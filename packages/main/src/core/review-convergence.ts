import { assessConvergenceProgressGate } from './convergence-progress-gate.js';
/**
 * REVIEW convergence-stall diagnostic shared by advisory and mint-gate consumers.
 *
 * Background: every finding-fix commit changes the source tree and stales that
 * round's review-run bindings (content-aware materialHash in
 * core/evidence-freshness.ts), forcing a fresh REVIEW round. Structurally this
 * cannot deadlock, but an operator who keeps fixing minor findings instead of
 * dismissing them can LIVELOCK with no mechanical signal. This module derives a
 * legacy round-based stall signal from already-observable state (REVIEW round
 * count from story events + per-round blocking-finding counts). The mint gate
 * below consumes this diagnostic; signed epoch progress remains a separate fact.
 *
 * Reuse discipline: round counting comes from resolveReviewRoundCount
 * (advisory.ts) and the per-round blocking decision reuses isFindingBlocking
 * (advisory.ts) + resolveEffectiveBlockingSeverities (guard-utils.ts). This
 * module does NOT reimplement round/blocking logic.
 */
import { resolveReviewRoundCount } from './advisory.js';
import { readDynamicFindingDecision } from './finding-applicability-projection.js';
import { readBrandEnv } from './brand-env.js';
import { loadConfig } from './config.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
// B-7813 CHK-002 fills the CHK-001 seam: read the signed stall-adjudication.json
// and re-validate it. Function-scoped usage only (never at module-init), so the
// mutual review-convergence ↔ stall-adjudication import edge is ESM-safe.
import { isValidCurrentRoundStallResolution } from './stall-adjudication.js';
import type { StoryStore } from './store.js';
import type { Finding } from './types.js';

/**
 * Minimum REVIEW round count before a stall can be reported. Below this we never
 * warn (a story still converging through its first few rounds is healthy).
 */
export const STALL_MIN_ROUNDS = 4;

/**
 * Size of the trailing window of per-round blocking counts inspected for a
 * downward trend. We only look at the most recent STALL_WINDOW rounds.
 */
export const STALL_WINDOW = 3;

export interface ReviewConvergenceInputs {
  /** Current REVIEW round count (reuses resolveReviewRoundCount). */
  roundCount: number;
  /**
   * DENSE, round-aligned per-round blocking-finding counts. Always has length
   * === roundCount: index i corresponds to ACTUAL review round i+1 (round 1 at
   * index 0 .. round roundCount at index roundCount-1). Rounds with no findings
   * (or no blocking findings) are 0, so a recently-clean tail shows trailing
   * zeros. The decay tier applied to each round's blocking decision is keyed to
   * that round's ACTUAL number, never to the position among rounds-that-have
   * -findings — so a round-with-no-findings does not shift later rounds onto the
   * wrong severity tier.
   */
  perRoundBlockingCounts: number[];
}

/**
 * CHK-001: read-only accessor. Derives the REVIEW round count + a DENSE,
 * round-aligned per-round blocking-finding count array from the store.
 * Pure-ish: only reads via the store, no writes, no transition side effects.
 *
 * Round identity / mapping approach (documented choice):
 *   - The canonical round count and round identities come from the SAME source
 *     resolveReviewRoundCount uses: story.events where phase==='REVIEW' &&
 *     action==='advance'. Each such event's `timestamp` is one review-round
 *     identity, in chronological order. This guarantees the array aligns with
 *     the canonical roundCount.
 *   - A finding's `reviewRound` ISO timestamp is matched against those event
 *     timestamps to place it in its actual round number. If the finding
 *     reviewRounds do NOT line up 1:1 with the event timestamps (legacy /
 *     synthetic stores whose findings carry round ids that are not event
 *     timestamps), we FALL BACK to mapping the sorted unique finding
 *     reviewRounds onto the LAST k round slots (the most recent rounds),
 *     padding earlier rounds with 0. Rationale: findings accrue toward recent
 *     rounds, and trailing-clean detection (the stall signal) cares about the
 *     most recent rounds, so anchoring partial data to the tail is the safe,
 *     non-false-alarming choice.
 *
 * Per-round blocking determination:
 *   - For each ACTUAL round r (1-based), compute that round's effective blocking
 *     severities via effectiveBlockingForRound(r, round1BlockingSeverities) —
 *     the SAME decay rule as resolveEffectiveBlockingSeverities (Round 1 =
 *     policy.review.blockingSeverities; Round 2 = critical+high; Round 3+ =
 *     critical) — and count findings assigned to round r that are blocking via
 *     isFindingBlocking for that round number.
 */
