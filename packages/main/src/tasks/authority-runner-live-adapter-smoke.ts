#!/usr/bin/env node
//
// Authority runner LIVE adapter smoke (Stage B loop wiring).
//
// Pure in-process smoke (no real network — injected fetch responses only). Proves
// the live Authority client adapter that wires `AuthorityClient.heartbeatJob /
// releaseJob` to the deterministic Stage B job loop:
//
//   1. adaptClaimedJobResponse maps the existing `/v1/runners/{id}/jobs/claim`
//      response shape ({ job: JobSpec } with Stage B extras in metadata) into a
//      typed ClaimedAuthorityJob + runtime ActiveLease, and fails closed with
//      structured reasons on no-job / malformed job / malformed lease.
//   2. The pure outcome→lease mappers classify success / server-rejection /
//      stale-lease(409 / body flag / message) correctly.
//   3. createLiveAuthorityJobLease drives the loop end to end over an injected
//      client: happy completion, stale-lease completion (releases), unverified
//      receipt (no completion POST → releases), and an unsafe/expired lease with a
//      rejected heartbeat (releases) — never dangling, never DONE on an unsafe
//      lease or unverified receipt.
//   4. The live driver's complete-or-release decisions match the canonical sync
//      finalizeAuthorityJob fed the same mapped results (no gate drift).
//
// Visible pass line:
//   ✓ authority runner live adapter smoke passed: claim adapter + lease mappers + live finalize (4 dispositions) verified

import assert from 'node:assert/strict';
import {
  AuthorityClient,
  type AuthorityFetch,
  type AuthorityFetchInit,
  type AuthorityFetchResponse,
} from '../core/authority-client.js';
import {
  adaptClaimedJobResponse,
  createLiveAuthorityJobLease,
  isStaleLeaseRejection,
  leaseCompleteResultFromOutcome,
  leaseRenewResultFromOutcome,
  leaseReleaseResultFromOutcome,
} from '../core/authority-runner-live-client.js';
import {
  createAuthorityJobLoop,
  finalizeAuthorityJob,
  type ActiveLease,
  type JobLeaseTransport,
  type LeaseCompleteResult,
  type LeaseRenewResult,
  type LeaseReleaseResult,
} from '../core/authority-job-loop.js';
import { generateEd25519KeyPair } from '../core/authority-signing.js';

const PASS_LINE =
  '✓ authority runner live adapter smoke passed: claim adapter + lease mappers + live finalize (4 dispositions) verified';

const BASE_URL = 'https://authority.test';
const KP = generateEd25519KeyPair();
const ACTOR_ID = 'actor-1';
const RUNNER_ID = 'runner-1';
const SESSION_ID = 'sess-1';
const JOB_ID = 'job-1';
const RUN_ID = 'run-1';
const T0 = 1_900_000_000_000; // fixed epoch ms clock anchor

// ─── recording fake fetch ─────────────────────────────────────────────────────
interface RecordedCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

function recordingClient(
  handler: (call: RecordedCall) => AuthorityFetchResponse,
): { client: AuthorityClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: AuthorityFetch = async (url: string, init: AuthorityFetchInit) => {
    let body: Record<string, unknown> | undefined;
    if (typeof init.body === 'string' && init.body.length > 0) {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = undefined;
      }
    }
    const call: RecordedCall = { url, method: init.method, body };
    calls.push(call);
    return handler(call);
  };
  return { client: new AuthorityClient(BASE_URL, fetch, undefined, { customerApiKey: 'customer-key-canary' }), calls };
}

function jsonResponse(status: number, body: unknown): AuthorityFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const RECEIPT = {
  receiptId: 'rcpt-1',
  subjectId: JOB_ID,
  subjectKind: 'job',
  issuedAt: '2026-06-06T00:00:00.000Z',
  authorityActorId: 'authority-1',
};

function isRelease(call: RecordedCall): boolean {
  return call.url.endsWith(`/v1/jobs/${JOB_ID}/release`);
}
function isHeartbeat(call: RecordedCall): boolean {
  return call.url.endsWith(`/v1/jobs/${JOB_ID}/heartbeat`);
}
function isCompleteEvent(call: RecordedCall): boolean {
  return call.url.endsWith(`/v1/runs/${RUN_ID}/events`);
}

function liveOptions(client: AuthorityClient, clock: () => number) {
  return {
    client,
    jobId: JOB_ID,
    runId: RUN_ID,
    actorId: ACTOR_ID,
    role: 'runner',
    privateKey: KP.privateKey,
    leaseDurationSeconds: 60,
    now: () => '2026-06-06T00:00:00.000Z',
    nonce: (prefix: string) => `${prefix}:fixed`,
    clock,
  };
}

