/**
 * B-6974 (Lifecycle Phase 2, Story 3c): transition-orchestrator — the explicit
 * coordinator of one story_advance transition.
 *
 * 3a (B-56d3) extracted the gate runner (phase-gates.ts) + non-DONE effects
 * (transition-effects.ts); 3b (B-9027) extracted the DONE merge / worktree
 * cleanup pipeline (done-effects.ts). After those two steps story-advance.ts
 * still inlined the *coordination* skeleton: actor lifecycle, event-type /
 * fallback mapping, the DONE merge lock scope, the state-mutation + writeStory
 * order, the pre/post gate ordering, and the 4 inline advisory segments.
 *
 * This module collects that coordination into runStoryTransition() and
 * EXPLICITLY OWNS the four formerly-implicit couplings (decision.json Option A
 * — behavior-preserving explicit orchestrator, NOT a mechanical relocation):
 *
 *   1. actor lifecycle — the orchestrator alone calls actor.create / .start /
 *      .send / .stop. On EVERY exit path (success, guard failure, gate
 *      failure, exception) the orchestrator stops the actor in a single
 *      finally block. phase-gates.ts (resolveGuardFailure) and done-effects.ts
 *      (the stray-offender path) no longer stop the actor themselves.
 *   2. DONE merge lock scope — acquireDoneMainMergeLock / release is wrapped in
 *      ONE try/finally that spans runDonePreMergeGate → actor.send →
 *      writeStory → applyDoneMergeEffects (equivalent to the old
 *      story-advance.ts try/finally).
 *   3. state-mutation / writeStory order — the orchestrator keeps the exact
 *      `pre-merge gate → actor.send → writeStory(phase=DONE) → post effects`
 *      ordering line-for-line.
 *   4. pre/post gate ordering + the 4 inline advisory segments — returned as
 *      explicit fields of TransitionResult; the thin handler only formats.
 *
 * External CLI behavior, phase-write timing, and DONE pre/post-merge semantics
 * are byte-identical to the pre-refactor story-advance.ts.
 *
 * Layering: handlers/ (NOT core/). It coordinates handler-layer gate/effect
 * modules and must NOT be imported by them — the dependency is strictly
 * one-directional: story-advance.ts → transition-orchestrator.ts →
 * {phase-gates, transition-effects, done-effects}. No circular import; no
 * global / shared hidden handoff (the rendered DONE checklist is carried in a
 * local variable, not a global stash).
 */

import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, realpathSync } from 'fs';
import { hostname } from 'os';
import { join, relative } from 'path';
import type { HandlerContext } from './context.js';
import { collectContext, PHASE_TO_EVENT, assertCwdInWorktree } from './context.js';
import { createStoryActor, getStateName, canSendStoryEventWithoutSnapshotCan } from '../core/machine.js';
// B-70a6 F-005: a VALUE import (not type-only) — the out-of-band rescue must open
// the DOOMED copy's own store (the worktree about to be deleted) to read the
// recovery record the surviving store cannot see. core/store.ts imports no
// handler module, so this stays one-directional (no import cycle).
import { StoryStore } from '../core/store.js';
import { resolveMainRepoRoot } from '../core/partial-done-recovery.js';
import type { ChecklistData, PendingReopenAudit, ProcessEvent, StoryInfo, StoryPhase } from '../core/types.js';
import { checkMetaStoryAdvanceGuard } from '../core/audit-meta-store.js';
import { renderSummaryForHint } from './summary.js';
import { collectBaselineRisk, renderBaselineRiskLines } from '../core/baseline-risk.js';
import { captureEvidenceHashSnapshot, currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { currentMilestoneStatusEvidenceBinding } from '../core/milestone-status.js';
import { consumeReviewInventoryReceipt } from '../core/review-inventory-epoch.js';
import { cancelReviewInventoryForReopen } from '../core/review-inventory-cancel.js';
import { evaluateReviewMaterialReopen, REVIEW_REOPEN_TRANSITION_TYPE, type ReviewMaterialReopenDecision } from '../core/review-material-reopen.js';
import { assertReviewInventoryContextFreshLocked } from './review-inventory.js';
import { findStaleEvidence, renderEvidenceStaleHint } from '../core/evidence-stale-hint.js';
import { checkMainDivergence } from '../core/done-oracle.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { loadConfig } from '../core/config.js';
import {
  evaluateRuntimeEnforcement,
  projectRuntimeClosure,
  type RuntimeDirtyState,
  type RuntimeEnforcementMode,
} from '../core/lifecycle-control/runtime/index.js';
import {
  classifyGitStatusRows,
  classifierOptionsForCheck,
  isBlockingDirty,
  readGitStatusLines,
} from '../core/dirty-worktree-gate.js';
import {
  resolveGuardFailure,
  runScopeTransitionGate,
  runPlanToDevScopeAdvice,
  runLegacyReceiptTransitionGate,
  runReviewToTestPreflightGate,
  runValidateGate,
  runImplementationWorkerAuthorityGate,
} from './phase-gates.js';
import { runGuardSessionGate } from './guard-session.js';
import { captureMilestoneCloseoutSnapshotFromStore } from './milestone-status.js';
import { getSessionId } from '../core/owner-session.js';
import {
  recomputeProcessMetrics,
  runPhaseChangeHooks,
  commitReviewMetadata,
  renderRelatedDocsHint,
  buildNextSteps,
} from './transition-effects.js';

import {
  autoSyncMain,
  detectDoneStoryWorktreeContext,
  assertDoneStoryBranchMatches,
  acquireDoneMainMergeLock,
  runDonePreMergeGate,
  applyDoneMergeEffects,
  runPostDoneLearningSettlement,
} from './done-effects.js';
import { runWithMainWriteLockContext } from '../core/main-write-lock.js';
import { acquireStoryTransitionLock } from '../core/story-transition-lock.js';
import { acquireMkdirLock, type AcquiredMkdirLock } from '../core/mkdir-lock.js';
import { resolveSharedLockRoot, sanitizeLockSegment } from '../core/validation-execution-lock.js';
import { PROOF_OR_STOP_DIR } from '../core/proof-or-stop-paths.js';
import { resolveStoryIntegrationTarget } from '../core/story-integration-target.js';
import { buildMemoryFreshnessPack, renderMemoryFreshnessPack } from '../core/playbook-runtime-memory.js';
import { surfaceRuntimeMemoryPack } from '../core/experience-pack-surface.js';
import {
  captureLifecycleMetadataTransaction,
  commitLifecycleMetadataTransaction,
  readLifecycleMetadataOutputHashes,
  type LifecycleMetadataTransaction,
} from '../core/auto-commit-metadata.js';
import { evaluateAcceptanceRolloutForContext, evaluateAcceptanceTopologyForContext, evaluatePreReviewCheckForContext } from './proofstory.js';
import { runEvidenceChainGate } from './evidence-chain.js';

export function runPreReviewCheckGate(ctx: HandlerContext, storyId: string): string {
  const report = evaluatePreReviewCheckForContext(ctx, storyId);
  const rendered = [
    '\nPre-review check:',
    `  mode=${report.mode}; status=${report.status}; blocking=${report.blocking}`,
    `  plannedActual=${report.plannedActual}; executableEvidence=${report.executableEvidence}; mutations=${report.mutations}; transcript=${report.transcript}; authority=${report.authority}; criticReattestation=${report.criticReattestation}`,
    `  codes=${report.codes.join(',') || 'none'}`,
    ...report.remediation.map(item => `  remediation=${item}`),
  ].join('\n');
  if (report.blocking) {
    throw new Error(`Cannot enter REVIEW: executable pre-review gate blocked DEV admission.${rendered}\n\n-> Run proof-or-stop pre_review_check after current evidence, then obtain the independent topology-critic re-attestation when enforce mode requires it.`);
  }
  return rendered;
}

export function unfinishedStoryDependencies(store: StoryStore, story: StoryInfo): string[] {
  const unfinished: string[] = [];
  for (const depId of story.depends ?? []) {
    try {
      const dependency = store.readStory(depId);
      if (dependency.phase !== 'DONE') {
        unfinished.push(`${depId}(${dependency.phase})`);
        continue;
      }
      // A worktree can contain phase=DONE after the phase write but before the
      // DONE branch was merged. That is a recoverable partial-DONE state, not a
      // completion fact a dependent Story may spend. In a git-backed project,
      // require the canonical DONE artifact on main and, while the story branch
      // still exists, require that exact branch to be an ancestor of main.
      const mainRoot = resolveMainRepoRoot(store.projectRoot);
      let gitBacked = false;
      try {
        gitBacked = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
          cwd: mainRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() === 'true';
      } catch {
        gitBacked = false;
      }
      if (!gitBacked) continue;
      let mainDependency: StoryInfo | null = null;
      try {
        mainDependency = JSON.parse(execFileSync('git', [
          'show', `main:${store.storyDirRel()}/${depId}/index.json`,
        ], {
          cwd: mainRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        })) as StoryInfo;
      } catch {
        mainDependency = null;
      }
      if (mainDependency?.phase !== 'DONE') {
        unfinished.push(`${depId}(DONE:not-on-main)`);
        continue;
      }
      const branch = `story/${depId}`;
      let branchExists = false;
      try {
        execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
          cwd: mainRoot, stdio: 'ignore',
        });
        branchExists = true;
      } catch {
        branchExists = false;
      }
      if (branchExists) {
        try {
          execFileSync('git', ['merge-base', '--is-ancestor', branch, 'main'], {
            cwd: mainRoot, stdio: 'ignore',
          });
        } catch {
          unfinished.push(`${depId}(DONE:not-merged)`);
        }
      }
    } catch {
      unfinished.push(`${depId}(not found)`);
    }
  }
  return unfinished;
}

/** PLAN→DEV is the first mutating execution boundary, so dependencies fail closed here. */
export function assertPlanDevDependenciesDone(store: StoryStore, story: StoryInfo, targetPhase: StoryPhase): void {
  if (story.phase !== 'PLAN' || targetPhase !== 'DEV') return;
  const unfinished = unfinishedStoryDependencies(store, story);
  if (unfinished.length > 0) {
    throw new Error(`Cannot enter DEV: unfinished Story dependencies: ${unfinished.join(', ')}. Complete and merge dependencies in declared order first.`);
  }
}

/** Wave 4 flat-project consumer. Diagnostics are mode-invariant; enforce alone blocks. */
export function runAcceptanceRolloutGate(ctx: HandlerContext, storyId: string): string {
  const report = evaluateAcceptanceRolloutForContext(ctx, storyId);
  const rendered = [
    '\nAcceptance rollout enforcement:',
    `  mode=${report.mode}; status=${report.status}; blocking=${report.blocking}`,
    `  receipt=${report.receipt}; quorum=${report.quorum}`,
    `  codes=${report.diagnostics.join(',') || 'none'}`,
  ].join('\n');
  if (report.blocking) {
    throw new Error(
      `Cannot enter REVIEW: acceptance rollout enforcement blocked DEV admission.${rendered}\n\n` +
      '-> Run proof-or-stop acceptance_rollout_report, then acceptance_rollout_check. Roll back by setting proofStory.acceptanceRolloutGateMode to warn or observe; prior reports remain immutable.',
    );
  }
  return rendered;
}

/** Arguments for one story_advance transition. */
export interface StoryTransitionArgs {
  storyId: string;
  phase: StoryPhase;
  checklist?: Array<{ id: string; title: string }>;
  /**
   * B-8b69: required, audited reason for the gated PLAN->INIT reopen. Ignored for
   * every other transition. Enforced (non-blank, >= REOPEN_REASON_MIN chars) before
   * the REOPEN event is sent, then persisted (with transitionType:"reopen") into the
   * append-only phase_transition process event so the reopen is durably auditable —
   * a validated-but-dropped reason would not be.
   */
  reason?: string;
}

