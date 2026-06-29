import { existsSync } from 'node:fs';

import { StoryStore } from './store.js';
import type { StoryInfo, StoryPhase } from './types.js';
import {
  getRepoRoot,
  isForeignAbsolutePath,
  listGitWorktrees,
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
  const linkedByStoryId = collectLinkedStoryWorktrees(repoRoot);

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

    rows.push(buildRow(id, mainStory, linkedByStoryId.get(id) ?? null, repoRoot));
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
  storyId: string,
  mainStory: StoryInfo,
  linkedPath: string | null,
  repoRoot: string,
): LocalAssuranceStoryRow {
  const mirrorPhase = mainStory.phase;
  const recordedAbs = resolveWorktreePath(repoRoot, mainStory.worktree?.path ?? null);
  const recordedForeign = mainStory.worktree?.path
    ? isForeignAbsolutePath(mainStory.worktree.path)
    : false;
  const recordedExists = Boolean(recordedAbs && !recordedForeign && existsSync(recordedAbs));

  const worktreePath = linkedPath
    ?? (recordedExists ? recordedAbs : null);

  let stateSource: StoryStateSource = 'main';
  let activePhase: StoryPhase = mirrorPhase;
  let activeCwd = repoRoot;

  if (worktreePath) {
    stateSource = 'worktree';
    activeCwd = worktreePath;
    activePhase = readWorktreePhase(storyId, worktreePath, mirrorPhase);
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
