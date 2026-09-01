#!/usr/bin/env node
/**
 * RED (repro-first) for B-fb7b + B-1734 — root `npm test` must self-bootstrap packages/main then
 * packages/utils before the full suite, and it must do so CONTENT-BOUND: skip when the dist matches
 * source (verifyBuildBinding), rebuild when a source change (or an absent dist) makes it stale.
 *
 * Baseline (no root "pretest"): FAILS the structural assertion — nothing auto-builds packages/utils,
 * so a worktree without packages/utils/dist runs the full suite with utils absent and its
 * bin/proofOrStop.js sub-tests die in bootstrap-runner.js ("Missing build artifacts: .../utils/dist/index.js").
 *
 * Baseline (a pretest that always `rm -rf dist` + rebuilds): FAILS the idempotency assertion — a
 * repeated `npm test` re-destroys a current dist, which can race a concurrent invocation's suite.
 *
 * After the fix (content-bound `node scripts/ensure-dist.mjs`): PASSES both — a current dist is left
 * byte-for-byte untouched (verifyBuildBinding skip), an absent dist is rebuilt.
 *
 * This runs the real `npm run pretest`, mutates the shared dist, and is therefore registered OUT of
 * validate.commands (it runs standalone, never in the concurrent suite).
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
while (!existsSync(join(repoRoot, 'proof-or-stop.config.json')) && !existsSync(join(repoRoot, 'proof-or-stop.config.json')) && repoRoot !== dirname(repoRoot)) {
  repoRoot = dirname(repoRoot);
}
assert.ok(existsSync(join(repoRoot, 'proof-or-stop.config.json')) || existsSync(join(repoRoot, 'proof-or-stop.config.json')), 'could not locate repo root (proof-or-stop.config.json)');

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};

// 1) Structural: a root "pretest" exists (the npm lifecycle hook before `npm test`).
const pretest = scripts.pretest;
assert.ok(
  typeof pretest === 'string' && pretest.trim().length > 0,
  'RED: root package.json has no "pretest" script — nothing auto-builds packages/utils before `npm test`, ' +
    'so a worktree without packages/utils/dist runs the full suite with utils absent and bin/proofOrStop.js sub-tests die at bootstrap-runner.',
);
assert.ok(/ensure-dist(?:\.mjs)?(?![\w:-])/.test(pretest), `RED: pretest must run the ensure-dist bootstrap: ${pretest}`);

// 2) ensure-dist must be CONTENT-BOUND (delegate to the verifyBuildBinding-gated build scripts,
// main before utils), not existence-based — an existsSync skip cannot detect a stale/tampered dist.
const ensureSrc = readFileSync(join(repoRoot, 'scripts', 'ensure-dist.mjs'), 'utf8');
const mainIdx = ensureSrc.indexOf('build-main-with-binding.mjs');
const utilsIdx = ensureSrc.indexOf('build-utils-with-binding.mjs');
assert.ok(
  mainIdx >= 0 && utilsIdx >= 0 && mainIdx < utilsIdx,
  'RED: ensure-dist must run build-main-with-binding.mjs before build-utils-with-binding.mjs (utils tsc links against main dist)',
);
assert.ok(
  !/existsSync/.test(ensureSrc),
  'RED: ensure-dist must be content-bound (no existsSync skip — a stale/partial/orphaned dist must trigger a rebuild)',
);

// 3) Invariant links — establish WHY utils must be built (so this guard is not a moot string check).
const bootstrap = readFileSync(join(repoRoot, 'bin', 'bootstrap-runner.js'), 'utf8');
assert.ok(
  bootstrap.includes("'utils', 'dist', 'index.js'") || bootstrap.includes('packages/utils/dist/index.js'),
  'invariant: bin/bootstrap-runner.js must require packages/utils/dist/index.js (else building utils would be pointless)',
);
assert.ok(
  /full-suite-runner/.test(scripts.test || ''),
  'invariant: root "test" must invoke the full-suite runner (which spawns bin/proofOrStop.js needing utils/dist)',
);

const utilsIndex = join(repoRoot, 'packages', 'utils', 'dist', 'index.js');
const mainIndex = join(repoRoot, 'packages', 'main', 'dist', 'index.js');
const runPretest = () => execFileSync('npm', ['run', 'pretest'], { cwd: repoRoot, stdio: 'pipe', timeout: 290000 });

// 4a) Behavioral — CONTENT-BOUND SKIP: the first pretest brings both dist trees current; the second,
// with no source change, must verifyBuildBinding and skip — leaving packages/utils/dist/index.js
// byte-for-byte in place (unchanged mtime). An always-`rm -rf dist` pretest bumps the mtime and FAILS.
runPretest();
assert.ok(existsSync(utilsIndex), 'behavioral: after `npm run pretest`, packages/utils/dist/index.js must exist');
const freshMtime = statSync(utilsIndex).mtimeMs;
runPretest();
assert.equal(
  statSync(utilsIndex).mtimeMs,
  freshMtime,
  'behavioral: a SECOND pretest with no source change must content-skip (verifyBuildBinding) and NOT rebuild packages/utils/dist',
);

// 4b) Behavioral — SELF-BOOTSTRAP: a MISSING packages/utils/dist must be rebuilt. Destructive step
// runs last; pretest restores dist. Freshness (mtime >= run start) rejects a trivially-present
// artifact and proves the rebuild actually happened this run.
rmSync(join(repoRoot, 'packages', 'utils', 'dist'), { recursive: true, force: true });
const startedAtMs = Date.now();
runPretest();
assert.ok(existsSync(utilsIndex), 'behavioral: after removing packages/utils/dist, `npm run pretest` must rebuild it (self-bootstrap)');
assert.ok(existsSync(mainIndex), 'behavioral: packages/main/dist/index.js must also exist (main build not regressed)');
assert.ok(
  statSync(utilsIndex).mtimeMs >= startedAtMs - 2000,
  'behavioral: the rebuilt packages/utils/dist/index.js must be FRESHLY written by this pretest run (not a stale pre-existing artifact)',
);

console.log('PASS red-fb7b-pretest-builds-utils: pretest content-skips a current dist AND self-bootstraps a missing packages/utils');
