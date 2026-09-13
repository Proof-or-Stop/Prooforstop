#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('.ts') && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const sourceUrl = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(sourceUrl)) return nextResolve(sourceUrl.href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith('.ts')) return nextLoad(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    };
  },
});

const storyReview = await import('../packages/main/src/handlers/story-review.ts');

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
  'Peer review signs off with no defects.',
  'Code review completes with zero defects.',
]) {
  assert.ok(
    classify({ desc: lifecycleVerdict, type: 'manual', priority: 'must' }),
    `REVIEW_GATE_INTENT_CYCLE: common REVIEW verdict wording must be rejected: ${lifecycleVerdict}`,
  );
}

for (const legitimate of [
  { desc: 'The parser rejects unresolved symbolic references.', type: 'logic', priority: 'must' },
  { desc: 'A review screen renders unresolved findings for the user.', type: 'browser', priority: 'must' },
  { desc: 'A reviewer can open the generated report.', type: 'cli', priority: 'must' },
  { desc: 'The code review page passes accessibility checks.', type: 'browser', priority: 'must' },
  { desc: 'review_pass_set rejects an invalid signature.', type: 'cli', priority: 'must' },
  { desc: 'Independent review has no unresolved high or critical finding.', type: 'manual', priority: 'should' },
]) {
  assert.equal(
    classify(legitimate),
    null,
    `REVIEW_GATE_INTENT_CYCLE: product behavior must not be mistaken for lifecycle evidence: ${legitimate.desc}`,
  );
}

const handlerSource = readFileSync(new URL('../packages/main/src/handlers/story-review.ts', import.meta.url), 'utf8');
assert.match(
  handlerSource,
  /reviewGateVerificationIntentIssue\(intent\)/,
  'REVIEW_GATE_INTENT_CYCLE: story_review must consume the classifier for every authored intent',
);

const handoffSource = readFileSync(new URL('../packages/main/src/handlers/testintent-handoff.ts', import.meta.url), 'utf8');
assert.match(
  handoffSource,
  /Do not encode .*review_pass_set.*finding_add.*verificationIntent/i,
  'REVIEW_GATE_INTENT_CYCLE: the PLAN authoring prompt must prohibit lifecycle review evidence as intent',
);

const fixtureRoot = mkdtempSync(join(tmpdir(), 'proof-review-gate-cycle-'));
const cli = new URL('../packages/main/dist/cli.js', import.meta.url).pathname;
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
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('REVIEW_GATE_INTENT_CYCLE: review-only gate evidence is rejected during PLAN');
