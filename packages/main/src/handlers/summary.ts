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
 *
 *   The `realMachineCoverage` field is NOT accepted from the caller.
 *   It's auto-scaffolded by scanning every fixture file under fixturesDir
 *   for cases with `sandbox: false` (real-machine), cross-referencing with
 *   test-evidence.json to mark each as ran/skipped, and requiring the agent
 *   to supply a per-case `skipReasons` dict for the skipped ones.
 *
 *   This prevents the "agent writes 'smoke all passed' without actually
 *   running them" failure mode that B-e28c and B-2614 both hit.
 * @changes
 *   - [CHK-001] DONE 前强制生成 summary.json，固定 changes/usage/limitations/pitfalls 与真实真机覆盖骨架
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { HandlerContext } from './context.js';
import type { StorySummaryData, StoryInfo, BugData, StoryTestRunsData } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import { ACTIVE_PHASE_ORDER } from '../core/phase-flow.js';

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

interface FixtureCase {
  name: string;
  sandbox?: boolean;
  intentRef?: string;
}

interface FixtureFile {
  cases?: FixtureCase[];
}

interface ScanResult {
  /** file path relative to project root → list of real-machine case names */
  byFile: Array<{ file: string; cases: string[] }>;
  /** flat list of all real-machine cases found */
  allCases: Array<{ name: string; file: string }>;
}

/**
 * Walk fixturesDir looking for .json files containing cases with sandbox:false.
 * Only include cases whose intentRef starts with "CHK-" (any checklist item of
 * THIS story — we can't easily tell which story a fixture belongs to without
 * cross-referencing, so we scope to cases matching the story's checklist ids).
 */
function scanRealMachineFixtures(
  projectRoot: string,
  fixturesDir: string,
  storyChecklistIds: Set<string>,
): ScanResult {
  const absFixturesDir = join(projectRoot, fixturesDir);
  const result: ScanResult = { byFile: [], allCases: [] };
  if (!existsSync(absFixturesDir)) return result;

  const walk = (dir: string): string[] => {
    const out: string[] = [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        out.push(...walk(full));
      } else if (entry.endsWith('.json')) {
        out.push(full);
      }
    }
    return out;
  };

  for (const filePath of walk(absFixturesDir)) {
    let parsed: FixtureFile;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as FixtureFile;
    } catch {
      continue;
    }
    if (!parsed.cases || !Array.isArray(parsed.cases)) continue;

    const matched: string[] = [];
    for (const c of parsed.cases) {
      if (c.sandbox !== false) continue;
      // Filter by intentRef starting with one of this story's checklist ids
      if (!c.intentRef) continue;
      const chkId = c.intentRef.split(':')[0]; // "CHK-001:happy:0" → "CHK-001"
      if (!storyChecklistIds.has(chkId)) continue;
      matched.push(c.name);
    }
    if (matched.length > 0) {
      const rel = relative(projectRoot, filePath);
      result.byFile.push({ file: rel, cases: matched });
      for (const name of matched) {
        result.allCases.push({ name, file: rel });
      }
    }
  }

  return result;
}

/**
 * Parse test-evidence.json output to figure out which cases actually ran + passed.
 * We look at the "output" field (JSON with passedCases/failedCases arrays) OR
 * fall back to the coarse result: if result === 'PASS', treat all fixtures as ran.
 * If output is not JSON-parseable, we assume everything is "unknown" → ran.
 */
