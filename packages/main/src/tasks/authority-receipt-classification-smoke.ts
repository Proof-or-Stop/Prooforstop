#!/usr/bin/env node
//
// Authority receipt classification smoke (B-2522 Milestone 7 / CHK-001).
//
// Purpose: prove mechanically that an envelope can ONLY reach
// `receipt-backed-l2-plus` after a signed Python `AuthorityReceipt` is
// cryptographically verified AND its subject binding (subjectKind / subjectId /
// subjectDigest) matches THIS evidence envelope. Every other path — including
// a forged "accepted=true" transport response without a verified receipt,
// a same-run producer/verifier, missing command/transcript/diff hash bindings,
// a bad receipt signature, or a receipt whose subject points at a different
// envelope — MUST stay non-receipt-backed.
//
// Visible pass line (consumed by reviewers / DONE summary):
//   ✓ authority receipt classification smoke passed: receiptVerified=true klass=receipt-backed-l2-plus only after signed receipt verification
//
// Scope: pure in-process smoke. No network, no fs, no Mac/Python repos. Exits 1
// on any boundary violation.

import assert from 'node:assert/strict';
import type { EvidenceEnvelopeContract } from '../core/authority-contracts.js';
import {
  classifyReceiptBackedEvidence,
  envelopeSubjectDigest,
  verifyReceiptBinding,
  RECEIPT_SUBJECT_KIND_EVIDENCE,
  type ReceiptRejectionReason,
} from '../core/authority-receipt-classification.js';
import {
  classifyCliAuthoritySubmission,
} from '../core/authority-submit.js';
import {
  generateEd25519KeyPair,
  signCanonical,
  stripSignature,
} from '../core/authority-signing.js';
import type { AuthorityReceipt } from '../core/authority-runner-contracts.js';

const PASS_LINE =
  '✓ authority receipt classification smoke passed: receiptVerified=true klass=receipt-backed-l2-plus only after signed receipt verification';

// ─── shared key material ──────────────────────────────────────────────────────
const authority = generateEd25519KeyPair();
const wrongKey = generateEd25519KeyPair();

const ISSUED_AT = '2026-06-02T18:30:00.000Z';
const EVIDENCE_ID = 'B-2522:CHK-001:CHK-001:happy:0';

function fullEnvelope(
  overrides: Partial<EvidenceEnvelopeContract> = {},
): EvidenceEnvelopeContract {
  // Receipt-backed L2+ candidate envelope: all run bindings, provider/model/
  // vendor, command/transcript/diff hashes, and an actor signature. Receipt
  // verification is the only step that's still gated outside the envelope.
  return {
    evidenceId: EVIDENCE_ID,
    projectId: 'B-2522',
    storyId: 'B-2522',
    producerActorId: 'producer-actor',
    role: 'verifier',
    kind: 'logic_test',
    trustLevel: 2,
    repo: { headHash: 'sha256:head', materialHash: 'sha256:material' },
    coveredRefs: ['ref-1'],
    uncoveredRefs: [],
    failedRefs: [],
    inspectedArtifacts: ['artifact-1'],
    inspectedFiles: ['packages/main/src/core/authority-receipt-classification.ts'],
    inspectedHunks: [],
    inspectedPackRefs: [],
    producerRunId: 'producer-run-1',
    verifierRunId: 'verifier-run-1',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    vendor: 'anthropic',
    commandDigest: 'sha256:cmd',
    transcriptHash: 'sha256:tx',
    diffHash: 'sha256:diff',
    signature: 'ed25519:envelope-signature',
    nonce: 'B-2522:CHK-001',
    createdAt: ISSUED_AT,
    ...overrides,
  };
}

/**
 * Build a signed receipt that binds to the supplied envelope. The signature is
 * computed over the canonical bytes of the SIGNATURE-LESS receipt view
 * (matching authority-runner-contracts.verifyAuthorityReceipt expectations).
 */
function signReceiptFor(
  envelope: EvidenceEnvelopeContract,
  overrides: Partial<AuthorityReceipt> = {},
  privateKey: string = authority.privateKey,
): AuthorityReceipt {
  const base: AuthorityReceipt = {
    receiptId: 'rcpt-1',
    subjectId: envelope.evidenceId,
    subjectKind: RECEIPT_SUBJECT_KIND_EVIDENCE,
    issuedAt: ISSUED_AT,
    authorityActorId: 'python-authority-1',
    subjectDigest: envelopeSubjectDigest(envelope),
    ...overrides,
  };
  const sig = signCanonical(stripSignature(base), privateKey);
  return { ...base, signature: sig };
}

function expectRejection(
  verification: { verified: boolean; rejectionReason?: ReceiptRejectionReason },
  expected: ReceiptRejectionReason,
  ctx: string,
): void {
  assert.equal(verification.verified, false, `${ctx}: must not verify`);
  assert.equal(
    verification.rejectionReason,
    expected,
    `${ctx}: rejection reason must be ${expected}`,
  );
}

