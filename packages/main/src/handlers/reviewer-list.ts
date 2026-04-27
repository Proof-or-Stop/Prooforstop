/**
 * B-fdcf CHK-001: koala reviewer_list CLI
 *
 * 输出当前 story 的 opt-in reviewer 名单（按 5 档条件实时计算）：
 *   - concept  / quality / test-coverage → baseline（永远开）
 *   - behavior             → story.riskSignals 命中 {state machine / guard / gate}
 *   - docs                 → understanding.touchpoints 含 .md 文件（兜底扫 git diff）
 *   - channel              → computeChannel(story, checklist, decision) === 'normal'
 *
 * 设计说明（decision.json A1）：
 *   - 纯函数 computeActiveReviewers 供 canPassReview (CHK-002) / story-advance REVIEW echo 共用
 *   - 多条 riskSignal 命中 behavior 触发集时，reason 扁平化为单字符串
 *     （"riskSignal: gate, guard" 而不是多条 entry）
 *   - forceReviewer 走逗号分隔字符串；写 StoryEvent.action='reviewer_forced' 审计
 *   - 每次调用实时计算，不 cache（preMortem 1: 状态变化立刻生效）
 *
 * 复用 workflow-policy.computeChannel（三档 express/fast/normal），不用
 * 老的 reviewer-opt-in.resolveChannel（两档 quick/normal，items>2 就 normal，
 * 与三档模型不一致，见 B-fdcf background 方案取舍 A 方案）。
 */

import type { HandlerContext } from './context.js';
import type { StoryInfo, ChecklistData, DecisionData, StoryEvent } from '../core/types.js';
import { computeChannel } from '../core/workflow-policy.js';
import { detectMdTouchpointsFromGit } from '../core/touchpoints-fallback.js';

export interface ActiveReviewer {
  /** reviewer 短名：concept / quality / test-coverage / behavior / docs / channel / forced name */
  name: string;
  /** 为什么启用：baseline / "riskSignal: <cats>" / "touchpoints .md" / "normal channel" / forced */
  reason: string;
  /** 是否通过 forceReviewer 强制加挂 */
  forced?: boolean;
}

/** riskSignal.category 命中后触发 behavior reviewer 的关键词集合 */
const BEHAVIOR_TRIGGERS = ['state machine', 'guard', 'gate'];

/**
 * 固定输出顺序（B-fdcf F-002）：baseline-first concept → quality → test-coverage → behavior → docs → channel。
 * CHK-001 userSees 声明的顺序与此一致，不可改为 alphabetical。forced 名称以及任何
 * 未知 reviewer 名追加在末尾（按插入顺序）。
 */
const REVIEWER_ORDER: readonly string[] = ['concept', 'quality', 'test-coverage', 'behavior', 'docs', 'channel'];

/**
 * 纯函数：按 story + checklist + decision 计算应启用的 reviewer 列表。
 *
 * 返回顺序：按 name 字母序排序（稳定，便于断言 / 文本渲染）。
 * 同名 forced reviewer 会覆盖 auto-computed 的 entry，标 forced=true。
 *
 * @param story       至少含 riskSignals；复用 StoryInfo 类型
 * @param checklist   至少含 items 数组（{ items: Array<unknown> } 即可）
 * @param decision    可选 decision.json 内容（影响 computeChannel 判定）
 * @param touchpoints 可选 touchpoints 列表（默认读 story 的 understanding.json）
 * @param forced      可选强制加挂的 reviewer name 列表（逗号分隔字符串已解析）
 */
