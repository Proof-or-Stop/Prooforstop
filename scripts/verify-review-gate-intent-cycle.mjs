#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const storyReview = await import('../packages/main/dist/handlers/story-review.js');
const { REVIEWER_LANE_NAMES } = await import('../packages/main/dist/core/reviewer-lane-names.js');
const { StoryStore } = await import('../packages/main/dist/core/store.js');
const { acquireOwnerLease, resetSessionIdForTest } = await import('../packages/main/dist/core/story-owner-lease.js');
const { acceptanceIntentHash } = await import('../packages/main/dist/core/verification-intent-amendment.js');
const { resetConfigCache } = await import('../packages/main/dist/core/config.js');
const { createChecklistHandlers } = await import('../packages/main/dist/handlers/checklist.js');

assert.equal(
  typeof storyReview.reviewGateVerificationIntentIssue,
  'function',
  'REVIEW_GATE_INTENT_CYCLE: PLAN review must expose the lifecycle-dependency classifier',
);

const classify = storyReview.reviewGateVerificationIntentIssue;
const blocked = classify({
  desc: 'Independent review has no unresolved high or critical finding.',
  type: 'manual',
  priority: 'must',
});
assert.ok(blocked, 'REVIEW_GATE_INTENT_CYCLE: an independent-review verdict cannot be pre-REVIEW verification evidence');
assert.equal(blocked.type, 'review_gate_as_verification_intent');
assert.equal(blocked.severity, 'blocker');
assert.match(blocked.message, /review_pass_set|finding_add/);
assert.match(blocked.message, /remove.*verificationIntent/i);

for (const lifecycleVerdict of [
  'Independent reviewers report no unresolved high or critical findings.',
  'All required review lanes pass with no blocking findings.',
  'The quality reviewer records a pass verdict.',
  'Independent review has no open findings.',
  'The independent review is approved.',
  'Peer-review signs off with no defects.',
  'Code review completes with zero defects.',
]) {
  assert.ok(
    classify({ desc: lifecycleVerdict, type: 'manual', priority: 'must' }),
    `REVIEW_GATE_INTENT_CYCLE: common REVIEW verdict wording must be rejected: ${lifecycleVerdict}`,
  );
}

for (const lane of REVIEWER_LANE_NAMES) {
  assert.ok(
    classify({ desc: `The ${lane} review is approved with no open findings.`, type: 'manual', priority: 'must' }),
    `REVIEW_GATE_INTENT_CYCLE: registered reviewer lane wording must be rejected: ${lane}`,
  );
}

for (const command of [
  'proof-or-stop finding_list --storyId=B-x',
  'proof-or-stop finding_resolve --storyId=B-x --findingId=F-1',
  'proof-or-stop story_get --storyId=B-x',
]) {
  assert.ok(
    classify({
      desc: 'Independent review has no open findings.',
      type: 'cli',
      priority: 'must',
      verification: { command, selector: 'open: 0' },
    }),
    `REVIEW_GATE_INTENT_CYCLE: a REVIEW lifecycle command pin must not bypass the pre-REVIEW cycle guard: ${command}`,
  );
}

for (const legitimate of [
  { desc: 'The parser rejects unresolved symbolic references.', type: 'logic', priority: 'must' },
  { desc: 'A review screen renders unresolved findings for the user.', type: 'browser', priority: 'must' },
  { desc: 'A reviewer can open the generated report.', type: 'cli', priority: 'must' },
  { desc: 'The code review page passes accessibility checks.', type: 'browser', priority: 'must' },
  { desc: 'review_pass_set rejects an invalid signature.', type: 'cli', priority: 'must' },
  { desc: 'review_pass_set records a pass for the fixture story.', type: 'cli', priority: 'must' },
  {
    desc: 'Independent review has no open findings.',
    type: 'cli',
    priority: 'must',
    verification: { command: 'node fixture-review-status.mjs', selector: 'NO_OPEN_FINDINGS' },
  },
  { desc: 'Independent review has no unresolved high or critical finding.', type: 'manual', priority: 'should' },
  { desc: undefined, type: 'manual', priority: 'must' },
]) {
  assert.equal(
    classify(legitimate),
    null,
    `REVIEW_GATE_INTENT_CYCLE: product behavior must not be mistaken for lifecycle evidence: ${legitimate.desc}`,
  );
}

