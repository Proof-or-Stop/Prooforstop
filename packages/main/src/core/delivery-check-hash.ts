/**
 * Delivery Check hash — core signature primitives for delivery-check.json.
 *
 * This module is the single source of truth for the delivery-check.json
 * signature algorithm. It lives in core/ (depends only on StoryStore + crypto)
 * so that core consumers (done-oracle.ts, machine.ts) can verify the hash
 * without an upward core→handlers import. The delivery_check_set handler
 * (handlers/delivery-check.ts) re-uses these same functions.
 *
 * 签名域：storyId + JSON.stringify(docsPromises) + JSON.stringify(realMachineTests)
 *          + JSON.stringify(closingSelfCheck) + reviewRound + salt
 *
 * waiverReason (≥ 30 字符) 入 realMachineTests / docsPromises 的 JSON.stringify，
 * 自动纳入签名。
 */

import { createHash } from 'crypto';
import type { StoryStore } from './store.js';
import type { DocsPromise, RealMachineTest, ClosingSelfCheck } from './types.js';

export const DELIVERY_CHECK_SALT = 'koala-delivery-check-integrity-v1';

/**
 * 签名函数（确定性：同输入同输出）。
 *
 * 签名域：storyId / docsPromises(JSON) / realMachineTests(JSON) / closingSelfCheck(JSON) / reviewRound + salt
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
 * gate 端复用的重算入口：读 delivery-check.json 后取其字段重新签名，
 * 比对 _hash 判断是否被篡改。
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
