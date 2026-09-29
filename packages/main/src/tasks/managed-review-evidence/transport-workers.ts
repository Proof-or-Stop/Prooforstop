import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';

import { resetConfigCache } from "../../core/config.js";

import { PROOF_OR_STOP_DIR } from "../../core/proof-or-stop-paths.js";



import { managedHostRunDirectory, managedHostRunReceipt, getManagedHostRunStatus, readManagedHostRunResult, signManagedReviewProposalInvocation, submitManagedHostRun, writeManagedReviewEvidenceProposal } from "../../core/managed-host-run.js";
import { buildManagedReviewerPrompt } from "../../core/managed-review-evidence.js";








import { signNativeReviewInvocationAttestation } from "../../core/native-review-attestation.js";
import { issueNativeReviewEvidenceBinding } from "../../core/native-review-evidence.js";
import { getSessionIdentity } from "../../core/owner-session.js";
import { StoryStore } from "../../core/store.js";

import type { ReviewRun } from "../../core/types.js";


import { createManagedReviewEvidenceHandlers } from "../../handlers/managed-review-evidence.js";

import { eventually, managedReadEvidence, waitForExit } from "./fixtures.js";
import { CLI, STORY_ID, LANE, withoutManagedAmbientAuthority, SELF, REVIEW_RUN_ID, MANAGED_REVIEW_DESCRIPTOR_DEADLINE_MS, MANAGED_REVIEW_DESCRIPTOR_CLAIM_TIMEOUT_MS } from "./environment.js";

export async function sanitizedProposalToolMain(root: string, gatePath: string, reviewRunId: string): Promise<void> {
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

export async function runBrokeredCli(
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

export interface BrokeredNativeBindingFixtureArgs {
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

export function brokeredNativeBindingFixtureMain(root: string, encodedArgs: string): void {
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

export async function runBrokeredNativeBindingFixture(
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

export async function runManagedProposalCliWithAttestation(
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

export async function assertDescriptorBackedProviderProposalTransport(
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
  const descriptorLauncher: import("../../core/managed-host-run.js").ManagedHostRunWorkerLauncher = request => {
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

export async function importWorkerMain(
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

export async function proposalWorkerMain(
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
