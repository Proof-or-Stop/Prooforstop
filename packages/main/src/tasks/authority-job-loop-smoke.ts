#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  createAuthorityJobLoop,
  finalizeAuthorityJob,
  finalizeConsumedAuthorityJobLease,
  consumeClaimedAuthorityJob,
  parseClaimedLease,
  jobResultDigest,
  type ActiveLease,
  type JobLeaseTransport,
  type LeaseRenewResult,
  type LeaseReleaseResult,
  type LeaseCompleteResult,
  type ClaimedAuthorityJob,
} from '../core/authority-runner.js';
import type { PlannerStoreLike } from '../core/planner.js';
import type { StoryInfo } from '../core/types.js';

const PASS_LINE =
  '✓ authority job-loop smoke passed: claim/heartbeat/renew/release/complete semantics — renews before threshold, releases on blocked/failure, completes only after verified receipt + final policy, stale-lease completion fails closed, release/complete idempotent';

// --- Recording fake transport ----------------------------------------------
// A deterministic in-memory lease server. No network: it records every call and
// lets each test script how the "server" answers (extend expiry, bump version,
// reject a stale completion, etc.).

interface Recorded {
  renew: Array<{ leaseVersion: number; renew: boolean; phase: string }>;
  release: Array<{ leaseVersion: number; reason: string }>;
  complete: Array<{ leaseVersion: number; resultDigest: string }>;
}

interface FakeTransportOptions {
  // Each heartbeat extends the lease by this many ms past the current clock.
  extendByMs?: number;
  // When true, a renew=true heartbeat bumps the server lease version.
  bumpVersionOnRenew?: boolean;
  // Force heartbeat failures.
  failRenew?: boolean;
  failRelease?: boolean;
  // Reject completion as stale (server holds a newer lease version).
  rejectCompleteStale?: boolean;
  failComplete?: boolean;
  clock: () => number;
}

function fakeTransport(opts: FakeTransportOptions): { transport: JobLeaseTransport; calls: Recorded; serverVersion: () => number } {
  const calls: Recorded = { renew: [], release: [], complete: [] };
  let serverVersion = 0;
  const transport: JobLeaseTransport = {
    renew(input): LeaseRenewResult {
      calls.renew.push({ leaseVersion: input.leaseVersion, renew: input.renew, phase: input.phase });
      if (opts.failRenew) return { ok: false, message: 'fake renew failure' };
      serverVersion = Math.max(serverVersion, input.leaseVersion);
      let leaseVersion = input.leaseVersion;
      if (input.renew && opts.bumpVersionOnRenew) {
        serverVersion += 1;
        leaseVersion = serverVersion;
      }
      return {
        ok: true,
        leaseExpiresAt: opts.clock() + (opts.extendByMs ?? 60_000),
        leaseVersion,
      };
    },
    release(input): LeaseReleaseResult {
      calls.release.push({ leaseVersion: input.leaseVersion, reason: input.reason });
      return { ok: !opts.failRelease, message: opts.failRelease ? 'fake release failure' : undefined };
    },
    complete(input): LeaseCompleteResult {
      calls.complete.push({ leaseVersion: input.leaseVersion, resultDigest: input.resultDigest });
      if (opts.failComplete) return { ok: false, message: 'fake complete failure' };
      if (opts.rejectCompleteStale) return { ok: false, staleLease: true, message: 'lease version is stale' };
      return { ok: true };
    },
  };
  return { transport, calls, serverVersion: () => serverVersion };
}

function leaseAt(now: number): ActiveLease {
  return {
    leaseId: 'lease-1',
    leasedByRunnerId: 'runner-1',
    leasedBySessionId: 'session-1',
    leaseExpiresAt: now + 60_000,
    leaseTtlMs: 60_000,
    renewalThresholdMs: 20_000,
    graceMs: 5_000,
    leaseVersion: 0,
  };
}

