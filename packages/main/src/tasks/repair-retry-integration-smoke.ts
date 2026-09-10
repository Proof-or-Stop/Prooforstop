#!/usr/bin/env node
//
// Repair / retry loop ↔ executePlannedSteps integration smoke (§B5, B14, M9).
//
// The pure loop engine (runRepairRetryLoop) and its provider-backed adapter
// (executeProviderBackedRepairRetry) are pinned by repair-retry-loop-smoke. This
// smoke proves the loop is actually WIRED INTO the real planned-steps execution
// path: a failing `validate.run` step that is repair-eligible drives the bounded
// repair/revalidate loop through executePlannedSteps itself (not an ad hoc loop),
// records every attempt as a step, and stops with an exact blocked reason. It also
// pins the hard boundaries:
//   - repair runs ONLY when repairAllowed=true AND maxRepairAttempts permits it;
//   - repeated identical blockers stop `blocked` (no infinite loop / token burn);
//   - a provider that exits 0 never satisfies validation;
//   - receipt/gate failures NEVER trigger repair-into-DONE;
//   - the default (repairAllowed=false) projection path is unchanged.

import assert from 'node:assert/strict';
import { executePlannedSteps } from '../core/planned-steps-executor.js';
import type { BoundedProviderExecutor, ProviderExecResult } from '../providers/types.js';

type JsonObject = Record<string, any>;

const root = '/tmp/proof-or-stop-repair-retry-integration-smoke';

const store = {
  readStory: () => ({ phase: 'DEV' } as JsonObject),
  storyExists: () => true,
  listStoryIds: () => [] as string[],
  appendProcessEvent: () => {},
} as any;

const env = { CODEX_KEY: 'secret-value', PATH: '/usr/bin', UNRELATED_SECRET: 'leak-me' };

// A bounded provider executor stub that counts invocations and lets each test shape
// the per-call result (e.g. vary stdoutDigest to flip the material/evidence hash).
function execStub(make: (call: number, req: JsonObject) => Partial<ProviderExecResult>, available = true) {
  const calls: JsonObject[] = [];
  const executor: BoundedProviderExecutor = {
    available: () => available,
    run: (req): ProviderExecResult => {
      calls.push(req as any);
      return {
        provider: req.provider,
        argvDigest: 'argv-digest',
        exitCode: 0,
        stdoutDigest: 'stdout-digest',
        stderrDigest: 'stderr-digest',
        stdoutBytes: 8,
        stderrBytes: 0,
        durationMs: 4,
        attempts: 1,
        timedOut: false,
        spawnError: false,
        ...make(calls.length, req as any),
      };
    },
  };
  return { executor, calls };
}

const providerPolicy = (over: JsonObject = {}): JsonObject => ({
  primaryProvider: 'codex',
  allowedProviders: ['codex'],
  fallbackProviders: [],
  productionDoneProviders: ['codex'],
  allowFakeProviderForProductionDone: false,
  credentialsEnvAllowlist: ['CODEX_KEY'],
  secretRefs: [],
  providerAvailability: 'fail_closed',
  ...over,
});

const retryPolicy = (over: JsonObject = {}): JsonObject => ({
  maxAttemptsPerStep: 2,
  maxRepairAttempts: 5,
  maxNoProgressIterations: 2,
  retryableFailureKinds: ['retryable_failure'],
  repairAllowed: true,
  ...over,
});

const stopPolicy = (over: JsonObject = {}): JsonObject => ({
  maxSteps: 20,
  maxWallClockMs: 60_000,
  onValidationFailure: 'repair_then_reverify',
  onProviderFailure: 'retry_then_block',
  onGateFailure: 'block',
  onReceiptFailure: 'block',
  onDirtyWorktree: 'block',
  onLeaseUnsafe: 'block',
  onMultiHostDisagreement: 'block',
  ...over,
});

const validateStep = (over: JsonObject = {}): JsonObject => ({
  stepId: 'step-validate',
  type: 'validate.run',
  title: 'run validation',
  purpose: 'validate the story',
  cwdPolicy: 'story-worktree',
  timeoutMs: 30_000,
  maxAttempts: 1,
  requiresCleanWorktree: false,
  producesEvidence: true,
  blocksUntilEvidenceUploaded: true,
  validationBinding: 'B-int:validation',
  repairBinding: 'B-int:repair',
  evidenceBinding: 'B-int:validation',
  args: { operation: 'validate.run' },
  ...over,
});

const repairStep = (over: JsonObject = {}): JsonObject => ({
  stepId: 'step-repair',
  type: 'provider.codex',
  title: 'bounded repair',
  purpose: 'repair the failing validation',
  cwdPolicy: 'story-worktree',
  timeoutMs: 1_000,
  maxAttempts: 2,
  requiresCleanWorktree: false,
  producesEvidence: true,
  blocksUntilEvidenceUploaded: true,
  provider: 'codex',
  evidenceBinding: 'B-int:repair',
  args: { operation: 'repair', argv: ['exec', '--repair'] },
  ...over,
});

