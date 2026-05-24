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

import type { HandlerContext } from './context.js';
import { collectContext, PHASE_TO_EVENT, assertCwdInWorktree } from './context.js';
import { createStoryActor, getStateName } from '../core/machine.js';
import type { StoryPhase } from '../core/types.js';
import { checkMetaStoryAdvanceGuard } from '../core/audit-meta-store.js';
import { renderSummaryForHint } from './summary.js';
import { collectBaselineRisk, renderBaselineRiskLines } from '../core/baseline-risk.js';
import { currentGitHead } from '../core/evidence-freshness.js';
import { findStaleEvidence, renderEvidenceStaleHint } from '../core/evidence-stale-hint.js';
import { checkMainDivergence } from '../core/done-oracle.js';
import {
  resolveGuardFailure,
  runScopeTransitionGate,
  runReviewToTestPreflightGate,
  runValidateGate,
} from './phase-gates.js';
import { runGuardSessionGate } from './guard-session.js';
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
  const { store } = ctx;
  let doneMainMergeLock: ReturnType<typeof acquireDoneMainMergeLock> | undefined;
  // The orchestrator is the SOLE owner of the actor lifecycle. It is assigned
  // inside the try (after the early guards) and unconditionally stopped in the
  // finally — covering success, guard failure, gate failure, and exceptions.
  let actor: ReturnType<typeof createStoryActor> | undefined;
  try {
    // B-9bd9 CHK-002: meta-story 永不进 DONE（跨 story 长存容器，只挂 finding）
    const metaGuardErr = checkMetaStoryAdvanceGuard(args.storyId, args.phase);
    if (metaGuardErr) {
      throw new Error(metaGuardErr);
    }

    const story = store.readStory(args.storyId);
    const oldPhase: string = story.phase as string;

    // CWD 门禁：PLAN/DEV/TEST 阶段必须在 worktree 里执行
    const CWD_GATED: StoryPhase[] = ['PLAN', 'DEV', 'REVIEW', 'TEST'];
    if (CWD_GATED.includes(args.phase) && story.worktree) {
      assertCwdInWorktree(store, args.storyId);
    }

    // 依赖完成度检查（soft warning，不阻塞）
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
        depsWarning = `\n⚠ 依赖未完成: ${unfinished.join(', ')}`;
      }
    }

    // Session 占用检查
    let sessionWarning = '';
    if (args.phase === 'DEV' && story.events) {
      const devEvents = story.events.filter(e => e.phase === 'DEV' && e.action === 'advance');
      if (devEvents.length > 0) {
        const lastDev = devEvents[devEvents.length - 1];
        const currentSession = process.env.KOALA_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
        if (lastDev.sessionId && lastDev.sessionId !== currentSession) {
          const who = lastDev.user || lastDev.agent || 'unknown';
          const when = lastDev.timestamp;
          sessionWarning = `\n⚠ Warning: Story ${args.storyId} 已被 ${who} 于 ${when} 领取开发（session: ${lastDev.sessionId}）`;
          console.error(sessionWarning.trim());
        }
      }
    }

    // IDEA→PLAN 需要 checklist
    if (args.phase === 'PLAN' && story.phase === 'IDEA') {
      if (!args.checklist || args.checklist.length === 0) {
        throw new Error('Cannot advance to PLAN: checklist is required');
      }
    }

    // B-c622 CL-006: auto-sync main BEFORE actor.can() to avoid TOCTOU —
    // guard evaluates post-merge state, not pre-merge state.
    if (args.phase === 'DONE') {
      // B-4c38 CHK-001: serialize every main-affecting DONE operation before
      // any DONE preflight can mutate the story branch or main. The lock spans
      // checkMainDivergence/autoSyncMain, DONE gates, phase persistence, and
      // the real merge/worktree cleanup. A live lock fails before phase=DONE
      // can be written; a stale lock is reclaimed by the mkdir-lock primitive.
      doneMainMergeLock = acquireDoneMainMergeLock(args.storyId, ctx.root);
      const doneWorktree = detectDoneStoryWorktreeContext();
      if (doneWorktree) {
        assertDoneStoryBranchMatches(args.storyId, doneWorktree.branch);
      }
      const divergence = checkMainDivergence(ctx.root);
      if (divergence.needsSync) {
        ctx.log?.(`DONE pre-check: 当前分支落后 main ${divergence.behind} 个提交，自动同步...`);
        const syncResult = autoSyncMain(ctx.root);
        if (syncResult.ok) {
          ctx.log?.(`✓ ${syncResult.message}`);
        } else {
          ctx.log?.(`⚠ ${syncResult.message}`);
        }
      }
    }

    // ── actor lifecycle: created + started here, owned by this orchestrator,
    // stopped exactly once in the finally below. No gate / effect module stops
    // it — they only consume it.
    actor = createStoryActor(args.storyId, store, story.phase, ctx.root);
    actor.start();

    let eventType = PHASE_TO_EVENT[args.phase];
    if (!eventType) {
      throw new Error(`Invalid target phase: ${args.phase}`);
    }
    // 回退映射：目标阶段比当前阶段早时，选择对应的回退事件
    if (args.phase === 'PLAN' && story.phase === 'DEV') {
      eventType = 'REPLAN';
    }
    // TEST→DEV 回退：PHASE_TO_EVENT['DEV']='START' 自动命中

    const canSend = actor.getSnapshot().can({ type: eventType } as any);
    if (!canSend) {
      // B-56d3: cwd/guard-failure adapter in phase-gates.ts. B-6974: it no
      // longer stops the actor — the orchestrator's finally owns that.
      throw resolveGuardFailure(actor, args.storyId, store, args.phase, ctx.root);
    }

    let scopeGateReport = '';
    let guardGateReport = '';
    if (args.phase === 'REVIEW' || args.phase === 'TEST' || args.phase === 'DONE') {
      scopeGateReport = runScopeTransitionGate(ctx, args.storyId, args.phase);
      // B-6bfd CHK-004: guard session projection gate — blocks on recorded
      // forbidden writes. Backward compatible: stories without a guard session
      // get '' and are unaffected.
      guardGateReport = runGuardSessionGate(ctx, args.storyId, args.phase);
    }

    // B-56d3: REVIEW→TEST CLI preflight gate (runReviewToTestPreflightGate).
    // B-6974: gate no longer stops the actor; the orchestrator's finally does.
    if (args.phase === 'TEST' && story.phase === 'REVIEW') {
      await runReviewToTestPreflightGate(ctx, args.storyId, actor);
    }

    // B-56d3: DEV→TEST koala validate gate (runValidateGate). It still writes
    // test-evidence.json on PASS and on execution-error — timing unchanged.
    // B-6974: gate no longer stops the actor; the orchestrator's finally does.
    if (args.phase === 'TEST') {
      await runValidateGate(ctx, args.storyId, actor);
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
      doneRenderedChecklist = await runDonePreMergeGate(args.storyId, store, ctx.root, actor);
    }

    // ── state mutation: actor.send → writeStory. Order is byte-identical to
    // the inline original — actor.send first, then phase is persisted.
    actor.send({ type: eventType } as any);
    const newState = getStateName(actor);

    // IDEA→PLAN：写入 checklist
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

    // 持久化状态
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
    // 推进到 REVIEW 时，生成新的 review round ID
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

    // CHK-002: PLAN→DEV / DONE 时收集 relatedDocs。
    let docsHint = '';
    if (args.phase === 'DEV' || args.phase === 'DONE') {
      docsHint = renderRelatedDocsHint(store, ctx.root, args.storyId, args.phase);
    }

    const nextSteps: Record<string, string> = buildNextSteps(store, ctx.root, args.storyId);
    let doneChecklistPrefix = '';
    let doneSummarySuffix = '';
    let doneMergeReport = '';
    if (args.phase === 'DONE') {
      // DONE 成功后把 summary 内容拼到返回里。
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
          baselineRiskWarning = `\n\n⚠ 基线风险（${risk.materialTotal} 个未提交文件可能污染 worktree）:\n${lines.map(l => '  ' + l).join('\n')}\n→ 建议先 git stash 或 git commit 后再创建 worktree`;
        }
      } catch { /* ignore */ }
    }

    // INIT→INIT_CHECK 成功后 echo non-blocking init reviewer issues。
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
            initCheckAdvisory = `\n\n⚠ init reviewer 记录 ${advisoryCount} 个 medium/low advisory，建议在 PLAN 前消化`;
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
