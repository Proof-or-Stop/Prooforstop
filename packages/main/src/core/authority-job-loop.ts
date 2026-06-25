import { createHash } from 'node:crypto';

// ===========================================================================
// Stage B job-loop lease / heartbeat / renew / release / complete semantics
// (§B1 lease shape, §B7 executor loop, §B12 heartbeat+lease+idempotency,
//  §B17 failure/stop semantics, §X5 idempotency). M9 / M11.
//
// This module is a pure, deterministic state machine over a CLAIMED authority
// job lease. It owns the safety boundary, not the network: the actual
// heartbeat / renew / release / complete calls are injected as a synchronous
// `JobLeaseTransport`, so the loop can be exercised exhaustively without a live
// Proofbound Authority server (the same pattern the gate evaluator uses to keep
// async I/O out of the deterministic executor core).
//
// Hard invariants enforced here:
// - a claimed job is ALWAYS either completed or released — never left dangling;
// - the executor heartbeats before/after long steps, before the gate, and
//   before release/completion, renewing the lease before it crosses
//   `renewalThresholdMs`;
// - completion FAILS CLOSED on a stale/expired lease — `graceMs` is diagnostic
//   only and must never be used to claim DONE after the lease is unsafe;
// - completion requires a verified receipt (when the target requires one) AND a
//   satisfied final policy; otherwise the job is released, not completed;
// - release and complete are idempotent: a retried release/complete with the
//   same job result digest never double-fires the transport or produces a
//   conflicting record.
// ===========================================================================

/** Lease health relative to the current clock. */
export type LeaseHealth = 'safe' | 'grace' | 'expired';

/**
 * Points in the executor loop where a heartbeat is mandatory (§B12). The loop
 * heartbeats (and renews when within the threshold) at each of these phases.
 */
export type HeartbeatPhase =
  | 'after-claim'
  | 'before-step'
  | 'after-step'
  | 'before-gate'
  | 'before-release'
  | 'before-completion';

export const HEARTBEAT_PHASES: readonly HeartbeatPhase[] = [
  'after-claim',
  'before-step',
  'after-step',
  'before-gate',
  'before-release',
  'before-completion',
] as const;

/**
 * Runtime view of a claimed lease. Unlike the planner's `JobLease` (whose
 * claim-time fields are null and whose `leaseExpiresAt` is an ISO string), this
 * is the live, claimed shape: every identity field is present and
 * `leaseExpiresAt` is an epoch-ms number for deterministic clock math.
 */
export interface ActiveLease {
  leaseId: string;
  leasedByRunnerId: string;
  leasedBySessionId: string;
  /** Epoch milliseconds. */
  leaseExpiresAt: number;
  leaseTtlMs: number;
  renewalThresholdMs: number;
  graceMs: number;
  leaseVersion: number;
}

export type JobLeaseStatus = 'active' | 'released' | 'completed';

// --- Injected transport -----------------------------------------------------
// Synchronous so the loop stays deterministic and server-free in tests. A live
// caller adapts the async AuthorityClient (heartbeatJob / releaseJob) behind
// these synchronous boundaries, or runs the network call first and feeds the
// result in.

export interface LeaseRenewResult {
  ok: boolean;
  /** New epoch-ms expiry returned by the server. */
  leaseExpiresAt?: number;
  /** Server-assigned lease version; a renewal increments it (§B1). */
  leaseVersion?: number;
  message?: string;
}

export interface LeaseReleaseResult {
  ok: boolean;
  message?: string;
}

export interface LeaseCompleteResult {
  ok: boolean;
  /**
   * The server rejected completion because the held lease version is stale
   * (another runner renewed/took the lease). Surfaced so the loop can fail
   * closed with a precise reason instead of a generic rejection.
   */
  staleLease?: boolean;
  message?: string;
}

