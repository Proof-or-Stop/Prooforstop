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
  classifyCurrentCloseoutArtifactForReviewRetention,
  computeCompositeScopeDigest,
  computeCloseoutWriteReceiptIntegrity,
  evaluateMetadataOnlyReviewRetention,
  latestCausallyValidCloseoutReceipt,
  readCloseoutWriteReceipts,
  validatePersistedDeliveryContextPack,
  validateTrustedMilestoneLedger,
  validateTrustedParentLedgerRollup,
  validateTrustedSlicePlan,
  verifyCloseoutWriteReceipt,
} from '../core/closeout-trust.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { isProofOrStopLifecycleArtifactPath } from '../core/lifecycle-registry.js';
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
import { currentScopeContextForStory, evaluatePersistedReviewToTestIndexTransition, evaluateReviewRunMetadataRetention, hashReviewPrompt, signReviewRun, verifyReviewRun } from '../core/review-run.js';
import { PROMPT_ENVELOPE_ROLLOUT_VERSION, resolvePromptRoleBody } from '../core/prompt-role-contract-registry.js';
import { signFinding, signReviewPass } from '../core/finding-verify.js';
import { createStoryActor, evaluateReviewVerdict, getGuardFailureReason, getStateName } from '../core/machine.js';
import type { Finding, ReviewRun } from '../core/types.js';
import { resetConfigCache } from '../core/config.js';
import { createProofStoryHandlers } from '../handlers/proofstory.js';
import { deriveCertificationDomainInputHashes } from '../handlers/certification-window.js';
import { createTestHandlers } from '../handlers/test.js';
import { createTestStoryHandlers } from '../handlers/test-story.js';
import { createDeliveryCheckHandlers } from '../handlers/delivery-check.js';
import { createEvaluateHandlers } from '../handlers/evaluate.js';
import { createSummaryHandlers } from '../handlers/summary.js';
import { createDeliveryContextPackHandlers } from '../handlers/delivery-context-pack.js';
import { createLiveSmokeTranscriptHandlers } from '../handlers/live-smoke-transcript.js';
import { createDoneRequiredValidationHandlers } from '../handlers/done-required-validation.js';
import { createPlaybookRuntimeMemoryHandlers } from '../handlers/playbook-runtime-memory.js';
import { createVerifierHandlers } from '../handlers/verifier.js';
import type { HandlerContext } from '../handlers/context.js';
import { computeActiveReviewers } from '../handlers/reviewer-list.js';
import { createLegacyLocalOnlyDeliveryClaims } from '../core/legacy-delivery-claims-compat.js';
import { evaluateOptionalLiveSmokeTranscript } from '../core/live-smoke-transcript-evidence.js';
import { persistSyntheticAdmittedWindowForTest } from '../core/certification-window.js';
import { acquireOwnerLease } from '../core/story-owner-lease.js';

