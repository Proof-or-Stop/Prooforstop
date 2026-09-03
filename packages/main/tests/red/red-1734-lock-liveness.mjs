#!/usr/bin/env node
/**
 * RED (repro-first) for B-1734 CHK-001 — the cross-platform build mutex.
 *
 * Covers EACH of the 10 CHK-001 verificationIntent cases and prints a distinct
 * `VI-OK CHK-001:<sub>:<n>` marker ONLY after that case's real assertion passes, so a broken lock
 * still fails and no marker is emitted for an unmet case:
 *   happy:0        lock-lifecycle: `<target>.lock` exists DURING the section, absent AFTER release
 *   happy:1        two sequential runs: the first fully releases so the second never contends/leaks
 *   edge:0         a fn that throws still releases the lock (no leaked finally cleanup / deadlock)
 *   edge:1         a SIGTERM'd holder's lock is cleaned up by proper-lockfile's signal handler and
 *                  the next builder reclaims it
 *   edge:2         code: DEFAULT mkdir strategy — no flock/fcntl/native module, no `fs` override
 *   adversarial:0  mutual exclusion: two concurrent holders on one key never overlap (live not stolen)
 *   adversarial:1  code: stale >= 30000 AND update (heartbeat) < stale/2 (live-holder heartbeat)
 *   adversarial:2  a DEAD holder (lock mtime older than stale) is reclaimed race-safely
 *   adversarial:3  the lock wraps the ENTIRE rm+tsc+write section (source order) at each call site
 *   adversarial:4  ALL three call sites (ensure-dist + both build-*-with-binding) take the SAME lock
 *
 * Isolated: every behavioral case uses a unique random repoKey and its own tmp lock target, so this
 * never touches the shared worktree dist and is safe to register in validate.commands.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_LOCK_OPTIONS, buildLockTarget, withBuildLock } from '../../../../scripts/build-lock.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
while (!existsSync(join(repoRoot, 'proof-or-stop.config.json')) && !existsSync(join(repoRoot, 'proof-or-stop.config.json')) && repoRoot !== dirname(repoRoot)) repoRoot = dirname(repoRoot);
assert.ok(existsSync(join(repoRoot, 'proof-or-stop.config.json')) || existsSync(join(repoRoot, 'proof-or-stop.config.json')), 'could not locate repo root (proof-or-stop.config.json)');
const LOCK_MODULE_ABS = join(repoRoot, 'scripts', 'build-lock.mjs');

const sleep = ms => new Promise(res => setTimeout(res, ms));
const uniqueKey = () => `red-1734-${randomUUID()}`;
const lockDir = key => `${buildLockTarget(key)}.lock`;
const cleanup = key => {
  rmSync(lockDir(key), { recursive: true, force: true });
  rmSync(buildLockTarget(key), { force: true });
};
async function pollUntil(pred, timeoutMs = 8000, stepMs = 25) {
  for (let waited = 0; waited < timeoutMs; waited += stepMs) {
    if (pred()) return true;
    await sleep(stepMs);
  }
  return pred();
}

// ── adversarial:1 — CONFIG: stale >= 30000 AND update < stale/2 ─────────────
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
  const retries = BUILD_LOCK_OPTIONS.retries;
  const retryCount = typeof retries === 'number' ? retries : retries?.retries;
  assert.ok(Number(retryCount) >= 10, `retries must make a concurrent builder WAIT (not fail): got ${retryCount}`);
  // The retry COUNT alone is not enough — the WAIT BUDGET is what actually keeps a waiter from
  // crashing with an uncaught ELOCKED while a slow build holds the lock. node-retry waits
  // Math.min(maxTimeout, minTimeout * factor**i) on attempt i, so factor:1 collapses EVERY retry to
  // minTimeout (the 24s bug: 120 * 200ms). Derive the real total from the config the same way
  // node-retry does and require it comfortably exceeds any single build (>= 5 min).
  const minTimeout = typeof retries === 'number' ? 1000 : Number(retries?.minTimeout ?? 1000);
  const maxTimeout = typeof retries === 'number' ? Infinity : Number(retries?.maxTimeout ?? Infinity);
  const factor = typeof retries === 'number' ? 2 : Number(retries?.factor ?? 2);
  let budgetMs = 0;
  for (let i = 0; i < Number(retryCount); i++) budgetMs += Math.min(maxTimeout, minTimeout * factor ** i);
  assert.ok(
    budgetMs >= 300000,
    `the retry WAIT BUDGET must exceed any single build (>= 300000ms / 5 min) so a concurrent builder ` +
      `WAITS instead of crashing with ELOCKED — a factor:1 config collapses every retry to minTimeout ` +
      `and fails this: got ${budgetMs}ms from ${JSON.stringify(retries)}`,
  );
  console.log('VI-OK CHK-001:adversarial:1');
}

// ── edge:2 — CODE: default mkdir strategy, no fs:lockFile option overriding it ─
{
  const lockSrc = readFileSync(LOCK_MODULE_ABS, 'utf8');
  assert.ok(/proper-lockfile/.test(lockSrc), 'build-lock.mjs must use proper-lockfile (portable mkdir mutex, no native module)');
  // Grep the lock CALL itself for the absence of a strategy override: it must pass BUILD_LOCK_OPTIONS
  // and no inline `fs:` option (an fs:lockFile override would swap out the cross-platform mkdir default).
  const callMatch = lockSrc.match(/lockfile\.lock\(([^)]*)\)/s);
  assert.ok(callMatch, 'build-lock.mjs must call lockfile.lock(...)');
  assert.ok(/BUILD_LOCK_OPTIONS/.test(callMatch[1]), 'the lock call must pass the reviewed BUILD_LOCK_OPTIONS');
  assert.ok(!/\bfs\s*:/.test(callMatch[1]), 'the lock call must not pass an inline `fs:` option overriding the mkdir strategy');
  assert.ok(!('fs' in BUILD_LOCK_OPTIONS), 'BUILD_LOCK_OPTIONS must not override `fs` (keep the mkdir strategy — Windows has no flock)');
  assert.ok(!('lockfilePath' in BUILD_LOCK_OPTIONS), 'BUILD_LOCK_OPTIONS must not override lockfilePath (default `<target>.lock`)');
  console.log('VI-OK CHK-001:edge:2');
}

// ── happy:0 — lock LIFECYCLE: dir present DURING, absent AFTER ───────────────
{
  const key = uniqueKey();
  try {
    let presentDuring = false;
    const ret = await withBuildLock(key, () => {
      presentDuring = existsSync(lockDir(key));
      return 'built-both';
    });
    assert.equal(ret, 'built-both', 'withBuildLock must return the fn result');
    assert.ok(presentDuring, 'the lock directory must EXIST while the critical section runs');
    assert.ok(!existsSync(lockDir(key)), 'the lock directory must be ABSENT after the section releases');
    console.log('VI-OK CHK-001:happy:0');
  } finally {
    cleanup(key);
  }
}

// ── happy:1 — two SEQUENTIAL runs: first releases, second never contends ─────
{
  const key = uniqueKey();
  try {
    const r1 = await withBuildLock(key, () => 'run-1');
    const releasedBetween = !existsSync(lockDir(key));
    const r2 = await withBuildLock(key, () => 'run-2');
    assert.equal(r1, 'run-1');
    assert.equal(r2, 'run-2');
    assert.ok(releasedBetween, 'the first run must fully release the lock on normal completion (no leak)');
    assert.ok(!existsSync(lockDir(key)), 'the lock must be absent after the second sequential run too');
    console.log('VI-OK CHK-001:happy:1');
  } finally {
    cleanup(key);
  }
}

// ── adversarial:0 — MUTUAL EXCLUSION / live holder not stolen ────────────────
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
    events.sort((a, b) => a.t - b.t);
    assert.equal(events.length, 4, 'expected two enter/exit pairs');
    // A working mutex yields enter,exit,enter,exit; an overlap yields enter,enter,exit,exit.
    assert.equal(
      events[1].ev,
      'exit',
      'a live holder was STOLEN: the second builder entered while the first was still inside the critical section ' +
        `(event order: ${events.map(e => `${e.id}:${e.ev}`).join(',')})`,
    );
    console.log('VI-OK CHK-001:adversarial:0');
  } finally {
    cleanup(key);
  }
}

// ── edge:0 — RELEASED ON ERROR ──────────────────────────────────────────────
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
    assert.ok(!existsSync(lockDir(key)), 'the lock directory must be released even when fn throws');
    const result = await Promise.race([withBuildLock(key, () => 'reacquired'), sleep(10000).then(() => 'TIMEOUT')]);
    assert.equal(result, 'reacquired', 'a leaked lock would deadlock the next builder; it must be released on error');
    console.log('VI-OK CHK-001:edge:0');
  } finally {
    cleanup(key);
  }
}

// ── adversarial:2 — DEAD holder (stale mtime) reclaimed ─────────────────────
{
  const key = uniqueKey();
  try {
    const target = buildLockTarget(key);
    writeFileSync(target, '');
    mkdirSync(lockDir(key), { recursive: true });
    const old = (Date.now() - BUILD_LOCK_OPTIONS.stale * 2) / 1000; // well past stale
    utimesSync(lockDir(key), old, old);
    const result = await Promise.race([withBuildLock(key, () => 'reclaimed'), sleep(10000).then(() => 'TIMEOUT')]);
    assert.equal(result, 'reclaimed', 'a DEAD holder (lock mtime older than stale) must be reclaimed; a stale=Infinity impl would deadlock');
    console.log('VI-OK CHK-001:adversarial:2');
  } finally {
    cleanup(key);
  }
}

// ── edge:1 — SIGTERM'd holder cleaned up by the signal handler, then reclaimed ─
{
  const key = uniqueKey();
  const childPath = join(tmpdir(), `red-1734-sigterm-${randomUUID()}.mjs`);
  let child;
  try {
    writeFileSync(
      childPath,
      `import { withBuildLock } from ${JSON.stringify(LOCK_MODULE_ABS)};\n` +
        `await withBuildLock(${JSON.stringify(key)}, () => new Promise(() => {\n` +
        `  process.stdout.write('READY\\n');\n` +
        `  setInterval(() => {}, 1000); // keep the event loop alive so the lock is genuinely HELD until SIGTERM\n` +
        `}));\n`,
    );
    child = spawn(process.execPath, [childPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let ready = false;
    child.stdout.on('data', d => { if (String(d).includes('READY')) ready = true; });
    assert.ok(await pollUntil(() => ready, 8000), 'child holder failed to acquire the lock');
    assert.ok(existsSync(lockDir(key)), 'the child holder must be holding the lock before SIGTERM');
    child.kill('SIGTERM');
    // proper-lockfile registers a signal-exit cleanup; the lock must be removed on SIGTERM.
    assert.ok(await pollUntil(() => !existsSync(lockDir(key)), 8000), 'a SIGTERM\'d holder must have its lock cleaned up by the signal handler');
    const result = await Promise.race([withBuildLock(key, () => 'reclaimed'), sleep(10000).then(() => 'TIMEOUT')]);
    assert.equal(result, 'reclaimed', 'after the SIGTERM\'d holder is cleaned up the next builder must reclaim the lock');
    console.log('VI-OK CHK-001:edge:1');
  } finally {
    if (child && !child.killed) child.kill('SIGKILL');
    rmSync(childPath, { force: true });
    cleanup(key);
  }
}

// ── adversarial:3 — the lock wraps the WHOLE rm+tsc+write at each call site ──
function assertLockWraps(rel, writeFnName) {
  const src = readFileSync(join(repoRoot, rel), 'utf8');
  const lockIdx = src.indexOf('withBuildLock(');
  const rmIdx = src.indexOf('rmSync(');
  const writeIdx = src.indexOf(`${writeFnName}(`);
  assert.ok(lockIdx >= 0, `${rel}: must acquire withBuildLock`);
  assert.ok(rmIdx >= 0, `${rel}: must rm the dist tree before rebuilding`);
  assert.ok(writeIdx >= 0, `${rel}: must call ${writeFnName} to record the binding`);
  assert.ok(rmIdx > lockIdx, `${rel}: rmSync(dist) happens BEFORE withBuildLock — a concurrent reader would see a half-removed dist`);
  assert.ok(writeIdx > rmIdx, `${rel}: ${writeFnName} must come after the rm inside the same locked section (binding written last)`);
}
{
  assertLockWraps('scripts/build-main-with-binding.mjs', 'writeBuildBinding');
  assertLockWraps('scripts/build-utils-with-binding.mjs', 'writeUtilsBuildBinding');
  console.log('VI-OK CHK-001:adversarial:3');
}

// ── adversarial:4 — ALL three call sites take the SAME lock ──────────────────
{
  const mainSrc = readFileSync(join(repoRoot, 'scripts/build-main-with-binding.mjs'), 'utf8');
  const utilsSrc = readFileSync(join(repoRoot, 'scripts/build-utils-with-binding.mjs'), 'utf8');
  const ensureSrc = readFileSync(join(repoRoot, 'scripts/ensure-dist.mjs'), 'utf8');
  // The two rm+build call sites acquire withBuildLock keyed on the SAME per-repo projectRoot.
  assert.ok(/withBuildLock\(\s*projectRoot\b/.test(mainSrc), 'build-main-with-binding.mjs must take withBuildLock(projectRoot, ...)');
  assert.ok(/withBuildLock\(\s*projectRoot\b/.test(utilsSrc), 'build-utils-with-binding.mjs must take withBuildLock(projectRoot, ...) — the SAME per-repo lock as main');
  // The third named call site (ensure-dist) does no unlocked rm+build of its own; it delegates to
  // the two locked scripts, so every critical section is behind the same mutex.
  assert.ok(
    ensureSrc.includes('build-main-with-binding.mjs') && ensureSrc.includes('build-utils-with-binding.mjs'),
    'ensure-dist must delegate to both locked build scripts',
  );
  assert.ok(!/rmSync\s*\(/.test(ensureSrc), 'ensure-dist must NOT rm the dist directly (an unlocked critical section)');
  console.log('VI-OK CHK-001:adversarial:4');
}

// ── adversarial:5 — LIVENESS: the heartbeat fires during an ASYNC critical section (event loop free) ─
// D2: proper-lockfile refreshes `<target>.lock`'s mtime every `update` (10s) via a setInterval — which
// can ONLY fire when the event loop is not blocked. tsc now runs as an AWAITED async child, so the loop
// stays free during the seconds-long compile and the heartbeat keeps the lock fresh. A synchronous
// execFileSync compile would BLOCK the loop for the whole emit, freeze the heartbeat, and let a build
// longer than the 30s stale threshold have its LIVE lock age-stolen (B-fb7b). Prove the mechanism: hold
// the lock across an AWAITED sleep spanning one heartbeat interval and assert the lock mtime ADVANCED —
// only possible because the event loop was free. Deterministic ~12s, generous margins (non-flaky).
{
  const key = uniqueKey();
  try {
    const dir = lockDir(key);
    let before = 0;
    let after = 0;
    await withBuildLock(key, async () => {
      before = statSync(dir).mtimeMs;
      await sleep(11500); // spans one 10s heartbeat; advances the mtime ONLY if the event loop is free
      after = statSync(dir).mtimeMs;
    });
    assert.ok(
      after - before >= 5000,
      `the proper-lockfile heartbeat must refresh the lock mtime during an AWAITED async critical section ` +
        `(event loop free): the mtime advanced only ${after - before}ms. A blocking execFileSync compile ` +
        `would freeze the event loop so the heartbeat never fires — reopening the B-fb7b live-holder ` +
        `age-steal for any build longer than the 30s stale threshold (before=${before}, after=${after})`,
    );
    console.log('VI-OK CHK-001:adversarial:5');
  } finally {
    cleanup(key);
  }
}

// ── adversarial:6 — CODE: the tsc step is an AWAITED ASYNC child, never a blocking execFileSync (D2) ──
{
  for (const rel of ['scripts/build-main-with-binding.mjs', 'scripts/build-utils-with-binding.mjs']) {
    const src = readFileSync(join(repoRoot, rel), 'utf8');
    // Match a CALL (execFileSync followed by `(`), not a prose mention in a comment — the comments here
    // legitimately explain WHY execFileSync is avoided.
    assert.ok(
      !/execFileSync\s*\(/.test(src),
      `${rel}: must NOT call execFileSync for the tsc step — a synchronous compile blocks the event loop, ` +
        `freezing the proper-lockfile heartbeat so a >30s build's live lock can be age-stolen (D2)`,
    );
    assert.ok(
      !/\bexecFileSync\b/.test(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')),
      `${rel}: must not import or reference execFileSync in CODE (comments explaining its absence are fine)`,
    );
    assert.ok(
      /await\s+execFileAsync\s*\(/.test(src),
      `${rel}: the tsc step must be an AWAITED async child process (execFileAsync) so the event loop stays free for the heartbeat`,
    );
    assert.ok(
      /withBuildLock\(\s*projectRoot\s*,\s*async\b/.test(src),
      `${rel}: the withBuildLock callback must be async so it can await the async tsc child`,
    );
  }
  console.log('VI-OK CHK-001:adversarial:6');
}

console.log('PASS red-1734-lock-liveness: mutex serializes live holders, reclaims dead/SIGTERM\'d ones, releases on error, wraps rm+tsc+write at every call site, and its heartbeat fires during an async (event-loop-free) critical section — tsc is an awaited async child, never a blocking execFileSync');
