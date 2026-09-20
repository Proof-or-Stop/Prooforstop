#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createManagedReviewEvidenceBinding,
  verifyManagedReviewEvidence,
} from '../core/managed-review-evidence.js';
import {
  cancelManagedHostRun,
  getManagedHostRunStatus,
  recoverManagedHostRun,
  managedHostRunDirectory,
  managedHostRunReceipt,
  runManagedHostRunWorker,
  submitManagedHostRun,
  writeManagedReviewEvidenceProposal,
  type ManagedHostRunWorkerLauncher,
} from '../core/managed-host-run.js';
import type { HostRunRunner } from '../core/host-run.js';
import { StoryStore } from '../core/store.js';
import { PROOF_OR_STOP_DIR } from '../core/proof-or-stop-paths.js';
import { createHostRunHandlers } from '../handlers/host-run.js';

const SELF = fileURLToPath(import.meta.url);
// The crash probe advances the status reconciler with its injected clock. Keep
// the worker's independent production deadline timer well outside that short
// assertion sequence so wall-clock scheduling cannot preempt the -1ms probe.
const CRASH_PROBE_REAL_DEADLINE_MS = 60_000;

function submitArgs(root: string, deadlineMs: number, host: 'codex' | 'claude' = 'codex') {
  return {
    root,
    cwd: root,
    host,
    storyId: 'B-managed-e2e',
    phase: 'REVIEW',
    agentType: 'lattice-review-quality',
    reviewRunId: 'B-managed-e2e:RR-001',
    lane: 'lattice-review-quality',
    promptText: 'detached real worker review prompt',
    deadlineMs,
    projectRootHash: 'sha256:managed-e2e-root',
    profile: 'managed_reviewer' as const,
    reviewBinding: {
      managedPromptDigest: `sha256:${createHash('sha256').update('detached real worker review prompt').digest('hex')}`,
      headHash: 'head-managed-e2e',
      materialHash: 'material-managed-e2e',
      storyFilesHash: 'story-managed-e2e',
      promptHash: 'prompt-managed-e2e',
      envelopeId: null,
    },
  };
}

async function eventually(predicate: () => Promise<boolean>, message: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(message);
}

async function workerMain(
  root: string,
  runId: string,
  crash: boolean,
  delayMs = 120,
  writeProposal = true,
  spawnMarkerPath?: string,
  crashReleasePath?: string,
  crashPromptMarkerPath?: string,
): Promise<void> {
  const runner: HostRunRunner = async plan => {
    if (spawnMarkerPath) writeFileSync(spawnMarkerPath, `${runId}\n`, { flag: 'wx', mode: 0o600 });
    if (crash) {
      if (crashPromptMarkerPath) {
        if (!plan.promptFile) throw new Error('crash prompt probe expected a managed Claude prompt file');
        writeFileSync(crashPromptMarkerPath, `${plan.promptFile}\n`, { flag: 'wx', mode: 0o600 });
      }
      if (crashReleasePath) {
        const releaseDeadline = Date.now() + 10_000;
        while (!existsSync(crashReleasePath) && Date.now() < releaseDeadline) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        if (!existsSync(crashReleasePath)) throw new Error('crash worker release gate timed out');
      }
      process.exit(23);
    }
    plan.onChunk?.({ stream: 'stdout', text: '{"type":"turn.started"}\n' });
    await new Promise(resolve => setTimeout(resolve, delayMs));
    if (writeProposal) {
      writeManagedReviewEvidenceProposal({
        root,
        runId,
        environment: plan.env,
        proposal: {
          storyId: 'B-managed-e2e',
          providerAgent: 'lattice-review-quality',
          lane: 'lattice-review-quality',
          reviewRunId: 'B-managed-e2e:RR-001',
          conclusion: 'pass',
          note: 'Detached provider worker completed the exact bound review once.',
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
        },
      });
    }
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
  };
  await runManagedHostRunWorker({ root, runId }, {
    runner,
    env: { ...process.env, PROOF_OR_STOP_USAGE_LEDGER: '0' },
    heartbeatMs: 25,
    cancelPollMs: 10,
  });
}

