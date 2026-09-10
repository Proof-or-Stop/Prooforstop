import { rethrowIntentAmendmentIntegrityError } from '../core/verification-intent-amendment.js';
/**
 * B-7813 CHK-002: stall_resolution_set — persist a signed, current-round-bound
 * stall-adjudication.json for compatibility diagnosis. It does not clear the
 * completed-epoch gate; human continuation uses story_resume.
 *
 * The five structured actions (single source: STALL_RESOLUTION_ACTIONS in
 * core/review-convergence.ts) are:
 *   authorize_continuation | replan | escalate_root_cause | resolve_findings | declare_unreachable
 *
 * For action=declare_unreachable the handler ALSO marks the named checklist item
 * withdrawn via the B-1909 withdrawn-disposition path (scope_shrinkage_decision_set
 * — the sole authorized applier of status='withdrawn'), reconciling the
 * plan/claim (F-059: a milestone whose checklistRef points at a withdrawn item
 * is treated as terminal downstream), so declaring it CLOSES the loop for that
 * item without another ordinary round.
 *
 * Re-validation contract (CLAUDE.md "Handler encoding convention"): this handler
 * re-validates the action enum + reason min length + declare_unreachable⇒itemId
 * at runtime (validateStallResolutionInput) even though the CLI Zod schema
 * already checks them; the gate (core/review-convergence.ts
 * hasCurrentRoundStallResolution → isValidCurrentRoundStallResolution)
 * independently re-validates on read. Neither path trusts the other.
 */
import type { HandlerContext } from './context.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { withMkdirLock } from '../core/mkdir-lock.js';
import { createProofStoryHandlers } from './proofstory.js';
import {
  signStallAdjudication,
  validateStallResolutionInput,
} from '../core/stall-adjudication.js';
import { PRIVILEGED_OVERRIDE_ACTION } from '../core/review-convergence.js';
import { StoryStore } from '../core/store.js';
import type { StallAdjudicationData } from '../core/types.js';

export function createStallAdjudicationHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;
  return {
    stall_resolution_set(args: {
      storyId: string;
      action: string;
      reason: string;
      itemId?: string;
      approvedBy?: string;
      actor?: string;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');

      // 1) Runtime re-validation at the handler entry (mirrors + reinforces Zod;
      //    a direct-fn / bypassed-Zod call is rejected identically).
      const normalized = validateStallResolutionInput(args);

      // 2) Story existence + current-round binding. The resolution binds to the
      //    round the story most recently entered REVIEW under (story.currentReviewRound),
      //    which is exactly the "current stalled round" at the DEV→REVIEW mint site.
      let reviewRound = '';
      try {
        const story = store.readStory(args.storyId);
        reviewRound = story.currentReviewRound || '';
      } catch {
        throw new Error(`Story ${args.storyId} not found`);
      }
      if (!reviewRound) {
        throw new Error(
          `stall_resolution_set: story ${args.storyId} has no currentReviewRound to bind the resolution to. ` +
          'A stall resolution can only be recorded against an active review round (the story must have entered REVIEW at least once).',
        );
      }

      return withMkdirLock(
        store.runtimeLockDirPath(args.storyId, 'stall-adjudication', 'stall-adjudication'),
        () => {
          const approvedBy = (args.approvedBy || args.actor || '').trim() || 'stall-adjudication';

          // 3) declare_unreachable: withdraw the item FIRST via the B-1909 path.
          //    scope_shrinkage_decision_set validates the itemId exists and throws
          //    (writing NOTHING here) if it does not, so a bad itemId fails before
          //    any stall-adjudication.json is written.
          let withdrawalDecisionRef: string | undefined;
          if (normalized.action === 'declare_unreachable' && normalized.itemId) {
            withdrawalDecisionRef = withdrawUnreachableChecklistItem(
              ctx, args.storyId, normalized.itemId, normalized.reason, approvedBy, reviewRound,
            );
          }

          // 4) Sign + persist the current-round-bound record.
          const recordedAt = new Date().toISOString();
          const _hash = signStallAdjudication(
            args.storyId, normalized.action, normalized.reason, reviewRound, normalized.itemId,
          );
          const data: StallAdjudicationData = {
            storyId: args.storyId,
            action: normalized.action,
            reason: normalized.reason,
            reviewRound,
            ...(normalized.itemId ? { itemId: normalized.itemId } : {}),
            approvedBy,
            recordedAt,
            ...(withdrawalDecisionRef ? { withdrawalDecisionRef } : {}),
            _hash,
          };
          store.writeStallAdjudication(args.storyId, data);

          const commitHint = autoCommitStoryMetadata(root, args.storyId, 'stall_resolution_set');
          const clearLine = `\n→ This compatibility decision does not clear the completed-epoch convergence gate. A human must use proof-or-stop story_resume --storyId=${args.storyId} --ack --reason="<why continuation is justified>" for a verified stagnation freeze.`;
          const closeLine = normalized.action === 'declare_unreachable'
            ? `\n→ Checklist item ${normalized.itemId} withdrawn (B-1909 disposition${withdrawalDecisionRef ? ` ${withdrawalDecisionRef}` : ''}); the stall loop is closed for that item — no further ordinary round is required for it.`
            : '';
          return `Stall resolution recorded for ${args.storyId}: action=${normalized.action}, bound to review round ${reviewRound}.` +
            `${clearLine}${closeLine}${commitHint}`;
        },
        { label: 'stall-adjudication metadata' },
      );
    },
  };
}

