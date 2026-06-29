import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { resolveAuditConfig } from './audit-config.js';
import { buildCapabilityProbe, type CapabilityStatus } from './capabilities.js';
import { buildCanonicalStory, type CanonicalStory } from './canonical-story.js';
import { loadConfig } from './config.js';
import {
  readGlobalMemoryEntries,
  readProjectMemoryEntries,
  searchEntries,
  type DevMemoryEntry,
} from './dev-memory.js';
import { isMaterialExcludedPath } from './evidence-freshness.js';
import { computeWriteSet, globsOverlap } from './parallel-decomposition-overlap.js';
import { resolveStoryLane, type StoryLane } from './parallel-policy.js';
import type { StoryStore } from './store.js';
import type { ScopeContractData, StoryInfo, StoryPhase } from './types.js';

export const PARALLEL_WAVE_SCHEMA_VERSION = 'lattice.parallel_wave.v1' as const;
export const PARALLEL_WAVE_INSPECT_SCHEMA_VERSION = 'lattice.parallel_wave_inspect.v1' as const;
export const PARALLEL_PLAN_SCHEMA_VERSION = 'lattice.parallel_plan.v1' as const;
export const PARALLEL_DISPATCH_SCHEMA_VERSION = 'lattice.parallel_dispatch.v1' as const;
export const PARALLEL_STATUS_SCHEMA_VERSION = 'lattice.parallel_status.v1' as const;
export const PARALLEL_MERGE_QUEUE_SCHEMA_VERSION = 'lattice.parallel_merge_queue.v1' as const;
export const PARALLEL_REPORT_SCHEMA_VERSION = 'lattice.parallel_report.v1' as const;

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
  authorityImpact: 'none' | 'evidence-local-only' | 'verification-evidence-limited' | 'local-assurance-required' | 'blocks-production-done';
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

export interface ParallelWaveChangedFiles {
  source: 'git';
  status: 'ok' | 'not_configured' | 'failed';
  materialChangedFiles: string[];
  ignoredChangedFiles: string[];
  reason?: string;
}

interface ParallelWaveChangedFileProbeFailure {
  storyId: string;
  reason: string;
}

