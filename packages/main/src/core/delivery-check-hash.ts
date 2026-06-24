/**
 * Delivery Check hash — core signature primitives for delivery-check.json.
 *
 * This module is the single source of truth for the delivery-check.json
 * signature algorithm. It lives in core/ (depends only on StoryStore + crypto)
 * so that core consumers (done-oracle.ts, machine.ts) can verify the hash
 * without an upward core→handlers import. The delivery_check_set handler
 * (handlers/delivery-check.ts) re-uses these same functions.
 *
 * Signature domain for new writes: storyId + JSON.stringify(docsPromises)
 *          + JSON.stringify(realMachineTests) + JSON.stringify(closingSelfCheck)
 *          + reviewRound + materialHash + salt
 *
 * waiverReason (≥ 30 characters) is included in JSON.stringify of realMachineTests / docsPromises,
 * automatically incorporated into the signature.
 */

import { createHash } from 'crypto';
import type { StoryStore } from './store.js';
import type { DocsPromise, RealMachineTest, ClosingSelfCheck } from './types.js';
import { currentMaterialHash } from './evidence-freshness.js';

export const DELIVERY_CHECK_SALT = 'lattice-delivery-check-integrity-v1';

/**
 * Signing function (deterministic: same input yields same output).
 *
 * Signature domain: storyId / docsPromises(JSON) / realMachineTests(JSON) /
 * closingSelfCheck(JSON) / reviewRound / materialHash + salt.
 *
 * materialHash is optional only so legacy delivery-check fixtures can still be
 * recognized as untampered; DONE freshness gates reject missing materialHash.
 */
export function signDeliveryCheck(
  storyId: string,
  docsPromises: DocsPromise[],
  realMachineTests: RealMachineTest[],
  closingSelfCheck: ClosingSelfCheck,
  reviewRound: string,
  materialHash?: string,
): string {
  const payload = [
    storyId,
    JSON.stringify(docsPromises),
    JSON.stringify(realMachineTests),
    JSON.stringify(closingSelfCheck),
    reviewRound,
    ...(materialHash ? [materialHash] : []),
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
  );
}

export type DeliveryCheckFreshnessCode =
  | 'delivery_check_passed'
  | 'missing_delivery_check'
  | 'delivery_check_tampered'
  | 'stale_delivery_check';

export interface DeliveryCheckFreshnessResult {
  ok: boolean;
  code: DeliveryCheckFreshnessCode;
  reason: string;
  deliveryCheck: ReturnType<StoryStore['readDeliveryCheck']>;
  expectedHash: string | null;
  currentMaterialHash?: string;
}

export function evaluateDeliveryCheckFreshness(
  storyId: string,
  store: StoryStore,
  gitCwd: string,
  metadataRoot: string = gitCwd,
): DeliveryCheckFreshnessResult {
  const deliveryCheck = store.readDeliveryCheck(storyId);
  if (!deliveryCheck) {
    return {
      ok: false,
      code: 'missing_delivery_check',
      reason: 'Missing delivery-check.json (requires lattice-review-delivery reviewer signature)',
      deliveryCheck,
      expectedHash: null,
    };
  }

  const expectedHash = recomputeDeliveryCheckHash(storyId, store);
  if (expectedHash === null || deliveryCheck._hash !== expectedHash) {
    return {
      ok: false,
      code: 'delivery_check_tampered',
      reason: 'delivery-check.json _hash mismatch',
      deliveryCheck,
      expectedHash,
    };
  }

  if (!deliveryCheck.materialHash) {
    return {
      ok: false,
      code: 'stale_delivery_check',
      reason: 'stale delivery-check: delivery-check.json is missing materialHash binding',
      deliveryCheck,
      expectedHash,
    };
  }

  const materialHash = currentMaterialHash(gitCwd, 'HEAD', metadataRoot);
  if (!materialHash) {
    return {
      ok: false,
      code: 'stale_delivery_check',
      reason: 'stale delivery-check: current materialHash could not be computed',
      deliveryCheck,
      expectedHash,
    };
  }

  if (materialHash !== deliveryCheck.materialHash) {
    return {
      ok: false,
      code: 'stale_delivery_check',
      reason: `stale delivery-check: materialHash mismatch (recorded ${deliveryCheck.materialHash.slice(0, 12)}, current ${materialHash.slice(0, 12)})`,
      deliveryCheck,
      expectedHash,
      currentMaterialHash: materialHash,
    };
  }

  return {
    ok: true,
    code: 'delivery_check_passed',
    reason: 'delivery-check materialHash matches current material',
    deliveryCheck,
    expectedHash,
    currentMaterialHash: materialHash,
  };
}
