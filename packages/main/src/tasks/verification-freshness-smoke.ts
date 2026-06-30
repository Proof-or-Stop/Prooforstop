#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  captureEvidenceHashSnapshot,
  checkEvidenceFreshnessForGit,
  checkEvidenceHashSnapshotReuse,
  currentGitHead,
  currentMaterialHash,
  currentStoryFilesHash,
  isMaterialExcludedPath,
} from '../core/evidence-freshness.js';
import { buildVerificationCoverage } from '../core/verification.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { buildDoneChecklist } from '../core/done-oracle.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { EVIDENCE_STALE_MARKER, findStaleEvidence, renderEvidenceStaleHint } from '../core/evidence-stale-hint.js';
import { createSessionHandlers } from '../handlers/session.js';
import { decorateResult } from '../handlers/hints.js';
import {
  createRecoverEvidenceHandlers,
  RECOVER_EVIDENCE_ALLOWED_CATEGORIES,
} from '../handlers/recover-evidence.js';
import { createStoryAdvanceHandlers } from '../handlers/story-advance.js';
import { resetConfigCache } from '../core/config.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function commit(cwd: string, message: string): string {
  git(cwd, ['add', '.']);
  git(cwd, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', message]);
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
  return mkdtempSync(join(tmpdir(), 'lattice-freshness-'));
}

function assertEvidenceHashSnapshotReusePreflight(): void {
  const root = mkdtempRoot();
  try {
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
    }, null, 2));
    write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
    commit(root, 'base');
    git(root, ['checkout', '-B', 'story/B-snapshot']);
    write(root, 'packages/main/src/story.ts', 'export const story = 1;\n');
    commit(root, 'story file');

    const snapshot = captureEvidenceHashSnapshot({ gitCwd: root, metadataRoot: root, ref: 'HEAD' });
    assert.equal(snapshot.gitCwd, root, 'snapshot gitCwd should be the command git cwd');
    assert.equal(snapshot.metadataRoot, root, 'snapshot metadataRoot should be the command metadata root');
    assert.equal(snapshot.ref, 'HEAD', 'snapshot ref should be HEAD');
    assert.equal(snapshot.headHash, currentGitHead(root), 'snapshot headHash should bind current HEAD');
    assert.equal(snapshot.materialHash, currentMaterialHash(root, 'HEAD', root), 'snapshot materialHash should bind current material tree');
    assert.equal(snapshot.storyFilesHash, currentStoryFilesHash(root, 'HEAD', root), 'snapshot storyFilesHash should bind current story-owned files');
    assert.deepEqual(snapshot.materialDirtyFiles, [], 'clean fixture should have no material dirty files');

    const reusable = checkEvidenceHashSnapshotReuse(snapshot, { gitCwd: root, metadataRoot: root, ref: 'HEAD' });
    assert.equal(reusable.reusable, true, `clean unchanged snapshot should be reusable: ${reusable.reasons.join('; ')}`);
    assert.equal(reusable.materialDirty, false, 'clean unchanged snapshot should report no material dirt');
    console.log(`captureEvidenceHashSnapshot: reusable=${reusable.reusable}, materialDirty=${reusable.materialDirty}`);

    const store = new StoryStore(root);
    const storyId = 'B-snapshot';
    const now = '2026-06-30T00:00:00.000Z';
    store.writeStory(storyId, {
      storyId,
      name: 'snapshot-reuse-smoke',
      title: 'Snapshot reuse smoke',
      description: 'Smoke story proving DONE current binding can reuse a command-local snapshot.',
      type: 'chore',
      phase: 'TEST',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
    });
    store.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Snapshot reuse',
        context: 'Snapshot reuse',
        status: 'done',
        startTime: null,
        endTime: null,
      }],
    });
    const rows = buildDoneChecklist(storyId, store, root, {
      gitCwd: root,
      auditWriter: null,
      evidenceHashSnapshot: snapshot,
    });
    assert.ok(rows.some(row => row.id === 'review-escalation'), 'DONE checklist should evaluate review escalation with current binding');
    assert.ok(rows.some(row => row.id === 'review-assurance-floor'), 'DONE checklist should evaluate review assurance floor with current binding');
    assert.ok(snapshot.materialHash, 'DONE current binding materialHash should be available');
    assert.ok(snapshot.storyFilesHash, 'DONE current binding storyFilesHash should be available');
    console.log(`DONE currentBinding reused: materialHash=${snapshot.materialHash} storyFilesHash=${snapshot.storyFilesHash}`);

    write(root, 'packages/main/src/story.ts', 'export const story = 2;\n');
    const stale = checkEvidenceHashSnapshotReuse(snapshot, { gitCwd: root, metadataRoot: root, ref: 'HEAD' });
    assert.equal(stale.reusable, false, 'old snapshot must not be reusable after dirty material drift');
    assert.equal(stale.materialDirty, true, 'dirty material drift should be visible in the preflight');
    assert.ok(stale.materialDirtyFiles.length > 0, 'dirty material drift should name at least one material dirty file');
    console.log('stale supplied snapshot rejected after dirty material drift');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertEvidenceHashSnapshotReusePreflight();

const metadataOnly = [
  '.lattice/story/actives/B-smoke/checklist.json',
  'docs/story/actives/B-smoke/findings.json',
  'Docs/story/actives/B-smoke/checklist.json',
  'Docs/story/actives/B-smoke/process-events.jsonl',
  'Docs/story/actives/B-smoke/test-evidence.json',
  'docs/framework-audit/round.json',
];

const runtimeMetadata = [
  '.lattice/activity.jsonl',
  'docs/story/activity.jsonl',
];

const material = [
  'packages/main/src/core/verification.ts',
  'packages/main/tests/fixtures/story.json',
  'packages/main/package.json',
  'package-lock.json',
  'lattice.config.json',
  'docs/requirements/decisions/ADR-001.md',
];

for (const path of metadataOnly) {
  assert.equal(isMaterialExcludedPath(path), true, `${path} should be workflow metadata`);
  assert.equal(freshAfterChanging(path), true, `${path} should keep evidence fresh`);
  assert.equal(materialFreshAfterChanging(path), true, `${path} should keep material-hash evidence fresh`);
  assert.equal(coverageStatusWithMaterialHash(path), 'covered', `${path} should keep coverage covered`);
}

