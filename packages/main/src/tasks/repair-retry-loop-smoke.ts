#!/usr/bin/env node
//
// Repair / retry / stop-policy loop smoke (§B5, M9).
//
// Drives the pure loop engine (runRepairRetryLoop) through every branch and the
// provider-backed adapter (executeProviderBackedRepairRetry) with a stubbed
// bounded provider, asserting:
//   - outer validation-failure loop with a configured repair provider step;
//   - revalidation after every repair (repair never bypasses validation);
//   - provider timeout retry budget surfaced in providerAttemptsUsed;
//   - cross-iteration no-progress detection via the material/evidence hash;
//   - exact blocked stop reasons after each limit;
//   - hard invariants: authority / receipt / multi-host status always false.

import assert from 'node:assert/strict';
import {
  executeProviderBackedRepairRetry,
  resolveRepairRetryPolicy,
} from '../core/planned-steps-executor.js';
import {
  normalizeRepairRetryPolicy,
  runRepairRetryLoop,
  type RepairProbeResult,
  type RepairRetryHooks,
  type RepairRetryLoopResult,
  type RepairRetryPolicy,
} from '../core/repair-retry-loop.js';
import type { BoundedProviderExecutor, ProviderExecResult } from '../providers/types.js';

type JsonObject = Record<string, any>;

const root = '/tmp/proof-or-stop-repair-retry-smoke';

// --- shared helpers ----------------------------------------------------------

const basePolicy = (over: Partial<RepairRetryPolicy> = {}): Partial<RepairRetryPolicy> => ({
  maxAttemptsPerStep: 2,
  maxRepairAttempts: 3,
  maxNoProgressIterations: 2,
  repairAllowed: true,
  retryableFailureKinds: ['retryable_failure'],
  onValidationFailure: 'return_to_dev',
  onProviderFailure: 'retry_then_block',
  ...over,
});

const repairProbe = (over: Partial<RepairProbeResult> = {}): RepairProbeResult => ({
  outcome: 'repaired',
  attempts: 1,
  evidenceDigest: 'evidence',
  ...over,
});

// Every loop result must carry the same hard invariants no matter the branch.
function assertInvariants(r: RepairRetryLoopResult): void {
  assert.equal(r.bypassedValidation, false, 'the loop never bypasses validation');
  assert.equal(r.authorityDone, false, 'the repair loop never confers authority DONE');
  assert.equal(r.receiptVerified, false, 'the repair loop never verifies a receipt');
  assert.equal(r.multiHostVerified, false, 'the repair loop never confers multi-host verification');
  if (r.status !== 'validated') {
    assert.equal(r.validationSatisfied, false, 'a blocked loop never reports validation satisfied');
  }
  assert.equal(typeof r.loopDigest, 'string');
  assert(r.loopDigest.length === 64, 'loopDigest is a sha256 hex digest');
}

// ============================================================================
// Part 1 — pure engine branches
// ============================================================================

// 1a. validation passes immediately -> validated, no repair attempted.
{
  const r = runRepairRetryLoop(basePolicy(), {
    validate: () => ({ passed: true, digest: 'v-ok' }),
    repair: () => repairProbe(),
    materialHash: () => 'm',
  });
  assert.equal(r.status, 'validated');
  assert.equal(r.stopReason, 'validation_passed');
  assert.equal(r.validationSatisfied, true);
  assert.equal(r.repairAttemptsUsed, 0, 'a passing first validation never runs repair');
  assert.equal(r.providerAttemptsUsed, 0);
  assertInvariants(r);
}

// 1b. validation fails + repair not allowed -> blocked, return_to_dev honored.
{
  const failHooks: RepairRetryHooks = {
    validate: () => ({ passed: false, digest: 'v-fail' }),
    repair: () => repairProbe(),
    materialHash: () => 'm',
  };
  const returnToDev = runRepairRetryLoop(basePolicy({ repairAllowed: false, onValidationFailure: 'return_to_dev' }), failHooks);
  assert.equal(returnToDev.status, 'blocked');
  assert.equal(returnToDev.stopReason, 'repair_not_allowed');
  assert.equal(returnToDev.returnToDev, true, 'onValidationFailure=return_to_dev routes the failure back to DEV');
  assert.equal(returnToDev.repairAttemptsUsed, 0);
  assertInvariants(returnToDev);

  const blockOnly = runRepairRetryLoop(basePolicy({ repairAllowed: false, onValidationFailure: 'block' }), failHooks);
  assert.equal(blockOnly.stopReason, 'repair_not_allowed');
  assert.equal(blockOnly.returnToDev, false, 'onValidationFailure=block does not route back to DEV');
  assertInvariants(blockOnly);
}