// ─── 1. happy path: signed receipt + matching subject → receipt-backed L2+ ───
function caseHappyReceiptBacked(): void {
  const env = fullEnvelope();
  const receipt = signReceiptFor(env);
  const { classification, receipt: verification } = classifyReceiptBackedEvidence({
    mode: 'enforce',
    envelope: env,
    receipt,
    authorityPublicKey: authority.publicKey,
    transportAccepted: true,
  });
  assert.equal(verification.verified, true, 'happy: receipt verification must succeed');
  assert.equal(
    classification.klass,
    'receipt-backed-l2-plus',
    'happy: fully bound envelope + verified receipt = receipt-backed-l2-plus',
  );
  assert.equal(classification.missing.length, 0, 'happy: no missing L2+ requirements');
}

// ─── 2. ordinary CLI workflow path keeps receiptVerified=false ───────────────
function caseCliWorkflowPathStillThinClient(): void {
  // classifyCliAuthoritySubmission MUST continue to use receiptVerified=false
  // even when the same envelope is fully bound. This is the protective
  // invariant: handlers that never verified a receipt cannot accidentally
  // promote evidence by passing through the receipt-backed classifier.
  const env = fullEnvelope();
  const result = classifyCliAuthoritySubmission('enforce', env, true);
  assert.notEqual(
    result.klass,
    'receipt-backed-l2-plus',
    'classifyCliAuthoritySubmission must NOT promote even fully bound envelopes',
  );
  assert.ok(
    result.missing.includes('verifiedAuthorityReceipt'),
    'classifyCliAuthoritySubmission must always flag missing verifiedAuthorityReceipt',
  );
  // And: a receipt-backed envelope with the SAME mode + transportAccepted but
  // NO receipt supplied to the receipt-backed classifier must also not promote.
  const noReceipt = classifyReceiptBackedEvidence({
    mode: 'enforce',
    envelope: env,
    receipt: undefined,
    authorityPublicKey: authority.publicKey,
    transportAccepted: true,
  });
  assert.equal(noReceipt.receipt.verified, false);
  assert.equal(noReceipt.receipt.rejectionReason, 'missing_receipt');
  assert.notEqual(noReceipt.classification.klass, 'receipt-backed-l2-plus');
  assert.equal(
    noReceipt.classification.klass,
    'thin-client-transport-accepted',
    'no receipt + accepted=true must classify as thin-client-transport-accepted',
  );
}

// ─── 3. bad receipt signature (signed by wrong key) → not L2+ ─────────────────
function caseBadReceiptSignature(): void {
  const env = fullEnvelope();
  const forged = signReceiptFor(env, {}, wrongKey.privateKey);
  const { classification, receipt: verification } = classifyReceiptBackedEvidence({
    mode: 'enforce',
    envelope: env,
    receipt: forged,
    authorityPublicKey: authority.publicKey,
    transportAccepted: true,
  });
  expectRejection(verification, 'receipt_signature_invalid', 'bad signature');
  assert.notEqual(classification.klass, 'receipt-backed-l2-plus');
  assert.ok(
    classification.missing.includes('verifiedAuthorityReceipt'),
    'bad signature must surface verifiedAuthorityReceipt as missing',
  );
}

// ─── 4. wrong subjectKind ("job" instead of "evidence") → not L2+ ─────────────
function caseWrongSubjectKind(): void {
  const env = fullEnvelope();
  const receipt = signReceiptFor(env, { subjectKind: 'job' });
  const { classification, receipt: verification } = classifyReceiptBackedEvidence({
    mode: 'enforce',
    envelope: env,
    receipt,
    authorityPublicKey: authority.publicKey,
    transportAccepted: true,
  });
  expectRejection(verification, 'subject_kind_mismatch', 'wrong subjectKind');
  assert.notEqual(classification.klass, 'receipt-backed-l2-plus');
}

// ─── 5. wrong subjectId (points at a different envelope) → not L2+ ────────────
function caseWrongSubjectId(): void {
  const env = fullEnvelope();
  const receipt = signReceiptFor(env, { subjectId: 'B-2522:OTHER:happy:0' });
  const { classification, receipt: verification } = classifyReceiptBackedEvidence({
    mode: 'enforce',
    envelope: env,
    receipt,
    authorityPublicKey: authority.publicKey,
    transportAccepted: true,
  });
  expectRejection(verification, 'subject_id_mismatch', 'wrong subjectId');
  assert.notEqual(classification.klass, 'receipt-backed-l2-plus');
}

