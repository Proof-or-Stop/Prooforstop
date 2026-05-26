// Authority trust-boundary classifier (B-ec09 / Milestone 1).
//
// Mechanically classifies a Koala CLI authority submission so that downstream
// gates / docs / tests cannot mistake CLI-shaped evidence for receipt-backed
// L2+ production authority. PD-1 keeps the CLI as a thin local/shadow client,
// so the CLI envelope is a strict subset (no run bindings, no provider/model/
// vendor, no actor signature, no Python authority receipt). A truthful classifier
// is the only mechanical defence against the "accepted=true means authoritative"
// over-claim.
//
// Scope (Milestone 1):
//   - Pure functions; no I/O, no network.
//   - Does not implement actor keys, signing, receipt verification, or the full
//     EvidenceEnvelope FU-1/FU-2/FU-3. Those are deferred to dedicated stories
//     once the enforce-mode PD-1 is explicitly approved.
//   - Used by authority-submit.ts and the boundary smoke; not yet a hard CLI gate.

import type { EvidenceEnvelopeContract } from './authority-contracts.js';
import type { AuthorityMode } from './authority-mode.js';

/**
 * Mechanical classification of where a piece of authority evidence sits on the
 * trust boundary. The CLI cannot produce anything stronger than `thin-client-*`
 * today; `receipt-backed-l2-plus` is reserved for runner/Python authority work
 * that hasn't landed.
 */
export type AuthorityEvidenceClass =
  | 'local-only'              // off mode; evidence stayed local, never POSTed
  | 'thin-client-shadow'      // shadow mode; POST observational, local write authoritative locally only
  | 'thin-client-transport-accepted'  // enforce/shadow + server returned accepted=true on transport, NOT a verified receipt
  | 'receipt-backed-l2-plus'; // requires actor-key signed envelope + verified Python authority receipt + run bindings; CLI never produces this today

export interface AuthorityClassificationInput {
  mode: AuthorityMode;
  envelope: Pick<
    EvidenceEnvelopeContract,
    | 'producerRunId'
    | 'verifierRunId'
    | 'provider'
    | 'model'
    | 'vendor'
    | 'signature'
    | 'commandDigest'
    | 'transcriptHash'
    | 'diffHash'
  >;
  /**
   * Verified Python authority receipt. The current CLI never verifies a receipt
   * signature, so this should be `false` everywhere in the CLI today. Reserved
   * for future Runner / authority-receipt work.
   */
  receiptVerified?: boolean;
  /** Whether the transport POST returned accepted=true. */
  transportAccepted?: boolean;
}

export interface AuthorityClassification {
  klass: AuthorityEvidenceClass;
  /** Stable, human-readable label safe for CLI output / logs. */
  label: string;
  /** Missing requirements that would be needed to reach receipt-backed L2+. */
  missing: ReadonlyArray<AuthorityL2Requirement>;
  /** Reason summary intended for adversarial smoke / gate messaging. */
  reason: string;
}

export type AuthorityL2Requirement =
  | 'producerRunId'
  | 'verifierRunId'
  | 'provider'
  | 'model'
  | 'vendor'
  | 'commandDigest'
  | 'transcriptHash'
  | 'diffHash'
  | 'envelopeSignature'
  | 'verifiedAuthorityReceipt';

const L2_REQUIREMENTS: ReadonlyArray<AuthorityL2Requirement> = [
  'producerRunId',
  'verifierRunId',
  'provider',
  'model',
  'vendor',
  'commandDigest',
  'transcriptHash',
  'diffHash',
  'envelopeSignature',
  'verifiedAuthorityReceipt',
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Enumerate the L2+ fields that are missing from this submission.
 * Used both to drive {@link classifyAuthorityEvidence} and to render the
 * adversarial smoke output.
 */
export function missingL2Requirements(
  input: AuthorityClassificationInput,
): AuthorityL2Requirement[] {
  const env = input.envelope;
  const missing: AuthorityL2Requirement[] = [];
  if (!isNonEmptyString(env.producerRunId)) missing.push('producerRunId');
  if (!isNonEmptyString(env.verifierRunId)) missing.push('verifierRunId');
  if (!isNonEmptyString(env.provider)) missing.push('provider');
  if (!isNonEmptyString(env.model)) missing.push('model');
  if (!isNonEmptyString(env.vendor)) missing.push('vendor');
  if (!isNonEmptyString(env.commandDigest)) missing.push('commandDigest');
  if (!isNonEmptyString(env.transcriptHash)) missing.push('transcriptHash');
  if (!isNonEmptyString(env.diffHash)) missing.push('diffHash');
  if (!isNonEmptyString(env.signature)) missing.push('envelopeSignature');
  if (input.receiptVerified !== true) missing.push('verifiedAuthorityReceipt');
  return missing;
}

/**
 * Classify a CLI authority submission against the L2+ trust boundary.
 *
 * Truth-source contract (authority-client-role.md §L2+ Evidence Boundary):
 *   - The CLI is a thin local/shadow lifecycle client.
 *   - `accepted: true` returned by the transport is acceptance of the POST, NOT
 *     verification of a signed Python authority receipt.
 *   - No CLI submission may classify as `receipt-backed-l2-plus` while ANY of
 *     the L2_REQUIREMENTS are missing. Until actor-key signing + receipt
 *     verification land in dedicated stories, that set is non-empty for every
 *     CLI envelope.
 */
export function classifyAuthorityEvidence(
  input: AuthorityClassificationInput,
): AuthorityClassification {
  const missing = missingL2Requirements(input);

  if (missing.length === 0) {
    return {
      klass: 'receipt-backed-l2-plus',
      label: 'receipt-backed L2+ authority',
      missing,
      reason:
        'envelope has run bindings, provider/model/vendor, command/transcript/diff hashes, signature, and a verified Python authority receipt',
    };
  }

  if (input.mode === 'off') {
    return {
      klass: 'local-only',
      label: 'local-only (off mode; no POST)',
      missing,
      reason: `KOALA_AUTHORITY_MODE=off; local evidence never POSTed; missing L2+ fields: ${missing.join(', ')}`,
    };
  }

  if (input.transportAccepted === true) {
    return {
      klass: 'thin-client-transport-accepted',
      label: 'thin-client transport-accepted (NOT a verified receipt)',
      missing,
      reason: `authority server returned accepted=true on POST transport; this is NOT signed receipt verification; missing L2+ fields: ${missing.join(', ')}`,
    };
  }

  // shadow with non-accepted or enforce with non-accepted both reduce to a
  // thin-client classification — caller (authority-submit) decides whether to
  // gate, here we only label.
  return {
    klass: 'thin-client-shadow',
    label: input.mode === 'enforce'
      ? 'thin-client enforce (transport not accepted)'
      : 'thin-client shadow (observational POST)',
    missing,
    reason: `mode=${input.mode}; transport accepted=false; missing L2+ fields: ${missing.join(', ')}`,
  };
}

/**
 * Adversarial guard: even if a caller hand-crafts a forged "accepted=true" path
 * on a CLI-shaped envelope, the classifier must NOT return
 * `receipt-backed-l2-plus`. This is the mechanical assertion used by the
 * authority-boundary smoke to prove the over-claim is impossible by construction.
 */
export function isReceiptBackedL2Plus(c: AuthorityClassification): boolean {
  return c.klass === 'receipt-backed-l2-plus' && c.missing.length === 0;
}

/** All L2+ requirements (frozen list) — exposed so docs/tests stay in sync. */
export function l2PlusRequirements(): ReadonlyArray<AuthorityL2Requirement> {
  return L2_REQUIREMENTS;
}
