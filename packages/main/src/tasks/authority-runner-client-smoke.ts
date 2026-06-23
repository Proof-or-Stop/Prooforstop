#!/usr/bin/env node
//
// Authority runner client smoke (B-1123 milestone 2).
//
// Pure in-process smoke (no real network). Proves:
//   1. Each runner endpoint method hits the expected path EXACTLY ONCE per call:
//        POST /v1/actors/{actorId}/keys
//        POST /v1/runners/register
//        POST /v1/runners/{runnerId}/heartbeat
//        GET  /v1/runners/{runnerId}/jobs/stream
//        POST /v1/runners/{runnerId}/jobs/claim
//        POST /v1/jobs/{jobId}/heartbeat
//        POST /v1/jobs/{jobId}/release
//        POST /v1/runs/{runId}/provider-events
//      Path parameters are URL-encoded.
//   2. Each request body is JSON-parseable, carries the envelope's signature,
//      and matches the typed contract shape (Zod parse on outbound body).
//   3. Success responses parse against the AuthorityReceipt union OR JobSpec.
//   4. HTTP error / malformed body / connection-refused outcomes map to
//      `http_error` / `error` / `connection_refused` respectively (Handler
//      Coding convention: malformed 2xx body is `error`, never silently `success`).
//   5. Off mode (LATTICE_AUTHORITY_MODE=off) and missing LATTICE_AUTHORITY_URL
//      cause `createRunnerAuthorityClient` to refuse instantiation and
//      perform ZERO network calls.
//   6. Policy discovery still NEVER POSTs evidence or runner mutations
//      (PD-2 invariant).
//
// Visible pass line (consumed by reviewers / DONE summary):
//   ✓ authority runner client smoke passed: 8 runner endpoints incl. jobs stream, off-mode performs zero network calls

import assert from 'node:assert/strict';
import {
  AuthorityClient,
  type AuthorityFetch,
  type AuthorityFetchInit,
  type AuthorityFetchResponse,
  createRunnerAuthorityClient,
  loadRunnerAuthorityClient,
} from '../core/authority-client.js';
import {
  ActorKeyRegistrationSchema,
  JobClaimSchema,
  JobLeaseHeartbeatSchema,
  JobReleaseSchema,
  ProviderEventsEnvelopeSchema,
  RunnerHeartbeatSchema,
  RunnerRegistrationSchema,
  signRunnerEnvelope,
  type ActorKeyRegistration,
  type JobClaim,
  type JobLeaseHeartbeat,
  type JobRelease,
  type ProviderEventsEnvelope,
  type RunnerHeartbeat,
  type RunnerRegistration,
} from '../core/authority-runner-contracts.js';
import { generateEd25519KeyPair } from '../core/authority-signing.js';
import { DEFAULT_AUTHORITY_TIMEOUT_MS } from '../core/authority-mode.js';
import { runLatticeAuthorityControlPlaneOnce } from '../core/authority-runner.js';

const PASS_LINE =
  '✓ authority runner client smoke passed: 8 runner endpoints incl. jobs stream, off-mode performs zero network calls';

const NONCE = 'n-1';
const CREATED_AT = '2026-06-02T18:00:00.000Z';
const ACTOR_ID = 'actor-1';
const BASE_URL = 'https://authority.test';
const KP = generateEd25519KeyPair();
const TEST_AUTH = { customerApiKey: 'test-customer-key' };

function testAuthorityClient(
  baseURL: string,
  fetchImpl: AuthorityFetch,
  timeoutMS = DEFAULT_AUTHORITY_TIMEOUT_MS,
): AuthorityClient {
  return new AuthorityClient(baseURL, fetchImpl, timeoutMS, TEST_AUTH);
}

// ─── recording fake fetch ─────────────────────────────────────────────────────
interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  bodyText?: string;
}

function recordingFetch(handler: (call: RecordedCall) => AuthorityFetchResponse): {
  fetch: AuthorityFetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch: AuthorityFetch = async (url: string, init: AuthorityFetchInit) => {
    let body: unknown;
    if (typeof init.body === 'string' && init.body.length > 0) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: RecordedCall = { url, method: init.method, headers: init.headers, body, bodyText: init.body };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

function jsonResponse(status: number, body: unknown): AuthorityFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function textResponse(status: number, body: string): AuthorityFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

function abortingTextResponse(status: number, message: string): AuthorityFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => {
      throw Object.assign(new Error(message), { name: 'AbortError' });
    },
  };
}

