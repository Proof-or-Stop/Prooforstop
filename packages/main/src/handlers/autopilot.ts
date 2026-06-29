import type { HandlerContext } from './context.js';
import {
  buildAutopilotRun,
  buildAutopilotStatus,
  type AutopilotArgs,
  type AutopilotRunResult,
  type AutopilotStatusResult,
} from '../core/autopilot.js';
import {
  executeAutopilot,
  type AutopilotExecuteArgs,
  type AutopilotExecuteResult,
} from '../core/autopilot-executor.js';

function wantsJson(args: { format?: string; json?: boolean } | undefined): boolean {
  return args?.format === 'json' || args?.json === true;
}

function renderRun(result: AutopilotRunResult): string {
  const lines = [
    `Proofbound autopilot run (${result.schemaVersion})`,
    `status: ${result.status}`,
    `mode: ${result.mode}`,
    `targetPhase: ${result.targetPhase}`,
    `dryRun: ${result.dryRun}`,
    `localWorkflowUsable: ${result.localWorkflowUsable}`,
    `localReviewCertified: ${result.localReviewCertified}`,
    `authorityDone: ${result.authorityDone}`,
    `fullAuthorityDone: ${result.fullAuthorityDone}`,
    `multiHostVerified: ${result.multiHostVerified}`,
    `requireMultiHost: ${result.multiHostPolicy.requireMultiHost}`,
    `requiredHostVerdictCount: ${result.multiHostPolicy.requiredHostVerdictCount}`,
    `maxReviewWaves: ${result.multiHostPolicy.maxReviewWaves}`,
    `authorityRequired: ${result.authorityRequired}`,
    `receiptRequired: ${result.receiptRequired}`,
    `receiptVerified: ${result.receipt.verified}`,
    `story: ${result.story.storyId ?? 'unbound'}${result.story.phase ? ` phase=${result.story.phase}` : ''}`,
    '',
    'plannedSteps:',
    ...result.plannedSteps.map(step => `  - ${step.id}: ${step.command}`),
  ];
  if (result.executedSteps.length > 0) {
    lines.push('', 'executedSteps:', ...result.executedSteps.map(step => `  - ${step.id}: ${step.command}`));
  }
  if (result.authority.readinessWarnings.length > 0) {
    lines.push('', 'readinessWarnings:', ...result.authority.readinessWarnings.map(warning => `  - ${warning}`));
  }
  if (result.nextActions.length > 0) {
    lines.push('', 'nextActions:', ...result.nextActions.map(action => `  - ${action}`));
  }
  lines.push('', result.note);
  return lines.join('\n');
}

function renderStatus(result: AutopilotStatusResult): string {
  return [
    `Proofbound autopilot status (${result.schemaVersion})`,
    `localAvailable: ${result.localAvailable}`,
    `defaultMode: ${result.defaultMode}`,
    `modes: ${result.modes.join(', ')}`,
    `authorityModeEnv: ${result.authorityModeEnv}`,
    `authorityReady: ${result.authorityReady}`,
    `localReviewCertified: ${result.localReviewCertified}`,
    `authorityDone: ${result.authorityDone}`,
    `fullAuthorityDone: ${result.fullAuthorityDone}`,
    `multiHostVerified: ${result.multiHostVerified}`,
    `requireMultiHost: ${result.multiHostPolicy.requireMultiHost}`,
    `requiredHostVerdictCount: ${result.multiHostPolicy.requiredHostVerdictCount}`,
    `maxReviewWaves: ${result.multiHostPolicy.maxReviewWaves}`,
    `receiptVerified: ${result.receiptVerified}`,
    `productionDone: ${result.productionDone}`,
    '',
    'nextActions:',
    ...result.nextActions.map(action => `  - ${action}`),
  ].join('\n');
}

function renderExecute(result: AutopilotExecuteResult): string {
  const lines = [
    `Proofbound autopilot execute (${result.schemaVersion})`,
    `status: ${result.status}`,
    `mode: ${result.mode}`,
    `targetPhase: ${result.targetPhase}`,
    `dryRun: ${result.dryRun}`,
    `stopReason: ${result.stopReason}`,
    `maxSteps: ${result.maxSteps}`,
    `maxReviewWaves: ${result.maxReviewWaves}`,
    `localWorkflowUsable: ${result.localWorkflowUsable}`,
    `localReviewCertified: ${result.localReviewCertified}`,
    `authorityDone: ${result.authorityDone}`,
    `fullAuthorityDone: ${result.fullAuthorityDone}`,
    `multiHostVerified: ${result.multiHostVerified}`,
    `multiHostRequired: ${result.multiHostRequired}`,
    `requiredHostVerdictCount: ${result.requiredHostVerdictCount}`,
    `authorityRequired: ${result.authorityRequired}`,
    `receiptRequired: ${result.receiptRequired}`,
    `receiptVerified: ${result.receipt.verified}`,
    `story: ${result.story.storyId ?? 'unbound'}${result.story.phase ? ` phase=${result.story.phase}` : ''}`,
    `claudeRepair: ${result.repair.enabled ? `enabled command=${result.repair.command}` : 'disabled'}`,
    '',
    'plannedSteps:',
    ...result.plannedSteps.map(step => `  - ${step.id}: ${step.command}`),
  ];
  if (result.executedSteps.length > 0) {
    lines.push(
      '',
      'executedSteps:',
      ...result.executedSteps.map(step => `  - ${step.id}: ${step.status}${step.exitCode === null ? '' : ` exit=${step.exitCode}`} ${step.command}`),
    );
  }
  if (result.repair.attempts.length > 0) {
    lines.push('', 'repairAttempts:', ...result.repair.attempts.map(attempt => `  - ${attempt.stepId}: ${attempt.status} exit=${attempt.exitCode}`));
  }
  if (result.authority.readinessWarnings.length > 0) {
    lines.push('', 'readinessWarnings:', ...result.authority.readinessWarnings.map(warning => `  - ${warning}`));
  }
  if (result.nextActions.length > 0) {
    lines.push('', 'nextActions:', ...result.nextActions.map(action => `  - ${action}`));
  }
  lines.push('', result.note);
  return lines.join('\n');
}

