import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { resolveProjectGitRoot } from './story-signed-workspace-resolution.js';
import { selectArtifactReleasePathsV1 } from './artifact-release.js';
import { digestCanonicalJson } from './digest.js';
import { readPlaybooks, writePlaybooks, withLearningStoreLock } from './learning-store.js';
import type { Playbook, PlaybookLineage } from './experience-layer-types.js';

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

/**
 * PURE, deterministic capability-release classifier (M2).
 *
 * Reuses the artifact-release path-selection idea: from the FULL DONE-time
 * changed-path list, select only capability-declaring paths under `docs/**`
 * or `experiments/**`, EXCLUDING `.lattice/**`, `docs/story/**`,
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

// ── M8: capability_release_backfill — bind ALREADY-EXISTING candidates ────────
//
// B-8128 M4 enriches capability-release lineage at candidate-CREATION time (via
// enrichSeedWithCapabilityLineage). Candidates created BEFORE their story had a
// recorded capability release stay "under-bound": lineage.sourceStoryId is set
// but lineage.capabilityReleaseId is absent even though a matching capability
// release now exists. This backfill binds exactly those candidates.
//
// It is a DELIBERATE, DIGEST-GUARDED writer: default dry-run emits a plan +
// deterministic plan digest; --apply requires the matching digest and enriches
// ONLY the eligible candidates' lineage. It NEVER changes .status (candidate
// stays candidate), NEVER touches usage.surfacedCount, NEVER appends a
// playbook-outcome, and NEVER mutates the capability-releases ledger.

export const CAPABILITY_RELEASE_BACKFILL_SCHEMA_VERSION =
  'proofbound.capability-release-backfill.v1';

/** One eligible under-bound candidate and the capability release it will bind to. */
export interface CapabilityReleaseBackfillEligibleRow {
  playbookId: string;
  sourceStoryId: string;
  /** `PCR-…` id of the matching capability release to set as capabilityReleaseId. */
  capabilityReleaseId: string;
  capabilityId: string;
  capabilityVersion: string;
  /** Present only when the matching capability release carries an artifactReleaseId. */
  artifactReleaseId?: string;
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
  /** Number of candidates enriched by this run (0 unless --apply succeeded). */
  enrichedCount: number;
  /** Deterministic digest over the canonical eligible set; required for --apply. */
  planDigest: string;
  eligible: CapabilityReleaseBackfillEligibleRow[];
}

export interface BuildCapabilityReleaseBackfillOptions {
  /** Project root (resolved to the ledger/git root internally). */
  root: string;
  /** Optional single-story filter (only candidates for this sourceStoryId). */
  storyId?: string;
  /** Opt-in real write. Default false → dry-run plan only. */
  apply?: boolean;
  /** Required when apply=true: must equal the current dry-run planDigest. */
  digest?: string;
}

/**
 * Compute the eligible set: candidate playbooks whose lineage.sourceStoryId has a
 * capability release but whose lineage.capabilityReleaseId is absent. Deterministic
 * (sorted by playbookId). A story with more than one capability release binds to the
 * latest by createdAt (same "first matching record" spirit as B-8128 enrichment,
 * made deterministic under duplicates).
 */
function computeCapabilityReleaseBackfillEligible(
  playbooks: Playbook[],
  records: ProductCapabilityReleaseRecord[],
  storyFilter: string | null,
): CapabilityReleaseBackfillEligibleRow[] {
  const latestByStory = new Map<string, ProductCapabilityReleaseRecord>();
  for (const record of records) {
    const prior = latestByStory.get(record.storyId);
    if (!prior || record.createdAt.localeCompare(prior.createdAt) > 0) {
      latestByStory.set(record.storyId, record);
    }
  }
  const rows: CapabilityReleaseBackfillEligibleRow[] = [];
  for (const playbook of playbooks) {
    if (playbook.status !== 'candidate') continue;
    const lineage = playbook.lineage;
    const sourceStoryId = lineage?.sourceStoryId;
    if (!sourceStoryId) continue;
    if (storyFilter && sourceStoryId !== storyFilter) continue;
    if (lineage.capabilityReleaseId) continue; // already bound
    const record = latestByStory.get(sourceStoryId);
    if (!record) continue; // no capability release for this story
    rows.push({
      playbookId: playbook.id,
      sourceStoryId,
      capabilityReleaseId: record.id,
      capabilityId: record.capabilityId,
      capabilityVersion: record.capabilityVersion,
      ...(record.artifactReleaseId ? { artifactReleaseId: record.artifactReleaseId } : {}),
    });
  }
  return rows.sort((a, b) => a.playbookId.localeCompare(b.playbookId));
}

/**
 * Deterministic plan digest over the canonical eligible set. Bound to storyId /
 * capabilityReleaseId / capabilityId / capabilityVersion / artifactReleaseId so an
 * --apply cannot ride a stale digest after the ledger or playbooks changed.
 */
export function computeCapabilityReleaseBackfillPlanDigest(
  eligible: CapabilityReleaseBackfillEligibleRow[],
): string {
  return `sha256:${digestCanonicalJson({
    schemaVersion: CAPABILITY_RELEASE_BACKFILL_SCHEMA_VERSION,
    eligible: eligible.map((row) => ({
      playbookId: row.playbookId,
      sourceStoryId: row.sourceStoryId,
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
 * M8 planner+applier. Default dry-run returns the eligible set + a deterministic
 * plan digest. --apply requires `digest` to equal the current plan digest, then
 * enriches ONLY the eligible candidates' lineage (capabilityReleaseId/
 * capabilityId/capabilityVersion/artifactReleaseId) and writes them back via
 * writePlaybooks. Idempotent: a re-run finds 0 eligible (they are now bound). It
 * never changes status, never touches usage, never writes an outcome, and never
 * mutates the capability-releases ledger.
 */
export function buildCapabilityReleaseBackfillReport(
  opts: BuildCapabilityReleaseBackfillOptions,
): CapabilityReleaseBackfillReport {
  const apply = opts.apply === true;
  const storyFilter = typeof opts.storyId === 'string' && opts.storyId.trim()
    ? opts.storyId.trim()
    : null;
  const ledgerRoot = resolveCapabilityReleaseLedgerRoot(opts.root);

  const run = (): CapabilityReleaseBackfillReport => {
    const records = readCapabilityReleaseLedger(ledgerRoot);
    const playbooks = readPlaybooks(opts.root);
    const candidateCount = playbooks.filter(
      (p) => p.status === 'candidate'
        && p.lineage?.sourceStoryId
        && (!storyFilter || p.lineage.sourceStoryId === storyFilter),
    ).length;
    const eligible = computeCapabilityReleaseBackfillEligible(playbooks, records, storyFilter);
    const planDigest = computeCapabilityReleaseBackfillPlanDigest(eligible);

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
    `enrichedCount: ${report.enrichedCount}`,
    `planDigest: ${report.planDigest}`,
    ...report.eligible.map((row) =>
      `  - ${row.playbookId} sourceStory=${row.sourceStoryId} -> capabilityReleaseId=${row.capabilityReleaseId} capabilityId=${row.capabilityId} capabilityVersion=${row.capabilityVersion}${row.artifactReleaseId ? ` artifactReleaseId=${row.artifactReleaseId}` : ''}`),
  ].join('\n');
}
