#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CLOSEOUT_ARTIFACT_POLICIES,
  CLOSEOUT_WRITE_RECEIPTS_PATH,
  assertCanonicalCloseoutWrite,
  buildCloseoutWriteReceipt,
  computeCompositeScopeDigest,
  evaluateMetadataOnlyReviewRetention,
  latestValidCloseoutReceipt,
  readCloseoutWriteReceipts,
  validatePersistedDeliveryContextPack,
  validateTrustedMilestoneLedger,
  validateTrustedParentLedgerRollup,
  validateTrustedSlicePlan,
  verifyCloseoutWriteReceipt,
} from '../core/closeout-trust.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { isLatticeLifecycleArtifactPath } from '../core/lifecycle-registry.js';
import {
  buildMilestoneLedger,
  buildParentLedgerRollup,
  buildSlicePlan,
} from '../core/proofstory.js';
import type { ScopeContractData } from '../core/types.js';
import {
  buildCurrentScopeContext,
  compareScopeBinding,
  computeReviewScopeBinding,
} from '../core/review-scope-binding.js';
import { StoryStore } from '../core/store.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { currentScopeContextForStory, evaluateReviewRunMetadataRetention } from '../core/review-run.js';
import type { ReviewRun } from '../core/types.js';
import { resetConfigCache } from '../core/config.js';
import { createProofStoryHandlers } from '../handlers/proofstory.js';
import { createTestHandlers } from '../handlers/test.js';
import { createTestStoryHandlers } from '../handlers/test-story.js';
import { createDeliveryCheckHandlers } from '../handlers/delivery-check.js';
import { createEvaluateHandlers } from '../handlers/evaluate.js';
import { createSummaryHandlers } from '../handlers/summary.js';
import { createDeliveryContextPackHandlers } from '../handlers/delivery-context-pack.js';
import { createLiveSmokeTranscriptHandlers } from '../handlers/live-smoke-transcript.js';
import { createDoneRequiredValidationHandlers } from '../handlers/done-required-validation.js';
import { createVerifierHandlers } from '../handlers/verifier.js';
import type { HandlerContext } from '../handlers/context.js';

const storyId = 'B-closeout';
const ledger = buildMilestoneLedger({
  storyId,
  state: 'candidate',
  milestones: [{
    id: 'M1',
    sourceRequirementId: 'REQ-1',
    claim: 'Closeout trust remains fail closed',
    doneMeans: 'Focused smoke passes',
    requiredEvidence: ['logic_test'],
    checklistRefs: ['CHK-001'],
    verificationIntentRefs: ['CHK-001:happy:0'],
    status: 'planned',
  }],
});
const plan = buildSlicePlan({
  storyId,
  ledger,
  slices: [{ id: 'S1', milestoneIds: ['M1'], reason: 'one bounded slice' }],
});
const rollup = buildParentLedgerRollup({
  storyId,
  ledger,
  slicePlan: plan,
  children: [{ storyId: 'B-child', milestoneIds: ['M1'], status: 'done', evidenceRefs: ['test:pass'] }],
});
const contract: ScopeContractData = {
  storyId,
  mode: 'enforce',
  allowedModify: ['packages/main/src/core/**'],
  allowedCreate: [],
  allowedTest: ['packages/main/src/tasks/**'],
  protectedFiles: [],
  explicitExcludes: ['.omx'],
  acknowledgements: [{
    actor: 'lattice-review-scope-plan',
    reason: 'The declared expansion is required and reviewer visible.',
    timestamp: '2026-07-13T00:00:00.000Z',
    paths: ['packages/main/src/core/closeout-trust.ts'],
  }],
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
};