/** B-8b69: minimum length of the mandatory PLAN->INIT reopen reason. */
export const REOPEN_REASON_MIN = 10;

/**
 * The structured result of one transition. story-advance.ts (the thin handler)
 * splices these fields into the CLI success message in the exact order the
 * inline original concatenated them — so the rendered output is byte-identical.
 */
export interface TransitionResult {
  storyId: string;
  /** machine state AFTER actor.send — the phase the story advanced to. */
  newState: string;
  /** rendered DONE checklist prefix (DONE only, else ''). */
  doneChecklistPrefix: string;
  /** REVIEW metadata auto-commit report (REVIEW only, else ''). */
  metadataCommitReport: string;
  /** DONE merge / worktree cleanup report (DONE only, else ''). */
  doneMergeReport: string;
  /** per-phase next-step guidance, keyed by machine state. */
  nextSteps: Record<string, string>;
  /** relatedDocs reminder (DEV / DONE only, else ''). */
  docsHint: string;
  /** unfinished-dependency advisory (else ''). */
  depsWarning: string;
  /** session-takeover advisory (DEV only, else ''). */
  sessionWarning: string;
  /** DONE summary suffix (DONE only, else ''). */
  doneSummarySuffix: string;
  /** INIT_CHECK medium/low init-reviewer advisory (else ''). */
  initCheckAdvisory: string;
  /** INIT_CHECK baseline-risk advisory (else ''). */
  baselineRiskWarning: string;
  /** stale verificationEvidence hint for REVIEW/TEST/DONE (else ''). */
  staleEvidenceHint: string;
  /** story scope contract gate report for REVIEW/TEST/DONE (else ''). */
  scopeGateReport: string;
  /** guard session projection gate report for REVIEW/TEST/DONE (else ''). */
  guardGateReport: string;
  /** non-authoritative runtime memory/playbook advisory (else ''). */
  memoryRuntimeAdvisory: string;
}

/**
 * Render a TransitionResult into the CLI success string. This is the exact
 * concatenation order of the pre-refactor story-advance.ts return statement —
 * keeping the rendering here means both the orchestrator and any other caller
 * format identically. The thin handler delegates to this.
 */
export function renderTransitionResult(result: TransitionResult): string {
  return (
    `${result.doneChecklistPrefix}Story ${result.storyId} advanced to ${result.newState}` +
    `${result.metadataCommitReport}${result.doneMergeReport}\n` +
    `${result.nextSteps[result.newState] || ''}${result.docsHint}` +
    `${result.scopeGateReport}${result.guardGateReport}${result.depsWarning}${result.sessionWarning}${result.doneSummarySuffix}` +
    `${result.initCheckAdvisory}${result.baselineRiskWarning}${result.staleEvidenceHint}${result.memoryRuntimeAdvisory}`
  );
}

export function canSendStoryEvent(
  actor: ReturnType<typeof createStoryActor>,
  eventType: string,
  storyId: string,
  store: HandlerContext['store'],
  root: string,
  gitCwd?: string,
): boolean {
  const event = { type: eventType } as any;
  const snapshot = actor.getSnapshot();
  const snapshotCan = (snapshot as typeof snapshot & { can?: (event: unknown) => boolean }).can;
  if (typeof snapshotCan === 'function') {
    return snapshotCan.call(snapshot, event);
  }

  // Compatibility fallback for XState runtimes/restored snapshots that do not
  // expose actor.getSnapshot().can(...). Keep this table aligned with
  // core/machine.ts and delegate guarded decisions to the same fail-closed
  // predicates used by the XState machine. Do not use getGuardFailureReason as
  // a decision oracle: it renders human hints and can intentionally fall
  // through to null after config/read failures.
  const currentState = getStateName(actor);
  return canSendStoryEventWithoutSnapshotCan(storyId, store, currentState, eventType, root, gitCwd);
}

export function assertStoryTransitionReachedTarget(
  storyId: string,
  eventType: string,
  targetPhase: StoryPhase,
  newState: string,
): void {
  if (newState !== targetPhase) {
    throw new Error(
      `Story ${storyId} transition ${eventType} did not reach requested phase ${targetPhase}; actor stayed in ${newState}. ` +
      `Phase side effects were not written.`,
    );
  }
}

function normalizeRuntimeEnforcementMode(value: unknown): RuntimeEnforcementMode {
  return value === 'enforce' || value === 'unavailable' || value === 'warn' ? value : 'warn';
}

function runtimeDirtyStateForPhaseAdvance(
  ctx: HandlerContext,
  storyId: string,
  gitCwd: string,
): { state: RuntimeDirtyState; statusError?: string; detail?: string } {
  const status = readGitStatusLines(gitCwd);
  if (!status.ok) {
    return {
      state: 'material',
      statusError: status.error,
      detail: `git status could not be read from authoritative cwd ${gitCwd}: ${status.error}`,
    };
  }
  if (status.lines.length === 0) return { state: 'clean' };

  const config = loadConfig(ctx.root);
  const classification = classifyGitStatusRows(
    status.lines,
    classifierOptionsForCheck(config, storyId, ctx.store, ctx.root),
  );
  const blocked = isBlockingDirty(classification);
  if (blocked.blocked) {
    return {
      state: 'material',
      detail: `blocking dirty categories ${blocked.blockingCategories.join(', ')}: ${blocked.blockingPaths.slice(0, 5).join(', ')}`,
    };
  }
  return {
    state: 'metadata-only',
    detail: 'only Proof-or-Stop metadata/runtime/declared-artifact dirty state was detected',
  };
}

function runRuntimeEnforcementPreflight(
  ctx: HandlerContext,
  story: StoryInfo,
  targetPhase: StoryPhase,
): string {
  const mode = normalizeRuntimeEnforcementMode(loadConfig(ctx.root).lifecycleControl?.runtimeEnforcement);
  if (mode === 'unavailable') return '';

  // Only authority, authoritativeCwd and locks are read below; the readiness
  // rows are lifecycle_check's and the transition's own gates evaluate them.
  const report = projectRuntimeClosure(ctx.store, ctx.root, {
    storyId: story.storyId,
    activeOnly: false,
    includeReadiness: false,
  });
  const runtimeRow = report.stories.find((row) => row.storyId === story.storyId);
  if (!runtimeRow) return '';

  const dirty = runtimeDirtyStateForPhaseAdvance(ctx, story.storyId, runtimeRow.authoritativeCwd);
  const decision = evaluateRuntimeEnforcement({
    mode,
    operation: targetPhase === 'DONE' ? 'shared-main-write' : 'phase-advance',
    currentCwd: process.cwd(),
    authoritativeCwd: runtimeRow.authoritativeCwd,
    authority: runtimeRow.authority,
    dirtyState: dirty.state,
    validationLock: runtimeRow.locks.validationLock,
    mainWriteLock: runtimeRow.locks.mainWriteLock,
  });
  const details = [
    `mode=${decision.mode}`,
    `operation=${decision.operation}`,
    `reason=${decision.reason}`,
    `dirtyState=${decision.dirtyState}`,
    `authoritativeCwd=${runtimeRow.authoritativeCwd}`,
    `rollback=${decision.rollback}`,
    `proofAdmissibilityEvaluated=${decision.proofAdmissibilityEvaluated}`,
    dirty.detail ? `detail=${dirty.detail}` : '',
  ].filter(Boolean);
  if (dirty.statusError && mode === 'enforce') {
    throw new Error(
      `Cannot enter ${targetPhase}: runtime closure preflight could not inspect dirty state [runtime_dirty_status_unreadable]\n` +
      `  - ${dirty.statusError}\n` +
      `  - ${details.join('; ')}\n\n` +
      `-> Roll back with lifecycleControl.runtimeEnforcement=warn while diagnosing, then rerun story_advance.`,
    );
  }
  if (decision.blocked) {
    throw new Error(
      `Cannot enter ${targetPhase}: runtime closure enforcement blocked phase advance [${decision.reason}]\n` +
      `  - ${details.join('; ')}\n\n` +
      `-> Resolve the runtime blocker or set lifecycleControl.runtimeEnforcement=warn to roll back enforcement while diagnosing.`,
    );
  }
  if (decision.reason === 'none' && dirty.state === 'clean') return '';
  return `\nRuntime closure preflight: ${details.join('; ')}`;
}

function renderStoryAdvanceMemoryRuntimeAdvisory(projectRoot: string, story: StoryInfo, targetPhase: StoryPhase): string {
  try {
    // B-ab8d CHK-002: experiment-arm render gate — pack always computed, event
    // fires on both arms, only the rendered section is hidden on control.
    const surfaced = surfaceRuntimeMemoryPack(projectRoot, {
      consumer: 'story_advance',
      storyId: story.storyId,
      roundKey: `${story.phase}->${targetPhase}`,
      buildPack: () => buildMemoryFreshnessPack({
        projectRoot,
        consumer: 'story_advance',
        storyPhase: targetPhase,
        query: [
          `story:${story.storyId}`,
          story.title,
          story.description,
          `from:${story.phase}`,
          `to:${targetPhase}`,
          'phase advance runtime memory playbook non-authoritative stale-doc truth-first repro-first intent-totality delivery review',
        ].filter(Boolean).join('\n'),
        maxEntries: 5,
        maxPlaybooks: 5,
        maxLines: 60,
      }),
    });
    if (!surfaced.shouldRender) return '';
    return `\n\nRuntime memory advisory (not gate evidence):\n${renderMemoryFreshnessPack(surfaced.pack)}`;
  } catch {
    return '';
  }
}

/**
 * B-0e53: read the integration branch commit sha in `gitCwd`, or undefined if unreadable.
 *
 * Used to capture the integration branch sha right AFTER the DONE pre-check autoSyncMain and to
 * re-read it just BEFORE store.writeStory persists phase=DONE. A CONFIRMED change
 * between the two reads means the integration branch advanced externally (between the pre-check
 * sync and the in-lock merge) and the DONE transition must abort before any
 * partial DONE is written. FAIL-OPEN: an unreadable sha (transient git error)
 * returns undefined and must NOT abort the common DONE path — only two
 * successful reads that DIFFER constitute a confirmed external advance.
 */
