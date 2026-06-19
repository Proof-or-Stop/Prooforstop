#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AuthorityClient } from '../core/authority-client.js';
import { canonicalDigest, generateEd25519KeyPair, type Ed25519KeyPair } from '../core/authority-signing.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { runAuthorityReceiptVerify } from '../handlers/authority-enforce.js';
import { createVerifierHandlers } from '../handlers/verifier.js';
import { runAuthorityReceiptTransitionGate } from '../handlers/phase-gates.js';
import {
  buildGateEvaluateRequest,
  type GateEvaluateRequestContract,
} from '../core/authority-contracts.js';
import { gateDecisionInputDigest } from '../core/authority-gate-receipt-verifier.js';
import {
  envValue,
  envStringList,
  LIVE_E2E_CLIENT_VERSION,
  normalizeKeyToHex,
  postJson,
  pythonCanonicalTimestamp,
  registerActorKey,
  registerAndHeartbeatRunner,
  signedCommand,
  signHexEnvelope,
  type Env,
  type LiveContext,
} from './authority-live-python-e2e-smoke.js';

const PASS_LINE =
  'PASS authority live receipt-ref gate smoke: staging proof fetched, receipt ref written, TEST/DONE gates consumed, negative control blocked';

function skip(reason: string): void {
  console.log(`authority live receipt-ref gate smoke SKIPPED: ${reason}`);
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function publicKeyDigestFromHex(publicKeyHex: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex')}`;
}

function pythonModelDigest(value: unknown): string {
  const prune = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(prune);
    if (!item || typeof item !== 'object') return item;
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(item as Record<string, unknown>)) {
      if (key === 'serverSignature' || raw === null || raw === undefined) continue;
      out[key] = prune(raw);
    }
    return out;
  };
  return canonicalDigest(prune(value));
}

function makeLocalRoot(storyId: string): {
  root: string;
  store: StoryStore;
  headHash: string;
  materialHash: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'lattice-authority-live-receipt-ref-'));
  mkdirSync(join(root, 'packages', 'main', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'main', 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
    workflow: { profile: 'balanced' },
  }, null, 2) + '\n', 'utf8');
  git(root, ['init']);
  git(root, ['config', 'user.email', 'authority-smoke@example.invalid']);
  git(root, ['config', 'user.name', 'Authority Receipt Ref Smoke']);
  git(root, ['add', 'lattice.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'seed']);
  resetConfigCache();
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root);
  assert.ok(headHash, 'temporary git root must expose HEAD');
  assert.ok(materialHash, 'temporary git root must expose material hash');
  const store = new StoryStore(root);
  seedStory(store, storyId);
  return { root, store, headHash, materialHash };
}

