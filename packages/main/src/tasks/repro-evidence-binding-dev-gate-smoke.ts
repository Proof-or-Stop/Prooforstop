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
  classifyReproFirstRequirement,
  evaluateStoryEvidenceBindingGate,
  type ReproFirstPreflightMode,
} from '../core/repro-evidence-binding-gate.js';
import { buildMaterialClassificationSnapshot } from '../core/material-code-policy.js';
import {
  createProbe,
  createStoryFromRepro,
  recordSpike,
  reviewProbe,
  reviewRegressionMatrix,
  reviewSpike,
} from '../core/repro-intake.js';
import type { ChecklistData, StoryInfo, StoryPhase } from '../core/types.js';
import { computeChecklistHash } from '../handlers/init-check.js';
import { createReproIntakeHandlers } from '../handlers/repro-intake.js';
import { createSessionHandlers } from '../handlers/session.js';
import { createStoryCreateHandlers } from '../handlers/story-create.js';
import { PROOF_OR_STOP_STATE_DIR } from '../core/brand-paths.js';

const NOW = '2026-06-24T12:00:00.000Z';

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

function makeRoot(mode: ReproFirstPreflightMode = 'enforce'): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-repro-binding-gate-'));
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.proof-or-stop/story/actives',
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

// B-a7c5 CHK-001: canSendStoryEventWithoutSnapshotCan's DEV-entry doors now ALSO
// require a dev-memory preflight acknowledgement. This file exists to test the
// repro-evidence-binding gate specifically, so every fixture writes a satisfying
// ack up front -- otherwise a DEV-door assertion below would observe
// missing_dev_memory_preflight_ack instead of the repro-binding-specific
// block/message this file exists to test.
function ackDevMemoryPreflight(store: StoryStore, storyId: string): void {
  store.writeDevMemoryPreflightAck(storyId, {
    schemaVersion: 'lattice.dev_memory_preflight_ack.v1',
    storyId,
    packDigest: 'repro-evidence-binding-dev-gate-smoke-synthetic-digest',
    topHitIds: [],
    acknowledgedAt: '2026-06-24T00:00:00.000Z',
    acknowledgedBy: 'repro-evidence-binding-dev-gate-smoke',
  });
}

function writeStory(store: StoryStore, storyId: string, phase: StoryPhase, checklist: ChecklistData): void {
  store.writeStory(storyId, story(storyId, phase));
  store.writeChecklist(storyId, checklist);
  ackDevMemoryPreflight(store, storyId);
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
  const spikeReview = reviewSpike(root, {
    spikeId: spike.artifactId,
    spikeDigest: spike.artifactDigest,
    verdict: 'confirmed',
    notes: 'Confirmed spike root cause for lifecycle gate smoke.',
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
    spikeReviewId: spikeReview.artifactId,
    matrixReviewId: matrixReview.artifactId,
    storyTitle: `${storyId} bound story`,
    storyDescription: 'Synthetic story bound to accepted repro evidence.',
  }, async () => storyId);
  return result.bindingArtifact.artifactDigest;
}

function createReviewedProbeAndSpike(root: string, candidateId: string) {
  const probe = createProbe(root, {
    candidateId,
    taskSummary: 'Synthetic confirmed failure with spike review',
    eligibility: 'Hermetic smoke candidate',
    reason: 'Gate must require confirmed spike review when a spike record is bound.',
    commandSpec: { command: 'node', args: [`${candidateId}.js`] },
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
    notes: 'Reviewed as a target-bug repro for spike review gate smoke.',
  });
  const spike = recordSpike(root, {
    probeId: probe.artifactId,
    description: 'Spike record requiring an explicit confirmed review.',
    steps: ['inspect synthetic spike'],
    observations: 'Synthetic root cause is bounded.',
    executionStatus: 'confirmed_failing',
    observedOutput: 'Synthetic spike output',
  });
  return { probe, review, spike };
}