/**
 * declare_unreachable reconciliation: mark the checklist item withdrawn via the
 * B-1909 withdrawn-disposition path (scope_shrinkage_decision_set — the sole
 * authorized applier), and, when it is safe (won't empty the effective binding
 * set → the empty-scope hard-refuse floor), also withdraw any acceptance binding
 * that references the now-unreachable item (F-059 plan/claim reconciliation).
 * Returns the B-1909 decisionId stamped onto the item (for the audit link).
 */
function withdrawUnreachableChecklistItem(
  ctx: HandlerContext,
  storyId: string,
  itemId: string,
  reason: string,
  approvedBy: string,
  reviewRound: string,
): string {
  const { store } = ctx;
  const boundBindingRefs = safelyWithdrawableBindings(store, storyId, itemId);
  const ps = createProofStoryHandlers(ctx);
  ps.scope_shrinkage_decision_set({
    storyId,
    decision: 'confirmed',
    userConfirmed: true,
    withdrawnChecklistItemRefs: [itemId],
    ...(boundBindingRefs.length > 0 ? { withdrawnAcceptanceBindingRefs: boundBindingRefs } : {}),
    reason,
    approvedBy,
    evidenceRefs: [`stall-adjudication:declare_unreachable:${reviewRound}`],
  });
  // The applier stamped item.decisionRef; read it back for the audit link.
  try {
    const checklist = store.readChecklist(storyId);
    const item = checklist.items.find(i => i.id === itemId);
    return item?.decisionRef ?? '';
  } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
    return '';
  }
}

/**
 * The acceptance bindings that reference `itemId` and can be withdrawn WITHOUT
 * emptying the effective (non-withdrawn) binding set. Returns [] when there is no
 * contract, no referencing binding, or withdrawing them would empty the set
 * (in which case only the checklist item is withdrawn — that still closes the
 * loop, and the empty-scope floor stays intact). Fail-open to [] on any read
 * error (never blocks the withdrawal).
 */
function safelyWithdrawableBindings(store: StoryStore, storyId: string, itemId: string): string[] {
  try {
    const contract = store.readProofStoryContract(storyId);
    const bindings = contract?.acceptanceBindings ?? [];
    if (bindings.length === 0) return [];
    const alreadyWithdrawn = new Set(
      (contract?.bindingDispositions ?? [])
        .filter(d => d.disposition === 'withdrawn')
        .map(d => d.bindingId),
    );
    const candidates = bindings
      .filter(b => !alreadyWithdrawn.has(b.id) && (b.checklistRefs ?? []).includes(itemId))
      .map(b => b.id);
    if (candidates.length === 0) return [];
    const candidateSet = new Set(candidates);
    const remaining = bindings.filter(b => !alreadyWithdrawn.has(b.id) && !candidateSet.has(b.id));
    // Only withdraw bindings if the effective set stays non-empty.
    return remaining.length > 0 ? candidates : [];
  } catch {
    return [];
  }
}
