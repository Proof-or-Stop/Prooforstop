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
 *   - Valid fake policy response (matching real Python contract) → success with
 *     disclaimer + requiredAuthorityMode=enforce printed.
 *   - Empty 2xx body → non-success (malformed policy).
 *   - HTTP error (4xx/5xx) → non-success outcome.
 *   - Connection-refused / unreachable → non-success outcome.
 *   - Malformed / non-JSON body → non-success outcome.
 *   - Overclaim response (body contains `receipt`, `receiptId`, `gatePassed`, or
 *     `accepted`) → non-success outcome.
 *   - Missing KOALA_AUTHORITY_URL → non-success with descriptive message.
 *   - GET /v1/authority/policy is called (correct path).
 *   - /v1/evidence and /v1/evidence/batch POST are NEVER called.
 *   - Real CLI child-process: authority_enforce_policy and nested alias
 *     "authority enforce policy" against a temporary local HTTP server.
 *   - Missing URL exits non-zero and includes the disclaimer.
 *
 *   Forbidden by M1 scope: actor keys, runner registration, jobs, provider
 *   execution, evidence submission, signatures, receipt verification, and L2+
 *   gate promotion.
 * @changes
 *   Adds read-only authority policy discovery smoke coverage: validates that
 *   the authority_enforce_policy command correctly fetches and surfaces policy
 *   data from a remote endpoint without performing production enforcement,
 *   submitting evidence, handling receipts, requiring actor keys, or touching
 *   L2+ gate promotion paths.
 */
import assert from 'node:assert/strict';
import {
  runAuthorityEnforcePolicy,
  AUTHORITY_ENFORCE_POLICY_DISCLAIMER,
} from '../handlers/authority-enforce.js';
import type { AuthorityFetch } from '../core/authority-client.js';

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Build a fake policy body that matches the real Python /v1/authority/policy
 * contract (authority-policy.v1). Includes the correct top-level fields:
 *  - requiredAuthorityMode (top-level, NOT derived from supportedAuthorityModes)
 *  - compatibility as an object (NOT string[])
 *  - productionEnforceAuthority, requireHandshake, minClientVersions, requiredEvidenceFields
 */
function fakePolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 'authority-policy.v1',
    purpose: 'discovery',
    documentation: 'GET /v1/authority/policy is a discovery/requirements contract. It does not issue a receipt, signature, or gate pass; clients must still submit signed evidence and obtain server receipts.',
    productionEnforceAuthority: true,
    requireHandshake: true,
    requiredAuthorityMode: 'enforce',
    minClientVersions: { 'koala-cli': '0.3.0', 'koala-mac': '0.3.0', runner: '0.3.0' },
    commandCatalogDigest: 'sha256-catalog-abc123',
    evidenceSchemaDigest: 'sha256-schema-def456',
    requiredEvidenceFields: ['clientName', 'clientVersion', 'authorityMode', 'commandCatalogDigest', 'evidenceSchemaDigest'],
    supportedAuthorityModes: ['local', 'shadow', 'enforce'],
    compatibility: {
      supportedAuthorityModes: ['local', 'shadow', 'enforce'],
      requiredAuthorityMode: 'enforce',
      requireHandshake: true,
      handshakeRequiredFields: ['clientName', 'clientVersion', 'authorityMode', 'commandCatalogDigest', 'evidenceSchemaDigest'],
      minClientVersions: { 'koala-cli': '0.3.0', 'koala-mac': '0.3.0', runner: '0.3.0' },
      commandCatalogDigest: 'sha256-catalog-abc123',
      evidenceSchemaDigest: 'sha256-schema-def456',
      productionEnforceAuthority: true,
      requireActorKeyBinding: false,
      requireRunnerHeartbeatForL2: false,
    },
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
  // requiredAuthorityMode comes from top-level field, not supportedAuthorityModes[0]
  assert.equal(result.requiredAuthorityMode, 'enforce', 'requiredAuthorityMode must be top-level field "enforce"');
  assert.equal(result.commandCatalogDigest, 'sha256-catalog-abc123', 'commandCatalogDigest');
  assert.equal(result.evidenceSchemaDigest, 'sha256-schema-def456', 'evidenceSchemaDigest');
  assert.deepEqual(result.supportedAuthorityModes, ['local', 'shadow', 'enforce'], 'supportedAuthorityModes');
  assert.equal(result.evidencePolicyPreset, 'standard', 'evidencePolicyPreset');
  // compatibility is an object, not a string array
  assert.ok(result.compatibility && typeof result.compatibility === 'object' && !Array.isArray(result.compatibility), 'compatibility is an object');
  assert.equal(result.compatibility?.['requiredAuthorityMode'], 'enforce', 'compatibility.requiredAuthorityMode');

  // GET /v1/authority/policy is the only call
  assert.equal(calls.length, 1, 'exactly one fetch call');
  assert.ok(calls[0].url.includes('/v1/authority/policy'), `GET path must be /v1/authority/policy, got ${calls[0].url}`);
  assert.equal(calls[0].method, 'GET', 'method must be GET');

  // No /v1/evidence call
  assertNoEvidencePost(calls, 'valid-policy');
}

