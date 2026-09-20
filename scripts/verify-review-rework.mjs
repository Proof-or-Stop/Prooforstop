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
if (run('npm', ['--prefix', 'packages/main', 'run', 'build']) !== 0) process.exit(1);
const results = [
  run(process.execPath, ['packages/main/dist/tasks/review-incremental-context-smoke.js', '--large-inventory-only']),
  run(process.execPath, ['scripts/run-validation-fixture-suite.mjs', 'packages/main/dist/tasks/review-inventory-epoch-smoke.js']),
];
if (results.some(code => code !== 0)) { console.error('REVIEW_REWORK_REGRESSION_FAILED ' + JSON.stringify(results)); process.exit(1); }
console.log('REVIEW_REWORK_REGRESSIONS PASS');
