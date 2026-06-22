// Authority receipt classification (B-2522 Milestone 7 / CHK-001).
//
// Pure helper that classifies a fully bound EvidenceEnvelope as
// `receipt-backed-l2-plus` ONLY after verifying:
//   (a) the Python `AuthorityReceipt` signature against the authority's
//       published public key (ed25519 over canonical signature-less bytes), and
//   (b) the receipt subject binding to *this specific envelope*, at minimum:
//         - subjectKind === 'evidence'
//         - subjectId === envelope.evidenceId
//         - subjectDigest (when present) === canonical digest of the
//           signature-less envelope view
//
// Anything that fails (a) or (b) collapses to receiptVerified=false and the
// classifier downgrades to a `thin-client-*` / `local-only` class — even if
// every other L2+ field is populated. This is the mechanical defense against
// "transport accepted=true was already L2+" and "forged receipt with a wrong
// subject can promote envelopes" over-claims.
//
// Trust boundary (authority-client-role.md §"Cold-read definition of L2+
// authority", §"Transport acceptance is NOT receipt verification"):
//   - This helper is used by the future enforce-mode receipt-backed path only.
//   - The ordinary CLI workflow path (classifyCliAuthoritySubmission in
//     authority-submit.ts) MUST continue to pass receiptVerified=false; it
//     never holds a verified Python AuthorityReceipt.
//   - No I/O, no network, no fs. Pure functions; safe to use in smoke /
//     handler / gate code.

import {
  classifyAuthorityEvidence,
  type AuthorityClassification,
} from './authority-boundary.js';
import type { EvidenceEnvelopeContract } from './authority-contracts.js';
import type { AuthorityMode } from './authority-mode.js';
import {
  verifyAuthorityReceipt,
  type AuthorityReceipt,
} from './authority-runner-contracts.js';
import {
  canonicalDigest,
  stripSignature,
  type PublicKeyBase64,
} from './authority-signing.js';

/** Canonical subject kind expected on receipts that acknowledge an evidence envelope. */
export const RECEIPT_SUBJECT_KIND_EVIDENCE = 'evidence' as const;

/**
 * Why a receipt was not honored. Enumerated rather than free-form so smoke /
 * gate code can pattern-match the failure path mechanically.
 *
 * The order matches the verification pipeline: signature first, then subject
 * kind, then subject id, then subject digest.
 */
export type ReceiptRejectionReason =
  | 'missing_receipt'
  | 'missing_authority_public_key'
  | 'receipt_signature_invalid'
  | 'subject_kind_mismatch'
  | 'subject_id_mismatch'
  | 'subject_digest_mismatch';

export interface ReceiptVerification {
  /** True only when signature + subject binding all pass. */
  verified: boolean;
  /** Populated when verified=false; absent when verified=true. */
  rejectionReason?: ReceiptRejectionReason;
  /** Canonical digest of the signature-less envelope view (for audit / logs). */
  envelopeDigest: string;
  /** Whether the receipt carried a subjectDigest claim at all. */
  subjectDigestPresent: boolean;
}

export interface ReceiptClassificationInput {
  mode: AuthorityMode;
  envelope: EvidenceEnvelopeContract;
  /**
   * Receipt returned by the Python authority server. May be absent when no
   * receipt-bearing path ran (e.g., shadow observational POST).
   */
  receipt?: AuthorityReceipt;
  /**
   * Base64 ed25519 public key of the authority that should have signed the
   * receipt. Required to verify the signature; treated as missing if absent.
   */
  authorityPublicKey?: PublicKeyBase64;
  /** Whether the transport POST returned accepted=true. */
  transportAccepted?: boolean;
}

