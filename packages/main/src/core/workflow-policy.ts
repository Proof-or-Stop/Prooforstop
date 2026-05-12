import type { KoalaConfig } from './config.js';
import type { StoryInfo, WorkflowProfile, WorkflowPolicy, DecisionData, ChecklistData } from './types.js';
import { PROFILE_ORDER, WORKFLOW_PRESETS } from './types.js';
import { EXPRESS_VERIFICATION_EXEMPTION_MESSAGE } from './flow-fact-policy.js';

/**
 * @task B-ef9c
 * @checklist CHK-001
 * @title wave zero before broader workflow escalation
 * @type feature
 * @priority high
 * @description
 *   Wave 0 is the de-risking slice for workflow policy: risk signals and high
 *   priority force stricter planning before later execution/review waves can
 *   proceed, and channel computation keeps lightweight stories from pretending
 *   they need the full Wave 1/2 machinery.
 * @changes
 *   - [CHK-001] Compute required workflow profile from risk and priority before downstream gates
 *   - [CHK-001] Compute express/fast/normal channel so workflow layers are triggered, not redefined
 */

const VALID_PROFILES: WorkflowProfile[] = ['light', 'balanced', 'strict'];

/**
 * Sanitize a raw profile string: if not a valid WorkflowProfile, fallback to 'balanced'.
 */
function sanitizeProfile(raw: string | undefined): WorkflowProfile {
  if (raw && VALID_PROFILES.includes(raw as WorkflowProfile)) return raw as WorkflowProfile;
  return 'balanced';
}

/**
 * From story compute requiredProfile (auto-escalation).
 * Rules:
 *   - riskSignals non-empty -> strict
 *   - priority in [high, critical] -> balanced
 *   - otherwise -> light
 */
export function computeRequiredProfile(story: StoryInfo): WorkflowProfile {
  if (story.riskSignals && story.riskSignals.length > 0) return 'strict';
  if (story.priority === 'high' || story.priority === 'critical') return 'balanced';
  return 'light';
}

/**
 * max(a, b) by total order light < balanced < strict
 */
export function maxProfile(a: WorkflowProfile, b: WorkflowProfile): WorkflowProfile {
  return PROFILE_ORDER[a] >= PROFILE_ORDER[b] ? a : b;
}

/**
 * Unified entry: compute the effective WorkflowPolicy for a story.
 * effectiveProfile = max(projectProfile, storyRequiredProfile)
 *
 * Defaults to 'balanced' when config.workflow.profile is absent.
 */
export function resolveWorkflowPolicy(config: KoalaConfig, story: StoryInfo): WorkflowPolicy {
  const projectProfile = sanitizeProfile(config.workflow?.profile);
  const requiredProfile = computeRequiredProfile(story);
  const effectiveProfile = maxProfile(projectProfile, requiredProfile);
  return WORKFLOW_PRESETS[effectiveProfile];
}

/**
 * Explanation of how the profile was computed (for workflow_explain command).
 */
export type ProfileExplanation = {
  projectProfile: WorkflowProfile;
  requiredProfile: WorkflowProfile;
  effectiveProfile: WorkflowProfile;
  reasons: string[];
};

export function explainProfile(config: KoalaConfig, story: StoryInfo): ProfileExplanation {
  const projectProfile = sanitizeProfile(config.workflow?.profile);
  const requiredProfile = computeRequiredProfile(story);
  const effectiveProfile = maxProfile(projectProfile, requiredProfile);

  const reasons: string[] = [];
  if (story.riskSignals && story.riskSignals.length > 0) {
    reasons.push(`riskSignals hit: ${story.riskSignals.map(r => r.category).join(', ')} -> requiredProfile=strict`);
  }
  if (story.priority === 'high' || story.priority === 'critical') {
    reasons.push(`priority=${story.priority} -> requiredProfile>=balanced`);
  }
  if (effectiveProfile !== projectProfile) {
    reasons.push(`auto-escalated: ${projectProfile} -> ${effectiveProfile}`);
  }
  if (reasons.length === 0) {
    reasons.push(`no escalation signals, using project default profile=${projectProfile}`);
  }

  return { projectProfile, requiredProfile, effectiveProfile, reasons };
}

