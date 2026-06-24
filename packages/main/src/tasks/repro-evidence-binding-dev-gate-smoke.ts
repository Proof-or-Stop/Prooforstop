#!/usr/bin/env node
/**
 * Repro evidence binding DEV gate smoke.
 *
 * Proves the lifecycle hard gate for code stories that declare
 * files.modify/create/test:
 *   - IDEA->PLAN blocks without a valid story-evidence-binding candidate.
 *   - IDEA->PLAN passes with a valid binding.
 *   - Non-code/no-file checklist stories are not blocked.
 *   - PLAN->DEV blocks missing/stale binding and passes valid binding.
 *   - INIT_CHECK->DEV express blocks missing binding and passes valid binding.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import {
  canSendStoryEventWithoutSnapshotCan,
  getGuardFailureReason,
} from '../core/machine.js';
import {
  createProbe,
  createStoryFromRepro,
  recordSpike,
  reviewProbe,
  reviewRegressionMatrix,
} from '../core/repro-intake.js';
import type { ChecklistData, StoryInfo, StoryPhase } from '../core/types.js';

const NOW = '2026-06-24T12:00:00.000Z';

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

function makeRoot(): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-repro-binding-gate-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'light' },
  }));
  resetConfigCache();
  return { root, store: new StoryStore(root) };
}

function story(storyId: string, phase: StoryPhase): StoryInfo {
  return {
    storyId,
    name: `${storyId}-smoke`,
    title: `${storyId} repro evidence binding smoke`,
    description: 'Synthetic story for repro evidence binding lifecycle gate smoke.',
    type: 'feature',
    phase,
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    events: [{ phase, action: 'advance', timestamp: NOW }],
    parallelSafe: 'no',
  };
}

const fileChecklist: ChecklistData = {
  items: [{
    id: 'CHK-001',
    title: 'Implement code fix',
    context: 'Synthetic code story declares files and therefore needs repro binding.',
    files: { modify: ['src/feature.ts'], create: [], test: ['tests/feature.test.ts'] },
    status: 'pending',
    startTime: null,
    endTime: null,
  }],
};

const noFileChecklist: ChecklistData = {
  items: [{
    id: 'CHK-001',
    title: 'Update product wording',
    context: 'Synthetic non-code story with no files declaration.',
    status: 'pending',
    startTime: null,
    endTime: null,
  }],
};

function writeStory(store: StoryStore, storyId: string, phase: StoryPhase, checklist: ChecklistData): void {
  store.writeStory(storyId, story(storyId, phase));
  store.writeChecklist(storyId, checklist);
}

async function bindAcceptedRepro(root: string, storyId: string): Promise<string> {
  const probe = createProbe(root, {
    candidateId: `cand-${storyId}`,
    taskSummary: 'Synthetic confirmed failure for repro binding gate',
    eligibility: 'Hermetic smoke candidate',
    reason: 'Gate must only allow code lifecycle progress from accepted repro evidence.',
    commandSpec: { command: 'node', args: ['failing-repro.js'] },
    expectedFailure: 'Expected synthetic target failure',
    expectedFailurePattern: 'SyntheticTargetFailure',
    executionStatus: 'confirmed_failing',
    observedFailureSummary: 'Synthetic target failure observed',
    boundedOutputExcerpt: 'SyntheticTargetFailure: observed',
    producerObservedClass: 'target-bug',
  });
  const review = reviewProbe(root, {
    probeId: probe.artifactId,
    probeDigest: probe.artifactDigest,
    verdict: 'red-reviewed',
    reviewedFailureClass: 'target-bug',
    notes: 'Reviewed as a target-bug repro for lifecycle gate smoke.',
  });
  const spike = recordSpike(root, {
    probeId: probe.artifactId,
    description: 'Optional spike included so the gate validates spike digest bindings.',
    steps: ['inspect synthetic failure'],
    observations: 'Synthetic root cause is bounded.',
    executionStatus: 'confirmed_failing',
    observedOutput: 'Synthetic spike output',
  });
  const matrixReview = reviewRegressionMatrix(root, {
    probeId: probe.artifactId,
    spikeId: spike.artifactId,
    status: 'accepted',
    notes: 'Optional matrix review included so the gate validates matrix digest bindings.',
  });
  const result = await createStoryFromRepro(root, {
    probeId: probe.artifactId,
    reviewId: review.artifactId,
    spikeId: spike.artifactId,
    matrixReviewId: matrixReview.artifactId,
    storyTitle: `${storyId} bound story`,
    storyDescription: 'Synthetic story bound to accepted repro evidence.',
  }, async () => storyId);
  return result.bindingArtifact.artifactDigest;
}

function tamperBindingObject(root: string, bindingDigest: string): void {
  const objectPath = join(root, '.lattice', 'evidence', 'objects', 'sha256', `${bindingDigest}.json`);
  const artifact = JSON.parse(readFileSync(objectPath, 'utf8')) as {
    payload: { reviewDigest: string };
  };
  artifact.payload.reviewDigest = 'sha256:stale-review-digest';
  writeFileSync(objectPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
}

async function withRoot(fn: (root: string, store: StoryStore) => Promise<void> | void): Promise<void> {
  const { root, store } = makeRoot();
  try {
    await fn(root, store);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

await check('IDEA->PLAN missing binding is blocked', async () => {
  await withRoot((root, store) => {
    const storyId = 'B-missing-plan';
    writeStory(store, storyId, 'IDEA', fileChecklist);
    assert.equal(canSendStoryEventWithoutSnapshotCan(storyId, store, 'IDEA', 'PLAN', root), false);
    assert.match(getGuardFailureReason(storyId, store, 'PLAN', root) ?? '', /missing_story_evidence_binding/);
    assert.match(getGuardFailureReason(storyId, store, 'PLAN', root) ?? '', /story_create_from_repro/);
  });
});

await check('IDEA->PLAN valid binding passes', async () => {
  await withRoot(async (root, store) => {
    const storyId = 'B-valid-plan';
    writeStory(store, storyId, 'IDEA', fileChecklist);
    await bindAcceptedRepro(root, storyId);
    assert.equal(canSendStoryEventWithoutSnapshotCan(storyId, store, 'IDEA', 'PLAN', root), true);
    assert.equal(getGuardFailureReason(storyId, store, 'PLAN', root), null);
  });
});

await check('IDEA->PLAN no-file checklist passes without binding', async () => {
  await withRoot((root, store) => {
    const storyId = 'B-no-files';
    writeStory(store, storyId, 'IDEA', noFileChecklist);
    assert.equal(canSendStoryEventWithoutSnapshotCan(storyId, store, 'IDEA', 'PLAN', root), true);
    assert.equal(getGuardFailureReason(storyId, store, 'PLAN', root), null);
  });
});

await check('PLAN->DEV missing binding is blocked', async () => {
  await withRoot((root, store) => {
    const storyId = 'B-missing-dev';
    writeStory(store, storyId, 'PLAN', fileChecklist);
    assert.equal(canSendStoryEventWithoutSnapshotCan(storyId, store, 'PLAN', 'START', root), false);
    assert.match(getGuardFailureReason(storyId, store, 'DEV', root) ?? '', /missing_story_evidence_binding/);
  });
});

await check('PLAN->DEV valid binding passes', async () => {
  await withRoot(async (root, store) => {
    const storyId = 'B-valid-dev';
    writeStory(store, storyId, 'PLAN', fileChecklist);
    await bindAcceptedRepro(root, storyId);
    assert.equal(canSendStoryEventWithoutSnapshotCan(storyId, store, 'PLAN', 'START', root), true);
    assert.equal(getGuardFailureReason(storyId, store, 'DEV', root), null);
  });
});

await check('PLAN->DEV stale binding is blocked', async () => {
  await withRoot(async (root, store) => {
    const storyId = 'B-stale-dev';
    writeStory(store, storyId, 'PLAN', fileChecklist);
    const digest = await bindAcceptedRepro(root, storyId);
    tamperBindingObject(root, digest);
    assert.equal(canSendStoryEventWithoutSnapshotCan(storyId, store, 'PLAN', 'START', root), false);
    assert.match(getGuardFailureReason(storyId, store, 'DEV', root) ?? '', /stale_story_evidence_binding/);
  });
});

await check('INIT_CHECK->DEV express missing binding is blocked', async () => {
  await withRoot((root, store) => {
    const storyId = 'B-missing-express';
    writeStory(store, storyId, 'INIT_CHECK', fileChecklist);
    assert.equal(canSendStoryEventWithoutSnapshotCan(storyId, store, 'INIT_CHECK', 'START', root), false);
    assert.match(getGuardFailureReason(storyId, store, 'DEV', root) ?? '', /missing_story_evidence_binding/);
  });
});

await check('INIT_CHECK->DEV express valid binding passes', async () => {
  await withRoot(async (root, store) => {
    const storyId = 'B-valid-express';
    writeStory(store, storyId, 'INIT_CHECK', fileChecklist);
    await bindAcceptedRepro(root, storyId);
    assert.equal(canSendStoryEventWithoutSnapshotCan(storyId, store, 'INIT_CHECK', 'START', root), true);
    assert.equal(getGuardFailureReason(storyId, store, 'DEV', root), null);
  });
});

process.stdout.write('\nrepro evidence binding dev gate smoke passed\n');