export interface JobLeaseTransport {
  /**
   * Heartbeat (keep-alive) or renew the lease. `renew=true` signals the loop
   * crossed `renewalThresholdMs` and expects a version bump.
   */
  renew(input: {
    jobId: string;
    leaseId: string;
    leaseVersion: number;
    renew: boolean;
    phase: HeartbeatPhase;
  }): LeaseRenewResult;
  release(input: {
    jobId: string;
    leaseId: string;
    leaseVersion: number;
    reason: string;
  }): LeaseReleaseResult;
  complete(input: {
    jobId: string;
    leaseId: string;
    leaseVersion: number;
    resultDigest: string;
  }): LeaseCompleteResult;
}

export interface HeartbeatOutcome {
  phase: HeartbeatPhase;
  ok: boolean;
  /** Whether this heartbeat was promoted to a lease renewal. */
  renewed: boolean;
  /**
   * Whether the lease is safe to keep working under AFTER this heartbeat. A
   * failed heartbeat that leaves the lease past expiry sets this false so the
   * loop stops and releases (§B17 heartbeat failure → stop/release if unsafe).
   */
  leaseSafe: boolean;
  health: LeaseHealth;
  leaseVersion: number;
  leaseExpiresAt: number;
  message?: string;
}

export interface ReleaseOutcome {
  ok: boolean;
  /** True when the call was a no-op because the lease was already terminal. */
  idempotent: boolean;
  reason: string;
  message?: string;
}

export interface CompleteInput {
  resultDigest: string;
  /** Whether this target requires a verified native gate_decision receipt. */
  receiptRequired: boolean;
  /** Whether such a receipt was independently verified (fail-closed default). */
  receiptVerified: boolean;
  /**
   * Whether the final policy (validation passed, required evidence uploaded,
   * lifecycle satisfied) holds. Completion requires this true.
   */
  finalPolicySatisfied: boolean;
}

export interface CompleteOutcome {
  ok: boolean;
  /** True when a retried completion with the same digest was a cached no-op. */
  idempotent: boolean;
  /** Set when completion was refused; never undefined on `ok=false`. */
  failClosedReason?: string;
  message?: string;
}

export interface JobLeaseSnapshot {
  jobId: string;
  status: JobLeaseStatus;
  lease: ActiveLease;
  lastHeartbeatAt: number | null;
  lastLeaseRenewalAt: number | null;
  heartbeatCount: number;
  renewalCount: number;
  releaseReason: string | null;
  completionDigest: string | null;
}

export interface AuthorityJobLoop {
  /** Immutable snapshot of the current lease runtime state. */
  snapshot(): JobLeaseSnapshot;
  status(): JobLeaseStatus;
  leaseHealth(): LeaseHealth;
  /** True when now has crossed `leaseExpiresAt - renewalThresholdMs`. */
  needsRenewal(): boolean;
  /** Heartbeat (renewing when within the threshold) at a loop phase. */
  heartbeat(phase: HeartbeatPhase): HeartbeatOutcome;
  /** Idempotently release the job lease with a reason (§B12, §X5). */
  release(reason: string): ReleaseOutcome;
  /** Idempotently complete the job; fails closed on stale lease / unmet gates. */
  complete(input: CompleteInput): CompleteOutcome;
}

export interface AuthorityJobLoopOptions {
  jobId: string;
  lease: ActiveLease;
  transport: JobLeaseTransport;
  /** Injectable clock (epoch ms). Defaults to Date.now. */
  now?: () => number;
}

/** Deterministic sha256 over a JSON-serializable job result (§X5 digest). */
export function jobResultDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null), 'utf8').digest('hex');
}

export interface ClaimedLeaseInput {
  leaseId: unknown;
  leasedByRunnerId: unknown;
  leasedBySessionId: unknown;
  /** ISO 8601 string or epoch-ms number. */
  leaseExpiresAt: unknown;
  leaseTtlMs: number;
  renewalThresholdMs: number;
  graceMs: number;
  leaseVersion?: number;
}

