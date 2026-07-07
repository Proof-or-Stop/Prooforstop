#!/usr/bin/env node

/**
 * Smoke: story-scoped validate executions are mutually exclusive without
 * turning the lock into a global workflow bottleneck.
 *
 * Coverage:
 *  - same story + same worktree: a second validate fails before entering the
 *    configured validation command;
 *  - same-story evidence persistence remains inside the validate lock after the
 *    validation command exits, so an overlapping newer validate cannot enter
 *    and then be overwritten by older post-command persistence;
 *  - different story worktrees: validates can still run at the same time;
 *  - reviewer and delivery metadata writes are not blocked while validate holds
 *    its lock;
 *  - story_advance REVIEW→TEST can run its internal validate gate without
 *    self-deadlocking;
 *  - done_required_validate shares the same story execution lock with validate;
 *  - stale locks are reclaimed, vanished or mismatched holders are stale, and
 *    same async-context nesting is reentrant without letting a concurrent async
 *    sibling pass through.
 *
 * Run:
 *   node packages/main/dist/tasks/validate-execution-lock-smoke.js
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import {
  VALIDATION_EXECUTION_LOCK_HEARTBEAT_FILE,
  validationExecutionLockPath,
  withValidationExecutionLock,
} from '../core/validation-execution-lock.js';
import { MKDIR_LOCK_HOLDER_FILE } from '../core/mkdir-lock.js';

const DEFAULT_STORY_ID = 'B-validate-lock';
const NOW = '2026-06-24T00:00:00.000Z';

type ChildResult = {
  code: number | null;
  output: string;
};

type SpawnedChild = {
  child: ReturnType<typeof spawn>;
  done: Promise<ChildResult>;
};

type FixtureOptions = {
  storyId?: string;
  phase?: StoryInfo['phase'];
  priority?: StoryInfo['priority'];
  workflowProfile?: 'light' | 'balanced' | 'strict';
  doneRequired?: boolean;
};

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
}

function cliPath(): string {
  return join(repoRoot(), 'bin/lattice.js');
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'validate-lock-smoke',
      GIT_AUTHOR_EMAIL: 'validate-lock-smoke@example.test',
      GIT_COMMITTER_NAME: 'validate-lock-smoke',
      GIT_COMMITTER_EMAIL: 'validate-lock-smoke@example.test',
    },
  });
}

function commitAll(root: string, message: string): void {
  git(root, ['add', '.']);
  git(root, ['commit', '-m', message]);
}

function story(
  storyId: string,
  phase: StoryInfo['phase'] = 'TEST',
  priority: StoryInfo['priority'] = 'high',
): StoryInfo {
  return {
    storyId,
    name: 'validate-execution-lock-smoke',
    title: 'validate execution lock smoke',
    description: 'Hermetic story used to prove validate execution lock behavior.',
    type: 'bug',
    phase,
    priority,
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    riskSignals: [],
    ...(phase === 'REVIEW' ? { currentReviewRound: NOW } : {}),
    events: [{ phase, action: 'advance', timestamp: NOW }],
  } as StoryInfo;
}

function checklist(): ChecklistData {
  return {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic lock smoke item',
      context: 'Synthetic context for validation lock smoke coverage.',
      status: 'done',
      startTime: NOW,
      endTime: NOW,
    }],
  };
}

function enteredCount(root: string): number {
  const path = join(root, 'entered.log');
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForEntered(root: string, count: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (enteredCount(root) >= count) return true;
    await sleep(25);
  }
  return enteredCount(root) >= count;
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await sleep(25);
  }
  return existsSync(path);
}

function spawnCommand(root: string, args: string[], label: string, extraEnv: Record<string, string> = {}): SpawnedChild {
  const child = spawn(process.execPath, [cliPath(), ...args], {
    cwd: root,
    env: {
      ...process.env,
      LATTICE_IDLE_TIMEOUT_MS: '300000',
      LATTICE_PROJECT_ROOT: root,
      LATTICE_VALIDATE_LOCK_SMOKE_LABEL: label,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const done = new Promise<ChildResult>((resolveDone) => {
    child.on('close', (code) => resolveDone({ code, output }));
    child.on('error', (error) => resolveDone({ code: null, output: `${output}\n${error.message}` }));
  });
  return { child, done };
}

function spawnValidate(root: string, storyId: string, label: string, extraEnv: Record<string, string> = {}): SpawnedChild {
  return spawnCommand(root, ['validate', `--story=${storyId}`, '--json'], label, extraEnv);
}

async function waitChild(proc: SpawnedChild, timeoutMs: number): Promise<ChildResult> {
  const timeout = sleep(timeoutMs).then(() => {
    proc.child.kill('SIGKILL');
    return { code: null, output: `timed out waiting for child pid ${proc.child.pid}` };
  });
  return Promise.race([proc.done, timeout]);
}

async function runLattice(root: string, command: string, args: Record<string, unknown>): Promise<string> {
  const proc = spawnCommand(root, [command, JSON.stringify(args)], command);
  const result = await waitChild(proc, 10000);
  if (result.code !== 0) {
    throw new Error(`${command} exited ${result.code}:\n${result.output}`);
  }
  return result.output;
}

function extractReviewRunId(output: string): string {
  const match = output.match(/B-[^:\s]+:RR-\d+/);
  assert.ok(match?.[0], `expected review run id in output: ${output}`);
  return match![0];
}

function setupFixture(options: FixtureOptions = {}): { root: string; storyId: string } {
  const storyId = options.storyId ?? DEFAULT_STORY_ID;
  const root = mkdtempSync(join(tmpdir(), 'lattice-validate-lock-'));
  write(root, '.gitignore', [
    'entered.log',
    'release',
    '.lattice/activity.jsonl',
    '.lattice/locks/',
    '',
  ].join('\n'));
  const validateCommand = {
    label: 'lock-probe',
    command: process.execPath,
    args: ['validate-probe.mjs'],
    timeoutMs: 10000,
  };
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    ...(options.workflowProfile ? { workflow: { profile: options.workflowProfile } } : {}),
    validate: { commands: [validateCommand] },
    ...(options.doneRequired ? { doneRequiredCommands: [validateCommand] } : {}),
  }, null, 2) + '\n');
  write(root, 'validate-probe.mjs', `
import { appendFileSync, existsSync } from 'node:fs';
const label = process.env.LATTICE_VALIDATE_LOCK_SMOKE_LABEL || 'unlabeled';
appendFileSync('entered.log', label + ' ' + String(process.pid) + ' ' + Date.now() + '\\n');
const deadline = Date.now() + 8000;
while (!existsSync('release')) {
  if (Date.now() > deadline) process.exit(12);
  await new Promise((resolve) => setTimeout(resolve, 25));
}
console.log('probe ' + label + ' passed');
`);
  write(root, 'packages/main/src/index.ts', 'export const validateLockSmoke = true;\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  commitAll(root, 'seed validate lock fixture');

  const store = new StoryStore(root);
  store.writeStory(storyId, story(storyId, options.phase ?? 'TEST', options.priority ?? 'high'));
  store.writeChecklist(storyId, checklist());
  commitAll(root, 'seed story metadata');
  return { root, storyId };
}

function release(root: string): void {
  writeFileSync(join(root, 'release'), 'release\n', 'utf8');
}

async function assertSameStoryMutualExclusion(): Promise<void> {
  const { root, storyId } = setupFixture();
  try {
    const first = spawnValidate(root, storyId, 'first');
    const firstEntered = await waitForEntered(root, 1, 4000);
    if (!firstEntered) {
      release(root);
      const firstResult = await waitChild(first, 4000);
      assert.fail([
        'precondition: first validate command entered the probe',
        `firstExit=${firstResult.code}`,
        `firstOutput=${firstResult.output.slice(0, 2000)}`,
      ].join('\n'));
    }

    const second = spawnValidate(root, storyId, 'second');
    const secondEnteredBeforeRelease = await waitForEntered(root, 2, 1500);
    const secondResult = await waitChild(second, 4000);

    release(root);
    const firstResult = await waitChild(first, 12000);

    assert.equal(firstResult.code, 0, firstResult.output);
    assert.notEqual(secondResult.code, 0, 'contending validate must fail before running validation command');
    assert.match(secondResult.output, /validation execution|already running|is blocked/);
    assert.equal(
      secondEnteredBeforeRelease,
      false,
      [
        'second validate entered the validation command before the first validate released',
        `enteredCount=${enteredCount(root)}`,
        `firstExit=${firstResult.code}`,
        `secondExit=${secondResult.code}`,
        `firstOutput=${firstResult.output.slice(0, 1000)}`,
        `secondOutput=${secondResult.output.slice(0, 1000)}`,
      ].join('\n'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertPostCommandPersistenceHoldsLock(): Promise<void> {
  const { root, storyId } = setupFixture({ storyId: 'B-validate-evidence-race' });
  const holdFile = join(root, 'post-command.hold');
  const readyFile = join(root, 'post-command.ready');
  try {
    writeFileSync(holdFile, 'hold older validate after its command exits\n', 'utf8');
    const older = spawnValidate(root, storyId, 'older-post-command', {
      LATTICE_VALIDATE_LOCK_SMOKE_POST_COMMAND_HOLD_FILE: holdFile,
      LATTICE_VALIDATE_LOCK_SMOKE_POST_COMMAND_READY_FILE: readyFile,
      LATTICE_VALIDATE_LOCK_SMOKE_POST_COMMAND_TIMEOUT_MS: '12000',
    });
    const olderEntered = await waitForEntered(root, 1, 4000);
    if (!olderEntered) {
      rmSync(holdFile, { force: true });
      release(root);
      const olderResult = await waitChild(older, 4000);
      assert.fail([
        'precondition: older validate command entered before post-command hold',
        `olderExit=${olderResult.code}`,
        `olderOutput=${olderResult.output.slice(0, 2000)}`,
      ].join('\n'));
    }

    release(root);
    assert.equal(
      await waitForFile(readyFile, 4000),
      true,
      'older validate must reach the post-command pre-persistence hold',
    );

    const newer = spawnValidate(root, storyId, 'newer-post-command');
    const newerResult = await waitChild(newer, 5000);

    assert.notEqual(newerResult.code, 0, 'newer validate must be blocked until older evidence persistence finishes');
    assert.match(newerResult.output, /validation execution|already running|is blocked/);
    assert.equal(
      enteredCount(root),
      1,
      'newer validate must not enter the validation command while older validate is between command exit and evidence persistence',
    );

    rmSync(holdFile, { force: true });
    const olderResult = await waitChild(older, 12000);
    assert.equal(olderResult.code, 0, olderResult.output);

    const evidence = new StoryStore(root).readTestEvidence(storyId);
    assert.ok(evidence, 'older validate must persist test evidence after the post-command hold releases');
    assert.match(evidence.output, /probe older-post-command passed/);
    assert.doesNotMatch(evidence.output, /probe newer-post-command passed/);
  } finally {
    rmSync(holdFile, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDifferentWorktreesCanValidateConcurrently(): Promise<void> {
  const firstFixture = setupFixture({ storyId: 'B-validate-a' });
  const secondFixture = setupFixture({ storyId: 'B-validate-b' });
  try {
    const first = spawnValidate(firstFixture.root, firstFixture.storyId, 'parallel-a');
    const second = spawnValidate(secondFixture.root, secondFixture.storyId, 'parallel-b');
    assert.equal(await waitForEntered(firstFixture.root, 1, 4000), true, 'first worktree validate entered');
    assert.equal(await waitForEntered(secondFixture.root, 1, 4000), true, 'second worktree validate entered');

    release(firstFixture.root);
    release(secondFixture.root);
    const [firstResult, secondResult] = await Promise.all([
      waitChild(first, 12000),
      waitChild(second, 12000),
    ]);
    assert.equal(firstResult.code, 0, firstResult.output);
    assert.equal(secondResult.code, 0, secondResult.output);
  } finally {
    rmSync(firstFixture.root, { recursive: true, force: true });
    rmSync(secondFixture.root, { recursive: true, force: true });
  }
}

async function assertReviewerWritesAreNotBlocked(): Promise<void> {
  const { root, storyId } = setupFixture({ storyId: 'B-validate-review', phase: 'REVIEW' });
  try {
    const validate = spawnValidate(root, storyId, 'review-holder');
    assert.equal(await waitForEntered(root, 1, 4000), true, 'validate must hold the execution lock');

    const reviewRunOutput = await runLattice(root, 'review_run_start', {
      storyId,
      agent: 'lattice-review-quality',
    });
    const reviewRunId = extractReviewRunId(reviewRunOutput);
    await runLattice(root, 'review_pass_set', {
      storyId,
      agent: 'lattice-review-quality',
      reviewRunId,
      note: 'lattice-review-quality checked validate lock scope and found no blocker.',
    });

    const passes = new StoryStore(root).readReviewPasses(storyId).passes;
    assert.equal(passes.length, 1, 'review_pass_set should persist while validate lock is held');

    release(root);
    await waitChild(validate, 12000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDeliveryCheckSetIsNotBlocked(): Promise<void> {
  const { root, storyId } = setupFixture({ storyId: 'B-validate-delivery', phase: 'TEST' });
  try {
    const validate = spawnValidate(root, storyId, 'delivery-holder');
    assert.equal(await waitForEntered(root, 1, 4000), true, 'validate must hold the execution lock');

    await runLattice(root, 'delivery_check_set', {
      storyId,
      agentId: 'lattice-review-delivery',
      docsPromises: [{
        docPath: 'README.md',
        promise: 'Synthetic delivery promise is checked by this smoke.',
        status: 'verified',
        verifiedBy: 'validate-execution-lock-smoke',
        evidence: 'delivery_check_set completed while validate was still waiting on release',
      }],
      realMachineTests: [{
        featureId: 'CHK-001',
        transcript: 'Synthetic real-machine transcript for delivery lock scope smoke.',
      }],
      closingSelfCheck: {
        hasRealMachineTest: true,
        hasEdgeCaseCoverage: true,
        hasUnresolvedTodos: false,
        summary: 'Delivery check metadata write is independent from validate execution lock.',
      },
    });

    const delivery = new StoryStore(root).readDeliveryCheck(storyId);
    assert.ok(delivery, 'delivery_check_set should persist while validate lock is held');
    assert.equal(delivery?.agentId, 'lattice-review-delivery');

    release(root);
    const validateResult = await waitChild(validate, 12000);
    assert.equal(validateResult.code, 0, validateResult.output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertStoryAdvanceInternalValidateDoesNotSelfLock(): Promise<void> {
  const { root, storyId } = setupFixture({
    storyId: 'B-advance-validate',
    phase: 'REVIEW',
    priority: 'medium',
    workflowProfile: 'light',
  });
  try {
    const advance = spawnCommand(root, [
      'story_advance',
      JSON.stringify({ storyId, phase: 'TEST' }),
    ], 'story-advance-test');

    const internalValidateEntered = await waitForEntered(root, 1, 4000);
    if (!internalValidateEntered) {
      release(root);
      const earlyResult = await waitChild(advance, 4000);
      assert.fail([
        'story_advance did not enter its internal validate command',
        `exit=${earlyResult.code}`,
        `output=${earlyResult.output.slice(0, 2000)}`,
      ].join('\n'));
    }

    release(root);
    const result = await waitChild(advance, 12000);
    assert.equal(result.code, 0, result.output);

    const store = new StoryStore(root);
    assert.equal(store.readStory(storyId).phase, 'TEST', 'story_advance should persist TEST phase');
    assert.equal(store.readTestEvidence(storyId)?.result, 'PASS', 'story_advance internal validate should write PASS test evidence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDoneRequiredSharesValidateLock(): Promise<void> {
  const { root, storyId } = setupFixture({ storyId: 'B-validate-required', doneRequired: true });
  try {
    const validate = spawnValidate(root, storyId, 'done-required-holder');
    assert.equal(await waitForEntered(root, 1, 4000), true, 'validate must enter before done_required_validate starts');

    const doneRequired = spawnCommand(root, [
      'done_required_validate',
      JSON.stringify({ storyId, json: true }),
    ], 'done-required-contender');
    const doneRequiredResult = await waitChild(doneRequired, 5000);

    assert.equal(enteredCount(root), 1, 'done_required_validate must not enter the validation command while validate is held');
    assert.notEqual(doneRequiredResult.code, 0, 'done_required_validate must fail on live validate lock contention');
    assert.match(doneRequiredResult.output, /validation execution|already running|is blocked/);

    release(root);
    const validateResult = await waitChild(validate, 12000);
    assert.equal(validateResult.code, 0, validateResult.output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertStaleLockReclaimed(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-validate-lock-stale-'));
  const storyId = 'B-stale';
  try {
    const lockDir = validationExecutionLockPath(root, storyId);
    mkdirSync(lockDir, { recursive: true });
    const old = new Date(Date.now() - 5000);
    utimesSync(lockDir, old, old);
    let ran = false;
    await withValidationExecutionLock({
      root,
      storyId,
      workspaceRoot: root,
      command: 'validate',
      staleMs: 50,
    }, () => {
      ran = true;
    });
    assert.equal(ran, true, 'stale validation lock should be reclaimed');
    assert.equal(existsSync(lockDir), false, 'validation lock should release after reclaimed run');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function processStartTimeMs(): number {
  return Math.floor(Date.now() - (process.uptime() * 1000));
}

function writeLockOwner(root: string, storyId: string, holder: Record<string, unknown>, heartbeat?: Record<string, unknown>): string {
  const lockDir = validationExecutionLockPath(root, storyId);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, MKDIR_LOCK_HOLDER_FILE), JSON.stringify(holder, null, 2) + '\n', 'utf8');
  if (heartbeat) {
    writeFileSync(join(lockDir, VALIDATION_EXECUTION_LOCK_HEARTBEAT_FILE), JSON.stringify(heartbeat, null, 2) + '\n', 'utf8');
  }
  const now = new Date();
  utimesSync(lockDir, now, now);
  return lockDir;
}

async function assertVanishedOwnerReclaimed(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-validate-lock-vanished-'));
  const storyId = 'B-vanished';
  try {
    const lockDir = writeLockOwner(root, storyId, {
      lockId: 'vanished-owner',
      pid: 999_999_999,
      hostname: hostname(),
      command: 'validate for B-vanished',
      acquiredAt: new Date().toISOString(),
      processStartTimeMs: processStartTimeMs() - 60_000,
    });
    let ran = false;
    await withValidationExecutionLock({
      root,
      storyId,
      workspaceRoot: root,
      command: 'validate',
      staleMs: 60000,
    }, () => {
      ran = true;
    });
    assert.equal(ran, true, 'fresh lock with vanished same-host pid should be reclaimed');
    assert.equal(existsSync(lockDir), false, 'vanished-owner lock should release after reclaimed run');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertMismatchedOwnerReclaimed(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-validate-lock-mismatch-'));
  const storyId = 'B-mismatch';
  const startMs = processStartTimeMs();
  try {
    const lockDir = writeLockOwner(root, storyId, {
      lockId: 'old-owner',
      pid: process.pid,
      hostname: hostname(),
      command: 'validate for B-mismatch',
      acquiredAt: new Date().toISOString(),
      processStartTimeMs: startMs,
    }, {
      lockId: 'different-owner',
      pid: process.pid,
      hostname: hostname(),
      processStartTimeMs: startMs,
      heartbeatAt: new Date().toISOString(),
    });
    let ran = false;
    await withValidationExecutionLock({
      root,
      storyId,
      workspaceRoot: root,
      command: 'validate',
      staleMs: 60000,
    }, () => {
      ran = true;
    });
    assert.equal(ran, true, 'fresh lock with mismatched owner/heartbeat identity should be reclaimed');
    assert.equal(existsSync(lockDir), false, 'mismatched-owner lock should release after reclaimed run');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertReentrantButNotSiblingBypass(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-validate-lock-unit-'));
  const storyId = 'B-reentrant';
  const options = { root, storyId, workspaceRoot: root, command: 'validate', staleMs: 60000 };
  try {
    let nestedEntries = 0;
    await withValidationExecutionLock(options, async () => {
      nestedEntries += 1;
      await withValidationExecutionLock(options, () => {
        nestedEntries += 1;
      });
    });
    assert.equal(nestedEntries, 2, 'same async-context nested validate lock should be reentrant');

    let releaseHolder: () => void = () => {};
    const holder = withValidationExecutionLock(options, async () => {
      await new Promise<void>((resolveHolder) => {
        releaseHolder = resolveHolder;
      });
    });
    try {
      await sleep(50);
      await assert.rejects(
        () => withValidationExecutionLock(options, () => undefined),
        /validation execution|is blocked/,
        'concurrent async sibling must contend on the on-disk validation lock',
      );
    } finally {
      releaseHolder();
      await holder;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void (async () => {
  try {
    await assertSameStoryMutualExclusion();
    await assertPostCommandPersistenceHoldsLock();
    await assertDifferentWorktreesCanValidateConcurrently();
    await assertReviewerWritesAreNotBlocked();
    await assertDeliveryCheckSetIsNotBlocked();
    await assertStoryAdvanceInternalValidateDoesNotSelfLock();
    await assertDoneRequiredSharesValidateLock();
    await assertStaleLockReclaimed();
    await assertVanishedOwnerReclaimed();
    await assertMismatchedOwnerReclaimed();
    await assertReentrantButNotSiblingBypass();
    console.log('validate-execution-lock smoke passed: 11 assertions');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
})();