const handlerSource = readFileSync(new URL('../packages/main/src/handlers/story-review.ts', import.meta.url), 'utf8');
const classifierSource = readFileSync(new URL('../packages/main/src/core/review-gate-verification-intent.ts', import.meta.url), 'utf8');
const registrySource = readFileSync(new URL('../packages/main/src/core/process-fact-registry.ts', import.meta.url), 'utf8');
const machineSource = readFileSync(new URL('../packages/main/src/core/machine.ts', import.meta.url), 'utf8');
const reviewerOptInSource = readFileSync(new URL('../packages/main/src/core/reviewer-opt-in.ts', import.meta.url), 'utf8');
assert.match(
  handlerSource,
  /reviewGateVerificationIntentIssue\(intent\)/,
  'REVIEW_GATE_INTENT_CYCLE: story_review must consume the classifier for every authored intent',
);
assert.ok(
  classifierSource.includes('review_\\w+|finding_\\w+|story_advance|story_get|lifecycle_check|reviewer_list')
    && registrySource.includes('review_* or finding_* commands plus story_advance, story_get, lifecycle_check, and reviewer_list'),
  'REVIEW_GATE_INTENT_CYCLE: the declared caller-pin boundary must stay aligned with the lifecycle command classifier',
);
assert.ok(
  classifierSource.includes("import { REVIEWER_LANE_NAMES } from './reviewer-lane-names.js'")
    && reviewerOptInSource.includes("import { REVIEWER_LANE_NAMES } from './reviewer-lane-names.js'"),
  'REVIEW_GATE_INTENT_CYCLE: lifecycle wording and reviewer routing must consume one registered lane vocabulary',
);
assert.ok(
  machineSource.includes('(lastRound.blockerCount ?? lastRound.issueCount) !== 0'),
  'REVIEW_GATE_INTENT_CYCLE: canStartDev must consume the signed generic blocker count',
);

const handoffSource = readFileSync(new URL('../packages/main/src/handlers/testintent-handoff.ts', import.meta.url), 'utf8');
assert.match(
  handoffSource,
  /Do not encode .*review_pass_set.*finding_add.*verificationIntent/i,
  'REVIEW_GATE_INTENT_CYCLE: the PLAN authoring prompt must prohibit lifecycle review evidence as intent',
);

