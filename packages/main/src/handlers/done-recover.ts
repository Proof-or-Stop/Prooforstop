import { execFileSync } from 'child_process';
import type { HandlerContext } from './context.js';
import { StoryStore } from '../core/store.js';
import {
  assertMainWorktreeClean,
  assertStoryWorktreeClean,
  detectPartialDoneStories,
  removeStoryWorktree,
  resolveMainBranchWorktree,
  resolveMainRepoRoot,
} from '../core/partial-done-recovery.js';
import {
  acquireDoneMainMergeLock,
  listChangedPathsBetweenMainShas,
  runArtifactReleaseLedgerAfterDoneMerge,
  runDoneMainPackageBuildAfterMerge,
  shouldBuildDoneMainPackageForChangedPaths,
} from './done-effects.js';

function git(gitCwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: gitCwd,
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
      const mainMergeRoot = resolveMainBranchWorktree(mainRepoRoot);
      const store = mainMergeRoot === root ? ctx.store : new StoryStore(mainMergeRoot);
      const lock = acquireDoneMainMergeLock(storyId, mainRepoRoot, mainMergeRoot);
      try {

      const currentBranch = git(mainMergeRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (currentBranch !== 'main') {
        throw new Error(
          `done_recover refused: resolved main merge worktree at "${mainMergeRoot}" is on branch "${currentBranch}", not "main".\n` +
          `Repository root: "${mainRepoRoot}".\n` +
          `→ cd "${mainMergeRoot}" && git checkout main`,
        );
      }
      assertMainWorktreeClean(mainMergeRoot);

      const partial = detectPartialDoneStories(mainMergeRoot, store).find(entry => entry.storyId === storyId);
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
      assertStoryWorktreeClean(partial.worktreePath);

      const lines: string[] = [];
      git(mainMergeRoot, ['merge-tree', '--write-tree', 'main', partial.branch]);
      const mainShaBeforeRecoveryMerge = git(mainMergeRoot, ['rev-parse', 'HEAD']);
      let mainShaAfterRecoveryMerge = mainShaBeforeRecoveryMerge;
      git(
        mainMergeRoot,
        ['-c', 'commit.gpgsign=false', 'merge', partial.branch, '--no-ff', '-m', `merge: ${storyId} ${partial.title}`],
      );
      mainShaAfterRecoveryMerge = git(mainMergeRoot, ['rev-parse', 'HEAD']);
      lines.push(`✓ ${partial.branch} merged into main`);
      for (const line of removeStoryWorktree(mainRepoRoot, storyId, partial.worktreePath)) {
        lines.push(line);
      }

      if (gitSucceeds(mainMergeRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${partial.branch}`])) {
        git(mainMergeRoot, ['branch', '-d', partial.branch]);
        lines.push(`✓ ${partial.branch} deleted`);
      }

      const recoveryMergeChangedPaths = listChangedPathsBetweenMainShas(
        mainMergeRoot,
        mainShaBeforeRecoveryMerge,
        mainShaAfterRecoveryMerge,
      );
      const runtimeSemverChanged = shouldBuildDoneMainPackageForChangedPaths(recoveryMergeChangedPaths);

      lines.push(runDoneMainPackageBuildAfterMerge(
        mainMergeRoot,
        mainShaBeforeRecoveryMerge,
        mainShaAfterRecoveryMerge,
        {
          changedPaths: recoveryMergeChangedPaths,
          buildRunner: ctx.doneMainBuildRunner,
        },
      ));

      const artifactReleaseLine = runArtifactReleaseLedgerAfterDoneMerge(
        mainMergeRoot,
        storyId,
        mainShaBeforeRecoveryMerge,
        mainShaAfterRecoveryMerge,
        {
          changedPaths: recoveryMergeChangedPaths,
          runtimeSemverChanged,
          runGit: (gitArgs, cwd) => git(cwd, gitArgs),
        },
      );
      if (artifactReleaseLine) lines.push(artifactReleaseLine);

      const remaining = detectPartialDoneStories(mainMergeRoot, store).find(entry => entry.storyId === storyId);
      if (remaining) {
        throw new Error(`done_recover incomplete: ${storyId} still appears partial-DONE`);
      }

      return [`✓ partial-DONE recovered: ${storyId}`, ...lines].join('\n');
      } finally {
        lock.release();
      }
    },
  };
}
