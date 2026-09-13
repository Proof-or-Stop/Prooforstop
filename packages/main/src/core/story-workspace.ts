/**
 * B-41c8 CHK-003 — the one owner of "where does this story's work live".
 *
 * Before this module four implementations each decided on their own which
 * tree a story's git work, StoryStore and config live in (story-query.ts
 * `readStoryProjection`, session.ts `listActiveWorktrees` +
 * `readStoryFromLinkedWorktree`, local-assurance-story-projection.ts
 * `collectLinkedStoryWorktrees` and validation-plan.ts
 * `resolveStoryWorkspace`, B-a745 F-010). Two of them applied the
 * phase-terminal guard, two did not, and the listing variants ran
 * `git worktree list` in the metadata root, which on a wrapper-root layout
 * (configured `gitRoot` below the invocation root) is not a git repository.
 * One fact implemented four times drifts, and each copy was self-consistent
 * enough that the drift only showed up as B-a745's F-010 / F-014 findings.
 *
 * Contract:
 *   - `gitCwd` is exactly what `resolveGitCwd` returns for the story: its
 *     bound or linked worktree, else the configured gitRoot, else the
 *     invocation root. No second resolver is introduced here.
 *   - `store` is a StoryStore rooted at the resolved workspace and `config`
 *     is loaded from that workspace, when the workspace is a different tree
 *     than the invocation root AND carries a readable copy of the story;
 *     otherwise both are the invocation root's (`source: 'invocation-root'`,
 *     with `rootReason` naming why).
 *   - The phase-terminal guard (`DONE` / `DISCARDED` never read from a linked
 *     worktree — a merged-and-removed story must never be resolved as if it
 *     were still live, and a residual worktree is residue, not authority) is
 *     the `terminalPhaseGuard` option. The helper default is ON and every
 *     caller passes its value explicitly: story_list, session_brief and
 *     validation_plan (guarded since B-41c8 F-004) pass true; the local
 *     assurance projection passes false (activeOnly is its own filter).
 *     When the guard refuses, `gitCwd` is the invocation root and no git
 *     process is spawned: a terminal story's tree IS the invocation root, and
 *     list-shaped callers (story_list, session_brief) iterate every story.
 *   - This file spells no state-directory name and builds no metadata path
 *     of its own: every read goes through StoryStore, whose default story
 *     directory derives from core/proof-or-stop-paths.ts -> core/brand-paths.ts.
 *
 * Read-only: nothing here writes to either tree.
 */
import { realpathSync } from 'node:fs';

import { loadConfig, type ProofOrStopConfig } from './config.js';
import { StoryStore } from './store.js';
import { resolveGitCwdWithWorkspace } from './story-signed-workspace-resolution.js';
import type { StoryInfo } from './types.js';
import { listGitWorktrees } from './worktree-runtime.js';

/** Where `store` / `config` came from. */
export type StoryWorkspaceSource = 'linked-worktree' | 'invocation-root';

/** Why the invocation root was used (null when `source` is `linked-worktree`). */
export type StoryWorkspaceRootReason =
  /** The story's tree is the invocation root itself (we are already inside it). */
  | 'same-tree'
  /** The story is DONE / DISCARDED and the phase-terminal guard is on. */
  | 'terminal-phase'
  /** The story's tree is a different checkout that carries no readable copy of the story. */
  | 'no-story-copy';

export interface StoryWorkspaceContext {
  store: StoryStore;
  root: string;
}

export interface ResolveStoryWorkspaceOptions {
  /**
   * Phase-terminal guard: when true (helper default) a DONE / DISCARDED story
   * is never read from a linked worktree. Callers pass their own value.
   */
  terminalPhaseGuard?: boolean;
  /** Invocation-root config, when the caller already loaded it. */
  config?: ProofOrStopConfig;
}

