import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { currentStoryFilesHash } from '../../evidence-freshness.js';
import { resolveLocalAssuranceStories } from '../../local-assurance-story-projection.js';
import type { StoryStore } from '../../store.js';
import type { StoryInfo } from '../../types.js';
import { getRepoRoot, resolveWorktreePath } from '../../worktree-runtime.js';
import {
  CONTROL_QUEUE_CLASSIFICATIONS,
  DEFAULT_CONTROL_PLANE_CAPABILITIES,
  type ControlQueueClassification,
  type QueueExceptionRecord,
  type QueueExceptionSetResult,
  type QueueGovernanceReport,
  type QueueGovernanceRow,
} from '../control-status.js';
import { isReadOnlyControlPlane } from '../global-control-service.js';

export {
  CONTROL_QUEUE_CLASSIFICATIONS,
  DEFAULT_CONTROL_PLANE_CAPABILITIES,
  isReadOnlyControlPlane,
};
export type {
  ControlQueueClassification,
  ControlQueueStatus,
  QueueExceptionRecord,
  QueueExceptionSetResult,
  QueueGovernanceReport,
  QueueGovernanceRow,
} from '../control-status.js';

const TERMINAL_PHASES = new Set(['DONE', 'DISCARDED', 'META']);
const MIGRATION_TITLE_PREFIX = 'Tier-C provider-execution receipt verification';
type QueueExceptionSource = QueueExceptionRecord['source'];
type QueueExceptionInputSource = QueueExceptionSource | 'tier-c-prefix';

interface QueueExceptionRegistry {
  schemaVersion: 'lattice.queue_exception_registry.v1';
  policyVersion: 'proofbound.queue_exception.v1';
  exceptions: QueueExceptionRecord[];
}

export interface QueueGovernanceOptions {
  readonly expanded?: boolean;
  readonly now?: string;
  readonly staleWorktreeMs?: number;
}

export interface QueueExceptionSetInput {
  readonly experimentBatchId: string;
  readonly storyIds: readonly string[];
  readonly reason: string;
  readonly actor?: string;
  readonly source?: QueueExceptionInputSource;
  readonly dashboardMode?: 'collapsed' | 'expanded';
}

function registryPath(root: string): string {
  return join(root, '.lattice', 'lifecycle-control', 'queue-exceptions.json');
}

function auditPath(root: string): string {
  return join(root, '.lattice', 'lifecycle-control', 'queue-exceptions.audit.jsonl');
}

function emptyRegistry(): QueueExceptionRegistry {
  return {
    schemaVersion: 'lattice.queue_exception_registry.v1',
    policyVersion: 'proofbound.queue_exception.v1',
    exceptions: [],
  };
}

export function readQueueExceptionRegistry(root: string): QueueExceptionRegistry {
  const file = registryPath(root);
  if (!existsSync(file)) return emptyRegistry();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<QueueExceptionRegistry>;
    const exceptions = Array.isArray(parsed.exceptions)
      ? parsed.exceptions
        .map(normalizeQueueExceptionRecord)
        .filter((record): record is QueueExceptionRecord => record !== null)
      : [];
    return {
      schemaVersion: 'lattice.queue_exception_registry.v1',
      policyVersion: 'proofbound.queue_exception.v1',
      exceptions,
    };
  } catch {
    return emptyRegistry();
  }
}

function normalizeQueueExceptionSource(source: unknown): QueueExceptionSource | null {
  if (source === undefined || source === 'explicit') return 'explicit';
  if (source === 'migration-title-prefix' || source === 'tier-c-prefix') return 'migration-title-prefix';
  return null;
}

function normalizeQueueExceptionRecord(value: unknown): QueueExceptionRecord | null {
  if (!isQueueExceptionRecord(value)) return null;
  const source = normalizeQueueExceptionSource((value as unknown as { source?: unknown }).source);
  return source ? { ...value, source } : null;
}

