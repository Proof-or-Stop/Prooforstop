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
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  appendFileSync,
} from 'fs';
import { join } from 'path';
import type { EvidenceArtifact, ArtifactKind, EvidenceScope, SubjectBinding } from './types.js';
import { EVIDENCE_SCHEMA_VERSION } from './types.js';

export interface CreateArtifactOptions<TPayload> {
  artifactKind: ArtifactKind;
  evidenceScope: EvidenceScope;
  subjectBinding: SubjectBinding;
  payload: TPayload;
  producer?: string;
}

function evidenceRoot(projectRoot: string): string {
  return join(projectRoot, '.lattice', 'evidence');
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

function computeDigest(obj: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort()))
    .digest('hex');
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

  // Compute digest over payload only (pre-envelope), then build full envelope.
  const payloadDigest = computeDigest(opts.payload);

  const artifact: EvidenceArtifact<TPayload> = {
    artifactId,
    artifactKind: opts.artifactKind,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    createdAt,
    producer: opts.producer ?? 'repro-intake',
    evidenceScope: opts.evidenceScope,
    subjectBinding: opts.subjectBinding,
    payload: opts.payload,
    artifactDigest: payloadDigest,
  };

  // Write immutable object
  const objPath = join(objectsDir(projectRoot), `${payloadDigest}.json`);
  if (!existsSync(objPath)) {
    writeFileSync(objPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  }

  // Write ref
  const refPath = join(refsDir(projectRoot), `${artifactId}.json`);
  writeFileSync(refPath, JSON.stringify({ artifactId, artifactDigest: payloadDigest, artifactKind: opts.artifactKind }, null, 2) + '\n', 'utf8');

  // Append ledger event
  const event = { event: 'artifact_written', artifactId, artifactKind: opts.artifactKind, artifactDigest: payloadDigest, evidenceScope: opts.evidenceScope, at: createdAt };
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
  const recomputed = computeDigest(artifact.payload);
  return recomputed === expectedDigest && artifact.artifactDigest === expectedDigest;
}
