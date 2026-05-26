#!/usr/bin/env node
//
// Authority boundary smoke (B-ec09 / Milestone 1).
//
// Purpose: prove mechanically that Koala CLI authority submissions cannot be
// mistaken for receipt-backed L2+ production authority. Even a forged "transport
// accepted" path on a CLI-shaped envelope must classify as `thin-client-*`,
// never as `receipt-backed-l2-plus`.
//
// Visible pass line (consumed by reviewers / DONE summary):
//   ✓ authority boundary smoke passed: CLI evidence is local/shadow/thin-client, not receipt-backed L2+ authority
//
// Scope: pure in-process smoke. No network, no fs, no Mac/Python repos. Exits 1
// on any boundary violation.

import assert from 'node:assert/strict';
import {
  classifyAuthorityEvidence,
  isReceiptBackedL2Plus,
  l2PlusRequirements,
  missingL2Requirements,
  type AuthorityClassification,
} from '../core/authority-boundary.js';
import { classifyCliAuthoritySubmission } from '../core/authority-submit.js';
import type { EvidenceEnvelopeContract } from '../core/authority-contracts.js';

const PASS_LINE =
  '✓ authority boundary smoke passed: CLI evidence is local/shadow/thin-client, not receipt-backed L2+ authority';

function cliShapedEnvelope(overrides: Partial<EvidenceEnvelopeContract> = {}): EvidenceEnvelopeContract {
  // Matches what authority-submit.buildEnvelope produces today: strict subset,
  // no run bindings / provider / model / vendor / signature.
  return {
    evidenceId: 'B-ec09:CHK-002:CHK-002:happy:0',
    projectId: 'B-ec09',
    storyId: 'B-ec09',
    producerActorId: 'main',
    role: 'verifier',
    kind: 'logic_test',
    trustLevel: 2,
    repo: {},
    coveredRefs: [],
    uncoveredRefs: [],
    failedRefs: [],
    inspectedArtifacts: [],
    inspectedFiles: [],
    inspectedHunks: [],
    inspectedPackRefs: [],
    nonce: 'nonce',
    createdAt: '2026-05-26T00:00:00.000Z',
    ...overrides,
  };
}

function expectThinClient(c: AuthorityClassification, ctx: string): void {
  assert.notEqual(c.klass, 'receipt-backed-l2-plus', `${ctx}: must not be receipt-backed L2+`);
  assert.equal(isReceiptBackedL2Plus(c), false, `${ctx}: isReceiptBackedL2Plus must be false`);
  assert.ok(c.missing.length > 0, `${ctx}: CLI envelope must have unmet L2+ requirements`);
}

function caseOffLocalOnly(): void {
  const c = classifyAuthorityEvidence({
    mode: 'off',
    envelope: cliShapedEnvelope(),
    receiptVerified: false,
    transportAccepted: false,
  });
  assert.equal(c.klass, 'local-only', 'off mode must classify as local-only');
  expectThinClient(c, 'off/local-only');
}

function caseShadowObservational(): void {
  const c = classifyAuthorityEvidence({
    mode: 'shadow',
    envelope: cliShapedEnvelope(),
    receiptVerified: false,
    transportAccepted: false,
  });
  assert.equal(c.klass, 'thin-client-shadow', 'shadow non-accepted must classify as thin-client-shadow');
  expectThinClient(c, 'shadow/observational');
}

function caseEnforceAcceptedTransportNotReceipt(): void {
  // The dangerous case: server returned accepted=true on the transport. The
  // boundary must still refuse to treat this as receipt-backed L2+ because the
  // envelope lacks run bindings / provider / model / vendor / signature and the
  // CLI does not verify a signed AuthorityReceipt.
  const c = classifyAuthorityEvidence({
    mode: 'enforce',
    envelope: cliShapedEnvelope(),
    receiptVerified: false,
    transportAccepted: true,
  });
  assert.equal(
    c.klass,
    'thin-client-transport-accepted',
    'enforce + accepted=true on CLI envelope must classify as thin-client-transport-accepted, NOT receipt-backed L2+',
  );
  assert.match(
    c.reason,
    /NOT signed receipt verification/i,
    'reason must explicitly distinguish transport acceptance from receipt verification',
  );
  expectThinClient(c, 'enforce/transport-accepted');
}

function caseAdversarialForgedPartialFields(): void {
  // An attacker / mis-configured caller fills in SOME of the L2+ fields but not
  // all (e.g., provider but no signature, no verified receipt). Must still
  // refuse receipt-backed classification.
  const c = classifyAuthorityEvidence({
    mode: 'enforce',
    envelope: cliShapedEnvelope({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      vendor: 'anthropic',
      producerRunId: 'forged-run',
      verifierRunId: 'forged-run',
      // signature omitted on purpose
    }),
    receiptVerified: false,
    transportAccepted: true,
  });
  assert.notEqual(c.klass, 'receipt-backed-l2-plus', 'forged partial L2+ fields must NOT classify as receipt-backed');
  const missing = missingL2Requirements({
    mode: 'enforce',
    envelope: cliShapedEnvelope({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      vendor: 'anthropic',
      producerRunId: 'forged-run',
      verifierRunId: 'forged-run',
    }),
    receiptVerified: false,
    transportAccepted: true,
  });
  assert.ok(missing.includes('envelopeSignature'), 'missing must include envelopeSignature');
  assert.ok(missing.includes('verifiedAuthorityReceipt'), 'missing must include verifiedAuthorityReceipt');
}

function caseAuthoritySubmitWrapperAgrees(): void {
  // The wrapper exposed from authority-submit.ts must agree with the core
  // classifier — guards against future drift where a handler bypasses the
  // boundary helper.
  const env = cliShapedEnvelope();
  const fromWrapper = classifyCliAuthoritySubmission('enforce', env, true);
  expectThinClient(fromWrapper, 'authority-submit wrapper');
  assert.equal(
    fromWrapper.klass,
    'thin-client-transport-accepted',
    'wrapper must classify enforce+accepted CLI envelope as thin-client-transport-accepted',
  );
}

function caseRequirementsFrozenList(): void {
  // L2+ requirement list must be non-empty and stable — used by docs/tests as
  // the canonical missing-fields list under the current PD-1 decision.
  const reqs = l2PlusRequirements();
  assert.ok(reqs.length >= 7, 'l2PlusRequirements must enumerate >=7 requirements');
  for (const r of ['producerRunId', 'verifierRunId', 'provider', 'model', 'vendor', 'envelopeSignature', 'verifiedAuthorityReceipt'] as const) {
    assert.ok(reqs.includes(r), `l2PlusRequirements must include ${r}`);
  }
}

function main(): void {
  caseOffLocalOnly();
  caseShadowObservational();
  caseEnforceAcceptedTransportNotReceipt();
  caseAdversarialForgedPartialFields();
  caseAuthoritySubmitWrapperAgrees();
  caseRequirementsFrozenList();
  console.log(PASS_LINE);
}

try {
  main();
} catch (err) {
  console.error('✗ authority boundary smoke FAILED');
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
}
