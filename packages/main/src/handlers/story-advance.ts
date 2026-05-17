
import type { HandlerContext } from './context.js';
import { collectContext, PHASE_TO_EVENT, assertCwdInWorktree } from './context.js';
import { createStoryActor, getStateName } from '../core/machine.js';
import type { StoryPhase } from '../core/types.js';
import { checkMetaStoryAdvanceGuard } from '../core/audit-meta-store.js';
import { renderSummaryForHint } from './summary.js';
import { collectBaselineRisk, renderBaselineRiskLines } from '../core/baseline-risk.js';
import { currentGitHead } from '../core/evidence-freshness.js';
import { findStaleEvidence, renderEvidenceStaleHint } from '../core/evidence-stale-hint.js';
// B-37e9: DONE oracle (buildDoneChecklist + DONE row assembly) extracted into
// core/done-oracle.ts. The DONE gate (B-56d3: now via phase-gates.ts) and
// session_brief consume the same module — a same-source contract test
// (flow-stability-smoke.ts) proves it. checkMainDivergence stays imported here
// for the DONE pre-check autoSyncMain TOCTOU fix.
import { checkMainDivergence } from '../core/done-oracle.js';
// B-56d3 (Lifecycle Phase 2, Story 3a): transition gate runner extracted into
// handlers/phase-gates.ts and non-DONE transition effects into
// handlers/transition-effects.ts. story_advance delegates to them inline at
// the exact same call sites — gate decisions / fail-closed semantics / error
// wording / effect order / output text are byte-identical (preMortem #1/#3).
import {
  resolveGuardFailure,
  runReviewToTestPreflightGate,
  runValidateGate,
} from './phase-gates.js';
import {
  recomputeProcessMetrics,
  runPhaseChangeHooks,
  commitReviewMetadata,
  renderRelatedDocsHint,
  buildNextSteps,
} from './transition-effects.js';
// B-9027 (Lifecycle Phase 2, Story 3b): DONE merge / worktree cleanup pipeline
// extracted into handlers/done-effects.ts. story_advance delegates to the two
// exported functions at the exact same call sites — runDonePreMergeGate before
// actor.send (block A, pre-merge gates / done-oracle), applyDoneMergeEffects
// after writeStory(phase=DONE) (block B, real merge / cleanup). Step order,
// output text, and failure semantics are byte-identical (Option A
// behavior-preserving extraction). The DONE-only helpers
// (detectDoneStoryWorktreeContext / assertDoneStoryBranchMatches / autoSyncMain
// etc.) moved into done-effects.ts too.
import {
  autoSyncMain,
  detectDoneStoryWorktreeContext,
  assertDoneStoryBranchMatches,
  runDonePreMergeGate,
  applyDoneMergeEffects,
} from './done-effects.js';

// B-c622 CHK-004: DONE 阶段自动同步 main —— detect divergence + auto merge main.
// checkMainDivergence moved into core/done-oracle.ts (B-37e9) and is imported
// above. B-9027 (Story 3b): autoSyncMain + the DONE worktree helpers
// (detectDoneStoryWorktreeContext / assertDoneStoryBranchMatches /
// assertSafeResidualWorktreeRm / assertDoneMergeCanApplyBeforeStateMutation /
// isRegisteredWorktree / pruneWorktreeRegistry) moved into
// handlers/done-effects.ts and are imported above. story-advance.ts only keeps
// the early DONE pre-check call sites that use them.

// B-37e9: readGitStatusLines / classifierOptionsForCheck / evaluateDirtyGitStatus
// moved into core/done-oracle.ts together with buildDoneChecklist (they are
// private helpers used only by the DONE row assembly).

// B-37e9: gitRefExists / gitRefContainsMain moved into core/done-oracle.ts
// (private helpers used only by buildDoneChecklist's branch-synced-main row).

// B-9d95 CHK-003: re-export 供 DONE merge 前 stray 文件清理。主实现在独立
// 文件（stray-file-cleanup.ts），logicTest 直接 import，避免把 xstate/machine
// 等重依赖拖进测试进程。
export { cleanStrayWorktreeFiles, STRAY_FILE_WHITELIST } from './stray-file-cleanup.js';


// B-37e9: buildDoneChecklist + DoneCheckRow + doneCheckRow + renderDoneChecklist
// + their private helpers (checkEvidenceFreshness etc.) moved into
// core/done-oracle.ts. buildDoneChecklist / renderDoneChecklist / DoneCheckRow
// are imported above; the DONE gate consumes them unchanged. A thin re-export
// keeps the legacy `./story-advance.js` import path working — there is exactly
// one implementation in core/done-oracle.ts.
export { buildDoneChecklist, type DoneCheckRow } from '../core/done-oracle.js';

