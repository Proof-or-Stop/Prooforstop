#!/usr/bin/env node
/**
 * RED (repro-first) for B-fb7b — root `npm test` must self-bootstrap packages/utils before the
 * full suite, and it must do so IDEMPOTENTLY (skip the rebuild when dist is already current).
 *
 * Baseline (no root "pretest"): FAILS at the structural assertion, proving the original gap —
 * nothing auto-builds packages/utils before `npm test`, so a worktree without packages/utils/dist
 * runs the full suite with utils absent and its bin/lattice.js sub-tests die in bootstrap-runner.js
 * ("Missing build artifacts: .../packages/utils/dist/index.js").
 *
 * Baseline (pretest that always `rm -rf dist` + rebuilds — the pre-Codex-MAJOR-2 form): FAILS the
 * idempotency assertion, proving the reader-writer hazard — a repeated `npm test` re-destroys a
 * current dist, which can race a concurrent invocation's full suite still spawning tasks out of dist.
 *
 * After the fix (idempotent `--ensure` pretest): PASSES both — a missing dist is built, a current
 * dist is left untouched.
 *
 * The behavioral steps run the real `npm run pretest`. This test manipulates the shared dist and is
 * therefore registered OUT of validate.commands (it runs standalone, never in the concurrent suite).
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, rmSync } from 'node:fs';
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

// 2) The pretest must run the IDEMPOTENT (`--ensure`) build for BOTH packages, main BEFORE utils.
// `--ensure` is what skips the rebuild on a current dist (the Codex MAJOR-2 fix); a plain
// always-rebuild form (`--prefix ... run build`, or the scripts without `--ensure`) must NOT satisfy
// this, so the assertion pins the idempotent invocation of each build script, not merely "a build".
const buildsMainEnsure = /build-main-with-binding(?:\.mjs)?\s+--ensure(?![\w:-])/.test(pretest);
const buildsUtilsEnsure = /build-utils-with-lock(?:\.mjs)?\s+--ensure(?![\w:-])/.test(pretest);
assert.ok(buildsUtilsEnsure, `RED: pretest does not idempotently (--ensure) build packages/utils: ${pretest}`);
assert.ok(buildsMainEnsure, `RED: pretest does not idempotently (--ensure) build packages/main: ${pretest}`);
const mainIdx = pretest.indexOf('build-main-with-binding');
const utilsIdx = pretest.indexOf('build-utils-with-lock');
assert.ok(
  mainIdx >= 0 && utilsIdx >= 0 && mainIdx < utilsIdx,
  `RED: pretest must build packages/main before packages/utils (utils tsc links against main dist): ${pretest}`,
);

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

const utilsIndex = join(repoRoot, 'packages', 'utils', 'dist', 'index.js');
const mainIndex = join(repoRoot, 'packages', 'main', 'dist', 'index.js');
const runPretest = () => execFileSync('npm', ['run', 'pretest'], { cwd: repoRoot, stdio: 'pipe', timeout: 290000 });

// 4a) Behavioral — IDEMPOTENCY (Codex MAJOR-2): a pretest over a current dist must NOT rebuild it.
// First pretest establishes a current dist; the second must leave packages/utils/dist/index.js
// byte-for-byte in place (unchanged mtime). A pre-Codex-MAJOR-2 always-`rm -rf dist` pretest bumps
// the mtime here and FAILS — that is exactly the repeated-rebuild-while-read hazard being closed.
runPretest();
assert.ok(existsSync(utilsIndex), 'behavioral: after `npm run pretest`, packages/utils/dist/index.js must exist');
const freshMtime = statSync(utilsIndex).mtimeMs;
runPretest();
assert.equal(
  statSync(utilsIndex).mtimeMs,
  freshMtime,
  'behavioral: a SECOND pretest over a current packages/utils/dist must NOT rebuild it (idempotent skip-if-fresh; Codex MAJOR-2)',
);

// 4b) Behavioral — SELF-BOOTSTRAP (original goal): a MISSING packages/utils/dist must be rebuilt.
// Destructive step runs last; pretest restores dist. Freshness (mtime >= run start) rejects a
// trivially-present artifact and proves the rebuild actually happened this run (F-002/F-003).
rmSync(join(repoRoot, 'packages', 'utils', 'dist'), { recursive: true, force: true });
const startedAtMs = Date.now();
runPretest();
assert.ok(existsSync(utilsIndex), 'behavioral: after removing packages/utils/dist, `npm run pretest` must rebuild it (self-bootstrap)');
assert.ok(existsSync(mainIndex), 'behavioral: packages/main/dist/index.js must also exist (main build not regressed)');
assert.ok(
  statSync(utilsIndex).mtimeMs >= startedAtMs - 2000,
  'behavioral: the rebuilt packages/utils/dist/index.js must be FRESHLY written by this pretest run (not a stale pre-existing artifact)',
);

console.log('PASS red-fb7b-pretest-builds-utils: pretest self-bootstraps packages/utils AND idempotently skips a current dist');
