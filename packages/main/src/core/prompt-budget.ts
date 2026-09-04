/** Story 6 prompt budget observation.
 *
 * This deliberately has no warn/enforce branch: exceeding a complex-role
 * budget is an auditable observation, never a reason to suppress the
 * correctness-critical full Task Context dispatch. Story 7 owns observe -> warn and a
 * later, evidence-gated enforce decision.
 */
import { canonicalAgentRoleId } from './agent-role-identity.js';

export const COMPLEX_ROLE_PROMPT_BUDGETS = Object.freeze({
  roleContractBytes: 12_000,
  // B-4043: raised from 10_000 — the implementer prompt now carries the
  // acceptance-rollout boundary guidance moved out of the host shim, matching
  // its sibling complex roles' role-body budget.
  implementerRoleContractBytes: 12_000,
  incrementalBytes: 27_000,
  fullBytes: 44_000,
});

export const BUDGETED_COMPLEX_ROLE_IDS = Object.freeze([
  'proof-or-stop-review-story-init',
  'proof-or-stop-review-scope-plan',
  'proof-or-stop-implementer',
  'proof-or-stop-review-delivery',
] as const);
export type BudgetedComplexRoleId = typeof BUDGETED_COMPLEX_ROLE_IDS[number];
export type PromptBudgetMode = 'observe';

export interface PromptBudgetObservation {
  schemaVersion: 'proof-or-stop.prompt-budget-observation.v1';
  roleId: string;
  contextMode: 'full' | 'incremental';
  mode: PromptBudgetMode;
  bytes: number;
  estimatedTokens: number;
  limitBytes: number;
  withinBudget: boolean;
  violation: 'none' | 'complex-role-budget';
  correctnessExecution: 'continue-full';
  baselineAccepted: boolean;
  reason: string;
}

export function isBudgetedComplexRole(roleId: string): roleId is BudgetedComplexRoleId {
  return (BUDGETED_COMPLEX_ROLE_IDS as readonly string[]).includes(canonicalAgentRoleId(roleId));
}

export function observeComplexRolePromptBudget(args: {
  roleId: string;
  contextMode: 'full' | 'incremental';
  bytes: number;
  estimatedTokens: number;
}): PromptBudgetObservation {
  const limitBytes = args.contextMode === 'incremental'
    ? COMPLEX_ROLE_PROMPT_BUDGETS.incrementalBytes
    : COMPLEX_ROLE_PROMPT_BUDGETS.fullBytes;
  const withinBudget = Number.isSafeInteger(args.bytes) && args.bytes <= limitBytes;
  const roleId = canonicalAgentRoleId(args.roleId);
  return {
    schemaVersion: 'proof-or-stop.prompt-budget-observation.v1',
    roleId,
    contextMode: args.contextMode,
    mode: 'observe',
    bytes: args.bytes,
    estimatedTokens: args.estimatedTokens,
    limitBytes,
    withinBudget,
    violation: withinBudget ? 'none' : 'complex-role-budget',
    correctnessExecution: 'continue-full',
    baselineAccepted: withinBudget,
    reason: withinBudget
      ? 'within complex-role prompt budget'
      : `complex-role prompt is ${args.bytes} bytes; advisory limit is ${limitBytes} bytes; continue full correctness dispatch`,
  };
}
