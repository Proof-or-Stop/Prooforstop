import { convergenceProgressUnavailable } from './convergence-progress-gate.js';
import { acceptanceCompletionBlocker } from './acceptance-amendment-gates.js';
import { storyScopeBudgetBlocker } from './story-scope-budget.js';
import { rethrowIntentAmendmentIntegrityError } from './verification-intent-amendment.js';

import { setup, createActor, type SnapshotFrom } from 'xstate';
import type { StoryStore } from './store.js';
import { createHash } from 'crypto';
import { loadConfig } from './config.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
import type { Finding, ReviewLoopIteration, ScopeFreezeCheckData, ScopeFreezeIssue, StoryInfo, ScopeContractData, WorkflowProfile } from './types.js';
import { resolveAuditConfig } from './audit-config.js';
import { evaluateDecompositionGate, computeWriteSet, type ParallelDecompositionBlock } from './parallel-decomposition.js';
import { safeReadScopeContract } from './proof-or-stop-parallel-wave.js';
import { TERMINAL_PHASES } from './parallel-policy.js';
import { REQUIRED_INIT_CHECK_AGENTS, blockingInitCheckIssues, describeInitCheckSignatureDomain, initCheckSignatureIsValid, missingRequiredInitCheckAgents, recomputeInitCheckHash } from './init-check-gate.js';
import { deriveLatestLoopRecord, listActiveLoops } from './review-loop.js';
import { evaluateDeliveryCheckFreshness } from './delivery-check-hash.js';
import { deliveryPromiseBlocksDone } from './delivery-promise-outcome.js';
import { evaluateOptionalLiveSmokeTranscript } from './live-smoke-transcript-evidence.js';
import { getBlockingVerificationEvidenceIssues } from './verification.js';
import { createVerificationEvidenceGateEvaluator } from './proof-admissibility.js';
import { isTerminalChecklistStatus } from './checklist-status.js';
import { normalizeLegacyPhase } from './phase-flow.js';
import { findingAgentMatchesReviewer } from './reviewer-opt-in.js';
import { detectMdTouchpointsFromGit } from './touchpoints-fallback.js';
import { computeActiveReviewers, computeFinalReviewRoster } from '../handlers/reviewer-list.js';
import { collectReviewerEvidenceState } from './review-run.js';
import { readDynamicFindingDecision } from './finding-applicability-projection.js';
import { evaluateReviewMintStallAdjudication, type StallAdjudication } from './review-convergence.js';
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
  executionBoundaryHashIsFresh,
  EXECUTION_BOUNDARY_SCHEMA_VERSION,
  evaluateScopeFreeze,
  LEGACY_EXECUTION_BOUNDARY_SCHEMA_VERSION,
  LEGACY_SCOPE_FREEZE_CHECK_SCHEMA_VERSION,
  SCOPE_FREEZE_CHECK_SCHEMA_VERSION,
  scopeBoundaryHashIsFresh,
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
import { readTrustedProofStoryScopeArtifacts } from './closeout-trust.js';
import { tryBuildMaterialClassificationSnapshotForDiagnostics } from './material-code-policy.js';
import {
  describeRedEvidenceReadFailure,
  redEvidenceRepairGuidance,
  renderRedEvidenceQuarantineNotice,
} from './red-evidence-artifact-validation.js';
import { renderAgentLivenessGuidance } from './agent-liveness-policy.js';
import { reviewInventoryRemediationGate } from './review-inventory-epoch.js';
import { inspectDevMemoryFinishDecision } from './playbook-runtime-memory.js';
import { canonicalAgentRoleId } from './agent-role-identity.js';

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
  } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
    return [];
  }
}

/**
 * B-956f FIX G: production materialClassification for a diagnostic-input
 * builder. Resolution failures yield undefined (the field is DIAGNOSTIC; a
 * broken policy/config surfaces through the fail-closed resolve/floor/repro
 * consumers, never by breaking a transition guard).
 */
function proofStoryMaterialClassification(store: StoryStore, storyId: string, projectRoot?: string) {
  if (!projectRoot) return undefined;
  let gitCwd: string | undefined;
  try {
    gitCwd = resolveGitCwd({ store, storyId, metadataRoot: projectRoot, projectRoot });
  } catch {
    gitCwd = undefined;
  }
  return tryBuildMaterialClassificationSnapshotForDiagnostics(projectRoot, gitCwd);
}

function proofStoryDiagnosticInput(store: StoryStore, storyId: string, projectRoot?: string): ProofStoryDiagnosticInput {
  let checklist;
  try {
    checklist = store.readChecklist(storyId);
  } catch (error) { rethrowIntentAmendmentIntegrityError(error);
    rethrowIntentAmendmentIntegrityError(error);
    checklist = { items: [] };
  }
  const trusted = readTrustedProofStoryScopeArtifacts(store, storyId);
  return {
    story: store.readStory(storyId),
    checklist,
    originalIntentSnapshot: store.readOriginalIntentSnapshot(storyId),
    milestoneLedger: trusted.ledger,
    slicePlan: trusted.slicePlan,
    parentLedgerRollup: trusted.parentRollup,
    proofStoryContract: store.readProofStoryContract(storyId),
    intentCollision: store.readIntentCollision(storyId),
    scopeContract: store.readScopeContract(storyId),
    scopeShrinkageDecision: store.readScopeShrinkageDecision(storyId),
    // B-2aa7 CHK-006: deliberately NOT swallowed here. A corrupt artifact must
    // reach `proofStoryDevGateFailure`, which turns it into a named gate failure;
    // defaulting it to `null` in this builder would make corruption arrive at the
    // gate as an ABSENT artifact — the exact conflation this story removes.
    redEvidence: store.readRedEvidence(storyId),
    spikeEvidence: store.readProofStorySpikes(storyId),
    summary: store.readSummary(storyId),
    materialClassification: proofStoryMaterialClassification(store, storyId, projectRoot),
  };
}

