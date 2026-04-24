/**
 * koala session_brief — 跨 session 的开场简报
 *
 * 设计目的：
 *   新 Claude session 进来时不知道"上次停在哪、最近发生过什么"。
 *   之前要连续 koala story_list / story_get / checklist_get 才能拼凑出来。
 *   session_brief 是 single-shot 命令：跑一下就拿到完整上下文 + 应该做的事。
 *
 *   CLAUDE.md 要求每个新 session 第一件事跑这个命令。
 *
 * 输出包括：
 *   - active story 摘要 (id/phase/title)
 *   - checklist 状态 (N done / M in_progress / K pending，列出 in_progress)
 *   - 最后一次 test 结果（来自 test-evidence.json）
 *   - bug 状态（open/fixed 计数）
 *   - 最近 N 条 activity（来自 activity.jsonl）
 *   - git status 摘要
 *   - computeNextStep 推断的"现在应该做什么"
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import type { StoryInfo, ChecklistData, BugData } from '../core/types.js';
import { formatProcessMetricsSummary } from '../core/process-metrics.js';
import { readActivityLogTail } from '../core/activity-log.js';
import { summarizeReviewerStatus } from '../core/reviewer-status.js';
import { reviewAntiStall, testAntiStall } from '../core/anti-stall.js';
import { isGitRepository } from '../core/git-probe.js';

interface ActiveStoryDetected {
  storyId: string;
  story: StoryInfo;
}

function detectActiveStoryFromGit(ctx: HandlerContext): ActiveStoryDetected | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: ctx.root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!branch.startsWith('story/')) return null;
    const storyId = branch.slice('story/'.length);
    if (!storyId) return null;
    try {
      const story = ctx.store.readStory(storyId);
      return { storyId, story };
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function readActivityTail(root: string, lines: number): Array<{
  timestamp: string;
  tool: string;
  status: string;
  storyId: string | null;
}> {
  try {
    // readActivityLogTail returns newest-first; reverse to match old
    // chronological order expected by callers that .reverse() for display.
    const entries = readActivityLogTail(root, lines).reverse();
    return entries.map(r => ({
      timestamp: String(r.startTime || r.endTime || ''),
      tool: String(r.tool || r.detail || '?'),
      status: String(r.status || '?'),
      storyId: (r.storyId as string) || null,
    }));
  } catch {
    return [];
  }
}

function readGitStatus(root: string): { porcelain: string[]; recentLog: string[] } {
  const porcelain: string[] = [];
  const recentLog: string[] = [];
  try {
    const status = execSync('git status --porcelain', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (status) porcelain.push(...status.split('\n').slice(0, 20));
  } catch { /* not a git repo */ }
  try {
    const log = execSync('git log -3 --oneline', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (log) recentLog.push(...log.split('\n'));
  } catch { /* no commits */ }
  return { porcelain, recentLog };
}

/**
 * B-89c7 CHK-016: map of storyId → worktree path, derived from
 * `git worktree list --porcelain`. Used by main-branch brief to show
 * which in-flight stories already have a worktree (so agents can cd
 * directly into them instead of story_advance-ing blindly).
 */
function listActiveWorktrees(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = execSync('git worktree list --porcelain', {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let currentPath = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        const branch = line.slice('branch '.length).trim();
        // refs/heads/story/B-xxx → B-xxx
        const m = branch.match(/refs\/heads\/story\/(.+)$/);
        if (m && currentPath) {
          out[m[1]] = currentPath;
        }
      }
    }
  } catch { /* not a git repo or git worktree unsupported — PROBE, return empty */ }
  return out;
}

/**
 * B-89c7 CHK-013 / CHK-016: tail of tmp/router-log.jsonl as a short
 * Recent-chats summary. Parses the last N entries and extracts
 * model / timing / cache hit rate / tool names. Never throws — if the
 * file doesn't exist yet, or any line fails to parse, the offending
 * record is skipped.
 *
 * cached=0 on a supported provider triggers a ⚠ marker so agents see
 * the B-73e2 CHK-004 byte-stable prompt cache regression signal the
 * next time they open a session.
 */
