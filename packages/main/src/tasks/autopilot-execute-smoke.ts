#!/usr/bin/env node
/**
 * Smoke coverage for the true Lattice autopilot executor loop:
 * - execute is separate from run/projection.
 * - local mode runs argv-mapped Lattice commands without shell parsing.
 * - authority DONE without a verified receipt fails closed before execution.
 * - Claude Code CLI repair is disabled by default and only runs when explicit.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  executeAutopilot,
  type AutopilotCommandRequest,
  type AutopilotCommandResult,
  type AutopilotCommandRunner,
} from '../core/autopilot-executor.js';
import type { ClaimedAuthorityJob } from '../core/authority-runner.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import { createAutopilotHandlers } from '../handlers/autopilot.js';

const PASS_LINE =
  '✓ autopilot execute smoke passed: local executor, authority fail-closed, explicit Claude repair, claimed-job --jobFile consumption (typed plannedSteps[], receipt-gated DONE), and main CLI registry routing verified';

const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

type EnvOverride = Record<string, string | undefined>;

const NOT_READY_AUTHORITY_ENV: EnvOverride = {
  LATTICE_AUTHORITY_MODE: 'enforce',
  LATTICE_AUTHORITY_URL: 'https://authority.test',
  LATTICE_AUTHORITY_ACTOR_KEY: 'test-actor-key',
  LATTICE_AUTHORITY_RUNNER_ID: 'runner-1',
};

const READY_AUTHORITY_ENV: EnvOverride = {
  ...NOT_READY_AUTHORITY_ENV,
  LATTICE_AUTHORITY_CUSTOMER_API_KEY: 'customer-key-canary',
  LATTICE_AUTHORITY_SESSION_ID: 'session-1',
  LATTICE_AUTHORITY_PROJECT_ID: 'project-1',
};

function writeConfig(root: string): void {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  resetConfigCache();
}

function seedStory(store: StoryStore): void {
  const now = '2026-06-04T00:00:00.000Z';
  const story: StoryInfo = {
    storyId: 'B-auto',
    name: 'autopilot-execute-smoke',
    title: 'Autopilot execute smoke',
    description: 'Verify the bounded unattended autopilot executor loop.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: now }],
  };
  store.writeStory('B-auto', story);
}

function commandKey(request: AutopilotCommandRequest): string {
  if (request.executable === 'claude') return 'claude';
  const rootFlag = request.args.indexOf('--root');
  if (rootFlag >= 0) return request.args.slice(rootFlag + 2).join(' ');
  return [request.executable, ...request.args].join(' ');
}

function passingRunner(requests: AutopilotCommandRequest[]): AutopilotCommandRunner {
  return request => {
    requests.push(request);
    return { exitCode: 0, stdout: `ok ${commandKey(request)}`, stderr: '' };
  };
}

let claimedStepSeq = 0;
function claimedStep(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  claimedStepSeq += 1;
  const provider = type === 'provider.fake' ? 'fake' : type === 'provider.codex' ? 'codex' : undefined;
  return {
    stepId: `cstep-${String(claimedStepSeq).padStart(3, '0')}`,
    type,
    title: `claimed ${type}`,
    purpose: `bounded ${type} from a claimed authority job`,
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

const root = mkdtempSync(join(tmpdir(), 'lattice-autopilot-execute-'));

// Drives the real compiled `lattice` CLI binary against the same temp root so the
// test exercises the main registry dispatch path (not just the in-process
// executor/handler imports). Returns parsed stdout JSON.
function runCli(args: string[], env?: EnvOverride): any {
  const out = execFileSync(process.execPath, [cliPath, '--root', root, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : process.env,
  });
  return JSON.parse(out);
}

try {
  writeConfig(root);
  const store = new StoryStore(root);
  seedStory(store);

  const dryRunRequests: AutopilotCommandRequest[] = [];
  const dryRun = executeAutopilot({
    store,
    root,
    args: { mode: 'local', storyId: 'B-auto', until: 'TEST', dryRun: true },
    runner: passingRunner(dryRunRequests),
  });
  assert.equal(dryRun.schemaVersion, 'lattice.autopilot_execute.v1');
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.stopReason, 'dry-run');
  assert.equal(dryRun.executedSteps.length, 0);
  assert.equal(dryRunRequests.length, 0, 'dry-run execute must not run commands');

  const unboundRequests: AutopilotCommandRequest[] = [];
  const unbound = executeAutopilot({
    store,
    root,
    args: { mode: 'local', until: 'TEST', maxSteps: 20 },
    runner: passingRunner(unboundRequests),
  });
  assert.equal(unbound.status, 'fail');
  assert.equal(unbound.stopReason, 'story-required');
  assert.equal(unboundRequests.length, 0, 'non-dry-run execute must require a concrete storyId before running commands');

  const missingStoryRequests: AutopilotCommandRequest[] = [];
  const missingStory = executeAutopilot({
    store,
    root,
    args: { mode: 'local', storyId: 'B-missing', until: 'TEST', maxSteps: 20 },
    runner: passingRunner(missingStoryRequests),
  });
  assert.equal(missingStory.status, 'fail');
  assert.equal(missingStory.stopReason, 'story-not-found');
  assert.equal(missingStoryRequests.length, 0, 'non-dry-run execute must not run commands for a missing storyId');

  const localRequests: AutopilotCommandRequest[] = [];
  const local = executeAutopilot({
    store,
    root,
    args: { mode: 'local', storyId: 'B-auto', until: 'TEST', maxSteps: 20 },
    runner: passingRunner(localRequests),
  });
  assert.equal(local.status, 'pass');
  assert.equal(local.stopReason, 'completed');
  assert.equal(local.localWorkflowUsable, true, 'local mode must remain fully usable through the executor');
  assert.equal(local.authorityRequired, false, 'local execute must not require authority');
  assert.equal(local.authorityDone, false, 'local execute never claims authority DONE');
  assert(local.executedSteps.some(step => step.id === 'advance-target'), 'local execute should reach lifecycle advance step');
  assert(local.executedSteps.every(step => step.status === 'passed'), 'all local steps should pass with passing runner');
  const localKeys = localRequests.map(commandKey);
  assert(localKeys.includes('validate --story=B-auto'), 'validate should be story-scoped when a storyId is bound');
  assert(localKeys.includes('codex verify --storyId=B-auto'), 'Codex adapter verification should be story-scoped when a storyId is bound');
  assert(!localKeys.includes('claude'), 'Claude repair must not run by default');

  const handlerRequests: AutopilotCommandRequest[] = [];
  const handlers = createAutopilotHandlers({
    root,
    scanRoot: 'packages/main',
    store,
    autopilotCommandRunner: passingRunner(handlerRequests),
  });
  const handled = handlers.autopilot_execute({
    mode: 'local',
    storyId: 'B-auto',
    until: 'TEST',
    maxSteps: 20,
    json: true,
  });
  assert.equal((handled as any).schemaVersion, 'lattice.autopilot_execute.v1');
  const events = store.readProcessEvents('B-auto');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'autopilot_execution');
  assert.equal(events[0].receiptVerified, false, 'executor receipt must not be an authority receipt');

  const authorityRequests: AutopilotCommandRequest[] = [];
  const authorityDoneWithoutReceipt = executeAutopilot({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'DONE', maxSteps: 20 },
    env: NOT_READY_AUTHORITY_ENV,
    runner: passingRunner(authorityRequests),
  });
  assert.equal(authorityDoneWithoutReceipt.status, 'fail');
  assert.equal(authorityDoneWithoutReceipt.stopReason, 'authority-not-ready');
  assert.equal(authorityDoneWithoutReceipt.receiptRequired, true);
  assert.equal(authorityDoneWithoutReceipt.receipt.verified, false);
  assert.equal(authorityDoneWithoutReceipt.authorityDone, false, 'blocked authority execute must not claim authority DONE');
  assert.equal(authorityDoneWithoutReceipt.fullAuthorityDone, false, 'blocked authority execute must not claim full authority DONE in-process either');
  assert.equal(authorityRequests.length, 0, 'authority DONE without receipt must fail closed before execution');
  assert(
    authorityDoneWithoutReceipt.nextActions.some(action => action.includes('--mode=local')),
    'a blocked authority executor must surface a recoverable nextAction (fall back to local or supply a verified receipt)',
  );
  assert(
    authorityDoneWithoutReceipt.executedSteps.length === 0,
    'a blocked authority executor must not record executed steps',
  );

  const failedNoRepairRequests: AutopilotCommandRequest[] = [];
  const failedNoRepair = executeAutopilot({
    store,
    root,
    args: { mode: 'local', storyId: 'B-auto', until: 'TEST', maxSteps: 20 },
    runner: request => {
      failedNoRepairRequests.push(request);
      if (commandKey(request) === 'validate --story=B-auto') {
        return { exitCode: 2, stdout: '', stderr: 'validation failed' };
      }
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(failedNoRepair.status, 'fail');
  assert.equal(failedNoRepair.stopReason, 'step-failed');
  assert.equal(failedNoRepair.repair.attempts.length, 0);
  assert(!failedNoRepairRequests.map(commandKey).includes('claude'), 'failed steps must not invoke Claude unless explicitly enabled');

  const repairRequests: AutopilotCommandRequest[] = [];
  let validateCalls = 0;
  const repairRunner: AutopilotCommandRunner = request => {
    repairRequests.push(request);
    const key = commandKey(request);
    if (key === 'validate --story=B-auto') {
      validateCalls += 1;
      if (validateCalls === 1) return { exitCode: 2, stdout: '', stderr: 'validation failed before repair' };
    }
    if (key === 'claude') return { exitCode: 0, stdout: 'repair applied', stderr: '' };
    return { exitCode: 0, stdout: 'ok', stderr: '' };
  };
  const repaired = executeAutopilot({
    store,
    root,
    args: {
      mode: 'local',
      storyId: 'B-auto',
      until: 'TEST',
      maxSteps: 20,
      allowClaudeRepair: true,
      maxRepairAttempts: 1,
    },
    runner: repairRunner,
  });
  assert.equal(repaired.status, 'pass');
  assert.equal(repaired.repair.enabled, true);
  assert.equal(repaired.repair.attempts.length, 1);
  assert.equal(repaired.repair.attempts[0].status, 'passed');
  assert.equal(validateCalls, 2, 'failed step should be retried after a successful Claude repair');
  assert(repairRequests.map(commandKey).includes('claude'), 'explicit repair should invoke Claude Code CLI');

  // --- Claimed authority job consumption (beyond projection) ---------------
  // When a claimed Authority job carrying typed plannedSteps[] is supplied, the
  // executor consumes it through the shared plannedSteps executor instead of
  // synthesizing local argv steps, and authority DONE stays gated by a verified
  // native receipt. The argv runner must NOT be invoked for these steps.
  const claimedDoneRequests: AutopilotCommandRequest[] = [];
  const claimedDone = executeAutopilot({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'DONE', maxSteps: 20 },
    env: READY_AUTHORITY_ENV,
    runner: passingRunner(claimedDoneRequests),
    claimedJob: {
      jobId: 'job-exec-done',
      storyId: 'B-auto',
      mode: 'authority',
      until: 'DONE',
      plannedSteps: [
        claimedStep('lattice.command', { args: { operation: 'story.resolve' } }),
        claimedStep('provider.fake'),
        claimedStep('gate.evaluate'),
      ],
    } as ClaimedAuthorityJob,
  });
  assert.equal(claimedDone.status, 'fail', 'authority DONE without a verified receipt must fail closed even when consuming a claimed job');
  assert.equal(claimedDone.stopReason, 'authority-job-blocked');
  assert.equal(claimedDone.authorityDone, false, 'consuming a claimed job must never self-claim authority DONE');
  assert.equal(claimedDone.claimedJobExecution?.disposition, 'blocked');
  assert.equal(claimedDone.claimedJobExecution?.execution?.status, 'blocked');
  assert.equal(claimedDoneRequests.length, 0, 'claimed plannedSteps execution must not invoke the local argv runner');
  assert.equal(claimedDone.executedSteps.length, 0, 'claimed-job path records execution under claimedJobExecution, not executedSteps');
  // The fail-closed completion verdict is surfaced on the autopilot execute result.
  // A claimed authority/DONE job with no verified native receipt mints no authority
  // DONE flag and records the receipt requirement as the first block reason.
  assert(claimedDone.completion, 'a claimed-job execution surfaces the completion verdict');
  assert.equal(claimedDone.completion?.authorityDone, false);
  assert.equal(claimedDone.completion?.fullAuthorityDone, false);
  assert.equal(claimedDone.completion?.completed, false);
  assert.equal(claimedDone.completion?.blockingReasons[0], 'authority_gate_decision_receipt_required', 'the verified-receipt requirement is the first block reason');
  assert.deepEqual(claimedDone.blockingReasons, claimedDone.completion?.blockingReasons, 'autopilot execute echoes the verdict blockingReasons at top level');
  assert.deepEqual(claimedDone.receiptRefs, [], 'no native gate_decision receipt was issued, so no receipt ref is surfaced');
  assert.deepEqual(claimedDone.hostVerdictRefs, [], 'no host verdicts were reconciled');
  assert(typeof claimedDone.nextAction === 'string' && claimedDone.nextAction.length > 0, 'a final nextAction is surfaced');

  const claimedDoneWithMismatchedReceipt = executeAutopilot({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'DONE', maxSteps: 20 },
    env: READY_AUTHORITY_ENV,
    runner: passingRunner([]),
    claimedJob: {
      jobId: 'job-exec-done-with-receipt',
      storyId: 'B-auto',
      mode: 'authority',
      until: 'DONE',
      plannedSteps: [
        claimedStep('lattice.command', { args: { operation: 'story.resolve' } }),
        claimedStep('provider.fake'),
        claimedStep('gate.evaluate'),
      ],
    } as ClaimedAuthorityJob,
    claimedJobAuthorityGate: input => ({
      receiptVerified: true,
      decision: 'approve',
      receiptId: 'rcpt-exec-done-with-receipt',
      decisionDigest: 'dd-exec-done-with-receipt',
      gateInputDigest: input.gateInputDigest,
      reason: 'smoke verified receipt',
    }),
    claimedJobGateDecision: {
      status: 'verified',
      decision: 'approve',
      receiptVerified: true,
      receiptId: 'rcpt-exec-done-with-receipt',
      decisionDigest: 'dd-exec-done-with-receipt',
      gateInputDigest: 'gate-input-digest-owned-by-executor',
      reason: 'smoke verified receipt',
    },
  });
  assert.equal(claimedDoneWithMismatchedReceipt.status, 'fail', 'mismatched claimed-job gateDecision must fail closed');
  assert.equal(claimedDoneWithMismatchedReceipt.stopReason, 'authority-job-released');
  assert.equal(claimedDoneWithMismatchedReceipt.authorityDone, false, 'mismatched claimed-job receipt must not project per-run authority DONE');
  assert.equal(claimedDoneWithMismatchedReceipt.fullAuthorityDone, false, 'multi-host final certification remains separate');
  assert.equal(claimedDoneWithMismatchedReceipt.receipt.verified, false, 'top-level receipt projection must agree with the binding failure');
  assert.equal(claimedDoneWithMismatchedReceipt.receipt.native, true);
  assert.equal(claimedDoneWithMismatchedReceipt.receipt.kind, 'gate_decision');
  assert.equal(claimedDoneWithMismatchedReceipt.receipt.receiptId, 'rcpt-exec-done-with-receipt');
  assert.equal(claimedDoneWithMismatchedReceipt.completion?.receiptVerified, false);
  assert.equal(claimedDoneWithMismatchedReceipt.completion?.blockingReasons[0], 'authority_gate_receipt_binding_mismatch');
  assert.deepEqual(claimedDoneWithMismatchedReceipt.receiptRefs, [{
    receiptId: 'rcpt-exec-done-with-receipt',
    kind: 'gate_decision',
    decisionDigest: 'dd-exec-done-with-receipt',
    verified: false,
  }]);

  const claimedTestRequests: AutopilotCommandRequest[] = [];
  const claimedTest = executeAutopilot({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'TEST', maxSteps: 20 },
    env: READY_AUTHORITY_ENV,
    runner: passingRunner(claimedTestRequests),
    claimedJob: {
      jobId: 'job-exec-test',
      storyId: 'B-auto',
      mode: 'authority',
      until: 'TEST',
      plannedSteps: [
        claimedStep('lattice.command', { args: { operation: 'story.resolve' } }),
        claimedStep('provider.fake'),
        claimedStep('gate.evaluate'),
        claimedStep('stop.summary'),
      ],
    } as ClaimedAuthorityJob,
  });
  assert.equal(claimedTest.status, 'pass', 'an all-passing non-DONE authority job completes through the executor');
  assert.equal(claimedTest.stopReason, 'authority-job-completed');
  assert.equal(claimedTest.claimedJobExecution?.disposition, 'completed');
  assert.equal(claimedTest.claimedJobExecution?.execution?.status, 'done');
  assert.equal(claimedTest.authorityDone, false, 'a non-DONE target never claims authority DONE');
  assert.equal(claimedTestRequests.length, 0, 'claimed plannedSteps execution must not invoke the local argv runner');
  // A completed authority/non-DONE job completes on local validation and never
  // projects an authority DONE flag; the verdict carries no multi-host requirement.
  assert.equal(claimedTest.completion?.completed, true, 'a non-DONE authority job completes on validation alone');
  assert.equal(claimedTest.completion?.authorityDone, false, 'authority/non-DONE never projects authorityDone');
  assert.equal(claimedTest.completion?.fullAuthorityDone, false);
  assert.equal(claimedTest.completion?.multiHostRequired, false, 'a non-DONE target carries no authority multi-host requirement');
  assert.deepEqual(claimedTest.completion?.blockingReasons, [], 'a completed job has no block reasons');

  const mismatchJob = executeAutopilot({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'DONE', maxSteps: 20 },
    env: READY_AUTHORITY_ENV,
    claimedJob: {
      jobId: 'job-exec-mismatch',
      storyId: 'B-other',
      mode: 'authority',
      until: 'DONE',
      plannedSteps: [claimedStep('provider.fake')],
    } as ClaimedAuthorityJob,
  });
  assert.equal(mismatchJob.status, 'fail');
  assert.equal(mismatchJob.stopReason, 'claimed-job-story-mismatch', 'a claimed job whose storyId differs from --storyId must be refused');
  assert.equal(mismatchJob.claimedJobExecution, null, 'a mismatched job must not be executed');

  // --- Claimed authority job FILE entry point (CLI/live seam) ----------------
  // The in-process tests above pass options.claimedJob directly. The live entry
  // point is `--jobFile=<path>`: the executor loads + validates a claimed job
  // file and consumes its typed plannedSteps[] instead of synthesizing local
  // argv steps. These checks pin the file-loading seam in-process and via the
  // real CLI binary.
  function writeJobFile(name: string, contents: unknown): string {
    const path = join(root, name);
    writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
    return path;
  }

  const fileJobRequests: AutopilotCommandRequest[] = [];
  const doneJobFile = writeJobFile('claimed-job-done.json', {
    jobId: 'job-file-done',
    storyId: 'B-auto',
    mode: 'authority',
    until: 'DONE',
    plannedSteps: [
      claimedStep('lattice.command', { args: { operation: 'story.resolve' } }),
      claimedStep('provider.fake'),
      claimedStep('gate.evaluate'),
    ],
  });
  const fileDone = executeAutopilot({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'DONE', maxSteps: 20, jobFile: doneJobFile },
    env: READY_AUTHORITY_ENV,
    runner: passingRunner(fileJobRequests),
  });
  assert.equal(fileDone.status, 'fail', 'a claimed job file targeting DONE without a verified receipt must fail closed');
  assert.equal(fileDone.stopReason, 'authority-job-blocked');
  assert.equal(fileDone.authorityDone, false, 'consuming a claimed job file must never self-claim authority DONE');
  assert.equal(fileDone.claimedJobExecution?.jobId, 'job-file-done', 'the loaded job identity must flow through to consumption');
  assert.equal(fileDone.claimedJobExecution?.disposition, 'blocked');
  assert.equal(fileDone.claimedJobExecution?.execution?.status, 'blocked');
  assert.equal(fileJobRequests.length, 0, 'claimed job-file plannedSteps must not invoke the local argv runner');
  assert.equal(fileDone.executedSteps.length, 0, 'claimed job-file path records execution under claimedJobExecution, not executedSteps');
  assert(
    (fileDone.claimedJobExecution?.execution?.steps ?? []).some(step => step.stepId.startsWith('cstep-')),
    'execution must consume the claimed job typed plannedSteps[], not synthesized local steps',
  );

  // A missing job file fails closed before any execution.
  const missingFile = executeAutopilot({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'DONE', maxSteps: 20, jobFile: join(root, 'does-not-exist.json') },
    env: READY_AUTHORITY_ENV,
    runner: passingRunner([]),
  });
  assert.equal(missingFile.status, 'fail');
  assert.equal(missingFile.stopReason, 'claimed-job-file-invalid', 'an unreadable claimed job file must fail closed');
  assert.equal(missingFile.claimedJobExecution, null, 'an invalid job file must not reach the executor');

  // Malformed JSON / wrong shape also fails closed (no fallback to local argv).
  const malformedFile = writeJobFile('claimed-job-malformed.json', '{ not json');
  const malformed = executeAutopilot({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'DONE', maxSteps: 20, jobFile: malformedFile },
    env: READY_AUTHORITY_ENV,
    runner: passingRunner([]),
  });
  assert.equal(malformed.status, 'fail');
  assert.equal(malformed.stopReason, 'claimed-job-file-invalid');

  const badShapeFile = writeJobFile('claimed-job-badshape.json', { jobId: 'x', storyId: 'B-auto', mode: 'authority', until: 'NOPE', plannedSteps: [] });
  const badShape = executeAutopilot({
    store,
    root,
    args: { mode: 'authority', storyId: 'B-auto', until: 'DONE', maxSteps: 20, jobFile: badShapeFile },
    env: READY_AUTHORITY_ENV,
    runner: passingRunner([]),
  });
  assert.equal(badShape.status, 'fail');
  assert.equal(badShape.stopReason, 'claimed-job-file-invalid', 'an invalid job envelope (bad until) must fail closed');

  // --- Main CLI registry integration ---------------------------------------
  // Everything above drives the executor in-process (executeAutopilot /
  // createAutopilotHandlers). That proves executor behavior but NOT that the main
  // `lattice` registry actually routes `autopilot execute` / `autopilot doctor`
  // to the bounded executor. registry.ts registers the autopilot handlers
  // missing-only, so a routing regression (e.g. another batch shadowing the
  // name, or the batch dropping) would be invisible to the in-process checks.
  // These assertions reuse the same temp root (seeded story B-auto + config) and
  // run the real compiled CLI binary to pin the current integration boundary.
  const cliExecuteLocal = runCli(['lattice', 'autopilot', 'execute', '--mode=local', '--storyId=B-auto', '--until=TEST', '--dryRun', '--json']);
  assert.equal(cliExecuteLocal.schemaVersion, 'lattice.autopilot_execute.v1', 'main CLI must route `autopilot execute` to the bounded executor');
  assert.equal(cliExecuteLocal.dryRun, true);
  assert.equal(cliExecuteLocal.status, 'pass');
  assert.equal(cliExecuteLocal.stopReason, 'dry-run');
  assert.equal(cliExecuteLocal.story.exists, true, 'CLI execute must resolve the seeded story through the shared root');
  assert.equal(cliExecuteLocal.authorityDone, false, 'local execute must never claim authority DONE through the CLI');

  const cliDoctor = runCli(['lattice', 'autopilot', 'doctor', '--json']);
  assert.equal(cliDoctor.schemaVersion, 'lattice.autopilot_doctor.v1', 'main CLI must route `autopilot doctor` to the autopilot surface');
  assert.equal(cliDoctor.ok, true);

  // Authority DONE must fail closed through the real CLI: without a configured
  // live Authority runner there is no server-backed claim/evidence/receipt loop
  // and therefore no Authority DONE. This is the durable current-behavior
  // boundary for --mode=authority without --jobFile.
  const cliAuthorityDone = runCli(
    ['lattice', 'autopilot', 'execute', '--mode=authority', '--storyId=B-auto', '--until=DONE', '--json'],
    NOT_READY_AUTHORITY_ENV,
  );
  assert.equal(cliAuthorityDone.schemaVersion, 'lattice.autopilot_execute.v1');
  assert.equal(cliAuthorityDone.status, 'fail');
  assert.equal(cliAuthorityDone.stopReason, 'authority-live-runner-not-configured');
  assert.equal(cliAuthorityDone.authorityDone, false, 'CLI authority DONE must fail closed without a verified receipt');
  assert.equal(cliAuthorityDone.fullAuthorityDone, false);
  assert.equal(cliAuthorityDone.receiptRequired, true);

  // With --jobFile, the real CLI consumes a claimed Authority job's typed
  // plannedSteps[] through the bounded executor instead of synthesizing local
  // argv steps. Authority DONE still fails closed without a verified receipt
  // (the gate.evaluate step blocks), proving the live entry point does not
  // weaken the receipt gate.
  writeFileSync(join(root, 'cli-claimed-job-done.json'), JSON.stringify({
    jobId: 'cli-job-done',
    storyId: 'B-auto',
    mode: 'authority',
    until: 'DONE',
    plannedSteps: [
      claimedStep('lattice.command', { args: { operation: 'story.resolve' } }),
      claimedStep('provider.fake'),
      claimedStep('gate.evaluate'),
    ],
  }));
  const cliJobDone = runCli(
    ['lattice', 'autopilot', 'execute', '--mode=authority', '--storyId=B-auto', '--until=DONE', '--jobFile=cli-claimed-job-done.json', '--json'],
    READY_AUTHORITY_ENV,
  );
  assert.equal(cliJobDone.schemaVersion, 'lattice.autopilot_execute.v1');
  assert.equal(cliJobDone.status, 'fail', 'CLI claimed-job DONE must fail closed without a verified receipt');
  assert.equal(cliJobDone.stopReason, 'authority-job-blocked', 'CLI --jobFile DONE must block at gate.evaluate, not synthesize local steps');
  assert.equal(cliJobDone.authorityDone, false);
  assert.equal(cliJobDone.claimedJobExecution?.jobId, 'cli-job-done', 'CLI must load and consume the claimed job from --jobFile');
  assert.equal(cliJobDone.claimedJobExecution?.disposition, 'blocked');
  assert.equal(cliJobDone.executedSteps.length, 0, 'CLI claimed-job path records execution under claimedJobExecution, not local executedSteps');

  // A non-DONE claimed job (authority + TEST) completes cleanly through the CLI
  // without claiming production DONE.
  writeFileSync(join(root, 'cli-claimed-job-test.json'), JSON.stringify({
    jobId: 'cli-job-test',
    storyId: 'B-auto',
    mode: 'authority',
    until: 'TEST',
    plannedSteps: [
      claimedStep('lattice.command', { args: { operation: 'story.resolve' } }),
      claimedStep('provider.fake'),
      claimedStep('gate.evaluate'),
      claimedStep('stop.summary'),
    ],
  }));
  const cliJobTest = runCli(
    ['lattice', 'autopilot', 'execute', '--mode=authority', '--storyId=B-auto', '--until=TEST', '--jobFile=cli-claimed-job-test.json', '--json'],
    READY_AUTHORITY_ENV,
  );
  assert.equal(cliJobTest.status, 'pass', 'an all-passing non-DONE claimed job completes through the CLI');
  assert.equal(cliJobTest.stopReason, 'authority-job-completed');
  assert.equal(cliJobTest.claimedJobExecution?.disposition, 'completed');
  assert.equal(cliJobTest.authorityDone, false, 'a non-DONE target never claims authority DONE through the CLI');

  // An invalid --jobFile fails closed through the CLI with no fallback to local
  // argv synthesis.
  const cliBadJob = runCli(
    ['lattice', 'autopilot', 'execute', '--mode=authority', '--storyId=B-auto', '--until=DONE', '--jobFile=does-not-exist.json', '--json'],
    READY_AUTHORITY_ENV,
  );
  assert.equal(cliBadJob.status, 'fail');
  assert.equal(cliBadJob.stopReason, 'claimed-job-file-invalid', 'an unreadable --jobFile must fail closed through the CLI');
  assert.equal(cliBadJob.claimedJobExecution, null);

  runHandlerRootConfigProbe();

  // --- Global installed `lattice` entrypoint (baseline: global entrypoints usable) ---
  // Everything above drives the *worktree* compiled CLI (cliPath). The baseline also
  // claims the GLOBAL installed `lattice` entrypoint on PATH remains usable. This is an
  // ENVIRONMENTAL probe, not a worktree artifact, so it must NEVER falsely pass:
  //   - global lattice ABSENT (ENOENT)                 -> explicit SKIP marker, no pass
  //   - global lattice present but the command is
  //     unrecognized / non-zero / non-JSON (e.g. an
  //     older installed version)                       -> explicit BLOCKED marker, no pass
  //   - global lattice present AND returns valid JSON  -> assert the read-only autopilot
  //     status invariants (real pass). An overclaim here (authorityDone/fullAuthorityDone
  //     true from a no-network status) is a genuine regression and DOES fail the smoke.
  // Runs from a neutral empty temp cwd (no config / no story) so it cannot couple to this
  // worktree or to main, and `autopilot status` is read-only with zero network.
  runGlobalLatticeEntrypointProbe();
} finally {
  rmSync(root, { recursive: true, force: true });
  resetConfigCache();
}

function runGlobalLatticeEntrypointProbe(): void {
  const probeCwd = mkdtempSync(join(tmpdir(), 'lattice-global-probe-'));
  try {
    let stdout: string;
    try {
      // PATH-resolved `lattice` from a cwd outside the repo == the global install
      // (the worktree's node_modules/.bin is not on PATH here).
      stdout = execFileSync('lattice', ['autopilot', 'status', '--json'], {
        cwd: probeCwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { status?: number; stderr?: Buffer | string };
      if (err.code === 'ENOENT') {
        console.log('ℹ global `lattice` entrypoint probe SKIPPED: no global lattice on PATH (not a worktree artifact; not counted as pass)');
        return;
      }
      const detail = (err.stderr ? String(err.stderr) : err.message).split('\n')[0];
      console.log(`⚠ global \`lattice\` entrypoint probe BLOCKED: global lattice present but \`autopilot status --json\` did not succeed (exit=${err.status ?? 'n/a'}: ${detail}). Treated as blocked, NOT pass.`);
      return;
    }

    // Tolerate leading log lines: parse from the first JSON object boundary.
    const start = stdout.indexOf('{');
    if (start < 0) {
      console.log('⚠ global `lattice` entrypoint probe BLOCKED: global lattice emitted no JSON object for `autopilot status --json` (older/incompatible install). Treated as blocked, NOT pass.');
      return;
    }
    let status: any;
    try {
      status = JSON.parse(stdout.slice(start));
    } catch {
      console.log('⚠ global `lattice` entrypoint probe BLOCKED: global lattice `autopilot status --json` output was not parseable JSON (older/incompatible install). Treated as blocked, NOT pass.');
      return;
    }

    // Present + valid JSON: pin the read-only invariants. An overclaim is a real failure.
    assert.equal(status.schemaVersion, 'lattice.autopilot_status.v1', 'global lattice must route `autopilot status` to the autopilot status surface');
    assert.equal(status.localWorkflowUsable, true, 'global lattice must report the local workflow as usable (baseline: global entrypoint usable)');
    assert.equal(status.authorityDone, false, 'a no-network global `autopilot status` must never claim authority DONE');
    assert.equal(status.fullAuthorityDone, false, 'a no-network global `autopilot status` must never claim full authority DONE');
    assert.equal(status.multiHostVerified, false, 'a no-network global `autopilot status` must never claim multi-host verification');
    console.log('✓ global `lattice` entrypoint probe PASSED: `autopilot status --json` usable and never overclaims authority DONE');
  } finally {
    rmSync(probeCwd, { recursive: true, force: true });
  }
}

function runHandlerRootConfigProbe(): void {
  const probeRoot = mkdtempSync(join(tmpdir(), 'lattice-autopilot-handler-root-'));
  try {
    writeConfig(probeRoot);
    const probeStore = new StoryStore(probeRoot);
    seedStory(probeStore);
    const probeHandlers = createAutopilotHandlers({
      root: probeRoot,
      scanRoot: 'packages/main',
      store: probeStore,
      autopilotCommandRunner: passingRunner([]),
    });
    mkdirSync(join(probeRoot, '.lattice'), { recursive: true });
    writeFileSync(join(probeRoot, '.lattice', 'authority.md'), [
      'serverUrl: https://authority-root-autopilot.example',
      'customerApiKey: root-customer-key',
      'actorKey: root-actor-key',
      'runnerId: root-runner',
      'sessionId: root-session',
      'projectId: root-project',
    ].join('\n'));
    const handledStatus = probeHandlers.autopilot_status({ json: true }) as any;
    assert.equal(handledStatus.authorityReady, true, 'autopilot_status handler reads authority.md from ctx.root');
    const handledRun = probeHandlers.autopilot_run({ mode: 'authority', until: 'DONE', dryRun: true, json: true }) as any;
    assert.deepEqual(handledRun.authority.readinessWarnings, [], 'autopilot_run handler reads authority.md from ctx.root');
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
    resetConfigCache();
  }
}

console.log(PASS_LINE);