export function collectReviewConvergenceInputs(
  store: StoryStore,
  storyId: string,
): ReviewConvergenceInputs {
  const roundCount = resolveReviewRoundCount(store, storyId);

  let findings: Finding[] = [];
  try {
    findings = store.readFindings(storyId).findings ?? [];
  } catch {
    findings = [];
  }

  // Round-1 blocking severities come from the resolved workflow policy, exactly
  // as the guard-utils call sites obtain it (loadConfig -> resolveWorkflowPolicy).
  let round1BlockingSeverities: readonly string[];
  let reviewRoundTimestamps: string[] = [];
  try {
    const story = store.readStory(storyId);
    const config = loadConfig(store.projectRoot);
    const policy = resolveWorkflowPolicy(config, story);
    round1BlockingSeverities = policy.review.blockingSeverities;
    // Canonical round identities: the timestamps of the REVIEW/advance events
    // that resolveReviewRoundCount counts, in chronological order.
    reviewRoundTimestamps = (story.events ?? [])
      .filter(e => e.phase === 'REVIEW' && e.action === 'advance' && Boolean(e.timestamp))
      .map(e => e.timestamp as string);
  } catch {
    // Conservative fallback matching the strictest Round-1 set; this only
    // affects the count when policy is unreadable (never blocks anything).
    round1BlockingSeverities = ['critical', 'high', 'medium'];
  }

  // Assign each finding to an actual round number (1-based) over a dense
  // 0..roundCount-1 array. findingsByRound[i] holds findings for round i+1.
  const findingsByRound: Finding[][] = Array.from({ length: roundCount }, () => []);

  // Sorted unique finding reviewRounds (chronological), mirror review-escalation.ts ordering.
  const findingRounds = [...new Set(
    findings.map(f => f.reviewRound).filter((r): r is string => Boolean(r)),
  )].sort((a, b) => {
    const at = Date.parse(a);
    const bt = Date.parse(b);
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
    return a.localeCompare(b);
  });

  // Primary mapping: finding reviewRound timestamps line up with event timestamps.
  const eventIndexByTs = new Map<string, number>();
  reviewRoundTimestamps.forEach((ts, idx) => {
    if (!eventIndexByTs.has(ts)) eventIndexByTs.set(ts, idx);
  });
  const alignsWithEvents = roundCount > 0
    && findingRounds.length > 0
    && findingRounds.every(r => eventIndexByTs.has(r));

  if (alignsWithEvents) {
    for (const f of findings) {
      if (!f.reviewRound) continue;
      const idx = eventIndexByTs.get(f.reviewRound);
      if (idx !== undefined && idx >= 0 && idx < roundCount) {
        findingsByRound[idx].push(f);
      }
    }
  } else {
    // Fallback: anchor sorted unique finding rounds to the LAST k round slots.
    // roundOffset shifts the earliest finding-round onto the slot that leaves
    // the most recent finding-round at the final (roundCount-1) index.
    const k = Math.min(findingRounds.length, roundCount);
    const roundOffset = roundCount - k; // earlier rounds (offset slots) stay 0
    const slotByRound = new Map<string, number>();
    findingRounds.slice(-k).forEach((r, i) => {
      slotByRound.set(r, roundOffset + i);
    });
    for (const f of findings) {
      if (!f.reviewRound) continue;
      const slot = slotByRound.get(f.reviewRound);
      if (slot !== undefined && slot >= 0 && slot < roundCount) {
        findingsByRound[slot].push(f);
      }
    }
  }

  const perRoundBlockingCounts = findingsByRound.map((roundFindings, idx) => {
    // Actual round number is index + 1 — the decay tier is keyed to this, NOT
    // to a position among rounds-with-findings.
    const roundNumber = idx + 1;
    const effectiveBlockingSeverities = effectiveBlockingForRound(roundNumber, round1BlockingSeverities);
    return roundFindings
      .filter(f => readDynamicFindingDecision({ store, projectRoot: store.projectRoot, storyId, finding: f,
        effectiveBlockingSeverities, round: roundNumber }).blocking)
      .length;
  });

  return { roundCount, perRoundBlockingCounts };
}