const canonicalPromptHash = (roleId: string): string => hashReviewPrompt(resolvePromptRoleBody(roleId, {
  version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
  roles: { [roleId]: 'full-envelope' },
}).body);

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
    actor: 'proof-or-stop-review-scope-plan',
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
    'topology-critic-receipt.json',
    'checklist.json',
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
  assert(isProofOrStopLifecycleArtifactPath(`.proof-or-stop/story/actives/${storyId}/${policy.path}`), `${policy.path} must be in the closed lifecycle classifier`);
  for (const writer of policy.canonicalWriters) assert(writer in COMMAND_POLICIES, `${policy.path} writer ${writer} must be a registered CLI command`);
}
assert.equal(assertCanonicalCloseoutWrite('scope-contract.json', 'scope_contract_acknowledge').artifactClass, 'scope-defining');
assert.equal(assertCanonicalCloseoutWrite('checklist.json', 'verification_evidence_refresh_stale').artifactClass, 'closeout-evidence');
assert.throws(() => assertCanonicalCloseoutWrite('checklist.json', 'checklist_update'), /non-canonical writer.*checklist/);
assert.throws(() => assertCanonicalCloseoutWrite('../parent-ledger-rollup.json', 'parent_ledger_rollup_set'), /untrusted closeout artifact path/);
assert.throws(() => assertCanonicalCloseoutWrite('parent-ledger-rollup.json', 'manual-write'), /non-canonical writer.*parent-ledger-rollup/);
console.log('PASS closeout artifact classifications: closed policy set verified');

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
  claims: createLegacyLocalOnlyDeliveryClaims(),
} as const;
validatePersistedDeliveryContextPack(deliveryPack, storyId);
const [firstLocalOnlyClaimKey] = Object.keys(deliveryPack.claims);
assert.throws(
  () => validatePersistedDeliveryContextPack({ ...deliveryPack, claims: { ...deliveryPack.claims, [firstLocalOnlyClaimKey]: true } }, storyId),
  /local-only claims must have the exact compatibility shape with false values/,
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
  storyFilesUnchanged: true,
  stableEvaluationHead: true,
  storedCompositeScopeDigest: digest,
  currentCompositeScopeDigest: digest,
  changedArtifacts: [{ path: 'parent-ledger-rollup.json', writer: 'parent_ledger_rollup_set', valid: true }],
  storedReviewRound: 'round-1',
  currentReviewRound: 'round-1',
});
assert.equal(retained.ok, true);
assert.equal(evaluateMetadataOnlyReviewRetention({
  materialUnchanged: false,
  storyFilesUnchanged: true,
  stableEvaluationHead: true,
  storedCompositeScopeDigest: digest,
  currentCompositeScopeDigest: digest,
  changedArtifacts: [{ path: 'parent-ledger-rollup.json', writer: 'parent_ledger_rollup_set', valid: true }],
  storedReviewRound: 'round-1',
  currentReviewRound: 'round-1',
}).ok, false);
assert.equal(evaluateMetadataOnlyReviewRetention({
  materialUnchanged: true,
  storyFilesUnchanged: true,
  stableEvaluationHead: true,
  storedCompositeScopeDigest: digest,
  currentCompositeScopeDigest: `${digest}-changed`,
  changedArtifacts: [{ path: 'parent-ledger-rollup.json', writer: 'parent_ledger_rollup_set', valid: true }],
  storedReviewRound: 'round-1',
  currentReviewRound: 'round-1',
}).ok, false);
assert.equal(evaluateMetadataOnlyReviewRetention({
  materialUnchanged: true,
  storyFilesUnchanged: false,
  stableEvaluationHead: true,
  storedCompositeScopeDigest: digest,
  currentCompositeScopeDigest: digest,
  changedArtifacts: [],
  storedReviewRound: 'round-1',
  currentReviewRound: 'round-1',
}).ok, false, 'story-owned drift must invalidate review retention');
assert.equal(evaluateMetadataOnlyReviewRetention({
  materialUnchanged: true,
  storyFilesUnchanged: true,
  stableEvaluationHead: false,
  storedCompositeScopeDigest: digest,
  currentCompositeScopeDigest: digest,
  changedArtifacts: [],
  storedReviewRound: 'round-1',
  currentReviewRound: 'round-1',
}).ok, false, 'concurrent HEAD movement must invalidate review retention');
console.log('PASS closeout review retention binds material, story files, scope, round, and stable HEAD');

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// Persisted lifecycle regression: reproduce the exact state write performed by
// transition-orchestrator after a successful REVIEW_PASS.  The REVIEW snapshot
// is committed first, then index.json receives only phase=TEST plus the single
// collectContext-shaped TEST/advance event.  That protocol delta is admissible;
// any additional index mutation remains fail-closed.
const indexRepo = mkdtempSync(join(tmpdir(), 'closeout-index-transition-'));
try {
  writeFileSync(join(indexRepo, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', testsDir: 'tests', fixturesDir: 'tests/fixtures', requirementsDir: 'docs/requirements', storyPrefix: 'B',
  }), 'utf8');
  mkdirSync(join(indexRepo, 'src'), { recursive: true });
  writeFileSync(join(indexRepo, 'src/app.ts'), 'export const stable = true;\n', 'utf8');
  git(indexRepo, ['init', '-b', 'main']);
  git(indexRepo, ['config', 'user.email', 'smoke@example.test']);
  git(indexRepo, ['config', 'user.name', 'closeout-smoke']);
  git(indexRepo, ['add', '.']);
  git(indexRepo, ['commit', '-m', 'repository baseline']);
  const indexStoryId = 'B-index-transition';
  git(indexRepo, ['checkout', '-b', `story/${indexStoryId}`]);
  resetConfigCache();
  const indexStore = new StoryStore(indexRepo);
  const indexRound = '2026-07-13T11:00:00.000Z';
  const indexContract = { ...contract, storyId: indexStoryId };
  const indexLedger = { ...ledger, storyId: indexStoryId };
  const indexPlan = { ...plan, storyId: indexStoryId };
  indexStore.writeStory(indexStoryId, {
    storyId: indexStoryId, name: 'index-transition', title: 'Index transition', description: 'Persist real REVIEW to TEST metadata delta.',
    type: 'feature', phase: 'REVIEW', priority: 'high', createdAt: indexRound, startedAt: indexRound, endedAt: null,
    currentReviewRound: indexRound,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: indexRound, branch: `story/${indexStoryId}`, user: 'closeout-smoke', sessionId: 'review-session', agent: 'main' }],
  });
  indexStore.writeScopeContract(indexStoryId, indexContract);
  indexStore.writeMilestoneLedger(indexStoryId, indexLedger);
  indexStore.writeProofStorySlicePlan(indexStoryId, indexPlan);
  git(indexRepo, ['add', '.']);
  git(indexRepo, ['commit', '-m', 'persist REVIEW snapshot']);
  const indexBinding = computeReviewScopeBinding({ contract: indexContract, diffPack: emptyDiff, ledger: indexLedger, slicePlan: indexPlan })!;
  const indexRun = {
    reviewRunId: `${indexStoryId}:RR-001`, storyId: indexStoryId, agent: 'proof-or-stop-review-quality', lane: 'proof-or-stop-review-quality',
    reviewRound: indexRound, startedAt: indexRound, headHash: currentGitHead(indexRepo)!, materialHash: currentMaterialHash(indexRepo, 'HEAD', indexRepo)!,
    storyFilesHash: currentStoryFilesHash(indexRepo, 'HEAD', indexRepo)!,
    promptHash: canonicalPromptHash('proof-or-stop-review-quality'),
    scopeBinding: indexBinding,
  } as ReviewRun;
  indexRun._hash = signReviewRun(
    indexRun.storyId, indexRun.reviewRunId, indexRun.agent, indexRun.lane, indexRun.reviewRound, indexRun.startedAt,
    indexRun.headHash, indexRun.materialHash, indexRun.promptHash, indexRun.scopeBinding?.bindingHash, undefined, indexRun.storyFilesHash,
  );
  const transitioned = indexStore.readStory(indexStoryId);
  git(indexRepo, ['config', '--unset', 'user.name']);
  git(indexRepo, ['config', '--unset', 'user.email']);
  assert.throws(() => git(indexRepo, ['config', '--local', 'user.name']), 'fixture must prove repository-local git user.name is absent');
  transitioned.phase = 'TEST';
  transitioned.events = [...(transitioned.events ?? []), {
    phase: 'TEST', action: 'advance', timestamp: '2026-07-13T11:01:00.000Z', branch: `story/${indexStoryId}`,
    sessionId: 'test-session', agent: 'main',
  }];
  indexStore.writeStory(indexStoryId, transitioned);
  git(indexRepo, ['add', '.']);
  git(indexRepo, ['-c', 'user.name=env-only-identity', '-c', 'user.email=env@example.test', 'commit', '-m', 'persist canonical REVIEW to TEST transition without user audit field']);
  assert.equal(evaluatePersistedReviewToTestIndexTransition(
    indexRepo, `.proof-or-stop/story/actives/${indexStoryId}/index.json`, indexRun, transitioned,
  ).ok, true);
  assert.equal(evaluateReviewRunMetadataRetention(
    indexStore, transitioned, indexRun, indexRepo, currentScopeContextForStory(indexStore, indexStoryId, indexRepo),
  ).ok, true, 'canonical persisted REVIEW to TEST index delta must retain the fresh review snapshot');

  const auditMutations = [
    { user: 'same-uid-forged-user' },
    { sessionId: 'same-uid-forged-session' },
    { agent: 'same-uid-forged-agent' },
    { timestamp: '1900-01-01T00:00:00.000Z' },
    { branch: 'same-uid-forged-branch' },
  ];
  for (const mutation of auditMutations) {
    const changedAudit = structuredClone(transitioned);
    changedAudit.events = [...(changedAudit.events ?? [])];
    changedAudit.events[changedAudit.events.length - 1] = {
      ...changedAudit.events.at(-1)!,
      ...mutation,
    };
    assert.equal(evaluatePersistedReviewToTestIndexTransition(
      indexRepo, `.proof-or-stop/story/actives/${indexStoryId}/index.json`, indexRun, changedAudit,
    ).ok, true, `${Object.keys(mutation)[0]} is same-UID-forgeable audit context and must not affect authorization`);
    assert.equal(evaluateReviewRunMetadataRetention(
      indexStore, changedAudit, indexRun, indexRepo, currentScopeContextForStory(indexStore, indexStoryId, indexRepo),
    ).ok, true, `${Object.keys(mutation)[0]} audit mutation must not add or remove review-retention authority`);
  }
  const malformedAudit = structuredClone(transitioned) as any;
  malformedAudit.events.at(-1).agent = 42;
  assert.equal(evaluatePersistedReviewToTestIndexTransition(
    indexRepo, `.proof-or-stop/story/actives/${indexStoryId}/index.json`, indexRun, malformedAudit,
  ).ok, false, 'present audit fields still require structurally valid string types');

  const tampered = indexStore.readStory(indexStoryId);
  tampered.title = 'Tampered after review';
  indexStore.writeStory(indexStoryId, tampered);
  git(indexRepo, ['add', '.']);
  git(indexRepo, ['-c', 'user.name=env-only-identity', '-c', 'user.email=env@example.test', 'commit', '-m', 'tamper index outside transition delta']);
  assert.equal(evaluatePersistedReviewToTestIndexTransition(
    indexRepo, `.proof-or-stop/story/actives/${indexStoryId}/index.json`, indexRun, tampered,
  ).ok, false);
  assert.equal(evaluateReviewRunMetadataRetention(
    indexStore, tampered, indexRun, indexRepo, currentScopeContextForStory(indexStore, indexStoryId, indexRepo),
  ).ok, false, 'extra persisted index mutation must fail closed');
} finally {
  resetConfigCache();
  rmSync(indexRepo, { recursive: true, force: true });
}
console.log('PASS persisted REVIEW-to-TEST retention delta remains bounded');

