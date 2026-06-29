import type { HandlerContext } from './context.js';
import { resolveStoryCommandWorkspace } from './context.js';
import { submitLocalVerdict, type FormatArgs } from './verdict.js';
import { canonicalDigest } from '../core/authority-signing.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { evaluateReviewEscalation } from '../core/review-escalation.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import { collectReviewerEvidenceState } from '../core/review-run.js';
import { detectMdTouchpointsFromGit } from '../core/touchpoints-fallback.js';
import { listVerdicts } from '../core/verdicts.js';
import { computeActiveReviewers } from './reviewer-list.js';

const REFUSAL = 'quorum_submit refuses: no current reviewer pass evidence for the required lanes — run the review lanes (review_run_start + review_pass_set) first; quorum_submit will not fabricate a floor quorum without a real review.';

type QuorumSubmitArgs = {
  storyId: string;
  hostA: string;
  hostB: string;
  rounds?: number | string;
  validationDigest?: string;
  promptDigestA?: string;
  promptDigestB?: string;
  keyA?: string;
  keyB?: string;
  sessionA?: string;
  sessionB?: string;
  providerA?: string;
  providerB?: string;
  note?: string;
} & FormatArgs;

type HostSide = 'A' | 'B';

interface QuorumHostInput {
  side: HostSide;
  hostId: string;
  provider: string;
  sessionId: string;
  keyId: string;
  promptDigest: string;
}

interface RequiredReviewerPass {
  lane: string;
  passId: string;
  reviewRunId?: string;
}

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeIdentity(value: unknown): string {
  return normalizeString(value).toLowerCase();
}

function toLane(name: string): string {
  return name.startsWith('lattice-review-') ? name : `lattice-review-${name}`;
}

function parseRounds(value: unknown): number {
  const rounds = value === undefined ? 3 : Math.floor(Number(value));
  if (!Number.isFinite(rounds) || rounds < 1) {
    throw new Error('quorum_submit: rounds must be a positive integer');
  }
  return rounds;
}

function derivedSession(storyId: string, hostId: string): string {
  return `quorum:${storyId}:${hostId}:session`;
}

function derivedKey(storyId: string, hostId: string): string {
  return `quorum:${storyId}:${hostId}:key`;
}

function assertHostIndependence(hostA: QuorumHostInput, hostB: QuorumHostInput): void {
  const shared: string[] = [];
  if (normalizeIdentity(hostA.hostId) === normalizeIdentity(hostB.hostId)) shared.push('hostId');
  if (normalizeIdentity(hostA.sessionId) === normalizeIdentity(hostB.sessionId)) shared.push('sessionId');
  if (normalizeIdentity(hostA.keyId) === normalizeIdentity(hostB.keyId)) shared.push('keyId');
  if (shared.length > 0) {
    throw new Error(`quorum_submit: hostA and hostB must be independent; shared ${shared.join(', ')} would collapse the quorum`);
  }
}

function safeReadChecklist(ctx: HandlerContext, storyId: string) {
  try {
    return ctx.store.readChecklist(storyId);
  } catch {
    return { items: [] };
  }
}

function safeReadDecision(ctx: HandlerContext, storyId: string) {
  try {
    return ctx.store.readDecision(storyId);
  } catch {
    return null;
  }
}

function safeReadTestEvidence(ctx: HandlerContext, storyId: string): unknown {
  try {
    return ctx.store.readTestEvidence(storyId);
  } catch {
    return null;
  }
}

function requiredReviewerLanes(ctx: HandlerContext, storyId: string, projectRoot: string): string[] {
  const story = ctx.store.readStory(storyId);
  const checklist = safeReadChecklist(ctx, storyId);
  const decision = safeReadDecision(ctx, storyId);
  const understanding = ctx.store.readUnderstanding(storyId);
  const touchpoints = understanding?.touchpoints ?? detectMdTouchpointsFromGit(projectRoot);
  return computeActiveReviewers(story, checklist, decision, touchpoints)
    .map(reviewer => toLane(reviewer.name));
}

