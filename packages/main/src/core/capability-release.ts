import { createHash } from 'node:crypto';
import { PROOF_OR_STOP_STATE_DIR } from './brand-paths.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { resolveProjectGitRoot } from './story-signed-workspace-resolution.js';
import {
  selectArtifactReleasePathsV1,
  readArtifactReleaseLedger,
  resolveArtifactReleaseLedgerRoot,
  type ArtifactReleaseRecordV1,
} from './artifact-release.js';
import { digestCanonicalJson } from './digest.js';
import { readPlaybooks, writePlaybooks, withLearningStoreLock } from './learning-store.js';
import type { Playbook, PlaybookLineage } from './experience-layer-types.js';

// B-cc10: this was hardcoded to the capability ledger under the retired state
// directory. The ledger file itself moved with CHK-003, so the constant pointed
// at a path that no longer holds it — the same defect class as managed-assets.json
// and the gap-log paths.
export const CAPABILITY_RELEASE_LEDGER_REL_PATH = `${PROOF_OR_STOP_STATE_DIR}/capability-releases.jsonl`;
export const CAPABILITY_RELEASE_SCHEMA_VERSION = 'proof-or-stop.product-capability-release.v1';

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
  /** Marked records contain only capability material; unmarked canonical v1 is historical read-only data. */
  changedPathsScope?: 'capability-material';
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
  /** FULL DONE-time classifier input; never persisted as the capability subset. */
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const CAPABILITY_KINDS = new Set<CapabilityKind>([
  'experiment-launch-control', 'workflow-control', 'evidence-control', 'memory-control', 'documentation-control', 'other',
]);
const CAPABILITY_ACTIVATION_BOUNDARIES = new Set<CapabilityActivationBoundary>(['non-runtime-capability', 'runtime-capability']);