interface RouterLogSummary {
  model: string;
  totalMs: number;
  beforeMs?: number;
  streamMs?: number;
  afterMs?: number;
  cachedInputTokens?: number;
  promptTokens?: number;
  toolNames: string[];
  cacheWarning: boolean; // true iff cached==0 && provider supports cache
}
function readRouterLogTail(root: string, n: number): RouterLogSummary[] {
  const logPath = join(root, 'tmp', 'router-log.jsonl');
  if (!existsSync(logPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf-8');
  } catch { return []; }
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const tail = lines.slice(-n);
  const out: RouterLogSummary[] = [];
  for (const line of tail) {
    try {
      const entry = JSON.parse(line);
      const run = entry.actualRun;
      if (!run || typeof run !== 'object' || run === 'abandoned') continue;
      const cached = typeof run.cachedInputTokensTotal === 'number' ? run.cachedInputTokensTotal : undefined;
      const prompt = typeof run.promptTokens === 'number' ? run.promptTokens : undefined;
      out.push({
        model: (run.steps?.[0]?.model as string) || entry.routeDecision?.model || 'unknown',
        totalMs: typeof run.chatMs === 'number' ? run.chatMs : 0,
        beforeMs: typeof run.beforeMs === 'number' ? run.beforeMs : undefined,
        streamMs: typeof run.streamMs === 'number' ? run.streamMs : undefined,
        afterMs: typeof run.afterMs === 'number' ? run.afterMs : undefined,
        cachedInputTokens: cached,
        promptTokens: prompt,
        toolNames: Array.isArray(run.steps)
          ? Array.from(new Set(
              (run.steps as Array<{ toolNames?: string[] }>)
                .flatMap(s => Array.isArray(s.toolNames) ? s.toolNames : []),
            ))
          : [],
        // cached=0 is the red-line signal; cached=undefined means the
        // provider doesn't report cache at all (no warning).
        cacheWarning: cached === 0 && (prompt ?? 0) > 0,
      });
    } catch { /* skip malformed */ }
  }
  return out;
}

/** Render router-log tail as a brief Recent-chats section. Returns lines
 *  array (empty if tail is empty). Used by both active and no-active
 *  branches of session_brief. */
function renderRouterLogTail(tail: RouterLogSummary[]): string[] {
  if (tail.length === 0) return [];
  const lines: string[] = [];
  lines.push('');
  lines.push(`## Recent chats (last ${tail.length})`);
  for (const r of tail) {
    const totalStr = r.totalMs >= 1000 ? `${(r.totalMs / 1000).toFixed(1)}s` : `${r.totalMs}ms`;
    const timingParts: string[] = [];
    if (r.beforeMs !== undefined) timingParts.push(`before ${r.beforeMs}ms`);
    if (r.streamMs !== undefined) timingParts.push(`stream ${r.streamMs >= 1000 ? (r.streamMs / 1000).toFixed(1) + 's' : r.streamMs + 'ms'}`);
    if (r.afterMs !== undefined) timingParts.push(`after ${r.afterMs}ms`);
    const timingStr = timingParts.length > 0 ? ` (${timingParts.join('/')})` : '';
    let cacheStr = '';
    if (r.cachedInputTokens === undefined) {
      cacheStr = ' cached:n/a';
    } else if (r.promptTokens && r.promptTokens > 0) {
      const pct = Math.round((r.cachedInputTokens / r.promptTokens) * 100);
      cacheStr = ` cached:${pct}%${r.cacheWarning ? ' \u26A0' : ''}`;
    }
    const toolsStr = r.toolNames.length > 0
      ? ` tools:[${r.toolNames.slice(0, 3).join(',')}${r.toolNames.length > 3 ? '+' + (r.toolNames.length - 3) : ''}]`
      : ' tools:notool';
    lines.push(`  ${r.model} ${totalStr}${timingStr}${cacheStr}${toolsStr}`);
  }
  return lines;
}

interface ChecklistSummary {
  total: number;
  done: number;
  inProgress: Array<{ id: string; title: string }>;
  pending: Array<{ id: string; title: string }>;
}

function summarizeChecklist(cl: ChecklistData | null): ChecklistSummary | null {
  if (!cl || !Array.isArray(cl.items)) return null;
  const summary: ChecklistSummary = { total: cl.items.length, done: 0, inProgress: [], pending: [] };
  for (const it of cl.items) {
    if (it.status === 'done') summary.done++;
    else if (it.status === 'in_progress') summary.inProgress.push({ id: it.id, title: it.title });
    else summary.pending.push({ id: it.id, title: it.title });
  }
  return summary;
}

interface NextStepCtx {
  storyId: string;
  phase: string;
  checklist: ChecklistSummary | null;
  hasUnderstanding: boolean;
  hasDecision: boolean;
  bugs: BugData | null;
  hasTestEvidence: boolean;
  testPassedAt: string | null;
  gitReady: boolean;
}

function computeNextStep(c: NextStepCtx): string {
  const sid = c.storyId;
  const openBugs = c.bugs?.bugs.filter(b => b.status === 'open') ?? [];

  switch (c.phase) {
    case 'IDEA':
      return `Story 在 IDEA 阶段，没有 checklist。和用户讨论 checklist 后用 checklist_add 追加，或重新 story_create 时带上 checklist 字段`;
    case 'INIT':
      if (!c.gitReady) {
        return `Story 在 INIT 阶段，但当前项目不是 git 仓库。可以继续记录 metadata；若要进入 INIT_CHECK/worktree 流程，先 git init && git add . && git commit -m "init"`;
      }
      return `Story 在 INIT 阶段。下一步：story_advance --storyId=${sid} --phase=INIT_CHECK 创建 worktree，然后 cd 进去`;
    case 'INIT_CHECK':
      if (!c.gitReady) {
        return `Story 在 INIT_CHECK 前置阶段，但当前项目不是 git 仓库。先 git init + 首次 commit，再继续 worktree / PLAN 流程`;
      }
      return `Story 在 INIT_CHECK，worktree 已创建。下一步：cd 到 .worktrees/${sid}/ 然后 story_advance --phase=PLAN`;
    case 'PLAN': {
      if (!c.hasUnderstanding) {
        return `PLAN 阶段缺 understanding。下一步：understanding_set 落 task/outcome/facts/constraints/unknowns/touchpoints 快照`;
      }
      if (!c.hasDecision) {
        return `PLAN 阶段已有 understanding，缺 decision。下一步：decision_set 落 RALPLAN-DR 决策（principles/drivers/options/chosen/rationale/preMortem）`;
      }
      return `PLAN 阶段。下一步：story_review --storyId=${sid} 跑对抗审查，issueCount=0 后 story_advance --phase=DEV`;
    }
    case 'DEV': {
      if (!c.checklist) return `DEV 阶段。先 checklist_get --storyId=${sid} 看待办`;
      if (c.checklist.inProgress.length > 0) {
        const ip = c.checklist.inProgress[0];
        return `DEV 阶段。继续完成 in_progress item: ${ip.id} ${ip.title}（完成后 checklist_update --status=done）`;
      }
      if (c.checklist.pending.length > 0) {
        const next = c.checklist.pending[0];
        return `DEV 阶段。下一项：checklist_update --storyId=${sid} --itemId=${next.id} --status=in_progress（${next.title}）`;
      }
      return `DEV 阶段，所有 checklist 已 done。下一步：git commit + story_advance --storyId=${sid} --phase=TEST 进入验证`;
    }
    case 'REVIEW':
      return `REVIEW 阶段。koala-reviewer 审查代码，提 finding。critical/high finding 全部 resolved 后 story_advance --storyId=${sid} --phase=TEST`;
    case 'TEST_CASE':
      return `TEST_CASE 阶段（legacy）。建议 story_advance --phase=TEST 直接进入验证`;
    case 'TEST_CASE_REVIEW':
      return `TEST_CASE_REVIEW 阶段（legacy）。建议 story_advance --phase=TEST 直接进入验证`;
    case 'TEST':
      if (openBugs.length > 0) {
        return `TEST 阶段，有 ${openBugs.length} 个 open bug：${openBugs.slice(0, 3).map(b => b.id).join(', ')}。修复后跑 koala validate 验证`;
      }
      if (!c.hasTestEvidence) {
        return `TEST 阶段。下一步：koala validate 跑验证，写 bug/evidence`;
      }
      return `TEST 阶段，所有 bug 已 fixed。下一步：story_advance --storyId=${sid} --phase=DONE 完成 story（会自动合并回 main）`;
    case 'DONE':
      return `Story 已 DONE。可以开始下一个 story`;
    default:
      return `未知 phase: ${c.phase}`;
  }
}

function formatTimeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const ms = Date.now() - t;
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/** B-89c7 CHK-008: session_brief input schema.
 *  concise=true → output < ~4KB, only critical fields. Used by the
 *  Claude Code SessionStart hook where head-of-context pollution must
 *  be minimized. Full mode (default) keeps everything that helps
 *  operators when they run the command manually. */
interface SessionBriefArgs {
  concise?: boolean;
}

export function createSessionHandlers(ctx: HandlerContext) {
  return {
    session_brief(args: SessionBriefArgs = {}): string {
      const concise = args.concise === true;
      const lines: string[] = [];
      const gitReady = isGitRepository(ctx.root);
      lines.push('# koala session brief');
      lines.push('');

      const detected = detectActiveStoryFromGit(ctx);

      if (!detected) {
        // ── No active story branch (B-89c7 CHK-016 main-branch enrichment) ──
        // Pull dashboard + active stories + cross-story open bugs + recent
        // router-log so agents landing in main still get real situational
        // awareness, not just "N stories total".
        const allStoryIds = (() => {
          try { return ctx.store.listStoryIds(); } catch { return []; }
        })();

        if (allStoryIds.length === 0) {
          lines.push('**No active story** — no stories yet.');
          lines.push('');
          lines.push('Start with `koala story_create` to create your first story.');
          if (!gitReady) {
            lines.push('');
            lines.push('⚠ Non-git project: Koala can still record story/test metadata here, but INIT_CHECK/worktree phases need `git init` + an initial commit first.');
          }
          const gitNew = readGitStatus(ctx.root);
          if (gitNew.recentLog.length > 0) {
            lines.push('');
            lines.push('Recent commits:');
            for (const l of gitNew.recentLog) lines.push(`  ${l}`);
          }
          return lines.join('\n');
        }

        // Dashboard: reuse story_list handler output's _dashboard field.
        // We call the same handler via ctx-level helpers so the exact
        // same numbers show up in brief and in `koala story_list`.
        let dashboardText: string | null = null;
        let activeStories: Array<{ storyId: string; phase: string; title: string; bugsOpen: number; hasBg: boolean }> = [];
        let totalBugsOpen = 0;
        let totalStories = allStoryIds.length;
        let doneStories = 0;
        try {
          const phases: Record<string, number> = {};
          for (const id of allStoryIds) {
            try {
              const s = ctx.store.readStory(id);
              phases[s.phase] = (phases[s.phase] || 0) + 1;
              if (s.phase === 'DONE') doneStories++;
              // Non-terminal = active
              if (
                s.phase !== 'DONE' &&
                s.phase !== 'DISCARDED' &&
                s.phase !== 'IDEA'
              ) {
                let bugsOpen = 0;
                try {
                  const bd = ctx.store.readBugs(id);
                  bugsOpen = bd.bugs.filter(b => b.status === 'open').length;
                } catch { /* no bugs file */ }
                // B-45ed CHK-008: 每个 active story 检测 background.md 存在性 → bg:✓ 标记
                const hasBg = existsSync(join(ctx.root, 'docs', 'story', 'actives', id, 'background.md'));
                activeStories.push({
                  storyId: id,
                  phase: s.phase,
                  title: s.title || '',
                  bugsOpen,
                  hasBg,
                });
              }
            } catch { /* skip unreadable */ }
          }
          // Cross-story open bug tally across ALL stories, not just active.
          for (const id of allStoryIds) {
            try {
              const bd = ctx.store.readBugs(id);
              totalBugsOpen += bd.bugs.filter(b => b.status === 'open').length;
            } catch { /* probe */ }
          }
          const donePct = totalStories > 0 ? Math.round((doneStories / totalStories) * 100) : 0;
          dashboardText = `${doneStories}/${totalStories} DONE (${donePct}%) · ${totalBugsOpen} open bugs across all stories`;
        } catch { /* defensive: leave dashboardText null */ }

        if (dashboardText) {
          lines.push(`**Dashboard**: ${dashboardText}`);
        } else {
          lines.push(`**${totalStories} stories total**`);
        }

        // Active stories + worktree paths.
        const worktrees = listActiveWorktrees(ctx.root);
        if (activeStories.length > 0) {
          lines.push('');
          lines.push(`## Active stories (${activeStories.length})`);
          const limit = concise ? 3 : activeStories.length;
          for (const s of activeStories.slice(0, limit)) {
            const wt = worktrees[s.storyId];
            const bugStr = s.bugsOpen > 0 ? ` [${s.bugsOpen} bugs]` : '';
            // B-45ed CHK-008: bg:✓ 尾部标记；不存在 background.md 时不显示
            const bgStr = s.hasBg ? ' bg:✓' : '';
            if (wt) {
              lines.push(`  ${s.storyId} ${s.phase.padEnd(16)} ${s.title}${bugStr}${bgStr}`);
              lines.push(`    → cd ${wt}`);
            } else {
              lines.push(`  ${s.storyId} ${s.phase.padEnd(16)} ${s.title}${bugStr}${bgStr}`);
            }
          }
          if (activeStories.length > limit) {
            lines.push(`  ... ${activeStories.length - limit} more`);
          }
        }

        // Cross-story open bugs sample (concise mode skips this).
        if (!concise && totalBugsOpen > 0) {
          const bugSample: Array<{ storyId: string; id: string; title: string }> = [];
          for (const id of allStoryIds) {
            if (bugSample.length >= 5) break;
            try {
              const bd = ctx.store.readBugs(id);
              for (const b of bd.bugs) {
                if (b.status === 'open' && bugSample.length < 5) {
                  bugSample.push({ storyId: id, id: b.id, title: b.title });
                }
              }
            } catch { /* probe */ }
          }
          if (bugSample.length > 0) {
            lines.push('');
            lines.push(`## Open bugs (${bugSample.length} of ${totalBugsOpen})`);
            for (const b of bugSample) {
              lines.push(`  - ${b.storyId} ${b.id} ${b.title}`);
            }
          }
        }

        // Git recent commits + porcelain (brief).
        const gitMain = readGitStatus(ctx.root);
        if (!concise && gitMain.recentLog.length > 0) {
          lines.push('');
          lines.push('## Recent commits');
          for (const l of gitMain.recentLog) lines.push(`  ${l}`);
        }
        if (gitMain.porcelain.length > 0) {
          lines.push('');
          lines.push(`Working tree dirty (${gitMain.porcelain.length} files).`);
        }
        if (!gitReady) {
          lines.push('');
          lines.push('⚠ Non-git project: story metadata can be recorded here, but branch/worktree phases need `git init` + an initial commit first.');
        }

        // B-89c7 CHK-013: Recent router-log tail with cache warning.
        const routerTail = readRouterLogTail(ctx.root, 3);
        for (const l of renderRouterLogTail(routerTail)) lines.push(l);

        // Next step suggestion for main branch.
        lines.push('');
        lines.push('## → Next step');
        if (activeStories.length > 0) {
          const top = activeStories[0];
          const wt = worktrees[top.storyId];
          if (!gitReady) {
            lines.push(`  Project is not a git repo. You can keep recording story/test metadata, but before INIT_CHECK/worktree flow run: \`git init && git add . && git commit -m "init"\``);
          } else if (wt) {
            lines.push(`  Resume: cd ${wt} (story ${top.storyId} is in ${top.phase})`);
          } else {
            lines.push(`  Story ${top.storyId} is in ${top.phase} but has no worktree. Try \`koala story_advance --storyId=${top.storyId} --phase=INIT_CHECK\` to create one.`);
          }
        } else if (doneStories === totalStories) {
          lines.push('  All stories DONE. Archive old stories or `koala story_create` for new work.');
        } else {
          lines.push('  No active story. `koala story_create` to start one, or `koala story_list` to see all.');
        }

        return lines.join('\n');
      }

      // ── Active story branch ────────────────────────────────────────
      // B-89c7 CHK-017: pruned of decorative fields (Type/Priority/Started,
      // full pending list, JSON.stringify summary, long activity tail).
      // Reads only answer "what's happening now + what should I do next".
      const { storyId, story } = detected;
      lines.push(`**Story**: ${storyId} — ${story.title}`);
      lines.push(`**Phase**: ${story.phase}`);

      // Checklist (kept: done/total + in_progress list).
      let checklistSummary: ChecklistSummary | null = null;
      try {
        const cl = ctx.store.readChecklist(storyId);
        checklistSummary = summarizeChecklist(cl);
      } catch { /* no checklist */ }

      if (checklistSummary) {
        lines.push('');
        lines.push(`## Checklist (${checklistSummary.done}/${checklistSummary.total} done)`);
        if (checklistSummary.inProgress.length > 0) {
          lines.push(`  in_progress (${checklistSummary.inProgress.length}):`);
          for (const it of checklistSummary.inProgress.slice(0, 5)) {
            lines.push(`    - ${it.id} ${it.title}`);
          }
        }
        // B-89c7 CHK-017: show ONLY the first pending item as "next up"
        // hint, not the full list — next step suggestion already names it.
        if (checklistSummary.pending.length > 0 && !concise) {
          const next = checklistSummary.pending[0];
          lines.push(`  next pending: ${next.id} ${next.title} (+${checklistSummary.pending.length - 1} more)`);
        }
      }

      // B-5fa4 CHK-001: reviewer-status integration for REVIEW phase
      if (story.phase === 'REVIEW') {
        try {
          const rs = summarizeReviewerStatus(ctx.store, storyId);
          lines.push('');
          lines.push(`## Reviewer status (${rs.allPassed ? 'all passed' : `${rs.totalBlockers} blockers`})`);
          for (const entry of rs.entries) {
            const marker = entry.verdict === 'pass' ? 'PASS' : (entry.verdict === 'fail' ? 'FAIL' : 'pending');
            lines.push(`  [${marker}] ${entry.name}${entry.blockerCount > 0 ? ` (${entry.blockerCount} blockers)` : ''}`);
          }
        } catch { /* probe: reviewer status unavailable */ }
      }

      // Understanding / Decision — probe only in PLAN phase (B-89c7 CHK-017
      // lazy I/O). Elsewhere these fields are never rendered so the file
      // read is wasted.
      let hasUnderstanding = false;
      let hasDecision = false;
      if (story.phase === 'PLAN') {
        try {
          const u = (ctx.store as { readUnderstanding?: (id: string) => { task?: string } }).readUnderstanding?.(storyId);
          hasUnderstanding = !!u && !!u.task;
        } catch { /* probe */ }
        try {
          const d = (ctx.store as { readDecision?: (id: string) => { options?: unknown[] } }).readDecision?.(storyId);
          hasDecision = !!d && Array.isArray(d.options) && d.options.length > 0;
        } catch { /* probe */ }
      }

      // Bugs (kept: open count + first 5 open).
      let bugs: BugData | null = null;
      try {
        bugs = ctx.store.readBugs(storyId);
        if (bugs && bugs.bugs.length > 0) {
          const open = bugs.bugs.filter(b => b.status === 'open');
          const fixed = bugs.bugs.filter(b => b.status === 'fixed');
          if (open.length > 0 || fixed.length > 0) {
            lines.push('');
            lines.push(`## Bugs: ${open.length} open, ${fixed.length} fixed`);
            for (const b of open.slice(0, 5)) {
              lines.push(`  - [open] ${b.id} ${b.title}${b.fixtureId ? ` (fixtureId=${b.fixtureId})` : ''}`);
            }
          }
        }
      } catch { /* none */ }

      // Anti-stall hints for REVIEW/TEST (helps weaker agents like Codex)
      if (story.phase === 'REVIEW' || story.phase === 'TEST') {
        const openBugIds = bugs?.bugs.filter(b => b.status === 'open').map(b => b.id) ?? [];
        const stall = story.phase === 'REVIEW'
          ? reviewAntiStall(storyId)
          : testAntiStall(storyId, openBugIds.length > 0 ? openBugIds : undefined);
        lines.push('');
        lines.push(`## Anti-stall (${story.phase})`);
        for (const line of stall.split('\n')) {
          lines.push(`  ${line}`);
        }
      }

      // Test evidence (kept: timestamp + structured summary, not JSON dump).
      let hasTestEvidence = false;
      let testPassedAt: string | null = null;
      try {
        const ev = ctx.store.readTestEvidence(storyId);
        if (ev) {
          hasTestEvidence = true;
          const evAny = ev as { timestamp?: string; runAt?: string; summary?: { passed?: number; failed?: number; skipped?: number; total?: number } };
          testPassedAt = evAny.timestamp || evAny.runAt || null;
          lines.push('');
          lines.push(`## Last test run`);
          if (testPassedAt) lines.push(`  at: ${testPassedAt} (${formatTimeAgo(testPassedAt)})`);
          if (evAny.summary && typeof evAny.summary === 'object') {
            const s = evAny.summary;
            const parts: string[] = [];
            if (typeof s.passed === 'number') parts.push(`passed: ${s.passed}`);
            if (typeof s.failed === 'number') parts.push(`failed: ${s.failed}`);
            if (typeof s.skipped === 'number') parts.push(`skipped: ${s.skipped}`);
            if (parts.length > 0) lines.push(`  ${parts.join(', ')}`);
          }
        }
      } catch { /* none */ }

      // DONE pre-check list for TEST phase stories
      if (story.phase === 'TEST') {
        const gitPre = readGitStatus(ctx.root);
        const openBugs = bugs?.bugs.filter(b => b.status === 'open') ?? [];
        let branchSynced = 'unknown';
        try {
          execSync(`git merge-base --is-ancestor main HEAD`, {
            cwd: ctx.root,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          branchSynced = 'yes';
        } catch {
          branchSynced = 'no';
        }
        let evalPresent = false;
        try {
          evalPresent = ctx.store.readEvalEvidence(storyId) !== null;
        } catch { /* probe */ }
        let summaryPresent = false;
        try {
          summaryPresent = ctx.store.readSummary(storyId) !== null;
        } catch { /* probe */ }

        lines.push('');
        lines.push('## DONE pre-check');
        lines.push(`  test evidence: ${hasTestEvidence ? 'PASS' : 'missing'}`);
        lines.push(`  bugs: ${openBugs.length === 0 ? 'all fixed' : `${openBugs.length} open`}`);
        lines.push(`  git working tree: ${gitPre.porcelain.length === 0 ? 'clean' : 'dirty'}`);
        lines.push(`  branch synced with main: ${branchSynced}`);
        lines.push(`  eval evidence: ${evalPresent ? 'present' : 'missing'}`);
        lines.push(`  summary: ${summaryPresent ? 'present' : 'missing'}`);
      }

      // B-abd8: process metrics in session brief
      const pm = ctx.store.readProcessMetrics(storyId);
      if (pm) {
        lines.push('');
        lines.push(`## Process metrics`);
        lines.push(`  ${formatProcessMetricsSummary(pm, 'compact')}`);
        if (pm.overallGaps.length > 0) {
          lines.push(`  gaps: ${pm.overallGaps.slice(0, 3).join('; ')}${pm.overallGaps.length > 3 ? ` (+${pm.overallGaps.length - 3} more)` : ''}`);
        }
      }

      // Activity tail — CHK-017 shrunk from 8 to 3 in full mode; skipped
      // entirely in concise mode (git log covers most of what it shows).
      if (!concise) {
        const activity = readActivityTail(ctx.root, 3);
        if (activity.length > 0) {
          lines.push('');
          lines.push(`## Recent activity (last ${activity.length})`);
          for (const a of activity.slice().reverse()) {
            lines.push(`  ${a.timestamp} ${a.tool} [${a.status}]`);
          }
        }
      }

      // Git status (kept full — compact and high signal).
      const git = readGitStatus(ctx.root);
      if (!concise && (git.porcelain.length > 0 || git.recentLog.length > 0)) {
        lines.push('');
        lines.push('## Git');
        if (git.recentLog.length > 0) {
          lines.push('  recent commits:');
          for (const l of git.recentLog) lines.push(`    ${l}`);
        }
        if (git.porcelain.length > 0) {
          lines.push(`  uncommitted (${git.porcelain.length}):`);
          for (const f of git.porcelain.slice(0, 8)) lines.push(`    ${f}`);
        }
      } else if (concise && git.porcelain.length > 0) {
        // Concise: just the dirty flag, not the file list.
        lines.push('');
        lines.push(`Working tree dirty (${git.porcelain.length} files).`);
      }

      // B-89c7 CHK-013: Recent router-log tail for active story too — most
      // relevant when the agent wants to know "did the last chat hit
      // cache" or "was the last turn slow".
      const routerTail = readRouterLogTail(ctx.root, concise ? 2 : 3);
      for (const l of renderRouterLogTail(routerTail)) lines.push(l);

      // Next step (kept — most important field).
      const nextStep = computeNextStep({
        storyId,
        phase: story.phase,
        checklist: checklistSummary,
        hasUnderstanding,
        hasDecision,
        bugs,
        hasTestEvidence,
        testPassedAt,
        gitReady,
      });

      lines.push('');
      lines.push('## → Next step');
      lines.push(`  ${nextStep}`);

      return lines.join('\n');
    },
  };
}
