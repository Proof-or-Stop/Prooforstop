#!/usr/bin/env node
/**
 * Proof admissibility smoke — B-0985 classification-only MVP.
 *
 * Expected final output: "proof-admissibility smoke passed"
 */

import assert from 'node:assert/strict';
import {
  ADMISSIBILITY_REASON_CODES,
  ARTIFACT_CONSUMER_KINDS,
  ARTIFACT_ROLES,
  CLAIM_KINDS,
  EVIDENCE_SCOPES,
  PROOF_ADMISSIBILITY_CONTRACT_VERSION,
  PROOF_ADMISSIBILITY_VERIFIER_VERSION,
  PROOF_PRODUCER_BOUNDARIES,
  PROOF_SURFACE_REGISTRY,
  TEMPORAL_ROLES,
  evaluateProofAdmissibility,
  getProofSurfaceDefinition,
  listProofSurfaceDefinitions,
  type AdmissibilityReasonCode,
} from '../core/proof-admissibility.js';

function expectReason(
  reasons: readonly AdmissibilityReasonCode[],
  expected: AdmissibilityReasonCode,
  context: string,
): void {
  assert.ok(reasons.includes(expected), `${context}: expected reason ${expected}, got ${reasons.join(', ')}`);
}

function currentValidChecks(schemaVersion: string) {
  return {
    contractVersion: PROOF_ADMISSIBILITY_CONTRACT_VERSION,
    verifierVersion: PROOF_ADMISSIBILITY_VERIFIER_VERSION,
    schemaVersion,
    strictShapeValid: true,
    semanticDigestValid: true,
    signatureOrReceiptBindingValid: true,
    temporalAndMaterialBindingValid: true,
    subjectMatches: true,
    producerBoundaryTrusted: true,
  };
}

type RuntimeAdmissibilityChecks = Parameters<typeof evaluateProofAdmissibility>[0]['checks'];

function runtimeChecks(value: Record<string, unknown>): RuntimeAdmissibilityChecks {
  return value as RuntimeAdmissibilityChecks;
}

{
  assert.ok(EVIDENCE_SCOPES.includes('local-gate-evidence'), 'scope dictionary includes local-gate-evidence');
  assert.ok(EVIDENCE_SCOPES.includes('authority-receipt'), 'scope dictionary includes authority-receipt');
  assert.ok(EVIDENCE_SCOPES.includes('production-gate-decision'), 'scope dictionary includes production-gate-decision');
  assert.ok(ARTIFACT_ROLES.includes('authority-decision'), 'artifact role dictionary includes authority-decision');
  assert.ok(ARTIFACT_ROLES.includes('legacy-authority-decision'), 'artifact role dictionary includes legacy-authority-decision');
  assert.ok(CLAIM_KINDS.includes('production-completion'), 'claim dictionary includes production-completion');
  assert.ok(ARTIFACT_CONSUMER_KINDS.includes('AUTHORITY_GATE_DECISION'), 'consumer dictionary includes AUTHORITY_GATE_DECISION');
  assert.ok(ARTIFACT_CONSUMER_KINDS.includes('LEGACY_AUTHORITY_RECEIPT'), 'consumer dictionary includes LEGACY_AUTHORITY_RECEIPT');
  assert.ok(TEMPORAL_ROLES.includes('transition-relation'), 'temporal role dictionary includes transition-relation');
  assert.ok(PROOF_PRODUCER_BOUNDARIES.includes('authority-owned'), 'producer boundary dictionary includes authority-owned');
  assert.ok(PROOF_PRODUCER_BOUNDARIES.includes('legacy-authority-owned'), 'producer boundary dictionary includes legacy-authority-owned');
  assert.ok(ADMISSIBILITY_REASON_CODES.includes('local_diagnostic_non_gate'), 'reason dictionary includes local_diagnostic_non_gate');
  assert.ok(ADMISSIBILITY_REASON_CODES.includes('unsupported_verifier_version'), 'reason dictionary includes unsupported_verifier_version');
  assert.ok(ADMISSIBILITY_REASON_CODES.includes('checker_error'), 'reason dictionary includes checker_error');
}

