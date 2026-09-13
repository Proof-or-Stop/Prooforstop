/** Shared read and write budgets. This leaf module has no IO or store dependencies. */
export const METADATA_BLOB_READ_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
export const VALIDATION_EVIDENCE_READ_CEILING_BYTES = METADATA_BLOB_READ_MAX_BUFFER_BYTES;
export const VALIDATION_EVIDENCE_ADVISORY_FRACTION = 0.25;
export const VALIDATION_EVIDENCE_BOUND_FRACTION = 0.75;
export const VALIDATION_EVIDENCE_ADVISORY_BYTES = Math.floor(VALIDATION_EVIDENCE_READ_CEILING_BYTES * VALIDATION_EVIDENCE_ADVISORY_FRACTION);
export const VALIDATION_EVIDENCE_BOUND_BYTES = Math.floor(VALIDATION_EVIDENCE_READ_CEILING_BYTES * VALIDATION_EVIDENCE_BOUND_FRACTION);

/** The final UTF-8 artifact, including its newline, may equal the cap. */
export function isWithinValidationEvidenceWriteBound(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= VALIDATION_EVIDENCE_BOUND_BYTES;
}
