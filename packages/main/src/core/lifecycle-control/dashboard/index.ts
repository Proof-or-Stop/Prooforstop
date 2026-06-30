import type { StoryStore } from '../../store.js';
import type {
  ControlPlaneStatusLevel,
  ProjectControlStatus,
  QueueGovernanceReport,
  RuntimeClosureReport,
  StoryControlStatus,
} from '../control-status.js';
import { buildProjectControlStatus, buildStoryControlStatus, isReadOnlyControlPlane } from '../global-control-service.js';
import { projectAdmissibilityWaterline } from '../consumption/index.js';
import { projectQueueGovernance } from '../queue/index.js';
import { projectRuntimeClosure } from '../runtime/index.js';

export * from '../control-status.js';
export { buildProjectControlStatus, buildStoryControlStatus, isReadOnlyControlPlane, projectAdmissibilityWaterline, projectQueueGovernance, projectRuntimeClosure };

export interface GlobalControlStatusOptions {
  readonly storyIds?: readonly string[];
  readonly expanded?: boolean;
  readonly now?: string;
}

export interface GlobalControlStoryRow {
  readonly storyId: string;
  readonly title?: string;
  readonly phase?: string;
  readonly runtime: StoryControlStatus['runtime'];
  readonly consumption: StoryControlStatus['consumption'];
  readonly readiness: StoryControlStatus['readiness'];
  readonly queue: StoryControlStatus['queue'];
  readonly authoritativeCwd?: string;
  readonly nextSafeAction?: string;
  readonly readyForNextSafeAction: boolean;
  readonly source: {
    readonly runtime: 'runtime-projection';
    readonly consumption: 'proof-admissibility';
    readonly queue: 'queue-governance';
  };
}

export interface GlobalControlStatusReport {
  readonly schemaVersion: 'lattice.global_control_status.v1';
  readonly readOnly: true;
  readonly generatedAt: string;
  readonly projectRoot: string;
  readonly project: ProjectControlStatus & {
    readonly runtimeAggregate: ControlPlaneStatusLevel;
    readonly consumptionAggregate: ControlPlaneStatusLevel;
    readonly queueAggregate: ControlPlaneStatusLevel;
    readonly staleWorktreeCount: number;
    readonly duplicateClusterCount: number;
    readonly experimentBatchCount: number;
    readonly overall: ControlPlaneStatusLevel;
  };
  readonly stories: readonly GlobalControlStoryRow[];
  readonly runtimeClosure: RuntimeClosureReport;
  readonly queueGovernance: QueueGovernanceReport;
}

function rollup(statuses: readonly ControlPlaneStatusLevel[]): ControlPlaneStatusLevel {
  if (statuses.length === 0) return 'unknown';
  if (statuses.includes('red')) return 'red';
  if (statuses.some((status) => status === 'yellow' || status === 'unknown')) return 'yellow';
  if (statuses.every((status) => status === 'na')) return 'na';
  return 'green';
}

function consumptionStatusFor(summary: ReturnType<typeof projectAdmissibilityWaterline>['summary']): ControlPlaneStatusLevel {
  if (summary.error > 0 || summary.fail > 0) return 'red';
  if (summary.stale > 0 || summary.legacy > 0 || summary.warn > 0) return 'yellow';
  return 'green';
}

function queueStatusFor(classification: string): ControlPlaneStatusLevel {
  if (classification === 'cleanup-required' || classification === 'duplicate-candidate' || classification === 'superseded') return 'red';
  if (classification === 'stale-worktree' || classification === 'main-init') return 'yellow';
  return 'green';
}

