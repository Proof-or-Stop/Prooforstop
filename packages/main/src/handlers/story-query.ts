
import { execFileSync, execSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import type { StoryPhase, StoryInfo } from '../core/types.js';
import { StoryStore } from '../core/store.js';
import { assertCwdInWorktree, collectContext } from './context.js';
import { loadConfig } from '../core/config.js';
import { formatProcessMetricsSummary } from '../core/process-metrics.js';
import { isVolatileRuntimeArtifactPath } from '../core/runtime-artifact-registry.js';
import {
  getRepoRoot,
  getStoryWorktreeRuntime,
  isForeignAbsolutePath,
  listGitWorktrees,
  resolveWorktreePath,
} from '../core/worktree-runtime.js';
import { getLegacyActivityLogPath, getRuntimeActivityLogPath } from '../core/activity-log.js';
import { initCheckAttestationMode } from '../core/init-check-gate.js';

/** B-45ed CHK-008: 若 story 的 background.md 文件存在则返回 true。 */
function hasBackground(store: StoryStore, storyId: string): boolean {
  return existsSync(store.storyFilePath(storyId, 'background.md'));
}

// ─── Non-terminal phases for zombie detection ──────────────────────────────

const NON_TERMINAL_PHASES = new Set<string>([
  'INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW',
  'TEST_CASE', 'TEST_CASE_REVIEW', 'TEST',
]);

interface ZombieInfo {
  storyId: string;
  phase: string;
  branch: string;
  branchExists: boolean;
  branchMerged: boolean;
  worktreeExists: boolean;
  worktreePath?: string;
  worktreeForeignPath?: boolean;
}

interface StoryResidueInfo {
  storyId: string;
  phase: string;
  path: string;
  safe: boolean;
  status: string;
}

interface IntentFixtureLocation {
  file: string;
  line: number;
  name: string;
}

function isLegacyIntentRef(ref: string): boolean {
  return /^CHK-\d+:(happy|edge|adversarial):\d+$/.test(ref);
}

function lineOfCaseName(raw: string, caseName: unknown): number {
  if (typeof caseName !== 'string') return 0;
  const compactIdx = raw.indexOf(`"name":"${caseName}"`);
  const prettyIdx = raw.indexOf(`"name": "${caseName}"`);
  const idx = compactIdx >= 0 ? compactIdx : prettyIdx;
  return idx >= 0 ? raw.substring(0, idx).split('\n').length : 0;
}

function relativeFixtureFile(fixturesDir: string, filePath: string): string {
  return filePath
    .replace(fixturesDir + '/', '')
    .replace(fixturesDir + '\\', '');
}

function collectStoryIntentFixtures(
  fixturesDir: string,
  storyId: string,
): Map<string, IntentFixtureLocation> {
  const refs = new Map<string, IntentFixtureLocation>();
  if (!existsSync(fixturesDir)) return refs;

  const scopedPrefix = `${storyId}:`;
  const scanDir = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) { scanDir(filePath); continue; }
      if (!entry.name.endsWith('.json')) continue;
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const content = JSON.parse(raw);
        for (const c of content.cases || []) {
          if (!c.intentRef || typeof c.intentRef !== 'string') continue;
          const ref = c.intentRef as string;
          const location = {
            file: relativeFixtureFile(fixturesDir, filePath),
            line: lineOfCaseName(raw, c.name),
            name: c.name,
          };

          if (ref.startsWith(scopedPrefix)) {
            refs.set(ref.slice(scopedPrefix.length), location);
          } else if (c.storyId === storyId && isLegacyIntentRef(ref)) {
            refs.set(ref, location);
          }
        }
      } catch { /* ignore corrupt fixture files while rendering story detail */ }
    }
  };
  scanDir(fixturesDir);
  return refs;
}

function appendJsonlContent(existing: string, incoming: string): string {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return `${existing}${existing.endsWith('\n') ? '' : '\n'}${incoming}`;
}