export function capabilityReleaseRecordValidationErrors(
  value: unknown,
  options: { requireCurrentWrite?: boolean } = {},
): string[] {
  if (!isPlainRecord(value)) return ['record must be an object'];
  const errors: string[] = [];
  const requiredStrings = ['id', 'idempotencyKey', 'storyId', 'createdAt', 'mainCommit', 'capabilityId', 'capabilityVersion', 'capabilityDigest'] as const;
  for (const field of requiredStrings) if (!isNonEmptyString(value[field])) errors.push(`${field} must be a non-empty string`);
  if (value.schemaVersion !== CAPABILITY_RELEASE_SCHEMA_VERSION) errors.push(`schemaVersion must be ${CAPABILITY_RELEASE_SCHEMA_VERSION}`);
  if ((options.requireCurrentWrite || value.changedPathsScope !== undefined)
    && value.changedPathsScope !== 'capability-material') {
    errors.push('changedPathsScope must be capability-material for current writes or marked records');
  }
  if (isNonEmptyString(value.id) && !/^PCR-[a-f0-9]{24}$/u.test(value.id)) errors.push('id must be PCR-<24 lowercase hex>');
  if (isNonEmptyString(value.storyId) && !/^B-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(value.storyId)) errors.push('storyId must be a B-* Story id');
  if (isNonEmptyString(value.createdAt) && Number.isNaN(Date.parse(value.createdAt))) errors.push('createdAt must be an ISO-compatible timestamp');
  if (isNonEmptyString(value.mainCommit) && value.mainCommit !== 'uncommitted' && !/^[a-f0-9]{40}$/u.test(value.mainCommit)) errors.push('mainCommit must be a full lowercase Git SHA or uncommitted');
  if (value.capabilityName !== undefined && !isNonEmptyString(value.capabilityName)) errors.push('capabilityName must be a non-empty string when present');
  if (!CAPABILITY_KINDS.has(value.capabilityKind as CapabilityKind)) errors.push('capabilityKind is invalid');
  if (isNonEmptyString(value.capabilityDigest) && !/^sha256:[a-f0-9]{64}$/u.test(value.capabilityDigest)) errors.push('capabilityDigest must be sha256:<64 lowercase hex>');
  if (isNonEmptyString(value.capabilityVersion) && !/^[a-f0-9]{12}$/u.test(value.capabilityVersion)) errors.push('capabilityVersion must be 12 lowercase hex');
  if (value.artifactReleaseId !== undefined && (!isNonEmptyString(value.artifactReleaseId) || !/^AR-[a-f0-9]{24}$/u.test(value.artifactReleaseId))) errors.push('artifactReleaseId must be AR-<24 lowercase hex> when present');
  if (value.artifactSetDigest !== undefined && (!isNonEmptyString(value.artifactSetDigest) || !/^sha256:[a-f0-9]{64}$/u.test(value.artifactSetDigest))) errors.push('artifactSetDigest must be sha256:<64 lowercase hex> when present');
  if (!Array.isArray(value.changedPaths) || value.changedPaths.length === 0 || value.changedPaths.some(path => !isNonEmptyString(path))) {
    errors.push('changedPaths must be a non-empty array of non-empty strings');
  } else if (JSON.stringify(uniqueSortedCapabilityPaths(value.changedPaths as string[])) !== JSON.stringify(value.changedPaths)) {
    errors.push('changedPaths must be normalized, unique, and sorted');
  }
  if (value.changedPathsScope === 'capability-material'
    && Array.isArray(value.changedPaths) && value.changedPaths.every(isNonEmptyString)) {
    const paths = value.changedPaths as string[];
    if (JSON.stringify(selectArtifactReleasePathsV1(paths)) !== JSON.stringify(paths)) {
      errors.push('changedPaths must contain only the capability-material subset');
    }
    if (isNonEmptyString(value.capabilityId) && CAPABILITY_KINDS.has(value.capabilityKind as CapabilityKind)
      && (value.artifactSetDigest === undefined || isNonEmptyString(value.artifactSetDigest))) {
      const expectedDigest = computeCapabilityDigest(value.capabilityId, value.capabilityKind as CapabilityKind,
        paths, value.artifactSetDigest as string | undefined);
      if (value.capabilityDigest !== expectedDigest) errors.push('capabilityDigest does not match capability-material changedPaths/artifactSetDigest');
    }
  }
  if (typeof value.runtimeSemverChanged !== 'boolean') errors.push('runtimeSemverChanged must be boolean');
  if (!CAPABILITY_ACTIVATION_BOUNDARIES.has(value.activationBoundary as CapabilityActivationBoundary)) errors.push('activationBoundary is invalid');
  if (value.authority !== 'non_authoritative') errors.push("authority must be 'non_authoritative'");
  if (value.gateEvidence !== false) errors.push('gateEvidence must be false');
  if (!Array.isArray(value.notes) || value.notes.length === 0 || value.notes.some(note => !isNonEmptyString(note))) errors.push('notes must be a non-empty array of non-empty strings');
  if (isNonEmptyString(value.capabilityDigest) && isNonEmptyString(value.capabilityVersion) && value.capabilityVersion !== capabilityVersionFromDigest(value.capabilityDigest)) errors.push('capabilityVersion does not match capabilityDigest');
  if (isNonEmptyString(value.storyId) && isNonEmptyString(value.capabilityId) && isNonEmptyString(value.capabilityDigest)) {
    const expectedKey = `${value.storyId}:${value.capabilityId}:${value.capabilityDigest}`;
    if (value.idempotencyKey !== expectedKey) errors.push('idempotencyKey does not match storyId/capabilityId/capabilityDigest');
    if (isNonEmptyString(value.id) && value.id !== `PCR-${sha256Hex(expectedKey).slice(0, 24)}`) errors.push('id does not match idempotencyKey');
  }
  return errors;
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
    if (parsed.schemaVersion !== CAPABILITY_RELEASE_SCHEMA_VERSION) {
      throw new CapabilityReleaseLedgerError(
        `capability release ledger line ${index + 1}: unsupported identity schema ${String(parsed.schemaVersion)}; expected ${CAPABILITY_RELEASE_SCHEMA_VERSION}`,
      );
    }
    const errors = capabilityReleaseRecordValidationErrors(parsed);
    if (errors.length > 0) throw new CapabilityReleaseLedgerError(`capability release ledger line ${index + 1}: ${errors.join('; ')}`);
    assertNonAuthoritative(parsed, index);
    records.push(parsed);
  }
  return records;
}

export function buildCapabilityReleaseRecord(opts: CapabilityReleaseRecordOptions): ProductCapabilityReleaseRecord {
  const capabilityId = opts.capabilityId.trim();
  if (!capabilityId) throw new Error('buildCapabilityReleaseRecord: capabilityId is required');
  const capabilityPaths = uniqueSortedCapabilityPaths(opts.capabilityPaths);
  const fullChangedPaths = new Set(uniqueSortedCapabilityPaths(opts.changedPaths));
  if (capabilityPaths.some(path => !fullChangedPaths.has(path))) {
    throw new CapabilityReleaseLedgerError('capabilityPaths must be a subset of the full DONE changedPaths input');
  }
  const capabilityDigest = computeCapabilityDigest(
    capabilityId,
    opts.capabilityKind,
    capabilityPaths,
    opts.artifactSetDigest,
  );
  const capabilityVersion = capabilityVersionFromDigest(capabilityDigest);
  const idempotencyKey = `${opts.storyId}:${capabilityId}:${capabilityDigest}`;
  const id = `PCR-${sha256Hex(idempotencyKey).slice(0, 24)}`;
  const record: ProductCapabilityReleaseRecord = {
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
    changedPathsScope: 'capability-material',
    changedPaths: capabilityPaths,
    runtimeSemverChanged: opts.runtimeSemverChanged,
    activationBoundary: opts.activationBoundary ?? 'non-runtime-capability',
    authority: 'non_authoritative',
    gateEvidence: false,
    notes: opts.notes ?? [
      'Product capability release provenance: records which reusable non-runtime product capability version a story released.',
      'Non-authoritative and never gate evidence; distinct from package semver and from the artifact release ledger.',
    ],
  };
  const errors = capabilityReleaseRecordValidationErrors(record, { requireCurrentWrite: true });
  if (errors.length > 0) throw new CapabilityReleaseLedgerError(`capability release build: ${errors.join('; ')}`);
  return record;
}

