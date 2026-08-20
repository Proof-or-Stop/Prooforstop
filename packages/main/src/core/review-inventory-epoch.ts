import { createHash } from 'node:crypto';
import { withMkdirLock } from './mkdir-lock.js';

export const REVIEW_INVENTORY_EPOCHS_FILE = 'review-inventory-epochs.json';
export const REVIEW_INVENTORY_EPOCHS_SCHEMA = 'proofbound.review_inventory_epochs.v1';
export const REVIEW_INVENTORY_EPOCH_SCHEMA = 'proofbound.review_inventory_epoch.v1';
export const REVIEW_INVENTORY_RECEIPT_SCHEMA = 'proofbound.review_inventory_receipt.v1';
export const INVENTORY_COMPLETENESS_AUTHORITY = 'inventory-completeness-only' as const;

const EPOCH_DOMAIN = 'proofbound.review-inventory-epoch.v1';
const RECEIPT_DOMAIN = 'proofbound.review-inventory-receipt.v1';

export interface ReviewInventoryCutoff {
  headHash: string;
  materialHash: string;
  storyFilesHash?: string;
}

export interface ReviewInventoryEpoch {
  schemaVersion: typeof REVIEW_INVENTORY_EPOCH_SCHEMA;
  epochId: string;
  storyId: string;
  reviewRound: string;
  state: 'FINALIZED';
  begunAt: string;
  updatedAt: string;
  cutoff: ReviewInventoryCutoff;
  receiptId: string;
  consumedAt?: string;
  consumedByReviewRound?: string;
  _hash: string;
}

export interface ReviewInventoryReceipt {
  schemaVersion: typeof REVIEW_INVENTORY_RECEIPT_SCHEMA;
  receiptId: string;
  epochId: string;
  storyId: string;
  reviewRound: string;
  cutoff: ReviewInventoryCutoff;
  authority: typeof INVENTORY_COMPLETENESS_AUTHORITY;
  authorizesTest: false;
  saturationResult: 'ZERO_NEW_VERIFIED_FINDINGS';
  issuedAt: string;
  consumedAt?: string;
  invalidatedAt?: string;
  _hash: string;
}

/** Persistence document for review-inventory-epochs.json. */
export interface ReviewInventoryEpochData {
  schemaVersion: typeof REVIEW_INVENTORY_EPOCHS_SCHEMA;
  epochs: ReviewInventoryEpoch[];
  receipts: ReviewInventoryReceipt[];
  criticReceipts: unknown[];
}