function safeLease(): ActiveLease {
  return {
    leaseId: 'lease-1',
    leasedByRunnerId: RUNNER_ID,
    leasedBySessionId: SESSION_ID,
    leaseExpiresAt: T0 + 60_000,
    leaseTtlMs: 60_000,
    renewalThresholdMs: 20_000,
    graceMs: 5_000,
    leaseVersion: 1,
  };
}

// Scripted sync transport feeding the canonical sync finalizeAuthorityJob with
// the SAME mapped results the live driver produced, for the drift cross-check.
function scriptedTransport(script: {
  renew: LeaseRenewResult;
  complete?: LeaseCompleteResult;
  release?: LeaseReleaseResult;
}): JobLeaseTransport {
  return {
    renew: () => script.renew,
    release: () => script.release ?? { ok: true },
    complete: () => script.complete ?? { ok: false, message: 'no complete scripted' },
  };
}

function syncFinalize(args: {
  lease: ActiveLease;
  clock: () => number;
  script: Parameters<typeof scriptedTransport>[0];
  input: { resultDigest: string; receiptRequired: boolean; receiptVerified: boolean; finalPolicySatisfied: boolean; releaseReason: string };
}) {
  const loop = createAuthorityJobLoop({ jobId: JOB_ID, lease: args.lease, transport: scriptedTransport(args.script), now: args.clock });
  return finalizeAuthorityJob({ loop, ...args.input });
}

