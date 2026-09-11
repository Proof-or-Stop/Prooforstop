/** Story 3A/CHK-003: public, schema-neutral Finding ledger transaction helpers. */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  canonicalHash, canonicalJson, planAppend, readLedger,
  validateEnvelope,
  FINDING_LEDGER_SCHEMA_EPOCH, FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY,
  FINDING_LEDGER_LOCAL_FS_CAPABILITY, FINDING_LEDGER_KEY_FRESHNESS_POLICY_DIGEST,
  currentFindingLedgerSignerFromWorkspace, currentFindingLedgerTrustFromWorkspace,
  findingLedgerSignerFromWorkspace, findingLedgerTrustFromWorkspace,
  signFindingLedgerReceipt, verifyFindingLedgerReceipt,
  type AppendLedgerOptions, type AppendPlan, type AppendRequest,
  type FindingLedgerReceiptTrust, type FindingLedgerSigner,
  type JsonValue, type LedgerCommitReceipt, type LedgerEnvelope, type LedgerFence,
  type LedgerRecord,
} from '../core/finding-ledger.js';
import {
  canonicalDigest,
  exportPublicKeyRaw,
  importPrivateKeyRaw,
  signCanonical,
  verifyCanonical,
} from '../core/authority-signing.js';
import type { StoryStore } from '../core/store.js';
import { FINDING_RUNTIME_EVIDENCE_ADAPTER_CONTRACT } from '../core/finding-runtime-evidence.js';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { withFindingRuntimeSource } from './finding-runtime-source.js';
import { currentGitHead, currentMaterialHash, readMaterialDirtyFiles } from '../core/evidence-freshness.js';
import { getSessionIdentity } from '../core/owner-session.js';
import { readOwnerLease } from '../core/story-owner-lease.js';
import { captureMkdirLockFence, withMkdirLock } from '../core/mkdir-lock.js';
import { mainWriteLockPath, withReentrantMainWriteLock } from '../core/main-write-lock.js';
import { resolveMainRepoRoot } from '../core/partial-done-recovery.js';
import {
  RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY,
  createRuntimeEvidenceBlobStore,
} from '../core/evidence/artifact-store.js';
import {
  RuntimeEvidenceRefusal,
  executeRuntimeEvidence,
  redactEnvironment,
  verifyRuntimeEvidenceCurrent,
  verifyRuntimeEvidenceReceiptSignature,
  type RuntimeEvidenceReceipt,
  type RuntimeReceiptSigner,
  type RuntimeReceiptTrust,
} from '../core/runtime-evidence-receipt.js';
import type {
  Finding,
  FindingData,
  FindingLedgerCasBinding,
  FindingLedgerOperation,
  FindingLedgerReceipt,
} from '../core/types.js';

export type { FindingLedgerCasBinding, FindingLedgerOperation, FindingLedgerReceipt } from '../core/types.js';
export {
  FINDING_LEDGER_KEY_FRESHNESS_POLICY_DIGEST,
  findingLedgerSignerFromWorkspace,
  findingLedgerTrustFromWorkspace,
  signFindingLedgerReceipt,
  verifyFindingLedgerReceipt,
} from '../core/finding-ledger.js';

export type LedgerSigner = FindingLedgerSigner;
export type LedgerReceiptTrust = FindingLedgerReceiptTrust;

const require = createRequire(import.meta.url);
const properLockfile = require('proper-lockfile') as {
  checkSync(file: string, options: { stale: number; update: number }): boolean;
};

function gitCommonDir(workspaceRoot: string): string {
  const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return isAbsolute(raw) ? raw : resolve(workspaceRoot, raw);
}
export interface LedgerExactCasSnapshot<T extends JsonValue = JsonValue> {
  ledger: LedgerEnvelope<T>;
  referencedRecords: Array<{ record: LedgerRecord<T>; canonicalBytes: string }>;
  currentChainHeadId: string;
  currentChainHeadHash: string;
}
export interface LedgerPredicateResult { accepted: boolean; predicateDigest: string; }
export type FindingLedgerWriteStore = Pick<StoryStore, 'readFindingLedger' | 'transactFindingLedger'>;
export interface LedgerAppendOptions<T extends JsonValue = JsonValue> {
  storyId: string; store: FindingLedgerWriteStore; operation: FindingLedgerOperation; idempotencyKey: string;
  records: Array<{ recordType: string; payload: T; uniqueBindingKey?: string }>;
  writerSessionId: string; writerLeaseId: string; writerFenceToken: string; fence: LedgerFence;
  signer: LedgerSigner; casBindings?: FindingLedgerCasBinding[]; expectedPriorLedgerDigest?: string;
  verifyPredicate?: (snapshot: LedgerExactCasSnapshot<T>) => LedgerPredicateResult;
  commitOptions?: AppendLedgerOptions;
}

/**
 * Prepare a sequence of existing signed/CAS appends against private snapshots,
 * then publish their envelope once under the original fence. Each receipt keeps
 * its own exact prefix, record IDs and predicate; no batch receipt substitutes
 * for an individual lifecycle transition's authority.
 */
export function withAtomicFindingLedgerWrites<R>(args: {
  store: FindingLedgerWriteStore;
  storyId: string;
  fence: LedgerFence;
  commitOptions?: AppendLedgerOptions;
}, prepare: (store: FindingLedgerWriteStore) => R): R {
  return args.store.transactFindingLedger<JsonValue, R>(args.storyId, args.fence, current => {
    let staged = structuredClone(current);
    let lastReceipt: LedgerCommitReceipt | undefined;
    let hasAppend = false;
    let open = true;
    const assertSubject = (storyId: string) => {
      if (!open) throw new Error('finding ledger batch is closed');
      if (storyId !== args.storyId) throw new Error('finding ledger batch cannot change Story subject');
      args.fence.assertCurrent();
    };
    const stagedStore: FindingLedgerWriteStore = {
      readFindingLedger<T = unknown>(storyId: string): LedgerEnvelope<T> {
        assertSubject(storyId);
        return structuredClone(staged) as unknown as LedgerEnvelope<T>;
      },
      transactFindingLedger<T = unknown, Result = unknown>(storyId: string, fence: LedgerFence,
        stage: (ledger: LedgerEnvelope<T>) => { plan: AppendPlan<T>; result: Result },
        options: AppendLedgerOptions = {}): Result {
        assertSubject(storyId);
        fence.assertCurrent();
        if (fence.writerFenceToken !== args.fence.writerFenceToken) throw new Error('STALE_FENCE: batch fence mismatch');
        if (Object.keys(options).length > 0) throw new Error('finding ledger batch accepts commit options only on the outer publication');
        const prepared = stage(structuredClone(staged) as unknown as LedgerEnvelope<T>);
        validateEnvelope(prepared.plan.envelope);
        if (prepared.plan.action === 'append') {
          staged = structuredClone(prepared.plan.envelope) as unknown as LedgerEnvelope<JsonValue>;
          hasAppend = true;
        }
        lastReceipt = structuredClone(prepared.plan.receipt);
        return prepared.result;
      },
    };
    try {
      const result = prepare(stagedStore);
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new Error('finding ledger batch preparation must be synchronous');
      }
      if (!lastReceipt) throw new Error('finding ledger batch must prepare at least one append or exact replay');
      const plan: AppendPlan<JsonValue> = {
        action: hasAppend ? 'append' : 'replay',
        records: staged.records.slice(current.records.length),
        receipt: lastReceipt,
        envelope: staged,
      };
      return { plan, result };
    } finally { open = false; }
  }, args.commitOptions);
}

export interface AuthoritativeFindingMutationResult<T> {
  result: T;
  changedFindingIds?: readonly string[];
}

export type AuthoritativeFindingMutation = <T>(
  storyId: string,
  mutationId: string,
  mutate: (data: FindingData) => AuthoritativeFindingMutationResult<T>,
) => T;

function assertText(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
}

function exactKeys(value: object, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonEmptyTextArray(value: unknown): value is string[] {
  return denseArrayOf(value, nonEmptyText) && value.length > 0;
}

/** Array.every skips holes, which JSON persistence would turn into signed nulls. */
function denseArrayOf(value: unknown, elementValid: (element: unknown) => boolean): value is unknown[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) return false;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index) || !elementValid(value[index])) return false;
  }
  return true;
}

type PersistedCommitReceipt = LedgerCommitReceipt & {
  exactRequestDigest?: string;
  findingLedgerReceipt?: FindingLedgerReceipt;
};

interface LegacyReceiptBindingEntry {
  receiptId: string;
  legacyReceiptDigest: string;
  recordIds: string[];
  priorLedgerDigest: string;
  committedLedgerDigest: string;
}
interface LegacyReceiptBindingSet {
  schemaVersion: 1;
  bindingType: 'legacy-unsigned-receipt-set';
  observedLedgerDigest: string;
  bindings: LegacyReceiptBindingEntry[];
}

interface LegacyLifecycleReceiptBindingEntry {
  receiptId: string;
  legacyReceiptDigest: string;
  transitionRecordId: string;
  transitionRecordHash: string;
  findingId: string;
  findingRecordId: string;
  findingRecordHash: string;
  outerExactRequestDigest: string;
  priorLedgerDigest: string;
  committedLedgerDigest: string;
}
interface LegacyLifecycleReceiptBindingSet {
  schemaVersion: 1;
  bindingType: 'legacy-lifecycle-transition-set';
  storyId: string;
  observedLedgerDigest: string;
  bindings: LegacyLifecycleReceiptBindingEntry[];
}

function verifiedLegacyReceiptBindings(
  ledger: LedgerEnvelope<JsonValue>,
  trustedKeys: readonly FindingLedgerQueryTrustedKey[],
): Map<string, LegacyReceiptBindingEntry> {
  const recordsById = new Map(ledger.records.map((record) => [record.recordId, record]));
  const bindings = new Map<string, LegacyReceiptBindingEntry>();
  for (const carrier of ledger.receipts as PersistedCommitReceipt[]) {
    const signed = carrier.findingLedgerReceipt;
    if (!signed || signed.operation !== 'append_legacy_identity_binding') continue;
    const trust = queryTrust(signed.keyId, signed.trustRootDigest, signed.keyFreshnessPolicyDigest, trustedKeys);
    if (!trust || !verifyFindingLedgerReceipt(signed, trust)) continue;
    for (const recordId of signed.recordIds) {
      const record = recordsById.get(recordId);
      if (!record || record.recordType !== 'legacy_receipt_binding'
        || !record.payload || typeof record.payload !== 'object') continue;
      const payload = record.payload as unknown as LegacyReceiptBindingSet;
      if (!exactKeys(payload, ['bindingType', 'bindings', 'observedLedgerDigest', 'schemaVersion'])
        || payload.schemaVersion !== 1
        || payload.bindingType !== 'legacy-unsigned-receipt-set'
        || payload.observedLedgerDigest !== signed.priorLedgerDigest
        || !Array.isArray(payload.bindings)) continue;
      for (const binding of payload.bindings) {
        if (!binding || typeof binding !== 'object'
          || !exactKeys(binding, [
            'committedLedgerDigest', 'legacyReceiptDigest', 'priorLedgerDigest',
            'receiptId', 'recordIds',
          ])
          || [
            binding.receiptId, binding.legacyReceiptDigest,
            binding.priorLedgerDigest, binding.committedLedgerDigest,
          ].some((value) => typeof value !== 'string' || !value.trim())
          || !Array.isArray(binding.recordIds)
          || binding.recordIds.length === 0
          || binding.recordIds.some((value) => typeof value !== 'string' || !value.trim())) continue;
        bindings.set(binding.legacyReceiptDigest, binding);
      }
    }
  }
  return bindings;
}

