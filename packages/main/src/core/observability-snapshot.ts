/**
 * @task B-381e
 * @checklist CHK-002
 * @title host-neutral observability snapshot adapter skeleton
 * @type feature
 * @priority high
 * @description
 *   Read-only adapter that assembles the data shape future Proofbound
 *   observability UI surfaces need without parsing `session_brief`/`status`
 *   Markdown and without reading backing story JSON directly. It consumes the
 *   local assurance story projection row-by-row, then opens a fresh `StoryStore`
 *   rooted at each row's `activeCwd` and projects through `buildCanonicalStory`
 *   so active worktree stories aren't read from a stale main mirror. The
 *   snapshot is L0 host-neutral observation, never release readiness evidence.
 * @changes
 *   - [CHK-002] Add validator-required changes metadata for the observability snapshot adapter task header.
 */

import {
  LOCAL_ASSURANCE_STORY_PROJECTION_SCHEMA_VERSION,
  resolveLocalAssuranceStories,
  type LocalAssuranceStoryProjection,
  type LocalAssuranceStoryRow,
} from './local-assurance-story-projection.js';
import {
  buildCanonicalStory,
  type CanonicalStory,
} from './canonical-story.js';
import { StoryStore } from './store.js';

export const OBSERVABILITY_SNAPSHOT_SCHEMA_VERSION = 'lattice.observability_snapshot.v1' as const;

export type ObservabilityAuthorityTier = CanonicalStory['authority']['tier'];
export type ObservabilityAuthorityImpact = CanonicalStory['degradations'][number]['authorityImpact'];

export interface ObservabilityLadderBucket {
  count: number;
  storyIds: string[];
}

export interface ObservabilityAuthorityLadder {
  legacyReceipt: ObservabilityLadderBucket;
  legacyRecord: ObservabilityLadderBucket;
  localEvidence: ObservabilityLadderBucket;
  inFlight: ObservabilityLadderBucket;
  localAssuranceGap: number;
}

export interface ObservabilityStoryBoardEntry {
  storyId: string;
  title: string;
  stateSource: LocalAssuranceStoryRow['stateSource'];
  activeCwd: string;
  worktreePath: string | null;
  mirrorPhase: LocalAssuranceStoryRow['mirrorPhase'];
  activePhase: LocalAssuranceStoryRow['activePhase'];
  tier: ObservabilityAuthorityTier;
  canonicalStoryDigest: string | null;
  evidenceCount: number;
  reviewCount: number;
  receiptRefCount: number;
  topAuthorityImpact: ObservabilityAuthorityImpact | null;
  localDone: boolean;
  releaseReady: false;
}

export interface ObservabilityCapabilityRow {
  storyId: string;
  receiptBundleVerificationAvailable: false;
  localAssuranceRequired: true;
  fallback: string;
}

export interface ObservabilityRecoveryEntry {
  storyId: string;
  activeCwd: string;
  recoveryPoints: Array<{ id: string; kind: string; path: string }>;
  resumeCommand: string;
}

export interface ObservabilityParallelEntry {
  storyId: string;
  activePhase: LocalAssuranceStoryRow['activePhase'];
  lane: 'mainline' | 'supporting' | 'exploratory' | null;
  parallelSafe: 'yes' | 'no' | 'plan_only' | null;
  worktreePath: string | null;
  depends: string[];
  blockingFor: string[];
}

export interface ObservabilityAuthorityBoundary {
  admissibilityStatus: 'local-only';
  assuranceLevel: 'local-observation';
  evidenceScope: 'read-only-observability';
  notes: string[];
}

export interface ObservabilitySnapshotSections {
  authorityLadder: ObservabilityAuthorityLadder;
  storyBoard: ObservabilityStoryBoardEntry[];
  capabilityMatrix: ObservabilityCapabilityRow[];
  recovery: ObservabilityRecoveryEntry[];
  parallel: ObservabilityParallelEntry[];
}

export interface LatticeObservabilitySnapshot {
  schemaVersion: typeof OBSERVABILITY_SNAPSHOT_SCHEMA_VERSION;
  readOnly: true;
  generatedAt: string;
  projectionSchemaVersion: typeof LOCAL_ASSURANCE_STORY_PROJECTION_SCHEMA_VERSION;
  projection: LocalAssuranceStoryProjection;
  localAssurance: ObservabilityAuthorityBoundary;
  sections: ObservabilitySnapshotSections;
  warnings: string[];
}

export interface ObservabilitySnapshotOptions {
  storyIds?: string[];
  activeOnly?: boolean;
  now?: string;
  /**
   * Pre-built projection. Tests / dashboards that already hold a local
   * assurance story projection can pass it here to skip a redundant pass.
   */
  projection?: LocalAssuranceStoryProjection;
  /**
   * Override how the adapter opens a `StoryStore` for a row's authoritative
   * cwd. Defaults to `new StoryStore(cwd)`. Tests inject this to avoid
   * spinning up real linked worktrees.
   */
  storeFactory?: (cwd: string) => StoryStore;
}

