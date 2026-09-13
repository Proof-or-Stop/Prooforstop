import { withExecutableDigestObservation, readObservedExecutableDigest } from './executable-digest-observation.js';
import { VERIFICATION_RECEIPT_BUNDLE_V5 } from './artifact-schema.js';
export { VERIFICATION_RECEIPT_BUNDLE_V5 } from './artifact-schema.js';
import { executionImplementationIdentity } from './execution-implementation.js';
import { execFileSync } from 'child_process';
import { createHash, createPublicKey, randomBytes, randomUUID } from 'crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'path';
import type {
  VerificationAssertionReceiptV1,
  VerificationAssertionReceiptV2,
  VerificationEvidenceReceipt,
  VerificationExecutionReceiptV2,
  VerificationExecutionReceiptV3,
  VerificationReuseReceiptV1,
  VerificationReceiptBundleV2,
  VerificationReceiptBundleV3,
  VerificationReceiptBundleV4,
  VerificationReceiptBundleV5,
  VerificationFreshnessBinding,
  VerificationPublicationBindingV1,
  VerificationReceiptBundleBindingV1,
  VerificationRecordAuthenticityV1,
  VerificationSplitReceipt,
} from './types.js';
import { parseAllowlistedCommand, type SingleCommandExecutionResult } from './validation-executor.js';
import {
  computeCanonicalDigest,
  readArtifact,
  verifyArtifactDigest,
  writeArtifact,
} from './evidence/artifact-store.js';
import type { EvidenceArtifact } from './evidence/types.js';
import {
  assessVerifierDependencyManifest,
  currentGitHead,
  currentMaterialHash,
  currentStoryFilesHash,
  isCanonicalGitHeadHash,
  isCanonicalSha256Hash,
  type VerifierDependencyAssessment,
} from './evidence-freshness.js';
import { closedEnvironmentForVerificationReuseCapsuleInvocation, VERIFICATION_DEPENDENCY_MANIFEST_BINDING_V2 } from './verification-reuse-capsule.js';
import { effectiveValidationCommandEnvironment } from './validation-command-environment.js';
import { buildValidationExecutableLookup, validationCommandUsesShell } from './validation-evidence-reuse.js';
import {
  canonicalDigest as signingCanonicalDigest,
  exportPublicKeyRaw,
  importPrivateKeyRaw,
  signCanonical,
  verifyCanonical,
} from './authority-signing.js';

export const VERIFICATION_OUTPUT_SCHEMA_VERSION = 'proof-or-stop.verification-output.v1' as const;
export const VERIFICATION_EXECUTION_RECEIPT_VERSION = 'proof-or-stop.verification-execution-receipt.v2' as const;
export const VERIFICATION_EXECUTION_RECEIPT_V3 = 'proof-or-stop.verification-execution-receipt.v3' as const;
export const VERIFICATION_ASSERTION_RECEIPT_VERSION = 'proof-or-stop.verification-assertion-receipt.v1' as const;
export const VERIFICATION_ASSERTION_RECEIPT_V2 = 'proof-or-stop.verification-assertion-receipt.v2' as const;
export const VERIFICATION_RECEIPT_BUNDLE_VERSION = 'proof-or-stop.verification-receipt-bundle.v2' as const;
export const VERIFICATION_RECEIPT_BUNDLE_V3 = 'proof-or-stop.verification-receipt-bundle.v3' as const;
export const VERIFICATION_RECEIPT_BUNDLE_V4 = 'proof-or-stop.verification-receipt-bundle.v4' as const;

const VERIFICATION_PUBLICATION_BINDING_V1 = 'proof-or-stop.verification-publication-binding.v1' as const;
export const VERIFICATION_RECEIPT_BUNDLE_BINDING_V1 = 'proof-or-stop.verification-receipt-bundle-binding.v1' as const;
export const VERIFICATION_REUSE_RECEIPT_VERSION = 'proof-or-stop.verification-reuse-receipt.v1' as const;
export const VERIFICATION_MATCHER_VERSION = 'literal-includes.v1' as const;
export const VERIFICATION_CAPTURE_SEMANTICS = 'combined-stdout-stderr.v1' as const;
export const VERIFICATION_OUTPUT_TAIL_CHARS = 4000;
export const VERIFICATION_RECORD_AUTHENTICITY_V1 = 'proof-or-stop.verification-record-authenticity.v1' as const;
const VERIFICATION_SIGNING_DOMAIN = 'proof-or-stop.verification-record.v1' as const;
const VERIFICATION_SIGNER_KEY_FILE = 'proof-or-stop-verification-receipt-signer-v1.key';

export interface VerificationOutputArtifactPayload {
  schemaVersion: typeof VERIFICATION_OUTPUT_SCHEMA_VERSION;
  captureSemantics: typeof VERIFICATION_CAPTURE_SEMANTICS;
  output: string;
  outputDigest: string;
}

export interface CreateVerificationExecutionInput {
  projectRoot: string;
  storyId: string;
  command: string;
  cwd: string;
  run: SingleCommandExecutionResult;
  executedAt?: string;
  manifestPath?: string;
  /** Precomputed immediately before receipt issuance after the run completed. */
  preparedIdentity?: PreparedVerificationExecutionIdentity;
}

const VERIFICATION_EXECUTION_LOCK_VERSION = 'proof-or-stop.verification-execution-lock.v1' as const;
const VERIFICATION_EXECUTION_KEY_VERSION = 'proof-or-stop.verification-execution-key.v1' as const;
const VERIFICATION_EXECUTION_LOCK_INITIALIZATION_MS = 30_000;
const VERIFICATION_EXECUTION_TICKET_VERSION = 'proof-or-stop.verification-execution-ticket.v1' as const;
// Longer than the evidence-command ceiling; a legitimate waiter must outlive the producer.
const VERIFICATION_EXECUTION_LOCK_DEADLINE_MS = 130 * 60_000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Stable repository-local producer lock. The digest subject is ONLY the already
 * normalized execution key; selector, intent type and evidence kind never enter it.
 */
export function verificationExecutionLockPath(projectRoot: string, executionKey: string): string {
  const digest = computeCanonicalDigest({
    schemaVersion: VERIFICATION_EXECUTION_LOCK_VERSION,
    executionKey,
  });
  return join(projectRoot, '.proof-or-stop', 'locks', 'verification-execution', `${digest}.lock`);
}

/** Selector-free identity used by every verification producer entrypoint. */
export function createVerificationExecutionKey(input: {
  command: string;
  cwd: string;
  effectiveTimeoutMs: number;
  preparedIdentity: PreparedVerificationExecutionIdentity;
}): string {
  return computeCanonicalDigest({
    schemaVersion: VERIFICATION_EXECUTION_KEY_VERSION,
    command: input.command,
    cwd: input.cwd,
    effectiveTimeoutMs: input.effectiveTimeoutMs,
    executionIdentityDigest: input.preparedIdentity.executionIdentityDigest,
  });
}

