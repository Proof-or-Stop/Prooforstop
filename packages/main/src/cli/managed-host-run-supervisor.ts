import { runManagedHostRunSupervisor } from '../core/managed-host-run.js';

// Internal detached owner. It receives no prompt, provider credential, or review
// signing capability; it can only reconcile this already sealed run.
const [root, runId] = process.argv.slice(2);
if (!root || !runId) throw new Error('managed supervisor requires root and runId');
runManagedHostRunSupervisor({ root, runId }, () => {
  process.send?.({ type: 'managed-supervisor-ready', runId });
}).catch(error => {
  console.error(`managed supervisor: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
