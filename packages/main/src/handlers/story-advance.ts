
import type { HandlerContext } from './context.js';
import { collectContext, PHASE_TO_EVENT, assertCwdInWorktree } from './context.js';
import { createStoryActor, getStateName } from '../core/machine.js';
import type { StoryPhase } from '../core/types.js';
import { checkMetaStoryAdvanceGuard } from '../core/audit-meta-store.js';
import { maybeTriggerAudit } from '../core/audit-trigger.js';
import { renderSummaryForHint } from './summary.js';
import { execFileSync, execSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { existsSync, rmSync } from 'fs';
import { cleanStrayWorktreeFiles } from './stray-file-cleanup.js';
import { repairGlobalKoalaLinkBeforeWorktreeDelete } from './worktree.js';
import { collectBaselineRisk, renderBaselineRiskLines } from '../core/baseline-risk.js';
import { currentGitHead } from '../core/evidence-freshness.js';
import { findStaleEvidence, renderEvidenceStaleHint } from '../core/evidence-stale-hint.js';
import { reportHealthIssue } from '../core/health.js';
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
  runDoneOracleGate,
} from './phase-gates.js';
import {
  recomputeProcessMetrics,
  runPhaseChangeHooks,
  commitReviewMetadata,
  renderRelatedDocsHint,
  buildNextSteps,
} from './transition-effects.js';

// B-c622 CHK-004: DONE 阶段自动同步 main —— detect divergence + auto merge main.
// checkMainDivergence moved into core/done-oracle.ts (B-37e9) and is imported
// above; autoSyncMain stays here (not a buildDoneChecklist dependency).

