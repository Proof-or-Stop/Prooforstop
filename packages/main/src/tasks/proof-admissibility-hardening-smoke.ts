#!/usr/bin/env node
/**
 * Proof admissibility hardening smoke — B-0405 M2-M7.
 *
 * Expected final output: "proof-admissibility hardening smoke passed"
 */

import assert from 'node:assert/strict';
import {
  parseProviderEventsEnvelope,
  parseRunnerRegistration,
} from '../core/authority-runner-contracts.js';
import {
  AuthorityGateReceiptProofSchema,
  AUTHORITY_GATE_DECISION_SUBJECT_KIND,
  AUTHORITY_GATE_RECEIPT_PROOF_SCHEMA_VERSION,
} from '../core/authority-gate-receipt-verifier.js';
import {
  buildProofBindingDigestPayload,
  PROOF_BINDING_SCHEMA_VERSION,
  strictProofShape,
  verifyProofBindingDigest,
} from '../core/proof-admissibility-binding.js';
import {
  buildProofAdmissibilityDiagnostic,
} from '../core/proof-admissibility-gates.js';
import {
  buildHandoffAdmissibilitySummary,
} from '../core/proof-admissibility-handoff.js';
import {
  classifyLegacyProofEvidence,
} from '../core/proof-admissibility-legacy.js';
import {
  findReservedProofMetadataKeys,
  sanitizeCallerProofMetadata,
} from '../core/proof-admissibility-metadata.js';

function validBindingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: PROOF_BINDING_SCHEMA_VERSION,
    verifierVersion: 'hardening-smoke.v1',
    artifactKind: 'authority-receipt-ref',
    claim: 'production-completion',
    storyId: 'B-0405',
    headHash: 'h1',
    materialHash: 'm1',
    storyFilesHash: 's1',
    targetPhase: 'DONE',
    verdict: 'pass',
    reason: 'all configured high-risk proof consumers passed',
    producerId: 'authority',
    signatureDigest: 'sig-1',
    ...overrides,
  };
}

function validGateProof(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: AUTHORITY_GATE_RECEIPT_PROOF_SCHEMA_VERSION,
    proofKind: AUTHORITY_GATE_DECISION_SUBJECT_KIND,
    receipt: {
      receiptId: 'r1',
      subjectId: 'd1',
      subjectKind: AUTHORITY_GATE_DECISION_SUBJECT_KIND,
      issuedAt: '2026-06-24T00:00:00.000Z',
      authorityActorId: 'authority',
      signature: Buffer.alloc(64, 1).toString('base64'),
      subjectDigest: 'sha256:subject',
      kind: AUTHORITY_GATE_DECISION_SUBJECT_KIND,
      inputDigest: 'input',
      decisionDigest: 'decision',
      stateVersion: 1,
      serverKeyId: 'server-key',
    },
    recordId: 'ref-1',
    inputPayload: {
      projectId: 'proofbound',
      storyId: 'B-0405',
      targetPhase: 'DONE',
      repo: { headHash: 'h1', materialHash: 'm1' },
      requestedByActorId: 'actor-1',
    },
    decisionPayload: {
      decisionId: 'd1',
      storyId: 'B-0405',
      verdict: 'pass',
      targetPhase: 'DONE',
      stateVersion: 1,
      repo: { headHash: 'h1', materialHash: 'm1' },
    },
    decisionDigestPayload: {
      requestedByActorId: 'actor-1',
      decision: {
        decisionId: 'd1',
        storyId: 'B-0405',
        verdict: 'pass',
        targetPhase: 'DONE',
        stateVersion: 1,
        repo: { headHash: 'h1', materialHash: 'm1' },
      },
    },
    requestedByActorId: 'actor-1',
    serverKeyId: 'server-key',
    serverPublicKeyHex: 'a'.repeat(64),
    serverKeyProfile: 'configured',
    serverKeyProductionInert: false,
    ...overrides,
  };
}

{
  const metadata = {
    team: 'devrel',
    nested: {
      receiptVerified: true,
      keep: 'ordinary',
      linked: [{ productionDone: true, note: 'still ordinary' }],
    },
    createdVia: 'server_delegated',
  };
  const issues = findReservedProofMetadataKeys(metadata);
  assert.deepEqual(
    issues.map(issue => issue.path).sort(),
    ['createdVia', 'nested.linked.0.productionDone', 'nested.receiptVerified'],
    'M2 detects nested and linked reserved proof keys',
  );
  const stripped = sanitizeCallerProofMetadata(metadata).sanitized as Record<string, unknown>;
  assert.equal(stripped.team, 'devrel', 'M2 preserves ordinary metadata');
  assert.equal(Object.prototype.hasOwnProperty.call(stripped, 'createdVia'), false, 'M2 strips server-delegated marker');
  const nested = stripped.nested as Record<string, unknown>;
  assert.equal(nested.keep, 'ordinary', 'M2 keeps nested ordinary metadata');
  assert.equal(Object.prototype.hasOwnProperty.call(nested, 'receiptVerified'), false, 'M2 strips nested receiptVerified');

  const parsed = parseRunnerRegistration({
    actorId: 'actor',
    nonce: 'n',
    createdAt: 'now',
    runnerId: 'r',
    metadata,
  });
  assert.equal(parsed.metadata?.team, 'devrel', 'M2 runner registration keeps ordinary metadata');
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.metadata ?? {}, 'createdVia'), false, 'M2 runner registration sanitizes caller metadata');

  const parsedEvent = parseProviderEventsEnvelope({
    actorId: 'actor',
    role: 'runner',
    nonce: 'n',
    timestamp: 'now',
    providerEvent: {
      eventId: 'e',
      runId: 'run',
      provider: 'codex',
      type: 'message',
      metadata: { source: 'server_delegated', useful: true },
    },
  });
  assert.equal(parsedEvent.providerEvent.metadata?.useful, true, 'M2 provider event preserves ordinary metadata');
  assert.equal(Object.prototype.hasOwnProperty.call(parsedEvent.providerEvent.metadata ?? {}, 'source'), false, 'M2 provider event strips delegated source spoof');
}

