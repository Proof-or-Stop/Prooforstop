#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  AuthorityClient,
  type AuthorityFetch,
  joinURL,
} from '../core/authority-client.js';
import {
  AUTHORITY_MODES,
  DEFAULT_AUTHORITY_TIMEOUT_MS,
  authorityModeEnabled,
  loadAuthoritySettings,
  normalizeAuthorityMode,
  normalizeAuthorityTimeout,
  normalizeAuthorityURL,
} from '../core/authority-mode.js';
import {
  buildAuthorityEvidenceBatchSubmission,
  buildAuthorityEvidenceSubmission,
  isAuthorityBatchFullyAccepted,
  type EvidenceEnvelopeContract,
} from '../core/authority-contracts.js';

function envelope(id = 'EV-1'): EvidenceEnvelopeContract {
  return {
    evidenceId: id,
    projectId: 'proj',
    storyId: 'B-94a6',
    producerActorId: 'actor-1',
    role: 'verifier',
    kind: 'logic_test',
    trustLevel: 2,
    repo: {},
    coveredRefs: [],
    uncoveredRefs: [],
    failedRefs: [],
    inspectedArtifacts: [],
    inspectedFiles: [],
    inspectedHunks: [],
    inspectedPackRefs: [],
    nonce: 'nonce-1',
    createdAt: '2026-05-21T00:00:00Z',
  };
}

function fetchReturning(status: number, body: string): AuthorityFetch {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });
}

function fetchThrowing(error: unknown): AuthorityFetch {
  return async () => {
    throw error;
  };
}

// --- authority-mode normalization (runtime, not Zod-only) ----------------------
assert.equal(normalizeAuthorityMode('off'), 'off');
assert.equal(normalizeAuthorityMode('shadow'), 'shadow');
assert.equal(normalizeAuthorityMode('enforce'), 'enforce');
// unset / empty / whitespace / illegal -> off
assert.equal(normalizeAuthorityMode(undefined), 'off');
assert.equal(normalizeAuthorityMode(''), 'off');
assert.equal(normalizeAuthorityMode('   '), 'off');
assert.equal(normalizeAuthorityMode('ENFORCE'), 'off'); // case sensitive
assert.equal(normalizeAuthorityMode('local'), 'off'); // legacy stash name not honored
assert.equal(normalizeAuthorityMode('bogus'), 'off');
assert.equal(normalizeAuthorityMode(123 as unknown), 'off');
assert.equal(normalizeAuthorityMode(null), 'off');
// leading/trailing whitespace around a valid value is trimmed
assert.equal(normalizeAuthorityMode('  enforce  '), 'enforce');
assert.deepEqual([...AUTHORITY_MODES], ['off', 'shadow', 'enforce']);
assert.equal(authorityModeEnabled('off'), false);
assert.equal(authorityModeEnabled('shadow'), true);
assert.equal(authorityModeEnabled('enforce'), true);

// --- url + timeout normalization ----------------------------------------------
assert.equal(normalizeAuthorityURL('https://authority.test/'), 'https://authority.test/');
assert.equal(normalizeAuthorityURL('  '), undefined);
assert.equal(normalizeAuthorityURL(undefined), undefined);
assert.equal(normalizeAuthorityTimeout('5000'), 5000);
assert.equal(normalizeAuthorityTimeout(7500), 7500);
assert.equal(normalizeAuthorityTimeout('0'), DEFAULT_AUTHORITY_TIMEOUT_MS);
assert.equal(normalizeAuthorityTimeout('-3'), DEFAULT_AUTHORITY_TIMEOUT_MS);
assert.equal(normalizeAuthorityTimeout('abc'), DEFAULT_AUTHORITY_TIMEOUT_MS);
assert.equal(normalizeAuthorityTimeout(undefined), DEFAULT_AUTHORITY_TIMEOUT_MS);