function thrower(error: unknown): AuthorityFetch {
  return async () => {
    throw error;
  };
}

function header() {
  return { actorId: ACTOR_ID, nonce: NONCE, createdAt: CREATED_AT };
}

function pythonHeader() {
  return { actorId: ACTOR_ID, role: 'runner', nonce: NONCE, timestamp: CREATED_AT };
}

function liveControlPlaneOptions(fetchImpl: AuthorityFetch) {
  return {
    baseURL: BASE_URL,
    timeoutMS: DEFAULT_AUTHORITY_TIMEOUT_MS,
    actorId: ACTOR_ID,
    role: 'runner',
    actorKeyId: 'actor-key-1',
    actorPrivateKey: KP.privateKey,
    actorPrivateKeyEncoding: 'base64' as const,
    runnerId: 'runner-1',
    sessionId: 'session-1',
    runnerProvider: 'codex' as const,
    projectId: 'project-1',
    customerApiKey: TEST_AUTH.customerApiKey,
    once: true,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  };
}

function controlPlaneFetch(
  streamHandler: (call: RecordedCall) => AuthorityFetchResponse,
): { fetch: AuthorityFetch; calls: RecordedCall[] } {
  return recordingFetch((call) => {
    const runnerPath = `${BASE_URL}/v1/runners/${encodeURIComponent('runner-1')}`;
    if (call.method === 'POST' && call.url === `${BASE_URL}/v1/actors/${encodeURIComponent(ACTOR_ID)}/keys`) {
      return jsonResponse(200, { ok: true });
    }
    if (call.method === 'POST' && call.url === `${BASE_URL}/v1/runners/register`) {
      return jsonResponse(200, { ok: true });
    }
    if (call.method === 'POST' && call.url === `${runnerPath}/heartbeat`) {
      return jsonResponse(200, { ok: true });
    }
    if (call.method === 'GET' && call.url === `${runnerPath}/jobs/stream`) {
      return streamHandler(call);
    }
    if (call.method === 'POST' && call.url === `${runnerPath}/jobs/claim`) {
      return jsonResponse(200, { job: null });
    }
    throw new Error(`unexpected control-plane call: ${call.method} ${call.url}`);
  });
}

function eventMessage(events: { step: string; message?: string }[], step: string): string {
  return events.find(event => event.step === step)?.message ?? '';
}