// === parseClaimedLease: claim records a valid lease, fails closed otherwise ===
{
  const ok = parseClaimedLease({
    leaseId: 'lease-9',
    leasedByRunnerId: 'runner-9',
    leasedBySessionId: 'session-9',
    leaseExpiresAt: '2026-06-06T12:00:00.000Z',
    leaseTtlMs: 60_000,
    renewalThresholdMs: 20_000,
    graceMs: 5_000,
  });
  assert.equal(ok.ok, true, 'a well-formed claim must parse into an ActiveLease');
  if (ok.ok) {
    assert.equal(ok.lease.leaseVersion, 0, 'leaseVersion defaults to 0');
    assert.equal(ok.lease.leaseExpiresAt, Date.parse('2026-06-06T12:00:00.000Z'), 'ISO expiry parses to epoch ms');
  }

  for (const [label, bad] of [
    ['missing leaseId', { leaseId: '', leasedByRunnerId: 'r', leasedBySessionId: 's', leaseExpiresAt: 1, leaseTtlMs: 60_000, renewalThresholdMs: 20_000, graceMs: 0 }],
    ['missing runnerId', { leaseId: 'l', leasedByRunnerId: '  ', leasedBySessionId: 's', leaseExpiresAt: 1, leaseTtlMs: 60_000, renewalThresholdMs: 20_000, graceMs: 0 }],
    ['missing sessionId', { leaseId: 'l', leasedByRunnerId: 'r', leasedBySessionId: '', leaseExpiresAt: 1, leaseTtlMs: 60_000, renewalThresholdMs: 20_000, graceMs: 0 }],
    ['bad expiry', { leaseId: 'l', leasedByRunnerId: 'r', leasedBySessionId: 's', leaseExpiresAt: 'not-a-date', leaseTtlMs: 60_000, renewalThresholdMs: 20_000, graceMs: 0 }],
    ['threshold >= ttl', { leaseId: 'l', leasedByRunnerId: 'r', leasedBySessionId: 's', leaseExpiresAt: 1, leaseTtlMs: 20_000, renewalThresholdMs: 20_000, graceMs: 0 }],
    ['negative grace', { leaseId: 'l', leasedByRunnerId: 'r', leasedBySessionId: 's', leaseExpiresAt: 1, leaseTtlMs: 60_000, renewalThresholdMs: 20_000, graceMs: -1 }],
  ] as Array<[string, any]>) {
    const parsed = parseClaimedLease(bad);
    assert.equal(parsed.ok, false, `invalid claim (${label}) must fail closed`);
  }
}

// === Heartbeat keeps the lease alive; renews only past the threshold ===
{
  let t = 1_000_000;
  const { transport, calls } = fakeTransport({ clock: () => t, bumpVersionOnRenew: true, extendByMs: 60_000 });
  const loop = createAuthorityJobLoop({ jobId: 'job-1', lease: leaseAt(t), transport, now: () => t });

  // Just after claim: 60s of life, threshold 20s — no renewal yet.
  assert.equal(loop.needsRenewal(), false, 'fresh lease does not need renewal');
  const hb1 = loop.heartbeat('after-claim');
  assert.equal(hb1.ok, true);
  assert.equal(hb1.renewed, false, 'heartbeat within the safe window is not a renewal');
  assert.equal(hb1.leaseSafe, true);
  assert.equal(calls.renew[0].renew, false, 'transport told it is a keep-alive, not a renew');

  // Advance to 5s before expiry (past the 20s renewal threshold).
  t += 55_000;
  assert.equal(loop.needsRenewal(), true, 'within renewalThresholdMs the lease must renew');
  const hb2 = loop.heartbeat('before-step');
  assert.equal(hb2.renewed, true, 'crossing the threshold promotes the heartbeat to a renewal');
  assert.equal(hb2.ok, true);
  assert.equal(loop.snapshot().renewalCount, 1, 'a renewal was recorded');
  assert.equal(loop.snapshot().lease.leaseVersion, 1, 'renewal bumped the lease version (§B1)');
  assert.equal(hb2.leaseSafe, true, 'after renewal the extended lease is safe again');
  assert.equal(loop.needsRenewal(), false, 'renewal pushed expiry out so no further renewal is due');
}