export interface StoryWorkspace {
  storyId: string;
  /** The tree the story's git-facing work lives in (from `resolveGitCwd`). */
  gitCwd: string;
  /** StoryStore rooted at the resolved workspace. */
  store: StoryStore;
  /** Config loaded from the resolved workspace. */
  config: ProofOrStopConfig;
  source: StoryWorkspaceSource;
  rootReason: StoryWorkspaceRootReason | null;
  /**
   * The linked worktree on the story's branch, as `git worktree list` at
   * `gitCwd` reports it; null when there is none or the guard refused.
   */
  worktreePath: string | null;
  /**
   * True when the story record in `story` was read from the story's own
   * worktree: either through a linked-worktree read, or because the
   * invocation root IS that worktree.
   */
  readFromStoryWorktree: boolean;
  /** The story as read from `store`. */
  story: StoryInfo;
  /** The story as read from the invocation root (`ctx.store`). */
  rootStory: StoryInfo;
}

const TERMINAL_PHASES: ReadonlySet<string> = new Set(['DONE', 'DISCARDED']);

export function isTerminalStoryPhase(phase: string): boolean {
  return TERMINAL_PHASES.has(phase);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The linked worktree checked out on the story's branch, if git lists one from `gitCwd`. */
function linkedStoryWorktreePath(gitCwd: string, story: StoryInfo): string | null {
  const expectedBranch = story.worktree?.branch || `story/${story.storyId}`;
  const linked = listGitWorktrees(gitCwd).find((entry) => entry.branch === expectedBranch);
  return linked?.path ?? null;
}

function atInvocationRoot(
  ctx: StoryWorkspaceContext,
  config: ProofOrStopConfig,
  rootStory: StoryInfo,
  gitCwd: string,
  rootReason: StoryWorkspaceRootReason,
  worktreePath: string | null,
): StoryWorkspace {
  return {
    storyId: rootStory.storyId,
    gitCwd,
    store: ctx.store,
    config,
    source: 'invocation-root',
    rootReason,
    worktreePath,
    readFromStoryWorktree:
      rootReason === 'same-tree' && worktreePath !== null && canonicalPath(worktreePath) === canonicalPath(gitCwd),
    story: rootStory,
    rootStory,
  };
}

/**
 * Resolve the workspace of `storyId` relative to the invocation context.
 * Throws only when the invocation root has no record of the story at all
 * (the same error `ctx.store.readStory` raises).
 */
export function resolveStoryWorkspace(
  ctx: StoryWorkspaceContext,
  storyId: string,
  options: ResolveStoryWorkspaceOptions = {},
): StoryWorkspace {
  const rootStory = ctx.store.readStory(storyId);
  const config = options.config ?? loadConfig(ctx.root);
  const terminalPhaseGuard = options.terminalPhaseGuard ?? true;

  if (terminalPhaseGuard && isTerminalStoryPhase(rootStory.phase)) {
    return atInvocationRoot(ctx, config, rootStory, ctx.root, 'terminal-phase', null);
  }

  const observation = resolveGitCwdWithWorkspace({
    store: ctx.store,
    storyId,
    metadataRoot: ctx.root,
    projectRoot: ctx.root,
    config,
  });
  const { gitCwd } = observation;
  // A successful resolver already observed the branch binding, including absence.
  // Preserve the historical inventory fallback only when authority was unresolved.
  const worktreePath = observation.worktreePath === undefined
    ? linkedStoryWorktreePath(gitCwd, rootStory)
    : observation.worktreePath;

  if (canonicalPath(gitCwd) === canonicalPath(ctx.root)) {
    return atInvocationRoot(ctx, config, rootStory, gitCwd, 'same-tree', worktreePath);
  }

  try {
    const store = new StoryStore(gitCwd);
    const story = store.readStory(storyId);
    return {
      storyId,
      gitCwd,
      store,
      config: loadConfig(gitCwd),
      source: 'linked-worktree',
      rootReason: null,
      worktreePath,
      readFromStoryWorktree: true,
      story,
      rootStory,
    };
  } catch {
    // The story's tree exists but carries no readable copy of the story (a
    // wrapper-root layout keeps the metadata outside git). Read-only fallback
    // to the invocation root; gitCwd still names the story's tree.
    return atInvocationRoot(ctx, config, rootStory, gitCwd, 'no-story-copy', worktreePath);
  }
}
