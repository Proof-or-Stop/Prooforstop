
import type { HandlerContext } from './context.js';
import { collectContext, PHASE_TO_EVENT, assertCwdInWorktree } from './context.js';
import { createStoryActor, getStateName, getGuardFailureReason } from '../core/machine.js';
import type { StoryPhase } from '../core/types.js';
import type { StoryStore } from '../core/store.js';
import { loadConfig } from '../core/config.js';
import { runHooks, buildHookEnv } from '../core/hooks.js';
import { renderSummaryForHint } from './summary.js';
import { execSync } from 'child_process';
import { dirname } from 'path';
import { existsSync } from 'fs';

/**
 * DONE Final Checklist：把 DONE 阶段所有验证项收成一份显式清单。
 * 无论 advance 成功失败都打印，强制主 agent 读一遍多层验证状态。
 * 对应 OMX ralph 的 <Final_Checklist>。
 */
type DoneCheckRow = {
  status: 'pass' | 'fail' | 'warn';
  label: string;
  detail?: string;
  hint?: string;       // fail 时的修复建议；warn 时作为多行明细
};

function buildDoneChecklist(storyId: string, store: StoryStore, root: string): DoneCheckRow[] {
  const rows: DoneCheckRow[] = [];

  // 1. test evidence
  const evidence = store.readTestEvidence(storyId);
  if (!evidence) {
    rows.push({
      status: 'fail',
      label: 'Test evidence',
      detail: '没有测试证据',
      hint: `koala test_story '{"storyId":"${storyId}"}'`,
    });
  } else if (evidence.result !== 'PASS') {
    rows.push({
      status: 'fail',
      label: 'Test evidence',
      detail: `${evidence.result}: ${evidence.output.slice(0, 120)}`,
      hint: '修复失败的 case 后重跑 test_story',
    });
  } else {
    let allPassedOk = true;
    try {
      const parsed = JSON.parse(evidence.output);
      if (parsed.allPassed !== true) {
        allPassedOk = false;
        rows.push({
          status: 'fail',
          label: 'Test evidence',
          detail: `allPassed=${parsed.allPassed}`,
          hint: '修复失败的 case 后重跑 test_story',
        });
      }
    } catch { /* output 不是 JSON 也算 PASS（兼容旧格式）*/ }
    if (allPassedOk) {
      rows.push({
        status: 'pass',
        label: 'Test evidence',
        detail: `PASS @ ${evidence.timestamp}`,
      });
    }
  }

  // 2. all bugs fixed
  const bugData = store.readBugs(storyId);
  const total = bugData.bugs.length;
  const openBugs = bugData.bugs.filter(b => b.status === 'open');
  if (openBugs.length > 0) {
    rows.push({
      status: 'fail',
      label: 'Bugs fixed',
      detail: `${openBugs.length} open / ${total} total: ${openBugs.map(b => b.id).join(', ')}`,
      hint: '修复所有 open bug 后重跑 test_auto，case pass 会自动标 fixed',
    });
  } else {
    rows.push({
      status: 'pass',
      label: 'Bugs fixed',
      detail: total > 0 ? `${total}/${total}` : 'no bugs',
    });
  }

  // 3. git working tree clean
  try {
    execSync('git diff --quiet && git diff --cached --quiet', { cwd: root, stdio: 'pipe' });
    rows.push({ status: 'pass', label: 'git working tree', detail: 'clean' });
  } catch {
    rows.push({
      status: 'fail',
      label: 'git working tree',
      detail: '有未提交的改动',
      hint: '先 git add + git commit 提交所有改动，再 advance DONE',
    });
  }

  // 4. branch synced with main
  try {
    const story = store.readStory(storyId);
    if (story.worktree?.branch) {
      const branch = story.worktree.branch;
      try {
        execSync(`git merge-base --is-ancestor main ${branch}`, { cwd: root, stdio: 'pipe' });
        rows.push({ status: 'pass', label: 'Branch synced with main', detail: branch });
      } catch {
        rows.push({
          status: 'fail',
          label: 'Branch synced with main',
          detail: `${branch} 未合并 main 的最新提交`,
          hint: '在 worktree 里执行: git merge main',
        });
      }
    }
  } catch { /* 读 story 失败不阻塞，guard 已经报过错 */ }

  // 5. relatedDocs (advisory，warn 不影响判定)
  try {
    const cl = store.readChecklist(storyId);
    const allDocs = new Map<string, string[]>();
    for (const it of cl.items) {
      const docs = (it as any).relatedDocs as string[] | undefined;
      if (Array.isArray(docs)) {
        for (const d of docs) {
          if (!allDocs.has(d)) allDocs.set(d, []);
          allDocs.get(d)!.push(it.id);
        }
      }
    }
    if (allDocs.size > 0) {
      let changedFiles = new Set<string>();
      try {
        const out = execSync('git diff main...HEAD --name-only', { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
        if (out) changedFiles = new Set(out.split('\n'));
      } catch { /* ignore */ }
      const unchanged: Array<[string, string[]]> = [];
      for (const [doc, items] of allDocs.entries()) {
        if (!changedFiles.has(doc.split('#')[0])) unchanged.push([doc, items]);
      }
      if (unchanged.length > 0) {
        rows.push({
          status: 'warn',
          label: 'relatedDocs',
          detail: `${unchanged.length}/${allDocs.size} untouched (advisory)`,
          hint: unchanged.map(([d, items]) => `${d}  (${items.join(', ')})`).join('\n'),
        });
      } else {
        rows.push({
          status: 'pass',
          label: 'relatedDocs',
          detail: `${allDocs.size}/${allDocs.size} touched`,
        });
      }
    }
  } catch { /* ignore */ }

  // 6. summary.json (hard gate — 强制 story 完成总结，防止 LLM 声称"都测过了"不留凭证)
  const summary = store.readSummary(storyId);
  if (!summary) {
    rows.push({
      status: 'fail',
      label: 'Story summary',
      detail: '没有 summary.json',
      hint: `koala summary_set '{"storyId":"${storyId}","changes":"改了什么（≥10 字符）","usage":"怎么用（≥10 字符）","limitations":"已知限制或 \\"none — fully covered\\"","pitfalls":"踩坑记录（≥10 字符，强制段）"}'`,
    });
  } else {
    const missing: string[] = [];
    if (!summary.changes || summary.changes.trim().length < 10) missing.push('changes');
    if (!summary.usage || summary.usage.trim().length < 10) missing.push('usage');
    if (typeof summary.limitations !== 'string' || summary.limitations.trim().length < 2) missing.push('limitations');
    if (!summary.pitfalls || summary.pitfalls.trim().length < 10) missing.push('pitfalls');
    if (missing.length > 0) {
      rows.push({
        status: 'fail',
        label: 'Story summary',
        detail: `字段缺失/过短: ${missing.join(', ')}`,
        hint: `重新调 koala summary_set 补齐 ${missing.join(', ')}`,
      });
    } else {
      const cov = summary.realMachineCoverage;
      const covNote = `${cov.ran.length} ran / ${cov.skipped.length} skipped`;
      rows.push({
        status: 'pass',
        label: 'Story summary',
        detail: `complete (${covNote})`,
      });
    }
  }

  return rows;
}

function renderDoneChecklist(storyId: string, rows: DoneCheckRow[]): string {
  const ICONS: Record<DoneCheckRow['status'], string> = { pass: '✓', fail: '✗', warn: '!' };
  const lines = [`DONE Gate Checklist (${storyId}):`];
  for (const row of rows) {
    let line = `  [${ICONS[row.status]}] ${row.label}`;
    if (row.detail) line += `: ${row.detail}`;
    lines.push(line);
    // warn 行的多行明细缩进展示
    if (row.status === 'warn' && row.hint) {
      for (const h of row.hint.split('\n')) {
        lines.push(`        - ${h}`);
      }
    }
  }
  return lines.join('\n');
}

export function createStoryAdvanceHandlers(ctx: HandlerContext) {
  const { store } = ctx;

  return {
    async story_advance(args: {
      storyId: string;
      phase: StoryPhase;
      checklist?: Array<{ id: string; title: string }>;
    }): Promise<string> {
      const story = store.readStory(args.storyId);
      const oldPhase: string = story.phase as string;

      // CWD 门禁：PLAN/DEV/TEST_* 阶段必须在 worktree 里执行
      // 注意：在 advance 前检查目标 phase 是否需要 worktree
      const CWD_GATED: StoryPhase[] = ['PLAN', 'DEV', 'TEST_CASE', 'TEST_CASE_REVIEW', 'TEST'];
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

      // Git clean 门禁（窄化版）：进入 TEST_CASE / TEST_CASE_REVIEW / TEST 前
      // 只要求 fixturesDir 干净，因为 test runner 的 cleanupFixtureDir 只会
      // git restore + git clean 这一个目录。代码目录的未 commit 改动不会丢，
      // 不再阻塞，让 DEV 阶段可以连续改代码 + 跑测试不被强制 commit 打断。
      const GIT_CLEAN_PHASES: StoryPhase[] = ['TEST_CASE', 'TEST_CASE_REVIEW', 'TEST'];
      if (GIT_CLEAN_PHASES.includes(args.phase) && !(globalThis as any).__koalaTestAutoRunning) {
        try {
          const cfg = loadConfig(ctx.root);
          const fixturesRel = cfg.fixturesDir;
          const gitStatus = execSync(
            `git status --porcelain -- "${fixturesRel}"`,
            { cwd: ctx.root, encoding: 'utf8', timeout: 5000 }
          ).trim();
          if (gitStatus) {
            const fileCount = gitStatus.split('\n').length;
            throw new Error(
              `Cannot enter ${args.phase}: ${fixturesRel} 有未提交的改动（${fileCount} 个文件）。` +
              `test runner 跑完会 git restore + git clean 这个目录，未 commit 的 fixture 改动会丢失。\n` +
              `→ 请先 git add ${fixturesRel} + git commit，再推进阶段\n\n` +
              `git status:\n${gitStatus.split('\n').slice(0, 10).join('\n')}${fileCount > 10 ? '\n...' : ''}`
            );
          }
        } catch (e: any) {
          // git status 本身报错（如不是 git 仓库）不阻塞
          if (e.message?.includes('Cannot enter')) throw e;
        }
      }

      // IDEA→PLAN 需要 checklist
      if (args.phase === 'PLAN' && story.phase === 'IDEA') {
        if (!args.checklist || args.checklist.length === 0) {
          throw new Error('Cannot advance to PLAN: checklist is required');
        }
      }

      const actor = createStoryActor(args.storyId, store, story.phase);
      actor.start();

      let eventType = PHASE_TO_EVENT[args.phase];
      if (!eventType) {
        throw new Error(`Invalid target phase: ${args.phase}`);
      }
      // 回退映射：目标阶段比当前阶段早时，选择对应的回退事件
      if (args.phase === 'PLAN' && story.phase === 'DEV') {
        eventType = 'REPLAN';
      } else if (args.phase === 'DEV' && story.phase === 'TEST_CASE_REVIEW') {
        eventType = 'ROLLBACK_DEV';
      } else if (args.phase === 'TEST_CASE' && (story.phase === 'TEST_CASE_REVIEW' || story.phase === 'TEST')) {
        eventType = 'ROLLBACK_TEST_CASE';
      }
      // TEST_CASE/TEST 已有 START→DEV 转换，PHASE_TO_EVENT['DEV']='START' 自动命中

      // TEST_CASE_REVIEW→TEST 门禁：检查 testIntent results（兜底，防止手动跳过 reviewer）
      if (args.phase === 'TEST' && story.phase === 'TEST_CASE_REVIEW') {
        const checklist = store.readChecklist(args.storyId);
        const failures: Array<{ itemId: string; category: string; desc: string; type: string }> = [];

        for (const item of checklist.items) {
          if (item.testIntent === null) continue; // 标记为不可自动化测试，跳过
          if (!item.testIntent) {
            failures.push({ itemId: item.id, category: '*', desc: 'missing testIntent', type: 'cli_blackbox' });
            continue;
          }
          for (const category of ['happy', 'edge', 'adversarial'] as const) {
            const entries = (item.testIntent as any)[category] || [];
            for (const entry of entries) {
              if (typeof entry === 'string') {
                failures.push({ itemId: item.id, category, desc: entry, type: 'cli_blackbox' });
                continue;
              }
              if (!entry.results || entry.results.length === 0) {
                failures.push({ itemId: item.id, category, desc: entry.desc, type: entry.type || 'cli_blackbox' });
                continue;
              }
              // 只看 role=reviewer 的最后一条判定记录
              const lastJudgment = [...entry.results].reverse().find((r: any) => r.role === 'reviewer' && r.pass !== undefined);
              if (!lastJudgment || !lastJudgment.pass) {
                failures.push({ itemId: item.id, category, desc: entry.desc, type: entry.type || 'cli_blackbox' });
              }
            }
          }
        }

        if (failures.length > 0) {
          // 统一回退 DEV
          actor.send({ type: 'ROLLBACK_DEV' } as any);
          actor.stop();
          story.phase = 'DEV' as any;
          const rollbackCtxEvent = collectContext('DEV' as any, 'advance');
          rollbackCtxEvent.agent = 'gate-rollback';
          if (!story.events) story.events = [];
          story.events.push(rollbackCtxEvent);
          store.writeStory(args.storyId, story);
          const detail = failures.map(f => `  - ${f.itemId}:${f.category} [${f.type}] ${f.desc}`).join('\n');
          return `Gate failed: ${failures.length} testIntent(s) not passed → auto rollback to DEV\n\n${detail}\n\n→ Story ${args.storyId} rolled back to DEV`;
        }
      }

      const canSend = actor.getSnapshot().can({ type: eventType } as any);
      if (!canSend) {
        const reason = getGuardFailureReason(args.storyId, store, args.phase);
        const currentState = getStateName(actor);
        actor.stop();
        throw new Error(
          reason || `Cannot transition from ${currentState} to ${args.phase}`
        );
      }

      // DEV→TEST_CASE 门禁：checklist 全部 done + fixture fn 合法性检查
      if (args.phase === 'TEST_CASE') {
        const errors: string[] = [];
        const hints: string[] = [];
        const root = ctx.root;
        const config = loadConfig(root);


        if (errors.length > 0) {
          actor.stop();
          throw new Error(
            `Cannot enter TEST_CASE: ${errors.length} 项检查未通过:\n\n` +
            errors.map((e, i) => `[${i + 1}] ${e}`).join('\n\n') +
            '\n\n修复建议:\n' + hints.map(h => `→ ${h}`).join('\n')
          );
        }
      }

      // TEST→DONE 严格门禁：构建并渲染 DONE Final Checklist。
      // 无论 advance 成功失败都会输出这份 checklist，强制主 agent 读一遍多层验证状态。
      // 对应 OMX ralph 的 <Final_Checklist>。
      if (args.phase === 'DONE') {
        const checkRows = buildDoneChecklist(args.storyId, store, ctx.root);
        const rendered = renderDoneChecklist(args.storyId, checkRows);
        const failed = checkRows.filter(r => r.status === 'fail');

        if (failed.length > 0) {
          actor.stop();
          const hints = failed.flatMap(r => r.hint ? [r.hint] : []);
          throw new Error(
            rendered + '\n\n' +
            `Cannot enter DONE: ${failed.length} 项检查未通过` +
            (hints.length > 0 ? '\n\n修复建议:\n' + hints.map(h => `→ ${h}`).join('\n') : '')
          );
        }

        // 全部硬检查通过，把渲染好的 checklist 暂存，最终拼到 advance 成功消息里
        (globalThis as any).__koalaDoneChecklistRendered = rendered;
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
      store.writeStory(args.storyId, story);

      // onPhaseChange hook — fires after the new phase is persisted, so the
      // hook can read the up-to-date story state. Failures are non-blocking.
      // Uses the shared buildHookEnv helper so KOALA_ARGS_JSON / KOALA_STORY_ID
      // / KOALA_PHASE stay consistent with the cli-engine code path.
      try {
        const cfg = loadConfig(ctx.root);
        const env = buildHookEnv({
          stage: 'onPhaseChange',
          command: 'story_advance',
          cwd: process.cwd(),
          root: ctx.root,
          argsJson: JSON.stringify(args),
          storyId: args.storyId,
          phase: newState,
          extra: {
            KOALA_OLD_PHASE: oldPhase,
            KOALA_NEW_PHASE: newState,
          },
        });
        await runHooks('onPhaseChange', `${oldPhase}->${newState}`, env, cfg, ctx.root);
      } catch { /* runHooks itself never throws, but defensive */ }

      // CHK-002: PLAN→DEV 时收集所有 relatedDocs 列出来作为开工提醒
      let docsHint = '';
      if (args.phase === 'DEV') {
        try {
          const cl = store.readChecklist(args.storyId);
          const docMap = new Map<string, string[]>(); // doc → [itemId]
          for (const it of cl.items) {
            const docs = (it as any).relatedDocs as string[] | undefined;
            if (Array.isArray(docs)) {
              for (const d of docs) {
                if (!docMap.has(d)) docMap.set(d, []);
                docMap.get(d)!.push(it.id);
              }
            }
          }
          if (docMap.size > 0) {
            const lines: string[] = [];
            for (const [d, items] of docMap.entries()) {
              lines.push(`  - ${d}  (${items.join(', ')})`);
            }
            docsHint = `\n\n📄 本 story 关联文档（改代码时注意同步）:\n${lines.join('\n')}`;
          }
        } catch { /* ignore */ }
      }

      const nextSteps: Record<string, string> = {
        PLAN: `→ 下一步: checklist_get(${args.storyId}) 查看待开发项，然后 story_advance(${args.storyId}, DEV) 开始开发`,
        DEV: `→ 下一步: 写代码实现（此阶段可改代码，不写测试）。完成后 story_advance(${args.storyId}, TEST_CASE)`,
        TEST_CASE: `→ 下一步: 根据 testIntent 编写 fixture case（只改 fixture，不改代码）。完成后 story_advance(${args.storyId}, TEST_CASE_REVIEW)。如需改代码请先 story_advance(${args.storyId}, DEV) 回退`,
        TEST_CASE_REVIEW: `→ 下一步: 启动 test-case-reviewer agent 审核（不改代码也不改 case）。未通过时主 agent 调 story_advance(${args.storyId}, DEV) 回退改代码，或 story_advance(${args.storyId}, TEST_CASE) 回退改 case`,
        TEST: `→ 必须立即执行: test_story('${args.storyId}') 跑当前 story 关联 case，写 bug/evidence。fail 自动 aux_diagnose + bug_report，pass 自动标 bug fixed。需要刷新架构 trace 时再 test_auto({trace:true})`,
        DONE: `→ 必须立即执行: 把下面的 Story 总结段落用你自己的话告诉用户（改了什么/怎么用/真机覆盖/限制/踩坑），然后 convergence_check 检查项目收敛状态`,
      };
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
        // 改为从 git 实际状态推断：cwd（worktree 路径）+ 当前分支 + git common dir。
        const cwdInWorktree = process.cwd();
        let detectedBranch = '';
        let mainRepoRoot = '';
        let wtPathAbs = '';
        try {
          detectedBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: cwdInWorktree, encoding: 'utf-8',
          }).trim();
          const commonDirRaw = execSync('git rev-parse --path-format=absolute --git-common-dir', {
            cwd: cwdInWorktree, encoding: 'utf-8',
          }).trim();
          mainRepoRoot = dirname(commonDirRaw);
          // 只有 cwd 真的是 worktree 而非 main 时才走自动合并
          if (cwdInWorktree !== mainRepoRoot && detectedBranch.startsWith('story/')) {
            wtPathAbs = cwdInWorktree;
          }
        } catch {
          // PROBE: 不在 git 仓库或 git 命令失败 → 跳过自动合并
        }

        if (detectedBranch && wtPathAbs && mainRepoRoot && detectedBranch.startsWith('story/')) {
          const mergeLines: string[] = [];
          const branch = detectedBranch;
          {
            const runGit = (cmd: string, cwd: string): string =>
              execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

            // Step 1: 清 story.worktree 字段 + endedAt + writeStory，让 metadata 落盘
            story.worktree = undefined;
            story.endedAt = story.endedAt || new Date().toISOString();
            store.writeStory(args.storyId, story);

            // Step 2: commit 所有 story metadata（phase=DONE + worktree=undefined +
            // endedAt + reviewer/test 产物）。dev_merge:228 用的是同一招。
            try {
              runGit('add docs/story', cwdInWorktree);
              const staged = runGit('diff --cached --name-only', cwdInWorktree);
              if (staged) {
                runGit(
                  `-c commit.gpgsign=false commit -m "koala: mark ${args.storyId} DONE + clear worktree"`,
                  cwdInWorktree,
                );
              }
            } catch { /* PROBE: 没东西 commit 也无所谓 */ }

            // Step 3: 从主仓库根目录 merge story 分支。merge 冲突直接 throw 给上层
            // 让 agent 看到详细的手动 cleanup 步骤——phase 已经是 DONE，不回滚，但
            // 必须让 user 知道还有手动收尾要做。
            const mainBranch = runGit('rev-parse --abbrev-ref HEAD', mainRepoRoot);
            try {
              runGit(
                `-c commit.gpgsign=false merge ${branch} --no-ff -m "merge: ${args.storyId} ${story.title}"`,
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
            if (existsSync(wtPathAbs)) {
              try {
                runGit(`worktree remove "${wtPathAbs}"`, mainRepoRoot);
                mergeLines.push(`✓ Worktree ${wtPathAbs} 已清理`);
              } catch {
                // worktree 内有 tmp/ llmlog 等运行时产物时 remove 会拒绝，用 --force
                try {
                  runGit(`worktree remove --force "${wtPathAbs}"`, mainRepoRoot);
                  mergeLines.push(`✓ Worktree ${wtPathAbs} 已强制清理`);
                } catch (e: any) {
                  mergeLines.push(`⚠ Worktree 未清理: ${e.message}`);
                }
              }
            }

            // Step 5: 删除分支
            try {
              runGit(`branch -d ${branch}`, mainRepoRoot);
              mergeLines.push(`✓ 分支 ${branch} 已删除`);
            } catch {
              mergeLines.push(`⚠ 分支 ${branch} 未删除（可能有未合并的提交）`);
            }
          }

          if (mergeLines.length > 0) {
            doneMergeReport = `\n\n${mergeLines.join('\n')}`;
          }
        }
      }

      return `${doneChecklistPrefix}Story ${args.storyId} advanced to ${newState}${doneMergeReport}\n${nextSteps[newState] || ''}${docsHint}${depsWarning}${sessionWarning}${doneSummarySuffix}`;
    },
  };
}
