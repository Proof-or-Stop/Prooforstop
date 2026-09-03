import type { HandlerContext } from '@proof-or-stop/core/extension-api';
import { requireCoreRuntime } from '../core-runtime.js';

export function createGapHandlers(ctx: HandlerContext) {
  const { root, store } = ctx;
  const { analyzeGap, checkConvergence } = requireCoreRuntime(ctx);
  return {
    gap_analyze(): string {
      return JSON.stringify(analyzeGap(root, store), null, 2);
    },

    convergence_check(): string {
      return JSON.stringify(checkConvergence(root, store), null, 2);
    },
  };
}