// === Release on blocked/failure is idempotent ===
{
  let t = 2_000_000;
  const { transport, calls } = fakeTransport({ clock: () => t });
  const loop = createAuthorityJobLoop({ jobId: 'job-2', lease: leaseAt(t), transport, now: () => t });

  const r1 = loop.release('authority-job-blocked:provider_unavailable');
  assert.equal(r1.ok, true);
  assert.equal(r1.idempotent, false, 'first release fires the transport');
  assert.equal(loop.status(), 'released');

  const r2 = loop.release('authority-job-blocked:provider_unavailable');
  assert.equal(r2.idempotent, true, 'second release is an idempotent no-op');
  assert.equal(calls.release.length, 1, 'transport.release fired exactly once across retries');
}

// === Complete: only after verified receipt + final policy; idempotent ===
{
  let t = 3_000_000;
  const { transport, calls } = fakeTransport({ clock: () => t });
  const loop = createAuthorityJobLoop({ jobId: 'job-3', lease: leaseAt(t), transport, now: () => t });
  const digest = jobResultDigest({ jobId: 'job-3', ok: true });

  // Receipt required but not verified → fail closed, no transport.complete.
  const blocked = loop.complete({ resultDigest: digest, receiptRequired: true, receiptVerified: false, finalPolicySatisfied: true });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.failClosedReason, 'authority-done-requires-verified-gate-decision-receipt');
  assert.equal(calls.complete.length, 0, 'completion must not touch the lease without a verified receipt');
  assert.equal(loop.status(), 'active', 'a blocked completion leaves the lease active for the caller to release');

  // Final policy not satisfied → fail closed.
  const noPolicy = loop.complete({ resultDigest: digest, receiptRequired: false, receiptVerified: false, finalPolicySatisfied: false });
  assert.equal(noPolicy.ok, false);
  assert.equal(noPolicy.failClosedReason, 'final-policy-not-satisfied');
  assert.equal(calls.complete.length, 0);

  // Receipt verified + policy satisfied + safe lease → completes.
  const done = loop.complete({ resultDigest: digest, receiptRequired: true, receiptVerified: true, finalPolicySatisfied: true });
  assert.equal(done.ok, true);
  assert.equal(loop.status(), 'completed');
  assert.equal(calls.complete.length, 1);

  // Idempotent re-complete with the same digest is a cached no-op.
  const again = loop.complete({ resultDigest: digest, receiptRequired: true, receiptVerified: true, finalPolicySatisfied: true });
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  assert.equal(calls.complete.length, 1, 'transport.complete fired exactly once across retries');

  // Re-complete with a DIFFERENT digest is refused.
  const conflict = loop.complete({ resultDigest: jobResultDigest({ different: true }), receiptRequired: true, receiptVerified: true, finalPolicySatisfied: true });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.failClosedReason, 'job-already-completed-with-different-result-digest');
}

// === Stale-lease completion fails closed (expired clock) ===
{
  let t = 4_000_000;
  const { transport, calls } = fakeTransport({ clock: () => t });
  const loop = createAuthorityJobLoop({ jobId: 'job-4', lease: leaseAt(t), transport, now: () => t });
  const digest = jobResultDigest({ jobId: 'job-4' });

  // Jump past expiry + grace: lease is fully expired.
  t += 70_000;
  assert.equal(loop.leaseHealth(), 'expired');
  const stale = loop.complete({ resultDigest: digest, receiptRequired: true, receiptVerified: true, finalPolicySatisfied: true });
  assert.equal(stale.ok, false, 'an expired lease can never complete, even with a verified receipt');
  assert.equal(stale.failClosedReason, 'stale-lease:expired');
  assert.equal(calls.complete.length, 0, 'no completion call is made on an expired lease');
}

