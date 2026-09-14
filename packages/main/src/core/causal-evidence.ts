import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  effectiveValidationCommandEnvironment,
  isValidationTransportEnvKey,
} from './validation-command-environment.js';
import {
  exportPublicKeyRaw,
  importPrivateKeyRaw,
  signCanonical,
  verifyCanonical,
  type PublicKeyBase64,
  type SignatureBase64,
} from './authority-signing.js';
import { resolveSharedLockRoot } from './validation-execution-lock.js';
import { PROOF_OR_STOP_CLI_VERSION } from './proof-or-stop-brand.js';

/**
 * CausalEvidence is deliberately a small, dependency-light boundary.  The
 * checklist and validator handlers adapt their existing stores/executors to
 * this API; the key, receipt, preflight, dependency, and metric rules live
 * here so a second caller cannot accidentally create a weaker identity.
 */
export const CAUSAL_EVIDENCE_SCHEMA = 'proof-or-stop.causal-evidence-receipt.v1' as const;
export const CAUSAL_EXECUTION_KEY_SCHEMA = 'proof-or-stop.causal-execution-key.v2' as const;
export const CAUSAL_EXECUTION_KEY_PREFIX = 'ce:v2:' as const;
export const CAUSAL_SELECTOR_POLICY_SCHEMA = 'proof-or-stop.causal-selector-policy.v1' as const;
export const CAUSAL_LEDGER_SCHEMA = 'proof-or-stop.causal-evidence-ledger.v1' as const;
export const CAUSAL_PREFLIGHT_SCHEMA = 'proof-or-stop.causal-evidence-preflight.v1' as const;
export const CAUSAL_DEPENDENCY_SCHEMA = 'proof-or-stop.causal-dependency-decision.v1' as const;
export const CAUSAL_EVIDENCE_INDEX_SCHEMA = 'proof-or-stop.causal-evidence-index.v1' as const;
export const CAUSAL_RECEIPT_DIRECTORY = 'causal-evidence/receipts';
export const CAUSAL_OUTPUT_DIRECTORY = 'causal-evidence/outputs';
export const CAUSAL_RECEIPT_INDEX_FILE = 'causal-evidence/index.json';
export const CAUSAL_AUTHORITY_KEY_FILE = 'proof-or-stop-causal-evidence-authority-v1.key';
export const CAUSAL_OUTPUT_TAIL_CHARS = 4_000;
export const CAUSAL_MAX_OUTPUT_CHARS = 12_000;
export const CAUSAL_SELECTOR_OUTPUT_BOUND_BYTES = 1024 * 1024;
export const CAUSAL_PREFLIGHT_CHECK_NAMES = [
  'cli',
  'worktree',
  'gitIndex',
  'gitMaterial',
  'writerLease',
  'providerCapability',
  'resources',
  'evidenceTarget',
  'sideChannel',
] as const;

export const CAUSAL_DEPENDENCY_DOMAINS = [
  'source',
  'test',
  'build-input',
  'manifest-semantic',
  'integration',
  'review-subject',
] as const;

export type CausalDependencyDomain = (typeof CAUSAL_DEPENDENCY_DOMAINS)[number];
export type CausalReceiptStatus = 'pass' | 'fail' | 'timeout' | 'cancelled' | 'partial';

/** Stable, structured command identity. Selector text is intentionally absent. */
export interface CausalCommandSpec {
  executable: string;
  args: string[];
  shell?: boolean;
  env?: Record<string, string>;
}

export interface CausalExecutionIdentityInput {
  storyId: string;
  cwd: string;
  command: CausalCommandSpec | string;
  bootstrap?: CausalCommandSpec | string | null;
  /** Explicit command inputs. An omitted value is incomplete; {} is explicit. */
  inputs?: unknown;
  storyFilesHash?: string;
  effectiveEnvironment?: Record<string, string>;
  runtimeVersion?: string;
  toolVersion?: string;
  /** Structured selector policy; individual selector IDs are not key material. */
  selectorPolicy?: unknown;
}

export interface CausalExecutionIdentity {
  schemaVersion: typeof CAUSAL_EXECUTION_KEY_SCHEMA;
  storyId: string;
  cwd: string;
  command: CausalCommandSpec;
  bootstrap: CausalCommandSpec | null;
  inputs: unknown;
  storyFilesHash: string;
  effectiveEnvironment: Record<string, string>;
  runtimeVersion: string;
  toolVersion: string;
  selectorPolicyDigest: string;
  complete: boolean;
}

export interface CausalExecutionKey {
  key: string;
  identity: CausalExecutionIdentity;
  identityDigest: string;
  reusable: boolean;
  incompleteReasons: string[];
}

export interface CausalCommandResult {
  code: number;
  output: string;
  timedOut?: boolean;
  cancelled?: boolean;
  partial?: boolean;
  durationMs?: number;
  timeoutMs?: number;
}

export interface CausalEvidenceReceipt {
  schemaVersion: typeof CAUSAL_EVIDENCE_SCHEMA;
  storyId: string;
  executionKey: string;
  identityDigest: string;
  identity: CausalExecutionIdentity;
  status: CausalReceiptStatus;
  exitCode: number;
  outputDigest: string;
  outputTail: string;
  /** A bounded prefix+tail probe used for independent selector verdicts. */
  outputProbe: string;
  /** Matching text uses NUL redaction boundaries, which cannot synthesize a valid text selector. */
  selectorProbe?: string;
  /** Bounded proof of only this selector when complete storage is unavailable or too large. */
  selectorWitness?: { selectorDigest: string; matched: boolean };
  outputLength: number;
  /** Signed binding to complete redacted selector bytes, stored separately from the display probe. */
  selectorOutput?: { digest: string; length: number };
  executedAt: string;
  durationMs?: number;
  timeoutMs?: number;
  /** Receipt hash excludes this field, like a normal CAS self-address. */
  receiptHash: string;
  /** Durable local Ed25519 authority identity; the public key is verified against the registered key. */
  signerPublicKey: PublicKeyBase64;
  signature: SignatureBase64;
  /** Only complete identities can be used as a cached PASS. */
  reusable: boolean;
  commandReruns: 0;
}

export interface CausalEvidenceReceiptStore {
  /** Exact verified CAS outputs, never an entire metadata directory exemption. */
  causalEvidenceOutputPaths?(storyId: string): string[];
  readCausalEvidenceReceipt(storyId: string, executionKey: string): CausalEvidenceReceipt | null;
  writeCausalEvidenceReceipt(storyId: string, receipt: CausalEvidenceReceipt): void;
  readCausalSelectorOutput?(storyId: string, digest: string): string;
  writeCausalSelectorOutput?(storyId: string, digest: string, output: string): void;
  /**
   * Optional cross-request single-flight boundary. The callback must re-read
   * the receipt before executing so callers that missed the initial read can
   * converge on the first request's receipt.
   */
  withCausalEvidenceExecution?<T>(
    storyId: string,
    executionKey: string,
    fn: () => Promise<T>,
  ): Promise<T>;
}

export interface CausalSelectorVerdict {
  intentRef?: string;
  selector: string;
  matched: boolean;
  result: 'pass' | 'fail';
  reason?: 'selectorMismatch' | 'executionFailure' | 'receiptInvalid' | 'legacyIdentity';
  executionKey: string;
  receiptHash?: string;
}

export interface CausalExecutionLedgerEntry {
  executionKey: string;
  identityDigest: string;
  receiptHash?: string;
  disposition: 'executed' | 'reused';
  executionAttempts: number;
}

export interface CausalEvidenceLedger {
  schemaVersion: typeof CAUSAL_LEDGER_SCHEMA;
  intentCount: number;
  executions: CausalExecutionLedgerEntry[];
  selectorVerdicts: CausalSelectorVerdict[];
  commitFailureReruns: number;
  unrelatedSpecializedRerun: number;
  affectedNodeRerun: number;
  falseFresh: number;
  _hash: string;
}

export interface CausalEvidenceMetrics {
  intentCount: number;
  uniqueExecutionKeys: number;
  commandExecutions: number;
  cacheHitRate: number;
  commandReruns: number;
  commitFailureReruns: number;
  unrelatedSpecializedRerun: number;
  affectedNodeRerun: number;
  falseFresh: number;
}

export interface CausalEvidenceBatch {
  executions: Map<string, Promise<CausalEvidenceReceipt>>;
  /** A failed first attempt may be retried once as a shared batch flight. */
  retryExecutions: Map<string, Promise<CausalEvidenceReceipt>>;
  ledger: CausalEvidenceLedger;
}

export interface CausalDependencyRerunEvidence {
  nodeId: string;
  receipt: CausalEvidenceReceipt;
}

/**
 * Identity of the causal evaluation for which a node rerun was executed.
 *
 * This is carried inside the existing signed execution inputs rather than
 * added as an unsigned field on CausalDependencyRerunEvidence.
 */
export interface CausalDependencyExecutionIdentityBinding {
  storyId?: string;
  materialHash?: string;
  storyFilesHash?: string;
  headHash?: string;
}

