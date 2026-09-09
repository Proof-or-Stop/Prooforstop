import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultHostRunRunner } from '../core/host-run.js';
import { submitManagedHostRun, runManagedHostRunWorker, managedHostRunDirectory, type ManagedHostRunTerminal } from '../core/managed-host-run.js';

/** Real isolated provider process; canonical progress authority comes from the enclosing inventory fixture. */
export async function runManagedBurnFixture(root: string, storyId: string, stalled: boolean, mode: 'running' | 'closed' | 'sealed-limit' = 'running'): Promise<void> {
  let worker!: Promise<ManagedHostRunTerminal>;
  const execute = (request: Parameters<typeof runManagedHostRunWorker>[0]) => runManagedHostRunWorker(request, {
    env: { ...process.env, PROOF_OR_STOP_USAGE_LEDGER: '0', PROOF_OR_STOP_MANAGED_BURN_TOKEN_LIMIT: mode === 'sealed-limit' ? '1' : '1000' }, heartbeatMs: mode === 'closed' ? 1000 : 30,
    runner: async plan => {
      const result = await defaultHostRunRunner({ ...plan, command: process.execPath,
      argv: ['-e', `process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:20,output_tokens:30}})+'\\n');setTimeout(()=>process.exit(0),${mode === 'closed' ? 0 : stalled && mode !== 'sealed-limit' ? 8000 : 300});`] });
      if (mode === 'closed') {
        assert.equal(result.closeObserved, true, 'fixture must observe the real child close');
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
      return result;
    },
  });
  const submitted = await submitManagedHostRun({ root, cwd: root, host: 'codex', storyId, phase: 'REVIEW',
    agentType: 'burn-fixture', promptText: 'Inspect the fixture without changing it.', projectRootHash: 'fixture',
    environment: { ...process.env, PROOF_OR_STOP_USAGE_LEDGER: '0', PROOF_OR_STOP_MANAGED_BURN_TOKEN_LIMIT: mode === 'sealed-limit' ? '200' : '100' },
    deadlineMs: 15000, timeoutMs: 15000 }, { launchWorker: async value => { worker = execute(value); return { pid: process.pid }; } });
  const terminal = await worker;
  if (mode === 'closed') {
    assert.equal(terminal.state, 'completed', 'U15 burn after actual provider close must not override completed result');
    assert.equal(existsSync(join(managedHostRunDirectory(root, submitted.runId), 'cancel-request.json')), false,
      'close must prevent the late cancellation itself, including crash-recovery input');
  }
  const expectStop = stalled && mode === 'running';
  assert.equal(terminal.state, expectStop ? 'cancelled' : 'completed', 'U15 verified stagnant high-burn run must stop while converging high-burn run continues');
  if (expectStop) assert.equal(terminal.reason, 'burn_without_effective_progress');
  assert.equal(terminal.replacementSafe, true, 'provider process group must be reaped before terminal reuse');
  assert.equal(terminal.runId, submitted.runId);
  console.log(`PASS U15 actual managed provider ${expectStop ? 'stopped after verified stagnation' : `continued (${mode})`} and reaped`);
}
