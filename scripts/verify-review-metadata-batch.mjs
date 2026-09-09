import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const run = spawnSync(process.execPath, ['packages/main/dist/tasks/review-inventory-handler-smoke.js', '--progress-capture-fixture', '--metadata-batch-fixture', ...(process.argv.includes('--remediation') ? ['--metadata-remediation-fixture'] : [])], { encoding: 'utf8', timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
assert.equal(run.status, 0, 'U12 metadata batch fixture failed; inspect concrete assertion above');
assert.match(run.stdout, /PASS U12 actual epoch persists each result, commits once, and replays without reviewer work/);
