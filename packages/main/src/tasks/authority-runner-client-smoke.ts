#!/usr/bin/env node
//
// Authority runner client smoke (B-1123 milestone 2).
//
// Pure in-process smoke (no real network). Proves:
//   1. Each runner endpoint method hits the expected path EXACTLY ONCE per call:
//        POST /v1/actors/{actorId}/keys
//        POST /v1/runners/register
//        POST /v1/runners/{runnerId}/heartbeat
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
//   ✓ authority runner client smoke passed: 7 runner endpoints hit, off-mode performs zero network calls

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

const PASS_LINE =
  '✓ authority runner client smoke passed: 7 runner endpoints hit, off-mode performs zero network calls';

const NONCE = 'n-1';
const CREATED_AT = '2026-06-02T18:00:00.000Z';
const ACTOR_ID = 'actor-1';
const BASE_URL = 'https://authority.test';
const KP = generateEd25519KeyPair();

// ─── recording fake fetch ─────────────────────────────────────────────────────
interface RecordedCall {
  url: string;
  method: string;
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
    const call: RecordedCall = { url, method: init.method, body, bodyText: init.body };
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

function thrower(error: unknown): AuthorityFetch {
  return async () => {
    throw error;
  };
}

function header() {
  return { actorId: ACTOR_ID, nonce: NONCE, createdAt: CREATED_AT };
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
    const client = new AuthorityClient(BASE_URL, fetch);
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
    const client = new AuthorityClient(BASE_URL, fetch);
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
    const client = new AuthorityClient(BASE_URL, fetch);
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

  // 1d. claimJob — JobSpec response shape
  {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, jobSpec));
    const client = new AuthorityClient(BASE_URL, fetch);
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
    const client = new AuthorityClient(BASE_URL, fetch);
    const env: JobClaim = { ...header(), runnerId: 'runner-1' };
    const { signed } = signRunnerEnvelope(env, KP.privateKey);
    const out = await client.claimJob('runner-1', signed);
    assert.equal(out.kind, 'success', 'null JobSpec is still success');
    assert.equal(calls.length, 1);
    assert.equal(out.data, null);
  }

  // 1e. heartbeatJob
  {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, acceptedReceipt));
    const client = new AuthorityClient(BASE_URL, fetch);
    const env: JobLeaseHeartbeat = { ...header(), jobId: 'job-1', progress: 0.25 };
    const { signed } = signRunnerEnvelope(env, KP.privateKey);
    const out = await client.heartbeatJob('job-1', signed);
    assert.equal(out.kind, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE_URL}/v1/jobs/job-1/heartbeat`);
    JobLeaseHeartbeatSchema.parse(calls[0].body);
  }

  // 1f. releaseJob
  {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, acceptedReceipt));
    const client = new AuthorityClient(BASE_URL, fetch);
    const env: JobRelease = { ...header(), jobId: 'job-1', outcome: 'completed', evidenceId: 'EV-1' };
    const { signed } = signRunnerEnvelope(env, KP.privateKey);
    const out = await client.releaseJob('job-1', signed);
    assert.equal(out.kind, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE_URL}/v1/jobs/job-1/release`);
    JobReleaseSchema.parse(calls[0].body);
  }

  // 1g. submitProviderEvents
  {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, acceptedReceipt));
    const client = new AuthorityClient(BASE_URL, fetch);
    const env: ProviderEventsEnvelope = {
      ...header(),
      runId: 'run-1',
      events: [{ eventId: 'e1', kind: 'start', occurredAt: CREATED_AT }],
    };
    const { signed } = signRunnerEnvelope(env, KP.privateKey);
    const out = await client.submitProviderEvents('run-1', signed);
    assert.equal(out.kind, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE_URL}/v1/runs/run-1/provider-events`);
    ProviderEventsEnvelopeSchema.parse(calls[0].body);
  }
}

// ─── 2. Empty path parameters throw at the client entry ───────────────────────
{
  const { fetch, calls } = recordingFetch(() => jsonResponse(200, {}));
  const client = new AuthorityClient(BASE_URL, fetch);
  const env: RunnerHeartbeat = { ...header(), runnerId: 'r' };
  const { signed } = signRunnerEnvelope(env, KP.privateKey);
  await assert.rejects(() => client.heartbeatRunner('', signed), /runnerId/);
  await assert.rejects(() => client.heartbeatRunner('   ', signed), /runnerId/);
  await assert.rejects(() => client.claimJob('', { ...header(), runnerId: 'r' } as any), /runnerId/);
  await assert.rejects(() => client.heartbeatJob('', { ...header(), jobId: 'j' } as any), /jobId/);
  await assert.rejects(() => client.releaseJob('', { ...header(), jobId: 'j', outcome: 'completed' } as any), /jobId/);
  await assert.rejects(() => client.submitProviderEvents('', { ...header(), runId: 'r', events: [] } as any), /runId/);
  await assert.rejects(() => client.registerActorKey('', { ...header(), publicKey: 'k' } as any), /actorId/);
  assert.equal(calls.length, 0, 'no network call when path params are empty');
}

// ─── 3. Outcome taxonomy: http_error / error / connection_refused ─────────────
{
  // http_error (5xx)
  const { fetch } = recordingFetch(() => jsonResponse(503, 'down'));
  const client = new AuthorityClient(BASE_URL, fetch);
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
  const client = new AuthorityClient(BASE_URL, fetch);
  const env: JobClaim = { ...header(), runnerId: 'r' };
  const { signed } = signRunnerEnvelope(env, KP.privateKey);
  const out = await client.claimJob('r', signed);
  assert.equal(out.kind, 'error', 'malformed 2xx body maps to error');
  assert.equal(out.ok, false);
}
{
  // Connection refused
  const err = Object.assign(new Error('boom'), { code: 'ECONNREFUSED' });
  const client = new AuthorityClient(BASE_URL, thrower(err));
  const env: RunnerHeartbeat = { ...header(), runnerId: 'r' };
  const { signed } = signRunnerEnvelope(env, KP.privateKey);
  const out = await client.heartbeatRunner('r', signed);
  assert.equal(out.kind, 'connection_refused');
  assert.equal(out.ok, false);
}
{
  // Timeout / abort
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const client = new AuthorityClient(BASE_URL, thrower(abortErr));
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
    { fetchImpl: fetch },
  );
  assert.equal(gate.enabled, true);
  assert.ok(gate.client instanceof AuthorityClient);
}

// ─── 5. loadRunnerAuthorityClient: env vs override (runtime re-validation) ────
{
  // Empty env → off → refuse
  const gateEmpty = loadRunnerAuthorityClient({});
  assert.equal(gateEmpty.enabled, false, 'empty env defaults to off mode → refuse');

  // shadow env + URL → enabled
  const gateShadow = loadRunnerAuthorityClient({
    LATTICE_AUTHORITY_MODE: 'shadow',
    LATTICE_AUTHORITY_URL: BASE_URL,
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
    { LATTICE_AUTHORITY_MODE: 'off', LATTICE_AUTHORITY_URL: '' },
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
  const client = new AuthorityClient(BASE_URL, fetch);
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
  const client = new AuthorityClient(BASE_URL, fetch);
  const out = await client.discoverPolicy();
  assert.equal(out.kind, 'error', 'overclaim keys in policy body → error');
  assert.equal(out.ok, false);
}

console.log(PASS_LINE);
