import { readFileSync } from 'node:fs';
import { buildCapabilityProbe, type CapabilityStatus } from './capabilities.js';
import { buildCanonicalStory, type CanonicalStory } from './canonical-story.js';
import { resolveStoryLane, type StoryLane } from './parallel-policy.js';
import type { StoryStore } from './store.js';
import type { StoryInfo, StoryPhase } from './types.js';

export const PARALLEL_WAVE_SCHEMA_VERSION = 'koala.parallel_wave.v1' as const;
export const PARALLEL_WAVE_INSPECT_SCHEMA_VERSION = 'koala.parallel_wave_inspect.v1' as const;
export const PARALLEL_PLAN_SCHEMA_VERSION = 'koala.parallel_plan.v1' as const;

export type ParallelWaveSafety = 'yes' | 'plan_only' | 'no';
export type ParallelWaveRecommendation = 'parallel_dev' | 'plan_only' | 'blocked';

export interface ParallelWaveDegradation {
  id: string;
  host: string;
  capability: string;
  severity: 'info' | 'warn' | 'block';
  visible: true;
  reason: string;
  fallback: string;
  authorityImpact: 'none' | 'evidence-local-only' | 'verification-evidence-limited' | 'blocks-production-done';
  recovery?: string;
}

export interface ParallelWaveDependencySummary {
  declared: string[];
  active: string[];
  satisfied: string[];
  missing: string[];
  inWave: string[];
  blockingForActive: string[];
}

export interface ParallelWaveHotspotConflict {
  hotspot: string;
  storyIds: string[];
}

export interface ParallelWaveStoryRef {
  storyId: string;
  title: string;
  phase: CanonicalStory['lifecycle']['phase'];
  lane: StoryLane;
  declaredParallelSafe?: StoryInfo['parallelSafe'];
  safety: ParallelWaveSafety;
  recommendation: ParallelWaveRecommendation;
  parallelDevRecommended: boolean;
  recommendedHostIds: string[];
  dependencies: ParallelWaveDependencySummary;
  hotspots: string[];
  sharedHotspots: ParallelWaveHotspotConflict[];
  degradations: ParallelWaveDegradation[];
  evidenceRefs: string[];
  canonicalStoryRef: {
    schemaVersion: CanonicalStory['schemaVersion'];
    storyId: string;
    canonicalStoryDigest?: string;
    gateInputDigest?: string;
  };
  recoveryRefs: string[];
}

export interface ParallelWaveHostCandidate {
  host: string;
  requestedHost: string;
  matchedFallback: boolean;
  capability: {
    available: string[];
    conditional: string[];
    unavailable: string[];
    receiptVerifyStatus: CapabilityStatus;
    productionDoneBlocked: boolean;
  };
  degradationSummary: {
    info: number;
    warn: number;
    block: number;
    blocksProductionDone: number;
  };
  degradations: ParallelWaveDegradation[];
}

export interface ParallelWaveMergeOrderEntry {
  storyId: string;
  after: string[];
  safety: ParallelWaveSafety;
  recommendation: ParallelWaveRecommendation;
  blockers: string[];
}

export interface ParallelWaveAuthorityBoundary {
  productionDone: false;
  authorityChanged: false;
  receiptRefs: [];
  notes: string[];
}

export interface LatticeParallelWave {
  schemaVersion: typeof PARALLEL_WAVE_SCHEMA_VERSION;
  waveId: string;
  generatedAt: string;
  storyRefs: ParallelWaveStoryRef[];
  hostCandidates: ParallelWaveHostCandidate[];
  evidenceRefs: string[];
  mergeOrder: ParallelWaveMergeOrderEntry[];
  authority: ParallelWaveAuthorityBoundary;
}

export interface LatticeParallelWaveInspection extends Omit<LatticeParallelWave, 'schemaVersion' | 'generatedAt'> {
  schemaVersion: typeof PARALLEL_WAVE_INSPECT_SCHEMA_VERSION;
  waveSchemaVersion: typeof PARALLEL_WAVE_SCHEMA_VERSION;
  inspectedAt: string;
  inspection: {
    storyCount: number;
    parallelDevCandidateCount: number;
    planOnlyCount: number;
    blockedCount: number;
    hostCandidateCount: number;
    blockingDegradationCount: number;
  };
}

export interface LatticeParallelPlan extends Omit<LatticeParallelWave, 'schemaVersion' | 'generatedAt'> {
  schemaVersion: typeof PARALLEL_PLAN_SCHEMA_VERSION;
  waveSchemaVersion: typeof PARALLEL_WAVE_SCHEMA_VERSION;
  plannedAt: string;
  parallelDevCandidates: string[];
  planOnlyStories: string[];
  blockedStories: string[];
  recoveryGuidance: string[];
}

