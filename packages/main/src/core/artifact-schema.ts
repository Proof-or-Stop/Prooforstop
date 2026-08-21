/**
 * Canonical schema identities for gate-consumed lifecycle artifacts.
 *
 * This is deliberately an allow-list, not a prefix rewrite.  Writers use the
 * canonical proof-or-stop literal.  Readers accept only the exact historical
 * lattice literal(s) listed beside it, so unknown schemas and archived formats
 * remain opaque and are never silently migrated.
 */

export const DONE_REQUIRED_EVIDENCE_SCHEMA = 'proof-or-stop.done-required-evidence' as const;
export const DONE_REQUIRED_EVIDENCE_SCHEMA_LEGACY = 'lattice.done-required-evidence' as const;

/** Versioned schema used by the proof-admissibility environment projection. */
export const DONE_REQUIRED_EVIDENCE_VERSIONED_SCHEMA = 'proof-or-stop.done_required_evidence.v1' as const;
export const DONE_REQUIRED_EVIDENCE_VERSIONED_SCHEMA_LEGACY = 'lattice.done_required_evidence.v1' as const;

/** Current portable command-spec envelope written by DONE-required validation. */
export const DONE_REQUIRED_COMMAND_SPEC_SCHEMA = 'proof-or-stop.command-spec.v2' as const;
export const DONE_REQUIRED_COMMAND_SPEC_SCHEMA_LEGACY_V2 = 'lattice.command-spec.v2' as const;

/** Absolute-cwd command-spec schema retained only for historical verification. */
export const DONE_REQUIRED_COMMAND_SPEC_SCHEMA_LEGACY_V1 = 'lattice.command-spec.v1' as const;

export const CLOSEOUT_WRITE_RECEIPT_SCHEMA = 'proof-or-stop.closeout_write_receipt.v3' as const;
export const CLOSEOUT_WRITE_RECEIPT_SCHEMA_LEGACY = 'lattice.closeout_write_receipt.v3' as const;

/** Versioned freshness snapshot written by current lifecycle readers. */
export const EVIDENCE_HASH_SNAPSHOT_SCHEMA = 'proof-or-stop.evidence_hash_snapshot.v1' as const;
/** Historical freshness snapshot accepted only for dual-read compatibility. */
export const EVIDENCE_HASH_SNAPSHOT_SCHEMA_LEGACY = 'lattice.evidence_hash_snapshot.v1' as const;

export type DoneRequiredEvidenceSchema =
  | typeof DONE_REQUIRED_EVIDENCE_SCHEMA
  | typeof DONE_REQUIRED_EVIDENCE_SCHEMA_LEGACY;

export type DoneRequiredEvidenceVersionedSchema =
  | typeof DONE_REQUIRED_EVIDENCE_VERSIONED_SCHEMA
  | typeof DONE_REQUIRED_EVIDENCE_VERSIONED_SCHEMA_LEGACY;

export type DoneRequiredCommandSpecSchema =
  | typeof DONE_REQUIRED_COMMAND_SPEC_SCHEMA
  | typeof DONE_REQUIRED_COMMAND_SPEC_SCHEMA_LEGACY_V2
  | typeof DONE_REQUIRED_COMMAND_SPEC_SCHEMA_LEGACY_V1;

export type CloseoutWriteReceiptSchema =
  | typeof CLOSEOUT_WRITE_RECEIPT_SCHEMA
  | typeof CLOSEOUT_WRITE_RECEIPT_SCHEMA_LEGACY;

export type EvidenceHashSnapshotSchema =
  | typeof EVIDENCE_HASH_SNAPSHOT_SCHEMA
  | typeof EVIDENCE_HASH_SNAPSHOT_SCHEMA_LEGACY;

export function isDoneRequiredEvidenceSchema(value: unknown): value is DoneRequiredEvidenceSchema {
  return value === DONE_REQUIRED_EVIDENCE_SCHEMA || value === DONE_REQUIRED_EVIDENCE_SCHEMA_LEGACY;
}

export function isDoneRequiredEvidenceVersionedSchema(value: unknown): value is DoneRequiredEvidenceVersionedSchema {
  return value === DONE_REQUIRED_EVIDENCE_VERSIONED_SCHEMA
    || value === DONE_REQUIRED_EVIDENCE_VERSIONED_SCHEMA_LEGACY;
}

export function isDoneRequiredCommandSpecSchema(value: unknown): value is DoneRequiredCommandSpecSchema {
  return value === DONE_REQUIRED_COMMAND_SPEC_SCHEMA
    || value === DONE_REQUIRED_COMMAND_SPEC_SCHEMA_LEGACY_V2
    || value === DONE_REQUIRED_COMMAND_SPEC_SCHEMA_LEGACY_V1;
}

export function isDoneRequiredCommandSpecV2Schema(value: unknown): value is
  typeof DONE_REQUIRED_COMMAND_SPEC_SCHEMA | typeof DONE_REQUIRED_COMMAND_SPEC_SCHEMA_LEGACY_V2 {
  return value === DONE_REQUIRED_COMMAND_SPEC_SCHEMA
    || value === DONE_REQUIRED_COMMAND_SPEC_SCHEMA_LEGACY_V2;
}

export function isCloseoutWriteReceiptSchema(value: unknown): value is CloseoutWriteReceiptSchema {
  return value === CLOSEOUT_WRITE_RECEIPT_SCHEMA || value === CLOSEOUT_WRITE_RECEIPT_SCHEMA_LEGACY;
}

export function isEvidenceHashSnapshotSchema(value: unknown): value is EvidenceHashSnapshotSchema {
  return value === EVIDENCE_HASH_SNAPSHOT_SCHEMA || value === EVIDENCE_HASH_SNAPSHOT_SCHEMA_LEGACY;
}
