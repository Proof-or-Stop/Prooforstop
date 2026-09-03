#!/usr/bin/env node
/**
 * B-fb7b + B-1734 guard — root `npm test` must self-bootstrap packages/main then packages/utils
 * before the full suite, and it must do so CONTENT-BOUND (skip when dist matches source) under a
 * CROSS-PLATFORM crash-safe mutex (never age-steal a live build, never rm a dist a concurrent
 * reader is using).
 *
 * Fast, structural, pure-read (no build, no lock). It asserts the invariant chain:
 *   1. root package.json "pretest" runs scripts/ensure-dist.mjs;
 *   2. ensure-dist ORCHESTRATES build-main-with-binding.mjs THEN build-utils-with-binding.mjs
 *      (utils tsc links against packages/main/dist, so main must build first) — it is no longer
 *      existence-based;
 *   3. each build-*-with-binding script skips on verifyBuildBinding / verifyUtilsBuildBinding
 *      (sha256 content hash — NOT existsSync) and takes the withBuildLock mutex;
 *   4. scripts/build-lock.mjs uses proper-lockfile with update < stale/2 (the live-holder heartbeat
 *      invariant) and stale >= 30000, where stale comes from the dependency-free build-lock-target.mjs;
 *   5. root "test" invokes the full-suite runner and bin/bootstrap-runner.js genuinely requires
 *      packages/utils/dist/index.js (so building utils is not moot).
 *
 * This is the permanent regression guard wired into validate.commands. The heavier behavioral proofs
 * live in the repro-first REDs (red-fb7b-pretest-builds-utils.mjs, red-1734-lock-liveness.mjs,
 * red-1734-content-binding.mjs).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(start: string): string {
  let dir = start;
  while (!existsSync(join(dir, 'proof-or-stop.config.json')) && !existsSync(join(dir, 'proof-or-stop.config.json')) && dir !== dirname(dir)) {
    dir = dirname(dir);
  }
  return dir;
}

const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
assert.ok(existsSync(join(repoRoot, 'proof-or-stop.config.json')) || existsSync(join(repoRoot, 'lattice.config.json')), 'could not locate repo root (proof-or-stop.config.json; legacy lattice.config.json is read as fallback)');

const read = (rel: string): string => {
  const abs = join(repoRoot, rel);
  assert.ok(existsSync(abs), `expected ${rel} to exist`);
  return readFileSync(abs, 'utf8');
};

const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
const scripts = pkg.scripts ?? {};

// 1) A root "pretest" hook exists and runs the ensure-dist bootstrap.
const pretest = scripts.pretest;
assert.ok(
  typeof pretest === 'string' && pretest.trim().length > 0,
  'root package.json has no "pretest" script — nothing auto-builds packages/utils before `npm test`, ' +
    'so a worktree without packages/utils/dist runs the full suite with utils absent and bin/proof-or-stop.js sub-tests die at bootstrap-runner',
);
assert.ok(/ensure-dist(?:\.mjs)?(?![\w:-])/.test(pretest), `pretest must run the ensure-dist bootstrap: ${pretest}`);

// 2) ensure-dist ORCHESTRATES main-then-utils via the two build-*-with-binding scripts, and is no
//    longer existence-based (an existsSync-gated bootstrap could not detect a stale/tampered dist).
const ensureSrc = read('scripts/ensure-dist.mjs');
const mainScriptIdx = ensureSrc.indexOf('build-main-with-binding.mjs');
const utilsScriptIdx = ensureSrc.indexOf('build-utils-with-binding.mjs');
assert.ok(
  mainScriptIdx >= 0 && utilsScriptIdx >= 0 && mainScriptIdx < utilsScriptIdx,
  'ensure-dist must run build-main-with-binding.mjs BEFORE build-utils-with-binding.mjs ' +
    '(utils tsc links against packages/main/dist, so main must build first)',
);
assert.ok(
  !/existsSync/.test(ensureSrc),
  'ensure-dist must be content-bound (delegate to the verifyBuildBinding-gated build scripts), NOT existence-based — ' +
    'an existsSync(dist/index.js) skip reuses a stale, partial, or orphaned dist',
);

// 3) Each build-*-with-binding script skips on the sha256 content binding (NOT existsSync) and takes
//    the withBuildLock mutex around its rm+tsc+write critical section.
const mainBuild = read('scripts/build-main-with-binding.mjs');
assert.ok(/verifyBuildBinding\s*\(/.test(mainBuild), 'build-main-with-binding.mjs must skip via verifyBuildBinding (content-bound)');
assert.ok(/withBuildLock\s*\(/.test(mainBuild), 'build-main-with-binding.mjs must take the withBuildLock mutex around rm+tsc+write');
assert.ok(!/existsSync/.test(mainBuild), 'build-main-with-binding.mjs must NOT use existsSync as its skip gate (content-bound, not existence)');

const utilsBuild = read('scripts/build-utils-with-binding.mjs');
assert.ok(/verifyUtilsBuildBinding\s*\(/.test(utilsBuild), 'build-utils-with-binding.mjs must skip via verifyUtilsBuildBinding (content-bound)');
assert.ok(/withBuildLock\s*\(/.test(utilsBuild), 'build-utils-with-binding.mjs must take the withBuildLock mutex around rm+tsc+write');
assert.ok(!/existsSync/.test(utilsBuild), 'build-utils-with-binding.mjs must NOT use existsSync as its skip gate');

// The packages/utils build script must invoke the content-bound builder, not a bare `tsc`.
const utilsPkg = JSON.parse(read('packages/utils/package.json')) as { scripts?: Record<string, string> };
assert.ok(
  /build-utils-with-binding\.mjs/.test(utilsPkg.scripts?.build ?? ''),
  'packages/utils build script must run build-utils-with-binding.mjs (content-bound + locked), not a bare `tsc`',
);

// 4) build-lock.mjs uses proper-lockfile with the live-holder heartbeat invariant update < stale/2.
//    The stale THRESHOLD lives in the dependency-free build-lock-target.mjs (single source of truth,
//    shared with bin/bootstrap-runner.js's freshness gate); build-lock.mjs folds it into
//    BUILD_LOCK_OPTIONS.stale and configures the update heartbeat.
const lockSrc = read('scripts/build-lock.mjs');
assert.ok(/proper-lockfile/.test(lockSrc), 'build-lock.mjs must use proper-lockfile (cross-platform mkdir mutex, no flock/native module)');
const staleTargetSrc = read('scripts/build-lock-target.mjs');
assert.ok(
  !/proper-lockfile/.test(staleTargetSrc),
  'build-lock-target.mjs must stay dependency-free (no proper-lockfile) so bin/bootstrap-runner.js can import it in a fresh checkout',
);
const staleMatch = staleTargetSrc.match(/BUILD_LOCK_STALE_MS\s*=\s*(\d+)/);
const updateMatch = lockSrc.match(/update:\s*(\d+)/);
assert.ok(staleMatch && updateMatch, 'build-lock-target.mjs must define numeric BUILD_LOCK_STALE_MS and build-lock.mjs a numeric update (heartbeat) interval');
const stale = Number(staleMatch![1]);
const update = Number(updateMatch![1]);
assert.ok(stale >= 30000, `build-lock.mjs stale must be >= 30000ms so a crashed holder is reclaimed, not stalled: got ${stale}`);
assert.ok(
  update > 0 && update < stale / 2,
  `build-lock.mjs update (heartbeat) must be > 0 and < stale/2 so a LIVE holder refreshes before stale expiry ` +
    `(the B-fb7b live-holder age-steal fix): got update=${update}, stale=${stale}`,
);

// 5) The consumer link: root "test" invokes the full-suite runner (which uses bin/proof-or-stop.js), and
//    bin/bootstrap-runner.js genuinely requires packages/utils/dist/index.js.
assert.ok(
  /full-suite-runner/.test(scripts.test ?? ''),
  'root "test" must invoke the full-suite runner (which uses bin/proof-or-stop.js needing packages/utils/dist)',
);
const bootstrap = read('bin/bootstrap-runner.js');
assert.ok(
  bootstrap.includes("'utils', 'dist', 'index.js'") || bootstrap.includes('packages/utils/dist/index.js'),
  'bin/bootstrap-runner.js must require packages/utils/dist/index.js (else building utils would be pointless)',
);

console.log('PASS test-suite-utils-autobuild-smoke: pretest content-bound-builds packages/main then packages/utils under a cross-platform mutex');
