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
    const resolvedWorktree = resolvePersistedStoryWorktree(metadataRoot, story.worktree.path);
    if (resolvedWorktree) {
      return resolved(
        story,
        metadataRoot,
        storyDir,
        resolvedWorktree,
        'story-worktree',
        resolvedWorktree,
        requiresWorktree,
      );
    }
    unresolvedReasons.push('story_worktree_path_is_not_a_git_worktree');
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

function resolvePersistedStoryWorktree(metadataRoot: string, storedPath: string): string | null {
  for (const candidate of storyWorktreeCandidates(metadataRoot, storedPath)) {
    const probe = probeGitRoot(candidate);
    if (probe.ok && probe.topLevel && canonicalPath(candidate) === probe.topLevel) return probe.topLevel;
  }
  return null;
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