export interface ParallelWaveActualFileOverlap {
  path: string;
  peerStoryId: string;
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
  changedFiles?: ParallelWaveChangedFiles;
  actualFileOverlaps?: ParallelWaveActualFileOverlap[];
  degradations: ParallelWaveDegradation[];
  evidenceRefs: string[];
  canonicalStoryRef: {
    schemaVersion: CanonicalStory['schemaVersion'];
    storyId: string;
    canonicalStoryDigest?: string;
    gateInputDigest?: string;
  };
  recoveryRefs: string[];
  worktreePath?: string;
  branch?: string;
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

export interface ParallelWaveExperienceRef {
  id: string;
  category: DevMemoryEntry['category'];
  summary: string;
  source: string;
  scope: DevMemoryEntry['scope'];
  gateEvidence: false;
  authority: 'non_authoritative';
}

export interface ParallelWaveProjectionOptions {
  projectRoot?: string;
  includeExperience?: boolean;
  experienceQuery?: string;
  maxExperienceRefs?: number;
}

export interface ParallelWaveCounts {
  storyCount: number;
  candidateCount: number;
  planOnlyCount: number;
  blockedCount: number;
}

export interface ParallelDispatchEntry {
  storyId: string;
  title: string;
  recommendation: ParallelWaveRecommendation;
  dispatchable: boolean;
  agentRole: 'implementer' | 'planner' | 'blocked';
  spawned: false;
  requiresRunnerConfirmation: true;
  recommendedHostIds: string[];
  worktreePath?: string;
  branch?: string;
  nextCommand: string;
  blockers: string[];
  degradations: ParallelWaveDegradation[];
  evidenceRefs: string[];
  experienceRefs: ParallelWaveExperienceRef[];
}

export interface LatticeParallelDispatch {
  schemaVersion: typeof PARALLEL_DISPATCH_SCHEMA_VERSION;
  waveSchemaVersion: typeof PARALLEL_WAVE_SCHEMA_VERSION;
  waveId: string;
  dispatchedAt: string;
  summary: ParallelWaveCounts;
  dispatchEntries: ParallelDispatchEntry[];
  hostCandidates: ParallelWaveHostCandidate[];
  evidenceRefs: string[];
  mergeOrder: ParallelWaveMergeOrderEntry[];
  authority: ParallelWaveAuthorityBoundary;
}

export interface ParallelMergeGuidanceReady {
  storyId: string;
  title: string;
  guidance: string;
}

export interface ParallelMergeGuidanceBlocked {
  storyId: string;
  title: string;
  blockers: string[];
  guidance: string;
}

export interface ParallelWaveMergeGuidance {
  ready: ParallelMergeGuidanceReady[];
  blocked: ParallelMergeGuidanceBlocked[];
}

export interface LatticeParallelStatus {
  schemaVersion: typeof PARALLEL_STATUS_SCHEMA_VERSION;
  waveSchemaVersion: typeof PARALLEL_WAVE_SCHEMA_VERSION;
  waveId: string;
  statusAt: string;
  summary: ParallelWaveCounts;
  candidates: string[];
  planOnly: string[];
  blocked: Array<{ storyId: string; title: string; blockers: string[] }>;
  mergeGuidance: ParallelWaveMergeGuidance;
  authority: ParallelWaveAuthorityBoundary;
}

export interface ParallelMergeQueueEntry {
  storyId: string;
  title: string;
  after: string[];
  safety: ParallelWaveSafety;
  recommendation: ParallelWaveRecommendation;
  ready: boolean;
  blockers: string[];
  guidance: string;
  evidenceRefs: string[];
}

export interface LatticeParallelMergeQueue {
  schemaVersion: typeof PARALLEL_MERGE_QUEUE_SCHEMA_VERSION;
  waveSchemaVersion: typeof PARALLEL_WAVE_SCHEMA_VERSION;
  waveId: string;
  queuedAt: string;
  summary: ParallelWaveCounts;
  ready: ParallelMergeQueueEntry[];
  blocked: ParallelMergeQueueEntry[];
  mergeGuidance: ParallelWaveMergeGuidance;
  authority: ParallelWaveAuthorityBoundary;
}

export interface ParallelReportEvidenceEntry {
  storyId: string;
  title: string;
  evidenceRefs: string[];
  canonicalStoryRef: ParallelWaveStoryRef['canonicalStoryRef'];
  recoveryRefs: string[];
}

export interface LatticeParallelReport {
  schemaVersion: typeof PARALLEL_REPORT_SCHEMA_VERSION;
  waveSchemaVersion: typeof PARALLEL_WAVE_SCHEMA_VERSION;
  waveId: string;
  reportedAt: string;
  summary: ParallelWaveCounts;
  candidates: string[];
  planOnly: string[];
  blocked: string[];
  dispatchEntries: ParallelDispatchEntry[];
  mergeGuidance: ParallelWaveMergeGuidance;
  evidenceSummary: {
    topLevelRefs: string[];
    byStory: ParallelReportEvidenceEntry[];
  };
  experienceRefs: ParallelWaveExperienceRef[];
  authority: ParallelWaveAuthorityBoundary;
}

const DEFAULT_MAX_EXPERIENCE_REFS = 3;
const MAX_EXPERIENCE_REFS = 20;

const TERMINAL_PHASES = new Set<StoryPhase>(['DONE', 'DISCARDED']);
const NON_ACTIVE_PHASES = new Set<StoryPhase>(['DONE', 'DISCARDED', 'IDEA', 'META']);
const ACTIVE_STORY_CHANGED_FILE_PROBE_FAILED_KIND = 'active-story-changed-file-probe-failed';

export interface ScopeGlobOverlap { peerStoryId: string; pairExample: string; }
/** Pure: which ACTIVE parallel peers' write-sets statically overlap this story's, for the
 *  advisory scope_glob_overlap wave degradation. Returns [] unless self is ACTIVE (non-terminal)
 *  AND asserts parallelSafe==='yes'. Mirrors evaluateDecompositionGate's active-peer semantics
 *  (non-terminal + parallelSafe==='yes') symmetrically on BOTH self and each peer — a terminal
 *  (DONE/DISCARDED) story must not emit live overlap advisories. */
export function computeScopeGlobOverlaps(
  self: { storyId: string; phase: StoryPhase; parallelSafe?: StoryInfo['parallelSafe']; writeSet: string[] },
  peers: Array<{ storyId: string; phase: StoryPhase; parallelSafe?: StoryInfo['parallelSafe']; writeSet: string[] }>,
): ScopeGlobOverlap[] {
  if (self.parallelSafe !== 'yes') return [];
  if (TERMINAL_PHASES.has(self.phase)) return [];
  const out: ScopeGlobOverlap[] = [];
  for (const peer of peers) {
    if (peer.storyId === self.storyId) continue;
    if (TERMINAL_PHASES.has(peer.phase)) continue;
    if (peer.parallelSafe !== 'yes') continue;
    const res = globsOverlap(self.writeSet, peer.writeSet);
    if (res.overlap && res.pairs.length > 0) {
      const [a, b] = res.pairs[0];
      out.push({ peerStoryId: peer.storyId, pairExample: `${a} ↔ ${b}` });
    }
  }
  return out;
}

/** Pure: build the advisory-only scope_glob_overlap wave degradations from precomputed
 *  ScopeGlobOverlaps. Exported so resolveWaveSafety's emitted degradation shape is
 *  runtime-testable (resolveWaveSafety itself is private). NOTE: `capability` is
 *  'scope_glob_overlap' (NOT the sibling 'parallel-scheduling' label the schedulingDegradation
 *  factory hardcodes) on purpose — it makes this advisory distinguishable in the degradation
 *  stream and matches the frozen verificationIntent. It is not consumed by any capability
 *  filter, so the divergent label is safe. Advisory-only: severity 'warn', authorityImpact 'none'. */
export function scopeGlobOverlapDegradations(
  storyId: string,
  overlaps: ScopeGlobOverlap[],
  explicitOverrideNote = '',
): ParallelWaveDegradation[] {
  return overlaps.map((o) => ({
    id: degradationId(storyId, 'scope-glob-overlap', o.peerStoryId),
    host: 'parallel-wave',
    capability: 'scope_glob_overlap',
    severity: 'warn',
    visible: true,
    reason: `Write-set overlaps active parallel peer ${o.peerStoryId} (e.g. ${o.pairExample}); independence is not statically provable.${explicitOverrideNote}`,
    fallback: 'Coordinate the two scope contracts (disjoint allowedModify/allowedCreate) or sequence the stories so they do not DEV simultaneously.',
    authorityImpact: 'none',
  }));
}

/** Read a story's scope contract without ever throwing. store.readScopeContract RE-THROWS
 *  (e.g. SyntaxError) on a CORRUPT scope-contract.json (vs returning null for a MISSING one);
 *  in this advisory/reporting path a corrupt contract is treated the same as a missing one, so
 *  one bad file cannot crash the whole parallel_wave_create command. */
export function safeReadScopeContract(
  store: Pick<StoryStore, 'readScopeContract'>,
  storyId: string,
): ScopeContractData | null {
  try {
    return store.readScopeContract(storyId);
  } catch {
    return null;
  }
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))].sort();
}

