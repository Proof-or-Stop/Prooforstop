import { agentRoleIdsEqual, canonicalAgentRoleId } from './agent-role-identity.js';
import type { ReviewRun } from './types.js';

/** Review rounds are ISO timestamps minted on REVIEW entry; order them by time, then text. */
export function isEarlierReviewRound(candidate: string, current: string): boolean {
  if (!candidate || !current || candidate === current) return false;
  const a = Date.parse(candidate);
  const b = Date.parse(current);
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a < b;
  return candidate.localeCompare(current) < 0;
}

/**
 * A code-review lane run: not the topology or inventory-completeness critic,
 * whose duty is a whole-Story audit rather than a review of the changed code.
 */
export function isCodeReviewLaneRun(run: Pick<ReviewRun, 'lane' | 'reviewPurpose'>): boolean {
  return run.reviewPurpose === undefined && canonicalAgentRoleId(run.lane) !== 'proof-or-stop-review-topology-critic';
}

/** Same-Story, same-lane code-review runs from rounds before `run`'s round. */
export function earlierRoundLaneRuns(runs: readonly ReviewRun[], run: Pick<ReviewRun, 'storyId' | 'lane' | 'reviewRound' | 'reviewPurpose'>): ReviewRun[] {
  if (!isCodeReviewLaneRun(run)) return [];
  return runs.filter(row => row.storyId === run.storyId && agentRoleIdsEqual(row.lane, run.lane)
    && isCodeReviewLaneRun(row) && isEarlierReviewRound(row.reviewRound, run.reviewRound));
}

/** The lane's newest run in the latest round before `run`'s round, if any. */
export function previousRoundLaneRun(runs: readonly ReviewRun[], run: Pick<ReviewRun, 'storyId' | 'lane' | 'reviewRound' | 'reviewPurpose'>): ReviewRun | null {
  const earlier = earlierRoundLaneRuns(runs, run);
  let best: ReviewRun | null = null;
  for (const row of earlier) {
    if (!best || isEarlierReviewRound(best.reviewRound, row.reviewRound)
      || (best.reviewRound === row.reviewRound && laterStart(row, best))) best = row;
  }
  return best;
}

function laterStart(a: ReviewRun, b: ReviewRun): boolean {
  const at = Date.parse(a.startedAt);
  const bt = Date.parse(b.startedAt);
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at > bt;
  return a.reviewRunId.localeCompare(b.reviewRunId) > 0;
}