/** Auto-sync main into the current branch. Returns success/failure + message. */
function autoSyncMain(projectRoot: string): { ok: boolean; message: string } {
  // Try to fetch origin main first (fails silently for local-only repos)
  try {
    execSync('git fetch origin main:main', {
      cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { /* local-only repo or no remote — skip fetch */ }
  try {
    execSync('git merge main --no-edit', {
      cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, message: 'main 已自动同步到当前分支' };
  } catch {
    // conflict — abort merge to keep branch clean
    try {
      execSync('git merge --abort', {
        cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { /* abort failed — already clean */ }
    return { ok: false, message: 'merge main 有冲突（已 abort 保持分支干净）。\n→ 执�� git merge main，解决冲突后 git add + git commit，然后重跑 story_advance DONE' };
  }
}

// B-37e9: readGitStatusLines / classifierOptionsForCheck / evaluateDirtyGitStatus
// moved into core/done-oracle.ts together with buildDoneChecklist (they are
// private helpers used only by the DONE row assembly).

function isRegisteredWorktree(repoRoot: string, worktreePath: string): boolean {
  try {
    const raw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const target = worktreePath.replace(/\\/g, '/');
    return raw
      .split(/\r?\n/)
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).trim().replace(/\\/g, '/'))
      .includes(target);
  } catch {
    return false;
  }
}

function pruneWorktreeRegistry(repoRoot: string): void {
  execFileSync('git', ['worktree', 'prune', '--expire', 'now'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

type DoneWorktreeContext = {
  invocationCwd: string;
  worktreeRoot: string;
  mainRepoRoot: string;
  branch: string;
};

function samePath(a: string, b: string): boolean {
  return resolve(a).replace(/\\/g, '/') === resolve(b).replace(/\\/g, '/');
}

function detectDoneStoryWorktreeContext(invocationCwd = process.cwd()): DoneWorktreeContext | null {
  try {
    const resolvedInvocationCwd = resolve(invocationCwd);
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: resolvedInvocationCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const worktreeRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolvedInvocationCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const commonDirRaw = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: resolvedInvocationCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const mainRepoRoot = dirname(commonDirRaw);
    if (samePath(worktreeRoot, mainRepoRoot)) return null;

    return {
      invocationCwd: resolvedInvocationCwd,
      worktreeRoot: resolve(worktreeRoot),
      mainRepoRoot: resolve(mainRepoRoot),
      branch,
    };
  } catch {
    // PROBE: not in a git worktree or git metadata is unavailable.
    return null;
  }
}

function assertDoneStoryBranchMatches(storyId: string, branch: string): void {
  const expectedBranch = `story/${storyId}`;
  if (branch !== expectedBranch) {
    throw new Error(
      `refusing DONE cleanup: detected branch ${branch} but expected ${expectedBranch}; ` +
      `merge/delete aborted before mutating story state.`,
    );
  }
}

function assertSafeResidualWorktreeRm(ctx: DoneWorktreeContext, target: string, wasRegisteredWorktree: boolean): void {
  if (!samePath(target, ctx.worktreeRoot)) {
    throw new Error(`refusing residual cleanup outside canonical worktree root: ${target}`);
  }
  if (!wasRegisteredWorktree) {
    throw new Error(`refusing residual cleanup for unregistered worktree path: ${target}`);
  }
  if (!samePath(ctx.invocationCwd, ctx.worktreeRoot) && samePath(target, ctx.invocationCwd)) {
    throw new Error(`refusing residual cleanup of nested invocation cwd: ${target}`);
  }
}

function assertDoneMergeCanApplyBeforeStateMutation(storyId: string, worktreePath: string, mainRepoRoot: string): void {
  try {
    execFileSync('git', ['merge-tree', '--write-tree', 'main', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    const detail = e?.stderr?.toString?.() || e?.stdout?.toString?.() || e?.message || String(e);
    throw new Error(
      `Cannot enter DONE: story/${storyId} 尚不能干净合并到 main；未修改 story phase。\n` +
      `${detail}\n\n` +
      `→ 在 worktree 内先解决与 main 的合并冲突，再重跑 story_advance --phase=DONE。\n` +
      `→ 可执行: cd "${worktreePath}" && git merge main\n` +
      `→ 主仓库: ${mainRepoRoot}`,
    );
  }
}

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

      // TEST→DONE 严格门禁：构建并渲染 DONE Final Checklist。
      // 无论 advance 成功失败都会输出这份 checklist，强制主 agent 读一遍多层验证状态。
      // 对应 OMX ralph 的 <Final_Checklist>。
      // B-56d3: the done-oracle gate (buildDoneChecklist + renderDoneChecklist +
      // fail-collection + throw) is extracted into phase-gates.ts
      // (runDoneOracleGate). It returns the rendered checklist on pass; the
      // throw-on-fail wording is byte-identical. The DONE merge / worktree
      // cleanup below is NOT extracted — Story 3b owns it.
      if (args.phase === 'DONE') {
        // B-c622 CL-006: autoSyncMain moved before actor.can() to fix TOCTOU.

        const rendered = runDoneOracleGate(args.storyId, store, ctx.root, actor);

        // 全部硬检查通过，把渲染好的 checklist 暂存，最终拼到 advance 成功消息里
        (globalThis as any).__koalaDoneChecklistRendered = rendered;

        // F-020 (B-9d95 Round 1 review): stray-file 检测提前到 phase=DONE 落盘
        // 之前。原实现（Step 2.5，line 632 附近）在 story.phase=DONE +
        // story.worktree=undefined 已 writeStory 之后才跑，若 throw（非白名单
        // 未追踪文件）story 会卡 DONE（merge 未发生、worktree 还活着、没有
        // koala 自愈路径）。这里预检查：dry-run detection，发现 offender 立刻
        // throw，保留 phase=TEST 状态让 main agent 按错误提示修复后重跑。
        //
        // whitelist 文件在此**不删除**——只负责早期拦截。真正的 rm 延后到
        // Step 2.5 (actor.send 之后的 merge 流程) 做，因为此时才知道合并一定
        // 会发生。预检查只看"有没有 offender"：
        //   - 有 offender → throw（保留文件，不落盘 DONE）
        //   - 无 offender → 继续走完整流程，whitelist rm 在 Step 2.5 执行
        try {
          const doneWorktree = detectDoneStoryWorktreeContext();
          if (doneWorktree) {
            assertDoneStoryBranchMatches(args.storyId, doneWorktree.branch);
            // 仅 dry-run：用 git ls-files 读出未追踪文件，按白名单分类。
            // 发现 offender → throw（此时 story.phase 仍为 TEST）。无 offender
            // → 返回，不做任何删除，后续 Step 2.5 才会真的 rm whitelist 文件。
            const { mainRepoRoot, worktreeRoot } = doneWorktree;
            const storyDir = `${store.storyDirRel()}/${args.storyId}/`;
            if (existsSync(join(mainRepoRoot, storyDir))) {
              let raw = '';
              try {
                raw = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', storyDir], {
                  cwd: mainRepoRoot,
                  encoding: 'utf-8',
                  stdio: ['pipe', 'pipe', 'pipe'],
                }).toString();
              } catch { /* PROBE: 忽略，让 Step 2.5 兜底 */ }
              const relPaths = raw.split('\n').map(l => l.trim()).filter(Boolean);
              const { STRAY_FILE_WHITELIST: WL } = await import('./stray-file-cleanup.js');
              const offenders = relPaths.filter(rel => !WL.includes(rel.split('/').pop() || rel));
              if (offenders.length > 0) {
                // 复用 cleanStrayWorktreeFiles 的 throw 消息（单一真相源），
                // 传入 worktreePath 让消息含 git worktree remove / branch -d 指引。
                actor.stop();
                cleanStrayWorktreeFiles(mainRepoRoot, args.storyId, worktreeRoot);
                // cleanStrayWorktreeFiles 在有 offender 时必然 throw；能到这行
                // 说明逻辑偏离，fallback：主动抛错避免 phase 默认落盘。
                throw new Error(
                  `Story ${args.storyId} DONE pre-merge stray 检测：检测到非白名单未追踪文件但 cleanStrayWorktreeFiles 未抛错（内部状态偏离），阻止推进。`,
                );
              }
            }
            assertDoneMergeCanApplyBeforeStateMutation(args.storyId, worktreeRoot, mainRepoRoot);
          }
        } catch (e: any) {
          // throw 的错误信息（含 stash / worktree remove 指引）直接冒给 caller，
          // 不吞。只有 git 探测本身的非 throw 失败被上面的 catch 吃掉。
          if (
            e?.message?.startsWith(`Story ${args.storyId} DONE `)
            || e?.message?.startsWith('Cannot enter DONE:')
            || e?.message?.startsWith('refusing DONE cleanup:')
          ) {
            throw e;
          }
          // 其他意外（如 import 失败 / unknown）转成可见错误
          throw new Error(`DONE pre-merge 预检查失败: ${e?.message ?? e}`);
        }
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
        const rendered = (globalThis as any).__koalaDoneChecklistRendered;
        if (rendered) {
          doneChecklistPrefix = `${rendered}\n\n`;
          delete (globalThis as any).__koalaDoneChecklistRendered;
        }
        // DONE 成功后把 summary 内容拼到返回里，agent 看到后转述给用户
        try {
          const summary = store.readSummary(args.storyId);
          if (summary) {
            doneSummarySuffix = `\n\n${renderSummaryForHint(summary)}`;
          }
        } catch { /* ignore */ }

        // B-7eed: DONE 成功后自动 git merge 回 main + 清 worktree + 删 branch。
        // CLAUDE.md 承诺"内部自动合并"但旧代码没实现，每次 DONE 都要手动 cleanup。
        // 复用 dev_merge 的逻辑（worktree.ts:208）但从 story-advance 触发。
        //
        // 关键的执行顺序（不能乱）：
        //   1. 清 story.worktree 字段 + writeStory（在 worktree fs 内）
        //   2. git add + git commit 把这一步以及之前的 phase=DONE 改动都落到 story 分支
        //   3. cd 到主仓库根目录，git merge story 分支（worktree 内不能 merge 自己）
        //   4. worktree remove
        //   5. branch -d
        // 注意：不能依赖 story.worktree 字段——INIT_CHECK 把这个字段写到了 main
        // 仓库的 index.json，但 worktree 内 checkout 的版本是 INIT_CHECK 之前的，
        // 没有这个字段。所以 readStory(from worktree) 永远拿到 worktree=undefined。
        // 改为从 git 实际状态推断：调用 cwd、git 顶层 worktree、当前分支、git common dir。
        // DONE 可从 worktree 子目录触发，所以 cleanup 目标必须是 git top-level，
        // 不能把 process.cwd() 当作可删除路径。
        const doneWorktree = detectDoneStoryWorktreeContext();

        if (doneWorktree) {
          const mergeLines: string[] = [];
          const { branch, mainRepoRoot, worktreeRoot: wtPathAbs } = doneWorktree;
          assertDoneStoryBranchMatches(args.storyId, branch);
          {
            const runGitArgs = (args: string[], cwd: string): string =>
              execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

            // Step 1: 清 story.worktree 字段 + endedAt + writeStory，让 metadata 落盘
            story.worktree = undefined;
            story.endedAt = story.endedAt || new Date().toISOString();
            store.writeStory(args.storyId, story);

            // Step 2: commit 所有 story metadata（phase=DONE + worktree=undefined +
            // endedAt + reviewer/test 产物）。dev_merge:228 用的是同一招。
            try {
              runGitArgs(['add', store.storyDirRel()], wtPathAbs);
              const staged = runGitArgs(['diff', '--cached', '--name-only'], wtPathAbs);
              if (staged) {
                runGitArgs(
                  ['-c', 'commit.gpgsign=false', 'commit', '-m', `koala: mark ${args.storyId} DONE + clear worktree`],
                  wtPathAbs,
                );
              }
            } catch { /* PROBE: 没东西 commit 也无所谓 */ }

            // Step 2.5 (B-9d95 CHK-003): merge 前清 stray whitelist 文件。
            // F-020: 非白名单 offender 检测已提前到 DONE gate（phase 落盘前），
            // 这里只负责 whitelist 自动 rm；理论上 offender 不可能到这行（上面
            // 已 throw），但保留 throw 路径作为 defense-in-depth。第三参数
            // wtPathAbs 用于 error message 的 worktree 清理指引（F-014）。
            const strayReport = cleanStrayWorktreeFiles(mainRepoRoot, args.storyId, wtPathAbs);
            for (const line of strayReport) mergeLines.push(line);

            // Step 3: 从主仓库根目录 merge story 分支。merge 冲突直接 throw 给上层
            // 让 agent 看到详细的手动 cleanup 步骤——phase 已经是 DONE，不回滚，但
            // 必须让 user 知道还有手动收尾要做。
            const mainBranch = runGitArgs(['rev-parse', '--abbrev-ref', 'HEAD'], mainRepoRoot);
            try {
              runGitArgs(
                ['-c', 'commit.gpgsign=false', 'merge', branch, '--no-ff', '-m', `merge: ${args.storyId} ${story.title}`],
                mainRepoRoot,
              );
              mergeLines.push(`✓ 分支 ${branch} 已合并到 ${mainBranch}`);
            } catch (e: any) {
              throw new Error(
                `Story ${args.storyId} 已标记为 DONE 但自动合并失败:\n` +
                `${e.stderr?.toString() || e.message}\n\n` +
                `请手动完成:\n` +
                `  cd "${mainRepoRoot}"\n` +
                `  git merge ${branch}\n` +
                `  git worktree remove --force "${wtPathAbs}"\n` +
                `  git branch -d ${branch}`,
              );
            }

            // Step 4: 清理 worktree
            let cleanupFailure: string | null = null;
            //
            // Two-step cleanup: `git worktree remove` deregisters the worktree
            // from git's internal list (so `git worktree list` no longer shows
            // it), then we `rm -rf` the directory to catch leftover files
            // that git didn't clean. Why the second step is needed:
            //
            // - activity.jsonl (Claude Code hook), tmp/llmlog.json and other
            //   gitignored runtime files are invisible to `git status` so git
            //   considers the worktree "dirty but all gitignored"
            // - with --force, git removes the worktree entry but leaves the
            //   directory (Windows + hook holding a file handle) or empty
            //   skeleton dirs behind
            // - result: `git worktree list` is clean but `.worktrees/B-xxx/`
            //   still exists with stray files
            //
            // The rm -rf is safe here because DONE gate already checked that
            // the working tree is clean AND the branch is merged into main —
            // anything left in the worktree is either gitignored runtime
            // state or genuine leakage we want to erase.
            if (existsSync(wtPathAbs) || isRegisteredWorktree(mainRepoRoot, wtPathAbs)) {
              const wasRegisteredWorktree = isRegisteredWorktree(mainRepoRoot, wtPathAbs);
              const repair = repairGlobalKoalaLinkBeforeWorktreeDelete(wtPathAbs, mainRepoRoot);
              if (repair.action === 'relinked') mergeLines.push(repair.message);
              let removeFailure: string | null = null;
              try {
                runGitArgs(['worktree', 'remove', wtPathAbs], mainRepoRoot);
                mergeLines.push(`✓ Worktree ${wtPathAbs} 已清理`);
              } catch {
                // worktree 内有 tmp/ llmlog 等运行时产物时 remove 会拒绝，用 --force
                try {
                  runGitArgs(['worktree', 'remove', '--force', wtPathAbs], mainRepoRoot);
                  mergeLines.push(`✓ Worktree ${wtPathAbs} 已强制清理`);
                } catch (e: any) {
                  removeFailure = `git worktree remove failed: ${e.message}`;
                  mergeLines.push(`⚠ Worktree 未清理: ${e.message}`);
                }
              }
              // Second step: rm -rf the directory if git left it behind.
              // This is the fix for "worktree folder still exists after
              // DONE merge" caused by activity.jsonl-style gitignored
              // leftovers from Claude Code hooks.
              if (existsSync(wtPathAbs)) {
                try {
                  assertSafeResidualWorktreeRm(doneWorktree, wtPathAbs, wasRegisteredWorktree);
                  rmSync(wtPathAbs, { recursive: true, force: true });
                  mergeLines.push(`✓ Worktree 目录残留已清空`);
                } catch (e: any) {
                  cleanupFailure = `worktree directory cleanup failed: ${e.message}`;
                  mergeLines.push(`⚠ Worktree 目录残留清理失败: ${e.message}`);
                }
              }
              try {
                pruneWorktreeRegistry(mainRepoRoot);
                if (removeFailure && !existsSync(wtPathAbs) && !isRegisteredWorktree(mainRepoRoot, wtPathAbs)) {
                  mergeLines.push(`✓ stale worktree registry 已 prune`);
                }
              } catch (e: any) {
                mergeLines.push(`⚠ git worktree prune 失败: ${e.message}`);
              }
              if (existsSync(wtPathAbs) && !cleanupFailure) {
                cleanupFailure = `worktree path still exists after cleanup: ${wtPathAbs}`;
              }
              if (isRegisteredWorktree(mainRepoRoot, wtPathAbs) && !cleanupFailure) {
                cleanupFailure = removeFailure || `worktree is still registered after cleanup: ${wtPathAbs}`;
                mergeLines.push(`⚠ Worktree 仍在 git registry 中: ${wtPathAbs}`);
              }
            }

            // Step 5: 删除分支
            try {
              runGitArgs(['branch', '-d', branch], mainRepoRoot);
              mergeLines.push(`✓ 分支 ${branch} 已删除`);
            } catch {
              mergeLines.push(`⚠ 分支 ${branch} 未删除（可能有未合并的提交）`);
            }

            if (cleanupFailure) {
              const err = new Error(cleanupFailure);
              reportHealthIssue('mutation:worktreeCleanup', err, {
                storyId: args.storyId,
                branch,
                worktreePath: wtPathAbs,
                mainRepoRoot,
              });
              throw new Error(
                `Story ${args.storyId} 已合并，但 worktree 清理未完成: ${cleanupFailure}\n` +
                `→ 请运行 koala doctor 查看，或执行 koala doctor --repair 清理终态 worktree 残留。`,
              );
            }
          }

          if (mergeLines.length > 0) {
            doneMergeReport = `\n\n${mergeLines.join('\n')}`;
          }

          // B-9bd9 CHK-003: DONE 合并成功后，尝试触发 framework audit。
          // maybeTriggerAudit 内部已 try/catch + meta-story guard + mode=off 兜底；
          // 此处再包一层防御，确保任何 audit-trigger 路径异常都不影响 DONE 成功消息。
          // projectRoot 用 mainRepoRoot（main 仓的根，不是已被清掉的 worktree）。
          try {
            const auditResult = await maybeTriggerAudit(args.storyId, mainRepoRoot);
            if (auditResult.hint) {
              // semi-auto 提示行：前后各空一行单独成段，avoid 和 mergeLines/docsHint 挤在一起
              doneMergeReport += `\n${auditResult.hint}`;
            }
          } catch (e: any) {
            console.warn(`[audit-trigger] DONE hook failed: ${e?.message || e}`);
          }
        }
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