export const DEFAULT_CAUSAL_SELECTOR_POLICY = Object.freeze({
  schemaVersion: CAUSAL_SELECTOR_POLICY_SCHEMA,
  matcher: 'literal-output-inclusion',
  output: 'bounded-redacted-tail',
  verdicts: ['pass', 'selectorMismatch', 'executionFailure'],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareCanonicalKeys(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]?.codePointAt(0) ?? 0;
    const rightPoint = rightPoints[index]?.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}

/** Deterministic JSON used for every digest in this module. */
export function causalCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(causalCanonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => compareCanonicalKeys(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${causalCanonical(item)}`)
    .join(',')}}`;
}

export function causalDigest(value: unknown): string {
  return createHash('sha256').update(causalCanonical(value)).digest('hex');
}

function canonicalAuthorityRoot(root: string | undefined): string {
  const requestedRoot = root || process.cwd();
  try {
    // Authority identity is repository-scoped, not linked-worktree-scoped.
    // resolveSharedLockRoot collapses every worktree to the same stable Git
    // context while retaining the requested root for non-Git projects.
    return realpathSync(resolveSharedLockRoot(requestedRoot));
  } catch {
    // use the stable process root below
  }
  try { return realpathSync(process.cwd()); } catch { return root ?? process.cwd(); }
}

function causalAuthorityKeyPath(root: string | undefined): string {
  const canonicalRoot = canonicalAuthorityRoot(root);
  // Keep the authority key in the ignored runtime state of the stable
  // repository context. Receipt and decision verification must not depend on
  // a worktree-specific administrative layout.
  return join(canonicalRoot, '.proof-or-stop', 'runtime', CAUSAL_AUTHORITY_KEY_FILE);
}

function readOrCreateCausalAuthorityPrivateKey(root: string | undefined): string {
  const path = causalAuthorityKeyPath(root);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(path, randomBytes(32).toString('base64'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch {
      if (!existsSync(path)) throw new Error(`causal authority key could not be created at ${path}`);
    }
  }
  return readFileSync(path, 'utf8').trim();
}

function readCausalAuthorityPublicKey(root: string | undefined): PublicKeyBase64 | null {
  try {
    const privateKey = readFileSync(causalAuthorityKeyPath(root), 'utf8').trim();
    return exportPublicKeyRaw(createPublicKey(importPrivateKeyRaw(privateKey)));
  } catch {
    return null;
  }
}

function signCausalAuthorityPayload(payload: unknown, root: string | undefined): {
  signerPublicKey: PublicKeyBase64;
  signature: SignatureBase64;
} {
  const privateKey = readOrCreateCausalAuthorityPrivateKey(root);
  const signerPublicKey = exportPublicKeyRaw(createPublicKey(importPrivateKeyRaw(privateKey)));
  return { signerPublicKey, signature: signCanonical(payload, privateKey) };
}

function verifyCausalAuthorityPayload(
  payload: unknown,
  signerPublicKey: unknown,
  signature: unknown,
  root: string | undefined,
): boolean {
  const trusted = readCausalAuthorityPublicKey(root);
  return Boolean(
    trusted
      && signerPublicKey === trusted
      && typeof signature === 'string'
      && verifyCanonical(payload, signature, trusted),
  );
}

/** A pending publication is a signed recovery capability, never an ordinary cache hit.
 * The caller binds its exact request, pre-write checklist, owner generation and current
 * execution inputs into requestKey. A successful checklist write changes that key. */
export interface CausalPublicationRecovery {
  schemaVersion: 'proof-or-stop.causal-publication-recovery.v1';
  storyId: string;
  requestKey: string;
  cwd: string;
  publication: unknown;
  signerPublicKey: PublicKeyBase64;
  signature: SignatureBase64;
}
export function createCausalPublicationRecovery(
  storyId: string, requestKey: string, cwd: string, publication: unknown,
): CausalPublicationRecovery {
  const payload = { schemaVersion: 'proof-or-stop.causal-publication-recovery.v1' as const,
    storyId, requestKey, cwd, publication: cloneCanonical(publication) };
  return { ...payload, ...signCausalAuthorityPayload(payload, cwd) };
}
export function verifyCausalPublicationRecovery(
  value: CausalPublicationRecovery, storyId: string, requestKey: string, cwd: string,
): boolean {
  if (!value || value.schemaVersion !== 'proof-or-stop.causal-publication-recovery.v1'
    || value.storyId !== storyId || value.requestKey !== requestKey || value.cwd !== cwd
    || !/^[a-f0-9]{64}$/.test(requestKey)) return false;
  const { signerPublicKey, signature, ...payload } = value;
  return verifyCausalAuthorityPayload(payload, signerPublicKey, signature, cwd);
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(causalCanonical(value)) as T;
}

function normalizeCommand(command: CausalCommandSpec | string | null | undefined): CausalCommandSpec | null {
  if (!command) return null;
  if (typeof command === 'string') {
    const parsed = parseCommandString(command);
    return { executable: parsed.executable, args: [...parsed.args] };
  }
  if (!isRecord(command) || typeof command.executable !== 'string' || !Array.isArray(command.args)) return null;
  if (!command.args.every(arg => typeof arg === 'string')) return null;
  return {
    executable: command.executable,
    args: command.args.map(String),
    ...(command.shell !== undefined ? { shell: Boolean(command.shell) } : {}),
    ...(command.env ? { env: redactEnvironment(command.env as Record<string, unknown>) } : {}),
  };
}

function parseCommandString(command: string): { executable: string; args: string[] } {
  const tokens: string[] = [];
  let token = '';
  let quote: 'single' | 'double' | null = null;
  let hasToken = false;
  for (const char of command.trim()) {
    if (quote === 'single') {
      if (char === "'") quote = null;
      else token += char;
      hasToken = true;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = null;
      else token += char;
      hasToken = true;
      continue;
    }
    if (char === "'") { quote = 'single'; hasToken = true; continue; }
    if (char === '"') { quote = 'double'; hasToken = true; continue; }
    if (/\s/.test(char)) {
      if (hasToken) { tokens.push(token); token = ''; hasToken = false; }
      continue;
    }
    token += char;
    hasToken = true;
  }
  if (quote) throw new Error('causal command has an unterminated quote');
  if (hasToken) tokens.push(token);
  if (tokens.length === 0) throw new Error('causal command is empty');
  const [executable, ...args] = tokens;
  return { executable, args };
}

const REDACTED = '<redacted>';
const SECRET_ENV_KEY = /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|authorization|auth|proxy|cookie|session|database[_-]?url|dsn|ssh|aws|gcp|google|azure)/i;
const SELECTOR_CREDENTIAL_ENV_KEY = /(?:^|[_-])(?:token|secret|password|passwd|credential|credentials|authorization|cookie|api[_-]?key|private[_-]?key|access[_-]?key)(?:$|[_-])/i;
const SAFE_PLAINTEXT_ENV_KEY = /^(?:LANG|LC_[A-Z_]+|TZ|TERM|COLORTERM|CI)$/;

function selectorEnvironmentValueIsSecret(rawKey: string, rawValue: unknown): boolean {
  if (SELECTOR_CREDENTIAL_ENV_KEY.test(rawKey) || /^(?:AUTH|BEARER)$/i.test(rawKey)) return true;
  if (/^(?:HTTPS?|ALL)_PROXY$/i.test(rawKey)) {
    try {
      const parsed = new URL(String(rawValue));
      return Boolean(parsed.username || parsed.password);
    } catch {
      return /\/\/[^/@:]+:[^/@]+@/.test(String(rawValue));
    }
  }
  return /(?:^|[_-])(?:database[_-]?url|dsn)(?:$|[_-])/i.test(rawKey);
}

function redactedEnvironmentIdentity(value: unknown): string {
  return `${REDACTED}:sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

/** Redact values while retaining a non-secret identity distinction per credential. */
export function redactEnvironment(environment: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(environment)) {
    if (rawValue === undefined) continue;
    // Windows environment lookup is case-insensitive; POSIX lookup is not.
    // Normalizing POSIX keys would collapse distinct variables such as Path and
    // PATH and make a receipt reusable under a different child environment.
    const key = process.platform === 'win32' ? rawKey.toUpperCase() : rawKey;
    if (isValidationTransportEnvKey(key)) continue;
    result[key] = SAFE_PLAINTEXT_ENV_KEY.test(key) && !SECRET_ENV_KEY.test(key)
      ? String(rawValue)
      : redactedEnvironmentIdentity(rawValue);
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => compareCanonicalKeys(left, right)));
}

function realCanonicalCwd(cwd: string): string | null {
  try {
    return realpathSync(cwd);
  } catch { // PROBE: a missing cwd makes the identity incomplete and non-reusable.
    return null;
  }
}

function selectorPolicyDigest(policy: unknown): string {
  return causalDigest(policy ?? DEFAULT_CAUSAL_SELECTOR_POLICY);
}

export function createCausalExecutionKey(input: CausalExecutionIdentityInput): CausalExecutionKey {
  const cwd = realCanonicalCwd(input.cwd);
  const command = normalizeCommand(input.command);
  const bootstrap = normalizeCommand(input.bootstrap);
  const incompleteReasons: string[] = [];
  if (!cwd) incompleteReasons.push('cwd_unavailable');
  if (!command) incompleteReasons.push('command_spec_incomplete');
  if (!Object.prototype.hasOwnProperty.call(input, 'inputs')) incompleteReasons.push('inputs_missing');
  if (typeof input.storyFilesHash !== 'string') incompleteReasons.push('storyFilesHash_missing');
  if (!input.effectiveEnvironment) incompleteReasons.push('effective_environment_missing');
  if (!input.runtimeVersion) incompleteReasons.push('runtime_version_missing');
  if (!input.toolVersion) incompleteReasons.push('tool_version_missing');
  if (!Object.prototype.hasOwnProperty.call(input, 'selectorPolicy')) incompleteReasons.push('selector_policy_missing');

  const identity: CausalExecutionIdentity = {
    schemaVersion: CAUSAL_EXECUTION_KEY_SCHEMA,
    storyId: input.storyId,
    cwd: cwd ?? input.cwd,
    command: command ?? { executable: '<incomplete>', args: [] },
    bootstrap,
    inputs: cloneCanonical(input.inputs ?? null),
    storyFilesHash: input.storyFilesHash ?? '<missing>',
    effectiveEnvironment: redactEnvironment(input.effectiveEnvironment ?? {}),
    runtimeVersion: input.runtimeVersion ?? '<missing>',
    toolVersion: input.toolVersion ?? '<missing>',
    selectorPolicyDigest: selectorPolicyDigest(input.selectorPolicy),
    complete: incompleteReasons.length === 0,
  };
  const identityDigest = causalDigest(identity);
  return {
    key: `${CAUSAL_EXECUTION_KEY_PREFIX}${identityDigest}`,
    identity,
    identityDigest,
    reusable: identity.complete,
    incompleteReasons,
  };
}

/** Compare a signed execution identity with the identity currently observable by its writer. */
export function causalExecutionIdentityMatchesCurrent(
  identity: CausalExecutionIdentity,
  current: {
    storyId: string;
    cwd: string;
    storyFilesHash: string;
    effectiveEnvironment: Record<string, string>;
    runtimeVersion: string;
    toolVersion: string;
  },
): boolean {
  const canonicalCwd = realCanonicalCwd(current.cwd);
  if (!canonicalCwd) return false;
  const expected: CausalExecutionIdentity = {
    ...identity,
    storyId: current.storyId,
    cwd: canonicalCwd,
    storyFilesHash: current.storyFilesHash,
    effectiveEnvironment: redactEnvironment(current.effectiveEnvironment),
    runtimeVersion: current.runtimeVersion,
    toolVersion: current.toolVersion,
  };
  return causalCanonical(identity) === causalCanonical(expected)
    && identityDigestForExecutionIdentity(identity) === identityDigestForExecutionIdentity(expected);
}

function identityDigestForExecutionIdentity(identity: CausalExecutionIdentity): string {
  return causalDigest(identity);
}

/** Build the exact environment used by the existing command runner. */
export function effectiveCausalEnvironment(
  overlay: Record<string, string> | undefined,
  cwd: string,
  processEnvironment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return effectiveValidationCommandEnvironment(processEnvironment, overlay, cwd);
}

/** Tool version belongs to this CLI build, never to the project being verified. */
export function resolveCausalToolVersion(_projectRoot: string): string {
  // Keep the argument for existing callers; project layout and cwd are irrelevant.
  return PROOF_OR_STOP_CLI_VERSION;
}

export function serializeCausalReceipt(receipt: CausalEvidenceReceipt): string {
  const { receiptHash: _ignored, ...payload } = receipt;
  return causalCanonical(payload);
}

export function computeCausalReceiptHash(receipt: CausalEvidenceReceipt): string {
  return createHash('sha256').update(serializeCausalReceipt(receipt)).digest('hex');
}

export function verifyCausalEvidenceReceipt(
  receipt: CausalEvidenceReceipt | null | undefined,
  expectedKey?: string,
): boolean {
  if (!receipt || receipt.schemaVersion !== CAUSAL_EVIDENCE_SCHEMA) return false;
  if (expectedKey && receipt.executionKey !== expectedKey) return false;
  if (!isRecord(receipt.identity)) return false;
  const {
    receiptHash: _ignored,
    signerPublicKey: _signerPublicKey,
    signature: _signature,
    ...authorityPayload
  } = receipt;
  if (!receipt.receiptHash || receipt.receiptHash !== computeCausalReceiptHash(receipt)) return false;
  if (!verifyCausalAuthorityPayload(
    authorityPayload,
    receipt.signerPublicKey,
    receipt.signature,
    receipt.identity.cwd,
  )) return false;
  if (typeof receipt.outputProbe !== 'string' || receipt.outputProbe.length > CAUSAL_MAX_OUTPUT_CHARS) return false;
  if (typeof receipt.outputTail !== 'string' || receipt.outputTail.length > CAUSAL_OUTPUT_TAIL_CHARS) return false;
  if (receipt.selectorProbe !== undefined && (typeof receipt.selectorProbe !== 'string' || receipt.selectorProbe.length > CAUSAL_MAX_OUTPUT_CHARS)) return false;
  if (receipt.selectorWitness !== undefined && (!receipt.selectorWitness || typeof receipt.selectorWitness.matched !== 'boolean'
      || !/^[a-f0-9]{64}$/.test(receipt.selectorWitness.selectorDigest) || receipt.selectorOutput)) return false;
  if (receipt.selectorOutput && (!/^[a-f0-9]{64}$/.test(receipt.selectorOutput.digest)
      || !Number.isSafeInteger(receipt.selectorOutput.length) || receipt.selectorOutput.length < 0)) return false;
  if (receipt.identity.schemaVersion !== CAUSAL_EXECUTION_KEY_SCHEMA) return false;
  if (receipt.identityDigest !== causalDigest(receipt.identity)) return false;
  if (receipt.executionKey !== `${CAUSAL_EXECUTION_KEY_PREFIX}${receipt.identityDigest}`) return false;
  if (receipt.storyId !== receipt.identity.storyId) return false;
  const statusAllowsReuse = receipt.status === 'pass' && receipt.exitCode === 0;
  if (receipt.reusable !== (receipt.identity.complete && statusAllowsReuse && !receipt.selectorWitness)) return false;
  if (receipt.commandReruns !== 0) return false;
  if (!['pass', 'fail', 'timeout', 'cancelled', 'partial'].includes(receipt.status)) return false;
  return true;
}

function statusForRun(run: CausalCommandResult): CausalReceiptStatus {
  if (run.cancelled) return 'cancelled';
  if (run.partial) return 'partial';
  if (run.timedOut) return 'timeout';
  return run.code === 0 ? 'pass' : 'fail';
}

function boundedOutputTail(output: string): string {
  return output.length <= CAUSAL_OUTPUT_TAIL_CHARS ? output : output.slice(-CAUSAL_OUTPUT_TAIL_CHARS);
}

function boundedOutputProbe(output: string): string {
  if (output.length <= CAUSAL_MAX_OUTPUT_CHARS) return output;
  const gap = '\n<causal-output-gap>\n';
  const available = Math.max(0, CAUSAL_MAX_OUTPUT_CHARS - gap.length);
  const headLength = Math.ceil(available / 2);
  const tailLength = available - headLength;
  return `${output.slice(0, headLength)}${gap}${output.slice(-tailLength)}`;
}

export function redactCausalOutput(output: string, effectiveEnvironment: Record<string, unknown> | undefined, replacement = REDACTED): string {
  let redacted = String(output ?? '');
  for (const [rawKey, rawValue] of Object.entries(effectiveEnvironment ?? {})) {
    if (rawValue === undefined || rawValue === null) continue;
    const value = String(rawValue);
    if (!value || value === REDACTED) continue;
    if (!isValidationTransportEnvKey(rawKey) && SECRET_ENV_KEY.test(rawKey) && value.length >= 4) {
      redacted = redacted.split(value).join(replacement);
    }
  }
  return redacted
    .replace(/(authorization\s*[:=]\s*|bearer\s+)[^\s,;]+/gi, `$1${replacement}`)
    .replace(/((?:token|secret|password|passwd|api[_-]?key|credential)\s*[:=]\s*)[^\s,;]+/gi, `$1${replacement}`);
}

/**
 * Redact only credential-bearing values before selector matching. Ordinary
 * environment values such as USER, PWD, NODE_ENV, or npm metadata are not
 * secrets and must not erase legitimate command-output substrings.
 */
export function redactCausalSelectorOutput(
  output: string,
  effectiveEnvironment: Record<string, unknown> | undefined,
  replacement = '\0',
): string {
  let redacted = String(output ?? '');
  for (const [rawKey, rawValue] of Object.entries(effectiveEnvironment ?? {})) {
    if (rawValue === undefined || rawValue === null || isValidationTransportEnvKey(rawKey)) continue;
    const value = String(rawValue);
    if (!value || value === REDACTED || value.length < 4 || !selectorEnvironmentValueIsSecret(rawKey, rawValue)) continue;
    redacted = redacted.split(value).join(replacement);
  }
  return redacted
    .replace(/(authorization\s*[:=]\s*|bearer\s+)[^\s,;]+/gi, `$1${replacement}`)
    .replace(/((?:token|secret|password|passwd|api[_-]?key|credential)\s*[:=]\s*)[^\s,;]+/gi, `$1${replacement}`);
}

function recordExecution(batch: CausalEvidenceBatch | undefined, entry: CausalExecutionLedgerEntry): void {
  if (!batch) return;
  const prior = batch.ledger.executions.find(item => item.executionKey === entry.executionKey);
  if (prior) {
    prior.executionAttempts += entry.executionAttempts;
    if (prior.disposition === 'reused' && entry.disposition === 'executed') prior.disposition = 'executed';
    if (!prior.receiptHash) prior.receiptHash = entry.receiptHash;
  } else {
    batch.ledger.executions.push({ ...entry });
  }
}

export function createCausalEvidenceBatch(): CausalEvidenceBatch {
  const ledgerWithoutHash = {
    schemaVersion: CAUSAL_LEDGER_SCHEMA,
    intentCount: 0,
    executions: [],
    selectorVerdicts: [],
    commitFailureReruns: 0,
    unrelatedSpecializedRerun: 0,
    affectedNodeRerun: 0,
    falseFresh: 0,
  } satisfies Omit<CausalEvidenceLedger, '_hash'>;
  return {
    executions: new Map(),
    retryExecutions: new Map(),
    ledger: { ...ledgerWithoutHash, _hash: causalDigest(ledgerWithoutHash) },
  };
}

function refreshLedgerHash(batch: CausalEvidenceBatch): void {
  const { _hash: _ignored, ...payload } = batch.ledger;
  batch.ledger._hash = causalDigest(payload);
}

export function verifyCausalEvidenceLedger(ledger: CausalEvidenceLedger): boolean {
  const { _hash: _ignored, ...payload } = ledger;
  return ledger.schemaVersion === CAUSAL_LEDGER_SCHEMA && ledger._hash === causalDigest(payload);
}

// Weak ownership retains failed/non-persistent execution output only while its receipt is live.
const liveSelectorOutput = new WeakMap<CausalEvidenceReceipt, string>();

export function readCausalSelectorOutput(receipt: CausalEvidenceReceipt, store?: CausalEvidenceReceiptStore): string {
  if (!receipt.selectorOutput) {
    if (receipt.selectorProbe !== undefined) return receipt.selectorProbe;
    // Historical receipts contain display bytes only. Truncation/redaction markers
    // have no raw-output provenance and must never become selector evidence.
    if (receipt.outputLength > CAUSAL_MAX_OUTPUT_CHARS
        || [receipt.outputProbe, receipt.outputTail].some(value => value.includes(REDACTED) || value.includes('<causal-output-gap>'))) {
      throw new Error('Legacy display output cannot prove this selector; fresh execution is required [causal_legacy_selector_output_unproven]');
    }
    return receipt.outputProbe;
  }
  const output = liveSelectorOutput.get(receipt) ?? store?.readCausalSelectorOutput?.(receipt.storyId, receipt.selectorOutput.digest);
  if (typeof output !== 'string' || output.length !== receipt.selectorOutput.length
      || createHash('sha256').update(output).digest('hex') !== receipt.selectorOutput.digest) {
    throw new Error('Complete selector output is missing or changed [causal_selector_output_invalid]');
  }
  return output;
}

function selectorVerdict(
  receipt: CausalEvidenceReceipt,
  selector: string,
  intentRef?: string,
  store?: CausalEvidenceReceiptStore,
): CausalSelectorVerdict {
  const matched = selector.length === 0 ? receipt.status === 'pass'
    : selector.includes('\0') ? false
    : receipt.selectorWitness ? receipt.selectorWitness.selectorDigest === createHash('sha256').update(selector).digest('hex') && receipt.selectorWitness.matched
    : readCausalSelectorOutput(receipt, store).includes(selector)
      || (!receipt.selectorOutput && receipt.selectorProbe === undefined && receipt.outputTail.includes(selector));
  const result = receipt.status === 'pass' && matched ? 'pass' : 'fail';
  return {
    ...(intentRef ? { intentRef } : {}),
    selector,
    matched,
    result,
    ...(result === 'pass'
      ? {}
      : { reason: !matched ? 'selectorMismatch' as const : receipt.status === 'pass' ? 'selectorMismatch' as const : 'executionFailure' as const }),
    executionKey: receipt.executionKey,
    receiptHash: receipt.receiptHash,
  };
}

export interface ExecuteCausalEvidenceArgs {
  identity: CausalExecutionIdentityInput;
  selector: string;
  intentRef?: string;
  run: () => Promise<CausalCommandResult>;
  receiptStore?: CausalEvidenceReceiptStore;
  batch?: CausalEvidenceBatch;
  preflight?: CausalPreflightReport;
  /** Required atomic state check immediately before the child runner is called. */
  revalidateBeforeRun: () => boolean;
}

export interface ExecuteCausalEvidenceResult {
  key: CausalExecutionKey;
  receipt: CausalEvidenceReceipt;
  verdict: CausalSelectorVerdict;
  disposition: 'executed' | 'reused';
}

/** Execute/reuse one key, then evaluate the caller's selector independently. */
export async function executeCausalEvidence(args: ExecuteCausalEvidenceArgs): Promise<ExecuteCausalEvidenceResult> {
  const key = createCausalExecutionKey(args.identity);
  if (!args.preflight || !verifyCausalPreflight(args.preflight, args.identity)) {
    throw new Error('causal evidence refused: missing_or_forged_preflight commandExecutions=0 evidenceWrites=0 [causal_preflight_invalid]');
  }

  const readReceipt = (): CausalEvidenceReceipt | null => {
    const existing = key.reusable ? args.receiptStore?.readCausalEvidenceReceipt(key.identity.storyId, key.key) : null;
    if (existing && !verifyCausalEvidenceReceipt(existing, key.key)) {
      throw new Error(`causal evidence refused: receipt for ${key.key} is tampered or has the wrong identity [causal_receipt_tampered]`);
    }
    return existing ?? null;
  };

  const existing = readReceipt();
  if (existing && existing.reusable) {
    const verdict = selectorVerdict(existing, args.selector, args.intentRef, args.receiptStore);
    if (args.batch) {
      args.batch.ledger.intentCount++;
      args.batch.ledger.selectorVerdicts.push(verdict);
      recordExecution(args.batch, {
        executionKey: key.key,
        identityDigest: key.identityDigest,
        receiptHash: existing.receiptHash,
        disposition: 'reused',
        executionAttempts: 0,
      });
      refreshLedgerHash(args.batch);
    }
    return { key, receipt: existing, verdict, disposition: 'reused' };
  }

  // These writes publish immutable evidence from an already-completed command.
  // Retry the same transaction once; never re-enter the runner to retry storage.
  const publishCompleted = (write: () => void): void => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { write(); return; }
      catch (error) { if (attempt === 1) throw error; }
    }
  };

  // Incomplete identities are intentionally never deduplicated: a legacy or
  // partial identity cannot turn a second selector into a cached PASS.
  const executeFresh = async (): Promise<CausalEvidenceReceipt> => {
      // This check is deliberately the last operation before invoking the child
      // runner. A post-run check can only reject the evidence after the command
      // has already executed, which violates the zero-execution refusal contract.
      if (!args.revalidateBeforeRun) {
        throw new Error('causal preflight refused: missing_last_moment_revalidation commandExecutions=0 evidenceWrites=0 [causal_preflight_refused]');
      }
      if (!args.revalidateBeforeRun()) {
        throw new Error('causal preflight refused: state_changed_before_launch commandExecutions=0 evidenceWrites=0 [causal_preflight_refused]');
      }
      const run = await args.run();
      const runStatus = statusForRun(run);
      // Selector witnesses are durable evidence too. The child identity only
      // records its effective environment, but command output may echo a secret
      // inherited from the broker process. Scrub both sources before matching,
      // probing, hashing, or persisting selector-visible bytes.
      const matchingOutput = redactCausalSelectorOutput(
        run.output,
        { ...process.env, ...args.identity.effectiveEnvironment },
      );
      // Every persisted output projection must describe the same redacted byte
      // stream. Credential values use NUL while matching, then the printable
      // marker below; benign selector-visible values remain visible everywhere.
      const redactedOutput = matchingOutput.replace(/\0/g, REDACTED);
      const longOutput = matchingOutput.length > CAUSAL_MAX_OUTPUT_CHARS;
      const durableOutput = longOutput && args.receiptStore?.readCausalSelectorOutput && args.receiptStore?.writeCausalSelectorOutput
        && matchingOutput.length <= CAUSAL_SELECTOR_OUTPUT_BOUND_BYTES
        && Buffer.byteLength(JSON.stringify({output:matchingOutput}), 'utf8') <= CAUSAL_SELECTOR_OUTPUT_BOUND_BYTES;
      const selectorOutput = durableOutput
        ? { digest: createHash('sha256').update(matchingOutput).digest('hex'), length: matchingOutput.length } : undefined;
      const selectorWitness = longOutput && !selectorOutput
        ? {selectorDigest:createHash('sha256').update(args.selector).digest('hex'), matched:!args.selector.includes('\0') && matchingOutput.includes(args.selector)} : undefined;
      const receiptWithoutAuthority: Omit<CausalEvidenceReceipt, 'receiptHash' | 'signerPublicKey' | 'signature'> = {
        schemaVersion: CAUSAL_EVIDENCE_SCHEMA,
        storyId: key.identity.storyId,
        executionKey: key.key,
        identityDigest: key.identityDigest,
        identity: key.identity,
        status: runStatus,
        exitCode: run.timedOut ? 124 : run.code,
        // The digest is non-reversible and remains over the complete observed
        // command output for compatibility; complete selector bytes are redacted separately.
        outputDigest: createHash('sha256').update(run.output).digest('hex'),
        outputTail: boundedOutputTail(redactedOutput),
        outputProbe: boundedOutputProbe(redactedOutput),
        outputLength: run.output.length,
        ...(selectorOutput ? { selectorOutput } : {}),
        ...(selectorWitness ? { selectorWitness } : {}),
        ...(!longOutput ? {selectorProbe:matchingOutput} : {}),
        executedAt: new Date().toISOString(),
        ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
        ...(run.timeoutMs !== undefined ? { timeoutMs: run.timeoutMs } : {}),
        reusable: key.reusable && runStatus === 'pass' && run.code === 0 && !selectorWitness,
        commandReruns: 0,
      };
      const authority = signCausalAuthorityPayload(receiptWithoutAuthority, key.identity.cwd);
      const receipt = {
        ...receiptWithoutAuthority,
        ...authority,
        receiptHash: computeCausalReceiptHash({ ...receiptWithoutAuthority, ...authority } as CausalEvidenceReceipt),
      } as CausalEvidenceReceipt;
      if (selectorOutput) {
        liveSelectorOutput.set(receipt, matchingOutput);
        // Publish complete bytes first. A receipt can never advertise an output
        // object whose write failed; an orphan output object grants no authority.
        if (receipt.reusable) publishCompleted(() =>
          args.receiptStore?.writeCausalSelectorOutput?.(key.identity.storyId, selectorOutput.digest, matchingOutput));
      }
      // A non-PASS result is an execution outcome, not a reusable CAS value.
      // Leaving it at this address would both turn a transient failure into a
      // cache hit and prevent the later PASS from being written immutably.
      if (args.receiptStore && receipt.reusable) {
        publishCompleted(() => args.receiptStore!.writeCausalEvidenceReceipt(key.identity.storyId, receipt));
      }
      return receipt;
  };

  type ExecutionOutcome = {
    receipt: CausalEvidenceReceipt;
    disposition: 'executed' | 'reused';
  };
  let execution: Promise<ExecutionOutcome>;
  const batchPromise = key.reusable
    ? (args.batch?.retryExecutions.get(key.key) ?? args.batch?.executions.get(key.key))
    : undefined;
  if (batchPromise) {
    // Only a PASS can be a per-batch cache hit. A failed/partial/timeout/
    // cancelled attempt must leave the key eligible for a later PASS.
    execution = batchPromise.then(async receipt => {
      if (receipt.reusable) return { receipt, disposition: 'reused' as const };

      // All followers that observed the failed first flight must converge on
      // one retry. Without this second single-flight boundary, each follower
      // calls executeFresh() after the first promise resolves and the same
      // exact key can launch several expensive retries concurrently.
      const existingRetry = args.batch?.retryExecutions.get(key.key);
      if (existingRetry) return { receipt: await existingRetry, disposition: 'reused' as const };
      const publishedRetry = args.batch?.executions.get(key.key);
      if (publishedRetry && publishedRetry !== batchPromise) {
        return { receipt: await publishedRetry, disposition: 'reused' as const };
      }

      let retry: Promise<CausalEvidenceReceipt>;
      retry = executeFresh().then(
        nextReceipt => {
          args.batch?.retryExecutions.delete(key.key);
          if (nextReceipt.reusable && args.batch) {
            const current = args.batch.executions.get(key.key);
            if (!current || current === batchPromise) args.batch.executions.set(key.key, Promise.resolve(nextReceipt));
          }
          return nextReceipt;
        },
        error => {
          args.batch?.retryExecutions.delete(key.key);
          if (args.batch?.executions.get(key.key) === batchPromise) args.batch.executions.delete(key.key);
          throw error;
        },
      );
      void retry.catch(() => undefined);
      args.batch?.retryExecutions.set(key.key, retry);
      return { receipt: await retry, disposition: 'executed' as const };
    });
  } else if (key.reusable && args.receiptStore?.withCausalEvidenceExecution) {
    // Separate requests do not share `batch`. The store boundary re-reads
    // inside its single-flight region so only the winner can launch the child.
    execution = args.receiptStore.withCausalEvidenceExecution(
      key.identity.storyId,
      key.key,
      async () => {
        const lockedExisting = readReceipt();
        if (lockedExisting && lockedExisting.reusable) {
          return { receipt: lockedExisting, disposition: 'reused' as const };
        }
        return { receipt: await executeFresh(), disposition: 'executed' as const };
      },
    );
  } else {
    execution = executeFresh().then(receipt => ({ receipt, disposition: 'executed' as const }));
  }
  if (key.reusable && args.batch && !batchPromise) {
    let batchReceipt: Promise<CausalEvidenceReceipt>;
    batchReceipt = execution.then(
      ({ receipt }) => {
        if (!receipt.reusable && args.batch?.executions.get(key.key) === batchReceipt) {
          args.batch.executions.delete(key.key);
        }
        return receipt;
      },
      error => {
        // Infrastructure/runner rejection is not an evidence result. Remove
        // the rejected single-flight promise so a later exact-key request can
        // retry, while the attached observer prevents an unhandled rejection.
        if (args.batch?.executions.get(key.key) === batchReceipt) {
          args.batch.executions.delete(key.key);
        }
        throw error;
      },
    );
    // The caller awaits `execution` directly. Observe the derived promise too
    // so a failed first execution cannot become an unhandled rejection merely
    // because the batch cache retains the same failure for later callers.
    void batchReceipt.catch(() => undefined);
    args.batch.executions.set(key.key, batchReceipt);
  }
  let { receipt, disposition } = await execution;
  // A bounded fallback witness proves one selector only. Another subscriber
  // cannot consume it as an absent-selector verdict for its own different pin.
  // Durable reusable output still fans out; this fallback needs its own run.
  if (receipt.selectorWitness
      && receipt.selectorWitness.selectorDigest !== createHash('sha256').update(args.selector).digest('hex')) {
    receipt = await executeFresh();
    disposition = 'executed';
  }
  const verdict = selectorVerdict(receipt, args.selector, args.intentRef, args.receiptStore);
  if (args.batch) {
    args.batch.ledger.intentCount++;
    args.batch.ledger.selectorVerdicts.push(verdict);
    recordExecution(args.batch, {
      executionKey: key.key,
      identityDigest: key.identityDigest,
      receiptHash: receipt.receiptHash,
      disposition,
      executionAttempts: disposition === 'executed' ? 1 : 0,
    });
    refreshLedgerHash(args.batch);
  }
  return { key, receipt, verdict, disposition };
}

export interface CausalPreflightFacts {
  cli?: { available: boolean; path?: string; reason?: string };
  worktree?: { expected: string; actual: string; reason?: string };
  gitIndex?: { readable: boolean; path?: string; expected?: string; actual?: string; contentDigest?: string; reason?: string };
  gitMaterial?: { available: boolean; headHash?: string; materialHash?: string; storyFilesHash?: string; reason?: string };
  writerLease?: { available: boolean; valid: boolean; reason?: string };
  providerCapability?: { required: string[]; available: string[]; reason?: string };
  resources?: { required: Record<string, number>; available: Record<string, number>; reason?: string };
  evidenceTarget?: { writable: boolean; path?: string; probe?: string; reason?: string };
  sideChannel?: { available: boolean; maxOutputChars: number; maxProgressEvents: number };
}

export interface CausalPreflightReport {
  schemaVersion: typeof CAUSAL_PREFLIGHT_SCHEMA;
  ready: boolean;
  facts: CausalPreflightFacts;
  /** The signed execution identity this readiness report was produced for. */
  executionKey: string;
  executionIdentity: CausalExecutionIdentity;
  executionIdentityDigest: string;
  authorityRoot: string;
  checks: Record<string, { status: 'pass' | 'fail'; reason?: string }>;
  failedChecks: string[];
  commandExecutions: 0;
  evidenceWrites: 0;
  signerPublicKey: PublicKeyBase64;
  signature: SignatureBase64;
  readinessHash: string;
}

function preflightFailure(report: Record<string, { status: 'pass' | 'fail'; reason?: string }>, name: string, reason: string): void {
  report[name] = { status: 'fail', reason };
}

function authorityRootForPreflightFacts(facts: CausalPreflightFacts): string {
  const expected = facts.worktree?.expected;
  return canonicalAuthorityRoot(expected && existsSync(expected) ? expected : undefined);
}

function preflightChecksForFacts(facts: CausalPreflightFacts): Record<string, { status: 'pass' | 'fail'; reason?: string }> {
  const checks: Record<string, { status: 'pass' | 'fail'; reason?: string }> = {};
  if (!facts.cli?.available || !facts.cli.path) preflightFailure(checks, 'cli', facts.cli?.reason ?? 'cli_unavailable');
  else checks.cli = { status: 'pass' };

  if (!facts.worktree?.expected || !facts.worktree.actual) preflightFailure(checks, 'worktree', 'worktree_unavailable');
  else if (facts.worktree.expected !== facts.worktree.actual) preflightFailure(checks, 'worktree', `worktree_mismatch expected=${facts.worktree.expected} actual=${facts.worktree.actual}`);
  else checks.worktree = { status: 'pass' };

  if (!facts.gitIndex?.readable || !facts.gitIndex.path) {
    preflightFailure(checks, 'gitIndex', facts.gitIndex?.reason ?? 'git_index_unavailable');
  } else if (!facts.gitIndex.contentDigest) {
    preflightFailure(checks, 'gitIndex', facts.gitIndex.reason ?? 'git_index_content_digest_unavailable');
  } else if (facts.gitIndex.expected && facts.gitIndex.actual && facts.gitIndex.expected !== facts.gitIndex.actual) {
    preflightFailure(checks, 'gitIndex', `git_index_mismatch expected=${facts.gitIndex.expected} actual=${facts.gitIndex.actual}`);
  } else checks.gitIndex = { status: 'pass' };

  if (!facts.gitMaterial?.available || !facts.gitMaterial.headHash || !facts.gitMaterial.materialHash || !facts.gitMaterial.storyFilesHash) {
    preflightFailure(checks, 'gitMaterial', facts.gitMaterial?.reason ?? 'git_material_unavailable');
  } else checks.gitMaterial = { status: 'pass' };

  if (!facts.writerLease?.available) preflightFailure(checks, 'writerLease', 'writer_unavailable');
  else if (!facts.writerLease.valid) preflightFailure(checks, 'writerLease', `lease_invalid${facts.writerLease.reason ? ` ${facts.writerLease.reason}` : ''}`);
  else checks.writerLease = { status: 'pass' };

  const missingCapability = (facts.providerCapability?.required ?? []).find(cap => !(facts.providerCapability?.available ?? []).includes(cap));
  if (!facts.providerCapability || missingCapability) preflightFailure(checks, 'providerCapability', facts.providerCapability?.reason ?? `provider_capability_missing${missingCapability ? ` ${missingCapability}` : ''}`);
  else checks.providerCapability = { status: 'pass' };

  const insufficient = Object.entries(facts.resources?.required ?? {}).find(([name, required]) => (facts.resources?.available[name] ?? 0) < required);
  if (!facts.resources || insufficient) preflightFailure(checks, 'resources', facts.resources?.reason ?? (insufficient ? `insufficient_resources ${insufficient[0]} required=${insufficient[1]} available=${facts.resources?.available[insufficient[0]] ?? 0}` : 'insufficient_resources'));
  else checks.resources = { status: 'pass' };

  if (!facts.evidenceTarget?.writable || !facts.evidenceTarget.path) preflightFailure(checks, 'evidenceTarget', facts.evidenceTarget?.reason ?? `evidence_target_not_writable${facts.evidenceTarget?.path ? ` ${facts.evidenceTarget.path}` : ''}${facts.evidenceTarget?.probe ? ` ${facts.evidenceTarget.probe}` : ''}`);
  else checks.evidenceTarget = { status: 'pass' };

  if (!facts.sideChannel?.available || facts.sideChannel.maxOutputChars <= 0 || facts.sideChannel.maxProgressEvents <= 0) preflightFailure(checks, 'sideChannel', 'bounded_side_channel_unavailable');
  else checks.sideChannel = { status: 'pass' };
  return checks;
}

/** Fresh execution admission without minting or consuming a reuse credential. */
export function assertCausalExecutionAdmission(facts: CausalPreflightFacts): void {
  const failed = Object.entries(preflightChecksForFacts(facts)).filter(([,check]) => check.status === 'fail');
  if (failed.length) throw new Error('causal execution preflight refused: ' + failed.map(([name,check]) => name + ':' + check.reason).join(', '));
}

function signedPreflightReport(
  facts: CausalPreflightFacts,
  ready: boolean,
  checks: Record<string, { status: 'pass' | 'fail'; reason?: string }>,
  failedChecks: string[],
  executionKey: CausalExecutionKey,
): CausalPreflightReport {
  const unsigned = {
    schemaVersion: CAUSAL_PREFLIGHT_SCHEMA,
    ready,
    facts: cloneCanonical(facts),
    executionKey: executionKey.key,
    executionIdentity: executionKey.identity,
    executionIdentityDigest: executionKey.identityDigest,
    authorityRoot: authorityRootForPreflightFacts(facts),
    checks,
    failedChecks,
    commandExecutions: 0 as const,
    evidenceWrites: 0 as const,
  };
  const authority = signCausalAuthorityPayload(unsigned, unsigned.authorityRoot);
  const signed = { ...unsigned, ...authority };
  return { ...signed, readinessHash: causalDigest(signed) };
}

export function preflightCausalEvidence(
  facts: CausalPreflightFacts,
  revalidate?: () => boolean,
  identity?: CausalExecutionIdentityInput,
): CausalPreflightReport {
  if (!identity) {
    throw new Error('causal preflight refused: execution identity is required [causal_preflight_identity_missing]');
  }
  const executionKey = createCausalExecutionKey(identity);
  const checks = preflightChecksForFacts(facts);

  if (Object.values(checks).some(check => check.status === 'fail')) {
    const failedChecks = Object.entries(checks).filter(([, check]) => check.status === 'fail').map(([name, check]) => `${name}:${check.reason}`);
    return signedPreflightReport(facts, false, checks, failedChecks, executionKey);
  }
  if (revalidate && !revalidate()) {
    const failedChecks = ['state_changed_before_launch'];
    return signedPreflightReport(facts, false, { ...checks, atomicRevalidation: { status: 'fail' as const, reason: 'state_changed_before_launch' } }, failedChecks, executionKey);
  }
  return signedPreflightReport(facts, true, checks, [], executionKey);
}

export function verifyCausalPreflight(report: CausalPreflightReport, expectedIdentity?: CausalExecutionIdentityInput): boolean {
  if (!isRecord(report) || !isRecord(report.checks) || !isRecord(report.facts) || !isRecord(report.executionIdentity) || !Array.isArray(report.failedChecks)) return false;
  const checkNames = Object.keys(report.checks);
  if (
    checkNames.length !== CAUSAL_PREFLIGHT_CHECK_NAMES.length
    || CAUSAL_PREFLIGHT_CHECK_NAMES.some(name => !Object.prototype.hasOwnProperty.call(report.checks, name))
    || checkNames.some(name => !CAUSAL_PREFLIGHT_CHECK_NAMES.includes(name as (typeof CAUSAL_PREFLIGHT_CHECK_NAMES)[number]))
    || Object.values(report.checks).some(check => !isRecord(check) || check.status !== 'pass')
  ) return false;
  const expectedChecks = preflightChecksForFacts(report.facts as CausalPreflightFacts);
  const { readinessHash: _ignored, signerPublicKey: _publicKey, signature: _signature, ...payload } = report;
  const signedPayload = { ...payload, signerPublicKey: report.signerPublicKey, signature: report.signature };
  const authorityRoot = authorityRootForPreflightFacts(report.facts as CausalPreflightFacts);
  const boundIdentity = report.executionIdentity as CausalExecutionIdentity;
  const identityBindingValid = report.executionIdentityDigest === causalDigest(boundIdentity)
    && report.executionKey === `${CAUSAL_EXECUTION_KEY_PREFIX}${report.executionIdentityDigest}`
    && boundIdentity.schemaVersion === CAUSAL_EXECUTION_KEY_SCHEMA
    && typeof boundIdentity.storyId === 'string'
    && typeof boundIdentity.cwd === 'string'
    && isRecord(boundIdentity.command)
    && Array.isArray(boundIdentity.command.args)
    && isRecord(boundIdentity.effectiveEnvironment)
    && typeof boundIdentity.storyFilesHash === 'string'
    && typeof boundIdentity.runtimeVersion === 'string'
    && typeof boundIdentity.toolVersion === 'string'
    && typeof boundIdentity.selectorPolicyDigest === 'string'
    && typeof boundIdentity.complete === 'boolean';
  const expectedBindingValid = expectedIdentity
    ? (() => {
      const expectedKey = createCausalExecutionKey(expectedIdentity);
      return expectedKey.key === report.executionKey
        && expectedKey.identityDigest === report.executionIdentityDigest
        && causalCanonical(expectedKey.identity) === causalCanonical(boundIdentity);
    })()
    : true;
  return report.schemaVersion === CAUSAL_PREFLIGHT_SCHEMA
    && report.ready === true
    && report.failedChecks.length === 0
    && report.commandExecutions === 0
    && report.evidenceWrites === 0
    && report.authorityRoot === authorityRoot
    && causalCanonical(report.checks) === causalCanonical(expectedChecks)
    && identityBindingValid
    && expectedBindingValid
    && report.readinessHash === causalDigest(signedPayload)
    && verifyCausalAuthorityPayload(
      { ...payload },
      report.signerPublicKey,
      report.signature,
      authorityRoot,
    );
}

export interface CausalDependencyNode {
  id: string;
  domain: CausalDependencyDomain;
  inputIds: string[];
  dependencyIds?: string[];
  recordedInputHashes: Record<string, string>;
}

export interface CausalDependencyDecisionIdentityBinding {
  storyId?: string;
  dependencyGraphDigest?: string;
  currentInputHashesDigest?: string;
  previousMaterialHash?: string;
  currentMaterialHash?: string;
  previousStoryFilesHash?: string;
  currentStoryFilesHash?: string;
  previousHeadHash?: string;
  currentHeadHash?: string;
}

export interface CausalDependencyDecisionAuthorityBinding {
  schemaVersion: 'proof-or-stop.causal-dependency-authority.v1';
  producer: 'core/causal-evidence';
  authority: 'proof-or-stop';
  signerPublicKey: PublicKeyBase64;
  signature: string;
}

const CAUSAL_DEPENDENCY_DECISION_AUTHORITY_METADATA = Object.freeze({
  schemaVersion: 'proof-or-stop.causal-dependency-authority.v1',
  producer: 'core/causal-evidence',
  authority: 'proof-or-stop',
} as const);
export interface CausalDependencyDecision {
  schemaVersion: typeof CAUSAL_DEPENDENCY_SCHEMA;
  causalDecision: 'fresh' | 'advisory' | 'rerun' | 'strict';
  affectedNodeIds: string[];
  invalidatedNodeIds: string[];
  changedInputIds: string[];
  specializedRerun: number;
  affectedNodeRerun: number;
  falseFresh: number;
  verifiedRerunNodeIds: string[];
  materialHashStrict: boolean;
  storyFilesHashAdvisory: boolean;
  doneRequiredStrict: boolean;
  gateAdmissible: boolean;
  reason: string;
  /** Hashes observed by evaluateCausalDependencies; included in the CAS hash. */
  identityBinding?: CausalDependencyDecisionIdentityBinding;
  authorityBinding: CausalDependencyDecisionAuthorityBinding;
  _hash: string;
}

export function causalDependencyContextDigests(
  nodes: readonly CausalDependencyNode[],
  currentInputHashes: Record<string, string>,
): { dependencyGraphDigest: string; currentInputHashesDigest: string } {
  return {
    dependencyGraphDigest: causalDigest(nodes.map(node => ({
      id: node.id,
      domain: node.domain,
      inputIds: [...node.inputIds].sort(),
      dependencyIds: [...(node.dependencyIds ?? [])].sort(),
    })).sort((a, b) => a.id.localeCompare(b.id))),
    currentInputHashesDigest: causalDigest(currentInputHashes),
  };
}

function dependencyClosure(nodes: readonly CausalDependencyNode[], changed: Set<string>): Set<string> {
  const affected = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of nodes) {
      if (affected.has(node.id)) continue;
      if ((node.dependencyIds ?? []).some(dep => affected.has(dep))) {
        affected.add(node.id);
        grew = true;
      }
    }
  }
  return affected;
}

/**
 * Inputs that an actual node execution must bind into its signed receipt. The
 * optional identity preserves the existing construction API; rerun admission
 * requires the current story/snapshot identity when one is being evaluated.
 */
export function causalDependencyExecutionInputs(
  nodeId: string,
  inputHashes: Record<string, string>,
  identity?: CausalDependencyExecutionIdentityBinding,
): Record<string, unknown> {
  const identityBinding = identity
    ? Object.fromEntries(Object.entries(identity).filter(([, value]) => value !== undefined))
    : {};
  return {
    causalDependency: {
      nodeId,
      inputHashes: cloneCanonical(inputHashes),
      ...identityBinding,
    },
  };
}

export function createCausalDependencyRerunEvidence(
  nodeId: string,
  receipt: CausalEvidenceReceipt,
): CausalDependencyRerunEvidence {
  return { nodeId, receipt };
}

function verifyCausalDependencyRerunEvidence(
  evidence: CausalDependencyRerunEvidence,
  node: CausalDependencyNode,
  currentInputHashes: Record<string, string>,
  currentIdentity: CausalDependencyExecutionIdentityBinding,
): boolean {
  if (!evidence || evidence.nodeId !== node.id) return false;
  const receipt = evidence.receipt;
  if (!verifyCausalEvidenceReceipt(receipt, receipt?.executionKey) || !receipt.reusable || receipt.status !== 'pass') return false;
  if (!isRecord(receipt.identity.inputs)) return false;
  const inputBinding: Record<string, unknown> = isRecord(receipt.identity.inputs.causalDependency)
    ? { ...receipt.identity.inputs.causalDependency }
    : {
        nodeId: receipt.identity.inputs.causalNodeId,
        inputHashes: receipt.identity.inputs.causalInputHashes,
      };
  if (inputBinding.nodeId !== node.id) return false;
  const inputHashes: Record<string, unknown> = isRecord(inputBinding.inputHashes)
    ? inputBinding.inputHashes
    : {};
  if (!isRecord(inputBinding.inputHashes)) return false;
  const identityFields = ['storyId', 'materialHash', 'storyFilesHash', 'headHash'] as const;
  const hasIdentityBinding = identityFields.some(field => Object.prototype.hasOwnProperty.call(inputBinding, field));
  if (!hasIdentityBinding) return false;
  for (const field of ['storyId', 'materialHash', 'storyFilesHash'] as const) {
    const expected = currentIdentity[field];
    if (typeof expected !== 'string' || expected.length === 0 || inputBinding[field] !== expected) return false;
  }
  for (const field of identityFields) {
    if (Object.prototype.hasOwnProperty.call(inputBinding, field)
      && (typeof inputBinding[field] !== 'string' || inputBinding[field].length === 0)) return false;
    const expected = currentIdentity[field];
    if (expected !== undefined && (typeof expected !== 'string' || expected.length === 0 || inputBinding[field] !== expected)) return false;
  }
  if (inputBinding.storyId !== undefined && inputBinding.storyId !== receipt.storyId) return false;
  if (inputBinding.storyFilesHash !== undefined && inputBinding.storyFilesHash !== receipt.identity.storyFilesHash) return false;
  const receiptMaterialHash = isRecord(receipt.identity.inputs)
    ? receipt.identity.inputs.materialHash
    : undefined;
  if (receiptMaterialHash !== undefined && receiptMaterialHash !== inputBinding.materialHash) return false;
  const expectedIds = [...new Set(node.inputIds)].sort();
  const actualIds = Object.keys(inputHashes).sort();
  if (expectedIds.length !== node.inputIds.length || causalCanonical(expectedIds) !== causalCanonical(actualIds)) return false;
  return expectedIds.every(inputId =>
    typeof inputHashes[inputId] === 'string'
      && inputHashes[inputId] === currentInputHashes[inputId],
  );
}

export function evaluateCausalDependencies(args: {
  storyId?: string;
  nodes: readonly CausalDependencyNode[];
  currentInputHashes: Record<string, string>;
  previousMaterialHash?: string;
  currentMaterialHash?: string;
  previousStoryFilesHash?: string;
  currentStoryFilesHash?: string;
  previousHeadHash?: string;
  currentHeadHash?: string;
  doneRequired?: boolean;
  rerunNodeIds?: string[];
  rerunEvidence?: readonly CausalDependencyRerunEvidence[];
}): CausalDependencyDecision {
  const changedInputIds = new Set<string>();
  let identityComplete = true;
  const declaredInputIds = new Set<string>();
  for (const node of args.nodes) {
    for (const inputId of node.inputIds) declaredInputIds.add(inputId);
  }
  const currentInputIds = Object.keys(args.currentInputHashes);
  const unknownCurrentInputIds = currentInputIds.filter(inputId => !declaredInputIds.has(inputId));
  const missingCurrentInputIds = [...declaredInputIds].filter(inputId => !Object.prototype.hasOwnProperty.call(args.currentInputHashes, inputId));
  if (unknownCurrentInputIds.length > 0 || missingCurrentInputIds.length > 0) {
    identityComplete = false;
    for (const inputId of unknownCurrentInputIds) changedInputIds.add(inputId);
    for (const inputId of missingCurrentInputIds) changedInputIds.add(inputId);
  }
  for (const node of args.nodes) {
    for (const inputId of node.inputIds) {
      const previous = node.recordedInputHashes[inputId];
      const current = args.currentInputHashes[inputId];
      if (!previous || !current) identityComplete = false;
      if (previous !== current) changedInputIds.add(inputId);
    }
  }
  const changedNodes = args.nodes.filter(node => node.inputIds.some(inputId => changedInputIds.has(inputId))).map(node => node.id);
  const affected = dependencyClosure(args.nodes, new Set(changedNodes));
  const materialIdentityComplete = [args.previousMaterialHash, args.currentMaterialHash]
    .every(value => typeof value === 'string' && value.length > 0);
  const materialDrift = materialIdentityComplete && args.previousMaterialHash !== args.currentMaterialHash;
  const storyFilesMatch = [args.previousStoryFilesHash, args.currentStoryFilesHash]
    .every(value => typeof value === 'string' && value.length > 0)
    && args.previousStoryFilesHash === args.currentStoryFilesHash;
  const storyFilesHashComplete = [args.previousStoryFilesHash, args.currentStoryFilesHash]
    .every(value => typeof value === 'string' && value.length > 0);
  const storyFilesDrift = storyFilesHashComplete && !storyFilesMatch;
  const doneRequiredStrict = args.doneRequired === true;
  let causalDecision: CausalDependencyDecision['causalDecision'] = 'fresh';
  let reason = 'causal dependency inputs match';
  let storyFilesHashAdvisory = false;
  let gateAdmissible = true;
  if (!materialIdentityComplete) {
    causalDecision = 'strict';
    reason = 'material identity is missing or uncomputable; strict refusal applies';
    gateAdmissible = false;
  } else if (!identityComplete) {
    causalDecision = 'strict';
    reason = 'dependency input-hash identity is missing or contains unknown keys; strict refusal applies';
    gateAdmissible = false;
  } else if (affected.size > 0) {
    causalDecision = 'rerun';
    reason = 'affected dependency closure requires fresh execution';
    gateAdmissible = false;
  } else if (storyFilesDrift) {
    causalDecision = 'strict';
    reason = 'storyFilesHash changed; story-owned evidence requires fresh execution';
    gateAdmissible = false;
  } else if (materialDrift && storyFilesMatch && !doneRequiredStrict) {
    causalDecision = 'advisory';
    storyFilesHashAdvisory = true;
    reason = 'whole-tree materialHash drift is unrelated; storyFilesHash matches and specialized evidence may remain advisory';
  } else if (materialDrift) {
    causalDecision = 'strict';
    reason = doneRequiredStrict
      ? 'DONE-required whole-tree materialHash policy remains strict'
      : 'materialHash drift has no admissible causal proof';
    gateAdmissible = false;
  }
  const currentIdentity: CausalDependencyExecutionIdentityBinding = {
    ...(args.storyId !== undefined ? { storyId: args.storyId } : {}),
    ...(args.currentMaterialHash !== undefined ? { materialHash: args.currentMaterialHash } : {}),
    ...(args.currentStoryFilesHash !== undefined ? { storyFilesHash: args.currentStoryFilesHash } : {}),
    ...(args.currentHeadHash !== undefined ? { headHash: args.currentHeadHash } : {}),
  };
  const verifiedRerunNodeIds = [...new Set((args.rerunEvidence ?? []).flatMap(evidence => {
    const node = args.nodes.find(candidate => candidate.id === evidence.nodeId);
    return node && verifyCausalDependencyRerunEvidence(evidence, node, args.currentInputHashes, currentIdentity) ? [node.id] : [];
  }))].sort();
  // `rerunNodeIds` is retained for source compatibility only. It is an
  // untrusted assertion and deliberately has no effect on correctness metrics
  // or gate admission.
  void args.rerunNodeIds;
  const rerunSet = new Set(verifiedRerunNodeIds);
  const missingReruns = [...affected].filter(id => !rerunSet.has(id));
  const affectedNodeRerun = affected.size === 0 ? 0 : Math.round(((affected.size - missingReruns.length) / affected.size) * 100);
  const causalRerunComplete = causalDecision === 'rerun' && missingReruns.length === 0;
  const finalGateAdmissible = causalRerunComplete || (causalDecision !== 'rerun' && gateAdmissible && missingReruns.length === 0);
  // An incomplete dependency identity is a strict refusal, not a measurable
  // stale-rerun observation. Do not turn the derived affected closure into a
  // false-fresh count when the input identity itself is not admissible.
  const falseFresh = identityComplete ? missingReruns.length : 0;
  const { dependencyGraphDigest, currentInputHashesDigest } = causalDependencyContextDigests(
    args.nodes,
    args.currentInputHashes,
  );
  const identityBinding: CausalDependencyDecisionIdentityBinding = {
    ...(args.storyId !== undefined
      ? { storyId: args.storyId, dependencyGraphDigest, currentInputHashesDigest }
      : {}),
    previousMaterialHash: args.previousMaterialHash,
    currentMaterialHash: args.currentMaterialHash,
    previousStoryFilesHash: args.previousStoryFilesHash,
    currentStoryFilesHash: args.currentStoryFilesHash,
    ...(args.previousHeadHash !== undefined ? { previousHeadHash: args.previousHeadHash } : {}),
    ...(args.currentHeadHash !== undefined ? { currentHeadHash: args.currentHeadHash } : {}),
  };
  const decisionCore = {
    schemaVersion: CAUSAL_DEPENDENCY_SCHEMA,
    causalDecision,
    affectedNodeIds: [...affected].sort(),
    invalidatedNodeIds: [...affected].sort(),
    changedInputIds: [...changedInputIds].sort(),
    specializedRerun: causalDecision === 'rerun' ? affected.size : 0,
    affectedNodeRerun,
    falseFresh,
    verifiedRerunNodeIds,
    materialHashStrict: !storyFilesHashAdvisory,
    storyFilesHashAdvisory,
    doneRequiredStrict,
    gateAdmissible: finalGateAdmissible,
    reason: causalRerunComplete ? 'affected dependency closure rerun is complete' : reason,
    identityBinding,
  };
  const authorityMetadata = {
    ...CAUSAL_DEPENDENCY_DECISION_AUTHORITY_METADATA,
  } as const;
  const authority = signCausalAuthorityPayload(decisionCore, process.cwd());
  const authorityBinding = Object.freeze({
    ...authorityMetadata,
    ...authority,
  });
  const decisionWithoutHash = { ...decisionCore, authorityBinding };
  const decision = {
    ...decisionWithoutHash,
    _hash: causalDigest(decisionWithoutHash),
  } as CausalDependencyDecision;
  for (const field of ['affectedNodeIds', 'invalidatedNodeIds', 'changedInputIds', 'verifiedRerunNodeIds'] as const) Object.freeze(decision[field]);
  Object.freeze(decision.identityBinding);
  Object.freeze(decision);
  return decision;
}

export function hasCausalDependencyDecisionIdentityBinding(
  decision: CausalDependencyDecision,
): boolean {
  const binding = decision?.identityBinding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
  return [
    binding.previousMaterialHash,
    binding.currentMaterialHash,
    binding.previousStoryFilesHash,
    binding.currentStoryFilesHash,
  ].every(value => typeof value === 'string' && value.length > 0)
    && (binding.storyId === undefined || typeof binding.storyId === 'string')
    && ((binding.dependencyGraphDigest === undefined && binding.currentInputHashesDigest === undefined)
      || (typeof binding.dependencyGraphDigest === 'string'
        && binding.dependencyGraphDigest.length > 0
        && typeof binding.currentInputHashesDigest === 'string'
        && binding.currentInputHashesDigest.length > 0))
    && (binding.previousHeadHash === undefined || typeof binding.previousHeadHash === 'string')
    && (binding.currentHeadHash === undefined || typeof binding.currentHeadHash === 'string');
}

export function causalDependencyDecisionMatchesCurrentIdentity(
  decision: CausalDependencyDecision,
  current: {
    storyId?: string;
    materialHash?: string;
    storyFilesHash?: string;
    headHash?: string;
    dependencyGraphDigest?: string;
    currentInputHashesDigest?: string;
  },
): boolean {
  if (!verifyCausalDependencyDecision(decision) || !hasCausalDependencyDecisionIdentityBinding(decision)) return false;
  const binding = decision.identityBinding!;
  if (
    binding.currentMaterialHash !== current.materialHash
    || binding.currentStoryFilesHash !== current.storyFilesHash
  ) return false;
  if (current.storyId !== undefined && binding.storyId !== current.storyId) return false;
  if (current.dependencyGraphDigest !== undefined
    && binding.dependencyGraphDigest !== current.dependencyGraphDigest) return false;
  if (current.currentInputHashesDigest !== undefined
    && binding.currentInputHashesDigest !== current.currentInputHashesDigest) return false;
  if (current.headHash !== undefined) return binding.currentHeadHash === current.headHash;
  return binding.currentHeadHash === undefined;
}

export function verifyCausalDependencyDecision(decision: CausalDependencyDecision): boolean {
  if (!decision || typeof decision !== 'object') return false;
  const { _hash: _ignored, authorityBinding, ...payload } = decision;
  const { signature: _signature, signerPublicKey: _signerPublicKey, ...authorityMetadata } = authorityBinding ?? {};
  return decision.schemaVersion === CAUSAL_DEPENDENCY_SCHEMA
    && decision._hash === causalDigest({ ...payload, authorityBinding })
    && causalCanonical(authorityMetadata) === causalCanonical(CAUSAL_DEPENDENCY_DECISION_AUTHORITY_METADATA)
    && verifyCausalAuthorityPayload(
      payload,
      authorityBinding?.signerPublicKey,
      authorityBinding?.signature,
      process.cwd(),
    )
    && (decision.causalDecision !== 'advisory' || hasCausalDependencyDecisionIdentityBinding(decision));
}

export function deriveCausalMetrics(ledger: CausalEvidenceLedger): CausalEvidenceMetrics {
  if (!verifyCausalEvidenceLedger(ledger)) throw new Error('causal metrics refused: execution ledger tampered [causal_ledger_tampered]');
  const uniqueKeys = new Set(ledger.executions.map(entry => entry.executionKey));
  if (uniqueKeys.size !== ledger.executions.length) throw new Error('causal metrics refused: duplicate execution key [causal_ledger_duplicate_key]');
  const commandExecutions = ledger.executions.filter(entry => entry.disposition === 'executed').length;
  const commandReruns = ledger.executions.reduce((sum, entry) => sum + Math.max(0, entry.executionAttempts - 1), 0);
  return {
    intentCount: ledger.intentCount,
    uniqueExecutionKeys: uniqueKeys.size,
    commandExecutions,
    cacheHitRate: ledger.intentCount === 0 ? 0 : Math.max(0, (ledger.intentCount - commandExecutions) / ledger.intentCount),
    commandReruns,
    commitFailureReruns: ledger.commitFailureReruns,
    unrelatedSpecializedRerun: ledger.unrelatedSpecializedRerun,
    affectedNodeRerun: ledger.affectedNodeRerun,
    falseFresh: ledger.falseFresh,
  };
}

export function renderCausalMetrics(metrics: CausalEvidenceMetrics): string {
  return `CausalEvidence: intentCount=${metrics.intentCount} uniqueExecutionKeys=${metrics.uniqueExecutionKeys} commandExecutions=${metrics.commandExecutions} cacheHitRate=${Math.round(metrics.cacheHitRate * 100)}% commandReruns=${metrics.commandReruns} commitFailureReruns=${metrics.commitFailureReruns} unrelatedSpecializedRerun=${metrics.unrelatedSpecializedRerun} affectedNodeRerun=${metrics.affectedNodeRerun}% falseFresh=${metrics.falseFresh}`;
}

export interface CausalImportArgs {
  receipt: CausalEvidenceReceipt | null | undefined;
  expectedStoryId: string;
  expectedExecutionKey: string;
  expectedMaterialHash?: string;
  expectedStoryFilesHash?: string;
  currentIdentity?: CausalExecutionIdentityInput | (() => CausalExecutionIdentityInput | undefined);
  revalidate: () => boolean;
  commit: () => void;
  maxAttempts?: number;
  batch?: CausalEvidenceBatch;
}

/** Import is a separate transaction: failures retry commit/index work only. */
export function importCausalEvidenceReceipt(args: CausalImportArgs): { receiptHash: string; attempts: number; commandReruns: 0 } {
  const receipt = args.receipt;
  if (!receipt || !verifyCausalEvidenceReceipt(receipt, args.expectedExecutionKey)) {
    throw new Error('causal evidence import refused: raw, unsigned, partial, receiptless, or tampered receipt [causal_receipt_invalid]');
  }
  if (receipt.storyId !== args.expectedStoryId) throw new Error('causal evidence import refused: story mismatch [causal_receipt_story_mismatch]');
  if (args.expectedMaterialHash) {
    const recordedMaterial = receipt.identity.inputs && isRecord(receipt.identity.inputs)
      ? receipt.identity.inputs.materialHash
      : undefined;
    if (recordedMaterial !== args.expectedMaterialHash) throw new Error('causal evidence import refused: materialHash changed [causal_receipt_material_mismatch]');
  }
  if (args.expectedStoryFilesHash && receipt.identity.storyFilesHash !== args.expectedStoryFilesHash) throw new Error('causal evidence import refused: storyFilesHash changed [causal_receipt_story_files_mismatch]');
  const maxAttempts = Math.max(1, Math.floor(args.maxAttempts ?? 2));
  let attempts = 0;
  let lastError: unknown;
  while (attempts < maxAttempts) {
    attempts++;
    if (!args.revalidate()) throw new Error('causal evidence import refused: lease/index/material revalidation failed [causal_import_revalidation_failed]');
    const currentIdentity = typeof args.currentIdentity === 'function' ? args.currentIdentity() : args.currentIdentity;
    if (currentIdentity) {
      const currentKey = createCausalExecutionKey(currentIdentity);
      const identityMatchesCurrent = causalExecutionIdentityMatchesCurrent(receipt.identity, {
        storyId: currentIdentity.storyId,
        cwd: currentIdentity.cwd,
        storyFilesHash: currentIdentity.storyFilesHash ?? '',
        effectiveEnvironment: currentIdentity.effectiveEnvironment ?? {},
        runtimeVersion: currentIdentity.runtimeVersion ?? '',
        toolVersion: currentIdentity.toolVersion ?? '',
      });
      if (
        !currentKey.reusable
        || currentKey.key !== receipt.executionKey
        || causalCanonical(currentKey.identity) !== causalCanonical(receipt.identity)
        || !identityMatchesCurrent
      ) {
        throw new Error('causal evidence import refused: execution identity changed or is incomplete [causal_receipt_identity_mismatch]');
      }
    }
    try {
      args.commit();
      if (args.batch && attempts > 1) {
        args.batch.ledger.commitFailureReruns += attempts - 1;
        refreshLedgerHash(args.batch);
      }
      return { receiptHash: receipt.receiptHash, attempts, commandReruns: 0 };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`causal evidence import failed after ${attempts} transaction attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)} [causal_import_failed]`);
}
