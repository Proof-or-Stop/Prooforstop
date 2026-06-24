#!/usr/bin/env node
/**
 * Proof admissibility hardening smoke — B-0405 M2-M7.
 *
 * Expected final output: "proof-admissibility hardening smoke passed"
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  evaluateProofAdmissibility,
  PROOF_ADMISSIBILITY_CONTRACT_VERSION,
  type AdmissibilityReasonCode,
} from '../core/proof-admissibility.js';
import {
  classifyLegacyProofEvidence,
} from '../core/proof-admissibility-legacy.js';
import {
  findReservedProofMetadataKeys,
  sanitizeCallerProofMetadata,
} from '../core/proof-admissibility-metadata.js';
import {
  REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_EVENT,
  REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE,
  evaluateReviewEscalation,
} from '../core/review-escalation.js';
import {
  evaluateReviewAssuranceFloor,
} from '../core/review-assurance-floor.js';

function withProofMode<T>(mode: 'warn' | 'enforce', fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), `proof-admissibility-${mode}-`));
  const config = {
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
    proofAdmissibility: { mode },
  };
  writeFileSync(join(root, 'lattice.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectAdmissibilityReason(result: { reasons: readonly AdmissibilityReasonCode[] }, reason: AdmissibilityReasonCode, label: string): void {
  assert.ok(result.reasons.includes(reason), `${label}: expected ${reason}, got ${result.reasons.join(', ')}`);
}

function matrixCase(label: string, checks: Record<string, unknown>, reason: AdmissibilityReasonCode): void {
  const result = evaluateProofAdmissibility({
    artifactKind: 'authority-receipt-ref',
    consumer: 'AUTHORITY_GATE_DECISION',
    claim: 'production-completion',
    checks: {
      contractVersion: PROOF_ADMISSIBILITY_CONTRACT_VERSION,
      schemaVersion: 'lattice.authority_receipt_refs.v1',
      strictShapeValid: true,
      semanticDigestValid: true,
      signatureOrReceiptBindingValid: true,
      temporalAndMaterialBindingValid: true,
      subjectMatches: true,
      producerBoundaryTrusted: true,
      ...checks,
    },
  });
  assert.equal(result.allowed, false, `${label} must reject proof`);
  assert.equal(result.productionDoneEligible, false, `${label} must not be productionDone eligible`);
  expectAdmissibilityReason(result, reason, label);
}

function hostVerdicts(rounds: number, hostsPerRound: number, materialHash: string) {
  const events: Record<string, unknown>[] = [];
  for (let round = 1; round <= rounds; round++) {
    for (let host = 1; host <= hostsPerRound; host++) {
      events.push({
        type: 'host_verdict',
        verdictId: `V-${round}-${host}`,
        runId: `round-${round}`,
        hostId: `host-${host}`,
        sessionId: `session-${round}-${host}`,
        keyId: `key-${round}-${host}`,
        decision: 'pass',
        materialDigest: materialHash,
        validationDigest: `validation-${round}-${host}`,
        promptDigest: `prompt-${round}-${host}`,
      });
    }
  }
  return events;
}

function highRiskPolicyEvent(materialHash: string): Record<string, unknown> {
  return {
    type: REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_EVENT,
    predicate: REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE,
    requires3x2: true,
    policyId: 'POL-M7',
    policyVersion: 'proof-admissibility-hardening.v1',
    riskClass: 'lifecycle-gate',
    sourcePolicyRef: 'docs/requirements/decisions/proof-admissibility-hardening-execution-plan.md',
    rolloutStage: 'enforce',
    degradedFallbackAllowed: false,
    issuer: 'smoke',
    issuedAt: '2026-06-24T00:00:00.000Z',
    materialHash,
  };
}

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
  const materialHash = 'material-m7';
  const processEvents = [
    highRiskPolicyEvent(materialHash),
    ...hostVerdicts(3, 2, materialHash),
  ];
  withProofMode('warn', (root) => {
    const report = evaluateReviewEscalation({
      projectRoot: root,
      storyId: 'B-0405',
      processEvents: processEvents as any,
      materialHash,
      storyFilesHash: 'story-files-m7',
    });
    assert.equal(report.required, true, 'M7 warn review escalation is a high-risk consumer');
    assert.equal(report.fullQuorum.ok, true, 'M7 warn review escalation has local quorum');
    assert.equal(report.proofAdmissibility.allowed, false, 'M7 warn review escalation surfaces inadmissible proof diagnostic');
    assert.equal(report.proofAdmissibility.blocking, false, 'M7 warn review escalation diagnostic is warn-only');
    assert.equal(report.ok, true, 'M7 warn review escalation remains warn-only');
  });
  withProofMode('enforce', (root) => {
    const report = evaluateReviewEscalation({
      projectRoot: root,
      storyId: 'B-0405',
      processEvents: processEvents as any,
      materialHash,
      storyFilesHash: 'story-files-m7',
    });
    assert.equal(report.fullQuorum.ok, true, 'M7 enforce review escalation local quorum still passes');
    assert.equal(report.proofAdmissibility.blocking, true, 'M7 enforce review escalation diagnostic blocks');
    assert.equal(report.ok, false, 'M7 enforce review escalation rejects inadmissible proof');
    assert.ok(report.reasons.some(reason => reason.startsWith('proof_admissibility_blocked:')), 'M7 enforce review escalation reports stable proof block reason');
  });

  const degradedEvents = [
    {
      type: 'review_escalation_fallback',
      fallbackId: 'REF-M7',
      eligibility: 'explicit-human-approval',
      reason: 'Explicit smoke approval for degraded fallback coverage in enforce-mode proof test.',
      evidenceRefs: ['smoke:evidence'],
      materialHash,
      storyFilesHash: 'story-files-m7',
      assuranceLevel: 'degraded-single-host',
    },
    ...hostVerdicts(3, 1, materialHash),
  ];
  withProofMode('warn', (root) => {
    const report = evaluateReviewAssuranceFloor({
      projectRoot: root,
      storyId: 'B-0405',
      changedFiles: ['packages/main/src/core/phase-gate.ts'],
      processEvents: degradedEvents as any,
      materialHash,
      storyFilesHash: 'story-files-m7',
    });
    assert.equal(report.requiredAssurance, 'three-round-two-hosts-or-degraded-single-host', 'M7 warn floor is high-risk');
    assert.equal(report.degradedFallback.ok, true, 'M7 warn floor degraded fallback passes locally');
    assert.equal(report.proofAdmissibility.allowed, false, 'M7 warn floor surfaces inadmissible proof diagnostic');
    assert.equal(report.proofAdmissibility.blocking, false, 'M7 warn floor diagnostic is warn-only');
    assert.equal(report.ok, true, 'M7 warn floor remains warn-only');
  });
  withProofMode('enforce', (root) => {
    const report = evaluateReviewAssuranceFloor({
      projectRoot: root,
      storyId: 'B-0405',
      changedFiles: ['packages/main/src/core/phase-gate.ts'],
      processEvents: degradedEvents as any,
      materialHash,
      storyFilesHash: 'story-files-m7',
    });
    assert.equal(report.degradedFallback.ok, true, 'M7 enforce floor degraded fallback still passes locally');
    assert.equal(report.proofAdmissibility.blocking, true, 'M7 enforce floor diagnostic blocks');
    assert.equal(report.ok, false, 'M7 enforce floor rejects inadmissible proof');
    assert.ok(report.reasons.some(reason => reason.startsWith('proof_admissibility_blocked:')), 'M7 enforce floor reports stable proof block reason');
  });

  const warnHandoff = buildHandoffAdmissibilitySummary({
    fromHost: 'codex',
    toHost: 'claude-code',
    admissibleProofRefs: ['authority-ref-unverified'],
    mode: 'warn',
  });
  assert.equal(warnHandoff.blocked, false, 'M7 warn handoff proof refs remain diagnostic-only');
  assert.equal(warnHandoff.diagnostics.some(diagnostic => diagnostic.allowed === false), true, 'M7 warn handoff records inadmissible proof ref');

  const enforceHandoff = buildHandoffAdmissibilitySummary({
    fromHost: 'codex',
    toHost: 'claude-code',
    admissibleProofRefs: ['authority-ref-unverified'],
    mode: 'enforce',
  });
  assert.equal(enforceHandoff.blocked, true, 'M7 enforce handoff rejects inadmissible proof ref consumption');
  assert.ok(enforceHandoff.reasons.some(reason => reason.startsWith('proof_admissibility_blocked:')), 'M7 enforce handoff reports stable proof block reason');
}

{
  matrixCase('M7 wrong story id', { storyMatches: false }, 'story_mismatch');
  matrixCase('M7 wrong target phase', { gatePhaseMatches: false }, 'gate_phase_mismatch');
  matrixCase('M7 wrong key id', { signatureOrReceiptBindingValid: false }, 'signature_invalid');
  matrixCase('M7 bad signature', { signatureOrReceiptBindingValid: false }, 'signature_invalid');
  matrixCase('M7 stale current-state green', { hashTupleFresh: false }, 'stale_hash_tuple');
  matrixCase('M7 red/green command mismatch', { redGreenCommandsMatch: false }, 'red_green_command_mismatch');
  matrixCase('M7 candidate mutation', { semanticDigestValid: false }, 'digest_mismatch');
  matrixCase('M7 bootstrap noise', { bootstrapNoiseRejected: false }, 'bootstrap_noise');
  matrixCase('M7 matrix-gap policy exception', { matrixGapWaived: false }, 'matrix_gap_unwaived');
  matrixCase('M7 command-spec digest mismatch', { commandSpecDigestValid: false }, 'command_spec_digest_mismatch');
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
