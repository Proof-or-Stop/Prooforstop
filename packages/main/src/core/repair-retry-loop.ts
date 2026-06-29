import { createHash } from 'node:crypto';
import type { StopBehavior } from './planner.js';

/**
 * Repair / retry / stop-policy loop engine (§B5, M9).
 *
 * The deterministic planned-steps executor runs each planned step at most once,
 * so its `no_progress` classification was a single-pass projection: a provider
 * step whose bounded attempt budget all timed out. The actual §B5 contract is an
 * OUTER loop around a validation step:
 *
 *   validate -> (fail) -> repair (configured provider step) -> revalidate -> ...
 *
 * bounded by `retryPolicy` (maxAttemptsPerStep / maxRepairAttempts /
 * maxNoProgressIterations / repairAllowed) and shaped by `stopPolicy`
 * (onValidationFailure / onProviderFailure). This module is that loop, expressed
 * as a pure, dependency-injected engine so it can be exercised deterministically
 * without spawning a real provider, and so a future live executor can drive it
 * with provider-backed hooks.
 *
 * Hard invariants the loop NEVER violates (requirement: repair cannot bypass
 * validation / gate / multi-host):
 *
 * - repair never directly satisfies validation; the loop ALWAYS revalidates with
 *   a fresh validation probe after every repair attempt;
 * - `validationSatisfied` is true only when a real validation probe returned
 *   `passed`, never inferred from a repair provider exit code or prose;
 * - the loop confers no remote completion status: `authorityDone`, `receiptVerified`, and
 *   `multiHostVerified` are hardcoded `false` in every result, and `validated`
 *   means "validation passed", which is a precondition for the gate, not DONE.
 */

export type RepairRetryStatus = 'validated' | 'blocked';

export type RepairRetryStopReason =
  | 'validation_passed'
  | 'validation_passed_after_repair'
  | 'repair_not_allowed'
  | 'no_progress'
  | 'max_repair_attempts_exhausted'
  | 'repair_provider_unavailable'
  | 'repair_provider_failed';

/** Outcome of one bounded repair provider invocation (timeout retry is internal to it). */
export type RepairProviderOutcome =
  | 'repaired'              // provider exited 0
  | 'provider_failed'      // provider exited non-zero
  | 'provider_timeout'     // every bounded attempt timed out
  | 'provider_unavailable'; // provider CLI missing / not enabled / no credential

export interface RepairRetryPolicy {
  /** Provider attempts inside a single repair step (timeout retry budget). */
  maxAttemptsPerStep: number;
  /** Outer repair iterations the loop may run. 0 disables repair entirely. */
  maxRepairAttempts: number;
  /** Consecutive no-progress iterations tolerated before a `no_progress` stop. */
  maxNoProgressIterations: number;
  repairAllowed: boolean;
  retryableFailureKinds: readonly string[];
  onValidationFailure: StopBehavior;
  onProviderFailure: StopBehavior;
}

export interface ValidationProbeResult {
  passed: boolean;
  /** Digest of the validation result; feeds the material/evidence no-progress hash. */
  digest: string;
  reason?: string;
}

export interface RepairProbeResult {
  outcome: RepairProviderOutcome;
  /** Provider attempts actually spent (>=1); surfaces the timeout retry budget usage. */
  attempts: number;
  /** Digest of the repair provider evidence; feeds the material/evidence hash. */
  evidenceDigest: string;
}

/**
 * Injected side-effecting hooks. `iteration` is 0 for the initial validation and
 * 1..N for each repair round. `materialHash` MUST reflect the current worktree /
 * evidence material so the loop can detect a repair that changed nothing.
 */
export interface RepairRetryHooks {
  validate: (iteration: number) => ValidationProbeResult;
  repair: (iteration: number) => RepairProbeResult;
  materialHash: (iteration: number) => string;
}

export interface RepairRetryIteration {
  iteration: number;
  phase: 'validate' | 'revalidate';
  validationPassed: boolean;
  validationDigest: string;
  repairOutcome?: RepairProviderOutcome;
  repairAttempts?: number;
  materialHash: string;
  materialChanged: boolean;
  noProgressStreak: number;
}

