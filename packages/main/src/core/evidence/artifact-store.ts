/**
 * Evidence artifact store — immutable content-addressed storage.
 *
 * B-0aa1: Candidate-only artifact storage primitives.
 *
 * Layout:
 *   <root>/.lattice/evidence/
 *     objects/sha256/<digest>.json   — immutable canonical artifact JSON
 *     refs/by-id/<artifactId>.json   — mutable pointer to current digest
 *     ledger/observed.jsonl          — append-only event ledger
 */

import { createHash } from 'crypto';
import {
  closeSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  appendFileSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import type { EvidenceArtifact, ArtifactKind, EvidenceScope, SubjectBinding } from './types.js';
import { EVIDENCE_SCHEMA_VERSION } from './types.js';
import { PROOF_OR_STOP_DIR } from '../lattice-paths.js';
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

function runtimeBlobPath(projectRoot: string, ref: EvidenceBlobRef): string {
  validateRuntimeBlobRef(ref);
  return join(runtimeBlobDir(projectRoot), `${ref.contentDigest}.blob`);
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
): { created: boolean } {
  assertRuntimeStorageCapability(capability);
  validateRuntimeBlobRef(ref);
  const actualDigest = createHash('sha256').update(bytes).digest('hex');
  if (actualDigest !== ref.contentDigest) throw new Error('runtime-evidence: blob_digest_mismatch');

  const dir = runtimeBlobDir(projectRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const destination = runtimeBlobPath(projectRoot, ref);
  if (existsSync(destination)) {
    const existing = readFileSync(destination);
    if (!existing.equals(bytes)) throw new Error('runtime-evidence: blob_digest_mismatch');
    return { created: false };
  }

  const temporary = join(dir, `.${ref.contentDigest}.${process.pid}.${Date.now().toString(36)}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
    const directoryDescriptor = openSync(dir, 'r');
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    const persisted = readFileSync(destination);
    if (!persisted.equals(bytes)) throw new Error('runtime-evidence: blob_digest_mismatch');
    return { created: true };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

/** Read and digest-check a runtime blob without exposing its physical path. */
export function readRuntimeEvidenceBlob(
  projectRoot: string,
  ref: EvidenceBlobRef,
  capability: string = RUNTIME_EVIDENCE_LOCAL_STORAGE_CAPABILITY,
): Buffer | undefined {
  assertRuntimeStorageCapability(capability);
  const path = runtimeBlobPath(projectRoot, ref);
  if (!existsSync(path)) return undefined;
  const bytes = readFileSync(path);
  if (createHash('sha256').update(bytes).digest('hex') !== ref.contentDigest) {
    throw new Error('runtime-evidence: blob_digest_mismatch');
  }
  return bytes;
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
