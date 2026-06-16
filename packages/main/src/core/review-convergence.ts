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
import { resolveEffectiveBlockingSeverities } from './guard-utils.js';
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
   * Per-round blocking-finding counts, ordered chronologically by round
   * (ascending). Index 0 = earliest round with findings, last = most recent.
   * A story with no findings yields an empty array. Note: only rounds that have
   * at least one finding appear here; rounds with zero recorded findings do not
   * produce an entry (the pure fn below tolerates this by reading the trailing
   * window, which is what matters for a stall signal).
   */
  perRoundBlockingCounts: number[];
}

/**
 * CHK-001: read-only accessor. Derives the REVIEW round count + per-round
 * blocking-finding counts from the store. Pure-ish: only reads via the store,
 * no writes, no transition side effects.
 *
 * Per-round blocking determination:
 *   - Group the story's findings by their `reviewRound` (ISO timestamp), mirror
 *     the chronological grouping used by core/review-escalation.ts.
 *   - Map each unique round timestamp to a 1-based round index (chronological).
 *   - For each round, compute that round's effective blocking severities using
 *     the SAME decay rule as resolveEffectiveBlockingSeverities (Round 1 =
 *     policy.review.blockingSeverities; Round 2 = critical+high; Round 3+ =
 *     critical), and count findings that are blocking via isFindingBlocking for
 *     that round index.
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
  try {
    const story = store.readStory(storyId);
    const config = loadConfig();
    const policy = resolveWorkflowPolicy(config, story);
    round1BlockingSeverities = policy.review.blockingSeverities;
  } catch {
    // Conservative fallback matching the strictest Round-1 set; this only
    // affects the count when policy is unreadable (never blocks anything).
    round1BlockingSeverities = ['critical', 'high', 'medium'];
  }

  // Group findings by reviewRound, chronologically (mirror review-escalation.ts
  // uniqueReviewRounds ordering: parse-as-date ascending, ties by localeCompare).
  const roundsWithFindings = [...new Set(
    findings.map(f => f.reviewRound).filter((r): r is string => Boolean(r)),
  )].sort((a, b) => {
    const at = Date.parse(a);
    const bt = Date.parse(b);
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
    return a.localeCompare(b);
  });

  const perRoundBlockingCounts = roundsWithFindings.map((roundTs, idx) => {
    // 1-based round index for the decay rule (mirrors resolveEffectiveBlockingSeverities).
    const roundIndex = idx + 1;
    const effectiveBlockingSeverities = effectiveBlockingForRound(roundIndex, round1BlockingSeverities);
    return findings
      .filter(f => f.reviewRound === roundTs)
      .filter(f => isFindingBlocking(f, effectiveBlockingSeverities, roundIndex))
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
 * "No downward trend" rule (precise & deterministic):
 *   Take the last STALL_WINDOW values of perRoundBlockingCounts (the `window`).
 *   The series is converging ONLY IF it is STRICTLY DECREASING across the
 *   window (each value strictly less than the previous one). Anything else —
 *   flat, rising, or non-monotonic — is "no downward trend".
 *   Formally: noDownwardTrend = NOT (window[i] < window[i-1] for all i).
 *   We deliberately require STRICT decrease, not merely "non-increasing":
 *     - [2,1,0] is strictly decreasing  -> downward trend  -> stalled=false (healthy)
 *     - [2,2,1] is NOT strictly decreasing (2==2) -> no downward trend -> stalled=true
 *     - [1,2,2] rises -> no downward trend -> stalled=true
 *     - [3,3,3] flat -> no downward trend -> stalled=true
 *   A window shorter than STALL_WINDOW (fewer recorded rounds than the window)
 *   cannot demonstrate a sustained downward trend, so it is treated as "no
 *   downward trend" once roundCount has reached STALL_MIN_ROUNDS.
 */
export function assessReviewConvergence(
  roundCount: number,
  perRoundBlockingCounts: number[],
): ReviewConvergenceAssessment {
  if (roundCount < STALL_MIN_ROUNDS) {
    return { stalled: false };
  }

  const window = perRoundBlockingCounts.slice(-STALL_WINDOW);

  // A full strictly-decreasing window of size STALL_WINDOW is the only
  // "converging" shape. Anything else (incl. a too-short window) is no trend.
  const strictlyDecreasing = window.length === STALL_WINDOW
    && window.every((value, i) => i === 0 || value < window[i - 1]);
  const noDownwardTrend = !strictlyDecreasing;

  if (!noDownwardTrend) {
    return { stalled: false };
  }

  return {
    stalled: true,
    message: buildStallMessage(roundCount, window),
  };
}

/**
 * Builds the English-only advisory message. Starts with a stable marker so the
 * line is easy to grep/test, and includes BOTH escalation hints.
 */
function buildStallMessage(roundCount: number, recentCounts: number[]): string {
  const counts = recentCounts.length > 0 ? recentCounts.join(', ') : 'none';
  return [
    `WARN review convergence stall: REVIEW has cycled ${roundCount} rounds with no downward trend in blocking findings (recent rounds: [${counts}]).`,
    '  - Debugging Contract escalation: 3+ fix attempts that keep surfacing new problems usually point to an architecture/design issue. Consider escalating the design instead of patching another round.',
    '  - Prefer dismissing advisory-level findings (finding_dismiss + reason) over re-rounding: every source-changing fix-commit stales the round and forces a fresh REVIEW round.',
  ].join('\n');
}
