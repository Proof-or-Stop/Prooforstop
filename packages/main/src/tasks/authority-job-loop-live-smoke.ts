#!/usr/bin/env node
/**
 * Smoke coverage for the live Stage B authority job loop wired into
 * `lattice autopilot execute --mode=authority` (no --jobFile).
 *
 * Drives executeAutopilotLive against an injected fake authority server and asserts:
 * - not-configured authority env fails closed with an authorityJobLoop trace (zero network);
 * - a live non-DONE job: register/heartbeat/claim -> consume typed plannedSteps[] ->
 *   lease completed; runtime trace (claimed job id, disposition, evidence refs,
 *   network events) is surfaced;
 * - a live authority+DONE job WITHOUT a verified receipt fails closed (blocked ->
 *   lease released), never claiming authority DONE;
 * - no queued job fails closed (authority-no-job), no dangling lease;
 * - a runner control-plane failure fails closed (authority-runner-failed);
 * - a story-mismatched claimed job is refused and the lease is released cleanly.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorityLiveRunnerConfigured, claimAuthorityJobForLoop, executeAutopilotLive } from '../core/authority-job-loop-live.js';
import {
  canonicalDigest,
  generateEd25519KeyPair,
  signCanonical,
  stripSignature,
} from '../core/authority-signing.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';

const PASS_LINE =
  '✓ authority job loop live smoke passed: live register/heartbeat/claim -> consume -> lease complete-or-release; authority DONE receipt/evidence-gated; no-job / runner-failure / story-mismatch fail closed without dangling leases';

const keyPair = generateEd25519KeyPair();
const serverKeyPair = generateEd25519KeyPair();
const SERVER_KEY_ID = 'server-key-live-loop';
const serverPublicKeyHex = Buffer.from(serverKeyPair.publicKey, 'base64').toString('hex');

const FIXED_NOW = () => new Date('2026-06-06T00:00:00.000Z');
const FAR_FUTURE_LEASE = '2026-06-06T01:00:00.000Z';

const LIVE_ENV: Record<string, string | undefined> = {
  LATTICE_AUTHORITY_MODE: 'enforce',
  LATTICE_AUTHORITY_URL: 'https://authority.test',
  LATTICE_AUTHORITY_ACTOR_KEY: keyPair.privateKey,
  LATTICE_AUTHORITY_RUNNER_ID: 'runner-live-1',
  LATTICE_AUTHORITY_PROJECT_ID: 'project-live-1',
  LATTICE_AUTHORITY_SESSION_ID: 'session-live-1',
  LATTICE_AUTHORITY_SERVER_KEY_ID: SERVER_KEY_ID,
  LATTICE_AUTHORITY_SERVER_PUBLIC_KEY: serverPublicKeyHex,
  LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_ENCODING: 'hex',
  LATTICE_AUTHORITY_CUSTOMER_API_KEY: 'customer-key-canary',
  LATTICE_AUTHORITY_BOOTSTRAP_TOKEN: 'bootstrap-token-canary',
  LATTICE_AUTHORITY_GATE_ACTOR_KEY: keyPair.privateKey,
  LATTICE_AUTHORITY_GATE_ACTOR_KEY_ENCODING: 'base64',
  LATTICE_AUTHORITY_GATE_ACTOR_ROLE: 'main',
};

// Not-configured: no PROJECT_ID -> authority mode must fail closed, never local fallback.
const NOT_CONFIGURED_ENV: Record<string, string | undefined> = {
  LATTICE_AUTHORITY_MODE: 'enforce',
  LATTICE_AUTHORITY_URL: 'https://authority.test',
  LATTICE_AUTHORITY_KEY_FILE: '.lattice/missing-authority.md',
  LATTICE_AUTHORITY_ACTOR_KEY: keyPair.privateKey,
  LATTICE_AUTHORITY_RUNNER_ID: 'runner-live-1',
};

const MD_ENV: Record<string, string | undefined> = {
  LATTICE_AUTHORITY_MODE: 'enforce',
  LATTICE_AUTHORITY_BOOTSTRAP_TOKEN: 'bootstrap-token-canary',
  LATTICE_AUTHORITY_GATE_ACTOR_KEY: keyPair.privateKey,
  LATTICE_AUTHORITY_GATE_ACTOR_KEY_ENCODING: 'base64',
  LATTICE_AUTHORITY_GATE_ACTOR_ROLE: 'main',
};

function writeConfig(root: string): void {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  resetConfigCache();
}

function writeAuthorityMd(root: string): void {
  const latticeDir = join(root, '.lattice');
  const secretDir = join(latticeDir, 'secrets');
  mkdirSync(secretDir, { recursive: true });
  writeFileSync(join(secretDir, 'actor.key'), keyPair.privateKey);
  writeFileSync(join(secretDir, 'customer.key'), 'md-customer-key\n');
  writeFileSync(join(latticeDir, 'authority.md'), [
    'serverUrl: https://authority-md.test',
    'projectId: project-live-1',
    'runnerId: runner-live-1',
    'sessionId: session-live-1',
    'actorId: md-runner-actor',
    'actorRole: runner',
    'actorKeyId: md-actor-key',
    'actorKeyPath: .lattice/secrets/actor.key',
    'actorKeyEncoding: base64',
    'customerApiKeyPath: .lattice/secrets/customer.key',
    `serverKeyId: ${SERVER_KEY_ID}`,
    `serverPublicKey: ${serverPublicKeyHex}`,
    'serverPublicKeyEncoding: hex',
  ].join('\n'));
}

function seedStory(store: StoryStore): void {
  const now = '2026-06-04T00:00:00.000Z';
  const story: StoryInfo = {
    storyId: 'B-auto',
    name: 'authority-job-loop-live-smoke',
    title: 'Authority job loop live smoke',
    description: 'Exercise the live Stage B authority job loop end to end.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now }],
  };
  store.writeStory('B-auto', story);
}

let stepSeq = 0;
function step(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  stepSeq += 1;
  const provider = type === 'provider.fake' ? 'fake' : undefined;
  return {
    stepId: `lstep-${String(stepSeq).padStart(3, '0')}`,
    type,
    title: `live ${type}`,
    purpose: `bounded ${type} from a live claimed authority job`,
    cwdPolicy: type === 'lattice.command' ? 'read-only' : 'story-worktree',
    timeoutMs: 60_000,
    maxAttempts: 1,
    requiresCleanWorktree: false,
    producesEvidence: true,
    blocksUntilEvidenceUploaded: false,
    evidenceBinding: `${type}-evidence`,
    args: { operation: type },
    ...(provider ? { provider } : {}),
    ...extra,
  };
}

interface ServerScript {
  /** Status code for /v1/runners/register (default 200). */
  registerStatus?: number;
  /** The claimed JobSpec, or null for "no queued job". */
  job: Record<string, unknown> | null;
  gateDecision?: 'approve' | 'reject' | 'approve_no_receipt' | 'approve_tamper';
  evidenceBatchStatus?: number;
  evidenceBatchBody?: unknown;
  completionEventStatus?: number;
}

