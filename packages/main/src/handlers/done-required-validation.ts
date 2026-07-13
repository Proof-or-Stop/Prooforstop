import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import {
  renderDoneRequiredEvidence,
  resolveDoneRequiredPolicy,
  runDoneRequiredValidation,
} from '../core/done-required-validation.js';
import type { ValidationProgressReporter } from '../core/validation-types.js';
import { withValidationExecutionLock } from '../core/validation-execution-lock.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';

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

      const policy = resolveDoneRequiredPolicy(ctx.root);
      if (!policy.required) {
        const result = {
          provider: 'lattice-done-required-validation',
          status: 'warn',
          allPass: true,
          storyId,
          summary: 'No doneRequiredCommands policy configured; DONE-required validation is advisory only',
          warnings: policy.warnings,
          timestamp: new Date().toISOString(),
        };
        return args.json ? JSON.stringify(result) : `${result.summary}\n${policy.warnings.join('\n')}`;
      }

      const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
      const evidence = await withValidationExecutionLock({
        root: ctx.root,
        storyId,
        workspaceRoot: gitCwd,
        command: 'done_required_validate',
      }, () => runDoneRequiredValidation({
        projectRoot: ctx.root,
        storyId,
        store: ctx.store,
        gitCwd,
        options: {
          progress: args.progress,
          heartbeatMs: args.heartbeatMs,
          abortSignal: args.abortSignal,
          deadlineAt: args.deadlineAt,
          deadlineError: args.deadlineError,
        },
      }));
      autoCommitStoryMetadata(ctx.root, storyId, 'done_required_validate', {
        closeoutArtifactPaths: ['done-required-evidence.json'],
      });
      if (args.json) return JSON.stringify(evidence);
      return renderDoneRequiredEvidence(evidence);
    },
  };
}
