#!/usr/bin/env node
/**
 * Proof admissibility hardening smoke.
 *
 * Expected final output: "proof-admissibility hardening smoke passed"
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PROOF_ADMISSIBILITY_CONTRACT_VERSION,
  PROOF_ADMISSIBILITY_VERIFIER_VERSION,
  type AdmissibilityResult,
} from '../core/proof-admissibility.js';
import {
  buildProofAdmissibilityDiagnostic,
  resolveProofAdmissibilityPolicy,
  type ProofAdmissibilityPolicy,
} from '../core/proof-admissibility-gates.js';
import {
  buildProofBindingDigestPayload,
  verifyProofBindingDigest,
  PROOF_BINDING_SCHEMA_VERSION,
} from '../core/proof-admissibility-binding.js';
import { buildHandoffAdmissibilitySummary } from '../core/proof-admissibility-handoff.js';
import {
  assertNoReservedProofMetadata,
  sanitizeCallerProofMetadata,
} from '../core/proof-admissibility-metadata.js';
import { classifyLegacyProofEvidence } from '../core/proof-admissibility-legacy.js';

const enforceHighRisk: ProofAdmissibilityPolicy = {
  mode: 'enforce',
  enforcedConsumers: ['DONE_REQUIRED', 'REVIEW', 'HANDOFF', 'AUTHORITY_GATE_DECISION'],
};

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
    storyMatches: true,
    gatePhaseMatches: true,
    commandSpecDigestValid: true,
    hashTupleFresh: true,
    producerBoundaryTrusted: true,
  };
}

{
  const root = mkdtempSync(join(tmpdir(), 'proof-admissibility-policy-'));
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
    flows: { defaults: {}, patterns: [] },
    proofAdmissibility: {
      mode: 'enforce',
      enforcedConsumers: ['DONE_REQUIRED', 'AUTHORITY_GATE_DECISION'],
    },
  }, null, 2));
  const policy = resolveProofAdmissibilityPolicy(root);
  assert.equal(policy.mode, 'enforce', 'config resolves enforce mode');
  assert.deepEqual(policy.enforcedConsumers, ['DONE_REQUIRED', 'AUTHORITY_GATE_DECISION'], 'config resolves explicit enforced consumers');
}

{
  const warnDiagnostic = buildProofAdmissibilityDiagnostic({
    artifactKind: 'done-required-evidence',
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    mode: 'warn',
    checks: {
      ...currentValidChecks('lattice.done_required_evidence.v1'),
      temporalAndMaterialBindingValid: false,
    },
  });
  assert.equal(warnDiagnostic.allowed, false, 'warn-mode inadmissible DONE_REQUIRED evidence is not allowed');
  assert.equal(warnDiagnostic.blocking, false, 'warn-mode inadmissible DONE_REQUIRED evidence is diagnostic-only');

  const enforceDiagnostic = buildProofAdmissibilityDiagnostic({
    artifactKind: 'done-required-evidence',
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    policy: enforceHighRisk,
    checks: {
      ...currentValidChecks('lattice.done_required_evidence.v1'),
      temporalAndMaterialBindingValid: false,
    },
  });
  assert.equal(enforceDiagnostic.blocking, true, 'configured enforce mode blocks stale DONE_REQUIRED evidence');
  assert.ok(enforceDiagnostic.reasons.includes('stale_material'), 'stale material reason is preserved');

  const nonConfiguredConsumer = buildProofAdmissibilityDiagnostic({
    artifactKind: 'done-required-evidence',
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    policy: { mode: 'enforce', enforcedConsumers: ['AUTHORITY_GATE_DECISION'] },
    checks: {
      ...currentValidChecks('lattice.done_required_evidence.v1'),
      temporalAndMaterialBindingValid: false,
    },
  });
  assert.equal(nonConfiguredConsumer.blocking, false, 'enforce mode does not block consumers omitted from enforcedConsumers');
}

{
  const authorityPass = buildProofAdmissibilityDiagnostic({
    artifactKind: 'authority-receipt-ref',
    consumer: 'AUTHORITY_GATE_DECISION',
    claim: 'production-completion',
    policy: enforceHighRisk,
    checks: currentValidChecks('lattice.authority_gate_decision.v1'),
  });
  assert.equal(authorityPass.allowed, true, 'Authority-facing gate decision can be admissible evidence for its matching consumer');
  assert.equal(authorityPass.blocking, false, 'valid Authority-facing gate decision does not block');
  assert.equal(authorityPass.scope, 'production-gate-decision', 'Authority-facing gate decision reports production-gate-decision scope');

  const authorityStale = buildProofAdmissibilityDiagnostic({
    artifactKind: 'authority-receipt-ref',
    consumer: 'AUTHORITY_GATE_DECISION',
    claim: 'production-completion',
    policy: enforceHighRisk,
    checks: {
      ...currentValidChecks('lattice.authority_gate_decision.v1'),
      temporalAndMaterialBindingValid: false,
    },
  });
  assert.equal(authorityStale.blocking, true, 'configured enforce mode blocks stale Authority-facing proof');
  assert.equal(authorityStale.allowed, false, 'stale Authority-facing proof is not admissible');

  const plainReceipt = buildProofAdmissibilityDiagnostic({
    artifactKind: 'authority-receipt',
    consumer: 'AUTHORITY_GATE_DECISION',
    claim: 'production-completion',
    policy: enforceHighRisk,
    checks: currentValidChecks('lattice.authority_receipt.v1'),
  });
  assert.equal(plainReceipt.blocking, true, 'plain Authority receipt cannot replace a gate decision in enforce mode');
  assert.ok(plainReceipt.reasons.includes('artifact_consumer_mismatch'), 'plain receipt exposes consumer mismatch');
}

{
  const summary = buildHandoffAdmissibilitySummary({
    fromHost: 'codex',
    toHost: 'claude-code',
    admissibleProofRefs: ['local-diagnostic-ref'],
    policy: enforceHighRisk,
  });
  assert.equal(summary.productionDone, false, 'handoff summary never sets productionDone');
  assert.equal(summary.authorityDone, false, 'handoff summary never sets authorityDone');
  assert.equal(summary.fullAuthorityDone, false, 'handoff summary never sets fullAuthorityDone');
  assert.equal(summary.receiptVerified, false, 'handoff summary does not verify receipts');
  assert.equal(summary.blocked, true, 'configured enforce mode blocks inadmissible handoff proof refs');
  assert.match(summary.reasons.join('\n'), /proof_admissibility_blocked/, 'handoff block reason is surfaced');
}

{
  const reviewBlock = buildProofAdmissibilityDiagnostic({
    artifactKind: 'review-run',
    consumer: 'REVIEW',
    claim: 'review-pass',
    policy: enforceHighRisk,
    checks: {
      ...currentValidChecks('lattice.review_run.v1'),
      signatureOrReceiptBindingValid: false,
    },
  });
  assert.equal(reviewBlock.blocking, true, 'configured REVIEW enforcement blocks inadmissible review assurance');

  const checkerError = buildProofAdmissibilityDiagnostic({
    artifactKind: 'review-run',
    consumer: 'REVIEW',
    claim: 'review-pass',
    policy: enforceHighRisk,
    evaluator: (): AdmissibilityResult => {
      throw new Error('synthetic checker failure');
    },
  });
  assert.equal(checkerError.allowed, false, 'checker errors cannot satisfy proof');
  assert.equal(checkerError.overall, 'error', 'checker failures report overall=error');
  assert.equal(checkerError.blocking, false, 'checker errors are warning-only workflow recovery, not proof-open');
  assert.ok(checkerError.reasons.includes('checker_error'), 'checker_error reason is preserved');
}

{
  const callerMetadata = {
    ordinary: 'keep',
    nested: {
      productionDone: true,
      linked: [{ providerAuthorization: 'spoof' }],
    },
  };
  const stripped = sanitizeCallerProofMetadata(callerMetadata);
  assert.equal(stripped.ok, true, 'strip mode preserves workflow availability');
  assert.equal((stripped.sanitized as typeof callerMetadata).ordinary, 'keep', 'ordinary metadata is preserved');
  assert.deepEqual((stripped.sanitized as typeof callerMetadata).nested.linked[0], {}, 'nested reserved proof keys are stripped');
  assert.throws(() => assertNoReservedProofMetadata(callerMetadata), /reserved proof key/, 'reserved proof keys can be rejected');
}

{
  const payload = {
    schemaVersion: PROOF_BINDING_SCHEMA_VERSION,
    verifierVersion: 'v1',
    artifactKind: 'done-required-evidence',
    claim: 'done-readiness',
    storyId: 'B-cd3a',
    headHash: 'sha256:head',
    materialHash: 'sha256:material',
    storyFilesHash: 'sha256:story-files',
    targetPhase: 'DONE',
    verdict: 'pass',
    reason: 'all configured commands passed',
    producerId: 'done_required_validate',
    signatureDigest: 'sha256:signature',
  };
  const binding = buildProofBindingDigestPayload(payload);
  assert.equal(verifyProofBindingDigest(payload, binding.digest).ok, true, 'fresh binding digest verifies');
  const tamperedReason = verifyProofBindingDigest({ ...payload, reason: 'edited reason' }, binding.digest);
  assert.equal(tamperedReason.ok, false, 'editing a consumed reason breaks digest binding');
  assert.ok(tamperedReason.reasons.includes('digest_mismatch'), 'reason tamper reports digest_mismatch');
  assert.throws(
    () => buildProofBindingDigestPayload({ ...payload, verdict: null }),
    /shape invalid/,
    'null in a strict proof payload is rejected before digest acceptance',
  );
}

{
  const legacy = classifyLegacyProofEvidence({ productionDone: false, producer: 'local diagnostic' });
  assert.equal(legacy.scope, 'legacy-observed', 'schema-less local legacy evidence stays audit-readable only');
  assert.equal(legacy.strongProof, false, 'legacy evidence is never promoted to strong proof');
}

console.log('proof-admissibility hardening smoke passed');
