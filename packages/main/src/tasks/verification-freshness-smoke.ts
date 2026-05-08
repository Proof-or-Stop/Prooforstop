#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkEvidenceFreshnessForGit, currentMaterialHash, isStoryMetadataPath } from '../core/evidence-freshness.js';
import { buildVerificationCoverage } from '../core/verification.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { createChecklistHandlers } from '../handlers/checklist.js';

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

{
  const root = mkdtempRoot();
  try {
    git(root, ['init']);
    write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
    const base = commit(root, 'base');
    const baseMaterialHash = currentMaterialHash(root);
    assert.ok(baseMaterialHash, 'base material hash should be available');
    write(root, 'packages/main/src/base.ts', 'export const base = false;\n');
    commit(root, 'material change');
    const head = git(root, ['rev-parse', 'HEAD']);

    const store = new StoryStore(root);
    const storyId = 'B-refresh';
    const story: StoryInfo = {
      storyId,
      name: 'refresh-stale-evidence',
      title: 'Refresh stale evidence',
      description: 'Smoke story for stale evidence refresh helper.',
      type: 'chore',
      phase: 'TEST',
      priority: 'medium',
      createdAt: '2026-05-03T00:00:00.000Z',
      startedAt: '2026-05-03T00:00:00.000Z',
      endedAt: null,
    };
    const checklist: ChecklistData = {
      items: [{
        id: 'CHK-001',
        title: 'Refresh stale evidence',
        context: 'Refresh stale evidence',
        status: 'done',
        startTime: null,
        endTime: null,
        verificationIntent: {
          happy: [{ desc: 'refresh stale evidence', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
        verificationEvidence: [{
          intentRef: 'CHK-001:happy:0',
          kind: 'logic_test',
          result: 'pass',
          note: 'old evidence before material change',
          headHash: base,
          materialHash: baseMaterialHash,
          command: 'npm test',
        }],
      }],
    };
    store.writeStory(storyId, story);
    store.writeChecklist(storyId, checklist);

    const before = buildVerificationCoverage(
      store.readChecklist(storyId),
      head,
      (headHash, evidence) => checkEvidenceFreshnessForGit(root, headHash, evidence?.materialHash).fresh,
    );
    assert.equal(before.entries[0]?.status, 'stale', 'material change should stale old evidence');

    const handlers = createChecklistHandlers({ store, root, scanRoot: root });
    const dryRun = handlers.verification_evidence_refresh_stale({ storyId, dryRun: true });
    assert.match(dryRun, /\[DRY-RUN\] Stale verification evidence/);
    assert.match(dryRun, /npm test/);

    const result = handlers.verification_evidence_refresh_stale({ storyId });
    assert.match(result, /Refreshed 1\/1 stale evidence/);
    const after = buildVerificationCoverage(
      store.readChecklist(storyId),
      head,
      (headHash, evidence) => checkEvidenceFreshnessForGit(root, headHash, evidence?.materialHash).fresh,
    );
    assert.equal(after.entries[0]?.status, 'covered', 'refresh helper should make stale evidence covered at current head');
    assert.equal(after.entries[0]?.evidence?.headHash, head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertChecklistUpdateEvidenceGetsMaterialHash(): void {
  const root = mkdtempRoot();
  try {
    git(root, ['init']);
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
    }, null, 2));
    write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
    commit(root, 'base');
    const store = new StoryStore(root);
    const storyId = 'B-evidence';
    const now = '2026-05-08T10:00:00.000Z';
    store.writeStory(storyId, {
      storyId,
      name: 'evidence-direct-update',
      title: 'Evidence direct update',
      description: 'Synthetic story for checklist_update evidence normalization.',
      type: 'chore',
      phase: 'DEV',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [{ phase: 'DEV', action: 'advance', timestamp: now }],
    });
    store.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Evidence item',
        context: 'Evidence item',
        status: 'pending',
        startTime: null,
        endTime: null,
        verificationIntent: {
          happy: [{ desc: 'direct evidence', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
      }],
    });
    const handlers = createChecklistHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    });
    handlers.checklist_update({
      storyId,
      itemId: 'CHK-001',
      verificationEvidence: [{
        intentRef: 'CHK-001:happy:0',
        kind: 'logic_test',
        result: 'pass',
        note: 'direct update evidence smoke',
      }],
    });
    const evidence = new StoryStore(root).readChecklist(storyId).items[0].verificationEvidence?.[0];
    assert.ok(evidence?.headHash, 'checklist_update evidence should capture headHash');
    assert.ok(evidence?.materialHash, 'checklist_update evidence should capture materialHash');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertChecklistUpdateEvidenceGetsMaterialHash();

console.log('✓ verification freshness smoke passed');
