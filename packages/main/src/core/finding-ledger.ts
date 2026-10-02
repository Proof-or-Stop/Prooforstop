/**
 * Schema-neutral, fenced append ledger primitives.
 *
 * Durable records remain payload-schema-neutral: callers decide how an opaque
 * payload is interpreted. This layer also owns the signed commit-receipt and
 * registered local trust primitives needed by core projections.
 */

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID, createHash, createPublicKey } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import {
  canonicalDigest,
  exportPublicKeyRaw,
  importPrivateKeyRaw,
  signCanonical,
  verifyCanonical,
} from "./authority-signing.js";
import type { FindingLedgerOperation, FindingLedgerReceipt } from "./types.js";
import { PROOF_OR_STOP_DIR } from "./proof-or-stop-paths.js";
import { observedGit } from "./git-tree-observation.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const FINDING_LEDGER_SCHEMA_EPOCH = 1;
export const FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY = "finding-ledger-writer-v1";
export const FINDING_LEDGER_LOCAL_FS_CAPABILITY = "canonical-local-fs-v1";
export const FINDING_LEDGER_KEY_FRESHNESS_POLICY_DIGEST = canonicalDigest({
  version: 1,
  registry: "git-common-dir-current-key",
  rotation: "replacement-invalidates-prior-current-key",
});

const FINDING_LEDGER_KEY_FILE = "proof-or-stop-finding-ledger-v1.key";

export interface FindingLedgerSigner {
  privateKey: string;
  publicKey: string;
  keyId: string;
  trustRootDigest: string;
  keyFreshnessPolicyDigest: string;
}

export interface FindingLedgerReceiptTrust extends Omit<FindingLedgerSigner, "privateKey"> {
  algorithm: "ed25519";
}

function gitCommonDir(workspaceRoot: string): string | undefined {
  try {
    const raw = observedGit(workspaceRoot, ["rev-parse", "--git-common-dir"], () => execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })).trim();
    return path.isAbsolute(raw) ? raw : path.resolve(workspaceRoot, raw);
  } catch {
    return undefined;
  }
}

/**
 * The current signing key lives in the git common dir so every linked worktree
 * of one repository shares it. A workspace that is not a git repository (smoke
 * fixtures, scratch projects) has no worktrees to share with, so its key is
 * kept in the workspace's own Proof-or-Stop state dir instead of failing.
 */
function findingLedgerKeyPath(workspaceRoot: string): string {
  const commonDir = gitCommonDir(workspaceRoot);
  if (commonDir) return path.join(commonDir, FINDING_LEDGER_KEY_FILE);
  return path.join(workspaceRoot, PROOF_OR_STOP_DIR, "keys", FINDING_LEDGER_KEY_FILE);
}

function trustFromPrivateKey(privateKey: string): FindingLedgerReceiptTrust {
  const publicKey = exportPublicKeyRaw(createPublicKey(importPrivateKeyRaw(privateKey)));
  return {
    publicKey,
    keyId: `finding-ledger-${canonicalDigest({ publicKey }).slice(0, 24)}`,
    algorithm: "ed25519",
    trustRootDigest: canonicalDigest({ profile: "finding-ledger-local-trust-root-v1", publicKey }),
    keyFreshnessPolicyDigest: FINDING_LEDGER_KEY_FRESHNESS_POLICY_DIGEST,
  };
}

/** Current registered trust without creating or rotating key material on a read path. */
export function currentFindingLedgerTrustFromWorkspace(
  workspaceRoot: string,
): FindingLedgerReceiptTrust | undefined {
  const signer = currentFindingLedgerSignerFromWorkspace(workspaceRoot);
  if (!signer) return undefined;
  const { privateKey: _privateKey, ...trust } = signer;
  return { ...trust, algorithm: "ed25519" };
}

/** Current signer without creating directories or key material on a read path. */
export function currentFindingLedgerSignerFromWorkspace(
  workspaceRoot: string,
): FindingLedgerSigner | undefined {
  const keyPath = findingLedgerKeyPath(workspaceRoot);
  if (!existsSync(keyPath)) return undefined;
  try {
    const privateKey = readFileSync(keyPath, "utf8").trim();
    if (!privateKey) return undefined;
    const trust = trustFromPrivateKey(privateKey);
    return {
      privateKey,
      publicKey: trust.publicKey,
      keyId: trust.keyId,
      trustRootDigest: trust.trustRootDigest,
      keyFreshnessPolicyDigest: trust.keyFreshnessPolicyDigest,
    };
  } catch {
    return undefined;
  }
}

