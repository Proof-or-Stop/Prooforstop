import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getManagedHostRunStatus, submitManagedHostRun, runManagedHostRunWorker } from '../packages/main/dist/core/managed-host-run.js';

const root = mkdtempSync(join(tmpdir(), 'managed-semantic-wait-'));
let release;
let worker;
let output;
const gate = new Promise(resolve => { release = resolve; });
try {
  const run = await submitManagedHostRun({ root, cwd: root, host: 'codex',
    phase: 'REVIEW', agentType: 'lattice-review-quality', promptText: 'Observe semantic progress.',
    deadlineMs: 5000, projectRootHash: 'sha256:test-root' }, {
    launchWorker: request => {
      worker = runManagedHostRunWorker(request, { heartbeatMs: 10, cancelPollMs: 10,
        env: { PROOF_OR_STOP_USAGE_LEDGER: '0' }, runner: async plan => {
          output = () => plan.onChunk?.({ stream: 'stdout', text: 'real provider output\n' });
          await gate;
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
        } });
      return { pid: process.pid };
    }, claimTimeoutMs: 1000, claimPollMs: 5,
  });
  const before = await getManagedHostRunStatus({ root, runId: run.runId });
  const quiet = await getManagedHostRunStatus({ root, runId: run.runId,
    afterGeneration: before.run.generation, waitMs: 150 });
  assert.equal(quiet.changed, false, 'U02: heartbeat must not wake semantic wait');
  assert.notEqual(quiet.run.workerHeartbeatAt, before.run.workerHeartbeatAt,
    'diagnostic heartbeat still advances while semantic revision stays stable');
  assert.equal(quiet.run.lastProviderProgressAt, before.run.lastProviderProgressAt);
  output();
  const progress = await getManagedHostRunStatus({ root, runId: run.runId,
    afterGeneration: quiet.run.generation, waitMs: 150 });
  assert.equal(progress.changed, true, 'real provider output wakes the wait');
  release();
  await worker;
  const terminal = await getManagedHostRunStatus({ root, runId: run.runId,
    afterGeneration: progress.run.generation, waitMs: 150 });
  assert.equal(terminal.run.state, 'completed');
  assert.ok(terminal.receipt, 'terminal notification retains its authoritative receipt');
  console.log('PASS U02 managed-semantic-wait');
} finally {
  release();
  await worker;
  rmSync(root, { recursive: true, force: true });
}
