#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resetConfigCache } from '../core/config.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { buildDoneChecklist } from '../core/done-oracle.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash, EMPTY_STORY_FILES_HASH } from '../core/evidence-freshness.js';
import { buildStoryReadinessReport } from '../core/lifecycle-readiness.js';
import { StoryStore } from '../core/store.js';
import type {
  ChecklistData,
  ClosingSelfCheck,
  DeliveryCheckData,
  DocsPromise,
  RealMachineTest,
  StoryInfo,
  TestEvidenceData,
} from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { createDonePrepareHandlers } from '../handlers/done-prepare.js';
import { createReviewEscalationHandlers } from '../handlers/review-escalation.js';
import { buildNextSteps } from '../handlers/transition-effects.js';

const STORY_ID = 'B-review-assurance-surfacing';
const NOW = '2026-07-09T12:00:00.000Z';

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'review-assurance-surfacing-smoke',
      GIT_AUTHOR_EMAIL: 'review-assurance-surfacing-smoke@example.test',
      GIT_COMMITTER_NAME: 'review-assurance-surfacing-smoke',
      GIT_COMMITTER_EMAIL: 'review-assurance-surfacing-smoke@example.test',
    },
  }).trim();
}

function commitAll(root: string, message: string): void {
  git(root, ['add', '.']);
  git(root, ['commit', '-m', message]);
}

function context(root: string): HandlerContext {
  resetConfigCache();
  return {
    root,
    scanRoot: root,
    store: new StoryStore(root),
  };
}

function seedDoneEvidence(root: string, storyId: string, store: StoryStore): void {
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root, 'HEAD', root);
  const rawStoryFilesHash = currentStoryFilesHash(root, 'HEAD', root);
  const storyFilesHash = rawStoryFilesHash && rawStoryFilesHash !== EMPTY_STORY_FILES_HASH
    ? rawStoryFilesHash
    : undefined;
  assert.ok(headHash, 'fixture must have a git HEAD');
  assert.ok(materialHash, 'fixture must have a material hash');

  const testEvidence: TestEvidenceData = {
    command: 'review assurance surfacing smoke validation',
    output: JSON.stringify({ allPass: true, summary: 'synthetic validation passed' }),
    result: 'PASS',
    timestamp: NOW,
    headHash,
    materialHash,
    ...(rawStoryFilesHash ? { storyFilesHash: rawStoryFilesHash } : {}),
  };
  store.writeTestEvidence(storyId, testEvidence);

  const docsPromises: DocsPromise[] = [];
  const realMachineTests: RealMachineTest[] = [{
    featureId: 'review-assurance-surfacing',
    transcript: 'Synthetic fixture proves review-assurance guidance is surfaced before DONE closeout.',
  }];
  const closingSelfCheck: ClosingSelfCheck = {
    hasRealMachineTest: true,
    hasEdgeCaseCoverage: true,
    hasUnresolvedTodos: false,
    summary: 'Synthetic delivery check covers review-assurance surfacing.',
  };
  const deliveryCheck: DeliveryCheckData = {
    storyId,
    checkedAt: NOW,
    headHash,
    materialHash,
    ...(storyFilesHash ? { storyFilesHash } : {}),
    reviewRound: NOW,
    agentId: 'lattice-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, NOW, materialHash, storyFilesHash),
  };
  store.writeDeliveryCheck(storyId, deliveryCheck);
}

function setupFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'lattice-review-assurance-surfacing-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: '.',
    rootDir: '.',
    testsDir: 'tests',
    fixturesDir: 'tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'light' },
    staleThresholds: {
      phaseStale: 10_000_000,
      itemStale: 10_000_000,
      idleLattice: 10_000_000,
      bugStale: 10_000_000,
    },
  }, null, 2) + '\n');
  write(root, '.gitignore', [
    '.lattice/activity.jsonl',
    '.lattice/learning/runtime-memory-pack-cache/',
    '.lattice/locks/',
    '',
  ].join('\n'));
  write(root, 'README.md', '# review assurance surfacing fixture\n');
  write(root, 'packages/main/src/core/done-oracle.ts', 'export const before = true;\n');

  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  commitAll(root, 'seed review assurance surfacing fixture');
  git(root, ['checkout', '-B', `story/${STORY_ID}`]);
  write(root, 'packages/main/src/core/done-oracle.ts', 'export const before = true;\nexport const highRiskChange = true;\n');
  commitAll(root, 'high risk lifecycle code change');

  resetConfigCache();
  const store = new StoryStore(root);
  store.writeStory(STORY_ID, {
    storyId: STORY_ID,
    name: 'review-assurance-surfacing',
    title: 'Review assurance surfacing smoke',
    description: 'Synthetic TEST story for review-assurance blocker guidance.',
    type: 'feature',
    phase: 'TEST',
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    currentReviewRound: NOW,
    riskSignals: [],
    worktree: {
      path: root,
      branch: `story/${STORY_ID}`,
      createdAt: NOW,
    },
    events: [
      { phase: 'DEV', action: 'advance', timestamp: '2026-07-09T11:00:00.000Z' },
      { phase: 'REVIEW', action: 'advance', timestamp: NOW },
      { phase: 'TEST', action: 'advance', timestamp: NOW },
    ],
  } as StoryInfo);
  store.writeChecklist(STORY_ID, {
    items: [{
      id: 'CHK-001',
      title: 'High-risk code change',
      context: 'Synthetic done item for review-assurance surfacing coverage.',
      status: 'done',
      startTime: NOW,
      endTime: NOW,
    }],
  } as ChecklistData);
  seedDoneEvidence(root, STORY_ID, store);
  commitAll(root, 'seed review assurance story evidence');
  assert.equal(git(root, ['status', '--porcelain']), '', 'fixture must start clean');
  return root;
}