/** Registered local non-authority signer shared by every worktree of one repo. */
export function findingLedgerSignerFromWorkspace(workspaceRoot: string): FindingLedgerSigner {
  const keyPath = findingLedgerKeyPath(workspaceRoot);
  if (!existsSync(keyPath)) {
    mkdirSync(path.dirname(keyPath), { recursive: true });
    try {
      writeFileSync(keyPath, `${randomBytes(32).toString("base64")}\n`, {
        encoding: "utf8", mode: 0o600, flag: "wx",
      });
    } catch (error) {
      if (!existsSync(keyPath)) throw error;
    }
  }
  const privateKey = readFileSync(keyPath, "utf8").trim();
  const trust = trustFromPrivateKey(privateKey);
  return {
    privateKey,
    publicKey: trust.publicKey,
    keyId: trust.keyId,
    trustRootDigest: trust.trustRootDigest,
    keyFreshnessPolicyDigest: trust.keyFreshnessPolicyDigest,
  };
}

export function findingLedgerTrustFromWorkspace(workspaceRoot: string): FindingLedgerReceiptTrust {
  const trust = currentFindingLedgerTrustFromWorkspace(workspaceRoot);
  if (!trust) throw new Error("finding-ledger: signing_key_unavailable");
  return trust;
}

export interface LedgerRecord<T = JsonValue> {
  recordId: string;
  recordType: string;
  idempotencyKey: string;
  uniqueBindingKey?: string;
  payload: T;
  payloadHash: string;
  priorDigest: string;
  ledgerSchemaEpoch: number;
  writerCapability: string;
  createdAt: string;
}

export interface LedgerEnvelope<T = JsonValue> {
  schemaVersion: "finding-ledger.v1";
  ledgerSchemaEpoch: number;
  minimumWriterCapability: string;
  committedLedgerDigest: string;
  records: LedgerRecord<T>[];
  receipts: LedgerCommitReceipt[];
}

export interface LedgerRecordInput<T = JsonValue> {
  recordType: string;
  payload: T;
  uniqueBindingKey?: string;
}

export interface AppendRequest<T = JsonValue> {
  operation: string;
  idempotencyKey: string;
  records: LedgerRecordInput<T>[];
  ledgerSchemaEpoch: number;
  writerCapability: string;
  writerSessionId: string;
  writerFenceToken: string;
  expectedPriorLedgerDigest?: string;
  storageCapability: string;
}

export interface AppendPlan<T = JsonValue> {
  action: "append" | "replay";
  records: LedgerRecord<T>[];
  receipt: LedgerCommitReceipt;
  envelope: LedgerEnvelope<T>;
}

/**
 * CHK-002's persistence acknowledgement. It is intentionally unsigned and is
 * not the public FindingLedgerReceipt contract owned by CHK-003.
 */
export interface LedgerCommitReceipt {
  receiptId: string;
  operation: string;
  idempotencyKey: string;
  requestDigest: string;
  recordIds: string[];
  priorLedgerDigest: string;
  committedLedgerDigest: string;
  writerSessionId: string;
  writerFenceToken: string;
  committedAt: string;
  replayed: boolean;
}

export interface LedgerFence {
  writerFenceToken: string;
  assertCurrent(): void;
  publishAtomically<R>(publish: () => R): R;
}

export interface DurableCommitTrace {
  fsyncFile: boolean;
  atomicRename: boolean;
  fsyncDirectory: boolean;
}

export interface AppendLedgerOptions {
  beforeRename?: () => void;
  trace?: DurableCommitTrace;
}

