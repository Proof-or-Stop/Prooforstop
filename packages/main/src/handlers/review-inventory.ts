import type { HandlerContext } from './context.js';
import { resolveStoryCommandWorkspace } from './context.js';
import { computeActiveReviewers } from './reviewer-list.js';
import { detectMdTouchpointsFromGit } from '../core/touchpoints-fallback.js';
import { assertCurrentReviewRunForEvidence, captureReviewRunSnapshot, verifyReviewRun } from '../core/review-run.js';
import type { ReviewInventoryCriticReceipt, ReviewInventoryEpoch, ReviewInventoryFindingDisposition, ReviewInventoryReceipt } from '../core/types.js';
import {
  buildWave,
  captureReviewInventoryBaselineFindingIds,
  currentOpenReviewInventory,
  evaluateReviewInventoryWave,
  finalizedUnconsumedReviewInventory,
  reviewInventoryDigest,
  reviewInventoryAggregateFamilies,
  reviewInventoryLaneCoverageDigest,
  signReviewInventoryEpoch,
  signReviewInventoryCriticReceipt,
  signReviewInventoryReceipt,
  validateReviewInventoryCriticReceipt,
  verifyReviewInventoryEpoch,
  verifyReviewInventoryReceipt,
  withReviewInventoryMutationLock,
} from '../core/review-inventory-epoch.js';
import { resolveAgentMutationAuthority } from '../core/agent-dispatch-registry.js';
import { verifyFinding, verifyReviewPass } from '../core/finding-verify.js';

function signedRoot(ctx: HandlerContext, storyId: string): { root: string; metadataRoot: string } {
  const workspace = resolveStoryCommandWorkspace(ctx.store, storyId, ctx.root);
  const root = workspace.signedWorkspaceRoot || workspace.snapshotRoot;
  if (!root) throw new Error(`review inventory: cannot resolve signed workspace for ${storyId}`);
  return { root, metadataRoot: workspace.metadataRoot || ctx.root };
}

function signEpoch(epoch: Omit<ReviewInventoryEpoch, '_hash'> | ReviewInventoryEpoch): ReviewInventoryEpoch {
  const { _hash, ...unsigned } = epoch as ReviewInventoryEpoch;
  return { ...unsigned, _hash: signReviewInventoryEpoch(unsigned) };
}

function inventoryLock<T>(ctx: HandlerContext, storyId: string, fn: () => T): T {
  return withReviewInventoryMutationLock(ctx.store, storyId, fn);
}

function capture(ctx: HandlerContext, storyId: string) {
  const workspace = signedRoot(ctx, storyId);
  const story = ctx.store.readStory(storyId);
  return captureReviewRunSnapshot(workspace.root, {
    storyId,
    storyPhase: story.phase,
    currentReviewRound: story.currentReviewRound,
  }, workspace.metadataRoot);
}

function persistInvalidationIfDrifted(ctx: HandlerContext, epoch: ReviewInventoryEpoch): ReviewInventoryEpoch {
  const current = capture(ctx, epoch.storyId);
  if (current.materialHash === epoch.cutoff.materialHash
    && (current.storyFilesHash ?? '') === (epoch.cutoff.storyFilesHash ?? '')) return epoch;
  const now = new Date().toISOString();
  const next = signEpoch({
    ...epoch,
    state: 'INVALIDATED',
    updatedAt: now,
    invalidation: {
      detectedAt: now,
      oldMaterialHash: epoch.cutoff.materialHash,
      currentMaterialHash: current.materialHash,
      ...(epoch.cutoff.storyFilesHash ? { oldStoryFilesHash: epoch.cutoff.storyFilesHash } : {}),
      ...(current.storyFilesHash ? { currentStoryFilesHash: current.storyFilesHash } : {}),
      blockerCode: 'OPEN_REVIEW_INVENTORY_MATERIAL_MUTATION',
    },
  });
  const data = ctx.store.readReviewInventoryEpochs(epoch.storyId);
  data.epochs = data.epochs.map(row => row.epochId === epoch.epochId ? next : row);
  ctx.store.writeReviewInventoryEpochs(epoch.storyId, data);
  return next;
}

export interface ReviewInventoryStatusProjection {
  evaluation?: ReturnType<typeof evaluateReviewInventoryWave>;
  criticComplete?: boolean;
  criticReviewRunId?: string;
}