interface NetCall { path: string; headers: Record<string, string>; body?: unknown }

function normalizePythonDigestJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(normalizePythonDigestJson).filter(item => item !== undefined);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      const normalized = normalizePythonDigestJson(item);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return String(value);
}

function pythonAuthorityDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizePythonDigestJson(value)), 'utf8')
    .digest('hex');
}

function gateInputDigestFromEvaluateBody(body: { gateInputDigest?: unknown; decision?: { decisionId?: unknown } }): string {
  return typeof body.gateInputDigest === 'string'
    ? body.gateInputDigest
    : typeof body.decision?.decisionId === 'string'
      ? body.decision.decisionId
      : '';
}

function receiptInputDigestFromEvaluateBody(body: { decision?: Record<string, unknown> }): string {
  const decision = { ...(body.decision ?? {}) };
  const repo = decision.repo;
  if (repo && typeof repo === 'object') {
    const raw = repo as Record<string, unknown>;
    decision.repo = {
      headHash: raw.headHash,
      materialHash: raw.materialHash,
      baseHash: raw.baseHash ?? null,
      treeHash: raw.treeHash ?? null,
      diffHash: raw.diffHash ?? null,
      manifestHash: raw.manifestHash ?? null,
      dirty: raw.dirty ?? false,
    };
  }
  return pythonAuthorityDigest(decision);
}

