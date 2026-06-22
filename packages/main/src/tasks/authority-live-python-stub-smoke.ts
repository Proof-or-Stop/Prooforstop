#!/usr/bin/env node
//
// authority-live-python-stub-smoke (B-2522 CHK-002)
//
// DETERMINISTIC counterpart to authority-live-python-smoke.ts. It drives the SAME
// runLivePythonAuthoritySmoke() driver against an in-process stub Python Lattice
// Authority (injected fetch impls) so the live integration path is exercised in
// CI with NO deployed server and NO network. This keeps the deterministic test
// separate from the live smoke: the live file skips when env is absent; this file
// always runs and proves the driver's "beyond policy discovery" contract.
//
// Coverage:
//   1. policy discovery verifies the advertised serverKey,
//   2. control plane proves real-endpoint connectivity for register + heartbeat +
//      claim + release (no dangling lease),
//   3. a claimed authority job's typed plannedSteps[] are executed through the
//      bounded executor with gate-receipt verification:
//        - authority+DONE without a receipt blocks at the gate (receipt required),
//        - a tampered receipt fails verification and stays blocked,
//        - a validly signed receipt verifies yet authority DONE is STILL gated by
//          the executor's gate.evaluate (defense in depth),
//        - a non-DONE authority job completes with no receipt required,
//   4. a NEGATIVE connectivity test: when the stub fails the heartbeat endpoint,
//      the control-plane contract assertion must fail (no false green).

import assert from 'node:assert/strict';
import {
  generateEd25519KeyPair,
  signCanonical,
  stripSignature,
} from '../core/authority-signing.js';
import type { AuthorityFetch } from '../core/authority-client.js';
import type { PlannerStoreLike } from '../core/planner.js';
import type { StoryInfo } from '../core/types.js';
import {
  assertControlPlaneContract,
  runLivePythonAuthoritySmoke,
} from './authority-live-python-smoke.js';

const PASS_LINE =
  '✓ authority live python stub smoke passed: policy serverKey verified; control-plane register/heartbeat/claim/release connectivity; claimed-job plannedSteps executed with gate-receipt verification (DONE stays gated); negative heartbeat fails closed';

const FIXED_NOW = new Date('2026-06-06T00:00:00.000Z');
const SERVER_KEY_ID = 'stub-server-key-1';
const PROJECT_ID = 'project-stub';
const STORY_ID = 'B-stub';

// ── In-process stub Python Lattice Authority ───────────────────────────────

interface StubConfig {
  /** Override the claim response job id; null returns no job. */
  claimJobId?: string | null;
  /** Force a non-2xx status on a given control-plane step. */
  failStep?: 'runner_heartbeat' | 'claim_job' | 'release_job';
}

interface Stub {
  serverPublicKeyHex: string;
  serverPrivateKeyBase64: string;
  clientFetch: AuthorityFetch;
  controlPlaneFetch: typeof fetch;
  calls: string[];
  /** Mint a signed native gate_decision receipt bound to this stub's key. */
  signReceipt(over?: Record<string, unknown>): Record<string, unknown>;
}

function policyBody(serverPublicKeyHex: string): Record<string, unknown> {
  const serverKey = {
    keyId: SERVER_KEY_ID,
    algorithm: 'ed25519',
    encoding: 'hex',
    publicKeyHex: serverPublicKeyHex,
  };
  return {
    contractVersion: 'authority-policy.v1',
    purpose: 'discovery',
    requiredAuthorityMode: 'enforce',
    productionEnforceAuthority: true,
    requireHandshake: true,
    commandCatalogDigest: 'catalog-digest',
    evidenceSchemaDigest: 'evidence-digest',
    supportedAuthorityModes: ['off', 'shadow', 'enforce'],
    minClientVersions: { lattice: '0.3.0' },
    requiredEvidenceFields: ['storyId'],
    evidencePolicy: { preset: 'standard' },
    serverKey,
    compatibility: {
      supportedAuthorityModes: ['off', 'shadow', 'enforce'],
      requiredAuthorityMode: 'enforce',
      requireHandshake: true,
      minClientVersions: { lattice: '0.3.0' },
      commandCatalogDigest: 'catalog-digest',
      evidenceSchemaDigest: 'evidence-digest',
      productionEnforceAuthority: true,
      requireActorKeyBinding: true,
      requireRunnerHeartbeatForL2: true,
      serverKey,
    },
  };
}

