/**
 * Decision (RALPLAN-DR 结构化决策，OMX ralplan 风格).
 *
 * PLAN 阶段为每个非 trivial story 落一份 decision.json：
 *   - principles (3-5 条)
 *   - drivers (top 3 关键约束)
 *   - options (≥ 2 个备选 + pros/cons)
 *   - chosen + rationale
 *   - preMortem (高风险 story 强制 ≥ 3)
 *
 * 第一版软引入：priority=high 或 riskSignals 非空时 story_review 强制要求。
 */

import type { HandlerContext } from './context.js';
import type { DecisionData, DecisionOption, PreMortemScenario } from '../core/types.js';

export function createDecisionHandlers(ctx: HandlerContext) {
  const { store } = ctx;

  return {
    decision_set(args: {
      storyId: string;
      principles: string[];
      drivers: string[];
      options: DecisionOption[];
      chosen: string;
      rationale: string;
      preMortem?: PreMortemScenario[];
    }): string {
      store.readStory(args.storyId); // 校验存在

      // 字段校验
      if (!Array.isArray(args.principles) || args.principles.length < 3 || args.principles.length > 5) {
        throw new Error('decision.principles 必须是 3-5 条');
      }
      if (!Array.isArray(args.drivers) || args.drivers.length < 1 || args.drivers.length > 5) {
        throw new Error('decision.drivers 必须是 1-5 条（建议 top 3）');
      }
      if (!Array.isArray(args.options) || args.options.length === 0) {
        throw new Error('decision.options 必须是非空数组');
      }
      if (args.options.length < 2) {
        // 单选项必须说明为什么
        const opt = args.options[0];
        if (!opt.cons || opt.cons.length === 0) {
          throw new Error(
            'decision.options 只有 1 个时必须在 cons 里写明"为什么其他备选被排除"的 invalidation rationale。' +
            '否则 review 视为"缺少 fair alternatives"（OMX Critic 同款要求）。'
          );
        }
      }
      for (const opt of args.options) {
        if (!opt.name || opt.name.trim().length < 3) {
          throw new Error(`option.name 必须 ≥ 3 字符: ${JSON.stringify(opt)}`);
        }
        if (!Array.isArray(opt.pros) || opt.pros.length === 0) {
          throw new Error(`option "${opt.name}" 缺少 pros`);
        }
        if (!Array.isArray(opt.cons) || opt.cons.length === 0) {
          throw new Error(`option "${opt.name}" 缺少 cons（不能只列好处）`);
        }
      }
      if (!args.chosen || args.chosen.trim().length < 3) {
        throw new Error('decision.chosen 必须指向某个 option.name');
      }
      const chosenExists = args.options.some(o => o.name === args.chosen);
      if (!chosenExists) {
        throw new Error(
          `decision.chosen "${args.chosen}" 不在 options 列表里。可选: ${args.options.map(o => o.name).join(', ')}`
        );
      }
      if (!args.rationale || args.rationale.trim().length < 10) {
        throw new Error('decision.rationale 必须 ≥ 10 字符（说明为什么选这个）');
      }

      // 高风险 story 强制 ≥ 3 preMortem
      // B-5010 CHK-004: 被 dismiss 的 riskSignal 不计入高风险判定
      const story = store.readStory(args.storyId);
      const dismissedCats = new Set((story.riskSignalsDismissed || []).map(d => d.category));
      const activeRiskSignals = (story.riskSignals || []).filter(r => !dismissedCats.has(r.category));
      const isHighRisk = story.priority === 'high' || story.priority === 'critical'
        || activeRiskSignals.length > 0;
      if (isHighRisk) {
        if (!args.preMortem || args.preMortem.length < 3) {
          throw new Error(
            `高风险 story（priority=${story.priority}${story.riskSignals ? ', riskSignals 非空' : ''}）` +
            `必须提供 ≥ 3 个 preMortem 场景（当前: ${args.preMortem?.length ?? 0}）。` +
            `每个场景包含 scenario/trigger/consequence/mitigation 4 个字段。`
          );
        }
        for (const pm of args.preMortem) {
          if (!pm.scenario || !pm.trigger || !pm.consequence || !pm.mitigation) {
            throw new Error(
              `preMortem 条目必须同时包含 scenario/trigger/consequence/mitigation 4 个非空字段: ${JSON.stringify(pm)}`
            );
          }
        }
      }

      const data: DecisionData = {
        principles: args.principles,
        drivers: args.drivers,
        options: args.options,
        chosen: args.chosen,
        rationale: args.rationale,
        ...(args.preMortem ? { preMortem: args.preMortem } : {}),
        timestamp: new Date().toISOString(),
      };

      store.writeDecision(args.storyId, data);

      const lines = [
        `Decision saved for ${args.storyId}`,
        `  principles:  ${args.principles.length}`,
        `  drivers:     ${args.drivers.length}`,
        `  options:     ${args.options.length} (chosen: ${args.chosen})`,
        `  preMortem:   ${args.preMortem?.length ?? 0}${isHighRisk ? ' (高风险强制 ≥ 3)' : ''}`,
      ];
      return lines.join('\n');
    },

    decision_get(args: { storyId: string }): DecisionData | { _empty: true } {
      const data = store.readDecision(args.storyId);
      if (!data) return { _empty: true };
      return data;
    },
  };
}