export class LedgerRefusal extends Error {
  readonly code:
    | "STALE_FENCE"
    | "SCHEMA_EPOCH_UNSUPPORTED"
    | "CAPABILITY_TOO_OLD"
    | "STORAGE_CAPABILITY_UNSUPPORTED"
    | "CAS_CONFLICT"
    | "IDEMPOTENCY_CONFLICT"
    | "IMMUTABLE_BINDING_CONFLICT";
  constructor(code: LedgerRefusal["code"], message: string) {
    super(message);
    this.name = "LedgerRefusal";
    this.code = code;
  }
}

export class StaleFenceRefusal extends LedgerRefusal {
  constructor(message = "writer ledger epoch is stale") { super("STALE_FENCE", message); }
}

export class CapabilityRefusal extends LedgerRefusal {
  constructor(message = "writer capability is below the ledger minimum") { super("CAPABILITY_TOO_OLD", message); }
}

const EMPTY_DIGEST = createHash("sha256").update("[]").digest("hex");

/** JSON canonicalization sufficient for schema-neutral JSON values. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== undefined) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new TypeError("ledger payload must be JSON-compatible");
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function unsignedFindingLedgerReceipt(
  receipt: FindingLedgerReceipt,
): Omit<FindingLedgerReceipt, "receiptHash" | "signature"> {
  const { receiptHash: _hash, signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

const FINDING_LEDGER_RECEIPT_KEYS = [
  "schemaVersion", "ledgerSchemaEpoch", "minimumWriterCapability", "receiptId", "storyId",
  "idempotencyKey", "operation", "recordIds", "casBindings", "priorLedgerDigest",
  "committedLedgerDigest", "replayed", "committedAt", "writerSessionId", "writerLeaseId",
  "writerFenceToken", "keyId", "algorithm", "trustRootDigest", "keyFreshnessPolicyDigest",
  "receiptHash", "signature",
].sort();
const FINDING_LEDGER_RECEIPT_EXACT_REQUEST_KEYS = [
  ...FINDING_LEDGER_RECEIPT_KEYS,
  "exactRequestDigest",
].sort();
const FINDING_LEDGER_CAS_KEYS = [
  "recordType", "expectedRecordId", "expectedRecordHash", "observedChainHeadId",
  "observedChainHeadHash", "predicateDigest",
].sort();
const FINDING_LEDGER_OPERATIONS = new Set<FindingLedgerOperation>([
  "append_review_remediation", "append_finding", "append_finding_projection", "append_finding_lifecycle_transition",
  "append_legacy_identity_binding", "append_detector_signal",
  "append_candidate_route", "append_candidate", "append_assessment_proposal",
  "append_assessment", "append_mandatory_repair", "append_deferral_expiry_policy",
  "append_deferral", "append_route_receipt", "append_progress_baseline_set",
  "append_material_drift_reattestation", "append_runtime_receipt",
  "append_canonical_defect_supersession", "append_canonical_defect",
  "append_supersession", "apply_manifest",
]);

function hasExactKeys(value: object, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

export function signFindingLedgerReceipt(
  receipt: Omit<FindingLedgerReceipt, "receiptHash" | "signature">,
  signer: FindingLedgerSigner,
): FindingLedgerReceipt {
  if (!signer.privateKey.trim()) throw new Error("signer.privateKey must be a non-empty string");
  const receiptHash = canonicalHash(receipt);
  return {
    ...receipt,
    receiptHash,
    signature: signCanonical({ ...receipt, receiptHash }, signer.privateKey),
  };
}

export function verifyFindingLedgerReceipt(
  receipt: FindingLedgerReceipt,
  trust: string | FindingLedgerReceiptTrust,
): boolean {
  try {
    if ((!hasExactKeys(receipt, FINDING_LEDGER_RECEIPT_KEYS)
      && !hasExactKeys(receipt, FINDING_LEDGER_RECEIPT_EXACT_REQUEST_KEYS))
      || !receipt.casBindings.every((binding) => hasExactKeys(binding, FINDING_LEDGER_CAS_KEYS))) return false;
    const publicKey = typeof trust === "string" ? trust : trust.publicKey;
    if (typeof trust !== "string" && (
      receipt.keyId !== trust.keyId
      || receipt.algorithm !== trust.algorithm
      || receipt.trustRootDigest !== trust.trustRootDigest
      || receipt.keyFreshnessPolicyDigest !== trust.keyFreshnessPolicyDigest
    )) return false;
    if (receipt.schemaVersion !== 1 || receipt.ledgerSchemaEpoch !== FINDING_LEDGER_SCHEMA_EPOCH
      || receipt.minimumWriterCapability !== FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY
      || receipt.algorithm !== "ed25519"
      || !FINDING_LEDGER_OPERATIONS.has(receipt.operation)
      || (receipt.exactRequestDigest !== undefined && !/^[0-9a-f]{64}$/.test(receipt.exactRequestDigest))
      || !receipt.recordIds.length
      || new Set(receipt.recordIds).size !== receipt.recordIds.length
      || [
        receipt.receiptId, receipt.storyId, receipt.idempotencyKey, receipt.priorLedgerDigest,
        receipt.committedLedgerDigest, receipt.committedAt, receipt.writerSessionId,
        receipt.writerLeaseId, receipt.writerFenceToken, receipt.keyId, receipt.trustRootDigest,
        receipt.keyFreshnessPolicyDigest, receipt.receiptHash, receipt.signature,
      ].some((value) => typeof value !== "string" || !value.trim())
      || receipt.casBindings.some((binding) => Object.values(binding).some((value) => !value.trim()))
      || receipt.receiptHash !== canonicalHash(unsignedFindingLedgerReceipt(receipt))) return false;
    return verifyCanonical(
      { ...unsignedFindingLedgerReceipt(receipt), receiptHash: receipt.receiptHash },
      receipt.signature,
      publicKey,
    );
  } catch {
    return false;
  }
}

/** IDs contain no array-length/ordinal component and remain unique across writers. */
export function allocateRecordId(now = Date.now()): string {
  return `lr_${now.toString(36)}_${process.pid.toString(36)}_${randomUUID().replaceAll("-", "")}`;
}

