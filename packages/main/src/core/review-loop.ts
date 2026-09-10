/**
 * B-7a34 CHK-001: Review Reflection Loop -- pure core helpers.
 *
 * No I/O. No side effects. All storage goes through StoryStore.
 * Reflection/reusableLearning is context only; it is not review pass,
 * validation evidence, or authority evidence.
 */

import type {
  ReviewLoopRecord,
  ReviewLoopRollbackRef,
  ReviewLoopTrigger,
  ReviewLoopPolicy,
  ReviewLoopStatus,
  ReviewLoopStart,
  ReviewLoopIteration,
} from './types.js';

export const REVIEW_LOOP_FILENAME = 'review-loops.jsonl';

// Conservative default policy matching spec section 9.
export const DEFAULT_REVIEW_LOOP_POLICY: ReviewLoopPolicy = {
  schemaVersion: 'proof-or-stop.review_loop_policy.v1',
  maxIterations: 5,
  maxNoProgressIterations: 2,
  maxRuntimeMinutes: 30,
  maxCostUSD: 5,
  allowAutoHandoff: false,
  allowAutoRollback: false,
  requireHumanForScopeExpansion: true,
  requireHumanForProtectedFiles: true,
  stopOnTestRegression: true,
  stopOnScopeViolation: true,
};

const FULL_GIT_HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const SHA256_HASH = /^[0-9a-f]{64}$/i;

function isPlaceholderHash(value: string): boolean {
  return /^([0-9a-f])\1+$/i.test(value);
}

function validateHashField(name: string, value: string | undefined, pattern: RegExp, description: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return `${name} is required`;
  if (!pattern.test(normalized)) return `${name} must be ${description}`;
  if (isPlaceholderHash(normalized)) return `${name} must not be a placeholder hash`;
  return undefined;
}

export function validateRollbackRef(ref: ReviewLoopRollbackRef): string | undefined {
  return (
    validateHashField('rollbackRef.headHash', ref.headHash, FULL_GIT_HASH, 'a full Git object hash (40 or 64 hex characters)') ||
    validateHashField('rollbackRef.diffHash', ref.diffHash, SHA256_HASH, 'a SHA-256 hex digest (64 hex characters)') ||
    validateHashField('rollbackRef.materialHash', ref.materialHash, SHA256_HASH, 'a SHA-256 hex digest (64 hex characters)') ||
    (ref.scopeContractHash
      ? validateHashField('rollbackRef.scopeContractHash', ref.scopeContractHash, SHA256_HASH, 'a SHA-256 hex digest (64 hex characters)')
      : undefined)
  );
}

/**
 * Returns an error string if the trigger has no refs, undefined otherwise.
 * Every active loop must bind to at least one finding, bug, validation failure,
 * or scope violation.
 */
export function validateTriggerRefs(trigger: ReviewLoopTrigger): string | undefined {
  const hasRefs =
    (trigger.findingIds?.length ?? 0) > 0 ||
    (trigger.bugIds?.length ?? 0) > 0 ||
    (trigger.validationFailureRefs?.length ?? 0) > 0 ||
    (trigger.scopeViolationRefs?.length ?? 0) > 0;
  if (!hasRefs) {
    return 'trigger must include at least one findingId, bugId, validationFailureRef, or scopeViolationRef';
  }
  return undefined;
}

export function validateResolvedCloseInvariant(
  status: ReviewLoopStatus,
  materialHash: string,
  resolvedEvidenceRefs: string[] | undefined,
  supersedingEvidenceRefs: string[] | undefined,
  currentMaterialHash: string | undefined,
): string | undefined {
  if (status !== 'resolved') return undefined;
  const evidenceRefCount = (resolvedEvidenceRefs?.length ?? 0) + (supersedingEvidenceRefs?.length ?? 0);
  if (evidenceRefCount === 0) {
    return 'resolved close requires resolvedEvidenceRefs or supersedingEvidenceRefs';
  }
  if (!currentMaterialHash) {
    return 'resolved close requires a computable current material hash';
  }
  if (materialHash !== currentMaterialHash) {
    return `resolved close materialHash is stale: expected ${currentMaterialHash}, got ${materialHash}`;
  }
  return undefined;
}

/**
 * Returns the latest record for a given loopId, or undefined if none found.
 * REVIEW gate derives loop state by reading the latest record's status.
 */
export function deriveLatestLoopRecord(
  records: ReviewLoopRecord[],
  loopId: string
): ReviewLoopRecord | undefined {
  // Records are append-only; the last one for a loopId is the latest state.
  let latest: ReviewLoopRecord | undefined;
  for (const r of records) {
    if (r.loopId === loopId) latest = r;
  }
  return latest;
}

/**
 * Returns the effective status of a loop, or undefined if the loopId is unknown.
 */
export function deriveLoopStatus(
  records: ReviewLoopRecord[],
  loopId: string
): ReviewLoopStatus | undefined {
  const latest = deriveLatestLoopRecord(records, loopId);
  return latest?.status as ReviewLoopStatus | undefined;
}

/**
 * Returns all loopIds whose latest record has status='open'.
 * An open loop blocks REVIEW -> TEST.
 */
export function listActiveLoops(records: ReviewLoopRecord[]): string[] {
  // Build a map from loopId -> latest record index to get last-wins semantics.
  const latestByLoop = new Map<string, ReviewLoopRecord>();
  for (const r of records) {
    latestByLoop.set(r.loopId, r);
  }
  const active: string[] = [];
  for (const [loopId, latest] of latestByLoop) {
    if (latest.status === 'open') active.push(loopId);
  }
  return active;
}

/**
 * Returns the next 1-based iteration number for a loop.
 * Counts existing iteration records for the loopId.
 */
export function nextIterationNumber(records: ReviewLoopRecord[], loopId: string): number {
  let count = 0;
  for (const r of records) {
    if (r.loopId === loopId && r.event === 'iteration') count++;
  }
  return count + 1;
}

/** Type guard: record is a start event. */
export function isLoopStart(r: ReviewLoopRecord): r is ReviewLoopStart {
  return r.event === 'start';
}

/** Type guard: record is an iteration event. */
export function isLoopIteration(r: ReviewLoopRecord): r is ReviewLoopIteration {
  return r.event === 'iteration';
}
