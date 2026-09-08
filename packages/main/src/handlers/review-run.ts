import { execFileSync } from 'child_process';
import { writeFileSync } from 'node:fs';
import type { HandlerContext } from './context.js';
import { resolveStoryCommandWorkspace } from './context.js';
import type { ReviewRun, ReviewScopeBinding } from '../core/types.js';
import {
  buildReviewRunWorkspaceBinding,
  ensureCurrentReviewRound,
  captureReviewRunSnapshot,
  hashReviewPrompt,
  resolveReviewRunLane,
  signReviewRun,
  verifyReviewRun,
  verifyCurrentReviewerDispatchBinding,
} from '../core/review-run.js';
import { buildScopeDiffPack } from '../core/scope-diff-pack.js';
import { computeReviewScopeBinding } from '../core/review-scope-binding.js';
import { readTrustedProofStoryScopeArtifacts } from '../core/closeout-trust.js';
import { withReviewMetadataTicketLock } from '../core/mkdir-lock.js';
import { loadConfig } from '../core/config.js';
import {
  readGitStatusLines,
  classifierOptionsForCheck,
  classifyGitStatusRows,
  isBlockingDirty,
} from '../core/dirty-worktree-gate.js';
import { resolveAgentMutationAuthority, validateCriticReviewPurpose } from '../core/agent-dispatch-registry.js';
import {
  promptRoleContract,
  resolvePromptRoleBody,
} from '../core/prompt-role-contract-registry.js';
import { readPromptRegistry } from '../core/prompt-registry.js';
import { agentRoleIdsEqual } from '../core/agent-role-identity.js';
import { BASELINE_RUNTIME_CONTRACT } from '../core/prompt-measurement.js';
import {
  assembleConditionalReviewPromptEnvelope,
  buildFullTaskContext,
  verifyPromptEnvelopeIntegrity,
} from '../core/prompt-envelope.js';
import { reviewIncrementalContext } from '../core/review-incremental-context.js';
import { currentOpenReviewInventory, assertReviewInventoryCutoff, withReviewInventoryMutationLock } from '../core/review-inventory-epoch.js';
import { assertReviewInventoryContextFreshLocked, requireInventoryCriticSubjectLocked } from './review-inventory.js';

function withReviewMetadataTransactionLock<T>(ctx: HandlerContext, storyId: string, fn: () => T): T {
  const lockDir = ctx.store.runtimeLockDirPath(storyId, 'review-run', 'review-runs');
  return withReviewMetadataTicketLock(lockDir, `review_run_start for ${storyId}`, fn);
}

function holdInventoryLockForDeterministicRunPublicationStress(): void {
  if (process.env.NODE_ENV !== 'test') return;
  const holdMs = Number(process.env.LATTICE_INTERNAL_REVIEW_RUN_HOLD_MS ?? 0);
  if (!Number.isFinite(holdMs) || holdMs <= 0) return;
  const readyFile = process.env.LATTICE_INTERNAL_REVIEW_RUN_READY_FILE;
  if (readyFile) writeFileSync(readyFile, `${process.pid}\n`, 'utf8');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
}

type ResolvedReviewWorkspace = ReturnType<typeof resolveStoryCommandWorkspace>;

function resolveSignedWorkspaceRoot(workspace: ResolvedReviewWorkspace, storyId: string): string {
  const signedWorkspaceRoot = workspace.signedWorkspaceRoot || workspace.snapshotRoot;
  if (!signedWorkspaceRoot) {
    throw new Error(
      `review_run_start: story ${storyId} cannot resolve a git-backed signed workspace.\n` +
      `metadataRoot: ${workspace.metadataRoot}\n` +
      `signedWorkspaceRoot: unresolved\n` +
      `Reason: ${workspace.unresolvedReason || 'requires_git_signed_workspace_but_no_binding'}\n` +
      'No reviewer run was created. Local host output is diagnostic only and no local proof-admissibility evidence was produced.',
    );
  }
  return signedWorkspaceRoot;
}

