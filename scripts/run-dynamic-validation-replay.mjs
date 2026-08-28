#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const requested = new Set(process.argv.slice(2));
const mode = requested.has('--mutation=missing-evidence') ? '--mutation=missing-evidence' : '--verify-threshold';
const mutationOnly = mode === '--mutation=missing-evidence';
const executableRequested = requested.has('--verify-threshold') || requested.has('--execute') || requested.has('--paired');
// The pinned threshold command is an enforcement path, not a diagnostic.
// It must complete a bounded interrupted campaign so it can emit its required
// selector, while still reusing every admissible signed historical record.
// A documented executable mode is a completion-capable assurance campaign.
// It may reuse signed historical records, but it must repair the missing or
// incompatible remainder instead of stopping at the first gap.  Keep the
// explicit flag for callers of the underlying task and for clarity in logs.
const repairMissingRequested = executableRequested || requested.has('--repair-missing');
if (repairMissingRequested && !executableRequested) throw new Error('--repair-missing requires an executable replay mode');
const historicalArgs = executableRequested
  // Executable replay is always paired assurance.  Keep accepting --paired
  // for compatibility, but never let --execute silently skip the three
  // alternating full/dynamic experiments. `--resume` validates durable,
  // signed historical receipts first, so an interrupted final paired campaign
  // replays only missing or incompatible historical cases.
  ? ['--execute', '--paired', '--resume', ...(repairMissingRequested ? ['--repair-missing'] : [])]
  : ['--plan-only'];
// The missing-evidence mutation proves a local fail-closed condition.  It must
// not scan the historical corpus: the current signed paired replay report is
// earned by the explicit executable modes above, and a negative mutation does
// not need to rediscover or re-execute those records.
const historical = mutationOnly
  ? { status: 0, stdout: '', stderr: '' }
  : spawnSync(process.env.BUN_BINARY || 'bun', [
    join(root, 'packages/main/src/tasks/story-aware-validation-historical-replay.ts'),
    ...historicalArgs,
  ], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const mutation = spawnSync(process.env.BUN_BINARY || 'bun', [
  join(root, 'packages/main/src/tasks/story-aware-validation-mutation-smoke.ts'),
], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const subprocessStatus = (child) => child.status === 0 ? 0 : (child.status || 1);
const result = {
  // `status ??` let the synthetic successful historical placeholder mask a
  // failing mutation probe. Both pieces are required assurance, so propagate
  // the first non-zero status fail-closed (historical before mutation).
  status: subprocessStatus(historical) || subprocessStatus(mutation),
  stdout: `${historical.stdout || ''}${mutation.stdout || ''}`,
  stderr: `${historical.stderr || ''}${mutation.stderr || ''}`,
};
const output = `${result.stdout || ''}${result.stderr || ''}`;
process.stdout.write(output);
if (result.status !== 0) process.exit(result.status || 1);
if ((!mutationOnly && !output.includes('historical stories: ')) || !output.includes('dynamic-validation mutation audit PASS')) {
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
