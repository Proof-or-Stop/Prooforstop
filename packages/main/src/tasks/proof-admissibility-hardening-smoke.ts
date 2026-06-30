#!/usr/bin/env node
/**
 * Proof admissibility hardening smoke.
 *
 * Expected final output: "proof-admissibility hardening smoke passed"
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { resetConfigCache } from '../core/config.js';
import {
  buildProofBindingDigestPayload,
  verifyProofBindingDigest,
  PROOF_BINDING_SCHEMA_VERSION,
} from '../core/proof-admissibility-binding.js';
import { buildHandoffAdmissibilitySummary } from '../core/proof-admissibility-handoff.js';
import {
  type HandoffAcceptProjection,
  type HandoffInspection,
  type HandoffPack,
  type HandoffReceipt,
  type HandoffReceiptSubmission,
  type HandoffResumeProjection,
} from '../core/lattice-handoff.js';
import {
  assertNoReservedProofMetadata,
  sanitizeCallerProofMetadata,
} from '../core/proof-admissibility-metadata.js';
import { classifyLegacyProofEvidence } from '../core/proof-admissibility-legacy.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { createMainRegistry } from '../registry.js';

const enforceHighRisk: ProofAdmissibilityPolicy = {
  mode: 'enforce',
  enforcedConsumers: ['DONE_REQUIRED', 'REVIEW', 'HANDOFF', 'AUTHORITY_GATE_DECISION'],
};
const CLOSURE_AUDIT_PATH = 'docs/requirements/decisions/control-plane-proof-capability-closure-audit.md';

function assertClosureAuditContract(): void {
  const audit = readFileSync(join(process.cwd(), CLOSURE_AUDIT_PATH), 'utf8');
  for (const milestone of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7']) {
    const matches = audit.match(new RegExp(`\\| ${milestone} \\|`, 'g')) ?? [];
    assert.equal(matches.length, 1, `${CLOSURE_AUDIT_PATH} must list ${milestone} exactly once`);
  }
  assert.match(audit, /\| M4 \| CHK-004 \| Append-only admissibility ledger \| retired\/non-goal \|/);
  assert.match(audit, /\| M7 \| CHK-007 \| CommandSpec envelope and project waterline coverage \| missing-to-implement \|/);
}

assertClosureAuditContract();

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

function seedHandoffStory(store: StoryStore): void {
  const now = '2026-06-30T00:00:00.000Z';
  const story: StoryInfo = {
    storyId: 'B-handoff-policy',
    name: 'handoff-policy-smoke',
    title: 'Handoff policy smoke',
    description: 'Smoke story for command-level handoff proof admissibility.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now, branch: 'story/B-handoff-policy' }],
  };
  const checklist: ChecklistData = {
    items: [
      {
        id: 'CHK-001',
        title: 'Carry handoff policy',
        status: 'done',
        startTime: now,
        endTime: now,
        verificationEvidence: [{
          intentRef: 'CHK-001:happy:0',
          kind: 'logic_test',
          command: 'node dist/tasks/proof-admissibility-hardening-smoke.js',
          result: 'pass',
          note: 'Seed evidence for handoff command policy smoke.',
          timestamp: now,
        }],
      },
    ],
  };
  store.writeStory('B-handoff-policy', story);
  store.writeChecklist('B-handoff-policy', checklist);
}

function assertBlockedHandoffSummary(value: { admissibilitySummary: { blocked: boolean; reasons: string[]; diagnostics: Array<{ mode: string }> }; productionDone: false }): void {
  assert.equal(value.productionDone, false, 'local handoff command output never claims release readiness');
  assert.equal(value.admissibilitySummary.blocked, true, 'project enforce policy blocks inadmissible HANDOFF proof refs');
  assert.ok(value.admissibilitySummary.reasons.some(reason => reason.includes('proof_admissibility_blocked')), 'blocked HANDOFF reason is surfaced');
  assert.ok(value.admissibilitySummary.diagnostics.some(diagnostic => diagnostic.mode === 'enforce'), 'HANDOFF diagnostic uses project enforce mode');
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
  resetConfigCache();
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
    checks: currentValidChecks('lattice.external_gate_decision.v1'),
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
      ...currentValidChecks('lattice.external_gate_decision.v1'),
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
    checks: currentValidChecks('lattice.external_receipt.v1'),
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
  assert.equal(summary.productionDone, false, 'handoff summary never sets retired release flags');
  assert.equal(summary.authorityDone, false, 'handoff summary never sets retired adapter flags');
  assert.equal(summary.fullAuthorityDone, false, 'handoff summary never sets retired aggregate flags');
  assert.equal(summary.receiptVerified, false, 'handoff summary does not verify receipts');
  assert.equal(summary.blocked, true, 'configured enforce mode blocks inadmissible handoff proof refs');
  assert.match(summary.reasons.join('\n'), /proof_admissibility_blocked/, 'handoff block reason is surfaced');
}

{
  const root = mkdtempSync(join(tmpdir(), 'proof-admissibility-handoff-command-'));
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
    flows: { defaults: {}, patterns: [] },
    proofAdmissibility: {
      mode: 'enforce',
      enforcedConsumers: ['HANDOFF'],
    },
  }, null, 2));
  resetConfigCache();
  const store = new StoryStore(root);
  seedHandoffStory(store);
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  const handoffProofRef = 'local-diagnostic-handoff-ref';

  const createText = registry.get('handoff_create')!({
    storyId: 'B-handoff-policy',
    fromHost: 'codex',
    toHost: 'claude-code',
    admissibleProofRefs: handoffProofRef,
  }) as string;
  assert.match(createText, /admissibilityBlocked: true/, 'handoff_create text surfaces blocked status');
  assert.match(createText, /proof_admissibility_blocked/, 'handoff_create text surfaces block reason');

  const pack = registry.get('handoff_create')!({
    storyId: 'B-handoff-policy',
    fromHost: 'codex',
    toHost: 'claude-code',
    admissibleProofRefs: handoffProofRef,
    json: true,
  }) as HandoffPack;
  assertBlockedHandoffSummary(pack);
  assert.equal((pack as unknown as Record<string, unknown>).authorityDone, undefined, 'handoff pack does not claim retired adapter flags');
  assert.equal((pack as unknown as Record<string, unknown>).fullAuthorityDone, undefined, 'handoff pack does not claim retired aggregate flags');

  const legacyWarnSummary = buildHandoffAdmissibilitySummary({
    fromHost: pack.fromHost,
    toHost: pack.toHost,
    evidenceRefs: pack.evidenceRefs,
    admissibleProofRefs: [handoffProofRef],
    mode: 'warn',
  });
  const packPath = join(root, 'legacy-warn-handoff-pack.json');
  writeFileSync(packPath, JSON.stringify({
    ...pack,
    admissibleProofRefs: [],
    admissibilitySummary: legacyWarnSummary,
  }, null, 2));

  const inspection = registry.get('handoff_inspect')!({ file: packPath, json: true }) as HandoffInspection;
  assertBlockedHandoffSummary(inspection);
  assert.deepEqual(inspection.admissibilitySummary.admissibleProofRef, [handoffProofRef], 'handoff_inspect preserves explicit proof refs from legacy summary');

  const accept = registry.get('handoff_accept')!({ file: packPath, json: true }) as HandoffAcceptProjection;
  assertBlockedHandoffSummary(accept);
  const acceptPath = join(root, 'legacy-warn-handoff-accept.json');
  writeFileSync(acceptPath, JSON.stringify({
    ...accept,
    admissibleProofRefs: [],
    admissibilitySummary: legacyWarnSummary,
  }, null, 2));

  const resume = registry.get('handoff_resume')!({ file: acceptPath, json: true }) as HandoffResumeProjection;
  assertBlockedHandoffSummary(resume);

  const receipt: HandoffReceipt = {
    schemaVersion: 'lattice.handoff_receipt.v1',
    storyId: pack.storyId,
    host: 'fake',
    packId: pack.packId,
    packHash: pack.packHash,
    fromHost: pack.fromHost,
    toHost: pack.toHost,
    allowedPaths: pack.allowedPaths,
    deniedPaths: pack.deniedPaths,
    requiredCommands: pack.requiredCommands,
    successCriteria: pack.successCriteria,
    authorityBoundary: pack.authorityBoundary,
    executionInstructions: pack.executionInstructions,
    headSha: 'missing-head',
    changedFiles: ['packages/main/src/core/lattice-handoff.ts'],
    commands: ['npm --prefix packages/main run build'],
    verdict: 'warn',
    limitations: ['synthetic command-level smoke receipt'],
    admissibleProofRefs: [],
    admissibilitySummary: legacyWarnSummary,
  };
  const receiptPath = join(root, 'legacy-warn-handoff-receipt.json');
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

  const receiptText = registry.get('handoff_receipt_submit')!({ file: receiptPath, admissibleProofRefs: handoffProofRef }) as string;
  assert.match(receiptText, /admissibilityBlocked: true/, 'handoff_receipt_submit text surfaces blocked status');
  assert.match(receiptText, /proof_admissibility_blocked/, 'handoff_receipt_submit text surfaces block reason');
  const receiptSubmission = registry.get('handoff_receipt_submit')!({ file: receiptPath, admissibleProofRefs: handoffProofRef, json: true }) as HandoffReceiptSubmission;
  assertBlockedHandoffSummary(receiptSubmission);
  assert.equal(receiptSubmission.receiptVerified, false, 'handoff receipt submission does not verify receipts');
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