function removeEmptyDir(path: string): boolean {
  if (!existsSync(path)) return false;
  if (readdirSync(path).length > 0) return false;
  rmdirSync(path);
  return true;
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

function gitOutput(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function gitSucceeds(cwd: string, args: string): boolean {
  try {
    execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

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

function gitUnmergedPaths(cwd: string): string[] {
  const raw = gitOutput(cwd, 'diff --name-only --diff-filter=U');
  return raw.split('\n').map(line => line.trim().replace(/\\/g, '/')).filter(Boolean);
}

function gitPorcelainPaths(cwd: string): string[] {
  const raw = gitOutput(cwd, 'status --porcelain -uall');
  return raw.split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => line.slice(3).trim().replace(/^"|"$/g, '').replace(/\\/g, '/'));
}

/**
 * 检测"僵尸" story：phase 非终态但分支已合并到 main（或分支已删除）。
 * 返回所有异常 story 列表。
 */
export function detectZombieStories(store: StoryStore, root: string): ZombieInfo[] {
  const zombies: ZombieInfo[] = [];
  const ids = store.listStoryIds();
  const repoRoot = getRepoRoot(root);
  const linkedByBranch = new Map<string, string>();
  for (const entry of listGitWorktrees(repoRoot)) {
    if (entry.branch) linkedByBranch.set(entry.branch, entry.path);
  }
  const branches = new Set(
    gitSafe(repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean),
  );
  const mergedBranches = new Set(
    gitSafe(repoRoot, ['for-each-ref', '--format=%(refname:short)', '--merged=main', 'refs/heads'])
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean),
  );

  for (const id of ids) {
    let story: StoryInfo;
    try { story = store.readStory(id); } catch { continue; }
    if (!NON_TERMINAL_PHASES.has(story.phase)) continue;

    const branch = story.worktree?.branch || `story/${id}`;
    const branchExists = branches.has(branch);
    const branchMerged = mergedBranches.has(branch);
    const linkedPath = linkedByBranch.get(branch) || null;
    const recordedPath = story.worktree?.path ?? null;
    const recordedForeignPath = recordedPath ? isForeignAbsolutePath(recordedPath) : false;
    const recordedAbsPath = resolveWorktreePath(repoRoot, recordedPath);
    const recordedExists = Boolean(recordedAbsPath && !recordedForeignPath && existsSync(recordedAbsPath));

    // INIT 还没创建分支属于正常；INIT_CHECK 若已经有 worktree 记录/历史动作
    // 但 branch/worktree 都消失，就是 phase 被覆盖后的僵尸状态。
    if (story.phase === 'INIT') {
      if (!branchExists) continue;
    }
    if (story.phase === 'INIT_CHECK' && !branchExists) {
      const hadRuntime = Boolean(story.worktree || recordedAbsPath || (Array.isArray(story.events) && story.events.length > 1));
      const worktreeGone = !linkedPath && !recordedExists;
      if (!hadRuntime || !worktreeGone) continue;
    }

    if (linkedPath) continue;

    const branchGone = !branchExists && story.phase !== 'INIT';

    if (!branchMerged && !branchGone) continue;

    zombies.push({
      storyId: id,
      phase: story.phase,
      branch,
      branchExists,
      branchMerged,
      worktreeExists: recordedExists,
      worktreePath: recordedAbsPath || undefined,
      worktreeForeignPath: recordedForeignPath,
    });
  }

  return zombies;
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
      if (existsSync(join(worktreesDir, dirName, '.koala-repair-ignore'))) continue;

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

  function readStoryProjection(id: string, linkedWorktrees: Map<string, string>): {
    story: StoryInfo;
    sourceStore: StoryStore;
    mainPhase: StoryPhase | null;
  } {
    const mainStory = store.readStory(id);
    const linkedPath = linkedWorktrees.get(id);
    if (
      linkedPath &&
      mainStory.phase !== 'DONE' &&
      mainStory.phase !== 'DISCARDED'
    ) {
      try {
        const sourceStore = new StoryStore(linkedPath);
        const story = sourceStore.readStory(id);
        return {
          story,
          sourceStore,
          mainPhase: story.phase !== mainStory.phase ? mainStory.phase : null,
        };
      } catch {
        // PROBE: if the linked worktree cannot be read, fall back to main metadata.
      }
    }
    return { story: mainStory, sourceStore: store, mainPhase: null };
  }

  function listLinkedStoryWorktrees(): Map<string, string> {
    const out = new Map<string, string>();
    for (const entry of listGitWorktrees(root)) {
      const m = entry.branch?.match(/^story\/(.+)$/);
      if (m) out.set(m[1], entry.path);
    }
    return out;
  }

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

      // B-95d8 CHK-001: surface the INIT_CHECK attestation so callers / dashboard can
      // distinguish an independent reviewer run from a manual fallback/repair.
      const initCheck = store.readInitCheck(args.storyId);
      if (initCheck) {
        result.initCheck = initCheck;
        const attestation = initCheckAttestationMode(initCheck);
        result.initCheckAttestation = attestation;
        if (initCheck.fallback) result.initCheckFallback = initCheck.fallback;
        // B-6894: human-readable warning for fallback stories only; independent
        // reviewer stories must NOT carry this field.
        if (attestation === 'fallback') {
          result.initCheckFallbackWarning =
            'INIT_CHECK was approved via manual fallback attestation, not independent reviewer approval. ' +
            'Later PLAN/DEV/REVIEW/TEST gates remain required. ' +
            'Implementation and continuation require explicit user/project authorization if this is not the requested project.';
        }
      }

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

      const linkedWorktrees = listLinkedStoryWorktrees();
      const results = ids.map(id => {
        const { story, sourceStore, mainPhase } = readStoryProjection(id, linkedWorktrees);
        const cl = (() => {
          try { return sourceStore.readChecklist(id); } catch { return { items: [] }; }
        })();
        const bugs = sourceStore.readBugs(id);
        const evidence = sourceStore.readTestEvidence(id);

        const clDone = cl.items.filter(i => i.status === 'done').length;
        const clTotal = cl.items.length;
        const bugsOpen = bugs.bugs.filter(b => b.status === 'open').length;
        const bugsFixed = bugs.bugs.filter(b => b.status === 'fixed').length;

        // B-abd8: process metrics summary
        const pm = sourceStore.readProcessMetrics(id);
        const metricsField = pm ? formatProcessMetricsSummary(pm, 'verbose') : null;

        // B-45ed CHK-008: bg:✓ 标记（仅在 background.md 存在时输出字段，不存在时省略字段不报错）
        const bgFlag = hasBackground(sourceStore, id) ? 'bg:✓' : null;

        // B-5fa4 CHK-002: append [zombie] / [terminal-worktree] labels
        const labels: string[] = [];
        if (zombieIds.has(id)) labels.push('[zombie]');
        if (residueIds.has(id)) labels.push('[terminal-worktree]');

        return {
          storyId: id,
          name: story.name || '',
          title: story.title,
          phase: story.phase,
          priority: story.priority,
          type: story.type,
          ...(mainPhase ? { mainPhase } : {}),
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
            `⚠ Terminal worktrees (${residues.length}): ${residues.map(r => r.storyId).join(', ')} — phase 已终态但 .worktrees/ 下仍有目录（可能仍 registered，也可能是 orphan）`,
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

    /**
     * story_reconcile — 检测并修复"僵尸" story
     *
     * 场景：分支已手动合并回 main 或被删除，但 story 状态文件仍停在非终态。
     * dryRun=true（默认）只报告，不修改；dryRun=false 执行修复。
     */
    story_reconcile(args?: { dryRun?: boolean }): string {
      const dryRun = args?.dryRun !== false; // 默认 dry run
      const zombies = detectZombieStories(store, ctx.root);
      const residues = scanTerminalStoryResidues(store, ctx.root);

      if (zombies.length === 0 && residues.length === 0) {
        return 'story_reconcile: 未检测到僵尸 story，所有非终态 story 的分支状态正常。';
      }

      const lines: string[] = [];
      lines.push(`检测到 ${zombies.length} 个僵尸 story（分支已合并/删除但 phase 非终态），${residues.length} 个终态 story residue：`);
      lines.push('');

      for (const z of zombies) {
        const reason = z.branchMerged
          ? `分支 ${z.branch} 已合并到 main`
          : `分支 ${z.branch} 已不存在`;
        lines.push(`  ${z.storyId}  phase=${z.phase}  ${reason}`);

        if (z.worktreeForeignPath && z.worktreePath) {
          lines.push(`    worktree: ${z.worktreePath} (foreign stale path)`);
        } else if (z.worktreeExists) {
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

      if (residues.length > 0) {
        lines.push('');
        lines.push('终态 story residue:');
        for (const residue of residues) {
          lines.push(`  ${residue.storyId} phase=${residue.phase} ${residue.safe ? 'safe-untracked' : 'unsafe-tracked/staged'} — ${residue.path}`);
          if (residue.status) {
            for (const line of residue.status.split('\n').slice(0, 4)) lines.push(`    ${line}`);
          }
          if (!dryRun && residue.safe) {
            rmSync(residue.path, { recursive: true, force: true });
            lines.push('    → 已清理 residue 目录');
          }
        }
      }

      if (dryRun) {
        lines.push('');
        lines.push('以上为 dry run 结果，未做任何修改。');
        lines.push('执行修复: koala story_reconcile \'{"dryRun":false}\'');
      }

      return lines.join('\n');
    },

    /**
     * @task B-e3a4
     * @checklist CHK-002
     * @title migrate story artifacts out of docs directory
     * @type feature
     * @priority high
     * @description
     *   Story artifacts and activity logs are Koala machine state, not human
     *   documentation. This command migrates legacy docs/story/actives data
     *   into the configured storyDir and legacy docs/story/activity.jsonl into
     *   .koala/activity.jsonl, backing up removed legacy files under .koala.
     * @changes
     *   - [CHK-002] Preview legacy-to-runtime story storage migration
     *   - [CHK-002] Copy legacy story directories to config.storyDir
     *   - [CHK-002] Move legacy docs/story/actives to .koala/legacy-backup on confirm
     *   - [B-281f/CHK-001] Merge legacy docs/story/activity.jsonl into .koala/activity.jsonl
     *   - [B-281f/CHK-002] Remove docs/story only when it becomes empty after migration
     * @test story-storage-migration
     */
    story_migrate_storage(args?: { dryRun?: boolean; confirm?: boolean }): string {
      const cfg = loadConfig(ctx.root);
      const legacyRel = 'docs/story/actives';
      const targetRel = cfg.storyDir.replace(/\\/g, '/');
      const legacyRoot = join(ctx.root, legacyRel);
      const targetRoot = join(ctx.root, targetRel);
      const legacyActivityRel = 'docs/story/activity.jsonl';
      const targetActivityRel = '.koala/activity.jsonl';
      const legacyActivityPath = getLegacyActivityLogPath(ctx.root);
      const targetActivityPath = getRuntimeActivityLogPath(ctx.root);
      const docsStoryRoot = join(ctx.root, 'docs', 'story');
      const lines: string[] = [];
      const legacyIds = listStoryDirs(legacyRoot);
      const targetIds = listStoryDirs(targetRoot);
      const toCopy = legacyIds.filter(id => !targetIds.includes(id));
      const storyDirMigrationEnabled = legacyRel !== targetRel;
      const hasLegacyActives = existsSync(legacyRoot);
      const hasLegacyActivity = existsSync(legacyActivityPath);
      const hasTargetActivity = existsSync(targetActivityPath);

      lines.push(`story_migrate_storage: ${legacyRel} -> ${targetRel}`);
      lines.push(`  legacy stories: ${legacyIds.length}`);
      lines.push(`  target stories : ${targetIds.length}`);
      lines.push(`  to copy        : ${storyDirMigrationEnabled ? toCopy.length : 0}`);
      lines.push(`  legacy activity: ${hasLegacyActivity ? legacyActivityRel : '(none)'}`);
      lines.push(`  target activity: ${hasTargetActivity ? `${targetActivityRel} (append)` : targetActivityRel}`);

      if (!storyDirMigrationEnabled) {
        lines.push('  story dir no-op: configured storyDir is still the legacy path');
      }
      if (!hasLegacyActives) {
        lines.push('  story dir no-op: legacy story directory does not exist');
      }
      if (!hasLegacyActives && !hasLegacyActivity) {
        lines.push('  no-op: no legacy story artifacts or activity log found');
        return lines.join('\n');
      }

      if (args?.dryRun !== false || !args?.confirm) {
        if (storyDirMigrationEnabled && toCopy.length > 0) lines.push(`  will copy: ${toCopy.slice(0, 12).join(', ')}${toCopy.length > 12 ? ` (+${toCopy.length - 12} more)` : ''}`);
        if (storyDirMigrationEnabled && hasLegacyActives) lines.push('  will backup legacy dir to .koala/legacy-backup/docs-story-actives-<timestamp>');
        if (hasLegacyActivity) {
          lines.push(`  will migrate activity: ${legacyActivityRel} -> ${targetActivityRel}${hasTargetActivity ? ' (append)' : ''}`);
          lines.push('  will backup legacy activity to .koala/legacy-backup/docs-story-activity-<timestamp>.jsonl');
        }
        lines.push('  will remove docs/story only if it is empty after migration');
        lines.push('→ 确认迁移: koala story_migrate_storage \'{"dryRun":false,"confirm":true}\'');
        return lines.join('\n');
      }

      const backupRoot = join(ctx.root, '.koala', 'legacy-backup');
      mkdirSync(backupRoot, { recursive: true });
      let copied = 0;
      let activesBackup: string | null = null;
      let activityBackup: string | null = null;
      let activityMigrated = false;

      if (storyDirMigrationEnabled && hasLegacyActives) {
        mkdirSync(targetRoot, { recursive: true });
        for (const id of toCopy) {
          cpSync(join(legacyRoot, id), join(targetRoot, id), { recursive: true, force: false });
          copied += 1;
        }
        activesBackup = join(backupRoot, `docs-story-actives-${Date.now()}`);
        renameSync(legacyRoot, activesBackup);
      }

      if (hasLegacyActivity) {
        const legacyActivity = readFileSync(legacyActivityPath, 'utf-8');
        const targetActivity = hasTargetActivity ? readFileSync(targetActivityPath, 'utf-8') : '';
        mkdirSync(join(ctx.root, '.koala'), { recursive: true });
        writeFileSync(targetActivityPath, appendJsonlContent(targetActivity, legacyActivity));
        activityBackup = join(backupRoot, `docs-story-activity-${Date.now()}.jsonl`);
        renameSync(legacyActivityPath, activityBackup);
        activityMigrated = true;
      }

      const removedDocsStory = removeEmptyDir(docsStoryRoot);

      lines.push(`  copied: ${copied}`);
      if (activesBackup) lines.push(`  backup actives: ${activesBackup}`);
      if (activityMigrated) lines.push(`  activity migrated: ${legacyActivityRel} -> ${targetActivityRel}`);
      if (activityBackup) lines.push(`  backup activity: ${activityBackup}`);
      lines.push(`  docs/story cleanup: ${removedDocsStory ? 'removed empty directory' : 'kept (missing or non-empty)'}`);
      lines.push('✓ story storage migrated');
      return lines.join('\n');
    },

    /**
     * @task B-2b38
     * @checklist CHK-001, CHK-002
     * @title safely sync story branch with main
     * @type feature
     * @priority high
     * @description
     *   Manual `git merge main` inside a story worktree can overwrite the
     *   story phase if users resolve `.koala/story/actives/<storyId>/index.json`
     *   with main's version. story_sync_main wraps that operation: current
     *   story metadata conflicts are resolved with `--ours`, while real code
     *   conflicts remain visible and block completion.
     * @changes
     *   - [CHK-001] Add dry-run/confirm guarded story_sync_main command
     *   - [CHK-002] Auto-resolve only current story metadata conflicts with --ours
     *   - [CHK-002] Leave non-story conflicts unresolved with explicit guidance
     * @test story-sync-main
     */
    story_sync_main(args: { storyId: string; dryRun?: boolean; confirm?: boolean }): string {
      const story = ctx.store.readStory(args.storyId);
      if (!story.worktree) {
        throw new Error(`Story ${args.storyId} 没有 worktree metadata，无法安全 sync main。请先检查 story 状态。`);
      }
      assertCwdInWorktree(ctx.store, args.storyId);

      const cwd = process.cwd();
      const cfg = loadConfig(ctx.root);
      const storyDirRel = cfg.storyDir.replace(/\\/g, '/');
      const storyMetaPrefix = `${storyDirRel}/${args.storyId}/`;
      const expectedBranch = story.worktree.branch || `story/${args.storyId}`;
      const currentBranch = gitOutput(cwd, 'rev-parse --abbrev-ref HEAD');
      const mainRef = 'main';
      const lines: string[] = [];

      if (currentBranch !== expectedBranch) {
        throw new Error(
          `Story ${args.storyId} 当前分支不匹配，拒绝 sync main。\n` +
          `期望: ${expectedBranch}\n当前: ${currentBranch}`,
        );
      }

      const currentHead = gitOutput(cwd, 'rev-parse --short HEAD');
      let mainHead = 'unknown';
      try { mainHead = gitOutput(cwd, `rev-parse --short ${mainRef}`); } catch { /* PROBE: main may not exist */ }
      const alreadyContainsMain = gitSucceeds(cwd, `merge-base --is-ancestor ${shellQuote(mainRef)} HEAD`);

      lines.push(`story_sync_main: ${args.storyId}`);
      lines.push(`  cwd: ${cwd}`);
      lines.push(`  branch: ${currentBranch}`);
      lines.push(`  current HEAD: ${currentHead}`);
      lines.push(`  main HEAD   : ${mainHead}`);
      lines.push(`  protect    : ${storyMetaPrefix}*`);

      if (args.dryRun === true || !args.confirm) {
        lines.push(alreadyContainsMain
          ? '  status     : story branch already contains main'
          : '  status     : confirm will run git merge main');
        lines.push('  metadata conflicts under the protected path will be resolved with --ours');
        lines.push('  source/other conflicts will remain unresolved and stop the command');
        lines.push(`→ 确认同步: koala story_sync_main '{"storyId":"${args.storyId}","confirm":true}'`);
        return lines.join('\n');
      }

      const dirty = gitPorcelainPaths(cwd).filter(path => !isVolatileRuntimeArtifactPath(path));
      if (dirty.length > 0) {
        throw new Error(`Cannot sync main: working tree has uncommitted changes:\n${dirty.slice(0, 20).join('\n')}`);
      }

      try {
        const out = gitOutput(cwd, `-c commit.gpgsign=false merge ${shellQuote(mainRef)} --no-ff -m ${shellQuote(`sync main into ${args.storyId}`)}`);
        lines.push(out || '✓ main already merged');
        lines.push(`✓ Story ${args.storyId} is synced with main`);
        lines.push(`→ 请重跑: koala test_story '{"storyId":"${args.storyId}"}'`);
        return lines.join('\n');
      } catch {
        const unmerged = gitUnmergedPaths(cwd);
        const protectedConflicts = unmerged.filter(path => path.startsWith(storyMetaPrefix));
        const unresolved = unmerged.filter(path => !path.startsWith(storyMetaPrefix));

        for (const path of protectedConflicts) {
          gitOutput(cwd, `checkout --ours -- ${shellQuote(path)}`);
          gitOutput(cwd, `add -- ${shellQuote(path)}`);
        }

        if (unresolved.length > 0) {
          throw new Error(
            `story_sync_main stopped: unresolved non-story conflicts remain.\n` +
            (protectedConflicts.length > 0
              ? `Story metadata conflicts auto-resolved with --ours:\n${protectedConflicts.map(path => `  - ${path}`).join('\n')}\n`
              : '') +
            `Unresolved conflicts:\n${unresolved.map(path => `  - ${path}`).join('\n')}\n\n` +
            `请手动解决上述真实冲突后 git add + git commit，再重跑 koala test_story '{"storyId":"${args.storyId}"}'。`,
          );
        }

        const staged = gitOutput(cwd, 'diff --cached --name-only');
        if (staged) {
          gitOutput(cwd, `-c commit.gpgsign=false commit -m ${shellQuote(`sync main into ${args.storyId} (story metadata ours)`)}`);
        }
        lines.push('Story metadata conflicts auto-resolved with --ours:');
        for (const path of protectedConflicts) lines.push(`  - ${path}`);
        lines.push(`✓ Story ${args.storyId} is synced with main`);
        lines.push(`→ 请重跑: koala test_story '{"storyId":"${args.storyId}"}'`);
        return lines.join('\n');
      }
    },
  };
}

function listStoryDirs(base: string): string[] {
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(base, entry.name, 'index.json')))
    .map(entry => entry.name)
    .sort();
}

function scanTerminalStoryResidues(store: StoryStore, root: string): StoryResidueInfo[] {
  const cfg = loadConfig(root);
  const base = join(root, cfg.storyDir);
  const residues: StoryResidueInfo[] = [];
  let ids: string[] = [];
  try { ids = store.listStoryIds(); } catch { return []; }
  for (const id of ids) {
    let story: StoryInfo;
    try { story = store.readStory(id); } catch { continue; }
    if (story.phase !== 'DONE' && story.phase !== 'DISCARDED') continue;
    const rel = `${cfg.storyDir.replace(/\\/g, '/')}/${id}`;
    let status = '';
    try {
      status = execSync(`git status --porcelain -uall -- ${JSON.stringify(rel)}`, {
        cwd: root,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch { continue; }
    if (!status) continue;
    const lines = status.split('\n').filter(Boolean);
    residues.push({
      storyId: id,
      phase: story.phase,
      path: join(base, id),
      safe: lines.length > 0 && lines.every(line => line.startsWith('?? ')),
      status,
    });
  }
  return residues;
}