{
  const requiredKinds = [
    'done-required-evidence',
    'delivery-check',
    'review-run',
    'authority-receipt-ref',
    'authority-receipt',
    'legacy-authority-receipt-ref',
    'legacy-authority-receipt',
    'offline-receipt-bundle',
    'handoff-pack',
    'usage-ledger-authority-evidence',
    'repro-probe',
    'repro-review',
    'spike-record',
    'spike-review',
    'red-green-relation',
    'red-green-relation-evaluation',
    'regression-matrix-review',
    'story-evidence-binding',
    'legacy-evidence',
  ];
  const registryKinds = new Set(listProofSurfaceDefinitions().map(definition => definition.artifactKind));
  for (const kind of requiredKinds) {
    assert.ok(registryKinds.has(kind), `registry missing ${kind}`);
  }
  assert.equal(PROOF_SURFACE_REGISTRY.length, registryKinds.size, 'registry artifactKind values must be unique');
  assert.equal(getProofSurfaceDefinition('authority-gate-decision')?.artifactKind, 'authority-receipt-ref', 'Authority-facing aliases resolve to canonical definition');
  assert.equal(getProofSurfaceDefinition('legacy-authority-receipt-refs.json')?.artifactKind, 'legacy-authority-receipt-ref', 'aliases resolve to canonical definition');
}

{
  const result = evaluateProofAdmissibility({
    artifactKind: 'authority-receipt-ref',
    consumer: 'AUTHORITY_GATE_DECISION',
    claim: 'production-completion',
    checks: currentValidChecks('lattice.external_gate_decision.v1'),
  });
  assert.equal(result.allowed, true, 'external gate decision refs can be admissible evidence for the matching adapter consumer');
  assert.equal(result.scope, 'production-gate-decision', 'external gate decision refs use production-gate-decision scope');
  assert.equal(result.productionDoneEligible, false, 'local CLI core never mints productionDone from external gate refs');
}

{
  const receiptOnly = evaluateProofAdmissibility({
    artifactKind: 'authority-receipt',
    consumer: 'AUTHORITY_GATE_DECISION',
    claim: 'production-completion',
    checks: currentValidChecks('lattice.external_receipt.v1'),
  });
  assert.equal(receiptOnly.allowed, false, 'plain external receipts cannot satisfy production-completion without gate-decision policy');
  assert.equal(receiptOnly.productionDoneEligible, false, 'plain external receipts cannot set productionDone');
  expectReason(receiptOnly.reasons, 'artifact_consumer_mismatch', 'plain receipt production-completion mismatch');
  expectReason(receiptOnly.reasons, 'producer_owned_required', 'plain receipt production-completion boundary');
}

{
  const result = evaluateProofAdmissibility({
    artifactKind: 'legacy-authority-receipt-ref',
    consumer: 'LEGACY_AUTHORITY_RECEIPT',
    claim: 'production-completion',
    checks: currentValidChecks('lattice.legacy_authority_receipt_refs.v1'),
  });
  assert.equal(result.allowed, false, 'legacy authority receipt ref is readable but cannot satisfy production-completion');
  assert.equal(result.overall, 'fail', 'legacy authority receipt ref stays out-of-core for release readiness');
  assert.equal(result.productionDoneEligible, false, 'local CLI core never turns legacy authority receipt refs into productionDone eligibility');
  expectReason(result.reasons, 'legacy_downgrade', 'legacy receipt production-completion blocked');
}

{
  const nullRequiredCheck = evaluateProofAdmissibility({
    artifactKind: 'legacy-authority-receipt-ref',
    consumer: 'LEGACY_AUTHORITY_RECEIPT',
    claim: 'production-completion',
    checks: runtimeChecks({
      ...currentValidChecks('lattice.legacy_authority_receipt_refs.v1'),
      strictShapeValid: null,
    }),
  });
  assert.equal(nullRequiredCheck.allowed, false, 'authority receipt production-completion with a null required check fails closed');
  assert.equal(nullRequiredCheck.productionDoneEligible, false, 'authority receipt production-completion with a null required check cannot set productionDone');
  expectReason(nullRequiredCheck.reasons, 'bad_shape', 'null required strictShapeValid');
}

