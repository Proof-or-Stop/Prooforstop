
import { setup, createActor, type SnapshotFrom } from 'xstate';
import type { StoryStore } from './store.js';
import { createHash } from 'crypto';
import { loadConfig } from './config.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
import type { Finding, ScopeFreezeCheckData, ScopeFreezeIssue, StoryInfo, ScopeContractData, WorkflowProfile } from './types.js';
import { resolveAuditConfig } from './audit-config.js';
import { evaluateDecompositionGate, computeWriteSet, type ParallelDecompositionBlock } from './parallel-decomposition.js';
import { safeReadScopeContract } from './lattice-parallel-wave.js';
import { TERMINAL_PHASES } from './parallel-policy.js';
import { REQUIRED_INIT_CHECK_AGENTS, blockingInitCheckIssues, missingRequiredInitCheckAgents, recomputeInitCheckHash } from './init-check-gate.js';
import { listActiveLoops, deriveLatestLoopRecord } from './review-loop.js';
import type { ReviewLoopIteration } from './types.js';
import { evaluateDeliveryCheckFreshness } from './delivery-check-hash.js';
import { getBlockingVerificationEvidenceIssues } from './verification.js';
import { normalizeLegacyPhase } from './phase-flow.js';
import { findingAgentMatchesReviewer } from './reviewer-opt-in.js';
import { detectMdTouchpointsFromGit } from './touchpoints-fallback.js';
import { computeActiveReviewers } from '../handlers/reviewer-list.js';
import { collectReviewerEvidenceState } from './review-run.js';
import { isFindingBlocking } from './advisory.js';
import { evaluateReviewerQuorum } from './reviewer-quorum.js';
import type { ReviewerEvidenceEntry } from './reviewer-quorum.js';
import {
  evaluateReviewEscalation,
  formatReviewEscalationFailure,
} from './review-escalation.js';
import {
  evaluateReviewAssuranceFloor,
  formatReviewAssuranceFloorFailure,
} from './review-assurance-floor.js';
import { resolveGitCwd } from './story-signed-workspace-resolution.js';
import {
  digestScopeFreezeCheck,
  evaluateScopeFreeze,
  storedScopeFreezeDiscardMitigations,
  type ScopeFreezeChecklistProjection,
} from './scope-anti-expansion.js';
import {
  evaluateStoryEvidenceBindingGate,
  formatStoryEvidenceBindingGateFailure,
} from './repro-evidence-binding-gate.js';
import {
  evaluateProofStoryDiagnostics,
  renderProofStoryDiagnosticReport,
  type ProofStoryDiagnosticInput,
} from './proofstory.js';

/**
 * Resolve effective blocking severities with round decay.
 * Round count is derived from story events (how many times the story entered REVIEW phase),
 * not from review.json which also contains PLAN-phase story_review entries.
 */
function resolveEffectiveBlockingSeverities(
  store: StoryStore, storyId: string, policy: { review: { blockingSeverities: readonly string[] | string[] } }
): { effectiveBlockingSeverities: string[]; roundCount: number } {
  let roundCount = 1;
  try {
    const story = store.readStory(storyId);
    if (story.events) {
      const reviewEntries = story.events.filter(
        (e: any) => e.phase === 'REVIEW' && e.action === 'advance'
      );
      roundCount = reviewEntries.length || 1;
    }
  } catch { /* fallback to 1 */ }

  let effectiveBlockingSeverities: string[];
  if (roundCount >= 3) {
    effectiveBlockingSeverities = ['critical'];
  } else if (roundCount >= 2) {
    effectiveBlockingSeverities = ['critical', 'high'];
  } else {
    effectiveBlockingSeverities = policy.review.blockingSeverities as string[];
  }
  return { effectiveBlockingSeverities, roundCount };
}

function buildQuorumEvidence(
  evidenceRecords: { agent: string; kind: string; signatureValid?: boolean }[],
): ReviewerEvidenceEntry[] {
  return evidenceRecords.map(e => ({
    lane: e.agent,
    agent: e.agent,
    // Production finding severity/round-decay remains owned by the existing
    // isFindingBlocking section; quorum only needs lane coverage here.
    kind: 'pass',
    signatureValid: e.signatureValid,
  }));
}

export interface StoryMachineContext {
  storyId: string;
  store: StoryStore;
  projectRoot: string;
  gitCwd?: string;
}

export interface ScopeAntiExpansionGateResult {
  ok: boolean;
  reason: string | null;
}

function projectScopeFreezeStory(store: StoryStore, storyId: string) {
  const story = store.readStory(storyId);
  return {
    title: story.title,
    description: story.description,
    background: store.readStoryBackground(storyId) ?? undefined,
  };
}

function projectScopeFreezeChecklist(store: StoryStore, storyId: string): ScopeFreezeChecklistProjection[] {
  try {
    return store.readChecklist(storyId).items.map(item => ({
      id: item.id,
      title: item.title,
      ...(item.context ? { context: item.context } : {}),
      ...(item.excludes && item.excludes.length > 0 ? { excludes: [...item.excludes] } : {}),
    }));
  } catch {
    return [];
  }
}

function proofStoryDiagnosticInput(store: StoryStore, storyId: string): ProofStoryDiagnosticInput {
  let checklist;
  try {
    checklist = store.readChecklist(storyId);
  } catch {
    checklist = { items: [] };
  }
  return {
    story: store.readStory(storyId),
    checklist,
    originalIntentSnapshot: store.readOriginalIntentSnapshot(storyId),
    milestoneLedger: store.readMilestoneLedger(storyId),
    proofStoryContract: store.readProofStoryContract(storyId),
    intentCollision: store.readIntentCollision(storyId),
    scopeContract: store.readScopeContract(storyId),
    scopeShrinkageDecision: store.readScopeShrinkageDecision(storyId),
    redEvidence: store.readRedEvidence(storyId),
    spikeEvidence: store.readProofStorySpikes(storyId),
  };
}

function proofStoryDevGateFailure(store: StoryStore, projectRoot: string | undefined, storyId: string): string | null {
  if (!projectRoot) return null;
  const mode = loadConfig(projectRoot).proofStory?.devGateMode ?? 'observe';
  if (mode !== 'enforce') return null;
  const report = evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId), 'enforce');
  if (!report.blocking) return null;
  return `Cannot enter DEV: ProofStory DEV gate is enforce and required intent artifacts are incomplete.\n${renderProofStoryDiagnosticReport(report)}`;
}

function firstHardScopeIssue(check: ScopeFreezeCheckData): ScopeFreezeIssue | null {
  return check.issues.find(issue => issue.severity === 'hard') ?? null;
}

function renderScopeFreezeIssue(storyId: string, issue: ScopeFreezeIssue): string {
  if (issue.code === 'missing_scope_boundary') {
    return `Cannot enter INIT_CHECK: scope-boundary.json is missing or invalid for ${storyId}. [missing_scope_boundary]\n` +
      `→ Run scope_boundary_set with userConfirmed:true before creating the worktree.`;
  }
  if (issue.code === 'missing_execution_boundary') {
    return `Cannot enter INIT_CHECK: execution-boundary.json is missing or invalid for ${storyId}. [missing_execution_boundary]\n` +
      `→ Run execution_boundary_set before creating the worktree.`;
  }
  if (issue.code === 'future_capability_keyword') {
    const source = issue.source ? ` in ${issue.source}${issue.itemId ? ` (${issue.itemId})` : ''}` : '';
    const keyword = issue.keyword ? `"${issue.keyword}"` : 'an excluded keyword';
    return `Cannot enter INIT_CHECK: excluded scope keyword ${keyword} appears${source}. [excluded_keyword]\n` +
      `→ Remove the expansion from the frozen INIT text, or record a scope_extension_proposal and explicit decision before rerunning scope_freeze_check.`;
  }
  if (issue.code === 'repeat_discard_without_mitigation') {
    const digest = issue.digest ? ` ${issue.digest}` : '';
    return `Cannot enter INIT_CHECK: current direction repeats a discarded direction${digest} without mitigation. [repeat_discarded_direction]\n` +
      `→ Provide repeatDiscardMitigation when rerunning scope_freeze_check, or choose a different scope boundary.`;
  }
  return `Cannot enter INIT_CHECK: scope-freeze-check failed for ${storyId}. [scope_freeze_check_failed]`;
}

