/**
 * B-e8c8 CHK-006: Reviewer opt-in routing by riskSignals.
 *
 * Baseline reviewers (always active): concept + quality.
 * Additional reviewers opted in by story signals:
 *   - riskSignals.category ∈ { state machine / guard / gate / 状态机/门禁 } → +behavior
 *   - touchpoints 含 `.md` 文件                                         → +docs
 *   - channel === 'normal'                                             → +channel
 *   - forced list (e.g. --force-reviewer=docs,channel)                 → 强制加挂
 *
 * Pure function — no I/O. 消费方：machine.canPassReview、reviewer_list handler、
 * story_advance REVIEW 命令输出的 reviewer echo（B-6974 后由 transition-effects.ts
 * buildNextSteps 渲染，经 transition-orchestrator 协调）。
 */

import type { StoryInfo } from './types.js';

export type Channel = 'quick' | 'normal';

export interface OptInReviewer {
  /** reviewer short name，如 concept / quality / behavior / docs / channel */
  name: string;
  /** 为什么这个 reviewer 被启用（baseline / riskSignal / touchpoint / channel / forced） */
  reason: string;
  /** 是否通过 --force-reviewer 强制加挂 */
  forced?: boolean;
}

/** Signal → +behavior 的触发 category 列表（既支持英文也支持现用的中文分类） */
const BEHAVIOR_TRIGGER_CATEGORIES = [
  'state machine',
  'guard',
  'gate',
  '状态机/门禁',
];

/**
 * 根据 story 的 riskSignals / channel / touchpoints 计算应启用的 reviewer 列表。
 * 返回按 name 字母序排序的列表（稳定，方便断言与渲染）。
 */
export function resolveOptInReviewers(
  story: StoryInfo,
  channel: Channel,
  touchpoints?: string[],
  forced?: string[],
): OptInReviewer[] {
  const map = new Map<string, OptInReviewer>();

  // BASELINE: concept + quality 永远启用
  map.set('concept', { name: 'concept', reason: 'baseline' });
  map.set('quality', { name: 'quality', reason: 'baseline' });

  // riskSignal 路由：命中 state machine/guard/gate 触发 behavior reviewer
  const categories = new Set((story.riskSignals || []).map(r => r.category));
  const triggeredBehavior = BEHAVIOR_TRIGGER_CATEGORIES.find(t => categories.has(t));
  if (triggeredBehavior) {
    map.set('behavior', { name: 'behavior', reason: `riskSignal: ${triggeredBehavior}` });
  }

  // touchpoint: 改动涉及 .md 文件 → +docs reviewer
  if (touchpoints && touchpoints.some(t => typeof t === 'string' && t.endsWith('.md'))) {
    map.set('docs', { name: 'docs', reason: 'touchpoint: md' });
  }

  // normal channel → +channel reviewer（检查 commit author 合规）
  if (channel === 'normal') {
    map.set('channel', { name: 'channel', reason: 'channel: normal' });
  }

  // forced override：命令行 --force-reviewer=docs,channel 显式加挂
  if (forced && forced.length > 0) {
    for (const f of forced) {
      const name = String(f).trim();
      if (!name) continue;
      map.set(name, { name, reason: 'forced', forced: true });
    }
  }

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 实时计算当前 story 的 channel（通道）。
 * 与 transition-effects.ts 的 buildNextSteps 里 DEV nextSteps 的判定保持一致：
 *   - checklist.items.length ≤ 2 且无 riskSignals → quick
 *   - 否则                                         → normal
 */
export function resolveChannel(
  itemsCount: number,
  riskSignals: StoryInfo['riskSignals'],
): Channel {
  if (itemsCount <= 2 && (!riskSignals || riskSignals.length === 0)) return 'quick';
  return 'normal';
}

/**
 * 根据 reviewer short name 从 finding agent 字符串判断匹配。
 * agent 如 "koala-review-concept" 匹配 name="concept"。
 * 兼容 "concept" 裸名、以及任何形式的 <prefix>-concept / <prefix>:concept。
 */
export function findingAgentMatchesReviewer(agent: string | undefined, reviewerName: string): boolean {
  if (!agent) return false;
  const a = agent.toLowerCase();
  const n = reviewerName.toLowerCase();
  if (a === n) return true;
  // "koala-review-concept" / "review-concept" / "some-concept" — 用边界匹配
  return a.endsWith(`-${n}`) || a.endsWith(`:${n}`) || a.includes(`-${n}-`) || a.includes(`-${n}:`);
}
