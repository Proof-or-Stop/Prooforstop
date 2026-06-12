
import { StoryStore } from '../core/store.js';
import type { StoryPhase, StoryEvent } from '../core/types.js';
import { execSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { join, isAbsolute } from 'path';
import { randomBytes } from 'crypto';
import { gitProbe } from '../core/git-probe.js';
import { getStoryWorktreeRuntime, resolveLinkedWorktreePath } from '../core/worktree-runtime.js';
import { CWD_GATED_LIFECYCLE_PHASES, PHASE_EVENT_BY_TARGET } from '../core/lifecycle-registry.js';

export interface HandlerContext {
  store: StoryStore;
  root: string;
  scanRoot: string;
  /** Streaming log output (MCP environments use sendLoggingMessage, others use console.log) */
  log?: (msg: string) => void;
  /** Lazily retrieve all registered tool names (injected by tools.ts to avoid circular dependencies) */
  getAllToolNames?: () => Set<string>;
  /**
   * B-94a6: authority submission injection point. Production leaves these unset and
   * the verification evidence handlers resolve settings from env (off by default,
   * zero network). Tests inject `authoritySettings` + `authoritySubmitter` to drive
   * shadow / enforce / failure paths without a real network.
   */
  authoritySettings?: import('../core/authority-mode.js').AuthoritySettings;
  authoritySubmitter?: import('../core/authority-submit.js').AuthoritySubmitter;
  /** Test seam for autopilot executor command execution. Production uses the built-in argv runner. */
  autopilotCommandRunner?: import('../core/autopilot-executor.js').AutopilotCommandRunner;
  /**
   * Authority gate evaluator resolution options for `planner run --mode=authority
   * --until=DONE`. Production leaves this unset, so `resolveAuthorityGateEvaluator`
   * reads `process.env` + the real fetch and stays fail-closed (no server config ->
   * no evaluator -> the executor blocks with authority_gate_decision_receipt_required).
   * The M15 Natural-Language-To-DONE E2E injects `{ env, fetchImpl, now }` so the full
   * NL -> Story -> job -> provider -> validate -> evidence -> gate -> verified-receipt
   * -> authorityDone loop runs deterministically without a live Authority server.
   * Injecting it never relaxes the gate: a stub that does not return a verified native
   * gate_decision receipt still blocks exactly as production does.
   */
  authorityGateOptions?: import('../core/authority-client.js').AuthorityGateEvaluatorOptions;
}

const PHASE_TO_EVENT: Record<string, string> = { ...PHASE_EVENT_BY_TARGET };

export { PHASE_TO_EVENT };

export function collectContext(phase: StoryPhase, action: 'create' | 'advance' | 'discard'): StoryEvent {
  const event: StoryEvent = {
    phase,
    action,
    timestamp: new Date().toISOString(),
  };
  const branch = gitProbe('git rev-parse --abbrev-ref HEAD');
  if (branch.ok) event.branch = branch.output;
  const user = gitProbe('git config user.name');
  if (user.ok) event.user = user.output;
  event.sessionId = process.env.KOALA_SESSION_ID
    || process.env.CLAUDE_SESSION_ID
    || undefined;
  event.agent = process.env.KOALA_AGENT || 'main';
  return event;
}

/** PLAN ~ TEST phases must execute koala commands inside the worktree */
export const CWD_GATED_PHASES: Set<StoryPhase> = new Set(CWD_GATED_LIFECYCLE_PHASES);

/**
 * Check whether the current cwd is inside the story's worktree.
 * The caller is responsible for deciding "whether to check" (based on target phase, etc.); this function only compares cwd.
 * Provide remediation guidance when throwing.
 */
export function assertCwdInWorktree(store: StoryStore, storyId: string): void {
  let story;
  try {
    story = store.readStory(storyId);
  } catch {
    return; // story does not exist, skip
  }
  if (story.phase === 'DONE' || story.phase === 'DISCARDED') return;

  const cwd = process.cwd();
  const expectedAbsPath = resolveExpectedWorktreeRoot(store, storyId, cwd, story.worktree?.path);
  if (!expectedAbsPath) return;

  assertPathInsideWorktree(storyId, cwd, expectedAbsPath);
}

export interface StoryCommandWorkspace {
  cwd: string;
  contextRoot: string;
  snapshotRoot: string;
  expectedWorktreeRoot?: string;
  mode: 'story-worktree' | 'direct-review-project';
}

export function resolveStoryCommandWorkspace(
  store: StoryStore,
  storyId: string,
  contextRoot: string,
): StoryCommandWorkspace {
  const cwd = process.cwd();
  let storedWorktreePath = store.readStory(storyId).worktree?.path;
  if (!storedWorktreePath && canonicalPath(contextRoot) !== canonicalPath(cwd)) {
    try {
      storedWorktreePath = new StoryStore(cwd).readStory(storyId).worktree?.path;
    } catch { /* PROBE: cwd may be a subdir or unrelated workspace */ }
  }
  const expectedAbsPath = resolveExpectedWorktreeRoot(store, storyId, cwd, storedWorktreePath);
  if (!expectedAbsPath) {
    return {
      cwd,
      contextRoot,
      snapshotRoot: contextRoot,
      mode: 'direct-review-project',
    };
  }

  assertPathInsideWorktree(storyId, cwd, expectedAbsPath);

  const normalizedContextRoot = canonicalPath(contextRoot);
  const normalizedExpected = canonicalPath(expectedAbsPath);
  if (normalizedContextRoot !== normalizedExpected) {
    throw new Error(
      `review_run_start: refusing to create reviewer evidence for ${storyId} because the Lattice root and story worktree differ.\n` +
      `Expected signed workspace: ${normalizedExpected}\n` +
      `Lattice root: ${normalizedContextRoot}\n` +
      `Current cwd: ${cwd}\n` +
      'No reviewer run was created. Signing one workspace while persisting story metadata through another would produce invalid reviewer evidence.\n' +
      `→ cd ${normalizedExpected} and rerun lattice review_run_start without --root/LATTICE_PROJECT_ROOT pointing elsewhere.`
    );
  }

  return {
    cwd,
    contextRoot,
    snapshotRoot: normalizedExpected,
    expectedWorktreeRoot: normalizedExpected,
    mode: 'story-worktree',
  };
}

function resolveExpectedWorktreeRoot(
  store: StoryStore,
  storyId: string,
  cwd: string,
  storedWorktreePath?: string,
): string | null {
  let expectedAbsPath: string | null = null;
  let repoRoot = cwd;
  try {
    const runtime = getStoryWorktreeRuntime(storyId, store, cwd);
    expectedAbsPath = resolveLinkedWorktreePath(runtime);
    repoRoot = runtime.repoRoot;
  } catch { /* PROBE: fall back to stored story.worktree below */ }

  if (!expectedAbsPath && !storedWorktreePath) return null; // no worktree, skip (compatible with legacy stories)

  try {
    // Use git common-dir to find the MAIN repo root, not the worktree root.
    // From a linked worktree, --show-toplevel returns the worktree itself,
    // but worktree.path is stored relative to the main repo, so joining
    // ".worktrees/B-xxx" with itself produces a nested non-existent path.
    const commonDir = execSync('git rev-parse --git-common-dir', { cwd, encoding: 'utf-8' }).trim();
    const absCommonDir = isAbsolute(commonDir)
      ? commonDir
      : join(execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf-8' }).trim(), commonDir);
    if (absCommonDir.endsWith('/.git') || absCommonDir.endsWith('\\.git')) {
      repoRoot = absCommonDir.slice(0, -5);
    } else {
      repoRoot = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf-8' }).trim();
    }
  } catch { /* not git */ }

  if (!expectedAbsPath && storedWorktreePath) {
    expectedAbsPath = isAbsolute(storedWorktreePath)
      ? storedWorktreePath
      : join(repoRoot, storedWorktreePath);
  }
  return expectedAbsPath;
}

function assertPathInsideWorktree(storyId: string, cwd: string, expectedAbsPath: string): void {
  const normalizedCwd = canonicalPath(cwd);
  const normalizedExpected = canonicalPath(expectedAbsPath);
  if (normalizedCwd !== normalizedExpected && !normalizedCwd.startsWith(normalizedExpected + '/') && !normalizedCwd.startsWith(normalizedExpected + '\\')) {
    throw new Error(
      `Story ${storyId} must execute koala commands inside the worktree\n` +
      `Expected cwd: ${normalizedExpected}\n` +
      `Current cwd: ${cwd}\n` +
      `→ cd ${normalizedExpected}`
    );
  }
}

function canonicalPath(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

export function nextStoryId(store: StoryStore, prefix = 'B'): string {
  const existing = new Set(store.listStoryIds());
  for (let attempt = 0; attempt < 100; attempt++) {
    const hex = randomBytes(2).toString('hex'); // 4 chars, e.g. "a3f7"
    const id = `${prefix}-${hex}`;
    if (!existing.has(id)) return id;
  }
  // fallback: 6 chars for extreme collision cases
  return `${prefix}-${randomBytes(3).toString('hex')}`;
}