function readScopeGateFailure<T>(label: string, fn: () => T): { value: T; reason: null } | { value: null; reason: string } {
  try {
    return { value: fn(), reason: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      value: null,
      reason: `Cannot enter INIT_CHECK: ${label} could not be read. [${label.replace(/\.json$/, '').replaceAll('-', '_')}_unreadable]\n  - ${msg}`,
    };
  }
}

export function evaluateScopeAntiExpansionGate(
  storyId: string,
  store: StoryStore,
): ScopeAntiExpansionGateResult {
  const scopeBoundary = readScopeGateFailure('scope-boundary.json', () => store.readScopeBoundary(storyId));
  if (scopeBoundary.reason) return { ok: false, reason: scopeBoundary.reason };

  const executionBoundary = readScopeGateFailure('execution-boundary.json', () => store.readExecutionBoundary(storyId));
  if (executionBoundary.reason) return { ok: false, reason: executionBoundary.reason };

  const freezeCheck = readScopeGateFailure('scope-freeze-check.json', () => store.readScopeFreezeCheck(storyId));
  if (freezeCheck.reason) return { ok: false, reason: freezeCheck.reason };

  const proposals = readScopeGateFailure('scope-extension-proposals.json', () => store.readScopeExtensionProposals(storyId));
  if (proposals.reason) return { ok: false, reason: proposals.reason };
  if (!proposals.value) {
    return {
      ok: false,
      reason: `Cannot enter INIT_CHECK: scope-extension-proposals.json could not be read. [scope_extension_proposals_unreadable]`,
    };
  }

  const discardDigest = readScopeGateFailure('scope-discard-digest.json', () => store.readScopeDiscardDigestForFreeze(storyId));
  if (discardDigest.reason) return { ok: false, reason: discardDigest.reason };

  const storedCheck = freezeCheck.value;
  const current = evaluateScopeFreeze({
    storyId,
    scopeBoundary: scopeBoundary.value,
    executionBoundary: executionBoundary.value,
    story: projectScopeFreezeStory(store, storyId),
    checklist: projectScopeFreezeChecklist(store, storyId),
    discardDigest: discardDigest.value,
    repeatDiscardMitigations: storedScopeFreezeDiscardMitigations(storedCheck),
  });

  const pending = proposals.value.proposals.filter(proposal => proposal.status === 'pending');
  if (pending.length > 0) {
    return {
      ok: false,
      reason: `Cannot enter INIT_CHECK: ${pending.length} scope extension proposal(s) are still pending: ${pending.map(p => p.proposalId).join(', ')}. [scope_extension_proposal_pending]\n` +
        `→ Run scope_extension_decide for each proposal, then rerun scope_freeze_check.`,
    };
  }

  if (!storedCheck) {
    const currentIssue = firstHardScopeIssue(current.check);
    if (currentIssue) {
      return { ok: false, reason: renderScopeFreezeIssue(storyId, currentIssue) };
    }
    return {
      ok: false,
      reason: `Cannot enter INIT_CHECK: scope-freeze-check.json is missing. [missing_scope_freeze_check]\n` +
        `→ Run scope_freeze_check after scope_boundary_set and execution_boundary_set.`,
    };
  }
  if (storedCheck._hash !== digestScopeFreezeCheck(storedCheck)) {
    return {
      ok: false,
      reason: `Cannot enter INIT_CHECK: scope-freeze-check.json hash is stale or tampered. [scope_freeze_check_stale]\n` +
        `→ Rerun scope_freeze_check before creating the worktree.`,
    };
  }
  if (storedCheck.status !== 'pass') {
    const storedIssue = firstHardScopeIssue(storedCheck);
    return {
      ok: false,
      reason: storedIssue
        ? renderScopeFreezeIssue(storyId, storedIssue)
        : `Cannot enter INIT_CHECK: scope-freeze-check.json status is ${storedCheck.status}. [scope_freeze_check_failed]\n→ Resolve the freeze issues and rerun scope_freeze_check.`,
    };
  }
  if (
    storedCheck.freshnessHash !== current.check.freshnessHash ||
    storedCheck.scopeBoundaryHash !== current.check.scopeBoundaryHash ||
    storedCheck.executionBoundaryHash !== current.check.executionBoundaryHash
  ) {
    return {
      ok: false,
      reason: `Cannot enter INIT_CHECK: scope-freeze-check.json is stale relative to current scope/checklist/proposal inputs. [scope_freeze_check_stale]\n` +
        `→ Rerun scope_freeze_check before creating the worktree.`,
    };
  }
  const currentIssue = firstHardScopeIssue(current.check);
  if (currentIssue) {
    return { ok: false, reason: renderScopeFreezeIssue(storyId, currentIssue) };
  }

  return { ok: true, reason: null };
}

export function getScopeAntiExpansionGuardFailureReason(
  storyId: string,
  store: StoryStore,
  _projectRoot?: string,
): string | null {
  return evaluateScopeAntiExpansionGate(storyId, store).reason;
}

export function renderScopeAntiExpansionSummary(
  storyId: string,
  store: StoryStore,
  projectRoot?: string,
): string[] {
  const reason = getScopeAntiExpansionGuardFailureReason(storyId, store, projectRoot);
  if (!reason) {
    return [
      'Scope anti-expansion: ready',
      '  - scope boundary, execution boundary, freeze check, proposals, and discard digest are current',
    ];
  }
  return [
    'Scope anti-expansion: blocked',
    `  - ${reason.split('\n')[0]}`,
  ];
}

export function checklistAllDoneGuard(context: StoryMachineContext): boolean {
  const cl = context.store.readChecklist(context.storyId);
  if (!cl.items.every(item => item.status === 'done')) return false;
  const story = context.store.readStory(context.storyId);
  const policy = resolveWorkflowPolicy(loadConfig(context.projectRoot), story);
  return getBlockingVerificationEvidenceIssues(cl, undefined, policy.profile).length === 0;
}

export function canEnterInitCheckGuard(context: StoryMachineContext): boolean {
  try {
    const story = context.store.readStory(context.storyId);
    if (story.phase !== 'INIT') return true; // Other sources such as IDEA→INIT_CHECK are not gated
    if (getScopeAntiExpansionGuardFailureReason(context.storyId, context.store, context.projectRoot)) return false;
    const initCheck = context.store.readInitCheck(context.storyId);
    if (!initCheck) return false;
    const expected = recomputeInitCheckHash(context.storyId, context.store, context.projectRoot);
    return initCheck._hash === expected
      && missingRequiredInitCheckAgents(initCheck).length === 0
      && blockingInitCheckIssues(initCheck).length === 0;
  } catch (err) {
    // B-e71f F-016: xstate guard must not throw (it would push the actor into the error state), but going completely silent
    // would swallow the underlying store exceptions (fs read failure / json parse failure / recompute path bug)——
    // the user would only see the gate rejection without any diagnostics. console.warn here does not affect the guard return value.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[canEnterInitCheck] ${context.storyId}: ${msg}`);
    return false;
  }
}