const repo = mkdtempSync(join(tmpdir(), 'closeout-retention-'));
try {
  writeFileSync(join(repo, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', testsDir: 'tests', fixturesDir: 'tests/fixtures', requirementsDir: 'docs/requirements', storyPrefix: 'B',
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
  // B-a7c5 CHK-003: canFinishGuard now ALSO requires a dev_memory_finish_decision
  // record. This fixture deliberately configures an INCOMPLETE review-lane set
  // to exercise the review_lane_missing DONE-gate diagnostic further below --
  // without a satisfying record here, that assertion would instead observe
  // missing_dev_memory_finish_decision (checked earlier in getGuardFailureReason's
  // DONE branch), masking the review_lane_missing diagnostic this fixture exists
  // to test.
  createPlaybookRuntimeMemoryHandlers({ store, root: repo, scanRoot: join(repo, 'src') })
    .dev_memory_finish_decision({ storyId: runtimeStoryId, decision: 'no-reusable-lesson', reason: 'closeout-trust-smoke fixture; no lesson to capture' });
  mkdirSync(join(repo, 'tests/fixtures'), { recursive: true });
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'baseline']);
  git(repo, ['checkout', '-b', `story/${runtimeStoryId}`]);
  const baselineHead = currentGitHead(repo)!;
  const baselineMaterial = currentMaterialHash(repo, 'HEAD', repo)!;
  const baselineStoryFiles = currentStoryFilesHash(repo, 'HEAD', repo)!;
  const baselineCausalInputHashes = deriveCertificationDomainInputHashes(repo, 'HEAD', repo);
  assert.ok(baselineCausalInputHashes, 'synthetic certification fixture must derive causal input hashes');
  const runtimeBinding = computeReviewScopeBinding({ contract: runtimeContract, diffPack: emptyDiff, ledger: runtimeLedger, slicePlan: runtimePlan })!;
  const run = {
    reviewRunId: `${runtimeStoryId}:RR-001`, storyId: runtimeStoryId, agent: 'proof-or-stop-review-quality', lane: 'proof-or-stop-review-quality',
    reviewRound: 'round-1', startedAt: new Date().toISOString(), headHash: baselineHead, materialHash: baselineMaterial,
    storyFilesHash: baselineStoryFiles,
    promptHash: canonicalPromptHash('proof-or-stop-review-quality'),
    scopeBinding: runtimeBinding,
  } as ReviewRun;
  run._hash = signReviewRun(
    run.storyId, run.reviewRunId, run.agent, run.lane, run.reviewRound, run.startedAt,
    run.headHash, run.materialHash, run.promptHash, run.scopeBinding?.bindingHash,
    undefined, run.storyFilesHash,
  );
  assert.equal(verifyReviewRun(run), true);
  const preCloseoutPassCreatedAt = new Date().toISOString();
  store.writeReviewRuns(runtimeStoryId, { runs: [run] });
  store.writeReviewPasses(runtimeStoryId, { passes: [{
    id: 'RP-001',
    agent: run.agent,
    note: 'Pre-closeout review snapshot.',
    createdAt: preCloseoutPassCreatedAt,
    reviewRound: run.reviewRound,
    reviewRunId: run.reviewRunId,
    _hash: signReviewPass(
      runtimeStoryId,
      'RP-001',
      run.agent,
      'Pre-closeout review snapshot.',
      preCloseoutPassCreatedAt,
      run.reviewRound,
      run.reviewRunId,
    ),
  }] });
  const proofstoryHandlers = createProofStoryHandlers({ store, root: repo, scanRoot: repo } as HandlerContext);
  const handlerResult = proofstoryHandlers.parent_ledger_rollup_set({
    storyId: runtimeStoryId,
    children: [{ storyId: 'B-child', milestoneIds: ['M1'], status: 'done', evidenceRefs: ['test:pass'] }],
  });
  assert.match(handlerResult, /Parent ledger roll-up: configured/);
  assert.match(handlerResult, /metadata auto-committed/);
  const handlerCtx = { store, root: repo, scanRoot: repo } as HandlerContext;
  const assertWriterReceipt = (artifactPath: string, writerCommand: string) => {
    const receipt = latestCausallyValidCloseoutReceipt(
      store.storyDirPath(runtimeStoryId), runtimeStoryId, artifactPath, { projectRoot: repo, metadataRoot: repo },
    );
    assert.equal(receipt?.writerCommand, writerCommand, `${writerCommand} must produce a causally valid ${artifactPath} receipt`);
  };
  assertWriterReceipt('parent-ledger-rollup.json', 'parent_ledger_rollup_set');

  writeFileSync(store.storyFilePath(runtimeStoryId, 'topology-critic-receipt.json'), '{"schemaVersion":"smoke"}\n', 'utf8');
  assert.match(
    autoCommitStoryMetadata(repo, runtimeStoryId, 'topology_critic_receipt_set', {
      closeoutArtifactPaths: ['topology-critic-receipt.json'],
    }),
    /metadata auto-committed/,
  );
  assertWriterReceipt('topology-critic-receipt.json', 'topology_critic_receipt_set');
  console.log('PASS canonical topology critic closeout lineage recorded');

  createTestHandlers(handlerCtx).test_add({ storyId: runtimeStoryId, command: 'true', output: 'pass', result: 'PASS' });
  assertWriterReceipt('test-evidence.json', 'test_add');
  console.log('PASS canonical test_add lineage recorded');
  await createTestStoryHandlers(handlerCtx).test_story({ storyId: runtimeStoryId });
  assertWriterReceipt('test-evidence.json', 'test_story');
  console.log('PASS canonical test_story lineage recorded');
  createEvaluateHandlers(handlerCtx).evaluate_save({ storyId: runtimeStoryId, result: JSON.stringify({ scores: { functionality: 5, usability: 5 }, pass: true }) });
  assertWriterReceipt('eval-evidence.json', 'evaluate_save');
  console.log('PASS canonical evaluate lineage recorded');
  createSummaryHandlers(handlerCtx).summary_set({
    storyId: runtimeStoryId,
    changes: 'Implemented causal closeout receipts.',
    usage: 'Run the canonical closeout commands.',
    limitations: 'none',
    pitfalls: 'Receipt causality must remain bound to Git history.',
  });
  assertWriterReceipt('summary.json', 'summary_set');
  console.log('PASS canonical summary lineage recorded');
  const deliveryHandlers = createDeliveryCheckHandlers(handlerCtx, { authorizeNativeInvocation: () => {} });
  deliveryHandlers.delivery_check_set({
    storyId: runtimeStoryId,
    docsPromises: [{ docPath: 'README.md', promise: 'document behavior', status: 'unverified' }],
    realMachineTests: [],
    closingSelfCheck: { hasRealMachineTest: true, hasEdgeCaseCoverage: true, hasUnresolvedTodos: false, summary: 'Real handler integration exercised.' },
  });
  assertWriterReceipt('delivery-check.json', 'delivery_check_set');
  console.log('PASS canonical delivery-check lineage recorded');
  deliveryHandlers.delivery_waiver_add({ storyId: runtimeStoryId, promiseId: 'README.md', waiverReason: 'Integration smoke intentionally exercises the waiver writer branch.' });
  assertWriterReceipt('delivery-check.json', 'delivery_waiver_add');
  console.log('PASS canonical delivery-waiver lineage recorded');
  const liveSmokeHandlers = createLiveSmokeTranscriptHandlers(handlerCtx);
  await liveSmokeHandlers.live_smoke_transcript({ storyId: runtimeStoryId, capture: 'node -e "process.stdout.write(\'ok\')"', write: true });
  assertWriterReceipt('evidence/live-smoke-transcript.json', 'live_smoke_transcript');
  liveSmokeHandlers.live_smoke_transcript({ storyId: runtimeStoryId, write: true });
  assertWriterReceipt('evidence/live-smoke-transcript.json', 'live_smoke_transcript');
  assert.equal(
    evaluateOptionalLiveSmokeTranscript(store, runtimeStoryId).status,
    'invalid',
    'write-only remains a causally valid canonical write but is not successful executed evidence',
  );
  await liveSmokeHandlers.live_smoke_transcript({ storyId: runtimeStoryId, capture: 'node -e "process.stdout.write(\'ok\')"', write: true });
  assert.equal(evaluateOptionalLiveSmokeTranscript(store, runtimeStoryId).status, 'valid', 'a passing capture restores valid executed evidence');
  createDeliveryContextPackHandlers(handlerCtx).delivery_context_pack({ storyId: runtimeStoryId, write: true });
  assertWriterReceipt('evidence/delivery-context-pack.json', 'delivery_context_pack');
  persistSyntheticAdmittedWindowForTest({
    store: store,
    storyId: runtimeStoryId,
    projectRoot: repo,
    causalInputHashes: baselineCausalInputHashes,
  });
  // Direct handler tests bypass the CLI ownership gate; seed the same owner
  // lease that both real story-scoped verifier commands acquire before their
  // shared causal preflight probes writer availability.
  acquireOwnerLease(store.storyDirPath(runtimeStoryId), { command: 'done_required_validate', cwd: repo });
  await createDoneRequiredValidationHandlers(handlerCtx).done_required_validate({ storyId: runtimeStoryId });
  assertWriterReceipt('done-required-evidence.json', 'done_required_validate');
  console.log('PASS canonical DONE-required lineage recorded');
  await createVerifierHandlers(handlerCtx).validate({ storyId: runtimeStoryId, json: true });
  assertWriterReceipt('test-evidence.json', 'validate');
  console.log('PASS canonical routine validation lineage recorded');
  // Make every independent DONE prerequisite current, then exercise the real
  // XState FINISH transition. The pre-closeout quality review remains fresh;
  // the independently enforced reviewer-lane quorum is the next blocker.
  deliveryHandlers.delivery_check_set({
    storyId: runtimeStoryId,
    docsPromises: [],
    realMachineTests: ['npm run test:closeout-trust'],
    closingSelfCheck: { hasRealMachineTest: true, hasEdgeCaseCoverage: true, hasUnresolvedTodos: false, summary: 'Lifecycle FINISH transition exercised.' },
  });
  const staleActor = createStoryActor(runtimeStoryId, store, 'TEST', repo, repo);
  staleActor.start();
  staleActor.send({ type: 'FINISH' });
  assert.equal(getStateName(staleActor), 'TEST', 'missing required reviewer lanes must block the actual TEST→DONE transition');
  const retainedGuardReason = getGuardFailureReason(runtimeStoryId, store, 'DONE', repo, repo) ?? '';
  assert.match(retainedGuardReason, /\[review_lane_missing\]/);
  assert.doesNotMatch(retainedGuardReason, /\[stale_closeout_review\]/);
  staleActor.stop();

  const assertDoneBlocked = (message: string, reasonCode: string) => {
    const actor = createStoryActor(runtimeStoryId, store, 'TEST', repo, repo);
    actor.start();
    actor.send({ type: 'FINISH' });
    assert.equal(getStateName(actor), 'TEST', message);
    assert.match(getGuardFailureReason(runtimeStoryId, store, 'DONE', repo, repo) ?? '', new RegExp(`\\[${reasonCode}\\]`));
    actor.stop();
  };

  const storyWithRound = store.readStory(runtimeStoryId);
  const storyWithoutRound = { ...storyWithRound };
  delete storyWithoutRound.currentReviewRound;
  store.writeStory(runtimeStoryId, storyWithoutRound);
  store.writeReviewRuns(runtimeStoryId, { runs: [] });
  store.writeReviewPasses(runtimeStoryId, { passes: [{
    id: 'RP-FORGED-NO-ROUND',
    agent: 'proof-or-stop-review-quality',
    note: 'Unsigned legacy-shaped pass must not gain authority when currentReviewRound is absent.',
    createdAt: new Date().toISOString(),
  }] });
  assert.equal(evaluateReviewVerdict({ storyId: runtimeStoryId, store, projectRoot: repo, gitCwd: repo }).code, 'review_round_missing');
  assertDoneBlocked('DONE must reject unsigned pass-shaped evidence when currentReviewRound is absent', 'review_round_missing');

  store.writeStory(runtimeStoryId, storyWithRound);
  const invalidPassCreatedAt = new Date().toISOString();
  store.writeReviewPasses(runtimeStoryId, { passes: [{
    id: 'RP-TAMPERED',
    agent: 'proof-or-stop-review-quality',
    note: 'Tampered pass.',
    createdAt: invalidPassCreatedAt,
    reviewRound: storyWithRound.currentReviewRound,
    reviewRunId: `${runtimeStoryId}:RR-NOT-REAL`,
    _hash: 'tampered',
  }] });
  assert.equal(evaluateReviewVerdict({ storyId: runtimeStoryId, store, projectRoot: repo, gitCwd: repo }).code, 'review_evidence_invalid');
  assertDoneBlocked('DONE must reject a tampered current-round pass', 'stale_closeout_review');

  const missingRunIdCreatedAt = new Date().toISOString();
  store.writeReviewPasses(runtimeStoryId, { passes: [{
    id: 'RP-MISSING-RUN-ID',
    agent: 'proof-or-stop-review-quality',
    note: 'Signed pass without reviewRunId.',
    createdAt: missingRunIdCreatedAt,
    reviewRound: storyWithRound.currentReviewRound,
    _hash: signReviewPass(
      runtimeStoryId, 'RP-MISSING-RUN-ID', 'proof-or-stop-review-quality', 'Signed pass without reviewRunId.',
      missingRunIdCreatedAt, storyWithRound.currentReviewRound!, '',
    ),
  }] });
  assert.equal(evaluateReviewVerdict({ storyId: runtimeStoryId, store, projectRoot: repo, gitCwd: repo }).code, 'review_evidence_invalid');
  assertDoneBlocked('DONE must reject a signed current-round pass without reviewRunId', 'stale_closeout_review');

  const unknownRunCreatedAt = new Date().toISOString();
  store.writeReviewPasses(runtimeStoryId, { passes: [{
    id: 'RP-UNKNOWN-RUN',
    agent: 'proof-or-stop-review-quality',
    note: 'Signed pass bound to an unknown run.',
    createdAt: unknownRunCreatedAt,
    reviewRound: storyWithRound.currentReviewRound,
    reviewRunId: `${runtimeStoryId}:RR-UNKNOWN`,
    _hash: signReviewPass(
      runtimeStoryId, 'RP-UNKNOWN-RUN', 'proof-or-stop-review-quality', 'Signed pass bound to an unknown run.',
      unknownRunCreatedAt, storyWithRound.currentReviewRound!, `${runtimeStoryId}:RR-UNKNOWN`,
    ),
  }] });
  assert.equal(evaluateReviewVerdict({ storyId: runtimeStoryId, store, projectRoot: repo, gitCwd: repo }).code, 'review_evidence_invalid');
  assertDoneBlocked('DONE must reject a signed current-round pass bound to a missing run', 'stale_closeout_review');

  store.writeReviewRuns(runtimeStoryId, { runs: [] });
  store.writeReviewPasses(runtimeStoryId, { passes: [] });
  store.writeFindings(runtimeStoryId, { findings: [] });
  assert.equal(evaluateReviewVerdict({ storyId: runtimeStoryId, store, projectRoot: repo, gitCwd: repo }).code, 'review_evidence_missing');
  const noReviewerActor = createStoryActor(runtimeStoryId, store, 'TEST', repo, repo);
  noReviewerActor.start();
  noReviewerActor.send({ type: 'FINISH' });
  assert.equal(getStateName(noReviewerActor), 'TEST', 'DONE must reject a hand-edited TEST phase with no reviewer evidence');
  assert.match(getGuardFailureReason(runtimeStoryId, store, 'DONE', repo, repo) ?? '', /\[review_evidence_missing\]/);
  noReviewerActor.stop();

  const activeReviewers = computeActiveReviewers(store.readStory(runtimeStoryId), store.readChecklist(runtimeStoryId), null, []);
  const currentHead = currentGitHead(repo)!;
  const currentMaterial = currentMaterialHash(repo, 'HEAD', repo)!;
  const currentStoryFiles = currentStoryFilesHash(repo, 'HEAD', repo)!;
  const freshRuns = activeReviewers.map((reviewer, index) => {
    const agent = `proof-or-stop-review-${reviewer.name}`;
    const freshRun = {
      ...run,
      reviewRunId: `${runtimeStoryId}:RR-${String(index + 2).padStart(3, '0')}`,
      agent,
      lane: agent,
      startedAt: new Date(Date.now() + index).toISOString(),
      headHash: currentHead,
      materialHash: currentMaterial,
      storyFilesHash: currentStoryFiles,
      promptHash: canonicalPromptHash(agent),
    } as ReviewRun;
    freshRun._hash = signReviewRun(
      freshRun.storyId, freshRun.reviewRunId, freshRun.agent, freshRun.lane, freshRun.reviewRound,
      freshRun.startedAt, freshRun.headHash, freshRun.materialHash, freshRun.promptHash,
      freshRun.scopeBinding?.bindingHash, undefined, freshRun.storyFilesHash,
    );
    return freshRun;
  });
  const freshPasses = freshRuns.map((freshRun, index) => {
    const id = `RP-${String(index + 2).padStart(3, '0')}`;
    const note = `Fresh post-closeout ${freshRun.lane} review snapshot.`;
    const createdAt = new Date(Date.now() + index).toISOString();
    return {
      id, agent: freshRun.agent, note, createdAt, reviewRound: freshRun.reviewRound, reviewRunId: freshRun.reviewRunId,
      _hash: signReviewPass(runtimeStoryId, id, freshRun.agent, note, createdAt, freshRun.reviewRound, freshRun.reviewRunId),
    };
  });

  store.writeReviewRuns(runtimeStoryId, { runs: [freshRuns[0]] });
  store.writeReviewPasses(runtimeStoryId, { passes: [freshPasses[0]] });
  const missingLaneVerdict = evaluateReviewVerdict({ storyId: runtimeStoryId, store, projectRoot: repo, gitCwd: repo });
  assert.equal(missingLaneVerdict.code, 'review_lane_missing', JSON.stringify(missingLaneVerdict));
  const missingLaneActor = createStoryActor(runtimeStoryId, store, 'TEST', repo, repo);
  missingLaneActor.start();
  missingLaneActor.send({ type: 'FINISH' });
  assert.equal(getStateName(missingLaneActor), 'TEST', 'DONE must reject missing required reviewer lanes/quorum');
  assert.match(getGuardFailureReason(runtimeStoryId, store, 'DONE', repo, repo) ?? '', /\[review_lane_missing\]/);
  missingLaneActor.stop();

  store.writeReviewRuns(runtimeStoryId, { runs: freshRuns });
  store.writeReviewPasses(runtimeStoryId, { passes: freshPasses });
  const findingCreatedAt = new Date().toISOString();
  const blockingFinding: Finding = {
    id: `${runtimeStoryId}:F-001`,
    desc: 'Verified high finding must remain blocking at DONE.',
    severity: 'high',
    category: 'adversarial',
    status: 'open',
    evidenceState: 'verified',
    agent: freshRuns[0].agent,
    createdAt: findingCreatedAt,
    reviewRound: freshRuns[0].reviewRound,
    reviewRunId: freshRuns[0].reviewRunId,
    _hash: signFinding(runtimeStoryId, `${runtimeStoryId}:F-001`, 'Verified high finding must remain blocking at DONE.', 'high', findingCreatedAt, freshRuns[0].reviewRound, freshRuns[0].reviewRunId),
  };
  store.writeFindings(runtimeStoryId, { findings: [blockingFinding] });
  assert.equal(evaluateReviewVerdict({ storyId: runtimeStoryId, store, projectRoot: repo, gitCwd: repo }).code, 'review_finding_blocking');
  const blockingFindingActor = createStoryActor(runtimeStoryId, store, 'TEST', repo, repo);
  blockingFindingActor.start();
  blockingFindingActor.send({ type: 'FINISH' });
  assert.equal(getStateName(blockingFindingActor), 'TEST', 'DONE must reject an open verified high finding after a manual phase edit');
  assert.match(getGuardFailureReason(runtimeStoryId, store, 'DONE', repo, repo) ?? '', /\[review_finding_blocking\]/);
  blockingFindingActor.stop();

  store.writeFindings(runtimeStoryId, { findings: [] });
  assert.equal(evaluateReviewVerdict({ storyId: runtimeStoryId, store, projectRoot: repo, gitCwd: repo }).ok, true);
  const freshActor = createStoryActor(runtimeStoryId, store, 'TEST', repo, repo);
  freshActor.start();
  freshActor.send({ type: 'FINISH' });
  assert.equal(getStateName(freshActor), 'DONE', 'fresh post-closeout review must allow the actual TEST→DONE transition');
  freshActor.stop();
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'record fresh review protocol metadata']);
  const currentStory = store.readStory(runtimeStoryId);
  const retainedAfterHandlers = evaluateReviewRunMetadataRetention(store, currentStory, run, repo, currentScopeContextForStory(store, runtimeStoryId, repo));
  assert.equal(retainedAfterHandlers.ok, true, retainedAfterHandlers.reasons.join('; '));
  const retainedSummary = classifyCurrentCloseoutArtifactForReviewRetention(
    store, runtimeStoryId, 'summary.json', repo, repo,
  );
  assert.equal(retainedSummary.retainsReview, true, retainedSummary.reason);

  const checklistPath = store.storyFilePath(runtimeStoryId, 'checklist.json');
  writeFileSync(checklistPath, JSON.stringify({ items: [], refreshedBy: 'verification_evidence_refresh_stale' }), 'utf8');
  assert.match(autoCommitStoryMetadata(repo, runtimeStoryId, 'verification_evidence_refresh_stale', {
    closeoutArtifactPaths: ['checklist.json'],
  }), /metadata auto-committed/);
  assertWriterReceipt('checklist.json', 'verification_evidence_refresh_stale');
  const retainedChecklist = classifyCurrentCloseoutArtifactForReviewRetention(
    store, runtimeStoryId, 'checklist.json', repo, repo,
  );
  assert.equal(retainedChecklist.retainsReview, true, retainedChecklist.reason);

  writeFileSync(checklistPath, JSON.stringify({ items: [], changedBy: 'checklist_update' }), 'utf8');
  const nonCanonicalChecklistCommit = autoCommitStoryMetadata(repo, runtimeStoryId, 'checklist_update', {
    closeoutArtifactPaths: ['checklist.json'],
  });
  assert.match(nonCanonicalChecklistCommit, /local causal closeout receipt was not issued: non-canonical writer/);
  const rejectedChecklist = classifyCurrentCloseoutArtifactForReviewRetention(
    store, runtimeStoryId, 'checklist.json', repo, repo,
  );
  assert.equal(rejectedChecklist.retainsReview, false);

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
  assert.equal(latestCausallyValidCloseoutReceipt(
    store.storyDirPath(runtimeStoryId), runtimeStoryId, 'summary.json', { projectRoot: repo, metadataRoot: repo },
  ), null, 'an old matching causal receipt must not survive a later manual revert to its bytes');

  mkdirSync(dirname(store.storyFilePath(runtimeStoryId, 'evidence/live-smoke-transcript.json')), { recursive: true });
  writeFileSync(store.storyFilePath(runtimeStoryId, 'evidence/live-smoke-transcript.json'), '{}\n', 'utf8');
  writeFileSync(store.storyFilePath(runtimeStoryId, 'evidence/transcript-diff.md'), 'manual pre-existing artifact\n', 'utf8');
  autoCommitStoryMetadata(repo, runtimeStoryId, 'live_smoke_transcript', {
    closeoutArtifactPaths: ['evidence/live-smoke-transcript.json'],
  });
  assert(latestCausallyValidCloseoutReceipt(
    store.storyDirPath(runtimeStoryId), runtimeStoryId, 'evidence/live-smoke-transcript.json', { projectRoot: repo, metadataRoot: repo },
  ));
  assert.equal(latestCausallyValidCloseoutReceipt(
    store.storyDirPath(runtimeStoryId), runtimeStoryId, 'evidence/transcript-diff.md', { projectRoot: repo, metadataRoot: repo },
  ), null, 'the auto-commit must not classify a bundled artifact omitted from the explicit write attestation');
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
  assert.equal(latestCausallyValidCloseoutReceipt(store.storyDirPath(runtimeStoryId), runtimeStoryId, 'test-evidence.json'), null, 'reordered receipt chains must fail');
  writeFileSync(receiptLedgerPath, originalReceiptLedger + originalReceiptLedger.split('\n').find((line) => line.includes('parent-ledger-rollup.json')) + '\n', 'utf8');
  assert.equal(latestCausallyValidCloseoutReceipt(store.storyDirPath(runtimeStoryId), runtimeStoryId, 'parent-ledger-rollup.json'), null, 'copied receipts must fail');
} finally {
  resetConfigCache();
  rmSync(repo, { recursive: true, force: true });
}