export function renderReviewInventoryStatus(epoch: ReviewInventoryEpoch, projection: ReviewInventoryStatusProjection = {}): string {
  const wave = epoch.waves.length + (epoch.state === 'OPEN' ? 1 : 0);
  const last = epoch.waves.at(-1);
  const live = epoch.state === 'OPEN' ? projection.evaluation : undefined;
  const laneRows = epoch.requiredLanes.map(lane => {
    const terminal = live?.lanes.find(row => row.lane === lane) ?? last?.lanes.find(row => row.lane === lane);
    return `Lane ${lane}: ${terminal?.terminal ?? 'pending'}`;
  });
  const blockers: string[] = [];
  if (epoch.state === 'INVALIDATED') blockers.push('OPEN_REVIEW_INVENTORY_MATERIAL_MUTATION');
  if (epoch.state === 'FINALIZED' && epoch.consumedAt) blockers.push('REVIEW_INVENTORY_RECEIPT_ALREADY_CONSUMED');
  if (epoch.state === 'OPEN' && epoch.waves.length >= epoch.maxWaves && !last?.saturated) blockers.push('REVIEW_INVENTORY_BUDGET_EXHAUSTED');
  if (epoch.state === 'OPEN' && live?.missingLanes.length) blockers.push('REVIEW_INVENTORY_LANES_INCOMPLETE');
  if (epoch.state === 'OPEN' && live?.duplicateIdentities.length) blockers.push('REVIEW_INVENTORY_DUPLICATE_IDENTITY');
  if (epoch.state === 'OPEN' && live?.unresolvedFindingIds.length) blockers.push('REVIEW_INVENTORY_FINDING_DISPOSITION_INCOMPLETE');
  if (epoch.state === 'OPEN' && live?.invalidDispositionIds.length) blockers.push('REVIEW_INVENTORY_FINDING_DISPOSITION_INVALID');
  if (epoch.state === 'OPEN' && live?.baselineMismatchIds.length) blockers.push('REVIEW_INVENTORY_BASELINE_FINDINGS_CHANGED');
  if (epoch.state === 'OPEN' && live && live.missingLanes.length === 0
    && live.duplicateIdentities.length === 0 && !projection.criticComplete) blockers.push('REVIEW_INVENTORY_CRITIC_INCOMPLETE');
  if (epoch.state === 'OPEN' && projection.criticComplete && live?.newFamilies.length) {
    blockers.push('REVIEW_INVENTORY_NEW_FINDINGS_REQUIRE_NEXT_WAVE');
  }
  let next: string;
  if (epoch.state === 'OPEN') {
    if (blockers.includes('REVIEW_INVENTORY_BUDGET_EXHAUSTED')) {
      next = `lattice review_inventory_cancel --storyId=${epoch.storyId} --reason="replan or decompose after wave budget exhaustion"`;
    } else if (live?.baselineMismatchIds.length) {
      next = `lattice review_inventory_cancel --storyId=${epoch.storyId} --reason="baseline finding set changed; reopen a fresh signed epoch"`;
    } else if (live?.missingLanes.length) {
      next = `lattice dispatch '{"storyId":"${epoch.storyId}","agentType":"${live.missingLanes[0]}"}'`;
    } else if (live?.duplicateIdentities.length) {
      next = `lattice review_inventory_cancel --storyId=${epoch.storyId} --reason="re-dispatch independent reviewer identities"`;
    } else if (live && !projection.criticComplete) {
      const conservativeDispositions = live.rawFindingIds.map(findingId => ({
        findingId,
        disposition: 'verified_family' as const,
        familyKey: `finding:${findingId}`,
        reason: 'Conservative executable default: retain this verified finding as its own family',
      }));
      next = projection.criticReviewRunId
        ? `lattice review_inventory_critic_set '${JSON.stringify({ storyId: epoch.storyId, epochId: epoch.epochId, reviewRunId: projection.criticReviewRunId, agent: 'lattice-review-topology-critic', findingDispositions: conservativeDispositions })}'`
        : `lattice dispatch '{"storyId":"${epoch.storyId}","agentType":"lattice-review-topology-critic"}'`;
    } else if (live?.newFamilies.length) {
      next = `lattice review_inventory_wave_advance --storyId=${epoch.storyId}`;
    } else {
      next = `lattice review_inventory_finalize --storyId=${epoch.storyId}`;
    }
  } else if (epoch.state === 'FINALIZED') {
    next = epoch.consumedAt
      ? `lattice review_inventory_begin --storyId=${epoch.storyId}`
      : `lattice story_advance --storyId=${epoch.storyId} --phase=DEV`;
  } else {
    next = `lattice review_inventory_begin --storyId=${epoch.storyId}`;
  }
  return [
    `Review inventory epoch: ${epoch.epochId}`,
    `State: ${epoch.state}`,
    `Frozen cutoff: ${epoch.cutoff.materialHash}`,
    `Review round: ${epoch.reviewRound}`,
    `Current wave: ${wave}/${epoch.maxWaves}`,
    `Required lanes: ${epoch.requiredLanes.join(', ')}`,
    ...laneRows,
    `Verified findings: ${live ? reviewInventoryAggregateFamilies(epoch, live).length : (last?.verifiedFindingFamilies.length ?? 0)}`,
    `New verified findings: ${live?.newFamilies.length ?? last?.newVerifiedFindingCount ?? 0}`,
    `Completeness critic: ${projection.criticComplete ? 'complete' : 'pending'}`,
    `Blockers: ${blockers.join(', ') || 'none'}`,
    ...(epoch.invalidation ? [`Changed lineage: ${epoch.invalidation.oldMaterialHash} -> ${epoch.invalidation.currentMaterialHash}`] : []),
    ...(epoch.state === 'FINALIZED' && !epoch.consumedAt
      ? [`Recovery for genuine late evidence: lattice review_inventory_cancel --storyId=${epoch.storyId} --reason="late evidence invalidated finalized receipt"; then begin a fresh epoch and fresh ReviewRun`]
      : []),
    `Next: ${next}`,
  ].join('\n');
}