const TERMINAL_PHASES = new Set<StoryPhase>(['DONE', 'DISCARDED']);
const NON_ACTIVE_PHASES = new Set<StoryPhase>(['DONE', 'DISCARDED', 'IDEA', 'META']);

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))].sort();
}

function waveIdFor(storyIds: string[], explicit?: string): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  const basis = storyIds.length > 0 ? storyIds.join('+') : 'active';
  return `wave:${basis}`;
}

function isActiveStory(story: StoryInfo): boolean {
  return !NON_ACTIVE_PHASES.has(story.phase);
}

function canonicalPhase(phase: StoryPhase): CanonicalStory['lifecycle']['phase'] {
  if (phase === 'TEST_CASE' || phase === 'TEST_CASE_REVIEW') return 'TEST';
  if (phase === 'META') return 'INIT';
  return phase;
}

function selectStories(store: StoryStore, storyIds?: string[]): StoryInfo[] {
  const ids = storyIds && storyIds.length > 0
    ? uniqueStrings(storyIds)
    : store.listStoryIds().filter(id => isActiveStory(store.readStory(id)));
  return ids.map(id => store.readStory(id));
}

function allKnownStories(store: StoryStore): StoryInfo[] {
  return store.listStoryIds().map(id => store.readStory(id));
}

function evidenceRefs(canonicalStory: CanonicalStory): string[] {
  const refs = new Set<string>();
  for (const evidence of canonicalStory.evidence) {
    const id = evidence.id;
    if (typeof id === 'string' && id.trim()) refs.add(id);
    const intentRef = evidence.intentRef;
    if (typeof intentRef === 'string' && intentRef.trim()) refs.add(intentRef);
  }
  return [...refs].sort();
}