// Wrapper-root containment + real retention consumer + explicit hostile-same-UID
// non-goal. Local lineage may classify a nonmaterial metadata descendant for
// review freshness; specialized artifact gate validation remains independent.
const wrapper = mkdtempSync(join(tmpdir(), 'closeout-wrapper-root-'));
const wrapperRepo = join(wrapper, 'repo');
try {
  mkdirSync(wrapperRepo, { recursive: true });
  writeFileSync(join(wrapper, 'proof-or-stop.config.json'), JSON.stringify({
    gitRoot: 'repo', scanRoot: 'repo', rootDir: 'src', storyDir: 'repo/.proof-or-stop/story/actives',
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
  const wrapperContract = { ...contract, storyId: wrapperStoryId };
  const wrapperLedger = { ...ledger, storyId: wrapperStoryId };
  const wrapperPlan = { ...plan, storyId: wrapperStoryId };
  wrapperStore.writeScopeContract(wrapperStoryId, wrapperContract);
  wrapperStore.writeMilestoneLedger(wrapperStoryId, wrapperLedger);
  wrapperStore.writeProofStorySlicePlan(wrapperStoryId, wrapperPlan);
  git(wrapperRepo, ['add', '.']);
  git(wrapperRepo, ['commit', '-m', 'wrapper baseline']);
  git(wrapperRepo, ['checkout', '-b', `story/${wrapperStoryId}`]);

  const wrapperBinding = computeReviewScopeBinding({ contract: wrapperContract, diffPack: emptyDiff, ledger: wrapperLedger, slicePlan: wrapperPlan })!;
  const makeWrapperRun = (id: string): ReviewRun => ({
    reviewRunId: `${wrapperStoryId}:${id}`,
    storyId: wrapperStoryId,
    agent: 'proof-or-stop-review-quality',
    lane: 'proof-or-stop-review-quality',
    reviewRound: 'round-1',
    startedAt: new Date().toISOString(),
    headHash: currentGitHead(wrapperRepo)!,
    materialHash: currentMaterialHash(wrapperRepo, 'HEAD', wrapper)!,
    storyFilesHash: currentStoryFilesHash(wrapperRepo, 'HEAD', wrapper)!,
    promptHash: canonicalPromptHash('proof-or-stop-review-quality'),
    scopeBinding: wrapperBinding,
  });
  const preCloseoutRun = makeWrapperRun('RR-001');
  writeFileSync(wrapperStore.storyFilePath(wrapperStoryId, 'summary.json'), '{"round":1}\n', 'utf8');
  assert.match(autoCommitStoryMetadata(wrapper, wrapperStoryId, 'summary_set', { closeoutArtifactPaths: ['summary.json'] }), /metadata auto-committed/);
  assert(latestCausallyValidCloseoutReceipt(
    wrapperStore.storyDirPath(wrapperStoryId), wrapperStoryId, 'summary.json',
    { projectRoot: wrapperRepo, metadataRoot: wrapper },
  ), 'wrapper-root canonical command must still emit coherent causal telemetry');

  // A canonical writer continues the chain after a previous canonical receipt.
  const wrapperReceiptPath = join(wrapperStore.storyDirPath(wrapperStoryId), CLOSEOUT_WRITE_RECEIPTS_PATH);
  const firstWrapperReceipt = readCloseoutWriteReceipts(wrapperStore.storyDirPath(wrapperStoryId)).at(-1)!;
  const { integrityHash: _legacyIntegrityHash, ...legacyReceiptPayload } = {
    ...firstWrapperReceipt,
    schemaVersion: 'proof-or-stop.closeout_write_receipt.v3' as const,
  };
  const legacyWrapperReceipt = {
    ...legacyReceiptPayload,
    integrityHash: computeCloseoutWriteReceiptIntegrity(legacyReceiptPayload),
  };
  writeFileSync(wrapperReceiptPath, `${JSON.stringify(legacyWrapperReceipt)}\n`, 'utf8');
  writeFileSync(wrapperStore.storyFilePath(wrapperStoryId, 'summary.json'), '{"round":2}\n', 'utf8');
  assert.match(autoCommitStoryMetadata(wrapper, wrapperStoryId, 'summary_set', { closeoutArtifactPaths: ['summary.json'] }), /metadata auto-committed/);
  const chainedWrapperReceipt = readCloseoutWriteReceipts(wrapperStore.storyDirPath(wrapperStoryId)).at(-1)!;
  assert.equal(chainedWrapperReceipt.schemaVersion, 'proof-or-stop.closeout_write_receipt.v3');
  assert.equal(chainedWrapperReceipt.sequence, legacyWrapperReceipt.sequence + 1, 'canonical receipt continues after previous canonical receipt');
  assert.equal(chainedWrapperReceipt.previousIntegrityHash, legacyWrapperReceipt.integrityHash, 'canonical receipt links to canonical predecessor');

  // F-121: an unsupported schema for the same artifact must not be ignored by
  // either the trust reader or the auto-commit receipt predecessor selector.
  const supportedWrapperLedger = readFileSync(wrapperReceiptPath, 'utf8');
  const supportedWrapperHead = currentGitHead(wrapperRepo)!;
  const unsupportedWrapperReceipt = {
    ...chainedWrapperReceipt,
    schemaVersion: 'proof-or-stop.closeout_write_receipt.v999',
  };
  writeFileSync(wrapperReceiptPath, `${supportedWrapperLedger}${JSON.stringify(unsupportedWrapperReceipt)}\n`, 'utf8');
  assert.equal(
    latestCausallyValidCloseoutReceipt(wrapperStore.storyDirPath(wrapperStoryId), wrapperStoryId, 'summary.json'),
    null,
    'unsupported receipt schemas for an artifact must fail the trusted chain closed',
  );
  writeFileSync(wrapperStore.storyFilePath(wrapperStoryId, 'summary.json'), '{"round":3}\n', 'utf8');
  const refusedUnsupportedAppend = autoCommitStoryMetadata(wrapper, wrapperStoryId, 'summary_set', { closeoutArtifactPaths: ['summary.json'] });
  assert.match(refusedUnsupportedAppend, /local causal closeout receipt was not issued: unsupported closeout receipt schema/);
  const afterRefusal = readCloseoutWriteReceipts(wrapperStore.storyDirPath(wrapperStoryId));
  assert.equal(afterRefusal.filter(receipt => receipt.artifactPath === 'summary.json').length, 3, 'refusal must not append a receipt after an unsupported schema');
  git(wrapperRepo, ['reset', '--hard', supportedWrapperHead]);

  const canonicalRetention = evaluateReviewRunMetadataRetention(
    wrapperStore, wrapperStore.readStory(wrapperStoryId), preCloseoutRun, wrapperRepo,
    currentScopeContextForStory(wrapperStore, wrapperStoryId, wrapperRepo),
  );
  assert.equal(canonicalRetention.ok, true, canonicalRetention.reasons.join('; '));

  const postCloseoutRun = makeWrapperRun('RR-002');
  const retainedAfterFreshReview = evaluateReviewRunMetadataRetention(
    wrapperStore, wrapperStore.readStory(wrapperStoryId), postCloseoutRun, wrapperRepo,
    currentScopeContextForStory(wrapperStore, wrapperStoryId, wrapperRepo),
  );
  assert.equal(retainedAfterFreshReview.ok, true, retainedAfterFreshReview.reasons.join('; '));

  writeFileSync(wrapperStore.storyFilePath(wrapperStoryId, 'unknown-manual.json'), '{}\n', 'utf8');
  git(wrapperRepo, ['add', '.']);
  git(wrapperRepo, ['commit', '-m', 'wrapper unknown manual metadata']);
  const unknownRetention = evaluateReviewRunMetadataRetention(
    wrapperStore, wrapperStore.readStory(wrapperStoryId), postCloseoutRun, wrapperRepo,
    currentScopeContextForStory(wrapperStore, wrapperStoryId, wrapperRepo),
  );
  assert.equal(unknownRetention.ok, false, 'git-root-relative wrapper paths must expose committed unknown metadata');
  assert(unknownRetention.reasons.some(reason => reason.includes('unknown-manual.json')));

  const preForgeRun = makeWrapperRun('RR-003');
  const forgedBytes = '{"sameUidManualForge":true}\n';
  writeFileSync(wrapperStore.storyFilePath(wrapperStoryId, 'summary.json'), forgedBytes, 'utf8');
  const previous = readCloseoutWriteReceipts(wrapperStore.storyDirPath(wrapperStoryId))
    .filter(receipt => receipt.artifactPath === 'summary.json').at(-1)!;
  const forgedReceipt = buildCloseoutWriteReceipt({
    storyId: wrapperStoryId,
    artifactPath: 'summary.json',
    writerCommand: 'summary_set',
    artifactDigest: createHash('sha256').update(forgedBytes).digest('hex'),
    phase: 'TEST',
    headHash: currentGitHead(wrapperRepo)!,
    materialHash: currentMaterialHash(wrapperRepo, 'HEAD', wrapper)!,
    storyFilesHash: currentStoryFilesHash(wrapperRepo, 'HEAD', wrapper)!,
    sequence: previous.sequence + 1,
    previousIntegrityHash: previous.integrityHash,
  });
  appendCloseoutWriteReceipt(wrapperStore.storyDirPath(wrapperStoryId), forgedReceipt);
  git(wrapperRepo, ['add', '.']);
  git(wrapperRepo, ['commit', '-m', 'manual forged artifact and receipt']);
  assert(latestCausallyValidCloseoutReceipt(
    wrapperStore.storyDirPath(wrapperStoryId), wrapperStoryId, 'summary.json',
    { projectRoot: wrapperRepo, metadataRoot: wrapper },
  ), 'a hostile same-UID process can mint coherent lineage, which is outside this cooperative local-runtime boundary');
  const forgedRetention = evaluateReviewRunMetadataRetention(
    wrapperStore, wrapperStore.readStory(wrapperStoryId), preForgeRun, wrapperRepo,
    currentScopeContextForStory(wrapperStore, wrapperStoryId, wrapperRepo),
  );
  assert.equal(forgedRetention.ok, true, forgedRetention.reasons.join('; '));
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
console.log('review evidence retained: unchanged reviewed material; artifact gate validation remains independent');
