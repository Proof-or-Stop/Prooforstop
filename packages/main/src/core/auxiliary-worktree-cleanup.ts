import { execFileSync } from 'child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { loadConfig } from './config.js';
import type { StoryStore } from './store.js';
import { getRepoRoot, listGitWorktrees } from './worktree-runtime.js';
import { withMainWriteLock } from './main-write-lock.js';

export type AuxiliaryCleanupState = 'safe-cleanup' | 'dirty-worktree' | 'missing-from-main' | 'unknown';

export interface AuxiliaryWorktreeCandidate {
  storyId: string;
  branch: string | null;
  head: string | null;
  worktreePath: string | null;
  sources: Array<'branch' | 'path' | 'registered-worktree'>;
}

export interface AuxiliaryWorktreeClassification extends AuxiliaryWorktreeCandidate {
  state: AuxiliaryCleanupState;
  reason: string;
  statusOutput: string;
  cherryOutput: string;
  rightOnlyOutput: string;
}

export interface AuxiliaryCleanupResult {
  before: AuxiliaryWorktreeClassification;
  after?: AuxiliaryWorktreeClassification;
  cleaned: boolean;
  actions: string[];
}

type StoreLike = Pick<StoryStore, 'appendProcessEvent' | 'listStoryIds'>;

function git(root: string, args: string[], cwd = root): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function gitSafe(root: string, args: string[], cwd = root): { ok: true; output: string } | { ok: false; output: string } {
  try {
    return { ok: true, output: git(root, args, cwd) };
  } catch (e: any) {
    return { ok: false, output: String(e?.stderr || e?.stdout || e?.message || e).trim() };
  }
}

function normalizePath(path: string): string {
  return resolve(path).replace(/\\/g, '/');
}

function isInsidePath(child: string, parent: string): boolean {
  const childNorm = normalizePath(child);
  const parentNorm = normalizePath(parent);
  return childNorm === parentNorm || childNorm.startsWith(parentNorm.endsWith('/') ? parentNorm : `${parentNorm}/`);
}

function toRepoRelative(repoRoot: string, path: string): string {
  return relative(repoRoot, path).replace(/\\/g, '/');
}

function worktreeBase(root: string): string {
  const repoRoot = getRepoRoot(root);
  const cfg = loadConfig(root);
  return resolve(repoRoot, cfg.worktreeDir || '.worktrees');
}

function readStoryIds(store: StoreLike, storyIds?: string[]): string[] {
  if (storyIds) return storyIds;
  try {
    return store.listStoryIds().filter((id) => /^B-[A-Za-z0-9]+$/.test(id));
  } catch {
    return [];
  }
}

function isAllowedStoryId(storyId: string, storyIds: string[], restrictToStoryIds: boolean): boolean {
  return !restrictToStoryIds || storyIds.includes(storyId);
}

function inferredStoryIdFromBranch(branch: string): string | null {
  return (
    /^codex\/(B-[A-Za-z0-9]+)-/.exec(branch)?.[1]
    ?? /^story\/(B-[A-Za-z0-9]+)-agent-/.exec(branch)?.[1]
    ?? /^(B-[A-Za-z0-9]+)-agent-/.exec(branch)?.[1]
    ?? null
  );
}

function matchStoryFromBranch(branch: string, storyIds: string[], restrictToStoryIds: boolean): string | null {
  const inferred = inferredStoryIdFromBranch(branch);
  if (inferred && isAllowedStoryId(inferred, storyIds, restrictToStoryIds)) return inferred;
  for (const storyId of storyIds) {
    if (branch.startsWith(`codex/${storyId}-`)) return storyId;
    if (branch.startsWith(`story/${storyId}-agent-`)) return storyId;
    if (branch.startsWith(`${storyId}-agent-`)) return storyId;
  }
  return null;
}

function inferredStoryIdFromPathSegments(segments: string[]): string | null {
  const name = segments[segments.length - 1] ?? '';
  if (segments.length === 2 && segments[0] === 'codex') {
    return /^(B-[A-Za-z0-9]+)-/.exec(name)?.[1] ?? null;
  }
  return (
    /^(B-[A-Za-z0-9]+)-agent-/.exec(name)?.[1]
    ?? /^(B-[A-Za-z0-9]+)-codex-/.exec(name)?.[1]
    ?? null
  );
}

function matchStoryFromPathSegments(segments: string[], storyIds: string[], restrictToStoryIds: boolean): string | null {
  const inferred = inferredStoryIdFromPathSegments(segments);
  if (inferred && isAllowedStoryId(inferred, storyIds, restrictToStoryIds)) return inferred;
  const name = segments[segments.length - 1] ?? '';
  for (const storyId of storyIds) {
    if (name.startsWith(`${storyId}-agent-`) || name.startsWith(`${storyId}-codex-`)) return storyId;
    if (segments.length === 2 && segments[0] === 'codex' && name.startsWith(`${storyId}-`)) return storyId;
  }
  return null;
}

