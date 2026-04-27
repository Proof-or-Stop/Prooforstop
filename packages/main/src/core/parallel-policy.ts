/**
 * B-c622 CHK-007: Multi-story parallel safety policy.
 *
 * Resolves lane / parallelSafety from story metadata and detects
 * shared-hotspot conflicts across active stories.
 */
import type { StoryInfo } from './types.js';

export type StoryLane = 'mainline' | 'supporting' | 'exploratory';
export type ParallelSafety = 'yes' | 'no' | 'plan_only';

/**
 * Resolve the lane for a story based on its explicit `lane` field
 * or inferred from `priority`.
 *
 * - critical / high  -> mainline
 * - medium           -> supporting
 * - low / everything else -> exploratory
 */
export function resolveStoryLane(story: StoryInfo): StoryLane {
  if (story.lane) return story.lane;

  switch (story.priority) {
    case 'critical':
    case 'high':
      return 'mainline';
    case 'medium':
      return 'supporting';
    default:
      return 'exploratory';
  }
}

/**
 * Resolve whether a story can safely run in parallel with other active stories.
 *
 * Rules (evaluated in order):
 * 1. Explicit `parallelSafe` on the story wins immediately.
 * 2. If story.blockingFor mentions any id in `allStories` that is still active
 *    (not DONE / DISCARDED) -> 'no'.
 * 3. If story.sharedHotspots overlap with any other active story's
 *    sharedHotspots -> 'plan_only' (can plan but not code simultaneously).
 * 4. If story.depends includes an active story -> 'no'.
 * 5. Otherwise -> 'yes'.
 */
export function resolveParallelSafety(
  story: StoryInfo,
  allStories: StoryInfo[],
): ParallelSafety {
  // Explicit override
  if (story.parallelSafe) return story.parallelSafe;

  const terminalPhases = new Set(['DONE', 'DISCARDED']);
  const activeOthers = allStories.filter(
    (s) => s.storyId !== story.storyId && !terminalPhases.has(s.phase),
  );

  // blockingFor: this story blocks another active story -> cannot parallel
  if (story.blockingFor && story.blockingFor.length > 0) {
    const activeIds = new Set(activeOthers.map((s) => s.storyId));
    for (const bid of story.blockingFor) {
      if (activeIds.has(bid)) return 'no';
    }
  }

  // depends: this story depends on another active story -> cannot parallel
  if (story.depends && story.depends.length > 0) {
    const activeIds = new Set(activeOthers.map((s) => s.storyId));
    for (const dep of story.depends) {
      if (activeIds.has(dep)) return 'no';
    }
  }

  // sharedHotspots overlap -> plan_only
  if (story.sharedHotspots && story.sharedHotspots.length > 0) {
    const myHotspots = new Set(story.sharedHotspots);
    for (const other of activeOthers) {
      if (other.sharedHotspots) {
        for (const hp of other.sharedHotspots) {
          if (myHotspots.has(hp)) return 'plan_only';
        }
      }
    }
  }

  return 'yes';
}

/**
 * Produce a human-readable parallel-safety summary for a set of stories.
 * Detects hotspot conflicts and blocking chains.
 */
export function summarizeParallelPolicy(stories: StoryInfo[]): string {
  const terminalPhases = new Set(['DONE', 'DISCARDED']);
  const active = stories.filter((s) => !terminalPhases.has(s.phase));

  if (active.length === 0) return 'No active stories.';

  const lines: string[] = [];
  lines.push(`Active stories: ${active.length}`);

  // Per-story lane + safety
  for (const s of active) {
    const lane = resolveStoryLane(s);
    const safety = resolveParallelSafety(s, stories);
    lines.push(`  ${s.storyId} [${lane}] parallel=${safety} (phase=${s.phase})`);
  }

  // Hotspot conflicts
  const hotspotMap = new Map<string, string[]>();
  for (const s of active) {
    if (s.sharedHotspots) {
      for (const hp of s.sharedHotspots) {
        const list = hotspotMap.get(hp) ?? [];
        list.push(s.storyId);
        hotspotMap.set(hp, list);
      }
    }
  }

  const conflicts: string[] = [];
  for (const [hp, ids] of hotspotMap) {
    if (ids.length > 1) {
      conflicts.push(`  ${hp}: ${ids.join(', ')}`);
    }
  }

  if (conflicts.length > 0) {
    lines.push('Hotspot conflicts:');
    lines.push(...conflicts);
  } else {
    lines.push('No hotspot conflicts.');
  }

  return lines.join('\n');
}
