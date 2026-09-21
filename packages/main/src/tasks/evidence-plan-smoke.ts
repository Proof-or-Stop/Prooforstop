#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { getCommandPolicy } from '../core/command-policy.js';
import { DEFAULT_PHASE_TOOLS, isCommandAllowed, resetConfigCache } from '../core/config.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo, VerificationEvidence } from '../core/types.js';
import { buildStoryReadinessReport } from '../core/lifecycle-readiness.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';
import type { EvidencePlanReport } from '../handlers/evidence-plan.js';

const STORY_ID = 'B-eplan';
const NOW = '2026-06-20T00:00:00.000Z';
const STALE_HEAD = '0000000000000000000000000000000000000000';
const STALE_MATERIAL = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'evidence-plan-smoke',
      GIT_AUTHOR_EMAIL: 'evidence-plan-smoke@example.com',
      GIT_COMMITTER_NAME: 'evidence-plan-smoke',
      GIT_COMMITTER_EMAIL: 'evidence-plan-smoke@example.com',
    },
  }).trim();
}

function gitStatus(root: string): string {
  return git(root, ['status', '--short']);
}

function writeConfig(root: string): void {
  writeFileSync(
    join(root, 'proof-or-stop.config.json'),
    JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
    }, null, 2) + '\n',
    'utf8',
  );
  resetConfigCache();
}

function baseStory(): StoryInfo {
  return {
    storyId: STORY_ID,
    name: 'evidence-plan-smoke',
    title: 'Implement evidence_plan',
    description: 'Read-only DRY planner classifying verification evidence into missing/rerun/refresh-only/fresh.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  };
}

/**
 * Build a fixture repo. `seedChecklist(root, store)` is invoked AFTER the git
 * base commit so callers can stamp evidence with the actual current headHash /
 * materialHash (required for the genuine fresh vs refresh-only split).
 */
function createFixture(
  seedChecklist: (root: string, store: StoryStore) => ChecklistData,
): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-evidence-plan-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# evidence plan smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 1;\n', 'utf8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'proof-or-stop.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);

  const store = new StoryStore(root);
  store.writeStory(STORY_ID, baseStory());
  store.writeChecklist(STORY_ID, seedChecklist(root, store));
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  return { root, store, ctx };
}

function snapshotDir(root: string, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  function walk(abs: string): void {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const path = join(abs, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out[relative(root, path)] = readFileSync(path, 'utf8');
    }
  }
  walk(dir);
  return out;
}

function assertNoAuthorityOrEvidenceArtifacts(store: StoryStore): void {
  for (const artifact of [
    'test-evidence.json',
    'review-runs.json',
    'review-passes.json',
    'findings.json',
    'delivery-check.json',
    'summary.json',
    'done-required-evidence.json',
    'authority-receipt-refs.json',
  ]) {
    assert.equal(existsSync(store.storyFilePath(STORY_ID, artifact)), false, `${artifact} must not be written`);
  }
}

function intentRefsOf(report: EvidencePlanReport, bucket: keyof EvidencePlanReport['buckets']): Set<string> {
  return new Set(report.buckets[bucket].map((e) => e.intentRef));
}

/** Legacy non-executable attestation compatibility: missing/fail/stale/current.
 * Actual executable receipt admission is exercised by intent-fingerprint-reuse.test.mjs below. */
