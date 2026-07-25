// §1.10 v2 record union for the trusted RED-evidence subsystem (W2c / B-506e).
//
// Spec: docs/requirements/decisions/red-evidence-subsystem-spec.md §1.10
// (lines 591-721), §0.4 (digest + nullability rules), §3.1 (chain fields).
//
// This leaf OWNS the `proofstory.red_evidence.v2` record union and its digest
// derivations. It declares the FULL four-operation shape for type-completeness
// (red-assert / green-confirm / quarantine / recover); this story only WRITES
// the two control operations (quarantine / recover), while the run-record
// entrypoints (red-assert = W2d, green-confirm = W2e) declare their shapes here
// so the union is closed.
//
// §0.4 field rules encoded by the TypeScript shapes below:
//   - The three chain fields `seq` / `priorRecordDigest` / `supersedes` are
//     ALWAYS present on every v2 record. `priorRecordDigest` and `supersedes`
//     carry JSON `null` (never "" / never omitted) on a chain-founding record
//     (`seq === 1`).
//   - Every OTHER optional field is OMITTED entirely when absent (never null /
//     never ""). The per-operation interfaces list EXACTLY the fields each
//     operation carries — a field not listed for an operation is absent.
//   - `recordDigest` = CANON over the record with the `recordDigest` member
//     itself omitted (a digest cannot contain itself).
//
// Assurance scope (§0.6 practical tier): reproducible digests detect accidental
// substitution / casual drift through the registered surfaces; they do NOT
// resist a hostile local agent that rewrites the store and recomputes every
// digest offline (that is the Tier-C program).

import { canon, canonDigest, first12hex, omitUndefinedDeep } from './canon.js';

/** The on-record schema discriminator that separates v2 records from v1. */
export const RED_EVIDENCE_V2_SCHEMA_VERSION = 'proofstory.red_evidence.v2' as const;
/** The (unchanged) file-level schema version — the on-disk layout is v1. */
export const RED_EVIDENCE_FILE_SCHEMA_VERSION = 'proofstory.red_evidence.v1' as const;

export type RedEvidenceOperation = 'red-assert' | 'green-confirm' | 'quarantine' | 'recover';

/** The `<OP>-` prefix of a derived record id per operation (§3.4). */
export const RECORD_ID_OPERATION_PREFIX: Record<RedEvidenceOperation, string> = {
  'red-assert': 'RED',
  'green-confirm': 'GRN',
  quarantine: 'QUA',
  recover: 'REC',
};

/**
 * The chain fields present on EVERY v2 record (§0.4 / §3.1). `priorRecordDigest`
 * and `supersedes` are `null` iff `seq === 1`.
 */
export interface RedEvidenceChainFields {
  seq: number;
  priorRecordDigest: string | null;
  supersedes: string | null;
}

/** The GREEN relation subobject retained from v1 (§1.4). */
export interface RedEvidenceGreenRelation {
  targetRef: string;
  relation: 'same_acceptance' | 'regression_to_green' | 'replacement';
}

/**
 * Fields shared by every v2 record: the schema discriminator, the operation
 * discriminator, story/target identity, the chain fields, the operation key,
 * timestamp, and the self-omitting record digest.
 */
export interface RedEvidenceRecordV2Base extends RedEvidenceChainFields {
  id: string;
  schemaVersion: typeof RED_EVIDENCE_V2_SCHEMA_VERSION;
  operation: RedEvidenceOperation;
  storyId: string;
  acceptanceTargetRef: string;
  operationKey: string;
  createdAt: string;
  recordDigest: string;
}

/**
 * `operation: "red-assert"` — the full run-record shape (§1.10). Declared here
 * for union completeness; WRITTEN by W2d, not this story. `assertion` /
 * `policySnapshot` / `runReceipt` are carried opaquely (their exhaustive
 * envelope schema is §1.1, owned by the runner story).
 */
export interface RedAssertRecordV2 extends RedEvidenceRecordV2Base {
  operation: 'red-assert';
  trigger: string;
  observedFailure: string;
  baselineHeadHash: string;
  baselineMaterialHash: string;
  greenRelation: RedEvidenceGreenRelation;
  assertion: Record<string, unknown>;
  policySnapshot: Record<string, unknown>;
  specDigest: string;
  runReceipt: Record<string, unknown>;
  note?: string;
}

/**
 * `operation: "green-confirm"` — confirms the governing red-assert (§1.10).
 * Declared for union completeness; WRITTEN by W2e. Carries NO `assertion` /
 * `policySnapshot` of its own — the confirmed assertion is reachable via
 * `confirmsRecordId` and pinned by `confirmsAssertionDigest`.
 */
export interface GreenConfirmRecordV2 extends RedEvidenceRecordV2Base {
  operation: 'green-confirm';
  confirmsRecordId: string;
  confirmsRecordDigest: string;
  confirmsAssertionDigest: string;
  redBaselineHeadHash: string;
  redBaselineMaterialHash: string;
  greenHeadHash: string;
  greenMaterialHash: string;
  greenRelation: RedEvidenceGreenRelation;
  specDigest: string;
  runReceipt: Record<string, unknown>;
  note?: string;
}