interface VerificationExecutionTicket {
  schemaVersion: typeof VERIFICATION_EXECUTION_TICKET_VERSION;
  ownerId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

/** Only ESRCH proves a local owner dead. PID reuse, EPERM and unknown hosts
 * conservatively retain ownership; elapsed heartbeat age is never authority. */
function verificationExecutionTicketOwnerIsDead(owner: VerificationExecutionTicket): boolean {
  if (owner.hostname !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error: any) {
    // PROBE: every uncertain liveness outcome protects the existing owner.
    return error?.code === 'ESRCH';
  }
}

function readVerificationExecutionTickets(lockPath: string): Array<{ path: string; name: string; owner: VerificationExecutionTicket }> {
  // A choosing token can atomically become a ticket after readdir. Dropping
  // its vanished old name would hide an earlier contender; restart the whole
  // snapshot instead. Sustained instability is a refusal, never an empty queue.
  snapshot: for (let attempt = 0; attempt < 32; attempt++) {
    const names = readdirSync(lockPath);
    // The previous fixed-path protocol must not be silently ignored. Recovery of
    // a legacy/mixed or incomplete layout needs explicit operator inspection.
    if (names.includes('owner.json')) {
      throw new Error('verification execution lock legacy/mixed ownership [verification_execution_lock_legacy_layout]');
    }
    const tickets: Array<{ path: string; name: string; owner: VerificationExecutionTicket }> = [];
    for (const name of names) {
      if (name === 'protocol' || /^\.[0-9a-f-]{36}\.preparing$/.test(name)) continue;
      const match = /^(?:([0-9]{16})-([0-9a-f-]{36})\.ticket|([0-9a-f-]{36})\.choosing)$/.exec(name);
      if (!match) throw new Error('verification execution lock unknown entry [verification_execution_lock_invalid_owner]');
      if (match[1] && (!Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1)) {
        throw new Error('verification execution lock invalid sequence [verification_execution_lock_invalid_owner]');
      }
      const path = join(lockPath, name);
      try {
        if (!lstatSync(path).isFile()) throw new Error('verification execution ticket is not a regular file');
        const owner = JSON.parse(readFileSync(path, 'utf8')) as VerificationExecutionTicket;
        if (owner.schemaVersion !== VERIFICATION_EXECUTION_TICKET_VERSION || owner.ownerId !== (match[2] ?? match[3])
          || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.hostname !== 'string' || !owner.hostname
          || typeof owner.acquiredAt !== 'string' || !Number.isFinite(Date.parse(owner.acquiredAt))) {
          throw new Error('verification execution ticket has incomplete ownership');
        }
        if (verificationExecutionTicketOwnerIsDead(owner)) {
          // This exact UUID path is never reused. Concurrent reclaimers therefore
          // cannot delete or heartbeat a replacement holder through fixed-path ABA.
          rmSync(path, { force: true });
        } else tickets.push({ path, name, owner });
      } catch (error: any) {
        // PROBE: removal and choosing-to-ticket publication both invalidate the
        // observation. Never omit a potentially live predecessor from a snapshot.
        if (error?.code === 'ENOENT') continue snapshot;
        throw new Error(`verification execution lock invalid ownership [verification_execution_lock_invalid_owner]: ${String(error)}`);
      }
    }
    return tickets;
  }
  throw new Error('verification execution lock unstable snapshot [verification_execution_lock_invalid_owner]');
}

async function acquireVerificationExecutionLock(lockPath: string): Promise<() => void> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const ownerId = randomUUID();
  const deadline = Date.now() + VERIFICATION_EXECUTION_LOCK_DEADLINE_MS;
  const protocolPath = join(lockPath, 'protocol');
  const preparingPath = join(lockPath, `.${ownerId}.preparing`);
  try {
    mkdirSync(lockPath);
    writeFileSync(preparingPath, VERIFICATION_EXECUTION_TICKET_VERSION, { flag: 'wx' });
    renameSync(preparingPath, protocolPath);
  } catch (error: any) {
    // PROBE: another process initialized this permanent queue root.
    if (error?.code !== 'EEXIST') throw error;
  }
  const initializationDeadline = Date.now() + VERIFICATION_EXECUTION_LOCK_INITIALIZATION_MS;
  while (!existsSync(protocolPath)) {
    if (existsSync(join(lockPath, 'owner.json'))) {
      throw new Error('verification execution lock legacy/mixed ownership [verification_execution_lock_legacy_layout]');
    }
    if (Date.now() > initializationDeadline) {
      throw new Error('verification execution lock incomplete layout [verification_execution_lock_invalid_owner]');
    }
    await delay(25);
  }
  if (lstatSync(lockPath).isSymbolicLink() || !lstatSync(protocolPath).isFile()
    || readFileSync(protocolPath, 'utf8') !== VERIFICATION_EXECUTION_TICKET_VERSION) {
    throw new Error('verification execution lock unknown protocol [verification_execution_lock_invalid_owner]');
  }
  readVerificationExecutionTickets(lockPath);
  const owner: VerificationExecutionTicket = {
    schemaVersion: VERIFICATION_EXECUTION_TICKET_VERSION, ownerId, pid: process.pid,
    hostname: hostname(), acquiredAt: new Date().toISOString(),
  };
  const choosingPath = join(lockPath, `${ownerId}.choosing`);
  let ticketPath = '';
  try {
    // Publish a complete choosing token atomically before taking the bakery
    // number; every waiting acquisition remains visible while it chooses.
    writeFileSync(preparingPath, JSON.stringify(owner), { flag: 'wx' });
    renameSync(preparingPath, choosingPath);
    const numbers = readVerificationExecutionTickets(lockPath)
      .filter(candidate => candidate.name.endsWith('.ticket')).map(candidate => Number(candidate.name.slice(0, 16)));
    const number = Math.max(0, ...numbers) + 1;
    if (!Number.isSafeInteger(number)) throw new Error('verification execution lock ticket sequence exhausted');
    ticketPath = join(lockPath, `${String(number).padStart(16, '0')}-${ownerId}.ticket`);
    renameSync(choosingPath, ticketPath);
    while (true) {
      const candidates = readVerificationExecutionTickets(lockPath);
      if (!candidates.some(candidate => candidate.path === ticketPath)) {
        throw new Error('verification execution lock lost ownership [verification_execution_lock_lost]');
      }
      const choosing = candidates.some(candidate => candidate.name.endsWith('.choosing'));
      const first = candidates.filter(candidate => candidate.name.endsWith('.ticket'))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)[0];
      if (!choosing && first?.path === ticketPath) break;
      if (Date.now() > deadline) {
        throw new Error('verification execution lock timeout [verification_execution_lock_timeout]');
      }
      await delay(25);
    }
  } catch (error) {
    // MUTATION: release only this acquisition's never-reused paths, then retain
    // the original refusal. No recursive deletion of the shared queue root.
    rmSync(preparingPath, { force: true });
    rmSync(choosingPath, { force: true });
    if (ticketPath) rmSync(ticketPath, { force: true });
    throw error;
  }
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(ticketPath, now, now);
    } catch {
      // DEBUG: heartbeat is descriptive only, never lease/liveness authority.
      // A missing exact ticket can never redirect this write to a successor.
    }
  }, 5_000);
  heartbeat.unref();
  return () => {
    clearInterval(heartbeat);
    rmSync(ticketPath, { force: true });
  };
}

