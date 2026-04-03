
import type { HandlerContext } from './context.js';
import { collectContext, nextStoryId, PHASE_TO_EVENT } from './context.js';
import { createStoryActor, getStateName, getGuardFailureReason } from '../../story/machine.js';
import type { StoryInfo, StoryPhase, StoryType } from '../../story/types.js';
import { checkCoverage } from '../../tasks/coverage.js';
import { MetadataStore } from '../../tasks/metadata-store.js';
import { validateMetadata } from '../../tasks/metadata-validate.js';
import { loadConfig } from '../../config.js';
import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';

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
      checklist?: Array<{ title: string }>;
      prefix?: string;
      phase?: StoryPhase;
    }): string {
      const storyId = nextStoryId(store, args.prefix);
      const now = new Date().toISOString();
      const hasChecklist = args.checklist && args.checklist.length > 0;

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
              status: (isDone ? 'done' : 'pending') as 'done' | 'pending',
              startTime: isDone ? now : null,
              endTime: isDone ? now : null,
            })),
          };
          store.writeChecklist(storyId, checklist);
        }
        return `Story ${storyId} created (${args.phase})${hasChecklist ? ` with ${args.checklist!.length} checklist items` : ''}`;
      }

      // 正常模式
      const phase: StoryPhase = hasChecklist ? 'PLAN' : 'IDEA';
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
            status: 'pending' as const,
            startTime: null,
            endTime: null,
          })),
        };
        store.writeChecklist(storyId, checklist);
        const noContext = args.checklist!.filter((c: any) => !c.context).length;
        const hint = noContext > 0 ? `\n⚠ ${noContext} 项缺少 context（根因/参考），建议补充以帮助执行 agent 理解上下文` : '';
        return `Story ${storyId} created (PLAN) with ${checklist.items.length} checklist items${hint}`;
      }

      return `Story ${storyId} created (IDEA)`;
    },

    /** 一键创建 Story + 推进到 DEV（story_quick CLI 会额外调 dev_start 开 worktree） */
    story_quick(args: {
      name: string;
      title: string;
      description: string;
      type: StoryType;
      priority: string;
      checklist: Array<{ title: string; context?: string }>;
      prefix?: string;
    }): string {
      const createResult = handlers.story_create({ ...args });
      const storyId = createResult.match(/Story\s+([\w-]+)/)?.[1];
      if (!storyId) return createResult;
      return `${createResult}\n__storyId__=${storyId}`;
    },

    story_advance(args: {
      storyId: string;
      phase: StoryPhase;
      checklist?: Array<{ id: string; title: string }>;
    }): string {
      const story = store.readStory(args.storyId);

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

      const actor = createStoryActor(args.storyId, store, story.phase);
      actor.start();

      const eventType = PHASE_TO_EVENT[args.phase];
      if (!eventType) {
        throw new Error(`Invalid target phase: ${args.phase}`);
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

      // DEV→TEST 严格门禁（项目级，不限当前 story）
      if (args.phase === 'TEST') {
        const errors: string[] = [];
        const hints: string[] = [];
        const root = ctx.root;
        const config = loadConfig(root);
        const metaStore = new MetadataStore(root);

        // 1. checklist 覆盖率（原有）
        const coverage = checkCoverage(args.storyId, store, scanRoot);
        if (!coverage.passed) {
          const missing = coverage.items.filter(i => !i.covered).map(i => `${i.checklistId}: ${i.title}`);
          errors.push(`${coverage.missing} checklist 项缺少代码覆盖:\n${missing.map(m => `  - ${m}`).join('\n')}`);
          hints.push('用 task_annotate 给函数添加对应 checklist ID');
        }

        // 2. 每个函数必须有 test 字段
        const taskStore = metaStore.readTasks();
        const noTest = taskStore.tasks.filter(t => t.functionName && !t.test && t.test !== 'skip');
        if (noTest.length > 0) {
          const fixItems = noTest.slice(0, 10).map(t =>
            `  - ${t.functionName} (${t.sourceFile}) → koala task_annotate '{"sourceFile":"${t.sourceFile}","functionName":"${t.functionName}","action":"update","task":"${t.task}","checklist":"${Array.isArray(t.checklist)?t.checklist[0]:t.checklist}","title":"fix","type":"${t.type}","priority":"${t.priority}","description":"fix","changes":["fix"],"test":"fixture名或skip"}'`
          );
          errors.push(`${noTest.length} 个函数缺少 test 字段:\n${fixItems.join('\n')}${noTest.length > 10 ? `\n  ... 等 ${noTest.length} 个` : ''}`);
          hints.push('把上面的 "fixture名或skip" 替换为实际值后执行，或用 task_annotate_batch 批量修复');
        }

        // 3. 孤儿元数据（task.json 有但源码函数已删）
        const validation = validateMetadata(taskStore.tasks, scanRoot);
        if (validation.orphanRecords.length > 0) {
          errors.push(`${validation.orphanRecords.length} 条孤儿元数据（函数已删除）:\n${validation.orphanRecords.map(r => `  - ${r.key}: ${r.reason}`).join('\n')}`);
          hints.push(`→ koala task_sync '{"direction":"validate"}' 查看详情\n→ 用 task_annotate(action=update) 更新 sourceFile，或直接编辑 task.json 删除过时记录`);
        }

        // 4. 过时 fixture（fixture 里的 fn 指向不存在的函数）
        const fixturesDir = join(root, config.fixturesDir);
        if (existsSync(fixturesDir)) {
          const fnNames = new Set(taskStore.tasks.map(t => t.functionName).filter(Boolean));
          const staleFixtures: string[] = [];
          const matchesFn = (fn: string): boolean => {
            if (fnNames.has(fn)) return true;
            // 支持 ClassName.methodName：检查 ClassName 或 methodName 是否在函数列表中
            if (fn.includes('.')) {
              const [className, methodName] = fn.split('.');
              return fnNames.has(className) || fnNames.has(methodName);
            }
            return false;
          };
          const scanFixtureDir = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              if (entry.isDirectory()) { scanFixtureDir(join(dir, entry.name)); continue; }
              if (!entry.name.endsWith('.json')) continue;
              try {
                const content = JSON.parse(readFileSync(join(dir, entry.name), 'utf-8'));
                const fixtureName = entry.name.replace('.json', '');
                for (const c of content.cases || []) {
                  if (c.fn && !matchesFn(c.fn)) {
                    staleFixtures.push(`${entry.name}: fn="${c.fn}" 不存在 → koala fixture_update '{"fixturePath":"${fixtureName}","action":"update","case":{"name":"${c.name}","fn":"正确的函数名"}}'`);
                  }
                }
              } catch { /* ignore */ }
            }
          };
          scanFixtureDir(fixturesDir);
          if (staleFixtures.length > 0) {
            errors.push(`${staleFixtures.length} 个过时 fixture case:\n${staleFixtures.map(s => `  - ${s}`).join('\n')}`);
            hints.push('用 fixture_update 删除过时的 case，或更新 fn 字段');
          }
        }

        if (errors.length > 0) {
          actor.stop();
          throw new Error(
            `Cannot enter TEST: ${errors.length} 项检查未通过:\n\n` +
            errors.map((e, i) => `[${i + 1}] ${e}`).join('\n\n') +
            '\n\n修复建议:\n' + hints.map(h => `→ ${h}`).join('\n')
          );
        }
      }

      // TEST→DONE 严格门禁：所有测试 100% PASS
      if (args.phase === 'DONE') {
        const errors: string[] = [];
        const evidence = store.readTestEvidence(args.storyId);

        // 1. 必须有 test_auto 记录
        const autoTests = evidence.tests.filter(t =>
          t.id.startsWith('TE-AUTO-') || t.id.startsWith('TE-E2E-') || t.id.startsWith('TE-CLI-') || t.id.startsWith('TE-BROWSER-')
        );
        if (autoTests.length === 0) {
          errors.push('没有 test_auto 测试证据。先跑 test_auto(full=true)');
        }

        // 2. 所有测试必须 PASS
        const failedTests = evidence.tests.filter(t => t.result === 'FAIL');
        if (failedTests.length > 0) {
          errors.push(`${failedTests.length} 个测试 FAIL:\n${failedTests.map(t => `  - ${t.scenario}: ${t.output}`).join('\n')}`);
        }

        // 3. 有 browser 配置的项目检查 browser test 证据（warning，不阻塞——CLI 环境可能无浏览器）
        const root = ctx.root;
        const config = loadConfig(root);
        if (config.browser?.devCommand) {
          const browserTests = evidence.tests.filter(t => t.id.startsWith('TE-BROWSER-') || t.scenario?.startsWith('browser:'));
          if (browserTests.length === 0) {
            // 降级为 warning：CLI/CI 环境无浏览器时不应阻塞
            // 日志提醒但不阻塞
          }
        }

        if (errors.length > 0) {
          actor.stop();
          throw new Error(
            `Cannot enter DONE: ${errors.length} 项检查未通过:\n\n` +
            errors.map((e, i) => `[${i + 1}] ${e}`).join('\n\n')
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

      const nextSteps: Record<string, string> = {
        PLAN: `→ 下一步: checklist_get(${args.storyId}) 查看待开发项，然后 story_advance(${args.storyId}, DEV) 开始开发`,
        DEV: `→ 下一步: dev_start(${args.storyId}) 创建 worktree 开发环境，开发完成后 dev_finish(${args.storyId}) 合并`,
        TEST: `→ 必须立即执行: test_auto(${args.storyId}, full=true) 全量真机测试，等待结果后再决定下一步`,
        DONE: `→ 必须立即执行: convergence_check 检查项目收敛状态，未收敛则 gap_analyze 查看差距`,
      };
      return `Story ${args.storyId} advanced to ${newState}\n${nextSteps[newState] || ''}${depsWarning}${sessionWarning}`;
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

    story_get(args: { storyId: string }): StoryInfo {
      return store.readStory(args.storyId);
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
        const testsPass = evidence.tests.filter(t => t.result === 'PASS').length;
        const testsTotal = evidence.tests.length;

        return {
          storyId: id,
          name: story.name || '',
          title: story.title,
          phase: story.phase,
          priority: story.priority,
          type: story.type,
          checklist: clTotal > 0 ? `${clDone}/${clTotal}` : '-',
          bugs: bugsOpen > 0 ? `${bugsOpen} open, ${bugsFixed} fixed` : (bugsFixed > 0 ? `${bugsFixed} fixed` : 'none'),
          tests: testsTotal > 0 ? `${testsPass}/${testsTotal} pass` : 'none',
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
        const autoTested = results.filter(r => {
          try {
            const ev = store.readTestEvidence(r.storyId);
            return ev.tests.some(t => t.id.startsWith('TE-AUTO-') || t.id.startsWith('TE-E2E-'));
          } catch { return false; }
        });

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
        const autoPct = total > 0 ? Math.round(autoTested.length / total * 100) : 0;
        const bugFreePct = total > 0 ? Math.round((total - storiesWithBugs.length - bugStories.length) / total * 100) : 0;

        const dashboard = [
          `Story 完成率    ${mkBar(storyPct)} ${storyPct}% (${done}/${total} DONE)`,
          `测试覆盖        ${mkBar(testPct)} ${testPct}% (${withTests.length}/${total} 有测试证据)`,
          `真机测试(auto)  ${mkBar(autoPct)} ${autoPct}% (${autoTested.length}/${total} 有 test_auto 记录)`,
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
          _autoTestMissing: total - autoTested.length > 0
            ? `缺少真机测试的 Story: ${results.filter(r => !autoTested.find(a => a.storyId === r.storyId)).map(r => r.storyId).join(', ')}`
            : '所有 Story 都有真机测试记录',
          stories: filtered,
        };
      }
      return filtered;
    },

  };
  return handlers;
}
