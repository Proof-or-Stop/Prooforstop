import { execFileSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import type { StoryStore } from './store.js';
import type { StoryInfo } from './types.js';
import { loadConfig } from './config.js';
import { isVolatileRuntimeArtifactPath } from './runtime-artifact-registry.js';
import { resolveRepositoryBaseline } from './git-baseline.js';
import { resolveStoryIntegrationTarget } from './story-integration-target.js';

export interface PartialDoneStory {
  storyId: string;
  title: string;
  branch: string;
  worktreePath: string | null;
  branchExists: boolean;
  branchMergedToMain: boolean;
  worktreeRegistered: boolean;
  worktreeExists: boolean;
  mergeTreeClean: boolean;
  recoverCommand: string;
  reason: string;
}

function git(gitCwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: gitCwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

// Porcelain status reads must NOT use git(): its full-output trim() strips the
// first porcelain row's leading status space (" M path" -> "M path"), shifting
// the fixed-width path offset so statusLinePath() corrupts the first path
// (".proof-or-stop/x" -> "proofOrStop/x") and volatile-artifact filtering misfires.
function gitRaw(gitCwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: gitCwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function gitSucceeds(root: string, args: string[]): boolean {
  try {
    git(root, args);
    return true;
  } catch {
    return false;
  }
}

function normalizePath(path: string): string {
  return resolve(path).replace(/\\/g, '/');
}

export function resolveMainRepoRoot(root: string): string {
  try {
    const commonDir = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return resolve(dirname(commonDir));
  } catch {
    return resolve(root);
  }
}

export function listRegisteredWorktrees(root: string): Array<{ path: string; branch: string | null }> {
  let raw = '';
  try {
    raw = git(root, ['worktree', 'list', '--porcelain']);
  } catch {
    return [];
  }
  const out: Array<{ path: string; branch: string | null }> = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  const flush = () => {
    if (currentPath) out.push({ path: currentPath, branch: currentBranch });
    currentPath = null;
    currentBranch = null;
  };
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      flush();
      currentPath = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      currentBranch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
  }
  flush();
  return out;
}

export function findRegisteredWorktreeForBranch(root: string, branch: string): string | null {
  const normalizedBranch = branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
  const registered = listRegisteredWorktrees(root).find(entry => entry.branch === normalizedBranch);
  return registered?.path ?? null;
}

export function resolveMainBranchWorktree(root: string, integrationBranch?: string): string {
  const canonicalRoot = resolveMainRepoRoot(root);
  if (integrationBranch) {
    const registered = findRegisteredWorktreeForBranch(canonicalRoot, integrationBranch);
    if (registered) return resolve(registered);
  }
  const baseline = resolveRepositoryBaseline(canonicalRoot);
  const ref = baseline?.ref ?? '';
  const localBranch = ref.startsWith('refs/heads/')
    ? ref.slice('refs/heads/'.length)
    : ref.startsWith('refs/remotes/')
      ? ref.split('/').slice(3).join('/')
      : ref;
  const target = localBranch ? findRegisteredWorktreeForBranch(canonicalRoot, localBranch) : null;
  if (target) return resolve(target);
  const primary = listRegisteredWorktrees(canonicalRoot).find(entry => entry.branch && !entry.branch.startsWith('story/'));
  return resolve(primary?.path ?? canonicalRoot);
}

export function storyWorktreePath(root: string, storyId: string): string {
  const cfg = loadConfig(root);
  return join(root, cfg.worktreeDir || '.worktrees', storyId);
}

export function findStoryWorktreePath(root: string, storyId: string, branch: string): string | null {
  const registered = listRegisteredWorktrees(root).find(entry => entry.branch === branch);
  if (registered) return registered.path;
  const configured = storyWorktreePath(root, storyId);
  return existsSync(configured) ? configured : null;
}

export function isSafeStoryWorktreePath(root: string, storyId: string, target: string): boolean {
  const expected = storyWorktreePath(root, storyId);
  return normalizePath(target) === normalizePath(expected) && basename(target) === storyId;
}

export function detectPartialDoneStories(root: string, store: StoryStore): PartialDoneStory[] {
  const mainRepoRoot = resolveMainRepoRoot(root);
  const partial: PartialDoneStory[] = [];
  const storyBranches = listStoryBranches(mainRepoRoot);
  const existingBranches = storyBranches === null ? null : new Set(storyBranches);
  const branchStoryIds = (storyBranches ?? []).map(branch => branch.slice('story/'.length));
  const storyIds = [...new Set([...store.listStoryIds(), ...branchStoryIds])].sort();
  for (const storyId of storyIds) {
    const branch = `story/${storyId}`;
    // Enumeration already proves absent refs need no per-Story Git process.
    // Keep a live check for candidates that existed at this scan's snapshot;
    // newly created refs are discovered by the next scan, never a cached list.
    // If enumeration failed, preserve the stored-ID fallback instead of
    // interpreting unavailable branch information as an empty repository.
    if (existingBranches !== null && !existingBranches.has(branch)) continue;
    const branchExists = gitSucceeds(mainRepoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (!branchExists) continue;
    const branchStory = readStoryFromBranch(mainRepoRoot, store.storyDirRel(), branch, storyId);
    if (branchStory?.phase !== 'DONE') continue;
    const doneStory = branchStory;
    const integrationTarget = resolveStoryIntegrationTarget(mainRepoRoot, doneStory);
    const integrationBranch = integrationTarget?.parentBranch;
    const worktreePath = findStoryWorktreePath(mainRepoRoot, storyId, branch);
    const registered = listRegisteredWorktrees(mainRepoRoot).some(entry =>
      entry.branch === branch || (worktreePath ? normalizePath(entry.path) === normalizePath(worktreePath) : false),
    );
    const worktreeExists = worktreePath ? existsSync(worktreePath) : false;
    if (!integrationBranch) {
      partial.push({
        storyId,
        title: doneStory.title,
        branch,
        worktreePath,
        branchExists,
        branchMergedToMain: false,
        worktreeRegistered: registered,
        worktreeExists,
        mergeTreeClean: false,
        recoverCommand: `proof-or-stop done_recover --storyId=${storyId}`,
        reason: 'story is phase=DONE but its integration target cannot be resolved; automatic recovery is refused',
      });
      continue;
    }
    const branchMergedToMain = gitSucceeds(mainRepoRoot, ['merge-base', '--is-ancestor', branch, integrationBranch]);
    if (branchMergedToMain) continue;
    const mergeTreeClean = gitSucceeds(mainRepoRoot, ['merge-tree', '--write-tree', integrationBranch, branch]);
    partial.push({
      storyId,
      title: doneStory.title,
      branch,
      worktreePath,
      branchExists,
      branchMergedToMain,
      worktreeRegistered: registered,
      worktreeExists,
      mergeTreeClean,
      recoverCommand: `proof-or-stop done_recover --storyId=${storyId}`,
      reason: `story is phase=DONE but its story branch is not merged into ${integrationBranch}`,
    });
  }
  return partial.sort((a, b) => a.storyId.localeCompare(b.storyId));
}

function listStoryBranches(root: string): string[] | null {
  let raw = '';
  try {
    raw = git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/story']);
  } catch {
    return null;
  }
  return raw.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('story/'));
}

function readStoryFromBranch(root: string, storyDirRel: string, branch: string, storyId: string): StoryInfo | null {
  try {
    const raw = git(root, ['show', `${branch}:${storyDirRel}/${storyId}/index.json`]);
    return JSON.parse(raw) as StoryInfo;
  } catch {
    return null;
  }
}

function statusLinePath(line: string): string {
  const payload = line.slice(3).trim();
  const renamedTarget = payload.includes(' -> ') ? payload.split(' -> ').pop() || payload : payload;
  return renamedTarget.replace(/^"|"$/g, '');
}

function materialStatusLines(status: string): string[] {
  return status
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .filter(line => !isVolatileRuntimeArtifactPath(statusLinePath(line)));
}

export function assertMainWorktreeClean(root: string): void {
  const status = materialStatusLines(gitRaw(root, ['status', '--porcelain']));
  if (status.length > 0) {
    throw new Error(
      `done_recover refused: main worktree is not clean at "${resolve(root)}".\n${status.join('\n')}\n` +
      `→ cd "${resolve(root)}" && git stash (or commit/resolve these changes before retrying).`,
    );
  }
}

export function assertStoryWorktreeClean(worktreePath: string | null): void {
  if (!worktreePath || !existsSync(worktreePath)) return;
  const status = git(worktreePath, ['status', '--porcelain', '--untracked-files=all']);
  if (status.trim()) {
    throw new Error(
      `done_recover refused: story worktree is not clean.\n${status}\n` +
      `→ Preserve or remove these files before retrying; done_recover will not delete local worktree edits.`,
    );
  }
}

export function renderPartialDoneSummary(partial: PartialDoneStory[]): string[] {
  if (partial.length === 0) return ['  ✓ no partial-DONE stories found'];
  const lines = ['  Partial-DONE stories:'];
  for (const entry of partial) {
    const clean = entry.mergeTreeClean ? 'merge-tree clean' : 'merge-tree conflict';
    const wt = entry.worktreePath ? ` worktree=${entry.worktreePath}` : ' worktree=(none)';
    lines.push(`  - ${entry.storyId} ${entry.branch} [${clean}]${wt}`);
    lines.push(`    reason: ${entry.reason}`);
    lines.push(`    → ${entry.recoverCommand}`);
  }
  return lines;
}

export function removeStoryWorktree(root: string, storyId: string, worktreePath: string | null): string[] {
  const lines: string[] = [];
  if (!worktreePath) return lines;
  if (!isSafeStoryWorktreePath(root, storyId, worktreePath)) {
    throw new Error(`done_recover refused: unsafe worktree path for ${storyId}: ${worktreePath}`);
  }
  if (existsSync(worktreePath) || listRegisteredWorktrees(root).some(entry => normalizePath(entry.path) === normalizePath(worktreePath))) {
    try {
      git(root, ['worktree', 'remove', worktreePath]);
      lines.push(`✓ Worktree ${worktreePath} removed`);
    } catch {
      git(root, ['worktree', 'remove', '--force', worktreePath]);
      lines.push(`✓ Worktree ${worktreePath} force-removed`);
    }
  }
  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
    lines.push(`✓ Worktree directory residue removed`);
  }
  try {
    git(root, ['worktree', 'prune', '--expire', 'now']);
  } catch {
    // PROBE: prune is best-effort; the caller verifies final state through git/list scans.
  }
  return lines;
}
