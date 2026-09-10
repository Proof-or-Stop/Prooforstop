import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const run = spawnSync(process.execPath, ['packages/main/dist/tasks/review-inventory-handler-smoke.js', '--progress-capture-fixture', '--effective-progress-fixture', '--burn-fixture', '--burn-close-fixture'], { encoding: 'utf8', timeout: 840_000, maxBuffer: 8 * 1024 * 1024 });
process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
assert.equal(run.status, 0, 'managed burn close fixture failed; inspect the preceding concrete assertion');
assert.match(run.stdout, /PASS U15 actual managed provider stopped after verified stagnation and reaped/);
