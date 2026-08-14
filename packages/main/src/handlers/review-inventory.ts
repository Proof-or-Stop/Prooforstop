import type { HandlerContext } from './context.js';
import { resolveStoryCommandWorkspace } from './context.js';
import { computeActiveReviewers } from './reviewer-list.js';
import { detectMdTouchpointsFromGit } from '../core/touchpoints-fallback.js';
import { captureReviewRunSnapshot } from '../core/review-run.js';
import { withMkdirLock } from '../core/mkdir-lock.js';
import type { ReviewInventoryEpoch, ReviewInventoryReceipt } from '../core/types.js';
import {
  buildWave,
  currentOpenReviewInventory,
  evaluateReviewInventoryWave,
  reviewInventoryDigest,
  signReviewInventoryEpoch,
  signReviewInventoryReceipt,
  verifyReviewInventoryEpoch,
} from '../core/review-inventory-epoch.js';

function signedRoot(ctx: HandlerContext, storyId: string): { root: string; metadataRoot: string } {
  const workspace = resolveStoryCommandWorkspace(ctx.store, storyId, ctx.root);
  const root = workspace.signedWorkspaceRoot || workspace.snapshotRoot;
  if (!root) throw new Error(`review inventory: cannot resolve signed workspace for ${storyId}`);
  return { root, metadataRoot: workspace.metadataRoot || ctx.root };
}

function signEpoch(epoch: Omit<ReviewInventoryEpoch, '_hash'>): ReviewInventoryEpoch {
  return { ...epoch, _hash: signReviewInventoryEpoch(epoch) };
}

function inventoryLock<T>(ctx: HandlerContext, storyId: string, fn: () => T): T {
  return withMkdirLock(ctx.store.runtimeLockDirPath(storyId, 'review-inventory', 'epochs'), fn, {
    label: `review inventory ${storyId}`,
  });
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

export function renderReviewInventoryStatus(epoch: ReviewInventoryEpoch): string {
  const wave = epoch.waves.length + (epoch.state === 'OPEN' ? 1 : 0);
  const last = epoch.waves.at(-1);
  const laneRows = epoch.requiredLanes.map(lane => {
    const terminal = last?.lanes.find(row => row.lane === lane);
    return `Lane ${lane}: ${terminal?.terminal ?? 'pending'}`;
  });
  const blockers: string[] = [];
  if (epoch.state === 'INVALIDATED') blockers.push('OPEN_REVIEW_INVENTORY_MATERIAL_MUTATION');
  if (epoch.state === 'OPEN' && epoch.waves.length >= epoch.maxWaves && !last?.saturated) blockers.push('REVIEW_INVENTORY_BUDGET_EXHAUSTED');
  let next: string;
  if (epoch.state === 'OPEN') {
    next = blockers.includes('REVIEW_INVENTORY_BUDGET_EXHAUSTED')
      ? `lattice review_inventory_cancel --storyId=${epoch.storyId} --reason="replan or decompose after wave budget exhaustion"`
      : `lattice review_inventory_finalize --storyId=${epoch.storyId}`;
  } else if (epoch.state === 'FINALIZED') {
    next = `lattice story_advance --storyId=${epoch.storyId} --phase=DEV`;
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
    `Verified findings: ${last?.verifiedFindingFamilies.length ?? 0}`,
    `New verified findings: ${last?.newVerifiedFindingCount ?? 0}`,
    `Blockers: ${blockers.join(', ') || 'none'}`,
    ...(epoch.invalidation ? [`Changed lineage: ${epoch.invalidation.oldMaterialHash} -> ${epoch.invalidation.currentMaterialHash}`] : []),
    `Next: ${next}`,
  ].join('\n');
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
          if (fresh.state === 'OPEN') return renderReviewInventoryStatus(fresh);
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
        const unsigned: Omit<ReviewInventoryEpoch, '_hash'> = {
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
        return renderReviewInventoryStatus(epoch);
      });
    },

    review_inventory_finalize(args: { storyId: string }): string {
      return inventoryLock(ctx, args.storyId, () => {
        let epoch = currentOpenReviewInventory(ctx.store, args.storyId);
        if (!epoch) throw new Error(`review_inventory_finalize: no OPEN epoch for ${args.storyId}`);
        epoch = persistInvalidationIfDrifted(ctx, epoch);
        if (epoch.state !== 'OPEN') throw new Error(renderReviewInventoryStatus(epoch));
        if (epoch.waves.length >= epoch.maxWaves) {
          throw new Error(`REVIEW_INVENTORY_BUDGET_EXHAUSTED: ${epoch.epochId}; replan/decompose/escalate, never manufacture PASS`);
        }
        const evaluation = evaluateReviewInventoryWave({
          epoch,
          runs: ctx.store.readReviewRuns(args.storyId).runs,
          passes: ctx.store.readReviewPasses(args.storyId).passes,
          findings: ctx.store.readFindings(args.storyId).findings,
        });
        if (evaluation.missingLanes.length > 0) {
          throw new Error(`REVIEW_INVENTORY_LANES_INCOMPLETE: ${evaluation.missingLanes.join(', ')}; Next: lattice review_inventory_status --storyId=${args.storyId}`);
        }
        if (evaluation.duplicateIdentities.length > 0) {
          throw new Error(`REVIEW_INVENTORY_DUPLICATE_IDENTITY: ${evaluation.duplicateIdentities.join(', ')}; independent lane evidence required`);
        }
        const now = new Date().toISOString();
        const wave = buildWave(epoch, evaluation, now);
        const data = ctx.store.readReviewInventoryEpochs(args.storyId);
        if (!wave.saturated) {
          const next = signEpoch({ ...epoch, updatedAt: now, waves: [...epoch.waves, wave] });
          data.epochs = data.epochs.map(row => row.epochId === epoch!.epochId ? next : row);
          ctx.store.writeReviewInventoryEpochs(args.storyId, data);
          return `${renderReviewInventoryStatus(next)}\nSaturation: new verified finding families require another full unchanged-material wave.`;
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
        return `${renderReviewInventoryStatus(finalized)}\nReceipt: ${receiptId}\nAuthority: inventory-completeness-only; authorizes TEST: false`;
      });
    },

    review_inventory_cancel(args: { storyId: string; reason: string }): string {
      return inventoryLock(ctx, args.storyId, () => {
        const epoch = currentOpenReviewInventory(ctx.store, args.storyId);
        if (!epoch) throw new Error(`review_inventory_cancel: no OPEN epoch for ${args.storyId}`);
        const now = new Date().toISOString();
        const cancelled = signEpoch({
          ...epoch,
          state: 'CANCELLED',
          updatedAt: now,
          cancelledAt: now,
          cancelReason: args.reason.trim(),
        });
        const data = ctx.store.readReviewInventoryEpochs(args.storyId);
        data.epochs = data.epochs.map(row => row.epochId === epoch.epochId ? cancelled : row);
        ctx.store.writeReviewInventoryEpochs(args.storyId, data);
        return renderReviewInventoryStatus(cancelled);
      });
    },
  };
}
