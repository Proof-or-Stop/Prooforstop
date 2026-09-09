import assert from 'node:assert/strict';
import { defaultHostRunRunner } from '../core/host-run.js';
import { submitManagedHostRun, runManagedHostRunWorker, type ManagedHostRunTerminal } from '../core/managed-host-run.js';

/** Real isolated provider process; canonical progress authority comes from the enclosing inventory fixture. */
export async function runManagedBurnFixture(root: string, storyId: string, stalled: boolean): Promise<void> {
  let worker!: Promise<ManagedHostRunTerminal>;
  const execute = (request: Parameters<typeof runManagedHostRunWorker>[0]) => runManagedHostRunWorker(request, {
    env: { ...process.env, PROOF_OR_STOP_USAGE_LEDGER: '0' }, heartbeatMs: 30,
    runner: plan => defaultHostRunRunner({ ...plan, command: process.execPath,
      argv: ['-e', `process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:20,output_tokens:30}})+'\\n');setTimeout(()=>process.exit(0),${stalled ? 8000 : 300});`] }),
  });
  const submitted = await submitManagedHostRun({ root, cwd: root, host: 'codex', storyId, phase: 'REVIEW',
    agentType: 'burn-fixture', promptText: 'Inspect the fixture without changing it.', projectRootHash: 'fixture',
    environment: { ...process.env, PROOF_OR_STOP_USAGE_LEDGER: '0', PROOF_OR_STOP_MANAGED_BURN_TOKEN_LIMIT: '100' },
    deadlineMs: 15000, timeoutMs: 15000 }, { launchWorker: async value => { worker = execute(value); return { pid: process.pid }; } });
  const terminal = await worker;
  assert.equal(terminal.state, stalled ? 'cancelled' : 'completed', 'U15 verified stagnant high-burn run must stop while converging high-burn run continues');
  if (stalled) assert.equal(terminal.reason, 'burn_without_effective_progress');
  assert.equal(terminal.replacementSafe, true, 'provider process group must be reaped before terminal reuse');
  assert.equal(terminal.runId, submitted.runId);
  console.log(`PASS U15 actual managed provider ${stalled ? 'stopped after verified stagnation' : 'continued with progress'} and reaped`);
}
