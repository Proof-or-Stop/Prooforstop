/**
 * Evidence artifact store — immutable content-addressed storage.
 *
 * B-0aa1: Candidate-only artifact storage primitives.
 *
 * Layout:
 *   <root>/.proof-or-stop/evidence/
 *     objects/sha256/<digest>.json   — immutable canonical artifact JSON
 *     refs/by-id/<artifactId>.json   — mutable pointer to current digest
 *     ledger/observed.jsonl          — append-only event ledger
 */

import { createHash } from 'crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  appendFileSync,
  fsyncSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import type { EvidenceArtifact, ArtifactKind, EvidenceScope, SubjectBinding } from './types.js';
import { EVIDENCE_SCHEMA_VERSION } from './types.js';
import { PROOF_OR_STOP_DIR } from '../proof-or-stop-paths.js';
import type { EvidenceBlobRef, RuntimeEvidenceBlobStore } from '../runtime-evidence-receipt.js';

export const RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY = 'runtime-evidence-local-fs-atomic-rename-v1' as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;

function runtimeBlobDir(projectRoot: string): string {
  return join(evidenceRoot(projectRoot), 'runtime-blobs', 'sha256');
}

function validateRuntimeBlobRef(ref: EvidenceBlobRef): void {
  if (!SHA256_HEX.test(ref.contentDigest) || ref.blobId !== `runtime-${ref.contentDigest}`) {
    throw new Error('runtime-evidence: blob_digest_mismatch');
  }
}

function assertRuntimeStorageCapability(capability: string): void {
  if (capability !== RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY) {
    throw new Error('runtime-evidence: unsupported_storage');
  }
}

function assertRuntimeBlobRootContained(projectRoot: string, dir: string): void {
  const rootReal = realpathSync(projectRoot);
  const dirReal = realpathSync(dir);
  const rel = relative(rootReal, dirReal);
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('runtime-evidence: unsupported_storage');
  }
}

interface RuntimeBlobDirectoryIdentity {
  projectRootReal: string;
  dirReal: string;
  dev: number;
  ino: number;
}

function captureRuntimeBlobDirectoryIdentity(projectRoot: string, dir: string): RuntimeBlobDirectoryIdentity {
  assertRuntimeBlobRootContained(projectRoot, dir);
  const logical = lstatSync(dir);
  if (logical.isSymbolicLink() || !logical.isDirectory()) {
    throw new Error('runtime-evidence: unsupported_storage');
  }
  const physical = statIdentity(dir);
  return {
    projectRootReal: realpathSync(projectRoot),
    dirReal: realpathSync(dir),
    dev: physical.dev,
    ino: physical.ino,
  };
}

function statIdentity(path: string): { dev: number; ino: number } {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(descriptor);
    return { dev: Number(stat.dev), ino: Number(stat.ino) };
  } finally {
    closeSync(descriptor);
  }
}

function assertRuntimeBlobDirectoryIdentity(
  projectRoot: string,
  dir: string,
  expected: RuntimeBlobDirectoryIdentity,
): void {
  try {
    const logical = lstatSync(dir);
    const current = statIdentity(dir);
    if (logical.isSymbolicLink() || !logical.isDirectory()
      || realpathSync(projectRoot) !== expected.projectRootReal
      || realpathSync(dir) !== expected.dirReal
      || current.dev !== expected.dev
      || current.ino !== expected.ino) {
      throw new Error('runtime-evidence: unsupported_storage');
    }
    assertRuntimeBlobRootContained(projectRoot, dir);
  } catch (error) {
    if (error instanceof Error && error.message === 'runtime-evidence: unsupported_storage') throw error;
    throw new Error('runtime-evidence: unsupported_storage');
  }
}

let runtimeBlobDirectoryCapabilityActive = false;

/**
 * Run synchronous blob I/O relative to a kernel-held working-directory
 * reference. Once chdir has resolved `dir`, replacing the logical pathname
 * with a symlink cannot redirect relative open/rename/read operations. The
 * process-wide guard rejects re-entry while the capability is held.
 */
function withRuntimeBlobDirectoryCapability<T>(
  projectRoot: string,
  dir: string,
  expected: RuntimeBlobDirectoryIdentity,
  action: () => T,
): T {
  if (runtimeBlobDirectoryCapabilityActive) {
    throw new Error('runtime-evidence: unsupported_storage');
  }
  const originalCwd = process.cwd();
  runtimeBlobDirectoryCapabilityActive = true;
  try {
    assertRuntimeBlobDirectoryIdentity(projectRoot, dir, expected);
    process.chdir(dir);
    const held = statIdentity('.');
    if (realpathSync('.') !== expected.dirReal || held.dev !== expected.dev || held.ino !== expected.ino) {
      throw new Error('runtime-evidence: unsupported_storage');
    }
    return action();
  } catch (error) {
    if (error instanceof Error && error.message === 'runtime-evidence: unsupported_storage') throw error;
    throw new Error('runtime-evidence: unsupported_storage');
  } finally {
    try {
      process.chdir(originalCwd);
    } finally {
      runtimeBlobDirectoryCapabilityActive = false;
    }
  }
}

