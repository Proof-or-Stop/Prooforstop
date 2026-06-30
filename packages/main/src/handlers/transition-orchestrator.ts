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
import type { HandlerContext } from './context.js';
import { collectContext, PHASE_TO_EVENT, assertCwdInWorktree } from './context.js';
import { createStoryActor, getStateName, canSendStoryEventWithoutSnapshotCan } from '../core/machine.js';
import type { StoryInfo, StoryPhase } from '../core/types.js';
import { checkMetaStoryAdvanceGuard } from '../core/audit-meta-store.js';
import { renderSummaryForHint } from './summary.js';
import { collectBaselineRisk, renderBaselineRiskLines } from '../core/baseline-risk.js';
import { currentGitHead } from '../core/evidence-freshness.js';
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
} from './done-effects.js';
import { runWithMainWriteLockContext } from '../core/main-write-lock.js';

/** Arguments for one story_advance transition. */
export interface StoryTransitionArgs {
  storyId: string;
  phase: StoryPhase;
  checklist?: Array<{ id: string; title: string }>;
}

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
    `${result.initCheckAdvisory}${result.baselineRiskWarning}${result.staleEvidenceHint}`
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

async function runStoryTransitionInner(
  ctx: HandlerContext,
  args: StoryTransitionArgs,
): Promise<TransitionResult> {
  const { store } = ctx;
  let doneMainMergeLock: ReturnType<typeof acquireDoneMainMergeLock> | undefined;
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
    if (CWD_GATED.includes(args.phase) && story.worktree) {
      assertCwdInWorktree(store, args.storyId);
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

    const canSend = canSendStoryEvent(actor, eventType, args.storyId, store, ctx.root, args.phase === 'DONE' ? doneGitCwd : undefined);
    if (!canSend) {
      // B-56d3: cwd/guard-failure adapter in phase-gates.ts. B-6974: it no
      // longer stops the actor — the orchestrator's finally owns that.
      throw resolveGuardFailure(actor, args.storyId, store, args.phase, ctx.root);
    }

    let scopeGateReport = '';
    let guardGateReport = runtimeGateReport;
    if (args.phase === 'REVIEW' || args.phase === 'TEST' || args.phase === 'DONE') {
      scopeGateReport = runScopeTransitionGate(ctx, args.storyId, args.phase);
      // B-6bfd CHK-004: guard session projection gate — blocks on recorded
      // forbidden writes. Backward compatible: stories without a guard session
      // get '' and are unaffected.
      guardGateReport = runGuardSessionGate(ctx, args.storyId, args.phase);
    }
    // PLAN→DEV: soft advisory when a new-scope story has no scope contract yet.
    // Does not block — advisory only; REVIEW will hard-block if still missing.
    if (args.phase === 'DEV') {
      scopeGateReport = runPlanToDevScopeAdvice(ctx, args.storyId);
    }

    // B-56d3: REVIEW→TEST CLI preflight gate (runReviewToTestPreflightGate).
    // B-6974: gate no longer stops the actor; the orchestrator's finally does.
    if (args.phase === 'TEST' && story.phase === 'REVIEW') {
      await runReviewToTestPreflightGate(ctx, args.storyId, actor);
    }

    // B-56d3: DEV→TEST lattice validate gate (runValidateGate). It still writes
    // test-evidence.json on PASS and on execution-error — timing unchanged.
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
      // B-6666 CHK-001: thread the SAME doneGitCwd resolved once above (no
      // re-resolve, preMortem #4) so the DONE-oracle git-status probe runs in
      // the real gitRoot on wrapper-root layouts instead of the bare ctx.root.
      doneRenderedChecklist = await runDonePreMergeGate(args.storyId, store, ctx.root, actor, doneGitCwd);
      guardGateReport += runLegacyReceiptTransitionGate(ctx, args.storyId, 'DONE');
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

    // IDEA→PLAN: write checklist
    if (args.phase === 'PLAN' && args.checklist && args.checklist.length > 0) {
      const checklist = {
        items: args.checklist.map(c => ({
          id: c.id,
          title: c.title,
          status: 'pending' as const,
          startTime: null,
          endTime: null,
        })),
      };
      store.writeChecklist(args.storyId, checklist);
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
    store.writeStory(args.storyId, story);

    // ── post effects. B-56d3: non-DONE transition effects in
    // transition-effects.ts; each call site stays in the exact order it ran
    // inline — effect order, output text, and timing are byte-identical.

    // B-abd8: auto-recompute process metrics on DEV/TEST/DONE transitions.
    if (args.phase === 'DEV' || args.phase === 'TEST' || args.phase === 'DONE') {
      recomputeProcessMetrics(args.storyId, store, ctx.root);
    }

    // onPhaseChange hook — fires after the new phase is persisted.
    await runPhaseChangeHooks(ctx.root, args.storyId, args, oldPhase, newState);

    let metadataCommitReport = '';
    if (args.phase === 'REVIEW') {
      metadataCommitReport = commitReviewMetadata(ctx.root, args.storyId, args.phase);
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
        const stale = findStaleEvidence(ctx.root, args.storyId);
        const hint = renderEvidenceStaleHint(args.storyId, stale, { currentHead: currentGitHead(ctx.root) });
        if (hint) staleEvidenceHint = `\n\n${hint}`;
      } catch { /* probe — never block phase advance on stale-hint failure */ }
    }

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
  }
}
