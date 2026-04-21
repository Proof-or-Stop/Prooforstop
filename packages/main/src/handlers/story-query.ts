
import { execFileSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import type { StoryPhase } from '../core/types.js';
import type { StoryStore } from '../core/store.js';
import { formatProcessMetricsSummary } from '../core/process-metrics.js';
import { getRepoRoot } from '../core/worktree-runtime.js';

/** B-45ed CHK-008: 若 story 的 background.md 文件存在则返回 true。 */
function hasBackground(root: string, storyId: string): boolean {
  return existsSync(join(root, 'docs', 'story', 'actives', storyId, 'background.md'));
}

// ─── Non-terminal phases for zombie detection ──────────────────────────────

const NON_TERMINAL_PHASES = new Set<string>([
  'INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW',
  'TEST_CASE', 'TEST_CASE_REVIEW', 'TEST',
]);

/**
 * Helper: run git command via execFileSync, return trimmed stdout.
 * Returns empty string on any failure.
 */
function gitSafe(projectRoot: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Detect "zombie" stories: phase is non-terminal but the story branch
 * has already been merged into main (or the branch no longer exists).
 */
export function detectZombieStories(
  store: StoryStore,
  projectRoot: string,
): Array<{ storyId: string; reason: string }> {
  try {
    const repoRoot = getRepoRoot(projectRoot);

    // Get branches already merged into main
    const mergedRaw = gitSafe(repoRoot, ['branch', '--merged', 'main', '--format=%(refname:short)']);
    const mergedBranches = new Set(
      mergedRaw.split('\n').map(b => b.trim()).filter(Boolean),
    );

    // Get all existing branches
    const allRaw = gitSafe(repoRoot, ['branch', '--format=%(refname:short)']);
    const allBranches = new Set(
      allRaw.split('\n').map(b => b.trim()).filter(Boolean),
    );

    const zombies: Array<{ storyId: string; reason: string }> = [];
    const ids = store.listStoryIds();

    for (const id of ids) {
      let story;
      try { story = store.readStory(id); } catch { continue; }
      if (!NON_TERMINAL_PHASES.has(story.phase)) continue;

      const branch = story.worktree?.branch || `story/${id}`;

      // INIT stories without a branch yet are normal
      if (story.phase === 'INIT' && !allBranches.has(branch)) continue;

      if (mergedBranches.has(branch)) {
        zombies.push({
          storyId: id,
          reason: `branch ${branch} already merged into main but phase=${story.phase}`,
        });
      } else if (!allBranches.has(branch) && story.phase !== 'INIT') {
        zombies.push({
          storyId: id,
          reason: `branch ${branch} no longer exists but phase=${story.phase}`,
        });
      }
    }

    return zombies;
  } catch {
    return [];
  }
}

/**
 * Detect story residue: .worktrees/ directories that belong to stories
 * whose phase is already DONE or DISCARDED. These should have been
 * cleaned up but weren't.
 */
export function detectStoryResidue(
  store: StoryStore,
  projectRoot: string,
): Array<{ storyId: string; reason: string }> {
  try {
    const repoRoot = getRepoRoot(projectRoot);
    const worktreesDir = join(repoRoot, '.worktrees');
    if (!existsSync(worktreesDir)) return [];

    const entries = readdirSync(worktreesDir, { withFileTypes: true });
    const residues: Array<{ storyId: string; reason: string }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // worktree dirs are named B-xxxx
      const dirName = entry.name;
      if (!dirName.startsWith('B-')) continue;

      let story;
      try { story = store.readStory(dirName); } catch { continue; }

      if (story.phase === 'DONE' || story.phase === 'DISCARDED') {
        residues.push({
          storyId: dirName,
          reason: `worktree .worktrees/${dirName} still exists but phase=${story.phase}`,
        });
      }
    }

    return residues;
  } catch {
    return [];
  }
}

export function createStoryQueryHandlers(ctx: HandlerContext) {
  const { store, root } = ctx;

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
      const cl = (() => {
        try { return store.readChecklist(args.storyId); } catch { return { items: [] }; }
      })();

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

      // B-5fa4 CHK-002: zombie + residue detection
      const zombies = detectZombieStories(store, root);
      const residues = detectStoryResidue(store, root);
      const zombieIds = new Set(zombies.map(z => z.storyId));
      const residueIds = new Set(residues.map(r => r.storyId));

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

        // B-abd8: process metrics summary
        const pm = store.readProcessMetrics(id);
        const metricsField = pm ? formatProcessMetricsSummary(pm, 'verbose') : null;

        // B-45ed CHK-008: bg:✓ 标记（仅在 background.md 存在时输出字段，不存在时省略字段不报错）
        const bgFlag = hasBackground(root, id) ? 'bg:✓' : null;

        // B-5fa4 CHK-002: append [zombie] / [residue] labels
        const labels: string[] = [];
        if (zombieIds.has(id)) labels.push('[zombie]');
        if (residueIds.has(id)) labels.push('[residue]');

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
          ...(metricsField ? { metrics: metricsField } : {}),
          ...(bgFlag ? { bg: bgFlag } : {}),
          ...(labels.length > 0 ? { labels: labels.join(' ') } : {}),
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

        // B-5fa4 CHK-002: zombie + residue warnings in dashboard
        if (zombies.length > 0) {
          bugSuggestions.push(
            `⚠ 僵尸 story (${zombies.length}): ${zombies.map(z => z.storyId).join(', ')} — 分支已合并/删除但 phase 非终态`,
          );
        }
        if (residues.length > 0) {
          bugSuggestions.push(
            `⚠ Residue (${residues.length}): ${residues.map(r => r.storyId).join(', ')} — phase 已终态但 worktree 目录未清理`,
          );
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
