import type { HandlerContext } from './context.js';
import { readStoryScopeBudget } from '../core/story-scope-budget.js';

export function createStoryScopeBudgetHandlers({ store, root }: HandlerContext) {
  return {
    scope_budget_check(args: { storyId: string; json?: boolean }) {
      if (!store.storyExists(args.storyId)) throw new Error(`Story ${args.storyId} does not exist`);
      const report = readStoryScopeBudget(store, root, args.storyId);
      return JSON.stringify({ ...report, readOnly: true, authority: 'diagnostic_only' }, null, 2);
    },
  };
}
