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
  mainWriteLockPath,
  withMainWriteLock,
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

  console.log('✓ main-write-lock smoke passed (acquire/release / blocking-on-held / stale-reclaim / concurrency mutex / canonical path)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
