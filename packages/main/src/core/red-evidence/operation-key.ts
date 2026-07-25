// §3.4 operation-key preimages + deterministic record id (W2c / B-506e).
//
// Spec: docs/requirements/decisions/red-evidence-subsystem-spec.md §3.4
// (lines 1000-1050). Logical request identity is SEPARATED from chain placement:
// the operation key contains NO `priorRecordDigest` and NO `seq` (audit round 4:
// including chain placement made a post-append retry derive a fresh key and
// re-append). `approvedBy` is DELIBERATELY excluded from the control key (audit
// round 5: session identity in the key broke cross-session retry dedupe).
//
// `recordId = <OP>-first12hex(operationKey)-<seq>`; `seq` is assigned at append
// AFTER the dedupe search, so retries of the same logical operation reproduce the
// identical operationKey and dedupe correctly whatever the chain head now is.

import { canonDigest } from './canon.js';
import { first12hex, RECORD_ID_OPERATION_PREFIX, type RedEvidenceOperation } from './record-v2.js';

/**
 * `normalizedReason` = `reason` trimmed with internal whitespace runs collapsed
 * to single ASCII spaces (§3.4). This is the dedupe-safety rule: two calls whose
 * reasons differ only cosmetically in whitespace derive the SAME operation key.
 */
export function normalizeReason(reason: string): string {
  return reason.trim().replace(/\s+/g, ' ');
}

/** The §3.4 control-key preimage for quarantine / recover. */
export interface ControlOperationKeyInput {
  operation: 'quarantine' | 'recover';
  storyId: string;
  acceptanceTargetRef: string;
  recoversRecordId: string;
  referencedRecordDigest: string;
  /** RAW reason — normalized internally before canonicalization. */
  reason: string;
}

/**
 * §3.4 control key: `CANON({ operation, storyId, acceptanceTargetRef,
 * recoversRecordId, referencedRecordDigest, normalizedReason })`. `approvedBy` is
 * deliberately excluded (it stays on the record, covered by `recordDigest`).
 */
export function controlOperationKey(input: ControlOperationKeyInput): string {
  return canonDigest({
    operation: input.operation,
    storyId: input.storyId,
    acceptanceTargetRef: input.acceptanceTargetRef,
    recoversRecordId: input.recoversRecordId,
    referencedRecordDigest: input.referencedRecordDigest,
    normalizedReason: normalizeReason(input.reason),
  });
}

/** The §3.4 red-assert 8-field preimage (declared for completeness; W2d writes it). */
export interface RedAssertOperationKeyInput {
  storyId: string;
  acceptanceTargetRef: string;
  baselineHeadHash: string;
  baselineMaterialHash: string;
  specDigest: string;
  assertionDigest: string;
  policyDigest: string;
}

export function redAssertOperationKey(input: RedAssertOperationKeyInput): string {
  return canonDigest({
    operation: 'red-assert',
    storyId: input.storyId,
    acceptanceTargetRef: input.acceptanceTargetRef,
    baselineHeadHash: input.baselineHeadHash,
    baselineMaterialHash: input.baselineMaterialHash,
    specDigest: input.specDigest,
    assertionDigest: input.assertionDigest,
    policyDigest: input.policyDigest,
  });
}

/** The §3.4 green-confirm 8-field preimage (declared for completeness; W2e writes it). */
export interface GreenConfirmOperationKeyInput {
  storyId: string;
  acceptanceTargetRef: string;
  greenHeadHash: string;
  greenMaterialHash: string;
  confirmsRecordDigest: string;
  confirmsAssertionDigest: string;
  specDigest: string;
}

export function greenConfirmOperationKey(input: GreenConfirmOperationKeyInput): string {
  return canonDigest({
    operation: 'green-confirm',
    storyId: input.storyId,
    acceptanceTargetRef: input.acceptanceTargetRef,
    greenHeadHash: input.greenHeadHash,
    greenMaterialHash: input.greenMaterialHash,
    confirmsRecordDigest: input.confirmsRecordDigest,
    confirmsAssertionDigest: input.confirmsAssertionDigest,
    specDigest: input.specDigest,
  });
}

/**
 * `recordId = <OP>-first12hex(operationKey)-<seq>` (§3.4). `first12hex` reuses the
 * W2a helper over the 64-hex body EXCLUDING the `sha256:` prefix; `seq` is the
 * chain position assigned at append time.
 */
export function deriveRecordId(operation: RedEvidenceOperation, operationKey: string, seq: number): string {
  const prefix = RECORD_ID_OPERATION_PREFIX[operation];
  return `${prefix}-${first12hex(operationKey)}-${seq}`;
}
