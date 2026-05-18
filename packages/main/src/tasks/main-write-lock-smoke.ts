#!/usr/bin/env node
/**
 * B-f60c CHK-001: unit smoke for core/main-write-lock.ts.
 *
 * Covers the load-bearing semantics of the unified main write lock
 * (session-ownership-and-write-leases.md "Main Write Lock Rules" 1-3,6):
 *  1. acquire / release — lock dir lives at the canonical path during the
 *     critical section, removed after release.
 *  2. blocking-on-held — a second acquire while the lock is live throws
 *     immediately (fail-fast, no optimistic proceed).
 *  3. stale-reclaim — a held lock older than the stale threshold is reclaimed.
 *  4. concurrency mutual exclusion — of two acquirers, exactly one succeeds and
 *     the other is rejected while the first holds the lock.
 *  5. canonical path — the lock resolves to `.koala/locks/main-write.lock/`.
 *  6. empty mainRepoRoot is rejected (runtime re-validation).
 *
 * Timing is driven via mtime backdating so the test stays fast and
 * deterministic without sleeping for the real 120s stale window.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAIN_WRITE_LOCK_REL,
  acquireMainWriteLock,
  acquireMainWriteLockRegistered,
  isMainWriteLockHeldInProcess,
  mainWriteLockPath,
  withMainWriteLock,
  withReentrantMainWriteLock,
} from '../core/main-write-lock.js';

const root = join(tmpdir(), `koala-main-write-lock-smoke-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });

try {
  // ── 5. canonical path ────────────────────────────────────────────────────
  {
    const lockPath = mainWriteLockPath(root);
    assert.equal(lockPath, join(root, MAIN_WRITE_LOCK_REL),
      'mainWriteLockPath resolves to <root>/.koala/locks/main-write.lock');
    assert.equal(MAIN_WRITE_LOCK_REL, '.koala/locks/main-write.lock',
      'canonical lock path is .koala/locks/main-write.lock');
  }

  // ── 1. acquire / release ─────────────────────────────────────────────────
  {
    const repo = join(root, 'acquire-release');
    mkdirSync(repo, { recursive: true });
    const lockDir = mainWriteLockPath(repo);
    const lock = acquireMainWriteLock(repo);
    assert.equal(existsSync(lockDir), true, 'lock dir exists while held');
    lock.release();
    assert.equal(existsSync(lockDir), false, 'lock dir removed after release');
  }

  // ── 1b. withMainWriteLock returns fn result and releases even on throw ────
  {
    const repo = join(root, 'with-lock');
    mkdirSync(repo, { recursive: true });
    const lockDir = mainWriteLockPath(repo);
    let sawLock = false;
    const ret = withMainWriteLock(repo, () => {
      sawLock = existsSync(lockDir);
      return 'payload';
    });
    assert.equal(ret, 'payload', 'withMainWriteLock returns fn result');
    assert.equal(sawLock, true, 'lock held during fn');
    assert.equal(existsSync(lockDir), false, 'lock released after fn');

    assert.throws(() => {
      withMainWriteLock(repo, () => { throw new Error('boom'); });
    }, /boom/, 'fn error propagates');
    assert.equal(existsSync(lockDir), false, 'lock released in finally after fn throws');
  }

  // ── 2 + 4. blocking-on-held / concurrency mutual exclusion ───────────────
  // First acquirer wins; while it holds the lock the second acquirer must fail
  // fast with a blocking error (Rule 6: no optimistic proceed).
  {
    const repo = join(root, 'mutex');
    mkdirSync(repo, { recursive: true });
    const first = acquireMainWriteLock(repo, { label: 'first-op' });
    let secondAcquired = false;
    assert.throws(() => {
      const second = acquireMainWriteLock(repo, { label: 'second-op' });
      secondAcquired = true;
      second.release();
    }, (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /main write lock is held/, 'held error names the main write lock');
      return true;
    }, 'a live main write lock blocks the second acquirer');
    assert.equal(secondAcquired, false, 'exactly one of two concurrent acquirers succeeds');
    // After the holder releases, the next acquire succeeds.
    first.release();
    const third = acquireMainWriteLock(repo);
    assert.equal(existsSync(mainWriteLockPath(repo)), true, 'lock re-acquirable after release');
    third.release();
  }

  // ── 3. stale-reclaim ─────────────────────────────────────────────────────
  // A held lock whose mtime is older than the stale threshold is force-reclaimed
  // instead of deadlocking every future main write.
  {
    const repo = join(root, 'stale');
    mkdirSync(repo, { recursive: true });
    const lockDir = mainWriteLockPath(repo);
    mkdirSync(lockDir, { recursive: true });
    // Backdate mtime well past a small test stale window.
    const stalePast = (Date.now() - 60_000) / 1000;
    utimesSync(lockDir, stalePast, stalePast);

    const lock = acquireMainWriteLock(repo, { staleMs: 1_000 });
    assert.equal(existsSync(lockDir), true, 'stale lock reclaimed — new holder owns the dir');
    lock.release();
    assert.equal(existsSync(lockDir), false, 'lock released after stale-reclaim run');
  }

  // ── 3b. a FRESH held lock is NOT reclaimed (still blocks) ────────────────
  {
    const repo = join(root, 'stale-fresh');
    mkdirSync(repo, { recursive: true });
    const lockDir = mainWriteLockPath(repo);
    mkdirSync(lockDir, { recursive: true });
    const fresh = Date.now() / 1000;
    utimesSync(lockDir, fresh, fresh);
    assert.throws(() => {
      acquireMainWriteLock(repo, { staleMs: 1_000_000 });
    }, /main write lock is held/, 'a fresh held lock is not reclaimed and still blocks');
    rmSync(lockDir, { recursive: true, force: true });
  }

  // ── 6. empty mainRepoRoot is rejected ────────────────────────────────────
  {
    assert.throws(() => acquireMainWriteLock(''), /mainRepoRoot is required/,
      'empty mainRepoRoot is rejected at runtime');
    assert.throws(() => acquireMainWriteLock('   '), /mainRepoRoot is required/,
      'whitespace-only mainRepoRoot is rejected at runtime');
  }

  // ── 7. B-f60c CHK-003: reentrancy — nested same-process acquire is a pass-through ──
  // The on-disk lock fail-fasts on a held lock; a NESTED withReentrantMainWriteLock
  // for the same root in the same process must NOT re-acquire (which would
  // self-deadlock) — it runs fn directly. This is the fix that lets the DONE
  // flow run `audit` in-process while already holding the lock.
  {
    const repo = join(root, 'reentrant');
    mkdirSync(repo, { recursive: true });
    const lockDir = mainWriteLockPath(repo);
    assert.equal(isMainWriteLockHeldInProcess(repo), false, 'lock not held before entry');
    let innerRan = false;
    let depth2InnerRan = false;
    const ret = withReentrantMainWriteLock(repo, () => {
      assert.equal(isMainWriteLockHeldInProcess(repo), true, 'outer frame holds the lock');
      assert.equal(existsSync(lockDir), true, 'on-disk lock dir exists at depth 1');
      // depth-2 nested call — must NOT self-deadlock, must run fn
      const innerRet = withReentrantMainWriteLock(repo, () => {
        innerRan = true;
        assert.equal(existsSync(lockDir), true, 'on-disk lock still held at depth 2');
        // depth-3 to be thorough
        withReentrantMainWriteLock(repo, () => { depth2InnerRan = true; });
        return 'inner-payload';
      });
      assert.equal(innerRet, 'inner-payload', 'nested call returns its fn result');
      return 'outer-payload';
    });
    assert.equal(ret, 'outer-payload', 'outermost call returns its fn result');
    assert.equal(innerRan, true, 'nested reentrant call ran');
    assert.equal(depth2InnerRan, true, 'depth-3 reentrant call ran');
    assert.equal(isMainWriteLockHeldInProcess(repo), false, 'lock released after outermost exit');
    assert.equal(existsSync(lockDir), false, 'on-disk lock dir removed after outermost exit');
  }

  // ── 7b. reentrancy registry is cleared even when the critical section throws ──
  {
    const repo = join(root, 'reentrant-throw');
    mkdirSync(repo, { recursive: true });
    assert.throws(() => {
      withReentrantMainWriteLock(repo, () => {
        withReentrantMainWriteLock(repo, () => { throw new Error('nested boom'); });
      });
    }, /nested boom/, 'a throw inside a nested reentrant section propagates');
    assert.equal(isMainWriteLockHeldInProcess(repo), false,
      'reentrancy registry cleared after a throwing critical section');
    assert.equal(existsSync(mainWriteLockPath(repo)), false, 'on-disk lock released after throw');
  }

  // ── 7c. acquireMainWriteLockRegistered: explicit acquire/release shape feeds the registry ──
  // The DONE flow holds the lock via this raw acquire/release form (across an
  // actor.send boundary); a NESTED withReentrantMainWriteLock must see it held.
  {
    const repo = join(root, 'registered');
    mkdirSync(repo, { recursive: true });
    const outer = acquireMainWriteLockRegistered(repo, { label: 'DONE-like' });
    assert.equal(isMainWriteLockHeldInProcess(repo), true,
      'acquireMainWriteLockRegistered registers the lock in-process');
    // a nested reentrant call now passes through instead of fail-fasting
    let nestedRan = false;
    withReentrantMainWriteLock(repo, () => { nestedRan = true; });
    assert.equal(nestedRan, true, 'nested reentrant call passes through a registered DONE-style lock');
    // a nested registered acquire is a no-op handle (outer still owns the lock)
    const nestedReg = acquireMainWriteLockRegistered(repo);
    nestedReg.release(); // no-op — must not release the outer lock
    assert.equal(isMainWriteLockHeldInProcess(repo), true, 'no-op nested release keeps the outer lock');
    outer.release();
    assert.equal(isMainWriteLockHeldInProcess(repo), false, 'outer release clears the registry');
    assert.equal(existsSync(mainWriteLockPath(repo)), false, 'on-disk lock removed after outer release');
  }

  // ── 8. B-f60c CHK-003: onContention 'wait' serializes instead of fail-fasting ──
  // 'wait' mode reclaims a stale lock just like fail-fast, but a LIVE held lock
  // is polled for rather than throwing. Backdate a held lock past a tiny stale
  // window so a 'wait' acquire reclaims it (proving 'wait' still stale-reclaims).
  {
    const repo = join(root, 'wait-mode');
    mkdirSync(repo, { recursive: true });
    const lockDir = mainWriteLockPath(repo);
    mkdirSync(lockDir, { recursive: true });
    const stalePast = (Date.now() - 60_000) / 1000;
    utimesSync(lockDir, stalePast, stalePast);
    const lock = acquireMainWriteLock(repo, { onContention: 'wait', staleMs: 1_000 });
    assert.equal(existsSync(lockDir), true, "'wait' mode reclaims a stale lock");
    lock.release();
    // an out-of-enum onContention value falls back to fail-fast (runtime guard)
    const fresh = join(root, 'wait-mode-fallback');
    mkdirSync(fresh, { recursive: true });
    const heldDir = mainWriteLockPath(fresh);
    mkdirSync(heldDir, { recursive: true });
    utimesSync(heldDir, Date.now() / 1000, Date.now() / 1000);
    assert.throws(
      () => acquireMainWriteLock(fresh, { onContention: 'bogus' as never, staleMs: 1_000_000 }),
      /main write lock is held/,
      'an invalid onContention value falls back to fail-fast on a live lock',
    );
    rmSync(heldDir, { recursive: true, force: true });
  }

  console.log('✓ main-write-lock smoke passed (acquire/release / blocking-on-held / stale-reclaim / concurrency mutex / canonical path / reentrancy / registered acquire / wait-mode)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