// === Grace window is diagnostic only — never completes ===
{
  let t = 4_500_000;
  const { transport } = fakeTransport({ clock: () => t });
  const loop = createAuthorityJobLoop({ jobId: 'job-4b', lease: leaseAt(t), transport, now: () => t });
  // Inside grace (expired but within graceMs).
  t += 62_000;
  assert.equal(loop.leaseHealth(), 'grace');
  const inGrace = loop.complete({ resultDigest: jobResultDigest({ g: 1 }), receiptRequired: false, receiptVerified: false, finalPolicySatisfied: true });
  assert.equal(inGrace.ok, false, 'graceMs must not be used to claim DONE (§B1)');
  assert.equal(inGrace.failClosedReason, 'stale-lease:grace');
}

// === Stale-lease completion fails closed (server version rejection) ===
{
  let t = 5_000_000;
  const { transport, calls } = fakeTransport({ clock: () => t, rejectCompleteStale: true });
  const loop = createAuthorityJobLoop({ jobId: 'job-5', lease: leaseAt(t), transport, now: () => t });
  const stale = loop.complete({ resultDigest: jobResultDigest({ jobId: 'job-5' }), receiptRequired: false, receiptVerified: false, finalPolicySatisfied: true });
  assert.equal(stale.ok, false, 'a server stale-version rejection fails closed');
  assert.equal(stale.failClosedReason, 'stale-lease:version');
  assert.equal(calls.complete.length, 1);
  assert.equal(loop.status(), 'active', 'a rejected completion leaves the lease active for release');
}

// === finalizeAuthorityJob: heartbeat → complete on the happy path ===
{
  let t = 6_000_000;
  const { transport, calls } = fakeTransport({ clock: () => t, extendByMs: 60_000 });
  const loop = createAuthorityJobLoop({ jobId: 'job-6', lease: leaseAt(t), transport, now: () => t });
  const fin = finalizeAuthorityJob({
    loop,
    resultDigest: jobResultDigest({ jobId: 'job-6' }),
    receiptRequired: true,
    receiptVerified: true,
    finalPolicySatisfied: true,
    releaseReason: 'unused-on-happy-path',
  });
  assert.equal(fin.disposition, 'completed');
  assert.equal(fin.completed, true);
  assert.equal(fin.heartbeat.phase, 'before-completion', 'finalize heartbeats before completing');
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.release.length, 0, 'a completed job is not also released');
}

// === finalizeAuthorityJob: failed heartbeat → release, never complete ===
{
  let t = 6_500_000;
  const { transport, calls } = fakeTransport({ clock: () => t, failRenew: true });
  // Lease already expired so a failed heartbeat leaves it unsafe.
  const lease = leaseAt(t);
  lease.leaseExpiresAt = t - 1_000;
  const loop = createAuthorityJobLoop({ jobId: 'job-7', lease, transport, now: () => t });
  const fin = finalizeAuthorityJob({
    loop,
    resultDigest: jobResultDigest({ jobId: 'job-7' }),
    receiptRequired: true,
    receiptVerified: true,
    finalPolicySatisfied: true,
    releaseReason: 'authority-job-finalize-release',
  });
  assert.equal(fin.disposition, 'released', 'an unsafe lease releases instead of completing');
  assert.equal(fin.completed, false);
  assert.ok(fin.failClosedReason?.startsWith('lease-unsafe'), 'release reason surfaces the unsafe lease');
  assert.equal(calls.complete.length, 0, 'no completion attempt on an unsafe lease');
  assert.equal(calls.release.length, 1);
}