function resolveGitTopLevel(gitCwd: string): string | null {
  // B-75f0 CHK-004: param named `gitCwd` because the sole caller
  // (review_run_start, below) passes the already-resolved signedWorkspaceRoot
  // (authoritativeCwd), never a bare metadataRoot. Pure rename, zero behavior
  // change — the inbound value is unchanged.
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

export function createReviewRunHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    review_run_list(args: {
      storyId: string;
      lane?: string;
      latest?: boolean;
      json?: boolean;
    }): string {
      if (!args.storyId) throw new Error('review_run_list: storyId is required');
      store.readStory(args.storyId);
      const lane = args.lane?.trim();
      if (args.lane !== undefined && !lane) throw new Error('review_run_list: lane must be nonblank when provided');

      // Recovery reader for a run that was durably published before a host timed
      // out while consuming the intentionally large assembled review prompt.
      // Return only signed, compact metadata: this reader neither mints evidence
      // nor exposes prompt bytes that can be mistaken for a newly issued prompt.
      const matchingRuns = store.readReviewRuns(args.storyId).runs
        .filter(run => (!lane || agentRoleIdsEqual(run.lane, lane)))
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.reviewRunId.localeCompare(left.reviewRunId));
      const runs = (args.latest ? matchingRuns.slice(0, 1) : matchingRuns)
        .map(run => ({
          reviewRunId: run.reviewRunId,
          lane: run.lane,
          agent: run.agent,
          reviewRound: run.reviewRound,
          startedAt: run.startedAt,
          headHash: run.headHash,
          materialHash: run.materialHash,
          storyFilesHash: run.storyFilesHash ?? null,
          signatureValid: verifyReviewRun(run),
        }));
      const report = {
        schemaVersion: 'proofbound.review_run_list.v1',
        storyId: args.storyId,
        lane: lane ?? null,
        latest: args.latest === true,
        runs,
      };
      if (args.json) return JSON.stringify(report);
      return [
        `Review runs: ${args.storyId}${lane ? ` lane=${lane}` : ''}${args.latest ? ' latest=true' : ''}`,
        ...(runs.length === 0
          ? ['  (none)']
          : runs.map(run => `  ${run.reviewRunId} lane=${run.lane} started=${run.startedAt} signature=${run.signatureValid ? 'valid' : 'invalid'}`)),
      ].join('\n');
    },

    review_run_start(args: {
      storyId: string;
      agent?: string;
      lane?: string;
      reviewedIntentRefs?: string[];
      reviewerEscalationReason?: string;
      reviewPurpose?: 'topology' | 'inventory-completeness';
      inventoryEpochId?: string;
    }): string {
      const authority = resolveAgentMutationAuthority({
        command: 'review_run_start',
        payloadActors: [args.agent, args.lane],
      });
      const workspace = resolveStoryCommandWorkspace(store, args.storyId, ctx.root);
      const signedWorkspaceRoot = resolveSignedWorkspaceRoot(workspace, args.storyId);
      const preflightStory = store.readStory(args.storyId);
      if (preflightStory.phase !== 'REVIEW') {
        throw new Error(
          `review_run_start: story ${args.storyId} must be in REVIEW phase (current: ${preflightStory.phase})`,
        );
      }

      // B-7691: material-source clean-tree preflight. Reuse the DONE gate's
      // shared git-status read + DIRTY_GATE_POLICY blocking table so a reviewer
      // cannot snapshot a run over uncommitted material-source / fixture drift.
      // Fail-OPEN on an unreadable git status (convenience gate; mirrors how the
      // DONE gate tolerates an unreadable status) — never throw on a broken read.
      // The DONE verdict, materialHash computation, and the evidence-write-time
      // freshness guard are NOT touched; this only READS DIRTY_GATE_POLICY.
      const preflightRoot = workspace.metadataRoot || ctx.root;
      const status = readGitStatusLines(signedWorkspaceRoot);
      if (status.ok) {
        const classification = classifyGitStatusRows(
          status.lines,
          classifierOptionsForCheck(loadConfig(preflightRoot), args.storyId, store, preflightRoot),
        );
        const b = isBlockingDirty(classification);
        if (b.blocked) {
          throw new Error(
            `review_run_start: git working tree has uncommitted ${b.blockingCategories.join('/')} changes ` +
            `(${b.blockingPaths.slice(0, 5).join(', ')}). ` +
            'Commit or revert all code/config changes, then rerun review_run_start.',
          );
        }
      }
      // status.ok === false → fail-open: after this preflight declines to block, proceed to the snapshot.

      const lane = resolveReviewRunLane(authority.actor, args.lane);
      validateCriticReviewPurpose(lane, args.reviewPurpose, args.inventoryEpochId);
      const reviewerEscalationReason = args.reviewerEscalationReason?.trim();
      if (args.reviewerEscalationReason !== undefined && !reviewerEscalationReason) {
        throw new Error('review_run_start: reviewerEscalationReason must be nonblank when provided');
      }
      // The inventory lock is the linearization boundary for the complete
      // ReviewRun publication: snapshot/precheck, monotonic RR allocation,
      // Prompt Envelope write, and durable ReviewRun write are indivisible
      // relative to wave/cancel/begin transitions.
      return withReviewInventoryMutationLock(store, args.storyId, () => {
      const startedAt = new Date().toISOString();
      // B-9dcb CHK-002: thread the resolved metadataRoot into the snapshot so the
      // storyDir-aware material/story hash exclusion loads proof-or-stop.config.json
      // from the metadataRoot (where a CUSTOM storyDir is declared), NOT the
      // gitRoot. This matches buildReviewRunWorkspaceBinding.metadataRoot below,
      // so the persisted binding is authoritative and consumers recompute
      // freshness against the same root (no false-stale on wrapper-root layouts).
      const { headHash, materialHash, storyFilesHash } = captureReviewRunSnapshot(signedWorkspaceRoot, {
        storyId: args.storyId,
        storyPhase: preflightStory.phase,
        currentReviewRound: preflightStory.currentReviewRound,
        workspaceMode: workspace.workspaceMode || workspace.resolutionSource || workspace.mode,
        expectedWorktreeRoot: workspace.expectedWorktreeRoot,
      }, workspace.metadataRoot || ctx.root);
      assertReviewInventoryContextFreshLocked(ctx, args.storyId);
      assertReviewInventoryCutoff(store, args.storyId, { materialHash, storyFilesHash });
      const inventoryBinding = args.reviewPurpose === 'inventory-completeness'
        ? requireInventoryCriticSubjectLocked(ctx, args.storyId, args.inventoryEpochId!) : undefined;
      if (inventoryBinding) {
        const dispatch = verifyCurrentReviewerDispatchBinding({ store, storyId: args.storyId, lane,
          reviewRound: preflightStory.currentReviewRound!, projectRoot: workspace.metadataRoot || ctx.root,
          reviewPurpose: args.reviewPurpose, inventoryBinding });
        if (!dispatch.ok) throw new Error(`review_run_start: ${dispatch.reason}`);
      }
      // Test-only barrier proves cancel/wave checkpoints cannot linearize
      // between the inventory precheck and durable RR publication.
      holdInventoryLockForDeterministicRunPublicationStress();
      const workspaceBinding = buildReviewRunWorkspaceBinding({
        metadataRoot: workspace.metadataRoot || ctx.root,
        invocationCwd: workspace.cwd || process.cwd(),
        repoRoot: workspace.repoRoot ?? resolveGitTopLevel(signedWorkspaceRoot),
        signedWorkspaceRoot,
        workspaceMode: workspace.workspaceMode || workspace.resolutionSource || workspace.mode,
        headHash,
        materialHash,
        storyFilesHash,
      });
      const story = ensureCurrentReviewRound(store, args.storyId, 'review_run_start');

      // B-6bfd CHK-005: for a scope-protected story, capture the scope/diff/hunk
      // binding so this run is bound to the EXACT scope contract + diff the
      // reviewer inspects. Absent for unprotected/legacy stories (no contract) →
      // run signs without a binding and the gate stays backward compatible.
      const contract = store.readScopeContract(args.storyId);
      let scopeBinding: ReviewScopeBinding | undefined;
      if (contract) {
        const diffPack = buildScopeDiffPack(signedWorkspaceRoot);
        const trusted = readTrustedProofStoryScopeArtifacts(store, args.storyId);
        scopeBinding = computeReviewScopeBinding({
          contract,
          diffPack,
          reviewedIntentRefs: args.reviewedIntentRefs,
          projectRoot: signedWorkspaceRoot,
          ledger: trusted.ledger,
          slicePlan: trusted.slicePlan,
        }) ?? undefined;
      }

      // New critic runs must consume the exact authenticated responsibility. Historical
      // envelope verification deliberately does not consult this live inventory state.
      const criticDispatch = lane === 'proof-or-stop-review-topology-critic'
        ? verifyCurrentReviewerDispatchBinding({ store, storyId: args.storyId, lane,
          reviewRound: story.currentReviewRound!, projectRoot: workspace.metadataRoot || ctx.root,
          reviewPurpose: args.reviewPurpose, inventoryBinding }) : null;
      let inventoryResponsibility = false;
      if (criticDispatch) {
        if (!criticDispatch.ok) throw new Error(`review_run_start: ${criticDispatch.reason}; redispatch critic`);
        const responsibility = criticDispatch.binding.reviewerResponsibility;
        if (!responsibility) throw new Error('review_run_start: critic dispatch lacks bound responsibility; redispatch critic');
        const inventory = story.phase === 'REVIEW' ? currentOpenReviewInventory(store, args.storyId) : null;
        if (responsibility.kind === 'inventory-completeness') {
          if (!inventory || inventory.storyId !== story.storyId || inventory.reviewRound !== story.currentReviewRound
            || responsibility.epochId !== inventory.epochId || responsibility.wave !== inventory.waves.length + 1
            || responsibility.materialHash !== inventory.cutoff.materialHash
            || responsibility.storyFilesHash !== (inventory.cutoff.storyFilesHash ?? '')) {
            throw new Error('review_run_start: inventory dispatch responsibility is stale; redispatch critic for current OPEN epoch');
          }
          inventoryResponsibility = true;
        } else if (inventoryBinding) {
          throw new Error('review_run_start: topology dispatch cannot become inventory responsibility; redispatch critic');
        }
      }

      // One per-story unique-ticket transaction covers both Prompt Envelope and
      // ReviewRun read-modify-write cycles. Stale reclaim removes only the
      // dead acquisition's UUID path, never a replacement holder's path.
      return withReviewMetadataTransactionLock(ctx, args.storyId, () => {
        const data = store.readReviewRuns(args.storyId);
        const nextNum = data.runs.reduce((max, run) => {
          const match = run.reviewRunId.match(/:RR-(\d+)$/);
          return match ? Math.max(max, Number(match[1])) : max;
        }, 0) + 1;
        const reviewRunId = `${args.storyId}:RR-${String(nextNum).padStart(3, '0')}`;
        const resolvedRoleBody = resolvePromptRoleBody(
          lane,
          loadConfig(workspace.metadataRoot || ctx.root).promptEnvelope,
        );
        const promptEntry = readPromptRegistry().agents.find(entry => entry.agentId === lane);
        if (!promptEntry) throw new Error(`review_run_start: no canonical prompt registry entry for ${lane}`);
        const canonicalRolePrompt = resolvedRoleBody.body;
        let promptHash = hashReviewPrompt(canonicalRolePrompt);
        let envelopeId: string | undefined;
        let assembledPrompt: string | undefined;
        let promptContextNote = 'legacy-full-context';
        let promptBudgetNote = '';
        if (resolvedRoleBody.mode === 'full-envelope') {
          const dispatchBinding = criticDispatch ?? verifyCurrentReviewerDispatchBinding({
            store,
            storyId: args.storyId,
            lane,
            reviewRound: story.currentReviewRound!,
            projectRoot: workspace.metadataRoot || ctx.root,
            reviewPurpose: args.reviewPurpose,
            inventoryBinding,
          });
          if (!dispatchBinding.ok) {
            throw new Error(`review_run_start: ${dispatchBinding.reason}; rerun proof-or-stop dispatch for ${lane}`);
          }
          const findingProjection = store.readFindings(args.storyId).findings
            .filter(finding => (finding.createdAt ?? '') <= startedAt)
            .map(finding => ({
              id: finding.id,
              createdAt: finding.createdAt ?? startedAt,
              status: finding.status,
              severity: finding.severity,
              category: finding.category,
              desc: finding.desc,
            }))
            .sort((left, right) => left.id.localeCompare(right.id));
          const selectedRoleContract = promptRoleContract(lane, inventoryResponsibility ? 'inventory-completeness' : undefined);
          const incremental = reviewIncrementalContext(store, signedWorkspaceRoot, args.storyId, lane, {
            roleSemanticDigest: selectedRoleContract.semanticDigest,
            findingsCutoffAt: startedAt,
            passesCutoffAt: startedAt,
            findingProjection,
          });
          const assembly = assembleConditionalReviewPromptEnvelope({
            roleContract: selectedRoleContract,
            eligibilityRoleSemanticDigest: selectedRoleContract.semanticDigest,
            runtimeContract: BASELINE_RUNTIME_CONTRACT,
            rolePrompt: canonicalRolePrompt,
            taskContext: buildFullTaskContext({
              story,
              checklist: store.readChecklist(args.storyId),
              headHash,
              materialHash,
              storyFilesHash,
              scopeContract: contract,
            }),
            dispatchKind: 'review-run',
            reviewRunId,
            reviewRound: story.currentReviewRound!,
            lane,
            createdAt: startedAt,
            dispatchPrompt: dispatchBinding.binding.dispatchPrompt,
            hostRenderIdentityDigest: dispatchBinding.binding.hostRenderIdentityDigest,
            reviewerDispatchBindingDigest: dispatchBinding.binding.dispatchBindingDigest,
            launcherSpec: {
              reviewedIntentRefs: args.reviewedIntentRefs ?? [],
              dispatchBindingDigest: dispatchBinding.binding.dispatchBindingDigest,
              hostRenderHost: dispatchBinding.binding.hostRenderHost,
              ...(inventoryBinding ? { reviewPurpose: args.reviewPurpose, inventoryBinding } : {}),
            },
            incrementalEligible: incremental.contextMode === 'incremental',
            eligibilityDigest: incremental.eligibilityDigest,
            eligibilityReasonCodes: incremental.eligibilityReasonCodes,
            freshnessClassification: incremental.freshnessClassification,
            impactPolicyVersion: incremental.impactPolicyVersion,
            priorPassRef: incremental.priorPassRef ?? undefined,
            changedFilesDigest: incremental.changedFilesDigest,
            impactedFilesDigest: incremental.impactedFilesDigest,
            reviewBasis: incremental.reviewBasis,
            findingProjection,
            reviewerEscalationReason,
          });
          const envelopeData = store.readPromptEnvelopes(args.storyId);
          const existingEnvelope = envelopeData.envelopes.find(candidate => candidate.envelopeId === assembly.envelope.envelopeId);
          if (existingEnvelope && !verifyPromptEnvelopeIntegrity(existingEnvelope)) {
            throw new Error(`review_run_start: persisted Prompt Envelope ${existingEnvelope.envelopeId} is invalid`);
          }
          if (!existingEnvelope) {
            envelopeData.envelopes.push(assembly.envelope);
            store.writePromptEnvelopes(args.storyId, envelopeData);
          }
          const persistedEnvelope = store.readPromptEnvelopes(args.storyId).envelopes.find(
            candidate => candidate.envelopeId === assembly.envelope.envelopeId,
          );
          if (!persistedEnvelope || !verifyPromptEnvelopeIntegrity(persistedEnvelope)) {
            throw new Error(`review_run_start: Prompt Envelope ${assembly.envelope.envelopeId} was not durably persisted`);
          }
          envelopeId = assembly.envelope.envelopeId;
          assembledPrompt = assembly.prompt;
          promptHash = assembly.envelope.assembledPromptDigest;
          promptContextNote = `${assembly.envelope.contextMode}/${assembly.selectionReason}`;
          promptBudgetNote =
            `, budget full=${assembly.envelope.fullContextBytes ?? 'unavailable'}` +
            `/incremental=${assembly.envelope.incrementalContextBytes ?? 'unavailable'}` +
            `/violation=${assembly.envelope.budgetViolation ?? 'none'}`;
        }
        const run: ReviewRun = {
          reviewRunId,
          storyId: args.storyId,
          agent: lane,
          lane,
          reviewRound: story.currentReviewRound!,
          startedAt,
          headHash,
          materialHash,
          ...(storyFilesHash ? { storyFilesHash } : {}),
          promptHash,
          ...(args.reviewPurpose ? { reviewPurpose: args.reviewPurpose } : {}),
          ...(inventoryBinding ? { inventoryBinding } : {}),
          ...(envelopeId ? { envelopeId } : {}),
          ...(assembledPrompt ? { assembledPrompt } : {}),
          ...(reviewerEscalationReason
            ? { reviewerEscalationReason }
            : {}),
          ...(scopeBinding ? { scopeBinding } : {}),
          workspaceBinding,
          _hash: signReviewRun(
            args.storyId,
            reviewRunId,
            lane,
            lane,
            story.currentReviewRound!,
            startedAt,
            headHash,
            materialHash,
            promptHash,
            scopeBinding?.bindingHash,
            workspaceBinding.bindingHash,
            storyFilesHash,
            envelopeId,
            reviewerEscalationReason,
            args.reviewPurpose,
            inventoryBinding,
          ),
        };
        data.runs.push(run);
        store.writeReviewRuns(args.storyId, data);
        const persisted = store.readReviewRuns(args.storyId).runs.find((candidate) => candidate.reviewRunId === reviewRunId);
        if (
          !persisted || persisted._hash !== run._hash || persisted.materialHash !== materialHash
          || persisted.storyFilesHash !== storyFilesHash
          || persisted.scopeBinding?.bindingHash !== scopeBinding?.bindingHash
          || persisted.workspaceBinding?.bindingHash !== workspaceBinding.bindingHash
          || persisted.envelopeId !== envelopeId
          || persisted.assembledPrompt !== assembledPrompt
          || persisted.reviewerEscalationReason !== reviewerEscalationReason
        ) {
          throw new Error(`review_run_start: ${reviewRunId} was not durably persisted; refusing to continue`);
        }
        const scopeNote = scopeBinding
          ? `, scope ${scopeBinding.scopeContractHash?.slice(0, 7)}/${scopeBinding.diffPackHash?.slice(0, 7)}`
          : '';
        const storyHashNote = storyFilesHash ? `, story ${storyFilesHash.slice(0, 7)}` : '';
        const envelopeNote = envelopeId
          ? `, rollout ${resolvedRoleBody.mode}, roleBody ${resolvedRoleBody.bodyDigest.slice(0, 7)}, envelope ${envelopeId.slice(0, 7)}, context ${promptContextNote}${promptBudgetNote}`
          : `, rollout legacy-full-context, legacyBytesRestored=${resolvedRoleBody.legacyBytesRestored}`;
        const escalationNote = reviewerEscalationReason
          ? `, reviewer escalation: ${reviewerEscalationReason}`
          : '';
        const purposeNote = inventoryBinding ? `\nReview purpose: inventory-completeness\nTrusted inventory subject: ${JSON.stringify(inventoryBinding)}\nInventory-only duties apply; this run supplies no topology certification.` : '';
        const summary = `Review run ${reviewRunId} started for ${lane} (round ${story.currentReviewRound}, head ${headHash.slice(0, 7)}${storyHashNote}${scopeNote}${envelopeNote}${escalationNote})${purposeNote}`;
        return assembledPrompt
          ? `${summary}\n\n--- BEGIN EXACT ASSEMBLED REVIEW PROMPT ---\n${assembledPrompt}\n--- END EXACT ASSEMBLED REVIEW PROMPT ---`
          : `${summary}\n\nThe host first loads a content-addressed thin bootstrap; the bytes below are the single selected role body, not the total model input.\n\n--- BEGIN EXACT SELECTED LEGACY ROLE BODY ---\n${canonicalRolePrompt}\n--- END EXACT SELECTED LEGACY ROLE BODY ---`;
      });
      });
    },
  };
}
