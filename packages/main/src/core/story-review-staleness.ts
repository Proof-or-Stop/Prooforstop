/**
 * Old-PoS run 34 (F7): the DEV-entry guard read the latest story_review round
 * (its blocker count) after the owner had already fixed what that round
 * reported (a pin-audit correction and a new scope-plan verdict), printed
 * "Cannot enter DEV:" with an empty first line and sent the owner to run
 * story_review, a deterministic record of the PLAN checks. When the latest
 * round is older than the Story inputs it judged, rerunning it is mechanical:
 * `next` runs it as a framework step (the same checks, recorded the same way);
 * a current round with blockers stays the owner's to fix.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The Story files story_review judges; a change to any of them after a round makes that round stale. */
export const STORY_REVIEW_INPUT_FILES = ['checklist.json', 'plan.md', 'scope-check.json', 'decision.json', 'background.md', 'request.md', 'scope-boundary.json', 'execution-boundary.json'] as const;

/**
 * Slack between a round and a later input write: story_review's own writes in
 * the same call never make its round stale (no rerun loop).
 */
const STALE_SLACK_MS = 2_000;

/** True when there is no round, or a judged input changed after the round's timestamp. */
export function storyReviewRoundStale(storyDir: string, lastRoundTimestamp: string | null | undefined): boolean {
  const round = Date.parse(lastRoundTimestamp ?? '');
  if (!Number.isFinite(round)) return true;
  for (const name of STORY_REVIEW_INPUT_FILES) {
    const path = join(storyDir, name);
    if (!existsSync(path)) continue;
    try { if (statSync(path).mtimeMs > round + STALE_SLACK_MS) return true; } catch { /* unreadable: not newer */ }
  }
  return false;
}