function fourIntentChecklist(root: string): ChecklistData {
  const head = currentGitHead(root);
  const material = currentMaterialHash(root, 'HEAD', root);
  assert.ok(head, 'fixture git head is readable');
  assert.ok(material, 'fixture material hash is computable');

  const freshEvidence: VerificationEvidence = {
    intentRef: 'CHK-001:happy:0',
    kind: 'docs_check',
    result: 'pass',
    note: 'fresh evidence — current head + material hash',
    headHash: head,
    materialHash: material,
  };
  const refreshOnlyEvidence: VerificationEvidence = {
    intentRef: 'CHK-001:edge:0',
    kind: 'docs_check',
    result: 'pass',
    note: 'pass but stale hash — logic valid, only needs re-stamp',
    headHash: STALE_HEAD,
    materialHash: STALE_MATERIAL,
  };
  const rerunEvidence: VerificationEvidence = {
    intentRef: 'CHK-001:adversarial:0',
    kind: 'docs_check',
    result: 'fail',
    command: 'npm test -- adversarial',
    note: 'failing evidence must be re-executed',
    headHash: head,
    materialHash: material,
  };
  // CHK-002:happy:0 has a must-priority intent with NO evidence → missing.

  return {
    items: [
      {
        id: 'CHK-001',
        title: 'Item with three covered lanes',
        context: 'fresh / refresh-only / rerun coverage',
        status: 'done',
        startTime: null,
        endTime: null,
        verificationIntent: {
          happy: [{ desc: 'fresh intent', type: 'docs', priority: 'must' }],
          edge: [{ desc: 'refresh-only intent', type: 'docs', priority: 'must' }],
          adversarial: [{ desc: 'rerun intent', type: 'docs', priority: 'must' }],
        },
        verificationEvidence: [freshEvidence, refreshOnlyEvidence, rerunEvidence],
      },
      {
        id: 'CHK-002',
        title: 'Item with an uncovered required intent',
        context: 'missing coverage',
        status: 'pending',
        startTime: null,
        endTime: null,
        verificationIntent: {
          happy: [{ desc: 'missing intent', type: 'docs', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
      },
    ],
  };
}

function emptyIntentChecklist(): ChecklistData {
  return {
    items: [
      {
        id: 'CHK-001',
        title: 'Item with no verification intent',
        context: 'no intents at all',
        status: 'pending',
        startTime: null,
        endTime: null,
      },
    ],
  };
}

function allFreshChecklist(root: string): ChecklistData {
  const head = currentGitHead(root);
  const material = currentMaterialHash(root, 'HEAD', root);
  assert.ok(head && material, 'fixture hashes available for all-fresh checklist');
  const mk = (ref: string): VerificationEvidence => ({
    intentRef: ref,
    kind: 'docs_check',
    result: 'pass',
    note: 'fresh',
    headHash: head!,
    materialHash: material!,
  });
  return {
    items: [
      {
        id: 'CHK-001',
        title: 'All lanes fresh',
        context: 'every intent has fresh passing evidence',
        status: 'done',
        startTime: null,
        endTime: null,
        verificationIntent: {
          happy: [{ desc: 'h', type: 'docs', priority: 'must' }],
          edge: [{ desc: 'e', type: 'docs', priority: 'should' }],
          adversarial: [{ desc: 'a', type: 'docs', priority: 'must' }],
        },
        verificationEvidence: [
          mk('CHK-001:happy:0'),
          mk('CHK-001:edge:0'),
          mk('CHK-001:adversarial:0'),
        ],
      },
    ],
  };
}

// ---- Policy / registration assertions -------------------------------------

assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'evidence_plan'), 'MAIN_TOOLS exposes evidence_plan');
const policy = getCommandPolicy('evidence_plan');
assert.equal(policy?.ownershipClass, 'readOnly', 'evidence_plan policy is readOnly');
assert.equal(policy?.destructiveRisk, 'none', 'evidence_plan policy has no destructive risk');
assert.equal(isCommandAllowed('evidence_plan', 'REVIEW', DEFAULT_PHASE_TOOLS), true, 'evidence_plan is available in REVIEW');
assert.equal(isCommandAllowed('evidence_plan', 'TEST', DEFAULT_PHASE_TOOLS), true, 'evidence_plan is available in TEST');
assert.equal(isCommandAllowed('evidence_plan', 'DONE', DEFAULT_PHASE_TOOLS), true, 'evidence_plan is available in DONE');

// ---- Fail-closed boundary (no store read on side-effect flags) ------------

{
  const throwingStore = new Proxy({}, {
    get(_t, prop) {
      throw new Error(`store read should not happen before evidence_plan rejection: ${String(prop)}`);
    },
  }) as StoryStore;
  const ctx: HandlerContext = { store: throwingStore, root: '/tmp/evidence-plan-no-read', scanRoot: '/tmp/evidence-plan-no-read/packages/main' };
  const handler = createMainRegistry(ctx).get('evidence_plan');
  assert.ok(handler, 'registry exposes evidence_plan for rejection test');
  for (const flag of ['runCommands', 'writeEvidence', 'write', 'refresh', 'execute', 'authorityDone'] as const) {
    assert.throws(
      () => handler!({ storyId: 'B-no-read', [flag]: true, json: true }),
      /read-only DRY planner|no story facts were read/,
      `${flag}=true fails closed before store reads`,
    );
  }
}

// ---- Core four-way classification + read-only invariants -------------------

{
  const { root, store, ctx } = createFixture((r) => fourIntentChecklist(r));
  try {
    const handler = createMainRegistry(ctx).get('evidence_plan');
    assert.ok(handler, 'registry exposes evidence_plan');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const beforeStatus = gitStatus(root);

    // (a) correct 4-way classification.
    const report = handler!({ storyId: STORY_ID, json: true }) as EvidencePlanReport;
    assert.equal(report.storyId, STORY_ID);
    assert.equal(report.mode.runCommands, false);
    assert.equal(report.mode.writeEvidence, false);
    assert.equal(report.claims.authorityDone, false);
    assert.equal(report.claims.productionDone, false);

    assert.deepEqual([...intentRefsOf(report, 'missing')], ['CHK-002:happy:0'], 'missing bucket holds the uncovered required intent');
    assert.deepEqual([...intentRefsOf(report, 'rerun')], ['CHK-001:adversarial:0'], 'rerun bucket holds the failing intent');
    assert.deepEqual([...intentRefsOf(report, 'refreshOnly')], ['CHK-001:edge:0'], 'refresh-only bucket holds the stale-pass intent');
    assert.deepEqual([...intentRefsOf(report, 'fresh')], ['CHK-001:happy:0'], 'fresh bucket holds the current-pass intent');

    assert.deepEqual(report.summary, { missing: 1, rerun: 1, refreshOnly: 1, fresh: 1 }, 'summary counts match buckets');
    assert.equal(report.buckets.missing[0].required, true, 'missing required intent is tagged required');
    assert.equal(report.buckets.rerun[0].command, 'npm test -- adversarial', 'rerun carries the recorded command');
    assert.ok(report.buckets.refreshOnly[0].driftReason, 'refresh-only carries a drift reason');

    // (c) the plan embeds the StoryReadinessReport verbatim.
    const directReport = buildStoryReadinessReport({ storyId: STORY_ID, target: 'REVIEW', store, root });
    assert.deepEqual(report.readinessReport, directReport, 'evidence_plan embeds the V1 StoryReadinessReport verbatim');

    // text render is coherent and read-only.
    const text = handler!({ storyId: STORY_ID, format: 'text' }) as string;
    assert.match(text, /Evidence plan \(B-eplan\)/);
    assert.match(text, /mode: read-only \(no commands run, no evidence written\)/);
    assert.match(text, /readinessReport: target=REVIEW/);
    assert.match(text, /summary: missing=1 rerun=1 refresh-only=1 fresh=1/);
    assert.match(text, /admissibilityStatus: read-only-evidence-plan/);
    assert.match(text, /evidenceScope: verification-planning/);

    // (b) + (d) read-only: no metadata / git mutation, no authority/evidence artifacts.
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'evidence_plan must not mutate story metadata files');
    assert.equal(gitStatus(root), beforeStatus, 'evidence_plan must leave git status unchanged');
    assertNoAuthorityOrEvidenceArtifacts(store);
    assert.equal(store.readStory(STORY_ID).phase, 'DEV', 'evidence_plan must not advance phase');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (e) flipping a fresh evidence hash reclassifies it as refresh-only ----

{
  const { root, store, ctx } = createFixture((r) => allFreshChecklist(r));
  try {
    const handler = createMainRegistry(ctx).get('evidence_plan');
    assert.ok(handler, 'registry exposes evidence_plan for reclassification test');

    const before = handler!({ storyId: STORY_ID, json: true }) as EvidencePlanReport;
    assert.equal(before.summary.fresh, 3, 'all three intents start fresh');
    assert.equal(before.summary.refreshOnly, 0, 'nothing is refresh-only before flip');

    // Flip ONE fresh evidence's hashes to a stale value. The split must follow
    // checkEvidenceFreshnessForGit, not any hard-coded bucket assignment.
    const checklist = store.readChecklist(STORY_ID);
    const item = checklist.items[0];
    const ev = item.verificationEvidence!.find((e) => e.intentRef === 'CHK-001:happy:0')!;
    ev.headHash = STALE_HEAD;
    ev.materialHash = STALE_MATERIAL;
    store.writeChecklist(STORY_ID, checklist);

    const after = handler!({ storyId: STORY_ID, json: true }) as EvidencePlanReport;
    assert.equal(after.summary.fresh, 2, 'flipped intent is no longer fresh');
    assert.equal(after.summary.refreshOnly, 1, 'flipped intent is now refresh-only');
    assert.deepEqual([...intentRefsOf(after, 'refreshOnly')], ['CHK-001:happy:0'], 'the flipped intent is the refresh-only one');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- empty-intent story: no crash, all buckets empty -----------------------

{
  const { root, store, ctx } = createFixture(() => emptyIntentChecklist());
  try {
    const handler = createMainRegistry(ctx).get('evidence_plan');
    assert.ok(handler, 'registry exposes evidence_plan for empty-intent test');
    const report = handler!({ storyId: STORY_ID, json: true }) as EvidencePlanReport;
    assert.deepEqual(report.summary, { missing: 0, rerun: 0, refreshOnly: 0, fresh: 0 }, 'empty-intent story yields empty buckets');
    const text = handler!({ storyId: STORY_ID, format: 'text' }) as string;
    assert.match(text, /summary: missing=0 rerun=0 refresh-only=0 fresh=0/);
    assertNoAuthorityOrEvidenceArtifacts(store);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- all-fresh story: every intent classified fresh ------------------------

{
  const { root, store, ctx } = createFixture((r) => allFreshChecklist(r));
  try {
    const handler = createMainRegistry(ctx).get('evidence_plan');
    assert.ok(handler, 'registry exposes evidence_plan for all-fresh test');
    const report = handler!({ storyId: STORY_ID, json: true }) as EvidencePlanReport;
    assert.equal(report.summary.fresh, 3, 'all three intents are fresh');
    assert.equal(report.summary.missing + report.summary.rerun + report.summary.refreshOnly, 0, 'no missing/rerun/refresh-only');
    assertNoAuthorityOrEvidenceArtifacts(store);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Executable rows remain covered by the original metadata/git/no-authority checks.
{
  const { root, store, ctx } = createFixture((r) => allFreshChecklist(r));
  try {
    const checklist = store.readChecklist(STORY_ID);
    checklist.items[0].verificationIntent!.happy[0].type = 'cli';
    store.writeChecklist(STORY_ID, checklist);
    const before = snapshotDir(root, store.storyDirPath(STORY_ID));
    const status = gitStatus(root);
    const handler = createMainRegistry(ctx).get('evidence_plan')!;
    const report = handler({ storyId: STORY_ID, json: true }) as EvidencePlanReport;
    assert.equal(report.fingerprints.intents.find(row => row.intentRef === 'CHK-001:happy:0')!.action, 'invalid', 'unsigned executable evidence does not inherit manual coverage');
    assert.ok(intentRefsOf(report, 'rerun').has('CHK-001:happy:0'), 'unpinned executable evidence must enter the rerun bucket');
    assert.equal(intentRefsOf(report, 'fresh').has('CHK-001:happy:0'), false, 'unpinned executable evidence never becomes fresh');
    assert.equal(report.summary.fresh, 2, 'only the two admitted manual attestations remain fresh');
    assert.deepEqual(snapshotDir(root, store.storyDirPath(STORY_ID)), before);
    assert.equal(gitStatus(root), status);
    assertNoAuthorityOrEvidenceArtifacts(store);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// Execute in this already supervised task: no extra child process or reservation boundary.
// @ts-expect-error The JavaScript test entry has no declaration file.
await import('../../tests/intent-fingerprint-reuse.test.mjs');
process.stdout.write('evidence_plan smoke passed\n');
