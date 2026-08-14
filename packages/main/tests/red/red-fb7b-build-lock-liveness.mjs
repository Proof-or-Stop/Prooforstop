#!/usr/bin/env node
/**
 * RED (repro-first) for B-fb7b Codex MAJOR-1 — the shared build mutex must reclaim a lock by
 * holder LIVENESS + release by OWNERSHIP, never by age alone.
 *
 * Baseline (the age-only steal + ownership-blind release): FAILS. A lock older than the stale
 * threshold is stolen even while its holder is still building (test 2 runs fn / does not time out),
 * and a holder unconditionally removes the lock on release even after a successor re-acquired it
 * (test 3 sees the lock gone). Both recreate the concurrent-build dist corruption the mutex exists
 * to prevent.
 *
 * After the fix (PID-liveness reclaim + nonce-checked release): PASSES. A live holder's lock is
 * never stolen (the waiter times out); a dead holder's lock is reclaimed; and a release only removes
 * a lock the caller still owns.
 *
 * Isolated: every case uses a unique repoKey, so its lock dir never collides with a real build or
 * another case. Env overrides keep the wait bounded.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
while (!existsSync(join(repoRoot, 'lattice.config.json')) && repoRoot !== dirname(repoRoot)) repoRoot = dirname(repoRoot);
const { withBuildLock } = await import(pathToFileURL(join(repoRoot, 'scripts', 'build-lock.mjs')).href);

const lockDirFor = (key) => join(tmpdir(), `lattice-build-${createHash('sha256').update(key).digest('hex').slice(0, 16)}.lock`);
const writeOwner = (lockDir, owner) => writeFileSync(join(lockDir, 'owner.json'), JSON.stringify(owner));

// --- Test 1: a lock held by a DEAD pid is reclaimed and fn runs.
{
  const key = `fb7b-locktest-dead-${randomUUID()}`;
  const lockDir = lockDirFor(key);
  rmSync(lockDir, { recursive: true, force: true });
  mkdirSync(lockDir, { recursive: true });
  // A freshly-exited child's pid is dead. Guard against PID reuse by confirming it is gone.
  const child = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const deadPid = child.pid;
  let stillAlive = true;
  try { process.kill(deadPid, 0); } catch { stillAlive = false; }
  assert.ok(!stillAlive, 'precondition: the sampled pid must be dead (skip on the rare PID-reuse)');
  writeOwner(lockDir, { pid: deadPid, nonce: 'dead-holder' });
  let ran = false;
  withBuildLock(key, () => { ran = true; });
  assert.ok(ran, 'MAJOR-1: withBuildLock must reclaim a lock whose holder PID is dead and run fn');
  assert.ok(!existsSync(lockDir), 'MAJOR-1: after fn the reclaimed lock is released');
}

// --- Test 2: a lock held by a LIVE pid is NOT stolen even when it is very old (age must not override
// liveness). The age-only baseline steals it and runs fn; the fix waits and times out.
{
  const key = `fb7b-locktest-live-${randomUUID()}`;
  const lockDir = lockDirFor(key);
  rmSync(lockDir, { recursive: true, force: true });
  mkdirSync(lockDir, { recursive: true });
  writeOwner(lockDir, { pid: process.pid, nonce: 'live-holder' }); // our own pid is unquestionably alive
  const longAgoSec = Date.now() / 1000 - 100_000; // ~27h old — far past any age threshold
  utimesSync(lockDir, longAgoSec, longAgoSec);
  process.env.LATTICE_BUILD_LOCK_WAIT_MS = '1200';
  let ran = false;
  let timedOut = false;
  try { withBuildLock(key, () => { ran = true; }); }
  catch (err) { timedOut = /timed out/.test(String(err && err.message)); }
  delete process.env.LATTICE_BUILD_LOCK_WAIT_MS;
  assert.ok(!ran, 'MAJOR-1: a lock held by a LIVE pid must NOT be stolen — fn must not run');
  assert.ok(timedOut, 'MAJOR-1: withBuildLock must WAIT for a live holder (and time out here), not age-steal it');
  assert.ok(existsSync(lockDir), 'MAJOR-1: the live holder lock is left intact');
  assert.equal(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).nonce, 'live-holder', 'live holder ownership preserved');
  rmSync(lockDir, { recursive: true, force: true });
}

// --- Test 3: ownership-checked release. If a successor re-acquires the lock (different nonce) while we
// run, our release must NOT delete it. The ownership-blind baseline removes it unconditionally.
{
  const key = `fb7b-locktest-owner-${randomUUID()}`;
  const lockDir = lockDirFor(key);
  rmSync(lockDir, { recursive: true, force: true });
  let sawLock = false;
  withBuildLock(key, () => {
    sawLock = existsSync(lockDir);
    // Simulate a successor that reclaimed (as if we had been declared dead) and re-acquired the lock.
    writeOwner(lockDir, { pid: process.pid, nonce: 'successor-nonce' });
  });
  assert.ok(sawLock, 'precondition: our own withBuildLock created the lock');
  assert.ok(existsSync(lockDir), 'MAJOR-1: ownership-checked release must NOT remove a lock a successor now owns');
  assert.equal(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).nonce, 'successor-nonce', 'successor ownership intact after our release');
  rmSync(lockDir, { recursive: true, force: true });
}

// --- Test 4: uncontended happy path — acquire, run, release cleanly.
{
  const key = `fb7b-locktest-happy-${randomUUID()}`;
  const lockDir = lockDirFor(key);
  rmSync(lockDir, { recursive: true, force: true });
  let ran = false;
  const result = withBuildLock(key, () => { ran = true; assert.ok(existsSync(lockDir), 'lock held during fn'); return 'ok'; });
  assert.equal(result, 'ok', 'withBuildLock returns fn result');
  assert.ok(ran && !existsSync(lockDir), 'uncontended: fn ran and lock released');
}

console.log('PASS red-fb7b-build-lock-liveness: mutex reclaims by PID-liveness, releases by ownership nonce (Codex MAJOR-1)');
