/**
 * story_dispatch — B-45ed CHK-005
 *
 * Generate the standard proof-or-stop-implementer prompt string (the main agent copy-pastes it into Agent({subagent_type, prompt})).
 *
 * Core goals:
 *   - Unify the prompt structure the main agent uses to dispatch implementers, avoiding paraphrased pastes of plan.md by the main agent
 *   - The prompt forces references to background.md + plan.md#CHK-xxx paths, making the implementer read them directly
 *   - Does not spawn the subagent; only outputs the string, preserving the main agent's dispatch decision authority
 *
 * agent-type tiered injection (full matrix see CLAUDE.md "background.md tiered injection"):
 *   - required: proof-or-stop-implementer / proof-or-stop-review-scope-plan / proof-or-stop-review-behavior / proof-or-stop-review-concept
 *     → first line of prompt labeled "must read", forcing the subagent to read background to understand intent
 *   - advisory: proof-or-stop-review-quality / proof-or-stop-review-docs
 *     → prompt labeled "optional reference", does not disrupt mechanical check logic
 *   - none: proof-or-stop-review-channel
 *     → not injected at all, to avoid mechanical commit author checks being polluted by background noise
 *   - unknown agentType → downgraded to required (safest; better to over-read than miss reading)
 *   - agentType not passed → defaults to proof-or-stop-implementer semantics (required)
 */

import { isStoryMetadataFinding } from '../core/metadata-finding-class.js';
import { isMetadataTargetFinding } from '../core/metadata-correction.js';
import { renderPinOracleAudit, storyPinOracle, type PinOracleContext } from '../core/pin-oracle.js';
import { renderExactTextRelaunch, renderRequestExactLiterals } from '../core/exact-text-assertions.js';
import { renderRemovedGuardAdvisory, renderRemovedGuardRelaunch, storyRemovedGuards } from '../core/removed-guard-scan.js';
import { boundMatrixFor, branchTestProblem, recordBoundMatrix, renderBoundMatrix } from '../core/bound-matrix.js';
import { managedRunFinalMessage } from '../core/managed-run-final-message.js';
import { appendExactRequiredOutput, itemsForFinding } from '../core/exact-required-output.js';
import { omittedPromptNote } from './review-run.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { createClusterHandlers } from './cluster.js';
import type { StoryStore } from '../core/store.js';
import { createDeliveryContextPackHandlers, renderDeliveryCheckSkeleton } from './delivery-context-pack.js';
import { readStoryRequest, renderUnmappedLiteralsLine, unmappedStoryRequestLiterals } from '../core/story-request.js';
import { renderPinAudit } from '../core/intent-derivation.js';
import { renderCoverageMatrixRule } from '../core/plan-coverage-matrix.js';
import { renderScopePlanRerunContext } from '../core/scope-plan-rerun-context.js';
import { renderScopePlanPreload } from '../core/scope-plan-preload.js';
import { mergedPlanReviewLines, planReviewMergeActive } from '../core/plan-review-merge.js';
import { IMPLEMENTER_PROBE_LINE, IMPLEMENTER_PROBE_MATRIX, INTENT_CONFLICT_RETURN_CONTRACT, PRODUCT_CODE_NO_POS_METADATA_RULE, REPAIR_INPUT_VARIANT_RULE, renderProbeTestGapLine, renderReviewRequestAuthority } from '../core/request-authority.js';
import { renderAllowedFilesSection } from '../core/managed-writer-scope.js';
import { earlierFindingRepairReports, earlierImplementerProbeGap, implementerRunReports } from '../core/finding-repair-attempts.js';
import { probeExtractionEnabled, renderAnchoredProbeTable, renderFrameworkProbeContract, renderProbeEvidence, renderProbeFlagRelaunch, renderRequestAnchoredPinAudit, reportProbeDecision, requestAnchoredKeys, storyProbeRunner } from '../core/request-probes.js';
import { scopeBoundaryHashIsFresh } from '../core/scope-anti-expansion.js';
import { reportHealthIssue } from '../core/health.js';
import { findSealedManagedImplementerCompletion, managedImplementerAlreadyDoneAction } from '../core/managed-host-run.js';
import { loadConfig } from '../core/config.js';
import { probeMatrixOn } from '../core/ab-variants.js';
import { counterpartImplementerLines, planCounterpartCoverage } from '../core/counterpart-coverage.js';
import { renderSiblingParity } from '../core/sibling-parity.js';
import { regressionFamilyBrief } from '../core/regression-family-brief.js';
import { baseDisagreementActive, SCOPE_PLAN_BASE_DISAGREEMENT_CHECK } from '../core/base-disagreement.js';
import { rejectedRepairCommits, renderRepairResolvedContext, renderResolvedReprobe } from '../core/resolved-finding-guard.js';
import { exclusionRationaleCheckActive, SCOPE_PLAN_EXCLUSION_CHECK } from '../core/scope-exclusion-rationale.js';
import { resolveWorkflowPolicy } from '../core/workflow-policy.js';
import { scopeVerdictHeldItems } from '../core/scope-plan-deferral.js';
import { currentPlanOwnerBinding } from '../core/plan-touchpoint-coverage.js';
import {
  resolveAgentDispatchType,
  resolveAgentDispatchPromptBuilder,
  validateAgentDispatchRequest,
  type ResolvedAgentDispatchType,
} from '../core/agent-dispatch-registry.js';
import {
  reviewerDispatchBindingDigest,
  type ReviewerDispatchResponsibility,
  reviewerDispatchPromptDigest,
} from '../core/prompt-contracts.js';
import {
  reviewerHostRenderIdentity,
  resolvePromptEnvelopeRolloutMode,
  promptRoleContract,
  type PromptRoleResponsibility,
  resolvePromptRoleBody,
} from '../core/prompt-role-contract-registry.js';
import {
  assembleFullPromptEnvelope,
  buildFullTaskContext,
  verifyPromptEnvelopeIntegrity,
} from '../core/prompt-envelope.js';
import { BASELINE_RUNTIME_CONTRACT } from '../core/prompt-measurement.js';
import { captureReviewRunSnapshot } from '../core/review-run.js';
import { isBudgetedComplexRole, observeComplexRolePromptBudget, type PromptBudgetObservation } from '../core/prompt-budget.js';
import { withReviewMetadataTicketLock } from '../core/mkdir-lock.js';
import { getSessionIdentity } from '../core/owner-session.js';
import type { OwnerSessionHostProvider } from '../core/owner-session-adapters.js';
import type { PromptHost } from '../core/prompt-registry.js';
import {
  currentImplementationBusinessCommit,
  IMPLEMENTATION_PROVENANCE_BASE_UNAVAILABLE,
  topologyDispatchBusinessAuthor,
} from '../core/topology-critic-receipt.js';
import { resolveFullStoryBaseHead } from '../core/review-incremental-context.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { renderAgentLivenessGuidance } from '../core/agent-liveness-policy.js';
import {
  REVIEWER_NO_DELEGATION_BOUNDARY,
} from '../core/reviewer-launch-guidance.js';
import type { ReviewInventoryPurposeBinding } from '../core/types.js';
import { withReviewInventoryMutationLock } from '../core/review-inventory-epoch.js';
import { requireInventoryCriticSubjectLocked } from './review-inventory.js';
import {
  DELIVERY_REVIEW_LANE,
  deliveryReviewDispatchBindingDigest,
} from '../core/delivery-review-authority.js';

// B-45ed CHK-008: agent-type → background injection strategy mapping table
// Source: CLAUDE.md "background.md tiered injection (subagent)" subsection
type BackgroundPolicy = 'required' | 'advisory' | 'none';
type NativeLaunchContract = {
  dispatchState: 'prompt-prepared';
  hostTaskRequired: true;
  waitTarget: 'nonempty-task-identity';
  missingWorkerDisposition: 'keep-finding-open';
};
type DispatchResult = { prompt: string; nativeLaunchContract?: NativeLaunchContract };
const REPAIR_NATIVE_LAUNCH_CONTRACT: NativeLaunchContract = Object.freeze({
  dispatchState: 'prompt-prepared',
  hostTaskRequired: true,
  waitTarget: 'nonempty-task-identity',
  missingWorkerDisposition: 'keep-finding-open',
});
const AGENT_BG_POLICY: Record<string, BackgroundPolicy> = {
  'proof-or-stop-implementer': 'required',
  'proof-or-stop-review-scope-plan': 'required',
  'proof-or-stop-review-topology-critic': 'required',
  'proof-or-stop-review-behavior': 'required',
  'proof-or-stop-review-concept': 'required',
  'proof-or-stop-review-quality': 'advisory',
  'proof-or-stop-review-docs': 'advisory',
  'proof-or-stop-review-channel': 'none',
};

// Identity-pinned literal (runtime-environment-checks occurrence count); equals
// IMPLEMENTER_COMMIT_AUTHOR of core/item-done-commit.ts, which commits with it.
const IMPLEMENTER_COMMIT_AUTHOR = 'proof-or-stop-implementer <proof-or-stop-implementer@noreply.local>';

/** Characters of each inlined Story document in the implementer prompt (old-PoS run 34; the rest stays in the file). */
const INLINED_STORY_DOC_MAX_CHARS = 12_000;

/**
 * Old-PoS run 34 (§4 sink 2): background.md, the item's plan.md section and
 * request.md inlined in the implementer prompt (static in DEV), each capped at
 * INLINED_STORY_DOC_MAX_CHARS with its path for the rest.
 */
function renderInlinedStoryDocuments(docs: { background: string | null; bgPath: string; planSection: string | null; planRef: string; request: string | null; requestPath: string }): string[] {
  const block = (title: string, path: string, text: string | null): string[] => {
    if (!text || !text.trim()) return [];
    const body = text.trim();
    const shown = body.length > INLINED_STORY_DOC_MAX_CHARS ? `${body.slice(0, INLINED_STORY_DOC_MAX_CHARS)}\n… (truncated; the rest is in ${path})` : body;
    return [`----- ${title} (${path}) -----`, shown];
  };
  const parts = [
    ...block('background.md: the intent', docs.bgPath, docs.background),
    ...block('plan.md section of this item', docs.planRef, docs.planSection),
    ...block('request.md: the user\'s verbatim request; it outranks the checklist intents', docs.requestPath, docs.request),
  ];
  return parts.length ? ['Story documents (inlined; static during DEV, so do not reread these files):', ...parts, '----- end of Story documents -----'] : [];
}

// A nested dispatch can be triggered synchronously by an instrumented event
// sink. Ticket locks are process-safe but intentionally non-reentrant, so keep
// same-stack re-entry inside the already-held transaction instead of waiting
// on our own ticket. Independent processes still serialize on the filesystem.
const activeStoryDispatchEnvelopeTransactions = new Set<string>();

function withStoryDispatchEnvelopeTransaction<T>(lockDir: string, operation: string, fn: () => T): T {
  if (activeStoryDispatchEnvelopeTransactions.has(lockDir)) return fn();
  return withReviewMetadataTicketLock(lockDir, operation, () => {
    activeStoryDispatchEnvelopeTransactions.add(lockDir);
    try {
      return fn();
    } finally {
      activeStoryDispatchEnvelopeTransactions.delete(lockDir);
    }
  });
}

type ReviewerPromptProvider = OwnerSessionHostProvider | 'claude-cli' | 'codex-cli';

export function reviewerPromptHostForProvider(
  provider: ReviewerPromptProvider | undefined,
): PromptHost {
  switch (provider) {
    case 'claude-code':
    case 'claude-cli':
      return 'claude';
    case 'codex':
    case 'codex-cli':
      return 'codex';
    default:
      throw new Error(
        `full-envelope reviewer dispatch: unsupported session host provider "${provider ?? 'absent'}"; `
        + 'supported providers: claude-code | claude-cli | codex | codex-cli',
      );
  }
}

function currentReviewerPromptHost(): PromptHost {
  return reviewerPromptHostForProvider(getSessionIdentity().hostProvider);
}

/** Resolve agentType → injection strategy; unknown agentType downgrades to required (safest). */
function resolveBackgroundPolicy(agentType: string | undefined): BackgroundPolicy {
  const canonical = resolveAgentDispatchType(agentType).canonicalType;
  return AGENT_BG_POLICY[canonical] ?? 'required';
}

/**
 * The item's PLAN verification intents, with their pins. Pins are immutable in
 * DEV and gates replay the exact command, so the worker must create tests with
 * exactly these names instead of choosing its own.
 */
function appendPinnedVerification(lines: string[], intent: Partial<Record<string, Array<{ id?: string; desc?: string; verification?: { command?: string; selector?: string } }>>> | undefined): void {
  const rows: string[] = [];
  for (const lane of ['happy', 'edge', 'adversarial']) {
    for (const entry of intent?.[lane] ?? []) {
      const pin = entry.verification?.command
        ? ` — pinned: \`${entry.verification.command}\`${entry.verification.selector ? ` (test name: ${entry.verification.selector})` : ''}`
        : '';
      rows.push(`- ${entry.id ?? lane} [${lane}] ${entry.desc ?? ''}${pin}`);
    }
  }
  if (rows.length === 0) return;
  lines.push('');
  lines.push('Planned verification intents (pins are immutable in DEV; gates replay each pinned command exactly):');
  lines.push(...rows);
  lines.push('- Name your tests with exactly these test names and make each pinned command pass as written; a renamed test leaves the pin selecting nothing and forces a re-dispatch.');
}

function appendImplementerCommitSteps(lines: string[], message: string): void {
  lines.push(`- git commit --author="${IMPLEMENTER_COMMIT_AUTHOR}" -m "${message.replace(/"/g, "'")}"`);
  lines.push('- Keep the canonical implementer author for audit attribution. Author text never replaces the required dispatch/subagent_result process evidence.');
}

/**
 * B-9d95 CHK-004: Unified dispatch entry.
 *
 * story_dispatch / finding_dispatch / dispatch — these three entries share the same prompt assembly logic, avoiding
 * duplicate implementation. `dispatch` dispatches by itemId / findingId / clusterId; the old entries are kept as aliases,
 * with the first line of stdout printing a deprecation warning while return values remain byte-identical.
 */
