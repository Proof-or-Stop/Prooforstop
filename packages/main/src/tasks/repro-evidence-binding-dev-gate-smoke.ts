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
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resetConfigCache } from '../core/config.js';
import { computeDraftCheckHash } from '../core/draft-check-hash.js';
import { writeArtifact } from '../core/evidence/artifact-store.js';
import { StoryStore } from '../core/store.js';
import {
  canSendStoryEventWithoutSnapshotCan,
  getGuardFailureReason,
} from '../core/machine.js';
import {
  evaluateStoryEvidenceBindingGate,
  type ReproFirstPreflightMode,
} from '../core/repro-evidence-binding-gate.js';
import {
  createProbe,
  createStoryFromRepro,
  recordSpike,
  reviewProbe,
  reviewRegressionMatrix,
} from '../core/repro-intake.js';
import type { ChecklistData, StoryInfo, StoryPhase } from '../core/types.js';
import { computeChecklistHash } from '../handlers/init-check.js';
import { createReproIntakeHandlers } from '../handlers/repro-intake.js';
import { createSessionHandlers } from '../handlers/session.js';
import { createStoryCreateHandlers } from '../handlers/story-create.js';

const NOW = '2026-06-24T12:00:00.000Z';

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

function makeRoot(mode: ReproFirstPreflightMode = 'enforce'): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-repro-binding-gate-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    reproFirstPreflight: { mode },
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