export interface ReceiptClassificationResult {
  classification: AuthorityClassification;
  receipt: ReceiptVerification;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Compute the canonical digest of the signature-less envelope view. Exposed
 * so receipt issuers (authority server, tests, fixtures) compute the SAME
 * digest the consumer will recompute — there is exactly one definition.
 *
 * Runtime re-validation (Handler coding convention): we recompute the digest from the
 * caller-supplied envelope every time; we never trust a precomputed digest
 * passed alongside the envelope.
 */
export function envelopeSubjectDigest(envelope: EvidenceEnvelopeContract): string {
  return canonicalDigest(stripSignature(envelope));
}

/**
 * Compare a receipt's claimed subjectDigest to the recomputed envelope canonical
 * digest. We accept two equivalent forms so Node- and Python-issued receipts can
 * both verify without coordinating on a string convention:
 *
 *   - the BARE canonical hex digest (what {@link envelopeSubjectDigest} returns)
 *   - the `sha256:<canonical-hex>` prefixed form (Python `AuthorityReceipt`
 *     issuers conventionally tag the algorithm)
 *
 * The match is exact-string and case-sensitive against either of those two
 * forms; we do NOT do generic algorithm parsing — only the literal `sha256:`
 * prefix paired with the recomputed hex. Anything else (different hex,
 * different algorithm tag, trailing whitespace, etc.) fails. This is a runtime
 * re-check; the contract is also documented on the JSDoc of
 * {@link verifyReceiptBinding} step 6.
 */
function subjectDigestMatches(
  claimed: string | undefined,
  envelopeDigest: string,
): boolean {
  if (!isNonEmptyString(claimed)) {
    return false;
  }
  return claimed === envelopeDigest || claimed === `sha256:${envelopeDigest}`;
}

/**
 * Verify a receipt against the supplied envelope + authority public key.
 *
 * Returns a structured result rather than throwing so callers can map the
 * failure path to a controlled classification outcome (the smoke covers each
 * rejection reason individually).
 *
 * Pipeline (short-circuits on first failure; each failure path returns false
 * with a specific reason):
 *   1. receipt present?
 *   2. authority public key supplied + non-empty?
 *   3. ed25519 signature verifies (verifyAuthorityReceipt)?
 *   4. subjectKind === 'evidence'?
 *   5. subjectId === envelope.evidenceId?
 *   6. subjectDigest (if present on the receipt) matches the envelope canonical
 *      digest? Accepted forms are the BARE canonical hex digest produced by
 *      {@link envelopeSubjectDigest} (Node-issued receipts) and the
 *      `sha256:<canonical-hex>` prefixed form (Python `AuthorityReceipt` issuers
 *      conventionally tag the algorithm). Any other value — including a
 *      different hex, a different algorithm prefix, or trailing whitespace —
 *      fails as `subject_digest_mismatch`.
 *      When absent on the receipt, this step is treated as "not asserted by
 *      the authority"; the binding still passes, because the subjectId match
 *      already pins the receipt to this evidenceId. The smoke covers all
 *      branches (present-bare-matching, present-prefixed-matching,
 *      present-mismatching, absent).
 */
export function verifyReceiptBinding(
  envelope: EvidenceEnvelopeContract,
  receipt: AuthorityReceipt | undefined,
  authorityPublicKey: PublicKeyBase64 | undefined,
): ReceiptVerification {
  const envelopeDigest = envelopeSubjectDigest(envelope);
  if (!receipt) {
    return {
      verified: false,
      rejectionReason: 'missing_receipt',
      envelopeDigest,
      subjectDigestPresent: false,
    };
  }
  const subjectDigestPresent = isNonEmptyString(receipt.subjectDigest);
  if (!isNonEmptyString(authorityPublicKey)) {
    return {
      verified: false,
      rejectionReason: 'missing_authority_public_key',
      envelopeDigest,
      subjectDigestPresent,
    };
  }
  // Signature first: a forged receipt with the "right" subject fields but no
  // valid signature must never count. verifyAuthorityReceipt returns false
  // (does not throw) on any tamper / wrong-key / missing-signature path.
  if (!verifyAuthorityReceipt(receipt, authorityPublicKey)) {
    return {
      verified: false,
      rejectionReason: 'receipt_signature_invalid',
      envelopeDigest,
      subjectDigestPresent,
    };
  }
  if (receipt.subjectKind !== RECEIPT_SUBJECT_KIND_EVIDENCE) {
    return {
      verified: false,
      rejectionReason: 'subject_kind_mismatch',
      envelopeDigest,
      subjectDigestPresent,
    };
  }
  if (receipt.subjectId !== envelope.evidenceId) {
    return {
      verified: false,
      rejectionReason: 'subject_id_mismatch',
      envelopeDigest,
      subjectDigestPresent,
    };
  }
  if (subjectDigestPresent && !subjectDigestMatches(receipt.subjectDigest, envelopeDigest)) {
    return {
      verified: false,
      rejectionReason: 'subject_digest_mismatch',
      envelopeDigest,
      subjectDigestPresent,
    };
  }
  return {
    verified: true,
    envelopeDigest,
    subjectDigestPresent,
  };
}

/**
 * Classify an envelope as `receipt-backed-l2-plus` only after the receipt
 * verification pipeline passes. On any failure (no receipt, bad signature,
 * wrong subject) the helper feeds receiptVerified=false into the boundary
 * classifier so the result downgrades to `thin-client-*` / `local-only`.
 *
 * This is the only sanctioned path to ever set receiptVerified=true. The
 * ordinary CLI workflow path (classifyCliAuthoritySubmission) does NOT use
 * this helper and must keep receiptVerified=false.
 */
export function classifyReceiptBackedEvidence(
  input: ReceiptClassificationInput,
): ReceiptClassificationResult {
  const receipt = verifyReceiptBinding(
    input.envelope,
    input.receipt,
    input.authorityPublicKey,
  );
  const classification = classifyAuthorityEvidence({
    mode: input.mode,
    envelope: input.envelope,
    receiptVerified: receipt.verified,
    transportAccepted: input.transportAccepted,
  });
  return { classification, receipt };
}
