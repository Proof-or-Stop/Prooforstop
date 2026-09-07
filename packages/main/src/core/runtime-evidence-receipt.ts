/**
 * Story 3B runtime evidence.
 *
 * This module proves only which command bytes ran against which source and
 * artifact bytes.  It intentionally has no Finding, lifecycle, or semantic
 * verdict dependency.  Blobs are content addressed before a receipt is
 * signed; verification is therefore useful even when a caller stores them in
 * an existing artifact/ledger transaction.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  canonicalDigest,
  canonicalJsonBytes,
  signCanonical,
  verifyCanonical,
} from './authority-signing.js';
import type {
  EvidenceBlobRef,
  RuntimeEvidenceContentType,
  RuntimeEvidenceReceipt,
} from './types.js';

export type {
  EvidenceBlobRef,
  RuntimeEvidenceContentType,
  RuntimeEvidenceReceipt,
} from './types.js';

export interface RuntimeReceiptSigner {
  privateKey: string;
  publicKey: string;
  keyId: string;
  trustRootDigest: string;
  keyFreshnessPolicyDigest: string;
  algorithm?: 'ed25519';
}

export interface RuntimeReceiptTrust {
  publicKey: string;
  keyId: string;
  algorithm: 'ed25519';
  trustRootDigest: string;
  keyFreshnessPolicyDigest: string;
  /** Optional key registry check for rotation/revocation/expiry. */
  keyIsFresh?: (keyId: string, policyDigest: string) => boolean;
  keyStatus?: 'fresh' | 'unknown' | 'revoked' | 'expired'
    | ((keyId: string, policyDigest: string) => 'fresh' | 'unknown' | 'revoked' | 'expired');
}

export type RuntimeEvidenceRefusalCode =
  | 'receipt_shape_invalid'
  | 'receipt_hash_mismatch'
  | 'receipt_signature_invalid'
  | 'unknown_signing_key'
  | 'revoked_signing_key'
  | 'expired_signing_key'
  | 'unsupported_algorithm'
  | 'unsupported_trust_root'
  | 'build_in_progress'
  | 'source_stale'
  | 'material_stale'
  | 'build_policy_stale'
  | 'build_command_stale'
  | 'execution_command_stale'
  | 'environment_stale'
  | 'toolchain_stale'
  | 'output_tampered'
  | 'blob_missing'
  | 'blob_digest_mismatch'
  | 'artifact_manifest_tampered'
  | 'artifact_stale'
  | 'artifact_mutated_during_execution'
  | 'artifact_mutated_after_execution'
  | 'realpath_policy_violation'
  | 'unsupported_storage';

export class RuntimeEvidenceRefusal extends Error {
  readonly code: RuntimeEvidenceRefusalCode;
  constructor(code: RuntimeEvidenceRefusalCode, message: string = code) {
    super(message);
    this.name = 'RuntimeEvidenceRefusal';
    this.code = code;
  }
}

export interface RuntimeEvidenceBlobStore {
  put(ref: EvidenceBlobRef, bytes: Buffer): void;
  get(ref: EvidenceBlobRef): Buffer | undefined;
}

/** Small deterministic store useful to adapters and tests; persistence belongs to the ledger/store layer. */
export class MemoryRuntimeEvidenceBlobStore implements RuntimeEvidenceBlobStore {
  private readonly blobs = new Map<string, Buffer>();
  put(ref: EvidenceBlobRef, bytes: Buffer): void { this.blobs.set(ref.blobId, Buffer.from(bytes)); }
  get(ref: EvidenceBlobRef): Buffer | undefined {
    const value = this.blobs.get(ref.blobId);
    return value ? Buffer.from(value) : undefined;
  }
}

export interface EnvironmentProjectionPolicy {
  allowlist: readonly string[];
  excludedVariableNames?: readonly string[];
  secretVariablePattern?: RegExp;
  policyDigest?: string;
}

export interface RedactedEnvironment {
  values: Record<string, string>;
  allowlistPolicyDigest: string;
  excludedVariableNames: string[];
  environmentDigest: string;
}