/** Acquire multiple producer identities in sorted order to avoid lock-order cycles. */
export async function withVerificationExecutionLocks<T>(
  projectRoot: string,
  executionKeys: Iterable<string>,
  fn: () => Promise<T>,
): Promise<T> {
  const paths = [...new Set([...executionKeys].map(key => verificationExecutionLockPath(projectRoot, key)))].sort();
  const releases: Array<() => void> = [];
  try {
    for (const path of paths) releases.push(await acquireVerificationExecutionLock(path));
    return await fn();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/**
 * Fail closed if any execution-affecting identity changed between the launch
 * boundary and the receipt boundary. The stable diagnostic is consumed by CLI
 * handlers and smoke evidence.
 */
export function assertVerificationInputUnchanged(
  before: PreparedVerificationExecutionIdentity,
  after: PreparedVerificationExecutionIdentity,
): void {
  if (before.executionIdentityDigest !== after.executionIdentityDigest) {
    throw new Error('receiptIssued=false reason=input_changed_during_execution');
  }
}

export interface CreateVerificationAssertionInput {
  projectRoot: string;
  storyId: string;
  executionReceipt: VerificationExecutionReceiptV2 | VerificationExecutionReceiptV3;
  intentRef: string;
  selector: string;
  reuseReceipt?: VerificationReuseReceiptV1;
  timeoutOverride?: {
    timeoutMs: number;
    defaultTimeoutMs: number;
    reason: string;
  };
}

/** Strict publication coordinates are captured by the producer, never supplied by a caller. */
export function captureVerificationFreshness(cwd: string, projectRoot: string): VerificationFreshnessBinding {
  const headHash = currentGitHead(cwd);
  const materialHash = currentMaterialHash(cwd, 'HEAD', projectRoot);
  const storyFilesHash = currentStoryFilesHash(cwd, 'HEAD', projectRoot);
  if (!isCanonicalGitHeadHash(headHash) || !isCanonicalSha256Hash(materialHash) || !isCanonicalSha256Hash(storyFilesHash)) {
    throw new Error('receiptIssued=false reason=incomplete_freshness_hash_binding');
  }
  return { headHash, materialHash, storyFilesHash };
}

export function assertVerificationFreshnessUnchanged(
  before: VerificationFreshnessBinding, after: VerificationFreshnessBinding,
): void {
  if (computeCanonicalDigest(before) !== computeCanonicalDigest(after)) {
    throw new Error('receiptIssued=false reason=freshness_changed_during_execution');
  }
}

/** Current publication signs coordinates separately from immutable execution bytes. */
export function createCurrentVerificationAssertionReceipt(
  input: CreateVerificationAssertionInput & { executionReceipt: VerificationExecutionReceiptV3; freshness: VerificationFreshnessBinding },
): VerificationReceiptBundleV5 {
  const current = captureVerificationFreshness(input.executionReceipt.cwd, input.projectRoot);
  // A follower may observe the producer's metadata-only commit. Preserve that
  // producer's exact signed tuple; never move its observed material coordinates.
  if (current.materialHash !== input.freshness.materialHash || current.storyFilesHash !== input.freshness.storyFilesHash) {
    throw new Error('receiptIssued=false reason=freshness_changed_during_execution');
  }
  const legacy = createVerificationAssertionReceipt(input) as VerificationReceiptBundleV4;
  const { schemaVersion: _legacySchema, ...links } = legacy.bundleBinding;
  const subject = {
    schemaVersion: VERIFICATION_PUBLICATION_BINDING_V1,
    ...links,
    storyId: input.storyId,
    freshness: { ...input.freshness },
  };
  const digested = { ...subject, publicationDigest: computeCanonicalDigest(subject) };
  const publicationBinding: VerificationPublicationBindingV1 = {
    ...digested,
    authenticity: issueVerificationAuthenticity(input.executionReceipt.cwd, 'publication', digested),
  };
  return { ...legacy, schemaVersion: VERIFICATION_RECEIPT_BUNDLE_V5, publicationBinding } as VerificationReceiptBundleV5;
}

export interface VerificationReceiptValidation {
  ok: boolean;
  kind: 'legacy-readable-only' | 'split-v2' | 'split-v3' | 'split-v4' | 'split-v5';
  reusable: boolean;
  promotable: false;
  errors: string[];
  output?: string;
}

export interface PreparedVerificationExecutionIdentity {
  /** Locally observed with this identity; never caller-authored receipt authority. */
  implementationDigest: string;
  reusable: boolean;
  reason: string | null;
  dependency: VerifierDependencyAssessment;
  executable: string;
  argv: string[];
  environmentDigest: string;
  toolchainDigest: string;
  evidenceInputDigest: string | null;
  executionIdentityDigest: string;
}

export interface VerificationReuseDecision {
  reusable: boolean;
  reason: string | null;
  identity: PreparedVerificationExecutionIdentity;
  executionReceipt?: VerificationExecutionReceiptV3;
  reuseReceipt?: VerificationReuseReceiptV1;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function gitCommonDir(gitCwd: string): string {
  const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: gitCwd, encoding: 'utf8' }).trim();
  return realpathSync(isAbsolute(raw) ? raw : resolve(gitCwd, raw));
}

function verificationSignerKeyPath(gitCwd: string): string {
  return join(gitCommonDir(gitCwd), VERIFICATION_SIGNER_KEY_FILE);
}

function readOrCreateVerificationPrivateKey(gitCwd: string): string {
  const path = verificationSignerKeyPath(gitCwd);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(path, randomBytes(32).toString('base64'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  return readFileSync(path, 'utf8').trim();
}

function publicKeyForPrivate(privateKey: string): string {
  return exportPublicKeyRaw(createPublicKey(importPrivateKeyRaw(privateKey)));
}

function trustedVerificationPublicKey(gitCwd: string): string | null {
  try { return publicKeyForPrivate(readFileSync(verificationSignerKeyPath(gitCwd), 'utf8').trim()); }
  catch { return null; }
}

function verificationSignatureSubject(domain: VerificationRecordAuthenticityV1['domain'], record: unknown): unknown {
  return { schemaVersion: VERIFICATION_SIGNING_DOMAIN, domain, record };
}

function issueVerificationAuthenticity(
  gitCwd: string,
  domain: VerificationRecordAuthenticityV1['domain'],
  record: unknown,
): VerificationRecordAuthenticityV1 {
  const privateKey = readOrCreateVerificationPrivateKey(gitCwd);
  const signerPublicKey = publicKeyForPrivate(privateKey);
  return {
    schemaVersion: VERIFICATION_RECORD_AUTHENTICITY_V1,
    domain,
    keyId: `sha256:${signingCanonicalDigest(signerPublicKey)}`,
    signerPublicKey,
    signature: signCanonical(verificationSignatureSubject(domain, record), privateKey),
  };
}

/** Private to one public validation call; key bytes and signatures are never cached. */
function verificationLocationReader(gitCwd: string): { read: (cwd: string) => string | null; unchanged: (cwd: string) => boolean } {
  function locate(): { cwd: string; commonDir: string } {
    // Use the existing single-result Git parser: paths may contain newlines.
    return { cwd: realpathSync(gitCwd), commonDir: gitCommonDir(gitCwd) };
  }
  let attempted = false;
  let location: ReturnType<typeof locate> | undefined;
  return {
    read(cwd) {
      if (cwd !== gitCwd) return null;
      try {
        if (!attempted) { attempted = true; location = locate(); }
        if (!location) return null;
        return publicKeyForPrivate(readFileSync(join(location.commonDir, VERIFICATION_SIGNER_KEY_FILE), 'utf8').trim());
      } catch { return null; }
    },
    unchanged(cwd) {
      if (cwd !== gitCwd) return false;
      if (!attempted) return true; // Legacy unsigned receipts do not discover a signer.
      try { return location !== undefined && JSON.stringify(locate()) === JSON.stringify(location); }
      catch { return false; }
    },
  };
}

function verifyVerificationAuthenticity(
  gitCwd: string,
  domain: VerificationRecordAuthenticityV1['domain'],
  record: unknown,
  authenticity: VerificationRecordAuthenticityV1 | undefined,
  readTrusted: (cwd: string) => string | null = () => trustedVerificationPublicKey(gitCwd),
): boolean {
  const trusted = readTrusted(gitCwd);
  return Boolean(
    trusted
    && authenticity
    && authenticity.schemaVersion === VERIFICATION_RECORD_AUTHENTICITY_V1
    && authenticity.domain === domain
    && authenticity.signerPublicKey === trusted
    && authenticity.keyId === `sha256:${signingCanonicalDigest(trusted)}`
    && verifyCanonical(verificationSignatureSubject(domain, record), authenticity.signature, trusted),
  );
}

function executionDigestSubject<T extends VerificationExecutionReceiptV2 | VerificationExecutionReceiptV3>(receipt: T): Omit<T, 'executionReceiptDigest' | 'authenticity'> {
  const { executionReceiptDigest: _digest, authenticity: _authenticity, ...subject } = receipt as T & { authenticity?: VerificationRecordAuthenticityV1 };
  return subject as Omit<T, 'executionReceiptDigest' | 'authenticity'>;
}

function assertionDigestSubject<T extends VerificationAssertionReceiptV1 | VerificationAssertionReceiptV2>(receipt: T): Omit<T, 'assertionReceiptDigest' | 'authenticity'> {
  const { assertionReceiptDigest: _digest, authenticity: _authenticity, ...subject } = receipt as T & { authenticity?: VerificationRecordAuthenticityV1 };
  return subject as Omit<T, 'assertionReceiptDigest' | 'authenticity'>;
}

function bundleDigestSubject(receipt: VerificationReceiptBundleV4): VerificationReceiptBundleBindingV1 {
  return receipt.bundleBinding;
}

function reuseDigestSubject(receipt: VerificationReuseReceiptV1): Omit<VerificationReuseReceiptV1, 'reuseReceiptDigest' | 'authenticity'> {
  const { reuseReceiptDigest: _digest, authenticity: _authenticity, ...subject } = receipt;
  return subject;
}

function executionIdentityDigestFromReceipt(receipt: VerificationExecutionReceiptV3): string {
  return computeCanonicalDigest({
    schemaVersion: 'proof-or-stop.verification-execution-identity.v1',
    command: receipt.command,
    executable: receipt.executable,
    argv: receipt.argv,
    cwd: receipt.cwd,
    effectiveTimeoutMs: receipt.effectiveTimeoutMs,
    environmentDigest: receipt.environmentDigest,
    toolchainDigest: receipt.toolchainDigest,
    platform: receipt.platform,
    arch: receipt.architecture,
    nodeVersion: receipt.nodeVersion,
    captureSemantics: receipt.captureSemantics,
    evidenceInputDigest: receipt.evidenceInputDigest,
  });
}

function executableFileIdentity(
  executable: string,
  cwd: string,
  environment: Record<string, string>,
): { path: string; digest: string } | null {
  // Reuse the established explicit-path/PATHEXT envelope. Relative and empty
  // PATH entries belong to the child cwd, not this CLI's ambient directory.
  const windows = process.platform === 'win32';
  const lookup = buildValidationExecutableLookup(executable, environment, process.platform);
  const directories = windows
    ? [cwd, ...(environment.PATH ?? '').split(';')]
    : (environment.PATH ?? '/usr/bin:/bin').split(':');
  const candidates = lookup.kind === 'explicit'
    ? lookup.commandCandidates.map(candidate => resolve(cwd, candidate))
    : directories.flatMap(directory => lookup.commandCandidates.map(candidate => resolve(cwd, directory, candidate)));
  for (const candidate of candidates) {
    let path: string;
    try {
      accessSync(candidate, constants.X_OK);
      path = realpathSync(candidate);
      if (!lstatSync(path).isFile()) continue;
    } catch {
      // Like PATH lookup, skip absent/non-executable entries. No candidate means
      // identity preparation fails closed, even for ordinary non-reusable work.
      continue;
    }
    try {
      return { path, digest: readObservedExecutableDigest(path) };
    } catch {
      // The first executable wins. Unreadable bytes cannot justify using a later
      // PATH candidate that the runner would not execute.
      return null;
    }
  }
  return null;
}

// Explicit synchronous planning and refresh scopes own this observation.
// Current plans, launches, completion and publication retain independent reads.
let planningObservation: { digest?: string } | undefined;
export function withVerificationPlanningObservation<T>(plan: () => T): T {
  const previous = planningObservation;
  planningObservation = {};
  try { return plan(); }
  finally { planningObservation = previous; }
}

/** A separate synchronous refresh scope; execution and publication remain outside. */
export function withVerificationRefreshObservation<T>(read: () => T): T {
  return withVerificationPlanningObservation(read);
}

function planningImplementationIdentityDigest(): string {
  if (!planningObservation) return executionImplementationIdentity().digest;
  return planningObservation.digest ??= executionImplementationIdentity().digest;
}

export function prepareVerificationExecutionIdentity(input: {
  command: string;
  cwd: string;
  effectiveTimeoutMs: number;
  manifestPath?: string;
}): PreparedVerificationExecutionIdentity {
  return withExecutableDigestObservation(() => prepareVerificationExecutionIdentityObserved(input));
}

function prepareVerificationExecutionIdentityObserved(
  input: Parameters<typeof prepareVerificationExecutionIdentity>[0],
): PreparedVerificationExecutionIdentity {
  const parsed = parseAllowlistedCommand(input.command);
  const dependency = assessVerifierDependencyManifest({
    gitCwd: input.cwd,
    manifestPath: input.manifestPath,
    executable: parsed.executable,
    argv: parsed.args,
  });
  // Match runSingleAllowlistedCommand's invocation decision, independently of
  // whether dependency metadata grants this execution persistent reuse authority.
  const environment = closedEnvironmentForVerificationReuseCapsuleInvocation({
    executable: parsed.executable,
    argv: parsed.args,
    cwd: input.cwd,
  }) ?? effectiveValidationCommandEnvironment(process.env, undefined, input.cwd);
  const environmentDigest = computeCanonicalDigest(
    Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)),
  );
  const executableIdentity = executableFileIdentity(parsed.executable, input.cwd, environment);
  const nodeIdentity = executableFileIdentity(process.execPath, input.cwd, environment);
  const usesShell = validationCommandUsesShell({}, process.platform);
  const shellExecutableCommand = usesShell
    ? String(environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe')
    : null;
  const shellIdentity = shellExecutableCommand
    ? executableFileIdentity(shellExecutableCommand, input.cwd, environment)
    : null;
  if (!executableIdentity || !nodeIdentity || (usesShell && !shellIdentity)) {
    throw new Error('verification executable resolution is unprovable [incomplete_toolchain_identity]');
  }
  const implementationDigest = planningImplementationIdentityDigest();
  const toolchainDigest = computeCanonicalDigest({
    implementationDigest,
    executable: parsed.executable,
    executableIdentity,
    nodeExecutable: process.execPath,
    nodeIdentity,
    ...(usesShell ? { shellExecutableCommand, shellIdentity } : {}),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  });
  const reason = dependency.reason;
  const executionIdentityDigest = computeCanonicalDigest({
    schemaVersion: 'proof-or-stop.verification-execution-identity.v1',
    command: input.command,
    executable: parsed.executable,
    argv: parsed.args,
    cwd: input.cwd,
    effectiveTimeoutMs: input.effectiveTimeoutMs,
    environmentDigest,
    toolchainDigest,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    captureSemantics: VERIFICATION_CAPTURE_SEMANTICS,
    evidenceInputDigest: dependency.evidenceInputDigest,
  });
  return {
    implementationDigest,
    reusable: dependency.reusable,
    reason,
    dependency,
    executable: parsed.executable,
    argv: [...parsed.args],
    environmentDigest,
    toolchainDigest,
    evidenceInputDigest: dependency.evidenceInputDigest,
    executionIdentityDigest,
  };
}

function boundedOutputTail(output: string): string {
  return output.length <= VERIFICATION_OUTPUT_TAIL_CHARS
    ? output
    : output.slice(output.length - VERIFICATION_OUTPUT_TAIL_CHARS);
}

export function isSplitVerificationReceipt(
  receipt: VerificationEvidenceReceipt | undefined,
): receipt is VerificationSplitReceipt {
  const version = (receipt as VerificationSplitReceipt | undefined)?.schemaVersion;
  return version === VERIFICATION_RECEIPT_BUNDLE_VERSION
    || version === VERIFICATION_RECEIPT_BUNDLE_V3
    || version === VERIFICATION_RECEIPT_BUNDLE_V4
    || version === VERIFICATION_RECEIPT_BUNDLE_V5;
}

export function isReusableVerificationReceipt(
  receipt: VerificationEvidenceReceipt | undefined,
): receipt is VerificationReceiptBundleV5 {
  return (receipt as VerificationReceiptBundleV5 | undefined)?.schemaVersion === VERIFICATION_RECEIPT_BUNDLE_V5;
}

/** Recompute, rather than trust, the capsule authority carried by a current receipt. */
export function verificationReceiptHasCurrentReuseAuthority(
  receipt: VerificationEvidenceReceipt | undefined,
): receipt is VerificationReceiptBundleV5 {
  if (!isReusableVerificationReceipt(receipt)) return false;
  const execution = receipt.executionReceipt;
  if (execution.dependencyManifest?.schemaVersion !== VERIFICATION_DEPENDENCY_MANIFEST_BINDING_V2) return false;
  try {
    const current = prepareVerificationExecutionIdentity({
      command: execution.command,
      cwd: execution.cwd,
      effectiveTimeoutMs: execution.effectiveTimeoutMs,
      manifestPath: execution.dependencyManifest.path,
    });
    return current.reusable
      && current.executionIdentityDigest === execution.executionIdentityDigest
      && current.dependency.manifestBinding?.schemaVersion === VERIFICATION_DEPENDENCY_MANIFEST_BINDING_V2
      && current.dependency.manifestBinding.manifestDigest === execution.dependencyManifest.manifestDigest
      && current.dependency.manifestBinding.capsulePolicyDigest === execution.dependencyManifest.capsulePolicyDigest;
  } catch {
    return false;
  }
}

/** A previously capsule-authoritative record must rerun when that authority is lost. */
export function verificationReceiptLostCurrentReuseAuthority(
  receipt: VerificationEvidenceReceipt | undefined,
): boolean {
  if (!isSplitVerificationReceipt(receipt)) return false;
  const execution = receipt.executionReceipt;
  return execution.schemaVersion === VERIFICATION_EXECUTION_RECEIPT_V3
    && execution.dependencyManifest?.schemaVersion === VERIFICATION_DEPENDENCY_MANIFEST_BINDING_V2
    && !verificationReceiptHasCurrentReuseAuthority(receipt);
}

export function createVerificationExecutionReceipt(
  input: CreateVerificationExecutionInput,
): VerificationExecutionReceiptV3 {
  const outputDigest = sha256Text(input.run.output);
  const artifact = writeArtifact<VerificationOutputArtifactPayload>(input.projectRoot, {
    artifactKind: 'verification-output',
    evidenceScope: 'local-gate-evidence',
    subjectBinding: { candidateId: input.storyId, storyId: input.storyId },
    producer: 'verification-executor',
    payload: {
      schemaVersion: VERIFICATION_OUTPUT_SCHEMA_VERSION,
      captureSemantics: VERIFICATION_CAPTURE_SEMANTICS,
      output: input.run.output,
      outputDigest,
    },
  });

  // Read through the verifying boundary immediately. A filesystem race or corrupt
  // write cannot be signed into an execution receipt.
  readVerificationOutputArtifact(input.projectRoot, {
    artifactId: artifact.artifactId,
    artifactDigest: artifact.artifactDigest,
    outputDigest,
  }, input.storyId);

  const identity = input.preparedIdentity ?? prepareVerificationExecutionIdentity({
    command: input.command,
    cwd: input.cwd,
    effectiveTimeoutMs: input.run.timeoutMs,
    manifestPath: input.manifestPath,
  });
  const subject: Omit<VerificationExecutionReceiptV3, 'executionReceiptDigest' | 'authenticity'> = {
    schemaVersion: VERIFICATION_EXECUTION_RECEIPT_V3,
    command: input.command,
    commandDigest: sha256Text(input.command),
    executable: identity.executable,
    argv: identity.argv,
    cwd: input.cwd,
    cwdDigest: sha256Text(input.cwd),
    effectiveTimeoutMs: input.run.timeoutMs,
    environmentDigest: identity.environmentDigest,
    toolchainDigest: identity.toolchainDigest,
    evidenceInputDigest: identity.evidenceInputDigest,
    inputClosureComplete: identity.reusable,
    dependencyManifest: identity.dependency.manifestBinding,
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    executionIdentityDigest: identity.executionIdentityDigest,
    reuseDeniedReason: identity.reason,
    captureSemantics: VERIFICATION_CAPTURE_SEMANTICS,
    outputArtifact: {
      artifactId: artifact.artifactId,
      artifactDigest: artifact.artifactDigest,
      outputDigest,
    },
    exitCode: input.run.code,
    timedOut: input.run.timedOut,
    durationMs: input.run.durationMs,
    executedAt: input.executedAt ?? new Date().toISOString(),
  };
  const digested = {
    ...subject,
    executionReceiptDigest: computeCanonicalDigest(subject),
  };
  return {
    ...digested,
    authenticity: issueVerificationAuthenticity(input.cwd, 'execution', digested),
  };
}

export function readVerificationOutputArtifact(
  projectRoot: string,
  ref: VerificationExecutionReceiptV2['outputArtifact'],
  expectedStoryId?: string,
): EvidenceArtifact<VerificationOutputArtifactPayload> {
  const artifact = readArtifact<VerificationOutputArtifactPayload>(projectRoot, ref.artifactId);
  if (artifact.artifactId !== ref.artifactId) {
    throw new Error(`verification output artifact ${ref.artifactId} failed artifact id verification [verification_output_artifact_id_mismatch]`);
  }
  if (artifact.artifactKind !== 'verification-output' || artifact.evidenceScope !== 'local-gate-evidence') {
    throw new Error(`verification output artifact ${ref.artifactId} has the wrong kind or scope [verification_output_kind_scope_mismatch]`);
  }
  if (artifact.artifactDigest !== ref.artifactDigest || !verifyArtifactDigest(artifact, ref.artifactDigest)) {
    throw new Error(`verification output artifact ${ref.artifactId} failed canonical digest verification [verification_output_artifact_digest_mismatch]`);
  }
  if (expectedStoryId && artifact.subjectBinding.storyId !== expectedStoryId) {
    throw new Error(`verification output artifact ${ref.artifactId} is bound to a different story [verification_output_story_mismatch]`);
  }
  const payload = artifact.payload;
  if (
    !payload
    || payload.schemaVersion !== VERIFICATION_OUTPUT_SCHEMA_VERSION
    || payload.captureSemantics !== VERIFICATION_CAPTURE_SEMANTICS
    || typeof payload.output !== 'string'
    || !isCanonicalSha256Hash(payload.outputDigest)
    || !isCanonicalSha256Hash(ref.artifactDigest)
    || !isCanonicalSha256Hash(ref.outputDigest)
  ) {
    throw new Error(`verification output artifact ${ref.artifactId} has a malformed payload [verification_output_payload_malformed]`);
  }
  const embeddedDigest = sha256Text(payload.output);
  if (embeddedDigest !== payload.outputDigest || embeddedDigest !== ref.outputDigest) {
    throw new Error(`verification output artifact ${ref.artifactId} failed embedded output digest verification [verification_output_digest_mismatch]`);
  }
  return artifact;
}

export function createVerificationAssertionReceipt(
  input: CreateVerificationAssertionInput,
): VerificationSplitReceipt {
  const executionErrors = verifyExecutionReceiptStructure(input.executionReceipt);
  if (executionErrors.length > 0) {
    throw new Error(`verification execution receipt invalid: ${executionErrors.join('; ')} [verification_execution_receipt_invalid]`);
  }
  const artifact = readVerificationOutputArtifact(
    input.projectRoot,
    input.executionReceipt.outputArtifact,
    input.storyId,
  );
  const matched = artifact.payload.output.includes(input.selector);
  const publicationMode = input.reuseReceipt ? 'reused' as const : 'executed' as const;
  const reuseReceiptDigest = input.reuseReceipt?.reuseReceiptDigest ?? null;
  const assertionSubject: Omit<VerificationAssertionReceiptV2, 'assertionReceiptDigest' | 'authenticity'> = {
    schemaVersion: VERIFICATION_ASSERTION_RECEIPT_V2,
    intentRef: input.intentRef,
    selectorDigest: sha256Text(input.selector),
    matcherVersion: VERIFICATION_MATCHER_VERSION,
    executionReceiptDigest: input.executionReceipt.executionReceiptDigest,
    outputDigest: artifact.payload.outputDigest,
    publicationMode,
    reuseReceiptDigest,
    matched,
  };
  const digestedAssertion = {
    ...assertionSubject,
    assertionReceiptDigest: computeCanonicalDigest(assertionSubject),
  };
  const assertionReceipt: VerificationAssertionReceiptV2 = {
    ...digestedAssertion,
    authenticity: issueVerificationAuthenticity(input.executionReceipt.cwd, 'assertion', digestedAssertion),
  };
  const common = {
    executionReceipt: input.executionReceipt,
    assertionReceipt,
    compatibility: {
      projection: 'legacy-verification-receipt.v1' as const,
      reusable: false as const,
      promotable: false as const,
    },
    exitCode: input.executionReceipt.exitCode,
    outputDigest: input.executionReceipt.outputArtifact.outputDigest,
    outputTail: boundedOutputTail(artifact.payload.output),
    selectorMatched: matched,
    // B-1482 compatibility projection: the selector belongs only on the
    // per-assertion bundle, never on the selector-free execution component.
    selector: input.selector,
    executedAt: input.executionReceipt.executedAt,
    timeoutMs: input.executionReceipt.effectiveTimeoutMs,
    ...(input.timeoutOverride ? { timeoutOverride: { ...input.timeoutOverride } } : {}),
  };
  if (input.executionReceipt.schemaVersion === VERIFICATION_EXECUTION_RECEIPT_V3) {
    const bundleBinding: VerificationReceiptBundleBindingV1 = {
      schemaVersion: VERIFICATION_RECEIPT_BUNDLE_BINDING_V1,
      publicationMode,
      executionReceiptDigest: input.executionReceipt.executionReceiptDigest,
      assertionReceiptDigest: assertionReceipt.assertionReceiptDigest,
      reuseReceiptDigest,
      outputArtifactDigest: input.executionReceipt.outputArtifact.artifactDigest,
      outputDigest: input.executionReceipt.outputArtifact.outputDigest,
    };
    return {
      ...common,
      schemaVersion: VERIFICATION_RECEIPT_BUNDLE_V4,
      executionReceipt: input.executionReceipt,
      publicationMode,
      reuseReceiptDigest,
      bundleBinding,
      bundleReceiptDigest: computeCanonicalDigest(bundleBinding),
      ...(input.reuseReceipt ? { reuseReceipt: input.reuseReceipt } : {}),
    } as VerificationReceiptBundleV4;
  }
  const legacyAssertionSubject: Omit<VerificationAssertionReceiptV1, 'assertionReceiptDigest'> = {
    schemaVersion: VERIFICATION_ASSERTION_RECEIPT_VERSION,
    intentRef: input.intentRef,
    selectorDigest: sha256Text(input.selector),
    matcherVersion: VERIFICATION_MATCHER_VERSION,
    executionReceiptDigest: input.executionReceipt.executionReceiptDigest,
    outputDigest: artifact.payload.outputDigest,
    matched,
  };
  return {
    ...common,
    schemaVersion: VERIFICATION_RECEIPT_BUNDLE_VERSION,
    executionReceipt: input.executionReceipt,
    assertionReceipt: {
      ...legacyAssertionSubject,
      assertionReceiptDigest: computeCanonicalDigest(legacyAssertionSubject),
    },
  };
}

export function verifyExecutionReceiptStructure(receipt: VerificationExecutionReceiptV2 | VerificationExecutionReceiptV3): string[] {
  return verifyExecutionReceiptStructureInternal(receipt, () => trustedVerificationPublicKey(receipt.cwd));
}

function verifyExecutionReceiptStructureInternal(
  receipt: VerificationExecutionReceiptV2 | VerificationExecutionReceiptV3,
  readTrusted: (cwd: string) => string | null,
): string[] {
  const errors: string[] = [];
  const record = receipt as unknown as Record<string, unknown>;
  if (receipt.schemaVersion !== VERIFICATION_EXECUTION_RECEIPT_VERSION && receipt.schemaVersion !== VERIFICATION_EXECUTION_RECEIPT_V3) {
    errors.push('execution schema version mismatch');
  }
  if (Object.prototype.hasOwnProperty.call(record, 'selector') || Object.prototype.hasOwnProperty.call(record, 'selectorMatched')) {
    errors.push('execution receipt contains selector outcome');
  }
  if (receipt.commandDigest !== sha256Text(receipt.command)) errors.push('command digest mismatch');
  if (receipt.cwdDigest !== sha256Text(receipt.cwd)) errors.push('cwd digest mismatch');
  if (!isCanonicalSha256Hash(receipt.commandDigest)) errors.push('command digest malformed');
  if (!isCanonicalSha256Hash(receipt.cwdDigest)) errors.push('cwd digest malformed');
  if (!isCanonicalSha256Hash(receipt.environmentDigest)) errors.push('environment digest malformed');
  if (!isCanonicalSha256Hash(receipt.toolchainDigest)) errors.push('toolchain digest malformed');
  if (!isCanonicalSha256Hash(receipt.outputArtifact.outputDigest)) errors.push('output digest malformed');
  if (!isCanonicalSha256Hash(receipt.outputArtifact.artifactDigest)) errors.push('output artifact digest malformed');
  if (!isCanonicalSha256Hash(receipt.executionReceiptDigest)) errors.push('execution receipt digest malformed');
  if (receipt.executionReceiptDigest !== computeCanonicalDigest(executionDigestSubject(receipt))) {
    errors.push('execution receipt digest mismatch');
  }
  if (receipt.schemaVersion === VERIFICATION_EXECUTION_RECEIPT_V3) {
    const signedExecution = { ...executionDigestSubject(receipt), executionReceiptDigest: receipt.executionReceiptDigest };
    if (!verifyVerificationAuthenticity(receipt.cwd, 'execution', signedExecution, receipt.authenticity, readTrusted)) {
      errors.push('execution receipt trusted signature mismatch');
    }
    if (!isCanonicalSha256Hash(receipt.executionIdentityDigest)) errors.push('execution identity digest malformed');
    if (receipt.executionIdentityDigest !== executionIdentityDigestFromReceipt(receipt)) {
      errors.push('execution identity digest mismatch');
    }
    if (receipt.inputClosureComplete) {
      if (!receipt.dependencyManifest) errors.push('complete execution missing dependency manifest');
      if (!receipt.evidenceInputDigest) errors.push('complete execution missing evidence input digest');
      if (receipt.reuseDeniedReason !== null) errors.push('complete execution carries reuse denial');
    }
    if (receipt.evidenceInputDigest !== null && !isCanonicalSha256Hash(receipt.evidenceInputDigest)) {
      errors.push('evidence input digest malformed');
    }
    if (receipt.dependencyManifest) {
      if (
        receipt.dependencyManifest.schemaVersion !== 'proof-or-stop.verifier-dependency-manifest-binding.v1'
        && receipt.dependencyManifest.schemaVersion !== VERIFICATION_DEPENDENCY_MANIFEST_BINDING_V2
      ) {
        errors.push('dependency manifest binding version mismatch');
      }
      if (!isCanonicalSha256Hash(receipt.dependencyManifest.manifestDigest)) errors.push('dependency manifest digest malformed');
      if (
        receipt.dependencyManifest.schemaVersion === VERIFICATION_DEPENDENCY_MANIFEST_BINDING_V2
        && !isCanonicalSha256Hash(receipt.dependencyManifest.capsulePolicyDigest)
      ) errors.push('capsule policy digest malformed');
    }
  }
  return errors;
}

export function planVerificationExecutionReuse(input: {
  projectRoot: string;
  storyId: string;
  priorReceipt: VerificationEvidenceReceipt | undefined;
  intentRef: string;
  selector: string;
  command: string;
  cwd: string;
  effectiveTimeoutMs: number;
  manifestPath?: string;
  freshnessHashBinding: {
    evidenceHeadHash: string | undefined;
    evidenceMaterialHash: string | undefined;
    evidenceStoryFilesHash: string | undefined;
    currentHeadHash: string | undefined;
    currentMaterialHash: string | undefined;
    currentStoryFilesHash: string | undefined;
  };
}): VerificationReuseDecision {
  const identity = prepareVerificationExecutionIdentity({
    command: input.command,
    cwd: input.cwd,
    effectiveTimeoutMs: input.effectiveTimeoutMs,
    manifestPath: input.manifestPath,
  });
  const denied = (reason: string): VerificationReuseDecision => ({ reusable: false, reason, identity });
  const hashBinding = input.freshnessHashBinding;
  if (
    !isCanonicalGitHeadHash(hashBinding.evidenceHeadHash)
    || !isCanonicalSha256Hash(hashBinding.evidenceMaterialHash)
    || !isCanonicalSha256Hash(hashBinding.evidenceStoryFilesHash)
    || !isCanonicalGitHeadHash(hashBinding.currentHeadHash)
    || !isCanonicalSha256Hash(hashBinding.currentMaterialHash)
    || !isCanonicalSha256Hash(hashBinding.currentStoryFilesHash)
  ) return denied('incomplete_freshness_hash_binding');
  const computedCurrentHead = currentGitHead(input.cwd);
  const computedCurrentMaterial = currentMaterialHash(input.cwd, 'HEAD', input.projectRoot);
  const computedCurrentStoryFiles = currentStoryFilesHash(input.cwd, 'HEAD', input.projectRoot);
  if (
    computedCurrentHead !== hashBinding.currentHeadHash
    || computedCurrentMaterial !== hashBinding.currentMaterialHash
    || computedCurrentStoryFiles !== hashBinding.currentStoryFilesHash
  ) return denied('current_freshness_hash_binding_mismatch');
  if (!identity.reusable) return denied(identity.reason ?? 'incomplete_input_closure');
  if (!isReusableVerificationReceipt(input.priorReceipt)) return denied('legacy_or_nonreusable_receipt');
  const validation = validateVerificationReceipt(input.projectRoot, input.priorReceipt, {
    intentRef: input.intentRef,
    selector: input.selector,
    storyId: input.storyId,
    command: input.command,
    freshness: {
      headHash: hashBinding.evidenceHeadHash,
      materialHash: hashBinding.evidenceMaterialHash,
      storyFilesHash: hashBinding.evidenceStoryFilesHash,
    },
  });
  if (!validation.ok) return denied('prior_receipt_invalid');
  const execution = input.priorReceipt.executionReceipt;
  if (execution.exitCode !== 0 || execution.timedOut) return denied('prior_execution_not_pass');
  if (!execution.inputClosureComplete || !execution.evidenceInputDigest || !execution.dependencyManifest) {
    return denied('prior_input_closure_incomplete');
  }
  if (execution.executionIdentityDigest !== identity.executionIdentityDigest) {
    return denied('execution_identity_changed');
  }
  if (
    execution.evidenceInputDigest !== identity.evidenceInputDigest
    || execution.dependencyManifest.manifestDigest !== identity.dependency.manifestBinding?.manifestDigest
  ) return denied('evidence_input_changed');

  // Re-snapshot at the issuance boundary. The earlier identity drove admission;
  // this second one proves the closure did not move while the prior artifact and
  // receipt were being verified.
  const issuanceIdentity = prepareVerificationExecutionIdentity({
    command: input.command,
    cwd: input.cwd,
    effectiveTimeoutMs: input.effectiveTimeoutMs,
    manifestPath: input.manifestPath,
  });
  assertVerificationInputUnchanged(identity, issuanceIdentity);

  const unsigned: Omit<VerificationReuseReceiptV1, 'reuseReceiptDigest' | 'authenticity'> = {
    schemaVersion: VERIFICATION_REUSE_RECEIPT_VERSION,
    priorExecutionReceiptDigest: execution.executionReceiptDigest,
    priorOutputArtifactDigest: execution.outputArtifact.artifactDigest,
    outputDigest: execution.outputArtifact.outputDigest,
    dependencyManifestDigest: execution.dependencyManifest.manifestDigest,
    evidenceInputDigest: execution.evidenceInputDigest,
    executionIdentityDigest: execution.executionIdentityDigest,
    reusedAt: new Date().toISOString(),
  };
  const digestedReuse = {
    ...unsigned,
    reuseReceiptDigest: computeCanonicalDigest(unsigned),
  };
  const reuseReceipt: VerificationReuseReceiptV1 = {
    ...digestedReuse,
    authenticity: issueVerificationAuthenticity(input.cwd, 'reuse', digestedReuse),
  };
  return {
    reusable: true,
    reason: null,
    identity,
    executionReceipt: execution,
    reuseReceipt,
  };
}

export function validateVerificationReceipt(
  projectRoot: string,
  receipt: VerificationEvidenceReceipt,
  expected: { intentRef: string; selector: string; storyId?: string; command?: string; freshness?: VerificationFreshnessBinding },
): VerificationReceiptValidation {
  if (!isSplitVerificationReceipt(receipt)) {
    const candidate = receipt as unknown as Record<string, unknown>;
    const splitShaped = 'executionReceipt' in candidate
      || 'assertionReceipt' in candidate
      || 'bundleBinding' in candidate
      || 'bundleReceiptDigest' in candidate
      || 'publicationBinding' in candidate;
    return {
      ok: !splitShaped,
      kind: 'legacy-readable-only',
      reusable: false,
      promotable: false,
      errors: splitShaped ? ['unrecognized split receipt schema'] : [],
    };
  }

  const location = verificationLocationReader(receipt.executionReceipt.cwd);
  const errors = verifyExecutionReceiptStructureInternal(receipt.executionReceipt, location.read);
  if (expected.command !== undefined && receipt.executionReceipt.command !== expected.command) {
    errors.push('authenticated execution command mismatch');
  }
  let output: string | undefined;
  try {
    const artifact = readVerificationOutputArtifact(
      projectRoot,
      receipt.executionReceipt.outputArtifact,
      expected.storyId,
    );
    output = artifact.payload.output;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const assertion = receipt.assertionReceipt;
  const expectsBoundPublication = receipt.schemaVersion === VERIFICATION_RECEIPT_BUNDLE_V4 || receipt.schemaVersion === VERIFICATION_RECEIPT_BUNDLE_V5;
  if (
    assertion.schemaVersion !== (expectsBoundPublication
      ? VERIFICATION_ASSERTION_RECEIPT_V2
      : VERIFICATION_ASSERTION_RECEIPT_VERSION)
  ) errors.push('assertion schema version mismatch');
  if (assertion.assertionReceiptDigest !== computeCanonicalDigest(assertionDigestSubject(assertion))) {
    errors.push('assertion receipt digest mismatch');
  }
  if (expectsBoundPublication) {
    const assertionV2 = assertion as VerificationAssertionReceiptV2;
    const signedAssertion = { ...assertionDigestSubject(assertionV2), assertionReceiptDigest: assertionV2.assertionReceiptDigest };
    if (!verifyVerificationAuthenticity(
      receipt.executionReceipt.cwd, 'assertion', signedAssertion, assertionV2.authenticity, location.read,
    )) errors.push('assertion receipt trusted signature mismatch');
    // The top-level selector is a compatibility projection consumed by narrowing.
    // It is intentionally absent from the selector-free ExecutionReceipt, but it
    // must resolve to the selector digest carried by the independently signed
    // AssertionReceipt. Otherwise persisted projection tampering could substitute a
    // different narrowing witness while leaving the signed receipt graph untouched.
    if (typeof receipt.selector !== 'string' || sha256Text(receipt.selector) !== assertionV2.selectorDigest) {
      errors.push('receipt selector compatibility digest mismatch');
    }
  }
  if (!isCanonicalSha256Hash(assertion.selectorDigest)) errors.push('assertion selector digest malformed');
  if (!isCanonicalSha256Hash(assertion.executionReceiptDigest)) errors.push('assertion execution receipt digest malformed');
  if (!isCanonicalSha256Hash(assertion.outputDigest)) errors.push('assertion output digest malformed');
  if (!isCanonicalSha256Hash(assertion.assertionReceiptDigest)) errors.push('assertion receipt digest malformed');
  if (assertion.intentRef !== expected.intentRef) errors.push('assertion intentRef mismatch');
  if (assertion.selectorDigest !== sha256Text(expected.selector)) errors.push('assertion selector digest mismatch');
  if (assertion.matcherVersion !== VERIFICATION_MATCHER_VERSION) errors.push('assertion matcher version mismatch');
  if (assertion.executionReceiptDigest !== receipt.executionReceipt.executionReceiptDigest) {
    errors.push('assertion execution receipt link mismatch');
  }
  if (assertion.outputDigest !== receipt.executionReceipt.outputArtifact.outputDigest) {
    errors.push('assertion output digest link mismatch');
  }
  if (output !== undefined && assertion.matched !== output.includes(expected.selector)) {
    errors.push('assertion selector result mismatch');
  }
  // V4 display projections must agree with authenticated artifact bytes, even
  // though no proof consumer may use the bounded tail for selector decisions.
  if (expectsBoundPublication && output !== undefined && receipt.outputTail !== boundedOutputTail(output)) {
    errors.push('receipt outputTail compatibility mismatch');
  }
  if (
    receipt.exitCode !== receipt.executionReceipt.exitCode
    || receipt.outputDigest !== receipt.executionReceipt.outputArtifact.outputDigest
    || receipt.selectorMatched !== assertion.matched
    || receipt.executedAt !== receipt.executionReceipt.executedAt
    || receipt.timeoutMs !== receipt.executionReceipt.effectiveTimeoutMs
  ) {
    errors.push('legacy compatibility projection mismatch');
  }
  if (receipt.compatibility.reusable !== false || receipt.compatibility.promotable !== false) {
    errors.push('split receipt compatibility capability widened');
  }

  let structurallyReusable = false;
  if (receipt.schemaVersion === VERIFICATION_RECEIPT_BUNDLE_V3) {
    const execution = receipt.executionReceipt;
    if (
      execution.inputClosureComplete
      || execution.evidenceInputDigest !== null
      || execution.dependencyManifest !== null
      || receipt.reuseReceipt
    ) {
      errors.push('legacy v3 reusable publication lacks cryptographically bound publication mode');
    }
  }
  if (receipt.schemaVersion === VERIFICATION_RECEIPT_BUNDLE_V4 || receipt.schemaVersion === VERIFICATION_RECEIPT_BUNDLE_V5) {
    const execution = receipt.executionReceipt;
    structurallyReusable = execution.inputClosureComplete
      && execution.evidenceInputDigest !== null
      && execution.dependencyManifest !== null
      && execution.dependencyManifest.schemaVersion === VERIFICATION_DEPENDENCY_MANIFEST_BINDING_V2
      && execution.reuseDeniedReason === null;
    const assertionV2 = receipt.assertionReceipt;
    const reuse = receipt.reuseReceipt;
    if (receipt.publicationMode !== assertionV2.publicationMode) errors.push('publication mode assertion link mismatch');
    if (receipt.reuseReceiptDigest !== assertionV2.reuseReceiptDigest) errors.push('reuse digest assertion link mismatch');
    if (receipt.publicationMode === 'executed') {
      if (receipt.reuseReceiptDigest !== null || assertionV2.reuseReceiptDigest !== null || reuse !== undefined) {
        errors.push('executed publication carries reuse lineage');
      }
    } else {
      if (!reuse || !isCanonicalSha256Hash(receipt.reuseReceiptDigest)) {
        errors.push('reused publication missing required reuse lineage');
      } else if (receipt.reuseReceiptDigest !== reuse.reuseReceiptDigest) {
        errors.push('reuse digest bundle link mismatch');
      }
    }
    if (reuse) {
      const signedReuse = { ...reuseDigestSubject(reuse), reuseReceiptDigest: reuse.reuseReceiptDigest };
      if (!verifyVerificationAuthenticity(execution.cwd, 'reuse', signedReuse, reuse.authenticity, location.read)) {
        errors.push('reuse receipt trusted signature mismatch');
      }
      for (const [label, digest] of [
        ['prior execution receipt', reuse.priorExecutionReceiptDigest],
        ['prior output artifact', reuse.priorOutputArtifactDigest],
        ['reuse output', reuse.outputDigest],
        ['reuse dependency manifest', reuse.dependencyManifestDigest],
        ['reuse evidence input', reuse.evidenceInputDigest],
        ['reuse execution identity', reuse.executionIdentityDigest],
        ['reuse receipt', reuse.reuseReceiptDigest],
      ] as const) {
        if (!isCanonicalSha256Hash(digest)) errors.push(`${label} digest malformed`);
      }
      if (reuse.reuseReceiptDigest !== computeCanonicalDigest(reuseDigestSubject(reuse))) {
        errors.push('reuse receipt digest mismatch');
      }
      if (
        reuse.priorExecutionReceiptDigest !== execution.executionReceiptDigest
        || reuse.priorOutputArtifactDigest !== execution.outputArtifact.artifactDigest
        || reuse.outputDigest !== execution.outputArtifact.outputDigest
        || reuse.dependencyManifestDigest !== execution.dependencyManifest?.manifestDigest
        || reuse.evidenceInputDigest !== execution.evidenceInputDigest
        || reuse.executionIdentityDigest !== execution.executionIdentityDigest
      ) errors.push('reuse receipt link mismatch');
    }
    const expectedBinding: VerificationReceiptBundleBindingV1 = {
      schemaVersion: VERIFICATION_RECEIPT_BUNDLE_BINDING_V1,
      publicationMode: receipt.publicationMode,
      executionReceiptDigest: execution.executionReceiptDigest,
      assertionReceiptDigest: assertionV2.assertionReceiptDigest,
      reuseReceiptDigest: receipt.reuseReceiptDigest,
      outputArtifactDigest: execution.outputArtifact.artifactDigest,
      outputDigest: execution.outputArtifact.outputDigest,
    };
    if (computeCanonicalDigest(receipt.bundleBinding) !== receipt.bundleReceiptDigest) {
      errors.push('bundle receipt digest mismatch');
    }
    if (computeCanonicalDigest(expectedBinding) !== receipt.bundleReceiptDigest) {
      errors.push('bundle receipt cross-link mismatch');
    }
    for (const [label, digest] of [
      ['bundle receipt', receipt.bundleReceiptDigest],
      ['bundle execution', receipt.bundleBinding?.executionReceiptDigest],
      ['bundle assertion', receipt.bundleBinding?.assertionReceiptDigest],
      ['bundle output artifact', receipt.bundleBinding?.outputArtifactDigest],
      ['bundle output', receipt.bundleBinding?.outputDigest],
    ] as const) {
      if (!isCanonicalSha256Hash(digest)) errors.push(`${label} digest malformed`);
    }
    if (receipt.schemaVersion === VERIFICATION_RECEIPT_BUNDLE_V5) {
      const publication = receipt.publicationBinding;
      const { schemaVersion: _bindingSchema, ...links } = expectedBinding;
      const subject = {
        schemaVersion: VERIFICATION_PUBLICATION_BINDING_V1,
        ...links,
        storyId: publication?.storyId,
        freshness: publication?.freshness,
      };
      if (!publication || publication.schemaVersion !== VERIFICATION_PUBLICATION_BINDING_V1
        || !isCanonicalGitHeadHash(publication.freshness?.headHash)
        || !isCanonicalSha256Hash(publication.freshness?.materialHash)
        || !isCanonicalSha256Hash(publication.freshness?.storyFilesHash)) {
        errors.push('publication freshness binding malformed');
      } else {
        const { authenticity, publicationDigest, ...actualSubject } = publication;
        if (computeCanonicalDigest(subject) !== publicationDigest
          || computeCanonicalDigest(actualSubject) !== publicationDigest
          || !verifyVerificationAuthenticity(execution.cwd, 'publication', { ...actualSubject, publicationDigest }, authenticity, location.read)) {
          errors.push('publication binding trusted signature or cross-link mismatch');
        }
        if (expected.storyId !== undefined && publication.storyId !== expected.storyId) errors.push('publication story binding mismatch');
        if (expected.freshness && computeCanonicalDigest(expected.freshness) !== computeCanonicalDigest(publication.freshness)) {
          errors.push('publication freshness binding mismatch');
        }
      }
    }
  }

  if (!location.unchanged(receipt.executionReceipt.cwd)) errors.push('verification signer location changed during validation');

  return {
    ok: errors.length === 0,
    kind: receipt.schemaVersion === VERIFICATION_RECEIPT_BUNDLE_V5 ? 'split-v5' : receipt.schemaVersion === VERIFICATION_RECEIPT_BUNDLE_V4
      ? 'split-v4'
      : receipt.schemaVersion === VERIFICATION_RECEIPT_BUNDLE_V3 ? 'split-v3' : 'split-v2',
    reusable: errors.length === 0 && structurallyReusable && receipt.schemaVersion === VERIFICATION_RECEIPT_BUNDLE_V5,
    promotable: false,
    errors,
    ...(output !== undefined ? { output } : {}),
  };
}