/**
 * `operation: "quarantine"` | `"recover"` — the chain-control records (§1.10).
 * They carry the SAME control shape and differ only by `operation` / `linkKind`.
 * They carry NO baseline hashes, NO greenRelation, NO specDigest, and NO
 * assertion/policySnapshot/runReceipt (§1.10). This story WRITES these two.
 */
export interface ControlRecordV2 extends RedEvidenceRecordV2Base {
  operation: 'quarantine' | 'recover';
  /** The id of the record this control record references (§4.1). */
  recoversRecordId: string;
  /** The `recordDigest` of the record named by `recoversRecordId`. */
  referencedRecordDigest: string;
  linkKind: 'quarantines' | 'recovers';
  reason: string;
  /** DERIVED `<actor>@<sessionId>` (§4.1) — never a caller argument. */
  approvedBy: string;
}

export type QuarantineRecordV2 = ControlRecordV2 & { operation: 'quarantine'; linkKind: 'quarantines' };
export type RecoverRecordV2 = ControlRecordV2 & { operation: 'recover'; linkKind: 'recovers' };

export type RedEvidenceRecordV2 =
  | RedAssertRecordV2
  | GreenConfirmRecordV2
  | QuarantineRecordV2
  | RecoverRecordV2;

/**
 * Version-discriminated type guard (§0.4). A record is v2 iff it carries
 * `schemaVersion === "proofstory.red_evidence.v2"` — the DISCRIMINATOR governs,
 * not field presence (defense-in-depth: a malformed hybrid v2 record that also
 * carries an `observedFailure` is still v2).
 */
export function isRedEvidenceV2(record: unknown): record is RedEvidenceRecordV2 {
  return (
    typeof record === 'object' &&
    record !== null &&
    (record as { schemaVersion?: unknown }).schemaVersion === RED_EVIDENCE_V2_SCHEMA_VERSION
  );
}

/**
 * True iff `record` is a v2 chain-control record (quarantine / recover) — the
 * two operations this story writes.
 */
export function isControlRecordV2(record: unknown): record is ControlRecordV2 {
  return (
    isRedEvidenceV2(record) &&
    (record.operation === 'quarantine' || record.operation === 'recover')
  );
}

/**
 * Classify a stored record's schema. A v1 record has NO `schemaVersion` member
 * (the FILE carries the version, not the record). A record carrying an UNKNOWN
 * `schemaVersion` (e.g. `proofstory.red_evidence.v3`) fails CLOSED — it is never
 * silently accepted (CHK-002 forward-compatibility rule).
 */
export function classifyRedRecordSchema(record: unknown): 'v1' | 'v2' {
  if (typeof record !== 'object' || record === null) {
    throw new Error('red-evidence: a record must be an object');
  }
  const schemaVersion = (record as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion === undefined) return 'v1';
  if (schemaVersion === RED_EVIDENCE_V2_SCHEMA_VERSION) return 'v2';
  throw new Error(
    `red-evidence: unknown per-record schemaVersion ${JSON.stringify(schemaVersion)} — ` +
      `only ${JSON.stringify(RED_EVIDENCE_V2_SCHEMA_VERSION)} (v2) or an absent version (legacy v1) is accepted (fail-closed)`,
  );
}

/**
 * §1.10 `specDigest` = CANON over EXACTLY
 * `{ acceptanceTargetRef, greenRelation: { targetRef, relation } }` — those
 * keys, that nesting, nothing else.
 */
export function computeSpecDigest(acceptanceTargetRef: string, greenRelation: RedEvidenceGreenRelation): string {
  return canonDigest({
    acceptanceTargetRef,
    greenRelation: { targetRef: greenRelation.targetRef, relation: greenRelation.relation },
  });
}

/**
 * §0.4 self-omitting record digest: CANON over the record with `recordDigest`
 * omitted. Undefined optional members are stripped first (§0.4 omission);
 * explicit JSON `null` on the chain-founding fields is preserved.
 */
export function computeRecordDigest(recordWithoutDigest: Record<string, unknown>): string {
  const clone: Record<string, unknown> = { ...recordWithoutDigest };
  delete clone.recordDigest;
  return canonDigest(omitUndefinedDeep(clone));
}

/**
 * Recompute a stored v2 record's `recordDigest` from its own bytes and compare.
 * True iff the stored digest matches the canonical recomputation (used by the
 * append CONFLICT / store-corruption detector, §3.5).
 */
export function recordDigestMatches(record: RedEvidenceRecordV2): boolean {
  const { recordDigest, ...rest } = record as RedEvidenceRecordV2 & { recordDigest: string };
  return computeRecordDigest(rest as Record<string, unknown>) === recordDigest;
}

/**
 * The canonical JSON string of a v2 record (with `recordDigest` retained) — used
 * by tests to prove an already-written record is BYTE-IDENTICAL before and after
 * an unrelated append (§4.2 immutability).
 */
export function recordCanonicalBytes(record: RedEvidenceRecordV2): string {
  return canon(omitUndefinedDeep({ ...record }));
}

/** Re-export the W2a short handle helper for id derivation (§3.4). */
export { first12hex };