// ─── 6. wrong subjectDigest (binds different envelope content) → not L2+ ──────
function caseWrongSubjectDigest(): void {
  const env = fullEnvelope();
  const receipt = signReceiptFor(env, { subjectDigest: 'sha256:not-the-envelope' });
  const { classification, receipt: verification } = classifyReceiptBackedEvidence({
    mode: 'enforce',
    envelope: env,
    receipt,
    authorityPublicKey: authority.publicKey,
    transportAccepted: true,
  });
  expectRejection(verification, 'subject_digest_mismatch', 'wrong subjectDigest');
  assert.notEqual(classification.klass, 'receipt-backed-l2-plus');

  // Also: a bare-hex digest that simply isn't the envelope's canonical digest
  // (no `sha256:` prefix tricks) must fail the same way. Defends against a
  // future "accept any non-empty subjectDigest" regression.
  const wrongBare = signReceiptFor(env, { subjectDigest: 'deadbeef'.repeat(8) });
  const wrongBareResult = classifyReceiptBackedEvidence({
    mode: 'enforce',
    envelope: env,
    receipt: wrongBare,
    authorityPublicKey: authority.publicKey,
    transportAccepted: true,
  });
  expectRejection(
    wrongBareResult.receipt,
    'subject_digest_mismatch',
    'wrong bare-hex subjectDigest',
  );
  assert.notEqual(wrongBareResult.classification.klass, 'receipt-backed-l2-plus');

  // And: a different algorithm prefix paired with the correct hex must also
  // fail — we only accept the literal `sha256:` prefix, not any algorithm tag.
  const env2 = fullEnvelope();
  const wrongAlgo = signReceiptFor(env2, {
    subjectDigest: `sha512:${envelopeSubjectDigest(env2)}`,
  });
  const wrongAlgoResult = classifyReceiptBackedEvidence({
    mode: 'enforce',
    envelope: env2,
    receipt: wrongAlgo,
    authorityPublicKey: authority.publicKey,
    transportAccepted: true,
  });
  expectRejection(
    wrongAlgoResult.receipt,
    'subject_digest_mismatch',
    'unsupported algorithm prefix must not promote',
  );
  assert.notEqual(wrongAlgoResult.classification.klass, 'receipt-backed-l2-plus');
}

// ─── 6b. prefixed `sha256:<canonical-hex>` subjectDigest is accepted → L2+ ────
function caseSha256PrefixedSubjectDigestAccepted(): void {
  // External Python AuthorityReceipt issuers conventionally tag the digest with
  // an algorithm prefix. Both the BARE canonical hex (signReceiptFor default,
  // covered by caseHappyReceiptBacked) and the `sha256:<hex>` prefixed form
  // must classify as receipt-backed-l2-plus. Plan: cover both accepted forms.
  const env = fullEnvelope();
  const bareDigest = envelopeSubjectDigest(env);
  const prefixed = signReceiptFor(env, { subjectDigest: `sha256:${bareDigest}` });
  const { classification, receipt: verification } = classifyReceiptBackedEvidence({
    mode: 'enforce',
    envelope: env,
    receipt: prefixed,
    authorityPublicKey: authority.publicKey,
    transportAccepted: true,
  });
  assert.equal(
    verification.verified,
    true,
    'sha256:<hex> prefixed subjectDigest must verify',
  );
  assert.equal(verification.subjectDigestPresent, true);
  assert.equal(
    classification.klass,
    'receipt-backed-l2-plus',
    'sha256:<hex> prefixed subjectDigest must classify as receipt-backed-l2-plus',
  );
  assert.equal(classification.missing.length, 0);
}

// ─── 7. subjectDigest absent (not asserted by authority) → still L2+ ──────────
function caseSubjectDigestAbsentStillVerifies(): void {
  // When the receipt does not carry a subjectDigest, the subjectId binding is
  // the sole pin to this evidenceId. Signature + subjectKind + subjectId all
  // pass → verifies. This branch is documented in the helper.
  const env = fullEnvelope();
  const receipt = signReceiptFor(env, { subjectDigest: undefined });
  const { classification, receipt: verification } = classifyReceiptBackedEvidence({
    mode: 'enforce',
    envelope: env,
    receipt,
    authorityPublicKey: authority.publicKey,
    transportAccepted: true,
  });
  assert.equal(verification.verified, true, 'absent subjectDigest must still verify');
  assert.equal(verification.subjectDigestPresent, false);
  assert.equal(classification.klass, 'receipt-backed-l2-plus');
}

// ─── 8. missing authority public key → not L2+ ────────────────────────────────
function caseMissingAuthorityPublicKey(): void {
  const env = fullEnvelope();
  const receipt = signReceiptFor(env);
  const { classification, receipt: verification } = classifyReceiptBackedEvidence({
    mode: 'enforce',
    envelope: env,
    receipt,
    authorityPublicKey: undefined,
    transportAccepted: true,
  });
  expectRejection(verification, 'missing_authority_public_key', 'missing key');
  assert.notEqual(classification.klass, 'receipt-backed-l2-plus');
}

