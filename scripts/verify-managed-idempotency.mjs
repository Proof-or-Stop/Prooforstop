import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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
  const moduleUrl = new URL('../packages/main/dist/core/managed-host-run.js', import.meta.url).href;
  const restarted = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {submitManagedHostRun} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await submitManagedHostRun(JSON.parse(process.argv[1]), {launchWorker:()=>{throw new Error('duplicate launch')}})));`,
    JSON.stringify(args)], { encoding: 'utf8', timeout: 5000 }));
  assert.equal(restarted.runId, first.runId, 'fresh process recovers the durable identity');
  assert.equal(restarted.state, 'completed');
  assert.equal(launches, 1);
  const formal = { ...args, idempotencyKey: undefined, profile: 'managed_reviewer',
    storyId: 'B-idempotent', reviewRunId: 'B-idempotent:RR-001',
    lane: 'lattice-review-quality', agentType: 'lattice-review-quality',
    reviewBinding: { headHash: 'head', materialHash: 'material', storyFilesHash: 'story', promptHash: 'prompt', envelopeId: null } };
  const one = await submitManagedHostRun(formal, deps);
  const two = await submitManagedHostRun(formal, deps);
  assert.equal(one.runId, two.runId, 'formal reviews deduplicate without caller keys');
  await assert.rejects(submitManagedHostRun({ ...formal, idempotencyKey: 'bypass' }, deps), /idempotency.*conflict/);
  assert.equal(launches, 2, 'caller key cannot bypass the formal review tuple');
  console.log('PASS U02 managed-idempotency');
} finally { release(); await Promise.all(workers); rmSync(root, { recursive: true, force: true }); }