const gateStep = (over: JsonObject = {}): JsonObject => ({
  stepId: 'step-gate',
  type: 'gate.evaluate',
  title: 'evaluate gate',
  purpose: 'gate to DONE',
  cwdPolicy: 'read-only',
  timeoutMs: 10_000,
  maxAttempts: 1,
  requiresCleanWorktree: false,
  producesEvidence: true,
  blocksUntilEvidenceUploaded: true,
  evidenceBinding: 'B-int:gate',
  args: { operation: 'gate.evaluate' },
  ...over,
});

const plan = (over: JsonObject): JsonObject => ({
  schemaVersion: 'proof-or-stop.job_plan.v1',
  plannerRunId: 'run-int',
  storyId: 'B-int',
  mode: 'local',
  until: 'TEST',
  developmentWorkflow: 'standard',
  plannedSteps: [],
  coverageMap: [],
  multiHostPolicy: {},
  providerPolicy: providerPolicy(),
  retryPolicy: retryPolicy(),
  stopPolicy: stopPolicy(),
  jobPlanDigest: 'jd',
  plannerDigest: 'pd',
  status: 'planned',
  ...over,
});

const run = (jobPlan: JsonObject, executor: BoundedProviderExecutor): JsonObject =>
  executePlannedSteps({ root, store, jobPlan: jobPlan as any, env, providerExecutor: executor }) as JsonObject;

const attempts = (r: JsonObject) => r.steps.filter((s: JsonObject) => s.summary.repairLoopAttempt === true);
const terminals = (r: JsonObject) => r.steps.filter((s: JsonObject) => s.summary.repairLoopAttempt !== true);

function assertNeverAuthority(r: JsonObject): void {
  assert.equal(r.authorityDone, false, 'repair never confers authority DONE');
  assert.equal(r.fullAuthorityDone, false);
  assert.equal(r.receiptVerified, false, 'repair never verifies a receipt');
  assert.equal(r.multiHostVerified, false);
  assert.equal(r.localDone, false);
}

// ============================================================================
// A. repairAllowed=false: a failing validate.run stops single-pass, NO repair.
//    Even with a valid repair provider step present, the loop must stay inert.
// ============================================================================
{
  const { executor, calls } = execStub(() => ({ exitCode: 0 }));
  const r = run(
    plan({ plannedSteps: [validateStep(), repairStep()], coverageMap: [], retryPolicy: retryPolicy({ repairAllowed: false }) }),
    executor,
  );
  assert.equal(r.status, 'blocked');
  assert.equal(r.stopReason, 'validation_binding_missing', 'repair disabled -> the validation failure stops single-pass with its own reason');
  assert.equal(calls.length, 0, 'repair provider must NOT be invoked when repairAllowed=false');
  assert.equal(attempts(r).length, 0, 'no repair-loop attempt records when repair is disabled');
  assertNeverAuthority(r);
}

// ============================================================================
// B. repairAllowed=true, provider exits 0 ("repaired") but validation keeps
//    failing with identical evidence -> bounded no_progress block.
//    CRITICAL: a provider exit 0 must NEVER be promoted to validation satisfied.
// ============================================================================
{
  const { executor, calls } = execStub(() => ({ exitCode: 0, stdoutDigest: 'constant' }));
  const r = run(
    plan({ plannedSteps: [validateStep(), repairStep()], coverageMap: [], retryPolicy: retryPolicy({ maxRepairAttempts: 5, maxNoProgressIterations: 2 }) }),
    executor,
  );
  assert.equal(r.status, 'blocked');
  assert.equal(r.stopReason, 'no_progress', 'identical repair evidence + still-failing validation hashes the same -> no_progress, not an infinite loop');
  assert.equal(r.failedStepId, 'step-validate');
  assert.equal(calls.length, 3, 'repair ran 3 rounds (round 1 changed material, rounds 2-3 unchanged tripped maxNoProgressIterations)');
  // every repair invocation saw the redacted env (allowlisted credential only).
  for (const req of calls) {
    assert.deepEqual(req.argv, ['exec', '--repair']);
    assert.equal(req.env.CODEX_KEY, 'secret-value', 'allowlisted credential is projected to the repair provider');
    assert.equal(req.env.UNRELATED_SECRET, undefined, 'non-allowlisted env is redacted out of the repair provider');
  }
  // attempt records: validate-0 + (repair+revalidate)*3 = 7; plus one terminal block.
  assert.equal(attempts(r).length, 7, 'every initial/repair/revalidation attempt is recorded (tagged repairLoopAttempt)');
  const terminal = terminals(r).find((s: JsonObject) => s.stepId === 'step-validate');
  assert(terminal, 'a single untagged terminal validate.run block carries the loop stop reason');
  assert.equal(terminal.status, 'blocked');
  assert.equal(terminal.reason, 'no_progress');
  assert.equal(terminal.summary.validationSatisfied, false, 'provider exit 0 must never satisfy validation');
  assert.equal(terminal.summary.repairAttemptsUsed, 3);
  assert(!JSON.stringify(r).includes('secret-value'), 'raw credential must never surface in execution evidence');
  assertNeverAuthority(r);
}

