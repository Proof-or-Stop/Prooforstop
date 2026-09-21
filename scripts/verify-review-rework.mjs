#!/usr/bin/env node
// Exact Lab RED/GREEN entry: rebuild before executing production dist consumers.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error || result.signal) throw result.error ?? new Error(`child signaled: ${result.signal}`);
  return result.status ?? 1;
};
if (run(process.execPath, ['scripts/ensure-dist.mjs']) !== 0) process.exit(1);
// Release preparation rebinds version-dependent static evidence. Check the
// actual candidate on every replay; the committed archive is historical.
if (run(process.execPath, ['scripts/verify-validation-static-edges.mjs']) !== 0) process.exit(1);
const staticInputs = [
  'scripts/lab/u18-static-edges/exceptions.json',
  'package.json', 'package-lock.json',
  'packages/main/package.json', 'packages/main/package-lock.json',
  'packages/lab/package-lock.json', 'packages/utils/package-lock.json',
  'packages/main/src/core/proof-or-stop-brand.ts',
];
console.log('REVIEW_REWORK_STATIC_BINDING PASS ' + JSON.stringify({
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
  sha256: Object.fromEntries(staticInputs.map(path => [path, createHash('sha256').update(readFileSync(new URL('../' + path, import.meta.url))).digest('hex')])),
}));
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