// ─── 1. Each runner endpoint method hits expected path EXACTLY ONCE ───────────
{
  const acceptedReceipt = {
    receiptId: 'rcpt-1',
    subjectId: 'sub-1',
    subjectKind: 'runner',
    issuedAt: CREATED_AT,
    authorityActorId: 'authority-1',
  };
  const jobSpec = {
    jobId: 'job-1',
    runId: 'run-1',
    kind: 'verify',
  };

  // 1a. registerActorKey
  {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, acceptedReceipt));
    const client = testAuthorityClient(BASE_URL, fetch);
    const env: ActorKeyRegistration = {
      ...header(),
      publicKey: KP.publicKey,
      keyLabel: 'primary',
    };
    const { signed } = signRunnerEnvelope(env, KP.privateKey);
    const out = await client.registerActorKey(ACTOR_ID, signed);
    assert.equal(out.kind, 'success', 'registerActorKey success');
    assert.equal(calls.length, 1, 'registerActorKey called exactly once');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, `${BASE_URL}/v1/actors/${encodeURIComponent(ACTOR_ID)}/keys`);
    const body = calls[0].body as unknown as ActorKeyRegistration;
    assert.equal(body.signature, signed.signature, 'body carries signature');
    // body must parse against the typed schema
    ActorKeyRegistrationSchema.parse(body);
  }

  // 1b. registerRunner
  {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, acceptedReceipt));
    const client = testAuthorityClient(BASE_URL, fetch);
    const env: RunnerRegistration = { ...header(), runnerId: 'runner-1', runnerName: 'r1' };
    const { signed } = signRunnerEnvelope(env, KP.privateKey);
    const out = await client.registerRunner(signed);
    assert.equal(out.kind, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE_URL}/v1/runners/register`);
    RunnerRegistrationSchema.parse(calls[0].body);
  }

  // 1c. heartbeatRunner — path encodes runnerId
  {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, acceptedReceipt));
    const client = testAuthorityClient(BASE_URL, fetch);
    const env: RunnerHeartbeat = { ...header(), runnerId: 'runner/with slash' };
    const { signed } = signRunnerEnvelope(env, KP.privateKey);
    const out = await client.heartbeatRunner('runner/with slash', signed);
    assert.equal(out.kind, 'success');
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      `${BASE_URL}/v1/runners/${encodeURIComponent('runner/with slash')}/heartbeat`,
      'runnerId is URL-encoded',
    );
    RunnerHeartbeatSchema.parse(calls[0].body);
  }

  // 1d. streamRunnerJobsAvailable — authenticated SSE GET hint
  {
    const { fetch, calls } = recordingFetch(() => textResponse(
      200,
      ': heartbeat\n\nevent: jobs.available\ndata: {"count":1,"jobIds":["job-1"]}\n\n',
    ));
    const client = testAuthorityClient(BASE_URL, fetch);
    const out = await client.streamRunnerJobsAvailable('runner-1');
    assert.equal(out.kind, 'available', 'jobs stream positive hint');
    assert.equal(out.ok, true);
    assert.equal(out.count, 1);
    assert.deepEqual(out.jobIds, ['job-1']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, `${BASE_URL}/v1/runners/runner-1/jobs/stream`);
    assert.equal(calls[0].body, undefined, 'jobs stream GET sends no body');
    assert.equal(calls[0].headers.Accept, 'text/event-stream');
    assert.equal(calls[0].headers.Authorization, `Bearer ${TEST_AUTH.customerApiKey}`);
  }

  // 1e. claimJob — JobSpec response shape
  {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, jobSpec));
    const client = testAuthorityClient(BASE_URL, fetch);
    const env: JobClaim = { ...header(), runnerId: 'runner-1', leaseDurationSeconds: 60 };
    const { signed } = signRunnerEnvelope(env, KP.privateKey);
    const out = await client.claimJob('runner-1', signed);
    assert.equal(out.kind, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE_URL}/v1/runners/runner-1/jobs/claim`);
    JobClaimSchema.parse(calls[0].body);
    assert.equal((out.data as { jobId: string }).jobId, 'job-1');
  }

  // claimJob: null response (no eligible job) is still success
  {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, null));
    const client = testAuthorityClient(BASE_URL, fetch);
    const env: JobClaim = { ...header(), runnerId: 'runner-1' };
    const { signed } = signRunnerEnvelope(env, KP.privateKey);
    const out = await client.claimJob('runner-1', signed);
    assert.equal(out.kind, 'success', 'null JobSpec is still success');
    assert.equal(calls.length, 1);
    assert.equal(out.data, null);
  }

  // 1f. heartbeatJob
  {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, acceptedReceipt));
    const client = testAuthorityClient(BASE_URL, fetch);
    const env: JobLeaseHeartbeat = { ...header(), jobId: 'job-1', progress: 0.25 };
    const { signed } = signRunnerEnvelope(env, KP.privateKey);
    const out = await client.heartbeatJob('job-1', signed);
    assert.equal(out.kind, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE_URL}/v1/jobs/job-1/heartbeat`);
    JobLeaseHeartbeatSchema.parse(calls[0].body);
  }

  // 1g. releaseJob
  {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, acceptedReceipt));
    const client = testAuthorityClient(BASE_URL, fetch);
    const env: JobRelease = {
      ...pythonHeader(),
      jobId: 'job-1',
      release: { runnerId: 'runner-1', sessionId: 'session-1', reason: 'not-completed-release' },
    };
    const { signed } = signRunnerEnvelope(env, KP.privateKey);
    const out = await client.releaseJob('job-1', signed);
    assert.equal(out.kind, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE_URL}/v1/jobs/job-1/release`);
    JobReleaseSchema.parse(calls[0].body);
    assert.equal((calls[0].body as { outcome?: unknown }).outcome, undefined, 'Python release body has no outcome');
  }

  // 1h. submitProviderEvents
  {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, acceptedReceipt));
    const client = testAuthorityClient(BASE_URL, fetch);
    const env: ProviderEventsEnvelope = {
      ...pythonHeader(),
      providerEvent: {
        eventId: 'e1',
        runId: 'run-1',
        provider: 'codex',
        type: 'message',
        occurredAt: CREATED_AT,
        message: 'started',
        metadata: {},
      },
    };
    const { signed } = signRunnerEnvelope(env, KP.privateKey);
    const out = await client.submitProviderEvents('run-1', signed);
    assert.equal(out.kind, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE_URL}/v1/runs/run-1/provider-events`);
    ProviderEventsEnvelopeSchema.parse(calls[0].body);
    assert.equal((calls[0].body as { events?: unknown }).events, undefined, 'Python provider-events body has no events[]');
    assert.equal((calls[0].body as { runId?: unknown }).runId, undefined, 'Python provider-events envelope has no top-level runId');
  }
}

// ─── 2. Empty path parameters throw at the client entry ───────────────────────
{
  const { fetch, calls } = recordingFetch(() => jsonResponse(200, {}));
  const client = testAuthorityClient(BASE_URL, fetch);
  const env: RunnerHeartbeat = { ...header(), runnerId: 'r' };
  const { signed } = signRunnerEnvelope(env, KP.privateKey);
  await assert.rejects(() => client.heartbeatRunner('', signed), /runnerId/);
  await assert.rejects(() => client.heartbeatRunner('   ', signed), /runnerId/);
  await assert.rejects(() => client.claimJob('', { ...header(), runnerId: 'r' } as any), /runnerId/);
  await assert.rejects(() => client.heartbeatJob('', { ...header(), jobId: 'j' } as any), /jobId/);
  await assert.rejects(() => client.releaseJob('', { ...pythonHeader(), jobId: 'j', release: { runnerId: 'r', sessionId: 's' } } as any), /jobId/);
  await assert.rejects(() => client.submitProviderEvents('', { ...pythonHeader(), providerEvent: { eventId: 'e', runId: 'r', provider: 'codex', type: 'message' } } as any), /runId/);
  await assert.rejects(() => client.registerActorKey('', { ...header(), publicKey: 'k' } as any), /actorId/);
  assert.equal(calls.length, 0, 'no network call when path params are empty');
}

// ─── 3. Outcome taxonomy: http_error / error / connection_refused ─────────────
{
  // http_error (5xx)
  const { fetch } = recordingFetch(() => jsonResponse(503, 'down'));
  const client = testAuthorityClient(BASE_URL, fetch);
  const env: RunnerHeartbeat = { ...header(), runnerId: 'r' };
  const { signed } = signRunnerEnvelope(env, KP.privateKey);
  const out = await client.heartbeatRunner('r', signed);
  assert.equal(out.kind, 'http_error');
  assert.equal(out.ok, false);
  assert.equal(out.status, 503);
}
{
  // Malformed JSON in 2xx body → kind:'error' (Handler coding convention: malformed body
  // is NOT silently success). Job claim takes JobSpec | null union, so a
  // string body like "not-json-but-junk" rejects.
  const { fetch } = recordingFetch(() => jsonResponse(200, 'not-json-but-junk'));
  const client = testAuthorityClient(BASE_URL, fetch);
  const env: JobClaim = { ...header(), runnerId: 'r' };
  const { signed } = signRunnerEnvelope(env, KP.privateKey);
  const out = await client.claimJob('r', signed);
  assert.equal(out.kind, 'error', 'malformed 2xx body maps to error');
  assert.equal(out.ok, false);
}
{
  // Connection refused
  const err = Object.assign(new Error('boom'), { code: 'ECONNREFUSED' });
  const client = testAuthorityClient(BASE_URL, thrower(err));
  const env: RunnerHeartbeat = { ...header(), runnerId: 'r' };
  const { signed } = signRunnerEnvelope(env, KP.privateKey);
  const out = await client.heartbeatRunner('r', signed);
  assert.equal(out.kind, 'connection_refused');
  assert.equal(out.ok, false);
}
{
  // Timeout / abort
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const client = testAuthorityClient(BASE_URL, thrower(abortErr));
  const env: RunnerHeartbeat = { ...header(), runnerId: 'r' };
  const { signed } = signRunnerEnvelope(env, KP.privateKey);
  const out = await client.heartbeatRunner('r', signed);
  assert.equal(out.kind, 'timeout');
}

// ─── 4. Off mode / missing URL → zero network calls ───────────────────────────
{
  // Off mode: no client returned, no network call ever made.
  let invoked = 0;
  const fetch: AuthorityFetch = async () => {
    invoked++;
    return jsonResponse(200, {});
  };
  const gate = createRunnerAuthorityClient(
    { mode: 'off', baseURL: BASE_URL, timeoutMS: DEFAULT_AUTHORITY_TIMEOUT_MS },
    { fetchImpl: fetch },
  );
  assert.equal(gate.enabled, false, 'off mode refuses');
  assert.equal(gate.client, undefined, 'off mode returns no client');
  assert.match(gate.refusedReason ?? '', /off/);
  assert.equal(invoked, 0, 'off-mode gate performs zero network calls');
}
{
  // Missing URL even in enforce mode → refuse + zero calls.
  let invoked = 0;
  const fetch: AuthorityFetch = async () => {
    invoked++;
    return jsonResponse(200, {});
  };
  const gate = createRunnerAuthorityClient(
    { mode: 'enforce', baseURL: undefined, timeoutMS: DEFAULT_AUTHORITY_TIMEOUT_MS },
    { fetchImpl: fetch },
  );
  assert.equal(gate.enabled, false, 'missing URL refuses');
  assert.equal(gate.client, undefined);
  assert.match(gate.refusedReason ?? '', /LATTICE_AUTHORITY_URL/);
  assert.equal(invoked, 0, 'missing URL gate performs zero network calls');
}
{
  // Whitespace-only URL still refuses.
  const gate = createRunnerAuthorityClient({ mode: 'enforce', baseURL: '   ', timeoutMS: 1000 });
  assert.equal(gate.enabled, false);
  assert.equal(gate.client, undefined);
}
{
  // Enabled path
  const { fetch } = recordingFetch(() => jsonResponse(200, {}));
  const gate = createRunnerAuthorityClient(
    { mode: 'shadow', baseURL: BASE_URL, timeoutMS: DEFAULT_AUTHORITY_TIMEOUT_MS },
    { fetchImpl: fetch, customerApiKey: 'test-customer-key' },
  );
  assert.equal(gate.enabled, true);
  assert.ok(gate.client instanceof AuthorityClient);
}
{
  // URL alone is not enough for mutating runner traffic: missing customer key refuses with zero calls.
  let invoked = 0;
  const fetch: AuthorityFetch = async () => {
    invoked++;
    return jsonResponse(200, {});
  };
  const gate = createRunnerAuthorityClient(
    { mode: 'enforce', baseURL: BASE_URL, timeoutMS: DEFAULT_AUTHORITY_TIMEOUT_MS },
    { fetchImpl: fetch },
  );
  assert.equal(gate.enabled, false, 'missing customer key refuses');
  assert.equal(gate.client, undefined);
  assert.match(gate.refusedReason ?? '', /CUSTOMER_API_KEY/);
  assert.equal(invoked, 0, 'missing customer key gate performs zero network calls');
}
{
  // Even if a caller reaches the exported live control-plane helper directly,
  // missing customer key must fail closed inside the POST helper before fetch.
  let invoked = 0;
  const out = await runLatticeAuthorityControlPlaneOnce({
    baseURL: BASE_URL,
    timeoutMS: DEFAULT_AUTHORITY_TIMEOUT_MS,
    actorId: ACTOR_ID,
    role: 'runner',
    actorKeyId: 'actor-key-1',
    actorPrivateKey: KP.privateKey,
    actorPrivateKeyEncoding: 'base64',
    runnerId: 'runner-1',
    sessionId: 'session-1',
    runnerProvider: 'codex',
    projectId: 'project-1',
    once: true,
    fetchImpl: (async () => {
      invoked += 1;
      return jsonResponse(200, {});
    }) as unknown as typeof fetch,
  });
  assert.equal(out.status, 'fail', 'direct live control-plane helper fails without customer key');
  const events = out.networkEvents ?? [];
  assert.equal(events[0]?.step, 'register_actor_key');
  assert.equal(events[0]?.ok, false);
  assert.match(events[0]?.message ?? '', /customer_api_key_unconfigured_fails_closed/);
  assert.equal(invoked, 0, 'direct live control-plane helper performs zero network calls without customer key');
}

// ─── 5. Live control-plane reads jobs stream hint, then still signed-claims ──
{
  const { fetch, calls } = controlPlaneFetch(() => textResponse(
    200,
    ': heartbeat\n\nevent: jobs.available\ndata: {"count":2,"jobIds":["job-a","job-b"]}\n\n',
  ));
  const out = await runLatticeAuthorityControlPlaneOnce(liveControlPlaneOptions(fetch));
  const events = out.networkEvents ?? [];
  assert.equal(out.status, 'pass', 'available stream hint still reaches signed claim path');
  assert.deepEqual(
    events.map(event => event.step),
    ['register_actor_key', 'register_runner', 'runner_heartbeat', 'jobs_stream', 'claim_job'],
    'control-plane records stream between heartbeat and claim',
  );
  assert.deepEqual(
    calls.map(call => call.method),
    ['POST', 'POST', 'POST', 'GET', 'POST'],
    'control-plane calls stream with GET before claim POST',
  );
  assert.equal(calls[3].url, `${BASE_URL}/v1/runners/runner-1/jobs/stream`);
  assert.equal(calls[3].headers.Authorization, `Bearer ${TEST_AUTH.customerApiKey}`);
  assert.equal(events.find(event => event.step === 'jobs_stream')?.ok, true);
  assert.equal(events.find(event => event.step === 'claim_job')?.ok, true, 'SSE available triggers signed claim');
}

for (const scenario of [
  {
    name: 'empty',
    stream: () => textResponse(200, 'event: jobs.available\ndata: {"count":0,"jobIds":[]}\n\n'),
  },
  {
    name: 'http_401',
    stream: () => textResponse(
      401,
      `Authorization: Bearer ${TEST_AUTH.customerApiKey}\nraw=${TEST_AUTH.customerApiKey}`,
    ),
    assertRedacted: true,
  },
  {
    name: 'timeout',
    stream: () => {
      throw Object.assign(new Error(`Bearer ${TEST_AUTH.customerApiKey}`), { name: 'AbortError' });
    },
  },
  {
    name: 'body_timeout',
    stream: () => abortingTextResponse(
      200,
      `Authorization: Bearer ${TEST_AUTH.customerApiKey}`,
    ),
    assertRedacted: true,
  },
  {
    name: 'malformed',
    stream: () => textResponse(200, 'event: jobs.available\ndata: {not-json}\n\n'),
  },
  {
    name: 'non_sse',
    stream: () => textResponse(200, '{"legacy":"json-body"}'),
  },
]) {
  const { fetch } = controlPlaneFetch(scenario.stream);
  const out = await runLatticeAuthorityControlPlaneOnce(liveControlPlaneOptions(fetch));
  const events = out.networkEvents ?? [];
  assert.equal(out.status, 'pass', `${scenario.name} stream fallback still reaches signed claim`);
  assert.deepEqual(
    events.map(event => event.step),
    ['register_actor_key', 'register_runner', 'runner_heartbeat', 'jobs_stream', 'claim_job'],
    `${scenario.name} stream keeps claim order`,
  );
  assert.equal(events.find(event => event.step === 'jobs_stream')?.ok, false, `${scenario.name} stream is not an authority success`);
  assert.equal(events.find(event => event.step === 'claim_job')?.ok, true, `${scenario.name} stream fallback claim succeeds`);
  if (scenario.assertRedacted) {
    const message = eventMessage(events, 'jobs_stream');
    assert.ok(!message.includes('Authorization'), 'jobs_stream message redacts Authorization header name');
    assert.ok(!message.includes('Bearer'), 'jobs_stream message redacts Bearer scheme');
    assert.ok(!message.includes(TEST_AUTH.customerApiKey), 'jobs_stream message redacts customer key');
  }
}

// ─── 6. loadRunnerAuthorityClient: env vs override (runtime re-validation) ────
{
  // Empty env → off → refuse
  const gateEmpty = loadRunnerAuthorityClient({});
  assert.equal(gateEmpty.enabled, false, 'empty env defaults to off mode → refuse');

  // shadow env + URL → enabled
  const gateShadow = loadRunnerAuthorityClient({
    LATTICE_AUTHORITY_MODE: 'shadow',
    LATTICE_AUTHORITY_URL: BASE_URL,
    LATTICE_AUTHORITY_CUSTOMER_API_KEY: 'test-customer-key',
  });
  assert.equal(gateShadow.enabled, true);
  assert.equal(gateShadow.settings.mode, 'shadow');
  assert.equal(gateShadow.settings.baseURL, BASE_URL);

  // illegal mode env → off via normalizer → refuse
  const gateIllegal = loadRunnerAuthorityClient({
    LATTICE_AUTHORITY_MODE: 'bogus',
    LATTICE_AUTHORITY_URL: BASE_URL,
  });
  assert.equal(gateIllegal.enabled, false, 'illegal mode normalizes to off → refuse');

  // override beats env
  const gateOverride = loadRunnerAuthorityClient(
    { LATTICE_AUTHORITY_MODE: 'off', LATTICE_AUTHORITY_URL: '', LATTICE_AUTHORITY_CUSTOMER_API_KEY: 'test-customer-key' },
    { authorityMode: 'enforce', authorityURL: BASE_URL },
  );
  assert.equal(gateOverride.enabled, true);
  assert.equal(gateOverride.settings.mode, 'enforce');
}

// ─── 6. Policy discovery never POSTs evidence or runner mutations (PD-2) ──────
{
  const { fetch, calls } = recordingFetch(() => jsonResponse(200, {
    contractVersion: 'authority-policy.v1',
    purpose: 'discovery',
    productionEnforceAuthority: true,
    requireHandshake: true,
    requiredAuthorityMode: 'enforce',
    minClientVersions: {},
    commandCatalogDigest: 'sha256-cat',
    evidenceSchemaDigest: 'sha256-sch',
    requiredEvidenceFields: [],
    supportedAuthorityModes: ['off', 'shadow', 'enforce'],
    evidencePolicy: { preset: 'standard' },
    compatibility: {
      supportedAuthorityModes: ['off', 'shadow', 'enforce'],
      requiredAuthorityMode: 'enforce',
      requireHandshake: true,
      minClientVersions: {},
      commandCatalogDigest: 'sha256-cat',
      evidenceSchemaDigest: 'sha256-sch',
      productionEnforceAuthority: true,
      requireActorKeyBinding: false,
      requireRunnerHeartbeatForL2: false,
    },
  }));
  const client = testAuthorityClient(BASE_URL, fetch);
  await client.discoverPolicy();
  assert.equal(calls.length, 1, 'policy discovery makes exactly one call');
  assert.equal(calls[0].method, 'GET', 'policy discovery is GET, not POST');
  assert.equal(calls[0].url, `${BASE_URL}/v1/authority/policy`);
  assert.ok(calls[0].body === undefined || calls[0].body === '', 'policy discovery has no body');
  // verify NO runner / evidence path was hit
  for (const c of calls) {
    assert.ok(!c.url.includes('/v1/evidence'), 'policy discovery must not hit /v1/evidence');
    assert.ok(!c.url.includes('/v1/runners/register'), 'policy discovery must not hit /v1/runners/register');
    assert.ok(!c.url.includes('/jobs/claim'), 'policy discovery must not hit jobs/claim');
    assert.ok(!c.url.includes('/keys'), 'policy discovery must not hit /keys');
    assert.ok(!c.url.includes('/provider-events'), 'policy discovery must not hit /provider-events');
  }
}

// ─── 7. Policy discovery overclaim guard still active ─────────────────────────
{
  // A policy body containing receipt/accepted/etc must NOT be reported as success.
  const { fetch } = recordingFetch(() => jsonResponse(200, {
    contractVersion: 'authority-policy.v1',
    purpose: 'discovery',
    productionEnforceAuthority: true,
    requireHandshake: true,
    requiredAuthorityMode: 'enforce',
    minClientVersions: {},
    commandCatalogDigest: 'sha256-cat',
    evidenceSchemaDigest: 'sha256-sch',
    requiredEvidenceFields: [],
    supportedAuthorityModes: ['off', 'shadow', 'enforce'],
    evidencePolicy: { preset: 'standard' },
    compatibility: {
      supportedAuthorityModes: ['off', 'shadow', 'enforce'],
      requiredAuthorityMode: 'enforce',
      requireHandshake: true,
      minClientVersions: {},
      commandCatalogDigest: 'sha256-cat',
      evidenceSchemaDigest: 'sha256-sch',
      productionEnforceAuthority: true,
      requireActorKeyBinding: false,
      requireRunnerHeartbeatForL2: false,
    },
    // overclaim:
    accepted: true,
  }));
  const client = testAuthorityClient(BASE_URL, fetch);
  const out = await client.discoverPolicy();
  assert.equal(out.kind, 'error', 'overclaim keys in policy body → error');
  assert.equal(out.ok, false);
}

console.log(PASS_LINE);