assert.deepEqual(
  CLOSEOUT_ARTIFACT_POLICIES.map((policy) => policy.path),
  [
    'scope-contract.json',
    'milestone-ledger.json',
    'slice-plan.json',
    'parent-ledger-rollup.json',
    'evidence/delivery-context-pack.json',
    'test-evidence.json',
    'done-required-evidence.json',
    'delivery-check.json',
    'eval-evidence.json',
    'summary.json',
    'evidence/live-smoke-transcript.json',
  ],
);
assert(!(CLOSEOUT_ARTIFACT_POLICIES as readonly { path: string }[]).some((policy) => policy.path === 'milestone-closeout.json'));
for (const policy of CLOSEOUT_ARTIFACT_POLICIES) {
  assert(isLatticeLifecycleArtifactPath(`.lattice/story/actives/${storyId}/${policy.path}`), `${policy.path} must be in the closed lifecycle classifier`);
  for (const writer of policy.canonicalWriters) assert(writer in COMMAND_POLICIES, `${policy.path} writer ${writer} must be a registered CLI command`);
}
assert.equal(assertCanonicalCloseoutWrite('scope-contract.json', 'scope_contract_acknowledge').artifactClass, 'scope-defining');
assert.throws(() => assertCanonicalCloseoutWrite('../parent-ledger-rollup.json', 'parent_ledger_rollup_set'), /untrusted closeout artifact path/);
assert.throws(() => assertCanonicalCloseoutWrite('parent-ledger-rollup.json', 'manual-write'), /non-canonical writer.*parent-ledger-rollup/);
console.log('PASS closeout artifact classifications: closed set and canonical writer provenance verified');

const digest = computeCompositeScopeDigest({ contract, ledger, slicePlan: plan });
const reorderedDigest = computeCompositeScopeDigest({
  contract: { ...contract, allowedModify: [...contract.allowedModify].reverse() },
  ledger: JSON.parse(JSON.stringify(ledger)),
  slicePlan: JSON.parse(JSON.stringify(plan)),
});
assert.equal(digest, reorderedDigest, 'equivalent ordering must reproduce the digest');
assert.notEqual(digest, computeCompositeScopeDigest({
  contract: {
    ...contract,
    acknowledgements: [{ ...contract.acknowledgements[0], actor: 'replayed-wrong-provenance' }],
  },
  ledger,
  slicePlan: plan,
}));
const changedLedger = buildMilestoneLedger({
  storyId,
  existing: ledger,
  milestones: ledger.milestones.map((item) => ({ ...item, claim: `${item.claim} changed` })),
});
assert.notEqual(digest, computeCompositeScopeDigest({ contract, ledger: changedLedger }));
const confirmedLedger = {
  ...ledger,
  state: 'confirmed' as const,
  acceptedIntentBinding: {
    intentCollisionId: 'IC-1',
    acceptedInterpretationHash: 'sha256:accepted-a',
    acceptedAt: '2026-07-13T00:00:00.000Z',
  },
};
validateTrustedMilestoneLedger(confirmedLedger, storyId);
assert.notEqual(
  computeCompositeScopeDigest({ contract, ledger: confirmedLedger, slicePlan: plan }),
  computeCompositeScopeDigest({
    contract,
    ledger: { ...confirmedLedger, acceptedIntentBinding: { ...confirmedLedger.acceptedIntentBinding, acceptedInterpretationHash: 'sha256:accepted-b' } },
    slicePlan: plan,
  }),
  'accepted intent binding is semantic scope even when ledgerHash is unchanged',
);
const emptyDiff = { diffPackHash: 'ignored', changedFiles: [], hunks: [], generatedAt: '2026-07-13T00:00:00.000Z' };
const signedScope = computeReviewScopeBinding({ contract, diffPack: emptyDiff, ledger, slicePlan: plan });
assert(signedScope?.compositeScopeDigest === digest);
assert.equal(compareScopeBinding(signedScope, buildCurrentScopeContext(contract, emptyDiff, undefined, ledger, plan)).ok, true);
assert.equal(compareScopeBinding(
  signedScope,
  buildCurrentScopeContext({ ...contract, acknowledgements: [{ ...contract.acknowledgements[0], actor: 'changed' }] }, emptyDiff, undefined, ledger, plan),
).code, 'composite_scope_changed');
console.log('PASS composite scope digest: semantic scope facts bound');

