/**
 * B-cfdd: Soft REVIEW convergence-stall advisory (Option C).
 *
 * Background: every finding-fix commit changes the source tree and stales that
 * round's review-run bindings (content-aware materialHash in
 * core/evidence-freshness.ts), forcing a fresh REVIEW round. Structurally this
 * cannot deadlock, but an operator who keeps fixing minor findings instead of
 * dismissing them can LIVELOCK with no mechanical signal. This module derives a
 * SOFT, advisory-only stall signal from already-observable state (REVIEW round
 * count from story events + per-round blocking-finding counts) and NEVER blocks
 * a transition. Thresholds are module constants — no CLI, no config.
 *
 * Reuse discipline: round counting comes from resolveReviewRoundCount
 * (advisory.ts) and the per-round blocking decision reuses isFindingBlocking
 * (advisory.ts) + resolveEffectiveBlockingSeverities (guard-utils.ts). This
 * module does NOT reimplement round/blocking logic.
 */
import { resolveReviewRoundCount, isFindingBlocking } from './advisory.js';
import { loadConfig } from './config.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
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
    const config = loadConfig();
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
      .filter(f => isFindingBlocking(f, effectiveBlockingSeverities, roundNumber))
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
 * Convergence rule (precise & deterministic). Take the last STALL_WINDOW values
 * of perRoundBlockingCounts (the `window`). The story is CONVERGING (not stalled)
 * if EITHER:
 *   (a) the most recent round has zero blocking findings (window[last] === 0):
 *       a clean current round means blockers have been driven to zero — the
 *       healthiest state, never a stall (covers tails like [...,0] and [...,0,0]);
 *   OR
 *   (b) the window is STRICTLY DECREASING (each value strictly less than the
 *       previous): a sustained downward trend toward zero.
 * A stall is reported only when NEITHER holds — i.e. the most recent round still
 * has blockers AND the recent window is not strictly decreasing (flat / rising /
 * non-monotonic), meaning rounds keep cycling while still surfacing blockers.
 *   - [2,1,0]  -> last is 0          -> converged -> stalled=false (healthy)
 *   - [3,2,0]  -> last is 0          -> converged -> stalled=false (clean tail)
 *   - [1,0,0]  -> last is 0          -> converged -> stalled=false (already clean)
 *   - [2,1]+   -> strictly decreasing-> converging -> stalled=false
 *   - [2,2,1]  -> last 1, not strict -> no trend  -> stalled=true
 *   - [1,2,2]  -> last 2, rising     -> no trend  -> stalled=true
 *   - [3,3,3]  -> last 3, flat       -> no trend  -> stalled=true
 * We deliberately require STRICT decrease (not merely non-increasing) for (b),
 * so [2,2,1] (the 2==2 step) is a stall, while [2,1,0] is healthy.
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

  // (b) Strictly decreasing window => sustained downward trend => converging.
  // window.length === STALL_WINDOW is guaranteed by the short-window guard above;
  // kept explicit so the branch documents its full-window precondition at the
  // point of use.
  const strictlyDecreasing = window.length === STALL_WINDOW
    && window.every((value, i) => i === 0 || value < window[i - 1]);

  if (recentRoundClean || strictlyDecreasing) {
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
 * The five structured resolution actions that (once CHK-002 lands the
 * stall_resolution_set command + signed, current-round-bound record) clear the
 * stall block for EXACTLY the next ordinary review round. Named here so the
 * blocking prompt and the future CHK-002 action enum share ONE source and can
 * never drift. Order is stable for grep/test.
 */
export const STALL_RESOLUTION_ACTIONS = [
  'authorize_continuation',
  'replan',
  'escalate_root_cause',
  'resolve_findings',
  'declare_unreachable',
] as const;

export type StallResolutionAction = (typeof STALL_RESOLUTION_ACTIONS)[number];

/** Stable machine-readable tag surfaced in the guard-failure message. */
export const STALL_ADJUDICATION_CODE = 'review_convergence_stall';

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
 * of observable state only (the trend assessment + the resolution boolean).
 *
 * Decision table:
 *   - assessment.stalled === false            -> ALLOW (converging or too-few rounds)
 *   - stalled && hasCurrentRoundResolution     -> ALLOW (a current-round resolution clears exactly the next round)
 *   - stalled && !hasCurrentRoundResolution    -> BLOCK (mint refused; carry the structured prompt)
 *
 * It deliberately does NOT re-derive the stall — it consumes assessReviewConvergence's
 * verdict — so a genuinely converging story (trailing-clean last==0, or strictly
 * decreasing) is NEVER blocked, even at/beyond STALL_MIN_ROUNDS.
 */
export function evaluateStallAdjudication(inputs: StallAdjudicationInputs): StallAdjudication {
  if (!inputs.assessment.stalled) {
    return { blocked: false };
  }
  if (inputs.hasCurrentRoundResolution) {
    return { blocked: false };
  }
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
 * SEAM for CHK-002. Presence of a signed, current-round-bound structured
 * resolution record (stall-adjudication.json) for the CURRENTLY stalled round.
 *
 * Until CHK-002 lands the stall_resolution_set command + persisted+signed
 * record, no resolution can exist, so this is UNCONDITIONALLY false — the block
 * is real and unclearable-by-text today. CHK-002 replaces this body with a read
 * of the persisted record RE-VALIDATED against the current stalled round (reason
 * min length + current-round binding + signature); a stale/previous-round/empty
 * record must still return false here. This is one of the two consumption points
 * (this gate + the CHK-002 handler) that must both re-validate the record.
 */
export function hasCurrentRoundStallResolution(_store: StoryStore, _storyId: string): boolean {
  // CHK-002 seam: no persisted resolution record exists yet.
  return false;
}

/**
 * CHK-001: store-consuming mint-site gate. Reads the observable round history
 * from the store, runs the EXISTING trend detector over the COMPLETED rounds
 * visible at the mint site, and returns the pure adjudication.
 *
 * Round-count semantics at the MINT site (vs assessReviewConvergenceAtEntry):
 *   The mint gate runs while the story is still at DEV, BEFORE the new round's
 *   REVIEW/advance event is written — so every round resolveReviewRoundCount
 *   counts here is a COMPLETED round whose reviewers have run. Therefore, unlike
 *   the render-time advisory (which drops the just-entered, not-yet-reviewed
 *   current round), this gate feeds the FULL dense per-round array to
 *   assessReviewConvergence with NO trailing drop. The advisory entry point
 *   (assessReviewConvergenceAtEntry) is intentionally left untouched.
 *
 * Pure-ish: only reads via the store, no writes, no transition side effects;
 * evaluateStallAdjudication stays PURE.
 */
export function evaluateReviewMintStallAdjudication(
  store: StoryStore,
  storyId: string,
): StallAdjudication {
  const { roundCount, perRoundBlockingCounts } = collectReviewConvergenceInputs(store, storyId);
  const assessment = assessReviewConvergence(roundCount, perRoundBlockingCounts);
  return evaluateStallAdjudication({
    assessment,
    hasCurrentRoundResolution: hasCurrentRoundStallResolution(store, storyId),
  });
}
