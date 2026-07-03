import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCompleteQuantumEvidence,
  buildQuantumClaimCheckCase,
  evaluateQuantumClaim,
  evaluateQuantumClaimGatePolicy,
  listQuantumVerifierAdapterDescriptors,
  normalizeQuantumVerifierAdapterOutput,
  renderQuantumClaimGatePolicyText,
  renderQuantumClaimCheckText,
  QUANTUM_VERIFIER_ADAPTER_OUTPUT_VERSION,
  type QuantumEvidenceIdentity,
  type QuantumEvidenceKind,
  type QuantumVerifierAdapterId,
  type QuantumVerifierAdapterOutput,
  type QuantumVerifierNormalizationFailureCode,
  type QuantumVerifierReceipt,
  type QuantumClaimCheckInput,
  type QuantumClaimCheckResult,
  type QuantumClaimGatePolicyResult,
} from '../core/claim-admissibility/quantum.js';
import {
  CODE_RUNTIME_CLAIM_ADMISSIBILITY_PACK_ID,
  QUANTUM_CLAIM_ADMISSIBILITY_PACK_ID,
  getClaimAdmissibilityPack,
  listClaimAdmissibilityPacks,
  validateClaimAdmissibilityPacks,
} from '../core/claim-admissibility/pack-framework.js';
import { createQuantumClaimAdmissibilityHandlers } from '../handlers/quantum-claim-admissibility.js';

function hasReason(result: { reasons: readonly string[] }, code: string): boolean {
  return result.reasons.some((reason) => reason === code || reason.startsWith(`${code}:`));
}

