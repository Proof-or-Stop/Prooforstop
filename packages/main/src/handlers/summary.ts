/**
 * @task B-093b
 * @checklist CHK-001
 * @title Story summary (DONE-gate forced completion summary)
 * @type feature
 * @priority high
 * @description
 *   Before advancing to DONE, the agent must call `summary_set` with:
 *     - changes       — what changed, user-facing
 *     - usage         — how to use it (slash command / tool / example)
 *     - limitations   — known limits / design divergences
 *     - pitfalls      — war stories, what future agents should know
 * @changes
 *   - Enforce explicit completion summaries before DONE.
 *   - Keep generated summary metrics derived from story data.
 */

import type { HandlerContext } from './context.js';
import type { StorySummaryData, StoryInfo, BugData, StoryTestRunsData } from '../core/types.js';
import { computeProcessMetrics, formatProcessMetricsSummary } from '../core/process-metrics.js';

/**
 * B-1522: Compute per-phase visit count + accumulated duration from story.events.
 * Logic: sort events by timestamp; each advance event = "enter phase newState";
 * the time between consecutive events is the prev phase's duration segment.
 * The current phase (tail) counts from its enter-time to `endedAt` or `now`.
 */
function computePhaseStats(story: StoryInfo): {
  phaseStats: Record<string, { count: number; durationMs: number }>;
  totalDurationMs: number;
} {
  const phaseStats: Record<string, { count: number; durationMs: number }> = {};
  const events = (story.events || []).filter(e => e.action === 'advance' || e.action === 'create');
  if (events.length === 0) {
    return { phaseStats, totalDurationMs: 0 };
  }
  // Sort by timestamp to defend against out-of-order writes
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const endStamp = story.endedAt || new Date().toISOString();

  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    const phase = ev.phase;
    const startMs = Date.parse(ev.timestamp);
    const nextMs = i + 1 < sorted.length
      ? Date.parse(sorted[i + 1].timestamp)
      : Date.parse(endStamp);
    if (Number.isNaN(startMs) || Number.isNaN(nextMs)) continue;
    const dur = Math.max(0, nextMs - startMs);

    if (!phaseStats[phase]) phaseStats[phase] = { count: 0, durationMs: 0 };
    phaseStats[phase].count += 1;
    phaseStats[phase].durationMs += dur;
  }

  const startIso = story.startedAt || story.createdAt;
  const totalDurationMs = Math.max(
    0,
    Date.parse(endStamp) - Date.parse(startIso || sorted[0].timestamp)
  );
  return { phaseStats, totalDurationMs: Number.isNaN(totalDurationMs) ? 0 : totalDurationMs };
}

/** B-1522: Aggregate test-runs.json into a compact summary. */
function computeFixtureStats(runs: StoryTestRunsData): StorySummaryData['fixtureStats'] {
  const list = runs.runs || [];
  if (list.length === 0) {
    return { totalRuns: 0, totalCases: 0, cumulativeCasesRun: 0, cumulativePassedCases: 0 };
  }
  const last = list[list.length - 1];
  let cumulativeCasesRun = 0;
  let cumulativePassedCases = 0;
  for (const r of list) {
    cumulativeCasesRun += r.totalCases || 0;
    cumulativePassedCases += r.passedCases || 0;
  }
  return {
    totalRuns: list.length,
    totalCases: last.totalCases || 0,
    cumulativeCasesRun,
    cumulativePassedCases,
  };
}

/** B-1522: bug.json → {found, fixed, open}. */
function computeBugStats(bugData: BugData): StorySummaryData['bugStats'] {
  const list = bugData.bugs || [];
  const fixed = list.filter(b => b.status === 'fixed').length;
  const open = list.filter(b => b.status === 'open').length;
  return { found: list.length, fixed, open };
}

