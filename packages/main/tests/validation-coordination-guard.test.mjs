import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createFixtureMachineEnvironment } from '../dist/tasks/helpers/fixture-machine-environment.js';
import { withWorkspaceValidationCapacity, validationCapacityLockPath } from '../dist/core/validation-execution-lock.js';
import { createQuorumSmokeProtectedMutationGuard } from '../dist/tasks/quorum-submit-smoke-worker.js';

if (!process.argv.includes('--private-machine')) {
  const fixture = createFixtureMachineEnvironment();
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--private-machine'], {
    env: fixture.env, stdio: 'inherit', timeout: 30000,
  });
  if (result.status === 0) fixture.cleanup();
  else console.error('Coordination fixture retained: ' + fixture.root);
  process.exit(result.status ?? 1);
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'validation-coordination-guard-')));
const roots = [root];
const freshRoot = () => { const value = realpathSync(mkdtempSync(join(tmpdir(), 'validation-coordination-boundary-'))); roots.push(value); return value; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const options = { root, workspaceRoot: root, command: 'coordination-guard-regression', deadlineAt: Date.now() + 20000 };
try {
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, '.gitignore'), '.proof-or-stop/\n');
  writeFileSync(join(root, 'subject.txt'), 'unchanged\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Lab', '-c', 'user.email=lab@example.test', 'commit', '-qm', 'fixture']);
  await withWorkspaceValidationCapacity(options, async () => {
    const guard = createQuorumSmokeProtectedMutationGuard([root]);
    await delay(2200); // Observe at least one actual parent capacity heartbeat.
    const witness = await guard.close();
    assert.equal(witness.clean, true, 'VALIDATION_PARENT_COORDINATION_FALSE_MUTATION: ' + JSON.stringify(witness));
  });
  const legacy = validationCapacityLockPath(root);
  assert.equal(lstatSync(legacy).isSymbolicLink(), true, 'legacy callers must retain one shared queue through the compatibility path');
  assert.ok(relative(root, realpathSync(legacy)).startsWith('..'), 'physical coordination must be outside the protected root');

  for (const path of ['subject.txt', '.proof-or-stop/real-write.txt']) {
    await withWorkspaceValidationCapacity(options, async () => {
      const guard = createQuorumSmokeProtectedMutationGuard([root]);
      const target = join(root, path); const original = path === 'subject.txt' ? readFileSync(target) : undefined;
      writeFileSync(target, 'real forbidden write\n');
      await delay(50);
      if (original) writeFileSync(target, original); else rmSync(target);
      const witness = await guard.close();
      assert.equal(witness.stateMatched, true, 'negative restores final bytes');
      assert.equal(witness.clean, false, 'real write-and-restore must still reject: ' + path);
    });
  }

  // An old queue participant writes through its original path. No new queue
  // may bypass this live, exclusive ticket after relocation.
  const holder = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { holder.once('spawn', resolve); holder.once('error', reject); });
  const lockId = randomUUID(); const ticket = join(legacy, `0000000000000001-${lockId}.ticket`);
  mkdirSync(ticket);
  writeFileSync(join(ticket, 'holder.json'), JSON.stringify({ lockId, pid: holder.pid, hostname: hostname(), command: 'legacy participant', acquiredAt: new Date().toISOString() }));
  try {
    let entered = false;
    const waiting = withWorkspaceValidationCapacity(options, () => { entered = true; });
    await delay(150); assert.equal(entered, false, 'legacy ticket must block the relocated queue');
    rmSync(ticket, { recursive: true }); await waiting;
    assert.equal(entered, true);
  } finally { holder.kill('SIGTERM'); await new Promise(resolve => holder.once('close', resolve)); rmSync(ticket, { recursive: true, force: true }); }
  const blocked = freshRoot(); const blockedPath = validationCapacityLockPath(blocked);
  mkdirSync(blockedPath, { recursive: true });
  writeFileSync(join(blockedPath, 'unknown-owner'), 'preserve unknown coordination state');
  await assert.rejects(withWorkspaceValidationCapacity({ ...options, root: blocked, workspaceRoot: blocked, deadlineAt: Date.now() + 120 }, () => {
    assert.fail('a populated legacy directory cannot be bypassed');
  }), /capacity wait deadline/);
  assert.equal(lstatSync(blockedPath).isDirectory(), true);
  assert.equal(readFileSync(join(blockedPath, 'unknown-owner'), 'utf8'), 'preserve unknown coordination state');
  rmSync(join(blockedPath, 'unknown-owner'));
  let active = 0; let peak = 0;
  await Promise.all(Array.from({ length: 8 }, () => withWorkspaceValidationCapacity({ ...options, root: blocked, workspaceRoot: blocked }, async () => {
    peak = Math.max(peak, ++active); await delay(10); active--;
  })));
  assert.equal(peak, 1, 'concurrent migration must retain one exclusive queue');
  const foreign = freshRoot(); const foreignPath = validationCapacityLockPath(foreign);
  mkdirSync(resolve(foreignPath, '..'), { recursive: true });
  symlinkSync(realpathSync(legacy), foreignPath, 'dir');
  await assert.rejects(withWorkspaceValidationCapacity({ ...options, root: foreign, workspaceRoot: foreign }, () => assert.fail('foreign alias admitted')), /unowned queue/);
  console.log('VALIDATION_COORDINATION_GUARD_GREEN: real heartbeat accepted; material and runtime write-restore rejected; legacy ticket serializes; unknown state preserved; eight concurrent migrations serialize; foreign alias refused');
} finally { for (const path of roots) rmSync(path, { recursive: true, force: true }); }
