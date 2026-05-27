#!/usr/bin/env node
/**
 * @task B-ea92
 * @checklist CHK-001, CHK-002
 * @title authority enforce policy smoke tests
 * @type chore
 * @priority high
 * @description
 *   Smoke coverage for the read-only authority policy discovery command
 *   (authority_enforce_policy / koala authority enforce policy).
 *
 *   Covers:
 *   - Valid fake policy response → success with disclaimer + all fields printed.
 *   - HTTP error (4xx/5xx) → non-success outcome.
 *   - Connection-refused / unreachable → non-success outcome.
 *   - Malformed / non-JSON body → non-success outcome.
 *   - Overclaim response (body contains `receipt`, `receiptId`, `gatePassed`, or
 *     `accepted`) → non-success outcome.
 *   - Missing KOALA_AUTHORITY_URL → non-success with descriptive message.
 *   - GET /v1/authority/policy is called (correct path).
 *   - /v1/evidence and /v1/evidence/batch POST are NEVER called.
 *
 *   Forbidden by M1 scope: actor keys, runner registration, jobs, provider
 *   execution, evidence submission, signatures, receipt verification, and L2+
 *   gate promotion.
 */
import assert from 'node:assert/strict';
import {
  runAuthorityEnforcePolicy,
  AUTHORITY_ENFORCE_POLICY_DISCLAIMER,
} from '../handlers/authority-enforce.js';
import type { AuthorityFetch } from '../core/authority-client.js';

// ── helpers ────────────────────────────────────────────────────────────────

/** Build a fake policy body that satisfies the authority-policy.v1 contract. */
function fakePolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 'authority-policy.v1',
    purpose: 'discovery',
    compatibility: ['koala-cli@0.3'],
    commandCatalogDigest: 'sha256-catalog-abc123',
    evidenceSchemaDigest: 'sha256-schema-def456',
    supportedAuthorityModes: ['off', 'shadow', 'enforce'],
    evidencePolicy: { preset: 'standard' },
    ...overrides,
  };
}

/** Track which URLs and methods were called by the injected fetch stub. */
interface CallRecord { url: string; method: string; }

/**
 * Build a fetch stub that records calls and returns the given status/body.
 * Returns the call record array so callers can assert no /v1/evidence calls.
 */
function fetchStub(status: number, body: string): { fetch: AuthorityFetch; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const fetch: AuthorityFetch = async (url, init) => {
    calls.push({ url, method: init.method });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    };
  };
  return { fetch, calls };
}

function fetchThrows(error: unknown): { fetch: AuthorityFetch; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const fetch: AuthorityFetch = async (url, init) => {
    calls.push({ url, method: init.method });
    throw error;
  };
  return { fetch, calls };
}

/** Assert that no call in `calls` hits /v1/evidence (single or batch). */
function assertNoEvidencePost(calls: CallRecord[], label: string): void {
  for (const call of calls) {
    assert.ok(
      !call.url.includes('/v1/evidence'),
      `[${label}] must not call /v1/evidence — got ${call.method} ${call.url}`,
    );
  }
}

const BASE_URL = 'https://authority.test';

