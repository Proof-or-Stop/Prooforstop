import { acceptanceCompletionBlocker } from '../core/acceptance-amendment-gates.js';
import { probeValidationCausalPreflightFacts } from './verifier.js';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import {
  renderDoneRequiredEvidence,
  resolveDoneRequiredPolicy,
  runDoneRequiredValidation,
} from '../core/done-required-validation.js';
import type { ValidationProgressReporter } from '../core/validation-types.js';
import { declaredValidationCapacity, withOfficialValidationExecution } from '../core/validation-execution-lock.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { formatValidationProgressEvent } from '../core/validation-executor.js';
import { evaluateDoneRequiredPreRunReuse } from '../core/done-prepare-validation-reuse.js';
import { timeoutLayerFromReason } from '../core/done-required-timeout-budget.js';
import { requireCurrentHeavyCertificationWindow } from '../core/certification-window.js';
import { currentCertificationIdentity } from './certification-window.js';

export function createDoneRequiredValidationHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    async done_required_validate(args: {
      storyId?: string;
      story?: string;
      json?: boolean;
      progress?: ValidationProgressReporter;
      heartbeatMs?: number;
      abortSignal?: AbortSignal;
      deadlineAt?: number;
      deadlineError?: () => Error;
    }) {
      const storyId = (args.storyId ?? args.story ?? '').trim();
      if (!storyId) throw new Error('done_required_validate requires --storyId=<id>');
      assertCwdInWorktree(ctx.store, storyId);
      const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
      const amendment = acceptanceCompletionBlocker(ctx.store, storyId, gitCwd);
      if (amendment) throw new Error(amendment);
      const policy = resolveDoneRequiredPolicy(ctx.root);
      if (policy.required) {
        requireCurrentHeavyCertificationWindow({
          store: ctx.store,
          storyId,
          current: currentCertificationIdentity(ctx, storyId),
        });
      }
      try {
        return await withOfficialValidationExecution({
        root: ctx.root,
        storyId,
        workspaceRoot: gitCwd,
        requireGitIdentity: true,
        command: 'done_required_validate',
        ...declaredValidationCapacity(policy.commands, gitCwd),
        sharedExecution: {storyId,receiptStore:ctx.store,probe:input=>probeValidationCausalPreflightFacts(ctx,storyId,input)},
        ownerLeaseDir: ctx.store.storyDirPath(storyId),
        abortSignal: args.abortSignal,
        deadlineAt: args.deadlineAt,
        deadlineError: args.deadlineError,
        onWaitProgress: (message) => ctx.log?.(message),
      }, async () => {

      const policy = resolveDoneRequiredPolicy(ctx.root);
      if (!policy.required) {
        const result = {
          provider: 'proof-or-stop-done-required-validation',
          status: 'warn',
          allPass: true,
          storyId,
          summary: 'No doneRequiredCommands policy configured; DONE-required validation is advisory only',
          warnings: policy.warnings,
          timestamp: new Date().toISOString(),
          disposition: 'skipped_explicitly',
          result: 'not_run',
          refusalReasons: [],
          timeoutLayer: null,
          existingEvidenceBasis: 'missing',
        };
        return args.json ? JSON.stringify(result) : [
          result.summary,
          ...policy.warnings,
          'disposition=skipped_explicitly result=not_run refusalReasons=none timeoutLayer=null existingEvidenceBasis=missing',
        ].join('\n');
      }

      const prior = evaluateDoneRequiredPreRunReuse({ root: ctx.root, gitCwd, storyId, store: ctx.store });
      let evidence;
      try {
        evidence = await runDoneRequiredValidation({
          projectRoot: ctx.root,
          storyId,
          store: ctx.store,
          gitCwd,
          options: {
            progress: args.progress ?? ((event) => {
              ctx.log?.(formatValidationProgressEvent(event));
            }),
            heartbeatMs: args.heartbeatMs,
            abortSignal: args.abortSignal,
            deadlineAt: args.deadlineAt,
            deadlineError: args.deadlineError,
          },
        });
      } catch (error) {
        const timeoutLayer = timeoutLayerFromReason(args.abortSignal?.reason) ?? timeoutLayerFromReason(error);
        const terminal = {
          provider: 'proof-or-stop-done-required-validation',
          status: 'fail',
          allPass: false,
          storyId,
          disposition: 'executed',
          result: timeoutLayer ? 'timed_out' : 'blocked',
          refusalReasons: [error instanceof Error ? error.message : String(error)],
          timeoutLayer,
          existingEvidenceBasis: prior.existingEvidenceBasis,
        };
        return args.json ? JSON.stringify(terminal) : [
          'DONE-required validation: FAIL',
          `disposition=${terminal.disposition} result=${terminal.result} refusalReasons=${terminal.refusalReasons.join(',')} timeoutLayer=${terminal.timeoutLayer ?? 'null'} existingEvidenceBasis=${terminal.existingEvidenceBasis}`,
        ].join('\n');
      }
      autoCommitStoryMetadata(ctx.root, storyId, 'done_required_validate', {
        closeoutArtifactPaths: ['done-required-evidence.json'],
      });
      const timedOut = evidence.receipts.some((receipt) => receipt.timedOut === true);
      const timeoutLayer = timedOut
        ? (timeoutLayerFromReason(args.abortSignal?.reason) ?? 'command')
        : null;
      const structuredResult = timedOut ? 'timed_out' : evidence.status === 'PASS' ? 'pass' : 'failed';
      if (args.json) return JSON.stringify({
        ...evidence,
        disposition: 'executed',
        result: structuredResult,
        refusalReasons: evidence.reasons,
        timeoutLayer,
        existingEvidenceBasis: prior.existingEvidenceBasis,
      });
      return [
        renderDoneRequiredEvidence(evidence),
        `disposition=executed result=${structuredResult} refusalReasons=${evidence.reasons.join(',') || 'none'} timeoutLayer=${timeoutLayer ?? 'null'} existingEvidenceBasis=${prior.existingEvidenceBasis}`,
      ].join('\n');
        });
      } catch (error) {
        const timeoutLayer = timeoutLayerFromReason(args.abortSignal?.reason) ?? timeoutLayerFromReason(error);
        let existingEvidenceBasis = 'missing';
        try {
          existingEvidenceBasis = evaluateDoneRequiredPreRunReuse({
            root: ctx.root,
            gitCwd,
            storyId,
            store: ctx.store,
          }).existingEvidenceBasis;
        } catch {
          /* Capacity errors remain reportable even when prior evidence is unreadable. */
        }
        const terminal = {
          provider: 'proof-or-stop-done-required-validation',
          status: 'fail',
          allPass: false,
          storyId,
          disposition: 'executed',
          result: timeoutLayer ? 'timed_out' : 'blocked',
          refusalReasons: [error instanceof Error ? error.message : String(error)],
          timeoutLayer,
          existingEvidenceBasis,
        };
        return args.json ? JSON.stringify(terminal) : [
          'DONE-required validation: FAIL',
          `disposition=${terminal.disposition} result=${terminal.result} refusalReasons=${terminal.refusalReasons.join(',')} timeoutLayer=${terminal.timeoutLayer ?? 'null'} existingEvidenceBasis=${terminal.existingEvidenceBasis}`,
        ].join('\n');
      }
    },
  };
}
