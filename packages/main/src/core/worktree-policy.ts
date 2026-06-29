import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import type { JobPlan, PlannedStep, PlannerStoreLike } from './planner.js';

/**
 * @task B-e3d9
 * @checklist CHK-003
 * @title Link Authority worktree policy requirements to runtime enforcement
 * @type bugfix
 * @priority high
 * @description
 *   Runtime linkage for requiresAuthoritativeWorktree and requiresCleanWorktree:
 *   evaluateWorktreePreflight maps unresolved story worktrees to
 *   authoritative_worktree_unresolved and clean-worktree violations to
 *   dirty_worktree while preserving unrelated dirty changes.
 * @changes
 *   - [CHK-003] Connect requiresAuthoritativeWorktree to authoritative_worktree_unresolved preflight enforcement
 *   - [CHK-003] Connect requiresCleanWorktree to dirty_worktree preservation enforcement covered by worktree-policy-smoke
 */

/**
 * Runtime enforcement of a JobPlan `worktreePolicy` (§B2). This is the executor-side
 * gate that turns the planner-emitted, fail-closed worktree policy block into real
 * runtime behavior for M7 (provider executor scoped to the story worktree), M9
 * (safe stop on dirty/unsafe worktree), and M11 (end-to-end authority autopilot).
 *
 * Boundaries (kept deliberately narrow so local mode keeps working):
 *
 * - enforcement only runs for MUTATING provider steps (`provider.codex` /
 *   `provider.claude`). `provider.fake` is deterministic, fixtures-only, touches
 *   nothing, and is intentionally exempt — exactly as it is exempt from the
 *   provider policy in `planned-steps-executor.ts`;
 * - enforcement only runs when the JobPlan actually carries a `worktreePolicy`
 *   block. Legacy / synthetic plans without one keep their prior behavior. Real
 *   plans always carry one (`buildJobPlan` emits it and `assertJobPolicyConsistency`
 *   rejects a plan that omits it), so this never weakens a release-readiness run;
 * - the module is pure + deterministic with an injectable `GitRunner`, so smokes
 *   never have to shell out to a real git unless they want to.
 */

// --- Policy view + defensive normalization -----------------------------------

export interface WorktreePolicyView {
  resolver: 'lattice.story.resolve';
  requiresAuthoritativeWorktree: boolean;
  allowWorktreeRepair: boolean;
  allowedPathRoots: string[];
  forbiddenPathGlobs: string[];
  requiresCleanWorktree: boolean;
  preserveUnrelatedDirtyChanges: boolean;
  requireGitStatusEvidence: boolean;
}

/**
 * Conservative fail-closed defaults applied when a worktreePolicy is malformed but
 * present. Mirrors the planner's fail-closed emission: authoritative worktree
 * required, dirty changes preserved, git status evidence required, and the
 * story/fixture JSON globs forbidden.
 */
export const DEFAULT_FAIL_CLOSED_WORKTREE_POLICY: WorktreePolicyView = {
  resolver: 'lattice.story.resolve',
  requiresAuthoritativeWorktree: true,
  allowWorktreeRepair: false,
  allowedPathRoots: [],
  forbiddenPathGlobs: ['.lattice/story/**', 'docs/story/**', '**/tests/fixtures/**'],
  requiresCleanWorktree: false,
  preserveUnrelatedDirtyChanges: true,
  requireGitStatusEvidence: true,
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : [];
}