validateTrustedMilestoneLedger(ledger, storyId);
validateTrustedSlicePlan(plan, ledger, storyId);
validateTrustedParentLedgerRollup(rollup, ledger, plan, storyId);
const { createdAt: _ledgerCreatedAt, ...ledgerWithoutCreatedAt } = ledger;
const { updatedAt: _planUpdatedAt, ...planWithoutUpdatedAt } = plan;
const { createdAt: _rollupCreatedAt, ...rollupWithoutCreatedAt } = rollup;
assert.throws(() => validateTrustedMilestoneLedger(ledgerWithoutCreatedAt, storyId), /createdAt/);
assert.throws(() => validateTrustedSlicePlan(planWithoutUpdatedAt, ledger, storyId), /updatedAt/);
assert.throws(() => validateTrustedParentLedgerRollup(rollupWithoutCreatedAt, ledger, plan, storyId), /createdAt/);
for (const [name, forged, validator] of [
  ['milestone-ledger.json', { ...ledger, ledgerHash: 'forged' }, () => validateTrustedMilestoneLedger({ ...ledger, ledgerHash: 'forged' }, storyId)],
  ['slice-plan.json', { ...plan, planHash: 'forged' }, () => validateTrustedSlicePlan({ ...plan, planHash: 'forged' }, ledger, storyId)],
  ['parent-ledger-rollup.json', { ...rollup, rollupHash: 'forged' }, () => validateTrustedParentLedgerRollup({ ...rollup, rollupHash: 'forged' }, ledger, plan, storyId)],
] as const) {
  void forged;
  assert.throws(validator, new RegExp(`${name.replace('.', '\\.')}: .*Hash mismatch`));
}
const deliveryPack = {
  storyId,
  generatedFor: 'delivery-review',
  diff: { changedFiles: [], summary: '' },
  docsPromises: [],
  realMachineTests: { transcriptDiff: false, testFiles: [], evidenceCommands: [] },
  candidateRouting: null,
  validation: null,
  reviewRound: '2026-07-13T00:00:00.000Z',
  deliveryCheck: { status: 'present', ref: null },
  waiver: { status: 'none' },
  isSigner: false,
  claims: { authorityDone: false, fullAuthorityDone: false, productionDone: false },
} as const;
validatePersistedDeliveryContextPack(deliveryPack, storyId);
assert.throws(
  () => validatePersistedDeliveryContextPack({ ...deliveryPack, claims: { ...deliveryPack.claims, authorityDone: true } }, storyId),
  /authority claims must all be false/,
);
for (const [label, mutation] of [
  ['non-string changedFiles', { ...deliveryPack, diff: { ...deliveryPack.diff, changedFiles: [42] } }],
  ['non-string testFiles', { ...deliveryPack, realMachineTests: { ...deliveryPack.realMachineTests, testFiles: [42] } }],
  ['non-string evidenceCommands', { ...deliveryPack, realMachineTests: { ...deliveryPack.realMachineTests, evidenceCommands: [{}] } }],
  ['invalid delivery ref', { ...deliveryPack, deliveryCheck: { ...deliveryPack.deliveryCheck, ref: 'forged' } }],
  ['extra claim', { ...deliveryPack, claims: { ...deliveryPack.claims, forged: false } }],
  ['invalid routing', { ...deliveryPack, candidateRouting: { artifactDigest: 'a', corpusDigest: 'b', candidateSpecSet: [42], ambiguitySignals: [] } }],
  ['invalid validation', { ...deliveryPack, validation: { source: 'test-evidence.json', result: 'PASS', timestamp: 'not-time', headHash: null, materialHash: null, storyFilesHash: null } }],
] as const) {
  assert.throws(() => validatePersistedDeliveryContextPack(mutation, storyId), Error, label);
}
console.log('PASS trusted closeout artifacts: schema and embedded hashes verified');

