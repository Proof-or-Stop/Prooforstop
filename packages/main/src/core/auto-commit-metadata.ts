/**
 * Task B-3506: Shared auto-commit helper for Lattice metadata writes
 *
 * Extracted from packages/main/src/handlers/story-advance.ts:autoCommitStoryMetadata
 * (B-6326 lifecycle). All lattice CLI handlers that mutate files under the
 * configured story directory should call this AFTER a successful write so the
 * worktree-dirty gate stops blocking on Lattice's own bookkeeping.
 *
 * Safety contract (preMortem #1 anchor):
 *   - Path scope is derived from the configured storyDir plus `storyId` itself.
 *     The caller cannot broaden the scope by passing a different path argument
 *     — there is no such argument.
 *   - storyId must match /^B-[A-Za-z0-9][A-Za-z0-9-]*$/. Anything else throws
 *     synchronously before any git invocation.
 *   - The classifier (B-6326 classifyDirtyWorktree) is consulted ONLY for the
 *     tail-note about coexisting non-metadata dirt. It is NOT used to decide
 *     whether to stage paths — `git add` is always scoped to the story dir.
 *
 * Idempotency (preMortem #2 anchor):
 *   - When nothing under the story dir is dirty, the function returns ''.
 *   - Two consecutive calls produce at most one commit; the second call sees
 *     an empty staged set and returns ''.
 *
 * Vocabulary (preMortem #3 anchor):
 *   - User-visible prefix is the literal `\n✓ lattice metadata auto-committed:`,
 *     re-exported as AUTO_COMMIT_METADATA_PREFIX so callers and tests can pin it.
 *   - Coexisting non-metadata dirt is announced with the anchor word
 *     `untouched` — never `handled` / `committed` / `all clean`.
 */

import { execFileSync } from 'child_process';
import { reportHealthIssue } from './health.js';
import {
  classifyGitStatusRows,
  dirtyWorktreeClassifierOptionsFromConfig,
  DIRTY_WORKTREE_CATEGORIES,
  type DirtyWorktreeCategory,
  type DirtyWorktreeClassification,
} from './dirty-worktree.js';
import { loadConfig } from './config.js';
import { LATTICE_STORY_DIR, normalizeRelPath } from './lattice-paths.js';
import { StoryStore } from './store.js';
import { resolveGitCwd } from './story-signed-workspace-resolution.js';

/**
 * Literal byte-equal user-visible prefix. Pinned for vocabulary consistency
 * across handlers + smoke (preMortem #3 anchor — CHK-003 / CHK-004).
 */
export const AUTO_COMMIT_METADATA_PREFIX = '\n✓ lattice metadata auto-committed:';

/** Canonical literal path prefix the helper is allowed to stage. */
export const AUTO_COMMIT_STORY_DIR_PREFIX = `${LATTICE_STORY_DIR}/`;

/**
 * storyId form gate — anti-broadening defense (preMortem #1).
 *
 * Production generator (`nextStoryId`) emits `B-{4-6 hex}`. Tests and fixtures
 * use richer alphanumeric forms like `B-test1`, `B-init-authority`, `B-001`.
 * We accept any `B-` followed by ASCII alphanumerics and hyphens — narrow
 * enough to reject path traversal (`..`, `/`, `\`, `:`, `@`, spaces, null
 * bytes, shell metacharacters) but broad enough not to bake production-only
 * id shapes into helper plumbing. Empty string and bare `B-` are rejected.
 */
const STORY_ID_PATTERN = /^B-[A-Za-z0-9][A-Za-z0-9-]*$/;

function assertStoryIdShape(storyId: string): void {
  if (typeof storyId !== 'string' || !STORY_ID_PATTERN.test(storyId)) {
    throw new Error(
      `autoCommitStoryMetadata: storyId must match /^B-[A-Za-z0-9][A-Za-z0-9-]*$/ (got: ${JSON.stringify(storyId)}). ` +
      `Refusing to git-add — broadening the path scope is a preMortem #1 anchor violation.`,
    );
  }
}

function storyDirPrefixFromConfig(projectRoot: string): string {
  const configured = normalizeRelPath(loadConfig(projectRoot).storyDir || LATTICE_STORY_DIR);
  if (!configured || configured === '.' || configured.includes('..')) {
    throw new Error(
      `autoCommitStoryMetadata: invalid configured storyDir ${JSON.stringify(configured)}. ` +
      `Refusing to git-add — broadening the path scope is a preMortem #1 anchor violation.`,
    );
  }
  return configured.endsWith('/') ? configured : `${configured}/`;
}

/**
 * Run classifyDirtyWorktree on the current git status of `projectRoot`.
 * Caller takes a snapshot BEFORE invoking `git add` / `git commit`, because the
 * commit itself takes metadata rows out of the dirty list — and the tail-note
 * must describe what coexisted at the moment of decision.
 */
function snapshotDirtyClassification(projectRoot: string, gitCwd: string): DirtyWorktreeClassification | null {
  try {
    const raw = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = raw.split('\n').map(line => line.trimEnd()).filter(Boolean);
    const config = loadConfig(projectRoot);
    return classifyGitStatusRows(lines, dirtyWorktreeClassifierOptionsFromConfig(config, projectRoot));
  } catch {
    return null;
  }
}