// ─── 1. Claim adapter: no-job / malformed / claimed / malformed lease ──────────
{
  const ctx = { runnerId: RUNNER_ID, sessionId: SESSION_ID };

  // no-job shapes
  assert.equal(adaptClaimedJobResponse(null, ctx).kind, 'no_job', 'null → no_job');
  assert.equal(adaptClaimedJobResponse({}, ctx).kind, 'no_job', '{} → no_job');
  assert.equal(adaptClaimedJobResponse({ job: null }, ctx).kind, 'no_job', '{job:null} → no_job');

  // malformed JobSpec (missing runId/kind)
  const badSpec = adaptClaimedJobResponse({ job: { jobId: 'j' } }, ctx);
  assert.equal(badSpec.kind, 'malformed', 'bad JobSpec → malformed');

  // malformed claimed-job fields (valid JobSpec but missing mode/until/plannedSteps)
  const badFields = adaptClaimedJobResponse(
    { job: { jobId: JOB_ID, runId: 'run-1', kind: 'verify', storyId: 'B-1', metadata: {} } },
    ctx,
  );
  assert.equal(badFields.kind, 'malformed', 'missing mode/until/plannedSteps → malformed');

  // claimed happy: Stage B extras live in metadata; lease in metadata.lease
  const claimResponse = {
    job: {
      jobId: JOB_ID,
      runId: 'run-1',
      kind: 'verify',
      storyId: 'B-1',
      projectId: 'proj-1',
      leaseExpiresAt: '2026-06-06T00:01:00.000Z',
      metadata: {
        mode: 'authority',
        until: 'DONE',
        developmentWorkflow: 'standard',
        plannedSteps: [{ id: 'S1', type: 'validate', evidenceBinding: 'b' }],
        coverageMap: [],
        lease: {
          leaseId: 'lease-9',
          leasedByRunnerId: RUNNER_ID,
          leasedBySessionId: SESSION_ID,
          leaseExpiresAt: '2026-06-06T00:01:00.000Z',
          leaseTtlMs: 60_000,
          renewalThresholdMs: 20_000,
          graceMs: 5_000,
          leaseVersion: 2,
        },
      },
    },
  };
  const claimed = adaptClaimedJobResponse(claimResponse, ctx);
  assert.equal(claimed.kind, 'claimed', 'full claim → claimed');
  if (claimed.kind === 'claimed') {
    assert.equal(claimed.job.jobId, JOB_ID);
    assert.equal(claimed.job.runId, 'run-1');
    assert.equal(claimed.job.storyId, 'B-1');
    assert.equal(claimed.job.mode, 'authority');
    assert.equal(claimed.job.until, 'DONE');
    assert.equal(claimed.job.developmentWorkflow, 'standard');
    assert.ok(Array.isArray(claimed.job.plannedSteps), 'plannedSteps carried through (unknown, validated later)');
    assert.equal(claimed.lease.leaseId, 'lease-9');
    assert.equal(claimed.lease.leasedByRunnerId, RUNNER_ID);
    assert.equal(claimed.lease.leaseVersion, 2, 'lease version mapped');
    assert.equal(claimed.lease.leaseExpiresAt, Date.parse('2026-06-06T00:01:00.000Z'), 'ISO expiry → epoch ms');
  }

  // Python Authority returns a JobRecord with nested `spec` plus Stage B extras
  // in record-level metadata. The live runner must claim that real shape, not
  // only the older in-process `{ job: JobSpec }` fixture.
  const pythonJobRecordClaim = adaptClaimedJobResponse(
    {
      job: {
        jobId: JOB_ID,
        runId: 'run-1',
        provider: 'codex',
        role: 'implementer',
        status: 'leased',
        leasedByRunnerId: RUNNER_ID,
        leasedBySessionId: SESSION_ID,
        leaseExpiresAt: '2026-06-06T00:02:00.000Z',
        leaseVersion: 6,
        metadata: {
          mode: 'authority',
          until: 'DONE',
          developmentWorkflow: 'standard',
          plannedSteps: [{ stepId: 'step-1', type: 'validate.run', evidenceBinding: 'evidence-1' }],
          coverageMap: [{ checklistItemId: 'CHK-live', validationStepIds: ['step-1'] }],
        },
        spec: {
          jobId: JOB_ID,
          runId: 'run-1',
          projectId: 'proj-1',
          storyId: 'B-python',
          provider: 'codex',
          role: 'implementer',
          leaseId: 'lease-python',
          plannedSteps: [],
          serverKeyId: 'server-1',
        },
      },
    },
    ctx,
  );
  assert.equal(pythonJobRecordClaim.kind, 'claimed', 'Python JobRecord claim → claimed');
  if (pythonJobRecordClaim.kind === 'claimed') {
    assert.equal(pythonJobRecordClaim.job.jobId, JOB_ID);
    assert.equal(pythonJobRecordClaim.job.runId, 'run-1');
    assert.equal(pythonJobRecordClaim.job.storyId, 'B-python');
    assert.equal(pythonJobRecordClaim.job.mode, 'authority');
    assert.equal(pythonJobRecordClaim.job.until, 'DONE');
    assert.equal(pythonJobRecordClaim.job.developmentWorkflow, 'standard');
    assert.equal(pythonJobRecordClaim.lease.leaseId, 'lease-python');
    assert.equal(pythonJobRecordClaim.lease.leasedByRunnerId, RUNNER_ID);
    assert.equal(pythonJobRecordClaim.lease.leasedBySessionId, SESSION_ID);
    assert.equal(pythonJobRecordClaim.lease.leaseVersion, 6);
    assert.equal(
      pythonJobRecordClaim.lease.leaseExpiresAt,
      Date.parse('2026-06-06T00:02:00.000Z'),
      'record-level lease expiry maps',
    );
  }

  // lease identity defaults to claim context when the body omits runner/session,
  // and expiry falls back to JobSpec.leaseExpiresAt.
  const ctxDefaulted = adaptClaimedJobResponse(
    {
      job: {
        jobId: JOB_ID,
        runId: 'run-1',
        kind: 'verify',
        storyId: 'B-1',
        leaseExpiresAt: '2026-06-06T00:01:00.000Z',
        metadata: { mode: 'local', until: 'TEST', plannedSteps: [], lease: { leaseId: 'lease-2' } },
      },
    },
    ctx,
  );
  assert.equal(ctxDefaulted.kind, 'claimed', 'lease identity defaults from context');
  if (ctxDefaulted.kind === 'claimed') {
    assert.equal(ctxDefaulted.lease.leasedByRunnerId, RUNNER_ID);
    assert.equal(ctxDefaulted.lease.leasedBySessionId, SESSION_ID);
    assert.equal(ctxDefaulted.lease.leaseVersion, 0, 'omitted version defaults to 0');
  }

  // malformed lease: leaseId + expiry present but no session anywhere → fail closed
  const badLease = adaptClaimedJobResponse(
    {
      job: {
        jobId: JOB_ID,
        runId: 'run-1',
        kind: 'verify',
        storyId: 'B-1',
        leaseExpiresAt: '2026-06-06T00:01:00.000Z',
        metadata: { mode: 'local', until: 'TEST', plannedSteps: [], lease: { leaseId: 'lease-3' } },
      },
    },
    { runnerId: RUNNER_ID }, // no sessionId → leasedBySessionId missing
  );
  assert.equal(badLease.kind, 'malformed', 'missing lease session → malformed');
}

