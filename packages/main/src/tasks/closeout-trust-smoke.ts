#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CLOSEOUT_ARTIFACT_POLICIES,
  CLOSEOUT_WRITE_RECEIPTS_PATH,
  assertCanonicalCloseoutWrite,
  appendCloseoutWriteReceipt,
  buildCloseoutWriteReceipt,
  computeCompositeScopeDigest,
  evaluateMetadataOnlyReviewRetention,
  latestValidCloseoutReceipt,
  loadOrCreateReviewRoundReceiptSigner,
  loadReviewRoundReceiptSigner,
  publicReviewRoundReceiptSigner,
  readCloseoutWriteReceipts,
  signCloseoutWriteReceipt,
  reviewRoundReceiptSignerPath,
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
import { currentScopeContextForStory, evaluateReviewRunMetadataRetention, signReviewRun, verifyReviewRun } from '../core/review-run.js';
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
import { generateEd25519KeyPair } from '../core/authority-signing.js';

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
  const signerRecord = loadOrCreateReviewRoundReceiptSigner(repo, runtimeStoryId, 'round-1');
  const trustedSigner = publicReviewRoundReceiptSigner(signerRecord);
  const runtimeBinding = computeReviewScopeBinding({ contract: runtimeContract, diffPack: emptyDiff, ledger: runtimeLedger, slicePlan: runtimePlan })!;
  const run = {
    reviewRunId: `${runtimeStoryId}:RR-001`, storyId: runtimeStoryId, agent: 'lattice-review-quality', lane: 'lattice-review-quality',
    reviewRound: 'round-1', startedAt: new Date().toISOString(), headHash: baselineHead, materialHash: baselineMaterial,
    storyFilesHash: baselineStoryFiles, promptHash: 'prompt', scopeBinding: runtimeBinding, receiptSigner: trustedSigner,
  } as ReviewRun;
  run._hash = signReviewRun(
    run.storyId, run.reviewRunId, run.agent, run.lane, run.reviewRound, run.startedAt,
    run.headHash, run.materialHash, run.promptHash, run.scopeBinding?.bindingHash,
    undefined, run.storyFilesHash,
    `${trustedSigner.schemaVersion}:${trustedSigner.keyId}:${trustedSigner.publicKey}`,
  );
  assert.equal(verifyReviewRun(run), true, 'ReviewRun hash must bind the receipt signer public key');
  assert.equal(verifyReviewRun({ ...run, receiptSigner: { ...trustedSigner, publicKey: generateEd25519KeyPair().publicKey } }), false,
    'tampering the ReviewRun receipt signer public key must invalidate the run');
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
      trustedSigner,
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
    signerKeyId: trustedSigner.keyId,
  });
  assert.equal(verifyCloseoutWriteReceipt(signCloseoutWriteReceipt(incoherentReceipt, signerRecord.privateKey), {
    storyId: runtimeStoryId,
    artifactPath: 'parent-ledger-rollup.json',
    artifactBytes: readFileSync(store.storyFilePath(runtimeStoryId, 'parent-ledger-rollup.json')),
    projectRoot: repo,
    metadataRoot: repo,
    trustedSigner,
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
    trustedSigner,
  ), null, 'an old matching receipt must not survive a later manual revert to its bytes');

  mkdirSync(dirname(store.storyFilePath(runtimeStoryId, 'evidence/live-smoke-transcript.json')), { recursive: true });
  writeFileSync(store.storyFilePath(runtimeStoryId, 'evidence/live-smoke-transcript.json'), '{}\n', 'utf8');
  writeFileSync(store.storyFilePath(runtimeStoryId, 'evidence/transcript-diff.md'), 'manual pre-existing artifact\n', 'utf8');
  autoCommitStoryMetadata(repo, runtimeStoryId, 'live_smoke_transcript', {
    closeoutArtifactPaths: ['evidence/live-smoke-transcript.json'],
  });
  assert(latestValidCloseoutReceipt(
    store.storyDirPath(runtimeStoryId), runtimeStoryId, 'evidence/live-smoke-transcript.json', { projectRoot: repo, metadataRoot: repo },
    trustedSigner,
  ));
  assert.equal(latestValidCloseoutReceipt(
    store.storyDirPath(runtimeStoryId), runtimeStoryId, 'evidence/transcript-diff.md', { projectRoot: repo, metadataRoot: repo },
    trustedSigner,
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
  assert.equal(latestValidCloseoutReceipt(store.storyDirPath(runtimeStoryId), runtimeStoryId, 'test-evidence.json', undefined, trustedSigner), null, 'reordered receipt chains must fail');
  writeFileSync(receiptLedgerPath, originalReceiptLedger + originalReceiptLedger.split('\n').find((line) => line.includes('parent-ledger-rollup.json')) + '\n', 'utf8');
  assert.equal(latestValidCloseoutReceipt(store.storyDirPath(runtimeStoryId), runtimeStoryId, 'parent-ledger-rollup.json', undefined, trustedSigner), null, 'copied receipts must fail');
} finally {
  resetConfigCache();
  rmSync(repo, { recursive: true, force: true });
}

// Wrapper-root containment + review-round key rotation + manual co-commit
// forgery regression. The private key stays under wrapper runtime state while
// the story metadata is committed inside the configured gitRoot.
const wrapper = mkdtempSync(join(tmpdir(), 'closeout-wrapper-root-'));
const wrapperRepo = join(wrapper, 'repo');
try {
  mkdirSync(wrapperRepo, { recursive: true });
  writeFileSync(join(wrapper, 'lattice.config.json'), JSON.stringify({
    gitRoot: 'repo', scanRoot: 'repo', rootDir: 'src', storyDir: 'repo/.lattice/story/actives',
    testsDir: 'repo/tests', fixturesDir: 'repo/tests/fixtures', requirementsDir: 'repo/docs/requirements', storyPrefix: 'B',
  }), 'utf8');
  git(wrapperRepo, ['init', '-b', 'main']);
  git(wrapperRepo, ['config', 'user.email', 'smoke@example.test']);
  git(wrapperRepo, ['config', 'user.name', 'closeout-wrapper-smoke']);
  resetConfigCache();
  const wrapperStore = new StoryStore(wrapper);
  const wrapperStoryId = 'B-wrapper-receipt';
  wrapperStore.writeStory(wrapperStoryId, {
    storyId: wrapperStoryId, name: 'wrapper-receipt', title: 'Wrapper receipt', description: 'Wrapper-root receipt signing.',
    type: 'feature', phase: 'TEST', priority: 'high', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: null,
    currentReviewRound: 'round-1', events: [],
  });
  git(wrapperRepo, ['add', '.']);
  git(wrapperRepo, ['commit', '-m', 'wrapper baseline']);
  git(wrapperRepo, ['checkout', '-b', `story/${wrapperStoryId}`]);

  const round1Record = loadOrCreateReviewRoundReceiptSigner(wrapper, wrapperStoryId, 'round-1');
  const round1Signer = publicReviewRoundReceiptSigner(round1Record);
  writeFileSync(wrapperStore.storyFilePath(wrapperStoryId, 'summary.json'), '{"round":1}\n', 'utf8');
  assert.match(autoCommitStoryMetadata(wrapper, wrapperStoryId, 'summary_set', { closeoutArtifactPaths: ['summary.json'] }), /metadata auto-committed/);
  assert(latestValidCloseoutReceipt(
    wrapperStore.storyDirPath(wrapperStoryId), wrapperStoryId, 'summary.json',
    { projectRoot: wrapperRepo, metadataRoot: wrapper }, round1Signer,
  ), 'wrapper-root canonical write must resolve and commit the story path relative to gitRoot');

  const rotatedStory = wrapperStore.readStory(wrapperStoryId);
  rotatedStory.currentReviewRound = 'round-2';
  wrapperStore.writeStory(wrapperStoryId, rotatedStory);
  const round2Record = loadOrCreateReviewRoundReceiptSigner(wrapper, wrapperStoryId, 'round-2');
  const round2Signer = publicReviewRoundReceiptSigner(round2Record);
  writeFileSync(wrapperStore.storyFilePath(wrapperStoryId, 'summary.json'), '{"round":2}\n', 'utf8');
  assert.match(autoCommitStoryMetadata(wrapper, wrapperStoryId, 'summary_set', { closeoutArtifactPaths: ['summary.json'] }), /metadata auto-committed/);
  assert(latestValidCloseoutReceipt(
    wrapperStore.storyDirPath(wrapperStoryId), wrapperStoryId, 'summary.json',
    { projectRoot: wrapperRepo, metadataRoot: wrapper }, round2Signer,
  ), 'new review round must start a valid signer-scoped receipt subchain');
  assert.equal(latestValidCloseoutReceipt(
    wrapperStore.storyDirPath(wrapperStoryId), wrapperStoryId, 'summary.json',
    { projectRoot: wrapperRepo, metadataRoot: wrapper }, round1Signer,
  ), null, 'old review-round key must not authenticate the current artifact');
  const rotatedReceipts = readCloseoutWriteReceipts(wrapperStore.storyDirPath(wrapperStoryId)).filter(receipt => receipt.artifactPath === 'summary.json');
  assert.deepEqual(rotatedReceipts.map(receipt => [receipt.signerKeyId, receipt.sequence]), [
    [round1Signer.keyId, 1], [round2Signer.keyId, 1],
  ], 'review-round rotation retains history but resets the signer-scoped chain');

  const signerPath = reviewRoundReceiptSignerPath(wrapper, wrapperStoryId, 'round-2');
  const signerBytes = readFileSync(signerPath, 'utf8');
  const corruptRecord = JSON.parse(signerBytes) as { privateKey: string };
  corruptRecord.privateKey = generateEd25519KeyPair().privateKey;
  writeFileSync(signerPath, `${JSON.stringify(corruptRecord)}\n`, { encoding: 'utf8', mode: 0o600 });
  assert.throws(
    () => loadReviewRoundReceiptSigner(wrapper, wrapperStoryId, 'round-2'),
    /mismatched or invalid private key/,
    'a signer record with a different private key must fail before emitting receipts',
  );
  writeFileSync(signerPath, signerBytes, { encoding: 'utf8', mode: 0o600 });

  rmSync(signerPath);
  writeFileSync(wrapperStore.storyFilePath(wrapperStoryId, 'summary.json'), '{"missingKey":true}\n', 'utf8');
  const missingKeyResult = autoCommitStoryMetadata(wrapper, wrapperStoryId, 'summary_set', { closeoutArtifactPaths: ['summary.json'] });
  assert.match(missingKeyResult, /canonical closeout receipt was not issued/);
  assert.match(missingKeyResult, /return to REVIEW and start a new review run/,
    'a moved host without the round private key must surface explicit re-review guidance and never rotate silently');
  writeFileSync(signerPath, signerBytes, { encoding: 'utf8', mode: 0o600 });

  const attacker = generateEd25519KeyPair();
  const attackerKeyId = `ed25519:${createHash('sha256').update(attacker.publicKey).digest('hex')}`;
  const forgedBytes = '{"forged":true}\n';
  writeFileSync(wrapperStore.storyFilePath(wrapperStoryId, 'summary.json'), forgedBytes, 'utf8');
  const forgedReceipt = signCloseoutWriteReceipt(buildCloseoutWriteReceipt({
    storyId: wrapperStoryId,
    artifactPath: 'summary.json',
    writerCommand: 'summary_set',
    artifactDigest: createHash('sha256').update(forgedBytes).digest('hex'),
    phase: 'TEST',
    headHash: currentGitHead(wrapperRepo)!,
    materialHash: currentMaterialHash(wrapperRepo, 'HEAD', wrapper)!,
    storyFilesHash: currentStoryFilesHash(wrapperRepo, 'HEAD', wrapper)!,
    sequence: 1,
    previousIntegrityHash: null,
    signerKeyId: attackerKeyId,
  }), attacker.privateKey);
  appendCloseoutWriteReceipt(wrapperStore.storyDirPath(wrapperStoryId), forgedReceipt);
  git(wrapperRepo, ['add', '.']);
  git(wrapperRepo, ['commit', '-m', 'manual forged artifact and receipt']);
  assert.equal(latestValidCloseoutReceipt(
    wrapperStore.storyDirPath(wrapperStoryId), wrapperStoryId, 'summary.json',
    { projectRoot: wrapperRepo, metadataRoot: wrapper }, round2Signer,
  ), null, 'a self-generated artifact+receipt co-commit must fail against the exact ReviewRun signer');
} finally {
  resetConfigCache();
  rmSync(wrapper, { recursive: true, force: true });
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
