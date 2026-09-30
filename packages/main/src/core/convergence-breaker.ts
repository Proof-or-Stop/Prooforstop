import { assessConvergenceProgressGate } from './convergence-progress-gate.js';
/**
 * Legacy activity diagnostics plus the current shared convergence gate.
 * Raw advance, takeover, run/pass and repeated-gate counters remain available
 * for historical analysis. They no longer authorize hard freezes. The CLI
 * enforcement seam consumes signed completed-epoch progress, shared with the
 * machine REVIEW mint gate. Human acknowledgement lives in story_resume.
 */

import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { StoryStore } from './store.js';
import { isCanonicalStoryId } from './lifecycle-registry.js';
import { readBrandEnv } from './brand-env.js';
// Takeover counter + fail-open JSON I/O live in the convergence-state-files
// leaf so story-owner-lease can bump the counter without importing this module
// (which reaches the lease back through the progress gate). Re-exported below.
import { nowIso, num, readJsonFile, writeJsonFile, readTakeoverCount } from './convergence-state-files.js';
export { readTakeoverCount, bumpTakeoverCount } from './convergence-state-files.js';

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
  maxAdvance: 'PROOF_OR_STOP_CONVERGENCE_MAX_ADVANCE',
  maxTakeover: 'PROOF_OR_STOP_CONVERGENCE_MAX_TAKEOVER',
  minPassRate: 'PROOF_OR_STOP_CONVERGENCE_MIN_PASS_RATE',
  minSample: 'PROOF_OR_STOP_CONVERGENCE_MIN_SAMPLE',
  maxGateRepeat: 'PROOF_OR_STOP_CONVERGENCE_MAX_GATE_REPEAT',
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
  const raw = readBrandEnv(key, env);
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
  if (truthyEnv(readBrandEnv('AUTOPILOT', env))) return false;
  if (truthyEnv(env.CI)) return false;
  if (truthyEnv(readBrandEnv('NON_INTERACTIVE', env))) return false;
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
    `Next action (a human, not an autopilot session): run \`proof-or-stop done_prepare --dryRun --storyId=${storyId}\` to see the real blocker, ` +
    `then \`proof-or-stop story_resume --storyId=${storyId} --ack --reason="<why it is safe to continue>"\` to clear the freeze. ` +
    `The ack is refused under autopilot / non-interactive sessions.`
  );
}

// ── Per-story I/O (cheap, fail-open) ─────────────────────────────────────────

const BREAKER_STATE_FILE = 'breaker-state.json';
const GATE_FAILURE_FILE = 'gate-failure-counts.json';



export function readBreakerState(storyDir: string): BreakerState | null {
  const raw = readJsonFile<Partial<BreakerState>>(join(storyDir, BREAKER_STATE_FILE));
  return raw ? normalizeState(raw) : null;
}