function normalizeChangedPath(rawPath: string): string | undefined {
  let normalized = rawPath.trim().replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  normalized = normalized.replace(/^\/+/, '');
  normalized = normalized.replace(/\/+/g, '/');
  return normalized ? normalized : undefined;
}

function errorText(error: unknown): string {
  const candidate = error as { stderr?: Buffer | string; message?: string };
  const stderr = candidate.stderr ? String(candidate.stderr).trim() : '';
  const message = candidate.message ? String(candidate.message).trim() : '';
  return stderr || message || String(error);
}

function gitOutputLines(cwd: string, args: string[]): string[] {
  const output = execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output.split(/\r?\n/).map(normalizeChangedPath).filter((line): line is string => Boolean(line));
}

function resolveGitCommonWorktreeRoot(root: string): string | undefined {
  try {
    const gitCommonDir = execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const absoluteGitCommonDir = isAbsolute(gitCommonDir) ? gitCommonDir : resolvePath(root, gitCommonDir);
    return basename(absoluteGitCommonDir) === '.git' ? dirname(absoluteGitCommonDir) : undefined;
  } catch {
    return undefined;
  }
}

function resolveWorktreePath(root: string, worktreePath: string): string {
  if (isAbsolute(worktreePath)) return worktreePath;

  const rootCandidate = resolvePath(root, worktreePath);
  const commonRoot = resolveGitCommonWorktreeRoot(root);
  const commonRootCandidate = commonRoot ? resolvePath(commonRoot, worktreePath) : undefined;
  const candidates = uniqueStrings([rootCandidate, commonRootCandidate]);
  const existingCandidate = candidates.find(candidate => existsSync(candidate));
  return existingCandidate ?? candidates[candidates.length - 1] ?? rootCandidate;
}

function collectStoryChangedFiles(root: string, story: StoryInfo): ParallelWaveChangedFiles {
  const configuredPath = story.worktree?.path;
  if (!configuredPath) {
    return {
      source: 'git',
      status: 'not_configured',
      materialChangedFiles: [],
      ignoredChangedFiles: [],
      reason: 'Story has no registered worktree path; git changed-file projection was not collected.',
    };
  }

  const worktreePath = resolveWorktreePath(root, configuredPath);
  if (!existsSync(worktreePath)) {
    return {
      source: 'git',
      status: 'failed',
      materialChangedFiles: [],
      ignoredChangedFiles: [],
      reason: `Registered worktree path does not exist: ${worktreePath}`,
    };
  }

  try {
    const paths = uniqueStrings([
      ...gitOutputLines(worktreePath, ['diff', '--name-only', 'main...HEAD', '--']),
      ...gitOutputLines(worktreePath, ['diff', '--name-only', '--cached', '--']),
      ...gitOutputLines(worktreePath, ['diff', '--name-only', '--']),
      ...gitOutputLines(worktreePath, ['ls-files', '--others', '--exclude-standard']),
    ]);
    const ignoredChangedFiles = paths.filter(path => isMaterialExcludedPath(path, worktreePath));
    const ignored = new Set(ignoredChangedFiles);
    return {
      source: 'git',
      status: 'ok',
      materialChangedFiles: paths.filter(path => !ignored.has(path)),
      ignoredChangedFiles,
    };
  } catch (error) {
    return {
      source: 'git',
      status: 'failed',
      materialChangedFiles: [],
      ignoredChangedFiles: [],
      reason: `git changed-file probe failed for ${worktreePath}: ${errorText(error)}`,
    };
  }
}