// ─── 9. same producer/verifier run id → not L2+ even with valid receipt ──────
function caseSameRunCollapseStillBlocks(): void {
  const env = fullEnvelope({
    producerRunId: 'same-run',
    verifierRunId: 'same-run',
  });
  const receipt = signReceiptFor(env);
  const { classification, receipt: verification } = classifyReceiptBackedEvidence({
    mode: 'enforce',
    envelope: env,
    receipt,
    authorityPublicKey: authority.publicKey,
    transportAccepted: true,
  });
  // Receipt verification itself still passes (the authority signed it).
  assert.equal(verification.verified, true, 'same-run: receipt sig still verifies');
  // But the envelope-side independence check blocks L2+ classification.
  assert.notEqual(
    classification.klass,
    'receipt-backed-l2-plus',
    'same-run producer/verifier MUST NOT classify as receipt-backed L2+ even with a verified receipt',
  );
  assert.ok(
    classification.missing.includes('independentVerifierRunId'),
    'same-run case must surface independentVerifierRunId',
  );
}

// ─── 10. missing commandDigest / transcriptHash / diffHash → not L2+ ─────────
function caseMissingHashBindingsBlock(): void {
  for (const omit of ['commandDigest', 'transcriptHash', 'diffHash'] as const) {
    const env = fullEnvelope({ [omit]: undefined });
    const receipt = signReceiptFor(env);
    const { classification, receipt: verification } = classifyReceiptBackedEvidence({
      mode: 'enforce',
      envelope: env,
      receipt,
      authorityPublicKey: authority.publicKey,
      transportAccepted: true,
    });
    // Receipt still verifies — receipts don't carry the diff/cmd/tx hashes.
    assert.equal(verification.verified, true, `${omit} omitted: receipt still verifies`);
    assert.notEqual(
      classification.klass,
      'receipt-backed-l2-plus',
      `${omit} omitted: MUST NOT classify as receipt-backed L2+`,
    );
    assert.ok(
      classification.missing.includes(omit),
      `${omit} omitted: missing must include ${omit}`,
    );
  }
}

// ─── 11. accepted=true with NO verified receipt stays thin-client ─────────────
function caseAcceptedWithoutVerifiedReceiptStaysThinClient(): void {
  // Direct call into the receipt-backed classifier with no receipt: must not
  // promote, must surface missing_receipt and thin-client-transport-accepted.
  const env = fullEnvelope();
  const { classification, receipt: verification } = classifyReceiptBackedEvidence({
    mode: 'enforce',
    envelope: env,
    transportAccepted: true,
  });
  expectRejection(verification, 'missing_receipt', 'accepted-without-receipt');
  assert.equal(
    classification.klass,
    'thin-client-transport-accepted',
    'accepted=true without receipt must stay thin-client-transport-accepted',
  );
}

// ─── 12. envelopeSubjectDigest is stable across signature mutation ───────────
function caseEnvelopeDigestIgnoresSignature(): void {
  // The signature-less envelope digest must not change when the envelope's
  // signature is rotated; otherwise a fresh signing would invalidate a
  // previously-issued receipt's subjectDigest.
  const env = fullEnvelope();
  const a = envelopeSubjectDigest(env);
  const b = envelopeSubjectDigest({ ...env, signature: 'ed25519:rotated' });
  const c = envelopeSubjectDigest({ ...env, signature: undefined });
  assert.equal(a, b, 'signature rotation must not change subject digest');
  assert.equal(a, c, 'absent signature must not change subject digest');

  // verifyReceiptBinding (direct call) covers the missing-receipt path too.
  const directMissing = verifyReceiptBinding(env, undefined, authority.publicKey);
  assert.equal(directMissing.verified, false);
  assert.equal(directMissing.rejectionReason, 'missing_receipt');
  assert.equal(
    directMissing.envelopeDigest,
    a,
    'direct call exposes the same envelope digest as envelopeSubjectDigest',
  );
}

function main(): void {
  caseHappyReceiptBacked();
  caseCliWorkflowPathStillThinClient();
  caseBadReceiptSignature();
  caseWrongSubjectKind();
  caseWrongSubjectId();
  caseWrongSubjectDigest();
  caseSha256PrefixedSubjectDigestAccepted();
  caseSubjectDigestAbsentStillVerifies();
  caseMissingAuthorityPublicKey();
  caseSameRunCollapseStillBlocks();
  caseMissingHashBindingsBlock();
  caseAcceptedWithoutVerifiedReceiptStaysThinClient();
  caseEnvelopeDigestIgnoresSignature();
  console.log(PASS_LINE);
}

try {
  main();
} catch (err) {
  console.error('✗ authority receipt classification smoke FAILED');
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
}
