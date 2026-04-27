/**
 * Understanding (Pre-context Intake snapshot, OMX 风格).
 *
 * 主 agent 在 PLAN 阶段开拆 checklist 之前先把对任务的理解结构化落下。
 * 借鉴 OMX ralph 的 step 0 — "没快照不准开干"。
 *
 * 第一版软引入：未填只 hint 提醒，不阻塞推进。等数据攒够再决定是否硬门禁。
 */

import type { HandlerContext } from './context.js';
import type { UnderstandingData } from '../core/types.js';
export function createUnderstandingHandlers(ctx: HandlerContext) {
  const { store } = ctx;

  return {
    understanding_set(args: {
      storyId: string;
      task: string;
      outcome: string;
      facts: string[];
      constraints: string[];
      unknowns: string[];
      touchpoints: string[];
    }): string {
      // 校验 story 存在
      store.readStory(args.storyId);

      // 基本字段校验：task / outcome 至少 5 字符
      if (!args.task || args.task.trim().length < 5) {
        throw new Error('understanding.task 必须 ≥ 5 字符（一句话描述要解决的问题）');
      }
      if (!args.outcome || args.outcome.trim().length < 5) {
        throw new Error('understanding.outcome 必须 ≥ 5 字符（完成后能观察到什么变化）');
      }
      if (!Array.isArray(args.facts)) throw new Error('facts 必须是数组');
      if (!Array.isArray(args.constraints)) throw new Error('constraints 必须是数组');
      if (!Array.isArray(args.unknowns)) throw new Error('unknowns 必须是数组');
      if (!Array.isArray(args.touchpoints)) throw new Error('touchpoints 必须是数组');

      const data: UnderstandingData = {
        task: args.task,
        outcome: args.outcome,
        facts: args.facts,
        constraints: args.constraints,
        unknowns: args.unknowns,
        touchpoints: args.touchpoints,
        timestamp: new Date().toISOString(),
      };

      store.writeUnderstanding(args.storyId, data);

      const summary = [
        `Understanding saved for ${args.storyId}`,
        `  task:        ${args.task.slice(0, 60)}${args.task.length > 60 ? '…' : ''}`,
        `  outcome:     ${args.outcome.slice(0, 60)}${args.outcome.length > 60 ? '…' : ''}`,
        `  facts:       ${args.facts.length}`,
        `  constraints: ${args.constraints.length}`,
        `  unknowns:    ${args.unknowns.length}`,
        `  touchpoints: ${args.touchpoints.length}`,
      ];

      // 软提醒：unknowns > 0 时建议在拆 checklist 前先消化
      if (args.unknowns.length > 0) {
        summary.push('');
        summary.push(`⚠ 还有 ${args.unknowns.length} 个 unknowns。建议在拆 checklist 前先调研:`);
        for (const u of args.unknowns.slice(0, 5)) {
          summary.push(`  - ${u}`);
        }
      }

      // 软提醒：touchpoints 为空时提醒补
      if (args.touchpoints.length === 0) {
        summary.push('');
        summary.push('⚠ touchpoints 为空。可能你还没想清楚这次改动会影响哪些文件——补一下能让 reviewer 更好审。');
      }

      return summary.join('\n');
    },

    understanding_get(args: { storyId: string }): UnderstandingData | { _empty: true } {
      const data = store.readUnderstanding(args.storyId);
      if (!data) return { _empty: true };
      return data;
    },
  };
}
