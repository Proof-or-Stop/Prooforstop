/**
 * @task B-381e
 * @checklist CHK-001
 * @title machine-readable story authority resolver core
 * @type feature
 * @priority high
 * @description
 *   Resolves the host-neutral authority surface for each active story so UI /
 *   adapter consumers do not have to parse `session_brief` / `status` Markdown
 *   or read backing JSON directly. For every active story it returns the
 *   `authority` (main vs worktree), the `mirrorPhase` recorded in the main
 *   repo, the `authoritativePhase` resolved from the worktree-side StoryStore
 *   when a linked worktree exists, the `authoritativeCwd` adapters should run
 *   subsequent `lattice story_export --format=json` calls from, and the
 *   `worktreePath` link (or null when none exists). Conservative authority
 *   fields (`productionDone` / `receiptVerified` / `authorityChanged`) are
 *   hardcoded `false`: this resolver is L0 read-only and never promotes a
 *   local host result into a production receipt — that path stays gated on
 *   B-2522.
 * @changes
 *   - [CHK-001] Add validator-required changes metadata for the story authority resolver task header.
 */

import { existsSync } from 'node:fs';
import { StoryStore } from './store.js';
import type { StoryInfo, StoryPhase } from './types.js';
import {
  getRepoRoot,
  isForeignAbsolutePath,
  listGitWorktrees,
  resolveWorktreePath,
} from './worktree-runtime.js';

export const STORY_AUTHORITY_RESOLVE_SCHEMA_VERSION = 'lattice.story_authority_resolve.v1';

export type StoryAuthority = 'main' | 'worktree';

export interface StoryAuthorityRow {
  storyId: string;
  title: string;
  authority: StoryAuthority;
  mirrorPhase: StoryPhase;
  authoritativePhase: StoryPhase;
  authoritativeCwd: string;
  worktreePath: string | null;
}

export interface StoryAuthorityResolveResult {
  schemaVersion: typeof STORY_AUTHORITY_RESOLVE_SCHEMA_VERSION;
  readOnly: true;
  productionDone: false;
  receiptVerified: false;
  authorityChanged: false;
  generatedAt: string;
  repoRoot: string;
  stories: StoryAuthorityRow[];
}

const TERMINAL_PHASES = new Set<StoryPhase>(['DONE', 'DISCARDED']);

export interface ResolveOptions {
  /** When true (default), only non-terminal stories are returned. */
  activeOnly?: boolean;
  /** Restrict resolution to specific story ids. */
  storyIds?: string[];
  /** ISO timestamp override (smoke tests only). */
  now?: string;
}

/**
 * Resolve the host-neutral authority view across the active story set.
 *
 * Read-only: never mutates StoryStore data, never spawns runners, never POSTs
 * authority evidence. Worktree state is discovered via `git worktree list` and
 * the per-worktree StoryStore — backing JSON files are NOT read directly by
 * adapters; consumers should drive subsequent reads through the documented L0
 * CLI surface.
 */
export function resolveStoryAuthority(
  rootStore: StoryStore,
  projectRoot: string,
  options: ResolveOptions = {},
): StoryAuthorityResolveResult {
  const repoRoot = getRepoRoot(projectRoot);
  const activeOnly = options.activeOnly !== false;
  const linkedByStoryId = collectLinkedStoryWorktrees(repoRoot);

  const allIds = options.storyIds && options.storyIds.length > 0
    ? options.storyIds
    : rootStore.listStoryIds();

  const rows: StoryAuthorityRow[] = [];
  for (const id of allIds) {
    let mainStory: StoryInfo;
    try {
      mainStory = rootStore.readStory(id);
    } catch {
      continue;
    }
    if (activeOnly && TERMINAL_PHASES.has(mainStory.phase)) continue;

    rows.push(buildRow(id, mainStory, linkedByStoryId.get(id) ?? null, repoRoot));
  }

  rows.sort((a, b) => a.storyId.localeCompare(b.storyId));

  return {
    schemaVersion: STORY_AUTHORITY_RESOLVE_SCHEMA_VERSION,
    readOnly: true,
    productionDone: false,
    receiptVerified: false,
    authorityChanged: false,
    generatedAt: options.now ?? new Date().toISOString(),
    repoRoot,
    stories: rows,
  };
}

function buildRow(
  storyId: string,
  mainStory: StoryInfo,
  linkedPath: string | null,
  repoRoot: string,
): StoryAuthorityRow {
  const mirrorPhase = mainStory.phase;
  const recordedAbs = resolveWorktreePath(repoRoot, mainStory.worktree?.path ?? null);
  const recordedForeign = mainStory.worktree?.path
    ? isForeignAbsolutePath(mainStory.worktree.path)
    : false;
  const recordedExists = Boolean(recordedAbs && !recordedForeign && existsSync(recordedAbs));

  const worktreePath = linkedPath
    ?? (recordedExists ? recordedAbs : null);

  let authority: StoryAuthority = 'main';
  let authoritativePhase: StoryPhase = mirrorPhase;
  let authoritativeCwd = repoRoot;

  if (worktreePath) {
    authority = 'worktree';
    authoritativeCwd = worktreePath;
    authoritativePhase = readWorktreePhase(storyId, worktreePath, mirrorPhase);
  }

  return {
    storyId,
    title: mainStory.title,
    authority,
    mirrorPhase,
    authoritativePhase,
    authoritativeCwd,
    worktreePath,
  };
}

function readWorktreePhase(
  storyId: string,
  worktreePath: string,
  fallback: StoryPhase,
): StoryPhase {
  try {
    const store = new StoryStore(worktreePath);
    const story = store.readStory(storyId);
    return story.phase;
  } catch {
    return fallback;
  }
}

function collectLinkedStoryWorktrees(repoRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of listGitWorktrees(repoRoot)) {
    const match = entry.branch?.match(/^story\/(.+)$/);
    if (!match) continue;
    if (!entry.path || !existsSync(entry.path)) continue;
    map.set(match[1], entry.path);
  }
  return map;
}