function createStub(config: StubConfig = {}): Stub {
  const keypair = generateEd25519KeyPair();
  const serverPublicKeyHex = Buffer.from(keypair.publicKey, 'base64').toString('hex');
  const calls: string[] = [];
  const claimJobId = config.claimJobId === undefined ? 'job-stub-1' : config.claimJobId;

  const clientFetch: AuthorityFetch = async (input) => {
    const path = new URL(input).pathname;
    calls.push(`GET ${path}`);
    if (path === '/v1/authority/policy') {
      return { ok: true, status: 200, text: async () => JSON.stringify(policyBody(serverPublicKeyHex)) };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  const respond = (step: StubConfig['failStep'], status: number, body: unknown) => {
    if (config.failStep === step) {
      return new Response(JSON.stringify({ error: `${step} forced failure` }), { status: 500 });
    }
    return new Response(JSON.stringify(body), { status });
  };

  const controlPlaneFetch = (async (input: string | URL) => {
    const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
    calls.push(`POST ${path}`);
    if (/^\/v1\/actors\/[^/]+\/keys$/.test(path)) {
      return new Response(JSON.stringify({ ok: true, keyId: 'default' }), { status: 200 });
    }
    if (path === '/v1/runners/register') {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (/^\/v1\/runners\/[^/]+\/heartbeat$/.test(path)) {
      return respond('runner_heartbeat', 200, { ok: true });
    }
    if (/^\/v1\/runners\/[^/]+\/jobs\/claim$/.test(path)) {
      return respond('claim_job', 200, { job: claimJobId ? { jobId: claimJobId } : null });
    }
    if (/^\/v1\/jobs\/[^/]+\/release$/.test(path)) {
      return respond('release_job', 200, { ok: true });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const signReceipt = (over: Record<string, unknown> = {}): Record<string, unknown> => {
    const base: Record<string, unknown> = {
      receiptId: 'rcpt-stub-1',
      kind: 'gate_decision',
      projectId: PROJECT_ID,
      storyId: STORY_ID,
      actorId: 'lattice-authority-server',
      role: 'server',
      stateVersion: 1,
      policyVersion: 'policy-v1',
      inputDigest: 'input-digest-1',
      decisionDigest: 'dd-stub-1',
      issuedAt: FIXED_NOW.toISOString(),
      serverKeyId: SERVER_KEY_ID,
      ...over,
    };
    const signature = Buffer.from(
      signCanonical(stripSignature(base), keypair.privateKey),
      'base64',
    ).toString('hex');
    return { ...base, signature };
  };

  return {
    serverPublicKeyHex,
    serverPrivateKeyBase64: keypair.privateKey,
    clientFetch,
    controlPlaneFetch,
    calls,
    signReceipt,
  };
}

// ── Test helpers ───────────────────────────────────────────────────────────

interface RecordingStore extends PlannerStoreLike {
  events: Array<Record<string, unknown>>;
}

function recordingStore(): RecordingStore {
  const story = { storyId: STORY_ID, phase: 'DEV' } as StoryInfo;
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    readStory: () => story,
    storyExists: (id: string) => id === STORY_ID,
    listStoryIds: () => [STORY_ID],
    appendProcessEvent: (_id, event) => { events.push(event); },
  };
}

let stepSeq = 0;
function step(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  stepSeq += 1;
  const provider = type === 'provider.fake' ? 'fake' : undefined;
  return {
    stepId: `step-${String(stepSeq).padStart(3, '0')}`,
    type,
    title: `bounded ${type}`,
    purpose: `exercise ${type} in a claimed authority job`,
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

function liveEnv(stub: Stub): Record<string, string | undefined> {
  // A real (non-placeholder) ed25519 actor key so the control-plane runner signs
  // its envelopes exactly as it would against a live server.
  const actorKeypair = generateEd25519KeyPair();
  return {
    LATTICE_AUTHORITY_LIVE_URL: 'http://stub.authority.local',
    LATTICE_AUTHORITY_LIVE_PUBLIC_KEY: stub.serverPublicKeyHex,
    LATTICE_AUTHORITY_ACTOR_KEY: actorKeypair.privateKey,
    LATTICE_AUTHORITY_ACTOR_KEY_ENCODING: 'base64',
    LATTICE_AUTHORITY_RUNNER_ID: 'runner-stub',
    LATTICE_AUTHORITY_PROJECT_ID: PROJECT_ID,
    LATTICE_AUTHORITY_SESSION_ID: 'session-stub',
    LATTICE_AUTHORITY_CUSTOMER_API_KEY: 'customer-key-canary',
  };
}

function authorityDoneJob(): Record<string, unknown> {
  return {
    jobId: 'job-stub-1',
    storyId: STORY_ID,
    mode: 'authority',
    until: 'DONE',
    plannedSteps: [
      step('lattice.command', { args: { operation: 'story.resolve' } }),
      step('provider.fake'),
      step('gate.evaluate'),
    ],
  };
}

// ── 1. Skip path: missing env returns an explicit skip, never a pass ─────────

{
  const result = await runLivePythonAuthoritySmoke({ env: {} });
  assert.equal(result.skipped, true, 'absent live env must skip');
  assert(result.skipReason && result.skipReason.includes('LATTICE_AUTHORITY_LIVE_URL'), 'skip reason must name the missing env');
  assert.equal(result.controlPlane, undefined, 'a skipped run must not report control-plane results');
}

// ── 2. Happy path: policy + control-plane + claimed-job (no receipt) ──────────

{
  const stub = createStub();
  const store = recordingStore();
  const result = await runLivePythonAuthoritySmoke({
    env: liveEnv(stub),
    clientFetch: stub.clientFetch,
    controlPlaneFetch: stub.controlPlaneFetch,
    store,
    job: authorityDoneJob(),
    now: () => FIXED_NOW,
  });

  assert.equal(result.skipped, false);
  assert(result.policy?.serverKeyVerified, 'policy serverKey must verify against the advertised key');

  // Control-plane connectivity contract (shared with the live entrypoint).
  assertControlPlaneContract(result);
  const steps = (result.controlPlane?.networkEvents ?? []).map(e => e.step);
  assert(steps.includes('register_actor_key'), 'control-plane must register the actor key');
  assert(steps.includes('register_runner'), 'control-plane must register the runner');
  assert(steps.includes('runner_heartbeat'), 'control-plane must heartbeat');
  assert(steps.includes('claim_job'), 'control-plane must claim');
  assert(steps.includes('release_job'), 'control-plane must release the claimed job');
  assert.equal(result.controlPlane?.claimedJobId, 'job-stub-1');
  assert.equal(result.controlPlane?.releasedJobId, 'job-stub-1', 'claimed lease must be released');

  // Claimed-job execution: authority+DONE without a receipt blocks at the gate.
  assert.equal(result.job?.ran, true);
  assert.equal(result.job?.receiptRequired, true, 'authority+DONE requires a gate_decision receipt');
  assert.equal(result.job?.receiptProvided, false);
  assert.equal(result.job?.receiptVerified, false);
  assert.equal(result.job?.authorityDone, false, 'no receipt → authority DONE stays false');
  assert.equal(result.job?.disposition, 'blocked');
  assert(result.job?.releaseReason.includes('authority_gate_decision_receipt_required'), 'release reason must surface the receipt requirement');
  assert(store.events.some(e => e.type === 'authority_job_consumed'), 'job consumption must emit an audit event');
}

// ── 3. Gate-receipt verification: validly signed receipt verifies, DONE gated ─

{
  const stub = createStub();
  const result = await runLivePythonAuthoritySmoke({
    env: liveEnv(stub),
    clientFetch: stub.clientFetch,
    controlPlaneFetch: stub.controlPlaneFetch,
    job: authorityDoneJob(),
    receipt: stub.signReceipt(),
    now: () => FIXED_NOW,
  });
  assert.equal(result.job?.receiptProvided, true);
  assert.equal(result.job?.receiptSignatureVerified, true, 'a validly signed receipt must verify against the server key');
  // Defense in depth: even with a verified receipt the executor's gate.evaluate
  // still blocks authority+DONE — the client never mints DONE locally.
  assert.equal(result.job?.receiptVerified, false, 'raw receipt verification alone must not satisfy the executor gate');
  assert.equal(result.job?.authorityDone, false, 'authority DONE stays gated by the executor even with a verified receipt');
  assert.equal(result.job?.disposition, 'blocked');
}

// ── 4. Gate-receipt verification: tampered receipt fails closed ──────────────

{
  const stub = createStub();
  const tampered = stub.signReceipt();
  tampered.decisionDigest = 'tampered-after-signing'; // signature no longer matches
  const result = await runLivePythonAuthoritySmoke({
    env: liveEnv(stub),
    clientFetch: stub.clientFetch,
    controlPlaneFetch: stub.controlPlaneFetch,
    job: authorityDoneJob(),
    receipt: tampered,
    now: () => FIXED_NOW,
  });
  assert.equal(result.job?.receiptProvided, true);
  assert.equal(result.job?.receiptSignatureVerified, false, 'a tampered receipt must fail verification');
  assert.equal(result.job?.receiptVerified, false);
  assert.equal(result.job?.authorityDone, false);
  assert.equal(result.job?.disposition, 'blocked');
}

// ── 5. Non-DONE authority job completes (no receipt required) ─────────────────

{
  const stub = createStub();
  const result = await runLivePythonAuthoritySmoke({
    env: liveEnv(stub),
    clientFetch: stub.clientFetch,
    controlPlaneFetch: stub.controlPlaneFetch,
    job: {
      jobId: 'job-stub-test',
      storyId: STORY_ID,
      mode: 'authority',
      until: 'TEST',
      plannedSteps: [
        step('lattice.command', { args: { operation: 'story.resolve' } }),
        step('provider.fake'),
        step('gate.evaluate'),
        step('stop.summary'),
      ],
    },
    now: () => FIXED_NOW,
  });
  assert.equal(result.job?.receiptRequired, false, 'a non-DONE authority target needs no DONE receipt');
  assert.equal(result.job?.disposition, 'completed', 'an all-passing non-DONE authority job completes');
  assert.equal(result.job?.authorityDone, false);
  assert.equal(result.job?.executionStatus, 'done');
}

// ── 6. Claim returns no job: control-plane still passes, no release ──────────

{
  const stub = createStub({ claimJobId: null });
  const result = await runLivePythonAuthoritySmoke({
    env: liveEnv(stub),
    clientFetch: stub.clientFetch,
    controlPlaneFetch: stub.controlPlaneFetch,
  });
  assertControlPlaneContract(result);
  assert.equal(result.controlPlane?.claimedJobId, null, 'no job claimed');
  const steps = (result.controlPlane?.networkEvents ?? []).map(e => e.step);
  assert(!steps.includes('release_job'), 'no release when nothing was claimed');
}

// ── 7. NEGATIVE: a failing heartbeat must fail the control-plane contract ─────

{
  const stub = createStub({ failStep: 'runner_heartbeat' });
  const result = await runLivePythonAuthoritySmoke({
    env: liveEnv(stub),
    clientFetch: stub.clientFetch,
    controlPlaneFetch: stub.controlPlaneFetch,
  });
  assert.equal(result.controlPlane?.status, 'fail', 'a 500 heartbeat must mark the control-plane failed');
  let threw = false;
  try {
    assertControlPlaneContract(result);
  } catch {
    threw = true;
  }
  assert(threw, 'the control-plane contract must reject a failed heartbeat (no false green)');
}

console.log(PASS_LINE);