function evaluateCurrentWave(
  ctx: HandlerContext,
  epoch: ReviewInventoryEpoch,
  findingDispositions?: ReviewInventoryFindingDisposition[],
) {
  const dispositions = findingDispositions ?? criticReceiptForCurrentWave(ctx, epoch)?.findingDispositions;
  return evaluateReviewInventoryWave({
    epoch,
    runs: ctx.store.readReviewRuns(epoch.storyId).runs,
    passes: ctx.store.readReviewPasses(epoch.storyId).passes,
    findings: ctx.store.readFindings(epoch.storyId).findings,
    findingDispositions: dispositions,
  });
}

function criticReceiptForCurrentWave(ctx: HandlerContext, epoch: ReviewInventoryEpoch) {
  const data = ctx.store.readReviewInventoryEpochs(epoch.storyId);
  return data.criticReceipts.find(row => row.epochId === epoch.epochId && row.wave === epoch.waves.length + 1);
}

function currentCriticComplete(ctx: HandlerContext, epoch: ReviewInventoryEpoch): boolean {
  if (epoch.state !== 'OPEN') return epoch.state === 'FINALIZED';
  const evaluation = evaluateCurrentWave(ctx, epoch);
  if (evaluation.missingLanes.length > 0 || evaluation.duplicateIdentities.length > 0) return false;
  return validateReviewInventoryCriticReceipt({
    receipt: criticReceiptForCurrentWave(ctx, epoch),
    epoch,
    evaluation,
    runs: ctx.store.readReviewRuns(epoch.storyId).runs,
    passes: ctx.store.readReviewPasses(epoch.storyId).passes,
    findings: ctx.store.readFindings(epoch.storyId).findings,
  }).ok;
}

function currentCriticReviewRunId(ctx: HandlerContext, epoch: ReviewInventoryEpoch, evaluation: ReturnType<typeof evaluateReviewInventoryWave>): string | undefined {
  if (evaluation.missingLanes.length > 0 || evaluation.duplicateIdentities.length > 0) return undefined;
  const passes = ctx.store.readReviewPasses(epoch.storyId).passes;
  const findings = ctx.store.readFindings(epoch.storyId).findings;
  const evidenceById = [...passes, ...findings];
  const latestLaneEvidenceAt = Math.max(...evaluation.lanes.flatMap(lane => lane.evidenceIds.map(id =>
    Date.parse(evidenceById.find(row => row.id === id)?.createdAt ?? ''),
  )).filter(Number.isFinite));
  const latest = ctx.store.readReviewRuns(epoch.storyId).runs
    .filter(run => verifyReviewRun(run) && run.lane === 'lattice-review-topology-critic'
      && run.reviewRound === epoch.reviewRound && run.materialHash === epoch.cutoff.materialHash
      && (run.storyFilesHash ?? '') === (epoch.cutoff.storyFilesHash ?? '')
      && Date.parse(run.startedAt) > latestLaneEvidenceAt)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!latest) return undefined;
  const terminal = [
    ...passes.filter(row => row.reviewRunId === latest.reviewRunId && verifyReviewPass(epoch.storyId, row)),
    ...findings.filter(row => row.reviewRunId === latest.reviewRunId && verifyFinding(epoch.storyId, row)),
  ];
  return terminal.some(row => Boolean(row.readManifest)) ? latest.reviewRunId : undefined;
}

