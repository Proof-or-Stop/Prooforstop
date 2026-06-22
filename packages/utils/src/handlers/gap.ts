import type { HandlerContext } from '../../../main/dist/handlers/context.js';
import { analyzeGap, checkConvergence } from '../../../main/dist/tasks/gap-analyze.js';

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
