import { readMaterialDirtyFiles } from '../core/evidence-freshness.js';
import { commitReviewEpochMetadata } from '../core/review-metadata-batch.js';
import { readManagedHostRunBinding, readManagedReviewEvidenceProposal } from '../core/managed-host-run.js';
import { createManagedReviewEvidenceBinding, managedReviewerPromptDigest, verifyManagedReviewLiveBinding } from '../core/managed-review-evidence.js';
import { isManagedInventoryCritic, type ManagedInventoryFindingRef } from '../core/managed-inventory-critic.js';
import { recordConvergenceProgressUnlocked } from '../core/convergence-progress-journal.js';
import { collectOrphanPromptBodies } from '../core/prompt-body-gc.js';
import type { HandlerContext } from './context.js';
import { resolveStoryCommandWorkspace } from './context.js';
import { computeActiveReviewers, computeFinalReviewRoster, finalReviewRosterBasis } from './reviewer-list.js';
import { detectMdTouchpointsFromGit } from '../core/touchpoints-fallback.js';
import { assertCurrentReviewRunForEvidence, captureReviewRunSnapshot, verifyReviewRun } from '../core/review-run.js';
import type { ReviewInventoryCriticReceipt, ReviewInventoryEpoch, ReviewInventoryFindingDisposition, ReviewInventoryReceipt } from '../core/types.js';
import {
  buildWave,
  captureReviewInventoryBaselineFindingIds,
  currentOpenReviewInventory,
  evaluateReviewInventoryWave,
  finalizedUnconsumedReviewInventory,
  finalizedLiveAggregateError,
  reviewInventoryDigest,
  reviewInventoryAcceptanceSubjectDigestForStore,
  reviewInventoryAggregateFamilies,
  reviewInventoryLaneCoverageDigest,
  maxReviewRunSequence,
  signReviewInventoryEpoch,
  signReviewInventoryCriticReceipt,
  signReviewInventoryReceipt,
  validateReviewInventoryCriticReceipt,
  verifyReviewInventoryEpoch,
  verifyReviewInventoryReceipt,
  persistFinalizedReviewInventoryUnlocked,
  renderFinalizedReviewInventory,
  reviewInventoryFinalizedNextCommand,
  withReviewInventoryMutationLock,
  reviewInventoryPurposeBinding,
  inventoryPurposeMatchesEpoch,
} from '../core/review-inventory-epoch.js';
import { resolveAgentMutationAuthority } from '../core/agent-dispatch-registry.js';
import { canonicalAgentRoleId } from '../core/agent-role-identity.js';
import { verifyFinding, verifyReviewPass } from '../core/finding-verify.js';
import { verifyCandidateSpecSet } from '../core/candidate-spec-routing.js';
import { writeFileSync } from 'node:fs';

function holdFinalizeForDeterministicStress(): void {
  if (process.env.NODE_ENV !== 'test') return;
  const holdMs = Number(process.env.PROOF_OR_STOP_INTERNAL_REVIEW_INVENTORY_FINALIZE_HOLD_MS ?? 0);
  if (!Number.isFinite(holdMs) || holdMs <= 0) return;
  const readyFile = process.env.PROOF_OR_STOP_INTERNAL_REVIEW_INVENTORY_FINALIZE_READY_FILE;
  if (readyFile) writeFileSync(readyFile, `${process.pid}\n`, 'utf8');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
}

function signedRoot(ctx: HandlerContext, storyId: string): { root: string; metadataRoot: string } {
  const workspace = resolveStoryCommandWorkspace(ctx.store, storyId, ctx.root);
  const root = workspace.signedWorkspaceRoot || workspace.snapshotRoot;
  if (!root) throw new Error(`review inventory: cannot resolve signed workspace for ${storyId}`);
  return { root, metadataRoot: workspace.metadataRoot || ctx.root };
}

