#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import {
  CLOSEOUT_ARTIFACT_POLICIES,
  assertCanonicalCloseoutWrite,
  computeCompositeScopeDigest,
  evaluateMetadataOnlyReviewRetention,
  validatePersistedDeliveryContextPack,
  validateTrustedMilestoneLedger,
  validateTrustedParentLedgerRollup,
  validateTrustedSlicePlan,
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
    'evidence/transcript-diff.md',
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
