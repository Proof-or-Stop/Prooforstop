#!/usr/bin/env node
//
// authority-live-python-e2e-smoke
//
// Live E2E proving a real queued Python Lattice Authority job can be created,
// claimed by the live runner loop, executed through typed plannedSteps[],
// evidence/gate wired to the server, and finalized without a dangling lease.
//
// Required live env (otherwise SKIP, exit 0):
//   LATTICE_AUTHORITY_LIVE_URL         or LATTICE_AUTHORITY_URL
//   LATTICE_AUTHORITY_LIVE_PUBLIC_KEY  server Ed25519 public key (hex/base64)
//   LATTICE_AUTHORITY_CUSTOMER_API_KEY real customer API key for mutating calls
//   LATTICE_AUTHORITY_BOOTSTRAP_TOKEN  required when the server runs in production mode
//
// This is intentionally NOT a fullAuthorityDone test. Current production
// semantics still require final multi-host certification before fullAuthorityDone.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalDigest, generateEd25519KeyPair, signCanonical, stripSignature } from '../core/authority-signing.js';
import { AuthorityClient, submitAuthorityJobFromPlan } from '../core/authority-client.js';
import { executeAutopilotLive } from '../core/authority-job-loop-live.js';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import type { Ed25519KeyPair } from '../core/authority-signing.js';
import type { JobPlan, PlannedStep } from '../core/planner.js';
import type { StoryInfo } from '../core/types.js';

const PASS_LINE =
  'PASS authority live Python E2E smoke: queued job created, claimed, evidence uploaded, gate receipt verified, authorityDone=true, lease released pending multi-host';
export const LIVE_E2E_CLIENT_VERSION = '0.3.8';

export type Env = Record<string, string | undefined>;

export interface LiveContext {
  liveURL: string;
  expectedServerKeyHex: string;
  serverKeyId: string;
  commandCatalogDigest: string;
  evidenceSchemaDigest: string;
  customerApiKey: string;
  bootstrapToken?: string;
  projectId: string;
  storyId: string;
  sessionId: string;
  runnerId: string;
  deviceId: string;
  mainActorId: string;
  reviewerActorId: string;
  verifierActorId: string;
  secondVerifierActorId: string;
  runnerActorId: string;
  extraEvidenceRefs: string[];
  repo: { headHash: string; materialHash: string; dirty: false };
  main: Ed25519KeyPair;
  reviewer: Ed25519KeyPair;
  verifier: Ed25519KeyPair;
  secondVerifier: Ed25519KeyPair;
  runner: Ed25519KeyPair;
}

export function envValue(env: Env, suffix: string): string | undefined {
  const canonical = env[`LATTICE_AUTHORITY_${suffix}`];
  if (typeof canonical === 'string' && canonical.trim()) return canonical.trim();
  const legacy = env[`LATTICE_AUTHORITY_${suffix}`];
  return typeof legacy === 'string' && legacy.trim() ? legacy.trim() : undefined;
}

export function envStringList(env: Env, suffix: string): string[] {
  const raw = envValue(env, suffix);
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
    } catch {
      return [];
    }
  }
  return trimmed.split(',').map(part => part.trim()).filter(Boolean);
}

export function normalizeKeyToHex(value: string): string {
  return /^[0-9a-fA-F]{64}$/.test(value)
    ? value.toLowerCase()
    : Buffer.from(value, 'base64').toString('hex');
}

export function publicKeyHex(keyPair: Ed25519KeyPair): string {
  return Buffer.from(keyPair.publicKey, 'base64').toString('hex');
}

export function pythonCanonicalTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.000Z$/, 'Z').replace(/\.(\d{3})Z$/, '.$1000Z');
}

