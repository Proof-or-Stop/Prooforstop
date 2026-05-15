#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkEvidenceFreshnessForGit, currentMaterialHash, currentGitHead, isMaterialExcludedPath } from '../core/evidence-freshness.js';
import { buildVerificationCoverage } from '../core/verification.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { EVIDENCE_STALE_MARKER, findStaleEvidence, renderEvidenceStaleHint } from '../core/evidence-stale-hint.js';
import { createSessionHandlers } from '../handlers/session.js';
import { decorateResult } from '../handlers/hints.js';
import {
  createRecoverEvidenceHandlers,
  RECOVER_EVIDENCE_ALLOWED_CATEGORIES,
} from '../handlers/recover-evidence.js';

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

const runtimeMetadata = [
  '.koala/activity.jsonl',
  'docs/story/activity.jsonl',
];

const material = [
  'packages/main/src/core/verification.ts',
  'packages/main/tests/fixtures/story.json',
  'packages/main/package.json',
  'package-lock.json',
  'koala.config.json',
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

// ── B-a2f1 CHK-001/002: stale-evidence UX must surface byte-identical recovery
// block across session_brief / story_advance pre-check / koala validate hint. ──
function assertStaleEvidenceHintCrossSurface(): void {
  const root = mkdtempRoot();
  try {
    git(root, ['init']);
    git(root, ['config', 'user.email', 'smoke@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
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
    assert.ok(renderedBlock.includes(`koala verification_evidence_refresh_stale --storyId=${storyId}`),
      'rendered block must include refresh_stale command with literal storyId');
    assert.ok(renderedBlock.includes(`koala validate --story=${storyId} --json`),
      'rendered block must include validate command with literal storyId');
    assert.ok(renderedBlock.includes(storyId), 'rendered block must include literal storyId');
    // preMortem #3 anti-placeholder anchors:
    assert.ok(!renderedBlock.includes('<storyId>'), 'rendered block must not contain <storyId> placeholder');
    assert.ok(!renderedBlock.includes('<B-'), 'rendered block must not contain <B-xxx> placeholder');

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
    //     Use a fake result that mimics `koala validate --story=B-a2f1 --json` returning
    //     allPass=false + verificationCoverage with stale entries.
    const fakeValidateJson = JSON.stringify({
      provider: 'koala-verifier',
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

/** Extract the EVIDENCE STALE block (marker line + the following 3 indented
 *  recovery lines) from a surface output, so we can assert byte-identity
 *  against the renderer output without false negatives from surface-specific
 *  preamble/trailing text. */
function extractStaleBlock(output: string): string {
  const lines = output.split('\n');
  const markerIdx = lines.findIndex(l => l.startsWith(EVIDENCE_STALE_MARKER));
  if (markerIdx < 0) return '';
  // Renderer emits exactly 4 lines: marker / "  Run to recover:" / 2 command lines.
  return lines.slice(markerIdx, markerIdx + 4).join('\n');
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
  for (const expected of ['koala_metadata_changes', 'runtime_artifact_changes', 'declared_artifact_changes'] as const) {
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
      git(root, ['config', 'user.name', 'Koala Smoke']);
      write(root, 'koala.config.json', JSON.stringify({
        scanRoot: 'packages/main',
        rootDir: 'src',
        storyDir: '.koala/story/actives',
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

console.log('✓ verification freshness smoke passed');
