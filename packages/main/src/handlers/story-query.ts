
import type { HandlerContext } from './context.js';
import type { StoryPhase } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';

export function createStoryQueryHandlers(ctx: HandlerContext) {
  const { store } = ctx;

  return {
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
        try { result.index = store.readStory(args.storyId); } catch { result.index = null; }
      }
      return result;
    },

    story_list(args?: { phase?: StoryPhase; active?: boolean }) {
      // B-89c7 CHK-016: active=true is a preset for "non-terminal phases"
      // (exclude DONE / DISCARDED / IDEA). Mutually exclusive with phase.
      if (args?.active && args?.phase) {
        throw new Error('story_list: active and phase are mutually exclusive');
      }
      const ACTIVE_PHASES = new Set<StoryPhase>([
        'INIT' as StoryPhase,
        'INIT_CHECK' as StoryPhase,
        'PLAN' as StoryPhase,
        'DEV' as StoryPhase,
        'TEST_CASE' as StoryPhase,
        'TEST_CASE_REVIEW' as StoryPhase,
        'TEST' as StoryPhase,
      ]);
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

      const filtered = args?.phase
        ? results.filter(r => r.phase === args.phase)
        : args?.active
        ? results.filter(r => ACTIVE_PHASES.has(r.phase as StoryPhase))
        : results;

      // 仪表盘摘要（无 phase/active 过滤时生成）
      if (!args?.phase && !args?.active) {
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
  };
}
