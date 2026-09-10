import { CANONICAL_REVIEW_HOSTS } from './host-execution-readiness.js';
import { opendirSync } from 'node:fs';
import { managedHostRunsRoot, readManagedHostRunProjection } from './managed-host-run.js';
import { MANAGED_RUN_DASHBOARD_POLICY } from './runtime-fact-registry.js';

/** Public operational fields only: never provider output, credentials or raw errors. */
export interface ManagedRunDashboardView {
  runId: string; storyId: string | null; host: string; state: string;
  stage: { number: number; total: number; name: string };
  queueReason: string | null;
  lastProviderProgressAt: string | null;
  durationEstimate: { kind: 'historical' | 'unavailable'; sampleCount: number; estimatedTerminalAt?: string };
  terminal: null | { digest: string; state: string; reason: string; terminalAt: string };
}
export interface ManagedRunDashboard {
  runs: ManagedRunDashboardView[];
  diagnostics: string[];
}

/** Polling this projection never recovers, renews a lease or changes a run. */
export function readManagedRunDashboard(root: string): ManagedRunDashboard {
  const result: ManagedRunDashboard = { runs: [], diagnostics: [] };
  let directory;
  try { directory = opendirSync(managedHostRunsRoot(root)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.diagnostics.push('managed_runtime_unavailable');
    return result;
  }
  try {
    const budget = { remainingBytes: MANAGED_RUN_DASHBOARD_POLICY.maxScanBytes, exhausted: false };
    let entry, count = 0;
    while ((entry = directory.readSync())) {
      if (++count > MANAGED_RUN_DASHBOARD_POLICY.maxDirectoryEntries) {
        result.diagnostics.push('managed_runtime_scan_limit'); break;
      }
      if (!entry.isDirectory()) {
        if (entry.isSymbolicLink()) result.diagnostics.push('invalid_managed_run');
        continue;
      }
      try {
        const run = readManagedHostRunProjection(root, entry.name, budget);
        const validTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
        if (!['submitted','running','completed','failed','cancelled','timed_out'].includes(run.state)
          || !CANONICAL_REVIEW_HOSTS.includes(run.host)
          || (run.storyId !== null && typeof run.storyId !== 'string')
          || (run.lastProviderProgressAt !== null && !validTime(run.lastProviderProgressAt))
          || !Number.isSafeInteger(run.durationEstimate.sampleCount) || run.durationEstimate.sampleCount < 0
          || (run.durationEstimate.kind !== 'historical_estimate' && run.durationEstimate.kind !== 'unavailable')
          || (run.durationEstimate.kind === 'historical_estimate' && !validTime(run.durationEstimate.estimatedTerminalAt))
          || (run.terminal && !validTime(run.terminal.terminalAt))) throw new Error('invalid public runtime shape');
        result.runs.push({
          runId: run.runId, storyId: run.storyId, host: run.host, state: run.state,
          stage: run.stage,
          // No inferred queue explanation or heartbeat-derived progress.
          queueReason: run.state === 'submitted' ? 'awaiting_worker' : null,
          lastProviderProgressAt: run.lastProviderProgressAt,
          durationEstimate: run.durationEstimate.kind === 'historical_estimate'
            ? { kind: 'historical', sampleCount: run.durationEstimate.sampleCount,
                estimatedTerminalAt: run.durationEstimate.estimatedTerminalAt }
            : { kind: 'unavailable', sampleCount: run.durationEstimate.sampleCount },
          terminal: run.terminal && run.terminalDigest ? { digest: run.terminalDigest,
            state: run.terminal.state, reason: run.terminal.state, terminalAt: run.terminal.terminalAt } : null,
        });
      } catch {
        if (budget.exhausted) { result.diagnostics.push('managed_runtime_scan_limit'); break; }
        result.diagnostics.push('invalid_managed_run');
      }
    }
  } finally { directory.closeSync(); }
  result.runs.sort((a,b) => a.runId.localeCompare(b.runId));
  result.diagnostics = [...new Set(result.diagnostics)];
  return result;
}
