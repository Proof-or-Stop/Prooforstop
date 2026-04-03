
import { readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { walkDir, extractBlocks, parseBlock, parseFunctionAfterBlock } from './extract.js';
import { loadConfig } from '../config.js';
import type { FlowChain, FlowValidationIssue, FlowValidationResult, TaskAnnotation, ValidationIssue, ValidationResult } from './types.js';

const REQUIRED_FIELDS = ['task', 'checklist', 'title', 'type', 'priority', 'description', 'changes'];

const VALID_VALUES: Record<string, string[]> = {
  type: ['feature', 'bugfix', 'refactor', 'chore'],
  priority: ['critical', 'high', 'medium', 'low'],
  scope: ['file', 'module', 'function', 'block'],
};

/** 校验单个注释块 */
function validateBlock(
  parsed: Record<string, string | string[]>,
  filePath: string,
  line: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const loc = `${filePath}:${line}`;

  // 必填字段
  for (const field of REQUIRED_FIELDS) {
    const val = parsed[field];
    if (!val || (Array.isArray(val) && val.length === 0)) {
      issues.push({ loc, level: 'error', msg: `missing required field: @${field}` });
    }
  }

  // 枚举值
  for (const [field, allowed] of Object.entries(VALID_VALUES)) {
    if (parsed[field] && typeof parsed[field] === 'string' && !allowed.includes(parsed[field] as string)) {
      issues.push({
        loc,
        level: 'error',
        msg: `invalid @${field}: "${parsed[field]}" (allowed: ${allowed.join(', ')})`,
      });
    }
  }

  // task ID 格式
  if (parsed.task && typeof parsed.task === 'string' && !/^[A-Z][\w-]+$/.test(parsed.task)) {
    issues.push({
      loc,
      level: 'warn',
      msg: `@task ID "${parsed.task}" format unusual (expected: B-001, ADHOC-xxx, TOOL-001)`,
    });
  }

  // description 不能太短
  if (parsed.description && typeof parsed.description === 'string') {
    if (parsed.description.length < 10) {
      issues.push({ loc, level: 'warn', msg: `@description too short (${parsed.description.length} chars)` });
    }
  }

  return issues;
}

/** 扫描并校验所有文件 */
export function validate(scanRoot: string): ValidationResult {
  let files: string[];
  try {
    files = walkDir(scanRoot);
  } catch {
    return {
      filesScanned: 0,
      tasksFound: 0,
      errors: [],
      warnings: [],
      filesWithoutTask: [],
      passed: true,
    };
  }

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  let tasksFound = 0;
  const filesWithoutTask: string[] = [];

  for (const filePath of files) {
    const rel = relative(scanRoot, filePath);
    const content = readFileSync(filePath, 'utf-8');
    const blocks = extractBlocks(content);

    if (blocks.length === 0) {
      filesWithoutTask.push(rel);
      continue;
    }

    for (const { raw, line, endIndex } of blocks) {
      const parsed = parseBlock(raw);
      if (!parsed.task) continue;
      tasksFound++;

      const issues = validateBlock(parsed, rel, line);
      for (const issue of issues) {
        if (issue.level === 'error') {
          errors.push(issue);
        } else {
          warnings.push(issue);
        }
      }

      // CHK-005: file-level @task with @test → warning
      const fnInfo = parseFunctionAfterBlock(content, endIndex);
      if (!fnInfo && parsed.test) {
        warnings.push({
          loc: `${rel}:${line}`,
          level: 'warn',
          msg: `文件级 @task 不应含 @test（${parsed.test}），请移到函数级 @task 块`,
        });
      }
      // CHK-001 / CHK-002: check @test on function-level annotations
      if (fnInfo) {
        const functionName = fnInfo.functionName;
        const loc = `${rel}:${line}`;
        if (!parsed.test) {
          if (parsed.flow) {
            // CHK-002: flow function missing @test → error
            errors.push({
              loc,
              level: 'error',
              msg: `flow function ${functionName} missing @test annotation (flow: ${parsed.flow})`,
            });
          } else {
            // CHK-001: regular function missing @test → warning
            warnings.push({
              loc,
              level: 'warn',
              msg: `function ${functionName} missing @test annotation`,
            });
          }
        }
      }
    }
  }

  return {
    filesScanned: files.length,
    tasksFound,
    errors,
    warnings,
    filesWithoutTask,
    passed: errors.length === 0,
  };
}

export function validateFlows(chains: FlowChain[], allTasks: TaskAnnotation[]): FlowValidationResult {
  const issues: FlowValidationIssue[] = [];

  // Build a map of functionName → task for @next existence checks
  const functionNames = new Set<string>();
  for (const t of allTasks) {
    if (t.functionName) functionNames.add(t.functionName);
  }

  // Build a map of functionName → flow name for cross-checking
  const fnToFlow = new Map<string, string>();
  for (const t of allTasks) {
    if (t.flow && t.functionName) {
      fnToFlow.set(t.functionName, t.flow);
    }
  }

  for (const chain of chains) {
    const { name, steps } = chain;

    if (steps.length === 0) continue;

    // Check step continuity (must be 1, 2, 3, ...)
    const stepNums = steps.map(s => s.step);
    const sorted = [...stepNums].sort((a, b) => a - b);

    if (sorted[0] !== 1) {
      issues.push({
        flow: name,
        step: sorted[0],
        level: 'error',
        msg: `flow "${name}" starts at step ${sorted[0]}, expected 1`,
        loc: `${steps[0].sourceFile}:${steps[0].sourceLine}`,
      });
    }

    // Check for gaps and duplicates
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1]) {
        issues.push({
          flow: name,
          step: sorted[i],
          level: 'error',
          msg: `flow "${name}" has duplicate step ${sorted[i]}`,
          loc: steps.find(s => s.step === sorted[i])?.sourceFile + ':' + steps.find(s => s.step === sorted[i])?.sourceLine,
        });
      } else if (sorted[i] !== sorted[i - 1] + 1) {
        issues.push({
          flow: name,
          level: 'error',
          msg: `flow "${name}" has gap between step ${sorted[i - 1]} and ${sorted[i]}`,
          loc: steps.find(s => s.step === sorted[i])?.sourceFile + ':' + steps.find(s => s.step === sorted[i])?.sourceLine,
        });
      }
    }

    // Build a map of functionName → TaskAnnotation for @test checks
    const fnToTask = new Map<string, TaskAnnotation>();
    for (const t of allTasks) {
      if (t.functionName) fnToTask.set(t.functionName, t);
    }

    // Check @test coverage for each step
    for (const step of steps) {
      const task = fnToTask.get(step.functionName);
      if (!task || !task.test) {
        issues.push({
          flow: name,
          step: step.step,
          level: 'error',
          msg: `Step ${step.step} function "${step.functionName}" missing @test annotation`,
          loc: `${step.sourceFile}:${step.sourceLine}`,
        });
      }
    }

    // Check @next for each step
    const sortedSteps = [...steps].sort((a, b) => a.step - b.step);
    for (let i = 0; i < sortedSteps.length; i++) {
      const step = sortedSteps[i];
      const isLast = i === sortedSteps.length - 1;
      const loc = `${step.sourceFile}:${step.sourceLine}`;

      if (isLast) {
        // Last step should NOT have @next
        if (step.next) {
          issues.push({
            flow: name,
            step: step.step,
            level: 'warn',
            msg: `flow "${name}" step ${step.step} is the last step but has @next "${step.next}"`,
            loc,
          });
        }
      } else {
        // Non-last steps MUST have @next
        if (!step.next) {
          issues.push({
            flow: name,
            step: step.step,
            level: 'error',
            msg: `flow "${name}" step ${step.step} is not the last step but missing @next`,
            loc,
          });
        } else {
          // Check @next target exists
          if (!functionNames.has(step.next)) {
            // Try to find a close match for suggestion
            const candidates = [...functionNames].filter(fn =>
              fn.toLowerCase().includes(step.next!.toLowerCase()) ||
              step.next!.toLowerCase().includes(fn.toLowerCase())
            );
            const suggestion = candidates.length > 0 ? ` (did you mean: ${candidates.join(', ')}?)` : '';
            issues.push({
              flow: name,
              step: step.step,
              level: 'error',
              msg: `flow "${name}" step ${step.step} @next "${step.next}" not found${suggestion}`,
              loc,
            });
          } else {
            // Check @next target has same @flow name
            const targetFlow = fnToFlow.get(step.next);
            if (targetFlow && targetFlow !== name) {
              issues.push({
                flow: name,
                step: step.step,
                level: 'warn',
                msg: `flow "${name}" step ${step.step} @next "${step.next}" belongs to flow "${targetFlow}", not "${name}"`,
                loc,
              });
            }
          }
        }
      }
    }
  }

  return {
    flows: chains,
    issues,
    passed: issues.filter(i => i.level === 'error').length === 0,
  };
}

export function validateTestAnnotations(
  tasks: TaskAnnotation[],
  projectRoot: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const t of tasks) {
    if (!t.test) continue;
    const fixturePath = join(projectRoot, loadConfig(projectRoot).fixturesDir, t.test + '.json');
    const loc = `${t.sourceFile}:${t.sourceLine}`;
    try {
      statSync(fixturePath);
    } catch {
      issues.push({
        loc,
        level: 'warn',
        msg: `@test fixture not found: tests/fixtures/${t.test}.json`,
      });
    }
  }

  return issues;
}
