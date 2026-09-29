import { agentRoleIdsEqual, canonicalAgentRoleId } from './agent-role-identity.js';
import type { ReviewRun } from './types.js';

/**
 * A code-review lane run: not the topology or inventory-completeness critic,
 * whose duty is a whole-Story audit rather than a review of the changed code.
 */
export function isCodeReviewLaneRun(run: Pick<ReviewRun, 'lane' | 'reviewPurpose'>): boolean {
  return run.reviewPurpose === undefined && canonicalAgentRoleId(run.lane) !== 'proof-or-stop-review-topology-critic';
}

/** Review rounds are ISO timestamps minted on REVIEW entry; order them by time, then text. */
export function isEarlierReviewRound(candidate: string, current: string): boolean {
  if (!candidate || !current || candidate === current) return false;
  const a = Date.parse(candidate);
  const b = Date.parse(current);
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a < b;
  return candidate.localeCompare(current) < 0;
}

/** Start order of ReviewRuns: startedAt, tie-broken by reviewRunId. */
export function startedBefore(a: Pick<ReviewRun, 'startedAt' | 'reviewRunId'>, b: Pick<ReviewRun, 'startedAt' | 'reviewRunId'>): boolean {
  const at = Date.parse(a.startedAt);
  const bt = Date.parse(b.startedAt);
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at < bt;
  return a.reviewRunId.localeCompare(b.reviewRunId, 'en', { numeric: true }) < 0;
}

/**
 * Same-Story runs that started before `run` on an earlier candidate: their
 * headHash differs from `run`'s. A remediation inside REVIEW moves HEAD without
 * minting a new reviewRound, so candidates, not rounds, delimit a re-review;
 * a later round is also a later candidate. Runs on `run`'s own HEAD (a relaunch
 * in the same wave) are excluded, which also keeps anything they write out of
 * a digest computed during the current candidate's review.
 */
export function earlierCandidateRuns(runs: readonly ReviewRun[], run: Pick<ReviewRun, 'storyId' | 'reviewRunId' | 'startedAt' | 'headHash'>): ReviewRun[] {
  return runs.filter(row => row.storyId === run.storyId && row.reviewRunId !== run.reviewRunId
    && row.headHash !== run.headHash && startedBefore(row, run));
}

/** The lane's earlier-candidate code-review runs, oldest first. Empty for the critic. */
export function earlierCandidateLaneRuns(
  runs: readonly ReviewRun[],
  run: Pick<ReviewRun, 'storyId' | 'reviewRunId' | 'startedAt' | 'headHash' | 'lane' | 'reviewPurpose'>,
): ReviewRun[] {
  if (!isCodeReviewLaneRun(run)) return [];
  return earlierCandidateRuns(runs, run)
    .filter(row => agentRoleIdsEqual(row.lane, run.lane) && isCodeReviewLaneRun(row))
    .sort((a, b) => (startedBefore(a, b) ? -1 : startedBefore(b, a) ? 1 : 0));
}

/** The lane's previous review: its newest earlier-candidate run, if any. */
export function previousCandidateLaneRun(
  runs: readonly ReviewRun[],
  run: Pick<ReviewRun, 'storyId' | 'reviewRunId' | 'startedAt' | 'headHash' | 'lane' | 'reviewPurpose'>,
): ReviewRun | null {
  return earlierCandidateLaneRuns(runs, run).at(-1) ?? null;
}
