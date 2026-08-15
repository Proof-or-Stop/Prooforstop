#!/usr/bin/env node
/**
 * RED (repro-first) for B-1734 CHK-001 — the cross-platform build mutex.
 *
 * BEHAVIORAL proofs that a broken lock MUST fail:
 *   - CONFIG INVARIANT (adversarial:1, edge:2): proper-lockfile is configured with stale >= 30000
 *     and update (heartbeat) < stale/2, with the DEFAULT mkdir strategy (no fs/native override).
 *     A low stale with no heartbeat is exactly B-fb7b finding #1 (live-holder age-steal).
 *   - MUTUAL EXCLUSION / LIVE HOLDER NOT STOLEN (adversarial:0): two concurrent withBuildLock calls
 *     on the same key never overlap — the second WAITS for the live holder rather than barging in.
 *   - RELEASED ON ERROR (edge:0): a fn that throws still releases the lock, so the next builder is
 *     not deadlocked (no leaked finally/onCompromised cleanup).
 *   - STALE / DEAD HOLDER RECLAIMED (adversarial:2, edge:1): a lock directory older than `stale` is
 *     reclaimed by the next builder instead of stalling forever.
 *   - LOCK WRAPS THE ENTIRE CRITICAL SECTION AT EVERY CALL SITE (adversarial:3, adversarial:4): in
 *     both build-*-with-binding scripts rmSync + tsc + write happen INSIDE withBuildLock, and
 *     ensure-dist does no unlocked rm+build of its own (it only delegates to the two locked scripts).
 *
 * Isolated: every behavioral case uses a unique random repoKey and its own tmp lock target, so this
 * never touches the shared worktree dist and is safe to register in validate.commands.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_LOCK_OPTIONS, buildLockTarget, withBuildLock } from '../../../../scripts/build-lock.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
while (!existsSync(join(repoRoot, 'lattice.config.json')) && repoRoot !== dirname(repoRoot)) repoRoot = dirname(repoRoot);
assert.ok(existsSync(join(repoRoot, 'lattice.config.json')), 'could not locate repo root (lattice.config.json)');

const sleep = ms => new Promise(res => setTimeout(res, ms));
const uniqueKey = () => `red-1734-${randomUUID()}`;
const cleanup = key => {
  const target = buildLockTarget(key);
  rmSync(`${target}.lock`, { recursive: true, force: true });
  rmSync(target, { force: true });
};

// ── 1. CONFIG INVARIANT (adversarial:1, edge:2) ─────────────────────────────
{
  const { stale, update } = BUILD_LOCK_OPTIONS;
  assert.equal(typeof stale, 'number', 'BUILD_LOCK_OPTIONS.stale must be numeric');
  assert.equal(typeof update, 'number', 'BUILD_LOCK_OPTIONS.update must be numeric');
  assert.ok(stale >= 30000, `stale must be >= 30000ms (a crashed holder is reclaimed, not stalled): got ${stale}`);
  assert.ok(
    update > 0 && update < stale / 2,
    `update (heartbeat) must be > 0 and < stale/2 so a LIVE holder refreshes before stale expiry — ` +
      `the specific mechanism that prevents live-holder age-steal (B-fb7b finding #1): got update=${update}, stale=${stale}`,
  );
  // DEFAULT mkdir strategy: no `fs` / `lockfilePath` override, so no flock/fcntl/native module — the
  // cross-platform guarantee (Windows has no flock).
  assert.ok(!('fs' in BUILD_LOCK_OPTIONS), 'BUILD_LOCK_OPTIONS must not override `fs` (keep the portable mkdir strategy)');
  assert.ok(!('lockfilePath' in BUILD_LOCK_OPTIONS), 'BUILD_LOCK_OPTIONS must not override lockfilePath (keep the default `<target>.lock`)');
  const retries = BUILD_LOCK_OPTIONS.retries;
  const retryCount = typeof retries === 'number' ? retries : retries?.retries;
  assert.ok(Number(retryCount) >= 10, `retries must make a concurrent builder WAIT (not fail): got ${retryCount}`);
}

// ── 2. MUTUAL EXCLUSION / LIVE HOLDER NOT STOLEN (adversarial:0) ─────────────
{
  const key = uniqueKey();
  try {
    const events = [];
    const hold = id =>
      withBuildLock(key, async () => {
        events.push({ id, ev: 'enter', t: Date.now() });
        await sleep(600);
        events.push({ id, ev: 'exit', t: Date.now() });
      });
    await Promise.all([hold('A'), hold('B')]);
    // Four events in time order. If the lock were not mutually exclusive the two holders would
    // overlap and produce enter,enter,exit,exit; a working mutex produces enter,exit,enter,exit —
    // so the SECOND event must be an 'exit' (the first holder released before the second entered).
    events.sort((a, b) => a.t - b.t);
    assert.equal(events.length, 4, 'expected two enter/exit pairs');
    assert.equal(
      events[1].ev,
      'exit',
      'a live holder was STOLEN: the second builder entered while the first was still inside the critical section — ' +
        `the mutex did not serialize (event order: ${events.map(e => `${e.id}:${e.ev}`).join(',')})`,
    );
  } finally {
    cleanup(key);
  }
}

// ── 3. RELEASED ON ERROR (edge:0) ───────────────────────────────────────────
{
  const key = uniqueKey();
  try {
    let threw = false;
    try {
      await withBuildLock(key, () => {
        throw new Error('simulated tsc failure mid-critical-section');
      });
    } catch (e) {
      threw = true;
      assert.match(String(e && e.message), /simulated tsc failure/, 'the original error must propagate');
    }
    assert.ok(threw, 'withBuildLock must reject when fn throws');
    // If the lock leaked on error, this second acquisition would hang until the stale window (30s).
    const result = await Promise.race([
      withBuildLock(key, () => 'reacquired'),
      sleep(10000).then(() => 'TIMEOUT'),
    ]);
    assert.equal(result, 'reacquired', 'the lock must be RELEASED on error (a leaked lock would deadlock the next builder)');
  } finally {
    cleanup(key);
  }
}

// ── 4. STALE / DEAD HOLDER RECLAIMED (adversarial:2, edge:1) ─────────────────
{
  const key = uniqueKey();
  try {
    const target = buildLockTarget(key);
    writeFileSync(target, '');
    // Simulate a crashed holder: a lock directory whose mtime is far older than `stale`.
    mkdirSync(`${target}.lock`, { recursive: true });
    const old = (Date.now() - BUILD_LOCK_OPTIONS.stale * 2) / 1000;
    utimesSync(`${target}.lock`, old, old);
    const result = await Promise.race([
      withBuildLock(key, () => 'reclaimed'),
      sleep(10000).then(() => 'TIMEOUT'),
    ]);
    assert.equal(
      result,
      'reclaimed',
      'a DEAD holder (lock mtime older than stale) must be reclaimed by the next builder; a stale=Infinity impl would deadlock',
    );
  } finally {
    cleanup(key);
  }
}

// ── 5. LOCK WRAPS THE WHOLE rm+tsc+write AT EVERY CALL SITE (adversarial:3/4) ─
function assertLockWraps(rel, writeFnName) {
  const src = readFileSync(join(repoRoot, rel), 'utf8');
  const lockIdx = src.indexOf('withBuildLock(');
  const rmIdx = src.indexOf('rmSync(');
  const writeIdx = src.indexOf(`${writeFnName}(`);
  assert.ok(lockIdx >= 0, `${rel}: must acquire withBuildLock`);
  assert.ok(rmIdx >= 0, `${rel}: must rm the dist tree before rebuilding`);
  assert.ok(writeIdx >= 0, `${rel}: must call ${writeFnName} to record the binding`);
  assert.ok(
    rmIdx > lockIdx,
    `${rel}: rmSync(dist) happens BEFORE withBuildLock — a concurrent reader would see a half-removed dist (MODULE_NOT_FOUND)`,
  );
  assert.ok(
    writeIdx > rmIdx,
    `${rel}: ${writeFnName} must come after the rm (inside the same locked section) so the binding is written last`,
  );
}
assertLockWraps('scripts/build-main-with-binding.mjs', 'writeBuildBinding');
assertLockWraps('scripts/build-utils-with-binding.mjs', 'writeUtilsBuildBinding');
// ensure-dist is the third named call site: it must NOT do an unlocked rm+build of its own — all
// rm+build is delegated to the two locked scripts above.
const ensureSrc = readFileSync(join(repoRoot, 'scripts/ensure-dist.mjs'), 'utf8');
assert.ok(ensureSrc.includes('build-main-with-binding.mjs') && ensureSrc.includes('build-utils-with-binding.mjs'),
  'ensure-dist must delegate to both locked build scripts');
assert.ok(!/rmSync\s*\(/.test(ensureSrc),
  'ensure-dist must NOT rm the dist directly (an unlocked critical section) — it delegates to the locked build scripts');

console.log('PASS red-1734-lock-liveness: mutex serializes live holders, reclaims dead ones, releases on error, and wraps rm+tsc+write at every call site');
