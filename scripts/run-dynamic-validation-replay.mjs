#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const requested = new Set(process.argv.slice(2));
const mutationOnly = requested.has('--mutation=missing-evidence');
const verifyThreshold = requested.has('--verify-threshold');
const executeRequested = requested.has('--execute');
const pairedRequested = requested.has('--paired');
const repairMissingRequested = requested.has('--repair-missing');
if (verifyThreshold && executeRequested) throw new Error('--verify-threshold verifies an existing artifact; run --execute separately to produce one');
if (verifyThreshold && pairedRequested) throw new Error('--verify-threshold cannot be combined with --paired');
if (pairedRequested && !executeRequested) throw new Error('--paired requires explicit --execute');
if (repairMissingRequested && !executeRequested) throw new Error('--repair-missing requires explicit --execute');

const bun = process.env.BUN_BINARY || 'bun';
const artifactVerifierTask = join(root, 'packages/main/src/tasks/story-aware-validation-historical-replay-artifact-verify.ts');
const historicalReplayTask = join(root, 'packages/main/src/tasks/story-aware-validation-historical-replay.ts');
const mutationTask = join(root, 'packages/main/src/tasks/story-aware-validation-mutation-smoke.ts');
const run = (task, args = []) => spawnSync(bun, [task, ...args], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
const subprocessStatus = (child) => child.status === 0 ? 0 : (child.status || 1);
const childOutput = (child) => `${child.stdout || ''}${child.stderr || ''}`;
const failFrom = (child) => {
  process.stdout.write(childOutput(child));
  process.exit(subprocessStatus(child));
};

// The immutable CHK-011 threshold pin is deliberately admission-only.  It
// proves an already-persisted, signed current-source replay artifact and never
// starts a historical campaign as a side effect.  A missing, stale or tampered
// artifact therefore fails closed instead of quietly producing replacement
// evidence.  `--execute` below is the only producer path.
if (verifyThreshold) {
  const artifact = run(artifactVerifierTask);
  if (subprocessStatus(artifact) !== 0) failFrom(artifact);
  const mutation = run(mutationTask);
  if (subprocessStatus(mutation) !== 0) failFrom(mutation);
  const output = childOutput(artifact) + childOutput(mutation);
  process.stdout.write(output);
  if (!output.includes('historical replay artifact admission PASS') || !output.includes('dynamic-validation mutation audit PASS')) {
    throw new Error('verify-threshold did not prove signed replay admission plus mutation coverage');
  }
  process.stdout.write('historical replay assurance PASS\n');
  process.stdout.write('historical replay discovery threshold PASS\n');
  // Preserve the immutable selector already pinned on CHK-011.
  process.stdout.write('historical replay threshold PASS\n');
  process.exit(0);
}

// The missing-evidence mutation proves a local fail-closed condition.  It must
// not scan the historical corpus: the current signed paired replay report is
// earned by the explicit executable modes above, and a negative mutation does
// not need to rediscover or re-execute those records.
if (mutationOnly) {
  const mutation = run(mutationTask);
  process.stdout.write(childOutput(mutation));
  if (subprocessStatus(mutation) !== 0) process.exit(subprocessStatus(mutation));
  if (!childOutput(mutation).includes('mutation guards:')) throw new Error('missing-evidence mutation guard did not run');
  process.stdout.write('enforcement threshold blocked\n');
  process.exit(0);
}

const historical = run(historicalReplayTask, executeRequested
  ? ['--execute', '--paired', '--resume', '--repair-missing']
  : ['--plan-only']);
if (subprocessStatus(historical) !== 0) failFrom(historical);
const mutation = run(mutationTask);
if (subprocessStatus(mutation) !== 0) failFrom(mutation);
process.stdout.write(childOutput(historical) + childOutput(mutation));
if (!childOutput(historical).includes('historical stories: ') || !childOutput(mutation).includes('dynamic-validation mutation audit PASS')) {
  throw new Error('replay audit did not prove historical Story discovery plus mutation coverage');
}

if (!executeRequested) {
  process.stdout.write('historical replay assurance BLOCKED (plan-only or incomplete)\n');
  process.exit(0);
}

const artifact = run(artifactVerifierTask);
if (subprocessStatus(artifact) !== 0) failFrom(artifact);
process.stdout.write(childOutput(artifact));
if (!childOutput(artifact).includes('historical replay artifact admission PASS')) {
  throw new Error('execute replay did not produce an admissible signed artifact');
}
process.stdout.write('historical replay assurance PASS\n');