function legacyLifecycleReceiptBindingEntry(
  ledger: LedgerEnvelope<JsonValue>,
  storyId: string,
  carrier: PersistedCommitReceipt,
  trust: FindingLedgerReceiptTrust,
): LegacyLifecycleReceiptBindingEntry | undefined {
  const signed = carrier.findingLedgerReceipt;
  const carrierIndex = ledger.receipts.indexOf(carrier);
  const firstCurrentExactReceiptIndex = (ledger.receipts as PersistedCommitReceipt[])
    .findIndex((candidate) => {
      const candidateSigned = candidate.findingLedgerReceipt;
      return candidate.operation !== 'append_legacy_identity_binding'
        && !!candidateSigned
        && verifyFindingLedgerReceipt(candidateSigned, trust)
        && candidateSigned.storyId === storyId
        && typeof candidate.exactRequestDigest === 'string'
        && candidateSigned.exactRequestDigest === candidate.exactRequestDigest;
    });
  if (!signed || !verifyFindingLedgerReceipt(signed, trust)
    || carrierIndex < 0
    || firstCurrentExactReceiptIndex < 0
    || carrierIndex >= firstCurrentExactReceiptIndex
    || carrier.operation !== 'append_finding_lifecycle_transition'
    || signed.operation !== 'append_finding_lifecycle_transition'
    || signed.storyId !== storyId
    || signed.receiptId !== carrier.receiptId
    || signed.idempotencyKey !== carrier.idempotencyKey
    || signed.recordIds.length !== 1
    || carrier.recordIds.length !== 1
    || signed.recordIds[0] !== carrier.recordIds[0]
    || signed.priorLedgerDigest !== carrier.priorLedgerDigest
    || signed.committedLedgerDigest !== carrier.committedLedgerDigest
    || signed.committedAt !== carrier.committedAt
    || signed.writerSessionId !== carrier.writerSessionId
    || signed.writerFenceToken !== carrier.writerFenceToken
    || signed.replayed !== false
    || carrier.replayed !== false
    || typeof carrier.exactRequestDigest !== 'string'
    || !/^[0-9a-f]{64}$/.test(carrier.exactRequestDigest)
    || signed.exactRequestDigest !== undefined) return undefined;

  const transitionRecordId = carrier.recordIds[0]!;
  const recordIndex = ledger.records.findIndex((record) => record.recordId === transitionRecordId);
  const transitionRecord = ledger.records[recordIndex];
  if (recordIndex <= 0 || !transitionRecord
    || transitionRecord.recordType !== 'finding_lifecycle_transition'
    || !transitionRecord.payload || typeof transitionRecord.payload !== 'object'
    || transitionRecord.idempotencyKey !== carrier.idempotencyKey) return undefined;
  const transition = transitionRecord.payload as Record<string, unknown>;
  if (transition.schemaVersion !== 1
    || typeof transition.findingId !== 'string' || !transition.findingId
    || typeof transition.findingRecordId !== 'string' || !transition.findingRecordId
    || transition.fromStatus !== 'open'
    || !['resolved', 'dismissed'].includes(String(transition.toStatus))) return undefined;
  const sourceIndex = ledger.records.findIndex((record) => record.recordId === transition.findingRecordId);
  if (sourceIndex < 0 || sourceIndex >= recordIndex) return undefined;
  const source = ledger.records[sourceIndex]!;
  const priorHead = ledger.records[recordIndex - 1]!;
  const requestRecords = [{
    recordType: transitionRecord.recordType,
    payload: transitionRecord.payload,
    ...(transitionRecord.uniqueBindingKey
      ? { uniqueBindingKey: transitionRecord.uniqueBindingKey }
      : {}),
  }];
  const expectedStorageRequestDigest = canonicalHash({
    operation: carrier.operation,
    idempotencyKey: carrier.idempotencyKey,
    records: requestRecords,
    ledgerSchemaEpoch: ledger.ledgerSchemaEpoch,
    writerCapability: ledger.minimumWriterCapability,
  });
  const expectedExactRequestDigest = canonicalHash({
    storyId,
    operation: carrier.operation,
    idempotencyKey: carrier.idempotencyKey,
    records: requestRecords,
    casBindings: signed.casBindings,
  });
  const expectedPriorDigest = canonicalHash(ledger.records.slice(0, recordIndex));
  const expectedCommittedDigest = canonicalHash(ledger.records.slice(0, recordIndex + 1));
  const expectedPredicateDigest = canonicalHash({
    schemaVersion: 1,
    predicate: 'finding-open-without-terminal-transition',
    findingId: transition.findingId,
    findingRecordId: transition.findingRecordId,
  });
  const cas = signed.casBindings[0];
  if (carrier.requestDigest !== expectedStorageRequestDigest
    || carrier.exactRequestDigest !== expectedExactRequestDigest
    || transitionRecord.priorDigest !== expectedPriorDigest
    || signed.priorLedgerDigest !== expectedPriorDigest
    || signed.committedLedgerDigest !== expectedCommittedDigest
    || signed.casBindings.length !== 1 || !cas
    || cas.recordType !== source.recordType
    || cas.expectedRecordId !== source.recordId
    || cas.expectedRecordHash !== canonicalHash(source)
    || cas.observedChainHeadId !== priorHead.recordId
    || cas.observedChainHeadHash !== canonicalHash(priorHead)
    || cas.predicateDigest !== expectedPredicateDigest) return undefined;
  return {
    receiptId: carrier.receiptId,
    legacyReceiptDigest: canonicalHash(carrier),
    transitionRecordId,
    transitionRecordHash: canonicalHash(transitionRecord),
    findingId: transition.findingId,
    findingRecordId: transition.findingRecordId,
    findingRecordHash: canonicalHash(source),
    outerExactRequestDigest: carrier.exactRequestDigest,
    priorLedgerDigest: carrier.priorLedgerDigest,
    committedLedgerDigest: carrier.committedLedgerDigest,
  };
}

