#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resetConfigCache } from '../core/config.js';
import { COMMIT_SUBJECT_PREFIX } from '../core/auto-commit-metadata.js';
import { PROOF_OR_STOP_DIR, PROOF_OR_STOP_STORY_DIR } from '../core/proof-or-stop-paths.js';
import { MAIN_TOOLS } from '../cli/command-catalog.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import {
  buildCorpusIndex,
  buildKeywordSeeds,
  digestCandidateRoutingValue,
  routeCandidateSpecs,
} from '../core/candidate-spec-routing.js';
import {
  cancelManagedHostRun,
  managedHostRunDirectory,
  managedHostRunReceipt,
  getManagedHostRunStatus,
  readManagedReviewImportSeal,
  readManagedReviewEvidenceProposal,
  readManagedHostRunResult,
  readManagedHostRunBinding,
  runManagedHostRunWorker,
  signManagedReviewProposalInvocation,
  submitManagedHostRun,
  writeManagedReviewEvidenceProposal,
} from '../core/managed-host-run.js';
import {
  classifyReviewerExecutionAuthority,
  buildManagedReviewerPrompt,
  createManagedReviewEvidenceBinding,
  verifyManagedReviewEvidence,
  verifyManagedReviewLiveBinding,
  type ManagedReviewExpectedBinding,
} from '../core/managed-review-evidence.js';
import { promptRoleContract, reviewerHostRenderIdentity, resolvePromptRoleBody } from '../core/prompt-role-contract-registry.js';
import { assembleFullPromptEnvelope, buildFullTaskContext } from '../core/prompt-envelope.js';
import { BASELINE_RUNTIME_CONTRACT } from '../core/prompt-measurement.js';
import { reviewerDispatchBindingDigest, reviewerDispatchPromptDigest } from '../core/prompt-contracts.js';
import { assertCurrentReviewRunForEvidence, captureReviewRunSnapshot, collectReviewerEvidenceState, hashReviewPrompt, signReviewRun } from '../core/review-run.js';
import { signFinding, signReviewPass } from '../core/finding-verify.js';
import { isFindingBlocking } from '../core/advisory.js';
import { generateEd25519KeyPair } from '../core/authority-signing.js';
import {
  signNativeReviewInvocationAttestation,
  verifyNativeReviewInvocationAttestation,
} from '../core/native-review-attestation.js';
import {
  classifyNativeHostProcessLineage,
  issueNativeReviewEvidenceBinding,
} from '../core/native-review-evidence.js';
import { getSessionIdentity } from '../core/owner-session.js';
import { StoryStore } from '../core/store.js';
import { defaultHostRunRunner, type HostRunRunner } from '../core/host-run.js';
import type { ChecklistData, Finding, ReviewRun, StoryInfo } from '../core/types.js';
import { createFindingHandlers } from '../handlers/finding.js';
import { currentStoryRoutingInput } from '../handlers/candidate-spec-routing.js';
import { createManagedReviewEvidenceHandlers } from '../handlers/managed-review-evidence.js';
import { createHostRunHandlers, type HostRunDetachResult } from '../handlers/host-run.js';

const STORY_ID = 'B-managed-evidence';
const LANE = 'proof-or-stop-review-quality';
const REVIEW_RUN_ID = `${STORY_ID}:RR-001`;
const CONCEPT_LANE = 'proof-or-stop-review-concept';
const CONCEPT_REVIEW_RUN_ID = `${STORY_ID}:RR-002`;
const REVIEW_ROUND = '2026-08-14T00:00:00.000Z';
const SELF = fileURLToPath(import.meta.url);
const MANAGED_REVIEW_FIXTURE_DEADLINE_MS = 10_000;
// The managed-cross-provider aggregate starts this detached CLI worker after
// several expensive child suites. A 2s test-only claim allowance has observed
// a real cold-start miss there; keep the same bounded 10s allowance already
// used by managed-host-run-smoke's aggregate-load worker controls. The 15s
// fixture deadline remains finite and leaves room for the claimed worker to
// run its fake provider, so this is not an unbounded retry or terminal waiver.
const MANAGED_REVIEW_DESCRIPTOR_CLAIM_TIMEOUT_MS = 10_000;
const MANAGED_REVIEW_DESCRIPTOR_DEADLINE_MS = 15_000;
const MANAGED_REVIEW_NESTED_CLAIM_DELAY_MS = 2_500;
const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const MANAGED_AMBIENT_AUTHORITY_KEYS = [
  'LATTICE_MANAGED_HOST_RUN_ID',
  'LATTICE_MANAGED_REVIEW_INVOCATION_FD',
  'LATTICE_MANAGED_REVIEW_PROPOSAL_CAPABILITY',
  'LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD',
] as const;

/**
 * Reviewer dispatch identity must not reach host-owned fixture mutations.
 *
 * B-137a main-merge fix: these were the RETIRED spellings. `brandEnvNames()`
 * returns a canonical-only tuple, so the guard reads PROOF_OR_STOP_AGENT and
 * this sanitizer was deleting names nothing consumed -- it cleared no authority
 * at all. Use the canonical keys the guard actually reads.
 */
const REVIEWER_DISPATCH_AUTHORITY_KEYS = [
  'PROOF_OR_STOP_AGENT',
  'PROOF_OR_STOP_ACTIVITY_ROLE',
] as const;

function withoutManagedAmbientAuthority(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of MANAGED_AMBIENT_AUTHORITY_KEYS) delete sanitized[key];
  return sanitized;
}

function withoutReviewerDispatchAuthority(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of REVIEWER_DISPATCH_AUTHORITY_KEYS) delete sanitized[key];
  return sanitized;
}

function hostOwnedChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return withoutReviewerDispatchAuthority(env);
}

function withHostOwnedMutationEnv<T>(fn: () => T): T {
  const previous = REVIEWER_DISPATCH_AUTHORITY_KEYS.map(key => [key, process.env[key]] as const);
  for (const key of REVIEWER_DISPATCH_AUTHORITY_KEYS) delete process.env[key];
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function assertHostOwnedMutationEnvDropsReviewerDispatchAuthority(): void {
  const env = hostOwnedChildEnv({
    ...process.env,
    PROOF_OR_STOP_AGENT: 'proof-or-stop-review-test-coverage',
    PROOF_OR_STOP_ACTIVITY_ROLE: 'proof-or-stop-review-test-coverage',
  });
  for (const key of REVIEWER_DISPATCH_AUTHORITY_KEYS) {
    assert.equal(env[key], undefined, `host-owned fixture env must not inherit ${key}`);
  }
  const observed = execFileSync(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify({agent: process.env.PROOF_OR_STOP_AGENT ?? null, role: process.env.PROOF_OR_STOP_ACTIVITY_ROLE ?? null}))'],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.deepEqual(
    JSON.parse(observed),
    { agent: null, role: null },
    `host-owned fixture child inherited reviewer dispatch authority: ${observed}`,
  );
}

function write(root: string, relativePath: string, contents: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function managedReadEvidence(root: string, requestedFiles?: string[]) {
  const artifact = new StoryStore(root).readCandidateSpecSet(STORY_ID);
  assert.ok(artifact, 'managed review fixture requires a candidate artifact');
  // Positive fixture worker actually reads all current required candidate files.
  // Explicit subsets remain untouched for rejection and drift controls.
  const filesReadFully = requestedFiles ?? [...new Set(['packages/main/src/example.ts', ...artifact.candidateSpecSet])].sort();
  for (const file of filesReadFully) readFileSync(join(root, file));
  return {
    readManifest: {
      filesReadFully,
      filesTriagedByName: [],
      scanEscalationReason: artifact.scanEscalationReason,
      candidateSpecSetDigest: artifact.artifactDigest,
      corpusDigest: artifact.corpusDigest,
    },
    readLog: {
      filesReadFully,
      filesTriagedByName: [],
      summary: { readCount: filesReadFully.length, tokenCount: null },
      digest: 'a'.repeat(64),
    },
  };
}

function refreshCandidateArtifact(root: string, store: StoryStore, mode: 'shadow' | 'enforce'): void {
  const routingContext = { store, root, scanRoot: join(root, 'packages/main') };
  const story = store.readStory(STORY_ID);
  const routingInput = currentStoryRoutingInput(routingContext, STORY_ID);
  const routingSnapshot = captureReviewRunSnapshot(root, { storyId: STORY_ID, storyPhase: story.phase });
  store.writeCandidateSpecSet(STORY_ID, routeCandidateSpecs({
    projectRoot: root,
    storyId: STORY_ID,
    corpus: buildCorpusIndex(root),
    seeds: buildKeywordSeeds(routingInput),
    protectedSources: routingInput.protectedSources,
    mode,
    storyInputDigest: digestCandidateRoutingValue(routingInput),
    ...routingSnapshot,
  }));
}

function seedReviewStory(
  root: string,
  brokerPublicKey: string,
  options: { candidateRoutingMode?: 'shadow' | 'enforce' } = {},
): {
  store: StoryStore;
  run: ReviewRun;
  nativeDispatch: { dispatchPromptDigest: string; hostRenderIdentityDigest: string; dispatchBindingDigest: string };
} {
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: PROOF_OR_STOP_STORY_DIR,
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
    promptEnvelope: {
      version: 'proof-or-stop.prompt-envelope-rollout.v1',
      roles: {
        [LANE]: 'full-envelope',
        [CONCEPT_LANE]: 'full-envelope',
      },
    },
    nativeReviewInvocation: {
      brokers: [{
        brokerId: 'smoke-codex-broker',
        adapterId: 'codex-desktop',
        host: 'codex',
        publicKey: brokerPublicKey,
      }],
    },
    candidateSpecRouting: { mode: options.candidateRoutingMode ?? 'shadow' },
  }));
  write(root, 'docs/requirements/decisions/managed-review-evidence.md', '# Managed Review Evidence\n\nCandidate routing fixture.\n');
  write(root, 'packages/main/src/example.ts', 'export const example = true;\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'base']);
  resetConfigCache();

  const store = new StoryStore(root);
  const story: StoryInfo = {
    storyId: STORY_ID,
    name: 'managed-review-evidence-smoke',
    title: 'Managed review evidence smoke',
    description: 'Exercise provider proposal, terminal seal, importer, and REVIEW gate.',
    type: 'feature',
    priority: 'high',
    phase: 'REVIEW',
    createdAt: REVIEW_ROUND,
    startedAt: REVIEW_ROUND,
    endedAt: null,
    currentReviewRound: REVIEW_ROUND,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: REVIEW_ROUND }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Managed evidence is admissible',
      context: 'Synthetic end-to-end managed review evidence.',
      status: 'done',
      startTime: REVIEW_ROUND,
      endTime: REVIEW_ROUND,
      relatedDocs: ['docs/requirements/decisions/managed-review-evidence.md'],
    }],
  };
  store.writeStory(STORY_ID, story);
  store.writeChecklist(STORY_ID, checklist);
  const dispatchPrompt = 'Perform the exact native-host review for this story.';
  const dispatchPromptDigest = reviewerDispatchPromptDigest(dispatchPrompt);
  const hostIdentity = reviewerHostRenderIdentity(root, LANE, 'codex', 'full-envelope');
  const dispatchBindingDigest = reviewerDispatchBindingDigest({
    storyId: STORY_ID,
    lane: LANE,
    reviewRound: REVIEW_ROUND,
    dispatchPromptDigest,
    hostRenderIdentityDigest: hostIdentity.identityDigest,
  });
  store.appendProcessEvent(STORY_ID, {
    type: 'dispatch',
    storyId: STORY_ID,
    agentType: LANE,
    targetKind: 'story-review',
    reviewRound: REVIEW_ROUND,
    dispatchPrompt,
    dispatchPromptDigest,
    hostRenderHost: 'codex',
    hostRenderIdentityDigest: hostIdentity.identityDigest,
    dispatchBindingDigest,
  });

  const currentRoleBody = resolvePromptRoleBody(LANE, {
    version: 'proof-or-stop.prompt-envelope-rollout.v1',
    roles: { [LANE]: 'full-envelope' },
  });
  const headHash = currentGitHead(root)!;
  const materialHash = currentMaterialHash(root)!;
  const storyFilesHash = currentStoryFilesHash(root)!;
  const run: ReviewRun = {
    reviewRunId: REVIEW_RUN_ID,
    storyId: STORY_ID,
    agent: LANE,
    lane: LANE,
    reviewRound: REVIEW_ROUND,
    startedAt: REVIEW_ROUND,
    headHash,
    materialHash,
    storyFilesHash,
    promptHash: hashReviewPrompt(currentRoleBody.body),
    _hash: signReviewRun(
      STORY_ID,
      REVIEW_RUN_ID,
      LANE,
      LANE,
      REVIEW_ROUND,
      REVIEW_ROUND,
      headHash,
      materialHash,
      hashReviewPrompt(currentRoleBody.body),
      undefined,
      undefined,
      storyFilesHash,
    ),
  };
  bindCurrentReviewEnvelope(root, store, run);
  store.writeReviewRuns(STORY_ID, { runs: [run] });
  refreshCandidateArtifact(root, store, options.candidateRoutingMode ?? 'shadow');
  return {
    store,
    run,
    nativeDispatch: {
      dispatchPromptDigest,
      hostRenderIdentityDigest: hostIdentity.identityDigest,
      dispatchBindingDigest,
    },
  };
}

/** Test-owned current envelope producer; broker authority and managed seals remain real. */
function bindCurrentReviewEnvelope(root: string, store: StoryStore, run: ReviewRun): ReviewRun {
  const dispatch = [...store.readProcessEvents(run.storyId)].reverse().find(event =>
    event.type === 'dispatch' && event.agentType === run.lane && event.reviewRound === run.reviewRound);
  if (!dispatch || typeof dispatch.dispatchPrompt !== 'string' || typeof dispatch.dispatchBindingDigest !== 'string'
    || typeof dispatch.hostRenderIdentityDigest !== 'string') throw new Error('fixture requires a current bound dispatch');
  const assembly = assembleFullPromptEnvelope({
    roleContract: promptRoleContract(run.lane), runtimeContract: BASELINE_RUNTIME_CONTRACT,
    rolePrompt: resolvePromptRoleBody(run.lane, {
      version: 'proof-or-stop.prompt-envelope-rollout.v1', roles: { [run.lane]: 'full-envelope' },
    }).body,
    taskContext: buildFullTaskContext({ story: store.readStory(run.storyId), checklist: store.readChecklist(run.storyId),
      headHash: run.headHash, materialHash: run.materialHash, storyFilesHash: run.storyFilesHash }),
    dispatchKind: 'review-run', reviewRunId: run.reviewRunId, reviewRound: run.reviewRound, lane: run.lane,
    dispatchPrompt: dispatch.dispatchPrompt, hostRenderIdentityDigest: dispatch.hostRenderIdentityDigest,
    reviewerDispatchBindingDigest: dispatch.dispatchBindingDigest,
    launcherSpec: { reviewedIntentRefs: [], dispatchBindingDigest: dispatch.dispatchBindingDigest, hostRenderHost: 'codex' },
    createdAt: run.startedAt,
  });
  run.envelopeId = assembly.envelope.envelopeId;
  run.assembledPrompt = assembly.prompt;
  run.promptHash = assembly.envelope.assembledPromptDigest;
  run._hash = signReviewRun(run.storyId, run.reviewRunId, run.agent, run.lane, run.reviewRound, run.startedAt,
    run.headHash, run.materialHash, run.promptHash, run.scopeBinding?.bindingHash, run.workspaceBinding?.bindingHash,
    run.storyFilesHash, run.envelopeId, run.reviewerEscalationReason, run.reviewPurpose, run.inventoryBinding);
  const prior = store.readPromptEnvelopes(run.storyId);
  store.writePromptEnvelopes(run.storyId, { envelopes: [...prior.envelopes.filter(item => item.envelopeId !== run.envelopeId), assembly.envelope] });
  return run;
}

function addCurrentReviewRun(root: string, store: StoryStore, lane: string, reviewRunId: string): ReviewRun {
  const dispatchPrompt = `Perform the exact native-host review for ${lane}.`;
  const dispatchPromptDigest = reviewerDispatchPromptDigest(dispatchPrompt);
  const hostIdentity = reviewerHostRenderIdentity(root, lane, 'codex', 'full-envelope');
  const dispatchBindingDigest = reviewerDispatchBindingDigest({
    storyId: STORY_ID,
    lane,
    reviewRound: REVIEW_ROUND,
    dispatchPromptDigest,
    hostRenderIdentityDigest: hostIdentity.identityDigest,
  });
  store.appendProcessEvent(STORY_ID, {
    type: 'dispatch',
    storyId: STORY_ID,
    agentType: lane,
    targetKind: 'story-review',
    reviewRound: REVIEW_ROUND,
    dispatchPrompt,
    dispatchPromptDigest,
    hostRenderHost: 'codex',
    hostRenderIdentityDigest: hostIdentity.identityDigest,
    dispatchBindingDigest,
  });
  const currentRoleBody = resolvePromptRoleBody(lane, {
    version: 'proof-or-stop.prompt-envelope-rollout.v1',
    roles: { [lane]: 'full-envelope' },
  });
  const headHash = currentGitHead(root)!;
  const materialHash = currentMaterialHash(root)!;
  const storyFilesHash = currentStoryFilesHash(root)!;
  const run: ReviewRun = {
    reviewRunId,
    storyId: STORY_ID,
    agent: lane,
    lane,
    reviewRound: REVIEW_ROUND,
    startedAt: REVIEW_ROUND,
    headHash,
    materialHash,
    storyFilesHash,
    promptHash: hashReviewPrompt(currentRoleBody.body),
    _hash: signReviewRun(
      STORY_ID,
      reviewRunId,
      lane,
      lane,
      REVIEW_ROUND,
      REVIEW_ROUND,
      headHash,
      materialHash,
      hashReviewPrompt(currentRoleBody.body),
      undefined,
      undefined,
      storyFilesHash,
    ),
  };
  bindCurrentReviewEnvelope(root, store, run);
  const reviewRuns = store.readReviewRuns(STORY_ID);
  store.writeReviewRuns(STORY_ID, { runs: [...reviewRuns.runs, run] });
  return run;
}

async function eventually(predicate: () => Promise<boolean>, message: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
}

