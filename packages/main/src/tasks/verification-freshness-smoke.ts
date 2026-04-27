#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkEvidenceFreshnessForGit, currentMaterialHash, isStoryMetadataPath } from '../core/evidence-freshness.js';
import { buildVerificationCoverage } from '../core/verification.js';
import type { ChecklistData } from '../core/types.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function commit(cwd: string, message: string): string {
  git(cwd, ['add', '.']);
  git(cwd, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function freshAfterChanging(path: string): boolean {
  const root = mkdtempRoot();
  try {
    git(root, ['init']);
    write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
    const base = commit(root, 'base');
    write(root, path, `changed ${path}\n`);
    commit(root, `change ${path}`);
    return checkEvidenceFreshnessForGit(root, base).fresh;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function materialFreshAfterChanging(path: string): boolean {
  const root = mkdtempRoot();
  try {
    git(root, ['init']);
    write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
    const base = commit(root, 'base');
    const materialHash = currentMaterialHash(root);
    assert.ok(materialHash, 'material hash should be available in git repo');
    write(root, path, `changed ${path}\n`);
    commit(root, `change ${path}`);
    return checkEvidenceFreshnessForGit(root, base, materialHash).fresh;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function coverageStatusWithMaterialHash(afterPath: string): string {
  const root = mkdtempRoot();
  try {
    git(root, ['init']);
    write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
    const base = commit(root, 'base');
    const materialHash = currentMaterialHash(root);
    assert.ok(materialHash, 'material hash should be available in git repo');
    write(root, afterPath, `changed ${afterPath}\n`);
    commit(root, `change ${afterPath}`);
    const checklist: ChecklistData = {
      items: [{
        id: 'CHK-001',
        title: 'Smoke item',
        context: 'Smoke item',
        status: 'done',
        startTime: null,
        endTime: null,
        verificationIntent: {
          happy: [{ desc: 'material hash freshness', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
        verificationEvidence: [{
          intentRef: 'CHK-001:happy:0',
          kind: 'logic_test',
          result: 'pass',
          note: 'material hash smoke',
          headHash: base,
          materialHash,
        }],
      }],
    };
    const report = buildVerificationCoverage(
      checklist,
      git(root, ['rev-parse', 'HEAD']),
      (headHash, evidence) => checkEvidenceFreshnessForGit(root, headHash, evidence?.materialHash).fresh,
    );
    return report.entries[0]?.status ?? 'missing';
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function mkdtempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'koala-freshness-'));
}

const metadataOnly = [
  '.koala/story/actives/B-smoke/checklist.json',
  'docs/story/actives/B-smoke/findings.json',
  'docs/koala/framework-audit/round.json',
];

const material = [
  '.koala/activity.jsonl',
  'packages/main/src/core/verification.ts',
  'packages/main/tests/fixtures/story.json',
  'packages/main/package.json',
  'package-lock.json',
  'koala.config.json',
  'docs/requirements/decisions/ADR-001.md',
];

for (const path of metadataOnly) {
  assert.equal(isStoryMetadataPath(path), true, `${path} should be workflow metadata`);
  assert.equal(freshAfterChanging(path), true, `${path} should keep evidence fresh`);
  assert.equal(materialFreshAfterChanging(path), true, `${path} should keep material-hash evidence fresh`);
  assert.equal(coverageStatusWithMaterialHash(path), 'covered', `${path} should keep coverage covered`);
}

for (const path of material) {
  assert.equal(isStoryMetadataPath(path), false, `${path} should be material`);
  assert.equal(freshAfterChanging(path), false, `${path} should make evidence stale`);
  assert.equal(materialFreshAfterChanging(path), false, `${path} should make material-hash evidence stale`);
  assert.equal(coverageStatusWithMaterialHash(path), 'stale', `${path} should make coverage stale`);
}

{
  const root = mkdtempRoot();
  try {
    git(root, ['init']);
    write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
    commit(root, 'base');
    const materialHash = currentMaterialHash(root);
    assert.ok(materialHash, 'material hash should be available in git repo');
    write(root, '.koala/story/actives/B-smoke/summary.json', '{}\n');
    commit(root, 'metadata only');
    assert.equal(
      checkEvidenceFreshnessForGit(root, 'missing-head-for-rebase-like-case', materialHash).fresh,
      true,
      'materialHash should keep evidence fresh even when legacy head diff is unavailable',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('✓ verification freshness smoke passed');
