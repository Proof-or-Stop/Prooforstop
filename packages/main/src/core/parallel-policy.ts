import type { StoryInfo, StoryLane, StoryParallelSafety } from './types.js';

export interface ParallelPolicyView {
  lane: StoryLane;
  declaredLane: StoryLane | null;
  safety: StoryParallelSafety;
  declaredSafety: StoryParallelSafety | null;
  sharedHotspots: string[];
  blockingFor: string[];
  reasons: string[];
  conflicts: string[];
}

function dedupe(values?: string[]): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function resolveStoryLane(story: StoryInfo): StoryLane {
  if (story.lane) return story.lane;
  if (story.priority === 'critical' || story.priority === 'high') return 'mainline';
  return 'supporting';
}

export function resolveParallelSafety(story: StoryInfo): StoryParallelSafety {
  if (story.parallelSafe) return story.parallelSafe;
  if (story.depends && story.depends.length > 0) return 'plan_only';
  if (story.phase === 'PLAN' || story.phase === 'INIT' || story.phase === 'INIT_CHECK') return 'plan_only';
  return 'yes';
}

export function summarizeParallelPolicy(
  story: StoryInfo,
  storiesById: Map<string, StoryInfo>,
): ParallelPolicyView {
  const lane = resolveStoryLane(story);
  const safety = resolveParallelSafety(story);
  const sharedHotspots = dedupe(story.sharedHotspots);
  const blockingFor = dedupe(story.blockingFor);
  const reasons: string[] = [];
  const conflicts: string[] = [];

  if (!story.lane) {
    reasons.push(`lane defaulted to ${lane}`);
  }
  if (!story.parallelSafe) {
    reasons.push(`parallelSafe defaulted to ${safety}`);
  }

  if (story.depends && story.depends.length > 0) {
    const unresolved = story.depends.filter((depId) => storiesById.get(depId)?.phase !== 'DONE');
    if (unresolved.length > 0) {
      reasons.push(`depends on ${unresolved.join(', ')}`);
      if (safety === 'yes') {
        conflicts.push(`declares parallelSafe=yes but still depends on ${unresolved.join(', ')}`);
      }
    }
  }

  for (const blockedId of blockingFor) {
    if (!storiesById.has(blockedId)) {
      conflicts.push(`blockingFor references unknown story ${blockedId}`);
    }
  }

  for (const other of storiesById.values()) {
    if (other.storyId === story.storyId) continue;
    const otherHotspots = dedupe(other.sharedHotspots);
    if (sharedHotspots.length === 0 || otherHotspots.length === 0) continue;
    const overlap = sharedHotspots.filter((hotspot) => otherHotspots.includes(hotspot));
    if (overlap.length === 0) continue;
    if (other.phase === 'DONE' || other.phase === 'DISCARDED' || other.phase === 'IDEA') continue;
    conflicts.push(`shares hotspots with ${other.storyId}: ${overlap.join(', ')}`);
  }

  return {
    lane,
    declaredLane: story.lane ?? null,
    safety,
    declaredSafety: story.parallelSafe ?? null,
    sharedHotspots,
    blockingFor,
    reasons,
    conflicts,
  };
}