// ── 1. Valid fake policy → success ─────────────────────────────────────────
{
  const { fetch, calls } = fetchStub(200, JSON.stringify(fakePolicy()));
  const result = await runAuthorityEnforcePolicy(
    { authorityURL: BASE_URL, _fetchImpl: fetch },
    { KOALA_AUTHORITY_URL: BASE_URL },
  );

  assert.equal(result.ok, true, 'valid policy → ok:true');
  assert.equal(result.disclaimer, AUTHORITY_ENFORCE_POLICY_DISCLAIMER, 'disclaimer always present on success');
  assert.equal(result.contractVersion, 'authority-policy.v1', 'contractVersion');
  assert.equal(result.purpose, 'discovery', 'purpose');
  assert.equal(result.commandCatalogDigest, 'sha256-catalog-abc123', 'commandCatalogDigest');
  assert.equal(result.evidenceSchemaDigest, 'sha256-schema-def456', 'evidenceSchemaDigest');
  assert.deepEqual(result.supportedAuthorityModes, ['off', 'shadow', 'enforce'], 'supportedAuthorityModes');
  assert.equal(result.evidencePolicyPreset, 'standard', 'evidencePolicyPreset');
  assert.deepEqual(result.compatibility, ['koala-cli@0.3'], 'compatibility');

  // GET /v1/authority/policy is the only call
  assert.equal(calls.length, 1, 'exactly one fetch call');
  assert.ok(calls[0].url.includes('/v1/authority/policy'), `GET path must be /v1/authority/policy, got ${calls[0].url}`);
  assert.equal(calls[0].method, 'GET', 'method must be GET');

  // No /v1/evidence call
  assertNoEvidencePost(calls, 'valid-policy');
}

// ── 2. HTTP error (4xx) → non-success ──────────────────────────────────────
for (const status of [400, 403, 404, 422, 500, 503]) {
  const { fetch, calls } = fetchStub(status, 'bad request');
  const result = await runAuthorityEnforcePolicy(
    { authorityURL: BASE_URL, _fetchImpl: fetch },
    {},
  );
  assert.equal(result.ok, false, `HTTP ${status} → ok:false`);
  assert.equal(result.disclaimer, AUTHORITY_ENFORCE_POLICY_DISCLAIMER, `HTTP ${status} → disclaimer always present`);
  assert.ok(result.error, `HTTP ${status} → error message set`);
  assertNoEvidencePost(calls, `http-error-${status}`);
}

// ── 3. Connection refused / unreachable → non-success ─────────────────────
for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH']) {
  const err = Object.assign(new Error('network down'), { code });
  const { fetch, calls } = fetchThrows(err);
  const result = await runAuthorityEnforcePolicy(
    { authorityURL: BASE_URL, _fetchImpl: fetch },
    {},
  );
  assert.equal(result.ok, false, `${code} → ok:false`);
  assert.equal(result.disclaimer, AUTHORITY_ENFORCE_POLICY_DISCLAIMER, `${code} → disclaimer always present`);
  assert.ok(result.error, `${code} → error message set`);
  assertNoEvidencePost(calls, `conn-refused-${code}`);
}

// ── 4. Timeout → non-success ───────────────────────────────────────────────
{
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const { fetch, calls } = fetchThrows(abortErr);
  const result = await runAuthorityEnforcePolicy(
    { authorityURL: BASE_URL, _fetchImpl: fetch },
    {},
  );
  assert.equal(result.ok, false, 'timeout → ok:false');
  assert.equal(result.disclaimer, AUTHORITY_ENFORCE_POLICY_DISCLAIMER, 'timeout → disclaimer always present');
  assert.ok(result.error, 'timeout → error message set');
  assertNoEvidencePost(calls, 'timeout');
}

// ── 5. Malformed / non-JSON body → non-success ─────────────────────────────
{
  const { fetch, calls } = fetchStub(200, 'not-json{{{');
  const result = await runAuthorityEnforcePolicy(
    { authorityURL: BASE_URL, _fetchImpl: fetch },
    {},
  );
  assert.equal(result.ok, false, 'non-JSON body → ok:false');
  assert.equal(result.disclaimer, AUTHORITY_ENFORCE_POLICY_DISCLAIMER, 'non-JSON → disclaimer always present');
  assert.ok(result.error, 'non-JSON → error message set');
  assertNoEvidencePost(calls, 'malformed-json');
}

// ── 5b. Schema-valid JSON but missing required fields → non-success ─────────
{
  // Missing `commandCatalogDigest` — schema validation fails.
  const body = JSON.stringify({ contractVersion: 'authority-policy.v1', purpose: 'discovery' });
  const { fetch, calls } = fetchStub(200, body);
  const result = await runAuthorityEnforcePolicy(
    { authorityURL: BASE_URL, _fetchImpl: fetch },
    {},
  );
  assert.equal(result.ok, false, 'incomplete schema → ok:false');
  assert.equal(result.disclaimer, AUTHORITY_ENFORCE_POLICY_DISCLAIMER, 'incomplete schema → disclaimer');
  assertNoEvidencePost(calls, 'malformed-schema');
}