/**
 * Mirrors the canonical round-decay rule from
 * guard-utils.ts resolveEffectiveBlockingSeverities, but parameterized by an
 * explicit round index so we can evaluate historical rounds (the store helper
 * only resolves the latest round). Kept here, not duplicated logic: it is the
 * same three-branch decay, applied per index instead of per latest-round.
 */
function effectiveBlockingForRound(
  roundIndex: number,
  round1BlockingSeverities: readonly string[],
): readonly string[] {
  if (roundIndex >= 3) return ['critical'];
  if (roundIndex >= 2) return ['critical', 'high'];
  return round1BlockingSeverities;
}

export interface ReviewConvergenceAssessment {
  stalled: boolean;
  message?: string;
}

/**
 * CHK-002: PURE decision function. No I/O. Given the round count + per-round
 * blocking counts, decide whether REVIEW appears to be stalling (cycling rounds
 * without converging) and, if so, build an English advisory message.
 *
 * Stall heuristic (trend-based, NOT a raw round ceiling):
 *   stalled = roundCount >= STALL_MIN_ROUNDS
 *             && the trailing window of blocking counts shows NO downward trend.
 *
 * Input shape: perRoundBlockingCounts is DENSE and round-aligned (length ===
 * roundCount, index === actual round-1) per collectReviewConvergenceInputs. So
 * once roundCount >= STALL_MIN_ROUNDS (4) and STALL_WINDOW (3) <= 4, the trailing
 * window always has exactly STALL_WINDOW real entries — and recently-clean rounds
 * contribute their actual 0s.
 *
 * PRECONDITION / SHORT-WINDOW BEHAVIOR (enforced, not just documented): the
 * strictly-decreasing trend branch (b) is only meaningful over a FULL window of
 * STALL_WINDOW values. If the trailing window has FEWER than STALL_WINDOW entries
 * (a caller passing a shorter perRoundBlockingCounts than the production entry
 * point supplies — e.g. assessReviewConvergence(4, [2, 1])), there is not enough
 * completed-round history to assert a SUSTAINED stall, so we conservatively return
 * { stalled: false } (no false alarm for a soft advisory). This check runs BEFORE
 * the strict-decreasing / clean-tail logic. The production entry point
 * (assessReviewConvergenceAtEntry) always supplies a full window — its `completed`
 * array has length roundCount-1 >= STALL_MIN_ROUNDS-1 (3) === STALL_WINDOW (3) —
 * so this guard is a no-op on the production path and never changes a full-window
 * classification. It only removes a short-window false positive for direct callers.
 *
 * A clean latest round or any measured blocker reduction in the trailing
 * window is progress. Requiring every adjacent round to decrease falsely
 * freezes [2,2,1]. A flat or rising window still reports a stall; two adjacent
 * comparisons must lack improvement before this legacy round diagnostic fires.
 * Signed completed-epoch accounting is a separate authority boundary.
 */