/**
 * Verbatim request traceability (benchmark run 13). The scope-plan reviewer gets
 * request.md inline plus the mechanical literal pre-check, the pin audit of
 * every intent value the request does not quote (with its derivation) and the
 * same-semantics rule (old-PoS run 23, core/intent-derivation.ts); the verification-intent
 * author, the INIT product reviewer, the implementer and the finding-repair
 * worker get its path; every REVIEW lane and the inventory critic get it inline
 * with the request-outranks-intent rubric (old-PoS run 23, which reversed the
 * earlier "REVIEW lanes get nothing": the lanes deferred to a wrong owner intent
 * because they saw only the owner paraphrase; core/request-authority.ts).
 * A Story without request.md adds no prompt bytes.
 */
function appendScopePlanRequestTraceability(lines: string[], store: StoryStore, storyId: string, oracle: PinOracleContext | null = null): void {
  const request = readStoryRequest(store, storyId);
  if (request.status === 'absent') return;
  const rel = `${store.storyDirRel()}/${storyId}/request.md`;
  lines.push('');
  if (request.status === 'tampered') {
    lines.push(`Verbatim request: ${rel} — ${request.reason}. Do not treat it as authoritative; record an openQuestion asking the Story owner to restore it with story_request_set and an amendmentReason.`);
    return;
  }
  lines.push(`Verbatim user request (${rel}, sha256=${request.meta.sha256.slice(0, 12)}${request.meta.truncated ? ', truncated at 16 KB' : ''}); it is authoritative over the owner paraphrase in the description/background:`);
  lines.push('<<<REQUEST');
  lines.push(request.text.replace(/\n$/, ''));
  lines.push('REQUEST>>>');
  lines.push('Request traceability (required): every normative sentence, every "for example" and every enumerated variant in the request is its own feature row with source "request.md". Each listed variant and each example input/output pair is a separate row, covered only when a checklist userSees or verificationIntent states that exact variant or exact output (whitespace aside); a related or analogous case is not coverage. Unmapped = gap. For these rows read userSees and verificationIntent, not only title/excludes.');
  const items = (() => { try { return store.readChecklist(storyId).items; } catch { return []; } })();
  const unmapped = unmappedStoryRequestLiterals(request.text, items);
  lines.push(unmapped.length > 0
    ? `Mechanical pre-check. ${renderUnmappedLiteralsLine(unmapped)}. Classify each one: gap, excluded (cite the excluding text), or covered (name the CHK and the field that states it).`
    : 'Mechanical pre-check: every backticked request literal appears in some checklist title/userSees/verificationIntent; still trace every normative sentence.');
  // D4 pin audit + D5 same-semantics rule (old-PoS run 23, core/intent-derivation.ts).
  lines.push(...renderPinAudit(items, request.text));
  // Old-PoS run 31 (core/pin-oracle.ts): the project-declared oracle for the examples the framework could not evaluate.
  lines.push(...renderPinOracleAudit(oracle));
  // Old-PoS run 31 (core/request-probes.ts): request-defined rows paired with the sentence that defines them.
  // Old-PoS runs 35-39: prose example rows count only with probe extraction on (probeRunner / probe matrix); A0 keeps arrow rows.
  const proseRows = (() => { try { return probeExtractionEnabled(store, storyId, resolveGitCwd({ store, storyId, metadataRoot: store.projectRoot, projectRoot: store.projectRoot }), loadConfig(store.projectRoot)); } catch { return false; } })();
  lines.push(...renderRequestAnchoredPinAudit(items, request.text, { prose: proseRows }));
  // Coverage matrix (old-PoS runs 24-29, core/plan-coverage-matrix.ts): the judgment form of the PLAN coverage checks.
  // Old-PoS run 33: plan.coverageMatrix (default off) keeps only the exact-text rule.
  lines.push(...renderCoverageMatrixRule(items, request.text, (() => { try { return loadConfig(store.projectRoot); } catch { return {}; } })()));
}

/**
 * Run 17 (Q4): obligations the scope-plan reviewer must not raise as gaps. The
 * reviewer flagged benchmark workflow sentences ("work in a new branch from
 * main", "commit everything when done") that the Proof-or-Stop workflow itself
 * satisfies, and a "do not ..." constraint already in the INIT scope ("The INIT
 * scope boundary is not an input of this verdict"), which forced a second
 * reviewer run with no checklist change. Product requirements stay strict: only
 * delivery-workflow sentences and restriction-only constraints are listed.
 */
export const POS_WORKFLOW_OBLIGATIONS = [
  'working in a new or separate branch from main (every Story runs on its own story/<id> branch and worktree created from main)',
  'committing the changes, "commit everything when done" (workers commit their work, Story metadata is auto-committed, DONE refuses an uncommitted tree)',
  'merging the work back into main (DONE merges the Story branch)',
] as const;

