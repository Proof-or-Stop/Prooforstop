
import { StoryStore } from '../story/store.js';
import { loadConfig } from '../config.js';
import { execSync } from 'child_process';
import type { StoryInfo, BugRecord } from '../story/types.js';

// ── Types ──

export type BugSource =
  | 'story_type_bug'     // story type="bug"
  | 'bug_json'           // bug.json 记录
  | 'test_fail'          // test-evidence FAIL
  | 'checklist_fix'      // checklist 含修复关键词
  | 'git_fix_commit';    // git commit message 含 fix/bug

export interface BugEntry {
  id: string;
  source: BugSource;
  storyId: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'open' | 'fixed';
  foundAt: string;
  fixedAt: string | null;
  details?: string;
}

export interface StoryMetrics {
  storyId: string;
  title: string;
  type: string;
  phase: string;
  bugCount: number;
  testTotal: number;
  testFail: number;
  devDurationHours: number | null;
}

export interface BugReport {
  generatedAt: string;
  summary: {
    totalStories: number;
    totalBugs: number;
    bugsBySource: Record<BugSource, number>;
    bugsByStatus: { open: number; fixed: number };
    bugsBySeverity: Record<string, number>;
    /** bug story 数 / 总 story 数 */
    storyBugRate: string;
    /** 总 bug 数 / 总 story 数 */
    bugPerStory: string;
    /** FAIL 数 / 总测试数 */
    testFailRate: string;
    /** 含 fix 的 commit 数 / 总 commit 数 */
    gitFixRate: string;
    avgFixTimeHours: string;
  };
  bugs: BugEntry[];
  storyMetrics: StoryMetrics[];
  /** Markdown 格式的可读报告 */
  markdown: string;
}

// ── Keyword matching ──

/** checklist 用严格匹配：只匹配明确修 bug 的关键词 */
const CHECKLIST_FIX_PATTERNS = [/修复/, /修正/, /\bfix\b/i, /\bbugfix\b/i, /\bhotfix\b/i, /缺陷/];
/** git commit 用宽松匹配 */
const GIT_FIX_PATTERNS = [/\bfix\b/i, /修复/, /修正/, /缺陷/];

function isChecklistFix(text: string): boolean {
  return CHECKLIST_FIX_PATTERNS.some(p => p.test(text));
}

function isGitFix(message: string): boolean {
  return GIT_FIX_PATTERNS.some(p => p.test(message));
}

function inferSeverity(text: string): BugEntry['severity'] {
  const lower = text.toLowerCase();
  if (/critical|严重|紧急|crash|数据丢失/.test(lower)) return 'critical';
  if (/high|高|阻塞|block/.test(lower)) return 'high';
  if (/low|低|minor|微小/.test(lower)) return 'low';
  return 'medium';
}

// ── Extraction functions ──

function extractFromStoryType(store: StoryStore, storyIds: string[]): BugEntry[] {
  const bugs: BugEntry[] = [];
  for (const sid of storyIds) {
    const story = store.readStory(sid);
    if (story.type === 'bug') {
      bugs.push({
        id: `${sid}-story`,
        source: 'story_type_bug',
        storyId: sid,
        title: story.title,
        severity: inferSeverity(story.priority + ' ' + story.description),
        status: story.phase === 'DONE' ? 'fixed' : 'open',
        foundAt: story.createdAt,
        fixedAt: story.endedAt,
        details: story.description,
      });
    }
  }
  return bugs;
}

function extractFromBugJson(store: StoryStore, storyIds: string[]): BugEntry[] {
  const bugs: BugEntry[] = [];
  for (const sid of storyIds) {
    const bugData = store.readBugs(sid);
    for (const b of bugData.bugs) {
      bugs.push({
        id: `${sid}-${b.id}`,
        source: 'bug_json',
        storyId: sid,
        title: b.title,
        severity: inferSeverity(b.title),
        status: b.status,
        foundAt: b.foundAt,
        fixedAt: b.fixedAt,
      });
    }
  }
  return bugs;
}

function extractFromTestEvidence(store: StoryStore, storyIds: string[]): BugEntry[] {
  const bugs: BugEntry[] = [];
  for (const sid of storyIds) {
    const evidence = store.readTestEvidence(sid);
    if (evidence && evidence.result === 'FAIL') {
      bugs.push({
        id: `${sid}-test-fail`,
        source: 'test_fail',
        storyId: sid,
        title: `测试失败: ${evidence.command}`,
        severity: 'medium',
        status: 'open',
        foundAt: evidence.timestamp,
        fixedAt: null,
        details: evidence.output,
      });
    }
  }
  return bugs;
}