/**
 * Parallel-decomposition: the block to ENFORCE at PLAN→DEV, or null (no enforced block).
 *
 * Consults cfg.mode ONLY here — the gate (evaluateDecompositionGate) is mode-agnostic and
 * the spec (§4.4) says the CALLER enforces mode. Returns null unless cfg.mode==='block', so
 * advise/off never produce an enforced block (advisory is Story 4's surface). The self story's
 * own scope contract is included in the map (the loop over ALL ids covers it), which the gate
 * needs to compute its own write-set.
 *
 * MAY THROW (config introspection / store read errors) — every caller wraps this in its OWN
 * fail-open try/catch so a gate/config infra error can NEVER block PLAN→DEV (spec §4.8).
 *
 * MIGRATION HAZARD (F-005): under mode='block', the frozen gate (§4.8) is fail-CLOSED on an
 * unreadable PEER contract — a legacy ACTIVE parallelSafe='yes' peer with NO scope-contract.json
 * will surprise-block an otherwise-unrelated story (peer_contract_unreadable_parallel). So
 * enabling mode='block' requires that EVERY active parallelSafe='yes' story carries a readable
 * scope contract. (The gate behaviour itself is frozen and out of scope here — do not change it.)
 */
function parallelDecompositionEnforcedBlock(
  store: StoryStore,
  projectRoot: string,
  story: StoryInfo,
  profile: WorkflowProfile,
): ParallelDecompositionBlock | null {
  const cfg = resolveAuditConfig(profile, projectRoot).parallelGate;
  if (!cfg || cfg.mode !== 'block') return null;
  const ids = store.listStoryIds();
  const peers = ids.filter((id) => id !== story.storyId).map((id) => store.readStory(id));
  const contracts = new Map<string, ScopeContractData>();
  for (const id of ids) {
    const c = safeReadScopeContract(store, id);
    if (c) contracts.set(id, c);
  }
  return evaluateDecompositionGate(story, peers, contracts, cfg).block;
}

/**
 * F-006: the SINGLE fail-open wrapper applied to EVERY door into DEV. There are four START→DEV
 * doors (lifecycle-registry PHASE_EVENT_BY_TARGET DEV:'START'): INIT_CHECK→DEV (canSkipPlanGuard),
 * PLAN→DEV (canStartDevGuard), and the rollback transitions REVIEW→DEV + TEST→DEV
 * (canReenterDevGuard). All four must enforce the same parallel hard-block under mode='block'.
 *
 * Returns the enforced block to refuse DEV entry, or null (allow). NEVER throws and NEVER blocks
 * on an infra error: a missing projectRoot or any gate/config/store error degrades to null
 * (fail-open, spec §4.8) so a gate/config infra error can never strand ANY door into DEV.
 */
function parallelDevEntryBlock(
  store: StoryStore,
  projectRoot: string | undefined,
  story: StoryInfo,
  profile: WorkflowProfile,
): ParallelDecompositionBlock | null {
  if (!projectRoot) return null;
  try {
    return parallelDecompositionEnforcedBlock(store, projectRoot, story, profile);
  } catch {
    return null; // FAIL-OPEN: a gate/config/store error must NEVER block any DEV door (spec §4.8)
  }
}

/**
 * F-007: a write-set entry is LITERAL (tier-1 eligible) iff it carries no trailing `/*` or `/**`.
 * Local mirror of parallel-decomposition-gate.ts's internal `isLiteralPath` (that module is frozen
 * and the predicate is not exported) so the formatter names the peer the gate ACTUALLY blocked on.
 */
function isLiteralWriteSetEntry(entry: string): boolean {
  return !entry.endsWith('/*') && !entry.endsWith('/**');
}

/**
 * F-007: the FIRST entry that is present-and-literal in BOTH write-sets — i.e. a genuine tier-1
 * literal collision (zero false positives), the only tier the gate hard-blocks on. Returns null
 * when there is no literal collision (so the formatter skips a peer with only tier-2 wildcard/
 * shared-prefix overlap). Mirrors the gate's `literalCollisions`.
 */
function firstLiteralCollision(a: string[], b: string[]): string | null {
  const litB = new Set(b.filter(isLiteralWriteSetEntry));
  for (const e of a) {
    if (isLiteralWriteSetEntry(e) && litB.has(e)) return e;
  }
  return null;
}

/**
 * Map an enforced parallel-decomposition block to an actionable PLAN→DEV failure message.
 * Names the colliding peer / broad glob where it is cheap to recompute (overlap recomputes
 * the TIER-1 LITERAL collision against active parallel peers, mirroring the gate, so it never
 * cites a tier-2 wildcard pair or names the wrong peer). Never throws: any recompute failure
 * degrades to a general message.
 */
function formatParallelDecompositionBlock(
  block: ParallelDecompositionBlock,
  story: StoryInfo,
  store: StoryStore,
  projectRoot: string,
  profile: WorkflowProfile,
): string {
  switch (block) {
    case 'overlap_declared_parallel': {
      let detail = '';
      try {
        const cfg = resolveAuditConfig(profile, projectRoot).parallelGate;
        const sContract = safeReadScopeContract(store, story.storyId);
        if (cfg && sContract) {
          const sWriteSet = computeWriteSet(sContract);
          for (const id of store.listStoryIds()) {
            if (id === story.storyId) continue;
            const peer = store.readStory(id);
            // F-004: mirror evaluateDecompositionGate's activePeers filter — never name a
            // terminal (DONE/DISCARDED) peer, which the gate does not consider.
            if (TERMINAL_PHASES.has(peer.phase)) continue;
            if (peer.parallelSafe !== 'yes') continue;
            const pContract = safeReadScopeContract(store, id);
            if (!pContract) continue;
            // F-007: only a genuine TIER-1 literal collision (not a tier-2 wildcard/shared-prefix
            // pair) is what the gate hard-blocks on — name only a peer that actually has one.
            const literal = firstLiteralCollision(sWriteSet, computeWriteSet(pContract));
            if (literal !== null) {
              detail = ` with parallel peer ${id} (e.g. ${literal})`;
              break;
            }
          }
        }
      } catch { /* general message below if recompute fails */ }
      return `parallel-decomposition: write-set literally collides${detail || ' with an active parallel peer'}; ` +
        `independence is not provable [overlap_declared_parallel]. ` +
        `→ Make the two scope contracts disjoint (allowedModify/allowedCreate), or set parallelSafe=no / sequence the stories so they do not DEV simultaneously.`;
    }
    case 'broad_glob_unprovable_parallel': {
      let broad = '';
      try {
        const sContract = safeReadScopeContract(store, story.storyId);
        if (sContract) {
          const example = computeWriteSet(sContract).find((e) => e.endsWith('/**'));
          if (example) broad = ` (e.g. ${example})`;
        }
      } catch { /* general message */ }
      return `parallel-decomposition: a broad glob${broad} is asserted parallel-safe under the strict profile; ` +
        `independence is unprovable [broad_glob_unprovable_parallel]. ` +
        `→ Narrow the contract to specific paths or dir/* entries, or set parallelSafe=no.`;
    }
    case 'peer_contract_unreadable_parallel': {
      let peerId = '';
      try {
        for (const id of store.listStoryIds()) {
          if (id === story.storyId) continue;
          const peer = store.readStory(id);
          // F-004: same activePeers filter — only an ACTIVE parallel peer can be the unreadable one.
          if (TERMINAL_PHASES.has(peer.phase)) continue;
          if (peer.parallelSafe !== 'yes') continue;
          if (safeReadScopeContract(store, id) === null) { peerId = id; break; }
        }
      } catch { /* general message */ }
      return `parallel-decomposition: the scope contract for parallel peer ${peerId || '(unknown)'} is unreadable, ` +
        `so disjointness from this story cannot be proven [peer_contract_unreadable_parallel]. ` +
        `→ Repair the peer's scope-contract.json, or set parallelSafe=no to drop the parallel assertion.`;
    }
    case 'fake_dependency_chain':
      // Advisory-only in the gate (never an enforced block); handled defensively.
      return `parallel-decomposition: a declared dependency edge could not be corroborated [fake_dependency_chain]. ` +
        `→ Verify the depends edges name real active peer stories.`;
  }
}

