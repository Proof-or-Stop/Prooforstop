// Actual checkout source; only the final paid-provider transport is intercepted.
import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText };
  return next(url, context);
} });
const { executePlannedSteps } = await import('../packages/main/src/core/planned-steps-executor.ts');
const { buildPlannerDraft, buildJobPlan } = await import('../packages/main/src/core/planner.ts');
const { runHostRun } = await import('../packages/main/src/core/host-run.ts');
const { resolveLedgerPath, verifyLedgerChain } = await import('../packages/main/src/core/usage-ledger/writer.ts');

const root = mkdtempSync(join(tmpdir(), 'benchmark-real-entry-'));
const measurements = {};
function plannerCase({ count = 6, cap = 4, attempts = 1, wall = 0, clockStep = 0, spawnError = false } = {}) {
  const plan = buildJobPlan(buildPlannerDraft(root, { request: 'Verify actual planned provider budget enforcement',
    mode: 'local', until: 'DONE', allowUnattendedPlanning: true }), 'B-lab', 'lab', {});
  // Isolated in-memory plan/store, no real Story or gate mutation.
  delete plan.worktreePolicy;
  plan.plannedSteps = Array.from({ length: count }, (_, i) => ({ stepId: `provider-${i}`, type: 'provider.codex',
    args: { argv: ['exec', 'bounded-fixture'] }, timeoutMs: 1000, maxAttempts: attempts }));
  plan.providerPolicy = { primaryProvider: 'codex', allowedProviders: ['codex'], fallbackProviders: [],
    productionDoneProviders: [], allowFakeProviderForProductionDone: false,
    credentialsEnvAllowlist: [], secretRefs: ['test-only-opaque-reference'], providerAvailability: 'fail_closed' };
  plan.budgetPolicy = { maxProviderCalls: cap, maxWallClockMs: wall, maxTokenOrCostBudget: 0 };
  let ticks = 0; const requests = [];
  const result = executePlannedSteps({ root, jobPlan: plan,
    store: { readStory: () => ({ storyId: 'B-lab', phase: 'DEV' }), storyExists: () => true,
      listStoryIds: () => ['B-lab'], appendProcessEvent: () => {} },
    now: () => new Date(1700000000000 + ticks++ * clockStep), env: {},
    providerExecutor: { available: () => true, run: request => {
      requests.push({ maxAttempts: request.maxAttempts, timeoutMs: request.timeoutMs });
      return { provider: 'codex', argvDigest: 'fixture', exitCode: 0, stdoutDigest: 'fixture', stderrDigest: 'fixture',
        stdoutBytes: 0, stderrBytes: 0, durationMs: 0, attempts: request.maxAttempts,
        timedOut: false, spawnError };
    } },
  });
  return { interceptedRequests: requests.length, authorizedAttempts: requests.reduce((n, r) => n + r.maxAttempts, 0),
    requests, recordedCalls: result.budgetUsage.usage.providerCalls, stopReason: result.stopReason,
    status: result.status, tokensKnown: result.budgetUsage.usage.tokenOrCostKnown };
}
try {
  measurements.callCeiling = plannerCase();
  measurements.retryCeiling = plannerCase({ count: 3, cap: 2, attempts: 3 });
  measurements.expiredWall = plannerCase({ count: 1, cap: 2, wall: 1, clockStep: 10 });
  measurements.remainingWall = plannerCase({ count: 1, cap: 2, attempts: 2, wall: 20 });
  measurements.generousBudget = plannerCase({ count: 2, cap: 8 });
  measurements.spawnFailure = plannerCase({ count: 1, cap: 2, attempts: 2, spawnError: true });
  const hostRoot = mkdtempSync(join(tmpdir(), 'benchmark-host-entry-'));
  try {
    let spawned = 0;
    const base = { root: hostRoot, cwd: hostRoot, host: 'codex', storyId: null, agentType: 'lab-regression',
      projectRootHash: 'sha256:lab', recordedAt: new Date().toISOString(), promptText: 'Bounded host entry fixture', env: { PROOF_OR_STOP_USAGE_LEDGER: '1' } };
    const runner = async (_plan) => { spawned++; return { stdout: JSON.stringify({ type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } }) + '\n', stderr: '', exitCode: 0,
      timedOut: false, durationMs: 1 }; };
    let blocked = 0;
    for (let i = 0; i < 10; i++) {
      const r = await runHostRun({ ...base, env: { ...base.env, PROOF_OR_STOP_HARD_BUDGET_TOKENS: '1' } }, { runner });
      blocked += Number(r.blocked);
    }
    measurements.existingHostBudget = { requests: 10, blocked, interceptedProviderCalls: spawned };
    const known = await runHostRun(base, { runner });
    const unknown = await runHostRun(base, { runner: async () => ({ stdout: '', stderr: 'fixture failure',
      exitCode: 1, timedOut: false, durationMs: 1 }) });
    const rows = verifyLedgerChain(resolveLedgerPath(hostRoot));
    measurements.existingHostLedger = { known: known.usageSummary, unknown: unknown.usageSummary,
      recordedRows: rows.length, chainVerified: true };
    assert.equal(blocked, 10); assert.equal(measurements.existingHostBudget.interceptedProviderCalls, 0);
    assert.equal(known.usageSummary.recorded, 'provider-reported');
    assert.equal(unknown.usageSummary.recorded, 'unavailable');
  } finally { rmSync(hostRoot, { recursive: true, force: true }); }
  console.log('MEASUREMENTS ' + JSON.stringify(measurements));
  assert.equal(measurements.callCeiling.interceptedRequests, 4, 'REAL_ENTRY_PROVIDER_CAP: ceiling must prevent the fifth transport invocation');
  assert.equal(measurements.retryCeiling.authorizedAttempts, 2, 'REAL_ENTRY_RETRY_CAP: retries must fit remaining calls');
  assert.equal(measurements.retryCeiling.recordedCalls, 2, 'actual retry attempts must be metered');
  assert.equal(measurements.spawnFailure.recordedCalls, 2, 'SPAWN_ATTEMPTS_LOST: post-transport spawn failures consume reported attempts');
  assert.equal(measurements.expiredWall.interceptedRequests, 0, 'REAL_ENTRY_WALL_CAP: expired work cannot reach transport');
  assert.ok(measurements.remainingWall.requests[0].timeoutMs * measurements.remainingWall.requests[0].maxAttempts <= 20,
    'actual provider request must fit the remaining wall allowance');
  assert.equal(measurements.generousBudget.interceptedRequests, 2, 'valid work must still run');
  assert.equal(measurements.generousBudget.tokensKnown, false, 'unknown provider usage must remain unknown');
  console.log('PASS actual executor/host entry regression; real paid provider calls=0');
} finally { rmSync(root, { recursive: true, force: true }); }