// ── 6. Overclaim keys → non-success ────────────────────────────────────────
// The response body contains keys that belong to the evidence-submission protocol;
// a discovery endpoint must never return them.
for (const overclaim of ['receipt', 'receiptId', 'gatePassed', 'accepted']) {
  const body = JSON.stringify(fakePolicy({ [overclaim]: 'sneaky-value' }));
  const { fetch, calls } = fetchStub(200, body);
  const result = await runAuthorityEnforcePolicy(
    { authorityURL: BASE_URL, _fetchImpl: fetch },
    {},
  );
  assert.equal(result.ok, false, `overclaim key "${overclaim}" → ok:false`);
  assert.equal(result.disclaimer, AUTHORITY_ENFORCE_POLICY_DISCLAIMER, `overclaim "${overclaim}" → disclaimer`);
  assert.ok(result.error?.includes(overclaim), `overclaim "${overclaim}" → error names the offending key`);
  assertNoEvidencePost(calls, `overclaim-${overclaim}`);
}

// ── 7. Missing URL → non-success, no network call ─────────────────────────
{
  const { fetch, calls } = fetchStub(200, JSON.stringify(fakePolicy()));
  const result = await runAuthorityEnforcePolicy(
    { _fetchImpl: fetch },
    {}, // no KOALA_AUTHORITY_URL
  );
  assert.equal(result.ok, false, 'missing URL → ok:false');
  assert.equal(result.disclaimer, AUTHORITY_ENFORCE_POLICY_DISCLAIMER, 'missing URL → disclaimer');
  assert.ok(result.error?.includes('KOALA_AUTHORITY_URL'), 'missing URL → error names the env var');
  assert.equal(calls.length, 0, 'missing URL → no network call made');
}

// ── 8. Disclaimer always appears on success output ─────────────────────────
// (The handler output includes the disclaimer string on every successful call.)
{
  const { fetch } = fetchStub(200, JSON.stringify(fakePolicy()));
  const result = await runAuthorityEnforcePolicy(
    { authorityURL: BASE_URL, _fetchImpl: fetch },
    {},
  );
  assert.ok(result.ok, 'baseline for disclaimer check');
  assert.ok(
    result.disclaimer === AUTHORITY_ENFORCE_POLICY_DISCLAIMER,
    'disclaimer matches the constant: "Authority policy discovery only: no receipt, no gate pass, no evidence submission."',
  );
}

// ── 9. No /v1/evidence or /v1/evidence/batch POST under any scenario ────────
// Belt-and-suspenders: verify the function never calls POST /v1/evidence or
// POST /v1/evidence/batch, even when it would normally succeed.
{
  const forbidden: CallRecord[] = [];
  const fetchSpy: AuthorityFetch = async (url, init) => {
    forbidden.push({ url, method: init.method });
    if (init.method === 'POST' && url.includes('/v1/evidence')) {
      throw new Error(`FORBIDDEN: policy discovery must not POST to ${url}`);
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(fakePolicy()),
    };
  };
  const result = await runAuthorityEnforcePolicy(
    { authorityURL: BASE_URL, _fetchImpl: fetchSpy },
    {},
  );
  assert.equal(result.ok, true, 'spy scenario: result ok');
  const evidencePosts = forbidden.filter(c => c.method === 'POST' && c.url.includes('/v1/evidence'));
  assert.equal(
    evidencePosts.length,
    0,
    `authority_enforce_policy must never POST to /v1/evidence or /v1/evidence/batch; got: ${JSON.stringify(evidencePosts)}`,
  );
}

console.log('authority-enforce-policy smoke passed');
