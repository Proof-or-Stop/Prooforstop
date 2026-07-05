import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { resolveProjectGitRoot } from './story-signed-workspace-resolution.js';

export const CAPABILITY_RELEASE_LEDGER_REL_PATH = '.lattice/capability-releases.jsonl';
export const CAPABILITY_RELEASE_SCHEMA_VERSION = 'proofbound.product-capability-release.v1';

export type CapabilityKind =
  | 'experiment-launch-control'
  | 'workflow-control'
  | 'evidence-control'
  | 'memory-control'
  | 'documentation-control'
  | 'other';

export type CapabilityActivationBoundary = 'non-runtime-capability' | 'runtime-capability';

/**
 * First-class, non-runtime product capability release provenance. This ledger is
 * NOT gate evidence and NOT a package release: `authority` is always
 * `non_authoritative` and `gateEvidence` is always `false`, enforced fail-closed
 * at read time (see {@link readCapabilityReleaseLedger}). Every persisted identity
 * (`id`, `idempotencyKey`, `capabilityDigest`, `capabilityVersion`) is
 * deterministic and merge-stable: reproducible on a clean checkout and identical
 * across a DONE re-merge / recovery of the same content (no `mainCommit`,
 * timestamp, or counter participates in any digest or key).
 */
export interface ProductCapabilityReleaseRecord {
  schemaVersion: typeof CAPABILITY_RELEASE_SCHEMA_VERSION;
  id: string;
  idempotencyKey: string;
  storyId: string;
  createdAt: string;
  /** Provenance only — EXCLUDED from idempotencyKey (changes on DONE re-merge). */
  mainCommit: string;
  capabilityId: string;
  /** Optional display label (default: story title); never part of a digest/key. */
  capabilityName?: string;
  capabilityVersion: string;
  capabilityKind: CapabilityKind;
  capabilityDigest: string;
  artifactReleaseId?: string;
  /** Provenance; folded into capabilityDigest, so absence is safe. */
  artifactSetDigest?: string;
  changedPaths: string[];
  runtimeSemverChanged: boolean;
  activationBoundary: CapabilityActivationBoundary;
  authority: 'non_authoritative';
  gateEvidence: false;
  notes: string[];
}

export interface CapabilityReleaseRecordOptions {
  root: string;
  storyId: string;
  mainCommit?: string;
  capabilityId: string;
  capabilityName?: string;
  capabilityKind: CapabilityKind;
  /** The FULL DONE-time changed-path list (persisted so backfill needs no git replay). */
  changedPaths: string[];
  /** Capability-declaring subset of changedPaths that defines the capability identity. */
  capabilityPaths: string[];
  artifactReleaseId?: string;
  artifactSetDigest?: string;
  runtimeSemverChanged: boolean;
  activationBoundary?: CapabilityActivationBoundary;
  now?: string;
  notes?: string[];
}

export interface RecordCapabilityReleaseResult {
  status: 'recorded' | 'already_recorded';
  record: ProductCapabilityReleaseRecord;
}

/** Thrown by the fail-closed reader; a tampered/invalid ledger is an error, not noise. */
export class CapabilityReleaseLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityReleaseLedgerError';
  }
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function normalizeCapabilityPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/').trim();
}

export function uniqueSortedCapabilityPaths(paths: string[]): string[] {
  return [...new Set(paths.map(normalizeCapabilityPath).filter(Boolean))].sort();
}

/**
 * Merge-stable capability identity digest. Hashes ONLY merge-stable inputs
 * (no mainCommit / timestamp / counter). artifactSetDigest is folded in here so
 * the artifact-less case (undefined -> null) is safe and does not need to be a
 * standalone key component.
 */
export function computeCapabilityDigest(
  capabilityId: string,
  capabilityKind: CapabilityKind,
  capabilityPaths: string[],
  artifactSetDigest?: string,
): string {
  const canonical = {
    capabilityId,
    capabilityKind,
    capabilityPaths: uniqueSortedCapabilityPaths(capabilityPaths),
    artifactSetDigest: artifactSetDigest ?? null,
  };
  return `sha256:${sha256Hex(JSON.stringify(canonical))}`;
}

const SHA256_PREFIX = 'sha256:';

/**
 * Digest-derived version (stateless, reproducible on a clean checkout): the 12
 * hex characters of capabilityDigest immediately after its `sha256:` prefix.
 */
export function capabilityVersionFromDigest(capabilityDigest: string): string {
  const start = capabilityDigest.startsWith(SHA256_PREFIX) ? SHA256_PREFIX.length : 0;
  return capabilityDigest.slice(start, start + 12);
}

/**
 * Deterministic host-neutral capabilityId slug fallback: the shallowest shared
 * directory of the capability-declaring paths under `experiments/` or `docs/`,
 * slugified. Same slug across stories denotes the same product surface.
 */