function seedStory(store: StoryStore, storyId: string): void {
  const now = pythonCanonicalTimestamp();
  const story: StoryInfo = {
    storyId,
    name: 'authority-live-receipt-ref-gate',
    title: 'Authority live receipt-ref gate smoke',
    description: 'Temporary story proving deployed staging proof fetch, receipt-ref write, and TEST/DONE gate consumption.',
    type: 'feature',
    phase: 'TEST',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'TEST', action: 'create', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-live-receipt-ref',
      title: 'Verify deployed Authority receipt-ref gate consumption',
      status: 'done',
      startTime: now,
      endTime: now,
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
}

function handlerContext(root: string, store: StoryStore): HandlerContext {
  return {
    root,
    store,
    scanRoot: join(root, 'packages', 'main'),
    authoritySettings: { mode: 'enforce', timeoutMS: 10_000 },
  };
}

async function buildContext(env: Env, repo: LiveContext['repo']): Promise<LiveContext | null> {
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
  assert.equal(policy.data.productionEnforceAuthority, true, 'staging policy must enforce production authority');
  assert.equal(policy.data.serverKey.ephemeral, false, 'staging server key must be non-ephemeral');
  assert.equal(policy.data.serverKey.productionInert, false, 'staging server key must not be production-inert');
  assert.ok(policy.data.commandCatalogDigest, 'live server policy must expose commandCatalogDigest');
  assert.ok(policy.data.evidenceSchemaDigest, 'live server policy must expose evidenceSchemaDigest');

  const suffix = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
  return {
    liveURL,
    expectedServerKeyHex,
    serverKeyId: policy.data.serverKey.keyId,
    commandCatalogDigest: policy.data.commandCatalogDigest,
    evidenceSchemaDigest: policy.data.evidenceSchemaDigest,
    customerApiKey,
    ...(bootstrapToken ? { bootstrapToken } : {}),
    projectId: envValue(env, 'PROJECT_ID') ?? `project-live-receipt-ref-${suffix}`,
    storyId: `B-live-receipt-ref-${suffix}`,
    sessionId: `session-live-receipt-ref-${suffix}`,
    runnerId: `runner-live-receipt-ref-${suffix}`,
    deviceId: `device-live-receipt-ref-${suffix}`,
    mainActorId: `main-live-receipt-ref-${suffix}`,
    reviewerActorId: `reviewer-live-receipt-ref-${suffix}`,
    verifierActorId: `verifier-live-receipt-ref-${suffix}`,
    secondVerifierActorId: `verifier2-live-receipt-ref-${suffix}`,
    runnerActorId: `runner-actor-live-receipt-ref-${suffix}`,
    extraEvidenceRefs: envStringList(env, 'LIVE_EXTRA_EVIDENCE_REFS'),
    repo,
    main: generateEd25519KeyPair(),
    reviewer: generateEd25519KeyPair(),
    verifier: generateEd25519KeyPair(),
    secondVerifier: generateEd25519KeyPair(),
    runner: generateEd25519KeyPair(),
  };
}

function buildPhaseGateRequest(ctx: LiveContext, targetPhase: 'TEST' | 'DONE'): GateEvaluateRequestContract {
  return buildGateEvaluateRequest({
    projectId: ctx.projectId,
    storyId: ctx.storyId,
    targetPhase,
    until: targetPhase,
    authorityRunId: ctx.sessionId,
    requestedByRunnerId: ctx.runnerId,
    repo: ctx.repo,
    materialHash: ctx.repo.materialHash,
    evidenceRefs: [
      `${ctx.storyId}:seed:l2-producer`,
      `${ctx.storyId}:seed:l2-verifier:codex`,
      `${ctx.storyId}:seed:l2-verifier:antigravity`,
      `${ctx.storyId}:delivery`,
    ],
  });
}

function signedTargetGateRequest(ctx: LiveContext, request: GateEvaluateRequestContract): Record<string, unknown> {
  const timestamp = pythonCanonicalTimestamp();
  const lowerPhase = request.targetPhase.toLowerCase();
  return signHexEnvelope({
    actorId: ctx.mainActorId,
    role: 'main',
    nonce: `${request.gateInputDigest}:gate-evaluate`,
    timestamp,
    decision: {
      decisionId: request.gateInputDigest,
      projectId: request.projectId,
      storyId: request.storyId,
      targetPhase: lowerPhase,
      repo: ctx.repo,
      policyMode: 'balanced',
      authorityMode: 'enforce',
      evidenceHashes: request.evidenceRefs ?? [],
      requestedByActorId: ctx.mainActorId,
      requestedAt: timestamp,
    },
  }, ctx.main);
}

type MinimalRun = {
  runId: string;
};

type VerifierAssignment = {
  jobId: string;
  runId: string;
  specDigest: string;
};

type ReceiptRefEvidenceContracts = ReturnType<typeof receiptRefEvidenceContracts>;

async function createCompletedProducerRun(ctx: LiveContext): Promise<MinimalRun> {
  const runId = `run_${ctx.storyId.replace(/[^a-zA-Z0-9]/g, '_')}_producer`;
  const raw = await postJson(ctx, '/v1/runs', signHexEnvelope({
    actorId: ctx.mainActorId,
    role: 'main',
    nonce: `${runId}:create`,
    timestamp: pythonCanonicalTimestamp(),
    request: {
      projectId: ctx.projectId,
      actorId: ctx.mainActorId,
      role: 'main',
      provider: 'lattice-receipt-ref-producer',
      storyId: ctx.storyId,
      runId,
      runType: 'generic',
      input: { purpose: 'seed minimum gate evidence for receipt-ref consumption smoke' },
      repo: ctx.repo,
      commandPreview: ['lattice', 'authority', 'receipt-ref-gate-smoke', 'producer'],
      idempotencyKey: `${ctx.storyId}:receipt-ref-producer-run`,
      stream: false,
      autoComplete: true,
      mutatesStory: false,
      metadata: {
        model: 'lattice-receipt-ref-producer',
        vendor: 'lattice-receipt-ref',
        source: 'authority-live-receipt-ref-gate-smoke',
      },
    },
  }, ctx.main));
  const runIdFromResponse = stringField(objectField(raw, 'run'), 'runId');
  assert.equal(runIdFromResponse, runId, `producer run create response must include runId: ${JSON.stringify(raw)}`);
  return { runId };
}

function verifierMetadata(provider: 'codex' | 'antigravity'): { model: string; vendor: string } {
  return provider === 'codex'
    ? { model: 'lattice-receipt-ref-verifier-a', vendor: 'lattice-receipt-ref-a' }
    : { model: 'lattice-receipt-ref-verifier-b', vendor: 'lattice-receipt-ref-b' };
}

async function createVerifierAssignment(input: {
  ctx: LiveContext;
  provider: 'codex' | 'antigravity';
  actorId: string;
  contracts: ReceiptRefEvidenceContracts;
  command: string[];
  commandClass: string;
}): Promise<VerifierAssignment> {
  const metadata = verifierMetadata(input.provider);
  const raw = await postJson(input.ctx, '/v1/jobs', signHexEnvelope({
    actorId: input.ctx.mainActorId,
    role: 'main',
    nonce: `${input.ctx.storyId}:receipt-ref-verifier-assignment:${input.provider}`,
    timestamp: pythonCanonicalTimestamp(),
    request: {
      projectId: input.ctx.projectId,
      provider: input.provider,
      role: 'tester',
      promptHash: canonicalDigest({
        storyId: input.ctx.storyId,
        seed: `receipt-ref-${input.provider}-verifier-prompt`,
      }),
      storyId: input.ctx.storyId,
      cwdPolicy: 'read-only',
      permissions: { canWrite: false, canRunShell: true, canNetwork: false, requiresApproval: false, allowedCommands: [] },
      repo: input.ctx.repo,
      mutatesStory: false,
      plannedSteps: [],
      expectedArtifacts: ['verification-transcript'],
      envPolicy: {},
      commandPreview: input.command,
      producerRunId: input.contracts.producerRunId,
      verificationTargets: [input.contracts.target],
      verificationPlan: input.contracts.plan,
      verificationContextPack: input.contracts.contextPack,
      verificationContextPackDigest: input.contracts.contextPackDigest,
      requiredTrustLevel: 2,
      verifierActorId: input.actorId,
      verifierRole: 'verifier',
      idempotencyKey: `${input.ctx.storyId}:receipt-ref-verifier:${input.provider}`,
      expiresAt: pythonCanonicalTimestamp(new Date(Date.now() + 24 * 60 * 60 * 1000)),
      metadata: {
        ...metadata,
        source: 'authority-live-receipt-ref-gate-smoke',
        purpose: 'minimum server-issued verifier assignment for gate receipt minting',
      },
    },
  }, input.ctx.main));
  const job = objectField(raw, 'job');
  const run = objectField(raw, 'run');
  const jobId = stringField(job, 'jobId');
  const runId = stringField(run, 'runId') ?? stringField(job, 'runId');
  const spec = objectField(job, 'spec');
  assert.ok(jobId, `verifier job response must include jobId: ${JSON.stringify(raw)}`);
  assert.ok(runId, `verifier job response must include runId: ${JSON.stringify(raw)}`);
  assert.ok(spec, `verifier job response must include spec: ${JSON.stringify(raw)}`);
  return { jobId, runId, specDigest: pythonModelDigest(spec) };
}

async function completeRun(
  ctx: Pick<LiveContext, 'liveURL' | 'customerApiKey' | 'bootstrapToken'>,
  runId: string,
  actorId: string,
  role: string,
  keyPair: Ed25519KeyPair,
  transcriptHash: string,
): Promise<void> {
  await postJson(ctx, `/v1/runs/${encodeURIComponent(runId)}/events`, signHexEnvelope({
    actorId,
    role,
    nonce: `${runId}:response.completed:${Date.now()}`,
    timestamp: pythonCanonicalTimestamp(),
    runId,
    event: {
      type: 'response.completed',
      payload: { outputText: 'completed', exitCode: 0, transcriptHash },
    },
  }, keyPair));
}

function receiptRefEvidenceContracts(ctx: LiveContext, producerRunId: string): {
  producerRunId: string;
  command: string[];
  commandDigest: string;
  transcriptHash: string;
  negativeTranscriptHash: string;
  secondCommand: string[];
  secondCommandDigest: string;
  secondTranscriptHash: string;
  secondNegativeTranscriptHash: string;
  diffHash: string;
  artifactRef: string;
  artifactDigest: string;
  fileRef: string;
  hunkRef: string;
  checklistId: string;
  intentRef: string;
  claimId: string;
  negativeControlId: string;
  oracleId: string;
  secondClaimId: string;
  secondNegativeControlId: string;
  secondOracleId: string;
  coveredRefs: string[];
  target: Record<string, unknown>;
  targetDigest: string;
  plan: Record<string, unknown>;
  planDigest: string;
  contextPack: Record<string, unknown>;
  contextPackDigest: string;
} {
  const command = ['lattice', 'validate', '--receipt-ref-gate-smoke'];
  const commandDigest = canonicalDigest({ command });
  const transcriptHash = canonicalDigest({ storyId: ctx.storyId, seed: 'receipt-ref-l2-verifier-transcript' });
  const negativeTranscriptHash = canonicalDigest({ storyId: ctx.storyId, seed: 'receipt-ref-negative-control-transcript' });
  const secondCommand = ['lattice', 'validate', '--receipt-ref-gate-smoke', '--full'];
  const secondCommandDigest = canonicalDigest({ command: secondCommand });
  const secondTranscriptHash = canonicalDigest({ storyId: ctx.storyId, seed: 'receipt-ref-second-l2-verifier-transcript' });
  const secondNegativeTranscriptHash = canonicalDigest({ storyId: ctx.storyId, seed: 'receipt-ref-second-negative-control-transcript' });
  const diffHash = canonicalDigest({ storyId: ctx.storyId, artifact: 'receipt-ref-seed-diff' });
  const artifactRef = 'artifact:authority-receipt-ref-gate-smoke-summary';
  const artifactDigest = canonicalDigest({ storyId: ctx.storyId, artifact: artifactRef });
  const fileRef = 'packages/main/src/tasks/authority-live-receipt-ref-gate-smoke.ts';
  const hunkRef = `${fileRef}:hunk-receipt-ref-gate-consumption`;
  const checklistId = 'CHK-live-receipt-ref';
  const intentRef = `${checklistId}:happy:0`;
  const claimId = `${ctx.storyId}:claim:receipt-ref-gate-consumption`;
  const negativeControlId = `${ctx.storyId}:negative-control:receipt-ref-required`;
  const oracleId = `${ctx.storyId}:oracle:receipt-ref-gate-consumption`;
  const secondClaimId = `${ctx.storyId}:claim:receipt-ref-done-consumption`;
  const secondNegativeControlId = `${ctx.storyId}:negative-control:receipt-ref-done-required`;
  const secondOracleId = `${ctx.storyId}:oracle:receipt-ref-done-consumption`;
  const coveredRefs = [
    `checklist:${checklistId}`,
    `intent:${intentRef}`,
    artifactRef,
    `file:${fileRef}`,
    `hunk:${hunkRef}`,
  ];
  const target = {
    targetId: `${ctx.storyId}:target:receipt-ref-gate-consumption`,
    producerRunId,
    diffHash,
    artifactRefs: [artifactRef],
    checklistItemIds: [checklistId],
    testIntentRefs: [intentRef],
    requiredCommands: [
      { command, commandDigest, commandClass: 'unit-tests', required: true },
      { command: secondCommand, commandDigest: secondCommandDigest, commandClass: 'integration-tests', required: true },
    ],
    acceptanceCriteria: ['Receipt-ref gate smoke verifies proof fetch, receipt-ref write, TEST/DONE consumption, and missing-ref fail-closed behavior.'],
    requiredRefs: [],
    requiredFiles: [fileRef],
    requiredHunks: [hunkRef],
    metadata: { source: 'authority-live-receipt-ref-gate-smoke' },
  };
  const targetDigest = pythonModelDigest(target);
  const plan = {
    planId: `${ctx.storyId}:plan:receipt-ref-gate-consumption`,
    targetIds: [target.targetId],
    items: [{
      itemId: `${ctx.storyId}:plan-item:receipt-ref-gate-consumption`,
      requiredRefs: [`checklist:${checklistId}`, artifactRef],
      requiredFiles: [fileRef],
      requiredHunks: [hunkRef],
      requiredCommandClasses: ['unit-tests', 'integration-tests'],
      testIntentRefs: [intentRef],
      acceptanceCriteria: ['Verifier evidence binds receipt-ref gate behavior to target refs and no unresolved limitations.'],
      requiresNegativeControl: false,
      minQualityScore: 70,
    }],
    requiredCommandClasses: ['unit-tests', 'integration-tests'],
    acceptanceCriteria: ['Verify the deployed Authority receipt-ref gate consumption path.'],
    minQualityScore: 70,
    requiresNegativeControl: false,
    metadata: { source: 'authority-live-receipt-ref-gate-smoke' },
  };
  const planDigest = pythonModelDigest(plan);
  const contextPack = {
    packId: `${ctx.storyId}:pack:receipt-ref-gate-consumption`,
    producerRunId,
    storyId: ctx.storyId,
    baseRef: 'main',
    headRef: 'HEAD',
    repo: ctx.repo,
    diffHash,
    changedFiles: [fileRef],
    changedHunks: [{
      hunkRef,
      file: fileRef,
      newStart: 1,
      newLines: 1,
      patchHash: canonicalDigest({ storyId: ctx.storyId, hunkRef }),
      riskTags: ['authority-receipt-ref'],
      required: true,
      metadata: {},
    }],
    changedSymbols: [],
    impactedFiles: [],
    impactedSymbols: [],
    dependencyEdges: [],
    sourceSnippets: [],
    checklistItemIds: [checklistId],
    testIntentRefs: [intentRef],
    acceptanceCriteria: ['The seed evidence must satisfy the remote anti-hallucination policy before gate receipt minting.'],
    requiredCommands: [
      { command, commandDigest, commandClass: 'unit-tests', required: true },
      { command: secondCommand, commandDigest: secondCommandDigest, commandClass: 'integration-tests', required: true },
    ],
    oracleRefs: [],
    riskTags: ['authority-receipt-ref'],
    requiredRefs: [artifactRef],
    excludedPaths: [],
    limitations: [],
    estimatedTokens: 128,
    truncated: false,
    metadata: { source: 'authority-live-receipt-ref-gate-smoke' },
  };
  const contextPackDigest = pythonModelDigest(contextPack);
  return {
    producerRunId,
    command,
    commandDigest,
    transcriptHash,
    negativeTranscriptHash,
    secondCommand,
    secondCommandDigest,
    secondTranscriptHash,
    secondNegativeTranscriptHash,
    diffHash,
    artifactRef,
    artifactDigest,
    fileRef,
    hunkRef,
    checklistId,
    intentRef,
    claimId,
    negativeControlId,
    oracleId,
    secondClaimId,
    secondNegativeControlId,
    secondOracleId,
    coveredRefs,
    target,
    targetDigest,
    plan,
    planDigest,
    contextPack,
    contextPackDigest,
  };
}

async function postL2VerifierEvidence(
  ctx: LiveContext,
  contracts: ReceiptRefEvidenceContracts,
  verifier: VerifierAssignment,
  input: {
    evidenceId: string;
    actorId: string;
    keyPair: Ed25519KeyPair;
    provider: 'codex' | 'antigravity';
    model: string;
    vendor: string;
    command: string[];
    commandClass: string;
    commandDigest: string;
    transcriptHash: string;
    negativeTranscriptHash: string;
    claimId: string;
    negativeControlId: string;
    oracleId: string;
    note: string;
    nonce: string;
  },
): Promise<void> {
  await postJson(ctx, '/v1/evidence', signHexEnvelope({
    evidenceId: input.evidenceId,
    projectId: ctx.projectId,
    storyId: ctx.storyId,
    producerActorId: input.actorId,
    role: 'verifier',
    kind: 'logic_test',
    trustLevel: 2,
    repo: ctx.repo,
    itemId: contracts.checklistId,
    intentRef: contracts.intentRef,
    command: input.command.join(' '),
    commandClass: input.commandClass,
    exitCode: 0,
    producerRunId: contracts.producerRunId,
    verifierRunId: verifier.runId,
    provider: input.provider,
    model: input.model,
    vendor: input.vendor,
    verificationTargetId: String(contracts.target.targetId),
    verificationTargetDigest: contracts.targetDigest,
    verificationContextPackId: String(contracts.contextPack.packId),
    verificationContextPackDigest: contracts.contextPackDigest,
    verifierAssignmentId: verifier.jobId,
    verifierAssignmentDigest: verifier.specDigest,
    verificationPlanId: String(contracts.plan.planId),
    verificationPlanDigest: contracts.planDigest,
    transcriptHash: input.transcriptHash,
    commandDigest: input.commandDigest,
    diffHash: contracts.diffHash,
    coveredRefs: contracts.coveredRefs,
    uncoveredRefs: [],
    failedRefs: [],
    claims: [{
      claimId: input.claimId,
      result: 'pass',
      claimType: 'authority-receipt-ref-gate',
      riskLevel: 'medium',
      supportStatus: 'supported',
      coveredRefs: contracts.coveredRefs,
      failedRefs: [],
      testIntentRefs: [contracts.intentRef],
      inspectedFiles: [contracts.fileRef],
      inspectedHunks: [contracts.hunkRef],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      sourceRefs: [contracts.fileRef],
      oracleRef: input.oracleId,
      rationale: 'Remote Authority minted a gate_decision receipt only after minimum signed gate evidence was accepted.',
    }],
    coverage: contracts.coveredRefs.map(ref => ({
      ref,
      claimId: input.claimId,
      commandDigest: input.commandDigest,
      transcriptHash: input.transcriptHash,
    })),
    negativeControls: [{
      controlId: input.negativeControlId,
      coveredRefs: [contracts.intentRef],
      commandDigest: canonicalDigest({ command: [...input.command, '--negative-control'] }),
      transcriptHash: input.negativeTranscriptHash,
      expectedFailureObserved: true,
      note: 'The local gate rejects the transition when the verified receipt-ref is removed.',
    }],
    oracleSpecs: [{
      oracleId: input.oracleId,
      oracleType: 'expected-output',
      expectedOutcome: 'Remote Authority proof can be fetched, verified, written as a receipt-ref, and consumed by TEST/DONE gates.',
      coveredRefs: [contracts.intentRef],
      sourceRefs: [contracts.fileRef],
      commandDigest: input.commandDigest,
      strict: true,
    }],
    testAdequacyReport: {
      reportId: `${ctx.storyId}:adequacy:${input.provider}:${input.commandClass}`,
      coveredClaimIds: [input.claimId],
      changedHunkRefs: [contracts.hunkRef],
      coveredHunkRefs: [contracts.hunkRef],
      testCommandDigests: [input.commandDigest],
      negativeControlIds: [input.negativeControlId],
      mutationScore: 75,
      statementCoveragePercent: 100,
      branchCoveragePercent: 100,
      rationale: 'The receipt-ref smoke covers the deployed proof/verify/write/consume path and a missing-ref negative control.',
    },
    observedAssertions: ['receipt-ref gate smoke consumes verified gate_decision receipts'],
    artifactDigests: [contracts.artifactDigest],
    inspectedArtifacts: [contracts.artifactRef],
    inspectedFiles: [contracts.fileRef],
    inspectedHunks: [contracts.hunkRef],
    inspectedPackRefs: contracts.coveredRefs,
    note: input.note,
    clientName: 'lattice-cli',
    clientVersion: LIVE_E2E_CLIENT_VERSION,
    authorityMode: 'enforce',
    commandCatalogDigest: ctx.commandCatalogDigest,
    evidenceSchemaDigest: ctx.evidenceSchemaDigest,
    deviceId: ctx.deviceId,
    runnerId: ctx.runnerId,
    reviewedClaimIds: [],
    unresolvedLimitations: [],
    nonce: input.nonce,
    createdAt: pythonCanonicalTimestamp(),
  }, input.keyPair));
}

async function seedMinimalGateFacts(ctx: LiveContext): Promise<void> {
  await postJson(ctx, '/v1/commands', signedCommand(ctx, 'story_create'));

  const reviewRunId = `RR-receipt-ref-${ctx.storyId}`;
  await postJson(ctx, '/v1/review-runs', signHexEnvelope({
    actorId: ctx.reviewerActorId,
    role: 'reviewer',
    nonce: `${reviewRunId}:start`,
    timestamp: pythonCanonicalTimestamp(),
    reviewRunId,
    projectId: ctx.projectId,
    storyId: ctx.storyId,
    repo: ctx.repo,
    lane: 'lattice-receipt-ref-gate-review',
    promptHash: canonicalDigest({ storyId: ctx.storyId, kind: 'receipt-ref-review-run' }),
    model: 'receipt-ref-gate-smoke',
    vendor: 'lattice',
  }, ctx.reviewer));

  await postJson(ctx, '/v1/review-passes', signHexEnvelope({
    actorId: ctx.reviewerActorId,
    role: 'reviewer',
    nonce: `${reviewRunId}:pass`,
    timestamp: pythonCanonicalTimestamp(),
    reviewPassId: `${reviewRunId}:pass`,
    projectId: ctx.projectId,
    storyId: ctx.storyId,
    reviewRunId,
    repo: ctx.repo,
    note: 'Receipt-ref smoke seed: reviewer pass exists so TEST and DONE gate receipts can be minted by Authority.',
    model: 'receipt-ref-gate-smoke',
    vendor: 'lattice',
  }, ctx.reviewer));

  const producer = await createCompletedProducerRun(ctx);
  const contracts = receiptRefEvidenceContracts(ctx, producer.runId);

  const firstMetadata = verifierMetadata('codex');
  const firstVerifier = await createVerifierAssignment({
    ctx,
    provider: 'codex',
    actorId: ctx.verifierActorId,
    contracts,
    command: contracts.command,
    commandClass: 'unit-tests',
  });
  await completeRun(ctx, firstVerifier.runId, ctx.verifierActorId, 'verifier', ctx.verifier, contracts.transcriptHash);

  const secondMetadata = verifierMetadata('antigravity');
  const secondVerifier = await createVerifierAssignment({
    ctx,
    provider: 'antigravity',
    actorId: ctx.secondVerifierActorId,
    contracts,
    command: contracts.secondCommand,
    commandClass: 'integration-tests',
  });
  await completeRun(ctx, secondVerifier.runId, ctx.secondVerifierActorId, 'verifier', ctx.secondVerifier, contracts.secondTranscriptHash);

  await postL2VerifierEvidence(ctx, contracts, firstVerifier, {
    evidenceId: `${ctx.storyId}:seed:l2-verifier:codex`,
    actorId: ctx.verifierActorId,
    keyPair: ctx.verifier,
    provider: 'codex',
    model: firstMetadata.model,
    vendor: firstMetadata.vendor,
    command: contracts.command,
    commandClass: 'unit-tests',
    commandDigest: contracts.commandDigest,
    transcriptHash: contracts.transcriptHash,
    negativeTranscriptHash: contracts.negativeTranscriptHash,
    claimId: contracts.claimId,
    negativeControlId: contracts.negativeControlId,
    oracleId: contracts.oracleId,
    note: 'Receipt-ref smoke seed: first independent L2 verifier evidence for Authority gate receipt minting.',
    nonce: `${ctx.storyId}:seed-receipt-ref-evidence:codex`,
  });

  await postL2VerifierEvidence(ctx, contracts, secondVerifier, {
    evidenceId: `${ctx.storyId}:seed:l2-verifier:antigravity`,
    actorId: ctx.secondVerifierActorId,
    keyPair: ctx.secondVerifier,
    provider: 'antigravity',
    model: secondMetadata.model,
    vendor: secondMetadata.vendor,
    command: contracts.secondCommand,
    commandClass: 'integration-tests',
    commandDigest: contracts.secondCommandDigest,
    transcriptHash: contracts.secondTranscriptHash,
    negativeTranscriptHash: contracts.secondNegativeTranscriptHash,
    claimId: contracts.secondClaimId,
    negativeControlId: contracts.secondNegativeControlId,
    oracleId: contracts.secondOracleId,
    note: 'Receipt-ref smoke seed: second independent L2 verifier evidence for Authority gate receipt minting.',
    nonce: `${ctx.storyId}:seed-receipt-ref-evidence:antigravity`,
  });

  await postJson(ctx, '/v1/checks', signHexEnvelope({
    actorId: ctx.verifierActorId,
    role: 'verifier',
    nonce: `${ctx.storyId}:delivery`,
    timestamp: pythonCanonicalTimestamp(),
    checkId: `${ctx.storyId}:delivery`,
    projectId: ctx.projectId,
    storyId: ctx.storyId,
    checkKind: 'delivery',
    repo: ctx.repo,
    payload: {
      docsPromises: [],
      realMachineTests: [{ featureId: 'CHK-live-receipt-ref', transcript: 'receipt-ref gate smoke is runnable against deployed staging' }],
      closingSelfCheck: {
        hasRealMachineTest: true,
        hasEdgeCaseCoverage: true,
        hasUnresolvedTodos: false,
        summary: 'delivery evidence is complete for the receipt-ref gate consumption smoke',
      },
    },
  }, ctx.verifier));
}

function objectField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === 'object' && !Array.isArray(field)
    ? field as Record<string, unknown>
    : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.trim() ? field.trim() : undefined;
}

