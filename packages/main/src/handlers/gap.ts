/**
 * @task B-5a58
 * @checklist CHK-001
 * @title restore gap CLI handlers in main registry
 * @type feature
 * @priority high
 * @description
 *   当前默认 koala CLI 已不再暴露 gap_analyze / convergence_check，
 *   但底层 analyzeGap / checkConvergence 实现仍在 tasks/gap-analyze.ts。
 *   这里把两条命令重新接回 main registry，让 CLI help、派发和 DONE hint
 *   不再引用一个用户实际跑不到的命令。
 * @changes
 *   - [CHK-001] 新增 main CLI 的 gap/convergence handler，直接复用 analyzeGap/checkConvergence
 */

import type { HandlerContext } from './context.js';
import { analyzeGap, checkConvergence } from '../tasks/gap-analyze.js';

export function createGapHandlers(ctx: HandlerContext) {
  const { root, store } = ctx;

  return {
    gap_analyze(): string {
      return JSON.stringify(analyzeGap(root, store), null, 2);
    },

    convergence_check(): string {
      return JSON.stringify(checkConvergence(root, store), null, 2);
    },
  };
}