export function allocateReceiptId(now = Date.now()): string {
  return `lrc_${now.toString(36)}_${process.pid.toString(36)}_${randomUUID().replaceAll("-", "")}`;
}

export function emptyLedger<T = JsonValue>(): LedgerEnvelope<T> {
  return {
    schemaVersion: "finding-ledger.v1",
    ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH,
    minimumWriterCapability: FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY,
    committedLedgerDigest: EMPTY_DIGEST,
    records: [],
    receipts: [],
  };
}

function requestDigest<T>(request: AppendRequest<T>): string {
  return canonicalHash({
    operation: request.operation,
    idempotencyKey: request.idempotencyKey,
    records: request.records,
    ledgerSchemaEpoch: request.ledgerSchemaEpoch,
    writerCapability: request.writerCapability,
  });
}

export function planAppend<T>(current: LedgerEnvelope<T>, request: AppendRequest<T>): AppendPlan<T> {
  validateWriter(current, request);
  const digest = requestDigest(request);
  const priorLedgerDigest = current.committedLedgerDigest;
  const existingReceipt = current.receipts.find((receipt) => receipt.idempotencyKey === request.idempotencyKey);
  if (existingReceipt) {
    if (existingReceipt.requestDigest !== digest || existingReceipt.operation !== request.operation) {
      throw new LedgerRefusal("IDEMPOTENCY_CONFLICT", "idempotency key is bound to different transaction bytes");
    }
    const replayRecords = existingReceipt.recordIds.map((recordId) => {
      const record = current.records.find((candidate) => candidate.recordId === recordId);
      if (!record) throw new Error(`ledger receipt references missing record ${recordId}`);
      return record;
    });
    return {
      action: "replay",
      records: replayRecords,
      receipt: { ...existingReceipt, replayed: true },
      envelope: current,
    };
  }
  if (
    request.expectedPriorLedgerDigest !== undefined
    && request.expectedPriorLedgerDigest !== priorLedgerDigest
  ) {
    throw new LedgerRefusal("CAS_CONFLICT", "expected prior ledger digest does not match");
  }

  const now = new Date().toISOString();
  const planned: LedgerRecord<T>[] = [];
  for (const input of request.records) {
    const payloadHash = canonicalHash(input.payload);
    const bound = input.uniqueBindingKey
      ? [...current.records, ...planned].find((record) => record.uniqueBindingKey === input.uniqueBindingKey)
      : undefined;
    if (bound) {
      if (bound.recordType !== input.recordType || bound.payloadHash !== payloadHash) {
        throw new LedgerRefusal(
          "IMMUTABLE_BINDING_CONFLICT",
          `immutable binding ${input.uniqueBindingKey} is already bound to different bytes`,
        );
      }
      planned.push(bound);
      continue;
    }
    planned.push({
      recordId: allocateRecordId(),
      recordType: input.recordType,
      idempotencyKey: request.idempotencyKey,
      ...(input.uniqueBindingKey ? { uniqueBindingKey: input.uniqueBindingKey } : {}),
      payload: input.payload,
      payloadHash,
      priorDigest: current.committedLedgerDigest,
      ledgerSchemaEpoch: request.ledgerSchemaEpoch,
      writerCapability: request.writerCapability,
      createdAt: now,
    });
  }
  const newRecords = planned.filter(
    (record) => !current.records.some((currentRecord) => currentRecord.recordId === record.recordId),
  );
  const records = [...current.records, ...newRecords];
  const committedLedgerDigest = records.length ? canonicalHash(records) : EMPTY_DIGEST;
  const receipt: LedgerCommitReceipt = {
    receiptId: allocateReceiptId(),
    operation: request.operation,
    idempotencyKey: request.idempotencyKey,
    requestDigest: digest,
    recordIds: planned.map((record) => record.recordId),
    priorLedgerDigest,
    committedLedgerDigest,
    writerSessionId: request.writerSessionId,
    writerFenceToken: request.writerFenceToken,
    committedAt: now,
    replayed: false,
  };
  return {
    action: "append",
    records: planned,
    receipt,
    envelope: {
      ...current,
      committedLedgerDigest,
      records,
      receipts: [...current.receipts, receipt],
    },
  };
}