function writeDraft(root: string, draftName: string, checklist: ChecklistData, overrides: Partial<StoryInfo> = {}): void {
  const draftDir = join(root, 'docs', 'story', 'drafts', draftName);
  mkdirSync(draftDir, { recursive: true });
  const index = {
    name: draftName,
    title: overrides.title ?? `${draftName} draft story`,
    description: overrides.description ?? 'Synthetic draft for repro-first fromDraft preflight smoke.',
    type: overrides.type ?? 'feature',
    priority: overrides.priority ?? 'medium',
    ...(overrides.keywords ? { keywords: overrides.keywords } : {}),
  };
  writeFileSync(join(draftDir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
  writeFileSync(join(draftDir, 'background.md'), validBackground + '\n', 'utf8');
  writeFileSync(join(draftDir, 'checklist.json'), JSON.stringify(checklist, null, 2) + '\n', 'utf8');
  const backgroundHash = createHash('sha256').update(validBackground + '\n').digest('hex');
  const checklistHash = computeChecklistHash(checklist.items.map(item => ({
    title: item.title,
    context: item.context ?? '',
  })));
  const draftCheck = {
    draftName,
    checkedAt: NOW,
    reviewRound: '',
    agentId: 'repro-binding-smoke',
    issues: [],
    _hash: computeDraftCheckHash(draftName, backgroundHash, index.title, index.description, checklistHash, ''),
  };
  writeFileSync(join(draftDir, 'draft-check.json'), JSON.stringify(draftCheck, null, 2) + '\n', 'utf8');
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

async function withRoot(fn: (root: string, store: StoryStore) => Promise<void> | void, mode: ReproFirstPreflightMode = 'enforce'): Promise<void> {
  const { root, store } = makeRoot(mode);
  try {
    await fn(root, store);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

const validBackground = [
  '## Trigger Event',
  '2026-06-24 B-1731 smoke needs a complete trigger event section to exercise story_create preflight without relying on a shortened fixture.',
  '## Key Insights',
  'Code-changing stories that declare files need an accepted repro binding before moving into lifecycle execution, while warn mode remains a rollout diagnostic.',
  '## Solution Tradeoffs',
  'The smoke uses the real story_create handler for preflight and the real repro intake handler for binding, keeping the test close to production command behavior.',
  '## Conversational Texture',
  'A maintainer sees a clear missing binding warning or block, then uses story_create_from_repro to bind candidate evidence before normal development begins.',
].join('\n\n');

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

await check('lifecycle repro-first gates respect warn mode as diagnostic-only', async () => {
  await withRoot((root, store) => {
    const planStory = 'B-warn-plan';
    writeStory(store, planStory, 'IDEA', fileChecklist);
    assert.equal(canSendStoryEventWithoutSnapshotCan(planStory, store, 'IDEA', 'PLAN', root), true);
    assert.equal(getGuardFailureReason(planStory, store, 'PLAN', root), null);

    const devStory = 'B-warn-dev';
    writeStory(store, devStory, 'PLAN', fileChecklist);
    assert.equal(canSendStoryEventWithoutSnapshotCan(devStory, store, 'PLAN', 'START', root), true);
    assert.equal(getGuardFailureReason(devStory, store, 'DEV', root), null);

    const expressStory = 'B-warn-express';
    writeStory(store, expressStory, 'INIT_CHECK', fileChecklist);
    assert.equal(canSendStoryEventWithoutSnapshotCan(expressStory, store, 'INIT_CHECK', 'START', root), true);
    assert.equal(getGuardFailureReason(expressStory, store, 'DEV', root), null);
  }, 'warn');
});

await check('lifecycle repro-first gates respect off mode as disabled', async () => {
  await withRoot((root, store) => {
    const storyId = 'B-off-plan';
    writeStory(store, storyId, 'IDEA', fileChecklist);
    const result = evaluateStoryEvidenceBindingGate(root, store, storyId);
    assert.equal(result.mode, 'off');
    assert.equal(result.required, false);
    assert.equal(canSendStoryEventWithoutSnapshotCan(storyId, store, 'IDEA', 'PLAN', root), true);
    assert.equal(getGuardFailureReason(storyId, store, 'PLAN', root), null);
  }, 'off');
});

await check('engine errors fail open and surface in session_brief', async () => {
  await withRoot((root, store) => {
    const storyId = 'B-engine-error';
    writeStory(store, storyId, 'PLAN', fileChecklist);
    write(root, '.lattice/evidence/refs/by-id', 'not a directory');
    const result = evaluateStoryEvidenceBindingGate(root, store, storyId);
    assert.equal(result.reasonCode, 'repro_first_preflight_engine_error');
    assert.equal(result.ok, true);
    assert.equal(result.blocking, false);
    assert.match(result.details.join('\n'), /repro_first_preflight_engine_error/);

    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'smoke@example.invalid'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Smoke Test'], { cwd: root, stdio: 'ignore' });
    write(root, '.gitkeep', 'init\n');
    execFileSync('git', ['add', '.gitkeep'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['checkout', '-b', `story/${storyId}`], { cwd: root, stdio: 'ignore' });
    const brief = createSessionHandlers({ root, store, scanRoot: join(root, 'packages/main') }).session_brief({ concise: false });
    assert.match(brief, /## Repro-first intake/);
    assert.match(brief, /reproFirst: engine-error; mode=enforce/);
  });
});

await check('story_create enforce blocks file-declaring story without binding before persistence', async () => {
  await withRoot((root, store) => {
    const handlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });
    assert.throws(
      () => handlers.story_create({
        name: 'preflight-enforce-block',
        title: 'Preflight enforce block',
        description: 'Exercise repro-first preflight on story_create with declared files.',
        type: 'feature',
        priority: 'medium',
        background: validBackground,
        checklist: [{
          title: 'Modify code',
          context: 'Declares files so repro-first preflight must require accepted evidence.',
          files: { modify: ['src/feature.ts'], test: ['tests/feature.test.ts'] },
        }],
      }),
      /missing_story_evidence_binding/,
    );
    assert.deepEqual(store.listStoryIds(), [], 'blocked story_create must not persist story metadata');
  });
});

await check('story_create enforce blocks bug-story classifier without binding before persistence', async () => {
  await withRoot((root, store) => {
    const handlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });
    assert.throws(
      () => handlers.story_create({
        name: 'bug-preflight-enforce-block',
        title: 'Bug preflight enforce block',
        description: 'Exercise repro-first preflight on bug story intake without declared files.',
        type: 'bug',
        priority: 'medium',
        background: validBackground,
      }),
      /classifier: bug_story/,
    );
    assert.deepEqual(store.listStoryIds(), [], 'blocked bug story_create must not persist story metadata');
  });
});

await check('story_create enforce blocks high-risk code-verifiable classifier without binding before persistence', async () => {
  await withRoot((root, store) => {
    const handlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });
    assert.throws(
      () => handlers.story_create({
        name: 'high-risk-preflight-enforce-block',
        title: 'High-risk preflight enforce block',
        description: 'Change state machine gate behavior for a synthetic lifecycle guard.',
        type: 'feature',
        priority: 'medium',
        background: validBackground,
      }),
      /classifier: high_risk_code_verifiable/,
    );
    assert.deepEqual(store.listStoryIds(), [], 'blocked high-risk story_create must not persist story metadata');
  });
});

await check('story_create fromDraft enforce blocks before story persistence or draft deletion', async () => {
  await withRoot((root, store) => {
    const draftName = 'draft-preflight-enforce-block';
    writeDraft(root, draftName, fileChecklist);
    const handlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });
    assert.throws(
      () => handlers.story_create({ fromDraft: draftName } as any),
      /missing_story_evidence_binding/,
    );
    assert.deepEqual(store.listStoryIds(), [], 'blocked fromDraft must not persist story metadata');
    assert.equal(existsSync(join(root, 'docs', 'story', 'drafts', draftName, 'index.json')), true, 'blocked fromDraft must not delete source draft');
  });
});