/** Defensive normalization (Handler encoding convention): never trust the raw shape. */
export function resolveWorktreePolicy(jobPlan: JobPlan): WorktreePolicyView {
  const raw = jobPlan.worktreePolicy;
  if (!raw || typeof raw !== 'object') return DEFAULT_FAIL_CLOSED_WORKTREE_POLICY;
  const d = DEFAULT_FAIL_CLOSED_WORKTREE_POLICY;
  const forbidden = stringArray(raw.forbiddenPathGlobs);
  return {
    resolver: 'lattice.story.resolve',
    requiresAuthoritativeWorktree: raw.requiresAuthoritativeWorktree !== false,
    allowWorktreeRepair: raw.allowWorktreeRepair === true,
    allowedPathRoots: stringArray(raw.allowedPathRoots),
    // Forbidden globs are a floor, not a ceiling: a plan may add globs but never
    // drop the story/fixture JSON protections.
    forbiddenPathGlobs: Array.from(new Set([...d.forbiddenPathGlobs, ...forbidden])),
    requiresCleanWorktree: raw.requiresCleanWorktree === true,
    preserveUnrelatedDirtyChanges: raw.preserveUnrelatedDirtyChanges !== false,
    requireGitStatusEvidence: raw.requireGitStatusEvidence !== false,
  };
}

/** Only real provider steps mutate the worktree. `provider.fake` is fixtures-only. */
export function isMutatingStepType(type: PlannedStep['type']): boolean {
  return type === 'provider.codex' || type === 'provider.claude';
}

// --- Authoritative worktree resolution ---------------------------------------

export interface WorktreeResolution {
  storyId: string;
  /** The cwd a mutating step must run in (story worktree, else project root). */
  authoritativeCwd: string;
  worktreeConfigured: boolean;
  worktreePath: string | null;
  phase: string | null;
  /** False when the story does not exist. */
  resolved: boolean;
  reason?: string;
}

/**
 * Resolve the authoritative story worktree cwd. This mirrors the read-only
 * `lattice story resolve` contract (story.worktree.path resolved against root,
 * falling back to the project root) so the executor and the operator command agree
 * on where provider work runs.
 */
export function resolveAuthoritativeWorktree(
  store: PlannerStoreLike,
  storyId: string,
  root: string,
): WorktreeResolution {
  if (!store.storyExists(storyId)) {
    return { storyId, authoritativeCwd: root, worktreeConfigured: false, worktreePath: null, phase: null, resolved: false, reason: 'story_not_found' };
  }
  let phase: string | null = null;
  let worktreePath: string | null = null;
  try {
    const story = store.readStory(storyId);
    phase = typeof story.phase === 'string' ? story.phase : null;
    const raw = story.worktree?.path;
    if (typeof raw === 'string' && raw.trim() !== '') {
      worktreePath = isAbsolute(raw) ? raw : join(root, raw);
    }
  } catch {
    return { storyId, authoritativeCwd: root, worktreeConfigured: false, worktreePath: null, phase: null, resolved: false, reason: 'story_unreadable' };
  }
  return {
    storyId,
    authoritativeCwd: worktreePath ?? root,
    worktreeConfigured: worktreePath !== null,
    worktreePath,
    phase,
    resolved: true,
  };
}

// --- Git status evidence ------------------------------------------------------

export interface GitStatusEntry {
  /** Two-char porcelain status code (e.g. " M", "??", "A "). */
  code: string;
  /** Repo-relative path (post-rename target for renames). */
  path: string;
}

export interface GitStatusEvidence {
  captured: boolean;
  clean: boolean;
  entries: GitStatusEntry[];
  digest: string;
  reason?: string;
}

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
  spawnError: boolean;
}

export type GitRunner = (cwd: string, args: string[]) => GitRunResult;

/** Production git runner. Never throws — a missing binary / non-repo is fail-soft. */
export const defaultGitRunner: GitRunner = (cwd, args) => {
  try {
    const proc = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const err = proc.error as NodeJS.ErrnoException | undefined;
    return {
      code: typeof proc.status === 'number' ? proc.status : -1,
      stdout: proc.stdout ?? '',
      stderr: proc.stderr ?? '',
      spawnError: !!err && err.code === 'ENOENT',
    };
  } catch {
    return { code: -1, stdout: '', stderr: '', spawnError: true };
  }
};

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function parsePorcelain(stdout: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3);
    // Rename / copy lines are "orig -> new"; the new path is what now exists.
    const arrow = path.indexOf(' -> ');
    if (arrow >= 0) path = path.slice(arrow + 4);
    path = path.trim().replace(/^"(.*)"$/, '$1');
    if (path) entries.push({ code, path });
  }
  return entries;
}

