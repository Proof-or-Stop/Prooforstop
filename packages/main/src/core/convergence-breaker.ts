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
 * renderProofStoryDiagnosticReport, whose header alone is 244 normalized
 * characters), so every rejection for one story collapsed to one key no matter
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
 * substantively different rejections keep separate keys. The normalization is
 * deliberately narrow and each rule's exact scope is load-bearing (B-bf52):
 *
 *  - `0x…` values, hex ids/hashes of 7+ digits and ISO-8601 timestamps → `#`.
 *  - ABSOLUTE paths only, and only at a token start (string start, or after
 *    whitespace, quote, paren, bracket, `:`, `=` or `,`): POSIX `/…` and Windows
 *    `c:\…`. A relative repo path (`src/core/alpha.ts`) and a mid-token slash
 *    (`DEV/REVIEW`) are deliberately LEFT ALONE — they name WHAT failed, and
 *    rewriting them collapsed two different failures into one key.
 *  - durations and sizes written as a number with a unit suffix (`45s`, `8m`,
 *    `2h`, `1.5ms`, `12kb`) → `#`. Heartbeat and lock-contention ages are pure
 *    wall-clock noise that changes on essentially every retry, so leaving them
 *    in would mint a fresh key per retry and the breaker would never fire.
 *  - STANDALONE numbers only (`attempt 41`, `pid 4821`, `3>=2`, `-19`, `3.5`)
 *    → `#`. A digit run attached to an identifier by a word character, a hyphen
 *    or a dot (`CHK-001`, `B-bf52`, `round-2`, `v0.3.229`) is part of that
 *    identifier's NAME and is deliberately preserved.
 *
 * Both directions are load-bearing and both are guarded case-by-case in
 * tasks/convergence-breaker-smoke.ts: widening a rule re-introduces the false
 * freeze this contract exists to prevent, and narrowing the duration or number
 * rule re-introduces the opposite failure — a genuine livelock whose repeat
 * count never accumulates.
 */
export function gateFailureDigest(command: string, reason: string): string {
  const normalized = boundReasonForDigest(reason)
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '#')
    .replace(/\b[0-9a-f]{7,}\b/g, '#')          // hex ids / hashes
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
    // B-bf52 F-007: a duration or size is a number welded to a unit letter, so
    // the standalone-number rule below cannot see it — its lookahead treats the
    // unit as an identifier tail. That is not academic: every lease/lock
    // contention message renders `heartbeat ${age} ago` with age from
    // formatLeaseAge / formatLockAge (`45s`, `8m`, `2h`) — story-owner-lease.ts,
    // cli/ownership-gate.ts, main-write-lock.ts, validation-execution-lock.ts —
    // so without this rule a story_advance retried against a live foreign lease
    // or a held lock mints a NEW key on essentially every retry, the repeat
    // count never reaches 2, and the breaker never fires for exactly the stuck
    // runaway it exists to stop. Runs BEFORE the number rule so the digits are
    // consumed together with their unit.
    .replace(/(?<![\w.-])-?\d+(?:\.\d+)?(?:ms|s|m|h|d|kb|mb|gb|b)(?![\w.-])/g, '#') // durations / sizes
    // B-bf52 CHK-003: a free-standing counter is incidental, but a digit run
    // ATTACHED to an identifier is part of that identifier's name. The former
    // unconditional rule rewrote both, so `CHK-001` and `CHK-002` — two
    // different checklist items — both became `chk-#`. This one matches only a
    // standalone number, i.e. one not preceded or followed by a word character,
    // a hyphen or a dot, so `attempt 41`, `3>=2`, `0/4 lanes` and `pid 4821`
    // still collapse while `CHK-001`, `round-2`, story ids and dotted versions
    // survive (F-002: `v0.3.229` and `v0.3.230` are different requirements, and
    // without `.` in the protection set both became `v#.#.#`). The sign is
    // consumed by the match rather than excluded by the lookbehind (F-003):
    // treating a leading `-` as an identifier hyphen left `-5` and `-19`
    // distinct, so a countdown in a rejection message never collapsed.
    .replace(/(?<![\w.-])-?\d+(?:\.\d+)?(?![\w.-])/g, '#')     // free-standing numbers only
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
