#!/usr/bin/env node

import { execFileSync } from 'child_process';

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const reportRaw = execFileSync('node', ['-e', `
  import { loadConfig } from './packages/main/dist/core/config.js';
  import { scan, extractFlows } from './packages/main/dist/tasks/extract.js';
  import { validate, validateFlows } from './packages/main/dist/tasks/validate.js';
  import { join } from 'path';

  const root = process.cwd();
  const config = loadConfig(root);
  const scanRoot = join(root, config.scanRoot);
  const tasks = scan(scanRoot);
  const chains = extractFlows(tasks);
  const flow = chains.find((c) => c.name === 'story-lifecycle');
  const flowIssues = validateFlows(chains, tasks).issues.filter((i) => i.flow === 'story-lifecycle');
  const codeErrors = validate(scanRoot).errors.filter((i) => i.loc.startsWith('src/handlers/summary.ts'));
  console.log(JSON.stringify({ flow, flowIssues, codeErrors }, null, 2));
`], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
});

const report = JSON.parse(reportRaw);
assert(report.flow, 'story-lifecycle flow not found');
assert(report.flow.complete === true, 'story-lifecycle flow is still incomplete');
assert(Array.isArray(report.flow.steps) && report.flow.steps.map((step) => step.step).join(',') === '1,2,3,4,5', 'story-lifecycle steps are not 1→2→3→4→5');
assert(Array.isArray(report.flowIssues) && report.flowIssues.length === 0, 'story-lifecycle still has flow validation issues');
assert(Array.isArray(report.codeErrors) && report.codeErrors.length === 0, 'summary.ts still has annotation validation errors');

console.log('flow annotation repair verified');
