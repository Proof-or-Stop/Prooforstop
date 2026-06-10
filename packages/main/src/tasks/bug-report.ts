
import { StoryStore } from '../core/store.js';
import { loadConfig } from '../core/config.js';
import { execSync } from 'child_process';
import type { StoryInfo, BugRecord } from '../core/types.js';

// ── Types ──

export type BugSource =
  | 'story_type_bug'     // story type="bug"
  | 'bug_json'           // bug.json record
  | 'test_fail'          // test-evidence FAIL
  | 'checklist_fix'      // checklist contains fix keyword
  | 'git_fix_commit';    // git commit message contains fix/bug

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
    /** bug story count / total story count */
    storyBugRate: string;
    /** total bug count / total story count */
    bugPerStory: string;
    /** FAIL count / total test count */
    testFailRate: string;
    /** commit count containing fix / total commit count */
    gitFixRate: string;
    avgFixTimeHours: string;
  };
  bugs: BugEntry[];
  storyMetrics: StoryMetrics[];
  /** Human-readable report in Markdown format */
  markdown: string;
}

// ── Keyword matching ──

/** checklist uses strict matching: only matches keywords explicitly fixing bugs */
const CHECKLIST_FIX_PATTERNS = [/fix/i, /correct/i, /\bfix\b/i, /\bbugfix\b/i, /\bhotfix\b/i, /defect/i];
/** git commit uses loose matching */
const GIT_FIX_PATTERNS = [/\bfix\b/i, /repair/i, /correct/i, /defect/i];

function isChecklistFix(text: string): boolean {
  return CHECKLIST_FIX_PATTERNS.some(p => p.test(text));
}

function isGitFix(message: string): boolean {
  return GIT_FIX_PATTERNS.some(p => p.test(message));
}

function inferSeverity(text: string): BugEntry['severity'] {
  const lower = text.toLowerCase();
  if (/critical|severe|urgent|crash|data loss/.test(lower)) return 'critical';
  if (/high|blocker|block/.test(lower)) return 'high';
  if (/low|minor|tiny/.test(lower)) return 'low';
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
        title: `Test failed: ${evidence.command}`,
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
    // story_type_bug and git_fix_commit for the same story may be duplicated
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

  lines.push('# Bug Quality Report');
  lines.push(`> Generated at: ${report.generatedAt}`);
  lines.push('');

  // Summary
  lines.push('## Overview');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Total Stories | ${s.totalStories} |`);
  lines.push(`| Total Bugs | ${s.totalBugs} |`);
  lines.push(`| Bug-to-Story Ratio | ${s.storyBugRate} |`);
  lines.push(`| Bug / Story | ${s.bugPerStory} |`);
  lines.push(`| Test Failure Rate | ${s.testFailRate} |`);
  lines.push(`| Git fix commit Ratio | ${s.gitFixRate} |`);
  lines.push(`| Average Fix Time | ${s.avgFixTimeHours} |`);
  lines.push('');

  // By source
  lines.push('## Bug Source Distribution');
  lines.push('| Source | Count |');
  lines.push('|---|---|');
  const sourceLabels: Record<BugSource, string> = {
    story_type_bug: 'Bug-type Story',
    bug_json: 'bug.json Record',
    test_fail: 'Test Failure (FAIL)',
    checklist_fix: 'Checklist Fix Item',
    git_fix_commit: 'Git fix commit',
  };
  for (const [src, label] of Object.entries(sourceLabels)) {
    const count = s.bugsBySource[src as BugSource] || 0;
    if (count > 0) lines.push(`| ${label} | ${count} |`);
  }
  lines.push('');

  // By severity
  lines.push('## Bug Severity Distribution');
  lines.push('| Severity | Count |');
  lines.push('|---|---|');
  for (const sev of ['critical', 'high', 'medium', 'low']) {
    const count = s.bugsBySeverity[sev] || 0;
    if (count > 0) lines.push(`| ${sev} | ${count} |`);
  }
  lines.push('');

  // Bug list
  lines.push('## Bug Details');
  lines.push('| ID | Story | Title | Source | Severity | Status |');
  lines.push('|---|---|---|---|---|---|');
  for (const b of report.bugs) {
    lines.push(`| ${b.id} | ${b.storyId} | ${b.title.substring(0, 50)} | ${sourceLabels[b.source]} | ${b.severity} | ${b.status} |`);
  }
  lines.push('');

  // Story metrics
  lines.push('## Story Quality Matrix');
  lines.push('| Story | Title | Type | Bugs | Tests | Failures | Dev Time (h) |');
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