async function foregroundCallerMain(root: string, resultPath: string, spawnMarkerPath: string): Promise<void> {
  const launcher: ManagedHostRunWorkerLauncher = async request => {
    writeFileSync(resultPath, `${JSON.stringify({ runId: request.runId })}\n`, { mode: 0o600 });
    const child = spawn(process.execPath, [
      SELF,
      '--worker',
      request.root,
      request.runId,
      '--complete',
      '--delay=600',
      '--raw',
      `--spawn-marker=${spawnMarkerPath}`,
    ], {
      cwd: request.root,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { pid: child.pid ?? 0 };
  };
  const ctx = { root, scanRoot: root, store: new StoryStore(root) };
  await createHostRunHandlers(ctx, { launchWorker: launcher }).host_run({
    host: 'codex',
    agentType: 'lattice-review-quality',
    phase: 'REVIEW',
    prompt: 'foreground caller death must not own the provider worker',
    deadlineMs: 3_000,
    json: true,
  });
}

async function submitterMain(root: string, resultPath: string): Promise<void> {
  const launcher: ManagedHostRunWorkerLauncher = async request => {
    const child = spawn(process.execPath, [SELF, '--worker', request.root, request.runId, '--complete', '--delay=600'], {
      cwd: request.root,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { pid: child.pid ?? 0 };
  };
  const submitted = await submitManagedHostRun(submitArgs(root, 3_000), {
    launchWorker: launcher,
    claimTimeoutMs: 1_000,
    claimPollMs: 10,
  });
  writeFileSync(resultPath, `${JSON.stringify({ runId: submitted.runId, state: submitted.state })}\n`, { mode: 0o600 });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'managed-host-run-e2e-smoke-'));
  try {
    let launches = 0;
    const launcher = (
      crash: boolean,
      crashReleasePath?: string,
      crashPromptMarkerPath?: string,
    ): ManagedHostRunWorkerLauncher => async request => {
      launches += 1;
      const child = spawn(process.execPath, [
        SELF,
        '--worker',
        request.root,
        request.runId,
        crash ? '--crash' : '--complete',
        ...(crashReleasePath ? [`--crash-release=${crashReleasePath}`] : []),
        ...(crashPromptMarkerPath ? [`--crash-prompt-marker=${crashPromptMarkerPath}`] : []),
      ], {
        cwd: request.root,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { pid: child.pid ?? 0 };
    };

    const callerDeathRoot = join(root, 'caller-death');
    const callerResultPath = join(root, 'caller-death-submission.json');
    const caller = spawn(process.execPath, [SELF, '--submitter', callerDeathRoot, callerResultPath], {
      cwd: root,
      stdio: 'ignore',
    });
    assert.equal(await waitForExit(caller), 0, 'independent submitter must exit cleanly after detached claim');
    const callerSubmission = JSON.parse(readFileSync(callerResultPath, 'utf8')) as { runId: string; state: string };
    assert.equal(callerSubmission.state, 'running', 'caller must disappear while the durable run remains active');
    const afterCallerExit = await getManagedHostRunStatus({ root: callerDeathRoot, runId: callerSubmission.runId, waitMs: 30 });
    assert.equal(afterCallerExit.run.runId, callerSubmission.runId);
    assert.ok(['running', 'completed'].includes(afterCallerExit.run.state), 'caller loss must not synthesize failure or a replacement run');
    await eventually(async () => {
      const status = await getManagedHostRunStatus({ root: callerDeathRoot, runId: callerSubmission.runId, waitMs: 30 });
      return status.run.state === 'completed';
    }, 'provider run did not survive the submitting caller process', 4_000);
    assert.equal(managedHostRunReceipt(callerDeathRoot, callerSubmission.runId).state, 'completed');

    const foregroundRoot = join(root, 'foreground-caller-death');
    const foregroundResultPath = join(root, 'foreground-caller-death-submission.json');
    const foregroundSpawnMarker = join(root, 'foreground-caller-death.spawn');
    const foregroundCaller = spawn(process.execPath, [
      SELF,
      '--foreground-caller',
      foregroundRoot,
      foregroundResultPath,
      foregroundSpawnMarker,
    ], { cwd: root, stdio: 'ignore' });
    await eventually(async () => {
      try {
        return JSON.parse(readFileSync(foregroundResultPath, 'utf8')).runId.length > 0;
      } catch {
        return false;
      }
    }, 'foreground caller did not publish the durable run identity');
    const foregroundSubmission = JSON.parse(readFileSync(foregroundResultPath, 'utf8')) as { runId: string };
    await eventually(async () => {
      const status = await getManagedHostRunStatus({ root: foregroundRoot, runId: foregroundSubmission.runId });
      return status.run.state === 'running';
    }, 'foreground caller did not observe a claimed provider worker');
    foregroundCaller.kill('SIGTERM');
    assert.notEqual(await waitForExit(foregroundCaller), 0, 'the attaching caller is deliberately terminated');
    await eventually(async () => {
      const status = await getManagedHostRunStatus({ root: foregroundRoot, runId: foregroundSubmission.runId, waitMs: 30 });
      return status.run.state === 'completed';
    }, 'foreground caller death must not terminate or replace the durable provider worker', 4_000);
    assert.equal(readFileSync(foregroundSpawnMarker, 'utf8').trim(), foregroundSubmission.runId,
      'foreground attach loss preserves exactly one provider spawn for the exact runId');
    assert.equal(managedHostRunReceipt(foregroundRoot, foregroundSubmission.runId).state, 'completed');

    const completedRoot = join(root, 'completed');
    const submitted = await submitManagedHostRun(submitArgs(completedRoot, 2_000), {
      launchWorker: launcher(false),
      claimTimeoutMs: 1_000,
      claimPollMs: 10,
    });
    assert.equal(submitted.state, 'running', 'submit returns only after the detached worker claims the run');
    assert.equal(launches, 1);

    // A fresh observer owns no child handle: the durable run directory is the only
    // join point after the submitting caller boundary has gone away.
    await eventually(async () => {
      const status = await getManagedHostRunStatus({ root: completedRoot, runId: submitted.runId, waitMs: 30 });
      return status.run.state === 'completed';
    }, 'detached OS worker did not publish terminal truth');
    assert.equal(launches, 1, 'status polling must never launch a replacement provider');
    const receipt = managedHostRunReceipt(completedRoot, submitted.runId);
    const expected = {
      providerHost: 'codex' as const,
      headHash: 'head-managed-e2e',
      materialHash: 'material-managed-e2e',
      storyFilesHash: 'story-managed-e2e',
      promptHash: 'prompt-managed-e2e',
      envelopeId: null,
      managedPromptDigest: `sha256:${createHash('sha256').update('detached real worker review prompt').digest('hex')}`,
    };
    const binding = createManagedReviewEvidenceBinding({
      root: completedRoot,
      storyId: 'B-managed-e2e',
      providerAgent: 'lattice-review-quality',
      lane: 'lattice-review-quality',
      reviewRunId: 'B-managed-e2e:RR-001',
      runId: submitted.runId,
      receiptId: receipt.receiptId,
      expected,
    });
    assert.equal(verifyManagedReviewEvidence({
      root: completedRoot,
      storyId: 'B-managed-e2e',
      agent: 'lattice-review-quality',
      lane: 'lattice-review-quality',
      reviewRunId: 'B-managed-e2e:RR-001',
      binding: binding.binding,
      expected,
    }).valid, true, 'the exact detached-worker receipt must be admissible to the formal reviewer consumer');
    assert.equal(verifyManagedReviewEvidence({
      root: completedRoot,
      storyId: 'B-managed-e2e',
      agent: binding.binding.providerAgent,
      lane: binding.binding.lane,
      reviewRunId: 'B-managed-e2e:RR-001',
      binding: binding.binding,
      expected: { ...expected, managedPromptDigest: `sha256:${'0'.repeat(64)}` },
    }).valid, true, 'caller-provided prompt expectations must not replace sealed launch authority');
    assert.equal(verifyManagedReviewEvidence({
      root: completedRoot,
      storyId: 'B-managed-e2e',
      agent: binding.binding.providerAgent, lane: binding.binding.lane, reviewRunId: 'B-managed-e2e:RR-001',
      binding: { ...binding.binding, managedPromptDigest: `sha256:${'0'.repeat(64)}` }, expected,
    }).valid, false, 'a changed signed prompt binding must not reuse the detached-worker receipt');
    assert.equal(verifyManagedReviewEvidence({
      root: completedRoot,
      storyId: 'B-managed-e2e',
      agent: 'proof-or-stop-review-quality', lane: binding.binding.lane, reviewRunId: 'B-managed-e2e:RR-001',
      binding: binding.binding, expected,
    }).valid, false, 'a different caller role must not reuse the exact signed provider binding');

    const crashedRoot = join(root, 'crashed');
    const crashReleasePath = join(root, 'crash-worker.release');
    const crashPromptMarkerPath = join(root, 'crash-worker-prompt-path');
    const crashed = await submitManagedHostRun(submitArgs(crashedRoot, CRASH_PROBE_REAL_DEADLINE_MS, 'claude'), {
      launchWorker: launcher(true, crashReleasePath, crashPromptMarkerPath),
      claimTimeoutMs: 10_000,
      claimPollMs: 10,
    });
    assert.equal(crashed.state, 'running',
      'the crash probe must establish a durable worker claim before releasing the worker death');
    await eventually(() => Promise.resolve(existsSync(crashPromptMarkerPath)),
      'crash worker did not materialize its managed Claude prompt before the simulated abnormal exit');
    const crashedPromptFile = readFileSync(crashPromptMarkerPath, 'utf8').trim();
    const expectedCrashedPromptFile = join(
      crashedRoot,
      // B-137a main-merge fix: assert the CANONICAL state dir the producer
      // (core/host-run.ts) actually writes after the brand rename. Reading the
      // same constant the producer uses keeps this expectation from drifting
      // away from the implementation again.
      PROOF_OR_STOP_DIR,
      'runtime',
      'host-run-prompts',
      crashed.runId,
      'prompt.txt',
    );
    assert.equal(crashedPromptFile, expectedCrashedPromptFile,
      'managed Claude prompt custody is bound to the exact durable run id, not an opaque tmp leaf');
    assert.equal(existsSync(crashedPromptFile), true,
      'the synthetic worker crash starts with the external plaintext prompt present');
    assert.equal(readFileSync(crashedPromptFile, 'utf8'), 'detached real worker review prompt');
    writeFileSync(crashReleasePath, 'release\n', { flag: 'wx', mode: 0o600 });
    const crashedDeadlineAt = Date.parse(crashed.deadlineAt);
    assert.ok(Number.isFinite(crashedDeadlineAt), 'crashed worker exposes a parseable absolute deadline');
    assert.ok(crashedDeadlineAt - Date.now() > 10_000,
      'the synthetic status deadline probe must remain outside the worker deadline timer window');
    const beforeCrashDeadline = await recoverManagedHostRun({
      root: crashedRoot,
      runId: crashed.runId,
      waitMs: 0,
      now: () => crashedDeadlineAt - 1,
    });
    assert.equal(beforeCrashDeadline.run.runId, crashed.runId);
    assert.equal(beforeCrashDeadline.run.state, 'running', 'post-claim worker death before deadline preserves the original run identity instead of replacing it');
    const deadlineGrace = await recoverManagedHostRun({
      root: crashedRoot,
      runId: crashed.runId,
      waitMs: 0,
      now: () => crashedDeadlineAt,
    });
    assert.equal(deadlineGrace.run.state, 'running', 'the exact deadline begins the production cooperative cleanup grace');
    await eventually(async () => (await recoverManagedHostRun({
      root: crashedRoot,
      runId: crashed.runId,
      waitMs: 0,
      now: () => crashedDeadlineAt + 300,
    })).run.state === 'timed_out', 'a crashed worker converges after stopping at the finite deadline cleanup grace');
    const reconciled = await getManagedHostRunStatus({ root: crashedRoot, runId: crashed.runId, waitMs: 0 });
    assert.ok(reconciled.run.terminal, 'crashed worker reconciliation must publish definite terminal truth');
    assert.equal(reconciled.run.terminal.reason, 'absolute_deadline_exceeded');
    assert.equal(existsSync(crashedPromptFile), false,
      'next-touch reconciliation removes the crashed worker\'s exact external managed Claude prompt leaf');

    const raceRoot = join(root, 'status-cancel-deadline-race');
    const raced = await submitManagedHostRun(submitArgs(raceRoot, 150), {
      launchWorker: launcher(false),
      claimTimeoutMs: 1_000,
      claimPollMs: 10,
    });
    await new Promise(resolve => setTimeout(resolve, 95));
    const racingTouches = await Promise.all([
      getManagedHostRunStatus({ root: raceRoot, runId: raced.runId, afterGeneration: raced.generation, waitMs: 300 }),
      cancelManagedHostRun({ root: raceRoot, runId: raced.runId, reason: 'status/attach/cancel deadline race' }),
      getManagedHostRunStatus({ root: raceRoot, runId: raced.runId, waitMs: 300 }),
    ]);
    await eventually(async () => (await getManagedHostRunStatus({ root: raceRoot, runId: raced.runId })).run.terminal !== null,
      'status/cancel/deadline race did not converge on terminal truth');
    const raceReceipt = managedHostRunReceipt(raceRoot, raced.runId);
    const raceTerminalPath = join(managedHostRunDirectory(raceRoot, raced.runId), 'terminal.json');
    const immutableTerminal = readFileSync(raceTerminalPath);
    const converged = await Promise.all([
      getManagedHostRunStatus({ root: raceRoot, runId: raced.runId }),
      getManagedHostRunStatus({ root: raceRoot, runId: raced.runId, waitMs: 300 }),
      cancelManagedHostRun({ root: raceRoot, runId: raced.runId, reason: 'late losing cancel' }),
    ]);
    for (const value of [...racingTouches, ...converged]) {
      const projection = 'run' in value ? value.run : value;
      if (projection.terminal) {
        assert.equal(managedHostRunReceipt(raceRoot, raced.runId).receiptId, raceReceipt.receiptId,
          'all terminal observers converge on the exact immutable receipt digest');
      }
    }
    assert.deepEqual(readFileSync(raceTerminalPath), immutableTerminal, 'late status/cancel/reconcile touches cannot rewrite terminal bytes');

    console.log('managed-host-run-e2e-smoke PASS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') {
  const delayArg = process.argv.find(value => value.startsWith('--delay='));
  const markerArg = process.argv.find(value => value.startsWith('--spawn-marker='));
  const crashReleaseArg = process.argv.find(value => value.startsWith('--crash-release='));
  const crashPromptMarkerArg = process.argv.find(value => value.startsWith('--crash-prompt-marker='));
  workerMain(
    process.argv[3] ?? '',
    process.argv[4] ?? '',
    process.argv[5] === '--crash',
    delayArg ? Number(delayArg.slice('--delay='.length)) : 120,
    !process.argv.includes('--raw'),
    markerArg ? markerArg.slice('--spawn-marker='.length) : undefined,
    crashReleaseArg ? crashReleaseArg.slice('--crash-release='.length) : undefined,
    crashPromptMarkerArg ? crashPromptMarkerArg.slice('--crash-prompt-marker='.length) : undefined,
  )
    .catch(error => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
} else if (process.argv[2] === '--submitter') {
  submitterMain(process.argv[3] ?? '', process.argv[4] ?? '')
    .catch(error => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
} else if (process.argv[2] === '--foreground-caller') {
  foregroundCallerMain(process.argv[3] ?? '', process.argv[4] ?? '', process.argv[5] ?? '')
    .catch(error => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
} else {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
