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
 *   `story_authority_resolve` CHK-001 contract row-by-row, then opens a fresh
 *   `StoryStore` rooted at each row's `authoritativeCwd` and projects through
 *   `buildCanonicalStory` so worktree-authoritative stories aren't read from a
 *   stale main mirror. All authority fields stay conservative
 *   (`productionDone=false` / `receiptVerified=false` / `authorityChanged=false`):
 *   the snapshot is L0 host-neutral observation, never a production claim.
 * @changes
 *   - [CHK-002] Add validator-required changes metadata for the observability snapshot adapter task header.
 */

import {
  STORY_AUTHORITY_RESOLVE_SCHEMA_VERSION,
  resolveStoryAuthority,
  type StoryAuthorityResolveResult,
  type StoryAuthorityRow,
} from './story-authority-resolver.js';
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
  productionDoneGap: number;
}

export interface ObservabilityStoryBoardEntry {
  storyId: string;
  title: string;
  authority: StoryAuthorityRow['authority'];
  authoritativeCwd: string;
  worktreePath: string | null;
  mirrorPhase: StoryAuthorityRow['mirrorPhase'];
  authoritativePhase: StoryAuthorityRow['authoritativePhase'];
  tier: ObservabilityAuthorityTier;
  canonicalStoryDigest: string | null;
  evidenceCount: number;
  reviewCount: number;
  receiptRefCount: number;
  topAuthorityImpact: ObservabilityAuthorityImpact | null;
  localDone: boolean;
  productionDone: false;
}

export interface ObservabilityCapabilityRow {
  storyId: string;
  receiptVerifyAvailable: false;
  productionDoneBlocked: true;
  fallback: string;
}

export interface ObservabilityRecoveryEntry {
  storyId: string;
  authoritativeCwd: string;
  recoveryPoints: Array<{ id: string; kind: string; path: string }>;
  resumeCommand: string;
}

export interface ObservabilityParallelEntry {
  storyId: string;
  authoritativePhase: StoryAuthorityRow['authoritativePhase'];
  lane: 'mainline' | 'supporting' | 'exploratory' | null;
  parallelSafe: 'yes' | 'no' | 'plan_only' | null;
  worktreePath: string | null;
  depends: string[];
  blockingFor: string[];
}

export interface ObservabilityAuthorityBoundary {
  productionDone: false;
  receiptVerified: false;
  authorityChanged: false;
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
  resolverSchemaVersion: typeof STORY_AUTHORITY_RESOLVE_SCHEMA_VERSION;
  resolver: StoryAuthorityResolveResult;
  authority: ObservabilityAuthorityBoundary;
  sections: ObservabilitySnapshotSections;
  warnings: string[];
}

export interface ObservabilitySnapshotOptions {
  storyIds?: string[];
  activeOnly?: boolean;
  now?: string;
  /**
   * Pre-built resolver result. Tests / dashboards that already hold a
   * `story_authority_resolve` projection can pass it here to skip a redundant
   * resolver pass.
   */
  resolver?: StoryAuthorityResolveResult;
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
    productionDoneGap: 0,
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

function resumeCommandFor(row: StoryAuthorityRow): string {
  return `cd ${row.authoritativeCwd} && lattice story_export --storyId=${row.storyId} --format=json`;
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
  row: StoryAuthorityRow;
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
  row: StoryAuthorityRow,
  storeFactory: (cwd: string) => StoryStore,
  warnings: string[],
): PerRowProjection {
  let store: StoryStore;
  try {
    store = storeFactory(row.authoritativeCwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const warning = `unable to open StoryStore for ${row.storyId} at ${row.authoritativeCwd}: ${message}`;
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
    canonical = buildCanonicalStory(store, row.authoritativeCwd, row.storyId).story;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`unable to export canonical story ${row.storyId} from ${row.authoritativeCwd}: ${message}`);
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
    warnings.push(`unable to read story info ${row.storyId} from ${row.authoritativeCwd}: ${message}`);
  }

  return { row, canonical, storeWarning: null, storyMeta };
}

function authorityBoundary(productionDoneGap: number): ObservabilityAuthorityBoundary {
  return {
    productionDone: false,
    receiptVerified: false,
    authorityChanged: false,
    notes: [
      'Observability snapshot is a host-neutral L0 read-only projection; it never claims production DONE, verifies receipts, or mutates authority state.',
      productionDoneGap > 0
        ? `localDone↔productionDone gap: ${productionDoneGap} stories carry local evidence only; receipt-backed verification is still required.`
        : 'No localDone stories detected this snapshot; receipt-backed verification still required for any future production claim.',
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
  const resolver = options.resolver ?? resolveStoryAuthority(rootStore, projectRoot, {
    storyIds: options.storyIds,
    activeOnly: options.activeOnly,
    now: options.now,
  });

  const ladder = emptyLadder();
  const storyBoard: ObservabilityStoryBoardEntry[] = [];
  const capabilityMatrix: ObservabilityCapabilityRow[] = [];
  const recovery: ObservabilityRecoveryEntry[] = [];
  const parallel: ObservabilityParallelEntry[] = [];

  for (const row of resolver.stories) {
    const projection = projectRow(row, storeFactory, warnings);
    const canonical = projection.canonical;
    const tier: ObservabilityAuthorityTier = canonical?.authority.tier ?? 'local-evidence';
    pushLadder(ladder, tier, row.storyId);

    if (!NON_ACTIVE_PHASES.has(row.authoritativePhase)) {
      ladder.inFlight.count += 1;
      ladder.inFlight.storyIds.push(row.storyId);
    }
    if (canonical?.lifecycle.localDone && !canonical.lifecycle.productionDone) {
      ladder.productionDoneGap += 1;
    }

    storyBoard.push({
      storyId: row.storyId,
      title: row.title,
      authority: row.authority,
      authoritativeCwd: row.authoritativeCwd,
      worktreePath: row.worktreePath,
      mirrorPhase: row.mirrorPhase,
      authoritativePhase: row.authoritativePhase,
      tier,
      canonicalStoryDigest: canonical?.authority.canonicalStoryDigest ?? null,
      evidenceCount: safeNumber(canonical?.evidence),
      reviewCount: safeNumber(canonical?.reviews),
      receiptRefCount: safeNumber(canonical?.authority.receiptRefs),
      topAuthorityImpact: canonical ? topAuthorityImpact(canonical) : null,
      localDone: Boolean(canonical?.lifecycle.localDone),
      productionDone: false,
    });

    capabilityMatrix.push({
      storyId: row.storyId,
      receiptVerifyAvailable: false,
      productionDoneBlocked: true,
      fallback: 'Keep tier at local-evidence until a receipt-backed authority flow lands (B-2522).',
    });

    recovery.push({
      storyId: row.storyId,
      authoritativeCwd: row.authoritativeCwd,
      recoveryPoints: canonical ? recoveryPointsFor(canonical) : [],
      resumeCommand: resumeCommandFor(row),
    });

    parallel.push({
      storyId: row.storyId,
      authoritativePhase: row.authoritativePhase,
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
    resolverSchemaVersion: STORY_AUTHORITY_RESOLVE_SCHEMA_VERSION,
    resolver,
    authority: authorityBoundary(ladder.productionDoneGap),
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
