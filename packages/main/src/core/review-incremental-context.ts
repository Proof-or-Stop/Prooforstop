/**
 * B-f675 CHK-001: read-only incremental review context.
 *
 * Gives a reviewer role its most recent prior verdict (review-pass or finding)
 * for the current story, the headHash that verdict was bound to, and the set of
 * MATERIAL files that changed since that headHash. When the reviewer has never
 * passed on this story it reports isFirstPass=true and the full main...HEAD
 * material diff.
 *
 * HARD INVARIANT (this story): this module is STRICTLY READ-ONLY. It only reads
 * via the StoryStore and git; it performs no writes and has no gate/store side
 * effects. It does NOT touch canPassReviewGuard, review-run bindings,
 * materialHash, or staleness logic — it only surfaces information so an operator
 * can decide whether to re-run a reviewer. The framework still skips nobody.
 *
 * Diff source: changedFilesBetweenRenameAware (`git diff --name-status -M`) so a
 * file rename since the reviewer's last pass still surfaces as a changed path
 * (rather than being hidden by a name-only collapse). Results are filtered to
 * material files via isMaterialExcludedPath so story-metadata-only churn does
 * not falsely flag scopeChanged.
 */

import type { StoryStore } from './store.js';
import type { Finding, ReviewPass, ReviewRun } from './types.js';
import { findingAgentMatchesReviewer } from './reviewer-opt-in.js';
import {
  changedFilesBetweenRenameAware,
  isMaterialExcludedPath,
} from './evidence-freshness.js';

export interface ReviewIncrementalContext {
  role: string;
  isFirstPass: boolean;
  priorHeadHash: string | null;
  priorVerdict: string | null;
  scopeChanged: boolean;
  changedFiles: string[];
}

interface PriorVerdict {
  /** Short human summary, e.g. "PASS (RP-001)" or "finding F-002: high". */
  summary: string;
  /** Bound headHash resolved from the verdict's reviewRunId, else null. */
  headHash: string | null;
  /** Timestamp used to pick the most recent verdict (ms since epoch, NaN-safe). */
  sortKey: number;
}

function verdictTime(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Resolve the headHash a reviewRunId was bound to, scanning verified-or-not runs. */
function headHashForRun(runs: ReviewRun[], reviewRunId: string | undefined): string | null {
  if (!reviewRunId) return null;
  const run = runs.find((candidate) => candidate.reviewRunId === reviewRunId);
  return run?.headHash || null;
}

function passVerdict(pass: ReviewPass, runs: ReviewRun[]): PriorVerdict {
  return {
    summary: `PASS (${pass.id})`,
    headHash: headHashForRun(runs, pass.reviewRunId),
    sortKey: verdictTime(pass.createdAt),
  };
}

function findingVerdict(finding: Finding, runs: ReviewRun[]): PriorVerdict {
  return {
    summary: `finding ${finding.id}: ${finding.severity}`,
    headHash: headHashForRun(runs, finding.reviewRunId),
    sortKey: verdictTime(finding.createdAt),
  };
}

/**
 * Pick the most recent prior verdict for `role` across passes + findings.
 * Returns null when the reviewer has no prior verdict on this story.
 */
function mostRecentPriorVerdict(
  role: string,
  findings: Finding[],
  passes: ReviewPass[],
  runs: ReviewRun[],
): PriorVerdict | null {
  const candidates: PriorVerdict[] = [];
  for (const pass of passes) {
    if (findingAgentMatchesReviewer(pass.agent, role)) candidates.push(passVerdict(pass, runs));
  }
  for (const finding of findings) {
    if (findingAgentMatchesReviewer(finding.agent, role)) candidates.push(findingVerdict(finding, runs));
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.sortKey - b.sortKey);
  return candidates[candidates.length - 1];
}

function materialOnly(files: string[], projectRoot: string): string[] {
  return files.filter((file) => !isMaterialExcludedPath(file, projectRoot));
}

/**
 * Read-only incremental review context for a reviewer `role` on `storyId`.
 *
 * - A prior pass/finding with a bound, resolvable headHash → diff that headHash
 *   against HEAD (rename-aware, material-filtered); scopeChanged = changed > 0;
 *   isFirstPass = false.
 * - No prior verdict (or prior verdict has no resolvable bound headHash) →
 *   isFirstPass = true, priorHeadHash = null, scopeChanged = true, and
 *   changedFiles = the full main...HEAD material diff.
 */
export function reviewIncrementalContext(
  store: StoryStore,
  projectRoot: string,
  storyId: string,
  role: string,
): ReviewIncrementalContext {
  const findings = store.readFindings(storyId).findings || [];
  const passes = store.readReviewPasses(storyId).passes || [];
  const runs = store.readReviewRuns(storyId).runs || [];

  const prior = mostRecentPriorVerdict(role, findings, passes, runs);

  // First-timer (or a prior verdict whose bound headHash cannot be resolved):
  // fall back to the full story diff against main. We treat a missing bound
  // headHash as a first pass so we never compute an incremental diff from an
  // unknown base — the conservative direction is "show everything".
  if (!prior || !prior.headHash) {
    const fullDiff = materialOnly(changedFilesBetweenRenameAware(projectRoot, 'main', 'HEAD'), projectRoot);
    return {
      role,
      isFirstPass: true,
      priorHeadHash: null,
      priorVerdict: prior ? prior.summary : null,
      scopeChanged: true,
      changedFiles: fullDiff,
    };
  }

  const changedFiles = materialOnly(
    changedFilesBetweenRenameAware(projectRoot, prior.headHash, 'HEAD'),
    projectRoot,
  );
  return {
    role,
    isFirstPass: false,
    priorHeadHash: prior.headHash,
    priorVerdict: prior.summary,
    scopeChanged: changedFiles.length > 0,
    changedFiles,
  };
}