await check('story_create fromDraft warn mode diagnoses missing binding but does not block', async () => {
  await withRoot((root, store) => {
    const draftName = 'draft-preflight-warn';
    writeDraft(root, draftName, fileChecklist);
    const handlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });
    const output = handlers.story_create({ fromDraft: draftName } as any);
    const storyId = output.match(/B-[a-z0-9]+/i)?.[0];
    assert.ok(storyId, 'warn-mode fromDraft should create a story id');
    assert.equal(existsSync(join(root, 'docs', 'story', 'drafts', draftName, 'index.json')), false, 'successful warn-mode fromDraft should delete source draft');
    const result = evaluateStoryEvidenceBindingGate(root, store, storyId);
    assert.equal(result.mode, 'warn');
    assert.equal(result.required, true);
    assert.equal(result.blocking, false);
    assert.equal(result.reasonCode, 'missing_story_evidence_binding');
  }, 'warn');
});

await check('story_create fromDraft supports explicit repro-first bypass reason', async () => {
  await withRoot((root, store) => {
    const draftName = 'draft-preflight-bypass';
    writeDraft(root, draftName, fileChecklist);
    const handlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });
    const output = handlers.story_create({
      fromDraft: draftName,
      reproFirstBypassReason: 'Emergency non-reproducible intake accepted by human operator for this smoke.',
    } as any);
    const storyId = output.match(/B-[a-z0-9]+/i)?.[0];
    assert.ok(storyId, 'bypassed fromDraft should create a story id');
    assert.equal(store.listStoryIds().length, 1, 'bypassed fromDraft should persist exactly one story');
    assert.equal(existsSync(join(root, 'docs', 'story', 'drafts', draftName, 'index.json')), false, 'successful fromDraft should delete source draft');
    const gate = evaluateStoryEvidenceBindingGate(root, store, storyId);
    assert.equal(gate.required, true);
    assert.equal(gate.blocking, true, 'bypass only permits intake; lifecycle gates still require binding');
  });
});

await check('story_create warn mode diagnoses missing binding but does not block creation', async () => {
  await withRoot((root, store) => {
    const handlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });
    const output = handlers.story_create({
      name: 'preflight-warn',
      title: 'Preflight warn',
      description: 'Exercise repro-first warn mode on a file-declaring story.',
      type: 'feature',
      priority: 'medium',
      background: validBackground,
      checklist: [{
        title: 'Modify code',
        context: 'Declares files so warn mode should surface but not block.',
        files: { modify: ['src/feature.ts'] },
      }],
    });
    const storyId = output.match(/B-[a-z0-9]+/i)?.[0];
    assert.ok(storyId, 'warn mode story_create should return a story id');
    const result = evaluateStoryEvidenceBindingGate(root, store, storyId);
    assert.equal(result.required, true);
    assert.equal(result.blocking, false);
    assert.equal(result.reasonCode, 'missing_story_evidence_binding');
  }, 'warn');
});

await check('story_create mode off bypasses repro-first diagnostic', async () => {
  await withRoot((root, store) => {
    const handlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });
    const output = handlers.story_create({
      name: 'preflight-off',
      title: 'Preflight off',
      description: 'Exercise repro-first disabled mode on a file-declaring story.',
      type: 'feature',
      priority: 'medium',
      background: validBackground,
      checklist: [{
        title: 'Modify code',
        context: 'Declares files but project config disables the repro-first preflight.',
        files: { modify: ['src/feature.ts'] },
      }],
    });
    const storyId = output.match(/B-[a-z0-9]+/i)?.[0];
    assert.ok(storyId, 'off mode story_create should return a story id');
    const result = evaluateStoryEvidenceBindingGate(root, store, storyId);
    assert.equal(result.required, false);
    assert.equal(result.mode, 'off');
  }, 'off');
});

