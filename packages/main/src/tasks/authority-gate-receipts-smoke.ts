#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  consumeAuthorityGateReceiptRef,
  eligibleAuthorityGateReceiptDocument,
  eligibleAuthorityGateReceiptRef,
  upsertAuthorityGateReceiptRef,
  type AuthorityGateDecisionReceiptRef,
  type AuthorityGateReceiptContext,
} from '../core/authority-gate-receipts.js';
import { PROCESS_FACT_REGISTRY_BY_NAME } from '../core/process-fact-registry.js';

const context: AuthorityGateReceiptContext = {
  storyId: 'B-receipt',
  targetPhase: 'TEST',
  headHash: 'head-1',
  materialHash: 'material-1',
  currentServerStateVersion: 7,
  acceptablePolicyModes: ['balanced', 'strict'],
  acceptableAuthorityModes: ['enforce'],
};

function validRef(overrides: Partial<AuthorityGateDecisionReceiptRef> = {}): AuthorityGateDecisionReceiptRef {
  return {
    receiptId: 'AR-1',
    receiptKind: 'gate_decision',
    classification: 'production-gate-decision',
    authorityUrl: 'https://authority.example',
    authorityKeyId: 'server-key-1',
    authorityPublicKeyDigest: 'sha256:key',
    decisionId: 'GD-1',
    stateVersion: 7,
    gateInputDigest: 'sha256:input',
    decisionDigest: 'sha256:decision',
    decisionVerdict: 'pass',
    storyId: 'B-receipt',
    targetPhase: 'TEST',
    headHash: 'head-1',
    materialHash: 'material-1',
    policyMode: 'balanced',
    authorityMode: 'enforce',
    producerRunIds: ['run-producer-1'],
    verifierRunIds: ['run-verifier-1'],
    sessionId: 'session-1',
    runnerSessionIds: ['session-1'],
    evidenceDigests: ['sha256:evidence-1'],
    verifiedAt: '2026-06-10T00:00:00.000Z',
    verifiedBy: 'lattice authority receipt verify',
    eligibleGates: ['TEST'],
    status: 'active',
    consumptionEvents: [],
    ...overrides,
  };
}

{
  const eligibility = eligibleAuthorityGateReceiptRef(validRef(), context);
  assert.equal(eligibility.eligible, true, 'valid production gate receipt ref is eligible');

  const consumed = consumeAuthorityGateReceiptRef(
    validRef(),
    context,
    '2026-06-10T00:01:00.000Z',
  );
  assert.equal(consumed.consumed, true, 'valid production gate receipt ref is consumed');
  assert.equal(consumed.fact?.fact, 'strongEvidenceConsumed');
  assert.equal(consumed.fact?.value, true);
  assert.equal(consumed.fact?.receiptId, 'AR-1');
  assert.equal(consumed.ref?.consumptionEvents?.length, 1);
}

