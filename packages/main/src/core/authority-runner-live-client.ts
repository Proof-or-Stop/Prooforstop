// Live Authority runner client adapter (Stage B loop wiring).
//
// This module is the thin, fail-closed seam between the live async
// `AuthorityClient` (heartbeatJob / releaseJob / claimJob) and the deterministic,
// server-free Stage B job-loop state machine (`createAuthorityJobLoop` /
// `finalizeAuthorityJob`). The job loop's `JobLeaseTransport` is intentionally
// synchronous so the safety boundary stays deterministic and testable; this
// module performs the network call first and feeds the mapped result into the
// loop's sync transport (the pattern blessed by authority-job-loop.ts's banner).
//
// What it provides:
//   1. `adaptClaimedJobResponse` — coerce a `/v1/runners/{runnerId}/jobs/claim`
//      response (legacy `{ job: JobSpec }` or Python `{ job: JobRecord{spec,...} }`
//      shape) into a typed `ClaimedAuthorityJob` PLUS a runtime `ActiveLease`,
//      reusing the existing fail-closed parsers (`parseClaimedAuthorityJob` /
//      `parseClaimedLease`). No server API change: it maps the typed JobSpec +
//      the JobRecord/JobSpec free-form `metadata` where Stage B carries
//      plannedSteps[], mode/until, policy, and lease fields.
//   2. Pure mappers from `AuthorityClientOutcome` to the loop's `Lease*Result`
//      shapes, classifying no-job / malformed / stale-lease / server-rejection
//      into structured, fail-closed outcomes.
//   3. `createLiveAuthorityJobLease` — a live driver that wires the async client
//      to a sync `JobLeaseTransport`, exposing async heartbeat / release /
//      complete / finalize that drive the loop without ever leaving the lease
//      dangling and without claiming DONE on an unsafe lease or unverified receipt.
//
// Hard invariants (inherited from the job loop, never relaxed here):
//   - a claimed job is ALWAYS completed or released, never dangling;
//   - completion fails closed on a stale/expired lease or an unverified receipt;
//   - `complete` performs the completion network call ONLY when the loop's own
//     gates would fire (no premature completion POST on an unmet gate).

import type { AuthorityClient, AuthorityClientOutcome } from './authority-client.js';
import {
  JobSpecSchema,
  type JobReleaseOutcome,
} from './authority-runner-contracts.js';
import {
  createAuthorityJobLoop,
  parseClaimedLease,
  type ActiveLease,
  type AuthorityJobLoop,
  type CompleteInput,
  type CompleteOutcome,
  type FinalizeAuthorityJobResult,
  type HeartbeatOutcome,
  type HeartbeatPhase,
  type JobLeaseTransport,
  type LeaseCompleteResult,
  type LeaseRenewResult,
  type LeaseReleaseResult,
  type ReleaseOutcome,
} from './authority-job-loop.js';
import { parseClaimedAuthorityJob, type ClaimedAuthorityJob } from './authority-runner.js';
import { signCanonical, stripSignature, type PrivateKeyBase64 } from './authority-signing.js';

// ─────────────────────────────────────────────────────────────────────────────
// Claim-response → ClaimedAuthorityJob + ActiveLease adapter
// ─────────────────────────────────────────────────────────────────────────────

/** Client-side lease policy defaults when the server omits the timing knobs. */
export const DEFAULT_CLAIMED_LEASE_TTL_MS = 60_000;
export const DEFAULT_CLAIMED_LEASE_RENEWAL_MS = 20_000;
export const DEFAULT_CLAIMED_LEASE_GRACE_MS = 5_000;

export interface AdaptClaimedJobContext {
  /** Runner that issued the claim; used as the lease holder when the body omits it. */
  runnerId: string;
  /** Session that issued the claim; used as the lease session when the body omits it. */
  sessionId?: string;
  /** Lease TTL policy knob (client-side) when the server omits it. */
  leaseTtlMs?: number;
  /** Renewal-threshold policy knob (client-side) when the server omits it. */
  renewalThresholdMs?: number;
  /** Grace policy knob (client-side) when the server omits it. */
  graceMs?: number;
}

