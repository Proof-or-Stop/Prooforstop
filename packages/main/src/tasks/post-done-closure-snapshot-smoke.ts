#!/usr/bin/env node

/**
 * @task B-b531
 * @checklist CHK-001
 * @title Fix post-DONE closure snapshot material projection
 * @type bugfix
 * @priority high
 * @description
 *   Regression smoke for post-DONE read-only closure/status projections:
 *   completed stories are evaluated against their DONE snapshot, while
 *   unfinished TEST stories keep strict current-material gates.
 * @changes
 *   - [CHK-001] Cover historical DONE closure projection after material drift.
 *   - [CHK-001] Cover review escalation status using the completed snapshot.
 *   - [CHK-001] Cover strict TEST-phase stale evidence behavior.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { runDoneRequiredValidation } from '../core/done-required-validation.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { StoryStore } from '../core/store.js';
import type { ClosingSelfCheck, DocsPromise, ProcessEvent, RealMachineTest, StoryInfo } from '../core/types.js';
import { buildDoneClosureRunbook } from '../handlers/done-closure.js';
import { createReviewEscalationHandlers } from '../handlers/review-escalation.js';
import type { HandlerContext } from '../handlers/context.js';

const STORY_ID = 'B-postdone';
const NOW = '2026-06-29T19:30:00.000Z';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'post-done-closure-smoke',
      GIT_AUTHOR_EMAIL: 'post-done-closure-smoke@example.invalid',
      GIT_COMMITTER_NAME: 'post-done-closure-smoke',
      GIT_COMMITTER_EMAIL: 'post-done-closure-smoke@example.invalid',
    },
  }).trim();
}

function writeConfig(root: string): void {
  writeFileSync(
    join(root, 'lattice.config.json'),
    JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      doneRequiredCommands: [
        { label: 'required pass', command: process.execPath, args: ['-e', 'process.exit(0)'] },
      ],
    }, null, 2) + '\n',
  );
  resetConfigCache();
}

async function createDoneReadyFixture(): Promise<{
  root: string;
  store: StoryStore;
  ctx: HandlerContext;
  materialHash: string;
  storyFilesHash: string | null;
}> {
  const root = mkdtempSync(join(tmpdir(), 'post-done-closure-snapshot-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  mkdirSync(join(root, 'docs/requirements'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, '.gitignore'), '.lattice/\n', 'utf8');
  writeFileSync(join(root, 'README.md'), '# post done closure snapshot smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 1;\n', 'utf8');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.gitignore', 'README.md', 'lattice.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);

  const store = new StoryStore(root);
  const story: StoryInfo = {
    storyId: STORY_ID,
    name: 'post-done-closure-snapshot-smoke',
    title: 'Post DONE closure snapshot smoke',
    description: 'Synthetic DONE story for closure snapshot projection.',
    type: 'bug',
    phase: 'TEST',
    priority: 'high',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  };
  store.writeStory(STORY_ID, story);
  store.writeChecklist(STORY_ID, {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic completed item',
      context: 'Synthetic completed context',
      status: 'done',
      startTime: NOW,
      endTime: NOW,
      verificationIntent: {
        happy: [{ desc: 'DONE closure remains stable after drift', type: 'logic', priority: 'must' }],
        edge: [{ desc: 'TEST remains strict under stale evidence', type: 'logic', priority: 'must' }],
        adversarial: [{ desc: 'Unfinished story cannot hide stale evidence', type: 'logic', priority: 'must' }],
      },
      verificationEvidence: [{
        intentRef: 'CHK-001:happy:0',
        kind: 'logic_test',
        result: 'pass',
        note: 'synthetic proof for post-DONE closure snapshot smoke',
      }],
    }],
  });

  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root, 'HEAD', root);
  const storyFilesHash = currentStoryFilesHash(root, 'HEAD', root);
  assert.ok(headHash, 'fixture HEAD is available');
  assert.ok(materialHash, 'fixture material hash is available');
  store.writeTestEvidence(STORY_ID, {
    command: 'post-done-closure-snapshot-smoke',
    output: JSON.stringify({ allPass: true, summary: 'post-DONE closure snapshot smoke fixture passed' }),
    result: 'PASS',
    timestamp: NOW,
    headHash,
    materialHash,
    ...(storyFilesHash ? { storyFilesHash } : {}),
    verificationCoverage: {
      total: 3,
      required: 3,
      covered: 3,
      missingRequired: 0,
      entries: [],
    },
  });
  store.writeBugs(STORY_ID, { bugs: [] });

  const docsPromises: DocsPromise[] = [];
  const realMachineTests: RealMachineTest[] = [{
    featureId: 'CHK-001',
    transcript: 'Synthetic closure snapshot smoke has real-machine-style coverage.',
  }];
  const closingSelfCheck: ClosingSelfCheck = {
    hasRealMachineTest: true,
    hasEdgeCaseCoverage: true,
    hasUnresolvedTodos: false,
    summary: 'Synthetic closure snapshot evidence is complete.',
  };
  store.writeDeliveryCheck(STORY_ID, {
    storyId: STORY_ID,
    checkedAt: NOW,
    headHash,
    materialHash,
    reviewRound: '',
    agentId: 'lattice-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    ...(storyFilesHash ? { storyFilesHash } : {}),
    _hash: signDeliveryCheck(STORY_ID, docsPromises, realMachineTests, closingSelfCheck, '', materialHash, storyFilesHash ?? undefined),
  });
  store.writeSummary(STORY_ID, {
    storyId: STORY_ID,
    createdAt: NOW,
    updatedAt: NOW,
    changes: 'Synthetic post-DONE closure snapshot fixture changes.',
    usage: 'Run done_closure and review_escalation_status against the synthetic story.',
    expectedOutcome: 'Historical DONE status remains stable after current material drift.',
    actualTranscript: 'Synthetic fixture records a stable historical DONE snapshot.',
    outcomeDiff: 'No difference.',
    acceptanceVerdict: 'accepted',
    outcomeKind: 'success',
    realMachineCoverage: { ran: [], skipped: [] },
    limitations: 'Synthetic smoke fixture only.',
    pitfalls: 'Do not use current-material revalidation as the default DONE history projection.',
  });
  await runDoneRequiredValidation({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });

  const policyEvent: Omit<ProcessEvent, 'timestamp'> = {
    type: 'review_escalation_policy',
    storyId: STORY_ID,
    command: 'review_escalation_policy_set',
    policyId: `${STORY_ID}:POL-1`,
    predicate: 'explicitlyConfiguredHighRiskPolicyRequires3x2',
    requires3x2: true,
    policyVersion: 'v1',
    riskClass: 'high',
    sourcePolicyRef: 'post-done-closure-snapshot-smoke',
    rolloutStage: 'ga',
    degradedFallbackAllowed: false,
    issuer: 'smoke',
    issuedAt: NOW,
    headHash,
    materialHash,
  };
  store.appendProcessEvent(STORY_ID, policyEvent);

  for (const runId of ['round-1', 'round-2', 'round-3']) {
    for (const host of ['codex', 'claude']) {
      store.appendProcessEvent(STORY_ID, {
        type: 'host_verdict',
        verdictId: `${runId}-${host}`,
        runId,
        hostId: `${host}-${runId}`,
        provider: host,
        sessionId: `${host}-${runId}-session`,
        keyId: `${host}-${runId}-key`,
        decision: 'pass',
        materialDigest: materialHash,
        ...(storyFilesHash ? { storyFilesHash } : {}),
        validationDigest: `${runId}-validation`,
        promptDigest: `${runId}-prompt`,
      });
    }
  }

  return {
    root,
    store,
    ctx: { store, root, scanRoot: join(root, 'packages/main') },
    materialHash,
    storyFilesHash: storyFilesHash ?? null,
  };
}

function blockingIds(runbook: ReturnType<typeof buildDoneClosureRunbook>): string[] {
  return runbook.blockers
    .filter((row) => row.blocking && row.status === 'fail')
    .map((row) => row.id)
    .sort();
}

{
  const { root, store, ctx, materialHash, storyFilesHash } = await createDoneReadyFixture();
  try {
    const readyRunbook = buildDoneClosureRunbook(ctx, STORY_ID);
    assert.equal(readyRunbook.phase, 'TEST');
    assert.equal(readyRunbook.canAttemptDone, true, 'TEST fixture starts DONE-ready');
    assert.deepEqual(blockingIds(readyRunbook), [], 'TEST fixture has no blockers before drift');

    const doneStory = store.readStory(STORY_ID);
    doneStory.phase = 'DONE';
    doneStory.endedAt = NOW;
    doneStory.events = [...(doneStory.events ?? []), { phase: 'DONE', action: 'advance', timestamp: NOW }];
    store.writeStory(STORY_ID, doneStory);

    writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 2;\n', 'utf8');
    git(root, ['add', 'packages/main/src/index.ts']);
    git(root, ['commit', '-m', 'unrelated material drift after done']);
    assert.notEqual(currentMaterialHash(root, 'HEAD', root), materialHash, 'material drift changes current material hash');

    const doneRunbook = buildDoneClosureRunbook(ctx, STORY_ID);
    assert.equal(doneRunbook.phase, 'DONE');
    assert.equal(doneRunbook.historicalSnapshot?.materialHash, materialHash);
    assert.equal(doneRunbook.historicalSnapshot?.storyFilesHash ?? null, storyFilesHash);
    assert.equal(doneRunbook.localAssurance.admissibilityStatus, 'local-admissible');
    assert.deepEqual(blockingIds(doneRunbook), [], 'DONE historical projection must not reopen stale current-material blockers');
    assert.equal(doneRunbook.blockers.find((row) => row.id === 'delivery-check')?.status, 'warn');
    assert.equal(doneRunbook.blockers.find((row) => row.id === 'done-required-validation')?.status, 'warn');
    assert.equal(doneRunbook.blockers.find((row) => row.id === 'review-escalation')?.status, 'pass');

    const reviewStatus = createReviewEscalationHandlers(ctx).review_escalation_status({ storyId: STORY_ID, json: true }) as {
      ok: boolean;
      materialHash: string | null;
      advisories?: string[];
    };
    assert.equal(reviewStatus.ok, true, 'DONE review_escalation_status uses the historical snapshot');
    assert.equal(reviewStatus.materialHash, materialHash);
    assert.ok(
      reviewStatus.advisories?.some((entry) => entry.includes('DONE historical snapshot')),
      'review status labels historical snapshot projection',
    );

    const unfinished = store.readStory(STORY_ID);
    unfinished.phase = 'TEST';
    unfinished.endedAt = null;
    store.writeStory(STORY_ID, unfinished);
    const strictRunbook = buildDoneClosureRunbook(ctx, STORY_ID);
    assert.equal(strictRunbook.phase, 'TEST');
    assert.ok(
      blockingIds(strictRunbook).some((id) => id === 'delivery-check' || id === 'done-required-validation'),
      'TEST phase remains strict under stale current-material evidence',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

process.stdout.write('post-done-closure-snapshot smoke passed\n');