export interface RepairRetryLoopResult {
  status: RepairRetryStatus;
  stopReason: RepairRetryStopReason;
  /** True ONLY when a real validation probe passed. Never inferred from repair. */
  validationSatisfied: boolean;
  repairAttemptsUsed: number;
  providerAttemptsUsed: number;
  noProgressStreak: number;
  /** Lifecycle signal: validation failure with `return_to_dev` behavior asks DEV. */
  returnToDev: boolean;
  iterations: RepairRetryIteration[];
  /** Hard invariants — the repair loop never confers authority/gate/multi-host status. */
  bypassedValidation: false;
  authorityDone: false;
  receiptVerified: false;
  multiHostVerified: false;
  loopDigest: string;
}

const VALID_STOP_BEHAVIORS: ReadonlySet<StopBehavior> = new Set([
  'block', 'return_to_dev', 'retry_then_block', 'repair_then_reverify',
]);

function boundedInt(value: unknown, fallback: number, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored < min ? min : floored;
}

function stopBehavior(value: unknown, fallback: StopBehavior): StopBehavior {
  return VALID_STOP_BEHAVIORS.has(value as StopBehavior) ? (value as StopBehavior) : fallback;
}

/**
 * Defensive normalization (Handler encoding convention): never trust the raw
 * policy shape. Out-of-range / wrong-typed fields collapse to conservative,
 * bounded defaults so the loop is always finite and fail-closed.
 */
export function normalizeRepairRetryPolicy(raw: Partial<RepairRetryPolicy> | undefined | null): RepairRetryPolicy {
  const policy = raw && typeof raw === 'object' ? raw : {};
  return {
    maxAttemptsPerStep: boundedInt(policy.maxAttemptsPerStep, 1, 1),
    maxRepairAttempts: boundedInt(policy.maxRepairAttempts, 0, 0),
    maxNoProgressIterations: boundedInt(policy.maxNoProgressIterations, 1, 1),
    repairAllowed: policy.repairAllowed === true,
    retryableFailureKinds: Array.isArray(policy.retryableFailureKinds)
      ? policy.retryableFailureKinds.filter((k): k is string => typeof k === 'string' && k.trim() !== '')
      : [],
    onValidationFailure: stopBehavior(policy.onValidationFailure, 'return_to_dev'),
    onProviderFailure: stopBehavior(policy.onProviderFailure, 'retry_then_block'),
  };
}

function loopDigest(policy: RepairRetryPolicy, iterations: RepairRetryIteration[], stopReason: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ policy, iterations, stopReason }), 'utf8')
    .digest('hex');
}

/**
 * Run the bounded repair / retry loop.
 *
 * The loop is always finite: it is bounded by `maxRepairAttempts` (the outer
 * repair budget) AND by `maxNoProgressIterations` (consecutive iterations whose
 * material/evidence hash did not change). Whichever limit is hit first produces a
 * distinct, exact `stopReason`. A missing provider (`provider_unavailable`) or a
 * `provider_failed` under an `onProviderFailure: 'block'` policy fails closed
 * immediately rather than burning the whole budget.
 */
