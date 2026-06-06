/**
 * Handler Registry — koala's tool registration center
 *
 * Design purpose: let main expose a clear registration interface so external packages (like @koala-agent/utils)
 * can inject their own handlers via registry.register / registerBatch,
 * while main itself remains completely unaware of these extension packages.
 *
 * main's cli.ts calls createMainRegistry(ctx) at startup to register the built-in handlers;
 * third-party bootstrap scripts can then call extension packages' register functions to append more registrations.
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
import { createCapabilityListHandlers } from './handlers/capability-list.js';
import { createStoryExportHandlers } from './handlers/story-export.js';
import { createLatticeHandoffHandlers } from './handlers/lattice-handoff.js';
import { createLatticeEvidenceHandlers } from './handlers/lattice-evidence.js';
import { createLatticeParallelWaveHandlers } from './handlers/lattice-parallel-wave.js';
import { createLatticeCliHandlers } from './handlers/lattice-cli.js';
import { createRolloutCheckHandlers } from './handlers/rollout-check.js';
import { createAutopilotHandlers } from './handlers/autopilot.js';
import { createPlannerHandlers } from './handlers/planner.js';
import { createStoryResolveHandlers } from './handlers/story-resolve.js';
import { createVerdictHandlers } from './handlers/verdict.js';
import { nextStoryId } from './handlers/context.js';

export type HandlerFn = (...args: any[]) => any;

/** Tool registration center: name → handler mapping + injection interface */
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

  /** Allow overriding an existing handler (for test stubs / replacing built-in implementations) */
  override(name: string, fn: HandlerFn): void {
    this.handlers.set(name, fn);
  }

  get(name: string): HandlerFn | undefined { return this.handlers.get(name); }
  has(name: string): boolean { return this.handlers.has(name); }
  list(): string[] { return [...this.handlers.keys()]; }

  /** Flatten into an object, mainly for injecting into the fixture runner's $handlers */
  toObject(): Record<string, HandlerFn> {
    return Object.fromEntries(this.handlers);
  }
}

/**
 * Create main's built-in Registry, registering only flow-related handlers.
 *
 * Auxiliary tools (aux/truth/gap, etc.) have been moved to the @koala-agent/utils package,
 * and are appended via the bootstrap script calling utils' register() function.
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
  // B-e71f CHK-003: init_check_set — writes init-check.json, the hard gate artifact for INIT→INIT_CHECK
  registry.registerBatch(createInitCheckHandlers(ctx));
  registry.registerBatch(createScopeQuestionResolveHandlers(ctx));
  registry.registerBatch(createStoryDispatchHandlers(ctx));
  registry.registerBatch(createBackgroundHandlers(ctx));
  registry.registerBatch(createPlanHandlers(ctx));
  registry.registerBatch(createAuditHandlers(ctx));

  // B-9d95 CHK-005: only wire `finding_cluster`. createClusterHandlers also exports `finding_dispatch`,
  // but that is the internal implementation of the dispatch({clusterId}) branch, already proxied and registered by
  // story-dispatch.ts's finding_dispatch / dispatch; re-registering it here would trigger a Registry name conflict.
  const clusterHandlers = createClusterHandlers(ctx);
  registry.register('finding_cluster', clusterHandlers.finding_cluster);

  // B-fdcf CHK-001: reviewer_list CLI wire (computed in real time from riskSignals / touchpoints)
  registry.registerBatch(createReviewerListHandlers(ctx));

  // B-9975 CHK-001: story_draft / story_draft_list / story_draft_discard
  registry.registerBatch(createStoryDraftHandlers(ctx));

  // B-9975 CHK-002: draft_check_set / draft_issue_resolve
  registry.registerBatch(createDraftCheckHandlers(ctx));

  // B-35ed CHK-001: delivery_check_set — writes delivery-check.json, the hard gate artifact for TEST→DONE
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

  // B-3fad CHK-002: gap_log — manual archival entry point for framework gaps.
  // Writes B-META-framework-audit findings (bootstraps via ensureMetaStory if it does not exist);
  // Does not depend on reviewer / review round / story worktree, does not participate in lifecycle gate.
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

  // Host-neutral capability discovery for Koala/Lattice adapters.
  registry.registerBatch(createCapabilityListHandlers());

  // Lattice productized export and cross-host handoff surfaces.
  registry.registerBatch(createLatticeCliHandlers(ctx));
  registry.registerBatch(createAutopilotHandlers(ctx));
  registry.registerBatch(createPlannerHandlers(ctx));
  registry.registerBatch(createStoryResolveHandlers(ctx));
  registry.registerBatch(createVerdictHandlers(ctx));
  registry.registerBatch(createRolloutCheckHandlers(ctx));
  registry.registerBatch(createStoryExportHandlers(ctx));
  registry.registerBatch(createLatticeHandoffHandlers(ctx));
  registry.registerBatch(createLatticeEvidenceHandlers(ctx));
  registry.registerBatch(createLatticeParallelWaveHandlers(ctx));

  // Internal helper: returns the next story id (for fixture/test runner use)
  registry.register('_nextStoryId', (prefix?: string) => nextStoryId(ctx.store, prefix));

  // Inject lazy getter: lets story gate obtain full tool name (avoids circular dependency)
  ctx.getAllToolNames = () => new Set(registry.list());

  return registry;
}

/**
 * Legacy entry point: kept for compatibility with old code paths.
 * New code should use createMainRegistry.
 */
export function createToolHandlers(store: StoryStore, projectRoot?: string, log?: (msg: string) => void) {
  const root = projectRoot || process.env.KOALA_PROJECT_ROOT || process.cwd();
  const config = loadConfig(root);
  const scanRoot = join(root, config.scanRoot);
  const ctx: HandlerContext = { store, root, scanRoot, log };
  return createMainRegistry(ctx).toObject();
}