const RESTRICTION_ONLY = /^(?:do not|don't|never|must not|should not|no\s|avoid|without)\b/i;

function appendScopePlanCoveredObligations(lines: string[], store: StoryStore, storyId: string): void {
  const clip = (text: string) => JSON.stringify(text.length > 200 ? `${text.slice(0, 197)}...` : text);
  const boundary = (() => { try { return store.readScopeBoundary(storyId); } catch { return null; } })();
  const understanding = (() => { try { return store.readUnderstanding(storyId); } catch { return null; } })();
  const constraints = [...new Set([
    ...(scopeBoundaryHashIsFresh(boundary) ? boundary!.excluded : []),
    // Only restriction-only constraints; a "keep X" / "must return Y" constraint is a product requirement and stays strict.
    ...(understanding?.constraints ?? []).filter(entry => RESTRICTION_ONLY.test(String(entry).trim())),
  ].map(entry => String(entry).trim()).filter(Boolean))].slice(0, 12);
  lines.push('');
  lines.push('Already covered (never a gap; record a matching row as status "covered"):');
  lines.push(`- Delivery-workflow sentences the Proof-or-Stop workflow guarantees (covered_by "proof-or-stop-workflow"): ${POS_WORKFLOW_OBLIGATIONS.join('; ')}.`);
  if (constraints.length > 0) {
    lines.push(`- Restriction-only constraints the Story already acknowledges in its INIT scope boundary / understanding (covered_by "init-scope"): ${constraints.map(clip).join('; ')}. A "do not ..." sentence that restates one is covered.`);
  }
  lines.push('Everything else stays strict: a required behavior, output, error, example or compatibility promise is covered only by a checklist userSees/verificationIntent that states it, even when it resembles a listed entry.');
}

export function createStoryDispatchHandlers(ctx: HandlerContext) {
  const { store, root } = ctx;
  const candidateRoutingMode = (): 'shadow' | 'warn' | 'enforce' => loadConfig(root).candidateSpecRouting?.mode ?? 'shadow';

  function appendCandidateEscalationGuidance(lines: string[], storyId: string, routed: NonNullable<ReturnType<StoryStore['readCandidateSpecSet']>>, scopePlan: boolean): void {
    const mode = candidateRoutingMode();
    if (routed.mode !== mode) {
      if (mode === 'shadow') {
        lines.push(`- SHADOW MODE_MISMATCH — signed candidate artifact mode=${routed.mode}, configured mode=${mode}; diagnostic recorded without blocking review.`);
      } else if (mode === 'warn') {
        lines.push(`- WARNING MODE_MISMATCH — signed candidate artifact mode=${routed.mode}, configured mode=${mode}; continue review and ask the Story owner to rerun candidate_spec_route.`);
      } else {
        lines.push(`- STOP — MODE_MISMATCH: signed candidate artifact mode=${routed.mode}, configured mode=${mode}. Do not submit scope/review evidence until the Story owner reruns candidate_spec_route.`);
        lines.push(`- Exact owner resolution action: proof-or-stop candidate_spec_route '{"storyId":"${storyId}"}'`);
        return;
      }
    }
    if (!routed.requiresEscalation || routed.fullScan) return;
    const reasons = routed.escalationReasons.join(', ') || 'unspecified';
    if (mode === 'shadow') {
      lines.push(`- SHADOW — candidate routing escalation recorded (${reasons}); continue review and do not treat it as gate evidence.`);
      return;
    }
    if (mode === 'warn') {
      lines.push(`- WARNING — candidate routing escalation is unresolved (${reasons}); continue review, record the advisory, and do not hard-block evidence.`);
      lines.push(`- Advisory owner action: proof-or-stop candidate_spec_route '{"storyId":"${storyId}","fullScanReason":"<specific justified tool-driven broad-scan reason>"}'`);
      return;
    }
    lines.push(scopePlan
      ? '- STOP — candidate routing escalation is unresolved. Do not call scope_check_save with this artifact.'
      : `STOP — candidate routing escalation is unresolved (${reasons}). Do not submit review_pass_set or finding evidence using this artifact.`);
    lines.push(`- Exact owner resolution action: proof-or-stop candidate_spec_route '{"storyId":"${storyId}","fullScanReason":"<specific justified tool-driven broad-scan reason>"}'`);
    if (scopePlan) lines.push('- Resume only after the newly signed candidate artifact reports fullScan=true and a nonblank scanEscalationReason.');
  }

  function appendReviewerExecutionModes(lines: string[], storyId: string, lane: string): void {
    lines.push('Execution boundary (choose exactly one):');
    lines.push('- Native host subagent with a registered host-adapter broker: the reviewer itself starts review_run_start and writes finding_add/review_pass_set as described below; the broker must descriptor-inject the exact signed invocation attestation. Native lifecycle remains owned by the host.');
    lines.push('- Native host without that broker integration is advisory-only and cannot write formal finding/pass evidence; use the managed reviewer path below instead.');
    lines.push('- Cross-provider CLI reviewer: do not launch raw `bash + codex/claude/agy`. The controller first starts review_run_start, then submits the exact run through ManagedHostRun:');
    lines.push(`  proof-or-stop host_run '{"host":"codex","storyId":"${storyId}","agentType":"${lane}","reviewRunId":"<reviewRunId>","lane":"${lane}","managedReview":true,"detach":true,"json":true}'`);
    lines.push('  Wait for the returned runId with one blocking call, `proof-or-stop host_run_status --runId=<runId> --untilTerminal=true` (returns at terminal, blocking up to 285 s per call; run it with a tool yield/shell timeout of 300000 ms, e.g. Codex write_stdin yield_time_ms=300000, and re-run it if it returns non-terminal instead of polling more often). A wait that expires or provider silence is not failure and never authorizes a replacement.');
    lines.push('  The provider final assistant result must be exactly one bounded `lattice.managed_review_final_proposal.v1` JSON envelope. The managed adapter seals the strictly validated verdict; the controller cannot supply or override it.');
    lines.push('  Only after state=completed and an exact receiptId exists, call `proof-or-stop managed_review_evidence_import \'{"runId":"<runId>","receiptId":"<receiptId>"}\'`.');
    lines.push('- A raw provider CLI result is manual/advisory output only; it cannot satisfy the managed reviewer evidence path.');
    lines.push('');
  }

  function appendDispatchEvent(args: {
    storyId: string;
    agentType?: string;
    targetKind: 'init-review' | 'scope-plan-review' | 'topology-critic-review' | 'inventory-critic-review' | 'story-review' | 'delivery-review' | 'rollout-verify' | 'checklist' | 'finding' | 'cluster';
    reviewPurpose?: 'inventory-completeness';
    inventoryBinding?: ReviewInventoryPurposeBinding;
    itemId?: string;
    findingId?: string;
    clusterId?: string;
    dispatchPrompt?: string;
    dispatchPromptDigest?: string;
    hostRenderHost?: PromptHost;
    hostRenderIdentityDigest?: string;
    dispatchBindingDigest?: string;
    reviewerResponsibility?: ReviewerDispatchResponsibility;
    reviewRound?: string;
    promptEnvelopeId?: string;
    promptEnvelopeDigest?: string;
    assembledPromptDigest?: string;
    promptEnvelope?: ReturnType<typeof assembleFullPromptEnvelope>['envelope'];
    headHash?: string;
    materialHash?: string;
    storyFilesHash?: string;
    businessCommit?: string;
    businessCommitAuthor?: string;
    businessCommitAuthorSource?: 'git-var:GIT_AUTHOR_IDENT';
    topologyProvenanceDiagnostic?: { status: 'unavailable'; required: boolean; code: string; message: string };
    budgetViolation?: 'incremental' | 'full';
    promptBudget?: PromptBudgetObservation;
  }): void {
    const persistEvent = (): void => {
      const story = store.readStory(args.storyId);
      const agentType = args.agentType || 'proof-or-stop-implementer';
      const budgetViolation = args.budgetViolation
        ?? (args.promptBudget && !args.promptBudget.withinBudget ? args.promptBudget.contextMode : undefined);
      store.appendProcessEvent(args.storyId, {
        type: 'dispatch',
        storyId: args.storyId,
        phase: story.phase,
        source: 'proof-or-stop dispatch',
        targetKind: args.targetKind,
        agentType,
        sessionId: getSessionIdentity().sessionId,
        ...(args.reviewPurpose ? { reviewPurpose: args.reviewPurpose, inventoryBinding: args.inventoryBinding } : {}),
        ...(args.headHash ? { headHash: args.headHash } : {}),
        ...(args.materialHash ? { materialHash: args.materialHash } : {}),
        ...(args.storyFilesHash ? { storyFilesHash: args.storyFilesHash } : {}),
        ...(args.businessCommit ? { businessCommit: args.businessCommit } : {}),
        ...(args.businessCommitAuthor ? { businessCommitAuthor: args.businessCommitAuthor } : {}),
        ...(args.businessCommitAuthorSource ? { businessCommitAuthorSource: args.businessCommitAuthorSource } : {}),
        ...(args.topologyProvenanceDiagnostic ? { topologyProvenanceDiagnostic: args.topologyProvenanceDiagnostic } : {}),
        ...(args.itemId ? { itemId: args.itemId, checklistId: args.itemId } : {}),
        ...(args.findingId ? { findingId: args.findingId } : {}),
        ...(args.clusterId ? { clusterId: args.clusterId } : {}),
        ...(args.dispatchPrompt !== undefined ? { dispatchPrompt: args.dispatchPrompt } : {}),
        ...(args.dispatchPromptDigest ? { dispatchPromptDigest: args.dispatchPromptDigest } : {}),
        ...(args.hostRenderHost ? { hostRenderHost: args.hostRenderHost } : {}),
        ...(args.hostRenderIdentityDigest ? { hostRenderIdentityDigest: args.hostRenderIdentityDigest } : {}),
        ...(args.dispatchBindingDigest ? { dispatchBindingDigest: args.dispatchBindingDigest } : {}),
        ...(args.reviewerResponsibility ? { reviewerResponsibility: args.reviewerResponsibility } : {}),
        ...(args.reviewRound ? { reviewRound: args.reviewRound } : {}),
        ...(args.promptEnvelopeId ? { promptEnvelopeId: args.promptEnvelopeId } : {}),
        ...(args.promptEnvelopeDigest ? { promptEnvelopeDigest: args.promptEnvelopeDigest } : {}),
        ...(args.assembledPromptDigest ? { assembledPromptDigest: args.assembledPromptDigest } : {}),
        ...(budgetViolation ? { budgetViolation } : {}),
        ...(args.promptBudget ? { promptBudget: args.promptBudget } : {}),
      });
    };
    if (args.promptEnvelope) {
      const envelope = args.promptEnvelope;
      const lockDir = store.runtimeLockDirPath(args.storyId, 'review-run', 'review-runs');
      withStoryDispatchEnvelopeTransaction(lockDir, `story_dispatch envelope+event for ${args.storyId}/${args.agentType ?? 'unknown'}`, () => {
        const data = store.readPromptEnvelopes(args.storyId);
        const existing = data.envelopes.find(candidate => candidate.envelopeId === envelope.envelopeId);
        if (existing && !verifyPromptEnvelopeIntegrity(existing)) {
          throw new Error(`story_dispatch: persisted envelope ${existing.envelopeId} failed integrity verification`);
        }
        const created = !existing;
        if (created) {
          data.envelopes.push(envelope);
          store.writePromptEnvelopes(args.storyId, data);
        }
        try {
          const persisted = store.readPromptEnvelopes(args.storyId).envelopes.find(candidate => candidate.envelopeId === envelope.envelopeId);
          if (!persisted || !verifyPromptEnvelopeIntegrity(persisted)) {
            throw new Error(`story_dispatch: envelope ${envelope.envelopeId} was not durably persisted`);
          }
          persistEvent();
        } catch (e: any) {
          let hasValidEventBinding = false;
          try {
            hasValidEventBinding = store.readProcessEvents(args.storyId).some(event =>
              event.type === 'dispatch'
              && event.storyId === args.storyId
              && event.promptEnvelopeId === envelope.envelopeId
              && event.promptEnvelopeDigest === envelope.contextDigest
              && event.assembledPromptDigest === envelope.assembledPromptDigest,
            );
          } catch {
            // If the event ledger itself is unreadable, it cannot prove a
            // successful binding and a newly-created envelope must roll back.
          }
          if (created && !hasValidEventBinding) {
            const rollback = store.readPromptEnvelopes(args.storyId);
            const remaining = rollback.envelopes.filter(candidate => candidate.envelopeId !== envelope.envelopeId);
            if (remaining.length !== rollback.envelopes.length) store.writePromptEnvelopes(args.storyId, { envelopes: remaining });
          }
          throw new Error(`story_dispatch: dispatch event persistence failed; prompt envelope was not accepted: ${e?.message || e}`);
        }
      });
      return;
    }
    try {
      persistEvent();
    } catch (e: any) {
      if (args.reviewPurpose === 'inventory-completeness') throw e;
      reportHealthIssue('persist:dispatchProcessEvent', e as Error, {
        storyId: args.storyId,
        agentType: args.agentType,
        targetKind: args.targetKind,
        itemId: args.itemId,
        findingId: args.findingId,
        clusterId: args.clusterId,
      });
      ctx.log?.(`[process-events] dispatch append failed for ${args.storyId}: ${e?.message || e}`);
    }
  }

  function topologyAuthorityDispatchBinding(story: ReturnType<StoryStore['readStory']>, required: boolean) {
    try {
      const snapshot = captureReviewRunSnapshot(root, { storyId: story.storyId, storyPhase: story.phase }, root);
      if (!snapshot.storyFilesHash) throw new Error('topology authority dispatch requires a current storyFilesHash');
      const gitCwd = resolveGitCwd({
        store,
        storyId: story.storyId,
        metadataRoot: root,
        projectRoot: root,
        cwd: process.cwd(),
      });
      const frozenStoryBase = story.integrationTarget !== undefined
        ? resolveFullStoryBaseHead(store, root, story.storyId)
        : undefined;
      if (story.integrationTarget !== undefined && !frozenStoryBase) {
        throw Object.assign(
          new Error(`${IMPLEMENTATION_PROVENANCE_BASE_UNAVAILABLE}: Story integration base is unavailable`),
          { code: IMPLEMENTATION_PROVENANCE_BASE_UNAVAILABLE },
        );
      }
      const implementation = currentImplementationBusinessCommit(gitCwd, frozenStoryBase);
      return {
        headHash: snapshot.headHash,
        storyFilesHash: snapshot.storyFilesHash,
        businessCommit: implementation.businessCommit,
        businessCommitAuthor: topologyDispatchBusinessAuthor(gitCwd),
        businessCommitAuthorSource: 'git-var:GIT_AUTHOR_IDENT' as const,
      };
    } catch (error) {
      if (required) throw error;
      const detail = error instanceof Error ? error : new Error(String(error));
      const code = typeof (detail as Error & { code?: unknown }).code === 'string'
        ? String((detail as Error & { code: string }).code)
        : 'IMPLEMENTATION_PROVENANCE_UNAVAILABLE';
      return {
        topologyProvenanceDiagnostic: {
          status: 'unavailable' as const,
          required,
          code,
          message: detail.message,
        },
      };
    }
  }

  /**
   * Story 6 trusted dispatch wrapper. The legacy dispatch text remains the
   * exact Task-specific input; the CLI adds the same canonical Runtime/Role /
   * Task Context envelope used by Story 2. Rollout is config-controlled and
   * defaults to the legacy path, so a disabled flag cannot silently change a
   * host's prompt bytes.
   */
  function assembleComplexStoryDispatch(
    story: ReturnType<StoryStore['readStory']>,
    agentType: string,
    dispatchPrompt: string,
    responsibility?: PromptRoleResponsibility,
  ): { prompt: string; envelope?: ReturnType<typeof assembleFullPromptEnvelope>['envelope']; promptBudget?: PromptBudgetObservation } {
    const mode = resolvePromptEnvelopeRolloutMode(agentType, loadConfig(root).promptEnvelope);
    if (mode !== 'full-envelope') return { prompt: dispatchPrompt };
    const snapshot = captureReviewRunSnapshot(root, { storyId: story.storyId, storyPhase: story.phase }, root);
    const taskContext = buildFullTaskContext({
      story,
      checklist: store.readChecklist(story.storyId),
      ...snapshot,
      scopeContract: store.readScopeContract(story.storyId),
    });
    const assembly = assembleFullPromptEnvelope({
      roleContract: promptRoleContract(agentType, responsibility),
      runtimeContract: BASELINE_RUNTIME_CONTRACT,
      rolePrompt: resolvePromptRoleBody(agentType, loadConfig(root).promptEnvelope).body,
      taskContext,
      dispatchKind: 'story-dispatch',
      dispatchPrompt,
      createdAt: new Date().toISOString(),
    });
    const promptBudget = isBudgetedComplexRole(agentType)
      ? observeComplexRolePromptBudget({
          roleId: agentType,
          contextMode: 'full',
          bytes: assembly.envelope.bytes,
          estimatedTokens: assembly.envelope.estimatedTokens,
        })
      : undefined;
    return {
      prompt: assembly.prompt,
      envelope: assembly.envelope,
      ...(promptBudget ? { promptBudget } : {}),
    };
  }

  function appendDispatchLivenessGuidance(lines: string[], label: string): void {
    lines.push(renderAgentLivenessGuidance({ label, startSignal: `DISPATCH_START:${label}` }));
    lines.push('');
  }

  function buildInitReviewPrompt(args: {
    storyId: string;
    agentType?: string;
  }): { prompt: string } {
    if (!args.storyId) throw new Error('storyId is required');
    try {
      store.readStory(args.storyId);
    } catch {
      throw new Error(`story ${args.storyId} not found`);
    }
    const bgPath = `${store.storyDirRel()}/${args.storyId}/background.md`;
    const checklistPath = `${store.storyDirRel()}/${args.storyId}/checklist.json`;
    return {
      prompt: [
        `Review the initial background + checklist for story ${args.storyId}.`,
        '',
        'You are the proof-or-stop-review-story-init reviewer; please review in a fresh context, do not carry over the main agent\'s conclusions.',
        REVIEWER_NO_DELEGATION_BOUNDARY,
        `Must read: ${bgPath}`,
        `Must read: ${checklistPath}`,
        '',
        'Review focus:',
        '- Only the five dimensions in the canonical role prompt: term definitions, standalone readability, metadata consistency, quick verification of existing-system claims, and mechanical checklist sanity',
        '- Do not judge product semantics, exact formats, internal lifecycle/state transitions, trace labels/order, test implementation, PLAN decisions, or REVIEW coverage during this INIT review',
        '- If an authoritative Story input marks a detail implementation-defined, asking the owner to freeze that detail is outside this reviewer authority',
        '',
        renderAgentLivenessGuidance({ label: 'proof-or-stop-review-story-init/story', startSignal: 'INIT_REVIEW_START' }),
        '- After starting, first output `INIT_REVIEW_START`; after finishing reading background/checklist, output `INIT_REVIEW_READ_DONE`.',
        '- Within 5 minutes at the latest, you must choose one of two: call init_check_set, or output an explicit blocker + current blocking point.',
        '',
        'Hard requirements:',
        `- Regardless of whether the conclusion is pass or fail, you must call init_check_set once to record the result; merely outputting a textual conclusion does not count as complete.`,
        '- Report the complete finite issue set in one call; do not turn a prior pass on unchanged facts into a new critical/high requirement.',
        '- Critical/high issues require one of: required_story_input_missing, undefined_term_or_reference, story_metadata_inconsistent, existing_system_claim_inaccurate, initial_checklist_invalid.',
        '- Every critical/high issue also requires an exact requirementRef such as story:priority, background:Trigger Event, checklist:CHK-001, or required-input:checklist. Out-of-authority or unbound critical/high reports are stored as advisory.',
        `- When issues are found, also call: proof-or-stop init_check_set '{"storyId":"${args.storyId}","issues":[{"kind":"initial_checklist_invalid","requirementRef":"checklist:CHK-001","severity":"high","desc":"..."}],"agentId":"proof-or-stop-review-story-init"}'`,
        `- If there are no issues, pass an empty array for issues: proof-or-stop init_check_set '{"storyId":"${args.storyId}","issues":[],"agentId":"proof-or-stop-review-story-init"}'`,
        '- The INIT_CHECK gate also requires proof-or-stop-product-reviewer to call init_check_set; you are only responsible for the proof-or-stop-review-story-init record.',
        '- Do not directly edit story files.',
      ].join('\n'),
    };
  }

  function buildProductInitReviewPrompt(args: {
    storyId: string;
    agentType?: string;
  }): { prompt: string } {
    if (!args.storyId) throw new Error('storyId is required');
    try {
      store.readStory(args.storyId);
    } catch {
      throw new Error(`story ${args.storyId} not found`);
    }
    const bgPath = `${store.storyDirRel()}/${args.storyId}/background.md`;
    const checklistPath = `${store.storyDirRel()}/${args.storyId}/checklist.json`;
    return {
      prompt: [
        `Review whether the INIT of story ${args.storyId} is ready to advance, from a user value perspective.`,
        '',
        'You are proof-or-stop-product-reviewer, not proof-or-stop-review-story-init. Please review in a fresh context, do not carry over the main agent\'s conclusions.',
        REVIEWER_NO_DELEGATION_BOUNDARY,
        `Must read: ${bgPath}`,
        `Required reading: ${checklistPath}`,
        ...(readStoryRequest(store, args.storyId).status === 'ok'
          ? [`Required reading: ${store.storyDirRel()}/${args.storyId}/request.md (the user's verbatim request; a requested behavior that no checklist item covers is user_outcome_unspecified)`]
          : []),
        '',
        'Review focus:',
        '- Whether the background clearly explains why the user needs this, not just the engineering mechanics',
        '- Whether each checklist item has a user-observable outcome',
        '- Whether userSees and verificationIntent make the planned result and its verification concrete enough to begin implementation',
        '- Whether requirements, verification commands, scope, compatibility, and safety boundaries are clear enough to proceed',
        '',
        'INIT phase boundary:',
        '- Implementation has not started. Planned userSees and verificationIntent are the available evidence at this phase.',
        '- You must not require implementation code, executed tests, actual CLI/UI output, or final delivery evidence before allowing implementation to start.',
        '- Missing evidence that can only exist after implementation is not an INIT failure. If recorded, use kind "post_implementation_evidence_missing"; the INIT gate defers it.',
        '- Actual behavior and delivery evidence remain subject to the later REVIEW, TEST, and DONE gates.',
        '- Do not require exhaustive internal lifecycle semantics, exact trace labels/order, serialization choices, or extra edge cases unless an authoritative INIT input explicitly fixes them.',
        '- A detail explicitly marked implementation-defined cannot become a critical/high INIT requirement.',
        '',
        renderAgentLivenessGuidance({ label: 'proof-or-stop-product-reviewer/story', startSignal: 'DISPATCH_START:proof-or-stop-product-reviewer/story' }),
        '',
        'Hard requirements:',
        '- Whether the conclusion is pass or fail, you must call init_check_set once to record the result; outputting only a text conclusion does not count as complete.',
        `- agentId must be passed exactly as "proof-or-stop-product-reviewer". Do not pass "proof-or-stop-review-story-init"; that is a different reviewer and will cause the INIT_CHECK gate to keep reporting a missing proof-or-stop-product-reviewer.`,
        '- INIT-blocking issue kinds are "requirements_ambiguous", "user_outcome_unspecified", "verification_plan_unexecutable", and "scope_or_safety_boundary_missing".',
        '- Report the complete finite issue set in one call; do not invent a new critical/high requirement from unchanged facts on a later fresh review.',
        '- Every critical/high issue requires an exact requirementRef such as story:description, background:Trigger Event, checklist:CHK-001, verification-intent:CHK-001:happy:0, scope-boundary, or execution-boundary. Unbound critical/high reports are stored as advisory.',
        `- When issues are found, also call: proof-or-stop init_check_set '{"storyId":"${args.storyId}","issues":[{"kind":"user_outcome_unspecified","requirementRef":"story:description","severity":"high","desc":"..."}],"agentId":"proof-or-stop-product-reviewer"}'`,
        `- If there are no issues, pass an empty array for issues: proof-or-stop init_check_set '{"storyId":"${args.storyId}","issues":[],"agentId":"proof-or-stop-product-reviewer"}'`,
        '- Critical/high INIT-applicable issues hard-block INIT_CHECK; medium/low and post-implementation-only issues are recorded as non-blocking or deferred.',
        '- Do not edit story files directly.',
      ].join('\n'),
    };
  }

  function buildScopePlanReviewPrompt(args: {
    storyId: string;
    agentType?: string;
  }): { prompt: string } {
    if (!args.storyId) throw new Error('storyId is required');
    const story = (() => {
      try {
        return store.readStory(args.storyId);
      } catch {
        throw new Error(`story ${args.storyId} not found`);
      }
    })();
    if (story.phase !== 'PLAN') {
      throw new Error(
        `scope_check_save is PLAN-only; current phase ${story.phase} is unsupported for ` +
        `story-level proof-or-stop-review-scope-plan dispatch on ${args.storyId}. ` +
        'Run this dispatch only while the story is in PLAN, or use proof-or-stop session_brief / proof-or-stop next for current-phase guidance.',
      );
    }

    const storyDir = `${store.storyDirRel()}/${args.storyId}`;
    const bgPath = `${storyDir}/background.md`;
    const understandingPath = `${storyDir}/understanding.json`;
    const checklistPath = `${storyDir}/checklist.json`;
    const planPath = `${storyDir}/plan.md`;
    const decisionPath = `${storyDir}/decision.json`;
    const routed = store.readCandidateSpecSet(args.storyId);
    const decisionsDir = join(root, loadConfig(root).requirementsDir ?? 'docs/requirements', 'decisions');
    const decisionsPresent = existsSync(decisionsDir);
    const ownerBinding = currentPlanOwnerBinding(store, root, args.storyId);

    const lines: string[] = [];
    lines.push(`Review PLAN scope coverage for story ${args.storyId}.`);
    lines.push('');
    lines.push('Reviewer execution contract:');
    lines.push('- You are the proof-or-stop-review-scope-plan reviewer. Review in a fresh context and do not carry over the main agent\'s or Story owner\'s conclusions. Finish by calling scope_check_save.');
    lines.push('- Call scope_check_save only with your complete final payload (never a placeholder or probe save); a later call of the same run replaces the earlier one. Run it from your normal shell environment; never unset or override LATTICE_MANAGED_INIT_INVOCATION or PROOF_OR_STOP_AGENT.');
    lines.push(`- ${REVIEWER_NO_DELEGATION_BOUNDARY}`);
    lines.push(`Working directory (subagent must cd here): ${root}`);
    lines.push('');
    appendDispatchLivenessGuidance(lines, 'proof-or-stop-review-scope-plan/story-scope');
    lines.push('Role boundary:');
    lines.push('- Review only; do not change code, tests, checklist items, plan text, or story metadata.');
    lines.push('- Dispatch output is not gate evidence; only scope_check_save writes the PLAN scope evidence consumed by story_review.');
    lines.push('');
    lines.push('Must read story artifacts:');
    lines.push(`1. ${bgPath}`);
    // The verdict is required without an understanding snapshot (run 16), so it is read only when present.
    lines.push(`2. ${understandingPath} (if present)`);
    lines.push(`3. ${checklistPath}`);
    lines.push(`4. ${planPath}`);
    lines.push(`5. ${decisionPath} (if present)`);
    lines.push('- Also read relatedDocs referenced by checklist items and any decisions/docs cited by the story artifacts.');
    // Lab initplan (A/B plan.reviewerPreload=on, core/scope-plan-preload.ts): the must-read files inline; off = nothing added.
    lines.push(...renderScopePlanPreload(store, root, args.storyId));
    if (!decisionsPresent) {
      lines.push('- Controller preflight: decisions directory is absent; review the Story description and named story artifacts for concrete promises. Do not search for a missing decisions corpus.');
    }
    if (routed) {
      lines.push(`- Current bounded candidate artifact: digest=${routed.artifactDigest} corpusDigest=${routed.corpusDigest}`);
      lines.push(`- Fully inspect routed candidates as relevant: ${routed.candidateSpecSet.join(', ') || '(none)'}`);
      lines.push(`- Ambiguity signals: ${routed.ambiguitySignals.join(', ') || 'none'}; scanEscalationReason=${routed.scanEscalationReason ?? 'null'}`);
      lines.push(`- Routing escalation: requiresEscalation=${routed.requiresEscalation}; reasons=${routed.escalationReasons.join(', ') || 'none'}`);
      appendCandidateEscalationGuidance(lines, args.storyId, routed, true);
    } else {
      lines.push('- candidate_spec_route is owner-only; do not call it from this reviewer. Ask the Story owner to route candidates when required.');
      lines.push(candidateRoutingMode() === 'enforce'
        ? '- No candidate-spec-set artifact is present. STOP in enforce mode and ask the Story owner to run candidate_spec_route; reviewer lanes must not seize owner authority.'
        : `- No candidate-spec-set artifact is present. ${candidateRoutingMode()} mode records this without hard-blocking review.`);
    }
    // Old-PoS run 27 (row 4b): a rerun starts from the previous verdict and the checklist diff since it.
    // Lab plan-light (A/B plan.reviewMerge=on): a rerun is a confirmation re-review of the changed rows.
    const merged = planReviewMergeActive(root);
    lines.push(...renderScopePlanRerunContext({ store, storyId: args.storyId, root,
      gitCwd: resolveGitCwd({ store, storyId: args.storyId, metadataRoot: root, projectRoot: root }), ...(merged ? { confirmation: true } : {}) }));
    appendScopePlanRequestTraceability(lines, store, args.storyId,
      storyPinOracle(store, root, args.storyId, resolveGitCwd({ store, storyId: args.storyId, metadataRoot: root, projectRoot: root })));
    appendScopePlanCoveredObligations(lines, store, args.storyId);
    lines.push('');
    lines.push('Review focus:');
    lines.push('- Identify every user-visible promise, scope constraint, exclusion, and acceptance expectation in the story artifacts.');
    lines.push('- Classify each feature as covered, excluded, gap, orphan-suspect, or drift using the scope_check_save schema.');
    // Old-PoS run 43 (core/scope-exclusion-rationale.ts, A/B plan.exclusionRationaleCheck, default on).
    if (exclusionRationaleCheckActive(root)) lines.push(SCOPE_PLAN_EXCLUSION_CHECK);
    // Old-PoS run 46 (core/base-disagreement.ts, A/B plan.baseDisagreement, default on).
    if (baseDisagreementActive(root)) lines.push(SCOPE_PLAN_BASE_DISAGREEMENT_CHECK);
    // Lab plan-light (A/B plan.reviewMerge=on): this ONE session also answers the INIT questions; only real gaps / unanswered questions block.
    if (merged) lines.push(...mergedPlanReviewLines(root));
    lines.push('- Record open questions when the artifacts conflict or a promise is visible but cannot be safely classified.');
    lines.push('- Track readManifest with filesReadFully, filesTriagedByName, scanEscalationReason, candidateSpecSetDigest, and corpusDigest. Put full-read files in filesReadFully, filename/title-only triage in filesTriagedByName, and use scanEscalationReason only for a justified tool-driven full decisions-directory scan.');
    lines.push('');
    if (ownerBinding) {
      lines.push(`Selected canonical process-fact owner paths: ${ownerBinding.paths.join(', ')}. Independently read every listed path and supply ownerDispositions with exactly one path, disposition (modify, test, or unchanged), and substantive reason (at least 40 characters) per mapped owner. Both understanding and checklist can omit the same owner: neither list is the completeness oracle. Unchanged means reviewed source sufficiency, not a requirement to edit every consulted file. Run under the registered scope role; the tool binds dispositions to current topology, source bytes, registry, declarations, and repository signing key.`);
    } else {
      lines.push('No canonical process-fact owner paths are selected by this Story; do not search the process-fact registry or supply ownerDispositions. Scope review still covers every promise in the Story and available project specifications.');
    }
    lines.push('Finish by calling scope_check_save:');
    lines.push(`- proof-or-stop scope_check_save '{"storyId":"${args.storyId}","features":[{"feature":"<promise or constraint>","covered_by":"<CHK-xxx or null>","status":"covered|excluded|gap|orphan-suspect|drift","excluded_by":"<reason or null>","source":"<artifact path>"}],"summary":{"total":1,"covered":0,"excluded":0,"gaps":1},"readManifest":{"filesReadFully":[],"filesTriagedByName":[],"scanEscalationReason":null,"candidateSpecSetDigest":"${routed?.artifactDigest ?? '<current candidate artifact digest>'}","corpusDigest":"${routed?.corpusDigest ?? '<current corpus digest>'}"},"openQuestions":[]}'`);
    lines.push('- Fill readManifest arrays with exactly the decisions files actually read or filename-triaged; leave them empty only when no such files were inspected.');
    lines.push('- If there are no gaps, still call scope_check_save with the complete feature list and accurate summary counts.');

    return { prompt: lines.join('\n') };
  }

  function buildTopologyCriticReviewPrompt(args: { storyId: string }): { prompt: string } {
    const story = store.readStory(args.storyId);
    if (!['PLAN', 'DEV', 'REVIEW'].includes(story.phase)) {
      throw new Error(`topology critic dispatch is unsupported during ${story.phase}`);
    }
    const lines = [
      `Independently review the current ProofStory acceptance topology for ${args.storyId}.`,
      `Working directory: ${root}`,
      '',
      renderAgentLivenessGuidance({ label: 'proof-or-stop-review-topology-critic/story', startSignal: 'DISPATCH_START:proof-or-stop-review-topology-critic/story' }),
      '',
      'Use the canonical proof-or-stop-review-topology-critic role. Do not edit implementation or story files.',
      REVIEWER_NO_DELEGATION_BOUNDARY,
      `Run proof-or-stop acceptance_basis '{"storyId":"${args.storyId}","json":true}' and inspect topology, scope, exclusions, discovery status, and closure.`,
      'A missing, partial, unsupported, stale, or tampered basis cannot receive pass.',
      'Every exclusion must already have a separately attributable proof-or-stop-review-scope-plan approval.',
      `Finish with proof-or-stop topology_critic_receipt_set '{"storyId":"${args.storyId}","verdict":"pass"}' or verdict=request_changes.`,
      `Then run proof-or-stop topology_critic_receipt_check '{"storyId":"${args.storyId}"}' to verify the persisted signed receipt.`,
    ];
    return { prompt: lines.join('\n') };

  }

  function buildStoryReviewPrompt(args: {
    storyId: string;
    resolved: ResolvedAgentDispatchType;
  }): { prompt: string } {
    const story = store.readStory(args.storyId);
    const entry = args.resolved.entry;
    const lane = entry.reviewerLane;
    if (!lane) throw new Error(`${entry.canonicalName} has no reviewer lane`);
    const storyDir = `${store.storyDirRel()}/${args.storyId}`;
    const routed = store.readCandidateSpecSet(args.storyId);
    const lines: string[] = [
      `As ${entry.canonicalName}, review story ${args.storyId} using the trusted context selected by review_run_start.`,
      '',
      `Working directory (subagent must cd here): ${root}`,
      '',
    ];
    appendDispatchLivenessGuidance(lines, `${entry.canonicalName}/story`);
    lines.push('Role boundary:');
    lines.push(`- ${REVIEWER_NO_DELEGATION_BOUNDARY}`);
    lines.push('- Review only; do not change code, tests, checklist status, or story metadata.');
    lines.push('- This is a story-level dispatch: review every checklist item and the integrated change, not one selected item.');
    lines.push('');
    lines.push('Required reading:');
    lines.push(`1. ${storyDir}/background.md`);
    lines.push(`2. ${storyDir}/plan.md`);
    lines.push(`3. ${storyDir}/checklist.json`);
    lines.push('- Read the files and relatedDocs named by every checklist item, bounded by the current candidate-spec artifact.');
    if (routed) {
      lines.push(`- Candidate routing: digest=${routed.artifactDigest} corpusDigest=${routed.corpusDigest} candidates=${routed.candidateSpecSet.join(', ') || '(none)'}`);
      lines.push(`- Bind no-blocker readManifest to candidateSpecSetDigest=${routed.artifactDigest} and corpusDigest=${routed.corpusDigest}.`);
      appendCandidateEscalationGuidance(lines, args.storyId, routed, false);
    }
    const requestAuthority = renderReviewRequestAuthority(store, args.storyId, { lane });
    if (requestAuthority.length > 0) lines.push('', ...requestAuthority);
    // Old-PoS run 31 (core/request-probes.ts): the framework probe tables as evidence.
    const probeEvidence = renderProbeEvidence(root, args.storyId, store.readChecklist(args.storyId).items.map(item => item.id));
    if (probeEvidence.length > 0) lines.push('', ...probeEvidence);
    // Old-PoS run 43 (core/sibling-parity.ts, A/B review.siblingParity, default on).
    const siblingParity = renderSiblingParity(root, lane);
    if (siblingParity.length > 0) lines.push('', ...siblingParity);
    // Old-PoS run 46 (core/resolved-finding-guard.ts): resolved findings are re-probed, not trusted.
    const reprobe = renderResolvedReprobe(store.readFindings(args.storyId).findings ?? [], args.storyId, lane);
    if (reprobe.length > 0) lines.push('', ...reprobe);
    // Lab round-cut N1 (core/removed-guard-scan.ts, dev.removedGuardScan advisory|on): base operand guards the change dropped.
    let removedGuards: string[] = [];
    try { removedGuards = renderRemovedGuardAdvisory(storyRemovedGuards(store, root, args.storyId, resolveGitCwd({ store, storyId: args.storyId, metadataRoot: root, projectRoot: root }))); } catch { removedGuards = []; }
    if (removedGuards.length > 0) lines.push('', ...removedGuards);
    lines.push('');
    lines.push(`Current phase: ${story.phase}. Review lane: ${lane}.`);
    appendReviewerExecutionModes(lines, args.storyId, lane);
    lines.push('Conclusion record (must choose one):');
    lines.push(`- Native path: start the reviewer run: proof-or-stop review_run_start '{"storyId":"${args.storyId}","agent":"${lane}"}' and copy the returned reviewRunId. In the managed cross-provider path the controller already performed this step.`);
    lines.push(`- Has issues: proof-or-stop finding_add '{"storyId":"${args.storyId}","reviewRunId":"<reviewRunId>","desc":"<file:line WHY + severity>","severity":"high|medium|low","category":"missing|edge|adversarial|happy","agent":"${lane}"}'`);
    lines.push('- No blocker: call review_pass_set with the returned reviewRunId and a truthful readManifest covering the story-level review.');
    return { prompt: lines.join('\n') };
  }

  function buildDeliveryReviewPrompt(args: {
    storyId: string;
    resolved: ResolvedAgentDispatchType;
  }): { prompt: string } {
    store.readStory(args.storyId);
    const lines: string[] = [
      `As ${args.resolved.canonicalType}, perform the delivery review for story ${args.storyId}.`,
      REVIEWER_NO_DELEGATION_BOUNDARY,
      '',
      `Working directory (subagent must cd here): ${root}`,
      '',
    ];
    appendDispatchLivenessGuidance(lines, `${args.resolved.canonicalType}/story`);
    lines.push('Role boundary: review only; do not change code, tests, checklist status, or commits.');
    lines.push(`Required reading: ${store.storyDirRel()}/${args.storyId}/background.md, plan.md, checklist.json, and delivery-facing relatedDocs.`);
    lines.push('Formal native delivery evidence requires the registered host adapter to descriptor-inject the exact one-shot broker attestation for this dispatch. Alternatively, the controller may launch this required TEST reviewer through host_run --managedDispatch; its live one-shot invocation and terminal-sealed delivery output provide the managed authority. Without either authorized invocation, delivery_check_set fails closed.');
    lines.push('Finish by calling delivery_check_set with the complete promise and evidence mapping; dispatch output alone is not delivery evidence.');
    // Old-PoS run 34 (F8): the reviewer spent its first minute exploring framework state
    // (status, dispatch_status, plan_get, host_run_status on its own run) before it ran the
    // pack producer. The read-only pack (delivery_context_pack default mode) is in the prompt.
    let pack = '';
    try { pack = String(createDeliveryContextPackHandlers(ctx).delivery_context_pack({ storyId: args.storyId })); } catch { pack = ''; }
    if (pack.trim()) {
      lines.push('');
      lines.push('Delivery context (the read-only delivery_context_pack output for this dispatch): start from it; do not explore framework state to rebuild it (do not run status, dispatch_status, plan_get, or host_run_status on your own run). Read the changed files, docs and tests it lists.');
      lines.push(pack.trim());
    }
    // Old-PoS run 40 (sink 5): the Story's delivery_check_set skeleton and the canonical report commands.
    try {
      const items = store.readChecklist(args.storyId).items.filter(item => item.status !== 'withdrawn');
      const storyRel = `${store.storyDirRel()}/${args.storyId}`;
      lines.push('');
      lines.push(renderDeliveryCheckSkeleton({
        storyId: args.storyId,
        docsPromises: items.filter(item => typeof item.userSees === 'string' && item.userSees.trim()).map(item => ({ docPath: `${storyRel}/checklist.json#${item.id}`, promise: String(item.userSees).trim() })),
        featureIds: items.map(item => item.id),
        commands: Object.fromEntries(items.flatMap(item => {
          const command = (item.verificationEvidence ?? []).map(row => (typeof row.command === 'string' ? row.command.trim() : '')).find(Boolean);
          return command ? [[item.id, command]] : [];
        })),
      }));
    } catch { /* the skeleton is guidance; the prompt stands without it */ }
    return { prompt: lines.join('\n') };
  }

  function buildVerificationIntentPrompt(args: {
    storyId: string;
    itemId: string;
    resolved: ResolvedAgentDispatchType;
  }): { prompt: string } {
    const story = store.readStory(args.storyId);
    const item = store.readChecklist(args.storyId).items.find(candidate => candidate.id === args.itemId);
    if (!item) throw new Error(`${args.itemId} not found in story ${args.storyId}`);
    const storyDir = `${store.storyDirRel()}/${args.storyId}`;
    const lines: string[] = [
      `As ${args.resolved.canonicalType}, define verification intent for ${args.storyId} ${args.itemId}: ${item.title}`,
      '',
      `Working directory (subagent must cd here): ${root}`,
      '',
    ];
    appendDispatchLivenessGuidance(lines, `${args.resolved.canonicalType}/${args.itemId}`);
    lines.push('Role boundary:');
    lines.push(`- ${REVIEWER_NO_DELEGATION_BOUNDARY}`);
    lines.push('- Define adversarial acceptance intent only; do not implement, edit code/tests, or change checklist completion.');
    lines.push('- You may write only verificationIntent through checklist_update; do not write status, verificationEvidence, or checklist definition fields.');
    lines.push('');
    lines.push('Required reading:');
    lines.push(`1. ${storyDir}/background.md`);
    lines.push(`2. ${storyDir}/plan.md#${args.itemId}`);
    if (readStoryRequest(store, args.storyId).status === 'ok') {
      lines.push(`3. ${storyDir}/request.md (the user's verbatim request): for every example and every listed variant this item covers, write one exact-output intent that names that exact input and its exact expected output or error text; never collapse a listed variant set into one representative case. An expected value the request does not quote verbatim needs "derivation":{"requestQuote":"<the request sentence it follows from, verbatim>","computation":"<the steps from it to that value>"} on its row (checklist_update refuses it otherwise).`);
    }
    for (const doc of item.relatedDocs || []) lines.push(`- ${doc}`);
    lines.push('');
    lines.push(`Current phase: ${story.phase}. Context: ${item.context || '(not declared)'}`);
    lines.push('Finish by handing the complete verificationIntent JSON to the Story owner as a proposal; do not set status or impersonate the owner.');
    lines.push('If another session owns the Story lease, return the proposal to that owner. The owner may apply it in PLAN with checklist_update and intentProposalApproval {baseIntentHash, digest, reason}; the reason must explain the review in at least 30 characters.');
    lines.push(`Read current baseIntentHash with checklist_get --storyId=${args.storyId} --proposalFor=${args.itemId}; add --proposalIntent='<complete intent JSON>' to obtain the exact digest. This read-only calculation grants no approval or independent authorship. The active owner applies the reviewed bytes with these hashes and a substantive reason, without an agent role. See checklist_update --help.`);
    lines.push('A directly dispatched verification-intent writer may call checklist_update only when normal owner lease checks permit it; no role bypass or takeover is granted.');
    return { prompt: lines.join('\n') };
  }

  function buildFindingPrompt(args: {
    storyId: string;
    findingId: string;
    agentType?: string;
  }): DispatchResult {
      if (!args.storyId) throw new Error('storyId is required');
      if (!args.findingId) throw new Error('findingId is required');

      const agentType = args.agentType;

      // 1. story existence check (message is clearer than readStory's native error)
      try {
        store.readStory(args.storyId);
      } catch {
        throw new Error(`story ${args.storyId} not found`);
      }

      // 2. finding lookup (id in findings.json is in "B-xxx:F-NNN" format; allow caller to pass short form "F-NNN" or long form)
      const data = store.readFindings(args.storyId);
      const wantShort = args.findingId.startsWith(`${args.storyId}:`)
        ? args.findingId.slice(args.storyId.length + 1)
        : args.findingId;
      const finding = data.findings.find(
        f => f.id === args.findingId || f.id === `${args.storyId}:${wantShort}`,
      );
      if (!finding) {
        throw new Error(`${args.findingId} not found in story ${args.storyId}`);
      }
      // Old-PoS run 31: a finding whose cited defect lies only in Story metadata is
      // the owner's checklist correction, never repair work (two blocked repair runs, one polluted patch).
      // Old-PoS run 33 (F-003): classified by correction target, not by lane (isMetadataTargetFinding).
      if (agentType === 'proof-or-stop-finding-repair' && (isStoryMetadataFinding(finding)
        || isMetadataTargetFinding({ store: store as never, storyId: args.storyId, gitCwd: resolveGitCwd({ store, storyId: args.storyId, metadataRoot: root, projectRoot: root }), finding }))) {
        throw new Error(`dispatch refused: ${finding.id} is a Story-metadata finding (its correction target is checklist text); it is corrected by the owner, not repaired [metadata_finding_not_repair_work]\nNext: proof-or-stop next --storyId=${args.storyId}`);
      }

      // 3. background.md existence
      const bgPath = `${store.storyDirRel()}/${args.storyId}/background.md`;
      const bgAbs = join(root, bgPath);
      const bgExists = existsSync(bgAbs);

      // 4. agent-type tiered injection decision (fully reuses story_dispatch's AGENT_BG_POLICY)
      const bgPolicy = resolveBackgroundPolicy(agentType);
      const displayAgent = resolveAgentDispatchType(agentType).canonicalType;

      // 5. finding field fallback. Note: Finding schema has no separate location/suggestion fields—
      //    reviewer writes file:line and fix suggestions directly in the desc body (by convention), so they are no longer rendered separately here.
      const fDesc = finding.desc || '(not provided)';
      const fSeverity = finding.severity || '(not provided)';
      const fCategory = finding.category || '(not provided)';
      const fReviewer = finding.agent || '(not provided)';

      // 6. assemble prompt
      const lines: string[] = [];
      // First line: use desc as short title (Finding schema has no separate title field), truncated to 80 characters
      const shortTitle = fDesc.length > 80 ? fDesc.slice(0, 80) + '…' : fDesc;
      // finding.id is already in "B-45ed:F-001" form; strip the storyId prefix when displaying to avoid duplicate "B-45ed B-45ed:F-001"
      const shortFid = finding.id.startsWith(`${args.storyId}:`)
        ? finding.id.slice(args.storyId.length + 1)
        : finding.id;
      lines.push(`As ${displayAgent}, fix ${args.storyId} ${shortFid}: ${shortTitle}`);
      lines.push('');

      // B-9d95 CHK-001: inject worktree absolute path. Root cause review (B-ed3e F-001): subagent inherits parent process cwd
      // which does not necessarily fall in the worktree (especially cross-repo scenarios), causing reviewer/handler to read docs/story/... at the main repo cwd
      // and miss the worktree copy, leading to false reports. ctx.root was bound to the worktree root at MCP handler init,
      // making it the most reliable absolute path source currently (better than process.cwd()—which depends on the caller shell's current directory).
      lines.push(`Working directory (subagent must cd here): ${root}`);
      lines.push('');
      lines.push('Controller launch contract (the repair worker does not perform this step):');
      lines.push('- This dispatch prepares the canonical prompt only; it does not start a host task.');
      lines.push('- The controller must launch this exact prompt through a native host task and obtain a nonempty task identity before calling any wait operation.');
      lines.push('- Never call a wait tool with an empty target list. If native launch is unavailable, report `missing_registered_worker` and keep the finding open.');
      lines.push('');
      appendDispatchLivenessGuidance(lines, `${displayAgent}/${shortFid}`);

      if (bgPolicy === 'required') {
        const prefix = bgExists ? '' : '⚠ missing, strongly recommend running `proof-or-stop background_set` first — ';
        lines.push(`Required reading: ${prefix}${bgPath}`);
        lines.push('');
      } else if (bgPolicy === 'advisory') {
        const prefix = bgExists ? '' : '⚠ missing — ';
        lines.push(`Optional reference: ${prefix}${bgPath}`);
        lines.push('');
      }
      // bgPolicy === 'none' → do not inject the background line at all
      if (readStoryRequest(store, args.storyId).status === 'ok') {
        lines.push(`Required reading: ${store.storyDirRel()}/${args.storyId}/request.md (the user's verbatim request; it outranks the checklist intents)`);
        lines.push('');
      }

      lines.push(`Severity: ${fSeverity}  Category: ${fCategory}  Reviewer: ${fReviewer}`);
      lines.push(`Description: ${fDesc}`);
      appendExactRequiredOutput(lines, itemsForFinding(store.readChecklist(args.storyId).items, finding));
      // Lab round-cut N3b: the request's exact-text literals at launch (the exact-text gate checks them before REVIEW).
      const requestLiterals = (() => { const request = readStoryRequest(store, args.storyId); return renderRequestExactLiterals(request.status === 'ok' ? request.text : null); })();
      if (requestLiterals.length) lines.push('', ...requestLiterals);
      lines.push('');
      lines.push('Repair the defect family, not only this counterexample:');
      lines.push('- Before editing, name the root cause and list every sibling code path with the same root cause (the other arity, operand type, direction, or read/write variant of the same operation).');
      lines.push('- Add a failing test for each sibling as well as for the reported case, then fix them together and rerun the affected package tests.');
      lines.push('- If the repair changes what a field or encoding means or can represent (for example adds an omitted/unset distinction), list every reader of it, including render, String(), serialize, print, equality and hash, and make each honor the new distinction or state a concrete reason tied to the request. Fix any existing test whose expected value contradicts the requirement.');
      lines.push('- A sibling left unfixed is reported as a new finding in the next review round, which costs a full remediation cycle.');
      // Old-PoS run 44 (F-009..F-019): each repair fixed the reported shapes only; the next round found the next one.
      lines.push('- Find the family by grepping the code path the finding names (the branch that mishandles it and every caller reaching it): each receiver, target (lvalue / parent / container) and operand shape that reaches the same branch, nested and computed ones included. Fix each (or reject it with an explicit error) with one test each.');
      lines.push('- In your final report, one line per shape checked: `[family] <shape>: fixed | rejected | unaffected (why)`.');
      // Old-PoS run 55: the repair deleted the correct test it had written because it failed.
      lines.push('- A test you add that fails on the current code is evidence of a product defect: fix the product code, or report the conflict (`[intent-conflict]`); never delete, skip or weaken it to get green (the framework refuses a repair that removes a test it added or a test running this finding\'s repro). List every test case you removed, with why.');
      lines.push(REPAIR_INPUT_VARIANT_RULE);
      lines.push(PRODUCT_CODE_NO_POS_METADATA_RULE);
      // Old-PoS run 46 (core/resolved-finding-guard.ts): resolved findings on the same code, rejected repairs, precedent conflicts.
      let processEvents: Array<Record<string, unknown>> = [];
      try { processEvents = store.readProcessEvents(args.storyId) as Array<Record<string, unknown>>; } catch { processEvents = []; }
      const rejectedAll = rejectedRepairCommits(processEvents);
      const resolvedContext = renderRepairResolvedContext({ findings: data.findings, storyId: args.storyId, finding,
        rejected: rejectedAll.get(finding.id) ?? [], rejectedAll });
      if (resolvedContext.length) lines.push(...resolvedContext);
      // Old-PoS run 73 (B): a regression of a resolved finding gets the earlier repair's diff and repro and a family-complete test requirement.
      const familyBrief = regressionFamilyBrief({ findings: data.findings, storyId: args.storyId, finding,
        gitCwd: resolveGitCwd({ store, storyId: args.storyId, metadataRoot: root, projectRoot: root }) });
      if (familyBrief.length) lines.push(...familyBrief);
      // Lab round-cut N2 (core/bound-matrix.ts): a finding in a helper with several operand branches is repaired branch-complete.
      const findingGitCwd = resolveGitCwd({ store, storyId: args.storyId, metadataRoot: root, projectRoot: root });
      const matrix = agentType === 'proof-or-stop-finding-repair' ? boundMatrixFor({ gitCwd: findingGitCwd, finding }) : null;
      if (matrix) {
        const recorded = recordBoundMatrix(root, args.storyId, finding.id, matrix);
        lines.push(...renderBoundMatrix(recorded, shortFid));
        for (const row of finding.status === 'open' ? earlierFindingRepairReports(root, args.storyId, finding.id) : []) {
          const problem = branchTestProblem(managedRunFinalMessage(root, row.runId), recorded);
          if (problem) lines.push(`- Earlier repair run ${row.runId} was not accepted: ${problem}. Test and report those branches now.`);
        }
      }
      const storyBase = (() => { try { return resolveFullStoryBaseHead(store, root, args.storyId); } catch { return undefined; } })();
      lines.push(storyBase
        ? `- Story base for that check: ${storyBase} (for example \`git worktree add --detach <tmp> ${storyBase.slice(0, 12)}\`, run the variants there, then remove it).`
        : '- Story base for that check: `git merge-base HEAD main` (run the variants in a detached temporary worktree, then remove it).');
      lines.push('');
      // Old-PoS run 29 REM2: the repair worker created a test file outside the declared files; state them.
      const allowedFiles = renderAllowedFilesSection(store.readScopeContract(args.storyId));
      if (allowedFiles.length) lines.push(...allowedFiles, '');
      // Old-PoS run 30: a relaunched repair starts from what the earlier run(s) reported.
      const earlier = finding.status === 'open' ? earlierFindingRepairReports(root, args.storyId, finding.id) : [];
      if (earlier.length) {
        lines.push(`Earlier repair run(s) of ${shortFid} ended without a repair commit (the finding is still open). Their final reports:`);
        for (const row of earlier) lines.push(`- run ${row.runId}: ${row.report.replace(/\s*\n\s*/g, ' ')}`);
        lines.push('- Start from those reports. Commit the repair; if it truly cannot be made inside this Story, name exactly what blocks it (path, rule or request sentence). Another run without a commit returns the Story to PLAN.', '');
      }
      lines.push('After completion:');
      appendImplementerCommitSteps(lines, `${args.storyId} ${shortFid}: resolve finding`);
      lines.push('- Return the commit SHA, focused verification output, and repair summary to the Story owner/controller. The repair worker must not call finding_resolve.');
      lines.push(`- The Story owner/controller verifies the repair and then runs: proof-or-stop finding_resolve '{"storyId":"${args.storyId}","findingId":"${finding.id}","resolution":"<verified repair description>"}'`);
      lines.push('');
      lines.push(INTENT_CONFLICT_RETURN_CONTRACT);

      return {
        prompt: lines.join('\n'),
        // Proof-or-Stop cannot invoke or intercept the host's native task/wait API.
        // This structured result lets host controllers enforce the same boundary
        // without parsing prose; the prompt remains the contract for LLM controllers.
        nativeLaunchContract: REPAIR_NATIVE_LAUNCH_CONTRACT,
      };
  }

  function buildItemPrompt(args: {
    storyId: string;
    itemId: string;
    agentType?: string;
  }): { prompt: string } {
      if (!args.storyId) throw new Error('storyId is required');
      if (!args.itemId) throw new Error('itemId is required');

      const agentType = args.agentType;

      // 1. story existence check (readStory's error message is not clear enough; wrap a layer)
      let story;
      try {
        story = store.readStory(args.storyId);
      } catch {
        throw new Error(`story ${args.storyId} not found`);
      }

      // 2. checklist item lookup
      const cl = store.readChecklist(args.storyId);
      const item = cl.items.find(i => i.id === args.itemId);
      if (!item) {
        throw new Error(`${args.itemId} not found in story ${args.storyId}`);
      }

      // 3. extract the corresponding CHK section from plan.md (optional—plan.md may not exist; fall back)
      const planSection = extractPlanSection(store, args.storyId, args.itemId);

      // 4. background.md existence detection (if missing → warning prefix, no crash)
      const bgPath = `${store.storyDirRel()}/${args.storyId}/background.md`;
      const bgAbs = join(root, bgPath);
      const bgExists = existsSync(bgAbs);

      // 5. extract Verify section from the plan.md section (fall back if not found)
      const verifyText = extractVerifyFromSection(planSection) || 'proof-or-stop validate all green';

      // 6. Files section rendering (if item.files is missing, display "(not declared)")
      const filesBlock = renderFilesBlock(item.files);

      // 7. background injection decision (B-45ed CHK-008 full tiered matrix)
      //    policy comes from AGENT_BG_POLICY (CLAUDE.md tiered matrix):
      //    - required → written into the first line of the "Required reading" section
      //    - advisory → write into the "optional reference" section
      //    - none     → do not inject at all
      const bgPolicy = resolveBackgroundPolicy(agentType);

      const resolvedAgent = resolveAgentDispatchType(agentType);
      if (resolvedAgent.entry.roleClass.endsWith('reviewer')) {
        const displayAgent = resolvedAgent.canonicalType;
        const lines: string[] = [];
        lines.push(`As ${displayAgent} reviewing ${args.storyId} ${args.itemId}: ${item.title}`);
        lines.push('');
        lines.push(`Working directory (subagent must cd here): ${root}`);
        lines.push('');
        appendDispatchLivenessGuidance(lines, `${displayAgent}/${args.itemId}`);
        lines.push('Role boundary:');
        lines.push('- Review only; do not change code, write tests, or update the checklist.');
        lines.push('- fresh-context reading materials; independently judge whether there is a blocker or an issue that requires rework.');
        lines.push('');
        lines.push('Review materials:');
        let idx = 1;
        if (bgPolicy === 'required') {
          const prefix = bgExists ? '' : '⚠ missing, strongly recommend writing `proof-or-stop background_set` first — ';
          lines.push(`${idx}. Required reading background.md to understand intent — ${prefix}${bgPath}`);
          idx++;
        }
        const planRef = `${store.storyDirRel()}/${args.storyId}/plan.md#${args.itemId}`;
        lines.push(`${idx}. ${planRef}`);
        idx++;
        const seen = new Set<string>([bgPath, planRef]);
        if (Array.isArray(item.relatedDocs) && item.relatedDocs.length > 0) {
          for (const doc of item.relatedDocs) {
            if (seen.has(doc)) continue;
            seen.add(doc);
            lines.push(`${idx}. ${doc}`);
            idx++;
          }
        }
        if (bgPolicy === 'advisory') {
          const prefix = bgExists ? '' : '⚠ missing — ';
          lines.push('');
          lines.push(`Optional reference background.md (understand intent, but this agent focuses on review duties): ${prefix}${bgPath}`);
        }
        lines.push('');
        lines.push(`Context: ${item.context || '(not declared)'}`);
        lines.push('');
        lines.push('Files:');
        lines.push(`- Modify: ${filesBlock.modify}`);
        lines.push(`- Create: ${filesBlock.create}`);
        lines.push(`- Test:   ${filesBlock.test}`);
        lines.push('');
        lines.push(`Verify expectation: ${verifyText}`);
        const routed = store.readCandidateSpecSet(args.storyId);
        if (routed) {
          lines.push(`Candidate routing: digest=${routed.artifactDigest} corpusDigest=${routed.corpusDigest} candidates=${routed.candidateSpecSet.join(', ') || '(none)'}`);
          lines.push(`Candidate escalation: requiresEscalation=${routed.requiresEscalation} reasons=${routed.escalationReasons.join(', ') || 'none'}`);
          appendCandidateEscalationGuidance(lines, args.storyId, routed, false);
        }
        lines.push('');
        appendReviewerExecutionModes(lines, args.storyId, displayAgent);
        lines.push('Conclusion record (must choose one of two):');
        lines.push(`- Native path: first start this round's reviewer run: proof-or-stop review_run_start '{"storyId":"${args.storyId}","agent":"${displayAgent}"}', copy the reviewRunId from the output. In the managed cross-provider path the controller already performed this step.`);
        lines.push(`- Has issues: proof-or-stop finding_add '{"storyId":"${args.storyId}","reviewRunId":"<reviewRunId from review_run_start>","desc":"<file:line WHY + severity>","severity":"high|medium|low","category":"missing|edge|adversarial|happy","agent":"${displayAgent}"}'`);
        lines.push('- Track readManifest with filesReadFully, filesTriagedByName, scanEscalationReason, candidateSpecSetDigest, and corpusDigest; include it on no-blocker review_pass_set. Non-decision entries remain signed manifest evidence; mechanical decisions-doc read mismatch fails closed.');
        lines.push(`- No blocker: proof-or-stop review_pass_set '{"storyId":"${args.storyId}","agent":"${displayAgent}","reviewRunId":"<reviewRunId from review_run_start>","note":"reviewed ${args.itemId}: checked implementation against the item context and found no blocker.","readManifest":{"filesReadFully":["<file reviewed in full>"],"filesTriagedByName":["<file triaged by name>"],"scanEscalationReason":null,"candidateSpecSetDigest":"${routed?.artifactDigest ?? '<current candidate artifact digest>'}","corpusDigest":"${routed?.corpusDigest ?? '<current corpus digest>'}"}}'`);

        void story;

        return { prompt: lines.join('\n') };
      }

      // 8. Assemble implementer prompt
      const lines: string[] = [];
      lines.push(`As ${resolvedAgent.canonicalType} implementing ${args.storyId} ${args.itemId}: ${item.title}`);
      lines.push('');
      lines.push('Controller launch contract (the worker does not perform this step):');
      lines.push('- A native dispatch exists only after the host returns a nonempty child task identity. Never claim dispatch or call a wait tool with an empty target list.');
      lines.push(`- If the host cannot return a native child identity, the controller must launch this exact Story/item through host_run with agentType=proof-or-stop-implementer, managedDispatch=true, storyId=${args.storyId}, and itemId=${args.itemId}; then monitor the returned runId.`);
      lines.push('- A successful managed run is terminal only after the item is done and its subagent_result is receipt-bound to that exact run.');
      lines.push('');
      lines.push('Managed implementation status contract:');
      lines.push('- The Story owner/controller owns the start transition. Do not call checklist_update with status=in_progress; begin the assigned implementation directly.');
      lines.push(`- When the implementation is ready, the one completion call is the checklist_update status=done + commit call under "After completion" (it commits, then marks ${args.itemId} done).`);
      lines.push('- An owner-gate refusal of an accidental in_progress call does not consume the item-bound completion capability. Continue the implementation and use the exact done call after commit.');
      lines.push('');
      // B-9d95 CHK-001: inject worktree absolute path. Root cause retrospective (B-ed3e F-001): subagent inherits parent process cwd
      // which does not necessarily land in the worktree (especially cross-repo scenarios), causing reviewer/handler to read docs/story/... in the main repo cwd
      // failing to see the worktree copy and producing false reports. ctx.root is already bound to the worktree root at MCP handler initialization,
      // and is currently the most reliable absolute path source (better than process.cwd()—the latter depends on the caller's shell current directory).
      lines.push(`Working directory (subagent must cd here): ${root}`);
      lines.push('');
      appendDispatchLivenessGuidance(lines, `${resolvedAgent.canonicalType}/${args.itemId}`);
      // Old-PoS run 34 (§4 sink 2): the implementer re-read background.md, plan.md and
      // request.md at the start of every item run (7 of 94 turns). They are static in DEV,
      // so the prompt carries them; only the item's relatedDocs stay files to read.
      const planRef = `${store.storyDirRel()}/${args.storyId}/plan.md#${args.itemId}`;
      const storyRequest = readStoryRequest(store, args.storyId);
      const inlined = bgPolicy === 'required' ? renderInlinedStoryDocuments({
        background: bgExists ? readFileSync(bgAbs, 'utf8') : null, bgPath,
        planSection, planRef,
        request: storyRequest.status === 'ok' ? storyRequest.text : null, requestPath: `${store.storyDirRel()}/${args.storyId}/request.md`,
      }) : [];
      const seen = new Set<string>([bgPath, planRef]);
      const related = (Array.isArray(item.relatedDocs) ? item.relatedDocs : []).filter(doc => !seen.has(doc) && (seen.add(doc), true));
      let idx = 1;
      if (inlined.length) {
        if (!bgExists) lines.push(`⚠ background.md is missing (${bgPath}); strongly recommend writing \`proof-or-stop background_set\` first.`);
        if (related.length) {
          lines.push('Required reading (in order):');
          for (const doc of related) { lines.push(`${idx}. ${doc}`); idx++; }
        }
      } else {
        lines.push('Required reading (in order):');
        if (bgPolicy === 'required') {
          const prefix = bgExists ? '' : '⚠ missing, strongly recommend writing `proof-or-stop background_set` first — ';
          lines.push(`${idx}. Required reading background.md to understand intent — ${prefix}${bgPath}`);
          idx++;
        }
        lines.push(`${idx}. ${planRef}`);
        idx++;
        for (const doc of related) { lines.push(`${idx}. ${doc}`); idx++; }
        if (storyRequest.status === 'ok') {
          lines.push(`${idx}. ${store.storyDirRel()}/${args.storyId}/request.md (the user's verbatim request; it outranks the checklist intents)`);
          idx++;
        }
      }
      // B-45ed CHK-008: advisory agent appends an "optional reference" line after the required reading section; none agent does not output the background line at all
      if (bgPolicy === 'advisory') {
        const prefix = bgExists ? '' : '⚠ missing — ';
        lines.push('');
        lines.push(`Optional reference background.md (understand intent, but this agent focuses on mechanical checks): ${prefix}${bgPath}`);
      }
      lines.push('');
      lines.push(`Context: ${item.context || '(not declared)'}`);
      lines.push('');
      lines.push('Files:');
      lines.push(`- Modify: ${filesBlock.modify}`);
      lines.push(`- Create: ${filesBlock.create}`);
      lines.push(`- Test:   ${filesBlock.test}`);
      lines.push('');
      lines.push(`Verify: ${verifyText}`);
      appendPinnedVerification(lines, item.verificationIntent);
      appendExactRequiredOutput(lines, [item]);
      // Old-PoS runs 24-29: the repair prompt's input-variant sweep, moved before REVIEW as a probe matrix.
      // Old-PoS run 31 (core/request-probes.ts): with a project probeRunner the framework runs the
      // item's rows (compact contract, no hand-written probes); without one, the matrix plus the
      // request-anchored rows and the per-row [probe-row] report.
      lines.push('');
      const probeItems = store.readChecklist(args.storyId).items;
      const probeRequest = readStoryRequest(store, args.storyId);
      const probeRequestText = probeRequest.status === 'ok' ? probeRequest.text : null;
      const probeRunner = storyProbeRunner(store, root, args.storyId, resolveGitCwd({ store, storyId: args.storyId, metadataRoot: root, projectRoot: root }));
      // Old-PoS run 33: the probe matrix and its [probes] / [probe-row] report contract are the
      // A/B arm implementation.probeMatrix=on (default off: one line).
      const probeMatrix = (() => { try { return probeMatrixOn(loadConfig(root)); } catch { return false; } })();
      if (probeRunner) {
        lines.push(...renderFrameworkProbeContract(probeItems, probeRequestText, args.itemId, probeRunner, { probeMatrix }));
        if (!probeMatrix) lines.push(IMPLEMENTER_PROBE_LINE);
        lines.push(...renderProbeFlagRelaunch(root, args.storyId, args.itemId));
      } else if (!probeMatrix) {
        lines.push(IMPLEMENTER_PROBE_LINE);
      } else {
        lines.push(IMPLEMENTER_PROBE_MATRIX);
        const itemBase = (() => { try { return resolveFullStoryBaseHead(store, root, args.storyId); } catch { return undefined; } })();
        lines.push(`- Story base: ${itemBase ?? '`git merge-base HEAD main`'} (run base probes in a detached temporary worktree, then remove it).`);
        lines.push(...renderAnchoredProbeTable(probeItems, probeRequestText, args.itemId));
        const reported = reportProbeDecision(args.itemId, requestAnchoredKeys(probeItems, probeRequestText, args.itemId), implementerRunReports(root, args.storyId, args.itemId));
        if (reported) lines.push(`- Earlier implementer run ${reported.runId} of this item left request contradictions open (fix each, or list a wrong pin under [intent-conflict]): ${reported.rows.join('; ').slice(0, 1500)}`);
      }
      const probeGap = probeMatrix ? earlierImplementerProbeGap(root, args.storyId, args.itemId) : null;
      if (probeGap) lines.push(renderProbeTestGapLine(probeGap));
      lines.push(...renderExactTextRelaunch(root, args.storyId, args.itemId));
      // Lab round-cut N3b / N1: the request's exact-text literals at launch; the removed base guards of a reopened item.
      lines.push(...renderRequestExactLiterals(probeRequestText));
      lines.push(...renderRemovedGuardRelaunch(root, args.storyId, args.itemId));
      // Lab sibling-gate (A/B plan.counterpartCoverage=on): probe the same receiver's counterpart before writing an added operation.
      const counterpart = planCounterpartCoverage(store, root, args.storyId, () => resolveGitCwd({ store, storyId: args.storyId, metadataRoot: root, projectRoot: root }));
      if (counterpart) lines.push(...counterpartImplementerLines(counterpart, args.itemId));
      const routed = store.readCandidateSpecSet(args.storyId);
      if (routed) {
        lines.push('');
        lines.push(`Candidate routing: digest=${routed.artifactDigest} corpusDigest=${routed.corpusDigest} candidates=${routed.candidateSpecSet.join(', ') || '(none)'}`);
        lines.push(`Candidate escalation: requiresEscalation=${routed.requiresEscalation} reasons=${routed.escalationReasons.join(', ') || 'none'}`);
        appendCandidateEscalationGuidance(lines, args.storyId, routed, false);
      }
      lines.push('');
      lines.push(PRODUCT_CODE_NO_POS_METADATA_RULE.replace(/^- /, ''));
      if (inlined.length) { lines.push(''); lines.push(...inlined); }
      lines.push('');
      lines.push('After completion:');
      // Old-PoS run 34 (§4 sink 2): commit + done in one call (core/item-done-commit.ts).
      const declared = [...new Set([...(item.files?.modify ?? []), ...(item.files?.create ?? []), ...(item.files?.test ?? [])])];
      lines.push(`- One call commits and marks the item done: proof-or-stop checklist_update '${JSON.stringify({ storyId: args.storyId, itemId: args.itemId, status: 'done', commit: { files: declared.length ? declared : ['<each file you changed>'] } })}'`);
      lines.push(`  It stages exactly commit.files (list every file you changed), refuses a git diff --check error with nothing committed (fix the lines it prints and repeat the call), commits as ${IMPLEMENTER_COMMIT_AUTHOR} with the message "${`${args.storyId} ${args.itemId}: ${item.title}`.replace(/"/g, "'")}", then runs the usual done checks; no separate git diff --check, git add, git commit or status call is needed.`);
      lines.push('');
      lines.push(INTENT_CONFLICT_RETURN_CONTRACT);

      // Use story.phase to eliminate unused variable warning (also convenient for reading context when extending CHK-008)
      void story;

      return { prompt: lines.join('\n') };
  }

  const handlers = {
    /**
     * dispatch — B-9d95 CHK-004 unified entry
     * (B-a4e3 CHK-005: the deprecated finding_dispatch / story_dispatch alias methods were removed;
     * dispatch is now the only entry. buildItemPrompt / buildFindingPrompt remain — they are used here.)
     *
     * The registry is the sole authority for phase, cardinality, prompt class,
     * and role. Validation completes before any prompt builder is selected.
     *
     * Mutual exclusion validation: exactly one of the three must be provided; more / fewer both throw Error.
     * Returns: { prompt: string, nativeLaunchContract?: object }. Finding repair
     * exposes the host-owned launch prerequisite as structured data; other prompt
     * bytes remain unchanged (the clusterId branch reuses cluster.ts text).
     */
    dispatch(args: {
      storyId: string;
      itemId?: string;
      findingId?: string;
      clusterId?: string;
      agentType?: string;
      reviewPurpose?: 'topology' | 'inventory-completeness';
      inventoryEpochId?: string;
      summary?: boolean;
    }): DispatchResult {
      if (!args.storyId) throw new Error('storyId is required');
      let story;
      try {
        story = store.readStory(args.storyId);
      } catch {
        throw new Error(`story ${args.storyId} not found`);
      }
      const resolved = validateAgentDispatchRequest({
        agentType: args.agentType,
        phase: story.phase,
        itemId: args.itemId,
        findingId: args.findingId,
        clusterId: args.clusterId,
        reviewPurpose: args.reviewPurpose,
        inventoryEpochId: args.inventoryEpochId,
      });
      const canonicalType = resolved.canonicalType;
      const identifierKind = args.itemId ? 'itemId' : args.findingId ? 'findingId' : args.clusterId ? 'clusterId' : undefined;
      const promptBuilder = resolveAgentDispatchPromptBuilder(resolved.entry, identifierKind);

      if (promptBuilder === 'init-review') {
        const result = buildInitReviewPrompt({
          storyId: args.storyId,
          agentType: canonicalType,
        });
        const wrapped = assembleComplexStoryDispatch(story, canonicalType, result.prompt);
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: canonicalType,
          targetKind: 'init-review',
          ...(wrapped.envelope ? { promptEnvelope: wrapped.envelope, promptEnvelopeId: wrapped.envelope.envelopeId, promptEnvelopeDigest: wrapped.envelope.contextDigest, assembledPromptDigest: wrapped.envelope.assembledPromptDigest } : {}),
          ...(wrapped.promptBudget ? { promptBudget: wrapped.promptBudget } : {}),
        });
        return wrapped;
      }
      if (promptBuilder === 'product-init-review') {
        const result = buildProductInitReviewPrompt({
          storyId: args.storyId,
          agentType: canonicalType,
        });
        const wrapped = assembleComplexStoryDispatch(story, canonicalType, result.prompt);
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: canonicalType,
          targetKind: 'init-review',
          ...(wrapped.envelope ? { promptEnvelope: wrapped.envelope, promptEnvelopeId: wrapped.envelope.envelopeId, promptEnvelopeDigest: wrapped.envelope.contextDigest, assembledPromptDigest: wrapped.envelope.assembledPromptDigest } : {}),
          ...(wrapped.promptBudget ? { promptBudget: wrapped.promptBudget } : {}),
        });
        return wrapped;
      }
      if (promptBuilder === 'scope-plan-review') {
        const result = buildScopePlanReviewPrompt({
          storyId: args.storyId,
          agentType: canonicalType,
        });
        const wrapped = assembleComplexStoryDispatch(story, canonicalType, result.prompt);
        const authorityBinding = topologyAuthorityDispatchBinding(story, false);
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: canonicalType,
          targetKind: 'scope-plan-review',
          ...authorityBinding,
          ...(wrapped.envelope ? { promptEnvelope: wrapped.envelope, promptEnvelopeId: wrapped.envelope.envelopeId, promptEnvelopeDigest: wrapped.envelope.contextDigest, assembledPromptDigest: wrapped.envelope.assembledPromptDigest } : {}),
          ...(wrapped.promptBudget ? { promptBudget: wrapped.promptBudget } : {}),
        });
        return wrapped;
      }
      if (promptBuilder === 'topology-critic-review') {
        if (args.reviewPurpose === 'inventory-completeness') {
          return withReviewInventoryMutationLock(store, args.storyId, () => {
            const inventoryBinding = requireInventoryCriticSubjectLocked(ctx, args.storyId, args.inventoryEpochId!);
            const currentStory = store.readStory(args.storyId);
            const dispatchPrompt = [
              'Review purpose: inventory-completeness. This is not topology certification.',
              `Trusted inventory subject: ${JSON.stringify(inventoryBinding)}`,
              renderAgentLivenessGuidance({ label: 'proof-or-stop-review-topology-critic/inventory', startSignal: 'DISPATCH_START:proof-or-stop-review-topology-critic/inventory' }),
              'Use the canonical critic role with the inventory-only duties. Preserve real Git attribution; never manufacture role-named implementation commits.',
              REVIEWER_NO_DELEGATION_BOUNDARY,
              'Launch only against the OPEN inventory. After official finalization, consumers verify the sealed launch prompt and signed completed-wave subject; do not reconstruct a new OPEN prompt or rewrite the terminal evidence.',
              'A managed reviewer may start after an OPEN epoch cutoff when ancestry and both content hashes remain bound. Earlier-wave critic evidence is historical, not current authority; an older PASS is omitted from invalid only after its native or managed authority authenticates and a newer valid lane record (PASS or FINDING) exists. It never becomes current authority, and open findings remain blocking. Receipt tampering remains blocking.',
              'Evidence-only retention refuses commits that also flush pending inventory initialization or unrelated process facts; a writer label never grants authority over those additional changes.',
              'A verification refresh retains review only when requirements and the covered intent references, evidence kind and passing result stay unchanged from the original reviewed snapshot and both old and new execution proofs authenticate. New coverage or a changed result requires fresh independent review.',
              `First run proof-or-stop review_run_start '${JSON.stringify({ storyId: args.storyId, agent: canonicalType, reviewPurpose: args.reviewPurpose, inventoryEpochId: args.inventoryEpochId })}'.`,
              'Inspect every required-lane signed terminal/read record and every verified Finding on this exact cutoff. Report missed paths through finding_add or review_pass_set with complete read evidence.',
              `Then call proof-or-stop review_inventory_critic_set with storyId=${args.storyId}, epochId=${inventoryBinding.epochId}, the exact new reviewRunId and one independently justified findingDisposition per aggregate Finding. Empty dispositions are valid only for an empty set.`,
              'Do not call topology_critic_receipt_set or claim topology, TEST, DONE, dependency approval, or independent-host assurance from this inventory purpose.',
              ...renderReviewRequestAuthority(store, args.storyId, { critic: true }),
            ].join('\n');
            const wrapped = assembleComplexStoryDispatch(currentStory, canonicalType, dispatchPrompt, 'inventory-completeness');
            const reviewerResponsibility: ReviewerDispatchResponsibility = {
              kind: 'inventory-completeness', epochId: inventoryBinding.epochId, wave: inventoryBinding.wave,
              materialHash: inventoryBinding.cutoff.materialHash, storyFilesHash: inventoryBinding.cutoff.storyFilesHash ?? '',
            };
            const envelopeMode = resolvePromptEnvelopeRolloutMode(canonicalType, loadConfig(root).promptEnvelope);
            const hostRenderHost = currentReviewerPromptHost();
            const hostIdentity = reviewerHostRenderIdentity(root, canonicalType, hostRenderHost, envelopeMode);
            const dispatchPromptDigest = reviewerDispatchPromptDigest(dispatchPrompt);
            appendDispatchEvent({
              storyId: args.storyId, agentType: canonicalType, targetKind: 'inventory-critic-review',
              reviewPurpose: 'inventory-completeness', inventoryBinding, reviewerResponsibility, dispatchPrompt, dispatchPromptDigest,
              hostRenderHost, hostRenderIdentityDigest: hostIdentity.identityDigest, reviewRound: currentStory.currentReviewRound,
              dispatchBindingDigest: reviewerDispatchBindingDigest({ reviewerResponsibility, storyId: args.storyId, lane: canonicalType, reviewRound: currentStory.currentReviewRound!, dispatchPromptDigest, hostRenderIdentityDigest: hostIdentity.identityDigest }),
              ...(wrapped.envelope ? { promptEnvelope: wrapped.envelope, promptEnvelopeId: wrapped.envelope.envelopeId, promptEnvelopeDigest: wrapped.envelope.contextDigest, assembledPromptDigest: wrapped.envelope.assembledPromptDigest } : {}),
            });
            return wrapped;
          });
        }
        const result = buildTopologyCriticReviewPrompt({ storyId: args.storyId });
        const wrapped = assembleComplexStoryDispatch(story, canonicalType, result.prompt);
        const authorityBinding = topologyAuthorityDispatchBinding(story, true);
        const reviewerResponsibility: ReviewerDispatchResponsibility = { kind: 'topology-proof' };
        // PLAN/DEV dispatch signs the independent topology receipt provenance,
        // but it is not REVIEW lane evidence and must not invent or inherit a
        // reviewer-round binding. In REVIEW, a real current round and signed dispatch
        // binding remain mandatory. Inventory responsibility is selected only
        // by the explicit OPEN-inventory branch above.
        const reviewerBinding = story.phase === 'REVIEW' ? (() => {
          if (!story.currentReviewRound) {
            throw new Error(`review dispatch requires currentReviewRound for story ${args.storyId}`);
          }
          const envelopeMode = resolvePromptEnvelopeRolloutMode(canonicalType, loadConfig(root).promptEnvelope);
          const hostRenderHost = currentReviewerPromptHost();
          const hostIdentity = reviewerHostRenderIdentity(root, canonicalType, hostRenderHost, envelopeMode);
          const dispatchPromptDigest = reviewerDispatchPromptDigest(result.prompt);
          return {
            reviewerResponsibility,
            dispatchPrompt: result.prompt,
            dispatchPromptDigest,
            hostRenderHost,
            hostRenderIdentityDigest: hostIdentity.identityDigest,
            dispatchBindingDigest: reviewerDispatchBindingDigest({
              reviewerResponsibility,
              storyId: args.storyId,
              lane: canonicalType,
              reviewRound: story.currentReviewRound,
              dispatchPromptDigest,
              hostRenderIdentityDigest: hostIdentity.identityDigest,
            }),
            reviewRound: story.currentReviewRound,
          };
        })() : {};
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: canonicalType,
          targetKind: 'topology-critic-review',
          ...authorityBinding,
          ...reviewerBinding,
          ...(wrapped.envelope ? { promptEnvelope: wrapped.envelope, promptEnvelopeId: wrapped.envelope.envelopeId, promptEnvelopeDigest: wrapped.envelope.contextDigest, assembledPromptDigest: wrapped.envelope.assembledPromptDigest } : {}),
          ...(wrapped.promptBudget ? { promptBudget: wrapped.promptBudget } : {}),
        });
        return wrapped;
      }
      if (promptBuilder === 'story-review' || promptBuilder === 'coverage-review') {
        const result = buildStoryReviewPrompt({ storyId: args.storyId, resolved });
        const envelopeMode = resolvePromptEnvelopeRolloutMode(
          canonicalType,
          loadConfig(root).promptEnvelope,
        );
        if (!story.currentReviewRound && envelopeMode === 'full-envelope') {
          throw new Error(`review dispatch requires currentReviewRound for story ${args.storyId}`);
        }
        if (story.currentReviewRound) {
          const hostRenderHost = currentReviewerPromptHost();
          const hostIdentity = reviewerHostRenderIdentity(root, canonicalType, hostRenderHost, envelopeMode);
          const dispatchPromptDigest = reviewerDispatchPromptDigest(result.prompt);
          const dispatchBindingDigest = reviewerDispatchBindingDigest({
            storyId: args.storyId,
            lane: canonicalType,
            reviewRound: story.currentReviewRound,
            dispatchPromptDigest,
            hostRenderIdentityDigest: hostIdentity.identityDigest,
          });
          appendDispatchEvent({
            storyId: args.storyId,
            agentType: canonicalType,
            targetKind: 'story-review',
            dispatchPrompt: result.prompt,
            dispatchPromptDigest,
            hostRenderHost,
            hostRenderIdentityDigest: hostIdentity.identityDigest,
            dispatchBindingDigest,
            reviewRound: story.currentReviewRound,
          });
        } else {
          appendDispatchEvent({
            storyId: args.storyId,
            agentType: canonicalType,
            targetKind: 'story-review',
          });
        }
        return result;
      }
      if (promptBuilder === 'rollout-verify') {
        const lines = [
          `As ${canonicalType}, run the registered acceptance-rollout cohort for ${args.storyId}.`,
          `Working directory (subagent must cd here): ${root}`,
          REVIEWER_NO_DELEGATION_BOUNDARY,
          '',
        ];
        appendDispatchLivenessGuidance(lines, `${canonicalType}/story`);
        lines.push(`Start the reviewer run: proof-or-stop review_run_start '{"storyId":"${args.storyId}","agent":"${canonicalType}"}' and copy the returned reviewRunId.`);
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: canonicalType,
          targetKind: 'rollout-verify',
        });
        return { prompt: lines.join('\n') };
      }
      if (promptBuilder === 'delivery-review') {
        const result = buildDeliveryReviewPrompt({ storyId: args.storyId, resolved });
        const wrapped = assembleComplexStoryDispatch(story, canonicalType, result.prompt);
        let authorityBinding: {
          dispatchPrompt: string;
          dispatchPromptDigest: string;
          hostRenderHost: PromptHost;
          hostRenderIdentityDigest: string;
          dispatchBindingDigest: string;
          headHash: string;
          materialHash: string;
          storyFilesHash?: string;
        } | undefined;
        try {
          const hostRenderHost = currentReviewerPromptHost();
          const hostRenderIdentityDigest = reviewerHostRenderIdentity(
            root,
            DELIVERY_REVIEW_LANE,
            hostRenderHost,
            resolvePromptEnvelopeRolloutMode(DELIVERY_REVIEW_LANE, loadConfig(root).promptEnvelope),
          ).identityDigest;
          const snapshot = captureReviewRunSnapshot(root, { storyId: args.storyId, storyPhase: story.phase }, root);
          const dispatchPromptDigest = reviewerDispatchPromptDigest(wrapped.prompt);
          authorityBinding = {
            dispatchPrompt: wrapped.prompt,
            dispatchPromptDigest,
            hostRenderHost,
            hostRenderIdentityDigest,
            dispatchBindingDigest: deliveryReviewDispatchBindingDigest({
              storyId: args.storyId,
              lane: DELIVERY_REVIEW_LANE,
              dispatchPromptDigest,
              hostRenderIdentityDigest,
              headHash: snapshot.headHash,
              materialHash: snapshot.materialHash,
              storyFilesHash: snapshot.storyFilesHash ?? null,
            }),
            headHash: snapshot.headHash,
            materialHash: snapshot.materialHash,
            ...(snapshot.storyFilesHash ? { storyFilesHash: snapshot.storyFilesHash } : {}),
          };
        } catch {
          // Dispatch remains usable as advisory context without a supported host
          // adapter. delivery_check_set itself fails closed without this binding.
        }
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: canonicalType,
          targetKind: 'delivery-review',
          ...(authorityBinding ?? {}),
          ...(wrapped.envelope ? { promptEnvelope: wrapped.envelope, promptEnvelopeId: wrapped.envelope.envelopeId, promptEnvelopeDigest: wrapped.envelope.contextDigest, assembledPromptDigest: wrapped.envelope.assembledPromptDigest } : {}),
          ...(wrapped.promptBudget ? { promptBudget: wrapped.promptBudget } : {}),
        });
        return wrapped;
      }
      if (promptBuilder === 'verification-intent-item') {
        const result = buildVerificationIntentPrompt({
          storyId: args.storyId,
          itemId: args.itemId!,
          resolved,
        });
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: canonicalType,
          targetKind: 'checklist',
          itemId: args.itemId!,
        });
        return result;
      }

      if (args.itemId) {
        const implementer = canonicalType === 'proof-or-stop-implementer';
        if (implementer) {
          // Old-PoS run 15: a second implementer for an item an earlier managed
          // run already sealed can only re-mark it done (done->done binds
          // nothing) and then fails. Refuse before any prompt or provider.
          const prior = findSealedManagedImplementerCompletion({ root, storyId: args.storyId, itemId: args.itemId });
          if (prior) throw new Error(`dispatch refused: ${managedImplementerAlreadyDoneAction(args.storyId, args.itemId, prior)}`);
          // Old-PoS run 27 (per-item N8 hold): an item the deferred scope-plan
          // verdict audits is never implemented before that verdict lands.
          const held = story.phase === 'DEV'
            ? scopeVerdictHeldItems(store, root, story, resolveWorkflowPolicy(loadConfig(root), story))
            : null;
          if (held?.heldItemIds.includes(args.itemId)) {
            throw new Error(`dispatch refused: ${args.itemId} waits for the scope-plan verdict [scope_verdict_held_item]: ${held.byItem[args.itemId]}; `
              + 'a pin-audit / asymmetric-example gap must land before the item is implemented.\n'
              + (held.run
                ? `Next: proof-or-stop host_run_status --runId=${held.run.runId} --untilTerminal=true`
                : `Next: proof-or-stop story_advance '{"storyId":"${args.storyId}","phase":"PLAN"}' (then rerun the scope-plan reviewer)`));
          }
        }
        const result = buildItemPrompt({
          storyId: args.storyId,
          itemId: args.itemId,
          agentType: canonicalType,
        });
        const wrapped = implementer
          ? assembleComplexStoryDispatch(story, canonicalType, result.prompt)
          : { prompt: result.prompt };
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: canonicalType,
          targetKind: 'checklist',
          itemId: args.itemId,
          ...(wrapped.envelope ? { promptEnvelope: wrapped.envelope, promptEnvelopeId: wrapped.envelope.envelopeId, promptEnvelopeDigest: wrapped.envelope.contextDigest, assembledPromptDigest: wrapped.envelope.assembledPromptDigest } : {}),
          ...(wrapped.promptBudget ? { promptBudget: wrapped.promptBudget } : {}),
        });
        return wrapped;
      }
      if (args.findingId) {
        const result = buildFindingPrompt({
          storyId: args.storyId,
          findingId: args.findingId,
          agentType: canonicalType,
        });
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: canonicalType,
          targetKind: 'finding',
          findingId: args.findingId,
        });
        // Finding repair is intentionally not envelope-wrapped. Preserve the
        // structured host launch contract explicitly at the public dispatch()
        // boundary so callers never need to infer it from prompt prose.
        return {
          prompt: result.prompt,
          nativeLaunchContract: result.nativeLaunchContract,
        };
      }
      // clusterId branch — reuse cluster.ts's finding_dispatch (outputs string).
      // Wrap as { prompt } to keep the interface consistent.
      const clusterHandlers = createClusterHandlers(ctx);
      const clusterPrompt = clusterHandlers.finding_dispatch({
        storyId: args.storyId,
        clusterId: args.clusterId!,
      });
      const prompt = `Controller launch contract (the repair worker does not perform this step):
- This dispatch prepares the canonical prompt only; it does not start a host task.
- The controller must launch this exact prompt through a native host task and obtain a nonempty task identity before calling any wait operation.
- Never call a wait tool with an empty target list. If native launch is unavailable, report \`missing_registered_worker\` and keep the cluster findings open.

${renderAgentLivenessGuidance({
        label: `${canonicalType}/${args.clusterId!}`,
        startSignal: `DISPATCH_START:${canonicalType}/${args.clusterId!}`,
      })}\n\n${clusterPrompt}`;
      appendDispatchEvent({
        storyId: args.storyId,
        agentType: canonicalType,
        targetKind: 'cluster',
        clusterId: args.clusterId!,
      });
      return { prompt, nativeLaunchContract: REPAIR_NATIVE_LAUNCH_CONTRACT };
    },
  };
  const dispatchFull = handlers.dispatch;
  handlers.dispatch = (args: Parameters<typeof dispatchFull>[0]): DispatchResult => {
    const result = dispatchFull(args);
    return args.summary ? { ...result, prompt: omittedPromptNote(result.prompt) } : result;
  };
  return handlers;
}