function collectActiveStoryChangedFiles(root: string, allStories: StoryInfo[]): Map<string, ParallelWaveChangedFiles> {
  return new Map(
    allStories
      .filter(isActiveStory)
      .map(story => [story.storyId, collectStoryChangedFiles(root, story)]),
  );
}

function activeStoryChangedFileProbeFailures(
  changesByStory: Map<string, ParallelWaveChangedFiles>,
  storyId: string,
): ParallelWaveChangedFileProbeFailure[] {
  return [...changesByStory.entries()]
    .filter(([peerStoryId, changedFiles]) => peerStoryId !== storyId && changedFiles.status === 'failed')
    .map(([peerStoryId, changedFiles]) => ({
      storyId: peerStoryId,
      reason: changedFiles.reason ?? 'git changed-file projection failed',
    }))
    .sort((a, b) => a.storyId.localeCompare(b.storyId));
}

function actualFileOverlapsByStory(
  changesByStory: Map<string, ParallelWaveChangedFiles>,
): Map<string, ParallelWaveActualFileOverlap[]> {
  const storyIdsByFile = new Map<string, Set<string>>();
  for (const [storyId, changedFiles] of changesByStory) {
    for (const file of changedFiles.materialChangedFiles) {
      const storyIds = storyIdsByFile.get(file) ?? new Set<string>();
      storyIds.add(storyId);
      storyIdsByFile.set(file, storyIds);
    }
  }

  const overlaps = new Map<string, ParallelWaveActualFileOverlap[]>();
  for (const [file, storyIds] of storyIdsByFile) {
    if (storyIds.size < 2) continue;
    const sortedStoryIds = [...storyIds].sort();
    for (const storyId of sortedStoryIds) {
      const existing = overlaps.get(storyId) ?? [];
      overlaps.set(storyId, [
        ...existing,
        ...sortedStoryIds
          .filter(peerStoryId => peerStoryId !== storyId)
          .map(peerStoryId => ({ path: file, peerStoryId })),
      ]);
    }
  }

  return new Map([...overlaps].map(([storyId, fileOverlaps]) => [
    storyId,
    fileOverlaps.sort((a, b) => a.path.localeCompare(b.path) || a.peerStoryId.localeCompare(b.peerStoryId)),
  ]));
}

function boundedExperienceLimit(maxExperienceRefs?: number): number {
  if (typeof maxExperienceRefs !== 'number' || !Number.isFinite(maxExperienceRefs)) {
    return DEFAULT_MAX_EXPERIENCE_REFS;
  }
  return Math.max(0, Math.min(MAX_EXPERIENCE_REFS, Math.floor(maxExperienceRefs)));
}

function experienceRef(entry: DevMemoryEntry): ParallelWaveExperienceRef {
  return {
    id: entry.id,
    category: entry.category,
    summary: entry.summary,
    source: entry.sourceAgent,
    scope: entry.scope,
    gateEvidence: false,
    authority: 'non_authoritative',
  };
}

function experienceRefs(options: ParallelWaveProjectionOptions = {}): ParallelWaveExperienceRef[] {
  if (!options.includeExperience) return [];
  const limit = boundedExperienceLimit(options.maxExperienceRefs);
  if (limit <= 0) return [];
  const seen = new Set<string>();
  const entries: DevMemoryEntry[] = [];
  for (const entry of [
    ...readProjectMemoryEntries(options.projectRoot),
    ...readGlobalMemoryEntries(),
  ]) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return searchEntries(entries, {
    query: options.experienceQuery,
    limit,
  }).map(experienceRef);
}

function waveCounts(wave: Pick<LatticeParallelWave, 'storyRefs'>): ParallelWaveCounts {
  return {
    storyCount: wave.storyRefs.length,
    candidateCount: wave.storyRefs.filter(ref => ref.recommendation === 'parallel_dev').length,
    planOnlyCount: wave.storyRefs.filter(ref => ref.recommendation === 'plan_only').length,
    blockedCount: wave.storyRefs.filter(ref => ref.recommendation === 'blocked').length,
  };
}

function actualFileOverlapReasons(ref: ParallelWaveStoryRef): string[] {
  return (ref.actualFileOverlaps ?? []).map(overlap =>
    `Material file ${overlap.path} overlaps active story ${overlap.peerStoryId}`
  );
}

function changedFileProbeRiskReasons(ref: ParallelWaveStoryRef): string[] {
  return ref.changedFiles?.status === 'failed'
    ? [ref.changedFiles.reason ?? 'git changed-file projection failed']
    : [];
}

