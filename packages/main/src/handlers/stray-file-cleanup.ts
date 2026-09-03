/**
 * B-9d95 CHK-003: Clean up stray untracked files in the main repo under the story directory.
 *
 * Background: Some proof-or-stop handlers (process_event_append / process_metrics_update
 * / review_add / cluster, etc.) write runtime files directly under
 * `docs/story/actives/<storyId>/`. If proof-or-stop is invoked in the **main repo cwd**
 * (rather than the worktree cwd) (e.g. a slip / early script misuse), these files
 * land on the copy where the main repo's index.json lives,
 * but are not tracked in the worktree branch's git — later when story_advance DONE tries to
 *   `untracked working tree files would be overwritten by merge`
 * merge the worktree branch back to main, git will report
 * and abort. The real failure during B-ed3e DONE was process-events.jsonl /
 *
 * process-metrics.json / review.json hitting this path.
 * Strategy: Before merging, scan untracked files in the main repo's `docs/story/actives/<storyId>/`:
 *   - Whitelisted (runtime auto-generated, worktree's tracked version is authoritative) → rm directly and report
 *   - Non-whitelisted (possibly user drafts / untracked manual changes) → throw, attach stash guidance,
 *
 *     preserve files for human decision
 * Placed in a separate file (not inside story-advance.ts) so that logicTest can directly
 */

import { execFileSync } from 'child_process';
import { basename, join } from 'path';
import { existsSync, unlinkSync } from 'fs';
import { loadConfig } from '../core/config.js';

export const STRAY_FILE_WHITELIST: ReadonlyArray<string> = [
  'background.md',
  'bug.json',
  'checklist.json',
  'decision.json',
  'delivery-check.json',
  'eval-evidence.json',
  'findings.json',
  'implementation-review.json',
  'index.json',
  'init-check.json',
  'init-self-check.json',
  'plan.md',
  'process-events.jsonl',
  'process-metrics.json',
  'review.json',
  'review-passes.json',
  'scope-check.json',
  'story-test-runs.json',
  'summary.json',
  'test-evidence.json',
  'understanding.json',
  'clusters.json',
];

/**
 * import without dragging heavy dependencies like xstate / machine into the test process.
 * F-014 / F-020 (B-9d95 Round 1 review): Optional worktreePath so the thrown message includes
 * worktree / branch cleanup guidance. Provides a fallback placeholder when caller doesn't supply path.
 */
export function cleanStrayWorktreeFiles(
  mainRepoRoot: string,
  storyId: string,
  worktreePath?: string,
): string[] {
  const report: string[] = [];
  const config = loadConfig(mainRepoRoot);
  const storyDir = `${config.storyDir.replace(/\\/g, '/')}/${storyId}/`;

  // Backward compatible: original 2-arg calls keep behavior unchanged (just a missing worktree cleanup hint in the error message).
  if (!existsSync(join(mainRepoRoot, storyDir))) {
    return report;
  }

  // If the main repo has no storyDir (extremely rare: deleted during INIT phase before creating worktree), skip.
  // shell metacharacters (backticks / $() / ;) in a malicious storyId could trigger injection when `git ls-files -- ${storyDir}` is concatenated into a shell string. execFileSync defaults to shell=false
  // shell metacharacters (backticks / $() / ;) trigger injection. execFileSync defaults to shell=false
  // exec the git binary directly, passing storyDir as a standalone argv item.
  let raw = '';
  try {
    raw = execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '--', storyDir],
      { cwd: mainRepoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString();
  } catch {
    // not a git repo / command failed → let it pass (the merge step will report its own error)
    return report;
  }

  const relPaths = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (relPaths.length === 0) return report;

  const whitelist: string[] = [];
  const offenders: string[] = [];
  for (const rel of relPaths) {
    const base = basename(rel);
    if (STRAY_FILE_WHITELIST.includes(base)) {
      whitelist.push(rel);
    } else {
      offenders.push(rel);
    }
  }

  // non-whitelisted: keep the files + throw with stash guidance (including whitelisted ones — atomicity: if any non-whitelisted file exists, touch nothing)
  if (offenders.length > 0) {
    const stashLines = offenders
      .map(rel => `  git stash push -- "${rel}"`)
      .join('\n');
    // F-014 / F-020: cleanStrayWorktreeFiles is invoked before merge. If we throw here,
    // the caller must ensure story.phase has not yet been persisted as DONE (see done-effects.ts),
    // so the next `story_advance --phase=DONE` can still rerun the full flow. But if the caller
    // already persisted phase=DONE (historical bug), the user must manually clean up the worktree + branch,
    // and this hint is always shown as a fallback.
    const wtDisplay = worktreePath ?? '<absolute worktree path, see .worktrees/<storyId>>';
    throw new Error(
      `Before the DONE merge for story ${storyId}, found ${offenders.length} non-whitelisted untracked files in the main repo, ` +
      `possibly manual drafts; not deleting automatically to prevent data loss:\n` +
      offenders.map(rel => `  - ${rel}`).join('\n') +
      `\n\nPlease handle these untracked files in the main repo by picking one option:\n` +
      `  Option A (archive, recommended):\n${stashLines}\n` +
      `  Option B (confirm safe to delete):\n` +
      offenders.map(rel => `  rm "${rel}"`).join('\n') +
      `\n\nThen rerun proof-or-stop story_advance --phase=DONE.\n` +
      `\nIf story.phase has been unexpectedly persisted as DONE and needs manual unsticking, run in the main repo cwd:\n` +
      `  git worktree remove --force "${wtDisplay}"\n` +
      `  git branch -d story/${storyId}\n` +
      `  # then manually merge: git merge story/${storyId} (if the branch is not yet deleted) or restore from backup`,
    );
  }

  // whitelist: rm + report
  for (const rel of whitelist) {
    const abs = join(mainRepoRoot, rel);
    try {
      unlinkSync(abs);
      report.push(`⚠ Cleaned untracked copy in main repo: ${rel} (reason: worktree tracked version is authoritative)`);
    } catch (e: any) {
      report.push(`⚠ Failed to clean untracked copy in main repo: ${rel}: ${e?.message || e}`);
    }
  }

  return report;
}
