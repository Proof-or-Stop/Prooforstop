#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cancelManagedHostRun,
  cleanupManagedCrossHostReviewWorktree,
  defaultManagedHostRunWorkerLauncher,
  getManagedHostRunStatus,
  recoverManagedHostRun,
  MANAGED_HOST_RUN_OUTPUT_RETENTION_MAX_BYTES,
  managedHostRunDirectory,
  readManagedHostRunOutput,
  readManagedHostRunResult,
  managedHostRunReceipt,
  managedHostRunReceiptsRoot,
  readManagedHostRunBinding,
  readManagedReviewEvidenceProposal,
  readManagedReviewImportSeal,
  pruneExpiredManagedHostRuns,
  reapManagedHostRunProviderProcess,
  runManagedHostRunWorker,
  scanManagedHostRunRuntime,
  submitManagedHostRun,
  writeManagedReviewEvidenceProposal,
  writeManagedHostRunEvidenceBinding,
  type ManagedHostRunWorkerLauncher,
} from '../core/managed-host-run.js';
import {
  createManagedReviewEvidenceBinding,
  verifyManagedReviewEvidence,
} from '../core/managed-review-evidence.js';
import { classifyManagedReviewFinalEnvelope, isStrictManagedReviewFindingProposal, type HostRunRunner, type HostRunSpawnResult } from '../core/host-run.js';
import { PROOF_OR_STOP_DIR } from '../core/proof-or-stop-paths.js';
import { acquireMkdirLock } from '../core/mkdir-lock.js';
import { StoryStore } from '../core/store.js';
import { createDoctorHandlers } from '../handlers/doctor.js';
import { withoutReviewerDispatchAuthority } from './reviewer-dispatch-authority.js';

const root = mkdtempSync(join(tmpdir(), 'managed-host-run-smoke-'));
const SELF = fileURLToPath(import.meta.url);
const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

function successfulResult(): HostRunSpawnResult {
  const finalAssistantResult = JSON.stringify({
    schemaVersion: 'lattice.managed_review_final_proposal.v1',
    storyId: 'B-managed',
    providerAgent: 'lattice-review-quality',
    lane: 'lattice-review-quality',
    reviewRunId: 'B-managed:RR-001',
    conclusion: 'pass',
    note: 'Provider inspected the managed changes and found no blocking issue.',
    readManifest: {
      filesReadFully: ['packages/main/src/core/managed-host-run.ts'],
      filesTriagedByName: [],
      scanEscalationReason: null,
      candidateSpecSetDigest: 'a'.repeat(64),
      corpusDigest: 'b'.repeat(64),
    },
    readLog: {
      filesReadFully: ['packages/main/src/core/managed-host-run.ts'],
      filesTriagedByName: [],
      summary: { readCount: 1, tokenCount: null },
      digest: 'c'.repeat(64),
    },
  });
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    terminalReason: 'completed',
    finalAssistantResult,
    finalAssistantResultCount: 1,
    finalAssistantResultTruncated: false,
  };
}

