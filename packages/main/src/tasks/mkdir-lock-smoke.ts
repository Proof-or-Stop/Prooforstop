#!/usr/bin/env node
/**
 * B-6812 CHK-001: unit smoke for core/mkdir-lock.ts `withMkdirLock`.
 *
 * Covers the three behaviors the decision preMortem named as load-bearing:
 *  1. normal acquire/release — lock dir exists during fn, removed after.
 *  2. deadline timeout — a held lock makes a second acquire throw a clear error.
 *  3. stale reclaim — a held lock older than staleMs is force-reclaimed.
 *
 * Timing is driven via the MkdirLockOptions (deadlineMs/staleMs/pollMs) so the
 * test is fast and deterministic without spawning processes.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withMkdirLock } from '../core/mkdir-lock.js';

const root = join(tmpdir(), `koala-mkdir-lock-smoke-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });

try {
  // ── 1. normal acquire / release ──────────────────────────────────────────
  {
    const lockDir = join(root, 'normal', '.lock');
    let sawLockDuringFn = false;
    const ret = withMkdirLock(lockDir, () => {
      sawLockDuringFn = existsSync(lockDir);
      return 'payload';
    });
    assert.equal(ret, 'payload', 'withMkdirLock returns the fn result');
    assert.equal(sawLockDuringFn, true, 'lock dir exists while fn runs');
    assert.equal(existsSync(lockDir), false, 'lock dir removed after fn returns');
  }

  // ── 1b. parent dir auto-created ──────────────────────────────────────────
  {
    const lockDir = join(root, 'deep', 'nested', 'never-made', '.lock');
    assert.equal(existsSync(join(root, 'deep')), false, 'parent does not pre-exist');
    withMkdirLock(lockDir, () => {});
    assert.equal(existsSync(join(root, 'deep', 'nested', 'never-made')), true,
      'withMkdirLock created the missing parent directory');
  }

  // ── 1c. lock released even when fn throws ────────────────────────────────
  {
    const lockDir = join(root, 'throwing', '.lock');
    assert.throws(() => {
      withMkdirLock(lockDir, () => { throw new Error('boom'); });
    }, /boom/, 'fn error propagates');
    assert.equal(existsSync(lockDir), false, 'lock released in finally after fn throws');
  }

  // ── 2. deadline timeout when lock is already held ────────────────────────
  {
    const lockDir = join(root, 'contended', '.lock');
    // Simulate a live holder: create the lock dir and keep its mtime fresh so
    // the stale-reclaim path does NOT fire.
    mkdirSync(lockDir, { recursive: true });
    const now = Date.now() / 1000;
    utimesSync(lockDir, now, now);
    const start = Date.now();
    assert.throws(() => {
      withMkdirLock(lockDir, () => 'should-not-run', {
        deadlineMs: 200,
        staleMs: 10_000, // far above the held lock's age → no reclaim
        pollMs: 20,
        label: 'contended-test',
      });
    }, (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /contended-test lock timeout/, 'timeout error names the label');
      assert.match(msg, /200ms/, 'timeout error states the deadline');
      return true;
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 200, `waited at least the deadline (elapsed=${elapsed}ms)`);
    // The original holder's lock dir is untouched (we never acquired it).
    assert.equal(existsSync(lockDir), true, 'live holder lock left intact after timeout');
    rmSync(lockDir, { recursive: true, force: true });
  }

  // ── 3. stale lock (mtime older than staleMs) is force-reclaimed ──────────
  {
    const lockDir = join(root, 'stale', '.lock');
    mkdirSync(lockDir, { recursive: true });
    // Backdate mtime well beyond staleMs so the first contention loop reclaims it.
    const stalePast = (Date.now() - 60_000) / 1000;
    utimesSync(lockDir, stalePast, stalePast);
    assert.ok(Date.now() - statSync(lockDir).mtimeMs > 10_000, 'lock dir mtime is stale');

    let ran = false;
    const ret = withMkdirLock(lockDir, () => { ran = true; return 'reclaimed'; }, {
      deadlineMs: 2_000,
      staleMs: 10_000, // held lock (60s old) exceeds this → reclaim
      pollMs: 20,
      label: 'stale-test',
    });
    assert.equal(ran, true, 'fn ran after reclaiming the stale lock');
    assert.equal(ret, 'reclaimed', 'withMkdirLock returned fn result after reclaim');
    assert.equal(existsSync(lockDir), false, 'lock released after stale-reclaim run');
  }

  // ── 4. lock path occupied by a plain FILE (not a directory) ─────────────
  // A hostile/accidental `.create.lock` regular file makes mkdir throw EEXIST
  // just like a held lock. withMkdirLock must not hang or crash:
  //  - a STALE file (old mtime) is rmSync-reclaimed → fn runs.
  //  - a FRESH file makes acquisition time out with a clear error.
  {
    // 4a. stale file → reclaimed.
    const staleFileLock = join(root, 'file-stale', '.lock');
    mkdirSync(join(root, 'file-stale'), { recursive: true });
    writeFileSync(staleFileLock, 'stale holder marker');
    const stalePast = (Date.now() - 60_000) / 1000;
    utimesSync(staleFileLock, stalePast, stalePast);
    let fileStaleRan = false;
    withMkdirLock(staleFileLock, () => { fileStaleRan = true; }, {
      deadlineMs: 2_000, staleMs: 10_000, pollMs: 20, label: 'file-stale-test',
    });
    assert.equal(fileStaleRan, true, 'stale file at lock path is reclaimed, fn runs');
    assert.equal(existsSync(staleFileLock), false, 'lock released after file-stale reclaim');

    // 4b. fresh file → clear timeout, no infinite loop / crash.
    const freshFileLock = join(root, 'file-fresh', '.lock');
    mkdirSync(join(root, 'file-fresh'), { recursive: true });
    writeFileSync(freshFileLock, 'fresh holder marker');
    const fnow = Date.now() / 1000;
    utimesSync(freshFileLock, fnow, fnow);
    assert.throws(() => {
      withMkdirLock(freshFileLock, () => {}, {
        deadlineMs: 200, staleMs: 10_000, pollMs: 20, label: 'file-fresh-test',
      });
    }, /file-fresh-test lock timeout/, 'fresh file at lock path yields a clear timeout error');
    rmSync(join(root, 'file-fresh'), { recursive: true, force: true });
  }

  console.log('✓ mkdir-lock smoke passed (normal / timeout / stale-reclaim / file-occupied path)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