for (const value of [false, 'true', 1, 0]) {
  const result = evaluateProofAdmissibility({
    artifactKind: 'legacy-authority-receipt-ref',
    consumer: 'LEGACY_AUTHORITY_RECEIPT',
    claim: 'production-completion',
    checks: runtimeChecks({
      ...currentValidChecks('lattice.legacy_authority_receipt_refs.v1'),
      strictShapeValid: value,
    }),
  });
  assert.equal(result.allowed, false, `authority receipt production-completion with strictShapeValid=${JSON.stringify(value)} fails closed`);
  assert.equal(result.productionDoneEligible, false, `authority receipt production-completion with strictShapeValid=${JSON.stringify(value)} cannot set productionDone`);
  expectReason(result.reasons, 'bad_shape', `non-true required strictShapeValid ${JSON.stringify(value)}`);
}

{
  const missingContractVersion = evaluateProofAdmissibility({
    artifactKind: 'legacy-authority-receipt-ref',
    consumer: 'LEGACY_AUTHORITY_RECEIPT',
    claim: 'production-completion',
    checks: runtimeChecks({
      schemaVersion: 'lattice.legacy_authority_receipt_refs.v1',
      verifierVersion: PROOF_ADMISSIBILITY_VERIFIER_VERSION,
      strictShapeValid: true,
      semanticDigestValid: true,
      signatureOrReceiptBindingValid: true,
      temporalAndMaterialBindingValid: true,
      subjectMatches: true,
      producerBoundaryTrusted: true,
    }),
  });
  assert.equal(missingContractVersion.allowed, false, 'authority receipt production-completion with all checks true but missing contractVersion fails closed');
  assert.equal(missingContractVersion.productionDoneEligible, false, 'authority receipt production-completion with missing contractVersion cannot set productionDone');
  expectReason(missingContractVersion.reasons, 'missing_required_field', 'missing contractVersion');
}

{
  const nullContractVersion = evaluateProofAdmissibility({
    artifactKind: 'legacy-authority-receipt-ref',
    consumer: 'LEGACY_AUTHORITY_RECEIPT',
    claim: 'production-completion',
    checks: runtimeChecks({
      ...currentValidChecks('lattice.legacy_authority_receipt_refs.v1'),
      contractVersion: null,
    }),
  });
  assert.equal(nullContractVersion.allowed, false, 'authority receipt production-completion with null contractVersion fails closed');
  assert.equal(nullContractVersion.productionDoneEligible, false, 'authority receipt production-completion with null contractVersion cannot set productionDone');
  expectReason(nullContractVersion.reasons, 'missing_required_field', 'null contractVersion');
}

{
  const wrongContractVersion = evaluateProofAdmissibility({
    artifactKind: 'legacy-authority-receipt-ref',
    consumer: 'LEGACY_AUTHORITY_RECEIPT',
    claim: 'production-completion',
    checks: runtimeChecks({
      ...currentValidChecks('lattice.legacy_authority_receipt_refs.v1'),
      contractVersion: 'lattice.proof_admissibility.v0',
    }),
  });
  assert.equal(wrongContractVersion.allowed, false, 'authority receipt production-completion with wrong contractVersion fails closed');
  assert.equal(wrongContractVersion.productionDoneEligible, false, 'authority receipt production-completion with wrong contractVersion cannot set productionDone');
  expectReason(wrongContractVersion.reasons, 'unsupported_contract_version', 'wrong contractVersion');
}

{
  const missingVerifierVersion = evaluateProofAdmissibility({
    artifactKind: 'legacy-authority-receipt-ref',
    consumer: 'LEGACY_AUTHORITY_RECEIPT',
    claim: 'production-completion',
    checks: runtimeChecks({
      contractVersion: PROOF_ADMISSIBILITY_CONTRACT_VERSION,
      schemaVersion: 'lattice.legacy_authority_receipt_refs.v1',
      strictShapeValid: true,
      semanticDigestValid: true,
      signatureOrReceiptBindingValid: true,
      temporalAndMaterialBindingValid: true,
      subjectMatches: true,
      producerBoundaryTrusted: true,
    }),
  });
  assert.equal(missingVerifierVersion.allowed, false, 'authority receipt production-completion with all checks true but missing verifierVersion fails closed');
  assert.equal(missingVerifierVersion.productionDoneEligible, false, 'authority receipt production-completion with missing verifierVersion cannot set productionDone');
  expectReason(missingVerifierVersion.reasons, 'missing_required_field', 'missing verifierVersion');
}