export function deriveCapabilityIdSlug(capabilityPaths: string[]): string | null {
  const normalized = uniqueSortedCapabilityPaths(capabilityPaths).filter(
    path => path.startsWith('experiments/') || path.startsWith('docs/'),
  );
  if (normalized.length === 0) return null;
  const segmentLists = normalized.map(path => path.split('/'));
  const shared: string[] = [];
  for (let i = 0; ; i += 1) {
    const seg = segmentLists[0][i];
    if (seg === undefined) break;
    if (!segmentLists.every(list => list[i] === seg)) break;
    // Stop before the final filename segment of any single-file path.
    if (segmentLists.some(list => i === list.length - 1)) break;
    shared.push(seg);
  }
  const basis = shared.length > 0 ? shared : segmentLists[0].slice(0, 2);
  return slugify(basis.join('-'));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

export function capabilityReleaseLedgerPath(root: string): string {
  return join(root, CAPABILITY_RELEASE_LEDGER_REL_PATH);
}

export function resolveCapabilityReleaseLedgerRoot(metadataRoot: string): string {
  const root = resolve(metadataRoot);
  const config = loadConfig(root);
  return resolveProjectGitRoot(root, config.gitRoot) ?? root;
}

function assertNonAuthoritative(record: ProductCapabilityReleaseRecord, index: number): void {
  if (record.authority !== 'non_authoritative') {
    throw new CapabilityReleaseLedgerError(
      `capability release ledger line ${index + 1}: authority must be 'non_authoritative' (got ${JSON.stringify(record.authority)}); a capability release is never authoritative.`,
    );
  }
  if (record.gateEvidence !== false) {
    throw new CapabilityReleaseLedgerError(
      `capability release ledger line ${index + 1}: gateEvidence must be false (got ${JSON.stringify(record.gateEvidence)}); a capability release is never gate evidence.`,
    );
  }
}

/**
 * Fail-closed reader. Filters by schemaVersion, and THROWS (does not silently
 * drop) on a parse error or on any row whose authority/gateEvidence invariant is
 * violated — a tampered ledger is an error, not a filtered noise row.
 */
export function readCapabilityReleaseLedger(root: string): ProductCapabilityReleaseRecord[] {
  const file = capabilityReleaseLedgerPath(root);
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf-8');
  const records: ProductCapabilityReleaseRecord[] = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: ProductCapabilityReleaseRecord;
    try {
      parsed = JSON.parse(line) as ProductCapabilityReleaseRecord;
    } catch (e: any) {
      throw new CapabilityReleaseLedgerError(
        `capability release ledger parse failed at line ${index + 1}: ${e?.message ?? e}`,
      );
    }
    if (parsed.schemaVersion !== CAPABILITY_RELEASE_SCHEMA_VERSION) continue;
    assertNonAuthoritative(parsed, index);
    records.push(parsed);
  }
  return records;
}

export function buildCapabilityReleaseRecord(opts: CapabilityReleaseRecordOptions): ProductCapabilityReleaseRecord {
  const capabilityId = opts.capabilityId.trim();
  if (!capabilityId) throw new Error('buildCapabilityReleaseRecord: capabilityId is required');
  const capabilityPaths = uniqueSortedCapabilityPaths(opts.capabilityPaths);
  const changedPaths = uniqueSortedCapabilityPaths(opts.changedPaths);
  const capabilityDigest = computeCapabilityDigest(
    capabilityId,
    opts.capabilityKind,
    capabilityPaths,
    opts.artifactSetDigest,
  );
  const capabilityVersion = capabilityVersionFromDigest(capabilityDigest);
  const idempotencyKey = `${opts.storyId}:${capabilityId}:${capabilityDigest}`;
  const id = `PCR-${sha256Hex(idempotencyKey).slice(0, 24)}`;
  return {
    schemaVersion: CAPABILITY_RELEASE_SCHEMA_VERSION,
    id,
    idempotencyKey,
    storyId: opts.storyId,
    createdAt: opts.now ?? new Date().toISOString(),
    mainCommit: opts.mainCommit?.trim() || 'uncommitted',
    capabilityId,
    ...(opts.capabilityName ? { capabilityName: opts.capabilityName } : {}),
    capabilityVersion,
    capabilityKind: opts.capabilityKind,
    capabilityDigest,
    ...(opts.artifactReleaseId ? { artifactReleaseId: opts.artifactReleaseId } : {}),
    ...(opts.artifactSetDigest ? { artifactSetDigest: opts.artifactSetDigest } : {}),
    changedPaths,
    runtimeSemverChanged: opts.runtimeSemverChanged,
    activationBoundary: opts.activationBoundary ?? 'non-runtime-capability',
    authority: 'non_authoritative',
    gateEvidence: false,
    notes: opts.notes ?? [
      'Product capability release provenance: records which reusable non-runtime product capability version a story released.',
      'Non-authoritative and never gate evidence; distinct from package semver and from the artifact release ledger.',
    ],
  };
}

export function appendCapabilityReleaseRecord(
  root: string,
  record: ProductCapabilityReleaseRecord,
): RecordCapabilityReleaseResult {
  const existing = readCapabilityReleaseLedger(root);
  const previous = existing.find(row => row.idempotencyKey === record.idempotencyKey);
  if (previous) return { status: 'already_recorded', record: previous };

  const file = capabilityReleaseLedgerPath(root);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf-8');
  return { status: 'recorded', record };
}

export function writeCapabilityReleaseLedgerForTest(
  root: string,
  records: ProductCapabilityReleaseRecord[],
): void {
  const file = capabilityReleaseLedgerPath(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''),
    'utf-8',
  );
}

export function createCapabilityReleaseRecordForTest(
  opts: CapabilityReleaseRecordOptions,
): ProductCapabilityReleaseRecord {
  return buildCapabilityReleaseRecord(opts);
}
