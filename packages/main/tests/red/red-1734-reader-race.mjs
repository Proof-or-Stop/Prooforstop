#!/usr/bin/env node
/**
 * RED (live-reproduced) for B-1734 F-003 — a concurrent rebuild must NOT expose an absent/partial
 * dist to the ~90 non-lock-holding readers of packages/main/dist.
 *
 * bin/bootstrap-runner.js is imported by EVERY bin/lattice.js call, yet it does NOT hold the build
 * lock (only build-TAKERS do). The pre-fix build did `rmSync(dist)` then a seconds-long in-place tsc,
 * so for that whole window a concurrent `bin/lattice.js` reader saw dist absent/partial and died with
 * MODULE_NOT_FOUND / "bootstrap is not ready", violating BOTH userSees claims ("never
 * MODULE_NOT_FOUND"). The fix builds into a SIBLING staging dir and promotes it by an atomic rename
 * (so a reader always sees the old-complete or new-complete dist), and makes the universal entry point
 * bin/bootstrap-runner.js WAIT+retry while a build lock is held instead of crashing.
 *
 * This test RACES the REAL reader against a REAL rebuild:
 *   1. Force a genuine rebuild by removing the main build manifest (a gitignored dist artifact — no
 *      tracked source change), so build-main-with-binding.mjs takes the slow rm/tsc path (~seconds).
 *   2. Spawn `node scripts/build-main-with-binding.mjs` (the real build) AND, in overlapping waves for
 *      the whole build window, dozens of `node bin/lattice.js --help` children (the real universal
 *      reader, through bin/bootstrap-runner.js).
 *   3. Assert ZERO readers failed with MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND / bootstrap-not-ready
 *      (and none exited non-zero). Only THEN print `VI-OK CHK-001:readerrace:0`.
 * Pre-fix (in-place rm+tsc, non-resilient bootstrap) this fails; post-fix it passes.
 *
 * Leaves the worktree clean: main dist+manifest freshly rebuilt, both bindings verifying, no stray
 * dist.staging / dist.trash-* siblings.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILD_MANIFEST,
  verifyBuildBinding,
  verifyUtilsBuildBinding,
} from '../../../../scripts/full-suite-build-binding.mjs';
import { BUILD_LOCK_OPTIONS, buildLockTarget } from '../../../../scripts/build-lock.mjs';
import { buildInProgress } from '../../../../bin/bootstrap-runner.js';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
while (!existsSync(join(repoRoot, 'lattice.config.json')) && repoRoot !== dirname(repoRoot)) repoRoot = dirname(repoRoot);
assert.ok(existsSync(join(repoRoot, 'lattice.config.json')), 'could not locate repo root (lattice.config.json)');

// A reader "failed" if it could not load the CLI dist: any dist-import failure surfaces one of these
// markers (or a non-zero exit). This is exactly the class F-003 must eliminate.
const READER_FAIL_RE = /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module|bootstrap is not ready|Missing build artifacts/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Spawn a child, capture merged stdout+stderr and exit code (never throws — a crash is data).
function spawnCapture(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
    child.on('error', err => resolve({ code: -1, out: String((err && err.stack) || err) }));
  });
}

// Defensively drop any transient atomic-swap siblings a prior interrupted build might have left.
function sweepSwapSiblings() {
  for (const pkg of ['packages/main', 'packages/utils']) {
    const dir = join(repoRoot, pkg);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (/^dist\.(staging|trash-)/.test(name)) rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
}

async function main() {
  sweepSwapSiblings();
  // Precondition: both dists are present and verifying, and bin/lattice.js reads cleanly at rest.
  const warm = await spawnCapture(['bin/lattice.js', '--help']);
  assert.equal(warm.code, 0, `precondition: bin/lattice.js --help must succeed at rest, got code ${warm.code}\n${warm.out.slice(0, 400)}`);
  assert.doesNotThrow(() => verifyBuildBinding(repoRoot), 'precondition: main build binding must verify before the race');
  assert.doesNotThrow(() => verifyUtilsBuildBinding(repoRoot), 'precondition: utils build binding must verify before the race');

  // Force a genuine rebuild: removing the manifest (a gitignored dist artifact) makes verifyBuildBinding
  // throw, so the build takes the slow rm/tsc path — a real seconds-long window a reader can race.
  rmSync(join(repoRoot, BUILD_MANIFEST), { force: true });

  let buildDone = false;
  const buildP = spawnCapture(['scripts/build-main-with-binding.mjs']).then(r => { buildDone = true; return r; });

  // Keep a steady stream of REAL universal readers IN FLIGHT for the ENTIRE build window, so many
  // readers overlap the rm/tsc rebuild and the atomic rename-swap simultaneously. Bounded concurrency
  // caps memory (each reader is a full node process). The loop runs until the build finishes AND a
  // minimum sample is collected, so it works whether the build is fast or slow.
  const MIN_READERS = 40;
  const MAX_INFLIGHT = 24;
  const readerResults = [];
  const inFlight = new Set();
  const want = () => !buildDone || readerResults.length + inFlight.size < MIN_READERS;
  const launch = () => {
    const p = spawnCapture(['bin/lattice.js', '--help']).then(r => { readerResults.push(r); inFlight.delete(p); });
    inFlight.add(p);
  };
  while (want()) {
    while (inFlight.size < MAX_INFLIGHT && want()) launch();
    await Promise.race([...inFlight, sleep(200)]);
  }
  await Promise.all(inFlight);
  const buildResult = await buildP;

  assert.equal(buildResult.code, 0, `the real rebuild must succeed (else the race is meaningless), got code ${buildResult.code}\n${buildResult.out.slice(-800)}`);
  assert.ok(readerResults.length >= MIN_READERS, `expected at least ${MIN_READERS} concurrent readers, got ${readerResults.length}`);

  const failures = readerResults.filter(r => r.code !== 0 || READER_FAIL_RE.test(r.out));
  assert.equal(
    failures.length,
    0,
    `${failures.length}/${readerResults.length} concurrent bin/lattice.js readers saw an absent/partial dist during the rebuild ` +
      `(F-003: readers must NEVER see MODULE_NOT_FOUND). Sample: ` +
      failures.slice(0, 3).map(f => `[code=${f.code}] ${f.out.replace(/\s+/g, ' ').slice(0, 200)}`).join(' || '),
  );
  console.log('VI-OK CHK-001:readerrace:0');

  // Restore a clean worktree: main dist+manifest are freshly built (the race rebuilt them); confirm
  // both bindings verify and no transient swap siblings remain.
  sweepSwapSiblings();
  assert.doesNotThrow(() => verifyBuildBinding(repoRoot), 'after the race the main build binding must verify (clean worktree)');
  assert.doesNotThrow(() => verifyUtilsBuildBinding(repoRoot), 'after the race the utils build binding must still verify (clean worktree)');

  // ── readerrace:1 — an ORPHANED (stale) build lock must NOT brick readers ─────────────────────────
  // A build interrupted by Ctrl-C/SIGKILL/crash skips its finally-release, leaving `<target>.lock`
  // orphaned. The atomic swap already left dist complete, so it is importable — buildInProgress() must
  // gate on lock FRESHNESS (proper-lockfile staleness), not mere existence, or every bin/lattice.js
  // call would wait 60s then fail until the next build reclaims the stale lock. Two proofs: a fast unit
  // check that buildInProgress() distinguishes fresh vs stale, and a LIVE check that a real reader with
  // a stale orphaned lock imports quickly (no 60s hang, no "bootstrap is not ready"). Non-vacuous: with
  // the pre-fix existsSync gate the stale lock would hang the reader ~60s and fail the time bound.
  {
    const lockDir = `${buildLockTarget(repoRoot)}.lock`;
    try {
      rmSync(lockDir, { recursive: true, force: true });
      mkdirSync(lockDir, { recursive: true });
      const nowSec = Date.now() / 1000;
      utimesSync(lockDir, nowSec, nowSec);
      assert.equal(buildInProgress(), true, 'a FRESH lock (mtime=now) must be treated as an active build');
      const staleSec = (Date.now() - BUILD_LOCK_OPTIONS.stale - 5000) / 1000; // older than stale
      utimesSync(lockDir, staleSec, staleSec);
      assert.equal(buildInProgress(), false, 'a STALE orphaned lock (mtime older than stale) must NOT be treated as an active build');
      // Live: a real bin/lattice.js reader with the stale orphaned lock still present must import FAST.
      const t0 = Date.now();
      const reader = await spawnCapture(['bin/lattice.js', '--help']);
      const elapsed = Date.now() - t0;
      assert.equal(reader.code, 0, `a reader must succeed despite a stale orphaned lock, got code ${reader.code}\n${reader.out.slice(0, 400)}`);
      assert.ok(!READER_FAIL_RE.test(reader.out), `a reader must not report bootstrap-not-ready with a stale orphaned lock:\n${reader.out.slice(0, 400)}`);
      assert.ok(elapsed < 15000, `a stale orphaned lock must not make the reader wait ~60s (freshness gate, not existence): took ${elapsed}ms`);
      console.log('VI-OK CHK-001:readerrace:1');
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }

  console.log(`PASS red-1734-reader-race: ${readerResults.length} concurrent bin/lattice.js readers raced a real rebuild with ZERO MODULE_NOT_FOUND; a stale orphaned lock does not brick readers`);
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
