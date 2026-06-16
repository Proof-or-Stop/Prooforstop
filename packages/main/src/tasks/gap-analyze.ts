
import { scanTruth } from './truth.js';
import type { TruthEntry } from './truth.js';
import {
  scan,
  extractFlows,
  walkDir,
  extractBlocks,
  parseBlock,
  parseFunctionAfterBlock,
  shouldSkipSourceDir,
} from './extract.js';
import { validate, validateFlows, validateTestAnnotations } from './validate.js';
import type { TaskAnnotation, FlowChain } from './types.js';
import { StoryStore } from '../core/store.js';
import { join, relative } from 'path';
import { loadConfig } from '../core/config.js';
import { isEvidenceStateBlocking } from '../core/advisory.js';
import type { Finding, StoryInfo, StoryPhase } from '../core/types.js';
import { existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';

/** Gap item */
export interface GapItem {
  type: 'no_code' | 'no_test' | 'no_flow' | 'broken_flow' | 'uncovered_requirement';
  description: string;
  source?: { file: string; line: number };
  severity: 'high' | 'medium' | 'low';
}

/** Gap analysis result */
export interface GapResult {
  _dashboard?: string;
  _hint?: string;
  truthEntries: number;
  codeAnnotations: number;
  flows: number;
  gaps: GapItem[];
  coveragePercent: number;
  healthy: boolean;
}

/** Convergence check result */
export interface ConvergenceResult {
  converged: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    detail: string;
  }>;
}

const AUDIT_STORY_ID = 'B-META-framework-audit';
const AUDIT_BLOCKING_SEVERITIES = new Set<Finding['severity']>(['critical', 'high']);

function normalizeSourceFile(sourceFile: string): string {
  return sourceFile.split(/[\\/]+/).filter(Boolean).join('/');
}

function isIgnoredSourceFile(sourceFile: string): boolean {
  return normalizeSourceFile(sourceFile).split('/').some(shouldSkipSourceDir);
}

function taskKey(task: TaskAnnotation): string {
  const sourceFile = normalizeSourceFile(task.sourceFile);
  return task.functionName
    ? `${sourceFile}:${task.functionName}`
    : `${sourceFile}:${task.sourceLine}:${task.task}`;
}

function taskTestKey(task: TaskAnnotation): string {
  return `${taskKey(task)}:${task.test ?? ''}`;
}

function hasMissingFixture(projectRoot: string, fixturesDir: string, task: TaskAnnotation): boolean {
  return Boolean(task.test)
    && !existsSync(join(projectRoot, fixturesDir, `${task.test}.json`));
}

function isStaleMissingTestAnnotation(
  projectRoot: string,
  fixturesDir: string,
  sourceTestKeys: Set<string>,
  task: TaskAnnotation,
): boolean {
  return Boolean(task.test)
    && hasMissingFixture(projectRoot, fixturesDir, task)
    && !sourceTestKeys.has(taskTestKey(task));
}

function taskSourceExists(projectRoot: string, scanRoot: string, rootDir: string | undefined, task: TaskAnnotation): boolean {
  if (!task.sourceFile) return true;
  const normalized = normalizeSourceFile(task.sourceFile);
  if (isIgnoredSourceFile(normalized)) return false;
  const candidates = [
    join(scanRoot, normalized),
    join(projectRoot, normalized),
  ];
  if (rootDir) candidates.push(join(scanRoot, rootDir, normalized));
  return candidates.some((candidate) => existsSync(candidate));
}

function scanSourceAnnotations(scanRoot: string): TaskAnnotation[] {
  const tasks: TaskAnnotation[] = [];
  for (const filePath of walkDir(scanRoot)) {
    const content = readFileSync(filePath, 'utf-8');
    for (const { raw, line, endIndex } of extractBlocks(content)) {
      const parsed = parseBlock(raw);
      if (!parsed.task) continue;
      const fnInfo = parseFunctionAfterBlock(content, endIndex);
      tasks.push({
        task: parsed.task as string,
        checklist: parsed.checklist as string[] | undefined,
        title: parsed.title as string | undefined,
        type: parsed.type as string | undefined,
        priority: parsed.priority as string | undefined,
        version: parsed.version as string | undefined,
        scope: parsed.scope as string | undefined,
        depends: parsed.depends as string[] | undefined,
        author: parsed.author as string | undefined,
        date: parsed.date as string | undefined,
        description: parsed.description as string | undefined,
        changes: parsed.changes as string[] | undefined,
        affected: parsed.affected as string[] | undefined,
        sourceFile: relative(scanRoot, filePath),
        sourceLine: line,
        functionName: fnInfo?.functionName,
        functionSignature: fnInfo?.functionSignature,
        flow: parsed.flow as string | undefined,
        step: parsed.step ? parseInt(parsed.step as string, 10) : undefined,
        input: parsed.input as string | undefined,
        output: parsed.output as string | undefined,
        next: parsed.next as string | undefined,
        test: parsed.test as string | undefined,
      });
    }
  }
  return tasks;
}