function verifiedLegacyLifecycleReceiptBindings(
  ledger: LedgerEnvelope<JsonValue>,
  storyId: string,
  trustedKeys: readonly FindingLedgerQueryTrustedKey[],
): Set<string> {
  const result = new Set<string>();
  for (const record of ledger.records) {
    if (record.recordType !== 'legacy_lifecycle_receipt_binding'
      || !record.payload || typeof record.payload !== 'object') continue;
    const payload = record.payload as unknown as LegacyLifecycleReceiptBindingSet;
    if (!exactKeys(payload, ['bindingType', 'bindings', 'observedLedgerDigest', 'schemaVersion', 'storyId'])
      || payload.schemaVersion !== 1
      || payload.bindingType !== 'legacy-lifecycle-transition-set'
      || payload.storyId !== storyId
      || !Array.isArray(payload.bindings) || payload.bindings.length === 0
      || record.uniqueBindingKey !== `legacy-lifecycle-binding:${canonicalHash(payload.bindings)}`) continue;
    const recordIndex = ledger.records.findIndex((candidate) => candidate.recordId === record.recordId);
    const carriers = (ledger.receipts as PersistedCommitReceipt[])
      .filter((candidate) => candidate.recordIds.includes(record.recordId));
    if (recordIndex < 0 || carriers.length !== 1) continue;
    const carrier = carriers[0]!;
    const signed = carrier.findingLedgerReceipt;
    if (!signed) continue;
    const trust = queryTrust(signed.keyId, signed.trustRootDigest, signed.keyFreshnessPolicyDigest, trustedKeys);
    const requestRecords = [{
      recordType: record.recordType,
      payload: record.payload,
      uniqueBindingKey: record.uniqueBindingKey,
    }];
    const expectedPriorDigest = canonicalHash(ledger.records.slice(0, recordIndex));
    const expectedCommittedDigest = canonicalHash(ledger.records.slice(0, recordIndex + 1));
    const expectedStorageRequestDigest = canonicalHash({
      operation: 'append_legacy_identity_binding',
      idempotencyKey: carrier.idempotencyKey,
      records: requestRecords,
      ledgerSchemaEpoch: ledger.ledgerSchemaEpoch,
      writerCapability: ledger.minimumWriterCapability,
    });
    const expectedExactRequestDigest = canonicalHash({
      storyId: payload.storyId,
      operation: 'append_legacy_identity_binding',
      idempotencyKey: carrier.idempotencyKey,
      records: requestRecords,
      casBindings: [],
      expectedPriorLedgerDigest: payload.observedLedgerDigest,
    });
    if (!trust || !verifyFindingLedgerReceipt(signed, trust)
      || carrier.operation !== 'append_legacy_identity_binding'
      || signed.operation !== 'append_legacy_identity_binding'
      || signed.storyId !== payload.storyId
      || signed.receiptId !== carrier.receiptId
      || signed.idempotencyKey !== carrier.idempotencyKey
      || carrier.idempotencyKey !== `legacy-lifecycle-binding:${canonicalHash(payload.bindings)}`
      || record.idempotencyKey !== carrier.idempotencyKey
      || signed.recordIds.length !== 1 || signed.recordIds[0] !== record.recordId
      || carrier.recordIds.length !== 1 || carrier.recordIds[0] !== record.recordId
      || signed.casBindings.length !== 0
      || carrier.requestDigest !== expectedStorageRequestDigest
      || carrier.exactRequestDigest !== expectedExactRequestDigest
      || signed.exactRequestDigest !== expectedExactRequestDigest
      || payload.observedLedgerDigest !== expectedPriorDigest
      || record.priorDigest !== expectedPriorDigest
      || carrier.priorLedgerDigest !== expectedPriorDigest
      || signed.priorLedgerDigest !== expectedPriorDigest
      || carrier.committedLedgerDigest !== expectedCommittedDigest
      || signed.committedLedgerDigest !== expectedCommittedDigest
      || signed.committedAt !== carrier.committedAt
      || signed.writerSessionId !== carrier.writerSessionId
      || signed.writerFenceToken !== carrier.writerFenceToken
      || signed.replayed !== false || carrier.replayed !== false) continue;
    const seen = new Set<string>();
    let valid = true;
    for (const binding of payload.bindings) {
      if (!binding || typeof binding !== 'object'
        || !exactKeys(binding, [
          'committedLedgerDigest', 'findingId', 'findingRecordHash', 'findingRecordId',
          'legacyReceiptDigest', 'outerExactRequestDigest', 'priorLedgerDigest', 'receiptId',
          'transitionRecordHash', 'transitionRecordId',
        ])
        || [
          binding.legacyReceiptDigest, binding.transitionRecordHash, binding.findingRecordHash,
          binding.outerExactRequestDigest, binding.priorLedgerDigest, binding.committedLedgerDigest,
        ].some((value) => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
        || [
          binding.receiptId, binding.transitionRecordId, binding.findingId, binding.findingRecordId,
        ].some((value) => typeof value !== 'string' || !value.trim())
        || seen.has(binding.legacyReceiptDigest)) {
        valid = false;
        break;
      }
      seen.add(binding.legacyReceiptDigest);
    }
    if (valid) for (const digest of seen) result.add(digest);
  }
  return result;
}

function currentChainHead<T>(ledger: LedgerEnvelope<T>): { id: string; hash: string } {
  const head = ledger.records.at(-1);
  return head
    ? { id: head.recordId, hash: canonicalHash(head) }
    : { id: 'ledger:empty', hash: canonicalHash([]) };
}

export function exactLedgerRecordHash(record: LedgerRecord<unknown>): string {
  return canonicalHash(record);
}

function exactRequestDigest<T extends JsonValue>(options: LedgerAppendOptions<T>): string {
  return canonicalHash({
    storyId: options.storyId,
    operation: options.operation,
    idempotencyKey: options.idempotencyKey,
    records: options.records,
    casBindings: options.casBindings ?? [],
    ...(options.expectedPriorLedgerDigest !== undefined
      ? { expectedPriorLedgerDigest: options.expectedPriorLedgerDigest }
      : {}),
  });
}

function storageRequestDigest<T extends JsonValue>(options: LedgerAppendOptions<T>): string {
  return canonicalHash({
    operation: options.operation,
    idempotencyKey: options.idempotencyKey,
    records: options.records,
    ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH,
    writerCapability: FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY,
  });
}

/**
 * A replay is safe only when the signed public receipt binds the exact caller
 * request and the unsigned persistence carrier still names the same immutable
 * ledger prefix and exact records. Legacy receipts without that signed digest
 * remain queryable, but deliberately fail closed on replay.
 */
function isExactSignedReplayBinding<T extends JsonValue>(
  ledger: LedgerEnvelope<T>,
  carrier: PersistedCommitReceipt,
  receipt: FindingLedgerReceipt,
  options: LedgerAppendOptions<T>,
  transactionDigest: string,
): boolean {
  if (receipt.exactRequestDigest !== transactionDigest
    || carrier.exactRequestDigest !== receipt.exactRequestDigest
    || carrier.requestDigest !== storageRequestDigest(options)
    || receipt.storyId !== options.storyId
    || receipt.operation !== options.operation
    || receipt.idempotencyKey !== options.idempotencyKey
    || receipt.receiptId !== carrier.receiptId
    || receipt.operation !== carrier.operation
    || receipt.idempotencyKey !== carrier.idempotencyKey
    || canonicalJson(receipt.recordIds) !== canonicalJson(carrier.recordIds)
    || canonicalJson(receipt.casBindings) !== canonicalJson(options.casBindings ?? [])
    || receipt.priorLedgerDigest !== carrier.priorLedgerDigest
    || receipt.committedLedgerDigest !== carrier.committedLedgerDigest
    || receipt.writerSessionId !== carrier.writerSessionId
    || receipt.writerFenceToken !== carrier.writerFenceToken
    || receipt.committedAt !== carrier.committedAt
    || receipt.replayed !== false
    || carrier.replayed !== false
    || (options.expectedPriorLedgerDigest !== undefined
      && receipt.priorLedgerDigest !== options.expectedPriorLedgerDigest)
    || receipt.recordIds.length !== options.records.length) return false;

  const carrierIndex = ledger.receipts.indexOf(carrier);
  if (carrierIndex < 0) return false;
  const recordsById = new Map(ledger.records.map((record) => [record.recordId, record]));
  const seenRecordIds = new Set<string>();
  const orderedRecords: LedgerRecord<T>[] = [];
  let priorDigest = canonicalHash([]);
  for (let index = 0; index <= carrierIndex; index += 1) {
    const candidate = ledger.receipts[index]!;
    const candidatePriorDigest = priorDigest;
    for (const recordId of candidate.recordIds) {
      const record = recordsById.get(recordId);
      if (!record) return false;
      if (!seenRecordIds.has(recordId)) {
        const expectedRecord = ledger.records[orderedRecords.length];
        if (!expectedRecord || expectedRecord.recordId !== recordId
          || record.priorDigest !== candidatePriorDigest) return false;
        seenRecordIds.add(recordId);
        orderedRecords.push(record);
      }
    }
    const candidateCommittedDigest = canonicalHash(orderedRecords);
    if (index === carrierIndex) {
      if (receipt.priorLedgerDigest !== candidatePriorDigest
        || receipt.committedLedgerDigest !== candidateCommittedDigest) return false;
    }
    priorDigest = candidateCommittedDigest;
  }

  return options.records.every((input, index) => {
    const record = recordsById.get(receipt.recordIds[index]!);
    return !!record
      && record.recordType === input.recordType
      && record.payloadHash === canonicalHash(input.payload)
      && canonicalJson(record.payload) === canonicalJson(input.payload)
      && record.uniqueBindingKey === input.uniqueBindingKey;
  });
}

/**
 * Compare exact referenced-record bytes, chain tip, ledger digest and a
 * caller-owned predicate under the acquired fence, then publish semantic rows
 * and the signed receipt in one atomic Store write.
 */
export function appendFindingLedger<T extends JsonValue = JsonValue>(options: LedgerAppendOptions<T>): FindingLedgerReceipt {
  if (options.fence.writerFenceToken !== options.writerFenceToken) {
    throw new Error('STALE_FENCE: request fence token does not match the acquired lock');
  }
  const request: AppendRequest<T> = {
    operation: options.operation, idempotencyKey: options.idempotencyKey, records: options.records,
    ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH, writerCapability: FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY,
    writerSessionId: options.writerSessionId, writerFenceToken: options.writerFenceToken,
    expectedPriorLedgerDigest: options.expectedPriorLedgerDigest, storageCapability: FINDING_LEDGER_LOCAL_FS_CAPABILITY,
  };
  const transactionDigest = exactRequestDigest(options);
  return options.store.transactFindingLedger<T, FindingLedgerReceipt>(options.storyId, options.fence, (current) => {
    const existing = current.receipts.find((candidate) => candidate.idempotencyKey === options.idempotencyKey) as PersistedCommitReceipt | undefined;
    if (existing) {
      const receipt = existing.findingLedgerReceipt;
      if (!receipt || !verifyFindingLedgerReceipt(receipt, {
        publicKey: options.signer.publicKey,
        keyId: options.signer.keyId,
        algorithm: 'ed25519',
        trustRootDigest: options.signer.trustRootDigest,
        keyFreshnessPolicyDigest: options.signer.keyFreshnessPolicyDigest,
      }) || !isExactSignedReplayBinding(current, existing, receipt, options, transactionDigest)) {
        throw new Error('IDEMPOTENCY_CONFLICT: idempotency key is not bound by a valid signed exact transaction');
      }
      const records = existing.recordIds.map((recordId) => {
        const record = current.records.find((candidate) => candidate.recordId === recordId);
        if (!record) throw new Error(`ledger receipt references missing record ${recordId}`);
        return record;
      });
      const replayPlan: AppendPlan<T> = {
        action: 'replay', records, receipt: existing, envelope: current,
      };
      return { plan: replayPlan, result: receipt };
    }

    if (options.expectedPriorLedgerDigest !== undefined
      && options.expectedPriorLedgerDigest !== current.committedLedgerDigest) {
      throw new Error('CAS_CONFLICT: prior ledger digest does not match');
    }
    const bindings = options.casBindings ?? [];
    const head = currentChainHead(current);
    const referencedRecords = bindings.map((binding) => {
      const record = current.records.find((candidate) => candidate.recordId === binding.expectedRecordId);
      if (!record || record.recordType !== binding.recordType
        || exactLedgerRecordHash(record) !== binding.expectedRecordHash
        || binding.observedChainHeadId !== head.id
        || binding.observedChainHeadHash !== head.hash) {
        throw new Error('CAS_CONFLICT: exact record or current chain head does not match');
      }
      return { record, canonicalBytes: canonicalJson(record) };
    });
    if (bindings.length > 0) {
      if (!options.verifyPredicate) throw new Error('CAS_CONFLICT: predicate verifier is required');
      const predicate = options.verifyPredicate({
        ledger: current, referencedRecords, currentChainHeadId: head.id, currentChainHeadHash: head.hash,
      });
      if (!predicate.accepted || bindings.some((binding) => binding.predicateDigest !== predicate.predicateDigest)) {
        throw new Error('CAS_CONFLICT: predicate digest or result does not match');
      }
    }

    const plan = planAppend(current, request);
    const core = plan.receipt;
    const receipt = signFindingLedgerReceipt({
      schemaVersion: 1, ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH,
      minimumWriterCapability: FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY, receiptId: core.receiptId,
      storyId: options.storyId, idempotencyKey: core.idempotencyKey,
      exactRequestDigest: transactionDigest, operation: options.operation,
      recordIds: core.recordIds, casBindings: bindings, priorLedgerDigest: core.priorLedgerDigest,
      committedLedgerDigest: core.committedLedgerDigest, replayed: false, committedAt: core.committedAt,
      writerSessionId: core.writerSessionId, writerLeaseId: options.writerLeaseId,
      writerFenceToken: core.writerFenceToken, keyId: options.signer.keyId, algorithm: 'ed25519',
      trustRootDigest: options.signer.trustRootDigest,
      keyFreshnessPolicyDigest: options.signer.keyFreshnessPolicyDigest,
    }, options.signer);
    const persisted = core as PersistedCommitReceipt;
    persisted.exactRequestDigest = transactionDigest;
    persisted.findingLedgerReceipt = receipt;
    return { plan, result: receipt };
  }, options.commitOptions);
}

function findingProjectionPayload(finding: Finding): JsonValue {
  const projection = structuredClone(finding) as Finding;
  delete projection.recordId;
  delete projection.ledgerCommitReceiptId;
  return projection as unknown as JsonValue;
}

/**
 * Compatibility mutation adapter for live Finding writers that predate the
 * authoritative ledger. The callback runs under the same fenced lock as the
 * append. New legacy rows become durable `finding` facts; changes to an
 * existing durable row become immutable full projections tied to that source
 * record. findings.json remains only the post-commit compatibility mirror.
 */
export function createAuthoritativeFindingMutation(ctx: HandlerContext): AuthoritativeFindingMutation {
  return <T>(
    storyId: string,
    mutationId: string,
    mutate: (data: FindingData) => AuthoritativeFindingMutationResult<T>,
  ): T => {
    const run = (fence: ReturnType<typeof captureMkdirLockFence>): T => {
      const data = ctx.store.readFindings(storyId);
      const before = new Map(data.findings.map((finding) => [finding.id, canonicalHash(finding)]));
      const mutation = mutate(data);
      const selected = mutation.changedFindingIds
        ? new Set(mutation.changedFindingIds)
        : new Set(data.findings
          .filter((finding) => before.get(finding.id) !== canonicalHash(finding))
          .map((finding) => finding.id));
      const changed = data.findings.filter((finding) => selected.has(finding.id));
      if (changed.length === 0) return mutation.result;

      const ledger = ctx.store.readFindingLedger<JsonValue>(storyId);
      const head = ledger.records.at(-1);
      const headId = head?.recordId ?? 'ledger:empty';
      const headHash = head ? exactLedgerRecordHash(head) : canonicalHash([]);
      const records = changed.map((finding) => {
        const source = [...ledger.records].reverse().find((record) => (
          record.recordType === 'finding'
          && record.payload && typeof record.payload === 'object'
          && (record.payload as Record<string, unknown>).id === finding.id
        ));
        if (!source) {
          return {
            recordType: 'finding',
            payload: findingProjectionPayload(finding),
          };
        }
        return {
          recordType: 'finding_projection',
          payload: {
            schemaVersion: 1,
            findingId: finding.id,
            findingRecordId: source.recordId,
            projection: findingProjectionPayload(finding),
          } as JsonValue,
        };
      });
      const sourceRecords = records
        .filter((record) => record.recordType === 'finding_projection')
        .map((record) => (record.payload as Record<string, unknown>).findingRecordId as string)
        .map((recordId) => ledger.records.find((record) => record.recordId === recordId)!)
        .filter((record, index, all) => all.findIndex((candidate) => candidate.recordId === record.recordId) === index);
      const predicateDigest = canonicalHash({
        schemaVersion: 1,
        predicate: 'finding-projection-sources-current',
        sourceRecordIds: sourceRecords.map((record) => record.recordId).sort(),
      });
      const identity = getSessionIdentity();
      const signer = findingLedgerSignerFromWorkspace(ctx.root);
      appendFindingLedger({
        storyId,
        store: ctx.store,
        operation: 'append_finding_projection',
        idempotencyKey: `finding-projection:${mutationId}:${canonicalHash(records)}`,
        records,
        writerSessionId: identity.sessionId,
        writerLeaseId: readOwnerLease(ctx.store.storyDirPath(storyId))?.sessionId ?? identity.sessionId,
        writerFenceToken: fence.writerFenceToken,
        fence,
        signer,
        casBindings: sourceRecords.map((source) => ({
          recordType: source.recordType,
          expectedRecordId: source.recordId,
          expectedRecordHash: exactLedgerRecordHash(source),
          observedChainHeadId: headId,
          observedChainHeadHash: headHash,
          predicateDigest,
        })),
        ...(sourceRecords.length > 0 ? {
          verifyPredicate: ({ ledger: current }) => ({
            accepted: sourceRecords.every((source) => current.records.some((record) => (
              record.recordId === source.recordId
              && exactLedgerRecordHash(record) === exactLedgerRecordHash(source)
            ))),
            predicateDigest,
          }),
        } : {}),
      });
      // The ledger is authoritative. Re-read its projection so a crash between
      // the atomic ledger rename and this mirror write remains recoverable.
      ctx.store.writeFindings(storyId, ctx.store.readFindings(storyId));
      return mutation.result;
    };

    if (storyId.startsWith('B-META-')) {
      const mainRoot = resolveMainRepoRoot(ctx.root);
      return withReentrantMainWriteLock(mainRoot, () => run(captureMkdirLockFence(mainWriteLockPath(mainRoot))), {
        label: `authoritative finding mutation (${storyId})`,
        onContention: 'wait',
      });
    }
    const lockDir = ctx.store.runtimeLockDirPath(storyId, 'finding', 'findings');
    return withMkdirLock(lockDir, () => run(captureMkdirLockFence(lockDir)), {
      label: `authoritative finding mutation (${storyId})`,
      requireHolderToken: true,
    });
  };
}

/**
 * Append a signed, auditable binding for legacy unsigned commit receipts.
 * Existing rows and receipts are never rewritten. Query acceptance remains
 * bounded to the exact receipt bytes observed by this signed transaction.
 */
export function bindLegacyFindingLedgerReceipts(options: Omit<LedgerAppendOptions<JsonValue>,
  'operation' | 'idempotencyKey' | 'records'>): FindingLedgerReceipt | null {
  let ledger = options.store.readFindingLedger<JsonValue>(options.storyId);
  const { privateKey: _privateKey, ...publicSigner } = options.signer;
  const existingBindings = verifiedLegacyReceiptBindings(ledger, [{ ...publicSigner }]);
  const unsigned = (ledger.receipts as PersistedCommitReceipt[])
    .filter((receipt) => !receipt.findingLedgerReceipt)
    .map((receipt): LegacyReceiptBindingEntry => ({
      receiptId: receipt.receiptId,
      legacyReceiptDigest: canonicalHash(receipt),
      recordIds: [...receipt.recordIds],
      priorLedgerDigest: receipt.priorLedgerDigest,
      committedLedgerDigest: receipt.committedLedgerDigest,
    }))
    .filter((binding) => !existingBindings.has(binding.legacyReceiptDigest));
  let latestReceipt: FindingLedgerReceipt | null = null;
  if (unsigned.length > 0) {
    const payload: LegacyReceiptBindingSet = {
      schemaVersion: 1,
      bindingType: 'legacy-unsigned-receipt-set',
      observedLedgerDigest: ledger.committedLedgerDigest,
      bindings: unsigned,
    };
    latestReceipt = appendFindingLedger({
      ...options,
      operation: 'append_legacy_identity_binding',
      idempotencyKey: `legacy-receipt-binding:${canonicalHash(payload)}`,
      records: [{
        recordType: 'legacy_receipt_binding',
        payload: payload as unknown as JsonValue,
        uniqueBindingKey: `legacy-receipt-binding:${canonicalHash(unsigned)}`,
      }],
      expectedPriorLedgerDigest: ledger.committedLedgerDigest,
    });
    ledger = options.store.readFindingLedger<JsonValue>(options.storyId);
  }

  const trust: FindingLedgerReceiptTrust = { ...publicSigner, algorithm: 'ed25519' };
  const alreadyBound = verifiedLegacyLifecycleReceiptBindings(ledger, options.storyId, [{ ...publicSigner }]);
  const lifecycleBindings = (ledger.receipts as PersistedCommitReceipt[])
    .map((carrier) => legacyLifecycleReceiptBindingEntry(ledger, options.storyId, carrier, trust))
    .filter((binding): binding is LegacyLifecycleReceiptBindingEntry => (
      !!binding && !alreadyBound.has(binding.legacyReceiptDigest)
    ));
  if (lifecycleBindings.length === 0) return latestReceipt;
  const lifecyclePayload: LegacyLifecycleReceiptBindingSet = {
    schemaVersion: 1,
    bindingType: 'legacy-lifecycle-transition-set',
    storyId: options.storyId,
    observedLedgerDigest: ledger.committedLedgerDigest,
    bindings: lifecycleBindings,
  };
  return appendFindingLedger({
    ...options,
    operation: 'append_legacy_identity_binding',
    idempotencyKey: `legacy-lifecycle-binding:${canonicalHash(lifecycleBindings)}`,
    records: [{
      recordType: 'legacy_lifecycle_receipt_binding',
      payload: lifecyclePayload as unknown as JsonValue,
      uniqueBindingKey: `legacy-lifecycle-binding:${canonicalHash(lifecycleBindings)}`,
    }],
    expectedPriorLedgerDigest: ledger.committedLedgerDigest,
  });
}

export function replayOriginalRecordIds(receipt: FindingLedgerReceipt): string[] { return [...receipt.recordIds]; }

export interface RuntimeReceiptAppendOptions extends Omit<LedgerAppendOptions<JsonValue>, 'operation' | 'records'> {
  runtimeReceipt: RuntimeEvidenceReceipt;
}

/** Persist one runtime receipt through the same signed, fenced CHK-003 transaction. */
export function appendRuntimeReceipt(options: RuntimeReceiptAppendOptions): FindingLedgerReceipt {
  return appendFindingLedger({
    ...options,
    operation: FINDING_RUNTIME_EVIDENCE_ADAPTER_CONTRACT.appendOperation,
    records: [{
      recordType: 'runtime_evidence_receipt',
      payload: options.runtimeReceipt as unknown as JsonValue,
      uniqueBindingKey: `runtime-evidence-receipt:${options.runtimeReceipt.receiptId}`,
    }],
  });
}

export interface AssessmentProposalVerification { valid: boolean; rejection?: string; proposalDigest?: string; }
export interface AssessmentProposalVerifyOptions {
  publicKey: string;
  expectedAuthorityDigest: string;
  now?: Date;
  expectedFindingHash?: string;
  expectedHeadHash?: string;
  expectedMaterialHash?: string;
  expectedStoryFilesHash?: string;
  receipt?: FindingLedgerReceipt;
  receiptTrust?: LedgerReceiptTrust;
  proposalRecord?: LedgerRecord<JsonValue>;
  requireReceipt?: boolean;
  receiptIsCurrent?: boolean;
  finalAssessment?: Record<string, unknown>;
}

const PROPOSAL_ENVELOPE_KEYS = [
  'schemaVersion', 'proposalId', 'findingRef', 'findingHash', 'findingVersion',
  'evaluationScope', 'owner', 'issuedAt', 'expiresAt', 'freshnessPolicyVersion',
  'maxAgeSeconds', 'dependencyBundle', 'evidenceRefs', 'historicalSourceRefs',
  'protectedSurfaceEvaluation', 'reviewRunId', 'reviewRound', 'scopeDigest',
  'headHash', 'materialHash', 'storyFilesHash', 'runtimeReceiptIds', 'assessedBy',
  'proposalDigest', 'proposalSigner', 'proposalSignature', 'verdict', 'basis',
];
const PROPOSAL_VARIANT_KEYS: Record<string, string[]> = {
  applicable: ['currentWitness'],
  pre_existing_unaffected: ['baseHead'],
  out_of_scope: ['excludedScopeProofDigest'],
  duplicate: ['canonicalDefectRef'],
  not_reproduced_under_current_witness: ['currentWitness'],
  disproven: ['currentWitness'],
  unknown: [],
};
const PROPOSAL_ENVELOPE_TEXT_KEYS = [
  'proposalId', 'findingHash', 'findingVersion', 'issuedAt', 'expiresAt',
  'freshnessPolicyVersion', 'reviewRunId', 'reviewRound', 'scopeDigest', 'headHash',
  'materialHash', 'storyFilesHash', 'assessedBy', 'proposalDigest', 'proposalSignature',
];
const PROPOSAL_PROTECTED_SURFACES = [
  'data_integrity', 'security_or_privacy', 'package_publish_or_clean_install',
  'cli_primary_entrypoint', 'agent_resolution', 'historical_evidence_integrity', 'lifecycle_gate',
];

function proposalObjectShape(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && exactKeys(value, [...required, ...optional.filter((key) => Object.hasOwn(value, key))].sort());
}

function proposalTextObject(value: unknown, required: string[], optional: string[] = []): value is Record<string, string> {
  return proposalObjectShape(value, required, optional) && Object.values(value).every(nonEmptyText);
}

function proposalUnsigned(proposal: Record<string, unknown>): Record<string, unknown> {
  const { proposalDigest: _digest, proposalSignature: _signature, ...unsigned } = proposal;
  return unsigned;
}

export function signAssessmentProposal(
  proposal: Omit<Record<string, unknown>, 'proposalDigest' | 'proposalSignature'>,
  privateKey: string,
): Record<string, unknown> {
  const digest = canonicalHash(proposal);
  return {
    ...proposal,
    proposalDigest: digest,
    proposalSignature: signCanonical({ proposalDigest: digest }, privateKey),
  };
}

function proposalExactUnionValid(proposal: Record<string, unknown>): boolean {
  const verdict = typeof proposal.verdict === 'string' ? proposal.verdict : '';
  const variant = PROPOSAL_VARIANT_KEYS[verdict];
  if (!variant || !exactKeys(proposal, [...PROPOSAL_ENVELOPE_KEYS, ...variant].sort())) return false;
  if (!PROPOSAL_ENVELOPE_TEXT_KEYS.every((key) => nonEmptyText(proposal[key]))) return false;
  const signer = proposal.proposalSigner;
  if (!proposalTextObject(signer, ['actorId', 'algorithm', 'authorityDigest', 'keyId', 'trustRootDigest'])) return false;
  const findingRef = proposal.findingRef;
  if (!proposalTextObject(findingRef, ['findingId', 'recordId', 'storyId'])) return false;
  const bundle = proposal.dependencyBundle;
  if (!proposalObjectShape(bundle, [
    'digest', 'ledgerSnapshotDigest', 'proofPolicyDigest', 'reviewerAuthorityPolicyDigest', 'sourceFinding',
  ], ['canonicalIdentityDigest', 'currentCanonicalFinding', 'supersessionChainTipDigest'])) return false;
  if (!['digest', 'proofPolicyDigest', 'reviewerAuthorityPolicyDigest', 'ledgerSnapshotDigest']
    .every((key) => nonEmptyText(bundle[key]))) return false;
  for (const key of ['canonicalIdentityDigest', 'supersessionChainTipDigest']) {
    if (Object.hasOwn(bundle, key) && !nonEmptyText(bundle[key])) return false;
  }
  if (Object.hasOwn(bundle, 'currentCanonicalFinding')
    && !proposalTextObject(bundle.currentCanonicalFinding, ['findingId', 'hash', 'recordId', 'storyId'])) return false;
  const sourceFinding = bundle.sourceFinding;
  if (!proposalTextObject(sourceFinding, ['findingId', 'hash', 'recordId', 'storyId', 'version'])) return false;
  const { digest: bundleDigest, ...unsignedBundle } = bundle;
  if (bundleDigest !== canonicalHash(unsignedBundle)
    || sourceFinding.storyId !== findingRef.storyId
    || sourceFinding.findingId !== findingRef.findingId
    || sourceFinding.recordId !== findingRef.recordId
    || sourceFinding.hash !== proposal.findingHash
    || sourceFinding.version !== proposal.findingVersion) return false;
  if (proposal.schemaVersion !== 1
    || typeof proposal.evaluationScope !== 'string'
    || !['target_story', 'canonical_owner', 'repository_release'].includes(proposal.evaluationScope)
    || typeof proposal.owner !== 'string'
    || !['current_story', 'meta', 'other_story', 'unowned'].includes(proposal.owner)
    || !denseArrayOf(proposal.evidenceRefs, nonEmptyText)
    || !denseArrayOf(proposal.runtimeReceiptIds, nonEmptyText)
    || !denseArrayOf(proposal.historicalSourceRefs, (entry) => proposalTextObject(entry,
      ['findingId', 'recordId', 'storyId', 'sourceFindingHash'], ['canonicalSourceKey']))
    || !denseArrayOf(proposal.protectedSurfaceEvaluation, (entry) => (
      proposalObjectShape(entry, ['surface', 'state', 'evidenceRefs'])
      && typeof entry.surface === 'string' && PROPOSAL_PROTECTED_SURFACES.includes(entry.surface)
      && typeof entry.state === 'string' && ['clear', 'known_risk', 'unknown'].includes(entry.state)
      && denseArrayOf(entry.evidenceRefs, nonEmptyText)
    ))
    || typeof proposal.maxAgeSeconds !== 'number'
    || !Number.isFinite(proposal.maxAgeSeconds)
    || proposal.maxAgeSeconds <= 0) return false;
  const owner = proposal.owner;
  const basis = proposal.basis;
  if (verdict === 'applicable') {
    const witness = proposal.currentWitness;
    return owner === 'current_story' && (basis === 'introduced_by_diff' || basis === 'worsened_by_diff' || basis === 'direct_scope')
      && proposalObjectShape(witness, ['receiptIds', 'reproduced'])
      && witness.reproduced === true && nonEmptyTextArray(witness.receiptIds);
  }
  if (verdict === 'pre_existing_unaffected') {
    const baseHead = proposal.baseHead;
    return (owner === 'meta' || owner === 'other_story') && basis === 'base_head_reproduction'
      && proposalObjectShape(baseHead, ['baseRef', 'baseResult', 'headRef', 'headResult', 'receiptIds', 'worsenedByStory'], ['baseReceiptId', 'headReceiptId', 'pairDigest'])
      && nonEmptyText(baseHead.baseRef) && baseHead.baseResult === 'reproduced'
      && nonEmptyText(baseHead.headRef) && baseHead.headResult === 'reproduced'
      && baseHead.worsenedByStory === false && nonEmptyTextArray(baseHead.receiptIds)
      && (!Object.hasOwn(baseHead, 'pairDigest') || (typeof baseHead.pairDigest === 'string' && /^[a-f0-9]{64}$/.test(baseHead.pairDigest)
        && typeof baseHead.baseReceiptId === 'string' && typeof baseHead.headReceiptId === 'string'
        && baseHead.baseReceiptId !== baseHead.headReceiptId));
  }
  if (verdict === 'out_of_scope') {
    return (owner === 'meta' || owner === 'other_story') && basis === 'decision_scope'
      && nonEmptyText(proposal.excludedScopeProofDigest);
  }
  if (verdict === 'duplicate') {
    const defect = proposal.canonicalDefectRef;
    if ((owner !== 'meta' && owner !== 'other_story') || basis !== 'canonical_duplicate'
      || !proposalObjectShape(defect, ['canonicalDefectId', 'canonicalOwner', 'currentCanonicalFinding', 'identityDigest'])) return false;
    return nonEmptyText(defect.canonicalDefectId) && nonEmptyText(defect.identityDigest)
      && nonEmptyText(defect.canonicalOwner)
      && proposalTextObject(defect.currentCanonicalFinding, ['findingId', 'hash', 'recordId', 'storyId']);
  }
  if (verdict === 'not_reproduced_under_current_witness' || verdict === 'disproven') {
    const witness = proposal.currentWitness;
    return ((verdict === 'disproven' && owner === 'current_story') || owner === 'meta' || owner === 'other_story') && basis === 'counter_evidence'
      && proposalObjectShape(witness, [
        'commandPolicyDigest', 'negativeWitnessDigest', 'receiptIds',
        'reproduced', 'runtimeEvidenceDigest',
      ])
      && witness.reproduced === false && nonEmptyTextArray(witness.receiptIds)
      && nonEmptyText(witness.commandPolicyDigest) && nonEmptyText(witness.runtimeEvidenceDigest)
      && nonEmptyText(witness.negativeWitnessDigest);
  }
  return verdict === 'unknown' && (basis === 'direct_scope' || basis === 'counter_evidence')
    && !Object.hasOwn(proposal, 'nonBlockingProof');
}

function proposalMatchesFinal(proposal: Record<string, unknown>, finalAssessment: Record<string, unknown>): boolean {
  if (finalAssessment.proposalId !== proposal.proposalId
    || finalAssessment.assessmentProposalDigest !== proposal.proposalDigest) return false;
  const ignored = new Set(['proposalDigest', 'proposalSignature']);
  for (const [key, value] of Object.entries(proposal)) {
    if (ignored.has(key)) continue;
    if (!(key in finalAssessment)) return false;
    if (canonicalHash(finalAssessment[key]) !== canonicalHash(value)) return false;
  }
  return true;
}

/** Shared rejection matrix primitive: every mutation is rejected before route acceptance. */
export function verifyAssessmentProposal(
  proposal: Record<string, unknown>,
  opts: AssessmentProposalVerifyOptions,
): AssessmentProposalVerification {
  const reject = (rejection: string): AssessmentProposalVerification => ({ valid: false, rejection });
  try {
    if (!proposalExactUnionValid(proposal)) return reject('proposal_exact_union_invalid');
    const { proposalDigest: digest, proposalSignature: signature, ...unsigned } = proposal;
    if (typeof digest !== 'string' || digest !== canonicalHash(unsigned)) return reject('proposal_digest_mismatch');
    const signer = proposal.proposalSigner as Record<string, unknown> | undefined;
    const expectedKeyId = `assessment-proposal-${canonicalHash({ publicKey: opts.publicKey }).slice(0, 24)}`;
    const expectedTrustRootDigest = canonicalHash({
      profile: 'assessment-proposal-trust-root-v1', publicKey: opts.publicKey,
    });
    if (!signer
      || signer.authorityDigest !== opts.expectedAuthorityDigest
      || signer.actorId !== proposal.assessedBy
      || signer.algorithm !== 'ed25519'
      || signer.keyId !== expectedKeyId
      || signer.trustRootDigest !== expectedTrustRootDigest) return reject('proposal_authority_invalid');
    if (typeof signature !== 'string'
      || !verifyCanonical({ proposalDigest: digest }, signature, opts.publicKey)) return reject('proposal_signature_invalid');
    if (opts.expectedFindingHash && proposal.findingHash !== opts.expectedFindingHash) return reject('finding_hash_mismatch');
    if ((opts.requireReceipt || opts.finalAssessment) && !opts.receipt) return reject('proposal_receipt_missing');
    if (opts.receipt) {
      if (!opts.receiptTrust || !verifyFindingLedgerReceipt(opts.receipt, opts.receiptTrust)
        || opts.receipt.operation !== 'append_assessment_proposal'
        || !opts.receipt.recordIds.length
        || opts.receiptIsCurrent !== true
        || !opts.proposalRecord
        || !opts.receipt.recordIds.includes(opts.proposalRecord.recordId)
        || canonicalHash(opts.proposalRecord.payload) !== canonicalHash(proposal)) {
        return reject('proposal_receipt_invalid');
      }
    }
    const now = (opts.now ?? new Date()).getTime();
    const expiresAt = typeof proposal.expiresAt === 'string' ? Date.parse(proposal.expiresAt) : Number.NaN;
    const issuedAt = typeof proposal.issuedAt === 'string' ? Date.parse(proposal.issuedAt) : Number.NaN;
    const maxAge = typeof proposal.maxAgeSeconds === 'number' ? proposal.maxAgeSeconds * 1_000 : Number.NaN;
    if (!Number.isFinite(expiresAt) || now >= expiresAt) return reject('proposal_expired');
    if (!Number.isFinite(issuedAt) || !Number.isFinite(maxAge) || now >= issuedAt + maxAge) return reject('proposal_stale');
    if ((opts.expectedHeadHash && proposal.headHash !== opts.expectedHeadHash)
      || (opts.expectedMaterialHash && proposal.materialHash !== opts.expectedMaterialHash)
      || (opts.expectedStoryFilesHash && proposal.storyFilesHash !== opts.expectedStoryFilesHash)) {
      return reject('proposal_stale');
    }
    if (opts.finalAssessment && !proposalMatchesFinal(proposal, opts.finalAssessment)) {
      return reject('proposal_final_divergence');
    }
    if (opts.finalAssessment && opts.receipt) {
      const expectedTuple = {
        receiptId: opts.receipt.receiptId,
        receiptHash: opts.receipt.receiptHash,
        operation: 'append_assessment_proposal',
      };
      if (canonicalHash(opts.finalAssessment.proposalReceipt) !== canonicalHash(expectedTuple)) {
        return reject('proposal_final_divergence');
      }
    }
    return { valid: true, proposalDigest: digest };
  } catch { return reject('proposal_malformed'); }
}

export interface AssessmentProposalAppendOptions extends Omit<LedgerAppendOptions<JsonValue>, 'operation' | 'records'> {
  proposal: Record<string, unknown>;
  proposalPublicKey: string;
  expectedAuthorityDigest: string;
  now?: Date;
}

export function appendAssessmentProposal(options: AssessmentProposalAppendOptions): FindingLedgerReceipt {
  const verified = verifyAssessmentProposal(options.proposal, {
    publicKey: options.proposalPublicKey,
    expectedAuthorityDigest: options.expectedAuthorityDigest,
    now: options.now,
  });
  if (!verified.valid) throw new Error(`ASSESSMENT_PROPOSAL_REJECTED: ${verified.rejection}`);
  assertText(options.proposal.proposalId, 'proposal.proposalId');
  return appendFindingLedger({
    ...options,
    operation: 'append_assessment_proposal',
    records: [{
      recordType: 'assessment_proposal',
      payload: options.proposal as JsonValue,
      uniqueBindingKey: `assessment-proposal:${options.proposal.proposalId}`,
    }],
  });
}

type ManifestedAppendOptions = Omit<LedgerAppendOptions<JsonValue>, 'operation' | 'records'> & {
  record: Record<string, unknown>;
  manifest: Record<string, unknown>;
};

function containsReference(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsReference(item, expected));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsReference(item, expected));
  return false;
}

