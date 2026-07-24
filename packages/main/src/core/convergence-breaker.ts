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
 * The SANITY bound applied to a raw gate-failure reason before it is normalized.
 *
 * B-bf52 CHK-001: hashing is length-agnostic, so truncating buys the digest
 * nothing. The former 200-character cut landed INSIDE the fixed header of a real
 * DEV-gate rejection (machine.ts's preamble plus
 * renderProofStoryDiagnosticReport, whose preamble plus six header lines MEASURE
 * 257 normalized characters, and 433 by the point the first gap row begins in a
 * typical two-trigger report — both figures measured against this normalizer,
 * not asserted; F-018 corrects an earlier "244" that was never measured), so
 * every rejection for one story collapsed to one key no matter
 * which gaps were outstanding — reading incremental progress as one gate failing
 * repeatedly. What remains is a pure sanity bound, applied to the raw input so a
 * pathological reason (an embedded transcript or stack trace) cannot make the
 * normalization pathological either. A generous worst-case real rejection — 20
 * gap rows, 15 trigger rows, 10 parent-rollup rows plus the header — measures
 * 7,448 characters, so 16,384 sits roughly 2.2x above the worst realistic
 * message. Accepted residual: two reasons identical up to the bound and
 * differing only past it still collapse.
 *
 * Exported so the smoke can assert the bound is genuinely APPLIED
 * (`digest(huge) === digest(huge.slice(0, MAX_REASON_CHARS))`) rather than
 * asserting a well-formed digest, which holds whether or not the bound exists.
 */
export const MAX_REASON_CHARS = 16_384;

/**
 * Apply the sanity bound to a raw reason, without splitting a surrogate pair.
 *
 * B-bf52 F-009 (cross-host): `String.prototype.slice` cuts UTF-16 code UNITS, so
 * a reason whose 16,384th unit is the HIGH half of an astral character (emoji,
 * CJK extension) would leave a lone high surrogate at the end, which hashes as a
 * replacement encoding rather than as the original character. Deterministic, so
 * it never destabilized a key across calls, but the bound is trivially made
 * code-point safe by dropping that dangling half.
 */
function boundReasonForDigest(reason: string): string {
  const bounded = String(reason ?? '').slice(0, MAX_REASON_CHARS);
  if (bounded.length === 0) return bounded;
  const last = bounded.charCodeAt(bounded.length - 1);
  // 0xd800-0xdbff is the high-surrogate range: a lone one means the low half was
  // cut off by the bound.
  return last >= 0xd800 && last <= 0xdbff ? bounded.slice(0, -1) : bounded;
}

/**
 * A stable digest for "the same gate failing the same reason".
 *
 * The command name is kept verbatim; the error message is normalized so two
 * rejections differing only in INCIDENTAL detail collapse to one key while
 * substantively different rejections keep separate keys.
 *
 * THE GOVERNING POLICY (B-bf52, adopted in review round 4 after three rounds of
 * oscillation): normalize ONLY provably-volatile SHAPES, and leave every
 * ambiguous bare number alone.
 *
 * The oscillation is the evidence for that policy. Rounds 1-3 tried to decide,
 * per case, whether a bare number was substantive or volatile. Every narrowing
 * produced a case where the breaker silently NEVER TRIPS (F-007 unit-suffixed
 * durations, F-015 sentence-final numbers, F-019 review-run ids, F-022
 * ppid-derived session ids); every widening produced a case where two
 * SUBSTANTIVELY different failures falsely FREEZE a story (F-002 dotted
 * versions, F-014 identifier-attached decimals, F-020 ports, percentages and
 * decimal thresholds in real test output). That is structural, not a sequence of
 * near misses: in free text a bare number is not syntactically decidable —
 * `CHK-002` versus `RR-002`, `attempt 3` versus `port 3000` are the same shape.
 *
 * The tie is broken by which direction has a real producer. `(attempt N)`, the
 * volatile bare counter the general number rule existed to absorb, appears
 * NOWHERE in this repo outside the smoke's own invented fixture. F-020's shapes
 * are real and reachable: `test-evidence` output is interpolated VERBATIM into a
 * `story_advance` DONE rejection (core/machine.ts, `Cannot enter DONE: test
 * ${result}: ${output}`), so `connection to localhost:3000 refused` versus
 * `:4000` are two different validation failures that a bare-number rule reads as
 * one gate failing twice — the exact defect this story exists to remove. Failing
 * toward "distinct" therefore fails toward never falsely freezing, which is this
 * story's purpose, and runaway retries remain separately covered by the
 * burn-alert system.
 *
 * The rule chain, in order:
 *
 *  1. `0x…` values → `#`.
 *  2. ATTACHED hashes: a hyphen/underscore-attached run of 7+ hex characters
 *     that contains at least one a-f LETTER → `#`. A letter-bearing hex run is
 *     provably a digest, never a human ordinal, so `sess-d7efe197b316c43a`
 *     collapses (F-022) while `session-1234567` stays distinct (F-014).
 *  3. FREE-STANDING hashes: a run of 7+ hex characters attached to nothing →
 *     `#`, with dot-adjacency excluded so it cannot bite a chunk out of a
 *     decimal (F-016).
 *  4. ISO-8601 timestamps → `#`.
 *  5. ABSOLUTE paths only, and only at a token start (string start, or after
 *     whitespace, quote, paren, bracket, `:`, `=` or `,`): Windows `c:\…` then
 *     POSIX `/…`. A relative repo path (`src/core/alpha.ts`) and a mid-token
 *     slash (`DEV/REVIEW`) are deliberately LEFT ALONE — they name WHAT failed.
 *  6. Durations and sizes written as a number WELDED TO A UNIT (`45s`, `8m`,
 *     `2h`, `1.5ms`, `12kb`) → `#`. A unit suffix is what makes the number
 *     provably volatile: heartbeat and lock-contention ages are wall-clock noise
 *     that moves on every retry, so leaving them in mints a fresh key per retry
 *     and the breaker never fires (F-007).
 *
 * There is deliberately NO general free-standing-number rule. It was present in
 * rounds 1-3 and is DELETED: a bare number carries no shape evidence either way,
 * and normalizing it is what produced F-002, F-014 and F-020.
 *
 * Both directions are load-bearing and both are guarded case-by-case in
 * tasks/convergence-breaker-smoke.ts: widening a rule re-introduces the false
 * freeze this contract exists to prevent, and deleting the duration, hash or
 * path rules re-introduces the opposite failure — a genuine livelock whose
 * repeat count never accumulates.
 */
