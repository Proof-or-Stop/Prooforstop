import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveRepositoryBaseline, type RepositoryBaselineCache } from '../../git-baseline.js';

export const QUEUE_GOVERNANCE_STATUS_SCHEMA_VERSION = 'proof-or-stop.queue_governance_status.v1' as const;
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { currentStoryFilesHash } from '../../evidence-freshness.js';
import { resolveLocalAssuranceStoryContexts } from '../../local-assurance-story-projection.js';
import type { StoryStore } from '../../store.js';
import type { StoryInfo } from '../../types.js';
import { getRepoRoot } from '../../worktree-runtime.js';
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
import { readBrandEnv } from '../../brand-env.js';
import { PROOF_OR_STOP_DIR } from '../../proof-or-stop-paths.js';

const TERMINAL_PHASES = new Set(['DONE', 'DISCARDED', 'META']);
const MIGRATION_TITLE_RUN_PATTERN = /^Tier-C provider-execution receipt verification(?: \([^)]+\))? run\b/;
const TIER_C_EXPERIMENT_BATCH_ID = 'tier-c-provider-execution-receipt-verification';
type QueueExceptionSource = QueueExceptionRecord['source'];
type QueueExceptionInputSource = QueueExceptionSource | 'tier-c-prefix';

interface QueueExceptionRegistry {
  schemaVersion: 'proof-or-stop.queue_exception_registry.v1';
  policyVersion: 'proof-or-stop.queue_exception.v1';
  exceptions: QueueExceptionRecord[];
}

export interface QueueGovernanceOptions {
  readonly expanded?: boolean;
  readonly now?: string;
  readonly staleWorktreeMs?: number;
  /** Optional diagnostic probes: defaults 4 / 1000 ms; explicit limits up to 1000 / 60000 ms. */
  readonly gitProbeLimit?: number;
  readonly gitProbeBudgetMs?: number;
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
  return join(root, PROOF_OR_STOP_DIR, 'lifecycle-control', 'queue-exceptions.json');
}

function auditPath(root: string): string {
  return join(root, PROOF_OR_STOP_DIR, 'lifecycle-control', 'queue-exceptions.audit.jsonl');
}

