// Explicit fixture entrypoints only. Real machine-admission witnesses are excluded.
import assert from 'node:assert/strict';
import { runProviderNeutralFixture } from './helpers/provider-neutral-fixture.mjs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFixtureMachineEnvironment, inspectFixtureCompileCache } from '../packages/main/dist/tasks/helpers/fixture-machine-environment.js';

export const FIXTURE_ENTRIES = new Set([
  'packages/main/dist/tasks/withdrawn-disposition-smoke.js',
  'packages/main/dist/tasks/quorum-submit-smoke.js',
  'packages/main/dist/tasks/verification-run-and-guard-smoke.js',
  'packages/main/dist/tasks/done-required-head-drift-proof.js',
  'packages/main/dist/tasks/post-done-closure-snapshot-smoke.js',
  'packages/main/dist/tasks/validate-progress-heartbeat-smoke.js',
  'packages/main/dist/tasks/narrowing-repin-smoke.js',
  'packages/main/dist/tasks/review-inventory-epoch-smoke.js',

  'packages/main/dist/tasks/flow-stability-smoke.js',
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
  'packages/main/tests/red/red-b49d4-registration-derivation.mjs',
]);

const [entry, ...rest] = process.argv.slice(2);
assert.ok(FIXTURE_ENTRIES.has(entry), 'expected one registered validation fixture entry');
assert.deepEqual(rest, (entry.endsWith('/red-w2d-command-readonly.mjs') || entry.endsWith('/flow-stability-smoke.js')) ? ['--canonical-core'] : entry.endsWith('/quorum-submit-smoke.js') && rest.length > 0 ? ['--jobs=2'] : [], 'registered fixture arguments');
const fixture = createFixtureMachineEnvironment();
const env = { ...fixture.env, PROOF_OR_STOP_HEALTH_PATH: join(fixture.root, 'health.jsonl') };
delete env.LATTICE_HEALTH_PATH;
// This fixture exercises both native host families with real broker signatures.
// The ambient Codex/Claude owner must not become its simulated host ancestry.
const result = entry.endsWith('/quorum-submit-smoke.js')
  ? await runProviderNeutralFixture(entry, rest, env)
  : spawnSync(process.execPath, [entry, ...rest], { env, stdio: 'inherit' });
if (entry.endsWith('/quorum-submit-smoke.js') || entry.endsWith('/validate-progress-heartbeat-smoke.js')) {
  console.log('FIXTURE_COMPILE_CACHE ' + JSON.stringify(inspectFixtureCompileCache(join(fixture.root, 'node-compile-cache'))));
}
if (result.status === 0) {
  fixture.cleanup();
} else {
  console.error(`fixture machine retained for diagnosis: ${fixture.root}`);
  if (result.error) console.error(result.error.message);
  if (result.signal) console.error(`fixture terminated by ${result.signal}`);
}
process.exitCode = result.status ?? 1;
