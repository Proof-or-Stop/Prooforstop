import { ACCEPTANCE_REVIEW_FINAL_SCHEMA } from '../core/acceptance-amendment-review.js';
import { assertActiveIdentityConsumerContract } from '../core/active-identity-consumer-contract.js';
import type { AgentDispatchMutationCommand } from '../core/types.js';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { resolveAgentMutationAuthority } from '../core/agent-dispatch-registry.js';
import { getSessionIdentity } from '../core/owner-session.js';
import { readOwnerLease } from '../core/story-owner-lease.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { createAcceptanceAmendmentController } from '../core/acceptance-amendment-journal.js';
import type { AcceptanceAmendmentDelta } from '../core/acceptance-amendment.js';
import type { ManagedHostRunSubmitDeps } from '../core/managed-host-run.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';

export function createAcceptanceAmendmentHandlers(ctx: HandlerContext, reviewDeps: ManagedHostRunSubmitDeps = {}) {
  const controller = (storyId: string) => createAcceptanceAmendmentController(ctx.store,
    resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root }));
  const authorize = (command: AgentDispatchMutationCommand, args: { storyId: string }, fields: string[]) => {
    if (Object.keys(args).some(key => !fields.includes(key))) throw new Error('Acceptance amendment refuses unknown caller authority fields');
    resolveAgentMutationAuthority({ command });
    assertCwdInWorktree(ctx.store, args.storyId);
    if (ctx.store.readStory(args.storyId).phase !== 'DEV') throw new Error('Acceptance amendment mutations require DEV');
    const owner = readOwnerLease(ctx.store.storyDirPath(args.storyId));
    if (owner && owner.sessionId !== getSessionIdentity().sessionId) throw new Error('Acceptance amendment requires the Story owner session');
  };
  return {
    acceptance_amendment_propose(args: { storyId: string; amendmentId: string; delta: AcceptanceAmendmentDelta }) {
      authorize('acceptance_amendment_propose', args, ['storyId', 'amendmentId', 'delta']);
      let commitHint: string | undefined;
      const result = controller(args.storyId).propose({ ...args, submitterSessionId: getSessionIdentity().sessionId }, () => {
        commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'acceptance_amendment_propose', { exactStoryArtifactNames: ['acceptance-amendments.json'] });
      });
      return JSON.stringify({ ...result, ...(commitHint ? { commitHint } : {}) });
    },
    async acceptance_amendment_review(args: { storyId: string; amendmentId: string; host: 'codex' | 'claude' | 'grok' }) {
      assertActiveIdentityConsumerContract('acceptance-amendment-review', ACCEPTANCE_REVIEW_FINAL_SCHEMA);
      authorize('acceptance_amendment_review', args, ['storyId', 'amendmentId', 'host']);
      // Do not commit the key pin after capturing reviewer HEAD: its signed journal is already durable.
      return JSON.stringify(await controller(args.storyId).startReview(args, reviewDeps));
    },
    acceptance_amendment_approve(args: { storyId: string; amendmentId: string }) {
      assertActiveIdentityConsumerContract('acceptance-amendment-review', ACCEPTANCE_REVIEW_FINAL_SCHEMA);
      authorize('acceptance_amendment_approve', args, ['storyId', 'amendmentId']);
      let commitHint: string | undefined;
      const result = controller(args.storyId).approve(args, () => {
        commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'acceptance_amendment_approve', { exactStoryArtifactNames: ['acceptance-amendments.json', 'checklist.json', 'scope-contract.json', 'proofstory.json'] });
      });
      return JSON.stringify({ ...result, ...(commitHint ? { commitHint } : {}) });
    },
    acceptance_amendment_cancel(args: { storyId: string; amendmentId: string; reason: string }) {
      authorize('acceptance_amendment_cancel', args, ['storyId', 'amendmentId', 'reason']);
      let commitHint: string | undefined;
      const result = controller(args.storyId).cancel(args, () => {
        commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'acceptance_amendment_cancel', { exactStoryArtifactNames: ['acceptance-amendments.json'] });
      });
      return JSON.stringify({ ...result, ...(commitHint ? { commitHint } : {}) });
    },
    acceptance_amendment_show(args: { storyId: string }) { return JSON.stringify(controller(args.storyId).show(args.storyId)); },
  };
}