function makeFetch(script: ServerScript, calls: NetCall[]): typeof fetch {
  const impl = async (input: string, _init: unknown) => {
    const url = String(input);
    const headers = ((_init as { headers?: Record<string, string> })?.headers ?? {});
    const rawBody = (_init as { body?: string }).body;
    let body: unknown;
    try {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      body = rawBody;
    }
    calls.push({ path: url, headers, body });
    const json = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    });
    if (url.includes('/v1/runners/register')) {
      return json(script.registerStatus ?? 200, {});
    }
    if (url.endsWith('/jobs/claim')) {
      return json(200, { job: script.job });
    }
    if (url.includes('/v1/runs/') && url.endsWith('/events')) {
      const body = JSON.parse((_init as { body?: string }).body ?? '{}') as { event?: { type?: string } };
      if (body.event?.type === 'response.completed' && script.completionEventStatus) {
        return json(script.completionEventStatus, { error: 'completion event rejected by smoke script' });
      }
      return json(200, {});
    }
    if (url.includes('/v1/evidence/batch')) {
      return json(script.evidenceBatchStatus ?? 200, script.evidenceBatchBody ?? { accepted: true, results: [{ accepted: true }] });
    }
    if (url.includes('/v1/gates/evaluate')) {
      if (script.gateDecision === 'reject') {
        return json(200, { decision: 'reject', reason: 'live smoke rejection' });
      }
      if (script.gateDecision === 'approve_no_receipt') {
        return json(200, { decision: 'approve', decisionDigest: 'missing-receipt-digest' });
      }
      if (script.gateDecision === 'approve_tamper') {
        const request = JSON.parse((_init as { body?: string }).body ?? '{}') as { gateInputDigest?: string; decision?: { projectId?: string; storyId?: string; decisionId?: string } };
        const decision = request.decision ?? {};
        const gateInputDigest = gateInputDigestFromEvaluateBody(request);
        const receiptInputDigest = receiptInputDigestFromEvaluateBody(request);
        const decisionDigest = canonicalDigest({ approve: true, gateInputDigest });
        const receipt = signReceipt(decision.projectId ?? 'project-live-1', decision.storyId ?? 'B-auto', decisionDigest, receiptInputDigest);
        return json(200, { decision: 'approve', decisionDigest, gateInputDigest, receipt: { ...receipt, storyId: 'B-wrong' } });
      }
      if (script.gateDecision === 'approve') {
        const request = JSON.parse((_init as { body?: string }).body ?? '{}') as { gateInputDigest?: string; decision?: { projectId?: string; storyId?: string; decisionId?: string } };
        const decision = request.decision ?? {};
        const gateInputDigest = gateInputDigestFromEvaluateBody(request);
        const receiptInputDigest = receiptInputDigestFromEvaluateBody(request);
        const decisionDigest = canonicalDigest({ approve: true, gateInputDigest });
        return json(200, { decision: 'approve', decisionDigest, gateInputDigest, receipt: signReceipt(decision.projectId ?? 'project-live-1', decision.storyId ?? 'B-auto', decisionDigest, receiptInputDigest) });
      }
      return json(500, { error: 'gate evaluator not configured for this script' });
    }
    // actor keys, runner heartbeat, job heartbeat, release all ack empty.
    return json(200, {});
  };
  return impl as unknown as typeof fetch;
}

function signReceipt(projectId: string, storyId: string, decisionDigest: string, gateInputDigest: string): Record<string, unknown> {
  const receipt: Record<string, unknown> & { signature?: string } = {
    receiptId: `rcpt-${storyId}-live`,
    kind: 'gate_decision',
    projectId,
    storyId,
    actorId: 'lattice-authority-server',
    role: 'server',
    stateVersion: 1,
    policyVersion: 'policy-v1',
    inputDigest: gateInputDigest,
    decisionDigest,
    issuedAt: FIXED_NOW().toISOString(),
    serverKeyId: SERVER_KEY_ID,
  };
  const signature = Buffer.from(signCanonical(stripSignature(receipt), serverKeyPair.privateKey), 'base64').toString('hex');
  return { ...receipt, signature };
}

