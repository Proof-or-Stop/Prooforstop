import assert from 'node:assert/strict';
import {
  buildCompleteQuantumEvidence,
  evaluateQuantumClaim,
  renderQuantumClaimCheckText,
  type QuantumClaimCheckInput,
  type QuantumClaimCheckResult,
} from '../core/claim-admissibility/quantum.js';

function hasReason(result: QuantumClaimCheckResult, code: string): boolean {
  return result.reasons.some((reason) => reason === code || reason.startsWith(`${code}:`));
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

const validEnergy = buildCompleteQuantumEvidence('Q5');
const validEnergyResult = checkPass('valid Q5 energy evidence', validEnergy);
assert.match(renderQuantumClaimCheckText(validEnergyResult), /Quantum claim-admissibility runtime status: M0-M1 implemented; M2-M5 pending\./);

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

console.log('quantum claim-admissibility smoke passed');