export function assessReviewConvergence(
  roundCount: number,
  perRoundBlockingCounts: number[],
): ReviewConvergenceAssessment {
  if (roundCount < STALL_MIN_ROUNDS) {
    return { stalled: false };
  }

  const window = perRoundBlockingCounts.slice(-STALL_WINDOW);

  // Short-window guard (precondition enforcement): a trailing window with fewer
  // than STALL_WINDOW entries does not carry enough completed-round history to
  // assert a SUSTAINED stall. Conservatively report NOT stalled (no false alarm).
  // Runs BEFORE the trend logic so a genuinely-decreasing short window like [2,1]
  // is never misread as a stall just because it cannot fill a full window. The
  // production entry point always supplies a full window, so this is a no-op there.
  if (window.length < STALL_WINDOW) {
    return { stalled: false };
  }

  // (a) Most recent round clean => blockers driven to zero => converged.
  const recentRoundClean = window[window.length - 1] === 0;

  // A plateau must not erase the verified reduction immediately after it.
  const hasBlockerReduction = window.some((value, i) => i > 0 && value < window[i - 1]);

  if (recentRoundClean || hasBlockerReduction) {
    return { stalled: false };
  }

  return {
    stalled: true,
    message: buildStallMessage(roundCount, window),
  };
}

/**
 * CHK-003: thin store entry point used at REVIEW-entry render time.
 *
 * WHY this exists (the crux of CHK-003): at the moment story_advance REVIEW
 * renders its output, the just-entered round's REVIEW/advance event is ALREADY
 * counted by resolveReviewRoundCount — so roundCount includes the CURRENT round.
 * But that round's reviewers have NOT run yet, so the current round's
 * blocking-finding count is always 0. assessReviewConvergence has a
 * `recentRoundClean = window[last] === 0 => not stalled` carve-out; feeding it
 * the raw dense per-round counts (whose trailing entry is the always-empty
 * current round) would make the advisory NEVER fire — a silent no-op.
 *
 * THEREFORE we assess the trend over COMPLETED rounds only: drop the trailing
 * current round before handing the window to the pure assessor. roundCount stays
 * the FULL entry count, so the `roundCount >= STALL_MIN_ROUNDS` threshold still
 * means "entered REVIEW >= STALL_MIN_ROUNDS times"; only the trend window is
 * restricted to rounds whose reviewers have actually run.
 *
 * Pure-ish: only reads via the store (delegates to collectReviewConvergenceInputs),
 * no writes, no transition side effects. assessReviewConvergence stays PURE.
 */
export function assessReviewConvergenceAtEntry(
  store: StoryStore,
  storyId: string,
): ReviewConvergenceAssessment {
  const { roundCount, perRoundBlockingCounts } = collectReviewConvergenceInputs(store, storyId);
  // Drop the just-entered current round (its reviewers have not run yet, so its
  // blocking count is structurally 0 at render time). Assess the trend over the
  // COMPLETED rounds only. roundCount is intentionally left as the full count.
  const completed = perRoundBlockingCounts.slice(0, -1);
  return assessReviewConvergence(roundCount, completed);
}

/**
 * Builds the English-only advisory message. Starts with a stable marker so the
 * line is easy to grep/test, and includes BOTH escalation hints.
 */
