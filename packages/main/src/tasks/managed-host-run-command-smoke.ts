#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, openSync, readFileSync, statSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  boundedManagedHostRunStatusWaitMs,
  cancelManagedHostRun,
  getManagedHostRunStatus,
  recoverManagedHostRun,
  runManagedHostRunSupervisor,
  inspectManagedHostRunFiles,
  MANAGED_HOST_RUN_OUTPUT_RETENTION_MAX_BYTES,
  managedHostRunDirectory,
  managedHostRunReceipt,
  managedHostRunReceiptsRoot,
  pruneExpiredManagedHostRuns,
  readManagedHostRunResult,
  runManagedHostRunWorker,
  submitManagedHostRun,
} from '../core/managed-host-run.js';
import { StoryStore } from '../core/store.js';
import type { HostRunRunner } from '../core/host-run.js';
import type { StoryInfo } from '../core/types.js';
import { createHostRunHandlers, type HostRunDetachResult } from '../handlers/host-run.js';

const root = mkdtempSync(join(tmpdir(), 'managed-host-run-command-smoke-'));
const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

async function eventually(predicate: () => Promise<boolean>, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      // A read-only status projection refuses the writer's publication window.
      // Let the existing supervisor finish it within this same fixed deadline.
      if (!(error instanceof Error)
        || !/^managed host run [A-Za-z0-9_-]+: snapshot\/event recovery pending; supervisor recovery required$/u.test(error.message)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function main(): Promise<void> {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let spawns = 0;
  const observedPlans: Array<Parameters<HostRunRunner>[0]> = [];
  const runner: HostRunRunner = async plan => {
    spawns += 1;
    observedPlans.push(plan);
    if (plan.env.LATTICE_MANAGED_HOST_RUN_ID?.includes('foreground')) {
      return { stdout: '{"type":"turn.completed","usage":{}}\n', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
    }
    await gate;
    return {
      stdout: '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":1,"output_tokens":2}}\n',
      stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed',
    };
  };
  const ctx = { root, scanRoot: join(root, 'packages/main'), store: new StoryStore(root) };
  const firstCaller = createHostRunHandlers(ctx, { runner });
  const invalidSubmitBase = {
    host: 'codex',
    agentType: 'runtime-validation-smoke',
    phase: 'DEV',
    prompt: 'invalid numeric input must refuse before spawn',
    detach: true,
    json: true,
  };
  for (const field of ['timeoutMs', 'deadlineMs'] as const) {
    for (const invalid of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        firstCaller.host_run({ ...invalidSubmitBase, [field]: invalid }),
        new RegExp(`host_run: --${field} must be a finite positive integer`),
        `${field}=${invalid} must be rejected by the production handler before submit`,
      );
    }
  }
  assert.equal(spawns, 0, 'runtime-invalid submit arguments never reach the provider runner');
  const detached = await firstCaller.host_run({
    host: 'codex',
    agentType: 'lattice-review-quality',
    phase: 'REVIEW',
    prompt: 'secret command smoke prompt',
    detach: true,
    timeoutMs: 777,
    deadlineMs: 2_000,
    json: true,
  }) as HostRunDetachResult;
  assert.equal(detached.detached, true);
  assert.equal(detached.run.state, 'running', 'detach returns after the worker claim handshake');
  assert.match(detached.run.deadlineAt, /^\d{4}-\d\d-\d\dT/, 'detach exposes the finite absolute deadline');
  assert.equal(spawns, 1);
  assert.equal(JSON.stringify(detached).includes('secret command smoke prompt'), false);
  const files = inspectManagedHostRunFiles(root, detached.run.runId);
  assert.equal(files.mode, 0o700);
  assert.equal(files.hasCapability, false, 'claim consumes the one-shot capability');
  assert.equal(files.hasPrompt, false, 'claim consumes the one-shot prompt');
  const observedPlan = observedPlans[0];
  assert.ok(observedPlan, 'managed worker must reach the provider runner after claim');
  assert.equal(observedPlan.argv[0], 'exec');
  assert.ok(observedPlan.argv.includes('--json'), 'managed Codex keeps observable JSONL progress enabled');
  assert.equal(observedPlan.argv.at(-1), '-', 'managed Codex must use the documented stdin sentinel');
  assert.equal(observedPlan.stdinText, 'secret command smoke prompt', 'prompt must be delivered through stdin, not argv');
  assert.equal(observedPlan.argv.includes('secret command smoke prompt'), false, 'prompt plaintext must never enter argv');
  assert.equal(observedPlan.timeoutMs, 777, 'the configured provider timeout reaches the actual Codex runner');

  for (const field of ['afterGeneration', 'afterSequence'] as const) {
    for (const invalid of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        firstCaller.host_run_status({ runId: detached.run.runId, [field]: invalid, json: true }),
        new RegExp(`host_run_status: --${field} must be a finite nonnegative integer`),
      );
    }
  }
  for (const invalid of [-1, 1.5, Number.POSITIVE_INFINITY, 30_001]) {
    await assert.rejects(
      firstCaller.host_run_status({ runId: detached.run.runId, waitMs: invalid, json: true }),
      /host_run_status: --waitMs must be a finite nonnegative integer <= 30000/,
    );
  }

  await assert.rejects(
    firstCaller.host_run({
      host: 'agy',
      agentType: 'lattice-review-quality',
      phase: 'REVIEW',
      prompt: 'agy secret must not enter argv',
      detach: true,
      deadlineMs: 2_000,
      json: true,
    }),
    /unsupported host.*expected codex \| claude/i,
    'the retired argv-only agy execution path must be rejected before a durable run is submitted',
  );
  assert.equal(spawns, 1, 'retired agy execution must refuse before the injected provider runner/spawn');

  const secondCaller = createHostRunHandlers(ctx, { runner });
  // Claim and provider-identity publication are distinct monotonic generations.
  // Observe after the worker has published its provider identity, then prove a
  // truly unchanged long-poll interval does not manufacture failure.
  await new Promise(resolve => setTimeout(resolve, 100));
  const baseline = await secondCaller.host_run_status({
    runId: detached.run.runId,
    json: true,
  }) as { run: { generation: number } };
  const immediateStartedAt = Date.now();
  const immediate = await secondCaller.host_run_status({
    runId: detached.run.runId,
    afterGeneration: baseline.run.generation,
    waitMs: 0,
    json: true,
  }) as { changed: boolean; run: { state: string; runId: string } };
  assert.equal(immediate.changed, false, 'exact waitMs=0 returns the current unchanged snapshot');
  assert.equal(immediate.run.state, 'running');
  assert.equal(immediate.run.runId, detached.run.runId);
  assert.ok(Date.now() - immediateStartedAt < 1_000, 'waitMs=0 is non-blocking');
  const unchanged = await secondCaller.host_run_status({
    runId: detached.run.runId,
    afterGeneration: baseline.run.generation,
    waitMs: 20,
    json: true,
  }) as { changed: boolean; run: { state: string; runId: string } };
  // A concurrent worker heartbeat/identity publication may legitimately advance
  // the generation during this window. Either way, the bounded observation must
  // return the same non-terminal run rather than synthesize provider failure.
  assert.equal(typeof unchanged.changed, 'boolean');
  assert.equal(unchanged.run.state, 'running');
  assert.equal(unchanged.run.runId, detached.run.runId);
  const exactCapWithoutDelay = await secondCaller.host_run_status({
    runId: detached.run.runId,
    afterGeneration: 0,
    waitMs: 30_000,
    json: true,
  }) as { changed: boolean };
  assert.equal(exactCapWithoutDelay.changed, true, 'the exact 30s cap may return immediately on a newer generation');
  assert.equal(boundedManagedHostRunStatusWaitMs(99_999), 30_000, 'status long-poll wait is mechanically capped at 30 seconds');
  assert.equal(boundedManagedHostRunStatusWaitMs(30_000), 30_000, 'the exact public waitMs=30000 boundary is accepted unchanged');
  const cappedCaller = createHostRunHandlers(ctx, { runner, statusWaitCapMs: 80 });
  const cappedBaseline = await cappedCaller.host_run_status({ runId: detached.run.runId, json: true }) as { run: { generation: number; state: string } };
  const cappedStartedAt = Date.now();
  const exactBoundaryNoChange = await cappedCaller.host_run_status({
    runId: detached.run.runId,
    afterGeneration: cappedBaseline.run.generation,
    waitMs: 30_000,
    json: true,
  }) as { changed: boolean; run: { generation: number; state: string; runId: string } };
  const cappedElapsed = Date.now() - cappedStartedAt;
  assert.equal(exactBoundaryNoChange.changed, false, 'exact waitMs=30000 returns unchanged non-terminal state instead of provider failure');
  assert.equal(exactBoundaryNoChange.run.state, 'running');
  assert.equal(exactBoundaryNoChange.run.runId, detached.run.runId);
  assert.ok(cappedElapsed >= 60 && cappedElapsed < 1_000, `test seam proves exact 30s handler wiring without sleeping 30s (elapsed=${cappedElapsed})`);
  await assert.rejects(
    cappedCaller.host_run_status({
      runId: detached.run.runId,
      afterGeneration: exactBoundaryNoChange.run.generation,
      waitMs: 99_999,
      json: true,
    }),
    /host_run_status: --waitMs must be a finite nonnegative integer <= 30000/,
    'the direct handler mirrors the public schema maximum instead of silently clamping an invalid call',
  );
  const text = await secondCaller.host_run_status({ runId: detached.run.runId }) as string;
  assert.match(text, /workerHeartbeatAt=/);
  assert.match(text, /providerProgressMode=/);
  assert.match(text, /lastProviderProgressAt=/);

  await assert.rejects(secondCaller.host_run_status({ runId: '../outside' }), /invalid runId/);
  await assert.rejects(secondCaller.host_run_cancel({ runId: '..' }), /invalid runId/);
  await assert.rejects(secondCaller.host_run_status({ runId: 'unknown-valid-run-id' }), /not found/);
  await assert.rejects(secondCaller.host_run_cancel({ runId: 'unknown-valid-run-id' }), /not found/);
  assert.equal(spawns, 1, 'malformed/path-traversal runIds must not spawn a provider');

  const cancelOne = await secondCaller.host_run_cancel({ runId: detached.run.runId, reason: 'operator command smoke', json: true }) as { run: { cancelRequestedAt: string | null } };
  const cancelTwo = await secondCaller.host_run_cancel({ runId: detached.run.runId, reason: 'different ignored retry reason', json: true }) as { run: { cancelRequestedAt: string | null } };
  assert.equal(cancelOne.run.cancelRequestedAt, cancelTwo.run.cancelRequestedAt, 'cancel is idempotent');
  release();
  await eventually(async () => {
    const status = await getManagedHostRunStatus({ root, runId: detached.run.runId });
    return status.run.terminal !== null;
  }, 'cancelled command run did not publish terminal truth');
  const terminalPath = join(managedHostRunDirectory(root, detached.run.runId), 'terminal.json');
  const terminalBeforeLateCancel = readFileSync(terminalPath);
  const receiptBeforeLateCancel = managedHostRunReceipt(root, detached.run.runId);
  const parsedProviderResult = readManagedHostRunResult(root, detached.run.runId);
  assert.equal(parsedProviderResult?.usageSummary.recorded, 'provider-reported',
    'the actual managed Codex terminal parses its turn.completed usage event');
  assert.equal(parsedProviderResult?.usageSummary.provider, 'openai');
  await secondCaller.host_run_cancel({ runId: detached.run.runId, reason: 'late retry must not rewrite terminal', json: true });
  assert.deepEqual(readFileSync(terminalPath), terminalBeforeLateCancel, 'post-terminal cancel cannot rewrite the authoritative terminal bytes');
  assert.equal(managedHostRunReceipt(root, detached.run.runId).receiptId, receiptBeforeLateCancel.receiptId);
  const secret = 'secret command smoke prompt';
  const durableRunDir = managedHostRunDirectory(root, detached.run.runId);
  for (const artifact of ['terminal.json', 'result.json', 'events.jsonl', 'evidence-proposal.json']) {
    const path = join(durableRunDir, artifact);
    assert.equal(existsSync(path) && readFileSync(path, 'utf8').includes(secret), false,
      `${artifact} must not retain provider prompt plaintext`);
  }

  let releaseForeground!: () => void;
  const foregroundGate = new Promise<void>(resolve => { releaseForeground = resolve; });
  const foregroundLogs: string[] = [];
  const foregroundRunner: HostRunRunner = async plan => {
    plan.onChunk?.({ stream: 'stdout', text: '{"type":"turn.completed"}\n' });
    await foregroundGate;
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
  };
  const foregroundPromise = createHostRunHandlers(
    { ...ctx, log: message => foregroundLogs.push(message) },
    { runner: foregroundRunner },
  ).host_run({
    host: 'codex',
    agentType: 'foreground-command-smoke',
    phase: 'DEV',
    prompt: 'foreground uses the same durable lifecycle',
    deadlineMs: 2_000,
    json: true,
  }) as Promise<{ runId: string; managed: true; exitCode: number; truncated: boolean }>;
  await eventually(async () => foregroundLogs.some(line => /\[host_run\] submitted runId=/.test(line)),
    'foreground submit did not publish a recoverable managed runId before attach blocked');
  const foregroundRunId = /runId=([^\s]+)/.exec(
    foregroundLogs.find(line => /\[host_run\] submitted runId=/.test(line)) ?? '',
  )?.[1];
  assert.ok(foregroundRunId, 'foreground progress carries an exact managed runId');
  const replacementCallerStatus = await secondCaller.host_run_status({ runId: foregroundRunId, json: true }) as {
    run: { runId: string; state: string };
  };
  assert.equal(replacementCallerStatus.run.runId, foregroundRunId,
    'a replacement caller can recover the foreground run from its early progress identity');
  assert.equal(replacementCallerStatus.run.state, 'running');
  releaseForeground();
  const foreground = await foregroundPromise;
  assert.equal(foreground.managed, true, 'foreground host_run is submit-and-attach over ManagedHostRun');
  assert.equal(foreground.exitCode, 0);
  assert.equal(foreground.runId, foregroundRunId);
  assert.equal(foreground.truncated, false, 'under-ceiling live output is not marked truncated');
  assert.equal(managedHostRunReceipt(root, foregroundRunId).state, 'completed');

  // F-179: the provider can return exit 0 before authoritative cancellation is
  // observed. Foreground JSON and text must project the sealed cancelled state,
  // while result.json and its receipt stay mutually consistent.
  const postResultCancellationRoot = join(root, 'foreground-post-result-cancellation');
  const postResultCancellationHandlers = createHostRunHandlers(
    {
      root: postResultCancellationRoot,
      scanRoot: postResultCancellationRoot,
      store: new StoryStore(postResultCancellationRoot),
    },
    {
      launchWorker: async request => {
        void runManagedHostRunWorker(request, {
          runner: async plan => {
            await cancelManagedHostRun({
              root: postResultCancellationRoot,
              runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!,
              reason: 'operator cancellation after provider success',
            });
            return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
          },
          env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
          // Keep cancellation authority in the post-result branch under test.
          cancelPollMs: 5_000,
        }).catch(() => { /* the worker seals its own terminal result */ });
        return { pid: process.pid };
      },
    },
  );
  const postResultCancellation = await postResultCancellationHandlers.host_run({
    host: 'codex',
    agentType: 'post-result-cancellation-json',
    phase: 'DEV',
    prompt: 'provider exits before the authoritative cancellation is sealed',
    deadlineMs: 5_000,
    json: true,
  }) as { runId: string; exitCode: number; timedOut: boolean };
  assert.equal(postResultCancellation.exitCode, 130,
    'foreground JSON projects post-result cancellation to a nonzero canonical exit');
  assert.equal(postResultCancellation.timedOut, false);
  const postResultCancellationStatus = await getManagedHostRunStatus({
    root: postResultCancellationRoot,
    runId: postResultCancellation.runId,
  });
  assert.equal(postResultCancellationStatus.run.state, 'cancelled');
  assert.equal(readManagedHostRunResult(postResultCancellationRoot, postResultCancellation.runId)?.exitCode, 130,
    'the sealed result projects cancellation before the receipt binds its digest');
  assert.equal(managedHostRunReceipt(postResultCancellationRoot, postResultCancellation.runId).state, 'cancelled');
  await assert.rejects(
    postResultCancellationHandlers.host_run({
      host: 'codex',
      agentType: 'post-result-cancellation-text',
      phase: 'DEV',
      prompt: 'text mode cannot claim success after authoritative cancellation',
      deadlineMs: 5_000,
    }),
    /host_run: codex exited 130/,
    'foreground text throws a nonzero cancellation result rather than returning success',
  );

  // The managed-review parser can reject a provider's final envelope after a
  // zero-exit provider result. That terminal is failed, not a successful host
  // result, and the immutable result/receipt must reflect the failed state.
  const invalidManagedFinalRoot = join(root, 'invalid-managed-final-result');
  const invalidManagedFinal = await submitManagedHostRun(
    {
      root: invalidManagedFinalRoot,
      cwd: invalidManagedFinalRoot,
      host: 'codex',
      storyId: 'B-managed',
      phase: 'REVIEW',
      agentType: 'lattice-review-quality',
      reviewRunId: 'B-managed:RR-001',
      lane: 'lattice-review-quality',
      promptText: 'malformed final proposal must fail closed',
      deadlineMs: 5_000,
      projectRootHash: 'sha256:invalid-managed-final',
      profile: 'managed_reviewer',
      reviewBinding: {
        headHash: 'head-invalid-final',
        materialHash: 'material-invalid-final',
        storyFilesHash: 'story-invalid-final',
        promptHash: 'prompt-invalid-final',
        envelopeId: null,
      },
    },
    {
      launchWorker: async request => {
        void runManagedHostRunWorker(request, {
          runner: async () => ({
            stdout: '',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            terminalReason: 'completed',
            finalAssistantResult: '{"schemaVersion":"lattice.managed_review_final_proposal.v1"}',
            finalAssistantResultCount: 1,
            finalAssistantResultTruncated: false,
          }),
          env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
          cancelPollMs: 5,
        }).catch(() => { /* the worker seals its own terminal result */ });
        return { pid: process.pid };
      },
      claimTimeoutMs: 500,
      claimPollMs: 5,
    },
  );
  await eventually(async () => {
    const status = await getManagedHostRunStatus({ root: invalidManagedFinalRoot, runId: invalidManagedFinal.runId });
    return status.run.state === 'failed';
  }, 'invalid managed final result did not seal a failed terminal');
  const invalidManagedFinalStatus = await getManagedHostRunStatus({
    root: invalidManagedFinalRoot,
    runId: invalidManagedFinal.runId,
  });
  assert.match(invalidManagedFinalStatus.run.terminal?.reason ?? '', /^managed_review_final_result_invalid:/);
  assert.equal(readManagedHostRunResult(invalidManagedFinalRoot, invalidManagedFinal.runId)?.exitCode, 1,
    'a rejected final envelope seals a nonzero failed result before receipt creation');
  const invalidManagedFinalReceipt = managedHostRunReceipt(invalidManagedFinalRoot, invalidManagedFinal.runId);
  assert.equal(invalidManagedFinalReceipt.state, 'failed');
  assert.ok(invalidManagedFinalReceipt.resultDigest,
    'the failed result remains digest-bound in the immutable receipt');

  const truncatedRunner: HostRunRunner = async plan => {
    plan.onChunk?.({ stream: 'stdout', text: '{"type":"turn.started"}\n' });
    plan.onChunk?.({ stream: 'stdout', text: 'x'.repeat(MANAGED_HOST_RUN_OUTPUT_RETENTION_MAX_BYTES + 1) });
    plan.onChunk?.({ stream: 'stdout', text: '{"type":"turn.completed"}\n' });
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
  };
  const truncatedResult = await createHostRunHandlers(ctx, { runner: truncatedRunner }).host_run({
    host: 'codex',
    agentType: 'foreground-truncated-smoke',
    phase: 'DEV',
    prompt: 'foreground json must surface truncated=true after the live-output ceiling',
    deadlineMs: 2_000,
    json: true,
  }) as { runId: string; truncated: boolean; exitCode: number };
  assert.equal(truncatedResult.exitCode, 0);
  assert.equal(truncatedResult.truncated, true,
    'foreground host_run JSON must surface truncated=true after the 8 MiB live-output ceiling');
  const truncatedStatus = await secondCaller.host_run_status({
    runId: truncatedResult.runId,
    json: true,
  }) as { output: { truncated: boolean } };
  assert.equal(truncatedStatus.output.truncated, true,
    'host_run_status JSON continues to expose output.truncated after the same ceiling');

  for (const workerOutcome of ['return', 'throw'] as const) {
    const deadlineWorkerRoot = join(root, `deadline-worker-${workerOutcome}`);
    const deadlineWorkerRunner: HostRunRunner = async plan => {
      await cancelManagedHostRun({
        root: deadlineWorkerRoot,
        runId: plan.env.LATTICE_MANAGED_HOST_RUN_ID!,
        reason: 'absolute_deadline_exceeded',
      });
      if (workerOutcome === 'throw') throw new Error('provider cleanup surfaced after durable deadline cancellation');
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
    };
    const deadlineWorkerHandlers = createHostRunHandlers(
      {
        root: deadlineWorkerRoot,
        scanRoot: deadlineWorkerRoot,
        store: new StoryStore(deadlineWorkerRoot),
      },
      {
        launchWorker: async request => {
          void runManagedHostRunWorker(request, {
            runner: deadlineWorkerRunner,
            env: { ...process.env, PROOF_OR_STOP_USAGE_LEDGER: '0' },
            // The fixture must exercise the worker's post-result/catch cancel
            // branches, not let the periodic poll pre-classify the request.
            cancelPollMs: 5_000,
          }).catch(() => { /* the worker seals its own terminal failure */ });
          return { pid: process.pid };
        },
      },
    );
    const deadlineWorkerResult = await deadlineWorkerHandlers.host_run({
      host: 'codex',
      agentType: `deadline-worker-${workerOutcome}`,
      phase: 'DEV',
      prompt: `deadline worker ${workerOutcome} branch must retain timeout truth`,
      deadlineMs: 5_000,
      json: true,
    }) as { runId: string; managed: true; exitCode: number; timedOut: boolean };
    assert.equal(deadlineWorkerResult.exitCode, 124,
      `${workerOutcome} branch exposes canonical timed-out handler exit 124`);
    assert.equal(deadlineWorkerResult.timedOut, true,
      `${workerOutcome} branch cannot project absolute deadline cancellation as an ordinary cancel`);
    const deadlineWorkerStatus = await getManagedHostRunStatus({
      root: deadlineWorkerRoot,
      runId: deadlineWorkerResult.runId,
    });
    assert.equal(deadlineWorkerStatus.run.state, 'timed_out', `${workerOutcome} branch seals timed_out`);
    assert.equal(deadlineWorkerStatus.run.terminal?.reason, 'absolute_deadline_exceeded');
    assert.equal(deadlineWorkerStatus.run.terminal?.replacementSafe, workerOutcome === 'return',
      `${workerOutcome} branch preserves its independently proven cleanup truth`);
  }

  const preclaimRoot = join(root, 'preclaim-cancel');
  let preclaimInputMode = 0;
  let preclaimCapabilityMode = 0;
  const preclaimSubmission = submitManagedHostRun({
    root: preclaimRoot,
    cwd: preclaimRoot,
    host: 'codex',
    storyId: null,
    phase: 'REVIEW',
    agentType: 'preclaim-cancel-smoke',
    promptText: 'preclaim one-shot secret',
    deadlineMs: 2_000,
    projectRootHash: 'sha256:preclaim',
  }, {
    randomId: () => 'preclaim-cancel-run',
    claimTimeoutMs: 1_000,
    claimPollMs: 5,
    launchWorker: async request => {
      preclaimInputMode = statSync(join(managedHostRunDirectory(request.root, request.runId), 'input.prompt')).mode & 0o777;
      preclaimCapabilityMode = statSync(join(managedHostRunDirectory(request.root, request.runId), 'input.cap')).mode & 0o777;
      return { pid: process.pid };
    },
  });
  await eventually(async () => {
    try {
      await createHostRunHandlers({ root: preclaimRoot, scanRoot: preclaimRoot, store: new StoryStore(preclaimRoot) })
        .host_run_cancel({ runId: 'preclaim-cancel-run', reason: 'cancel before claim', json: true });
      return true;
    } catch { return false; }
  }, 'preclaim cancellation request did not reach the submitted run');
  await new Promise(resolve => setTimeout(resolve, 270));
  await recoverManagedHostRun({ root: preclaimRoot, runId: 'preclaim-cancel-run' });
  const preclaim = await preclaimSubmission;
  assert.equal(preclaim.state, 'cancelled', 'cancel before worker claim converges without a provider spawn');
  assert.equal(preclaimInputMode, 0o600, 'preclaim one-shot prompt is mode 0600');
  assert.equal(preclaimCapabilityMode, 0o600, 'preclaim one-shot capability is mode 0600');

  // A worker deadline timer persists the reserved cancellation reason before
  // a later status touch performs cleanup. Exercise that exact second branch
  // with the production clock seam: even when the injected observation clock
  // is still before spec.deadlineAt, the durable reason is deadline authority,
  // never an operator cancellation.
  const deadlineCancelRoot = join(root, 'deadline-cancel-reconcile');
  const deadlineCancelSubmission = submitManagedHostRun({
    root: deadlineCancelRoot,
    cwd: deadlineCancelRoot,
    host: 'codex',
    storyId: null,
    phase: 'REVIEW',
    agentType: 'deadline-cancel-smoke',
    promptText: 'deadline cancellation reason must remain terminal truth',
    deadlineMs: 5_000,
    projectRootHash: 'sha256:deadline-cancel',
  }, {
    randomId: () => 'deadline-cancel-run',
    claimTimeoutMs: 1_000,
    claimPollMs: 5,
    launchWorker: async () => ({ pid: process.pid }),
  });
  const deadlineCancelHandlers = createHostRunHandlers({
    root: deadlineCancelRoot,
    scanRoot: deadlineCancelRoot,
    store: new StoryStore(deadlineCancelRoot),
  });
  let deadlineCancelRequest!: { run: { cancelRequestedAt: string | null; deadlineAt: string } };
  await eventually(async () => {
    try {
      deadlineCancelRequest = await deadlineCancelHandlers.host_run_cancel({
        runId: 'deadline-cancel-run',
        reason: 'absolute_deadline_exceeded',
        json: true,
      }) as typeof deadlineCancelRequest;
      return deadlineCancelRequest.run.cancelRequestedAt !== null;
    } catch { return false; }
  }, 'deadline cancellation request did not reach the submitted run');
  const deadlineCancelRequestedAt = Date.parse(deadlineCancelRequest.run.cancelRequestedAt!);
  assert.ok(deadlineCancelRequestedAt + 300 < Date.parse(deadlineCancelRequest.run.deadlineAt),
    'fixture keeps the status clock before spec.deadlineAt so the cancel-reconcile branch is authoritative');
  const deadlineCancelTerminal = await recoverManagedHostRun({
    root: deadlineCancelRoot,
    runId: 'deadline-cancel-run',
    waitMs: 0,
    now: () => deadlineCancelRequestedAt + 300,
  });
  assert.equal(deadlineCancelTerminal.run.state, 'timed_out',
    'reserved absolute_deadline_exceeded cancellation always seals a timed_out terminal');
  assert.equal(deadlineCancelTerminal.run.terminal?.reason, 'absolute_deadline_exceeded');
  assert.equal((await deadlineCancelSubmission).state, 'timed_out');

  const foreignRoot = mkdtempSync(join(tmpdir(), 'managed-host-run-command-cross-project-'));
  try {
    const foreign = await submitManagedHostRun({
      root: foreignRoot,
      cwd: foreignRoot,
      host: 'codex',
      storyId: null,
      phase: 'DEV',
      agentType: 'foreign-run',
      promptText: 'foreign project',
      deadlineMs: 500,
      projectRootHash: 'sha256:foreign',
    }, { launchWorker: async () => ({ pid: 99_999_999 }), claimTimeoutMs: 10, claimPollMs: 5 });
    await assert.rejects(secondCaller.host_run_status({ runId: foreign.runId }), /not found/, 'cross-project runId is never resolved under this root');
  } finally {
    rmSync(foreignRoot, { recursive: true, force: true });
  }

  const watchdogRoot = join(root, 'runtime-continuation-watchdog');
  const fakeBin = join(watchdogRoot, 'bin');
  const fakeCodex = join(fakeBin, 'codex');
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(fakeCodex, [
    '#!/usr/bin/env node',
    'process.stdin.resume();',
    'setTimeout(() => {',
    '  process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}) + "\\n");',
    '}, 2000);',
    'setInterval(() => {}, 1000);',
  ].join('\n'), { mode: 0o755 });
  chmodSync(fakeCodex, 0o755);
  const watchdogEnv = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    PROOF_OR_STOP_USAGE_LEDGER: '0',
    PROOF_OR_STOP_IDLE_TIMEOUT_MS: '40',
    PROOF_OR_STOP_MAX_TIMEOUT_MS: '70',
  };
  const watchdogSubmission = await submitManagedHostRun({
    root: watchdogRoot,
    cwd: watchdogRoot,
    host: 'codex',
    storyId: null,
    phase: 'DEV',
    agentType: 'runtime-continuation-watchdog-smoke',
    promptText: 'provider outlives the generic CLI watchdog but not its explicit deadline',
    // Keep the provider's own total budget at the managed absolute deadline.
    // A shorter provider timeout would test provider timeout classification,
    // not the runtimeContinuation/absolute-deadline boundary below.
    timeoutMs: 5_000,
    deadlineMs: 5_000,
    projectRootHash: 'sha256:runtime-continuation-watchdog',
    environment: watchdogEnv,
  }, {
    launchWorker: async request => {
      const workerLogFd = openSync(join(managedHostRunDirectory(request.root, request.runId), 'worker.log'), 'a', 0o600);
      void runManagedHostRunSupervisor(request);
      try {
        const child = spawn(process.execPath, [
          CLI,
          '--root', request.root,
          'host_run_worker',
          JSON.stringify({ runId: request.runId }),
        ], { cwd: request.root, env: watchdogEnv, detached: true, stdio: ['ignore', workerLogFd, workerLogFd] });
        child.unref();
        return { pid: child.pid ?? 0 };
      } finally {
        closeSync(workerLogFd);
      }
    },
    claimTimeoutMs: 5_000,
    claimPollMs: 5,
  });
  await eventually(async () => {
    const snapshot = JSON.parse(readFileSync(join(
      managedHostRunDirectory(watchdogRoot, watchdogSubmission.runId),
      'snapshot.json',
    ), 'utf8')) as { providerLaunchState?: string };
    return snapshot.providerLaunchState === 'spawned';
  }, 'watchdog fixture provider identity was not published before the ordinary status wait', 5_000);
  const watchdogBaseline = await getManagedHostRunStatus({ root: watchdogRoot, runId: watchdogSubmission.runId });
  const ordinaryStatus = spawnSync(process.execPath, [
    CLI,
    '--root', watchdogRoot,
    'host_run_status',
    JSON.stringify({
      runId: watchdogSubmission.runId,
      afterGeneration: watchdogBaseline.run.generation,
      waitMs: 30_000,
    }),
  ], { cwd: watchdogRoot, env: watchdogEnv, encoding: 'utf8', timeout: 5_000 });
  assert.equal(ordinaryStatus.status, 2,
    `ordinary CLI status wait remains watchdog-bounded instead of borrowing runtimeContinuation: ${ordinaryStatus.stderr}`);
  assert.match(ordinaryStatus.stderr, /without output|exceeded max timeout/);
  // Use the provider's actual clock: a future injected cancellation timestamp
  // cannot establish ordering against a real child-close timestamp.
  assert.ok(Number.isFinite(Date.parse(watchdogSubmission.deadlineAt)),
    'watchdog fixture exposes a parseable managed deadline');
  await eventually(async () => (await getManagedHostRunStatus({
    root: watchdogRoot, runId: watchdogSubmission.runId,
  })).run.terminal !== null, 'the real absolute deadline must terminate the live provider', 6000);
  const watchdogTerminal = await getManagedHostRunStatus({
    root: watchdogRoot, runId: watchdogSubmission.runId,
  });
  assert.equal(watchdogTerminal.run.state, 'timed_out');
  assert.equal(watchdogTerminal.run.terminal?.reason, 'absolute_deadline_exceeded');
  const watchdogWorkerPid = watchdogSubmission.workerPid;
  assert.ok(watchdogWorkerPid && watchdogWorkerPid !== process.pid,
    'watchdog fixture exposes the exact detached worker pid for cleanup convergence');
  await eventually(async () => {
    try {
      process.kill(watchdogWorkerPid!, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }, 'watchdog fixture detached worker was not reaped after terminal cleanup', 5_000);
  assert.doesNotMatch(
    readFileSync(join(managedHostRunDirectory(watchdogRoot, watchdogSubmission.runId), 'worker.log'), 'utf8'),
    /without output|exceeded max timeout/,
    'host_run_worker ignores generic CLI idle/max watchdogs while retaining the provider deadline',
  );

  // The real CLI parent owns this story through the only available fallback:
  // its PPID. The detached child gets a new PPID, so this exercises the exact
  // ownership-gate boundary rather than an injected in-process worker seam.
  const derivedSessionRoot = join(root, 'derived-session-worker');
  const derivedSessionStoryId = 'B-derived-session-worker';
  const derivedSessionStore = new StoryStore(derivedSessionRoot);
  const derivedSessionNow = new Date().toISOString();
  derivedSessionStore.writeStory(derivedSessionStoryId, {
    storyId: derivedSessionStoryId,
    name: 'derived-session-worker',
    title: 'Derived session detached worker smoke',
    description: 'A parent CLI must keep ownership when its detached worker has a new PPID.',
    type: 'feature',
    priority: 'medium',
    phase: 'DEV',
    createdAt: derivedSessionNow,
    startedAt: derivedSessionNow,
    endedAt: null,
    events: [],
  } satisfies StoryInfo);
  const fakeProviderBin = join(derivedSessionRoot, 'fake-provider-bin');
  mkdirSync(fakeProviderBin, { recursive: true });
  const derivedSessionFakeCodex = join(fakeProviderBin, 'codex');
  writeFileSync(derivedSessionFakeCodex, `#!/bin/sh
sleep 0.2
printf '%s\\n' '{"type":"turn.completed","usage":{}}'
`);
  chmodSync(derivedSessionFakeCodex, 0o700);
  // Deliberately omit every session/host-adapter input. Both the submitting
  // CLI and the later status CLI derive their session from this smoke process,
  // while the detached worker must receive the submitter's canonical identity.
  const sessionlessEnv: NodeJS.ProcessEnv = {
    PATH: `${fakeProviderBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    PROOF_OR_STOP_USAGE_LEDGER: '0',
  };
  const derivedSessionSubmit = spawnSync(process.execPath, [
    CLI,
    '--root', derivedSessionRoot,
    'host_run',
    JSON.stringify({
      host: 'codex',
      storyId: derivedSessionStoryId,
      agentType: 'derived-session-worker-smoke',
      phase: 'DEV',
      prompt: 'complete after the submitting CLI exits',
      detach: true,
      deadlineMs: 5_000,
      json: true,
    }),
  ], { cwd: derivedSessionRoot, env: sessionlessEnv, encoding: 'utf8', timeout: 10_000 });
  assert.equal(derivedSessionSubmit.status, 0,
    `derived-PPID parent CLI must submit and receive a worker claim: ${derivedSessionSubmit.stderr}`);
  const derivedSessionDetached = JSON.parse(derivedSessionSubmit.stdout) as HostRunDetachResult;
  assert.equal(derivedSessionDetached.run.state, 'running',
    'the parent CLI returns after the detached worker claims its owned story run');
  await eventually(async () => {
    const status = spawnSync(process.execPath, [
      CLI,
      '--root', derivedSessionRoot,
      'host_run_status',
      JSON.stringify({ runId: derivedSessionDetached.run.runId, json: true }),
    ], { cwd: derivedSessionRoot, env: sessionlessEnv, encoding: 'utf8', timeout: 5_000 });
    if (status.status !== 0) return false;
    return (JSON.parse(status.stdout) as { run: { state: string } }).run.state === 'completed';
  }, 'detached derived-PPID worker was rejected by ownership after the parent CLI exited', 5_000);
  assert.equal(
    (await getManagedHostRunStatus({ root: derivedSessionRoot, runId: derivedSessionDetached.run.runId })).run.terminal?.reason,
    'provider_completed',
  );
  assert.doesNotMatch(
    readFileSync(join(managedHostRunDirectory(derivedSessionRoot, derivedSessionDetached.run.runId), 'worker.log'), 'utf8'),
    /owned by another Proofbound session|non-owner/i,
    'the child CLI receives the canonical derived session instead of deriving a foreign identity from its new PPID',
  );

  const terminalAt = Date.parse(receiptBeforeLateCancel.terminalAt);
  const gc = pruneExpiredManagedHostRuns(root, { now: terminalAt + 2, retentionMs: 1 });
  assert.ok(gc.removed.includes(detached.run.runId));
  const archivedReceipt = join(managedHostRunReceiptsRoot(root), `${detached.run.runId}.json`);
  assert.equal(existsSync(archivedReceipt), true, 'terminal GC archives the minimal receipt');
  assert.equal(readFileSync(archivedReceipt, 'utf8').includes(secret), false,
    'the archived receipt must not retain provider prompt plaintext');
  await assert.rejects(secondCaller.host_run_status({ runId: detached.run.runId }), /not found/, 'a stale GCd runtime runId cannot be attached or mutated');

  console.log('managed-host-run-command-smoke PASS');
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  })
  .finally(() => rmSync(root, { recursive: true, force: true }));
