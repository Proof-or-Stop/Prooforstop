#!/usr/bin/env node
/**
 * B-f60c CHK-004: unit smoke for the doctor stuck-lock check and the
 * lock-contention error UX.
 *
 * Covers:
 *  1. holder.json — acquireMainWriteLock records pid/hostname/command/acquiredAt
 *     inside the lock dir; readMkdirLockHolder reads it back.
 *  2. contention message — a fail-fast acquire against a LIVE main write lock
 *     throws a holder-aware blocking error naming the holder command, pid,
 *     hostname, heartbeat age, and a retry instruction.
 *  3. no fabricated sessionId — the contention message and holder metadata
 *     never contain a `session <id>` token (sessionId is an owner-lease story
 *     concept, deliberately out of scope here).
 *  4. doctor scan: STUCK — a held lock older than the stale window classifies
 *     as `stuck` and renders a ⚠ stuck report.
 *  5. doctor scan: ACTIVE not misreported — a fresh held lock classifies as
 *     `active` and is NOT reported as stuck.
 *  6. doctor scan: ABSENT — no lock dir → `absent`, healthy report.
 *  7. formatLockAge — seconds / minutes / hours rendering.
 *  8. malformed holder.json degrades to "holder unknown" (graceful).
 *
 * Timing is driven via mtime backdating so the test stays fast and
 * deterministic without sleeping for the real 120s stale window.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireMainWriteLock,
  buildMainWriteLockContentionMessage,
  formatLockAge,
  mainWriteLockPath,
  MAIN_WRITE_LOCK_STALE_MS,
} from '../core/main-write-lock.js';
import { MKDIR_LOCK_HOLDER_FILE, readMkdirLockHolder } from '../core/mkdir-lock.js';
import {
  renderMainWriteLockScan,
  scanMainWriteLock,
} from '../core/main-write-lock-doctor.js';

const root = join(tmpdir(), `proof-or-stop-mwl-doctor-smoke-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });

try {
  // ── 1. holder.json is recorded on acquire and readable ───────────────────
  {
    const repo = join(root, 'holder');
    mkdirSync(repo, { recursive: true });
    const lockDir = mainWriteLockPath(repo);
    const lock = acquireMainWriteLock(repo, { label: 'gap_log' });
    assert.equal(existsSync(join(lockDir, MKDIR_LOCK_HOLDER_FILE)), true,
      'holder.json written inside the acquired lock dir');
    const holder = readMkdirLockHolder(lockDir);
    assert.ok(holder, 'readMkdirLockHolder returns the recorded holder');
    assert.equal(holder!.pid, process.pid, 'holder records the acquiring pid');
    assert.equal(holder!.command, 'gap_log', 'holder records the operation label as command');
    assert.ok(holder!.hostname.length > 0, 'holder records a hostname');
    assert.ok(!Number.isNaN(Date.parse(holder!.acquiredAt)), 'holder records an ISO acquiredAt');
    lock.release();
    assert.equal(readMkdirLockHolder(lockDir), null,
      'holder is gone once the lock is released');
  }

  // ── 2. contention message names the holder, pid, hostname, heartbeat, retry ─
  {
    const repo = join(root, 'contention');
    mkdirSync(repo, { recursive: true });
    const first = acquireMainWriteLock(repo, { label: 'story_advance DONE for B-6974' });
    let secondAcquired = false;
    assert.throws(() => {
      const second = acquireMainWriteLock(repo, { label: 'gap_log' });
      secondAcquired = true;
      second.release();
    }, (err: unknown) => {
      const msg = (err as Error).message;
      assert.match(msg, /is blocked/, 'message states the operation is blocked');
      assert.match(msg, /main write lock is held/, 'message names the main write lock');
      assert.match(msg, /story_advance DONE for B-6974/,
        'message names the holder command');
      assert.match(msg, new RegExp(`pid ${process.pid}`),
        'message names the holder pid');
      assert.match(msg, /heartbeat \d+s ago/, 'message states a heartbeat age');
      assert.match(msg, /[Rr]etry/, 'message gives a retry instruction');
      // 3. no fabricated sessionId — sessionId is an owner-lease concept.
      assert.ok(!/session\s+[a-z0-9]{4,}/i.test(msg),
        'contention message does NOT fabricate a session id');
      return true;
    }, 'a live main write lock yields a holder-aware contention error');
    assert.equal(secondAcquired, false, 'the contending acquire did not succeed');
    first.release();
  }

  // ── 3b. buildMainWriteLockContentionMessage with an unknown holder ───────
  {
    const msg = buildMainWriteLockContentionMessage('gap_log', null, 65_000);
    assert.match(msg, /gap_log is blocked/, 'blocked op named even with no holder info');
    assert.match(msg, /holder details unavailable/,
      'message states holder details are unavailable when holder.json is absent');
    assert.match(msg, /heartbeat 1m ago/, 'heartbeat age still rendered (65s → 1m)');
    assert.ok(!/session\s+[a-z0-9]{4,}/i.test(msg),
      'unknown-holder message also never fabricates a session id');
  }

  // ── 4. doctor scan: a stale held lock classifies as STUCK ────────────────
  {
    const repo = join(root, 'stuck');
    mkdirSync(repo, { recursive: true });
    const lockDir = mainWriteLockPath(repo);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, MKDIR_LOCK_HOLDER_FILE),
      JSON.stringify({
        pid: 99999, hostname: 'crashed-host', command: 'DONE main merge',
        acquiredAt: new Date(Date.now() - 200_000).toISOString(),
      }) + '\n',
      'utf-8',
    );
    // Backdate the lock dir mtime past the 120s stale window.
    const stalePast = (Date.now() - 200_000) / 1000;
    utimesSync(lockDir, stalePast, stalePast);

    const scan = scanMainWriteLock(repo);
    assert.equal(scan.state, 'stuck',
      'a lock older than the stale window is classified stuck');
    assert.ok(scan.ageMs > MAIN_WRITE_LOCK_STALE_MS, 'scan reports the stale age');
    assert.ok(scan.holder, 'stuck scan still reads holder metadata');
    assert.equal(scan.holder!.command, 'DONE main merge', 'stuck scan names the holder command');

    const report = renderMainWriteLockScan(scan).join('\n');
    assert.match(report, /STUCK/, 'doctor report flags the stuck lock');
    assert.match(report, /DONE main merge/, 'doctor report names the holder command');
    assert.match(report, /pid 99999/, 'doctor report names the holder pid');
    assert.match(report, /crashed-host/, 'doctor report names the holder hostname');
    rmSync(lockDir, { recursive: true, force: true });
  }

  // ── 5. doctor scan: a FRESH held lock is ACTIVE, NOT misreported as stuck ─
  {
    const repo = join(root, 'active');
    mkdirSync(repo, { recursive: true });
    const lock = acquireMainWriteLock(repo, { label: 'gap_log' });
    // The lock was just acquired — mtime is "now", well within the 120s window.
    const scan = scanMainWriteLock(repo);
    assert.equal(scan.state, 'active',
      'a fresh held lock is classified active, never stuck');
    assert.ok(scan.ageMs <= MAIN_WRITE_LOCK_STALE_MS,
      'active lock age is within the stale window');
    const report = renderMainWriteLockScan(scan).join('\n');
    assert.ok(!/STUCK/.test(report), 'doctor report does NOT call an active lock stuck');
    assert.match(report, /active operation, not stuck/,
      'doctor report explicitly says an in-window lock is an active operation');
    assert.match(report, /gap_log/, 'doctor report names the active holder command');
    lock.release();
  }

  // ── 5b. a held lock JUST under the stale window is still active ──────────
  {
    const repo = join(root, 'active-edge');
    mkdirSync(repo, { recursive: true });
    const lockDir = mainWriteLockPath(repo);
    mkdirSync(lockDir, { recursive: true });
    // mtime 60s ago — half the 120s window → must still be 'active'.
    const recentPast = (Date.now() - 60_000) / 1000;
    utimesSync(lockDir, recentPast, recentPast);
    const scan = scanMainWriteLock(repo);
    assert.equal(scan.state, 'active',
      'a 60s-old lock (inside the 120s window) is active, not stuck');
    rmSync(lockDir, { recursive: true, force: true });
  }

  // ── 6. doctor scan: no lock dir → ABSENT, healthy report ─────────────────
  {
    const repo = join(root, 'absent');
    mkdirSync(repo, { recursive: true });
    const scan = scanMainWriteLock(repo);
    assert.equal(scan.state, 'absent', 'no lock dir → absent');
    assert.equal(scan.ageMs, 0, 'absent scan reports zero age');
    const report = renderMainWriteLockScan(scan).join('\n');
    assert.match(report, /not held/, 'doctor report says the lock is not held');
    assert.ok(!/STUCK/.test(report), 'absent report never reports stuck');
  }

  // ── 7. formatLockAge — seconds / minutes / hours ─────────────────────────
  {
    assert.equal(formatLockAge(30_000), '30s', '30s rendered as seconds');
    assert.equal(formatLockAge(8 * 60_000), '8m', '8m rendered as minutes');
    assert.equal(formatLockAge(2 * 3600_000), '2h', '2h rendered as hours');
    assert.equal(formatLockAge(-5), '0s', 'negative age clamps to 0s');
    assert.equal(formatLockAge(Number.NaN), '0s', 'NaN age clamps to 0s');
  }

  // ── 8. malformed holder.json degrades to "holder unknown" ────────────────
  {
    const repo = join(root, 'malformed');
    mkdirSync(repo, { recursive: true });
    const lockDir = mainWriteLockPath(repo);
    mkdirSync(lockDir, { recursive: true });
    // Half-written holder.json (writer crashed) — must NOT yield a half holder.
    writeFileSync(join(lockDir, MKDIR_LOCK_HOLDER_FILE), '{ "pid": 12', 'utf-8');
    assert.equal(readMkdirLockHolder(lockDir), null,
      'malformed holder.json reads back as null (holder unknown)');
    // Holder missing a field is also rejected.
    writeFileSync(
      join(lockDir, MKDIR_LOCK_HOLDER_FILE),
      JSON.stringify({ pid: 1, hostname: 'h' }) + '\n',
      'utf-8',
    );
    assert.equal(readMkdirLockHolder(lockDir), null,
      'holder.json missing command/acquiredAt reads back as null');
    // The scan still classifies the lock; only the holder is unknown.
    const fresh = Date.now() / 1000;
    utimesSync(lockDir, fresh, fresh);
    const scan = scanMainWriteLock(repo);
    assert.equal(scan.state, 'active', 'scan still classifies a lock with malformed holder');
    assert.equal(scan.holder, null, 'scan reports holder unknown for malformed holder.json');
    const report = renderMainWriteLockScan(scan).join('\n');
    assert.match(report, /unknown holder/, 'doctor report degrades gracefully to "unknown holder"');
    rmSync(lockDir, { recursive: true, force: true });
  }

  console.log('✓ main-write-lock-doctor smoke passed (holder.json / contention UX / no sessionId / stuck-lock detection / active not misreported / absent / formatLockAge / malformed holder)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