function activeStoryChangedFileProbeRiskReasons(ref: ParallelWaveStoryRef): string[] {
  const prefix = degradationId(ref.storyId, ACTIVE_STORY_CHANGED_FILE_PROBE_FAILED_KIND, '');
  return ref.degradations
    .filter(degradation => degradation.id === prefix || degradation.id.startsWith(`${prefix}-`))
    .map(degradation => degradation.reason);
}

function refBlockers(ref: ParallelWaveStoryRef): string[] {
  return uniqueStrings([
    ...ref.dependencies.active,
    ...ref.dependencies.blockingForActive,
    ...actualFileOverlapReasons(ref),
    ...changedFileProbeRiskReasons(ref),
    ...activeStoryChangedFileProbeRiskReasons(ref),
    ...ref.degradations
      .filter(degradation => degradation.severity === 'block')
      .map(degradation => degradation.reason),
  ]);
}

function dispatchAgentRole(recommendation: ParallelWaveRecommendation): ParallelDispatchEntry['agentRole'] {
  if (recommendation === 'parallel_dev') return 'implementer';
  if (recommendation === 'plan_only') return 'planner';
  return 'blocked';
}

function dispatchNextCommand(ref: ParallelWaveStoryRef): string {
  if (ref.recommendation === 'parallel_dev') {
    return `lattice dispatch --storyId=${ref.storyId} --itemId=<CHK-id> --agentType=lattice-implementer`;
  }
  if (ref.recommendation === 'plan_only') {
    return `lattice parallel_plan --storyIds='["${ref.storyId}"]'`;
  }
  return `lattice parallel_status --storyIds='["${ref.storyId}"]'`;
}

function dispatchEntry(ref: ParallelWaveStoryRef, refs: ParallelWaveExperienceRef[]): ParallelDispatchEntry {
  return {
    storyId: ref.storyId,
    title: ref.title,
    recommendation: ref.recommendation,
    dispatchable: ref.recommendation !== 'blocked',
    agentRole: dispatchAgentRole(ref.recommendation),
    spawned: false,
    requiresRunnerConfirmation: true,
    recommendedHostIds: ref.recommendedHostIds,
    ...(ref.worktreePath ? { worktreePath: ref.worktreePath } : {}),
    ...(ref.branch ? { branch: ref.branch } : {}),
    nextCommand: dispatchNextCommand(ref),
    blockers: refBlockers(ref),
    degradations: ref.degradations,
    evidenceRefs: ref.evidenceRefs,
    experienceRefs: refs,
  };
}

function mergeGuidance(wave: LatticeParallelWave): ParallelWaveMergeGuidance {
  const refsById = new Map(wave.storyRefs.map(ref => [ref.storyId, ref]));
  const ready: ParallelMergeGuidanceReady[] = [];
  const blocked: ParallelMergeGuidanceBlocked[] = [];
  for (const entry of wave.mergeOrder) {
    const ref = refsById.get(entry.storyId);
    if (!ref) continue;
    const blockers = refBlockers(ref);
    if (ref.recommendation === 'blocked') {
      blocked.push({
        storyId: ref.storyId,
        title: ref.title,
        blockers,
        guidance: blockers.length > 0
          ? `Resolve blockers before dispatch or merge: ${blockers.join('; ')}.`
          : 'Resolve blocked scheduling state before dispatch or merge.',
      });
      continue;
    }
    ready.push({
      storyId: ref.storyId,
      title: ref.title,
      guidance: ref.recommendation === 'parallel_dev'
        ? 'Ready for operator-confirmed implementer dispatch; normal Proofbound review, test, merge, and receipt gates still apply.'
        : blockers.length > 0
          ? `Ready for planning-only handoff; resolve scheduling risks before simultaneous DEV or merge: ${blockers.join('; ')}.`
          : 'Ready for planning-only handoff; avoid simultaneous DEV until hotspot or capability degradations clear.',
    });
  }
  return { ready, blocked };
}

