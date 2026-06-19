#!/usr/bin/env node
//
// authority-live-python-full-e2e-smoke
//
// Live E2E proving the server-backed multi-host final certification path on top
// of the real queued-job Authority loop:
//   queued job -> runner claim -> verified gate_decision receipt -> 3 review waves
//   with 2 independent host verdicts each -> authority job status fullAuthorityDone.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalDigest, generateEd25519KeyPair } from '../core/authority-signing.js';
import {
  AuthorityClient,
  authorityJobVerdictStatus,
  submitAuthorityHostVerdict,
  submitAuthorityJobFromPlan,
} from '../core/authority-client.js';
import { executeAutopilotLive } from '../core/authority-job-loop-live.js';
import type { AuthorityVerdictClaim } from '../core/authority-contracts.js';
import {
  FINAL_HOST_REVIEW_PROMPT_PROFILE,
  buildFinalHostReviewPromptDigestInput,
} from '../core/authority-contracts.js';
import type { Ed25519KeyPair } from '../core/authority-signing.js';
import {
  buildLiveEnv,
  buildLiveJobPlan,
  buildLocalStore,
  envValue,
  envStringList,
  normalizeKeyToHex,
  registerActorKey,
  registerAndHeartbeatRunner,
  seedServerDoneFacts,
  skip,
  type Env,
  type LiveContext,
} from './authority-live-python-e2e-smoke.js';

const PASS_LINE =
  'PASS authority live Python FULL E2E smoke: queued job certified by three server-backed multi-host waves, fullAuthorityDone=true';

interface HostMaterial {
  actorId: string;
  deviceId: string;
  provider: 'codex' | 'claude' | 'antigravity';
  model: string;
  keyPair: Ed25519KeyPair;
}

function hostEnv(base: Env, ctx: LiveContext, host: HostMaterial): Env {
  return {
    ...base,
    LATTICE_AUTHORITY_MODE: 'enforce',
    LATTICE_AUTHORITY_URL: ctx.liveURL,
    LATTICE_AUTHORITY_LIVE_URL: ctx.liveURL,
    LATTICE_AUTHORITY_CUSTOMER_API_KEY: ctx.customerApiKey,
    LATTICE_AUTHORITY_SERVER_PUBLIC_KEY: ctx.expectedServerKeyHex,
    LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_ENCODING: 'hex',
    LATTICE_AUTHORITY_SERVER_KEY_ID: ctx.serverKeyId,
    LATTICE_AUTHORITY_ACTOR_ID: host.actorId,
    LATTICE_AUTHORITY_ACTOR_ROLE: 'verifier',
    LATTICE_AUTHORITY_ACTOR_KEY: host.keyPair.privateKey,
    LATTICE_AUTHORITY_ACTOR_KEY_ENCODING: 'base64',
    LATTICE_AUTHORITY_DEVICE_ID: host.deviceId,
  };
}

function hostClaim(input: {
  ctx: LiveContext;
  jobId: string;
  runId: string;
  reviewWaveId: string;
  host: HostMaterial;
  receiptId: string;
  gateInputDigest: string;
  decisionDigest?: string;
  evidenceRefs: string[];
}): AuthorityVerdictClaim {
  const { ctx, jobId, runId, reviewWaveId, host, receiptId, gateInputDigest, decisionDigest, evidenceRefs } = input;
  return {
    runId,
    storyId: ctx.storyId,
    role: 'verifier',
    provider: host.provider,
    model: host.model,
    decision: 'pass',
    reviewWaveId,
    reviewPromptProfile: FINAL_HOST_REVIEW_PROMPT_PROFILE,
    reviewPromptDigest: canonicalDigest(buildFinalHostReviewPromptDigestInput({
      reviewWaveId,
      provider: host.provider,
      checkedReceiptId: receiptId,
      checkedGateInputDigest: gateInputDigest,
      checkedEvidenceRefs: evidenceRefs,
      checkedMaterialHash: ctx.repo.materialHash,
      checkedCommit: ctx.repo.headHash,
    })),
    checkedEvidenceRefs: evidenceRefs,
    checkedReceiptId: receiptId,
    checkedGateInputDigest: gateInputDigest,
    checkedMaterialHash: ctx.repo.materialHash,
    checkedCommit: ctx.repo.headHash,
    commandsRun: ['npm run test:authority-live-python-full-e2e'],
    findings: [],
    artifactDigest: canonicalDigest({
      kind: 'authority-live-full-e2e-host-artifact',
      jobId,
      runId,
      reviewWaveId,
      hostId: host.deviceId,
      receiptId,
      gateInputDigest,
      decisionDigest,
    }),
  };
}