// 1c. repair fixes validation on the first round -> validated_after_repair.
{
  const r = runRepairRetryLoop(basePolicy(), {
    validate: (i) => ({ passed: i >= 1, digest: `v-${i}` }),
    repair: () => repairProbe({ evidenceDigest: 'fix-1' }),
    materialHash: (i) => `m-${i}`,
  });
  assert.equal(r.status, 'validated');
  assert.equal(r.stopReason, 'validation_passed_after_repair');
  assert.equal(r.validationSatisfied, true);
  assert.equal(r.repairAttemptsUsed, 1, 'one repair round was enough');
  assert.equal(r.iterations.length, 2, 'iteration 0 (validate) + iteration 1 (revalidate)');
  assertInvariants(r);
}

// 1d. cross-iteration no-progress: every repair times out, material never changes.
{
  let providerCalls = 0;
  const r = runRepairRetryLoop(basePolicy({ maxRepairAttempts: 5, maxNoProgressIterations: 2 }), {
    validate: () => ({ passed: false, digest: 'v-stuck' }),
    repair: () => { providerCalls++; return repairProbe({ outcome: 'provider_timeout', attempts: 2, evidenceDigest: 'same' }); },
    materialHash: () => 'constant', // never changes -> no progress
  });
  assert.equal(r.status, 'blocked');
  assert.equal(r.stopReason, 'no_progress', 'an unchanging material hash stops with no_progress, not max_repair');
  assert.equal(r.noProgressStreak, 2);
  assert.equal(r.repairAttemptsUsed, 2, 'no_progress fires as soon as the streak hits the limit');
  assert.equal(r.providerAttemptsUsed, 4, 'each repair spent its 2-attempt timeout budget (provider timeout retry)');
  assert.equal(providerCalls, 2);
  assertInvariants(r);
}

// 1e. max repair attempts exhausted: material changes each round (progress resets
// the no-progress streak) but validation never passes.
{
  let i = 0;
  const r = runRepairRetryLoop(basePolicy({ maxRepairAttempts: 3, maxNoProgressIterations: 5 }), {
    validate: () => ({ passed: false, digest: 'v' }),
    repair: () => repairProbe({ outcome: 'provider_failed', attempts: 1 }),
    materialHash: () => `m-${i++}`, // always changes -> never no-progress
  });
  assert.equal(r.stopReason, 'max_repair_attempts_exhausted');
  assert.equal(r.repairAttemptsUsed, 3, 'the full outer repair budget was spent');
  assert.equal(r.noProgressStreak, 0, 'changing material kept the no-progress streak at zero');
  assertInvariants(r);
}

// 1f. provider unavailable -> fail closed immediately (no budget burn).
{
  const r = runRepairRetryLoop(basePolicy({ maxRepairAttempts: 5 }), {
    validate: () => ({ passed: false, digest: 'v' }),
    repair: () => repairProbe({ outcome: 'provider_unavailable', evidenceDigest: '' }),
    materialHash: () => 'm',
  });
  assert.equal(r.stopReason, 'repair_provider_unavailable');
  assert.equal(r.repairAttemptsUsed, 1, 'an unavailable provider stops after the first attempt, not the whole budget');
  assertInvariants(r);
}

// 1g. provider_failed + onProviderFailure=block -> blocked on provider failure.
{
  const r = runRepairRetryLoop(basePolicy({ onProviderFailure: 'block' }), {
    validate: () => ({ passed: false, digest: 'v' }),
    repair: () => repairProbe({ outcome: 'provider_failed' }),
    materialHash: () => 'm',
  });
  assert.equal(r.stopReason, 'repair_provider_failed');
  assertInvariants(r);
}

