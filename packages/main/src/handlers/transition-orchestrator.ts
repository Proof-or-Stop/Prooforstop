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
import { realpathSync } from 'fs';
import { hostname } from 'os';
import { join, relative } from 'path';
import type { HandlerContext } from './context.js';
import { collectContext, PHASE_TO_EVENT, assertCwdInWorktree } from './context.js';
import { createStoryActor, getStateName, canSendStoryEventWithoutSnapshotCan } from '../core/machine.js';
import type { ChecklistData, ProcessEvent, StoryInfo, StoryPhase } from '../core/types.js';
import { checkMetaStoryAdvanceGuard } from '../core/audit-meta-store.js';
import { renderSummaryForHint } from './summary.js';
import { collectBaselineRisk, renderBaselineRiskLines } from '../core/baseline-risk.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { currentMilestoneStatusEvidenceBinding } from '../core/milestone-status.js';
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
import { LATTICE_DIR } from '../core/lattice-paths.js';
import { buildMemoryFreshnessPack, renderMemoryFreshnessPack } from '../core/playbook-runtime-memory.js';
import { surfaceRuntimeMemoryPack } from '../core/experience-pack-surface.js';
import {
  captureLifecycleMetadataTransaction,
  commitLifecycleMetadataTransaction,
  readLifecycleMetadataOutputHashes,
  type LifecycleMetadataTransaction,
} from '../core/auto-commit-metadata.js';
import { evaluateAcceptanceTopologyForContext, evaluatePreReviewCheckForContext } from './proofstory.js';

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
    throw new Error(`Cannot enter REVIEW: executable pre-review gate blocked DEV admission.${rendered}\n\n-> Run lattice pre_review_check after current evidence, then obtain the independent topology-critic re-attestation when enforce mode requires it.`);
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
   * the REOPEN event is sent.
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
    detail: 'only Proofbound metadata/runtime/declared-artifact dirty state was detected',
  };
}