function appendManifested(
  options: ManifestedAppendOptions,
  operation: 'append_mandatory_repair' | 'append_deferral_expiry_policy',
  recordType: 'mandatory_repair' | 'deferral_expiry_policy',
  semanticId: string,
): FindingLedgerReceipt {
  if (!containsReference(options.manifest, semanticId)) {
    throw new Error(`MANIFEST_REFERENCE_MISSING: ${semanticId}`);
  }
  return appendFindingLedger({
    ...options,
    operation,
    records: [
      { recordType, payload: options.record as JsonValue, uniqueBindingKey: `${recordType}:${semanticId}` },
      { recordType: 'manifest', payload: options.manifest as JsonValue, uniqueBindingKey: `manifest:${recordType}:${semanticId}` },
    ],
  });
}

export function classifyMandatoryRepair(options: ManifestedAppendOptions): FindingLedgerReceipt {
  const id = options.record.mandatoryRepairId;
  assertText(id, 'record.mandatoryRepairId');
  if (options.record.state !== 'required') throw new Error('mandatory repair classification must have state=required');
  return appendManifested(options, 'append_mandatory_repair', 'mandatory_repair', id);
}
export function closeMandatoryRepair(options: ManifestedAppendOptions): FindingLedgerReceipt {
  const id = options.record.mandatoryRepairId;
  assertText(id, 'record.mandatoryRepairId');
  if (options.record.state !== 'closure_proven') throw new Error('mandatory repair closure must have state=closure_proven');
  return appendManifested(options, 'append_mandatory_repair', 'mandatory_repair', id);
}
export function appendDeferralExpiryPolicy(options: ManifestedAppendOptions): FindingLedgerReceipt {
  const id = options.record.policyDigest;
  assertText(id, 'record.policyDigest');
  return appendManifested(options, 'append_deferral_expiry_policy', 'deferral_expiry_policy', id);
}

