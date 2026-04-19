/**
 * @task B-a591
 * @checklist CHK-002
 * @title koala-lab profiles normalize target-specific heuristics into one interface
 * @type feature
 * @priority high
 * @description
 *   scoring core 不应该知道 reviewer、intent 或 session brief 的细节。profile
 *   层负责把 target-specific 评估压成统一的 LabRunMetrics，让 compare/promote
 *   可以只依赖一个接口。
 * @changes
 *   - [CHK-002] 新增 profile registry 与 resolveProfile 统一入口
 *   - [CHK-002] 未知 profile 时给出明确错误而不是回到 placeholder
 */
import type { LabProfileContext, LabRunMetrics } from '../types.js';
import { evaluateReviewerQualityProfile } from '../profiles/reviewer-quality-v1.js';
import { evaluateSessionBriefQualityProfile } from '../profiles/session-brief-quality-v1.js';
import { evaluateStoryReviewQualityProfile } from '../profiles/story-review-quality-v1.js';

export type LabProfileEvaluator = (ctx: LabProfileContext) => LabRunMetrics;

const PROFILES: Record<string, LabProfileEvaluator> = {
  'reviewer-quality-v1': evaluateReviewerQualityProfile,
  'session-brief-quality-v1': evaluateSessionBriefQualityProfile,
  'story-review-quality-v1': evaluateStoryReviewQualityProfile,
};

export function resolveProfile(profileName: string): LabProfileEvaluator {
  const profile = PROFILES[profileName];
  if (!profile) {
    const available = Object.keys(PROFILES).sort().join(', ');
    throw new Error(`未知 koala-lab profile: ${profileName}. 可用 profile: ${available}`);
  }
  return profile;
}

export function listProfiles(): string[] {
  return Object.keys(PROFILES).sort();
}