export interface ReviewInventoryStorePort {
  readReviewInventoryEpochs(storyId: string): ReviewInventoryEpochData;
  writeReviewInventoryEpochs(storyId: string, data: ReviewInventoryEpochData): void;
  runtimeLockDirPath(storyId: string, category: string, name: string): string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

export function reviewInventoryDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function emptyReviewInventoryEpochData(): ReviewInventoryEpochData {
  return { schemaVersion: REVIEW_INVENTORY_EPOCHS_SCHEMA, epochs: [], receipts: [], criticReceipts: [] };
}

export function withReviewInventoryMutationLock<T>(
  store: ReviewInventoryStorePort,
  storyId: string,
  fn: () => T,
): T {
  return withMkdirLock(store.runtimeLockDirPath(storyId, 'review-inventory', 'epochs'), fn, {
    label: `review inventory ${storyId}`,
  });
}

export function signReviewInventoryEpoch(epoch: Omit<ReviewInventoryEpoch, '_hash'>): string {
  return reviewInventoryDigest({ domain: EPOCH_DOMAIN, ...epoch });
}

export function verifyReviewInventoryEpoch(epoch: ReviewInventoryEpoch): boolean {
  if (!epoch?._hash || epoch.schemaVersion !== REVIEW_INVENTORY_EPOCH_SCHEMA) return false;
  if (epoch.state !== 'FINALIZED') return false;
  const { _hash, ...unsigned } = epoch;
  return _hash === signReviewInventoryEpoch(unsigned);
}

export function signReviewInventoryReceipt(receipt: Omit<ReviewInventoryReceipt, '_hash'>): string {
  return reviewInventoryDigest({ domain: RECEIPT_DOMAIN, ...receipt });
}

export function verifyReviewInventoryReceipt(receipt: ReviewInventoryReceipt): boolean {
  if (!receipt?._hash || receipt.schemaVersion !== REVIEW_INVENTORY_RECEIPT_SCHEMA) return false;
  if (receipt.authority !== INVENTORY_COMPLETENESS_AUTHORITY) return false;
  if (receipt.authorizesTest !== false) return false;
  const { _hash, ...unsigned } = receipt;
  return _hash === signReviewInventoryReceipt(unsigned);
}

function withSignedEpoch(
  epoch: Omit<ReviewInventoryEpoch, '_hash'> | ReviewInventoryEpoch,
): ReviewInventoryEpoch {
  const { _hash: _ignored, ...unsigned } = epoch as ReviewInventoryEpoch;
  return { ...unsigned, _hash: signReviewInventoryEpoch(unsigned) };
}

function withSignedReceipt(
  receipt: Omit<ReviewInventoryReceipt, '_hash'> | ReviewInventoryReceipt,
): ReviewInventoryReceipt {
  const { _hash: _ignored, ...unsigned } = receipt as ReviewInventoryReceipt;
  return { ...unsigned, _hash: signReviewInventoryReceipt(unsigned) };
}

function sameCutoff(left: ReviewInventoryCutoff, right: ReviewInventoryCutoff): boolean {
  return left.headHash === right.headHash
    && left.materialHash === right.materialHash
    && (left.storyFilesHash ?? '') === (right.storyFilesHash ?? '');
}

export function finalizedUnconsumedReviewInventory(
  store: ReviewInventoryStorePort,
  storyId: string,
): { epoch: ReviewInventoryEpoch; receipt: ReviewInventoryReceipt } | null {
  const data = store.readReviewInventoryEpochs(storyId);
  const epoch = data.epochs.at(-1);
  if (epoch?.state !== 'FINALIZED' || epoch.consumedAt) return null;
  if (!epoch || !verifyReviewInventoryEpoch(epoch) || !epoch.receiptId) return null;
  const receipt = data.receipts.find(row => row.receiptId === epoch.receiptId);
  if (!receipt || !verifyReviewInventoryReceipt(receipt) || receipt.consumedAt || receipt.invalidatedAt) return null;
  if (receipt.epochId !== epoch.epochId || receipt.storyId !== storyId || receipt.reviewRound !== epoch.reviewRound) {
    return null;
  }
  return { epoch, receipt };
}

export function consumeReviewInventoryReceipt(
  store: ReviewInventoryStorePort,
  storyId: string,
  reviewRound: string,
  currentCutoff: { materialHash: string; storyFilesHash?: string },
  validateInventoryContext?: () => void,
): string | null {
  return withReviewInventoryMutationLock(store, storyId, () => {
    validateInventoryContext?.();
    const pair = finalizedUnconsumedReviewInventory(store, storyId);
    if (!pair) {
      throw new Error('REVIEW_INVENTORY_REMEDIATION_BLOCKED: missing valid unconsumed FINALIZED review inventory receipt');
    }
    if (reviewRound && pair.epoch.reviewRound !== reviewRound && pair.receipt.reviewRound !== reviewRound) {
      throw new Error(
        `REVIEW_INVENTORY_REMEDIATION_BLOCKED: receipt reviewRound ${pair.epoch.reviewRound} != current ${reviewRound}`,
      );
    }
    if (
      pair.receipt.cutoff.materialHash !== currentCutoff.materialHash
      || (pair.receipt.cutoff.storyFilesHash ?? '') !== (currentCutoff.storyFilesHash ?? '')
    ) {
      throw new Error('REVIEW_INVENTORY_REMEDIATION_BLOCKED: current material/storyFiles no longer match the finalized cutoff');
    }
    const now = new Date().toISOString();
    const data = store.readReviewInventoryEpochs(storyId);
    data.epochs = data.epochs.map(row => {
      if (row.epochId !== pair.epoch.epochId) return row;
      return withSignedEpoch({ ...row, consumedAt: now, consumedByReviewRound: reviewRound, updatedAt: now });
    });
    data.receipts = data.receipts.map(row => {
      if (row.receiptId !== pair.receipt.receiptId) return row;
      return withSignedReceipt({ ...row, consumedAt: now });
    });
    store.writeReviewInventoryEpochs(storyId, data);
    return pair.receipt.receiptId;
  });
}

export function persistFinalizedReviewInventory(args: {
  store: ReviewInventoryStorePort;
  storyId: string;
  reviewRound: string;
  cutoff: ReviewInventoryCutoff;
}): { epoch: ReviewInventoryEpoch; receipt: ReviewInventoryReceipt; reused: boolean } {
  return withReviewInventoryMutationLock(args.store, args.storyId, () => {
    const data = args.store.readReviewInventoryEpochs(args.storyId);
    const latest = data.epochs.at(-1);
    if (latest && latest.state === 'FINALIZED' && !latest.consumedAt && latest.receiptId) {
      const existing = data.receipts.find(row => row.receiptId === latest.receiptId);
      if (
        existing
        && verifyReviewInventoryEpoch(latest)
        && verifyReviewInventoryReceipt(existing)
        && !existing.consumedAt
        && !existing.invalidatedAt
        && sameCutoff(latest.cutoff, args.cutoff)
        && sameCutoff(existing.cutoff, args.cutoff)
        && latest.storyId === args.storyId
        && existing.storyId === args.storyId
      ) {
        return { epoch: latest, receipt: existing, reused: true };
      }
    }
    const now = new Date().toISOString();
    const seq = String(data.epochs.length + 1).padStart(3, '0');
    const epochId = `${args.storyId}:RIE-${seq}`;
    const receiptId = `${epochId}:RCP-001`;
    const epoch = withSignedEpoch({
      schemaVersion: REVIEW_INVENTORY_EPOCH_SCHEMA,
      epochId,
      storyId: args.storyId,
      reviewRound: args.reviewRound,
      state: 'FINALIZED',
      begunAt: now,
      updatedAt: now,
      cutoff: args.cutoff,
      receiptId,
    });
    const receipt = withSignedReceipt({
      schemaVersion: REVIEW_INVENTORY_RECEIPT_SCHEMA,
      receiptId,
      epochId,
      storyId: args.storyId,
      reviewRound: args.reviewRound,
      cutoff: args.cutoff,
      authority: INVENTORY_COMPLETENESS_AUTHORITY,
      authorizesTest: false,
      saturationResult: 'ZERO_NEW_VERIFIED_FINDINGS',
      issuedAt: now,
    });
    data.epochs.push(epoch);
    data.receipts.push(receipt);
    args.store.writeReviewInventoryEpochs(args.storyId, data);
    return { epoch, receipt, reused: false };
  });
}

export function renderFinalizedReviewInventory(epoch: ReviewInventoryEpoch, receipt: ReviewInventoryReceipt): string {
  return [
    `State: ${epoch.state}`,
    `Epoch: ${epoch.epochId}`,
    `Receipt: ${receipt.receiptId}`,
    `headHash: ${epoch.cutoff.headHash}`,
    `materialHash: ${epoch.cutoff.materialHash}`,
    `storyFilesHash: ${epoch.cutoff.storyFilesHash ?? ''}`,
    `Authority: ${receipt.authority}`,
    `authorizesTest: ${receipt.authorizesTest}`,
  ].join('\n');
}