const NON_ACTIVE_PHASES = new Set(['DONE', 'DISCARDED', 'IDEA', 'META']);

const AUTHORITY_IMPACT_ORDER: ObservabilityAuthorityImpact[] = [
  'blocks-production-done',
  'verification-evidence-limited',
  'evidence-local-only',
  'none',
];

function defaultStoreFactory(cwd: string): StoryStore {
  return new StoryStore(cwd);
}

function emptyLadder(): ObservabilityAuthorityLadder {
  return {
    legacyReceipt: { count: 0, storyIds: [] },
    legacyRecord: { count: 0, storyIds: [] },
    localEvidence: { count: 0, storyIds: [] },
    inFlight: { count: 0, storyIds: [] },
    localAssuranceGap: 0,
  };
}

function pushLadder(
  ladder: ObservabilityAuthorityLadder,
  tier: ObservabilityAuthorityTier,
  storyId: string,
): void {
  if (tier === 'legacy-receipt') {
    ladder.legacyReceipt.count += 1;
    ladder.legacyReceipt.storyIds.push(storyId);
    return;
  }
  if (tier === 'legacy-record') {
    ladder.legacyRecord.count += 1;
    ladder.legacyRecord.storyIds.push(storyId);
    return;
  }
  ladder.localEvidence.count += 1;
  ladder.localEvidence.storyIds.push(storyId);
}

function topAuthorityImpact(story: CanonicalStory): ObservabilityAuthorityImpact | null {
  if (story.degradations.length === 0) return null;
  const present = new Set(story.degradations.map(d => d.authorityImpact));
  for (const impact of AUTHORITY_IMPACT_ORDER) {
    if (present.has(impact)) return impact;
  }
  return null;
}

function safeNumber(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
}

function recoveryPointsFor(story: CanonicalStory): Array<{ id: string; kind: string; path: string }> {
  const raw = (story.lineage as { recoveryPoints?: unknown }).recoveryPoints;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; kind: string; path: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const id = (entry as { id?: unknown }).id;
    const kind = (entry as { kind?: unknown }).kind;
    const path = (entry as { path?: unknown }).path;
    if (typeof id !== 'string' || typeof kind !== 'string' || typeof path !== 'string') continue;
    out.push({ id, kind, path });
  }
  return out;
}

function resumeCommandFor(row: LocalAssuranceStoryRow): string {
  return `cd ${row.activeCwd} && lattice story_export --storyId=${row.storyId} --format=json`;
}

function asLane(value: unknown): ObservabilityParallelEntry['lane'] {
  if (value === 'mainline' || value === 'supporting' || value === 'exploratory') return value;
  return null;
}

