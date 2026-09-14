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

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { createClusterHandlers } from './cluster.js';
import type { StoryStore } from '../core/store.js';
import { reportHealthIssue } from '../core/health.js';
import { loadConfig } from '../core/config.js';
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
import { currentImplementationBusinessCommit, topologyDispatchBusinessAuthor } from '../core/topology-critic-receipt.js';
import { renderAgentLivenessGuidance } from '../core/agent-liveness-policy.js';
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

const IMPLEMENTER_COMMIT_AUTHOR = 'proof-or-stop-implementer <proof-or-stop-implementer@noreply.local>';

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

function appendImplementerCommitSteps(lines: string[], message: string): void {
  lines.push(`- git commit --author="${IMPLEMENTER_COMMIT_AUTHOR}" -m "${message.replace(/"/g, "'")}"`);
  lines.push('- Do not omit `--author`; normal-channel author fallback only accepts author=proof-or-stop-implementer.');
}

/**
 * B-9d95 CHK-004: Unified dispatch entry.
 *
 * story_dispatch / finding_dispatch / dispatch — these three entries share the same prompt assembly logic, avoiding
 * duplicate implementation. `dispatch` dispatches by itemId / findingId / clusterId; the old entries are kept as aliases,
 * with the first line of stdout printing a deprecation warning while return values remain byte-identical.
 */
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
    lines.push('  Poll the returned runId with `proof-or-stop host_run_status \'{"runId":"<runId>","afterGeneration":<generation>,"waitMs":30000,"json":true}\'`. A 30-second return or provider silence is not failure and never authorizes a replacement.');
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
      const implementation = currentImplementationBusinessCommit(root);
      return {
        headHash: snapshot.headHash,
        storyFilesHash: snapshot.storyFilesHash,
        businessCommit: implementation.businessCommit,
        businessCommitAuthor: topologyDispatchBusinessAuthor(root),
        businessCommitAuthorSource: 'git-var:GIT_AUTHOR_IDENT' as const,
      };
    } catch (error) {
      if (required) throw error;
      return {};
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
        `Must read: ${bgPath}`,
        `Must read: ${checklistPath}`,
        '',
        'Review focus:',
        '- Whether the background sufficiently explains the triggering event, key insights, trade-offs in the approach, and conversational texture',
        '- Whether the checklist is broken down into items that are user-observable, verifiable, and non-overlapping',
        '- Whether there are high-risk signals but insufficient PLAN/decision/verification preparation',
        '',
        renderAgentLivenessGuidance({ label: 'proof-or-stop-review-story-init/story', startSignal: 'INIT_REVIEW_START' }),
        '- After starting, first output `INIT_REVIEW_START`; after finishing reading background/checklist, output `INIT_REVIEW_READ_DONE`.',
        '- Within 5 minutes at the latest, you must choose one of two: call init_check_set, or output an explicit blocker + current blocking point.',
        '',
        'Hard requirements:',
        `- Regardless of whether the conclusion is pass or fail, you must call init_check_set once to record the result; merely outputting a textual conclusion does not count as complete.`,
        `- When issues are found, also call: proof-or-stop init_check_set '{"storyId":"${args.storyId}","issues":[{"severity":"low","desc":"..."}],"agentId":"proof-or-stop-review-story-init"}'`,
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
        `Must read: ${bgPath}`,
        `Required reading: ${checklistPath}`,
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
        '',
        renderAgentLivenessGuidance({ label: 'proof-or-stop-product-reviewer/story', startSignal: 'DISPATCH_START:proof-or-stop-product-reviewer/story' }),
        '',
        'Hard requirements:',
        '- Whether the conclusion is pass or fail, you must call init_check_set once to record the result; outputting only a text conclusion does not count as complete.',
        `- agentId must be passed exactly as "proof-or-stop-product-reviewer". Do not pass "proof-or-stop-review-story-init"; that is a different reviewer and will cause the INIT_CHECK gate to keep reporting a missing proof-or-stop-product-reviewer.`,
        '- INIT-blocking issue kinds are "requirements_ambiguous", "user_outcome_unspecified", "verification_plan_unexecutable", and "scope_or_safety_boundary_missing".',
        `- When issues are found, also call: proof-or-stop init_check_set '{"storyId":"${args.storyId}","issues":[{"kind":"user_outcome_unspecified","severity":"medium","desc":"..."}],"agentId":"proof-or-stop-product-reviewer"}'`,
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

    const lines: string[] = [];
    lines.push(`Review PLAN scope coverage for story ${args.storyId}.`);
    lines.push('');
    lines.push('You are the proof-or-stop-review-scope-plan reviewer; review in a fresh context and do not carry over the main agent\'s conclusions.');
    lines.push(`Working directory (subagent must cd here): ${root}`);
    lines.push('');
    appendDispatchLivenessGuidance(lines, 'proof-or-stop-review-scope-plan/story-scope');
    lines.push('Role boundary:');
    lines.push('- Review only; do not change code, tests, checklist items, plan text, or story metadata.');
    lines.push('- Dispatch output is not gate evidence; only scope_check_save writes the PLAN scope evidence consumed by story_review.');
    lines.push('');
    lines.push('Must read story artifacts:');
    lines.push(`1. ${bgPath}`);
    lines.push(`2. ${understandingPath}`);
    lines.push(`3. ${checklistPath}`);
    lines.push(`4. ${planPath}`);
    lines.push(`5. ${decisionPath} (if present)`);
    lines.push('- Also read relatedDocs referenced by checklist items and any decisions/docs cited by the story artifacts.');
    if (routed) {
      lines.push(`- Current bounded candidate artifact: digest=${routed.artifactDigest} corpusDigest=${routed.corpusDigest}`);
      lines.push(`- Fully inspect routed candidates as relevant: ${routed.candidateSpecSet.join(', ') || '(none)'}`);
      lines.push(`- Ambiguity signals: ${routed.ambiguitySignals.join(', ') || 'none'}; scanEscalationReason=${routed.scanEscalationReason ?? 'null'}`);
      lines.push(`- Routing escalation: requiresEscalation=${routed.requiresEscalation}; reasons=${routed.escalationReasons.join(', ') || 'none'}`);
      appendCandidateEscalationGuidance(lines, args.storyId, routed, true);
    } else {
      lines.push(candidateRoutingMode() === 'enforce'
        ? '- No candidate-spec-set artifact is present. STOP in enforce mode and ask the Story owner to run candidate_spec_route; reviewer lanes must not seize owner authority.'
        : `- No candidate-spec-set artifact is present. ${candidateRoutingMode()} mode records this without hard-blocking review.`);
    }
    lines.push('');
    lines.push('Review focus:');
    lines.push('- Identify every user-visible promise, scope constraint, exclusion, and acceptance expectation in the story artifacts.');
    lines.push('- Classify each feature as covered, excluded, gap, orphan-suspect, or drift using the scope_check_save schema.');
    lines.push('- Record open questions when the artifacts conflict or a promise is visible but cannot be safely classified.');
    lines.push('- Track readManifest with filesReadFully, filesTriagedByName, scanEscalationReason, candidateSpecSetDigest, and corpusDigest. Put full-read files in filesReadFully, filename/title-only triage in filesTriagedByName, and use scanEscalationReason only for a justified tool-driven full decisions-directory scan.');
    lines.push('');
    lines.push('For canonical process-fact topology refs, independently read every canonical paths entry of the selected process-fact rows in projectProcessFactRegistry. Supply ownerDispositions with exactly one path, disposition (modify, test, or unchanged), and substantive reason (at least 40 characters) per owner. Both understanding and checklist can omit the same owner: neither list is the completeness oracle. Unchanged means reviewed source sufficiency, not a requirement to edit every consulted file. Run under the registered scope role; the tool binds dispositions to current topology, source bytes, registry, declarations, and repository signing key.');
    lines.push('Finish by calling scope_check_save:');
    lines.push(`- proof-or-stop scope_check_save '{"storyId":"${args.storyId}","features":[{"feature":"<promise or constraint>","covered_by":"<CHK-xxx or null>","status":"covered|excluded|gap|orphan-suspect|drift","excluded_by":"<reason or null>","source":"<artifact path>"}],"summary":{"total":1,"covered":0,"excluded":0,"gaps":1},"readManifest":{"filesReadFully":["docs/requirements/decisions/<candidate>.md"],"filesTriagedByName":["docs/requirements/decisions/<triaged>.md"],"scanEscalationReason":null,"candidateSpecSetDigest":"${routed?.artifactDigest ?? '<current candidate artifact digest>'}","corpusDigest":"${routed?.corpusDigest ?? '<current corpus digest>'}"},"openQuestions":[]}'`);
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
      '',
      `Working directory (subagent must cd here): ${root}`,
      '',
    ];
    appendDispatchLivenessGuidance(lines, `${args.resolved.canonicalType}/story`);
    lines.push('Role boundary: review only; do not change code, tests, checklist status, or commits.');
    lines.push(`Required reading: ${store.storyDirRel()}/${args.storyId}/background.md, plan.md, checklist.json, and delivery-facing relatedDocs.`);
    lines.push('Formal native delivery evidence requires the registered host adapter to descriptor-inject the exact one-shot broker attestation for this dispatch. Without that broker integration, this review is advisory and delivery_check_set fails closed.');
    lines.push('Finish by calling delivery_check_set with the complete promise and evidence mapping; dispatch output alone is not delivery evidence.');
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
    lines.push('- Define adversarial acceptance intent only; do not implement, edit code/tests, or change checklist completion.');
    lines.push('- You may write only verificationIntent through checklist_update; do not write status, verificationEvidence, or checklist definition fields.');
    lines.push('');
    lines.push('Required reading:');
    lines.push(`1. ${storyDir}/background.md`);
    lines.push(`2. ${storyDir}/plan.md#${args.itemId}`);
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
  }): { prompt: string } {
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

      lines.push(`Severity: ${fSeverity}  Category: ${fCategory}  Reviewer: ${fReviewer}`);
      lines.push(`Description: ${fDesc}`);
      lines.push('');
      lines.push('After completion:');
      appendImplementerCommitSteps(lines, `${args.storyId} ${shortFid}: resolve finding`);
      lines.push(`- proof-or-stop finding_resolve '{"storyId":"${args.storyId}","findingId":"${finding.id}","resolution":"<your fix description>"}'`);

      return { prompt: lines.join('\n') };
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
      // B-9d95 CHK-001: inject worktree absolute path. Root cause retrospective (B-ed3e F-001): subagent inherits parent process cwd
      // which does not necessarily land in the worktree (especially cross-repo scenarios), causing reviewer/handler to read docs/story/... in the main repo cwd
      // failing to see the worktree copy and producing false reports. ctx.root is already bound to the worktree root at MCP handler initialization,
      // and is currently the most reliable absolute path source (better than process.cwd()—the latter depends on the caller's shell current directory).
      lines.push(`Working directory (subagent must cd here): ${root}`);
      lines.push('');
      appendDispatchLivenessGuidance(lines, `${resolvedAgent.canonicalType}/${args.itemId}`);
      lines.push('Required reading (in order):');
      let idx = 1;
      if (bgPolicy === 'required') {
        const prefix = bgExists ? '' : '⚠ missing, strongly recommend writing `proof-or-stop background_set` first — ';
        lines.push(`${idx}. Required reading background.md to understand intent — ${prefix}${bgPath}`);
        idx++;
      }
      const planRef = `${store.storyDirRel()}/${args.storyId}/plan.md#${args.itemId}`;
      lines.push(`${idx}. ${planRef}`);
      idx++;
      // relatedDocs append (dedupe: skip background.md / plan.md that already appeared earlier)
      const seen = new Set<string>([bgPath, planRef]);
      if (Array.isArray(item.relatedDocs) && item.relatedDocs.length > 0) {
        for (const doc of item.relatedDocs) {
          if (seen.has(doc)) continue;
          seen.add(doc);
          lines.push(`${idx}. ${doc}`);
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
      const routed = store.readCandidateSpecSet(args.storyId);
      if (routed) {
        lines.push('');
        lines.push(`Candidate routing: digest=${routed.artifactDigest} corpusDigest=${routed.corpusDigest} candidates=${routed.candidateSpecSet.join(', ') || '(none)'}`);
        lines.push(`Candidate escalation: requiresEscalation=${routed.requiresEscalation} reasons=${routed.escalationReasons.join(', ') || 'none'}`);
        appendCandidateEscalationGuidance(lines, args.storyId, routed, false);
      }
      lines.push('');
      lines.push('After completion:');
      appendImplementerCommitSteps(lines, `${args.storyId} ${args.itemId}: ${item.title}`);
      lines.push(`- proof-or-stop checklist_update '{"storyId":"${args.storyId}","itemId":"${args.itemId}","status":"done"}'`);

      // Use story.phase to eliminate unused variable warning (also convenient for reading context when extending CHK-008)
      void story;

      return { prompt: lines.join('\n') };
  }

  return {
    /**
     * dispatch — B-9d95 CHK-004 unified entry
     * (B-a4e3 CHK-005: the deprecated finding_dispatch / story_dispatch alias methods were removed;
     * dispatch is now the only entry. buildItemPrompt / buildFindingPrompt remain — they are used here.)
     *
     * The registry is the sole authority for phase, cardinality, prompt class,
     * and role. Validation completes before any prompt builder is selected.
     *
     * Mutual exclusion validation: exactly one of the three must be provided; more / fewer both throw Error.
     * Returns: { prompt: string } — byte-identical to the old entry (clusterId branch reuses cluster.ts text).
     */
    dispatch(args: {
      storyId: string;
      itemId?: string;
      findingId?: string;
      clusterId?: string;
      agentType?: string;
      reviewPurpose?: 'topology' | 'inventory-completeness';
      inventoryEpochId?: string;
    }): { prompt: string } {
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
              'Launch only against the OPEN inventory. After official finalization, consumers verify the sealed launch prompt and signed completed-wave subject; do not reconstruct a new OPEN prompt or rewrite the terminal evidence.',
              'A managed reviewer may start after an OPEN epoch cutoff when ancestry and both content hashes remain bound. Earlier-wave critic evidence is historical, not current authority; an older PASS is omitted from invalid only after its native or managed authority authenticates and a newer valid lane record (PASS or FINDING) exists. It never becomes current authority, and open findings remain blocking. Receipt tampering remains blocking.',
              'Evidence-only retention refuses commits that also flush pending inventory initialization or unrelated process facts; a writer label never grants authority over those additional changes.',
              'A verification refresh retains review only when requirements and the covered intent references, evidence kind and passing result stay unchanged from the original reviewed snapshot and both old and new execution proofs authenticate. New coverage or a changed result requires fresh independent review.',
              `First run proof-or-stop review_run_start '${JSON.stringify({ storyId: args.storyId, agent: canonicalType, reviewPurpose: args.reviewPurpose, inventoryEpochId: args.inventoryEpochId })}'.`,
              'Inspect every required-lane signed terminal/read record and every verified Finding on this exact cutoff. Report missed paths through finding_add or review_pass_set with complete read evidence.',
              `Then call proof-or-stop review_inventory_critic_set with storyId=${args.storyId}, epochId=${inventoryBinding.epochId}, the exact new reviewRunId and one independently justified findingDisposition per aggregate Finding. Empty dispositions are valid only for an empty set.`,
              'Do not call topology_critic_receipt_set or claim topology, TEST, DONE, dependency approval, or independent-host assurance from this inventory purpose.',
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
        const result = buildItemPrompt({
          storyId: args.storyId,
          itemId: args.itemId,
          agentType: canonicalType,
        });
        const wrapped = canonicalType === 'proof-or-stop-implementer'
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
        return result;
      }
      // clusterId branch — reuse cluster.ts's finding_dispatch (outputs string).
      // Wrap as { prompt } to keep the interface consistent.
      const clusterHandlers = createClusterHandlers(ctx);
      const clusterPrompt = clusterHandlers.finding_dispatch({
        storyId: args.storyId,
        clusterId: args.clusterId!,
      });
      const prompt = `${renderAgentLivenessGuidance({
        label: `${canonicalType}/${args.clusterId!}`,
        startSignal: `DISPATCH_START:${canonicalType}/${args.clusterId!}`,
      })}\n\n${clusterPrompt}`;
      appendDispatchEvent({
        storyId: args.storyId,
        agentType: canonicalType,
        targetKind: 'cluster',
        clusterId: args.clusterId!,
      });
      return { prompt };
    },
  };
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