function runRuntimeEnforcementPreflight(
  ctx: HandlerContext,
  story: StoryInfo,
  targetPhase: StoryPhase,
): string {
  const mode = normalizeRuntimeEnforcementMode(loadConfig(ctx.root).lifecycleControl?.runtimeEnforcement);
  if (mode === 'unavailable') return '';

  const report = projectRuntimeClosure(ctx.store, ctx.root, {
    storyId: story.storyId,
    activeOnly: false,
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
 * B-0e53: read main's commit sha in `gitCwd`, or undefined if unreadable.
 *
 * Used to capture main's sha right AFTER the DONE pre-check autoSyncMain and to
 * re-read it just BEFORE store.writeStory persists phase=DONE. A CONFIRMED change
 * between the two reads means main advanced externally (between the pre-check
 * sync and the in-lock merge) and the DONE transition must abort before any
 * partial DONE is written. FAIL-OPEN: an unreadable sha (transient git error)
 * returns undefined and must NOT abort the common DONE path — only two
 * successful reads that DIFFER constitute a confirmed external advance.
 */
function readMainSha(gitCwd: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'main^{commit}'], {
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
 *   guard check (actor.can) → [REVIEW→TEST preflight gate] → [validate gate] →
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
  };
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
  let syncedMainSha: string | undefined;
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
    transitionLock = acquireStoryTransitionLock(ctx.root, args.storyId);

    // B-9bd9 CHK-002: meta-story never enters DONE (long-lived cross-story container, only carries findings)
    const metaGuardErr = checkMetaStoryAdvanceGuard(args.storyId, args.phase);
    if (metaGuardErr) {
      throw new Error(metaGuardErr);
    }

    const story = store.readStory(args.storyId);
    const oldPhase: string = story.phase as string;
    const runtimeGateReport = runRuntimeEnforcementPreflight(ctx, story, args.phase);

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
      preReviewGateReport = runPreReviewCheckGate(ctx, args.storyId);
    }

    // Dependency completion check (soft warning, non-blocking)
    let depsWarning = '';
    if (story.depends && story.depends.length > 0) {
      const unfinished: string[] = [];
      for (const depId of story.depends) {
        try {
          const dep = store.readStory(depId);
          if (dep.phase !== 'DONE') {
            unfinished.push(`${depId}(${dep.phase})`);
          }
        } catch {
          unfinished.push(`${depId}(not found)`);
        }
      }
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
      const divergence = checkMainDivergence(doneGitCwd);
      if (divergence.needsSync) {
        ctx.log?.(`DONE pre-check: current branch is ${divergence.behind} commits behind main, auto-syncing...`);
        const syncResult = autoSyncMain(doneGitCwd);
        if (syncResult.ok) {
          ctx.log?.(`✓ ${syncResult.message}`);
        } else {
          ctx.log?.(`⚠ ${syncResult.message}`);
        }
      }
      // B-0e53: capture main's sha AFTER autoSyncMain so Proofbound's own sync is
      // already in the baseline. The re-check before writeStory compares against
      // this; only an EXTERNAL advance after this point trips the abort.
      syncedMainSha = readMainSha(doneGitCwd);
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
          `Re-run: lattice story_advance '{"storyId":"${args.storyId}","phase":"INIT","reason":"<why>"}'.`,
        );
      }
    }

    const canSend = canSendStoryEvent(actor, eventType, args.storyId, store, ctx.root, args.phase === 'DONE' ? doneGitCwd : undefined);
    if (!canSend) {
      // B-56d3: cwd/guard-failure adapter in phase-gates.ts. B-6974: it no
      // longer stops the actor — the orchestrator's finally owns that.
      throw resolveGuardFailure(actor, args.storyId, store, args.phase, ctx.root);
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

    // B-56d3: DEV→TEST lattice validate gate (runValidateGate). The verifier is
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

    // B-0e53: pre-merge mainSha re-check. This point is AFTER the slow
    // runDonePreMergeGate (so it covers that window) and strictly BEFORE
    // store.writeStory persists phase=DONE. If main advanced EXTERNALLY between
    // the pre-check sync (where syncedMainSha was captured) and here, abort
    // before any partial DONE is written — nothing is merged and the story stays
    // at TEST. The throw propagates to the existing try/finally which releases
    // the DONE merge lock; no new lock handling is added here. FAIL-OPEN: if
    // either read returns undefined (transient git error), do NOT abort — only a
    // confirmed change (both reads succeeded and differ) trips the abort.
    if (args.phase === 'DONE' && syncedMainSha !== undefined) {
      const currentMainSha = readMainSha(doneGitCwd);
      if (currentMainSha !== undefined && currentMainSha !== syncedMainSha) {
        throw new Error(
          `DONE aborted: main advanced (${syncedMainSha.slice(0, 7)} -> ${currentMainSha.slice(0, 7)}) after the pre-check sync; ` +
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
      LATTICE_DIR, 'locks', 'transition-cas',
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
    store.appendProcessEvent(args.storyId, buildPhaseTransitionProcessEvent({
      storyId: args.storyId,
      fromPhase: oldPhase,
      toPhase: newState,
      materialHash: currentMaterialHash(transitionGitCwd, 'HEAD', ctx.root) ?? '',
      storyFilesHash: currentStoryFilesHash(transitionGitCwd, 'HEAD', ctx.root) ?? '',
      reviewRound: story.currentReviewRound ?? '',
    }));

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
        metadataCommitReport = `\n✓ lattice metadata auto-committed: lattice: record ${args.storyId} test-transition metadata (${committed.commitSha.slice(0, 7)})`;
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
            i => i && typeof i.desc === 'string' && i.desc.trim().length >= 1 && (i.severity === 'medium' || i.severity === 'low'),
          ).length;
          if (advisoryCount > 0) {
            initCheckAdvisory = `\n\n⚠ init reviewer recorded ${advisoryCount} medium/low advisories, recommend digesting them before PLAN`;
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