function pushSource(candidate: AuxiliaryWorktreeCandidate, source: AuxiliaryWorktreeCandidate['sources'][number]): void {
  if (!candidate.sources.includes(source)) candidate.sources.push(source);
}

function candidateKey(storyId: string, branch: string | null, head: string | null, worktreePath: string | null): string {
  if (branch) return `${storyId}:branch:${branch}`;
  if (head && worktreePath) return `${storyId}:detached:${head}:${normalizePath(worktreePath)}`;
  return `${storyId}:path:${worktreePath ? normalizePath(worktreePath) : '(none)'}`;
}

export function discoverAuxiliaryWorktreeCandidates(
  root: string,
  store: StoreLike,
  options: { storyIds?: string[] } = {},
): AuxiliaryWorktreeCandidate[] {
  const repoRoot = getRepoRoot(root);
  const base = worktreeBase(root);
  const storyIds = readStoryIds(store, options.storyIds);
  const restrictToStoryIds = Boolean(options.storyIds);
  const linked = listGitWorktrees(repoRoot);
  const linkedByBranch = new Map<string, { branch: string; head: string | null; path: string }>();
  const linkedByPath = new Map<string, { branch: string | null; head: string | null; path: string }>();
  for (const entry of linked) {
    if (entry.branch) linkedByBranch.set(entry.branch, { branch: entry.branch, head: entry.head, path: entry.path });
    linkedByPath.set(normalizePath(entry.path), { branch: entry.branch, head: entry.head, path: entry.path });
  }

  const candidates = new Map<string, AuxiliaryWorktreeCandidate>();
  const upsert = (
    storyId: string,
    branch: string | null,
    head: string | null,
    worktreePath: string | null,
    source: AuxiliaryWorktreeCandidate['sources'][number],
  ) => {
    const key = candidateKey(storyId, branch, head, worktreePath);
    const existing = candidates.get(key);
    if (existing) {
      if (!existing.worktreePath && worktreePath) existing.worktreePath = worktreePath;
      if (!existing.branch && branch) existing.branch = branch;
      if (!existing.head && head) existing.head = head;
      pushSource(existing, source);
      return;
    }
    candidates.set(key, { storyId, branch, head, worktreePath, sources: [source] });
  };

  const branchRaw = gitSafe(repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (branchRaw.ok) {
    for (const branch of branchRaw.output.split('\n').map((line) => line.trim()).filter(Boolean)) {
      const storyId = matchStoryFromBranch(branch, storyIds, restrictToStoryIds);
      if (!storyId) continue;
      const linkedEntry = linkedByBranch.get(branch);
      upsert(storyId, branch, linkedEntry?.head ?? null, linkedEntry?.path ?? null, 'branch');
    }
  }

  if (existsSync(base)) {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directPath = join(base, entry.name);
      const maybeAdd = (path: string, segments: string[]) => {
        const storyId = matchStoryFromPathSegments(segments, storyIds, restrictToStoryIds);
        if (!storyId) return;
        const linkedEntry = linkedByPath.get(normalizePath(path)) ?? null;
        upsert(
          storyId,
          linkedEntry?.branch ?? null,
          linkedEntry?.head ?? null,
          linkedEntry?.path ?? path,
          linkedEntry ? 'registered-worktree' : 'path',
        );
      };
      maybeAdd(directPath, [entry.name]);
      if (entry.name === 'codex') {
        for (const nested of readdirSync(directPath, { withFileTypes: true })) {
          if (!nested.isDirectory()) continue;
          maybeAdd(join(directPath, nested.name), [entry.name, nested.name]);
        }
      }
    }
  }

  return [...candidates.values()].sort((a, b) =>
    `${a.storyId}:${a.branch ?? ''}:${a.worktreePath ?? ''}`.localeCompare(`${b.storyId}:${b.branch ?? ''}:${b.worktreePath ?? ''}`),
  );
}

function readCandidateHead(root: string, candidate: AuxiliaryWorktreeCandidate): string | null {
  if (candidate.head) return candidate.head;
  if (candidate.worktreePath) {
    const head = gitSafe(getRepoRoot(root), ['rev-parse', 'HEAD'], candidate.worktreePath);
    if (head.ok && head.output) return head.output;
  }
  if (candidate.branch) {
    const head = gitSafe(getRepoRoot(root), ['rev-parse', `refs/heads/${candidate.branch}`]);
    if (head.ok && head.output) return head.output;
  }
  return null;
}