// 1h. defensive normalization: garbage policy stays finite and fail-closed.
{
  const norm = normalizeRepairRetryPolicy({ maxRepairAttempts: -5, maxNoProgressIterations: 0, maxAttemptsPerStep: 0, repairAllowed: true, onValidationFailure: 'nonsense' as any } as any);
  assert.equal(norm.maxRepairAttempts, 0, 'negative repair budget clamps to 0');
  assert.equal(norm.maxNoProgressIterations, 1, 'zero no-progress budget clamps to 1');
  assert.equal(norm.maxAttemptsPerStep, 1, 'zero attempts-per-step clamps to 1');
  assert.equal(norm.onValidationFailure, 'return_to_dev', 'an invalid stop behavior falls back to a safe default');
  // repairAllowed=true but maxRepairAttempts clamped to 0 -> repair cannot run.
  const r = runRepairRetryLoop({ maxRepairAttempts: -5, maxNoProgressIterations: 0, repairAllowed: true } as any, {
    validate: () => ({ passed: false, digest: 'v' }),
    repair: () => repairProbe(),
    materialHash: () => 'm',
  });
  assert.equal(r.stopReason, 'repair_not_allowed', 'a clamped-to-zero repair budget cannot repair');
  assertInvariants(r);
}

// ============================================================================
// Part 2 — provider-backed adapter (real executeRealProviderStep machinery)
// ============================================================================

const providerPolicy = (over: JsonObject = {}): JsonObject => ({
  primaryProvider: 'codex',
  allowedProviders: ['codex'],
  fallbackProviders: [],
  productionDoneProviders: ['codex'],
  allowFakeProviderForProductionDone: false,
  credentialsEnvAllowlist: ['CODEX_KEY'],
  providerAvailability: 'fail_closed',
  ...over,
});

const retryPolicy = (over: JsonObject = {}): JsonObject => ({
  maxAttemptsPerStep: 2,
  maxRepairAttempts: 5,
  maxNoProgressIterations: 2,
  repairAllowed: true,
  retryableFailureKinds: ['retryable_failure'],
  ...over,
});

const stopPolicy = (over: JsonObject = {}): JsonObject => ({
  maxSteps: 10,
  maxWallClockMs: 60_000,
  onValidationFailure: 'return_to_dev',
  onProviderFailure: 'retry_then_block',
  onGateFailure: 'block',
  onReceiptFailure: 'block',
  onDirtyWorktree: 'block',
  onLeaseUnsafe: 'block',
  onMultiHostDisagreement: 'block',
  ...over,
});

const jobPlanFor = (pp: JsonObject, rp: JsonObject, sp: JsonObject): JsonObject => ({
  schemaVersion: 'proof-or-stop.job_plan.v1',
  plannerRunId: 'run-repair',
  storyId: 'B-repair',
  mode: 'local',
  until: 'TEST',
  developmentWorkflow: 'standard',
  plannedSteps: [],
  coverageMap: [],
  providerPolicy: pp,
  retryPolicy: rp,
  stopPolicy: sp,
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
  evidenceBinding: 'B-repair:repair',
  args: { operation: 'repair', argv: ['exec', '--repair'] },
  ...over,
});

const execStub = (result: Partial<ProviderExecResult> = {}): BoundedProviderExecutor => ({
  available: () => true,
  run: (req): ProviderExecResult => ({
    provider: req.provider,
    argvDigest: 'argv-digest',
    exitCode: 0,
    stdoutDigest: 'stdout-digest',
    stderrDigest: 'stderr-digest',
    stdoutBytes: 4,
    stderrBytes: 0,
    durationMs: 5,
    attempts: 1,
    timedOut: false,
    spawnError: false,
    ...result,
  }),
});

const env = { CODEX_KEY: 'secret', PATH: '/usr/bin' };

// 2a. a real repaired provider that fixes validation -> validated_after_repair.
{
  const r = executeProviderBackedRepairRetry({
    root,
    jobPlan: jobPlanFor(providerPolicy(), retryPolicy(), stopPolicy()) as any,
    repairStep: repairStep() as any,
    env,
    providerExecutor: execStub({ exitCode: 0 }),
    validate: (i) => ({ passed: i >= 1, digest: `v-${i}` }),
  });
  assert.equal(r.status, 'validated');
  assert.equal(r.stopReason, 'validation_passed_after_repair');
  assert.equal(r.validationSatisfied, true);
  assert.equal(r.repairAttemptsUsed, 1);
  assert.equal(r.providerAttemptsUsed, 1);
  assertInvariants(r);
}

