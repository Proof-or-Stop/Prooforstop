import { execFileSync } from 'child_process';
import type { HandlerContext } from './context.js';
import { StoryStore } from '../core/store.js';
import {
  assertMainWorktreeClean,
  detectPartialDoneStories,
  removeStoryWorktree,
  resolveMainRepoRoot,
} from '../core/partial-done-recovery.js';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function gitSucceeds(root: string, args: string[]): boolean {
  try {
    git(root, args);
    return true;
  } catch {
    return false;
  }
}

export function createDoneRecoverHandlers(ctx: HandlerContext) {
  const { root } = ctx;

  return {
    done_recover(args: { storyId: string }): string {
      const storyId = String(args?.storyId ?? '').trim();
      if (!storyId) throw new Error('done_recover: storyId is required');

      const mainRepoRoot = resolveMainRepoRoot(root);
      const store = mainRepoRoot === root ? ctx.store : new StoryStore(mainRepoRoot);

      const currentBranch = git(mainRepoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (currentBranch !== 'main') {
        throw new Error(`done_recover refused: run from main repo on branch main (current: ${currentBranch})`);
      }
      assertMainWorktreeClean(mainRepoRoot);

      const partial = detectPartialDoneStories(mainRepoRoot, store).find(entry => entry.storyId === storyId);
      if (!partial) {
        const story = store.readStory(storyId);
        if (story.phase !== 'DONE') {
          throw new Error(`done_recover refused: ${storyId} is ${story.phase}, not DONE`);
        }
        throw new Error(`done_recover refused: ${storyId} is not a recoverable partial-DONE story`);
      }
      if (!partial.branchExists) {
        throw new Error(`done_recover refused: ${partial.branch} does not exist`);
      }
      if (!partial.mergeTreeClean) {
        throw new Error(
          `done_recover refused: ${partial.branch} cannot merge cleanly into main.\n` +
          `→ Resolve conflicts manually, then rerun done_recover.`,
        );
      }

      const lines: string[] = [];
      git(mainRepoRoot, ['merge-tree', '--write-tree', 'main', partial.branch]);
      git(
        mainRepoRoot,
        ['-c', 'commit.gpgsign=false', 'merge', partial.branch, '--no-ff', '-m', `merge: ${storyId} ${partial.title}`],
      );
      lines.push(`✓ ${partial.branch} merged into main`);

      for (const line of removeStoryWorktree(mainRepoRoot, storyId, partial.worktreePath)) {
        lines.push(line);
      }

      if (gitSucceeds(mainRepoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${partial.branch}`])) {
        git(mainRepoRoot, ['branch', '-d', partial.branch]);
        lines.push(`✓ ${partial.branch} deleted`);
      }

      const remaining = detectPartialDoneStories(mainRepoRoot, store).find(entry => entry.storyId === storyId);
      if (remaining) {
        throw new Error(`done_recover incomplete: ${storyId} still appears partial-DONE`);
      }

      return [`✓ partial-DONE recovered: ${storyId}`, ...lines].join('\n');
    },
  };
}