function extractFromChecklist(store: StoryStore, storyIds: string[]): BugEntry[] {
  const bugs: BugEntry[] = [];
  for (const sid of storyIds) {
    try {
      const cl = store.readChecklist(sid);
      for (const item of cl.items) {
        if (isChecklistFix(item.title)) {
          bugs.push({
            id: `${sid}-${item.id}-cl`,
            source: 'checklist_fix',
            storyId: sid,
            title: item.title,
            severity: inferSeverity(item.title),
            status: item.status === 'done' ? 'fixed' : 'open',
            foundAt: item.startTime || '',
            fixedAt: item.endTime,
          });
        }
      }
    } catch { /* no checklist */ }
  }
  return bugs;
}

interface GitCommitInfo {
  hash: string;
  message: string;
  date: string;
}

function extractFromGitLog(projectRoot: string): { fixCommits: GitCommitInfo[]; totalCommits: number } {
  try {
    const raw = execSync(
      'git log --oneline --format="%H||%s||%aI" --all',
      { cwd: projectRoot, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );
    const lines = raw.trim().split('\n').filter(Boolean);
    const all = lines.map(line => {
      const [hash, message, date] = line.split('||');
      return { hash, message, date };
    });
    const fixCommits = all.filter(c => isGitFix(c.message));
    return { fixCommits, totalCommits: all.length };
  } catch {
    return { fixCommits: [], totalCommits: 0 };
  }
}

function gitFixToBugEntries(fixCommits: GitCommitInfo[]): BugEntry[] {
  return fixCommits.map((c, i) => {
    const storyMatch = c.message.match(/B-\d+/);
    return {
      id: `git-fix-${i + 1}`,
      source: 'git_fix_commit' as BugSource,
      storyId: storyMatch ? storyMatch[0] : 'unknown',
      title: c.message,
      severity: inferSeverity(c.message),
      status: 'fixed' as const,
      foundAt: c.date,
      fixedAt: c.date,
      details: `commit: ${c.hash.substring(0, 8)}`,
    };
  });
}

// ── Dedup ──

function dedup(bugs: BugEntry[]): BugEntry[] {
  const seen = new Set<string>();
  const result: BugEntry[] = [];
  for (const b of bugs) {
    // 同一 story 的 story_type_bug 和 git_fix_commit 可能重复
    const key = `${b.storyId}:${b.title.substring(0, 40)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(b);
    }
  }
  return result;
}

// ── Story metrics ──

function buildStoryMetrics(store: StoryStore, storyIds: string[], bugs: BugEntry[]): StoryMetrics[] {
  return storyIds.map(sid => {
    const story = store.readStory(sid);
    const evidence = store.readTestEvidence(sid);
    const storyBugs = bugs.filter(b => b.storyId === sid);

    let devHours: number | null = null;
    if (story.startedAt && story.endedAt) {
      devHours = Math.round(
        (new Date(story.endedAt).getTime() - new Date(story.startedAt).getTime()) / 3600000 * 10,
      ) / 10;
    }

    return {
      storyId: sid,
      title: story.title,
      type: story.type,
      phase: story.phase,
      bugCount: storyBugs.length,
      testTotal: evidence ? 1 : 0,
      testFail: evidence && evidence.result === 'FAIL' ? 1 : 0,
      devDurationHours: devHours,
    };
  });
}

// ── Markdown rendering ──

function renderMarkdown(report: Omit<BugReport, 'markdown'>): string {
  const s = report.summary;
  const lines: string[] = [];

  lines.push('# Bug 质量报告');
  lines.push(`> 生成时间: ${report.generatedAt}`);
  lines.push('');

  // Summary
  lines.push('## 概览');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  lines.push(`| Story 总数 | ${s.totalStories} |`);
  lines.push(`| Bug 总数 | ${s.totalBugs} |`);
  lines.push(`| Bug Story 比率 | ${s.storyBugRate} |`);
  lines.push(`| Bug / Story | ${s.bugPerStory} |`);
  lines.push(`| 测试失败率 | ${s.testFailRate} |`);
  lines.push(`| Git fix commit 比率 | ${s.gitFixRate} |`);
  lines.push(`| 平均修复时长 | ${s.avgFixTimeHours} |`);
  lines.push('');

  // By source
  lines.push('## Bug 来源分布');
  lines.push('| 来源 | 数量 |');
  lines.push('|---|---|');
  const sourceLabels: Record<BugSource, string> = {
    story_type_bug: 'Bug 类型 Story',
    bug_json: 'bug.json 记录',
    test_fail: '测试失败(FAIL)',
    checklist_fix: 'Checklist 修复项',
    git_fix_commit: 'Git fix commit',
  };
  for (const [src, label] of Object.entries(sourceLabels)) {
    const count = s.bugsBySource[src as BugSource] || 0;
    if (count > 0) lines.push(`| ${label} | ${count} |`);
  }
  lines.push('');

  // By severity
  lines.push('## Bug 严重性分布');
  lines.push('| 严重性 | 数量 |');
  lines.push('|---|---|');
  for (const sev of ['critical', 'high', 'medium', 'low']) {
    const count = s.bugsBySeverity[sev] || 0;
    if (count > 0) lines.push(`| ${sev} | ${count} |`);
  }
  lines.push('');

  // Bug list
  lines.push('## Bug 明细');
  lines.push('| ID | Story | 标题 | 来源 | 严重性 | 状态 |');
  lines.push('|---|---|---|---|---|---|');
  for (const b of report.bugs) {
    lines.push(`| ${b.id} | ${b.storyId} | ${b.title.substring(0, 50)} | ${sourceLabels[b.source]} | ${b.severity} | ${b.status} |`);
  }
  lines.push('');

  // Story metrics
  lines.push('## Story 质量矩阵');
  lines.push('| Story | 标题 | 类型 | Bug数 | 测试数 | 失败数 | 开发时长(h) |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const m of report.storyMetrics) {
    lines.push(`| ${m.storyId} | ${m.title.substring(0, 30)} | ${m.type} | ${m.bugCount} | ${m.testTotal} | ${m.testFail} | ${m.devDurationHours ?? '-'} |`);
  }
  lines.push('');

  return lines.join('\n');
}

// ── Main ──

export function extractBugs(projectRoot: string): BugReport {
  const store = new StoryStore(projectRoot);
  const storyIds = store.listStoryIds().sort();

  // 1. Multi-source extraction
  const fromStory = extractFromStoryType(store, storyIds);
  const fromBugJson = extractFromBugJson(store, storyIds);
  const fromTestFail = extractFromTestEvidence(store, storyIds);
  const fromChecklist = extractFromChecklist(store, storyIds);
  const { fixCommits, totalCommits } = extractFromGitLog(projectRoot);
  const fromGit = gitFixToBugEntries(fixCommits);

  // 2. Merge & dedup
  const allBugs = dedup([...fromStory, ...fromBugJson, ...fromTestFail, ...fromChecklist, ...fromGit]);

  // 3. Stats
  const bugsBySource = {} as Record<BugSource, number>;
  const bugsBySeverity = {} as Record<string, number>;
  const byStatus = { open: 0, fixed: 0 };

  for (const b of allBugs) {
    bugsBySource[b.source] = (bugsBySource[b.source] || 0) + 1;
    bugsBySeverity[b.severity] = (bugsBySeverity[b.severity] || 0) + 1;
    byStatus[b.status]++;
  }

  // Bug stories
  const bugStoryCount = new Set(
    storyIds.filter(sid => {
      try { return store.readStory(sid).type === 'bug'; } catch { return false; }
    }),
  ).size;

  // Test totals
  let totalTests = 0;
  let totalFails = 0;
  for (const sid of storyIds) {
    const ev = store.readTestEvidence(sid);
    if (ev) {
      totalTests += 1;
      if (ev.result === 'FAIL') totalFails += 1;
    }
  }

  // Avg fix time
  const fixTimes = allBugs
    .filter(b => b.fixedAt && b.foundAt)
    .map(b => new Date(b.fixedAt!).getTime() - new Date(b.foundAt).getTime())
    .filter(ms => ms > 0);
  const avgFixMs = fixTimes.length > 0 ? fixTimes.reduce((a, b) => a + b, 0) / fixTimes.length : 0;
  const avgFixHours = Math.round(avgFixMs / 3600000 * 10) / 10;

  // Story metrics
  const storyMetrics = buildStoryMetrics(store, storyIds, allBugs);

  const partial: Omit<BugReport, 'markdown'> = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalStories: storyIds.length,
      totalBugs: allBugs.length,
      bugsBySource,
      bugsByStatus: byStatus,
      bugsBySeverity,
      storyBugRate: `${bugStoryCount}/${storyIds.length} (${(bugStoryCount / storyIds.length * 100).toFixed(1)}%)`,
      bugPerStory: `${(allBugs.length / storyIds.length).toFixed(2)}`,
      testFailRate: totalTests > 0 ? `${totalFails}/${totalTests} (${(totalFails / totalTests * 100).toFixed(1)}%)` : 'N/A',
      gitFixRate: totalCommits > 0 ? `${fixCommits.length}/${totalCommits} (${(fixCommits.length / totalCommits * 100).toFixed(1)}%)` : 'N/A',
      avgFixTimeHours: fixTimes.length > 0 ? `${avgFixHours}h` : 'N/A',
    },
    bugs: allBugs,
    storyMetrics,
  };

  return {
    ...partial,
    markdown: renderMarkdown(partial),
  };
}
