#!/usr/bin/env node

/**
 * Safe injected regression for public managed-review execution isolation.
 *
 * It creates only temporary git worktrees and uses an in-process fake runner:
 * no provider CLI, host_run CLI, process group, or signal is invoked.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createManagedReviewScratchWorktree,
  getManagedHostRunStatus,
  managedHostRunDirectory,
  readManagedHostRunBinding,
  runManagedHostRunWorker,
  scanManagedHostRunRuntime,
  submitManagedHostRun,
  type ManagedHostRunTerminal,
} from '../core/managed-host-run.js';
import { currentMaterialHash } from '../core/evidence-freshness.js';
import type { HostRunRunner, HostRunSpawnPlan } from '../core/host-run.js';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function reviewBinding(headHash: string, materialHash: string) {
  return {
    headHash,
    materialHash,
    storyFilesHash: 'sha256:managed-review-scratch-story',
    promptHash: 'sha256:managed-review-scratch-prompt',
    managedPromptDigest: `sha256:${'a'.repeat(64)}`,
    envelopeId: null,
  };
}

function safeFailureResult() {
  return {
    stdout: '',
    stderr: 'injected provider failure',
    exitCode: 1,
    timedOut: false,
    terminalReason: 'exit_nonzero' as const,
    replacementSafe: true,
    residualProcessGroup: false,
    processCleanup: { termSent: false, killSent: false, reaped: true, residualProcessGroup: false },
  };
}

function successfulPassResult(reviewRunId: string) {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    terminalReason: 'completed' as const,
    replacementSafe: true,
    residualProcessGroup: false,
    processCleanup: { termSent: false, killSent: false, reaped: true, residualProcessGroup: false },
    finalAssistantResult: JSON.stringify({
      schemaVersion: 'lattice.managed_review_final_proposal.v1',
      storyId: 'B-scratch',
      providerAgent: 'lattice-review-quality',
      lane: 'lattice-review-quality',
      reviewRunId,
      conclusion: 'pass',
      note: 'The injected detached review completed without a scratch mutation.',
      readManifest: {
        filesReadFully: ['primary-sentinel.txt'],
        filesTriagedByName: [],
        scanEscalationReason: null,
        candidateSpecSetDigest: 'a'.repeat(64),
        corpusDigest: 'b'.repeat(64),
      },
      readLog: {
        filesReadFully: ['primary-sentinel.txt'],
        filesTriagedByName: [],
        summary: { readCount: 1, tokenCount: null },
        digest: 'c'.repeat(64),
      },
    }),
    finalAssistantResultCount: 1,
    finalAssistantResultTruncated: false,
  };
}

function isRegistered(root: string, worktree: string): boolean {
  return git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .some(line => line === `worktree ${worktree}`);
}

async function submitIsolatedManagedReview(args: {
  root: string;
  headHash: string;
  materialHash: string;
  runId: string;
  runner: HostRunRunner;
  beforeWorker?: () => void;
  parentFactory?: () => string;
  environment?: NodeJS.ProcessEnv;
}): Promise<{ terminal: ManagedHostRunTerminal; plan: HostRunSpawnPlan | null }> {
  let worker: Promise<ManagedHostRunTerminal> | null = null;
  let plan: HostRunSpawnPlan | null = null;
  const observedRunner: HostRunRunner = async spawnPlan => {
    plan = spawnPlan;
    return args.runner(spawnPlan);
  };
  await submitManagedHostRun({
    root: args.root,
    cwd: args.root,
    host: 'codex',
    storyId: 'B-scratch',
    phase: 'REVIEW',
    agentType: 'lattice-review-quality',
    reviewRunId: `B-scratch:${args.runId}`,
    lane: 'lattice-review-quality',
    promptText: 'injected managed-review scratch isolation probe',
    deadlineMs: 5_000,
    projectRootHash: 'sha256:managed-review-scratch-project',
    profile: 'managed_reviewer',
    reviewBinding: reviewBinding(args.headHash, args.materialHash),
    isolateManagedReview: true,
    environment: args.environment,
  }, {
    claimTimeoutMs: 1_000,
    claimPollMs: 5,
    managedReviewScratchParentFactory: args.parentFactory,
    launchWorker: async request => {
      args.beforeWorker?.();
      worker = runManagedHostRunWorker(request, {
        runner: observedRunner,
        env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
      });
      return { pid: process.pid };
    },
  });
  assert.ok(worker, 'injected worker launch occurred');
  return { terminal: await worker, plan };
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'managed-review-scratch-isolation-'));
  try {
    git(root, ['init']);
    git(root, ['config', 'user.email', 'managed-review-scratch@example.test']);
    git(root, ['config', 'user.name', 'Managed Review Scratch Smoke']);
    writeFileSync(join(root, 'primary-sentinel.txt'), 'primary worktree must remain intact\n');
    git(root, ['add', 'primary-sentinel.txt']);
    git(root, ['commit', '-m', 'initial primary sentinel']);
    const headHash = git(root, ['rev-parse', 'HEAD']);
    const materialHash = currentMaterialHash(root);
    assert.ok(materialHash, 'fresh primary fixture has a material hash for its signed review binding');

    const completed = await submitIsolatedManagedReview({
      root,
      headHash,
      materialHash,
      runId: 'managed-review-scratch-completed',
      runner: () => safeFailureResult(),
    });
    const binding = readManagedHostRunBinding(root, completed.terminal.runId);
    const persistedSpec = JSON.parse(readFileSync(
      join(managedHostRunDirectory(root, completed.terminal.runId), 'spec.json'),
      'utf8',
    )) as { root: string; cwd: string; managedReviewScratch?: { headHash?: string; cwd?: string } };

    assert.equal(completed.terminal.state, 'failed', 'safe injected provider failure reaches a terminal state');
    assert.equal(completed.terminal.replacementSafe, true, 'terminal records a reaped, replacement-safe provider boundary');
    assert.equal(persistedSpec.root, root, 'durable evidence root remains the canonical primary worktree');
    assert.equal(binding.cwd, persistedSpec.cwd, 'sealed binding persists the exact provider execution cwd');
    assert.notEqual(binding.cwd, root, 'provider execution cwd is never the canonical primary worktree');
    assert.equal(persistedSpec.managedReviewScratch?.cwd, binding.cwd, 'sealed scratch registration binds the spec cwd');
    assert.equal(persistedSpec.managedReviewScratch?.headHash, headHash, 'sealed scratch registration binds the submitted HEAD');
    assert.equal(completed.plan?.cwd, binding.cwd, 'provider plan executes only in the sealed detached scratch cwd');
    assert.deepEqual(completed.plan?.argv, ['exec', '--json', '-s', 'read-only', '-C', binding.cwd, '-'],
      'Codex managed-review launch uses observable JSON plus native read-only mode with the scratch cwd');
    assert.equal(existsSync(dirname(binding.cwd)), false,
      'a proven safe terminal removes only its managed-review scratch parent');
    assert.equal(isRegistered(root, binding.cwd), false,
      'terminal cleanup removes the exact scratch git-worktree registration');
    assert.equal(readFileSync(join(root, 'primary-sentinel.txt'), 'utf8'), 'primary worktree must remain intact\n',
      'terminal scratch cleanup has no effect on the canonical primary worktree');

    let substitutedScratch = '';
    const substituted = await submitIsolatedManagedReview({
      root,
      headHash,
      materialHash,
      runId: 'managed-review-scratch-substituted',
      runner: () => safeFailureResult(),
      parentFactory: () => {
        const parent = mkdtempSync(join(tmpdir(), 'lattice-managed-review-'));
        substitutedScratch = join(parent, 'worktree');
        return parent;
      },
      beforeWorker: () => {
        assert.ok(substitutedScratch.length > 0, 'scratch parent factory published the exact execution path');
        rmSync(substitutedScratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
      },
      environment: { MANAGED_REVIEW_SCRATCH_ONE_SHOT_SECRET: 'must-not-survive-pre-intake-failure' },
    });
    // The parent factory is overridden only for this test to capture the fresh
    // owned path before the worker revalidates it.
    assert.match(substituted.terminal.reason, /^managed_review_scratch_invalid:/,
      'a missing/replaced scratch fails before provider spawn rather than resuming in another cwd');
    assert.equal(substituted.plan, null, 'invalid scratch never reaches the provider runner');
    for (const oneShotName of ['input.cap', 'input.prompt', 'input.env.json']) {
      assert.equal(existsSync(join(managedHostRunDirectory(root, substituted.terminal.runId), oneShotName)), false,
        `pre-intake scratch rejection erases ${oneShotName} before terminal retention`);
    }
    assert.equal(readFileSync(join(root, 'primary-sentinel.txt'), 'utf8'), 'primary worktree must remain intact\n',
      'invalid-scratch failure cleanup still leaves the primary worktree untouched');

    const failedParent = mkdtempSync(join(tmpdir(), 'lattice-managed-review-'));
    writeFileSync(join(failedParent, 'worktree'), 'force git worktree setup failure');
    assert.throws(
      () => createManagedReviewScratchWorktree({
        gitCwd: root,
        runId: 'managed-review-scratch-setup-failure',
        headHash,
        parentFactory: () => failedParent,
      }),
      /cannot create detached managed-review scratch/,
      'scratch setup failure is fail-closed',
    );
    assert.equal(existsSync(failedParent), false, 'failed setup removes only its fresh owned scratch parent');
    assert.equal(readFileSync(join(root, 'primary-sentinel.txt'), 'utf8'), 'primary worktree must remain intact\n',
      'failed setup cleanup has no primary worktree effect');
    assert.equal(isRegistered(root, join(failedParent, 'worktree')), false,
      'failed setup leaves no detached scratch registration behind');

    const cleanReceipt = await submitIsolatedManagedReview({
      root,
      headHash,
      materialHash,
      runId: 'managed-review-scratch-clean-receipt',
      runner: () => successfulPassResult('B-scratch:managed-review-scratch-clean-receipt'),
    });
    assert.equal(cleanReceipt.terminal.state, 'completed',
      'an unchanged detached scratch still seals a valid managed-review terminal');
    assert.equal(existsSync(join(managedHostRunDirectory(root, cleanReceipt.terminal.runId), 'evidence-proposal.json')), true,
      'the valid unchanged provider proposal remains available for managed-review evidence import');

    const mutatedReceipt = await submitIsolatedManagedReview({
      root,
      headHash,
      materialHash,
      runId: 'managed-review-scratch-mutated-receipt',
      runner: spawnPlan => {
        writeFileSync(join(spawnPlan.cwd, 'primary-sentinel.txt'), 'provider changed detached review material\n');
        return successfulPassResult('B-scratch:managed-review-scratch-mutated-receipt');
      },
    });
    assert.equal(mutatedReceipt.terminal.state, 'failed',
      'a provider mutation after launch cannot seal a completed managed-review receipt');
    assert.match(mutatedReceipt.terminal.reason, /^managed_review_scratch_integrity_invalid:/,
      'the terminal explicitly records the post-exit scratch-integrity rejection');
    assert.equal(existsSync(join(managedHostRunDirectory(root, mutatedReceipt.terminal.runId), 'evidence-proposal.json')), false,
      'a mutated scratch cannot write a pass/finding proposal for later import');
    assert.equal(readFileSync(join(root, 'primary-sentinel.txt'), 'utf8'), 'primary worktree must remain intact\n',
      'post-exit integrity rejection leaves the canonical primary worktree untouched');

    const terminalCleanupParent = mkdtempSync(join(tmpdir(), 'lattice-managed-review-'));
    const terminalCleanupFailure = await submitIsolatedManagedReview({
      root,
      headHash,
      materialHash,
      runId: 'managed-review-scratch-terminal-cleanup-diagnostic',
      parentFactory: () => terminalCleanupParent,
      runner: spawnPlan => {
        // This fixture removes only its own registration marker after provider
        // launch. Terminal sealing must remain valid, while cleanup reports a
        // durable recovery diagnostic rather than swallowing the failure.
        unlinkSync(join(dirname(spawnPlan.cwd), 'managed-review-scratch.json'));
        return safeFailureResult();
      },
    });
    assert.equal(terminalCleanupFailure.terminal.state, 'failed');
    const terminalCleanupStatus = await getManagedHostRunStatus({
      root,
      runId: terminalCleanupFailure.terminal.runId,
      waitMs: 0,
    });
    assert.equal(terminalCleanupStatus.run.managedReviewScratchCleanupDiagnostic?.stage, 'terminal',
      'post-terminal scratch cleanup failures remain visible from run status');
    assert.match(terminalCleanupStatus.run.managedReviewScratchCleanupDiagnostic?.error ?? '', /registration marker is absent/);
    assert.equal(
      scanManagedHostRunRuntime(root).runs.find(run => run.runId === terminalCleanupFailure.terminal.runId)
        ?.managedReviewScratchCleanupDiagnostic?.stage,
      'terminal',
      'runtime health scan exposes the retained terminal cleanup failure',
    );
    git(root, ['worktree', 'remove', '--force', join(terminalCleanupParent, 'worktree')]);
    rmSync(terminalCleanupParent, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });

    // F-239: if the scratch cleanup marker itself cannot be persisted, the
    // terminal remains authoritative but the lost diagnostic is visible to the
    // doctor health channel rather than silently disappearing.
    const previousHealthPath = process.env.PROOF_OR_STOP_HEALTH_PATH;
    const healthPath = join(root, 'managed-review-scratch-health.jsonl');
    process.env.PROOF_OR_STOP_HEALTH_PATH = healthPath;
    const healthFailureParent = mkdtempSync(join(tmpdir(), 'lattice-managed-review-'));
    try {
      const healthFailure = await submitIsolatedManagedReview({
        root,
        headHash,
        materialHash,
        runId: 'managed-review-scratch-health-diagnostic-failure',
        parentFactory: () => healthFailureParent,
        runner: spawnPlan => {
          unlinkSync(join(dirname(spawnPlan.cwd), 'managed-review-scratch.json'));
          mkdirSync(join(managedHostRunDirectory(root, spawnPlan.env.LATTICE_MANAGED_HOST_RUN_ID!), 'managed-review-scratch-cleanup-diagnostic.json'));
          return safeFailureResult();
        },
      });
      assert.equal(healthFailure.terminal.state, 'failed');
      const healthRows = readFileSync(healthPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { category?: string; context?: { runId?: string; stage?: string } });
      assert.ok(healthRows.some(row => row.category === 'persist:managedReviewScratchCleanupDiagnostic'
        && row.context?.runId === healthFailure.terminal.runId
        && row.context?.stage === 'terminal'),
      'a scratch cleanup diagnostic persistence failure is surfaced through the doctor health channel');
    } finally {
      if (previousHealthPath === undefined) delete process.env.PROOF_OR_STOP_HEALTH_PATH;
      else process.env.PROOF_OR_STOP_HEALTH_PATH = previousHealthPath;
      git(root, ['worktree', 'remove', '--force', join(healthFailureParent, 'worktree')]);
      rmSync(healthFailureParent, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }

    const inputFailureParent = mkdtempSync(join(tmpdir(), 'lattice-managed-review-'));
    let inputFailureWorkerLaunched = false;
    const inputFailure = await submitManagedHostRun({
      root,
      cwd: root,
      host: 'codex',
      storyId: 'B-scratch',
      phase: 'REVIEW',
      agentType: 'lattice-review-quality',
      reviewRunId: 'B-scratch:managed-review-scratch-input-cleanup-diagnostic',
      lane: 'lattice-review-quality',
      promptText: 'injected managed-review scratch input failure probe',
      deadlineMs: 5_000,
      projectRootHash: 'sha256:managed-review-scratch-project',
      profile: 'managed_reviewer',
      reviewBinding: reviewBinding(headHash, materialHash),
      isolateManagedReview: true,
    }, {
      managedReviewScratchParentFactory: () => inputFailureParent,
      beforeOneShotInputWrite: ({ runId }) => {
        unlinkSync(join(inputFailureParent, 'managed-review-scratch.json'));
        writeFileSync(join(managedHostRunDirectory(root, runId), 'input.prompt'), 'pre-existing test collision');
      },
      launchWorker: async () => {
        inputFailureWorkerLaunched = true;
        return { pid: process.pid };
      },
    });
    assert.equal(inputFailureWorkerLaunched, false, 'input-write failure refuses before worker launch');
    assert.equal(inputFailure.state, 'failed', 'input-write failure records a durable failed run');
    const inputFailureStatus = await getManagedHostRunStatus({
      root,
      runId: inputFailure.runId,
      waitMs: 0,
    });
    assert.equal(inputFailureStatus.run.managedReviewScratchCleanupDiagnostic?.stage, 'submit_input_setup',
      'input cleanup failures retain their pre-terminal stage for recovery');
    assert.match(inputFailureStatus.run.terminal?.reason ?? '', /^submit_input_write_failed:/);
    assert.equal(inputFailureStatus.run.terminal?.replacementSafe, true,
      'a pre-launch one-shot input failure is replacement-safe because no worker can exist');
    const inputFailureDir = managedHostRunDirectory(root, inputFailure.runId);
    for (const oneShotInput of ['input.cap', 'input.prompt', 'input.env.json']) {
      assert.equal(existsSync(join(inputFailureDir, oneShotInput)), false,
        `pre-launch failure erases one-shot ${oneShotInput} while retaining the cleanup diagnostic`);
    }
    git(root, ['worktree', 'remove', '--force', join(inputFailureParent, 'worktree')]);
    rmSync(inputFailureParent, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });

    console.log('managed-review-scratch-isolation-smoke PASS');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