function nonMetadataCounts(classification: DirtyWorktreeClassification): Array<{ category: DirtyWorktreeCategory; count: number }> {
  return DIRTY_WORKTREE_CATEGORIES
    .filter(category => category !== 'lattice_metadata_changes')
    .map(category => ({ category, count: classification.groups[category]?.length ?? 0 }))
    .filter(({ count }) => count > 0);
}

function renderCoexistTailNote(classification: DirtyWorktreeClassification | null): string {
  if (!classification) return '';
  const counts = nonMetadataCounts(classification);
  if (counts.length === 0) return '';
  const parts = counts.map(({ category, count }) => `${category}=${count}`).join(', ');
  return ` (coexisting non-metadata dirt left untouched: ${parts})`;
}

function isNonGitRepositoryError(error: unknown): boolean {
  const anyError = error as { message?: unknown; stderr?: unknown };
  const stderr = Buffer.isBuffer(anyError?.stderr)
    ? anyError.stderr.toString('utf-8')
    : (typeof anyError?.stderr === 'string' ? anyError.stderr : '');
  const message = typeof anyError?.message === 'string' ? anyError.message : '';
  return `${message}\n${stderr}`.includes('not a git repository');
}

/**
 * Auto-commit metadata under the configured story directory.
 *
 * @param projectRoot — repo root (must contain `.git`)
 * @param storyId    — `B-xxxx` form (runtime-validated)
 * @param reason     — operation name (e.g. `finding_add`, `review_pass_set`,
 *                     `summary_set`, or a phase string for story_advance).
 *
 * @returns User-visible suffix (multi-line) to append to the handler's primary
 *          response. Empty string when no commit was produced (non-story branch,
 *          no dirty metadata, etc.). On failure, returns a `⚠ ... failed` warning
 *          line and also writes a health issue (never throws).
 */
export function autoCommitStoryMetadata(
  projectRoot: string,
  storyId: string,
  reason: string,
): string {
  // 1. storyId runtime gate (anti-broadening defense — preMortem #1 anchor)
  assertStoryIdShape(storyId);

  // B-db56: resolve the actual git cwd ONCE at function entry via the
  // resolveGitCwd choke-point. In a wrapper-root layout the metadataRoot
  // (== projectRoot) is NOT a git repo and the real repo is a configured
  // gitRoot subdir; resolveGitCwd routes us there. Plain-repo layouts and
  // unresolved/throws cases fall back to projectRoot — byte-identical.
  let gitCwd: string;
  try {
    gitCwd = resolveGitCwd({
      store: new StoryStore(projectRoot),
      storyId,
      metadataRoot: projectRoot,
      projectRoot,
    });
  } catch {
    gitCwd = projectRoot;
  }

  try {
    // 2. branch check — non-story/* branches stay silent
    let branch = '';
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: gitCwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (e: unknown) {
      if (isNonGitRepositoryError(e)) return '';
      throw e;
    }
    if (!branch.startsWith('story/')) return '';

    // 3. canonical path computation (scope = configured storyDir + storyId)
    const storyRel = `${storyDirPrefixFromConfig(projectRoot)}${storyId}`;

    // 4. snapshot the FULL dirty classification BEFORE committing (so the
    //    tail-note describes coexisting non-metadata dirt as it stood at decision
    //    time — `git add` / `git commit` will drop metadata rows otherwise).
    const dirtySnapshot = snapshotDirtyClassification(projectRoot, gitCwd);

    // 5. fast-path: is anything under the story dir dirty?
    const before = execFileSync('git', ['status', '--porcelain', '--', storyRel], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!before) return '';

    // 6. stage only paths inside the story dir (path-scoped — never `.` / `-A`)
    execFileSync('git', ['add', '--', storyRel], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 7. double-check what got staged — defends against `.gitignore` quirks.
    const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--', storyRel], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!staged) return '';

    // 8. commit
    const subject = `lattice: record ${storyId} ${reason} metadata`;
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', subject], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 9. capture short sha for audit
    let sha7 = '';
    try {
      sha7 = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
        cwd: gitCwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // PROBE: rev-parse failed right after a successful commit — extremely
      // unlikely; fall through to omit the sha suffix rather than throw.
    }

    // 10. assemble tail-note from the PRE-commit snapshot (post-commit would
    //     under-count because git status now hides what we just committed).
    const tailNote = renderCoexistTailNote(dirtySnapshot);
    const shaSuffix = sha7 ? ` (${sha7})` : '';
    return `${AUTO_COMMIT_METADATA_PREFIX} ${subject}${shaSuffix}${tailNote}`;
  } catch (e: any) {
    reportHealthIssue('mutation:storyMetadataCommit', e instanceof Error ? e : new Error(String(e)), {
      storyId,
      reason,
      projectRoot,
    });
    return `\n⚠ lattice metadata auto-commit failed: ${e?.message || e}`;
  }
}