export type ParseClaimedLeaseResult =
  | { ok: true; lease: ActiveLease }
  | { ok: false; reason: string };

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * Coerce an untrusted claim response into a runtime `ActiveLease`. Fails closed
 * when any required claimed-job lease field is missing or inconsistent (§B1:
 * leaseId / leasedByRunnerId / leasedBySessionId / leaseExpiresAt are required
 * on claimed jobs; renewalThreshold must be < ttl so renewal precedes expiry).
 */
export function parseClaimedLease(input: ClaimedLeaseInput): ParseClaimedLeaseResult {
  if (!nonEmptyString(input.leaseId)) {
    return { ok: false, reason: 'claimed lease leaseId must be a non-empty string' };
  }
  if (!nonEmptyString(input.leasedByRunnerId)) {
    return { ok: false, reason: 'claimed lease leasedByRunnerId must be a non-empty string' };
  }
  if (!nonEmptyString(input.leasedBySessionId)) {
    return { ok: false, reason: 'claimed lease leasedBySessionId must be a non-empty string' };
  }
  const leaseExpiresAt = toEpochMs(input.leaseExpiresAt);
  if (leaseExpiresAt === null) {
    return { ok: false, reason: 'claimed lease leaseExpiresAt must be an ISO timestamp or epoch ms' };
  }
  if (!(input.leaseTtlMs > 0)) {
    return { ok: false, reason: 'claimed lease leaseTtlMs must be > 0' };
  }
  if (!(input.renewalThresholdMs > 0)) {
    return { ok: false, reason: 'claimed lease renewalThresholdMs must be > 0' };
  }
  if (!(input.renewalThresholdMs < input.leaseTtlMs)) {
    return { ok: false, reason: 'claimed lease renewalThresholdMs must be < leaseTtlMs so renewal happens before expiry' };
  }
  if (input.graceMs < 0) {
    return { ok: false, reason: 'claimed lease graceMs must be >= 0' };
  }
  const leaseVersion = input.leaseVersion ?? 0;
  if (!Number.isInteger(leaseVersion) || leaseVersion < 0) {
    return { ok: false, reason: 'claimed lease leaseVersion must be an integer >= 0' };
  }
  return {
    ok: true,
    lease: {
      leaseId: input.leaseId,
      leasedByRunnerId: input.leasedByRunnerId,
      leasedBySessionId: input.leasedBySessionId,
      leaseExpiresAt,
      leaseTtlMs: input.leaseTtlMs,
      renewalThresholdMs: input.renewalThresholdMs,
      graceMs: input.graceMs,
      leaseVersion,
    },
  };
}

/**
 * Create a job-loop controller bound to a claimed lease and an injected
 * transport. The returned object is the only thing the executor talks to for
 * lease lifecycle; all safety boundaries (renewal timing, stale-lease
 * fail-closed, idempotency) live here.
 */
