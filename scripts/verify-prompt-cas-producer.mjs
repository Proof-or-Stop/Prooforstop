import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const run = spawnSync(process.execPath, ['packages/main/dist/tasks/review-inventory-handler-smoke.js', '--progress-capture-fixture', '--prompt-cas-fixture'], { encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
assert.equal(run.status, 0, 'prompt CAS producer fixture failed; inspect the concrete assertion above');
assert.match(run.stdout, /PASS U12 actual reviewer run stores a body reference and retains native review authority/);
