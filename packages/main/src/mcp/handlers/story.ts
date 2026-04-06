
import type { HandlerContext } from './context.js';
import { collectContext, nextStoryId, PHASE_TO_EVENT, assertCwdInWorktree } from './context.js';
import { createStoryActor, getStateName, getGuardFailureReason } from '../../story/machine.js';
import type { StoryInfo, StoryPhase, StoryType } from '../../story/types.js';
import { loadConfig } from '../../config.js';
import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { createHash } from 'crypto';

export function createStoryHandlers(ctx: HandlerContext) {
  const { store, scanRoot } = ctx;

  const handlers = {

    story_create(args: {
      name: string;
      title: string;
      description: string;
      type: StoryType;
      priority: string;
      source?: string;
      depends?: string[];
      keywords?: string[];
      checklist?: Array<{ title: string; context?: string; relatedDocs?: string[]; testIntent?: { happy: string[]; edge: string[]; adversarial: string[] } }>;
      prefix?: string;
      phase?: StoryPhase;
    }): string {
      const storyId = nextStoryId(store, args.prefix);
      const now = new Date().toISOString();
      const hasChecklist = args.checklist && args.checklist.length > 0;

      // 关键词查重：与已有非 DONE/DISCARDED story 比较 keywords
      let dupWarning = '';
      if (args.keywords && args.keywords.length > 0) {
        const overlaps: Array<{ id: string; title: string; phase: string; common: string[] }> = [];
        for (const sid of store.listStoryIds()) {
          try {
            const other = store.readStory(sid);
            if (other.phase === 'DONE' || other.phase === 'DISCARDED') continue;
            if (!other.keywords || other.keywords.length === 0) continue;
            const common = args.keywords.filter(k => other.keywords!.includes(k));
            if (common.length > 0) {
              overlaps.push({ id: sid, title: other.title, phase: other.phase, common });
            }
          } catch { /* ignore */ }
        }
        if (overlaps.length > 0) {
          dupWarning = '\n⚠ 疑似重复 story（关键词重叠）:\n' +
            overlaps.map(o => `  - ${o.id} [${o.phase}] ${o.title} (共同关键词: ${o.common.join(', ')})`).join('\n');
        }
      }

      // 直接指定 phase（onboard 用：已完成模块直接标 DONE）
      if (args.phase) {
        const story: StoryInfo = {
          storyId,
          name: args.name,
          title: args.title,
          description: args.description,
          type: args.type,
          phase: args.phase,
          priority: args.priority,
          ...(args.source ? { source: args.source } : {}),
          ...(args.depends && args.depends.length > 0 ? { depends: args.depends } : {}),
          ...(args.keywords && args.keywords.length > 0 ? { keywords: args.keywords } : {}),
          createdAt: now,
          startedAt: args.phase !== 'IDEA' ? now : null,
          endedAt: args.phase === 'DONE' ? now : null,
          events: [collectContext(args.phase, 'create')],
        };
        store.writeStory(storyId, story);
        if (hasChecklist) {
          const isDone = args.phase === 'DONE';
          const checklist = {
            items: args.checklist!.map((c: any, i: number) => ({
              id: `CHK-${String(i + 1).padStart(3, '0')}`,
              title: c.title,
              ...(c.context ? { context: c.context } : {}),
              ...(c.relatedDocs !== undefined ? { relatedDocs: c.relatedDocs } : {}),
              ...(c.testIntent ? { testIntent: c.testIntent } : {}),
              status: (isDone ? 'done' : 'pending') as 'done' | 'pending',
              startTime: isDone ? now : null,
              endTime: isDone ? now : null,
            })),
          };
          store.writeChecklist(storyId, checklist);
        }
        return `Story ${storyId} created (${args.phase})${hasChecklist ? ` with ${args.checklist!.length} checklist items` : ''}${dupWarning}`;
      }

      // 正常模式：有 checklist → INIT（之后 story_advance INIT_CHECK 创建 worktree → PLAN）
      const phase: StoryPhase = hasChecklist ? 'INIT' : 'IDEA';
      const story: StoryInfo = {
        storyId,
        name: args.name,
        title: args.title,
        description: args.description,
        type: args.type,
        phase,
        priority: args.priority,
        ...(args.source ? { source: args.source } : {}),
        ...(args.depends && args.depends.length > 0 ? { depends: args.depends } : {}),
        ...(args.keywords && args.keywords.length > 0 ? { keywords: args.keywords } : {}),
        createdAt: now,
        startedAt: hasChecklist ? now : null,
        endedAt: null,
        events: [collectContext(phase, 'create')],
      };
      store.writeStory(storyId, story);

      if (hasChecklist) {
        const checklist = {
          items: args.checklist!.map((c: any, i: number) => ({
            id: `CHK-${String(i + 1).padStart(3, '0')}`,
            title: c.title,
            ...(c.context ? { context: c.context } : {}),
            ...(c.relatedDocs !== undefined ? { relatedDocs: c.relatedDocs } : {}),
            ...(c.testIntent ? { testIntent: c.testIntent } : {}),
            status: 'pending' as const,
            startTime: null,
            endTime: null,
          })),
        };
        store.writeChecklist(storyId, checklist);
        const noContext = args.checklist!.filter((c: any) => !c.context).length;
        const noIntent = args.checklist!.filter((c: any) => !c.testIntent).length;
        const hints: string[] = [];
        if (noContext > 0) hints.push(`${noContext} 项缺少 context（根因/参考），建议补充`);
        if (noIntent > 0) hints.push(`${noIntent} 项缺少 testIntent（happy/edge/adversarial），建议补充后跑 story_review 审查`);
        const hint = hints.length > 0 ? '\n⚠ ' + hints.join('\n⚠ ') : '';
        return `Story ${storyId} created (INIT) with ${checklist.items.length} checklist items${hint}${dupWarning}`;
      }

      return `Story ${storyId} created (IDEA)${dupWarning}`;
    },

    story_advance(args: {
      storyId: string;
      phase: StoryPhase;
      checklist?: Array<{ id: string; title: string }>;
    }): string {
      const story = store.readStory(args.storyId);

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

      // Git clean 门禁：进入 TEST_CASE / TEST_CASE_REVIEW / TEST 前必须 git status 干净
      // 因为 test_auto 会 git restore + git clean，未 commit 的改动会丢
      const GIT_CLEAN_PHASES: StoryPhase[] = ['TEST_CASE', 'TEST_CASE_REVIEW', 'TEST'];
      if (GIT_CLEAN_PHASES.includes(args.phase) && !(globalThis as any).__koalaTestAutoRunning) {
        try {
          const gitStatus = execSync('git status --porcelain', { cwd: ctx.root, encoding: 'utf8', timeout: 5000 }).trim();
          if (gitStatus) {
            const fileCount = gitStatus.split('\n').length;
            throw new Error(
              `Cannot enter ${args.phase}: git 有未提交的改动（${fileCount} 个文件）。` +
              `test_auto 会执行 git restore，未 commit 的改动会丢失。\n` +
              `→ 请先 git add + git commit，再推进阶段\n\n` +
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

      // TEST→DONE 严格门禁：测试通过
      if (args.phase === 'DONE') {
        const errors: string[] = [];
        const hints: string[] = [];
        const evidence = store.readTestEvidence(args.storyId);
        const root = ctx.root;

        // 1. 必须有测试证据
        if (!evidence) {
          errors.push('没有测试证据');
          hints.push('先跑 koala test_story \'{"storyId":"' + args.storyId + '"}\'');
        } else if (evidence.result !== 'PASS') {
          errors.push(`最近一次测试 ${evidence.result}: ${evidence.output}`);
          hints.push('修复失败的 case 后重跑 test_story');
        } else {
          // 进一步校验 output 中的 allPassed
          try {
            const parsed = JSON.parse(evidence.output);
            if (parsed.allPassed !== true) {
              errors.push(`最近一次测试 allPassed=${parsed.allPassed}，需要全部通过`);
              hints.push('修复失败的 case 后重跑 test_story');
            }
          } catch { /* ignore parse error */ }
        }

        // 4. 所有 bug 必须 fixed
        const bugData = store.readBugs(args.storyId);
        const openBugs = bugData.bugs.filter(b => b.status === 'open');
        if (openBugs.length > 0) {
          errors.push(`${openBugs.length} 个 bug 未修复:\n${openBugs.map(b => `  - ${b.id}: ${b.title}`).join('\n')}`);
          hints.push('修复所有 open bug 后重跑 test_auto，case pass 会自动标 fixed');
        }

        // 5. git working tree 必须干净（所有改动已提交）
        try {
          execSync('git diff --quiet && git diff --cached --quiet', { cwd: root, stdio: 'pipe' });
        } catch {
          errors.push('git working tree 不干净，有未提交的改动');
          hints.push('先 git add + git commit 提交所有改动，再 advance DONE');
        }

        // 6. story 分支必须已 merge main（B-775a）
        const story_ = store.readStory(args.storyId);
        if (story_.worktree?.branch) {
          try {
            const branch = story_.worktree.branch;
            // main 是否是 story 分支的祖先（即 story 已经包含 main 的所有提交）
            try {
              execSync(`git merge-base --is-ancestor main ${branch}`, { cwd: root, stdio: 'pipe' });
            } catch {
              errors.push(`story 分支 ${branch} 未合并 main 的最新提交`);
              hints.push(`在 worktree 里执行: git merge main`);
            }
          } catch { /* git 查询失败，跳过 */ }
        }

        // 7. relatedDocs 软提醒（不门禁）：DONE 阶段最后一次列出未改动的关联文档
        // 累积到 docsHintAtDone 在最终消息里输出，不 push 到 errors[]
        try {
          const checklistForDocs = store.readChecklist(args.storyId);
          const allDocs = new Map<string, string[]>();
          for (const it of checklistForDocs.items) {
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
              (globalThis as any).__koalaDocsHintAtDone = unchanged
                .map(([d, items]) => `  - ${d}  (${items.join(', ')})`).join('\n');
            }
          }
        } catch { /* ignore */ }


        if (errors.length > 0) {
          actor.stop();
          throw new Error(
            `Cannot enter DONE: ${errors.length} 项检查未通过:\n\n` +
            errors.map((e, i) => `[${i + 1}] ${e}`).join('\n\n') +
            (hints.length > 0 ? '\n\n修复建议:\n' + hints.map(h => `→ ${h}`).join('\n') : '')
          );
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
      store.writeStory(args.storyId, story);

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
        TEST: `→ 必须立即执行: test_auto(${args.storyId}) 全量真机测试（含 V8 profiler trace）。fail 自动 diagnose + bug_report，pass 自动保存 trace 快照 + 标 bug fixed`,
        DONE: `→ 必须立即执行: convergence_check 检查项目收敛状态，未收敛则 gap_analyze 查看差距`,
      };
      let doneDocsNote = '';
      if (args.phase === 'DONE') {
        const note = (globalThis as any).__koalaDocsHintAtDone;
        if (note) {
          doneDocsNote = `\n\n📄 提醒：以下关联文档本次 story 未改动，请确认是否需要同步：\n${note}`;
          delete (globalThis as any).__koalaDocsHintAtDone;
        }
      }

      return `Story ${args.storyId} advanced to ${newState}\n${nextSteps[newState] || ''}${docsHint}${doneDocsNote}${depsWarning}${sessionWarning}`;
    },

    story_update(args: {
      storyId: string;
      title?: string;
      description?: string;
      priority?: string;
      source?: string;
      depends?: string[];
    }): string {
      const story = store.readStory(args.storyId);
      if (args.title !== undefined) story.title = args.title;
      if (args.description !== undefined) story.description = args.description;
      if (args.priority !== undefined) story.priority = args.priority;
      if (args.source !== undefined) story.source = args.source;
      if (args.depends !== undefined) story.depends = args.depends;
      store.writeStory(args.storyId, story);
      return `Story ${args.storyId} updated`;
    },

    story_get(args: { storyId: string; detail?: boolean }): object {
      const config = loadConfig(ctx.root);
      const fixturesDir = join(ctx.root, config.fixturesDir);

      // 扫描所有 fixture，建立 intentRef → {file, line, name} 的映射
      const intentRefMap = new Map<string, { file: string; line: number; name: string }>();
      if (existsSync(fixturesDir)) {
        const scanDir = (dir: string) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) { scanDir(join(dir, entry.name)); continue; }
            if (!entry.name.endsWith('.json')) continue;
            try {
              const raw = readFileSync(join(dir, entry.name), 'utf-8');
              const content = JSON.parse(raw);
              for (const c of content.cases || []) {
                if (c.intentRef) {
                  // 粗略算行号：找 case name 在原始文本中的位置
                  const idx = raw.indexOf(`"name":"${c.name}"`);
                  const line = idx >= 0 ? raw.substring(0, idx).split('\n').length : 0;
                  intentRefMap.set(c.intentRef, { file: entry.name, line, name: c.name });
                }
              }
            } catch { /* ignore */ }
          }
        };
        scanDir(fixturesDir);
      }

      // 读 checklist 并填入 fixture 关联
      const cl = (() => {
        try { return store.readChecklist(args.storyId); } catch { return { items: [] as any[] }; }
      })();
      for (const item of cl.items) {
        if (!item.testIntent) continue;
        for (const lane of ['happy', 'edge', 'adversarial'] as const) {
          const entries = item.testIntent[lane] || [];
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (typeof entry === 'string') continue;
            const ref = `${item.id}:${lane}:${i}`;
            entry.fixture = intentRefMap.get(ref) || null;
          }
        }
      }

      // 读 review
      const review = (() => {
        try { return store.readReview(args.storyId); } catch { return null; }
      })();

      const result: Record<string, unknown> = { checklist: cl, review };
      if (args.detail) {
        result.index = store.readStory(args.storyId);
      }
      return result;
    },

    story_list(args?: { phase?: StoryPhase }) {
      const ids = store.listStoryIds();
      const results = ids.map(id => {
        const story = store.readStory(id);
        const cl = (() => {
          try { return store.readChecklist(id); } catch { return { items: [] }; }
        })();
        const bugs = store.readBugs(id);
        const evidence = store.readTestEvidence(id);

        const clDone = cl.items.filter(i => i.status === 'done').length;
        const clTotal = cl.items.length;
        const bugsOpen = bugs.bugs.filter(b => b.status === 'open').length;
        const bugsFixed = bugs.bugs.filter(b => b.status === 'fixed').length;

        return {
          storyId: id,
          name: story.name || '',
          title: story.title,
          phase: story.phase,
          priority: story.priority,
          type: story.type,
          checklist: clTotal > 0 ? `${clDone}/${clTotal}` : '-',
          bugs: bugsOpen > 0 ? `${bugsOpen} open, ${bugsFixed} fixed` : (bugsFixed > 0 ? `${bugsFixed} fixed` : 'none'),
          tests: evidence && evidence.result ? evidence.result.toLowerCase() : 'none',
        };
      });

      const filtered = args?.phase ? results.filter(r => r.phase === args.phase) : results;

      // 仪表盘摘要（无 phase 过滤时生成）
      if (!args?.phase) {
        const total = results.length;
        const done = results.filter(r => r.phase === 'DONE').length;
        const phases: Record<string, number> = {};
        for (const r of results) {
          phases[r.phase] = (phases[r.phase] || 0) + 1;
        }

        // 测试统计
        const withTests = results.filter(r => r.tests !== 'none');
        const withoutTests = results.filter(r => r.tests === 'none');
        const passedTests = results.filter(r => r.tests === 'pass');

        // Bug 统计
        const bugStories = results.filter(r => r.type === 'bug');
        const storiesWithBugs = results.filter(r => r.bugs !== 'none');
        let totalBugsOpen = 0;
        let totalBugsFixed = 0;
        for (const r of results) {
          const bd = store.readBugs(r.storyId);
          totalBugsOpen += bd.bugs.filter(b => b.status === 'open').length;
          totalBugsFixed += bd.bugs.filter(b => b.status === 'fixed').length;
        }
        const totalBugs = totalBugsOpen + totalBugsFixed + bugStories.length;

        const mkBar = (pct: number) => '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
        const storyPct = total > 0 ? Math.round(done / total * 100) : 0;
        const testPct = total > 0 ? Math.round(withTests.length / total * 100) : 0;
        const passPct = total > 0 ? Math.round(passedTests.length / total * 100) : 0;
        const bugFreePct = total > 0 ? Math.round((total - storiesWithBugs.length - bugStories.length) / total * 100) : 0;

        const dashboard = [
          `Story 完成率    ${mkBar(storyPct)} ${storyPct}% (${done}/${total} DONE)`,
          `测试覆盖        ${mkBar(testPct)} ${testPct}% (${withTests.length}/${total} 有测试证据)`,
          `测试通过        ${mkBar(passPct)} ${passPct}% (${passedTests.length}/${total} PASS)`,
          `无 Bug 率       ${mkBar(bugFreePct)} ${bugFreePct}% (${total - storiesWithBugs.length - bugStories.length}/${total} 无 bug)`,
          `Bug 总计        ${totalBugs} (open: ${totalBugsOpen}, fixed: ${totalBugsFixed}, bug story: ${bugStories.length})`,
        ].join('\n');

        // Bug 建议
        const bugSuggestions: string[] = [];
        if (totalBugsOpen > 0) {
          bugSuggestions.push(`⚠ ${totalBugsOpen} 个 open bug 待修复，建议优先处理`);
        }
        if (bugStories.filter(r => r.phase !== 'DONE').length > 0) {
          const openBugStories = bugStories.filter(r => r.phase !== 'DONE');
          bugSuggestions.push(`⚠ Bug Story 未关闭: ${openBugStories.map(r => r.storyId).join(', ')}`);
        }
        if (totalBugs > 0 && total > 0) {
          const bugRate = (totalBugs / total).toFixed(2);
          bugSuggestions.push(`Bug/Story 比率: ${bugRate}，可运行 bug_analyze() 查看详细报告`);
        }

        return {
          _dashboard: dashboard,
          _hint: '请将仪表盘展示在最前面',
          _phases: phases,
          _bugSummary: bugSuggestions.length > 0 ? bugSuggestions.join('\n') : '无 bug 问题',
          _testMissing: withoutTests.length > 0
            ? `缺少测试的 Story: ${withoutTests.map(r => r.storyId).join(', ')}`
            : '所有 Story 都有测试证据',
          stories: filtered,
        };
      }
      return filtered;
    },

    story_review(args: { storyId: string }): object {
      const story = store.readStory(args.storyId);
      const cl = store.readChecklist(args.storyId);

      // 读取真相源
      const config = loadConfig(ctx.root);
      const reqDir = join(ctx.root, config.requirementsDir);
      const truthDocs: string[] = [];
      if (existsSync(reqDir)) {
        const scanDir = (dir: string) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) { scanDir(join(dir, entry.name)); continue; }
            if (entry.name.endsWith('.md')) {
              truthDocs.push(readFileSync(join(dir, entry.name), 'utf-8'));
            }
          }
        };
        scanDir(reqDir);
      }

      const issues: Array<{ type: string; severity: 'blocker' | 'advisory'; itemId?: string; message: string }> = [];

      // 0. checklist 拆分质量静态检查
      // 0.1 数量异常
      if (cl.items.length === 0) {
        issues.push({ type: 'split_quality', severity: 'blocker', message: 'checklist 为空' });
      } else if (cl.items.length > 15) {
        issues.push({ type: 'split_quality', severity: 'advisory', message: `checklist 项数过多 (${cl.items.length})，可能存在过碎的拆分，建议合并相关 item` });
      }
      // 0.2 title/context 质量
      for (const item of cl.items) {
        if (!item.title || item.title.trim().length < 4) {
          issues.push({ type: 'split_quality', severity: 'blocker', itemId: item.id, message: `${item.id} title 过短或缺失` });
        }
        if (!(item as any).context || (item as any).context.trim().length < 8) {
          issues.push({ type: 'split_quality', severity: 'advisory', itemId: item.id, message: `${item.id} 缺少 context（根因/参考方案）` });
        }
      }
      // 0.3 颗粒度一致性：title 长度差异过大可能表示颗粒度不一致
      if (cl.items.length >= 3) {
        const titleLens = cl.items.map(i => (i.title || '').length);
        const avg = titleLens.reduce((a, b) => a + b, 0) / titleLens.length;
        const maxDiff = Math.max(...titleLens) - Math.min(...titleLens);
        if (avg > 0 && maxDiff > avg * 2) {
          issues.push({
            type: 'split_quality',
            severity: 'advisory',
            message: `checklist item 颗粒度可能不一致（title 长度差异较大: ${Math.min(...titleLens)}~${Math.max(...titleLens)}），请检查是否需要拆分/合并`,
          });
        }
      }

      // 1. 检查每个 item 是否有 testIntent（happy 必填，edge/adversarial 选填但建议补全）
      for (const item of cl.items) {
        if (item.testIntent === null) continue; // 标记为不可自动化测试，跳过
        if (!item.testIntent) {
          issues.push({ type: 'missing_intent', severity: 'blocker', itemId: item.id, message: `${item.id}「${item.title}」缺少 testIntent` });
          continue;
        }
        if (!item.testIntent.happy || item.testIntent.happy.length === 0) {
          issues.push({ type: 'weak_intent', severity: 'blocker', itemId: item.id, message: `${item.id} happy 栏为空（必填）` });
        }
        if (!item.testIntent.edge || item.testIntent.edge.length === 0) {
          issues.push({ type: 'weak_intent', severity: 'advisory', itemId: item.id, message: `${item.id} edge 栏为空（建议补全）` });
        }
        if (!item.testIntent.adversarial || item.testIntent.adversarial.length === 0) {
          issues.push({ type: 'weak_intent', severity: 'advisory', itemId: item.id, message: `${item.id} adversarial 栏为空（建议补全）` });
        }
      }

      // 2. intent-case 覆盖率报告
      const config2 = loadConfig(ctx.root);
      const fixturesDir2 = join(ctx.root, config2.fixturesDir);
      const allIntentRefs = new Set<string>();
      if (existsSync(fixturesDir2)) {
        const scanFixtures = (dir: string) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) { scanFixtures(join(dir, entry.name)); continue; }
            if (!entry.name.endsWith('.json')) continue;
            try {
              const content = JSON.parse(readFileSync(join(dir, entry.name), 'utf-8'));
              for (const c of content.cases || []) {
                if (c.intentRef && typeof c.intentRef === 'string') {
                  allIntentRefs.add(c.intentRef);
                }
              }
            } catch { /* ignore */ }
          }
        };
        scanFixtures(fixturesDir2);
      }

      const intentCoverage: Array<{ itemId: string; lane: string; index: number; text: string; covered: boolean }> = [];
      for (const item of cl.items) {
        if (!item.testIntent) continue;
        for (const lane of ['happy', 'edge', 'adversarial'] as const) {
          const entries = item.testIntent[lane] || [];
          for (let i = 0; i < entries.length; i++) {
            const ref = `${item.id}:${lane}:${i}`;
            const entry = entries[i];
            const text = typeof entry === 'string' ? entry : (entry as { desc: string }).desc;
            intentCoverage.push({
              itemId: item.id,
              lane,
              index: i,
              text,
              covered: allIntentRefs.has(ref),
            });
          }
        }
      }

      const coveredCount = intentCoverage.filter(c => c.covered).length;
      const totalIntentEntries = intentCoverage.length;
      const coveragePct = totalIntentEntries > 0 ? Math.round(coveredCount / totalIntentEntries * 100) : 100;

      // 3. 检查 item 之间的交叉场景
      const itemTitles = cl.items.map(i => i.title);
      if (cl.items.length >= 2) {
        const crossPairs: Array<[string, string]> = [];
        for (let i = 0; i < cl.items.length; i++) {
          for (let j = i + 1; j < cl.items.length; j++) {
            crossPairs.push([cl.items[i].id, cl.items[j].id]);
          }
        }
        // 检查是否有任何 testIntent 提到了其他 item 的关键词（简单文本匹配）
        const extractText = (e: string | { desc: string }) => typeof e === 'string' ? e : e.desc;
        const allIntentTexts = cl.items
          .filter(i => i.testIntent)
          .flatMap(i => [
            ...(i.testIntent!.happy || []).map(extractText),
            ...(i.testIntent!.edge || []).map(extractText),
            ...(i.testIntent!.adversarial || []).map(extractText),
          ])
          .join(' ');

        if (crossPairs.length > 0 && cl.items.every(i => i.testIntent)) {
          // 如果没有任何 intent 文本引用其他 item 的关键词，提示可能遗漏交叉场景
          let hasCrossRef = false;
          for (const item of cl.items) {
            if (!item.testIntent) continue;
            const texts = [
              ...(item.testIntent.happy || []).map(extractText),
              ...(item.testIntent.edge || []).map(extractText),
              ...(item.testIntent.adversarial || []).map(extractText),
            ].join(' ');
            for (const other of cl.items) {
              if (other.id === item.id) continue;
              // 从 title 提取关键词（去掉常见虚词）
              const keywords = other.title.split(/[\s,，、]+/).filter(w => w.length > 1);
              if (keywords.some(kw => texts.includes(kw))) { hasCrossRef = true; break; }
            }
            if (hasCrossRef) break;
          }
          if (!hasCrossRef) {
            issues.push({
              type: 'cross_scenario',
              severity: 'advisory',
              message: `${cl.items.length} 个 checklist item 的 testIntent 之间没有交叉引用，可能遗漏组合场景（如：${cl.items[0].title} + ${cl.items[1].title} 同时操作会怎样？）`,
            });
          }
        }
      }

      // 3. 确保 issueCount > 0（审查必须产出至少一个 advisory）
      if (issues.length === 0) {
        issues.push({
          type: 'review_advisory',
          severity: 'advisory',
          message: '审查未发现 blocker，但建议对照 _reviewPrompt 中的真相源文档人工复核 testIntent 完整性',
        });
      }

      // 4. 统计
      const totalItems = cl.items.length;
      const withIntent = cl.items.filter(i => i.testIntent && i.testIntent !== null).length;
      const skippedItems = cl.items.filter(i => i.testIntent === null).length;
      const totalIntents = cl.items.reduce((sum, i) => {
        if (!i.testIntent || i.testIntent === null) return sum;
        return sum + (i.testIntent.happy?.length || 0) + (i.testIntent.edge?.length || 0) + (i.testIntent.adversarial?.length || 0);
      }, 0);
      const blockerCount = issues.filter(i => i.severity === 'blocker').length;

      // 5. 写入 review.json（带签名，防止主 agent 伪造）
      const reviewData = store.readReview(args.storyId);
      const timestamp = new Date().toISOString();
      const reviewEntry = {
        timestamp,
        issueCount: issues.length,
        blockerCount,
        issues,
        _hash: '',
      };
      // 签名 = sha256(storyId + timestamp + issueCount + blockerCount + 固定盐)
      const REVIEW_SALT = 'koala-review-integrity-v1';
      const hashInput = `${args.storyId}:${timestamp}:${issues.length}:${blockerCount}:${REVIEW_SALT}`;
      reviewEntry._hash = createHash('sha256').update(hashInput).digest('hex');
      reviewData.reviews.push(reviewEntry);
      store.writeReview(args.storyId, reviewData);

      return {
        storyId: args.storyId,
        title: story.title,
        reviewRound: reviewData.reviews.length,
        summary: {
          totalItems,
          withIntent,
          withoutIntent: totalItems - withIntent,
          totalIntents,
          issueCount: issues.length,
          blockerCount,
          intentCoverage: {
            covered: coveredCount,
            total: totalIntentEntries,
            percentage: coveragePct,
          },
        },
        issues,
        intentCoverageDetail: intentCoverage.length > 0
          ? intentCoverage.filter(c => !c.covered).map(c => `${c.itemId}:${c.lane}:${c.index} → ${c.text}`)
          : undefined,
        truthDocsCount: truthDocs.length,
        _hint: blockerCount > 0
          ? `第 ${reviewData.reviews.length} 轮审查发现 ${blockerCount} 个 blocker，请修复后再次 story_review`
          : `✅ 第 ${reviewData.reviews.length} 轮审查通过（${blockerCount} blocker, ${issues.length} advisory）${coveragePct < 100 ? `，intent 覆盖率 ${coveragePct}%（${coveredCount}/${totalIntentEntries}）` : ''}，可进入开发`,
        _reviewPrompt: truthDocs.length > 0
          ? `以下是真相源文档（${truthDocs.length} 篇），请对照检查 checklist 是否遗漏了需求中的场景：\n\n---\nStory: ${story.title}\nDescription: ${story.description}\n\nChecklist + TestIntent:\n${cl.items.map(i => { const et = (e: string | { desc: string }) => typeof e === 'string' ? e : e.desc; return `- ${i.id}: ${i.title}\n  ${i.testIntent ? `happy: ${(i.testIntent.happy || []).map(et).join('; ')}\n  edge: ${(i.testIntent.edge || []).map(et).join('; ')}\n  adversarial: ${(i.testIntent.adversarial || []).map(et).join('; ')}` : '(无 testIntent)'}` }).join('\n')}\n\n---\nTruth Source:\n${truthDocs.join('\n---\n')}`
          : undefined,
      };
    },

  };
  return handlers;
}