/**
 * Publish one immutable runtime-evidence blob. Repeated writes of the same
 * digest are byte-checked no-ops; callers never receive the protected path.
 */
export function writeRuntimeEvidenceBlob(
  projectRoot: string,
  ref: EvidenceBlobRef,
  bytes: Buffer,
  capability: string = RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY,
  testInterleaving?: { beforeOpen?: () => void; beforePublish?: () => void },
): { created: boolean } {
  assertRuntimeStorageCapability(capability);
  validateRuntimeBlobRef(ref);
  const actualDigest = createHash('sha256').update(bytes).digest('hex');
  if (actualDigest !== ref.contentDigest) throw new Error('runtime-evidence: blob_digest_mismatch');

  projectRoot = resolve(projectRoot);
  const dir = runtimeBlobDir(projectRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const directoryIdentity = captureRuntimeBlobDirectoryIdentity(projectRoot, dir);
  const destination = `${ref.contentDigest}.blob`;
  return withRuntimeBlobDirectoryCapability(projectRoot, dir, directoryIdentity, () => {
    if (existsSync(destination)) {
      const descriptor = openSync(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const existing = readFileSync(descriptor);
        assertRuntimeBlobDirectoryIdentity(projectRoot, dir, directoryIdentity);
        if (!existing.equals(bytes)) throw new Error('runtime-evidence: blob_digest_mismatch');
      } finally {
        closeSync(descriptor);
      }
      return { created: false };
    }

    const temporary = `.${ref.contentDigest}.${process.pid}.${Date.now().toString(36)}.tmp`;
    let descriptor: number | undefined;
    let published = false;
    try {
      assertRuntimeBlobDirectoryIdentity(projectRoot, dir, directoryIdentity);
      testInterleaving?.beforeOpen?.();
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      testInterleaving?.beforePublish?.();
      assertRuntimeBlobDirectoryIdentity(projectRoot, dir, directoryIdentity);
      renameSync(temporary, destination);
      published = true;
      assertRuntimeBlobDirectoryIdentity(projectRoot, dir, directoryIdentity);
      const directoryDescriptor = openSync('.', 'r');
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
      const persisted = readFileSync(destination);
      if (!persisted.equals(bytes)) throw new Error('runtime-evidence: blob_digest_mismatch');
      return { created: true };
    } catch (error) {
      if (published) rmSync(destination, { force: true });
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
    }
  });
}

/** Read and digest-check a runtime blob without exposing its physical path. */
export function readRuntimeEvidenceBlob(
  projectRoot: string,
  ref: EvidenceBlobRef,
  capability: string = RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY,
): Buffer | undefined {
  assertRuntimeStorageCapability(capability);
  projectRoot = resolve(projectRoot);
  const dir = runtimeBlobDir(projectRoot);
  if (!existsSync(dir)) return undefined;
  const directoryIdentity = captureRuntimeBlobDirectoryIdentity(projectRoot, dir);
  const path = `${ref.contentDigest}.blob`;
  return withRuntimeBlobDirectoryCapability(projectRoot, dir, directoryIdentity, () => {
    if (!existsSync(path)) return undefined;
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const bytes = readFileSync(descriptor);
      assertRuntimeBlobDirectoryIdentity(projectRoot, dir, directoryIdentity);
      if (createHash('sha256').update(bytes).digest('hex') !== ref.contentDigest) {
        throw new Error('runtime-evidence: blob_digest_mismatch');
      }
      return bytes;
    } finally {
      closeSync(descriptor);
    }
  });
}

export function createRuntimeEvidenceBlobStore(
  projectRoot: string,
  capability: string = RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY,
): RuntimeEvidenceBlobStore {
  assertRuntimeStorageCapability(capability);
  return {
    put: (ref, bytes) => { writeRuntimeEvidenceBlob(projectRoot, ref, bytes, capability); },
    get: (ref) => readRuntimeEvidenceBlob(projectRoot, ref, capability),
  };
}

export interface CreateArtifactOptions<TPayload> {
  artifactKind: ArtifactKind;
  evidenceScope: EvidenceScope;
  subjectBinding: SubjectBinding;
  payload: TPayload;
  producer?: string;
}

function evidenceRoot(projectRoot: string): string {
  return join(projectRoot, PROOF_OR_STOP_DIR, 'evidence');
}

function objectsDir(projectRoot: string): string {
  return join(evidenceRoot(projectRoot), 'objects', 'sha256');
}

function refsDir(projectRoot: string): string {
  return join(evidenceRoot(projectRoot), 'refs', 'by-id');
}

function ledgerPath(projectRoot: string): string {
  return join(evidenceRoot(projectRoot), 'ledger', 'observed.jsonl');
}

function ensureDirs(projectRoot: string): void {
  mkdirSync(objectsDir(projectRoot), { recursive: true });
  mkdirSync(refsDir(projectRoot), { recursive: true });
  mkdirSync(join(evidenceRoot(projectRoot), 'ledger'), { recursive: true });
}

function stableCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableCanonicalize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map(key => [key, stableCanonicalize(record[key])]),
    );
  }
  return value;
}

function computeDigest(obj: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableCanonicalize(obj)))
    .digest('hex');
}

interface ArtifactDigestSubject<TPayload> {
  artifactKind: ArtifactKind;
  schemaVersion: string;
  producer: string;
  evidenceScope: EvidenceScope;
  subjectBinding: SubjectBinding;
  payload: TPayload;
}

function artifactDigestSubject<TPayload>(subject: ArtifactDigestSubject<TPayload>): ArtifactDigestSubject<TPayload> {
  return {
    artifactKind: subject.artifactKind,
    schemaVersion: subject.schemaVersion,
    producer: subject.producer,
    evidenceScope: subject.evidenceScope,
    subjectBinding: subject.subjectBinding,
    payload: subject.payload,
  };
}

function digestSubject<TPayload>(opts: CreateArtifactOptions<TPayload>): ArtifactDigestSubject<TPayload> {
  return artifactDigestSubject({
    artifactKind: opts.artifactKind,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    producer: opts.producer ?? 'repro-intake',
    evidenceScope: opts.evidenceScope,
    subjectBinding: opts.subjectBinding,
    payload: opts.payload,
  });
}

function generateArtifactId(kind: ArtifactKind): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  const prefix = kind.split('-').map(w => w[0]).join('');
  return `${prefix}-${ts}-${rand}`;
}

/** Write an artifact envelope to the object store and update the ref pointer. */
export function writeArtifact<TPayload>(
  projectRoot: string,
  opts: CreateArtifactOptions<TPayload>,
): EvidenceArtifact<TPayload> {
  ensureDirs(projectRoot);

  const artifactId = generateArtifactId(opts.artifactKind);
  const createdAt = new Date().toISOString();

  const artifactDigest = computeDigest(digestSubject(opts));
  const objPath = join(objectsDir(projectRoot), `${artifactDigest}.json`);

  if (existsSync(objPath)) {
    return JSON.parse(readFileSync(objPath, 'utf8')) as EvidenceArtifact<TPayload>;
  }

  const artifact: EvidenceArtifact<TPayload> = {
    artifactId,
    artifactKind: opts.artifactKind,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    createdAt,
    producer: opts.producer ?? 'repro-intake',
    evidenceScope: opts.evidenceScope,
    subjectBinding: opts.subjectBinding,
    payload: opts.payload,
    artifactDigest,
  };

  // Write immutable object
  writeFileSync(objPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');

  // Write ref
  const refPath = join(refsDir(projectRoot), `${artifactId}.json`);
  writeFileSync(refPath, JSON.stringify({ artifactId, artifactDigest, artifactKind: opts.artifactKind }, null, 2) + '\n', 'utf8');

  // Append ledger event
  const event = { event: 'artifact_written', artifactId, artifactKind: opts.artifactKind, artifactDigest, evidenceScope: opts.evidenceScope, at: createdAt };
  appendFileSync(ledgerPath(projectRoot), JSON.stringify(event) + '\n', 'utf8');

  return artifact;
}

/** Read an artifact by ID (resolves via ref). */
export function readArtifact<TPayload>(
  projectRoot: string,
  artifactId: string,
): EvidenceArtifact<TPayload> {
  const refPath = join(refsDir(projectRoot), `${artifactId}.json`);
  if (!existsSync(refPath)) {
    throw new Error(`evidence-store: artifact ref not found: ${artifactId}`);
  }
  const ref = JSON.parse(readFileSync(refPath, 'utf8')) as { artifactDigest: string };
  const objPath = join(objectsDir(projectRoot), `${ref.artifactDigest}.json`);
  if (!existsSync(objPath)) {
    throw new Error(`evidence-store: object not found for digest ${ref.artifactDigest} (artifact ${artifactId})`);
  }
  return JSON.parse(readFileSync(objPath, 'utf8')) as EvidenceArtifact<TPayload>;
}

/** Verify that a stored artifact digest matches expected. */
export function verifyArtifactDigest(artifact: EvidenceArtifact<unknown>, expectedDigest: string): boolean {
  const recomputed = computeDigest(artifactDigestSubject({
    artifactKind: artifact.artifactKind,
    schemaVersion: artifact.schemaVersion,
    producer: artifact.producer,
    evidenceScope: artifact.evidenceScope,
    subjectBinding: artifact.subjectBinding,
    payload: artifact.payload,
  }));
  return recomputed === expectedDigest && artifact.artifactDigest === expectedDigest;
}

export function listArtifacts<TPayload>(
  projectRoot: string,
  artifactKind?: ArtifactKind,
): EvidenceArtifact<TPayload>[] {
  const dir = refsDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => name.slice(0, -'.json'.length))
    .map(artifactId => readArtifact<TPayload>(projectRoot, artifactId))
    .filter(artifact => !artifactKind || artifact.artifactKind === artifactKind);
}