export interface RuntimeEvidenceCommandSpec {
  executable: string;
  args?: string[];
  cwd?: string;
}

export interface FindingRuntimeEvidenceRunArgs {
  storyId: string;
  sourceRef?: string;
  idempotencyKey: string;
  buildCommand: RuntimeEvidenceCommandSpec;
  executionCommand: RuntimeEvidenceCommandSpec;
  artifactPaths: string[];
  environmentAllowlist?: string[];
  excludedEnvironmentVariables?: string[];
  compilerVersion: string;
  timeoutMs?: number;
  buildInProgress?: boolean;
  storageCapability?: string;
  /** Internal fault-injection seam; intentionally absent from the CLI schema. */
  commitOptions?: AppendLedgerOptions;
  /** Test-only interleaving seam after the canonical build mutex is held. */
  afterCanonicalBuildLockForTest?: () => void;
}

export interface FindingRuntimeEvidenceVerifyArgs {
  storyId: string;
  runtimeReceiptId: string;
  buildCommand: RuntimeEvidenceCommandSpec;
  executionCommand: RuntimeEvidenceCommandSpec;
  environmentAllowlist?: string[];
  excludedEnvironmentVariables?: string[];
  compilerVersion: string;
  publicKey?: string;
  keyStatus?: 'fresh' | 'unknown' | 'revoked' | 'expired';
  storageCapability?: string;
}

export interface FindingLedgerQueryTrustedKey {
  publicKey: string;
  keyId: string;
  trustRootDigest: string;
  keyFreshnessPolicyDigest: string;
}

export interface FindingLedgerQueryArgs {
  storyId: string;
}

export type FindingLedgerQueryCategory = 'ledger' | 'cas' | 'idempotency' | 'runtime' | 'migration';

interface FindingLedgerQueryRowCore {
  schemaVersion: 1;
  category: FindingLedgerQueryCategory;
  storyId: string;
  numerator: number;
  denominator: number;
  details: JsonValue;
  evidenceDigests: string[];
  gateEvidence: false;
  lifecycleAuthority: 'none';
}

export interface FindingLedgerQueryRow extends FindingLedgerQueryRowCore {
  rowDigest: string;
  keyId: string;
  algorithm: 'ed25519';
  trustRootDigest: string;
  keyFreshnessPolicyDigest: string;
  signature: string;
}

export interface FindingLedgerQueryResult {
  schemaVersion: 1;
  command: 'finding_ledger_query';
  storyId: string;
  rows: FindingLedgerQueryRow[];
  snapshotDigest: string;
  signedRows: true;
  gateEvidence: false;
  lifecycleAuthority: 'none';
  publicKey: string;
}

export type FindingLedgerQueryRefusalCode =
  | 'signing_key_unavailable'
  | 'ledger_missing'
  | 'ledger_digest_mismatch'
  | 'ledger_incomplete'
  | 'ledger_receipt_unsigned'
  | 'ledger_receipt_signature_invalid'
  | 'runtime_receipt_unsigned'
  | 'runtime_receipt_signature_invalid'
  | 'query_row_invalid';

export class FindingLedgerQueryRefusal extends Error {
  constructor(readonly code: FindingLedgerQueryRefusalCode) {
    super(`finding-ledger-query:${code}`);
    this.name = 'FindingLedgerQueryRefusal';
  }
}

const QUERY_ROW_KEYS = [
  'algorithm', 'category', 'denominator', 'details', 'evidenceDigests', 'gateEvidence',
  'keyFreshnessPolicyDigest', 'keyId', 'lifecycleAuthority', 'numerator', 'rowDigest',
  'schemaVersion', 'signature', 'storyId', 'trustRootDigest',
].sort();

function signFindingLedgerQueryRow(core: FindingLedgerQueryRowCore, signer: LedgerSigner): FindingLedgerQueryRow {
  const rowDigest = canonicalHash(core);
  const signed = {
    ...core,
    rowDigest,
    keyId: signer.keyId,
    algorithm: 'ed25519' as const,
    trustRootDigest: signer.trustRootDigest,
    keyFreshnessPolicyDigest: signer.keyFreshnessPolicyDigest,
  };
  return { ...signed, signature: signCanonical(signed, signer.privateKey) };
}

export function verifyFindingLedgerQueryRow(row: FindingLedgerQueryRow, trust: LedgerReceiptTrust): boolean {
  try {
    if (!exactKeys(row, QUERY_ROW_KEYS)
      || row.schemaVersion !== 1
      || !['ledger', 'cas', 'idempotency', 'runtime', 'migration'].includes(row.category)
      || row.gateEvidence !== false
      || row.lifecycleAuthority !== 'none'
      || !Number.isSafeInteger(row.numerator)
      || !Number.isSafeInteger(row.denominator)
      || row.numerator < 0
      || row.denominator < 0
      || row.numerator > row.denominator
      || row.keyId !== trust.keyId
      || row.algorithm !== trust.algorithm
      || row.trustRootDigest !== trust.trustRootDigest
      || row.keyFreshnessPolicyDigest !== trust.keyFreshnessPolicyDigest) return false;
    const { rowDigest, signature, keyId, algorithm, trustRootDigest, keyFreshnessPolicyDigest, ...core } = row;
    if (rowDigest !== canonicalHash(core)) return false;
    return verifyCanonical({ ...core, rowDigest, keyId, algorithm, trustRootDigest, keyFreshnessPolicyDigest }, signature, trust.publicKey);
  } catch { return false; }
}

function queryTrust(
  keyId: string,
  trustRootDigest: string,
  keyFreshnessPolicyDigest: string,
  trustedKeys: readonly FindingLedgerQueryTrustedKey[],
): LedgerReceiptTrust | undefined {
  const key = trustedKeys.find((candidate) => candidate.keyId === keyId
    && candidate.trustRootDigest === trustRootDigest
    && candidate.keyFreshnessPolicyDigest === keyFreshnessPolicyDigest);
  return key ? { ...key, algorithm: 'ed25519' } : undefined;
}

function queryRefusalForEnvelope(error: unknown): FindingLedgerQueryRefusal {
  const message = error instanceof Error ? error.message : '';
  return new FindingLedgerQueryRefusal(/digest|hash/i.test(message) ? 'ledger_digest_mismatch' : 'ledger_incomplete');
}

/**
 * Protected Story 3 query projection. The complete ledger is validated before
 * any row is returned; public rows contain only signed digests and schema-neutral
 * scorecard/migration metadata, never record payloads or protected paths.
 */
