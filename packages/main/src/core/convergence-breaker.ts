/**
 * B-bbaf: no-convergence + takeover circuit breaker — pure core + cheap per-story I/O.
 *
 * Background (evidence B-f458): a story burned ~14 hours in a non-converging
 * death loop — 89 story_advance events (healthy is 6-10), a 131:31 review
 * run_start/pass ratio (~23.7% overall, collapsing to ~9.5% in the post-16:00
 * window), and 65 lease takeovers — because the framework has only SOFT
 * convergence advisories (core/review-convergence.ts, core/anti-stall.ts,
 * core/usage-burn-alert.ts) and no hard brake. This module is the hard brake:
 * it derives FOUR read-only per-story signals and, on a pathological signature,
 * hard-stops story_advance. It auto-recovers ONCE so healthy autonomous work is
 * unaffected, and only escalates to a human-ack freeze on re-trip.
 *
 * DESIGN CONTRACT (mirrors the usage-burn-alert.ts / review-convergence.ts
 * pure-core discipline):
 *   - assessBreaker is PURE: no process.env, no Date.now(), no I/O. The clock is
 *     irrelevant (all signals are cumulative counts) and thresholds are injected.
 *   - resolveConvergenceThresholds is a pure function of a caller-supplied env
 *     record (handlers pass process.env at the boundary), mirroring
 *     resolveBurnAlertThresholds: typo-safe fallback, per-variable sanity
 *     ceilings, no NaN/Infinity.
 *   - FAIL-OPEN: a malformed/missing breaker-state, ledger, or counter must never
 *     wedge a healthy story. assessBreaker never throws; every I/O helper swallows
 *     errors and returns a safe default.
 *   - CHEAP READS (no hot-path activity-log scan): all four signals come from
 *     small per-story files or the already-loaded story index. The two counters
 *     that would otherwise require scanning the growing shared activity.jsonl —
 *     takeover frequency and repeated-identical-gate-failure — are instead bumped
 *     at the writes that ALREADY happen (the lease takeover audit write and the
 *     cli-engine failure catch), so the breaker only ever does an O(1) read.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { StoryStore } from './store.js';
import { isCanonicalStoryId } from './lifecycle-registry.js';

// ── Thresholds + env resolver ────────────────────────────────────────────────

export interface ConvergenceThresholds {
  /** Max advances OVER the current baseline before the advance signal trips (strict >). */
  maxAdvance: number;
  /** Max lifetime takeovers before the takeover signal trips (strict >). */
  maxTakeover: number;
  /** Minimum acceptable review pass-rate; below this trips (strict <), once min-sample is met. */
  minPassRate: number;
  /** Review runs required before the pass-rate signal can trip at all. */
  minSample: number;
  /** Max same-(command,reason) repeated gate failures before the gate-repeat signal trips (>=). */
  maxGateRepeat: number;
}

export const DEFAULT_CONVERGENCE_THRESHOLDS: ConvergenceThresholds = {
  // Healthy stories reach DONE in 6-10 advances; the B-f458 storm hit 89. 20 sits
  // comfortably above healthy and well below a runaway, and the one-shot
  // auto-recovery re-baseline gives a legitimately long story extra headroom.
  maxAdvance: 20,
  // Healthy stories take ~1 takeover; the storm took 65.
  maxTakeover: 5,
  // The B-f458 overall pass-rate was ~23.7%; 0.35 sits safely above it so a
  // genuinely converging story (which trends toward passing) never trips.
  minPassRate: 0.35,
  // Mirrors review-convergence.ts STALL_MIN_ROUNDS intent: never judge a rate
  // before there is enough sample (0 of 1 is not a 0% story).
  minSample: 10,
  // The user's stated discipline: the same gate failing the same reason twice is
  // a livelock — stop rather than keep hammering the same wall.
  maxGateRepeat: 2,
};

export const CONVERGENCE_ENV = {
  maxAdvance: 'LATTICE_CONVERGENCE_MAX_ADVANCE',
  maxTakeover: 'LATTICE_CONVERGENCE_MAX_TAKEOVER',
  minPassRate: 'LATTICE_CONVERGENCE_MIN_PASS_RATE',
  minSample: 'LATTICE_CONVERGENCE_MIN_SAMPLE',
  maxGateRepeat: 'LATTICE_CONVERGENCE_MAX_GATE_REPEAT',
} as const;

/** Per-variable sanity ceilings (values above these are typos, not thresholds). */
export const CONVERGENCE_ENV_MAX = {
  maxAdvance: 100_000,
  maxTakeover: 100_000,
  /** A rate ceiling of 1 (100%); a value above 1 is a typo. */
  minPassRate: 1,
  minSample: 100_000,
  maxGateRepeat: 100_000,
} as const;

/**
 * Parse one env number. Invalid (non-numeric / non-finite / negative, or zero
 * where zero is not meaningful, or above the sanity ceiling) falls back to the
 * default for that variable — a typo'd env must never break or silently zero a
 * safety brake.
 */
function envNumber(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  opts: { allowZero?: boolean; max: number },
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return fallback;
  if (value < 0) return fallback;
  if (value === 0 && !opts.allowZero) return fallback;
  if (value > opts.max) return fallback;
  return value;
}

/**
 * Resolve convergence thresholds from an env record (pure; handlers pass
 * process.env). Every variable is independently typo-safe and ceiling-clamped.
 */
export function resolveConvergenceThresholds(
  env: Record<string, string | undefined>,
): ConvergenceThresholds {
  const d = DEFAULT_CONVERGENCE_THRESHOLDS;
  return {
    maxAdvance: envNumber(env, CONVERGENCE_ENV.maxAdvance, d.maxAdvance, { max: CONVERGENCE_ENV_MAX.maxAdvance }),
    maxTakeover: envNumber(env, CONVERGENCE_ENV.maxTakeover, d.maxTakeover, { allowZero: true, max: CONVERGENCE_ENV_MAX.maxTakeover }),
    minPassRate: envNumber(env, CONVERGENCE_ENV.minPassRate, d.minPassRate, { max: CONVERGENCE_ENV_MAX.minPassRate }),
    minSample: envNumber(env, CONVERGENCE_ENV.minSample, d.minSample, { max: CONVERGENCE_ENV_MAX.minSample }),
    maxGateRepeat: envNumber(env, CONVERGENCE_ENV.maxGateRepeat, d.maxGateRepeat, { max: CONVERGENCE_ENV_MAX.maxGateRepeat }),
  };
}

// ── Pure evaluator ───────────────────────────────────────────────────────────

/** The four read-only signals fed to assessBreaker (all cumulative counts). */
export interface BreakerCounters {
  /** Total story_advance events over the story's lifetime. */
  advanceCount: number;
  /** review_run_start ledger length. */
  reviewRunCount: number;
  /** review_pass_set ledger length. */
  reviewPassCount: number;
  /** Per-story lease-takeover counter. */
  takeoverCount: number;
  /** Max observed same-(command,reason) repeated-gate-failure count. */
  maxGateRepeat: number;
}

/**
 * Persisted graduated-freeze state (breaker-state.json).
 *
 * F-003 fix: EVERY count-based signal is measured RELATIVE to a baseline, not
 * against its lifetime-cumulative value. An auto-recovery / human ack re-baselines
 * ALL of them to the current counts, giving each signal a fresh window. Without
 * this, a lifetime-monotonic counter like takeoverCount (which nothing ever
 * decrements) would re-trip on every assessment after the one auto-recovery was
 * spent — permanently alternating advance→freeze→ack→advance→freeze even for a
 * fully healthy, converging story. (Pass-rate self-heals as a ratio, but is
 * baselined too so a recovered story is judged only on its NEW reviews.)
 */
export interface BreakerState {
  /** advanceCount the advance signal is measured RELATIVE to (re-baselined on recovery/ack). */
  advanceBaseline: number;
  /** takeoverCount the takeover signal is measured RELATIVE to (re-baselined on recovery/ack). */
  takeoverBaseline: number;
  /** reviewRunCount the pass-rate window starts from (re-baselined on recovery/ack). */
  reviewRunBaseline: number;
  /** reviewPassCount the pass-rate window starts from (re-baselined on recovery/ack). */
  reviewPassBaseline: number;
  /** How many one-shot auto-recoveries have been consumed (budget is AUTO_RECOVERY_BUDGET). */
  autoRecoveriesSpent: number;
  /** When true, story_advance is hard-blocked until a human ack. */
  frozen: boolean;
  /** The reasons recorded at the last trip (for the freeze message / audit). */
  trippedReasons: string[];
  /** Snapshot of the counters at the last assessment (audit / diagnostics). */
  counterSnapshot?: BreakerCounters;
  /** ISO time of the last state write. */
  updatedAt?: string;
}

