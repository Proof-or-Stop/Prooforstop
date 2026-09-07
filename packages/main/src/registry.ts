/**
 * Handler Registry — Proof-or-Stop 的工具注册中心
 *
 * 设计目的：让 main 暴露一个清晰的注册接口，外部包（如 @proof-or-stop/utils）
 * 可以把自己的 handler 通过 registry.register / registerBatch 注入进来，
 * 而 main 自身完全不知道这些扩展包的存在。
 *
 * main 的 proof-or-stop CLI 启动时会调用 createMainRegistry(ctx) 完成内置 handler 的注册；
 * 第三方 bootstrap 脚本可以在此基础上再调用扩展包的 register 函数追加注册。
 *
 * npm 的 executable identity 不在这里注册：`proof-or-stop` 是唯一 active bin，
 * 历史 `lattice` wrapper/path 兼容由各自的 filesystem/read fallback 负责。
 */

import { StoryStore } from './core/store.js';
import { join } from 'path';
import { loadConfig } from './core/config.js';
import type { HandlerContext } from './handlers/context.js';
import { createStoryHandlers } from './handlers/story.js';
import { createChecklistHandlers } from './handlers/checklist.js';
import { createFrozenClaimDriftCheckHandlers } from './handlers/frozen-claim-drift-check.js';
import { createBugHandlers } from './handlers/bug.js';
import { createFixtureHandlers } from './handlers/fixture.js';
import { createTestAutoHandlers } from './handlers/test-auto.js';
import { createTestStoryHandlers } from './handlers/test-story.js';
import { createTestFixtureHandlers } from './handlers/test-fixture.js';
import { createWorktreeHandlers } from './handlers/worktree.js';
import { createUnderstandingHandlers } from './handlers/understanding.js';
import { createDecisionHandlers } from './handlers/decision.js';
import { createGrillHandlers } from './handlers/grill.js';
import { createSummaryHandlers } from './handlers/summary.js';
import { createDoctorHandlers } from './handlers/doctor.js';
import { createSessionHandlers } from './handlers/session.js';
import { createTestHandlers } from './handlers/test.js';
import { createTaskHandlers } from './handlers/task.js';
import { createTruthHandlers } from './handlers/truth.js';
import { createGapHandlers } from './handlers/gap.js';
import { createVerifierHandlers } from './handlers/verifier.js';
import { createGraphHandlers } from './handlers/graph.js';
import { createFindingHandlers } from './handlers/finding.js';
import { createEvaluateHandlers } from './handlers/evaluate.js';
import { createWorkflowHandlers } from './handlers/workflow.js';
import { createScopeCheckHandlers } from './handlers/scope-check.js';
import { createInitCheckHandlers } from './handlers/init-check.js';
import { createStallAdjudicationHandlers } from './handlers/stall-adjudication.js';
import { createScopeQuestionResolveHandlers } from './handlers/scope-question-resolve.js';
import { createStoryDispatchHandlers } from './handlers/story-dispatch.js';
import { createBackgroundHandlers } from './handlers/background.js';
import { createPlanHandlers } from './handlers/plan.js';
import { createAuditHandlers } from './handlers/audit.js';
import { createClusterHandlers } from './handlers/cluster.js';
import { createReviewerListHandlers } from './handlers/reviewer-list.js';
import { createReviewIncrementalContextHandlers } from './handlers/review-incremental-context.js';
import { createValidationPlanHandlers } from './handlers/validation-plan.js';
import { createStoryDraftHandlers } from './handlers/story-draft.js';
import { createDraftCheckHandlers } from './handlers/draft-check.js';
import { createDeliveryCheckHandlers } from './handlers/delivery-check.js';
import { createCertificationWindowHandlers } from './handlers/certification-window.js';
import { createReviewInventoryHandlers } from './handlers/review-inventory.js';
import { createTestIntentHandoffHandlers } from './handlers/testintent-handoff.js';
import { createAuxDocHandlers } from './handlers/aux-doc.js';
import { createCodexAdapterHandlers } from './handlers/codex-adapter.js';
import { createReviewRunHandlers } from './handlers/review-run.js';
import { createReviewLoopHandlers } from './handlers/review-loop.js';
import { createCheckHandlers } from './handlers/check.js';
import { createRecoverEvidenceHandlers } from './handlers/recover-evidence.js';
import { createArtifactDeclareHandlers } from './handlers/artifact-declare.js';
import { createArtifactReleaseHandlers } from './handlers/artifact-release.js';
import { createCapabilityReleaseHandlers } from './handlers/capability-release.js';
import { createCapabilityReleaseBackfillHandlers } from './handlers/capability-release-backfill.js';
import { createGapLogHandlers } from './handlers/gap-log.js';
import { createDoneRecoverHandlers } from './handlers/done-recover.js';
import { createDoneClosureHandlers } from './handlers/done-closure.js';
import { createDonePrepareHandlers } from './handlers/done-prepare.js';
import { createDoneRequiredValidationHandlers } from './handlers/done-required-validation.js';
import { createLifecycleCheckHandlers } from './handlers/lifecycle-check.js';
import { createMilestoneStatusHandlers } from './handlers/milestone-status.js';
import { createLifecycleControlHandlers } from './handlers/lifecycle-control.js';
import { createPlanSkeletonHandlers } from './handlers/plan-skeleton.js';
import { createEvidencePlanHandlers } from './handlers/evidence-plan.js';
import { createInitPreflightHandlers } from './handlers/init-preflight.js';
import { createReviewerBatchHandlers } from './handlers/reviewer-batch.js';
import { createEvidenceRefreshHandlers } from './handlers/evidence-refresh.js';
import { createLiveSmokeTranscriptHandlers } from './handlers/live-smoke-transcript.js';
import { createDeliveryContextPackHandlers } from './handlers/delivery-context-pack.js';
import { createLifecycleOrchestrateHandlers } from './handlers/lifecycle-orchestrate.js';
import { createDecisionDocQuorumHandlers } from './handlers/decision-doc-quorum.js';
import { createDecisionDocPromotionHandlers } from './handlers/decision-doc-promotion.js';
import { createSignatureRegistryHandlers } from './handlers/signature-registry.js';
import { createSignatureBackfillHandlers } from './handlers/signature-backfill.js';
import { createPlaybookHandlers } from './handlers/playbook.js';
import { createRecallHandlers } from './handlers/recall.js';
import { createLearningScanHandlers } from './handlers/learning-scan.js';
import { createLearningValidateHandlers } from './handlers/learning-validate.js';
import { createLearningEffectivenessHandlers } from './handlers/learning-effectiveness.js';
import { createReviewEscalationHandlers } from './handlers/review-escalation.js';
import { createVerificationContextPackHandlers } from './handlers/verification-context-pack.js';
import { createCapsuleHandlers } from './handlers/capsule.js';
import { createScopeAntiExpansionHandlers } from './handlers/scope-anti-expansion.js';
import { createScopeContractHandlers } from './handlers/scope-contract.js';
import { createProofStoryHandlers } from './handlers/proofstory.js';
import { createParentRoadmapHandlers } from './handlers/parent-roadmap.js';
import { createGuardSessionHandlers } from './handlers/guard-session.js';
import { createDevMemoryHandlers } from './handlers/dev-memory.js';
import { createReproIntakeHandlers } from './handlers/repro-intake.js';
import { createMemoryBenchmarkHandlers } from './handlers/memory-benchmark.js';
import { createPinnClaimAdmissibilityHandlers } from './handlers/pinn-claim-admissibility.js';
import { createQuantumClaimAdmissibilityHandlers } from './handlers/quantum-claim-admissibility.js';
import { createPlaybookRuntimeMemoryHandlers } from './handlers/playbook-runtime-memory.js';
import { createCapabilityListHandlers } from './handlers/capability-list.js';
import { createAgentPromptHandlers } from './handlers/agent-prompt.js';
import { createPromptMeasurementHandlers } from './handlers/prompt-measurement.js';
import { createStoryExportHandlers } from './handlers/story-export.js';
import { createProofOrStopHandoffHandlers } from './handlers/proof-or-stop-handoff.js';
import { createProofOrStopDispatchHandlers } from './handlers/proof-or-stop-dispatch.js';
import { createProofOrStopAutopilotHandlers } from './handlers/proof-or-stop-autopilot.js';
import { createProofOrStopEvidenceHandlers } from './handlers/proof-or-stop-evidence.js';
import { createProofOrStopParallelWaveHandlers } from './handlers/proof-or-stop-parallel-wave.js';
import { createProofOrStopBaselineHandlers } from './handlers/proof-or-stop-baseline.js';
import { createProofOrStopCliHandlers } from './handlers/proof-or-stop-cli.js';
import { createRolloutCheckHandlers } from './handlers/rollout-check.js';
import { createObservabilitySnapshotHandlers } from './handlers/observability-snapshot.js';
import { createPrewriteGuardHandlers } from './handlers/prewrite-guard.js';
import { createEvidencePinGuardHandlers } from './handlers/evidence-pin-guard.js';
import { createReleaseHandlers } from './handlers/release.js';
import { createAutopilotHandlers } from './handlers/autopilot.js';
import { createPlannerHandlers } from './handlers/planner.js';
import { createStoryResolveHandlers } from './handlers/story-resolve.js';
import { createVerdictHandlers } from './handlers/verdict.js';
import { createQuorumSubmitHandlers } from './handlers/quorum-submit.js';
import { createCrossHostReviewHandlers } from './handlers/cross-host-review.js';
import { createHostRunHandlers } from './handlers/host-run.js';
import { createUsageSweepHandlers } from './handlers/usage-sweep.js';
import { createCandidateSpecRoutingHandlers } from './handlers/candidate-spec-routing.js';
import { createBaselineHandlers } from './handlers/baseline.js';
import { createBaselineSuiteHandlers } from './handlers/baseline-suite.js';
import { createRedEvidenceHandlers } from './handlers/red-evidence.js';
import { createFindingLedgerHandlers } from './handlers/finding-ledger.js';
import { createFindingRuntimeEvidenceHandlers } from './handlers/finding-runtime-evidence.js';
import { createIdentityStateMigrateHandlers } from './handlers/identity-state-migrate.js';
import { nextStoryId } from './handlers/context.js';
import { readBrandEnv } from './core/brand-env.js';
import { createProofOrStopExtensionRuntime } from './core/extension-runtime.js';

