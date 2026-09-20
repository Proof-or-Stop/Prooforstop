/** Shared cumulative quota, independent from concurrency and per-plan meters. */
import { captureHostRunBudgetEnvironment, restoreHostRunBudgetEnvironment, reserveHostRunBudgetAttempts, settleHostRunBudget, type HostRunBudgetReservation } from './host-run-budget.js';
import type { ProviderExecRequest, ProviderExecResult } from '../providers/types.js';
import type { SupervisedProcessOptions } from '../providers/supervised-process.js';

// Only live object identity can delegate an already-reserved attempt. JSON,
// environment flags and copied request objects cannot forge this exemption.
const ownedRequests = new WeakSet<object>();
const coveredTransports = new WeakSet<object>();
function settle(reservations: HostRunBudgetReservation[] | null, used: number | null): void {
  for (const [i, reservation] of (reservations ?? []).entries()) {
    try { settleHostRunBudget(reservation, used !== null && i >= used
      ? { spawned: false, recorded: 'none', input: null, cacheRead: null, output: null }
      : null); } catch (error) {
      // Accounting failure must retain the charge and the original execution outcome.
      try { process.stderr.write(`host_run_budget_settlement_failed: ${String(error)}\n`); } catch { /* preserve outcome */ }
    }
  }
}

export function runWithProviderCallBudget<T>(root: string, env: NodeJS.ProcessEnv, prompt: string, run: () => T): T {
  const reservations = reserveHostRunBudgetAttempts(root, env, prompt, 1);
  try { return run(); } finally { settle(reservations, null); }
}
export async function runWithProviderCallBudgetAsync<T>(root: string, env: NodeJS.ProcessEnv, prompt: string, run: () => Promise<T>): Promise<T> {
  const reservations = reserveHostRunBudgetAttempts(root, env, prompt, 1);
  try { return await run(); } finally { settle(reservations, null); }
}

export function runBudgetedProviderRequest(request: ProviderExecRequest, run: (request: ProviderExecRequest) => ProviderExecResult): ProviderExecResult {
  if (ownedRequests.has(request)) return run(request);
  const childEnv = restoreHostRunBudgetEnvironment(request.env, captureHostRunBudgetEnvironment(request.budgetEnv ?? request.env));
  const reservations = reserveHostRunBudgetAttempts(request.budgetRoot ?? request.cwd,
    request.budgetEnv ?? request.env, request.stdin ?? JSON.stringify(request.argv), Math.max(1, Math.min(request.maxAttempts, 5)));
  const admitted = { ...request, maxAttempts: reservations?.length ?? request.maxAttempts };
  // Keep this non-secret task quota in the child projection for nested owned CLI
  // calls. Do not copy credentials or other unredacted parent environment values.
  admitted.env = childEnv;
  ownedRequests.add(admitted);
  let used: number | null = null;
  try {
    const result = run(admitted);
    if (Number.isSafeInteger(result.attempts) && result.attempts >= 1 && result.attempts <= admitted.maxAttempts) used = result.attempts;
    return result;
  } finally { ownedRequests.delete(admitted); settle(reservations, used); }
}

/** Delegate only the current synchronous transport call to the supervisor. */
export function runCoveredProviderTransport<T>(request: ProviderExecRequest, options: SupervisedProcessOptions, run: () => T): T {
  if (!ownedRequests.has(request)) throw new Error('provider quota delegation without live request');
  coveredTransports.add(options);
  try { return run(); } finally { coveredTransports.delete(options); }
}
export function runBudgetedSupervisedProcess<T>(options: SupervisedProcessOptions, argv: string[], run: () => T): T {
  if (coveredTransports.has(options)) return run();
  return runWithProviderCallBudget(options.budgetRoot ?? options.cwd, options.budgetEnv ?? options.env,
    options.stdin ?? JSON.stringify(argv), run);
}