const fixtureRoot = mkdtempSync(join(tmpdir(), 'proof-review-gate-cycle-'));
const cli = new URL('../packages/main/dist/cli.js', import.meta.url).pathname;
const previousCwd = process.cwd();
const previousSessionId = process.env.PROOF_OR_STOP_SESSION_ID;
const previousAgent = process.env.PROOF_OR_STOP_AGENT;
const run = (command, payload) => execFileSync(process.execPath, [cli, '--root', fixtureRoot, command, JSON.stringify(payload)], {
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
});
const runFailure = (command, payload) => {
  try {
    run(command, payload);
  } catch (error) {
    return `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
  }
  assert.fail(`REVIEW_GATE_INTENT_CYCLE: ${command} unexpectedly accepted REVIEW lifecycle intent`);
};
try {
  mkdirSync(join(fixtureRoot, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests', fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives', requirementsDir: 'docs/requirements', storyPrefix: 'B',
  }));
  writeFileSync(join(fixtureRoot, 'docs', 'requirements', 'truth.md'), '# Review lifecycle truth\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixtureRoot });
  execFileSync('git', ['config', 'user.name', 'Review Intent Fixture'], { cwd: fixtureRoot });
  execFileSync('git', ['config', 'user.email', 'review-intent@example.invalid'], { cwd: fixtureRoot });
  execFileSync('git', ['add', '.'], { cwd: fixtureRoot });
  execFileSync('git', ['commit', '-qm', 'fixture baseline'], { cwd: fixtureRoot });
  const background = `## Trigger Event\nOn 2026-09-12, run LAB-review-intent-stage-cycle reproduced a DEV to REVIEW dependency cycle caused by a review verdict encoded as acceptance evidence.\n\n## Key Insights\nIndependent review evidence is created only after entering REVIEW, while verification intents are otherwise required before that transition. The two evidence classes must remain separate.\n\n## Solution Tradeoffs\nReject the narrow lifecycle-verdict shape during PLAN instead of weakening the DEV evidence gate. This preserves product-behavior acceptance while preventing the known impossible dependency.\n\n## Conversational Texture\nThe benchmark completed implementation and focused tests but delivered an empty patch because one impossible intent kept the Story in DEV. The repair must fail early with a useful instruction.`;
  const baseStory = {
    name: 'review-gate-cycle',
    title: 'Reject review lifecycle evidence from acceptance intent',
    description: 'Keep the DEV to REVIEW transition satisfiable.',
    type: 'bug',
    priority: 'low',
    forceNew: true,
    background,
  };
  const invalidIntent = {
    happy: [{ desc: 'The focused product command passes.', type: 'cli', priority: 'must' }],
    edge: [{ desc: 'The product handles an empty input.', type: 'logic', priority: 'must' }],
    adversarial: [{ desc: 'Independent review has no open findings.', type: 'manual', priority: 'must' }],
  };
  const createFailure = runFailure('story_create', {
    ...baseStory,
    checklist: [{
      title: 'Verify the focused behavior',
      context: 'Exercise product behavior and keep lifecycle review separate.',
      relatedDocs: ['docs/requirements/truth.md'],
      verificationIntent: invalidIntent,
    }],
  });
  assert.match(createFailure, /story_create refused.*review_gate_as_verification_intent/s);

  const draftName = 'review-intent-draft';
  run('story_draft', {
    name: draftName,
    title: 'Reject review lifecycle draft intent',
    description: 'Keep draft materialization free of review lifecycle evidence.',
    type: 'bug',
    priority: 'low',
    background,
    checklist: [{
      title: 'Verify the focused behavior',
      context: 'Exercise product behavior and keep lifecycle review separate.',
    }],
  });
  run('draft_check_set', { draftName, issues: [], agentId: 'proof-or-stop-review-story-init' });
  const draftChecklistPath = join(fixtureRoot, 'docs', 'story', 'drafts', draftName, 'checklist.json');
  const draftChecklist = JSON.parse(readFileSync(draftChecklistPath, 'utf8'));
  draftChecklist.items[0].verificationIntent = invalidIntent;
  writeFileSync(draftChecklistPath, JSON.stringify(draftChecklist, null, 2) + '\n');
  const draftFailure = runFailure('story_create', { fromDraft: draftName });
  assert.match(draftFailure, /story_create refused.*review_gate_as_verification_intent/s);

  const legitimateIntent = {
    happy: [{ desc: 'The code review page passes accessibility checks.', type: 'browser', priority: 'must' }],
    edge: [{ desc: 'A review screen renders an empty findings list.', type: 'browser', priority: 'must' }],
    adversarial: [{ desc: 'review_pass_set rejects an invalid signature.', type: 'cli', priority: 'must' }],
  };
  const created = run('story_create', {
    ...baseStory,
    checklist: [{
      title: 'Verify the focused behavior',
      context: 'Exercise product behavior and keep lifecycle review separate.',
      relatedDocs: ['docs/requirements/truth.md'],
      verificationIntent: legitimateIntent,
    }],
  });
  const storyId = created.match(/B-[a-f0-9]+/)?.[0];
  assert.ok(storyId, 'REVIEW_GATE_INTENT_CYCLE: fixture Story must be created');
  const updateFailure = runFailure('checklist_update', {
    storyId,
    itemId: 'CHK-001',
    verificationIntent: invalidIntent,
  });
  assert.match(updateFailure, /checklist_update refused.*review_gate_as_verification_intent/s);
  const addFailure = runFailure('checklist_add', {
    storyId,
    title: 'Add an invalid review lifecycle intent',
    context: 'The writer must reject this item before persistence.',
    verificationIntent: invalidIntent,
  });
  assert.match(addFailure, /checklist_add refused.*review_gate_as_verification_intent/s);

  const store = new StoryStore(fixtureRoot);
  const story = store.readStory(storyId);
  store.writeStory(storyId, { ...story, phase: 'DEV' });
  process.chdir(fixtureRoot);
  process.env.PROOF_OR_STOP_SESSION_ID = 'review-intent-cycle-owner';
  delete process.env.PROOF_OR_STOP_AGENT;
  resetSessionIdForTest();
  resetConfigCache();
  acquireOwnerLease(store.storyDirPath(storyId), { cwd: fixtureRoot, command: 'verification_intent_append' });
  const item = store.readChecklist(storyId).items[0];
  const handlers = createChecklistHandlers({ root: fixtureRoot, scanRoot: join(fixtureRoot, 'packages', 'main'), store });
  assert.throws(
    () => handlers.verification_intent_append({
      storyId,
      itemId: item.id,
      expectedIntentHash: acceptanceIntentHash(item.verificationIntent),
      reason: 'Reject lifecycle review evidence before a signed acceptance amendment is persisted.',
      addition: { adversarial: [{ ...invalidIntent.adversarial[0], id: 'REVIEW-DEADLOCK', type: 'cli' }] },
    }),
    /verification_intent_append refused.*review_gate_as_verification_intent/s,
  );
  process.chdir(previousCwd);
  store.writeStory(storyId, story);
  run('understanding_set', {
    storyId,
    task: 'reject lifecycle review outcomes in verification intent',
    outcome: 'PLAN review reports a precise blocking issue',
    facts: ['review evidence is produced in REVIEW'],
    constraints: ['do not weaken DEV verification coverage'],
    unknowns: [],
    touchpoints: ['packages/main/src/handlers/story-review.ts'],
  });
  run('scope_check_save', {
    storyId,
    features: [{ feature: 'review intent cycle', covered_by: 'regression fixture', status: 'covered', excluded_by: null, source: 'Lab regression' }],
    summary: { total: 1, covered: 1, excluded: 0, gaps: 0, orphanSuspect: 0, drift: 0 },
    readManifest: { filesReadFully: ['docs/requirements/truth.md'], filesTriagedByName: [], scanEscalationReason: null },
    openQuestions: [],
  });
  const legitimateReviewText = run('story_review', { storyId });
  const legitimateReview = JSON.parse(legitimateReviewText.slice(legitimateReviewText.indexOf('{')));
  assert.equal(
    legitimateReview.issues.some((candidate) => candidate.type === 'review_gate_as_verification_intent'),
    false,
    'REVIEW_GATE_INTENT_CYCLE: real story_review must preserve legitimate product review behavior',
  );

  // Simulate a Story persisted by an older CLI before writer-side rejection
  // existed. The consumer gate must still block this retained legacy state.
  const checklistPath = join(fixtureRoot, 'docs', 'story', 'actives', storyId, 'checklist.json');
  const checklist = JSON.parse(readFileSync(checklistPath, 'utf8'));
  checklist.items[0].verificationIntent = invalidIntent;
  writeFileSync(checklistPath, JSON.stringify(checklist, null, 2) + '\n');
  const reviewText = run('story_review', { storyId });
  const review = JSON.parse(reviewText.slice(reviewText.indexOf('{')));
  const issue = review.issues.find((candidate) => candidate.type === 'review_gate_as_verification_intent');
  assert.ok(issue, 'REVIEW_GATE_INTENT_CYCLE: real story_review must report the lifecycle dependency');
  assert.equal(issue.intentRef, 'CHK-001:adversarial:0');
  assert.equal(issue.severity, 'blocker');
  assert.ok(review.summary.blockerCount > 0, 'REVIEW_GATE_INTENT_CYCLE: the retained lifecycle dependency must enter the signed blocker count consumed by canStartDev');
} finally {
  process.chdir(previousCwd);
  if (previousSessionId === undefined) delete process.env.PROOF_OR_STOP_SESSION_ID;
  else process.env.PROOF_OR_STOP_SESSION_ID = previousSessionId;
  if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
  else process.env.PROOF_OR_STOP_AGENT = previousAgent;
  resetSessionIdForTest();
  resetConfigCache();
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('REVIEW_GATE_INTENT_CYCLE: review-only gate evidence is rejected during PLAN');
