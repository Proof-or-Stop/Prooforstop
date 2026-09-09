// Explicit fixture entrypoints only. Real machine-admission witnesses are excluded.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createFixtureMachineEnvironment } from '../packages/main/dist/tasks/helpers/fixture-machine-environment.js';

export const FIXTURE_ENTRIES = new Set([
  'packages/main/dist/tasks/tool-executed-evidence-receipt-smoke.js',
  'packages/main/dist/tasks/validate-command-timeout-smoke.js',
  'packages/main/dist/tasks/validate-focused-full-layering-smoke.js',
  'packages/main/dist/tasks/done-required-validation-smoke.js',
  'packages/main/dist/tasks/validate-parallel-equivalence-smoke.js',
  'packages/main/dist/tasks/validation-protocol-smoke.js',
  'packages/main/tests/red/red-B-7dff-sequential-validate-plan.mjs',
  'packages/main/tests/validate-plan-scheduling.test.mjs',
  'packages/main/tests/validate-pollution-attribution.test.mjs',
  'packages/main/tests/red/red-w2d-command-readonly.mjs',
]);

const [entry, ...rest] = process.argv.slice(2);
assert.ok(FIXTURE_ENTRIES.has(entry), 'expected one registered validation fixture entry');
assert.deepEqual(rest, entry.endsWith('/red-w2d-command-readonly.mjs') ? ['--canonical-core'] : [], 'registered fixture arguments');
const fixture = createFixtureMachineEnvironment();
const result = spawnSync(process.execPath, [entry, ...rest], { env: fixture.env, stdio: 'inherit' });
if (result.status === 0) {
  fixture.cleanup();
} else {
  console.error(`fixture machine retained for diagnosis: ${fixture.root}`);
  if (result.error) console.error(result.error.message);
  if (result.signal) console.error(`fixture terminated by ${result.signal}`);
}
process.exitCode = result.status ?? 1;
