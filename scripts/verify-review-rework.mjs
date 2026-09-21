#!/usr/bin/env node
// Exact Lab RED/GREEN entry: rebuild before executing production dist consumers.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error || result.signal) throw result.error ?? new Error(`child signaled: ${result.signal}`);
  return result.status ?? 1;
};
if (run(process.execPath, ['scripts/ensure-dist.mjs']) !== 0) process.exit(1);
const results = [
  run(process.execPath, ['scripts/verify-review-inventory-identity.mjs']),
  run(process.execPath, ['packages/main/dist/tasks/review-incremental-context-smoke.js', '--large-inventory-only']),
  run(process.execPath, ['scripts/run-validation-fixture-suite.mjs', 'packages/main/dist/tasks/review-inventory-epoch-smoke.js']),
];
if (results.some(code => code !== 0)) { console.error('REVIEW_REWORK_REGRESSION_FAILED ' + JSON.stringify(results)); process.exit(1); }
console.log('REVIEW_REWORK_REGRESSIONS PASS');

const { runProviderNeutralFixture } = await import('./helpers/provider-neutral-fixture.mjs');
const { createFixtureMachineEnvironment } = await import('../packages/main/dist/tasks/helpers/fixture-machine-environment.js');
const fixture = createFixtureMachineEnvironment();
const env = { ...fixture.env, CODEX_THREAD_ID: '', CLAUDECODE: '' };
delete env.PROOF_OR_STOP_VALIDATION_RESERVATION_FD;
const native = await runProviderNeutralFixture('packages/main/dist/tasks/review-inventory-handler-smoke.js', ['--roster-only'], env, { timeoutMs: 600000 });
if (native.status !== 0 || native.signal) { console.error('Native fixture retained:', fixture.root); process.exit(1); }
fixture.cleanup();
console.log('REVIEW_REWORK_NATIVE_ROSTER PASS');
