import type { JobBudgetPolicy, JobPlan, JobStopPolicy, PlannerPolicy } from './planner.js';
import { PLANNED_PROVIDER_BUDGET_RUNTIME_POLICY } from './runtime-fact-registry.js';

// Budget metering for the bounded Stage B / planner executor (X6 + §B5 stopPolicy).
//
// Complete unattended mode must be bounded by cost AND time. This module is the
// single, side-effect-free meter the executor uses to track token/cost, provider
// call, and wall-clock usage from planner/provider/executor step events and to
// decide a fail-closed `budget_exceeded` stop. It owns NO I/O: it reads structured
// step summaries and a clock, and returns a structured report. The executor is the
// only enforcement point; this keeps the budget rules in one auditable place.
//
// Budget rules (X6):
// - known token and cost usage is recorded in `budgetUsage`;
// - unknown token usage still consumes provider-call and wall-clock budgets;
// - budget exhaustion stops `blocked` and must NOT trigger provider fallback, extra
//   review waves, recursive redevelopment planning, or silent scope reduction.

/** The single canonical stop reason for a budget-bounded stop (asserted by gates/tests). */
export const BUDGET_EXCEEDED_STOP_REASON = 'budget_exceeded';

export interface BudgetLimits {
  /** Wall-clock ceiling in ms. `<= 0` disables the wall-clock budget. */
  maxWallClockMs: number;
  /** Token-or-cost ceiling in provider-reported units. `<= 0` disables it. */
  maxTokenOrCostBudget: number;
  /** Provider-call ceiling. `<= 0` disables it. */
  maxProviderCalls: number;
}

export type BudgetDimension = 'wall_clock' | 'provider_calls' | 'token_or_cost';

export interface BudgetUsage {
  /** Elapsed wall-clock since the meter was created, in ms. */
  wallClockMs: number;
  /** Accumulated known token/cost units from provider events. */
  tokenOrCost: number;
  /** False until at least one provider event reported a known token/cost number. */
  tokenOrCostKnown: boolean;
  /** Count of executed `provider.*` steps (real or fake). */
  providerCalls: number;
  /** Total executed steps the meter observed. */
  steps: number;
}

export interface BudgetReport {
  limits: BudgetLimits;
  usage: BudgetUsage;
  exceeded: boolean;
  /** Which dimension tripped first, or null when within budget. */
  exceededDimension: BudgetDimension | null;
  /** `budget_exceeded` when exceeded, else null. */
  stopReason: typeof BUDGET_EXCEEDED_STOP_REASON | null;
  /** Operator next action when exceeded, else null. */
  nextAction: string | null;
}

/** A minimal structural view of an executed step the meter needs (decoupled from the executor type). */
export interface BudgetStepEvent {
  type: string;
  summary?: Record<string, unknown>;
}

export interface BudgetMeter {
  /** Record one executed step event (provider call counting + known token/cost accrual). */
  recordStep(step: BudgetStepEvent): void;
  /** Current usage snapshot (recomputes wall-clock from the injected clock). */
  usage(): BudgetUsage;
  /** Evaluate usage against the limits into a structured report. */
  evaluate(): BudgetReport;
  /** Pre-transport allowance; execution is synchronous and records before the next admission. */
  providerAllowance(attempts: number, timeoutMs: number): { attempts: number; timeoutMs: number; report: BudgetReport };
}

/** Defensive normalization (Handler encoding convention): any non-positive / non-finite limit means "no limit". */
function normLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** A known, non-negative numeric cost from a step summary field, or null when absent/unknown. */
function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Provider events may report `costUnits` (preferred) or `tokensUsed`; anything else is unknown. */
function extractStepCost(summary: Record<string, unknown> | undefined): number | null {
  if (!summary || typeof summary !== 'object') return null;
  const cost = numeric(summary.costUnits);
  if (cost !== null) return cost;
  return numeric(summary.tokensUsed);
}

/** Reduce-only merge: a CLI/override limit may only TIGHTEN (never expand) a plan limit. 0 = no constraint. */
function tighter(base: number, override: number): number {
  const a = base > 0;
  const b = override > 0;
  if (a && b) return Math.min(base, override);
  return a ? base : b ? override : 0;
}

/** Build budget limits straight from planner policy (+ stopPolicy wall-clock fallback). */
export function budgetLimitsFromPolicy(
  policy: Pick<PlannerPolicy, 'maxWallClockMs' | 'maxTokenOrCostBudget' | 'maxProviderCalls'>,
  stopPolicy?: Pick<JobStopPolicy, 'maxWallClockMs'>,
): BudgetLimits {
  return {
    maxWallClockMs: normLimit(policy.maxWallClockMs ?? stopPolicy?.maxWallClockMs),
    maxTokenOrCostBudget: normLimit(policy.maxTokenOrCostBudget),
    maxProviderCalls: normLimit(policy.maxProviderCalls),
  };
}

/**
 * Resolve the effective budget limits for a JobPlan. Reads the plan's `budgetPolicy`
 * (defensively, since legacy/hand-built plans may omit it), falls back to
 * `stopPolicy.maxWallClockMs` for the wall-clock bound, then applies an optional
 * reduce-only override (CLI safety limits may only tighten the job's budget, §B9).
 */