await check('story_create_from_repro handler creates story and binding under enforce mode', async () => {
  await withRoot(async (root, store) => {
    const probe = createProbe(root, {
      candidateId: 'cand-handler-bound',
      taskSummary: 'Handler creates story from accepted repro',
      eligibility: 'Hermetic smoke candidate',
      reason: 'The handler path must pass background validation and write binding.',
      commandSpec: { command: 'node', args: ['handler-repro.js'] },
      expectedFailure: 'Expected handler target failure',
      expectedFailurePattern: 'HandlerTargetFailure',
      executionStatus: 'confirmed_failing',
      observedFailureSummary: 'Handler target failure observed',
      boundedOutputExcerpt: 'HandlerTargetFailure: observed',
      producerObservedClass: 'target-bug',
    });
    const review = reviewProbe(root, {
      probeId: probe.artifactId,
      probeDigest: probe.artifactDigest,
      verdict: 'red-reviewed',
      reviewedFailureClass: 'target-bug',
      notes: 'Reviewed as target-bug for handler smoke.',
    });
    const handlers = createReproIntakeHandlers({ root, store, scanRoot: join(root, 'packages/main') });
    const result = await handlers.story_create_from_repro({
      probeId: probe.artifactId,
      reviewId: review.artifactId,
      storyTitle: 'Handler bound story',
      storyDescription: 'Create a story from accepted handler-level repro evidence.',
    });
    const story = store.readStory(result.storyId);
    assert.equal(story.phase, 'INIT');
    assert.equal(result.hasVerificationEvidence, false);
    assert.match(result.bindingArtifactId, /^seb-/);
    assert.match(result.bindingArtifactDigest, /^[a-f0-9]{64}$/);
    const gate = evaluateStoryEvidenceBindingGate(root, store, result.storyId);
    assert.equal(gate.ok, true);
  });
});

await check('gate rejects binding whose repro review is not an accepted target bug', async () => {
  await withRoot((root, store) => {
    const storyId = 'B-unaccepted-review';
    writeStory(store, storyId, 'PLAN', fileChecklist);
    const probe = createProbe(root, {
      candidateId: 'cand-unaccepted-review',
      taskSummary: 'Unaccepted review reason code smoke',
      eligibility: 'Hermetic smoke candidate',
      reason: 'Gate must reject arbitrary story-evidence-binding metadata when review is not accepted.',
      commandSpec: { command: 'node', args: ['unaccepted-review.js'] },
      expectedFailure: 'Expected target failure',
      expectedFailurePattern: 'UnacceptedReviewFailure',
      executionStatus: 'confirmed_failing',
      observedFailureSummary: 'Observed failure still requires reviewer acceptance.',
      boundedOutputExcerpt: 'UnacceptedReviewFailure: observed',
      producerObservedClass: 'target-bug',
    });
    const review = reviewProbe(root, {
      probeId: probe.artifactId,
      probeDigest: probe.artifactDigest,
      verdict: 'needs-spike',
      reviewedFailureClass: 'bootstrap-noise',
      notes: 'Not accepted as a target bug; gate should reject this binding.',
    });
    writeArtifact(root, {
      artifactKind: 'story-evidence-binding',
      evidenceScope: 'evidence-candidate',
      subjectBinding: { candidateId: probe.payload.candidateId, probeId: probe.artifactId, storyId },
      producer: 'repro-intake-service',
      payload: {
        storyId,
        candidateId: probe.payload.candidateId,
        probeId: probe.artifactId,
        probeDigest: probe.artifactDigest,
        reviewId: review.artifactId,
        reviewDigest: review.artifactDigest,
        derivedChecklistRefs: [],
        derivedVerificationIntentRefs: [],
        note: 'Synthetic invalid binding for reason-code smoke.',
      },
    });
    const result = evaluateStoryEvidenceBindingGate(root, store, storyId);
    assert.equal(result.blocking, true);
    assert.equal(result.reasonCode, 'stale_story_evidence_binding');
    const details = result.details.join('\n');
    assert.match(details, /repro_first_candidate_unreviewed/);
    assert.match(details, /repro_first_reviewed_class_not_target_bug/);
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
