import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetConfigCache } from '../core/config.js';
import { signReviewPass } from '../core/finding-verify.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { buildStoryReadinessReport } from '../core/lifecycle-readiness.js';
import {
  captureReviewRunSnapshot,
  collectReviewerEvidenceState,
  hashReviewPrompt,
  signReviewRun,
} from '../core/review-run.js';
import {
  PROMPT_ENVELOPE_ROLLOUT_VERSION,
  resolvePromptRoleBody,
} from '../core/prompt-role-contract-registry.js';
import { StoryStore } from '../core/store.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { createFindingHandlers } from '../handlers/finding.js';
import { checkCommitAuthor } from '../handlers/validate-channel.js';
import type { ReviewPass, ReviewRun } from '../core/types.js';

const observedReasons: Record<string, string> = {};
const observedBehavior: Record<string, unknown> = {};

function captureError(fn: () => unknown, pattern: RegExp): Error {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.match(String(error), pattern);
    return error;
  }
  assert.fail(`expected error matching ${pattern}`);
}

function git(root: string, args: string[], author = 'Story 6 Matrix'): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: `${author.toLowerCase().replaceAll(' ', '-')}@example.invalid`,
      GIT_COMMITTER_NAME: author,
      GIT_COMMITTER_EMAIL: `${author.toLowerCase().replaceAll(' ', '-')}@example.invalid`,
    },
  }).trim();
}

function writeConfig(root: string): void {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: '.', testsDir: 'tests', fixturesDir: 'tests/fixtures',
    storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
    browser: { devCommand: 'node fake-browser.js' },
    promptEnvelope: {
      version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
      roles: {
        'proof-or-stop-review-quality': 'full-envelope',
        'proof-or-stop-review-concept': 'full-envelope',
      },
    },
  }, null, 2));
}

function canonicalRolePromptHash(agent: string): string {
  return hashReviewPrompt(resolvePromptRoleBody(agent, {
    version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
    roles: { [agent]: 'full-envelope' },
  }).body);
}

function makeRun(args: {
  storyId: string;
  reviewRunId: string;
  agent: string;
  reviewRound: string;
  startedAt: string;
  headHash: string;
  materialHash: string;
  storyFilesHash?: string;
}): ReviewRun {
  const promptHash = canonicalRolePromptHash(args.agent);
  return {
    reviewRunId: args.reviewRunId,
    storyId: args.storyId,
    agent: args.agent,
    lane: args.agent,
    reviewRound: args.reviewRound,
    startedAt: args.startedAt,
    headHash: args.headHash,
    materialHash: args.materialHash,
    ...(args.storyFilesHash ? { storyFilesHash: args.storyFilesHash } : {}),
    promptHash,
    _hash: signReviewRun(
      args.storyId,
      args.reviewRunId,
      args.agent,
      args.agent,
      args.reviewRound,
      args.startedAt,
      args.headHash,
      args.materialHash,
      promptHash,
      undefined,
      undefined,
      args.storyFilesHash,
    ),
  };
}

function makePass(storyId: string, run: ReviewRun): ReviewPass {
  const id = `${storyId}:RP-001`;
  const note = 'Story 6 invariant matrix valid reviewer control';
  const createdAt = '2026-07-21T03:01:00.000Z';
  return {
    id,
    agent: run.lane,
    note,
    createdAt,
    reviewRound: run.reviewRound,
    reviewRunId: run.reviewRunId,
    _hash: signReviewPass(storyId, id, run.lane, note, createdAt, run.reviewRound, run.reviewRunId),
  };
}

