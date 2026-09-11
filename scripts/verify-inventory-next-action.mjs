import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const results = [];
for (const remediation of [false, true]) {
  const started = performance.now();
  const run = spawnSync(process.execPath, [
    'packages/main/dist/tasks/review-inventory-handler-smoke.js',
    '--progress-capture-fixture', '--next-action-fixture',
    ...(remediation ? ['--metadata-remediation-fixture'] : []),
  ], { encoding: 'utf8', timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
  results.push({ remediation, exitCode: run.status, signal: run.signal, elapsedMs: performance.now() - started });
}
console.log(`INVENTORY_NEXT_ACTION_RUNS ${JSON.stringify(results)}`);
assert.ok(results.every(row => row.exitCode === 0 && !row.signal), 'INVENTORY_NEXT_ACTION_AUTHORITY_MISMATCH');
console.log('PASS inventory next action: both real CLI authority branches');
