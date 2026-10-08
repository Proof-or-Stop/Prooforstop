/**
 * Review inventory epoch cancellation for the REVIEW→DEV material reopen
 * (old-PoS run 25 F2, core/review-material-reopen.ts). Same record shape as
 * `review_inventory_cancel` (handlers/review-inventory.ts) writes. Kept out of
 * core/review-inventory-epoch.ts, whose emitted bytes are an active identity
 * boundary, and not imported by that handler, which sits in the review import
 * cycle (import-cycles-smoke).
 */
import type { StoryStore } from './store.js';
import type { ReviewInventoryEpoch, ReviewInventoryEpochData, ReviewInventoryReceipt } from './types.js';
import {
  finalizedUnconsumedReviewInventory,
  maxReviewRunSequence,
  signReviewInventoryEpoch,
  signReviewInventoryReceipt,
  verifyReviewInventoryEpoch,
  verifyReviewInventoryReceipt,
  withReviewInventoryMutationLock,
} from './review-inventory-epoch.js';

/**
 * Cancel `epoch` (OPEN, or FINALIZED with a valid unconsumed receipt) in
 * `data`: the epoch becomes CANCELLED with its reason and terminal run
 * boundary, and a FINALIZED epoch's receipt is invalidated. Pure; the caller
 * validates the epoch state, holds the inventory lock and writes the result.
 */
export function cancelReviewInventoryEpochData(
  data: ReviewInventoryEpochData,
  epoch: ReviewInventoryEpoch,
  reason: string,
  now: string,
  terminalRunSequenceBoundary: number,
): { data: ReviewInventoryEpochData; cancelled: ReviewInventoryEpoch } {
  const { _hash: _epochHash, ...unsignedEpoch } = epoch;
  const cancelledUnsigned: Omit<ReviewInventoryEpoch, '_hash'> = {
    ...unsignedEpoch,
    state: 'CANCELLED',
    updatedAt: now,
    cancelledAt: now,
    cancelReason: reason,
    terminalRunSequenceBoundary,
  };
  const cancelled: ReviewInventoryEpoch = { ...cancelledUnsigned, _hash: signReviewInventoryEpoch(cancelledUnsigned) };
  const receipts = epoch.state === 'FINALIZED' && epoch.receiptId
    ? data.receipts.map(row => {
      if (row.receiptId !== epoch.receiptId) return row;
      if (!verifyReviewInventoryReceipt(row) || row.consumedAt || row.invalidatedAt) {
        throw new Error(`review reopen: receipt ${row.receiptId} is invalid or already consumed`);
      }
      const { _hash, ...unsigned } = row;
      const invalidated: Omit<ReviewInventoryReceipt, '_hash'> = { ...unsigned, invalidatedAt: now, invalidationReason: reason };
      return { ...invalidated, _hash: signReviewInventoryReceipt(invalidated) };
    })
    : data.receipts;
  return {
    data: { ...data, epochs: data.epochs.map(row => row.epochId === epoch.epochId ? cancelled : row), receipts },
    cancelled,
  };
}

/**
 * Old-PoS run 25 F2 (core/review-material-reopen.ts): the REVIEW→DEV material
 * reopen retires the abandoned round's inventory epoch when it is still OPEN
 * or FINALIZED with an unconsumed receipt, so the next round begins cleanly.
 * A consumed, cancelled or other-round epoch is left as it is. Returns the
 * cancelled epoch id, or null.
 */
export function cancelReviewInventoryForReopen(store: StoryStore, storyId: string, reviewRound: string, reason: string): string | null {
  return withReviewInventoryMutationLock(store, storyId, () => {
    const data = store.readReviewInventoryEpochs(storyId);
    const epoch = data.epochs.at(-1);
    if (!epoch || epoch.reviewRound !== reviewRound || !verifyReviewInventoryEpoch(epoch)) return null;
    const pair = epoch.state === 'FINALIZED' ? finalizedUnconsumedReviewInventory(store, storyId) : null;
    if (epoch.state !== 'OPEN' && pair?.epoch.epochId !== epoch.epochId) return null;
    const next = cancelReviewInventoryEpochData(data, epoch, reason, new Date().toISOString(),
      maxReviewRunSequence(store.readReviewRuns(storyId).runs));
    store.writeReviewInventoryEpochs(storyId, next.data);
    return epoch.epochId;
  });
}
