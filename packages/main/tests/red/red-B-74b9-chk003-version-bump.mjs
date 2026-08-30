#!/usr/bin/env node
/**
 * RED (repro-first) for B-74b9 CHK-003.
 *
 * worktree-authority-smoke.ts's assertDoneRecoverRunsPostMergeBuildForRuntimeChanges builds a
 * synthetic mkdtemp root via buildDoneReadyStory with no package.json at the root. handlers/
 * done-recover.ts's done_recover now also calls core/version-bump.ts's bumpVersionOnDoneMerge,
 * which requires root/package.json (and the other version sync points) to exist -- it throws
 * "DONE post-merge version bump failed before any commit: ENOENT ... package.json" before the
 * test's stubbed doneMainBuildRunner is ever invoked. This wiring (the DONE-merge auto-bump
 * feature) postdates the fixture; production behavior is correct, the fixture's synthetic root
 * scaffold is stale.
 *
 * Before the fix: FAILS with the ENOENT package.json error from bumpVersionOnDoneMerge.
 * After the fix (root scaffold includes package.json + other version sync points): PASSES.
 *
 * Uses spawnSync with the child's stderr redirected to a real file descriptor (not a pipe) --
 * see red-B-74b9-chk001-acceptance-basis.mjs for why execFileSync's pipe-based capture is
 * unreliable for large synchronous crash dumps on macOS.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-B-74b9-chk003-version-bump.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
while (!existsSync(join(repoRoot, 'proof-or-stop.config.json')) && !existsSync(join(repoRoot, 'proof-or-stop.config.json')) && repoRoot !== dirname(repoRoot)) repoRoot = dirname(repoRoot);
assert.ok(existsSync(join(repoRoot, 'proof-or-stop.config.json')) || existsSync(join(repoRoot, 'proof-or-stop.config.json')), 'could not locate repo root (proof-or-stop.config.json)');

const target = join(repoRoot, 'packages/main/dist/tasks/worktree-authority-smoke.js');
const captureDir = mkdtempSync(join(tmpdir(), 'red-b74b9-chk003-'));
const stderrPath = join(captureDir, 'stderr.txt');

try {
  const fd = openSync(stderrPath, 'w');
  const result = spawnSync(process.execPath, [target], { cwd: repoRoot, stdio: ['ignore', 'ignore', fd] });
  closeSync(fd);

  const stderr = readFileSync(stderrPath, 'utf8');

  assert.notEqual(result.status, 0, 'RED: worktree-authority-smoke.js is expected to fail (still exhibits the pre-fix missing-package.json defect)');
  assert.match(stderr, /DONE post-merge version bump failed before any commit/, 'RED: expected the bumpVersionOnDoneMerge pre-commit failure message');
  assert.match(stderr, /ENOENT.*package\.json/, 'RED: expected an ENOENT package.json error');
  assert.match(stderr, /bumpVersionOnDoneMerge/, 'RED: expected the failure to originate from bumpVersionOnDoneMerge');

  console.log('RED red-B-74b9-chk003-version-bump: confirmed pre-fix defect (ENOENT package.json in bumpVersionOnDoneMerge before the stubbed build runner is reached)');
} finally {
  rmSync(captureDir, { recursive: true, force: true });
}