function expectDeterministicInputError(label: string, fn: () => unknown, expectedMessage: RegExp): void {
  assert.throws(
    fn,
    (error: unknown): boolean => {
      assert.ok(error instanceof Error, `${label} should throw an Error`);
      assert.equal(error instanceof TypeError, false, `${label} should not leak a raw TypeError`);
      assert.match(error.message, expectedMessage, `${label} should report a deterministic validation message`);
      return true;
    },
    `${label} should fail closed`,
  );
  console.log(`${label}: INPUT BLOCK`);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectUnique(label: string, values: readonly string[]): void {
  assert.equal(new Set(values).size, values.length, `${label} should not contain duplicate ids: ${values.join(', ')}`);
}

function expectRuntimeFrozenArray(label: string, values: readonly string[] | undefined, mutationValue: string): void {
  assert.ok(values, `${label} should be exposed`);
  const original = [...values];
  assert.equal(Object.isFrozen(values), true, `${label} should be frozen at runtime`);
  assert.throws(
    () => {
      (values as unknown as string[]).push(mutationValue);
    },
    TypeError,
    `${label} should reject mutation through registry descriptors`,
  );
  assert.deepEqual(values, original, `${label} should remain unchanged after mutation attempt`);
}

function requireActiveIdentity(input: QuantumClaimCheckInput): Partial<QuantumEvidenceIdentity> {
  assert.ok(input.activeIdentity, 'test fixture should include active identity');
  return input.activeIdentity;
}

function adapterOutput(
  adapterId: QuantumVerifierAdapterId,
  evidenceKind: QuantumEvidenceKind,
  identity: Partial<QuantumEvidenceIdentity>,
  overrides: Partial<QuantumVerifierAdapterOutput> = {},
): QuantumVerifierAdapterOutput {
  return {
    adapterId,
    outputVersion: QUANTUM_VERIFIER_ADAPTER_OUTPUT_VERSION,
    evidenceKind,
    status: 'pass',
    exitCode: 0,
    identity: { ...identity },
    verifierScriptHash: identity.verifierScriptHash,
    outputDigest: identity.outputDigest,
    observedAt: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

function expectNormalizedPass(
  label: string,
  output: QuantumVerifierAdapterOutput,
  activeIdentity: Partial<QuantumEvidenceIdentity>,
): QuantumVerifierReceipt {
  const normalized = normalizeQuantumVerifierAdapterOutput(output, activeIdentity);
  const blockedReasons = normalized.ok ? 'none' : normalized.reasons.join(', ');
  assert.equal(normalized.ok, true, `${label} should normalize: ${blockedReasons}`);
  if (!normalized.ok) throw new Error(`${label} unexpectedly blocked`);
  assert.equal(normalized.receipt.status, 'pass', `${label} returns a passing receipt`);
  assert.equal(normalized.receipt.exitCode, 0, `${label} returns a zero-exit receipt`);
  console.log(`${label}: NORMALIZED`);
  return normalized.receipt;
}

function expectNormalizedBlock(
  label: string,
  output: QuantumVerifierAdapterOutput,
  activeIdentity: Partial<QuantumEvidenceIdentity>,
  reasonCode: QuantumVerifierNormalizationFailureCode,
): void {
  const normalized = normalizeQuantumVerifierAdapterOutput(output, activeIdentity);
  assert.equal(normalized.ok, false, `${label} should fail closed`);
  if (normalized.ok) throw new Error(`${label} unexpectedly normalized`);
  assert.equal(normalized.reason, reasonCode, `${label} should block with ${reasonCode}; got ${normalized.reason}`);
  assert.ok(
    normalized.reasons.some((reason) => reason === reasonCode || reason.startsWith(`${reasonCode}:`)),
    `${label} should include deterministic ${reasonCode}; got ${normalized.reasons.join(', ')}`,
  );
  console.log(`${label}: NORMALIZATION BLOCK`);
}

function checkPass(label: string, input: QuantumClaimCheckInput): QuantumClaimCheckResult {
  const result = evaluateQuantumClaim(input);
  assert.equal(result.allowed, true, `${label} should be allowed: ${result.reasons.join(', ')}`);
  assert.equal(result.nextAction, 'advance', `${label} should advance`);
  assert.equal(result.scopedClaim, true, `${label} remains scoped to computational identity`);
  assert.equal(result.boundary.quantumTheoryClaim, false, `${label} must not claim quantum theory proof`);
  assert.equal(result.boundary.hardwareValidationClaim, false, `${label} must not claim hardware validation`);
  assert.equal(result.boundary.solverImprovementClaim, false, `${label} must not claim solver improvement`);
  assert.equal(result.boundary.productionClaim, false, `${label} must not claim production deployment`);
  assert.equal(result.boundary.authorityClaim, false, `${label} must not claim Authority`);
  console.log(`${label}: PASS`);
  return result;
}

function checkBlock(label: string, input: QuantumClaimCheckInput, reasonCode: string): QuantumClaimCheckResult {
  const result = evaluateQuantumClaim(input);
  assert.equal(result.allowed, false, `${label} should be blocked`);
  assert.ok(hasReason(result, reasonCode), `${label} should include ${reasonCode}; got ${result.reasons.join(', ')}`);
  console.log(`${label}: BLOCK`);
  return result;
}

function checkGateDecision(
  label: string,
  input: QuantumClaimCheckInput,
  decision: QuantumClaimGatePolicyResult['decision'],
): QuantumClaimGatePolicyResult {
  const result = evaluateQuantumClaimGatePolicy(input);
  assert.equal(result.decision, decision, `${label} should decide ${decision}; got ${result.decision} with ${result.reasons.join(', ')}`);
  assert.equal(result.localClaimAdmissibilityOnly, true, `${label} remains local claim-admissibility only`);
  assert.equal(result.writesLifecycleEvidence, false, `${label} writes no lifecycle evidence`);
  assert.equal(result.mutatesLifecycle, false, `${label} mutates no lifecycle state`);
  assert.equal(result.boundary.productionClaim, false, `${label} keeps boundary.productionClaim false`);
  assert.equal(result.boundary.authorityClaim, false, `${label} keeps boundary.authorityClaim false`);
  if (decision === 'advance') {
    assert.equal(result.allowed, true, `${label} advance is the only allowed gate-policy pass`);
  } else {
    assert.equal(result.allowed, false, `${label} must not hard-pass non-advance decisions`);
  }
  console.log(`${label}: PASS`);
  return result;
}

{
  const expectedAdapters: readonly [QuantumVerifierAdapterId, readonly QuantumEvidenceKind[]][] = [
    ['quantum.hamiltonian-spec', ['hamiltonian-freeze']],
    ['quantum.basis-grid', ['basis-grid-freeze']],
    ['quantum.solver-output', ['solver-run', 'energy-eigenvalue']],
    ['quantum.normalization', ['normalization']],
    ['quantum.unitarity-probability-conservation', ['unitarity']],
    ['quantum.convergence', ['convergence']],
    ['quantum.reference-comparison', ['reference-comparison']],
    ['quantum.reproducibility', ['reproducibility']],
    ['quantum.figure-table-provenance', ['figure-table-provenance']],
  ];
  const adapters = listQuantumVerifierAdapterDescriptors();
  assert.deepEqual(adapters.map((adapter) => adapter.id), expectedAdapters.map(([id]) => id), 'known M2 adapter ids remain stable');
  for (const [adapterId, evidenceKinds] of expectedAdapters) {
    const adapter = adapters.find((candidate) => candidate.id === adapterId);
    assert.ok(adapter, `${adapterId} descriptor is listed`);
    assert.deepEqual(
      adapter.evidenceProfiles.map((profile) => profile.evidenceKind),
      evidenceKinds,
      `${adapterId} evidence kinds remain stable`,
    );
    assert.equal(adapter.executionBoundary, 'read-receipt-only', `${adapterId} is descriptor/read-only receipt ingestion`);
    assert.deepEqual(adapter.supportedOutputVersions, [QUANTUM_VERIFIER_ADAPTER_OUTPUT_VERSION], `${adapterId} has stable output version`);
    assert.equal('commandSpec' in adapter, false, `${adapterId} does not declare an external command`);
    assert.equal(adapter.claimBoundary.quantumTheoryClaim, false, `${adapterId} must not claim theory proof`);
    assert.equal(adapter.claimBoundary.hardwareValidationClaim, false, `${adapterId} must not claim hardware validation`);
    assert.equal(adapter.claimBoundary.solverImprovementClaim, false, `${adapterId} must not claim solver improvement`);
    assert.equal(adapter.claimBoundary.productionClaim, false, `${adapterId} must not claim production`);
    assert.equal(adapter.claimBoundary.authorityClaim, false, `${adapterId} must not claim Authority`);
  }
  expectUnique('quantum adapter descriptors', adapters.map((adapter) => adapter.id));
  console.log('quantum verifier adapter descriptors listed');
}

{
  const packs = listClaimAdmissibilityPacks();
  const packIds = packs.map((pack) => pack.id);
  assert.ok(packIds.includes(CODE_RUNTIME_CLAIM_ADMISSIBILITY_PACK_ID), 'registry lists code-runtime pack');
  assert.ok(packIds.includes(QUANTUM_CLAIM_ADMISSIBILITY_PACK_ID), 'registry lists quantum pack');
  assert.equal(validateClaimAdmissibilityPacks().ok, true, 'default pack registry validates');
  const listedQuantumPack = packs.find((pack) => pack.id === QUANTUM_CLAIM_ADMISSIBILITY_PACK_ID);
  assert.ok(listedQuantumPack, 'listClaimAdmissibilityPacks exposes quantum pack');
  expectRuntimeFrozenArray('listed quantum claimIds', listedQuantumPack.claimSchemas[0]?.claimIds, 'Q-mutated');
  expectRuntimeFrozenArray('listed quantum artifactKinds', listedQuantumPack.evidenceSchemas[0]?.artifactKinds, 'mutated-kind');

  const lookup = getClaimAdmissibilityPack(QUANTUM_CLAIM_ADMISSIBILITY_PACK_ID);
  assert.equal(lookup.status, 'found', 'quantum pack resolves from registry');
  if (lookup.status !== 'found') throw new Error('quantum pack lookup unexpectedly failed');
  const quantumPack = lookup.pack;
  assert.equal(Object.isFrozen(quantumPack), true, 'quantum pack descriptor is frozen/read-only');
  assert.equal(quantumPack.boundary.mutation, 'read-only', 'quantum pack is read-only');
  assert.equal(quantumPack.boundary.declaration, 'declarative-only', 'quantum pack is declarative-only');
  assert.equal(quantumPack.boundary.createsStorage, false, 'quantum pack creates no storage');
  assert.equal(quantumPack.boundary.createsLedger, false, 'quantum pack creates no ledger');
  assert.equal(quantumPack.boundary.createsLifecycleGate, false, 'quantum pack creates no lifecycle gates');
  assert.equal(quantumPack.boundary.completionEligible, false, 'quantum pack cannot make completion claims');
  assert.equal(quantumPack.gatePolicies.length, 0, 'quantum pack has no lifecycle gate policies');
  assert.equal(quantumPack.proofSurfaces.length, 0, 'quantum pack does not add proof-surface storage roots');
  assert.ok(quantumPack.verifierAdapters.length > 0, 'quantum pack exposes verifier adapters');
  assert.ok(
    quantumPack.verifierAdapters.every((adapter) => adapter.executionBoundary === 'read-receipt-only' && adapter.commandSpec === undefined),
    'quantum pack adapters do not execute external commands',
  );
  expectUnique('quantum pack adapter ids', quantumPack.verifierAdapters.map((adapter) => adapter.id));
  expectUnique('quantum pack claim schema ids', quantumPack.claimSchemas.map((schema) => schema.id));
  expectUnique('quantum pack evidence schema ids', quantumPack.evidenceSchemas.map((schema) => schema.id));
  const quantumPackJson = JSON.stringify(quantumPack);
  assert.equal(quantumPackJson.includes('storageRoot'), false, 'quantum pack advertises no storage root');
  assert.equal(quantumPackJson.includes('storageRoots'), false, 'quantum pack advertises no storage roots');
  assert.equal(quantumPackJson.includes('"completionEligible":true'), false, 'quantum pack advertises no completion claim');
  assert.equal(quantumPackJson.includes('"createsLifecycleGate":true'), false, 'quantum pack advertises no lifecycle gate');
  console.log('quantum pack registry descriptor is read-only');
}

{
  const normalizedEnergy = buildCompleteQuantumEvidence('Q5');
  const activeIdentity = requireActiveIdentity(normalizedEnergy);
  const baseOutput = adapterOutput('quantum.solver-output', 'energy-eigenvalue', activeIdentity);
  const normalizedReceipt = expectNormalizedPass('valid quantum adapter output', baseOutput, activeIdentity);
  checkPass('normalized Q5 adapter receipt', {
    ...normalizedEnergy,
    receipts: [normalizedReceipt],
  });

  expectNormalizedBlock(
    'unknown quantum adapter id',
    { ...baseOutput, adapterId: 'quantum.unknown' },
    activeIdentity,
    'unknown_adapter_id',
  );
  expectNormalizedBlock(
    'unsupported quantum adapter output version',
    { ...baseOutput, outputVersion: 'lattice.quantum_verifier_adapter_output.v0' },
    activeIdentity,
    'unsupported_output_version',
  );
  expectNormalizedBlock(
    'missing quantum adapter output identity',
    { ...baseOutput, identity: undefined },
    activeIdentity,
    'missing_output_identity',
  );
  expectNormalizedBlock(
    'stale quantum adapter output',
    { ...baseOutput, stale: true },
    activeIdentity,
    'stale_output',
  );
  expectNormalizedBlock(
    'failing quantum adapter output',
    { ...baseOutput, status: 'fail' },
    activeIdentity,
    'output_status_not_pass',
  );
  expectNormalizedBlock(
    'mismatched adapter hamiltonianHash',
    { ...baseOutput, identity: { ...activeIdentity, hamiltonianHash: 'sha256:mismatched-hamiltonian' } },
    activeIdentity,
    'identity_mismatch',
  );
  expectNormalizedBlock(
    'mismatched adapter gridHash',
    { ...baseOutput, identity: { ...activeIdentity, gridHash: 'sha256:mismatched-grid' } },
    activeIdentity,
    'identity_mismatch',
  );
  expectNormalizedBlock(
    'mismatched adapter verifierScriptHash',
    { ...baseOutput, verifierScriptHash: 'sha256:mismatched-verifier-script' },
    activeIdentity,
    'verifier_script_mismatch',
  );
  expectNormalizedBlock(
    'mismatched adapter outputDigest',
    { ...baseOutput, outputDigest: 'sha256:mismatched-output' },
    activeIdentity,
    'output_digest_mismatch',
  );
}

const validEnergy = buildCompleteQuantumEvidence('Q5');
const validEnergyResult = checkPass('valid Q5 energy evidence', validEnergy);
assert.match(renderQuantumClaimCheckText(validEnergyResult), /Quantum claim-admissibility runtime status: M0-M3 implemented; M4-M5 pending\./);

const completeGate = checkGateDecision('quantum M3 complete gate-policy case', buildQuantumClaimCheckCase('complete'), 'advance');
assert.equal(completeGate.transition, 'claim-admissibility', 'complete gate policy is claim-admissibility scoped');
assert.equal(completeGate.claimId, 'Q5', 'complete case defaults to Q5');
const completeGateText = renderQuantumClaimGatePolicyText(completeGate);
assert.match(completeGateText, /decision: advance/);
assert.match(completeGateText, /localClaimAdmissibilityOnly: true/);
assert.match(completeGateText, /writesLifecycleEvidence: false/);
assert.match(completeGateText, /mutatesLifecycle: false/);
assert.match(completeGateText, /productionClaim: false/);
assert.match(completeGateText, /authorityClaim: false/);

const degradedGate = checkGateDecision('quantum M3 weak/degraded gate-policy case', buildQuantumClaimCheckCase('degraded'), 'degrade');
assert.ok(hasReason(degradedGate, 'weak_evidence_overclaim'), 'degraded gate has weak_evidence_overclaim reason');
assert.equal(degradedGate.degradedClaimAvailable, true, 'weak Q5 evidence degrades to a scoped claim instead of hard-passing');

const validBasisOnlyEnergy = buildCompleteQuantumEvidence('Q5');
delete validBasisOnlyEnergy.activeIdentity?.gridHash;
if (validBasisOnlyEnergy.receipts?.[0]) {
  delete validBasisOnlyEnergy.receipts[0].identity.gridHash;
}
checkPass('valid Q5 basis-set-only evidence', validBasisOnlyEnergy);

checkPass('valid figure provenance', buildCompleteQuantumEvidence('Q12'));

const deterministic = buildCompleteQuantumEvidence('Q4');
delete deterministic.activeIdentity?.randomSeed;
delete deterministic.activeIdentity?.timeStepHash;
if (deterministic.receipts?.[0]) {
  delete deterministic.receipts[0].identity.randomSeed;
  delete deterministic.receipts[0].identity.timeStepHash;
}
checkPass('deterministic optional fields', deterministic);

const missingCore = buildCompleteQuantumEvidence('Q5');
delete missingCore.activeIdentity?.codeHash;
checkBlock('missing core fields', missingCore, 'missing_core_identity_field');

checkBlock('unknown claim', { ...buildCompleteQuantumEvidence('Q5'), claimId: 'Q404' }, 'unknown_claim');

const omittedConditional = buildCompleteQuantumEvidence('Q7');
delete omittedConditional.activeIdentity?.timeStepHash;
checkBlock('omitted conditional field', omittedConditional, 'missing_conditional_identity_field');

const mismatchedHamiltonian = buildCompleteQuantumEvidence('Q5');
if (mismatchedHamiltonian.activeIdentity) mismatchedHamiltonian.activeIdentity.hamiltonianHash = 'sha256:mismatched-hamiltonian';
checkBlock('mismatched hamiltonianHash', mismatchedHamiltonian, 'identity_mismatch');

const mismatchedGrid = buildCompleteQuantumEvidence('Q5');
if (mismatchedGrid.activeIdentity) mismatchedGrid.activeIdentity.gridHash = 'sha256:mismatched-grid';
checkBlock('mismatched gridHash', mismatchedGrid, 'identity_mismatch');

const mismatchedBasis = buildCompleteQuantumEvidence('Q5');
delete mismatchedBasis.activeIdentity?.gridHash;
if (mismatchedBasis.receipts?.[0]) {
  delete mismatchedBasis.receipts[0].identity.gridHash;
  mismatchedBasis.receipts[0].identity.basisSetHash = 'sha256:mismatched-basis-set';
}
checkBlock('mismatched basisSetHash', mismatchedBasis, 'identity_mismatch');

const missingBasisOrGrid = buildCompleteQuantumEvidence('Q5');
delete missingBasisOrGrid.activeIdentity?.basisSetHash;
delete missingBasisOrGrid.activeIdentity?.gridHash;
if (missingBasisOrGrid.receipts?.[0]) {
  delete missingBasisOrGrid.receipts[0].identity.basisSetHash;
  delete missingBasisOrGrid.receipts[0].identity.gridHash;
}
checkBlock('missing basis/grid identity', missingBasisOrGrid, 'missing_basis_or_grid_identity');

const missingBasisOrGridOverclaim = deepClone(missingBasisOrGrid);
missingBasisOrGridOverclaim.requestedStrength = 'ground-state';
const missingBasisOrGridOverclaimResult = checkBlock(
  'missing basis/grid identity with weak overclaim',
  missingBasisOrGridOverclaim,
  'missing_basis_or_grid_identity',
);
assert.ok(
  hasReason(missingBasisOrGridOverclaimResult, 'weak_evidence_overclaim'),
  'missing basis/grid overclaim should retain weak_evidence_overclaim reason',
);
assert.equal(
  missingBasisOrGridOverclaimResult.nextAction,
  'stop',
  'missing basis/grid identity must stop even when weak overclaim is present',
);
assert.equal(
  missingBasisOrGridOverclaimResult.scopedClaim,
  false,
  'missing basis/grid identity must not expose scoped degradation',
);

const mismatchedVerifier = buildCompleteQuantumEvidence('Q5');
if (mismatchedVerifier.activeIdentity) mismatchedVerifier.activeIdentity.verifierScriptHash = 'sha256:mismatched-verifier-script';
checkBlock('mismatched verifierScriptHash', mismatchedVerifier, 'verifier_script_mismatch');

const missingRequiredReceipt = buildCompleteQuantumEvidence('Q5');
missingRequiredReceipt.receipts = [];
checkBlock('missing required receipt', missingRequiredReceipt, 'missing_required_receipt');

const staleEvidence = buildCompleteQuantumEvidence('Q5');
if (staleEvidence.receipts?.[0]) {
  staleEvidence.receipts[0].stale = true;
}
checkBlock('stale evidence', staleEvidence, 'stale_evidence');

const staleOverclaim = buildCompleteQuantumEvidence('Q5');
staleOverclaim.requestedStrength = 'ground-state';
if (staleOverclaim.receipts?.[0]) {
  staleOverclaim.receipts[0].stale = true;
}
const staleOverclaimResult = checkBlock('weak ground-state overclaim with stale evidence', staleOverclaim, 'stale_evidence');
assert.ok(hasReason(staleOverclaimResult, 'weak_evidence_overclaim'), 'combined stale overclaim should retain weak_evidence_overclaim reason');
assert.equal(staleOverclaimResult.nextAction, 'stop', 'stale evidence must stop even when weak overclaim is present');
assert.equal(staleOverclaimResult.scopedClaim, false, 'stale evidence must not expose scoped degradation');

const unboundSolverOutput = buildCompleteQuantumEvidence('Q4');
if (unboundSolverOutput.receipts?.[0]) {
  delete unboundSolverOutput.receipts[0].identity.outputDigest;
  delete unboundSolverOutput.receipts[0].outputDigest;
}
checkBlock('unbound solver output', unboundSolverOutput, 'unbound_solver_output');

const staleGate = checkGateDecision('quantum M3 stale gate-policy case', buildQuantumClaimCheckCase('stale'), 'stop');
assert.ok(hasReason(staleGate, 'stale_evidence'), 'stale gate stops on stale_evidence');
const missingGate = checkGateDecision('quantum M3 missing gate-policy case', buildQuantumClaimCheckCase('missing'), 'repair');
assert.ok(hasReason(missingGate, 'missing_required_receipt'), 'missing gate repairs missing required receipt');
const mismatchedGate = checkGateDecision('quantum M3 mismatched gate-policy case', buildQuantumClaimCheckCase('mismatched'), 'stop');
assert.ok(hasReason(mismatchedGate, 'identity_mismatch'), 'mismatched gate stops on identity_mismatch');
const unboundGate = checkGateDecision('quantum M3 unbound gate-policy case', buildQuantumClaimCheckCase('unbound'), 'stop');
assert.ok(hasReason(unboundGate, 'unbound_solver_output'), 'unbound gate stops on unbound solver output');

const mismatchedSolverOutputDigest = buildCompleteQuantumEvidence('Q4');
if (mismatchedSolverOutputDigest.receipts?.[0]) {
  mismatchedSolverOutputDigest.receipts[0].outputDigest = 'sha256:mismatched-solver-output';
}
const mismatchedSolverOutputDigestResult = checkBlock(
  'mismatched top-level solver output digest',
  mismatchedSolverOutputDigest,
  'output_digest_mismatch',
);
assert.equal(mismatchedSolverOutputDigestResult.nextAction, 'stop', 'mismatched solver output digest must stop');
assert.equal(mismatchedSolverOutputDigestResult.scopedClaim, false, 'mismatched solver output digest must not expose scoped claim');

const mismatchedEnergyOutputDigest = buildCompleteQuantumEvidence('Q5');
if (mismatchedEnergyOutputDigest.receipts?.[0]) {
  mismatchedEnergyOutputDigest.receipts[0].outputDigest = 'sha256:mismatched-energy-output';
}
const mismatchedEnergyOutputDigestResult = checkBlock(
  'mismatched top-level energy output digest',
  mismatchedEnergyOutputDigest,
  'output_digest_mismatch',
);
assert.equal(mismatchedEnergyOutputDigestResult.nextAction, 'stop', 'mismatched energy output digest must stop');
assert.equal(mismatchedEnergyOutputDigestResult.scopedClaim, false, 'mismatched energy output digest must not expose scoped claim');

const mismatchedFigureOutputDigest = buildCompleteQuantumEvidence('Q12');
if (mismatchedFigureOutputDigest.receipts?.[0]) {
  mismatchedFigureOutputDigest.receipts[0].outputDigest = 'sha256:mismatched-figure-output';
}
const mismatchedFigureOutputDigestResult = checkBlock(
  'mismatched top-level figure provenance output digest',
  mismatchedFigureOutputDigest,
  'output_digest_mismatch',
);
assert.equal(mismatchedFigureOutputDigestResult.nextAction, 'stop', 'mismatched figure output digest must stop');
assert.equal(mismatchedFigureOutputDigestResult.scopedClaim, false, 'mismatched figure output digest must not expose scoped claim');

const missingReceiptIdentity = buildCompleteQuantumEvidence('Q4');
const receiptWithoutIdentity = missingReceiptIdentity.receipts?.[0] as { identity?: unknown } | undefined;
if (receiptWithoutIdentity) {
  delete receiptWithoutIdentity.identity;
}
const missingReceiptIdentityResult = checkBlock('missing receipt identity', missingReceiptIdentity, 'missing_receipt_identity');
assert.equal(missingReceiptIdentityResult.nextAction, 'stop', 'missing receipt identity must stop');
assert.equal(missingReceiptIdentityResult.scopedClaim, false, 'missing receipt identity must not expose scoped claim');

const unboundPlotTable = buildCompleteQuantumEvidence('Q12');
if (unboundPlotTable.receipts?.[0]) {
  delete unboundPlotTable.receipts[0].identity.sourceRunId;
  delete unboundPlotTable.receipts[0].identity.plotScriptHash;
  delete unboundPlotTable.receipts[0].identity.plotConfigHash;
}
checkBlock('unbound plot/table', unboundPlotTable, 'unbound_plot_table');

for (const strength of ['ground-state', 'convergence', 'quantum-advantage'] as const) {
  const stronger = deepClone(validEnergy);
  stronger.requestedStrength = strength;
  const result = checkBlock(`weak single-run energy evidence cannot prove stronger ${strength} claim`, stronger, 'weak_evidence_overclaim');
  assert.equal(result.nextAction, 'degrade', `${strength} overclaim should degrade to scoped energy`);
  assert.equal(result.scopedClaim, true, `${strength} overclaim should expose weaker scoped claim`);
}

const productionOverclaim = buildCompleteQuantumEvidence('Q5');
productionOverclaim.requestedStrength = 'production';
checkBlock('production boundary overclaim', productionOverclaim, 'claim_boundary_violation');

const overclaimGate = checkGateDecision('quantum M3 overclaim gate-policy case', buildQuantumClaimCheckCase('overclaim'), 'stop');
assert.ok(hasReason(overclaimGate, 'claim_boundary_violation'), 'overclaim gate stops on boundary violation');
assert.equal(overclaimGate.boundary.hardwareValidationClaim, false, 'overclaim output still refuses hardware validation');
assert.equal(overclaimGate.boundary.quantumTheoryClaim, false, 'overclaim output still refuses theory validation');

for (const requestedStrength of ['theory', 'hardware', 'physical-validation', 'solver-improvement', 'production', 'authority'] as const) {
  const input = buildCompleteQuantumEvidence('Q5');
  input.requestedStrength = requestedStrength;
  const result = checkGateDecision(`quantum M3 hard ${requestedStrength} overclaim gate-policy case`, input, 'stop');
  assert.ok(hasReason(result, 'claim_boundary_violation'), `${requestedStrength} overclaim has boundary violation`);
}

const directInvalidRequestedStrength = buildCompleteQuantumEvidence('Q5');
(directInvalidRequestedStrength as unknown as Record<string, unknown>).requestedStrength = 'productionn';
const directInvalidRequestedStrengthGate = checkGateDecision(
  'quantum M3 invalid requestedStrength core gate-policy case',
  directInvalidRequestedStrength,
  'stop',
);
assert.ok(
  hasReason(directInvalidRequestedStrengthGate, 'invalid_requested_strength'),
  'direct invalid requestedStrength has validation reason',
);

const directAuthorityClaim = buildCompleteQuantumEvidence('Q5');
(directAuthorityClaim as unknown as Record<string, unknown>).authorityClaim = true;
const directAuthorityClaimGate = checkGateDecision('quantum M3 direct Authority claim overclaim gate-policy case', directAuthorityClaim, 'stop');
assert.ok(hasReason(directAuthorityClaimGate, 'claim_boundary_violation'), 'direct authorityClaim field has boundary violation');

const theoryNarrative = buildCompleteQuantumEvidence('Q5');
theoryNarrative.narrativeClaim = 'quantum theory proven';
const theoryNarrativeGate = checkGateDecision('quantum M3 narrative theory overclaim gate-policy case', theoryNarrative, 'stop');
assert.ok(hasReason(theoryNarrativeGate, 'claim_boundary_violation'), 'theory narrative has boundary violation');

const hardwareNarrative = buildCompleteQuantumEvidence('Q5');
hardwareNarrative.narrativeClaim = 'hardware validation complete';
const hardwareNarrativeGate = checkGateDecision('quantum M3 narrative hardware overclaim gate-policy case', hardwareNarrative, 'stop');
assert.ok(hasReason(hardwareNarrativeGate, 'claim_boundary_violation'), 'hardware narrative has boundary violation');

const handlers = createQuantumClaimAdmissibilityHandlers({} as any);
const handlerComplete = handlers.quantum_claim_check({ case: 'complete', format: 'json' }) as QuantumClaimGatePolicyResult;
assert.equal(handlerComplete.decision, 'advance', 'handler complete JSON advances');
assert.equal(handlerComplete.boundary.productionClaim, false, 'handler complete JSON boundary.productionClaim false');
assert.equal(handlerComplete.boundary.authorityClaim, false, 'handler complete JSON boundary.authorityClaim false');
const handlerCompleteQ12 = handlers.quantum_claim_check({
  case: 'complete',
  claimId: 'Q12',
  requestedStrength: 'scoped',
  format: 'json',
}) as QuantumClaimGatePolicyResult;
assert.equal(handlerCompleteQ12.decision, 'advance', 'handler complete Q12 JSON advances');
assert.equal(handlerCompleteQ12.claimId, 'Q12', 'handler complete Q12 preserves requested claimId');
const handlerDegraded = handlers.quantum_claim_check({ case: 'degraded', format: 'json' }) as QuantumClaimGatePolicyResult;
assert.equal(handlerDegraded.decision, 'degrade', 'handler degraded JSON degrades');
const handlerOverclaimText = handlers.quantum_claim_check({ case: 'overclaim' }) as string;
assert.match(handlerOverclaimText, /decision: stop/, 'handler overclaim text stops');
assert.match(handlerOverclaimText, /productionClaim: false/, 'handler overclaim text boundary.productionClaim false');
assert.match(handlerOverclaimText, /authorityClaim: false/, 'handler overclaim text boundary.authorityClaim false');
expectDeterministicInputError(
  'handler invalid requestedStrength',
  () => handlers.quantum_claim_check({ case: 'complete', requestedStrength: 'productionn', format: 'json' } as any),
  /Unknown quantum requestedStrength: productionn/,
);
expectDeterministicInputError(
  'handler invalid built-in claimId',
  () => handlers.quantum_claim_check({ case: 'complete', claimId: 'Q404', format: 'json' } as any),
  /Unknown quantum claimId: Q404/,
);
expectDeterministicInputError(
  'core complete fixture invalid claimId',
  () => buildQuantumClaimCheckCase('complete', 'Q404' as any),
  /Unknown quantum claimId: Q404/,
);
const directCompleteEvidenceJson = JSON.stringify(buildCompleteQuantumEvidence('Q5'));
const directCompleteEvidenceObject = JSON.parse(directCompleteEvidenceJson) as QuantumClaimCheckInput;
for (const blankEvidenceJson of ['', '   ']) {
  assert.throws(
    () => handlers.quantum_claim_check({ evidenceJson: blankEvidenceJson, format: 'json' } as any),
    /evidenceJson must be a non-empty JSON object/,
    'handler blank evidenceJson fails closed instead of falling back to complete fixture',
  );
}
assert.throws(
  () => handlers.quantum_claim_check({ evidenceJson: '[]', format: 'json' } as any),
  /evidenceJson must be a JSON object/,
  'handler evidenceJson arrays fail closed instead of falling back to complete fixture',
);
assert.throws(
  () => handlers.quantum_claim_check({ evidenceJson: '{', format: 'json' } as any),
  SyntaxError,
  'handler malformed evidenceJson fails closed instead of falling back to complete fixture',
);
const invalidRequestedStrengthEvidence = buildCompleteQuantumEvidence('Q5');
(invalidRequestedStrengthEvidence as unknown as Record<string, unknown>).requestedStrength = 'productionn';
const handlerEvidenceJsonInvalidRequestedStrength = handlers.quantum_claim_check({
  evidenceJson: JSON.stringify(invalidRequestedStrengthEvidence),
  format: 'json',
}) as QuantumClaimGatePolicyResult;
assert.equal(handlerEvidenceJsonInvalidRequestedStrength.decision, 'stop', 'handler evidenceJson invalid requestedStrength stops');
assert.equal(handlerEvidenceJsonInvalidRequestedStrength.allowed, false, 'handler evidenceJson invalid requestedStrength fails closed');
assert.ok(
  hasReason(handlerEvidenceJsonInvalidRequestedStrength, 'invalid_requested_strength'),
  'handler evidenceJson invalid requestedStrength has validation reason',
);
const handlerEvidenceJsonOverclaim = handlers.quantum_claim_check({
  evidenceJson: directCompleteEvidenceJson,
  requestedStrength: 'production',
  format: 'json',
}) as QuantumClaimGatePolicyResult;
assert.equal(handlerEvidenceJsonOverclaim.decision, 'stop', 'handler evidenceJson requestedStrength=production stops');
assert.equal(handlerEvidenceJsonOverclaim.allowed, false, 'handler evidenceJson requestedStrength=production fails closed');
assert.ok(
  hasReason(handlerEvidenceJsonOverclaim, 'claim_boundary_violation'),
  'handler evidenceJson requestedStrength=production has boundary violation',
);
assert.equal(handlerEvidenceJsonOverclaim.boundary.productionClaim, false, 'handler evidenceJson overclaim boundary.productionClaim false');
assert.equal(handlerEvidenceJsonOverclaim.boundary.authorityClaim, false, 'handler evidenceJson overclaim boundary.authorityClaim false');
const handlerParsedEvidenceJsonOverclaim = handlers.quantum_claim_check({
  evidenceJson: directCompleteEvidenceObject as unknown as Record<string, unknown>,
  requestedStrength: 'production',
  format: 'json',
}) as QuantumClaimGatePolicyResult;
assert.equal(handlerParsedEvidenceJsonOverclaim.decision, 'stop', 'handler parsed evidenceJson requestedStrength=production stops');
assert.equal(handlerParsedEvidenceJsonOverclaim.allowed, false, 'handler parsed evidenceJson requestedStrength=production fails closed');
assert.ok(
  hasReason(handlerParsedEvidenceJsonOverclaim, 'claim_boundary_violation'),
  'handler parsed evidenceJson requestedStrength=production has boundary violation',
);
const evidencePathRoot = mkdtempSync(join(tmpdir(), 'quantum-claim-admissibility-'));
const directCompleteEvidencePath = join(evidencePathRoot, 'complete-q5.json');
try {
  writeFileSync(directCompleteEvidencePath, directCompleteEvidenceJson);
  const handlerEvidencePathOverclaim = handlers.quantum_claim_check({
    evidencePath: directCompleteEvidencePath,
    requestedStrength: 'production',
    format: 'json',
  }) as QuantumClaimGatePolicyResult;
  assert.equal(handlerEvidencePathOverclaim.decision, 'stop', 'handler evidencePath requestedStrength=production stops');
  assert.equal(handlerEvidencePathOverclaim.allowed, false, 'handler evidencePath requestedStrength=production fails closed');
  assert.ok(
    hasReason(handlerEvidencePathOverclaim, 'claim_boundary_violation'),
    'handler evidencePath requestedStrength=production has boundary violation',
  );
} finally {
  rmSync(evidencePathRoot, { recursive: true, force: true });
}
assert.throws(
  () => handlers.quantum_claim_check({ productionClaim: true } as any),
  /refuses unsupported/,
  'handler rejects productionClaim overclaim flag',
);
console.log('quantum M3 handler gate-policy cases: PASS');

console.log('quantum claim-admissibility smoke passed');