function scanCoverageTasks(scanRoot: string, projectRoot: string, rootDir: string | undefined): TaskAnnotation[] {
  const config = loadConfig(projectRoot);
  const sourceTasks = scanSourceAnnotations(scanRoot);
  const sourceTestKeys = new Set(sourceTasks.filter(task => task.test).map(taskTestKey));
  const merged = new Map<string, TaskAnnotation>();
  for (const task of scan(scanRoot)) {
    if (!taskSourceExists(projectRoot, scanRoot, rootDir, task)) continue;
    if (isStaleMissingTestAnnotation(projectRoot, config.fixturesDir, sourceTestKeys, task)) continue;
    merged.set(taskKey(task), task);
  }
  for (const task of sourceTasks) {
    if (!merged.has(taskKey(task))) merged.set(taskKey(task), task);
  }
  return Array.from(merged.values());
}

function isBlockingAuditFinding(finding: Finding): boolean {
  return finding.status === 'open'
    && AUDIT_BLOCKING_SEVERITIES.has(finding.severity)
    && isEvidenceStateBlocking(finding.evidenceState);
}

function formatAuditFinding(finding: Finding): string {
  const evidenceState = finding.evidenceState ?? 'verified(legacy)';
  return `${finding.id} [${finding.severity}/${evidenceState}]`;
}

function hasRecordedWorktreePath(story: StoryInfo): boolean {
  return Boolean(story.worktree?.path?.trim());
}

function readLinkedStoryWorktreeIds(projectRoot: string): Set<string> {
  const gitCwd = projectRoot;
  try {
    const raw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const linked = new Set<string>();
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^branch refs\/heads\/story\/(.+)$/);
      if (match?.[1]) linked.add(match[1]);
    }
    return linked;
  } catch {
    return new Set();
  }
}

function isParkedBacklogStory(storyId: string, story: StoryInfo, linkedStoryWorktreeIds: Set<string>): boolean {
  return story.phase === 'INIT'
    && !hasRecordedWorktreePath(story)
    && !linkedStoryWorktreeIds.has(storyId);
}

export function analyzeGap(projectRoot: string, store?: StoryStore): GapResult {
  const config = loadConfig(projectRoot);
  const scanRoot = join(projectRoot, config.scanRoot);
  const truth = scanTruth(projectRoot);
  const tasks = scanCoverageTasks(scanRoot, projectRoot, config.rootDir);
  const chains = extractFlows(tasks);
  const validation = validate(scanRoot);
  const flowValidation = validateFlows(chains, tasks);
  const testIssues = validateTestAnnotations(tasks, projectRoot);

  const gaps: GapItem[] = [];

  // 1. Requirements without any @task code coverage
  const requirements = truth.entries.filter(e => e.type === 'requirement');
  const taskIds = new Set(tasks.map(t => t.task));

  for (const req of requirements) {
    // Check if any task annotation mentions keywords from this requirement
    const keywords = req.summary.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z_]{4,}/g) || [];
    const hasMatch = tasks.some(t => {
      const taskText = [t.title, t.description, ...(t.changes || [])].join(' ');
      return keywords.some(kw => taskText.includes(kw));
    });

    if (!hasMatch) {
      gaps.push({
        type: 'uncovered_requirement',
        description: `Requirement has no corresponding implementation in code: ${req.summary}`,
        source: { file: req.file, line: req.line },
        severity: 'high',
      });
    }
  }

  // 2. Tasks without @test
  for (const t of tasks) {
    if (t.functionName && !t.test) {
      gaps.push({
        type: 'no_test',
        description: `Function ${t.functionName} is missing @test annotation (${t.sourceFile}:${t.sourceLine})`,
        severity: t.flow ? 'high' : 'medium',
      });
    }
  }

  // 3. Broken flows
  for (const issue of flowValidation.issues) {
    if (issue.level === 'error') {
      gaps.push({
        type: 'broken_flow',
        description: `Flow validation error: ${issue.msg}`,
        severity: 'high',
      });
    }
  }

  // 4. Test fixture missing
  for (const issue of testIssues) {
    gaps.push({
      type: 'no_test',
      description: issue.msg,
      severity: 'medium',
    });
  }

  const totalRequirements = requirements.length;
  const coveredRequirements = totalRequirements - gaps.filter(g => g.type === 'uncovered_requirement').length;
  const coveragePercent = totalRequirements > 0 ? Math.round((coveredRequirements / totalRequirements) * 100) : 100;

  const highGaps = gaps.filter(g => g.severity === 'high').length;
  const mediumGaps = gaps.filter(g => g.severity === 'medium').length;
  // Function-level test coverage: both numerator and denominator are based on "tasks with functionName", avoiding file-level @task
  // making numerator larger than denominator and causing percentage > 100 (which would make ░.repeat(negative) crash)
  const fnTasks = tasks.filter(t => t.functionName);
  const testPct = fnTasks.length > 0
    ? Math.round(fnTasks.filter(t => t.test).length / fnTasks.length * 100)
    : 0;
  const mkBar = (pct: number) => {
    const filled = Math.max(0, Math.min(20, Math.round(pct / 5)));
    return '█'.repeat(filled) + '░'.repeat(20 - filled);
  };
  const testBar = mkBar(testPct);
  const covBar = mkBar(coveragePercent);

  return {
    _dashboard: [
      `Requirement coverage ${covBar} ${coveragePercent}%`,
      `Test coverage ${testBar} ${testPct}%`,
      `Gaps: ${highGaps} high / ${mediumGaps} medium`,
    ].join('\n'),
    _hint: 'Please display the dashboard at the very top',
    truthEntries: truth.entries.length,
    codeAnnotations: tasks.length,
    flows: chains.length,
    gaps,
    coveragePercent,
    healthy: highGaps === 0,
  };
}