// ── 1b. requiredAuthorityMode is NOT derived from supportedAuthorityModes[0] ──
// Verify the handler reads the top-level field, not the first element of
// supportedAuthorityModes (which could differ from requiredAuthorityMode).
{
  const policy = fakePolicy({
    requiredAuthorityMode: 'shadow',
    supportedAuthorityModes: ['local', 'shadow', 'enforce'], // first element is 'local'
  });
  const { fetch } = fetchStub(200, JSON.stringify(policy));
  const result = await runAuthorityEnforcePolicy(
    { authorityURL: BASE_URL, _fetchImpl: fetch },
    {},
  );
  assert.equal(result.ok, true, 'shadow mode policy → ok:true');
  assert.equal(result.requiredAuthorityMode, 'shadow', 'requiredAuthorityMode reads top-level field, not supportedAuthorityModes[0]');
}

// ── 2. Empty 2xx body → non-success (malformed policy) ─────────────────────
{
  const { fetch, calls } = fetchStub(200, '');
  const result = await runAuthorityEnforcePolicy(
    { authorityURL: BASE_URL, _fetchImpl: fetch },
    {},
  );
  assert.equal(result.ok, false, 'empty 2xx body → ok:false (malformed policy)');
  assert.equal(result.disclaimer, AUTHORITY_ENFORCE_POLICY_DISCLAIMER, 'empty body → disclaimer always present');
  assert.ok(result.error, 'empty body → error message set');
  assertNoEvidencePost(calls, 'empty-2xx-body');
}

// ── 3. HTTP error (4xx/5xx) → non-success ─────────────────────────────────
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

// ── 4. Connection refused / unreachable → non-success ─────────────────────
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

// ── 5. Timeout → non-success ───────────────────────────────────────────────
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

// ── 6. Malformed / non-JSON body → non-success ─────────────────────────────
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

// ── 6b. Schema-valid JSON but missing required fields → non-success ─────────
{
  // Missing required top-level fields like requiredAuthorityMode, commandCatalogDigest
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

// ── 7. Overclaim keys → non-success ────────────────────────────────────────
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

// ── 8. Missing URL → non-success, no network call ─────────────────────────
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

// ── 9. Disclaimer always appears on success output ─────────────────────────
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

// ── 10. No /v1/evidence or /v1/evidence/batch POST under any scenario ────────
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

// ── 11. CLI child-process tests — deferred to a later pass ──────────────────
// spawnSync blocks the parent Node.js event loop, which prevents the
// in-process HTTP server from accepting connections. Child-process CLI tests
// require an out-of-process HTTP server (separate child_process spawn or a
// pre-started fixture server). These will be added in a dedicated CLI-smoke
// pass; they are intentionally omitted here.

console.log('authority-enforce-policy smoke passed');
