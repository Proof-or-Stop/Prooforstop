import { execFileSync } from 'node:child_process';
import type { HandlerContext } from './context.js';
import {
  DEFAULT_RELEASE_PUSH_TTL_SECONDS,
  MAX_RELEASE_PUSH_TTL_SECONDS,
  RELEASE_PUSH_APPROVAL_REL_PATH,
  writeReleasePushApproval,
} from '../core/release-push-approval.js';
import { resolveRepositoryBaseline } from '../core/git-baseline.js';
import { localIntegrationBranchNameForRef } from '../core/story-integration-target.js';

interface ReleaseApprovePushArgs {
  confirm?: boolean;
  sha?: string;
  ttlSeconds?: number;
  remote?: string;
  reason?: string;
  approvedBy?: string;
  format?: 'text' | 'json';
  json?: boolean;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error: any) {
    const details = String(error?.stderr || error?.stdout || error?.message || error).trim();
    throw new Error(`git ${args.join(' ')} failed${details ? `: ${details}` : ''}`);
  }
}

function wantsJson(args: ReleaseApprovePushArgs): boolean {
  return args.json === true || args.format === 'json';
}

export function createReleaseHandlers(ctx: HandlerContext) {
  return {
    release_approve_push(args: ReleaseApprovePushArgs = {}) {
      if (args.confirm !== true) {
        throw new Error(
          'release_approve_push requires --confirm. This creates a short-lived local approval for one integration-branch push; it never pushes by itself.',
        );
      }
      const branch = git(ctx.root, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const baseline = resolveRepositoryBaseline(ctx.root);
      const integrationBranch = baseline
        ? localIntegrationBranchNameForRef(baseline.ref)
        : undefined;
      if (!integrationBranch || branch !== integrationBranch) {
        throw new Error(`release_approve_push must run from local integration branch ${integrationBranch || '(unresolved)'}, but current branch is ${branch}`);
      }
      const dirty = git(ctx.root, ['status', '--porcelain']);
      if (dirty) {
        throw new Error(
          `release_approve_push requires a clean local ${integrationBranch} before remote publish approval:\n${dirty}`,
        );
      }

      const expectedSha = git(ctx.root, ['rev-parse', args.sha || 'HEAD']);
      const approval = writeReleasePushApproval({
        root: ctx.root,
        sha: expectedSha,
        branch: integrationBranch,
        remote: args.remote || 'origin',
        ttlSeconds: args.ttlSeconds || DEFAULT_RELEASE_PUSH_TTL_SECONDS,
        approvedBy: args.approvedBy,
        reason: args.reason,
      });

      if (wantsJson(args)) {
        return {
          status: 'approved-local-only',
          approvalFile: RELEASE_PUSH_APPROVAL_REL_PATH,
          approval,
          nextAction: `git push ${approval.remote} ${integrationBranch}`,
          note: 'No remote write was performed. The pre-push hook will consume this one-shot approval.',
        };
      }

      return [
        '✓ Local one-shot remote publish approval created',
        `  file: ${RELEASE_PUSH_APPROVAL_REL_PATH}`,
        `  branch: ${approval.branch}`,
        `  remote: ${approval.remote}`,
        `  sha: ${approval.sha}`,
        `  expiresAt: ${approval.expiresAt}`,
        `  ttlSeconds: ${approval.ttlSeconds} (max ${MAX_RELEASE_PUSH_TTL_SECONDS})`,
        '',
        'No remote write was performed.',
        `Next action, only if the human still wants to publish: git push ${approval.remote} ${integrationBranch}`,
      ].join('\n');
    },
  };
}