function renderProjectedStatus(ctx: HandlerContext, epoch: ReviewInventoryEpoch): string {
  const evaluation = epoch.state === 'OPEN' ? evaluateCurrentWave(ctx, epoch) : undefined;
  return renderReviewInventoryStatus(epoch, {
    evaluation,
    criticComplete: currentCriticComplete(ctx, epoch),
    criticReviewRunId: evaluation ? currentCriticReviewRunId(ctx, epoch, evaluation) : undefined,
  });
}

export function renderReviewInventoryBegin(epoch: ReviewInventoryEpoch): string {
  return [
    `Review inventory epoch: ${epoch.epochId}`,
    'State: OPEN',
    `Frozen cutoff: ${epoch.cutoff.materialHash}`,
    `Next: lattice review_inventory_status --storyId=${epoch.storyId}`,
  ].join('\n');
}

export function assertOpenInventoryFresh(ctx: HandlerContext, storyId: string): void {
  inventoryLock(ctx, storyId, () => {
    const epoch = currentOpenReviewInventory(ctx.store, storyId);
    if (!epoch) return;
    const refreshed = persistInvalidationIfDrifted(ctx, epoch);
    if (refreshed.state !== 'OPEN') {
      throw new Error(
        `OPEN_REVIEW_INVENTORY_MATERIAL_MUTATION\nEpoch: ${epoch.epochId}\n` +
        `Changed lineage: ${refreshed.invalidation?.oldMaterialHash} -> ${refreshed.invalidation?.currentMaterialHash}\n` +
        `Recovery: lattice review_inventory_begin --storyId=${storyId}`,
      );
    }
  });
}