const root = mkdtempSync(join(tmpdir(), 'story6-real-consumer-matrix-'));
try {
  writeConfig(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'fixture.ts'), 'export const fixture = true;\n');
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'story6@example.invalid']);
  git(root, ['config', 'user.name', 'Story 6 Matrix']);
  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-story6-invariants';
  const reviewRound = 'round-1';
  store.writeStory(storyId, {
    storyId, name: storyId, title: 'Story 6 invariant matrix', description: 'Hermetic real-consumer controls',
    type: 'feature', phase: 'REVIEW', priority: 'high', riskSignals: ['state-machine'], currentReviewRound: reviewRound,
    createdAt: '2026-07-21T03:00:00.000Z', startedAt: '2026-07-21T03:00:00.000Z', endedAt: null, events: [],
  } as never);
  store.writeChecklist(storyId, { items: [{
    id: 'CHK-001', title: 'Invariant matrix', context: 'real consumers', status: 'in_progress', relatedDocs: [],
    files: { modify: ['src/fixture.ts'], create: [], test: [] }, verificationIntent: { happy: [], edge: [], adversarial: [] },
  }] } as never);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture base']);

  const snapshot = captureReviewRunSnapshot(root, { storyId, storyPhase: 'REVIEW' }, root);
  const run = makeRun({
    storyId, reviewRunId: `${storyId}:RR-001`, agent: 'proof-or-stop-review-quality', reviewRound,
    startedAt: '2026-07-21T03:00:30.000Z', headHash: snapshot.headHash, materialHash: snapshot.materialHash,
    storyFilesHash: snapshot.storyFilesHash,
  });
  const pass = makePass(storyId, run);
  store.writeReviewRuns(storyId, { runs: [run] });
  store.writeReviewPasses(storyId, { passes: [pass] });

  const valid = collectReviewerEvidenceState(store, storyId, root);
  assert.equal(valid.invalid.length, 0, `valid signed control must pass: ${JSON.stringify(valid.invalid)}`);
  assert.equal(valid.valid.length, 1);
  const positiveControlValidPasses = valid.valid.filter(evidence => evidence.kind === 'pass').length;
  assert.equal(positiveControlValidPasses, 1);

  store.writeReviewPasses(storyId, { passes: [{ ...pass, note: `${pass.note} tampered` }] });
  const signatureReasons = collectReviewerEvidenceState(store, storyId, root).invalid.map(issue => issue.code);
  assert.deepEqual(signatureReasons, ['invalid_evidence_signature']);
  observedReasons.signature = signatureReasons[0];
  store.writeReviewPasses(storyId, { passes: [pass] });
  store.writeReviewRuns(storyId, { runs: [{ ...run, _hash: '0'.repeat(64) }] });
  assert.deepEqual(
    collectReviewerEvidenceState(store, storyId, root).invalid.map(issue => issue.code),
    ['invalid_run_signature'],
  );

  const wrongLaneRun = makeRun({
    storyId, reviewRunId: run.reviewRunId, agent: 'proof-or-stop-review-concept', reviewRound,
    startedAt: run.startedAt, headHash: run.headHash, materialHash: run.materialHash, storyFilesHash: run.storyFilesHash,
  });
  store.writeReviewRuns(storyId, { runs: [wrongLaneRun] });
  store.writeReviewPasses(storyId, { passes: [pass] });
  assert.deepEqual(
    collectReviewerEvidenceState(store, storyId, root).invalid.map(issue => issue.code),
    ['wrong_lane'],
  );

  store.writeReviewRuns(storyId, { runs: [run] });
  store.writeScopeContract(storyId, {
    storyId, mode: 'enforce', allowedModify: ['src/fixture.ts'], allowedCreate: [], allowedTest: [],
    protectedFiles: [], explicitExcludes: [], acknowledgements: [],
    createdAt: '2026-07-21T03:02:00.000Z', updatedAt: '2026-07-21T03:02:00.000Z',
  });
  const scopeReasons = collectReviewerEvidenceState(store, storyId, root).invalid.map(issue => issue.code);
  assert.deepEqual(scopeReasons, ['missing_scope_binding']);
  observedReasons.scope = scopeReasons[0];

  store.writeReviewPasses(storyId, { passes: [] });
  store.appendProcessEvent(storyId, {
    type: 'dispatch', storyId, phase: 'REVIEW', source: 'Story 6 audit-only control',
    targetKind: 'story-dispatch', agentType: 'proof-or-stop-review-quality', promptEnvelopeId: 'a'.repeat(64),
    promptEnvelopeDigest: 'b'.repeat(64), assembledPromptDigest: 'c'.repeat(64),
  });
  const auditOnlyEvidence = collectReviewerEvidenceState(store, storyId, root);
  const auditOnlyValidPasses = auditOnlyEvidence.valid.filter(evidence => evidence.kind === 'pass').length;
  const auditOnlyValidFindings = auditOnlyEvidence.valid.filter(evidence => evidence.kind === 'finding').length;
  assert.equal(auditOnlyEvidence.valid.length, 0, 'story-dispatch receipt gets zero REVIEW credit');
  assert.deepEqual(
    { validPasses: auditOnlyValidPasses, validFindings: auditOnlyValidFindings },
    { validPasses: 0, validFindings: 0 },
    'removing the real signed pass and adding only a story-dispatch event must mutate the consumer outcome from one valid pass to zero credit',
  );
  observedBehavior.reviewCredit = {
    reviewCredit: 'zero',
    validPasses: auditOnlyValidPasses,
    validFindings: auditOnlyValidFindings,
    positiveControlValidPasses,
    source: 'collectReviewerEvidenceState',
  };

  const ctx = { root, scanRoot: root, store } as never;
  const checklistHandlers = createChecklistHandlers(ctx);
  const authorityError = captureError(
    () => checklistHandlers.checklist_update({ storyId, itemId: 'CHK-001', status: 'done', actor: 'proof-or-stop-review-quality' }),
    /agent_dispatch_mutation_denied/,
  );
  observedReasons.authority = /agent_dispatch_mutation_denied/.exec(String(authorityError))![0];
  assert.throws(
    () => checklistHandlers.checklist_update({ storyId, itemId: 'CHK-001', status: 'done', actor: 'test-intent' }),
    /agent_dispatch_mutation_scope_denied/,
  );
  const findingHandlers = createFindingHandlers(ctx);
  assert.throws(
    () => findingHandlers.review_pass_set({
      storyId, agent: 'proof-or-stop-implementer', reviewRunId: 'RR-denied', note: 'must not persist',
      readManifest: { routedCandidates: [], fullyRead: [], triaged: [] },
    }),
    /agent_dispatch_mutation_denied/,
  );

  store.writeEvalEvidence(storyId, {
    scores: { functionality: 5, usability: 5 }, total: 10, pass: true,
    itemResults: [{ itemId: 'CHK-001', pass: true, note: 'valid evaluator control' }],
    findings: [], timestamp: '2026-07-21T03:03:00.000Z',
  });
  const missingDelivery = new Set(buildStoryReadinessReport({ storyId, target: 'DONE', store, root }).readiness.map(row => row.code));
  assert.ok(missingDelivery.has('missing_delivery_check'), 'eval-present control isolates missing_delivery_check');
  assert.ok(!missingDelivery.has('missing_eval_evidence'), 'valid evaluator control removes missing_eval_evidence');
  observedReasons.delivery = 'missing_delivery_check';

  rmSync(join(store.storyDirPath(storyId), 'eval-evidence.json'));
  const docsPromises: [] = [];
  const realMachineTests = [{ featureId: 'CHK-001', transcript: 'Story 6 invariant matrix real-machine control.' }];
  const closingSelfCheck = {
    hasRealMachineTest: true, hasEdgeCaseCoverage: true, hasUnresolvedTodos: false,
    summary: 'Story 6 invariant matrix delivery control is complete.',
  };
  store.writeDeliveryCheck(storyId, {
    storyId, checkedAt: '2026-07-21T03:04:00.000Z', headHash: snapshot.headHash,
    materialHash: snapshot.materialHash, storyFilesHash: snapshot.storyFilesHash, reviewRound,
    agentId: 'proof-or-stop-review-delivery', docsPromises, realMachineTests, closingSelfCheck,
    _hash: signDeliveryCheck(
      storyId, docsPromises, realMachineTests, closingSelfCheck, reviewRound,
      snapshot.materialHash, snapshot.storyFilesHash,
    ),
  });
  const missingEvaluator = new Set(buildStoryReadinessReport({ storyId, target: 'DONE', store, root }).readiness.map(row => row.code));
  assert.ok(missingEvaluator.has('missing_eval_evidence'), 'delivery-present browser control isolates missing_eval_evidence');
  assert.ok(missingEvaluator.has('delivery_check_passed'), 'valid delivery control is accepted by the real DONE consumer');
  assert.ok(!missingEvaluator.has('missing_delivery_check') && !missingEvaluator.has('stale_delivery_check'));
  observedReasons.evaluator = 'missing_eval_evidence';
} finally {
  rmSync(root, { recursive: true, force: true });
  resetConfigCache();
}

