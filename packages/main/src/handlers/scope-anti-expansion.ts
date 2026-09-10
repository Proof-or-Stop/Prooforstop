import { rethrowIntentAmendmentIntegrityError } from '../core/verification-intent-amendment.js';
import type { HandlerContext } from './context.js';
import {
  buildExecutionBoundary,
  buildScopeBoundary,
  buildScopeExtensionDecision,
  buildScopeExtensionProposal,
  digestScopeExtensionProposal,
  digestScopeFreezeCheck,
  evaluateScopeFreeze,
  normalizeBoundaryArray,
} from '../core/scope-anti-expansion.js';
import type {
  ScopeBoundaryMode,
  ScopeExtensionDecisionValue,
  ScopeExtensionPatch,
  ScopeExtensionProposal,
  ScopeFreezeCheckData,
} from '../core/types.js';
import { readBrandEnv } from '../core/brand-env.js';

type ScopeBoundarySetArgs = {
  storyId: string;
  mode?: ScopeBoundaryMode;
  allowedScope: string[];
  excludedScope?: string[];
  userConfirmed?: boolean;
  confirmation?: string;
  actor?: string;
};

type ExecutionBoundarySetArgs = {
  storyId: string;
  allowedCommands?: string[];
  blockedCommands?: string[];
  excludedCommands?: string[];
  allowedTools?: string[];
  excludedTools?: string[];
  allowedPaths?: string[];
  blockedPaths?: string[];
  excludedPaths?: string[];
  notes?: string;
  actor?: string;
};

type ScopeFreezeCheckArgs = {
  storyId: string;
  status?: 'PASS' | 'FAIL' | 'pass' | 'fail';
  note?: string;
  repeatDiscardMitigation?: string;
  actor?: string;
};

type ScopeExtensionProposalArgs = {
  storyId: string;
  proposal: string;
  reason?: string;
  reviewer?: string;
  findingId?: string;
  evidenceRefs?: string[];
};

type ScopeExtensionDecideArgs = {
  storyId: string;
  proposalId: string;
  decision: 'accepted' | 'rejected';
  reason: string;
  decider?: string;
};

function actorFrom(value: string | undefined): string {
  const explicit = value?.trim();
  if (explicit) return explicit;
  return readBrandEnv('AGENT') || process.env.USER || 'main-agent';
}

function ensureInitStory(ctx: HandlerContext, storyId: string, command: string): void {
  if (!storyId) throw new Error('storyId is required');
  const story = ctx.store.readStory(storyId);
  if (story.phase !== 'INIT') {
    throw new Error(`${command} is INIT-only; story ${storyId} is currently ${story.phase}`);
  }
}

function requireUserConfirmation(args: ScopeBoundarySetArgs): void {
  if (args.userConfirmed !== true) {
    throw new Error('userConfirmed must be true before the INIT scope boundary can be saved');
  }
}

function statusLabel(status: string): 'PASS' | 'FAIL' {
  return status === 'pass' ? 'PASS' : 'FAIL';
}

function expectedStatus(value: ScopeFreezeCheckArgs['status']): 'pass' | 'fail' | null {
  if (!value) return null;
  return value.toLowerCase() === 'pass' ? 'pass' : 'fail';
}

function projectStory(ctx: HandlerContext, storyId: string) {
  const story = ctx.store.readStory(storyId);
  return {
    title: story.title,
    description: story.description,
    background: ctx.store.readStoryBackground(storyId) ?? undefined,
  };
}

function projectChecklist(ctx: HandlerContext, storyId: string) {
  try {
    return ctx.store.readChecklist(storyId).items.map((item) => ({
      id: item.id,
      title: item.title,
      ...(item.context ? { context: item.context } : {}),
      ...(item.excludes ? { excludes: [...item.excludes] } : {}),
    }));
  } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
    return [];
  }
}

function makeProposalId(storyId: string, existingCount: number): string {
  return `SEP-${storyId}-${String(existingCount + 1).padStart(3, '0')}`;
}

function typedProposalPatch(): ScopeExtensionPatch {
  // A proposal is an audit route, not scope acceptance. The explicit decision
  // command records approve/reject, and a fresh scope_freeze_check must follow
  // before INIT_CHECK can consume any changed boundary.
  return {};
}

function mapDecision(decision: ScopeExtensionDecideArgs['decision']): ScopeExtensionDecisionValue {
  return decision === 'accepted' ? 'approved' : 'rejected';
}

function outputDecision(decision: ScopeExtensionDecideArgs['decision']): 'accepted' | 'rejected' {
  return decision;
}

function invalidateFreezeCheckAfterAcceptedDecision(
  check: ScopeFreezeCheckData | null,
  decisionHash: string,
): ScopeFreezeCheckData | null {
  if (!check) return null;
  const staleCheck: ScopeFreezeCheckData = {
    ...check,
    freshnessHash: `${check.freshnessHash}:accepted-scope-extension:${decisionHash}`,
    _hash: '',
  };
  return { ...staleCheck, _hash: digestScopeFreezeCheck(staleCheck) };
}

function updateProposalWithDecision(
  proposal: ScopeExtensionProposal,
  decision: ScopeExtensionDecisionValue,
  decisionArgs: ScopeExtensionDecideArgs,
): ScopeExtensionProposal {
  const decided = buildScopeExtensionDecision({
    proposalId: proposal.proposalId,
    decision,
    decidedBy: actorFrom(decisionArgs.decider),
    rationale: decisionArgs.reason,
  });
  const updated: ScopeExtensionProposal = {
    ...proposal,
    status: decision,
    decision: decided,
    _hash: '',
  };
  return { ...updated, _hash: digestScopeExtensionProposal(updated) };
}