function extractReceiptId(value: unknown): string | undefined {
  return stringField(value, 'receiptId')
    ?? stringField(objectField(value, 'receipt'), 'receiptId')
    ?? stringField(objectField(value, 'decision'), 'receiptId')
    ?? stringField(objectField(objectField(value, 'decision'), 'receipt'), 'receiptId');
}

function extractVerdict(value: unknown): string | undefined {
  return stringField(value, 'decision')
    ?? stringField(value, 'verdict')
    ?? stringField(objectField(value, 'decision'), 'verdict');
}

async function requestGateReceiptId(ctx: LiveContext, targetPhase: 'TEST' | 'DONE'): Promise<string> {
  const request = buildPhaseGateRequest(ctx, targetPhase);
  const raw = await postJson(ctx, '/v1/gates/evaluate', signedTargetGateRequest(ctx, request));
  const verdict = extractVerdict(raw);
  assert.ok(
    verdict === 'approve' || verdict === 'pass',
    `${targetPhase} gate decision must pass/approve: ${JSON.stringify(raw)}`,
  );
  const receiptId = extractReceiptId(raw);
  assert.ok(receiptId, `${targetPhase} gate response must expose receiptId: ${JSON.stringify(raw)}`);
  return receiptId;
}

async function verifyReceiptRef(input: {
  ctx: LiveContext;
  local: HandlerContext;
  targetPhase: 'TEST' | 'DONE';
  receiptId: string;
  productionAuthorityKeyDigest: string;
}): Promise<void> {
  const proofPath = `/v1/receipts/${encodeURIComponent(input.receiptId)}/proof`;
  const result = await runAuthorityReceiptVerify(input.local, {
    storyId: input.ctx.storyId,
    phase: input.targetPhase,
    headHash: input.ctx.repo.headHash,
    materialHash: input.ctx.repo.materialHash,
    authorityURL: input.ctx.liveURL,
    proofPath,
    productionAuthorityKeyDigests: [input.productionAuthorityKeyDigest],
    now: new Date().toISOString(),
  });
  if (!result.ok) {
    const proof = await new AuthorityClient(input.ctx.liveURL).fetchGateReceiptProof(proofPath);
    const diagnostic = proof.ok && proof.data
      ? {
          failureReason: result.failureReason,
          receiptInputDigest: proof.data.receipt.inputDigest,
          computedInputDigest: `sha256:${gateDecisionInputDigest(proof.data.inputPayload)}`,
          inputPayload: proof.data.inputPayload,
        }
      : { failureReason: result.failureReason, proofFetch: proof.kind, message: proof.message };
    assert.fail(`${input.targetPhase} receipt verification must pass: ${JSON.stringify(diagnostic)}`);
  }
  assert.equal(result.written, true, `${input.targetPhase} receipt verification must write receipt-ref`);
  assert.equal(result.receiptVerified, true, `${input.targetPhase} receipt must be verified`);
  assert.equal(result.classification, 'production-gate-decision');
  assert.equal(result.ref?.storyId, input.ctx.storyId);
  assert.equal(result.ref?.targetPhase, input.targetPhase);
  assert.equal(result.ref?.headHash, input.ctx.repo.headHash);
  assert.equal(result.ref?.materialHash, input.ctx.repo.materialHash);
}