export function buildGlobalControlStatus(
  store: StoryStore,
  root: string,
  options: GlobalControlStatusOptions = {},
): GlobalControlStatusReport {
  const now = options.now ?? new Date().toISOString();
  const runtime = projectRuntimeClosure(store, root, {
    storyIds: options.storyIds,
    now,
  });
  const queue = projectQueueGovernance(store, root, {
    expanded: options.expanded,
    now,
  });
  const queueByStory = new Map(queue.rows.map((row) => [row.storyId, row]));
  const storyRows = runtime.stories.map((runtimeRow): GlobalControlStoryRow => {
    const waterline = projectAdmissibilityWaterline(store, root, {
      storyId: runtimeRow.storyId,
      now,
    });
    const consumptionStatus = consumptionStatusFor(waterline.summary);
    const queueRow = queueByStory.get(runtimeRow.storyId);
    const queueStatus = queueStatusFor(queueRow?.classification ?? 'none');
    const story = (() => {
      try { return store.readStory(runtimeRow.storyId); } catch { return null; }
    })();
    return {
      storyId: runtimeRow.storyId,
      ...(story?.title ? { title: story.title } : {}),
      phase: runtimeRow.phase,
      runtime: {
        status: runtimeRow.status,
        reason: runtimeRow.blockingItems[0]?.reason ?? runtimeRow.advisoryItems[0]?.reason ?? 'runtime projection available',
        nextSafeAction: runtimeRow.nextSafeAction,
        blockerCount: runtimeRow.blockingItems.length,
        source: 'runtime-projection',
      },
      consumption: {
        status: consumptionStatus,
        reason: waterline.rows.flatMap((row) => row.topReasons)[0] ?? 'admissibility waterline has no blocking rows',
        blockerCount: waterline.summary.fail + waterline.summary.error,
        source: 'proof-projection',
      },
      readiness: {
        status: runtimeRow.status,
        reason: 'readiness is sourced from lifecycle_check rows inside runtime projection',
        blockerCount: runtimeRow.blockingItems.length,
        source: 'runtime-projection',
      },
      queue: {
        classification: queueRow?.classification ?? 'none',
        reason: queueRow?.reason,
        exceptionId: queueRow?.exceptionId,
        experimentBatchId: queueRow?.experimentBatchId,
        cleanupPolicy: queueRow?.cleanupPolicy,
      },
      authoritativeCwd: runtimeRow.authoritativeCwd,
      nextSafeAction: runtimeRow.nextSafeAction,
      readyForNextSafeAction: runtimeRow.status === 'green' &&
        consumptionStatus === 'green' &&
        (queueStatus === 'green'),
      source: {
        runtime: 'runtime-projection',
        consumption: 'proof-admissibility',
        queue: 'queue-governance',
      },
    };
  });

  const runtimeAggregate = runtime.aggregate;
  const consumptionAggregate = rollup(storyRows.map((row) => row.consumption.status));
  const queueAggregate = rollup(storyRows.map((row) => queueStatusFor(row.queue.classification)));
  const overall = rollup([runtimeAggregate, consumptionAggregate, queueAggregate]);
  const baseProject = buildProjectControlStatus({
    projectRoot: root,
    stories: storyRows.map((row) => buildStoryControlStatus({
      storyId: row.storyId,
      phase: row.phase,
      title: row.title,
      runtime: row.runtime,
      consumption: row.consumption,
      readiness: row.readiness,
      queue: row.queue,
    })),
    runtime: { status: runtimeAggregate, source: 'runtime-projection' },
    consumption: { status: consumptionAggregate, source: 'proof-projection' },
    readiness: {
      status: runtimeAggregate,
      reason: 'project readiness is rolled up from runtime readiness rows',
      source: 'runtime-projection',
    },
    queueSummary: {
      classification: queueAggregate === 'red' ? 'blocked' : queueAggregate === 'yellow' ? 'waiting-on-story' : 'ready',
      size: queue.rows.length,
    },
  });
  const project: GlobalControlStatusReport['project'] = {
    ...baseProject,
    runtimeAggregate,
    consumptionAggregate,
    queueAggregate,
    staleWorktreeCount: queue.summary.staleWorktree,
    duplicateClusterCount: queue.duplicateClusters.length,
    experimentBatchCount: queue.experimentBatches.length,
    overall,
  };

  return {
    schemaVersion: 'lattice.global_control_status.v1',
    readOnly: true,
    generatedAt: now,
    projectRoot: root,
    project,
    stories: storyRows,
    runtimeClosure: runtime,
    queueGovernance: queue,
  };
}

export function renderGlobalControlStatus(report: GlobalControlStatusReport): string {
  const lines = [
    `Project control status (${report.schemaVersion})`,
    `readOnly: ${report.readOnly}`,
    `projectRoot: ${report.projectRoot}`,
    `Runtime: ${report.project.runtimeAggregate}`,
    `Consumption: ${report.project.consumptionAggregate}`,
    `Queue: ${report.project.queueAggregate}`,
    `Overall: ${report.project.overall}`,
    `Experiment batches: ${report.project.experimentBatchCount}`,
    '',
    'Story rows',
  ];
  for (const row of report.stories) {
    lines.push(`  ${row.storyId} ${row.phase ?? ''} runtime=${row.runtime.status} consumption=${row.consumption.status} queue=${row.queue.classification}`);
    if (row.authoritativeCwd) lines.push(`    authoritative cwd: ${row.authoritativeCwd}`);
    if (row.nextSafeAction) lines.push(`    Next safe action: ${row.nextSafeAction}`);
    lines.push(`    Runtime: ${row.runtime.reason ?? 'ok'}`);
    lines.push(`    Consumption: ${row.consumption.reason ?? 'ok'}`);
    lines.push(`    Queue: ${row.queue.reason ?? 'ok'}`);
  }
  return lines.join('\n');
}