// === finalizeConsumedAuthorityJobLease: consumption disposition → lease ===
// A blocked authority+DONE consumption (no verified receipt) must release.
{
  const story = { storyId: 'B-auto', phase: 'DEV' } as StoryInfo;
  const events: Array<Record<string, unknown>> = [];
  const store: PlannerStoreLike = {
    readStory: () => story,
    storyExists: (id: string) => id === 'B-auto',
    listStoryIds: () => ['B-auto'],
    appendProcessEvent: (_id, e) => { events.push(e); },
  };
  let stepSeq = 0;
  const step = (type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    stepSeq += 1;
    return {
      stepId: `step-${String(stepSeq).padStart(3, '0')}`,
      type,
      title: `bounded ${type}`,
      purpose: `exercise ${type}`,
      cwdPolicy: type === 'lattice.command' ? 'read-only' : 'story-worktree',
      timeoutMs: 60_000,
      maxAttempts: 1,
      requiresCleanWorktree: false,
      producesEvidence: true,
      blocksUntilEvidenceUploaded: false,
      evidenceBinding: `${type}-evidence`,
      args: { operation: type },
      ...(type === 'provider.fake' ? { provider: 'fake' } : {}),
      ...extra,
    };
  };
  const job: ClaimedAuthorityJob = {
    jobId: 'job-consume-done',
    storyId: 'B-auto',
    mode: 'authority',
    until: 'DONE',
    plannedSteps: [step('provider.fake'), step('gate.evaluate')],
  };
  const result = consumeClaimedAuthorityJob({ root: '/tmp/lattice-job-loop', store, job });
  assert.equal(result.disposition, 'blocked', 'authority DONE without a receipt blocks at the gate');

  let t = 7_000_000;
  const { transport, calls } = fakeTransport({ clock: () => t });
  const loop = createAuthorityJobLoop({ jobId: job.jobId, lease: leaseAt(t), transport, now: () => t });
  const fin = finalizeConsumedAuthorityJobLease({ loop, result });
  assert.equal(fin.disposition, 'released', 'a blocked consumption releases the lease');
  assert.equal(fin.completed, false);
  assert.equal(calls.complete.length, 0, 'a blocked consumption never completes');
  assert.equal(calls.release.length, 1);
  assert.equal(fin.releaseReason, result.releaseReason, 'release carries the consumption release reason');
}

// A completed authority+TEST consumption (no receipt required) → completes.
{
  const story = { storyId: 'B-auto', phase: 'DEV' } as StoryInfo;
  const store: PlannerStoreLike = {
    readStory: () => story,
    storyExists: (id: string) => id === 'B-auto',
    listStoryIds: () => ['B-auto'],
    appendProcessEvent: () => {},
  };
  let stepSeq = 0;
  const step = (type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    stepSeq += 1;
    return {
      stepId: `step-${String(stepSeq).padStart(3, '0')}`,
      type,
      title: `bounded ${type}`,
      purpose: `exercise ${type}`,
      cwdPolicy: type === 'lattice.command' ? 'read-only' : 'story-worktree',
      timeoutMs: 60_000,
      maxAttempts: 1,
      requiresCleanWorktree: false,
      producesEvidence: true,
      blocksUntilEvidenceUploaded: false,
      evidenceBinding: `${type}-evidence`,
      args: { operation: type },
      ...(type === 'provider.fake' ? { provider: 'fake' } : {}),
      ...extra,
    };
  };
  const job: ClaimedAuthorityJob = {
    jobId: 'job-consume-test',
    storyId: 'B-auto',
    mode: 'authority',
    until: 'TEST',
    plannedSteps: [step('provider.fake'), step('gate.evaluate'), step('stop.summary')],
  };
  const result = consumeClaimedAuthorityJob({ root: '/tmp/lattice-job-loop', store, job });
  assert.equal(result.disposition, 'completed', 'a non-DONE all-passing authority job completes');

  let t = 7_500_000;
  const { transport, calls } = fakeTransport({ clock: () => t, extendByMs: 60_000 });
  const loop = createAuthorityJobLoop({ jobId: job.jobId, lease: leaseAt(t), transport, now: () => t });
  const fin = finalizeConsumedAuthorityJobLease({ loop, result });
  assert.equal(fin.disposition, 'completed', 'a completed consumption completes the lease');
  assert.equal(fin.completed, true);
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.release.length, 0);
}

console.log(PASS_LINE);
