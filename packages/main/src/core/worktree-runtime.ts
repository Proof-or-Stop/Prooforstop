import { execFileSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { dirname, isAbsolute, join, relative } from 'path';
import type { StoryStore } from './store.js';

export interface GitWorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  branchRef: string | null;
}

export interface StoryWorktreeRuntime {
  storyId: string;
  repoRoot: string;
  branch: string;
  hasWorktreeRecord: boolean;
  recordedPath: string | null;
  recordedAbsPath: string | null;
  recordedForeignPath: boolean;
  recordedExists: boolean;
  linkedPath: string | null;
  linkedRelPath: string | null;
  linkedExists: boolean;
  branchExists: boolean;
  branchMerged: boolean;
  branchContainsMain: boolean | null;
  drift: boolean;
  canRepairPath: boolean;
  status: 'ok' | 'drift' | 'missing' | 'orphaned' | 'foreign';
  summary: string;
  warnings: string[];
  recoveryHint: string | null;
}

function git(gitCwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: gitCwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function isForeignAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path) || /^\/\/[^/]/.test(path);
}

export function getRepoRoot(root: string): string {
  try {
    const topLevel = canonicalPath(git(root, ['rev-parse', '--show-toplevel']));
    const commonDir = git(root, ['rev-parse', '--git-common-dir']);
    const absCommonDir = canonicalPath(isAbsolute(commonDir) ? commonDir : join(topLevel, commonDir));
    if (absCommonDir.endsWith('/.git') || absCommonDir.endsWith('\\.git')) {
      return dirname(absCommonDir);
    }
    return topLevel;
  } catch {
    return canonicalPath(root);
  }
}

export function resolveWorktreePath(repoRoot: string, storedPath: string | null | undefined): string | null {
  if (!storedPath) return null;
  if (isForeignAbsolutePath(storedPath)) return storedPath;
  if (isAbsolute(storedPath)) return storedPath;
  return join(repoRoot, storedPath);
}

function toRepoRelative(repoRoot: string, absPath: string): string {
  return relative(repoRoot, absPath).replace(/\\/g, '/');
}

function readBranches(root: string, args: string[]): Set<string> {
  const raw = git(root, ['for-each-ref', '--format=%(refname:short)', ...args, 'refs/heads']);
  return new Set(raw.split('\n').map((line) => line.trim()).filter(Boolean));
}

export function listGitWorktrees(root: string): GitWorktreeEntry[] {
  const repoRoot = getRepoRoot(root);
  let raw = '';
  try {
    raw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return [];
  }

  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = {
        path: canonicalPath(line.slice('worktree '.length).trim()),
        head: null,
        branch: null,
        branchRef: null,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
      continue;
    }
    if (line.startsWith('detached')) {
      current.branch = null;
      current.branchRef = null;
      continue;
    }
    if (line.startsWith('branch ')) {
      current.branchRef = line.slice('branch '.length).trim();
      current.branch = current.branchRef.replace(/^refs\/heads\//, '');
      continue;
    }
    if (line.trim().length === 0) {
      entries.push(current);
      current = null;
    }
  }
  if (current) entries.push(current);
  return entries;
}