export function validateWriter<T>(ledger: LedgerEnvelope<T>, request: AppendRequest<T>): void {
  if (request.storageCapability !== FINDING_LEDGER_LOCAL_FS_CAPABILITY) {
    throw new LedgerRefusal(
      "STORAGE_CAPABILITY_UNSUPPORTED",
      `unsupported storage capability ${request.storageCapability}; only ${FINDING_LEDGER_LOCAL_FS_CAPABILITY} is supported`,
    );
  }
  if (request.ledgerSchemaEpoch !== FINDING_LEDGER_SCHEMA_EPOCH || request.ledgerSchemaEpoch !== ledger.ledgerSchemaEpoch) {
    throw new LedgerRefusal("SCHEMA_EPOCH_UNSUPPORTED", "writer ledger schema epoch is stale or unsupported");
  }
  if (request.writerCapability !== ledger.minimumWriterCapability) throw new CapabilityRefusal();
  if (!request.idempotencyKey.trim()) throw new LedgerRefusal("IDEMPOTENCY_CONFLICT", "idempotency key is required");
  if (!request.writerFenceToken.trim()) throw new StaleFenceRefusal("writer fence token is required");
}

export function validateEnvelope<T>(ledger: LedgerEnvelope<T>): void {
  if (
    ledger.schemaVersion !== "finding-ledger.v1"
    || !Number.isInteger(ledger.ledgerSchemaEpoch)
    || typeof ledger.minimumWriterCapability !== "string"
    || !Array.isArray(ledger.records)
    || !Array.isArray(ledger.receipts)
  ) {
    throw new Error("invalid ledger envelope");
  }
  const expected = ledger.records.length ? canonicalHash(ledger.records) : EMPTY_DIGEST;
  if (ledger.committedLedgerDigest !== expected) throw new Error("ledger chain digest mismatch");
  const ids = new Set<string>();
  const keys = new Set<string>();
  const bindingKeys = new Set<string>();
  const receiptIds = new Set<string>();
  for (const record of ledger.records) {
    if (!record.recordId || !record.priorDigest || !record.idempotencyKey || ids.has(record.recordId)) {
      throw new Error("ledger record identity is invalid or duplicated");
    }
    if (record.payloadHash !== canonicalHash(record.payload)) throw new Error("ledger payload hash mismatch");
    if (record.ledgerSchemaEpoch !== ledger.ledgerSchemaEpoch) throw new Error("ledger record schema epoch mismatch");
    if (record.writerCapability !== ledger.minimumWriterCapability) throw new Error("ledger record writer capability mismatch");
    if (record.uniqueBindingKey) {
      if (bindingKeys.has(record.uniqueBindingKey)) throw new Error("ledger immutable binding key is duplicated");
      bindingKeys.add(record.uniqueBindingKey);
    }
    ids.add(record.recordId);
  }
  for (const receipt of ledger.receipts) {
    if (
      !receipt.receiptId
      || !receipt.idempotencyKey
      || keys.has(receipt.idempotencyKey)
      || receiptIds.has(receipt.receiptId)
    ) {
      throw new Error("ledger receipt identity is invalid or duplicated");
    }
    if (receipt.replayed) throw new Error("persisted ledger receipt cannot be marked replayed");
    if (!/^[0-9a-f]{64}$/.test(receipt.requestDigest)) throw new Error("ledger receipt request digest is invalid");
    if (!receipt.writerFenceToken) throw new Error("ledger receipt fence token is missing");
    for (const recordId of receipt.recordIds) {
      if (!ids.has(recordId)) throw new Error(`ledger receipt references missing record ${recordId}`);
    }
    keys.add(receipt.idempotencyKey);
    receiptIds.add(receipt.receiptId);
  }
  const latest = ledger.receipts.at(-1);
  if (latest && latest.committedLedgerDigest !== ledger.committedLedgerDigest) {
    throw new Error("latest ledger receipt does not bind the committed ledger tip");
  }
}