export function computeActiveReviewers(
  story: Pick<StoryInfo, 'riskSignals'> & Partial<Pick<StoryInfo, 'riskSignalsDismissed'>>,
  checklist: Pick<ChecklistData, 'items'> | { items: Array<unknown> },
  decision?: Pick<DecisionData, 'options' | 'chosen'> | null,
  touchpoints?: string[],
  forced?: string[],
): ActiveReviewer[] {
  const map = new Map<string, ActiveReviewer>();

  // BASELINE: concept + quality + test-coverage 永远启用.
  // test-coverage is the old TEST_CASE_REVIEW responsibility folded into REVIEW:
  // it checks verificationIntent -> verificationEvidence coverage instead of owning a lifecycle phase.
  map.set('concept', { name: 'concept', reason: 'baseline' });
  map.set('quality', { name: 'quality', reason: 'baseline' });
  map.set('test-coverage', { name: 'test-coverage', reason: 'baseline' });

  // behavior: riskSignals ∩ {state machine, guard, gate} 非空
  // 扁平化所有命中的 category（同时命中 gate+guard → "riskSignal: gate, guard"）
  const dismissed = new Set((story.riskSignalsDismissed || []).map(d => d.category));
  const activeCategories = (story.riskSignals || [])
    .map(r => r.category)
    .filter(c => !dismissed.has(c));
  const hitTriggers = BEHAVIOR_TRIGGERS.filter(t => activeCategories.includes(t));
  if (hitTriggers.length > 0) {
    map.set('behavior', {
      name: 'behavior',
      reason: `riskSignal: ${hitTriggers.join(', ')}`,
    });
  }

  // docs: touchpoints 含 .md 文件
  if (touchpoints && touchpoints.some(t => typeof t === 'string' && t.endsWith('.md'))) {
    map.set('docs', { name: 'docs', reason: 'touchpoints .md' });
  }

  // channel: 三档通道 === 'normal'（与 computeChannel 口径一致）
  const channel = computeChannel(story, checklist, decision ?? undefined);
  if (channel === 'normal') {
    map.set('channel', { name: 'channel', reason: 'normal channel' });
  }

  // forced override：命令行 --forceReviewer=a,b,c 显式加挂
  // 同名 auto reviewer 会被 override 成 reason='forced' + forced=true
  if (forced && forced.length > 0) {
    for (const f of forced) {
      const name = String(f).trim();
      if (!name) continue;
      map.set(name, { name, reason: 'forced', forced: true });
    }
  }

  // F-002: 固定 baseline-first 顺序，而不是 alphabetical。未知名（forced 非标准名）追加末尾。
  const ordered: ActiveReviewer[] = [];
  const seen = new Set<string>();
  for (const name of REVIEWER_ORDER) {
    const entry = map.get(name);
    if (entry) {
      ordered.push(entry);
      seen.add(name);
    }
  }
  for (const [name, entry] of map) {
    if (!seen.has(name)) ordered.push(entry);
  }
  return ordered;
}

/** 文本输出单行格式：`Active reviewers: concept, quality, behavior (riskSignal: gate)` */
export function renderActiveReviewersText(reviewers: ActiveReviewer[]): string {
  const parts = reviewers.map(r =>
    r.reason === 'baseline' ? r.name : `${r.name} (${r.reason})`,
  );
  return `Active reviewers: ${parts.join(', ')}`;
}

/** handler factory — 与其他 handler 保持一致的结构 */
export function createReviewerListHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    reviewer_list(args: { storyId: string; json?: boolean; forceReviewer?: string }): string {
      const story = store.readStory(args.storyId);

      // checklist — 缺失则视为 items 空（computeChannel 按 express 处理）
      let checklist: { items: unknown[] } = { items: [] };
      try {
        checklist = store.readChecklist(args.storyId);
      } catch {
        /* no checklist yet — items.length = 0 → express */
      }

      // F-005: 防御性兜底——store.readDecision 当前版本 file-not-exists 返回 null，
      // 但若未来校验加严 / JSON 损坏抛错，也不要把异常冒泡给 CLI。
      // computeChannel 对 undefined decision 有 fall-through 路径。
      let decision = null;
      try {
        decision = store.readDecision(args.storyId);
      } catch {
        decision = null;
      }

      // touchpoints: understanding.touchpoints 优先；否则回扫 git diff 的 .md 改动
      const understanding = store.readUnderstanding(args.storyId);
      const touchpoints = understanding?.touchpoints
        ?? detectMdTouchpointsFromGit(ctx.root);

      // forceReviewer 解析：逗号分隔 → 去空
      const forced = args.forceReviewer
        ? args.forceReviewer.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;

      const reviewers = computeActiveReviewers(
        story,
        checklist,
        decision,
        touchpoints,
        forced,
      );

      // 审计：每次 forceReviewer 调用写一条 reviewer_forced 事件，names[] 表达本次加挂的全集
      if (forced && forced.length > 0) {
        if (!story.events) story.events = [];
        const timestamp = new Date().toISOString();
        const agent = process.env.KOALA_AGENT || 'main';
        // 每个 forced name 一条事件（兼容 StoryEvent.reviewer 单值字段 + 方便按 reviewer 查询）
        for (const name of forced) {
          const event: StoryEvent = {
            phase: story.phase,
            action: 'reviewer_forced',
            timestamp,
            reviewer: name,
            reason: 'manual',
            agent,
          };
          story.events.push(event);
        }
        store.writeStory(args.storyId, story);
      }

      if (args.json) {
        return JSON.stringify({
          reviewers: reviewers.map(r => ({
            name: r.name,
            reason: r.reason,
            ...(r.forced ? { forced: true } : {}),
          })),
        });
      }

      return renderActiveReviewersText(reviewers);
    },
  };
}