function jobSpec(opts: { jobId: string; storyId: string; until: string; steps: unknown[] }): Record<string, unknown> {
  return {
    jobId: opts.jobId,
    runId: `${opts.jobId}:run`,
    storyId: opts.storyId,
    projectId: 'project-live-1',
    provider: 'codex',
    role: 'implementer',
    status: 'leased',
    leasedByRunnerId: 'runner-live-1',
    leasedBySessionId: 'session-live-1',
    leaseExpiresAt: FAR_FUTURE_LEASE,
    spec: {
      jobId: opts.jobId,
      runId: `${opts.jobId}:run`,
      projectId: 'project-live-1',
      provider: 'codex',
      role: 'implementer',
      storyId: opts.storyId,
      cwdPolicy: 'same-worktree',
      permissions: { canWrite: false, canRunShell: true, requiresApproval: false },
      plannedSteps: opts.steps,
      leaseId: `${opts.jobId}:lease`,
      leaseMetadata: {
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 3600,
        heartbeatIntervalSeconds: 600,
      },
      receiptPolicy: { targetPhase: opts.until },
      issuedAt: FIXED_NOW().toISOString(),
      expiresAt: FAR_FUTURE_LEASE,
      serverKeyId: SERVER_KEY_ID,
    },
  };
}

const root = mkdtempSync(join(tmpdir(), 'lattice-authority-job-loop-live-'));