{
  const nullVerifierVersion = evaluateProofAdmissibility({
    artifactKind: 'legacy-authority-receipt-ref',
    consumer: 'LEGACY_AUTHORITY_RECEIPT',
    claim: 'production-completion',
    checks: runtimeChecks({
      ...currentValidChecks('lattice.legacy_authority_receipt_refs.v1'),
      verifierVersion: null,
    }),
  });
  assert.equal(nullVerifierVersion.allowed, false, 'authority receipt production-completion with null verifierVersion fails closed');
  assert.equal(nullVerifierVersion.productionDoneEligible, false, 'authority receipt production-completion with null verifierVersion cannot set productionDone');
  expectReason(nullVerifierVersion.reasons, 'missing_required_field', 'null verifierVersion');
}

{
  const wrongVerifierVersion = evaluateProofAdmissibility({
    artifactKind: 'legacy-authority-receipt-ref',
    consumer: 'LEGACY_AUTHORITY_RECEIPT',
    claim: 'production-completion',
    checks: runtimeChecks({
      ...currentValidChecks('lattice.legacy_authority_receipt_refs.v1'),
      verifierVersion: 'lattice.proof_admissibility_verifier.v0',
    }),
  });
  assert.equal(wrongVerifierVersion.allowed, false, 'authority receipt production-completion with wrong verifierVersion fails closed');
  assert.equal(wrongVerifierVersion.productionDoneEligible, false, 'authority receipt production-completion with wrong verifierVersion cannot set productionDone');
  expectReason(wrongVerifierVersion.reasons, 'unsupported_verifier_version', 'wrong verifierVersion');
}

{
  const missingChecks = evaluateProofAdmissibility({
    artifactKind: 'legacy-authority-receipt-ref',
    consumer: 'LEGACY_AUTHORITY_RECEIPT',
    claim: 'production-completion',
  });
  assert.equal(missingChecks.allowed, false, 'production gate decision with omitted checks fails closed');
  assert.equal(missingChecks.productionDoneEligible, false, 'production gate decision with omitted checks cannot set productionDone');
  expectReason(missingChecks.reasons, 'missing_required_field', 'missing production gate checks');
  expectReason(missingChecks.reasons, 'signature_missing', 'missing production gate checks');
  expectReason(missingChecks.reasons, 'legacy_downgrade', 'missing production gate checks');
}

{
  const doneRequired = evaluateProofAdmissibility({
    artifactKind: 'done-required-evidence',
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    checks: currentValidChecks('lattice.done_required_evidence.v1'),
  });
  assert.equal(doneRequired.allowed, true, 'DONE-required evidence can satisfy local done-readiness');
  assert.equal(doneRequired.scope, 'local-gate-evidence', 'DONE-required evidence is scoped as local gate evidence');
  assert.equal(doneRequired.productionDoneEligible, false, 'DONE-required evidence is never productionDone eligible');

  const doneRequiredOverread = evaluateProofAdmissibility({
    artifactKind: 'done-required-evidence',
    consumer: 'DONE',
    claim: 'production-completion',
    checks: currentValidChecks('lattice.done_required_evidence.v1'),
  });
  assert.equal(doneRequiredOverread.allowed, false, 'DONE-required evidence cannot satisfy release readiness');
  assert.equal(doneRequiredOverread.productionDoneEligible, false, 'DONE-required evidence cannot set productionDone');
  expectReason(doneRequiredOverread.reasons, 'artifact_consumer_mismatch', 'DONE-required production claim');
}

{
  const stale = evaluateProofAdmissibility({
    artifactKind: 'legacy-authority-receipt-ref',
    consumer: 'LEGACY_AUTHORITY_RECEIPT',
    claim: 'production-completion',
    checks: {
      ...currentValidChecks('lattice.legacy_authority_receipt_refs.v1'),
      temporalAndMaterialBindingValid: false,
    },
  });
  assert.equal(stale.allowed, false, 'stale material denies production gate decision');
  assert.equal(stale.productionDoneEligible, false, 'stale material cannot be productionDone eligible');
  expectReason(stale.reasons, 'stale_material', 'stale material');
}