function proofStoryDevGateFailure(store: StoryStore, projectRoot: string | undefined, storyId: string): string | null {
  if (!projectRoot) return null;
  const mode = loadConfig(projectRoot).proofStory?.devGateMode ?? 'observe';
  if (mode !== 'enforce') return null;
  // B-2aa7 CHK-006. Two ways a corrupt artifact reaches this gate, and they need
  // different handling:
  //
  //   REJECTED (throws) — the typed error would escape an xstate guard as a raw
  //     stack trace with no gate verdict at all (§10.4 forbids exactly that).
  //     Convert it into an ordinary DEV-gate failure string that says CORRUPT.
  //
  //   QUARANTINED (no throw) — `records` arrives clean, so the report says
  //     `missing_red_evidence`, which is the wording for an ABSENT artifact.
  //     Lead the failure with the corruption so the operator is not sent looking
  //     for a file that is right there and broken.
  //
  // The quarantine notice only ever DECORATES an already-blocking failure; it
  // never turns a passing gate into a blocking one. Rendering is not judging,
  // and inventing a new block here would move a verdict this story must not move.
  let input: ProofStoryDiagnosticInput;
  try {
    input = proofStoryDiagnosticInput(store, storyId, projectRoot);
  } catch (e) {
    const corruption = describeRedEvidenceReadFailure(e);
    if (corruption === null) throw e;
    return `Cannot enter DEV: this story's red-evidence artifact is corrupt, so the ProofStory DEV gate has no evidence `
      + `to evaluate. [red_evidence_corrupt]\n${corruption}\n${redEvidenceRepairGuidance(storyId)}`;
  }
  const report = evaluateProofStoryDiagnostics(input, 'enforce');
  if (!report.blocking) return null;
  const corruption = renderRedEvidenceQuarantineNotice(storyId, input.redEvidence);
  return `Cannot enter DEV: ProofStory DEV gate is enforce and required intent artifacts are incomplete.\n`
    + (corruption === null ? '' : `${corruption}\n${redEvidenceRepairGuidance(storyId)}\n`)
    + renderProofStoryDiagnosticReport(report);
}

function firstHardScopeIssue(check: ScopeFreezeCheckData): ScopeFreezeIssue | null {
  return check.issues.find(issue => issue.severity === 'hard') ?? null;
}

function initPreflightGuidance(storyId: string): string {
  return `→ To see all INIT_CHECK prerequisites, run \`proof-or-stop init_preflight --storyId=${storyId}\`.`;
}

function renderMissingInitReviewerDispatches(storyId: string, missingAgents: string[]): string {
  const dispatches = missingAgents.map(agentId => {
    if (agentId === 'proof-or-stop-review-story-init') {
      return `   Story owner runs proof-or-stop dispatch '{"storyId":"${storyId}","agentType":"proof-or-stop-review-story-init"}', then passes the returned prompt unchanged to Agent({ subagent_type: "proof-or-stop-review-story-init", prompt: "<owner-produced standard prompt>" })`;
    }
    if (agentId === 'proof-or-stop-product-reviewer') {
      return `   Story owner runs proof-or-stop dispatch '{"storyId":"${storyId}","agentType":"proof-or-stop-product-reviewer"}', then passes the returned prompt unchanged to Agent({ subagent_type: "proof-or-stop-product-reviewer", prompt: "<owner-produced standard prompt>" })`;
    }
    throw new Error(`unsupported required INIT reviewer: ${agentId}`);
  });
  return `→ Preferred: have the Story owner separately dispatch only the missing reviewer records:\n${dispatches.join('\n')}\n` +
    `   Every reviewer independently performs its reviewerWrite by calling init_check_set regardless of pass/fail; review_run_start begins only after the Story enters REVIEW, not during INIT.`;
}

function renderScopeFreezeIssue(storyId: string, issue: ScopeFreezeIssue): string {
  if (issue.code === 'missing_scope_boundary') {
    return `Cannot enter INIT_CHECK: scope-boundary.json is missing or invalid for ${storyId}. [missing_scope_boundary]\n` +
      `${initPreflightGuidance(storyId)}\n` +
      `→ Run scope_boundary_set with userConfirmed:true before creating the worktree.`;
  }
  if (issue.code === 'missing_execution_boundary') {
    return `Cannot enter INIT_CHECK: execution-boundary.json is missing or invalid for ${storyId}. [missing_execution_boundary]\n` +
      `${initPreflightGuidance(storyId)}\n` +
      `→ Run execution_boundary_set before creating the worktree.`;
  }
  if (issue.code === 'future_capability_keyword') {
    const source = issue.source ? ` in ${issue.source}${issue.itemId ? ` (${issue.itemId})` : ''}` : '';
    const keyword = issue.keyword ? `"${issue.keyword}"` : 'an excluded keyword';
    return `Cannot enter INIT_CHECK: excluded scope keyword ${keyword} appears${source}. [excluded_keyword]\n` +
      `${initPreflightGuidance(storyId)}\n` +
      `→ Remove the expansion from the frozen INIT text, or record a scope_extension_proposal and explicit decision before rerunning scope_freeze_check.`;
  }
  if (issue.code === 'repeat_discard_without_mitigation') {
    const digest = issue.digest ? ` ${issue.digest}` : '';
    return `Cannot enter INIT_CHECK: current direction repeats a discarded direction${digest} without mitigation. [repeat_discarded_direction]\n` +
      `${initPreflightGuidance(storyId)}\n` +
      `→ Provide repeatDiscardMitigation when rerunning scope_freeze_check, or choose a different scope boundary.`;
  }
  return `Cannot enter INIT_CHECK: scope-freeze-check failed for ${storyId}. [scope_freeze_check_failed]\n` +
    `${initPreflightGuidance(storyId)}`;
}

