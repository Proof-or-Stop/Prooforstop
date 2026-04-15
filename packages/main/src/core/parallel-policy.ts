/**
 * @task B-6fda
 * @checklist CHK-002
 * @title parallel policy encodes Wave 0 de-risking before downstream waves
 * @type feature
 * @priority high
 * @description
 *   Wave 0 必须先做完、决策不明朗之前不要同时开 Wave 1/2，这个要求在实现层
 *   由并行调度规则承载：depends、plan_only、sharedHotspots、mainline/supporting
 *   和 conflict 推断一起把“先做 de-risking 主线、下游 wave 不抢跑”落成可计算的
 *   gate 语义，而不是只停留在文档里。
 * @changes
 *   - [CHK-002] 用 parallel policy 的 depends/plan_only/conflict 规则覆盖 Wave 0 先完成再开后续 wave 的 gate 要求
 */
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
