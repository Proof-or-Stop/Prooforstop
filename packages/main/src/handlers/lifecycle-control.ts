import {
  buildGlobalControlStatus,
  renderGlobalControlStatus,
} from '../core/lifecycle-control/dashboard/index.js';
import {
  projectAdmissibilityWaterline,
  type AdmissibilityWaterlineOptions,
} from '../core/lifecycle-control/consumption/index.js';
import {
  projectQueueGovernance,
  setQueueException,
  type QueueExceptionSetInput,
} from '../core/lifecycle-control/queue/index.js';
import {
  projectRuntimeClosure,
  type RuntimeClosureOptions,
} from '../core/lifecycle-control/runtime/index.js';
import { withReentrantMainWriteLock } from '../core/main-write-lock.js';
import { resolveMainRepoRoot } from '../core/partial-done-recovery.js';
import type { HandlerContext } from './context.js';

type FormatArgs = { format?: 'text' | 'json'; json?: boolean };

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function renderRuntime(report: ReturnType<typeof projectRuntimeClosure>): string {
  const lines = [
    `Runtime closure (${report.schemaVersion})`,
    `readOnly: ${report.readOnly}`,
    `aggregate: ${report.aggregate}`,
  ];
  for (const row of report.stories) {
    lines.push(`  ${row.storyId} runtime=${row.status} authority=${row.authority} phase=${row.phase} mirror=${row.mirrorPhase ?? row.phase}`);
    lines.push(`    authoritative cwd: ${row.authoritativeCwd}`);
    if (row.nextSafeAction) lines.push(`    next: ${row.nextSafeAction}`);
    for (const issue of [...row.blockingItems, ...row.advisoryItems].slice(0, 5)) {
      lines.push(`    - ${issue.check}: ${issue.reason}`);
    }
  }
  return lines.join('\n');
}

function renderWaterline(report: ReturnType<typeof projectAdmissibilityWaterline>): string {
  const lines = [
    `Admissibility waterline (${report.schemaVersion})`,
    `readOnly: ${report.readOnly}`,
    `diagnosticOnly: ${report.diagnosticOnly}`,
    `storyId: ${report.storyId ?? '(project)'}`,
  ];
  for (const row of report.rows) {
    lines.push(`  ${row.consumer}: ${row.status} missing=${row.missingClauses.join(', ') || 'none'} reasons=${row.topReasons.join(', ') || 'none'}`);
  }
  lines.push(report.note);
  return lines.join('\n');
}

function renderQueue(report: ReturnType<typeof projectQueueGovernance>): string {
  const lines = [
    `Queue governance (${report.schemaVersion})`,
    `readOnly: ${report.readOnly}`,
    `defaultDashboardMode: ${report.defaultDashboardMode}`,
    `experimentBatches: ${report.experimentBatches.length}`,
  ];
  for (const batch of report.experimentBatches) {
    lines.push(`  experiment ${batch.experimentBatchId}: ${batch.storyCount} stories${batch.storyIds ? ` [${batch.storyIds.join(', ')}]` : ''}`);
  }
  for (const row of report.rows) {
    lines.push(`  ${row.storyId}: ${row.classification} ${row.reason}`);
  }
  return lines.join('\n');
}

function renderException(result: ReturnType<typeof setQueueException>): string {
  return [
    `queue_exception_set (${result.schemaVersion})`,
    `written: ${result.written}`,
    `exceptionId: ${result.exceptionId}`,
    `policyVersion: ${result.policyVersion}`,
    `class: ${result.class}`,
    `experimentBatchId: ${result.experimentBatchId}`,
    `storyFilesHash: ${result.storyFilesHash}`,
    `cleanupPolicy: ${result.cleanupPolicy}`,
  ].join('\n');
}

export function createLifecycleControlHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    global_control_status(args: ({ storyIds?: string[]; expanded?: boolean } & FormatArgs) = {}) {
      const report = buildGlobalControlStatus(ctx.store, ctx.root, {
        storyIds: args.storyIds,
        expanded: args.expanded,
      });
      return wantsJson(args) ? report : renderGlobalControlStatus(report);
    },

    runtime_closure_status(args: (RuntimeClosureOptions & FormatArgs) = {}) {
      const report = projectRuntimeClosure(ctx.store, ctx.root, args);
      return wantsJson(args) ? report : renderRuntime(report);
    },

    admissibility_waterline(args: (AdmissibilityWaterlineOptions & FormatArgs) = {}) {
      const report = projectAdmissibilityWaterline(ctx.store, ctx.root, args);
      return wantsJson(args) ? report : renderWaterline(report);
    },

    queue_governance_status(args: ({ expanded?: boolean } & FormatArgs) = {}) {
      const report = projectQueueGovernance(ctx.store, ctx.root, args);
      return wantsJson(args) ? report : renderQueue(report);
    },

    queue_exception_set(args: QueueExceptionSetInput & FormatArgs) {
      const mainRepoRoot = resolveMainRepoRoot(ctx.root);
      const result = withReentrantMainWriteLock(
        mainRepoRoot,
        () => setQueueException(mainRepoRoot, args),
        { label: 'queue_exception_set' },
      );
      return wantsJson(args) ? result : renderException(result);
    },
  };
}