export function appendCapabilityReleaseRecord(
  root: string,
  record: ProductCapabilityReleaseRecord,
): RecordCapabilityReleaseResult {
  // Validate the new-write claim before idempotency: an existing row never
  // authorizes an unmarked or tampered append input.
  const errors = capabilityReleaseRecordValidationErrors(record, { requireCurrentWrite: true });
  if (errors.length > 0) throw new CapabilityReleaseLedgerError(`capability release append: ${errors.join('; ')}`);
  const existing = readCanonicalCapabilityReleaseRecordsForAppend(root);
  const previous = existing.find(row => row.idempotencyKey === record.idempotencyKey);
  if (previous) return { status: 'already_recorded', record: previous };

  const file = capabilityReleaseLedgerPath(root);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf-8');
  return { status: 'recorded', record };
}

/**
 * Writer-only idempotency scan. Historical non-canonical rows remain opaque and
 * are admitted only by DONE's frozen-provenance verifier. They are never exposed
 * as active capability-release records.
 */
function readCanonicalCapabilityReleaseRecordsForAppend(root: string): ProductCapabilityReleaseRecord[] {
  const file = capabilityReleaseLedgerPath(root);
  if (!existsSync(file)) return [];
  const records: ProductCapabilityReleaseRecord[] = [];
  for (const [index, rawLine] of readFileSync(file, 'utf-8').split(/\r?\n/).entries()) {
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
    const errors = capabilityReleaseRecordValidationErrors(parsed);
    if (errors.length > 0) {
      throw new CapabilityReleaseLedgerError(`capability release ledger line ${index + 1}: ${errors.join('; ')}`);
    }
    assertNonAuthoritative(parsed, index);
    records.push(parsed);
  }
  return records;
}

/**
 * PURE, deterministic capability-release classifier (M2).
 *
 * Reuses the artifact-release path-selection idea: from the FULL DONE-time
 * changed-path list, select only capability-declaring paths under `docs/**`
 * or `experiments/**`, EXCLUDING `.proof-or-stop/**`, `docs/story/**`,
 * `packages/main/src/**`, and root manifests/locks (the exact same conservative
 * filter as {@link selectArtifactReleasePathsV1}). If no capability-declaring
 * path survives, returns `null` — there is NO capability release and the caller
 * emits an advisory instead of inventing one.
 *
 * capabilityId is derived host-neutrally via {@link deriveCapabilityIdSlug}
 * (shallowest shared directory slug); if that slug is null the classifier is
 * conservative and returns `null` rather than guessing an identity.
 *
 * capabilityKind is chosen conservatively and deterministically:
 * `experiment-launch-control` if ANY capability path is under `experiments/`,
 * else `documentation-control` if all are under `docs/`, else `other`.
 */
export function classifyCapabilityRelease(
  changedPaths: string[],
  opts: { isRuntimeBuildInput?: (path: string) => boolean } = {},
): { capabilityKind: CapabilityKind; capabilityId: string; capabilityPaths: string[] } | null {
  const capabilityPaths = selectArtifactReleasePathsV1(changedPaths, {
    isRuntimeBuildInput: opts.isRuntimeBuildInput,
  });
  if (capabilityPaths.length === 0) return null;

  const capabilityId = deriveCapabilityIdSlug(capabilityPaths);
  if (!capabilityId) return null;

  const anyExperiment = capabilityPaths.some(path => path.startsWith('experiments/'));
  const allDocs = capabilityPaths.every(path => path.startsWith('docs/'));
  const capabilityKind: CapabilityKind = anyExperiment
    ? 'experiment-launch-control'
    : allDocs
      ? 'documentation-control'
      : 'other';

  return { capabilityKind, capabilityId, capabilityPaths };
}