function readScopeGateFailure<T>(storyId: string, label: string, fn: () => T): { value: T; reason: null } | { value: null; reason: string } {
  try {
    return { value: fn(), reason: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const guidance = ['scope-boundary.json', 'execution-boundary.json', 'scope-freeze-check.json'].includes(label)
      ? `\n${initPreflightGuidance(storyId)}`
      : '';
    return {
      value: null,
      reason: `Cannot enter INIT_CHECK: ${label} could not be read. [${label.replace(/\.json$/, '').replaceAll('-', '_')}_unreadable]\n  - ${msg}${guidance}`,
    };
  }
}

export function evaluateScopeAntiExpansionGate(
  storyId: string,
  store: StoryStore,
): ScopeAntiExpansionGateResult {
  const scopeBoundary = readScopeGateFailure(storyId, 'scope-boundary.json', () => store.readScopeBoundary(storyId));
  if (scopeBoundary.reason) return { ok: false, reason: scopeBoundary.reason };
  if (scopeBoundary.value && !scopeBoundaryHashIsFresh(scopeBoundary.value)) {
    return {
      ok: false,
      reason: `Cannot enter INIT_CHECK: scope-boundary.json hash is stale or tampered. [scope_boundary_tampered]\n` +
        `${initPreflightGuidance(storyId)}\n` +
        `→ Recreate the scope boundary from an explicit user-confirmed scope; do not rewrite signed history.`,
    };
  }

  const executionBoundary = readScopeGateFailure(storyId, 'execution-boundary.json', () => store.readExecutionBoundary(storyId));
  if (executionBoundary.reason) return { ok: false, reason: executionBoundary.reason };
  if (
    executionBoundary.value
    && executionBoundary.value.schemaVersion !== EXECUTION_BOUNDARY_SCHEMA_VERSION
    && executionBoundary.value.schemaVersion !== LEGACY_EXECUTION_BOUNDARY_SCHEMA_VERSION
  ) {
    return {
      ok: false,
      reason: `Cannot enter INIT_CHECK: execution-boundary.json has unsupported schemaVersion ${String(executionBoundary.value.schemaVersion)}. [execution_boundary_unreadable]`,
    };
  }
  if (executionBoundary.value && !executionBoundaryHashIsFresh(executionBoundary.value)) {
    return {
      ok: false,
      reason: `Cannot enter INIT_CHECK: execution-boundary.json hash is stale or tampered. [execution_boundary_tampered]\n` +
        `${initPreflightGuidance(storyId)}\n` +
        `→ Recreate the execution boundary from the user-confirmed envelope; do not rewrite signed history.`,
    };
  }

  const freezeCheck = readScopeGateFailure(storyId, 'scope-freeze-check.json', () => store.readScopeFreezeCheck(storyId));
  if (freezeCheck.reason) return { ok: false, reason: freezeCheck.reason };
  if (
    freezeCheck.value
    && freezeCheck.value.schemaVersion !== SCOPE_FREEZE_CHECK_SCHEMA_VERSION
    && freezeCheck.value.schemaVersion !== LEGACY_SCOPE_FREEZE_CHECK_SCHEMA_VERSION
  ) {
    return {
      ok: false,
      reason: `Cannot enter INIT_CHECK: scope-freeze-check.json has unsupported schemaVersion ${String(freezeCheck.value.schemaVersion)}. [scope_freeze_check_unreadable]`,
    };
  }

  const proposals = readScopeGateFailure(storyId, 'scope-extension-proposals.json', () => store.readScopeExtensionProposals(storyId));
  if (proposals.reason) return { ok: false, reason: proposals.reason };
  if (!proposals.value) {
    return {
      ok: false,
      reason: `Cannot enter INIT_CHECK: scope-extension-proposals.json could not be read. [scope_extension_proposals_unreadable]`,
    };
  }

  const discardDigest = readScopeGateFailure(storyId, 'scope-discard-digest.json', () => store.readScopeDiscardDigestForFreeze(storyId));
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
        `${initPreflightGuidance(storyId)}\n` +
        `→ Run scope_freeze_check after scope_boundary_set and execution_boundary_set.`,
    };
  }
  if (storedCheck._hash !== digestScopeFreezeCheck(storedCheck)) {
    return {
      ok: false,
      reason: `Cannot enter INIT_CHECK: scope-freeze-check.json hash is stale or tampered. [scope_freeze_check_stale]\n` +
        `${initPreflightGuidance(storyId)}\n` +
        `→ Rerun scope_freeze_check before creating the worktree.`,
    };
  }
  if (storedCheck.status !== 'pass') {
    const storedIssue = firstHardScopeIssue(storedCheck);
    return {
      ok: false,
      reason: storedIssue
        ? renderScopeFreezeIssue(storyId, storedIssue)
        : `Cannot enter INIT_CHECK: scope-freeze-check.json status is ${storedCheck.status}. [scope_freeze_check_failed]\n${initPreflightGuidance(storyId)}\n→ Resolve the freeze issues and rerun scope_freeze_check.`,
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
        `${initPreflightGuidance(storyId)}\n` +
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

/**
 * B-a7c5 CHK-001: dev-memory preflight-acknowledgement gate, checked at every
 * DEV-entry door (canStartDevGuard / canSkipPlanGuard / canReenterDevGuard).
 *
 * SIMPLE existence-check model (mirrors canFinishGuard's test-evidence check:
 * read → check truthy), NOT the hash/staleness model scope-freeze-check uses
 * — the ack just needs to exist once per story; it is never re-validated
 * against current material.
 *
 * A missing artifact (store.readDevMemoryPreflightAck returns null) and a
 * corrupt/hand-crafted artifact (malformed JSON -- a SyntaxError from
 * JSON.parse, or a well-formed-but-wrong-shape object) are both treated as
 * ABSENT (return false, no throw) -- a `{}` or truncated file can never
 * satisfy the gate. A genuine unexpected read fault (permission denied,
 * EISDIR, disk error -- anything that is not a missing artifact or a JSON
 * parse failure) is deliberately NOT swallowed here: it propagates to the
 * caller. canStartDevGuard/canSkipPlanGuard's own outer catches are
 * fail-CLOSED (infra error -> block, same net effect as before), but
 * canReenterDevGuard's outer catch is fail-OPEN by design (F-006/spec
 * §4.8: a rollback door must never be stranded by a gate/config error) --
 * catching every error class here unconditionally would have silently
 * broken that guarantee for this one check, which is exactly what the
 * REVIEW quality lane caught (empirically, via a forced EISDIR on the ack
 * path making canReenterDevGuard wrongly return false instead of true).
 */
export function evaluateDevMemoryPreflightGate(storyId: string, store: StoryStore): boolean {
  let ack;
  try {
    ack = store.readDevMemoryPreflightAck(storyId);
  } catch (e) {
    if (e instanceof SyntaxError) return false;
    throw e;
  }
  if (!ack) return false;
  if (ack.schemaVersion !== 'proof-or-stop.dev_memory_preflight_ack.v1') return false;
  if (typeof ack.storyId !== 'string' || ack.storyId !== storyId) return false;
  if (!Array.isArray(ack.topHitIds)) return false;
  if (typeof ack.acknowledgedAt !== 'string' || !ack.acknowledgedAt) return false;
  if (typeof ack.acknowledgedBy !== 'string' || !ack.acknowledgedBy) return false;
  return true;
}

export function checklistAllDoneGuard(context: StoryMachineContext): boolean {
  if (acceptanceCompletionBlocker(context.store, context.storyId, context.gitCwd ?? context.projectRoot ?? process.cwd())) return false;
  const cl = context.store.readChecklist(context.storyId);
  // B-1909 CHK-002: advance when every item is TERMINAL (done OR withdrawn); a
  // withdrawn item is recorded-undeliverable and no longer outstanding. The
  // verification-evidence check below does not require a withdrawn item's
  // intents (buildVerificationCoverage skips withdrawn items).
  if (!cl.items.every(item => isTerminalChecklistStatus(item.status))) return false;
  const story = context.store.readStory(context.storyId);
  const policy = resolveWorkflowPolicy(loadConfig(context.projectRoot), story);
  return getBlockingVerificationEvidenceIssues(
    cl,
    undefined,
    policy.profile,
    createVerificationEvidenceGateEvaluator(context.projectRoot, context.storyId),
  ).length === 0;
}

/**
 * B-7813 CHK-001: the mint-site stall adjudication for the DEV→REVIEW
 * (CODE_REVIEW) transition — the site where an ordinary review round is minted.
 *
 * Reads the observable round history via the pure-ish store consumer
 * evaluateReviewMintStallAdjudication (which itself reuses the EXISTING
 * assessReviewConvergence trend detector — no raw round ceiling here). Returns
 * the adjudication; the caller refuses the mint when blocked.
 *
 * A guard must not throw into the actor. Observation-integrity errors become
 * explicit blocked results, distinct from a verified no-progress conclusion.
 */
export function reviewRoundMintStallAdjudication(context: StoryMachineContext): StallAdjudication {
  try {
    return evaluateReviewMintStallAdjudication(context.store, context.storyId);
  } catch (error) {
    return convergenceProgressUnavailable(error);
  }
}

/**
 * B-7813 CHK-001: combined guard for the DEV→REVIEW (CODE_REVIEW) mint. The
 * round is minted only when the checklist/evidence gate passes AND the
 * convergence-stall adjudication does not block. Order mirrors
 * getGuardFailureReason's REVIEW branch so the boolean and the rendered reason
 * cannot drift.
 */
export function canMintReviewRoundGuard(context: StoryMachineContext): boolean {
  if (!checklistAllDoneGuard(context)) return false;
  return !reviewRoundMintStallAdjudication(context).blocked;
}

export function canEnterInitCheckGuard(context: StoryMachineContext): boolean {
  try {
    const story = context.store.readStory(context.storyId);
    if (story.phase !== 'INIT') return true; // Other sources such as IDEA→INIT_CHECK are not gated
    if (getScopeAntiExpansionGuardFailureReason(context.storyId, context.store, context.projectRoot)) return false;
    const initCheck = context.store.readInitCheck(context.storyId);
    if (!initCheck) return false;
    // Verify against the SNAPSHOT already read, not a second read of the file: the
    // verdict is inside the domain since B-8df9 CHK-002, so re-reading would leave a
    // window in which the record that is hashed is not the record that is judged.
    // The comparison rule itself is initCheckSignatureIsValid (B-8df9 CHK-003) — the
    // same one the carry-forward crosses — so "trusted" cannot mean two things.
    return initCheckSignatureIsValid(context.storyId, context.store, context.projectRoot, initCheck)
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
  if (storyScopeBudgetBlocker(context.store, context.projectRoot, context.storyId)) return false;
  // Passing story_review is a prerequisite for entering DEV (unless policy does not require it)
  try {
    const config = loadConfig(context.projectRoot);
    const story = context.store.readStory(context.storyId);
    const policy = resolveWorkflowPolicy(config, story);
    // B-a7c5 CHK-001: dev-memory preflight ack, checked on EVERY door into DEV
    // (not just this primary PLAN→DEV path) — see evaluateDevMemoryPreflightGate.
    if (!evaluateDevMemoryPreflightGate(context.storyId, context.store)) return false;
    if (evaluateStoryEvidenceBindingGate(context.projectRoot, context.store, context.storyId).blocking) return false;
    if (proofStoryDevGateFailure(context.store, context.projectRoot, context.storyId)) return false;
    // F-001: ONLY the review-record checks are gated on requireStoryReview. The parallel
    // sub-check below must run on EVERY door into DEV (it used to be skipped when review was
    // not required, which made the hard block bypassable). The early `return true` is gone.
    if (policy.plan.requireStoryReview) {
      const review = context.store.readReview(context.storyId);
      if (!review || !review.reviews || review.reviews.length === 0) return false;
      const lastRound = review.reviews[review.reviews.length - 1];
      const REVIEW_SALT = 'proof-or-stop-review-integrity-v1';
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

/**
 * B-8b69: gated PLAN->INIT reopen guard. Structurally, the reopen is legal only
 * from PLAN (the xstate PLAN state is the sole owner of the REOPEN edge, and the
 * non-xstate parallel table below restricts it to the PLAN case). This guard
 * fails closed on a missing/unreadable story. The REQUIRED, audited reason is NOT
 * checked here — the pure machine guard has no access to the command args; the
 * transition orchestrator enforces the reason before sending the REOPEN event.
 */
export function canReopenToInitGuard(context: StoryMachineContext): boolean {
  try {
    return context.store.readStory(context.storyId).phase === 'PLAN';
  } catch {
    return false;
  }
}

export function canSkipPlanGuard(context: StoryMachineContext): boolean {
  if (storyScopeBudgetBlocker(context.store, context.projectRoot, context.storyId)) return false;
  // Express channel: WorkflowPolicy decides whether skipping PLAN is allowed
  try {
    const config = loadConfig(context.projectRoot);
    const story = context.store.readStory(context.storyId);
    const policy = resolveWorkflowPolicy(config, story);
    if (!policy.quickPath.enabled) return false;
    if (!policy.quickPath.allowRiskSignals && story.riskSignals && story.riskSignals.length > 0) return false;
    const cl = context.store.readChecklist(context.storyId);
    if (cl.items.length > policy.quickPath.maxChecklistItems) return false;
    // B-a7c5 CHK-001: the express channel is ALSO a door into DEV — same ack requirement.
    if (!evaluateDevMemoryPreflightGate(context.storyId, context.store)) return false;
    if (evaluateStoryEvidenceBindingGate(context.projectRoot, context.store, context.storyId).blocking) return false;
    if (proofStoryDevGateFailure(context.store, context.projectRoot, context.storyId)) return false;
    // F-003: the INIT_CHECK→DEV express channel is ALSO a door into DEV, so it must enforce the
    // SAME parallel hard-block (otherwise an express story bypasses the gate). Shared FAIL-OPEN
    // wrapper: a gate/config infra error must never strand the express channel.
    if (parallelDevEntryBlock(context.store, context.projectRoot, story, policy.profile) !== null) return false;
    return true;
  } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
    return false;
  }
}

/**
 * F-006: the ROLLBACK doors REVIEW→DEV and TEST→DEV ("rework" via story_advance DEV). These are
 * do not re-demand a clean final review, but REVIEW→DEV now requires the signed
 * frozen-inventory saturation receipt that authorizes one aggregated remediation. Both doors
 * ARE doors into DEV, so they also enforce the SAME ProofStory DEV admission gate and parallel
 * hard-block used by PLAN/INIT_CHECK DEV entry. Inventory authority is the
 * exception to the legacy rollback fail-open rule: unreadable/invalid inventory
 * evidence fails closed before entering the legacy rollback gates.
 * Returns true to ALLOW re-entry, false to refuse. FAIL-OPEN: any infra error → allow (a rollback
 * must never be stranded by a gate/config error), via proofStoryDevGateFailure,
 * parallelDevEntryBlock, and the outer catch.
 */
export function canReenterDevGuard(context: StoryMachineContext): boolean {
  if (storyScopeBudgetBlocker(context.store, context.projectRoot, context.storyId)) return false;
  let inventoryStory: StoryInfo | undefined;
  try {
    inventoryStory = context.store.readStory(context.storyId);
    if (inventoryStory.phase === 'REVIEW') {
      const inventory = reviewInventoryRemediationGate(
        context.store, context.storyId, inventoryStory.currentReviewRound,
      );
      if (!inventory.ok) return false;
    }
  } catch {
    if (inventoryStory?.phase === 'REVIEW') return false;
  }
  try {
    const config = loadConfig(context.projectRoot);
    const story = inventoryStory ?? context.store.readStory(context.storyId);
    const policy = resolveWorkflowPolicy(config, story);
    // B-a7c5 CHK-001: a rollback (REVIEW/TEST→DEV) is ALSO a door into DEV. The ack
    // persists for the story's whole lifetime once written by the first PLAN/INIT_CHECK
    // entry, so a legitimate rollback finds it already present and passes through with
    // zero added friction — but a story that somehow never wrote one (e.g. predates this
    // gate) is refused here too, not silently fail-opened like an infra error would be.
    if (!evaluateDevMemoryPreflightGate(context.storyId, context.store)) return false;
    if (proofStoryDevGateFailure(context.store, context.projectRoot, context.storyId)) return false;
    return parallelDevEntryBlock(context.store, context.projectRoot, story, policy.profile) === null;
  } catch {
    return true; // FAIL-OPEN: an infra error must never block a rollback into DEV (spec §4.8)
  }
}

export interface ReviewVerdict {
  ok: boolean;
  code?: 'open_review_loop' | 'review_loop_record_error' | 'review_round_missing' | 'review_evidence_missing' | 'review_evidence_invalid' | 'review_lane_missing' | 'review_quorum' | 'review_finding_blocking' | 'review_verdict_error';
  message?: string;
}

/** Read-only, phase-agnostic reviewer verdict shared by REVIEW→TEST and TEST→DONE. */
export function evaluateReviewVerdict(context: StoryMachineContext): ReviewVerdict {
  try {
    const amendment = acceptanceCompletionBlocker(context.store, context.storyId, context.gitCwd ?? context.projectRoot ?? process.cwd());
    if (amendment) return { ok: false, code: 'review_evidence_invalid', message: amendment };
    const loopRecords = context.store.readReviewLoopRecords(context.storyId);
    const activeLoops = listActiveLoops(loopRecords);
    if (activeLoops.length > 0) {
      const details = activeLoops.map((loopId) => {
        const latest = deriveLatestLoopRecord(loopRecords, loopId);
        const parts = [`loopId=${loopId}`];
        if (latest?.event === 'iteration') {
          const iteration = latest as ReviewLoopIteration;
          parts.push(`decision=${iteration.decision}`);
          const nextAction = Object.entries(iteration.nextAction ?? {})
            .filter(([, value]) => value != null)
            .map(([key, value]) => `${key}=${String(value)}`);
          if (nextAction.length > 0) parts.push(`nextAction={${nextAction.join(', ')}}`);
        }
        return parts.join(', ');
      });
      return { ok: false, code: 'open_review_loop', message: `active review loop(s): ${details.join('; ')}` };
    }
  } catch (error) {
    return { ok: false, code: 'review_loop_record_error', message: `review loop records unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const config = loadConfig(context.projectRoot);
    const story = context.store.readStory(context.storyId);
    const policy = resolveWorkflowPolicy(config, story);

    if (!policy.review.requireReviewer) return { ok: true };
    if (!story.currentReviewRound) {
      return {
        ok: false,
        code: 'review_round_missing',
        message: 'reviewer-required lifecycle transition has no currentReviewRound; unsigned legacy-shaped evidence is not admissible',
      };
    }

    const findings = context.store.readFindings(context.storyId);
    const reviewPasses = context.store.readReviewPasses(context.storyId);
    if ((!findings.findings || findings.findings.length === 0) && (!reviewPasses.passes || reviewPasses.passes.length === 0)) {
      return { ok: false, code: 'review_evidence_missing', message: 'reviewer not run (no findings or review pass)' };
    }
    const evidenceState = collectReviewerEvidenceState(context.store, context.storyId, context.projectRoot);
    if (evidenceState.invalid.length > 0) {
      return { ok: false, code: 'review_evidence_invalid', message: evidenceState.invalid.slice(0, 5).map(issue => issue.message).join('; ') };
    }
    if (evidenceState.valid.length === 0) {
      return { ok: false, code: 'review_evidence_missing', message: 'no valid current-round proof-or-stop-review-* finding or pass' };
    }

    // Check for reviewer-produced finding if policy requires it
    if (policy.review.requireReviewerFinding) {
      const currentRoundReviewerEvidence = evidenceState.valid.map((e) => ({ agent: e.agent, kind: e.kind }));

      {
        // The former round-2+ single-receipt shortcut could call one lane sufficient
        // after remediation changed material. Consume only the current signed
        // canonical impact closure; unknown impact fails closed to all active lanes.
        // Round number alone never narrows the required set.
        let checklist: { items: unknown[] } = { items: [] };
        try { checklist = context.store.readChecklist(context.storyId); } catch (error) { rethrowIntentAmendmentIntegrityError(error); rethrowIntentAmendmentIntegrityError(error); }
        let decision = null;
        try { decision = context.store.readDecision(context.storyId); } catch {}
        const understanding = context.store.readUnderstanding(context.storyId);
        const touchpoints = understanding?.touchpoints
          ?? detectMdTouchpointsFromGit(context.projectRoot ?? process.cwd());
        const active = computeActiveReviewers(story, checklist, decision, touchpoints);
        const optIn = computeFinalReviewRoster(
          context.store,
          context.projectRoot ?? process.cwd(),
          context.storyId,
          active,
        ).requiredReviewers;
        const missing = optIn.filter(reviewer => !currentRoundReviewerEvidence.some(
          e => findingAgentMatchesReviewer(e.agent, reviewer.name),
        ));
        if (missing.length > 0) {
          const expected = optIn.map(row => row.name);
          const covered = expected.filter(name => currentRoundReviewerEvidence.some(
            evidence => findingAgentMatchesReviewer(evidence.agent, name),
          ));
          const agentsSeen = [...new Set(currentRoundReviewerEvidence.map(evidence => evidence.agent))];
          return {
            ok: false,
            code: 'review_lane_missing',
            message: [
              `Expected ${expected.length} reviewers (opt-in: ${expected.join(',')})`,
              `Covered ${covered.length}/${expected.length}`,
              `Missing: ${missing.map(row => row.name).join(',')}`,
              `Reviewer agents seen: ${agentsSeen.length > 0 ? agentsSeen.join(',') : '(none)'}`,
            ].join('; '),
          };
        }

        // B-1fca CHK-002: quorum gate for round 1
        const quorum = evaluateReviewerQuorum({
          activeReviewers: optIn.map(r => r.name),
          evidence: buildQuorumEvidence(evidenceState.valid),
          profile: policy.profile as 'light' | 'balanced' | 'strict',
        });
        if (!quorum.ok) {
          return { ok: false, code: 'review_quorum', message: quorum.blocking.join('; ') };
        }
      }
    }

    const { effectiveBlockingSeverities, roundCount } = resolveEffectiveBlockingSeverities(context.store, context.storyId, policy);

    // Check blocking severities from policy (with round decay).
    // B-3fad CHK-001: evidenceState dimension — only verified (or legacy missing-field) open findings block;
    // suspected / disproven do not block REVIEW→TEST.
    const blocking = evidenceState.valid
      .map((e) => e.finding)
      .filter((finding): finding is Finding => !!finding)
      .map((finding) => ({ finding, decision: readDynamicFindingDecision({ store: context.store,
        projectRoot: context.projectRoot, storyId: context.storyId, finding, effectiveBlockingSeverities, round: roundCount }) }))
      .filter((row) => row.decision.blocking);
    if (blocking.length > 0) {
      return {
        ok: false,
        code: 'review_finding_blocking',
        message: `${blocking.length} open blocking finding(s): ${blocking.map(row => `${row.finding.id} [${row.finding.severity}] ${row.finding.desc} (${row.decision.reason})`).join('; ')}`,
      };
    }
    return { ok: true };
  } catch (error) { rethrowIntentAmendmentIntegrityError(error);
    return { ok: false, code: 'review_verdict_error', message: error instanceof Error ? error.message : String(error) };
  }
}

export function canPassReviewGuard(context: StoryMachineContext): boolean {
  return evaluateReviewVerdict(context).ok;
}

/** One ordered source for the boolean DONE gate, diagnostic, and preflight. */
export interface DonePredicateResult {
  id: string;
  oracleRowId: string;
  ok: boolean;
  failureReason: string | null;
  value: unknown;
}

function donePredicate<T>(id: string, oracleRowId: string, value: T, failureReason: string | null): DonePredicateResult {
  return { id, oracleRowId, value, ok: failureReason === null, failureReason };
}

/**
 * Lazy evaluation preserves the first-failure diagnostic order. The oracle
 * collects all results, while the guard and diagnostic stop at the first
 * failure. Adding a predicate here automatically reaches all three consumers.
 * Record contents and reviewer evidence are only read, never repaired here.
 */
export function* evaluateDonePredicates(context: StoryMachineContext): Generator<DonePredicateResult> {
  const { storyId, store, projectRoot } = context;
  const amendment = acceptanceCompletionBlocker(store, storyId, context.gitCwd ?? projectRoot ?? process.cwd());
  yield donePredicate('acceptance-amendment', 'acceptance-amendment', amendment, amendment ? `[acceptance_amendment_blocked] ${amendment}` : null);
  const evidence = store.readTestEvidence(storyId);
  yield donePredicate('test-evidence', 'test-evidence', evidence,
    !evidence ? 'Cannot enter DONE: no test evidence (run proof-or-stop validate first)'
      : evidence.result !== 'PASS' ? `Cannot enter DONE: test ${evidence.result}: ${evidence.output}` : null);

  const bugs = store.readBugs(storyId);
  const openBugs = bugs.bugs.filter(b => b.status !== 'fixed');
  yield donePredicate('bugs-fixed', 'bugs-fixed', bugs, openBugs.length > 0
    ? `Cannot enter DONE: ${openBugs.length} unfixed bug(s): ${openBugs.map(b => b.id).join(', ')}` : null);

  // Presence alone is a completeness signal; lesson contents are not authority.
  const finishDecisionRead = inspectDevMemoryFinishDecision(projectRoot, storyId);
  const finishDecision = finishDecisionRead.record;
  yield donePredicate('dev-memory-finish-decision', 'dev-memory-finish-decision', finishDecisionRead, finishDecisionRead.unsupportedIdentity
    ? `Cannot enter DONE: ${finishDecisionRead.unsupportedIdentity}. [unsupported_identity]`
    : !finishDecision
    ? `Cannot enter DONE: dev_memory_finish_decision has not been recorded. [missing_dev_memory_finish_decision]\n` +
      `→ Run \`proof-or-stop dev_memory_finish_decision --storyId=${storyId} --decision=captured|no-reusable-lesson|defer-with-reason\`.`
    : null);

  const gitCwd = context.gitCwd ?? resolveGitCwd({ store, storyId, metadataRoot: projectRoot, projectRoot });
  const deliveryCheckFreshness = evaluateDeliveryCheckFreshness(storyId, store, gitCwd, projectRoot);
  const deliveryCheck = deliveryCheckFreshness.deliveryCheck;
  yield donePredicate('delivery-presence', 'delivery-check', deliveryCheckFreshness, !deliveryCheck
    ? 'Cannot enter DONE: missing delivery-check.json (requires proof-or-stop-review-delivery reviewer signature). [missing_delivery_check] → Run story_advance DEV to rework and fill in'
    : null);

  // Keep the established diagnostic precedence: missing delivery first, then
  // a failed optional transcript, then delivery signature/material failures.
  const liveSmokeTranscript = evaluateOptionalLiveSmokeTranscript(store, storyId);
  yield donePredicate('live-smoke-transcript', 'live-smoke-transcript', liveSmokeTranscript, !liveSmokeTranscript.ok
    ? `Cannot enter DONE: ${liveSmokeTranscript.reason}. [live_smoke_transcript_failed] → Re-run proof-or-stop live_smoke_transcript with a passing command and --write` : null);

  yield donePredicate('delivery-integrity', 'delivery-check', deliveryCheckFreshness,
    deliveryCheckFreshness.code === 'delivery_check_tampered'
      ? 'Cannot enter DONE: delivery-check.json _hash mismatch (content has been tampered with); please re-run proof-or-stop-review-delivery reviewer. [delivery_check_tampered] → Run story_advance DEV to rework and fill in'
      : deliveryCheckFreshness.code === 'stale_delivery_check'
        ? `Cannot enter DONE: ${deliveryCheckFreshness.reason}; please re-run proof-or-stop-review-delivery reviewer. [stale_delivery_check] → Run story_advance DEV to rework and fill in`
        : !deliveryCheckFreshness.ok
          ? `Cannot enter DONE: ${deliveryCheckFreshness.reason}. [${deliveryCheckFreshness.code}]`
          : null);

  // Rejected artifacts are opaque: eager preflight must not traverse contents
  // after the lazy guard has already rejected their integrity predicate.
  const unverifiedPromises = deliveryCheckFreshness.ok && deliveryCheck
    ? deliveryCheck.docsPromises.filter(deliveryPromiseBlocksDone) : [];
  yield donePredicate('delivery-promises', 'delivery-check', unverifiedPromises, unverifiedPromises.length > 0
    ? `Cannot enter DONE: ${unverifiedPromises.length} docsPromise entries unverified and not waived: ${unverifiedPromises.map(p => p.docPath).join(', ')}. [unverified_promise] → Use delivery_waiver_add to write a waiver or re-run reviewer → Run story_advance DEV to rework and fill in` : null);

  const reviewVerdict = evaluateReviewVerdict(context);
  yield donePredicate('review-verdict', 'review-verdict', reviewVerdict, !reviewVerdict.ok
    ? reviewVerdict.code === 'review_evidence_invalid'
      ? `Cannot enter DONE: ${reviewVerdict.message}. [stale_closeout_review] → Return to DEV/REVIEW and record current reviewer evidence before TEST`
      : `Cannot enter DONE: ${reviewVerdict.message}. [${reviewVerdict.code}] → Return to DEV/REVIEW and record current reviewer evidence before TEST`
    : null);

  const reviewEscalation = evaluateReviewEscalation({ projectRoot, gitCwd, storyId, store });
  yield donePredicate('review-escalation', 'review-escalation', reviewEscalation,
    !reviewEscalation.ok ? formatReviewEscalationFailure(reviewEscalation) : null);
  const reviewAssuranceFloor = evaluateReviewAssuranceFloor({ projectRoot, gitCwd, storyId, store });
  yield donePredicate('review-assurance-floor', 'review-assurance-floor', reviewAssuranceFloor,
    !reviewAssuranceFloor.ok ? formatReviewAssuranceFloorFailure(reviewAssuranceFloor) : null);
}

export function firstDonePredicateFailure(context: StoryMachineContext): DonePredicateResult | null {
  for (const result of evaluateDonePredicates(context)) {
    if (!result.ok) return result;
  }
  return null;
}

/** Presentation consumes the already-read fact rather than invoking a second reader. */
export function donePredicateValue<T>(results: readonly DonePredicateResult[], id: string): T {
  const result = results.find(candidate => candidate.id === id);
  if (!result) throw new Error(`Missing shared DONE predicate result: ${id}`);
  return result.value as T;
}

export function canFinishGuard(context: StoryMachineContext): boolean {
  return firstDonePredicateFailure(context) === null;
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
      // B-8b69: START advances to DEV; REOPEN is the gated backward edge to INIT
      // (unfreeze a scope-flagged title). Keep this in sync with the xstate PLAN state.
      return (eventType === 'START' && canStartDevGuard(context))
        || (eventType === 'REOPEN' && canReopenToInitGuard(context));
    case 'DEV':
      // B-7813 CHK-001: CODE_REVIEW mints a review round — enforce the stall
      // adjudication here too so the snapshot-can fallback agrees with the
      // xstate canMintReviewRound guard.
      return eventType === 'REPLAN' || (eventType === 'CODE_REVIEW' && canMintReviewRoundGuard(context));
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
      | { type: 'REOPEN' }
      | { type: 'CODE_REVIEW' }
      | { type: 'REVIEW_PASS' }
      | { type: 'FINISH' },
  },
  guards: {
    checklistAllDone: ({ context }) => checklistAllDoneGuard(context),
    // B-7813 CHK-001: DEV→REVIEW mint gate = checklistAllDone AND not stalled
    // without a current-round resolution.
    canMintReviewRound: ({ context }) => canMintReviewRoundGuard(context),
    // B-e71f CHK-006: xstate-side fallback for the INIT→INIT_CHECK hard gate.
    // getGuardFailureReason in phase-gates.ts is only invoked by resolveGuardFailure when actor.can() returns false,
    // so a guard must be attached to the INIT→INIT_CHECK transition here; otherwise can() will always be true and the gate will never fire.
    // The guard and getGuardFailureReason share the same decision logic: missing init-check.json → false;
    // _hash mismatch → false; pass → true. The failure reason is rendered as a human-readable message by getGuardFailureReason.
    canEnterInitCheck: ({ context }) => canEnterInitCheckGuard(context),
    canEnterPlan: ({ context }) => canEnterPlanGuard(context),
    // B-8b69: gated PLAN->INIT reopen. The guard only certifies the transition is
    // structurally legal (story is at PLAN); the required, audited reason is
    // enforced by the transition orchestrator, which owns the command args.
    canReopenToInit: ({ context }) => canReopenToInitGuard(context),
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
        // B-8b69: gated backward edge to INIT so a PLAN scope review that flags a
        // frozen checklist title can be honored (INIT is the only phase where
        // title/context is editable). Reason enforcement lives in the orchestrator.
        REOPEN: { target: 'INIT', guard: 'canReopenToInit' },
      },
    },
    DEV: {
      on: {
        CODE_REVIEW: {
          target: 'REVIEW',
          // B-7813 CHK-001: mint gate — checklistAllDone + convergence-stall
          // adjudication (refuses another ordinary round when stalled without a
          // current-round resolution).
          guard: 'canMintReviewRound',
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
        `${initPreflightGuidance(storyId)}\n` +
        `Missing required reviewer records: ${REQUIRED_INIT_CHECK_AGENTS.join(', ')}\n` +
        `→ Preferred: have the Story owner prepare both independent reviewers\n` +
        `   Story owner runs proof-or-stop dispatch '{"storyId":"${storyId}","agentType":"proof-or-stop-review-story-init"}', then passes the returned prompt unchanged to Agent({ subagent_type: "proof-or-stop-review-story-init", prompt: "<owner-produced standard prompt>" })\n` +
        `   Story owner runs proof-or-stop dispatch '{"storyId":"${storyId}","agentType":"proof-or-stop-product-reviewer"}', then passes the returned prompt unchanged to Agent({ subagent_type: "proof-or-stop-product-reviewer", prompt: "<owner-produced standard prompt>" })\n` +
        `   Each reviewer independently performs its reviewerWrite by calling init_check_set; review_run_start begins only after the Story enters REVIEW, not during INIT.\n` +
        `${renderAgentLivenessGuidance({ label: 'INIT reviewers' })}\n` +
        `→ Fallback (only when subagents cannot be spawned, controlled and audited):\n` +
        `   proof-or-stop init_check_repair '{"storyId":"${storyId}","acknowledge":true,"fallbackReason":"<why the reviewer cannot run + what you manually verified, >=30 chars>"}'`;
    }
    const expected = recomputeInitCheckHash(storyId, store, projectRoot ?? process.cwd());
    if (initCheck._hash !== expected) {
      return `Cannot enter INIT_CHECK: init-check.json _hash mismatch (signed components: ${describeInitCheckSignatureDomain()}); please re-run the proof-or-stop-review-story-init agent. [init_check_tampered]`;
    }
    const missingAgents = missingRequiredInitCheckAgents(initCheck);
    if (missingAgents.length > 0) {
      return `Cannot enter INIT_CHECK: init-check.json is missing required reviewer records: ${missingAgents.join(', ')}. [missing_init_check_agent]\n` +
        `${initPreflightGuidance(storyId)}\n` +
        `${renderMissingInitReviewerDispatches(storyId, missingAgents)}\n` +
        `${renderAgentLivenessGuidance({ label: 'missing INIT reviewers' })}\n` +
        `→ Fallback (only when subagents cannot be spawned, controlled and audited):\n` +
        `   proof-or-stop init_check_repair '{"storyId":"${storyId}","acknowledge":true,"fallbackReason":"<why the reviewer cannot run + what you manually verified, >=30 chars>"}'`;
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
    const budgetBlocker = storyScopeBudgetBlocker(store, projectRoot ?? process.cwd(), storyId);
    if (budgetBlocker) return budgetBlocker;
    // First check whether taking the express channel from INIT_CHECK
    const story = store.readStory(storyId);
    // B-a7c5 CHK-001: dev-memory preflight ack, checked before any door-specific
    // branching below — applies uniformly to every DEV door (PLAN→DEV, the
    // express channel, and the REVIEW/TEST→DEV rollbacks alike), same slot as
    // the proofStoryDevGateFailure check further down.
    if (!evaluateDevMemoryPreflightGate(storyId, store)) {
      return `Cannot enter DEV: dev-memory preflight has not been acknowledged for this story. ` +
        `[missing_dev_memory_preflight_ack]\n` +
        `→ Run \`proof-or-stop dev_memory_preflight_ack --storyId=${storyId}\` first (or, if the ` +
        `preflight pack build itself is failing, --reason="<why>" to record a reasoned downgrade).`;
    }
    // F-003: when the story takes the express (INIT_CHECK→DEV quickPath) channel, the
    // story-review record gate does NOT apply (express skips review), so the review-reason block
    // below must be skipped — otherwise an eligible express story shows a spurious "no review
    // record" message instead of the real (parallel-decomposition) reason it was blocked on.
    // F-006: the same holds for the REVIEW→DEV and TEST→DEV ROLLBACK doors — a rollback does not
    // re-demand a clean review (canReenterDevGuard applies ONLY the parallel check), so the review
    // block must be skipped for those phases too, leaving the parallel reason to render below.
    const isRollbackDoor = story.phase === 'REVIEW' || story.phase === 'TEST';
    if (story.phase === 'REVIEW') {
      try {
        const inventory = reviewInventoryRemediationGate(store, storyId, story.currentReviewRound);
        if (!inventory.ok) {
          return `Cannot enter remediation DEV: ${inventory.reason}. ` +
            `Next: ${inventory.nextCommand ?? `proof-or-stop review_inventory_status --storyId=${storyId}`}`;
        }
      } catch (error) {
        return `Cannot enter remediation DEV: inventory evidence is unreadable or invalid (${error instanceof Error ? error.message : String(error)}). ` +
          `Next: proof-or-stop review_inventory_status --storyId=${storyId}`;
      }
    }
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
          } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
            reasons.push('No checklist; must run story_advance PLAN first');
          }
        }
      } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
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
            const REVIEW_SALT = 'proof-or-stop-review-integrity-v1';
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
    const amendment = acceptanceCompletionBlocker(store, storyId, gitCwd ?? projectRoot ?? process.cwd());
    if (amendment) return amendment;
    if (!projectRoot) {
      return 'Cannot enter REVIEW: verification_receipt_invalid: project root is required to validate executable evidence';
    }
    const cl = store.readChecklist(storyId);
    // B-1909 CHK-002: withdrawn items are terminal, not outstanding.
    const pending = cl.items.filter(i => !isTerminalChecklistStatus(i.status));
    if (pending.length > 0) {
      return `Cannot enter REVIEW: ${pending.length} checklist item(s) not done: ${pending.map(i => i.id).join(', ')}`;
    }
    const reviewStory = store.readStory(storyId);
    const reviewPolicy = resolveWorkflowPolicy(loadConfig(projectRoot), reviewStory);
    const missingEvidence = getBlockingVerificationEvidenceIssues(
      cl,
      undefined,
      reviewPolicy.profile,
      createVerificationEvidenceGateEvaluator(projectRoot, storyId),
    );
    if (missingEvidence.length > 0) {
      return `Cannot enter REVIEW: ${missingEvidence.length} required verification intent(s) lack passing evidence or waiver:\n${missingEvidence.map(i => `  - ${i}`).join('\n')}\n→ Run verification_evidence_add to record logic/integration/browser/manual evidence, or use waiver to explicitly exempt`;
    }
    // B-7813 CHK-001: convergence-stall adjudication at the mint site. Ordered
    // AFTER the checklist/evidence checks to mirror canMintReviewRoundGuard, so
    // pending items surface first and the stall reason renders only once the
    // checklist gate is otherwise clear.
    const stall = (() => {
      try {
        return evaluateReviewMintStallAdjudication(store, storyId);
      } catch (error) {
        return convergenceProgressUnavailable(error);
      }
    })();
    if (stall.blocked && stall.prompt) {
      return `Cannot enter REVIEW: ${stall.prompt}`;
    }
  }

  if (targetPhase === 'TEST') {
    const verdict = evaluateReviewVerdict({ storyId, store, projectRoot: projectRoot ?? process.cwd(), ...(gitCwd ? { gitCwd } : {}) });
    if (!verdict.ok) return `Cannot enter TEST: ${verdict.message} [${verdict.code}]`;
  }

if (targetPhase === 'DONE') {
    return firstDonePredicateFailure({ storyId, store, projectRoot: projectRoot ?? process.cwd(), ...(gitCwd ? { gitCwd } : {}) })?.failureReason ?? null;
  }

  return null;
}
