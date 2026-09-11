import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedBurnTokenLimit, assessManagedBurn } from '../packages/main/dist/core/managed-burn-guard.js';
import { StoryStore } from '../packages/main/dist/core/store.js';
import { runManagedHostRunWorker, submitManagedHostRun } from '../packages/main/dist/core/managed-host-run.js';
import { defaultHostRunRunner } from '../packages/main/dist/core/host-run.js';
const root = mkdtempSync(join(tmpdir(), 'managed-burn-boundaries-'));
try {
  assert.equal(managedBurnTokenLimit({}), 100000000);
  for (const raw of ['0', '-1', 'NaN', '1.5', '9007199254740992', '', ' 10']) {
    assert.throws(() => managedBurnTokenLimit({ PROOF_OR_STOP_MANAGED_BURN_TOKEN_LIMIT: raw }), /positive safe integer/);
  }
  assert.equal(assessManagedBurn(root, null, 101, 100).action, 'advisory');
  assert.equal(assessManagedBurn(root, null, 100, 100).action, 'continue');
  assert.equal(assessManagedBurn(root, null, Number.NaN, 100).action, 'advisory');
  const store = new StoryStore(root), storyId = 'B-burn-boundary';
  store.writeStory(storyId, { storyId, name: 'boundary', phase: 'DEV', createdAt: new Date().toISOString(), events: [] });
  writeFileSync(store.storyFilePath(storyId, 'convergence-progress.json'), '{invalid');
  assert.equal(assessManagedBurn(root, storyId, 101, 100).action, 'advisory', 'corrupt journal is unavailable, never stagnation');
  let worker;
  const submitted = await submitManagedHostRun({ root, cwd: root, host: 'codex', storyId: null, phase: 'DEV', agentType: 'burn-boundary',
    promptText: 'Observe the bounded fixture.', projectRootHash: 'fixture', deadlineMs: 400, timeoutMs: 1000,
    environment: { ...process.env, PROOF_OR_STOP_USAGE_LEDGER: '0', PROOF_OR_STOP_MANAGED_BURN_TOKEN_LIMIT: '100' } }, {
    launchWorker: async request => {
      worker = runManagedHostRunWorker(request, { env: { ...process.env, PROOF_OR_STOP_USAGE_LEDGER: '0', PROOF_OR_STOP_MANAGED_BURN_TOKEN_LIMIT: '1' }, heartbeatMs: 20,
        runner: plan => defaultHostRunRunner({ ...plan, command: process.execPath, argv: ['-e', "process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,output_tokens:30}})+'\\n');setInterval(()=>{},1000)"] }) });
      return { pid: process.pid };
    },
  });
  const terminal = await worker;
  assert.equal(terminal.state, 'timed_out');
  assert.equal(terminal.reason, 'absolute_deadline_exceeded', 'explicit absolute deadline stays authoritative even without stagnation');
  assert.equal(terminal.replacementSafe, true);
  assert.equal(terminal.runId, submitted.runId);
  console.log('PASS U15 threshold validation, unknown progress advisory, real deadline and process reap');
} finally { rmSync(root, { recursive: true, force: true }); }
