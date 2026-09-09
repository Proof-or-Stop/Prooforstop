import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cancelManagedHostRun, getManagedHostRunStatus, managedHostRunDirectory, managedHostRunReceipt } from '../packages/main/dist/core/managed-host-run.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'managed-autonomous-supervisor-'));
const bin = join(root, 'bin');
const marker = join(root, 'provider.json');
let runId;
try {
  mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,workerPid:process.ppid}));
process.stdin.resume();
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const submitted = spawnSync(process.execPath, [join(repository, 'packages/main/dist/cli.js'),
    '--root', root, 'host_run', JSON.stringify({host:'codex', agentType:'autonomous-supervisor-witness',
      phase:'DEV', prompt:'Exercise a real orphaned provider process.', detach:true, json:true,
      timeoutMs:90000, deadlineMs:120000})], {cwd:root, encoding:'utf8', timeout:15000,
    env:{PATH:`${bin}:${process.env.PATH}`, PROOF_OR_STOP_USAGE_LEDGER:'0'}});
  assert.equal(submitted.status, 0, `real CLI submit must succeed: ${submitted.stdout}\n${submitted.stderr}`);
  runId = JSON.parse(submitted.stdout).run.runId;
  const directory = managedHostRunDirectory(root, runId);
  const untilStarted = Date.now() + 5000;
  while (!existsSync(marker) && Date.now() < untilStarted) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(existsSync(marker), 'real provider must start before the worker crash');
  const provider = JSON.parse(readFileSync(marker, 'utf8'));
  const snapshot = JSON.parse(readFileSync(join(directory, 'snapshot.json'), 'utf8'));
  assert.equal(provider.workerPid, snapshot.workerPid, 'only the worker launched for this fixture may be killed');
  assert.equal(provider.pid, snapshot.providerIdentity.pid, 'provider identity must be durably published');
  process.kill(provider.workerPid, 'SIGKILL');
  // Observe files only. Calling status/cancel here would hide touch-driven recovery.
  const started = Date.now();
  while (!existsSync(join(directory, 'terminal.json')) && Date.now() - started < 12000) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(existsSync(join(directory, 'terminal.json')),
    'U02: orphaned worker must converge without status polling');
  const receipt = managedHostRunReceipt(root, runId);
  assert.equal(receipt.terminal.state, 'failed');
  assert.match(receipt.terminal.reason, /worker_orphaned/);
  assert.equal(receipt.terminal.replacementSafe, true, 'TERM-resistant provider must be killed and reaped');
  assert.throws(() => process.kill(provider.pid, 0), /ESRCH/, 'provider must no longer exist');
  console.log('PASS U02 autonomous worker-orphan terminal and provider cleanup without status polling');
} finally {
  if (runId) {
    await cancelManagedHostRun({root, runId, reason:'autonomous-supervisor-witness cleanup'});
    await new Promise(resolve => setTimeout(resolve, 300));
    await getManagedHostRunStatus({root, runId});
  }
  rmSync(root, {recursive:true, force:true});
}