export function queryFindingLedger(
  ledger: LedgerEnvelope<JsonValue>,
  storyId: string,
  signer: LedgerSigner,
  additionalTrustedKeys: readonly FindingLedgerQueryTrustedKey[] = [],
): FindingLedgerQueryResult {
  try { validateEnvelope(ledger); } catch (error) { throw queryRefusalForEnvelope(error); }
  if (ledger.records.length === 0 || ledger.receipts.length === 0) {
    throw new FindingLedgerQueryRefusal('ledger_missing');
  }
  const trustedKeys: FindingLedgerQueryTrustedKey[] = [{
    publicKey: signer.publicKey,
    keyId: signer.keyId,
    trustRootDigest: signer.trustRootDigest,
    keyFreshnessPolicyDigest: signer.keyFreshnessPolicyDigest,
  }, ...additionalTrustedKeys];
  const recordsById = new Map(ledger.records.map((record) => [record.recordId, record]));
  const seenRecordIds = new Set<string>();
  const orderedRecords: LedgerRecord<JsonValue>[] = [];
  const receiptHashes: string[] = [];
  const casBindings: FindingLedgerCasBinding[] = [];
  const idempotencyKeyDigests: string[] = [];
  let priorDigest = canonicalHash([]);

  const legacyBindings = verifiedLegacyReceiptBindings(ledger, trustedKeys);

  for (const persisted of ledger.receipts as PersistedCommitReceipt[]) {
    const receipt = persisted.findingLedgerReceipt;
    if (!receipt || !receipt.receiptHash || !receipt.signature) {
      const digest = canonicalHash(persisted);
      const binding = legacyBindings.get(digest);
      if (!binding
        || binding.receiptId !== persisted.receiptId
        || binding.priorLedgerDigest !== persisted.priorLedgerDigest
        || binding.committedLedgerDigest !== persisted.committedLedgerDigest
        || canonicalHash(binding.recordIds) !== canonicalHash(persisted.recordIds)
        || persisted.priorLedgerDigest !== priorDigest) {
        throw new FindingLedgerQueryRefusal('ledger_receipt_unsigned');
      }
      for (const recordId of persisted.recordIds) {
        const record = recordsById.get(recordId);
        if (!record) throw new FindingLedgerQueryRefusal('ledger_incomplete');
        if (!seenRecordIds.has(recordId)) {
          const expected = ledger.records[orderedRecords.length];
          if (!expected || expected.recordId !== recordId || record.priorDigest !== priorDigest) {
            throw new FindingLedgerQueryRefusal('ledger_incomplete');
          }
          seenRecordIds.add(recordId);
          orderedRecords.push(record);
        }
      }
      const committedDigest = canonicalHash(orderedRecords);
      if (persisted.committedLedgerDigest !== committedDigest) {
        throw new FindingLedgerQueryRefusal('ledger_digest_mismatch');
      }
      priorDigest = committedDigest;
      receiptHashes.push(digest);
      idempotencyKeyDigests.push(canonicalHash(persisted.idempotencyKey));
      continue;
    }
    const trust = queryTrust(receipt.keyId, receipt.trustRootDigest, receipt.keyFreshnessPolicyDigest, trustedKeys);
    if (!trust || !verifyFindingLedgerReceipt(receipt, trust)) {
      throw new FindingLedgerQueryRefusal('ledger_receipt_signature_invalid');
    }
    const carrierRecords = persisted.recordIds.map((recordId) => recordsById.get(recordId));
    if (carrierRecords.some((record) => !record)) {
      throw new FindingLedgerQueryRefusal('ledger_incomplete');
    }
    const committedCarrierRequestDigest = canonicalHash({
      operation: persisted.operation,
      idempotencyKey: persisted.idempotencyKey,
      records: carrierRecords.map((record) => ({
        recordType: record!.recordType,
        payload: record!.payload,
        ...(record!.uniqueBindingKey ? { uniqueBindingKey: record!.uniqueBindingKey } : {}),
      })),
      ledgerSchemaEpoch: ledger.ledgerSchemaEpoch,
      writerCapability: ledger.minimumWriterCapability,
    });
    if (receipt.storyId !== storyId
      || receipt.receiptId !== persisted.receiptId
      || receipt.operation !== persisted.operation
      || receipt.idempotencyKey !== persisted.idempotencyKey
      || persisted.requestDigest !== committedCarrierRequestDigest
      || canonicalHash(receipt.recordIds) !== canonicalHash(persisted.recordIds)
      || receipt.priorLedgerDigest !== persisted.priorLedgerDigest
      || receipt.committedLedgerDigest !== persisted.committedLedgerDigest
      || receipt.writerSessionId !== persisted.writerSessionId
      || receipt.writerFenceToken !== persisted.writerFenceToken
      || receipt.committedAt !== persisted.committedAt
      || receipt.replayed !== false
      || typeof persisted.exactRequestDigest !== 'string'
      || !/^[0-9a-f]{64}$/.test(persisted.exactRequestDigest)
      || (receipt.exactRequestDigest !== undefined
        && receipt.exactRequestDigest !== persisted.exactRequestDigest)
      || receipt.priorLedgerDigest !== priorDigest) {
      throw new FindingLedgerQueryRefusal('ledger_incomplete');
    }
    for (const recordId of receipt.recordIds) {
      const record = recordsById.get(recordId);
      if (!record) throw new FindingLedgerQueryRefusal('ledger_incomplete');
      if (!seenRecordIds.has(recordId)) {
        const expected = ledger.records[orderedRecords.length];
        if (!expected || expected.recordId !== recordId || record.priorDigest !== priorDigest) {
          throw new FindingLedgerQueryRefusal('ledger_incomplete');
        }
        seenRecordIds.add(recordId);
        orderedRecords.push(record);
      }
    }
    const committedDigest = canonicalHash(orderedRecords);
    if (receipt.committedLedgerDigest !== committedDigest) {
      throw new FindingLedgerQueryRefusal('ledger_digest_mismatch');
    }
    priorDigest = committedDigest;
    receiptHashes.push(receipt.receiptHash);
    casBindings.push(...receipt.casBindings);
    idempotencyKeyDigests.push(canonicalHash(receipt.idempotencyKey));
  }
  if (orderedRecords.length !== ledger.records.length || priorDigest !== ledger.committedLedgerDigest) {
    throw new FindingLedgerQueryRefusal('ledger_incomplete');
  }

  const runtimeReceiptDigests: string[] = [];
  for (const record of ledger.records.filter((candidate) => candidate.recordType === 'runtime_evidence_receipt')) {
    const receipt = record.payload as unknown as RuntimeEvidenceReceipt;
    if (!receipt || typeof receipt.receiptHash !== 'string' || typeof receipt.signature !== 'string') {
      throw new FindingLedgerQueryRefusal('runtime_receipt_unsigned');
    }
    const trust = queryTrust(receipt.keyId, receipt.trustRootDigest, receipt.keyFreshnessPolicyDigest, trustedKeys);
    if (!trust || !verifyRuntimeEvidenceReceiptSignature(receipt, trust)) {
      throw new FindingLedgerQueryRefusal('runtime_receipt_signature_invalid');
    }
    runtimeReceiptDigests.push(receipt.receiptHash);
  }

  const migrationRecords = ledger.records.map((record) => ({
    recordId: record.recordId,
    recordType: record.recordType,
    idempotencyKeyDigest: canonicalHash(record.idempotencyKey),
    ...(record.uniqueBindingKey ? { uniqueBindingKeyDigest: canonicalHash(record.uniqueBindingKey) } : {}),
    payloadHash: record.payloadHash,
    recordHash: exactLedgerRecordHash(record),
    ledgerSchemaEpoch: record.ledgerSchemaEpoch,
    writerCapability: record.writerCapability,
    createdAt: record.createdAt,
  }));
  const rowCores: FindingLedgerQueryRowCore[] = [
    {
      schemaVersion: 1, category: 'ledger', storyId,
      numerator: ledger.receipts.length, denominator: ledger.receipts.length,
      details: { committedLedgerDigest: ledger.committedLedgerDigest, recordCount: ledger.records.length, receiptCount: ledger.receipts.length },
      evidenceDigests: [...receiptHashes].sort(), gateEvidence: false, lifecycleAuthority: 'none',
    },
    {
      schemaVersion: 1, category: 'cas', storyId,
      numerator: casBindings.length, denominator: casBindings.length,
      details: casBindings.map((binding) => ({ ...binding })),
      evidenceDigests: casBindings.map((binding) => canonicalHash(binding)).sort(), gateEvidence: false, lifecycleAuthority: 'none',
    },
    {
      schemaVersion: 1, category: 'idempotency', storyId,
      numerator: new Set(idempotencyKeyDigests).size, denominator: ledger.receipts.length,
      details: { keyDigests: [...idempotencyKeyDigests].sort(), receiptCount: ledger.receipts.length },
      evidenceDigests: [...receiptHashes].sort(), gateEvidence: false, lifecycleAuthority: 'none',
    },
    {
      schemaVersion: 1, category: 'runtime', storyId,
      numerator: runtimeReceiptDigests.length, denominator: runtimeReceiptDigests.length,
      details: { receiptDigests: [...runtimeReceiptDigests].sort() },
      evidenceDigests: [...runtimeReceiptDigests].sort(), gateEvidence: false, lifecycleAuthority: 'none',
    },
    {
      schemaVersion: 1, category: 'migration', storyId,
      numerator: migrationRecords.length, denominator: ledger.records.length,
      details: { ledgerSchemaEpoch: ledger.ledgerSchemaEpoch, minimumWriterCapability: ledger.minimumWriterCapability, records: migrationRecords },
      evidenceDigests: migrationRecords.map((record) => record.recordHash).sort(), gateEvidence: false, lifecycleAuthority: 'none',
    },
  ];
  const rows = rowCores.map((row) => signFindingLedgerQueryRow(row, signer));
  if (rows.some((row) => !verifyFindingLedgerQueryRow(row, { ...signer, algorithm: 'ed25519' }))) {
    throw new FindingLedgerQueryRefusal('query_row_invalid');
  }
  return {
    schemaVersion: 1,
    command: 'finding_ledger_query',
    storyId,
    rows,
    snapshotDigest: canonicalHash(rows),
    signedRows: true,
    gateEvidence: false,
    lifecycleAuthority: 'none',
    publicKey: signer.publicKey,
  };
}

export const RUNTIME_EVIDENCE_PRIVATE_KEY_ENV = 'PROOF_OR_STOP_RUNTIME_EVIDENCE_PRIVATE_KEY';
export const RUNTIME_EVIDENCE_PUBLIC_KEY_ENV = 'PROOF_OR_STOP_RUNTIME_EVIDENCE_PUBLIC_KEY';
export const RUNTIME_EVIDENCE_REVOKED_KEY_IDS_ENV = 'PROOF_OR_STOP_RUNTIME_EVIDENCE_REVOKED_KEY_IDS';
export const RUNTIME_EVIDENCE_BUILD_POLICY_DIGEST = canonicalDigest({
  version: 1,
  adapter: 'structured-spawn-sync',
  shell: false,
  executable: 'absolute-realpath-bound',
  environment: 'allowlisted-redacted-complete-child-env',
  artifactStability: ['pre', 'during', 'post'],
  storageCapability: RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY,
});
export const RUNTIME_EVIDENCE_KEY_FRESHNESS_POLICY_DIGEST = canonicalDigest({
  version: 2,
  policy: 'git-common-dir-runtime-key-registry-current-state-required',
});

const RUNTIME_EVIDENCE_KEY_FILE = 'proof-or-stop-runtime-evidence-v1.key';
const RUNTIME_EVIDENCE_TRUST_REGISTRY_FILE = 'proof-or-stop-runtime-evidence-trust-v1.json';

interface RuntimeEvidenceRegisteredKey extends FindingLedgerQueryTrustedKey {
  status: 'fresh' | 'revoked' | 'expired';
}
interface RuntimeEvidenceTrustRegistry {
  schemaVersion: 1;
  currentKeyId: string;
  keys: RuntimeEvidenceRegisteredKey[];
}

function runtimeKeyIdentity(publicKey: string): Omit<RuntimeEvidenceRegisteredKey, 'status'> {
  const publicKeyDigest = canonicalDigest({ publicKey });
  return {
    publicKey,
    keyId: `runtime-evidence-${publicKeyDigest.slice(0, 24)}`,
    trustRootDigest: canonicalDigest({ profile: 'runtime-evidence-trust-root-v1', publicKey }),
    keyFreshnessPolicyDigest: RUNTIME_EVIDENCE_KEY_FRESHNESS_POLICY_DIGEST,
  };
}

function readRuntimeTrustRegistry(workspaceRoot: string): RuntimeEvidenceTrustRegistry {
  const registryPath = join(gitCommonDir(workspaceRoot), RUNTIME_EVIDENCE_TRUST_REGISTRY_FILE);
  let parsed: RuntimeEvidenceTrustRegistry;
  try {
    parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as RuntimeEvidenceTrustRegistry;
  } catch {
    throw new RuntimeEvidenceRefusal('unknown_signing_key');
  }
  if (parsed.schemaVersion !== 1 || typeof parsed.currentKeyId !== 'string'
    || !Array.isArray(parsed.keys) || parsed.keys.length === 0
    || parsed.keys.some((key) => (
      !['fresh', 'revoked', 'expired'].includes(key.status)
      || canonicalHash(runtimeKeyIdentity(key.publicKey)) !== canonicalHash({
        publicKey: key.publicKey,
        keyId: key.keyId,
        trustRootDigest: key.trustRootDigest,
        keyFreshnessPolicyDigest: key.keyFreshnessPolicyDigest,
      })
    ))) {
    throw new RuntimeEvidenceRefusal('unknown_signing_key', 'runtime evidence trust registry is malformed');
  }
  return parsed;
}

