import assert from 'node:assert/strict';
import { runProviderNeutralFixture } from './helpers/provider-neutral-fixture.mjs';
import { spawnSync } from 'node:child_process';
const binding = spawnSync(process.execPath, ['scripts/verify-inventory-consumer-binding.mjs'], { stdio: 'inherit' });
assert.equal(binding.status, 0, 'inventory consumer binding failed; inspect concrete refusal above');
const results = [];
for (const remediation of [false, true]) {
  const started = performance.now();
  const run = await runProviderNeutralFixture('packages/main/dist/tasks/review-inventory-handler-smoke.js', [
    '--progress-capture-fixture', '--next-action-fixture',
    ...(remediation ? ['--metadata-remediation-fixture'] : []),
  ], process.env, { timeoutMs: 600000 });
  results.push({ remediation, exitCode: run.status, signal: run.signal, elapsedMs: performance.now() - started });
}
console.log(`INVENTORY_NEXT_ACTION_RUNS ${JSON.stringify(results)}`);
assert.ok(results.every(row => row.exitCode === 0 && !row.signal), 'inventory fixture failed: inspect its specific assertion; setup failure is not target RED');
console.log('PASS inventory next action: both real CLI authority branches');