export function gateFailureDigest(command: string, reason: string): string {
  const normalized = boundReasonForDigest(reason)
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '#')
    // B-bf52 F-022: an ATTACHED hash. A hyphen/underscore-attached run of 7+ hex
    // characters that contains at least one a-f LETTER is provably a digest and
    // never a human ordinal, which is exactly the distinction the deleted number
    // rule could not make. `deriveLocalSessionId` (core/owner-session.ts) mints
    // `sess-${sha256.slice(0,16)}` from host+root+PPID, so every host that
    // re-execs mints a NEW session id; without this rule the ownership-gate
    // rejection that names it (`… is owned by Proofbound session sess-<hash> …`)
    // minted a fresh digest key on essentially every retry and the breaker never
    // fired. The letter requirement is the whole safety argument: it is what
    // keeps `session-1234567` / `worker-1721775600` distinct (F-014), because a
    // human ordinal or an epoch suffix is decimal and therefore letter-free.
    // Runs BEFORE the free-standing rule below; the two are disjoint by
    // construction (this one REQUIRES a `-`/`_` before the run, that one FORBIDS
    // any word character or hyphen there).
    //
    // Accepted asymmetry: this rule carries no dot-adjacency guard, unlike the
    // free-standing rule. The shape that would need one is a hyphen-attached
    // letter-bearing hex run immediately followed by a decimal point
    // (`x-abcdef1.5`); no producer in this tree emits it, and the nearest real
    // shape (`commit-a1b2c3d.patch`) is a digest that SHOULD collapse.
    .replace(/(?<=[-_])(?=[0-9a-f]*[a-f])[0-9a-f]{7,}(?![\w-])/g, '#') // attached hashes / digests
    // B-bf52 F-014 + F-016: a FREE-STANDING hash. The identifier-attachment
    // protection is not optional — `0-9` is a subset of `0-9a-f`, so a bare `\b`
    // boundary let this rule consume any identifier-attached decimal run of 7+
    // digits: `session-1234567` vs `session-7654321` and `worker-1721775600` vs
    // `worker-1721775601` (epoch-suffixed ids) both collapsed, i.e. two DIFFERENT
    // identifiers read as one gate failing twice.
    //
    // The dot-adjacency lookarounds are F-016: without `(?!\.\d)` this rule bites
    // the integer part out of a decimal whose digits happen to reach 7, so
    // `heartbeat 1234567.5ms ago` normalized to `heartbeat #.# ago` while
    // `heartbeat 123456.5ms ago` (six digits) normalized to `heartbeat # ago` —
    // one duration rendering, two keys, straddling an arbitrary threshold. Only
    // `(?!\.\d)` has a named producer; `(?<!\d\.)` is retained as its symmetric
    // half. Both can only make this rule collapse LESS, which is the direction
    // this policy deliberately fails toward.
    .replace(/(?<![\w-])(?<!\d\.)[0-9a-f]{7,}(?![\w-])(?!\.\d)/g, '#') // free-standing hex ids / hashes
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, '#') // ISO timestamps
    // B-bf52 CHK-002: an absolute path is machine-specific, so it must still
    // collapse — but ONLY when it is a path. The former rule anchored on any
    // slash, so it ate the tail of every slash-bearing token: `DEV/REVIEW` and
    // `DEV/TEST` both became `dev#`, and `src/core/alpha.ts` and
    // `src/core/beta.ts` both became `src#`. These match a leading root only at
    // a TOKEN START (string start, whitespace, quote, paren, bracket, or one of
    // the `:` / `=` / `,` delimiters that real messages use to introduce a path
    // with no space, e.g. `cwd=/Users/...`) and then consume the rest of the
    // token, so `/Users/...` and `/private/var/...` still collapse to one key —
    // including when the path continues into repo-relative segments, which are
    // consumed in the same match rather than left as a per-host remainder —
    // while a mid-token slash is left alone. Structural, not an enumeration of
    // machine roots. F-006: the Windows drive-letter form is handled first,
    // since it carries no forward slash and would otherwise survive whole, so a
    // per-user `c:\users\<name>\...` root would not collapse on a Windows host.
    .replace(/(?:^|(?<=[\s"'(\[:=,]))[a-z]:\\[^\s"')\]]*/g, '#') // windows absolute paths
    .replace(/(?:^|(?<=[\s"'(\[:=,]))\/[^\s"')\]]*/g, '#')       // posix absolute paths
    // B-bf52 F-007: a duration or size is a number WELDED TO A UNIT, and the
    // unit is the shape evidence that makes it provably volatile. This is the
    // one numeric rule the policy keeps. That is not academic: every lease/lock
    // contention message renders `heartbeat ${age} ago` with age from
    // formatLeaseAge / formatLockAge (`45s`, `8m`, `2h`) — story-owner-lease.ts,
    // cli/ownership-gate.ts, main-write-lock.ts, validation-execution-lock.ts —
    // so without this rule a story_advance retried against a live foreign lease
    // or a held lock mints a NEW key on essentially every retry, the repeat
    // count never reaches 2, and the breaker never fires for exactly the stuck
    // runaway it exists to stop. It carries the same identifier-attachment
    // lookarounds as the deleted number rule, so `B-bf52` and `v0.3.229` are
    // untouched, plus the dot-adjacency pair (F-015): `heartbeat 45s.` at the end
    // of a sentence must still collapse, while `1.5ms` must not be split.
    .replace(/(?<![\w-])(?<!\d\.)-?\d+(?:\.\d+)?(?:ms|s|m|h|d|kb|mb|gb|b)(?![\w-])(?!\.\d)/g, '#') // durations / sizes
    //
    // ── NO GENERAL FREE-STANDING-NUMBER RULE (B-bf52 round-4 policy) ──────────
    //
    // Rounds 1-3 ended here with `/(?<![\w-])(?<!\d\.)-?\d+(?:\.\d+)?(?![\w-])(?!\.\d)/g
    // -> '#'`, on the theory that a bare number is an incidental counter. It is
    // DELETED, and its deletion is load-bearing, not an omission:
    //
    //  - `test-evidence` output is interpolated VERBATIM into the DONE rejection
    //    at core/machine.ts (`Cannot enter DONE: test ${result}: ${output}`), so
    //    every bare number a real test harness prints reached this rule. Under it
    //    `connection to localhost:3000 refused` and `…:4000`, `coverage 82%` and
    //    `coverage 91%`, `expected >= 0.95, got 0.72` and `got 0.61` each
    //    collapsed to ONE key — two DIFFERENT validation failures counted as one
    //    gate failing twice, which is the false freeze this story exists to
    //    remove, reintroduced by this story's own fix (F-020).
    //  - The shape it existed to absorb, `(attempt N)`, has NO producer: it
    //    appears nowhere in this repo outside the smoke's own invented fixture.
    //
    // Consequences are accepted deliberately, not overlooked: a bare retry
    // counter, a countdown (F-003), a sentence-final ordinal (F-015), a holder
    // pid and a review-run ordinal (F-019) now keep SEPARATE keys, so a runaway
    // that varies one of them will not accumulate a gate-repeat count. That
    // failure mode is bounded by the burn-alert system, which watches spend
    // rather than message text; a false freeze is not bounded by anything except
    // an interactive human TTY acknowledgement.
    .replace(/\s+/g, ' ')
    .trim();
  const h = createHash('sha1').update(`${command}\n${normalized}`).digest('hex').slice(0, 12);
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