export function checkConvergence(projectRoot: string, store: StoryStore): ConvergenceResult {
  const config = loadConfig(projectRoot);
  const scanRoot = join(projectRoot, config.scanRoot);
  const gap = analyzeGap(projectRoot, store);
  const tasks = scanCoverageTasks(scanRoot, projectRoot, config.rootDir);
  const chains = extractFlows(tasks);
  const flowValidation = validateFlows(chains, tasks);
  const codeValidation = validate(scanRoot);

  // Check all stories
  const terminalPhases = new Set<StoryPhase>(['DONE', 'DISCARDED']);
  const storyIds = store.listStoryIds();
  const linkedStoryWorktreeIds = readLinkedStoryWorktreeIds(projectRoot);
  const businessNonTerminalStories = storyIds
    .map(id => ({ id, story: store.readStory(id) }))
    .filter(({ story }) => story.phase !== 'META' && !terminalPhases.has(story.phase));
  const parkedBacklogStories = businessNonTerminalStories
    .filter(({ id, story }) => isParkedBacklogStory(id, story, linkedStoryWorktreeIds))
    .map(({ id }) => id);
  const activeStories = businessNonTerminalStories
    .filter(({ id, story }) => !isParkedBacklogStory(id, story, linkedStoryWorktreeIds))
    .map(({ id }) => id);
  const auditFindings = store.readFindings(AUDIT_STORY_ID).findings.filter(f => f.status === 'open');
  const blockingAuditFindings = auditFindings.filter(isBlockingAuditFinding);
  const advisoryAuditFindings = auditFindings.filter(f => !isBlockingAuditFinding(f));

  const checks: ConvergenceResult['checks'] = [];

  // 1. No high-severity gaps
  const highGaps = gap.gaps.filter(g => g.severity === 'high');
  checks.push({
    name: 'No high-priority gaps',
    passed: highGaps.length === 0,
    detail: highGaps.length === 0 ? 'All requirements are covered' : `${highGaps.length} high-priority gaps to resolve`,
  });

  // 2. All flows valid
  checks.push({
    name: 'Flow chain complete',
    passed: flowValidation.passed,
    detail: flowValidation.passed ? `All ${chains.length} chains passed` : `${flowValidation.issues.filter(i => i.level === 'error').length} flow errors`,
  });

  // 3. Code annotations valid
  checks.push({
    name: 'Code annotations compliant',
    passed: codeValidation.passed,
    detail: codeValidation.passed ? `All ${codeValidation.tasksFound} annotations compliant` : `${codeValidation.errors.length} annotation errors`,
  });

  // 4. All stories DONE
  checks.push({
    name: 'All Stories completed',
    passed: activeStories.length === 0,
    detail: activeStories.length === 0 ? 'No unfinished business Stories' : `${activeStories.length} Stories unfinished: ${activeStories.join(', ')}`,
  });

  // 5. Parked backlog advisory
  checks.push({
    name: 'Parked backlog',
    passed: true,
    detail: parkedBacklogStories.length === 0
      ? 'No parked backlog'
      : `${parkedBacklogStories.length} parked backlog advisory: ${parkedBacklogStories.join(', ')}`,
  });

  // 6. Audit backlog
  checks.push({
    name: 'Audit backlog',
    passed: blockingAuditFindings.length === 0,
    detail: auditFindings.length === 0
      ? 'No open audit findings'
      : [
        `${blockingAuditFindings.length} blocking`,
        blockingAuditFindings.length > 0 ? blockingAuditFindings.map(formatAuditFinding).join(', ') : null,
        `${advisoryAuditFindings.length} advisory`,
        advisoryAuditFindings.length > 0 ? advisoryAuditFindings.map(formatAuditFinding).join(', ') : null,
      ].filter(Boolean).join('; '),
  });

  // 7. Requirements coverage
  checks.push({
    name: 'Requirements coverage',
    passed: gap.coveragePercent === 100,
    detail: `${gap.coveragePercent}%`,
  });

  return {
    converged: checks.every(c => c.passed),
    checks,
  };
}