{
  const unsupported = evaluateProofAdmissibility({
    artifactKind: 'legacy-authority-receipt-ref',
    consumer: 'LEGACY_AUTHORITY_RECEIPT',
    claim: 'production-completion',
    checks: currentValidChecks('legacy'),
  });
  assert.equal(unsupported.allowed, false, 'unsupported schema denies production gate decision');
  expectReason(unsupported.reasons, 'unsupported_schema_version', 'unsupported schema');
}

{
  const unknown = evaluateProofAdmissibility({
    artifactKind: 'new-proof-looking-file',
    consumer: 'DONE',
    claim: 'production-completion',
  });
  assert.equal(unknown.allowed, false, 'unknown artifact kind fails closed');
  assert.equal(unknown.scope, 'unknown');
  expectReason(unknown.reasons, 'missing_required_field', 'unknown artifact');
}

{
  const localQuorum = evaluateProofAdmissibility({
    artifactKind: 'review-run',
    consumer: 'REVIEW',
    claim: 'review-pass',
    checks: currentValidChecks('lattice.review_run.v1'),
  });
  assert.equal(localQuorum.allowed, true, 'local review quorum may satisfy local review');
  assert.equal(localQuorum.productionDoneEligible, false, 'local review quorum is never productionDone eligible');

  const overread = evaluateProofAdmissibility({
    artifactKind: 'review-run',
    consumer: 'DONE',
    claim: 'production-completion',
    checks: currentValidChecks('lattice.review_run.v1'),
  });
  assert.equal(overread.allowed, false, 'local review quorum cannot satisfy release readiness');
  expectReason(overread.reasons, 'artifact_consumer_mismatch', 'local quorum overread');
  expectReason(overread.reasons, 'producer_owned_required', 'local quorum production claim');
}

const negativeProductionControls = [
  { artifactKind: 'repro-probe', expected: 'producer_owned_required' as const },
  { artifactKind: 'handoff-pack', expected: 'local_diagnostic_non_gate' as const },
  { artifactKind: 'offline-receipt-bundle', expected: 'producer_owned_required' as const },
  { artifactKind: 'legacy-evidence', expected: 'producer_owned_required' as const },
  { artifactKind: 'legacy-authority-receipt', expected: 'producer_owned_required' as const },
];

for (const { artifactKind, expected } of negativeProductionControls) {
  const definition = getProofSurfaceDefinition(artifactKind);
  assert.ok(definition, `negative control ${artifactKind} has definition`);
  const result = evaluateProofAdmissibility({
    artifactKind,
    consumer: 'LEGACY_AUTHORITY_RECEIPT',
    claim: 'production-completion',
    checks: currentValidChecks(definition.schemaVersions[0] ?? 'missing'),
  });
  assert.equal(result.allowed, false, `${artifactKind} cannot satisfy production-completion`);
  assert.equal(result.productionDoneEligible, false, `${artifactKind} cannot set productionDone`);
  expectReason(result.reasons, expected, `${artifactKind} production negative`);
}

{
  const candidateIntake = evaluateProofAdmissibility({
    artifactKind: 'repro-probe',
    consumer: 'STORY_INTAKE',
    claim: 'historical-failure',
    checks: currentValidChecks('lattice.evidence.v1'),
  });
  assert.equal(candidateIntake.allowed, true, 'candidate repro probe can inform story intake');
  assert.equal(candidateIntake.productionDoneEligible, false, 'candidate repro probe is never productionDone eligible');

  const localDiagnosticStatus = evaluateProofAdmissibility({
    artifactKind: 'handoff-pack',
    consumer: 'HANDOFF',
    claim: 'diagnostic-status',
    checks: currentValidChecks('lattice.handoff.v1'),
  });
  assert.equal(localDiagnosticStatus.allowed, true, 'local diagnostic status is allowed for diagnostic consumer');
  assert.equal(localDiagnosticStatus.productionDoneEligible, false, 'local diagnostic status is not production proof');
}

console.log('proof-admissibility smoke passed');