const authorRoot = mkdtempSync(join(tmpdir(), 'story6-wrong-author-channel-'));
try {
  writeConfig(authorRoot);
  mkdirSync(join(authorRoot, 'src'), { recursive: true });
  writeFileSync(join(authorRoot, 'src', 'base.ts'), 'export const base = true;\n');
  git(authorRoot, ['init', '-b', 'main']);
  git(authorRoot, ['config', 'user.email', 'story6@example.invalid']);
  git(authorRoot, ['config', 'user.name', 'Story 6 Matrix']);
  resetConfigCache();
  const store = new StoryStore(authorRoot);
  const storyId = 'B-story6-wrong-author';
  store.writeStory(storyId, {
    storyId, name: storyId, title: 'Wrong author channel', description: 'Normal-channel author diagnostic',
    type: 'feature', phase: 'DEV', priority: 'high', riskSignals: ['state-machine'],
    createdAt: '2026-07-21T04:00:00.000Z', startedAt: '2026-07-21T04:00:00.000Z', endedAt: null, events: [],
  } as never);
  store.writeChecklist(storyId, { items: ['001', '002', '003'].map(suffix => ({
    id: `CHK-${suffix}`, title: `Item ${suffix}`, context: 'normal-channel control', status: 'in_progress', relatedDocs: [],
    files: { modify: ['src/real-code.ts'], create: [], test: [] }, verificationIntent: { happy: [], edge: [], adversarial: [] },
  })) } as never);
  git(authorRoot, ['add', '.']);
  git(authorRoot, ['commit', '-m', 'base']);
  git(authorRoot, ['checkout', '-b', `story/${storyId}`]);
  writeFileSync(join(authorRoot, 'src', 'real-code.ts'), 'export const realCode = true;\n');
  git(authorRoot, ['add', 'src/real-code.ts']);
  git(authorRoot, ['commit', '-m', 'implement without dispatch evidence'], 'main-agent');
  const wrongAuthor = checkCommitAuthor(storyId, { store, projectRoot: authorRoot });
  assert.equal(wrongAuthor.status, 'fail');
  assert.match(wrongAuthor.summary, /missing dispatch\/subagent_result evidence/);
  assert.match(wrongAuthor.summary, /unexpected implementation attribution/);
  assert.match(wrongAuthor.details.join('\n'), /commit author is an independent audit signal/);
  assert.match(wrongAuthor.details.join('\n'), /main-agent/);
  assert.match(wrongAuthor.summary, /missing dispatch\/subagent_result evidence/);
  observedBehavior.wrongAuthor = {
    status: wrongAuthor.status,
    dispatchEvidence: 'missing',
    source: 'checkCommitAuthor',
  };
} finally {
  rmSync(authorRoot, { recursive: true, force: true });
  resetConfigCache();
}

assert.deepEqual(Object.keys(observedReasons).sort(), [
  'authority', 'delivery', 'evaluator', 'scope', 'signature',
]);
console.log(`story6-invariant-reasons: ${JSON.stringify(observedReasons)}`);
console.log(`story6-invariant-behavior: ${JSON.stringify(observedBehavior)}`);
console.log('story6-invariants-smoke: PASS (real signed-evidence, scope/delivery/evaluator, authority, REVIEW-credit, and wrong-author consumers)');
