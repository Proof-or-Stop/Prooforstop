
import { scanTruth } from './truth.js';
import type { TruthEntry } from './truth.js';
import {
  scan,
  extractFlows,
  walkDir,
  extractBlocks,
  parseBlock,
  parseFunctionAfterBlock,
} from './extract.js';
import { validate, validateFlows, validateTestAnnotations } from './validate.js';
import type { TaskAnnotation, FlowChain } from './types.js';
import { StoryStore } from '../core/store.js';
import { join, relative } from 'path';
import { loadConfig } from '../core/config.js';
import { isEvidenceStateBlocking } from '../core/advisory.js';
import type { Finding, StoryPhase } from '../core/types.js';
import { existsSync, readFileSync } from 'fs';

/** 差距项 */
export interface GapItem {
  type: 'no_code' | 'no_test' | 'no_flow' | 'broken_flow' | 'uncovered_requirement';
  description: string;
  source?: { file: string; line: number };
  severity: 'high' | 'medium' | 'low';
}

/** 差距分析结果 */
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

/** 收敛检查结果 */
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

function taskKey(task: TaskAnnotation): string {
  return task.functionName
    ? `${task.sourceFile}:${task.functionName}`
    : `${task.sourceFile}:${task.sourceLine}:${task.task}`;
}

function taskSourceExists(projectRoot: string, scanRoot: string, rootDir: string | undefined, task: TaskAnnotation): boolean {
  if (!task.sourceFile) return true;
  const normalized = task.sourceFile.split(/[\\/]+/).filter(Boolean).join('/');
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
  const merged = new Map<string, TaskAnnotation>();
  for (const task of scan(scanRoot)) {
    if (!taskSourceExists(projectRoot, scanRoot, rootDir, task)) continue;
    merged.set(taskKey(task), task);
  }
  for (const task of scanSourceAnnotations(scanRoot)) {
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
        description: `需求未在代码中找到对应实现: ${req.summary}`,
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
        description: `函数 ${t.functionName} 缺少 @test 注释 (${t.sourceFile}:${t.sourceLine})`,
        severity: t.flow ? 'high' : 'medium',
      });
    }
  }

  // 3. Broken flows
  for (const issue of flowValidation.issues) {
    if (issue.level === 'error') {
      gaps.push({
        type: 'broken_flow',
        description: `Flow 校验错误: ${issue.msg}`,
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
  // 函数级测试覆盖率：分子分母都基于"有 functionName 的 task"，避免 file-level @task
  // 让分子大于分母导致百分比 > 100（会让 ░.repeat(负数) 崩溃）
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
      `需求覆盖率 ${covBar} ${coveragePercent}%`,
      `测试覆盖率 ${testBar} ${testPct}%`,
      `差距: ${highGaps} high / ${mediumGaps} medium`,
    ].join('\n'),
    _hint: '请将仪表盘展示在最前面',
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
  const activeStories = storyIds.filter(id => {
    const story = store.readStory(id);
    return story.phase !== 'META' && !terminalPhases.has(story.phase);
  });
  const auditFindings = store.readFindings(AUDIT_STORY_ID).findings.filter(f => f.status === 'open');
  const blockingAuditFindings = auditFindings.filter(isBlockingAuditFinding);
  const advisoryAuditFindings = auditFindings.filter(f => !isBlockingAuditFinding(f));

  const checks: ConvergenceResult['checks'] = [];

  // 1. No high-severity gaps
  const highGaps = gap.gaps.filter(g => g.severity === 'high');
  checks.push({
    name: '无高优先级差距',
    passed: highGaps.length === 0,
    detail: highGaps.length === 0 ? '所有需求已覆盖' : `${highGaps.length} 个高优先级差距待解决`,
  });

  // 2. All flows valid
  checks.push({
    name: 'Flow 链路完整',
    passed: flowValidation.passed,
    detail: flowValidation.passed ? `${chains.length} 条链路全部通过` : `${flowValidation.issues.filter(i => i.level === 'error').length} 个 flow 错误`,
  });

  // 3. Code annotations valid
  checks.push({
    name: '代码注释合规',
    passed: codeValidation.passed,
    detail: codeValidation.passed ? `${codeValidation.tasksFound} 个注释全部合规` : `${codeValidation.errors.length} 个注释错误`,
  });

  // 4. All stories DONE
  checks.push({
    name: '所有 Story 完成',
    passed: activeStories.length === 0,
    detail: activeStories.length === 0 ? '无未完成业务 Story' : `${activeStories.length} 个 Story 未完成: ${activeStories.join(', ')}`,
  });

  // 5. Audit backlog
  checks.push({
    name: 'Audit backlog',
    passed: blockingAuditFindings.length === 0,
    detail: auditFindings.length === 0
      ? '无 open audit findings'
      : [
        `${blockingAuditFindings.length} blocking`,
        blockingAuditFindings.length > 0 ? blockingAuditFindings.map(formatAuditFinding).join(', ') : null,
        `${advisoryAuditFindings.length} advisory`,
        advisoryAuditFindings.length > 0 ? advisoryAuditFindings.map(formatAuditFinding).join(', ') : null,
      ].filter(Boolean).join('; '),
  });

  // 6. Requirements coverage
  checks.push({
    name: '需求覆盖率',
    passed: gap.coveragePercent === 100,
    detail: `${gap.coveragePercent}%`,
  });

  return {
    converged: checks.every(c => c.passed),
    checks,
  };
}
