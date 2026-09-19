import assert from 'node:assert/strict';
import { alwaysWake, createMonitor } from './policy.mjs';

const base = {
  phases: { 'B-0980': 'REVIEW', 'B-65ca': 'PLAN' },
  revision: 'revision-a',
  scope: { status: 'decision_required', binding: 'binding-a' },
  executions: [],
};
const copy = () => structuredClone(base);
const monitor = createMonitor();
assert.equal(monitor.observe(copy()).wake, true, 'cold start must initialize');
const unchanged = Array.from({ length: 100 }, copy);
const before = unchanged.filter(alwaysWake).length;
const after = unchanged.filter(x => monitor.observe(x).wake).length;
assert.equal(before, 100);
assert.equal(after, 0, 'UNCHANGED_WAKE_REGRESSION: 100 unchanged observations must add zero wakes');

const changed = [
  { ...copy(), phases: { 'B-0980': 'TEST', 'B-65ca': 'PLAN' } },
  { ...copy(), revision: 'revision-b' },
  { ...copy(), scope: { status: 'allowed', binding: 'binding-a' } },
  { ...copy(), scope: { status: 'decision_required', binding: 'binding-b' } },
  { ...copy(), executions: [{ id: 'run-1', status: 'running', progress: 1 }] },
  { ...copy(), executions: [{ id: 'run-1', status: 'running', progress: 2 }] },
  { ...copy(), executions: [{ id: 'run-1', status: 'completed', exitCode: 0 }] },
  { ...copy(), executions: [{ id: 'run-1', status: 'failed', exitCode: 1 }] },
  { ...copy(), executions: [{ id: 'run-2', status: 'running', progress: 1 }] },
];
for (const state of changed) {
  const m = createMonitor();
  m.observe(copy());
  assert.equal(m.observe(state).wake, true, 'meaningful change must wake');
  assert.equal(m.observe(structuredClone(state)).wake, false, 'same change wakes once');
  assert.equal(m.observe(copy()).wake, true, 'A -> B -> A must wake again');
}
const reordered = Object.fromEntries(Object.entries(copy()).reverse());
reordered.phases = Object.fromEntries(Object.entries(reordered.phases).reverse());
assert.equal(monitor.observe(reordered).wake, false, 'object order is immaterial');
for (const invalid of [null, undefined, {}, { value: NaN }, { value: undefined }, { value: () => 1 }]) {
  const result = monitor.observe(invalid);
  assert.equal(result.wake, true, 'unknown observation must remain visible');
  assert.equal(result.reason, 'invalid_observation');
}
assert.equal(monitor.observe(copy()).wake, true, 'recovery after failed reads must wake');
assert.equal(monitor.observe(copy()).wake, false);
const mutable = copy();
monitor.observe(mutable);
mutable.revision = 'revision-mutated';
assert.equal(monitor.observe(mutable).wake, true, 'retain a value snapshot, not a mutable reference');
console.log(JSON.stringify({ status: 'verified', unchanged: { before, after }, changeCases: changed.length,
  realProviderCalls: 0, scope: 'Lab policy replay; not live scheduler or Story evidence' }));
