/**
 * B-7813 CHK-002: structured stall-resolution record — validate + sign the
 * resolution that clears the CHK-001 convergence-stall block for EXACTLY the
 * current stalled review round.
 *
 * PURE module: crypto signing + validation only. No store, no fs, no clock in
 * the signature path. The I/O (persist/read stall-adjudication.json) lives in
 * handlers/stall-adjudication.ts and the gate seam consumer
 * (hasCurrentRoundStallResolution) lives in core/review-convergence.ts.
 *
 * Single source of truth for the five actions is STALL_RESOLUTION_ACTIONS in
 * core/review-convergence.ts (CHK-001). This module imports that tuple so the
 * CLI command enum, the block prompt, and this validator can never drift. The
 * import is function-scoped only (never accessed at module-init), so the mutual
 * review-convergence ↔ stall-adjudication edge is safe under ESM live bindings.
 *
 * Re-validation contract (CLAUDE.md "Handler encoding convention"): the reason
 * minimum length + the current-round binding + the signature are enforced at
 * BOTH consumption points — the handler (validateStallResolutionInput on write)
 * and the gate (isValidCurrentRoundStallResolution on read). A stale
 * (previous-round) / empty-reason / wrong-action / unsigned / tampered record is
 * refused at every point; neither path trusts the other to have checked.
 */
import { createHash } from 'crypto';
import { STALL_RESOLUTION_ACTIONS, type StallResolutionAction } from './review-convergence.js';
import type { StallAdjudicationData } from './types.js';

/** Signature salt (versioned; a bump invalidates every prior signed record). */
export const STALL_ADJUDICATION_SALT = 'proof-or-stop-stall-adjudication-integrity-v1';

/** Minimum length (after trim) for a stall-resolution reason. */
export const STALL_RESOLUTION_REASON_MIN = 20;

/**
 * Runtime membership test against the CHK-001 tuple (single source of truth).
 * Referenced lazily inside functions, never at module-init, so the mutual
 * import with review-convergence.ts stays safe.
 */
export function isStallResolutionAction(action: unknown): action is StallResolutionAction {
  return typeof action === 'string' && (STALL_RESOLUTION_ACTIONS as readonly string[]).includes(action);
}

/**
 * Deterministic signature over the resolution's meaningful (signed-domain)
 * fields. `reason` is hashed (bounded) and folded in, so a post-write edit of
 * ANY signed field (action / reason / reviewRound / itemId) diverges from
 * `_hash` and is refused by isValidCurrentRoundStallResolution.
 *
 * Domain: storyId : action : sha256(reason) : reviewRound : itemId : SALT
 * (approvedBy / recordedAt / withdrawalDecisionRef are audit fields, excluded.)
 */
export function signStallAdjudication(
  storyId: string,
  action: string,
  reason: string,
  reviewRound: string,
  itemId?: string,
): string {
  const reasonHash = createHash('sha256').update(reason ?? '').digest('hex');
  return createHash('sha256')
    .update(`${storyId}:${action}:${reasonHash}:${reviewRound}:${itemId ?? ''}:${STALL_ADJUDICATION_SALT}`)
    .digest('hex');
}

/** Recompute the expected `_hash` for a persisted record (single source: signStallAdjudication). */
export function recomputeStallAdjudicationHash(record: StallAdjudicationData): string {
  return signStallAdjudication(record.storyId, record.action, record.reason, record.reviewRound, record.itemId);
}

export interface NormalizedStallResolutionInput {
  action: StallResolutionAction;
  reason: string;
  itemId?: string;
}

/**
 * Runtime validation of the operator-supplied resolution at the HANDLER entry.
 * Mirrors the CLI Zod schema (action enum + reason min length +
 * declare_unreachable ⇒ itemId) so a direct-fn / bypassed-Zod call is rejected
 * identically. Throws with a precise message; returns the normalized (trimmed)
 * input on success.
 */
export function validateStallResolutionInput(input: {
  action?: unknown;
  reason?: unknown;
  itemId?: unknown;
}): NormalizedStallResolutionInput {
  if (!isStallResolutionAction(input.action)) {
    throw new Error(
      `stall_resolution_set: action must be one of ${STALL_RESOLUTION_ACTIONS.join(' | ')} (got ${JSON.stringify(input.action)})`,
    );
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < STALL_RESOLUTION_REASON_MIN) {
    throw new Error(
      `stall_resolution_set: reason must be >= ${STALL_RESOLUTION_REASON_MIN} characters after trim (got ${reason.length}). ` +
      'State why you are consciously clearing the convergence-stall block for this review round.',
    );
  }
  const itemId = typeof input.itemId === 'string' ? input.itemId.trim() : '';
  if (input.action === 'declare_unreachable' && !itemId) {
    throw new Error(
      'stall_resolution_set: action=declare_unreachable requires itemId (the checklist item to withdraw as unreachable via the B-1909 scope-shrinkage disposition).',
    );
  }
  return {
    action: input.action,
    reason,
    ...(itemId ? { itemId } : {}),
  };
}

/**
 * PURE gate predicate (READ side). Returns true ONLY when `record` is a valid,
 * signed resolution BOUND to `currentReviewRound`. Every check the handler makes
 * on write is re-applied here on read (defence in depth):
 *
 *   - record present
 *   - action ∈ STALL_RESOLUTION_ACTIONS
 *   - reason.trim().length >= STALL_RESOLUTION_REASON_MIN (empty/short → refused)
 *   - currentReviewRound non-empty AND record.reviewRound === currentReviewRound
 *     (a previous-round record does NOT clear the current block)
 *   - declare_unreachable carries a non-empty itemId (matches the signed domain)
 *   - _hash present AND === recomputeStallAdjudicationHash(record) (unsigned /
 *     tampered → refused)
 */
export function isValidCurrentRoundStallResolution(
  record: StallAdjudicationData | null | undefined,
  currentReviewRound: string,
): boolean {
  if (!record) return false;
  if (!isStallResolutionAction(record.action)) return false;
  if (typeof record.reason !== 'string' || record.reason.trim().length < STALL_RESOLUTION_REASON_MIN) return false;
  // Current-round binding: a non-empty current round that matches the record.
  if (!currentReviewRound || record.reviewRound !== currentReviewRound) return false;
  // declare_unreachable must carry the withdrawn itemId (part of the signed domain).
  if (record.action === 'declare_unreachable'
    && (typeof record.itemId !== 'string' || record.itemId.trim().length === 0)) {
    return false;
  }
  // Signature: recompute over the persisted signed-domain fields must match _hash.
  if (typeof record._hash !== 'string' || record._hash.length === 0) return false;
  return recomputeStallAdjudicationHash(record) === record._hash;
}