export function resolveBudgetLimits(jobPlan: JobPlan, override?: Partial<BudgetLimits>): BudgetLimits {
  const bp = (jobPlan as { budgetPolicy?: Partial<JobBudgetPolicy> }).budgetPolicy;
  const stopWall = (jobPlan as { stopPolicy?: Partial<JobStopPolicy> }).stopPolicy?.maxWallClockMs;
  const base: BudgetLimits = {
    maxWallClockMs: normLimit(bp?.maxWallClockMs ?? stopWall),
    maxTokenOrCostBudget: normLimit(bp?.maxTokenOrCostBudget),
    maxProviderCalls: normLimit(bp?.maxProviderCalls),
  };
  if (!override) return base;
  return {
    maxWallClockMs: tighter(base.maxWallClockMs, normLimit(override.maxWallClockMs)),
    maxTokenOrCostBudget: tighter(base.maxTokenOrCostBudget, normLimit(override.maxTokenOrCostBudget)),
    maxProviderCalls: tighter(base.maxProviderCalls, normLimit(override.maxProviderCalls)),
  };
}

function budgetNextAction(dimension: BudgetDimension, limits: BudgetLimits, usage: BudgetUsage): string {
  const detail =
    dimension === 'wall_clock'
      ? `wall-clock ${usage.wallClockMs}ms exceeded the ${limits.maxWallClockMs}ms budget (plannerPolicy.maxWallClockMs / stopPolicy.maxWallClockMs)`
      : dimension === 'provider_calls'
        ? `provider calls ${usage.providerCalls} exceeded the ${limits.maxProviderCalls}-call budget (plannerPolicy.maxProviderCalls)`
        : `token/cost usage ${usage.tokenOrCost} exceeded the ${limits.maxTokenOrCostBudget} budget (plannerPolicy.maxTokenOrCostBudget)`;
  return (
    `Budget exceeded: ${detail}. The run stops blocked — budget exhaustion never triggers provider ` +
    `fallback, extra review waves, or silent scope reduction. Raise the relevant budget and rerun, or ` +
    `split the request into smaller bounded scopes.`
  );
}

/**
 * Create a budget meter bound to the given limits and clock. The clock is injected
 * (same `() => Date` seam the executor uses) so deterministic tests can advance time
 * without real sleeping. Wall-clock usage is measured from meter creation.
 */
export function createBudgetMeter(limits: BudgetLimits, now: () => Date = () => new Date()): BudgetMeter {
  const startMs = now().getTime();
  let tokenOrCost = 0;
  let tokenOrCostKnown = false;
  let providerCalls = 0;
  let steps = 0;

  function recordStep(step: BudgetStepEvent): void {
    steps += 1;
    if (typeof step.type === 'string' && step.type.startsWith('provider.')) {
      const attempts = numeric(step.summary?.providerAttempts);
      providerCalls += attempts === null ? 1 : Math.floor(attempts);
    }
    const cost = extractStepCost(step.summary);
    if (cost !== null) {
      tokenOrCost += cost;
      tokenOrCostKnown = true;
    }
  }

  function usage(): BudgetUsage {
    return {
      wallClockMs: Math.max(0, now().getTime() - startMs),
      tokenOrCost,
      tokenOrCostKnown,
      providerCalls,
      steps,
    };
  }

  function evaluate(): BudgetReport {
    const current = usage();
    // Precedence: time is the hardest bound, then provider calls, then token/cost.
    let dimension: BudgetDimension | null = null;
    if (limits.maxWallClockMs > 0 && current.wallClockMs > limits.maxWallClockMs) {
      dimension = 'wall_clock';
    } else if (limits.maxProviderCalls > 0 && current.providerCalls > limits.maxProviderCalls) {
      dimension = 'provider_calls';
    } else if (limits.maxTokenOrCostBudget > 0 && current.tokenOrCost > limits.maxTokenOrCostBudget) {
      dimension = 'token_or_cost';
    }
    const exceeded = dimension !== null;
    return {
      limits,
      usage: current,
      exceeded,
      exceededDimension: dimension,
      stopReason: exceeded ? BUDGET_EXCEEDED_STOP_REASON : null,
      nextAction: exceeded ? budgetNextAction(dimension as BudgetDimension, limits, current) : null,
    };
  }

  function providerAllowance(requestedAttempts: number, requestedTimeoutMs: number) {
    const report = evaluate();
    const current = report.usage;
    const remainingCalls = limits.maxProviderCalls > 0 ? Math.max(0, limits.maxProviderCalls - current.providerCalls) : Infinity;
    const remainingMs = limits.maxWallClockMs > 0 ? Math.max(0, limits.maxWallClockMs - current.wallClockMs) : Infinity;
    const minimum = PLANNED_PROVIDER_BUDGET_RUNTIME_POLICY.minimumAttemptTimeoutMs;
    const requested = Number.isFinite(requestedAttempts) && requestedAttempts > 0 ? Math.floor(requestedAttempts) : 1;
    let attempts = Math.min(Math.max(1, requested), remainingCalls, Math.floor(remainingMs / minimum));
    let dimension = report.exceededDimension;
    if (remainingMs < minimum) dimension = 'wall_clock';
    else if (remainingCalls < 1) dimension = 'provider_calls';
    else if (limits.maxTokenOrCostBudget > 0 && current.tokenOrCost >= limits.maxTokenOrCostBudget) dimension = 'token_or_cost';
    if (dimension !== null) {
      attempts = 0;
      Object.assign(report, { exceeded: true, exceededDimension: dimension, stopReason: BUDGET_EXCEEDED_STOP_REASON,
        nextAction: `Budget exhausted before provider launch (${dimension}). The run stops blocked; never triggers provider fallback or extra review waves.` });
    }
    const requestedTimeout = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs >= minimum ? Math.floor(requestedTimeoutMs) : minimum;
    const timeoutMs = attempts > 0 ? Math.min(requestedTimeout, Math.floor(remainingMs / attempts)) : 0;
    return { attempts, timeoutMs, report };
  }
  return { recordStep, usage, evaluate, providerAllowance };
}