const retained = evaluateMetadataOnlyReviewRetention({
  materialUnchanged: true,
  storedCompositeScopeDigest: digest,
  currentCompositeScopeDigest: digest,
  changedArtifacts: [{ path: 'parent-ledger-rollup.json', writer: 'parent_ledger_rollup_set', valid: true }],
  storedReviewRound: 'round-1',
  currentReviewRound: 'round-1',
});
assert.equal(retained.ok, true);
assert.equal(evaluateMetadataOnlyReviewRetention({
  materialUnchanged: false,
  storedCompositeScopeDigest: digest,
  currentCompositeScopeDigest: digest,
  changedArtifacts: [{ path: 'parent-ledger-rollup.json', writer: 'parent_ledger_rollup_set', valid: true }],
  storedReviewRound: 'round-1',
  currentReviewRound: 'round-1',
}).ok, false);
assert.equal(evaluateMetadataOnlyReviewRetention({
  materialUnchanged: true,
  storedCompositeScopeDigest: digest,
  currentCompositeScopeDigest: `${digest}-changed`,
  changedArtifacts: [{ path: 'parent-ledger-rollup.json', writer: 'parent_ledger_rollup_set', valid: true }],
  storedReviewRound: 'round-1',
  currentReviewRound: 'round-1',
}).ok, false);
console.log('PASS canonical closeout write retained TEST');

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

