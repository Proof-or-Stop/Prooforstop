/**
 * Canonical schema identities for gate-consumed lifecycle artifacts.
 *
 * This is deliberately an allow-list, not a prefix rewrite.  Writers use the
 * canonical proof-or-stop literal. Readers reject all retired identity families;
 * only the canonical older command-spec version remains supported.
 */

export const DONE_REQUIRED_EVIDENCE_SCHEMA = 'proof-or-stop.done-required-evidence' as const;

/** Versioned schema used by the proof-admissibility environment projection. */
export const DONE_REQUIRED_EVIDENCE_VERSIONED_SCHEMA = 'proof-or-stop.done_required_evidence.v1' as const;

/** Current portable command-spec envelope written by DONE-required validation. */
export const DONE_REQUIRED_COMMAND_SPEC_SCHEMA = 'proof-or-stop.command-spec.v2' as const;

/** Absolute-cwd command-spec schema retained only for historical verification. */
export const DONE_REQUIRED_COMMAND_SPEC_SCHEMA_V1 = 'proof-or-stop.command-spec.v1' as const;

export const CLOSEOUT_WRITE_RECEIPT_SCHEMA = 'proof-or-stop.closeout_write_receipt.v3' as const;

/** Versioned freshness snapshot written by current lifecycle readers. */
export const EVIDENCE_HASH_SNAPSHOT_SCHEMA = 'proof-or-stop.evidence_hash_snapshot.v1' as const;

/** Current lifecycle projection schemas. Readers require the canonical identity. */
export const AGENT_ASSET_RESOLUTION_SCHEMA = 'proof-or-stop.agent_asset_resolution.v1' as const;
export const DONE_PREPARE_SCHEMA = 'proof-or-stop.done_prepare.v1' as const;
export const DONE_PREPARE_GENERATED_METADATA_SCHEMA = 'proof-or-stop.done-prepare-generated-metadata.v1' as const;
export const DONE_PREPARE_VALIDATION_REUSE_SCHEMA = 'proof-or-stop.done-prepare-validation-reuse.v1' as const;
export const DONE_CLOSURE_SCHEMA = 'proof-or-stop.done_closure.v1' as const;
export const PROOF_BINDING_SCHEMA = 'proof-or-stop.proof_binding.v1' as const;
export const OBSERVABILITY_SNAPSHOT_SCHEMA = 'proof-or-stop.observability_snapshot.v1' as const;
export const USAGE_SWEEP_SCHEMA = 'proof-or-stop.usage_sweep.v1' as const;

export type DoneRequiredEvidenceSchema = typeof DONE_REQUIRED_EVIDENCE_SCHEMA;


export type DoneRequiredEvidenceVersionedSchema = typeof DONE_REQUIRED_EVIDENCE_VERSIONED_SCHEMA;


export type DoneRequiredCommandSpecSchema = typeof DONE_REQUIRED_COMMAND_SPEC_SCHEMA | typeof DONE_REQUIRED_COMMAND_SPEC_SCHEMA_V1;


export type CloseoutWriteReceiptSchema = typeof CLOSEOUT_WRITE_RECEIPT_SCHEMA;


export type EvidenceHashSnapshotSchema = typeof EVIDENCE_HASH_SNAPSHOT_SCHEMA;


export type DonePrepareGeneratedMetadataSchema = typeof DONE_PREPARE_GENERATED_METADATA_SCHEMA;


export type DonePrepareValidationReuseSchema = typeof DONE_PREPARE_VALIDATION_REUSE_SCHEMA;


export function isDoneRequiredEvidenceSchema(value: unknown): value is DoneRequiredEvidenceSchema {
  return value === DONE_REQUIRED_EVIDENCE_SCHEMA;
}

export function isDoneRequiredEvidenceVersionedSchema(value: unknown): value is DoneRequiredEvidenceVersionedSchema {
  return value === DONE_REQUIRED_EVIDENCE_VERSIONED_SCHEMA;
}

export function isDoneRequiredCommandSpecSchema(value: unknown): value is DoneRequiredCommandSpecSchema {
  return value === DONE_REQUIRED_COMMAND_SPEC_SCHEMA
    || value === DONE_REQUIRED_COMMAND_SPEC_SCHEMA_V1;
}

export function isDoneRequiredCommandSpecV2Schema(value: unknown): value is
  typeof DONE_REQUIRED_COMMAND_SPEC_SCHEMA {
  return value === DONE_REQUIRED_COMMAND_SPEC_SCHEMA;
}

export function isCloseoutWriteReceiptSchema(value: unknown): value is CloseoutWriteReceiptSchema {
  return value === CLOSEOUT_WRITE_RECEIPT_SCHEMA;
}

export function isEvidenceHashSnapshotSchema(value: unknown): value is EvidenceHashSnapshotSchema {
  return value === EVIDENCE_HASH_SNAPSHOT_SCHEMA;
}

export function isDonePrepareGeneratedMetadataSchema(value: unknown): value is DonePrepareGeneratedMetadataSchema {
  return value === DONE_PREPARE_GENERATED_METADATA_SCHEMA;
}

export function isDonePrepareValidationReuseSchema(value: unknown): value is DonePrepareValidationReuseSchema {
  return value === DONE_PREPARE_VALIDATION_REUSE_SCHEMA;
}

/** Current signed verification bundle identity; data-only to keep consumers import-order independent. */
export const VERIFICATION_RECEIPT_BUNDLE_V5 = 'proof-or-stop.verification-receipt-bundle.v5' as const;

/** Current Lab gate authority; retired journal domains are not admitted. */
export const ACCEPTANCE_AMENDMENT_ENTRY_SCHEMA = 'proof-or-stop.acceptance_amendment.v1' as const;
export const ACCEPTANCE_AMENDMENT_JOURNAL_SCHEMA = 'proof-or-stop.acceptance_amendments.v1' as const;
export const EFFECTIVE_PROGRESS_SCHEMA = 'proof-or-stop.effective_progress.v1' as const;
export const CONVERGENCE_PROGRESS_JOURNAL_SCHEMA = 'proof-or-stop.convergence_progress_journal.v1' as const;