function assertCurrentReviewerPasses(ctx: HandlerContext, storyId: string, projectRoot: string): RequiredReviewerPass[] {
  const story = ctx.store.readStory(storyId);
  if (!story.currentReviewRound) {
    throw new Error(`${REFUSAL}\nDetails: story has no currentReviewRound, so no current signed reviewer pass can be proven.`);
  }
  const requiredLanes = requiredReviewerLanes(ctx, storyId, projectRoot);
  const state = collectReviewerEvidenceState(ctx.store, storyId, projectRoot);
  const validPasses = state.valid.filter(evidence => evidence.kind === 'pass');
  const passByLane = new Map(validPasses.map(evidence => [evidence.agent, evidence]));
  const missing = requiredLanes.filter(lane => !passByLane.has(lane));
  if (missing.length > 0 || state.invalid.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing current pass lane(s): ${missing.join(', ')}`] : []),
      ...state.invalid.slice(0, 8).map(issue => `${issue.agent}: ${issue.message}`),
    ];
    throw new Error(`${REFUSAL}${details.length > 0 ? `\nDetails: ${details.join('\n')}` : ''}`);
  }
  return requiredLanes.map((lane) => {
    const pass = passByLane.get(lane)!;
    return {
      lane,
      passId: pass.id,
      ...(pass.reviewRunId ? { reviewRunId: pass.reviewRunId } : {}),
    };
  });
}

function deriveValidationDigest(ctx: HandlerContext, storyId: string, materialDigest: string, storyFilesHash: string, headHash?: string): string {
  return canonicalDigest({
    schemaVersion: 'lattice.quorum_submit.validation_digest.v1',
    storyId,
    headHash,
    materialDigest,
    storyFilesHash,
    testEvidence: safeReadTestEvidence(ctx, storyId),
  });
}

function derivePromptDigest(storyId: string, host: Omit<QuorumHostInput, 'promptDigest'>, materialDigest: string, storyFilesHash: string): string {
  return canonicalDigest({
    schemaVersion: 'lattice.quorum_submit.prompt_digest.v1',
    purpose: 'local voluntary 3x2 review quorum after signed reviewer passes',
    storyId,
    hostId: host.hostId,
    provider: host.provider,
    sessionId: host.sessionId,
    keyId: host.keyId,
    materialDigest,
    storyFilesHash,
  });
}

function formatResult(result: QuorumSubmitResult): string {
  return [
    `Quorum submit (${result.schemaVersion})`,
    `storyId: ${result.storyId}`,
    `verdictIds: ${result.verdictIds.join(', ')}`,
    `runIds: ${result.runIds.join(', ')}`,
    `materialDigest: ${result.materialDigest}`,
    `storyFilesHash: ${result.storyFilesHash}`,
    `validationDigest: ${result.validationDigest}`,
    `promptDigestA: ${result.promptDigests.hostA}`,
    `promptDigestB: ${result.promptDigests.hostB}`,
    `reviewerPasses: ${result.reviewerPasses.length}/${result.requiredReviewerLanes.length} lanes current`,
    `voluntaryLocalRounds: ${result.reviewEscalationStatus.voluntaryLocalRounds.validRoundCount}/${result.reviewEscalationStatus.voluntaryLocalRounds.requiredRounds} rounds x ${result.reviewEscalationStatus.voluntaryLocalRounds.requiredPassingHostsPerRound} hosts (complete=${result.reviewEscalationStatus.voluntaryLocalRounds.complete})`,
    'admissibilityStatus: local-quorum-recorded',
    `assuranceLevel: ${result.reviewEscalationStatus.assuranceLevel}`,
    'evidenceScope: local-review-quorum',
  ].join('\n');
}

interface QuorumSubmitResult {
  schemaVersion: 'lattice.quorum_submit.v1';
  storyId: string;
  rounds: number;
  emittedCount: number;
  verdictIds: string[];
  runIds: string[];
  materialDigest: string;
  storyFilesHash: string;
  validationDigest: string;
  promptDigests: {
    hostA: string;
    hostB: string;
  };
  hosts: {
    hostA: QuorumHostInput;
    hostB: QuorumHostInput;
  };
  requiredReviewerLanes: string[];
  reviewerPasses: RequiredReviewerPass[];
  verdicts: Array<{
    verdictId: string;
    runId: string;
    hostId: string;
    provider: string;
    sessionId: string;
    keyId?: string;
  }>;
  reviewEscalationStatus: ReturnType<typeof evaluateReviewEscalation>;
  authorityDone: false;
  fullAuthorityDone: false;
  productionDone: false;
}

export function createQuorumSubmitHandlers(ctx: HandlerContext) {
  return {
    quorum_submit(args: QuorumSubmitArgs): QuorumSubmitResult | string {
      const storyId = normalizeString(args.storyId);
      if (!storyId) throw new Error('quorum_submit: storyId is required');
      if (!isCanonicalStoryId(storyId)) {
        throw new Error(`quorum_submit: storyId "${storyId}" is not a canonical, path-safe Proofbound story id`);
      }
      const hostAId = normalizeString(args.hostA);
      const hostBId = normalizeString(args.hostB);
      if (!hostAId || !hostBId) throw new Error('quorum_submit: hostA and hostB are required');
      const rounds = parseRounds(args.rounds);
      const workspace = resolveStoryCommandWorkspace(ctx.store, storyId, ctx.root);
      const projectRoot = workspace.signedWorkspaceRoot;

      const reviewerPasses = assertCurrentReviewerPasses(ctx, storyId, projectRoot);

      const materialDigest = currentMaterialHash(projectRoot, 'HEAD', workspace.metadataRoot || ctx.root);
      if (!materialDigest) {
        throw new Error('quorum_submit: cannot compute current materialHash; refusing to emit quorum verdicts with an empty materialDigest');
      }
      const storyFilesHash = currentStoryFilesHash(projectRoot, 'HEAD', workspace.metadataRoot || ctx.root);
      if (!storyFilesHash) {
        throw new Error('quorum_submit: cannot compute current storyFilesHash; refusing to emit quorum verdicts without the story-owned file hash');
      }
      const headHash = currentGitHead(projectRoot);
      const baseHostA = {
        side: 'A' as const,
        hostId: hostAId,
        provider: normalizeString(args.providerA) || 'claude',
        sessionId: normalizeString(args.sessionA) || derivedSession(storyId, hostAId),
        keyId: normalizeString(args.keyA) || derivedKey(storyId, hostAId),
      };
      const baseHostB = {
        side: 'B' as const,
        hostId: hostBId,
        provider: normalizeString(args.providerB) || 'codex',
        sessionId: normalizeString(args.sessionB) || derivedSession(storyId, hostBId),
        keyId: normalizeString(args.keyB) || derivedKey(storyId, hostBId),
      };
      const hostA: QuorumHostInput = {
        ...baseHostA,
        promptDigest: normalizeString(args.promptDigestA) || derivePromptDigest(storyId, baseHostA, materialDigest, storyFilesHash),
      };
      const hostB: QuorumHostInput = {
        ...baseHostB,
        promptDigest: normalizeString(args.promptDigestB) || derivePromptDigest(storyId, baseHostB, materialDigest, storyFilesHash),
      };
      assertHostIndependence(hostA, hostB);
      const validationDigest = normalizeString(args.validationDigest)
        || deriveValidationDigest(ctx, storyId, materialDigest, storyFilesHash, headHash);
      const note = normalizeString(args.note) || 'quorum_submit local voluntary floor quorum after current signed reviewer passes';

      // Guard: refuse to re-submit a quorum for a runId that already carries a verdict at the
      // SAME materialDigest. This prevents silently piling duplicate verdicts onto an already-
      // populated runId, while still allowing a fresh quorum after the material changes (a
      // different materialDigest does not collide).
      const plannedRunIds = new Set<string>();
      for (let round = 1; round <= rounds; round += 1) plannedRunIds.add(`${storyId}-q-r${round}`);
      const duplicateRunIds = [...new Set(
        listVerdicts(ctx.root, 'local', storyId)
          .filter(verdict => plannedRunIds.has(verdict.runId) && verdict.materialDigest === materialDigest)
          .map(verdict => verdict.runId),
      )].sort();
      if (duplicateRunIds.length > 0) {
        throw new Error(`quorum_submit refuses: verdicts already exist for runId(s) ${duplicateRunIds.join(', ')} at the current material (${materialDigest}); re-submitting would duplicate the quorum. Re-run only after the material changes (a new commit), or use a fresh review round.`);
      }

      const emitted = [];
      const runIds: string[] = [];
      for (let round = 1; round <= rounds; round += 1) {
        const runId = `${storyId}-q-r${round}`;
        runIds.push(runId);
        for (const host of [hostA, hostB]) {
          const verdict = submitLocalVerdict(ctx, 'local', {
            storyId,
            runId,
            hostId: host.hostId,
            provider: host.provider,
            sessionId: host.sessionId,
            keyId: host.keyId,
            decision: 'pass',
            materialDigest,
            storyFilesHash,
            validationDigest,
            promptDigest: host.promptDigest,
            note,
          });
          emitted.push({
            verdictId: verdict.verdictId,
            runId: verdict.runId,
            hostId: verdict.hostId,
            provider: verdict.provider,
            sessionId: verdict.sessionId,
            keyId: verdict.keyId,
          });
        }
      }

      const reviewEscalationStatus = evaluateReviewEscalation({
        projectRoot,
        storyId,
        store: ctx.store,
        materialHash: materialDigest,
        storyFilesHash,
      });
      const result: QuorumSubmitResult = {
        schemaVersion: 'lattice.quorum_submit.v1',
        storyId,
        rounds,
        emittedCount: emitted.length,
        verdictIds: emitted.map(verdict => verdict.verdictId),
        runIds,
        materialDigest,
        storyFilesHash,
        validationDigest,
        promptDigests: {
          hostA: hostA.promptDigest,
          hostB: hostB.promptDigest,
        },
        hosts: { hostA, hostB },
        requiredReviewerLanes: reviewerPasses.map(pass => pass.lane),
        reviewerPasses,
        verdicts: emitted,
        reviewEscalationStatus,
        authorityDone: false,
        fullAuthorityDone: false,
        productionDone: false,
      };
      return wantsJson(args) ? result : formatResult(result);
    },
  };
}
