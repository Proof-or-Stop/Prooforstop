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
    schemaVersion,
    strictShapeValid: true,
    semanticDigestValid: true,
    signatureOrReceiptBindingValid: true,
    temporalAndMaterialBindingValid: true,
    subjectMatches: true,
    producerBoundaryTrusted: true,
  };
}

{
  assert.ok(EVIDENCE_SCOPES.includes('production-gate-decision'), 'scope dictionary includes production-gate-decision');
  assert.ok(EVIDENCE_SCOPES.includes('local-gate-evidence'), 'scope dictionary includes local-gate-evidence');
  assert.ok(ARTIFACT_ROLES.includes('authority-decision'), 'artifact role dictionary includes authority-decision');
  assert.ok(CLAIM_KINDS.includes('production-completion'), 'claim dictionary includes production-completion');
  assert.ok(ARTIFACT_CONSUMER_KINDS.includes('AUTHORITY_GATE_DECISION'), 'consumer dictionary includes AUTHORITY_GATE_DECISION');
  assert.ok(TEMPORAL_ROLES.includes('transition-relation'), 'temporal role dictionary includes transition-relation');
  assert.ok(PROOF_PRODUCER_BOUNDARIES.includes('authority-owned'), 'producer boundary dictionary includes authority-owned');
  assert.ok(ADMISSIBILITY_REASON_CODES.includes('local_diagnostic_non_gate'), 'reason dictionary includes local_diagnostic_non_gate');
}

{
  const requiredKinds = [
    'done-required-evidence',
    'delivery-check',
    'review-run',
    'authority-receipt-ref',
    'authority-receipt',
    'offline-receipt-bundle',
    'handoff-pack',
    'usage-ledger-authority-evidence',
    'repro-probe',
    'repro-review',
    'spike-record',
    'spike-review',
    'red-green-relation',
    'regression-matrix-review',
    'story-evidence-binding',
    'legacy-evidence',
  ];
  const registryKinds = new Set(listProofSurfaceDefinitions().map(definition => definition.artifactKind));
  for (const kind of requiredKinds) {
    assert.ok(registryKinds.has(kind), `registry missing ${kind}`);
  }
  assert.equal(PROOF_SURFACE_REGISTRY.length, registryKinds.size, 'registry artifactKind values must be unique');
  assert.equal(getProofSurfaceDefinition('authority-receipt-refs.json')?.artifactKind, 'authority-receipt-ref', 'aliases resolve to canonical definition');
}

{
  const result = evaluateProofAdmissibility({
    artifactKind: 'authority-receipt-ref',
    consumer: 'AUTHORITY_GATE_DECISION',
    claim: 'production-completion',
    checks: currentValidChecks('lattice.authority_receipt_refs.v1'),
  });
  assert.equal(result.allowed, true, 'matching production gate decision is allowed');
  assert.equal(result.productionDoneEligible, true, 'matching production gate decision can be productionDone eligible');
  assert.deepEqual(result.reasons, [], 'happy production gate decision has no reasons');
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
  assert.equal(doneRequiredOverread.allowed, false, 'DONE-required evidence cannot satisfy production completion');
  assert.equal(doneRequiredOverread.productionDoneEligible, false, 'DONE-required evidence cannot set productionDone');
  expectReason(doneRequiredOverread.reasons, 'artifact_consumer_mismatch', 'DONE-required production claim');
  expectReason(doneRequiredOverread.reasons, 'producer_owned_required', 'DONE-required production claim');
}

{
  const stale = evaluateProofAdmissibility({
    artifactKind: 'authority-receipt-ref',
    consumer: 'AUTHORITY_GATE_DECISION',
    claim: 'production-completion',
    checks: {
      ...currentValidChecks('lattice.authority_receipt_refs.v1'),
      temporalAndMaterialBindingValid: false,
    },
  });
  assert.equal(stale.allowed, false, 'stale material denies production gate decision');
  assert.equal(stale.productionDoneEligible, false, 'stale material cannot be productionDone eligible');
  expectReason(stale.reasons, 'stale_material', 'stale material');
}

{
  const unsupported = evaluateProofAdmissibility({
    artifactKind: 'authority-receipt-ref',
    consumer: 'AUTHORITY_GATE_DECISION',
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
  assert.equal(overread.allowed, false, 'local review quorum cannot satisfy production completion');
  expectReason(overread.reasons, 'artifact_consumer_mismatch', 'local quorum overread');
  expectReason(overread.reasons, 'producer_owned_required', 'local quorum production claim');
}

const negativeProductionControls = [
  { artifactKind: 'repro-probe', expected: 'producer_owned_required' as const },
  { artifactKind: 'handoff-pack', expected: 'local_diagnostic_non_gate' as const },
  { artifactKind: 'offline-receipt-bundle', expected: 'producer_owned_required' as const },
  { artifactKind: 'legacy-evidence', expected: 'producer_owned_required' as const },
  { artifactKind: 'authority-receipt', expected: 'producer_owned_required' as const },
];

for (const { artifactKind, expected } of negativeProductionControls) {
  const definition = getProofSurfaceDefinition(artifactKind);
  assert.ok(definition, `negative control ${artifactKind} has definition`);
  const result = evaluateProofAdmissibility({
    artifactKind,
    consumer: 'AUTHORITY_GATE_DECISION',
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