function readIntegrationBranchSha(gitCwd: string, integrationBranch: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--verify', `${integrationBranch}^{commit}`], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Coordinate one story_advance transition end-to-end.
 *
 * Sequence (byte-identical to the pre-refactor inline story_advance):
 *   meta guard → readStory → cwd guard → deps advisory → session advisory →
 *   IDEA→PLAN checklist guard → [DONE: acquire merge lock + pre-check] →
 *   create + start actor → resolve event (incl. REPLAN fallback) →
 *   guard check (actor.can) → [DEV→REVIEW worker-authority gate] →
 *   [REVIEW→TEST preflight gate] → [validate gate] →
 *   [DONE pre-merge gate] → actor.send → writeStory(state mutation) →
 *   post effects (metrics / hooks / metadata commit / docsHint / nextSteps /
 *   [DONE: applyDoneMergeEffects]) → advisory segments → return.
 *
 * The orchestrator OWNS the actor lifecycle: it is created and started here,
 * and stopped in a single finally block on EVERY exit path (success / guard
 * failure / gate failure / exception). The DONE merge lock acquire/release is
 * wrapped in ONE try/finally spanning the whole transition.
 */
export async function runStoryTransition(
  ctx: HandlerContext,
  args: StoryTransitionArgs,
): Promise<TransitionResult> {
  // B-3d39: a DONE transition holds the main write lock in the acquire/release
  // PAIR form (acquireDoneMainMergeLock at the top of the try, release in the
  // finally) ACROSS `await` boundaries (actor.send / applyDoneMergeEffects).
  // Establish an isolated async-context owner scope around the WHOLE transition
  // so the reentrancy registry recognizes only THIS transition's own nested
  // calls (in-process `audit`) as reentrant — never a CONCURRENT transition for
  // another story that interleaves while this one is parked at an await. The
  // registered acquire records the resolved lock key into this scope. Non-DONE
  // transitions never take the pair-form lock, so they run the body directly.
  if (args.phase === 'DONE') {
    return runWithMainWriteLockContext(() => runStoryTransitionInner(ctx, args));
  }
  return runStoryTransitionInner(ctx, args);
}

export function buildPhaseTransitionProcessEvent(input: {
  storyId: string;
  fromPhase: string;
  toPhase: string;
  materialHash: string;
  storyFilesHash: string;
  reviewRound: string;
  // B-8b69 follow-up: durable audit of the gated PLAN->INIT reopen. All three are
  // set ONLY on a REOPEN transition and omitted for every normal transition, so a
  // normal phase_transition event keeps its exact prior shape (old JSONL readers and
  // the builder shape test stay green; the fields are strictly additive).
  transitionType?: string;
  reason?: string;
  // B-70a6 F-004: the reopen's recovery idempotency key. Carrying it ON the event
  // is what lets reconciliation tell "my audit event is already on disk" from "it
  // is missing" without fuzzy-matching on reason text (two reopens of the same
  // story CAN carry the same reason), so recovery emits exactly one event.
  reopenAuditId?: string;
}): Omit<ProcessEvent, 'timestamp'> {
  return {
    type: 'phase_transition',
    storyId: input.storyId,
    attemptId: input.reviewRound,
    fromPhase: input.fromPhase,
    toPhase: input.toPhase,
    materialHash: input.materialHash,
    storyFilesHash: input.storyFilesHash,
    reviewRound: input.reviewRound,
    ...(input.transitionType !== undefined ? { transitionType: input.transitionType } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.reopenAuditId !== undefined ? { reopenAuditId: input.reopenAuditId } : {}),
  };
}

/** What `reconcilePendingReopenAudit` found and did. */
export type ReopenAuditReconciliationStatus =
  /** No recovery record on the index — the overwhelmingly common case, a pure no-op. */
  | 'none'
  /** Record present, its event already on disk (crash between append and clear): cleared, nothing appended. */
  | 'already_audited'
  /** Record present, event MISSING (crash between phase write and append): the missing event was appended. */
  | 'recovered';

export interface ReopenAuditReconciliation {
  status: ReopenAuditReconciliationStatus;
  /** The story as it stands AFTER reconciliation (recovery record cleared when there was one). */
  story: StoryInfo;
  auditId?: string;
}

/**
 * B-70a6 F-004: recover a gated PLAN->INIT reopen whose audit event never made it
 * to disk.
 *
 * THE WINDOW THIS CLOSES. `store.writeStory` (phase=INIT) and
 * `store.appendProcessEvent` (the audit event) are two separate fs operations,
 * with real git subprocess calls between them. A crash/throw in that window used
 * to leave a reopen that HAD happened with no audit record — and since REOPEN
 * only fires from PLAN, the story had already left the only phase that could
 * retry it, so the event was unrecoverable. Now the reopen's audit facts are
 * written INSIDE the same atomic `writeStory` rename as phase=INIT (see
 * StoryInfo.pendingReopenAudit), and this function turns that record back into
 * the missing event.
 *
 * IDEMPOTENT BY CONSTRUCTION. The record's `auditId` is stamped onto the event
 * as `reopenAuditId`, so "already audited" is an exact identity match, never a
 * heuristic on reason text. Therefore:
 *   - crash between phase write and append  -> record present, no matching event -> append (exactly one)
 *   - crash between append and clear        -> record present, matching event    -> clear only, NO second event
 *   - normal completion                     -> no record                         -> no-op
 * The clear happens only AFTER the event is durably on disk, so a crash at any
 * point simply re-runs the same convergent reconciliation.
 *
 * NEVER FABRICATES A TRANSITION. The record can only exist because the phase
 * write it rode along with committed, so an emitted event always describes a
 * reopen that really happened. An aborted/refused reopen throws before that
 * write, leaves no record, and therefore produces no event.
 *
 * SCOPE / RESIDUAL (stated, not glossed):
 *   - The two-write window is not ELIMINATED, it is made RECOVERABLE. After any
 *     crash the validated reason is already durable on the story index; only the
 *     event may be late, and no ORCHESTRATED phase transition can run before this
 *     heals it.
 *   - CORRECTED BY B-70a6 F-005 — the previous text here said the loss was
 *     "deferred, not lost", and that was FALSE. `runStoryTransitionInner` is not
 *     the only writer of `story.phase`: `story_discard` (handlers/worktree.ts)
 *     and the `story_reconcile` zombie repair (handlers/story-query.ts) mutate it
 *     out of band, land the story in a TERMINAL phase, and (for discard)
 *     force-delete the worktree + branch holding the record — so there the event
 *     was lost PERMANENTLY. Those two sites now call
 *     `reconcileReopenAuditBeforeOutOfBandPhaseChange` before their destructive
 *     steps. The accurate statement is the narrower one: reconciliation fires on
 *     the next TRANSITION or at those two out-of-band sites, NOT on arbitrary
 *     read-only commands (store.readStory lives in core/store.ts, outside this
 *     story's permitted scope); until one of them runs, the validated reason is
 *     still durable and visible on the story index.
 *   - NARROWED AGAIN BY B-70a6 F-013. Even at those two sites the coverage is
 *     SEQUENTIAL only: they rescue a record that is ALREADY on disk when they
 *     start, and they serialize against nothing, so a reopen RACING them is not
 *     covered. See CONCURRENCY RESIDUAL (B-70a6 F-013) on
 *     `reconcileReopenAuditBeforeOutOfBandPhaseChange` for the exact interleaving
 *     and for why it is named rather than locked.
 *   - The "already audited" test is a read-then-append, not an atomic CAS. On the
 *     ORCHESTRATED path the caller holds the per-story transition lock, so it is
 *     exact under the same software-concurrency threat model as the persist
 *     claim, and it inherits that claim's documented residual (an OS-level freeze
 *     longer than staleMs); the failure mode there is a DUPLICATE audit event,
 *     both carrying the same auditId so a reader can dedupe — never a lost one.
 *     The OUT-OF-BAND callers hold NO such lock, so there the same read-then-append
 *     is UNSERIALIZED — the F-013 residual below, not a stronger claim in disguise.
 */
export function reconcilePendingReopenAudit(
  store: StoryStore,
  storyId: string,
  known?: StoryInfo,
): ReopenAuditReconciliation {
  const story = known ?? store.readStory(storyId);
  const pending = story.pendingReopenAudit;
  if (!pending) return { status: 'none', story };
  const alreadyAudited = store.readProcessEvents(storyId).some(
    (event) => event.type === 'phase_transition'
      && event.transitionType === 'reopen'
      && event.reopenAuditId === pending.auditId,
  );
  if (!alreadyAudited) {
    // Rebuilt from the RECORD, not from live state: fromPhase/hashes/reviewRound
    // are the ones captured with the reopen, so a recovered event matches the one
    // the crashed run would have appended instead of describing the later tree.
    store.appendProcessEvent(storyId, buildPhaseTransitionProcessEvent({
      storyId,
      fromPhase: pending.fromPhase,
      toPhase: 'INIT',
      materialHash: pending.materialHash,
      storyFilesHash: pending.storyFilesHash,
      reviewRound: pending.reviewRound,
      transitionType: 'reopen',
      reason: pending.reason,
      reopenAuditId: pending.auditId,
    }));
  }
  // Re-read before clearing so this read-modify-write cannot clobber any other
  // field written since `known` was read; only the recovery record is dropped.
  const cleared = store.readStory(storyId);
  delete cleared.pendingReopenAudit;
  store.writeStory(storyId, cleared);
  return {
    status: alreadyAudited ? 'already_audited' : 'recovered',
    story: cleared,
    auditId: pending.auditId,
  };
}

/** What `reconcileReopenAuditBeforeOutOfBandPhaseChange` found, did, and could not do. */
export interface OutOfBandReopenAuditReconciliation {
  status: ReopenAuditReconciliationStatus;
  auditId?: string;
  /**
   * Which copy held the record: the surviving story index, or a doomed root path.
   * Rendered by `renderOutOfBandReopenAuditNotice` (B-70a6 F-009) — the doomed-copy
   * path is the one whose record is deliberately left uncleared (see RESIDUALS
   * below), so an operator chasing a duplicate audit event needs to see WHICH copy
   * this rescue read.
   */
  source?: string;
  /** Non-fatal problems. Never thrown: an audit rescue must not block the operation. */
  warnings: string[];
}

/**
 * B-70a6 F-005: rescue a pending reopen audit BEFORE an OUT-OF-BAND phase
 * mutation destroys the record carrying it.
 *
 * WHY THIS EXISTS (the F-004 invariant was narrower than it claimed).
 * `reconcilePendingReopenAudit` runs at the top of `runStoryTransitionInner`,
 * which only yields "no ORCHESTRATED phase change can follow an unaudited
 * reopen" — i.e. only for phase changes that GO THROUGH it. Two production sites write
 * `story.phase` directly via `store.writeStory`:
 *   - `story_discard`  (handlers/worktree.ts)  -> DISCARDED
 *   - the `story_reconcile` zombie repair (handlers/story-query.ts) -> DONE
 * Both land the story in a TERMINAL phase (no outgoing machine edge), and
 * story_discard additionally force-deletes the worktree + branch. So the loss
 * there was not "deferred until the next transition" as the F-004 docblock said:
 * there IS no next transition, and the copy holding the record is gone. This
 * function is what those sites call first.
 *
 * WHY IT NEEDS `recordRoots` (a plain `reconcilePendingReopenAudit(store, id)`
 * at those sites does NOT fix it). `cli/runtime-root.ts` deliberately redirects
 * story_discard's runtime root from the worktree to the MAIN root, and the
 * reopen is cwd-gated to run INSIDE the worktree — so the record normally lives
 * in the worktree's own metadata copy, which the handler's store cannot see. The
 * record must therefore be read from the DOOMED copy while it is still on disk,
 * and the event appended to the SURVIVING store's append-only log.
 *
 * SINGLE APPEND SITE. Both paths delegate to `reconcilePendingReopenAudit`, so
 * the emitted event, the exact-auditId idempotency test and the
 * append-then-clear ordering cannot drift from the orchestrator's own recovery.
 *
 * NEVER BLOCKS. Discarding or reconciling a story is legitimate; refusing it
 * because of an audit record would be a worse failure than the one being fixed.
 * Every failure is captured as a warning for the caller to SURFACE, not thrown.
 * The ONE deliberate silence (B-70a6 F-008) is a doomed copy that holds no story
 * metadata at all — StoryStore's typed not-found. That is not a failure: there is
 * nothing there to rescue. Every other read failure (corrupt index.json, EACCES)
 * IS warned about, because it may be hiding a record.
 *
 * ── CONCURRENCY RESIDUAL (B-70a6 F-013) — NAMED, NOT FIXED ────────────────────
 * THE HONEST SCOPE OF THIS FUNCTION. It is a ONE-TIME SCAN and it does NOT hold
 * the per-story transition lock that `runStoryTransitionInner` holds, so it
 * SERIALIZES AGAINST NOTHING. The interleaving it therefore does NOT cover:
 *   1. this scan runs and finds no record;
 *   2. a concurrent PLAN->INIT reopen commits phase=INIT + its recovery record
 *      into the worktree copy;
 *   3. story_discard removes that worktree;
 *   4. the reopen dies against the removed copy.
 * NEITHER the record NOR the event survives. So the guarantee is:
 *   - SEQUENTIAL (holds): a reopen whose record is ALREADY on disk when the
 *     terminal operation starts is recovered — by the next orchestrated
 *     transition, or here. That is what the drills in
 *     tasks/plan-init-reopen-roundtrip-smoke.ts actually prove.
 *   - CONCURRENT (does NOT hold): a reopen that writes its record AFTER this scan
 *     and loses its copy to that same operation is not covered.
 * A second, lock-independent case: story_discard --force on a story whose
 * worktree is ALREADY gone. The record only ever lived there, so there is nothing
 * to rescue and no mutex could have changed that.
 *
 * WHY IT IS NAMED RATHER THAN LOCKED (reasons, not excuses).
 *
 * CORRECTED BY B-70a6 F-014 — the middle reason previously given here was
 * MISDIRECTED and is RETRACTED. It argued that the persist claim below
 * (`failFastIfHeld`, `staleMs: 15000`, held for MILLISECONDS) could not be
 * stretched across story_discard's git work. That is true and irrelevant: the
 * persist claim was never the candidate primitive; nobody proposed reusing it
 * here. The ONLY candidate is the per-story ADVISORY lock
 * `acquireStoryTransitionLock` (core/story-transition-lock.ts, `staleMs`
 * 120_000 / deadline 180_000), whose stale threshold is documented as
 * "generously exceeds any legitimate non-DONE transition" — i.e. it is sized
 * for exactly this class of long synchronous section, and story_discard IS one
 * (declared `story_discard(args): string`, no `await` anywhere in its body,
 * shelling out only through synchronous `execSync` / `execFileSync`). The
 * accurate reasons are these three:
 *   1. NO GUARANTEE COULD REST ON IT, so this is a defence-in-depth question and
 *      never a correctness one. core/story-transition-lock.ts documents
 *      `acquireStoryTransitionLock` as a
 *      "BEST-EFFORT ADVISORY CONTENTION-REDUCER, NOT the correctness guarantee",
 *      and `PROOF_OR_STOP_TEST_DISABLE_TRANSITION_ADVISORY_LOCK=1` turns its acquire
 *      into a literal no-op (tasks/transition-integrity-smoke.ts sets exactly that to
 *      prove the atomic claim alone serializes a persist). A correctness claim
 *      resting on it would be FALSE under that env while every test stayed
 *      green. Taking it here would NARROW this window; it could not close it,
 *      and the shipped claim would still have to be SEQUENTIAL.
 *   2. THIS IS THE RECOVERY COMMAND, AND THE LOCK'S ONLY EXPOSED SHAPE BLOCKS.
 *      `StoryTransitionLockOptions` exposes only `deadlineMs` / `staleMs` — there
 *      is no `failFastIfHeld` — so an acquire here POLLS (synchronously, via the
 *      mkdir lock's `Atomics.wait`) for the 180s deadline and then THROWS. Worse
 *      for a recovery tool: `classifyTransitionLockHolder` returns `active` for
 *      ANY same-host holder whose recorded pid is merely alive, and its PID-REUSE
 *      guard fires only when the recorded pid is THIS process's own, so a leaked
 *      lock whose pid has since been recycled by an unrelated live process is
 *      NEVER stale-reclaimed at any age. story_discard would then hang the full
 *      deadline and fail — putting the command operators reach for when a story
 *      is ALREADY wedged behind a lock file that only a manual `rm` clears.
 *      The one shape that dodges that, a NON-BLOCKING try-acquire that proceeds
 *      UNLOCKED on failure, was considered and DECLINED: it covers only the
 *      interleaving in which the racing reopen has not yet taken the lock,
 *      because a reopen that already holds it (it is acquired before its own
 *      readStory and held for the whole transition) makes the try-acquire fail
 *      and discard proceed exactly as it does today. That is a partial narrowing
 *      bought with a mutex that reads to the next maintainer as the
 *      serialization this function explicitly does NOT have — the precise
 *      over-reading this story has already been bitten by.
 *   3. AT THE story_reconcile SITE THE LOCK ORDER ALSO FORBIDS IT. This reason is
 *      SITE-SPECIFIC and does NOT apply to story_discard; the earlier text
 *      wrongly lumped the two together. `story_reconcile`'s repair already runs
 *      INSIDE `withMainWriteLock`, while this repo's established order is
 *      transitionLock -> mainWriteLock (runStoryTransitionInner takes the
 *      transition lock, then the DONE path takes the main write lock). Acquiring
 *      the transition lock inside that repair would INVERT that order, so a
 *      reconcile would sit on the main write lock for up to the transition
 *      deadline while a DONE holding the transition lock fail-fasts on the main
 *      write lock — turning one rare audit loss into systematic aborts of DONE /
 *      story_create / gap_log / audit. story_discard is NOT in that position: its
 *      `withReentrantMainWriteLock` calls all come AFTER the rescue and after the
 *      worktree/branch destruction, so an acquire there would be transitionLock
 *      -> mainWriteLock, the established order, not an inversion.
 * Hardening this race is a FOLLOW-UP STORY. It is not claimed here.
 *
 * RESIDUALS (stated, not glossed):
 *   - The doomed copy's record is deliberately NOT cleared. Writing to a worktree
 *     that is about to be checked with `git status --porcelain` could turn a clean
 *     worktree dirty and make a non-force discard refuse. If the destructive step
 *     then fails and the worktree survives, its record is reconciled again later
 *     into ITS log; both events carry the SAME auditId, so the failure mode is a
 *     dedupable duplicate, never a lost event. (`source` names that copy in the
 *     operator notice so the duplicate is traceable to where it came from.)
 *   - `story_discard --purge` removes the story metadata directory this event's
 *     log lives in, so the rescued event does NOT survive a purge. That is an
 *     explicit erase of ALL of the story's process events, not a silent audit
 *     loss; the caller surfaces it. Precise scope of that claim (B-70a6 F-012):
 *     purge's own git rollback may restore an OLDER committed copy of the
 *     directory, so metadata files can still be on disk afterwards — but that
 *     older copy predates the rescue and therefore never carries this event.
 */
export function reconcileReopenAuditBeforeOutOfBandPhaseChange(args: {
  storyId: string;
  /** The store that SURVIVES the operation — where the audit event must land. */
  store: StoryStore;
  /** Roots of copies about to be destroyed (e.g. the worktree), searched in order. */
  recordRoots?: ReadonlyArray<string | null | undefined>;
}): OutOfBandReopenAuditReconciliation {
  const warnings: string[] = [];
  try {
    const own = reconcilePendingReopenAudit(args.store, args.storyId);
    if (own.status !== 'none') {
      return { status: own.status, auditId: own.auditId, source: 'the surviving story index', warnings };
    }
  } catch (e: any) {
    warnings.push(`could not reconcile the pending reopen audit on the story index: ${String(e?.message ?? e)}`);
  }
  for (const recordRoot of args.recordRoots ?? []) {
    if (!recordRoot || !existsSync(recordRoot)) continue;
    let doomed: StoryInfo | undefined;
    try {
      doomed = new StoryStore(recordRoot).readStory(args.storyId);
    } catch (e: any) {
      // B-70a6 F-008: this used to be a bare `catch { continue; }`, which
      // contradicted the docblock above by swallowing REAL failures.
      //
      // ABSENT metadata is not a failure: a doomed root can legitimately hold no
      // copy of this story (a worktree created before the metadata commit, a
      // residual directory), and there is genuinely nothing to rescue there —
      // warning on it would bury the real ones in routine noise. StoryStore
      // signals exactly that case with its typed not-found error.
      //
      // ANY OTHER read failure (corrupt-but-present index.json, EACCES) may be a
      // record sitting right there, unreadable — precisely the silent loss this
      // function exists to prevent — so it is surfaced as a warning. Still never
      // thrown: the caller's discard/repair must not be blocked.
      //
      // The not-found error class is private to core/store.ts, so it is matched by
      // NAME. If it is ever renamed this degrades to an EXTRA warning (loud), never
      // back to a swallowed failure (silent).
      if (e?.name !== 'StoryArtifactMissingError') {
        warnings.push(`could not read the pending reopen audit record from ${recordRoot}: ${String(e?.message ?? e)}`);
      }
      continue;
    }
    if (!doomed?.pendingReopenAudit) continue;
    try {
      // The RECORD comes from the doomed copy; the EVENT is appended to the
      // surviving store — the whole point of this function.
      const rescued = reconcilePendingReopenAudit(args.store, args.storyId, doomed);
      if (rescued.status !== 'none') {
        return { status: rescued.status, auditId: rescued.auditId, source: recordRoot, warnings };
      }
    } catch (e: any) {
      warnings.push(`could not rescue the pending reopen audit from ${recordRoot}: ${String(e?.message ?? e)}`);
    }
  }
  return { status: 'none', warnings };
}

/**
 * The operator-facing lines for an out-of-band rescue. Kept next to the rescue so
 * both call sites report it identically — a silent rescue is the exact complaint
 * F-005 raised about the silent LOSS.
 */
export function renderOutOfBandReopenAuditNotice(
  storyId: string,
  result: OutOfBandReopenAuditReconciliation,
  options?: { metadataWillBePurged?: boolean },
): string[] {
  const lines: string[] = [];
  // B-70a6 F-009: `source` names WHICH copy held the record. It matters to the
  // operator: a doomed-copy rescue deliberately leaves that copy's record in place
  // (see the rescue's RESIDUALS), so this is the pointer that makes a later
  // duplicate event traceable instead of mysterious.
  const from = result.source ? ` [record read from ${result.source}]` : '';
  if (result.status === 'recovered') {
    lines.push(
      `✓ recovered the audit event for an interrupted PLAN->INIT reopen of ${storyId} (${result.auditId}) ` +
      `before this out-of-band phase change destroyed its record${from}`,
    );
    if (options?.metadataWillBePurged) {
      // B-70a6 F-012: says only what is verified. The rescued event does NOT
      // survive purge (its log is removed, and purge's git rollback can only
      // restore an OLDER committed copy, which predates the rescue). The earlier
      // wording also claimed the whole directory reliably disappears, which is
      // not true in the common case — purgeSafeInitCommit resets only the LATEST
      // commit, so metadata files can remain on disk afterwards.
      lines.push(
        `⚠ purge removes this story's metadata directory, so the audit event just recovered will NOT survive it ` +
        `(an explicit erase of this story's process events, not a silent audit loss); ` +
        `purge's git rollback may leave an OLDER committed copy of that directory on disk, but it predates this rescue and does not carry the event`,
      );
    }
  } else if (result.status === 'already_audited') {
    lines.push(`✓ cleared a stale reopen recovery record for ${storyId} (${result.auditId}); its audit event was already durable${from}`);
  }
  for (const warning of result.warnings) {
    lines.push(`⚠ reopen audit rescue: ${warning}`);
  }
  return lines;
}

async function runStoryTransitionInner(
  ctx: HandlerContext,
  args: StoryTransitionArgs,
): Promise<TransitionResult> {
  const { store } = ctx;
  let doneMainMergeLock: ReturnType<typeof acquireDoneMainMergeLock> | undefined;
  // B-d877 CHK-002 + Finding 2: per-story transition lock taken for EVERY phase
  // (including DONE). Held across the non-atomic read → gate → persist span so two
  // concurrent SAME-owner transitions serialize (the owner lease only rejects
  // FOREIGN sessions). DONE ALSO takes acquireDoneMainMergeLock, but this
  // transition lock is acquired FIRST (fixed ordering transitionLock →
  // doneMainMergeLock) so a DONE and a concurrent same-story NON-DONE transition
  // (e.g. a rollback) mutually exclude. NON-DONE only takes this lock, so the
  // ordering is total → no circular wait. Released in the finally.
  let transitionLock: AcquiredMkdirLock | undefined;
  // B-0e53: main's commit sha captured AFTER the DONE pre-check autoSyncMain.
  // Outer-scoped so the capture point (end of the DONE pre-check block) and the
  // re-check point (just before store.writeStory persists phase=DONE) both see
  // it. Stays undefined for non-DONE transitions and when the capture read fails.
  let syncedIntegrationSha: string | undefined;
  // The orchestrator is the SOLE owner of the actor lifecycle. It is assigned
  // inside the try (after the early guards) and unconditionally stopped in the
  // finally — covering success, guard failure, gate failure, and exceptions.
  let actor: ReturnType<typeof createStoryActor> | undefined;
  try {
    // B-d877 CHK-002 + Finding 2: acquire the per-story transition lock BEFORE
    // readStory so the read → gate → persist span is atomic against another
    // SAME-owner transition. A second concurrent attempt blocks here, then
    // re-reads the committed post-transition state below. This now runs for ALL
    // phases (including DONE); for DONE it is acquired BEFORE
    // acquireDoneMainMergeLock (see the DONE pre-check block) — a fixed lock
    // ordering that makes a DONE and a concurrent same-story rollback mutually
    // exclude without any circular wait.
    //
    // B-3e5d F-001: `ctx.root` here may be a story worktree that a winning DONE
    // later removes, but that is already handled INSIDE acquireStoryTransitionLock
    // — storyTransitionLockPath resolves through resolveSharedLockRoot (git-
    // common-dir based, B-d877 R2 FIX B) before touching disk, so the lock
    // directory itself is always anchored at the stable shared root regardless of
    // which worktree/root string is passed in here. Rerouting the ROOT ARGUMENT
    // at this call site (an earlier revision of this fix) was therefore a no-op:
    // confirmed by comparing storyTransitionLockPath(worktreePath, id) against
    // storyTransitionLockPath(mainRepoRoot, id) on a real worktree layout — both
    // resolve to the identical lock directory. The actual crash this story fixes
    // is the loser's OWN story-metadata read after it wakes up (see the
    // StoryArtifactMissingError translation below), not the lock's location.
    transitionLock = acquireStoryTransitionLock(ctx.root, args.storyId);

    // B-9bd9 CHK-002: meta-story never enters DONE (long-lived cross-story container, only carries findings)
    const metaGuardErr = checkMetaStoryAdvanceGuard(args.storyId, args.phase);
    if (metaGuardErr) {
      throw new Error(metaGuardErr);
    }

    // B-70a6 F-004: heal a crash-interrupted reopen BEFORE this transition reads
    // its own state. Held under the per-story transition lock acquired above, so
    // it is serialized against concurrent transitions. This is what makes the
    // recovery record a real recovery rather than a note nobody acts on, and it
    // yields the load-bearing invariant FOR ORCHESTRATED TRANSITIONS: no phase
    // transition routed through here can run while an unaudited reopen is pending
    // — reconciliation always goes first. B-70a6 F-005: that is NOT by itself a
    // framework-wide invariant, because story_discard and the story_reconcile
    // zombie repair write story.phase WITHOUT coming through this function; they
    // get a NARROWER version of it by calling
    // reconcileReopenAuditBeforeOutOfBandPhaseChange before their own phase write.
    // B-70a6 F-013: narrower in a specific way — those two sites hold no lock, so
    // they only cover a record ALREADY on disk when they start, never a reopen
    // racing them (CONCURRENCY RESIDUAL (B-70a6 F-013) on that function). THIS
    // call site is the strong one: it runs under the transition lock acquired
    // above, so a concurrent transition cannot slip a reopen past it.
    // For every ordinary transition `pendingReopenAudit` is absent and this is a
    // pure no-op that returns the very object just read.
    //
    // `store` here is `ctx.store`, bound to this invocation's root at CLI
    // bootstrap — for a CWD-gated phase run from inside the story's own
    // worktree, that root IS the worktree path, fixed for the life of this
    // process. The transitionLock above now blocks on the STABLE main repo
    // root, so a concurrent DONE racer can win, finish, and delete this
    // worktree entirely WHILE this process is still parked waiting on that
    // lock. The moment it wakes, this read runs against a root that no longer
    // exists on disk, and StoryStore surfaces that as a raw
    // StoryArtifactMissingError ("File not found: .../index.json") — a
    // confusing crash instead of the clean "someone else already finished
    // this" explanation callers are meant to see. Recognized narrowly (missing
    // artifact AND the invocation root itself is gone, not just this one
    // story record) and translated; any other StoryArtifactMissingError
    // (a genuinely unknown story id, root still present) rethrows unchanged.
    let initialStoryRead: StoryInfo;
    try {
      initialStoryRead = store.readStory(args.storyId);
    } catch (e: any) {
      if (e?.name === 'StoryArtifactMissingError' && !existsSync(ctx.root)) {
        throw new Error(
          `Cannot advance ${args.storyId} to ${args.phase}: this worktree no longer exists — ` +
          `a concurrent DONE transition for ${args.storyId} already completed and removed it. ` +
          `Retry from main.`,
        );
      }
      throw e;
    }
    const reconciledReopenAudit = reconcilePendingReopenAudit(
      store,
      args.storyId,
      initialStoryRead,
    );
    if (reconciledReopenAudit.status === 'recovered') {
      ctx.log?.(
        `✓ recovered the audit event for an interrupted PLAN->INIT reopen of ${args.storyId} ` +
        `(${reconciledReopenAudit.auditId}); the reason is now in the append-only process-event log`,
      );
    }
    // Read AFTER reconciliation so this transition never carries (and cannot
    // re-persist) an already-cleared recovery record.
    const story = reconciledReopenAudit.story;
    const oldPhase: string = story.phase as string;
    const runtimeGateReport = runRuntimeEnforcementPreflight(ctx, story, args.phase);

    // Dependency admission runs before any actor.send/writeStory mutation.
    assertPlanDevDependenciesDone(store, story, args.phase);

    // CWD gate: PLAN/DEV/TEST phases must execute inside the worktree
    const CWD_GATED: StoryPhase[] = ['PLAN', 'DEV', 'REVIEW', 'TEST'];
    // B-8b69: the PLAN->INIT reopen must also run inside the worktree, even though
    // the TARGET phase (INIT) is not itself cwd-gated. The story sits at PLAN with an
    // active worktree whose branch carries the authoritative metadata; running the
    // reopen from the main root would flip main's (stale) index.json to INIT and leave
    // the worktree at PLAN — a split brain. Gate on the reopen shape, not the target.
    const isReopenToInit = args.phase === 'INIT' && story.phase === 'PLAN';
    if ((CWD_GATED.includes(args.phase) || isReopenToInit) && story.worktree) {
      assertCwdInWorktree(store, args.storyId);
    }

    // Wave 2 PLAN→DEV structural gate. Both the CLI and lifecycle route use
    // the same production adapter and canonical evaluator. Observe/warn retain
    // identical diagnostics; enforce alone changes admission behavior.
    let acceptanceTopologyGateReport = '';
    if (story.phase === 'PLAN' && args.phase === 'DEV') {
      const topology = evaluateAcceptanceTopologyForContext(ctx, args.storyId);
      acceptanceTopologyGateReport = [
        '\nAcceptance topology check:',
        `  mode=${topology.mode}; status=${topology.status}; structuralPass=${topology.structuralPass}; blocking=${topology.blocking}`,
        `  diagnostics=${topology.diagnostics.map(item => item.code).join(',') || 'none'}`,
      ].join('\n');
      if (topology.blocking) {
        throw new Error(
          `Cannot enter DEV: acceptance topology structural gate blocked PLAN admission.\n` +
          topology.diagnostics.map(item => `  - ${item.code}: ${item.message}`).join('\n') +
          `\n\n-> ${topology.nextAction}`,
        );
      }
    }
    let preReviewGateReport = '';
    if (story.phase === 'DEV' && args.phase === 'REVIEW') {
      preReviewGateReport = runPreReviewCheckGate(ctx, args.storyId) + runAcceptanceRolloutGate(ctx, args.storyId)
        + runEvidenceChainGate(ctx, args.storyId);
    }

    // Non-PLAN→DEV transitions retain the historical diagnostic. PLAN→DEV is
    // already fail-closed above and therefore cannot reach here unfinished.
    let depsWarning = '';
    if (story.depends && story.depends.length > 0) {
      const unfinished = unfinishedStoryDependencies(store, story);
      if (unfinished.length > 0) {
        depsWarning = `\n⚠ Unfinished dependencies: ${unfinished.join(', ')}`;
      }
    }

    // Session ownership check
    let sessionWarning = '';
    if (args.phase === 'DEV' && story.events) {
      const devEvents = story.events.filter(e => e.phase === 'DEV' && e.action === 'advance');
      if (devEvents.length > 0) {
        const lastDev = devEvents[devEvents.length - 1];
        const currentSession = getSessionId();
        if (lastDev.sessionId && lastDev.sessionId !== currentSession) {
          const who = lastDev.user || lastDev.agent || 'unknown';
          const when = lastDev.timestamp;
          sessionWarning = `\n⚠ Warning: Story ${args.storyId} was already claimed for development by ${who} at ${when} (session: ${lastDev.sessionId})`;
          console.error(sessionWarning.trim());
        }
      }
    }

    // IDEA→PLAN requires checklist
    if (args.phase === 'PLAN' && story.phase === 'IDEA') {
      if (!args.checklist || args.checklist.length === 0) {
        throw new Error('Cannot advance to PLAN: checklist is required');
      }
    }

    // B-6666 CHK-001: the resolved DONE git cwd is hoisted to function scope so
    // the SAME value resolved ONCE in the DONE pre-check block (preMortem #4)
    // can be threaded into runDonePreMergeGate below — no second resolveGitCwd.
    let doneGitCwd: string = ctx.root;
    let doneIntegrationBranch = '';

    // B-c622 CL-006: auto-sync main BEFORE actor.can() to avoid TOCTOU —
    // guard evaluates post-merge state, not pre-merge state.
    if (args.phase === 'DONE') {
      // B-db56 F-002 fix: resolve the actual git cwd ONCE at the entry of the
      // DONE pre-check block via the resolveGitCwd choke-point, then pass the
      // resolved value to every git-invoking callee here. In a wrapper-root
      // layout `ctx.root` (metadataRoot) is NOT a git repo and the real repo
      // is a configured gitRoot subdir; without this routing the bare-root
      // calls below would fail with `fatal: not a git repository`.
      // Plain-repo / unresolved cases fall back to ctx.root — byte-identical.
      doneGitCwd = resolveGitCwd({
        store,
        storyId: args.storyId,
        metadataRoot: ctx.root,
        projectRoot: ctx.root,
      });
      const integrationTarget = resolveStoryIntegrationTarget(doneGitCwd, story);
      if (!integrationTarget) {
        throw new Error(
          `Cannot enter DONE: no integration branch can be resolved for Story ${args.storyId}. ` +
          'No fetch, merge, phase mutation, or DONE effect was attempted.',
        );
      }
      doneIntegrationBranch = integrationTarget.parentBranch;
      // B-4c38 CHK-001: serialize every main-affecting DONE operation before
      // any DONE preflight can mutate the story branch or main. The lock spans
      // checkMainDivergence/autoSyncMain, DONE gates, phase persistence, and
      // the real merge/worktree cleanup. A live lock fails before phase=DONE
      // can be written; a stale lock is reclaimed by the mkdir-lock primitive.
      // acquireDoneMainMergeLock's lock-path mkdir uses the projectRoot fallback
      // when not inside a story worktree, so pass the resolved gitCwd so the
      // mkdir target is the real main repo root in wrapper-root layouts.
      //
      // B-d877 Finding 2: the per-story `transitionLock` was already acquired at
      // the top of this try (for EVERY phase). Acquiring the DONE main-merge lock
      // here — strictly AFTER the transition lock — fixes the ordering
      // (transitionLock → doneMainMergeLock). Since a NON-DONE transition only
      // ever holds `transitionLock`, this ordering is total and cannot deadlock.
      doneMainMergeLock = acquireDoneMainMergeLock(args.storyId, doneGitCwd);
      const doneWorktree = detectDoneStoryWorktreeContext();
      if (doneWorktree) {
        assertDoneStoryBranchMatches(args.storyId, doneWorktree.branch);
      }
      const divergence = checkMainDivergence(doneGitCwd, doneIntegrationBranch);
      if (divergence.needsSync) {
        ctx.log?.(`DONE pre-check: current branch is ${divergence.behind} commits behind ${doneIntegrationBranch}, auto-syncing...`);
        const syncResult = autoSyncMain(doneGitCwd, doneIntegrationBranch);
        if (syncResult.ok) {
          ctx.log?.(`✓ ${syncResult.message}`);
        } else {
          ctx.log?.(`⚠ ${syncResult.message}`);
        }
      }
      // B-0e53: capture the integration branch sha AFTER autoSyncMain so Proof-or-Stop's own sync is
      // already in the baseline. The re-check before writeStory compares against
      // this; only an EXTERNAL advance after this point trips the abort.
      syncedIntegrationSha = readIntegrationBranchSha(doneGitCwd, doneIntegrationBranch);
    }

    // ── actor lifecycle: created + started here, owned by this orchestrator,
    // stopped exactly once in the finally below. No gate / effect module stops
    // it — they only consume it.
    actor = createStoryActor(args.storyId, store, story.phase, ctx.root, args.phase === 'DONE' ? doneGitCwd : undefined);
    actor.start();

    let eventType = PHASE_TO_EVENT[args.phase];
    if (!eventType) {
      throw new Error(`Invalid target phase: ${args.phase}`);
    }
    // Rollback mapping: when the target phase is earlier than the current phase, pick the matching rollback event
    if (args.phase === 'PLAN' && story.phase === 'DEV') {
      eventType = 'REPLAN';
    }
    // TEST→DEV rollback: PHASE_TO_EVENT['DEV']='START' matches automatically
    // B-8b69: gated PLAN->INIT reopen. PHASE_TO_EVENT['INIT']='INIT', which the PLAN
    // state has no edge for; remap to the REOPEN event and enforce the required,
    // audited reason here (the pure machine guard has no access to args). A missing
    // or too-short reason fails BEFORE the actor.can() check so the refusal names the
    // reason requirement rather than an opaque illegal-transition message.
    if (args.phase === 'INIT' && story.phase === 'PLAN') {
      eventType = 'REOPEN';
      if (!args.reason || args.reason.trim().length < REOPEN_REASON_MIN) {
        throw new Error(
          `Cannot reopen ${args.storyId} to INIT: a reason of at least ${REOPEN_REASON_MIN} characters is required ` +
          `(explain why the frozen checklist title/context must change — e.g. which PLAN scope review flagged it). ` +
          `Re-run: proof-or-stop story_advance '{"storyId":"${args.storyId}","phase":"INIT","reason":"<why>"}'.`,
        );
      }
    }

    const canSend = canSendStoryEvent(actor, eventType, args.storyId, store, ctx.root, args.phase === 'DONE' ? doneGitCwd : undefined);
    if (!canSend) {
      // B-56d3: cwd/guard-failure adapter in phase-gates.ts. B-6974: it no
      // longer stops the actor — the orchestrator's finally owns that.
      throw resolveGuardFailure(actor, args.storyId, store, args.phase, ctx.root);
    }

    // Stop an unregistered or improvised implementation worker before REVIEW
    // mints a round or starts managed reviewers. Commit author text alone is
    // attribution and cannot satisfy this process-evidence boundary.
    if (args.phase === 'REVIEW' && story.phase === 'DEV') {
      runImplementationWorkerAuthorityGate(ctx, args.storyId);
    }

    let scopeGateReport = acceptanceTopologyGateReport + preReviewGateReport;
    let guardGateReport = runtimeGateReport;
    if (args.phase === 'REVIEW' || args.phase === 'TEST' || args.phase === 'DONE') {
      scopeGateReport = preReviewGateReport + runScopeTransitionGate(ctx, args.storyId, args.phase);
      // B-6bfd CHK-004: guard session projection gate — blocks on recorded
      // forbidden writes. Backward compatible: stories without a guard session
      // get '' and are unaffected.
      guardGateReport = runGuardSessionGate(ctx, args.storyId, args.phase);
    }
    // PLAN→DEV: soft advisory when a new-scope story has no scope contract yet.
    // Does not block — advisory only; REVIEW will hard-block if still missing.
    if (args.phase === 'DEV') {
      scopeGateReport += runPlanToDevScopeAdvice(ctx, args.storyId);
    }

    // B-56d3: REVIEW→TEST CLI preflight gate (runReviewToTestPreflightGate).
    // B-6974: gate no longer stops the actor; the orchestrator's finally does.
    if (args.phase === 'TEST' && story.phase === 'REVIEW') {
      await runReviewToTestPreflightGate(ctx, args.storyId, actor);
    }

    // B-56d3: DEV→TEST proof-or-stop validate gate (runValidateGate). The verifier is
    // the sole writer of canonical test-evidence; the gate only consumes JSON.
    // B-6974: gate no longer stops the actor; the orchestrator's finally does.
    if (args.phase === 'TEST') {
      await runValidateGate(ctx, args.storyId, actor);
      guardGateReport += runLegacyReceiptTransitionGate(ctx, args.storyId, 'TEST');
    }

    // TEST→DONE: block A (done-oracle gate + F-020 stray-file dry-run +
    // merge-tree dry-run). Runs BEFORE actor.send so any pre-merge gate failure
    // throws while the story is still TEST. Returns the rendered DONE checklist
    // — held in a local variable here (no global stash) and passed to
    // applyDoneMergeEffects after writeStory.
    // B-6974: the stray-offender path inside runDonePreMergeGate no longer
    // stops the actor; the orchestrator's finally owns that.
    let doneRenderedChecklist: string | undefined;
    if (args.phase === 'DONE') {
      // A locally edited index.json must not gain privilege by claiming that
      // REVIEW→TEST already ran. Re-run every REVIEW→TEST preflight fact at the
      // actual DONE authorization boundary. The index event's local identity
      // strings remain audit-only; review-loop, ProofStory completeness, CLI
      // gates, signed reviewer evidence, scope/guard and validation evidence
      // are independently consumed by their existing mechanical gates.
      await runReviewToTestPreflightGate(ctx, args.storyId, actor);
      // B-6666 CHK-001: thread the SAME doneGitCwd resolved once above (no
      // re-resolve, preMortem #4) so the DONE-oracle git-status probe runs in
      // the real gitRoot on wrapper-root layouts instead of the bare ctx.root.
      doneRenderedChecklist = await runDonePreMergeGate(args.storyId, store, ctx.root, actor, doneGitCwd);
      guardGateReport += runLegacyReceiptTransitionGate(ctx, args.storyId, 'DONE');
    }

    // Keep the TEST phase transaction short. The direct verifier gate closes
    // its own evidence/terminal/receipt transaction before returning, so this
    // clean capture owns only the subsequent phase/index/metrics writes. Any
    // foreign bytes left by the gate are rejected here rather than adopted.
    let testTransitionCapture: LifecycleMetadataTransaction | null = null;
    let transitionGitCwd = '';
    if (args.phase === 'TEST') {
      transitionGitCwd = resolveGitCwd({
        store,
        storyId: args.storyId,
        metadataRoot: ctx.root,
        projectRoot: ctx.root,
      });
      const storyRel = relative(
        realpathSync(transitionGitCwd),
        realpathSync(store.storyDirPath(args.storyId)),
      );
      testTransitionCapture = captureLifecycleMetadataTransaction({
        root: transitionGitCwd,
        gitCwd: transitionGitCwd,
        storyId: args.storyId,
        storyRel,
        kind: 'test-transition',
      });
    }

    // B-0e53: pre-merge integration branch sha re-check. This point is AFTER the slow
    // runDonePreMergeGate (so it covers that window) and strictly BEFORE
    // store.writeStory persists phase=DONE. If the integration branch advanced
    // EXTERNALLY between the pre-check sync (where syncedIntegrationSha was captured) and here, abort
    // before any partial DONE is written — nothing is merged and the story stays
    // at TEST. The throw propagates to the existing try/finally which releases
    // the DONE merge lock; no new lock handling is added here. FAIL-OPEN: if
    // either read returns undefined (transient git error), do NOT abort — only a
    // confirmed change (both reads succeeded and differ) trips the abort.
    if (args.phase === 'DONE' && syncedIntegrationSha !== undefined) {
      const currentIntegrationSha = readIntegrationBranchSha(doneGitCwd, doneIntegrationBranch);
      if (currentIntegrationSha !== undefined && currentIntegrationSha !== syncedIntegrationSha) {
        throw new Error(
          `DONE aborted: ${doneIntegrationBranch} advanced (${syncedIntegrationSha.slice(0, 7)} -> ${currentIntegrationSha.slice(0, 7)}) after the pre-check sync; ` +
          `nothing was merged and the story stays at TEST. Re-run story_advance DONE to resync.`,
        );
      }
    }

    // ── state mutation: actor.send → writeStory. Order is byte-identical to
    // the inline original — actor.send first, then phase is persisted.
    actor.send({ type: eventType } as any);
    const newState = getStateName(actor);
    assertStoryTransitionReachedTarget(args.storyId, eventType, args.phase, newState);

    if (args.phase === 'DONE') {
      const closeoutCapture = captureMilestoneCloseoutSnapshotFromStore(store, args.storyId, {
        currentEvidenceBinding: currentMilestoneStatusEvidenceBinding(doneGitCwd, ctx.root),
      });
      if (closeoutCapture.status === 'written') {
        ctx.log?.(`✓ milestone closeout snapshot captured for ${args.storyId}`);
      } else {
        ctx.log?.(`ℹ ${closeoutCapture.message}`);
      }
    }

    // IDEA→PLAN: BUILD the checklist to write. B-d877 R4 FIX F-012: the WRITE is
    // deferred INTO the atomic persist claim's critical section below (co-located
    // with the phase writeStory), so it becomes atomically conditional on the
    // pre-write phase re-read guard too. Building the object here is a pure,
    // side-effect-free computation; only its persist moves. A losing concurrent
    // PLAN transition aborts at the re-read guard BEFORE writing either the
    // checklist or the story, so a loser's checklist can never land on disk.
    let checklistToWrite: ChecklistData | undefined;
    if (args.phase === 'PLAN' && args.checklist && args.checklist.length > 0) {
      checklistToWrite = {
        items: args.checklist.map(c => ({
          id: c.id,
          title: c.title,
          status: 'pending' as const,
          startTime: null,
          endTime: null,
        })),
      };
    }

    // Persist state
    const now = new Date().toISOString();
    if (args.phase === 'PLAN' && !story.startedAt) {
      story.startedAt = now;
    }
    if (args.phase === 'DONE') {
      story.endedAt = now;
    }
    story.phase = newState as StoryPhase;
    if (!story.events) story.events = [];
    story.events.push(collectContext(args.phase, 'advance'));
    // When advancing to REVIEW, generate a new review round ID
    if (args.phase === 'REVIEW') {
      story.currentReviewRound = now;
    }
    // B-70a6 F-004: the gated PLAN->INIT reopen's DURABLE audit record.
    //
    // The audit facts (validated reason + reopen marker) belong to an append-only
    // process event, but the phase write and the event append are two separate fs
    // operations with git subprocess calls in between (resolveGitCwd +
    // currentMaterialHash/currentStoryFilesHash below), so the window is real, not
    // theoretical. A crash there used to leave phase=INIT with NO audit record,
    // and — because REOPEN only fires FROM PLAN — the story had already left the
    // only phase that could retry it, making the event UNRECOVERABLE.
    //
    // Fix: attach the audit facts to the STORY OBJECT here, so the writeStory
    // below persists them in the SAME tmp-write + renameSync as phase=INIT (see
    // StoryStore.writeJsonFile). One atomic rename, so the two can never disagree:
    // either the reopen did not commit, or it committed WITH its reason on disk.
    // The record is cleared right after the event lands. A crash in between leaves
    // the reopen RECOVERABLE — NOT automatically healed by whatever transition
    // happens to run next, which is a stronger promise than the code keeps (B-70a6
    // F-017 retired that unqualified wording here, as F-016 did in the
    // StoryInfo.pendingReopenAudit docblock).
    // reconcilePendingReopenAudit re-emits the missing event at the next
    // ORCHESTRATED transition, OR reconcileReopenAuditBeforeOutOfBandPhaseChange
    // does it at the two out-of-band phase writers — story_discard and the
    // repairing story_reconcile — before they destroy the copy holding the record;
    // never on an arbitrary read-only command. And the guarantee is SEQUENTIAL
    // (B-70a6 F-013): a record ALREADY on disk when one of those runs is recovered,
    // while a reopen RACING a concurrent terminal operation is not recovered at all.
    // Until one of them runs the validated reason is still durable and visible here.
    //
    // Built BEFORE the persist claim on purpose: its git reads must not run inside
    // the claim's deliberately short, fully-synchronous critical section. Nothing
    // is persisted until the writeStory inside the claim, so an abort at the claim
    // or at the oldPhase re-read guard leaves NO record — an aborted reopen still
    // produces neither a record nor an event.
    let reopenAudit: PendingReopenAudit | undefined;
    if (eventType === 'REOPEN') {
      if (!transitionGitCwd) {
        transitionGitCwd = resolveGitCwd({
          store,
          storyId: args.storyId,
          metadataRoot: ctx.root,
          projectRoot: ctx.root,
        });
      }
      reopenAudit = {
        auditId: `${args.storyId}:RA-${randomUUID()}`,
        reason: (args.reason ?? '').trim(),
        fromPhase: oldPhase,
        at: now,
        materialHash: currentMaterialHash(transitionGitCwd, 'HEAD', ctx.root) ?? '',
        storyFilesHash: currentStoryFilesHash(transitionGitCwd, 'HEAD', ctx.root) ?? '',
        reviewRound: story.currentReviewRound ?? '',
      };
      story.pendingReopenAudit = reopenAudit;
    }
    let remediationCutoff: { materialHash: string; storyFilesHash?: string } | undefined;
    // Old-PoS run 25 F2: material changed since the round began and no finding
    // is open -> the framework-owned review reopen (no remediation receipt is
    // consumed; the round's open/unconsumed inventory epoch is cancelled; the
    // reason is recorded on the phase_transition).
    let reviewReopen: ReviewMaterialReopenDecision | undefined;
    if (oldPhase === 'REVIEW' && args.phase === 'DEV') {
      if (!transitionGitCwd) {
        transitionGitCwd = resolveGitCwd({
          store,
          storyId: args.storyId,
          metadataRoot: ctx.root,
          projectRoot: ctx.root,
        });
      }
      const decision = evaluateReviewMaterialReopen({ store, storyId: args.storyId, gitCwd: transitionGitCwd, metadataRoot: ctx.root });
      if (decision.eligible) reviewReopen = decision;
      const remediationSnapshot = captureEvidenceHashSnapshot({
        gitCwd: transitionGitCwd,
        metadataRoot: ctx.root,
        ref: 'HEAD',
        trustedControllerProjectionStoryId: args.storyId,
      });
      if (remediationSnapshot.materialDirtyFiles.length > 0) {
        throw new Error(`REVIEW_INVENTORY_REMEDIATION_BLOCKED: current material worktree is dirty (${remediationSnapshot.materialDirtyFiles.join(', ')})`);
      }
      remediationCutoff = {
        materialHash: remediationSnapshot.materialHash ?? '',
        storyFilesHash: remediationSnapshot.storyFilesHash ?? '',
      };
    }
    // B-d877 R3 FIX A: ATOMIC persist claim — the AUTHORITATIVE correctness fence.
    //
    // The R2 fence was a plain read-then-write ("re-read phase, then writeStory"):
    // two concurrent transitions could BOTH re-read the still-`oldPhase` on-disk
    // state before EITHER wrote, pass the check, and both persist → double-mint
    // (duplicate review round / duplicate phase_transition event). The advisory
    // transition lock reduces contention but does NOT itself make this window
    // atomic (a mis-classified/stale-reclaimed advisory lock can let two writers
    // reach here concurrently). So the write is instead gated by an ATOMIC `mkdir`
    // CLAIM: `mkdir` of a fresh dir is atomic on POSIX, so exactly ONE concurrent
    // writer creates the claim and the loser throws IMMEDIATELY (failFastIfHeld).
    // Under the claim we RE-READ the on-disk phase and abort unless it still equals
    // `oldPhase`, then writeStory — making the persist atomically conditional on
    // `oldPhase`. The claim is held ONLY across re-read → write (milliseconds), so a
    // short staleMs (15s) + failFast is safe and a crashed holder's claim
    // self-reclaims in 15s. This covers BOTH the non-DONE and DONE persist (they
    // share this one writeStory). The advisory transition lock and the in-process
    // fail-fast guard remain as contention reducers; THIS atomic claim — not the
    // lock — is what prevents a double-mint under the practical threat model (see
    // KNOWN LIMITATION below for the sole residual: an OS-level freeze longer than
    // staleMs, outside the software-concurrency threat model).
    //
    // KNOWN LIMITATION (B-d877 R4, codex #1 residual — deliberately deferred):
    // this atomic claim uses a TIME-BASED stale reclaim (staleMs=15s), so it is
    // NOT an absolute mutex against a holder that is OS-level frozen (e.g.
    // SIGSTOP) for LONGER than staleMs in the middle of the persist — a waiter
    // could then stale-reclaim a still-live holder's claim. Mitigation in place:
    // the persist critical section (claim acquire → phase re-read → checklist +
    // story write → release) is FULLY SYNCHRONOUS — there is NO `await` between
    // acquire and release — so the JS runtime cannot preempt a live holder
    // mid-section; only an external multi-second OS process freeze could trigger
    // a stale-reclaim of a live holder, which is outside the software-concurrency
    // threat model and is recoverable (re-run story_advance). Full fencing-token
    // hardening (a monotonic generation checked at commit, with crash → explicit
    // recovery instead of a time reclaim) is a deliberately-deferred follow-up.
    const persistClaimPath = join(
      resolveSharedLockRoot(ctx.root),
      PROOF_OR_STOP_DIR, 'locks', 'transition-cas',
      `${sanitizeLockSegment(args.storyId)}.claim`,
    );
    let persistClaim: AcquiredMkdirLock;
    try {
      persistClaim = acquireMkdirLock(persistClaimPath, {
        failFastIfHeld: true,
        staleMs: 15000,
        requireHolderToken: true,
        holderInfo: {
          pid: process.pid,
          hostname: hostname(),
          command: `transition persist claim ${args.storyId} ${oldPhase}->${args.phase}`,
          acquiredAt: new Date().toISOString(),
        },
      });
    } catch (claimErr: any) {
      // The claim is held → a concurrent transition is persisting this same story.
      throw new Error(
        `concurrent transition already advancing ${args.storyId} from ${oldPhase}; ` +
        `aborting to prevent double-mint (${String(claimErr?.message ?? claimErr)})`,
      );
    }
    try {
      const persistedBeforeWrite = store.readStory(args.storyId);
      if ((persistedBeforeWrite.phase as string) !== oldPhase) {
        throw new Error(
          `concurrent transition already advanced ${args.storyId} ` +
          `(expected fromPhase ${oldPhase}, found ${persistedBeforeWrite.phase}); ` +
          `aborting to prevent double-mint`,
        );
      }
      // B-d877 R4 FIX F-012: write the IDEA→PLAN checklist INSIDE the claim,
      // immediately before the phase writeStory, so BOTH writes are atomically
      // conditional on the oldPhase re-read guard above. Two concurrent PLAN
      // transitions previously wrote the checklist BEFORE acquiring the claim, so
      // the LOSING transition's checklist still landed on disk even though its
      // phase write aborted. Co-locating the checklist write here makes the loser
      // abort at the guard before writing EITHER file.
      if (checklistToWrite) {
        store.writeChecklist(args.storyId, checklistToWrite);
      }
      // B-8b69 (F-005/F-006): reopening to INIT unfreezes the checklist title/context,
      // so any item that already reached done/in_progress MUST be reset to pending —
      // otherwise a story that went DEV -> REPLAN -> PLAN -> reopen could retitle an
      // already-done item with no re-verification, silently decoupling the requirement
      // from the delivered code (the tampering the INIT_CHECK freeze prevents, which
      // decision.json promises the reopen preserves). This synchronous read-mutate-write
      // is co-located INSIDE the persist claim (F-006) and ORDERED so the phase=INIT
      // writeStory below runs LAST.
      //
      // Exact guarantee. CONCURRENCY-atomic: the persist claim is a mkdir lock
      // (core/mkdir-lock.ts — mkdirSync of a fresh dir IS the atomic acquire, EEXIST means
      // held), so only one writer at a time runs the reset+phase pair, and a loser aborts at
      // the oldPhase re-read guard above before writing EITHER file, so it never resets.
      // NOT crash-transactional: the reset (checklist.json) and the phase write (index.json)
      // are two separate fs writes, so a crash or kill between them leaves the checklist
      // reset with the phase still PLAN. Each write is individually tmp+rename
      // (store.writeJsonFile), so that residual is one of exactly two file-consistent
      // states — never a torn checklist.
      //
      // Why that is the safe direction, and it is safe ONLY because the phase write is LAST:
      // no crash can produce the dangerous state — phase=INIT (titles unfrozen) still holding
      // a stale done item — which nothing would later clean up, since REOPEN only fires from
      // PLAN (see the eventType remap above) and so the reset cannot re-run from INIT. The
      // reachable residual costs only the done/in_progress markers that this reopen was
      // deliberately discarding anyway, so a retry converges on exactly the intended end
      // state. It is not free, though: abandon the reopen and those markers stay lost
      // (checklist.json has already been overwritten), so "safe" here means integrity-safe,
      // not recoverable. No-op for the common case (all items already pending).
      if (eventType === 'REOPEN') {
        const reopenChecklist = store.readChecklist(args.storyId);
        let reopenMutated = false;
        for (const item of reopenChecklist.items) {
          if (item.status === 'done' || item.status === 'in_progress') {
            item.status = 'pending';
            item.startTime = null;
            item.endTime = null;
            reopenMutated = true;
          }
        }
        if (reopenMutated) store.writeChecklist(args.storyId, reopenChecklist);
      }
      if (reviewReopen) {
        const cancelledEpoch = cancelReviewInventoryForReopen(store, args.storyId, reviewReopen.reviewRound ?? '', `${REVIEW_REOPEN_TRANSITION_TYPE}: ${reviewReopen.reason}`);
        process.stderr.write(
          `Review reopen: ${reviewReopen.reason}\n`
          + (cancelledEpoch ? `Cancelled the abandoned round's inventory epoch ${cancelledEpoch}\n` : ''),
        );
      } else if (oldPhase === 'REVIEW' && args.phase === 'DEV') {
        // Consume authority before publishing phase=DEV. A consume failure cannot
        // leave unauthorized DEV; a later write failure requires a new epoch.
        const consumedReceiptId = consumeReviewInventoryReceipt(
          store,
          args.storyId,
          story.currentReviewRound ?? '',
          remediationCutoff!,
          () => assertReviewInventoryContextFreshLocked(ctx, args.storyId),
        );
        // B-3f3d F-119: CHK-004's userSees promises the accepted rollback reports which epoch
        // authorized it, the aggregate finding count, and that the receipt does NOT authorize
        // TEST. The consume was silent, so an operator could not see any of that. Reported from
        // the consumed record itself -- the epoch id and family count are read back, not
        // recomputed, so the line cannot drift from what was actually consumed.
        if (consumedReceiptId) {
          const consumedEpoch = store.readReviewInventoryEpochs(args.storyId)
            .epochs.filter((row: { state?: string }) => row.state === 'FINALIZED').slice(-1)[0];
          const familyCount = consumedEpoch
            ? new Set(consumedEpoch.waves.flatMap(wave => wave.verifiedFindingFamilies)).size
            : 0;
          process.stderr.write(
            `Remediation authorized once by epoch ${consumedEpoch?.epochId ?? consumedReceiptId}\n`
            + `Aggregate verified finding families: ${familyCount}\n`
            + 'This receipt does not authorize TEST\n',
          );
        }
      }
      store.writeStory(args.storyId, story);
    } finally {
      // Release only across the re-read→write critical section (milliseconds).
      persistClaim.release();
    }
    if (!transitionGitCwd) {
      transitionGitCwd = resolveGitCwd({
        store,
        storyId: args.storyId,
        metadataRoot: ctx.root,
        projectRoot: ctx.root,
      });
    }
    // B-70a6 F-004: for a REOPEN the evidence-binding facts come from the record
    // that was just persisted atomically with phase=INIT, so this in-line append
    // and a crash-recovered append describe the SAME reopen with the SAME values
    // (modulo the event timestamp) instead of merely being expected to agree. An
    // ordinary transition has no record, so it computes them exactly as before.
    const transitionEventFacts = reopenAudit ?? {
      materialHash: currentMaterialHash(transitionGitCwd, 'HEAD', ctx.root) ?? '',
      storyFilesHash: currentStoryFilesHash(transitionGitCwd, 'HEAD', ctx.root) ?? '',
      reviewRound: story.currentReviewRound ?? '',
    };
    store.appendProcessEvent(args.storyId, buildPhaseTransitionProcessEvent({
      storyId: args.storyId,
      fromPhase: oldPhase,
      toPhase: newState,
      materialHash: transitionEventFacts.materialHash,
      storyFilesHash: transitionEventFacts.storyFilesHash,
      reviewRound: transitionEventFacts.reviewRound,
      // B-8b69 follow-up: the gated PLAN->INIT reopen reason is validated above
      // (>= REOPEN_REASON_MIN chars) but was previously dropped here. Persist it —
      // with a transitionType marker distinguishing a reopen from a forward
      // transition — into this append-only, only-on-success phase_transition event
      // so the reopen is durably auditable. Set ONLY for REOPEN; every normal
      // transition passes none of these fields and keeps its exact prior event shape.
      // B-70a6 F-004 adds reopenAuditId, the recovery idempotency key.
      ...(eventType === 'REOPEN'
        ? { transitionType: 'reopen', reason: args.reason?.trim(), reopenAuditId: reopenAudit?.auditId }
        : reviewReopen
          ? { transitionType: REVIEW_REOPEN_TRANSITION_TYPE, reason: reviewReopen.reason }
          : {}),
    }));
    // B-70a6 F-004: the reopen is now durably audited, so retire its recovery
    // record. Deliberately the SAME entry point EVERY recovery path uses after a
    // crash: it re-reads the log, matches THIS auditId, and clears WITHOUT
    // appending a second event — one code path, so the normal and recovery paths
    // cannot drift apart. A crash before this line leaves the record on disk, and
    // the (identical) recovery is performed at the next ORCHESTRATED transition, or
    // by reconcileReopenAuditBeforeOutOfBandPhaseChange at the out-of-band phase
    // writers story_discard / the repairing story_reconcile (B-70a6 F-005) — never
    // on an arbitrary read-only command, and only SEQUENTIALLY (B-70a6 F-013): a
    // reopen RACING a concurrent terminal operation is not recovered at all.
    // (B-70a6 F-017: this used to promise the recovery unqualified, as if whatever
    // transition ran next always performed it — the retired over-claim F-016 fixed
    // in the StoryInfo.pendingReopenAudit docblock.)
    if (reopenAudit) {
      reconcilePendingReopenAudit(store, args.storyId);
    }

    // ── post effects. B-56d3: non-DONE transition effects in
    // transition-effects.ts; each call site stays in the exact order it ran
    // inline — effect order, output text, and timing are byte-identical.

    // B-abd8: auto-recompute process metrics on DEV/TEST/DONE transitions.
    if (args.phase === 'DEV' || args.phase === 'TEST' || args.phase === 'DONE') {
      recomputeProcessMetrics(args.storyId, store, ctx.root);
    }

    const testTransitionOutput = testTransitionCapture
      ? readLifecycleMetadataOutputHashes({
        root: transitionGitCwd,
        capture: testTransitionCapture,
      })
      : null;

    // onPhaseChange hook — fires after the new phase is persisted.
    await runPhaseChangeHooks(ctx.root, args.storyId, args, oldPhase, newState);

    let metadataCommitReport = '';
    if (args.phase === 'REVIEW') {
      metadataCommitReport = commitReviewMetadata(ctx.root, args.storyId, args.phase);
    } else if (testTransitionCapture && testTransitionOutput) {
      const committed = commitLifecycleMetadataTransaction({
        root: transitionGitCwd,
        gitCwd: transitionGitCwd,
        storyId: args.storyId,
        capture: testTransitionCapture,
        verifiedHashes: testTransitionOutput.ok ? testTransitionOutput.hashes : new Map(),
      });
      if (!committed.ok) {
        throw new Error(
          `TEST transition canonical metadata closeout failed: ${
            testTransitionOutput.ok ? '' : `${testTransitionOutput.reason}; `
          }${committed.reason}`,
        );
      }
      if (committed.commitSha) {
        metadataCommitReport = `\n✓ proof-or-stop metadata auto-committed: proof-or-stop: record ${args.storyId} test-transition metadata (${committed.commitSha.slice(0, 7)})`;
      }
    }

    // CHK-002: collect relatedDocs on PLAN→DEV / DONE.
    let docsHint = '';
    if (args.phase === 'DEV' || args.phase === 'DONE') {
      docsHint = renderRelatedDocsHint(store, ctx.root, args.storyId, args.phase);
    }

    const nextSteps: Record<string, string> = buildNextSteps(store, ctx.root, args.storyId);
    let doneChecklistPrefix = '';
    let doneSummarySuffix = '';
    let doneMergeReport = '';
    let postTransitionRoot = ctx.root;
    if (args.phase === 'DONE') {
      // After DONE succeeds, append the summary content to the return value.
      try {
        const summary = store.readSummary(args.storyId);
        if (summary) {
          doneSummarySuffix = `\n\n${renderSummaryForHint(summary)}`;
        }
      } catch { /* ignore */ }

      // B-9027 (Story 3b): block B (real merge / worktree cleanup +
      // maybeTriggerAudit). Runs AFTER writeStory(phase=DONE) — the exact
      // timing of the inline original. The rendered DONE checklist produced by
      // runDonePreMergeGate is passed in here (no global stash).
      const doneEffects = await applyDoneMergeEffects(args.storyId, store, story, doneRenderedChecklist);
      doneChecklistPrefix = doneEffects.doneChecklistPrefix;
      doneMergeReport = doneEffects.doneMergeReport;
      postTransitionRoot = doneEffects.mainMergeRoot ?? ctx.root;

      // B-6241 M3: post-DONE learning settlement runs only after durable DONE
      // effects, and only after the lifecycle main write lock is released. The
      // helper is best-effort and returns a status line instead of throwing.
      doneMainMergeLock?.release();
      doneMainMergeLock = undefined;
      const settlement = runPostDoneLearningSettlement(doneEffects.mainMergeRoot ?? ctx.root, args.storyId);
      const settlementLine =
        `playbook learning settlementStatus: ${settlement.settlementStatus}; ` +
        `alreadyApplied: ${settlement.alreadyApplied}; ${settlement.message}; ` +
        `candidateIngestStatus: ${settlement.candidateIngestStatus}; ` +
        `candidateIngestAlreadyApplied: ${settlement.candidateIngestAlreadyApplied}; ` +
        `candidateCreatedCount: ${settlement.candidateIngestCandidateCreatedCount}; ` +
        `${settlement.candidateIngestMessage}; ` +
        'authority: non_authoritative; gateEvidence: false';
      doneMergeReport += `${doneMergeReport ? '\n' : '\n\n'}${settlementLine}`;
    }

    // Baseline risk warning: show dirty/untracked files before worktree creation.
    let baselineRiskWarning = '';
    if (args.phase === 'INIT_CHECK' && oldPhase === 'INIT') {
      try {
        const risk = collectBaselineRisk(ctx.root);
        if (risk.materialTotal > 0) {
          const lines = renderBaselineRiskLines(risk);
          baselineRiskWarning = `\n\n⚠ Baseline risk (${risk.materialTotal} uncommitted files may pollute the worktree):\n${lines.map(l => '  ' + l).join('\n')}\n→ Recommend git stash or git commit before creating the worktree`;
        }
      } catch { /* ignore */ }
    }

    // After INIT→INIT_CHECK succeeds, echo non-blocking init reviewer issues.
    let initCheckAdvisory = '';
    if (args.phase === 'INIT_CHECK' && oldPhase === 'INIT') {
      try {
        const initCheck = store.readInitCheck(args.storyId);
        if (initCheck) {
          const allIssues = Array.isArray(initCheck.agentResults) && initCheck.agentResults.length > 0
            ? initCheck.agentResults.flatMap(result => result.issues || [])
            : initCheck.issues || [];
          const advisoryCount = allIssues.filter(
            i => i && typeof i.desc === 'string' && i.desc.trim().length >= 1 && (
              i.severity === 'medium' || i.severity === 'low' || i.kind === 'post_implementation_evidence_missing'
            ),
          ).length;
          if (advisoryCount > 0) {
            initCheckAdvisory = `\n\n⚠ init reviewer recorded ${advisoryCount} non-blocking or deferred issue(s), review them during PLAN and later verification`;
          }
        }
      } catch { /* ignore */ }
    }

    // B-a2f1 CHK-001/002: surface stale verificationEvidence in REVIEW/TEST/DONE.
    let staleEvidenceHint = '';
    if (newState === 'REVIEW' || newState === 'TEST' || newState === 'DONE') {
      try {
        const stale = findStaleEvidence(postTransitionRoot, args.storyId);
        const hint = renderEvidenceStaleHint(args.storyId, stale, { currentHead: currentGitHead(postTransitionRoot) });
        if (hint) staleEvidenceHint = `\n\n${hint}`;
      } catch { /* probe — never block phase advance on stale-hint failure */ }
    }

    const memoryRuntimeAdvisory = renderStoryAdvanceMemoryRuntimeAdvisory(postTransitionRoot, story, args.phase);

    return {
      storyId: args.storyId,
      newState,
      doneChecklistPrefix,
      metadataCommitReport,
      doneMergeReport,
      nextSteps,
      docsHint,
      depsWarning,
      sessionWarning,
      doneSummarySuffix,
      initCheckAdvisory,
      baselineRiskWarning,
      staleEvidenceHint,
      scopeGateReport,
      guardGateReport,
      memoryRuntimeAdvisory,
    };
  } finally {
    // Single owner: the orchestrator stops the actor exactly once on every
    // exit path — success, guard failure, gate failure, or exception. The
    // gate/effect modules no longer stop it themselves.
    actor?.stop();
    // DONE merge lock release — the one try/finally covering the whole
    // transition (runDonePreMergeGate → actor.send → writeStory →
    // applyDoneMergeEffects), equivalent to the old story-advance.ts scope.
    doneMainMergeLock?.release();
    // B-d877 CHK-002: release the per-story transition lock on EVERY exit path
    // (success, guard failure, gate failure, exception) so a throwing
    // critical section cannot leak it (no deadlock for the next transition).
    transitionLock?.release();
  }
}