function tamperBindingObject(root: string, bindingDigest: string): void {
  // B-cc10: writeArtifact (imported above) stores objects under the CANONICAL state dir,
  // so reading them from the deprecated path threw ENOENT.
  const objectPath = join(root, PROOF_OR_STOP_STATE_DIR, 'evidence', 'objects', 'sha256', `${bindingDigest}.json`);
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
    // B-cc10: plant the deliberate breakage where the engine actually READS. This wrote
    // to the deprecated dir, so after the rename the sabotage missed entirely and the gate
    // returned 'missing_story_evidence_binding' instead of the engine error under test —
    // i.e. the test silently stopped exercising its own scenario.
    write(root, `${PROOF_OR_STOP_STATE_DIR}/evidence/refs/by-id`, 'not a directory');
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

await check('malformed story-evidence-binding returns stale diagnostic instead of throwing', async () => {
  await withRoot((root, store) => {
    const storyId = 'B-malformed-binding';
    writeStory(store, storyId, 'PLAN', fileChecklist);
    writeArtifact(root, {
      artifactKind: 'story-evidence-binding',
      evidenceScope: 'evidence-candidate',
      subjectBinding: { storyId, candidateId: 'cand-malformed', probeId: 'probe-malformed' },
      producer: 'repro-intake-service',
      payload: undefined as any,
    });
    const result = evaluateStoryEvidenceBindingGate(root, store, storyId);
    assert.equal(result.blocking, true);
    assert.equal(result.reasonCode, 'stale_story_evidence_binding');
    assert.match(result.details.join('\n'), /malformed story-evidence-binding payload/);
    assert.doesNotThrow(() => getGuardFailureReason(storyId, store, 'DEV', root));
    assert.match(getGuardFailureReason(storyId, store, 'DEV', root) ?? '', /stale_story_evidence_binding/);
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

await check('story_create direct lifecycle phase rejects repro-first bypass before persistence', async () => {
  await withRoot((root, store) => {
    const handlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });
    assert.throws(
      () => handlers.story_create({
        name: 'direct-dev-bypass-block',
        title: 'Direct DEV bypass block',
        description: 'Exercise direct lifecycle phase with an explicit repro-first bypass reason.',
        type: 'feature',
        phase: 'DEV',
        priority: 'medium',
        background: validBackground,
        reproFirstBypassReason: 'Emergency non-reproducible intake must not skip DEV lifecycle binding gates.',
        checklist: [{
          title: 'Modify code',
          context: 'Declares files so direct DEV bypass must not persist without accepted binding.',
          files: { modify: ['src/feature.ts'] },
        }],
      }),
      /repro_first_bypass_direct_phase_forbidden/,
    );
    assert.deepEqual(store.listStoryIds(), [], 'blocked direct phase bypass must not persist story metadata');
  });
});

await check('story_create enforce blocks code-verifiable material-code bug classifier without binding before persistence', async () => {
  await withRoot((root, store) => {
    const handlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });
    assert.throws(
      () => handlers.story_create({
        name: 'bug-preflight-enforce-block',
        title: 'Bug preflight enforce block',
        description: 'Exercise repro-first preflight on a material-code bug story intake.',
        type: 'bug',
        priority: 'medium',
        background: validBackground,
        checklist: [{ title: 'Fix the source bug', context: 'in the runtime source', files: { modify: ['packages/main/src/x.ts'], create: [], test: [] } }],
      }),
      /classifier: code_verifiable_behavior_change/,
    );
    assert.deepEqual(store.listStoryIds(), [], 'blocked material-code bug story_create must not persist story metadata');
  });
});

// B-8628 red/spike regression: a no-material-file bug (and docs/refactor/chore) is
// intake-exempt; a material-code bug/feature is required; the high-risk safety net stays.
await check('B-8628 classifyReproFirstRequirement: material-code bug/feature required; docs/refactor/chore/no-file exempt; safety net kept', async () => {
  const story = (type: string, priority = 'medium', riskSignals: Array<{ category: string; matched: string }> = []) =>
    ({ type, priority, riskSignals }) as unknown as Parameters<typeof classifyReproFirstRequirement>[0];
  const cl = (...files: string[]) =>
    ({ items: [{ files: { modify: files, create: [], test: [] } }] }) as unknown as Parameters<typeof classifyReproFirstRequirement>[1];
  const snap = buildMaterialClassificationSnapshot();
  const expect = (name: string, s: ReturnType<typeof story>, files: string[], want: boolean) => {
    const r = classifyReproFirstRequirement(s, cl(...files), snap);
    assert.equal(r.required, want, `${name}: required ${r.required} !== ${want} (reason=${r.reason})`);
  };
  // exempt (cannot have a reproduce-the-failure red test)
  expect('docs-only bug', story('bug'), ['docs/g.md'], false);
  expect('docs feature', story('feature'), ['README.md'], false);
  expect('material refactor', story('refactor'), ['packages/main/src/x.ts'], false);
  expect('chore w/ material', story('chore'), ['packages/main/src/x.ts'], false);
  expect('no-file bug', story('bug'), [], false);
  // required (code-verifiable behavior change)
  expect('material bug', story('bug'), ['packages/main/src/x.ts'], true);
  expect('material feature', story('feature'), ['packages/main/src/x.ts'], true);
  // safety net (high/critical + code-verifiable risk, even without files)
  expect('high-risk no-file', story('bug', 'high', [{ category: 'State Machine/Gate', matched: 'machine.ts' }]), [], true);
  // reason codes
  assert.equal(classifyReproFirstRequirement(story('bug'), cl('packages/main/src/x.ts'), snap).reason, 'code_verifiable_behavior_change');
  assert.equal(classifyReproFirstRequirement(story('bug'), cl('docs/g.md'), snap).reason, 'bypass_eligible_no_files');
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

await check('story_create blocks direct lifecycle phase with repro-first bypass before persistence', async () => {
  await withRoot((root, store) => {
    const handlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });
    const blockedPhases: StoryPhase[] = ['PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE'];
    for (const phase of blockedPhases) {
      assert.throws(
        () => handlers.story_create({
          name: `direct-${phase.toLowerCase()}-bypass`,
          title: `Direct ${phase} bypass`,
          description: 'Exercise direct phase repro-first bypass refusal on a file-declaring story.',
          type: 'feature',
          priority: 'medium',
          phase,
          background: validBackground,
          reproFirstBypassReason: 'Emergency non-reproducible intake accepted by human operator for this smoke.',
          checklist: [{
            title: 'Modify code',
            context: 'Declares files so repro-first bypass must not skip lifecycle gates.',
            files: { modify: ['src/feature.ts'], test: ['tests/feature.test.ts'] },
          }],
        }),
        /repro_first_bypass_direct_phase_forbidden/,
      );
    }
    assert.deepEqual(store.listStoryIds(), [], 'blocked direct-phase bypass must not persist story metadata');
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

await check('gate accepts spike binding with confirmed spike review', async () => {
  await withRoot(async (root, store) => {
    const storyId = 'B-confirmed-spike-review';
    writeStory(store, storyId, 'PLAN', fileChecklist);
    const { probe, review, spike } = createReviewedProbeAndSpike(root, 'cand-confirmed-spike-review');
    const spikeReview = reviewSpike(root, {
      spikeId: spike.artifactId,
      spikeDigest: spike.artifactDigest,
      verdict: 'confirmed',
      notes: 'Confirmed spike root cause for gate acceptance smoke.',
    });
    const result = await createStoryFromRepro(root, {
      probeId: probe.artifactId,
      reviewId: review.artifactId,
      spikeId: spike.artifactId,
      spikeReviewId: spikeReview.artifactId,
      storyTitle: 'Confirmed spike review story',
      storyDescription: 'Synthetic story bound to accepted repro and confirmed spike evidence.',
    }, async () => storyId);
    assert.equal(result.bindingArtifact.payload.spikeReviewId, spikeReview.artifactId);
    assert.equal(result.bindingArtifact.payload.spikeReviewDigest, spikeReview.artifactDigest);
    const gate = evaluateStoryEvidenceBindingGate(root, store, storyId);
    assert.equal(gate.ok, true);
    assert.equal(gate.reasonCode, null);
  });
});

await check('gate rejects spike binding without spike review as stale', async () => {
  await withRoot((root, store) => {
    const storyId = 'B-missing-spike-review';
    writeStory(store, storyId, 'PLAN', fileChecklist);
    const { probe, review, spike } = createReviewedProbeAndSpike(root, 'cand-missing-spike-review');
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
        spikeId: spike.artifactId,
        spikeDigest: spike.artifactDigest,
        derivedChecklistRefs: [],
        derivedVerificationIntentRefs: [],
        note: 'Synthetic invalid spike binding without spike review.',
      },
    });
    const result = evaluateStoryEvidenceBindingGate(root, store, storyId);
    assert.equal(result.blocking, true);
    assert.equal(result.reasonCode, 'stale_story_evidence_binding');
    assert.match(result.details.join('\n'), /spikeReviewId and spikeReviewDigest are required/);
  });
});

await check('story_create_from_repro spike without review is stale at gate', async () => {
  await withRoot(async (root, store) => {
    const storyId = 'B-spike-without-review';
    writeStory(store, storyId, 'PLAN', fileChecklist);
    const { probe, review, spike } = createReviewedProbeAndSpike(root, 'cand-spike-without-review');
    const result = await createStoryFromRepro(root, {
      probeId: probe.artifactId,
      reviewId: review.artifactId,
      spikeId: spike.artifactId,
      storyTitle: 'Spike without review story',
      storyDescription: 'Synthetic story keeps compatible creation but cannot pass the gate without confirmed spike review.',
    }, async () => storyId);
    assert.equal(result.bindingArtifact.payload.spikeReviewId, undefined);
    const gate = evaluateStoryEvidenceBindingGate(root, store, storyId);
    assert.equal(gate.blocking, true);
    assert.equal(gate.reasonCode, 'stale_story_evidence_binding');
    assert.match(gate.details.join('\n'), /spikeReviewId and spikeReviewDigest are required/);
  });
});

await check('story_create_from_repro rejects rejected spike review before binding', async () => {
  await withRoot(async (root, store) => {
    const storyId = 'B-rejected-spike-review-create';
    writeStory(store, storyId, 'PLAN', fileChecklist);
    const { probe, review, spike } = createReviewedProbeAndSpike(root, 'cand-rejected-spike-review-create');
    const spikeReview = reviewSpike(root, {
      spikeId: spike.artifactId,
      spikeDigest: spike.artifactDigest,
      verdict: 'rejected',
      notes: 'Rejected spike review must not create a story binding.',
    });
    await assert.rejects(
      () => createStoryFromRepro(root, {
        probeId: probe.artifactId,
        reviewId: review.artifactId,
        spikeId: spike.artifactId,
        spikeReviewId: spikeReview.artifactId,
        storyTitle: 'Rejected spike review create story',
        storyDescription: 'Synthetic story must not be created from rejected spike review.',
      }, async () => storyId),
      /expected confirmed/,
    );
    assert.equal(store.readStory(storyId).phase, 'PLAN');
  });
});

await check('gate rejects rejected spike review as stale', async () => {
  await withRoot((root, store) => {
    const storyId = 'B-rejected-spike-review';
    writeStory(store, storyId, 'PLAN', fileChecklist);
    const { probe, review, spike } = createReviewedProbeAndSpike(root, 'cand-rejected-spike-review');
    const spikeReview = reviewSpike(root, {
      spikeId: spike.artifactId,
      spikeDigest: spike.artifactDigest,
      verdict: 'rejected',
      notes: 'Rejected spike review must not satisfy the story binding gate.',
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
        spikeId: spike.artifactId,
        spikeDigest: spike.artifactDigest,
        spikeReviewId: spikeReview.artifactId,
        spikeReviewDigest: spikeReview.artifactDigest,
        derivedChecklistRefs: [],
        derivedVerificationIntentRefs: [],
        note: 'Synthetic invalid spike binding with rejected spike review.',
      },
    });
    const gate = evaluateStoryEvidenceBindingGate(root, store, storyId);
    assert.equal(gate.blocking, true);
    assert.equal(gate.reasonCode, 'stale_story_evidence_binding');
    assert.match(gate.details.join('\n'), /spike_review_not_confirmed/);
  });
});

await check('gate rejects contradictory spike review status when verdict is rejected', async () => {
  await withRoot((root, store) => {
    const storyId = 'B-contradictory-spike-review';
    writeStory(store, storyId, 'PLAN', fileChecklist);
    const { probe, review, spike } = createReviewedProbeAndSpike(root, 'cand-contradictory-spike-review');
    const spikeReview = writeArtifact(root, {
      artifactKind: 'spike-review',
      evidenceScope: 'evidence-candidate',
      subjectBinding: { candidateId: probe.payload.candidateId, probeId: probe.artifactId, spikeId: spike.artifactId },
      producer: 'repro-intake-service',
      payload: {
        spikeId: spike.artifactId,
        spikeDigest: spike.artifactDigest,
        verdict: 'rejected',
        status: 'accepted',
        notes: 'Legacy status must not override a rejected spike review verdict.',
      } as any,
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
        spikeId: spike.artifactId,
        spikeDigest: spike.artifactDigest,
        spikeReviewId: spikeReview.artifactId,
        spikeReviewDigest: spikeReview.artifactDigest,
        derivedChecklistRefs: [],
        derivedVerificationIntentRefs: [],
        note: 'Synthetic invalid spike binding with contradictory spike review status.',
      },
    });
    const gate = evaluateStoryEvidenceBindingGate(root, store, storyId);
    assert.equal(gate.blocking, true);
    assert.equal(gate.reasonCode, 'stale_story_evidence_binding');
    const details = gate.details.join('\n');
    assert.match(details, /spike_review_not_confirmed/);
    assert.match(details, /verdict=rejected, status=accepted, expected verdict=confirmed/);
  });
});

