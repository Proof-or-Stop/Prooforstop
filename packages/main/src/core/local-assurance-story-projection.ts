import { existsSync } from 'node:fs';

import type { StoryStore } from './store.js';
import { resolveStoryWorkspace, type StoryWorkspace } from './story-workspace.js';
import type { StoryInfo, StoryPhase } from './types.js';
import {
  getRepoRoot,
  isForeignAbsolutePath,
  resolveWorktreePath,
} from './worktree-runtime.js';

export const LOCAL_ASSURANCE_STORY_PROJECTION_SCHEMA_VERSION = 'lattice.local_assurance_story_projection.v1';

export type StoryStateSource = 'main' | 'worktree';

export interface LocalAssuranceStoryRow {
  storyId: string;
  title: string;
  stateSource: StoryStateSource;
  mirrorPhase: StoryPhase;
  activePhase: StoryPhase;
  activeCwd: string;
  worktreePath: string | null;
}

export interface LocalAssuranceStoryProjection {
  schemaVersion: typeof LOCAL_ASSURANCE_STORY_PROJECTION_SCHEMA_VERSION;
  readOnly: true;
  generatedAt: string;
  repoRoot: string;
  stories: LocalAssuranceStoryRow[];
}

const TERMINAL_PHASES = new Set<StoryPhase>(['DONE', 'DISCARDED']);

export interface ResolveLocalAssuranceStoriesOptions {
  /** When true (default), only non-terminal stories are returned. */
  activeOnly?: boolean;
  /** Restrict resolution to specific story ids. */
  storyIds?: string[];
  /** ISO timestamp override (smoke tests only). */
  now?: string;
}

export function resolveLocalAssuranceStories(
  rootStore: StoryStore,
  projectRoot: string,
  options: ResolveLocalAssuranceStoriesOptions = {},
): LocalAssuranceStoryProjection {
  const repoRoot = getRepoRoot(projectRoot);
  const activeOnly = options.activeOnly !== false;
  const ctx = { store: rootStore, root: projectRoot };

  const allIds = options.storyIds && options.storyIds.length > 0
    ? options.storyIds
    : rootStore.listStoryIds();

  const rows: LocalAssuranceStoryRow[] = [];
  for (const id of allIds) {
    let mainStory: StoryInfo;
    try {
      mainStory = rootStore.readStory(id);
    } catch {
      continue;
    }
    if (activeOnly && TERMINAL_PHASES.has(mainStory.phase)) continue;

    // B-41c8 CHK-003: workspace resolution is owned by core/story-workspace.ts.
    // The projection never applied the phase-terminal guard itself (activeOnly
    // is the caller's filter; activeOnly=false callers such as the handoff read
    // a DONE story's residual worktree), so the guard stays off here.
    rows.push(buildRow(mainStory, resolveStoryWorkspace(ctx, id, { terminalPhaseGuard: false }), repoRoot));
  }

  rows.sort((a, b) => a.storyId.localeCompare(b.storyId));

  return {
    schemaVersion: LOCAL_ASSURANCE_STORY_PROJECTION_SCHEMA_VERSION,
    readOnly: true,
    generatedAt: options.now ?? new Date().toISOString(),
    repoRoot,
    stories: rows,
  };
}

function buildRow(
  mainStory: StoryInfo,
  workspace: StoryWorkspace,
  repoRoot: string,
): LocalAssuranceStoryRow {
  const storyId = workspace.storyId;
  const mirrorPhase = mainStory.phase;
  const recordedAbs = resolveWorktreePath(repoRoot, mainStory.worktree?.path ?? null);
  const recordedForeign = mainStory.worktree?.path
    ? isForeignAbsolutePath(mainStory.worktree.path)
    : false;
  const recordedExists = Boolean(recordedAbs && !recordedForeign && existsSync(recordedAbs));

  const worktreePath = workspace.worktreePath
    ?? (recordedExists ? recordedAbs : null);

  let stateSource: StoryStateSource = 'main';
  let activePhase: StoryPhase = mirrorPhase;
  let activeCwd = repoRoot;

  if (worktreePath) {
    stateSource = 'worktree';
    activeCwd = worktreePath;
    // The workspace store is the linked worktree's when it carries the story,
    // the invocation root's otherwise (which, invoked from inside the
    // worktree, is that worktree; anywhere else it is the mirror phase).
    activePhase = workspace.story.phase;
  }

  return {
    storyId,
    title: mainStory.title,
    stateSource,
    mirrorPhase,
    activePhase,
    activeCwd,
    worktreePath,
  };
}
