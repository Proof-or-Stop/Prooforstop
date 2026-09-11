import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const run = spawnSync(process.execPath, ['packages/main/dist/tasks/review-incremental-context-smoke.js', '--asof-run-only'], { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
assert.equal(run.status, 0, 'U09 historical review replay and current admission boundary');
assert.match(run.stdout, /AS-OF-RUN ELIGIBILITY/);