await check('gate rejects status-only accepted spike review without confirmed verdict', async () => {
  await withRoot((root, store) => {
    const storyId = 'B-status-only-spike-review';
    writeStory(store, storyId, 'PLAN', fileChecklist);
    const { probe, review, spike } = createReviewedProbeAndSpike(root, 'cand-status-only-spike-review');
    const spikeReview = writeArtifact(root, {
      artifactKind: 'spike-review',
      evidenceScope: 'evidence-candidate',
      subjectBinding: { candidateId: probe.payload.candidateId, probeId: probe.artifactId, spikeId: spike.artifactId },
      producer: 'repro-intake-service',
      payload: {
        spikeId: spike.artifactId,
        spikeDigest: spike.artifactDigest,
        status: 'accepted',
        notes: 'Legacy status-only acceptance must not satisfy the spike review contract.',
      } as any,
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
        spikeId: spike.artifactId,
        spikeDigest: spike.artifactDigest,
        spikeReviewId: spikeReview.artifactId,
        spikeReviewDigest: spikeReview.artifactDigest,
        derivedChecklistRefs: [],
        derivedVerificationIntentRefs: [],
        note: 'Synthetic invalid spike binding with status-only accepted spike review.',
      },
    });
    const gate = evaluateStoryEvidenceBindingGate(root, store, storyId);
    assert.equal(gate.blocking, true);
    assert.equal(gate.reasonCode, 'stale_story_evidence_binding');
    const details = gate.details.join('\n');
    assert.match(details, /spike_review_not_confirmed/);
    assert.match(details, /status=accepted, expected verdict=confirmed/);
  });
});

