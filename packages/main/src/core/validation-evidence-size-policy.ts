/** Shared read and write budgets. This leaf module has no IO or store dependencies. */
/**
 * Explicit output ceiling for every managed-metadata `git` read.
 *
 * Node applies a 1,048,576-byte `maxBuffer` default to `execFileSync`, and a read above it throws
 * ENOBUFS rather than returning truncated content. The managed metadata this module commits is not
 * bounded by that number: `test-evidence.json` serialises one entry per configured validate command,
 * so it grows with the command count, and it measured 1,369,692 bytes on story B-9ff1. Under the
 * default every such read failed, and the failure surfaced as a digest comparison against a null,
 * i.e. as "verified metadata changed after manifest verification".
 *
 * 32 MiB is 32x the Node default, far above any observed artifact, and cheap: Node grows the pipe
 * buffer on demand, so a high ceiling costs nothing until content actually arrives. The evidence
 * reducer and StoryStore writer derive its warning and bounding thresholds from THIS
 * constant so the two cannot drift apart.
 *
 * What this ceiling does NOT promise: that every managed file stays under it. Only
 * `test-evidence.json` has an aggregate bound. `process-events.jsonl` is append-only and never
 * truncated, and `done-required-evidence.json` is written by other paths entirely, so either can
 * reach the ceiling in time. That is why a read above the ceiling must fail DIAGNOSTICALLY - see
 * done-prepare-generated-metadata.ts describeContentReadFailure, which names the ceiling and the measured capture and never returns
 * content - rather than being assumed unreachable.
 */
export const METADATA_BLOB_READ_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
export const VALIDATION_EVIDENCE_READ_CEILING_BYTES = METADATA_BLOB_READ_MAX_BUFFER_BYTES;
/**
 * Advisory at a quarter of the ceiling (8 MiB against a 32 MiB ceiling). Chosen against the
 * measured growth curve, not by taste: 8 MiB is roughly 6x the 1,369,692-byte artifact that caused
 * the incident, which is far enough ahead that an operator meets the advisory with room to act, and
 * far enough behind the bound that the advisory is not a synonym for it.
 */
export const VALIDATION_EVIDENCE_ADVISORY_FRACTION = 0.25;
/** Hard bound at three quarters of the ceiling, leaving 25 percent headroom for the read itself. */
export const VALIDATION_EVIDENCE_BOUND_FRACTION = 0.75;
export const VALIDATION_EVIDENCE_ADVISORY_BYTES = Math.floor(VALIDATION_EVIDENCE_READ_CEILING_BYTES * VALIDATION_EVIDENCE_ADVISORY_FRACTION);
export const VALIDATION_EVIDENCE_BOUND_BYTES = Math.floor(VALIDATION_EVIDENCE_READ_CEILING_BYTES * VALIDATION_EVIDENCE_BOUND_FRACTION);

/** The final UTF-8 artifact, including its newline, may equal the cap. */
export function isWithinValidationEvidenceWriteBound(bytes: number, budget = VALIDATION_EVIDENCE_BOUND_BYTES): boolean {
  return Number.isSafeInteger(bytes) && bytes >= 0 && Number.isSafeInteger(budget) && bytes <= budget;
}