// 2b. repair provider whose every bounded attempt times out -> no_progress.
{
  let runs = 0;
  const r = executeProviderBackedRepairRetry({
    root,
    jobPlan: jobPlanFor(providerPolicy(), retryPolicy({ maxNoProgressIterations: 2 }), stopPolicy()) as any,
    repairStep: repairStep({ maxAttempts: 2 }) as any,
    env,
    providerExecutor: { available: () => true, run: (req): ProviderExecResult => { runs++; return execStub({ timedOut: true, attempts: 2 }).run(req); } },
    validate: () => ({ passed: false, digest: 'v-stuck' }),
  });
  assert.equal(r.status, 'blocked');
  assert.equal(r.stopReason, 'no_progress', 'identical timeout evidence + failing validation hashes the same -> no_progress');
  assert.equal(r.repairAttemptsUsed, 3, 'first repair changed material (no repair evidence -> evidence), then 2 unchanging rounds tripped no_progress');
  assert.equal(r.providerAttemptsUsed, 6, 'each repair spent its 2-attempt timeout budget');
  assert.equal(runs, 3);
  assertInvariants(r);
}

// 2c. CRITICAL: a provider that exits 0 ("repaired") but validation still fails
// must NOT be promoted to validated. Repair cannot bypass validation.
{
  const r = executeProviderBackedRepairRetry({
    root,
    jobPlan: jobPlanFor(providerPolicy(), retryPolicy({ maxRepairAttempts: 5, maxNoProgressIterations: 2 }), stopPolicy()) as any,
    repairStep: repairStep() as any,
    env,
    providerExecutor: execStub({ exitCode: 0 }), // provider "succeeds" every time
    validate: () => ({ passed: false, digest: 'v-still-fails' }), // but validation never passes
  });
  assert.equal(r.status, 'blocked');
  assert.equal(r.validationSatisfied, false, 'provider exit 0 must never satisfy validation');
  assert.equal(r.stopReason, 'no_progress');
  assertInvariants(r);
}

// 2d. a non-provider repair step cannot make progress -> provider_unavailable.
{
  const r = executeProviderBackedRepairRetry({
    root,
    jobPlan: jobPlanFor(providerPolicy(), retryPolicy(), stopPolicy()) as any,
    repairStep: repairStep({ type: 'validate.run', provider: undefined, args: { operation: 'validate.run' } }) as any,
    env,
    providerExecutor: execStub(),
    validate: () => ({ passed: false, digest: 'v' }),
  });
  assert.equal(r.stopReason, 'repair_provider_unavailable');
  assert.equal(r.repairAttemptsUsed, 1);
  assertInvariants(r);
}

// 2e. policy gating is reused: a provider not in allowedProviders is unavailable.
{
  const r = executeProviderBackedRepairRetry({
    root,
    jobPlan: jobPlanFor(providerPolicy({ allowedProviders: [] }), retryPolicy(), stopPolicy()) as any,
    repairStep: repairStep() as any,
    env,
    providerExecutor: execStub(),
    validate: () => ({ passed: false, digest: 'v' }),
  });
  assert.equal(r.stopReason, 'repair_provider_unavailable', 'a policy-disabled provider repair step fails closed as unavailable');
  assertInvariants(r);
}

// 2f. resolveRepairRetryPolicy maps disjoint retry/stop blocks defensively.
{
  const mapped = resolveRepairRetryPolicy(jobPlanFor(providerPolicy(), retryPolicy({ maxRepairAttempts: 4 }), stopPolicy({ onValidationFailure: 'block' })) as any);
  assert.equal(mapped.maxRepairAttempts, 4);
  assert.equal(mapped.onValidationFailure, 'block');
  assert.equal(mapped.onProviderFailure, 'retry_then_block');
  // missing blocks collapse to a safe, repair-disabled default after normalization
  const empty = normalizeRepairRetryPolicy(resolveRepairRetryPolicy({} as any));
  assert.equal(empty.repairAllowed, false, 'a JobPlan with no retryPolicy defaults to repair disabled');
  assert.equal(empty.maxRepairAttempts, 0);
}

console.log('✓ repair-retry-loop smoke passed: outer validation/repair/revalidate loop, configured repair provider step, provider timeout retry budget, cross-iteration no-progress via material/evidence hash, exact blocked stop reasons after limits, repair never bypasses validation/gate/multi-host, and defensive policy normalization verified');