for (const path of runtimeMetadata) {
  assert.equal(isMaterialExcludedPath(path), true, `${path} should be runtime metadata`);
  assert.equal(freshAfterChanging(path), true, `${path} should keep evidence fresh`);
  assert.equal(materialFreshAfterChanging(path), true, `${path} should keep material-hash evidence fresh`);
  assert.equal(coverageStatusWithMaterialHash(path), 'covered', `${path} should keep coverage covered even when tracked`);
}

for (const path of material) {
  assert.equal(isMaterialExcludedPath(path), false, `${path} should be material`);
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
    write(root, '.lattice/story/actives/B-smoke/summary.json', '{}\n');
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

// ── refresh_stale preserves attestation/actorTrust/factProvenance ────────────
{
  const root = mkdtempRoot();
  try {
    git(root, ['init']);
    write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
    const base = commit(root, 'base');
    const baseMaterialHash = currentMaterialHash(root);
    assert.ok(baseMaterialHash, 'material hash should be available in git repo');
    write(root, 'packages/main/src/base.ts', 'export const base = false;\n');
    commit(root, 'material change');
    const head = git(root, ['rev-parse', 'HEAD']);

    const store = new StoryStore(root);
    const storyId = 'B-refresh-meta';
    const story: StoryInfo = {
      storyId,
      name: 'refresh-stale-preserves-metadata',
      title: 'Refresh stale evidence preserves metadata',
      description: 'Smoke story for metadata preservation during stale evidence refresh.',
      type: 'chore',
      phase: 'TEST',
      priority: 'medium',
      createdAt: '2026-05-22T00:00:00.000Z',
      startedAt: '2026-05-22T00:00:00.000Z',
      endedAt: null,
    };
    const checklist: ChecklistData = {
      items: [{
        id: 'CHK-001',
        title: 'Refresh stale evidence preserves metadata',
        context: 'Ensure attestation/actorTrust/factProvenance survive refresh',
        status: 'done',
        startTime: null,
        endTime: null,
        verificationIntent: {
          happy: [{ desc: 'refresh preserves metadata', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
        verificationEvidence: [{
          intentRef: 'CHK-001:happy:0',
          kind: 'logic_test',
          result: 'pass',
          note: 'old evidence with rich metadata',
          headHash: base,
          materialHash: baseMaterialHash,
          command: 'npm test',
          attestation: { kind: 'human', actor: 'smoke-test', result: 'pass' },
          actorTrust: { level: 'verified', source: 'ci' } as any,
          factProvenance: {
            kind: 'external_fact',
            sourceUrl: 'https://example.com/spec',
            digest: 'sha256:abc123',
            checkedClaims: ['claim A'],
            fetchedAt: '2026-05-20T00:00:00.000Z',
          },
        }],
      }],
    };
    store.writeStory(storyId, story);
    store.writeChecklist(storyId, checklist);

    const handlers = createChecklistHandlers({ store, root, scanRoot: root });
    const result = handlers.verification_evidence_refresh_stale({ storyId });
    assert.match(result, /Refreshed 1\/1 stale evidence/);

    const refreshed = store.readChecklist(storyId).items[0].verificationEvidence?.[0];
    assert.ok(refreshed, 'refreshed evidence must exist');
    assert.equal(refreshed.headHash, head, 'headHash must be updated to current HEAD');
    assert.ok(refreshed.attestation, 'attestation must be preserved after refresh');
    assert.equal(refreshed.attestation?.kind, 'human', 'attestation.kind must be preserved');
    assert.ok(refreshed.actorTrust, 'actorTrust must be preserved after refresh');
    assert.equal((refreshed.actorTrust as any)?.level, 'verified', 'actorTrust.level must be preserved');
    assert.ok(refreshed.factProvenance, 'factProvenance must be preserved after refresh');
    assert.equal(refreshed.factProvenance?.sourceUrl, 'https://example.com/spec', 'factProvenance.sourceUrl must be preserved');
    assert.equal(refreshed.factProvenance?.digest, 'sha256:abc123', 'factProvenance.digest must be preserved');
    console.log('✓ refresh_stale preserves attestation/actorTrust/factProvenance');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertChecklistUpdateEvidenceGetsMaterialHash(): void {
  const root = mkdtempRoot();
  try {
    git(root, ['init']);
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
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

// ── B-a2f1 CHK-001/002: stale-evidence UX must surface byte-identical recovery
// block across session_brief / story_advance pre-check / lattice validate hint. ──
function assertStaleEvidenceHintCrossSurface(): void {
  const root = mkdtempRoot();
  try {
    git(root, ['init']);
    git(root, ['config', 'user.email', 'smoke@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
    }, null, 2));
    write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
    const baseSha = commit(root, 'base');
    const baseMaterialHash = currentMaterialHash(root);
    assert.ok(baseMaterialHash, 'base material hash should be available');

    // Simulate a main-merge that drifted materialHash: change a material file.
    write(root, 'packages/main/src/base.ts', 'export const base = false;\n');
    commit(root, 'simulated main merge introduces material change');
    const driftHead = currentGitHead(root);
    assert.ok(driftHead, 'drift head should be available');

    const storyId = 'B-a2f1';
    const store = new StoryStore(root);
    const now = '2026-05-15T10:00:00.000Z';
    const story: StoryInfo = {
      storyId,
      name: 'stale-evidence-ux',
      title: 'Stale evidence UX smoke',
      description: 'Cross-surface stale-evidence marker smoke',
      type: 'chore',
      phase: 'REVIEW',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [{ phase: 'REVIEW', action: 'advance', timestamp: now }],
    };
    const checklist: ChecklistData = {
      items: [{
        id: 'CHK-001',
        title: 'Stale evidence item',
        context: 'Stale evidence item',
        status: 'done',
        startTime: null,
        endTime: null,
        verificationIntent: {
          happy: [{ desc: 'stale evidence', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
        verificationEvidence: [{
          intentRef: 'CHK-001:happy:0',
          kind: 'logic_test',
          result: 'pass',
          note: 'evidence captured before material change',
          headHash: baseSha,
          materialHash: baseMaterialHash,
        }],
      }],
    };
    store.writeStory(storyId, story);
    store.writeChecklist(storyId, checklist);

    // (1) findStaleEvidence finds the drifted entry.
    const stale = findStaleEvidence(root, storyId);
    assert.equal(stale.length, 1, 'stale evidence should be detected after material drift');
    assert.equal(stale[0].intentRef, 'CHK-001:happy:0');
    assert.equal(stale[0].itemId, 'CHK-001');

    // (2) renderEvidenceStaleHint produces the canonical recovery block.
    const renderedBlock = renderEvidenceStaleHint(storyId, stale, { currentHead: driftHead });
    assert.ok(renderedBlock.includes(EVIDENCE_STALE_MARKER), 'rendered block must include marker constant');
    assert.ok(renderedBlock.includes('HEAD/material hash binding changed'),
      'rendered block must explain stale means evidence binding drift, not necessarily verification logic failure');
    assert.ok(renderedBlock.includes('does not necessarily mean the verification logic failed'),
      'rendered block must explicitly clarify stale evidence does not necessarily mean verification logic failed');
    assert.ok(renderedBlock.includes(`lattice verification_evidence_refresh_stale --storyId=${storyId}`),
      'rendered block must include refresh_stale command with literal storyId');
    assert.ok(renderedBlock.includes(`lattice validate --story=${storyId} --json`),
      'rendered block must include validate command with literal storyId');
    assert.ok(renderedBlock.includes(storyId), 'rendered block must include literal storyId');
    // preMortem #3 anti-placeholder anchors:
    assert.ok(!renderedBlock.includes('<storyId>'), 'rendered block must not contain <storyId> placeholder');
    assert.ok(!renderedBlock.includes('<B-'), 'rendered block must not contain <B-xxx> placeholder');
    // B-bdce GAP1/GAP2 regression (red/spike): the hint must guide the Host to the
    // done_prepare one-step recovery AND classify the drift, so a future edit that
    // drops either line FAILs here (the red test, formalized).
    assert.ok(renderedBlock.includes(`lattice done_prepare --storyId=${storyId} --mergeMain --refreshStale --validate`),
      'GAP1: rendered block must offer the done_prepare one-step ordered recovery with literal storyId');
    assert.ok(/storyFilesHash|story-owned|whole-tree|unrelated/.test(renderedBlock),
      'GAP2: rendered block must classify the drift (whole-tree materialHash vs story-owned storyFilesHash)');
    assert.ok(renderedBlock.includes('Drift class:'),
      'rendered block must include the Drift class line');

    // (3) session_brief surface: must include marker + identical recovery block.
    // session_brief detects active story from `git rev-parse --abbrev-ref HEAD`.
    // Create a story branch so detection succeeds.
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const briefOutput = createSessionHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }).session_brief({});
    assert.ok(briefOutput.includes(EVIDENCE_STALE_MARKER),
      `session_brief must include EVIDENCE STALE marker. Actual output:\n${briefOutput}`);
    // Recovery block (the 4 lines after the marker line) must be byte-identical.
    const briefBlock = extractStaleBlock(briefOutput);
    assert.equal(briefBlock, renderedBlock,
      `session_brief stale block must be byte-identical to renderer output.\nGot:\n${briefBlock}\nExpected:\n${renderedBlock}`);
    assert.ok(!briefOutput.includes('<storyId>'), 'session_brief must not contain <storyId> placeholder');

    // (4) validate-hint surface: feed synthetic validate JSON through decorateResult.
    //     Use a fake result that mimics `lattice validate --story=B-a2f1 --json` returning
    //     allPass=false + verificationCoverage with stale entries.
    const fakeValidateJson = JSON.stringify({
      provider: 'lattice-verifier',
      allPass: false,
      verificationCoverage: {
        total: 1,
        covered: 0,
        missingRequired: 1,
        entries: [{
          intentRef: 'CHK-001:happy:0',
          priority: 'must',
          status: 'stale',
          desc: 'stale evidence',
        }],
      },
    });
    const decorated = decorateResult({
      cmd: 'validate',
      args: { storyId, story: storyId, json: true },
      result: fakeValidateJson,
      store,
      root,
      activeStory: { storyId, phase: 'REVIEW' },
    });
    const decoratedText = typeof decorated === 'string' ? decorated : JSON.stringify(decorated);
    assert.ok(decoratedText.includes(EVIDENCE_STALE_MARKER),
      `validate hint must include EVIDENCE STALE marker. Actual:\n${decoratedText}`);
    const validateBlock = extractStaleBlock(decoratedText);
    assert.equal(validateBlock, renderedBlock,
      `validate stale block must be byte-identical to renderer output.\nGot:\n${validateBlock}\nExpected:\n${renderedBlock}`);
    assert.ok(!decoratedText.includes('<storyId>'), 'validate hint must not contain <storyId> placeholder');

    // (5) Fresh case: no marker should leak when evidence matches current HEAD.
    //     Update evidence to current head + materialHash; re-run findStaleEvidence and session_brief.
    const freshMaterialHash = currentMaterialHash(root);
    assert.ok(freshMaterialHash, 'fresh material hash should be available');
    const freshChecklist: ChecklistData = JSON.parse(JSON.stringify(checklist));
    freshChecklist.items[0].verificationEvidence![0].headHash = driftHead;
    freshChecklist.items[0].verificationEvidence![0].materialHash = freshMaterialHash;
    store.writeChecklist(storyId, freshChecklist);
    const freshStale = findStaleEvidence(root, storyId);
    assert.equal(freshStale.length, 0, 'fresh evidence should not be detected as stale');
    const freshHint = renderEvidenceStaleHint(storyId, freshStale, { currentHead: driftHead });
    assert.equal(freshHint, '', 'renderEvidenceStaleHint must return empty string when no stale entries');
    const freshBrief = createSessionHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }).session_brief({});
    assert.ok(!freshBrief.includes(EVIDENCE_STALE_MARKER),
      `fresh session_brief must NOT include EVIDENCE STALE marker. Actual:\n${freshBrief}`);

    // (6) No-storyId guard: renderer must omit block entirely (anti-placeholder).
    const noStoryHint = renderEvidenceStaleHint(undefined, stale, { currentHead: driftHead });
    assert.equal(noStoryHint, '', 'renderEvidenceStaleHint without storyId must return empty string');
    const emptyStoryIdHint = renderEvidenceStaleHint('', stale, { currentHead: driftHead });
    assert.equal(emptyStoryIdHint, '', 'renderEvidenceStaleHint with empty storyId must return empty string');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Extract the EVIDENCE STALE block (marker line + the following 7 indented
 *  lines) from a surface output, so we can assert byte-identity against the
 *  renderer output without false negatives from surface-specific
 *  preamble/trailing text. */
function extractStaleBlock(output: string): string {
  const lines = output.split('\n');
  const markerIdx = lines.findIndex(l => l.startsWith(EVIDENCE_STALE_MARKER));
  if (markerIdx < 0) return '';
  // Renderer emits exactly 8 lines (B-bdce): marker / meaning / drift-class /
  // "Run to recover" / 2 recovery command lines / "Or, when converging..." /
  // done_prepare one-step command line.
  return lines.slice(markerIdx, markerIdx + 8).join('\n');
}

assertStaleEvidenceHintCrossSurface();

// ── B-a2f1 CHK-003: recover_evidence single-shot ──
// Verifies:
//   (1) Allowlist invariant — only 3 categories pass through (preMortem #1).
//   (2) Happy path — stale fixture with no non-metadata dirt → refresh + validate.
//   (3) Refuse path (material) — material_source_changes blocks recover.
//   (4) Refuse path (unexpected) — unexpected_dirty_files blocks recover.
async function assertRecoverEvidenceCommand(): Promise<void> {
  // (1) Allowlist invariant — guard against future categories silently passing.
  // Must be an allowlist (3 entries), not a blocklist (would grow with classifier).
  assert.equal(
    RECOVER_EVIDENCE_ALLOWED_CATEGORIES.size,
    3,
    `RECOVER_EVIDENCE_ALLOWED_CATEGORIES must contain exactly 3 entries; found ${RECOVER_EVIDENCE_ALLOWED_CATEGORIES.size} — adding new DIRTY_WORKTREE_CATEGORIES must NOT silently pass through recover_evidence (preMortem #1).`,
  );
  for (const expected of ['lattice_metadata_changes', 'runtime_artifact_changes', 'declared_artifact_changes'] as const) {
    assert.ok(
      RECOVER_EVIDENCE_ALLOWED_CATEGORIES.has(expected),
      `RECOVER_EVIDENCE_ALLOWED_CATEGORIES must contain ${expected}`,
    );
  }

  // Shared fixture builder for cases (2) (3) (4): stale evidence + clean worktree.
  function makeFixture(): { root: string; storyId: string; store: StoryStore; cleanup: () => void } {
    const root = mkdtempRoot();
    try {
      git(root, ['init']);
      git(root, ['config', 'user.email', 'smoke@example.test']);
      git(root, ['config', 'user.name', 'Proofbound Smoke']);
      write(root, 'lattice.config.json', JSON.stringify({
        scanRoot: 'packages/main',
        rootDir: 'src',
        storyDir: '.lattice/story/actives',
        requirementsDir: 'docs/requirements',
      }, null, 2));
      write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
      const baseSha = commit(root, 'base');
      const baseMaterialHash = currentMaterialHash(root);
      assert.ok(baseMaterialHash, 'base material hash should be available');

      // Drift: change a material file in a new commit (simulates a main merge).
      write(root, 'packages/main/src/base.ts', 'export const base = false;\n');
      commit(root, 'material drift');

      const storyId = 'B-recover';
      const store = new StoryStore(root);
      const now = '2026-05-15T10:00:00.000Z';
      const story: StoryInfo = {
        storyId,
        name: 'recover-evidence-smoke',
        title: 'recover_evidence smoke',
        description: 'Smoke fixture for recover_evidence single-shot command.',
        type: 'chore',
        phase: 'TEST',
        priority: 'medium',
        createdAt: now,
        startedAt: now,
        endedAt: null,
        events: [{ phase: 'TEST', action: 'advance', timestamp: now }],
      };
      const checklist: ChecklistData = {
        items: [{
          id: 'CHK-001',
          title: 'Stale evidence item',
          context: 'Stale evidence item',
          status: 'done',
          startTime: null,
          endTime: null,
          verificationIntent: {
            happy: [{ desc: 'stale evidence', type: 'logic', priority: 'must' }],
            edge: [],
            adversarial: [],
          },
          verificationEvidence: [{
            intentRef: 'CHK-001:happy:0',
            kind: 'logic_test',
            result: 'pass',
            note: 'old evidence pinned to baseSha',
            headHash: baseSha,
            materialHash: baseMaterialHash,
            command: 'npm test',
          }],
        }],
      };
      store.writeStory(storyId, story);
      store.writeChecklist(storyId, checklist);
      return { root, storyId, store, cleanup: () => rmSync(root, { recursive: true, force: true }) };
    } catch (e) {
      rmSync(root, { recursive: true, force: true });
      throw e;
    }
  }

  // Handler return type is intentionally loose at runtime (CLI returns object);
  // the smoke test reads through the documented shape only.
  type RecoverResult = {
    status: 'pass' | 'fail' | 'refused';
    refused?: { reason: string; categories: string[]; paths: string[] };
    refreshTranscript?: string;
    validateTranscript?: string;
  };

  // Handler is pure: always returns the structured result; CLI wrapper handles
  // exit-code escalation in cli-engine.ts. Smoke asserts the in-process shape.
  function runHandler(root: string, storyId: string, store: StoryStore): Promise<RecoverResult> {
    const handlers = createRecoverEvidenceHandlers({ store, root, scanRoot: join(root, 'packages/main') });
    return Promise.resolve(handlers.recover_evidence({ storyId })) as Promise<RecoverResult>;
  }

  // (2) Happy path — no non-metadata dirt; refresh + validate must run, status=pass.
  {
    const fx = makeFixture();
    try {
      const result = await runHandler(fx.root, fx.storyId, fx.store);
      assert.equal(result.status, 'pass',
        `recover_evidence happy path must return status=pass. Got: ${JSON.stringify(result)}`);
      assert.ok(result.refreshTranscript && /Refreshed 1\/1 stale evidence/.test(result.refreshTranscript),
        `refreshTranscript must contain "Refreshed 1/1 stale evidence". Got:\n${result.refreshTranscript}`);
      assert.ok(result.validateTranscript && result.validateTranscript.length > 0,
        `validateTranscript must be non-empty. Got:\n${result.validateTranscript}`);
      // Refresh must come before validate in the result object (refresh first, validate second).
      assert.ok(result.refreshTranscript && result.validateTranscript,
        'both transcripts must be populated in happy path');
    } finally {
      fx.cleanup();
    }
  }

  // (3) Refuse — material_source_changes blocks recover.
  {
    const fx = makeFixture();
    try {
      // Introduce a material-source untracked file (matches scanRoot + rootDir = packages/main/src/).
      write(fx.root, 'packages/main/src/foo.ts', 'export const x = 1;\n');
      const result = await runHandler(fx.root, fx.storyId, fx.store);
      assert.equal(result.status, 'refused',
        `recover_evidence with material_source_changes must refuse. Got: ${JSON.stringify(result)}`);
      assert.ok(result.refused, 'refused field must be present');
      assert.ok(result.refused!.reason.includes('material_source_changes'),
        `refused.reason must include material_source_changes. Got: ${result.refused!.reason}`);
      assert.ok(result.refused!.categories.includes('material_source_changes'),
        `refused.categories must include material_source_changes. Got: ${JSON.stringify(result.refused!.categories)}`);
      assert.ok(result.refused!.paths.some(p => p.includes('foo.ts')),
        `refused.paths must include foo.ts. Got: ${JSON.stringify(result.refused!.paths)}`);
      // Short-circuit: transcripts must be undefined on refuse.
      assert.equal(result.refreshTranscript, undefined,
        `refused path must NOT run refresh (refreshTranscript should be undefined). Got: ${result.refreshTranscript}`);
      assert.equal(result.validateTranscript, undefined,
        `refused path must NOT run validate (validateTranscript should be undefined). Got: ${result.validateTranscript}`);
    } finally {
      fx.cleanup();
    }
  }

  // (4) Refuse — unexpected_dirty_files blocks recover.
  {
    const fx = makeFixture();
    try {
      // Path not in scanRoot, not fixtures, not metadata, not runtime artifact → unexpected.
      write(fx.root, 'packages/main/tests/output/x.json', '{}\n');
      const result = await runHandler(fx.root, fx.storyId, fx.store);
      assert.equal(result.status, 'refused',
        `recover_evidence with unexpected_dirty_files must refuse. Got: ${JSON.stringify(result)}`);
      assert.ok(result.refused, 'refused field must be present');
      assert.ok(result.refused!.reason.includes('unexpected_dirty_files'),
        `refused.reason must include unexpected_dirty_files. Got: ${result.refused!.reason}`);
      assert.ok(result.refused!.categories.includes('unexpected_dirty_files'),
        `refused.categories must include unexpected_dirty_files. Got: ${JSON.stringify(result.refused!.categories)}`);
    } finally {
      fx.cleanup();
    }
  }

  // (5) Runtime guard: missing / empty storyId must throw before any classification.
  {
    const fx = makeFixture();
    try {
      const handlers = createRecoverEvidenceHandlers({ store: fx.store, root: fx.root, scanRoot: join(fx.root, 'packages/main') });
      await assert.rejects(
        () => Promise.resolve(handlers.recover_evidence({ storyId: '' })),
        /storyId is required/,
        'empty storyId must reject',
      );
      await assert.rejects(
        () => Promise.resolve(handlers.recover_evidence({ storyId: '   ' })),
        /storyId is required/,
        'whitespace storyId must reject (mirrors Zod min(1) at runtime)',
      );
    } finally {
      fx.cleanup();
    }
  }
}

await assertRecoverEvidenceCommand();

// ── B-a2f1 CHK-004: end-to-end main-merge regression ──
// Simulate the real B-c9f5 failure: a user finishes DEV with evidence pinned
// at baseSha/baseMaterialHash, then merges main (which drifts materialHash),
// then runs session_brief / story_advance --phase=REVIEW / lattice validate.
// All three surfaces must surface the EVIDENCE STALE marker with a
// byte-identical recovery block that uses the real storyId (no placeholders),
// and the recover_evidence single-shot must (a) succeed when only stale
// evidence exists, (b) refuse when unexpected_dirty_files appear.
//
// Ties together CHK-001/002 (cross-surface marker) and CHK-003 (recover_evidence)
// covering all three preMortem anti-regression anchors from decision.json:
//   #1 allowlist invariant (recover_evidence refuses unknown categories)
//   #2 marker no-drift across surfaces (byte-identical block)
//   #3 no placeholder leakage (literal storyId, no <storyId> / <B-...>)
async function assertSimulatedMainMergeRegression(): Promise<void> {
  const root = mkdtempRoot();
  const originalCwd = process.cwd();
  try {
    // ── 1. Build temp git fixture with a baseline materialHash ─────────────
    git(root, ['init']);
    git(root, ['config', 'user.email', 'smoke@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
    }, null, 2));
    resetConfigCache();
    write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
    git(root, ['checkout', '-B', 'main']);
    const baseSha = commit(root, 'base');
    const baseMaterialHash = currentMaterialHash(root);
    assert.ok(baseMaterialHash, 'base material hash should be available');

    // Create story branch BEFORE simulating the main merge — story_advance
    // detects the story via the branch name and autoCommitStoryMetadata only
    // commits on a story branch.
    const storyId = 'B-a2f1mm';
    git(root, ['checkout', '-b', `story/${storyId}`]);

    // ── 2. Set up a story in DEV with checklist all-done + pinned evidence ─
    const store = new StoryStore(root);
    const now = '2026-05-15T11:00:00.000Z';
    const reviewRound = '2026-05-15T11:01:00.000Z';
    const story: StoryInfo = {
      storyId,
      name: 'simulated-main-merge',
      title: 'Simulated main-merge regression',
      description: 'End-to-end stale evidence UX regression smoke.',
      type: 'chore',
      phase: 'DEV',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      // Important: do NOT set `worktree` — keeps CWD gating off in fixture.
      currentReviewRound: reviewRound,
      events: [{ phase: 'DEV', action: 'advance', timestamp: now }],
    };
    const checklist: ChecklistData = {
      items: [{
        id: 'CHK-001',
        title: 'Stale evidence item',
        context: 'Stale evidence item',
        status: 'done',
        startTime: now,
        endTime: now,
        verificationIntent: {
          happy: [{ desc: 'evidence pinned at baseSha', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
        verificationEvidence: [{
          intentRef: 'CHK-001:happy:0',
          kind: 'logic_test',
          result: 'pass',
          note: 'evidence captured BEFORE main merge',
          headHash: baseSha,
          materialHash: baseMaterialHash,
          command: 'npm test',
        }],
      }],
    };
    store.writeStory(storyId, story);
    store.writeChecklist(storyId, checklist);
    // PLAN-stage decision + understanding so DEV→REVIEW guard checklistAllDone
    // is satisfied and downstream reviewer routing has data to read.
    store.writeUnderstanding(storyId, {
      task: 'Stale evidence regression smoke',
      outcome: 'Cross-surface stale-evidence marker stays byte-identical',
      facts: [],
      constraints: [],
      unknowns: [],
      touchpoints: ['packages/main/src/base.ts'],
      timestamp: now,
    } as any);
    store.writeDecision(storyId, {
      principles: ['keep gates explicit', 'reuse stale-hint renderer', 'avoid placeholder leakage'],
      drivers: ['main-merge UX regression coverage'],
      options: [
        { name: 'A: shared renderer', pros: ['byte-identical surfaces'], cons: ['needs storyId plumbing'] },
        { name: 'B: per-surface strings', pros: ['simpler'], cons: ['marker drift risk'] },
      ],
      chosen: 'A: shared renderer',
      rationale: 'three surfaces must use one source of truth',
      timestamp: now,
    } as any);

    // ── 3. Simulate the main merge: change material file + commit ──────────
    // (This drifts both headHash and materialHash relative to the pinned
    //  evidence; freshness check should report stale.)
    write(root, 'packages/main/src/base.ts', 'export const base = false;\n');
    const driftHead = commit(root, 'simulated main merge drifts material');
    assert.ok(driftHead, 'drift head should be available');

    // chdir into root so autoCommitStoryMetadata + git-probe paths resolve.
    process.chdir(root);

    // ── Sanity: findStaleEvidence detects the drift ────────────────────────
    {
      const preStale = findStaleEvidence(root, storyId);
      assert.equal(preStale.length, 1, 'main-merge drift should produce exactly 1 stale entry');
      assert.equal(preStale[0].intentRef, 'CHK-001:happy:0');
    }

    // ── 4. Surface #1: story_advance DEV→REVIEW pre-check ──────────────────
    // story_advance for DEV→REVIEW only requires checklistAllDone guard, which
    // is satisfied by our fixture. transition-orchestrator.ts appends the stale
    // hint (via transition-effects.ts renderRelatedDocsHint) when
    // newState ∈ {REVIEW, TEST, DONE}.
    //
    // story_advance is called FIRST because autoCommitStoryMetadata creates a
    // metadata commit (advancing HEAD by one), and we want all three surfaces
    // to render against the SAME HEAD so byte-identicality is verifiable. If
    // session_brief / decorateResult ran first they would see the pre-advance
    // HEAD and produce a block that differs by 7 chars (the `(materialHash
    // drift after <sha7>)` segment) — defeating preMortem #2 cross-surface
    // byte-identity coverage. See driftHead vs post-advance currentGitHead.
    const advanceOutput = await createStoryAdvanceHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }).story_advance({ storyId, phase: 'REVIEW' });

    // After story_advance, HEAD has advanced by one (autoCommitStoryMetadata).
    // Compute the canonical block against post-advance HEAD — same input as
    // the other surfaces will see for the rest of this fixture's lifetime.
    const postAdvanceHead = currentGitHead(root);
    assert.ok(postAdvanceHead, 'post-advance HEAD should be available');
    const staleEntries = findStaleEvidence(root, storyId);
    assert.equal(staleEntries.length, 1,
      'stale entry should remain after story_advance (advance does not refresh evidence)');
    const canonicalBlock = renderEvidenceStaleHint(storyId, staleEntries, { currentHead: postAdvanceHead });
    assert.ok(canonicalBlock.includes(EVIDENCE_STALE_MARKER),
      'canonical block must contain marker');
    assert.ok(canonicalBlock.includes(storyId),
      'canonical block must contain literal storyId');
    assert.ok(!canonicalBlock.includes('<storyId>'),
      'canonical block must not contain <storyId> placeholder (preMortem #3)');
    assert.ok(!canonicalBlock.includes('<B-'),
      'canonical block must not contain <B-...> placeholder (preMortem #3)');

    assert.ok(advanceOutput.includes(EVIDENCE_STALE_MARKER),
      `story_advance surface must include EVIDENCE STALE marker.\nActual:\n${advanceOutput}`);
    const advanceBlock = extractStaleBlock(advanceOutput);
    assert.equal(advanceBlock, canonicalBlock,
      `story_advance block must be byte-identical to renderer (preMortem #2).\nGot:\n${advanceBlock}\nExpected:\n${canonicalBlock}`);
    assert.ok(advanceOutput.includes(storyId),
      'story_advance output must include literal storyId');
    assert.ok(!advanceOutput.includes('<storyId>'),
      'story_advance output must not leak <storyId> placeholder (preMortem #3)');
    assert.ok(!advanceOutput.includes('<B-a2f1mm>'),
      'story_advance output must not leak <B-a2f1mm> placeholder (preMortem #3)');

    // ── 5. Surface #2: session_brief (post-advance HEAD) ───────────────────
    // Phase is now REVIEW. session_brief on REVIEW reads the same stale
    // evidence and uses the same currentGitHead, so its block must match
    // the canonical block byte-for-byte.
    const briefOutput = createSessionHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }).session_brief({});
    assert.ok(briefOutput.includes(EVIDENCE_STALE_MARKER),
      `session_brief surface must include EVIDENCE STALE marker.\nActual:\n${briefOutput}`);
    const briefBlock = extractStaleBlock(briefOutput);
    assert.equal(briefBlock, canonicalBlock,
      `session_brief block must be byte-identical to renderer (preMortem #2).\nGot:\n${briefBlock}\nExpected:\n${canonicalBlock}`);
    assert.ok(briefOutput.includes(storyId),
      'session_brief output must include literal storyId');
    assert.ok(!briefOutput.includes('<storyId>'),
      'session_brief output must not leak <storyId> placeholder (preMortem #3)');
    assert.ok(!briefOutput.includes('<B-a2f1mm>'),
      'session_brief output must not leak <B-a2f1mm> placeholder (preMortem #3)');

    // Restore to DEV so the remaining surfaces and recover_evidence see a
    // consistent in-progress phase (phase is irrelevant to stale detection,
    // but keeps the fixture's narrative coherent).
    const updatedStory = store.readStory(storyId);
    updatedStory.phase = 'DEV';
    store.writeStory(storyId, updatedStory);

    // ── 6. Surface #3: lattice validate (via decorateResult hint) ──────────
    const fakeValidateJson = JSON.stringify({
      provider: 'lattice-verifier',
      allPass: false,
      verificationCoverage: {
        total: 1,
        covered: 0,
        missingRequired: 1,
        entries: [{
          intentRef: 'CHK-001:happy:0',
          priority: 'must',
          status: 'stale',
          desc: 'evidence pinned at baseSha',
        }],
      },
    });
    const decorated = decorateResult({
      cmd: 'validate',
      args: { storyId, story: storyId, json: true },
      result: fakeValidateJson,
      store,
      root,
      activeStory: { storyId, phase: 'DEV' },
    });
    const validateText = typeof decorated === 'string' ? decorated : JSON.stringify(decorated);
    assert.ok(validateText.includes(EVIDENCE_STALE_MARKER),
      `validate surface must include EVIDENCE STALE marker.\nActual:\n${validateText}`);
    const validateBlock = extractStaleBlock(validateText);
    assert.equal(validateBlock, canonicalBlock,
      `validate block must be byte-identical to renderer (preMortem #2).\nGot:\n${validateBlock}\nExpected:\n${canonicalBlock}`);
    assert.ok(validateText.includes(storyId),
      'validate output must include literal storyId');
    assert.ok(!validateText.includes('<storyId>'),
      'validate output must not leak <storyId> placeholder (preMortem #3)');
    assert.ok(!validateText.includes('<B-a2f1mm>'),
      'validate output must not leak <B-a2f1mm> placeholder (preMortem #3)');

    // ── 7. Three-way byte-identity proof (preMortem #2 anchor) ─────────────
    // Already asserted each block == canonicalBlock above; double-check
    // pairwise to make the regression intent explicit in the failure trace.
    assert.equal(briefBlock, advanceBlock,
      'session_brief and story_advance blocks must be byte-identical');
    assert.equal(advanceBlock, validateBlock,
      'story_advance and validate blocks must be byte-identical');
    assert.equal(briefBlock, validateBlock,
      'session_brief and validate blocks must be byte-identical');

    // ── 8. End-to-end recover_evidence happy path ──────────────────────────
    // No non-metadata dirt in worktree → recover must refresh + revalidate.
    type RecoverResult = {
      status: 'pass' | 'fail' | 'refused';
      refused?: { reason: string; categories: string[]; paths: string[] };
      refreshTranscript?: string;
      validateTranscript?: string;
    };
    const recoverHandlers = createRecoverEvidenceHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    });
    const recoverResult = (await Promise.resolve(
      recoverHandlers.recover_evidence({ storyId }),
    )) as RecoverResult;
    assert.equal(recoverResult.status, 'pass',
      `recover_evidence after main-merge must succeed. Got: ${JSON.stringify(recoverResult)}`);
    assert.ok(recoverResult.refreshTranscript,
      'recover_evidence happy path must populate refreshTranscript');
    // Refresh transcript should reflect actually-refreshed evidence; case
    // insensitive to absorb future copy tweaks but anchored on the canonical
    // helper output `Refreshed 1/1 stale evidence`.
    assert.match(recoverResult.refreshTranscript!, /[Rr]efresh/,
      `refreshTranscript must mention refresh. Got:\n${recoverResult.refreshTranscript}`);
    assert.match(recoverResult.refreshTranscript!, /1\/1/,
      `refreshTranscript must report 1/1 refreshed. Got:\n${recoverResult.refreshTranscript}`);
    assert.ok(recoverResult.validateTranscript && recoverResult.validateTranscript.length > 0,
      'recover_evidence happy path must populate validateTranscript');
    // After recover, evidence should be re-pinned to drift head — no longer stale.
    const postRecoverStale = findStaleEvidence(root, storyId);
    assert.equal(postRecoverStale.length, 0,
      'after recover_evidence pass, findStaleEvidence must return empty (evidence refreshed)');
  } finally {
    process.chdir(originalCwd);
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }

  // ── 9. Separate fixture: unexpected_dirty_files refuse path ──────────────
  // (preMortem #1 anchor: allowlist must refuse categories outside the 3
  //  whitelisted ones — `packages/main/tests/output/` is unexpected.)
  const root2 = mkdtempRoot();
  const originalCwd2 = process.cwd();
  try {
    git(root2, ['init']);
    git(root2, ['config', 'user.email', 'smoke@example.test']);
    git(root2, ['config', 'user.name', 'Proofbound Smoke']);
    write(root2, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
    }, null, 2));
    resetConfigCache();
    write(root2, 'packages/main/src/base.ts', 'export const base = true;\n');
    const baseSha2 = commit(root2, 'base');
    const baseMaterialHash2 = currentMaterialHash(root2);
    assert.ok(baseMaterialHash2, 'base material hash should be available');

    // Material drift commit (simulated main merge).
    write(root2, 'packages/main/src/base.ts', 'export const base = false;\n');
    commit(root2, 'simulated main merge drifts material');

    const storyId2 = 'B-a2f1mm';
    const store2 = new StoryStore(root2);
    const now = '2026-05-15T11:00:00.000Z';
    store2.writeStory(storyId2, {
      storyId: storyId2,
      name: 'simulated-main-merge-refused',
      title: 'Simulated main-merge refuse smoke',
      description: 'Refuse on unexpected_dirty_files.',
      type: 'chore',
      phase: 'TEST',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [{ phase: 'TEST', action: 'advance', timestamp: now }],
    });
    store2.writeChecklist(storyId2, {
      items: [{
        id: 'CHK-001',
        title: 'Stale evidence item',
        context: 'Stale evidence item',
        status: 'done',
        startTime: now,
        endTime: now,
        verificationIntent: {
          happy: [{ desc: 'evidence pinned', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
        verificationEvidence: [{
          intentRef: 'CHK-001:happy:0',
          kind: 'logic_test',
          result: 'pass',
          note: 'baseline evidence',
          headHash: baseSha2,
          materialHash: baseMaterialHash2,
        }],
      }],
    });

    // Inject the exact category called out by CHK-004: an untracked file
    // under packages/main/tests/output/ (not a fixture, not metadata, not
    // runtime artifact, not declared artifact → unexpected_dirty_files).
    write(root2, 'packages/main/tests/output/foo.json', '{"unexpected":true}\n');
    process.chdir(root2);

    type RecoverResult = {
      status: 'pass' | 'fail' | 'refused';
      refused?: { reason: string; categories: string[]; paths: string[] };
      refreshTranscript?: string;
      validateTranscript?: string;
    };
    const recoverHandlers2 = createRecoverEvidenceHandlers({
      store: store2,
      root: root2,
      scanRoot: join(root2, 'packages/main'),
    });
    const refusedResult = (await Promise.resolve(
      recoverHandlers2.recover_evidence({ storyId: storyId2 }),
    )) as RecoverResult;
    assert.equal(refusedResult.status, 'refused',
      `recover_evidence with packages/main/tests/output/foo.json must refuse. Got: ${JSON.stringify(refusedResult)}`);
    assert.ok(refusedResult.refused, 'refused field must be present');
    assert.ok(refusedResult.refused!.reason.includes('unexpected_dirty_files'),
      `refused.reason must include "unexpected_dirty_files" (preMortem #1).\nGot: ${refusedResult.refused!.reason}`);
    assert.ok(refusedResult.refused!.categories.includes('unexpected_dirty_files'),
      `refused.categories must include "unexpected_dirty_files".\nGot: ${JSON.stringify(refusedResult.refused!.categories)}`);
    assert.ok(refusedResult.refused!.paths.some(p => p.includes('foo.json')),
      `refused.paths must include foo.json.\nGot: ${JSON.stringify(refusedResult.refused!.paths)}`);
    // Short-circuit invariant: refused MUST NOT have run refresh / validate.
    assert.equal(refusedResult.refreshTranscript, undefined,
      `refused path must NOT run refresh.\nGot: ${refusedResult.refreshTranscript}`);
    assert.equal(refusedResult.validateTranscript, undefined,
      `refused path must NOT run validate.\nGot: ${refusedResult.validateTranscript}`);

    // The stale evidence is still stale (recover refused → didn't refresh).
    const stillStale = findStaleEvidence(root2, storyId2);
    assert.equal(stillStale.length, 1,
      'refuse path must leave stale evidence intact (no silent refresh)');
  } finally {
    process.chdir(originalCwd2);
    resetConfigCache();
    rmSync(root2, { recursive: true, force: true });
  }
}

await assertSimulatedMainMergeRegression();

// ── B-edca: test-evidence.json is metadata-only; custom storyDir exclusion ──
{
  // (1) .lattice/story/actives/B-smoke/test-evidence.json is metadata-only and
  //     keeps material-hash evidence fresh.
  const path1 = '.lattice/story/actives/B-smoke/test-evidence.json';
  assert.equal(isMaterialExcludedPath(path1), true, `${path1} should be metadata`);
  assert.equal(materialFreshAfterChanging(path1), true, `${path1} should keep material-hash evidence fresh`);

  // (2) custom configured storyDir: workflow/stories/B-smoke/test-evidence.json
  //     is metadata when lattice.config.json sets storyDir to workflow/stories.
  //     workflow/notes.md must NOT be excluded (parent dir is not storyDir).
  {
    const root = mkdtempRoot();
    try {
      git(root, ['init']);
      resetConfigCache();
      write(root, 'lattice.config.json', JSON.stringify({ storyDir: 'workflow/stories' }, null, 2));
      write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
      const base = commit(root, 'base');
      const materialHash = currentMaterialHash(root);
      assert.ok(materialHash, 'material hash should be available');

      // (2a) story metadata path IS excluded
      const storyMetaPath = 'workflow/stories/B-smoke/test-evidence.json';
      write(root, storyMetaPath, 'changed\n');
      const baseAfterMeta = commit(root, 'change custom storyDir test-evidence');
      const materialHashAfterMeta = currentMaterialHash(root);
      assert.ok(materialHashAfterMeta, 'materialHashAfterMeta should be available');
      const freshAfterMeta = checkEvidenceFreshnessForGit(root, base, materialHash).fresh;
      assert.equal(freshAfterMeta, true, `${storyMetaPath} with storyDir=workflow/stories should keep material-hash evidence fresh`);
      assert.equal(isMaterialExcludedPath(storyMetaPath, root), true, `${storyMetaPath} must be excluded with storyDir=workflow/stories`);

      // (2b) sibling file outside storyDir must NOT be excluded and must make evidence stale.
      // Use the post-meta commit as baseline so the sibling change is the only diff.
      const siblingPath = 'workflow/notes.md';
      assert.equal(isMaterialExcludedPath(siblingPath, root), false, `${siblingPath} must NOT be excluded (not under storyDir)`);
      write(root, siblingPath, 'content\n');
      commit(root, 'change sibling file');
      const staleAfterSibling = checkEvidenceFreshnessForGit(root, baseAfterMeta, materialHashAfterMeta).fresh;
      assert.equal(staleAfterSibling, false, `${siblingPath} must make material-hash evidence stale`);
    } finally {
      resetConfigCache();
      rmSync(root, { recursive: true, force: true });
    }
  }

  // (3) a real material file still makes evidence stale.
  const materialPath = 'packages/main/src/core/verifier.ts';
  assert.equal(materialFreshAfterChanging(materialPath), false, `${materialPath} should make material-hash evidence stale`);
}

console.log('✓ verification freshness smoke passed');