function buildStallMessage(roundCount: number, recentCounts: number[]): string {
  const counts = recentCounts.length > 0 ? recentCounts.join(', ') : 'none';
  return [
    `WARN review convergence stall: REVIEW has cycled ${roundCount} rounds and the most recent rounds still surface blocking findings with no downward trend (recent rounds: [${counts}]).`,
    '  - Debugging Contract escalation: 3+ fix attempts that keep surfacing new problems usually point to an architecture/design issue. Consider escalating the design instead of patching another round.',
    '  - Prefer dismissing advisory-level findings (finding_dismiss + reason) over re-rounding: every source-changing fix-commit stales the round and forces a fresh REVIEW round.',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* B-7813 CHK-001: stall adjudication (advisory trend signal -> BLOCK).        */
/* -------------------------------------------------------------------------- */

/**
 * The structured resolution actions that (once CHK-002 lands the
 * stall_resolution_set command + signed, current-round-bound record) clear the
 * stall block for EXACTLY the next ordinary review round. Named here so the
 * blocking prompt and the CHK-002 action enum share ONE source and can never
 * drift. Order is stable for grep/test.
 *
 * The first FIVE are the ordinary per-round resolutions (CHK-002). The SIXTH,
 * `override_budget` (CHK-003), is the PRIVILEGED hard-ceiling override — it is
 * validated + signed through the SAME machinery ("like the others") so it too
 * requires its own reason and is current-round-bound, but it additionally clears
 * the CHK-003 hard-ceiling block that an ordinary per-round resolution CANNOT
 * (see PRIVILEGED_OVERRIDE_ACTION + evaluateStallAdjudication). Because it is a
 * strictly-stronger act, it ALSO satisfies the ordinary per-round clear.
 */
export const STALL_RESOLUTION_ACTIONS = [
  'authorize_continuation',
  'replan',
  'escalate_root_cause',
  'resolve_findings',
  'declare_unreachable',
  'override_budget',
] as const;

export type StallResolutionAction = (typeof STALL_RESOLUTION_ACTIONS)[number];

/**
 * CHK-003: the one PRIVILEGED action that clears the hard-ceiling block. An
 * ordinary per-round resolution (the other five actions) does NOT clear the
 * ceiling — only a record whose action === this value does. Consumed on read by
 * hasCurrentRoundPrivilegedOverride (which re-validates the signed record AND
 * requires this exact action), so the ceiling can never be bypassed by an
 * ordinary resolution.
 */
export const PRIVILEGED_OVERRIDE_ACTION: StallResolutionAction = 'override_budget';

/** The ordinary per-round resolution actions (everything EXCEPT the privileged override). */
export const ORDINARY_STALL_RESOLUTION_ACTIONS = STALL_RESOLUTION_ACTIONS.filter(
  a => a !== PRIVILEGED_OVERRIDE_ACTION,
) as readonly StallResolutionAction[];

/** Stable machine-readable tag surfaced in the guard-failure message. */
export const STALL_ADJUDICATION_CODE = 'review_convergence_stall';

/** Stable machine-readable tag for the CHK-003 hard-ceiling refusal. */
export const STALL_CEILING_CODE = 'review_convergence_stall_ceiling';

/* -------------------------------------------------------------------------- */
/* B-7813 CHK-003: hard ceiling on total ordinary review rounds.               */
/* -------------------------------------------------------------------------- */

/**
 * DEFAULT hard ceiling on total ordinary review rounds. Once the completed
 * review-round count EXCEEDS this ceiling, minting another ordinary round is
 * refused EVEN IF a per-round resolution is recorded — only a privileged
 * override (override_budget) proceeds. A small multiple of STALL_MIN_ROUNDS (4):
 * a stall can first be DETECTED at round 4 and cleared with per-round
 * resolutions up through the ceiling, giving generous runway before the hard
 * wall that forces a conscious, signed budget override. This is a DIFFERENT
 * accounting domain from convergence-breaker's maxAdvance (advances, not review
 * rounds); the two counters never share a value.
 */
export const STALL_HARD_CEILING_ROUNDS = 3 * STALL_MIN_ROUNDS; // 12

/**
 * Env override for the hard ceiling (mirrors convergence-breaker's env pattern).
 * Canonical spelling; `resolveStallHardCeiling` reads it via `readBrandEnv`, so the
 * deprecated `PROOF_OR_STOP_STALL_HARD_CEILING_ROUNDS` export is still honoured.
 */
export const STALL_HARD_CEILING_ENV = 'PROOF_OR_STOP_STALL_HARD_CEILING_ROUNDS';

/** Sanity ceiling: a value above this is a typo, not a threshold. */
export const STALL_HARD_CEILING_ENV_MAX = 100_000;

/**
 * Resolve the hard-ceiling threshold from an env record (pure; callers pass
 * process.env at the I/O boundary, exactly like resolveConvergenceThresholds).
 * A missing / empty / non-numeric / non-finite / non-positive / above-sanity
 * value falls back to the default — a typo'd env must never zero or break the
 * ceiling brake.
 */
export function resolveStallHardCeiling(env: Record<string, string | undefined>): number {
  // Stays pure (env is injected) while accepting either brand spelling.
  const raw = readBrandEnv(STALL_HARD_CEILING_ENV, env);
  if (raw === undefined) return STALL_HARD_CEILING_ROUNDS;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return STALL_HARD_CEILING_ROUNDS;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return STALL_HARD_CEILING_ROUNDS;
  if (value <= 0) return STALL_HARD_CEILING_ROUNDS;
  if (value > STALL_HARD_CEILING_ENV_MAX) return STALL_HARD_CEILING_ROUNDS;
  return value;
}

export interface StallAdjudicationInputs {
  /**
   * The EXISTING trend signal, i.e. the output of assessReviewConvergence over
   * the mint-site round history. This is the ONLY convergence surface — the
   * adjudication reuses it verbatim and adds no raw round ceiling (the ceiling
   * is CHK-003).
   */
  assessment: ReviewConvergenceAssessment;
  /**
   * Whether a signed, current-round-bound structured resolution record exists
   * for the CURRENTLY stalled round. CHK-002 populates this from a validated
   * stall-adjudication.json (reason min length + current-round binding +
   * signature). Until then it is always false, so a genuine stall is blocked
   * and cannot be cleared by prose — only by the future signed record.
   */
  hasCurrentRoundResolution: boolean;
  /**
   * CHK-003: total ordinary review rounds observed at the mint site (the same
   * completed-round count assessReviewConvergence is fed). Compared against
   * `ceiling` for the hard-ceiling brake. Keyed on REVIEW ROUNDS — a DIFFERENT
   * accounting domain from convergence-breaker's advance count.
   */
  roundCount: number;
  /**
   * CHK-003: the resolved hard ceiling on total ordinary review rounds
   * (resolveStallHardCeiling(env); default STALL_HARD_CEILING_ROUNDS). Injected
   * so this function stays PURE — no process.env read here.
   */
  ceiling: number;
  /**
   * CHK-003: whether a signed, current-round-bound PRIVILEGED override
   * (override_budget) record exists for the current round. Only this clears the
   * hard-ceiling block; an ordinary per-round resolution does not. Populated by
   * hasCurrentRoundPrivilegedOverride (re-validates the signed record AND
   * requires action === PRIVILEGED_OVERRIDE_ACTION).
   */
  hasPrivilegedOverride: boolean;
}

export interface StallAdjudication {
  /** True => minting another ordinary review round is REFUSED. */
  blocked: boolean;
  /** Structured English prompt naming the allowed §3 actions; only when blocked. */
  prompt?: string;
  /** Stable machine-readable code for the gate-failure tag; only when blocked. */
  code?: string;
}

/**
 * PURE decision function. No I/O, no store, no clock — a deterministic function
 * of observable state only (the trend assessment + the two resolution booleans +
 * the round count and injected ceiling).
 *
 * Decision table (evaluated top-to-bottom):
 *   (1) assessment.stalled === false          -> ALLOW (converging or too-few rounds).
 *       Preserves CHK-001's invariant VERBATIM: a genuinely converging story
 *       (trailing-clean last==0, or strictly decreasing) is NEVER blocked, even
 *       at/beyond STALL_MIN_ROUNDS and even beyond the hard ceiling.
 *   (2) stalled && roundCount > ceiling        -> HARD-CEILING branch:
 *         - hasPrivilegedOverride              -> ALLOW (a signed override_budget proceeds).
 *         - else                               -> BLOCK [STALL_CEILING_CODE]. This
 *           branch is checked BEFORE the per-round-resolution clear below, so
 *           beyond the ceiling the mint is refused EVEN IF an ordinary per-round
 *           resolution is recorded — only a privileged override proceeds. This is
 *           what stops the adjudication from being ignored indefinitely by
 *           recording one ordinary resolution every round.
 *   (3) stalled && hasCurrentRoundResolution    -> ALLOW (below the ceiling, a
 *       current-round resolution clears exactly the next round — CHK-002).
 *   (4) stalled && !hasCurrentRoundResolution   -> BLOCK [STALL_ADJUDICATION_CODE]
 *       (ordinary stall block; carry the structured prompt).
 *
 * It deliberately does NOT re-derive the stall — it consumes assessReviewConvergence's
 * verdict. Note override_budget also satisfies hasCurrentRoundResolution (it is a
 * strictly-stronger act), so it clears both the ceiling AND, below the ceiling,
 * the ordinary stall.
 */
export function evaluateStallAdjudication(inputs: StallAdjudicationInputs): StallAdjudication {
  // (1) Converging / too-few rounds -> allow (CHK-001 invariant, unchanged).
  if (!inputs.assessment.stalled) {
    return { blocked: false };
  }
  // (2) Hard ceiling on total ordinary rounds. Checked BEFORE the per-round
  //     resolution clear so an ordinary resolution cannot bypass the ceiling.
  if (inputs.roundCount > inputs.ceiling) {
    if (inputs.hasPrivilegedOverride) {
      return { blocked: false };
    }
    return {
      blocked: true,
      code: STALL_CEILING_CODE,
      prompt: buildStallCeilingPrompt(inputs.roundCount, inputs.ceiling, inputs.assessment),
    };
  }
  // (3) Below the ceiling: a current-round resolution clears exactly the next round.
  if (inputs.hasCurrentRoundResolution) {
    return { blocked: false };
  }
  // (4) Stalled, below ceiling, no resolution -> ordinary stall block.
  return {
    blocked: true,
    code: STALL_ADJUDICATION_CODE,
    prompt: buildStallAdjudicationPrompt(inputs.assessment),
  };
}

/**
 * Builds the structured, English-only block prompt. Leads with a stable marker
 * ([review_convergence_stall]) for grep/test, echoes the advisory trend detail
 * (assessment.message, when present), and NAMES the five allowed resolution
 * actions the operator must record (via CHK-002's stall_resolution_set) to mint
 * another round or close the loop.
 */
function buildStallAdjudicationPrompt(assessment: ReviewConvergenceAssessment): string {
  const lines = [
    `Cannot mint another ordinary REVIEW round: convergence has stalled and no current-round resolution is recorded. [${STALL_ADJUDICATION_CODE}]`,
  ];
  if (assessment.message) {
    lines.push(assessment.message);
  }
  lines.push(
    '→ This mint is refused until you record ONE structured resolution bound to the current stalled round (CHK-002 stall_resolution_set). Allowed actions:',
    '  - authorize_continuation: consciously allow one more ordinary round (with a reason).',
    '  - replan: return to PLAN and re-decompose the checklist/decision.',
    '  - escalate_root_cause: escalate the design/architecture instead of patching another round (Debugging Contract: 3+ non-converging fix attempts).',
    '  - resolve_findings: dismiss the advisory-level findings that keep re-rounding (finding_dismiss + reason) rather than re-rounding.',
    '  - declare_unreachable: mark the offending checklist item withdrawn/unreachable (B-1909 withdrawn-disposition) and close the loop.',
  );
  return lines.join('\n');
}

/**
 * CHK-003: the structured, English-only HARD-CEILING refusal prompt. Distinct
 * from the ordinary stall prompt — leads with STALL_CEILING_CODE for grep/test,
 * states the total-rounds cap has been exceeded, and makes explicit that an
 * ordinary per-round resolution will NOT clear it: only a signed
 * `override_budget` (with its own reason) proceeds. This is the wall that forces
 * a conscious budget decision once a story has cycled past the hard ceiling.
 */
function buildStallCeilingPrompt(
  roundCount: number,
  ceiling: number,
  assessment: ReviewConvergenceAssessment,
): string {
  const lines = [
    `Cannot mint another ordinary REVIEW round: total ordinary review rounds (${roundCount}) have exceeded the hard ceiling (${ceiling}). [${STALL_CEILING_CODE}]`,
  ];
  if (assessment.message) {
    lines.push(assessment.message);
  }
  lines.push(
    '→ Beyond the hard ceiling an ordinary per-round resolution (authorize_continuation / replan / escalate_root_cause / resolve_findings / declare_unreachable) will NOT clear this block — the review budget is exhausted.',
    `  - The ONLY way to mint another ordinary round is to record the PRIVILEGED override with its own reason: stall_resolution_set action=${PRIVILEGED_OVERRIDE_ACTION}.`,
    '  - The override is itself current-round-bound and signed, so it authorizes EXACTLY the next ordinary round — it is not a permanent budget increase, and each further round past the ceiling needs its own conscious override.',
    '  - Strongly prefer closing the loop instead: escalate the design (Debugging Contract) or declare the offending checklist item unreachable rather than paying down more rounds.',
    `  - The hard ceiling defaults to ${STALL_HARD_CEILING_ROUNDS} rounds and can be tuned via the ${STALL_HARD_CEILING_ENV} env var.`,
  );
  return lines.join('\n');
}

/**
 * CHK-002 (fills the CHK-001 seam). Presence of a signed, current-round-bound
 * structured resolution record (stall-adjudication.json) for the CURRENTLY
 * stalled round.
 *
 * Reads the persisted record and RE-VALIDATES it against the current stalled
 * round via the pure isValidCurrentRoundStallResolution predicate (reason min
 * length + current-round binding + signature). Returns true ONLY when a valid,
 * current-review-round, signed resolution exists — a previous-round / empty /
 * unsigned / tampered record returns false and does NOT clear the block. This is
 * one of the two consumption points (this gate + the stall_resolution_set
 * handler) that must both re-validate the record; neither trusts the other.
 *
 * Pure-ish store consumer (same discipline as collectReviewConvergenceInputs):
 * reads only, no writes, no transition side effects. Fail-closed on any read
 * error — an infra/read failure means "no valid resolution", so the block holds
 * (it never silently clears the stall).
 */
export function hasCurrentRoundStallResolution(store: StoryStore, storyId: string): boolean {
  try {
    const record = store.readStallAdjudication(storyId);
    if (!record) return false;
    let currentReviewRound = '';
    try {
      currentReviewRound = store.readStory(storyId).currentReviewRound || '';
    } catch {
      return false;
    }
    return isValidCurrentRoundStallResolution(record, currentReviewRound);
  } catch {
    return false;
  }
}

/**
 * CHK-003 (gate consumer of the privileged override). Presence of a signed,
 * current-round-bound record whose action is the PRIVILEGED override
 * (override_budget) for the CURRENTLY stalled round.
 *
 * RE-VALIDATION (Handler encoding convention, "re-validate at handler + gate"):
 * this re-runs the FULL isValidCurrentRoundStallResolution check (reason min
 * length + current-round binding + signature) — exactly as the ordinary
 * resolution gate does — AND additionally requires action ===
 * PRIVILEGED_OVERRIDE_ACTION. So the hard-ceiling block can be cleared ONLY by a
 * genuine, signed, current-round override; a stale / previous-round / unsigned /
 * tampered record, or any of the five ordinary actions, returns false and the
 * ceiling holds. Fail-closed on any read error (the block holds).
 */
export function hasCurrentRoundPrivilegedOverride(store: StoryStore, storyId: string): boolean {
  try {
    const record = store.readStallAdjudication(storyId);
    if (!record) return false;
    if (record.action !== PRIVILEGED_OVERRIDE_ACTION) return false;
    let currentReviewRound = '';
    try {
      currentReviewRound = store.readStory(storyId).currentReviewRound || '';
    } catch {
      return false;
    }
    return isValidCurrentRoundStallResolution(record, currentReviewRound);
  } catch {
    return false;
  }
}

/** Read-only machine mint entry sharing completed-epoch authority with the CLI.
 * The env argument remains source-compatible; raw thresholds are diagnostic only.
 */
export function evaluateReviewMintStallAdjudication(
  store: StoryStore,
  storyId: string,
  env: Record<string, string | undefined> = process.env,
): StallAdjudication {
  // Legacy round trends and ceilings remain advisory diagnostics. Both hard
  // entries consume the same verified completed-epoch decision.
  void env;
  return assessConvergenceProgressGate(store, storyId);
}