export function createScopeAntiExpansionHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    scope_boundary_set(args: ScopeBoundarySetArgs): string {
      ensureInitStory(ctx, args.storyId, 'scope_boundary_set');
      requireUserConfirmation(args);

      const boundary = buildScopeBoundary({
        storyId: args.storyId,
        mode: args.mode ?? 'custom',
        allowed: args.allowedScope,
        excluded: args.excludedScope,
        confirmedBy: actorFrom(args.actor),
        confirmationNote: args.confirmation,
      });
      ctx.store.writeScopeBoundary(args.storyId, boundary);

      return `Scope boundary saved for ${args.storyId}: ${boundary.allowed.length} allowed, ${boundary.excluded.length} excluded (_hash ${boundary._hash})`;
    },

    execution_boundary_set(args: ExecutionBoundarySetArgs): string {
      ensureInitStory(ctx, args.storyId, 'execution_boundary_set');

      const boundary = buildExecutionBoundary({
        storyId: args.storyId,
        allowedCommands: args.allowedCommands,
        allowedTools: args.allowedTools,
        allowedPaths: args.allowedPaths,
        excludedCommands: [...normalizeBoundaryArray(args.blockedCommands), ...normalizeBoundaryArray(args.excludedCommands)],
        excludedTools: args.excludedTools,
        excludedPaths: [...normalizeBoundaryArray(args.blockedPaths), ...normalizeBoundaryArray(args.excludedPaths)],
        confirmedBy: actorFrom(args.actor),
        confirmationNote: args.notes,
      });
      ctx.store.writeExecutionBoundary(args.storyId, boundary);

      return `Execution boundary saved for ${args.storyId}: ${boundary.allowedCommands.length} allowed commands, ${boundary.excludedCommands.length} excluded commands, ${boundary.allowedPaths?.length ?? 0} allowed paths, ${boundary.excludedPaths?.length ?? 0} excluded paths (_hash ${boundary._hash})`;
    },

    scope_freeze_check(args: ScopeFreezeCheckArgs): string {
      ensureInitStory(ctx, args.storyId, 'scope_freeze_check');

      const result = evaluateScopeFreeze({
        storyId: args.storyId,
        scopeBoundary: ctx.store.readScopeBoundary(args.storyId),
        executionBoundary: ctx.store.readExecutionBoundary(args.storyId),
        story: projectStory(ctx, args.storyId),
        checklist: projectChecklist(ctx, args.storyId),
        discardDigest: ctx.store.readScopeDiscardDigestForFreeze(args.storyId),
        repeatDiscardMitigation: args.repeatDiscardMitigation ?? args.note,
      });

      const requestedStatus = expectedStatus(args.status);
      if (requestedStatus && requestedStatus !== result.check.status) {
        throw new Error(`scope_freeze_check status override refused: core evaluated ${result.check.status}, requested ${requestedStatus}`);
      }

      if (result.normalizedScopeBoundary) ctx.store.writeScopeBoundary(args.storyId, result.normalizedScopeBoundary);
      if (result.normalizedExecutionBoundary) ctx.store.writeExecutionBoundary(args.storyId, result.normalizedExecutionBoundary);
      ctx.store.writeScopeFreezeCheck(args.storyId, result.check);

      return `Scope freeze check saved for ${args.storyId}: ${statusLabel(result.check.status)}`;
    },

    scope_extension_proposal(args: ScopeExtensionProposalArgs): string {
      ensureInitStory(ctx, args.storyId, 'scope_extension_proposal');

      const existing = ctx.store.readScopeExtensionProposals(args.storyId);
      const proposal = buildScopeExtensionProposal({
        proposalId: makeProposalId(args.storyId, existing.proposals.length),
        storyId: args.storyId,
        proposedBy: actorFrom(args.reviewer),
        proposal: args.proposal,
        reason: args.reason?.trim() || 'Reviewer proposed scope extension.',
        patch: typedProposalPatch(),
      });
      ctx.store.writeScopeExtensionProposals(args.storyId, {
        storyId: args.storyId,
        updatedAt: proposal.proposedAt,
        proposals: [...existing.proposals, proposal],
      });

      return `Scope extension proposal saved for ${args.storyId}: pending (${proposal.proposalId})`;
    },

    scope_extension_decide(args: ScopeExtensionDecideArgs): string {
      ensureInitStory(ctx, args.storyId, 'scope_extension_decide');
      if (args.reason.trim().length < 10) throw new Error('reason must be at least 10 characters');

      const existing = ctx.store.readScopeExtensionProposals(args.storyId);
      const decision = mapDecision(args.decision);
      const proposal = existing.proposals.find((entry) => entry.proposalId === args.proposalId);
      if (!proposal) throw new Error(`scope extension proposal not found: ${args.proposalId}`);
      if (proposal.status !== 'pending') throw new Error(`scope extension proposal ${args.proposalId} is already ${proposal.status}`);

      const updatedProposal = updateProposalWithDecision(proposal, decision, args);
      const updatedAt = updatedProposal.decision?.decidedAt ?? new Date().toISOString();
      ctx.store.writeScopeExtensionProposals(args.storyId, {
        storyId: args.storyId,
        updatedAt,
        proposals: existing.proposals.map((entry) => entry.proposalId === args.proposalId ? updatedProposal : entry),
      });

      if (decision === 'approved') {
        const staleCheck = invalidateFreezeCheckAfterAcceptedDecision(
          ctx.store.readScopeFreezeCheck(args.storyId),
          updatedProposal.decision?._hash ?? updatedProposal._hash,
        );
        if (staleCheck) ctx.store.writeScopeFreezeCheck(args.storyId, staleCheck);
      }

      return `Scope extension decision saved for ${args.storyId}: ${outputDecision(args.decision)} (${updatedProposal.decision?._hash ?? updatedProposal._hash})`;
    },
  };
}