const HEX_DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DEFAULT_COMMAND_POLICY_DIGEST = canonicalDigest({ version: 1, keyOrder: 'unicode-code-point', arrays: 'ordered' });
const DEFAULT_REALPATH_POLICY_DIGEST = canonicalDigest({ version: 1, containment: 'realpath', paths: 'relative-posix' });
const DEFAULT_SECRET_PATTERN = /(?:pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential|auth)/i;

function digestBytes(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function textBytes(value: string): Buffer { return Buffer.from(value, 'utf8'); }
function requireDigest(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !HEX_DIGEST.test(value)) throw new RuntimeEvidenceRefusal('receipt_shape_invalid', `${name} must be a sha256 hex digest`);
}
function canonicalBytes(value: unknown): Buffer { return canonicalJsonBytes(value); }
function nowIso(): string { return new Date().toISOString(); }

function blobRef(type: RuntimeEvidenceContentType, bytes: Buffer, redactionPolicyDigest: string): EvidenceBlobRef {
  const contentDigest = digestBytes(bytes);
  return { blobId: `runtime-${contentDigest}`, contentDigest, contentType: type, redactionPolicyDigest };
}

function commandValue(command: string | { executable: string; args?: readonly string[]; cwd?: string; shell?: boolean; env?: Record<string, string> }): unknown {
  if (typeof command === 'string') return { command: command.trim() };
  return {
    executable: command.executable,
    args: [...(command.args ?? [])],
    ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    shell: command.shell === true,
    ...(command.env === undefined ? {} : { env: Object.fromEntries(Object.entries(command.env).sort()) }),
  };
}

export function canonicalizeRuntimeCommand(command: string | { executable: string; args?: readonly string[]; cwd?: string; shell?: boolean; env?: Record<string, string> }): Buffer {
  const value = commandValue(command);
  if (typeof command === 'string' && !command.trim()) throw new RuntimeEvidenceRefusal('receipt_shape_invalid', 'command must be non-empty');
  if (typeof command !== 'string' && (!command.executable || typeof command.executable !== 'string')) throw new RuntimeEvidenceRefusal('receipt_shape_invalid', 'command executable must be non-empty');
  return canonicalBytes(value);
}

export function redactEnvironment(
  environment: Record<string, string | undefined>,
  policy: EnvironmentProjectionPolicy,
): RedactedEnvironment {
  const allow = [...new Set(policy.allowlist)].sort();
  const excluded = [...new Set([...(policy.excludedVariableNames ?? []), ...Object.keys(environment).filter(name => (policy.secretVariablePattern ?? DEFAULT_SECRET_PATTERN).test(name))])].sort();
  const policyDigest = policy.policyDigest ?? canonicalDigest({ version: 1, allowlist: allow, excludedVariableNames: excluded });
  const values: Record<string, string> = {};
  for (const name of allow) {
    if (excluded.includes(name)) continue;
    const value = environment[name];
    if (value !== undefined) values[name] = value;
  }
  const environmentDigest = canonicalDigest(values);
  return { values, allowlistPolicyDigest: policyDigest, excludedVariableNames: excluded, environmentDigest };
}

export function createRuntimeEvidenceBlob(
  type: RuntimeEvidenceContentType,
  value: Buffer | string | unknown,
  redactionPolicyDigest = 'none',
): { ref: EvidenceBlobRef; bytes: Buffer } {
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : typeof value === 'string' ? textBytes(value) : canonicalBytes(value);
  return { ref: blobRef(type, bytes, redactionPolicyDigest), bytes };
}

export interface RuntimeArtifactInput {
  path: string;
  sourceHead: string;
  realpathPolicyDigest?: string;
}

interface RuntimeArtifactSnapshot {
  manifest: RuntimeEvidenceReceipt['artifacts'][number];
  realPath: string;
  fingerprint: string;
}

export function resolveContainedArtifact(root: string, artifactPath: string): { logicalPath: string; absolutePath: string; realPath: string } {
  // Never expose host paths in refusal messages.  Resolve both sides through
  // realpath before containment, so symlink escapes and `..` traversal fail
  // closed even when the logical path itself appears harmless.
  try {
    const rootReal = realpathSync(root);
    const absolutePath = resolve(rootReal, artifactPath);
    const realPath = realpathSync(absolutePath);
    const rel = relative(rootReal, realPath).split(sep).join('/');
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
      throw new RuntimeEvidenceRefusal('realpath_policy_violation');
    }
    return { logicalPath: rel, absolutePath, realPath };
  } catch (error) {
    if (error instanceof RuntimeEvidenceRefusal) throw error;
    throw new RuntimeEvidenceRefusal('realpath_policy_violation');
  }
}