function extractRanCaseNames(evidenceOutput: string): Set<string> | null {
  try {
    const parsed = JSON.parse(evidenceOutput);
    const ran = new Set<string>();
    // Formats we've seen in practice:
    //   { allPassed, totalCases, passedCases: 59, failedCases: 0, ... }  (number)
    //   { passedCases: ['name1', 'name2'], ... }                         (array)
    //   { results: [{name, passed}] }                                    (per-case)
    if (Array.isArray(parsed.passedCases)) {
      for (const n of parsed.passedCases) if (typeof n === 'string') ran.add(n);
    }
    if (Array.isArray(parsed.results)) {
      for (const r of parsed.results) {
        if (r && typeof r === 'object' && typeof r.name === 'string' && r.passed !== false) {
          ran.add(r.name);
        }
      }
    }
    // If we got names, return them. Otherwise null = "can't tell, assume all".
    return ran.size > 0 ? ran : null;
  } catch {
    return null;
  }
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
     *   skipReasons  — optional dict {caseName: reason}; any skipped case
     *                  without a reason is reported back so agent can fix
     */
    summary_set(args: {
      storyId: string;
      changes: string;
      usage: string;
      limitations: string;
      pitfalls: string;
      skipReasons?: Record<string, string>;
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

      // Scan fixtures for real-machine cases scoped to this story's checklist.
      // Gating rule: only scan if test-evidence.json exists for THIS story.
      // Why: checklist ids (CHK-001, ...) restart per story, so cross-story
      // intentRef prefixes collide. Using test-evidence as the authoritative
      // "what was run under this story" list eliminates the false positives.
      // Short-path stories with no test-evidence get empty coverage — the
      // author should declare that in limitations.
      const cfg = loadConfig(root);
      const ev = store.readTestEvidence(args.storyId);
      let scan: ScanResult = { byFile: [], allCases: [] };
      let ranNames: Set<string> | null = null;

      if (ev) {
        let checklistIds = new Set<string>();
        try {
          const cl = store.readChecklist(args.storyId);
          for (const it of cl.items) checklistIds.add(it.id);
        } catch { /* no checklist */ }
        scan = scanRealMachineFixtures(root, cfg.fixturesDir, checklistIds);
        if (ev.result === 'PASS') {
          ranNames = extractRanCaseNames(ev.output);
        }
        // Further filter: only keep cases whose name actually appears in
        // test-evidence (either passedCases array or unknown/coarse PASS).
        // This is the final line of defense against cross-story CHK-id collision.
        if (ranNames !== null) {
          const evNames = ranNames;
          scan.allCases = scan.allCases.filter(c => evNames.has(c.name));
          scan.byFile = scan.byFile
            .map(b => ({ file: b.file, cases: b.cases.filter(n => evNames.has(n)) }))
            .filter(b => b.cases.length > 0);
        }
      }

      const skipReasons = args.skipReasons ?? {};
      const ran: StorySummaryData['realMachineCoverage']['ran'] = [];
      const skipped: StorySummaryData['realMachineCoverage']['skipped'] = [];
      const missingReasons: string[] = [];

      for (const c of scan.allCases) {
        let isRan: boolean;
        if (ranNames === null) {
          // Coarse PASS: evidence exists, format unparseable → assume ran
          isRan = ev !== null && ev.result === 'PASS';
        } else {
          isRan = ranNames.has(c.name);
        }
        if (isRan) {
          ran.push({ name: c.name, where: c.file });
        } else {
          const reason = skipReasons[c.name];
          if (!reason || reason.trim().length === 0) {
            missingReasons.push(c.name);
          }
          skipped.push({ name: c.name, where: c.file, reason: reason ?? '' });
        }
      }

      if (missingReasons.length > 0) {
        throw new Error(
          `summary.skipReasons 缺少 ${missingReasons.length} 条未跑 case 的原因:\n` +
          missingReasons.map(n => `  - ${n}`).join('\n') +
          '\n\n请在 skipReasons 字典中为每条补充说明，例如:\n' +
          `  {"skipReasons": {${missingReasons.slice(0, 2).map(n => `"${n}": "成本/框架限制/非确定性 详细原因"`).join(', ')}}}`
        );
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
        realMachineCoverage: { ran, skipped },
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

      const lines = [
        `Summary saved for ${args.storyId}`,
        `  changes:     ${args.changes.length} chars`,
        `  usage:       ${args.usage.length} chars`,
        `  limitations: ${args.limitations.length} chars`,
        `  pitfalls:    ${args.pitfalls.length} chars`,
        `  real-machine: ${ran.length} ran, ${skipped.length} skipped${scan.allCases.length === 0 ? ' (no real-machine fixtures found for this story)' : ''}`,
        `  total time:  ${formatDuration(totalDurationMs)}`,
        `  fixtures:    ${fixtureStats!.totalCases} bound, ${fixtureStats!.totalRuns} run(s), ${fixtureStats!.cumulativeCasesRun} cumulative executions`,
        `  bugs:        ${bugStats!.found} found / ${bugStats!.fixed} fixed / ${bugStats!.open} open`,
      ];
      if (skipped.length > 0) {
        lines.push('  skipped cases:');
        for (const s of skipped) lines.push(`    - ${s.name} — ${s.reason}`);
      }
      return lines.join('\n');
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
    // 按核心 phase 顺序排序，未列入的放最后
    const phaseOrder: string[] = ACTIVE_PHASE_ORDER.filter((phase) => phase !== 'IDEA');
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
    lines.push(`  - test_story 累计调用: ${fs.totalRuns} 次`);
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