// --- loadAuthoritySettings: env vs override -----------------------------------
{
  const fromEnv = loadAuthoritySettings({
    LATTICE_AUTHORITY_MODE: 'shadow',
    LATTICE_AUTHORITY_URL: 'https://env.test',
    LATTICE_AUTHORITY_TIMEOUT_MS: '2500',
  });
  assert.deepEqual(fromEnv, { mode: 'shadow', baseURL: 'https://env.test', timeoutMS: 2500 });

  const emptyEnv = loadAuthoritySettings({});
  assert.deepEqual(emptyEnv, { mode: 'off', baseURL: undefined, timeoutMS: DEFAULT_AUTHORITY_TIMEOUT_MS });

  // CLI inline override beats env
  const overridden = loadAuthoritySettings(
    { LATTICE_AUTHORITY_MODE: 'off', LATTICE_AUTHORITY_URL: 'https://env.test' },
    { authorityMode: 'enforce', authorityURL: 'https://override.test', authorityTimeoutMS: 1234 },
  );
  assert.deepEqual(overridden, {
    mode: 'enforce',
    baseURL: 'https://override.test',
    timeoutMS: 1234,
  });

  // illegal override mode still falls back to off (runtime re-validation)
  const illegalOverride = loadAuthoritySettings(
    { LATTICE_AUTHORITY_MODE: 'enforce' },
    { authorityMode: 'garbage' },
  );
  assert.equal(illegalOverride.mode, 'off');
}

// --- additive submission contract helpers -------------------------------------
{
  const single = buildAuthorityEvidenceSubmission(envelope('EV-single'));
  assert.equal(single.evidence.evidenceId, 'EV-single');
  const batch = buildAuthorityEvidenceBatchSubmission([envelope('EV-a'), envelope('EV-b')]);
  assert.equal(batch.evidences.length, 2);
  assert.deepEqual(batch.evidences.map(e => e.evidenceId), ['EV-a', 'EV-b']);

  assert.equal(isAuthorityBatchFullyAccepted({ accepted: true }), true);
  assert.equal(isAuthorityBatchFullyAccepted({ accepted: false }), false);
  assert.equal(
    isAuthorityBatchFullyAccepted({ accepted: true, results: [{ accepted: true }, { accepted: true }] }),
    true,
  );
  // partial acceptance -> whole-batch failure (preMortem #3)
  assert.equal(
    isAuthorityBatchFullyAccepted({ accepted: true, results: [{ accepted: true }, { accepted: false }] }),
    false,
  );
}

// --- joinURL ------------------------------------------------------------------
assert.equal(joinURL('https://a.test/', '/v1/evidence'), 'https://a.test/v1/evidence');
assert.equal(joinURL('https://a.test', 'v1/evidence'), 'https://a.test/v1/evidence');

// --- client outcome taxonomy: success -----------------------------------------
{
  const client = new AuthorityClient('https://a.test', fetchReturning(200, JSON.stringify({ accepted: true, evidenceId: 'EV-1' })));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'success');
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
  assert.equal(out.data?.accepted, true);
  assert.equal(out.data?.evidenceId, 'EV-1');
}

// success with empty body parses to {}
{
  const client = new AuthorityClient('https://a.test', fetchReturning(204, ''));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'success');
  assert.deepEqual(out.data, {});
}

// --- client outcome taxonomy: http_error (4xx + 5xx) --------------------------
for (const status of [400, 409, 422, 500, 503]) {
  const client = new AuthorityClient('https://a.test', fetchReturning(status, 'rejected'));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'http_error', `status ${status} should be http_error`);
  assert.equal(out.ok, false);
  assert.equal(out.status, status);
  assert.ok(out.message?.includes(String(status)));
}

// --- client outcome taxonomy: timeout -----------------------------------------
{
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const client = new AuthorityClient('https://a.test', fetchThrowing(abortErr));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'timeout');
  assert.equal(out.ok, false);
  assert.ok(out.message?.includes('timed out'));
}
{
  const abortErr = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
  const client = new AuthorityClient('https://a.test', fetchThrowing(abortErr));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'timeout');
}