export function captureArtifactManifest(root: string, artifacts: readonly RuntimeArtifactInput[]): RuntimeEvidenceReceipt['artifacts'] {
  return captureArtifactSnapshots(root, artifacts).map((snapshot) => snapshot.manifest);
}

function captureArtifactSnapshots(root: string, artifacts: readonly RuntimeArtifactInput[]): RuntimeArtifactSnapshot[] {
  if (!existsSync(root)) throw new RuntimeEvidenceRefusal('unsupported_storage', 'artifact root does not exist');
  const snapshots = artifacts.map((input) => {
    const resolved = resolveContainedArtifact(root, input.path);
    const stat = statSync(resolved.realPath, { bigint: true });
    if (!stat.isFile()) throw new RuntimeEvidenceRefusal('artifact_stale', `${resolved.logicalPath} is not a regular file`);
    return {
      manifest: {
        path: resolved.logicalPath,
        digest: digestBytes(readFileSync(resolved.realPath)),
        sourceHead: input.sourceHead,
        realpathPolicyDigest: input.realpathPolicyDigest ?? DEFAULT_REALPATH_POLICY_DIGEST,
      },
      realPath: resolved.realPath,
      fingerprint: canonicalDigest({
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
      }),
    };
  }).sort((a, b) => a.manifest.path.localeCompare(b.manifest.path));
  if (new Set(snapshots.map((snapshot) => snapshot.manifest.path)).size !== snapshots.length) {
    throw new RuntimeEvidenceRefusal('realpath_policy_violation', 'duplicate artifact realpath');
  }
  return snapshots;
}

function assertArtifactSnapshotsStable(
  root: string,
  snapshots: readonly RuntimeArtifactSnapshot[],
  phase: 'pre' | 'during' | 'post',
): void {
  const code = phase === 'during'
    ? 'artifact_mutated_during_execution'
    : phase === 'post'
      ? 'artifact_mutated_after_execution'
      : 'artifact_stale';
  try {
    for (const snapshot of snapshots) {
      const resolved = resolveContainedArtifact(root, snapshot.manifest.path);
      const stat = statSync(resolved.realPath, { bigint: true });
      const fingerprint = canonicalDigest({
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
      });
      if (resolved.realPath !== snapshot.realPath
        || digestBytes(readFileSync(resolved.realPath)) !== snapshot.manifest.digest
        || fingerprint !== snapshot.fingerprint) {
        throw new RuntimeEvidenceRefusal(code);
      }
    }
  } catch (error) {
    if (error instanceof RuntimeEvidenceRefusal && error.code === code) throw error;
    throw new RuntimeEvidenceRefusal(code);
  }
}

export function assertArtifactManifestStable(root: string, manifest: RuntimeEvidenceReceipt['artifacts'], phase: 'pre' | 'during' | 'post'): void {
  try {
    for (const entry of manifest) {
      const resolved = resolveContainedArtifact(root, entry.path);
      const currentDigest = digestBytes(readFileSync(resolved.realPath));
      if (resolved.logicalPath !== entry.path || currentDigest !== entry.digest) {
        throw new RuntimeEvidenceRefusal(phase === 'during' ? 'artifact_mutated_during_execution' : phase === 'post' ? 'artifact_mutated_after_execution' : 'artifact_stale', `artifact ${entry.path} changed`);
      }
    }
  } catch (error) {
    if (error instanceof RuntimeEvidenceRefusal) throw error;
    throw new RuntimeEvidenceRefusal(phase === 'during' ? 'artifact_mutated_during_execution' : phase === 'post' ? 'artifact_mutated_after_execution' : 'artifact_stale');
  }
}

