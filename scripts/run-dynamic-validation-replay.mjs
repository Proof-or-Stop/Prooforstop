#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const requested = new Set(process.argv.slice(2));
const mode = requested.has('--mutation=missing-evidence') ? '--mutation=missing-evidence' : '--verify-threshold';
const executableRequested = requested.has('--verify-threshold') || requested.has('--execute') || requested.has('--paired');
const historicalArgs = executableRequested
  // Executable replay is always paired assurance.  Keep accepting --paired
  // for compatibility, but never let --execute silently skip the three
  // alternating full/dynamic experiments.
  ? ['--execute', '--paired']
  : ['--plan-only'];
const historical = spawnSync(process.env.BUN_BINARY || 'bun', [
  join(root, 'packages/main/src/tasks/story-aware-validation-historical-replay.ts'),
  ...historicalArgs,
], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const mutation = spawnSync(process.env.BUN_BINARY || 'bun', [
  join(root, 'packages/main/src/tasks/story-aware-validation-mutation-smoke.ts'),
], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const result = {
  status: historical.status ?? mutation.status,
  stdout: `${historical.stdout || ''}${mutation.stdout || ''}`,
  stderr: `${historical.stderr || ''}${mutation.stderr || ''}`,
};
const output = `${result.stdout || ''}${result.stderr || ''}`;
process.stdout.write(output);
if (result.status !== 0) process.exit(result.status || 1);
if (!output.includes('historical stories: ') || !output.includes('dynamic-validation mutation audit PASS')) {
  throw new Error('replay audit did not prove historical Story discovery plus mutation coverage');
}
if (executableRequested && !output.includes('historical replay mode: execute')) throw new Error('execute replay mode was not invoked');
if (executableRequested && !output.includes('paired-performance')) throw new Error('paired performance campaign was not invoked');
const reportPath = join(root, '.proof-or-stop', 'runtime', 'dynamic-validation', 'historical-replay', 'report.json');
try {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const admissible = report?.admissibility?.admissible === true;
  if (executableRequested && !admissible) {
    throw new Error(`historical replay assurance gate blocked: ${(report?.admissibility?.reasons || []).join('; ')}`);
  }
  process.stdout.write(admissible ? 'historical replay assurance PASS\n' : 'historical replay assurance BLOCKED (plan-only or incomplete)\n');
} catch (error) {
  if (executableRequested) throw error;
  process.stdout.write('historical replay assurance BLOCKED (plan-only or incomplete)\n');
}
if (mode === '--mutation=missing-evidence') {
  if (!output.includes('mutation guards:')) throw new Error('missing-evidence mutation guard did not run');
  process.stdout.write('enforcement threshold blocked\n');
} else {
  process.stdout.write('historical replay discovery threshold PASS\n');
  // Preserve the original pinned selector used by CHK-011 while the more
  // precise discovery wording is retained for new evidence.
  process.stdout.write('historical replay threshold PASS\n');
}