await check('gate rejects mismatched spike review as stale', async () => {
  await withRoot((root, store) => {
    const storyId = 'B-mismatched-spike-review';
    writeStory(store, storyId, 'PLAN', fileChecklist);
    const { probe, review, spike } = createReviewedProbeAndSpike(root, 'cand-mismatched-spike-review');
    const otherSpike = recordSpike(root, {
      probeId: probe.artifactId,
      description: 'Different spike record for mismatch smoke.',
      steps: ['inspect different synthetic spike'],
      observations: 'Different bounded observation.',
      executionStatus: 'confirmed_failing',
      observedOutput: 'Different synthetic spike output',
    });
    const otherSpikeReview = reviewSpike(root, {
      spikeId: otherSpike.artifactId,
      spikeDigest: otherSpike.artifactDigest,
      verdict: 'confirmed',
      notes: 'Confirmed review for a different spike must not satisfy this binding.',
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
        spikeId: spike.artifactId,
        spikeDigest: spike.artifactDigest,
        spikeReviewId: otherSpikeReview.artifactId,
        spikeReviewDigest: otherSpikeReview.artifactDigest,
        derivedChecklistRefs: [],
        derivedVerificationIntentRefs: [],
        note: 'Synthetic invalid spike binding with mismatched spike review.',
      },
    });
    const result = evaluateStoryEvidenceBindingGate(root, store, storyId);
    assert.equal(result.blocking, true);
    assert.equal(result.reasonCode, 'stale_story_evidence_binding');
    assert.match(result.details.join('\n'), /spikeReview payload\.spikeId does not match binding spikeId/);
  });
});