// ─── 2. Pure outcome → lease mappers ──────────────────────────────────────────
{
  const renewOk = leaseRenewResultFromOutcome({
    kind: 'success',
    ok: true,
    status: 200,
    data: { metadata: { leaseExpiresAt: '2026-06-06T00:05:00.000Z', leaseVersion: 4 } },
  });
  assert.equal(renewOk.ok, true);
  assert.equal(renewOk.leaseExpiresAt, Date.parse('2026-06-06T00:05:00.000Z'));
  assert.equal(renewOk.leaseVersion, 4);

  const renewTopLevel = leaseRenewResultFromOutcome({
    kind: 'success',
    ok: true,
    status: 200,
    data: { leaseExpiresAt: T0 + 1_000, leaseVersion: 7 },
  });
  assert.equal(renewTopLevel.leaseExpiresAt, T0 + 1_000, 'numeric epoch-ms expiry passes through');
  assert.equal(renewTopLevel.leaseVersion, 7);

  const renewFail = leaseRenewResultFromOutcome({ kind: 'http_error', ok: false, status: 503, message: 'down' });
  assert.equal(renewFail.ok, false);

  assert.equal(leaseReleaseResultFromOutcome({ kind: 'success', ok: true, status: 200 }).ok, true);
  assert.equal(leaseReleaseResultFromOutcome({ kind: 'timeout', ok: false, message: 't' }).ok, false);

  assert.equal(leaseCompleteResultFromOutcome({ kind: 'success', ok: true, status: 200, data: {} }).ok, true);

  const stale409 = leaseCompleteResultFromOutcome({ kind: 'http_error', ok: false, status: 409, message: 'conflict' });
  assert.equal(stale409.ok, false);
  assert.equal(stale409.staleLease, true, '409 → stale lease');

  const staleBody = leaseCompleteResultFromOutcome({ kind: 'error', ok: false, status: 422, data: { staleLease: true } });
  assert.equal(staleBody.staleLease, true, 'body.staleLease → stale lease');

  const staleMsg = leaseCompleteResultFromOutcome({ kind: 'http_error', ok: false, status: 400, message: 'lease version conflict' });
  assert.equal(staleMsg.staleLease, true, 'message → stale lease');

  const plainReject = leaseCompleteResultFromOutcome({ kind: 'http_error', ok: false, status: 400, message: 'bad request' });
  assert.equal(plainReject.ok, false);
  assert.notEqual(plainReject.staleLease, true, 'non-stale rejection is not flagged stale');

  assert.equal(isStaleLeaseRejection({ kind: 'http_error', ok: false, status: 409 }), true);
  assert.equal(isStaleLeaseRejection({ kind: 'http_error', ok: false, status: 500, message: 'oops' }), false);
}

// ─── 3a. Live finalize: happy completion (no receipt required) ────────────────
{
  const { client, calls } = recordingClient(call => (isHeartbeat(call) ? jsonResponse(200, RECEIPT) : jsonResponse(200, RECEIPT)));
  const live = createLiveAuthorityJobLease(safeLease(), liveOptions(client, () => T0));
  const result = await live.finalize({
    resultDigest: 'digest-1',
    receiptRequired: false,
    receiptVerified: false,
    finalPolicySatisfied: true,
    releaseReason: 'should-not-release',
  });
  assert.equal(result.disposition, 'completed', 'happy → completed');
  assert.equal(result.completed, true);
  assert.equal(calls.length, 2, 'exactly heartbeat + response.completed event');
  assert.ok(isHeartbeat(calls[0]), 'first call is heartbeat');
  assert.equal((calls[0].body?.heartbeat as { status?: string } | undefined)?.status, undefined, 'Python job heartbeat payload omits unsupported status');
  assert.ok(isCompleteEvent(calls[1]), 'second call is response.completed run event');
  assert.equal((calls[1].body?.event as { type?: string } | undefined)?.type, 'response.completed');
  assert.ok(typeof calls[1].body?.signature === 'string', 'complete event envelope is signed');

  // drift cross-check vs canonical sync finalize fed the same mapped results
  const sync = syncFinalize({
    lease: safeLease(),
    clock: () => T0,
    script: { renew: { ok: true }, complete: { ok: true } },
    input: { resultDigest: 'digest-1', receiptRequired: false, receiptVerified: false, finalPolicySatisfied: true, releaseReason: 'should-not-release' },
  });
  assert.equal(sync.disposition, result.disposition, 'sync/live agree (completed)');
}

