import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import {
  REVIEW_ESCALATION_FALLBACK_ELIGIBILITIES,
  evaluateReviewEscalation,
  formatReviewEscalationReport,
  isReviewEscalationFallbackEligibility,
  type ReviewEscalationFallbackEligibility,
} from '../core/review-escalation.js';

type FormatArgs = { json?: boolean; format?: 'text' | 'json' };

type ReviewEscalationStatusArgs = {
  storyId: string;
} & FormatArgs;

type ReviewEscalationFallbackSetArgs = {
  storyId: string;
  eligibility: ReviewEscalationFallbackEligibility;
  reason: string;
  evidenceRefs?: string[];
  approvalRef?: string;
  materialHash?: string;
  storyFilesHash?: string;
  actor?: string;
} & FormatArgs;

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(values: unknown): string[] {
  return Array.isArray(values)
    ? values.map(value => normalizeString(value)).filter(Boolean)
    : [];
}

export function createReviewEscalationHandlers(ctx: HandlerContext) {
  return {
    review_escalation_status(args: ReviewEscalationStatusArgs) {
      const report = evaluateReviewEscalation({
        projectRoot: ctx.root,
        storyId: args.storyId,
        store: ctx.store,
      });
      return wantsJson(args) ? report : formatReviewEscalationReport(report);
    },

    review_escalation_fallback_set(args: ReviewEscalationFallbackSetArgs) {
      assertCwdInWorktree(ctx.store, args.storyId);
      if (!isReviewEscalationFallbackEligibility(args.eligibility)) {
        throw new Error(`review_escalation_fallback_set: eligibility must be one of ${REVIEW_ESCALATION_FALLBACK_ELIGIBILITIES.join('|')}`);
      }
      const reason = normalizeString(args.reason);
      if (reason.length < 20) {
        throw new Error('review_escalation_fallback_set: reason must be at least 20 characters and explain the selected degraded fallback eligibility and why lower-assurance 3x1 is being used');
      }
      const evidenceRefs = normalizeStringArray(args.evidenceRefs);
      const approvalRef = normalizeString(args.approvalRef);
      if (evidenceRefs.length === 0 && !approvalRef) {
        throw new Error('review_escalation_fallback_set: provide at least one evidenceRefs entry or approvalRef');
      }
      const freshMaterialHash = currentMaterialHash(ctx.root);
      if (!freshMaterialHash) {
        throw new Error('review_escalation_fallback_set: cannot compute current material hash');
      }
      const suppliedMaterialHash = normalizeString(args.materialHash);
      if (suppliedMaterialHash && suppliedMaterialHash !== freshMaterialHash) {
        throw new Error('review_escalation_fallback_set: supplied materialHash is stale and does not match current material hash');
      }
      const freshStoryFilesHash = currentStoryFilesHash(ctx.root, 'HEAD', ctx.root);
      const suppliedStoryFilesHash = normalizeString(args.storyFilesHash);
      if (suppliedStoryFilesHash && freshStoryFilesHash && suppliedStoryFilesHash !== freshStoryFilesHash) {
        throw new Error('review_escalation_fallback_set: supplied storyFilesHash is stale and does not match current story-owned file hash');
      }
      const storyFilesHash = freshStoryFilesHash || suppliedStoryFilesHash;

      const fallbackId = `${args.storyId}:REF-${Date.now().toString(36)}`;
      const actor = normalizeString(args.actor) || process.env.LATTICE_AGENT || process.env.USER || 'main';
      ctx.store.appendProcessEvent(args.storyId, {
        type: 'review_escalation_fallback',
        storyId: args.storyId,
        command: 'review_escalation_fallback_set',
        fallbackId,
        eligibility: args.eligibility,
        reason,
        evidenceRefs,
        ...(approvalRef ? { approvalRef } : {}),
        materialHash: freshMaterialHash,
        ...(storyFilesHash ? { storyFilesHash } : {}),
        assuranceLevel: 'degraded-single-host',
        actor,
        authorityDone: false,
        fullAuthorityDone: false,
        productionDone: false,
      });

      const report = evaluateReviewEscalation({
        projectRoot: ctx.root,
        storyId: args.storyId,
        store: ctx.store,
      });
      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'review_escalation_fallback_set');
      if (wantsJson(args)) {
        return {
          schemaVersion: 'lattice.review_escalation_fallback_set.v1',
          fallbackId,
          materialHash: freshMaterialHash,
          ...(storyFilesHash ? { storyFilesHash } : {}),
          assuranceLevel: 'degraded-single-host',
          authorityDone: false,
          fullAuthorityDone: false,
          productionDone: false,
          report,
        };
      }
      return [
        `Review escalation fallback ${fallbackId} recorded`,
        `assuranceLevel: degraded-single-host`,
        `materialHash: ${freshMaterialHash}`,
        ...(storyFilesHash ? [`storyFilesHash: ${storyFilesHash}`] : []),
        `reviewEscalationOk: ${report.ok}`,
        'authorityDone: false',
        'fullAuthorityDone: false',
        'productionDone: false',
        commitHint.trim(),
      ].filter(Boolean).join('\n');
    },
  };
}