export function createAuthorityJobLoop(options: AuthorityJobLoopOptions): AuthorityJobLoop {
  const { jobId, transport } = options;
  const now = options.now ?? (() => Date.now());

  const lease: ActiveLease = { ...options.lease };
  let status: JobLeaseStatus = 'active';
  let lastHeartbeatAt: number | null = null;
  let lastLeaseRenewalAt: number | null = null;
  let heartbeatCount = 0;
  let renewalCount = 0;
  let releaseReason: string | null = null;
  let completionDigest: string | null = null;
  // Cache the terminal transport outcomes so a retried release/complete is a
  // true no-op (idempotent) rather than a second network effect.
  let cachedRelease: ReleaseOutcome | null = null;

  function leaseHealth(): LeaseHealth {
    const t = now();
    if (t < lease.leaseExpiresAt) return 'safe';
    if (t < lease.leaseExpiresAt + lease.graceMs) return 'grace';
    return 'expired';
  }

  function needsRenewal(): boolean {
    // Renew once the clock crosses (expiry - threshold), i.e. the lease has less
    // than `renewalThresholdMs` of life left.
    return now() >= lease.leaseExpiresAt - lease.renewalThresholdMs;
  }

  function snapshot(): JobLeaseSnapshot {
    return {
      jobId,
      status,
      lease: { ...lease },
      lastHeartbeatAt,
      lastLeaseRenewalAt,
      heartbeatCount,
      renewalCount,
      releaseReason,
      completionDigest,
    };
  }

  function heartbeat(phase: HeartbeatPhase): HeartbeatOutcome {
    const renew = needsRenewal();
    const result = transport.renew({
      jobId,
      leaseId: lease.leaseId,
      leaseVersion: lease.leaseVersion,
      renew,
      phase,
    });
    const t = now();
    if (result.ok) {
      lastHeartbeatAt = t;
      heartbeatCount += 1;
      if (typeof result.leaseExpiresAt === 'number' && Number.isFinite(result.leaseExpiresAt)) {
        lease.leaseExpiresAt = result.leaseExpiresAt;
      }
      if (typeof result.leaseVersion === 'number' && Number.isInteger(result.leaseVersion)) {
        if (result.leaseVersion > lease.leaseVersion) {
          renewalCount += 1;
          lastLeaseRenewalAt = t;
        }
        lease.leaseVersion = result.leaseVersion;
      } else if (renew) {
        // Server accepted a renew but echoed no version: bump locally so a later
        // stale completion still has a monotonic version to compare.
        lease.leaseVersion += 1;
        renewalCount += 1;
        lastLeaseRenewalAt = t;
      }
      const health = leaseHealth();
      return {
        phase,
        ok: true,
        renewed: renew,
        leaseSafe: health === 'safe',
        health,
        leaseVersion: lease.leaseVersion,
        leaseExpiresAt: lease.leaseExpiresAt,
        message: result.message,
      };
    }
    // Heartbeat failed: the lease is only safe to keep working under if the
    // clock is still strictly before expiry (grace is diagnostic, not safe).
    const health = leaseHealth();
    return {
      phase,
      ok: false,
      renewed: false,
      leaseSafe: health === 'safe',
      health,
      leaseVersion: lease.leaseVersion,
      leaseExpiresAt: lease.leaseExpiresAt,
      message: result.message ?? 'lease heartbeat failed',
    };
  }

  function release(reason: string): ReleaseOutcome {
    if (status === 'released' && cachedRelease) {
      return { ...cachedRelease, idempotent: true };
    }
    if (status === 'completed') {
      // A completed job has already ended its lease; releasing it is a no-op.
      return { ok: true, idempotent: true, reason: releaseReason ?? reason, message: 'job already completed; release is a no-op' };
    }
    const result = transport.release({
      jobId,
      leaseId: lease.leaseId,
      leaseVersion: lease.leaseVersion,
      reason,
    });
    status = 'released';
    releaseReason = reason;
    cachedRelease = {
      ok: result.ok,
      idempotent: false,
      reason,
      message: result.message,
    };
    return cachedRelease;
  }

  function complete(input: CompleteInput): CompleteOutcome {
    if (status === 'completed') {
      if (completionDigest === input.resultDigest) {
        return { ok: true, idempotent: true, message: 'job already completed with matching result digest' };
      }
      return {
        ok: false,
        idempotent: false,
        failClosedReason: 'job-already-completed-with-different-result-digest',
        message: 'refusing to complete an already-completed job with a different result digest',
      };
    }
    if (status === 'released') {
      return {
        ok: false,
        idempotent: false,
        failClosedReason: 'job-already-released',
        message: 'cannot complete a job whose lease was already released',
      };
    }
    // Final-policy gates BEFORE touching the lease: a job that has not earned
    // completion is never completed (it should be released by the caller).
    if (input.receiptRequired && !input.receiptVerified) {
      return {
        ok: false,
        idempotent: false,
        failClosedReason: 'authority-done-requires-verified-gate-decision-receipt',
        message: 'completion blocked: target requires a verified native gate_decision receipt',
      };
    }
    if (!input.finalPolicySatisfied) {
      return {
        ok: false,
        idempotent: false,
        failClosedReason: 'final-policy-not-satisfied',
        message: 'completion blocked: final policy (validation/evidence/lifecycle) is not satisfied',
      };
    }
    // Stale-lease fail-closed: completion requires a SAFE lease. `grace` and
    // `expired` are both unsafe for DONE — grace is diagnostic only (§B1).
    const health = leaseHealth();
    if (health !== 'safe') {
      return {
        ok: false,
        idempotent: false,
        failClosedReason: `stale-lease:${health}`,
        message: `completion blocked: lease is ${health}, not safe; releasing instead of completing`,
      };
    }
    const result = transport.complete({
      jobId,
      leaseId: lease.leaseId,
      leaseVersion: lease.leaseVersion,
      resultDigest: input.resultDigest,
    });
    if (!result.ok) {
      return {
        ok: false,
        idempotent: false,
        failClosedReason: result.staleLease ? 'stale-lease:version' : 'completion-rejected',
        message: result.message ?? 'authority server rejected job completion',
      };
    }
    status = 'completed';
    completionDigest = input.resultDigest;
    return { ok: true, idempotent: false, message: result.message };
  }

  return { snapshot, status: () => status, leaseHealth, needsRenewal, heartbeat, release, complete };
}

