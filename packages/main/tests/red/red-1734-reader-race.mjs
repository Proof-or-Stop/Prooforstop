#!/usr/bin/env node
/**
 * RED (live-reproduced) for B-1734 F-003 — a concurrent rebuild must NOT expose an absent/partial
 * dist to readers of packages/main/dist.
 *
 * bin/bootstrap-runner.js is imported by EVERY bin/proof-or-stop.js call. At B-1734 it held no lock at
 * all (only build-TAKERS did), and the pre-fix build did `rmSync(dist)` then a seconds-long in-place
 * tsc, so for that whole window a concurrent `bin/proof-or-stop.js` reader saw dist absent/partial and
 * died with MODULE_NOT_FOUND / "bootstrap is not ready", violating BOTH userSees claims ("never
 * MODULE_NOT_FOUND"). The B-1734 fix builds into a SIBLING staging dir and promotes it by an atomic
 * rename (so a reader always sees the old-complete or new-complete dist), and makes the universal entry
 * point bin/bootstrap-runner.js WAIT+retry while a build lock is held instead of crashing.
 *
 * SINCE B-bcae the reader this file spawns is no longer unsynchronised with builders: it takes READER
 * ADMISSION on distImportLockTarget before importing dist, and withBuildLock nests that same target
 * inside buildLockTarget for the whole build critical section. It still does not take buildLockTarget
 * itself — deliberately, so an ordinary CLI startup is never reported as a build. Read readerrace:0
 * accordingly: zero MODULE_NOT_FOUND is now carried by mutual exclusion with promotion, with the atomic
 * staging-swap behind it (and still the whole story for dist readers that take no lock at all).
 *
 * This test RACES the REAL reader against a REAL rebuild:
 *   1. Force a genuine rebuild by removing the main build manifest (a gitignored dist artifact — no
 *      tracked source change), so build-main-with-binding.mjs takes the slow rm/tsc path (~seconds).
 *   2. Spawn `node scripts/build-main-with-binding.mjs` (the real build) AND, in overlapping waves for
 *      the whole build window, dozens of `node bin/proof-or-stop.js --help` children (the real universal
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILD_MANIFEST,
  verifyBuildBinding,
  verifyUtilsBuildBinding,
} from '../../../../scripts/full-suite-build-binding.mjs';
import { BUILD_LOCK_OPTIONS, buildLockTarget } from '../../../../scripts/build-lock.mjs';
import { promoteDist } from '../../../../scripts/promote-dist.mjs';
import { buildInProgress, IMPORT_WAIT_MAX_MS } from '../../../../bin/bootstrap-runner.js';

const here = dirname(fileURLToPath(import.meta.url));
// Repo root is a fixed four levels up (packages/main/tests/red -> root) — the same
// relative anchor as the scripts/full-suite-build-binding.mjs import above, and the
// same idiom the genuine registration guards (e.g. red-w2c-validate-registration.mjs)
// use. Root is resolved by DEPTH, not by scanning for the root config file, on
// purpose: this is a build-concurrency RED test, not a registration decider, and
// red-b49d4-registration-derivation.mjs derives its target guards from red *.mjs that
// reference that config file AND enumerate a directory. Naming the config here (even
// only as a root-finding sentinel) would mis-derive this test into that meta-guard's
// symlink mirror, where treeDigest sees no real dist and verifyBuildBinding throws for
// a reason unrelated to anything this test asserts.
const repoRoot = join(here, '..', '..', '..', '..');
assert.ok(
  existsSync(join(repoRoot, 'scripts', 'full-suite-build-binding.mjs')),
  'could not locate repo root (expected scripts/full-suite-build-binding.mjs four levels above this test)',
);

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
  // Precondition: both dists are present and verifying, and bin/proof-or-stop.js reads cleanly at rest.
  const warm = await spawnCapture(['bin/proof-or-stop.js', '--help']);
  assert.equal(warm.code, 0, `precondition: bin/proof-or-stop.js --help must succeed at rest, got code ${warm.code}\n${warm.out.slice(0, 400)}`);
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
    const p = spawnCapture(['bin/proof-or-stop.js', '--help']).then(r => { readerResults.push(r); inFlight.delete(p); });
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
    `${failures.length}/${readerResults.length} concurrent bin/proof-or-stop.js readers saw an absent/partial dist during the rebuild ` +
      `(F-003: readers must NEVER see MODULE_NOT_FOUND). Sample: ` +
      failures.slice(0, 3).map(f => `[code=${f.code}] ${f.out.replace(/\s+/g, ' ').slice(0, 200)}`).join(' || '),
  );
  console.log('VI-OK CHK-001:readerrace:0');

  // Restore a clean worktree: main dist+manifest are freshly built (the race rebuilt them); confirm
  // both bindings verify and no transient swap siblings remain.
  sweepSwapSiblings();
  assert.doesNotThrow(() => verifyBuildBinding(repoRoot), 'after the race the main build binding must verify (clean worktree)');
  assert.doesNotThrow(() => verifyUtilsBuildBinding(repoRoot), 'after the race the utils build binding must still verify (clean worktree)');

  // ── readerrace:1 — a buildLockTarget-only lock must NOT brick readers, fresh OR stale ────────────
  // Two separate properties, and after B-bcae they live on two different branches of
  // importDistModules. Keep them apart or one silently stops discriminating.
  //
  //   UNIT — buildInProgress() freshness. A build interrupted by Ctrl-C/SIGKILL/crash skips its
  //   finally-release and leaves `<target>.lock` orphaned. That predicate is what the dist-ABSENT wait
  //   branch consults, and it must gate on lock FRESHNESS (proper-lockfile staleness), not mere
  //   existence, or a never-built checkout with an orphaned lock would wait out the whole ceiling
  //   instead of failing fast with the recovery hint.
  //
  //   LIVE — the dist-PRESENT branch, which is what a real `bin/proof-or-stop.js --help` takes here.
  //   Since B-bcae that branch does not consult buildInProgress() at all (bin/bootstrap-runner.js
  //   samples it only after an entry was observed ABSENT); exclusion is delegated entirely to reader
  //   admission on distImportLockTarget. So this half is NOT a second freshness proof — asserting it
  //   with only a STALE lock would pass for a reason unrelated to freshness. It is the executable
  //   record of the residual B-bcae F-040 names: a critical section holding buildLockTarget ALONE
  //   (withCanonicalBuildLock's shape) does not exclude an admitted reader. Both mtimes are exercised
  //   and BOTH must import immediately; a reader that stalled on either would show up as a time-bound
  //   failure here rather than as an unexplained pause in an unrelated command.
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
      // Live, both mtimes. `stale` is the orphaned-build case; `fresh` is the F-040 residual — nothing
      // holds distImportLockTarget, so an admitted reader must proceed even though every canonical
      // build-in-progress observer would report a live build.
      const liveTimings = [];
      for (const [label, seconds] of [['stale', staleSec], ['fresh', Date.now() / 1000]]) {
        utimesSync(lockDir, seconds, seconds);
        const t0 = Date.now();
        const reader = await spawnCapture(['bin/proof-or-stop.js', '--help']);
        const elapsed = Date.now() - t0;
        assert.equal(reader.code, 0, `a reader must succeed with a ${label} buildLockTarget-only lock, got code ${reader.code}\n${reader.out.slice(0, 400)}`);
        assert.ok(!READER_FAIL_RE.test(reader.out), `a reader must not report bootstrap-not-ready with a ${label} buildLockTarget-only lock:\n${reader.out.slice(0, 400)}`);
        assert.ok(
          elapsed < 15000,
          `a ${label} buildLockTarget-only lock must not delay a dist-present reader — it holds no ` +
            `reader-admission target (B-bcae F-040): took ${elapsed}ms`,
        );
        liveTimings.push(`${label}=${elapsed}ms`);
      }
      console.log(`VI-OK CHK-001:readerrace:1 (buildLockTarget-only reader: ${liveTimings.join(', ')})`);
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }

  // ── readerrace:2 — C4: a slow, LIVE build is waited on well past 60s (no fixed short cap) ─────────
  // The pre-fix reader gave up after a fixed 60s (IMPORT_WAIT_CAP=240 × 250ms) even while buildInProgress()
  // still reported a FRESH heartbeating lock — but the main build timeout is 290s and the builder retry
  // budget is ~10min, so a legitimately slow build failed concurrent readers after 1 minute. The fix
  // replaces the fixed cap with an absolute wall-clock ceiling (IMPORT_WAIT_MAX_MS) and keeps waiting
  // while the lock is fresh. Unit-tested WITHOUT sleeping 60s: assert the ceiling covers the build
  // duration, that the fixed cap is gone, and that a FRESH lock keeps buildInProgress() true (so the
  // give-up branch, which requires !buildInProgress() when dist is absent, does not fire).
  {
    assert.ok(
      IMPORT_WAIT_MAX_MS >= 290000,
      `the reader wait ceiling must be >= the 290s build timeout so a legitimately slow build is never abandoned: got ${IMPORT_WAIT_MAX_MS}ms`,
    );
    const bootSrc = readFileSync(join(repoRoot, 'bin/bootstrap-runner.js'), 'utf8');
    assert.ok(!/IMPORT_WAIT_CAP/.test(bootSrc), 'the fixed 60s IMPORT_WAIT_CAP must be gone (replaced by the absolute IMPORT_WAIT_MAX_MS ceiling)');
    assert.ok(/IMPORT_WAIT_MAX_MS/.test(bootSrc), 'bootstrap must bound waiting by the absolute IMPORT_WAIT_MAX_MS ceiling');
    assert.ok(
      /keepWaiting\s*=\s*buildInProgress\(\)/.test(bootSrc),
      'the wait predicate must keep waiting while buildInProgress() reports a fresh lock (give-up requires !buildInProgress() when dist is absent)',
    );
    const lockDir = `${buildLockTarget(repoRoot)}.lock`;
    try {
      rmSync(lockDir, { recursive: true, force: true });
      mkdirSync(lockDir, { recursive: true });
      const nowSec = Date.now() / 1000;
      utimesSync(lockDir, nowSec, nowSec);
      assert.equal(buildInProgress(), true, 'a FRESH heartbeating lock must keep the reader waiting (never give up at a short 60s cap)');
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
    console.log('VI-OK CHK-001:readerrace:2');
  }

  // ── readerrace:3 — C2: a failed staging→dist rename RESTORES the old dist (never left absent) ─────
  // Pre-fix the promotion was `renameSync(dist,trash); renameSync(staging,dist)` — if the SECOND rename
  // failed after the first succeeded, dist was gone (in trash) and staging orphaned, leaving dist ABSENT
  // and the CLI broken until the next build. promoteDist restores the old dist from trash on failure.
  // Deterministic: staging is ABSENT so staging→dist throws ENOENT after the old dist was evicted.
  {
    const base = mkdtempSync(join(tmpdir(), 'red-1734-promote-'));
    try {
      const dist = join(base, 'dist');
      const staging = join(base, 'dist.staging'); // deliberately absent → the second rename throws ENOENT
      const trash = join(base, 'dist.trash');
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, 'index.js'), 'export const OLD = 1;\n');
      writeFileSync(join(dist, 'sub.js'), 'export const S = 2;\n');
      let threw = false;
      try {
        promoteDist(dist, staging, trash);
      } catch (e) {
        threw = true;
        assert.equal(e && e.code, 'ENOENT', `the ORIGINAL staging→dist error must surface (not the restore error), got ${e && e.code}`);
      }
      assert.ok(threw, 'promoteDist must rethrow when the staging→dist rename fails');
      assert.ok(existsSync(dist), 'the OLD dist must be RESTORED (never left absent) when promotion fails mid-swap');
      assert.equal(readFileSync(join(dist, 'index.js'), 'utf8'), 'export const OLD = 1;\n', 'the restored dist must be COMPLETE (old content intact)');
      assert.equal(readFileSync(join(dist, 'sub.js'), 'utf8'), 'export const S = 2;\n', 'the restored dist must include EVERY old file');
      assert.ok(!existsSync(trash), 'a successful restore must not leave the old dist orphaned in trash');
      console.log('VI-OK CHK-001:readerrace:3');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ── readerrace:4 — C1: build-utils has NO pre-lock verify-and-exit (verify only inside the lock) ──
  // The utils binding folds in packages/main/dist (a MUTABLE external). A pre-lock fast-path could
  // validate against the OLD main/dist while a concurrent MAIN build holds the shared lock and is about
  // to swap in NEW main/dist, exiting "fresh" and leaving the utils binding stale — so utils+main would
  // NOT be mutually exclusive. The fix removes the pre-lock fast-path; every verify runs INSIDE the lock
  // (where the shared lock keeps main/dist stable). Static assert: no verify and no process.exit(0)
  // before withBuildLock. (build-main keeps its pre-lock fast-path safely — its binding is self-contained.)
  {
    const utilsSrc = readFileSync(join(repoRoot, 'scripts/build-utils-with-binding.mjs'), 'utf8');
    const lockIdx = utilsSrc.indexOf('withBuildLock(');
    assert.ok(lockIdx >= 0, 'build-utils-with-binding.mjs must take withBuildLock');
    const verifyIdxs = [...utilsSrc.matchAll(/verifyUtilsBuildBinding\s*\(/g)].map(m => m.index);
    assert.ok(verifyIdxs.length > 0, 'build-utils must still verify (the double-check INSIDE the lock)');
    for (const idx of verifyIdxs) {
      assert.ok(
        idx > lockIdx,
        'every verifyUtilsBuildBinding call must be INSIDE withBuildLock — a pre-lock fast-path could validate a mutable main/dist before a concurrent main build swaps it (C1)',
      );
    }
    assert.ok(
      !/process\.exit\s*\(\s*0\s*\)/.test(utilsSrc.slice(0, lockIdx)),
      'build-utils must have NO pre-lock process.exit(0) fast-path (C1: always take the shared lock, then rely on the in-lock double-check)',
    );
    console.log('VI-OK CHK-001:readerrace:4');
  }

  console.log(`PASS red-1734-reader-race: ${readerResults.length} concurrent bin/proof-or-stop.js readers raced a real rebuild with ZERO MODULE_NOT_FOUND; a buildLockTarget-only lock does not brick readers, stale or fresh; the reader waits a live build past 60s; promotion restores dist on failure (in-process); utils has no pre-lock fast-path`);
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