export function canStartDevGuard(context: StoryMachineContext): boolean {
  // Passing story_review is a prerequisite for entering DEV (unless policy does not require it)
  try {
    const config = loadConfig(context.projectRoot);
    const story = context.store.readStory(context.storyId);
    const policy = resolveWorkflowPolicy(config, story);
    if (evaluateStoryEvidenceBindingGate(context.projectRoot, context.store, context.storyId).blocking) return false;
    if (proofStoryDevGateFailure(context.store, context.projectRoot, context.storyId)) return false;
    // F-001: ONLY the review-record checks are gated on requireStoryReview. The parallel
    // sub-check below must run on EVERY door into DEV (it used to be skipped when review was
    // not required, which made the hard block bypassable). The early `return true` is gone.
    if (policy.plan.requireStoryReview) {
      const review = context.store.readReview(context.storyId);
      if (!review || !review.reviews || review.reviews.length === 0) return false;
      const lastRound = review.reviews[review.reviews.length - 1];
      const REVIEW_SALT = 'lattice-review-integrity-v1';
      const hashInput = `${context.storyId}:${lastRound.timestamp}:${lastRound.issueCount}:${lastRound.blockerCount ?? lastRound.issueCount}:${REVIEW_SALT}`;
      const expectedHash = createHash('sha256').update(hashInput).digest('hex');
      if (!lastRound._hash || lastRound._hash !== expectedHash) return false;
      // F-002: strict `!== 0` (NOT `> 0`) — a negative / NaN / oddly-typed signed count must
      // NOT be treated as clean. This restores the original `=== 0` semantics exactly.
      if ((lastRound.blockerCount ?? lastRound.issueCount) !== 0) return false;
    }
    // Parallel-decomposition hard block (spec §4.8) via the shared FAIL-OPEN wrapper, ALWAYS
    // reached (regardless of requireStoryReview). The wrapper never throws and returns null on any
    // infra error, so this can never block PLAN→DEV on a gate/config error. The review gate above
    // stays fail-closed.
    if (parallelDevEntryBlock(context.store, context.projectRoot, story, policy.profile) !== null) return false;
    return true;
  } catch {
    return false;
  }
}

export function canEnterPlanGuard(context: StoryMachineContext): boolean {
  try {
    const story = context.store.readStory(context.storyId);
    if (story.phase !== 'IDEA') return true;
    return !evaluateStoryEvidenceBindingGate(context.projectRoot, context.store, context.storyId).blocking;
  } catch {
    return false;
  }
}