/** Inventory completion remains valid if optional progress observation is unavailable. */
function captureConvergenceProgress(ctx: HandlerContext, storyId: string, completedEpochId?: string): string {
  try {
    recordConvergenceProgressUnlocked(ctx.store, storyId, signedRoot(ctx, storyId).root, { completedEpochId });
    return '';
  } catch (error) {
    return `\nConvergence progress unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
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

export function captureReviewInventoryScope(ctx: HandlerContext, storyId: string): {
  scopeDigest: string;
  requiredLanes: string[];
  rosterBasis?: string;
  candidateSpecSetDigest?: string;
  corpusDigest?: string;
  candidateArtifactInvalid: boolean;
} {
  const story = ctx.store.readStory(storyId);
  const checklist = ctx.store.readChecklist(storyId);
  let decision = null;
  try { decision = ctx.store.readDecision(storyId); } catch { decision = null; }
  const understanding = ctx.store.readUnderstanding(storyId);
  const touchpoints = understanding?.touchpoints ?? detectMdTouchpointsFromGit(ctx.root);
  const roster = computeFinalReviewRoster(ctx.store, ctx.root, storyId, computeActiveReviewers(story, checklist, decision, touchpoints));
  const candidate = ctx.store.readCandidateSpecSet(storyId);
  const candidateArtifactInvalid = candidate !== null && !verifyCandidateSpecSet(candidate);
  const validCandidate = candidateArtifactInvalid ? null : candidate;
  return {
    requiredLanes: roster.requiredReviewers.map(row => canonicalAgentRoleId(`proof-or-stop-review-${row.name}`)),
    rosterBasis: finalReviewRosterBasis(roster),
    scopeDigest: reviewInventoryAcceptanceSubjectDigestForStore(ctx.store, storyId),
    // B-3f3d F-103: bind the candidate set's SEMANTICS, not its identity digest.
    // artifactDigest is the artifact's tamper-detection identity and deliberately
    // covers headHash/materialHash verbatim (candidate-spec-routing.ts), so reusing
    // it here made the OPEN-epoch barrier fire on freshness alone: re-running
    // candidate_spec_route (permitted in REVIEW) with byte-identical candidate
    // content after an unrelated commit ticked HEAD forward flipped the digest and
    // tripped OPEN_REVIEW_INVENTORY_CANDIDATE_ROUTING_MUTATION. Same defect class as
    // F-099, different consumer. artifactDigest is left untouched so verifyCandidateSpecSet
    // keeps detecting real tampering; only what the BARRIER compares is narrowed.
    // B-3f3d F-103/F-104: bind the candidate set's ROUTING UNIVERSE, not its
    // freshness. artifactDigest is the artifact's tamper-detection identity and
    // deliberately covers headHash/materialHash verbatim, so reusing it here fired
    // the OPEN-epoch barrier on freshness alone (F-103). Narrowing to a semantics
    // subset was still not enough (F-104): storyInputDigest is
    // digestCandidateRoutingValue(input) over a routing input that includes
    // changedPaths (git diff --name-only main...HEAD), and changedPaths ALSO seeds
    // keyword weights, so it leaks into candidates[].score/.reasons too — two
    // independent channels by which an unrelated commit flips the digest.
    // What actually defines the routing universe is WHICH specs were selected and
    // WHAT they contain, so bind path+contentHash per candidate plus the routing
    // policy knobs. A real corpus/selection change still invalidates; a re-route
    // that reselects the same specs with the same content does not.
    // artifactDigest stays untouched so verifyCandidateSpecSet keeps detecting
    // genuine tampering; only the BARRIER comparator is narrowed.
    candidateArtifactInvalid,
    ...(validCandidate ? {
      candidateSpecSetDigest: reviewInventoryDigest({
        schemaVersion: validCandidate.schemaVersion,
        mode: validCandidate.mode,
        // Candidate route ranking and changedPaths are intentionally allowed to
        // change ordering. The review barrier binds the selected semantic set, so
        // canonicalize only the path/contentHash projection while retaining each
        // row (including duplicate rows should a valid future schema permit them).
        candidates: validCandidate.candidates
          .map(row => ({ path: row.path, contentHash: row.contentHash }))
          .sort((left, right) => left.path.localeCompare(right.path, 'en') || left.contentHash.localeCompare(right.contentHash, 'en')),
        // B-3f3d F-107: queryFiltering is NOT bound. It records HOW candidates were
        // selected, not WHAT was selected, and it is freshness-derived through the
        // same channel as F-104: changedPaths (git diff --name-only main...HEAD)
        // seeds buildKeywordSeeds at weight 50, those seeds feed orderedQueryTerms,
        // and that produces filteredTerms. So an unrelated commit that only shifts
        // the changed-file set could add or drop a filteredTerms entry and invalidate
        // an OPEN epoch while the selected candidates[].{path,contentHash} stayed
        // byte-identical. scanEscalationReason stays bound: it is a routing-policy
        // outcome (whether the bounded search had to escalate), not diff-derived.
        scanEscalationReason: validCandidate.scanEscalationReason,
      }),
      corpusDigest: validCandidate.corpusDigest,
    } : {}),
  };
}

/** Observation only: an invalidated projection has no valid signature and is never stored. */
function projectInvalidationIfDrifted(ctx: HandlerContext, epoch: ReviewInventoryEpoch): ReviewInventoryEpoch {
  const current = capture(ctx, epoch.storyId);
  const currentScope = captureReviewInventoryScope(ctx, epoch.storyId);
  const materialChanged = current.materialHash !== epoch.cutoff.materialHash
    || (current.storyFilesHash ?? '') !== (epoch.cutoff.storyFilesHash ?? '');
  const scopeChanged = currentScope.scopeDigest !== epoch.scopeDigest
    || reviewInventoryDigest(currentScope.requiredLanes) !== reviewInventoryDigest(epoch.requiredLanes)
    || currentScope.rosterBasis !== epoch.rosterBasis;
  const candidateChanged = currentScope.candidateArtifactInvalid
    || (currentScope.candidateSpecSetDigest ?? '') !== (epoch.candidateSpecSetDigest ?? '')
    || (currentScope.corpusDigest ?? '') !== (epoch.corpusDigest ?? '');
  if (!materialChanged && !scopeChanged && !candidateChanged) return epoch;
  const now = new Date().toISOString();
  return {
    ...epoch,
    _hash: '',
    state: 'INVALIDATED',
    updatedAt: now,
    invalidation: {
      detectedAt: now,
      oldMaterialHash: epoch.cutoff.materialHash,
      currentMaterialHash: current.materialHash,
      ...(epoch.cutoff.storyFilesHash ? { oldStoryFilesHash: epoch.cutoff.storyFilesHash } : {}),
      ...(current.storyFilesHash ? { currentStoryFilesHash: current.storyFilesHash } : {}),
      blockerCode: currentScope.candidateArtifactInvalid
        ? 'OPEN_REVIEW_INVENTORY_INVALID_CANDIDATE_ARTIFACT'
        : candidateChanged
          ? 'OPEN_REVIEW_INVENTORY_CANDIDATE_ROUTING_MUTATION'
        : scopeChanged
          ? 'OPEN_REVIEW_INVENTORY_SCOPE_MUTATION'
          : 'OPEN_REVIEW_INVENTORY_MATERIAL_MUTATION',
      ...(scopeChanged ? {
        oldScopeDigest: epoch.scopeDigest,
        currentScopeDigest: currentScope.scopeDigest,
        oldRequiredLanes: epoch.requiredLanes,
        currentRequiredLanes: currentScope.requiredLanes,
      } : {}),
      ...(candidateChanged ? {
        oldCandidateSpecSetDigest: epoch.candidateSpecSetDigest,
        currentCandidateSpecSetDigest: currentScope.candidateSpecSetDigest,
        oldCorpusDigest: epoch.corpusDigest,
        currentCorpusDigest: currentScope.corpusDigest,
      } : {}),
    },
    terminalRunSequenceBoundary: maxReviewRunSequence(ctx.store.readReviewRuns(epoch.storyId).runs),
  };
}

function persistInvalidationIfDrifted(ctx: HandlerContext, epoch: ReviewInventoryEpoch): ReviewInventoryEpoch {
  const projection = projectInvalidationIfDrifted(ctx, epoch);
  if (projection === epoch) return epoch;
  const next = signEpoch(projection);
  const data = ctx.store.readReviewInventoryEpochs(epoch.storyId);
  data.epochs = data.epochs.map(row => row.epochId === epoch.epochId ? next : row);
  ctx.store.writeReviewInventoryEpochs(epoch.storyId, data);
  return next;
}

/** Must be called while the shared review-inventory mutation lock is held. */
export function assertReviewInventoryContextFreshLocked(ctx: HandlerContext, storyId: string): void {
  const epoch = currentOpenReviewInventory(ctx.store, storyId);
  if (!epoch) return;
  const refreshed = persistInvalidationIfDrifted(ctx, epoch);
  if (refreshed.state !== 'OPEN') throw new Error(renderProjectedStatus(ctx, refreshed));
}

/** Caller holds the inventory lock through dispatch/run publication. */
export function requireInventoryCriticSubjectLocked(ctx: HandlerContext, storyId: string, epochId: string) {
  const story = ctx.store.readStory(storyId);
  if (story.phase !== 'REVIEW' || !story.currentReviewRound) throw new Error('inventory purpose requires current REVIEW');
  assertReviewInventoryContextFreshLocked(ctx, storyId);
  const epoch = currentOpenReviewInventory(ctx.store, storyId);
  if (!epoch || epoch.epochId !== epochId || !verifyReviewInventoryEpoch(epoch)
    || ctx.store.readReviewInventoryEpochs(storyId).epochs.at(-1)?.epochId !== epochId
    || epoch.reviewRound !== story.currentReviewRound) throw new Error('inventory purpose requires the signed current OPEN epoch');
  const evaluation = evaluateCurrentWave(ctx, epoch, []);
  if (evaluation.missingLanes.length || evaluation.duplicateIdentities.length || evaluation.baselineMismatchIds.length) {
    throw new Error('inventory purpose requires complete current required-lane terminal evidence');
  }
  return reviewInventoryPurposeBinding(epoch);
}

/** Recompute and persist invalidation while the caller owns the shared lock. */
export function refreshReviewInventoryContextLocked(ctx: HandlerContext, storyId: string): ReviewInventoryEpoch | null {
  const epoch = currentOpenReviewInventory(ctx.store, storyId);
  return epoch ? persistInvalidationIfDrifted(ctx, epoch) : null;
}

export interface ReviewInventoryStatusProjection {
  evaluation?: ReturnType<typeof evaluateReviewInventoryWave>;
  criticComplete?: boolean;
  criticReviewRunId?: string;
  receipt?: ReviewInventoryReceipt;
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
  if (epoch.state === 'INVALIDATED') blockers.push(epoch.invalidation?.blockerCode ?? 'OPEN_REVIEW_INVENTORY_MATERIAL_MUTATION');
  if (epoch.state === 'FINALIZED' && epoch.consumedAt) blockers.push('REVIEW_INVENTORY_RECEIPT_ALREADY_CONSUMED');
  if (epoch.state === 'OPEN' && epoch.waves.length >= epoch.maxWaves && !last?.saturated) blockers.push('REVIEW_INVENTORY_BUDGET_EXHAUSTED');
  if (epoch.state === 'OPEN' && live?.missingLanes.length) blockers.push('REVIEW_INVENTORY_LANES_INCOMPLETE');
  if (epoch.state === 'OPEN' && live?.duplicateIdentities.length) blockers.push('REVIEW_INVENTORY_DUPLICATE_IDENTITY');
  if (epoch.state === 'OPEN' && live?.unresolvedFindingIds.length) blockers.push('REVIEW_INVENTORY_FINDING_DISPOSITION_INCOMPLETE');
  if (epoch.state === 'OPEN' && live?.invalidDispositionIds.length) blockers.push('REVIEW_INVENTORY_FINDING_DISPOSITION_INVALID');
  if (epoch.state === 'OPEN' && live?.baselineMismatchIds.length) blockers.push('REVIEW_INVENTORY_BASELINE_FINDINGS_CHANGED');
  if (epoch.state === 'OPEN' && live && live.missingLanes.length === 0
    && live.duplicateIdentities.length === 0 && !projection.criticComplete) blockers.push('REVIEW_INVENTORY_CRITIC_INCOMPLETE');
  let next: string;
  if (epoch.state === 'OPEN') {
    if (blockers.includes('REVIEW_INVENTORY_BUDGET_EXHAUSTED')) {
      next = `proof-or-stop review_inventory_cancel --storyId=${epoch.storyId} --reason="replan or decompose after wave budget exhaustion"`;
    } else if (live?.baselineMismatchIds.length) {
      next = `proof-or-stop review_inventory_cancel --storyId=${epoch.storyId} --reason="baseline finding set changed; reopen a fresh signed epoch"`;
    } else if (live?.missingLanes.length) {
      next = `proof-or-stop dispatch '{"storyId":"${epoch.storyId}","agentType":"${live.missingLanes[0]}"}'`;
    } else if (live?.duplicateIdentities.length) {
      next = `proof-or-stop review_inventory_cancel --storyId=${epoch.storyId} --reason="re-dispatch independent reviewer identities"`;
    } else if (live && !projection.criticComplete) {
      const conservativeDispositions = live.rawFindingIds.map(findingId => ({
        findingId,
        disposition: 'verified_family' as const,
        familyKey: `finding:${findingId}`,
        reason: 'Conservative executable default: retain this verified finding as its own family',
      }));
      next = projection.criticReviewRunId
        ? `proof-or-stop review_inventory_critic_set '${JSON.stringify({ storyId: epoch.storyId, epochId: epoch.epochId, reviewRunId: projection.criticReviewRunId, agent: 'proof-or-stop-review-topology-critic', findingDispositions: conservativeDispositions })}'`
        : `proof-or-stop dispatch '${JSON.stringify({ storyId: epoch.storyId, agentType: 'proof-or-stop-review-topology-critic', reviewPurpose: 'inventory-completeness', inventoryEpochId: epoch.epochId })}'`;
    } else if (live?.newFamilies.length) {
      next = `proof-or-stop review_inventory_finalize --storyId=${epoch.storyId} --remediation`;
    } else {
      next = `proof-or-stop review_inventory_finalize --storyId=${epoch.storyId}`;
    }
  } else if (epoch.state === 'FINALIZED') {
    next = reviewInventoryFinalizedNextCommand(epoch, projection.receipt);
  } else {
    next = `proof-or-stop review_inventory_begin --storyId=${epoch.storyId}`;
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
    ...(epoch.invalidation?.oldScopeDigest ? [`Changed scope: ${epoch.invalidation.oldScopeDigest} -> ${epoch.invalidation.currentScopeDigest}`] : []),
    ...(epoch.invalidation?.blockerCode === 'OPEN_REVIEW_INVENTORY_CANDIDATE_ROUTING_MUTATION'
      ? [`Changed candidate routing: ${epoch.invalidation.oldCandidateSpecSetDigest ?? 'none'} -> ${epoch.invalidation.currentCandidateSpecSetDigest ?? 'none'}; corpus ${epoch.invalidation.oldCorpusDigest ?? 'none'} -> ${epoch.invalidation.currentCorpusDigest ?? 'none'}`]
      : []),
    ...(epoch.invalidation?.blockerCode === 'OPEN_REVIEW_INVENTORY_INVALID_CANDIDATE_ARTIFACT'
      ? ['Invalid candidate routing artifact: persisted candidate-spec-set.json failed structural and artifactDigest verification.']
      : []),
    ...(epoch.state === 'FINALIZED' && !epoch.consumedAt
      ? [`Recovery for genuine late evidence: proof-or-stop review_inventory_cancel --storyId=${epoch.storyId} --reason="late evidence invalidated finalized receipt"; then begin a fresh epoch and fresh ReviewRun`]
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
  return evaluateReviewInventoryWave({ promptStore: ctx.store,
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
  return validateReviewInventoryCriticReceipt({ promptStore: ctx.store,
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
    .filter(run => verifyReviewRun(run, ctx.store) && canonicalAgentRoleId(run.lane) === 'proof-or-stop-review-topology-critic'
      && run.reviewPurpose === 'inventory-completeness' && inventoryPurposeMatchesEpoch(run.inventoryBinding, epoch)
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
    receipt: epoch.state === 'FINALIZED'
      ? ctx.store.readReviewInventoryEpochs(epoch.storyId).receipts.find(row => row.receiptId === epoch.receiptId)
      : undefined,
  });
}

export function renderReviewInventoryBegin(epoch: ReviewInventoryEpoch): string {
  return [
    `Review inventory epoch: ${epoch.epochId}`,
    'State: OPEN',
    `Frozen cutoff: ${epoch.cutoff.materialHash}`,
    `Next: proof-or-stop review_inventory_status --storyId=${epoch.storyId}`,
  ].join('\n');
}

export function assertOpenInventoryFresh(ctx: HandlerContext, storyId: string): void {
  inventoryLock(ctx, storyId, () => {
    const epoch = currentOpenReviewInventory(ctx.store, storyId);
    if (!epoch) return;
    const refreshed = persistInvalidationIfDrifted(ctx, epoch);
    if (refreshed.state !== 'OPEN') {
      throw new Error(
        `${refreshed.invalidation?.blockerCode ?? 'OPEN_REVIEW_INVENTORY_MATERIAL_MUTATION'}\nEpoch: ${epoch.epochId}\n` +
        `Changed lineage: ${refreshed.invalidation?.oldMaterialHash} -> ${refreshed.invalidation?.currentMaterialHash}\n` +
    `Recovery: proof-or-stop review_inventory_begin --storyId=${storyId}`,
      );
    }
  });
}

/** Receipt-only internal ingress. No caller-supplied verdict, actor or dispositions. */
export function importManagedInventoryCritic(ctx: HandlerContext, args: { runId: string; receiptId: string }): string {
  const managed = readManagedHostRunBinding(ctx.root, args.runId);
  if (!managed.storyId || !managed.reviewRunId || managed.profile !== 'managed_reviewer'
    || managed.lane !== 'proof-or-stop-review-topology-critic' || managed.agentType !== managed.lane) {
    throw new Error('managed inventory critic: wrong managed subject');
  }
  const storyId = managed.storyId;
  return inventoryLock(ctx, storyId, () => {
    const story = ctx.store.readStory(storyId);
    const run = assertCurrentReviewRunForEvidence(ctx.store, story, ctx.root, managed.lane!, managed.reviewRunId!);
    const expected = {
      providerHost: managed.host, headHash: run.headHash, materialHash: run.materialHash,
      storyFilesHash: run.storyFilesHash ?? run.workspaceBinding?.storyFilesHash ?? '',
      promptHash: run.promptHash, envelopeId: run.envelopeId ?? null,
      managedPromptDigest: managed.reviewBinding?.managedPromptDigest
        ?? managedReviewerPromptDigest(run.workspaceBinding?.metadataRoot ?? ctx.root, run),
    };
    const live = verifyManagedReviewLiveBinding({gitCwd: run.workspaceBinding?.signedWorkspaceRoot ?? ctx.root,
      metadataRoot: ctx.root, storyId, expected});
    if (!live.valid) throw new Error(`managed inventory critic: ${live.reason}`);
    const sealed = readManagedReviewEvidenceProposal(ctx.root, args.runId);
    const verified = createManagedReviewEvidenceBinding({root: ctx.root, storyId,
      providerAgent: managed.agentType, lane: managed.lane!, reviewRunId: run.reviewRunId,
      runId: args.runId, receiptId: args.receiptId, expected, importedAt: sealed?.authoredAt});
    const proposal = verified.verification.proposal;
    const block = proposal?.inventoryCritic;
    if (!proposal || !isManagedInventoryCritic(block, managed.lane!, managed.agentType, proposal.findings?.length ?? 0)) {
      throw new Error('managed inventory critic: authenticated disposition block missing or invalid');
    }
    const epoch = currentOpenReviewInventory(ctx.store, storyId);
    if (!epoch || block.epochId !== epoch.epochId || block.wave !== epoch.waves.length + 1
      || run.reviewPurpose !== 'inventory-completeness' || !inventoryPurposeMatchesEpoch(run.inventoryBinding, epoch)) {
      throw new Error('managed inventory critic: purpose or current wave mismatch');
    }
    const ownFindings = ctx.store.readFindings(storyId).findings.filter(f => f.reviewRunId === run.reviewRunId
      && f.managedEvidenceBinding?.runId === args.runId && f.managedEvidenceBinding?.receiptId === args.receiptId
      && verifyFinding(storyId, f));
    const resolve = (ref: ManagedInventoryFindingRef): string => {
      if ('findingId' in ref) return ref.findingId;
      const matches = ownFindings.filter(f => f.managedEvidenceBinding?.proposalFindingIndex === ref.proposalFindingIndex);
      if (matches.length !== 1) throw new Error('managed inventory critic: own finding index not uniquely imported');
      return matches[0].id;
    };
    const dirty = readMaterialDirtyFiles(run.workspaceBinding?.signedWorkspaceRoot ?? ctx.root, ctx.root);
    if (dirty.error || dirty.files.length) throw new Error(`managed inventory critic: material drift or unavailable status: ${dirty.files.join(', ')}`);
    return persistCriticReceipt(ctx, {storyId, epochId: block.epochId, reviewRunId: run.reviewRunId,
      findingDispositions: block.findingDispositions.map(row => ({findingId: resolve(row.finding),
        disposition: row.disposition, reason: row.reason, ...(row.familyKey ? {familyKey: row.familyKey} : {}),
        ...(row.canonicalFinding ? {canonicalFindingId: resolve(row.canonicalFinding)} : {})}))});
  });
}

interface CriticReceiptInput {
  storyId: string;
  epochId: string;
  reviewRunId: string;
  findingDispositions: ReviewInventoryFindingDisposition[];
}
// Private shared writer: callers establish native or authenticated managed authority,
// and hold the inventory lock. This helper is not a public command or bypass.
function persistCriticReceipt(ctx: HandlerContext, args: CriticReceiptInput): string {
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
    ctx.store, story, ctx.root, 'proof-or-stop-review-topology-critic', args.reviewRunId,
  );
  if (run.reviewPurpose !== 'inventory-completeness' || !inventoryPurposeMatchesEpoch(run.inventoryBinding, epoch)) {
    throw new Error('REVIEW_INVENTORY_CRITIC_PURPOSE_REQUIRED: dispatch and run explicit inventory-completeness review');
  }
  const passes = ctx.store.readReviewPasses(args.storyId).passes
    .filter(row => row.reviewRunId === run.reviewRunId && verifyReviewPass(args.storyId, row));
  const findings = ctx.store.readFindings(args.storyId).findings
    .filter(row => row.reviewRunId === run.reviewRunId && verifyFinding(args.storyId, row));
  const terminal = [...passes, ...findings];
  if (terminal.length === 0) throw new Error('REVIEW_INVENTORY_CRITIC_TERMINAL_MISSING: submit critic review_pass_set/finding_add first');
  if (terminal.some(row => !row.readManifest)) throw new Error('REVIEW_INVENTORY_CRITIC_READ_EVIDENCE_MISSING');
  const existing = criticReceiptForCurrentWave(ctx, epoch);
  const now = existing?.createdAt ?? new Date().toISOString();
  const terminalEvidenceIds = terminal.map(row => row.id).sort();
  const readEvidence = terminal.map(row => ({ id: row.id, readManifest: row.readManifest ?? null, readLog: row.readLog?.digest ?? null }));
  const unsigned: Omit<ReviewInventoryCriticReceipt, '_hash'> = {
    schemaVersion: 'proof-or-stop.review_inventory_critic_receipt.v1',
    criticReceiptId: `${epoch.epochId}:CRIT-${String(epoch.waves.length + 1).padStart(2, '0')}`,
    epochId: epoch.epochId,
    storyId: epoch.storyId,
    reviewRound: epoch.reviewRound,
    wave: epoch.waves.length + 1,
    cutoff: epoch.cutoff,
    aggregateFindingSetDigest: reviewInventoryDigest(reviewInventoryAggregateFamilies(epoch, evaluation)),
    requiredLaneCoverageDigest: reviewInventoryLaneCoverageDigest(evaluation),
    criticLane: 'proof-or-stop-review-topology-critic',
    reviewRunId: run.reviewRunId,
    reviewPurpose: 'inventory-completeness',
    inventoryBinding: run.inventoryBinding,
    terminalEvidenceIds,
    readEvidenceDigest: reviewInventoryDigest(readEvidence),
    findingDispositions,
    createdAt: now,
  };
  const receipt: ReviewInventoryCriticReceipt = { ...unsigned, _hash: signReviewInventoryCriticReceipt(unsigned) };
  const validated = validateReviewInventoryCriticReceipt({ promptStore: ctx.store,
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
}

export function createReviewInventoryHandlers(ctx: HandlerContext) {
  return {
    review_prompt_gc(args: { storyId: string }): string {
      ctx.store.readStory(args.storyId);
      const result = collectOrphanPromptBodies(ctx.store, args.storyId);
      return `Review prompt GC: removed=${result.removed} retained=${result.retained}; signed metadata unchanged`;
    },
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
            `Next: ${reviewInventoryFinalizedNextCommand(pendingReceipt.epoch, pendingReceipt.receipt)}`,
          );
        }
        const {
          requiredLanes,
          rosterBasis,
          scopeDigest,
          candidateSpecSetDigest,
          corpusDigest,
          candidateArtifactInvalid,
        } = captureReviewInventoryScope(ctx, args.storyId);
        const cutoff = capture(ctx, args.storyId);
        const data = ctx.store.readReviewInventoryEpochs(args.storyId);
        const epochNum = data.epochs.reduce((max, row) => {
          const match = row.epochId.match(/:RI-(\d+)$/);
          return match ? Math.max(max, Number(match[1])) : max;
        }, 0) + 1;
        const now = new Date().toISOString();
        const provisional: Omit<ReviewInventoryEpoch, '_hash'> = {
          schemaVersion: 'proof-or-stop.review_inventory_epoch.v1',
          epochId: `${args.storyId}:RI-${String(epochNum).padStart(3, '0')}`,
          storyId: args.storyId,
          reviewRound: story.currentReviewRound,
          // A persisted candidate artifact can be syntactically signed-looking while
          // still failing the structural verifier. Never publish an OPEN epoch in
          // that state: record the terminal blocker in the same signed write so
          // callers receive a durable, rendered recovery state rather than a
          // transiently admissible inventory.
          state: candidateArtifactInvalid ? 'INVALIDATED' : 'OPEN',
          begunAt: now,
          updatedAt: now,
          cutoff,
          scopeDigest,
          ...(candidateSpecSetDigest ? { candidateSpecSetDigest } : {}),
          ...(corpusDigest ? { corpusDigest } : {}),
          requiredLanes,
          ...(rosterBasis ? { rosterBasis } : {}),
          initialRunSequenceBoundary: maxReviewRunSequence(ctx.store.readReviewRuns(args.storyId).runs),
          maxWaves: args.maxWaves ?? 3,
          waves: [],
          ...(candidateArtifactInvalid ? {
            invalidation: {
              detectedAt: now,
              oldMaterialHash: cutoff.materialHash,
              currentMaterialHash: cutoff.materialHash,
              ...(cutoff.storyFilesHash ? {
                oldStoryFilesHash: cutoff.storyFilesHash,
                currentStoryFilesHash: cutoff.storyFilesHash,
              } : {}),
              blockerCode: 'OPEN_REVIEW_INVENTORY_INVALID_CANDIDATE_ARTIFACT' as const,
            },
            terminalRunSequenceBoundary: maxReviewRunSequence(ctx.store.readReviewRuns(args.storyId).runs),
          } : {}),
        };
        const baselineFindingIds = captureReviewInventoryBaselineFindingIds({ promptStore: ctx.store,
          epoch: { ...provisional, _hash: '' },
          runs: ctx.store.readReviewRuns(args.storyId).runs,
          findings: ctx.store.readFindings(args.storyId).findings,
        });
        const unsigned: Omit<ReviewInventoryEpoch, '_hash'> = { ...provisional, baselineFindingIds };
        const epoch = signEpoch(unsigned);
        data.epochs.push(epoch);
        ctx.store.writeReviewInventoryEpochs(args.storyId, data);
        return (candidateArtifactInvalid ? renderReviewInventoryStatus(epoch) : renderReviewInventoryBegin(epoch)) + captureConvergenceProgress(ctx, args.storyId);
      });
    },

    review_inventory_status(args: { storyId: string; refresh?: boolean }): string {
      if (args.refresh !== undefined && typeof args.refresh !== 'boolean') {
        throw new Error('review_inventory_status: refresh must be boolean');
      }
      const inspect = () => {
        const data = ctx.store.readReviewInventoryEpochs(args.storyId);
        let epoch = data.epochs.at(-1);
        if (!epoch) throw new Error(`review_inventory_status: no epoch for ${args.storyId}`);
        if (!verifyReviewInventoryEpoch(epoch)) throw new Error(`review_inventory_status: epoch ${epoch.epochId} signature mismatch`);
        if (epoch.state === 'OPEN') epoch = args.refresh === true
          ? persistInvalidationIfDrifted(ctx, epoch)
          : projectInvalidationIfDrifted(ctx, epoch);
        return renderProjectedStatus(ctx, epoch)
          + (args.refresh === true ? '' : '\nRead-only observation; persisted evidence is unchanged.');
      };
      // Only the explicit writer takes the mutation lock. Gate consumers still
      // independently check current lineage under their existing producer lock.
      return args.refresh === true ? inventoryLock(ctx, args.storyId, inspect) : inspect();
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
      if (!authority.actor || canonicalAgentRoleId(authority.actor) !== 'proof-or-stop-review-topology-critic') {
        throw new Error('review_inventory_critic_set: only proof-or-stop-review-topology-critic may write critic authority');
      }
      return inventoryLock(ctx, args.storyId, () => {
        return persistCriticReceipt(ctx, args);
      });
    },

    review_inventory_finalize(args: { storyId: string; remediation?: boolean }): string {
      return inventoryLock(ctx, args.storyId, () => {
        let epoch = currentOpenReviewInventory(ctx.store, args.storyId);
        if (!epoch) {
          const story = ctx.store.readStory(args.storyId);
          const cutoff = capture(ctx, args.storyId);
          if (!cutoff.headHash || !cutoff.materialHash || !cutoff.storyFilesHash) {
            throw new Error(
              'review_inventory_finalize: current headHash/materialHash/storyFilesHash are missing; refuse rather than invent a second freshness hash',
            );
          }
          const retained = finalizedUnconsumedReviewInventory(ctx.store, args.storyId);
          if (retained && retained.epoch.waves.length > 0 && retained.epoch.requiredLanes.length > 0) {
            if ((args.remediation === true) !== (retained.receipt.authority === 'review-remediation-only')) {
              throw new Error('REVIEW_INVENTORY_FINALIZE_REPLAY_AUTHORITY: retry must preserve the original remediation flag and receipt authority');
            }
            if (retained.epoch.reviewRound !== (story.currentReviewRound ?? '')
              || retained.epoch.cutoff.materialHash !== cutoff.materialHash
              || (retained.epoch.cutoff.storyFilesHash ?? '') !== (cutoff.storyFilesHash ?? '')
              || retained.epoch.scopeDigest !== reviewInventoryAcceptanceSubjectDigestForStore(ctx.store, args.storyId)) {
              throw new Error('REVIEW_INVENTORY_FINALIZE_REPLAY_DRIFT: the completed epoch subject changed; cancel and begin a fresh review');
            }
            const invalid = finalizedLiveAggregateError(ctx.store, retained);
            if (invalid) throw new Error(`REVIEW_INVENTORY_FINALIZE_REPLAY_INVALID: ${invalid}`);
            return renderFinalizedReviewInventory(retained.epoch, retained.receipt)
              + captureConvergenceProgress(ctx, args.storyId, retained.epoch.epochId)
              + commitReviewEpochMetadata(ctx.store, ctx.root, args.storyId, args.remediation ? 'review_inventory_finalize --remediation' : 'review_inventory_finalize');
          }
          if (args.remediation) throw new Error('REVIEW_INVENTORY_REMEDIATION_REQUIRES_COMPLETE_OPEN_WAVE');
          const persisted = persistFinalizedReviewInventoryUnlocked({
            store: ctx.store,
            storyId: args.storyId,
            reviewRound: story.currentReviewRound ?? '',
            cutoff,
          });
          // A valid receipt may predate a failed optional observation write.
          // Retry that observation, but never count a zero-wave compatibility receipt.
          const progress = persisted.epoch.waves.length && persisted.epoch.requiredLanes.length
            ? captureConvergenceProgress(ctx, args.storyId, persisted.epoch.epochId) : '';
          return renderFinalizedReviewInventory(persisted.epoch, persisted.receipt) + progress
            + commitReviewEpochMetadata(ctx.store, ctx.root, args.storyId, args.remediation ? 'review_inventory_finalize --remediation' : 'review_inventory_finalize');
        }
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
          throw new Error(`REVIEW_INVENTORY_LANES_INCOMPLETE: ${evaluation.missingLanes.join(', ')}; Next: proof-or-stop review_inventory_status --storyId=${args.storyId}`);
        }
        if (evaluation.duplicateIdentities.length > 0) {
          throw new Error(`REVIEW_INVENTORY_DUPLICATE_IDENTITY: ${evaluation.duplicateIdentities.join(', ')}; independent lane evidence required`);
        }
        const critic = validateReviewInventoryCriticReceipt({ promptStore: ctx.store,
          receipt: criticReceiptForCurrentWave(ctx, epoch),
          epoch,
          evaluation,
          runs: ctx.store.readReviewRuns(args.storyId).runs,
          passes: ctx.store.readReviewPasses(args.storyId).passes,
          findings: ctx.store.readFindings(args.storyId).findings,
        });
        if (!critic.ok) throw new Error(`REVIEW_INVENTORY_CRITIC_INCOMPLETE: ${critic.reason}; run the independent topology critic for wave ${epoch.waves.length + 1}`);
        // Test-only barrier holds the real shared inventory critical section
        // after every finalize admission check and before receipt publication.
        holdFinalizeForDeterministicStress();
        const now = new Date().toISOString();
        const wave = buildWave(epoch, evaluation, now, maxReviewRunSequence(ctx.store.readReviewRuns(args.storyId).runs));
        const data = ctx.store.readReviewInventoryEpochs(args.storyId);
        if (!wave.saturated && args.remediation !== true) {
          throw new Error(
            `REVIEW_INVENTORY_NEW_FINDINGS_REQUIRE_NEXT_WAVE: ${evaluation.newFamilies.join(', ')}; ` +
            `Next: proof-or-stop review_inventory_wave_advance --storyId=${args.storyId}`,
          );
        }
        const aggregateFamilies = wave.verifiedFindingFamilies;
        const receiptId = `${epoch.epochId}:RCP-001`;
        const unsignedReceipt: Omit<ReviewInventoryReceipt, '_hash'> = {
          schemaVersion: 'proof-or-stop.review_inventory_receipt.v1',
          receiptId,
          epochId: epoch.epochId,
          storyId: epoch.storyId,
          reviewRound: epoch.reviewRound,
          cutoff: epoch.cutoff,
          scopeDigest: epoch.scopeDigest,
          requiredLanes: epoch.requiredLanes,
          ...(epoch.rosterBasis ? { rosterBasis: epoch.rosterBasis } : {}),
          waveCount: epoch.waves.length + 1,
          findingSetDigest: reviewInventoryDigest(aggregateFamilies),
          coverageDigest: reviewInventoryDigest([...epoch.waves, wave].flatMap(row => row.lanes.map(lane => lane.coverageDigest))),
          saturationResult: args.remediation ? 'NOT_EVALUATED_FOR_REMEDIATION' : 'ZERO_NEW_VERIFIED_FINDINGS',
          authority: args.remediation ? 'review-remediation-only' : 'inventory-completeness-only',
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
        return `${renderReviewInventoryStatus(finalized, { criticComplete: true, receipt })}\nReceipt: ${receiptId}\nAuthority: ${receipt.authority}; authorizes TEST: ${receipt.authorizesTest}${captureConvergenceProgress(ctx, args.storyId, finalized.epochId)}${commitReviewEpochMetadata(ctx.store, ctx.root, args.storyId, args.remediation ? 'review_inventory_finalize --remediation' : 'review_inventory_finalize')}`;
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
        const critic = validateReviewInventoryCriticReceipt({ promptStore: ctx.store,
          receipt: criticReceiptForCurrentWave(ctx, epoch),
          epoch,
          evaluation,
          runs: ctx.store.readReviewRuns(args.storyId).runs,
          passes: ctx.store.readReviewPasses(args.storyId).passes,
          findings: ctx.store.readFindings(args.storyId).findings,
        });
        if (!critic.ok) throw new Error(`REVIEW_INVENTORY_CRITIC_INCOMPLETE: ${critic.reason}`);
        if (evaluation.newFamilies.length === 0) {
          throw new Error(`REVIEW_INVENTORY_ZERO_NEW_READY_TO_FINALIZE: Next: proof-or-stop review_inventory_finalize --storyId=${args.storyId}`);
        }
        const now = new Date().toISOString();
        const wave = buildWave(epoch, evaluation, now, maxReviewRunSequence(ctx.store.readReviewRuns(args.storyId).runs));
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
        if (epoch?.state === 'CANCELLED' && verifyReviewInventoryEpoch(epoch)) {
          if (epoch.cancelReason !== args.reason.trim()) throw new Error('review_inventory_cancel: retry must preserve the original cancellation reason');
          return renderReviewInventoryStatus(epoch) + commitReviewEpochMetadata(ctx.store, ctx.root, args.storyId, 'review_inventory_cancel');
        }
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
          terminalRunSequenceBoundary: maxReviewRunSequence(ctx.store.readReviewRuns(args.storyId).runs),
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
        return renderReviewInventoryStatus(cancelled) + commitReviewEpochMetadata(ctx.store, ctx.root, args.storyId, 'review_inventory_cancel');
      });
    },
  };
}
