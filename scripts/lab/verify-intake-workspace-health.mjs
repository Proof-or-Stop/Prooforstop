import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const baseline = JSON.parse(readFileSync(new URL('../../docs/lab/memory-intake-measurement/history-repair/workspace-health-baseline.json', import.meta.url), 'utf8'));
const result = spawnSync(process.execPath, baseline.command.slice(1), { encoding: 'utf8', timeout: 180_000 });
assert.equal(result.signal, null); assert.equal(result.error, undefined);
const output = result.stdout + result.stderr;
const failures = output.split('\n').filter(line => line.startsWith('[FAIL]'));
const summary = output.match(/(?:^|\n)(\d+)\/(\d+) cases passed/);
assert.ok(summary, 'workspace health must finish every case');
assert.equal(Number(summary[2]), baseline.cases);
assert.equal(Number(summary[1]) + failures.length, baseline.cases);
assert.equal(result.status, failures.length ? 1 : 0);
for (const failure of failures) assert.ok(baseline.failures.includes(failure), 'NEW_WORKSPACE_REGRESSION ' + failure);
console.log('WORKSPACE_HEALTH_NO_NEW_REGRESSIONS ' + JSON.stringify({baselineHead:baseline.mainHead,passed:Number(summary[1]),cases:baseline.cases,remainingBaselineFailures:failures}));
// This is a no-new-regressions health input. It never calls the full suite green.
