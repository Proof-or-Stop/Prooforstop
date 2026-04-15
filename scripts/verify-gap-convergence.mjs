#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { join } from 'path';

const root = process.cwd();
const repoRoot = '/Users/jek/Documents/Work/Orchestrate';
const cli = join(repoRoot, 'bin', 'koala-codex.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, payload) {
  const args = [cli, command];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  const text = execFileSync('node', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`no JSON object found in ${command} output`);
  return JSON.parse(text.slice(start));
}

const gap = run('gap_analyze', { format: 'markdown' });
assert(typeof gap._dashboard === 'string' && gap._dashboard.includes('需求覆盖率'), 'gap dashboard missing');
assert(typeof gap.coveragePercent === 'number' && gap.coveragePercent >= 90, 'gap coverage percent regressed');
assert(Array.isArray(gap.gaps) && gap.gaps.some((item) => item.type === 'uncovered_requirement'), 'gap output missing uncovered requirement');
assert(Array.isArray(gap.gaps) && gap.gaps.some((item) => item.type === 'no_test'), 'gap output missing no_test backlog');
assert(!gap.gaps.some((item) => String(item.description).includes('silent catch **不能全删**')), 'fail-fast requirement regressed into uncovered_requirement');

const convergence = run('convergence_check');
assert(convergence && Array.isArray(convergence.checks), 'convergence_check missing checks array');
const flowCheck = convergence.checks.find((check) => check.name === 'Flow 链路完整');
const annotationCheck = convergence.checks.find((check) => check.name === '代码注释合规');
const coverageCheck = convergence.checks.find((check) => check.name === '需求覆盖率');
assert(flowCheck?.passed === true, 'flow completeness check regressed');
assert(annotationCheck?.passed === true, 'annotation validation check regressed');
assert(typeof coverageCheck?.detail === 'string' && coverageCheck.detail === '90%', 'coverage detail drifted unexpectedly');
assert(convergence.converged === false, 'project should not be marked fully converged yet');

console.log('gap convergence verified');