export function canSkipPlanGuard(context: StoryMachineContext): boolean {
  // Express channel: WorkflowPolicy decides whether skipping PLAN is allowed
  try {
    const config = loadConfig(context.projectRoot);
    const story = context.store.readStory(context.storyId);
    const policy = resolveWorkflowPolicy(config, story);
    if (!policy.quickPath.enabled) return false;
    if (!policy.quickPath.allowRiskSignals && story.riskSignals && story.riskSignals.length > 0) return false;
    const cl = context.store.readChecklist(context.storyId);
    if (cl.items.length > policy.quickPath.maxChecklistItems) return false;
    if (evaluateStoryEvidenceBindingGate(context.projectRoot, context.store, context.storyId).blocking) return false;
    if (proofStoryDevGateFailure(context.store, context.projectRoot, context.storyId)) return false;
    // F-003: the INIT_CHECK→DEV express channel is ALSO a door into DEV, so it must enforce the
    // SAME parallel hard-block (otherwise an express story bypasses the gate). Shared FAIL-OPEN
    // wrapper: a gate/config infra error must never strand the express channel.
    if (parallelDevEntryBlock(context.store, context.projectRoot, story, policy.profile) !== null) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * F-006: the ROLLBACK doors REVIEW→DEV and TEST→DEV ("rework" via story_advance DEV). These are
 * NOT subject to the review/express gates (a rollback must not re-demand a clean review), but they
 * ARE doors into DEV, so they must enforce the SAME ProofStory DEV admission gate and parallel
 * hard-block used by PLAN/INIT_CHECK DEV entry.
 * Returns true to ALLOW re-entry, false to refuse. FAIL-OPEN: any infra error → allow (a rollback
 * must never be stranded by a gate/config error), via proofStoryDevGateFailure,
 * parallelDevEntryBlock, and the outer catch.
 */
export function canReenterDevGuard(context: StoryMachineContext): boolean {
  try {
    const config = loadConfig(context.projectRoot);
    const story = context.store.readStory(context.storyId);
    const policy = resolveWorkflowPolicy(config, story);
    if (proofStoryDevGateFailure(context.store, context.projectRoot, context.storyId)) return false;
    return parallelDevEntryBlock(context.store, context.projectRoot, story, policy.profile) === null;
  } catch {
    return true; // FAIL-OPEN: an infra error must never block a rollback into DEV (spec §4.8)
  }
}

export function canPassReviewGuard(context: StoryMachineContext): boolean {
  try {
    // B-7a34 CHK-003: open review loop blocks REVIEW→TEST (fail-closed).
    const loopRecords = context.store.readReviewLoopRecords(context.storyId);
    if (listActiveLoops(loopRecords).length > 0) return false;
  } catch {
    return false;
  }
  try {
    const config = loadConfig(context.projectRoot);
    const story = context.store.readStory(context.storyId);
    const policy = resolveWorkflowPolicy(config, story);

    // If policy doesn't require reviewer, skip finding checks entirely
    if (!policy.review.requireReviewer) return true;

    const findings = context.store.readFindings(context.storyId);
    const reviewPasses = context.store.readReviewPasses(context.storyId);
    if ((!findings.findings || findings.findings.length === 0) && (!reviewPasses.passes || reviewPasses.passes.length === 0)) return false;
    const evidenceState = collectReviewerEvidenceState(context.store, context.storyId, context.projectRoot);
    if (evidenceState.invalid.length > 0) return false;

    // Check for reviewer-produced finding if policy requires it
    if (policy.review.requireReviewerFinding) {
      const currentRoundReviewerEvidence = evidenceState.valid.map((e) => ({ agent: e.agent, kind: e.kind }));

      const { roundCount } = resolveEffectiveBlockingSeverities(context.store, context.storyId, policy);
      if (roundCount <= 1) {
        // Round 1: require findings from every opt-in reviewer (same source as reviewer_list).
        let checklist: { items: unknown[] } = { items: [] };
        try { checklist = context.store.readChecklist(context.storyId); } catch {}
        let decision = null;
        try { decision = context.store.readDecision(context.storyId); } catch {}
        const understanding = context.store.readUnderstanding(context.storyId);
        const touchpoints = understanding?.touchpoints
          ?? detectMdTouchpointsFromGit(context.projectRoot ?? process.cwd());
        const optIn = computeActiveReviewers(story, checklist, decision, touchpoints);
        const missing = optIn.filter(reviewer => !currentRoundReviewerEvidence.some(
          e => findingAgentMatchesReviewer(e.agent, reviewer.name),
        ));
        if (missing.length > 0) return false;

        // B-1fca CHK-002: quorum gate for round 1
        const quorum = evaluateReviewerQuorum({
          activeReviewers: optIn.map(r => r.name),
          evidence: buildQuorumEvidence(evidenceState.valid),
          profile: policy.profile as 'light' | 'balanced' | 'strict',
        });
        if (!quorum.ok) return false;
      } else {
        // Round 2+: require at least 1 reviewer finding or pass receipt
        if (currentRoundReviewerEvidence.length === 0) return false;
      }
    }

    const { effectiveBlockingSeverities, roundCount } = resolveEffectiveBlockingSeverities(context.store, context.storyId, policy);

    // Check blocking severities from policy (with round decay).
    // B-3fad CHK-001: evidenceState dimension — only verified (or legacy missing-field) open findings block;
    // suspected / disproven do not block REVIEW→TEST.
    const blocking = evidenceState.valid
      .map((e) => e.finding)
      .filter((finding): finding is Finding => !!finding)
      .filter((f) => isFindingBlocking(f, effectiveBlockingSeverities, roundCount));
    return blocking.length === 0;
  } catch {
    return false;
  }
}

export function canFinishGuard(context: StoryMachineContext): boolean {
  // verifier result (test-evidence.json) must be PASS + all bugs fixed
  const evidence = context.store.readTestEvidence(context.storyId);
  const hasEvidence = evidence !== null && evidence.result === 'PASS';
  const bugs = context.store.readBugs(context.storyId);
  const bugsOk = bugs.bugs.every(b => b.status === 'fixed');
  if (!hasEvidence || !bugsOk) return false;

  // delivery-check.json must exist, be untampered, and be bound to current material.
  const deliveryCheckFreshness = evaluateDeliveryCheckFreshness(
    context.storyId,
    context.store,
    context.gitCwd ?? resolveGitCwd({
      store: context.store,
      storyId: context.storyId,
      metadataRoot: context.projectRoot,
      projectRoot: context.projectRoot,
    }),
    context.projectRoot,
  );
  if (!deliveryCheckFreshness.ok) return false;
  const deliveryCheck = deliveryCheckFreshness.deliveryCheck;
  if (!deliveryCheck) return false;

  // every docsPromise must be verified or waived
  const unverified = deliveryCheck.docsPromises.filter(
    p => !p.verifiedBy && !p.waiverReason && !['met', 'verified', 'waived'].includes(p.status || ''),
  );
  if (unverified.length > 0) {
    return false;
  }

  const reviewEscalation = evaluateReviewEscalation({
    projectRoot: context.projectRoot,
    gitCwd: context.gitCwd ?? resolveGitCwd({
      store: context.store,
      storyId: context.storyId,
      metadataRoot: context.projectRoot,
      projectRoot: context.projectRoot,
    }),
    storyId: context.storyId,
    store: context.store,
  });
  if (!reviewEscalation.ok) return false;

  const reviewAssuranceFloor = evaluateReviewAssuranceFloor({
    projectRoot: context.projectRoot,
    gitCwd: context.gitCwd ?? resolveGitCwd({
      store: context.store,
      storyId: context.storyId,
      metadataRoot: context.projectRoot,
      projectRoot: context.projectRoot,
    }),
    storyId: context.storyId,
    store: context.store,
  });
  if (!reviewAssuranceFloor.ok) return false;

  return true;
}

export function canSendStoryEventWithoutSnapshotCan(
  storyId: string,
  store: StoryStore,
  currentState: string,
  eventType: string,
  projectRoot: string,
  gitCwd?: string,
): boolean {
  const context: StoryMachineContext = { storyId, store, projectRoot, ...(gitCwd ? { gitCwd } : {}) };
  switch (currentState) {
    case 'IDEA':
      return eventType === 'INIT' || (eventType === 'PLAN' && canEnterPlanGuard(context));
    case 'INIT':
      return eventType === 'INIT_CHECK' && canEnterInitCheckGuard(context);
    case 'INIT_CHECK':
      return eventType === 'PLAN' || (eventType === 'START' && canSkipPlanGuard(context));
    case 'PLAN':
      return eventType === 'START' && canStartDevGuard(context);
    case 'DEV':
      return eventType === 'REPLAN' || (eventType === 'CODE_REVIEW' && checklistAllDoneGuard(context));
    case 'REVIEW':
      // F-006: REVIEW→DEV rollback must consult canReenterDevGuard so this non-xstate path agrees
      // with the machine guard (the parallel block holds on the rollback door too).
      return (eventType === 'START' && canReenterDevGuard(context)) || (eventType === 'REVIEW_PASS' && canPassReviewGuard(context));
    case 'TEST':
      return (eventType === 'START' && canReenterDevGuard(context)) || (eventType === 'FINISH' && canFinishGuard(context));
    default:
      return false;
  }
}

export const storyMachine = setup({
  types: {
    context: {} as StoryMachineContext,
    input: {} as StoryMachineContext,
    events: {} as
      | { type: 'INIT' }
      | { type: 'INIT_CHECK' }
      | { type: 'PLAN' }
      | { type: 'START' }
      | { type: 'REPLAN' }
      | { type: 'CODE_REVIEW' }
      | { type: 'REVIEW_PASS' }
      | { type: 'FINISH' },
  },
  guards: {
    checklistAllDone: ({ context }) => checklistAllDoneGuard(context),
    // B-e71f CHK-006: xstate-side fallback for the INIT→INIT_CHECK hard gate.
    // getGuardFailureReason in phase-gates.ts is only invoked by resolveGuardFailure when actor.can() returns false,
    // so a guard must be attached to the INIT→INIT_CHECK transition here; otherwise can() will always be true and the gate will never fire.
    // The guard and getGuardFailureReason share the same decision logic: missing init-check.json → false;
    // _hash mismatch → false; pass → true. The failure reason is rendered as a human-readable message by getGuardFailureReason.
    canEnterInitCheck: ({ context }) => canEnterInitCheckGuard(context),
    canEnterPlan: ({ context }) => canEnterPlanGuard(context),
    canStartDev: ({ context }) => canStartDevGuard(context),
    canSkipPlan: ({ context }) => canSkipPlanGuard(context),
    // F-006: REVIEW→DEV and TEST→DEV rollbacks are also doors into DEV — enforce the parallel block.
    canReenterDev: ({ context }) => canReenterDevGuard(context),
    canPassReview: ({ context }) => canPassReviewGuard(context),
    canFinish: ({ context }) => canFinishGuard(context),
  },
}).createMachine({
  id: 'story',
  context: ({ input }: { input: StoryMachineContext }) => input,
  initial: 'IDEA',
  states: {
    IDEA: {
      on: {
        INIT: { target: 'INIT' },
        PLAN: { target: 'PLAN', guard: 'canEnterPlan' }, // legacy direct path
      },
    },
    INIT: {
      on: {
        // B-e71f CHK-006: The guard must be attached; otherwise actor.can() will always be true,
        // and the failure message rendering in phase-gates.ts's getGuardFailureReason will never trigger.
        INIT_CHECK: { target: 'INIT_CHECK', guard: 'canEnterInitCheck' },
      },
    },
    INIT_CHECK: {
      on: {
        PLAN: { target: 'PLAN' },
        START: { target: 'DEV', guard: 'canSkipPlan' },
      },
    },
    PLAN: {
      on: {
        START: { target: 'DEV', guard: 'canStartDev' },
      },
    },
    DEV: {
      on: {
        CODE_REVIEW: {
          target: 'REVIEW',
          guard: 'checklistAllDone',
        },
        REPLAN: {
          target: 'PLAN',
        },
      },
    },
    REVIEW: {
      on: {
        REVIEW_PASS: {
          target: 'TEST',
          guard: 'canPassReview',
        },
        START: {
          target: 'DEV',
          guard: 'canReenterDev', // F-006: rollback REVIEW→DEV must still enforce the parallel block
        },
      },
    },
    TEST: {
      on: {
        FINISH: {
          target: 'DONE',
          guard: 'canFinish',
        },
        START: {
          target: 'DEV',
          guard: 'canReenterDev', // F-006: rollback TEST→DEV must still enforce the parallel block
        },
      },
    },
    DONE: {
      type: 'final',
    },
  },
});

export type StoryMachineSnapshot = SnapshotFrom<typeof storyMachine>;

export function createStoryActor(
  storyId: string,
  store: StoryStore,
  restoredState?: string,
  projectRoot?: string,
  gitCwd?: string,
) {
  const context: StoryMachineContext = {
    storyId,
    store,
    projectRoot: projectRoot ?? process.cwd(),
    ...(gitCwd ? { gitCwd } : {}),
  };
  const normalizedState = restoredState ? normalizeLegacyPhase(restoredState) : undefined;

  if (normalizedState) {
    const snapshot = storyMachine.resolveState({
      value: normalizedState,
      context,
    });
    return createActor(storyMachine, { snapshot, input: context });
  }

  return createActor(storyMachine, { input: context });
}

export function getStateName(actor: ReturnType<typeof createActor<typeof storyMachine>>): string {
  const snapshot = actor.getSnapshot();
  return typeof snapshot.value === 'string' ? snapshot.value : JSON.stringify(snapshot.value);
}

export function getGuardFailureReason(
  storyId: string,
  store: StoryStore,
  targetPhase: string,
  projectRoot?: string,
  gitCwd?: string,
): string | null {
  // B-e71f CHK-005: INIT→INIT_CHECK hard gate.
  // Only enabled when story.phase === 'INIT'; other sources such as IDEA→INIT_CHECK are not gated.
  // Missing init-check.json → missing_init_check; _hash mismatch → init_check_tampered.
  // recomputeInitCheckHash reuses the function already exported by CHK-001 (no duplicate implementations).
  if (targetPhase === 'INIT_CHECK') {
    const story = store.readStory(storyId);
    if (story.phase !== 'INIT') return null;
    const scopeAntiExpansionFailure = getScopeAntiExpansionGuardFailureReason(storyId, store, projectRoot);
    if (scopeAntiExpansionFailure) return scopeAntiExpansionFailure;
    const initCheck = store.readInitCheck(storyId);
    if (!initCheck) {
      return `Cannot enter INIT_CHECK: init-check.json is missing. [missing_init_check]\n` +
        `Missing required reviewer records: ${REQUIRED_INIT_CHECK_AGENTS.join(', ')}\n` +
        `→ Preferred: spawn an independent reviewer\n` +
        `   Agent({ subagent_type: "lattice-review-story-init", prompt: \`lattice dispatch '{"storyId":"${storyId}","agentType":"lattice-review-story-init"}'\` })\n` +
        `   and have product-reviewer call init_check_set as well; if the reviewer produces no output for 4 minutes, re-dispatch and restart the reviewer.\n` +
        `→ Fallback (only when subagents cannot be spawned, controlled and audited):\n` +
        `   lattice init_check_repair '{"storyId":"${storyId}","acknowledge":true,"fallbackReason":"<why the reviewer cannot run + what you manually verified, >=30 chars>"}'`;
    }
    const expected = recomputeInitCheckHash(storyId, store, projectRoot ?? process.cwd());
    if (initCheck._hash !== expected) {
      return `Cannot enter INIT_CHECK: init-check.json _hash mismatch (background/title/description/checklist were modified); please re-run the lattice-review-story-init agent. [init_check_tampered]`;
    }
    const missingAgents = missingRequiredInitCheckAgents(initCheck);
    if (missingAgents.length > 0) {
      return `Cannot enter INIT_CHECK: init-check.json is missing required reviewer records: ${missingAgents.join(', ')}. [missing_init_check_agent]\n` +
        `→ Preferred: separately run lattice dispatch '{"storyId":"${storyId}","agentType":"lattice-review-story-init"}' and product-reviewer; every reviewer must call init_check_set regardless of pass/fail.\n` +
        `→ Fallback (only when subagents cannot be spawned, controlled and audited):\n` +
        `   lattice init_check_repair '{"storyId":"${storyId}","acknowledge":true,"fallbackReason":"<why the reviewer cannot run + what you manually verified, >=30 chars>"}'`;
    }
    const blockers = blockingInitCheckIssues(initCheck);
    if (blockers.length > 0) {
      const lines = blockers.slice(0, 8).map(({ agentId, issue }) =>
        `  - ${agentId}: ${issue.severity} ${issue.id ? `${issue.id} ` : ''}${issue.desc}`,
      );
      return `Cannot enter INIT_CHECK: init-check reviewer recorded high/critical issues; you must fix them and re-run the corresponding reviewer first. [init_check_blocking_issues]\n${lines.join('\n')}`;
    }
    return null;
  }

  if (targetPhase === 'PLAN') {
    const story = store.readStory(storyId);
    if (story.phase !== 'IDEA') return null;
    const reproGate = evaluateStoryEvidenceBindingGate(projectRoot ?? process.cwd(), store, storyId);
    return formatStoryEvidenceBindingGateFailure('PLAN', storyId, reproGate);
  }

  if (targetPhase === 'DEV') {
    // First check whether taking the express channel from INIT_CHECK
    const story = store.readStory(storyId);
    // F-003: when the story takes the express (INIT_CHECK→DEV quickPath) channel, the
    // story-review record gate does NOT apply (express skips review), so the review-reason block
    // below must be skipped — otherwise an eligible express story shows a spurious "no review
    // record" message instead of the real (parallel-decomposition) reason it was blocked on.
    // F-006: the same holds for the REVIEW→DEV and TEST→DEV ROLLBACK doors — a rollback does not
    // re-demand a clean review (canReenterDevGuard applies ONLY the parallel check), so the review
    // block must be skipped for those phases too, leaving the parallel reason to render below.
    const isRollbackDoor = story.phase === 'REVIEW' || story.phase === 'TEST';
    let tookExpressChannel = false;
    if (story.phase === 'INIT_CHECK') {
      // Express channel failure reasons — read WorkflowPolicy
      const reasons: string[] = [];
      try {
        const config = loadConfig(projectRoot);
        const policy = resolveWorkflowPolicy(config, story);
        if (!policy.quickPath.enabled) {
          reasons.push(`Current profile=${policy.profile} disables the express channel`);
        } else {
          if (!policy.quickPath.allowRiskSignals && story.riskSignals && story.riskSignals.length > 0) {
            reasons.push(`Has high-risk signals (${story.riskSignals.map(r => r.category).join(', ')}); must go through the full PLAN`);
          }
          try {
            const cl = store.readChecklist(storyId);
            if (cl.items.length > policy.quickPath.maxChecklistItems) {
              reasons.push(`Checklist has ${cl.items.length} items (> ${policy.quickPath.maxChecklistItems}); must go through the full PLAN`);
            }
          } catch {
            reasons.push('No checklist; must run story_advance PLAN first');
          }
        }
      } catch {
        reasons.push('Unable to load configuration; must go through the full PLAN');
      }
      if (reasons.length > 0) {
        return `Cannot skip PLAN:\n${reasons.map(r => `  - ${r}`).join('\n')}\n→ story_advance '{"storyId":"${storyId}","phase":"PLAN"}' to enter the full PLAN flow`;
      }
      // No express-eligibility reasons => this story takes the express channel into DEV.
      tookExpressChannel = true;
    }

    if (!isRollbackDoor) {
      const reproGate = evaluateStoryEvidenceBindingGate(projectRoot ?? process.cwd(), store, storyId);
      const reproGateFailure = formatStoryEvidenceBindingGateFailure('DEV', storyId, reproGate);
      if (reproGateFailure) return reproGateFailure;
    }
    const proofStoryFailure = proofStoryDevGateFailure(store, projectRoot, storyId);
    if (proofStoryFailure) return proofStoryFailure;

    // Normal PLAN → DEV path: requires story_review to pass (unless policy does not require it).
    // Skipped entirely for an express-channel story AND for a rollback door (review does not apply
    // to either) — both fall straight through to the parallel-decomposition message below.
    if (!tookExpressChannel && !isRollbackDoor) try {
      const config2 = loadConfig(projectRoot);
      const story2 = store.readStory(storyId);
      const policy2 = resolveWorkflowPolicy(config2, story2);
      if (!policy2.plan.requireStoryReview) {
        // policy says no review needed — pass through
      } else {
        const reasons: string[] = [];
        try {
          const review = store.readReview(storyId);
          if (!review || !review.reviews || review.reviews.length === 0) {
            reasons.push('story_review check not passed (no review record)');
          } else {
            const lastRound = review.reviews[review.reviews.length - 1];
            const REVIEW_SALT = 'lattice-review-integrity-v1';
            const hashInput = `${storyId}:${lastRound.timestamp}:${lastRound.issueCount}:${lastRound.blockerCount ?? lastRound.issueCount}:${REVIEW_SALT}`;
            const expectedHash = createHash('sha256').update(hashInput).digest('hex');
            if (!lastRound._hash || lastRound._hash !== expectedHash) {
              reasons.push('review.json signature verification failed; review report must be generated by story_review CLI');
            } else if ((lastRound.blockerCount ?? lastRound.issueCount) !== 0) {
              // F-002: strict `!== 0` mirrors canStartDevGuard — a non-clean non-positive count
              // (negative/NaN) is NOT clean, so it must surface a reason here too.
              reasons.push(`Latest story_review round has ${lastRound.blockerCount ?? lastRound.issueCount} unresolved blocker(s)`);
            }
          }
        } catch {
          reasons.push('story_review check not passed (no review record)');
        }
        if (reasons.length > 0) {
          return `Cannot enter DEV:\n${reasons.map(r => `  - ${r}`).join('\n')}`;
        }
      }
    } catch {
      // config load failed — fall through (don't block on config error)
    }

    // Parallel-decomposition block message — mirrors canStartDevGuard's decision via the SAME
    // helper (parallelDecompositionEnforcedBlock) so the boolean and the message cannot drift.
    // FAIL-OPEN: on ANY error (or missing projectRoot) fall through to null — never fabricate a
    // block message on a gate/config error (spec §4.8). projectRoot is optional in this signature.
    if (projectRoot) {
      try {
        const config = loadConfig(projectRoot);
        const story = store.readStory(storyId);
        const policy = resolveWorkflowPolicy(config, story);
        const block = parallelDecompositionEnforcedBlock(store, projectRoot, story, policy.profile);
        if (block !== null) {
          return `Cannot enter DEV:\n  - ${formatParallelDecompositionBlock(block, story, store, projectRoot, policy.profile)}`;
        }
      } catch { /* fail-open: never fabricate a block message on a gate/config error */ }
    }
  }

  if (targetPhase === 'REVIEW') {
    const cl = store.readChecklist(storyId);
    const pending = cl.items.filter(i => i.status !== 'done');
    if (pending.length > 0) {
      return `Cannot enter REVIEW: ${pending.length} checklist item(s) not done: ${pending.map(i => i.id).join(', ')}`;
    }
    const reviewStory = store.readStory(storyId);
    const reviewPolicy = resolveWorkflowPolicy(loadConfig(projectRoot), reviewStory);
    const missingEvidence = getBlockingVerificationEvidenceIssues(cl, undefined, reviewPolicy.profile);
    if (missingEvidence.length > 0) {
      return `Cannot enter REVIEW: ${missingEvidence.length} required verification intent(s) lack passing evidence or waiver:\n${missingEvidence.map(i => `  - ${i}`).join('\n')}\n→ Run verification_evidence_add to record logic/integration/browser/manual evidence, or use waiver to explicitly exempt`;
    }
  }

  if (targetPhase === 'TEST') {
    // B-7a34 CHK-003: review loop gate — checked first, highest priority.
    // Open loop always blocks regardless of reviewer/finding state.
    try {
      const loopRecords = store.readReviewLoopRecords(storyId);
      const activeLoops = listActiveLoops(loopRecords);
      if (activeLoops.length > 0) {
        const details = activeLoops.map(loopId => {
          const latest = deriveLatestLoopRecord(loopRecords, loopId);
          const parts: string[] = [`loopId=${loopId}`];
          if (latest && latest.event === 'iteration') {
            const iter = latest as ReviewLoopIteration;
            parts.push(`decision=${iter.decision}`);
            if (iter.nextAction) {
              const naEntries = Object.entries(iter.nextAction)
                .filter(([, v]) => v != null)
                .map(([k, v]) => `${k}=${String(v)}`);
              if (naEntries.length > 0) parts.push(`nextAction={${naEntries.join(', ')}}`);
            }
          }
          return `  [open_loop] ${parts.join(', ')}`;
        });
        return (
          `Cannot enter TEST: active review loop(s) block REVIEW→TEST [open_review_loop]\n` +
          `${details.join('\n')}\n` +
          `→ 关闭所有 open loop（review_loop_close --status=resolved）后确保 trigger refs 已 resolved，再重跑 story_advance --phase=TEST`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Cannot enter TEST: review loop records could not be read [review_loop_record_error]\n  - ${msg}\n→ 修复 review-loops evidence 后重跑 story_advance --phase=TEST`;
    }

    const config = loadConfig(projectRoot);
    const story = store.readStory(storyId);
    const policy = resolveWorkflowPolicy(config, story);

    // If policy doesn't require reviewer, skip finding checks
    if (!policy.review.requireReviewer) {
      // no review gate — pass through
    } else {
      try {
        const findings = store.readFindings(storyId);
        const reviewPasses = store.readReviewPasses(storyId);
        if ((!findings.findings || findings.findings.length === 0) && (!reviewPasses.passes || reviewPasses.passes.length === 0)) {
          return `Cannot enter TEST: reviewer not run (no findings or review pass)\n→ Start reviewers per opt-in results (see lattice reviewer_list); when no issues, use review_pass_set to record pass`;
        }
        const evidenceState = collectReviewerEvidenceState(store, storyId, projectRoot ?? process.cwd());
        if (evidenceState.invalid.length > 0) {
          return `Cannot enter TEST: reviewer evidence has invalid/expired review run bindings:\n${evidenceState.invalid.slice(0, 5).map(issue => `  - ${issue.message}`).join('\n')}`;
        }
        if (policy.review.requireReviewerFinding) {
          const currentRound = story.currentReviewRound;
          const currentRoundReviewerEvidence = evidenceState.valid.map((e) => ({ agent: e.agent, kind: e.kind }));

          const { roundCount: rc } = resolveEffectiveBlockingSeverities(store, storyId, policy);
          if (rc <= 1) {
            // Round 1: require findings from every opt-in reviewer (same source as reviewer_list).
            let checklist: { items: unknown[] } = { items: [] };
            try { checklist = store.readChecklist(storyId); } catch {}
            let decision = null;
            try { decision = store.readDecision(storyId); } catch {}
            const understanding = store.readUnderstanding(storyId);
            const touchpoints = understanding?.touchpoints
              ?? detectMdTouchpointsFromGit(projectRoot ?? process.cwd());
            const optIn = computeActiveReviewers(story, checklist, decision, touchpoints);
            const missing = optIn.filter(reviewer => !currentRoundReviewerEvidence.some(
              e => findingAgentMatchesReviewer(e.agent, reviewer.name),
            ));
            if (missing.length > 0) {
              const names = optIn.map(r => r.name).join(',');
              const missingNames = missing.map(r => r.name).join(',');
              const presentAgents = Array.from(new Set(currentRoundReviewerEvidence.map(e => e.agent))).join(', ') || 'none';
              return `Cannot enter TEST: Expected ${optIn.length} reviewers (opt-in: ${names}); currently ${currentRoundReviewerEvidence.length} reviewer evidence covers ${optIn.length - missing.length} reviewer(s) (Missing: ${missingNames}; agents seen: ${presentAgents})\n→ Start the missing lattice-review-* agents in parallel; when no issues, use review_pass_set`;
            }

            // B-1fca CHK-002: quorum diagnostics for round 1 disputes/missing lanes
            const quorumR1 = evaluateReviewerQuorum({
              activeReviewers: optIn.map(r => r.name),
              evidence: buildQuorumEvidence(currentRoundReviewerEvidence),
              profile: policy.profile as 'light' | 'balanced' | 'strict',
            });
            if (!quorumR1.ok) {
              return `Cannot enter TEST: Reviewer quorum not met (Round 1):\n${quorumR1.blocking.map(m => `  - ${m}`).join('\n')}\n→ Re-run the corresponding reviewer after fixing reviewer dispute; when no issues, use review_pass_set`;
            }
          } else {
            if (currentRoundReviewerEvidence.length === 0) {
              return currentRound
                ? `Cannot enter TEST: Round ${rc} current review round (${currentRound}) has no reviewer finding/pass; please start the corresponding lattice-review-* agents`
                : `Cannot enter TEST: findings all come from main agent (reviewer not run)\n→ Start lattice-review-* subagent`;
            }
          }
        }
        const { effectiveBlockingSeverities, roundCount } = resolveEffectiveBlockingSeverities(store, storyId, policy);

        // B-3fad CHK-001: evidenceState dimension — only verified (or legacy missing-field) open findings block.
        const blocking = evidenceState.valid
          .map((e) => e.finding)
          .filter((finding): finding is Finding => !!finding)
          .filter((f) => isFindingBlocking(f, effectiveBlockingSeverities, roundCount));
        if (blocking.length > 0) {
          return `Cannot enter TEST: ${blocking.length} blocking finding(s) open (Round ${roundCount}, blocking: ${effectiveBlockingSeverities.join('/')}):\n${blocking.map(f => `  - ${f.id} [${f.severity}] ${f.desc}`).join('\n')}\n→ After fixing, finding_resolve, or to confirm not fixing use finding_dismiss (reason ≥10 characters required)`;
        }
      } catch {
        return `Cannot enter TEST: reviewer not run (no findings.json)\n→ Start reviewers per opt-in results (see lattice reviewer_list)`;
      }
    }
  }

  if (targetPhase === 'DONE') {
    const evidence = store.readTestEvidence(storyId);
    if (!evidence) {
      return 'Cannot enter DONE: no test evidence (run lattice validate first)';
    }
    if (evidence.result !== 'PASS') {
      return `Cannot enter DONE: test ${evidence.result}: ${evidence.output}`;
    }
    const bugs = store.readBugs(storyId);
    const openBugs = bugs.bugs.filter(b => b.status !== 'fixed');
    if (openBugs.length > 0) {
      return `Cannot enter DONE: ${openBugs.length} unfixed bug(s): ${openBugs.map(b => b.id).join(', ')}`;
    }

    // delivery-check.json signature and material freshness verification
    const deliveryCheckFreshness = evaluateDeliveryCheckFreshness(
      storyId,
      store,
      gitCwd ?? resolveGitCwd({
        store,
        storyId,
        metadataRoot: projectRoot ?? process.cwd(),
        projectRoot: projectRoot ?? process.cwd(),
      }),
      projectRoot ?? process.cwd(),
    );
    const deliveryCheck = deliveryCheckFreshness.deliveryCheck;
    if (!deliveryCheck) {
      return `Cannot enter DONE: missing delivery-check.json (requires lattice-review-delivery reviewer signature). [missing_delivery_check] → Run story_advance DEV to rework and fill in`;
    }
    if (deliveryCheckFreshness.code === 'delivery_check_tampered') {
      return `Cannot enter DONE: delivery-check.json _hash mismatch (content has been tampered with); please re-run lattice-review-delivery reviewer. [delivery_check_tampered] → Run story_advance DEV to rework and fill in`;
    }
    if (deliveryCheckFreshness.code === 'stale_delivery_check') {
      return `Cannot enter DONE: ${deliveryCheckFreshness.reason}; please re-run lattice-review-delivery reviewer. [stale_delivery_check] → Run story_advance DEV to rework and fill in`;
    }

    // every docsPromise must be verified or waived
    const unverifiedPromises = deliveryCheck.docsPromises.filter(
      p => !p.verifiedBy && !p.waiverReason && !['met', 'verified', 'waived'].includes(p.status || ''),
    );
    if (unverifiedPromises.length > 0) {
      const names = unverifiedPromises.map(p => p.docPath).join(', ');
      return `Cannot enter DONE: ${unverifiedPromises.length} docsPromise entries unverified and not waived: ${names}. [unverified_promise] → Use delivery_waiver_add to write a waiver or re-run reviewer → Run story_advance DEV to rework and fill in`;
    }

    const reviewEscalation = evaluateReviewEscalation({
      projectRoot: projectRoot ?? process.cwd(),
      gitCwd: gitCwd ?? resolveGitCwd({
        store,
        storyId,
        metadataRoot: projectRoot ?? process.cwd(),
        projectRoot: projectRoot ?? process.cwd(),
      }),
      storyId,
      store,
    });
    if (!reviewEscalation.ok) {
      return formatReviewEscalationFailure(reviewEscalation);
    }

    const reviewAssuranceFloor = evaluateReviewAssuranceFloor({
      projectRoot: projectRoot ?? process.cwd(),
      gitCwd: gitCwd ?? resolveGitCwd({
        store,
        storyId,
        metadataRoot: projectRoot ?? process.cwd(),
        projectRoot: projectRoot ?? process.cwd(),
      }),
      storyId,
      store,
    });
    if (!reviewAssuranceFloor.ok) {
      return formatReviewAssuranceFloorFailure(reviewAssuranceFloor);
    }
  }

  return null;
}