/** Format ms duration as "Xh Ym Zs" / "Xm Ys" / "Zs" */
function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m ${rs}s`;
}


export function createSummaryHandlers(ctx: HandlerContext) {
  const { store, root } = ctx;

  return {
    /**
     * Write summary.json. The `realMachineCoverage` field is computed here,
     * not accepted from the caller.
     *
     * Args:
     *   storyId      — required
     *   changes      — required non-empty
     *   usage        — required non-empty
     *   limitations  — required (can be "none" but must be explicit)
     *   pitfalls     — required non-empty (encourage war-story discipline)
     */
    summary_set(args: {
      storyId: string;
      changes: string;
      usage: string;
      limitations: string;
      pitfalls: string;
    }): string {
      const story = store.readStory(args.storyId); // validate exists
      void story;

      if (!args.changes || args.changes.trim().length < 10) {
        throw new Error('summary.changes 必须非空且 ≥ 10 字符（描述改了什么文件的关键改动）');
      }
      if (!args.usage || args.usage.trim().length < 10) {
        throw new Error('summary.usage 必须非空且 ≥ 10 字符（描述如何使用新功能 — slash / tool / 示例）');
      }
      if (typeof args.limitations !== 'string' || args.limitations.trim().length < 2) {
        throw new Error('summary.limitations 必须非空（没有限制就写 "none — fully covered"）');
      }
      if (!args.pitfalls || args.pitfalls.trim().length < 10) {
        throw new Error('summary.pitfalls 必须非空且 ≥ 10 字符（这是强制段：做这个 story 的时候卡在哪、绕了几次路、下个人应该知道什么 — 禁止空话）');
      }

      // B-1522: compute auto-stats from story.events / test-runs.json / bug.json
      const storyForStats = store.readStory(args.storyId);
      const { phaseStats, totalDurationMs } = computePhaseStats(storyForStats);
      const fixtureStats = computeFixtureStats(store.readTestRuns(args.storyId));
      const bugStats = computeBugStats(store.readBugs(args.storyId));

      const existing = store.readSummary(args.storyId);
      const now = new Date().toISOString();
      const data: StorySummaryData = {
        storyId: args.storyId,
        changes: args.changes,
        usage: args.usage,
        realMachineCoverage: { ran: [], skipped: [] },
        limitations: args.limitations,
        pitfalls: args.pitfalls,
        phaseStats,
        totalDurationMs,
        fixtureStats,
        bugStats,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      store.writeSummary(args.storyId, data);

      // B-abd8: auto-recompute process metrics
      let metricsLine = '';
      try {
        const pm = computeProcessMetrics(args.storyId, store, root);
        store.writeProcessMetrics(args.storyId, pm);
        metricsLine = `\nProcess: ${formatProcessMetricsSummary(pm)}`;
      } catch (e) {
        console.warn(`[process-metrics] recompute failed for ${args.storyId}:`, (e as Error).message);
      }

      const lines = [
        `Summary saved for ${args.storyId}`,
        `  changes:     ${args.changes.length} chars`,
        `  usage:       ${args.usage.length} chars`,
        `  limitations: ${args.limitations.length} chars`,
        `  pitfalls:    ${args.pitfalls.length} chars`,
        `  total time:  ${formatDuration(totalDurationMs)}`,
        `  fixtures:    ${fixtureStats!.totalCases} bound, ${fixtureStats!.totalRuns} run(s), ${fixtureStats!.cumulativeCasesRun} cumulative executions`,
        `  bugs:        ${bugStats!.found} found / ${bugStats!.fixed} fixed / ${bugStats!.open} open`,
      ];
      return lines.join('\n') + metricsLine;
    },

    summary_get(args: { storyId: string }): StorySummaryData | { _empty: true } {
      const data = store.readSummary(args.storyId);
      if (!data) return { _empty: true };
      return data;
    },
  };
}

/**
 * Format a loaded summary into a markdown-ish block for DONE-advance hint
 * output. Used by story-advance.ts after successful DONE transition so the
 * agent has all the material to speak the summary back to the user in chat.
 */
export function renderSummaryForHint(summary: StorySummaryData): string {
  const lines: string[] = [];
  lines.push(`📋 Story 总结 (${summary.storyId}) — 请把以下内容用你自己的话告诉用户:`);
  lines.push('');
  lines.push('## 改了什么');
  lines.push(summary.changes);
  lines.push('');
  lines.push('## 怎么用');
  lines.push(summary.usage);
  lines.push('');
  lines.push('## 真机验证覆盖');
  lines.push(`  ✓ 跑过: ${summary.realMachineCoverage.ran.length} 条`);
  for (const r of summary.realMachineCoverage.ran) {
    lines.push(`    - ${r.name}  (${r.where})`);
  }
  lines.push(`  ✗ 没跑: ${summary.realMachineCoverage.skipped.length} 条`);
  for (const s of summary.realMachineCoverage.skipped) {
    lines.push(`    - ${s.name}  (${s.where})`);
    lines.push(`      原因: ${s.reason}`);
  }
  lines.push('');
  // B-1522: 各阶段进入次数 + 耗时
  if (summary.phaseStats && Object.keys(summary.phaseStats).length > 0) {
    lines.push('## 各阶段耗时');
    // 按常见 phase 顺序排序，未列入的放最后
    const phaseOrder = ['INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE', 'TEST_CASE', 'TEST_CASE_REVIEW'];
    const ordered = Object.keys(summary.phaseStats).sort((a, b) => {
      const ia = phaseOrder.indexOf(a);
      const ib = phaseOrder.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    for (const p of ordered) {
      const s = summary.phaseStats[p];
      lines.push(`  - ${p}: 进入 ${s.count} 次，累计 ${formatDuration(s.durationMs)}`);
    }
    lines.push(`  总计: ${formatDuration(summary.totalDurationMs || 0)}`);
    lines.push('');
  }
  // B-1522: fixture 统计
  if (summary.fixtureStats) {
    const fs = summary.fixtureStats;
    lines.push('## Fixture 执行统计');
    lines.push(`  - 当前 story 绑定 case: ${fs.totalCases} 条`);
    lines.push(`  - validate 累计调用: ${fs.totalRuns} 次`);
    lines.push(`  - 累计执行次数（∑ totalCases）: ${fs.cumulativeCasesRun}`);
    lines.push(`  - 累计 PASS 次数（∑ passedCases）: ${fs.cumulativePassedCases}`);
    lines.push('');
  }
  // B-1522: bug 统计
  if (summary.bugStats) {
    const bs = summary.bugStats;
    lines.push('## Bug 统计');
    lines.push(`  - 发现: ${bs.found}   修复: ${bs.fixed}   遗留: ${bs.open}`);
    lines.push('');
  }
  lines.push('## 已知限制 / 设计偏离');
  lines.push(summary.limitations);
  lines.push('');
  lines.push('## 踩坑记录');
  lines.push(summary.pitfalls);
  return lines.join('\n');
}