// ─────────────────────────────────────────────────────────────────
// Channel (B-45ed CHK-004): 三档通道
//   express  极速：items ≤ 2 且无 riskSignals
//   fast     快速：items ≤ 5 且单一解（decision 缺失 or options.length ≤ 1）且无 riskSignals
//   normal   正常：其他情况
// 硬规则：riskSignals 非空 → 强制 normal（即便 items ≤ 2）
// ─────────────────────────────────────────────────────────────────
export type StoryChannel = 'express' | 'fast' | 'normal';
export type VerificationIntentPolicyKind = 'express-exempt' | 'explicit-intent' | 'missing-intent';

/**
 * Channel 中文显示名（workflow_explain 输出用）
 */
export const CHANNEL_LABELS: Record<StoryChannel, string> = {
  express: '极速',
  fast: '快速',
  normal: '正常',
};

type ChannelStory = Pick<StoryInfo, 'riskSignals'> & Partial<Pick<StoryInfo, 'riskSignalsDismissed'>>;
type ChannelChecklist = Pick<ChecklistData, 'items'> | { items: Array<unknown> };
type ChannelDecision = Pick<DecisionData, 'options' | 'chosen'> | null | undefined;

export interface VerificationIntentPolicyResolution {
  policy: VerificationIntentPolicyKind;
  channel: StoryChannel;
  intentCount: number;
  message?: string;
  reason: string;
}

/**
 * 实时计算 story 的通道分档。不持久化，每次调用重新算。
 *
 * 参数兼容旧调用方：decision 可省略（等价于"尚未决策 → 按单一解路径判"）。
 *
 * @param story  至少含 riskSignals；可选 riskSignalsDismissed（被驳回的不计入 risk）
 * @param checklist 至少含 items 数组
 * @param decision 可选 decision.json 内容（含 options + chosen）
 */
export function computeChannel(
  story: ChannelStory,
  checklist: ChannelChecklist,
  decision?: ChannelDecision,
): StoryChannel {
  // 风险判定：过滤掉已 dismiss 的 category（与 story_review 口径一致）
  const dismissed = new Set(
    (story.riskSignalsDismissed || []).map((d: { category: string }) => d.category),
  );
  const activeRisk = (story.riskSignals || []).filter(
    (r: { category: string }) => !dismissed.has(r.category),
  );
  const hasRisk = activeRisk.length > 0;

  // 硬规则：有 riskSignals → normal
  if (hasRisk) return 'normal';

  const n = Array.isArray(checklist.items) ? checklist.items.length : 0;

  // 极速：≤ 2
  if (n <= 2) return 'express';

  // 快速：≤ 5 且单一解
  // 单一解判定：decision 不存在 → 视为"尚未决策，按 items 长度走"（≤5 即 fast）
  //              decision 存在 → options.length ≤ 1 才算单一解
  if (n <= 5) {
    const isSingleSolution = !decision || !Array.isArray(decision.options) || decision.options.length <= 1;
    if (isSingleSolution) return 'fast';
  }

  return 'normal';
}

function countVerificationIntentEntries(checklist: ChannelChecklist): number {
  if (!Array.isArray(checklist.items)) return 0;
  return checklist.items.reduce<number>((total, item: any) => {
    const vi = item?.verificationIntent;
    if (!vi || typeof vi !== 'object') return total;
    return total
      + (Array.isArray(vi.happy) ? vi.happy.length : 0)
      + (Array.isArray(vi.edge) ? vi.edge.length : 0)
      + (Array.isArray(vi.adversarial) ? vi.adversarial.length : 0);
  }, 0);
}

export function resolveVerificationIntentPolicy(
  story: ChannelStory,
  checklist: ChannelChecklist,
  decision?: ChannelDecision,
): VerificationIntentPolicyResolution {
  const channel = computeChannel(story, checklist, decision);
  const intentCount = countVerificationIntentEntries(checklist);
  if (intentCount > 0) {
    return {
      policy: 'explicit-intent',
      channel,
      intentCount,
      reason: `verificationIntent entries present (${intentCount})`,
    };
  }
  if (channel === 'express') {
    return {
      policy: 'express-exempt',
      channel,
      intentCount,
      message: EXPRESS_VERIFICATION_EXEMPTION_MESSAGE,
      reason: 'express channel has no riskSignals and at most two checklist items',
    };
  }
  return {
    policy: 'missing-intent',
    channel,
    intentCount,
    reason: `${channel} channel has zero verificationIntent entries`,
  };
}
