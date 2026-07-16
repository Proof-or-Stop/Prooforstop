import type { DocsPromise } from './types.js';

export const DELIVERY_PROMISE_OUTCOME_CONTRADICTION = 'delivery_promise_outcome_contradiction' as const;

export type DeliveryPromiseOutcome = 'verified' | 'waived' | 'unresolved';

export type DeliveryPromiseOutcomeResult =
  | {
      ok: true;
      outcome: DeliveryPromiseOutcome;
      normalized: DocsPromise;
      legacy: boolean;
    }
  | {
      ok: false;
      code: typeof DELIVERY_PROMISE_OUTCOME_CONTRADICTION;
      reason: string;
    };

function optionalString(value: unknown, field: string): { ok: true; value?: string } | { ok: false; reason: string } {
  if (value === undefined || value === null || value === '') return { ok: true };
  if (typeof value !== 'string') return { ok: false, reason: `${field} must be a string when provided` };
  const trimmed = value.trim();
  return trimmed ? { ok: true, value: trimmed } : { ok: true };
}

/**
 * Total, phase-agnostic classification of a signed delivery promise.
 *
 * Empty optional strings are absent. Explicit status always wins over legacy
 * inference: in particular, `unverified` can never be upgraded by verifiedBy.
 */
export function normalizeDeliveryPromiseOutcome(input: DocsPromise | Record<string, unknown>): DeliveryPromiseOutcomeResult {
  const statusValue = (input as Record<string, unknown>).status;
  const status = optionalString(statusValue, 'status');
  if (!status.ok) return { ok: false, code: DELIVERY_PROMISE_OUTCOME_CONTRADICTION, reason: status.reason };
  if (status.value && !['met', 'verified', 'waived', 'unverified'].includes(status.value)) {
    return {
      ok: false,
      code: DELIVERY_PROMISE_OUTCOME_CONTRADICTION,
      reason: `unknown status=${status.value}`,
    };
  }

  const verifiedBy = optionalString((input as Record<string, unknown>).verifiedBy, 'verifiedBy');
  if (!verifiedBy.ok) return { ok: false, code: DELIVERY_PROMISE_OUTCOME_CONTRADICTION, reason: verifiedBy.reason };
  const evidence = optionalString((input as Record<string, unknown>).evidence, 'evidence');
  if (!evidence.ok) return { ok: false, code: DELIVERY_PROMISE_OUTCOME_CONTRADICTION, reason: evidence.reason };
  const waiverReason = optionalString((input as Record<string, unknown>).waiverReason, 'waiverReason');
  if (!waiverReason.ok) return { ok: false, code: DELIVERY_PROMISE_OUTCOME_CONTRADICTION, reason: waiverReason.reason };

  const normalized: DocsPromise = {
    docPath: String(input.docPath ?? ''),
    promise: String(input.promise ?? ''),
    ...(status.value ? { status: status.value as DocsPromise['status'] } : {}),
    ...(verifiedBy.value ? { verifiedBy: verifiedBy.value } : {}),
    ...(evidence.value ? { evidence: evidence.value } : {}),
    ...(waiverReason.value ? { waiverReason: waiverReason.value } : {}),
  };

  if (status.value === 'met' || status.value === 'verified') {
    if (waiverReason.value) {
      return {
        ok: false,
        code: DELIVERY_PROMISE_OUTCOME_CONTRADICTION,
        reason: `status=${status.value} cannot include waiverReason`,
      };
    }
    normalized.verifiedBy = verifiedBy.value ?? `status:${status.value}`;
    return { ok: true, outcome: 'verified', normalized, legacy: false };
  }

  if (status.value === 'waived') {
    if (verifiedBy.value) {
      return {
        ok: false,
        code: DELIVERY_PROMISE_OUTCOME_CONTRADICTION,
        reason: 'status=waived cannot include verifiedBy',
      };
    }
    if (!waiverReason.value || waiverReason.value.length < 30) {
      return {
        ok: false,
        code: DELIVERY_PROMISE_OUTCOME_CONTRADICTION,
        reason: 'status=waived requires waiverReason of at least 30 characters',
      };
    }
    return { ok: true, outcome: 'waived', normalized, legacy: false };
  }

  if (status.value === 'unverified') {
    if (verifiedBy.value) {
      return {
        ok: false,
        code: DELIVERY_PROMISE_OUTCOME_CONTRADICTION,
        reason: 'status=unverified cannot include verifiedBy',
      };
    }
    if (waiverReason.value) {
      return {
        ok: false,
        code: DELIVERY_PROMISE_OUTCOME_CONTRADICTION,
        reason: 'status=unverified cannot include waiverReason',
      };
    }
    return { ok: true, outcome: 'unresolved', normalized, legacy: false };
  }

  // Missing status is the only compatibility branch.
  if (verifiedBy.value && waiverReason.value) {
    return {
      ok: false,
      code: DELIVERY_PROMISE_OUTCOME_CONTRADICTION,
      reason: 'legacy promise cannot include both verifiedBy and waiverReason',
    };
  }
  if (waiverReason.value) {
    if (waiverReason.value.length < 30) {
      return {
        ok: false,
        code: DELIVERY_PROMISE_OUTCOME_CONTRADICTION,
        reason: 'legacy waiverReason must be at least 30 characters',
      };
    }
    return { ok: true, outcome: 'waived', normalized, legacy: true };
  }
  if (verifiedBy.value) return { ok: true, outcome: 'verified', normalized, legacy: true };
  return { ok: true, outcome: 'unresolved', normalized, legacy: true };
}

export function deliveryPromiseBlocksDone(input: DocsPromise | Record<string, unknown>): boolean {
  const result = normalizeDeliveryPromiseOutcome(input);
  return !result.ok || result.outcome === 'unresolved';
}