function mergeQueueEntry(entry: ParallelWaveMergeOrderEntry, ref: ParallelWaveStoryRef): ParallelMergeQueueEntry {
  const blockers = refBlockers(ref);
  const ready = ref.recommendation !== 'blocked';
  return {
    storyId: ref.storyId,
    title: ref.title,
    after: entry.after,
    safety: entry.safety,
    recommendation: entry.recommendation,
    ready,
    blockers,
    guidance: ready
      ? blockers.length > 0
        ? `Queue for planning follow-up only; resolve before simultaneous DEV or merge: ${blockers.join('; ')}.`
        : entry.recommendation === 'parallel_dev'
        ? 'Queue after listed dependencies and keep receipt-backed authority checks separate.'
        : 'Queue for planning follow-up only; do not treat plan-only as simultaneous DEV clearance.'
      : blockers.length > 0
        ? `Blocked until resolved: ${blockers.join('; ')}.`
        : 'Blocked until scheduling safety is restored.',
    evidenceRefs: ref.evidenceRefs,
  };
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
  changedFiles: ParallelWaveChangedFiles,
  actualFileOverlaps: ParallelWaveActualFileOverlap[],
  activeStoryProbeFailures: ParallelWaveChangedFileProbeFailure[],
  scopeGlobOverlaps: ScopeGlobOverlap[],
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
  if (changedFiles.status === 'not_configured') {
    degradations.push(schedulingDegradation(
      story.storyId,
      'changed-files',
      'not-configured',
      'info',
      changedFiles.reason ?? 'Story has no registered worktree path; git changed-file projection was not collected.',
      'Changed-file overlap checks apply once the story has a registered worktree.',
    ));
  }
  if (changedFiles.status === 'failed') {
    degradations.push(schedulingDegradation(
      story.storyId,
      'changed-files',
      'failed',
      'warn',
      `${changedFiles.reason ?? 'git changed-file projection failed.'}${explicitOverrideNote}`,
      'Allow planning only until the worktree changed-file projection can be collected.',
    ));
  }
  for (const failure of activeStoryProbeFailures) {
    degradations.push(schedulingDegradation(
      story.storyId,
      ACTIVE_STORY_CHANGED_FILE_PROBE_FAILED_KIND,
      failure.storyId,
      'warn',
      `Active story ${failure.storyId} changed-file projection failed: ${failure.reason}.${explicitOverrideNote}`,
      'Allow planning only until every active story worktree changed-file projection can be collected.',
    ));
  }
  for (const overlap of actualFileOverlaps) {
    degradations.push(schedulingDegradation(
      story.storyId,
      'actual-file-overlap',
      `${overlap.path}-${overlap.peerStoryId}`,
      'warn',
      `Material file ${overlap.path} overlaps active story ${overlap.peerStoryId}.${explicitOverrideNote}`,
      'Allow planning and merge sequencing only; avoid simultaneous DEV until the overlapping file risk is resolved.',
    ));
  }
  // scope_glob_overlap (advisory-only, Story 4): a STATIC write-set collision with an active
  // parallel peer. Built via the pure exported scopeGlobOverlapDegradations() so the exact
  // degradation shape is runtime-testable (resolveWaveSafety itself is private). Advisory-only:
  // it does NOT change the safety tier here (a hard block is Story 5), so the
  // explicitOverrideNote ("...overridden by collection-level safety") is deliberately NOT
  // appended — nothing is being overridden.
  degradations.push(...scopeGlobOverlapDegradations(story.storyId, scopeGlobOverlaps));

  if (dependencies.active.length > 0 || dependencies.blockingForActive.length > 0 || explicit === 'no') {
    return { safety: 'no', degradations };
  }
  if (
    sharedHotspots.length > 0 ||
    actualFileOverlaps.length > 0 ||
    changedFiles.status === 'failed' ||
    activeStoryProbeFailures.length > 0 ||
    explicit === 'plan_only'
  ) {
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
      blocksProductionDone: degradations.filter(d => d.authorityImpact === 'blocks-production-done' || d.authorityImpact === 'local-assurance-required').length,
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
  changedFilesByStory: Map<string, ParallelWaveChangedFiles>,
  actualFileOverlapsByStory: Map<string, ParallelWaveActualFileOverlap[]>,
  contractsByStoryId: Map<string, ScopeContractData>,
  scopeGlobEnabled: boolean,
): ParallelWaveStoryRef {
  const canonical = buildCanonicalStory(store, root, story.storyId).story;
  const dependencies = dependencySummary(story, allStories, waveIds);
  const sharedHotspots = hotspotConflicts(story, allStories);
  const changedFiles = changedFilesByStory.get(story.storyId) ?? {
    source: 'git',
    status: 'not_configured',
    materialChangedFiles: [],
    ignoredChangedFiles: [],
    reason: 'Story has no changed-file projection.',
  } satisfies ParallelWaveChangedFiles;
  const actualFileOverlaps = actualFileOverlapsByStory.get(story.storyId) ?? [];
  const activeStoryProbeFailures = activeStoryChangedFileProbeFailures(changedFilesByStory, story.storyId);
  // Story 4: static scope-contract write-set overlap with ACTIVE parallel peers (advisory-only).
  // Contracts are read ONCE, safely, upstream (contractsByStoryId, via safeReadScopeContract):
  // a corrupt OR missing scope-contract.json is simply absent from the Map, so this projection
  // performs no I/O and cannot throw — one bad contract anywhere never crashes the wave.
  // §4.7 escape hatch: when the parallel gate is mode='off' the caller passes
  // scopeGlobEnabled=false, so NO scope_glob_overlap degradation is emitted (overlaps stay []).
  // The pure computeScopeGlobOverlaps remains config-free; the on/off decision lives in the
  // factory and is just a branch here.
  const canonicalPhaseForOverlap = canonical.lifecycle.phase ?? canonicalPhase(story.phase);
  const scopeGlobOverlaps = scopeGlobEnabled
    ? computeScopeGlobOverlaps(
        {
          storyId: story.storyId,
          phase: canonicalPhaseForOverlap,
          parallelSafe: story.parallelSafe,
          writeSet: (() => {
            const selfContract = contractsByStoryId.get(story.storyId);
            return selfContract ? computeWriteSet(selfContract) : [];
          })(),
        },
        allStories
          .filter(p => p.storyId !== story.storyId)
          .flatMap(p => {
            const peerContract = contractsByStoryId.get(p.storyId);
            if (!peerContract) return [];
            return [{
              storyId: p.storyId,
              phase: p.phase,
              parallelSafe: p.parallelSafe,
              writeSet: computeWriteSet(peerContract),
            }];
          }),
      )
    : [];
  const resolved = resolveWaveSafety(story, dependencies, sharedHotspots, changedFiles, actualFileOverlaps, activeStoryProbeFailures, scopeGlobOverlaps);
  const recommendation = recommendationFor(resolved.safety, hostIds);
  return {
    storyId: story.storyId,
    title: story.title,
    phase: canonicalPhaseForOverlap,
    lane: resolveStoryLane(story),
    ...(story.parallelSafe ? { declaredParallelSafe: story.parallelSafe } : {}),
    safety: resolved.safety,
    recommendation,
    parallelDevRecommended: recommendation === 'parallel_dev',
    recommendedHostIds: recommendation === 'parallel_dev' ? hostIds : [],
    dependencies,
    hotspots: uniqueStrings(story.sharedHotspots ?? []),
    sharedHotspots,
    changedFiles,
    actualFileOverlaps,
    degradations: resolved.degradations,
    evidenceRefs: evidenceRefs(canonical),
    canonicalStoryRef: {
      schemaVersion: canonical.schemaVersion,
      storyId: canonical.storyId,
      ...(canonical.authority.canonicalStoryDigest ? { canonicalStoryDigest: canonical.authority.canonicalStoryDigest } : {}),
      ...(canonical.authority.gateInputDigest ? { gateInputDigest: canonical.authority.gateInputDigest } : {}),
    },
    recoveryRefs: recoveryRefs(canonical),
    ...(story.worktree?.path ? { worktreePath: story.worktree.path } : {}),
    ...(story.worktree?.branch ? { branch: story.worktree.branch } : {}),
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
      blockers: refBlockers(ref),
    };
  });
}

