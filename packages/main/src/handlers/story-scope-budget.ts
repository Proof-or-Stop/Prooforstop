import type { HandlerContext } from './context.js';
import { approveStoryScopeBudget, scopeBudgetDecisionReport, type ScopeBudgetApprovalArgs } from '../core/story-scope-budget-decisions.js';

export function createStoryScopeBudgetHandlers({ store, root }: HandlerContext) {
  return {
    scope_budget_check(args: { storyId: string; amendmentId?: string; json?: boolean }) {
      if (!store.storyExists(args.storyId)) throw new Error(`Story ${args.storyId} does not exist`);
      const report = scopeBudgetDecisionReport(store, root, args.storyId, args.amendmentId);
      return JSON.stringify({ ...report, readOnly: true, authority: 'diagnostic_only',
        confirmationToken: report.status === 'decision_required' ? `APPROVE LARGE STORY ${args.storyId} ${report.bindingDigest}` : null }, null, 2);
    },
    scope_budget_approve(args: ScopeBudgetApprovalArgs) {
      return JSON.stringify({ decision: approveStoryScopeBudget(store, root, args) }, null, 2);
    },
  };
}
