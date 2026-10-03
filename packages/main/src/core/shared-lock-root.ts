/**
 * Worktree-independent lock roots: the git-common-dir anchor shared by every
 * linked worktree, the per-story runtime lock path under it, and the lock-name
 * sanitizer. A leaf over node built-ins, so callers that only need a lock PATH
 * (causal-evidence, story-owner-lease, dirty-gate-policy) do not import
 * validation-execution-lock, which imports story-owner-lease back (that was part
 * of the 55-module core import cycle). validation-execution-lock re-exports
 * these under their original names.
 */
import { execFileSync } from 'node:child_process';
import { observedGit } from './git-tree-observation.js';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';

export function sanitizeLockSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

/**
 * B-d877 R3 FIX B: resolve a per-story RUNTIME lock dir under the DURABLE shared
 * root's gitignored `.proof-or-stop/locks/<category>/`, NEVER under the git-tracked
 * story metadata dir (`.proof-or-stop/story/actives/<id>/`).
 *
 * The universal-lockId change (R2 FIX D) writes a `holder.json` inside EVERY
 * acquired lock dir. When such a lock lived inside the story dir (e.g.
 * `<storyDir>/review-passes.lock/`), a `git add -A` that ran while the lock was
 * held committed that transient `holder.json`; releasing the lock then deleted
 * it, leaving a `D …/review-passes.lock/holder.json` dirty entry that
 * deterministically failed the clean-tree preflight (quorum-submit-smoke).
 *
 * Anchoring at `resolveSharedLockRoot(root)` (git-common-dir based) — exactly
 * like the validation execution lock and the per-story transition lock — makes
 * the lock (a) live under the ALREADY-gitignored `.proof-or-stop/locks/` prefix, (b)
 * survive story-worktree removal, and (c) resolve IDENTICALLY from every
 * worktree/main root so cross-worktree callers contend on ONE mutex. The lock
 * file name embeds BOTH the sanitized story id and the logical `<name>` so
 * distinct per-story locks (checklist / review-passes / review-runs /
 * init-check / prompt-envelopes / process-events append) never collide in the
 * shared category dir. FAIL-OPEN: a non-git / unreadable root falls back to
 * `root` verbatim.
 */
export function storyRuntimeLockPath(
  root: string,
  category: string,
  storyId: string,
  name: string,
): string {
  const projectRoot = String(root ?? '').trim();
  const id = String(storyId ?? '').trim();
  if (!projectRoot) throw new Error('storyRuntimeLockPath: root is required');
  if (!id) throw new Error('storyRuntimeLockPath: storyId is required');
  const sharedRoot = resolveSharedLockRoot(projectRoot);
  return join(sharedRoot, PROOF_OR_STOP_DIR, 'locks', category, `${sanitizeLockSegment(id)}-${name}.lock`);
}

/**
 * Resolve the canonical, worktree-independent repository root that anchors
 * story-scoped coordination state (validation locks). Two linked worktrees of
 * the same repository must share ONE lock per story so a validation running in
 * one worktree serializes against a validation in another; keying the lock off
 * each worktree's own physical root (the old behavior) minted DIFFERENT locks
 * and defeated cross-worktree/host serialization.
 *
 * `git rev-parse --git-common-dir` returns the SAME common git dir for the main
 * worktree and every linked worktree (e.g. `<repo>/.git`), so it is the stable
 * shared anchor. On ANY failure (not a git repo, git missing, unusual layout)
 * this falls back to `root` verbatim, keeping plain-repo behavior byte-identical.
 */
export function resolveGitCommonLockRoot(root: string): string {
  const projectRoot = String(root ?? '').trim();
  if (!projectRoot) throw new Error('git-common-dir lock identity requires a workspace root');
  const commonDirRaw = observedGit(projectRoot, ['rev-parse', '--git-common-dir'], () => execFileSync('git', ['-C', projectRoot, 'rev-parse', '--git-common-dir'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  })).trim();
  if (!commonDirRaw) throw new Error(`git-common-dir lock identity is empty for ${projectRoot}`);
  const commonDirAbs = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(projectRoot, commonDirRaw);
  const commonDir = realpathSync(commonDirAbs);
  return basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
}

// Cache only successful Git identities. Recheck the nearest .git entry, its
// real path and linked-worktree commondir on every lookup; init/retarget/remove
// must never reuse an identity from another repository.
const sharedRootCache = new Map<string, { fingerprint: string; sharedRoot: string }>();
function sharedRootFingerprint(root: string): string {
  let dir = realpathSync(root);
  const parts = [dir];
  while (!existsSync(join(dir, '.git'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('no Git entry');
    dir = parent;
  }
  const entry = join(dir, '.git');
  const stat = statSync(entry);
  parts.push(realpathSync(entry), String(stat.dev), String(stat.ino));
  let gitDir = entry;
  if (stat.isFile()) {
    const contents = readFileSync(entry, 'utf8');
    parts.push(contents);
    const match = /^gitdir: (.+)\s*$/.exec(contents.trim());
    if (!match) throw new Error('invalid Git entry');
    gitDir = resolve(dir, match[1]);
  }
  const commonFile = join(gitDir, 'commondir');
  const common = existsSync(commonFile) ? readFileSync(commonFile, 'utf8').trim() : '.';
  const commonDir = realpathSync(resolve(gitDir, common));
  const commonStat = statSync(commonDir);
  parts.push(common, commonDir, String(commonStat.dev), String(commonStat.ino));
  return JSON.stringify(parts);
}
export function resolveSharedLockRoot(root: string): string {
  const projectRoot = String(root ?? '').trim();
  if (!projectRoot) return projectRoot;
  try {
    if (process.env.GIT_DIR || process.env.GIT_COMMON_DIR || process.env.GIT_WORK_TREE) return resolveGitCommonLockRoot(projectRoot);
    const fingerprint = sharedRootFingerprint(projectRoot);
    const cached = sharedRootCache.get(projectRoot);
    if (cached?.fingerprint === fingerprint) return cached.sharedRoot;
    const sharedRoot = resolveGitCommonLockRoot(projectRoot);
    if (sharedRootCache.size >= 128) sharedRootCache.delete(sharedRootCache.keys().next().value!);
    sharedRootCache.set(projectRoot, { fingerprint, sharedRoot });
    return sharedRoot;
  } catch {
    sharedRootCache.delete(projectRoot);
    try { return resolveGitCommonLockRoot(projectRoot); } catch { return projectRoot; }
  }
}