// --- client outcome taxonomy: connection_refused ------------------------------
for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET']) {
  const err = Object.assign(new Error('boom'), { code });
  const client = new AuthorityClient('https://a.test', fetchThrowing(err));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'connection_refused', `${code} should be connection_refused`);
  assert.equal(out.ok, false);
}
// connection error nested in cause (node fetch wrapping)
{
  const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const client = new AuthorityClient('https://a.test', fetchThrowing(err));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'connection_refused');
}

// --- client outcome taxonomy: generic error (e.g. JSON parse) -----------------
{
  const client = new AuthorityClient('https://a.test', fetchReturning(200, 'not-json{'));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'error');
  assert.equal(out.ok, false);
}
{
  const client = new AuthorityClient('https://a.test', fetchThrowing(new TypeError('weird')));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'error');
}

// --- F-001: 2xx but malformed body fails the submission-result schema ----------
// A parseable-but-wrong-shape body must NOT be reported as success; it maps to
// `error` (ok:false) so enforce gates the write and shadow degrades to a warning.
{
  // Missing the required `accepted` boolean.
  const client = new AuthorityClient('https://a.test', fetchReturning(200, JSON.stringify({ evidenceId: 'EV-1' })));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'error', 'single: malformed 2xx body -> error');
  assert.equal(out.ok, false);
  assert.equal(out.status, 200);
  assert.ok(out.message?.includes('schema validation'), 'single: schema-validation message');
}
{
  // `accepted` present but wrong type.
  const client = new AuthorityClient('https://a.test', fetchReturning(200, JSON.stringify({ accepted: 'yes' })));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'error', 'single: wrong-typed accepted -> error');
  assert.equal(out.ok, false);
}
{
  // A valid {accepted:false} body is still a SUCCESS outcome (schema passes); the
  // mode logic — not the client — decides rejection from the accepted flag.
  const client = new AuthorityClient('https://a.test', fetchReturning(200, JSON.stringify({ accepted: false, reason: 'no' })));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'success', 'single: valid {accepted:false} stays success at client level');
  assert.equal(out.data?.accepted, false);
}
{
  // Batch: malformed entry result (accepted not a boolean) -> error.
  const client = new AuthorityClient(
    'https://a.test',
    fetchReturning(200, JSON.stringify({ accepted: true, results: [{ accepted: 'maybe' }] })),
  );
  const out = await client.submitEvidenceBatch([envelope('EV-a')]);
  assert.equal(out.kind, 'error', 'batch: malformed entry result -> error');
  assert.equal(out.ok, false);
}

// --- batch submission outcomes ------------------------------------------------
{
  const client = new AuthorityClient(
    'https://a.test',
    fetchReturning(200, JSON.stringify({ accepted: true, results: [{ accepted: true }, { accepted: true }] })),
  );
  const out = await client.submitEvidenceBatch([envelope('EV-a'), envelope('EV-b')]);
  assert.equal(out.kind, 'success');
  assert.equal(out.data?.accepted, true);
  assert.equal(isAuthorityBatchFullyAccepted(out.data!), true);
}
{
  // server accepts top-level but rejects one entry -> not fully accepted
  const client = new AuthorityClient(
    'https://a.test',
    fetchReturning(200, JSON.stringify({ accepted: true, results: [{ accepted: true }, { accepted: false, reason: 'dup' }] })),
  );
  const out = await client.submitEvidenceBatch([envelope('EV-a'), envelope('EV-b')]);
  assert.equal(out.kind, 'success');
  assert.equal(isAuthorityBatchFullyAccepted(out.data!), false);
}
{
  const client = new AuthorityClient('https://a.test', fetchReturning(500, 'down'));
  const out = await client.submitEvidenceBatch([envelope('EV-a')]);
  assert.equal(out.kind, 'http_error');
}

console.log('authority client smoke passed');