export type HandlerFn = (...args: any[]) => any;

/** 工具注册中心：name → handler 的映射 + 注入接口 */
export class Registry {
  private handlers = new Map<string, HandlerFn>();

  register(name: string, fn: HandlerFn): void {
    if (this.handlers.has(name)) {
      throw new Error(`Handler already registered: ${name}`);
    }
    this.handlers.set(name, fn);
  }

  registerBatch(map: Record<string, HandlerFn>): void {
    for (const [name, fn] of Object.entries(map)) this.register(name, fn);
  }

  registerBatchMissing(map: Record<string, HandlerFn>): void {
    for (const [name, fn] of Object.entries(map)) {
      if (!this.handlers.has(name)) this.register(name, fn);
    }
  }

  /** 允许覆盖已存在的 handler（用于测试桩 / 替换内置实现） */
  override(name: string, fn: HandlerFn): void {
    this.handlers.set(name, fn);
  }

  get(name: string): HandlerFn | undefined { return this.handlers.get(name); }
  has(name: string): boolean { return this.handlers.has(name); }
  list(): string[] { return [...this.handlers.keys()]; }

  /** 平铺成对象，主要给 fixture runner 的 $handlers 注入用 */
  toObject(): Record<string, HandlerFn> {
    return Object.fromEntries(this.handlers);
  }
}