export function createAutopilotHandlers(ctx: HandlerContext) {
  return {
    autopilot_run(args: AutopilotArgs & { format?: 'text' | 'json'; json?: boolean } = {}) {
      const result = buildAutopilotRun(ctx.store, args, process.env, { cwd: ctx.root });
      if (result.dryRun === false && args.storyId) {
        try {
          ctx.store.appendProcessEvent(args.storyId, {
            type: 'autopilot_projection',
            storyId: args.storyId,
            mode: result.mode,
            status: result.status,
            targetPhase: result.targetPhase,
            authorityRequired: result.authorityRequired,
            receiptRequired: result.receiptRequired,
            receiptVerified: result.receipt.verified,
            localReviewCertified: result.localReviewCertified,
            authorityDone: result.authorityDone,
            fullAuthorityDone: result.fullAuthorityDone,
            multiHostVerified: result.multiHostVerified,
            requireMultiHost: result.multiHostPolicy.requireMultiHost,
            requiredHostVerdictCount: result.multiHostPolicy.requiredHostVerdictCount,
            maxReviewWaves: result.multiHostPolicy.maxReviewWaves,
            receiptId: result.receipt.receiptId,
            receiptSubjectId: result.receipt.subjectId,
            receiptSubjectKind: result.receipt.subjectKind,
            receiptExpectedSubjectId: result.receipt.expectedSubjectId,
            receiptExpectedSubjectKind: result.receipt.expectedSubjectKind,
            authorityActorId: result.receipt.authorityActorId,
            plannedSteps: result.plannedSteps.map(step => step.id),
            executedSteps: result.executedSteps.map(step => step.id),
          });
        } catch (error: any) {
          ctx.log?.(`[process-events] autopilot projection append failed: ${error?.message || error}`);
        }
      }
      return wantsJson(args) ? result : renderRun(result);
    },

    autopilot_status(args: { format?: 'text' | 'json'; json?: boolean } = {}) {
      const result = buildAutopilotStatus(process.env, { cwd: ctx.root });
      return wantsJson(args) ? result : renderStatus(result);
    },

    autopilot_execute(args: AutopilotExecuteArgs & { format?: 'text' | 'json'; json?: boolean } = {}) {
      const finish = (result: AutopilotExecuteResult) => {
        if (result.dryRun === false && args.storyId) {
          try {
            ctx.store.appendProcessEvent(args.storyId, {
              type: 'autopilot_execution',
              storyId: args.storyId,
              mode: result.mode,
              status: result.status,
              targetPhase: result.targetPhase,
              stopReason: result.stopReason,
              maxSteps: result.maxSteps,
              maxReviewWaves: result.maxReviewWaves,
              authorityRequired: result.authorityRequired,
              receiptRequired: result.receiptRequired,
              receiptVerified: result.receipt.verified,
              localReviewCertified: result.localReviewCertified,
              authorityDone: result.authorityDone,
              fullAuthorityDone: result.fullAuthorityDone,
              multiHostVerified: result.multiHostVerified,
              multiHostRequired: result.multiHostRequired,
              requiredHostVerdictCount: result.requiredHostVerdictCount,
              receiptId: result.receipt.receiptId,
              receiptSubjectId: result.receipt.subjectId,
              receiptSubjectKind: result.receipt.subjectKind,
              receiptExpectedSubjectId: result.receipt.expectedSubjectId,
              receiptExpectedSubjectKind: result.receipt.expectedSubjectKind,
              authorityActorId: result.receipt.authorityActorId,
              claudeRepairEnabled: result.repair.enabled,
              repairAttempts: result.repair.attempts.length,
              plannedSteps: result.plannedSteps.map(step => step.id),
              executedSteps: result.executedSteps.map(step => ({
                id: step.id,
                status: step.status,
                exitCode: step.exitCode,
              })),
            });
          } catch (error: any) {
            ctx.log?.(`[process-events] autopilot execution append failed: ${error?.message || error}`);
          }
        }
        return wantsJson(args) ? result : renderExecute(result);
      };

      return finish(executeAutopilot({
        store: ctx.store,
        root: ctx.root,
        args,
        runner: ctx.autopilotCommandRunner,
      }));
    },

    autopilot_doctor(args: { format?: 'text' | 'json'; json?: boolean } = {}) {
      const status = buildAutopilotStatus(process.env, { cwd: ctx.root });
      const local = buildAutopilotRun(ctx.store, { mode: 'local', dryRun: true }, process.env, { cwd: ctx.root });
      const result = {
        schemaVersion: 'lattice.autopilot_doctor.v1' as const,
        ok: local.status !== 'fail',
        local,
        status,
        note: 'Doctor confirms local autopilot stays available; server Authority modes are retired from active runtime.',
      };
      if (wantsJson(args)) return result;
      return [
        `Proofbound autopilot doctor (${result.schemaVersion})`,
        `ok: ${result.ok}`,
        `localStatus: ${local.status}`,
        `authorityReady: ${status.authorityReady}`,
        '',
        result.note,
      ].join('\n');
    },
  };
}
