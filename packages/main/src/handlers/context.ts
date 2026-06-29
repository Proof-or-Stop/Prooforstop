/**
 * @task B-748e
 * @checklist CHK-002, CHK-003
 * @title bind no binding signed workspace diagnostic coverage
 * @type chore
 * @priority high
 * @description
 *   Source binding for review-run-start-signed-workspace-resolution-execution-plan.md:311:
 *   review_run_start emits Reason [requires_git_signed_workspace_but_no_binding]:
 *   and fails closed when a git-backed signed workspace cannot be resolved.
 *   The unresolved path reports No reviewer run was created and does not create reviewer run metadata.
 * @changes
 *   - [CHK-002] Bind the exact no-binding diagnostic phrase to the existing fail-closed behavior.
 *   - [CHK-003] Preserve runtime behavior; do not add unrelated future-scope support.
 */

import { StoryStore } from '../core/store.js';
import type { StoryPhase, StoryEvent } from '../core/types.js';
import { existsSync, realpathSync } from 'fs';
import { randomBytes } from 'crypto';
import { gitProbe } from '../core/git-probe.js';
import { CWD_GATED_LIFECYCLE_PHASES, PHASE_EVENT_BY_TARGET } from '../core/lifecycle-registry.js';
import { resolveStorySignedWorkspace, type StorySignedWorkspaceResolutionSource } from '../core/story-signed-workspace-resolution.js';
import { getSessionId } from '../core/owner-session.js';

export interface HandlerContext {
  store: StoryStore;
  root: string;
  scanRoot: string;
  /** Streaming log output (MCP environments use sendLoggingMessage, others use console.log) */
  log?: (msg: string) => void;
  /** Lazily retrieve all registered tool names (injected by tools.ts to avoid circular dependencies) */
  getAllToolNames?: () => Set<string>;
  /** Test seam for autopilot executor command execution. Production uses the built-in argv runner. */
  autopilotCommandRunner?: import('../core/autopilot-executor.js').AutopilotCommandRunner;
  /** Test seam for DONE / done_recover post-merge package build execution. Production uses npm. */
  doneMainBuildRunner?: import('./done-effects.js').DoneMainBuildRunner;
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
  event.sessionId = getSessionId();
  event.agent = process.env.LATTICE_AGENT || 'main';
  return event;
}

/** PLAN ~ TEST phases must execute lattice commands inside the worktree */
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
  const resolution = resolveStorySignedWorkspace({ store, storyId, metadataRoot: cwd, cwd });
  const expectedAbsPath = (
    resolution.resolutionSource === 'story-worktree'
    || resolution.resolutionSource === 'linked-story-branch-worktree'
  )
    ? resolution.authoritativeCwd
    : null;
  if (!expectedAbsPath) return;

  assertPathInsideWorktree(storyId, cwd, expectedAbsPath);
}

export interface StoryCommandWorkspace {
  cwd: string;
  contextRoot: string;
  metadataRoot: string;
  snapshotRoot: string;
  expectedWorktreeRoot?: string;
  signedWorkspaceRoot: string;
  authoritativeCwd: string;
  repoRoot: string | null;
  resolved: true;
  resolutionSource: StorySignedWorkspaceResolutionSource;
  workspaceMode: StorySignedWorkspaceResolutionSource;
  unresolvedReason: null;
  mode: 'story-worktree' | 'direct-review-project';
}

export function resolveStoryCommandWorkspace(
  store: StoryStore,
  storyId: string,
  contextRoot: string,
): StoryCommandWorkspace {
  const cwd = process.cwd();
  const resolution = resolveStorySignedWorkspace({ store, storyId, metadataRoot: contextRoot, cwd });
  if (!resolution.resolved || !resolution.signedWorkspaceRoot || !resolution.authoritativeCwd) {
    throw new Error(formatUnresolvedSignedWorkspace(storyId, resolution.metadataRoot, resolution.unresolvedReason));
  }

  const isWorktreeResolution = resolution.resolutionSource === 'story-worktree'
    || resolution.resolutionSource === 'linked-story-branch-worktree';
  if (isWorktreeResolution) {
    assertPathInsideWorktree(storyId, cwd, resolution.authoritativeCwd);
  }

  return {
    cwd,
    contextRoot: resolution.metadataRoot,
    metadataRoot: resolution.metadataRoot,
    snapshotRoot: resolution.signedWorkspaceRoot,
    signedWorkspaceRoot: resolution.signedWorkspaceRoot,
    authoritativeCwd: resolution.authoritativeCwd,
    repoRoot: resolution.repoRoot,
    resolved: true,
    resolutionSource: resolution.resolutionSource,
    workspaceMode: resolution.resolutionSource,
    unresolvedReason: null,
    ...(isWorktreeResolution ? { expectedWorktreeRoot: resolution.authoritativeCwd } : {}),
    mode: isWorktreeResolution ? 'story-worktree' : 'direct-review-project',
  };
}

function formatUnresolvedSignedWorkspace(storyId: string, metadataRoot: string, unresolvedReason: string | null): string {
  return [
    `review_run_start: story ${storyId} cannot resolve a git-backed signed workspace.`,
    `metadataRoot: ${metadataRoot}`,
    'signedWorkspaceRoot: unresolved',
    `Reason [${unresolvedReason || 'requires_git_signed_workspace_but_no_binding'}]: no explicit git-backed story worktree or configured gitRoot could be verified.`,
    'No reviewer run was created.',
    'Next action: configure gitRoot, attach the story to a git worktree, or recreate/advance the story through a git-backed Proofbound worktree flow.',
  ].join('\n');
}

function assertPathInsideWorktree(storyId: string, cwd: string, expectedAbsPath: string): void {
  const normalizedCwd = canonicalPath(cwd);
  const normalizedExpected = canonicalPath(expectedAbsPath);
  if (normalizedCwd !== normalizedExpected && !normalizedCwd.startsWith(normalizedExpected + '/') && !normalizedCwd.startsWith(normalizedExpected + '\\')) {
    throw new Error(
      `Story ${storyId} must execute lattice commands inside the worktree\n` +
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
