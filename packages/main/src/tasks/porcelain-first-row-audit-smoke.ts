#!/usr/bin/env node

/**
 * B-d6a0: porcelain first-row regression smoke.
 *
 * Locks out the B-b264 whole-output-trim bug class: a helper that .trim()s the
 * FULL `git status --porcelain` output strips the first row's leading status
 * space (" M path" -> "M path"), shifting the fixed-width path offset so the
 * first modified-tracked row's path loses its first character
 * (".lattice/x" -> "lattice/x") and prefix-based material/volatile
 * classification misfires. Untracked "??" rows never start with a space, so
 * untracked-only fixtures cannot catch the class — every scenario here stages
 * a modified-TRACKED first row and asserts its shape before asserting
 * classification (a vacuous fixture is a hard failure, not a silent pass).
 *
 * Covered consumers (fixed in B-d6a0):
 *   - core/evidence-freshness.ts   captureEvidenceHashSnapshot materialDirtyFiles
 *   - handlers/cross-host-review.ts assertMaterialCleanForReview preflight
 *   - handlers/story-query.ts      gitPorcelainPaths (story_sync_main preflight)
 *   - core/partial-done-recovery.ts assertMainWorktreeClean (done_recover guard)
 *   - handlers/session.ts          readGitStatus brief rows
 *
 * Exit code: 0 on all-assertions-pass, non-zero on any failure.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { captureEvidenceHashSnapshot } from '../core/evidence-freshness.js';
import { assertMainWorktreeClean } from '../core/partial-done-recovery.js';
import { isVolatileRuntimeArtifactPath } from '../core/runtime-artifact-registry.js';
import { assertMaterialCleanForReview } from '../handlers/cross-host-review.js';
import { readGitStatus } from '../handlers/session.js';
import { gitPorcelainPaths } from '../handlers/story-query.js';

// `.lattice/activity.jsonl` is an exact-match VOLATILE runtime artifact in the
// runtime-artifact registry, and sorts before `notes/` in porcelain output, so
// it deterministically lands on the FIRST row.
const VOLATILE_PATH = '.lattice/activity.jsonl';
const MATERIAL_PATH = 'notes/keep.txt';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'porcelain-first-row-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'smoke@example.com']);
  git(root, ['config', 'user.name', 'smoke']);
  write(root, VOLATILE_PATH, '{"seed":true}\n');
  write(root, MATERIAL_PATH, 'original\n');
  git(root, ['add', '-A']);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed tracked volatile + material files']);
  return root;
}

function porcelainRows(root: string): string[] {
  return git(root, ['status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

/**
 * Fixture-shape guard: the FIRST porcelain row must be the modified-tracked
 * row this smoke exists to protect. Without this, a git-ordering change would
 * turn every assertion below vacuous.
 */
function assertFirstRowModifiedTracked(root: string, expectedPath: string): void {
  const rows = porcelainRows(root);
  assert.equal(
    rows[0],
    ` M ${expectedPath}`,
    `fixture guard: first porcelain row must be " M ${expectedPath}", got ${JSON.stringify(rows)}`,
  );
}