export function writeBreakerState(storyDir: string, state: BreakerState): void {
  writeJsonFile(join(storyDir, BREAKER_STATE_FILE), { ...state, updatedAt: nowIso() });
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
 * B-bf52 F-058: WHY THERE IS NO ARTIFACT-ID ALLOWLIST HERE, and why re-adding one
 * is not a matter of getting the pattern right.
 *
 * This story set out to deliver three classes. C2 (different phase targets) and C4
 * (different in-repo file paths) are delivered by the narrowed POSIX path rule
 * below. C3 — "`CHK-001` and `CHK-002` are two different gate failures, so they
 * must not share one counter key" — IS NOT DELIVERED, and what follows is a proof
 * that it cannot be, from message text alone. It is not a preference, a deferral or
 * a budget decision.
 *
 * THE PROOF (cross-host codex, review round 15). core/machine.ts:1190 renders
 * `Cannot enter DONE: test ${evidence.result}: ${evidence.output}`, i.e. it
 * interpolates RAW third-party test output into the very text this function keys
 * on. In that channel a bare token like `bug-2` — an ordinary TAP subtest name or a
 * parameterized-test label — is TEXTUALLY IDENTICAL to a bare artifact ordinal:
 *
 *   not ok 1 - bug-2 reproducer still red        third-party label
 *   Cannot enter DONE: 1 unfixed bug(s): BUG-002 artifact ordinal
 *
 * Lower-cased and whitespace-delimited, the token under decision is the same string
 * in both. There is no property OF THE MESSAGE TEXT that separates them, because
 * there is no difference in the message text to find. Any rule that recognises
 * `BUG-002` therefore recognises `bug-2` as well, and any rule that refuses `bug-2`
 * refuses `BUG-002` too. The two outcomes are the only two available.
 *
 * That is why this guard leaked EIGHT times. Rounds 7-14 each closed the shape they
 * had been shown — a wider lookbehind, a token-start anchor, a balanced-wrapper
 * rule, a deleted punctuation strip, a pure-ordinal body — and each time the next
 * round found another shape, because every one of those fixes was an attempt to
 * separate two strings that are equal. The eight leaks were not eight oversights;
 * they were eight measurements of one impossibility.
 *
 * WHICH WAY THE TIE BREAKS, and why that removes the allowlist rather than shrinking
 * it. For a circuit breaker OVER-RECOGNISING is the dangerous direction: a key that
 * is too fine lets a stuck agent mint a fresh key on every retry, so the brake never
 * fires — the unbounded loop this module exists to stop. A key that is too coarse
 * makes the brake fire EARLY: a false freeze, which costs one human acknowledgement.
 * Every exclusion this story made applied that principle — `rr-`, `rp-`, `rl-` and
 * `i-` were all excluded because a retry re-mints them — and applied consistently it
 * removes the allowlist itself. So it is removed: every digit run collapses to `#`,
 * byte for byte as main does it, and the accepted cost is that a story which clears
 * CHK-001 and then trips on CHK-002 still reads as one gate failing twice.
 *
 * WHAT WOULD ACTUALLY DELIVER C3, named so this is a follow-up and not a silence.
 * Recognising an artifact ordinal is possible, but not from the message: the digest
 * would have to CONSULT STORY STATE — ask the store whether `CHK-002` is a checklist
 * item OF THIS STORY, whether `BUG-002` is one of its open bug reports — so that the
 * decision is made against the story's own artifact inventory instead of against a
 * string shape. A third-party label that happens to look like an id is then refused
 * because the story has no such artifact, which is the distinction the text does not
 * carry. That is a different design with different costs — `gateFailureDigest` stops
 * being a pure function of `(command, reason)` and becomes store-dependent on a hot
 * path that must stay cheap, and the inventory itself changes between attempts — and
 * it is out of scope here.
 *
 * The must-still-collapse `embedded-test-output-third-party-label` case in
 * tasks/convergence-breaker-smoke.ts is the permanent record of this decision: it
 * uses codex's exact `bug-2`/`bug-5` pair and it fails the moment anything in this
 * file starts recognising that shape again.
 */

/**
 * The volatile-token normalization applied to a gate reason before it is keyed.
 *
 * Exported — main keeps this chain inline inside `gateFailureDigest` — so a test can
 * assert a fixture's PRECONDITION ("these two reasons share their first 200
 * normalized characters and only then diverge") against the REAL rule chain. The
 * alternative, a hand-mirrored copy of the chain inside a smoke (which
 * tasks/gate-repeat-block-smoke.ts carries as `normalizePrefix`), can drift out of
 * sync with production silently and then attest to a precondition that no longer
 * holds.
 *
 * Every rule here is main's, byte for byte, EXCEPT the POSIX path rule, which is
 * narrowed to token start. See the F-058 note above for why the digit rule is main's
 * bare `/\d+/g` and why nothing is lifted out in front of it.
 */
export function normalizeGateReason(reason: string): string {
  return String(reason ?? '')
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '#')
    .replace(/\b[0-9a-f]{7,}\b/g, '#')          // hex ids / hashes
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, '#') // ISO timestamps
    // Machine-absolute POSIX paths, anchored at TOKEN START (B-bf52 C2/C4). The
    // former `\/[^\s"']+` rewrote from ANY slash anywhere in a token, so it ate the
    // tail of every slash-bearing identifier — `DEV/REVIEW` and `DEV/TEST` both
    // became `dev#`, and `src/core/alpha.ts` and `src/core/beta.ts` both became
    // `src#`, so a story that fixed one phase target or one file and then tripped on
    // another read as one gate failing twice. Anchoring to a token start (or to a
    // delimiter that really does introduce a path: quote, paren, bracket, colon,
    // equals, comma) keeps per-machine roots collapsing while leaving relative
    // in-repo paths and slash-joined identifiers intact.
    //
    // THIS RULE HAS THE AMBIGUITY THE ID RULE DID NOT, WHICH IS WHY IT SURVIVES
    // (F-058). A token-start absolute path is STRUCTURALLY distinguishable from a
    // slash-bearing identifier — the leading `/` is at the token boundary, and no
    // identifier this tree renders begins with one — so recognising the first does
    // not force recognising the second. That is exactly the property `bug-2` versus
    // `BUG-002` lacks, and it is why C2/C4 never leaked while C3 leaked eight times.
    .replace(/(?:^|(?<=[\s"'(\[:=,]))\/[^\s"')\]]*/g, '#')
    // Bare digit runs, byte-for-byte main's rule. A bare `attempt 3`, a welded `45s`
    // heartbeat age, `0/4 lanes`, the story-id ordinal in `b-1234` AND every
    // lifecycle-artifact ordinal (`chk-001`, `bug-002`) all become `#`. The last of
    // those is C3's accepted cost; see F-058 above.
    .replace(/\d+/g, '#')
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
  // IDENTICAL signal set and their ONLY difference is a token this normalizer
  // PRESERVES — after F-058 that means an in-repo path, since every ordinal
  // collapses — sitting PAST character 200 of the normalized reason, both the
  // prefix and the signal list are equal, so the two still collapse onto one key
  // and clearing one then tripping on the next reads as one repeated failure.
  //
  // This is accepted rather than fixed because it is NEVER WORSE THAN MAIN, and
  // that comparison was measured rather than argued: main truncates at 200
  // unconditionally AND rewrites every slash-bearing token from its first slash,
  // so main collapses that same pair — and collapses the within-200 pair too.
  // Within the 200-character window this branch is strictly better (the path
  // survives and the pair keys apart); past it, the two branches are equal. The
  // improvement is therefore BOUNDED, not regressive.
  //
  // WHY 200 IS KEPT, stated accurately (F-042). An earlier revision of this
  // comment said widening the window "is not available"; that overstated the
  // constraint and measurement contradicts it. B-cc54's CHK-002:adversarial:1
  // requires a signal-free tail past its banner to leave the key UNCHANGED, and
  // that banner fixture normalizes to exactly 592 characters — so cuts of 593 and
  // above break B-cc54's suite, while every cut from 275 (the divergence point of
  // the residual pair below) through 592 would fix that pair and leave B-cc54
  // green. A 318-character window exists; it is simply NOT TAKEN, and the reason
  // is the one already given above: on the signals branch this story keeps
  // B-cc54's 200-character prefix EXACTLY, so every key it produces is
  // byte-identical to before this change. Widening would rekey every ProofStory
  // gate rejection in the system to buy back a residual that is already never
  // worse than main. The `blocking-finding-cited-path-past-window` collapse case
  // and its within-window twin `blocking-finding-cited-path-within-window` in
  // tasks/convergence-breaker-smoke.ts pin BOTH directions of this residual, so it
  // stays a known, tested boundary rather than a surprise. (That pair is measured
  // on a cited in-repo PATH, and in round 15 that stopped being a detail: the
  // round-14 pair varied a checklist ORDINAL, which after F-058 collapses on the
  // digit rule at every window, so it could no longer measure this cut at all —
  // the same defect that had already retired the `SEP-…` pair before it.)
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
 * CLI advance/takeover entry: shared verified progress can block with a stall or
 * integrity diagnostic. Reads never rewrite legacy counters or signed history.
 * story_resume reaches its existing human-only acknowledgement checks.
 */
export function enforceConvergenceBreakerGate(opts: {
  command: string;
  storyId: string | null | undefined;
  /** True when the command carries --takeover / --forceTakeover. */
  isTakeoverCommand: boolean;
  store: StoryStore;
  env: Record<string, string | undefined>;
}): void {
  // `story_resume` is the human-only recovery path for a frozen breaker. It may
  // legitimately carry --takeover/--forceTakeover to acquire a fresh terminal
  // session's owner lease, so it must reach its handler for the TTY, --ack, and
  // reason checks. Every other takeover command remains gated below.
  if (opts.command === 'story_resume') return;
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

  const progress = assessConvergenceProgressGate(opts.store, storyId);
  if (progress.blocked) throw new Error(progress.prompt);
  // Preserve legacy counter state for diagnostics. It does not authorize a freeze.
}
