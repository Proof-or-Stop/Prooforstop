/** Story 6 prompt budget observation.
 *
 * This deliberately has no enforce branch: exceeding a complex-role budget is
 * an auditable warning, never a reason to suppress the correctness-critical
 * full Task Context dispatch. Story 7 owns the observe -> warn rollout and a
 * later, evidence-gated enforce decision.
 */
export const COMPLEX_ROLE_PROMPT_BUDGETS = Object.freeze({
  incrementalBytes: 27_000,
  fullBytes: 44_000,
});

export type PromptBudgetMode = 'observe' | 'warn';

export interface PromptBudgetObservation {
  schemaVersion: 'proofbound.prompt-budget-observation.v1';
  roleId: string;
  contextMode: 'full' | 'incremental';
  mode: PromptBudgetMode;
  bytes: number;
  estimatedTokens: number;
  limitBytes: number;
  withinBudget: boolean;
  violation: 'none' | 'complex-role-budget';
  reason: string;
}

export function observeComplexRolePromptBudget(args: {
  roleId: string;
  contextMode: 'full' | 'incremental';
  bytes: number;
  estimatedTokens: number;
  mode?: PromptBudgetMode;
}): PromptBudgetObservation {
  const limitBytes = args.contextMode === 'incremental'
    ? COMPLEX_ROLE_PROMPT_BUDGETS.incrementalBytes
    : COMPLEX_ROLE_PROMPT_BUDGETS.fullBytes;
  const withinBudget = Number.isSafeInteger(args.bytes) && args.bytes <= limitBytes;
  return {
    schemaVersion: 'proofbound.prompt-budget-observation.v1',
    roleId: args.roleId,
    contextMode: args.contextMode,
    mode: args.mode ?? 'warn',
    bytes: args.bytes,
    estimatedTokens: args.estimatedTokens,
    limitBytes,
    withinBudget,
    violation: withinBudget ? 'none' : 'complex-role-budget',
    reason: withinBudget
      ? 'within complex-role prompt budget'
      : `complex-role prompt is ${args.bytes} bytes; advisory limit is ${limitBytes} bytes; continue full correctness dispatch`,
  };
}