function recoveryRefs(canonicalStory: CanonicalStory): string[] {
  const points = (canonicalStory.lineage as { recoveryPoints?: unknown }).recoveryPoints;
  if (!Array.isArray(points)) return [];
  return uniqueStrings(points.map(point => {
    if (!point || typeof point !== 'object') return undefined;
    const id = (point as { id?: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  }));
}

function degradationId(storyId: string, kind: string, value: string): string {
  return `${storyId}-${kind}-${value}`
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function schedulingDegradation(
  storyId: string,
  kind: string,
  value: string,
  severity: ParallelWaveDegradation['severity'],
  reason: string,
  fallback: string,
): ParallelWaveDegradation {
  return {
    id: degradationId(storyId, kind, value),
    host: 'parallel-wave',
    capability: 'parallel-scheduling',
    severity,
    visible: true,
    reason,
    fallback,
    authorityImpact: 'none',
  };
}

function dependencySummary(
  story: StoryInfo,
  allStories: StoryInfo[],
  waveIds: Set<string>,
): ParallelWaveDependencySummary {
  const byId = new Map(allStories.map(candidate => [candidate.storyId, candidate]));
  const activeIds = new Set(allStories.filter(isActiveStory).map(candidate => candidate.storyId));
  const declared = uniqueStrings(story.depends ?? []);
  const blockingFor = uniqueStrings(story.blockingFor ?? []);
  return {
    declared,
    active: declared.filter(id => activeIds.has(id)),
    satisfied: declared.filter(id => {
      const dependency = byId.get(id);
      return Boolean(dependency && TERMINAL_PHASES.has(dependency.phase));
    }),
    missing: declared.filter(id => !byId.has(id)),
    inWave: declared.filter(id => waveIds.has(id)),
    blockingForActive: blockingFor.filter(id => activeIds.has(id)),
  };
}

function hotspotConflicts(story: StoryInfo, allStories: StoryInfo[]): ParallelWaveHotspotConflict[] {
  const hotspots = uniqueStrings(story.sharedHotspots ?? []);
  if (hotspots.length === 0) return [];
  const activeOthers = allStories.filter(candidate => candidate.storyId !== story.storyId && isActiveStory(candidate));
  return hotspots.flatMap(hotspot => {
    const storyIds = activeOthers
      .filter(candidate => (candidate.sharedHotspots ?? []).includes(hotspot))
      .map(candidate => candidate.storyId)
      .sort();
    return storyIds.length > 0 ? [{ hotspot, storyIds }] : [];
  });
}

function resolveWaveSafety(
  story: StoryInfo,
  dependencies: ParallelWaveDependencySummary,
  sharedHotspots: ParallelWaveHotspotConflict[],
): { safety: ParallelWaveSafety; degradations: ParallelWaveDegradation[] } {
  const degradations: ParallelWaveDegradation[] = [];
  const explicit = story.parallelSafe;
  const explicitOverrideNote = explicit === 'yes'
    ? ' Explicit parallelSafe=yes is overridden by collection-level safety.'
    : '';

  for (const dependencyId of dependencies.active) {
    degradations.push(schedulingDegradation(
      story.storyId,
      'active-dependency',
      dependencyId,
      'block',
      `Dependency ${dependencyId} is still active.${explicitOverrideNote}`,
      'Do not recommend parallel DEV until the dependency is DONE/DISCARDED or the dependency edge is removed.',
    ));
  }
  for (const blockedId of dependencies.blockingForActive) {
    degradations.push(schedulingDegradation(
      story.storyId,
      'blocking-for-active',
      blockedId,
      'block',
      `Story blocks active story ${blockedId}.${explicitOverrideNote}`,
      'Sequence the blocking story before recommending simultaneous DEV.',
    ));
  }
  if (explicit === 'no') {
    degradations.push(schedulingDegradation(
      story.storyId,
      'declared-parallel-safe',
      'no',
      'block',
      'Story declares parallelSafe=no.',
      'Keep the story out of parallel DEV until metadata changes.',
    ));
  }
  for (const conflict of sharedHotspots) {
    degradations.push(schedulingDegradation(
      story.storyId,
      'shared-hotspot',
      conflict.hotspot,
      'warn',
      `Shared hotspot ${conflict.hotspot} overlaps active stories ${conflict.storyIds.join(', ')}.${explicitOverrideNote}`,
      'Allow planning and handoff only; avoid simultaneous DEV on the overlapping hotspot.',
    ));
  }

  if (dependencies.active.length > 0 || dependencies.blockingForActive.length > 0 || explicit === 'no') {
    return { safety: 'no', degradations };
  }
  if (sharedHotspots.length > 0 || explicit === 'plan_only') {
    return { safety: 'plan_only', degradations };
  }
  return { safety: 'yes', degradations };
}

function hostCandidate(host: string): ParallelWaveHostCandidate {
  const probe = buildCapabilityProbe(host);
  const capabilities = probe.profile.capabilities;
  const available = capabilities.filter(c => c.status === 'available').map(c => c.category);
  const conditional = capabilities.filter(c => c.status === 'conditional').map(c => c.category);
  const unavailable = capabilities.filter(c => c.status === 'unavailable').map(c => c.category);
  const receiptVerifyStatus = capabilities.find(c => c.category === 'receipt-verify')?.status ?? 'unavailable';
  const degradations = probe.degradations.map(degradation => ({ ...degradation, capability: degradation.capability }));
  return {
    host: probe.host,
    requestedHost: probe.requestedHost,
    matchedFallback: probe.matchedFallback,
    capability: {
      available,
      conditional,
      unavailable,
      receiptVerifyStatus,
      productionDoneBlocked: receiptVerifyStatus !== 'available',
    },
    degradationSummary: {
      info: degradations.filter(d => d.severity === 'info').length,
      warn: degradations.filter(d => d.severity === 'warn').length,
      block: degradations.filter(d => d.severity === 'block').length,
      blocksProductionDone: degradations.filter(d => d.authorityImpact === 'blocks-production-done').length,
    },
    degradations,
  };
}

function implementationHostIds(hosts: ParallelWaveHostCandidate[]): string[] {
  return hosts
    .filter(host =>
      host.capability.available.includes('file-edit') &&
      host.capability.available.includes('test-execution')
    )
    .map(host => host.host)
    .sort();
}

function recommendationFor(safety: ParallelWaveSafety, recommendedHostIds: string[]): ParallelWaveRecommendation {
  if (safety === 'no') return 'blocked';
  if (safety === 'plan_only') return 'plan_only';
  return recommendedHostIds.length > 0 ? 'parallel_dev' : 'plan_only';
}

function storyRef(
  store: StoryStore,
  root: string,
  story: StoryInfo,
  allStories: StoryInfo[],
  waveIds: Set<string>,
  hostIds: string[],
): ParallelWaveStoryRef {
  const canonical = buildCanonicalStory(store, root, story.storyId).story;
  const dependencies = dependencySummary(story, allStories, waveIds);
  const sharedHotspots = hotspotConflicts(story, allStories);
  const resolved = resolveWaveSafety(story, dependencies, sharedHotspots);
  const recommendation = recommendationFor(resolved.safety, hostIds);
  return {
    storyId: story.storyId,
    title: story.title,
    phase: canonical.lifecycle.phase ?? canonicalPhase(story.phase),
    lane: resolveStoryLane(story),
    ...(story.parallelSafe ? { declaredParallelSafe: story.parallelSafe } : {}),
    safety: resolved.safety,
    recommendation,
    parallelDevRecommended: recommendation === 'parallel_dev',
    recommendedHostIds: recommendation === 'parallel_dev' ? hostIds : [],
    dependencies,
    hotspots: uniqueStrings(story.sharedHotspots ?? []),
    sharedHotspots,
    degradations: resolved.degradations,
    evidenceRefs: evidenceRefs(canonical),
    canonicalStoryRef: {
      schemaVersion: canonical.schemaVersion,
      storyId: canonical.storyId,
      ...(canonical.authority.canonicalStoryDigest ? { canonicalStoryDigest: canonical.authority.canonicalStoryDigest } : {}),
      ...(canonical.authority.gateInputDigest ? { gateInputDigest: canonical.authority.gateInputDigest } : {}),
    },
    recoveryRefs: recoveryRefs(canonical),
  };
}

function laneRank(lane: StoryLane): number {
  if (lane === 'mainline') return 0;
  if (lane === 'supporting') return 1;
  return 2;
}

function mergeOrder(storyRefs: ParallelWaveStoryRef[]): ParallelWaveMergeOrderEntry[] {
  const refsById = new Map(storyRefs.map(ref => [ref.storyId, ref]));
  const order: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const sortedIds = storyRefs
    .map(ref => ref.storyId)
    .sort((a, b) => {
      const left = refsById.get(a)!;
      const right = refsById.get(b)!;
      const laneDelta = laneRank(left.lane) - laneRank(right.lane);
      return laneDelta || a.localeCompare(b);
    });

  const visit = (storyId: string): void => {
    if (visited.has(storyId) || visiting.has(storyId)) return;
    visiting.add(storyId);
    const ref = refsById.get(storyId);
    for (const dependencyId of ref?.dependencies.inWave ?? []) visit(dependencyId);
    visiting.delete(storyId);
    visited.add(storyId);
    order.push(storyId);
  };

  for (const storyId of sortedIds) visit(storyId);

  return order.map(storyId => {
    const ref = refsById.get(storyId)!;
    return {
      storyId,
      after: ref.dependencies.inWave,
      safety: ref.safety,
      recommendation: ref.recommendation,
      blockers: uniqueStrings([
        ...ref.dependencies.active,
        ...ref.dependencies.blockingForActive,
      ]),
    };
  });
}

function authorityBoundary(hosts: ParallelWaveHostCandidate[]): ParallelWaveAuthorityBoundary {
  const blockedHosts = hosts
    .filter(host => host.capability.productionDoneBlocked)
    .map(host => `${host.host}:receipt-verify=${host.capability.receiptVerifyStatus}`);
  return {
    productionDone: false,
    authorityChanged: false,
    receiptRefs: [],
    notes: [
      'Parallel Wave is collection-level scheduling and recovery guidance only; it does not mutate story authority, verify receipts, or satisfy DONE.',
      blockedHosts.length > 0
        ? `Production authority remains blocked for hosts without available receipt verification (${blockedHosts.join(', ')}).`
        : 'Receipt-capable hosts still need a separate verified authority receipt before any productionDone claim.',
    ],
  };
}

export function createParallelWave(
  store: StoryStore,
  root: string,
  args: { storyIds?: string[]; hosts?: string[]; waveId?: string } = {},
): LatticeParallelWave {
  const selectedStories = selectStories(store, args.storyIds);
  const allStories = allKnownStories(store);
  const waveIds = new Set(selectedStories.map(story => story.storyId));
  const hosts = uniqueStrings(args.hosts && args.hosts.length > 0 ? args.hosts : ['codex'])
    .map(hostCandidate);
  const recommendedHostIds = implementationHostIds(hosts);
  const storyRefs = selectedStories.map(story =>
    storyRef(store, root, story, allStories, waveIds, recommendedHostIds)
  );
  const evidence = uniqueStrings(storyRefs.flatMap(ref => ref.evidenceRefs));
  return {
    schemaVersion: PARALLEL_WAVE_SCHEMA_VERSION,
    waveId: waveIdFor(selectedStories.map(story => story.storyId).sort(), args.waveId),
    generatedAt: new Date().toISOString(),
    storyRefs,
    hostCandidates: hosts,
    evidenceRefs: evidence,
    mergeOrder: mergeOrder(storyRefs),
    authority: authorityBoundary(hosts),
  };
}

function nonAuthorityBoundary(authority?: Partial<ParallelWaveAuthorityBoundary>): ParallelWaveAuthorityBoundary {
  return {
    productionDone: false,
    authorityChanged: false,
    receiptRefs: [],
    notes: authority?.notes && Array.isArray(authority.notes)
      ? authority.notes
      : ['Parallel Wave inspection preserves scheduling guidance only and does not change authority.'],
  };
}

export function readParallelWave(file: string): LatticeParallelWave {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as LatticeParallelWave;
  if (parsed.schemaVersion !== PARALLEL_WAVE_SCHEMA_VERSION) {
    throw new Error(`parallel_wave_inspect expected schemaVersion ${PARALLEL_WAVE_SCHEMA_VERSION}, got ${String((parsed as { schemaVersion?: unknown }).schemaVersion)}`);
  }
  return {
    ...parsed,
    storyRefs: parsed.storyRefs ?? [],
    hostCandidates: parsed.hostCandidates ?? [],
    evidenceRefs: uniqueStrings(parsed.evidenceRefs ?? []),
    mergeOrder: parsed.mergeOrder ?? [],
    authority: nonAuthorityBoundary(parsed.authority),
  };
}

export function inspectParallelWave(wave: LatticeParallelWave): LatticeParallelWaveInspection {
  const blockedCount = wave.storyRefs.filter(ref => ref.safety === 'no').length;
  const planOnlyCount = wave.storyRefs.filter(ref => ref.safety === 'plan_only' || ref.recommendation === 'plan_only').length;
  return {
    schemaVersion: PARALLEL_WAVE_INSPECT_SCHEMA_VERSION,
    waveSchemaVersion: PARALLEL_WAVE_SCHEMA_VERSION,
    waveId: wave.waveId,
    inspectedAt: new Date().toISOString(),
    storyRefs: wave.storyRefs,
    hostCandidates: wave.hostCandidates,
    evidenceRefs: wave.evidenceRefs,
    mergeOrder: wave.mergeOrder,
    authority: nonAuthorityBoundary(wave.authority),
    inspection: {
      storyCount: wave.storyRefs.length,
      parallelDevCandidateCount: wave.storyRefs.filter(ref => ref.parallelDevRecommended).length,
      planOnlyCount,
      blockedCount,
      hostCandidateCount: wave.hostCandidates.length,
      blockingDegradationCount: [
        ...wave.storyRefs.flatMap(ref => ref.degradations),
        ...wave.hostCandidates.flatMap(host => host.degradations),
      ].filter(degradation => degradation.severity === 'block').length,
    },
  };
}

export function buildParallelPlan(wave: LatticeParallelWave): LatticeParallelPlan {
  const parallelDevCandidates = wave.storyRefs
    .filter(ref => ref.parallelDevRecommended)
    .map(ref => ref.storyId)
    .sort();
  const planOnlyStories = wave.storyRefs
    .filter(ref => ref.recommendation === 'plan_only')
    .map(ref => ref.storyId)
    .sort();
  const blockedStories = wave.storyRefs
    .filter(ref => ref.recommendation === 'blocked')
    .map(ref => ref.storyId)
    .sort();

  return {
    schemaVersion: PARALLEL_PLAN_SCHEMA_VERSION,
    waveSchemaVersion: PARALLEL_WAVE_SCHEMA_VERSION,
    waveId: wave.waveId,
    plannedAt: new Date().toISOString(),
    storyRefs: wave.storyRefs,
    hostCandidates: wave.hostCandidates,
    evidenceRefs: wave.evidenceRefs,
    mergeOrder: wave.mergeOrder,
    authority: nonAuthorityBoundary(wave.authority),
    parallelDevCandidates,
    planOnlyStories,
    blockedStories,
    recoveryGuidance: [
      parallelDevCandidates.length > 0
        ? `Start parallel DEV only for candidate stories: ${parallelDevCandidates.join(', ')}.`
        : 'No story is currently safe for parallel DEV.',
      planOnlyStories.length > 0
        ? `Keep plan-only stories out of simultaneous DEV until hotspot or capability degradations clear: ${planOnlyStories.join(', ')}.`
        : 'No plan-only stories in this wave.',
      blockedStories.length > 0
        ? `Resolve active dependencies or explicit blockers before DEV: ${blockedStories.join(', ')}.`
        : 'No dependency-blocked stories in this wave.',
      'Rerun normal Koala validation and require verified receipts before claiming productionDone.',
    ],
  };
}