const repo = mkdtempSync(join(tmpdir(), 'closeout-retention-'));
try {
  writeFileSync(join(repo, 'lattice.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: 'src', storyDir: '.lattice/story/actives', testsDir: 'tests', fixturesDir: 'tests/fixtures', requirementsDir: 'docs/requirements', storyPrefix: 'B',
    validate: { commands: [{ label: 'closeout smoke validate', command: 'node', args: ['-e', 'process.exit(0)'] }] },
    doneRequiredCommands: [{ label: 'closeout smoke done required', command: 'node', args: ['-e', 'process.exit(0)'] }],
  }), 'utf8');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/app.ts'), 'export const stable = true;\n', 'utf8');
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'smoke@example.test']);
  git(repo, ['config', 'user.name', 'closeout-smoke']);
  resetConfigCache();
  const store = new StoryStore(repo);
  const runtimeStoryId = 'B-receipt';
  const runtimeContract = { ...contract, storyId: runtimeStoryId };
  const runtimeLedger = { ...ledger, storyId: runtimeStoryId };
  const runtimePlan = { ...plan, storyId: runtimeStoryId };
  store.writeStory(runtimeStoryId, {
    storyId: runtimeStoryId, name: 'receipt-smoke', title: 'Receipt smoke', description: 'Exercise real metadata retention consumer.',
    type: 'feature', phase: 'TEST', priority: 'high', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: null,
    currentReviewRound: 'round-1', events: [],
  });
  store.writeScopeContract(runtimeStoryId, runtimeContract);
  store.writeMilestoneLedger(runtimeStoryId, runtimeLedger);
  store.writeProofStorySlicePlan(runtimeStoryId, runtimePlan);
  store.writeChecklist(runtimeStoryId, { items: [] });
  mkdirSync(join(repo, 'tests/fixtures'), { recursive: true });
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'baseline']);
  git(repo, ['checkout', '-b', `story/${runtimeStoryId}`]);
  const baselineHead = currentGitHead(repo)!;
  const baselineMaterial = currentMaterialHash(repo, 'HEAD', repo)!;
  const baselineStoryFiles = currentStoryFilesHash(repo, 'HEAD', repo)!;
  const runtimeBinding = computeReviewScopeBinding({ contract: runtimeContract, diffPack: emptyDiff, ledger: runtimeLedger, slicePlan: runtimePlan })!;
  const run = {
    reviewRunId: `${runtimeStoryId}:RR-001`, storyId: runtimeStoryId, agent: 'lattice-review-quality', lane: 'lattice-review-quality',
    reviewRound: 'round-1', startedAt: new Date().toISOString(), headHash: baselineHead, materialHash: baselineMaterial,
    storyFilesHash: baselineStoryFiles, promptHash: 'prompt', scopeBinding: runtimeBinding,
  } as ReviewRun;
  const proofstoryHandlers = createProofStoryHandlers({ store, root: repo, scanRoot: repo } as HandlerContext);
  const handlerResult = proofstoryHandlers.parent_ledger_rollup_set({
    storyId: runtimeStoryId,
    children: [{ storyId: 'B-child', milestoneIds: ['M1'], status: 'done', evidenceRefs: ['test:pass'] }],
  });
  assert.match(handlerResult, /Parent ledger roll-up: configured/);
  assert.match(handlerResult, /metadata auto-committed/);
  const handlerCtx = { store, root: repo, scanRoot: repo } as HandlerContext;
  const assertWriterReceipt = (artifactPath: string, writerCommand: string) => {
    const receipt = latestValidCloseoutReceipt(
      store.storyDirPath(runtimeStoryId), runtimeStoryId, artifactPath, { projectRoot: repo, metadataRoot: repo },
    );
    assert.equal(receipt?.writerCommand, writerCommand, `${writerCommand} must produce a causally valid ${artifactPath} receipt`);
  };
  assertWriterReceipt('parent-ledger-rollup.json', 'parent_ledger_rollup_set');

  createTestHandlers(handlerCtx).test_add({ storyId: runtimeStoryId, command: 'true', output: 'pass', result: 'PASS' });
  assertWriterReceipt('test-evidence.json', 'test_add');
  await createTestStoryHandlers(handlerCtx).test_story({ storyId: runtimeStoryId });
  assertWriterReceipt('test-evidence.json', 'test_story');
  createEvaluateHandlers(handlerCtx).evaluate_save({ storyId: runtimeStoryId, result: JSON.stringify({ scores: { functionality: 5, usability: 5 }, pass: true }) });
  assertWriterReceipt('eval-evidence.json', 'evaluate_save');
  createSummaryHandlers(handlerCtx).summary_set({
    storyId: runtimeStoryId,
    changes: 'Implemented causal closeout receipts.',
    usage: 'Run the canonical closeout commands.',
    limitations: 'none',
    pitfalls: 'Receipt causality must remain bound to Git history.',
  });
  assertWriterReceipt('summary.json', 'summary_set');
  const deliveryHandlers = createDeliveryCheckHandlers(handlerCtx);
  deliveryHandlers.delivery_check_set({
    storyId: runtimeStoryId,
    docsPromises: [{ docPath: 'README.md', promise: 'document behavior', status: 'unverified' }],
    realMachineTests: [],
    closingSelfCheck: { hasRealMachineTest: true, hasEdgeCaseCoverage: true, hasUnresolvedTodos: false, summary: 'Real handler integration exercised.' },
  });
  assertWriterReceipt('delivery-check.json', 'delivery_check_set');
  deliveryHandlers.delivery_waiver_add({ storyId: runtimeStoryId, promiseId: 'README.md', waiverReason: 'Integration smoke intentionally exercises the waiver writer branch.' });
  assertWriterReceipt('delivery-check.json', 'delivery_waiver_add');
  createLiveSmokeTranscriptHandlers(handlerCtx).live_smoke_transcript({ storyId: runtimeStoryId, capture: 'node -e "process.stdout.write(\'ok\')"', write: true });
  assertWriterReceipt('evidence/live-smoke-transcript.json', 'live_smoke_transcript');
  createDeliveryContextPackHandlers(handlerCtx).delivery_context_pack({ storyId: runtimeStoryId, write: true });
  assertWriterReceipt('evidence/delivery-context-pack.json', 'delivery_context_pack');
  await createDoneRequiredValidationHandlers(handlerCtx).done_required_validate({ storyId: runtimeStoryId });
  assertWriterReceipt('done-required-evidence.json', 'done_required_validate');
  await createVerifierHandlers(handlerCtx).validate({ storyId: runtimeStoryId, json: true });
  assertWriterReceipt('test-evidence.json', 'validate');
  const currentStory = store.readStory(runtimeStoryId);
  const retainedAfterHandlers = evaluateReviewRunMetadataRetention(store, currentStory, run, repo, currentScopeContextForStory(store, runtimeStoryId, repo));
  assert.equal(retainedAfterHandlers.ok, true, retainedAfterHandlers.reasons.join('; '));

  git(repo, ['checkout', '-b', 'source-drift', baselineHead]);
  writeFileSync(join(repo, 'src/app.ts'), 'export const stable = false;\n', 'utf8');
  git(repo, ['add', 'src/app.ts']);
  git(repo, ['commit', '-m', 'source drift']);
  const rejectedSource = evaluateReviewRunMetadataRetention(
    store, currentStory, run, repo, currentScopeContextForStory(store, runtimeStoryId, repo),
  );
  assert.equal(rejectedSource.ok, false);
  assert(rejectedSource.reasons.some((reason) => reason.includes('product/material diff changed')));
  git(repo, ['checkout', `story/${runtimeStoryId}`]);

  const parentReceipt = readCloseoutWriteReceipts(store.storyDirPath(runtimeStoryId)).at(-1)!;
  const incoherentReceipt = buildCloseoutWriteReceipt({
    storyId: parentReceipt.storyId,
    artifactPath: parentReceipt.artifactPath,
    writerCommand: parentReceipt.writerCommand,
    artifactDigest: parentReceipt.artifactDigest,
    phase: parentReceipt.phase,
    headHash: parentReceipt.headHash,
    materialHash: 'coherent-looking-but-wrong',
    storyFilesHash: parentReceipt.storyFilesHash,
    sequence: parentReceipt.sequence,
    previousIntegrityHash: parentReceipt.previousIntegrityHash,
    timestamp: parentReceipt.timestamp,
  });
  assert.equal(verifyCloseoutWriteReceipt(incoherentReceipt, {
    storyId: runtimeStoryId,
    artifactPath: 'parent-ledger-rollup.json',
    artifactBytes: readFileSync(store.storyFilePath(runtimeStoryId, 'parent-ledger-rollup.json')),
    projectRoot: repo,
    metadataRoot: repo,
  }).ok, false, 'integrity-valid but provenance-incoherent receipts must fail');

  writeFileSync(store.storyFilePath(runtimeStoryId, 'unknown-hand-written.json'), '{}\n', 'utf8');
  const rejectedDirty = evaluateReviewRunMetadataRetention(store, currentStory, run, repo, currentScopeContextForStory(store, runtimeStoryId, repo));
  assert.equal(rejectedDirty.ok, false);
  assert(rejectedDirty.reasons.some((reason) => reason.includes('unknown-hand-written.json')), 'uncommitted metadata must fail closed');
  rmSync(store.storyFilePath(runtimeStoryId, 'unknown-hand-written.json'));

  const summaryPath = store.storyFilePath(runtimeStoryId, 'summary.json');
  writeFileSync(summaryPath, '{"value":"A"}\n', 'utf8');
  autoCommitStoryMetadata(repo, runtimeStoryId, 'summary_set', { closeoutArtifactPaths: ['summary.json'] });
  const summaryA = readFileSync(summaryPath);
  writeFileSync(summaryPath, '{"value":"B"}\n', 'utf8');
  autoCommitStoryMetadata(repo, runtimeStoryId, 'summary_set', { closeoutArtifactPaths: ['summary.json'] });
  writeFileSync(summaryPath, summaryA);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'manual replay old summary bytes']);
  assert.equal(latestValidCloseoutReceipt(
    store.storyDirPath(runtimeStoryId), runtimeStoryId, 'summary.json', { projectRoot: repo, metadataRoot: repo },
  ), null, 'an old matching receipt must not survive a later manual revert to its bytes');

  mkdirSync(dirname(store.storyFilePath(runtimeStoryId, 'evidence/live-smoke-transcript.json')), { recursive: true });
  writeFileSync(store.storyFilePath(runtimeStoryId, 'evidence/live-smoke-transcript.json'), '{}\n', 'utf8');
  writeFileSync(store.storyFilePath(runtimeStoryId, 'evidence/transcript-diff.md'), 'manual pre-existing artifact\n', 'utf8');
  autoCommitStoryMetadata(repo, runtimeStoryId, 'live_smoke_transcript', {
    closeoutArtifactPaths: ['evidence/live-smoke-transcript.json'],
  });
  assert(latestValidCloseoutReceipt(
    store.storyDirPath(runtimeStoryId), runtimeStoryId, 'evidence/live-smoke-transcript.json', { projectRoot: repo, metadataRoot: repo },
  ));
  assert.equal(latestValidCloseoutReceipt(
    store.storyDirPath(runtimeStoryId), runtimeStoryId, 'evidence/transcript-diff.md', { projectRoot: repo, metadataRoot: repo },
  ), null, 'the auto-commit must not bless a bundled artifact omitted from the explicit write attestation');
  const rejectedBundled = evaluateReviewRunMetadataRetention(store, currentStory, run, repo, currentScopeContextForStory(store, runtimeStoryId, repo));
  assert.equal(rejectedBundled.ok, false);
  assert(rejectedBundled.reasons.some((reason) => reason.includes('evidence/transcript-diff.md')));

  assert(existsSync(store.storyFilePath(runtimeStoryId, CLOSEOUT_WRITE_RECEIPTS_PATH)));
  writeFileSync(store.storyFilePath(runtimeStoryId, 'unknown-hand-written.json'), '{}\n', 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'manual unknown metadata']);
  const rejected = evaluateReviewRunMetadataRetention(store, currentStory, run, repo, currentScopeContextForStory(store, runtimeStoryId, repo));
  assert.equal(rejected.ok, false);
  assert(rejected.reasons.some((reason) => reason.includes('unknown-hand-written.json')));

  const receiptLedgerPath = store.storyFilePath(runtimeStoryId, CLOSEOUT_WRITE_RECEIPTS_PATH);
  const originalReceiptLedger = readFileSync(receiptLedgerPath, 'utf8');
  const receiptLines = originalReceiptLedger.trimEnd().split('\n');
  const testReceiptIndexes = receiptLines
    .map((line, index) => ({ receipt: JSON.parse(line) as { artifactPath: string }, index }))
    .filter(({ receipt }) => receipt.artifactPath === 'test-evidence.json')
    .map(({ index }) => index);
  assert(testReceiptIndexes.length >= 2);
  [receiptLines[testReceiptIndexes[0]], receiptLines[testReceiptIndexes[1]]] = [receiptLines[testReceiptIndexes[1]], receiptLines[testReceiptIndexes[0]]];
  writeFileSync(receiptLedgerPath, `${receiptLines.join('\n')}\n`, 'utf8');
  assert.equal(latestValidCloseoutReceipt(store.storyDirPath(runtimeStoryId), runtimeStoryId, 'test-evidence.json'), null, 'reordered receipt chains must fail');
  writeFileSync(receiptLedgerPath, originalReceiptLedger + originalReceiptLedger.split('\n').find((line) => line.includes('parent-ledger-rollup.json')) + '\n', 'utf8');
  assert.equal(latestValidCloseoutReceipt(store.storyDirPath(runtimeStoryId), runtimeStoryId, 'parent-ledger-rollup.json'), null, 'copied receipts must fail');
} finally {
  resetConfigCache();
  rmSync(repo, { recursive: true, force: true });
}

for (const mutation of [
  { path: 'unknown.json', writer: 'parent_ledger_rollup_set', valid: true },
  { path: 'parent-ledger-rollup.json', writer: 'manual-write', valid: true },
  { path: 'parent-ledger-rollup.json', writer: 'parent_ledger_rollup_set', valid: false },
]) {
  assert.equal(evaluateMetadataOnlyReviewRetention({
    materialUnchanged: true,
    storedCompositeScopeDigest: digest,
    currentCompositeScopeDigest: digest,
    changedArtifacts: [mutation],
    storedReviewRound: 'round-1',
    currentReviewRound: 'round-1',
  }).ok, false);
}
assert.equal(evaluateMetadataOnlyReviewRetention({
  materialUnchanged: true,
  storedCompositeScopeDigest: digest,
  currentCompositeScopeDigest: digest,
  changedArtifacts: [],
  storedReviewRound: 'round-1',
  currentReviewRound: 'round-2',
}).ok, false, 'new review round must never inherit the old pass');
assert(!(COMMAND_POLICIES.scope_contract_acknowledge.allowedPhases as readonly string[]).includes('TEST'));
console.log('PASS metadata-only review retention is fail-closed');
