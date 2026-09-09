import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { submitManagedHostRun, runManagedHostRunWorker } from '../packages/main/dist/core/managed-host-run.js';
const root = mkdtempSync(join(tmpdir(), 'managed-idempotency-'));
let launches = 0;
const workers = [];
let release;
const gate = new Promise(resolve => { release = resolve; });
const args = { root, cwd: root, host: 'codex', storyId: null, phase: 'DEV',
  agentType: 'implementer', promptText: 'One logical request.', deadlineMs: 5000,
  projectRootHash: 'sha256:test', idempotencyKey: 'same-request-after-restart' };
const deps = { launchWorker: request => {
  launches++;
  workers.push(runManagedHostRunWorker(request, {
    env: { PROOF_OR_STOP_USAGE_LEDGER: '0' }, runner: async () => {
      await gate;
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
    },
  }));
  return { pid: process.pid };
}, claimTimeoutMs: 1000, claimPollMs: 5 };
try {
  const [first, concurrent] = await Promise.all([submitManagedHostRun(args, deps), submitManagedHostRun(args, deps)]);
  assert.equal(first.runId, concurrent.runId, 'U02: duplicate logical submission must reuse durable runId');
  assert.equal(launches, 1);
  await assert.rejects(submitManagedHostRun({ ...args, promptText: 'Changed authority' }, deps), /idempotency.*conflict/);
  release(); await Promise.all(workers);
  const retry = await submitManagedHostRun(args, { launchWorker: () => { throw new Error('must not dispatch'); } });
  assert.equal(retry.runId, first.runId);
  assert.equal(retry.state, 'completed', 'terminal retry returns the original result');
  assert.equal(launches, 1);
  console.log('PASS U02 managed-idempotency');
} finally { release(); await Promise.all(workers); rmSync(root, { recursive: true, force: true }); }
