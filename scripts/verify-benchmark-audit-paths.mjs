import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText };
  return next(url, context);
} });
const { runHostRun } = await import('../packages/main/src/core/host-run.ts');
const { reserveHostRunBudget, settleHostRunBudget } = await import('../packages/main/src/core/host-run-budget.ts');
const { resolveLedgerPath } = await import('../packages/main/src/core/usage-ledger/writer.ts');
const failures = [], passed = [];
const env = { PROOF_OR_STOP_RUN_BUDGET_ID: 'audit', PROOF_OR_STOP_RUN_BUDGET_MAX_CALLS: '2' };
const args = root => ({ root, cwd: root, host: 'codex', storyId: null, agentType: 'lab-audit',
  promptText: 'bounded fixture', env, recordedAt: new Date().toISOString(), projectRootHash: 'sha256:lab' });
const stdout = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } }) + '\n';
const runner = async () => ({ stdout, stderr: '', exitCode: 0, timedOut: false });
const budgetFile = root => {
  const dir = join(root, '.proof-or-stop/runtime/host-run-budgets');
  return join(dir, readdirSync(dir).find(name => name.endsWith('.json')));
};
async function test(name, fn) {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-audit-path-'));
  try { await fn(root); passed.push(name); }
  catch (error) { failures.push({ name, message: error.message }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
for (const count of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
  await test(`malformed provider count ${count}`, async root => {
    const result = await runHostRun({ ...args(root), host: 'claude' }, { runner: async () => ({
      stdout: JSON.stringify({ type: 'result', usage: { input_tokens: count, cache_read_input_tokens: 0, output_tokens: 2 } }) + '\n',
      stderr: '', exitCode: 0, timedOut: false,
    }) });
    assert.equal(result.exitCode, 0);
    assert.equal((await runHostRun(args(root), { runner })).exitCode, 0);
    const rows = JSON.parse(readFileSync(budgetFile(root), 'utf8')).rows;
    assert.equal(rows.length, 2); assert.equal(rows[0].input, null);
  });
  await test(`persisted accounting recovery ${count}`, root => {
    const first = reserveHostRunBudget(root, env, 'bounded');
    settleHostRunBudget(first, { spawned: true, recorded: 'provider-reported', input: count, cacheRead: 0, output: 2 });
    const file = budgetFile(root), state = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(state.rows[0].input, null, 'writer must normalize invalid counters');
    state.rows[0].input = count; writeFileSync(file, JSON.stringify(state));
    reserveHostRunBudget(root, env, 'next');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).rows[0].input, null, 'reader must recover accounting without releasing calls');
    assert.throws(() => reserveHostRunBudget(root, env, 'exhausted'), /reservations exhausted/);
  });
}
await test('settlement failure preserves provider result and blocks later corrupt-state launches', async root => {
  let launches = 0;
  const result = await runHostRun(args(root), { runner: async () => {
    launches++; writeFileSync(budgetFile(root), 'corrupt');
    return { ...await runner(), exitCode: 7 };
  } });
  assert.equal(result.stdout, stdout); assert.equal(result.exitCode, 7);
  assert.equal(result.usageSummary.recorded, 'provider-reported');
  assert.match(result.budgetSettlementError, /budget_settlement_failed/);
  await assert.rejects(runHostRun(args(root), { runner: async () => { launches++; return runner(); } }));
  assert.equal(launches, 1);
});
for (const [name, overrides, deps] of [
  ['unsupported host', { host: 'invalid' }, {}],
  ['empty prompt', { promptText: '' }, {}],
  ['empty cwd', { cwd: '' }, {}],
  ['unknown story', { storyId: 'B-missing' }, { resolveStory: () => null }],
  ['cross-story run', { storyId: 'B-one', phase: 'DEV', reviewRunId: 'B-two:RR-1' }, {}],
]) await test(`pre-runner rejection: ${name}`, async root => {
  let launches = 0;
  await assert.rejects(runHostRun({ ...args(root), ...overrides }, { ...deps,
    runner: async () => { launches++; return runner(); } }));
  assert.equal(launches, 0);
  assert.deepEqual(JSON.parse(readFileSync(budgetFile(root), 'utf8')).rows, []);
  assert.equal((await runHostRun(args(root), { runner })).exitCode, 0);
});
await test('corrupt ledger cannot replace original transport exception', async root => {
  const original = new Error('original transport failure');
  await assert.rejects(runHostRun(args(root), { runner: async () => {
    writeFileSync(resolveLedgerPath(root), 'corrupt'); throw original;
  } }), error => error === original);
  const rows = JSON.parse(readFileSync(budgetFile(root), 'utf8')).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].state, 'unknown');
});
console.log('AUDIT_PATH_RESULTS ' + JSON.stringify({ passed, failures }));
assert.deepEqual(failures, [], 'BENCHMARK_AUDIT_PATHS_RED: audited accounting boundaries must hold');
console.log('BENCHMARK_AUDIT_PATHS_GREEN');
