import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import { runScheduled } from '../packages/main/src/core/keyed-scheduler.ts';

const entry = (name, key = '43127', access = 'exclusive') => ({ name,
  resources: [{ class: 'fixed-port', key, canonicalKey: `fixed-port:${key}`, access }] });
const pass = item => ({ name: item.name, status: 'PASS' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const options = { cancellation: 'run-all' };
async function overlap(a, b) {
  let active = 0, maximum = 0;
  const execute = async item => {
    active++; maximum = Math.max(active, maximum);
    await sleep(30); active--;
    return pass(item);
  };
  await Promise.all([runScheduled([a], 1, execute, options), runScheduled([b], 1, execute, options)]);
  return maximum;
}
assert.equal(await overlap(entry('a'), entry('b')), 1,
  'U08 independent schedulers must serialize the same exclusive fixed port');
assert.equal(await overlap(entry('a', '43127', 'shared'), entry('b', '43127', 'shared')), 2,
  'shared resource readers still overlap');
assert.equal(await overlap(entry('a'), entry('b', '43128')), 2, 'unrelated resources still overlap');
assert.equal(await overlap(entry('a', '43127', 'shared'), entry('b')), 1, 'writer excludes readers across batches');

let release, started;
const held = new Promise(resolve => { release = resolve; });
const ready = new Promise(resolve => { started = resolve; });
const failed = runScheduled([entry('failure')], 1, async () => {
  started(); await held; throw new Error('actual executor rejection');
}, options);
// Attach rejection handling immediately; an unrelated waiter must not inherit it.
const rejected = assert.rejects(failed, /actual executor rejection/);
await ready;
let launched = false;
const successor = runScheduled([entry('successor')], 1, async item => { launched = true; return pass(item); }, options);
await sleep(20); assert.equal(launched, false, 'waiter cannot run before failed owner releases');
release(); await rejected;
assert.equal((await successor)[0].status, 'PASS', 'executor rejection releases claims without cancelling another batch');

await assert.rejects(runScheduled([entry('sync-throw')], 1, () => { throw new Error('sync failure'); }, options), /sync failure/);
assert.equal((await runScheduled([entry('after-sync-throw')], 1, async item => pass(item), options))[0].status, 'PASS');

let freeOwner, ownerStarted;
const ownerReady = new Promise(resolve => { ownerStarted = resolve; });
const ownerHold = new Promise(resolve => { freeOwner = resolve; });
const owner = runScheduled([entry('owner')], 1, async item => { ownerStarted(); await ownerHold; return pass(item); }, options);
await ownerReady;
let cancelled = false, cancelledLaunches = 0;
const waiting = runScheduled([entry('cancelled-waiter')], 1, async item => { cancelledLaunches++; return pass(item); }, {
  ...options, externalCancellation: () => cancelled ? 'user cancelled' : undefined,
  cancelledResult: (item, reason) => ({ name: item.name, status: 'INTERRUPTED', reason }),
});
cancelled = true;
const cancellationDeadline = setTimeout(() => { throw new Error('blocked scheduler failed to observe cancellation'); }, 2000);
try {
  assert.equal((await waiting)[0].status, 'INTERRUPTED');
  assert.equal(cancelledLaunches, 0, 'cancelled waiter never executes or steals another owner claim');
} finally { clearTimeout(cancellationDeadline); freeOwner(); }
assert.equal((await owner)[0].status, 'PASS', 'waiter cancellation does not cancel owner');
console.log('PASS U08 cross-scheduler resources, shared access, independent failures and release');
