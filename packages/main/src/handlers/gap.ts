/**
 * @task B-5a58
 * @checklist CHK-001
 * @title restore gap CLI handlers in main registry
 * @type feature
 * @priority high
 * @description
 *   The current default lattice CLI no longer exposes gap_analyze / convergence_check,
 *   but the underlying analyzeGap / checkConvergence implementations remain in tasks/gap-analyze.ts.
 *   This re-wires the two commands back into the main registry so that CLI help, dispatch, and DONE hints
 *   no longer reference a command the user cannot actually run.
 * @changes
 *   - [CHK-001] Add gap/convergence handlers to the main CLI, directly reusing analyzeGap/checkConvergence
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