function assertGuidanceText(text: string): void {
  assert.match(text, /review_assurance_floor_high_risk_3x2_or_fallback_missing/);
  assert.match(text, /currentBinding: storyId=B-review-assurance-surfacing materialHash=[a-f0-9]{64} storyFilesHash=/);
  assert.match(text, /fallbackEligibility: eligible reasonCode=fallback_eligible_high_risk_review_assurance_floor/);
  assert.match(text, /autopilot_review_submit/);
  assert.match(text, /quorum_submit/);
  assert.match(text, /review_escalation_fallback_set/);
  assert.match(text, /will not auto-write reviewer evidence, host verdicts, delivery checks, or degraded fallback evidence/);
}

async function main(): Promise<void> {
  const root = setupFixture();
  const originalCwd = process.cwd();
  try {
    const ctx = context(root);

    const doneRows = buildDoneChecklist(STORY_ID, ctx.store, root, { gitCwd: root, auditWriter: null });
    const floorRow = doneRows.find((row) => row.id === 'review-assurance-floor');
    assert.equal(floorRow?.status, 'fail');
    assert.equal(floorRow?.blocking, true);
    assert.match(floorRow?.detail ?? '', /reasonCode=review_assurance_floor_high_risk_3x2_or_fallback_missing/);
    assert.match(floorRow?.detail ?? '', /fallback=eligible\/fallback_eligible_high_risk_review_assurance_floor/);

    const readiness = buildStoryReadinessReport({ storyId: STORY_ID, target: 'DONE', store: ctx.store, root, gitCwd: root });
    const readinessRow = readiness.readiness.find((row) => row.id === 'done.review-assurance-floor');
    assert.equal(readinessRow?.blocking, true);
    assert.equal(readinessRow?.nextCommand, `lattice review_escalation_status '{"storyId":"${STORY_ID}"}'`);
    assert.match(readinessRow?.reason ?? '', /reasonCode=review_assurance_floor_high_risk_3x2_or_fallback_missing/);

    const reviewText = createReviewEscalationHandlers(ctx).review_escalation_status({ storyId: STORY_ID }) as string;
    assertGuidanceText(reviewText);
    const reviewJson = createReviewEscalationHandlers(ctx).review_escalation_status({ storyId: STORY_ID, json: true }) as {
      reviewAssuranceGuidance?: Array<{ reasonCode: string; fallback: { status: string } }>;
    };
    assert.equal(
      reviewJson.reviewAssuranceGuidance?.some((guidance) =>
        guidance.reasonCode === 'review_assurance_floor_high_risk_3x2_or_fallback_missing'
        && guidance.fallback.status === 'eligible',
      ),
      true,
    );

    const testGuidance = buildNextSteps(ctx.store, root, STORY_ID).TEST;
    assert.match(testGuidance, /Review assurance before DONE \(advisory only; TEST is not blocked by this advisory\)/);
    assertGuidanceText(testGuidance);

    process.chdir(root);
    const beforeStatus = git(root, ['status', '--porcelain']);
    const prepare = await createDonePrepareHandlers(ctx).done_prepare({
      storyId: STORY_ID,
      dryRun: true,
      validate: false,
      mergeMain: false,
      refreshStale: false,
    }) as string;
    const afterStatus = git(root, ['status', '--porcelain']);
    assert.equal(afterStatus, beforeStatus, 'done_prepare --dryRun review-assurance block must not mutate git state');
    assert.match(prepare, /DONE prepare: BLOCKED/);
    assert.match(prepare, /Review assurance blocker classification:/);
    assert.match(prepare, /owner-runnable commands:/);
    assert.match(prepare, /reviewer\/host writer paths \(do not run from owner\/main session\):/);
    assert.match(prepare, /human-approved fallback writer paths \(only when eligible\):/);
    assert.match(prepare, /commands:\n  - lattice review_escalation_status/);
    const machineCommandBlock = prepare.match(/\ncommands:\n([\s\S]*?)\n\n/)?.[1] ?? '';
    assert.doesNotMatch(machineCommandBlock, /quorum_submit/);
    assert.doesNotMatch(machineCommandBlock, /autopilot_review_submit/);
    assert.doesNotMatch(machineCommandBlock, /review_escalation_fallback_set/);
    assertGuidanceText(prepare);

    const jsonPrepare = await createDonePrepareHandlers(ctx).done_prepare({
      storyId: STORY_ID,
      dryRun: true,
      validate: false,
      mergeMain: false,
      refreshStale: false,
      json: true,
    }) as { schemaVersion: string; status: string; transcript: string };
    assert.equal(jsonPrepare.schemaVersion, 'lattice.done_prepare.v1');
    assert.equal(jsonPrepare.status, 'blocked');
    assertGuidanceText(jsonPrepare.transcript);

    console.log('review-assurance-surfacing smoke passed');
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
