import './lab-source-loader.mjs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText };
  return next(url, context);
} });
const { submitManagedHostRun, runManagedHostRunWorker, getManagedHostRunStatus } =
  await import('../packages/main/src/core/managed-host-run.ts');

if (process.argv[2] === '--reopen') {
  let launches = 0;
  const result = await submitManagedHostRun(JSON.parse(process.argv[3]), {
    launchWorker: async () => { launches++; throw new Error('Duplicate worker after client restart'); },
  });
  console.log(JSON.stringify({ runId: result.runId, state: result.state, launches }));
} else {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-managed-entry-'));
  let worker;
  let release;
  try {
    let launches = 0; let providerCalls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const args = { root, cwd: root, host: 'codex', storyId: null, phase: 'DEV',
      agentType: 'lab-regression', promptText: 'Bounded durable execution test',
      projectRootHash: 'sha256:lab', profile: null, environment: {},
      deadlineMs: 10000, idempotencyKey: 'same-bounded-execution' };
    const deps = { claimTimeoutMs: 2000, claimPollMs: 5, launchWorker: async request => {
      launches++;
      worker = runManagedHostRunWorker(request, { env: {}, runner: async () => {
        providerCalls++; await gate;
        return { stdout: JSON.stringify({ type: 'turn.completed', usage: {
          input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } }) + '\n',
          stderr: '', exitCode: 0, timedOut: false, replacementSafe: true };
      } });
      return { pid: process.pid };
    } };
    const [a, b] = await Promise.all([submitManagedHostRun(args, deps), submitManagedHostRun(args, deps)]);
    assert.equal(a.runId, b.runId);
    const beforeWait = providerCalls;
    const observer = getManagedHostRunStatus({ root, runId: a.runId, afterGeneration: a.generation, waitMs: 1000 });
    release(); await worker; await observer;
    for (let i = 0; i < 20; i++) await getManagedHostRunStatus({ root, runId: a.runId });
    const reopened = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--reopen', JSON.stringify(args)], {
      encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    assert.equal(reopened.runId, a.runId); assert.equal(reopened.launches, 0);
    assert.equal(reopened.state, 'completed'); assert.equal(launches, 1); assert.equal(providerCalls, 1);
    assert.equal(providerCalls - beforeWait, 0);
    console.log('MANAGED_MEASUREMENTS ' + JSON.stringify({ concurrentSubmissions: 2, durableRuns: 1,
      workerLaunches: launches, interceptedProviderCalls: providerCalls, extraCallsWhileWaitingAndReading: providerCalls-beforeWait,
      statusReads: 20, launchesAfterNewClientProcess: reopened.launches,
      scope: 'actual managed-host-run source, explicit idempotency key, intercepted paid transport; not desktop scheduler' }));
  } finally { release?.(); if (worker) await worker; rmSync(root, { recursive: true, force: true }); }
}