{
  const contractOnly = eligibleAuthorityGateReceiptRef(
    validRef({ classification: 'contract-only' }),
    context,
  );
  assert.equal(contractOnly.eligible, false);
  assert.equal(contractOnly.reason, 'authority_receipt_not_production_classified');

  const evidenceReceipt = eligibleAuthorityGateReceiptRef(
    validRef({ receiptKind: 'evidence' }),
    context,
  );
  assert.equal(evidenceReceipt.eligible, false);
  assert.equal(evidenceReceipt.reason, 'authority_receipt_not_gate_decision');

  const wrongPhase = eligibleAuthorityGateReceiptRef(
    validRef({ targetPhase: 'DONE', eligibleGates: ['DONE'] }),
    context,
  );
  assert.equal(wrongPhase.eligible, false);
  assert.equal(wrongPhase.reason, 'authority_receipt_phase_mismatch');

  const gateListExcludesCurrentPhase = eligibleAuthorityGateReceiptRef(
    validRef({ targetPhase: 'TEST', eligibleGates: ['DONE'] }),
    context,
  );
  assert.equal(gateListExcludesCurrentPhase.eligible, false);
  assert.equal(gateListExcludesCurrentPhase.reason, 'authority_receipt_phase_mismatch');

  const explicitTestCoversDone = eligibleAuthorityGateReceiptRef(
    validRef({ targetPhase: 'TEST', eligibleGates: ['TEST', 'DONE'] }),
    { ...context, targetPhase: 'DONE' },
  );
  assert.equal(explicitTestCoversDone.eligible, true);

  const wrongState = eligibleAuthorityGateReceiptRef(
    validRef({ stateVersion: 6 }),
    context,
  );
  assert.equal(wrongState.eligible, false);
  assert.equal(wrongState.reason, 'authority_receipt_state_version_mismatch');

  const staleMaterial = eligibleAuthorityGateReceiptRef(
    validRef({ materialHash: 'material-old' }),
    context,
  );
  assert.equal(staleMaterial.eligible, false);
  assert.equal(staleMaterial.reason, 'authority_receipt_stale_material');

  const missingEvidence = eligibleAuthorityGateReceiptRef(
    validRef({ evidenceDigests: [] }),
    context,
  );
  assert.equal(missingEvidence.eligible, false);
  assert.equal(missingEvidence.reason, 'authority_receipt_evidence_missing');

  const missingRun = eligibleAuthorityGateReceiptRef(
    validRef({ verifierRunIds: [] }),
    context,
  );
  assert.equal(missingRun.eligible, false);
  assert.equal(missingRun.reason, 'authority_receipt_run_binding_missing');

  const missingVerifiedAt = eligibleAuthorityGateReceiptRef(
    validRef({ verifiedAt: undefined }),
    context,
  );
  assert.equal(missingVerifiedAt.eligible, false);
  assert.equal(missingVerifiedAt.reason, 'authority_receipt_verified_at_missing');

  const expired = eligibleAuthorityGateReceiptRef(
    validRef({ verifiedAt: '2026-06-10T00:00:00.000Z' }),
    {
      ...context,
      now: '2026-06-10T00:10:00.000Z',
      maxVerifiedAgeMs: 5 * 60 * 1000,
    },
  );
  assert.equal(expired.eligible, false);
  assert.equal(expired.reason, 'authority_receipt_freshness_expired');
}

{
  const first = upsertAuthorityGateReceiptRef(undefined, validRef(), '2026-06-10T00:00:00.000Z');
  assert.equal(first.schemaVersion, 'lattice.authority_receipt_refs.v1');
  assert.equal(first.refs.length, 1);
  const fromDocument = eligibleAuthorityGateReceiptDocument(first, context);
  assert.equal(fromDocument.eligible, true, 'supported receipt-ref document can yield an eligible ref');
  const unsupportedSchema = eligibleAuthorityGateReceiptDocument(
    { ...first, schemaVersion: 'legacy' as 'lattice.authority_receipt_refs.v1' },
    context,
  );
  assert.equal(unsupportedSchema.eligible, false);
  assert.equal(unsupportedSchema.reason, 'authority_receipt_schema_unsupported');
  const replaced = upsertAuthorityGateReceiptRef(
    first,
    validRef({ decisionDigest: 'sha256:decision-new' }),
    '2026-06-10T00:02:00.000Z',
  );
  assert.equal(replaced.refs.length, 1, 'same receiptId is replaced, not duplicated');
  assert.equal(replaced.refs[0]?.decisionDigest, 'sha256:decision-new');
}

{
  const fact = PROCESS_FACT_REGISTRY_BY_NAME['artifact:authority-receipt-refs.json'];
  assert.ok(fact, 'authority receipt ref artifact is registered as a process fact');
  assert.equal(fact.level, 'L4');
  assert.equal(fact.kind, 'artifact');
  assert.ok(fact.semantics.includes('gate-evidence'));
  assert.match(fact.consumerGate ?? '', /Authority gate_decision receipt/);
}

console.log('authority gate receipts smoke passed');
