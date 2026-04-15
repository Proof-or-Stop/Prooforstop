
import type { HandlerContext } from './context.js';
import type { StoryPhase, StoryInfo } from '../core/types.js';
import { collectContext } from './context.js';
import { loadConfig } from '../core/config.js';
import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';

// ─── 僵尸 story 检测：分支已合并到 main 但 phase 不是 DONE ─────────────────

const NON_TERMINAL_PHASES = new Set<string>([
  'INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'TEST_CASE', 'TEST_CASE_REVIEW', 'TEST',
]);

interface ZombieInfo {
  storyId: string;
  phase: string;
  branch: string;
  branchExists: boolean;
  branchMerged: boolean;
  worktreeExists: boolean;
  worktreePath?: string;
}

/**
 * 检测"僵尸" story：phase 非终态但分支已合并到 main（或分支已删除）。
 * 返回所有异常 story 列表。
 */
export function detectZombieStories(store: import('../core/store.js').StoryStore, root: string): ZombieInfo[] {
  const zombies: ZombieInfo[] = [];
  const ids = store.listStoryIds();
  const readLocalBranches = (args: string): Set<string> => {
    const raw = execSync(`git for-each-ref --format='%(refname:short)' ${args} refs/heads`, {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new Set(raw.split('\n').map(l => l.trim()).filter(Boolean));
  };

  // 拿已合并到 main 的分支列表（一次 git 调用覆盖所有 story）
  let mergedBranches: Set<string>;
  try {
    mergedBranches = readLocalBranches('--merged=main');
  } catch {
    return []; // git 不可用，跳过
  }

  // 拿所有本地分支名
  let allBranches: Set<string>;
  try {
    allBranches = readLocalBranches('');
  } catch {
    allBranches = new Set();
  }

  for (const id of ids) {
    let story: StoryInfo;
    try { story = store.readStory(id); } catch { continue; }
    if (!NON_TERMINAL_PHASES.has(story.phase)) continue;

    const branch = story.worktree?.branch || `story/${id}`;
    const branchExists = allBranches.has(branch);
    const branchMerged = mergedBranches.has(branch);

    // 分支已合并到 main，或分支已删除（被人手动删了或 merge 后删了）
    // 对于 INIT/INIT_CHECK，分支可能还没创建，不算僵尸
    if (story.phase === 'INIT' || story.phase === 'INIT_CHECK') {
      if (!branchExists) continue; // 分支还没创建，正常
    }

    const branchGone = !branchExists && (story.phase !== 'INIT' && story.phase !== 'INIT_CHECK');

    if (!branchMerged && !branchGone) continue;

    let worktreeExists = false;
    let worktreePath: string | undefined;
    if (story.worktree?.path) {
      worktreePath = join(root, story.worktree.path);
      worktreeExists = existsSync(worktreePath);
    }

    zombies.push({
      storyId: id,
      phase: story.phase,
      branch,
      branchExists,
      branchMerged,
      worktreeExists,
      worktreePath,
    });
  }

  return zombies;
}

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
      lane?: 'mainline' | 'supporting' | 'exploratory';
      parallelSafe?: 'yes' | 'no' | 'plan_only';
      sharedHotspots?: string[];
      blockingFor?: string[];
    }): string {
      const story = store.readStory(args.storyId);
      if (args.title !== undefined) story.title = args.title;
      if (args.description !== undefined) story.description = args.description;
      if (args.priority !== undefined) story.priority = args.priority;
      if (args.source !== undefined) story.source = args.source;
      if (args.depends !== undefined) story.depends = args.depends;
      if (args.lane !== undefined) story.lane = args.lane;
      if (args.parallelSafe !== undefined) story.parallelSafe = args.parallelSafe;
      if (args.sharedHotspots !== undefined) story.sharedHotspots = args.sharedHotspots;
      if (args.blockingFor !== undefined) story.blockingFor = args.blockingFor;
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

        // 僵尸 story 检测
        const zombies = detectZombieStories(store, ctx.root);
        const zombieWarning = zombies.length > 0
          ? `⚠ 僵尸 story (${zombies.length}): ${zombies.map(z => `${z.storyId}(${z.phase})`).join(', ')} — 分支已合并/删除但 phase 非终态，运行 story_reconcile 修复`
          : null;
        if (zombieWarning) bugSuggestions.push(zombieWarning);

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

    /**
     * story_reconcile — 检测并修复"僵尸" story
     *
     * 场景：分支已手动合并回 main 或被删除，但 story 状态文件仍停在非终态。
     * dryRun=true（默认）只报告，不修改；dryRun=false 执行修复。
     */
    story_reconcile(args?: { dryRun?: boolean }): string {
      const dryRun = args?.dryRun !== false; // 默认 dry run
      const zombies = detectZombieStories(store, ctx.root);

      if (zombies.length === 0) {
        return 'story_reconcile: 未检测到僵尸 story，所有非终态 story 的分支状态正常。';
      }

      const lines: string[] = [];
      lines.push(`检测到 ${zombies.length} 个僵尸 story（分支已合并/删除但 phase 非终态）：`);
      lines.push('');

      for (const z of zombies) {
        const reason = z.branchMerged
          ? `分支 ${z.branch} 已合并到 main`
          : `分支 ${z.branch} 已不存在`;
        lines.push(`  ${z.storyId}  phase=${z.phase}  ${reason}`);

        if (z.worktreeExists) {
          lines.push(`    worktree: ${z.worktreePath} (仍存在)`);
        } else if (z.worktreePath) {
          lines.push(`    worktree: ${z.worktreePath} (已不存在)`);
        }

        if (!dryRun) {
          const story = store.readStory(z.storyId);
          const actions: string[] = [];

          // 清理 worktree 目录
          if (z.worktreeExists && z.worktreePath) {
            try {
              execSync(`git worktree remove --force "${z.worktreePath}"`, {
                cwd: ctx.root, stdio: 'pipe',
              });
              actions.push('worktree 已移除');
            } catch {
              // worktree remove 失败时尝试直接删目录
              try {
                const { rmSync } = require('fs');
                rmSync(z.worktreePath, { recursive: true, force: true });
                actions.push('worktree 目录已强制删除');
              } catch { actions.push('worktree 清理失败'); }
            }
          }

          // 删除已合并的分支
          if (z.branchExists) {
            try {
              execSync(`git branch -d "${z.branch}"`, { cwd: ctx.root, stdio: 'pipe' });
              actions.push(`分支 ${z.branch} 已删除`);
            } catch {
              actions.push(`分支 ${z.branch} 删除失败（可能有未合并提交）`);
            }
          }

          // 更新 story 状态为 DONE
          story.phase = 'DONE' as StoryPhase;
          story.endedAt = new Date().toISOString();
          story.worktree = undefined;
          if (!story.events) story.events = [];
          const event = collectContext('DONE' as StoryPhase, 'advance');
          (event as any).reconciled = true;
          (event as any).reason = `story_reconcile: ${z.branchMerged ? '分支已合并到 main' : '分支已删除'}`;
          story.events.push(event);
          store.writeStory(z.storyId, story);
          actions.push('phase → DONE');

          lines.push(`    → 已修复: ${actions.join(', ')}`);
        }
      }

      if (dryRun) {
        lines.push('');
        lines.push('以上为 dry run 结果，未做任何修改。');
        lines.push('执行修复: koala story_reconcile \'{"dryRun":false}\'');
      }

      return lines.join('\n');
    },
  };
}
