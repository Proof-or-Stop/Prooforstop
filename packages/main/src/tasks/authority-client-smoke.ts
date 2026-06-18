#!/usr/bin/env node
/**
 * @task B-e3d9
 * @checklist CHK-001
 * @title Smoke unsupported algorithm rejection in authority receipt verification
 * @type bugfix
 * @priority high
 * @description
 *   Prove the authority client fails closed when production receipt verification
 *   material is discovered with an unsupported algorithm. The smoke keeps the
 *   receipt payload otherwise valid so the rejection is isolated to
 *   `serverKey.algorithm` rather than any digest-prefix or subject binding path.
 * @changes
 *   - [CHK-001] Assert a discovered unsupported algorithm yields `receipt_unverified` and blocks authority DONE.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuthorityClient,
  evaluateAuthorityGate,
  buildAuthorityTrustProfileBundle,
  loadAuthorityConfig,
  readAuthorityMdConfig,
  resolveAuthorityClientAuth,
  resolveAuthorityCustomerApiKey,
  resolveAuthorityGateEvaluator,
  resolveAuthorityVerdictBacking,
  runAuthorityGateWiring,
  authorityJobVerdictStatus,
  buildAuthorityJobCreateEnvelopeFromPlan,
  submitAuthorityJobFromPlan,
  listAuthorityHostVerdicts,
  submitAuthorityHostVerdict,
  type AuthorityFetch,
  type AuthorityGateVerifyConfig,
  joinURL,
} from '../core/authority-client.js';
import { writeAuthorityTrustProfileBundle } from '../handlers/lattice-cli.js';
import { submitVerdict, summarizeVerdicts } from '../core/verdicts.js';
import {
  AUTHORITY_MODES,
  DEFAULT_AUTHORITY_TIMEOUT_MS,
  DEFAULT_AUTHORITY_URL,
  authorityTrustProfileFileNames,
  authorityModeEnabled,
  loadAuthoritySettings,
  normalizeAuthorityTrustEnv,
  normalizeAuthorityMode,
  normalizeAuthorityTimeout,
  normalizeAuthorityURL,
  parseAuthorityMd,
  parseAuthorityTrustEnv,
  quoteAuthorityShellValue,
  resolveAuthorityConfig,
} from '../core/authority-mode.js';
import {
  type AuthorityVerdictClaim,
  buildAuthorityEvidenceBatchSubmission,
  buildAuthorityEvidenceSubmission,
  buildAuthorityRunEventsEnvelope,
  buildFinalHostReviewPromptDigestInput,
  buildGateEvaluateRequest,
  computeGateInputDigest,
  FINAL_HOST_REVIEW_PROMPT_PROFILE,
  isAuthorityBatchFullyAccepted,
  type EvidenceEnvelopeContract,
} from '../core/authority-contracts.js';
import { canonicalDigest, generateEd25519KeyPair, signCanonical, stripSignature } from '../core/authority-signing.js';
import { verifyLatticeAuthorityReceipt } from '../core/lattice-authority-native.js';
import { buildGateEvidenceRefResolver } from '../core/evidence-uploader.js';
import { executePlannedSteps, type AuthorityGateOutcome } from '../core/planned-steps-executor.js';
import type { JobPlan, PlannedStep, PlannerStoreLike } from '../core/planner.js';
import type { StoryInfo } from '../core/types.js';

const GATE_ACTOR_KEYPAIR = generateEd25519KeyPair();
const VERDICT_ACTOR_KEYPAIR = generateEd25519KeyPair();
const TEST_AUTH = { customerApiKey: 'test-customer-key' };

function testAuthorityClient(
  baseURL: string,
  fetchImpl: AuthorityFetch,
  timeoutMS = DEFAULT_AUTHORITY_TIMEOUT_MS,
  auth = TEST_AUTH,
): AuthorityClient {
  return new AuthorityClient(baseURL, fetchImpl, timeoutMS, auth);
}

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

function generateAuthorityBundle(
  sourceRoot: string,
  bundleRoot: string,
  tier: 'basic' | 'senior' = 'basic',
): {
  sourceConfig: ReturnType<typeof loadAuthorityConfig>;
  sourceCustomer: ReturnType<typeof resolveAuthorityCustomerApiKey>;
  bundle: ReturnType<typeof buildAuthorityTrustProfileBundle>;
  written: ReturnType<typeof writeAuthorityTrustProfileBundle>;
} {
  const sourceTrustPath = join(sourceRoot, 'authority_trust.env');
  const sourceEnv: Record<string, string | undefined> = {
    LATTICE_AUTHORITY_MODE: 'off',
    LATTICE_AUTHORITY_TRUST_ENV_FILE: sourceTrustPath,
  };
  const sourceConfig = loadAuthorityConfig(
    sourceEnv,
    { authorityMode: 'enforce' },
    { cwd: sourceRoot },
  );
  const sourceCustomer = resolveAuthorityCustomerApiKey(sourceEnv, {
    cwd: sourceRoot,
  });
  const bundle = buildAuthorityTrustProfileBundle({
    env: sourceEnv,
    cwd: sourceRoot,
    outputDir: bundleRoot,
    tier,
  });
  const written = writeAuthorityTrustProfileBundle(bundleRoot, bundle);
  return { sourceConfig, sourceCustomer, bundle, written };
}

function assertAuthorityBundleRoundTrip(tier: 'basic' | 'senior'): void {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'authority-bundle-source-'));
  const bundleRoot = mkdtempSync(join(tmpdir(), 'authority-bundle-target-'));
  const consumerRoot = mkdtempSync(join(tmpdir(), 'authority-bundle-consumer-'));
  try {
    mkdirSync(join(sourceRoot, '.lattice'), { recursive: true });
    writeFileSync(
      join(sourceRoot, 'authority_trust.env'),
      [
        'LATTICE_AUTHORITY_LIVE_URL=https://authority.example/',
        'LATTICE_AUTHORITY_LIVE_PUBLIC_KEY=source-server-public-key',
        'LATTICE_AUTHORITY_SERVER_KEY_ID=source-server-key-id',
        'LATTICE_AUTHORITY_PROJECT_ID=source-project-id',
      ].join('\n'),
    );
    writeFileSync(join(sourceRoot, '.lattice', 'authority.md'), 'customerApiKey: source-customer-key\n');

    const generated = generateAuthorityBundle(sourceRoot, bundleRoot, tier);
    const expectedNames = authorityTrustProfileFileNames(tier);
    assert.deepEqual(
      {
        urlSource: generated.sourceConfig.urlSource,
        trustLoaded: generated.sourceConfig.authorityTrustEnvLoaded,
        mdLoaded: generated.sourceConfig.authorityMdLoaded,
        projectId: generated.sourceConfig.projectId,
        serverPublicKey: generated.sourceConfig.keyMaterial.serverPublicKey,
        serverKeyId: generated.sourceConfig.keyMaterial.serverKeyId,
        customerSource: generated.sourceCustomer.source,
        customerValue: generated.sourceCustomer.value,
      },
      {
        urlSource: 'authority_trust_env',
        trustLoaded: true,
        mdLoaded: true,
        projectId: 'source-project-id',
        serverPublicKey: 'source-server-public-key',
        serverKeyId: 'source-server-key-id',
        customerSource: 'authority_md',
        customerValue: 'source-customer-key',
      },
    );

    const trustFilePath = join(bundleRoot, expectedNames.trustFileName);
    const clientFilePath = join(bundleRoot, expectedNames.clientFileName);
    assert.equal(generated.bundle.trustFileName, expectedNames.trustFileName);
    assert.equal(generated.bundle.clientFileName, expectedNames.clientFileName);
    assert.equal(generated.written.trustFilePath, trustFilePath);
    assert.equal(generated.written.clientFilePath, clientFilePath);
    assert.equal(
      readFileSync(trustFilePath, 'utf8').trim(),
      [
        `export LATTICE_AUTHORITY_TRUST_ENV_FILE=${quoteAuthorityShellValue(trustFilePath)}`,
        `export LATTICE_AUTHORITY_MODE=${quoteAuthorityShellValue('enforce')}`,
        `export LATTICE_AUTHORITY_URL=${quoteAuthorityShellValue('https://authority.example/')}`,
        `export LATTICE_AUTHORITY_SERVER_PUBLIC_KEY=${quoteAuthorityShellValue('source-server-public-key')}`,
        `export LATTICE_AUTHORITY_SERVER_KEY_ID=${quoteAuthorityShellValue('source-server-key-id')}`,
        `export LATTICE_AUTHORITY_PROJECT_ID=${quoteAuthorityShellValue('source-project-id')}`,
        `export LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH=${quoteAuthorityShellValue(clientFilePath)}`,
      ].join('\n'),
    );
    assert.equal(readFileSync(clientFilePath, 'utf8').trim(), 'source-customer-key');

    const loaded = loadAuthorityConfig(
      {
        LATTICE_AUTHORITY_MODE: 'enforce',
        LATTICE_AUTHORITY_TRUST_ENV_FILE: trustFilePath,
      },
      {},
      { cwd: consumerRoot },
    );
    assert.equal(loaded.authorityTrustEnvLoaded, true);
    assert.equal(loaded.authorityMdLoaded, false);
    assert.equal(loaded.baseURL, 'https://authority.example/');
    assert.equal(loaded.urlSource, 'authority_trust_env');
    assert.equal(loaded.projectId, 'source-project-id');
    assert.equal(loaded.keyMaterial.serverPublicKey, 'source-server-public-key');
    assert.equal(loaded.keyMaterial.serverKeyId, 'source-server-key-id');

    const resolved = resolveAuthorityCustomerApiKey(
      {
        LATTICE_AUTHORITY_MODE: 'enforce',
        LATTICE_AUTHORITY_TRUST_ENV_FILE: trustFilePath,
      },
      { cwd: consumerRoot },
    );
    assert.equal(resolved.source, 'authority_trust_env');
    assert.equal(resolved.value, 'source-customer-key');
    assert.equal(resolved.path, clientFilePath);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(bundleRoot, { recursive: true, force: true });
    rmSync(consumerRoot, { recursive: true, force: true });
  }
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
  const client = testAuthorityClient('https://a.test', fetchReturning(200, JSON.stringify({ accepted: true, evidenceId: 'EV-1' })));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'success');
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
  assert.equal(out.data?.accepted, true);
  assert.equal(out.data?.evidenceId, 'EV-1');
}

// Mutating POSTs without a customer API key fail closed before any network call.
{
  let invoked = 0;
  const client = new AuthorityClient('https://a.test', async () => {
    invoked += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ accepted: true }) };
  });
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'error');
  assert.equal(out.ok, false);
  assert.match(out.message ?? '', /customer_api_key_unconfigured_fails_closed/);
  assert.equal(invoked, 0, 'missing customer key performs zero mutating POST calls');
}

// success with empty body parses to {}
{
  const client = testAuthorityClient('https://a.test', fetchReturning(204, ''));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'success');
  assert.deepEqual(out.data, {});
}

// --- client outcome taxonomy: http_error (4xx + 5xx) --------------------------
for (const status of [400, 409, 422, 500, 503]) {
  const client = testAuthorityClient('https://a.test', fetchReturning(status, 'rejected'));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'http_error', `status ${status} should be http_error`);
  assert.equal(out.ok, false);
  assert.equal(out.status, status);
  assert.ok(out.message?.includes(String(status)));
}

// --- client outcome taxonomy: timeout -----------------------------------------
{
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const client = testAuthorityClient('https://a.test', fetchThrowing(abortErr));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'timeout');
  assert.equal(out.ok, false);
  assert.ok(out.message?.includes('timed out'));
}
{
  const abortErr = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
  const client = testAuthorityClient('https://a.test', fetchThrowing(abortErr));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'timeout');
}

// --- client outcome taxonomy: connection_refused ------------------------------
for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET']) {
  const err = Object.assign(new Error('boom'), { code });
  const client = testAuthorityClient('https://a.test', fetchThrowing(err));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'connection_refused', `${code} should be connection_refused`);
  assert.equal(out.ok, false);
}
// connection error nested in cause (node fetch wrapping)
{
  const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const client = testAuthorityClient('https://a.test', fetchThrowing(err));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'connection_refused');
}

// --- client outcome taxonomy: generic error (e.g. JSON parse) -----------------
{
  const client = testAuthorityClient('https://a.test', fetchReturning(200, 'not-json{'));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'error');
  assert.equal(out.ok, false);
}
{
  const client = testAuthorityClient('https://a.test', fetchThrowing(new TypeError('weird')));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'error');
}

// --- F-001: 2xx but malformed body fails the submission-result schema ----------
// A parseable-but-wrong-shape body must NOT be reported as success; it maps to
// `error` (ok:false) so enforce gates the write and shadow degrades to a warning.
{
  // Missing the required `accepted` boolean.
  const client = testAuthorityClient('https://a.test', fetchReturning(200, JSON.stringify({ evidenceId: 'EV-1' })));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'error', 'single: malformed 2xx body -> error');
  assert.equal(out.ok, false);
  assert.equal(out.status, 200);
  assert.ok(out.message?.includes('schema validation'), 'single: schema-validation message');
}
{
  // `accepted` present but wrong type.
  const client = testAuthorityClient('https://a.test', fetchReturning(200, JSON.stringify({ accepted: 'yes' })));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'error', 'single: wrong-typed accepted -> error');
  assert.equal(out.ok, false);
}
{
  // A valid {accepted:false} body is still a SUCCESS outcome (schema passes); the
  // mode logic — not the client — decides rejection from the accepted flag.
  const client = testAuthorityClient('https://a.test', fetchReturning(200, JSON.stringify({ accepted: false, reason: 'no' })));
  const out = await client.submitEvidence(envelope());
  assert.equal(out.kind, 'success', 'single: valid {accepted:false} stays success at client level');
  assert.equal(out.data?.accepted, false);
}
{
  // Batch: malformed entry result (accepted not a boolean) -> error.
  const client = testAuthorityClient(
    'https://a.test',
    fetchReturning(200, JSON.stringify({ accepted: true, results: [{ accepted: 'maybe' }] })),
  );
  const out = await client.submitEvidenceBatch([envelope('EV-a')]);
  assert.equal(out.kind, 'error', 'batch: malformed entry result -> error');
  assert.equal(out.ok, false);
}

// --- customer API key: POST carries Authorization, GET policy stays keyless ---
{
  let postHeaders: Record<string, string> | undefined;
  let getHeaders: Record<string, string> | undefined;
  const { serverPublicKeyHex } = signedGateReceipt();
  const policyBody = {
    contractVersion: 'authority-policy.v1',
    purpose: 'discovery',
    requiredAuthorityMode: 'enforce',
    productionEnforceAuthority: true,
    requireHandshake: false,
    commandCatalogDigest: 'ccd',
    evidenceSchemaDigest: 'esd',
    supportedAuthorityModes: ['off', 'shadow', 'enforce'],
    minClientVersions: {},
    requiredEvidenceFields: [],
    evidencePolicy: { preset: 'default' },
    serverKey: { keyId: 'server-key-1', algorithm: 'ed25519', encoding: 'hex', publicKeyHex: serverPublicKeyHex },
    compatibility: {
      supportedAuthorityModes: ['off', 'shadow', 'enforce'],
      requiredAuthorityMode: 'enforce',
      requireHandshake: false,
      minClientVersions: {},
      commandCatalogDigest: 'ccd',
      evidenceSchemaDigest: 'esd',
      productionEnforceAuthority: true,
      requireActorKeyBinding: false,
      requireRunnerHeartbeatForL2: false,
    },
  };
  const fetchImpl: AuthorityFetch = async (_input, init) => {
    if (init.method === 'GET') {
      getHeaders = init.headers;
      return { ok: true, status: 200, text: async () => JSON.stringify(policyBody) };
    }
    postHeaders = init.headers;
    return { ok: true, status: 200, text: async () => JSON.stringify({ accepted: true, evidenceId: 'EV-auth' }) };
  };
  const client = testAuthorityClient(
    'https://a.test',
    fetchImpl,
    DEFAULT_AUTHORITY_TIMEOUT_MS,
    { customerApiKey: 'customer-key-canary' },
  );
  const policy = await client.discoverPolicy();
  assert.equal(policy.kind, 'success');
  assert.equal(getHeaders?.Authorization, undefined, 'policy discovery GET must not send the customer API key');
  const posted = await client.submitEvidence(envelope('EV-auth'));
  assert.equal(posted.kind, 'success');
  assert.equal(postHeaders?.Authorization, 'Bearer customer-key-canary', 'mutating POST must send the customer API key');
}

// --- batch submission outcomes ------------------------------------------------
{
  const client = testAuthorityClient(
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
  const client = testAuthorityClient(
    'https://a.test',
    fetchReturning(200, JSON.stringify({ accepted: true, results: [{ accepted: true }, { accepted: false, reason: 'dup' }] })),
  );
  const out = await client.submitEvidenceBatch([envelope('EV-a'), envelope('EV-b')]);
  assert.equal(out.kind, 'success');
  assert.equal(isAuthorityBatchFullyAccepted(out.data!), false);
}
{
  const client = testAuthorityClient('https://a.test', fetchReturning(500, 'down'));
  const out = await client.submitEvidenceBatch([envelope('EV-a')]);
  assert.equal(out.kind, 'http_error');
}

// ===========================================================================
// Authority gate evaluation + native receipt verification (B6 / B15) — fake server
//
// Proves the evidence/gate loop end to end against an injected fetch:
//   evaluateGate -> (fetchReceipt) -> verifyLatticeAuthorityReceipt
// and the executor gate.evaluate wiring (pass on verified approve, fail closed on
// reject / tampered / missing decisionDigest, and when NO authority config is given).
// The CLI never mints a receipt: receiptVerified is true ONLY for a server receipt
// that the native verifier accepts.
// ===========================================================================

type NativeGateReceipt = {
  receiptId: string;
  kind: string;
  projectId: string;
  storyId: string;
  actorId: string;
  role: string;
  stateVersion: number;
  policyVersion: string;
  inputDigest: string;
  decisionDigest?: string;
  issuedAt: string;
  serverKeyId: string;
  signature?: string;
};

const gateRequest = buildGateEvaluateRequest({
  projectId: 'project-1',
  storyId: 'B-auth',
  targetPhase: 'DONE',
  until: 'DONE',
  evidenceRefs: ['B-auth:step-fake', 'B-auth:step-validate'],
});

function signedGateReceipt(
  overrides: Partial<NativeGateReceipt> = {},
  keypair = generateEd25519KeyPair(),
): { receipt: NativeGateReceipt; serverPublicKeyHex: string } {
  const base: NativeGateReceipt = {
    receiptId: 'rcpt-gate-smoke-1',
    kind: 'gate_decision',
    projectId: 'project-1',
    storyId: 'B-auth',
    actorId: 'lattice-authority-server',
    role: 'server',
    stateVersion: 1,
    policyVersion: 'policy-v1',
    inputDigest: 'input-digest-1',
    decisionDigest: 'decision-digest-1',
    issuedAt: new Date().toISOString(),
    serverKeyId: 'server-key-1',
    ...overrides,
  };
  const signature = Buffer.from(signCanonical(stripSignature(base), keypair.privateKey), 'base64').toString('hex');
  return { receipt: { ...base, signature }, serverPublicKeyHex: Buffer.from(keypair.publicKey, 'base64').toString('hex') };
}

function gateInputDigestFromEvaluateBody(body: any): string {
  return typeof body?.gateInputDigest === 'string'
    ? body.gateInputDigest
    : typeof body?.decision?.decisionId === 'string'
      ? body.decision.decisionId
      : '';
}

function pythonGateDecisionInputDigestFromEvaluateBody(body: any): string {
  const decision = body?.decision;
  if (!decision || typeof decision !== 'object') return gateInputDigestFromEvaluateBody(body);
  const input = { ...decision };
  if (input.repo && typeof input.repo === 'object') {
    input.repo = {
      headHash: input.repo.headHash,
      materialHash: input.repo.materialHash,
      baseHash: input.repo.baseHash ?? null,
      treeHash: input.repo.treeHash ?? null,
      diffHash: input.repo.diffHash ?? null,
      manifestHash: input.repo.manifestHash ?? null,
      dirty: input.repo.dirty ?? false,
    };
  }
  return digestPreservingNull(input);
}

function digestPreservingNull(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item === undefined) return undefined;
    if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') return item;
    if (Array.isArray(item)) return item.map(normalize).filter(entry => entry !== undefined);
    if (typeof item === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        const normalized = normalize(raw);
        if (normalized !== undefined) out[key] = normalized;
      }
      return out;
    }
    return String(item);
  };
  return createHash('sha256').update(JSON.stringify(normalize(value)), 'utf8').digest('hex');
}

function dynamicApproveForGateRequest(keypair = generateEd25519KeyPair()): {
  serverPublicKeyHex: string;
  evaluate: { status: number; body: (requestBody: any) => unknown };
} {
  const serverPublicKeyHex = Buffer.from(keypair.publicKey, 'base64').toString('hex');
  return {
    serverPublicKeyHex,
    evaluate: {
      status: 200,
      body: (requestBody: any) => {
        const { receipt } = signedGateReceipt({ inputDigest: pythonGateDecisionInputDigestFromEvaluateBody(requestBody) }, keypair);
        return { decision: 'approve', decisionDigest: receipt.decisionDigest, receipt };
      },
    },
  };
}

// A fetch that routes by path: POST /v1/gates/evaluate and GET /v1/receipts/{id}.
function gateRouterFetch(opts: {
  evaluate: { status: number; body: unknown };
  receipt?: { status: number; body: unknown };
  counts?: { evaluate: number; receipt: number };
}): AuthorityFetch {
  return async (input, init) => {
    const url = String(input);
    if (url.includes('/v1/gates/evaluate') && init.method === 'POST') {
      if (opts.counts) opts.counts.evaluate += 1;
      return { ok: opts.evaluate.status >= 200 && opts.evaluate.status < 300, status: opts.evaluate.status, text: async () => JSON.stringify(opts.evaluate.body) };
    }
    if (url.includes('/v1/receipts/') && init.method === 'GET') {
      if (opts.counts) opts.counts.receipt += 1;
      const r = opts.receipt ?? { status: 404, body: {} };
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
    }
    throw Object.assign(new Error(`unexpected fetch ${init.method} ${url}`), { code: 'EUNEXPECTED' });
  };
}

function authorityJobPlanGateInputDigest(plan = authorityJobPlan()): string {
  return authorityJobPlanGateRequest(plan).gateInputDigest;
}

function authorityJobPlanGateRequest(plan = authorityJobPlan()): Record<string, unknown> & { gateInputDigest: string } {
  const priorStepEvidenceRefs = plan.plannedSteps
    .filter(step => step.type !== 'gate.evaluate' && step.type !== 'stop.summary')
    .map(step => step.evidenceBinding);
  const base = {
    projectId: plan.jobCreateRequestEnvelope?.projectId ?? plan.jobCreateRequest?.projectId ?? 'local-project',
    storyId: plan.storyId,
    targetPhase: plan.until,
    until: plan.until,
    plannerRunId: plan.plannerRunId,
    ...(plan.jobCreateRequest ? { jobId: plan.jobPlanDigest } : {}),
    plannedStepsDigest: plan.localRunPlan?.plannedStepsDigest
      ?? plan.jobCreateRequestEnvelope?.plannedStepsDigest
      ?? createHash('sha256').update(JSON.stringify(plan.plannedSteps), 'utf8').digest('hex'),
    evidenceRefs: priorStepEvidenceRefs,
  };
  return {
    ...base,
    gateInputDigest: computeGateInputDigest(base),
  };
}

function verifyConfig(serverPublicKeyHex: string, expectedDecisionDigest?: string): AuthorityGateVerifyConfig {
  return {
    serverPublicKey: serverPublicKeyHex,
    serverPublicKeyEncoding: 'hex',
    expectedProjectId: 'project-1',
    expectedStoryId: 'B-auth',
    expectedServerKeyId: 'server-key-1',
    expectedDecisionDigest,
    maxAgeMs: 600_000,
  };
}

// --- run-events client method (POST /v1/runs/{runId}/events) -------------------
{
  let path = '';
  let body: any;
  const fetchImpl: AuthorityFetch = async (input, init) => {
    path = String(input);
    body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return { ok: true, status: 200, text: async () => '' };
  };
  const client = testAuthorityClient('https://a.test', fetchImpl);
  const env = buildAuthorityRunEventsEnvelope({ actorId: 'a', nonce: 'n', createdAt: '2026-06-06T00:00:00Z' }, 'run-1', [
    { eventId: 'e1', kind: 'command', occurredAt: '2026-06-06T00:00:00Z', payload: { argvDigest: 'd' } },
  ]);
  const out = await client.appendRunEvents('run-1', env);
  assert.equal(out.kind, 'success', 'appendRunEvents success on empty 2xx');
  assert.ok(path.endsWith('/v1/runs/run-1/events'), 'appendRunEvents hits /v1/runs/{id}/events');
  assert.equal(body.createdAt, undefined, 'Python run-events envelope has no createdAt alias');
  assert.equal(body.events, undefined, 'Python run-events envelope has no events[] alias');
  assert.equal(body.event.type, 'lattice.command');
}

// --- fetchReceipt: receipt body carrying receiptId is NOT an overclaim rejection -
{
  const { receipt } = signedGateReceipt();
  const client = testAuthorityClient('https://a.test', fetchReturning(200, JSON.stringify(receipt)));
  const out = await client.fetchReceipt(receipt.receiptId);
  assert.equal(out.kind, 'success', 'fetchReceipt returns the raw receipt (no overclaim guard)');
  assert.equal((out.data as { receiptId?: string }).receiptId, receipt.receiptId);
}

// --- APPROVE: verified native gate_decision receipt (inline) -> receiptVerified ---
{
  const { receipt, serverPublicKeyHex } = signedGateReceipt({ inputDigest: authorityJobPlanGateInputDigest() });
  const client = testAuthorityClient('https://a.test', gateRouterFetch({
    evaluate: { status: 200, body: { decision: 'approve', decisionDigest: receipt.decisionDigest, receipt } },
  }));
  const decision = await evaluateAuthorityGate(client, authorityJobPlanGateRequest(), verifyConfig(serverPublicKeyHex, receipt.decisionDigest));
  assert.equal(decision.status, 'verified', 'approve + valid receipt -> verified');
  assert.equal(decision.receiptVerified, true);
  assert.equal(decision.decision, 'approve');
  assert.equal(decision.decisionDigest, receipt.decisionDigest);
  assert.equal(runExecutor(decisionToOutcome(decision)).status, 'done', 'executor completes on verified approve');
  const exec = runExecutor(decisionToOutcome(decision));
  assert.equal(exec.receiptVerified, true, 'executor surfaces verified receipt');
  assert.equal(exec.authorityDone, true, 'per-run authorityDone projected only on verified receipt');
  assert.equal(exec.fullAuthorityDone, false, 'executor never claims fullAuthorityDone (multi-host owned elsewhere)');
  assert.equal(exec.multiHostVerified, false);
}

// --- APPROVE via receiptId (fetch path) -> verified, fetch counted ----------------
{
  const { receipt, serverPublicKeyHex } = signedGateReceipt({ receiptId: 'rcpt-by-id', inputDigest: gateRequest.gateInputDigest });
  const counts = { evaluate: 0, receipt: 0 };
  const client = testAuthorityClient('https://a.test', gateRouterFetch({
    evaluate: { status: 200, body: { decision: 'approve', decisionDigest: receipt.decisionDigest, receiptId: 'rcpt-by-id' } },
    receipt: { status: 200, body: receipt },
    counts,
  }));
  const decision = await evaluateAuthorityGate(client, gateRequest, verifyConfig(serverPublicKeyHex, receipt.decisionDigest));
  assert.equal(decision.status, 'verified', 'approve + receiptId fetch -> verified');
  assert.equal(counts.evaluate, 1, 'one evaluate call');
  assert.equal(counts.receipt, 1, 'receipt fetched when only an id is returned');
  assert.equal(decision.receiptId, 'rcpt-by-id');
}

// --- APPROVE with receipt bound to a different gate input -> fail closed ----------
{
  const { receipt, serverPublicKeyHex } = signedGateReceipt({ inputDigest: 'sha256:other-gate-input' });
  const client = testAuthorityClient('https://a.test', gateRouterFetch({
    evaluate: { status: 200, body: { decision: 'approve', decisionDigest: receipt.decisionDigest, receipt } },
  }));
  const decision = await evaluateAuthorityGate(client, gateRequest, verifyConfig(serverPublicKeyHex, receipt.decisionDigest));
  assert.equal(decision.status, 'receipt_unverified', 'valid receipt for a different gate input is not accepted');
  assert.equal(decision.receiptVerified, false);
  assert.match(decision.reason ?? '', /inputDigest expected/, 'mismatch reason names the bound gate input');
  const exec = runExecutor(decisionToOutcome(decision));
  assert.equal(exec.status, 'blocked', 'executor blocks when the gate receipt input binding is wrong');
  assert.equal(exec.stopReason, 'authority_gate_receipt_unverified');
  assert.equal(exec.authorityDone, false);
}

// --- evaluator overclaim: verified approve but wrong gate input -> fail closed -----
{
  const exec = runExecutor({
    receiptVerified: true,
    decision: 'approve',
    gateInputDigest: 'sha256:other-gate-input',
    receiptId: 'rcpt-wrong-input',
    decisionDigest: 'decision-digest-wrong-input',
    reason: 'overclaimed verified receipt for another gate input',
  });
  assert.equal(exec.status, 'blocked', 'executor refuses verified approve overclaims for a different gate input');
  assert.equal(exec.stopReason, 'authority_gate_receipt_input_digest_mismatch');
  assert.equal(exec.authorityDone, false);
}

// --- DENY: reject decision -> fail closed, never verified -------------------------
{
  const client = testAuthorityClient('https://a.test', gateRouterFetch({
    evaluate: { status: 200, body: { decision: 'reject', reason: 'validation evidence insufficient' } },
  }));
  const decision = await evaluateAuthorityGate(client, gateRequest, verifyConfig('00'.repeat(32)));
  assert.equal(decision.status, 'rejected', 'reject decision -> rejected');
  assert.equal(decision.receiptVerified, false, 'reject never mints receiptVerified');
  const exec = runExecutor(decisionToOutcome(decision));
  assert.equal(exec.status, 'blocked', 'executor blocks on reject');
  assert.equal(exec.stopReason, 'authority_gate_decision_rejected');
  assert.equal(exec.receiptVerified, false);
  assert.equal(exec.authorityDone, false);
}

// --- TAMPERED: approve but receipt fields mutated after signing -> unverified ------
{
  const { receipt, serverPublicKeyHex } = signedGateReceipt();
  const tampered = { ...receipt, decisionDigest: 'tampered-digest' }; // signature no longer matches
  const client = testAuthorityClient('https://a.test', gateRouterFetch({
    evaluate: { status: 200, body: { decision: 'approve', decisionDigest: 'tampered-digest', receipt: tampered } },
  }));
  const decision = await evaluateAuthorityGate(client, gateRequest, verifyConfig(serverPublicKeyHex, 'tampered-digest'));
  assert.equal(decision.status, 'receipt_unverified', 'tampered receipt -> receipt_unverified');
  assert.equal(decision.receiptVerified, false, 'tampered receipt is NEVER accepted');
  const exec = runExecutor(decisionToOutcome(decision));
  assert.equal(exec.status, 'blocked', 'executor blocks on tampered receipt');
  assert.equal(exec.stopReason, 'authority_gate_receipt_unverified');
  assert.equal(exec.receiptVerified, false);
  assert.equal(exec.authorityDone, false);
}

// --- MISSING decisionDigest: gate_decision receipt without decisionDigest -> fail --
{
  const { receipt, serverPublicKeyHex } = signedGateReceipt({ decisionDigest: undefined });
  const client = testAuthorityClient('https://a.test', gateRouterFetch({
    evaluate: { status: 200, body: { decision: 'approve', receipt } },
  }));
  const decision = await evaluateAuthorityGate(client, gateRequest, verifyConfig(serverPublicKeyHex));
  assert.equal(decision.status, 'receipt_unverified', 'missing decisionDigest -> receipt_unverified');
  assert.equal(decision.receiptVerified, false);
  assert.match(decision.reason, /decisionDigest/, 'reason names the missing decisionDigest');
  const exec = runExecutor(decisionToOutcome(decision));
  assert.equal(exec.status, 'blocked', 'executor blocks on missing decisionDigest');
  assert.equal(exec.receiptVerified, false);
}

// --- FUTURE-DATED: approve receipt issued beyond the clock-skew window -> unverified
// Freshness is a fail-closed binding (native verifier lattice-authority-native.ts):
// a receipt whose issuedAt is further in the future than clockSkewMs is rejected with a
// future-dated reason even when the signature and all bindings are otherwise valid. The
// clock is injected (now) so the assertion is deterministic, not wall-clock dependent.
{
  const FIXED_NOW = new Date('2026-06-06T00:00:00.000Z');
  const { receipt, serverPublicKeyHex } = signedGateReceipt({ issuedAt: '2030-01-01T00:00:00.000Z' });
  const client = testAuthorityClient('https://a.test', gateRouterFetch({
    evaluate: { status: 200, body: { decision: 'approve', decisionDigest: receipt.decisionDigest, receipt } },
  }));
  const decision = await evaluateAuthorityGate(client, gateRequest, {
    ...verifyConfig(serverPublicKeyHex, receipt.decisionDigest),
    now: FIXED_NOW,
    clockSkewMs: 300_000,
  });
  assert.equal(decision.status, 'receipt_unverified', 'future-dated receipt -> receipt_unverified');
  assert.equal(decision.receiptVerified, false, 'a future-dated receipt is NEVER accepted (clock-skew fail-closed)');
  assert.match(decision.reason, /future-dated/, 'reason names the future-dated freshness failure');
  const exec = runExecutor(decisionToOutcome(decision));
  assert.equal(exec.status, 'blocked', 'executor blocks on a future-dated receipt');
  assert.equal(exec.stopReason, 'authority_gate_receipt_unverified');
  assert.equal(exec.authorityDone, false);
  assert.equal(exec.receiptVerified, false);
}

// --- STALE: approve receipt older than maxAge + skew -> unverified (freshness pair) --
// The future-dated case's mirror: a valid-signature receipt issued far enough in the
// PAST (beyond maxAgeMs + clockSkewMs) fails closed with a stale reason. Together these
// pin both edges of the freshness window the enforce-mode default (600000/300000) opens.
{
  const FIXED_NOW = new Date('2026-06-06T00:00:00.000Z');
  const { receipt, serverPublicKeyHex } = signedGateReceipt({ issuedAt: '2026-06-05T00:00:00.000Z' });
  const client = testAuthorityClient('https://a.test', gateRouterFetch({
    evaluate: { status: 200, body: { decision: 'approve', decisionDigest: receipt.decisionDigest, receipt } },
  }));
  const decision = await evaluateAuthorityGate(client, gateRequest, {
    ...verifyConfig(serverPublicKeyHex, receipt.decisionDigest),
    now: FIXED_NOW,
    maxAgeMs: 600_000,
    clockSkewMs: 300_000,
  });
  assert.equal(decision.status, 'receipt_unverified', 'stale receipt -> receipt_unverified');
  assert.equal(decision.receiptVerified, false, 'a stale receipt is NEVER accepted');
  assert.match(decision.reason, /stale/, 'reason names the stale freshness failure');
  const exec = runExecutor(decisionToOutcome(decision));
  assert.equal(exec.status, 'blocked', 'executor blocks on a stale receipt');
  assert.equal(exec.stopReason, 'authority_gate_receipt_unverified');
  assert.equal(exec.authorityDone, false);
}

// --- FAIL CLOSED: no authority config supplied -> executor blocks at the gate ------
{
  const exec = executePlannedSteps({ root: '/tmp/x', store: fakeStore(), jobPlan: authorityJobPlan(), now: () => new Date('2026-06-06T00:00:00Z') });
  assert.equal(exec.status, 'blocked', 'no authorityGate -> fail closed');
  assert.equal(exec.stopReason, 'authority_gate_decision_receipt_required');
  assert.equal(exec.receiptVerified, false);
  assert.equal(exec.authorityDone, false);
}

// ===========================================================================
// Planner/executor production wiring (resolveAuthorityGateEvaluator) — B6 / B7
//
// Proves the missing wiring: an authority/DONE job appends run + evidence events,
// requests the gate, verifies the native receipt, and hands the executor a
// synchronous evaluator that only yields authorityDone on a verified approve.
// It must FAIL CLOSED (no evaluator, no DONE) when authority mode/url/server-key
// are unconfigured, and must stay byte-quiet (zero network) for local jobs.
// ===========================================================================

function wiringRouterFetch(opts: {
  evaluate?: { status: number; body: unknown | ((requestBody: any) => unknown) };
  events?: { status: number; body: unknown };
  evidence?: { status: number; body: unknown };
  receipt?: { status: number; body: unknown };
  policy?: { status: number; body: unknown };
  counts?: { events: number; evidence: number; evaluate: number; receipt: number; policy: number };
  capture?: { evidenceBatchBody?: string; eventPaths?: string[]; eventBodies?: string[]; gateEvaluateBody?: string };
}): AuthorityFetch {
  const ok = (s: number) => s >= 200 && s < 300;
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith('/events') && init.method === 'POST') {
      if (opts.counts) opts.counts.events += 1;
      if (opts.capture) {
        (opts.capture.eventPaths ??= []).push(url);
        (opts.capture.eventBodies ??= []).push(init.body ?? '');
      }
      const e = opts.events ?? { status: 200, body: {} };
      return { ok: ok(e.status), status: e.status, text: async () => JSON.stringify(e.body) };
    }
    if (url.includes('/v1/evidence/batch') && init.method === 'POST') {
      if (opts.counts) opts.counts.evidence += 1;
      if (opts.capture) opts.capture.evidenceBatchBody = init.body;
      const e = opts.evidence ?? { status: 200, body: { accepted: true, results: [{ accepted: true }] } };
      return { ok: ok(e.status), status: e.status, text: async () => JSON.stringify(e.body) };
    }
    if (url.includes('/v1/gates/evaluate') && init.method === 'POST') {
      if (opts.counts) opts.counts.evaluate += 1;
      if (opts.capture) opts.capture.gateEvaluateBody = init.body;
      const e = opts.evaluate ?? { status: 500, body: {} };
      const requestBody = init.body ? JSON.parse(String(init.body)) : {};
      const body = typeof e.body === 'function' ? e.body(requestBody) : e.body;
      return { ok: ok(e.status), status: e.status, text: async () => JSON.stringify(body) };
    }
    if (url.includes('/v1/receipts/') && init.method === 'GET') {
      if (opts.counts) opts.counts.receipt += 1;
      const r = opts.receipt ?? { status: 404, body: {} };
      return { ok: ok(r.status), status: r.status, text: async () => JSON.stringify(r.body) };
    }
    if (url.includes('/v1/authority/policy') && init.method === 'GET') {
      if (opts.counts) opts.counts.policy += 1;
      const p = opts.policy ?? { status: 404, body: {} };
      return { ok: ok(p.status), status: p.status, text: async () => JSON.stringify(p.body) };
    }
    throw Object.assign(new Error(`unexpected fetch ${init.method} ${url}`), { code: 'EUNEXPECTED' });
  };
}

const noNetworkFetch: AuthorityFetch = async (input, init) => {
  throw Object.assign(new Error(`network must not be called: ${init.method} ${String(input)}`), { code: 'ENONET' });
};

function authorityEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    LATTICE_AUTHORITY_MODE: 'enforce',
    LATTICE_AUTHORITY_URL: 'https://authority.test',
    LATTICE_AUTHORITY_CUSTOMER_API_KEY: 'customer-key-canary',
    LATTICE_AUTHORITY_SERVER_KEY_ID: 'server-key-1',
    LATTICE_AUTHORITY_ACTOR_ID: 'main-1',
    LATTICE_AUTHORITY_ACTOR_ROLE: 'main',
    LATTICE_AUTHORITY_ACTOR_KEY: GATE_ACTOR_KEYPAIR.privateKey,
    LATTICE_AUTHORITY_ACTOR_KEY_ENCODING: 'base64',
    LATTICE_AUTHORITY_TRUST_ENV_FILE: '.missing-authority-trust.env',
    ...extra,
  };
}

// --- local / non-DONE job: zero settings load, zero network, no evaluator ---------
{
  const localPlan = { ...authorityJobPlan(), mode: 'local' as const };
  const resolution = await resolveAuthorityGateEvaluator(localPlan, { env: authorityEnv(), fetchImpl: noNetworkFetch });
  assert.equal(resolution.configured, false, 'local job never runs an authority gate round-trip');
  assert.equal(resolution.evaluator, undefined, 'local job hands the executor no authority evaluator');
  assert.equal(resolution.reason, 'non_authority_or_non_done_job');
}

// --- authority DONE but mode off in env: fail closed, no evaluator, no network -----
{
  const resolution = await resolveAuthorityGateEvaluator(authorityJobPlan(), {
    env: { LATTICE_AUTHORITY_URL: 'https://authority.test' }, // mode unset -> off
    fetchImpl: noNetworkFetch,
  });
  assert.equal(resolution.configured, false);
  assert.equal(resolution.evaluator, undefined, 'mode off must fail closed with no evaluator');
  assert.equal(resolution.reason, 'authority_mode_off_fails_closed');
}

// --- authority DONE, enforce, no server URL: localhost default is production-inert,
//     fail closed (must not silently fall back to localhost for production DONE) -----
{
  const resolution = await resolveAuthorityGateEvaluator(authorityJobPlan(), {
    env: { LATTICE_AUTHORITY_MODE: 'enforce' }, // no URL -> localhost default
    fetchImpl: noNetworkFetch,
    fileReader: () => undefined, // no .lattice/authority.md
  });
  assert.equal(resolution.configured, false);
  assert.equal(resolution.evaluator, undefined);
  assert.equal(
    resolution.reason,
    'authority_settings_production_inert_fails_closed:authority_url_localhost_default',
    'enforce + no URL gets the localhost default and is production-inert',
  );
}

// --- authority DONE, enforce + URL, but no pinned key and policy discovery fails ---
{
  const counts = { events: 0, evidence: 0, evaluate: 0, receipt: 0, policy: 0 };
  const resolution = await resolveAuthorityGateEvaluator(authorityJobPlan(), {
    env: authorityEnv({ LATTICE_AUTHORITY_SERVER_KEY_ID: undefined }),
    fetchImpl: wiringRouterFetch({ policy: { status: 404, body: {} }, counts }),
  });
  assert.equal(resolution.configured, false, 'no server key + failed discovery must fail closed');
  assert.equal(resolution.evaluator, undefined);
  assert.equal(resolution.reason, 'server_public_key_unavailable_fails_closed');
  assert.equal(counts.evaluate, 0, 'no gate evaluate without a verifiable server key');
}

// --- authority DONE, enforce + URL, but no customer key: fail closed before POSTs ---
{
  const { serverPublicKeyHex } = signedGateReceipt();
  const counts = { events: 0, evidence: 0, evaluate: 0, receipt: 0, policy: 0 };
  const resolution = await resolveAuthorityGateEvaluator(authorityJobPlan(), {
    env: authorityEnv({
      LATTICE_AUTHORITY_CUSTOMER_API_KEY: undefined,
      LATTICE_AUTHORITY_SERVER_PUBLIC_KEY: serverPublicKeyHex,
      LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_ENCODING: 'hex',
    }),
    fetchImpl: wiringRouterFetch({ counts }),
  });
  assert.equal(resolution.configured, false, 'missing customer API key must fail closed before mutating Authority calls');
  assert.equal(resolution.reason, 'customer_api_key_unconfigured_fails_closed');
  assert.equal(counts.events, 0, 'no run-events POST without customer API key');
  assert.equal(counts.evidence, 0, 'no evidence POST without customer API key');
  assert.equal(counts.evaluate, 0, 'no gate evaluate POST without customer API key');
}

// --- FULL PRODUCTION PATH: append run+evidence, evaluate, verify receipt -> DONE ----
{
  const approve = dynamicApproveForGateRequest();
  const counts = { events: 0, evidence: 0, evaluate: 0, receipt: 0, policy: 0 };
  const capture: { evidenceBatchBody?: string } = {};
  const resolution = await resolveAuthorityGateEvaluator(authorityJobPlan(), {
    env: authorityEnv({
      LATTICE_AUTHORITY_SERVER_PUBLIC_KEY: approve.serverPublicKeyHex,
      LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_ENCODING: 'hex',
      LATTICE_AUTHORITY_RUNNER_ID: 'runner-live-1',
      LATTICE_AUTHORITY_DEVICE_ID: 'device-live-1',
    }),
    fetchImpl: wiringRouterFetch({
      evaluate: approve.evaluate,
      counts,
      capture,
    }),
  });
  assert.equal(resolution.configured, true, 'fully configured authority job runs a live gate round-trip');
  assert.equal(resolution.decision?.status, 'verified', `decision should verify: ${JSON.stringify(resolution.decision)}`);
  assert.equal(resolution.runEventsAck, 'success', 'run events are appended when configured');
  assert.equal(resolution.evidenceAck, 'success', 'evidence is submitted when configured');
  assert.equal(counts.events, 3, 'Python run events are appended one single-event envelope per POST before the gate');
  assert.equal(counts.evidence, 1, 'exactly one evidence batch submission precedes the gate');
  assert.equal(counts.evaluate, 1, 'exactly one gate evaluate call');
  const evidenceBatch = JSON.parse(capture.evidenceBatchBody ?? '{}');
  assert.equal(evidenceBatch.evidences?.[0]?.runnerId, 'runner-live-1', 'live evidence binds to the configured runner id');
  assert.equal(evidenceBatch.evidences?.[0]?.deviceId, 'device-live-1', 'live evidence binds to the configured device id when present');
  assert.match(evidenceBatch.evidences?.[0]?.commandDigest, /^[0-9a-f]{64}$/, 'live evidence carries server-required commandDigest');
  assert.match(evidenceBatch.evidences?.[0]?.transcriptHash, /^[0-9a-f]{64}$/, 'live evidence carries server-required transcriptHash');
  assert(resolution.evaluator, 'a verified approve hands the executor an evaluator');
  // Drive the executor with the resolved evaluator: authority DONE only on the verified receipt.
  const jobPlan = authorityJobPlan();
  const exec = executePlannedSteps({
    root: '/tmp/x',
    store: fakeStore(),
    jobPlan,
    now: () => new Date('2026-06-06T00:00:00Z'),
    authorityGate: resolution.evaluator,
    gateEvidenceRefResolver: buildGateEvidenceRefResolver(jobPlan),
  });
  const gateStep = exec.steps.find(step => step.type === 'gate.evaluate');
  assert.equal(
    exec.status,
    'done',
    `executor completes on the verified approve; stopReason=${exec.stopReason ?? 'none'} gateSummary=${JSON.stringify(gateStep?.summary ?? {})}`,
  );
  assert.equal(exec.receiptVerified, true);
  assert.equal(exec.authorityDone, true, 'per-run authorityDone projected only on the verified native receipt');
  assert.equal(exec.fullAuthorityDone, false, 'executor never claims fullAuthorityDone (multi-host owned elsewhere)');
  assert.equal(exec.localDone, false, 'an authority job never claims local lifecycle DONE');
}

// --- claimed live job: server runId wins over ambient SESSION_ID for uploads ---
{
  const approve = dynamicApproveForGateRequest();
  const counts = { events: 0, evidence: 0, evaluate: 0, receipt: 0, policy: 0 };
  const capture: { evidenceBatchBody?: string; eventPaths?: string[]; eventBodies?: string[] } = {};
  const jobPlan = { ...authorityJobPlan(), authorityRunId: 'run-live-claimed-1' };
  const resolution = await resolveAuthorityGateEvaluator(jobPlan, {
    env: authorityEnv({
      LATTICE_AUTHORITY_SERVER_PUBLIC_KEY: approve.serverPublicKeyHex,
      LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_ENCODING: 'hex',
      LATTICE_AUTHORITY_SESSION_ID: 'session-ambient-should-not-win',
    }),
    fetchImpl: wiringRouterFetch({
      evaluate: approve.evaluate,
      counts,
      capture,
    }),
  });
  assert.equal(resolution.configured, true);
  assert.equal(resolution.decision?.status, 'verified');
  assert.ok((capture.eventPaths ?? []).every(path => path.includes('/v1/runs/run-live-claimed-1/events')), 'run events must bind the claimed Authority runId, not ambient SESSION_ID');
  const evidenceBatch = JSON.parse(capture.evidenceBatchBody ?? '{}');
  assert.equal(evidenceBatch.evidences?.[0]?.producerRunId, 'run-live-claimed-1', 'evidence must bind the claimed Authority runId');
}

// --- E4 bridge: submit a planner JobPlan as a signed server-backed job create ----
{
  const capture: { path?: string; body?: string; authorization?: string } = {};
  const fetchImpl: AuthorityFetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/v1/jobs') && init.method === 'POST') {
      capture.path = url;
      capture.body = init.body;
      capture.authorization = init.headers.Authorization;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          job: {
            jobId: 'job-live-1',
            runId: 'run-live-1',
            storyId: 'B-auth',
            spec: { jobId: 'job-live-1', runId: 'run-live-1', storyId: 'B-auth', plannedStepsDigest: 'server-psd-1' },
          },
          run: { runId: 'run-live-1' },
        }),
      };
    }
    throw Object.assign(new Error(`unexpected fetch ${init.method} ${url}`), { code: 'EUNEXPECTED' });
  };
  const blockedFakeProvider = await submitAuthorityJobFromPlan(authorityJobPlan(), {
    env: authorityEnv(),
    fetchImpl,
    cwd: '/repo',
  });
  assert.equal(blockedFakeProvider.ok, false, 'fake provider plans cannot be silently rewritten into server jobs');
  assert.match(blockedFakeProvider.reason ?? '', /explicit real provider/, 'blocked reason asks for an explicit real provider');

  const outcome = await submitAuthorityJobFromPlan(authorityJobPlan(), {
    env: authorityEnv(),
    fetchImpl,
    cwd: '/repo',
    provider: 'codex',
  });
  assert.equal(outcome.ok, true, 'authority job create succeeds on a valid server JobResponse');
  assert.equal(outcome.jobId, 'job-live-1', 'created job id is surfaced');
  assert.equal(outcome.runId, 'run-live-1', 'created run id is surfaced');
  assert.ok(capture.path?.endsWith('/v1/jobs'), 'job create posts to /v1/jobs');
  assert.equal(capture.authorization, 'Bearer customer-key-canary', 'job create uses the real customer API key authorization header');
  const sent = JSON.parse(capture.body ?? '{}');
  assert.equal(sent.actorId, 'main-1', 'job create is signed by the configured main actor');
  assert.equal(sent.role, 'main', 'job create uses an Authority job-creator role');
  assert.match(sent.signature, /^[0-9a-f]{128}$/i, 'job create envelope carries an Ed25519 hex signature');
  assert.equal(sent.request.provider, 'codex', 'explicit provider selects the server-supported Authority provider');
  assert.notEqual(sent.request.idempotencyKey, 'idem-1', 'server submission derives a run-scoped idempotency key from the planner key');
  assert.equal(sent.request.metadata.plannerJobCreateIdempotencyKey, 'idem-1', 'metadata preserves the planner idempotency key for audit');
  assert.equal(sent.request.plannedSteps[0].evidenceBinding.ref, 'B-auth:step-fake', 'server plannedSteps use Python-compatible evidenceBinding objects');
  assert.equal(sent.request.metadata.plannedSteps[0].evidenceBinding, 'B-auth:step-fake', 'metadata preserves original CLI plannedSteps for the live runner');
  const firstRunEnvelope = buildAuthorityJobCreateEnvelopeFromPlan(authorityJobPlan(), {
    env: authorityEnv({ LATTICE_AUTHORITY_SESSION_ID: 'run-a' }),
    cwd: '/repo',
    now: () => new Date('2026-06-08T00:00:00Z'),
    provider: 'codex',
  }) as any;
  const secondRunEnvelope = buildAuthorityJobCreateEnvelopeFromPlan(authorityJobPlan(), {
    env: authorityEnv({ LATTICE_AUTHORITY_SESSION_ID: 'run-b' }),
    cwd: '/repo',
    now: () => new Date('2026-06-08T00:00:00Z'),
    provider: 'codex',
  }) as any;
  assert.notEqual(
    firstRunEnvelope.request.idempotencyKey,
    secondRunEnvelope.request.idempotencyKey,
    'job create idempotency key must include run/session identity so fresh live retries do not conflict',
  );
}

// --- discovery fallback: server key comes from policy, not env ----------------------
{
  const approve = dynamicApproveForGateRequest();
  const policyBody = {
    contractVersion: 'authority-policy.v1', purpose: 'discovery', requiredAuthorityMode: 'enforce',
    productionEnforceAuthority: true, requireHandshake: false, commandCatalogDigest: 'ccd', evidenceSchemaDigest: 'esd',
    supportedAuthorityModes: ['off', 'shadow', 'enforce'], minClientVersions: {}, requiredEvidenceFields: [],
    evidencePolicy: { preset: 'default' },
    serverKey: { keyId: 'server-key-1', algorithm: 'ed25519', encoding: 'hex', publicKeyHex: approve.serverPublicKeyHex },
    compatibility: {
      supportedAuthorityModes: ['off', 'shadow', 'enforce'], requiredAuthorityMode: 'enforce', requireHandshake: false,
      minClientVersions: {}, commandCatalogDigest: 'ccd', evidenceSchemaDigest: 'esd', productionEnforceAuthority: true,
      requireActorKeyBinding: false, requireRunnerHeartbeatForL2: false,
    },
  };
  const counts = { events: 0, evidence: 0, evaluate: 0, receipt: 0, policy: 0 };
  const resolution = await resolveAuthorityGateEvaluator(authorityJobPlan(), {
    env: authorityEnv({ LATTICE_AUTHORITY_SERVER_KEY_ID: undefined }),
    fetchImpl: wiringRouterFetch({
      policy: { status: 200, body: policyBody },
      evaluate: approve.evaluate,
      counts,
    }),
  });
  assert.equal(counts.policy, 1, 'discovery is consulted when no server key is pinned');
  assert.equal(resolution.configured, true, 'a discovered server key resolves the verify config');
  assert.equal(resolution.decision?.status, 'verified');
}

// --- discovery fallback: unsupported algorithm fails closed on receipt verify -------
{
  const approve = dynamicApproveForGateRequest();
  const policyBody = {
    contractVersion: 'authority-policy.v1', purpose: 'discovery', requiredAuthorityMode: 'enforce',
    productionEnforceAuthority: true, requireHandshake: false, commandCatalogDigest: 'ccd', evidenceSchemaDigest: 'esd',
    supportedAuthorityModes: ['off', 'shadow', 'enforce'], minClientVersions: {}, requiredEvidenceFields: [],
    evidencePolicy: { preset: 'default' },
    serverKey: { keyId: 'server-key-1', algorithm: 'rsa', encoding: 'hex', publicKeyHex: approve.serverPublicKeyHex },
    compatibility: {
      supportedAuthorityModes: ['off', 'shadow', 'enforce'], requiredAuthorityMode: 'enforce', requireHandshake: false,
      minClientVersions: {}, commandCatalogDigest: 'ccd', evidenceSchemaDigest: 'esd', productionEnforceAuthority: true,
      requireActorKeyBinding: false, requireRunnerHeartbeatForL2: false,
    },
  };
  const counts = { events: 0, evidence: 0, evaluate: 0, receipt: 0, policy: 0 };
  const resolution = await resolveAuthorityGateEvaluator(authorityJobPlan(), {
    env: authorityEnv({ LATTICE_AUTHORITY_SERVER_KEY_ID: undefined }),
    fetchImpl: wiringRouterFetch({
      policy: { status: 200, body: policyBody },
      evaluate: approve.evaluate,
      counts,
    }),
  });
  assert.equal(counts.policy, 1, 'discovery still provides the production receipt verification material');
  assert.equal(resolution.configured, true, 'unsupported algorithm is enforced during receipt verification, not by bypassing the gate flow');
  assert.equal(resolution.decision?.status, 'receipt_unverified');
  assert.equal(resolution.decision?.receiptVerified, false);
  assert.match(resolution.decision?.reason ?? '', /unsupported algorithm/i);
  const exec = executePlannedSteps({
    root: '/tmp/x',
    store: fakeStore(),
    jobPlan: authorityJobPlan(),
    now: () => new Date('2026-06-06T00:00:00Z'),
    authorityGate: resolution.evaluator,
  });
  assert.equal(exec.status, 'blocked', 'unsupported algorithm blocks authority DONE fail-closed');
  assert.equal(exec.stopReason, 'authority_gate_receipt_unverified');
  assert.equal(exec.authorityDone, false);
}

// --- pinned server key: policy algorithm metadata still fails closed --------------
{
  const keypair = generateEd25519KeyPair();
  const approve = dynamicApproveForGateRequest(keypair);
  const policyBody = {
    contractVersion: 'authority-policy.v1', purpose: 'discovery', requiredAuthorityMode: 'enforce',
    productionEnforceAuthority: true, requireHandshake: false, commandCatalogDigest: 'ccd', evidenceSchemaDigest: 'esd',
    supportedAuthorityModes: ['off', 'shadow', 'enforce'], minClientVersions: {}, requiredEvidenceFields: [],
    evidencePolicy: { preset: 'default' },
    serverKey: { keyId: 'server-key-1', algorithm: 'rsa', encoding: 'hex', publicKeyHex: approve.serverPublicKeyHex },
    compatibility: {
      supportedAuthorityModes: ['off', 'shadow', 'enforce'], requiredAuthorityMode: 'enforce', requireHandshake: false,
      minClientVersions: {}, commandCatalogDigest: 'ccd', evidenceSchemaDigest: 'esd', productionEnforceAuthority: true,
      requireActorKeyBinding: false, requireRunnerHeartbeatForL2: false,
    },
  };
  const counts = { events: 0, evidence: 0, evaluate: 0, receipt: 0, policy: 0 };
  const pinnedEnv = authorityEnv({
    LATTICE_AUTHORITY_SERVER_PUBLIC_KEY: approve.serverPublicKeyHex,
    LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_ENCODING: 'hex',
  });
  const resolution = await resolveAuthorityGateEvaluator(authorityJobPlan(), {
    env: pinnedEnv,
    fetchImpl: wiringRouterFetch({
      policy: { status: 200, body: policyBody },
      evaluate: approve.evaluate,
      counts,
    }),
  });
  assert.equal(counts.policy, 1, 'policy metadata is consulted even when the server public key is pinned');
  assert.equal(resolution.configured, true, 'pinned key remains the receipt verification trust anchor');
  assert.equal(resolution.decision?.status, 'receipt_unverified');
  assert.equal(resolution.decision?.receiptVerified, false);
  assert.match(resolution.decision?.reason ?? '', /unsupported algorithm/i);
  const exec = executePlannedSteps({
    root: '/tmp/x',
    store: fakeStore(),
    jobPlan: authorityJobPlan(),
    now: () => new Date('2026-06-06T00:00:00Z'),
    authorityGate: resolution.evaluator,
  });
  assert.equal(exec.status, 'blocked', 'pinned key plus unsupported policy algorithm blocks authority DONE');
  assert.equal(exec.stopReason, 'authority_gate_receipt_unverified');
  assert.equal(exec.authorityDone, false);

  const statusInputDigest = 'status-input-digest-1';
  const { receipt } = signedGateReceipt({ inputDigest: statusInputDigest }, keypair);
  const statusCounts = { verdicts: 0, policy: 0 };
  const statusClient = testAuthorityClient('https://authority.test', async (input, init) => {
    const url = String(input);
    if (url.includes('/v1/jobs/job-9/verdicts') && init.method === 'GET') {
      statusCounts.verdicts += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          jobId: 'job-9',
          runId: 'run-7',
          verdicts: [],
          reconciliation: {
            independentHostCount: 2,
            requiredHostCount: 2,
            passingIndependentHostCount: 2,
            failingIndependentHostCount: 0,
            duplicateVerdictCount: 0,
            satisfied: true,
            requiredReviewWaveCount: 3,
            satisfiedReviewWaveCount: 3,
            reviewWaveRefs: ['wave-1', 'wave-2', 'wave-3'],
          },
        }),
      };
    }
    if (url.includes('/v1/authority/policy') && init.method === 'GET') {
      statusCounts.policy += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify(policyBody) };
    }
    throw Object.assign(new Error(`unexpected fetch ${init.method} ${url}`), { code: 'EUNEXPECTED' });
  });
  const status = await authorityJobVerdictStatus(statusClient, {
    jobId: 'job-9',
    runId: 'run-7',
    receipt,
    expectedProjectId: receipt.projectId,
    expectedStoryId: receipt.storyId,
    expectedServerKeyId: receipt.serverKeyId,
    expectedDecisionDigest: receipt.decisionDigest,
    expectedReceiptInputDigest: statusInputDigest,
    expectedGateInputDigest: statusInputDigest,
  }, pinnedEnv);
  assert.equal(statusCounts.policy, 1, 'job status receipt verification also consults policy metadata for pinned keys');
  assert.equal(status.ok, true);
  assert.equal(status.certification?.receiptVerified, false);
  assert.equal(status.certification?.authorityDone, false);
  assert.equal(status.certification?.fullAuthorityDone, false);
  assert.match(status.certification?.blockedReason ?? '', /authority_receipt_unverified/);
}

// --- discovery fallback: empty algorithm fails closed on receipt verify ------------
{
  const approve = dynamicApproveForGateRequest();
  const policyBody = {
    contractVersion: 'authority-policy.v1', purpose: 'discovery', requiredAuthorityMode: 'enforce',
    productionEnforceAuthority: true, requireHandshake: false, commandCatalogDigest: 'ccd', evidenceSchemaDigest: 'esd',
    supportedAuthorityModes: ['off', 'shadow', 'enforce'], minClientVersions: {}, requiredEvidenceFields: [],
    evidencePolicy: { preset: 'default' },
    serverKey: { keyId: 'server-key-1', algorithm: '   ', encoding: 'hex', publicKeyHex: approve.serverPublicKeyHex },
    compatibility: {
      supportedAuthorityModes: ['off', 'shadow', 'enforce'], requiredAuthorityMode: 'enforce', requireHandshake: false,
      minClientVersions: {}, commandCatalogDigest: 'ccd', evidenceSchemaDigest: 'esd', productionEnforceAuthority: true,
      requireActorKeyBinding: false, requireRunnerHeartbeatForL2: false,
    },
  };
  const resolution = await resolveAuthorityGateEvaluator(authorityJobPlan(), {
    env: authorityEnv({ LATTICE_AUTHORITY_SERVER_KEY_ID: undefined }),
    fetchImpl: wiringRouterFetch({
      policy: { status: 200, body: policyBody },
      evaluate: approve.evaluate,
    }),
  });
  assert.equal(resolution.configured, true, 'empty algorithm is enforced during receipt verification, not by bypassing the gate flow');
  assert.equal(resolution.decision?.status, 'receipt_unverified');
  assert.equal(resolution.decision?.receiptVerified, false);
  assert.match(resolution.decision?.reason ?? '', /unsupported algorithm/i);
}

// --- native verifier: non-string algorithm fails closed ----------------------------
{
  const { receipt, serverPublicKeyHex } = signedGateReceipt();
  const verification = verifyLatticeAuthorityReceipt(receipt, {
    serverPublicKey: serverPublicKeyHex,
    serverPublicKeyEncoding: 'hex',
    serverPublicKeyAlgorithm: 123 as any,
  });
  assert.equal(verification.verified, false);
  assert.match(verification.reason, /unsupported algorithm/i);
}

// --- discovery fallback: algorithm case variant is normalized to ed25519 -----------
{
  const approve = dynamicApproveForGateRequest();
  const policyBody = {
    contractVersion: 'authority-policy.v1', purpose: 'discovery', requiredAuthorityMode: 'enforce',
    productionEnforceAuthority: true, requireHandshake: false, commandCatalogDigest: 'ccd', evidenceSchemaDigest: 'esd',
    supportedAuthorityModes: ['off', 'shadow', 'enforce'], minClientVersions: {}, requiredEvidenceFields: [],
    evidencePolicy: { preset: 'default' },
    serverKey: { keyId: 'server-key-1', algorithm: 'ED25519', encoding: 'hex', publicKeyHex: approve.serverPublicKeyHex },
    compatibility: {
      supportedAuthorityModes: ['off', 'shadow', 'enforce'], requiredAuthorityMode: 'enforce', requireHandshake: false,
      minClientVersions: {}, commandCatalogDigest: 'ccd', evidenceSchemaDigest: 'esd', productionEnforceAuthority: true,
      requireActorKeyBinding: false, requireRunnerHeartbeatForL2: false,
    },
  };
  const resolution = await resolveAuthorityGateEvaluator(authorityJobPlan(), {
    env: authorityEnv({ LATTICE_AUTHORITY_SERVER_KEY_ID: undefined }),
    fetchImpl: wiringRouterFetch({
      policy: { status: 200, body: policyBody },
      evaluate: approve.evaluate,
    }),
  });
  assert.equal(resolution.configured, true, 'case-variant ed25519 discovery still resolves receipt verification material');
  assert.equal(resolution.decision?.status, 'verified');
  assert.equal(resolution.decision?.receiptVerified, true);
  const jobPlan = authorityJobPlan();
  const exec = executePlannedSteps({
    root: '/tmp/x',
    store: fakeStore(),
    jobPlan,
    now: () => new Date('2026-06-06T00:00:00Z'),
    authorityGate: resolution.evaluator,
    gateEvidenceRefResolver: buildGateEvidenceRefResolver(jobPlan),
  });
  assert.equal(exec.status, 'done', 'case-variant ed25519 allows authority DONE after normalization');
  assert.equal(exec.receiptVerified, true);
  assert.equal(exec.authorityDone, true);
}

// --- pinned server key: case-variant ed25519 policy metadata remains accepted ------
{
  const approve = dynamicApproveForGateRequest();
  const policyBody = {
    contractVersion: 'authority-policy.v1', purpose: 'discovery', requiredAuthorityMode: 'enforce',
    productionEnforceAuthority: true, requireHandshake: false, commandCatalogDigest: 'ccd', evidenceSchemaDigest: 'esd',
    supportedAuthorityModes: ['off', 'shadow', 'enforce'], minClientVersions: {}, requiredEvidenceFields: [],
    evidencePolicy: { preset: 'default' },
    serverKey: { keyId: 'server-key-1', algorithm: 'ED25519', encoding: 'hex', publicKeyHex: approve.serverPublicKeyHex },
    compatibility: {
      supportedAuthorityModes: ['off', 'shadow', 'enforce'], requiredAuthorityMode: 'enforce', requireHandshake: false,
      minClientVersions: {}, commandCatalogDigest: 'ccd', evidenceSchemaDigest: 'esd', productionEnforceAuthority: true,
      requireActorKeyBinding: false, requireRunnerHeartbeatForL2: false,
    },
  };
  const counts = { events: 0, evidence: 0, evaluate: 0, receipt: 0, policy: 0 };
  const resolution = await resolveAuthorityGateEvaluator(authorityJobPlan(), {
    env: authorityEnv({
      LATTICE_AUTHORITY_SERVER_PUBLIC_KEY: approve.serverPublicKeyHex,
      LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_ENCODING: 'hex',
    }),
    fetchImpl: wiringRouterFetch({
      policy: { status: 200, body: policyBody },
      evaluate: approve.evaluate,
      counts,
    }),
  });
  assert.equal(counts.policy, 1, 'case-variant ed25519 metadata is consulted for pinned keys');
  assert.equal(resolution.configured, true, 'pinned key plus ED25519 policy metadata still resolves receipt verification material');
  assert.equal(resolution.decision?.status, 'verified');
  assert.equal(resolution.decision?.receiptVerified, true);
  const exec = executePlannedSteps({
    root: '/tmp/x',
    store: fakeStore(),
    jobPlan: authorityJobPlan(),
    now: () => new Date('2026-06-06T00:00:00Z'),
    authorityGate: resolution.evaluator,
    gateEvidenceRefResolver: buildGateEvidenceRefResolver(authorityJobPlan()),
  });
  assert.equal(exec.status, 'done', 'pinned key plus ED25519 policy metadata allows authority DONE');
  assert.equal(exec.receiptVerified, true);
  assert.equal(exec.authorityDone, true);
}

// --- DENY: rejected decision -> evaluator present but executor fails closed ---------
{
  const { serverPublicKeyHex } = signedGateReceipt();
  const resolution = await resolveAuthorityGateEvaluator(authorityJobPlan(), {
    env: authorityEnv({ LATTICE_AUTHORITY_SERVER_PUBLIC_KEY: serverPublicKeyHex, LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_ENCODING: 'hex' }),
    fetchImpl: wiringRouterFetch({ evaluate: { status: 200, body: { decision: 'reject', reason: 'validation evidence insufficient' } } }),
  });
  assert.equal(resolution.configured, true);
  assert.equal(resolution.decision?.status, 'rejected');
  assert.equal(resolution.decision?.receiptVerified, false);
  const exec = executePlannedSteps({ root: '/tmp/x', store: fakeStore(), jobPlan: authorityJobPlan(), now: () => new Date('2026-06-06T00:00:00Z'), authorityGate: resolution.evaluator });
  assert.equal(exec.status, 'blocked', 'a rejected gate blocks the executor');
  assert.equal(exec.stopReason, 'authority_gate_decision_rejected');
  assert.equal(exec.authorityDone, false, 'a rejected gate never mints authority DONE');
  assert.equal(exec.receiptVerified, false);
}

// --- runAuthorityGateWiring building block: acks recorded, gate decision returned ---
{
  const { receipt, serverPublicKeyHex } = signedGateReceipt({ inputDigest: gateRequest.gateInputDigest });
  const counts = { events: 0, evidence: 0, evaluate: 0, receipt: 0, policy: 0 };
  const client = testAuthorityClient('https://a.test', wiringRouterFetch({
    evaluate: { status: 200, body: { decision: 'approve', decisionDigest: receipt.decisionDigest, receipt } },
    counts,
  }));
  const runEvents = buildAuthorityRunEventsEnvelope({ actorId: 'a', nonce: 'n', createdAt: '2026-06-06T00:00:00Z' }, 'run-1', [
    { eventId: 'e1', kind: 'command', occurredAt: '2026-06-06T00:00:00Z', payload: { evidenceBinding: 'B-auth:step-fake' } },
  ]);
  const wiring = await runAuthorityGateWiring(client, { gateRequest, verify: verifyConfig(serverPublicKeyHex, receipt.decisionDigest), runEvents, evidence: [envelope('EV-run')] });
  assert.equal(wiring.runEventsAck, 'success');
  assert.equal(wiring.evidenceAck, 'success');
  assert.equal(wiring.decision.status, 'verified');
  assert.equal(counts.events, 1);
  assert.equal(counts.evidence, 1);
  assert.equal(counts.evaluate, 1);
}

// --- runAuthorityGateWiring: required run-event upload failure blocks before gate ---
{
  const { receipt, serverPublicKeyHex } = signedGateReceipt({ inputDigest: authorityJobPlanGateInputDigest() });
  const counts = { events: 0, evidence: 0, evaluate: 0, receipt: 0, policy: 0 };
  const client = testAuthorityClient('https://a.test', wiringRouterFetch({
    events: { status: 404, body: { error: 'run missing' } },
    evaluate: { status: 200, body: { decision: 'approve', decisionDigest: receipt.decisionDigest, receipt } },
    counts,
  }));
  const runEvents = buildAuthorityRunEventsEnvelope({ actorId: 'a', nonce: 'n-run-fail', createdAt: '2026-06-06T00:00:00Z' }, 'run-missing', [
    { eventId: 'e1', kind: 'command', occurredAt: '2026-06-06T00:00:00Z', payload: { evidenceBinding: 'B-auth:step-fake' } },
  ]);
  const wiring = await runAuthorityGateWiring(client, { gateRequest, verify: verifyConfig(serverPublicKeyHex, receipt.decisionDigest), runEvents, evidence: [envelope('EV-run-fail')] });
  assert.equal(wiring.runEventsAck, 'http_error');
  assert.equal(wiring.evidenceAck, undefined, 'evidence upload is not attempted after required run-event failure');
  assert.equal(wiring.decision.status, 'blocked');
  assert.equal(wiring.decision.receiptVerified, false);
  assert.match(wiring.decision.reason, /required_authority_run_events_upload_failed:http_error status=404/);
  assert.equal(counts.events, 1);
  assert.equal(counts.evidence, 0);
  assert.equal(counts.evaluate, 0, 'gate evaluate must not run after required run-event upload failure');
}

// --- runAuthorityGateWiring: required evidence upload failure blocks before gate ---
{
  const { receipt, serverPublicKeyHex } = signedGateReceipt();
  const counts = { events: 0, evidence: 0, evaluate: 0, receipt: 0, policy: 0 };
  const client = testAuthorityClient('https://a.test', wiringRouterFetch({
    evidence: { status: 401, body: { error: 'invalid_signature' } },
    evaluate: { status: 200, body: { decision: 'approve', decisionDigest: receipt.decisionDigest, receipt } },
    counts,
  }));
  const runEvents = buildAuthorityRunEventsEnvelope({ actorId: 'a', nonce: 'n-evidence-fail', createdAt: '2026-06-06T00:00:00Z' }, 'run-1', [
    { eventId: 'e1', kind: 'command', occurredAt: '2026-06-06T00:00:00Z', payload: { evidenceBinding: 'B-auth:step-fake' } },
  ]);
  const wiring = await runAuthorityGateWiring(client, { gateRequest, verify: verifyConfig(serverPublicKeyHex, receipt.decisionDigest), runEvents, evidence: [envelope('EV-evidence-fail')] });
  assert.equal(wiring.runEventsAck, 'success');
  assert.equal(wiring.evidenceAck, 'http_error');
  assert.equal(wiring.decision.status, 'blocked');
  assert.equal(wiring.decision.receiptVerified, false);
  assert.match(wiring.decision.reason, /required_authority_evidence_upload_failed:http_error status=401/);
  assert.equal(counts.events, 1);
  assert.equal(counts.evidence, 1);
  assert.equal(counts.evaluate, 0, 'gate evaluate must not run after required evidence upload failure');
}

// ===========================================================================
// Multi-host verdict endpoints — POST/GET /v1/jobs/{jobId}/verdicts (fake server)
//
// Proves the server-side verdict client surface (truth source §X9):
//  - POST/GET hit the correct paths and shapes;
//  - the POST receipt is `host_verdict`, never `gate_decision` (overclaim → error);
//  - GET reconciliation exposes independentHostCount + the satisfied flag;
//  - submitting verdicts / a satisfied reconciliation is NOT authority DONE — the
//    local-review summarizer still keeps authorityDone/fullAuthorityDone/
//    multiHostVerified false without a verified native receipt.
// ===========================================================================

// A fetch that routes POST and GET /v1/jobs/{jobId}/verdicts.
function verdictRouterFetch(opts: {
  submit?: { status: number; body: unknown };
  list?: { status: number; body: unknown };
  capture?: { submitPath?: string; submitBody?: string; listPath?: string };
}): AuthorityFetch {
  const ok = (s: number) => s >= 200 && s < 300;
  return async (input, init) => {
    const url = String(input);
    if (url.includes('/verdicts') && init.method === 'POST') {
      if (opts.capture) { opts.capture.submitPath = url; opts.capture.submitBody = init.body; }
      const s = opts.submit ?? { status: 500, body: {} };
      return { ok: ok(s.status), status: s.status, text: async () => JSON.stringify(s.body) };
    }
    if (url.includes('/verdicts') && init.method === 'GET') {
      if (opts.capture) opts.capture.listPath = url;
      const l = opts.list ?? { status: 404, body: {} };
      return { ok: ok(l.status), status: l.status, text: async () => JSON.stringify(l.body) };
    }
    throw Object.assign(new Error(`unexpected fetch ${init.method} ${url}`), { code: 'EUNEXPECTED' });
  };
}

function finalHostPromptDigest(claim: Partial<AuthorityVerdictClaim>): string {
  return canonicalDigest(buildFinalHostReviewPromptDigestInput(claim));
}

const sampleVerdictClaim: AuthorityVerdictClaim = {
  runId: 'run-7',
  storyId: 'B-auth',
  reviewWaveId: 'wave-1',
  role: 'verifier',
  provider: 'claude',
  decision: 'pass',
  reviewPromptProfile: FINAL_HOST_REVIEW_PROMPT_PROFILE,
  checkedReceiptId: 'rcpt-gate-1',
  checkedGateInputDigest: 'gid-1',
  checkedEvidenceRefs: ['B-auth:step-validate'],
  artifactDigest: 'artifact-digest-1',
};
sampleVerdictClaim.reviewPromptDigest = finalHostPromptDigest(sampleVerdictClaim);

const sampleVerdictEnvelope = {
  actorId: 'verifier-1',
  role: 'verifier',
  nonce: 'nonce-verdict-1',
  timestamp: '2026-06-06T00:00:00Z',
  jobId: 'job-9',
  submission: {
    jobId: 'job-9',
    runId: sampleVerdictClaim.runId,
    storyId: sampleVerdictClaim.storyId,
    reviewWaveId: sampleVerdictClaim.reviewWaveId,
    reviewPromptProfile: sampleVerdictClaim.reviewPromptProfile,
    reviewPromptDigest: sampleVerdictClaim.reviewPromptDigest,
    role: sampleVerdictClaim.role,
    provider: sampleVerdictClaim.provider,
    verdict: sampleVerdictClaim.decision,
    checkedReceiptId: sampleVerdictClaim.checkedReceiptId,
    checkedGateInputDigest: sampleVerdictClaim.checkedGateInputDigest,
    checkedEvidenceRefs: sampleVerdictClaim.checkedEvidenceRefs,
    artifactDigest: sampleVerdictClaim.artifactDigest,
  },
  signature: 'test-signature',
};

// --- Backing: configured server URL remains server-backed without submit key -------
{
  const capture: { submitPath?: string; listPath?: string } = {};
  const listBody = {
    jobId: 'job-9',
    verdicts: [],
    reconciliation: {
      independentHostCount: 0,
      requiredHostCount: 2,
      passingIndependentHostCount: 0,
      failingIndependentHostCount: 0,
      satisfied: false,
    },
  };
  const verdictEnv = {
      LATTICE_AUTHORITY_MODE: 'enforce',
      LATTICE_AUTHORITY_URL: 'https://a.test',
      LATTICE_AUTHORITY_CUSTOMER_API_KEY: '',
      LATTICE_AUTHORITY_ACTOR_ID: 'verifier-1',
      LATTICE_AUTHORITY_ACTOR_ROLE: 'verifier',
      LATTICE_AUTHORITY_ACTOR_KEY: VERDICT_ACTOR_KEYPAIR.privateKey,
      LATTICE_AUTHORITY_ACTOR_KEY_ENCODING: 'base64',
  };
  const backing = resolveAuthorityVerdictBacking({
    env: verdictEnv,
    fetchImpl: verdictRouterFetch({ list: { status: 200, body: listBody }, capture }),
  });
  assert.equal(backing.mode, 'server', 'configured Authority URL keeps verdict GET server-backed without customer key');
  assert.ok(backing.client, 'server-backed verdict commands expose an AuthorityClient');

  const listed = await listAuthorityHostVerdicts(backing.client!, 'job-9');
  assert.equal(listed.ok, true, 'verdict list uses server GET without customer key');
  assert.ok(capture.listPath?.endsWith('/v1/jobs/job-9/verdicts'));

  const submitted = await submitAuthorityHostVerdict(backing.client!, 'job-9', sampleVerdictClaim, { env: verdictEnv });
  assert.equal(submitted.ok, false, 'verdict submit fails closed without customer key');
  assert.equal(submitted.transport, 'error');
  assert.match(submitted.reason ?? '', /customer_api_key_unconfigured_fails_closed/);
  assert.equal(capture.submitPath, undefined, 'verdict submit performs zero POST calls without customer key');
}

// --- Final host-check prompt digest is mandatory and canonical -------------------
{
  const verdictEnv = {
    LATTICE_AUTHORITY_MODE: 'enforce',
    LATTICE_AUTHORITY_URL: 'https://a.test',
    LATTICE_AUTHORITY_CUSTOMER_API_KEY: 'customer-key-canary',
    LATTICE_AUTHORITY_ACTOR_ID: 'verifier-1',
    LATTICE_AUTHORITY_ACTOR_ROLE: 'verifier',
    LATTICE_AUTHORITY_ACTOR_KEY: VERDICT_ACTOR_KEYPAIR.privateKey,
    LATTICE_AUTHORITY_ACTOR_KEY_ENCODING: 'base64',
  };

  for (const [claim, reasonPattern] of [
    [{ ...sampleVerdictClaim, reviewPromptDigest: undefined }, /final_host_review_prompt_digest_required/],
    [{ ...sampleVerdictClaim, reviewPromptDigest: 'wrong-digest' }, /final_host_review_prompt_digest_mismatch/],
    [{ ...sampleVerdictClaim, reviewPromptProfile: 'legacy-host-review' }, /final_host_review_prompt_profile_required/],
  ] as Array<[AuthorityVerdictClaim, RegExp]>) {
    const capture: { submitPath?: string } = {};
    const client = testAuthorityClient('https://a.test', verdictRouterFetch({ capture }));
    const submitted = await submitAuthorityHostVerdict(client, 'job-9', claim, { env: verdictEnv });
    assert.equal(submitted.ok, false, 'final host verdict prompt contract failures fail closed');
    assert.equal(submitted.transport, 'error');
    assert.match(submitted.reason ?? '', reasonPattern);
    assert.equal(capture.submitPath, undefined, 'bad final host prompt contract performs zero POST calls');
  }
}

// --- POST: submit a verdict, server returns a host_verdict receipt -----------------
{
  const capture: { submitPath?: string; submitBody?: string } = {};
  const submitBody = {
    accepted: true,
    verdict: {
      kind: 'host_verdict',
      verdictId: 'hv-1',
      jobId: 'job-9',
      runId: 'run-7',
      storyId: 'B-auth',
      hostId: 'authenticated-claude-host',
      provider: 'claude',
      role: 'verifier',
      decision: 'pass',
      independent: true,
      issuedAt: '2026-06-06T00:00:00Z',
    },
    receipt: {
      kind: 'host_verdict',
      receiptId: 'receipt-hv-1',
    },
    reconciliation: {
      independentHostCount: 1,
      requiredHostCount: 2,
      passingIndependentHostCount: 1,
      failingIndependentHostCount: 0,
      satisfied: false,
    },
  };
  const client = testAuthorityClient('https://a.test', verdictRouterFetch({ submit: { status: 200, body: submitBody }, capture }));
  const out = await client.submitJobVerdict('job-9', sampleVerdictEnvelope);
  assert.equal(out.kind, 'success', 'verdict submit success on a valid host_verdict body');
  assert.ok(capture.submitPath?.endsWith('/v1/jobs/job-9/verdicts'), 'submit hits /v1/jobs/{jobId}/verdicts');
  // Request body is the signed actor envelope Python Authority verifies. It never
  // self-reports a hostId; the server derives host identity from the actor key.
  const sent = JSON.parse(capture.submitBody ?? '{}');
  assert.equal(sent.actorId, 'verifier-1', 'submission body carries the signing actor');
  assert.equal(sent.jobId, 'job-9', 'envelope body binds the path job id');
  assert.equal(sent.submission?.runId, 'run-7', 'submission body carries the verdict claim');
  assert.equal(sent.submission?.hostId, undefined, 'client never self-reports hostId (server derives it from auth)');
  // The returned receipt is a host_verdict — NOT a gate_decision.
  assert.equal(out.data?.verdict?.kind, 'host_verdict', 'POST returns a host_verdict verdict record');
  assert.notEqual(out.data?.verdict?.kind, 'gate_decision', 'a verdict record is never a gate_decision');
  assert.equal(out.data?.verdict?.independent, true);
  assert.equal(out.data?.reconciliation?.satisfied, false, 'one host is not yet a satisfied multi-host wave');
}

// --- POST overclaim: a gate_decision-kinded receipt is rejected (error) -------------
// The verdict endpoint must never mint a native production-DONE receipt. A server
// returning kind:'gate_decision' from /verdicts is an overclaim → schema refine fails
// → client maps it to `error` (ok:false), so a host opinion can never be laundered
// into authority DONE.
{
  const overclaimBody = {
    accepted: true,
    receipt: {
      kind: 'gate_decision',
      verdictId: 'hv-bad',
      jobId: 'job-9',
      runId: 'run-7',
      hostId: 'h',
      decision: 'pass',
      issuedAt: '2026-06-06T00:00:00Z',
    },
  };
  const client = testAuthorityClient('https://a.test', verdictRouterFetch({ submit: { status: 200, body: overclaimBody } }));
  const out = await client.submitJobVerdict('job-9', sampleVerdictEnvelope);
  assert.equal(out.kind, 'error', 'a gate_decision receipt from /verdicts is rejected');
  assert.equal(out.ok, false);
  assert.ok(out.message?.includes('schema validation'), 'overclaim maps to a schema-validation error');
}

// --- GET: list verdicts + reconciliation exposes independentHostCount + satisfied ---
{
  const capture: { listPath?: string } = {};
  const listBody = {
    jobId: 'job-9',
    runId: 'run-7',
    verdicts: [
      { kind: 'host_verdict', verdictId: 'hv-1', jobId: 'job-9', runId: 'run-7', hostId: 'host-a', provider: 'codex', decision: 'pass', independent: true, issuedAt: '2026-06-06T00:00:00Z' },
      { kind: 'host_verdict', verdictId: 'hv-2', jobId: 'job-9', runId: 'run-7', hostId: 'host-b', provider: 'claude', decision: 'pass', independent: true, issuedAt: '2026-06-06T00:00:01Z' },
    ],
    reconciliation: {
      independentHostCount: 2,
      requiredHostCount: 2,
      passingIndependentHostCount: 2,
      failingIndependentHostCount: 0,
      duplicateVerdictCount: 0,
      satisfied: true,
    },
  };
  const client = testAuthorityClient('https://a.test', verdictRouterFetch({ list: { status: 200, body: listBody }, capture }));
  const out = await client.listJobVerdicts('job-9');
  assert.equal(out.kind, 'success', 'verdict list success');
  assert.ok(capture.listPath?.endsWith('/v1/jobs/job-9/verdicts'), 'list hits /v1/jobs/{jobId}/verdicts');
  assert.equal(out.data?.verdicts.length, 2);
  assert.equal(out.data?.reconciliation.independentHostCount, 2, 'reconciliation exposes the server-computed independentHostCount');
  assert.equal(out.data?.reconciliation.satisfied, true, 'reconciliation exposes the satisfied flag');
  assert.equal(out.data?.verdicts.every(v => v.kind === 'host_verdict'), true, 'every listed verdict is a host_verdict');
}

// --- GET: an unsatisfied reconciliation (coverage shortfall) ------------------------
{
  const listBody = {
    jobId: 'job-9',
    verdicts: [
      { kind: 'host_verdict', verdictId: 'hv-1', jobId: 'job-9', runId: 'run-7', hostId: 'host-a', provider: 'codex', decision: 'pass', independent: true, issuedAt: '2026-06-06T00:00:00Z' },
    ],
    reconciliation: {
      independentHostCount: 1,
      requiredHostCount: 2,
      passingIndependentHostCount: 1,
      failingIndependentHostCount: 0,
      satisfied: false,
      blockedReason: 'insufficient_independent_hosts',
    },
  };
  const client = testAuthorityClient('https://a.test', verdictRouterFetch({ list: { status: 200, body: listBody } }));
  const out = await client.listJobVerdicts('job-9');
  assert.equal(out.kind, 'success');
  assert.equal(out.data?.reconciliation.satisfied, false, 'a single host is not a satisfied multi-host wave');
  assert.equal(out.data?.reconciliation.independentHostCount, 1);
}

// --- POST/GET transport taxonomy still applies (http_error, empty path guard) -------
{
  const client = testAuthorityClient('https://a.test', verdictRouterFetch({ submit: { status: 503, body: 'down' } }));
  const out = await client.submitJobVerdict('job-9', sampleVerdictEnvelope);
  assert.equal(out.kind, 'http_error', '5xx on submit is http_error');
}
{
  const client = testAuthorityClient('https://a.test', verdictRouterFetch({ list: { status: 200, body: {} } }));
  await assert.rejects(() => client.listJobVerdicts('  '), /jobId must be a non-empty string/, 'empty jobId is rejected before any network call');
}

// --- LOCAL REVIEW INVARIANT: a satisfied multi-host wave is NOT authority DONE -------
// The server reconciliation can report satisfied=true, but the LOCAL review summarizer
// (core/verdicts.ts) must still keep authorityDone / fullAuthorityDone / multiHostVerified
// false on a passing local wave. Authority DONE flags are owned by the receipt-verifier
// path, never minted from host agreement alone (truth source §X9 local overclaim guard).
{
  const root = mkdtempSync(join(tmpdir(), 'lattice-verdict-smoke-'));
  try {
    submitVerdict(root, { mode: 'local', storyId: 'B-local', runId: 'run-x', hostId: 'codex-host', provider: 'codex', sessionId: 's1', decision: 'pass', materialDigest: 'mat-local' });
    submitVerdict(root, { mode: 'local', storyId: 'B-local', runId: 'run-x', hostId: 'claude-host', provider: 'claude', sessionId: 's2', decision: 'pass', materialDigest: 'mat-local' });
    const summary = summarizeVerdicts(root, 'local', 'B-local', 'run-x', 2);
    assert.equal(summary.status, 'pass', 'two independent passing local hosts certify the local wave');
    assert.equal(summary.localReviewCertified, true, 'a passing local wave is certified via localReviewCertified');
    assert.equal(summary.authorityDone, false, 'local review must never set authorityDone');
    assert.equal(summary.fullAuthorityDone, false, 'local review must never set fullAuthorityDone');
    assert.equal(summary.multiHostVerified, false, 'local review must never set multiHostVerified, even on a passing wave');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ===========================================================================
// Authority config hardening: default URL, authority.md, precedence, inert flag
// ===========================================================================

// --- parseAuthorityMd: machine-readable block parsing ----------------------
{
  const md = parseAuthorityMd(
    [
      '```',
      '# a comment',
      'serverUrl: http://localhost:6789/',
      'projectId: project-md',
      'runnerId: runner-md',
      'sessionId: session-md',
      'serverKeyId: local-test-server-key',
      'serverPublicKeyEncoding: hex',
      'serverPublicKey: "abc123"',
      'actorId: local-test-actor',
      'actorRole: runner',
      'actorKeyId: local-test-actor-key',
      'actorKeyPath: /tmp/actor.key',
      'customerApiKeyPath: .lattice/secrets/customer-api-key',
      'testKeyProfile: local-test',
      '- not: a kv line',
      '```',
    ].join('\n'),
  );
  assert.equal(md.serverUrl, 'http://localhost:6789/');
  assert.equal(md.projectId, 'project-md');
  assert.equal(md.runnerId, 'runner-md');
  assert.equal(md.sessionId, 'session-md');
  assert.equal(md.serverKeyId, 'local-test-server-key');
  assert.equal(md.serverPublicKey, 'abc123', 'surrounding quotes stripped');
  assert.equal(md.serverPublicKeyEncoding, 'hex');
  assert.equal(md.actorId, 'local-test-actor');
  assert.equal(md.actorRole, 'runner');
  assert.equal(md.actorKeyId, 'local-test-actor-key');
  assert.equal(md.actorKeyPath, '/tmp/actor.key');
  assert.equal(md.customerApiKeyPath, '.lattice/secrets/customer-api-key');
  assert.equal(md.testKeyProfile, 'local-test');
  // aliases
  const aliased = parseAuthorityMd('serverPublicKeyHex: deadbeef\nactorPrivateKeyPath: /k');
  assert.equal(aliased.serverPublicKey, 'deadbeef', 'serverPublicKeyHex alias');
  assert.equal(aliased.actorKeyPath, '/k', 'actorPrivateKeyPath alias');
  // non-string input is safe
  assert.deepEqual(parseAuthorityMd(undefined), {});
}

// --- parseAuthorityTrustEnv: root env profile parsing + alias normalization -
{
  const trust = parseAuthorityTrustEnv([
    '# comments ignored',
    'export LATTICE_AUTHORITY_LIVE_URL=\"https://live.example/\"',
    'LATTICE_AUTHORITY_LIVE_PUBLIC_KEY=pub-live',
    'LATTICE_AUTHORITY_CUSTOMER_API_KEY_FILE=${HOME}/secrets/customer.key',
    'LATTICE_AUTHORITY_CUSTOMER_API_KEY_DEFAULT=${MISSING_AUTHORITY_DIR:-$HOME/secrets/default.key}',
    'LATTICE_AUTHORITY_UNKNOWN_REF=$DOES_NOT_EXIST/key',
    'not a kv line',
  ].join('\n'), { HOME: '/home/lattice' });
  assert.equal(trust.LATTICE_AUTHORITY_LIVE_URL, 'https://live.example/');
  assert.equal(trust.LATTICE_AUTHORITY_LIVE_PUBLIC_KEY, 'pub-live');
  assert.equal(trust.LATTICE_AUTHORITY_CUSTOMER_API_KEY_FILE, '/home/lattice/secrets/customer.key');
  assert.equal(trust.LATTICE_AUTHORITY_CUSTOMER_API_KEY_DEFAULT, '/home/lattice/secrets/default.key');
  assert.equal(trust.LATTICE_AUTHORITY_UNKNOWN_REF, '$DOES_NOT_EXIST/key');
  const normalized = normalizeAuthorityTrustEnv(trust);
  assert.equal(normalized.LATTICE_AUTHORITY_URL, 'https://live.example/');
  assert.equal(normalized.LATTICE_AUTHORITY_SERVER_PUBLIC_KEY, 'pub-live');
  assert.equal(normalized.LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH, '/home/lattice/secrets/customer.key');
}

// --- customer API key resolution: env > path > trust env > authority.md -----
{
  const envInline = resolveAuthorityCustomerApiKey({ LATTICE_AUTHORITY_CUSTOMER_API_KEY: ' env-key ' });
  assert.equal(envInline.value, 'env-key');
  assert.equal(envInline.source, 'env');

  const envPath = resolveAuthorityCustomerApiKey(
    { LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH: 'secrets/customer.key' },
    { cwd: '/proj', fileReader: (p) => (p.endsWith('secrets/customer.key') ? ' path-key\n' : undefined) },
  );
  assert.equal(envPath.value, 'path-key');
  assert.equal(envPath.source, 'path');
  assert.ok(envPath.path?.endsWith('secrets/customer.key'));

  const trustPath = resolveAuthorityCustomerApiKey(
    {},
    {
      cwd: '/proj',
      authorityTrustEnv: normalizeAuthorityTrustEnv({
        LATTICE_AUTHORITY_CUSTOMER_API_KEY_FILE: 'secrets/trust.key',
      }),
      fileReader: (p) => (p.endsWith('secrets/trust.key') ? ' trust-key\n' : undefined),
    },
  );
  assert.equal(trustPath.value, 'trust-key');
  assert.equal(trustPath.source, 'authority_trust_env');

  const mdInline = resolveAuthorityCustomerApiKey(
    {},
    { authorityTrustEnv: {}, authorityMd: parseAuthorityMd('customerApiKey: md-key') },
  );
  assert.equal(mdInline.value, 'md-key');
  assert.equal(mdInline.source, 'authority_md');

  const auth = resolveAuthorityClientAuth({ LATTICE_AUTHORITY_CUSTOMER_API_KEY: 'client-key' });
  assert.equal(auth.customerApiKey, 'client-key');
}

// --- authority trust profile bundle: basic and senior tier round-trip --------
assertAuthorityBundleRoundTrip('basic');
assertAuthorityBundleRoundTrip('senior');

// --- legacy staging-client.env path stays consumable through authority_trust.env
{
  const root = mkdtempSync(join(tmpdir(), 'authority-legacy-client-path-'));
  try {
    mkdirSync(join(root, '.lattice'), { recursive: true });
    writeFileSync(
      join(root, 'authority_trust.env'),
      [
        'LATTICE_AUTHORITY_LIVE_URL=https://authority.example/',
        'LATTICE_AUTHORITY_LIVE_PUBLIC_KEY=legacy-server-public-key',
        'LATTICE_AUTHORITY_SERVER_KEY_ID=legacy-server-key-id',
        'LATTICE_AUTHORITY_PROJECT_ID=legacy-project-id',
        'LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH=staging-client.env',
      ].join('\n'),
    );
    writeFileSync(join(root, 'staging-client.env'), 'legacy-customer-key\n');

    const trustEnvPath = 'authority_trust.env';
    const loaded = loadAuthorityConfig(
      {
        LATTICE_AUTHORITY_MODE: 'enforce',
        LATTICE_AUTHORITY_TRUST_ENV_FILE: trustEnvPath,
      },
      {},
      { cwd: root },
    );
    assert.equal(loaded.authorityTrustEnvLoaded, true);
    assert.equal(loaded.baseURL, 'https://authority.example/');

    const resolved = resolveAuthorityCustomerApiKey(
      {
        LATTICE_AUTHORITY_MODE: 'enforce',
        LATTICE_AUTHORITY_TRUST_ENV_FILE: trustEnvPath,
      },
      { cwd: root },
    );
    assert.equal(resolved.source, 'authority_trust_env');
    assert.equal(resolved.value, 'legacy-customer-key');
    assert.equal(resolved.path, join(root, 'staging-client.env'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- resolveAuthorityConfig precedence: CLI > env > trust env > md > default
{
  const md = parseAuthorityMd('serverUrl: https://md.example/\nprojectId: project-md\nrunnerId: runner-md\nsessionId: session-md\ntestKeyProfile: local-test');
  // CLI wins over env + md
  const cli = resolveAuthorityConfig({
    env: { LATTICE_AUTHORITY_MODE: 'enforce', LATTICE_AUTHORITY_URL: 'https://env.example/' },
    override: { authorityURL: 'https://cli.example/' },
    authorityMd: md,
    authorityMdLoaded: true,
  });
  assert.equal(cli.baseURL, 'https://cli.example/');
  assert.equal(cli.urlSource, 'cli');
  // env wins over md
  const envWin = resolveAuthorityConfig({
    env: { LATTICE_AUTHORITY_MODE: 'enforce', LATTICE_AUTHORITY_URL: 'https://env.example/' },
    authorityMd: md,
    authorityMdLoaded: true,
  });
  assert.equal(envWin.baseURL, 'https://env.example/');
  assert.equal(envWin.urlSource, 'env');
  // trust env wins over md
  const trustWin = resolveAuthorityConfig({
    env: { LATTICE_AUTHORITY_MODE: 'enforce' },
    authorityTrustEnv: normalizeAuthorityTrustEnv({
      LATTICE_AUTHORITY_LIVE_URL: 'https://trust.example/',
      LATTICE_AUTHORITY_LIVE_PUBLIC_KEY: 'trust-server-key',
      LATTICE_AUTHORITY_RUNNER_ID: 'runner-trust',
    }),
    authorityTrustEnvLoaded: true,
    authorityMd: md,
    authorityMdLoaded: true,
  });
  assert.equal(trustWin.baseURL, 'https://trust.example/');
  assert.equal(trustWin.urlSource, 'authority_trust_env');
  assert.equal(trustWin.runnerId, 'runner-trust');
  assert.equal(trustWin.keyMaterial.serverPublicKey, 'trust-server-key');
  assert.equal(trustWin.keyMaterial.serverKeySource, 'authority_trust_env');
  assert.equal(trustWin.authorityTrustEnvLoaded, true);
  // md wins over the mode default
  const mdWin = resolveAuthorityConfig({
    env: { LATTICE_AUTHORITY_MODE: 'enforce' },
    authorityMd: md,
    authorityMdLoaded: true,
  });
  assert.equal(mdWin.baseURL, 'https://md.example/');
  assert.equal(mdWin.urlSource, 'authority_md');
  assert.equal(mdWin.projectId, 'project-md');
  assert.equal(mdWin.runnerId, 'runner-md');
  assert.equal(mdWin.sessionId, 'session-md');
  // local-test profile from a loaded md makes config production-inert
  assert.equal(mdWin.productionInert, true, 'local-test md profile is production-inert');
  assert.deepEqual(mdWin.productionInertReasons, ['authority_md_local_test_profile']);
}

// --- enforce + nothing else: localhost default applied, production-inert ----
{
  const cfg = resolveAuthorityConfig({ env: { LATTICE_AUTHORITY_MODE: 'enforce' } });
  assert.equal(cfg.baseURL, DEFAULT_AUTHORITY_URL, 'enforce default URL = http://localhost:6789/');
  assert.equal(cfg.urlSource, 'authority_mode_default');
  assert.equal(cfg.defaultUrlApplied, true);
  assert.equal(cfg.productionInert, true, 'localhost auto-default is production-inert');
  assert.deepEqual(cfg.productionInertReasons, ['authority_url_localhost_default']);
}

// --- off / non-authority mode: byte-identical, zero default, zero inert -----
{
  const off = resolveAuthorityConfig({ env: {} });
  assert.equal(off.mode, 'off');
  assert.equal(off.baseURL, undefined, 'off mode never applies the localhost default');
  assert.equal(off.urlSource, 'none');
  assert.equal(off.defaultUrlApplied, false);
  assert.equal(off.productionInert, false, 'off mode is not production-inert (it makes no DONE claim)');
  // an off-mode caller with an md present still ignores it (no connect)
  const offWithMd = resolveAuthorityConfig({
    env: { LATTICE_AUTHORITY_URL: 'https://env.example/' }, // mode unset -> off
    authorityMd: parseAuthorityMd('serverUrl: https://md.example/\ntestKeyProfile: local-test'),
    authorityMdLoaded: true,
  });
  assert.equal(offWithMd.mode, 'off');
  assert.equal(offWithMd.baseURL, 'https://env.example/', 'off keeps explicit env URL but ignores md');
  assert.equal(offWithMd.urlSource, 'env');
  assert.equal(offWithMd.productionInert, false, 'off mode ignores md local-test profile');
}

// --- shadow mode: no localhost default (only enforce gets it) ---------------
{
  const shadow = resolveAuthorityConfig({ env: { LATTICE_AUTHORITY_MODE: 'shadow' } });
  assert.equal(shadow.baseURL, undefined, 'shadow does not silently point at localhost');
  assert.equal(shadow.urlSource, 'none');
}

// --- key material precedence: env > md -------------------------------------
{
  const md = parseAuthorityMd(
    'serverPublicKey: mdkey\nserverKeyId: md-key-id\nactorId: md-actor\nactorKeyPath: /md/key',
  );
  // env server key wins; md actor used when env actor absent
  const cfg = resolveAuthorityConfig({
    env: { LATTICE_AUTHORITY_MODE: 'enforce', LATTICE_AUTHORITY_SERVER_PUBLIC_KEY: 'envkey' },
    authorityMd: md,
    authorityMdLoaded: true,
  });
  assert.equal(cfg.keyMaterial.serverPublicKey, 'envkey');
  assert.equal(cfg.keyMaterial.serverKeySource, 'env');
  assert.equal(cfg.keyMaterial.actorId, 'md-actor', 'md actor fills in when env actor absent');
  assert.equal(cfg.keyMaterial.actorKeyPath, '/md/key');
  assert.equal(cfg.keyMaterial.actorKeySource, 'authority_md');
}

// --- loadAuthorityConfig: off mode performs ZERO file reads ----------------
{
  let reads = 0;
  const cfg = loadAuthorityConfig({}, {}, { fileReader: (_p) => { reads += 1; return undefined; } });
  assert.equal(cfg.mode, 'off');
  assert.equal(reads, 0, 'off mode must not touch the authority.md file (zero I/O)');
}

// --- loadAuthorityConfig: enforce reads + applies authority.md via reader ---
{
  let readPath = '';
  const cfg = loadAuthorityConfig(
    { LATTICE_AUTHORITY_MODE: 'enforce' },
    {},
    {
      cwd: '/proj',
      fileReader: (p) => {
        readPath = p;
        return p.endsWith('.lattice/authority.md')
          ? 'serverUrl: https://md.example/\ntestKeyProfile: local-test'
          : undefined;
      },
    },
  );
  assert.ok(readPath.endsWith('.lattice/authority.md'), 'default key-file path resolved under cwd');
  assert.equal(cfg.authorityMdLoaded, true);
  assert.equal(cfg.baseURL, 'https://md.example/', 'authority.md serverUrl applied over mode default');
  assert.equal(cfg.urlSource, 'authority_md');
  assert.equal(cfg.productionInert, true);
}

// --- loadAuthorityConfig: enforce applies root authority_trust.env ----------
{
  const reads: string[] = [];
  const cfg = loadAuthorityConfig(
    { LATTICE_AUTHORITY_MODE: 'enforce' },
    {},
    {
      cwd: '/proj',
      fileReader: (p) => {
        reads.push(p);
        if (p.endsWith('authority_trust.env')) {
          return [
            'LATTICE_AUTHORITY_LIVE_URL=https://trust-file.example/',
            'LATTICE_AUTHORITY_LIVE_PUBLIC_KEY=trust-file-public-key',
            'LATTICE_AUTHORITY_CUSTOMER_API_KEY_FILE=secrets/customer.key',
          ].join('\n');
        }
        if (p.endsWith('.lattice/authority.md')) return 'serverUrl: https://md.example/';
        if (p.endsWith('secrets/customer.key')) return 'trust-file-customer-key';
        return undefined;
      },
    },
  );
  assert.ok(reads.some(p => p.endsWith('authority_trust.env')), 'default root trust env path is read');
  assert.equal(cfg.baseURL, 'https://trust-file.example/');
  assert.equal(cfg.urlSource, 'authority_trust_env');
  assert.equal(cfg.keyMaterial.serverPublicKey, 'trust-file-public-key');
  assert.equal(cfg.authorityTrustEnvLoaded, true);
  const key = resolveAuthorityCustomerApiKey(
    { LATTICE_AUTHORITY_MODE: 'enforce' },
    {
      cwd: '/proj',
      authorityTrustEnv: normalizeAuthorityTrustEnv(parseAuthorityTrustEnv('LATTICE_AUTHORITY_CUSTOMER_API_KEY_FILE=secrets/customer.key')),
      fileReader: p => (p.endsWith('secrets/customer.key') ? 'trust-file-customer-key' : undefined),
    },
  );
  assert.equal(key.source, 'authority_trust_env');
  assert.equal(key.value, 'trust-file-customer-key');
}

// --- readAuthorityMdConfig: missing file -> loaded:false -------------------
{
  const res = readAuthorityMdConfig({}, { cwd: '/proj', fileReader: () => undefined });
  assert.equal(res.loaded, false);
  assert.equal(res.md, undefined);
  assert.ok(res.path.endsWith('.lattice/authority.md'));
  // LATTICE_AUTHORITY_KEY_FILE override changes the path
  const overridden = readAuthorityMdConfig(
    { LATTICE_AUTHORITY_KEY_FILE: 'custom/keys.md' },
    { cwd: '/proj', fileReader: () => 'serverUrl: https://x/' },
  );
  assert.ok(overridden.path.endsWith('custom/keys.md'), 'KEY_FILE override path honored');
  assert.equal(overridden.loaded, true);
}

// --- gate evaluator: authority.md supplies URL, customer key, and actor key path ---
{
  const approve = dynamicApproveForGateRequest();
  const counts = { events: 0, evidence: 0, evaluate: 0, receipt: 0, policy: 0 };
  const resolution = await resolveAuthorityGateEvaluator(authorityJobPlan(), {
    env: { LATTICE_AUTHORITY_MODE: 'enforce' },
    cwd: '/proj',
    fileReader: (p) => {
      if (p.endsWith('.lattice/authority.md')) {
        return [
          'serverUrl: https://authority-md.example/',
          'serverKeyId: server-key-1',
          `serverPublicKey: ${approve.serverPublicKeyHex}`,
          'serverPublicKeyEncoding: hex',
          'actorId: main-1',
          'actorRole: main',
          'actorKeyPath: .lattice/secrets/gate.key',
          'actorKeyEncoding: base64',
          'customerApiKey: md-customer-key',
        ].join('\n');
      }
      if (p.endsWith('.lattice/secrets/gate.key')) return GATE_ACTOR_KEYPAIR.privateKey;
      return undefined;
    },
    fetchImpl: wiringRouterFetch({
      evaluate: approve.evaluate,
      counts,
    }),
  });
  assert.equal(resolution.configured, true, 'authority.md material can drive the gate evaluator');
  assert.equal(resolution.decision?.status, 'verified');
  assert.equal(counts.events, 3, 'authority.md actor key signs run-event envelopes');
  assert.equal(counts.evidence, 1);
  assert.equal(counts.evaluate, 1);
}

// --- gate evaluator: runner-only authority.md actor material cannot request gate ---
{
  const { receipt, serverPublicKeyHex } = signedGateReceipt();
  const counts = { events: 0, evidence: 0, evaluate: 0, receipt: 0, policy: 0 };
  const resolution = await resolveAuthorityGateEvaluator(authorityJobPlan(), {
    env: { LATTICE_AUTHORITY_MODE: 'enforce' },
    cwd: '/proj',
    fileReader: (p) => {
      if (p.endsWith('.lattice/authority.md')) {
        return [
          'serverUrl: https://authority-md.example/',
          'serverKeyId: server-key-1',
          `serverPublicKey: ${serverPublicKeyHex}`,
          'serverPublicKeyEncoding: hex',
          'actorId: runner-actor',
          'actorRole: runner',
          'actorKeyPath: .lattice/secrets/runner.key',
          'actorKeyEncoding: base64',
          'customerApiKey: md-customer-key',
        ].join('\n');
      }
      if (p.endsWith('.lattice/secrets/runner.key')) return GATE_ACTOR_KEYPAIR.privateKey;
      return undefined;
    },
    fetchImpl: wiringRouterFetch({
      evaluate: { status: 200, body: { decision: 'approve', decisionDigest: receipt.decisionDigest, receipt } },
      counts,
    }),
  });
  assert.equal(resolution.configured, false, 'runner-only authority.md actor material must not be rewritten into a gate actor');
  assert.equal(resolution.reason, 'authority_gate_actor_key_unconfigured_fails_closed');
  assert.equal(counts.evaluate, 0, 'runner-only actor material performs zero gate evaluate POSTs');
}

// --- gate evaluator: explicit gate key without explicit role cannot default to main ---
{
  const { receipt, serverPublicKeyHex } = signedGateReceipt();
  const counts = { events: 0, evidence: 0, evaluate: 0, receipt: 0, policy: 0 };
  const resolution = await resolveAuthorityGateEvaluator(authorityJobPlan(), {
    env: {
      LATTICE_AUTHORITY_MODE: 'enforce',
      LATTICE_AUTHORITY_URL: 'https://authority.example/',
      LATTICE_AUTHORITY_SERVER_KEY_ID: 'server-key-1',
      LATTICE_AUTHORITY_SERVER_PUBLIC_KEY: serverPublicKeyHex,
      LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_ENCODING: 'hex',
      LATTICE_AUTHORITY_CUSTOMER_API_KEY: 'customer-key-canary',
      LATTICE_AUTHORITY_ACTOR_ID: 'runner-actor',
      LATTICE_AUTHORITY_ACTOR_ROLE: 'runner',
      LATTICE_AUTHORITY_ACTOR_KEY: GATE_ACTOR_KEYPAIR.privateKey,
      LATTICE_AUTHORITY_ACTOR_KEY_ENCODING: 'base64',
      LATTICE_AUTHORITY_GATE_ACTOR_KEY: GATE_ACTOR_KEYPAIR.privateKey,
      LATTICE_AUTHORITY_GATE_ACTOR_KEY_ENCODING: 'base64',
    },
    fetchImpl: wiringRouterFetch({
      evaluate: { status: 200, body: { decision: 'approve', decisionDigest: receipt.decisionDigest, receipt } },
      counts,
    }),
  });
  assert.equal(resolution.configured, false, 'explicit gate actor key without GATE_ACTOR_ROLE must fail closed, not default to main');
  assert.equal(resolution.reason, 'authority_gate_actor_key_unconfigured_fails_closed');
  assert.equal(counts.evaluate, 0, 'unroled gate actor material performs zero gate evaluate POSTs');
}

// --- gate evaluator: authority.md local-test profile is production-inert ----
{
  const resolution = await resolveAuthorityGateEvaluator(authorityJobPlan(), {
    env: { LATTICE_AUTHORITY_MODE: 'enforce', LATTICE_AUTHORITY_URL: 'https://real.example/' },
    fetchImpl: noNetworkFetch,
    fileReader: () => 'testKeyProfile: local-test\nserverPublicKey: deadbeef',
  });
  assert.equal(resolution.configured, false, 'a local-test md profile must not satisfy production DONE');
  assert.equal(resolution.evaluator, undefined);
  assert.equal(
    resolution.reason,
    'authority_settings_production_inert_fails_closed:authority_md_local_test_profile',
  );
}

console.log('authority client smoke passed');

// ---------------------------------------------------------------------------
// Executor harness helpers (defined after use; hoisted function declarations).
// ---------------------------------------------------------------------------

function decisionToOutcome(decision: Awaited<ReturnType<typeof evaluateAuthorityGate>>): AuthorityGateOutcome {
  return {
    receiptVerified: decision.receiptVerified,
    decision: decision.decision,
    receiptId: decision.receiptId,
    decisionDigest: decision.decisionDigest,
    gateInputDigest: decision.gateInputDigest,
    reason: decision.reason,
  };
}

function step(stepId: string, type: PlannedStep['type'], extra: Partial<PlannedStep> = {}): PlannedStep {
  const provider = type === 'provider.fake' ? 'fake' : undefined;
  return {
    stepId,
    type,
    title: stepId,
    purpose: `${type} bounded step`,
    cwdPolicy: 'story-worktree',
    timeoutMs: 60_000,
    maxAttempts: 1,
    requiresCleanWorktree: false,
    producesEvidence: true,
    blocksUntilEvidenceUploaded: false,
    ...(provider ? { provider } : {}),
    evidenceBinding: `B-auth:${stepId}`,
    args: {},
    ...extra,
  };
}

function authorityJobPlan(): JobPlan {
  const plannedSteps = [
    step('step-fake', 'provider.fake'),
    step('step-validate', 'validate.run', { validationBinding: 'step-validate' }),
    step('step-gate', 'gate.evaluate'),
    step('step-stop', 'stop.summary'),
  ];
  return {
    schemaVersion: 'lattice.job_plan.v1',
    plannerRunId: 'prun-auth-1',
    storyId: 'B-auth',
    mode: 'authority',
    until: 'DONE',
    developmentWorkflow: 'standard',
    providerPolicy: {
      primaryProvider: 'fake',
      allowedProviders: ['fake'],
      fallbackProviders: [],
      productionDoneProviders: [],
      allowFakeProviderForProductionDone: false,
      credentialsEnvAllowlist: [],
      secretRefs: [],
      providerAvailability: 'fail_closed',
    },
    worktreePolicy: {
      resolver: 'lattice.story.resolve',
      requiresAuthoritativeWorktree: true,
      allowWorktreeRepair: false,
      allowedPathRoots: [],
      forbiddenPathGlobs: [],
      requiresCleanWorktree: false,
      preserveUnrelatedDirtyChanges: true,
      requireGitStatusEvidence: true,
    },
    retryPolicy: {
      maxAttemptsPerStep: 2,
      maxRepairAttempts: 1,
      maxNoProgressIterations: 2,
      retryableFailureKinds: ['retryable_failure'],
      repairAllowed: false,
    },
    stopPolicy: {
      maxSteps: 4,
      maxWallClockMs: 600_000,
      onValidationFailure: 'return_to_dev',
      onProviderFailure: 'retry_then_block',
      onGateFailure: 'block',
      onReceiptFailure: 'block',
      onDirtyWorktree: 'block',
      onLeaseUnsafe: 'block',
      onMultiHostDisagreement: 'block',
    },
    lease: {
      leaseId: null,
      leasedByRunnerId: null,
      leasedBySessionId: null,
      leaseExpiresAt: null,
      leaseTtlMs: 300_000,
      renewalThresholdMs: 120_000,
      graceMs: 30_000,
      leaseVersion: 0,
    },
    evidencePolicy: {
      requiredEvidenceKinds: ['run_record', 'provider_event', 'command_event', 'validation_evidence', 'git_evidence', 'gate_request', 'stop_summary'],
      redactionRequired: true,
      retentionClassByKind: {},
      allowContinueWithoutEvidence: false,
      checklistCoverageRequired: true,
    },
    receiptPolicy: {
      requiredKind: 'gate_decision',
      expectedDecisionDigest: null,
      freshnessMaxAgeMs: 600_000,
      clockSkewToleranceMs: 300_000,
      requiredServerKeyId: null,
    },
    jobCreateRequestEnvelope: {
      kind: 'authority_job_create',
      projectId: 'project-1',
      storyId: 'B-auth',
      plannerRunId: 'prun-auth-1',
      authorityMode: 'enforce',
      createdAt: '2026-06-06T00:00:00Z',
      actorId: 'actor-1',
      actorRole: 'runner',
      actorKeyId: 'key-1',
      canonicalPayloadDigest: 'cpd-1',
      storyDigest: 'sd-1',
      plannerDigest: 'pd-1',
      plannedStepsDigest: 'psd-1',
      policyDigest: 'pold-1',
      idempotencyKey: 'idem-1',
      signatureAlgorithm: 'ed25519',
    },
    plannedSteps,
    coverageMap: [{
      checklistItemId: 'CHK-001',
      verificationIntentDigest: 'vid-1',
      plannedStepIds: ['step-fake'],
      validationStepIds: ['step-validate'],
      evidenceRefs: ['B-auth:step-validate'],
      expectedArtifacts: [],
      gatePredicate: 'validate.pass',
    }],
    multiHostPolicy: {
      minIndependentHosts: 2,
      targetHostsPerWave: 2,
      preferredHostsForReleaseCertification: 3,
      preferredVerifierProviders: [],
      requireMultiHost: false,
      requiredHostVerdictCount: 2,
      fullAuthorityDoneRequired: true,
    },
    plannerDigest: 'pd-1',
    jobPlanDigest: 'jpd-1',
    status: 'planned',
  };
}

function fakeStore(): PlannerStoreLike {
  return {
    readStory: (storyId: string): StoryInfo => ({ storyId, phase: 'TEST' } as unknown as StoryInfo),
    storyExists: () => true,
    listStoryIds: () => ['B-auth'],
    appendProcessEvent: () => {},
  };
}

function runExecutor(outcome: AuthorityGateOutcome): ReturnType<typeof executePlannedSteps> {
  return executePlannedSteps({
    root: '/tmp/x',
    store: fakeStore(),
    jobPlan: authorityJobPlan(),
    now: () => new Date('2026-06-06T00:00:00Z'),
    authorityGate: () => outcome,
  });
}