function withFixture(name: string, fn: (root: string) => void): void {
  const root = makeFixture();
  try {
    fn(root);
    console.log(`✓ ${name}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── CHK-001: evidence-freshness captureEvidenceHashSnapshot ────────────────

withFixture('evidence-freshness: first-row volatile row excluded, material path exact', (root) => {
  write(root, VOLATILE_PATH, '{"seed":false}\n');
  write(root, MATERIAL_PATH, 'edited\n');
  assertFirstRowModifiedTracked(root, VOLATILE_PATH);
  const snapshot = captureEvidenceHashSnapshot({ gitCwd: root });
  assert.deepEqual(
    snapshot.materialDirtyFiles,
    [MATERIAL_PATH],
    `materialDirtyFiles must be exactly [${MATERIAL_PATH}] (no corrupted "lattice/..." entry, volatile excluded)`,
  );
});

withFixture('evidence-freshness: clean tree yields empty materialDirtyFiles', (root) => {
  const snapshot = captureEvidenceHashSnapshot({ gitCwd: root });
  assert.deepEqual(snapshot.materialDirtyFiles, []);
});

// ── CHK-002: cross-host-review assertMaterialCleanForReview ────────────────

withFixture('cross-host-review: .lattice-only first-row dirt passes the preflight', (root) => {
  write(root, VOLATILE_PATH, '{"seed":false}\n');
  assertFirstRowModifiedTracked(root, VOLATILE_PATH);
  assertMaterialCleanForReview(root); // must not throw
});

withFixture('cross-host-review: clean tree passes the preflight', (root) => {
  assertMaterialCleanForReview(root); // must not throw
});

withFixture('cross-host-review: material row still refuses with the exact path', (root) => {
  write(root, VOLATILE_PATH, '{"seed":false}\n');
  write(root, MATERIAL_PATH, 'edited\n');
  assertFirstRowModifiedTracked(root, VOLATILE_PATH);
  assert.throws(
    () => assertMaterialCleanForReview(root),
    (err: Error) => {
      assert.match(err.message, /notes\/keep\.txt/, 'refusal must name the exact material path');
      assert.doesNotMatch(
        err.message,
        /[^.]lattice\/activity\.jsonl/,
        'refusal must not list a corrupted (dot-less) .lattice path as material',
      );
      return true;
    },
  );
});

// ── CHK-003: story-query gitPorcelainPaths (story_sync_main preflight) ──────

withFixture('story-query: first porcelain path keeps its leading dot', (root) => {
  write(root, VOLATILE_PATH, '{"seed":false}\n');
  write(root, MATERIAL_PATH, 'edited\n');
  assertFirstRowModifiedTracked(root, VOLATILE_PATH);
  const paths = gitPorcelainPaths(root);
  assert.equal(paths[0], VOLATILE_PATH, `first path must be ${VOLATILE_PATH}, got ${JSON.stringify(paths)}`);
  assert.ok(paths.includes(MATERIAL_PATH), `paths must include ${MATERIAL_PATH}: ${JSON.stringify(paths)}`);
});

withFixture('story-query: rename rows resolve to the new path', (root) => {
  git(root, ['mv', MATERIAL_PATH, 'notes/renamed.txt']);
  const paths = gitPorcelainPaths(root);
  assert.ok(paths.includes('notes/renamed.txt'), `rename target missing: ${JSON.stringify(paths)}`);
  assert.ok(
    paths.every((p) => !p.includes(' -> ')),
    `no raw arrow strings may leak into paths: ${JSON.stringify(paths)}`,
  );
});

withFixture('story-query: sync-main volatile filter drops the first-row volatile path', (root) => {
  write(root, VOLATILE_PATH, '{"seed":false}\n');
  write(root, MATERIAL_PATH, 'edited\n');
  assertFirstRowModifiedTracked(root, VOLATILE_PATH);
  // Mirrors the story_sync_main dirty preflight: corrupted "lattice/..." would
  // survive this filter and false-block the sync.
  const dirty = gitPorcelainPaths(root).filter((p) => !isVolatileRuntimeArtifactPath(p));
  assert.deepEqual(dirty, [MATERIAL_PATH]);
});

// ── CHK-004: partial-done-recovery assertMainWorktreeClean + session brief ──

withFixture('partial-done-recovery: volatile-only first-row dirt does not refuse', (root) => {
  write(root, VOLATILE_PATH, '{"seed":false}\n');
  assertFirstRowModifiedTracked(root, VOLATILE_PATH);
  assertMainWorktreeClean(root); // must not throw
});

withFixture('partial-done-recovery: material row still refuses with the exact path', (root) => {
  write(root, VOLATILE_PATH, '{"seed":false}\n');
  write(root, MATERIAL_PATH, 'edited\n');
  assertFirstRowModifiedTracked(root, VOLATILE_PATH);
  assert.throws(
    () => assertMainWorktreeClean(root),
    (err: Error) => {
      assert.match(err.message, / M notes\/keep\.txt/, 'refusal must list the exact material row');
      return true;
    },
  );
});

withFixture('session: brief rows keep the first row status column', (root) => {
  write(root, VOLATILE_PATH, '{"seed":false}\n');
  write(root, MATERIAL_PATH, 'edited\n');
  assertFirstRowModifiedTracked(root, VOLATILE_PATH);
  const { porcelain } = readGitStatus(root);
  assert.equal(porcelain[0], ` M ${VOLATILE_PATH}`, `brief row 0 corrupted: ${JSON.stringify(porcelain)}`);
});

console.log('porcelain-first-row-audit-smoke: ALL PASS');