function unsignedReceipt(receipt: RuntimeEvidenceReceipt): Omit<RuntimeEvidenceReceipt, 'receiptHash' | 'signature'> {
  const { receiptHash: _hash, signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

const RECEIPT_KEYS = [
  'algorithm', 'artifactManifest', 'artifacts', 'buildCommand', 'buildCommandDigest', 'buildPolicyDigest',
  'commandCanonicalizationPolicyDigest', 'completedAt', 'environment', 'environmentDigest', 'executionCommand',
  'executionCommandDigest', 'exitCode', 'headHash', 'keyFreshnessPolicyDigest', 'keyId', 'producer',
  'receiptHash', 'receiptId', 'schemaVersion', 'signature', 'sourceMaterialHash', 'startedAt', 'stderr',
  'stderrDigest', 'stdout', 'stdoutDigest', 'storyId', 'toolchain', 'trustRootDigest',
].sort();
const BLOB_KEYS = ['blobId', 'contentDigest', 'contentType', 'redactionPolicyDigest'].sort();

function exactKeys(value: object, keys: readonly string[]): boolean { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function validBlob(ref: EvidenceBlobRef, keys: readonly string[] = BLOB_KEYS): boolean {
  return exactKeys(ref, keys) && HEX_DIGEST.test(ref.blobId.replace(/^runtime-/, '')) && HEX_DIGEST.test(ref.contentDigest) && ref.blobId === `runtime-${ref.contentDigest}` && typeof ref.redactionPolicyDigest === 'string' && ref.redactionPolicyDigest.length > 0;
}

/** Verify every referenced blob, including the manifest bytes, before use. */
export function verifyRuntimeEvidenceReceiptBlobs(
  receipt: RuntimeEvidenceReceipt,
  store: RuntimeEvidenceBlobStore,
): boolean {
  try {
    const refs: EvidenceBlobRef[] = [
      receipt.buildCommand,
      receipt.executionCommand,
      receipt.stdout,
      receipt.stderr,
      receipt.environment,
      receipt.artifactManifest,
    ];
    if (!refs.every((ref) => {
      const bytes = store.get(ref);
      return bytes !== undefined && digestBytes(bytes) === ref.contentDigest && ref.blobId === `runtime-${ref.contentDigest}`;
    })) return false;
    if (receipt.buildCommandDigest !== receipt.buildCommand.contentDigest
      || receipt.executionCommandDigest !== receipt.executionCommand.contentDigest
      || receipt.stdoutDigest !== receipt.stdout.contentDigest
      || receipt.stderrDigest !== receipt.stderr.contentDigest
      || receipt.environmentDigest !== receipt.environment.contentDigest) return false;
    const manifestBytes = store.get(receipt.artifactManifest);
    if (!manifestBytes || digestBytes(manifestBytes) !== receipt.artifactManifest.contentDigest) return false;
    return manifestBytes.equals(canonicalBytes(receipt.artifacts));
  } catch {
    return false;
  }
}

export function signRuntimeEvidenceReceipt(receipt: Omit<RuntimeEvidenceReceipt, 'receiptHash' | 'signature'>, signer: RuntimeReceiptSigner): RuntimeEvidenceReceipt {
  if (!signer.privateKey || !signer.keyId || !signer.trustRootDigest || !signer.keyFreshnessPolicyDigest) throw new RuntimeEvidenceRefusal('receipt_shape_invalid', 'incomplete signer');
  const hash = canonicalDigest(receipt);
  return { ...receipt, receiptHash: hash, signature: signCanonical({ ...receipt, receiptHash: hash }, signer.privateKey) };
}

export function verifyRuntimeEvidenceReceiptSignature(receipt: RuntimeEvidenceReceipt, trust: RuntimeReceiptTrust | string): boolean {
  try {
    if (!exactKeys(receipt, RECEIPT_KEYS) || receipt.schemaVersion !== 1 || receipt.algorithm !== 'ed25519') return false;
    if (![receipt.receiptId, receipt.storyId, receipt.headHash, receipt.sourceMaterialHash, receipt.buildPolicyDigest, receipt.buildCommandDigest, receipt.executionCommandDigest, receipt.startedAt, receipt.completedAt, receipt.producer, receipt.keyId, receipt.trustRootDigest, receipt.keyFreshnessPolicyDigest, receipt.receiptHash, receipt.signature].every(value => typeof value === 'string' && value.length > 0)) return false;
    if (!GIT_OBJECT_HASH.test(receipt.headHash)
      || ![receipt.sourceMaterialHash, receipt.buildPolicyDigest, receipt.buildCommandDigest, receipt.executionCommandDigest, receipt.stdoutDigest, receipt.stderrDigest, receipt.environmentDigest, receipt.toolchain.toolchainDigest, receipt.commandCanonicalizationPolicyDigest, receipt.trustRootDigest, receipt.keyFreshnessPolicyDigest, receipt.receiptHash].every(value => HEX_DIGEST.test(value))) return false;
    if (!validBlob(receipt.buildCommand) || !validBlob(receipt.executionCommand) || !validBlob(receipt.stdout) || !validBlob(receipt.stderr) || !validBlob(receipt.artifactManifest) || !validBlob(receipt.environment, [...BLOB_KEYS, 'allowlistPolicyDigest', 'excludedVariableNames'])) return false;
    if (!Array.isArray(receipt.artifacts) || receipt.artifacts.some(item => !item || typeof item.path !== 'string' || isAbsolute(item.path) || item.path.split(/[\\/]/).includes('..') || !HEX_DIGEST.test(item.digest) || !GIT_OBJECT_HASH.test(item.sourceHead) || !HEX_DIGEST.test(item.realpathPolicyDigest))) return false;
    const key = typeof trust === 'string' ? { publicKey: trust, keyId: receipt.keyId, algorithm: 'ed25519' as const, trustRootDigest: receipt.trustRootDigest, keyFreshnessPolicyDigest: receipt.keyFreshnessPolicyDigest } : trust;
    if (receipt.keyId !== key.keyId || receipt.algorithm !== key.algorithm || receipt.trustRootDigest !== key.trustRootDigest || receipt.keyFreshnessPolicyDigest !== key.keyFreshnessPolicyDigest) return false;
    if (key.keyIsFresh && !key.keyIsFresh(receipt.keyId, receipt.keyFreshnessPolicyDigest)) return false;
    const keyStatus = typeof key.keyStatus === 'function'
      ? key.keyStatus(receipt.keyId, receipt.keyFreshnessPolicyDigest)
      : key.keyStatus;
    if (keyStatus !== undefined && keyStatus !== 'fresh') return false;
    if (canonicalDigest(unsignedReceipt(receipt)) !== receipt.receiptHash) return false;
    return verifyCanonical({ ...unsignedReceipt(receipt), receiptHash: receipt.receiptHash }, receipt.signature, key.publicKey);
  } catch { return false; }
}

export function verifyRuntimeEvidenceReceipt(receipt: RuntimeEvidenceReceipt, trust: RuntimeReceiptTrust | string): boolean {
  return verifyRuntimeEvidenceReceiptSignature(receipt, trust);
}

export interface RuntimeEvidenceExpectedState {
  storyId: string;
  headHash: string;
  sourceMaterialHash: string;
  buildPolicyDigest: string;
  buildCommand: RuntimeEvidenceReceiptInput['buildCommand'];
  executionCommand: RuntimeEvidenceReceiptInput['executionCommand'];
  environment: RedactedEnvironment;
  toolchain: RuntimeEvidenceReceipt['toolchain'];
  trust: RuntimeReceiptTrust;
  blobStore: RuntimeEvidenceBlobStore;
  artifactRoot: string;
  producer?: string;
}

export interface RuntimeEvidenceVerification {
  valid: boolean;
  refusal?: RuntimeEvidenceRefusalCode;
}

function signingKeyStatus(trust: RuntimeReceiptTrust, receipt: RuntimeEvidenceReceipt): 'fresh' | 'unknown' | 'revoked' | 'expired' {
  if (receipt.keyId !== trust.keyId) return 'unknown';
  const status = typeof trust.keyStatus === 'function'
    ? trust.keyStatus(receipt.keyId, receipt.keyFreshnessPolicyDigest)
    : trust.keyStatus;
  if (status) return status;
  if (trust.keyIsFresh && !trust.keyIsFresh(receipt.keyId, receipt.keyFreshnessPolicyDigest)) return 'revoked';
  return 'fresh';
}

/** Verify signature, immutable blobs, current source/policy state and current artifacts. */
export function verifyRuntimeEvidenceCurrent(
  receipt: RuntimeEvidenceReceipt,
  expected: RuntimeEvidenceExpectedState,
): RuntimeEvidenceVerification {
  const refuse = (refusal: RuntimeEvidenceRefusalCode): RuntimeEvidenceVerification => ({ valid: false, refusal });
  try {
    if (receipt.algorithm !== 'ed25519' || expected.trust.algorithm !== 'ed25519') return refuse('unsupported_algorithm');
    if (receipt.trustRootDigest !== expected.trust.trustRootDigest) return refuse('unsupported_trust_root');
    const status = signingKeyStatus(expected.trust, receipt);
    if (status === 'unknown') return refuse('unknown_signing_key');
    if (status === 'revoked') return refuse('revoked_signing_key');
    if (status === 'expired') return refuse('expired_signing_key');
    if (receipt.keyFreshnessPolicyDigest !== expected.trust.keyFreshnessPolicyDigest) return refuse('revoked_signing_key');
    if (canonicalDigest(unsignedReceipt(receipt)) !== receipt.receiptHash) return refuse('receipt_hash_mismatch');
    if (!verifyRuntimeEvidenceReceiptSignature(receipt, expected.trust)) return refuse('receipt_signature_invalid');

    const refs: Array<[EvidenceBlobRef, RuntimeEvidenceContentType]> = [
      [receipt.buildCommand, 'command'], [receipt.executionCommand, 'command'],
      [receipt.stdout, 'stdout'], [receipt.stderr, 'stderr'],
      [receipt.environment, 'environment'], [receipt.artifactManifest, 'artifact_manifest'],
    ];
    for (const [ref, contentType] of refs) {
      if (ref.contentType !== contentType) return refuse('blob_digest_mismatch');
      const bytes = expected.blobStore.get(ref);
      if (bytes === undefined) return refuse('blob_missing');
      if (digestBytes(bytes) !== ref.contentDigest || ref.blobId !== `runtime-${ref.contentDigest}`) {
        return refuse('blob_digest_mismatch');
      }
    }
    if (receipt.stdoutDigest !== receipt.stdout.contentDigest || receipt.stderrDigest !== receipt.stderr.contentDigest) {
      return refuse('output_tampered');
    }
    if (receipt.buildCommandDigest !== receipt.buildCommand.contentDigest
      || receipt.buildCommandDigest !== digestBytes(canonicalizeRuntimeCommand(expected.buildCommand))) {
      return refuse('build_command_stale');
    }
    if (receipt.executionCommandDigest !== receipt.executionCommand.contentDigest
      || receipt.executionCommandDigest !== digestBytes(canonicalizeRuntimeCommand(expected.executionCommand))) {
      return refuse('execution_command_stale');
    }
    if (receipt.environmentDigest !== receipt.environment.contentDigest
      || receipt.environmentDigest !== expected.environment.environmentDigest
      || receipt.environment.allowlistPolicyDigest !== expected.environment.allowlistPolicyDigest
      || canonicalDigest(receipt.environment.excludedVariableNames) !== canonicalDigest(expected.environment.excludedVariableNames)) {
      return refuse('environment_stale');
    }
    if (receipt.toolchain.toolchainDigest !== canonicalDigest({
      compilerVersion: receipt.toolchain.compilerVersion,
      runtimeVersion: receipt.toolchain.runtimeVersion,
    }) || canonicalDigest(receipt.toolchain) !== canonicalDigest(expected.toolchain)) return refuse('toolchain_stale');
    if (receipt.storyId !== expected.storyId || receipt.headHash !== expected.headHash
      || receipt.artifacts.some((artifact) => artifact.sourceHead !== expected.headHash)) return refuse('source_stale');
    if (receipt.sourceMaterialHash !== expected.sourceMaterialHash) return refuse('material_stale');
    if (receipt.buildPolicyDigest !== expected.buildPolicyDigest) return refuse('build_policy_stale');
    if (expected.producer !== undefined && receipt.producer !== expected.producer) return refuse('receipt_shape_invalid');

    const manifestBytes = expected.blobStore.get(receipt.artifactManifest);
    if (!manifestBytes || !manifestBytes.equals(canonicalBytes(receipt.artifacts))) {
      return refuse('artifact_manifest_tampered');
    }
    if (receipt.artifacts.some((artifact) => artifact.realpathPolicyDigest !== DEFAULT_REALPATH_POLICY_DIGEST)) {
      return refuse('realpath_policy_violation');
    }
    assertArtifactManifestStable(expected.artifactRoot, receipt.artifacts, 'pre');
    return { valid: true };
  } catch (error) {
    if (error instanceof RuntimeEvidenceRefusal) return refuse(error.code);
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('unsupported_storage')) return refuse('unsupported_storage');
    if (message.includes('blob_digest_mismatch')) return refuse('blob_digest_mismatch');
    return refuse('receipt_shape_invalid');
  }
}

export interface RuntimeEvidenceReceiptInput {
  storyId: string;
  headHash: string;
  sourceMaterialHash: string;
  buildPolicyDigest: string;
  buildCommand: string | { executable: string; args?: readonly string[]; cwd?: string; shell?: boolean; env?: Record<string, string> };
  executionCommand: string | { executable: string; args?: readonly string[]; cwd?: string; shell?: boolean; env?: Record<string, string> };
  stdout: Buffer | string;
  stderr: Buffer | string;
  environment: RedactedEnvironment;
  artifacts: RuntimeEvidenceReceipt['artifacts'];
  startedAt: string;
  completedAt: string;
  exitCode: number;
  toolchain: RuntimeEvidenceReceipt['toolchain'];
  producer: string;
  commandCanonicalizationPolicyDigest?: string;
  blobStore?: RuntimeEvidenceBlobStore;
  receiptId?: string;
}

export function createRuntimeEvidenceReceipt(input: RuntimeEvidenceReceiptInput, signer: RuntimeReceiptSigner): RuntimeEvidenceReceipt {
  if (!input.storyId || !input.producer || !input.startedAt || !input.completedAt) throw new RuntimeEvidenceRefusal('receipt_shape_invalid', 'receipt identity and timing are required');
  if (!GIT_OBJECT_HASH.test(input.headHash) || ![input.sourceMaterialHash, input.buildPolicyDigest].every(value => HEX_DIGEST.test(value))) throw new RuntimeEvidenceRefusal('receipt_shape_invalid', 'source and policy fields are invalid');
  if (input.artifacts.some((artifact) => artifact.sourceHead !== input.headHash)) throw new RuntimeEvidenceRefusal('source_stale', 'artifact source head differs from receipt source head');
  if (input.toolchain.toolchainDigest !== canonicalDigest({ compilerVersion: input.toolchain.compilerVersion, runtimeVersion: input.toolchain.runtimeVersion })) throw new RuntimeEvidenceRefusal('toolchain_stale');
  if (input.exitCode % 1 !== 0 || !Number.isSafeInteger(input.exitCode)) throw new RuntimeEvidenceRefusal('receipt_shape_invalid', 'exitCode must be an integer');
  const commandPolicy = input.commandCanonicalizationPolicyDigest ?? DEFAULT_COMMAND_POLICY_DIGEST;
  const buildBytes = canonicalizeRuntimeCommand(input.buildCommand);
  const executionBytes = canonicalizeRuntimeCommand(input.executionCommand);
  const build = createRuntimeEvidenceBlob('command', buildBytes, commandPolicy);
  const execution = createRuntimeEvidenceBlob('command', executionBytes, commandPolicy);
  const stdout = createRuntimeEvidenceBlob('stdout', input.stdout, 'none');
  const stderr = createRuntimeEvidenceBlob('stderr', input.stderr, 'none');
  const envBytes = canonicalBytes(input.environment.values);
  const env = createRuntimeEvidenceBlob('environment', envBytes, input.environment.allowlistPolicyDigest);
  const environment = { ...env.ref, allowlistPolicyDigest: input.environment.allowlistPolicyDigest, excludedVariableNames: [...input.environment.excludedVariableNames].sort() };
  const manifest = createRuntimeEvidenceBlob('artifact_manifest', input.artifacts, 'none');
  const store = input.blobStore;
  for (const item of [[build, buildBytes], [execution, executionBytes], [stdout, Buffer.isBuffer(input.stdout) ? input.stdout : textBytes(input.stdout)], [stderr, Buffer.isBuffer(input.stderr) ? input.stderr : textBytes(input.stderr)], [env, envBytes], [manifest, canonicalBytes(input.artifacts)] ] as const) store?.put(item[0].ref, item[1]);
  return signRuntimeEvidenceReceipt({
    schemaVersion: 1, receiptId: input.receiptId ?? `rer_${Date.now().toString(36)}_${process.pid.toString(36)}_${digestBytes(canonicalBytes({ storyId: input.storyId, startedAt: input.startedAt })).slice(0, 16)}`,
    storyId: input.storyId, headHash: input.headHash, sourceMaterialHash: input.sourceMaterialHash, buildPolicyDigest: input.buildPolicyDigest,
    buildCommandDigest: build.ref.contentDigest, executionCommandDigest: execution.ref.contentDigest, buildCommand: build.ref, executionCommand: execution.ref,
    stdout: stdout.ref, stderr: stderr.ref, environment, artifactManifest: manifest.ref, artifacts: input.artifacts.map(item => ({ ...item })),
    startedAt: input.startedAt, completedAt: input.completedAt, exitCode: input.exitCode, stdoutDigest: stdout.ref.contentDigest, stderrDigest: stderr.ref.contentDigest,
    environmentDigest: input.environment.environmentDigest, toolchain: input.toolchain, commandCanonicalizationPolicyDigest: commandPolicy,
    producer: input.producer, keyId: signer.keyId, algorithm: signer.algorithm ?? 'ed25519', trustRootDigest: signer.trustRootDigest, keyFreshnessPolicyDigest: signer.keyFreshnessPolicyDigest,
  }, signer);
}

export interface RuntimeEvidenceExecutionResult { receipt: RuntimeEvidenceReceipt; stdout: Buffer; stderr: Buffer; exitCode: number; preStable: true; duringStable: true; postStable: true; }
export interface RuntimeEvidenceExecutionOptions extends Omit<RuntimeEvidenceReceiptInput, 'stdout' | 'stderr' | 'exitCode' | 'startedAt' | 'completedAt' | 'artifacts'> {
  root: string;
  artifactInputs: readonly RuntimeArtifactInput[];
  run: () => { stdout: Buffer | string; stderr: Buffer | string; exitCode: number };
  buildInProgress?: boolean;
  /** Optional durability/barrier callback between during-run and post-run checks. */
  postRunStabilityBarrier?: () => void;
}

/** Execute an already policy-authorized callback with pre/during/post artifact checks. */
export function executeRuntimeEvidence(options: RuntimeEvidenceExecutionOptions, signer: RuntimeReceiptSigner): RuntimeEvidenceExecutionResult {
  if (options.buildInProgress) throw new RuntimeEvidenceRefusal('build_in_progress', 'build is in progress');
  const snapshots = captureArtifactSnapshots(options.root, options.artifactInputs);
  const artifacts = snapshots.map((snapshot) => snapshot.manifest);
  assertArtifactSnapshotsStable(options.root, snapshots, 'pre');
  const startedAt = nowIso();
  const result = options.run();
  assertArtifactSnapshotsStable(options.root, snapshots, 'during');
  const completedAt = nowIso();
  options.postRunStabilityBarrier?.();
  assertArtifactSnapshotsStable(options.root, snapshots, 'post');
  const receipt = createRuntimeEvidenceReceipt({ ...options, artifacts, startedAt, completedAt, stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr), exitCode: result.exitCode }, signer);
  return { receipt, stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr), exitCode: result.exitCode, preStable: true, duringStable: true, postStable: true };
}

export const RUNTIME_COMMAND_CANONICALIZATION_POLICY_DIGEST = DEFAULT_COMMAND_POLICY_DIGEST;
export const RUNTIME_REALPATH_POLICY_DIGEST = DEFAULT_REALPATH_POLICY_DIGEST;