async function eventually(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function submitArgs(caseRoot: string, promptText: string, deadlineMs = 2_000) {
  return {
    root: caseRoot,
    cwd: caseRoot,
    host: 'codex' as const,
    storyId: 'B-managed',
    phase: 'REVIEW',
    agentType: 'lattice-review-quality',
    reviewRunId: 'B-managed:RR-001',
    lane: 'lattice-review-quality',
    promptText,
    deadlineMs,
    projectRootHash: 'sha256:test-root',
    profile: 'managed_reviewer',
    reviewBinding: {
      headHash: 'head-managed',
      materialHash: 'material-managed',
      storyFilesHash: 'story-managed',
      promptHash: 'prompt-managed',
      envelopeId: null,
    },
  };
}

async function main(): Promise<void> {
  const missingReadBinding = JSON.stringify({
    schemaVersion: 'lattice.managed_review_final_proposal.v1',
    storyId: 'B-managed',
    providerAgent: 'lattice-review-quality',
    lane: 'lattice-review-quality',
    reviewRunId: 'B-managed:RR-001',
    conclusion: 'pass',
    note: 'This formerly accepted a provider assertion without read proof.',
    readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
  });
  assert.equal(classifyManagedReviewFinalEnvelope(missingReadBinding).kind, 'malformed',
    'managed proposals fail closed without non-empty read evidence and candidate/corpus bindings');
  assert.equal(
    isStrictManagedReviewFindingProposal({ desc: 'coerced', severity: ['critical'], category: 'happy' }),
    false,
    'JSON array severity must not coerce through String() into a blocking finding',
  );
  assert.equal(
    isStrictManagedReviewFindingProposal({ desc: 'coerced', severity: 'critical', category: ['edge'] }),
    false,
    'JSON array category must not coerce through String() into a valid finding',
  );
  assert.equal(
    isStrictManagedReviewFindingProposal({ desc: 'ok', severity: 'critical', category: 'happy' }),
    true,
    'string enum severity/category remain accepted',
  );

  const ordinaryHelp = execFileSync(process.execPath, [CLI, 'help', '--full'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, LATTICE_BRIEF_OUTPUT: '0' },
  });
  assert.doesNotMatch(ordinaryHelp, /\bhost_run_worker\b/, 'ordinary help catalog hides the private detached worker command');
  assert.match(ordinaryHelp, /\bhost_run_status\b/, 'public managed host-run commands remain discoverable');

  const sealedEnv = { PATH: '/usr/bin', SENTINEL: 'redacted-only' };
  const silentRunner: HostRunRunner = async () => successfulResult();
  async function runSealedEnvironmentCase(
    label: string,
    mutate: (envPath: string) => void,
    expectedReason: RegExp,
  ): Promise<void> {
    const caseRoot = join(root, label);
    mkdirSync(caseRoot, { recursive: true });
    const launcher: ManagedHostRunWorkerLauncher = async request => {
      const envPath = join(managedHostRunDirectory(caseRoot, request.runId), 'input.env.json');
      assert.equal(existsSync(envPath), true, `${label}: sealed environment must be written before the worker starts`);
      mutate(envPath);
      void runManagedHostRunWorker(
        request,
        { runner: silentRunner, env: { ...process.env, SENTINEL: 'ambient-leak' } },
      );
      return { pid: process.pid };
    };
    const submittedEnv = await submitManagedHostRun(
      { ...submitArgs(caseRoot, `env ${label}`), environment: sealedEnv, profile: null },
      { launchWorker: launcher, claimTimeoutMs: 2_000, claimPollMs: 5 },
    );
    const terminal = submittedEnv.terminal
      ?? (await getManagedHostRunStatus({ root: caseRoot, runId: submittedEnv.runId })).run.terminal;
    assert.ok(terminal, `${label}: worker must seal a terminal`);
    assert.match(terminal.reason, expectedReason, `${label}: sealed environment bypass must fail closed`);
    assert.equal(terminal.state, 'failed');
  }
  await runSealedEnvironmentCase('env-missing', path => unlinkSync(path), /worker_environment_missing/);
  await runSealedEnvironmentCase('env-null', path => writeFileSync(path, 'null\n'), /worker_environment_invalid/);

  const failedCleanupParent = mkdtempSync(join(tmpdir(), 'lattice-xhr-review-'));
  const failedCleanupWorktree = join(failedCleanupParent, 'worktree');
  mkdirSync(failedCleanupWorktree, { recursive: true });
  assert.throws(
    () => cleanupManagedCrossHostReviewWorktree(root, failedCleanupWorktree),
    /git|worktree/i,
    'git worktree mutation failure must be observable instead of being followed by filesystem deletion',
  );
  assert.equal(existsSync(failedCleanupParent), true,
    'failed git worktree removal retains the snapshot for diagnosis and bounded retry');
  rmSync(failedCleanupParent, { recursive: true, force: true });

  let unsupportedSpawned = false;
  const unsupported = await submitManagedHostRun(submitArgs(join(root, 'unsupported'), 'must not spawn'), {
    platform: 'win32',
    launchWorker: async () => { unsupportedSpawned = true; return { pid: process.pid }; },
  });
  assert.equal(unsupportedSpawned, false, 'unsupported platforms must fail before worker/provider spawn');
  assert.equal(unsupported.state, 'failed');
  assert.equal(unsupported.replacementSafe, true);
  assert.equal(unsupported.terminal?.reason, 'unsupported_platform:win32');
  assert.equal(
    managedHostRunReceipt(join(root, 'unsupported'), unsupported.runId).state,
    'failed',
    'unsupported platforms still expose an exact terminal receipt for status and audit',
  );

  // CHK-001:adversarial:1 is immutably pinned to this command. Keep its
  // corruption/partial/identity fail-closed boundary executable here rather
  // than relying on another smoke's output as indirect proof.
  const corruptRuntimeRoot = join(root, 'lifecycle-corrupt-runtime');
  const corruptRuntime = await submitManagedHostRun(submitArgs(corruptRuntimeRoot, 'corrupt runtime'), {
    launchWorker: async () => ({ pid: process.pid }),
    claimTimeoutMs: 10,
    claimPollMs: 5,
  });
  writeFileSync(join(managedHostRunDirectory(corruptRuntimeRoot, corruptRuntime.runId), 'spec.json'), '{corrupt');
  await assert.rejects(
    getManagedHostRunStatus({ root: corruptRuntimeRoot, runId: corruptRuntime.runId }),
    /JSON|Unexpected|position/i,
    'corrupt runtime state must fail closed instead of fabricating replacement safety',
  );
  assert.equal(scanManagedHostRunRuntime(corruptRuntimeRoot).corrupt, 1,
    'corrupt runtime state remains an explicit diagnostic classification');

  for (const missingArtifact of ['owner.json', 'snapshot.json', 'terminal.json'] as const) {
    const partialRoot = join(root, `lifecycle-partial-${missingArtifact}`);
    const partial = await submitManagedHostRun(submitArgs(partialRoot, `missing ${missingArtifact}`), {
      launchWorker: async () => ({ pid: process.pid }),
      claimTimeoutMs: 10,
      claimPollMs: 5,
    });
    unlinkSync(join(managedHostRunDirectory(partialRoot, partial.runId), missingArtifact));
    await assert.rejects(
      getManagedHostRunStatus({ root: partialRoot, runId: partial.runId }),
      /managed host run .* partial runtime: .* missing|ENOENT/i,
      `missing ${missingArtifact} must not project a resumable run`,
    );
    const diagnostic = scanManagedHostRunRuntime(partialRoot).runs[0];
    assert.equal(diagnostic?.replacementSafe, null,
      `missing ${missingArtifact} preserves unknown replacement safety`);
    assert.equal(diagnostic?.residualProcessGroup, null,
      `missing ${missingArtifact} preserves unknown residual-process state`);
  }

  // The requested runId selects its directory and must remain the immutable
  // identity of every artifact read from it.  Before this guard, a complete,
  // self-consistent runtime for identity B copied under identity A's directory
  // was projected as B and could drive status/cancel/reconcile/cleanup for the
  // wrong sealed spec.  Do not use a live provider or process signals here:
  // terminal no-claim fixtures give us the complete durable artifact shape.
  const swappedIdentityRoot = join(root, 'cross-run-artifact-swap');
  const requested = await submitManagedHostRun(submitArgs(swappedIdentityRoot, 'requested identity'), {
    launchWorker: async () => ({ pid: process.pid }),
    claimTimeoutMs: 10,
    claimPollMs: 5,
  });
  const foreign = await submitManagedHostRun({ ...submitArgs(swappedIdentityRoot, 'foreign identity'), reviewRunId: 'B-managed:RR-002' }, {
    launchWorker: async () => ({ pid: process.pid }),
    claimTimeoutMs: 10,
    claimPollMs: 5,
  });
  assert.notEqual(requested.runId, foreign.runId);
  const requestedDirectory = managedHostRunDirectory(swappedIdentityRoot, requested.runId);
  const foreignDirectory = managedHostRunDirectory(swappedIdentityRoot, foreign.runId);
  rmSync(requestedDirectory, { recursive: true, force: true });
  cpSync(foreignDirectory, requestedDirectory, { recursive: true });
  const crossRunMismatch = /managed host run .* (spec|owner|snapshot|terminal) runId binding mismatch/;
  await assert.rejects(
    getManagedHostRunStatus({ root: swappedIdentityRoot, runId: requested.runId }),
    crossRunMismatch,
    'status must fail closed rather than project a foreign self-consistent run',
  );
  await assert.rejects(
    cancelManagedHostRun({ root: swappedIdentityRoot, runId: requested.runId }),
    crossRunMismatch,
    'cancel must not write or reconcile against a foreign self-consistent run',
  );
  assert.throws(
    () => readManagedHostRunOutput({ root: swappedIdentityRoot, runId: requested.runId }),
    crossRunMismatch,
    'output must remain bound to the requested run directory identity',
  );
  assert.throws(
    () => readManagedHostRunResult(swappedIdentityRoot, requested.runId),
    crossRunMismatch,
    'result reads must not return a foreign run result',
  );
  assert.throws(
    () => readManagedHostRunBinding(swappedIdentityRoot, requested.runId),
    crossRunMismatch,
    'binding reads must not return a foreign run spec',
  );
  assert.throws(
    () => managedHostRunReceipt(swappedIdentityRoot, requested.runId),
    crossRunMismatch,
    'receipt reads must not seal or return a foreign terminal',
  );
  await assert.rejects(
    runManagedHostRunWorker({ root: swappedIdentityRoot, runId: requested.runId }),
    crossRunMismatch,
    'worker entry must refuse a directory whose artifacts belong to another run',
  );

  const postSpawnThrowRoot = join(root, 'worker-launch-post-spawn-throw');
  let postSpawnWorker: ReturnType<typeof spawn> | null = null;
  const postSpawnThrow = await submitManagedHostRun(submitArgs(postSpawnThrowRoot, 'launcher throws after spawn'), {
    launchWorker: async () => {
      // Natural bounded exit keeps this post-spawn ambiguity fixture from
      // sending a negative-PID cleanup signal. A malformed PID of 1 would turn
      // a POSIX broadcast.
      postSpawnWorker = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 250)'], { detached: true, stdio: 'ignore' });
      assert.ok(postSpawnWorker.pid);
      throw new Error('post-spawn fixture failure');
    },
  });
  assert.equal(postSpawnThrow.state, 'failed');
  assert.equal(postSpawnThrow.terminal?.reason, 'worker_launch_failed:post-spawn fixture failure');
  const postSpawnExit = new Promise<void>(resolveExit => postSpawnWorker!.once('close', () => resolveExit()));
  await postSpawnExit;
  assert.equal(postSpawnThrow.replacementSafe, false,
    'an exception with ambiguous post-spawn worker ownership must never publish replacementSafe=true');

  const descriptorFailureRoot = join(root, 'worker-capability-descriptor-epipe');
  const descriptorFailureRunId = `mhr-${randomUUID()}`;
  const descriptorFailurePidPath = join(descriptorFailureRoot, 'child.pid');
  const descriptorFailureEntrypoint = join(descriptorFailureRoot, 'close-worker-capability-fd.cjs');
  mkdirSync(managedHostRunDirectory(descriptorFailureRoot, descriptorFailureRunId), { recursive: true });
  writeFileSync(descriptorFailureEntrypoint, [
    `const fs = require('node:fs');`,
    `fs.closeSync(3);`,
    `fs.writeFileSync(${JSON.stringify(descriptorFailurePidPath)}, String(process.pid));`,
    `setInterval(() => {}, 1000);`,
  ].join('\n'));
  const originalEntrypoint = process.argv[1];
  try {
    process.argv[1] = descriptorFailureEntrypoint;
    await assert.rejects(
      async () => defaultManagedHostRunWorkerLauncher({
        root: descriptorFailureRoot,
        runId: descriptorFailureRunId,
        proposalInvocationPrivateKey: 'x'.repeat(2 * 1024 * 1024),
      }),
      /worker capability descriptor failed:.*EPIPE/,
      'a real async fd3 EPIPE is returned as a supervised launcher failure',
    );
  } finally {
    process.argv[1] = originalEntrypoint;
  }
  const descriptorFailurePid = Number(readFileSync(descriptorFailurePidPath, 'utf8'));
  assert.throws(
    () => process.kill(descriptorFailurePid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
    'the worker capability fd3 failure kills and reaps the exact detached child',
  );

  const descriptorDeliveryRoot = join(root, 'worker-capability-descriptor-delivery');
  const descriptorDeliveryRunId = `mhr-${randomUUID()}`;
  const descriptorDeliveryPayloadPath = join(descriptorDeliveryRoot, 'payload.txt');
  const descriptorDeliveryEntrypoint = join(descriptorDeliveryRoot, 'hold-worker-capability-fd.cjs');
  mkdirSync(managedHostRunDirectory(descriptorDeliveryRoot, descriptorDeliveryRunId), { recursive: true });
  writeFileSync(descriptorDeliveryEntrypoint, [
    `const fs = require('node:fs');`,
    `fs.writeFileSync(${JSON.stringify(descriptorDeliveryPayloadPath)}, fs.readFileSync(3, 'utf8'));`,
    `setTimeout(() => process.exit(0), 800);`,
  ].join('\n'));
  const descriptorDeliveryEntrypointOriginal = process.argv[1];
  try {
    process.argv[1] = descriptorDeliveryEntrypoint;
    const startedAt = Date.now();
    const launched = await defaultManagedHostRunWorkerLauncher({
      root: descriptorDeliveryRoot,
      runId: descriptorDeliveryRunId,
      proposalInvocationPrivateKey: 'descriptor-delivery-test-key',
    });
    assert.ok(launched.pid > 1, 'successful descriptor delivery returns the detached worker pid');
    assert.ok(Date.now() - startedAt < 500,
      'descriptor delivery must settle on local write finish, not wait for the long-lived worker to close fd 3');
    await eventually(
      async () => existsSync(descriptorDeliveryPayloadPath),
      'worker did not receive the descriptor-only capability payload',
    );
    assert.equal(readFileSync(descriptorDeliveryPayloadPath, 'utf8'), 'descriptor-delivery-test-key',
      'descriptor payload reaches the worker before detached submission returns');
    await eventually(async () => {
      try { process.kill(launched.pid, 0); return false; } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }, 'descriptor delivery fixture worker did not exit after its deliberate hold', 2_000);
  } finally {
    process.argv[1] = descriptorDeliveryEntrypointOriginal;
  }

  const ambiguousIdentityRoot = join(root, 'lifecycle-ambiguous-identity');
  let releaseAmbiguousRunner!: () => void;
  let ambiguousAbortObserved = false;
  let ambiguousRunnerCalls = 0;
  const ambiguousRunner: HostRunRunner = plan => new Promise(resolve => {
    ambiguousRunnerCalls += 1;
    const observeAbort = () => { ambiguousAbortObserved = true; };
    if (plan.signal?.aborted) observeAbort();
    else plan.signal?.addEventListener('abort', observeAbort, { once: true });
    // Reconciliation, not this simulated provider, owns the terminal. Keep
    // the runner pending until that terminal is asserted, then release and
    // await the exact worker so this fixture cannot leak background admission.
    releaseAmbiguousRunner = () => resolve(successfulResult());
  });
  let ambiguousWorker: Promise<unknown> | null = null;
  const ambiguousLauncher: ManagedHostRunWorkerLauncher = async request => {
    ambiguousWorker = runManagedHostRunWorker(request, {
      runner: ambiguousRunner,
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
      cancelPollMs: 5,
    });
    return { pid: process.pid };
  };
  const ambiguous = await submitManagedHostRun(
    // Keep the real worker deadline comfortably outside this fixture. The
    // production observation clock below crosses the deadline explicitly, so
    // host load cannot seal a terminal before the identity mutation lands.
    submitArgs(ambiguousIdentityRoot, 'ambiguous identity', 30_000),
    { launchWorker: ambiguousLauncher, claimTimeoutMs: 500, claimPollMs: 5 },
  );
  const ambiguousSnapshotPath = join(managedHostRunDirectory(ambiguousIdentityRoot, ambiguous.runId), 'snapshot.json');
  const ambiguousSnapshot = JSON.parse(readFileSync(ambiguousSnapshotPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(ambiguousSnapshotPath, `${JSON.stringify({
    ...ambiguousSnapshot,
    providerLaunchState: 'spawned',
    providerIdentity: {
      pid: process.pid,
      pgid: process.pid,
      spawnedAt: new Date().toISOString(),
      startFingerprint: 'definitely-not-the-live-process-start-fingerprint',
      processGroupIsolated: true,
    },
  })}\n`);
  const ambiguousSignals: Array<'SIGTERM' | 'SIGKILL'> = [];
  const ambiguousProcessGroupOps = {
    rows: (pgid: number) => [{
      pid: process.pid,
      pgid,
      sessionId: process.pid,
      start: 'live-process-start-fingerprint',
    }],
    signal: (_pgid: number, signal: 'SIGTERM' | 'SIGKILL') => { ambiguousSignals.push(signal); },
    wait: async () => {},
  };
  const ambiguousDeadline = Date.parse(ambiguous.deadlineAt);
  const ambiguousBeforeDeadline = await recoverManagedHostRun({
    root: ambiguousIdentityRoot,
    runId: ambiguous.runId,
    now: () => ambiguousDeadline - 1,
    processGroupOps: ambiguousProcessGroupOps,
  });
  assert.equal(ambiguousBeforeDeadline.run.terminal, null,
    'the mismatched live identity is installed before deadline reconciliation');
  await recoverManagedHostRun({
    root: ambiguousIdentityRoot,
    runId: ambiguous.runId,
    now: () => ambiguousDeadline,
    processGroupOps: ambiguousProcessGroupOps,
  });
  const ambiguousTerminal = await recoverManagedHostRun({
    root: ambiguousIdentityRoot,
    runId: ambiguous.runId,
    now: () => ambiguousDeadline + 300,
    processGroupOps: ambiguousProcessGroupOps,
  });
  assert.equal(ambiguousTerminal.run.state, 'timed_out');
  assert.equal(ambiguousTerminal.run.replacementSafe, false,
    'PID/PGID fingerprint ambiguity must never authorize replacement');
  assert.deepEqual(ambiguousSignals, [],
    'ambiguous reconciliation must not signal the mismatched live process group');
  assert.doesNotThrow(() => process.kill(process.pid, 0),
    'ambiguous reconciliation must not signal the mismatched live process');
  assert.ok(ambiguousWorker, 'ambiguous fixture retains the exact in-process worker promise');
  await eventually(async () => ambiguousAbortObserved,
    'ambiguous worker did not observe the externally persisted deadline cancellation');
  releaseAmbiguousRunner();
  await ambiguousWorker;
  assert.equal(ambiguousRunnerCalls, 1,
    'releasing the reconciled ambiguous worker cannot launch a late replacement provider');

  const completionCase = join(root, 'completion');
  let releaseCompletion!: () => void;
  let completionRunnerCalls = 0;
  const completionGate = new Promise<void>(resolve => { releaseCompletion = resolve; });
  const completionRunner: HostRunRunner = async plan => {
    completionRunnerCalls += 1;
    plan.onChunk?.({ stream: 'stdout', text: '{"type":"turn.started"}\n' });
    await completionGate;
    plan.onChunk?.({ stream: 'stdout', text: 'x'.repeat(MANAGED_HOST_RUN_OUTPUT_RETENTION_MAX_BYTES + 1) });
    plan.onChunk?.({ stream: 'stdout', text: '{"type":"turn.completed"}\n' });
    return successfulResult();
  };
  const completionLauncher: ManagedHostRunWorkerLauncher = async request => {
    void runManagedHostRunWorker(request, {
      runner: completionRunner,
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
      cancelPollMs: 5,
    });
    return { pid: process.pid };
  };

  const submitted = await submitManagedHostRun(
    submitArgs(completionCase, 'review this change'),
    { launchWorker: completionLauncher, claimTimeoutMs: 500, claimPollMs: 5 },
  );
  assert.equal(submitted.state, 'running');
  assert.equal(submitted.terminal, null);
  assert.equal(JSON.stringify(submitted).includes('review this change'), false);
  const submittedSnapshot = JSON.parse(readFileSync(
    join(managedHostRunDirectory(completionCase, submitted.runId), 'snapshot.json'),
    'utf8',
  )) as { generation: number; state: string };
  const submittedEventRows = readFileSync(
    join(managedHostRunDirectory(completionCase, submitted.runId), 'events.jsonl'),
    'utf8',
  ).trim().split('\n');
  const submittedEvents = submittedEventRows.map(line => (JSON.parse(line) as { type: string }).type);
  assert.equal(submittedSnapshot.generation, submitted.generation,
    'the returned running projection reads the same generation that the durable snapshot published');
  assert.deepEqual(submittedEvents, ['submitted', 'worker_claimed'],
    'the worker-claim event is journaled before its snapshot generation is exposed to status/attach readers');
  // F-251: a crash after publishing the next snapshot but before appending its
  // journal event leaves a durable transition record. The next reader must
  // finish that exact transition before exposing either artifact or allowing a
  // terminal seal, rather than silently sealing an incomplete event digest.
  const recoveredSnapshot = { ...submittedSnapshot, generation: submittedSnapshot.generation + 1 };
  const recoveryEvent = {
    schemaVersion: (JSON.parse(submittedEventRows[0]!) as { schemaVersion: string }).schemaVersion,
    runId: submitted.runId,
    at: new Date().toISOString(),
    type: 'snapshot_event_recovered',
    detail: { generation: recoveredSnapshot.generation },
  };
  const completionRunDir = managedHostRunDirectory(completionCase, submitted.runId);
  writeFileSync(join(completionRunDir, 'snapshot-event-transition.json'), `${JSON.stringify({
    schemaVersion: 'lattice.managed_host_run_snapshot_event_transition.v1',
    runId: submitted.runId,
    snapshot: recoveredSnapshot,
    event: recoveryEvent,
  })}\n`);
  await assert.rejects(getManagedHostRunStatus({root:completionCase, runId:submitted.runId}),
    /snapshot\/event recovery pending/, 'readers report pending recovery without replaying the journal');
  const recoveredTransitionStatus = await recoverManagedHostRun({
    root: completionCase,
    runId: submitted.runId,
    waitMs: 0,
  });
  assert.equal(recoveredTransitionStatus.run.generation, recoveredSnapshot.generation,
    'the recovery owner completes the interrupted snapshot transition before returning status');
  assert.equal(existsSync(join(completionRunDir, 'snapshot-event-transition.json')), false,
    'a recovered snapshot/event transition leaves no replayable sidecar behind');
  const recoveredEventTypes = readFileSync(join(completionRunDir, 'events.jsonl'), 'utf8')
    .trim().split('\n').map(line => (JSON.parse(line) as { type: string }).type);
  assert.deepEqual(recoveredEventTypes, ['submitted', 'worker_claimed', 'snapshot_event_recovered'],
    'recovery appends the exact missing causal event before a terminal can seal the journal');

  const silent = await getManagedHostRunStatus({
    root: completionCase,
    runId: submitted.runId,
    afterGeneration: recoveredSnapshot.generation,
    waitMs: 30,
  });
  assert.equal(silent.changed, false, 'silence must not manufacture a terminal or restart');
  assert.equal(silent.run.state, 'running');
  assert.equal(silent.run.runId, submitted.runId);
  assert.equal(completionRunnerCalls, 1, 'silence/status polling must not launch a duplicate provider');
  const activeDiagnostic = scanManagedHostRunRuntime(completionCase, {
    now: Date.parse(submitted.deadlineAt) + 10_000,
    retentionMs: 1,
  });
  assert.equal(activeDiagnostic.active, 1);
  assert.equal(activeDiagnostic.runs[0]?.deadlineExpired, true);
  assert.equal(activeDiagnostic.runs[0]?.workerLiveness, 'alive');
  assert.equal(activeDiagnostic.runs[0]?.providerProgressMode, 'output-observable');
  const activeGc = pruneExpiredManagedHostRuns(completionCase, {
    now: Date.parse(submitted.deadlineAt) + 10_000,
    retentionMs: 1,
  });
  assert.deepEqual(activeGc.removed, [], 'GC must protect an active run even after its diagnostic deadline');
  assert.equal(activeGc.retained[0]?.reason, 'active_run_protected');

  releaseCompletion();
  await eventually(async () => {
    const status = await getManagedHostRunStatus({ root: completionCase, runId: submitted.runId });
    return status.run.state === 'completed';
  }, 'managed run did not converge to completed');
  const completed = await getManagedHostRunStatus({ root: completionCase, runId: submitted.runId });
  assert.equal(completed.run.terminal?.state, 'completed');
  assert.equal(completed.run.replacementSafe, true);
  const receipt = managedHostRunReceipt(completionCase, submitted.runId);
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.replacementSafe, true, 'the immutable receipt explicitly binds terminal replacement safety');
  assert.ok(receipt.evidenceProposalDigest);
  const expected = {
    providerHost: 'codex' as const,
    headHash: 'head-managed',
    materialHash: 'material-managed',
    storyFilesHash: 'story-managed',
    promptHash: 'prompt-managed',
    envelopeId: null,
    managedPromptDigest: `sha256:${createHash('sha256').update('review this change', 'utf8').digest('hex')}`,
  };
  const imported = createManagedReviewEvidenceBinding({
    root: completionCase,
    storyId: 'B-managed',
    providerAgent: 'lattice-review-quality',
    lane: 'lattice-review-quality',
    reviewRunId: 'B-managed:RR-001',
    runId: submitted.runId,
    receiptId: receipt.receiptId,
    expected,
  });
  assert.equal(imported.verification.diagnostic.artifactKind, 'managed-review-evidence');
  assert.equal(imported.verification.diagnostic.allowed, true);
  writeManagedHostRunEvidenceBinding(completionCase, submitted.runId, {
    schemaVersion: 'lattice.managed_review_evidence_import.v1',
    runId: submitted.runId,
    receiptId: receipt.receiptId,
    storyId: 'B-managed',
    reviewRunId: 'B-managed:RR-001',
    lane: 'lattice-review-quality',
    importedIds: ['B-managed:RP-001'],
    importedAt: imported.binding.importedAt,
  });
  const forged = verifyManagedReviewEvidence({
    root: completionCase,
    storyId: 'B-managed',
    agent: 'lattice-review-quality',
    lane: 'lattice-review-quality',
    reviewRunId: 'B-managed:RR-001',
    binding: { ...imported.binding, receiptId: 'sha256:forged' },
    expected,
  });
  assert.equal(forged.valid, false, 'forged receipt must fail the shared Proof Admissibility path');
  const verifyBound = (overrides: Partial<Parameters<typeof verifyManagedReviewEvidence>[0]> = {}) => verifyManagedReviewEvidence({
    root: completionCase,
    storyId: 'B-managed',
    agent: 'lattice-review-quality',
    lane: 'lattice-review-quality',
    reviewRunId: 'B-managed:RR-001',
    binding: imported.binding,
    expected,
    ...overrides,
  });
  assert.equal(verifyBound({ storyId: 'B-other' }).valid, false, 'cross-story receipt replay must fail');
  assert.equal(verifyBound({ agent: 'lattice-review-concept' }).valid, false, 'cross-agent receipt replay must fail');
  assert.equal(verifyBound({ lane: 'lattice-review-concept' }).valid, false, 'cross-lane receipt replay must fail');
  assert.equal(verifyBound({ reviewRunId: 'B-managed:RR-999' }).valid, false, 'cross-ReviewRun receipt replay must fail');
  assert.equal(verifyBound({ expected: { ...expected, providerHost: 'claude' } }).valid, false, 'cross-provider receipt replay must fail');
  assert.equal(verifyBound({ expected: { ...expected, headHash: 'other-head' } }).valid, false, 'stale HEAD receipt must fail');
  assert.equal(verifyBound({ expected: { ...expected, materialHash: 'other-material' } }).valid, false, 'stale material receipt must fail');
  assert.equal(verifyBound({ expected: { ...expected, storyFilesHash: 'other-story-files' } }).valid, false, 'stale story-files receipt must fail');
  assert.equal(verifyBound({ expected: { ...expected, promptHash: 'other-prompt' } }).valid, false, 'prompt-binding replay must fail');
  assert.equal(verifyBound({ expected: { ...expected, managedPromptDigest: 'sha256:other-managed-prompt' } }).valid, false, 'managed prompt digest replay must fail');
  const output = readManagedHostRunOutput({ root: completionCase, runId: submitted.runId, afterSequence: 0 });
  assert.deepEqual(output.frames.map(frame => frame.sequence), [1, 3]);
  assert.match(output.frames[0]?.text ?? '', /turn\.started/);
  assert.equal(output.truncated, true, 'over-cap provider output must be bounded and explicitly marked truncated');
  assert.ok(output.frames.every(frame => frame.text.length < MANAGED_HOST_RUN_OUTPUT_RETENTION_MAX_BYTES));

  const liveOutputPath = join(managedHostRunDirectory(completionCase, submitted.runId), 'live-output.jsonl');
  const sealedLiveOutput = readFileSync(liveOutputPath);
  appendFileSync(liveOutputPath, `${JSON.stringify({
    schemaVersion: 'lattice.managed_host_run_output.v1',
    sequence: 999,
    stream: 'stdout',
    text: '{"decision":"pass","summary":"forged after terminal"}',
    at: new Date().toISOString(),
  })}\n`, 'utf8');
  try {
    assert.throws(
      () => managedHostRunReceipt(completionCase, submitted.runId),
      /sealed artifact digest mismatch \(live-output\)/,
      'terminal receipt must reject live output mutated after sealing',
    );
    assert.throws(
      () => readManagedHostRunOutput({ root: completionCase, runId: submitted.runId, afterSequence: 0 }),
      /sealed artifact digest mismatch \(live-output\)/,
      'output consumer must reject live output mutated after sealing',
    );
  } finally {
    writeFileSync(liveOutputPath, sealedLiveOutput);
  }
  assert.equal(
    managedHostRunReceipt(completionCase, submitted.runId).receiptId,
    receipt.receiptId,
    'restored sealed live output preserves the immutable receipt',
  );

  const owner = JSON.parse(readFileSync(join(completionCase, PROOF_OR_STOP_DIR, 'runtime/host-runs', submitted.runId, 'owner.json'), 'utf8')) as Record<string, unknown>;
  assert.equal('promptText' in owner, false);
  assert.equal(JSON.stringify(owner).includes('review this change'), false);

  // F-178: The canonical final-result protocol permits a findings envelope to
  // carry a non-empty explanatory note, then discards it before durable
  // evidence. The older compatibility proposal writer must preserve that same
  // contract instead of rejecting an otherwise valid provider finding.
  const findingsExplanationCase = join(root, 'findings-explanation');
  let releaseFindingsExplanation!: () => void;
  const findingsExplanationGate = new Promise<void>(resolve => { releaseFindingsExplanation = resolve; });
  let findingsExplanationEnvironment: NodeJS.ProcessEnv | null = null;
  const findingsExplanationLauncher: ManagedHostRunWorkerLauncher = async request => {
    void runManagedHostRunWorker(request, {
      runner: async plan => {
        findingsExplanationEnvironment = { ...plan.env };
        await findingsExplanationGate;
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
      },
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
      cancelPollMs: 5,
    });
    return { pid: process.pid };
  };
  const findingsExplanationRun = await submitManagedHostRun(
    submitArgs(findingsExplanationCase, 'provider findings explanation'),
    { launchWorker: findingsExplanationLauncher, claimTimeoutMs: 500, claimPollMs: 5 },
  );
  await eventually(async () => findingsExplanationEnvironment !== null,
    'findings explanation provider did not receive the managed proposal capability');
  const findingsExplanationInput = {
    storyId: 'B-managed',
    providerAgent: 'lattice-review-quality',
    lane: 'lattice-review-quality',
    reviewRunId: 'B-managed:RR-001',
    conclusion: 'findings' as const,
    note: 'The provider explanation is diagnostic only and cannot become durable review evidence.',
    findings: [{
      desc: 'The managed proposal preserves the provider-authored finding without promoting its explanation.',
      severity: 'high' as const,
      category: 'adversarial' as const,
      files: ['packages/main/src/core/managed-host-run.ts'],
    }],
    readManifest: {
      filesReadFully: ['packages/main/src/core/managed-host-run.ts'],
      filesTriagedByName: [],
      scanEscalationReason: null,
      candidateSpecSetDigest: 'a'.repeat(64),
      corpusDigest: 'b'.repeat(64),
    },
    readLog: {
      filesReadFully: ['packages/main/src/core/managed-host-run.ts'],
      filesTriagedByName: [],
      summary: { readCount: 1, tokenCount: null },
      digest: 'c'.repeat(64),
    },
  };
  assert.throws(
    () => writeManagedReviewEvidenceProposal({
      root: findingsExplanationCase,
      runId: findingsExplanationRun.runId,
      environment: findingsExplanationEnvironment!,
      proposal: { ...findingsExplanationInput, note: 'x'.repeat(256 * 1024) },
    }),
    /proposal exceeds .* managed final envelope cap/,
    'compatibility ingress must reject an over-cap findings explanation before persistence',
  );
  const findingsExplanationProposal = writeManagedReviewEvidenceProposal({
    root: findingsExplanationCase,
    runId: findingsExplanationRun.runId,
    environment: findingsExplanationEnvironment!,
    proposal: findingsExplanationInput,
  });
  assert.equal(findingsExplanationProposal.conclusion, 'findings');
  assert.equal(findingsExplanationProposal.note, undefined,
    'findings explanations are discarded before the immutable proposal is written');
  assert.equal(findingsExplanationProposal.findings?.length, 1);
  releaseFindingsExplanation();
  await eventually(async () => {
    const status = await getManagedHostRunStatus({ root: findingsExplanationCase, runId: findingsExplanationRun.runId });
    return status.run.state === 'completed';
  }, 'findings explanation run did not seal the valid immutable proposal');
  const sealedFindingsExplanation = readManagedReviewEvidenceProposal(findingsExplanationCase, findingsExplanationRun.runId);
  assert.equal(sealedFindingsExplanation?.note, undefined,
    'the sealed evidence proposal contains no explanatory-note field');
  assert.equal(sealedFindingsExplanation?.findings?.length, 1,
    'the sealed evidence proposal retains the strict provider finding');

  const cancelCase = join(root, 'cancel');
  const cancelRunner: HostRunRunner = plan => new Promise(resolve => {
    const finish = () => resolve({
      stdout: '',
      stderr: '',
      exitCode: 130,
      timedOut: false,
      terminalReason: 'aborted',
      // Model the real default runner: abort signals a live provider, then the
      // child close is observed before the runner result is returned.
      closeObserved: true,
    });
    if (plan.signal?.aborted) finish();
    else plan.signal?.addEventListener('abort', finish, { once: true });
  });
  const cancelLauncher: ManagedHostRunWorkerLauncher = async request => {
    void runManagedHostRunWorker(request, {
      runner: cancelRunner,
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
      cancelPollMs: 5,
    });
    return { pid: process.pid };
  };
  const cancellable = await submitManagedHostRun(
    submitArgs(cancelCase, 'cancel me'),
    { launchWorker: cancelLauncher, claimTimeoutMs: 500, claimPollMs: 5 },
  );
  const firstCancel = await cancelManagedHostRun({ root: cancelCase, runId: cancellable.runId, reason: 'operator request' });
  const secondCancel = await cancelManagedHostRun({ root: cancelCase, runId: cancellable.runId, reason: 'operator request' });
  assert.equal(firstCancel.cancelRequestedAt, secondCancel.cancelRequestedAt, 'cancel must be idempotent');
  await eventually(async () => {
    const status = await getManagedHostRunStatus({ root: cancelCase, runId: cancellable.runId });
    return status.run.state === 'cancelled';
  }, 'managed run did not converge to cancelled');
  const cancelledReceipt = managedHostRunReceipt(cancelCase, cancellable.runId);
  const cancelledAgain = await cancelManagedHostRun({ root: cancelCase, runId: cancellable.runId, reason: 'late ignored cancel' });
  assert.equal(cancelledAgain.state, 'cancelled', 'cancel after terminal cannot change authoritative outcome');
  assert.equal(managedHostRunReceipt(cancelCase, cancellable.runId).receiptId, cancelledReceipt.receiptId);

  // The reserved deadline cancellation reaches a still-live provider before
  // its close boundary. `closeObserved` here is NOT the F-171 close-before-
  // deadline fence: the abort result proves that deadline authority caused the
  // close, so it must seal timed_out instead of falling through to exit 130's
  // ordinary failed classification.
  const deadlineAbortCase = join(root, 'deadline-aborts-live-provider');
  const deadlineAborted = await submitManagedHostRun(
    submitArgs(deadlineAbortCase, 'deadline aborts a live provider'),
    { launchWorker: cancelLauncher, claimTimeoutMs: 500, claimPollMs: 5 },
  );
  await cancelManagedHostRun({
    root: deadlineAbortCase,
    runId: deadlineAborted.runId,
    reason: 'absolute_deadline_exceeded',
  });
  await eventually(async () => {
    const status = await getManagedHostRunStatus({ root: deadlineAbortCase, runId: deadlineAborted.runId });
    return status.run.state === 'timed_out';
  }, 'deadline abort of a live close-observed provider did not converge to timed_out');
  const deadlineAbortedStatus = await getManagedHostRunStatus({ root: deadlineAbortCase, runId: deadlineAborted.runId });
  assert.equal(deadlineAbortedStatus.run.terminal?.reason, 'absolute_deadline_exceeded');

  const liveTerminalLockRoot = join(root, 'live-terminal-lock');
  const terminalLockReady = join(root, 'live-terminal-lock.ready');
  const terminalLockReleased = join(root, 'live-terminal-lock.released');
  let terminalLockHolderExit: Promise<void> | null = null;
  const liveLockLauncher: ManagedHostRunWorkerLauncher = async request => {
    const terminalLockHolder = spawn(process.execPath, [
      SELF,
      '--terminal-lock-holder',
      request.root,
      request.runId,
      terminalLockReady,
      terminalLockReleased,
      '2600',
    ], { stdio: 'ignore' });
    terminalLockHolderExit = new Promise<void>((resolve, reject) => {
      terminalLockHolder.once('error', reject);
      terminalLockHolder.once('close', code => code === 0 ? resolve() : reject(new Error(`terminal lock holder exited ${code}`)));
    });
    await eventually(async () => existsSync(terminalLockReady), 'live terminal-lock holder did not acquire');
    void runManagedHostRunWorker(request, {
      runner: async () => ({
        ...successfulResult(),
        stdout: 'live-holder-terminal-result',
      }),
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
    });
    return { pid: process.pid };
  };
  const liveLockRun = await submitManagedHostRun(
    submitArgs(liveTerminalLockRoot, 'terminal lock liveness', 6_000),
    { launchWorker: liveLockLauncher, claimTimeoutMs: 4_000, claimPollMs: 5 },
  );
  await eventually(async () => existsSync(terminalLockReleased), 'live terminal-lock holder did not release', 4_000);
  await eventually(async () => (await getManagedHostRunStatus({ root: liveTerminalLockRoot, runId: liveLockRun.runId })).run.terminal !== null,
    'worker did not publish terminal after live holder released', 4_000);
  const liveLockStatus = await getManagedHostRunStatus({ root: liveTerminalLockRoot, runId: liveLockRun.runId });
  const holderReleasedAt = Date.parse(readFileSync(terminalLockReleased, 'utf8'));
  const liveRunDir = join(liveTerminalLockRoot, PROOF_OR_STOP_DIR, 'runtime/host-runs', liveLockRun.runId);
  assert.ok(
    statSync(join(liveRunDir, 'terminal.json')).mtimeMs >= holderReleasedAt,
    `a live terminal-lock holder older than staleMs must not be stolen (state=${liveLockStatus.run.terminal!.state}, reason=${liveLockStatus.run.terminal!.reason}, release=${readFileSync(terminalLockReleased, 'utf8')})`,
  );
  const terminalBeforeLateTouch = readFileSync(join(liveRunDir, 'terminal.json'), 'utf8');
  const resultBeforeLateTouch = readFileSync(join(liveRunDir, 'result.json'), 'utf8');
  const eventsBeforeLateTouch = readFileSync(join(liveRunDir, 'events.jsonl'), 'utf8');
  await Promise.all([
    cancelManagedHostRun({ root: liveTerminalLockRoot, runId: liveLockRun.runId, reason: 'late cancel cannot overwrite' }),
    getManagedHostRunStatus({ root: liveTerminalLockRoot, runId: liveLockRun.runId }),
    getManagedHostRunStatus({ root: liveTerminalLockRoot, runId: liveLockRun.runId }),
  ]);
  assert.equal(readFileSync(join(liveRunDir, 'terminal.json'), 'utf8'), terminalBeforeLateTouch, 'terminal digest remains immutable after pause/resume race');
  assert.equal(readFileSync(join(liveRunDir, 'result.json'), 'utf8'), resultBeforeLateTouch, 'result digest remains immutable after pause/resume race');
  assert.equal(readFileSync(join(liveRunDir, 'events.jsonl'), 'utf8'), eventsBeforeLateTouch, 'sealed event journal remains byte-immutable after late cancel/status touches');
  if (terminalLockHolderExit) await terminalLockHolderExit;

  const terminalRaceRoot = join(root, 'terminal-race');
  let releaseTerminalRace!: () => void;
  const terminalRaceGate = new Promise<void>(resolve => { releaseTerminalRace = resolve; });
  const terminalRaceLauncher: ManagedHostRunWorkerLauncher = async request => {
    void runManagedHostRunWorker(request, {
      runner: async () => {
        await terminalRaceGate;
        return successfulResult();
      },
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
      cancelPollMs: 5,
    });
    return { pid: process.pid };
  };
  const terminalRace = await submitManagedHostRun(submitArgs(terminalRaceRoot, 'race success and cancel', 1_000), {
    launchWorker: terminalRaceLauncher,
    claimTimeoutMs: 500,
    claimPollMs: 5,
  });
  const cancelRace = cancelManagedHostRun({ root: terminalRaceRoot, runId: terminalRace.runId, reason: 'race cancel' });
  releaseTerminalRace();
  await cancelRace;
  await eventually(async () => (await getManagedHostRunStatus({ root: terminalRaceRoot, runId: terminalRace.runId })).run.terminal !== null, 'success/cancel race did not converge');
  const converged = await Promise.all(Array.from({ length: 6 }, () => getManagedHostRunStatus({ root: terminalRaceRoot, runId: terminalRace.runId })));
  const terminalStates = new Set(converged.map(status => status.run.terminal?.state));
  const receiptIds = new Set(converged.map(status => status.receipt?.receiptId));
  assert.equal(terminalStates.size, 1, 'all racing observers must converge on one terminal state');
  assert.equal(receiptIds.size, 1, 'all racing observers must converge on one immutable terminal receipt digest');

  const launchFenceRoot = join(root, 'pre-spawn-launch-authority-fence');
  let releaseLaunchFence!: () => void;
  const launchFenceGate = new Promise<void>(resolve => { releaseLaunchFence = resolve; });
  let launchFenceRunnerCalls = 0;
  const launchFenceLauncher: ManagedHostRunWorkerLauncher = async request => {
    void runManagedHostRunWorker(request, {
      runner: async plan => {
        launchFenceRunnerCalls += 1;
        await launchFenceGate;
        return {
          stdout: '', stderr: '', exitCode: plan.signal?.aborted ? 130 : 0,
          timedOut: false, terminalReason: plan.signal?.aborted ? 'aborted' : 'completed',
        };
      },
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
      cancelPollMs: 5,
    });
    return { pid: process.pid };
  };
  const launchFenced = await submitManagedHostRun(
    submitArgs(launchFenceRoot, 'pause after launch authority but before provider identity', 2_000),
    { launchWorker: launchFenceLauncher, claimTimeoutMs: 500, claimPollMs: 5 },
  );
  await eventually(async () => launchFenceRunnerCalls === 1, 'worker did not reach the pre-spawn launch fence');
  await cancelManagedHostRun({ root: launchFenceRoot, runId: launchFenced.runId, reason: 'cancel during provider launch fence' });
  await new Promise(resolve => setTimeout(resolve, 550));
  const launchFenceStatus = await getManagedHostRunStatus({ root: launchFenceRoot, runId: launchFenced.runId, waitMs: 0 });
  assert.equal(launchFenceStatus.run.state, 'cancelled',
    'a live launch-authorized worker with no provider identity converges after the bounded cooperative recovery window');
  assert.equal(launchFenceStatus.run.replacementSafe, false,
    'pre-identity cancellation is explicitly unsafe rather than pretending a bare worker PID can be reaped');
  assert.equal(launchFenceStatus.run.terminal?.processCleanup?.residualProcessGroup, true,
    'the finite terminal retains the unresolved provider-boundary residual truth');
  releaseLaunchFence();
  await eventually(async () => (await getManagedHostRunStatus({ root: launchFenceRoot, runId: launchFenced.runId })).run.terminal !== null,
    'launch-authority cancellation did not converge after the provider boundary returned');

  const grantedWithoutIdentityRoot = join(root, 'deadline-granted-without-provider-identity');
  let releaseGrantedWithoutIdentity!: () => void;
  const grantedWithoutIdentityGate = new Promise<void>(resolve => { releaseGrantedWithoutIdentity = resolve; });
  let lateProviderLaunches = 0;
  let grantedWithoutIdentityAbortObserved = false;
  const grantedWithoutIdentityLauncher: ManagedHostRunWorkerLauncher = async request => {
    void runManagedHostRunWorker(request, {
      runner: async plan => {
        const observeAbort = () => { grantedWithoutIdentityAbortObserved = true; };
        if (plan.signal?.aborted) observeAbort();
        else plan.signal?.addEventListener('abort', observeAbort, { once: true });
        await grantedWithoutIdentityGate;
        if (!plan.signal?.aborted) lateProviderLaunches += 1;
        return {
          stdout: '', stderr: '', exitCode: plan.signal?.aborted ? 130 : 0,
          timedOut: false, terminalReason: plan.signal?.aborted ? 'aborted' : 'completed',
        };
      },
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
      cancelPollMs: 5,
    });
    return { pid: process.pid };
  };
  // B-137a:F-102 — this case was ~50% flaky (measured 4 PASS / 4 FAIL over 8
  // isolated runs, independently reproduced at 3/6). With deadlineMs=40 the
  // worker and the next-touch reconciler raced for the launch fence
  // (managed-host-run.ts, under withTerminalAuthorityLock):
  //   (a) worker wins  -> providerLaunchState='granted', wedges with
  //       providerIdentity=null -> AMBIGUOUS_PROCESS_CLEANUP -> safe=false (pass)
  //   (b) reconciler wins -> 'pending'->'revoked' -> REAPED_WITHOUT_SIGNAL ->
  //       safe=true (assertion fails)
  // Both interleavings are legitimate in production -- under (b) the fence
  // provably refused to spawn any provider, so replacementSafe=true is HONEST.
  // The defect was the fixture asserting one branch of a genuine race, NOT the
  // shipped code. Make the intended branch deterministic: give the run enough
  // deadline for the worker to reach the fence, wait until it has actually been
  // GRANTED, and only then advance the status observer's clock past the
  // deadline. Keep the worker's real timer well outside this short virtual
  // sequence: otherwise it can persist cancellation before the first
  // post-deadline status touch and the fixture merely measures scheduling.
  const grantedWithoutIdentityDeadlineMs = 30_000;
  const grantedWithoutIdentity = await submitManagedHostRun(
    submitArgs(grantedWithoutIdentityRoot, 'deadline must converge without provider identity', grantedWithoutIdentityDeadlineMs),
    { launchWorker: grantedWithoutIdentityLauncher, claimTimeoutMs: 500, claimPollMs: 5 },
  );
  const grantedWithoutIdentitySnapshotPath = join(
    managedHostRunDirectory(grantedWithoutIdentityRoot, grantedWithoutIdentity.runId),
    'snapshot.json',
  );
  const grantedWithoutIdentitySubmittedAt = Date.now();
  const grantPollDeadline = grantedWithoutIdentitySubmittedAt + 2_000;
  let observedGrant = false;
  while (Date.now() < grantPollDeadline) {
    const snapshot = JSON.parse(readFileSync(grantedWithoutIdentitySnapshotPath, 'utf8')) as { providerLaunchState?: string };
    if (snapshot.providerLaunchState === 'granted') { observedGrant = true; break; }
    if (snapshot.providerLaunchState === 'revoked') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(observedGrant, true,
    'F-102 fixture: the launch fence must be observed GRANTED before the deadline elapses, otherwise this case silently tests the revoked branch instead');
  const grantedWithoutIdentityVirtualDeadline = Date.parse(grantedWithoutIdentity.deadlineAt);
  assert.ok(Number.isFinite(grantedWithoutIdentityVirtualDeadline),
    'F-102 fixture: submitted run exposes a parseable virtual deadline');
  // Touch status while still inside the absolute deadline. This proves the
  // fixture reached the granted/null state before asking production to recover
  // an expired run without waiting for the independent worker timer.
  const grantedWithoutIdentityBeforeDeadline = await recoverManagedHostRun({
    root: grantedWithoutIdentityRoot,
    runId: grantedWithoutIdentity.runId,
    waitMs: 0,
    now: () => grantedWithoutIdentityVirtualDeadline - 1,
  });
  assert.equal(grantedWithoutIdentityBeforeDeadline.run.state, 'running',
    'the granted/null worker remains live before its absolute deadline');
  assert.equal(grantedWithoutIdentityBeforeDeadline.run.terminal, null,
    'the pre-deadline status touch must not manufacture a terminal');
  // Advance only the status observer past the deadline with the provider still
  // wedged and its identity unpublished -- the exact state this case is about.
  const grantedWithoutIdentityDeadlineTouched = await recoverManagedHostRun({
    root: grantedWithoutIdentityRoot,
    runId: grantedWithoutIdentity.runId,
    waitMs: 0,
    now: () => grantedWithoutIdentityVirtualDeadline,
  });
  assert.equal(grantedWithoutIdentityDeadlineTouched.run.state, 'running',
    'the first post-deadline touch records cancellation and preserves the bounded cooperative window');
  assert.equal(grantedWithoutIdentityDeadlineTouched.run.terminal, null,
    'the first post-deadline touch must give the worker a chance to observe cancellation');
  const grantedWithoutIdentityRecovered = await recoverManagedHostRun({
    root: grantedWithoutIdentityRoot,
    runId: grantedWithoutIdentity.runId,
    waitMs: 0,
    now: () => grantedWithoutIdentityVirtualDeadline + 550,
  });
  assert.equal(grantedWithoutIdentityRecovered.run.state, 'timed_out',
    'a live granted/null worker cannot wedge reconciliation forever after the bounded recovery grace');
  assert.equal(grantedWithoutIdentityRecovered.run.replacementSafe, false,
    'pre-identity recovery remains explicitly replacement-unsafe because a bare worker pid is never trusted for reaping');
  assert.equal(grantedWithoutIdentityRecovered.run.terminal?.processCleanup?.residualProcessGroup, true,
    'the terminal retains residual-process truth instead of claiming an untracked provider was reaped');
  await eventually(async () => grantedWithoutIdentityAbortObserved,
    'the deadline cancellation request must reach the granted worker before the fixture releases its launch fence');
  releaseGrantedWithoutIdentity();
  await eventually(async () => (await getManagedHostRunStatus({
    root: grantedWithoutIdentityRoot,
    runId: grantedWithoutIdentity.runId,
    waitMs: 0,
  })).run.terminal !== null, 'deadline run did not converge after the worker observed cancellation');
  const grantedWithoutIdentityTerminal = await getManagedHostRunStatus({
    root: grantedWithoutIdentityRoot,
    runId: grantedWithoutIdentity.runId,
    waitMs: 0,
  });
  assert.equal(lateProviderLaunches, 0,
    'the cancellation signal observed after the launch grant prevents a late provider launch');
  assert.equal(grantedWithoutIdentityTerminal.run.state, 'timed_out');

  const lateSnapshotRoot = join(root, 'late-snapshot-writer');
  let lateChunk: ((chunk: { stream: 'stdout' | 'stderr'; text: string }) => void) | undefined;
  const lateSnapshotLauncher: ManagedHostRunWorkerLauncher = async request => {
    void runManagedHostRunWorker(request, {
      runner: async plan => {
        lateChunk = plan.onChunk;
        return successfulResult();
      },
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
    });
    return { pid: process.pid };
  };
  const lateSnapshot = await submitManagedHostRun(
    submitArgs(lateSnapshotRoot, 'late snapshot writer', 1_000),
    { launchWorker: lateSnapshotLauncher, claimTimeoutMs: 500, claimPollMs: 5 },
  );
  await eventually(async () => (await getManagedHostRunStatus({ root: lateSnapshotRoot, runId: lateSnapshot.runId })).run.terminal !== null,
    'late-snapshot control did not complete');
  const lateReceiptBefore = managedHostRunReceipt(lateSnapshotRoot, lateSnapshot.runId);
  lateChunk?.({ stream: 'stdout', text: 'late provider progress after terminal' });
  const lateStatus = await getManagedHostRunStatus({ root: lateSnapshotRoot, runId: lateSnapshot.runId });
  assert.equal(lateStatus.run.state, 'completed', 'late snapshot writers cannot regress the terminal projection');
  assert.equal(managedHostRunReceipt(lateSnapshotRoot, lateSnapshot.runId).receiptId, lateReceiptBefore.receiptId,
    'late snapshot writers cannot change terminal generation or receipt digest');

  const deadlineCase = join(root, 'deadline');
  const deadlineLauncher: ManagedHostRunWorkerLauncher = async request => {
    void runManagedHostRunWorker(request, {
      runner: cancelRunner,
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
      cancelPollMs: 5,
    });
    return { pid: process.pid };
  };
  const expiring = await submitManagedHostRun(
    submitArgs(deadlineCase, 'deadline me', 40),
    { launchWorker: deadlineLauncher, claimTimeoutMs: 500, claimPollMs: 5 },
  );
  await new Promise(resolve => setTimeout(resolve, 60));
  const reconciled = await getManagedHostRunStatus({
    root: deadlineCase,
    runId: expiring.runId,
    waitMs: 500,
  });
  assert.equal(reconciled.run.state, 'timed_out');
  assert.equal(reconciled.run.terminal?.reason, 'absolute_deadline_exceeded');
  assert.equal(reconciled.run.replacementSafe, true);

  const timerFailureRoot = join(root, 'timer-callback-failure');
  let timerFailureWorker: ReturnType<typeof spawn> | null = null;
  const timerFailureSubmission = await submitManagedHostRun(
    // Cold-start of this smoke file as a worker can exceed 500ms under
    // aggregate load. Keep the deadline well above the claim allowance so the
    // corrupt-cancel injection still runs against a live supervisor.
    submitArgs(timerFailureRoot, 'timer callback failures stay supervised', 30_000),
    {
      launchWorker: async request => {
        timerFailureWorker = spawn(process.execPath, [SELF, '--timer-error-worker', request.root, request.runId], {
          stdio: 'ignore',
        });
        assert.ok(timerFailureWorker.pid);
        return { pid: timerFailureWorker.pid };
      },
      // Cold-start of this smoke file as a worker can exceed 500ms under aggregate load.
      claimTimeoutMs: 10_000,
      claimPollMs: 5,
    },
  );
  assert.equal(timerFailureSubmission.state, 'running');
  writeFileSync(join(managedHostRunDirectory(timerFailureRoot, timerFailureSubmission.runId), 'cancel-request.json'), '{corrupt');
  const timerWorkerExit = await new Promise<number | null>(resolveExit => timerFailureWorker!.once('close', resolveExit));
  assert.equal(timerWorkerExit, 0, 'timer callback failure is contained by the worker supervisor');
  const timerFailureStatus = await getManagedHostRunStatus({ root: timerFailureRoot, runId: timerFailureSubmission.runId });
  assert.equal(timerFailureStatus.run.state, 'failed');
  assert.match(timerFailureStatus.run.terminal?.reason ?? '', /worker_error:/);

  const claimTimeoutCase = join(root, 'claim-timeout');

  const slowClaimCase = join(root, 'slow-claim-terminal-fence');
  const slowPrompt = 'provider input deliberately paused after FIFO open';
  const slowGate = join(slowClaimCase, 'release-prompt');
  const slowWriterReady = join(slowClaimCase, 'writer.ready');
  const slowRunnerCalled = join(slowClaimCase, 'runner.called');
  let slowWorkerExit: Promise<number | null> | null = null;
  let slowWriterExit: Promise<number | null> | null = null;
  const slowLauncher: ManagedHostRunWorkerLauncher = async request => {
    const promptPath = join(request.root, PROOF_OR_STOP_DIR, 'runtime/host-runs', request.runId, 'input.prompt');
    unlinkSync(promptPath);
    execFileSync('mkfifo', [promptPath]);
    const worker = spawn(process.execPath, [SELF, '--fifo-worker', request.root, request.runId, slowRunnerCalled], { stdio: 'ignore' });
    const writer = spawn(process.execPath, [SELF, '--fifo-writer', promptPath, slowGate, slowWriterReady, slowPrompt], { stdio: 'ignore' });
    slowWorkerExit = new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('close', resolve);
    });
    slowWriterExit = new Promise((resolve, reject) => {
      writer.once('error', reject);
      writer.once('close', resolve);
    });
    await eventually(async () => existsSync(slowWriterReady), 'FIFO writer did not connect to the slow worker');
    return { pid: worker.pid! };
  };
  const slowSubmitted = await submitManagedHostRun(
    submitArgs(slowClaimCase, slowPrompt),
    { launchWorker: slowLauncher, claimTimeoutMs: 30, claimPollMs: 5 },
  );
  assert.equal(
    slowSubmitted.state,
    'running',
    'the durable claim handshake must publish running before a slow one-shot input read',
  );
  writeFileSync(slowGate, 'release');
  assert.equal(await slowWriterExit, 0, 'FIFO writer releases the exact one-shot prompt');
  assert.equal(await slowWorkerExit, 0, 'slow worker exits cleanly after the one-shot prompt is released');
  const slowFinal = await getManagedHostRunStatus({ root: slowClaimCase, runId: slowSubmitted.runId });
  assert.notEqual(
    slowSubmitted.state,
    'failed',
    `a worker must durably claim ownership before a slow one-shot read (terminal=${slowFinal.run.terminal?.state}, runnerCalled=${existsSync(slowRunnerCalled)})`,
  );
  assert.equal(slowFinal.run.terminal?.state, 'completed', 'submit and worker converge on the same completed terminal');
  assert.equal(existsSync(slowRunnerCalled), true, 'the sole claimed worker invokes the provider exactly once');

  const corruptIntakeRoot = join(root, 'corrupt-post-claim-intake');
  let corruptIntakeWorker: ReturnType<typeof spawn> | null = null;
  const corruptIntakeSubmission = await submitManagedHostRun(
    {
      ...submitArgs(corruptIntakeRoot, 'TOP_SECRET_PROMPT_POST_CLAIM'),
      environment: { TOP_SECRET_ENVIRONMENT: 'must be removed after failed intake' },
    },
    {
      launchWorker: async request => {
        const runtime = managedHostRunDirectory(request.root, request.runId);
        writeFileSync(join(runtime, 'input.env.json'), '{corrupt');
        corruptIntakeWorker = spawn(
          process.execPath,
          [SELF, '--post-claim-intake-worker', request.root, request.runId],
          { stdio: 'ignore' },
        );
        assert.ok(corruptIntakeWorker.pid);
        return { pid: corruptIntakeWorker.pid };
      },
      claimTimeoutMs: 5_000,
      claimPollMs: 5,
    },
  );
  assert.notEqual(corruptIntakeSubmission.state, 'submitted', 'the durable claim or terminal is visible before submit returns');
  await new Promise<number | null>(resolveExit => corruptIntakeWorker!.once('close', resolveExit));
  const corruptIntakeStatus = await getManagedHostRunStatus({
    root: corruptIntakeRoot,
    runId: corruptIntakeSubmission.runId,
  });
  assert.equal(corruptIntakeStatus.run.state, 'failed', 'post-claim intake failure converges to a terminal failure');
  assert.match(corruptIntakeStatus.run.terminal?.reason ?? '', /worker_input_error:/);
  for (const oneShotName of ['input.prompt', 'input.capability', 'input.env.json']) {
    assert.equal(
      existsSync(join(managedHostRunDirectory(corruptIntakeRoot, corruptIntakeSubmission.runId), oneShotName)),
      false,
      `post-claim intake failure removes ${oneShotName}`,
    );
  }

  const crashedGrantedRoot = join(root, 'crashed-granted-without-provider-identity');
  let grantedWorker: ReturnType<typeof spawn> | null = null;
  const crashedGranted = await submitManagedHostRun(
    submitArgs(crashedGrantedRoot, 'provider launch granted before identity publication', 30_000),
    {
      launchWorker: async request => {
        grantedWorker = spawn(process.execPath, [SELF, '--granted-no-identity-worker', request.root, request.runId], {
          stdio: 'ignore',
          env: {
            ...withoutReviewerDispatchAuthority(process.env),
            PROOF_OR_STOP_USAGE_LEDGER: '0',
          },
        });
        assert.ok(grantedWorker.pid);
        return { pid: grantedWorker.pid };
      },
      // Cold-start of this smoke file as a worker can exceed 500ms under aggregate load.
      claimTimeoutMs: 10_000,
      claimPollMs: 5,
    },
  );
  const grantedSnapshotPath = join(
    managedHostRunDirectory(crashedGrantedRoot, crashedGranted.runId),
    'snapshot.json',
  );
  let lastGrantedWindow = 'missing';
  try {
    await eventually(async () => {
      if (!existsSync(grantedSnapshotPath)) {
        lastGrantedWindow = 'missing';
        return false;
      }
      try {
        const snapshot = JSON.parse(readFileSync(grantedSnapshotPath, 'utf8')) as {
          state?: string;
          providerLaunchState?: string;
          providerIdentity?: unknown;
        };
        lastGrantedWindow = `state=${snapshot.state ?? 'unset'} providerLaunchState=${snapshot.providerLaunchState ?? 'unset'} providerIdentity=${snapshot.providerIdentity === null ? 'null' : typeof snapshot.providerIdentity}`;
        return snapshot.providerLaunchState === 'granted' && snapshot.providerIdentity === null;
      } catch {
        lastGrantedWindow = 'unreadable';
        return false;
      }
    }, 'worker never persisted the granted/null provider launch crash window', 15_000);
  } catch {
    throw new Error(`worker never persisted the granted/null provider launch crash window (${lastGrantedWindow})`);
  }
  const grantedWorkerExit = new Promise<number | null>(resolveExit => grantedWorker!.once('close', resolveExit));
  process.kill(grantedWorker!.pid!, 'SIGKILL');
  await grantedWorkerExit;
  const grantedDeadline = Date.parse(crashedGranted.deadlineAt);
  await recoverManagedHostRun({
    root: crashedGrantedRoot,
    runId: crashedGranted.runId,
    now: () => grantedDeadline,
  });
  const grantedTerminal = await recoverManagedHostRun({
    root: crashedGrantedRoot,
    runId: crashedGranted.runId,
    now: () => grantedDeadline + 300,
  });
  assert.equal(grantedTerminal.run.state, 'timed_out');
  assert.equal(
    grantedTerminal.run.replacementSafe,
    false,
    'a dead worker cannot make the granted/null provider launch crash window replacement-safe',
  );
  assert.deepEqual(grantedTerminal.run.terminal?.processCleanup, {
    termSent: false,
    killSent: false,
    reaped: false,
    residualProcessGroup: true,
  });

  const exactCleanupRoot = join(root, 'next-touch-exact-provider-cleanup');
  const exactCleanupWorkers: Array<{
    worker: Promise<unknown>;
    release: () => void;
    abortObserved: () => boolean;
    runnerCalls: () => number;
  }> = [];
  const exactCleanupLauncher: ManagedHostRunWorkerLauncher = async request => {
    let released = false;
    let abortObserved = false;
    let runnerCalls = 0;
    let releaseRunner!: () => void;
    const runner: HostRunRunner = plan => new Promise(resolve => {
      runnerCalls += 1;
      const observeAbort = () => { abortObserved = true; };
      if (plan.signal?.aborted) observeAbort();
      else plan.signal?.addEventListener('abort', observeAbort, { once: true });
      // Keep the simulated provider alive until the external next-touch path
      // seals its terminal. The fixture then releases and awaits this worker,
      // preventing a residual in-process admission from outliving the case.
      releaseRunner = () => {
        if (released) return;
        released = true;
        resolve(successfulResult());
      };
    });
    const worker = runManagedHostRunWorker(request, {
      runner,
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
      cancelPollMs: 5,
    });
    exactCleanupWorkers.push({
      worker,
      release: () => releaseRunner(),
      abortObserved: () => abortObserved,
      runnerCalls: () => runnerCalls,
    });
    return { pid: process.pid };
  };
  const exactCleanup = await submitManagedHostRun(
    submitArgs(exactCleanupRoot, 'next touch must report exact provider cleanup', 5_000),
    { launchWorker: exactCleanupLauncher, claimTimeoutMs: 500, claimPollMs: 5 },
  );
  const exactCleanupSnapshotPath = join(managedHostRunDirectory(exactCleanupRoot, exactCleanup.runId), 'snapshot.json');
  await eventually(async () => {
    const snapshot = JSON.parse(readFileSync(exactCleanupSnapshotPath, 'utf8')) as { providerLaunchState?: string };
    return snapshot.providerLaunchState === 'granted';
  }, 'exact-cleanup fixture never crossed the provider launch fence');
  const exactCleanupSnapshot = JSON.parse(readFileSync(exactCleanupSnapshotPath, 'utf8')) as Record<string, unknown>;
  const exactProviderIdentity = {
    pid: 41001,
    pgid: 41001,
    spawnedAt: new Date().toISOString(),
    startFingerprint: 'fixture-provider-start',
    processGroupIsolated: true,
  };
  writeFileSync(exactCleanupSnapshotPath, `${JSON.stringify({
    ...exactCleanupSnapshot,
    providerLaunchState: 'spawned',
    providerIdentity: exactProviderIdentity,
  })}\n`);
  const cleanupSignals: string[] = [];
  let cleanupInspection = 0;
  const exactCleanupOps = {
    rows: () => {
      cleanupInspection += 1;
      return cleanupInspection < 3
        ? [{ pid: 41001, pgid: 41001, sessionId: 41001, start: 'fixture-provider-start' }]
        : [];
    },
    signal: (_pgid: number, signal: 'SIGTERM' | 'SIGKILL') => { cleanupSignals.push(signal); },
    wait: async () => {},
  };
  const exactCleanupDeadline = Date.parse(exactCleanup.deadlineAt);
  await recoverManagedHostRun({ root: exactCleanupRoot, runId: exactCleanup.runId, now: () => exactCleanupDeadline });
  const exactCleanupTerminal = await recoverManagedHostRun({
    root: exactCleanupRoot,
    runId: exactCleanup.runId,
    now: () => exactCleanupDeadline + 300,
    processGroupOps: exactCleanupOps,
  });
  assert.equal(exactCleanupTerminal.run.state, 'timed_out');
  assert.equal(exactCleanupTerminal.run.replacementSafe, true);
  assert.deepEqual(cleanupSignals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(exactCleanupTerminal.run.terminal?.processCleanup, {
    termSent: true,
    killSent: true,
    reaped: true,
    residualProcessGroup: false,
  }, 'next-touch reconciliation must seal the TERM/KILL/reap facts it actually observed');
  const exactCleanupWorker = exactCleanupWorkers[0];
  assert.ok(exactCleanupWorker, 'exact cleanup fixture retains its worker promise');
  await eventually(async () => exactCleanupWorker.abortObserved(),
    'exact cleanup worker did not observe the externally persisted deadline cancellation');
  exactCleanupWorker.release();
  await exactCleanupWorker.worker;
  assert.equal(exactCleanupWorker.runnerCalls(), 1,
    'settling a reconciled exact-cleanup worker cannot launch a late replacement provider');

  const reusedGroupSignals: string[] = [];
  let reusedGroupInspection = 0;
  const reusedGroupCleanup = await reapManagedHostRunProviderProcess(exactProviderIdentity, {
    rows: () => {
      reusedGroupInspection += 1;
      return reusedGroupInspection === 1
        ? [{ pid: 41001, pgid: 41001, sessionId: 41001, start: 'fixture-provider-start' }]
        : [{ pid: 41001, pgid: 41001, sessionId: 41001, start: 'reused-provider-start' }];
    },
    signal: (_pgid: number, signal: 'SIGTERM' | 'SIGKILL') => { reusedGroupSignals.push(signal); },
    wait: async () => {},
  });
  assert.deepEqual(reusedGroupSignals, ['SIGTERM'], 'a reused PGID must never receive SIGKILL for the prior provider');
  assert.deepEqual(reusedGroupCleanup, {
    termSent: true,
    killSent: false,
    reaped: false,
    residualProcessGroup: true,
  }, 'PGID reuse after TERM remains replacement-unsafe and records no false reap');

  const concurrentReconcileRoot = join(root, 'concurrent-next-touch-reconcile');
  const concurrentReconcile = await submitManagedHostRun(
    submitArgs(concurrentReconcileRoot, 'concurrent next touches share one cleanup transaction', 5_000),
    { launchWorker: exactCleanupLauncher, claimTimeoutMs: 500, claimPollMs: 5 },
  );
  const concurrentSnapshotPath = join(
    managedHostRunDirectory(concurrentReconcileRoot, concurrentReconcile.runId),
    'snapshot.json',
  );
  await eventually(async () => {
    const snapshot = JSON.parse(readFileSync(concurrentSnapshotPath, 'utf8')) as { providerLaunchState?: string };
    return snapshot.providerLaunchState === 'granted';
  }, 'concurrent-reconcile fixture never crossed the provider launch fence');
  const concurrentSnapshot = JSON.parse(readFileSync(concurrentSnapshotPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(concurrentSnapshotPath, `${JSON.stringify({
    ...concurrentSnapshot,
    providerLaunchState: 'spawned',
    providerIdentity: exactProviderIdentity,
  })}\n`);
  const concurrentSignals: string[] = [];
  let concurrentKilled = false;
  const concurrentOps = {
    rows: () => concurrentKilled
      ? []
      : [{ pid: 41001, pgid: 41001, sessionId: 41001, start: 'fixture-provider-start' }],
    signal: (_pgid: number, signal: 'SIGTERM' | 'SIGKILL') => {
      concurrentSignals.push(signal);
      if (signal === 'SIGKILL') concurrentKilled = true;
    },
    wait: async () => { await new Promise(resolve => setTimeout(resolve, 25)); },
  };
  const concurrentDeadline = Date.parse(concurrentReconcile.deadlineAt);
  await recoverManagedHostRun({
    root: concurrentReconcileRoot,
    runId: concurrentReconcile.runId,
    now: () => concurrentDeadline,
  });
  const [firstConcurrentStatus, secondConcurrentStatus, attachedConcurrentStatus, concurrentCancel] = await Promise.all([
    recoverManagedHostRun({
      root: concurrentReconcileRoot,
      runId: concurrentReconcile.runId,
      now: () => concurrentDeadline + 300,
      processGroupOps: concurrentOps,
    }),
    recoverManagedHostRun({
      root: concurrentReconcileRoot,
      runId: concurrentReconcile.runId,
      now: () => concurrentDeadline + 300,
      processGroupOps: concurrentOps,
    }),
    // A foreground attach is a generation-waiting status reader. Keep it in
    // the same interleaving as ordinary status, cancel, and deadline reconcile
    // so a detached caller cannot be the only participant covered by this
    // single-cleanup transaction assertion.
    getManagedHostRunStatus({
      root: concurrentReconcileRoot,
      runId: concurrentReconcile.runId,
      afterGeneration: concurrentReconcile.generation,
      waitMs: 25,
    }),
    cancelManagedHostRun({
      root: concurrentReconcileRoot,
      runId: concurrentReconcile.runId,
      reason: 'concurrent foreground attach cancellation',
    }),
  ]);
  const concurrentStatuses = [firstConcurrentStatus, secondConcurrentStatus, attachedConcurrentStatus];
  assert.ok(concurrentStatuses.every(status => status.run.state === 'timed_out'));
  assert.equal(attachedConcurrentStatus.changed, true,
    'the generation-waiting foreground attach converges on the same terminal reconciliation');
  assert.equal(concurrentCancel.runId, concurrentReconcile.runId,
    'the concurrent cancellation participant returns the same durable run identity');
  assert.deepEqual(
    concurrentSignals,
    ['SIGTERM', 'SIGKILL'],
    'concurrent next touches share exactly one provider cleanup transaction',
  );
  const concurrentCleanupWorker = exactCleanupWorkers[1];
  assert.ok(concurrentCleanupWorker, 'concurrent cleanup fixture retains its worker promise');
  await eventually(async () => concurrentCleanupWorker.abortObserved(),
    'concurrent cleanup worker did not observe the externally persisted deadline cancellation');
  concurrentCleanupWorker.release();
  await concurrentCleanupWorker.worker;
  assert.equal(concurrentCleanupWorker.runnerCalls(), 1,
    'settling a reconciled concurrent worker cannot launch a late replacement provider');

  const neverClaims: ManagedHostRunWorkerLauncher = async () => ({ pid: process.pid });
  const claimTimedOut = await submitManagedHostRun(
    submitArgs(claimTimeoutCase, 'worker never claims'),
    { launchWorker: neverClaims, claimTimeoutMs: 20, claimPollMs: 5 },
  );
  assert.equal(claimTimedOut.state, 'failed');
  assert.equal(claimTimedOut.terminal?.reason, 'worker_claim_timeout');
  assert.equal(
    claimTimedOut.replacementSafe,
    false,
    'a live but unclaimed worker identity must never be declared replacement-safe merely because claim polling expired',
  );
  let lateProviderSpawns = 0;
  const lateTerminal = await runManagedHostRunWorker(
    { root: claimTimeoutCase, runId: claimTimedOut.runId },
    { runner: async () => { lateProviderSpawns += 1; return successfulResult(); } },
  );
  assert.equal(lateTerminal.reason, 'worker_claim_timeout');
  assert.equal(lateProviderSpawns, 0, 'a late worker must observe the existing terminal before spawning a provider');

  const terminalDiagnostic = scanManagedHostRunRuntime(completionCase, {
    now: Date.parse(completed.run.terminal!.terminalAt) + 10,
    retentionMs: 1,
  });
  assert.equal(terminalDiagnostic.terminal, 1, JSON.stringify(terminalDiagnostic));
  assert.equal(terminalDiagnostic.eligibleForGc, 1);
  assert.equal(terminalDiagnostic.runs[0]?.replacementSafe, true);
  assert.equal(terminalDiagnostic.runs[0]?.residualProcessGroup, false);
  const managedDoctor = await createDoctorHandlers({
    root: completionCase,
    store: new StoryStore(completionCase),
    scanRoot: completionCase,
  }).doctor({ format: 'text' });
  assert.match(String(managedDoctor), /Managed host runs:[\s\S]*terminal=1/,
    'the pinned managed-host-run evidence command executes the real doctor consumer, not scan-only coverage');
  const sealedArtifactMutations = [
    {
      file: 'terminal.json',
      mutate: (contents: string) => `${JSON.stringify({ ...JSON.parse(contents), resultDigest: 'sha256:tampered' })}\n`,
    },
    { file: 'result.json', mutate: (contents: string) => `${contents.trim()} \n` },
    { file: 'events.jsonl', mutate: (contents: string) => `${contents}{"tampered":true}\n` },
    {
      file: 'evidence-proposal.json',
      mutate: (contents: string) => `${JSON.stringify({ ...JSON.parse(contents), note: 'tampered proposal' })}\n`,
    },
    {
      file: 'evidence-binding.json',
      mutate: (contents: string) => `${JSON.stringify({ ...JSON.parse(contents), receiptId: 'sha256:tampered' })}\n`,
    },
    {
      file: 'evidence-binding.json',
      mutate: (contents: string) => `${JSON.stringify({ ...JSON.parse(contents), importedIds: ['rewritten-import-id'] })}\n`,
    },
  ] as const;
  for (const mutation of sealedArtifactMutations) {
    const artifactPath = join(completionRunDir, mutation.file);
    const original = readFileSync(artifactPath, 'utf8');
    writeFileSync(artifactPath, mutation.mutate(original));
    const tamperedDiagnostic = scanManagedHostRunRuntime(completionCase, {
      now: Date.parse(completed.run.terminal!.terminalAt) + 10,
      retentionMs: 1,
    });
    assert.equal(tamperedDiagnostic.corrupt, 1, `${mutation.file} tamper is doctor-visible corrupt runtime`);
    const tamperedGc = pruneExpiredManagedHostRuns(completionCase, {
      now: Date.parse(completed.run.terminal!.terminalAt) + 10,
      retentionMs: 1,
    });
    assert.deepEqual(tamperedGc.removed, [], `GC refuses to delete ${mutation.file} tampered audit evidence`);
    assert.equal(tamperedGc.retained[0]?.reason, 'corrupt_runtime_retained_for_manual_review');
    writeFileSync(artifactPath, original);
  }
  const evidenceBindingPath = join(completionRunDir, 'evidence-binding.json');
  const evidenceBindingContents = readFileSync(evidenceBindingPath, 'utf8');
  unlinkSync(evidenceBindingPath);
  const orphanSealDiagnostic = scanManagedHostRunRuntime(completionCase, {
    now: Date.parse(completed.run.terminal!.terminalAt) + 10,
    retentionMs: 1,
  });
  assert.equal(orphanSealDiagnostic.corrupt, 1, 'missing binding with an orphan immutable seal is doctor-visible corrupt runtime');
  const orphanSealGc = pruneExpiredManagedHostRuns(completionCase, {
    now: Date.parse(completed.run.terminal!.terminalAt) + 10,
    retentionMs: 1,
  });
  assert.deepEqual(orphanSealGc.removed, [], 'GC retains an orphan binding seal instead of deleting its audit runtime');
  assert.equal(orphanSealGc.retained[0]?.reason, 'corrupt_runtime_retained_for_manual_review');
  writeFileSync(evidenceBindingPath, evidenceBindingContents);
  const archivedReceiptPath = join(managedHostRunReceiptsRoot(completionCase), `${submitted.runId}.json`);
  mkdirSync(managedHostRunReceiptsRoot(completionCase), { recursive: true, mode: 0o700 });
  // B-137a:F-135 — receiptId-only matching must not GC the live runtime while
  // keeping a crash leftover / pre-F-127 archive that lacks proposal+seal.
  // Removing the completeness/upgrade check fails here: the planted archive
  // would survive, live would be deleted, and imported evidence would no
  // longer re-verify.
  writeFileSync(archivedReceiptPath, `${JSON.stringify({
    schemaVersion: 'lattice.managed_host_run_receipt_archive.v1',
    runId: submitted.runId,
    archivedAt: completed.run.terminal!.terminalAt,
    receipt,
    evidenceBindingDigest: null,
  })}\n`);
  assert.equal(existsSync(completionRunDir), true, 'live runtime is still present before incomplete-archive GC');
  const terminalGc = pruneExpiredManagedHostRuns(completionCase, {
    now: Date.parse(completed.run.terminal!.terminalAt) + 10,
    retentionMs: 1,
  });
  assert.deepEqual(terminalGc.failed, [], 'incomplete leftover with a matching receiptId must not fail closed when live artifacts can upgrade the archive');
  assert.deepEqual(terminalGc.removed, [submitted.runId]);
  assert.deepEqual(terminalGc.archivedReceipts, [submitted.runId]);
  assert.equal(existsSync(completionRunDir), false, 'live runtime is reclaimed only after the leftover archive is upgraded');
  assert.equal(scanManagedHostRunRuntime(completionCase).runs.length, 0);
  assert.equal(managedHostRunReceipt(completionCase, submitted.runId).receiptId, receipt.receiptId, 'minimal terminal receipt remains auditable after heavy runtime GC');
  const upgradedArchive = JSON.parse(readFileSync(archivedReceiptPath, 'utf8')) as {
    binding?: { runId?: string };
    evidenceProposalText?: string | null;
    evidenceBindingText?: string | null;
    evidenceBindingSealText?: string | null;
  };
  assert.equal(upgradedArchive.binding?.runId, submitted.runId, 'GC must upgrade a receiptId-matching leftover with the live binding projection');
  assert.equal(typeof upgradedArchive.evidenceProposalText, 'string', 'GC must upgrade a receiptId-matching leftover with the live proposal body');
  assert.equal(typeof upgradedArchive.evidenceBindingText, 'string', 'GC must upgrade a receiptId-matching leftover with the live evidence-binding body');
  assert.equal(typeof upgradedArchive.evidenceBindingSealText, 'string', 'GC must upgrade a receiptId-matching leftover with the live import seal');
  const upgradedProposal = readManagedReviewEvidenceProposal(completionCase, submitted.runId);
  assert.ok(upgradedProposal, 'upgraded archive must expose the provider-authored proposal');
  assert.equal(
    verifyBound({
      evidence: {
        kind: 'pass',
        pass: {
          id: 'B-managed:RP-001',
          agent: 'lattice-review-quality',
          note: upgradedProposal.note ?? '',
          createdAt: upgradedProposal.authoredAt,
          readManifest: upgradedProposal.readManifest,
          readLog: upgradedProposal.readLog,
          readDiagnostics: upgradedProposal.readDiagnostics,
        },
      },
    }).valid,
    true,
    'imported pass stays verifiable after GC upgrades a receiptId-matching incomplete archive',
  );
  // B-137a:F-127 regression. This block previously asserted only that the RECEIPT
  // stayed auditable after GC, never that already-imported evidence stayed
  // VERIFIABLE -- which is why the defect survived: readManagedHostRunBinding,
  // readManagedReviewEvidenceProposal and the import-seal read all hit the deleted
  // directory, so verification fell to the fail-closed refusal and the REVIEW gate
  // mapped it to managed_receipt_invalid (absent from SUPERSEDED_PASS_ISSUE_CODES,
  // so it hard-blocks REVIEW->TEST -- the F-100 deadlock mechanism). Assert the
  // three archive-backed reads directly; removing any archive capture fails here.
  assert.doesNotThrow(
    () => readManagedHostRunBinding(completionCase, submitted.runId),
    'the evidence binding must survive terminal-retention GC via the receipt archive',
  );
  assert.equal(
    readManagedHostRunBinding(completionCase, submitted.runId).runId,
    submitted.runId,
    'the archived binding must describe the same run',
  );
  assert.ok(
    readManagedReviewEvidenceProposal(completionCase, submitted.runId),
    'the provider-authored proposal must survive GC (semanticDigestValid/subjectMatches need it)',
  );
  assert.ok(
    readManagedReviewImportSeal(completionCase, submitted.runId),
    'the import-seal pair must survive GC (externalImportSealMatches returns false without it)',
  );
  assert.equal(existsSync(archivedReceiptPath), true);
  assert.match(readFileSync(archivedReceiptPath, 'utf8'), /"evidenceBindingDigest":"sha256:/, 'receipt archive preserves the exact imported evidence-binding reference digest');
  const archivedReceipt = readFileSync(archivedReceiptPath, 'utf8');
  const tamperedArchive = JSON.parse(archivedReceipt) as { receipt: { receiptId: string } };
  tamperedArchive.receipt.receiptId = 'sha256:tampered';
  writeFileSync(archivedReceiptPath, `${JSON.stringify(tamperedArchive)}\n`);
  assert.throws(() => managedHostRunReceipt(completionCase, submitted.runId), /archived terminal receipt is corrupt/,
    'post-GC receipt lookup must reject a tampered archive instead of trusting its embedded id');
  writeFileSync(archivedReceiptPath, archivedReceipt);

  // B-137a:F-132 — archived seal integrity is not implied by retaining the
  // text. The reader used to return a truthy pair after only digesting
  // bindingText, so a mutated evidenceBindingSealText was still admitted.
  const archivedProposal = readManagedReviewEvidenceProposal(completionCase, submitted.runId);
  assert.ok(archivedProposal, 'archived proposal is available for post-GC seal verification');
  const postGcPassEvidence = {
    kind: 'pass' as const,
    pass: {
      id: 'B-managed:RP-001',
      agent: 'lattice-review-quality',
      note: archivedProposal.note ?? '',
      createdAt: archivedProposal.authoredAt,
      readManifest: archivedProposal.readManifest,
      readLog: archivedProposal.readLog,
      readDiagnostics: archivedProposal.readDiagnostics,
    },
  };
  assert.equal(
    verifyBound({ evidence: postGcPassEvidence }).valid,
    true,
    'imported pass stays verifiable after GC when the archived seal is intact',
  );
  const archivedForSeal = JSON.parse(archivedReceipt) as {
    evidenceBindingSealText?: string | null;
  };
  const originalSealText = archivedForSeal.evidenceBindingSealText;
  assert.ok(originalSealText, 'receipt archive retained the import-seal body');
  const mutatedSeal = JSON.parse(originalSealText) as { bindingDigest?: string };
  mutatedSeal.bindingDigest = 'sha256:tampered-archived-seal';
  archivedForSeal.evidenceBindingSealText = `${JSON.stringify(mutatedSeal)}\n`;
  writeFileSync(archivedReceiptPath, `${JSON.stringify(archivedForSeal)}\n`);
  assert.throws(
    () => readManagedReviewImportSeal(completionCase, submitted.runId),
    /archived import seal schema, runId, or bindingDigest is invalid/,
    'post-GC import-seal read must reject a mutated archived seal',
  );
  assert.equal(
    verifyBound({ evidence: postGcPassEvidence }).valid,
    false,
    'gate-consumed evidence must refuse a mutated archived seal',
  );
  writeFileSync(archivedReceiptPath, archivedReceipt);
  const archivedForBinding = JSON.parse(archivedReceipt) as {
    binding?: { profile?: string | null; runId?: string };
    receipt: { receiptId: string; bindingProjectionDigest?: string };
  };
  assert.ok(archivedForBinding.binding, 'receipt archive retained the binding projection');
  assert.equal(typeof archivedForBinding.receipt.bindingProjectionDigest, 'string',
    'receipt payload must digest-bind the archived projection');
  archivedForBinding.binding = { ...archivedForBinding.binding, profile: 'forged-managed-reviewer' };
  writeFileSync(archivedReceiptPath, `${JSON.stringify(archivedForBinding)}\n`);
  assert.throws(
    () => readManagedHostRunBinding(completionCase, submitted.runId),
    /does not match receipt bindingProjectionDigest/,
    'post-GC binding read must reject a mutated archive.binding even when receiptId is untouched',
  );
  delete archivedForBinding.receipt.bindingProjectionDigest;
  writeFileSync(archivedReceiptPath, `${JSON.stringify(archivedForBinding)}\n`);
  assert.throws(
    () => readManagedHostRunBinding(completionCase, submitted.runId),
    /archived binding is not digest-bound/,
    'a binding-bearing archive must not skip verification by omitting bindingProjectionDigest',
  );
  writeFileSync(archivedReceiptPath, archivedReceipt);
  assert.ok(
    readManagedReviewImportSeal(completionCase, submitted.runId),
    'restored archive admits the import-seal pair again',
  );
  assert.equal(
    verifyBound({ evidence: postGcPassEvidence }).valid,
    true,
    'restored archive re-admits gate-consumed evidence',
  );

  const orphanedSnapshotParent = mkdtempSync(join(tmpdir(), 'lattice-xhr-review-'));
  const orphanedSnapshot = join(orphanedSnapshotParent, 'worktree');
  const orphanedSnapshotGitRoot = join(root, 'orphaned-cross-host-git-root');
  mkdirSync(orphanedSnapshotGitRoot, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: orphanedSnapshotGitRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'managed-smoke@example.invalid'], { cwd: orphanedSnapshotGitRoot });
  execFileSync('git', ['config', 'user.name', 'managed-smoke'], { cwd: orphanedSnapshotGitRoot });
  writeFileSync(join(orphanedSnapshotGitRoot, 'README.md'), 'cross-host retention fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: orphanedSnapshotGitRoot });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: orphanedSnapshotGitRoot, stdio: 'ignore' });
  execFileSync('git', ['worktree', 'add', '--detach', orphanedSnapshot, 'HEAD'], {
    cwd: orphanedSnapshotGitRoot,
    stdio: 'ignore',
  });
  const orphanedSnapshotRoot = orphanedSnapshotGitRoot;
  const orphanedSnapshotLauncher: ManagedHostRunWorkerLauncher = async request => {
    void runManagedHostRunWorker(request, {
      runner: async () => ({ ...successfulResult(), finalAssistantResult: null, finalAssistantResultCount: 0 }),
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
      cancelPollMs: 5,
    });
    return { pid: process.pid };
  };
  const orphanedSnapshotSubmission = await submitManagedHostRun({
    ...submitArgs(orphanedSnapshotRoot, 'cross-host snapshot abandoned by detached caller'),
    cwd: orphanedSnapshot,
    profile: 'cross_host_review_codex',
    reviewBinding: undefined,
  }, {
    launchWorker: orphanedSnapshotLauncher,
    claimTimeoutMs: 500,
    claimPollMs: 5,
  });
  await eventually(async () => (await getManagedHostRunStatus({
    root: orphanedSnapshotRoot,
    runId: orphanedSnapshotSubmission.runId,
  })).run.state === 'completed', 'orphaned cross-host snapshot run did not complete');
  const orphanedTerminal = (await getManagedHostRunStatus({
    root: orphanedSnapshotRoot,
    runId: orphanedSnapshotSubmission.runId,
  })).run.terminal!;
  const orphanedGc = pruneExpiredManagedHostRuns(orphanedSnapshotRoot, {
    now: Date.parse(orphanedTerminal.terminalAt) + 10,
    retentionMs: 1,
  });
  assert.deepEqual(orphanedGc.removed, [orphanedSnapshotSubmission.runId]);
  assert.equal(existsSync(orphanedSnapshotParent), false,
    'bounded retention GC removes the canonical detached cross-host snapshot even when no caller resumes');
  assert.doesNotThrow(
    () => cleanupManagedCrossHostReviewWorktree(orphanedSnapshotGitRoot, orphanedSnapshot),
    'cross-host snapshot cleanup is idempotent after a prior successful handler or GC cleanup',
  );

  // Canonical validation schedules these contracts independently. The default
  // standalone command retains its historical pinned combined proof.
  if (!process.argv.includes('--canonical-core')) {
    const realCallerBoundary = execFileSync(process.execPath, [fileURLToPath(new URL('./managed-host-run-e2e-smoke.js', import.meta.url))], { encoding: 'utf8' });
    assert.match(realCallerBoundary, /managed-host-run-e2e-smoke PASS/, 'lifecycle smoke must execute the real caller-death and worker-crash boundary');

    // F083: CHK-001:edge:0 is immutably pinned to this command. Execute the
    // real-provider process suite here so the pin itself proves that a live,
    // output-silent provider remains running across the production-injected
    // legacy ten-minute observation boundary and repeated next touches.
    const silenceBoundary = execFileSync(
      process.execPath,
      [fileURLToPath(new URL('./managed-host-run-process-smoke.js', import.meta.url))],
      { encoding: 'utf8' },
    );
    assert.match(
      silenceBoundary,
      /managed-host-run-process-smoke PASS/,
      'pinned managed-host-run smoke executes the real silent-provider observation boundary',
    );
    console.log('managed-host-run silence-boundary extension PASS');
  }

  console.log(process.argv.includes('--canonical-core') ? 'managed-host-run-core PASS' : 'managed-host-run-smoke PASS');
}

if (process.argv[2] === '--granted-no-identity-worker') {
  runManagedHostRunWorker(
    { root: process.argv[3] ?? '', runId: process.argv[4] ?? '' },
    { runner: () => new Promise(() => {}), env: { PROOF_OR_STOP_USAGE_LEDGER: '0' } },
  ).catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
} else if (process.argv[2] === '--timer-error-worker') {
  runManagedHostRunWorker(
    { root: process.argv[3] ?? '', runId: process.argv[4] ?? '' },
    {
      cancelPollMs: 5,
      runner: plan => new Promise(resolveRun => {
        const hold = setInterval(() => {}, 1_000);
        const finish = () => {
          clearInterval(hold);
          resolveRun({
            stdout: '', stderr: '', exitCode: 130, timedOut: false, terminalReason: 'aborted',
            replacementSafe: true, residualProcessGroup: false,
          });
        };
        if (plan.signal?.aborted) finish();
        else plan.signal?.addEventListener('abort', finish, { once: true });
      }),
    },
  ).catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
} else if (process.argv[2] === '--fifo-worker') {
  runManagedHostRunWorker(
    { root: process.argv[3] ?? '', runId: process.argv[4] ?? '' },
    { runner: async () => {
      writeFileSync(process.argv[5] ?? '', 'called');
      return successfulResult();
    } },
  ).catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
} else if (process.argv[2] === '--post-claim-intake-worker') {
  runManagedHostRunWorker(
    { root: process.argv[3] ?? '', runId: process.argv[4] ?? '' },
    { runner: async () => successfulResult() },
  ).catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
} else if (process.argv[2] === '--fifo-writer') {
  const fd = openSync(process.argv[3] ?? '', 'w');
  writeFileSync(process.argv[5] ?? '', 'ready');
  eventually(async () => existsSync(process.argv[4] ?? ''), 'FIFO writer was never released')
    .then(() => {
      writeSync(fd, process.argv[6] ?? '');
      closeSync(fd);
    })
    .catch(error => {
      closeSync(fd);
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
} else if (process.argv[2] === '--terminal-lock-holder') {
  const caseRoot = process.argv[3] ?? '';
  const runId = process.argv[4] ?? '';
  const readyPath = process.argv[5] ?? '';
  const releasedPath = process.argv[6] ?? '';
  const holdMs = Number(process.argv[7] ?? '0');
  const lock = acquireMkdirLock(join(caseRoot, PROOF_OR_STOP_DIR, 'runtime/host-runs', runId, 'terminal.lock'), {
    label: 'managed terminal smoke live holder',
    requireHolderToken: true,
    holderInfo: {
      pid: process.pid,
      hostname: hostname(),
      command: 'managed terminal smoke live holder',
      acquiredAt: new Date().toISOString(),
      lockId: randomUUID(),
      processStartTimeMs: Math.floor(Date.now() - process.uptime() * 1_000),
    },
  });
  writeFileSync(readyPath, new Date().toISOString());
  setTimeout(() => {
    writeFileSync(releasedPath, new Date().toISOString());
    lock.release();
  }, holdMs);
} else main()
  .catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