/** Repository-owned signer; caller environment cannot register or select it. */
export function runtimeEvidenceSignerFromWorkspace(workspaceRoot: string): RuntimeReceiptSigner {
  const commonDir = gitCommonDir(workspaceRoot);
  const keyPath = join(commonDir, RUNTIME_EVIDENCE_KEY_FILE);
  const registryPath = join(commonDir, RUNTIME_EVIDENCE_TRUST_REGISTRY_FILE);
  if (!existsSync(keyPath)) {
    mkdirSync(dirname(keyPath), { recursive: true });
    try {
      writeFileSync(keyPath, `${randomBytes(32).toString('base64')}\n`, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
    } catch (error) {
      if (!existsSync(keyPath)) throw error;
    }
  }
  const privateKey = readFileSync(keyPath, 'utf8').trim();
  const publicKey = exportPublicKeyRaw(createPublicKey(importPrivateKeyRaw(privateKey)));
  const identity = runtimeKeyIdentity(publicKey);
  if (!existsSync(registryPath)) {
    try {
      writeFileSync(registryPath, `${JSON.stringify({
        schemaVersion: 1,
        currentKeyId: identity.keyId,
        keys: [{ ...identity, status: 'fresh' }],
      }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (!existsSync(registryPath)) throw error;
    }
  }
  const registry = readRuntimeTrustRegistry(workspaceRoot);
  const registered = registry.keys.find((key) => key.keyId === identity.keyId);
  if (!registered || registry.currentKeyId !== identity.keyId || registered.status !== 'fresh') {
    throw new RuntimeEvidenceRefusal(
      registered?.status === 'revoked' ? 'revoked_signing_key'
        : registered?.status === 'expired' ? 'expired_signing_key' : 'unknown_signing_key',
    );
  }
  return { privateKey, ...identity, algorithm: 'ed25519' };
}

function runtimeTrustFromWorkspace(workspaceRoot: string): RuntimeReceiptTrust {
  const registry = readRuntimeTrustRegistry(workspaceRoot);
  const key = registry.keys.find((candidate) => candidate.keyId === registry.currentKeyId);
  if (!key || key.status !== 'fresh') {
    throw new RuntimeEvidenceRefusal(
      key?.status === 'revoked' ? 'revoked_signing_key'
        : key?.status === 'expired' ? 'expired_signing_key' : 'unknown_signing_key',
    );
  }
  return { ...key, algorithm: 'ed25519', keyStatus: 'fresh' };
}

/** Fault-injection helper used only by repository tests; it is not in the CLI catalog. */
export function setRuntimeEvidenceKeyStatusForTest(
  workspaceRoot: string,
  status: RuntimeEvidenceRegisteredKey['status'],
): void {
  const registryPath = join(gitCommonDir(workspaceRoot), RUNTIME_EVIDENCE_TRUST_REGISTRY_FILE);
  const registry = readRuntimeTrustRegistry(workspaceRoot);
  registry.keys = registry.keys.map((key) => (
    key.keyId === registry.currentKeyId ? { ...key, status } : key
  ));
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

type ResolvedRuntimeCommand = Required<Pick<RuntimeEvidenceCommandSpec, 'executable' | 'args'>> & {
  /** Canonical receipt value; always project-relative and never a protected physical path. */
  cwd: string;
  /** Execution-only physical cwd; canonicalizeRuntimeCommand deliberately ignores this field. */
  executionCwd: string;
};

function resolveRuntimeCommand(root: string, command: RuntimeEvidenceCommandSpec): ResolvedRuntimeCommand {
  try {
    if (!command || typeof command.executable !== 'string' || !isAbsolute(command.executable)) {
      throw new Error('invalid executable');
    }
    const executable = realpathSync(command.executable);
    if (!statSync(executable).isFile()) throw new Error('invalid executable');
    const rootReal = realpathSync(root);
    const cwd = realpathSync(resolve(rootReal, command.cwd ?? '.'));
    const rel = relative(rootReal, cwd);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !statSync(cwd).isDirectory()) {
      throw new Error('cwd escape');
    }
    return { executable, args: [...(command.args ?? [])], cwd: rel || '.', executionCwd: cwd };
  } catch {
    throw new RuntimeEvidenceRefusal('realpath_policy_violation', 'runtime command violates executable/cwd policy');
  }
}

function runRuntimeCommand(
  command: ReturnType<typeof resolveRuntimeCommand>,
  environment: Record<string, string>,
  timeoutMs: number,
): { stdout: Buffer; stderr: Buffer; exitCode: number } {
  const result = spawnSync(command.executable, command.args, {
    cwd: command.executionCwd,
    env: environment,
    shell: false,
    encoding: 'buffer',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw new Error('runtime-evidence: command_spawn_failed');
  return {
    stdout: Buffer.from(result.stdout ?? Buffer.alloc(0)),
    stderr: Buffer.from(result.stderr ?? Buffer.alloc(0)),
    exitCode: typeof result.status === 'number' ? result.status : 1,
  };
}

function runtimeEnvironment(args: {
  environmentAllowlist?: string[];
  excludedEnvironmentVariables?: string[];
}) {
  return redactEnvironment(process.env, {
    allowlist: args.environmentAllowlist ?? [],
    excludedVariableNames: args.excludedEnvironmentVariables ?? [],
  });
}

function runtimeToolchain(compilerVersion: string): RuntimeEvidenceReceipt['toolchain'] {
  assertText(compilerVersion, 'compilerVersion');
  const value = { compilerVersion: compilerVersion.trim(), runtimeVersion: process.version };
  return { ...value, toolchainDigest: canonicalDigest(value) };
}

function canonicalBuildLockInProgress(projectRoot: string): boolean {
  try {
    // Exact target/options shared with scripts/build-lock-target.mjs and
    // scripts/build-lock.mjs. Keep the read in-package so a clean npm install
    // does not depend on repository-level scripts existing outside the package.
    const target = join(tmpdir(), `proof-or-stop-build-lock-${createHash('sha256').update(String(projectRoot)).digest('hex')}`);
    if (!existsSync(target)) return false;
    return properLockfile.checkSync(target, { stale: 30_000, update: 10_000 });
  } catch {
    throw new RuntimeEvidenceRefusal('build_in_progress', 'canonical build-lock state is unavailable');
  }
}

/**
 * Hold the exact build proper-lockfile in an independent broker process. The
 * handler executes commands synchronously; a same-process heartbeat would stop
 * while spawnSync blocks and could be age-stolen after 30 seconds. The broker's
 * event loop keeps the canonical 10s heartbeat alive for the whole build/run/
 * publish critical section.
 */
function withCanonicalBuildLock<T>(projectRoot: string, fn: () => T): T {
  const target = join(tmpdir(), `proof-or-stop-build-lock-${createHash('sha256').update(String(projectRoot)).digest('hex')}`);
  closeSync(openSync(target, 'a'));
  const nonce = randomBytes(12).toString('hex');
  const readyPath = join(tmpdir(), `proof-or-stop-runtime-lock-${nonce}.ready`);
  const releasePath = join(tmpdir(), `proof-or-stop-runtime-lock-${nonce}.release`);
  const broker = String.raw`
    const fs = require('node:fs');
    const lockfile = require(process.argv[1]);
    const target = process.argv[2];
    const ready = process.argv[3];
    const releaseSignal = process.argv[4];
    (async () => {
      try {
        const release = await lockfile.lock(target, { stale: 30000, update: 10000, retries: 0 });
        fs.writeFileSync(ready, 'locked');
        const timer = setInterval(async () => {
          if (!fs.existsSync(releaseSignal)) return;
          clearInterval(timer);
          await release();
          process.exit(0);
        }, 20);
      } catch (error) {
        fs.writeFileSync(ready, 'refused:' + String(error && error.code || error));
        process.exit(75);
      }
    })();
  `;
  const child = spawn(process.execPath, [
    '-e', broker, require.resolve('proper-lockfile'), target, readyPath, releasePath,
  ], { stdio: 'ignore' });
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5_000;
  while (!existsSync(readyPath) && Date.now() < deadline) Atomics.wait(waitArray, 0, 0, 20);
  const ready = existsSync(readyPath) ? readFileSync(readyPath, 'utf8') : 'timeout';
  if (ready !== 'locked') {
    child.kill();
    rmSync(readyPath, { force: true });
    rmSync(releasePath, { force: true });
    throw new RuntimeEvidenceRefusal('build_in_progress', `canonical build mutex refused: ${ready}`);
  }
  try {
    return fn();
  } finally {
    writeFileSync(releasePath, 'release');
    const lockPath = `${target}.lock`;
    const releaseDeadline = Date.now() + 5_000;
    while (existsSync(lockPath) && Date.now() < releaseDeadline) Atomics.wait(waitArray, 0, 0, 20);
    if (existsSync(lockPath)) child.kill();
    rmSync(readyPath, { force: true });
    rmSync(releasePath, { force: true });
  }
}

function runtimeReplay(
  ctx: HandlerContext,
  args: FindingRuntimeEvidenceRunArgs,
  ledgerTrust: LedgerReceiptTrust,
  expected: Parameters<typeof verifyRuntimeEvidenceCurrent>[1],
): { runtimeReceipt: RuntimeEvidenceReceipt; runtimeRecordId: string; ledgerReceipt: FindingLedgerReceipt } | null {
  const ledger = ctx.store.readFindingLedger<JsonValue>(args.storyId);
  const commit = ledger.receipts.find((candidate) => candidate.idempotencyKey === args.idempotencyKey) as PersistedCommitReceipt | undefined;
  if (!commit) return null;
  const signed = commit.findingLedgerReceipt;
  if (!signed
    || !verifyFindingLedgerReceipt(signed, ledgerTrust)
    || signed.operation !== FINDING_RUNTIME_EVIDENCE_ADAPTER_CONTRACT.appendOperation
    || commit.recordIds.length !== 1) {
    throw new Error('IDEMPOTENCY_CONFLICT: original runtime ledger receipt is invalid');
  }
  const record = ledger.records.find((candidate) => candidate.recordId === commit.recordIds[0]);
  if (!record || record.recordType !== 'runtime_evidence_receipt') {
    throw new Error('IDEMPOTENCY_CONFLICT: original runtime record is missing');
  }
  const runtimeReceipt = record.payload as unknown as RuntimeEvidenceReceipt;
  const exactRuntimeRequestDigest = canonicalHash({
    storyId: args.storyId,
    operation: FINDING_RUNTIME_EVIDENCE_ADAPTER_CONTRACT.appendOperation,
    idempotencyKey: args.idempotencyKey,
    records: [{
      recordType: 'runtime_evidence_receipt',
      payload: runtimeReceipt as unknown as JsonValue,
      uniqueBindingKey: `runtime-evidence-receipt:${runtimeReceipt.receiptId}`,
    }],
    casBindings: [],
  });
  if (signed.exactRequestDigest !== exactRuntimeRequestDigest
    || commit.exactRequestDigest !== signed.exactRequestDigest
    || signed.receiptId !== commit.receiptId
    || signed.idempotencyKey !== commit.idempotencyKey
    || canonicalJson(signed.recordIds) !== canonicalJson(commit.recordIds)
    || signed.priorLedgerDigest !== commit.priorLedgerDigest
    || signed.committedLedgerDigest !== commit.committedLedgerDigest
    || signed.writerSessionId !== commit.writerSessionId
    || signed.writerFenceToken !== commit.writerFenceToken
    || signed.committedAt !== commit.committedAt
    || signed.replayed !== false
    || commit.replayed !== false) {
    throw new Error('IDEMPOTENCY_CONFLICT: original runtime replay binding is invalid');
  }
  const verification = verifyRuntimeEvidenceCurrent(runtimeReceipt, expected);
  if (!verification.valid) {
    throw new Error(`IDEMPOTENCY_CONFLICT: original runtime receipt is not current (${verification.refusal})`);
  }
  return { runtimeReceipt, runtimeRecordId: record.recordId, ledgerReceipt: signed };
}

/**
 * Establish the complete local trust chain for a persisted runtime receipt.
 *
 * The runtime receipt's own signature is necessary but not sufficient: the
 * record carrying it must also be covered by an untampered, repository-key
 * signed ledger commit.  Keep this check public so adversarial tests can
 * exercise the exact production predicate rather than a look-alike.
 */
export function verifyRuntimeReceiptCarrier(
  ledger: LedgerEnvelope<JsonValue>,
  storyId: string,
  record: LedgerRecord<JsonValue>,
  trust: LedgerReceiptTrust,
): boolean {
  try {
    validateEnvelope(ledger);
    if (record.recordType !== 'runtime_evidence_receipt'
      || record.payloadHash !== canonicalHash(record.payload)) return false;
    const recordIndex = ledger.records.findIndex((candidate) => candidate.recordId === record.recordId);
    if (recordIndex < 0) return false;
    const carrier = ledger.receipts.find((candidate) => candidate.recordIds.includes(record.recordId)) as PersistedCommitReceipt | undefined;
    const receipt = carrier?.findingLedgerReceipt;
    if (!carrier || !receipt) return false;
    const carrierRecords = carrier.recordIds.map((recordId) => (
      ledger.records.find((candidate) => candidate.recordId === recordId)
    ));
    if (carrierRecords.some((candidate) => !candidate)) return false;
    const expectedCarrierRequestDigest = canonicalHash({
      operation: carrier.operation,
      idempotencyKey: carrier.idempotencyKey,
      records: carrierRecords.map((candidate) => ({
        recordType: candidate!.recordType,
        payload: candidate!.payload,
        ...(candidate!.uniqueBindingKey ? { uniqueBindingKey: candidate!.uniqueBindingKey } : {}),
      })),
      ledgerSchemaEpoch: ledger.ledgerSchemaEpoch,
      writerCapability: ledger.minimumWriterCapability,
    });
    if (receipt.storyId !== storyId
      || receipt.operation !== FINDING_RUNTIME_EVIDENCE_ADAPTER_CONTRACT.appendOperation
      || receipt.operation !== carrier.operation
      || receipt.receiptId !== carrier.receiptId
      || receipt.idempotencyKey !== carrier.idempotencyKey
      || carrier.requestDigest !== expectedCarrierRequestDigest
      || canonicalHash(receipt.recordIds) !== canonicalHash(carrier.recordIds)
      || receipt.priorLedgerDigest !== carrier.priorLedgerDigest
      || receipt.committedLedgerDigest !== carrier.committedLedgerDigest
      || receipt.writerSessionId !== carrier.writerSessionId
      || receipt.writerFenceToken !== carrier.writerFenceToken
      || receipt.committedAt !== carrier.committedAt
      || receipt.replayed !== false
      || typeof receipt.exactRequestDigest !== 'string'
      || receipt.exactRequestDigest !== carrier.exactRequestDigest
      || !receipt.recordIds.includes(record.recordId)
      || receipt.priorLedgerDigest !== record.priorDigest
      || receipt.committedLedgerDigest !== canonicalHash(ledger.records.slice(0, recordIndex + 1))
      || !verifyFindingLedgerReceipt(receipt, trust)) return false;
    return true;
  } catch {
    return false;
  }
}

function runtimeExpectedState(
  ctx: HandlerContext,
  args: Pick<FindingRuntimeEvidenceRunArgs, 'storyId' | 'buildCommand' | 'executionCommand' | 'environmentAllowlist' | 'excludedEnvironmentVariables' | 'compilerVersion' | 'storageCapability'>,
  trust: RuntimeReceiptTrust,
) {
  const headHash = currentGitHead(ctx.root);
  const sourceMaterialHash = currentMaterialHash(ctx.root, 'HEAD', ctx.root);
  if (!headHash || !sourceMaterialHash) throw new RuntimeEvidenceRefusal('source_stale', 'source identity is unavailable');
  return {
    storyId: args.storyId,
    headHash,
    sourceMaterialHash,
    buildPolicyDigest: RUNTIME_EVIDENCE_BUILD_POLICY_DIGEST,
    buildCommand: resolveRuntimeCommand(ctx.root, args.buildCommand),
    executionCommand: resolveRuntimeCommand(ctx.root, args.executionCommand),
    environment: runtimeEnvironment(args),
    toolchain: runtimeToolchain(args.compilerVersion),
    trust,
    blobStore: createRuntimeEvidenceBlobStore(ctx.root, args.storageCapability),
    artifactRoot: ctx.root,
    producer: 'finding_runtime_evidence_run',
  };
}

/** Historical reproduction only: never a current GREEN/runtime-freshness claim. */
export function readHistoricalFindingRuntimeEvidence(ctx: HandlerContext, storyId: string, receiptId: string) {
  const ledger = ctx.store.readFindingLedger<JsonValue>(storyId);
  const record = ledger.records.find(row => row.recordType === 'runtime_evidence_receipt'
    && (row.payload as unknown as RuntimeEvidenceReceipt).receiptId === receiptId);
  if (!record || !verifyRuntimeReceiptCarrier(ledger, storyId, record, findingLedgerTrustFromWorkspace(ctx.root))) throw new Error('runtime-evidence: trusted historical carrier missing');
  const receipt = record.payload as unknown as RuntimeEvidenceReceipt;
  if (!verifyRuntimeEvidenceReceiptSignature(receipt, runtimeTrustFromWorkspace(ctx.root))) throw new Error('runtime-evidence: historical signature invalid');
  const blobs = createRuntimeEvidenceBlobStore(ctx.root);
  for (const ref of [receipt.buildCommand, receipt.executionCommand, receipt.stdout, receipt.stderr, receipt.environment, receipt.artifactManifest]) {
    if (!blobs.get(ref)) throw new Error('runtime-evidence: historical blob missing');
  }
  return { receipt, record, stdout: blobs.get(receipt.stdout)!.toString('utf8') };
}

/** Read-only Story 3B port. Consumers cannot replace trust, command bytes or output. */
export function readCurrentFindingRuntimeEvidence(ctx: HandlerContext, storyId: string, receiptId: string) {
  return readFindingRuntimeEvidenceForReader(ctx, storyId, receiptId, false);
}

/** Closure reuse is narrower than a fresh execution claim. Only a clean,
 * material-identical descendant may retain the original execution HEAD;
 * environment, artifacts, toolchain, policy, blobs and key status are rechecked. */
export function readMaterialBoundRepairRuntimeEvidence(ctx: HandlerContext, storyId: string, receiptId: string) {
  return readFindingRuntimeEvidenceForReader(ctx, storyId, receiptId, true);
}
/** Re-attestation already executed at its bound material revision. A later
 * metadata-only commit may reuse it, never relabel it as a new execution. */
export function readMaterialBoundReattestationRuntimeEvidence(ctx: HandlerContext, storyId: string, receiptId: string) {
  return readFindingRuntimeEvidenceForReader(ctx, storyId, receiptId, true);
}
function readFindingRuntimeEvidenceForReader(ctx: HandlerContext, storyId: string, receiptId: string, closureReuse: boolean) {
  const ledger = ctx.store.readFindingLedger<JsonValue>(storyId);
  const record = ledger.records.find(row => row.recordType === 'runtime_evidence_receipt'
    && (row.payload as unknown as RuntimeEvidenceReceipt).receiptId === receiptId);
  if (!record || !verifyRuntimeReceiptCarrier(ledger, storyId, record, findingLedgerTrustFromWorkspace(ctx.root))) {
    throw new Error('runtime-evidence: trusted receipt carrier missing');
  }
  const receipt = record.payload as unknown as RuntimeEvidenceReceipt;
  const currentHead = currentGitHead(ctx.root) ?? '';
  const material = currentMaterialHash(ctx.root, 'HEAD', ctx.root) ?? '';
  if (closureReuse) {
    const dirty = readMaterialDirtyFiles(ctx.root, ctx.root);
    if (dirty.error || dirty.files.length || !material || receipt.sourceMaterialHash !== material) throw new Error('runtime-evidence: repair material stale');
    execFileSync('git', ['merge-base', '--is-ancestor', receipt.headHash, currentHead], { cwd: ctx.root, stdio: 'pipe' });
  }
  const blobStore = createRuntimeEvidenceBlobStore(ctx.root);
  const parse = (ref: RuntimeEvidenceReceipt['buildCommand']) => {
    const bytes = blobStore.get(ref); if (!bytes) throw new Error('runtime-evidence: command blob missing');
    return JSON.parse(bytes.toString('utf8'));
  };
  const environment = parse(receipt.environment) as Record<string, string>;
  const buildCommand = parse(receipt.buildCommand); const executionCommand = parse(receipt.executionCommand);
  const verified = verifyRuntimeEvidenceCurrent(receipt, {
    storyId, headHash: closureReuse ? receipt.headHash : currentHead, sourceMaterialHash: material,
    buildPolicyDigest: RUNTIME_EVIDENCE_BUILD_POLICY_DIGEST, buildCommand, executionCommand,
    environment: runtimeEnvironment({ environmentAllowlist: Object.keys(environment), excludedEnvironmentVariables: receipt.environment.excludedVariableNames }),
    toolchain: runtimeToolchain(receipt.toolchain.compilerVersion), trust: runtimeTrustFromWorkspace(ctx.root), blobStore,
    artifactRoot: ctx.root, producer: 'finding_runtime_evidence_run',
  });
  if (!verified.valid) throw new Error(`runtime-evidence: ${verified.refusal}`);
  const stdout = blobStore.get(receipt.stdout); if (!stdout) throw new Error('runtime-evidence: stdout missing');
  return { receipt, record, executionCommand, stdout: stdout.toString('utf8') };
}

export function createFindingLedgerHandlers(ctx: HandlerContext) {
  return {
    finding_ledger_query(args: FindingLedgerQueryArgs) {
      assertText(args.storyId, 'storyId');
      ctx.store.readStory(args.storyId);
      const signer = currentFindingLedgerSignerFromWorkspace(ctx.root);
      if (!signer) throw new FindingLedgerQueryRefusal('signing_key_unavailable');
      let registeredRuntimeKeys: FindingLedgerQueryTrustedKey[] = [];
      try {
        registeredRuntimeKeys = readRuntimeTrustRegistry(ctx.root).keys
          .filter((key) => key.status === 'fresh')
          .map(({ status: _status, ...key }) => key);
      } catch {
        // A ledger without runtime rows remains queryable. A ledger containing
        // a runtime row will fail closed below because no registered key can
        // validate it.
        registeredRuntimeKeys = [];
      }
      try {
        return queryFindingLedger(
          ctx.store.readFindingLedger<JsonValue>(args.storyId),
          args.storyId,
          signer,
          registeredRuntimeKeys,
        );
      } catch (error) {
        if (error instanceof FindingLedgerQueryRefusal) throw error;
        throw queryRefusalForEnvelope(error);
      }
    },

    finding_runtime_evidence_run(args: FindingRuntimeEvidenceRunArgs) {
      assertText(args.storyId, 'storyId');
      assertText(args.idempotencyKey, 'idempotencyKey');
      assertCwdInWorktree(ctx.store, args.storyId);
      ctx.store.readStory(args.storyId);
      if (args.buildInProgress || canonicalBuildLockInProgress(ctx.root)) {
        throw new RuntimeEvidenceRefusal('build_in_progress');
      }
      const timeoutMs = args.timeoutMs ?? 60_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
        throw new Error('timeoutMs must be an integer from 1 to 300000');
      }
      const run = () => withFindingRuntimeSource(ctx.root, args.sourceRef, executionRoot => withCanonicalBuildLock(executionRoot, () => {
      args.afterCanonicalBuildLockForTest?.();
      const signer = runtimeEvidenceSignerFromWorkspace(ctx.root);
      const ledgerSigner = findingLedgerSignerFromWorkspace(ctx.root);
      const ledgerTrust = currentFindingLedgerTrustFromWorkspace(ctx.root);
      if (!ledgerTrust) throw new RuntimeEvidenceRefusal('unknown_signing_key');
      const trust = runtimeTrustFromWorkspace(ctx.root);
      const expected = { ...runtimeExpectedState({ ...ctx, root: executionRoot }, args, trust),
        blobStore: createRuntimeEvidenceBlobStore(ctx.root, args.storageCapability) };
      const findingLockDir = ctx.store.storyFilePath(args.storyId, 'findings.lock');
      const replay = withMkdirLock(findingLockDir, () => runtimeReplay(ctx, args, ledgerTrust, expected), {
        label: 'runtime receipt replay lookup', requireHolderToken: true,
      });
      if (replay) {
        return {
          command: 'finding_runtime_evidence_run', persisted: true, replayed: true,
          runtimeReceiptId: replay.runtimeReceipt.receiptId,
          runtimeRecordId: replay.runtimeRecordId,
          ledgerReceiptId: replay.ledgerReceipt.receiptId,
          publicKey: signer.publicKey,
          receipt: replay.runtimeReceipt,
          ledgerReceipt: replay.ledgerReceipt,
        };
      }

      const buildLockDir = ctx.store.runtimeLockDirPath(args.storyId, 'build', 'runtime-evidence');
      return withMkdirLock(buildLockDir, () => {
        const childEnvironment = { ...expected.environment.values };
        const buildResult = runRuntimeCommand(expected.buildCommand, childEnvironment, timeoutMs);
        if (buildResult.exitCode !== 0) throw new Error('runtime-evidence: build_failed');
        const runtime = executeRuntimeEvidence({
          storyId: args.storyId,
          headHash: expected.headHash,
          sourceMaterialHash: expected.sourceMaterialHash,
          buildPolicyDigest: expected.buildPolicyDigest,
          buildCommand: expected.buildCommand,
          executionCommand: expected.executionCommand,
          environment: expected.environment,
          toolchain: expected.toolchain,
          producer: expected.producer,
          root: executionRoot,
          artifactInputs: args.artifactPaths.map((path) => ({ path, sourceHead: expected.headHash })),
          blobStore: expected.blobStore,
          receiptId: `rer_${canonicalDigest({ storyId: args.storyId, idempotencyKey: args.idempotencyKey }).slice(0, 32)}`,
          run: () => runRuntimeCommand(expected.executionCommand, childEnvironment, timeoutMs),
        }, signer);
        if (currentGitHead(executionRoot) !== expected.headHash
          || currentMaterialHash(executionRoot, 'HEAD', executionRoot) !== expected.sourceMaterialHash) {
          throw new RuntimeEvidenceRefusal('source_stale');
        }

        const identity = getSessionIdentity();
        const ownerLease = readOwnerLease(ctx.store.storyDirPath(args.storyId));
        const persisted = withMkdirLock(findingLockDir, () => {
          const lateReplay = runtimeReplay(ctx, args, ledgerTrust, expected);
          if (lateReplay) return lateReplay;
          const fence = captureMkdirLockFence(findingLockDir);
          const ledgerReceipt = appendRuntimeReceipt({
            storyId: args.storyId,
            store: ctx.store,
            idempotencyKey: args.idempotencyKey,
            runtimeReceipt: runtime.receipt,
            writerSessionId: identity.sessionId,
            writerLeaseId: ownerLease?.sessionId ?? identity.sessionId,
            writerFenceToken: fence.writerFenceToken,
            fence,
            signer: ledgerSigner,
            commitOptions: args.commitOptions,
          });
          return {
            runtimeReceipt: runtime.receipt,
            runtimeRecordId: ledgerReceipt.recordIds[0],
            ledgerReceipt,
          };
        }, { label: 'append runtime receipt', requireHolderToken: true });
        return {
          command: 'finding_runtime_evidence_run', persisted: true,
          replayed: persisted.runtimeReceipt !== runtime.receipt,
          runtimeReceiptId: persisted.runtimeReceipt.receiptId,
          runtimeRecordId: persisted.runtimeRecordId,
          ledgerReceiptId: persisted.ledgerReceipt.receiptId,
          publicKey: signer.publicKey,
          receipt: persisted.runtimeReceipt,
          ledgerReceipt: persisted.ledgerReceipt,
        };
      }, {
        label: 'runtime evidence build/execution',
        requireHolderToken: true,
        failFastIfHeld: true,
        heldMessage: 'runtime-evidence: build_in_progress',
      });
      }));
      // Historical worktrees isolate artifacts, but owner-side runtime/build
      // publication must still exclude a concurrent current-head producer.
      return args.sourceRef ? withCanonicalBuildLock(ctx.root, run) : run();
    },

    finding_runtime_evidence_verify(args: FindingRuntimeEvidenceVerifyArgs) {
      assertText(args.storyId, 'storyId');
      assertText(args.runtimeReceiptId, 'runtimeReceiptId');
      assertCwdInWorktree(ctx.store, args.storyId);
      ctx.store.readStory(args.storyId);
      const trust = runtimeTrustFromWorkspace(ctx.root);
      if (args.publicKey?.trim() && args.publicKey.trim() !== trust.publicKey) {
        throw new RuntimeEvidenceRefusal('unknown_signing_key');
      }
      if (args.keyStatus && args.keyStatus !== 'fresh') {
        throw new RuntimeEvidenceRefusal(args.keyStatus === 'expired' ? 'expired_signing_key'
          : args.keyStatus === 'revoked' ? 'revoked_signing_key' : 'unknown_signing_key');
      }
      const expected = runtimeExpectedState(ctx, args, trust);
      const ledger = ctx.store.readFindingLedger<JsonValue>(args.storyId);
      const record = ledger.records.find((candidate) => candidate.recordType === 'runtime_evidence_receipt'
        && (candidate.payload as unknown as RuntimeEvidenceReceipt).receiptId === args.runtimeReceiptId);
      if (!record) throw new Error('runtime-evidence: receipt_not_found');
      const ledgerTrust = findingLedgerTrustFromWorkspace(ctx.root);
      if (!verifyRuntimeReceiptCarrier(ledger, args.storyId, record, ledgerTrust)) {
        throw new RuntimeEvidenceRefusal('receipt_signature_invalid', 'runtime receipt carrier trust chain is invalid');
      }
      const receipt = record.payload as unknown as RuntimeEvidenceReceipt;
      const verification = verifyRuntimeEvidenceCurrent(receipt, expected);
      if (!verification.valid) throw new RuntimeEvidenceRefusal(verification.refusal ?? 'receipt_shape_invalid');
      return {
        command: 'finding_runtime_evidence_verify', verified: true,
        runtimeReceiptId: receipt.receiptId,
        runtimeRecordId: record.recordId,
        receiptHash: receipt.receiptHash,
      };
    },
  };
}

export function readFindingLedger<T = JsonValue>(file: string): LedgerEnvelope<T> { return readLedger<T>(file); }
export { canonicalHash, canonicalJson };