async function consumeTestGate(local: HandlerContext, storyId: string, receiptId: string): Promise<void> {
  const result = JSON.parse(String(await createVerifierHandlers(local).validate({ story: storyId, json: true, noSync: true })));
  assert.equal(result.allPass, true, `TEST validate must pass: ${JSON.stringify(result)}`);
  assert.equal(result.authorityGateConsumption?.strongEvidenceConsumed, true, 'TEST gate must consume strong evidence');
  assert.equal(result.authorityGateConsumption?.receiptId, receiptId, 'TEST gate must consume the verified receipt ref');
}

function consumeDoneGate(local: HandlerContext, storyId: string, receiptId: string): void {
  const report = runAuthorityReceiptTransitionGate(local, storyId, 'DONE');
  assert.match(report, /Authority DONE gate: PASS/);
  assert.match(report, new RegExp(`receiptId=${receiptId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
}

async function main(): Promise<void> {
  const env = process.env as Env;
  const livePublicKey = envValue(env, 'LIVE_PUBLIC_KEY') ?? envValue(env, 'SERVER_PUBLIC_KEY');
  if (!livePublicKey) {
    skip('set LATTICE_AUTHORITY_LIVE_PUBLIC_KEY');
    return;
  }
  const expectedServerKeyHex = normalizeKeyToHex(livePublicKey);
  const productionAuthorityKeyDigest = publicKeyDigestFromHex(expectedServerKeyHex);

  let root: string | undefined;
  const preContext = await buildContext(env, { headHash: 'pending', materialHash: 'pending', dirty: false });
  if (!preContext) return;
  const localRoot = makeLocalRoot(preContext.storyId);
  root = localRoot.root;
  const ctx: LiveContext = {
    ...preContext,
    repo: {
      headHash: localRoot.headHash,
      materialHash: localRoot.materialHash,
      dirty: false,
    },
  };
  const local = handlerContext(localRoot.root, localRoot.store);

  try {
    await registerActorKey(ctx, ctx.mainActorId, 'main', ctx.main, { deviceId: ctx.deviceId });
    await registerActorKey(ctx, ctx.reviewerActorId, 'reviewer', ctx.reviewer, { deviceId: ctx.deviceId });
    await registerActorKey(ctx, ctx.verifierActorId, 'verifier', ctx.verifier, { runnerId: ctx.runnerId });
    await registerActorKey(ctx, ctx.secondVerifierActorId, 'verifier', ctx.secondVerifier, { runnerId: ctx.runnerId });
    await registerActorKey(ctx, ctx.runnerActorId, 'runner', ctx.runner, { runnerId: ctx.runnerId });
    await registerAndHeartbeatRunner(ctx);
    await seedMinimalGateFacts(ctx);

    const testReceiptId = await requestGateReceiptId(ctx, 'TEST');
    const doneReceiptId = await requestGateReceiptId(ctx, 'DONE');

    await verifyReceiptRef({
      ctx,
      local,
      targetPhase: 'TEST',
      receiptId: testReceiptId,
      productionAuthorityKeyDigest,
    });
    await consumeTestGate(local, ctx.storyId, testReceiptId);

    await verifyReceiptRef({
      ctx,
      local,
      targetPhase: 'DONE',
      receiptId: doneReceiptId,
      productionAuthorityKeyDigest,
    });
    consumeDoneGate(local, ctx.storyId, doneReceiptId);

    localRoot.store.writeAuthorityReceiptRefs(ctx.storyId, {
      schemaVersion: 'lattice.authority_receipt_refs.v1',
      storyId: ctx.storyId,
      updatedAt: new Date().toISOString(),
      refs: [],
    });
    assert.throws(
      () => runAuthorityReceiptTransitionGate(local, ctx.storyId, 'DONE'),
      /authority_receipt_missing/,
      'negative control must fail closed when receipt-ref is removed',
    );

    console.log(PASS_LINE);
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
