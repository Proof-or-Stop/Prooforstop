/**
 * Handler Registry — koala 的工具注册中心
 *
 * 设计目的：让 main 暴露一个清晰的注册接口，外部包（如 @koala-agent/utils）
 * 可以把自己的 handler 通过 registry.register / registerBatch 注入进来，
 * 而 main 自身完全不知道这些扩展包的存在。
 *
 * main 的 cli.ts 启动时会调用 createMainRegistry(ctx) 完成内置 handler 的注册；
 * 第三方 bootstrap 脚本可以在此基础上再调用扩展包的 register 函数追加注册。
 */

import { StoryStore } from './core/store.js';
import { join } from 'path';
import { loadConfig } from './core/config.js';
import type { HandlerContext } from './handlers/context.js';
import { createStoryHandlers } from './handlers/story.js';
import { createChecklistHandlers } from './handlers/checklist.js';
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
import { createFindingHandlers } from './handlers/finding.js';
import { createEvaluateHandlers } from './handlers/evaluate.js';
import { createWorkflowHandlers } from './handlers/workflow.js';
import { createScopeCheckHandlers } from './handlers/scope-check.js';
import { createInitCheckHandlers } from './handlers/init-check.js';
import { createScopeQuestionResolveHandlers } from './handlers/scope-question-resolve.js';
import { createStoryDispatchHandlers } from './handlers/story-dispatch.js';
import { createBackgroundHandlers } from './handlers/background.js';
import { createPlanHandlers } from './handlers/plan.js';
import { createAuditHandlers } from './handlers/audit.js';
import { createClusterHandlers } from './handlers/cluster.js';
import { createReviewerListHandlers } from './handlers/reviewer-list.js';
import { createStoryDraftHandlers } from './handlers/story-draft.js';
import { createDraftCheckHandlers } from './handlers/draft-check.js';
import { createDeliveryCheckHandlers } from './handlers/delivery-check.js';
import { createTestIntentHandoffHandlers } from './handlers/testintent-handoff.js';
import { createAuxDocHandlers } from './handlers/aux-doc.js';
import { createCodexAdapterHandlers } from './handlers/codex-adapter.js';
import { createReviewRunHandlers } from './handlers/review-run.js';
import { createCheckHandlers } from './handlers/check.js';
import { createRecoverEvidenceHandlers } from './handlers/recover-evidence.js';
import { createArtifactDeclareHandlers } from './handlers/artifact-declare.js';
import { createGapLogHandlers } from './handlers/gap-log.js';
import { createDoneRecoverHandlers } from './handlers/done-recover.js';
import { createVerificationContextPackHandlers } from './handlers/verification-context-pack.js';
import { createCapsuleHandlers } from './handlers/capsule.js';
import { createScopeContractHandlers } from './handlers/scope-contract.js';
import { createGuardSessionHandlers } from './handlers/guard-session.js';
import { createAuthorityEnforceHandlers } from './handlers/authority-enforce.js';
import { createDevMemoryHandlers } from './handlers/dev-memory.js';
import { nextStoryId } from './handlers/context.js';

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
 * 辅助工具（aux/truth/gap 等）已移到 @koala-agent/utils 包，
 * 由 bootstrap 脚本调用 utils 的 register() 函数追加注入。
 */
export function createMainRegistry(ctx: HandlerContext): Registry {
  const registry = new Registry();

  registry.registerBatch(createStoryHandlers(ctx));
  registry.registerBatch(createChecklistHandlers(ctx));
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
  registry.registerBatch(createReviewRunHandlers(ctx));
  registry.registerBatch(createFindingHandlers(ctx));
  registry.registerBatch(createEvaluateHandlers(ctx));
  registry.registerBatch(createWorkflowHandlers(ctx));
  registry.registerBatch(createScopeCheckHandlers(ctx));
  // B-e71f CHK-003: init_check_set — INIT→INIT_CHECK 硬门槛产物 init-check.json 写入
  registry.registerBatch(createInitCheckHandlers(ctx));
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

  // B-9975 CHK-001: story_draft / story_draft_list / story_draft_discard
  registry.registerBatch(createStoryDraftHandlers(ctx));

  // B-9975 CHK-002: draft_check_set / draft_issue_resolve
  registry.registerBatch(createDraftCheckHandlers(ctx));

  // B-35ed CHK-001: delivery_check_set — TEST→DONE 硬门槛产物 delivery-check.json 写入
  registry.registerBatch(createDeliveryCheckHandlers(ctx));

  // B-3749 CHK-002: PLAN handoff package for test-intent agents.
  registry.registerBatch(createTestIntentHandoffHandlers(ctx));
  registry.registerBatch(createAuxDocHandlers(ctx));
  registry.registerBatch(createCodexAdapterHandlers(ctx));
  registry.registerBatch(createCheckHandlers(ctx));

  // B-a2f1 CHK-003: recover_evidence — single-shot stale-evidence recovery
  // (refuse-on-non-metadata-dirt → verification_evidence_refresh_stale → koala validate).
  registry.registerBatch(createRecoverEvidenceHandlers(ctx));

  // B-cf60: artifact_declare — per-story declared product artifact registration.
  // Populates declared-artifacts.json consumed by the dirty-worktree classifier
  // and the DONE gate reference check.
  registry.registerBatch(createArtifactDeclareHandlers(ctx));

  // B-3fad CHK-002: gap_log — 框架 gap 手动归档入口。
  // 写 B-META-framework-audit findings（不存在则 ensureMetaStory bootstrap）；
  // 不依赖 reviewer / review round / story worktree，不参与 lifecycle gate。
  registry.registerBatch(createGapLogHandlers(ctx));

  // B-4c38 CHK-003: done_recover — explicit recovery for partial-DONE stories
  // whose phase was persisted but whose branch did not merge back to main.
  registry.registerBatch(createDoneRecoverHandlers(ctx));
  registry.registerBatch(createVerificationContextPackHandlers(ctx));
  registry.registerBatch(createCapsuleHandlers(ctx));

  // B-be27: scope contract — scope_contract_set/show/check/acknowledge
  registry.registerBatch(createScopeContractHandlers(ctx));

  // B-6bfd CHK-004: guard session projection — guard_session_start/status/check
  registry.registerBatch(createGuardSessionHandlers(ctx));

  // B-ea92 M1: authority_enforce_policy — read-only policy discovery command stub.
  // Never submits evidence, claims jobs, registers actor keys, or verifies receipts.
  registry.registerBatch(createAuthorityEnforceHandlers(ctx));

  // B-ad2c: dev_memory_* — lightweight experience capture outside Koala story gates.
  // Non-authoritative: entries cannot satisfy Koala DONE gate evidence.
  registry.registerBatch(createDevMemoryHandlers(ctx));

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
  const root = projectRoot || process.env.KOALA_PROJECT_ROOT || process.cwd();
  const config = loadConfig(root);
  const scanRoot = join(root, config.scanRoot);
  const ctx: HandlerContext = { store, root, scanRoot, log };
  return createMainRegistry(ctx).toObject();
}