export type AdaptClaimedJobResult =
  | { kind: 'no_job'; reason: string }
  | { kind: 'malformed'; reason: string }
  | { kind: 'claimed'; job: ClaimedAuthorityJob; lease: ActiveLease };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Convert a `/v1/runners/{runnerId}/jobs/claim` response into a typed
 * ClaimedAuthorityJob + runtime ActiveLease, mapping the existing server shape.
 *
 * Fail-closed taxonomy:
 *   - `no_job`    : the server had nothing to claim (null / {} / { job: null }).
 *   - `malformed` : a job was returned but its envelope, typed fields, or lease
 *                   failed validation — never a partial job.
 *   - `claimed`   : a fully validated job + lease ready for the Stage B loop.
 *
 * The Stage B extras (mode / until / plannedSteps[] / developmentWorkflow /
 * coverageMap / lease) live in JobRecord.metadata, JobSpec.metadata, or a sibling
 * `lease` block. plannedSteps[] is left as `unknown` here and deeply validated
 * later by `consumeClaimedAuthorityJob`, identical to the `--jobFile` path.
 */
export function adaptClaimedJobResponse(
  claimBody: unknown,
  context: AdaptClaimedJobContext,
): AdaptClaimedJobResult {
  const body = asRecord(claimBody);
  // null / non-object / {} / { job: null } all mean "no eligible job".
  if (body === undefined) {
    return { kind: 'no_job', reason: 'authority claim returned no job (empty response)' };
  }
  const jobRaw = body.job;
  if (jobRaw === undefined || jobRaw === null) {
    return { kind: 'no_job', reason: 'authority claim returned no eligible job' };
  }

  const jobRecord = asRecord(jobRaw);
  const specRaw = asRecord(jobRecord?.spec) ?? jobRaw;
  const parsedSpec = JobSpecSchema.safeParse(specRaw);
  if (!parsedSpec.success) {
    const reason = parsedSpec.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .slice(0, 3)
      .join('; ');
    return { kind: 'malformed', reason: `claimed job spec is invalid: ${reason}` };
  }
  const spec = parsedSpec.data;
  const specRecord = spec as unknown as Record<string, unknown>;
  const metadata = asRecord(jobRecord?.metadata) ?? asRecord(spec.metadata) ?? {};

  // Map the typed JobSpec + its metadata onto the flat ClaimedAuthorityJob shape
  // the existing fail-closed parser already validates.
  const flat: Record<string, unknown> = {
    jobId: spec.jobId,
    runId: spec.runId,
    storyId: spec.storyId ?? metadata.storyId ?? jobRecord?.storyId,
    mode: metadata.mode,
    until: metadata.until,
    plannedSteps: metadata.plannedSteps,
  };
  if (metadata.developmentWorkflow !== undefined) flat.developmentWorkflow = metadata.developmentWorkflow;
  if (metadata.coverageMap !== undefined) flat.coverageMap = metadata.coverageMap;
  if (metadata.providerPolicy !== undefined) flat.providerPolicy = metadata.providerPolicy;
  if (metadata.worktreePolicy !== undefined) flat.worktreePolicy = metadata.worktreePolicy;
  if (metadata.retryPolicy !== undefined) flat.retryPolicy = metadata.retryPolicy;
  if (metadata.stopPolicy !== undefined) flat.stopPolicy = metadata.stopPolicy;
  if (metadata.budgetPolicy !== undefined) flat.budgetPolicy = metadata.budgetPolicy;
  if (metadata.lease !== undefined) flat.lease = metadata.lease;
  if (metadata.evidencePolicy !== undefined) flat.evidencePolicy = metadata.evidencePolicy;
  if (metadata.receiptPolicy !== undefined) flat.receiptPolicy = metadata.receiptPolicy;

  const jobResult = parseClaimedAuthorityJob(flat);
  if (!jobResult.ok) {
    return { kind: 'malformed', reason: jobResult.reason };
  }

  // Lease: prefer an explicit lease block (metadata.lease or a sibling claim.lease),
  // falling back to JobSpec.leaseExpiresAt for the expiry and the claim context for
  // identity. Timing knobs (ttl / threshold / grace) fall back to client policy.
  const leaseBlock = asRecord(metadata.lease) ?? asRecord(body.lease) ?? {};
  const leaseResult = parseClaimedLease({
    leaseId: leaseBlock.leaseId ?? metadata.leaseId ?? specRecord.leaseId ?? jobRecord?.leaseId,
    leasedByRunnerId: leaseBlock.leasedByRunnerId ?? metadata.leasedByRunnerId ?? jobRecord?.leasedByRunnerId ?? context.runnerId,
    leasedBySessionId:
      leaseBlock.leasedBySessionId ?? metadata.leasedBySessionId ?? metadata.sessionId ?? jobRecord?.leasedBySessionId ?? context.sessionId,
    leaseExpiresAt: leaseBlock.leaseExpiresAt ?? metadata.leaseExpiresAt ?? spec.leaseExpiresAt ?? jobRecord?.leaseExpiresAt,
    leaseTtlMs: numberOr(leaseBlock.leaseTtlMs, context.leaseTtlMs ?? DEFAULT_CLAIMED_LEASE_TTL_MS),
    renewalThresholdMs: numberOr(
      leaseBlock.renewalThresholdMs,
      context.renewalThresholdMs ?? DEFAULT_CLAIMED_LEASE_RENEWAL_MS,
    ),
    graceMs: numberOr(leaseBlock.graceMs, context.graceMs ?? DEFAULT_CLAIMED_LEASE_GRACE_MS),
    leaseVersion: integerOrUndefined(leaseBlock.leaseVersion ?? metadata.leaseVersion ?? jobRecord?.leaseVersion),
  });
  if (!leaseResult.ok) {
    return { kind: 'malformed', reason: `claimed lease is invalid: ${leaseResult.reason}` };
  }

  return { kind: 'claimed', job: jobResult.job, lease: leaseResult.lease };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function integerOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// AuthorityClientOutcome → Lease*Result mappers (pure, fail-closed)
// ─────────────────────────────────────────────────────────────────────────────

/** Merge a receipt body's top-level + `metadata` so either may carry lease fields. */
function readReceiptFields(data: unknown): Record<string, unknown> {
  const obj = asRecord(data);
  if (!obj) return {};
  const merged: Record<string, unknown> = { ...obj };
  const meta = asRecord(obj.metadata);
  if (meta) Object.assign(merged, meta);
  return merged;
}

function epochMsFrom(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

/** True when a server rejection is a stale-lease / version conflict (fail closed). */
export function isStaleLeaseRejection(outcome: AuthorityClientOutcome<unknown>): boolean {
  if (outcome.status === 409) return true;
  const fields = readReceiptFields(outcome.data);
  if (fields.staleLease === true || fields.leaseStale === true) return true;
  const msg = (outcome.message ?? '').toLowerCase();
  return /stale[\s-]?lease|lease version|version conflict/.test(msg);
}

/** Map a `heartbeatJob` outcome onto the loop's renew result (lease extension). */
export function leaseRenewResultFromOutcome(outcome: AuthorityClientOutcome<unknown>): LeaseRenewResult {
  if (!outcome.ok) {
    return { ok: false, message: outcome.message ?? `lease heartbeat failed (${outcome.kind})` };
  }
  const fields = readReceiptFields(outcome.data);
  const leaseExpiresAt = epochMsFrom(fields.leaseExpiresAt);
  const leaseVersion = integerOrUndefined(fields.leaseVersion);
  return {
    ok: true,
    ...(leaseExpiresAt !== undefined ? { leaseExpiresAt } : {}),
    ...(leaseVersion !== undefined ? { leaseVersion } : {}),
  };
}

/** Map a `releaseJob` (non-completed) outcome onto the loop's release result. */
export function leaseReleaseResultFromOutcome(outcome: AuthorityClientOutcome<unknown>): LeaseReleaseResult {
  return outcome.ok
    ? { ok: true }
    : { ok: false, message: outcome.message ?? `lease release failed (${outcome.kind})` };
}

/** Map a Python `response.completed` run-event outcome onto the loop's complete result. */
export function leaseCompleteResultFromOutcome(outcome: AuthorityClientOutcome<unknown>): LeaseCompleteResult {
  if (outcome.ok) return { ok: true };
  if (isStaleLeaseRejection(outcome)) {
    return {
      ok: false,
      staleLease: true,
      message: outcome.message ?? 'authority rejected completion: stale lease version',
    };
  }
  return { ok: false, message: outcome.message ?? `lease completion rejected (${outcome.kind})` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Live lease driver: async client → sync JobLeaseTransport → loop
// ─────────────────────────────────────────────────────────────────────────────

export interface LiveAuthorityJobLeaseOptions {
  client: AuthorityClient;
  jobId: string;
  runId?: string;
  /** Actor id stamped on the (signed) heartbeat / release envelopes. */
  actorId: string;
  /** Actor role stamped on Python Authority signed envelopes. */
  role?: string;
  /** Ed25519 private key used to sign the lease envelopes. */
  privateKey: PrivateKeyBase64;
  /** Renewed lease duration requested on each heartbeat, in seconds. */
  leaseDurationSeconds?: number;
  /** Release outcome used when releasing (not completing) the job. */
  releaseOutcome?: JobReleaseOutcome;
  /** Injectable ISO-timestamp source for envelope `createdAt` (test seam). */
  now?: () => string;
  /** Injectable nonce source for envelope `nonce` (test seam). */
  nonce?: (prefix: string) => string;
  /** Injectable epoch-ms clock for the loop's lease math (test seam). */
  clock?: () => number;
}

export interface FinalizeLiveAuthorityJobInput {
  resultDigest: string;
  receiptRequired: boolean;
  receiptVerified: boolean;
  finalPolicySatisfied: boolean;
  /** Reason recorded when the job is released instead of completed. */
  releaseReason: string;
}

export interface LiveAuthorityJobLease {
  /** The underlying deterministic loop (safety boundary lives here). */
  readonly loop: AuthorityJobLoop;
  /** The sync transport fed by the async client (exposed for custom drivers). */
  readonly transport: JobLeaseTransport;
  /** Heartbeat (renewing when due) at a loop phase, via the live client. */
  heartbeat(phase: HeartbeatPhase): Promise<HeartbeatOutcome>;
  /** Release the lease via the live client (idempotent). */
  release(reason: string): Promise<ReleaseOutcome>;
  /** Complete the job via the live client; fails closed on unmet gates. */
  complete(input: CompleteInput): Promise<CompleteOutcome>;
  /** Drive the §B7 tail (heartbeat → complete-or-release) over the live client. */
  finalize(input: FinalizeLiveAuthorityJobInput): Promise<FinalizeAuthorityJobResult>;
}

let liveLeaseNonceCounter = 0;

/**
 * Build a live lease driver bound to a claimed lease and an `AuthorityClient`.
 *
 * Each async method performs the real network call (heartbeatJob / releaseJob),
 * maps the outcome into the loop's sync transport via a single staged slot, then
 * invokes the corresponding sync loop method — so every safety gate (renewal
 * timing, stale-lease fail-closed, idempotency, receipt requirement) stays inside
 * the deterministic loop and is never re-implemented here.
 */
export function createLiveAuthorityJobLease(
  lease: ActiveLease,
  options: LiveAuthorityJobLeaseOptions,
): LiveAuthorityJobLease {
  const { client, jobId } = options;
  const nowIso = options.now ?? (() => new Date().toISOString());
  const nonceFor =
    options.nonce ?? ((prefix: string) => `${prefix}:${++liveLeaseNonceCounter}:${Math.random().toString(16).slice(2)}`);
  // Single staged slot per operation: the async method fills it immediately
  // before invoking the sync loop method that consumes it.
  const staged: {
    renew?: LeaseRenewResult;
    release?: LeaseReleaseResult;
    complete?: LeaseCompleteResult;
  } = {};

  function take<K extends keyof typeof staged>(slot: K): NonNullable<(typeof staged)[K]> {
    const value = staged[slot];
    if (value === undefined) {
      throw new Error(`live lease transport: no staged "${String(slot)}" result (driver invariant violated)`);
    }
    staged[slot] = undefined;
    return value as NonNullable<(typeof staged)[K]>;
  }

  const transport: JobLeaseTransport = {
    renew: () => take('renew'),
    release: () => take('release'),
    complete: () => take('complete'),
  };

  const loop = createAuthorityJobLoop({
    jobId,
    lease,
    transport,
    ...(options.clock ? { now: options.clock } : {}),
  });

  function signPythonEnvelope<T extends object>(envelope: T): T & { signature: string } {
    const signature = Buffer.from(signCanonical(stripSignature(envelope), options.privateKey), 'base64').toString('hex');
    return { ...envelope, signature };
  }

  function buildHeartbeat(renew: boolean): Record<string, unknown> {
    const envelope = {
      actorId: options.actorId,
      role: options.role ?? 'runner',
      nonce: nonceFor(`${jobId}:hb`),
      timestamp: nowIso(),
      jobId,
      heartbeat: {
        runnerId: lease.leasedByRunnerId,
        sessionId: lease.leasedBySessionId,
        ...(options.leaseDurationSeconds ? { leaseTtlSeconds: options.leaseDurationSeconds } : {}),
      },
    };
    return signPythonEnvelope(envelope);
  }

  function buildRelease(reason?: string): Record<string, unknown> {
    const envelope = {
      actorId: options.actorId,
      role: options.role ?? 'runner',
      nonce: nonceFor(`${jobId}:rel`),
      timestamp: nowIso(),
      jobId,
      release: {
        runnerId: lease.leasedByRunnerId,
        sessionId: lease.leasedBySessionId,
        ...(reason && reason.trim().length > 0 ? { reason } : {}),
      },
    };
    return signPythonEnvelope(envelope);
  }

  function buildCompletedRunEvent(input: CompleteInput): Record<string, unknown> | null {
    if (!options.runId) return null;
    const envelope = {
      actorId: options.actorId,
      role: options.role ?? 'runner',
      nonce: nonceFor(`${options.runId}:completed`),
      timestamp: nowIso(),
      runId: options.runId,
      event: {
        type: 'response.completed',
        payload: {
          jobId,
          resultDigest: input.resultDigest,
        },
      },
    };
    return signPythonEnvelope(envelope);
  }

  async function heartbeat(phase: HeartbeatPhase): Promise<HeartbeatOutcome> {
    const renew = loop.needsRenewal();
    const outcome = await client.heartbeatJob(jobId, buildHeartbeat(renew));
    staged.renew = leaseRenewResultFromOutcome(outcome);
    return loop.heartbeat(phase);
  }

  async function release(reason: string): Promise<ReleaseOutcome> {
    // Only hit the network while the lease is still active; a terminal lease's
    // release is a local no-op in the loop and must not re-POST.
    if (loop.status() === 'active') {
      const outcome = await client.releaseJob(jobId, buildRelease(reason));
      staged.release = leaseReleaseResultFromOutcome(outcome);
    } else {
      staged.release = { ok: true };
    }
    return loop.release(reason);
  }

  async function complete(input: CompleteInput): Promise<CompleteOutcome> {
    // Perform the completion POST ONLY when the loop's own gates would fire
    // (these mirror createAuthorityJobLoop.complete's preconditions exactly). On
    // an unmet gate the loop fails closed BEFORE transport.complete, so skipping
    // the network here is the correct fail-closed behavior, not a shortcut.
    const gatesReady =
      loop.status() === 'active' &&
      (!input.receiptRequired || input.receiptVerified) &&
      input.finalPolicySatisfied &&
      loop.leaseHealth() === 'safe';
    if (gatesReady) {
      const envelope = buildCompletedRunEvent(input);
      if (!envelope || !options.runId) {
        staged.complete = { ok: false, message: 'completion requires a runId for Python Authority response.completed event' };
      } else {
        const outcome = await client.appendRunEvents(options.runId, envelope);
        staged.complete = leaseCompleteResultFromOutcome(outcome);
      }
    } else {
      // Loop will fail closed before consuming this; staged only to satisfy the
      // transport contract if the gate logic ever changes (defensive).
      staged.complete = { ok: false, message: 'completion gate not satisfied; no network call made' };
    }
    return loop.complete(input);
  }

  async function finalize(input: FinalizeLiveAuthorityJobInput): Promise<FinalizeAuthorityJobResult> {
    // Async mirror of finalizeAuthorityJob over the live client. All branch
    // decisions delegate to the loop; this only sequences the network calls.
    const hb = await heartbeat('before-completion');
    if (!hb.leaseSafe) {
      const reason = `lease-unsafe:${hb.health}`;
      const released = await release(reason);
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
    const done = await complete({
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
    const released = await release(input.releaseReason);
    return {
      disposition: 'released',
      completed: false,
      ...(done.failClosedReason ? { failClosedReason: done.failClosedReason } : {}),
      releaseReason: released.reason,
      heartbeat: hb,
      complete: done,
      snapshot: loop.snapshot(),
    };
  }

  return { loop, transport, heartbeat, release, complete, finalize };
}
