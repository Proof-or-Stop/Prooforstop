import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createController } from './controller.mjs';

export const limits = { calls: 4, cachedInput: 100, uncachedInput: 100, output: 100 };
export const options = () => ({ limits, partitions: {
  repair: { ...limits, calls: 2 }, product: { ...limits, calls: 3 },
}, maxWallMs: 2000, maxContextBytes: 4096 });
export const event = (overrides = {}) => ({ verified: true, task: 'benchmark',
  phase: 'REVIEW', candidate: 'commit-A', policy: 'policy-A',
  blocker: { code: 'approval_required', binding: 'binding-A', dependencies: { approval: 'pending' } },
  execution: { id: 'run-A', status: 'running', progress: 0 }, ...overrides });
export const request = (id, partition = 'product', source = 'main') => ({
  task: 'benchmark', candidate: id, policy: 'policy-A', cwd: '/isolated/lab',
  command: ['node', 'verify.mjs'], witness: 'witness-A', partition, source, provider: 'local-stub',
  ceiling: { cachedInput: 10, uncachedInput: 10, output: 10 },
});
export const receipt = id => ({ responseId: id,
  usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 } });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
test('BLOCKED_PROGRESS_WAKE_REGRESSION', () => {
  const c = createController(options());
  assert.equal(c.observe(event()).wake, true);
  let wakes = 0;
  for (let i = 1; i <= 1000; i++) wakes += Number(c.observe(event({
    observedAt: i, execution: { id: 'run-A', status: 'running', progress: i },
  })).wake);
  assert.equal(wakes, 0, 'BLOCKED_PROGRESS_WAKE_REGRESSION: unchanged blocker/progress must not wake model');
});
test('relevant changes wake exactly once, never grant approval', () => {
  const c = createController(options()); c.observe(event());
  for (const changed of [event({ candidate: 'commit-B' }), event({ policy: 'policy-B' }),
    event({ blocker: { code: 'approval_required', binding: 'binding-B', dependencies: { approval: 'pending' } } }),
    event({ blocker: null }), event({ execution: { id: 'run-A', status: 'completed' } }),
    event({ execution: { id: 'run-B', status: 'failed' } })]) {
    assert.equal(c.observe(changed).wake, true);
    assert.equal(c.observe(changed).wake, false);
  }
  assert.equal(c.observe(event()).wake, true);
});
test('invalid observations fail closed and report once until recovery', () => {
  const c = createController(options()); c.observe(event());
  assert.equal(c.observe({ verified: false }).reason, 'invalid_observation');
  for (let i = 0; i < 1000; i++) assert.equal(c.observe(null).wake, false);
  assert.equal(c.observe(event()).wake, true);
});
test('same candidate shares in-flight execution and reuses failed or completed outcome', async () => {
  const c = createController(options()); let launches = 0;
  let resolve; const completion = new Promise(r => { resolve = r; });
  const execute = async () => { launches++; await completion; return receipt('shared'); };
  const a = c.run(request('A'), execute); const b = c.run(request('A'), execute);
  resolve(); assert.deepEqual(await a, await b);
  await c.run(request('A'), execute); assert.equal(launches, 1);
  let failures = 0;
  const failed = async () => { failures++; throw new Error('provider failed without usage'); };
  await c.run(request('B'), failed); await c.run(request('B'), failed);
  assert.equal(failures, 1);
  assert.equal(c.ledger().filter(r => r.usage === null).length, 1);
});
test('candidate, policy, command, cwd and witness changes invalidate execution reuse', async () => {
  for (const field of ['candidate', 'policy', 'command', 'cwd', 'witness']) {
    const c = createController(options()); let launches = 0;
    const execute = async () => receipt(`fresh-${++launches}`);
    await c.run(request('A'), execute);
    const changed = request('A'); changed[field] = field === 'command' ? ['node', 'other.mjs'] : 'changed';
    await c.run(changed, execute); assert.equal(launches, 2, field);
  }
});
test('parallel reservations constrain aggregate and repair budget before execution', async () => {
  const c = createController(options()); const launched = [];
  let release; const done = new Promise(r => { release = r; });
  const pending = ['repair', 'repair', 'repair', 'product', 'product', 'product'].map((part, i) =>
    c.run(request(String(i), part, i % 2 ? 'child' : 'external_cli'), async () => {
      launched.push(part); await done; return receipt(`budget-${i}`);
    }));
  release(); const result = await Promise.all(pending);
  assert.equal(launched.length, 4); assert.equal(launched.filter(p => p === 'repair').length, 2);
  assert.equal(result.filter(r => r.status === 'blocked').length, 2);
  assert.equal(c.ledger().length, 4);
});
test('every token dimension is independently reserved, zero budget means zero', async () => {
  for (const dimension of ['calls', 'cachedInput', 'uncachedInput', 'output']) {
    const opts = options(); opts.limits = { ...limits, [dimension]: 0 };
    const c = createController(opts); let launches = 0;
    const result = await c.run(request('A'), async () => { launches++; return receipt('forbidden'); });
    assert.equal(launches, 0, dimension); assert.equal(result.status, 'blocked');
  }
});
test('caller cannot lower call reservation or dispatch while external block is active', async () => {
  const opts = options(); opts.limits = { ...limits, calls: 0 };
  const c = createController(opts); const input = request('A'); input.ceiling.calls = 0;
  let launches = 0; const execute = async () => { launches++; return receipt('A'); };
  assert.equal((await c.run(input, execute)).status, 'blocked');
  const blocked = createController(options()); blocked.observe(event());
  assert.equal((await blocked.run(request('B'), execute)).reason, 'external_dependency');
  blocked.observe(event({ blocker: null }));
  assert.equal((await blocked.run(request('B'), execute)).status, 'completed');
  assert.equal(launches, 1);
});
test('settled reservations release unused tokens, caller mutations cannot alter them', async () => {
  const opts = options(); opts.limits = { ...limits, cachedInput: 11, uncachedInput: 17, output: 13 };
  const c = createController(opts);
  const input = request('A'); let release; const wait = new Promise(r => { release = r; });
  const first = c.run(input, async () => { await wait; return receipt('settle-A'); });
  input.ceiling.cachedInput = 0; input.candidate = 'mutated';
  assert.equal((await c.run(request('B'), async () => receipt('settle-B'))).status, 'blocked');
  release(); await first;
  // Actual cache usage is 4, so a second ceiling of 7 now fits exactly.
  const second = request('B'); second.ceiling.cachedInput = 7;
  assert.equal((await c.run(second, async () => receipt('settle-B'))).status, 'completed');
  const ledger = c.ledger(); ledger[0].usage.cachedInput = 0;
  assert.equal(c.ledger()[0].usage.cachedInput, 4);
});
test('unknown usage is retained and prevents further dispatch', async () => {
  const c = createController(options());
  await c.run(request('A', 'repair', 'external_cli'), async () => ({ responseId: 'unknown', usage: null }));
  let launches = 0;
  const next = await c.run(request('B'), async () => { launches++; return receipt('B'); });
  assert.equal(launches, 0); assert.equal(next.status, 'blocked');
  assert.equal(c.ledger()[0].usage, null);
});
test('usage reconciles cache and reasoning subsets without double counting', async () => {
  const c = createController(options());
  for (const [i, source] of ['main', 'child', 'external_cli'].entries())
    await c.run(request(String(i), 'product', source), async () => receipt(`account-${i}`));
  const rows = c.ledger(); assert.equal(rows.length, 3);
  assert.equal(rows.reduce((n, r) => n + r.usage.cachedInput + r.usage.uncachedInput + r.usage.output, 0), 36);
  assert.deepEqual(rows.map(r => r.source), ['main', 'child', 'external_cli']);
});
test('duplicate response identity and invalid usage never fabricate a zero cost', async () => {
  for (const invalid of [null, { input_tokens: 1, cached_input_tokens: 2, output_tokens: 1 },
    { input_tokens: -1, cached_input_tokens: 0, output_tokens: 1 }]) {
    const c = createController(options());
    await c.run(request('A'), async () => ({ responseId: 'bad', usage: invalid }));
    assert.equal(c.ledger()[0].usage, null);
    assert.equal((await c.run(request('B'), async () => receipt('B'))).status, 'blocked');
  }
  const c = createController(options());
  await c.run(request('A'), async () => receipt('same-id'));
  await c.run(request('B'), async () => receipt('same-id'));
  assert.equal(c.ledger()[1].usage, null);
  assert.equal((await c.run(request('C'), async () => receipt('C'))).status, 'blocked');
});
test('provider overrun is recorded honestly and stops new dispatch', async () => {
  const c = createController(options());
  await c.run(request('A'), async () => ({ responseId: 'overrun',
    usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 1 } }));
  assert.equal(c.ledger()[0].usage.uncachedInput, 1000);
  assert.equal(c.ledger()[0].overrun, true);
  assert.equal((await c.run(request('B'), async () => receipt('B'))).status, 'blocked');
});
test('bounded context preserves current facts, excludes growing logs, rejects oversize facts', () => {
  const c = createController(options()); const state = { task: 'benchmark', phase: 'REVIEW',
    blocker: 'approval pending', decision: 'wait for binding change', logRefs: ['local://run-A'] };
  const first = c.context(state, []);
  assert.equal(c.context(state, Array(10000).fill('historical detail')), first);
  assert.deepEqual(JSON.parse(first), state); assert.ok(Buffer.byteLength(first) <= 4096);
  assert.throws(() => c.context({ ...state, decision: 'x'.repeat(5000) }, []), /context_budget/);
});
test('wall deadline blocks new dispatch, signals owned adapter, records unknown on timeout', async () => {
  const c = createController({ ...options(), maxWallMs: 20 }); let signalled = false;
  const result = await c.run(request('A'), ({ signal }) => new Promise(() => {
    signal.addEventListener('abort', () => { signalled = true; });
  }));
  assert.equal(result.status, 'failed'); assert.equal(signalled, true);
  assert.equal(c.ledger()[0].usage, null);
  assert.equal((await c.run(request('B'), async () => receipt('B'))).status, 'blocked');
});
test('one actual local process, one completion, no polling-driven execution', async () => {
  const c = createController(options()); let processes = 0;
  const execute = () => new Promise((resolve, reject) => {
    processes++;
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 10)'], { stdio: 'ignore' });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(receipt('local-process')) : reject(new Error('child failed')));
  });
  const results = await Promise.all(Array.from({ length: 50 }, () => c.run(request('process'), execute)));
  assert.equal(processes, 1); assert.ok(results.every(r => r.status === 'completed'));
});

if (process.argv[1]?.endsWith('/verify.mjs')) {
  for (const [name, run] of tests) { await run(); console.log(`PASS ${name}`); }
  console.log(JSON.stringify({ tests: tests.length, realModelCalls: 0, scope: 'Lab control prototype, not live host integration' }));
}