/** Extract the paragraph between `## {itemId}:` and the next `^## ` from plan.md */
function extractPlanSection(store: StoryStore, storyId: string, itemId: string): string | null {
  const planPath = store.storyFilePath(storyId, 'plan.md');
  if (!existsSync(planPath)) return null;
  const content = readFileSync(planPath, 'utf-8');
  const lines = content.split('\n');
  const startRe = new RegExp(`^## ${itemId}:`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * Extract the content after **Verify**: from the CHK-xxx section of plan.md, until encountering the next **xxx**: bold field or section end.
 * Preserve bullet form; join multiple lines with "; " for single-line display.
 */
function extractVerifyFromSection(section: string | null): string | null {
  if (!section) return null;
  const lines = section.split('\n');
  let verifyStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\*\*Verify\*\*\s*:/.test(lines[i])) { verifyStart = i; break; }
  }
  if (verifyStart === -1) return null;
  // Collect verify blocks
  const out: string[] = [];
  const firstLine = lines[verifyStart].replace(/^\*\*Verify\*\*\s*:\s*/, '').trim();
  if (firstLine) out.push(firstLine);
  for (let i = verifyStart + 1; i < lines.length; i++) {
    const ln = lines[i];
    // Stop at the next bold field (**Xxx**:) or at the end of the next blank line
    if (/^\*\*\w+\*\*\s*:/.test(ln)) break;
    if (ln.trim() === '' && out.length > 0) {
      // Allow intermediate blank lines, but stop on bold after consecutive blank lines
      continue;
    }
    const bullet = ln.trim().replace(/^-\s*/, '');
    if (bullet) out.push(bullet);
  }
  return out.length > 0 ? out.join('; ') : null;
}

function renderFilesBlock(
  files:
    | {
        readonly modify: readonly string[];
        readonly create: readonly string[];
        readonly test: readonly string[];
      }
    | undefined,
): { modify: string; create: string; test: string } {
  const fmt = (arr: readonly string[] | undefined) =>
    arr && arr.length > 0 ? arr.join(', ') : '(not declared)';
  return {
    modify: fmt(files?.modify),
    create: fmt(files?.create),
    test: fmt(files?.test),
  };
}
