/**
 * B-02a6 CHK-002: safe-init-commit on the current branch HEAD.
 *
 * Root cause this closes:
 *   `story_create` writes a story's INIT metadata
 *   (`<storyDir>/<storyId>/index.json` etc.) into the SHARED main checkout as
 *   UNTRACKED files. The repo `.gitignore` allowlists `.lattice/story/actives/**`
 *   (i.e. NOT ignored) — exactly the file class a plain `git clean -fd` removes.
 *   A story sitting in INIT therefore has its metadata committed to no branch, so
 *   a concurrent `git clean -fd` (or a wrong-branch checkout) on the shared
 *   checkout PERMANENTLY DELETES it.
 *
 * Fix:
 *   At the end of `story_create` (inside the held main-write-lock) advance the
 *   CURRENT branch HEAD by committing ONLY the new story's metadata dir, so the
 *   leaf is a tracked git object from birth — immune to `git clean -fd`.
 *
 * Mechanism (advances the CURRENT branch on the SHARED working tree, so it must
 * update the WORKING index too — a temp-index trick like the INIT_CHECK
 * bootstrap leaves the working index stale, which means `git clean -fd` would
 * still treat the file as untracked and wipe it):
 *   git add -f -- <storyRel>  (stage into the working index; -f so a broad
 *                              `.lattice/` ignore never aborts)
 *   git commit --only -- <storyRel>  (commit ONLY that pathspec — coexisting
 *                              staged changes are left untouched — and advance
 *                              the current branch HEAD).
 * `--only` keeps the commit scoped to the story dir AND leaves the working index
 * tracking the path, so the on-disk leaf is tracked-and-clean and clean-proof.
 *
 * This is a DELIBERATE, scoped main-HEAD commit — separate from
 * `auto-commit-metadata.ts`, whose `!branch.startsWith('story/')` early-return is
 * exactly why main never commits today. We do NOT relax that helper.
 *
 * Idempotency:
 *   If HEAD's tree already carries `<storyRel>/index.json` (e.g. the metadata was
 *   already committed), the freshly written tree equals HEAD's tree, so we skip
 *   the commit rather than producing an empty/duplicate one.
 *
 * Safety / fail-open:
 *   The commit is best-effort observability of a durable object. Any git failure
 *   (detached HEAD, no HEAD yet, ignored-and-force-add-stripped, etc.) returns a
 *   non-committed result instead of throwing, so a successful `story_create`
 *   never fails on the safe-init commit. The metadata remains on disk; the next
 *   INIT_CHECK bootstrap or doctor surfaces an uncommitted leaf.
 */

import { execFileSync } from 'child_process';

export interface SafeInitCommitArgs {
  storyId: string;
  /** Story metadata dir path RELATIVE to repoRoot (forward-slash, no leading slash). */
  storyRel: string;
  /** Resolved git repository root the commit must run from. */
  repoRoot: string;
}

export interface SafeInitCommitResult {
  /** true when a new commit advanced the current branch HEAD. */
  committed: boolean;
  /** Short sha of the new HEAD when committed; '' otherwise. */
  sha: string;
  /** Why no commit was produced (idempotent / detached / error), for diagnostics. */
  reason?: 'already-tracked' | 'no-head' | 'detached' | 'nothing-staged' | 'error';
  /** Subject of the commit when committed. */
  subject?: string;
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * True when `ref`'s tree already contains the story's index.json leaf. Used by
 * the INIT_CHECK bootstrap to decide whether main already carries the metadata
 * (so it can branch from main as-is instead of duplicating the init commit).
 */
export function refContainsStoryMetadata(repoRoot: string, ref: string, storyIndexRel: string): boolean {
  try {
    git(repoRoot, ['cat-file', '-e', `${ref}:${storyIndexRel}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Commit ONLY `<storyRel>` onto the CURRENT branch HEAD (and the working index),
 * making the story's INIT metadata a tracked (clean-proof) git object. Never
 * throws — returns a structured result so a successful story_create cannot fail
 * on it.
 */
export function createSafeInitCommitOnHead(args: SafeInitCommitArgs): SafeInitCommitResult {
  const { storyId, storyRel, repoRoot } = args;

  // A repo with no commits yet cannot carry a scoped commit on top of HEAD.
  try {
    git(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    return { committed: false, sha: '', reason: 'no-head' };
  }

  // Resolve the current branch ref. A detached HEAD has no branch to advance —
  // skip rather than rewrite a detached checkout's anonymous HEAD.
  let branch: string;
  try {
    branch = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return { committed: false, sha: '', reason: 'error' };
  }
  if (!branch || branch === 'HEAD') {
    return { committed: false, sha: '', reason: 'detached' };
  }

  try {
    // Idempotency fast-path: nothing under the story dir is dirty (already
    // committed / tracked-and-clean) → do NOT produce an empty/duplicate commit.
    const dirty = git(repoRoot, ['status', '--porcelain', '--', storyRel]);
    if (!dirty) {
      return { committed: false, sha: '', reason: 'already-tracked' };
    }

    // Stage ONLY the story dir into the WORKING index. force-add (`-f`) so a
    // broad `.lattice/` ignore never aborts with "paths are ignored".
    git(repoRoot, ['add', '-f', '--', storyRel]);

    // Double-check something actually staged (defends against `.gitignore`
    // quirks that strip a force-add).
    const staged = git(repoRoot, ['diff', '--cached', '--name-only', '--', storyRel]);
    if (!staged) {
      return { committed: false, sha: '', reason: 'nothing-staged' };
    }

    // Commit ONLY the story-dir pathspec (`--only`): coexisting staged changes
    // are left untouched, and the working index keeps tracking the path — so the
    // on-disk leaf is tracked-and-clean and immune to `git clean -fd`.
    const subject = `lattice: story ${storyId} init`;
    git(repoRoot, ['-c', 'commit.gpgsign=false', 'commit', '--only', '-m', subject, '--', storyRel]);

    let sha = '';
    try {
      sha = git(repoRoot, ['rev-parse', '--short=7', 'HEAD']);
    } catch {
      /* sha is best-effort audit detail */
    }
    return { committed: true, sha, reason: undefined, subject };
  } catch {
    return { committed: false, sha: '', reason: 'error' };
  }
}
