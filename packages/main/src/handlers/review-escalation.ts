import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import {
  REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_EVENT,
  REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE,
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

type ReviewEscalationPolicySetArgs = {
  storyId: string;
  policyVersion: string;
  sourcePolicyRef: string;
  rolloutStage: string;
  milestoneId?: string;
  riskClass?: string;
  degradedFallbackAllowed: boolean;
  issuer?: string;
  approver?: string;
  materialHash?: string;
  headHash?: string;
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
      const gitCwd = resolveGitCwd({ store: ctx.store, storyId: args.storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
      const report = evaluateReviewEscalation({
        projectRoot: ctx.root,
        gitCwd,
        storyId: args.storyId,
        store: ctx.store,
      });
      return wantsJson(args) ? report : formatReviewEscalationReport(report);
    },

    review_escalation_policy_set(args: ReviewEscalationPolicySetArgs) {
      assertCwdInWorktree(ctx.store, args.storyId);
      const gitCwd = resolveGitCwd({ store: ctx.store, storyId: args.storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
      const policyVersion = normalizeString(args.policyVersion);
      const sourcePolicyRef = normalizeString(args.sourcePolicyRef);
      const rolloutStage = normalizeString(args.rolloutStage);
      const milestoneId = normalizeString(args.milestoneId);
      const riskClass = normalizeString(args.riskClass);
      const issuer = normalizeString(args.issuer) || normalizeString(args.actor) || process.env.LATTICE_AGENT || process.env.USER || 'main';
      const approver = normalizeString(args.approver);
      if (!policyVersion) throw new Error('review_escalation_policy_set: policyVersion is required');
      if (!sourcePolicyRef) throw new Error('review_escalation_policy_set: sourcePolicyRef is required');
      if (!rolloutStage) throw new Error('review_escalation_policy_set: rolloutStage is required');
      if (!milestoneId && !riskClass) throw new Error('review_escalation_policy_set: provide milestoneId or riskClass');
      if (typeof args.degradedFallbackAllowed !== 'boolean') {
        throw new Error('review_escalation_policy_set: degradedFallbackAllowed must be boolean');
      }
      const freshMaterialHash = currentMaterialHash(gitCwd, 'HEAD', ctx.root);
      if (!freshMaterialHash) throw new Error('review_escalation_policy_set: cannot compute current material hash');
      const freshHeadHash = currentGitHead(gitCwd);
      if (!freshHeadHash) throw new Error('review_escalation_policy_set: cannot compute current git HEAD');
      const suppliedMaterialHash = normalizeString(args.materialHash);
      if (suppliedMaterialHash && suppliedMaterialHash !== freshMaterialHash) {
        throw new Error('review_escalation_policy_set: supplied materialHash is stale and does not match current material hash');
      }
      const suppliedHeadHash = normalizeString(args.headHash);
      if (suppliedHeadHash && suppliedHeadHash !== freshHeadHash) {
        throw new Error('review_escalation_policy_set: supplied headHash is stale and does not match current HEAD');
      }

      const issuedAt = new Date().toISOString();
      const policyId = `${args.storyId}:POL-${Date.now().toString(36)}`;
      ctx.store.appendProcessEvent(args.storyId, {
        type: REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_EVENT,
        storyId: args.storyId,
        command: 'review_escalation_policy_set',
        policyId,
        predicate: REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE,
        requires3x2: true,
        policyVersion,
        ...(milestoneId ? { milestoneId } : {}),
        ...(riskClass ? { riskClass } : {}),
        sourcePolicyRef,
        rolloutStage,
        degradedFallbackAllowed: args.degradedFallbackAllowed,
        issuer,
        ...(approver ? { approver } : {}),
        issuedAt,
        headHash: freshHeadHash,
        materialHash: freshMaterialHash,
        authorityDone: false,
        fullAuthorityDone: false,
        productionDone: false,
      });

      const report = evaluateReviewEscalation({
        projectRoot: ctx.root,
        gitCwd,
        storyId: args.storyId,
        store: ctx.store,
      });
      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'review_escalation_policy_set');
      if (wantsJson(args)) {
        return {
          schemaVersion: 'lattice.review_escalation_policy_set.v1',
          policyId,
          predicate: REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE,
          requires3x2: true,
          policyVersion,
          sourcePolicyRef,
          rolloutStage,
          degradedFallbackAllowed: args.degradedFallbackAllowed,
          headHash: freshHeadHash,
          materialHash: freshMaterialHash,
          authorityDone: false,
          fullAuthorityDone: false,
          productionDone: false,
          report,
        };
      }
      return [
        `Review escalation policy ${policyId} recorded`,
        `predicate: ${REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE}`,
        `requires3x2: true`,
        `policyVersion: ${policyVersion}`,
        `sourcePolicyRef: ${sourcePolicyRef}`,
        `rolloutStage: ${rolloutStage}`,
        `degradedFallbackAllowed: ${args.degradedFallbackAllowed}`,
        `materialHash: ${freshMaterialHash}`,
        `reviewEscalationRequired: ${report.required}`,
        'admissibilityStatus: local-review-policy-recorded',
        'assuranceLevel: local',
        'evidenceScope: review-escalation-policy',
        commitHint.trim(),
      ].filter(Boolean).join('\n');
    },

    review_escalation_fallback_set(args: ReviewEscalationFallbackSetArgs) {
      assertCwdInWorktree(ctx.store, args.storyId);
      const gitCwd = resolveGitCwd({ store: ctx.store, storyId: args.storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
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
      const freshMaterialHash = currentMaterialHash(gitCwd, 'HEAD', ctx.root);
      if (!freshMaterialHash) {
        throw new Error('review_escalation_fallback_set: cannot compute current material hash');
      }
      const suppliedMaterialHash = normalizeString(args.materialHash);
      if (suppliedMaterialHash && suppliedMaterialHash !== freshMaterialHash) {
        throw new Error('review_escalation_fallback_set: supplied materialHash is stale and does not match current material hash');
      }
      const freshStoryFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', ctx.root);
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
        gitCwd,
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
        'admissibilityStatus: degraded-local-review-recorded',
        'assuranceLevel: degraded-single-host',
        'evidenceScope: review-escalation-fallback',
        commitHint.trim(),
      ].filter(Boolean).join('\n');
    },
  };
}