export function readLedger<T = JsonValue>(file: string): LedgerEnvelope<T> {
  if (!existsSync(file)) return emptyLedger<T>();
  const value = JSON.parse(readFileSync(file, "utf8")) as LedgerEnvelope<T>;
  validateEnvelope(value);
  return value;
}

/** Remove interrupted temp files without touching the committed ledger. */
export function cleanupLedgerTemps(file: string): void {
  const directory = path.dirname(file);
  const prefix = `.${path.basename(file)}.`;
  const entries = existsSync(directory) ? readdirSync(directory) : [];
  for (const entry of entries) {
    if (entry.startsWith(prefix) && entry.endsWith(".tmp")) rmSync(path.join(directory, entry), { force: true });
  }
}

/** Durable replace: write+fsync temp, rename, then fsync the containing directory. */
export function writeLedgerAtomic<T>(
  file: string,
  envelope: LedgerEnvelope<T>,
  fence: LedgerFence,
  options: AppendLedgerOptions = {},
): DurableCommitTrace {
  validateEnvelope(envelope);
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true });
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const trace = options.trace ?? { fsyncFile: false, atomicRename: false, fsyncDirectory: false };
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    trace.fsyncFile = true;
  } finally {
    closeSync(fd);
  }
  try {
    JSON.parse(readFileSync(temp, "utf8"));
    options.beforeRename?.();
    fence.publishAtomically(() => {
      renameSync(temp, file);
      trace.atomicRename = true;
      const directoryFd = openSync(directory, "r");
      try {
        fsyncSync(directoryFd);
        trace.fsyncDirectory = true;
      } finally {
        closeSync(directoryFd);
      }
    });
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return trace;
}

export function recoverLedger<T = JsonValue>(file: string): LedgerEnvelope<T> {
  cleanupLedgerTemps(file);
  return readLedger<T>(file);
}

/**
 * Execute one already-serialized, fenced transaction. Callers must acquire the
 * existing canonical Finding or B-META main lock and pass its captured fence.
 */
export function appendLedgerTransaction<T = JsonValue>(
  file: string,
  request: AppendRequest<T>,
  fence: LedgerFence,
  options: AppendLedgerOptions = {},
): AppendPlan<T> {
  if (fence.writerFenceToken !== request.writerFenceToken) {
    throw new StaleFenceRefusal("request fence token does not match the acquired lock");
  }
  fence.assertCurrent();
  const current = recoverLedger<T>(file);
  const plan = planAppend(current, request);
  if (plan.action === "replay") return plan;
  writeLedgerAtomic(file, plan.envelope, fence, options);
  return plan;
}