export interface RecordCapabilityReleaseForDoneMergeOptions {
  /** Ledger root (already resolved to the project git root by the caller). */
  root: string;
  storyId: string;
  mainCommit?: string;
  /** FULL DONE-time changed-path list; the classifier selects the capability subset. */
  changedPaths: string[];
  runtimeSemverChanged: boolean;
  /** Passed through from the artifact release when the caller recorded one. */
  artifactReleaseId?: string;
  /** Folded into capabilityDigest; passed through from the artifact release when available. */
  artifactSetDigest?: string;
  capabilityName?: string;
  isRuntimeBuildInput?: (path: string) => boolean;
  now?: string;
}

export interface RecordCapabilityReleaseForDoneMergeResult {
  status: 'recorded' | 'already_recorded' | 'skipped_empty';
  record?: ProductCapabilityReleaseRecord;
}

/**
 * Mirrors `recordArtifactReleaseForDoneMerge`: run the pure classifier over the
 * DONE-time changed paths; if it declines (`null`) return `skipped_empty` so the
 * caller emits an advisory. Otherwise build a merge-stable record (passing the
 * artifact release id/digest through, so identical content re-merged/recovered
 * dedups) and append it (idempotent on idempotencyKey).
 */
export function recordCapabilityReleaseForDoneMerge(
  opts: RecordCapabilityReleaseForDoneMergeOptions,
): RecordCapabilityReleaseForDoneMergeResult {
  const classified = classifyCapabilityRelease(opts.changedPaths, {
    isRuntimeBuildInput: opts.isRuntimeBuildInput,
  });
  if (!classified) return { status: 'skipped_empty' };

  const record = buildCapabilityReleaseRecord({
    root: opts.root,
    storyId: opts.storyId,
    mainCommit: opts.mainCommit,
    capabilityId: classified.capabilityId,
    capabilityName: opts.capabilityName,
    capabilityKind: classified.capabilityKind,
    changedPaths: opts.changedPaths,
    capabilityPaths: classified.capabilityPaths,
    artifactReleaseId: opts.artifactReleaseId,
    artifactSetDigest: opts.artifactSetDigest,
    runtimeSemverChanged: opts.runtimeSemverChanged,
    now: opts.now,
  });
  return appendCapabilityReleaseRecord(opts.root, record);
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

// ── M8: capability_release_backfill — record-then-bind migration ──────────────
//
// B-8128 M4 enriches capability-release lineage at candidate-CREATION time (via
// enrichSeedWithCapabilityLineage). Candidates created BEFORE their story had a
// recorded capability release stay "under-bound": lineage.sourceStoryId is set
// but lineage.capabilityReleaseId is absent. There are TWO reasons a story can be
// missing that binding, and this migration handles both:
//
//   plan='bind'            A capability release ALREADY exists for the story — the
//                          candidate just was created too early. Bind it.
//   plan='record-then-bind' The story has an ARTIFACT release but NO capability
//                          release (it DONE'd before the capability-release feature
//                          existed, so the DONE classifier never recorded one).
//                          RECORD a capability release for it (classify the artifact
//                          release's paths; conservatively skip if the classifier
//                          declines), THEN bind the candidate.
//
// It is a DELIBERATE, DIGEST-GUARDED writer: default dry-run emits a plan +
// deterministic plan digest; --apply requires the matching digest, records any
// missing capability releases (committed the same `git add -f` way as B-8128's
// DONE-merge ledger commit), and enriches ONLY the eligible candidates' lineage.
// It NEVER changes .status (candidate stays candidate), NEVER touches
// usage.surfacedCount, and NEVER appends a playbook-outcome.

export const CAPABILITY_RELEASE_BACKFILL_SCHEMA_VERSION =
  'proof-or-stop.capability-release-backfill.v1';

export type CapabilityReleaseBackfillPlanKind = 'bind' | 'record-then-bind';

/** One eligible under-bound candidate and the capability release it will bind to. */
export interface CapabilityReleaseBackfillEligibleRow {
  playbookId: string;
  sourceStoryId: string;
  /**
   * 'bind' when a capability release already exists; 'record-then-bind' when the
   * story has an artifact release but no capability release (one WILL be recorded).
   */
  plan: CapabilityReleaseBackfillPlanKind;
  /** `PCR-…` id of the capability release to set as capabilityReleaseId. */
  capabilityReleaseId: string;
  capabilityId: string;
  capabilityVersion: string;
  /** Present only when the matching capability release carries an artifactReleaseId. */
  artifactReleaseId?: string;
  /**
   * For plan='record-then-bind': the artifact release id the capability release is
   * derived from (human-facing plan note). Same value as artifactReleaseId.
   */
  fromArtifactReleaseId?: string;
}

export interface CapabilityReleaseBackfillReport {
  schemaVersion: typeof CAPABILITY_RELEASE_BACKFILL_SCHEMA_VERSION;
  dryRun: boolean;
  applied: boolean;
  /** Always non-authoritative: this backfill is never gate/release evidence. */
  authority: 'non_authoritative';
  gateEvidence: false;
  /** Optional single-story filter that was applied (or null for all stories). */
  storyFilter: string | null;
  /** Candidate playbooks scanned (post story filter). */
  candidateCount: number;
  /** Number of eligible under-bound candidates. */
  eligibleCount: number;
  /** Eligible candidates whose plan is 'record-then-bind' (a PCR will be recorded). */
  recordThenBindCount: number;
  /** Capability releases recorded by this run (0 unless --apply succeeded). */
  recordedReleaseCount: number;
  /** Number of candidates enriched by this run (0 unless --apply succeeded). */
  enrichedCount: number;
  /** Deterministic digest over the canonical eligible set; required for --apply. */
  planDigest: string;
  eligible: CapabilityReleaseBackfillEligibleRow[];
}

/** Injected git runner (defaults to a plain execFileSync-style runner via handler). */
export type BackfillGitRunner = (gitArgs: string[], cwd: string) => string;

export interface BuildCapabilityReleaseBackfillOptions {
  /** Project root (resolved to the ledger/git root internally). */
  root: string;
  /** Optional single-story filter (only candidates for this sourceStoryId). */
  storyId?: string;
  /** Opt-in real write. Default false → dry-run plan only. */
  apply?: boolean;
  /** Required when apply=true: must equal the current dry-run planDigest. */
  digest?: string;
  /**
   * Runs a git command; required for --apply so a newly-recorded capability release
   * is `git add -f`-committed (mirrors B-8128's commitCapabilityReleaseLedgerIfNeeded).
   * Injected so a hermetic (non-git) smoke can supply a no-op runner.
   */
  runGit?: BackfillGitRunner;
  /** Deterministic createdAt for any capability release recorded by this run. */
  now?: string;
}

/**
 * Deterministically pre-compute the capability release record a 'record-then-bind'
 * candidate WOULD get. Runs the SAME pure classifier B-8128 uses on the artifact
 * release's already-selected `paths`, then builds a merge-stable record passing the
 * artifact release's id + artifactSetDigest through (so a real DONE-merge that later
 * recorded the same content would dedup on idempotencyKey). Returns null when the
 * classifier declines (the paths do not declare a reusable capability) — conservative.
 */
function plannedCapabilityReleaseFromArtifact(
  storyId: string,
  artifact: ArtifactReleaseRecordV1,
  now: string,
): ProductCapabilityReleaseRecord | null {
  const classified = classifyCapabilityRelease(artifact.paths);
  if (!classified) return null;
  return buildCapabilityReleaseRecord({
    root: '', // unused by buildCapabilityReleaseRecord (identity is content-only)
    storyId,
    mainCommit: artifact.mainCommit,
    capabilityId: classified.capabilityId,
    capabilityKind: classified.capabilityKind,
    changedPaths: artifact.paths,
    capabilityPaths: classified.capabilityPaths,
    artifactReleaseId: artifact.id,
    artifactSetDigest: artifact.artifactSetDigest,
    runtimeSemverChanged: artifact.runtimeSemverChanged,
    now,
  });
}

interface EligiblePlan {
  rows: CapabilityReleaseBackfillEligibleRow[];
  /** Capability releases to record on --apply, keyed by sourceStoryId (deduped). */
  releasesToRecord: Map<string, ProductCapabilityReleaseRecord>;
}

/**
 * Compute the eligible set. A candidate is eligible iff it is status:candidate, has a
 * lineage.sourceStoryId, lacks lineage.capabilityReleaseId, and EITHER:
 *   (bind)            its story has a capability release, OR
 *   (record-then-bind) its story has an artifact release but no capability release
 *                      AND the classifier accepts that artifact's paths.
 * Deterministic (sorted by playbookId; multi-release stories bind the latest by
 * createdAt). Also returns the exact PCR records a --apply would record.
 */
function computeCapabilityReleaseBackfillEligible(
  playbooks: Playbook[],
  capabilityRecords: ProductCapabilityReleaseRecord[],
  artifactRecords: ArtifactReleaseRecordV1[],
  storyFilter: string | null,
  now: string,
): EligiblePlan {
  const latestCapabilityByStory = new Map<string, ProductCapabilityReleaseRecord>();
  for (const record of capabilityRecords) {
    const prior = latestCapabilityByStory.get(record.storyId);
    if (!prior || record.createdAt.localeCompare(prior.createdAt) > 0) {
      latestCapabilityByStory.set(record.storyId, record);
    }
  }
  const latestArtifactByStory = new Map<string, ArtifactReleaseRecordV1>();
  for (const record of artifactRecords) {
    const prior = latestArtifactByStory.get(record.storyId);
    if (!prior || record.createdAt.localeCompare(prior.createdAt) > 0) {
      latestArtifactByStory.set(record.storyId, record);
    }
  }

  // Deterministically pre-compute the PCR each release-less story would record, so
  // both dry-run and apply see the SAME id/version and the digest stays stable.
  const plannedByStory = new Map<string, ProductCapabilityReleaseRecord>();

  const rows: CapabilityReleaseBackfillEligibleRow[] = [];
  for (const playbook of playbooks) {
    if (playbook.status !== 'candidate') continue;
    const lineage = playbook.lineage;
    const sourceStoryId = lineage?.sourceStoryId;
    if (!sourceStoryId) continue;
    if (storyFilter && sourceStoryId !== storyFilter) continue;
    if (lineage.capabilityReleaseId) continue; // already bound

    const existing = latestCapabilityByStory.get(sourceStoryId);
    if (existing) {
      rows.push({
        playbookId: playbook.id,
        sourceStoryId,
        plan: 'bind',
        capabilityReleaseId: existing.id,
        capabilityId: existing.capabilityId,
        capabilityVersion: existing.capabilityVersion,
        ...(existing.artifactReleaseId ? { artifactReleaseId: existing.artifactReleaseId } : {}),
      });
      continue;
    }

    // No capability release: try to derive one from an artifact release.
    const artifact = latestArtifactByStory.get(sourceStoryId);
    if (!artifact) continue; // nothing to record from → not eligible
    let planned = plannedByStory.get(sourceStoryId);
    if (!planned) {
      const derived = plannedCapabilityReleaseFromArtifact(sourceStoryId, artifact, now);
      if (!derived) continue; // classifier declined → conservatively not eligible
      planned = derived;
      plannedByStory.set(sourceStoryId, derived);
    }
    rows.push({
      playbookId: playbook.id,
      sourceStoryId,
      plan: 'record-then-bind',
      capabilityReleaseId: planned.id,
      capabilityId: planned.capabilityId,
      capabilityVersion: planned.capabilityVersion,
      ...(planned.artifactReleaseId ? { artifactReleaseId: planned.artifactReleaseId } : {}),
      ...(planned.artifactReleaseId ? { fromArtifactReleaseId: planned.artifactReleaseId } : {}),
    });
  }
  rows.sort((a, b) => a.playbookId.localeCompare(b.playbookId));

  // Only keep planned PCRs that an eligible row actually references.
  const referenced = new Set(
    rows.filter((r) => r.plan === 'record-then-bind').map((r) => r.sourceStoryId),
  );
  const releasesToRecord = new Map<string, ProductCapabilityReleaseRecord>();
  for (const [storyId, record] of plannedByStory) {
    if (referenced.has(storyId)) releasesToRecord.set(storyId, record);
  }
  return { rows, releasesToRecord };
}

/**
 * Deterministic plan digest over the canonical eligible set. Bound to plan kind /
 * storyId / capabilityReleaseId / capabilityId / capabilityVersion / artifactReleaseId
 * so an --apply cannot ride a stale digest after the ledgers or playbooks changed.
 */
export function computeCapabilityReleaseBackfillPlanDigest(
  eligible: CapabilityReleaseBackfillEligibleRow[],
): string {
  return `sha256:${digestCanonicalJson({
    schemaVersion: CAPABILITY_RELEASE_BACKFILL_SCHEMA_VERSION,
    eligible: eligible.map((row) => ({
      playbookId: row.playbookId,
      sourceStoryId: row.sourceStoryId,
      plan: row.plan,
      capabilityReleaseId: row.capabilityReleaseId,
      capabilityId: row.capabilityId,
      capabilityVersion: row.capabilityVersion,
      artifactReleaseId: row.artifactReleaseId ?? null,
    })),
  })}`;
}

/**
 * Enrich exactly the eligible candidate's lineage with the capability-release
 * identity, mirroring the field set B-8128's enrichSeedWithCapabilityLineage sets.
 * PURE on the lineage: returns a new lineage; never mutates status/usage.
 */
function bindLineageToRelease(
  lineage: PlaybookLineage,
  row: CapabilityReleaseBackfillEligibleRow,
): PlaybookLineage {
  return {
    ...lineage,
    capabilityReleaseId: row.capabilityReleaseId,
    capabilityId: row.capabilityId,
    capabilityVersion: row.capabilityVersion,
    ...(row.artifactReleaseId ? { artifactReleaseId: row.artifactReleaseId } : {}),
  };
}

/**
 * Commit a just-appended capability-releases ledger the same `git add -f` way as
 * B-8128's commitCapabilityReleaseLedgerIfNeeded, so the migration's records are
 * tracked. A hermetic (non-git) smoke passes a no-op runGit and this is a no-op.
 */
function commitBackfilledCapabilityReleaseLedger(
  ledgerRoot: string,
  storyIds: string[],
  runGit: BackfillGitRunner,
): void {
  if (storyIds.length === 0) return;
  try {
    runGit(['add', '-f', CAPABILITY_RELEASE_LEDGER_REL_PATH], ledgerRoot);
    const staged = runGit(
      ['diff', '--cached', '--name-only', '--', CAPABILITY_RELEASE_LEDGER_REL_PATH],
      ledgerRoot,
    );
    if (!staged) return; // nothing to commit (already tracked/committed) → idempotent
    runGit(
      [
        '-c', 'commit.gpgsign=false', 'commit', '-m',
        `proof-or-stop: backfill product capability release for ${storyIds.join(', ')}`,
      ],
      ledgerRoot,
    );
  } catch (e: any) {
    throw new Error(
      `capability_release_backfill: capability release ledger commit failed: ${e?.message ?? e}\n` +
      `Recovery: git add ${CAPABILITY_RELEASE_LEDGER_REL_PATH} && git commit -m "proof-or-stop: backfill product capability release"`,
    );
  }
}

/**
 * M8 planner+applier (record-then-bind migration). Default dry-run returns the
 * eligible set + a deterministic plan digest. --apply requires `digest` to equal the
 * current plan digest, records any missing capability releases (append + git commit),
 * then enriches ONLY the eligible candidates' lineage and writes them back via
 * writePlaybooks. Idempotent: after apply, every story has a capability release and
 * every candidate is bound, so a re-run finds 0 eligible. It never changes status,
 * never touches usage, and never writes an outcome.
 */
export function buildCapabilityReleaseBackfillReport(
  opts: BuildCapabilityReleaseBackfillOptions,
): CapabilityReleaseBackfillReport {
  const apply = opts.apply === true;
  const storyFilter = typeof opts.storyId === 'string' && opts.storyId.trim()
    ? opts.storyId.trim()
    : null;
  const capabilityLedgerRoot = resolveCapabilityReleaseLedgerRoot(opts.root);
  const artifactLedgerRoot = resolveArtifactReleaseLedgerRoot(opts.root);
  const now = opts.now ?? new Date().toISOString();

  const run = (): CapabilityReleaseBackfillReport => {
    const capabilityRecords = readCapabilityReleaseLedger(capabilityLedgerRoot);
    const artifactRecords = readArtifactReleaseLedger(artifactLedgerRoot);
    const playbooks = readPlaybooks(opts.root);
    const candidateCount = playbooks.filter(
      (p) => p.status === 'candidate'
        && p.lineage?.sourceStoryId
        && (!storyFilter || p.lineage.sourceStoryId === storyFilter),
    ).length;
    const { rows: eligible, releasesToRecord } = computeCapabilityReleaseBackfillEligible(
      playbooks,
      capabilityRecords,
      artifactRecords,
      storyFilter,
      now,
    );
    const planDigest = computeCapabilityReleaseBackfillPlanDigest(eligible);
    const recordThenBindCount = eligible.filter((r) => r.plan === 'record-then-bind').length;

    if (!apply) {
      return {
        schemaVersion: CAPABILITY_RELEASE_BACKFILL_SCHEMA_VERSION,
        dryRun: true,
        applied: false,
        authority: 'non_authoritative',
        gateEvidence: false,
        storyFilter,
        candidateCount,
        eligibleCount: eligible.length,
        recordThenBindCount,
        recordedReleaseCount: 0,
        enrichedCount: 0,
        planDigest,
        eligible,
      };
    }

    const expected = (opts.digest ?? '').trim();
    if (!expected) {
      throw new Error('capability_release_backfill requires --digest when --apply is set');
    }
    if (expected !== planDigest) {
      throw new Error(
        `capability_release_backfill: plan digest drift; expected ${expected}, current ${planDigest}. Re-run the dry-run and pass the fresh digest.`,
      );
    }
    if (recordThenBindCount > 0 && typeof opts.runGit !== 'function') {
      throw new Error(
        'capability_release_backfill: --apply needs a git runner to commit newly-recorded capability releases',
      );
    }

    // STEP 1: record any missing capability releases (append + commit).
    let recordedReleaseCount = 0;
    const recordedStoryIds: string[] = [];
    if (releasesToRecord.size > 0) {
      for (const [storyId, record] of [...releasesToRecord.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const result = appendCapabilityReleaseRecord(capabilityLedgerRoot, record);
        if (result.status === 'recorded') {
          recordedReleaseCount += 1;
          recordedStoryIds.push(storyId);
        }
        // Fail-closed: the release the plan promised must now be readable.
        const persisted = readCapabilityReleaseLedger(capabilityLedgerRoot)
          .find((r) => r.storyId === storyId && r.id === record.id);
        if (!persisted) {
          throw new Error(`capability_release_backfill: recorded capability release ${record.id} for ${storyId} is not readable back`);
        }
      }
      commitBackfilledCapabilityReleaseLedger(capabilityLedgerRoot, recordedStoryIds, opts.runGit!);
    }

    // STEP 2: bind the eligible candidates' lineage.
    let enrichedCount = 0;
    if (eligible.length > 0) {
      const bindById = new Map(eligible.map((row) => [row.playbookId, row]));
      const next = playbooks.map((playbook) => {
        const row = bindById.get(playbook.id);
        // Enrich ONLY eligible candidates; status/usage are carried through verbatim.
        if (!row || playbook.status !== 'candidate' || playbook.lineage?.capabilityReleaseId) {
          return playbook;
        }
        return { ...playbook, lineage: bindLineageToRelease(playbook.lineage, row) };
      });
      writePlaybooks(opts.root, next);

      // Fail-closed write verification: only lineage capability fields changed;
      // status and usage.surfacedCount are byte-identical to before.
      const after = readPlaybooks(opts.root);
      const beforeById = new Map(playbooks.map((p) => [p.id, p]));
      for (const row of eligible) {
        const persisted = after.find((p) => p.id === row.playbookId);
        const prior = beforeById.get(row.playbookId);
        if (!persisted || !prior) {
          throw new Error(`capability_release_backfill: write verification failed; ${row.playbookId} missing after write`);
        }
        if (persisted.lineage.capabilityReleaseId !== row.capabilityReleaseId) {
          throw new Error(`capability_release_backfill: write verification failed; ${row.playbookId} lineage not bound`);
        }
        if (persisted.status !== 'candidate' || persisted.status !== prior.status) {
          throw new Error(`capability_release_backfill: write verification failed; ${row.playbookId} status changed`);
        }
        if (persisted.usage.surfacedCount !== prior.usage.surfacedCount) {
          throw new Error(`capability_release_backfill: write verification failed; ${row.playbookId} usage.surfacedCount changed`);
        }
        enrichedCount += 1;
      }
      // No unrelated playbook may vanish.
      for (const prior of playbooks) {
        if (!after.some((p) => p.id === prior.id)) {
          throw new Error(`capability_release_backfill: write verification failed; existing playbook ${prior.id} disappeared`);
        }
      }
    }

    return {
      schemaVersion: CAPABILITY_RELEASE_BACKFILL_SCHEMA_VERSION,
      dryRun: false,
      applied: true,
      authority: 'non_authoritative',
      gateEvidence: false,
      storyFilter,
      candidateCount,
      eligibleCount: eligible.length,
      recordThenBindCount,
      recordedReleaseCount,
      enrichedCount,
      planDigest,
      eligible,
    };
  };

  if (!apply) return run();
  return withLearningStoreLock(opts.root, 'capability-release-backfill', run);
}

export function renderCapabilityReleaseBackfill(
  report: CapabilityReleaseBackfillReport,
  json?: boolean,
): string {
  if (json) return JSON.stringify(report, null, 2);
  return [
    'Capability release backfill',
    `dryRun: ${report.dryRun}`,
    `applied: ${report.applied}`,
    `authority: ${report.authority}`,
    `gateEvidence: ${report.gateEvidence}`,
    `storyFilter: ${report.storyFilter ?? 'all'}`,
    `candidateCount: ${report.candidateCount}`,
    `eligibleCount: ${report.eligibleCount}`,
    `recordThenBindCount: ${report.recordThenBindCount}`,
    `recordedReleaseCount: ${report.recordedReleaseCount}`,
    `enrichedCount: ${report.enrichedCount}`,
    `planDigest: ${report.planDigest}`,
    ...report.eligible.map((row) =>
      row.plan === 'record-then-bind'
        ? `  - ${row.playbookId} sourceStory=${row.sourceStoryId} [record-then-bind] would record PCR ${row.capabilityReleaseId} (capabilityId=${row.capabilityId} capabilityVersion=${row.capabilityVersion}) from ${row.fromArtifactReleaseId ?? '?'}, then bind ${row.playbookId}`
        : `  - ${row.playbookId} sourceStory=${row.sourceStoryId} [bind] -> capabilityReleaseId=${row.capabilityReleaseId} capabilityId=${row.capabilityId} capabilityVersion=${row.capabilityVersion}${row.artifactReleaseId ? ` artifactReleaseId=${row.artifactReleaseId}` : ''}`),
  ].join('\n');
}