function patchState(root: string, target: string): {
  state: 'safe-cleanup' | 'missing-from-main' | 'unknown';
  reason: string;
  cherryOutput: string;
  rightOnlyOutput: string;
} {
  const repoRoot = getRepoRoot(root);
  const exists = gitSafe(repoRoot, ['rev-parse', '--verify', target]);
  if (!exists.ok) {
    return { state: 'unknown', reason: `git target does not exist: ${target}`, cherryOutput: '', rightOnlyOutput: exists.output };
  }
  const rightOnly = gitSafe(repoRoot, ['log', '--cherry-pick', '--right-only', '--oneline', `main...${target}`]);
  if (!rightOnly.ok) {
    return { state: 'unknown', reason: 'git log --cherry-pick failed', cherryOutput: '', rightOnlyOutput: rightOnly.output };
  }
  const cherry = gitSafe(repoRoot, ['cherry', 'main', target]);
  if (!cherry.ok) {
    return { state: 'unknown', reason: 'git cherry failed', cherryOutput: cherry.output, rightOnlyOutput: rightOnly.output };
  }
  const rightOnlyMissing = rightOnly.output.trim().length > 0;
  const cherryMissing = cherry.output.split('\n').some((line) => line.trim().startsWith('+'));
  if (rightOnlyMissing !== cherryMissing) {
    return {
      state: 'unknown',
      reason: 'patch-equivalence probes disagree',
      cherryOutput: cherry.output,
      rightOnlyOutput: rightOnly.output,
    };
  }
  if (rightOnlyMissing) {
    return {
      state: 'missing-from-main',
      reason: 'branch has non-equivalent patches missing from main',
      cherryOutput: cherry.output,
      rightOnlyOutput: rightOnly.output,
    };
  }
  return {
    state: 'safe-cleanup',
    reason: 'worktree is clean and patch content is already present on main',
    cherryOutput: cherry.output,
    rightOnlyOutput: rightOnly.output,
  };
}

export function classifyAuxiliaryWorktreeCandidate(
  root: string,
  candidate: AuxiliaryWorktreeCandidate,
): AuxiliaryWorktreeClassification {
  const repoRoot = getRepoRoot(root);
  const base = worktreeBase(root);
  const empty = { statusOutput: '', cherryOutput: '', rightOnlyOutput: '' };

  if (!candidate.worktreePath) {
    return { ...candidate, state: 'unknown', reason: 'candidate branch has no linked worktree path', ...empty };
  }

  const path = resolve(candidate.worktreePath);
  if (!isInsidePath(path, base)) {
    return { ...candidate, state: 'unknown', reason: `worktree path is outside configured worktree root: ${path}`, ...empty };
  }
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) {
      return { ...candidate, state: 'unknown', reason: `worktree path is not a directory: ${path}`, ...empty };
    }
  } catch {
    return { ...candidate, state: 'unknown', reason: `worktree path does not exist: ${path}`, ...empty };
  }

  const status = gitSafe(repoRoot, ['status', '--porcelain', '-uall'], path);
  if (!status.ok) {
    return { ...candidate, state: 'unknown', reason: 'git status failed for candidate worktree', statusOutput: status.output, cherryOutput: '', rightOnlyOutput: '' };
  }
  if (status.output.trim()) {
    return { ...candidate, state: 'dirty-worktree', reason: 'candidate worktree has material changes', statusOutput: status.output, cherryOutput: '', rightOnlyOutput: '' };
  }

  const target = candidate.branch ? `refs/heads/${candidate.branch}` : readCandidateHead(root, candidate);
  if (!target) {
    return { ...candidate, state: 'unknown', reason: 'candidate has no branch or readable HEAD', statusOutput: status.output, cherryOutput: '', rightOnlyOutput: '' };
  }
  const patch = patchState(root, target);
  return {
    ...candidate,
    state: patch.state,
    reason: patch.reason,
    statusOutput: status.output,
    cherryOutput: patch.cherryOutput,
    rightOnlyOutput: patch.rightOnlyOutput,
  };
}

export function scanAuxiliaryWorktreeResidues(
  root: string,
  store: StoreLike,
  options: { storyIds?: string[] } = {},
): AuxiliaryWorktreeClassification[] {
  return discoverAuxiliaryWorktreeCandidates(root, store, options)
    .map((candidate) => classifyAuxiliaryWorktreeCandidate(root, candidate));
}

function isRegisteredWorktree(root: string, worktreePath: string): boolean {
  const target = normalizePath(worktreePath);
  return listGitWorktrees(getRepoRoot(root)).some((entry) => normalizePath(entry.path) === target);
}

