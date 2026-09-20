// Explicit experimental baseline, NOT a replica of the whole production host.
// Observation uses the existing 0.3.425 filter; dispatch/context model the
// uncontrolled paths proposed for this bounded Lab experiment.
import { createMonitor } from '../benchmark-monitor-change-filter/policy.mjs';

export function createController() {
  const monitor = createMonitor();
  const records = [];
  return {
    observe(event) { return monitor.observe(event); },
    async run(request, execute) {
      try {
        const result = await execute({ signal: new AbortController().signal });
        records.push({ source: request.source, ...result });
        return { status: 'completed', result };
      } catch (error) { return { status: 'failed', error: error.message }; }
    },
    context(state, history) { return JSON.stringify({ state, history }); },
    ledger() { return structuredClone(records); },
  };
}
