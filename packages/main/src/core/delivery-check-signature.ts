/**
 * Delivery Check signature primitives for delivery-check.json: the salt, the
 * deterministic signer and the gate-side recompute. A leaf (crypto + types
 * only): managed-host-run re-signs through it without importing
 * delivery-check-hash, which imports managed-host-run for dispatch receipts
 * (that direct pair was part of the 55-module core import cycle).
 * delivery-check-hash re-exports every name here and stays the documented entry.
 */
import { createHash } from 'crypto';
import type { StoryStore } from './store.js';
import type { DocsPromise, RealMachineTest, ClosingSelfCheck, NativeReviewEvidenceBinding } from './types.js';

export const DELIVERY_CHECK_SALT = 'proof-or-stop-delivery-check-integrity-v1';

/**
 * Signing function (deterministic: same input yields same output).
 *
 * Signature domain: storyId / docsPromises(JSON) / realMachineTests(JSON) /
 * closingSelfCheck(JSON) / reviewRound / materialHash / storyFilesHash + salt.
 *
 * materialHash and storyFilesHash are optional and appended only when present,
 * so legacy delivery-check fixtures (without either) recompute byte-identically
 * and stay recognizable as untampered; DONE freshness gates reject a missing
 * materialHash as stale. storyFilesHash is signed so the drift-advisory
 * downgrade keyed on it is non-forgeable.
 */
export function signDeliveryCheck(
  storyId: string,
  docsPromises: DocsPromise[],
  realMachineTests: RealMachineTest[],
  closingSelfCheck: ClosingSelfCheck,
  reviewRound: string,
  materialHash?: string,
  storyFilesHash?: string,
  nativeEvidenceBinding?: NativeReviewEvidenceBinding,
  managedDeliveryRunId?: string,
): string {
  const payload = [
    storyId,
    JSON.stringify(docsPromises),
    JSON.stringify(realMachineTests),
    JSON.stringify(closingSelfCheck),
    reviewRound,
    ...(materialHash ? [materialHash] : []),
    ...(storyFilesHash ? [storyFilesHash] : []),
    ...(nativeEvidenceBinding ? [JSON.stringify(nativeEvidenceBinding)] : []),
    ...(managedDeliveryRunId ? [JSON.stringify({ managedDeliveryRunId })] : []),
    DELIVERY_CHECK_SALT,
  ].join(':');
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Recompute entry reused on the gate side: read delivery-check.json, take its fields and re-sign,
 * compare _hash to determine whether it has been tampered with.
 */
export function recomputeDeliveryCheckHash(storyId: string, store: StoryStore): string | null {
  const data = store.readDeliveryCheck(storyId);
  if (!data) return null;
  return signDeliveryCheck(
    data.storyId,
    data.docsPromises,
    data.realMachineTests,
    data.closingSelfCheck,
    data.reviewRound,
    data.materialHash,
    data.storyFilesHash,
    data.nativeEvidenceBinding,
    data.managedDeliveryRunId,
  );
}