function writeQueueExceptionRegistry(root: string, registry: QueueExceptionRegistry): void {
  const file = registryPath(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
}

function isQueueExceptionRecord(value: unknown): value is QueueExceptionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.policyVersion === 'proofbound.queue_exception.v1' &&
    record.class === 'experiment-batch-exception' &&
    typeof record.exceptionId === 'string' &&
    typeof record.experimentBatchId === 'string' &&
    Array.isArray(record.storyIds) &&
    normalizeQueueExceptionSource(record.source) !== null &&
    record.cleanupPolicy === 'preserve';
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleClusterKey(story: StoryInfo): string {
  return normalizeTitle(story.title || story.name).split(' ').slice(0, 6).join(' ');
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function exceptionId(input: QueueExceptionSetInput): string {
  return `qex-${hashString(`${input.experimentBatchId}\0${[...input.storyIds].sort().join(',')}`).slice(0, 12)}`;
}

function storyFilesHashFor(root: string, storyIds: readonly string[]): string {
  return currentStoryFilesHash(root) ?? hashString(storyIds.slice().sort().join('\0'));
}

function validateExceptionInput(input: QueueExceptionSetInput): void {
  if (!input.experimentBatchId || !/^[a-z0-9][a-z0-9_.-]*$/.test(input.experimentBatchId)) {
    throw new Error('queue_exception_set requires experimentBatchId matching /^[a-z0-9][a-z0-9_.-]*$/');
  }
  if (!Array.isArray(input.storyIds) || input.storyIds.length === 0 || input.storyIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new Error('queue_exception_set requires a non-empty storyIds array');
  }
  if (!input.reason || input.reason.trim().length < 10) {
    throw new Error('queue_exception_set requires reason with at least 10 characters');
  }
}

export function setQueueException(root: string, input: QueueExceptionSetInput): QueueExceptionSetResult {
  validateExceptionInput(input);
  const now = new Date().toISOString();
  const storyIds = [...new Set(input.storyIds.map((id) => id.trim()))].sort();
  const record: QueueExceptionRecord = {
    exceptionId: exceptionId({ ...input, storyIds }),
    policyVersion: 'proofbound.queue_exception.v1',
    class: 'experiment-batch-exception',
    experimentBatchId: input.experimentBatchId,
    storyIds,
    source: normalizeQueueExceptionSource(input.source) ?? 'explicit',
    storyFilesHash: storyFilesHashFor(root, storyIds),
    dashboardMode: input.dashboardMode ?? 'collapsed',
    cleanupPolicy: 'preserve',
    actor: input.actor?.trim() || process.env.LATTICE_AGENT || process.env.USER || 'unknown',
    reason: input.reason.trim(),
    createdAt: now,
  };
  const registry = readQueueExceptionRegistry(root);
  const next = {
    ...registry,
    exceptions: [
      ...registry.exceptions.filter((existing) => existing.exceptionId !== record.exceptionId),
      record,
    ].sort((a, b) => a.exceptionId.localeCompare(b.exceptionId)),
  };
  writeQueueExceptionRegistry(root, next);
  const auditEvent = {
    type: 'queue_exception_set' as const,
    storyIds,
    timestamp: now,
  };
  mkdirSync(dirname(auditPath(root)), { recursive: true });
  appendFileSync(auditPath(root), JSON.stringify({ ...auditEvent, exceptionId: record.exceptionId, actor: record.actor }) + '\n', 'utf-8');
  return {
    schemaVersion: 'lattice.queue_exception_set.v1',
    ...record,
    written: true,
    auditEvent,
  };
}

function explicitExceptionByStory(root: string): Map<string, QueueExceptionRecord> {
  const map = new Map<string, QueueExceptionRecord>();
  const mainRepoRoot = getRepoRoot(root);
  for (const record of readQueueExceptionRegistry(mainRepoRoot).exceptions) {
    for (const storyId of record.storyIds) map.set(storyId, record);
  }
  return map;
}

function supersededBy(story: StoryInfo): string | null {
  const lifecycleControl = (story as StoryInfo & {
    lifecycleControl?: {
      queue?: {
        supersededBy?: unknown;
      };
    };
  }).lifecycleControl;
  const value = lifecycleControl?.queue?.supersededBy;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function durableExperimentException(story: StoryInfo, root: string, now: string): QueueExceptionRecord | null {
  const lifecycleControl = (story as StoryInfo & {
    lifecycleControl?: {
      queue?: {
        experimentBatchId?: unknown;
        reason?: unknown;
        actor?: unknown;
        createdAt?: unknown;
        dashboardMode?: unknown;
      };
    };
  }).lifecycleControl;
  const queue = lifecycleControl?.queue;
  const experimentBatchId = typeof queue?.experimentBatchId === 'string' ? queue.experimentBatchId.trim() : '';
  if (!experimentBatchId || !/^[a-z0-9][a-z0-9_.-]*$/.test(experimentBatchId)) return null;
  const storyIds = [story.storyId];
  return {
    exceptionId: exceptionId({
      experimentBatchId,
      storyIds,
      reason: 'Durable story queue metadata.',
      source: 'explicit',
      dashboardMode: queue?.dashboardMode === 'expanded' ? 'expanded' : 'collapsed',
    }),
    policyVersion: 'proofbound.queue_exception.v1',
    class: 'experiment-batch-exception',
    experimentBatchId,
    storyIds,
    source: 'explicit',
    storyFilesHash: storyFilesHashFor(root, storyIds),
    dashboardMode: queue?.dashboardMode === 'expanded' ? 'expanded' : 'collapsed',
    cleanupPolicy: 'preserve',
    actor: typeof queue?.actor === 'string' && queue.actor.trim() ? queue.actor.trim() : 'story-metadata',
    reason: typeof queue?.reason === 'string' && queue.reason.trim()
      ? queue.reason.trim()
      : 'Durable story metadata marks this story as an experiment-batch exception.',
    createdAt: typeof queue?.createdAt === 'string' && queue.createdAt.trim() ? queue.createdAt.trim() : now,
  };
}

function titleInferredExperiment(story: StoryInfo): boolean {
  return story.title.startsWith(MIGRATION_TITLE_PREFIX);
}

function malformedExperiment(story: StoryInfo): boolean {
  return /tier-c/i.test(story.title) && !titleInferredExperiment(story);
}

function worktreeIsStale(story: StoryInfo, root: string, thresholdMs: number, nowMs: number): boolean {
  const path = story.worktree?.path;
  if (!path) return false;
  const absolute = resolveWorktreePath(getRepoRoot(root), path);
  if (!absolute) return false;
  try {
    return nowMs - statSync(absolute).mtimeMs > thresholdMs;
  } catch {
    return true;
  }
}

function queueRow(args: {
  story: StoryInfo;
  classification: ControlQueueClassification;
  reason: string;
  authoritativeCwd?: string;
  exception?: QueueExceptionRecord;
  cleanupPolicy?: QueueGovernanceRow['cleanupPolicy'];
}): QueueGovernanceRow {
  return {
    storyId: args.story.storyId,
    title: args.story.title,
    phase: args.story.phase,
    classification: args.classification,
    reason: args.reason,
    ...(args.authoritativeCwd ? { authoritativeCwd: args.authoritativeCwd } : {}),
    ...(args.exception ? {
      experimentBatchId: args.exception.experimentBatchId,
      exceptionId: args.exception.exceptionId,
      cleanupPolicy: args.exception.cleanupPolicy,
    } : args.cleanupPolicy ? { cleanupPolicy: args.cleanupPolicy } : {}),
  };
}

export function projectQueueGovernance(
  store: StoryStore,
  root: string,
  options: QueueGovernanceOptions = {},
): QueueGovernanceReport {
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const staleWorktreeMs = options.staleWorktreeMs ?? 7 * 24 * 60 * 60 * 1000;
  const mainRepoRoot = getRepoRoot(root);
  const exceptions = explicitExceptionByStory(root);
  const localProjection = resolveLocalAssuranceStories(store, root, { activeOnly: true, now });
  const localProjectionById = new Map(localProjection.stories.map((row) => [row.storyId, row]));
  const activeStories = store.listStoryIds()
    .map((storyId) => {
      try { return store.readStory(storyId); } catch { return null; }
    })
    .filter((story): story is StoryInfo => story !== null && !TERMINAL_PHASES.has(story.phase));

  for (const story of activeStories) {
    if (exceptions.has(story.storyId)) continue;
    const durable = durableExperimentException(story, mainRepoRoot, now);
    if (durable) exceptions.set(story.storyId, durable);
  }

  const duplicateGroups = new Map<string, StoryInfo[]>();
  for (const story of activeStories) {
    if (supersededBy(story) || exceptions.has(story.storyId)) continue;
    const key = titleClusterKey(story);
    if (!key) continue;
    duplicateGroups.set(key, [...(duplicateGroups.get(key) ?? []), story]);
  }
  const duplicateIds = new Set<string>();
  const duplicateClusters: Array<QueueGovernanceReport['duplicateClusters'][number]> = [];
  for (const [key, stories] of duplicateGroups) {
    const nonExperiment = stories;
    if (nonExperiment.length < 2) continue;
    const canonical = nonExperiment[0];
    const duplicates = nonExperiment.slice(1).map((story) => story.storyId);
    for (const id of duplicates) duplicateIds.add(id);
    duplicateClusters.push({
      clusterId: `dup-${hashString(key).slice(0, 10)}`,
      canonicalStoryId: canonical.storyId,
      duplicateStoryIds: duplicates,
      reason: `normalized title cluster: ${key}`,
    });
  }

  const rows = activeStories.map((story) => {
    const projectionRow = localProjectionById.get(story.storyId);
    const explicit = exceptions.get(story.storyId);
    const supersededTarget = supersededBy(story);
    if (malformedExperiment(story)) {
      return queueRow({
        story,
        classification: 'cleanup-required',
        reason: 'malformed Tier-C experiment title does not match the durable exception rule',
        authoritativeCwd: projectionRow?.activeCwd,
        cleanupPolicy: 'cleanup-required',
      });
    }
    if (supersededTarget) {
      return queueRow({
        story,
        classification: 'superseded',
        reason: `story is explicitly superseded by ${supersededTarget}`,
        authoritativeCwd: projectionRow?.activeCwd,
        cleanupPolicy: 'cleanup-required',
      });
    }
    if (projectionRow?.stateSource === 'worktree') {
      const stale = worktreeIsStale(story, root, staleWorktreeMs, Number.isFinite(nowMs) ? nowMs : Date.now());
      return queueRow({
        story,
        classification: stale ? 'stale-worktree' : 'active-worktree',
        reason: stale
          ? 'authoritative worktree exists but appears stale/missing'
          : explicit
            ? 'authoritative worktree exists; experiment exception metadata is preserved'
            : 'authoritative worktree exists',
        authoritativeCwd: projectionRow.activeCwd,
        exception: explicit,
      });
    }
    if (duplicateIds.has(story.storyId)) {
      return queueRow({
        story,
        classification: 'duplicate-candidate',
        reason: 'non-experiment duplicate candidate; choose canonical/superseded disposition through story flow',
        authoritativeCwd: projectionRow?.activeCwd,
        cleanupPolicy: 'review-required',
      });
    }
    if (explicit) {
      return queueRow({
        story,
        classification: 'experiment-batch-exception',
        reason: 'experiment exception preserves provider-execution receipt verification evidence',
        authoritativeCwd: projectionRow?.activeCwd,
        exception: explicit,
      });
    }
    if (story.phase === 'INIT' || story.phase === 'INIT_CHECK') {
      return queueRow({
        story,
        classification: 'main-init',
        reason: 'story is waiting in main before active worktree execution',
        authoritativeCwd: projectionRow?.activeCwd,
      });
    }
    return queueRow({
      story,
      classification: 'ready',
      reason: 'ordinary active story queue row',
      authoritativeCwd: projectionRow?.activeCwd,
    });
  });

  const batchMap = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.classification !== 'experiment-batch-exception' || !row.experimentBatchId) continue;
    const set = batchMap.get(row.experimentBatchId) ?? new Set<string>();
    set.add(row.storyId);
    batchMap.set(row.experimentBatchId, set);
  }
  const expanded = options.expanded === true;
  const experimentBatches = [...batchMap.entries()].map(([experimentBatchId, ids]) => ({
    experimentBatchId,
    defaultDashboardMode: expanded ? 'expanded' as const : 'collapsed' as const,
    storyCount: ids.size,
    ...(expanded ? { storyIds: [...ids].sort() } : {}),
  }));

  const summary = {
    activeWorktree: rows.filter((row) => row.classification === 'active-worktree').length,
    staleWorktree: rows.filter((row) => row.classification === 'stale-worktree').length,
    mainInit: rows.filter((row) => row.classification === 'main-init').length,
    experimentBatchException: rows.filter((row) => row.classification === 'experiment-batch-exception').length,
    duplicateCandidate: rows.filter((row) => row.classification === 'duplicate-candidate').length,
    superseded: rows.filter((row) => row.classification === 'superseded').length,
    cleanupRequired: rows.filter((row) => row.classification === 'cleanup-required').length,
  };

  return {
    schemaVersion: 'lattice.queue_governance_status.v1',
    readOnly: true,
    generatedAt: now,
    projectRoot: root,
    defaultDashboardMode: expanded ? 'expanded' : 'collapsed',
    rows,
    experimentBatches,
    duplicateClusters,
    cleanupRequired: rows.filter((row) => row.classification === 'cleanup-required'),
    summary,
  };
}
