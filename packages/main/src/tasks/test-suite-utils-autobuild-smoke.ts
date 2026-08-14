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

// 2) The pretest runs the IDEMPOTENT (`--ensure`) build for BOTH packages, main BEFORE utils.
// `--ensure` is the skip-if-current mode (Codex MAJOR-2): a repeated `npm test` over a current
// dist must NOT rm+rebuild it, or it races a concurrent invocation's suite still reading dist.
// The negative lookahead `(?![\w:-])` pins the exact `--ensure` flag (rejects `--ensure-x` etc.),
// so a plain always-rebuild pretest (`--prefix ... run build`, or the scripts without `--ensure`)
// cannot satisfy this guard.
const buildsMain = /build-main-with-binding(?:\.mjs)?\s+--ensure(?![\w:-])/.test(pretest);
const buildsUtils = /build-utils-with-lock(?:\.mjs)?\s+--ensure(?![\w:-])/.test(pretest);
assert.ok(buildsUtils, `pretest does not idempotently (--ensure) build packages/utils: ${pretest}`);
assert.ok(buildsMain, `pretest does not idempotently (--ensure) build packages/main: ${pretest}`);
const mainIdx = pretest.indexOf('build-main-with-binding');
const utilsIdx = pretest.indexOf('build-utils-with-lock');
assert.ok(
  mainIdx >= 0 && utilsIdx >= 0 && mainIdx < utilsIdx,
  `pretest must build packages/main before packages/utils (utils tsc links against main dist): ${pretest}`,
);
// The referenced idempotent build scripts must actually exist on disk (not a dangling name).
for (const rel of ['scripts/build-main-with-binding.mjs', 'scripts/build-utils-with-lock.mjs', 'scripts/build-lock.mjs']) {
  assert.ok(existsSync(join(repoRoot, rel)), `pretest references ${rel} but it does not exist`);
}
// build-lock.mjs must reclaim a stale lock by holder liveness, not purely by age — the age-only
// steal recreated the dist corruption the mutex prevents (Codex MAJOR-1).
const buildLock = readFileSync(join(repoRoot, 'scripts/build-lock.mjs'), 'utf8');
assert.ok(
  /process\.kill\(/.test(buildLock) && /nonce/.test(buildLock),
  'scripts/build-lock.mjs must reclaim a lock by holder PID-liveness and release by ownership nonce (Codex MAJOR-1), not by age alone',
);

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