export function getStoryWorktreeRuntime(
  storyId: string,
  store: StoryStore,
  root: string,
): StoryWorktreeRuntime {
  const story = store.readStory(storyId);
  const repoRoot = getRepoRoot(root);
  const branch = story.worktree?.branch || `story/${storyId}`;
  const recordedPath = story.worktree?.path ?? null;
  const recordedForeignPath = recordedPath ? isForeignAbsolutePath(recordedPath) : false;
  const recordedAbsPath = resolveWorktreePath(repoRoot, recordedPath);
  const recordedExists = recordedAbsPath && !recordedForeignPath ? existsSync(recordedAbsPath) : false;

  const linkedEntry = listGitWorktrees(repoRoot).find((entry) => entry.branch === branch) || null;
  const linkedPath = linkedEntry?.path ?? null;
  const linkedRelPath = linkedPath ? toRepoRelative(repoRoot, linkedPath) : null;
  const linkedExists = linkedPath ? existsSync(linkedPath) : false;

  let branchExists = false;
  let branchMerged = false;
  try {
    branchExists = readBranches(repoRoot, []).has(branch);
  } catch { /* PROBE */ }
  try {
    branchMerged = readBranches(repoRoot, ['--merged=main']).has(branch);
  } catch { /* PROBE */ }
  let branchContainsMain: boolean | null = null;
  if (branchExists) {
    try {
      git(repoRoot, ['merge-base', '--is-ancestor', 'main', branch]);
      branchContainsMain = true;
    } catch {
      branchContainsMain = false;
    }
  }

  const drift = Boolean(linkedPath && recordedAbsPath && canonicalPath(linkedPath) !== canonicalPath(recordedAbsPath));
  const canRepairPath = Boolean(linkedPath && (!recordedAbsPath || drift));
  const warnings: string[] = [];
  let status: StoryWorktreeRuntime['status'] = 'ok';
  let summary = 'worktree registered';
  let recoveryHint: string | null = null;

  if (linkedPath) {
    if (drift || !recordedAbsPath) {
      status = 'drift';
      summary = 'git linked worktree exists but story record drifted';
      warnings.push(`linked worktree: ${linkedPath}`);
      if (recordedAbsPath) warnings.push(`recorded path: ${recordedAbsPath}`);
      recoveryHint = canRepairPath
        ? `Can be auto-corrected to ${linkedPath} via git worktree list`
        : 'First confirm the currently active linked worktree, then decide whether to write back story.worktree.path';
    }
  } else if (recordedForeignPath) {
    status = 'foreign';
    summary = 'story worktree path is from another platform';
    warnings.push(`foreign stale path: ${recordedAbsPath || recordedPath}`);
    recoveryHint = `Branch ${branch} no longer exists or the worktree path belongs to another platform; first check whether to reconcile / discard / re-run INIT_CHECK`;
  } else if (recordedExists) {
    status = 'orphaned';
    summary = 'recorded worktree directory exists but git registry has no matching linked worktree';
    warnings.push(`recorded path: ${recordedAbsPath}`);
    recoveryHint = 'First check git worktree list / git worktree repair; if the directory is leftover residue, then clean up and rebuild';
  } else if (recordedPath || branchExists) {
    status = 'missing';
    summary = branchExists
      ? 'story branch exists but no linked worktree is registered'
      : 'story has no active linked worktree';
    if (recordedAbsPath) warnings.push(`missing path: ${recordedAbsPath}`);
    if (branchMerged) warnings.push(`branch ${branch} already merged into main`);
    recoveryHint = branchExists
      ? `Run lattice story_advance --storyId=${storyId} --phase=INIT_CHECK to re-establish the worktree`
      : `Branch ${branch} no longer exists; first check whether to reconcile / discard / re-run INIT_CHECK`;
  }

  if (linkedPath && branchContainsMain === false) {
    warnings.push(`branch ${branch} does not contain current main; merge/rebase main before DEV if latest baseline matters`);
  }

  return {
    storyId,
    repoRoot,
    branch,
    hasWorktreeRecord: Boolean(story.worktree),
    recordedPath,
    recordedAbsPath,
    recordedForeignPath,
    recordedExists,
    linkedPath,
    linkedRelPath,
    linkedExists,
    branchExists,
    branchMerged,
    branchContainsMain,
    drift,
    canRepairPath,
    status,
    summary,
    warnings,
    recoveryHint,
  };
}

export function resolveLinkedWorktreePath(runtime: StoryWorktreeRuntime): string | null {
  return runtime.linkedPath || runtime.recordedAbsPath || null;
}

export function resolveLinkedWorktreeStoryPath(runtime: StoryWorktreeRuntime): string | null {
  if (runtime.linkedPath) {
    return runtime.linkedRelPath || toRepoRelative(runtime.repoRoot, runtime.linkedPath);
  }
  return runtime.recordedPath || null;
}
