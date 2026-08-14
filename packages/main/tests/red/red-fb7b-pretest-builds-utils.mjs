#!/usr/bin/env node
/**
 * RED (repro-first) for B-fb7b — root npm test must build packages/utils before the full suite.
 *
 * Baseline (no root "pretest"): this test FAILS at the first assertion, proving the gap —
 * nothing auto-builds packages/utils before `npm test`, so a worktree without
 * packages/utils/dist runs the full suite with utils absent and its bin/lattice.js
 * sub-tests die in bootstrap-runner.js ("Missing build artifacts: .../packages/utils/dist/index.js").
 *
 * After the fix (root "pretest" builds packages/main then packages/utils): this test PASSES.
 *
 * Non-destructive: it never removes the shared dist. The behavioral step runs the real
 * `npm run pretest`, which is an idempotent rebuild, and asserts packages/utils/dist/index.js exists.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
while (!existsSync(join(repoRoot, 'lattice.config.json')) && repoRoot !== dirname(repoRoot)) {
  repoRoot = dirname(repoRoot);
}
assert.ok(existsSync(join(repoRoot, 'lattice.config.json')), 'could not locate repo root (lattice.config.json)');

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};

// 1) Structural: a root "pretest" exists (the npm lifecycle hook that fires before `npm test`).
const pretest = scripts.pretest;
assert.ok(
  typeof pretest === 'string' && pretest.trim().length > 0,
  'RED: root package.json has no "pretest" script — nothing auto-builds packages/utils before `npm test`, ' +
    'so a worktree without packages/utils/dist runs the full suite with utils absent and bin/lattice.js sub-tests die at bootstrap-runner.',
);

// 2) The pretest must actually run a real build for BOTH packages, packages/main BEFORE packages/utils.
const buildsMain = /--prefix\s+packages\/main\s+run\s+build/.test(pretest) || /\bnpm\s+run\s+build\b/.test(pretest);
const buildsUtils = /--prefix\s+packages\/utils\s+run\s+build/.test(pretest) || /\bnpm\s+run\s+build\b/.test(pretest);
assert.ok(buildsUtils, `RED: pretest does not build packages/utils: ${pretest}`);
assert.ok(buildsMain, `RED: pretest does not build packages/main: ${pretest}`);
const mainIdx = pretest.indexOf('packages/main');
const utilsIdx = pretest.indexOf('packages/utils');
if (mainIdx >= 0 && utilsIdx >= 0) {
  assert.ok(mainIdx < utilsIdx, `RED: pretest must build packages/main before packages/utils (utils tooling assumes main dist): ${pretest}`);
}

// 3) Invariant links — establish WHY utils must be built (so this guard is not a moot string check).
const bootstrap = readFileSync(join(repoRoot, 'bin', 'bootstrap-runner.js'), 'utf8');
assert.ok(
  bootstrap.includes("'utils', 'dist', 'index.js'") || bootstrap.includes('packages/utils/dist/index.js'),
  'invariant: bin/bootstrap-runner.js must require packages/utils/dist/index.js (else building utils would be pointless)',
);
assert.ok(
  /full-suite-runner/.test(scripts.test || ''),
  'invariant: root "test" must invoke the full-suite runner (which spawns bin/lattice.js needing utils/dist)',
);

// 4) Behavioral: the real `npm run pretest` executes and produces packages/utils/dist. Un-gameable.
execFileSync('npm', ['run', 'pretest'], { cwd: repoRoot, stdio: 'pipe', timeout: 290000 });
assert.ok(
  existsSync(join(repoRoot, 'packages', 'utils', 'dist', 'index.js')),
  'behavioral: after `npm run pretest`, packages/utils/dist/index.js must exist',
);

console.log('PASS red-fb7b-pretest-builds-utils: root npm test self-bootstraps packages/utils via pretest');
