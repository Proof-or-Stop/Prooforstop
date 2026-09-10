import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const run = spawnSync(process.execPath, ['packages/main/dist/tasks/review-inventory-handler-smoke.js', '--progress-capture-fixture', '--effective-progress-fixture'], { encoding: 'utf8', timeout: 840_000, maxBuffer: 8 * 1024 * 1024 });
process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
assert.equal(run.status, 0, 'U11 two actual completed stagnant epochs must gate both entry points');
assert.match(run.stdout, /PASS U11 two actual complete stagnant epochs gate both entries and one signed decision resumes/);
