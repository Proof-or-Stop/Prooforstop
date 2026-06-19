import { execFileSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
import { loadConfig } from '../core/config.js';
import { withReentrantMainWriteLock } from '../core/main-write-lock.js';
import { StoryStore } from '../core/store.js';
import { resolveStorySignedWorkspace } from '../core/story-signed-workspace-resolution.js';

function gitCli(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e: any) {
    const details = String(e?.stderr || e?.stdout || e?.message || e).trim();
    throw new Error(`git ${args.join(' ')} failed${details ? `: ${details}` : ''}`);
  }
}

function isPathUnderAny(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function stageBoundedMetadataPath(root: string, relPath: string): void {
  if (existsSync(join(root, relPath))) {
    gitCli(root, ['add', '-A', '--', relPath]);
    return;
  }

  const deleted = gitCli(root, ['ls-files', '--deleted', '--', relPath])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (deleted.length > 0) {
    gitCli(root, ['add', '-A', '--', ...deleted]);
  }
}

/**
 * B-4e06 CHK-003: resolve the git "main checkout" root for INIT_CHECK metadata
 * reconciliation. With a configured gitRoot (wrapper-root project), the main
 * checkout IS the resolved git root, not the metadata wrapper. Reuses the shared
 * signed-workspace resolver — no second resolver. Falls back to the metadata
 * root for plain repos (byte-for-byte unchanged).
 */
export function resolveInitCheckGitMainRoot(root: string, store: StoryStore, storyId: string): string {
  const configuredGitRoot = loadConfig(root).gitRoot?.trim();
  if (!configuredGitRoot) return root;
  const resolution = resolveStorySignedWorkspace({ store, storyId, metadataRoot: root });
  if (resolution.resolved && resolution.repoRoot) return resolution.repoRoot;
  throw new Error(
    `INIT_CHECK metadata reconcile: configured gitRoot is unusable (${resolution.unresolvedReason || 'unresolved'}).`,
  );
}

export function commitInitCheckMetadataAndMergeMain(root: string, store: StoryStore, storyId: string): string {
  const gitMainRoot = resolveInitCheckGitMainRoot(root, store, storyId);
  const currentBranch = gitCli(gitMainRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (currentBranch.startsWith('story/')) {
    // INIT_CHECK is the standard worktree-creation entry and must run from the
    // main checkout. If we are already on a story branch, dev_start would not
    // have created a main-side mirror to reconcile — leave it untouched.
    return '';
  }

  // storyRel must be relative to the git main root so `git add` works whether or
  // not the metadata root is the git root. Canonicalize both sides (realpath) so
  // a /var → /private/var symlink does not corrupt the relative path. When
  // gitMainRoot === root this equals the legacy bounded storyDirRel/storyId path.
  const storyAbs = join(root, store.storyDirRel(), storyId);
  const canonicalStoryAbs = existsSync(storyAbs) ? realpathSync(storyAbs) : storyAbs;
  const canonicalGitMainRoot = existsSync(gitMainRoot) ? realpathSync(gitMainRoot) : gitMainRoot;
  const storyRelRaw = relative(canonicalGitMainRoot, canonicalStoryAbs).replace(/\\/g, '/');
  if (!storyRelRaw || isAbsolute(storyRelRaw) || storyRelRaw.split('/').includes('..')) {
    throw new Error(
      `INIT_CHECK metadata reconcile: story metadata path ${storyAbs} is not inside the git root ${gitMainRoot}; ` +
      `configure storyDir so story metadata lives inside the gitRoot.`,
    );
  }
  const storyRel = storyRelRaw;
  stageBoundedMetadataPath(gitMainRoot, storyRel);
  const staged = gitCli(gitMainRoot, ['diff', '--cached', '--name-only']);
  const stagedPaths = staged.split('\n').map((line) => line.trim()).filter(Boolean);
  if (stagedPaths.length === 0) {
    // Story metadata already committed (retry / already-tracked) — nothing to
    // reconcile, the DONE merge will not collide.
    return '';
  }
  const outOfBounds = stagedPaths.filter((path) => !isPathUnderAny(path, [storyRel]));
  if (outOfBounds.length > 0) {
    throw new Error(
      `INIT_CHECK metadata commit refused out-of-bounds staged paths:\n${outOfBounds.join('\n')}`,
    );
  }

  const commitMessage = `lattice: INIT_CHECK metadata ${storyId}`;
  const story = store.readStory(storyId);
  const worktreePath = story.worktree?.path;
  const storyBranch = story.worktree?.branch || `story/${storyId}`;
  if (!worktreePath) {
    throw new Error(`INIT_CHECK story ${storyId} has no recorded worktree path after dev_start`);
  }
  const worktreeAbs = isAbsolute(worktreePath) ? worktreePath : join(gitMainRoot, worktreePath);

  // B-7365: serialize the commit-on-main + merge-into-story-worktree critical
  // section under the unified main write lock. A concurrent session committing
  // to main between our commit and our merge is exactly what produces a
  // divergent `index.json` and the merge conflict this function must survive;
  // holding the lock across BOTH steps closes that race. Reentrant variant:
  // INIT_CHECK can run inside an already-locked context (the lock is released
  // in the helper's finally even when the critical section throws).
  return withReentrantMainWriteLock(gitMainRoot, () => {
    gitCli(gitMainRoot, [
      '-c', 'commit.gpgsign=false',
      'commit',
      '-m', commitMessage,
    ]);
    const mainHead = gitCli(gitMainRoot, ['rev-parse', '--short', 'HEAD']);
    const boundedStatus = gitCli(gitMainRoot, ['status', '--porcelain', '--', storyRel]);
    if (boundedStatus) {
      throw new Error(
        `INIT_CHECK metadata committed, but bounded story path is still dirty (${storyRel}):\n${boundedStatus}`,
      );
    }

    mergeBaseBranchIntoStoryWorktreeResolvingMetadata({
      worktreeAbs,
      baseBranch: currentBranch,
      storyRel,
    });
    gitCli(worktreeAbs, ['merge-base', '--is-ancestor', currentBranch, storyBranch]);

    return [
      `✓ INIT_CHECK metadata committed on ${currentBranch}: ${mainHead} (${commitMessage})`,
      `✓ ${currentBranch} merged into ${storyBranch}`,
    ].join('\n');
  }, { label: 'INIT_CHECK reconcile' });
}

/**
 * B-7365: merge `baseBranch` (main) into the story worktree's branch, resolving
 * any conflict on the machine-generated story metadata deterministically to the
 * post-advance (base/main-committed) version — NEVER leaving or committing
 * `<<<<<<< / ======= / >>>>>>>` conflict markers in `index.json` (or any other
 * file under `storyRel`).
 *
 * Rationale: the story metadata under `storyRel` is machine-owned and
 * authoritative on the base branch right after INIT_CHECK advanced it; the
 * story branch's copy is the pre-advance bootstrap snapshot. So on a conflict
 * the correct, deterministic resolution is "take base/main's version" for every
 * conflicted path under `storyRel`. Anything conflicting OUTSIDE `storyRel` is
 * not machine-owned and cannot be silently auto-resolved — we abort the merge
 * and throw a clear recovery error rather than guess.
 *
 * The clean (no-conflict) path is byte-identical to the legacy bare
 * `git merge <base> --no-edit`: `git merge` returns 0, we return immediately.
 */
export function mergeBaseBranchIntoStoryWorktreeResolvingMetadata(args: {
  worktreeAbs: string;
  baseBranch: string;
  storyRel: string;
}): void {
  const { worktreeAbs, baseBranch, storyRel } = args;

  // Run the merge WITHOUT throwing on a non-zero exit so a conflict can be
  // inspected + resolved rather than surfacing as an opaque marker corruption.
  const merge = runGitNoThrow(worktreeAbs, [
    '-c', 'commit.gpgsign=false',
    'merge', baseBranch, '--no-edit',
  ]);
  if (merge.code === 0) {
    // Clean (no-conflict) path: byte-identical to the legacy bare merge — git
    // has already created the merge commit. Return immediately.
    return;
  }

  // Non-zero exit: determine whether this is a resolvable metadata conflict.
  // `git diff --name-only --diff-filter=U` lists exactly the unmerged
  // (conflicted) paths, repo-relative with forward slashes.
  const conflicted = runGitNoThrow(worktreeAbs, ['diff', '--name-only', '--diff-filter=U'])
    .stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (conflicted.length === 0) {
    // Non-zero with no unmerged paths is NOT a content conflict (e.g. the base
    // branch is unknown, a dirty worktree blocked the merge, a hook failed).
    // Do not pretend to resolve it: abort any half-started merge and surface the
    // real git error for recovery.
    runGitNoThrow(worktreeAbs, ['merge', '--abort']);
    throw new Error(
      `INIT_CHECK reconcile: git merge ${baseBranch} into the story worktree failed and is not a ` +
      `metadata conflict (no unmerged paths). git said:\n${(merge.stderr || merge.stdout).trim()}`,
    );
  }

  // Any conflicted path OUTSIDE the machine-owned story dir cannot be safely
  // auto-resolved (it is not machine-generated metadata we own a canonical
  // version of). Abort the merge cleanly and throw a clear recovery error —
  // never leave/commit markers.
  const outOfBounds = conflicted.filter((path) => !isPathUnderAny(path, [storyRel]));
  if (outOfBounds.length > 0) {
    runGitNoThrow(worktreeAbs, ['merge', '--abort']);
    throw new Error(
      `INIT_CHECK reconcile: merge of ${baseBranch} conflicted on non-metadata paths that cannot be ` +
      `auto-resolved:\n${outOfBounds.join('\n')}\n` +
      `Aborted the merge to avoid committing conflict markers. Resolve manually in the worktree ` +
      `(git merge ${baseBranch}) and retry.`,
    );
  }

  // Every conflicted path is under the machine-owned story dir. Resolve each to
  // the post-advance (base/main) version. We merged `baseBranch` INTO the story
  // branch, so `--theirs` is the incoming base branch's version. Stage the
  // resolved content so no markers remain, then complete the merge commit.
  //
  // The throwing gitCli calls below (stage / rm / commit) can fail for reasons
  // outside our control (locked index, hook failure, disk error). If any of
  // them throws, the exception must NOT escape with the worktree left mid-merge
  // (MERGE_HEAD present) — that would require manual `git merge --abort`
  // recovery. Wrap the resolution + commit in try/catch so ANY throw aborts the
  // half-started merge before rethrowing, mirroring the out-of-bounds and
  // still-unmerged abort+throw handling above.
  try {
    for (const path of conflicted) {
      // `git checkout --theirs` takes the base/main version for content (and
      // add/add) conflicts. For a modify/delete conflict where base DELETED the
      // path there is no "theirs" stage and checkout errors — in that case the
      // deterministic "take base" resolution is to delete the path too.
      const tookTheirs = runGitNoThrow(worktreeAbs, ['checkout', '--theirs', '--', path]);
      if (tookTheirs.code === 0) {
        gitCli(worktreeAbs, ['add', '--', path]);
      } else {
        gitCli(worktreeAbs, ['rm', '-f', '--', path]);
      }
    }

    // Defensive: confirm no unmerged paths remain before committing so a marker
    // can never reach a commit object. (Re-check the same invariant rather than
    // trusting the loop above blindly — Handler coding convention.)
    const stillUnmerged = runGitNoThrow(worktreeAbs, ['diff', '--name-only', '--diff-filter=U'])
      .stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (stillUnmerged.length > 0) {
      runGitNoThrow(worktreeAbs, ['merge', '--abort']);
      throw new Error(
        `INIT_CHECK reconcile: failed to fully resolve metadata conflict; unmerged paths remain:\n` +
        `${stillUnmerged.join('\n')}\nAborted the merge to avoid committing conflict markers.`,
      );
    }

    gitCli(worktreeAbs, ['-c', 'commit.gpgsign=false', 'commit', '--no-edit']);
  } catch (e) {
    // Any failure while resolving/committing the metadata conflict must leave
    // the worktree clean rather than mid-merge. Abort the half-started merge
    // (best-effort, no-throw) before surfacing the original error.
    runGitNoThrow(worktreeAbs, ['merge', '--abort']);
    throw e;
  }
}

/**
 * Run a git command capturing stdout/stderr/exit code WITHOUT throwing on a
 * non-zero exit. Needed for `git merge`, whose conflict exit code (1) must be
 * inspected and resolved rather than surfacing as an opaque thrown error.
 */
export function runGitNoThrow(cwd: string, gitArgs: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', gitArgs, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: stdout ?? '', stderr: '' };
  } catch (e: any) {
    return {
      code: typeof e?.status === 'number' ? e.status : 1,
      stdout: e?.stdout ? String(e.stdout) : '',
      stderr: e?.stderr ? String(e.stderr) : String(e?.message ?? e),
    };
  }
}
