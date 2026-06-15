/**
 * @task B-748e
 * @checklist CHK-001, CHK-003
 * @title bind unresolved signed workspace reason coverage
 * @type chore
 * @priority high
 * @description
 *   Source binding for review-run-start-signed-workspace-resolution-execution-plan.md:262:
 *   unresolvedReason remains exactly
 *   requires_git_signed_workspace_but_metadata_root_is_not_git_and_no_worktree_or_gitRoot_is_configured
 *   when metadataRoot is not git-backed and no story worktree or gitRoot is configured.
 * @changes
 *   - [CHK-001] Bind the exact unresolvedReason requirement to the existing signed-workspace resolver behavior.
 *   - [CHK-003] Keep this as annotation coverage only; do not claim unrelated future-scope support.
 */
import { existsSync, realpathSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
import { loadConfig, type KoalaConfig } from './config.js';
import { gitProbe } from './git-probe.js';
import type { StoryStore } from './store.js';
import type { StoryInfo, StoryPhase } from './types.js';
import { getRepoRoot, listGitWorktrees } from './worktree-runtime.js';

export type StorySignedWorkspaceResolutionSource =
  | 'story-worktree'
  | 'linked-story-branch-worktree'
  | 'metadata-git-root'
  | 'configured-git-root'
  | 'unresolved';

export interface StorySignedWorkspaceResolution {
  storyId: string;
  phase: StoryPhase;
  metadataRoot: string;
  storyDir: string;
  signedWorkspaceRoot: string | null;
  authoritativeCwd: string | null;
  worktreePath: string | null;
  repoRoot: string | null;
  requiresWorktree: boolean;
  resolved: boolean;
  resolutionSource: StorySignedWorkspaceResolutionSource;
  unresolvedReason: string | null;
}

export interface ResolveStorySignedWorkspaceOptions {
  store: StoryStore;
  storyId: string;
  metadataRoot: string;
  cwd?: string;
  config?: KoalaConfig;
}

interface GitRootProbe {
  ok: boolean;
  topLevel: string | null;
  reason: string | null;
}

interface ConfiguredGitRootResolution {
  ok: boolean;
  path: string | null;
  reason: string | null;
}

interface PersistedStoryWorktreeResolution {
  path: string | null;
  reason: string | null;
}

export function resolveStorySignedWorkspace(
  opts: ResolveStorySignedWorkspaceOptions,
): StorySignedWorkspaceResolution {
  const story = opts.store.readStory(opts.storyId);
  const metadataRoot = canonicalPath(opts.metadataRoot);
  const config = opts.config ?? loadConfig(metadataRoot);
  const storyDir = opts.store.storyDirPath(story.storyId);
  const requiresWorktree = story.phase !== 'INIT' && story.phase !== 'DONE' && story.phase !== 'DISCARDED';
  const expectedBranch = story.worktree?.branch || `story/${story.storyId}`;
  const hasWorktreeBinding = Boolean(story.worktree?.path);
  const unresolvedReasons: string[] = [];

  if (story.worktree?.path) {
    const resolvedWorktree = resolvePersistedStoryWorktree(metadataRoot, story.worktree.path, expectedBranch);
    if (resolvedWorktree.path) {
      return resolved(
        story,
        metadataRoot,
        storyDir,
        resolvedWorktree.path,
        'story-worktree',
        resolvedWorktree.path,
        requiresWorktree,
      );
    }
    unresolvedReasons.push(resolvedWorktree.reason || 'story_worktree_path_is_not_a_git_worktree');
  }

  const configuredGitRoot = resolveConfiguredGitRoot(metadataRoot, config.gitRoot);
  if (configuredGitRoot) {
    if (!configuredGitRoot.ok) {
      return unresolved(story, metadataRoot, storyDir, requiresWorktree, configuredGitRoot.reason!);
    }

    const linkedWorktree = resolveLinkedStoryWorktree(configuredGitRoot.path!, expectedBranch);
    if (linkedWorktree) {
      return resolved(
        story,
        metadataRoot,
        storyDir,
        linkedWorktree,
        'linked-story-branch-worktree',
        linkedWorktree,
        requiresWorktree,
      );
    }

    if (!hasWorktreeBinding) {
      return resolved(
        story,
        metadataRoot,
        storyDir,
        configuredGitRoot.path!,
        'configured-git-root',
        null,
        requiresWorktree,
      );
    }
    unresolvedReasons.push('configured_gitRoot_has_no_linked_story_worktree');
  }

  const metadataGitRoot = probeGitRoot(metadataRoot);
  if (metadataGitRoot.ok && metadataGitRoot.topLevel) {
    const linkedWorktree = resolveLinkedStoryWorktree(metadataGitRoot.topLevel, expectedBranch);
    if (linkedWorktree) {
      return resolved(
        story,
        metadataRoot,
        storyDir,
        linkedWorktree,
        'linked-story-branch-worktree',
        linkedWorktree,
        requiresWorktree,
      );
    }

    if (!hasWorktreeBinding) {
      return resolved(
        story,
        metadataRoot,
        storyDir,
        metadataGitRoot.topLevel,
        'metadata-git-root',
        null,
        requiresWorktree,
      );
    }
    unresolvedReasons.push('linked_story_branch_worktree_not_found');
  }

  const reason = hasWorktreeBinding
    ? `story_worktree_binding_unresolved:${unresolvedReasons.join(',') || 'no_valid_git_worktree'}`
    : 'requires_git_signed_workspace_but_metadata_root_is_not_git_and_no_worktree_or_gitRoot_is_configured';
  return unresolved(story, metadataRoot, storyDir, requiresWorktree, reason);
}

/**
 * B-198c CHK-001: pure detection helper.
 *
 * Early-detect the wrapper-root violation where story metadata does NOT resolve
 * inside the resolved git root. The git-backed lifecycle must git-commit story
 * metadata (scoped story branch + DONE merge to main), which requires storyDir
 * to live inside the resolved gitRoot. Today the only detectors are two LATE
 * guards (worktree.ts:754 + cli-engine.ts reconcile) that fire at INIT_CHECK
 * bootstrap — by then the user already invested INIT/PLAN effort. This helper
 * lets the new doctor check (CHK-002) and early advisory (CHK-003) surface the
 * dead end sooner WITHOUT touching those stable guards.
 *
 * Single source of truth for the escape condition: it mirrors the EXACT check
 * at packages/main/src/handlers/worktree.ts:754 —
 *   rel = relative(realpath(gitRoot), realpath(storyAbs))
 *   violation when rel is empty / absolute / contains a `..` segment
 * realpath BOTH sides so a /var → /private/var symlink between the metadata
 * root and the git toplevel does not produce a false violation; fall back to
 * the raw path when it does not exist on disk (mirrors the guards'
 * `existsSync ? realpathSync : path` pattern).
 *
 * PURE: never throws, no console output. Callers own presentation.
 *
 * When signed-workspace resolution is unresolved (no/invalid gitRoot), returns
 * a DISTINCT non-violation result (`ok: true`, `reason: 'gitroot-unresolved'`)
 * so callers can report the unresolvable condition separately rather than
 * mislabel it as an inside/outside violation.
 */
export interface StoryDirInsideGitRootResult {
  /** false = violation (storyDir resolves OUTSIDE the resolved gitRoot). */
  ok: boolean;
  /** Canonicalized absolute story metadata dir (realpath when on disk). */
  storyDirAbs: string;
  /** Canonicalized absolute resolved git root, or null when unresolved. */
  gitRootAbs: string | null;
  /** relative(gitRootAbs, storyDirAbs), or null when gitRoot is unresolved. */
  rel: string | null;
  /**
   * Present only for non-inside results:
   *  - 'gitroot-unresolved' → signed workspace could not resolve a gitRoot
   *  - 'outside-gitroot'     → storyDir resolves outside the resolved gitRoot
   */
  reason?: 'gitroot-unresolved' | 'outside-gitroot';
}

export interface EvaluateStoryDirInsideGitRootOptions {
  store: StoryStore;
  storyId: string;
  metadataRoot: string;
  cwd?: string;
  config?: KoalaConfig;
}

export function evaluateStoryDirInsideGitRoot(
  opts: EvaluateStoryDirInsideGitRootOptions,
): StoryDirInsideGitRootResult {
  const metadataRoot = canonicalPath(opts.metadataRoot);
  // storyAbs mirrors worktree.ts: join(root, store.storyDirRel() minus trailing
  // slash, storyId), then realpath both sides.
  const storyAbs = join(
    metadataRoot,
    opts.store.storyDirRel().replace(/\/$/, ''),
    opts.storyId,
  );
  const storyDirAbs = canonicalPath(storyAbs);

  const resolution = resolveStorySignedWorkspace({
    store: opts.store,
    storyId: opts.storyId,
    metadataRoot,
    cwd: opts.cwd,
    config: opts.config,
  });

  // Unresolved gitRoot → distinct non-violation result; never throw.
  if (!resolution.resolved || !resolution.signedWorkspaceRoot) {
    return {
      ok: true,
      storyDirAbs,
      gitRootAbs: null,
      rel: null,
      reason: 'gitroot-unresolved',
    };
  }

  const gitRootAbs = canonicalPath(resolution.signedWorkspaceRoot);
  const rel = relative(gitRootAbs, storyDirAbs).replace(/\\/g, '/');

  // EXACT escape condition mirrored from worktree.ts:754.
  const violation = !rel || isAbsolute(rel) || rel.split('/').includes('..');
  if (violation) {
    return {
      ok: false,
      storyDirAbs,
      gitRootAbs,
      rel,
      reason: 'outside-gitroot',
    };
  }

  return { ok: true, storyDirAbs, gitRootAbs, rel };
}

function resolved(
  story: StoryInfo,
  metadataRoot: string,
  storyDir: string,
  signedWorkspaceRoot: string,
  resolutionSource: Exclude<StorySignedWorkspaceResolutionSource, 'unresolved'>,
  worktreePath: string | null,
  requiresWorktree: boolean,
): StorySignedWorkspaceResolution {
  const canonicalSignedRoot = canonicalPath(signedWorkspaceRoot);
  return {
    storyId: story.storyId,
    phase: story.phase,
    metadataRoot,
    storyDir,
    signedWorkspaceRoot: canonicalSignedRoot,
    authoritativeCwd: canonicalSignedRoot,
    worktreePath,
    repoRoot: canonicalPath(getRepoRoot(canonicalSignedRoot)),
    requiresWorktree,
    resolved: true,
    resolutionSource,
    unresolvedReason: null,
  };
}

function unresolved(
  story: StoryInfo,
  metadataRoot: string,
  storyDir: string,
  requiresWorktree: boolean,
  unresolvedReason: string,
): StorySignedWorkspaceResolution {
  return {
    storyId: story.storyId,
    phase: story.phase,
    metadataRoot,
    storyDir,
    signedWorkspaceRoot: null,
    authoritativeCwd: null,
    worktreePath: null,
    repoRoot: null,
    requiresWorktree,
    resolved: false,
    resolutionSource: 'unresolved',
    unresolvedReason,
  };
}

function resolvePersistedStoryWorktree(
  metadataRoot: string,
  storedPath: string,
  expectedBranch: string,
): PersistedStoryWorktreeResolution {
  let sawGitRoot = false;
  let sawWrongBranch = false;
  for (const candidate of storyWorktreeCandidates(metadataRoot, storedPath)) {
    const probe = probeGitRoot(candidate);
    if (!probe.ok || !probe.topLevel || canonicalPath(candidate) !== probe.topLevel) continue;
    sawGitRoot = true;
    if (gitRootHasBranch(probe.topLevel, expectedBranch)) return { path: probe.topLevel, reason: null };
    sawWrongBranch = true;
  }
  if (sawWrongBranch) return { path: null, reason: 'story_worktree_path_branch_mismatch' };
  if (sawGitRoot) return { path: null, reason: 'story_worktree_path_branch_unresolved' };
  return { path: null, reason: 'story_worktree_path_is_not_a_git_worktree' };
}

function storyWorktreeCandidates(metadataRoot: string, storedPath: string): string[] {
  if (isAbsolute(storedPath)) return [storedPath];
  const candidates = [join(metadataRoot, storedPath)];
  const repoRoot = canonicalPath(getRepoRoot(metadataRoot));
  if (repoRoot !== metadataRoot) candidates.push(join(repoRoot, storedPath));
  return uniquePaths(candidates);
}

function resolveLinkedStoryWorktree(repoRoot: string, expectedBranch: string): string | null {
  const linked = listGitWorktrees(repoRoot).find((entry) => entry.branch === expectedBranch);
  if (!linked) return null;
  const probe = probeGitRoot(linked.path);
  if (!probe.ok || !probe.topLevel) return null;
  return probe.topLevel;
}

function gitRootHasBranch(gitRoot: string, expectedBranch: string): boolean {
  const branch = gitProbe('git rev-parse --abbrev-ref HEAD', { cwd: gitRoot });
  return branch.ok && branch.output === expectedBranch;
}

function resolveConfiguredGitRoot(metadataRoot: string, configuredGitRoot: string | undefined): ConfiguredGitRootResolution | null {
  const raw = configuredGitRoot?.trim();
  if (!raw) return null;
  const candidate = canonicalPath(isAbsolute(raw) ? raw : join(metadataRoot, raw));
  if (!isPathInside(metadataRoot, candidate)) {
    return { ok: false, path: null, reason: 'configured_gitRoot_outside_metadata_root' };
  }
  if (!existsSync(candidate)) {
    return { ok: false, path: null, reason: 'configured_gitRoot_missing' };
  }
  const probe = probeGitRoot(candidate);
  if (!probe.ok || !probe.topLevel) {
    return { ok: false, path: null, reason: 'configured_gitRoot_is_not_git_repository' };
  }
  if (probe.topLevel !== candidate) {
    return { ok: false, path: null, reason: 'configured_gitRoot_is_not_git_root' };
  }
  return { ok: true, path: probe.topLevel, reason: null };
}

function probeGitRoot(candidate: string): GitRootProbe {
  if (!existsSync(candidate)) {
    return { ok: false, topLevel: null, reason: 'path_missing' };
  }
  const result = gitProbe('git rev-parse --show-toplevel', { cwd: candidate });
  if (!result.ok) return { ok: false, topLevel: null, reason: result.reason };
  return { ok: true, topLevel: canonicalPath(result.output), reason: null };
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(canonicalPath(root), canonicalPath(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function canonicalPath(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const canonical = canonicalPath(path);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}