// --- Finalization helper ----------------------------------------------------
// Ties the §B7 tail together: heartbeat before completion, then either complete
// (verified receipt + satisfied policy + safe lease) or release. Always leaves
// the lease terminal.

export interface FinalizeAuthorityJobInput {
  loop: AuthorityJobLoop;
  resultDigest: string;
  receiptRequired: boolean;
  receiptVerified: boolean;
  finalPolicySatisfied: boolean;
  /** Reason recorded when the job is released instead of completed. */
  releaseReason: string;
}

export interface FinalizeAuthorityJobResult {
  disposition: 'completed' | 'released';
  completed: boolean;
  /** Set when completion was refused and the job was released instead. */
  failClosedReason?: string;
  releaseReason?: string;
  heartbeat: HeartbeatOutcome;
  complete: CompleteOutcome | null;
  snapshot: JobLeaseSnapshot;
}

/**
 * Drive the §B7 tail for one job: a mandatory `before-completion` heartbeat,
 * then complete-or-release. A failed/unsafe heartbeat, an unmet receipt/policy
 * gate, or a stale-lease completion rejection all fall through to a clean
 * release — the job is never left dangling, and DONE is never claimed on an
 * unsafe lease.
 */
export function finalizeAuthorityJob(input: FinalizeAuthorityJobInput): FinalizeAuthorityJobResult {
  const { loop } = input;
  const hb = loop.heartbeat('before-completion');

  if (!hb.leaseSafe) {
    const reason = `lease-unsafe:${hb.health}`;
    const released = loop.release(reason);
    return {
      disposition: 'released',
      completed: false,
      failClosedReason: reason,
      releaseReason: released.reason,
      heartbeat: hb,
      complete: null,
      snapshot: loop.snapshot(),
    };
  }

  const done = loop.complete({
    resultDigest: input.resultDigest,
    receiptRequired: input.receiptRequired,
    receiptVerified: input.receiptVerified,
    finalPolicySatisfied: input.finalPolicySatisfied,
  });

  if (done.ok) {
    return {
      disposition: 'completed',
      completed: true,
      heartbeat: hb,
      complete: done,
      snapshot: loop.snapshot(),
    };
  }

  const released = loop.release(input.releaseReason);
  return {
    disposition: 'released',
    completed: false,
    failClosedReason: done.failClosedReason,
    releaseReason: released.reason,
    heartbeat: hb,
    complete: done,
    snapshot: loop.snapshot(),
  };
}
