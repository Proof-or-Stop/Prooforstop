#!/usr/bin/env node
/**
 * multi-host-authority-smoke — M16 Multi-Host Final Verification (truth source §X9).
 *
 * Proves the server-backed multi-host release-certification path:
 *   1. receipt-before-verdict ordering rejects a verdict that does not name the
 *      verified gate_decision receipt it inspected — BEFORE any network call;
 *   2. the verdict commands are SERVER-backed when authority mode enables a URL
 *      (explicit URL or enforce-mode localhost default) and fall back to LOCAL
 *      storage only when authority is off; mutating submit still requires a
 *      customer API key and fails closed with zero POST when it is missing;
 *   3. fullAuthorityDone requires BOTH a verified per-run gate_decision receipt AND
 *      a server-satisfied independent-host reconciliation;
 *   4. multi-host disagreement blocks (or recommends repair_then_reverify);
 *   5. a repair that mints a fresh receipt makes prior verdicts stale, forcing a
 *      fresh review wave (local anchor staleness + server receipt staleness).
 *
 * Network is faked end-to-end (injected fetch + Ed25519 key material); no real
 * server, no provider execution.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveAuthorityVerdictBacking,
  submitAuthorityHostVerdict,
  listAuthorityHostVerdicts,
  authorityJobVerdictStatus,
  type AuthorityFetch,
  type AuthorityFileReader,
} from '../core/authority-client.js';
import {
  checkFinalHostReviewPromptDigest,
  checkReceiptBeforeVerdict,
  deriveSignedServerReviewWaveReconciliation,
  reconcileAuthorityCertification,
  partitionFreshWaveVerdicts,
  submitVerdict,
  summarizeVerdicts,
} from '../core/verdicts.js';
import type {
  AuthorityVerdictClaim,
  AuthorityVerdictReceipt,
  AuthorityVerdictReconciliation,
} from '../core/authority-contracts.js';
import {
  FINAL_HOST_REVIEW_PROMPT_PROFILE,
  buildFinalHostReviewPromptDigestInput,
} from '../core/authority-contracts.js';
import {
  evaluateAuthorityCompletion,
  type MultiHostReconciliation,
} from '../core/authority-completion.js';
import type { JobPlan } from '../core/planner.js';
import type { PlannedStepsExecutionResult } from '../core/planned-steps-executor.js';
import { canonicalDigest, generateEd25519KeyPair, signCanonical, stripSignature } from '../core/authority-signing.js';

const PASS = '✓ multi-host authority smoke passed';

// Hermetic isolation: a no-op fileReader so every backing-resolution / config
// load returns nothing from disk. Without this the dev's on-disk
// authority_trust.env (LATTICE_AUTHORITY_LIVE_URL=…) leaks via process.cwd() and
// flips E2's expected mode='local' to 'server'. fileReader is an EXISTING
// production parameter (AuthorityVerdictBackingOptions.fileReader); threading it
// from the test is 0 production change.
const NO_DISK: AuthorityFileReader = () => undefined;

// ── shared key material + a signed native gate_decision receipt ─────────────────
const serverKey = generateEd25519KeyPair();
const verdictActorKey = generateEd25519KeyPair();
const ISSUED_AT = '2026-06-06T00:00:00.000Z';
const NOW = new Date('2026-06-06T00:01:00.000Z');
const FAKE_HOST_VERDICT_SIGNATURE = 'a'.repeat(128);
const GATE_INPUT_DIGEST = 'sha256:gate-input';
const RECEIPT_INPUT_DIGEST = 'sha256:receipt-input';

function signedGateReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    receiptId: 'rcpt-gate-1',
    kind: 'gate_decision',
    projectId: 'proj-1',
    storyId: 'B-auth',
    actorId: 'authority-server',
    role: 'authority',
    stateVersion: 1,
    policyVersion: 'policy.v1',
    inputDigest: RECEIPT_INPUT_DIGEST,
    decisionDigest: 'sha256:decision',
    issuedAt: ISSUED_AT,
    serverKeyId: 'server-key-1',
    ...overrides,
  };
  const sigBase64 = signCanonical(stripSignature(base as Record<string, unknown> & { signature?: string }), serverKey.privateKey);
  const signature = Buffer.from(sigBase64, 'base64').toString('hex');
  return { ...base, signature };
}

function serverEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    LATTICE_AUTHORITY_MODE: 'enforce',
    LATTICE_AUTHORITY_URL: 'https://authority.test',
    LATTICE_AUTHORITY_CUSTOMER_API_KEY: 'customer-key-canary',
    LATTICE_AUTHORITY_SERVER_PUBLIC_KEY: serverKey.publicKey,
    LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_ENCODING: 'base64',
    LATTICE_AUTHORITY_SERVER_KEY_ID: 'server-key-1',
    LATTICE_AUTHORITY_ACTOR_ID: 'verifier-1',
    LATTICE_AUTHORITY_ACTOR_ROLE: 'verifier',
    LATTICE_AUTHORITY_ACTOR_KEY: verdictActorKey.privateKey,
    LATTICE_AUTHORITY_ACTOR_KEY_ENCODING: 'base64',
    ...extra,
  };
}

// ── fake fetch routing POST/GET /v1/jobs/{jobId}/verdicts ───────────────────────
function verdictFetch(opts: {
  submit?: { status: number; body: unknown };
  list?: { status: number; body: unknown };
  capture?: { posts: number; gets: number; lastBody?: string };
}): AuthorityFetch {
  return async (url, init) => {
    const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
    if (url.includes('/verdicts') && init.method === 'POST') {
      if (opts.capture) { opts.capture.posts += 1; opts.capture.lastBody = init.body; }
      return json(opts.submit?.status ?? 200, opts.submit?.body ?? {});
    }
    if (url.includes('/verdicts') && init.method === 'GET') {
      if (opts.capture) opts.capture.gets += 1;
      return json(opts.list?.status ?? 200, opts.list?.body ?? {});
    }
    throw new Error(`unexpected fetch ${init.method} ${url}`);
  };
}

function finalHostPromptDigest(claim: Partial<AuthorityVerdictClaim>): string {
  return canonicalDigest(buildFinalHostReviewPromptDigestInput(claim));
}

const baseClaim: AuthorityVerdictClaim = {
  runId: 'run-7',
  storyId: 'B-auth',
  reviewWaveId: 'wave-1',
  role: 'verifier',
  provider: 'claude',
  decision: 'pass',
  reviewPromptProfile: FINAL_HOST_REVIEW_PROMPT_PROFILE,
  checkedReceiptId: 'rcpt-gate-1',
  checkedGateInputDigest: 'gid-1',
  artifactDigest: 'artifact-digest-1',
};
baseClaim.reviewPromptDigest = finalHostPromptDigest(baseClaim);

const FULL_REVIEW_WAVE_REFS = ['wave-1', 'wave-2', 'wave-3'];

function reconciliation(over: Partial<AuthorityVerdictReconciliation> = {}): AuthorityVerdictReconciliation {
  return {
    independentHostCount: 2,
    requiredHostCount: 2,
    passingIndependentHostCount: 2,
    failingIndependentHostCount: 0,
    duplicateVerdictCount: 0,
    satisfiedReviewWaveCount: 1,
    requiredReviewWaveCount: 3,
    reviewWaveRefs: ['wave-1'],
    satisfied: true,
    ...over,
  };
}

function fullCertificationReconciliation(over: Partial<AuthorityVerdictReconciliation> = {}): AuthorityVerdictReconciliation {
  return reconciliation({
    satisfiedReviewWaveCount: 3,
    requiredReviewWaveCount: 3,
    reviewWaveRefs: FULL_REVIEW_WAVE_REFS,
    ...over,
  });
}

function verdictReceipt(over: Partial<AuthorityVerdictReceipt> = {}): AuthorityVerdictReceipt {
  const verdictId = over.verdictId ?? 'hv-1';
  const merged = {
    kind: 'host_verdict',
    verdictId,
    jobId: 'job-9',
    runId: 'run-7',
    storyId: 'B-auth',
    hostId: 'host-a',
    provider: 'codex',
    role: 'verifier',
    decision: 'pass',
    independent: true,
    issuedAt: ISSUED_AT,
    reviewWaveId: 'wave-1',
    checkedGateInputDigest: RECEIPT_INPUT_DIGEST,
    signature: FAKE_HOST_VERDICT_SIGNATURE,
    ...over,
  } as AuthorityVerdictReceipt;
  return {
    ...merged,
    reviewPromptProfile: merged.reviewPromptProfile ?? FINAL_HOST_REVIEW_PROMPT_PROFILE,
    reviewPromptDigest: merged.reviewPromptDigest ?? finalHostPromptDigest(merged),
  };
}

function fullCertificationVerdicts(): AuthorityVerdictReceipt[] {
  return [
    verdictReceipt({ verdictId: 'hv-1', reviewWaveId: 'wave-1', hostId: 'host-a', provider: 'codex', checkedReceiptId: 'rcpt-gate-1' }),
    verdictReceipt({ verdictId: 'hv-2', reviewWaveId: 'wave-1', hostId: 'host-b', provider: 'claude', checkedReceiptId: 'rcpt-gate-1' }),
    verdictReceipt({ verdictId: 'hv-3', reviewWaveId: 'wave-2', hostId: 'host-a', provider: 'codex', checkedReceiptId: 'rcpt-gate-1' }),
    verdictReceipt({ verdictId: 'hv-4', reviewWaveId: 'wave-2', hostId: 'host-c', provider: 'antigravity', checkedReceiptId: 'rcpt-gate-1' }),
    verdictReceipt({ verdictId: 'hv-5', reviewWaveId: 'wave-3', hostId: 'host-b', provider: 'claude', checkedReceiptId: 'rcpt-gate-1' }),
    verdictReceipt({ verdictId: 'hv-6', reviewWaveId: 'wave-3', hostId: 'host-c', provider: 'antigravity', checkedReceiptId: 'rcpt-gate-1' }),
  ];
}

async function main(): Promise<void> {
  // ── A. receipt-before-verdict ordering (pure) ─────────────────────────────────
  {
    const noReceipt = checkReceiptBeforeVerdict({ checkedReceiptId: undefined, checkedGateInputDigest: 'gid' });
    assert.equal(noReceipt.ok, false, 'A1: verdict without a receipt id is rejected');
    assert.ok(noReceipt.reason?.includes('receipt_required_before_verdict'), 'A1: names receipt-before-verdict ordering');

    const noGate = checkReceiptBeforeVerdict({ checkedReceiptId: 'rcpt', checkedGateInputDigest: '  ' });
    assert.equal(noGate.ok, false, 'A2: verdict without a gate input digest is rejected');
    assert.ok(noGate.reason?.includes('gate_input_digest_required_before_verdict'), 'A2: names the gate input digest requirement');

    assert.equal(checkReceiptBeforeVerdict(baseClaim).ok, true, 'A3: a fully bound claim passes ordering');
    assert.equal(checkFinalHostReviewPromptDigest(baseClaim).ok, true, 'A4: canonical final host-check prompt digest passes');
    assert.equal(
      checkFinalHostReviewPromptDigest({ ...baseClaim, reviewPromptDigest: undefined }).ok,
      false,
      'A5: missing final host-check prompt digest fails closed',
    );
    assert.equal(
      checkFinalHostReviewPromptDigest({ ...baseClaim, reviewPromptDigest: 'wrong-digest' }).ok,
      false,
      'A6: wrong final host-check prompt digest fails closed',
    );
  }

  // ── B. fullAuthorityDone reconciliation matrix (pure) ─────────────────────────
  {
    const oneWave = reconcileAuthorityCertification({ reconciliation: reconciliation(), receiptVerified: true });
    assert.equal(oneWave.authorityDone, true, 'B1: per-run authorityDone reflects verified receipt');
    assert.equal(oneWave.fullAuthorityDone, false, 'B1: one satisfied wave is not fullAuthorityDone');
    assert.equal(oneWave.multiHostVerified, false, 'B1: multiHostVerified requires all three final waves');
    assert.ok(oneWave.blockedReason?.includes('insufficient_review_waves'), 'B1: names the missing final host-check waves');

    const pass = reconcileAuthorityCertification({ reconciliation: fullCertificationReconciliation(), receiptVerified: true });
    assert.equal(pass.fullAuthorityDone, true, 'B1b: verified receipt + three satisfied waves = fullAuthorityDone');
    assert.equal(pass.status, 'pass', 'B1b: status pass');
    assert.equal(pass.multiHostVerified, true, 'B1b: multiHostVerified reflects three satisfied waves');
    assert.equal(pass.satisfiedReviewWaves, 3, 'B1b: surfaces satisfied wave count');

    const promptlessVerdicts = fullCertificationVerdicts().map(verdict => {
      const { reviewPromptProfile: _profile, reviewPromptDigest: _digest, ...rest } = verdict;
      return rest as AuthorityVerdictReceipt;
    });
    const promptlessReconciliation = deriveSignedServerReviewWaveReconciliation(
      fullCertificationReconciliation(),
      promptlessVerdicts,
    );
    const promptless = reconcileAuthorityCertification({ reconciliation: promptlessReconciliation, receiptVerified: true });
    assert.equal(promptless.fullAuthorityDone, false, 'B1c: three waves without canonical final host-check prompt digests are not fullAuthorityDone');
    assert.equal(promptless.multiHostVerified, false, 'B1c: promptless passing verdicts do not count toward final host certification');

    const noReceipt = reconcileAuthorityCertification({ reconciliation: fullCertificationReconciliation(), receiptVerified: false });
    assert.equal(noReceipt.fullAuthorityDone, false, 'B2: three satisfied waves WITHOUT a verified receipt is not fullAuthorityDone');
    assert.ok(noReceipt.blockedReason?.includes('authority_receipt_unverified'), 'B2: blocked on the missing receipt half');

    const disagreeBlock = reconcileAuthorityCertification({
      reconciliation: reconciliation({ failingIndependentHostCount: 1, satisfied: false }),
      receiptVerified: true,
      disagreementBehavior: 'block',
    });
    assert.equal(disagreeBlock.fullAuthorityDone, false, 'B3: a failing host blocks fullAuthorityDone');
    assert.ok(disagreeBlock.blockedReason?.includes('multi_host_disagreement'), 'B3: blocked reason is multi_host_disagreement');
    assert.ok(disagreeBlock.nextAction?.includes('stop blocked'), 'B3: block behavior recommends stopping');

    const disagreeRepair = reconcileAuthorityCertification({
      reconciliation: reconciliation({ failingIndependentHostCount: 1, satisfied: false }),
      receiptVerified: true,
      disagreementBehavior: 'repair_then_reverify',
    });
    assert.ok(disagreeRepair.nextAction?.includes('fresh gate_decision receipt'), 'B4: repair_then_reverify forces a fresh receipt + fresh review wave');

    const stale = reconcileAuthorityCertification({
      reconciliation: reconciliation(),
      receiptVerified: true,
      staleVerdictIds: ['hv-old'],
    });
    assert.equal(stale.fullAuthorityDone, false, 'B5: a stale verdict blocks fullAuthorityDone');
    assert.ok(stale.blockedReason?.includes('stale_review_wave_after_repair'), 'B5: blocked on stale review wave');

    const shortfall = reconcileAuthorityCertification({
      reconciliation: reconciliation({ passingIndependentHostCount: 1, independentHostCount: 1, satisfied: false }),
      receiptVerified: true,
    });
    assert.ok(shortfall.blockedReason?.includes('insufficient_independent_hosts'), 'B6: coverage shortfall is distinct from disagreement');
  }

  // ── C. fresh-wave partition (pure) ────────────────────────────────────────────
  {
    const part = partitionFreshWaveVerdicts(
      [
        verdictReceipt({ verdictId: 'hv-fresh', checkedReceiptId: 'rcpt-gate-2' }),
        verdictReceipt({ verdictId: 'hv-stale', checkedReceiptId: 'rcpt-gate-1' }),
        verdictReceipt({ verdictId: 'hv-nochk' }),
      ],
      'rcpt-gate-2',
    );
    assert.deepEqual(part.staleVerdictIds, ['hv-stale', 'hv-nochk'], 'C1: prior-receipt and unbound verdicts are stale');
    assert.equal(part.fresh.length, 1, 'C1: only the current receipt-bound verdict stays fresh');
  }

  // ── D. local fresh-wave anchor staleness (summarizeVerdicts) ──────────────────
  {
    const root = mkdtempSync(join(tmpdir(), 'mh-local-'));
    try {
      // Two independent hosts certified the PRE-repair chain (validationDigest=v1).
      submitVerdict(root, { mode: 'local', storyId: 'B-auth', runId: 'r1', hostId: 'h1', provider: 'codex', sessionId: 's1', decision: 'pass', validationDigest: 'v1', materialDigest: 'm1' });
      submitVerdict(root, { mode: 'local', storyId: 'B-auth', runId: 'r1', hostId: 'h2', provider: 'claude', sessionId: 's2', decision: 'pass', validationDigest: 'v1', materialDigest: 'm1' });
      // Without an anchor the pre-repair wave certifies.
      const before = summarizeVerdicts(root, 'local', 'B-auth', 'r1', 2);
      assert.equal(before.status, 'pass', 'D1: pre-repair wave certifies with no anchor filter');
      assert.equal(before.staleVerdicts, 0, 'D1: no stale verdicts without an anchor');
      // After a repair (fresh validation v2) the old verdicts are stale → blocked.
      const after = summarizeVerdicts(root, 'local', 'B-auth', 'r1', 2, { currentAnchor: { validationDigest: 'v2' } });
      assert.equal(after.status, 'blocked', 'D2: a fresh anchor invalidates the pre-repair wave');
      assert.equal(after.staleVerdicts, 2, 'D2: both pre-repair verdicts are stale');
      assert.ok(after.blockedReason?.includes('stale_review_wave'), 'D2: blocked reason names the stale review wave');
      assert.equal(after.localReviewCertified, false, 'D2: local review is not certified on a stale wave');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // ── E. backing resolution (server vs local; submit auth is fail-closed) ───────
  {
    const off = resolveAuthorityVerdictBacking({ env: {}, fileReader: NO_DISK });
    assert.equal(off.mode, 'local', 'E1: no authority config → local storage');
    assert.equal(off.client, undefined, 'E1: no client instantiated (zero network)');

    const defaultServer = resolveAuthorityVerdictBacking({ env: { LATTICE_AUTHORITY_MODE: 'enforce' }, fileReader: NO_DISK });
    assert.equal(defaultServer.mode, 'local', 'E2: localhost default is production-inert and cannot be server-backed final certification');
    assert.equal(defaultServer.settings.defaultUrlApplied, true, 'E2: default URL source is recorded');
    assert.ok(defaultServer.reason.includes('production-inert'), 'E2: refusal reason names production-inert material');

    const capture = { posts: 0, gets: 0 };
    const noKeyEnv = serverEnv({ LATTICE_AUTHORITY_CUSTOMER_API_KEY: undefined });
    const noKeyServer = resolveAuthorityVerdictBacking({
      env: noKeyEnv,
      fetchImpl: verdictFetch({ capture }),
      fileReader: NO_DISK,
    });
    assert.equal(noKeyServer.mode, 'server', 'E3: configured server remains server-backed even without a submit key');
    const noKeySubmit = await submitAuthorityHostVerdict(noKeyServer.client!, 'job-9', baseClaim, { env: noKeyEnv });
    assert.equal(noKeySubmit.ok, false, 'E3: missing customer key blocks mutating verdict submit');
    assert.equal(noKeySubmit.transport, 'error');
    assert.ok(noKeySubmit.reason?.includes('customer_api_key_unconfigured_fails_closed'), 'E3: missing-key reason is explicit');
    assert.equal(capture.posts, 0, 'E3: missing customer key performs zero POST calls');

    const server = resolveAuthorityVerdictBacking({ env: serverEnv(), fetchImpl: verdictFetch({}), fileReader: NO_DISK });
    assert.equal(server.mode, 'server', 'E4: enforce + URL + customer key → server-backed');
    assert.ok(server.client, 'E4: server client instantiated');
  }

  // ── F. server submit: ordering guard fires BEFORE any network call ────────────
  {
    const capture = { posts: 0, gets: 0 };
    const env = serverEnv();
    const server = resolveAuthorityVerdictBacking({ env, fetchImpl: verdictFetch({ capture }), fileReader: NO_DISK });
    const blocked = await submitAuthorityHostVerdict(server.client!, 'job-9', { ...baseClaim, checkedReceiptId: undefined }, { env });
    assert.equal(blocked.ok, false, 'F1: a verdict missing its receipt is blocked');
    assert.equal(capture.posts, 0, 'F1: NO network POST happens before the receipt exists (receipt-before-verdict)');
    assert.ok(blocked.reason?.includes('receipt_required_before_verdict'), 'F1: names the ordering violation');
  }

  // ── G. server submit happy + list ────────────────────────────────────────────
  {
    const capture = { posts: 0, gets: 0, lastBody: undefined as string | undefined };
    const submitBody = {
      accepted: true,
      verdict: verdictReceipt({ hostId: 'authenticated-host' }),
      receipt: { kind: 'host_verdict', receiptId: 'receipt-hv-1' },
      reconciliation: reconciliation({ passingIndependentHostCount: 1, independentHostCount: 1, satisfied: false }),
    };
    const env = serverEnv();
    const server = resolveAuthorityVerdictBacking({ env, fetchImpl: verdictFetch({ submit: { status: 200, body: submitBody }, capture }), fileReader: NO_DISK });
    const out = await submitAuthorityHostVerdict(server.client!, 'job-9', baseClaim, { env });
    assert.equal(out.ok, true, 'G1: a fully bound verdict submits');
    assert.equal(capture.posts, 1, 'G1: exactly one POST');
    assert.equal(out.accepted, true, 'G1: server accepted');
    assert.equal(out.receipt?.kind, 'host_verdict', 'G1: the receipt is a host_verdict, never a gate_decision');
    const sentBody = JSON.parse(capture.lastBody ?? '{}');
    assert.equal(sentBody.actorId, 'verifier-1', 'G1: client sends a signed verifier actor envelope');
    assert.equal(sentBody.submission?.hostId, undefined, 'G1: client never self-reports hostId (server derives it)');
    assert.equal(sentBody.submission?.artifactDigest, 'artifact-digest-1', 'G1: server-backed verdict binds the checked artifact digest');

    const rejectedServer = resolveAuthorityVerdictBacking({
      env,
      fetchImpl: verdictFetch({ submit: { status: 200, body: { accepted: false, reason: 'signature rejected' } } }),
      fileReader: NO_DISK,
    });
    const rejected = await submitAuthorityHostVerdict(rejectedServer.client!, 'job-9', baseClaim, { env });
    assert.equal(rejected.ok, false, 'G1b: a server-rejected verdict is not accepted');
    assert.equal(rejected.accepted, false, 'G1b: accepted=false stays visible');
    assert.match(rejected.reason ?? '', /signature rejected|not_accepted/, 'G1b: rejected reason is explicit');

    const listBody = { jobId: 'job-9', runId: 'run-7', verdicts: [verdictReceipt({ verdictId: 'hv-1' }), verdictReceipt({ verdictId: 'hv-2', hostId: 'host-b' })], reconciliation: reconciliation() };
    const listServer = resolveAuthorityVerdictBacking({ env: serverEnv(), fetchImpl: verdictFetch({ list: { status: 200, body: listBody } }), fileReader: NO_DISK });
    const listOut = await listAuthorityHostVerdicts(listServer.client!, 'job-9');
    assert.equal(listOut.ok, true, 'G2: list ok');
    assert.equal(listOut.verdicts.length, 2, 'G2: lists both server verdict records');
    assert.equal(listOut.reconciliation?.satisfied, true, 'G2: surfaces the server reconciliation');
    assert.equal(listOut.verdicts.every(v => v.kind === 'host_verdict'), true, 'G2: every listed verdict is a host_verdict');
  }

  // ── H. job status: receipt + reconciliation combine for fullAuthorityDone ─────
  {
    // H1: three satisfied waves + verified per-run receipt → fullAuthorityDone.
    const env = serverEnv();
    const listBody = { jobId: 'job-9', runId: 'run-7', verdicts: fullCertificationVerdicts(), reconciliation: fullCertificationReconciliation() };
    const server = resolveAuthorityVerdictBacking({ env, fetchImpl: verdictFetch({ list: { status: 200, body: listBody } }), fileReader: NO_DISK });
    const ok = await authorityJobVerdictStatus(server.client!, { jobId: 'job-9', runId: 'run-7', receipt: signedGateReceipt(), expectedProjectId: 'proj-1', expectedStoryId: 'B-auth', expectedDecisionDigest: 'sha256:decision', expectedReceiptInputDigest: RECEIPT_INPUT_DIGEST, expectedGateInputDigest: RECEIPT_INPUT_DIGEST, now: NOW }, env);
    assert.equal(ok.ok, true, 'H1: status ok');
    assert.equal(ok.certification?.fullAuthorityDone, true, 'H1: verified receipt + three satisfied waves = fullAuthorityDone');
    assert.equal(ok.certification?.authorityDone, true, 'H1: per-run receipt verified');

    // H2: three satisfied waves but NO receipt provided → fullAuthorityDone stays false.
    const server2 = resolveAuthorityVerdictBacking({ env, fetchImpl: verdictFetch({ list: { status: 200, body: listBody } }), fileReader: NO_DISK });
    const noReceipt = await authorityJobVerdictStatus(server2.client!, { jobId: 'job-9', runId: 'run-7', now: NOW }, env);
    assert.equal(noReceipt.certification?.fullAuthorityDone, false, 'H2: three satisfied waves alone are NOT fullAuthorityDone');
    assert.equal(noReceipt.certification?.authorityDone, false, 'H2: no per-run receipt proven');
    assert.equal(noReceipt.certification?.multiHostVerified, true, 'H2: the three-wave multi-host gate itself is still satisfied');

    // H3: repair minted a FRESH receipt (rcpt-gate-2) but verdicts still check the OLD
    // one → stale review wave blocks fullAuthorityDone.
    const server3 = resolveAuthorityVerdictBacking({ env, fetchImpl: verdictFetch({ list: { status: 200, body: listBody } }), fileReader: NO_DISK });
    const stale = await authorityJobVerdictStatus(server3.client!, { jobId: 'job-9', runId: 'run-7', receipt: signedGateReceipt({ receiptId: 'rcpt-gate-2' }), expectedProjectId: 'proj-1', expectedStoryId: 'B-auth', expectedDecisionDigest: 'sha256:decision', expectedReceiptInputDigest: RECEIPT_INPUT_DIGEST, expectedGateInputDigest: RECEIPT_INPUT_DIGEST, now: NOW }, env);
    assert.equal(stale.certification?.fullAuthorityDone, false, 'H3: fresh receipt + stale verdicts blocks fullAuthorityDone');
    assert.ok(stale.certification?.blockedReason?.includes('stale_review_wave_after_repair'), 'H3: blocked on stale review wave after repair');

    // H4: server reconciliation reports a failing host → disagreement blocks.
    const disagreeBody = { jobId: 'job-9', runId: 'run-7', verdicts: [verdictReceipt({ decision: 'fail', checkedReceiptId: 'rcpt-gate-1' })], reconciliation: reconciliation({ failingIndependentHostCount: 1, passingIndependentHostCount: 1, satisfied: false }) };
    const server4 = resolveAuthorityVerdictBacking({ env, fetchImpl: verdictFetch({ list: { status: 200, body: disagreeBody } }), fileReader: NO_DISK });
    const disagree = await authorityJobVerdictStatus(server4.client!, { jobId: 'job-9', runId: 'run-7', receipt: signedGateReceipt(), disagreementBehavior: 'repair_then_reverify', expectedProjectId: 'proj-1', expectedStoryId: 'B-auth', expectedDecisionDigest: 'sha256:decision', expectedReceiptInputDigest: RECEIPT_INPUT_DIGEST, expectedGateInputDigest: RECEIPT_INPUT_DIGEST, now: NOW }, env);
    assert.equal(disagree.certification?.fullAuthorityDone, false, 'H4: a failing host blocks fullAuthorityDone');
    assert.ok(disagree.certification?.blockedReason?.includes('multi_host_disagreement'), 'H4: blocked on disagreement');
    assert.ok(disagree.certification?.nextAction?.includes('fresh gate_decision receipt'), 'H4: repair_then_reverify recommends a fresh receipt + review wave');

    // H5: repeated same host inside each configured wave must not inflate the wave.
    const repeatedHostBody = {
      jobId: 'job-9',
      runId: 'run-7',
      verdicts: [
        verdictReceipt({ verdictId: 'hv-r1', reviewWaveId: 'wave-1', hostId: 'host-a', checkedReceiptId: 'rcpt-gate-1' }),
        verdictReceipt({ verdictId: 'hv-r2', reviewWaveId: 'wave-1', hostId: 'host-a', checkedReceiptId: 'rcpt-gate-1' }),
        verdictReceipt({ verdictId: 'hv-r3', reviewWaveId: 'wave-2', hostId: 'host-a', checkedReceiptId: 'rcpt-gate-1' }),
        verdictReceipt({ verdictId: 'hv-r4', reviewWaveId: 'wave-2', hostId: 'host-a', checkedReceiptId: 'rcpt-gate-1' }),
        verdictReceipt({ verdictId: 'hv-r5', reviewWaveId: 'wave-3', hostId: 'host-a', checkedReceiptId: 'rcpt-gate-1' }),
        verdictReceipt({ verdictId: 'hv-r6', reviewWaveId: 'wave-3', hostId: 'host-a', checkedReceiptId: 'rcpt-gate-1' }),
      ],
      reconciliation: fullCertificationReconciliation(),
    };
    const server5 = resolveAuthorityVerdictBacking({ env, fetchImpl: verdictFetch({ list: { status: 200, body: repeatedHostBody } }), fileReader: NO_DISK });
    const repeated = await authorityJobVerdictStatus(server5.client!, { jobId: 'job-9', runId: 'run-7', receipt: signedGateReceipt(), expectedProjectId: 'proj-1', expectedStoryId: 'B-auth', expectedDecisionDigest: 'sha256:decision', expectedReceiptInputDigest: RECEIPT_INPUT_DIGEST, expectedGateInputDigest: RECEIPT_INPUT_DIGEST, now: NOW }, env);
    assert.equal(repeated.certification?.fullAuthorityDone, false, 'H5: repeated same-host verdicts do not satisfy fullAuthorityDone');
    assert.equal(repeated.certification?.multiHostVerified, false, 'H5: repeated same host does not satisfy multi-host verification');
    assert.ok(repeated.certification?.blockedReason?.includes('insufficient_review_waves'), 'H5: block names unsatisfied review waves');

    // H6: unsigned server-listed verdict records cannot satisfy final certification.
    const unsignedBody = {
      jobId: 'job-9',
      runId: 'run-7',
      verdicts: fullCertificationVerdicts().map(({ signature: _signature, ...verdict }) => verdict),
      reconciliation: fullCertificationReconciliation(),
    };
    const server6 = resolveAuthorityVerdictBacking({ env, fetchImpl: verdictFetch({ list: { status: 200, body: unsignedBody } }), fileReader: NO_DISK });
    const unsigned = await authorityJobVerdictStatus(server6.client!, { jobId: 'job-9', runId: 'run-7', receipt: signedGateReceipt(), expectedProjectId: 'proj-1', expectedStoryId: 'B-auth', expectedDecisionDigest: 'sha256:decision', expectedReceiptInputDigest: RECEIPT_INPUT_DIGEST, expectedGateInputDigest: RECEIPT_INPUT_DIGEST, now: NOW }, env);
    assert.equal(unsigned.certification?.fullAuthorityDone, false, 'H6: unsigned verdict records do not satisfy fullAuthorityDone');
    assert.equal(unsigned.certification?.satisfiedReviewWaves, 0, 'H6: unsigned verdicts do not count as satisfied waves');
  }

  // ── I. server reconciliation -> completion gate fullAuthorityDone wiring ──────
  // Proves the multi-host final certification is wired into authority completion: a
  // server reconciliation is projected (exactly as runAuthorityCompletionLoop does)
  // into a MultiHostReconciliation and consumed by evaluateAuthorityCompletion, which
  // keeps per-run authorityDone independent of fullAuthorityDone.
  {
    const jobPlan = {
      mode: 'authority',
      until: 'DONE',
      multiHostPolicy: {
        minIndependentHosts: 2,
        targetHostsPerWave: 2,
        preferredHostsForReleaseCertification: 3,
        preferredVerifierProviders: [],
        requireMultiHost: true,
        requiredHostVerdictCount: 2,
        requiredReviewWaveCount: 3,
        fullAuthorityDoneRequired: true,
      },
    } as unknown as JobPlan;
    const execution = {
      status: 'done',
      receiptVerified: true,
      stopReason: 'completed',
      steps: [{
        stepId: 'step-gate',
        type: 'gate.evaluate',
        status: 'passed',
        evidenceBinding: 'B-auth:step-gate',
        evidenceDigest: 'digest-gate',
        startedAt: '2026-06-06T00:00:00.000Z',
        endedAt: '2026-06-06T00:00:00.000Z',
        attempts: 1,
        summary: {
          receiptVerified: true,
          receiptId: 'rcpt-gate-1',
          decisionDigest: 'sha256:decision',
          gateInputDigest: GATE_INPUT_DIGEST,
        },
      }],
    } as unknown as PlannedStepsExecutionResult;
    const verifiedGate = { status: 'verified', decision: 'approve', receiptVerified: true, receiptId: 'rcpt-gate-1', decisionDigest: 'sha256:decision', gateInputDigest: GATE_INPUT_DIGEST, receiptInputDigest: RECEIPT_INPUT_DIGEST, reason: 'verified' } as const;

    // Project a server certification view into a MultiHostReconciliation (loop parity).
    const project = (view: ReturnType<typeof reconcileAuthorityCertification>, refs: string[]): MultiHostReconciliation => ({
      independentHostVerdictCount: view.passingIndependentHosts,
      satisfied: view.multiHostVerified,
      hostVerdictRefs: refs,
      checkedReceiptId: verifiedGate.receiptId,
      checkedGateInputDigest: verifiedGate.receiptInputDigest,
      reviewWaveProofs: view.reviewWaveRefs.map((reviewWaveRef, index) => ({
        reviewWaveRef,
        independentHostVerdictCount: 2,
        hostVerdictRefs: refs.slice(index * 2, index * 2 + 2),
      })),
      satisfiedReviewWaveCount: view.satisfiedReviewWaves,
      requiredReviewWaveCount: view.requiredReviewWaves,
      reviewWaveRefs: view.reviewWaveRefs,
      ...(view.multiHostVerified ? {} : { blockedReason: view.blockedReason ?? 'multi_host_verification_incomplete' }),
    });

    // I1: three satisfied server waves + verified receipt -> fullAuthorityDone.
    const okView = reconcileAuthorityCertification({ reconciliation: fullCertificationReconciliation(), receiptVerified: true });
    const ok = evaluateAuthorityCompletion({ jobPlan, execution, gateDecision: verifiedGate, multiHost: project(okView, ['hv-1', 'hv-2', 'hv-3', 'hv-4', 'hv-5', 'hv-6']) });
    assert.equal(ok.authorityDone, true, 'I1: per-run authorityDone on verified receipt');
    assert.equal(ok.fullAuthorityDone, true, 'I1: three satisfied waves + receipt -> fullAuthorityDone');
    assert.equal(ok.completed, true, 'I1: job completes');
    assert.equal(ok.requiredHostVerdictCount, 2, 'I1: surfaces required host verdict count');
    assert.equal(ok.independentHostVerdictCount, 2, 'I1: surfaces independent count');
    assert.equal(ok.requiredReviewWaveCount, 3, 'I1: surfaces required review wave count');
    assert.equal(ok.satisfiedReviewWaveCount, 3, 'I1: surfaces satisfied review wave count');
    assert.deepEqual(ok.hostVerdictRefs, ['hv-1', 'hv-2', 'hv-3', 'hv-4', 'hv-5', 'hv-6'], 'I1: surfaces host verdict refs');
    assert.equal(ok.multiHostBlockedReason, undefined, 'I1: no blocked reason when satisfied');

    // I2: disagreement server wave -> per-run authorityDone holds but fullAuthorityDone blocked.
    const failView = reconcileAuthorityCertification({
      reconciliation: reconciliation({ passingIndependentHostCount: 1, failingIndependentHostCount: 1, satisfied: false }),
      receiptVerified: true,
    });
    const blocked = evaluateAuthorityCompletion({ jobPlan, execution, gateDecision: verifiedGate, multiHost: project(failView, ['hv-1']) });
    assert.equal(blocked.authorityDone, true, 'I2: per-run authorityDone can be true with a verified receipt');
    assert.equal(blocked.fullAuthorityDone, false, 'I2: fullAuthorityDone stays false until multi-host policy is satisfied');
    assert.equal(blocked.completed, false, 'I2: job does not complete on disagreement');
    assert.ok(blocked.multiHostBlockedReason?.includes('multi_host_disagreement'), 'I2: surfaces disagreement reason in JSON output');
    assert.equal(blocked.independentHostVerdictCount, 1, 'I2: surfaces the passing independent count');

    // I3: shortfall server wave -> distinct blocked reason, fullAuthorityDone false.
    const shortView = reconcileAuthorityCertification({
      reconciliation: reconciliation({ independentHostCount: 1, passingIndependentHostCount: 1, satisfied: false }),
      receiptVerified: true,
    });
    const short = evaluateAuthorityCompletion({ jobPlan, execution, gateDecision: verifiedGate, multiHost: project(shortView, ['hv-1']) });
    assert.equal(short.fullAuthorityDone, false, 'I3: coverage shortfall blocks fullAuthorityDone');
    assert.ok(short.multiHostBlockedReason?.includes('insufficient_independent_hosts'), 'I3: shortfall reason is distinct from disagreement');
  }

  console.log(PASS);
}

main().catch(err => {
  console.error('✗ multi-host authority smoke FAILED');
  console.error(err);
  process.exit(1);
});