// ─── 3b. Live finalize: stale-lease completion → releases ─────────────────────
{
  const { client, calls } = recordingClient(call => {
    if (isHeartbeat(call)) return jsonResponse(200, RECEIPT);
    if (isCompleteEvent(call)) return jsonResponse(409, 'stale');
    return jsonResponse(200, RECEIPT); // the abandoning release
  });
  const live = createLiveAuthorityJobLease(safeLease(), liveOptions(client, () => T0));
  const result = await live.finalize({
    resultDigest: 'digest-2',
    receiptRequired: false,
    receiptVerified: false,
    finalPolicySatisfied: true,
    releaseReason: 'stale-fallback',
  });
  assert.equal(result.disposition, 'released', 'stale completion → released');
  assert.equal(result.completed, false);
  assert.equal(result.failClosedReason, 'stale-lease:version', 'fail-closed reason is stale-lease:version');
  assert.equal(calls.length, 3, 'heartbeat + response.completed(409) + release');
  assert.ok(isCompleteEvent(calls[1]), 'failed completion is a run event');
  assert.ok(isRelease(calls[2]), 'fallback release is a Python release envelope');
  assert.equal((calls[2].body?.release as { outcome?: unknown } | undefined)?.outcome, undefined, 'Python release envelope carries no outcome');

  const sync = syncFinalize({
    lease: safeLease(),
    clock: () => T0,
    script: { renew: { ok: true }, complete: { ok: false, staleLease: true }, release: { ok: true } },
    input: { resultDigest: 'digest-2', receiptRequired: false, receiptVerified: false, finalPolicySatisfied: true, releaseReason: 'stale-fallback' },
  });
  assert.equal(sync.disposition, 'released', 'sync agrees: released');
  assert.equal(sync.failClosedReason, result.failClosedReason, 'sync/live agree on stale reason');
}

// ─── 3c. Live finalize: receipt required but unverified → no completion POST ───
{
  const { client, calls } = recordingClient(call => jsonResponse(200, RECEIPT));
  const live = createLiveAuthorityJobLease(safeLease(), liveOptions(client, () => T0));
  const result = await live.finalize({
    resultDigest: 'digest-3',
    receiptRequired: true,
    receiptVerified: false,
    finalPolicySatisfied: true,
    releaseReason: 'needs-receipt',
  });
  assert.equal(result.disposition, 'released', 'unverified receipt → released');
  assert.equal(result.failClosedReason, 'authority-done-requires-verified-gate-decision-receipt');
  assert.equal(calls.length, 2, 'heartbeat + abandoned release only (NO completion POST)');
  assert.ok(isHeartbeat(calls[0]));
  assert.ok(isRelease(calls[1]));
  assert.equal((calls[1].body?.release as { reason?: string } | undefined)?.reason, 'needs-receipt');
  for (const c of calls) {
    assert.equal(isCompleteEvent(c), false, 'no completion POST is ever made for an unverified receipt');
  }
}

// ─── 3d. Live finalize: unsafe (expired) lease + rejected heartbeat → releases ─
{
  const expiredClock = () => T0 + 70_000; // past expiry (T0+60s) + grace (5s)
  const { client, calls } = recordingClient(call => (isHeartbeat(call) ? jsonResponse(503, 'down') : jsonResponse(200, RECEIPT)));
  const live = createLiveAuthorityJobLease(safeLease(), liveOptions(client, expiredClock));
  const result = await live.finalize({
    resultDigest: 'digest-4',
    receiptRequired: false,
    receiptVerified: false,
    finalPolicySatisfied: true,
    releaseReason: 'unsafe-fallback',
  });
  assert.equal(result.disposition, 'released', 'unsafe lease → released');
  assert.equal(result.failClosedReason, 'lease-unsafe:expired');
  assert.equal(result.complete, null, 'no completion attempted on an unsafe lease');
  assert.equal(calls.length, 2, 'heartbeat(503) + abandoned release');
  assert.ok(isHeartbeat(calls[0]));
  assert.ok(isRelease(calls[1]));
  assert.equal((calls[1].body?.release as { reason?: string } | undefined)?.reason, 'lease-unsafe:expired');
}

// ─── 3e. Live finalize: receipt required AND verified → completes ─────────────
{
  const { client, calls } = recordingClient(() => jsonResponse(200, RECEIPT));
  const live = createLiveAuthorityJobLease(safeLease(), liveOptions(client, () => T0));
  const result = await live.finalize({
    resultDigest: 'digest-5',
    receiptRequired: true,
    receiptVerified: true,
    finalPolicySatisfied: true,
    releaseReason: 'unused',
  });
  assert.equal(result.disposition, 'completed', 'verified receipt + policy → completed');
  assert.equal(calls.length, 2);
  assert.ok(isCompleteEvent(calls[1]));
  assert.equal((calls[1].body?.event as { type?: string } | undefined)?.type, 'response.completed');
}

console.log(PASS_LINE);