async function sanitizedProposalToolMain(root: string, gatePath: string, reviewRunId: string): Promise<void> {
  await eventually(async () => {
    try { readFileSync(gatePath); return true; } catch { return false; }
  }, 'sanitized provider tool child was never released');
  const result = spawnSync(process.execPath, [CLI, 'managed_review_proposal_set', JSON.stringify({
    storyId: STORY_ID,
    providerAgent: LANE,
    lane: LANE,
    reviewRunId,
    conclusion: 'pass',
    note: 'Sanitized Codex tool child authored this exact provider verdict.',
    ...managedReadEvidence(root),
  })], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LATTICE_MANAGED_REVIEW_INVOCATION_FD: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe', 3],
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  process.exitCode = result.status ?? 1;
}

async function runBrokeredCli(
  root: string,
  command: string,
  args: Record<string, unknown>,
  attestation: ReturnType<typeof signNativeReviewInvocationAttestation>,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const childEnvironment = withoutManagedAmbientAuthority(env);
  const child = spawn(process.execPath, [CLI, command, JSON.stringify(args)], {
    cwd: root,
    env: {
      ...childEnvironment,
      LATTICE_NATIVE_REVIEW_ATTESTATION_FD: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', chunk => { stdout += String(chunk); });
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const brokerPipe = child.stdio[3] as NodeJS.WritableStream;
  brokerPipe.write(`${JSON.stringify(attestation)}\n`);
  brokerPipe.end();
  return { status: await waitForExit(child), stdout, stderr };
}

interface BrokeredNativeBindingFixtureArgs {
  storyId: string;
  agent: string;
  lane: string;
  reviewRunId: string;
  dispatch: {
    dispatchPromptDigest: string;
    hostRenderIdentityDigest: string;
    dispatchBindingDigest: string;
    hostRenderHost: 'codex' | 'claude';
  };
}

function brokeredNativeBindingFixtureMain(root: string, encodedArgs: string): void {
  const args = JSON.parse(encodedArgs) as BrokeredNativeBindingFixtureArgs;
  const binding = issueNativeReviewEvidenceBinding({
    projectRoot: root,
    storyId: args.storyId,
    agent: args.agent,
    lane: args.lane,
    reviewRunId: args.reviewRunId,
    identity: getSessionIdentity(),
    dispatch: args.dispatch,
    // This observation seam exists only in this task binary entrypoint. It is
    // neither a production CLI command nor an environment-controlled bypass.
    observeProcess: () => null,
  });
  process.stdout.write(`${JSON.stringify(binding)}\n`);
}

async function runBrokeredNativeBindingFixture(
  root: string,
  args: BrokeredNativeBindingFixtureArgs,
  attestation: ReturnType<typeof signNativeReviewInvocationAttestation>,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const childEnvironment = withoutManagedAmbientAuthority(env);
  const child = spawn(process.execPath, [SELF, '--brokered-native-binding-fixture', root, JSON.stringify(args)], {
    cwd: root,
    env: {
      ...childEnvironment,
      LATTICE_NATIVE_REVIEW_ATTESTATION_FD: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', chunk => { stdout += String(chunk); });
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const brokerPipe = child.stdio[3] as NodeJS.WritableStream;
  brokerPipe.write(`${JSON.stringify(attestation)}\n`);
  brokerPipe.end();
  return { status: await waitForExit(child), stdout, stderr };
}

async function runManagedProposalCliWithAttestation(
  root: string,
  args: Record<string, unknown>,
  attestation: ReturnType<typeof signManagedReviewProposalInvocation>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI, 'managed_review_proposal_set', JSON.stringify(args)], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LATTICE_MANAGED_REVIEW_INVOCATION_FD: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', chunk => { stdout += String(chunk); });
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const brokerPipe = child.stdio[3] as NodeJS.WritableStream;
  brokerPipe.write(`${JSON.stringify(attestation)}\n`);
  brokerPipe.end();
  return { status: await waitForExit(child), stdout, stderr };
}

/**
 * Keep the descriptor-only provider path independently runnable. The source
 * mutation harness must prove its importer/gate mutation after this path has
 * been established, but an unrelated descriptor transport failure must never
 * obscure the mutation boundary it is intended to exercise.
 */
async function assertDescriptorBackedProviderProposalTransport(
  root: string,
  store: StoryStore,
  run: ReviewRun,
): Promise<void> {
  const fakeBin = join(root, PROOF_OR_STOP_DIR, 'runtime', 'fake-provider-bin');
  mkdirSync(fakeBin, { recursive: true });
  const fakeCodex = join(fakeBin, 'codex');
  const providerProposal = JSON.stringify({
    storyId: STORY_ID,
    providerAgent: LANE,
    lane: LANE,
    reviewRunId: REVIEW_RUN_ID,
    conclusion: 'pass',
    note: 'Real descriptor-brokered Codex-style tool submitted this exact verdict.',
    ...managedReadEvidence(root),
  });
  writeFileSync(fakeCodex, `#!/bin/sh
cat >/dev/null
exec /usr/bin/env -i PATH="$PATH" LATTICE_MANAGED_REVIEW_INVOCATION_FD=3 "$LATTICE_TEST_NODE" "$LATTICE_TEST_CLI" managed_review_proposal_set '${providerProposal}'
`);
  chmodSync(fakeCodex, 0o700);
  let descriptorPrivateKey = '';
  const descriptorLauncher: import('../core/managed-host-run.js').ManagedHostRunWorkerLauncher = request => {
    const child = spawn(process.execPath, [CLI, '--root', request.root, 'host_run_worker', JSON.stringify({ runId: request.runId })], {
      cwd: request.root,
      detached: true,
      env: {
        ...process.env,
        LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD: '3',
      },
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
    assert.ok(child.pid && request.proposalInvocationPrivateKey);
    descriptorPrivateKey = request.proposalInvocationPrivateKey!;
    const capabilityPipe = child.stdio[3];
    assert.ok(capabilityPipe && 'end' in capabilityPipe);
    capabilityPipe.end(request.proposalInvocationPrivateKey);
    child.unref();
    return { pid: child.pid! };
  };
  const descriptorRun = await submitManagedHostRun({
    root,
    cwd: root,
    host: 'codex',
    storyId: STORY_ID,
    phase: 'REVIEW',
    agentType: LANE,
    reviewRunId: REVIEW_RUN_ID,
    lane: LANE,
    promptText: buildManagedReviewerPrompt(root, run),
    deadlineMs: MANAGED_REVIEW_DESCRIPTOR_DEADLINE_MS,
    projectRootHash: `sha256:${'1'.repeat(64)}`,
    profile: 'managed_reviewer',
    environment: {
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      LATTICE_TEST_NODE: process.execPath,
      LATTICE_TEST_CLI: CLI,
      PROOF_OR_STOP_USAGE_LEDGER: '0',
    },
    reviewBinding: {
      headHash: run.headHash,
      materialHash: run.materialHash,
      storyFilesHash: run.storyFilesHash ?? '',
      promptHash: run.promptHash,
      envelopeId: run.envelopeId ?? null,
    },
  }, {
    launchWorker: descriptorLauncher,
    workerCapabilityTransport: 'descriptor',
    claimTimeoutMs: MANAGED_REVIEW_DESCRIPTOR_CLAIM_TIMEOUT_MS,
    claimPollMs: 10,
  });
  await eventually(async () => (await getManagedHostRunStatus({ root, runId: descriptorRun.runId })).run.terminal !== null,
    'real descriptor-brokered provider did not reach terminal');
  const descriptorStatus = await getManagedHostRunStatus({ root, runId: descriptorRun.runId });
  const descriptorResult = readManagedHostRunResult(root, descriptorRun.runId);
  assert.equal(descriptorStatus.run.terminal?.state, 'completed',
    `real Codex-style sanitized tool env reaches a successful provider terminal: ${descriptorStatus.run.terminal?.reason}; `
    + `stderr=${descriptorResult?.stderr ?? '<no result>'}`);
  const descriptorReceipt = managedHostRunReceipt(root, descriptorRun.runId);
  assert.match(descriptorReceipt.evidenceProposalDigest ?? '', /^sha256:/,
    'the descriptor-brokered provider proposal is sealed into its terminal receipt');
  assert.equal(existsSync(join(managedHostRunDirectory(root, descriptorRun.runId), 'input.cap')), false,
    'production descriptor transport never persists its private proposal signing key');
  const persistedRunFiles = readdirSync(managedHostRunDirectory(root, descriptorRun.runId))
    .map(name => join(managedHostRunDirectory(root, descriptorRun.runId), name))
    .filter(path => statSync(path).isFile());
  assert.ok(descriptorPrivateKey.length > 0 && persistedRunFiles.every(path => !readFileSync(path).includes(descriptorPrivateKey)),
    'the worker/provider private proposal signing key appears in no durable run artifact');
  const handlers = createManagedReviewEvidenceHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  assert.match(
    handlers.managed_review_evidence_import({ runId: descriptorRun.runId, receiptId: descriptorReceipt.receiptId }),
    /Managed review evidence imported/,
    'the real sanitized provider proposal remains exactly importable',
  );
  store.writeReviewPasses(STORY_ID, {
    passes: store.readReviewPasses(STORY_ID).passes.filter(
      pass => pass.managedEvidenceBinding?.receiptId !== descriptorReceipt.receiptId,
    ),
  });
}

async function importWorkerMain(
  root: string,
  runId: string,
  receiptId: string,
  readyPath: string,
  goPath: string,
  resultPath: string,
  afterReviewPassReadPath?: string,
  persistBarrierPath?: string,
): Promise<void> {
  process.chdir(root);
  resetConfigCache();
  writeFileSync(readyPath, 'ready');
  await eventually(async () => {
    try { readFileSync(goPath); return true; } catch { return false; }
  }, 'concurrent import barrier was never released');
  const store = new StoryStore(root);
  if (afterReviewPassReadPath && persistBarrierPath) {
    const readReviewPasses = store.readReviewPasses.bind(store);
    const readFindings = store.readFindings.bind(store);
    let reviewPassReads = 0;
    let findingReads = 0;
    store.readReviewPasses = ((storyId: string) => {
      const data = readReviewPasses(storyId);
      reviewPassReads += 1;
      if (reviewPassReads === 2) {
        writeFileSync(afterReviewPassReadPath, 'read');
        while (!existsSync(persistBarrierPath)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return data;
    }) as typeof store.readReviewPasses;
    store.readFindings = ((storyId: string) => {
      const data = readFindings(storyId);
      findingReads += 1;
      if (findingReads === 2) {
        writeFileSync(afterReviewPassReadPath, 'read');
        while (!existsSync(persistBarrierPath)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return data;
    }) as typeof store.readFindings;
  }
  const handlers = createManagedReviewEvidenceHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  let resolvedReceiptId = receiptId;
  if (receiptId === 'AUTO') {
    await eventually(async () => {
      try {
        resolvedReceiptId = managedHostRunReceipt(root, runId).receiptId;
        return true;
      } catch { return false; }
    }, 'import worker did not observe the exclusive terminal receipt');
  }
  const result = handlers.managed_review_evidence_import({ runId, receiptId: resolvedReceiptId });
  writeFileSync(resultPath, `${result}\n`);
}

async function proposalWorkerMain(
  root: string,
  runId: string,
  readyPath: string,
  goPath: string,
  resultPath: string,
): Promise<void> {
  writeFileSync(readyPath, 'ready');
  await eventually(async () => {
    try { readFileSync(goPath); return true; } catch { return false; }
  }, 'concurrent proposal barrier was never released');
  try {
    writeManagedReviewEvidenceProposal({
      root,
      runId,
      environment: process.env,
      proposal: {
        storyId: STORY_ID,
        providerAgent: LANE,
        lane: LANE,
        reviewRunId: REVIEW_RUN_ID,
        conclusion: 'pass',
        note: 'Provider reviewed the exact managed prompt and found no blocker.',
        ...managedReadEvidence(root),
      },
    });
    writeFileSync(resultPath, 'created');
  } catch (error) {
    writeFileSync(resultPath, `rejected:${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertManagedImportRejectsLiveMaterialDrift(brokerPublicKey: string): Promise<void> {
  const driftRoot = mkdtempSync(join(tmpdir(), 'managed-review-import-live-drift-'));
  try {
    const { store, run } = seedReviewStory(driftRoot, brokerPublicKey);
    git(driftRoot, ['checkout', '-b', 'story/managed-import-drift']);
    write(driftRoot, 'packages/main/src/story-owned.ts', 'export const storyOwned = true;\n');
    git(driftRoot, ['add', 'packages/main/src/story-owned.ts']);
    git(driftRoot, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'story material']);
    const snapshotHead = currentGitHead(driftRoot)!;
    const snapshotMaterial = currentMaterialHash(driftRoot)!;
    const snapshotStoryFiles = currentStoryFilesHash(driftRoot)!;
    const updatedRun: ReviewRun = {
      ...run,
      headHash: snapshotHead,
      materialHash: snapshotMaterial,
      storyFilesHash: snapshotStoryFiles,
      _hash: signReviewRun(
        STORY_ID, REVIEW_RUN_ID, LANE, LANE, REVIEW_ROUND, REVIEW_ROUND,
        snapshotHead, snapshotMaterial, run.promptHash,
        undefined, undefined, snapshotStoryFiles,
      ),
    };
    bindCurrentReviewEnvelope(driftRoot, store, updatedRun);
    store.writeReviewRuns(STORY_ID, { runs: [updatedRun] });
    // Create the managed run while the signed review tuple still names the
    // canonical HEAD. The negative control is about import-time live material
    // drift, not about bypassing scratch creation's separate exact-HEAD guard.
    const hostHandlers = createHostRunHandlers(
      { store, root: driftRoot, scanRoot: join(driftRoot, 'packages/main') },
      { runner: async () => ({
        stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
        finalAssistantResult: JSON.stringify({
          schemaVersion: 'lattice.managed_review_final_proposal.v1',
          storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: REVIEW_RUN_ID,
          conclusion: 'pass', note: 'The old review tuple must not become evidence after live material drift.',
          ...managedReadEvidence(driftRoot, ['packages/main/src/story-owned.ts']),
        }),
        finalAssistantResultCount: 1, finalAssistantResultTruncated: false,
      }) },
    );
    const runResult = await hostHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: REVIEW_RUN_ID, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    git(driftRoot, ['checkout', 'main']);
    write(driftRoot, 'packages/main/src/unrelated-main-change.ts', 'export const unrelatedMainChange = true;\n');
    git(driftRoot, ['add', 'packages/main/src/unrelated-main-change.ts']);
    git(driftRoot, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'unrelated main material']);
    git(driftRoot, ['checkout', 'story/managed-import-drift']);
    git(driftRoot, ['merge', '--no-edit', 'main']);
    resetConfigCache();
    // The older ReviewRun freshness reader intentionally accepts this exact
    // whole-tree drift under its storyFilesHash advisory. Import is stricter:
    // it creates immutable gate evidence and must reject the old tuple.
    assert.doesNotThrow(() => assertCurrentReviewRunForEvidence(store, store.readStory(STORY_ID), driftRoot, LANE, REVIEW_RUN_ID),
      'control: advisory ReviewRun freshness accepts unrelated merged material drift');
    await eventually(async () => (await getManagedHostRunStatus({ root: driftRoot, runId: runResult.run.runId })).run.terminal !== null,
      'drift control managed reviewer did not complete');
    const receipt = managedHostRunReceipt(driftRoot, runResult.run.runId);
    assert.equal(verifyManagedReviewLiveBinding({
      gitCwd: driftRoot,
      metadataRoot: driftRoot,
      storyId: STORY_ID,
      expected: {
        headHash: updatedRun.headHash,
        materialHash: updatedRun.materialHash,
        storyFilesHash: updatedRun.storyFilesHash ?? '',
      },
    }).valid, false, 'canonical managed live binding rejects the advisory-stale source tree');
    const importHandlers = createManagedReviewEvidenceHandlers({ store, root: driftRoot, scanRoot: join(driftRoot, 'packages/main') });
    assert.throws(
      () => importHandlers.managed_review_evidence_import({ runId: runResult.run.runId, receiptId: receipt.receiptId }),
      /managed_review_live_(?:material_stale|head_lineage_invalid)/,
      'managed import must fail closed instead of accepting an advisory-stale ReviewRun tuple',
    );
    assert.equal(store.readReviewPasses(STORY_ID).passes.length, 0, 'rejected live drift creates no review evidence');
  } finally {
    resetConfigCache();
    rmSync(driftRoot, { recursive: true, force: true });
  }
}

/**
 * Importing the first managed receipt auto-commits only story metadata. That
 * must not strand another completed receipt from a different required lane in
 * the same ReviewRun round: the evidence remains bound to the signed tuple,
 * and the canonical material hash remains unchanged. A real source commit is
 * still not admissible for the third receipt.
 */
async function assertManagedImportAllowsSameMaterialMetadataAdvance(brokerPublicKey: string): Promise<void> {
  const metadataRoot = mkdtempSync(join(tmpdir(), 'managed-review-import-metadata-advance-'));
  try {
    const { store } = seedReviewStory(metadataRoot, brokerPublicKey);
    git(metadataRoot, ['checkout', '-b', 'story/managed-import-metadata-advance']);
    addCurrentReviewRun(metadataRoot, store, CONCEPT_LANE, CONCEPT_REVIEW_RUN_ID);
    refreshCandidateArtifact(metadataRoot, store, 'shadow');
    const completeReceipt = async (lane: string, reviewRunId: string): Promise<{ runId: string; receiptId: string }> => {
      const hostHandlers = createHostRunHandlers(
        { store, root: metadataRoot, scanRoot: join(metadataRoot, 'packages/main') },
        { runner: async () => ({
          stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
          finalAssistantResult: JSON.stringify({
            schemaVersion: 'lattice.managed_review_final_proposal.v1',
            storyId: STORY_ID,
            providerAgent: lane,
            lane,
            reviewRunId,
            conclusion: 'pass',
            note: `The ${lane} provider reviewed the signed managed tuple.`,
            ...managedReadEvidence(metadataRoot),
          }),
          finalAssistantResultCount: 1, finalAssistantResultTruncated: false,
        }) },
      );
      const submitted = await hostHandlers.host_run({
        host: 'codex', storyId: STORY_ID, agentType: lane, reviewRunId, lane,
        managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
      }) as HostRunDetachResult;
      await eventually(async () => (await getManagedHostRunStatus({ root: metadataRoot, runId: submitted.run.runId })).run.state === 'completed',
        `${lane} managed reviewer did not complete`);
      const receipt = managedHostRunReceipt(metadataRoot, submitted.run.runId);
      return { runId: submitted.run.runId, receiptId: receipt.receiptId };
    };

    const conceptReceipt = await completeReceipt(CONCEPT_LANE, CONCEPT_REVIEW_RUN_ID);
    const qualityReceipt = await completeReceipt(LANE, REVIEW_RUN_ID);
    const importHandlers = createManagedReviewEvidenceHandlers({
      store,
      root: metadataRoot,
      scanRoot: join(metadataRoot, 'packages/main'),
    });
    const reviewHeadBeforeImport = currentGitHead(metadataRoot)!;
    const reviewedMaterial = currentMaterialHash(metadataRoot)!;

    assert.match(
      importHandlers.managed_review_evidence_import(conceptReceipt),
      /Managed review evidence imported/,
      'the first lane receipt imports and records only story metadata',
    );
    assert.notEqual(currentGitHead(metadataRoot), reviewHeadBeforeImport,
      'the first import auto-commits its story metadata and advances HEAD');
    assert.equal(
      git(metadataRoot, ['show', '-s', '--format=%s', 'HEAD']),
      `${COMMIT_SUBJECT_PREFIX} record ${STORY_ID} managed_review_evidence_import metadata`,
      'the first metadata advance must be the canonical managed importer commit',
    );
    const firstImporterFiles = git(metadataRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n');
    assert.ok(firstImporterFiles.every(path => path.startsWith(`${PROOF_OR_STOP_STORY_DIR}/${STORY_ID}/`)),
      `canonical importer scope is story-local: ${firstImporterFiles.join(', ')}`);
    assert.ok(firstImporterFiles.includes(`${PROOF_OR_STOP_STORY_DIR}/${STORY_ID}/review-passes.json`), firstImporterFiles.join(', '));
    assert.equal(currentMaterialHash(metadataRoot), reviewedMaterial,
      'the metadata-only import commit preserves the reviewed material hash');
    const adjacentDirtyStory = store.readStory(STORY_ID);
    store.writeStory(STORY_ID, { ...adjacentDirtyStory, description: `${adjacentDirtyStory.description} adjacent importer dirt` });
    git(metadataRoot, ['add', `${PROOF_OR_STOP_STORY_DIR}/${STORY_ID}/index.json`]);
    assert.throws(
      () => importHandlers.managed_review_evidence_import(qualityReceipt),
      /story metadata has staged changes/,
      'receipt importer rejects pre-staged adjacent story metadata instead of sweeping it into an importer commit',
    );
    git(metadataRoot, ['reset', 'HEAD', '--', `${PROOF_OR_STOP_STORY_DIR}/${STORY_ID}/index.json`]);
    store.writeStory(STORY_ID, adjacentDirtyStory);
    assert.match(
      importHandlers.managed_review_evidence_import(qualityReceipt),
      /Managed review evidence imported/,
      'a second same-round receipt remains admissible after the first lane metadata commit',
    );
    assert.deepEqual(
      store.readReviewPasses(STORY_ID).passes.map(pass => pass.agent).sort(),
      [CONCEPT_LANE, LANE].sort(),
      'each required reviewer lane keeps its own receipt-bound review pass',
    );

    const manualStory = store.readStory(STORY_ID);
    store.writeStory(STORY_ID, { ...manualStory, description: `${manualStory.description} Manual metadata drift.` });
    git(metadataRoot, ['add', `${PROOF_OR_STOP_STORY_DIR}/${STORY_ID}/index.json`]);
    git(metadataRoot, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'manual same-material metadata drift']);
    assert.equal(currentMaterialHash(metadataRoot), reviewedMaterial,
      'control: the manual metadata-only commit preserves materialHash');
    assert.throws(
      () => importHandlers.managed_review_evidence_import(qualityReceipt),
      /managed_review_live_head_lineage_invalid/,
      'a same-material non-importer commit cannot admit an old managed receipt',
    );

    // F-235: the matching importer subject is insufficient when another
    // metadata tree happens to use the same story id and basename. Only the
    // configured canonical story directory owns an admissible importer advance.
    const beforeForeignLookalike = currentGitHead(metadataRoot)!;
    write(metadataRoot, `.lattice/foreign/${STORY_ID}/review-passes.json`, '{"forged":true}\n');
    git(metadataRoot, ['add', `.lattice/foreign/${STORY_ID}/review-passes.json`]);
    git(metadataRoot, [
      '-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit',
      '-m', `${COMMIT_SUBJECT_PREFIX} record ${STORY_ID} managed_review_evidence_import metadata`,
    ]);
    assert.equal(verifyManagedReviewLiveBinding({
      gitCwd: metadataRoot,
      metadataRoot,
      storyId: STORY_ID,
      expected: {
        headHash: beforeForeignLookalike,
        materialHash: reviewedMaterial,
        storyFilesHash: '',
      },
    }).valid, false,
    'same-subject lookalike metadata outside the configured story directory cannot advance managed receipt lineage');

    // assertManagedImportRejectsLiveMaterialDrift covers source/material drift.
    // This fixture isolates F-219's same-material non-importer lineage break.
    assert.equal(store.readReviewPasses(STORY_ID).passes.length, 2,
      'the rejected same-material lineage receipt creates no review pass');
  } finally {
    resetConfigCache();
    rmSync(metadataRoot, { recursive: true, force: true });
  }
}

/**
 * F-177: an import retry can observe a valid tuple before its receipt and
 * metadata locks, then a concurrent source commit can land while the importer
 * is locating prior evidence. The replay must revalidate under the locks
 * before it reuses that evidence or repairs the receipt binding.
 *
 * This deliberately injects the commit from the first locked metadata read.
 * The old one-time preflight accepted the replay; the in-lock revalidation
 * rejects it before any reuse-side binding write.
 */
async function assertManagedImportRejectsLateLiveMaterialDrift(brokerPublicKey: string): Promise<void> {
  const lateDriftRoot = mkdtempSync(join(tmpdir(), 'managed-review-import-late-live-drift-'));
  try {
    const { store } = seedReviewStory(lateDriftRoot, brokerPublicKey);
    const hostHandlers = createHostRunHandlers(
      { store, root: lateDriftRoot, scanRoot: join(lateDriftRoot, 'packages/main') },
      { runner: async () => ({
        stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
        finalAssistantResult: JSON.stringify({
          schemaVersion: 'lattice.managed_review_final_proposal.v1',
          storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: REVIEW_RUN_ID,
          conclusion: 'pass', note: 'An authentic receipt is safe only for its exact live review tuple.',
          ...managedReadEvidence(lateDriftRoot),
        }),
        finalAssistantResultCount: 1, finalAssistantResultTruncated: false,
      }) },
    );
    const submitted = await hostHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: REVIEW_RUN_ID, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root: lateDriftRoot, runId: submitted.run.runId })).run.state === 'completed',
      'late-drift managed reviewer did not complete');
    const receipt = managedHostRunReceipt(lateDriftRoot, submitted.run.runId);
    const handlers = createManagedReviewEvidenceHandlers({ store, root: lateDriftRoot, scanRoot: join(lateDriftRoot, 'packages/main') });
    assert.match(
      handlers.managed_review_evidence_import({ runId: submitted.run.runId, receiptId: receipt.receiptId }),
      /Managed review evidence imported/,
      'control: the exact current managed receipt imports before the late commit',
    );

    const originalReadFindings = store.readFindings.bind(store);
    let committedDuringLockedImport = false;
    store.readFindings = ((storyId: string) => {
      const data = originalReadFindings(storyId);
      if (!committedDuringLockedImport) {
        committedDuringLockedImport = true;
        write(lateDriftRoot, 'packages/main/src/late-import-drift.ts', 'export const lateImportDrift = true;\n');
        git(lateDriftRoot, ['add', 'packages/main/src/late-import-drift.ts']);
        git(lateDriftRoot, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'late import material drift']);
        resetConfigCache();
      }
      return data;
    }) as typeof store.readFindings;
    try {
      assert.throws(
        () => handlers.managed_review_evidence_import({ runId: submitted.run.runId, receiptId: receipt.receiptId }),
        /managed_review_live_material_stale/,
        'a commit after preflight but before reuse-side persistence must fail closed',
      );
    } finally {
      store.readFindings = originalReadFindings;
    }
    assert.equal(committedDuringLockedImport, true, 'the late source commit was injected from the locked import path');
    assert.equal(store.readReviewPasses(STORY_ID).passes.length, 1,
      'late drift cannot create or duplicate review evidence during idempotent receipt reuse');
  } finally {
    resetConfigCache();
    rmSync(lateDriftRoot, { recursive: true, force: true });
  }
}

/** F-189: managed receipt import must enforce the same candidate reads as native evidence. */
async function assertManagedImportEnforcesCandidateReadBinding(brokerPublicKey: string): Promise<void> {
  for (const scenario of ['pass', 'findings', 'complete'] as const) {
  const candidateRoot = mkdtempSync(join(tmpdir(), 'managed-review-import-candidate-binding-'));
  try {
    const { store } = seedReviewStory(candidateRoot, brokerPublicKey, { candidateRoutingMode: 'enforce' });
    const artifact = store.readCandidateSpecSet(STORY_ID);
    assert.ok(artifact && artifact.candidateSpecSet.length > 0,
      'candidate-binding fixture requires at least one routed document');
    const manifest = (filesReadFully: string[]) => ({
      filesReadFully,
      filesTriagedByName: [],
      scanEscalationReason: artifact!.scanEscalationReason,
      candidateSpecSetDigest: artifact!.artifactDigest,
      corpusDigest: artifact!.corpusDigest,
    });
    const completeReceipt = async (envelope: Record<string, unknown> | (() => Record<string, unknown>)): Promise<{ runId: string; receiptId: string }> => {
      const submitted = await createHostRunHandlers(
        { store, root: candidateRoot, scanRoot: join(candidateRoot, 'packages/main') },
        { runner: async () => ({
          stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
          finalAssistantResult: JSON.stringify(typeof envelope === 'function' ? envelope() : envelope),
          finalAssistantResultCount: 1,
          finalAssistantResultTruncated: false,
        }) },
      ).host_run({
        host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: REVIEW_RUN_ID, lane: LANE,
        managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
      }) as HostRunDetachResult;
      await eventually(async () => (await getManagedHostRunStatus({ root: candidateRoot, runId: submitted.run.runId })).run.terminal !== null,
        'candidate-binding managed reviewer did not reach terminal');
      const status = await getManagedHostRunStatus({ root: candidateRoot, runId: submitted.run.runId });
      assert.equal(status.run.terminal?.state, 'completed',
        `candidate-binding managed reviewer must complete: ${status.run.terminal?.reason}`);
      return { runId: submitted.run.runId, receiptId: managedHostRunReceipt(candidateRoot, submitted.run.runId).receiptId };
    };
    const envelope = (conclusion: 'pass' | 'findings', readManifest: ReturnType<typeof manifest>) => ({
      schemaVersion: 'lattice.managed_review_final_proposal.v1',
      storyId: STORY_ID,
      providerAgent: LANE,
      lane: LANE,
      reviewRunId: REVIEW_RUN_ID,
      conclusion,
      ...(conclusion === 'pass'
        ? { note: 'The provider completed the candidate-bound managed review.' }
        : { findings: [{
          desc: 'The provider found a candidate-bound managed review defect.',
          severity: 'medium',
          category: 'missing',
        }] }),
      readManifest,
      readLog: {
        filesReadFully: readManifest.filesReadFully,
        filesTriagedByName: [],
        summary: { readCount: readManifest.filesReadFully.length, tokenCount: null },
        digest: 'a'.repeat(64),
      },
    });
    const handlers = createManagedReviewEvidenceHandlers({
      store,
      root: candidateRoot,
      scanRoot: join(candidateRoot, 'packages/main'),
    });

    if (scenario !== 'complete') {
      const rejected = await completeReceipt(envelope(scenario, manifest(['packages/main/src/example.ts'])));
      assert.throws(
        () => handlers.managed_review_evidence_import(rejected),
        /candidate routing evidence rejected: read manifest is missing candidate full reads/,
        `a managed ${scenario} with matching routing digests but no full candidate read is rejected`,
      );
      assert.equal(store.readReviewPasses(STORY_ID).passes.length, 0,
        'candidate-incomplete managed evidence creates no REVIEW pass');
      assert.equal(store.readFindings(STORY_ID).findings.length, 0,
        'candidate-incomplete managed evidence creates no REVIEW finding');
      continue;
    }

    const acceptedPass = await completeReceipt(() => ({
      ...envelope('pass', manifest([])),
      ...managedReadEvidence(candidateRoot),
    }));
    assert.match(
      handlers.managed_review_evidence_import(acceptedPass),
      /Managed review evidence imported/,
      'a managed pass that fully reads every routed candidate imports successfully',
    );
    assert.match(
      handlers.managed_review_evidence_import(acceptedPass),
      /already imported/,
      'retry preserves a prior valid candidate-bound managed receipt without allocating duplicate evidence',
    );
    assert.equal(store.readReviewPasses(STORY_ID).passes.length, 1,
      'candidate-bound retry leaves exactly one imported managed pass');
  } finally {
    resetConfigCache();
    rmSync(candidateRoot, { recursive: true, force: true });
  }
}
}

async function main(): Promise<void> {
  assertHostOwnedMutationEnvDropsReviewerDispatchAuthority();
  const root = mkdtempSync(join(tmpdir(), 'managed-review-evidence-smoke-'));
  const originalCwd = process.cwd();
  const evaluatorMutationBoundary = process.env.LATTICE_VALID_TRUE_MUTATION_BOUNDARY;
  const bindingMutationTarget = process.env.LATTICE_BINDING_MUTATION_NAME;
  try {
    const brokerKeys = generateEd25519KeyPair();
    const { store, run, nativeDispatch } = seedReviewStory(root, brokerKeys.publicKey);
    let attemptSequence = 0;
    const newAttempt = (name: string): ReviewRun => {
      // Separate experiments need distinct signed runs, not another dispatch
      // that supersedes the native-authority control shared by this fixture.
      const reviewRunId = `${REVIEW_RUN_ID}:${name}-${++attemptSequence}`;
      const headHash = currentGitHead(root)!;
      const materialHash = currentMaterialHash(root)!;
      const storyFilesHash = currentStoryFilesHash(root)!;
      const attempt: ReviewRun = { ...run, reviewRunId, headHash, materialHash, storyFilesHash,
        _hash: signReviewRun(STORY_ID, reviewRunId, LANE, LANE, REVIEW_ROUND,
          REVIEW_ROUND, headHash, materialHash, run.promptHash, undefined, undefined, storyFilesHash),
      };
      bindCurrentReviewEnvelope(root, store, attempt);
      store.writeReviewRuns(STORY_ID, { runs: [...store.readReviewRuns(STORY_ID).runs, attempt] });
      return attempt;
    };
    if (process.argv[2] === '--descriptor-proposal-transport') {
      await assertDescriptorBackedProviderProposalTransport(root, store, run);
      console.log('managed-review-evidence descriptor-proposal-transport PASS');
      return;
    }
    // Current full-only authority rejects a pre-envelope run; legacy reconstruction
    // is no longer an allowed positive path. Preserve the actual broker config.
    const preEnvelopeRun: ReviewRun = { ...run, envelopeId: undefined, assembledPrompt: undefined,
      promptHash: hashReviewPrompt('retired pre-envelope fixture body') };
    assert.throws(() => buildManagedReviewerPrompt(root, preEnvelopeRun),
      /managed reviewer requires a current canonical full-envelope ReviewRun; pre-envelope runs must be renewed/,
      'managed reviewer must reject missing current envelope instead of reconstructing legacy authority');
    await assertManagedImportAllowsSameMaterialMetadataAdvance(brokerKeys.publicKey);
    await assertManagedImportRejectsLiveMaterialDrift(brokerKeys.publicKey);
    await assertManagedImportRejectsLateLiveMaterialDrift(brokerKeys.publicKey);
    await assertManagedImportEnforcesCandidateReadBinding(brokerKeys.publicKey);
    process.chdir(root);
    assert.equal(
      MAIN_TOOLS.some(tool => tool.name === 'native_review_invocation_issue'),
      false,
      'ordinary dispatch/review_run_start/raw CLI have no broker-attestation issuer command',
    );
    const mixedLineage = classifyNativeHostProcessLineage([
      { pid: 303, ppid: 202, comm: 'codex', command: 'codex exec' },
      { pid: 202, ppid: 1, comm: 'claude', command: 'claude review' },
    ]);
    assert.deepEqual(mixedLineage.providerFamilies, ['codex', 'claude']);
    assert.equal(mixedLineage.mixedProviderFamilies, true, 'full ancestry rejects Claude to Codex even when the nearest provider matches');
    const invocationClaims = {
      schemaVersion: 'lattice.native_review_invocation_attestation.v1' as const,
      brokerId: 'smoke-codex-broker',
      adapterId: 'codex-desktop',
      host: 'codex' as const,
      storyId: STORY_ID,
      agent: LANE,
      lane: LANE,
      reviewRunId: REVIEW_RUN_ID,
      writerSessionId: 'native-host-reviewer-session',
      dispatchPromptDigest: nativeDispatch.dispatchPromptDigest,
      dispatchBindingDigest: nativeDispatch.dispatchBindingDigest,
      hostRenderIdentityDigest: nativeDispatch.hostRenderIdentityDigest,
      invocationNonce: randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const brokerAttestation = signNativeReviewInvocationAttestation(invocationClaims, brokerKeys.privateKey);
    assert.equal(verifyNativeReviewInvocationAttestation({
      attestation: brokerAttestation,
      trustedBrokers: [{
        brokerId: 'smoke-codex-broker',
        adapterId: 'codex-desktop',
        host: 'codex',
        publicKey: brokerKeys.publicKey,
      }],
      expected: invocationClaims,
    }).ok, true, 'registered broker signature authorizes the exact native invocation without OS ancestry');
    let deliveredPrompt = '';
    let deliveredEnvironment: NodeJS.ProcessEnv = {};
    let proposalRaceReady = false;
    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>(resolve => { releaseTerminal = resolve; });
    const runner: HostRunRunner = async plan => {
      deliveredPrompt = plan.stdinText ?? '';
      deliveredEnvironment = { ...plan.env };
      const runId = plan.env.LATTICE_MANAGED_HOST_RUN_ID!;
      const proposalBarrier = join(root, `${runId}-proposal.go`);
      const workers = [0, 1].map(index => {
        const readyPath = join(root, `${runId}-proposal-${index}.ready`);
        const resultPath = join(root, `${runId}-proposal-${index}.result`);
        const child = spawn(process.execPath, [SELF, '--proposal-worker', root, runId, readyPath, proposalBarrier, resultPath], {
          cwd: root,
          env: plan.env,
          stdio: 'ignore',
        });
        return { child, exit: waitForExit(child), readyPath, resultPath };
      });
      await eventually(async () => workers.every(worker => {
        try { readFileSync(worker.readyPath); return true; } catch { return false; }
      }), 'real proposal workers did not reach their barrier');
      writeFileSync(proposalBarrier, 'go');
      assert.deepEqual(await Promise.all(workers.map(worker => worker.exit)), [0, 0]);
      const results = workers.map(worker => readFileSync(worker.resultPath, 'utf8'));
      assert.equal(results.filter(result => result === 'created').length, 1, 'real multiprocess proposal race has exactly one immutable winner');
      assert.equal(results.filter(result => /already has an immutable evidence proposal/.test(result)).length, 1,
        'real multiprocess proposal loser observes the immutable provider proposal');
      proposalRaceReady = true;
      await terminalGate;
      return { stdout: '{}\n', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
    };
    const hostHandlers = createHostRunHandlers({ store, root, scanRoot: join(root, 'packages/main') }, { runner });
    const detached = await hostHandlers.host_run({
      host: 'codex',
      storyId: STORY_ID,
      agentType: LANE,
      reviewRunId: REVIEW_RUN_ID,
      lane: LANE,
      managedReview: true,
      detach: true,
      deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS,
      json: true,
    }) as HostRunDetachResult;
    const submitted = detached.run;
    assert.match(deliveredPrompt, /BEGIN MANAGED REVIEW EVIDENCE PROTOCOL/);
    assert.match(deliveredPrompt, /overrides any generic reviewer-role instruction/i,
      'the managed final-envelope protocol explicitly supersedes generic reviewer role write instructions');
    assert.match(deliveredPrompt, /Do not call review_run_start, review_pass_set, or finding_add/);
    assert.match(
      deliveredEnvironment.LATTICE_MANAGED_REVIEW_PROPOSAL_CAPABILITY ?? '',
      /^[A-Za-z0-9+/]{43}=$/,
      'the provider receives an unguessable proposal bearer capability distinct from runId',
    );
    await eventually(async () => proposalRaceReady, 'real proposal workers did not finish before the terminal/import race');
    const importBarrier = join(root, 'import-barrier.go');
    const importWorkers = [0, 1].map(index => {
      const readyPath = join(root, `import-worker-${index}.ready`);
      const resultPath = join(root, `import-worker-${index}.result`);
      const child = spawn(process.execPath, [
        SELF, '--import-worker', root, submitted.runId, 'AUTO',
        readyPath, importBarrier, resultPath,
      ], { cwd: root, env: hostOwnedChildEnv(), stdio: 'ignore' });
      return { child, exit: waitForExit(child), readyPath, resultPath };
    });
    await eventually(async () => importWorkers.every(worker => {
      try { readFileSync(worker.readyPath); return true; } catch { return false; }
    }), 'concurrent import workers did not reach the pre-terminal barrier');
    writeFileSync(importBarrier, 'go');
    releaseTerminal();
    await eventually(async () => {
      const status = await getManagedHostRunStatus({ root, runId: submitted.runId });
      return status.run.state === 'completed';
    }, 'managed reviewer did not complete');
    const receipt = managedHostRunReceipt(root, submitted.runId);
    assert.deepEqual(await Promise.all(importWorkers.map(worker => worker.exit)), [0, 0],
      'real importer processes waiting before terminal creation both converge cleanly after the exclusive receipt appears');
    const concurrentImportResults = importWorkers.map(worker => readFileSync(worker.resultPath, 'utf8'));
    const handlers = createManagedReviewEvidenceHandlers({ store, root, scanRoot: join(root, 'packages/main') });

    // The executable-mutant registry invokes this binary once per isolated
    // source mutation.  Its evidence boundary is the exact sealed receipt
    // produced above; it must not spend the rest of the normal E2E matrix on
    // unrelated descriptor, lifecycle, and retention controls before proving
    // that the selected intake/REVIEW assertion bites.  Keeping this path
    // after the real proposal -> terminal -> concurrent import race preserves
    // the production binding seam while preventing the registry's bounded
    // child timeout from mistaking a late fixture teardown for a killed mutant.
    const assertSelectedEvaluatorMutation = (): void => {
      const passes = store.readReviewPasses(STORY_ID).passes;
      assert.equal(passes.length, 1,
        'the selected evaluator mutation fixture requires exactly one imported sealed pass');
      const originalPass = structuredClone(passes[0]!);
      const originalBinding = originalPass.managedEvidenceBinding;
      assert.ok(originalBinding,
        'the selected evaluator mutation fixture requires the imported pass to retain its managed evidence binding');
      const managedBinding = readManagedHostRunBinding(root, submitted.runId);
      const expectedBinding: ManagedReviewExpectedBinding = {
        providerHost: managedBinding.host,
        headHash: run.headHash,
        materialHash: run.materialHash,
        storyFilesHash: run.storyFilesHash ?? '',
        promptHash: run.promptHash,
        envelopeId: run.envelopeId ?? null,
        managedPromptDigest: managedBinding.promptDigest,
      };
      type IntakeArgs = Parameters<typeof createManagedReviewEvidenceBinding>[0];
      const exactIntake: IntakeArgs = {
        root,
        storyId: STORY_ID,
        providerAgent: LANE,
        lane: LANE,
        reviewRunId: REVIEW_RUN_ID,
        runId: submitted.runId,
        receiptId: receipt.receiptId,
        expected: expectedBinding,
      };
      type MutationCase = {
        name: string;
        mutateIntake: (value: IntakeArgs) => IntakeArgs;
        mutateBinding: (value: NonNullable<typeof originalPass.managedEvidenceBinding>) => NonNullable<typeof originalPass.managedEvidenceBinding>;
        /** Story ownership is implicit in the store key and is covered by the full normal matrix. */
        gateCoveredSeparately?: boolean;
      };
      const mutationCases: MutationCase[] = [
        { name: 'agent', mutateIntake: value => ({ ...value, providerAgent: 'proof-or-stop-review-concept' }), mutateBinding: value => ({ ...value!, providerAgent: 'proof-or-stop-review-concept' }) },
        {
          name: 'story',
          mutateIntake: value => ({ ...value, storyId: 'B-cross-story' }),
          mutateBinding: value => value!,
          gateCoveredSeparately: true,
        },
        { name: 'lane', mutateIntake: value => ({ ...value, lane: 'proof-or-stop-review-concept' }), mutateBinding: value => ({ ...value!, lane: 'proof-or-stop-review-concept' }) },
        { name: 'reviewRun', mutateIntake: value => ({ ...value, reviewRunId: `${STORY_ID}:RR-999` }), mutateBinding: value => ({ ...value!, reviewRunId: `${STORY_ID}:RR-999` }) },
        { name: 'provider', mutateIntake: value => ({ ...value, expected: { ...value.expected, providerHost: 'claude' } }), mutateBinding: value => ({ ...value!, providerHost: 'claude' }) },
        { name: 'head', mutateIntake: value => ({ ...value, expected: { ...value.expected, headHash: 'other-head' } }), mutateBinding: value => ({ ...value!, headHash: 'other-head' }) },
        { name: 'material', mutateIntake: value => ({ ...value, expected: { ...value.expected, materialHash: 'other-material' } }), mutateBinding: value => ({ ...value!, materialHash: 'other-material' }) },
        { name: 'storyFiles', mutateIntake: value => ({ ...value, expected: { ...value.expected, storyFilesHash: 'other-story-files' } }), mutateBinding: value => ({ ...value!, storyFilesHash: 'other-story-files' }) },
        { name: 'prompt', mutateIntake: value => ({ ...value, expected: { ...value.expected, promptHash: 'other-prompt' } }), mutateBinding: value => ({ ...value!, promptHash: 'other-prompt' }) },
        { name: 'envelope', mutateIntake: value => ({ ...value, expected: { ...value.expected, envelopeId: 'a'.repeat(64) } }), mutateBinding: value => ({ ...value!, envelopeId: 'a'.repeat(64) }) },
        { name: 'managedPrompt', mutateIntake: value => ({ ...value, expected: { ...value.expected, managedPromptDigest: 'sha256:other-managed-prompt' } }), mutateBinding: value => ({ ...value!, managedPromptDigest: 'sha256:other-managed-prompt' }) },
      ];
      const selectedMutations = bindingMutationTarget
        ? mutationCases.filter(mutation => mutation.name === bindingMutationTarget)
        : [mutationCases[0]!];
      assert.equal(selectedMutations.length, 1,
        'the bounded evaluator mutation fixture requires one explicit binding target');
      const mutation = selectedMutations[0]!;
      let intakeReason = '';
      if (evaluatorMutationBoundary !== 'gate') {
        try {
          createManagedReviewEvidenceBinding(mutation.mutateIntake(exactIntake));
          assert.fail(`fresh intake rejects ${mutation.name} mutation`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message === `fresh intake rejects ${mutation.name} mutation`) throw error;
          assert.match(message, /managed_review_evidence_import:/, `fresh intake rejects ${mutation.name} mutation`);
          intakeReason = message.replace(/^managed_review_evidence_import:\s*/, '');
        }
      }
      const mutatedBinding = mutation.mutateBinding(originalBinding);
      const mutatedPass = { ...originalPass, managedEvidenceBinding: mutatedBinding };
      mutatedPass._hash = signReviewPass(
        STORY_ID,
        mutatedPass.id,
        mutatedPass.agent,
        mutatedPass.note,
        mutatedPass.createdAt,
        mutatedPass.reviewRound ?? '',
        mutatedPass.reviewRunId ?? '',
        mutatedPass.readManifest,
        mutatedPass.readLog,
        mutatedPass.readDiagnostics,
        { writerSessionId: mutatedPass.writerSessionId!, sessionSource: mutatedPass.sessionSource! },
        mutatedPass.envelopeId,
        mutatedBinding,
      );
      store.writeReviewPasses(STORY_ID, { passes: [mutatedPass] });
      if (evaluatorMutationBoundary !== 'intake' && !mutation.gateCoveredSeparately) {
        const gate = collectReviewerEvidenceState(store, STORY_ID, root);
        const gateInvalid = gate.invalid.find(candidate => candidate.code === 'managed_receipt_invalid');
        assert.ok(gateInvalid, `REVIEW gate rejects persisted ${mutation.name} mutation`);
        if (intakeReason && mutation.name === 'agent') {
          assert.ok(gateInvalid!.message.endsWith(intakeReason),
            `fresh intake and REVIEW gate retain one canonical reason for ${mutation.name} mutation`);
        }
      }
      store.writeReviewPasses(STORY_ID, { passes: [originalPass] });
      const evidence = collectReviewerEvidenceState(store, STORY_ID, root);
      assert.ok(evidence.valid.some(candidate => candidate.id === originalPass.id),
        'the exact sealed managed evidence remains accepted after the selected mutation control');
      assert.equal(evidence.invalid.some(candidate => candidate.code === 'managed_receipt_invalid'), false);
    };
    if (evaluatorMutationBoundary || bindingMutationTarget) {
      assertSelectedEvaluatorMutation();
      console.log('managed-review-evidence selected-evaluator-mutation PASS');
      return;
    }

    // B-137a: the formal managed path consumes only the provider adapter's
    // bounded final assistant result. A tool shell is not required to inherit a
    // proposal capability and arbitrary streamed output is not an evidence
    // source. This injected runner is the same public adapter seam used by the
    // production Codex/Claude runners.
    const finalResultReviewRunId = newAttempt('finalResult').reviewRunId;
    const finalEnvelope = JSON.stringify({
      schemaVersion: 'lattice.managed_review_final_proposal.v1',
      storyId: STORY_ID,
      providerAgent: LANE,
      lane: LANE,
      reviewRunId: finalResultReviewRunId,
      conclusion: 'pass',
      note: 'The provider reviewed the exact managed material and found no blocking issue.',
      ...managedReadEvidence(root),
    });
    const codexMultiMessageRunner: HostRunRunner = plan => defaultHostRunRunner({
      ...plan,
      command: process.execPath,
      argv: ['-e', `for (const event of ${JSON.stringify([
        { type: 'item.completed', item: { type: 'agent_message', text: 'DISPATCH_START reviewer accepted the managed assignment' } },
        { type: 'item.completed', item: { type: 'reasoning', text: 'private reasoning is not a proposal candidate' } },
        { type: 'item.completed', item: { type: 'command_execution', aggregated_output: finalEnvelope } },
        { type: 'item.completed', item: { type: 'agent_message', text: 'Reviewed the first evidence group; continuing with adversarial paths.' } },
        { type: 'item.completed', item: { type: 'agent_message', text: finalEnvelope } },
      ])}) process.stdout.write(JSON.stringify(event) + '\\n');`],
    });
    const finalResultRun = await createHostRunHandlers(
      { store, root, scanRoot: join(root, 'packages/main') },
      { runner: codexMultiMessageRunner },
    ).host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: finalResultReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: 5_000, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: finalResultRun.run.runId })).run.terminal !== null,
      'final-result managed reviewer did not reach terminal');
    const finalResultReceipt = managedHostRunReceipt(root, finalResultRun.run.runId);
    assert.equal(finalResultReceipt.state, 'completed', 'an exact bounded final proposal completes the formal managed run');
    assert.match(finalResultReceipt.evidenceProposalDigest ?? '', /^sha256:/,
      'the worker seals the provider final-result proposal into terminal.json');
    assert.match(
      handlers.managed_review_evidence_import({ runId: finalResultRun.run.runId, receiptId: finalResultReceipt.receiptId }),
      /Managed review evidence imported/,
      'the exact provider final-result proposal is importable without a provider tool-shell callback',
    );
    store.writeReviewPasses(STORY_ID, {
      passes: store.readReviewPasses(STORY_ID).passes.filter(
        pass => pass.managedEvidenceBinding?.receiptId !== finalResultReceipt.receiptId,
      ),
    });

    const finalEnvelopeFor = (reviewRunId: string): string => JSON.stringify({ ...JSON.parse(finalEnvelope), reviewRunId });

    // Force the exact worker TOCTOU window after the initial no-proposal read,
    // but before the final-result writer takes the immutable-file fence.
    const submitProposalRace = async (
      runnerFor: (reviewRunId: string) => HostRunRunner,
      afterManagedReviewProposalPreRead?: (args: { runId: string; reviewRunId: string }) => void,
    ) => {
      const raceRun = newAttempt('proposal-race');
      return submitManagedHostRun({
      root,
      cwd: root,
      host: 'codex',
      storyId: STORY_ID,
      phase: 'REVIEW',
      agentType: LANE,
      reviewRunId: raceRun.reviewRunId,
      lane: LANE,
      promptText: buildManagedReviewerPrompt(root, raceRun),
      deadlineMs: 5_000,
      projectRootHash: `sha256:${'a'.repeat(64)}`,
      profile: 'managed_reviewer',
      reviewBinding: {
        headHash: raceRun.headHash,
        materialHash: raceRun.materialHash,
        storyFilesHash: raceRun.storyFilesHash ?? '',
        promptHash: raceRun.promptHash,
        envelopeId: raceRun.envelopeId ?? null,
      },
    }, {
      launchWorker: async request => {
        void runManagedHostRunWorker(request, {
          runner: runnerFor(raceRun.reviewRunId),
          afterManagedReviewProposalPreRead: args => afterManagedReviewProposalPreRead?.({ runId: args.runId, reviewRunId: raceRun.reviewRunId }),
        });
        return { pid: process.pid };
      },
      claimTimeoutMs: 2_000,
      claimPollMs: 10,
    });
    };

    // B-137a:F-187 regression. The cross-provider aggregate launches this
    // smoke after several long-running child suites. Reproduce an otherwise
    // healthy descriptor worker that cannot begin its durable claim for longer
    // than the former 2s test-only allowance. It must still claim and reach a
    // completed terminal; this is deliberately not a retry or a relaxation of
    // the formal evidence terminal contract.
    const delayedClaimReviewRunId = newAttempt('delayedClaim').reviewRunId;
    let delayedClaimWorkerError: unknown = null;
    let resolveDelayedClaimWorker: (() => void) | null = null;
    const delayedClaimWorkerFinished = new Promise<void>(resolve => {
      resolveDelayedClaimWorker = resolve;
    });
    const delayedClaimRun = await submitManagedHostRun({
      root,
      cwd: root,
      host: 'codex',
      storyId: STORY_ID,
      phase: 'REVIEW',
      agentType: LANE,
      reviewRunId: delayedClaimReviewRunId,
      lane: LANE,
      promptText: buildManagedReviewerPrompt(root, store.readReviewRuns(STORY_ID).runs.find(candidate => candidate.reviewRunId === delayedClaimReviewRunId)!),
      deadlineMs: MANAGED_REVIEW_DESCRIPTOR_DEADLINE_MS,
      projectRootHash: `sha256:${'f'.repeat(64)}`,
      profile: 'managed_reviewer',
      reviewBinding: {
        headHash: run.headHash,
        materialHash: run.materialHash,
        storyFilesHash: run.storyFilesHash ?? '',
        promptHash: run.promptHash,
        envelopeId: run.envelopeId ?? null,
      },
    }, {
      launchWorker: async request => {
        setTimeout(() => {
          void runManagedHostRunWorker(request, {
            runner: async () => ({
              stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
              finalAssistantResult: finalEnvelopeFor(delayedClaimReviewRunId),
              finalAssistantResultCount: 1,
              finalAssistantResultTruncated: false,
            }),
          }).catch(error => {
            delayedClaimWorkerError = error;
          }).finally(() => {
            resolveDelayedClaimWorker?.();
          });
        }, MANAGED_REVIEW_NESTED_CLAIM_DELAY_MS);
        return { pid: process.pid };
      },
      workerCapabilityTransport: 'descriptor',
      claimTimeoutMs: MANAGED_REVIEW_DESCRIPTOR_CLAIM_TIMEOUT_MS,
      claimPollMs: 10,
    });
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: delayedClaimRun.runId })).run.terminal !== null,
      'aggregate-pressure delayed descriptor worker did not reach terminal', MANAGED_REVIEW_DESCRIPTOR_DEADLINE_MS);
    await delayedClaimWorkerFinished;
    assert.equal(delayedClaimWorkerError, null,
      'aggregate-pressure delayed descriptor worker must claim and settle without an execution error');
    const delayedClaimStatus = await getManagedHostRunStatus({ root, runId: delayedClaimRun.runId });
    assert.equal(delayedClaimStatus.run.terminal?.state, 'completed',
      `aggregate-pressure delayed descriptor worker reaches completed rather than worker_claim_timeout: ${delayedClaimStatus.run.terminal?.reason}`);

    let compatibilityProviderEnv: NodeJS.ProcessEnv | null = null;
    const compatibilityRaceRun = await submitProposalRace(
      reviewRunId => async plan => {
        compatibilityProviderEnv = { ...plan.env };
        return {
          stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
          finalAssistantResult: finalEnvelopeFor(reviewRunId),
          finalAssistantResultCount: 1,
          finalAssistantResultTruncated: false,
        };
      },
      ({ runId, reviewRunId }) => {
        writeManagedReviewEvidenceProposal({
          root,
          runId,
          environment: compatibilityProviderEnv!,
          proposal: {
            storyId: STORY_ID,
            providerAgent: LANE,
            lane: LANE,
            reviewRunId,
            conclusion: 'pass',
            note: 'Compatibility proposal won exactly after the final-result pre-read.',
            ...managedReadEvidence(root),
          },
        });
      },
    );
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: compatibilityRaceRun.runId })).run.terminal !== null,
      'compatibility proposal race run did not reach terminal');
    const compatibilityRaceReceipt = managedHostRunReceipt(root, compatibilityRaceRun.runId);
    assert.equal(compatibilityRaceReceipt.state, 'completed',
      'a valid compatibility proposal that wins the final-result write race converges to one completed terminal');
    assert.equal(
      readManagedReviewEvidenceProposal(root, compatibilityRaceRun.runId)?.note,
      'Compatibility proposal won exactly after the final-result pre-read.',
      'the immutable compatibility proposal, rather than the losing final result, is sealed into the terminal binding',
    );
    assert.match(
      handlers.managed_review_evidence_import({ runId: compatibilityRaceRun.runId, receiptId: compatibilityRaceReceipt.receiptId }),
      /Managed review evidence imported/,
      'the completed race winner remains importable through the exact receipt binding',
    );
    store.writeReviewPasses(STORY_ID, {
      passes: store.readReviewPasses(STORY_ID).passes.filter(
        pass => pass.managedEvidenceBinding?.receiptId !== compatibilityRaceReceipt.receiptId,
      ),
    });

    const corruptCompatibilityRaceRun = await submitProposalRace(
      reviewRunId => async () => ({
        stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
        finalAssistantResult: finalEnvelopeFor(reviewRunId),
        finalAssistantResultCount: 1,
        finalAssistantResultTruncated: false,
      }),
      ({ runId }) => writeFileSync(join(
        managedHostRunDirectory(root, runId),
        'evidence-proposal.json',
      ), '{corrupted'),
    );
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: corruptCompatibilityRaceRun.runId })).run.terminal !== null,
      'corrupt compatibility proposal race run did not reach terminal');
    const corruptCompatibilityRaceReceipt = managedHostRunReceipt(root, corruptCompatibilityRaceRun.runId);
    const corruptCompatibilityRaceStatus = await getManagedHostRunStatus({ root, runId: corruptCompatibilityRaceRun.runId });
    assert.equal(corruptCompatibilityRaceReceipt.state, 'failed',
      'a corrupted proposal cannot be mistaken for the valid immutable race winner');
    assert.match(corruptCompatibilityRaceStatus.run.terminal?.reason ?? '', /^managed_review_final_result_invalid:/,
      'a corrupt competing proposal retains fail-closed final-result semantics');

    const missingProposalRun = await submitProposalRace(
      reviewRunId => async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' }),
    );
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: missingProposalRun.runId })).run.terminal !== null,
      'missing proposal control run did not reach terminal');
    const missingProposalReceipt = managedHostRunReceipt(root, missingProposalRun.runId);
    const missingProposalStatus = await getManagedHostRunStatus({ root, runId: missingProposalRun.runId });
    assert.equal(missingProposalReceipt.state, 'failed', 'a nonexistent proposal remains fail-closed');
    assert.match(missingProposalStatus.run.terminal?.reason ?? '', /^managed_review_final_result_invalid:managed_review_final_result_missing$/,
      'the race recovery cannot turn a missing proposal into a completed terminal');

    // The public managedReview seam must carry the same exact proposal protocol
    // through Claude without asking its detached tool shell for an impossible
    // interactive approval. Inspect the actual worker-produced spawn plan: the
    // prompt is private, under cwd, absent from argv, and removed after settle.
    let claudePromptFile: string | null = null;
    const previousWorkerCapabilityFd = process.env.LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD;
    process.env.LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD = '3';
    const claudeManagedRun = await createHostRunHandlers(
      { store, root, scanRoot: join(root, 'packages/main') },
      { runner: plan => {
        claudePromptFile = plan.promptFile ?? null;
        assert.equal(plan.command, 'claude');
        assert.equal(plan.env.LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD, undefined,
          'worker descriptor capability metadata is not inherited as ordinary provider authority');
        assert.ok(claudePromptFile && !isAbsolute(relative(plan.cwd, claudePromptFile))
          && !relative(plan.cwd, claudePromptFile).split(/[\\/]/).includes('..'),
        'public managed Claude prompt is inside the exact provider cwd');
        assert.equal(statSync(claudePromptFile).mode & 0o777, 0o600, 'public managed Claude prompt is mode 0600');
        assert.match(readFileSync(claudePromptFile, 'utf8'), /BEGIN MANAGED REVIEW EVIDENCE PROTOCOL/,
          'public managed Claude prompt carries the authoritative review protocol');
        assert.equal(plan.argv.includes(readFileSync(claudePromptFile, 'utf8')), false, 'managed prompt plaintext is absent from Claude argv');
        assert.deepEqual(
          plan.argv.slice(plan.argv.indexOf('--permission-mode'), plan.argv.indexOf('--permission-mode') + 2),
          ['--permission-mode', 'bypassPermissions'],
          'public managed Claude launch cannot block on interactive tool approval',
        );
        const schemaIndex = plan.argv.indexOf('--json-schema');
        assert.ok(schemaIndex >= 0 && typeof plan.argv[schemaIndex + 1] === 'string',
          'public managed Claude launch supplies its bounded structured-output schema');
        const fencedProse = `Review complete.\n\`\`\`json\n${finalEnvelopeFor(REVIEW_RUN_ID)}\n\`\`\``;
        return defaultHostRunRunner({
          ...plan,
          command: process.execPath,
          argv: ['-e', `process.stdout.write(${JSON.stringify(`${JSON.stringify({
            type: 'result',
            subtype: 'success',
            result: fencedProse,
            structured_output: JSON.parse(finalEnvelopeFor(REVIEW_RUN_ID)),
          })}\n`)})`],
        });
      } },
    ).host_run({
      host: 'claude', storyId: STORY_ID, agentType: LANE, reviewRunId: REVIEW_RUN_ID, lane: LANE,
      managedReview: true, detach: true, deadlineMs: 5_000, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: claudeManagedRun.run.runId })).run.terminal !== null,
      'public managed Claude transport did not reach terminal');
    assert.ok(claudePromptFile);
    assert.equal(existsSync(claudePromptFile!), false, 'public managed Claude prompt is removed after provider settlement');
    const claudeManagedReceipt = managedHostRunReceipt(root, claudeManagedRun.run.runId);
    assert.equal(claudeManagedReceipt.state, 'completed', 'Claude final proposal retains strict managed terminal semantics');
    assert.match(claudeManagedReceipt.evidenceProposalDigest ?? '', /^sha256:/);
    assert.match(
      handlers.managed_review_evidence_import({ runId: claudeManagedRun.run.runId, receiptId: claudeManagedReceipt.receiptId }),
      /Managed review evidence imported/,
      'public managed Claude final proposal is exactly importable',
    );
    store.writeReviewPasses(STORY_ID, {
      passes: store.readReviewPasses(STORY_ID).passes.filter(
        pass => pass.managedEvidenceBinding?.receiptId !== claudeManagedReceipt.receiptId,
      ),
    });
    if (previousWorkerCapabilityFd === undefined) delete process.env.LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD;
    else process.env.LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD = previousWorkerCapabilityFd;

    // Resolving a finding creates authoritative append-only lifecycle records.
    // Keep that experiment in its own project instead of erasing only its mirror.
    const findingsBeforeLifecycleCase = structuredClone(store.readFindings(STORY_ID));
    {
      const root = mkdtempSync(join(tmpdir(), 'managed-finding-lifecycle-'));
      try {
      const {store, run} = seedReviewStory(root, brokerKeys.publicKey);
      const handlers = createManagedReviewEvidenceHandlers({store, root, scanRoot: join(root, 'packages/main')});
    const findingsFinalReviewRunId = REVIEW_RUN_ID;
    const findingsExplanation = 'Provider explanation remains diagnostic and cannot become a formal finding or evidence field.';
    const findingsEnvelope = JSON.stringify({
      schemaVersion: 'lattice.managed_review_final_proposal.v1',
      storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: findingsFinalReviewRunId,
      ...managedReadEvidence(root),
      conclusion: 'findings',
      note: findingsExplanation,
      findings: [{
        desc: 'The provider found one exact managed-review defect.',
        severity: 'high',
        category: 'adversarial',
        files: ['packages/main/src/example.ts'],
        evidenceState: 'verified',
      }],
    });
    const findingsRun = await createHostRunHandlers(
      { store, root, scanRoot: join(root, 'packages/main') },
      { runner: async () => ({
        stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
        finalAssistantResult: findingsEnvelope,
        finalAssistantResultCount: 1,
        finalAssistantResultTruncated: false,
      }) },
    ).host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: findingsFinalReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: findingsRun.run.runId })).run.terminal !== null,
      'findings-with-explanation final result did not reach terminal');
    const findingsReceipt = managedHostRunReceipt(root, findingsRun.run.runId);
    assert.equal(findingsReceipt.state, 'completed', 'strict findings plus optional explanation complete the managed run');
    const findingsProposal = readManagedReviewEvidenceProposal(root, findingsRun.run.runId);
    assert.equal(findingsProposal?.conclusion, 'findings');
    assert.equal(findingsProposal?.findings?.length, 1, 'only the strict provider finding enters the immutable proposal');
    assert.equal(findingsProposal?.findings?.[0]?.desc, 'The provider found one exact managed-review defect.');
    assert.equal(findingsProposal?.note, undefined,
      'the optional findings explanation is deliberately discarded before formal proposal persistence');
    assert.equal(JSON.stringify(findingsProposal).includes(findingsExplanation), false,
      'diagnostic explanation bytes never become formal finding/proposal evidence');

    // B-137a:F-100 regression. The authorship digest once compared the LIVE
    // finding status against a hardcoded 'open' on the proposal side, so
    // finding_resolve (which mutates status in place) invalidated the finding's
    // OWN receipt: managed_receipt_invalid is absent from
    // SUPERSEDED_PASS_ISSUE_CODES, so it reached evidenceState.invalid and
    // machine.ts blocked REVIEW->TEST before the severity filter -- resolving a
    // managed finding deadlocked the gate at any severity. Import the finding,
    // then walk it through BOTH terminal lifecycle transitions and assert the
    // receipt survives each one. Re-pinning the literal makes this fail.
    const f100ImportOutput = handlers.managed_review_evidence_import({
      runId: findingsRun.run.runId,
      receiptId: findingsReceipt.receiptId,
    });
    assert.match(String(f100ImportOutput), /Managed review evidence imported/,
      'F-100 fixture: the provider-authored finding imports cleanly');
    const f100Imported = store.readFindings(STORY_ID).findings.find(
      finding => finding.managedEvidenceBinding?.receiptId === findingsReceipt.receiptId,
    );
    assert.ok(f100Imported, 'F-100 fixture: the imported managed finding is retrievable');
    const f100ManagedBinding = readManagedHostRunBinding(root, findingsRun.run.runId);
    const f100Expected: ManagedReviewExpectedBinding = {
      providerHost: f100ManagedBinding.host,
      headHash: run.headHash,
      materialHash: run.materialHash,
      storyFilesHash: run.storyFilesHash ?? '',
      promptHash: run.promptHash,
      envelopeId: run.envelopeId ?? null,
      managedPromptDigest: f100ManagedBinding.promptDigest,
    };
    const verifyF100 = (label: string) => {
      const current = store.readFindings(STORY_ID).findings.find(finding => finding.id === f100Imported!.id);
      assert.ok(current, `F-100 ${label}: finding still present`);
      const verification = verifyManagedReviewEvidence({
        root,
        storyId: STORY_ID,
        agent: current!.agent ?? LANE,
        reviewRunId: current!.reviewRunId ?? findingsFinalReviewRunId,
        lane: LANE,
        binding: current!.managedEvidenceBinding!,
        expected: f100Expected,
        evidence: { kind: 'finding', finding: current! },
      });
      assert.equal(verification.valid, true,
        `F-100 ${label}: the managed receipt must stay valid (reason=${verification.reason ?? 'none'})`);
    };
    verifyF100('as imported (status=open)');
    const f100Findings = createFindingHandlers({ store, root, scanRoot: join(root, 'packages/main') });
    // Host-owned finding_resolve is not a reviewer mutation. A leaked
    // PROOF_OR_STOP_AGENT from the managed-review boundary must be dropped first.
    // B-137a main-merge fix: this used the RETIRED LATTICE_* spellings, but
    // brandEnvNames() returns a canonical-only tuple, so readBrandEnv never read
    // them -- the guard could not fire and the negative assertion silently
    // stopped testing anything. Use the canonical names the guard actually reads.
    const previousAgent = process.env.PROOF_OR_STOP_AGENT;
    const previousRole = process.env.PROOF_OR_STOP_ACTIVITY_ROLE;
    process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-review-test-coverage';
    process.env.PROOF_OR_STOP_ACTIVITY_ROLE = 'proof-or-stop-review-test-coverage';
    try {
      assert.throws(
        () => f100Findings.finding_resolve({
          storyId: STORY_ID,
          findingId: f100Imported!.id,
          resolution: 'must not resolve under leaked reviewer dispatch authority',
        }),
        /agent_dispatch_mutation_denied/,
        'leaked PROOF_OR_STOP_AGENT must not reach host-owned finding_resolve',
      );
      assert.equal(
        store.readFindings(STORY_ID).findings.find(finding => finding.id === f100Imported!.id)?.status,
        'open',
        'denied finding_resolve must leave the managed finding open',
      );
      withHostOwnedMutationEnv(() => {
        assert.equal(process.env.PROOF_OR_STOP_AGENT, undefined, 'host-owned finding_resolve drops PROOF_OR_STOP_AGENT');
        assert.equal(process.env.PROOF_OR_STOP_ACTIVITY_ROLE, undefined, 'host-owned finding_resolve drops PROOF_OR_STOP_ACTIVITY_ROLE');
        f100Findings.finding_resolve({
          storyId: STORY_ID,
          findingId: f100Imported!.id,
          resolution: 'F-100 regression fixture: resolved to prove the managed receipt survives a host-owned lifecycle transition.',
        });
      });
    } finally {
      if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
      else process.env.PROOF_OR_STOP_AGENT = previousAgent;
      if (previousRole === undefined) delete process.env.PROOF_OR_STOP_ACTIVITY_ROLE;
      else process.env.PROOF_OR_STOP_ACTIVITY_ROLE = previousRole;
    }
    assert.equal(
      store.readFindings(STORY_ID).findings.find(finding => finding.id === f100Imported!.id)?.status,
      'resolved',
      'F-100 fixture: finding_resolve actually moved the lifecycle status',
    );
    verifyF100('after finding_resolve (status=resolved)');
    // B-137a:F-120: the runtime artifact reads after the receipt/proposal guard
    // are now inside the same fail-closed try/catch (see
    // managed-review-evidence.ts). This suite deliberately carries NO negative
    // fixture for it, because none is constructible: managedHostRunReceipt --
    // which runs inside the FIRST guard -- already reads terminal.json and
    // seal-validates spec.json / evidence-proposal.json / the binding, so every
    // corruption or removal of those artifacts is caught before the second block
    // executes, and deleting the whole run directory is caught there too
    // (verified empirically: each attempt refused with 'artifact read failed',
    // never 'runtime artifact read failed').
    //
    // The second guard is therefore defense-in-depth against a future reordering
    // or a partially written directory, NOT a currently reachable path -- so it
    // is asserted by inspection, not by a passing negative control. Recording
    // that honestly, rather than shipping a fixture that green-lights the first
    // guard while appearing to cover the second.
    const f120Verification = verifyManagedReviewEvidence({
      root,
      storyId: STORY_ID,
      agent: LANE,
      reviewRunId: findingsFinalReviewRunId,
      lane: LANE,
      binding: f100Imported!.managedEvidenceBinding!,
      expected: {
        providerHost: readManagedHostRunBinding(root, findingsRun.run.runId).host,
        headHash: run.headHash,
        materialHash: run.materialHash,
        storyFilesHash: run.storyFilesHash ?? '',
        promptHash: run.promptHash,
        envelopeId: run.envelopeId ?? null,
        managedPromptDigest: readManagedHostRunBinding(root, findingsRun.run.runId).promptDigest,
      },
      evidence: { kind: 'finding', finding: f100Imported! },
    });
    assert.equal(f120Verification.valid, true,
      `F-120: an intact managed run must still verify cleanly (reason=${f120Verification.reason ?? 'none'})`);

      } finally { resetConfigCache(); rmSync(root, {recursive: true, force: true}); }
    }
    assert.deepEqual(store.readFindings(STORY_ID), findingsBeforeLifecycleCase,
      'independent finding lifecycle case leaves the main fixture unchanged');

    for (const control of [
      { name: 'missing', result: {} },
      { name: 'malformed', result: { finalAssistantResult: '{', finalAssistantResultCount: 1, finalAssistantResultTruncated: false } },
      { name: 'multiple', result: { finalAssistantResult: finalEnvelope, finalAssistantResultCount: 2, finalAssistantResultTruncated: false } },
      { name: 'oversize', result: { finalAssistantResult: null, finalAssistantResultCount: 1, finalAssistantResultTruncated: true } },
    ] as const) {
      const controlledReviewRunId = newAttempt(`final-control-${control.name}`).reviewRunId;
      const controlled = await createHostRunHandlers(
        { store, root, scanRoot: join(root, 'packages/main') },
        { runner: async () => ({
          stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
          ...control.result,
        }) },
      ).host_run({
        host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: controlledReviewRunId, lane: LANE,
        managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
      }) as HostRunDetachResult;
      await eventually(async () => (await getManagedHostRunStatus({ root, runId: controlled.run.runId })).run.terminal !== null,
        `${control.name} final-result control did not reach terminal`);
      const controlledStatus = await getManagedHostRunStatus({ root, runId: controlled.run.runId });
      const controlledReceipt = managedHostRunReceipt(root, controlled.run.runId);
      assert.equal(controlledReceipt.state, 'failed', `${control.name} final result fails closed`);
      assert.match(controlledStatus.run.terminal?.reason ?? '', new RegExp(`managed_review_final_result_(?:invalid:managed_review_final_result_)?${control.name}`));
      assert.equal(controlledReceipt.evidenceProposalDigest, null, `${control.name} final result cannot mint proposal evidence`);
    }

    // The evaluator-mutant children prove only importer/REVIEW admission from
    // the pre-sealed fixture below. Keep this independent real child/descriptor
    // transport E2E in normal mode: its deadline/worker scheduling is not an
    // evaluator boundary and must not obscure the intended mutant refusal.
    if (!evaluatorMutationBoundary) {
    const sanitizedReviewRunId = newAttempt('sanitized').reviewRunId;
    let sanitizedAttestation: ReturnType<typeof signManagedReviewProposalInvocation> | null = null;
    const sanitizedToolRunner: HostRunRunner = async plan => {
      const gatePath = join(root, `${plan.env.LATTICE_MANAGED_HOST_RUN_ID}-sanitized-tool.go`);
      const child = spawn(process.execPath, [SELF, '--sanitized-proposal-tool', root, gatePath, sanitizedReviewRunId], {
        cwd: root,
        detached: true,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      });
      assert.ok(child.pid);
      const providerIdentity = {
        pid: child.pid!,
        pgid: child.pid!,
        spawnedAt: new Date().toISOString(),
        startFingerprint: 'sanitized-provider-start-fingerprint',
        processGroupIsolated: true as const,
      };
      plan.onSpawn?.(providerIdentity);
      const privateKey = plan.env.LATTICE_MANAGED_REVIEW_PROPOSAL_CAPABILITY!;
      const attestation = signManagedReviewProposalInvocation({
        schemaVersion: 'lattice.managed_review_proposal_invocation.v1',
        runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!,
        storyId: STORY_ID,
        providerAgent: LANE,
        lane: LANE,
        reviewRunId: sanitizedReviewRunId,
        providerIdentity,
        invocationNonce: randomUUID(),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }, privateKey);
      sanitizedAttestation = attestation;
      const descriptor = child.stdio[3] as NodeJS.WritableStream;
      descriptor.write(`${JSON.stringify(attestation)}\n`);
      descriptor.end();
      writeFileSync(gatePath, 'go');
      let stdout = '';
      let stderr = '';
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', chunk => { stdout += String(chunk); });
      child.stderr!.on('data', chunk => { stderr += String(chunk); });
      const status = await waitForExit(child);
      if (status !== 0) throw new Error(`sanitized provider tool failed: ${stderr}${stdout}`);
      return {
        stdout,
        stderr,
        exitCode: status ?? 1,
        timedOut: false,
        terminalReason: status === 0 ? 'completed' : 'exit_nonzero',
        finalAssistantResult: 'Compatibility adapter already submitted its signed provider proposal.',
        finalAssistantResultCount: 1,
        finalAssistantResultTruncated: false,
      };
    };
    const sanitizedRun = await createHostRunHandlers(
      { store, root, scanRoot: join(root, 'packages/main') },
      { runner: sanitizedToolRunner },
    ).host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: sanitizedReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: 5_000, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: sanitizedRun.run.runId })).run.terminal !== null,
      'sanitized provider tool run did not reach terminal');
    const sanitizedStatus = await getManagedHostRunStatus({ root, runId: sanitizedRun.run.runId });
    const sanitizedReceipt = managedHostRunReceipt(root, sanitizedRun.run.runId);
    assert.equal(sanitizedReceipt.state, 'completed',
      `sanitized Codex-style tool environment can submit a provider proposal without inherited bearer env: ${sanitizedStatus.run.terminal?.reason}`);
    assert.match(sanitizedReceipt.evidenceProposalDigest ?? '', /^sha256:/, 'successful formal provider terminal seals its proposal');
    const sanitizedImport = handlers.managed_review_evidence_import({
      runId: sanitizedRun.run.runId,
      receiptId: sanitizedReceipt.receiptId,
    });
    assert.match(sanitizedImport, /Managed review evidence imported/, 'exact sanitized provider receipt is importable');
    assert.ok(sanitizedAttestation, 'sanitized provider emitted one signed invocation attestation');
    const replayedSanitizedAttestation = await runManagedProposalCliWithAttestation(root, {
      storyId: STORY_ID,
      providerAgent: LANE,
      lane: LANE,
      reviewRunId: sanitizedReviewRunId,
      conclusion: 'pass',
      note: 'An old provider invocation attestation cannot authorize a later write.',
      ...managedReadEvidence(root),
    }, sanitizedAttestation);
    assert.notEqual(replayedSanitizedAttestation.status, 0,
      'old provider attestation replay fails after its exact managed run reaches terminal');
    assert.match(`${replayedSanitizedAttestation.stderr}\n${replayedSanitizedAttestation.stdout}`,
      /proposal is accepted only while the managed provider run is active|proposal invocation attestation is invalid or already consumed/,
      'old provider attestation replay is rejected by terminal/one-shot authority');
    // Keep the existing mutation matrix isolated from this additional transport E2E.
    // The assertion above exercised the real importer; subsequent checks retain their
    // historical single managed receipt fixture.
    store.writeReviewPasses(STORY_ID, {
      passes: store.readReviewPasses(STORY_ID).passes.filter(
        pass => pass.managedEvidenceBinding?.receiptId !== sanitizedReceipt.receiptId,
      ),
    });
    }

    // The executable evaluator-mutant children below prove only importer and
    // REVIEW admission. They use the already-sealed in-process receipt; the
    // independently runnable descriptor transport mode above owns the real
    // fake-Codex fd-3 transport assertion. Do not let transport setup obscure
    // an evaluator mutation's intended boundary.
    if (!evaluatorMutationBoundary) {
    const descriptorReviewRun = newAttempt('descriptor');
    const descriptorReviewRunId = descriptorReviewRun.reviewRunId;
    const fakeBin = join(root, PROOF_OR_STOP_DIR, 'runtime', 'fake-provider-bin');
    mkdirSync(fakeBin, { recursive: true });
    const fakeCodex = join(fakeBin, 'codex');
    const providerProposal = JSON.stringify({
      storyId: STORY_ID,
      providerAgent: LANE,
      lane: LANE,
      reviewRunId: descriptorReviewRunId,
      conclusion: 'pass',
      note: 'Real descriptor-brokered Codex-style tool submitted this exact verdict.',
      ...managedReadEvidence(root),
    });
    writeFileSync(fakeCodex, `#!/bin/sh
cat >/dev/null
exec /usr/bin/env -i PATH="$PATH" LATTICE_MANAGED_REVIEW_INVOCATION_FD=3 "$LATTICE_TEST_NODE" "$LATTICE_TEST_CLI" managed_review_proposal_set '${providerProposal}'
`);
    chmodSync(fakeCodex, 0o700);
    let descriptorPrivateKey = '';
    const descriptorLauncher: import('../core/managed-host-run.js').ManagedHostRunWorkerLauncher = request => {
      const child = spawn(process.execPath, [CLI, '--root', request.root, 'host_run_worker', JSON.stringify({ runId: request.runId })], {
        cwd: request.root,
        detached: true,
        env: {
          ...process.env,
          LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD: '3',
        },
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      });
      assert.ok(child.pid && request.proposalInvocationPrivateKey);
      descriptorPrivateKey = request.proposalInvocationPrivateKey!;
      const capabilityPipe = child.stdio[3];
      assert.ok(capabilityPipe && 'end' in capabilityPipe);
      capabilityPipe.end(request.proposalInvocationPrivateKey);
      child.unref();
      return { pid: child.pid! };
    };
    const descriptorRun = await submitManagedHostRun({
      root,
      cwd: root,
      host: 'codex',
      storyId: STORY_ID,
      phase: 'REVIEW',
      agentType: LANE,
      reviewRunId: descriptorReviewRunId,
      lane: LANE,
      promptText: buildManagedReviewerPrompt(root, store.readReviewRuns(STORY_ID).runs.find(candidate => candidate.reviewRunId === descriptorReviewRunId)!),
      deadlineMs: MANAGED_REVIEW_DESCRIPTOR_DEADLINE_MS,
      projectRootHash: `sha256:${'1'.repeat(64)}`,
      profile: 'managed_reviewer',
      environment: {
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        LATTICE_TEST_NODE: process.execPath,
        LATTICE_TEST_CLI: CLI,
        PROOF_OR_STOP_USAGE_LEDGER: '0',
      },
      reviewBinding: {
        headHash: descriptorReviewRun.headHash,
        materialHash: descriptorReviewRun.materialHash,
        storyFilesHash: descriptorReviewRun.storyFilesHash ?? '',
        promptHash: descriptorReviewRun.promptHash,
        envelopeId: descriptorReviewRun.envelopeId ?? null,
      },
    }, {
      launchWorker: descriptorLauncher,
      workerCapabilityTransport: 'descriptor',
      claimTimeoutMs: MANAGED_REVIEW_DESCRIPTOR_CLAIM_TIMEOUT_MS,
      claimPollMs: 10,
    });
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: descriptorRun.runId })).run.terminal !== null,
      'real descriptor-brokered provider did not reach terminal');
    const descriptorStatus = await getManagedHostRunStatus({ root, runId: descriptorRun.runId });
    const descriptorResult = readManagedHostRunResult(root, descriptorRun.runId);
    assert.equal(descriptorStatus.run.terminal?.state, 'completed',
      `real Codex-style sanitized tool env reaches a successful provider terminal: ${descriptorStatus.run.terminal?.reason}; `
      + `stderr=${descriptorResult?.stderr ?? '<no result>'}`);
    const descriptorReceipt = managedHostRunReceipt(root, descriptorRun.runId);
    assert.match(descriptorReceipt.evidenceProposalDigest ?? '', /^sha256:/,
      'the descriptor-brokered provider proposal is sealed into its terminal receipt');
    assert.equal(existsSync(join(managedHostRunDirectory(root, descriptorRun.runId), 'input.cap')), false,
      'production descriptor transport never persists its private proposal signing key');
    const persistedRunFiles = readdirSync(managedHostRunDirectory(root, descriptorRun.runId))
      .map(name => join(managedHostRunDirectory(root, descriptorRun.runId), name))
      .filter(path => statSync(path).isFile());
    assert.ok(descriptorPrivateKey.length > 0 && persistedRunFiles.every(path => !readFileSync(path).includes(descriptorPrivateKey)),
      'the worker/provider private proposal signing key appears in no durable run artifact');
    assert.match(
      handlers.managed_review_evidence_import({ runId: descriptorRun.runId, receiptId: descriptorReceipt.receiptId }),
      /Managed review evidence imported/,
      'the real sanitized provider proposal remains exactly importable',
    );
    store.writeReviewPasses(STORY_ID, {
      passes: store.readReviewPasses(STORY_ID).passes.filter(
        pass => pass.managedEvidenceBinding?.receiptId !== descriptorReceipt.receiptId,
      ),
    });
    }

    if (!evaluatorMutationBoundary) {
    const previousManagedRun = process.env.LATTICE_MANAGED_HOST_RUN_ID;
    const previousAgent = process.env.PROOF_OR_STOP_AGENT;
    process.env.LATTICE_MANAGED_HOST_RUN_ID = submitted.runId;
    process.env.PROOF_OR_STOP_AGENT = LANE;
    try {
      const ordinaryEvidence = createFindingHandlers({ store, root, scanRoot: join(root, 'packages/main') });
      assert.throws(() => ordinaryEvidence.review_pass_set({
        storyId: STORY_ID,
        agent: LANE,
        reviewRunId: REVIEW_RUN_ID,
        note: 'Attempt to bypass the managed terminal receipt.',
        readManifest: { filesReadFully: ['packages/main/src/example.ts'], filesTriagedByName: [], scanEscalationReason: null },
      }), /direct final reviewer evidence is forbidden[\s\S]*final assistant result[\s\S]*managed adapter/i);
      assert.throws(() => ordinaryEvidence.finding_add({
        storyId: STORY_ID,
        agent: LANE,
        reviewRunId: REVIEW_RUN_ID,
        desc: 'Attempt to bypass the managed terminal receipt with a direct finding.',
        severity: 'high',
        category: 'adversarial',
        readManifest: { filesReadFully: ['packages/main/src/example.ts'], filesTriagedByName: [], scanEscalationReason: null },
      }), /direct final reviewer evidence is forbidden[\s\S]*final assistant result[\s\S]*managed adapter/i);
    } finally {
      if (previousManagedRun === undefined) delete process.env.LATTICE_MANAGED_HOST_RUN_ID;
      else process.env.LATTICE_MANAGED_HOST_RUN_ID = previousManagedRun;
      if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
      else process.env.PROOF_OR_STOP_AGENT = previousAgent;
    }

    assert.throws(
      () => (handlers.managed_review_evidence_import as (value: Record<string, unknown>) => unknown)({
        runId: submitted.runId,
        receiptId: receipt.receiptId,
        conclusion: 'findings',
      }),
      /verdict overrides are not accepted/,
      'controller must not be able to add or override proposal verdict fields',
    );
    assert.throws(
      () => handlers.managed_review_evidence_import({ runId: submitted.runId, receiptId: 'sha256:forged' }),
      /signature_invalid|producer_owned_required/,
    );

    let releasePreterminal!: () => void;
    let duplicateProposalRejected = false;
    const preterminalGate = new Promise<void>(resolve => { releasePreterminal = resolve; });
    const preterminalReviewRunId = newAttempt('preterminal').reviewRunId;
    const preterminalHandlers = createHostRunHandlers(
      { store, root, scanRoot: join(root, 'packages/main') },
      { runner: async plan => {
        const proposal = {
          storyId: STORY_ID,
          providerAgent: LANE,
          lane: LANE,
          reviewRunId: preterminalReviewRunId,
          conclusion: 'pass' as const,
          note: 'Provider proposal exists but the terminal has not been sealed yet.',
          ...managedReadEvidence(root),
        };
        writeManagedReviewEvidenceProposal({ root, runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!, environment: plan.env, proposal });
        try {
          writeManagedReviewEvidenceProposal({ root, runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!, environment: plan.env, proposal });
        } catch (error) {
          duplicateProposalRejected = /already has an immutable evidence proposal/.test(error instanceof Error ? error.message : String(error));
        }
        await preterminalGate;
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
      } },
    );
    const preterminal = await preterminalHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: preterminalReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => duplicateProposalRejected, 'provider proposal was not durably written before the preterminal assertion');
    assert.throws(
      () => handlers.managed_review_evidence_import({ runId: preterminal.run.runId, receiptId: 'sha256:not-terminal' }),
      /producer_owned_required|signature_invalid/,
      'a provider proposal before terminal must not become final evidence',
    );
    assert.equal(duplicateProposalRejected, true, 'a provider can author exactly one immutable proposal per run');
    releasePreterminal();
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: preterminal.run.runId })).run.state === 'completed', 'preterminal control run did not finish');

    let releaseForgery!: () => void;
    let forgedTargetEnvironment: NodeJS.ProcessEnv | null = null;
    const forgeryGate = new Promise<void>(resolve => { releaseForgery = resolve; });
    const forgeryReviewRunId = newAttempt('forgery').reviewRunId;
    const forgeryHandlers = createHostRunHandlers(
      { store, root, scanRoot: join(root, 'packages/main') },
      { runner: async plan => {
        forgedTargetEnvironment = { ...plan.env };
        await forgeryGate;
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
      } },
    );
    const forgeryRun = await forgeryHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: forgeryReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: 5_000, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => forgedTargetEnvironment !== null, 'managed provider did not receive its proposal environment');
    const forgedProposal = {
      storyId: STORY_ID,
      providerAgent: LANE,
      lane: LANE,
      reviewRunId: forgeryReviewRunId,
      conclusion: 'pass' as const,
      note: 'Authentic provider-only proposal capability control.',
      ...managedReadEvidence(root),
    };
    assert.throws(
      () => writeManagedReviewEvidenceProposal({
        root,
        runId: forgeryRun.run.runId,
        environment: forgedTargetEnvironment!,
        proposal: {
          ...forgedProposal,
          conclusion: 'findings',
          note: undefined,
          findings: [{
            desc: 'Provider supplied an unknown nested finding vocabulary.',
            severity: 'urgent',
            category: 'invented',
            evidenceState: 'trusted',
            files: ['packages/main/src/example.ts'],
            controllerOverride: true,
          }],
        } as unknown as Parameters<typeof writeManagedReviewEvidenceProposal>[0]['proposal'],
      }),
      /strict managed finding schema/,
      'proposal persistence rejects unknown nested severity/category/evidenceState and extra fields',
    );
    assert.throws(
      () => writeManagedReviewEvidenceProposal({
        root,
        runId: forgeryRun.run.runId,
        environment: forgedTargetEnvironment!,
        proposal: {
          ...forgedProposal,
          conclusion: 'findings',
          note: 'short one',
          findings: [{
            desc: 'Compatibility ingress must preserve the documented note minimum.',
            severity: 'high',
            category: 'adversarial',
            evidenceState: 'verified',
          }],
        },
      }),
      /diagnostic note >= 10 chars/,
      'compatibility proposal ingress rejects a trimmed findings note shorter than ten characters',
    );
    const rawSameUidProposal = spawnSync(process.execPath, [CLI, 'managed_review_proposal_set', JSON.stringify(forgedProposal)], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    assert.notEqual(rawSameUidProposal.status, 0,
      'same-UID raw CLI without the broker descriptor cannot submit a managed reviewer proposal');
    assert.match(`${rawSameUidProposal.stderr ?? ''}\n${rawSameUidProposal.stdout ?? ''}`,
      /match exactly one active managed reviewer|proposal capability or agent identity is missing or mismatched/,
      'same-UID raw CLI remains outside the provider invocation authority boundary');
    const detachedToolChild = spawn(process.execPath, [CLI, 'managed_review_proposal_set', JSON.stringify(forgedProposal)], {
      cwd: root,
      detached: true,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let detachedToolStdout = '';
    let detachedToolStderr = '';
    detachedToolChild.stdout!.setEncoding('utf8');
    detachedToolChild.stderr!.setEncoding('utf8');
    detachedToolChild.stdout!.on('data', chunk => { detachedToolStdout += String(chunk); });
    detachedToolChild.stderr!.on('data', chunk => { detachedToolStderr += String(chunk); });
    const detachedToolStatus = await waitForExit(detachedToolChild);
    assert.notEqual(detachedToolStatus, 0,
      'a provider tool moved into a different process group/session fails closed without its signed descriptor');
    assert.match(`${detachedToolStderr}\n${detachedToolStdout}`,
      /match exactly one active managed reviewer|proposal capability or agent identity is missing or mismatched/,
      'PGID fallback never authorizes an ambiguous or different-session tool process');
    for (const [name, environment] of [
      ['missing capability', { LATTICE_MANAGED_HOST_RUN_ID: forgeryRun.run.runId, PROOF_OR_STOP_AGENT: LANE }],
      ['forged capability', { LATTICE_MANAGED_HOST_RUN_ID: forgeryRun.run.runId, PROOF_OR_STOP_AGENT: LANE, LATTICE_MANAGED_REVIEW_PROPOSAL_CAPABILITY: 'forged-same-uid-capability' }],
      ['wrong provider agent', { ...forgedTargetEnvironment!, PROOF_OR_STOP_AGENT: 'proof-or-stop-review-concept' }],
    ] as const) {
      assert.throws(
        () => writeManagedReviewEvidenceProposal({ root, runId: forgeryRun.run.runId, environment, proposal: forgedProposal }),
        /proposal capability or agent identity is missing or mismatched/,
        `${name} cannot impersonate the active managed provider`,
      );
    }
    releaseForgery();
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: forgeryRun.run.runId })).run.state === 'failed', 'forgery negative-control run did not fail closed', 5_000);
    const forgeryReceipt = managedHostRunReceipt(root, forgeryRun.run.runId);
    assert.equal(forgeryReceipt.evidenceProposalDigest, null,
      'a managed reviewer with no trusted final result cannot seal a null-proposal success');
    assert.throws(
      () => handlers.managed_review_evidence_import({ runId: forgeryRun.run.runId, receiptId: forgeryReceipt.receiptId }),
      /producer_owned_required|signature_invalid/,
      'a successful terminal without an authenticated provider proposal remains inadmissible',
    );

    const failedReviewRunId = newAttempt('failed').reviewRunId;
    const failedHandlers = createHostRunHandlers(
      { store, root, scanRoot: join(root, 'packages/main') },
      { runner: async plan => {
        writeManagedReviewEvidenceProposal({
          root,
          runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!,
          environment: plan.env,
          proposal: {
            storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: failedReviewRunId,
            conclusion: 'pass', note: 'Provider proposal cannot survive a failed provider terminal.',
            ...managedReadEvidence(root),
          },
        });
        return { stdout: '', stderr: 'failed', exitCode: 7, timedOut: false, terminalReason: 'exit_nonzero' };
      } },
    );
    const failed = await failedHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: failedReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: failed.run.runId })).run.state === 'failed', 'failed managed reviewer did not reach terminal');
    const failedReceipt = managedHostRunReceipt(root, failed.run.runId);
    assert.throws(
      () => handlers.managed_review_evidence_import({ runId: failed.run.runId, receiptId: failedReceipt.receiptId }),
      /producer_owned_required|signature_invalid/,
      'a failed terminal must not become final reviewer evidence',
    );

    let releaseCancelled!: () => void;
    let cancelledProposalReady = false;
    const cancelledGate = new Promise<void>(resolve => { releaseCancelled = resolve; });
    const cancelledReviewRunId = newAttempt('cancelled').reviewRunId;
    const cancelledHandlers = createHostRunHandlers(
      { store, root, scanRoot: join(root, 'packages/main') },
      { runner: async plan => {
        writeManagedReviewEvidenceProposal({
          root,
          runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!,
          environment: plan.env,
          proposal: {
            storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: cancelledReviewRunId,
            conclusion: 'pass', note: 'Cancellation must defeat this otherwise authentic proposal.',
            ...managedReadEvidence(root),
          },
        });
        cancelledProposalReady = true;
        await cancelledGate;
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
      } },
    );
    const cancelled = await cancelledHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: cancelledReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => cancelledProposalReady, 'cancelled managed reviewer did not publish its provider proposal');
    await cancelManagedHostRun({ root, runId: cancelled.run.runId, reason: 'cancelled evidence control' });
    releaseCancelled();
    await eventually(async () => (await getManagedHostRunStatus({
      root,
      runId: cancelled.run.runId,
    })).run.state === 'cancelled', 'cancelled managed reviewer did not converge after its fenced provider returned');
    const cancelledStatus = await getManagedHostRunStatus({ root, runId: cancelled.run.runId });
    assert.equal(cancelledStatus.run.state, 'cancelled');
    const cancelledReceipt = managedHostRunReceipt(root, cancelled.run.runId);
    assert.throws(
      () => handlers.managed_review_evidence_import({ runId: cancelled.run.runId, receiptId: cancelledReceipt.receiptId }),
      /producer_owned_required|signature_invalid/,
      'a cancelled terminal cannot upgrade an authentic provider proposal into REVIEW evidence',
    );
    const timedOutReviewRunId = newAttempt('timedOut').reviewRunId;
    const timedOutHandlers = createHostRunHandlers(
      { store, root, scanRoot: join(root, 'packages/main') },
      { runner: async plan => {
        writeManagedReviewEvidenceProposal({
          root,
          runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!,
          environment: plan.env,
          proposal: {
            storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: timedOutReviewRunId,
            conclusion: 'pass', note: 'Timed-out evidence control.',
            ...managedReadEvidence(root),
          },
        });
        return { stdout: '', stderr: '', exitCode: 124, timedOut: true, timeoutKind: 'total_timeout', terminalReason: 'total_timeout' };
      } },
    );
    const timedOut = await timedOutHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: timedOutReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: timedOut.run.runId })).run.state === 'timed_out',
      'timed-out managed reviewer did not reach terminal truth');
    const timedOutReceipt = managedHostRunReceipt(root, timedOut.run.runId);
    assert.throws(
      () => handlers.managed_review_evidence_import({ runId: timedOut.run.runId, receiptId: timedOutReceipt.receiptId }),
      /producer_owned_required|signature_invalid/,
      'a timed_out terminal cannot upgrade an authentic provider proposal into REVIEW evidence',
    );

    let rawProposalRejected = false;
    const rawReviewRunId = newAttempt('raw').reviewRunId;
    const rawHandlers = createHostRunHandlers(
      { store, root, scanRoot: join(root, 'packages/main') },
      { runner: async plan => {
        try {
          writeManagedReviewEvidenceProposal({
            root,
            runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!,
            environment: plan.env,
            proposal: {
              storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: rawReviewRunId,
              conclusion: 'pass', note: 'Raw execution must not author formal reviewer evidence.',
              ...managedReadEvidence(root),
            },
          });
        } catch (error) {
          rawProposalRejected = /not a formal managed_reviewer execution/.test(error instanceof Error ? error.message : String(error));
        }
        return { stdout: 'manual raw reviewer output', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
      } },
    );
    const raw = await rawHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: rawReviewRunId, lane: LANE,
      prompt: 'manual raw reviewer prompt', detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: raw.run.runId })).run.state === 'completed', 'raw control run did not complete');
    assert.equal(rawProposalRejected, true, 'ordinary managed runs cannot author formal reviewer proposals');
    const rawReceipt = managedHostRunReceipt(root, raw.run.runId);
    assert.throws(
      () => handlers.managed_review_evidence_import({ runId: raw.run.runId, receiptId: rawReceipt.receiptId }),
      /not an exact managed_reviewer binding/,
      'ordinary/raw CLI output cannot upgrade into formal managed reviewer evidence',
    );
    }

    assert.equal(concurrentImportResults.filter(result => /Managed review evidence imported/.test(result)).length, 1);
    assert.equal(concurrentImportResults.filter(result => /already imported/.test(result)).length, 1,
      'real proposal/terminal/import race converges on one creator and one exact reuse');
    const passes = store.readReviewPasses(STORY_ID).passes;
    assert.equal(passes.length, 1);
    assert.equal(passes[0]?.agent, LANE);
    assert.equal(passes[0]?.writerSessionId, `managed:${submitted.runId}`);
    assert.deepEqual(passes[0]?.readManifest?.filesReadFully, ['docs/requirements/decisions/managed-review-evidence.md', 'packages/main/src/example.ts']);
    assert.equal(passes[0]?.managedEvidenceBinding?.receiptId, receipt.receiptId);

    const managedBinding = readManagedHostRunBinding(root, submitted.runId);
    const expectedBinding: ManagedReviewExpectedBinding = {
      providerHost: managedBinding.host,
      headHash: run.headHash,
      materialHash: run.materialHash,
      storyFilesHash: run.storyFilesHash ?? '',
      promptHash: run.promptHash,
      envelopeId: run.envelopeId ?? null,
      managedPromptDigest: managedBinding.promptDigest,
    };
    type IntakeArgs = Parameters<typeof createManagedReviewEvidenceBinding>[0];
    const exactIntake: IntakeArgs = {
      root,
      storyId: STORY_ID,
      providerAgent: LANE,
      lane: LANE,
      reviewRunId: REVIEW_RUN_ID,
      runId: submitted.runId,
      receiptId: receipt.receiptId,
      expected: expectedBinding,
    };
    type MutationCase = {
      name: string;
      mutateIntake: (value: IntakeArgs) => IntakeArgs;
      mutateBinding: (value: NonNullable<typeof passes[0]>['managedEvidenceBinding']) => NonNullable<typeof passes[0]>['managedEvidenceBinding'];
      /** Story ownership is implicit in the store key and is exercised by the real cross-story gate below. */
      gateCoveredSeparately?: boolean;
    };
    const mutationCases: MutationCase[] = [
      { name: 'agent', mutateIntake: value => ({ ...value, providerAgent: 'proof-or-stop-review-concept' }), mutateBinding: value => ({ ...value!, providerAgent: 'proof-or-stop-review-concept' }) },
      {
        name: 'story',
        mutateIntake: value => ({ ...value, storyId: 'B-cross-story' }),
        mutateBinding: value => value!,
        gateCoveredSeparately: true,
      },
      { name: 'lane', mutateIntake: value => ({ ...value, lane: 'proof-or-stop-review-concept' }), mutateBinding: value => ({ ...value!, lane: 'proof-or-stop-review-concept' }) },
      { name: 'reviewRun', mutateIntake: value => ({ ...value, reviewRunId: `${STORY_ID}:RR-999` }), mutateBinding: value => ({ ...value!, reviewRunId: `${STORY_ID}:RR-999` }) },
      { name: 'provider', mutateIntake: value => ({ ...value, expected: { ...value.expected, providerHost: 'claude' } }), mutateBinding: value => ({ ...value!, providerHost: 'claude' }) },
      { name: 'head', mutateIntake: value => ({ ...value, expected: { ...value.expected, headHash: 'other-head' } }), mutateBinding: value => ({ ...value!, headHash: 'other-head' }) },
      { name: 'material', mutateIntake: value => ({ ...value, expected: { ...value.expected, materialHash: 'other-material' } }), mutateBinding: value => ({ ...value!, materialHash: 'other-material' }) },
      { name: 'storyFiles', mutateIntake: value => ({ ...value, expected: { ...value.expected, storyFilesHash: 'other-story-files' } }), mutateBinding: value => ({ ...value!, storyFilesHash: 'other-story-files' }) },
      { name: 'prompt', mutateIntake: value => ({ ...value, expected: { ...value.expected, promptHash: 'other-prompt' } }), mutateBinding: value => ({ ...value!, promptHash: 'other-prompt' }) },
      { name: 'envelope', mutateIntake: value => ({ ...value, expected: { ...value.expected, envelopeId: 'a'.repeat(64) } }), mutateBinding: value => ({ ...value!, envelopeId: 'a'.repeat(64) }) },
      { name: 'managedPrompt', mutateIntake: value => ({ ...value, expected: { ...value.expected, managedPromptDigest: 'sha256:other-managed-prompt' } }), mutateBinding: value => ({ ...value!, managedPromptDigest: 'sha256:other-managed-prompt' }) },
    ];
    const originalPass = structuredClone(passes[0]!);
    for (const mutation of mutationCases) {
      if (bindingMutationTarget && mutation.name !== bindingMutationTarget) continue;
      let intakeReason = '';
      if (evaluatorMutationBoundary !== 'gate') {
        try {
          createManagedReviewEvidenceBinding(mutation.mutateIntake(exactIntake));
          assert.fail(`fresh intake rejects ${mutation.name} mutation`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message === `fresh intake rejects ${mutation.name} mutation`) throw error;
          assert.match(message, /managed_review_evidence_import:/, `fresh intake rejects ${mutation.name} mutation`);
          intakeReason = message.replace(/^managed_review_evidence_import:\s*/, '');
        }
      }
      const mutatedBinding = mutation.mutateBinding(originalPass.managedEvidenceBinding)!;
      const mutatedPass = { ...originalPass, managedEvidenceBinding: mutatedBinding };
      mutatedPass._hash = signReviewPass(
        STORY_ID,
        mutatedPass.id,
        mutatedPass.agent,
        mutatedPass.note,
        mutatedPass.createdAt,
        mutatedPass.reviewRound ?? '',
        mutatedPass.reviewRunId ?? '',
        mutatedPass.readManifest,
        mutatedPass.readLog,
        mutatedPass.readDiagnostics,
        { writerSessionId: mutatedPass.writerSessionId!, sessionSource: mutatedPass.sessionSource! },
        mutatedPass.envelopeId,
        mutatedBinding,
      );
      store.writeReviewPasses(STORY_ID, { passes: [mutatedPass] });
      if (evaluatorMutationBoundary !== 'intake' && !mutation.gateCoveredSeparately) {
        const gate = collectReviewerEvidenceState(store, STORY_ID, root);
        const gateInvalid = gate.invalid.find(candidate => candidate.code === 'managed_receipt_invalid');
        assert.ok(gateInvalid, `REVIEW gate rejects persisted ${mutation.name} mutation`);
        // Agent is represented identically at importer and persisted-evidence
        // boundaries, so it also proves the shared evaluator's reason remains
        // canonical. Material tuple mutations necessarily enter through
        // importer `expected` versus persisted binding fields and may surface
        // different individual failed checks while both remain fail-closed.
        if (intakeReason && mutation.name === 'agent') {
          assert.ok(gateInvalid!.message.endsWith(intakeReason),
            `fresh intake and REVIEW gate retain one canonical reason for ${mutation.name} mutation`);
        }
      }
      store.writeReviewPasses(STORY_ID, { passes: [originalPass] });
      if (evaluatorMutationBoundary || bindingMutationTarget) break;
    }

    const evidence = collectReviewerEvidenceState(store, STORY_ID, root);
    assert.ok(evidence.valid.some(candidate => candidate.id === passes[0]?.id), 'REVIEW gate must accept the exact sealed managed evidence');
    assert.equal(evidence.invalid.some(candidate => candidate.code === 'managed_receipt_invalid'), false);

    const crossStoryId = 'B-cross-story';
    const sourceStory = store.readStory(STORY_ID);
    store.writeStory(crossStoryId, {
      ...sourceStory,
      storyId: crossStoryId,
      name: 'managed-review-cross-story-control',
      title: 'Managed review cross-story control',
    });
    store.writeChecklist(crossStoryId, store.readChecklist(STORY_ID));
    const crossDispatchPrompt = 'Perform the exact native-host review for this story.';
    const crossHostIdentity = reviewerHostRenderIdentity(root, LANE, 'codex', 'full-envelope');
    store.appendProcessEvent(crossStoryId, {
      type: 'dispatch',
      storyId: crossStoryId,
      agentType: LANE,
      targetKind: 'story-review',
      reviewRound: REVIEW_ROUND,
      dispatchPrompt: crossDispatchPrompt,
      dispatchPromptDigest: reviewerDispatchPromptDigest(crossDispatchPrompt),
      hostRenderHost: 'codex',
      hostRenderIdentityDigest: crossHostIdentity.identityDigest,
      dispatchBindingDigest: reviewerDispatchBindingDigest({
        storyId: crossStoryId,
        lane: LANE,
        reviewRound: REVIEW_ROUND,
        dispatchPromptDigest: reviewerDispatchPromptDigest(crossDispatchPrompt),
        hostRenderIdentityDigest: crossHostIdentity.identityDigest,
      }),
    });
    const crossRun: ReviewRun = {
      ...run,
      storyId: crossStoryId,
      _hash: signReviewRun(
        crossStoryId,
        run.reviewRunId,
        run.agent,
        run.lane,
        run.reviewRound,
        run.startedAt,
        run.headHash,
        run.materialHash,
        run.promptHash,
        undefined,
        undefined,
        run.storyFilesHash,
      ),
    };
    bindCurrentReviewEnvelope(root, store, crossRun);
    store.writeReviewRuns(crossStoryId, { runs: [crossRun] });
    const crossPass = { ...structuredClone(originalPass), id: `${crossStoryId}:RP-001`, envelopeId: crossRun.envelopeId };
    crossPass._hash = signReviewPass(
      crossStoryId,
      crossPass.id,
      crossPass.agent,
      crossPass.note,
      crossPass.createdAt,
      crossPass.reviewRound ?? '',
      crossPass.reviewRunId ?? '',
      crossPass.readManifest,
      crossPass.readLog,
      crossPass.readDiagnostics,
      { writerSessionId: crossPass.writerSessionId!, sessionSource: crossPass.sessionSource! },
      crossPass.envelopeId,
      crossPass.managedEvidenceBinding,
    );
    store.writeReviewPasses(crossStoryId, { passes: [crossPass] });
    const crossStoryGate = collectReviewerEvidenceState(store, crossStoryId, root);
    assert.ok(
      crossStoryGate.invalid.some(candidate => candidate.code === 'managed_receipt_invalid'),
      'persisting and re-signing an authentic managed pass under a different story is rejected by the actual REVIEW gate storyMatches boundary',
    );

    assert.deepEqual(classifyReviewerExecutionAuthority({
      executionMode: 'cross-provider-cli',
      assuranceLevel: 'ordinary-review',
      hasManagedEvidenceBinding: true,
    }), {
      classification: 'managed-cross-provider-receipt',
      directSignedReviewAllowed: false,
      managedReceiptRequired: true,
      reviewGatePath: 'managed-receipt',
    });
    const nativePass = structuredClone(originalPass);
    delete nativePass.managedEvidenceBinding;
    nativePass.writerSessionId = 'native-host-reviewer-session';
    nativePass.sessionSource = 'host-adapter';
    nativePass._hash = signReviewPass(
      STORY_ID,
      nativePass.id,
      nativePass.agent,
      nativePass.note,
      nativePass.createdAt,
      nativePass.reviewRound ?? '',
      nativePass.reviewRunId ?? '',
      nativePass.readManifest,
      nativePass.readLog,
      nativePass.readDiagnostics,
      { writerSessionId: nativePass.writerSessionId, sessionSource: nativePass.sessionSource },
      nativePass.envelopeId,
      undefined,
    );
    store.writeReviewPasses(STORY_ID, { passes: [nativePass] });
    const unboundDirectEvidence = collectReviewerEvidenceState(store, STORY_ID, root);
    assert.equal(
      unboundDirectEvidence.valid.some(candidate => candidate.id === nativePass.id),
      false,
      'absence of a managed binding is not proof that direct evidence came from the native host',
    );
    assert.ok(
      unboundDirectEvidence.invalid.some(candidate => String(candidate.code) === 'review_execution_authority_missing'),
      'an otherwise correctly re-signed direct pass without a broker invocation attestation fails closed',
    );
    nativePass.nativeEvidenceBinding = issueNativeReviewEvidenceBinding({
      projectRoot: root,
      storyId: STORY_ID,
      agent: LANE,
      lane: LANE,
      reviewRunId: REVIEW_RUN_ID,
      identity: {
        sessionId: nativePass.writerSessionId,
        sessionSource: 'host-adapter',
        hostProvider: 'codex',
        nativeSessionRef: 'codex:validated-composite',
      },
      dispatch: {
        hostRenderHost: 'codex',
        dispatchPromptDigest: nativeDispatch.dispatchPromptDigest,
        hostRenderIdentityDigest: nativeDispatch.hostRenderIdentityDigest,
        dispatchBindingDigest: nativeDispatch.dispatchBindingDigest,
      },
      attestation: brokerAttestation,
      observeProcess: () => null,
    });
    nativePass._hash = signReviewPass(
      STORY_ID,
      nativePass.id,
      nativePass.agent,
      nativePass.note,
      nativePass.createdAt,
      nativePass.reviewRound ?? '',
      nativePass.reviewRunId ?? '',
      nativePass.readManifest,
      nativePass.readLog,
      nativePass.readDiagnostics,
      { writerSessionId: nativePass.writerSessionId, sessionSource: nativePass.sessionSource },
      nativePass.envelopeId,
      undefined,
      nativePass.nativeEvidenceBinding,
    );
    store.writeReviewPasses(STORY_ID, { passes: [nativePass] });
    assert.ok(
      collectReviewerEvidenceState(store, STORY_ID, root).valid.some(candidate => candidate.id === nativePass.id),
      'a registered-broker native invocation preserves the direct signed review path without OS ancestry',
    );
    const nativeConsumptionPath = join(
      root,
      PROOF_OR_STOP_DIR,
      'runtime',
      'native-review-invocations',
      nativePass.nativeEvidenceBinding!.brokerId,
      `${nativePass.nativeEvidenceBinding!.invocationNonce}.json`,
    );
    const nativeConsumption = readFileSync(nativeConsumptionPath, 'utf8');
    unlinkSync(nativeConsumptionPath);
    assert.ok(
      collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(candidate => candidate.evidenceId === nativePass.id),
      'deleting the persisted one-shot native broker consumption record invalidates the otherwise signed direct-review pass',
    );
    writeFileSync(nativeConsumptionPath, nativeConsumption, 'utf8');
    const tamperedNativeConsumption = JSON.parse(nativeConsumption) as Record<string, unknown>;
    tamperedNativeConsumption.attestationDigest = `sha256:${'f'.repeat(64)}`;
    writeFileSync(nativeConsumptionPath, `${JSON.stringify(tamperedNativeConsumption)}\n`, 'utf8');
    assert.ok(
      collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(candidate => candidate.evidenceId === nativePass.id),
      'tampering the persisted one-shot native broker consumption digest invalidates current review acceptance',
    );
    writeFileSync(nativeConsumptionPath, nativeConsumption, 'utf8');
    assert.ok(
      collectReviewerEvidenceState(store, STORY_ID, root).valid.some(candidate => candidate.id === nativePass.id),
      'restoring the exact consumption record preserves valid existing native review evidence',
    );
    const brokeredCliSession = 'brokered-codex-cli-session';
    const brokeredCliClaims = {
      ...invocationClaims,
      writerSessionId: brokeredCliSession,
      invocationNonce: randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const brokeredFixture = await runBrokeredNativeBindingFixture(
      root,
      {
        storyId: STORY_ID,
        agent: LANE,
        lane: LANE,
        reviewRunId: REVIEW_RUN_ID,
        dispatch: {
          ...nativeDispatch,
          hostRenderHost: 'codex',
        },
      },
      signNativeReviewInvocationAttestation(brokeredCliClaims, brokerKeys.privateKey),
      {
        ...process.env,
        // A brokered native fixture must not inherit authority from an outer
        // managed Claude/Codex review. These values deliberately model the
        // real nested-provider environment that exposed F-098.
        LATTICE_MANAGED_HOST_RUN_ID: 'ambient-managed-review-run',
        LATTICE_MANAGED_REVIEW_INVOCATION_FD: '99',
        CLAUDE_CODE_SESSION_ID: 'ambient-claude-host-session',
        PROOF_OR_STOP_SESSION_ID: brokeredCliSession,
        PROOF_OR_STOP_AGENT: LANE,
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'codex-desktop-brokered-tool-invocation',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: LANE,
      },
    );
    assert.equal(brokeredFixture.status, 0,
      `isolated broker-signature fixture succeeds without consulting ambient provider ancestry: ${brokeredFixture.stderr}`);
    const brokeredFixtureBinding = JSON.parse(brokeredFixture.stdout) as {
      writerSessionId: string;
      adapterId: string;
      brokerId: string;
    };
    assert.deepEqual(
      {
        writerSessionId: brokeredFixtureBinding.writerSessionId,
        adapterId: brokeredFixtureBinding.adapterId,
        brokerId: brokeredFixtureBinding.brokerId,
      },
      {
        writerSessionId: brokeredCliSession,
        adapterId: 'codex-desktop',
        brokerId: 'smoke-codex-broker',
      },
      'independent fixture process consumes the exact registered-broker attestation without an OS-ancestry prerequisite',
    );
    const passesBeforeDuplicateMutation = structuredClone(store.readReviewPasses(STORY_ID).passes);
    const duplicatedNativePass = {
      ...structuredClone(nativePass),
      id: `${STORY_ID}:RP-900`,
      createdAt: new Date(Date.now() + 1).toISOString(),
    };
    duplicatedNativePass._hash = signReviewPass(
      STORY_ID,
      duplicatedNativePass.id,
      duplicatedNativePass.agent,
      duplicatedNativePass.note,
      duplicatedNativePass.createdAt,
      duplicatedNativePass.reviewRound ?? '',
      duplicatedNativePass.reviewRunId ?? '',
      duplicatedNativePass.readManifest,
      duplicatedNativePass.readLog,
      duplicatedNativePass.readDiagnostics,
      { writerSessionId: duplicatedNativePass.writerSessionId!, sessionSource: duplicatedNativePass.sessionSource! },
      duplicatedNativePass.envelopeId,
      undefined,
      duplicatedNativePass.nativeEvidenceBinding,
    );
    store.writeReviewPasses(STORY_ID, { passes: [...passesBeforeDuplicateMutation, duplicatedNativePass] });
    const duplicateGate = collectReviewerEvidenceState(store, STORY_ID, root);
    assert.equal(
      duplicateGate.valid.some(candidate => candidate.id === nativePass.id || candidate.id === duplicatedNativePass.id),
      false,
      'persisted duplicate evidence cannot reuse one broker invocation nonce',
    );
    assert.equal(
      duplicateGate.invalid.filter(candidate => /broker attestations are one-shot/.test(candidate.message)).length,
      2,
      'both artifacts sharing the consumed nonce are rejected rather than choosing an attacker-controlled winner',
    );
    store.writeReviewPasses(STORY_ID, { passes: passesBeforeDuplicateMutation });

    const findingsBeforeNativeBroker = structuredClone(store.readFindings(STORY_ID).findings);
    const nativeFindingReviewRunId = newAttempt('native-finding').reviewRunId;
    const nativeFindingClaims = {
      ...invocationClaims,
      reviewRunId: nativeFindingReviewRunId,
      writerSessionId: 'native-brokered-finding-session',
      invocationNonce: randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const nativeFindingBinding = issueNativeReviewEvidenceBinding({
      projectRoot: root,
      storyId: STORY_ID,
      agent: LANE,
      lane: LANE,
      reviewRunId: nativeFindingReviewRunId,
      identity: {
        sessionId: nativeFindingClaims.writerSessionId,
        sessionSource: 'host-adapter',
        hostProvider: 'codex',
        nativeSessionRef: 'codex:validated-composite',
      },
      dispatch: {
        hostRenderHost: 'codex',
        dispatchPromptDigest: nativeDispatch.dispatchPromptDigest,
        hostRenderIdentityDigest: nativeDispatch.hostRenderIdentityDigest,
        dispatchBindingDigest: nativeDispatch.dispatchBindingDigest,
      },
      attestation: signNativeReviewInvocationAttestation(nativeFindingClaims, brokerKeys.privateKey),
      observeProcess: () => null,
    });
    const nativeFinding: Finding = {
      id: `${STORY_ID}:F-900`,
      desc: 'Registered broker authorizes this exact native reviewer finding closeout.',
      severity: 'low',
      category: 'edge',
      status: 'open',
      evidenceState: 'disproven',
      disprovenEvidence: {
        summary: 'The brokered native finding was refuted by the exact signed counter-evidence.',
        sourceRefs: ['packages/main/src/core/finding-verify.ts:1'],
        reproCommand: 'node packages/main/dist/tasks/managed-review-evidence-smoke.js',
      },
      agent: LANE,
      createdAt: new Date().toISOString(),
      reviewRound: REVIEW_ROUND,
      reviewRunId: nativeFindingReviewRunId,
      nativeEvidenceBinding: nativeFindingBinding,
      _hash: '',
    };
    nativeFinding._hash = signFinding(
      STORY_ID,
      nativeFinding.id!,
      nativeFinding.desc,
      nativeFinding.severity,
      nativeFinding.createdAt!,
      nativeFinding.reviewRound ?? '',
      nativeFinding.reviewRunId ?? '',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      nativeFindingBinding,
      {
        category: nativeFinding.category,
        evidenceState: nativeFinding.evidenceState ?? null,
        uncertaintyReason: nativeFinding.uncertaintyReason ?? null,
        files: nativeFinding.files ?? [],
        disprovenEvidence: nativeFinding.disprovenEvidence,
      },
    );
    store.writeFindings(STORY_ID, { findings: [...findingsBeforeNativeBroker, nativeFinding] });
    assert.ok(
      collectReviewerEvidenceState(store, STORY_ID, root).valid.some(candidate => candidate.id === nativeFinding.id),
      'registered broker attestation authorizes a native finding when OS ancestry is unavailable',
    );
    for (const [label, mutate] of [
      ['category', (value: Finding) => ({ ...value, category: 'adversarial' as const })],
      ['evidenceState', (value: Finding) => ({ ...value, evidenceState: 'suspected' as const, uncertaintyReason: 'controller rewrite' })],
      ['uncertaintyReason', (value: Finding) => ({ ...value, uncertaintyReason: 'unsigned controller text' })],
      ['files', (value: Finding) => ({ ...value, files: ['packages/main/src/forged.ts'] })],
      ['disprovenEvidence', (value: Finding) => ({ ...value, disprovenEvidence: { ...value.disprovenEvidence!, summary: 'unsigned controller rewrite' } })],
    ] as const) {
      const mutated = mutate(structuredClone(nativeFinding));
      store.writeFindings(STORY_ID, { findings: [...findingsBeforeNativeBroker, mutated] });
      assert.ok(
        collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(candidate => candidate.evidenceId === nativeFinding.id),
        `native finding signature binds immutable ${label} semantics`,
      );
    }
    store.writeFindings(STORY_ID, { findings: findingsBeforeNativeBroker });

    for (const [field, changed] of [
      ['storyId', 'B-other-story'],
      ['agent', 'proof-or-stop-review-concept'],
      ['lane', 'proof-or-stop-review-concept'],
      ['reviewRunId', `${STORY_ID}:RR-999`],
      ['writerSessionId', 'different-writer-session'],
      ['dispatchBindingDigest', `sha256:${'9'.repeat(64)}`],
    ] as const) {
      const swapped = signNativeReviewInvocationAttestation({
        ...invocationClaims,
        [field]: changed,
        invocationNonce: randomUUID(),
      }, brokerKeys.privateKey);
      const result = verifyNativeReviewInvocationAttestation({
        attestation: swapped,
        trustedBrokers: [{
          brokerId: 'smoke-codex-broker',
          adapterId: 'codex-desktop',
          host: 'codex',
          publicKey: brokerKeys.publicKey,
        }],
        expected: invocationClaims,
      });
      assert.equal(result.ok, false, `signed cross-${field} attestation cannot be replayed into this invocation`);
    }

    const attackerKeys = generateEd25519KeyPair();
    const selfMinted = signNativeReviewInvocationAttestation({
      ...invocationClaims,
      writerSessionId: 'raw-self-mint-session',
      invocationNonce: randomUUID(),
    }, attackerKeys.privateKey);
    const selfMintedCli = await runBrokeredCli(root, 'review_pass_set', {
      storyId: STORY_ID,
      agent: LANE,
      reviewRunId: REVIEW_RUN_ID,
      note: 'Raw provider self-mints a matching dispatch and ReviewRun attestation.',
      readManifest: {
        filesReadFully: ['packages/main/src/example.ts'],
        filesTriagedByName: [],
        scanEscalationReason: null,
      },
    }, selfMinted, {
      ...process.env,
      PROOF_OR_STOP_SESSION_ID: 'raw-self-mint-session',
      PROOF_OR_STOP_AGENT: LANE,
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'raw-provider-self-mint',
      PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: LANE,
    });
    assert.notEqual(selfMintedCli.status, 0, 'raw provider cannot self-mint authority even when all dispatch and ReviewRun claims match');
    assert.match(`${selfMintedCli.stdout}${selfMintedCli.stderr}`, /signature is invalid/);

    const inlineSession = 'inherited-inline-attestation-session';
    const inlineAttestation = signNativeReviewInvocationAttestation({
      ...invocationClaims,
      writerSessionId: inlineSession,
      invocationNonce: randomUUID(),
    }, brokerKeys.privateKey);
    const inheritedInline = spawnSync(process.execPath, [CLI, 'review_pass_set', JSON.stringify({
      storyId: STORY_ID,
      agent: LANE,
      reviewRunId: REVIEW_RUN_ID,
      note: 'An inherited inline environment token must not become native authority.',
      readManifest: {
        filesReadFully: ['packages/main/src/example.ts'],
        filesTriagedByName: [],
        scanEscalationReason: null,
      },
    })], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...withoutManagedAmbientAuthority(process.env),
        PROOF_OR_STOP_SESSION_ID: inlineSession,
        PROOF_OR_STOP_AGENT: LANE,
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'codex',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'raw-inherited-inline-token',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: LANE,
        LATTICE_NATIVE_REVIEW_ATTESTATION: JSON.stringify(inlineAttestation),
      },
    });
    assert.notEqual(inheritedInline.status, 0, 'inherited inline env token is not an accepted broker injection seam');
    assert.match(`${inheritedInline.stdout}${inheritedInline.stderr}`, /requires a registered host-adapter invocation attestation/);

    const mixedCodexClaims = signNativeReviewInvocationAttestation({
      ...invocationClaims,
      invocationNonce: randomUUID(),
    }, brokerKeys.privateKey);
    assert.throws(() => issueNativeReviewEvidenceBinding({
      projectRoot: root,
      storyId: STORY_ID,
      agent: LANE,
      lane: LANE,
      reviewRunId: REVIEW_RUN_ID,
      identity: {
        sessionId: invocationClaims.writerSessionId,
        sessionSource: 'host-adapter',
        hostProvider: 'codex',
        nativeSessionRef: 'codex:validated-composite',
      },
      dispatch: {
        hostRenderHost: 'codex',
        dispatchPromptDigest: nativeDispatch.dispatchPromptDigest,
        hostRenderIdentityDigest: nativeDispatch.hostRenderIdentityDigest,
        dispatchBindingDigest: nativeDispatch.dispatchBindingDigest,
      },
      attestation: mixedCodexClaims,
      observeProcess: () => classifyNativeHostProcessLineage([
        { pid: 303, ppid: 202, comm: 'codex', command: 'codex exec' },
        { pid: 202, ppid: 1, comm: 'claude', command: 'claude review' },
      ]),
    }), /mixed provider ancestry=codex->claude/, 'Claude to Codex mixed tree is rejected despite a valid nearest-host broker attestation');

    const claudeBrokerKeys = generateEd25519KeyPair();
    const claudeDispatch = {
      hostRenderHost: 'claude' as const,
      dispatchPromptDigest: `sha256:${'1'.repeat(64)}`,
      hostRenderIdentityDigest: `sha256:${'2'.repeat(64)}`,
      dispatchBindingDigest: `sha256:${'3'.repeat(64)}`,
    };
    const claudeClaims = {
      ...invocationClaims,
      brokerId: 'smoke-claude-broker',
      adapterId: 'claude-code-hook',
      host: 'claude' as const,
      writerSessionId: 'native-claude-session',
      dispatchPromptDigest: claudeDispatch.dispatchPromptDigest,
      dispatchBindingDigest: claudeDispatch.dispatchBindingDigest,
      hostRenderIdentityDigest: claudeDispatch.hostRenderIdentityDigest,
      invocationNonce: randomUUID(),
    };
    assert.throws(() => issueNativeReviewEvidenceBinding({
      projectRoot: root,
      storyId: STORY_ID,
      agent: LANE,
      lane: LANE,
      reviewRunId: REVIEW_RUN_ID,
      identity: {
        sessionId: claudeClaims.writerSessionId,
        sessionSource: 'host-adapter',
        hostProvider: 'claude-code',
        nativeSessionRef: 'claude-code:validated-composite',
      },
      dispatch: claudeDispatch,
      attestation: signNativeReviewInvocationAttestation(claudeClaims, claudeBrokerKeys.privateKey),
      trustedBrokers: [{
        brokerId: claudeClaims.brokerId,
        adapterId: claudeClaims.adapterId,
        host: 'claude',
        publicKey: claudeBrokerKeys.publicKey,
      }],
      observeProcess: () => classifyNativeHostProcessLineage([
        { pid: 404, ppid: 303, comm: 'claude', command: 'claude review' },
        { pid: 303, ppid: 1, comm: 'codex', command: 'codex exec' },
      ]),
    }), /mixed provider ancestry=claude->codex/, 'Codex to Claude mixed tree is rejected despite a valid nearest-host broker attestation');
    assert.throws(
      () => issueNativeReviewEvidenceBinding({
        projectRoot: root,
        storyId: STORY_ID,
        agent: LANE,
        lane: LANE,
        reviewRunId: REVIEW_RUN_ID,
        identity: {
          sessionId: nativePass.writerSessionId!,
          sessionSource: 'host-adapter',
          hostProvider: 'codex',
          nativeSessionRef: 'codex:validated-composite',
        },
        dispatch: {
          hostRenderHost: 'codex',
          dispatchPromptDigest: nativeDispatch.dispatchPromptDigest,
          hostRenderIdentityDigest: nativeDispatch.hostRenderIdentityDigest,
          dispatchBindingDigest: nativeDispatch.dispatchBindingDigest,
        },
        attestation: brokerAttestation,
        observeProcess: () => null,
      }),
      /already consumed/,
      'broker invocation attestation is one-shot even when every context field still matches',
    );
    const inheritedClaims = {
      ...invocationClaims,
      writerSessionId: 'inherited-codex-env',
      invocationNonce: randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    assert.throws(
      () => issueNativeReviewEvidenceBinding({
        projectRoot: root,
        storyId: STORY_ID,
        agent: LANE,
        lane: LANE,
        reviewRunId: REVIEW_RUN_ID,
        identity: {
          sessionId: 'inherited-codex-env',
          sessionSource: 'host-adapter',
          hostProvider: 'codex',
          nativeSessionRef: 'codex:validated-composite',
        },
        dispatch: {
          hostRenderHost: 'codex',
          dispatchPromptDigest: nativeDispatch.dispatchPromptDigest,
          hostRenderIdentityDigest: nativeDispatch.hostRenderIdentityDigest,
          dispatchBindingDigest: nativeDispatch.dispatchBindingDigest,
        },
        attestation: signNativeReviewInvocationAttestation(inheritedClaims, brokerKeys.privateKey),
        observeProcess: () => ({ host: 'claude', processLineageDigest: `sha256:${'b'.repeat(64)}` }),
      }),
      /nearest provider process=claude/,
      'inherited or forged Codex environment cannot hide that the nearest real provider process is Claude',
    );
    const passesBeforeRawCli = store.readReviewPasses(STORY_ID).passes.length;
    const rawCli = spawnSync(process.execPath, [CLI, 'review_pass_set', JSON.stringify({
      storyId: STORY_ID,
      agent: LANE,
      reviewRunId: REVIEW_RUN_ID,
      note: 'Raw Claude CLI attempts to write a direct pass against a Codex-native dispatch.',
      readManifest: {
        filesReadFully: ['packages/main/src/example.ts'],
        filesTriagedByName: [],
        scanEscalationReason: null,
      },
    })], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...withoutManagedAmbientAuthority(process.env),
        PROOF_OR_STOP_SESSION_ID: 'raw-cross-provider-reviewer',
        PROOF_OR_STOP_AGENT: LANE,
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'claude-code',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'raw-claude-review',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: LANE,
        CLAUDE_CODE_SESSION_ID: 'raw-claude-review',
      },
    });
    assert.notEqual(rawCli.status, 0, 'real raw cross-provider CLI review_pass_set must fail');
    assert.match(
      `${rawCli.stdout}${rawCli.stderr}`,
      /cross-provider direct reviewer evidence is advisory-only|requires a registered host-adapter invocation attestation/,
      'real raw CLI is rejected by the same production native-host authority boundary',
    );
    assert.equal(
      store.readReviewPasses(STORY_ID).passes.length,
      passesBeforeRawCli,
      'rejected raw cross-provider CLI creates no formal pass artifact',
    );
    const findingsBeforeRawCli = store.readFindings(STORY_ID).findings.length;
    const rawCliFinding = spawnSync(process.execPath, [CLI, 'finding_add', JSON.stringify({
      storyId: STORY_ID,
      agent: LANE,
      reviewRunId: REVIEW_RUN_ID,
      desc: 'raw cross-provider CLI cannot mint a formal finding',
      severity: 'high',
      category: 'adversarial',
      readManifest: {
        filesReadFully: ['packages/main/src/example.ts'],
        filesTriagedByName: [],
        scanEscalationReason: null,
      },
    })], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...withoutManagedAmbientAuthority(process.env),
        PROOF_OR_STOP_SESSION_ID: 'raw-cross-provider-reviewer',
        PROOF_OR_STOP_AGENT: LANE,
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'claude-code',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: 'raw-claude-review',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: LANE,
        CLAUDE_CODE_SESSION_ID: 'raw-claude-review',
      },
    });
    assert.notEqual(rawCliFinding.status, 0, 'real raw cross-provider CLI finding_add must fail');
    assert.match(`${rawCliFinding.stdout}${rawCliFinding.stderr}`, /cross-provider direct reviewer evidence is advisory-only|requires a live Codex\/Claude process ancestor/);
    assert.equal(
      store.readFindings(STORY_ID).findings.length,
      findingsBeforeRawCli,
      'rejected raw cross-provider CLI creates no formal finding artifact',
    );
    assert.deepEqual(classifyReviewerExecutionAuthority({
      executionMode: 'native-host',
      assuranceLevel: 'ordinary-review',
      hasManagedEvidenceBinding: false,
    }), {
      classification: 'native-host-signed-review',
      directSignedReviewAllowed: true,
      managedReceiptRequired: false,
      reviewGatePath: 'direct-signed-review',
    });
    assert.deepEqual(classifyReviewerExecutionAuthority({
      executionMode: 'native-host',
      assuranceLevel: 'degraded-single-host',
      hasManagedEvidenceBinding: false,
    }), {
      classification: 'degraded-single-host-local-only',
      directSignedReviewAllowed: false,
      managedReceiptRequired: false,
      reviewGatePath: 'local-host-verdict-only',
    }, 'explicit degraded fallback stays local assurance and cannot masquerade as native or managed REVIEW evidence');
    const degradedPass = structuredClone(originalPass);
    delete degradedPass.managedEvidenceBinding;
    delete degradedPass.nativeEvidenceBinding;
    degradedPass.writerSessionId = 'degraded-single-host-local-control';
    degradedPass.sessionSource = 'review-escalation-degraded-single-host';
    degradedPass._hash = signReviewPass(
      STORY_ID,
      degradedPass.id,
      degradedPass.agent,
      degradedPass.note,
      degradedPass.createdAt,
      degradedPass.reviewRound ?? '',
      degradedPass.reviewRunId ?? '',
      degradedPass.readManifest,
      degradedPass.readLog,
      degradedPass.readDiagnostics,
      { writerSessionId: degradedPass.writerSessionId, sessionSource: degradedPass.sessionSource },
      degradedPass.envelopeId,
    );
    store.writeReviewPasses(STORY_ID, { passes: [degradedPass] });
    const degradedGate = collectReviewerEvidenceState(store, STORY_ID, root);
    assert.ok(
      degradedGate.invalid.some(candidate => candidate.code === 'review_execution_authority_missing'),
      'the actual REVIEW gate keeps degraded-single-host local evidence out of native and managed authority paths',
    );
    assert.equal(degradedGate.valid.some(candidate => candidate.id === degradedPass.id), false);
    assert.deepEqual(classifyReviewerExecutionAuthority({
      executionMode: 'cross-provider-cli',
      assuranceLevel: 'ordinary-review',
      hasManagedEvidenceBinding: false,
    }), {
      classification: 'cross-provider-advisory-only',
      directSignedReviewAllowed: false,
      managedReceiptRequired: true,
      reviewGatePath: 'none',
    }, 'cross-provider CLI without a managed receipt remains advisory-only');
    store.writeReviewPasses(STORY_ID, { passes: [originalPass] });

    const findingRaceReviewRunId = newAttempt('findingRace').reviewRunId;
    const findingHandlers = createHostRunHandlers(
      { store, root, scanRoot: join(root, 'packages/main') },
      { runner: async () => {
        const finalAssistantResult = JSON.stringify({
          schemaVersion: 'lattice.managed_review_final_proposal.v1',
            storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: findingRaceReviewRunId,
            conclusion: 'findings',
            findings: [{
              desc: 'packages/main/src/example.ts:1 managed provider found a blocking behavior defect',
              severity: 'high', category: 'adversarial', files: ['packages/main/src/example.ts'],
            }],
            ...managedReadEvidence(root),
        });
        return {
          stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
          finalAssistantResult, finalAssistantResultCount: 1, finalAssistantResultTruncated: false,
        };
      } },
    );
    const findingRun = await findingHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: findingRaceReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: findingRun.run.runId })).run.state === 'completed', 'managed finding run did not complete');
    const findingReceipt = managedHostRunReceipt(root, findingRun.run.runId);
    const secondFindingRun = await findingHandlers.host_run({
      host: 'claude', storyId: STORY_ID, agentType: LANE, reviewRunId: findingRaceReviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: secondFindingRun.run.runId })).run.state === 'completed',
      'second managed finding run did not complete');
    const secondFindingReceipt = managedHostRunReceipt(root, secondFindingRun.run.runId);
    const findingStartBarrier = join(root, 'distinct-finding-import-start.go');
    const findingPersistBarrier = join(root, 'distinct-finding-import-persist.go');
    const findingImportWorkers = [
      { runId: findingRun.run.runId, receiptId: findingReceipt.receiptId },
      { runId: secondFindingRun.run.runId, receiptId: secondFindingReceipt.receiptId },
    ].map((candidate, index) => {
      const readyPath = join(root, `distinct-finding-worker-${index}.ready`);
      const resultPath = join(root, `distinct-finding-worker-${index}.result`);
      const afterReadPath = join(root, `distinct-finding-worker-${index}.after-read`);
      const child = spawn(process.execPath, [
        SELF, '--import-worker', root, candidate.runId, candidate.receiptId,
        readyPath, findingStartBarrier, resultPath, afterReadPath, findingPersistBarrier,
      ], { cwd: root, env: hostOwnedChildEnv(), stdio: 'ignore' });
      return { child, exit: waitForExit(child), readyPath, afterReadPath };
    });
    await eventually(async () => findingImportWorkers.every(worker => existsSync(worker.readyPath)),
      'different-receipt finding workers did not reach the start barrier');
    writeFileSync(findingStartBarrier, 'start');
    await eventually(async () => findingImportWorkers.some(worker => existsSync(worker.afterReadPath)),
      'no different-receipt finding importer reached its pre-persist boundary');
    await new Promise(resolve => setTimeout(resolve, 500));
    writeFileSync(findingPersistBarrier, 'persist');
    assert.deepEqual(await Promise.all(findingImportWorkers.map(worker => worker.exit)), [0, 0]);
    const racedFindings = store.readFindings(STORY_ID).findings;
    assert.equal(racedFindings.length, 2, 'different receipt finding imports lose no concurrent update');
    assert.equal(new Set(racedFindings.map(finding => finding.id)).size, 2, 'different receipt finding imports allocate unique ids');
    assert.deepEqual(
      new Set(racedFindings.map(finding => finding.managedEvidenceBinding?.receiptId)),
      new Set([findingReceipt.receiptId, secondFindingReceipt.receiptId]),
    );
    const importedFinding = racedFindings.find(finding => finding.managedEvidenceBinding?.receiptId === findingReceipt.receiptId)!;
    const importedFindings = [importedFinding];
    store.writeFindings(STORY_ID, { findings: importedFindings });
    assert.equal(importedFindings[0]?.agent, LANE);
    assert.equal(importedFindings[0]?.managedEvidenceBinding?.receiptId, findingReceipt.receiptId);
    assert.equal(importedFindings[0]?.desc, 'packages/main/src/example.ts:1 managed provider found a blocking behavior defect');
    assert.equal(importedFindings[0]?.severity, 'high');
    assert.equal(importedFindings[0]?.category, 'adversarial');
    assert.deepEqual(importedFindings[0]?.files, ['packages/main/src/example.ts']);
    assert.deepEqual(importedFindings[0]?.readManifest, managedReadEvidence(root).readManifest);
    assert.equal(
      isFindingBlocking(importedFindings[0]!, ['critical', 'high'], 1),
      true,
      'an exact imported verified/high provider finding remains REVIEW-blocking',
    );
    const findingEvidence = collectReviewerEvidenceState(store, STORY_ID, root);
    assert.ok(findingEvidence.valid.some(candidate => candidate.id === importedFindings[0]?.id), 'REVIEW gate must revalidate an imported provider finding through the shared evaluator');

    const originalFinding = structuredClone(importedFindings[0]!);
    const rewrittenFinding = { ...originalFinding, severity: 'low' as const };
    rewrittenFinding._hash = (await import('../core/finding-verify.js')).signFinding(
      STORY_ID,
      rewrittenFinding.id,
      rewrittenFinding.desc,
      rewrittenFinding.severity,
      rewrittenFinding.createdAt!,
      rewrittenFinding.reviewRound ?? '',
      rewrittenFinding.reviewRunId ?? '',
      rewrittenFinding.readManifest,
      rewrittenFinding.readLog,
      rewrittenFinding.readDiagnostics,
      undefined,
      rewrittenFinding.managedEvidenceBinding,
    );
    store.writeFindings(STORY_ID, { findings: [rewrittenFinding] });
    const rewrittenFindingEvidence = collectReviewerEvidenceState(store, STORY_ID, root);
    assert.ok(
      rewrittenFindingEvidence.invalid.some(candidate => candidate.code === 'managed_receipt_invalid'),
      'a controller cannot downgrade provider severity and re-sign the imported finding',
    );
    assert.throws(
      () => handlers.managed_review_evidence_import({ runId: findingRun.run.runId, receiptId: findingReceipt.receiptId }),
      /existing imported evidence is no longer admissible/,
      'idempotent importer replay revalidates the exact persisted provider finding instead of trusting receipt identity alone',
    );
    store.writeFindings(STORY_ID, { findings: [originalFinding] });

    const secondReceiptHandlers = createHostRunHandlers(
      { store, root, scanRoot: join(root, 'packages/main') },
      { runner: async plan => {
        writeManagedReviewEvidenceProposal({
          root,
          runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!,
          environment: plan.env,
          proposal: {
            storyId: STORY_ID, providerAgent: LANE, lane: LANE, reviewRunId: readManagedHostRunBinding(root, plan.env.LATTICE_MANAGED_HOST_RUN_ID!).reviewRunId!,
            conclusion: 'pass', note: 'A second authentic receipt is a distinct provider proposal, never a rewrite of the first.',
            ...managedReadEvidence(root),
          },
        });
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
      } },
    );
    const secondReceiptRun = await secondReceiptHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: newAttempt('receipt-recovery').reviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: secondReceiptRun.run.runId })).run.state === 'completed',
      'second authentic receipt run did not complete');
    const secondReceipt = managedHostRunReceipt(root, secondReceiptRun.run.runId);
    assert.throws(
      () => handlers.managed_review_evidence_import({ runId: submitted.runId, receiptId: secondReceipt.receiptId }),
      /producer_owned_required|signature_invalid/,
      'an authentic receipt from a different run cannot be swapped onto the already imported provider proposal',
    );
    const thirdReceiptRun = await secondReceiptHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: newAttempt('receipt-recovery').reviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: thirdReceiptRun.run.runId })).run.state === 'completed',
      'third authentic receipt run did not complete');
    const thirdReceipt = managedHostRunReceipt(root, thirdReceiptRun.run.runId);
    const distinctReceiptStartBarrier = join(root, 'distinct-receipt-import-start.go');
    const distinctReceiptPersistBarrier = join(root, 'distinct-receipt-import-persist.go');
    const distinctReceiptWorkers = [
      { runId: secondReceiptRun.run.runId, receiptId: secondReceipt.receiptId },
      { runId: thirdReceiptRun.run.runId, receiptId: thirdReceipt.receiptId },
    ].map((candidate, index) => {
      const readyPath = join(root, `distinct-receipt-worker-${index}.ready`);
      const resultPath = join(root, `distinct-receipt-worker-${index}.result`);
      const afterReadPath = join(root, `distinct-receipt-worker-${index}.after-read`);
      const child = spawn(process.execPath, [
        SELF, '--import-worker', root, candidate.runId, candidate.receiptId,
        readyPath, distinctReceiptStartBarrier, resultPath, afterReadPath, distinctReceiptPersistBarrier,
      ], { cwd: root, env: hostOwnedChildEnv(), stdio: 'ignore' });
      return { child, exit: waitForExit(child), readyPath, resultPath, afterReadPath };
    });
    await eventually(async () => distinctReceiptWorkers.every(worker => existsSync(worker.readyPath)),
      'distinct receipt import workers did not reach the start barrier');
    writeFileSync(distinctReceiptStartBarrier, 'start');
    await eventually(async () => distinctReceiptWorkers.some(worker => existsSync(worker.afterReadPath)),
      'no distinct receipt importer reached its pre-persist boundary');
    await new Promise(resolve => setTimeout(resolve, 500));
    writeFileSync(distinctReceiptPersistBarrier, 'persist');
    assert.deepEqual(await Promise.all(distinctReceiptWorkers.map(worker => worker.exit)), [0, 0],
      'real different-receipt importer processes both complete under the shared story metadata lock');
    const afterSecondReceipt = store.readReviewPasses(STORY_ID).passes;
    assert.equal(afterSecondReceipt.length, 3, 'two concurrently imported authentic receipts create two distinct evidence identities');
    assert.equal(new Set(afterSecondReceipt.map(pass => pass.id)).size, 3, 'concurrent different receipts never allocate a duplicate review-pass id');
    assert.deepEqual(
      new Set(afterSecondReceipt.map(pass => pass.managedEvidenceBinding?.receiptId)),
      new Set([receipt.receiptId, secondReceipt.receiptId, thirdReceipt.receiptId]),
      'concurrent different receipts are neither lost nor duplicated',
    );
    assert.deepEqual(
      afterSecondReceipt.find(candidate => candidate.id === originalPass.id),
      originalPass,
      'the first imported provider proposal remains byte-semantically unchanged after a different authentic receipt import',
    );
    assert.ok(
      collectReviewerEvidenceState(store, STORY_ID, root).valid.some(candidate => candidate.id === originalPass.id),
      'the prior authentic receipt remains independently valid at the REVIEW gate',
    );

    const prePersistCrashRun = await secondReceiptHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: newAttempt('receipt-recovery').reviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({
      root,
      runId: prePersistCrashRun.run.runId,
    })).run.state === 'completed', 'pre-persist crash receipt run did not complete');
    const prePersistCrashReceipt = managedHostRunReceipt(root, prePersistCrashRun.run.runId);
    const originalPrePersistWrite = store.writeReviewPasses.bind(store);
    let injectedPrePersistCrash = false;
    store.writeReviewPasses = ((storyId: string, data: Parameters<StoryStore['writeReviewPasses']>[1]) => {
      if (!injectedPrePersistCrash
        && data.passes.some(pass => pass.managedEvidenceBinding?.receiptId === prePersistCrashReceipt.receiptId)) {
        injectedPrePersistCrash = true;
        throw new Error('injected crash before story evidence persistence');
      }
      originalPrePersistWrite(storyId, data);
    }) as typeof store.writeReviewPasses;
    try {
      assert.throws(
        () => handlers.managed_review_evidence_import({
          runId: prePersistCrashRun.run.runId,
          receiptId: prePersistCrashReceipt.receiptId,
        }),
        /injected crash before story evidence persistence/,
      );
    } finally {
      store.writeReviewPasses = originalPrePersistWrite;
    }
    const prePersistRunDir = managedHostRunDirectory(root, prePersistCrashRun.run.runId);
    assert.equal(existsSync(join(prePersistRunDir, 'evidence-binding.json')), false,
      'a pre-persist crash cannot seal an RP id that the story has not durably claimed');
    assert.equal(
      store.readReviewPasses(STORY_ID).passes.some(pass => pass.managedEvidenceBinding?.receiptId === prePersistCrashReceipt.receiptId),
      false,
      'pre-persist crash cannot expose partial story evidence',
    );
    // F-151: let another authentic receipt claim the RP id the crashed importer
    // would have selected. The retry must allocate its own next identity and
    // seal it, not collide with a stale pre-persistence binding.
    const interveningRun = await secondReceiptHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: newAttempt('receipt-recovery').reviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: interveningRun.run.runId })).run.state === 'completed',
      'intervening receipt run did not complete');
    const interveningReceipt = managedHostRunReceipt(root, interveningRun.run.runId);
    assert.match(
      handlers.managed_review_evidence_import({ runId: interveningRun.run.runId, receiptId: interveningReceipt.receiptId }),
      /Managed review evidence imported/,
      'an intervening authentic receipt can claim the next RP id after the crash',
    );
    const interveningPass = store.readReviewPasses(STORY_ID).passes.find(
      pass => pass.managedEvidenceBinding?.receiptId === interveningReceipt.receiptId,
    );
    assert.ok(interveningPass, 'the intervening receipt owns one durable review-pass identity');
    assert.match(
      handlers.managed_review_evidence_import({
        runId: prePersistCrashRun.run.runId,
        receiptId: prePersistCrashReceipt.receiptId,
      }),
      /Managed review evidence imported/,
      'retry after a pre-persist crash converges after an intervening receipt claimed the original candidate id',
    );
    const recoveredPasses = store.readReviewPasses(STORY_ID).passes.filter(
      pass => pass.managedEvidenceBinding?.receiptId === prePersistCrashReceipt.receiptId,
    );
    assert.equal(recoveredPasses.length, 1, 'crash recovery creates exactly one provider-authored pass');
    assert.notEqual(recoveredPasses[0]!.id, interveningPass.id,
      'the recovering receipt never rewrites or collides with the intervening receipt identity');
    assert.equal(existsSync(join(prePersistRunDir, 'evidence-binding.json')), true,
      'the retry seals the recovered receipt against its own durable RP id');

    const crashRun = await secondReceiptHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: newAttempt('receipt-recovery').reviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({ root, runId: crashRun.run.runId })).run.state === 'completed',
      'crash-consistency receipt run did not complete');
    const crashReceipt = managedHostRunReceipt(root, crashRun.run.runId);
    const originalWriteReviewPasses = store.writeReviewPasses.bind(store);
    let injectedPostPersistCrash = false;
    store.writeReviewPasses = ((storyId: string, data: Parameters<StoryStore['writeReviewPasses']>[1]) => {
      originalWriteReviewPasses(storyId, data);
      if (!injectedPostPersistCrash && data.passes.some(pass => pass.managedEvidenceBinding?.receiptId === crashReceipt.receiptId)) {
        injectedPostPersistCrash = true;
        throw new Error('injected crash after story evidence persistence');
      }
    }) as typeof store.writeReviewPasses;
    try {
      assert.throws(
        () => handlers.managed_review_evidence_import({ runId: crashRun.run.runId, receiptId: crashReceipt.receiptId }),
        /injected crash after story evidence persistence/,
      );
    } finally {
      store.writeReviewPasses = originalWriteReviewPasses;
    }
    const crashRunDir = managedHostRunDirectory(root, crashRun.run.runId);
    assert.equal(existsSync(join(crashRunDir, 'evidence-binding.json')), false,
      'a post-persist crash leaves no premature external receipt seal');
    assert.equal(existsSync(join(crashRunDir, 'evidence-binding.seal.json')), false,
      'a post-persist crash leaves the binding seal absent for retry repair');
    const recoveredImport = handlers.managed_review_evidence_import({ runId: crashRun.run.runId, receiptId: crashReceipt.receiptId });
    assert.match(
      recoveredImport,
      /already imported/,
      'retry after the post-persist crash seals the exact persisted evidence without duplication',
    );
    assert.equal(
      store.readProcessEvents(STORY_ID).filter((event) =>
        event.type === 'review_pass'
        && event.command === 'managed_review_evidence_import'
        && event.managedRunId === crashRun.run.runId
        && event.managedReceiptId === crashReceipt.receiptId,
      ).length,
      1,
      'retry after a post-persist crash restores the missing receipt-bound review audit event exactly once',
    );
    assert.ok(
      collectReviewerEvidenceState(store, STORY_ID, root).valid.some(candidate => candidate.pass?.managedEvidenceBinding?.receiptId === crashReceipt.receiptId),
      'retry repairs receipt authority before the persisted pass can become admissible',
    );

    // F-190: writeManagedHostRunEvidenceBinding used to leave receipt reads
    // fail-closed after a crash between its binding and seal writes, so this
    // importer could not reach its existing-evidence retry branch. Inject that
    // exact window after story persistence, require the partial state to remain
    // gate-inadmissible, then prove a normal retry seals the same receipt and
    // does not allocate another review pass.
    const bindingSealCrashRun = await secondReceiptHandlers.host_run({
      host: 'codex', storyId: STORY_ID, agentType: LANE, reviewRunId: newAttempt('receipt-recovery').reviewRunId, lane: LANE,
      managedReview: true, detach: true, deadlineMs: MANAGED_REVIEW_FIXTURE_DEADLINE_MS, json: true,
    }) as HostRunDetachResult;
    await eventually(async () => (await getManagedHostRunStatus({
      root,
      runId: bindingSealCrashRun.run.runId,
    })).run.state === 'completed', 'binding-seal crash receipt run did not complete');
    const bindingSealCrashReceipt = managedHostRunReceipt(root, bindingSealCrashRun.run.runId);
    let injectedBindingSealCrash = false;
    const bindingSealCrashHandlers = createManagedReviewEvidenceHandlers(
      { store, root, scanRoot: join(root, 'packages/main') },
      {
        afterManagedHostRunEvidenceBindingWrite: () => {
          if (!injectedBindingSealCrash) {
            injectedBindingSealCrash = true;
            throw new Error('injected crash between evidence binding and seal writes');
          }
        },
      },
    );
    assert.throws(
      () => bindingSealCrashHandlers.managed_review_evidence_import({
        runId: bindingSealCrashRun.run.runId,
        receiptId: bindingSealCrashReceipt.receiptId,
      }),
      /injected crash between evidence binding and seal writes/,
      'the regression injects the exact binding-to-seal crash window',
    );
    const bindingSealCrashDir = managedHostRunDirectory(root, bindingSealCrashRun.run.runId);
    assert.equal(injectedBindingSealCrash, true, 'binding-to-seal crash seam ran after the durable binding write');
    assert.equal(existsSync(join(bindingSealCrashDir, 'evidence-binding.json')), true,
      'crash leaves its exact terminal-bound evidence binding available for recovery');
    assert.equal(existsSync(join(bindingSealCrashDir, 'evidence-binding.seal.json')), false,
      'crash occurs before the external binding seal is published');
    assert.doesNotThrow(
      () => managedHostRunReceipt(root, bindingSealCrashRun.run.runId),
      'an exact terminal-bound unsealed binding remains receipt-readable for importer recovery',
    );
    assert.equal(readManagedReviewImportSeal(root, bindingSealCrashRun.run.runId), null,
      'the incomplete pair remains inadmissible to REVIEW evidence before retry repair');
    const bindingSealCrashPass = store.readReviewPasses(STORY_ID).passes.find(
      pass => pass.managedEvidenceBinding?.receiptId === bindingSealCrashReceipt.receiptId,
    );
    assert.ok(bindingSealCrashPass, 'crash window persists exactly one receipt-bound review pass before repair');
    assert.ok(
      collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(candidate => (
        candidate.code === 'managed_receipt_invalid' && candidate.evidenceId === bindingSealCrashPass.id
      )),
      'the REVIEW gate refuses persisted managed evidence until the binding seal is recovered',
    );
    assert.match(
      handlers.managed_review_evidence_import({
        runId: bindingSealCrashRun.run.runId,
        receiptId: bindingSealCrashReceipt.receiptId,
      }),
      /already imported/,
      'retry repairs the exact incomplete binding-seal pair without duplicating story evidence',
    );
    assert.ok(readManagedReviewImportSeal(root, bindingSealCrashRun.run.runId),
      'retry publishes the terminal-bound binding seal');
    assert.equal(
      store.readReviewPasses(STORY_ID).passes.filter(pass => pass.managedEvidenceBinding?.receiptId === bindingSealCrashReceipt.receiptId).length,
      1,
      'binding-seal recovery preserves exactly one provider-authored review pass',
    );
    assert.ok(
      collectReviewerEvidenceState(store, STORY_ID, root).valid.some(candidate => candidate.pass?.managedEvidenceBinding?.receiptId === bindingSealCrashReceipt.receiptId),
      'recovered binding seal restores the exact receipt to REVIEW admissibility',
    );

    const sealedRunDir = managedHostRunDirectory(root, submitted.runId);
    const terminalPath = join(sealedRunDir, 'terminal.json');
    const originalTerminal = readFileSync(terminalPath, 'utf8');
    const incompleteTerminal = JSON.parse(originalTerminal) as Record<string, unknown>;
    incompleteTerminal.processCleanup = null;
    writeFileSync(terminalPath, `${JSON.stringify(incompleteTerminal)}\n`);
    assert.throws(
      () => managedHostRunReceipt(root, submitted.runId),
      /sealed artifact digest mismatch \(binding\)/,
      'a post-import terminal rewrite invalidates the sealed evidence binding instead of minting a recomputed receipt',
    );
    assert.ok(
      collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(candidate => candidate.code === 'managed_receipt_invalid'),
      'the REVIEW gate independently rejects incomplete or ambiguous cleanup',
    );
    writeFileSync(terminalPath, originalTerminal);

    const conflictingProposalArtifact = join(sealedRunDir, 'evidence-proposal-conflict.json');
    writeFileSync(conflictingProposalArtifact, readFileSync(join(sealedRunDir, 'evidence-proposal.json')));
    assert.throws(
      () => createManagedReviewEvidenceBinding(exactIntake),
      /managed_review_evidence_import:/,
      'multiple proposal artifacts are ambiguous and fail closed at fresh intake',
    );
    assert.ok(
      collectReviewerEvidenceState(store, STORY_ID, root).invalid.some(candidate => candidate.code === 'managed_receipt_invalid'),
      'multiple proposal artifacts also fail the persisted REVIEW gate',
    );
    unlinkSync(conflictingProposalArtifact);
    assert.ok(collectReviewerEvidenceState(store, STORY_ID, root).valid.some(candidate => candidate.id === originalPass.id));

    for (const artifact of ['spec.json', 'events.jsonl', 'result.json', 'terminal.json']) {
      const artifactPath = join(sealedRunDir, artifact);
      const original = readFileSync(artifactPath, 'utf8');
      writeFileSync(artifactPath, `${original} `);
      assert.throws(
        () => createManagedReviewEvidenceBinding(exactIntake),
        /managed_review_evidence_import:/,
        `fresh intake must reject post-terminal ${artifact} tampering`,
      );
      const invalid = collectReviewerEvidenceState(store, STORY_ID, root);
      assert.ok(
        invalid.invalid.some(candidate => candidate.code === 'managed_receipt_invalid'),
        `REVIEW gate must reject post-terminal ${artifact} tampering`,
      );
      writeFileSync(artifactPath, original);
      const restored = collectReviewerEvidenceState(store, STORY_ID, root);
      assert.equal(restored.invalid.some(candidate => candidate.code === 'managed_receipt_invalid'), false, `${artifact} byte restoration should restore exact receipt validity`);
    }

    const proposalPath = join(sealedRunDir, 'evidence-proposal.json');
    const proposal = JSON.parse(readFileSync(proposalPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(proposalPath, `${JSON.stringify({ ...proposal, note: 'tampered after terminal' })}\n`);
    assert.throws(
      () => createManagedReviewEvidenceBinding(exactIntake),
      /managed_review_evidence_import:/,
      'fresh intake must reject post-terminal proposal tampering',
    );
    const tampered = collectReviewerEvidenceState(store, STORY_ID, root);
    assert.ok(tampered.invalid.some(candidate => candidate.code === 'managed_receipt_invalid'), 'REVIEW gate must recheck and reject post-terminal proposal tampering');

    console.log('managed-review-evidence-smoke PASS');
  } finally {
    process.chdir(originalCwd);
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--proposal-worker') {
  proposalWorkerMain(
    process.argv[3] ?? '', process.argv[4] ?? '', process.argv[5] ?? '',
    process.argv[6] ?? '', process.argv[7] ?? '',
  ).catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
} else if (process.argv[2] === '--import-worker') {
  importWorkerMain(
    process.argv[3] ?? '', process.argv[4] ?? '', process.argv[5] ?? '',
    process.argv[6] ?? '', process.argv[7] ?? '', process.argv[8] ?? '',
    process.argv[9], process.argv[10],
  ).catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
} else if (process.argv[2] === '--sanitized-proposal-tool') {
  sanitizedProposalToolMain(process.argv[3] ?? '', process.argv[4] ?? '', process.argv[5] ?? '').catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
} else if (process.argv[2] === '--brokered-native-binding-fixture') {
  try {
    brokeredNativeBindingFixtureMain(process.argv[3] ?? '', process.argv[4] ?? '');
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
} else {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
