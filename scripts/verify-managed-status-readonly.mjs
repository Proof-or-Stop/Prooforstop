import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getManagedHostRunStatus, managedHostRunDirectory, runManagedHostRunWorker, submitManagedHostRun } from '../packages/main/dist/core/managed-host-run.js';

const root = mkdtempSync(join(tmpdir(), 'managed-status-readonly-'));
let finish;
let worker;
function manifest(path) {
  return readdirSync(path).sort().map(name => {
    const file = join(path, name);
    const stat = statSync(file);
    return [name, stat.mtimeMs, stat.isDirectory() ? manifest(file) : readFileSync(file).toString('base64')];
  });
}
try {
  const run = await submitManagedHostRun({root, cwd:root, host:'codex', phase:'DEV',
    agentType:'readonly-witness', promptText:'Observe a running provider without controlling it.',
    timeoutMs:60000, deadlineMs:60000}, {
    launchWorker:async request => {
      worker = runManagedHostRunWorker(request, {heartbeatMs:60000,
        runner:async () => new Promise(resolve => { finish = resolve; })});
      return {pid:process.pid};
    }, claimTimeoutMs:2000,
  });
  assert.equal(run.state, 'running');
  assert.equal(typeof finish, 'function');
  const directory = managedHostRunDirectory(root, run.runId);
  const before = manifest(directory);
  const status = await getManagedHostRunStatus({root, runId:run.runId, waitMs:0,
    now:() => Date.parse(run.deadlineAt) + 1000});
  assert.deepEqual(manifest(directory), before,
    'U02: status observation must not write runtime files or acquire recovery locks even after deadline');
  assert.equal(status.run.state, 'running', 'only the supervision owner may publish a terminal');
  console.log('PASS U02 status observation preserves runtime bytes and metadata after deadline');
} finally {
  finish?.({stdout:'', stderr:'', exitCode:0, timedOut:false, terminalReason:'completed'});
  await worker;
  rmSync(root, {recursive:true, force:true});
}
