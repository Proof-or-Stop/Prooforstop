#!/usr/bin/env node
// B-d6a0 red-evidence repro: whole-output-trim porcelain first-row corruption.
//
// Uses ONLY currently-exported entry points (no source changes needed), so the
// same command runs against the pre-fix baseline dist:
//   1. core/evidence-freshness.js captureEvidenceHashSnapshot — a first-row
//      modified-tracked volatile artifact (" M .lattice/activity.jsonl") must
//      NOT surface in the snapshot's material dirty files.
//   2. core/partial-done-recovery.js assertMainWorktreeClean — a tree whose
//      ONLY dirty row is that same first-row volatile artifact must not refuse.
//
// Exit 0 = both behave correctly (post-fix). Exit 1 = bug class present (RED).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// evidence dir -> .lattice/story/actives/B-d6a0/evidence, repo root is 4 up.
const repoRoot = resolve(here, '..', '..', '..', '..', '..');
const { captureEvidenceHashSnapshot } = await import(
  join(repoRoot, 'packages/main/dist/core/evidence-freshness.js')
);
const { assertMainWorktreeClean } = await import(
  join(repoRoot, 'packages/main/dist/core/partial-done-recovery.js')
);

function git(cwd, args) {
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'b-d6a0-porcelain-repro-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'repro@example.com']);
  git(root, ['config', 'user.name', 'repro']);
  mkdirSync(join(root, '.lattice'), { recursive: true });
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, '.lattice/activity.jsonl'), '{"seed":true}\n');
  writeFileSync(join(root, 'notes/keep.txt'), 'original\n');
  git(root, ['add', '-A']);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed']);
  return root;
}

const failures = [];

// Guard: the fixture's FIRST porcelain row must be the modified-tracked
// volatile artifact, otherwise every assertion below is vacuous.
function firstRowGuard(root) {
  const raw = execFileSync(
    'git', ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: root, encoding: 'utf-8' },
  );
  const rows = raw.split('\n').filter(Boolean);
  if (!/^ M \.lattice\/activity\.jsonl$/.test(rows[0] ?? '')) {
    console.error(`fixture guard failed: first row is ${JSON.stringify(rows[0])}`);
    process.exit(2);
  }
}

// Scenario 1: evidence snapshot material dirty files.
{
  const root = makeFixture();
  writeFileSync(join(root, '.lattice/activity.jsonl'), '{"seed":false}\n');
  writeFileSync(join(root, 'notes/keep.txt'), 'edited\n');
  firstRowGuard(root);
  const snapshot = captureEvidenceHashSnapshot({ gitCwd: root });
  const files = snapshot.materialDirtyFiles ?? [];
  if (files.some((f) => f === 'lattice/activity.jsonl')) {
    failures.push(`scenario1: corrupted first-row path in materialDirty: ${JSON.stringify(files)}`);
  }
  if (!files.includes('notes/keep.txt')) {
    failures.push(`scenario1: exact material path missing: ${JSON.stringify(files)}`);
  }
  rmSync(root, { recursive: true, force: true });
}

// Scenario 2: done_recover main-clean guard with volatile-only first-row dirt.
{
  const root = makeFixture();
  writeFileSync(join(root, '.lattice/activity.jsonl'), '{"seed":false}\n');
  firstRowGuard(root);
  try {
    assertMainWorktreeClean(root);
  } catch (err) {
    failures.push(`scenario2: volatile-only dirty tree refused: ${String(err?.message).split('\n')[0]}`);
  }
  rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('RED: porcelain first-row corruption present:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('GREEN: first-row modified-tracked rows classify correctly in both consumers');