/** One-shot: the FIRST pathological trip auto-recovers; the next one freezes. */
export const AUTO_RECOVERY_BUDGET = 1;

export type BreakerAction = 'proceed' | 'auto-recover' | 'freeze';

export interface BreakerAssessment {
  /** True when any signal fired (independent of the graduated action). */
  tripped: boolean;
  reasons: string[];
  /** passCount/runCount, or null when there is no sample. */
  passRate: number | null;
  action: BreakerAction;
  /** The state to persist after this assessment. */
  nextState: BreakerState;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function normalizeState(prior: Partial<BreakerState> | null | undefined): BreakerState {
  return {
    advanceBaseline: num(prior?.advanceBaseline),
    takeoverBaseline: num(prior?.takeoverBaseline),
    reviewRunBaseline: num(prior?.reviewRunBaseline),
    reviewPassBaseline: num(prior?.reviewPassBaseline),
    autoRecoveriesSpent: num(prior?.autoRecoveriesSpent),
    frozen: prior?.frozen === true,
    trippedReasons: Array.isArray(prior?.trippedReasons) ? prior!.trippedReasons.slice() : [],
    counterSnapshot: prior?.counterSnapshot,
  };
}

/** All count-based signals re-baselined to the current counts (fresh window). */
function baselinesFrom(counters: BreakerCounters): Pick<BreakerState, 'advanceBaseline' | 'takeoverBaseline' | 'reviewRunBaseline' | 'reviewPassBaseline'> {
  return {
    advanceBaseline: num(counters.advanceCount),
    takeoverBaseline: num(counters.takeoverCount),
    reviewRunBaseline: num(counters.reviewRunCount),
    reviewPassBaseline: num(counters.reviewPassCount),
  };
}

/**
 * PURE decision function. Given the four counters, resolved thresholds, and the
 * prior persisted state, decide whether the story has gone runaway and what the
 * graduated action is. Never throws; on any malformed input it fails open
 * (tripped=false, action='proceed').
 *
 * Signals (all measured as a DELTA over the state baseline — see BreakerState):
 *   - advance:   advanceCount - advanceBaseline      >  maxAdvance   (strict >)
 *   - takeover:  takeoverCount - takeoverBaseline     >  maxTakeover  (strict >)
 *   - pass-rate: runDelta >= minSample AND passDelta/runDelta < minPassRate (strict <),
 *     where runDelta/passDelta are the review runs/passes SINCE the baseline
 *   - gate-repeat: maxGateRepeat                       >= maxGateRepeat (>=; the
 *     user's "same reason twice" discipline is inclusive at the threshold). The
 *     gate-failure counter is reset on progress, so it carries no baseline here.
 *
 * Graduated action when ANY signal fires:
 *   - already frozen                     -> 'freeze' (stays frozen)
 *   - autoRecoveriesSpent < budget (1)   -> 'auto-recover': re-baseline ALL
 *     signals to the current counts, spend one recovery, advance PROCEEDS.
 *   - budget exhausted                   -> 'freeze': advance is hard-blocked
 *     until a human ack.
 */
export function assessBreaker(
  counters: BreakerCounters,
  thresholds: ConvergenceThresholds,
  priorState: Partial<BreakerState> | null | undefined,
): BreakerAssessment {
  try {
    const state = normalizeState(priorState);
    const advanceCount = num(counters?.advanceCount);
    const reviewRunCount = num(counters?.reviewRunCount);
    const reviewPassCount = num(counters?.reviewPassCount);
    const takeoverCount = num(counters?.takeoverCount);
    const maxGateRepeat = num(counters?.maxGateRepeat);

    const reasons: string[] = [];

    const advanceDelta = advanceCount - state.advanceBaseline;
    if (advanceDelta > thresholds.maxAdvance) {
      reasons.push(`advance-count ${advanceDelta}>${thresholds.maxAdvance}`);
    }

    const takeoverDelta = takeoverCount - state.takeoverBaseline;
    if (takeoverDelta > thresholds.maxTakeover) {
      reasons.push(`takeover ${takeoverDelta}>${thresholds.maxTakeover}`);
    }

    // Pass-rate over the reviews SINCE the baseline (F-003: a recovered story is
    // judged only on its new reviews, so an old low ratio cannot re-freeze it).
    const runDelta = reviewRunCount - state.reviewRunBaseline;
    const passDelta = reviewPassCount - state.reviewPassBaseline;
    const passRate = runDelta > 0 ? passDelta / runDelta : null;
    if (passRate !== null && runDelta >= thresholds.minSample && passRate < thresholds.minPassRate) {
      const pct = Math.round(passRate * 100);
      const minPct = Math.round(thresholds.minPassRate * 100);
      reasons.push(`pass-rate ${passDelta}/${runDelta}=${pct}%<${minPct}%`);
    }

    if (maxGateRepeat >= thresholds.maxGateRepeat && thresholds.maxGateRepeat > 0) {
      reasons.push(`gate-repeat ${maxGateRepeat}>=${thresholds.maxGateRepeat}`);
    }

    const tripped = reasons.length > 0;
    const counterSnapshot: BreakerCounters = {
      advanceCount, reviewRunCount, reviewPassCount, takeoverCount, maxGateRepeat,
    };

    if (!tripped) {
      // Healthy: leave the persisted state untouched except for a fresh snapshot.
      return {
        tripped: false, reasons: [], passRate, action: 'proceed',
        nextState: { ...state, counterSnapshot },
      };
    }

    if (state.frozen) {
      return {
        tripped: true, reasons, passRate, action: 'freeze',
        nextState: { ...state, frozen: true, trippedReasons: reasons, counterSnapshot },
      };
    }

    if (state.autoRecoveriesSpent < AUTO_RECOVERY_BUDGET) {
      // First trip: re-baseline EVERY signal to now and spend one recovery. The
      // advance PROCEEDS; only a genuine re-trip within the fresh window freezes.
      return {
        tripped: true, reasons, passRate, action: 'auto-recover',
        nextState: {
          ...baselinesFrom(counterSnapshot),
          autoRecoveriesSpent: state.autoRecoveriesSpent + 1,
          frozen: false,
          trippedReasons: reasons,
          counterSnapshot,
        },
      };
    }

    // Budget exhausted -> freeze.
    return {
      tripped: true, reasons, passRate, action: 'freeze',
      nextState: { ...state, frozen: true, trippedReasons: reasons, counterSnapshot },
    };
  } catch {
    // Fail-open: any internal error leaves a healthy story untouched.
    return {
      tripped: false, reasons: [], passRate: null, action: 'proceed',
      nextState: normalizeState(priorState),
    };
  }
}

/**
 * Clear a freeze on human ack: reset the auto-recovery budget, re-baseline ALL
 * signals to the current counts (F-003: including takeover, which is otherwise
 * lifetime-monotonic and would immediately re-freeze), drop the frozen flag and
 * tripped reasons. PURE — the caller resets the on-disk gate-failure counter
 * separately.
 */
export function resumeBreakerState(
  counters: BreakerCounters,
): BreakerState {
  return {
    ...baselinesFrom(counters),
    autoRecoveriesSpent: 0,
    frozen: false,
    trippedReasons: [],
    counterSnapshot: undefined,
  };
}

/**
 * Whether the human-ack resume is allowed in the current environment. PURE so
 * the smoke can assert both branches without a real TTY. The ack is refused when
 * stdin is not a TTY, or when an autopilot / CI / non-interactive marker is
 * present — which stops the realistic threat: a normal looping autopilot (running
 * headless, no TTY) self-servicing the ack.
 *
 * SCOPE / ACCEPTED RISK (codex host-B #2): this is a barrier against ACCIDENTAL
 * unattended self-ack, matching the acceptance criterion "refused under autopilot
 * / non-interactive mode". It is NOT a defense against a DELIBERATELY adversarial
 * caller that allocates a pseudo-TTY and clears the env markers — no in-process
 * check can be, since the agent controls its own process. Truly un-spoofable
 * human presence would require an out-of-band confirmation channel (e.g. a
 * signed operator token), which is out of scope for this story. The required
 * explicit --ack flag and a >=10-char human --reason (enforced in the handler)
 * raise the bar for the realistic case.
 */
export function isInteractiveAckAllowed(
  env: Record<string, string | undefined>,
  isTTY: boolean | undefined,
): boolean {
  if (truthyEnv(env.LATTICE_AUTOPILOT)) return false;
  if (truthyEnv(env.CI)) return false;
  if (truthyEnv(env.LATTICE_NON_INTERACTIVE)) return false;
  return isTTY === true;
}

function truthyEnv(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t !== '' && t !== '0' && t !== 'false' && t !== 'no';
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** The story_advance rejection shown when a story is (or just became) frozen. */
export function renderBreakerFreeze(storyId: string, reasons: string[]): string {
  const list = reasons.length > 0 ? reasons.join(', ') : '(no recorded reasons)';
  return (
    `Convergence breaker FROZEN for ${storyId}: this story tripped the runaway signature and already spent its ` +
    `one automatic recovery, so story_advance is hard-blocked until a human reviews it. ` +
    `Tripped counters: ${list}. ` +
    `This is the hard brake that the B-f458 14-hour burn lacked. ` +
    `Next action (a human, not an autopilot session): run \`lattice done_prepare --dryRun --storyId=${storyId}\` to see the real blocker, ` +
    `then \`lattice story_resume --storyId=${storyId} --ack --reason="<why it is safe to continue>"\` to clear the freeze. ` +
    `The ack is refused under autopilot / non-interactive sessions.`
  );
}

// ── Per-story I/O (cheap, fail-open) ─────────────────────────────────────────

const BREAKER_STATE_FILE = 'breaker-state.json';
const TAKEOVER_COUNT_FILE = 'takeover-count.json';
const GATE_FAILURE_FILE = 'gate-failure-counts.json';

function readJsonFile<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Atomic-ish write: temp file + rename, best-effort (never throws). */
function writeJsonFile(file: string, value: unknown): void {
  try {
    const dir = file.slice(0, file.lastIndexOf('/'));
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch {
    // best-effort: a failed state write must never break the command path.
  }
}

export function readBreakerState(storyDir: string): BreakerState | null {
  const raw = readJsonFile<Partial<BreakerState>>(join(storyDir, BREAKER_STATE_FILE));
  return raw ? normalizeState(raw) : null;
}

export function writeBreakerState(storyDir: string, state: BreakerState): void {
  writeJsonFile(join(storyDir, BREAKER_STATE_FILE), { ...state, updatedAt: nowIso() });
}

export function readTakeoverCount(storyDir: string): number {
  const raw = readJsonFile<{ count?: number }>(join(storyDir, TAKEOVER_COUNT_FILE));
  return num(raw?.count);
}

/** Bump the per-story takeover counter. Called from the lease takeover audit write. */
export function bumpTakeoverCount(storyDir: string): void {
  const next = readTakeoverCount(storyDir) + 1;
  writeJsonFile(join(storyDir, TAKEOVER_COUNT_FILE), { count: next, updatedAt: nowIso() });
}

/** Gate-failure counter map: digest(command+reason) -> occurrence record. */
export interface GateFailureRecord {
  count: number;
  command: string;
  lastReason: string;
  lastAt: string;
}
export type GateFailureCounts = Record<string, GateFailureRecord>;

export function readGateFailureCounts(storyDir: string): GateFailureCounts {
  return readJsonFile<GateFailureCounts>(join(storyDir, GATE_FAILURE_FILE)) ?? {};
}

/**
 * A stable digest for "the same gate failing the same reason". The command name
 * is kept verbatim; the error message is normalized to strip volatile tokens
 * (hashes, ids, timestamps, bare numbers, paths) so two rejections that differ
 * only in incidental detail collapse to the same key.
 */
/**
 * B-cc54: pull the STRUCTURED blocker identity out of a normalized gate reason.
 *
 * gateFailureDigest hashes only the first 200 normalized characters. For a
 * structured gate failure that prefix is an invariant banner — every ProofStory
 * DEV-gate refusal opens with the same "cannot enter dev: proofstory dev gate is
 * enforce ... status: fail blocking: yes hardening level: high_assurance" text —
 * while the part naming WHICH precondition is unmet ("diagnostic gaps: -
 * missing_acceptance_binding ...") sits far beyond character 200. Digit
 * normalization erases what is left ("trigger reasons (4)" and "(6)" both
 * collapse to "(#)").
 *
 * Reproduced on B-cc54 itself: three genuinely DIFFERENT blockers (missing
 * intent snapshot -> missing acceptance binding -> missing verificationIntentRefs)
 * collapsed onto one digest, so fixing one precondition at a time read as a stuck
 * repeat loop and froze the story. Clearing that freeze demands an interactive
 * human ack, which an unattended run can never obtain — so a false positive here
 * is precisely a "needs a human" failure.
 *
 * The key therefore also carries the blocker's structured identity: bracketed
 * reason codes ([missing_scope_boundary]) and diagnostic gap ids
 * (- missing_spike_evidence [warn; spike.json]).
 *
 * F-005: be precise about what "bounded" means here, because an earlier draft of
 * this comment claimed a bounded VOCABULARY that the code did not enforce — and
 * that gap between claim and code is exactly what F-002 turned out to be. What is
 * bounded is the FORM, not an enumerable set: a token counts only if it is
 * multi-word snake_case. Any freshly invented multi-word snake_case token would
 * still register as a signal. That is acceptable because such tokens are emitted
 * by gate code, not by free text, and the alternative (accepting any bracketed
 * word) demonstrably let ordinary annotations mint a new key per attempt. What
 * the form restriction buys is that a genuinely stuck loop keeps emitting the
 * SAME set and still trips: this widens the key, it never resets the counter on
 * free text.
 */
export function extractGateBlockSignals(normalizedReason: string): string[] {
  const signals = new Set<string>();
  // Bracketed reason codes: [missing_scope_boundary], [init_check_tampered], ...
  //
  // F-002: the bracket pattern MUST require at least one underscore. An earlier
  // draft accepted any bracketed lowercase word, which silently admitted ordinary
  // annotations like [note] / [info] / [todo] / [warn]. A genuinely stuck loop
  // whose reason text carried a VARYING plain word would then get a fresh key on
  // every attempt and escape the brake entirely — reintroducing exactly the
  // unbounded loop this module exists to stop. Requiring an underscore restricts
  // the FORM of an accepted token; it does not enumerate a fixed set.
  for (const m of normalizedReason.matchAll(/\[([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\]/g)) signals.add(m[1]);

  // F-008: capture diagnostic gap ids and trigger reasons by their STRUCTURAL
  // position, not by a prefix whitelist. An earlier draft only accepted tokens
  // starting with missing/invalid/stale/unreadable/tampered, which matched a
  // FABRICATED fixture but almost none of the codes production actually emits —
  // acceptance_binding_missing_verification_intent_refs,
  // milestone_source_requirement_unbound, review_completeness_missing_evidence,
  // scope_ambiguity and every trigger reason extracted ZERO signals, so real
  // distinct blockers still collided on one key and the headline bug survived.
  //
  // proofstory.ts renders each entry as "  - <code> [<severity>; <artifact>]: …"
  // and each trigger reason as "  - <code>: …", so a bullet followed by a
  // multi-word snake_case token followed by '[' or ':' is a reliable, bounded
  // anchor. Ordinary prose bullets ("- If there is no output for 4 minutes…")
  // and anti-stall action labels ("- [retry] …") do not match it.
  for (const m of normalizedReason.matchAll(/-\s+([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*[[:]/g)) {
    signals.add(m[1]);
  }

  // Codes mentioned inline rather than as a bullet (kept from the first draft;
  // narrower than the structural rule above, and harmless alongside it).
  for (const m of normalizedReason.matchAll(/\b((?:missing|invalid|stale|unreadable|tampered)_[a-z0-9_]+)/g)) {
    signals.add(m[1]);
  }
  return [...signals].sort();
}

/**
 * B-bf52 C3: the bounded vocabulary of id prefixes whose ORDINAL is substantive.
 *
 * The digit rule cannot decide "substantive vs volatile" syntactically — nothing
 * in the SHAPE of `b-1234` distinguishes it from `CHK-001`, and an earlier draft
 * of this story that tried to draw the line syntactically (identifier-attached
 * digits are substantive) is exactly what put it in conflict with B-cc54, whose
 * CHK-002:adversarial:2 requires `gate blocked for b-1234` and `... b-5678` to
 * keep ONE key. So the line is drawn SEMANTICALLY instead: an ordinal is
 * substantive when it names WHICH lifecycle artifact the gate refused on, and
 * every other digit run is incidental.
 *
 * MEMBERSHIP IS DECIDED BY A MEASUREMENT, NOT BY THE EXISTENCE OF A PRODUCER
 * (F-056, review round 14). The pattern below is a WHOLE-TOKEN test with no
 * reduction, so a prefix earns its place here only if some producer renders its id
 * as the ENTIRE whitespace-delimited token. A prefix whose every native render is
 * comma-, period- or colon-attached is never protected in practice no matter what
 * this set says — its entry buys nothing — while the prefix itself remains an
 * active false-positive surface, because core/machine.ts:1190 embeds RAW
 * third-party test output in the digest and an ordinary label can look exactly
 * like the id. So the criterion is: NAMES WHICH ARTIFACT MUST BE FIXED, SURVIVES
 * THE RETRY, AND HAS A BARE NATIVE RENDER.
 *
 * The members, each with the story_advance-reachable render site that emits it
 * BARE (verified by reading the producer, round 14):
 *   chk-  checklist item — core/machine.ts:1169 joins the pending ids with `, ` and
 *         adds NO trailing period, so the LAST id of that list is the whole token;
 *         a reviewer citing the item at the end of the last blocking-finding
 *         description (:756, wrapped by :1181) is bare too.
 *   bug-  bug report — core/machine.ts:1195 `Cannot enter DONE: 1 unfixed bug(s):
 *         BUG-001`, same list join, same bare last element.
 * Two gate refusals naming DIFFERENT members are two different failures; a story
 * that clears CHK-001 and then trips on CHK-002 is making progress, and counting
 * that as one gate failing twice is the false freeze this story exists to kill.
 *
 * WHAT WAS REMOVED FOR HAVING NO BARE NATIVE RENDER (F-056, round 14). Each entry
 * records the MEASUREMENT that removed it — the producer was read, not assumed —
 * rather than being deleted silently, because a silent drop is indistinguishable
 * from an oversight:
 *   `f-`   finding id. NEVER BARE. Every mint is composite: audit-meta-store.ts:187
 *          and :501 and handlers/finding.ts:552 all build `${storyId}:F-${NNN}`,
 *          and the one story_advance render (core/machine.ts:756, wrapped by
 *          :1181) interpolates that id whole, so the token is `b-bf52:f-012` — a
 *          colon composite this form has not protected since F-052. The entry
 *          therefore protected nothing, and `f-` is the WORST of the three to keep:
 *          a single letter is the most likely shape to collide with an ordinary
 *          hyphenated label in the third-party output :1190 embeds.
 *   `req-` requirement id. NEVER BARE. The only ordinal-bearing `REQ-` in the tree
 *          is the key-requirement id (core/proofstory.ts:85 defaults it to
 *          `REQ-001`), and its only story_advance-reachable render is
 *          core/proofstory.ts:1026 — `… references sourceRequirementId REQ-001,
 *          which is not in original intent keyRequirementIds.` — surfaced by the
 *          report renderer at :1911. The token is `req-001,`: COMMA-ATTACHED.
 *          (core/planner.ts:863-865 mints `REQ-empty` / `REQ-vague` /
 *          `REQ-placeholder`, which carry no ordinal at all.)
 *   `sep-` scope-extension proposal id. NEVER BARE. handlers/scope-anti-expansion.ts:121
 *          mints `SEP-${storyId}-${NNN}` and the only story_advance render is
 *          core/machine.ts:273, `… are still pending: ${ids.join(', ')}.` — every
 *          element but the last is comma-attached and the last is period-attached.
 *          (handlers/init-preflight.ts:254 joins the same ids with no trailing
 *          period, but init_preflight is not story_advance and cli-engine.ts:1500
 *          bumps the counter for story_advance ONLY, so that render never reaches
 *          this normalizer.) Its compound shape could not match the pure-ordinal
 *          body below in any case.
 * REMOVAL COST, stated rather than implied: all three already collapsed before
 * this change, because the F-054 deletion left nothing to strip their attached
 * punctuation. Removing them changes no digest for any first-party render; what it
 * changes is third-party text, where `f-2` / `req-3` / `sep-1` stop being
 * protected. There is consequently NO single-mutation guard on the `sep-` removal
 * (re-adding it changes no observable behaviour, since no bare `SEP-<ordinal>`
 * shape exists anywhere), and the smoke says so instead of implying one. `f-` and
 * `req-` DO have one: the must-still-collapse `bare-finding-ordinal` and
 * `embedded-test-output-bare-requirement-ordinal` cases in
 * tasks/convergence-breaker-smoke.ts key APART the moment either is re-added.
 *
 * WHAT WAS REMOVED EARLIER, AND WHY (review round 6, cross-host codex).
 *   `ab-` / `oq-`  DEAD CONFIG (F-035). No `AB-` producer exists anywhere in
 *                  packages/main/src; `OQ-` appears only in comments and in the
 *                  open_question_resolve schema description, and no story_advance
 *                  transition guard renders an open-question id. They protected
 *                  nothing, and their presence made the allowlist look better
 *                  evidenced than it was.
 *   `init-`        WRONG SHAPE (F-034). The only `INIT-${…}` mint is
 *                  handlers/draft-check.ts:81, which ids draft-check issues; that
 *                  artifact is never rendered by a story_advance guard. `init-` is
 *                  now an explicit EXCLUSION in the completeness guard, not a
 *                  silent omission.
 *   `i-`           UNSTABLE ORDINAL (F-044, review round 8). F-034 replaced
 *                  `init-` with `i-` on the strength of the RENDER site being real
 *                  — core/machine.ts:1044 does interpolate `${issue.id}` — but the
 *                  render site was never the criterion. The criterion is stability
 *                  across a retry, and `i-` fails it exactly as `rr-`/`rp-`/`rl-`
 *                  do: cli/command-catalog.ts:2315 declares `issue.id` OPTIONAL and
 *                  reviewer-self-assigned free text, handlers/init-check.ts:139-142
 *                  drops the calling agent's previous record and rewrites its issues
 *                  wholesale on every init_check_set, and the remediation the
 *                  rejection itself prints (core/machine.ts:1036-1044, "re-run the
 *                  corresponding reviewer") is precisely the action that re-mints
 *                  those ids from scratch. So a reviewer re-run that reports the
 *                  SAME unfixed problem can renumber it, mint a fresh digest key,
 *                  and the brake never trips — the unbounded-retry hole. Removing
 *                  `i-` does NOT undo F-034: `init-` is dead config either way and
 *                  stays excluded. `i-` moves to the review-bookkeeping exclusion
 *                  category in tasks/convergence-breaker-smoke.ts, and the
 *                  must-still-collapse `init-check-issue-ordinal` case there is the
 *                  standing guard against re-adding it.
 *
 * WHAT IS DELIBERATELY NOT HERE, AND WHY (F-030, cross-host codex round 5; F-044,
 * round 8). The criterion above is "names WHICH artifact must be FIXED", and the
 * test of that is whether the ordinal SURVIVES the retry the rejection asks for.
 * Review BOOKKEEPING
 * ids — `RR-` (review run) and `RP-` (review pass) — fail it: they name the
 * bookkeeping record that changes on retry, not the artifact at fault. An
 * earlier draft of this story listed them, which reintroduced the inverse-risk
 * hole: "review evidence ... bound reviewRunId B-x:RR-002 is stale" and its
 * RR-003 variant would key differently, and since starting another reviewer run
 * does NOT repair stale evidence (see staleMaterialHint in core/review-run.ts —
 * the fix is to return to DEV), a host repeating review_run_start then
 * story_advance would mint a fresh key on every attempt and the breaker would
 * never trip. That is the unbounded retry loop this module exists to stop, so
 * `rr-`/`rp-` are excluded and the `stale-review-run-evidence` collapse case in
 * tasks/convergence-breaker-smoke.ts is the standing guard against re-adding
 * them. `rl-` (review loop) is excluded on the SAME ground — see the exclusion
 * category in that file for its honest justification. `i-` (INIT_CHECK reviewer
 * issue) is excluded on that same ground too: the id is caller-written, optional,
 * and rewritten wholesale by the next init_check_set, so "re-run the reviewer" —
 * the remediation the rejection prints — renumbers it, and the
 * `init-check-issue-ordinal` collapse case is its standing guard.
 *
 * ACCEPTED RESIDUAL — THIS ENUMERATION IS NOT PROVABLY COMPLETE. It is a
 * hand-written vocabulary, and no mechanism here can invent a prefix that no
 * producer emits yet: a NEW artifact id that starts appearing in a
 * story_advance rejection is, until someone classifies it, treated as volatile
 * and its ordinals collapse (the direction that makes the breaker fire MORE
 * often, i.e. fail-safe for a breaker, but still a false freeze). What IS
 * bounded is DRIFT: the bidirectional completeness guard in
 * tasks/convergence-breaker-smoke.ts section 7c fails when a scanned producer's
 * prefix is unclassified AND when a classified prefix has no producer, so a
 * newly minted or newly deleted id shape is caught by the suite rather than by
 * the next round of review. Do not read this list as "the set of substantive
 * ordinals"; read it as "the set decided so far, with its drift bounded".
 *
 * Keep this set SMALL and evidence-backed. Every prefix added here is a prefix
 * whose ordinals stop collapsing, which makes the breaker fire LESS often; the
 * `bcc54-story-id-digits` case in tasks/convergence-breaker-smoke.ts is the
 * standing guard that `b-` never joins it.
 */
const SUBSTANTIVE_ID_PREFIXES = new Set(['bug-', 'chk-']);

/**
 * The allowlist, exported READ-ONLY so the completeness guard in
 * tasks/convergence-breaker-smoke.ts can reconcile it against the artifact-id
 * prefixes production source actually emits. A copy is returned so no caller can
 * widen the live set (which would make the breaker fire less often) at runtime.
 */
export function listSubstantiveIdPrefixes(): string[] {
  return [...SUBSTANTIVE_ID_PREFIXES].sort();
}

/**
 * A substantive artifact id is the ENTIRE whitespace-delimited token, AS IT
 * ARRIVES — nothing is removed from a token before it is tested (F-054).
 *
 * WHY THIS IS A SHAPE, NOT ANOTHER BOUNDARY. Four successive revisions of this
 * guard stated the rule as a boundary ASSERTION around the id — "the stem must
 * not be preceded by X", "the ordinal must be followed by Y" — and every one of
 * them was defeated by a punctuation character its author had not enumerated.
 * Two more stated it as a whole-token test applied to a REDUCED token, and both
 * were defeated by a reduction its author had not thought through.
 * The reachable channel is core/machine.ts:1190, `Cannot enter DONE: test
 * ${evidence.result}: ${evidence.output}`, which embeds RAW third-party test
 * output in the digest, so the enumeration was being tested against arbitrary
 * text rather than against this repo's own renders. The measured history:
 *
 *   `\b` (round 7)          a hyphen is a NON-word character, so it CREATES the
 *                           boundary `\b` asks for: `de-bug-2` / `de-bug-7`,
 *                           `scenario-f-2` and `over-req-3` each kept a
 *                           protected-looking tail (F-043).
 *   `(?<![\w-])` (round 8)  closed exactly those two characters. A SLASH is
 *                           neither, so `scenario/bug-2` walked through; and the
 *                           match began at the FIRST allowlisted stem it found, so
 *                           the doubled prefix `BUG-BUG-2` did too (F-048).
 *   positive token-START +
 *   trailing `\b` (round 9) closed the head. The TAIL was still an assertion, and
 *                           `\b` succeeds between a digit and a slash, a dot, a
 *                           hyphen or a non-ascii letter — so `bug-2/x`,
 *                           `bug-2.x`, `bug-2-x` and `bug-2é` all had the
 *                           SUBSTRING `bug-2` protected inside a larger token
 *                           (F-051). Cross-host codex measured all four as WORSE
 *                           THAN MAIN, which rewrites every ordinal to `#` and
 *                           collapses them.
 *   whole token + optional
 *   `<label>:` QUALIFIER
 *   (round 10)              closed both ends, then re-opened ONE of them by hand.
 *                           The qualifier was added to rescue the composite render
 *                           `B-bf52:F-012`, and it accepted ANY label, not only a
 *                           story id: in the raw test output core/machine.ts:1190
 *                           embeds, `timeout:bug-2` and `timeout:bug-5` are
 *                           ordinary TAP subtest names, and they keyed APART on
 *                           that branch while main collapses them (F-052). It was
 *                           an unbounded enumeration re-introduced inside a form
 *                           whose entire justification was having no enumeration
 *                           left to leak.
 *   whole token AFTER an
 *   INDEPENDENT-RUN punctuation
 *   strip (round 11)        `^[("'[{<]+` off the head and `[)"'\]}>,;:.!?]+$` off
 *                           the tail, each end enumerating characters without
 *                           reference to the other, so HALF a wrapper came off as
 *                           readily as a whole one: the NON-id `(bug-2` reduced to
 *                           `bug-2` and was protected, and `bug-2)` was the mirror
 *                           (F-053).
 *   whole token AFTER a
 *   BALANCED-ONLY strip
 *   (round 12)              matched wrapper pairs peeled one at a time, preceded by
 *                           an UNCONDITIONAL `[,;:.!?]+$` sentence-punctuation
 *                           strip. The balance rule closed the wrapper half; the
 *                           sentence half was still an enumeration and still
 *                           unconditional, so the arbitrary TAP subtest name
 *                           `bug-2:` reduced to `bug-2` and was protected —
 *                           `not ok 1 - bug-2: reproducer still red` and its
 *                           `bug-5:` sibling digested APART on that branch while
 *                           main collapses them (F-054).
 *   whole token, NO
 *   reduction, PERMISSIVE
 *   BODY `[a-z0-9-]*\d`
 *   (round 13)              closed the reduction class outright and left the leak in
 *                           the PATTERN instead. This is the eighth leak and the first
 *                           that is not about the token's surroundings at all: the
 *                           body existed to carry a COMPOUND id (`SEP-B-bf52-001`),
 *                           and `[a-z0-9-]*` accepts an ordinary hyphenated WORD just
 *                           as readily. The bare tokens `bug-fix-2` and `bug-fix-5` —
 *                           a routine TAP subtest name in the raw output
 *                           core/machine.ts:1190 embeds — matched as artifact ids and
 *                           digested APART while main collapses them, which is the
 *                           worse-than-main direction. `chk-abc-1` is the same
 *                           manufacture with a letter body and `bug-2a1` with an
 *                           alphanumeric one (F-056).
 *
 * Every one of the first seven leaks has the same structure: something that was NOT
 * an artifact id was made to look like one, either by finding the id inside a
 * larger token or by REMOVING characters from the token until an id was what
 * remained. The eighth needed no such step — the pattern simply ACCEPTED a non-id —
 * which is why closing it is a change to the pattern and NOT another revision of
 * the reduction: the reduction stayed deleted and is not coming back.
 * So the rule is stated as the property that is actually wanted, and it is not an
 * assertion at all — it is a WHOLE-TOKEN TEST, WITH NO REDUCTION, OVER A PURE
 * ORDINAL.
 * `normalizeGateReason` splits the reason on whitespace and protects a token only
 * if THE TOKEN ITSELF, byte for byte, is an artifact id. A token that merely
 * CONTAINS an id is not an id, and no embedded or attached punctuation can change
 * that, because nothing is ever taken off before the test.
 *
 * The pattern, applied to one whitespace-delimited token as it arrives and
 * anchored at both ends:
 *
 *   ^(?:<stems>)-\d+$
 *    └── stem ──┘└ord┘
 *
 *   body        `\d+` — a PURE ORDINAL, and nothing else. The token is a stem, a
 *               hyphen and digits, or it is not an id. There is no character class
 *               left in which an ordinary word can hide, which is the whole content
 *               of the F-056 fix.
 *
 * WHAT THE PURE ORDINAL COSTS, stated rather than softened: the COMPOUND id
 * `SEP-B-bf52-001` (F-032) can no longer be protected in any position, because its
 * ordinal is preceded by `bf52-`. That costs nothing measurable, and the reason is
 * the same measurement that removed `sep-` from the allowlist above — the only
 * story_advance render of that id (core/machine.ts:273) attaches a comma or a
 * period to every element, so no `SEP-` token has been protected since the F-054
 * deletion anyway. The compound body was carrying a capability nothing used, at the
 * price of admitting every hyphenated word in third-party output.
 *
 * WHAT ELSE THE PURE ORDINAL SUBSUMES. The doubled-prefix lookahead
 * `(?!(?:<stems>)-)` that rounds 9-13 carried for F-048 (b) is DELETED, not
 * retained-but-unused: with a pure-ordinal body `bug-bug-2` cannot match, because
 * the characters after the stem are not digits. Keeping a lookahead that provably
 * cannot fire would be a guard nobody has, so it goes and the standing case
 * `embedded-test-output-doubled-prefix` is RETAGGED onto the body rule that now
 * refuses it (measured: widening the body back fails that case).
 *
 * There is NO interior structure left and NOTHING RUNS IN FRONT OF THE TEST: a
 * token is protected only when it IS an artifact id. Built FROM the allowlist, so
 * the two cannot drift apart, and there is nothing else in the form to enumerate.
 *
 * THE CLOSURE ARGUMENT, and how F-056 changed it. Rounds 7-12 each closed the leak
 * they had been shown by fixing the CHARACTER SET — a wider lookbehind, an anchor,
 * a balance requirement, a safer punctuation list — and each time the next round
 * found a character or a combination the previous author had not listed. Round 13
 * closed that class by deleting the reduction outright: a manufacture vector needs
 * a step that turns a non-id into an id, and with the step gone there is nothing
 * left to be incomplete about at the token's EDGES. That argument was correct and
 * it still stands — F-056 did not re-open it, and the reduction is not coming back.
 * What round 13 got wrong was assuming the argument covered the token's INTERIOR
 * too. It did not: with no reduction at all, `bug-fix-2` needs no manufacture step,
 * because the pattern accepted it as written. So the closure argument is now stated
 * in two halves, both of which have to hold:
 *
 *   edges     nothing is removed from the token before the test, so no non-id can
 *             become an id (rounds 7-13, unchanged);
 *   interior  the accepted body is `\d+`, so the set of accepted strings is exactly
 *             `<stem>-<digits>` — a set small enough to enumerate in one line, with
 *             no character class in which a word can hide (F-056).
 *
 * THE COST, stated plainly and NOT softened. ONLY BARE, PURELY-ORDINAL ids beat
 * main now. Four groups of shapes tie with main instead:
 *
 *   colon composites  (F-052) the real SUFFIX composite `CHK-001:happy:0`
 *                     (core/verification.ts:22-24, rendered at :1173) and the forged
 *                     `timeout:bug-2`. The real PREFIX composite `B-bf52:F-012` is
 *                     no longer a separate cost, because F-056 removed `f-` from the
 *                     allowlist entirely;
 *   wrapped ids       (F-054) `(CHK-001)` from core/machine.ts:204, `[CHK-001]` and
 *                     `"CHK-001"` from embedded test output. A wrapper is not part
 *                     of the id, but removing it is a reduction, and a reduction is
 *                     what leaked;
 *   punctuation-attached ids
 *                     (F-054) `CHK-001,` from the list join at core/machine.ts:1169
 *                     and `CHK-001;` from the `'; '` join at :756;
 *   compound ids and
 *   retired prefixes  (F-056, NEW cost) `SEP-B-bf52-001` is not a pure ordinal, and
 *                     `F-012` / `REQ-001` / `SEP-…` are not allowlisted at all. All
 *                     four of those renders were ALREADY tying with main before this
 *                     change (every one of them is comma-, period- or colon-attached
 *                     at its producer, see the allowlist comment above), so the
 *                     measured cost of F-056 against a first-party render is ZERO;
 *                     what it changes is third-party text.
 *
 * What is still protected, and what the must-differ lane in
 * tasks/convergence-breaker-smoke.ts pins: a BARE PURELY-ORDINAL `chk-`/`bug-` id —
 * one that arrives as the whole whitespace-delimited token. Real producers do
 * render those: the LAST id of the checklist list at core/machine.ts:1169 (that
 * join has no trailing period), the LAST id of the unfixed-bug list at :1195, a
 * checklist id cited at the end of a reviewer description before the bracketed
 * reason code at :1181, and any bare id in the raw test output :1190 embeds. Every
 * one of the shapes that LOST protection is a named must-still-collapse case in
 * that file, so the cost is visible in the matrix and not only in this comment.
 *
 * THE RESIDUAL, and its direction. A real id that arrives attached to ANY other
 * character — a wrapper, a list comma, a sentence period, a `:` composite, an
 * `itemId=` prefix — is not the whole token, so it is NOT protected and its
 * ordinal collapses. That makes the breaker fire EARLIER, which is the fail-safe
 * direction for a circuit breaker, and it is never worse than main, which
 * collapses those shapes too.
 *
 * The opposite error — protecting a NON-id — is the one that hands a stuck agent
 * back an unbounded retry loop. The claim this comment used to make about it was
 * that "the pattern is anchored at both ends over a character class that excludes
 * every welding character, so the only strings it accepts are strings that are
 * themselves artifact ids". That claim was FALSE FOUR times — the qualifier
 * admitted `timeout:bug-2` (F-052), the independent-run strip admitted `(bug-2`
 * (F-053), the sentence strip admitted `bug-2:` (F-054), and the permissive body
 * admitted `bug-fix-2` with no strip at all (F-056). The last of those is the one
 * that shows why the sentence about "a character class that excludes every welding
 * character" was the wrong claim to make: the class did exclude every welding
 * character, and the leak came through the characters it INCLUDED. The claim is now
 * made about the accepted SET rather than the excluded characters, which is
 * checkable by reading one line: the anchored pattern `^(?:<stems>)-\d+$` is applied
 * to the token itself, so the set of protected strings is exactly
 * `{stem}-{digits}`.
 *
 * The command that measures it, and the only thing that should be trusted here:
 *
 *   node packages/main/tests/red/red-s3-differential-probe.mjs <path-to-a-main-dist>
 *
 * That probe runs every leak shape from rounds 7-14 against a separately built
 * comparison normalizer and exits non-zero if this build distinguishes any ordinal
 * that a retry re-mints. Do not quote a number from this comment; run it. And note
 * what F-053, F-054 and F-056 each measured about the probe itself: it PASSED THREE
 * TIMES while a live regression was in the tree — once because every wrapper in its
 * matrix was BALANCED, once because no row ended in a stripped punctuation
 * character, and once because every welded row put material BEFORE the stem or
 * AFTER the ordinal and none put an ordinary word BETWEEN them. A probe whose
 * matrix cannot express a defect is not a guard against it; all three row groups
 * are now in it, and the running count is recorded in the probe's own header
 * because it is the evidence that a probe's matrix must be extended by every defect
 * that slips past it.
 *
 * EMPTY-ALLOWLIST SAFETY (F-041). If the set is ever emptied, an alternation over
 * zero stems is the empty string and `(?:)` matches EVERYWHERE, so the pattern
 * would degrade to "protect nearly everything" rather than to "protect nothing" —
 * and (measured, on the previous revision) that threw the suite off at an earlier
 * assertion instead of failing the named cases the matrix exists to localize to.
 * An empty allowlist must mean "protect NOTHING", so it yields a regex that
 * cannot match at all and the substantive-id matrix cases then fail BY NAME.
 */
function buildSubstantiveIdRe(prefixes: Iterable<string>): RegExp {
  const stems = [...prefixes]
    .map((p) => p.slice(0, -1))
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  if (stems.length === 0) return /(?!)/;
  const alt = stems.join('|');
  // F-056: the body is a PURE ORDINAL. Nothing may sit between the stem's hyphen
  // and the digits — not a word, not a letter, not another hyphen — because
  // anything that may sit there is a place an ordinary label can hide.
  return new RegExp(`^(?:${alt})-\\d+$`);
}
const SUBSTANTIVE_ID_RE = buildSubstantiveIdRe(SUBSTANTIVE_ID_PREFIXES);

/**
 * THE PUNCTUATION STRIP IS DELETED (F-054), and this note is where it was.
 *
 * Rounds 9-12 kept a reduction in front of the whole-token test — first two
 * independent character-class runs (`^[("'[{<]+` and `[)"'\]}>,;:.!?]+$`), then
 * balanced wrapper pairs preceded by an unconditional `[,;:.!?]+$` sentence
 * strip. Its purpose was real: core/machine.ts:204 renders `(CHK-001).`, :273
 * ends its pending list with `SEP-B-bf52-001.` and :1169 joins ids with `, `, so
 * without a strip those ids are not the whole token and lose protection.
 *
 * It is deleted anyway, because a reduction is the mechanism every manufacture
 * vector needs. F-053 measured the independent-run form admitting `(bug-2`;
 * F-054 measured the balanced form admitting `bug-2:` — an arbitrary TAP subtest
 * name in the raw output core/machine.ts:1190 embeds, whose trailing colon the
 * unconditional sentence strip removed, so `not ok 1 - bug-2: reproducer still
 * red` and its `bug-5:` sibling keyed APART here while main collapses them.
 * Replacing `[,;:.!?]` with a "safer" set does not close that: `bug-2,` is the
 * same manufacture with a list comma, and raw third-party output can place any
 * punctuation character against any name.
 *
 * So the cost is PAID instead of engineered around — `(CHK-001)`, `CHK-001,`,
 * `SEP-B-bf52-001.` and `CHK-001;` now tie with main — and the protected set is
 * exactly the set of tokens SUBSTANTIVE_ID_RE matches. Nothing is enumerated,
 * therefore nothing can be enumerated incompletely. The lost shapes are pinned by
 * name as must-still-collapse cases in tasks/convergence-breaker-smoke.ts under
 * `substantive-id-no-reduction`, and the manufacture vectors are measured against
 * a main build by tests/red/red-s3-differential-probe.mjs.
 */

/**
 * Placeholder encoding for a protected token.
 *
 * The index is written in a NON-DIGIT, NON-HEX alphabet (`g`-`z`) between two
 * U+0001 sentinels, and that is load-bearing rather than cosmetic: a numeric
 * index would be rewritten by the bare-number rule below, every placeholder
 * would collapse to the same text, and every protected token would then restore
 * to whichever token happened to be first — turning the fix into a new collision
 * source. `g`-`z` is also outside `[0-9a-f]`, so the hash rule cannot eat a
 * placeholder either.
 */
const TOKEN_PLACEHOLDER_ALPHABET = 'ghijklmnopqrstuvwxyz';
const TOKEN_SENTINEL = '\u0001';
const TOKEN_SENTINEL_RE = /\u0001/g;
const TOKEN_PLACEHOLDER_RE = /\u0001([g-z]+)\u0001/g;
function encodeTokenIndex(index: number): string {
  const base = TOKEN_PLACEHOLDER_ALPHABET.length;
  let n = index;
  let out = '';
  do {
    out = TOKEN_PLACEHOLDER_ALPHABET[n % base] + out;
    n = Math.floor(n / base);
  } while (n > 0);
  return `${TOKEN_SENTINEL}${out}${TOKEN_SENTINEL}`;
}
function decodeTokenIndex(encoded: string): number {
  const base = TOKEN_PLACEHOLDER_ALPHABET.length;
  let n = 0;
  for (const ch of encoded) n = n * base + TOKEN_PLACEHOLDER_ALPHABET.indexOf(ch);
  return n;
}

/**
 * The whole-token walk that lifts substantive artifact ids out of a reason
 * (F-051, F-054).
 *
 * A TOKEN WALK, not one mega-regex, and that is the point: the decision is made
 * once per whitespace-delimited token, so an id welded into a larger token is
 * simply not a candidate. Every previous revision made the decision per POSITION
 * inside the string and then tried to fence the position off with boundary
 * assertions, which is what leaked four times.
 *
 * NOTHING IS REMOVED FROM A TOKEN BEFORE IT IS TESTED (F-054). The token that the
 * anchored pattern sees is the token the reason contained, so the set of protected
 * strings is exactly the set the pattern matches and there is no step in which a
 * non-id can become an id. Rounds 9-12 ran a punctuation strip here; it is deleted
 * rather than narrowed, because narrowing it is what leaked twice (`(bug-2` under
 * the independent runs, `bug-2:` under the balanced form with its unconditional
 * sentence strip). See the note above SUBSTANTIVE_ID_RE for the cost.
 *
 * Whitespace separators are preserved verbatim (`split` with a capturing group)
 * and a protected token is replaced whole, so the only bytes this step rewrites
 * are the id itself.
 */
function protectSubstantiveIds(
  lowered: string,
  kept: string[],
  keptIndex: Map<string, number>,
): string {
  const parts = lowered.split(/(\s+)/);
  for (let i = 0; i < parts.length; i += 1) {
    const token = parts[i];
    // Odd positions are the captured whitespace separators; the empty strings
    // `split` produces at a leading/trailing separator are skipped here too.
    if (!token || i % 2 === 1) continue;
    if (!SUBSTANTIVE_ID_RE.test(token)) continue;
    let index = keptIndex.get(token);
    if (index === undefined) {
      index = kept.length;
      kept.push(token);
      keptIndex.set(token, index);
    }
    parts[i] = encodeTokenIndex(index);
  }
  return parts.join('');
}

/**
 * The volatile-token normalization applied to a gate reason before it is keyed.
 *
 * Extracted (same rule order as main's) so a test can assert a fixture's
 * PRECONDITION — "these two reasons share their first 200 normalized characters
 * and only then diverge" — against the REAL rule chain. The alternative, a
 * hand-mirrored copy of the chain inside the smoke (which
 * tasks/gate-repeat-block-smoke.ts carries as `normalizePrefix`), can drift out
 * of sync with production silently and then attest to a precondition that no
 * longer holds.
 *
 * Structure: extract-protect, normalize, restore. Substantive artifact ids are
 * lifted out first by the whole-token walk above, the volatile-token rules then
 * run EXACTLY as main runs them (the digit rule is main's bare `/\d+/g` — the
 * allowlist is applied by the extraction step, not by a special-cased digit
 * rule), and the ids are put back before the whitespace fold.
 *
 * A machine path is never protected under the whole-token rule — a path token is
 * not an id, whatever it contains — so the path rule sees exactly the text it saw
 * before this story, and the two rules no longer interact at all.
 */
export function normalizeGateReason(reason: string): string {
  const kept: string[] = [];
  const keptIndex = new Map<string, number>();
  const protectedText = protectSubstantiveIds(
    // U+0001 never appears in a rendered gate reason; stripping it means no
    // caller-supplied text can forge a placeholder and impersonate a protected id.
    String(reason ?? '').replace(TOKEN_SENTINEL_RE, '').toLowerCase(),
    kept,
    keptIndex,
  );
  return protectedText
    .replace(/0x[0-9a-f]+/g, '#')
    .replace(/\b[0-9a-f]{7,}\b/g, '#')          // hex ids / hashes
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, '#') // ISO timestamps
    // Machine-absolute POSIX paths, anchored at TOKEN START (B-bf52 C2/C4). The
    // former `\/[^\s"']+` rewrote from ANY slash anywhere in a token, so it ate
    // the tail of every slash-bearing identifier — `DEV/REVIEW` and `DEV/TEST`
    // both became `dev#`, and `src/core/alpha.ts` and `src/core/beta.ts` both
    // became `src#`, so a story that fixed one phase target or one file and then
    // tripped on another read as one gate failing twice. Anchoring to a token
    // start (or to a delimiter that really does introduce a path: quote, paren,
    // bracket, colon, equals, comma) keeps per-machine roots collapsing while
    // leaving relative in-repo paths and slash-joined identifiers intact.
    .replace(/(?:^|(?<=[\s"'(\[:=,]))\/[^\s"')\]]*/g, '#')
    // Bare digit runs, byte-for-byte main's rule (B-bf52 C3). A bare `attempt 3`,
    // a welded `45s` heartbeat age, `0/4 lanes` and the story-id ordinal in
    // `b-1234` all still become `#`; the ONLY reason `chk-001` survives is that it
    // was lifted out above.
    .replace(/\d+/g, '#')
    .replace(TOKEN_PLACEHOLDER_RE, (_m: string, code: string) => kept[decodeTokenIndex(code)] ?? '#')
    .replace(/\s+/g, ' ')
    .trim();
}

export function gateFailureDigest(command: string, reason: string): string {
  const normalized = normalizeGateReason(reason);
  // B-cc54: scan the WHOLE normalized reason for structured blocker identity,
  // then key on prefix + that identity. A reason carrying no structured signal
  // keeps the prefix-only key shape (see the signals-conditional cut below for
  // the one thing B-bf52 changed about it).
  const signals = extractGateBlockSignals(normalized);
  // B-bf52 CHK-001 (F-031): the truncation is SIGNALS-CONDITIONAL.
  //
  // The 200-character cut only causes harm when there is NO structured signal to
  // carry distinctness: two signal-less rejections that are byte-identical for
  // their first 200 characters and then diverge — a real shape, e.g. a scope-gate
  // refusal whose invariant advice precedes the offending path — collapse onto
  // one key, so fixing one and tripping on the next reads as one repeated
  // failure. Where signals DO exist, B-cc54's mechanism already supplies
  // distinctness from the whole reason, so B-cc54's 200-character prefix is
  // preserved EXACTLY in that case and every key it produces is byte-identical
  // to before this change.
  //
  // Removing the truncation outright is NOT the fix, measured: with
  // `prefix = normalized` (both branches) tasks/gate-repeat-block-smoke.ts exits
  // 1 on CHK-002:adversarial:1, which appends a noise tail past the banner and
  // requires the key to be UNCHANGED. That reason carries signals, so it is the
  // signals branch that must keep the cut; only the signal-less branch may relax
  // it. The 16,384-character bound is a sanity ceiling on that branch alone, so a
  // pathological embedded transcript is still cheap to hash.
  //
  // ACCEPTED RESIDUAL (F-033), measured, not assumed. The 200-character window on
  // the signals branch is a real blind spot: when two rejections extract the
  // IDENTICAL signal set and their ONLY difference is a substantive ordinal
  // sitting PAST character 200 of the normalized reason, both the prefix and the
  // signal list are equal, so the two still collapse onto one key and clearing
  // one then tripping on the next reads as one repeated failure.
  //
  // This is accepted rather than fixed because it is NEVER WORSE THAN MAIN, and
  // that comparison was measured rather than argued: main truncates at 200
  // unconditionally AND rewrites every ordinal to `#`, so main collapses that
  // same pair — and collapses the within-200 pair too. Within the 200-character
  // window this branch is strictly better (the ordinal survives and the pair
  // keys apart); past it, the two branches are equal. The improvement is
  // therefore BOUNDED, not regressive.
  //
  // WHY 200 IS KEPT, stated accurately (F-042). An earlier revision of this
  // comment said widening the window "is not available"; that overstated the
  // constraint and measurement contradicts it. B-cc54's CHK-002:adversarial:1
  // requires a signal-free tail past its banner to leave the key UNCHANGED, and
  // that banner fixture normalizes to exactly 592 characters — so cuts of 593 and
  // above break B-cc54's suite, while every cut from 258 (the divergence point of
  // the residual pair below) through 592 would fix that pair and leave B-cc54
  // green. A 335-character window exists; it is simply NOT TAKEN, and the reason
  // is the one already given above: on the signals branch this story keeps
  // B-cc54's 200-character prefix EXACTLY, so every key it produces is
  // byte-identical to before this change. Widening would rekey every ProofStory
  // gate rejection in the system to buy back a residual that is already never
  // worse than main. The `blocking-finding-cited-id-past-window` collapse case and
  // its within-window twin `blocking-finding-cited-id-within-window` in
  // tasks/convergence-breaker-smoke.ts pin BOTH directions of this residual, so it
  // stays a known, tested boundary rather than a surprise. (Those two replaced the
  // `SEP-…` pair that carried this residual through round 12: after the F-054
  // deletion every `SEP-` token in core/machine.ts:273's render is comma- or
  // period-attached and therefore unprotected, so neither half of that pair keyed
  // apart at any window and it could no longer measure this cut. Measured: a
  // 592-character cut fails the new past-window case and failed nothing on the old
  // one.)
  const prefix = signals.length > 0 ? normalized.slice(0, 200) : normalized.slice(0, 16_384);
  // F-003: encode the parts unambiguously instead of concatenating them with a
  // literal " signals:" delimiter. Concatenation only resisted forgery by accident
  // (a reason containing the delimiter text also fed its own extraction); a JSON
  // encoding makes the boundary structural, so no reason body can impersonate a
  // signal list. A reason with no signals still hashes the BARE prefix (no JSON
  // envelope), so the two branches remain structurally distinguishable; what the
  // signal-less branch changed above is only HOW MUCH of the reason that bare
  // prefix covers.
  const basis = signals.length > 0 ? JSON.stringify([prefix, signals]) : prefix;
  const h = createHash('sha1').update(`${command}\n${basis}`).digest('hex').slice(0, 12);
  return `${command}/${h}`;
}

/** Bump the per-story gate-failure counter for (command, reason). Best-effort. */
export function bumpGateFailureCount(storyDir: string, command: string, reason: string): void {
  try {
    const counts = readGateFailureCounts(storyDir);
    const key = gateFailureDigest(command, reason);
    const prev = counts[key];
    counts[key] = {
      count: num(prev?.count) + 1,
      command,
      lastReason: String(reason ?? '').slice(0, 500),
      lastAt: nowIso(),
    };
    writeJsonFile(join(storyDir, GATE_FAILURE_FILE), counts);
  } catch {
    // best-effort
  }
}

/**
 * Reset the gate-failure counter (progress = fresh slate); called on every
 * successful story-scoped mutation. F-005: this must NOT create a file when
 * there is nothing to clear — an unconditional write of `{}` on every successful
 * command left a stray untracked gate-failure-counts.json that dirtied the tree
 * in contexts whose .gitignore predates this artifact (breaking a pre-existing
 * story_discard smoke). So only rewrite when the file actually exists AND holds
 * a non-empty map. Best-effort: an existing empty map is left untouched.
 */
export function resetGateFailureCounts(storyDir: string): void {
  try {
    const file = join(storyDir, GATE_FAILURE_FILE);
    if (!existsSync(file)) return;
    if (Object.keys(readGateFailureCounts(storyDir)).length === 0) return;
    writeJsonFile(file, {});
  } catch {
    // best-effort: never fail a successful command on counter reset
  }
}

/** The largest same-(command,reason) repeat count currently recorded. */
export function maxGateFailureCount(counts: GateFailureCounts): number {
  let max = 0;
  for (const rec of Object.values(counts ?? {})) {
    const c = num(rec?.count);
    if (c > max) max = c;
  }
  return max;
}

function nowIso(): string {
  // I/O helpers are not on the pure path; a timestamp here is audit-only.
  return new Date().toISOString();
}

// ── Store collector (reads the four signals; fail-open) ──────────────────────

/**
 * The narrow slice of StoryStore the breaker reads. F-001: collector and gate
 * share this type so no `as StoryStore` cast is needed (which would defeat the
 * Pick and hide a future signature mismatch at compile time).
 */
export type BreakerStore = Pick<StoryStore, 'readStory' | 'readReviewRuns' | 'readReviewPasses' | 'storyDirPath'>;

export function collectBreakerCounters(
  store: BreakerStore,
  storyId: string,
  storyDir: string,
): BreakerCounters {
  let advanceCount = 0;
  try {
    const story = store.readStory(storyId);
    advanceCount = (story.events ?? []).filter(e => e.action === 'advance').length;
  } catch { advanceCount = 0; }

  // Pass-rate is review_pass_set / review_run_start — the two review LEDGERS, not
  // the REVIEW-round count. CHK-001's context suggested reusing
  // resolveReviewRoundCount (which counts REVIEW/advance events = rounds), but that
  // is the wrong denominator here: the B-f458 signature is 131 run_start vs 31
  // pass_set, a ledger ratio, not a round count. So we read the ledgers directly
  // (still no round-logic reimplementation — there is none to reuse for this).
  let reviewRunCount = 0;
  try { reviewRunCount = (store.readReviewRuns(storyId).runs ?? []).length; } catch { reviewRunCount = 0; }

  let reviewPassCount = 0;
  try { reviewPassCount = (store.readReviewPasses(storyId).passes ?? []).length; } catch { reviewPassCount = 0; }

  const takeoverCount = readTakeoverCount(storyDir);
  const maxGateRepeat = maxGateFailureCount(readGateFailureCounts(storyDir));

  return { advanceCount, reviewRunCount, reviewPassCount, takeoverCount, maxGateRepeat };
}

// ── Enforcement seam (CHK-003) ───────────────────────────────────────────────

/**
 * The story_advance choke-point breaker gate, mirroring enforceStoryOwnerLeaseGate:
 * a thin function cli-engine.ts calls at its single command choke point so the
 * enforcement logic (and its throw) lives in ONE testable place, not scattered.
 *
 * CHK-003 covers TWO gated entries (per the checklist title "story_advance and
 * takeover-command entry"): while a story is FROZEN, both `story_advance` AND any
 * takeover-carrying command (--takeover / --forceTakeover) are hard-blocked, so a
 * frozen runaway cannot keep seizing leases to extend the storm. Only a human ack
 * (story_resume) clears it. ASSESSMENT for a new trip happens only on
 * story_advance (the progress action); a takeover command is gated by an existing
 * freeze but never itself triggers a new assessment. Healthy stories are
 * byte-identical to today — no state written, nothing thrown. Fail-open: any
 * resolution error returns silently so the breaker never wedges a healthy command.
 */
export function enforceConvergenceBreakerGate(opts: {
  command: string;
  storyId: string | null | undefined;
  /** True when the command carries --takeover / --forceTakeover. */
  isTakeoverCommand: boolean;
  store: BreakerStore;
  env: Record<string, string | undefined>;
}): void {
  const isAdvance = opts.command === 'story_advance';
  // Only story_advance and takeover-carrying commands are gated by the breaker.
  if (!isAdvance && !opts.isTakeoverCommand) return;
  const storyId = opts.storyId;
  if (!storyId) return;
  // Defense-in-depth (codex host-B round-2 #2): never derive a story path from a
  // non-canonical id. In production the owner-lease gate's path-traversal guard
  // already ran first, but this keeps the breaker self-safe for any direct caller.
  if (!isCanonicalStoryId(storyId)) return;

  let storyDir: string;
  try {
    storyDir = opts.store.storyDirPath(storyId);
  } catch {
    return;
  }
  if (!existsSync(storyDir)) return;

  const prior = readBreakerState(storyDir);

  // Already frozen: block every gated entry (advance OR takeover) until a human
  // ack, without re-assessing.
  if (prior?.frozen) {
    throw new Error(renderBreakerFreeze(storyId, prior.trippedReasons ?? []));
  }

  // A takeover command on a non-frozen story is allowed through untouched; only
  // story_advance runs the signal assessment below.
  if (!isAdvance) return;

  const counters = collectBreakerCounters(opts.store, storyId, storyDir);
  const thresholds = resolveConvergenceThresholds(opts.env);
  const assessment = assessBreaker(counters, thresholds, prior);

  if (assessment.action === 'freeze') {
    writeBreakerState(storyDir, assessment.nextState);
    throw new Error(renderBreakerFreeze(storyId, assessment.reasons));
  }
  if (assessment.action === 'auto-recover') {
    // Persist the re-baseline + spent recovery; the advance PROCEEDS this once.
    writeBreakerState(storyDir, assessment.nextState);
  }
  // 'proceed': healthy — write nothing (byte-identical to today).
}