function removeWorktree(root: string, classification: AuxiliaryWorktreeClassification): string[] {
  const actions: string[] = [];
  const path = classification.worktreePath;
  if (!path) return actions;
  if (!existsSync(path) && !isRegisteredWorktree(root, path)) return actions;

  const repoRoot = getRepoRoot(root);
  try {
    git(repoRoot, ['worktree', 'remove', path]);
    actions.push(`worktree removed: ${path}`);
  } catch {
    const current = classifyAuxiliaryWorktreeCandidate(root, classification);
    if (current.state !== 'safe-cleanup') {
      throw new Error(`worktree remove refused after re-classification: ${current.state} ${current.reason}`);
    }
    git(repoRoot, ['worktree', 'remove', '--force', path]);
    actions.push(`worktree force-removed: ${path}`);
  }

  if (existsSync(path) && !isRegisteredWorktree(root, path)) {
    if (!isInsidePath(path, worktreeBase(root))) {
      throw new Error(`refusing residual directory removal outside worktree root: ${path}`);
    }
    rmSync(path, { recursive: true, force: true });
    actions.push(`worktree directory residue removed: ${path}`);
  }
  return actions;
}

function deleteBranch(root: string, branch: string): string[] {
  const repoRoot = getRepoRoot(root);
  try {
    git(repoRoot, ['branch', '-d', branch]);
    return [`branch deleted: ${branch}`];
  } catch {
    const ancestor = gitSafe(repoRoot, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, 'main']);
    if (ancestor.ok) {
      git(repoRoot, ['branch', '-D', branch]);
      return [`branch force-deleted after merge-base proof: ${branch}`];
    }
    const patch = patchState(root, `refs/heads/${branch}`);
    if (patch.state !== 'safe-cleanup') {
      throw new Error(`branch delete refused after patch re-check: ${patch.state} ${patch.reason}`);
    }
    git(repoRoot, ['branch', '-D', branch]);
    return [`branch force-deleted after patch-equivalence proof: ${branch}`];
  }
}

function appendCleanupEvent(store: StoreLike, classification: AuxiliaryWorktreeClassification, actions: string[]): void {
  try {
    if (!store.listStoryIds().includes(classification.storyId)) return;
    store.appendProcessEvent(classification.storyId, {
      type: 'auxiliary_worktree_cleanup',
      branch: classification.branch,
      worktreePath: classification.worktreePath,
      state: classification.state,
      reason: classification.reason,
      actions,
      cherryOutput: classification.cherryOutput,
      rightOnlyOutput: classification.rightOnlyOutput,
    });
  } catch {
    // Best-effort audit append; caller still reports the cleanup action.
  }
}

export function cleanupAuxiliaryWorktreeResidue(
  root: string,
  store: StoreLike,
  classification: AuxiliaryWorktreeClassification,
): AuxiliaryCleanupResult {
  const current = classifyAuxiliaryWorktreeCandidate(root, classification);
  if (current.state !== 'safe-cleanup') {
    return { before: current, after: current, cleaned: false, actions: [`skipped: ${current.state} ${current.reason}`] };
  }
  const actions = [
    ...removeWorktree(root, current),
    ...(current.branch ? deleteBranch(root, current.branch) : []),
  ];
  gitSafe(getRepoRoot(root), ['worktree', 'prune', '--expire', 'now']);
  appendCleanupEvent(store, current, actions);
  return { before: current, cleaned: true, actions };
}

export function cleanupAuxiliaryWorktreeResidues(
  root: string,
  store: StoreLike,
  options: { storyIds?: string[] } = {},
): AuxiliaryCleanupResult[] {
  return scanAuxiliaryWorktreeResidues(root, store, options)
    .map((classification) => cleanupAuxiliaryWorktreeResidue(root, store, classification));
}

export function repairAuxiliaryWorktreeResidues(
  root: string,
  store: StoreLike,
  options: { storyIds?: string[] } = {},
): AuxiliaryCleanupResult[] {
  const repoRoot = getRepoRoot(root);
  return withMainWriteLock(repoRoot, () =>
    cleanupAuxiliaryWorktreeResidues(root, store, options),
    { label: 'story_reconcile auxiliary worktree cleanup' },
  );
}

export function renderAuxiliaryClassification(root: string, classification: AuxiliaryWorktreeClassification): string {
  const rel = classification.worktreePath
    ? toRepoRelative(getRepoRoot(root), classification.worktreePath)
    : '(no worktree)';
  const branch = classification.branch ?? '(no branch)';
  const head = classification.head ? ` @${classification.head.slice(0, 12)}` : '';
  return `${classification.storyId} ${classification.state} ${branch}${head} -> ${rel} (${classification.reason})`;
}