/**
 * Capture `git status --porcelain` as structured evidence. Fail-soft: a missing
 * git binary or a non-repository cwd yields `captured:false` (the preflight then
 * decides whether that is a hard block per `requireGitStatusEvidence`).
 */
export function captureGitStatus(cwd: string, run: GitRunner): GitStatusEvidence {
  const res = run(cwd, ['status', '--porcelain', '--untracked-files=all']);
  if (res.spawnError || res.code !== 0) {
    return { captured: false, clean: false, entries: [], digest: '', reason: res.spawnError ? 'git_unavailable' : 'git_status_failed' };
  }
  const entries = parsePorcelain(res.stdout);
  return { captured: true, clean: entries.length === 0, entries, digest: sha256(entries) };
}

// --- Forbidden path glob matching --------------------------------------------

function normalizePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Minimal glob → RegExp: `**` crosses path separators, `*` does not. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // a/**/b matches a/b
      } else {
        re += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** Returns the first forbidden glob the path matches, or null. */
export function matchesForbiddenGlob(path: string, globs: string[]): string | null {
  const normalized = normalizePath(path);
  for (const glob of globs) {
    if (globToRegExp(glob).test(normalized)) return glob;
  }
  return null;
}

function withinAnyRoot(path: string, roots: string[]): boolean {
  const normalized = normalizePath(path);
  return roots.some(root => {
    const r = normalizePath(root).replace(/\/+$/, '');
    return r === '' || normalized === r || normalized.startsWith(r + '/');
  });
}

/**
 * Partition dirty entries into "related" (inside an allowed path root) vs
 * "unrelated". With no allowed roots declared everything is unrelated — those are
 * the changes `preserveUnrelatedDirtyChanges` protects.
 */
export function partitionDirtyEntries(
  entries: GitStatusEntry[],
  allowedPathRoots: string[],
): { related: GitStatusEntry[]; unrelated: GitStatusEntry[] } {
  if (allowedPathRoots.length === 0) return { related: [], unrelated: entries };
  const related: GitStatusEntry[] = [];
  const unrelated: GitStatusEntry[] = [];
  for (const entry of entries) (withinAnyRoot(entry.path, allowedPathRoots) ? related : unrelated).push(entry);
  return { related, unrelated };
}

// --- Preflight + postflight enforcement --------------------------------------

export type WorktreeStopReason =
  | 'authoritative_worktree_unresolved'
  | 'git_status_evidence_unavailable'
  | 'dirty_worktree'
  | 'forbidden_path_glob';

export interface WorktreePreflightResult {
  ok: boolean;
  reason?: WorktreeStopReason;
  summary: Record<string, unknown>;
}

/** Declared paths a step says it will touch (explicit arrays + path-like argv). */
export function declaredStepPaths(step: PlannedStep): string[] {
  const out = new Set<string>();
  for (const key of ['paths', 'touchesPaths', 'files']) {
    for (const p of stringArray((step.args as Record<string, unknown>)[key])) out.add(p);
  }
  // argv entries that already look like a forbidden path are a strong signal.
  for (const a of stringArray((step.args as Record<string, unknown>).argv)) {
    if (a.includes('/') && !a.startsWith('-')) out.add(a);
  }
  return [...out];
}

export interface WorktreePreflightInput {
  policy: WorktreePolicyView;
  resolution: WorktreeResolution;
  gitStatus: GitStatusEvidence;
  step: PlannedStep;
}

/**
 * Run the worktree preflight BEFORE a mutating provider step spawns. Fails closed
 * (ok:false + a stop reason) on: an unresolved authoritative worktree, missing git
 * status evidence when required, a dirty worktree when the step/policy requires a
 * clean one, or a step that declares it will edit a forbidden path.
 */
export function evaluateWorktreePreflight(input: WorktreePreflightInput): WorktreePreflightResult {
  const { policy, resolution, gitStatus, step } = input;
  const requiresClean = step.requiresCleanWorktree === true || policy.requiresCleanWorktree === true;
  const dirty = partitionDirtyEntries(gitStatus.entries, policy.allowedPathRoots);
  const baseSummary: Record<string, unknown> = {
    worktreeEnforced: true,
    authoritativeCwd: resolution.authoritativeCwd,
    worktreeConfigured: resolution.worktreeConfigured,
    requiresCleanWorktree: requiresClean,
    preserveUnrelatedDirtyChanges: policy.preserveUnrelatedDirtyChanges,
    gitStatusCaptured: gitStatus.captured,
    gitStatusClean: gitStatus.clean,
    gitStatusDigest: gitStatus.digest,
    dirtyEntryCount: gitStatus.entries.length,
    unrelatedDirtyCount: dirty.unrelated.length,
    relatedDirtyCount: dirty.related.length,
  };

  // 1. Authoritative worktree must resolve when the policy requires it.
  if (policy.requiresAuthoritativeWorktree && (!resolution.resolved || !resolution.worktreeConfigured)) {
    return {
      ok: false,
      reason: 'authoritative_worktree_unresolved',
      summary: {
        ...baseSummary,
        resolverContract: 'lattice.story.resolve',
        resolved: resolution.resolved,
        note: resolution.resolved
          ? 'authority mode requires an authoritative story worktree; create it via lattice story_advance --phase=INIT_CHECK'
          : `story ${resolution.storyId} did not resolve (${resolution.reason ?? 'unknown'})`,
      },
    };
  }

  // 2. Git status evidence is mandatory for mutating steps when the policy says so.
  if (policy.requireGitStatusEvidence && !gitStatus.captured) {
    return {
      ok: false,
      reason: 'git_status_evidence_unavailable',
      summary: {
        ...baseSummary,
        note: `git status evidence is required before a mutating step but could not be captured (${gitStatus.reason ?? 'unknown'})`,
      },
    };
  }

  // 3. A step that declares it will edit a forbidden path is rejected before spawn.
  for (const path of declaredStepPaths(step)) {
    const glob = matchesForbiddenGlob(path, policy.forbiddenPathGlobs);
    if (glob) {
      return {
        ok: false,
        reason: 'forbidden_path_glob',
        summary: { ...baseSummary, offendingPath: path, matchedGlob: glob, phase: 'preflight', note: 'planned step declares it will edit a forbidden path (story/fixture JSON or other protected glob)' },
      };
    }
  }

  // 4. Dirty worktree + clean requirement → stop safely (preserves, never clobbers).
  if (requiresClean && gitStatus.captured && !gitStatus.clean) {
    return {
      ok: false,
      reason: 'dirty_worktree',
      summary: {
        ...baseSummary,
        dirtyEntries: gitStatus.entries.slice(0, 50),
        note: dirty.unrelated.length > 0
          ? 'worktree has unrelated dirty changes and this step requires a clean worktree; preserving the changes and stopping instead of discarding them'
          : 'worktree is dirty and this step requires a clean worktree; resolve the pending changes before rerunning',
      },
    };
  }

  return { ok: true, summary: baseSummary };
}

/**
 * After a mutating step, diff the before/after git status and reject if the step
 * INTRODUCED a change to a forbidden path (e.g. a provider edited story/fixture
 * JSON). Pre-existing forbidden dirt is handled by the clean-worktree preflight.
 */
export function evaluateForbiddenEdits(
  before: GitStatusEvidence,
  after: GitStatusEvidence,
  forbiddenPathGlobs: string[],
): WorktreePreflightResult {
  if (!after.captured) return { ok: true, summary: { worktreePostCheck: 'skipped', reason: after.reason ?? 'after_status_uncaptured' } };
  const beforePaths = new Set(before.entries.map(e => e.path));
  const introduced: Array<{ path: string; glob: string }> = [];
  for (const entry of after.entries) {
    if (beforePaths.has(entry.path)) continue; // pre-existing dirt, not introduced here
    const glob = matchesForbiddenGlob(entry.path, forbiddenPathGlobs);
    if (glob) introduced.push({ path: entry.path, glob });
  }
  if (introduced.length > 0) {
    return {
      ok: false,
      reason: 'forbidden_path_glob',
      summary: {
        phase: 'postflight',
        introducedForbiddenPaths: introduced,
        gitStatusBeforeDigest: before.digest,
        gitStatusAfterDigest: after.digest,
        note: 'the executed step introduced edits to a forbidden path; story/fixture JSON must be changed through Proofbound commands, never edited directly',
      },
    };
  }
  return { ok: true, summary: { worktreePostCheck: 'clean', gitStatusAfterDigest: after.digest } };
}

// --- Fail-closed stop summary -------------------------------------------------

export interface WorktreeStopSummary {
  schemaVersion: 'lattice.worktree_stop_summary.v1';
  storyId: string;
  stepId: string;
  stopReason: WorktreeStopReason;
  authoritativeCwd: string;
  gitStatusBeforeDigest: string;
  gitStatusAfterDigest: string | null;
  detail: Record<string, unknown>;
  nextAction: string;
}

const WORKTREE_NEXT_ACTION: Record<WorktreeStopReason, string> = {
  authoritative_worktree_unresolved: 'Resolve the authoritative story worktree (lattice story resolve / lattice story_advance --phase=INIT_CHECK) before running provider work in authority mode.',
  git_status_evidence_unavailable: 'Run the executor inside the story git worktree so git status evidence can be captured before mutating steps.',
  dirty_worktree: 'Commit, stash, or resolve the pending worktree changes (unrelated dirty changes are preserved, not discarded), then rerun.',
  forbidden_path_glob: 'Stop editing story/fixture JSON or other forbidden paths directly; route those changes through Proofbound commands.',
};

/** Build the printable / uploadable fail-closed stop summary for a worktree block. */
export function buildWorktreeStopSummary(args: {
  storyId: string;
  stepId: string;
  stopReason: WorktreeStopReason;
  authoritativeCwd: string;
  gitStatusBefore: GitStatusEvidence;
  gitStatusAfter?: GitStatusEvidence | null;
  detail: Record<string, unknown>;
}): WorktreeStopSummary {
  return {
    schemaVersion: 'lattice.worktree_stop_summary.v1',
    storyId: args.storyId,
    stepId: args.stepId,
    stopReason: args.stopReason,
    authoritativeCwd: args.authoritativeCwd,
    gitStatusBeforeDigest: args.gitStatusBefore.digest,
    gitStatusAfterDigest: args.gitStatusAfter?.digest ?? null,
    detail: args.detail,
    nextAction: WORKTREE_NEXT_ACTION[args.stopReason],
  };
}

export function renderWorktreeStopSummary(summary: WorktreeStopSummary): string {
  return [
    `Proofbound worktree stop (${summary.schemaVersion})`,
    `storyId: ${summary.storyId}`,
    `stepId: ${summary.stepId}`,
    `stopReason: ${summary.stopReason}`,
    `authoritativeCwd: ${summary.authoritativeCwd}`,
    `gitStatusBeforeDigest: ${summary.gitStatusBeforeDigest || '(uncaptured)'}`,
    `gitStatusAfterDigest: ${summary.gitStatusAfterDigest ?? '(n/a)'}`,
    `nextAction: ${summary.nextAction}`,
  ].join('\n');
}

export const WORKTREE_STOP_REASONS: readonly WorktreeStopReason[] = [
  'authoritative_worktree_unresolved',
  'git_status_evidence_unavailable',
  'dirty_worktree',
  'forbidden_path_glob',
] as const;
