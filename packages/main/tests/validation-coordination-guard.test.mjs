import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, lstatSync, symlinkSync, readlinkSync, existsSync, renameSync, cpSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createFixtureMachineEnvironment } from '../dist/tasks/helpers/fixture-machine-environment.js';
import { withWorkspaceValidationCapacity, validationCapacityLockPath, isValidationCapacityWaitDeadlineError } from '../dist/core/validation-execution-lock.js';
import { createQuorumSmokeProtectedMutationGuard } from '../dist/tasks/quorum-submit-smoke-worker.js';
import { WORKSPACE_VALIDATION_COORDINATION_FIXTURE_RUNTIME_POLICY as coordinationFixtureBudget } from '../dist/core/runtime-fact-registry.js';
import { observeFixtureCoordination, assertFixtureCoordinationRemoved, assertObservedCoordinationAliases, assertReclaimedFixtureCoordination } from '../../../scripts/fixture-coordination-observation.mjs';

if (!process.argv.includes('--private-machine')) {
  await import('./validation-audit-final-regressions.test.mjs');
  const fixture = createFixtureMachineEnvironment();
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--private-machine'], {
    env: fixture.env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', timeout: coordinationFixtureBudget.childMs,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status === 0) {
    const targets = assertReclaimedFixtureCoordination(fixture, result.stdout, 3);
    fixture.cleanup();
    assertFixtureCoordinationRemoved(fixture, targets);
  }
  else console.error('Coordination fixture retained: ' + fixture.root);
  process.exit(result.status ?? 1);
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'validation-coordination-guard-')));
const roots = [root];
const freshRoot = () => { const value = realpathSync(mkdtempSync(join(tmpdir(), 'validation-coordination-boundary-'))); roots.push(value); return value; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const options = { root, workspaceRoot: root, command: 'coordination-guard-regression' };
function withDeadline(extra = {}) {
  return { ...options, deadlineAt: Date.now() + 20000, ...extra };
}
try {
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, '.gitignore'), '.proof-or-stop/\n');
  writeFileSync(join(root, 'subject.txt'), 'unchanged\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Lab', '-c', 'user.email=lab@example.test', 'commit', '-qm', 'fixture']);
  await withWorkspaceValidationCapacity(withDeadline(), async () => {
    const guard = createQuorumSmokeProtectedMutationGuard([root]);
    await delay(2200); // Observe at least one actual parent capacity heartbeat.
    const witness = await guard.close();
    assert.equal(witness.clean, true, 'VALIDATION_PARENT_COORDINATION_FALSE_MUTATION: ' + JSON.stringify(witness));
  });
  const legacy = validationCapacityLockPath(root);
  assert.equal(lstatSync(legacy).isSymbolicLink(), true, 'legacy callers must retain one shared queue through the compatibility path');
  assert.ok(relative(root, realpathSync(legacy)).startsWith('..'), 'physical coordination must be outside the protected root');
  console.log('COORDINATION_ALIAS_TARGET ' + JSON.stringify(realpathSync(legacy)));

  for (const path of ['subject.txt', '.proof-or-stop/real-write.txt']) {
    await withWorkspaceValidationCapacity(withDeadline(), async () => {
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
    const waiting = withWorkspaceValidationCapacity(withDeadline(), () => { entered = true; });
    await delay(150); assert.equal(entered, false, 'legacy ticket must block the relocated queue');
    rmSync(ticket, { recursive: true }); await waiting;
    assert.equal(entered, true);

    // Unlike the alias case above, an actual old directory must drain before
    // migration. Waiting is visible and never removes or bypasses its holder.
    const oldRoot = freshRoot(); const oldPath = validationCapacityLockPath(oldRoot);
    const oldTicket = join(oldPath, `0000000000000001-${randomUUID()}.ticket`);
    mkdirSync(oldTicket, { recursive: true });
    writeFileSync(join(oldTicket, 'holder.json'), JSON.stringify({ lockId: randomUUID(), pid: holder.pid, hostname: hostname(), command: 'legacy migration holder', acquiredAt: new Date().toISOString() }));
    await assert.rejects(withWorkspaceValidationCapacity(withDeadline({ root: oldRoot, workspaceRoot: oldRoot,
      deadlineAt: Date.now() + 1000 }), () => assert.fail('live legacy ticket bypassed')), error => {
      assert.equal(isValidationCapacityWaitDeadlineError(error), true, 'migration preserves the typed capacity deadline');
      assert.ok(error.message.includes(oldPath) && error.message.includes('legacy migration holder'), 'migration deadline names the path and holder');
      return true;
    });
    assert.equal(existsSync(oldTicket), true, 'expired waiter never removes the live owner');
    const progress = []; let migrated = false;
    const migrating = withWorkspaceValidationCapacity(withDeadline({ root: oldRoot, workspaceRoot: oldRoot,
      onWaitProgress: message => { progress.push(message); throw new Error('descriptive callback cannot change ownership'); } }), () => { migrated = true; });
    await delay(150);
    try {
      assert.equal(migrated, false);
      assert.ok(progress.some(message => message.includes(oldPath) && message.includes('legacy migration holder') && message.includes(String(holder.pid))),
        'LEGACY_MIGRATION_WAIT_MUST_REPORT_HOLDER_AND_PATH');
      assert.equal(existsSync(oldTicket), true, 'live legacy ticket must remain intact while migration waits');
    } finally { rmSync(oldTicket, { recursive: true, force: true }); await migrating; }
    assert.equal(migrated, true);
    assert.equal(lstatSync(oldPath).isSymbolicLink(), true);
    console.log('COORDINATION_ALIAS_TARGET ' + JSON.stringify(realpathSync(oldPath)));
  } finally { holder.kill('SIGTERM'); await new Promise(resolve => holder.once('close', resolve)); rmSync(ticket, { recursive: true, force: true }); }
  const blocked = freshRoot(); const blockedPath = validationCapacityLockPath(blocked);
  mkdirSync(blockedPath, { recursive: true });
  writeFileSync(join(blockedPath, 'unknown-owner'), 'preserve unknown coordination state');
  await assert.rejects(withWorkspaceValidationCapacity(withDeadline({ root: blocked, workspaceRoot: blocked }), () => {
    assert.fail('a populated legacy directory cannot be bypassed');
  }), error => {
    assert.match(String(error), /WORKSPACE_COORDINATION_MIGRATION_BLOCKED/);
    assert.ok(String(error).includes(blockedPath));
    assert.ok(String(error).includes('unknown-owner'));
    return true;
  });
  assert.equal(lstatSync(blockedPath).isDirectory(), true);
  assert.equal(readFileSync(join(blockedPath, 'unknown-owner'), 'utf8'), 'preserve unknown coordination state');
  rmSync(join(blockedPath, 'unknown-owner'));
  let active = 0; let peak = 0;
  await Promise.all(Array.from({ length: 8 }, () => withWorkspaceValidationCapacity(withDeadline({ root: blocked, workspaceRoot: blocked }), async () => {
    peak = Math.max(peak, ++active); await delay(10); active--;
  })));
  assert.equal(peak, 1, 'concurrent migration must retain one exclusive queue');
  console.log('COORDINATION_ALIAS_TARGET ' + JSON.stringify(realpathSync(blockedPath)));
  const foreign = freshRoot(); const foreignPath = validationCapacityLockPath(foreign);
  mkdirSync(resolve(foreignPath, '..'), { recursive: true });
  symlinkSync(realpathSync(legacy), foreignPath, 'dir');
  // A copied/moved checkout retains its owned queue identity. Sharing that
  // queue is conservative; replacing it could bypass a concurrently live owner.
  await withWorkspaceValidationCapacity(withDeadline({root:foreign,workspaceRoot:foreign}),()=>{});
  assert.equal(realpathSync(foreignPath),realpathSync(legacy));
  const moved = root + '-renamed';roots.push(moved);renameSync(root,moved);
  const copied = freshRoot();cpSync(moved,copied,{recursive:true,verbatimSymlinks:true});
  let entered = 0;
  await withWorkspaceValidationCapacity(withDeadline({root:moved,workspaceRoot:moved}),async()=>{
    const waiting=withWorkspaceValidationCapacity(withDeadline({root:copied,workspaceRoot:copied,deadlineAt:Date.now()+500}),()=>{entered++;});
    await assert.rejects(waiting,isValidationCapacityWaitDeadlineError);
  });
  assert.equal(entered,0,'copied checkout must not bypass the live retained queue');
  for(const project of [moved,copied]) {
    await withWorkspaceValidationCapacity(withDeadline({root:project,workspaceRoot:project}),()=>{entered++;});
    assert.equal(realpathSync(validationCapacityLockPath(project)),realpathSync(foreignPath));
  }
  assert.equal(entered,2,'renamed and copied checkouts remain usable');
  // All roots and alternate homes are disposable. A fixture home override must
  // never target the real repository's coordination alias.
  const alternateHome = freshRoot();
  const otherQueue = join(alternateHome, 'private-queue');
  mkdirSync(otherQueue, {mode:0o700});
  for (const [label, target] of [['other-home', otherQueue], ['dangling', join(alternateHome, 'removed-queue')]]) {
    const project = freshRoot(), alias = validationCapacityLockPath(project);
    mkdirSync(resolve(alias, '..'), {recursive:true});symlinkSync(target,alias,'dir');
    const before=readlinkSync(alias);let entered=false;
    await assert.rejects(withWorkspaceValidationCapacity(withDeadline({root:project,workspaceRoot:project}),()=>{entered=true;}), label==='dangling'?/WORKSPACE_COORDINATION_ALIAS_DANGLING/:/unowned queue/);
    assert.equal(entered,false);assert.equal(readlinkSync(alias),before,'refusal must preserve the original alias');
    assert.equal(lstatSync(alias).isSymbolicLink(),true);
  }
  console.log('VALIDATION_COORDINATION_GUARD_GREEN: heartbeat accepted; write-restore rejected; legacy tickets serialize; migration reports holder and typed deadline; unknown state preserved; concurrent migration serializes; foreign alias refused');
} finally { for (const path of roots) rmSync(path, { recursive: true, force: true }); }