{
  const payload = validBindingPayload();
  const bound = buildProofBindingDigestPayload(payload);
  for (const [field, value] of [
    ['reason', 'edited reason'],
    ['verdict', 'fail'],
    ['storyId', 'B-other'],
    ['headHash', 'h2'],
    ['materialHash', 'm2'],
    ['signatureDigest', 'sig-2'],
  ] as const) {
    const tampered = { ...payload, [field]: value };
    assert.equal(
      verifyProofBindingDigest(tampered, bound.digest).ok,
      false,
      `M3 ${field} tamper changes digest or fails verification`,
    );
  }
  assert.equal(strictProofShape({ ...payload, extra: true }, Object.keys(payload), Object.keys(payload)).ok, false, 'M3 rejects extra fields');
  assert.equal(strictProofShape({ ...payload, reason: null }, Object.keys(payload), Object.keys(payload)).ok, false, 'M3 rejects null semantic fields');
  assert.throws(
    () => buildProofBindingDigestPayload({ ...payload, schemaVersion: 'lattice.proof_binding.v0' }),
    /unsupported proof binding schemaVersion/,
    'M3 rejects version mismatch',
  );
}

{
  assert.equal(AuthorityGateReceiptProofSchema.safeParse(validGateProof()).success, true, 'M3 strict Authority proof accepts canonical shape');
  assert.equal(AuthorityGateReceiptProofSchema.safeParse(validGateProof({ extra: true })).success, false, 'M3 strict Authority proof rejects extra root field');
  const nullProof = validGateProof({ requestedByActorId: null });
  assert.equal(AuthorityGateReceiptProofSchema.safeParse(nullProof).success, false, 'M3 strict Authority proof rejects null required field');
}

{
  const warning = buildProofAdmissibilityDiagnostic({
    artifactKind: 'handoff-pack',
    artifactId: 'HP-local',
    consumer: 'AUTHORITY_GATE_DECISION',
    claim: 'production-completion',
    mode: 'warn',
    checks: {
      schemaVersion: 'lattice.handoff.v1',
      strictShapeValid: true,
      semanticDigestValid: true,
      subjectMatches: true,
      producerBoundaryTrusted: true,
    },
  });
  assert.equal(warning.blocking, false, 'M4 warn mode reports without blocking');
  assert.equal(warning.scope, 'local-diagnostic', 'M4 reports diagnostic scope');
  assert.ok(warning.reasons.includes('local_diagnostic_non_gate'), 'M4 reports reason code');
  assert.ok(warning.remediation.length > 0, 'M4 reports remediation');

  const enforced = buildProofAdmissibilityDiagnostic({
    ...warning,
    artifactKind: 'handoff-pack',
    consumer: 'AUTHORITY_GATE_DECISION',
    claim: 'production-completion',
    mode: 'enforce',
    checks: {
      schemaVersion: 'lattice.handoff.v1',
      strictShapeValid: true,
      semanticDigestValid: true,
      subjectMatches: true,
      producerBoundaryTrusted: true,
    },
  });
  assert.equal(enforced.blocking, true, 'M7 enforce mode blocks high-risk inadmissible proof consumer');
}

{
  assert.equal(classifyLegacyProofEvidence({ note: 'old' }).classification, 'legacy-observed', 'M5 classifies schema-less evidence as observed legacy');
  assert.equal(
    classifyLegacyProofEvidence({ schemaVersion: 'old', producer: 'local-cli', productionDone: false }).classification,
    'legacy-local-only',
    'M5 classifies local legacy evidence as local-only',
  );
  assert.equal(
    classifyLegacyProofEvidence({ schemaVersion: 'old', producer: 'mystery' }).classification,
    'legacy-unknown-producer',
    'M5 classifies unknown legacy producer',
  );
}

{
  const summary = buildHandoffAdmissibilitySummary({
    fromHost: 'codex',
    toHost: 'claude-code',
    evidenceRefs: ['CHK-001:happy:0'],
    receiptRefs: ['local-receipt'],
    admissibleProofRefs: ['authority-ref-if-already-verified'],
    quorumIdentity: 'host:codex+host:claude-code',
  });
  assert.deepEqual(summary.evidenceCandidate, ['CHK-001:happy:0'], 'M6 separates evidence candidates');
  assert.deepEqual(summary.diagnosticReceipt, ['local-receipt'], 'M6 separates diagnostic receipts');
  assert.deepEqual(summary.admissibleProofRef, ['authority-ref-if-already-verified'], 'M6 separates proof refs');
  assert.equal(summary.productionDone, false, 'M6 handoff never overclaims productionDone');
  assert.equal(summary.authorityDone, false, 'M6 handoff never overclaims authorityDone');
  assert.equal(summary.receiptVerified, false, 'M6 handoff never overclaims receipt verification');
}

console.log('proof-admissibility hardening smoke passed');