function asParallelSafe(value: unknown): ObservabilityParallelEntry['parallelSafe'] {
  if (value === 'yes' || value === 'no' || value === 'plan_only') return value;
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

interface PerRowProjection {
  row: LocalAssuranceStoryRow;
  canonical: CanonicalStory | null;
  storeWarning: string | null;
  storyMeta: {
    lane: ObservabilityParallelEntry['lane'];
    parallelSafe: ObservabilityParallelEntry['parallelSafe'];
    depends: string[];
    blockingFor: string[];
  };
}

function projectRow(
  row: LocalAssuranceStoryRow,
  storeFactory: (cwd: string) => StoryStore,
  warnings: string[],
): PerRowProjection {
  let store: StoryStore;
  try {
    store = storeFactory(row.activeCwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const warning = `unable to open StoryStore for ${row.storyId} at ${row.activeCwd}: ${message}`;
    warnings.push(warning);
    return {
      row,
      canonical: null,
      storeWarning: warning,
      storyMeta: { lane: null, parallelSafe: null, depends: [], blockingFor: [] },
    };
  }

  let canonical: CanonicalStory | null = null;
  try {
    canonical = buildCanonicalStory(store, row.activeCwd, row.storyId).story;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`unable to export canonical story ${row.storyId} from ${row.activeCwd}: ${message}`);
  }

  let storyMeta: PerRowProjection['storyMeta'] = { lane: null, parallelSafe: null, depends: [], blockingFor: [] };
  try {
    const info = store.readStory(row.storyId);
    storyMeta = {
      lane: asLane(info.lane),
      parallelSafe: asParallelSafe(info.parallelSafe),
      depends: asStringArray(info.depends),
      blockingFor: asStringArray(info.blockingFor),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`unable to read story info ${row.storyId} from ${row.activeCwd}: ${message}`);
  }

  return { row, canonical, storeWarning: null, storyMeta };
}

function authorityBoundary(localAssuranceGap: number): ObservabilityAuthorityBoundary {
  return {
    admissibilityStatus: 'local-only',
    assuranceLevel: 'local-observation',
    evidenceScope: 'read-only-observability',
    notes: [
      'Observability snapshot is a host-neutral L0 read-only projection; it never signs gate evidence or widens local assurance.',
      localAssuranceGap > 0
        ? `local assurance gap: ${localAssuranceGap} stories carry local completion evidence that still needs ordinary gate review.`
        : 'No local completion stories detected this snapshot; use proof-admissibility, receipt-bundle, and review quorum evidence for release readiness.',
    ],
  };
}

export function buildObservabilitySnapshot(
  rootStore: StoryStore,
  projectRoot: string,
  options: ObservabilitySnapshotOptions = {},
): LatticeObservabilitySnapshot {
  const warnings: string[] = [];
  const storeFactory = options.storeFactory ?? defaultStoreFactory;
  const localProjection = options.projection ?? resolveLocalAssuranceStories(rootStore, projectRoot, {
    storyIds: options.storyIds,
    activeOnly: options.activeOnly,
    now: options.now,
  });

  const ladder = emptyLadder();
  const storyBoard: ObservabilityStoryBoardEntry[] = [];
  const capabilityMatrix: ObservabilityCapabilityRow[] = [];
  const recovery: ObservabilityRecoveryEntry[] = [];
  const parallel: ObservabilityParallelEntry[] = [];

  for (const row of localProjection.stories) {
    const projection = projectRow(row, storeFactory, warnings);
    const canonical = projection.canonical;
    const tier: ObservabilityAuthorityTier = canonical?.authority.tier ?? 'local-evidence';
    pushLadder(ladder, tier, row.storyId);

    if (!NON_ACTIVE_PHASES.has(row.activePhase)) {
      ladder.inFlight.count += 1;
      ladder.inFlight.storyIds.push(row.storyId);
    }
    if (canonical?.lifecycle.localDone) {
      ladder.localAssuranceGap += 1;
    }

    storyBoard.push({
      storyId: row.storyId,
      title: row.title,
      stateSource: row.stateSource,
      activeCwd: row.activeCwd,
      worktreePath: row.worktreePath,
      mirrorPhase: row.mirrorPhase,
      activePhase: row.activePhase,
      tier,
      canonicalStoryDigest: canonical?.authority.canonicalStoryDigest ?? null,
      evidenceCount: safeNumber(canonical?.evidence),
      reviewCount: safeNumber(canonical?.reviews),
      receiptRefCount: safeNumber(canonical?.authority.receiptRefs),
      topAuthorityImpact: canonical ? topAuthorityImpact(canonical) : null,
      localDone: Boolean(canonical?.lifecycle.localDone),
      releaseReady: false,
    });

    capabilityMatrix.push({
      storyId: row.storyId,
      receiptBundleVerificationAvailable: false,
      localAssuranceRequired: true,
      fallback: 'Use proof-admissibility, receipt-bundle, and local review quorum before treating evidence as release-ready.',
    });

    recovery.push({
      storyId: row.storyId,
      activeCwd: row.activeCwd,
      recoveryPoints: canonical ? recoveryPointsFor(canonical) : [],
      resumeCommand: resumeCommandFor(row),
    });

    parallel.push({
      storyId: row.storyId,
      activePhase: row.activePhase,
      lane: projection.storyMeta.lane,
      parallelSafe: projection.storyMeta.parallelSafe,
      worktreePath: row.worktreePath,
      depends: projection.storyMeta.depends,
      blockingFor: projection.storyMeta.blockingFor,
    });
  }

  ladder.legacyReceipt.storyIds.sort();
  ladder.legacyRecord.storyIds.sort();
  ladder.localEvidence.storyIds.sort();
  ladder.inFlight.storyIds.sort();
  storyBoard.sort((a, b) => a.storyId.localeCompare(b.storyId));
  capabilityMatrix.sort((a, b) => a.storyId.localeCompare(b.storyId));
  recovery.sort((a, b) => a.storyId.localeCompare(b.storyId));
  parallel.sort((a, b) => a.storyId.localeCompare(b.storyId));

  return {
    schemaVersion: OBSERVABILITY_SNAPSHOT_SCHEMA_VERSION,
    readOnly: true,
    generatedAt: options.now ?? new Date().toISOString(),
    projectionSchemaVersion: LOCAL_ASSURANCE_STORY_PROJECTION_SCHEMA_VERSION,
    projection: localProjection,
    localAssurance: authorityBoundary(ladder.localAssuranceGap),
    sections: {
      authorityLadder: ladder,
      storyBoard,
      capabilityMatrix,
      recovery,
      parallel,
    },
    warnings,
  };
}