async function buildContext(env: Env): Promise<LiveContext | null> {
  const liveURL = envValue(env, 'LIVE_URL') ?? envValue(env, 'URL');
  const livePublicKey = envValue(env, 'LIVE_PUBLIC_KEY') ?? envValue(env, 'SERVER_PUBLIC_KEY');
  const customerApiKey = envValue(env, 'CUSTOMER_API_KEY');
  const bootstrapToken = envValue(env, 'BOOTSTRAP_TOKEN');
  if (!liveURL || !livePublicKey || !customerApiKey) {
    skip('set LATTICE_AUTHORITY_LIVE_URL, LATTICE_AUTHORITY_LIVE_PUBLIC_KEY, and LATTICE_AUTHORITY_CUSTOMER_API_KEY');
    return null;
  }

  const policy = await new AuthorityClient(liveURL).discoverPolicy();
  if (!policy.ok || !policy.data?.serverKey) {
    throw new Error(`authority policy discovery failed: ${policy.ok ? 'missing serverKey' : policy.message ?? policy.kind}`);
  }
  const expectedServerKeyHex = normalizeKeyToHex(livePublicKey);
  assert.equal(policy.data.serverKey.publicKeyHex.toLowerCase(), expectedServerKeyHex, 'live server public key must match pinned key');
  assert.ok(policy.data.commandCatalogDigest, 'live server policy must expose commandCatalogDigest');
  assert.ok(policy.data.evidenceSchemaDigest, 'live server policy must expose evidenceSchemaDigest');

  const suffix = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
  const baselineId = envValue(env, 'LIVE_BASELINE_ID');
  const storyPrefix = baselineId
    ? `B-baseline-${baselineId}`
    : 'B-live-full-e2e';
  return {
    liveURL,
    expectedServerKeyHex,
    serverKeyId: policy.data.serverKey.keyId,
    commandCatalogDigest: policy.data.commandCatalogDigest,
    evidenceSchemaDigest: policy.data.evidenceSchemaDigest,
    customerApiKey,
    ...(bootstrapToken ? { bootstrapToken } : {}),
    projectId: envValue(env, 'PROJECT_ID') ?? `project-live-full-e2e-${suffix}`,
    storyId: `${storyPrefix}-${suffix}`,
    sessionId: `session-live-full-e2e-${suffix}`,
    runnerId: `runner-live-full-e2e-${suffix}`,
    deviceId: `device-live-full-e2e-${suffix}`,
    mainActorId: `main-live-full-e2e-${suffix}`,
    reviewerActorId: `reviewer-live-full-e2e-${suffix}`,
    verifierActorId: `verifier-live-full-e2e-${suffix}`,
    secondVerifierActorId: `verifier2-live-full-e2e-${suffix}`,
    runnerActorId: `runner-actor-live-full-e2e-${suffix}`,
    extraEvidenceRefs: envStringList(env, 'LIVE_EXTRA_EVIDENCE_REFS'),
    repo: {
      headHash: `head-live-full-e2e-${suffix}`,
      materialHash: `material-live-full-e2e-${suffix}`,
      dirty: false,
    },
    main: generateEd25519KeyPair(),
    reviewer: generateEd25519KeyPair(),
    verifier: generateEd25519KeyPair(),
    secondVerifier: generateEd25519KeyPair(),
    runner: generateEd25519KeyPair(),
  };
}

async function registerBaseActors(ctx: LiveContext): Promise<void> {
  await registerActorKey(ctx, ctx.mainActorId, 'main', ctx.main, { deviceId: ctx.deviceId });
  await registerActorKey(ctx, ctx.reviewerActorId, 'reviewer', ctx.reviewer, { deviceId: ctx.deviceId });
  await registerActorKey(ctx, ctx.verifierActorId, 'verifier', ctx.verifier, { runnerId: ctx.runnerId });
  await registerActorKey(ctx, ctx.secondVerifierActorId, 'verifier', ctx.secondVerifier, { runnerId: ctx.runnerId });
  await registerActorKey(ctx, ctx.runnerActorId, 'runner', ctx.runner, { runnerId: ctx.runnerId });
  await registerAndHeartbeatRunner(ctx);
}