await check('gate treats malformed story-evidence-binding payload as stale without throwing', async () => {
  await withRoot((root, store) => {
    const storyId = 'B-malformed-binding';
    writeStory(store, storyId, 'PLAN', fileChecklist);
    writeArtifact(root, {
      artifactKind: 'story-evidence-binding',
      evidenceScope: 'evidence-candidate',
      subjectBinding: { candidateId: 'cand-malformed-binding', storyId },
      producer: 'repro-intake-service',
      payload: null,
    });
    const result = evaluateStoryEvidenceBindingGate(root, store, storyId);
    assert.equal(result.blocking, true);
    assert.equal(result.reasonCode, 'stale_story_evidence_binding');
    assert.match(result.details.join('\n'), /malformed story-evidence-binding payload/);
    assert.equal(canSendStoryEventWithoutSnapshotCan(storyId, store, 'PLAN', 'START', root), false);
    assert.match(getGuardFailureReason(storyId, store, 'DEV', root) ?? '', /stale_story_evidence_binding/);
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

await check('PLAN->DEV material-code bug missing binding diagnostic uses code-verifiable classifier reason', async () => {
  await withRoot((root, store) => {
    const storyId = 'B-bug-missing-dev';
    store.writeStory(storyId, { ...story(storyId, 'PLAN'), type: 'bug' });
    store.writeChecklist(storyId, fileChecklist);
    ackDevMemoryPreflight(store, storyId);
    assert.equal(canSendStoryEventWithoutSnapshotCan(storyId, store, 'PLAN', 'START', root), false);
    const reason = getGuardFailureReason(storyId, store, 'DEV', root) ?? '';
    assert.match(reason, /classifier=code_verifiable_behavior_change/);
    assert.match(reason, /story\.type=bug/);
  });
});

// B-8628: a no-material-file bug is intake-exempt — the DEV gate no longer blocks it
// with a repro-first missing-binding reason (the removed bug_story over-reach).
await check('PLAN->DEV no-file bug is repro-first exempt (no bug_story over-reach)', async () => {
  await withRoot((root, store) => {
    const storyId = 'B-nofile-bug-dev';
    store.writeStory(storyId, { ...story(storyId, 'PLAN'), type: 'bug' });
    store.writeChecklist(storyId, noFileChecklist);
    ackDevMemoryPreflight(store, storyId);
    const reason = getGuardFailureReason(storyId, store, 'DEV', root) ?? '';
    assert.doesNotMatch(reason, /classifier=bug_story/);
    assert.doesNotMatch(reason, /missing_story_evidence_binding/);
  });
});

await check('PLAN->DEV high-risk missing binding diagnostic uses classifier reason', async () => {
  await withRoot((root, store) => {
    const storyId = 'B-high-risk-missing-dev';
    store.writeStory(storyId, {
      ...story(storyId, 'PLAN'),
      priority: 'high',
      riskSignals: [{ category: 'State Machine/Gate', matched: 'gate' }],
    });
    store.writeChecklist(storyId, noFileChecklist);
    ackDevMemoryPreflight(store, storyId);
    assert.equal(canSendStoryEventWithoutSnapshotCan(storyId, store, 'PLAN', 'START', root), false);
    const reason = getGuardFailureReason(storyId, store, 'DEV', root) ?? '';
    assert.match(reason, /classifier=high_risk_code_verifiable/);
    assert.match(reason, /priority=high/);
    assert.match(reason, /riskSignals=State Machine\/Gate:gate/);
    assert.doesNotMatch(reason, /checklist declares files\.modify\/create\/test/);
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
