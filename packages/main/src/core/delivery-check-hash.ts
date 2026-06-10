/**
 * Delivery Check hash — core signature primitives for delivery-check.json.
 *
 * This module is the single source of truth for the delivery-check.json
 * signature algorithm. It lives in core/ (depends only on StoryStore + crypto)
 * so that core consumers (done-oracle.ts, machine.ts) can verify the hash
 * without an upward core→handlers import. The delivery_check_set handler
 * (handlers/delivery-check.ts) re-uses these same functions.
 *
 * Signature domain: storyId + JSON.stringify(docsPromises) + JSON.stringify(realMachineTests)
 *          + JSON.stringify(closingSelfCheck) + reviewRound + salt
 *
 * waiverReason (≥ 30 characters) is included in JSON.stringify of realMachineTests / docsPromises,
 * automatically incorporated into the signature.
 */

import { createHash } from 'crypto';
import type { StoryStore } from './store.js';
import type { DocsPromise, RealMachineTest, ClosingSelfCheck } from './types.js';

export const DELIVERY_CHECK_SALT = 'koala-delivery-check-integrity-v1';

/**
 * Signing function (deterministic: same input yields same output).
 *
 * Signature domain: storyId / docsPromises(JSON) / realMachineTests(JSON) / closingSelfCheck(JSON) / reviewRound + salt
 */
export function signDeliveryCheck(
  storyId: string,
  docsPromises: DocsPromise[],
  realMachineTests: RealMachineTest[],
  closingSelfCheck: ClosingSelfCheck,
  reviewRound: string,
): string {
  const payload = [
    storyId,
    JSON.stringify(docsPromises),
    JSON.stringify(realMachineTests),
    JSON.stringify(closingSelfCheck),
    reviewRound,
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
  );
}