export function signHexEnvelope<T extends Record<string, unknown>>(
  envelope: T,
  keyPair: Ed25519KeyPair,
): T & { signature: string } {
  const signature = Buffer.from(signCanonical(stripSignature(envelope), keyPair.privateKey), 'base64').toString('hex');
  return { ...envelope, signature };
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

export function skip(reason: string): void {
  console.log(`authority live Python E2E smoke SKIPPED: ${reason}`);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function postJson(
  ctx: Pick<LiveContext, 'liveURL' | 'customerApiKey' | 'bootstrapToken'>,
  path: string,
  body: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ctx.customerApiKey}`,
  };
  if (ctx.bootstrapToken) headers['X-Lattice-Bootstrap-Token'] = ctx.bootstrapToken;
  const response = await fetch(`${ctx.liveURL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const parsed = await readJson(response);
  if (!response.ok) {
    throw new Error(`POST ${path} failed (${response.status}): ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

export async function registerActorKey(
  ctx: Pick<LiveContext, 'liveURL' | 'customerApiKey' | 'bootstrapToken'>,
  actorId: string,
  role: string,
  keyPair: Ed25519KeyPair,
  binding: { deviceId?: string; runnerId?: string } = {},
): Promise<void> {
  await postJson(ctx, `/v1/actors/${encodeURIComponent(actorId)}/keys`, {
    role,
    publicKeyHex: publicKeyHex(keyPair),
    keyId: 'default',
    status: 'active',
    ...binding,
  });
}

export function runnerCapability(): Record<string, unknown> {
  return runnerCapabilities()[0]!;
}

export function runnerCapabilities(): Record<string, unknown>[] {
  const base = {
    provider: 'codex',
    available: true,
    cliPathMode: 'unknown',
    version: LIVE_E2E_CLIENT_VERSION,
    loggedIn: true,
    supportsNonInteractive: true,
    supportsPty: false,
    supportsSandbox: false,
    supportsWorktreeIsolation: false,
    metadata: { source: 'authority-live-python-e2e-smoke' },
  };
  return [
    base,
    {
      ...base,
      provider: 'claude-code',
      metadata: { source: 'authority-live-python-e2e-smoke', purpose: 'producer-run-diversity' },
    },
    {
      ...base,
      provider: 'gemini',
      metadata: { source: 'authority-live-python-e2e-smoke', purpose: 'second-verifier-quorum' },
    },
  ];
}

export async function registerAndHeartbeatRunner(ctx: LiveContext): Promise<void> {
  const capabilities = runnerCapabilities();
  await postJson(ctx, '/v1/runners/register', signHexEnvelope({
    actorId: ctx.runnerActorId,
    role: 'runner',
    nonce: `${ctx.runnerId}:register`,
    timestamp: pythonCanonicalTimestamp(),
    request: {
      runnerId: ctx.runnerId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      capabilities,
      hostname: 'lattice-live-e2e-host',
      heartbeatTtlSeconds: 60,
      metadata: { source: 'authority-live-python-e2e-smoke' },
    },
  }, ctx.runner));
  await postJson(ctx, `/v1/runners/${encodeURIComponent(ctx.runnerId)}/heartbeat`, signHexEnvelope({
    actorId: ctx.runnerActorId,
    role: 'runner',
    nonce: `${ctx.runnerId}:heartbeat`,
    timestamp: pythonCanonicalTimestamp(),
    runnerId: ctx.runnerId,
    heartbeat: {
      sessionId: ctx.sessionId,
      capabilities,
      heartbeatTtlSeconds: 60,
      metadata: { source: 'authority-live-python-e2e-smoke' },
    },
  }, ctx.runner));
}

export function signedCommand(
  ctx: LiveContext,
  command: string,
  args: Record<string, unknown> = {},
): Record<string, unknown> {
  const timestamp = pythonCanonicalTimestamp();
  const commandId = `${command}:${ctx.storyId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  return signHexEnvelope({
    commandId,
    idempotencyKey: commandId,
    projectId: ctx.projectId,
    storyId: ctx.storyId,
    actorId: ctx.mainActorId,
    role: 'main',
    sessionId: ctx.sessionId,
    command,
    args,
    repo: ctx.repo,
    nonce: commandId,
    timestamp,
    clientVersion: LIVE_E2E_CLIENT_VERSION,
  }, ctx.main);
}

export function signedGateRequest(ctx: LiveContext, decisionId: string): Record<string, unknown> {
  const timestamp = pythonCanonicalTimestamp();
  return signHexEnvelope({
    actorId: ctx.mainActorId,
    role: 'main',
    nonce: `${decisionId}:gate`,
    timestamp,
    decision: {
      decisionId,
      projectId: ctx.projectId,
      storyId: ctx.storyId,
      targetPhase: 'done',
      repo: ctx.repo,
      policyMode: 'balanced',
      authorityMode: 'enforce',
      evidenceHashes: ctx.extraEvidenceRefs.map(ref => canonicalDigest({ ref })),
      requestedByActorId: ctx.mainActorId,
      requestedAt: timestamp,
    },
  }, ctx.main);
}

async function createLiveJob(
  ctx: LiveContext,
  label: string,
  request: Record<string, unknown>,
): Promise<LiveJobCreateResult> {
  let raw: unknown;
  try {
    raw = await postJson(ctx, '/v1/jobs', signHexEnvelope({
      actorId: ctx.mainActorId,
      role: 'main',
      nonce: `${ctx.storyId}:job-create:${String(request.role)}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      timestamp: pythonCanonicalTimestamp(),
      request,
    }, ctx.main));
  } catch (error) {
    throw new Error(`create ${label} job failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const response = raw as {
    job?: { jobId?: string; runId?: string; spec?: Record<string, unknown> };
    run?: { runId?: string };
  };
  const jobId = response.job?.jobId;
  const runId = response.run?.runId ?? response.job?.runId;
  const spec = response.job?.spec;
  assert.ok(jobId, `job create response must include job.jobId: ${JSON.stringify(response)}`);
  assert.ok(runId, `job create response must include run.runId: ${JSON.stringify(response)}`);
  assert.ok(spec, `job create response must include job.spec: ${JSON.stringify(response)}`);
  return { jobId, runId, spec, specDigest: pythonModelDigest(spec) };
}

type LiveJobCreateResult = {
  jobId: string;
  runId: string;
  spec: Record<string, unknown>;
  specDigest: string;
};

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

function liveEvidenceContracts(ctx: LiveContext, producerRunId: string): {
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
  const command = ['npm', '--prefix', 'packages/main', 'run', 'test:authority-live-python-e2e'];
  const commandDigest = canonicalDigest({ command });
  const transcriptHash = canonicalDigest({ storyId: ctx.storyId, seed: 'l2-verifier-transcript' });
  const negativeTranscriptHash = canonicalDigest({ storyId: ctx.storyId, seed: 'negative-control-transcript' });
  const secondCommand = ['npm', '--prefix', 'packages/main', 'run', 'test:authority-live-python-full-e2e'];
  const secondCommandDigest = canonicalDigest({ command: secondCommand });
  const secondTranscriptHash = canonicalDigest({ storyId: ctx.storyId, seed: 'second-l2-verifier-transcript' });
  const secondNegativeTranscriptHash = canonicalDigest({ storyId: ctx.storyId, seed: 'second-negative-control-transcript' });
  const diffHash = canonicalDigest({ storyId: ctx.storyId, artifact: 'producer-diff' });
  const artifactRef = 'artifact:authority-live-e2e-summary';
  const artifactDigest = canonicalDigest({ storyId: ctx.storyId, artifact: artifactRef });
  const fileRef = 'packages/main/src/tasks/authority-live-python-e2e-smoke.ts';
  const hunkRef = `${fileRef}:hunk-live-e2e-strong-evidence`;
  const checklistId = 'CHK-live-e2e';
  const intentRef = `${checklistId}:happy:0`;
  const claimId = `${ctx.storyId}:claim:authority-live-e2e`;
  const negativeControlId = `${ctx.storyId}:negative-control:run-binding`;
  const oracleId = `${ctx.storyId}:oracle:authority-live-e2e`;
  const secondClaimId = `${ctx.storyId}:claim:authority-live-full-e2e`;
  const secondNegativeControlId = `${ctx.storyId}:negative-control:full-e2e-quorum`;
  const secondOracleId = `${ctx.storyId}:oracle:authority-live-full-e2e`;
  const coveredRefs = [
    `checklist:${checklistId}`,
    `intent:${intentRef}`,
    artifactRef,
    `file:${fileRef}`,
    `hunk:${hunkRef}`,
  ];
  const target = {
    targetId: `${ctx.storyId}:target:authority-live-e2e`,
    producerRunId,
    diffHash,
    artifactRefs: [artifactRef],
    checklistItemIds: [checklistId],
    testIntentRefs: [intentRef],
    requiredCommands: [
      { command, commandDigest, commandClass: 'unit-tests', required: true },
      { command: secondCommand, commandDigest: secondCommandDigest, commandClass: 'integration-tests', required: true },
    ],
    acceptanceCriteria: ['The remote Authority accepts only run-bound and target-bound L2 verifier evidence.'],
    requiredRefs: [],
    requiredFiles: [fileRef],
    requiredHunks: [hunkRef],
    metadata: { source: 'authority-live-python-e2e-smoke' },
  };
  const targetDigest = pythonModelDigest(target);
  const plan = {
    planId: `${ctx.storyId}:plan:authority-live-e2e`,
    targetIds: [target.targetId],
    items: [{
      itemId: `${ctx.storyId}:plan-item:authority-live-e2e`,
      requiredRefs: [`checklist:${checklistId}`, artifactRef],
      requiredFiles: [fileRef],
      requiredHunks: [hunkRef],
      requiredCommandClasses: ['unit-tests', 'integration-tests'],
      testIntentRefs: [intentRef],
      acceptanceCriteria: ['Verifier evidence binds command output to target refs and no unresolved limitations.'],
      requiresNegativeControl: false,
      minQualityScore: 70,
    }],
    requiredCommandClasses: ['unit-tests', 'integration-tests'],
    acceptanceCriteria: ['Verify the signed live Authority E2E seed target.'],
    minQualityScore: 70,
    requiresNegativeControl: false,
    metadata: { source: 'authority-live-python-e2e-smoke' },
  };
  const planDigest = pythonModelDigest(plan);
  const contextPack = {
    packId: `${ctx.storyId}:pack:authority-live-e2e`,
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
      riskTags: ['authority-e2e'],
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
    acceptanceCriteria: ['The seed evidence must satisfy the remote anti-hallucination policy.'],
    requiredCommands: [
      { command, commandDigest, commandClass: 'unit-tests', required: true },
      { command: secondCommand, commandDigest: secondCommandDigest, commandClass: 'integration-tests', required: true },
    ],
    oracleRefs: [],
    riskTags: ['authority-e2e'],
    requiredRefs: [artifactRef],
    excludedPaths: [],
    limitations: [],
    estimatedTokens: 128,
    truncated: false,
    metadata: { source: 'authority-live-python-e2e-smoke' },
  };
  const contextPackDigest = pythonModelDigest(contextPack);
  return {
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

type LiveEvidenceContracts = ReturnType<typeof liveEvidenceContracts>;

async function postL2VerifierEvidence(
  ctx: LiveContext,
  contracts: LiveEvidenceContracts,
  producer: Pick<LiveJobCreateResult, 'runId'>,
  verifier: Pick<LiveJobCreateResult, 'jobId' | 'runId' | 'specDigest'>,
  input: {
    evidenceId: string;
    actorId: string;
    keyPair: Ed25519KeyPair;
    provider: string;
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
    producerRunId: producer.runId,
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
      claimType: 'authority-live-e2e',
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
      rationale: 'Remote Authority accepted only target-bound, run-bound L2 evidence.',
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
      note: 'The server rejects non-run-bound L2 evidence; this test covers that negative-control policy.',
    }],
    oracleSpecs: [{
      oracleId: input.oracleId,
      oracleType: 'expected-output',
      expectedOutcome: 'Remote Authority accepts the seed only when it is producer/verifier run-bound and target-bound.',
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
      rationale: 'The remote live smoke is a bounded protocol fixture; changed hunk coverage is explicit and complete.',
    },
    observedAssertions: ['server review/evidence/delivery seed enables DONE gate approval'],
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

export async function seedServerDoneFacts(ctx: LiveContext): Promise<void> {
  await postJson(ctx, '/v1/commands', signedCommand(ctx, 'story_create'));

  const reviewRunId = `RR-live-e2e-${ctx.storyId}`;
  await postJson(ctx, '/v1/review-runs', signHexEnvelope({
    actorId: ctx.reviewerActorId,
    role: 'reviewer',
    nonce: `${reviewRunId}:start`,
    timestamp: pythonCanonicalTimestamp(),
    reviewRunId,
    projectId: ctx.projectId,
    storyId: ctx.storyId,
    repo: ctx.repo,
    lane: 'lattice-live-e2e-review',
    promptHash: canonicalDigest({ storyId: ctx.storyId, kind: 'review-run' }),
    model: 'live-e2e-fixture',
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
    note: 'Live E2E seed: reviewer found no blocking issues for the bounded authority job loop test.',
    model: 'live-e2e-fixture',
    vendor: 'lattice',
  }, ctx.reviewer));

  const producer = await createLiveJob(ctx, 'producer', {
    projectId: ctx.projectId,
    provider: 'claude-code',
    role: 'implementer',
    promptHash: canonicalDigest({ storyId: ctx.storyId, seed: 'producer-job-prompt' }),
    storyId: ctx.storyId,
    cwdPolicy: 'same-worktree',
    permissions: { canWrite: true, canRunShell: true, canNetwork: false, requiresApproval: false, allowedCommands: [] },
    repo: ctx.repo,
    mutatesStory: true,
    plannedSteps: [],
    expectedArtifacts: ['diff', 'transcript'],
    envPolicy: {},
    commandPreview: ['npm', '--prefix', 'packages/main', 'run', 'test:authority-live-python-e2e'],
    verificationTargets: [],
    idempotencyKey: `${ctx.storyId}:producer-job`,
    expiresAt: pythonCanonicalTimestamp(new Date(Date.now() + 24 * 60 * 60 * 1000)),
    metadata: { model: 'claude-code', vendor: 'anthropic', source: 'authority-live-python-e2e-smoke' },
  });
  await completeRun(ctx, producer.runId, ctx.mainActorId, 'main', ctx.main, canonicalDigest({ storyId: ctx.storyId, seed: 'producer-run-transcript' }));

  const contracts = liveEvidenceContracts(ctx, producer.runId);
  const verifier = await createLiveJob(ctx, 'verifier', {
    projectId: ctx.projectId,
    provider: 'codex',
    role: 'tester',
    promptHash: canonicalDigest({ storyId: ctx.storyId, seed: 'verifier-job-prompt' }),
    storyId: ctx.storyId,
    cwdPolicy: 'read-only',
    permissions: { canWrite: false, canRunShell: true, canNetwork: false, requiresApproval: false, allowedCommands: [] },
    repo: ctx.repo,
    mutatesStory: false,
    plannedSteps: [],
    expectedArtifacts: ['verification-transcript'],
    envPolicy: {},
    commandPreview: contracts.command,
    producerJobId: producer.jobId,
    producerRunId: producer.runId,
    verificationTargets: [contracts.target],
    verificationPlan: contracts.plan,
    verificationContextPack: contracts.contextPack,
    verificationContextPackDigest: contracts.contextPackDigest,
    requiredTrustLevel: 2,
    verifierActorId: ctx.verifierActorId,
    verifierRole: 'verifier',
    idempotencyKey: `${ctx.storyId}:verifier-job`,
    expiresAt: pythonCanonicalTimestamp(new Date(Date.now() + 24 * 60 * 60 * 1000)),
    metadata: { model: 'gpt-5.3-codex', vendor: 'openai', source: 'authority-live-python-e2e-smoke' },
  });
  await completeRun(ctx, verifier.runId, ctx.verifierActorId, 'verifier', ctx.verifier, contracts.transcriptHash);

  const secondVerifier = await createLiveJob(ctx, 'second verifier', {
    projectId: ctx.projectId,
    provider: 'gemini',
    role: 'tester',
    promptHash: canonicalDigest({ storyId: ctx.storyId, seed: 'second-verifier-job-prompt' }),
    storyId: ctx.storyId,
    cwdPolicy: 'read-only',
    permissions: { canWrite: false, canRunShell: true, canNetwork: false, requiresApproval: false, allowedCommands: [] },
    repo: ctx.repo,
    mutatesStory: false,
    plannedSteps: [],
    expectedArtifacts: ['verification-transcript'],
    envPolicy: {},
    commandPreview: contracts.secondCommand,
    producerJobId: producer.jobId,
    producerRunId: producer.runId,
    verificationTargets: [contracts.target],
    verificationPlan: contracts.plan,
    verificationContextPack: contracts.contextPack,
    verificationContextPackDigest: contracts.contextPackDigest,
    requiredTrustLevel: 2,
    verifierActorId: ctx.secondVerifierActorId,
    verifierRole: 'verifier',
    idempotencyKey: `${ctx.storyId}:second-verifier-job`,
    expiresAt: pythonCanonicalTimestamp(new Date(Date.now() + 24 * 60 * 60 * 1000)),
    metadata: { model: 'gemini-3.1-pro', vendor: 'google', source: 'authority-live-python-e2e-smoke' },
  });
  await completeRun(ctx, secondVerifier.runId, ctx.secondVerifierActorId, 'verifier', ctx.secondVerifier, contracts.secondTranscriptHash);

  await postL2VerifierEvidence(ctx, contracts, producer, verifier, {
    evidenceId: `${ctx.storyId}:seed:l2-verifier:codex`,
    actorId: ctx.verifierActorId,
    keyPair: ctx.verifier,
    provider: 'codex',
    model: 'gpt-5.3-codex',
    vendor: 'openai',
    command: contracts.command,
    commandClass: 'unit-tests',
    commandDigest: contracts.commandDigest,
    transcriptHash: contracts.transcriptHash,
    negativeTranscriptHash: contracts.negativeTranscriptHash,
    claimId: contracts.claimId,
    negativeControlId: contracts.negativeControlId,
    oracleId: contracts.oracleId,
    note: 'Live E2E seed: first independent verifier evidence for the authority job loop test.',
    nonce: `${ctx.storyId}:seed-evidence:codex`,
  });

  await postL2VerifierEvidence(ctx, contracts, producer, secondVerifier, {
    evidenceId: `${ctx.storyId}:seed:l2-verifier:gemini`,
    actorId: ctx.secondVerifierActorId,
    keyPair: ctx.secondVerifier,
    provider: 'gemini',
    model: 'gemini-3.1-pro',
    vendor: 'google',
    command: contracts.secondCommand,
    commandClass: 'integration-tests',
    commandDigest: contracts.secondCommandDigest,
    transcriptHash: contracts.secondTranscriptHash,
    negativeTranscriptHash: contracts.secondNegativeTranscriptHash,
    claimId: contracts.secondClaimId,
    negativeControlId: contracts.secondNegativeControlId,
    oracleId: contracts.secondOracleId,
    note: 'Live E2E seed: second independent verifier evidence for the authority job loop test quorum.',
    nonce: `${ctx.storyId}:seed-evidence:gemini`,
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
      realMachineTests: [{ featureId: 'CHK-live-e2e', transcript: 'bounded live authority job loop test is runnable' }],
      closingSelfCheck: {
        hasRealMachineTest: true,
        hasEdgeCaseCoverage: true,
        hasUnresolvedTodos: false,
        summary: 'delivery evidence is complete for the live E2E authority job loop test',
      },
    },
  }, ctx.verifier));

  const preGate = await postJson(ctx, '/v1/gates/evaluate', signedGateRequest(ctx, `${ctx.storyId}:preflight-done-gate`));
  const decision = (preGate as { decision?: { verdict?: unknown; reasons?: unknown } }).decision;
  assert.equal(decision?.verdict, 'pass', `server DONE gate preflight must pass before creating the queued job: ${JSON.stringify(decision)}`);
}

export function step(
  stepId: string,
  type: PlannedStep['type'],
  title: string,
  args: Record<string, unknown>,
  extra: Partial<PlannedStep> = {},
): PlannedStep {
  return {
    stepId,
    type,
    title,
    purpose: title,
    cwdPolicy: 'read-only',
    timeoutMs: 30_000,
    maxAttempts: 1,
    requiresCleanWorktree: false,
    producesEvidence: true,
    blocksUntilEvidenceUploaded: false,
    evidenceBinding: `${stepId}:evidence`,
    args,
    ...extra,
  };
}

export function buildLiveJobPlan(ctx: LiveContext): JobPlan {
  const plannedSteps: PlannedStep[] = [
    step('step-resolve-story', 'lattice.command', 'Resolve the live E2E story', { operation: 'story.resolve' }),
    step('step-provider', 'provider.fake', 'Run deterministic bounded provider fixture', { operation: 'provider.fake.healthcheck' }, {
      provider: 'fake',
    }),
    step('step-validate', 'validate.run', 'Validate coverage binding for the live E2E job', { operation: 'validate.binding' }, {
      validationBinding: 'CHK-live-e2e:happy:0',
    }),
    step('step-gate', 'gate.evaluate', 'Evaluate the live server authority DONE gate', { operation: 'authority.gate.evaluate' }),
    step('step-summary', 'stop.summary', 'Write terminal live E2E stop summary', { operation: 'stop.summary' }),
  ];
  const plannerDigest = canonicalDigest({ kind: 'authority-live-python-e2e', storyId: ctx.storyId, plannedSteps });
  const evidenceRefs = [...new Set([...plannedSteps.map(item => item.evidenceBinding), ...ctx.extraEvidenceRefs])];
  return {
    schemaVersion: 'lattice.job_plan.v1',
    plannerRunId: `planner-live-e2e-${ctx.storyId}`,
    storyId: ctx.storyId,
    mode: 'authority',
    until: 'DONE',
    developmentWorkflow: 'standard',
    providerPolicy: {
      primaryProvider: 'codex',
      allowedProviders: ['codex'],
      fallbackProviders: [],
      productionDoneProviders: [],
      allowFakeProviderForProductionDone: false,
      credentialsEnvAllowlist: [],
      secretRefs: [],
      providerAvailability: 'fail_closed',
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
    plannedSteps,
    coverageMap: [{
      checklistItemId: 'CHK-live-e2e',
      verificationIntentDigest: canonicalDigest({ storyId: ctx.storyId, intent: 'live authority job loop executes to a verified gate receipt' }),
      plannedStepIds: plannedSteps.map(item => item.stepId),
      validationStepIds: ['step-validate'],
      evidenceRefs,
      expectedArtifacts: ['authority-job-loop-live-e2e-summary'],
      gatePredicate: 'Python Lattice Authority returns a verified gate_decision receipt for target DONE.',
    }],
    multiHostPolicy: {
      minIndependentHosts: 2,
      targetHostsPerWave: 3,
      preferredHostsForReleaseCertification: 3,
      preferredVerifierProviders: ['codex', 'claude', 'gemini'],
      requireMultiHost: true,
      requiredHostVerdictCount: 2,
      requiredReviewWaveCount: 3,
      fullAuthorityDoneRequired: true,
    },
    plannerDigest,
    jobPlanDigest: canonicalDigest({ kind: 'job-plan', plannerDigest, storyId: ctx.storyId }),
    status: 'planned',
  };
}

export function buildLocalStore(ctx: LiveContext): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-authority-live-e2e-'));
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: '.',
    rootDir: '.',
    outDir: 'dist',
    testsDir: 'tests',
    fixturesDir: 'tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2) + '\n', 'utf8');
  resetConfigCache();
  const store = new StoryStore(root);
  const now = pythonCanonicalTimestamp();
  const story: StoryInfo = {
    storyId: ctx.storyId,
    name: 'authority-live-python-e2e',
    title: 'Authority live Python E2E job loop',
    description: 'Temporary live E2E story proving queued job claim, evidence upload, gate receipt verification, and clean lease finalization.',
    type: 'feature',
    phase: 'DONE',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: now,
    events: [{ phase: 'DONE', action: 'create', timestamp: now }],
  };
  store.writeStory(ctx.storyId, story);
  return { root, store };
}

export function buildLiveEnv(ctx: LiveContext, base: Env): Env {
  return {
    ...base,
    LATTICE_AUTHORITY_MODE: 'enforce',
    LATTICE_AUTHORITY_URL: ctx.liveURL,
    LATTICE_AUTHORITY_LIVE_URL: ctx.liveURL,
    LATTICE_AUTHORITY_CUSTOMER_API_KEY: ctx.customerApiKey,
    LATTICE_AUTHORITY_PROJECT_ID: ctx.projectId,
    LATTICE_AUTHORITY_SESSION_ID: ctx.sessionId,
    LATTICE_AUTHORITY_SERVER_PUBLIC_KEY: ctx.expectedServerKeyHex,
    LATTICE_AUTHORITY_SERVER_PUBLIC_KEY_ENCODING: 'hex',
    LATTICE_AUTHORITY_SERVER_KEY_ID: ctx.serverKeyId,
    LATTICE_AUTHORITY_COMMAND_CATALOG_DIGEST: ctx.commandCatalogDigest,
    LATTICE_AUTHORITY_EVIDENCE_SCHEMA_DIGEST: ctx.evidenceSchemaDigest,
    LATTICE_AUTHORITY_CLIENT_VERSION: LIVE_E2E_CLIENT_VERSION,
    LATTICE_AUTHORITY_HEAD_HASH: ctx.repo.headHash,
    LATTICE_AUTHORITY_MATERIAL_HASH: ctx.repo.materialHash,
    LATTICE_AUTHORITY_DIRTY: 'false',
    LATTICE_AUTHORITY_GATE_ACTOR_ID: ctx.mainActorId,
    LATTICE_AUTHORITY_GATE_ACTOR_ROLE: 'main',
    LATTICE_AUTHORITY_GATE_ACTOR_KEY: ctx.main.privateKey,
    LATTICE_AUTHORITY_GATE_ACTOR_KEY_ENCODING: 'base64',
    LATTICE_AUTHORITY_ACTOR_ID: ctx.runnerActorId,
    LATTICE_AUTHORITY_ACTOR_ROLE: 'runner',
    LATTICE_AUTHORITY_ACTOR_KEY_ID: 'default',
    LATTICE_AUTHORITY_ACTOR_KEY: ctx.runner.privateKey,
    LATTICE_AUTHORITY_ACTOR_KEY_ENCODING: 'base64',
    LATTICE_AUTHORITY_RUNNER_ID: ctx.runnerId,
    LATTICE_AUTHORITY_DEVICE_ID: ctx.deviceId,
  };
}

export async function main(): Promise<void> {
  const env = process.env as Env;
  const liveURL = envValue(env, 'LIVE_URL') ?? envValue(env, 'URL');
  const livePublicKey = envValue(env, 'LIVE_PUBLIC_KEY') ?? envValue(env, 'SERVER_PUBLIC_KEY');
  const customerApiKey = envValue(env, 'CUSTOMER_API_KEY');
  const bootstrapToken = envValue(env, 'BOOTSTRAP_TOKEN');
  if (!liveURL || !livePublicKey || !customerApiKey) {
    skip('set LATTICE_AUTHORITY_LIVE_URL, LATTICE_AUTHORITY_LIVE_PUBLIC_KEY, and LATTICE_AUTHORITY_CUSTOMER_API_KEY');
    return;
  }

  const policy = await new AuthorityClient(liveURL).discoverPolicy();
  if (!policy.ok || !policy.data?.serverKey) {
    throw new Error(`authority policy discovery failed: ${policy.ok ? 'missing serverKey' : policy.message ?? policy.kind}`);
  }
  const expectedServerKeyHex = normalizeKeyToHex(livePublicKey);
  const actualServerKeyHex = policy.data.serverKey.publicKeyHex.toLowerCase();
  assert.equal(actualServerKeyHex, expectedServerKeyHex, 'live server public key must match the pinned test key');
  assert.ok(policy.data.commandCatalogDigest, 'live server policy must expose commandCatalogDigest');
  assert.ok(policy.data.evidenceSchemaDigest, 'live server policy must expose evidenceSchemaDigest');

  const suffix = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
  const ctx: LiveContext = {
    liveURL,
    expectedServerKeyHex,
    serverKeyId: policy.data.serverKey.keyId,
    commandCatalogDigest: policy.data.commandCatalogDigest,
    evidenceSchemaDigest: policy.data.evidenceSchemaDigest,
    customerApiKey,
    ...(bootstrapToken ? { bootstrapToken } : {}),
    projectId: envValue(env, 'PROJECT_ID') ?? `project-live-e2e-${suffix}`,
    storyId: `B-live-e2e-${suffix}`,
    sessionId: `session-live-e2e-${suffix}`,
    runnerId: `runner-live-e2e-${suffix}`,
    deviceId: `device-live-e2e-${suffix}`,
    mainActorId: `main-live-e2e-${suffix}`,
    reviewerActorId: `reviewer-live-e2e-${suffix}`,
    verifierActorId: `verifier-live-e2e-${suffix}`,
    secondVerifierActorId: `verifier2-live-e2e-${suffix}`,
    runnerActorId: `runner-actor-live-e2e-${suffix}`,
    extraEvidenceRefs: envStringList(env, 'LIVE_EXTRA_EVIDENCE_REFS'),
    repo: {
      headHash: `head-live-e2e-${suffix}`,
      materialHash: `material-live-e2e-${suffix}`,
      dirty: false,
    },
    main: generateEd25519KeyPair(),
    reviewer: generateEd25519KeyPair(),
    verifier: generateEd25519KeyPair(),
    secondVerifier: generateEd25519KeyPair(),
    runner: generateEd25519KeyPair(),
  };

  await registerActorKey(ctx, ctx.mainActorId, 'main', ctx.main, { deviceId: ctx.deviceId });
  await registerActorKey(ctx, ctx.reviewerActorId, 'reviewer', ctx.reviewer, { deviceId: ctx.deviceId });
  await registerActorKey(ctx, ctx.verifierActorId, 'verifier', ctx.verifier, { runnerId: ctx.runnerId });
  await registerActorKey(ctx, ctx.secondVerifierActorId, 'verifier', ctx.secondVerifier, { runnerId: ctx.runnerId });
  await registerActorKey(ctx, ctx.runnerActorId, 'runner', ctx.runner, { runnerId: ctx.runnerId });
  await registerAndHeartbeatRunner(ctx);
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

  assert.equal(result.authorityJobLoop?.claimStatus, 'claimed', 'live runner must claim the queued job');
  assert.equal(result.authorityJobLoop.claimedJobId, created.jobId, 'claimed job id must be the job just created');
  assert.equal(result.claimedJobExecution?.jobId, created.jobId, 'claimed job execution must bind to created job');
  assert.equal(
    result.claimedJobExecution?.execution?.status,
    'done',
    `typed plannedSteps must execute to done: ${JSON.stringify(result.claimedJobExecution?.execution)}`,
  );
  assert.equal(result.completion?.receiptVerified, true, 'native gate_decision receipt must verify');
  assert.equal(result.authorityDone, true, 'per-run authorityDone must be true after verified gate receipt');
  assert.equal(result.fullAuthorityDone, false, 'fullAuthorityDone stays false until final multi-host certification');
  assert.equal(result.completion?.completed, false, 'job completion stays blocked by multi-host policy');
  assert.equal(result.authorityJobLoop.disposition, 'released', 'lease must be released when full completion gate is not satisfied');
  assert.equal(result.authorityJobLoop.releaseOutcome, 'abandoned', 'release outcome should be abandoned, not completed');
  assert.equal(result.authorityJobLoop.receiptVerified, true, 'live loop trace must reflect verified receipt');
  assert.ok(result.authorityJobLoop.evidenceRefs.length > 0, 'live loop must expose evidence refs');
  assert.ok(
    result.authorityJobLoop.networkEvents.some(event => event.step === 'claim_job' && event.ok),
    'network trace must include successful claim_job',
  );
  assert.ok(
    result.authorityJobLoop.networkEvents.some(event => event.step === 'release_job' && event.ok),
    'network trace must include successful release_job',
  );

  console.log(PASS_LINE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
