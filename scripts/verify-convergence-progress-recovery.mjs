import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const run = spawnSync(process.execPath, ['packages/main/dist/tasks/review-inventory-handler-smoke.js', '--progress-capture-fixture', '--progress-recovery-fixture'], { encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
assert.equal(run.status, 0, 'U11 finalize retry must recover missing verified observation');
assert.match(run.stdout, /PASS U11 finalize retry recovers one verified observation/);