export function createStoryAdvanceHandlers(ctx: HandlerContext) {
  const { store } = ctx;

  return {
    async story_advance(args: {
      storyId: string;
      phase: StoryPhase;
      checklist?: Array<{ id: string; title: string }>;
    }): Promise<string> {
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

      const actor = createStoryActor(args.storyId, store, story.phase, ctx.root);
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
        // B-56d3: cwd/guard-failure adapter extracted into phase-gates.ts.
        throw resolveGuardFailure(actor, args.storyId, store, args.phase, ctx.root);
      }

      // B-56d3: REVIEW→TEST CLI preflight gate extracted into phase-gates.ts
      // (runReviewToTestPreflightGate). Same call site, same fail-closed
      // semantics, same error wording — F-019 (B-9d95 Round 1 review): aggregates
      // checkCommitAuthor / checkConcept / checkLint / docs-drift (+ conditional
      // codex-adapter); 任一 fail 即 block; 快速通道走内部 fastChannel 路径。
      if (args.phase === 'TEST' && story.phase === 'REVIEW') {
        await runReviewToTestPreflightGate(ctx, args.storyId, actor);
      }

      // B-56d3: DEV→TEST koala validate gate extracted into phase-gates.ts
      // (runValidateGate). Behavior-preserving side effect: this gate still
      // writes test-evidence.json (annotated in phase-gates.ts) — evidence-write
      // timing unchanged.
      if (args.phase === 'TEST') {
        await runValidateGate(ctx, args.storyId, actor);
      }

      // TEST→DONE 严格门禁：构建并渲染 DONE Final Checklist + pre-merge gates。
      // 无论 advance 成功失败都会输出这份 checklist，强制主 agent 读一遍多层验证状态。
      // 对应 OMX ralph 的 <Final_Checklist>。
      // B-9027 (Story 3b): block A (done-oracle gate + F-020 stray-file dry-run
      // + merge-tree dry-run) extracted into done-effects.ts
      // (runDonePreMergeGate). It runs BEFORE actor.send so any pre-merge gate
      // failure throws while the story is still TEST. It returns the rendered
      // DONE checklist string — held in a local variable here and passed to
      // applyDoneMergeEffects after writeStory (replaces the old globalThis
      // stash). Step order / failure semantics are byte-identical.
      let doneRenderedChecklist: string | undefined;
      if (args.phase === 'DONE') {
        // B-c622 CL-006: autoSyncMain moved before actor.can() to fix TOCTOU.
        doneRenderedChecklist = await runDonePreMergeGate(args.storyId, store, ctx.root, actor);
      }

      actor.send({ type: eventType } as any);
      const newState = getStateName(actor);
      actor.stop();

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

      // B-56d3: non-DONE transition effects extracted into transition-effects.ts.
      // Each call site stays in the exact same order it ran inline — effect
      // order, output text, and timing are byte-identical (preMortem #3).

      // B-abd8: auto-recompute process metrics on DEV/TEST/DONE transitions
      // DEV included so fast-channel stories get initial metrics
      if (args.phase === 'DEV' || args.phase === 'TEST' || args.phase === 'DONE') {
        recomputeProcessMetrics(args.storyId, store, ctx.root);
      }

      // onPhaseChange hook — fires after the new phase is persisted, so the
      // hook can read the up-to-date story state. Failures are non-blocking.
      await runPhaseChangeHooks(ctx.root, args.storyId, args, oldPhase, newState);

      let metadataCommitReport = '';
      if (args.phase === 'REVIEW') {
        metadataCommitReport = commitReviewMetadata(ctx.root, args.storyId, args.phase);
      }

      // CHK-002: PLAN→DEV 时收集所有 relatedDocs 列出来作为开工提醒
      // B-45ed CHK-008: PLAN→DEV 和 DONE 的 docsHint 统一含 background.md
      let docsHint = '';
      if (args.phase === 'DEV' || args.phase === 'DONE') {
        docsHint = renderRelatedDocsHint(store, ctx.root, args.storyId, args.phase);
      }

      const nextSteps: Record<string, string> = buildNextSteps(store, ctx.root, args.storyId);
      let doneChecklistPrefix = '';
      let doneSummarySuffix = '';
      let doneMergeReport = '';
      if (args.phase === 'DONE') {
        // DONE 成功后把 summary 内容拼到返回里，agent 看到后转述给用户
        try {
          const summary = store.readSummary(args.storyId);
          if (summary) {
            doneSummarySuffix = `\n\n${renderSummaryForHint(summary)}`;
          }
        } catch { /* ignore */ }

        // B-9027 (Story 3b): block B (Step1-5 merge / worktree cleanup +
        // maybeTriggerAudit) extracted into done-effects.ts
        // (applyDoneMergeEffects). It runs AFTER writeStory(phase=DONE) — the
        // exact timing of the inline original. The rendered DONE checklist
        // produced by runDonePreMergeGate is passed in here (replaces the old
        // globalThis stash); it is prefixed onto the success message via
        // doneChecklistPrefix. Step order / output text / failure semantics
        // are byte-identical.
        const doneEffects = await applyDoneMergeEffects(args.storyId, store, story, doneRenderedChecklist);
        doneChecklistPrefix = doneEffects.doneChecklistPrefix;
        doneMergeReport = doneEffects.doneMergeReport;
      }

      // Baseline risk warning: show dirty/untracked files before worktree creation
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
      // critical/high 已在 gate 中阻塞；这里仅提示 medium/low。
      // 与 init_check_set 同标准 trim().length >= 1 校验 issue.desc，过滤空白串。
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

      // B-a2f1 CHK-001/002: surface stale verificationEvidence in REVIEW/TEST/DONE
      // pre-check output so a main-merge that drifted materialHash does not
      // produce an opaque pass without naming the recovery commands.
      let staleEvidenceHint = '';
      if (newState === 'REVIEW' || newState === 'TEST' || newState === 'DONE') {
        try {
          const stale = findStaleEvidence(ctx.root, args.storyId);
          const hint = renderEvidenceStaleHint(args.storyId, stale, { currentHead: currentGitHead(ctx.root) });
          if (hint) staleEvidenceHint = `\n\n${hint}`;
        } catch { /* probe — never block phase advance on stale-hint failure */ }
      }

      return `${doneChecklistPrefix}Story ${args.storyId} advanced to ${newState}${metadataCommitReport}${doneMergeReport}\n${nextSteps[newState] || ''}${docsHint}${depsWarning}${sessionWarning}${doneSummarySuffix}${initCheckAdvisory}${baselineRiskWarning}${staleEvidenceHint}`;
    },
  };
}