export function createReviewInventoryHandlers(ctx: HandlerContext) {
  return {
    review_inventory_begin(args: { storyId: string; maxWaves?: number }): string {
      return inventoryLock(ctx, args.storyId, () => {
        const story = ctx.store.readStory(args.storyId);
        if (story.phase !== 'REVIEW' || !story.currentReviewRound) {
          throw new Error(`review_inventory_begin: ${args.storyId} must be in REVIEW with currentReviewRound`);
        }
        const existing = currentOpenReviewInventory(ctx.store, args.storyId);
        if (existing) {
          const fresh = persistInvalidationIfDrifted(ctx, existing);
          if (fresh.state === 'OPEN') return renderProjectedStatus(ctx, fresh);
        }
        const pendingReceipt = finalizedUnconsumedReviewInventory(ctx.store, args.storyId);
        if (pendingReceipt) {
          throw new Error(
            `REVIEW_INVENTORY_RECEIPT_UNCONSUMED: ${pendingReceipt.receipt.receiptId}; ` +
            `Next: lattice story_advance --storyId=${args.storyId} --phase=DEV`,
          );
        }
        const checklist = ctx.store.readChecklist(args.storyId);
        let decision = null;
        try { decision = ctx.store.readDecision(args.storyId); } catch { decision = null; }
        const understanding = ctx.store.readUnderstanding(args.storyId);
        const touchpoints = understanding?.touchpoints ?? detectMdTouchpointsFromGit(ctx.root);
        const requiredLanes = computeActiveReviewers(story, checklist, decision, touchpoints)
          .map(row => `lattice-review-${row.name}`);
        const cutoff = capture(ctx, args.storyId);
        const scopeDigest = reviewInventoryDigest({
          scopeContract: ctx.store.readScopeContract(args.storyId),
          checklist: checklist.items.map(row => ({ id: row.id, title: row.title, files: row.files })),
        });
        const data = ctx.store.readReviewInventoryEpochs(args.storyId);
        const epochNum = data.epochs.reduce((max, row) => {
          const match = row.epochId.match(/:RI-(\d+)$/);
          return match ? Math.max(max, Number(match[1])) : max;
        }, 0) + 1;
        const now = new Date().toISOString();
        const provisional: Omit<ReviewInventoryEpoch, '_hash'> = {
          schemaVersion: 'proofbound.review_inventory_epoch.v1',
          epochId: `${args.storyId}:RI-${String(epochNum).padStart(3, '0')}`,
          storyId: args.storyId,
          reviewRound: story.currentReviewRound,
          state: 'OPEN',
          begunAt: now,
          updatedAt: now,
          cutoff,
          scopeDigest,
          requiredLanes,
          maxWaves: args.maxWaves ?? 3,
          waves: [],
        };
        const baselineFindingIds = captureReviewInventoryBaselineFindingIds({
          epoch: { ...provisional, _hash: '' },
          runs: ctx.store.readReviewRuns(args.storyId).runs,
          findings: ctx.store.readFindings(args.storyId).findings,
        });
        const unsigned: Omit<ReviewInventoryEpoch, '_hash'> = { ...provisional, baselineFindingIds };
        const epoch = signEpoch(unsigned);
        data.epochs.push(epoch);
        ctx.store.writeReviewInventoryEpochs(args.storyId, data);
        return renderReviewInventoryBegin(epoch);
      });
    },

    review_inventory_status(args: { storyId: string }): string {
      return inventoryLock(ctx, args.storyId, () => {
        const data = ctx.store.readReviewInventoryEpochs(args.storyId);
        let epoch = data.epochs.at(-1);
        if (!epoch) throw new Error(`review_inventory_status: no epoch for ${args.storyId}`);
        if (!verifyReviewInventoryEpoch(epoch)) throw new Error(`review_inventory_status: epoch ${epoch.epochId} signature mismatch`);
        if (epoch.state === 'OPEN') epoch = persistInvalidationIfDrifted(ctx, epoch);
        return renderProjectedStatus(ctx, epoch);
      });
    },

    review_inventory_critic_set(args: {
      storyId: string;
      epochId: string;
      reviewRunId: string;
      agent?: string;
      findingDispositions: ReviewInventoryFindingDisposition[];
    }): string {
      const authority = resolveAgentMutationAuthority({
        command: 'review_inventory_critic_set',
        payloadActors: [args.agent],
      });
      if (authority.actor !== 'lattice-review-topology-critic') {
        throw new Error('review_inventory_critic_set: only lattice-review-topology-critic may write critic authority');
      }
      return inventoryLock(ctx, args.storyId, () => {
        let epoch = currentOpenReviewInventory(ctx.store, args.storyId);
        if (!epoch || epoch.epochId !== args.epochId) throw new Error(`review_inventory_critic_set: OPEN epoch ${args.epochId} not found`);
        epoch = persistInvalidationIfDrifted(ctx, epoch);
        if (epoch.state !== 'OPEN') throw new Error(renderProjectedStatus(ctx, epoch));
        const rawEvaluation = evaluateCurrentWave(ctx, epoch, []);
        if (rawEvaluation.baselineMismatchIds.length > 0) throw new Error(`REVIEW_INVENTORY_BASELINE_FINDINGS_CHANGED: ${rawEvaluation.baselineMismatchIds.join(', ')}`);
        if (rawEvaluation.missingLanes.length > 0) throw new Error(`REVIEW_INVENTORY_LANES_INCOMPLETE: ${rawEvaluation.missingLanes.join(', ')}`);
        if (rawEvaluation.duplicateIdentities.length > 0) throw new Error(`REVIEW_INVENTORY_DUPLICATE_IDENTITY: ${rawEvaluation.duplicateIdentities.join(', ')}`);
        const findingDispositions = [...args.findingDispositions]
          .map(row => ({ ...row, findingId: row.findingId.trim(), familyKey: row.familyKey?.trim(), canonicalFindingId: row.canonicalFindingId?.trim(), reason: row.reason.trim() }))
          .sort((a, b) => a.findingId.localeCompare(b.findingId));
        const evaluation = evaluateCurrentWave(ctx, epoch, findingDispositions);
        if (evaluation.unresolvedFindingIds.length > 0) throw new Error(`REVIEW_INVENTORY_FINDING_DISPOSITION_INCOMPLETE: ${evaluation.unresolvedFindingIds.join(', ')}`);
        if (evaluation.invalidDispositionIds.length > 0) throw new Error(`REVIEW_INVENTORY_FINDING_DISPOSITION_INVALID: ${evaluation.invalidDispositionIds.join(', ')}`);
        const story = ctx.store.readStory(args.storyId);
        const run = assertCurrentReviewRunForEvidence(
          ctx.store, story, ctx.root, 'lattice-review-topology-critic', args.reviewRunId,
        );
        const passes = ctx.store.readReviewPasses(args.storyId).passes
          .filter(row => row.reviewRunId === run.reviewRunId && verifyReviewPass(args.storyId, row));
        const findings = ctx.store.readFindings(args.storyId).findings
          .filter(row => row.reviewRunId === run.reviewRunId && verifyFinding(args.storyId, row));
        const terminal = [...passes, ...findings];
        if (terminal.length === 0) throw new Error('REVIEW_INVENTORY_CRITIC_TERMINAL_MISSING: submit critic review_pass_set/finding_add first');
        if (terminal.some(row => !row.readManifest)) throw new Error('REVIEW_INVENTORY_CRITIC_READ_EVIDENCE_MISSING');
        const now = new Date().toISOString();
        const terminalEvidenceIds = terminal.map(row => row.id).sort();
        const readEvidence = terminal.map(row => ({ id: row.id, readManifest: row.readManifest ?? null, readLog: row.readLog?.digest ?? null }));
        const unsigned: Omit<ReviewInventoryCriticReceipt, '_hash'> = {
          schemaVersion: 'proofbound.review_inventory_critic_receipt.v1',
          criticReceiptId: `${epoch.epochId}:CRIT-${String(epoch.waves.length + 1).padStart(2, '0')}`,
          epochId: epoch.epochId,
          storyId: epoch.storyId,
          reviewRound: epoch.reviewRound,
          wave: epoch.waves.length + 1,
          cutoff: epoch.cutoff,
          aggregateFindingSetDigest: reviewInventoryDigest(reviewInventoryAggregateFamilies(epoch, evaluation)),
          requiredLaneCoverageDigest: reviewInventoryLaneCoverageDigest(evaluation),
          criticLane: 'lattice-review-topology-critic',
          reviewRunId: run.reviewRunId,
          terminalEvidenceIds,
          readEvidenceDigest: reviewInventoryDigest(readEvidence),
          findingDispositions,
          createdAt: now,
        };
        const receipt: ReviewInventoryCriticReceipt = { ...unsigned, _hash: signReviewInventoryCriticReceipt(unsigned) };
        const validated = validateReviewInventoryCriticReceipt({
          receipt, epoch, evaluation,
          runs: ctx.store.readReviewRuns(args.storyId).runs,
          passes: ctx.store.readReviewPasses(args.storyId).passes,
          findings: ctx.store.readFindings(args.storyId).findings,
        });
        if (!validated.ok) throw new Error(`REVIEW_INVENTORY_CRITIC_INVALID: ${validated.reason}`);
        const data = ctx.store.readReviewInventoryEpochs(args.storyId);
        const prior = data.criticReceipts.find(row => row.criticReceiptId === receipt.criticReceiptId);
        if (prior) {
          if (prior._hash !== receipt._hash) throw new Error(`review_inventory_critic_set: conflicting receipt ${receipt.criticReceiptId}`);
          return `Completeness critic: complete\nCritic receipt: ${receipt.criticReceiptId}`;
        }
        data.criticReceipts.push(receipt);
        ctx.store.writeReviewInventoryEpochs(args.storyId, data);
        return `Completeness critic: complete\nCritic receipt: ${receipt.criticReceiptId}`;
      });
    },

    review_inventory_finalize(args: { storyId: string }): string {
      return inventoryLock(ctx, args.storyId, () => {
        let epoch = currentOpenReviewInventory(ctx.store, args.storyId);
        if (!epoch) throw new Error(`review_inventory_finalize: no OPEN epoch for ${args.storyId}`);
        epoch = persistInvalidationIfDrifted(ctx, epoch);
        if (epoch.state !== 'OPEN') throw new Error(renderProjectedStatus(ctx, epoch));
        if (epoch.waves.length >= epoch.maxWaves) {
          throw new Error(`REVIEW_INVENTORY_BUDGET_EXHAUSTED: ${epoch.epochId}; replan/decompose/escalate, never manufacture PASS`);
        }
        const evaluation = evaluateCurrentWave(ctx, epoch);
        if (evaluation.baselineMismatchIds.length > 0) {
          throw new Error(`REVIEW_INVENTORY_BASELINE_FINDINGS_CHANGED: ${evaluation.baselineMismatchIds.join(', ')}; cancel and begin a fresh signed epoch`);
        }
        if (evaluation.missingLanes.length > 0) {
          throw new Error(`REVIEW_INVENTORY_LANES_INCOMPLETE: ${evaluation.missingLanes.join(', ')}; Next: lattice review_inventory_status --storyId=${args.storyId}`);
        }
        if (evaluation.duplicateIdentities.length > 0) {
          throw new Error(`REVIEW_INVENTORY_DUPLICATE_IDENTITY: ${evaluation.duplicateIdentities.join(', ')}; independent lane evidence required`);
        }
        const critic = validateReviewInventoryCriticReceipt({
          receipt: criticReceiptForCurrentWave(ctx, epoch),
          epoch,
          evaluation,
          runs: ctx.store.readReviewRuns(args.storyId).runs,
          passes: ctx.store.readReviewPasses(args.storyId).passes,
          findings: ctx.store.readFindings(args.storyId).findings,
        });
        if (!critic.ok) throw new Error(`REVIEW_INVENTORY_CRITIC_INCOMPLETE: ${critic.reason}; run the independent topology critic for wave ${epoch.waves.length + 1}`);
        const now = new Date().toISOString();
        const wave = buildWave(epoch, evaluation, now);
        const data = ctx.store.readReviewInventoryEpochs(args.storyId);
        if (!wave.saturated) {
          throw new Error(
            `REVIEW_INVENTORY_NEW_FINDINGS_REQUIRE_NEXT_WAVE: ${evaluation.newFamilies.join(', ')}; ` +
            `Next: lattice review_inventory_wave_advance --storyId=${args.storyId}`,
          );
        }
        const aggregateFamilies = wave.verifiedFindingFamilies;
        const receiptId = `${epoch.epochId}:RCP-001`;
        const unsignedReceipt: Omit<ReviewInventoryReceipt, '_hash'> = {
          schemaVersion: 'proofbound.review_inventory_receipt.v1',
          receiptId,
          epochId: epoch.epochId,
          storyId: epoch.storyId,
          reviewRound: epoch.reviewRound,
          cutoff: epoch.cutoff,
          scopeDigest: epoch.scopeDigest,
          requiredLanes: epoch.requiredLanes,
          waveCount: epoch.waves.length + 1,
          findingSetDigest: reviewInventoryDigest(aggregateFamilies),
          coverageDigest: reviewInventoryDigest([...epoch.waves, wave].flatMap(row => row.lanes.map(lane => lane.coverageDigest))),
          saturationResult: 'ZERO_NEW_VERIFIED_FINDINGS',
          authority: 'inventory-completeness-only',
          authorizesTest: false,
          issuedAt: now,
        };
        const receipt: ReviewInventoryReceipt = { ...unsignedReceipt, _hash: signReviewInventoryReceipt(unsignedReceipt) };
        const finalized = signEpoch({
          ...epoch,
          state: 'FINALIZED',
          updatedAt: now,
          waves: [...epoch.waves, wave],
          receiptId,
        });
        data.epochs = data.epochs.map(row => row.epochId === epoch!.epochId ? finalized : row);
        data.receipts.push(receipt);
        ctx.store.writeReviewInventoryEpochs(args.storyId, data);
        return `${renderReviewInventoryStatus(finalized, { criticComplete: true })}\nReceipt: ${receiptId}\nAuthority: inventory-completeness-only; authorizes TEST: false`;
      });
    },

    review_inventory_wave_advance(args: { storyId: string }): string {
      return inventoryLock(ctx, args.storyId, () => {
        let epoch = currentOpenReviewInventory(ctx.store, args.storyId);
        if (!epoch) throw new Error(`review_inventory_wave_advance: no OPEN epoch for ${args.storyId}`);
        epoch = persistInvalidationIfDrifted(ctx, epoch);
        if (epoch.state !== 'OPEN') throw new Error(renderProjectedStatus(ctx, epoch));
        if (epoch.waves.length >= epoch.maxWaves) {
          throw new Error(`REVIEW_INVENTORY_BUDGET_EXHAUSTED: ${epoch.epochId}; cancel and replan/decompose/escalate`);
        }
        const evaluation = evaluateCurrentWave(ctx, epoch);
        if (evaluation.baselineMismatchIds.length > 0) {
          throw new Error(`REVIEW_INVENTORY_BASELINE_FINDINGS_CHANGED: ${evaluation.baselineMismatchIds.join(', ')}; cancel and begin a fresh signed epoch`);
        }
        if (evaluation.missingLanes.length > 0) {
          throw new Error(`REVIEW_INVENTORY_LANES_INCOMPLETE: ${evaluation.missingLanes.join(', ')}`);
        }
        if (evaluation.duplicateIdentities.length > 0) {
          throw new Error(`REVIEW_INVENTORY_DUPLICATE_IDENTITY: ${evaluation.duplicateIdentities.join(', ')}`);
        }
        const critic = validateReviewInventoryCriticReceipt({
          receipt: criticReceiptForCurrentWave(ctx, epoch),
          epoch,
          evaluation,
          runs: ctx.store.readReviewRuns(args.storyId).runs,
          passes: ctx.store.readReviewPasses(args.storyId).passes,
          findings: ctx.store.readFindings(args.storyId).findings,
        });
        if (!critic.ok) throw new Error(`REVIEW_INVENTORY_CRITIC_INCOMPLETE: ${critic.reason}`);
        if (evaluation.newFamilies.length === 0) {
          throw new Error(`REVIEW_INVENTORY_ZERO_NEW_READY_TO_FINALIZE: Next: lattice review_inventory_finalize --storyId=${args.storyId}`);
        }
        const now = new Date().toISOString();
        const wave = buildWave(epoch, evaluation, now);
        const next = signEpoch({ ...epoch, updatedAt: now, waves: [...epoch.waves, wave] });
        const data = ctx.store.readReviewInventoryEpochs(args.storyId);
        data.epochs = data.epochs.map(row => row.epochId === epoch!.epochId ? next : row);
        ctx.store.writeReviewInventoryEpochs(args.storyId, data);
        return renderProjectedStatus(ctx, next);
      });
    },

    review_inventory_cancel(args: { storyId: string; reason: string }): string {
      return inventoryLock(ctx, args.storyId, () => {
        const data = ctx.store.readReviewInventoryEpochs(args.storyId);
        const epoch = data.epochs.at(-1);
        if (!epoch || !verifyReviewInventoryEpoch(epoch)
          || (epoch.state !== 'OPEN' && !(epoch.state === 'FINALIZED' && !epoch.consumedAt))) {
          throw new Error(`review_inventory_cancel: no OPEN or unconsumed FINALIZED epoch for ${args.storyId}`);
        }
        const finalizedReceipt = epoch.state === 'FINALIZED'
          ? data.receipts.find(row => row.receiptId === epoch.receiptId)
          : undefined;
        if (epoch.state === 'FINALIZED' && (!finalizedReceipt
          || !verifyReviewInventoryReceipt(finalizedReceipt)
          || finalizedReceipt.consumedAt || finalizedReceipt.invalidatedAt)) {
          throw new Error(`review_inventory_cancel: FINALIZED epoch ${epoch.epochId} has no valid unconsumed receipt to invalidate`);
        }
        const now = new Date().toISOString();
        const cancelled = signEpoch({
          ...epoch,
          state: 'CANCELLED',
          updatedAt: now,
          cancelledAt: now,
          cancelReason: args.reason.trim(),
        });
        data.epochs = data.epochs.map(row => row.epochId === epoch.epochId ? cancelled : row);
        if (epoch.state === 'FINALIZED' && epoch.receiptId) {
          data.receipts = data.receipts.map(row => {
            if (row.receiptId !== epoch.receiptId) return row;
            if (!verifyReviewInventoryReceipt(row) || row.consumedAt || row.invalidatedAt) {
              throw new Error(`review_inventory_cancel: receipt ${row.receiptId} is invalid or already consumed`);
            }
            const { _hash, ...unsigned } = row;
            const invalidated: Omit<ReviewInventoryReceipt, '_hash'> = {
              ...unsigned,
              invalidatedAt: now,
              invalidationReason: args.reason.trim(),
            };
            return { ...invalidated, _hash: signReviewInventoryReceipt(invalidated) };
          });
        }
        ctx.store.writeReviewInventoryEpochs(args.storyId, data);
        return renderReviewInventoryStatus(cancelled);
      });
    },
  };
}