function emptyRegistry(): QueueExceptionRegistry {
  return {
    schemaVersion: 'proof-or-stop.queue_exception_registry.v1',
    policyVersion: 'proof-or-stop.queue_exception.v1',
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
      schemaVersion: 'proof-or-stop.queue_exception_registry.v1',
      policyVersion: 'proof-or-stop.queue_exception.v1',
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
  return record.policyVersion === 'proof-or-stop.queue_exception.v1' &&
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
    policyVersion: 'proof-or-stop.queue_exception.v1',
    class: 'experiment-batch-exception',
    experimentBatchId: input.experimentBatchId,
    storyIds,
    source: normalizeQueueExceptionSource(input.source) ?? 'explicit',
    storyFilesHash: storyFilesHashFor(root, storyIds),
    dashboardMode: input.dashboardMode ?? 'collapsed',
    cleanupPolicy: 'preserve',
    actor: input.actor?.trim() || readBrandEnv('AGENT') || process.env.USER || 'unknown',
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
    schemaVersion: 'proof-or-stop.queue_exception_set.v1',
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
    policyVersion: 'proof-or-stop.queue_exception.v1',
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
  return MIGRATION_TITLE_RUN_PATTERN.test(story.title);
}

function migrationTitlePrefixException(story: StoryInfo, root: string, now: string): QueueExceptionRecord | null {
  if (!titleInferredExperiment(story)) return null;
  const storyIds = [story.storyId];
  return {
    exceptionId: exceptionId({
      experimentBatchId: TIER_C_EXPERIMENT_BATCH_ID,
      storyIds,
      reason: 'Tier-C migration title-prefix discovery.',
      source: 'migration-title-prefix',
    }),
    policyVersion: 'proof-or-stop.queue_exception.v1',
    class: 'experiment-batch-exception',
    experimentBatchId: TIER_C_EXPERIMENT_BATCH_ID,
    storyIds,
    source: 'migration-title-prefix',
    storyFilesHash: storyFilesHashFor(root, storyIds),
    dashboardMode: 'collapsed',
    cleanupPolicy: 'preserve',
    actor: 'queue-governance-migration',
    reason: 'Tier-C provider-execution receipt verification title-prefix migration preserves each run as experiment evidence.',
    createdAt: now,
  };
}

function malformedExperiment(story: StoryInfo): boolean {
  return /tier-c/i.test(story.title) && !titleInferredExperiment(story);
}

interface ProgressProbeBudget {
  remaining: number;
  readonly deadlineMs: number;
  readonly observations: Map<string, number | null | undefined>;
  readonly baselineCandidates: RepositoryBaselineCache;
}

function storyProgressState(story: StoryInfo, gitCwd: string, thresholdMs: number, nowMs: number, budget: ProgressProbeBudget): 'active' | 'stale' | 'unknown' {
  // Directory mtime measures direct child entries, not nested Story progress.
  // Ignore invalid/future timestamps; unavailable evidence remains unknown.
  const progress = [story.createdAt, story.startedAt, ...(story.events ?? []).map(event => event.timestamp)]
    .map(value => typeof value === 'string' ? Date.parse(value) : NaN)
    .filter(value => Number.isFinite(value) && value <= nowMs);
  if (progress.some(time => nowMs - time <= thresholdMs)) return 'active';
  // Only probe Git when recorded activity is old. An inherited main commit or
  // a merge-only synchronization is not evidence of work on this Story.
  if (!budget.observations.has(gitCwd)) {
    if (budget.remaining <= 0 || performance.now() >= budget.deadlineMs) return 'unknown';
    budget.remaining--;
    budget.observations.set(gitCwd, undefined);
    try {
      const baseline = resolveRepositoryBaseline(gitCwd, 'HEAD', { deadlineMs: budget.deadlineMs, candidateCache: budget.baselineCandidates });
      const remaining = Math.floor(budget.deadlineMs - performance.now());
      if (!baseline || remaining <= 0) return 'unknown';
      const value = execFileSync('git', ['log', '-1', '--no-merges', '--format=%ct', `${baseline.commit ?? baseline.ref}..HEAD`, '--'],
        { cwd: gitCwd, encoding: 'utf8', timeout: remaining, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      budget.observations.set(gitCwd, value ? Number(value) * 1000 : null);
    } catch { /* Optional observation failure is not proof of staleness. */ }
  }
  const committedAt = budget.observations.get(gitCwd);
  if (committedAt === undefined || (committedAt !== null && (!Number.isFinite(committedAt) || committedAt > nowMs))) return 'unknown';
  if (committedAt !== null && nowMs - committedAt <= thresholdMs) return 'active';
  return progress.length > 0 ? 'stale' : 'unknown';
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
      exceptionSource: args.exception.source,
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
  const { projection: localProjection, workspaces } = resolveLocalAssuranceStoryContexts(store, root, { activeOnly: true, now });
  const localProjectionById = new Map(localProjection.stories.map((row) => [row.storyId, row]));
  const activeStories = store.listStoryIds()
    .map((storyId) => {
      try { return store.readStory(storyId); } catch { return null; }
    })
    .filter((story): story is StoryInfo => story !== null && !TERMINAL_PHASES.has(story.phase));

  for (const story of activeStories) {
    if (exceptions.has(story.storyId)) continue;
    const durable = durableExperimentException(story, mainRepoRoot, now);
    if (durable) {
      exceptions.set(story.storyId, durable);
      continue;
    }
    const migrated = migrationTitlePrefixException(story, mainRepoRoot, now);
    if (migrated) exceptions.set(story.storyId, migrated);
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

  const bounded = (value: number | undefined, fallback: number, maximum: number): number =>
    value !== undefined && Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.floor(value))) : fallback;
  const probeBudget: ProgressProbeBudget = {
    remaining: bounded(options.gitProbeLimit, 4, 1000),
    deadlineMs: performance.now() + bounded(options.gitProbeBudgetMs, 1000, 60000),
    observations: new Map(),
    baselineCandidates: new Map(),
  };
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
      const workspace = workspaces.get(story.storyId)!;
      const progress = workspace.readFromStoryWorktree
        ? storyProgressState(workspace.story, workspace.gitCwd, staleWorktreeMs, Number.isFinite(nowMs) ? nowMs : Date.now(), probeBudget)
        : 'unknown';
      return queueRow({
        // Selection, grouping and displayed phase share the queue mirror. Only
        // progress evidence comes from the authoritative workspace above.
        story,
        classification: progress === 'unknown' ? 'unknown-worktree' : progress === 'stale' ? 'stale-worktree' : 'active-worktree',
        reason: progress === 'unknown'
          ? 'authoritative Story state or bounded Git progress evidence is unavailable; no staleness or cleanup conclusion'
          : progress === 'stale'
          ? 'authoritative Story progress is older than the threshold'
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
        reason: explicit.source === 'migration-title-prefix'
          ? 'Tier-C migration title-prefix exception preserves provider-execution receipt verification evidence; lifecycle readiness is unchanged'
          : 'experiment exception preserves provider-execution receipt verification evidence; lifecycle readiness is unchanged',
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
    unknownWorktree: rows.filter((row) => row.classification === 'unknown-worktree').length,
    mainInit: rows.filter((row) => row.classification === 'main-init').length,
    experimentBatchException: rows.filter((row) => row.classification === 'experiment-batch-exception').length,
    duplicateCandidate: rows.filter((row) => row.classification === 'duplicate-candidate').length,
    superseded: rows.filter((row) => row.classification === 'superseded').length,
    cleanupRequired: rows.filter((row) => row.classification === 'cleanup-required').length,
  };

  return {
    schemaVersion: QUEUE_GOVERNANCE_STATUS_SCHEMA_VERSION,
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