export function runRepairRetryLoop(
  rawPolicy: Partial<RepairRetryPolicy> | undefined,
  hooks: RepairRetryHooks,
): RepairRetryLoopResult {
  const policy = normalizeRepairRetryPolicy(rawPolicy);
  const iterations: RepairRetryIteration[] = [];
  let providerAttemptsUsed = 0;
  let repairAttemptsUsed = 0;
  let noProgressStreak = 0;

  const finalize = (
    status: RepairRetryStatus,
    stopReason: RepairRetryStopReason,
    validationSatisfied: boolean,
    returnToDev: boolean,
  ): RepairRetryLoopResult => ({
    status,
    stopReason,
    validationSatisfied,
    repairAttemptsUsed,
    providerAttemptsUsed,
    noProgressStreak,
    returnToDev,
    iterations,
    bypassedValidation: false,
    authorityDone: false,
    receiptVerified: false,
    multiHostVerified: false,
    loopDigest: loopDigest(policy, iterations, stopReason),
  });

  // --- Iteration 0: the initial validation that may open the repair loop. ----
  const v0 = hooks.validate(0);
  const m0 = hooks.materialHash(0);
  iterations.push({
    iteration: 0,
    phase: 'validate',
    validationPassed: v0.passed,
    validationDigest: v0.digest,
    materialHash: m0,
    materialChanged: false,
    noProgressStreak: 0,
  });
  if (v0.passed) {
    return finalize('validated', 'validation_passed', true, false);
  }

  // Repair is opt-in: it runs only when the policy explicitly allows it AND there
  // is a non-zero repair budget. Otherwise the loop hands the failure back to the
  // lifecycle (return_to_dev) or blocks, but it never silently "passes".
  if (!policy.repairAllowed || policy.maxRepairAttempts <= 0) {
    const returnToDev = policy.onValidationFailure === 'return_to_dev';
    return finalize('blocked', 'repair_not_allowed', false, returnToDev);
  }

  let prevMaterialHash = m0;

  while (repairAttemptsUsed < policy.maxRepairAttempts) {
    const iterationNo = repairAttemptsUsed + 1;
    const repairResult = hooks.repair(iterationNo);
    repairAttemptsUsed++;
    providerAttemptsUsed += Math.max(1, boundedInt(repairResult.attempts, 1, 1));

    // Fail closed: a missing / unusable provider cannot make progress; do not
    // burn the rest of the budget pretending it might.
    if (repairResult.outcome === 'provider_unavailable') {
      iterations.push({
        iteration: iterationNo,
        phase: 'revalidate',
        validationPassed: false,
        validationDigest: '',
        repairOutcome: repairResult.outcome,
        repairAttempts: repairResult.attempts,
        materialHash: prevMaterialHash,
        materialChanged: false,
        noProgressStreak,
      });
      return finalize('blocked', 'repair_provider_unavailable', false, false);
    }

    // A hard provider failure under an explicit `block` stop behavior stops now.
    // Softer behaviors (retry_then_block / repair_then_reverify) fall through to
    // the revalidate + no-progress accounting below.
    if (repairResult.outcome === 'provider_failed' && policy.onProviderFailure === 'block') {
      iterations.push({
        iteration: iterationNo,
        phase: 'revalidate',
        validationPassed: false,
        validationDigest: '',
        repairOutcome: repairResult.outcome,
        repairAttempts: repairResult.attempts,
        materialHash: prevMaterialHash,
        materialChanged: false,
        noProgressStreak,
      });
      return finalize('blocked', 'repair_provider_failed', false, false);
    }

    // Repair NEVER directly satisfies validation — always revalidate fresh.
    const v = hooks.validate(iterationNo);
    const mh = hooks.materialHash(iterationNo);
    const materialChanged = mh !== prevMaterialHash;
    noProgressStreak = materialChanged ? 0 : noProgressStreak + 1;
    prevMaterialHash = mh;

    iterations.push({
      iteration: iterationNo,
      phase: 'revalidate',
      validationPassed: v.passed,
      validationDigest: v.digest,
      repairOutcome: repairResult.outcome,
      repairAttempts: repairResult.attempts,
      materialHash: mh,
      materialChanged,
      noProgressStreak,
    });

    if (v.passed) {
      return finalize('validated', 'validation_passed_after_repair', true, false);
    }

    // Cross-iteration no-progress: a repair that changed nothing about the
    // material/evidence hash for N consecutive rounds cannot converge.
    if (noProgressStreak >= policy.maxNoProgressIterations) {
      return finalize('blocked', 'no_progress', false, false);
    }
  }

  // Outer repair budget exhausted without validation ever passing.
  return finalize('blocked', 'max_repair_attempts_exhausted', false, false);
}