// ============================================================================
// C. repair changes evidence each round (material progresses) but validation
//    never passes -> bounded by maxRepairAttempts -> max_repair_attempts_exhausted.
// ============================================================================
{
  const { executor, calls } = execStub((call) => ({ exitCode: 0, stdoutDigest: `round-${call}` }));
  const r = run(
    plan({ plannedSteps: [validateStep(), repairStep()], coverageMap: [], retryPolicy: retryPolicy({ maxRepairAttempts: 3, maxNoProgressIterations: 5 }) }),
    executor,
  );
  assert.equal(r.status, 'blocked');
  assert.equal(r.stopReason, 'max_repair_attempts_exhausted', 'changing repair evidence resets no-progress, so the outer repair budget bounds the loop');
  assert.equal(calls.length, 3, 'the full maxRepairAttempts budget was spent, then stopped');
  const terminal = terminals(r).find((s: JsonObject) => s.stepId === 'step-validate');
  assert.equal(terminal.reason, 'max_repair_attempts_exhausted');
  assert.equal(terminal.summary.repairAttemptsUsed, 3);
  assertNeverAuthority(r);
}

// ============================================================================
// D. repair provider unavailable -> fail closed after ONE attempt (no budget burn).
// ============================================================================
{
  const { executor, calls } = execStub(() => ({}), /* available */ false);
  const r = run(
    plan({ plannedSteps: [validateStep(), repairStep()], coverageMap: [], retryPolicy: retryPolicy({ maxRepairAttempts: 5 }) }),
    executor,
  );
  assert.equal(r.status, 'blocked');
  assert.equal(r.stopReason, 'repair_provider_unavailable');
  assert.equal(calls.length, 0, 'an unavailable provider is rejected at preflight; no spawn, and the loop stops after one attempt');
  const terminal = terminals(r).find((s: JsonObject) => s.stepId === 'step-validate');
  assert.equal(terminal.reason, 'repair_provider_unavailable');
  assert.equal(terminal.summary.repairAttemptsUsed, 1, 'an unavailable provider stops after the first repair attempt, not the whole budget');
  assertNeverAuthority(r);
}

// ============================================================================
// E. repairBinding does not resolve to a provider step -> single-pass stop
//    (the loop never engages; conservative fail-closed).
// ============================================================================
{
  const { executor, calls } = execStub(() => ({ exitCode: 0 }));
  const r = run(
    plan({ plannedSteps: [validateStep({ repairBinding: 'B-int:does-not-exist' }), repairStep()], coverageMap: [] }),
    executor,
  );
  assert.equal(r.status, 'blocked');
  assert.equal(r.stopReason, 'validation_binding_missing', 'an unresolvable repairBinding keeps the original single-pass behavior');
  assert.equal(calls.length, 0, 'no repair provider is invoked when the repair binding does not resolve');
  assert.equal(attempts(r).length, 0);
  assertNeverAuthority(r);
}

// ============================================================================
// F. RECEIPT/GATE failure must NEVER trigger repair-into-DONE.
//    validate.run passes; the authority DONE gate then fails closed for want of a
//    verified receipt. Repair is configured AND allowed, but must stay untouched.
// ============================================================================
{
  const { executor, calls } = execStub(() => ({ exitCode: 0 }));
  const r = run(
    plan({
      mode: 'authority',
      until: 'DONE',
      plannedSteps: [validateStep(), gateStep()],
      coverageMap: [{ validationStepIds: ['step-validate'] }],
    }),
    executor,
  );
  assert.equal(r.status, 'blocked');
  assert.equal(r.stopReason, 'authority_gate_decision_receipt_required', 'authority DONE without a verified receipt stops closed');
  assert.equal(calls.length, 0, 'a receipt/gate failure must never invoke the repair provider');
  assert.equal(attempts(r).length, 0, 'gate/receipt failures never enter the repair loop (repair is scoped to validate.run)');
  // sanity: validation itself passed, so the block is the gate, not validation.
  const validateRecord = r.steps.find((s: JsonObject) => s.stepId === 'step-validate');
  assert.equal(validateRecord.status, 'passed', 'validation passed; only the receipt gate blocks');
  assertNeverAuthority(r);
}

console.log('✓ repair-retry integration smoke passed: executePlannedSteps drives the bounded §B5/B14 repair loop on a failing validate.run (repair only when repairAllowed+budget permit), records every attempt, stops blocked with exact reasons (no_progress / max_repair_attempts_exhausted / repair_provider_unavailable), a provider exit 0 never satisfies validation, unresolvable/disabled repair stays single-pass, and receipt/gate failures never repair-into-DONE');