async function main(): Promise<void> {
  writeConfig(root);
  writeAuthorityMd(root);
  const store = new StoryStore(root);
  seedStory(store);

  // 1. Not-configured authority env fails closed and never touches the network.
  const noNetCalls: NetCall[] = [];
  const explodingFetch = (() => { throw new Error('network must not be used when live settings are not configured'); }) as unknown as typeof fetch;
  const notConfigured = await executeAutopilotLive({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'DONE', maxSteps: 20 },
    env: NOT_CONFIGURED_ENV,
    fetchImpl: explodingFetch,
    now: FIXED_NOW,
  });
  assert.equal(notConfigured.schemaVersion, 'lattice.autopilot_execute.v1');
  assert.notEqual(notConfigured.authorityJobLoop ?? null, null, 'unconfigured authority env must surface a live-loop fail-closed trace');
  assert.equal(notConfigured.authorityJobLoop?.claimStatus, 'runner-failed');
  assert.equal(notConfigured.status, 'fail', 'authority DONE without config fails closed');
  assert.equal(notConfigured.stopReason, 'authority-live-runner-not-configured');
  assert.equal(notConfigured.authorityDone, false);
  assert.equal(notConfigured.fullAuthorityDone, false);
  assert.equal(noNetCalls.length, 0);

  assert.doesNotThrow(() => {
    const configured = authorityLiveRunnerConfigured({
      ...LIVE_ENV,
      LATTICE_AUTHORITY_ACTOR_KEY: undefined,
      LATTICE_AUTHORITY_ACTOR_KEY_PATH: '.lattice/secrets/missing-runner.key',
    }, { cwd: root });
    assert.equal(configured, false, 'missing actor key path is not live-configured');
  }, 'live runner readiness probe must not throw on missing actor key paths');

  // Direct exported live-loop claim helper also fails closed with zero network
  // when the customer API key is missing.
  {
    let invoked = 0;
    const directClaim = await claimAuthorityJobForLoop({
      baseURL: 'https://authority.test',
      timeoutMS: 10_000,
      actorId: 'actor-no-key',
      role: 'runner',
      actorKeyId: 'actor-key-no-key',
      actorPrivateKey: keyPair.privateKey,
      actorPrivateKeyEncoding: 'base64',
      runnerId: 'runner-no-key',
      sessionId: 'session-no-key',
      projectId: 'project-no-key',
      once: true,
      fetchImpl: (async () => {
        invoked += 1;
        return { ok: true, status: 200, text: async () => JSON.stringify({}) };
      }) as unknown as typeof fetch,
    }, {
      storyId: 'B-auto',
      mode: 'authority',
      until: 'TEST',
    });
    assert.equal(directClaim.status, 'runner-failed', 'direct live-loop claim fails without customer key');
    assert.equal(directClaim.networkEvents[0]?.step, 'register_actor_key');
    assert.equal(directClaim.networkEvents[0]?.ok, false);
    assert.match(directClaim.networkEvents[0]?.message ?? '', /customer_api_key_unconfigured_fails_closed/);
    assert.equal(invoked, 0, 'direct live-loop claim performs zero network calls without customer key');
  }

  // 2. Live non-DONE (TEST) job: claim -> consume -> lease completed.
  const testCalls: NetCall[] = [];
  const testFetch = makeFetch({
    job: jobSpec({
      jobId: 'job-live-test',
      storyId: 'B-auto',
      until: 'TEST',
      steps: [
        step('lattice.command', { args: { operation: 'story.resolve' } }),
        step('provider.fake'),
        step('gate.evaluate'),
        step('stop.summary'),
      ],
    }),
  }, testCalls);
  const liveTest = await executeAutopilotLive({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'TEST', maxSteps: 20 },
    env: LIVE_ENV,
    fetchImpl: testFetch,
    now: FIXED_NOW,
  });
  assert.equal(liveTest.status, 'pass', 'an all-passing non-DONE live job completes');
  assert.equal(liveTest.stopReason, 'authority-job-completed');
  assert.equal(liveTest.authorityDone, false, 'non-DONE target never claims authority DONE');
  const testLoop = liveTest.authorityJobLoop!;
  assert.ok(testLoop, 'live path must surface the authorityJobLoop trace');
  assert.equal(testLoop.claimStatus, 'claimed');
  assert.equal(testLoop.claimedJobId, 'job-live-test');
  assert.equal(testLoop.disposition, 'completed', 'a completed consumption completes the lease');
  assert.equal(testLoop.completed, true);
  assert.equal(testLoop.releaseOutcome, 'completed');
  assert.equal(testLoop.leaseHealth, 'safe');
  assert.equal(testLoop.receiptRequired, false);
  assert.ok(testLoop.evidenceRefs.length > 0, 'step evidence refs must be surfaced in the trace');
  assert.ok(testLoop.executedStepCount > 0, 'executed step count must be surfaced');
  const testSteps = testLoop.networkEvents.map(e => e.step);
  for (const required of ['register_actor_key', 'register_runner', 'runner_heartbeat', 'claim_job', 'job_heartbeat', 'complete_job']) {
    assert.ok(testSteps.includes(required as any), `network trace must include ${required}`);
  }
  assert.ok(testLoop.networkEvents.every(e => e.ok), 'all live job-loop network calls succeeded');
  const actorRegistration = testCalls.find(call => call.path.includes('/v1/actors/'));
  assert.equal(actorRegistration?.headers.Authorization, 'Bearer customer-key-canary', 'actor registration carries the customer API key');
  assert.equal(actorRegistration?.headers['X-Lattice-Bootstrap-Token'], 'bootstrap-token-canary', 'bootstrap token uses its dedicated header');
  assert.ok(testCalls.every(call => call.headers.Authorization === 'Bearer customer-key-canary'), 'every mutating live call carries the customer API key');
  const jobHeartbeat = testCalls.find(call => call.path.includes('/v1/jobs/job-live-test/heartbeat'));
  assert.equal((jobHeartbeat?.body as any)?.heartbeat?.status, undefined, 'job heartbeat payload must stay Python-compatible and omit unsupported status');

  // 3. Server-side terminal completion rejection downgrades the top-level result.
  const completionFailedCalls: NetCall[] = [];
  const completionFailed = await executeAutopilotLive({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'TEST', maxSteps: 20 },
    env: LIVE_ENV,
    fetchImpl: makeFetch({
      completionEventStatus: 500,
      job: jobSpec({
        jobId: 'job-live-test-completion-failed',
        storyId: 'B-auto',
        until: 'TEST',
        steps: [
          step('lattice.command', { args: { operation: 'story.resolve' } }),
          step('provider.fake'),
          step('stop.summary'),
        ],
      }),
    }, completionFailedCalls),
    now: FIXED_NOW,
  });
  assert.equal(completionFailed.status, 'fail', 'server completion-event rejection must fail the top-level live result');
  assert.equal(completionFailed.stopReason, 'authority-job-completion-event-failed');
  assert.equal(completionFailed.authorityDone, false, 'completion-event failure clears authority DONE projection');
  assert.equal(completionFailed.fullAuthorityDone, false, 'completion-event failure clears full authority DONE projection');
  assert.equal(completionFailed.completion?.completed, false, 'completion verdict is downgraded after terminal event failure');
  assert.ok(completionFailed.blockingReasons.includes('authority-job-completion-event-failed'));
  assert.equal(completionFailed.authorityJobLoop?.failClosedReason, 'authority-job-completion-event-failed');
  assert.equal(completionFailed.authorityJobLoop?.disposition, 'released');
  assert.ok(completionFailedCalls.some(call => call.path.includes('/v1/runs/') && call.path.endsWith('/events')), 'completion-event path was exercised');

  // 4. authority.md can supply the live URL, actor key path, and customer key path.
  const mdCalls: NetCall[] = [];
  const mdFetch = makeFetch({
    job: jobSpec({
      jobId: 'job-live-md',
      storyId: 'B-auto',
      until: 'TEST',
      steps: [
        step('lattice.command', { args: { operation: 'story.resolve' } }),
        step('provider.fake'),
        step('gate.evaluate'),
        step('stop.summary'),
      ],
    }),
  }, mdCalls);
  const liveFromMd = await executeAutopilotLive({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'TEST', maxSteps: 20 },
    env: MD_ENV,
    fetchImpl: mdFetch,
    now: FIXED_NOW,
  });
  assert.equal(liveFromMd.status, 'pass', 'authority.md-backed live job completes a non-DONE lease');
  assert.equal(liveFromMd.authorityJobLoop?.claimStatus, 'claimed');
  assert.ok(mdCalls.every(call => call.path.startsWith('https://authority-md.test/')), 'live loop uses authority.md serverUrl');
  assert.ok(mdCalls.every(call => call.headers.Authorization === 'Bearer md-customer-key'), 'authority.md customer key is sent on every mutating live call');

  // authority.md must also feed the DONE gate resolver. This catches cwd drift:
  // without cwd: root, the gate resolver reloads config from process.cwd().
  const mdDoneCalls: NetCall[] = [];
  const mdDoneFetch = makeFetch({
    gateDecision: 'approve',
    job: jobSpec({
      jobId: 'job-live-md-done-approved',
      storyId: 'B-auto',
      until: 'DONE',
      steps: [
        step('lattice.command', { args: { operation: 'story.resolve' } }),
        step('provider.fake'),
        step('gate.evaluate'),
        step('stop.summary'),
      ],
    }),
  }, mdDoneCalls);
  const liveDoneFromMd = await executeAutopilotLive({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'DONE', maxSteps: 20 },
    env: MD_ENV,
    fetchImpl: mdDoneFetch,
    now: FIXED_NOW,
  });
  assert.equal(liveDoneFromMd.authorityDone, true, `authority.md-backed DONE gate verifies the native receipt: ${JSON.stringify({
    status: liveDoneFromMd.status,
    stopReason: liveDoneFromMd.stopReason,
    completion: liveDoneFromMd.completion,
    authorityJobLoop: liveDoneFromMd.authorityJobLoop,
  })}`);
  assert.equal(liveDoneFromMd.fullAuthorityDone, false, 'multi-host certification is still required after receipt verification');
  assert.ok(mdDoneCalls.some(call => call.path.includes('/v1/gates/evaluate')), 'authority.md-backed DONE job reaches the gate evaluator');
  assert.ok(mdDoneCalls.every(call => call.path.startsWith('https://authority-md.test/')), 'authority.md-backed DONE gate uses authority.md serverUrl');
  // GET /v1/authority/policy is an intentional public read-only discovery endpoint
  // (B-ea92 M1) and carries no Authorization header. Every other (mutating) call
  // on the DONE-gate path must still carry the authority.md customer key.
  assert.ok(mdDoneCalls.filter(call => !call.path.includes('/v1/authority/policy')).every(call => call.headers.Authorization === 'Bearer md-customer-key'), 'authority.md-backed DONE gate uses authority.md customer key on every mutating call');

  // 5. Live authority+DONE without a verified receipt: blocked -> lease released.
  const doneCalls: NetCall[] = [];
  const doneFetch = makeFetch({
    job: jobSpec({
      jobId: 'job-live-done',
      storyId: 'B-auto',
      until: 'DONE',
      steps: [
        step('lattice.command', { args: { operation: 'story.resolve' } }),
        step('provider.fake'),
        step('gate.evaluate'),
      ],
    }),
  }, doneCalls);
  const liveDone = await executeAutopilotLive({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'DONE', maxSteps: 20 },
    env: LIVE_ENV,
    fetchImpl: doneFetch,
    now: FIXED_NOW,
  });
  assert.equal(liveDone.status, 'fail', 'authority DONE without a verified receipt fails closed');
  assert.equal(liveDone.authorityDone, false, 'live loop never self-claims authority DONE');
  assert.equal(liveDone.fullAuthorityDone, false);
  const doneLoop = liveDone.authorityJobLoop!;
  assert.equal(doneLoop.claimStatus, 'claimed');
  assert.equal(doneLoop.claimedJobId, 'job-live-done');
  assert.equal(doneLoop.disposition, 'released', 'a receipt-gated DONE job releases the lease');
  assert.equal(doneLoop.completed, false);
  assert.equal(doneLoop.receiptRequired, true);
  assert.equal(doneLoop.receiptVerified, false, 'no native receipt was verified');
  assert.ok(doneLoop.failClosedReason, 'a released DONE lease must record a fail-closed reason');
  assert.ok(doneLoop.networkEvents.some(e => e.step === 'release_job' && e.ok), 'DONE lease must be released cleanly (no dangling lease)');

  // 6. Live authority+DONE with a verified native receipt: per-run authorityDone
  // passes, but final fullAuthorityDone still waits for multi-host certification.
  const approvedCalls: NetCall[] = [];
  const approvedFetch = makeFetch({
    gateDecision: 'approve',
    job: jobSpec({
      jobId: 'job-live-done-approved',
      storyId: 'B-auto',
      until: 'DONE',
      steps: [
        step('lattice.command', { args: { operation: 'story.resolve' } }),
        step('provider.fake'),
        step('gate.evaluate'),
        step('stop.summary'),
      ],
    }),
  }, approvedCalls);
  const liveApproved = await executeAutopilotLive({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'DONE', maxSteps: 20 },
    env: LIVE_ENV,
    fetchImpl: approvedFetch,
    now: FIXED_NOW,
  });
  assert.equal(liveApproved.authorityDone, true, 'verified native receipt should satisfy per-run authorityDone');
  assert.equal(liveApproved.fullAuthorityDone, false, 'fullAuthorityDone still requires multi-host final certification');
  assert.equal(liveApproved.status, 'fail', 'the job is not completed until the full completion gate is satisfied');
  assert.equal(liveApproved.completion?.receiptVerified, true);
  assert.equal(liveApproved.completion?.authorityDone, true);
  assert.ok(liveApproved.completion?.receiptRefs.some(ref => ref.verified), 'verified gate_decision receipt ref must be surfaced');
  assert.ok(liveApproved.completion?.blockingReasons.includes('multi_host_verification_incomplete'));
  const approvedLoop = liveApproved.authorityJobLoop!;
  assert.equal(approvedLoop.receiptVerified, true, 'live loop trace must expose receipt verification');
  assert.equal(approvedLoop.disposition, 'released', 'lease releases while final multi-host certification is incomplete');
  assert.equal(approvedLoop.releaseOutcome, 'abandoned');
  assert.ok(approvedLoop.networkEvents.some(e => e.step === 'release_job' && e.ok), 'receipt-verified but not full-DONE job must still release cleanly');

  // 7. E5-shaped regression: required evidence upload failure blocks before gate.
  const evidenceFailedCalls: NetCall[] = [];
  const evidenceFailed = await executeAutopilotLive({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'DONE', maxSteps: 20 },
    env: LIVE_ENV,
    fetchImpl: makeFetch({
      gateDecision: 'approve',
      evidenceBatchStatus: 401,
      evidenceBatchBody: { error: 'invalid_signature' },
      job: jobSpec({
        jobId: 'job-live-evidence-failed',
        storyId: 'B-auto',
        until: 'DONE',
        steps: [
          step('lattice.command', { args: { operation: 'story.resolve' } }),
          step('provider.fake'),
          step('gate.evaluate'),
          step('stop.summary'),
        ],
      }),
    }, evidenceFailedCalls),
    now: FIXED_NOW,
  });
  assert.equal(evidenceFailed.status, 'fail', 'evidence upload failure must fail the live result');
  assert.equal(evidenceFailed.authorityDone, false, 'failed evidence upload must not project authority DONE');
  assert.equal(evidenceFailed.fullAuthorityDone, false);
  assert.equal(evidenceFailed.claimedJobExecution?.receiptVerified, false);
  assert.ok(evidenceFailed.claimedJobExecution?.execution?.stopReason, 'evidence failure must surface an executor stop reason');
  assert.ok(!evidenceFailedCalls.some(call => call.path.includes('/v1/gates/evaluate')), 'gate evaluate must not run after evidence upload failure');
  assert.ok(!evidenceFailedCalls.some(call => call.path.includes('/v1/runs/session-live-1/events')), 'claimed job must not post run events to ambient SESSION_ID');
  assert.ok(evidenceFailedCalls.some(call => call.path.includes('/v1/runs/job-live-evidence-failed%3Arun/events')), 'run events bind the claimed server runId');
  assert.equal(evidenceFailed.authorityJobLoop?.disposition, 'released', 'evidence-failed DONE lease is released, not completed');
  assert.ok(evidenceFailed.authorityJobLoop?.networkEvents.some(e => e.step === 'release_job' && e.ok), 'evidence-failed lease must release cleanly');

  // 8. No queued job: fail closed, nothing claimed, no dangling lease.
  const noJobCalls: NetCall[] = [];
  const noJob = await executeAutopilotLive({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'DONE', maxSteps: 20 },
    env: LIVE_ENV,
    fetchImpl: makeFetch({ job: null }, noJobCalls),
    now: FIXED_NOW,
  });
  assert.equal(noJob.status, 'fail');
  assert.equal(noJob.stopReason, 'authority-no-job');
  assert.equal(noJob.authorityDone, false);
  assert.equal(noJob.authorityJobLoop!.claimStatus, 'no-job');
  assert.equal(noJob.authorityJobLoop!.claimedJobId, null);
  assert.ok(!noJob.authorityJobLoop!.networkEvents.some(e => e.step === 'release_job'), 'nothing was claimed, so nothing is released');

  // 9. Runner control-plane failure: fail closed.
  const failCalls: NetCall[] = [];
  const runnerFailed = await executeAutopilotLive({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'DONE', maxSteps: 20 },
    env: LIVE_ENV,
    fetchImpl: makeFetch({ job: null, registerStatus: 503 }, failCalls),
    now: FIXED_NOW,
  });
  assert.equal(runnerFailed.status, 'fail');
  assert.equal(runnerFailed.stopReason, 'authority-runner-failed');
  assert.equal(runnerFailed.authorityJobLoop!.claimStatus, 'runner-failed');

  // 10. Story-mismatched claimed job is refused and the lease released cleanly.
  const mismatchCalls: NetCall[] = [];
  const mismatch = await executeAutopilotLive({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'TEST', maxSteps: 20 },
    env: LIVE_ENV,
    fetchImpl: makeFetch({
      job: jobSpec({ jobId: 'job-live-mismatch', storyId: 'B-other', until: 'TEST', steps: [step('provider.fake')] }),
    }, mismatchCalls),
    now: FIXED_NOW,
  });
  assert.equal(mismatch.status, 'fail');
  assert.equal(mismatch.stopReason, 'claimed-job-story-mismatch', 'a claimed job for another story is refused');
  assert.equal(mismatch.claimedJobExecution, null, 'a mismatched job is never executed');
  assert.equal(mismatch.authorityJobLoop!.disposition, 'released');
  assert.ok(mismatch.authorityJobLoop!.networkEvents.some(e => e.step === 'release_job' && e.ok), 'a mismatched claimed job lease must be released');

  console.log(PASS_LINE);
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  });
