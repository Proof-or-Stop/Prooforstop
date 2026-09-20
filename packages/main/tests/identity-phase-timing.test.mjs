import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the actual suite dispatcher without booting unrelated Story fixtures.
const source = readFileSync(new URL('./canonical-new-story-artifacts.test.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function check(groups, name, fn) {');
const end = source.indexOf('\nconst NOW =', start);
assert.ok(start >= 0 && end > start, 'actual check dispatcher must be found');
const stdout = [], stderr = [], failures = [];
const context = vm.createContext({
  selectedGroup: 'identity-cutover', failures,
  process: { pid: 123, stdout: { write: s => stdout.push(s) }, stderr: { write: s => stderr.push(s) },
    hrtime: { bigint: (() => { let time = 0n; return () => (time += 2500000n); })() } },
});
vm.runInContext(source.slice(start, end), context);
await context.check(['identity-cutover'], 'passing case', async () => {});
const originalError = new Error('intentional controlled rejection');
await context.check(['identity-cutover'], 'failing case', async () => { throw originalError; });
let skippedRan = false;
await context.check(['runtime'], 'excluded case', async () => { skippedRan = true; });
assert.equal(skippedRan, false);
assert.equal(failures.length, 1);
assert.equal(failures[0].error, originalError, 'timing must preserve original failure');
assert.deepEqual(stdout, ['PASS passing case\n']);
assert.ok(stderr.includes('FAIL failing case: intentional controlled rejection\n'));
const timings = stderr.filter(s => s.startsWith('IDENTITY_CHECK_TIMING ')).map(s => JSON.parse(s.slice('IDENTITY_CHECK_TIMING '.length)));
assert.equal(timings.length, 2, 'IDENTITY_TIMING_MISSING: executed passing and failing checks need independent timing records');
assert.deepEqual(timings.map(t => [t.name, t.status, t.elapsedMs, t.group, t.pid]), [
  ['passing case', 'pass', 2.5, 'identity-cutover', 123],
  ['failing case', 'fail', 2.5, 'identity-cutover', 123],
]);
console.log('IDENTITY_PHASE_TIMING_GREEN: actual dispatcher preserves pass/fail/skip and reports monotonic duration');