function authorityBoundary(hosts: ParallelWaveHostCandidate[]): ParallelWaveAuthorityBoundary {
  const blockedHosts = hosts
    .filter(host => host.capability.productionDoneBlocked)
    .map(host => `${host.host}:receipt-bundle=${host.capability.receiptVerifyStatus}`);
  return {
    productionDone: false,
    authorityChanged: false,
    receiptRefs: [],
    notes: [
      'Parallel Wave is collection-level scheduling and recovery guidance only; it does not mutate story authority, verify receipts, or satisfy DONE.',
      blockedHosts.length > 0
        ? `Local assurance remains incomplete for hosts without available receipt-bundle verification (${blockedHosts.join(', ')}).`
        : 'Receipt-bundle-capable hosts still need proof admissibility and local review quorum before any integration; no productionDone claim is made.',
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
  const changedFilesByStory = collectActiveStoryChangedFiles(root, allStories);
  const overlapsByStory = actualFileOverlapsByStory(changedFilesByStory);
  // §4.7 reversible escape hatch: parallelGate.mode='off' disables BOTH behaviors — the
  // story-review advisory AND this wave's scope_glob_overlap degradation. The config read is
  // confined to this factory (which already reads store + root); the pure layers
  // (computeScopeGlobOverlaps / resolveWaveSafety) stay config-free. The project-level profile
  // is the collection-level concern here; resolveAuditConfig tolerates an absent/invalid profile.
  const parallelMode = resolveAuditConfig(loadConfig(root).workflow?.profile ?? 'balanced', root).parallelGate?.mode ?? 'advise';
  const scopeGlobEnabled = parallelMode !== 'off';
  // Read every scope contract ONCE, safely (corrupt OR missing => simply absent from the Map),
  // so the per-story overlap projection in storyRef performs no I/O and cannot throw.
  const contractsByStoryId = new Map<string, ScopeContractData>();
  for (const s of allStories) {
    const c = safeReadScopeContract(store, s.storyId);
    if (c) contractsByStoryId.set(s.storyId, c);
  }
  const storyRefs = selectedStories.map(story =>
    storyRef(store, root, story, allStories, waveIds, recommendedHostIds, changedFilesByStory, overlapsByStory, contractsByStoryId, scopeGlobEnabled)
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
      'Rerun normal Proofbound validation and require verified receipts before claiming productionDone.',
    ],
  };
}

export function buildParallelDispatch(
  wave: LatticeParallelWave,
  options: ParallelWaveProjectionOptions = {},
): LatticeParallelDispatch {
  const refs = experienceRefs(options);
  return {
    schemaVersion: PARALLEL_DISPATCH_SCHEMA_VERSION,
    waveSchemaVersion: PARALLEL_WAVE_SCHEMA_VERSION,
    waveId: wave.waveId,
    dispatchedAt: new Date().toISOString(),
    summary: waveCounts(wave),
    dispatchEntries: wave.storyRefs
      .map(ref => dispatchEntry(ref, refs))
      .sort((a, b) => a.storyId.localeCompare(b.storyId)),
    hostCandidates: wave.hostCandidates,
    evidenceRefs: wave.evidenceRefs,
    mergeOrder: wave.mergeOrder,
    authority: nonAuthorityBoundary(wave.authority),
  };
}

export function buildParallelStatus(wave: LatticeParallelWave): LatticeParallelStatus {
  return {
    schemaVersion: PARALLEL_STATUS_SCHEMA_VERSION,
    waveSchemaVersion: PARALLEL_WAVE_SCHEMA_VERSION,
    waveId: wave.waveId,
    statusAt: new Date().toISOString(),
    summary: waveCounts(wave),
    candidates: wave.storyRefs
      .filter(ref => ref.recommendation === 'parallel_dev')
      .map(ref => ref.storyId)
      .sort(),
    planOnly: wave.storyRefs
      .filter(ref => ref.recommendation === 'plan_only')
      .map(ref => ref.storyId)
      .sort(),
    blocked: wave.storyRefs
      .filter(ref => ref.recommendation === 'blocked')
      .map(ref => ({
        storyId: ref.storyId,
        title: ref.title,
        blockers: refBlockers(ref),
      }))
      .sort((a, b) => a.storyId.localeCompare(b.storyId)),
    mergeGuidance: mergeGuidance(wave),
    authority: nonAuthorityBoundary(wave.authority),
  };
}

export function buildParallelMergeQueue(wave: LatticeParallelWave): LatticeParallelMergeQueue {
  const refsById = new Map(wave.storyRefs.map(ref => [ref.storyId, ref]));
  const entries = wave.mergeOrder.flatMap(entry => {
    const ref = refsById.get(entry.storyId);
    return ref ? [mergeQueueEntry(entry, ref)] : [];
  });
  return {
    schemaVersion: PARALLEL_MERGE_QUEUE_SCHEMA_VERSION,
    waveSchemaVersion: PARALLEL_WAVE_SCHEMA_VERSION,
    waveId: wave.waveId,
    queuedAt: new Date().toISOString(),
    summary: waveCounts(wave),
    ready: entries.filter(entry => entry.ready),
    blocked: entries.filter(entry => !entry.ready),
    mergeGuidance: mergeGuidance(wave),
    authority: nonAuthorityBoundary(wave.authority),
  };
}

export function buildParallelReport(
  wave: LatticeParallelWave,
  options: ParallelWaveProjectionOptions = {},
): LatticeParallelReport {
  const refs = experienceRefs(options);
  const dispatchEntries = wave.storyRefs
    .map(ref => dispatchEntry(ref, refs))
    .sort((a, b) => a.storyId.localeCompare(b.storyId));
  return {
    schemaVersion: PARALLEL_REPORT_SCHEMA_VERSION,
    waveSchemaVersion: PARALLEL_WAVE_SCHEMA_VERSION,
    waveId: wave.waveId,
    reportedAt: new Date().toISOString(),
    summary: waveCounts(wave),
    candidates: wave.storyRefs
      .filter(ref => ref.recommendation === 'parallel_dev')
      .map(ref => ref.storyId)
      .sort(),
    planOnly: wave.storyRefs
      .filter(ref => ref.recommendation === 'plan_only')
      .map(ref => ref.storyId)
      .sort(),
    blocked: wave.storyRefs
      .filter(ref => ref.recommendation === 'blocked')
      .map(ref => ref.storyId)
      .sort(),
    dispatchEntries,
    mergeGuidance: mergeGuidance(wave),
    evidenceSummary: {
      topLevelRefs: wave.evidenceRefs,
      byStory: wave.storyRefs
        .map(ref => ({
          storyId: ref.storyId,
          title: ref.title,
          evidenceRefs: ref.evidenceRefs,
          canonicalStoryRef: ref.canonicalStoryRef,
          recoveryRefs: ref.recoveryRefs,
        }))
        .sort((a, b) => a.storyId.localeCompare(b.storyId)),
    },
    experienceRefs: refs,
    authority: nonAuthorityBoundary(wave.authority),
  };
}
