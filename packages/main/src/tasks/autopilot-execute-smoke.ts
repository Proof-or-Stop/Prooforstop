#!/usr/bin/env node
/**
 * Smoke coverage for the true Lattice autopilot executor loop:
 * - execute is separate from run/projection.
 * - local mode runs argv-mapped Lattice commands without shell parsing.
 * - authority DONE without a verified receipt fails closed before execution.
 * - Claude Code CLI repair is disabled by default and only runs when explicit.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeAutopilot,
  type AutopilotCommandRequest,
  type AutopilotCommandResult,
  type AutopilotCommandRunner,
} from '../core/autopilot-executor.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import { createAutopilotHandlers } from '../handlers/autopilot.js';

const PASS_LINE =
  '✓ autopilot execute smoke passed: local executor, authority fail-closed, and explicit Claude repair verified';

type EnvOverride = Record<string, string | undefined>;

const READY_AUTHORITY_ENV: EnvOverride = {
  LATTICE_AUTHORITY_MODE: 'enforce',
  LATTICE_AUTHORITY_URL: 'https://authority.test',
  LATTICE_AUTHORITY_ACTOR_KEY: 'test-actor-key',
  LATTICE_AUTHORITY_RUNNER_ID: 'runner-1',
};

function writeConfig(root: string): void {
  writeFileSync(join(root, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.koala/story/actives',
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

const root = mkdtempSync(join(tmpdir(), 'lattice-autopilot-execute-'));
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
    env: READY_AUTHORITY_ENV,
    runner: passingRunner(authorityRequests),
  });
  assert.equal(authorityDoneWithoutReceipt.status, 'fail');
  assert.equal(authorityDoneWithoutReceipt.stopReason, 'authority-not-ready');
  assert.equal(authorityDoneWithoutReceipt.receiptRequired, true);
  assert.equal(authorityDoneWithoutReceipt.receipt.verified, false);
  assert.equal(authorityDoneWithoutReceipt.authorityDone, false, 'blocked authority execute must not claim authority DONE');
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
} finally {
  rmSync(root, { recursive: true, force: true });
  resetConfigCache();
}

console.log(PASS_LINE);