/**
 * 创建 main 内置的 Registry，只注册流程相关的 handler。
 *
 * 辅助工具（aux/truth/gap 等）已移到 @proof-or-stop/utils 包，
 * 由 bootstrap 脚本调用 utils 的 register() 函数追加注入。
 */
export function createMainRegistry(ctx: HandlerContext): Registry {
  ctx.extensionRuntime ??= createProofOrStopExtensionRuntime();
  const registry = new Registry();

  registry.registerBatch(createStoryHandlers(ctx));
  registry.registerBatch(createChecklistHandlers(ctx));
  // B-2296 CHK-003: read-only, non-blocking FROZEN_CLAIM_DRIFT advisory surface.
  registry.registerBatch(createFrozenClaimDriftCheckHandlers(ctx));
  registry.registerBatch(createBugHandlers(ctx));
  registry.registerBatch(createFixtureHandlers(ctx));
  registry.registerBatch(createTestAutoHandlers(ctx));
  registry.registerBatch(createTestStoryHandlers(ctx));
  registry.registerBatch(createTestFixtureHandlers(ctx));
  registry.registerBatch(createWorktreeHandlers(ctx));
  registry.registerBatch(createUnderstandingHandlers(ctx));
  registry.registerBatch(createDecisionHandlers(ctx));
  registry.registerBatch(createGrillHandlers(ctx));
  registry.registerBatch(createSummaryHandlers(ctx));
  registry.registerBatch(createDoctorHandlers(ctx));
  registry.registerBatch(createSessionHandlers(ctx));
  registry.registerBatch(createTestHandlers(ctx));
  registry.registerBatch(createTaskHandlers(ctx));
  registry.registerBatch(createTruthHandlers(ctx));
  registry.registerBatch(createGapHandlers(ctx));
  registry.registerBatch(createVerifierHandlers(ctx));
  // B-3e16 CHK-003: graph is a NORMAL registered handler (like the long-running
  // serve), not a dashboard-style standalone branch, so the command-ownership
  // dispatchability assertion keeps covering it with no new exemption.
  registry.registerBatch(createGraphHandlers(ctx));
  registry.registerBatch(createReviewRunHandlers(ctx));
  registry.registerBatch(createReviewInventoryHandlers(ctx));
  registry.registerBatch(createReviewLoopHandlers(ctx));
  registry.registerBatch(createFindingHandlers(ctx));
  const findingLedgerHandlers = createFindingLedgerHandlers(ctx);
  registry.register('finding_ledger_query', findingLedgerHandlers.finding_ledger_query);
  registry.registerBatch(createFindingRuntimeEvidenceHandlers(ctx));
  registry.registerBatch(createEvaluateHandlers(ctx));
  registry.registerBatch(createWorkflowHandlers(ctx));
  registry.registerBatch(createScopeCheckHandlers(ctx));
  // B-e71f CHK-003: init_check_set — INIT→INIT_CHECK 硬门槛产物 init-check.json 写入
  registry.registerBatch(createInitCheckHandlers(ctx));
  registry.registerBatch(createStallAdjudicationHandlers(ctx));
  registry.registerBatch(createScopeQuestionResolveHandlers(ctx));
  registry.registerBatch(createStoryDispatchHandlers(ctx));
  registry.registerBatch(createBackgroundHandlers(ctx));
  registry.registerBatch(createPlanHandlers(ctx));
  registry.registerBatch(createAuditHandlers(ctx));

  // B-9d95 CHK-005: 只 wire `finding_cluster`。createClusterHandlers 同时导出 `finding_dispatch`，
  // 但那是 dispatch({clusterId}) 分支的内部实现，已由 story-dispatch.ts 的 finding_dispatch / dispatch
  // 代理注册，此处重复 register 会触发 Registry 同名冲突。
  const clusterHandlers = createClusterHandlers(ctx);
  registry.register('finding_cluster', clusterHandlers.finding_cluster);

  // B-fdcf CHK-001: reviewer_list CLI wire（按 riskSignals / touchpoints 实时计算）
  registry.registerBatch(createReviewerListHandlers(ctx));

  // B-f675 CHK-002: review_incremental_context — read-only reviewer incremental
  // context (prior verdict + since-last-pass diff + scopeChanged). No writes.
  registry.registerBatch(createReviewIncrementalContextHandlers(ctx));

  // B-a745 CHK-005: validation_plan — read-only Story-relevance validation
  // planner (explain-only). Executes nothing and writes nothing.
  registry.registerBatch(createValidationPlanHandlers(ctx));

  // B-9975 CHK-001: story_draft / story_draft_list / story_draft_discard
  registry.registerBatch(createStoryDraftHandlers(ctx));

  // B-9975 CHK-002: draft_check_set / draft_issue_resolve
  registry.registerBatch(createDraftCheckHandlers(ctx));

  // B-35ed CHK-001: delivery_check_set — TEST→DONE 硬门槛产物 delivery-check.json 写入
  registry.registerBatch(createDeliveryCheckHandlers(ctx));

  // B-1e1f CHK-001: PRE_CERT CertificationWindow begin/status/cancel
  registry.registerBatch(createCertificationWindowHandlers(ctx));

  // B-3749 CHK-002: PLAN handoff package for test-intent agents.
  registry.registerBatch(createTestIntentHandoffHandlers(ctx));
  registry.registerBatch(createAuxDocHandlers(ctx));
  registry.registerBatch(createCodexAdapterHandlers(ctx));
  registry.registerBatch(createCheckHandlers(ctx));

  // B-a2f1 CHK-003: recover_evidence — single-shot stale-evidence recovery
  // (refuse-on-non-metadata-dirt → verification_evidence_refresh_stale → proof-or-stop validate).
  registry.registerBatch(createRecoverEvidenceHandlers(ctx));

  // B-cf60: artifact_declare — per-story declared product artifact registration.
  // Populates declared-artifacts.json consumed by the dirty-worktree classifier
  // and the DONE gate reference check.
  registry.registerBatch(createArtifactDeclareHandlers(ctx));
  registry.registerBatch(createArtifactReleaseHandlers(ctx));
  registry.registerBatch(createCapabilityReleaseHandlers(ctx));
  registry.registerBatch(createCapabilityReleaseBackfillHandlers(ctx));

  // B-3fad CHK-002: gap_log — 框架 gap 手动归档入口。
  // 写 B-META-framework-audit findings（不存在则 ensureMetaStory bootstrap）；
  // 不依赖 reviewer / review round / story worktree，不参与 lifecycle gate。
  registry.registerBatch(createGapLogHandlers(ctx));

  // B-4c38 CHK-003: done_recover — explicit recovery for partial-DONE stories
  // whose phase was persisted but whose branch did not merge back to main.
  registry.registerBatch(createDoneRecoverHandlers(ctx));
  registry.registerBatch(createDoneClosureHandlers(ctx));
  registry.registerBatch(createDonePrepareHandlers(ctx));
  registry.registerBatch(createDoneRequiredValidationHandlers(ctx));
  registry.registerBatch(createLifecycleCheckHandlers(ctx));
  registry.registerBatch(createMilestoneStatusHandlers(ctx));
  registry.registerBatch(createLifecycleControlHandlers(ctx));
  registry.registerBatch(createPlanSkeletonHandlers(ctx));
  // B-09e7 (P3): evidence_plan — read-only DRY planner classifying verification
  // intent evidence into missing/rerun/refresh-only/fresh. Runs no commands,
  // writes no evidence/metadata (the actual refresh is the P4 layer).
  registry.registerBatch(createEvidencePlanHandlers(ctx));
  // B-62c8: init_preflight — read-only INIT→INIT_CHECK prerequisite surveyor.
  // Probes EACH prerequisite independently (never fail-fast) and echoes the
  // AUTHORITATIVE INIT_CHECK gate verdict via getGuardFailureReason. Runs no commands,
  // writes no evidence/metadata, advances no phase.
  registry.registerBatch(createInitPreflightHandlers(ctx));
  // P7: reviewer_batch — read-only reviewer-launcher PLAN producer. Classifies
  // each active review lane (current-pass / scope-changed / no-receipt / blocking)
  // from existing facts and emits the Agent(...) launch instruction (the
  // orchestrator subagent-spawn form, not a dispatch CLI command) + REVIEW gate
  // status. Launches no reviewer, runs no review_run_start, writes no evidence.
  registry.registerBatch(createReviewerBatchHandlers(ctx));
  // B-4896 (P4): evidence_refresh — opt-in one-pass refresh-only orchestrator.
  // Dry default previews the refresh-only bucket (read-only). --apply performs
  // AT MOST ONE re-stamp pass via the existing verification_evidence_refresh_stale
  // writer, then re-reads + reclassifies: fresh→refreshed, still-stale→escalated
  // (rerun_required / hard_stale). Never runs a command, advances phase, launches
  // reviewers, or claims Authority. --apply is ownership/scope gated by the CLI gate.
  registry.registerBatch(createEvidenceRefreshHandlers(ctx));
  // B-9b5e (P5): live_smoke_transcript — explicit live-smoke transcript producer.
  // Read-only status default consumes the V1 readiness live-smoke row + userSees.
  // --capture runs ONLY the one provided command (independent of --write); --write
  // persists the expected-vs-actual artifact (ownership/scope gated). Never advances
  // phase, launches reviewers, claims Authority, writes verificationEvidence/delivery
  // checks, or accepts a metadata-only waiver.
  registry.registerBatch(createLiveSmokeTranscriptHandlers(ctx));
  // P6: delivery_context_pack — delivery-review context PRODUCER (NOT a signer).
  // Read-only default gathers/prints the delivery context pack (diff vs main,
  // docs-promises, real-machine test refs, validation/review state) and CONSUMES
  // the V1 readiness deliveryCheckRef. --write persists the pack artifact only
  // (ownership/scope gated). It never writes delivery-check.json, calls the
  // delivery-check setter, accepts a metadata-only waiver, runs a command, advances
  // phase, launches reviewers, writes verificationEvidence, or claims Authority.
  registry.registerBatch(createDeliveryContextPackHandlers(ctx));
  // P8 (CAPSTONE): lifecycle_orchestrate — read-only top-level lifecycle
  // orchestration. COMPOSES the prior read-only layers (V1 readiness + P2-P7)
  // into ONE consolidated, phase-aware view: it calls each prior handler's
  // READ-ONLY DEFAULT path ({ storyId, json:true }) — never a write/apply/capture
  // flag — selects the phase-relevant subset (PLAN→plan_skeleton; intents→
  // evidence_plan + evidence_refresh dry; REVIEW→reviewer_batch; TEST/delivery→
  // live_smoke_transcript status + delivery_context_pack default), consolidates
  // blockers + next actions from the V1 readiness rows, and EMITS the next
  // story_advance command as a PRINTED string (executed:false — never run). It
  // runs no command, writes no evidence/metadata/artifact, launches no reviewer,
  // advances no phase, and never claims Authority/production.
  registry.registerBatch(createLifecycleOrchestrateHandlers(ctx));
  registry.registerBatch(createDecisionDocQuorumHandlers(ctx));
  registry.registerBatch(createDecisionDocPromotionHandlers(ctx));

  // B-4f46 CHK-003: signature_registry_list / signature_registry_set — audit-only
  // catalog of finding signatureTags (Experience Layer Phase 1b). No gate reads it.
  registry.registerBatch(createSignatureRegistryHandlers(ctx));
  // B-17a9 (Experience Layer): signature_backfill — WRITING command that fills empty
  // finding signatureTags from a committed map (source='backfill'); dry-run default.
  // Writes audit-only fields after _hash; never recomputes _hash; no gate reads it.
  registry.registerBatch(createSignatureBackfillHandlers(ctx));
  // B-8387/B-cc94 (Experience Layer): staged Process Playbook lifecycle
  // (playbook_propose/diff/approve/activate/reject). Never files findings /
  // touches gates; writes only under .proof-or-stop/learning/. Approve/activate fail
  // closed on stale digests.
  registry.registerBatch(createPlaybookHandlers(ctx));
  registry.registerBatch(createRecallHandlers(ctx));
  // B-4eb6 (Experience Layer ③.1): learning_scan derives + PERSISTS the advisory
  // finding-signals cache under .proof-or-stop/learning/ that the Phase 1.5 hint loader
  // reads. Writing (not read-only); files no findings / touches no gate.
  registry.registerBatch(createLearningScanHandlers(ctx));
  registry.registerBatch(createLearningValidateHandlers(ctx));
  registry.registerBatch(createLearningEffectivenessHandlers(ctx));
  registry.registerBatch(createReviewEscalationHandlers(ctx));
  registry.registerBatch(createVerificationContextPackHandlers(ctx));
  registry.registerBatch(createCapsuleHandlers(ctx));

  // B-85ba CHK-002: INIT scope anti-expansion CLI surface.
  registry.registerBatch(createScopeAntiExpansionHandlers(ctx));

  // B-be27: scope contract — scope_contract_set/show/check/acknowledge
  registry.registerBatch(createScopeContractHandlers(ctx));

  // B-7287 M0-M2: ProofStory progressive intent hardening diagnostics only.
  // ProofStory handlers also own the registered acceptance-basis verifier
  // writer, its read-only verifier projection, and acceptance_topology_check.
  // The latter shares the canonical evaluator with PLAN→DEV; discovery adapter
  // selection remains fixed in core/acceptance-discovery-adapters, never caller supplied.
  registry.registerBatch(createProofStoryHandlers(ctx));
  registry.registerBatch(createParentRoadmapHandlers(ctx));

  // B-6bfd CHK-004: guard session projection — guard_session_start/status/check
  registry.registerBatch(createGuardSessionHandlers(ctx));

  // B-ad2c: dev_memory_* — lightweight experience capture outside Proof-or-Stop story gates.
  // Non-authoritative: entries cannot satisfy Proof-or-Stop DONE gate evidence.
  registry.registerBatch(createDevMemoryHandlers(ctx));

  // B-0aa1: repro-first candidate-only evidence intake MVP.
  // All commands produce evidence-candidate artifacts; not production/DONE evidence.
  registry.registerBatch(createReproIntakeHandlers(ctx));

  // B-d4dd/B-2a63: deterministic virtual benchmark + real-data export baseline harnesses.
  registry.registerBatch(createMemoryBenchmarkHandlers(ctx));
  registry.registerBatch(createPinnClaimAdmissibilityHandlers(ctx));
  registry.registerBatch(createQuantumClaimAdmissibilityHandlers(ctx));
  registry.registerBatch(createPlaybookRuntimeMemoryHandlers(ctx));

  // Host-neutral capability discovery for Proof-or-Stop adapters.
  registry.registerBatch(createCapabilityListHandlers());

  // B-097f/B-235e: agent_prompt returns the canonical package-registry host
  // render. The six migrated reviewer definitions keep modular bodies; the five
  // active REVIEW lanes receive a body-free review_run_start bootstrap, while
  // topology-critic receives its ordinary role body. review_run_start alone
  // supplies one selected legacy/modular reviewer body for those five lanes.
  registry.registerBatch(createAgentPromptHandlers(ctx));
  registry.registerBatch(createPromptMeasurementHandlers());

  // Proof-or-Stop productized export and cross-host handoff surfaces.
  registry.registerBatch(createProofOrStopCliHandlers(ctx));
  registry.registerBatch(createProofOrStopAutopilotHandlers(ctx));
  // Autopilot projection/executor surfaces (autopilot_run/status/execute/doctor).
  //
  // createProofOrStopAutopilotHandlers owns the shipped autopilot policy engine.
  // createAutopilotHandlers contributes only names that are not already present.
  registry.registerBatchMissing(createAutopilotHandlers(ctx));
  registry.registerBatch(createPlannerHandlers(ctx));
  registry.registerBatch(createStoryResolveHandlers(ctx));
  registry.registerBatch(createVerdictHandlers(ctx));
  registry.registerBatch(createQuorumSubmitHandlers(ctx));
  registry.registerBatch(createCrossHostReviewHandlers(ctx));
  registry.registerBatch(createHostRunHandlers(ctx));
  registry.registerBatch(createCandidateSpecRoutingHandlers(ctx));
  registry.registerBatch(createUsageSweepHandlers(ctx));
  registry.registerBatch(createBaselineHandlers(ctx));
  registry.registerBatch(createBaselineSuiteHandlers(ctx));
  registry.registerBatch(createRolloutCheckHandlers(ctx));
  registry.registerBatch(createStoryExportHandlers(ctx));
  registry.registerBatch(createObservabilitySnapshotHandlers(ctx));
  registry.registerBatch(createProofOrStopHandoffHandlers(ctx));
  registry.registerBatch(createProofOrStopDispatchHandlers(ctx));
  registry.registerBatch(createProofOrStopEvidenceHandlers(ctx));
  registry.registerBatch(createProofOrStopParallelWaveHandlers(ctx));
  registry.registerBatchMissing(createProofOrStopBaselineHandlers(ctx));

  // W2b (B-e10d): red_evidence_binding_set — the trusted RED-evidence
  // subsystem's first mutating command. Owner-lease + mutation-authority gated;
  // registers the per-story target binding (§1.1.3) before a RED run.
  // W2c (B-506e) adds red_evidence_quarantine / red_evidence_recover (the two
  // owner-gated chain-control appends) to the SAME batch — auto-registered here.
  // W2d (B-9ff1) adds the READ-ONLY red_evidence_envelope_check: a §1.1 envelope
  // admissibility pre-flight that executes no envelope. Canonical scope
  // sentence, used verbatim at every site that states this guarantee: Scoped to
  // the command handler itself and the CLI story-evidence writers, it writes no
  // RED-evidence record, chain record or story/evidence artifact, emits no
  // process event, changes no gate verdict, and runs no preCommand or
  // postCommand hook. Nothing outside that scope is covered: see the
  // red_evidence_envelope_check note in cli/activity-policy.ts, which lists the
  // surfaces known when it was written and is not a proof of exhaustiveness.
  registry.registerBatch(createRedEvidenceHandlers(ctx));
  registry.registerBatch(createIdentityStateMigrateHandlers(ctx));

  // prewrite scope enforcement — pre-tool hook guard for write-like operations
  registry.registerBatch(createPrewriteGuardHandlers(ctx));

  // B-1507 CHK-003: fail-open evidence-pin seatbelt for shell-tool PreToolUse hooks
  registry.registerBatch(createEvidencePinGuardHandlers(ctx));

  // Remote publish approval is local-only: it writes a one-shot pre-push token,
  // never performs the push itself.
  registry.registerBatch(createReleaseHandlers(ctx));

  // 内部辅助：返回下一个 story id（fixture/测试 runner 用）
  registry.register('_nextStoryId', (prefix?: string) => nextStoryId(ctx.store, prefix));

  // 注入延迟获取器：让 story gate 能拿到完整工具名（避免循环依赖）
  ctx.getAllToolNames = () => new Set(registry.list());

  return registry;
}

/**
 * Legacy 入口：保留以兼容旧代码路径。
 * 新代码请用 createMainRegistry。
 */
export function createToolHandlers(store: StoryStore, projectRoot?: string, log?: (msg: string) => void) {
  const root = projectRoot || readBrandEnv('PROJECT_ROOT') || process.cwd();
  const config = loadConfig(root);
  const scanRoot = join(root, config.scanRoot);
  const ctx: HandlerContext = { store, root, scanRoot, log };
  return createMainRegistry(ctx).toObject();
}
