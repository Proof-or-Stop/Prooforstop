#!/usr/bin/env node

import { StoryStore } from '../packages/main/dist/core/store.js';
import { analyzeGap, checkConvergence } from '../packages/main/dist/tasks/gap-analyze.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const repoRoot = '/Users/jek/Documents/Work/Orchestrate';
const store = new StoryStore(repoRoot);
const gap = analyzeGap(repoRoot, store);
assert(typeof gap._dashboard === 'string' && gap._dashboard.includes('需求覆盖率'), 'gap dashboard missing');
assert(typeof gap.coveragePercent === 'number' && gap.coveragePercent >= 90, 'gap coverage percent regressed');
assert(Array.isArray(gap.gaps) && gap.gaps.some((item) => item.type === 'uncovered_requirement'), 'gap output missing uncovered requirement');
assert(Array.isArray(gap.gaps) && gap.gaps.some((item) => item.type === 'no_test'), 'gap output missing no_test backlog');
assert(!gap.gaps.some((item) => String(item.description).includes('silent catch **不能全删**')), 'fail-fast requirement regressed into uncovered_requirement');

const convergence = checkConvergence(repoRoot, store);
assert(convergence && Array.isArray(convergence.checks), 'convergence_check missing checks array');
const flowCheck = convergence.checks.find((check) => check.name === 'Flow 链路完整');
const annotationCheck = convergence.checks.find((check) => check.name === '代码注释合规');
const coverageCheck = convergence.checks.find((check) => check.name === '需求覆盖率');
assert(flowCheck?.passed === true, 'flow completeness check regressed');
assert(annotationCheck?.passed === true, 'annotation validation check regressed');
assert(typeof coverageCheck?.detail === 'string' && coverageCheck.detail === '90%', 'coverage detail drifted unexpectedly');
assert(convergence.converged === false, 'project should not be marked fully converged yet');

console.log('gap convergence verified');