async function main(): Promise<void> {
  const env = process.env as Env;
  const ctx = await buildContext(env);
  if (!ctx) return;

  await registerBaseActors(ctx);
  await seedServerDoneFacts(ctx);

  const liveEnv = buildLiveEnv(ctx, env);
  const jobPlan = buildLiveJobPlan(ctx);
  const { root, store } = buildLocalStore(ctx);
  const created = await submitAuthorityJobFromPlan(jobPlan, {
    env: liveEnv,
    cwd: root,
    now: () => new Date(),
  });
  assert.equal(created.ok, true, `authority job create failed: ${created.reason ?? created.transport}`);
  assert.ok(created.jobId, 'authority job create must return jobId');
  assert.ok(created.runId, 'authority job create must return runId');

  const result = await executeAutopilotLive({
    store,
    root,
    args: {
      mode: 'authority',
      storyId: ctx.storyId,
      until: 'DONE',
      maxSteps: 20,
    },
    env: liveEnv,
  });
  assert.equal(result.authorityDone, true, 'per-run authorityDone must be true before final host certification');
  assert.equal(result.fullAuthorityDone, false, 'fullAuthorityDone must be false before host verdicts');
  assert.equal(result.completion?.receiptVerified, true, 'native gate_decision receipt must verify');
  assert.ok(result.completion?.receiptId, 'completion must expose receiptId');
  assert.ok(result.completion?.decisionDigest, 'completion must expose decisionDigest');

  const client = new AuthorityClient(ctx.liveURL, globalThis.fetch as any, 30_000, { customerApiKey: ctx.customerApiKey });
  const receiptFetch = await client.fetchReceipt(result.completion.receiptId);
  assert.equal(receiptFetch.ok, true, `receipt fetch failed: ${receiptFetch.ok ? '' : receiptFetch.message ?? receiptFetch.kind}`);
  assert.ok(receiptFetch.data, 'receipt fetch must return receipt JSON');

  const hosts: HostMaterial[] = [
    { actorId: `host-codex-wave1-${ctx.storyId}`, deviceId: `host-codex-wave1-${ctx.storyId}`, provider: 'codex', model: 'codex-cli', keyPair: generateEd25519KeyPair() },
    { actorId: `host-claude-wave1-${ctx.storyId}`, deviceId: `host-claude-wave1-${ctx.storyId}`, provider: 'claude', model: 'claude-cli', keyPair: generateEd25519KeyPair() },
    { actorId: `host-codex-wave2-${ctx.storyId}`, deviceId: `host-codex-wave2-${ctx.storyId}`, provider: 'codex', model: 'codex-cli', keyPair: generateEd25519KeyPair() },
    { actorId: `host-antigravity-wave2-${ctx.storyId}`, deviceId: `host-antigravity-wave2-${ctx.storyId}`, provider: 'antigravity', model: 'antigravity-cli', keyPair: generateEd25519KeyPair() },
    { actorId: `host-claude-wave3-${ctx.storyId}`, deviceId: `host-claude-wave3-${ctx.storyId}`, provider: 'claude', model: 'claude-cli', keyPair: generateEd25519KeyPair() },
    { actorId: `host-antigravity-wave3-${ctx.storyId}`, deviceId: `host-antigravity-wave3-${ctx.storyId}`, provider: 'antigravity', model: 'antigravity-cli', keyPair: generateEd25519KeyPair() },
  ];
  for (const host of hosts) {
    await registerActorKey(ctx, host.actorId, 'verifier', host.keyPair, { deviceId: host.deviceId });
  }

  const receiptId = result.completion.receiptId;
  const executorGateInputDigestValue = result.completion.gateInputDigest;
  const receiptInputDigestValue = (receiptFetch.data as { inputDigest?: unknown }).inputDigest;
  assert.equal(typeof executorGateInputDigestValue, 'string', 'completion must expose executor gateInputDigest');
  assert.equal(typeof receiptInputDigestValue, 'string', 'fetched receipt must expose receipt inputDigest');
  const executorGateInputDigest = executorGateInputDigestValue as string;
  const receiptInputDigest = receiptInputDigestValue as string;
  const gateInputDigest = receiptInputDigest;
  const evidenceRefs = [...new Set([...(result.authorityJobLoop?.evidenceRefs ?? []), ...ctx.extraEvidenceRefs])];
  assert.ok(evidenceRefs.length > 0, 'live job loop must expose evidence refs for host verdict checks');

  for (const [index, host] of hosts.entries()) {
    const wave = `wave-${Math.floor(index / 2) + 1}`;
    const outcome = await submitAuthorityHostVerdict(
      client,
      created.jobId,
      hostClaim({
        ctx,
        jobId: created.jobId,
        runId: created.runId,
        reviewWaveId: wave,
        host,
        receiptId,
        gateInputDigest,
        decisionDigest: result.completion.decisionDigest,
        evidenceRefs,
      }),
      {
        env: hostEnv(env, ctx, host),
        cwd: root,
      },
    );
    assert.equal(outcome.ok, true, `host verdict ${index + 1} must submit: ${outcome.reason ?? outcome.transport}`);
    assert.equal(outcome.accepted, true, `host verdict ${index + 1} must be accepted`);
  }

  const status = await authorityJobVerdictStatus(
    client,
    {
      jobId: created.jobId,
      runId: created.runId,
      receipt: receiptFetch.data,
      expectedProjectId: ctx.projectId,
      expectedStoryId: ctx.storyId,
      expectedServerKeyId: ctx.serverKeyId,
      expectedDecisionDigest: result.completion.decisionDigest,
      expectedReceiptInputDigest: receiptInputDigest,
      expectedGateInputDigest: gateInputDigest,
    },
    liveEnv,
  );
  assert.equal(status.ok, true, `authority job status must succeed: ${status.reason ?? status.transport}`);
  assert.equal(status.certification?.authorityDone, true, 'status must preserve verified per-run authorityDone');
  assert.equal(status.certification?.receiptVerified, true, 'status must verify native gate receipt');
  assert.equal(status.certification?.multiHostVerified, true, 'status must verify three server-backed host waves');
  assert.equal(status.certification?.satisfiedReviewWaves, 3, 'status must count three satisfied review waves');
  assert.equal(status.certification?.fullAuthorityDone, true, 'status must certify fullAuthorityDone');

  const evidenceOutputDir = envValue(env, 'LIVE_EVIDENCE_OUTPUT_DIR');
  if (evidenceOutputDir) {
    const verdictList = await client.listJobVerdicts(created.jobId);
    assert.equal(verdictList.ok, true, `verdict list artifact fetch must succeed: ${verdictList.ok ? '' : verdictList.message ?? verdictList.kind}`);
    mkdirSync(evidenceOutputDir, { recursive: true });
    writeFileSync(join(evidenceOutputDir, 'gate-receipt.json'), `${JSON.stringify(receiptFetch.data, null, 2)}\n`);
    writeFileSync(join(evidenceOutputDir, 'host-verdicts.json'), `${JSON.stringify(verdictList.data, null, 2)}\n`);
    writeFileSync(join(evidenceOutputDir, 'authority-live-full-e2e-summary.json'), `${JSON.stringify({
      schemaVersion: 'lattice.authority-live-full-e2e-summary.v1',
      liveURL: ctx.liveURL,
      serverKeyId: ctx.serverKeyId,
      serverPublicKeySha256Prefix: canonicalDigest(ctx.expectedServerKeyHex).slice(0, 12),
      jobId: created.jobId,
      runId: created.runId,
      receiptId,
      gateInputDigest,
      receiptInputDigest,
      executorGateInputDigest,
      decisionDigest: result.completion.decisionDigest,
      extraEvidenceRefs: ctx.extraEvidenceRefs,
      verdictCount: verdictList.data?.verdicts.length ?? 0,
      fullAuthorityDone: status.certification.fullAuthorityDone,
    }, null, 2)}\n`);
  }

  console.log(PASS_LINE);
}

await main();
