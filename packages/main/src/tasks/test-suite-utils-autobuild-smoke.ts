#!/usr/bin/env node
/**
 * B-fb7b guard — root `npm test` must self-bootstrap packages/utils before the full suite.
 *
 * Fast, structural, no build. It asserts the invariant chain that keeps `npm test`
 * (run by done_required) from dying on a missing packages/utils/dist:
 *   1. root package.json "pretest" runs a real build for packages/main THEN packages/utils
 *      (utils tooling assumes packages/main/dist exists, so main must build first);
 *   2. root package.json "test" invokes the full-suite runner (which spawns bin/lattice.js);
 *   3. bin/bootstrap-runner.js requires packages/utils/dist/index.js — so utils MUST be built,
 *      otherwise the full-suite sub-tests that spawn bin/lattice.js abort at bootstrap.
 *
 * This is the permanent regression guard wired into validate.commands. The heavier
 * behavioral proof (actually running `npm run pretest`) lives in the repro-first RED
 * at packages/main/tests/red/red-fb7b-pretest-builds-utils.mjs.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(start: string): string {
  let dir = start;
  while (!existsSync(join(dir, 'lattice.config.json')) && dir !== dirname(dir)) {
    dir = dirname(dir);
  }
  return dir;
}

const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
assert.ok(existsSync(join(repoRoot, 'lattice.config.json')), 'could not locate repo root (lattice.config.json)');

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
const scripts = pkg.scripts ?? {};

// 1) A root "pretest" hook exists (fires automatically before `npm test` via the npm lifecycle).
const pretest = scripts.pretest;
assert.ok(
  typeof pretest === 'string' && pretest.trim().length > 0,
  'root package.json has no "pretest" script — nothing auto-builds packages/utils before `npm test`, ' +
    'so a worktree without packages/utils/dist runs the full suite with utils absent and bin/lattice.js sub-tests die at bootstrap-runner',
);

// 2) The pretest runs a real build for BOTH packages, packages/main BEFORE packages/utils.
// The fallback matches ONLY the exact root `build` script (which builds both packages), not a
// namespaced sibling like `build:lab` / `build-x` — the negative lookahead rejects a trailing
// word char, colon, or hyphen after `build` so partial builds cannot pass the guard (F-003/F-004).
const runsExactRootBuild = /\bnpm\s+run\s+build(?![\w:-])/.test(pretest);
const buildsMain = /--prefix\s+packages\/main\s+run\s+build/.test(pretest) || runsExactRootBuild;
const buildsUtils = /--prefix\s+packages\/utils\s+run\s+build/.test(pretest) || runsExactRootBuild;
assert.ok(buildsUtils, `pretest does not build packages/utils: ${pretest}`);
assert.ok(buildsMain, `pretest does not build packages/main: ${pretest}`);
const mainIdx = pretest.indexOf('packages/main');
const utilsIdx = pretest.indexOf('packages/utils');
if (mainIdx >= 0 && utilsIdx >= 0) {
  assert.ok(mainIdx < utilsIdx, `pretest must build packages/main before packages/utils: ${pretest}`);
}

// 3) The consumer link: root "test" invokes the full-suite runner (which spawns bin/lattice.js).
assert.ok(
  /full-suite-runner/.test(scripts.test ?? ''),
  'root "test" must invoke the full-suite runner (which spawns bin/lattice.js needing packages/utils/dist)',
);

// 4) The invariant link: bootstrap-runner genuinely requires packages/utils/dist/index.js.
const bootstrap = readFileSync(join(repoRoot, 'bin', 'bootstrap-runner.js'), 'utf8');
assert.ok(
  bootstrap.includes("'utils', 'dist', 'index.js'") || bootstrap.includes('packages/utils/dist/index.js'),
  'bin/bootstrap-runner.js must require packages/utils/dist/index.js (else building utils would be pointless)',
);

console.log('PASS test-suite-utils-autobuild-smoke: root npm test self-bootstraps packages/utils via pretest');
