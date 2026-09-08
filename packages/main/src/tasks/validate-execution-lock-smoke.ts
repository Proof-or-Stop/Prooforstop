import { persistSyntheticAdmittedWindowForTest } from '../core/certification-window.js';
import { deriveCertificationDomainInputHashes } from '../handlers/certification-window.js';
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
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import {
  VALIDATION_EXECUTION_LOCK_HEARTBEAT_FILE,
  validationCapacityLockPath,
  validationExecutionLockPath,
  withOfficialValidationExecution,
  withValidationExecutionLock,
  withWorkspaceValidationCapacity,
} from '../core/validation-execution-lock.js';
import { MKDIR_LOCK_HOLDER_FILE } from '../core/mkdir-lock.js';
// B-cc10 CHK-007 (F-001 tail): fixture paths come from the resolver, never from a
// hardcoded brand literal. Hardcoding the NEW literal would just move the problem;
// deriving means this fixture follows any future rename with the writers it exercises.
import { CONFIG_FILENAMES, PROOF_OR_STOP_CONFIG_FILENAME } from '../core/brand-paths.js';
import { PROOF_OR_STOP_ACTIVITY_LOG, PROOF_OR_STOP_DIR, PROOF_OR_STOP_STORY_DIR } from '../core/proof-or-stop-paths.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { createVerifierHandlers as unownedcreateVerifierHandlers } from '../handlers/verifier.js';
import { createVerdictHandlers } from '../handlers/verdict.js';
import type { HandlerContext } from '../handlers/context.js';
import { assessStoredValidationPassAdmissibility } from '../handlers/phase-gates.js';
import { verificationIntentSchema } from '../cli/command-schemas.js';

const DEFAULT_STORY_ID = 'B-validate-lock';
const NOW = '2026-06-24T00:00:00.000Z';

type ChildResult = {
  code: number | null;
  output: string;
};

type SpawnedChild = {
  child: ReturnType<typeof spawn>;
  done: Promise<ChildResult>;
  output: () => string;
  stdout: () => string;
  stderr: () => string;
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
  return join(repoRoot(), 'bin/proof-or-stop.js');
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

async function waitForOutput(proc: SpawnedChild, pattern: RegExp, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(proc.output())) return true;
    await sleep(25);
  }
  return pattern.test(proc.output());
}

function spawnCommand(root: string, args: string[], label: string, extraEnv: Record<string, string> = {}): SpawnedChild {
  const child = spawn(process.execPath, [cliPath(), ...args], {
    cwd: root,
    env: {
      ...process.env,
      PROOF_OR_STOP_IDLE_TIMEOUT_MS: '300000',
      PROOF_OR_STOP_PROJECT_ROOT: root,
      PROOF_OR_STOP_VALIDATE_LOCK_SMOKE_LABEL: label,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = new Promise<ChildResult>((resolveDone) => {
    child.on('close', (code) => resolveDone({ code, output: stdout + stderr }));
    child.on('error', (error) => resolveDone({ code: null, output: `${stdout}${stderr}\n${error.message}` }));
  });
  return { child, done, output: () => stdout + stderr, stdout: () => stdout, stderr: () => stderr };
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

async function runProofOrStop(root: string, command: string, args: Record<string, unknown>): Promise<string> {
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

function reviewerReadManifest(agent: string): Record<string, unknown> {
  return {
    filesReadFully: [`docs/requirements/decisions/${agent}.md`],
    filesTriagedByName: [],
    scanEscalationReason: null,
  };
}

function setupFixture(options: FixtureOptions = {}): { root: string; storyId: string } {
  const storyId = options.storyId ?? DEFAULT_STORY_ID;
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-validate-lock-'));
  write(root, '.gitignore', [
    'entered.log',
    'bare-entered.log',
    'release',
    PROOF_OR_STOP_ACTIVITY_LOG,
    `${PROOF_OR_STOP_DIR}/locks/`,
    '',
  ].join('\n'));
  const validateCommand = {
    label: 'lock-probe',
    command: process.execPath,
    args: ['validate-probe.mjs'],
    timeoutMs: 10000,
  };
  write(root, PROOF_OR_STOP_CONFIG_FILENAME, JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: PROOF_OR_STOP_STORY_DIR,
    requirementsDir: 'docs/requirements',
    ...(options.workflowProfile ? { workflow: { profile: options.workflowProfile } } : {}),
    validate: { commands: [validateCommand] },
    ...(options.doneRequired ? { doneRequiredCommands: [validateCommand] } : {}),
  }, null, 2) + '\n');
  write(root, 'validate-probe.mjs', `
import { appendFileSync, existsSync } from 'node:fs';
const label = process.env.PROOF_OR_STOP_VALIDATE_LOCK_SMOKE_LABEL || 'unlabeled';
appendFileSync('entered.log', label + ' ' + String(process.pid) + ' ' + Date.now() + '\\n');
const deadline = Date.now() + 8000;
while (!existsSync('release')) {
  if (Date.now() > deadline) process.exit(12);
  await new Promise((resolve) => setTimeout(resolve, 25));
}
console.log('probe ' + label + ' passed');
`);
  write(root, 'package.json', JSON.stringify({ scripts: { test: 'node bare-test-probe.mjs' } }, null, 2) + '\n');
  write(root, 'bare-test-probe.mjs', "import{appendFileSync}from'node:fs';appendFileSync('bare-entered.log','bare npm test\\n');console.log('bare npm test passed');\n");
  write(root, 'packages/main/src/index.ts', 'export const validateLockSmoke = true;\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  commitAll(root, 'seed validate lock fixture');

  const store = new StoryStore(root);
  store.writeStory(storyId, story(storyId, options.phase ?? 'TEST', options.priority ?? 'high'));
  store.writeChecklist(storyId, checklist());
  commitAll(root, 'seed story metadata');
  if (options.doneRequired) {
    const causalInputHashes = deriveCertificationDomainInputHashes(root, 'HEAD', root);
    assert.ok(causalInputHashes, 'capacity fixture must bind real certification inputs');
    persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes });
  }
  return { root, storyId };
}

function release(root: string): void {
  writeFileSync(join(root, 'release'), 'release\n', 'utf8');
}

async function assertWorkspaceWaitAndRun(): Promise<void> {
  const { root, storyId } = setupFixture({ storyId: 'B-capacity-a' });
  const secondStoryId = 'B-capacity-b';
  const store = new StoryStore(root);
  store.writeStory(secondStoryId, story(secondStoryId));
  store.writeChecklist(secondStoryId, checklist());
  commitAll(root, 'seed second story metadata');
  const originalCwd = process.cwd();
  try {
    process.chdir(root);
    process.env.PROOF_OR_STOP_VALIDATE_LOCK_SMOKE_LABEL = 'first';
    const firstLog: string[] = [];
    const firstHandlers = createVerifierHandlers({
      root, scanRoot: join(root, 'packages/main'), store,
      log: (message) => firstLog.push(message),
    });
    const first = firstHandlers.validate({ story: storyId, json: true, noSync: true }) as Promise<string>;
    const firstEntered = await waitForEntered(root, 1, 4000);
    if (!firstEntered) {
      release(root);
      const firstResult = await first;
      assert.fail([
        'precondition: first validate command entered the probe',
        `firstOutput=${firstResult.slice(0, 2000)}`,
      ].join('\n'));
    }

    process.env.PROOF_OR_STOP_VALIDATE_LOCK_SMOKE_LABEL = 'second';
    const secondLog: string[] = [];
    const secondHandlers = createVerifierHandlers({
      root, scanRoot: join(root, 'packages/main'), store,
      log: (message) => secondLog.push(message),
    });
    const second = secondHandlers.validate({ story: secondStoryId, json: true, noSync: true }) as Promise<string>;
    const secondEnteredBeforeRelease = await waitForEntered(root, 2, 1500);
    assert.equal(secondEnteredBeforeRelease, false, 'second story must wait outside its validation callback');
    assert.match(secondLog.join('\n'), /waiting for workspace validation capacity/);
    assert.match(secondLog.join('\n'), /validate for B-capacity-a/);
    assert.match(secondLog.join('\n'), /heartbeat/);

    release(root);
    const [firstRaw, secondRaw] = await Promise.all([first, second]);
    const firstResult = JSON.parse(firstRaw) as { status?: string };
    const secondResult = JSON.parse(secondRaw) as { status?: string };

    assert.equal(firstResult.status, 'pass', firstRaw);
    assert.equal(secondResult.status, 'pass', secondRaw);
    assert.equal(enteredCount(root), 2, 'queued story must run automatically after the holder releases');
    const evidenceStore = new StoryStore(root);
    const firstEvidence = evidenceStore.readTestEvidence(storyId);
    const secondEvidence = evidenceStore.readTestEvidence(secondStoryId);
    assert.equal(firstEvidence?.result, 'PASS', `first evidence=${JSON.stringify(firstEvidence)}`);
    assert.equal(secondEvidence?.result, 'PASS', `second evidence=${JSON.stringify(secondEvidence)}`);
  } finally {
    delete process.env.PROOF_OR_STOP_VALIDATE_LOCK_SMOKE_LABEL;
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertPostCommandPersistenceHoldsLock(): Promise<void> {
  const { root, storyId } = setupFixture({ storyId: 'B-validate-evidence-race' });
  const originalCwd = process.cwd();
  try {
    // Exercise the real verifier handler and instrument only its fixed StoryStore
    // capability. The callback cannot select a path, command, argv, cwd, or shell.
    writeFileSync(join(root, 'release'), 'allow configured command to finish\n', 'utf8');
    const targetStore = new StoryStore(root);
    let persistenceObserved = false;
    const instrumentedStore = new Proxy(targetStore, {
      get(target, property) {
        if (property === 'writeTestEvidence') {
          return (...args: Parameters<StoryStore['writeTestEvidence']>) => {
            assert.equal(enteredCount(root), 1, 'real configured command must finish before evidence persistence');
            assert.equal(existsSync(validationExecutionLockPath(root, storyId)), true,
              'real verifier evidence persistence must remain inside the story validation lock');
            assert.equal(capacityTicketPaths(root).length, 1,
              'real verifier evidence persistence must remain inside workspace capacity');
            persistenceObserved = true;
            return target.writeTestEvidence(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    process.chdir(root);
    const handlers = createVerifierHandlers({ root, scanRoot: join(root, 'packages/main'), store: instrumentedStore });
    const raw = await handlers.validate({ story: storyId, json: true, noSync: true });
    const result = JSON.parse(raw) as { status?: string; commandExecutions?: number };
    assert.equal(result.status, 'pass');
    assert.equal(result.commandExecutions, 1);
    assert.equal(persistenceObserved, true, 'real verifier must call the instrumented evidence writer');
    assert.equal(existsSync(validationExecutionLockPath(root, storyId)), false,
      'validation lock releases only after the real handler returns');
    assert.equal(capacityTicketPaths(root).length, 0,
      'workspace capacity releases only after the real handler returns');
    assert.ok(targetStore.readTestEvidence(storyId), 'real verifier persists story evidence');
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertRetiredRaceSeamIsProductionUnreachable(): Promise<void> {
  const verifierSource = readFileSync(join(repoRoot(), 'packages/main/src/handlers/verifier.ts'), 'utf8');
  for (const retired of [
    'PROOF_OR_STOP_VALIDATE_LOCK_SMOKE_POST_COMMAND_HOLD_FILE',
    'PROOF_OR_STOP_VALIDATE_LOCK_SMOKE_POST_COMMAND_READY_FILE',
    'PROOF_OR_STOP_VALIDATE_LOCK_SMOKE_POST_COMMAND_TIMEOUT_MS',
  ]) {
    assert.doesNotMatch(verifierSource, new RegExp(retired), `${retired} must be absent from production verifier`);
  }
  const validateSchema = MAIN_TOOLS.find(tool => tool.name === 'validate')?.schema;
  assert.ok(validateSchema, 'validate public schema exists');
  assert.equal(Object.keys(validateSchema).some(key => /SMOKE|TEST.*(?:FILE|COMMAND|HOLD|READY)/i.test(key)), false,
    'public validate schema exposes no race capability');

  const { root, storyId } = setupFixture({ storyId: 'B-retired-seam-unreachable' });
  const trapReady = join(root, 'caller-selected.ready');
  const trapHold = join(root, 'caller-selected.hold');
  try {
    const unknownFlag = spawnCommand(root, [
      'validate',
      `--story=${storyId}`,
      '--json',
      `--PROOF_OR_STOP_VALIDATE_LOCK_SMOKE_POST_COMMAND_READY_FILE=${trapReady}`,
    ], 'unknown-race-flag');
    const rejected = await waitChild(unknownFlag, 5000);
    assert.notEqual(rejected.code, 0, 'unknown caller-selected race capability flag must be rejected');
    assert.equal(existsSync(trapReady), false, 'unknown flag must not create caller-selected ready path');

    release(root);
    const inherited = spawnValidate(root, storyId, 'retired-env-control', {
      PROOF_OR_STOP_VALIDATE_LOCK_SMOKE_POST_COMMAND_HOLD_FILE: trapHold,
      PROOF_OR_STOP_VALIDATE_LOCK_SMOKE_POST_COMMAND_READY_FILE: trapReady,
      PROOF_OR_STOP_VALIDATE_LOCK_SMOKE_POST_COMMAND_TIMEOUT_MS: '1',
    });
    const result = await waitChild(inherited, 12000);
    assert.equal(result.code, 0, result.output);
    assert.equal(existsSync(trapReady), false, 'inherited environment cannot create caller-selected ready path');
    assert.equal(existsSync(trapHold), false, 'inherited environment cannot create caller-selected hold path');
  } finally {
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

    const reviewRunOutput = await runProofOrStop(root, 'review_run_start', {
      storyId,
      agent: 'proof-or-stop-review-quality',
    });
    const reviewRunId = extractReviewRunId(reviewRunOutput);
    await runProofOrStop(root, 'review_pass_set', {
      storyId,
      agent: 'proof-or-stop-review-quality',
      reviewRunId,
      note: 'proof-or-stop-review-quality checked validate lock scope and found no blocker.',
      readManifest: reviewerReadManifest('proof-or-stop-review-quality'),
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

    await runProofOrStop(root, 'delivery_check_set', {
      storyId,
      agentId: 'proof-or-stop-review-delivery',
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
    assert.equal(delivery?.agentId, 'proof-or-stop-review-delivery');

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
    assert.equal(enteredCount(root), 1, 'done_required_validate must not enter the validation command while validate is held');
    assert.equal(await waitForOutput(doneRequired, /waiting for workspace validation capacity/, 4000), true,
      `done_required_validate must visibly wait; output=${doneRequired.output()}`);

    release(root);
    const [validateResult, doneRequiredResult] = await Promise.all([
      waitChild(validate, 12000),
      waitChild(doneRequired, 12000),
    ]);
    assert.equal(validateResult.code, 0, validateResult.output);
    assert.equal(doneRequiredResult.code, 0, doneRequiredResult.output);
    assert.equal(enteredCount(root), 2, 'queued done_required_validate must run after validate releases');
    const evidenceStore = new StoryStore(root);
    const routineEvidence = evidenceStore.readTestEvidence(storyId);
    const doneEvidence = evidenceStore.readDoneRequiredEvidence(storyId);
    assert.equal(routineEvidence?.result, 'PASS', 'validate -> done_required must retain routine PASS evidence');
    assert.equal(doneEvidence?.status, 'PASS', 'validate -> done_required must write DONE-required PASS evidence');
    for (const [label, evidence] of [['routine', routineEvidence], ['done-required', doneEvidence]] as const) {
      assert.ok(evidence?.headHash, `${label} evidence must bind headHash`);
      assert.ok(evidence?.materialHash, `${label} evidence must bind materialHash`);
      assert.ok(evidence?.storyFilesHash, `${label} evidence must bind storyFilesHash`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const reverse = setupFixture({ storyId: 'B-required-validate', doneRequired: true });
  try {
    const doneRequired = spawnCommand(reverse.root, [
      'done_required_validate',
      JSON.stringify({ storyId: reverse.storyId, json: true }),
    ], 'reverse-done-holder');
    assert.equal(await waitForEntered(reverse.root, 1, 4000), true,
      'done_required_validate must enter before reverse validate starts');
    const validate = spawnValidate(reverse.root, reverse.storyId, 'reverse-validate-contender');
    assert.equal(await waitForOutput(validate, /waiting for workspace validation capacity/, 4000), true,
      `reverse validate must visibly wait; output=${validate.output()}`);
    assert.equal(enteredCount(reverse.root), 1, 'reverse validate must not enter while done_required holds capacity');
    release(reverse.root);
    const [doneResult, validateResult] = await Promise.all([
      waitChild(doneRequired, 12000),
      waitChild(validate, 12000),
    ]);
    assert.equal(doneResult.code, 0, doneResult.output);
    assert.equal(validateResult.code, 0, validateResult.output);
    assert.equal(enteredCount(reverse.root), 2, 'reverse queued validate must run after done_required releases');
    const store = new StoryStore(reverse.root);
    assert.equal(store.readDoneRequiredEvidence(reverse.storyId)?.status, 'PASS');
    assert.equal(store.readTestEvidence(reverse.storyId)?.result, 'PASS');
  } finally {
    rmSync(reverse.root, { recursive: true, force: true });
  }
}

async function assertStaleLockReclaimed(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-validate-lock-stale-'));
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
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-validate-lock-vanished-'));
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
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-validate-lock-mismatch-'));
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
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-validate-lock-unit-'));
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

function writeCapacityOwner(
  root: string,
  holder: Record<string, unknown> | null,
  heartbeat?: Record<string, unknown>,
  ageMs = 0,
): string {
  const lockRoot = validationCapacityLockPath(root);
  mkdirSync(lockRoot, { recursive: true });
  const lockId = typeof holder?.lockId === 'string' ? holder.lockId : `unknown-${Date.now()}`;
  const lockDir = join(lockRoot, `0000000000000001-${lockId}.ticket`);
  mkdirSync(lockDir);
  if (holder) writeFileSync(join(lockDir, MKDIR_LOCK_HOLDER_FILE), JSON.stringify(holder, null, 2) + '\n', 'utf8');
  if (heartbeat) {
    writeFileSync(join(lockDir, VALIDATION_EXECUTION_LOCK_HEARTBEAT_FILE), JSON.stringify(heartbeat, null, 2) + '\n', 'utf8');
  }
  const timestamp = new Date(Date.now() - ageMs);
  utimesSync(lockDir, timestamp, timestamp);
  return lockDir;
}

function capacityTicketPaths(root: string): string[] {
  const lockRoot = validationCapacityLockPath(root);
  try {
    return readdirSync(lockRoot)
      .filter(name => name.endsWith('.ticket'))
      .sort()
      .map(name => join(lockRoot, name));
  } catch {
    return [];
  }
}

async function waitForCapacityTicketCount(root: string, count: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (capacityTicketPaths(root).length === count) return true;
    await sleep(10);
  }
  return capacityTicketPaths(root).length === count;
}

async function assertCapacityStrictStaleClassifier(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-capacity-stale-'));
  const base = { root, workspaceRoot: root, command: 'validate', pollMs: 15, progressIntervalMs: 15 };
  try {
    const unknown = writeCapacityOwner(root, null, undefined, 60_000);
    await assert.rejects(
      () => withWorkspaceValidationCapacity({ ...base, staleMs: 10, deadlineAt: Date.now() + 80 }, () => undefined),
      /deadline/,
    );
    assert.equal(existsSync(unknown), true, 'old ownerless capacity lease must not be reclaimed');
    rmSync(unknown, { recursive: true, force: true });

    const malformed = writeCapacityOwner(root, { nope: true }, undefined, 60_000);
    await assert.rejects(
      () => withWorkspaceValidationCapacity({ ...base, staleMs: 10, deadlineAt: Date.now() + 80 }, () => undefined),
      /deadline/,
    );
    assert.equal(existsSync(malformed), true, 'malformed capacity owner must not be reclaimed');
    rmSync(malformed, { recursive: true, force: true });

    const startMs = processStartTimeMs();
    const oldBeat = new Date(Date.now() - 60_000).toISOString();
    const live = writeCapacityOwner(root, {
      lockId: 'live-owner', pid: process.pid, hostname: hostname(), command: 'validate for B-live',
      acquiredAt: oldBeat, processStartTimeMs: startMs,
    }, {
      lockId: 'live-owner', pid: process.pid, hostname: hostname(), heartbeatAt: oldBeat,
      processStartTimeMs: startMs,
    }, 60_000);
    await assert.rejects(
      () => withWorkspaceValidationCapacity({ ...base, staleMs: 10, deadlineAt: Date.now() + 80 }, () => undefined),
      /deadline/,
    );
    assert.equal(existsSync(live), true, 'age-only expiry with a live matching owner must stay blocked');
    rmSync(live, { recursive: true, force: true });

    const dead = writeCapacityOwner(root, {
      lockId: 'dead-owner', pid: 999_999_999, hostname: hostname(), command: 'validate for B-dead',
      acquiredAt: new Date().toISOString(), processStartTimeMs: startMs - 60_000,
    });
    let deadRan = false;
    await withWorkspaceValidationCapacity({ ...base, staleMs: 60_000 }, () => { deadRan = true; });
    assert.equal(deadRan, true, 'mechanically dead local owner must be reclaimed');
    assert.equal(existsSync(dead), false);

    const mismatch = writeCapacityOwner(root, {
      lockId: 'holder-a', pid: process.pid, hostname: hostname(), command: 'validate for B-mismatch',
      acquiredAt: new Date().toISOString(), processStartTimeMs: startMs,
    }, {
      lockId: 'heartbeat-b', pid: process.pid, hostname: hostname(), heartbeatAt: new Date().toISOString(),
      processStartTimeMs: startMs,
    });
    let mismatchRan = false;
    await withWorkspaceValidationCapacity({ ...base, staleMs: 60_000 }, () => { mismatchRan = true; });
    assert.equal(mismatchRan, true, 'holder/heartbeat identity mismatch must be reclaimed');
    assert.equal(existsSync(mismatch), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertCapacityAtomicStaleQuarantineStress(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-capacity-aba-stress-'));
  try {
    for (let round = 0; round < 20; round += 1) {
      writeCapacityOwner(root, {
        lockId: `dead-seed-${round}`,
        pid: 999_999_999,
        hostname: hostname(),
        command: `dead seed ${round}`,
        acquiredAt: new Date().toISOString(),
        processStartTimeMs: processStartTimeMs() - 60_000,
      });
      let concurrent = 0;
      let maxConcurrency = 0;
      const entries: number[] = [];
      await Promise.all(Array.from({ length: 12 }, (_, waiter) => withWorkspaceValidationCapacity({
        root,
        workspaceRoot: root,
        command: 'validate',
        storyId: `B-aba-${round}-${waiter}`,
        pollMs: 2,
        deadlineAt: Date.now() + 5000,
      }, async () => {
        concurrent += 1;
        maxConcurrency = Math.max(maxConcurrency, concurrent);
        entries.push(waiter);
        await sleep(2);
        concurrent -= 1;
      })));
      assert.equal(maxConcurrency, 1, `round ${round}: stale reclaim must never overlap a successor`);
      assert.equal(entries.length, 12, `round ${round}: every queued successor must eventually enter`);
      const leftovers = readdirSync(validationCapacityLockPath(root))
        .filter(name => name.endsWith('.ticket') || name.endsWith('.choosing') || name.endsWith('.quarantine'));
      assert.deepEqual(leftovers, [], `round ${round}: no ticket/quarantine may leak after release`);
    }

    // Repeat the stale-reclaim race across independent processes. The earlier
    // Promise cohort proves separate async contexts in one process; this cohort
    // makes the filesystem publication/quarantine boundary genuinely concurrent.
    const helper = join(root, 'capacity-child-stress.mjs');
    const events = join(root, 'child-events.log');
    const overlap = join(root, 'child-overlap.log');
    const critical = join(root, 'child-critical');
    writeFileSync(helper, `
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { withWorkspaceValidationCapacity } from ${JSON.stringify(join(repoRoot(), 'packages/main/dist/core/validation-execution-lock.js'))};
const [root, label, events, overlap, critical] = process.argv.slice(2);
await withWorkspaceValidationCapacity({
  root,
  workspaceRoot: root,
  command: \`child-stress-\${label}\`,
  pollMs: 5,
  deadlineAt: Date.now() + 10000,
}, async () => {
  let ownsCritical = false;
  try {
    mkdirSync(critical);
    ownsCritical = true;
  } catch {
    appendFileSync(overlap, \`overlap:\${label}\\n\`);
  }
  appendFileSync(events, \`start:\${label}\\n\`);
  await delay(15);
  appendFileSync(events, \`end:\${label}\\n\`);
  if (ownsCritical) rmSync(critical, { recursive: true, force: true });
});
`, 'utf8');

    const childProcessWaiterCount = 12;
    for (let round = 0; round < 3; round += 1) {
      rmSync(events, { force: true });
      rmSync(overlap, { force: true });
      rmSync(critical, { recursive: true, force: true });
      writeCapacityOwner(root, {
        lockId: `dead-child-seed-${round}`,
        pid: 999_999_999,
        hostname: hostname(),
        command: `dead child seed ${round}`,
        acquiredAt: new Date().toISOString(),
        processStartTimeMs: processStartTimeMs() - 60_000,
      });
      const children = Array.from({ length: childProcessWaiterCount }, (_, index) => new Promise<ChildResult>((resolveChild) => {
        const child = spawn(process.execPath, [helper, root, `${round}-${index}`, events, overlap, critical], {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        child.on('error', (error) => resolveChild({ code: null, output: `${output}\n${error.message}` }));
        child.on('close', (code) => resolveChild({ code, output }));
      }));
      const results = await Promise.all(children);
      for (const [index, result] of results.entries()) {
        assert.equal(result.code, 0, `child stress round ${round} waiter ${index}: ${result.output}`);
      }
      const eventLines = readFileSync(events, 'utf8').trim().split('\n').filter(Boolean);
      let concurrent = 0;
      let maxConcurrency = 0;
      let starts = 0;
      for (const event of eventLines) {
        if (event.startsWith('start:')) {
          starts += 1;
          concurrent += 1;
          maxConcurrency = Math.max(maxConcurrency, concurrent);
        } else if (event.startsWith('end:')) {
          concurrent -= 1;
          assert.ok(concurrent >= 0, `child stress round ${round}: end cannot precede start`);
        }
      }
      assert.equal(starts, childProcessWaiterCount,
        `child stress round ${round}: all ${childProcessWaiterCount} child-process waiters must enter`);
      assert.equal(concurrent, 0, `child stress round ${round}: every process must exit`);
      assert.equal(maxConcurrency, 1, `child stress round ${round}: maxConcurrency must remain one`);
      assert.equal(existsSync(overlap), false, `child stress round ${round}: critical section must have zero overlap`);
      const leftovers = readdirSync(validationCapacityLockPath(root))
        .filter(name => name.endsWith('.ticket') || name.endsWith('.choosing') || name.endsWith('.quarantine'));
      assert.deepEqual(leftovers, [], `child stress round ${round}: no queue artifact may leak`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertKilledCapacityOwnerReplacement(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-capacity-killed-owner-'));
  const ready = join(root, 'owner-ready');
  const helper = join(root, 'capacity-owner.mjs');
  try {
    writeFileSync(helper, `
import { writeFileSync } from 'node:fs';
import { withWorkspaceValidationCapacity } from ${JSON.stringify(join(repoRoot(), 'packages/main/dist/core/validation-execution-lock.js'))};
await withWorkspaceValidationCapacity({ root: ${JSON.stringify(root)}, workspaceRoot: ${JSON.stringify(root)}, command: 'killed-owner', pollMs: 5 }, async () => {
  writeFileSync(${JSON.stringify(ready)}, 'ready\\n');
  await new Promise(() => { setInterval(() => {}, 1000); });
});
`, 'utf8');
    const owner = spawn(process.execPath, [helper], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const ownerDone = new Promise<number | null>((resolveDone) => owner.on('close', resolveDone));
    const readyDeadline = Date.now() + 4000;
    while (!existsSync(ready) && Date.now() < readyDeadline) await sleep(10);
    assert.equal(existsSync(ready), true, 'child owner must acquire capacity before replacement queues');

    let successorEntered = false;
    const successor = withWorkspaceValidationCapacity({
      root,
      workspaceRoot: root,
      command: 'killed-successor',
      pollMs: 5,
      deadlineAt: Date.now() + 4000,
    }, () => { successorEntered = true; });
    await sleep(50);
    assert.equal(successorEntered, false, 'successor must wait while child owner is live');
    owner.kill('SIGKILL');
    await ownerDone;
    await successor;
    assert.equal(successorEntered, true, 'queued successor must replace a mechanically dead child owner');
    assert.equal(capacityTicketPaths(root).length, 0, 'killed-owner replacement must leave no ticket');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertKilledBeforeCapacityPublicationDoesNotBlock(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-capacity-killed-before-publish-'));
  const lockRoot = validationCapacityLockPath(root);
  const ready = join(root, 'preparing-ready');
  const helper = join(root, 'capacity-preparing-owner.mjs');
  const abandonedPreparation = join(lockRoot, 'killed-owner.preparing');
  try {
    mkdirSync(lockRoot, { recursive: true });
    writeFileSync(helper, `
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync(${JSON.stringify(abandonedPreparation)});
writeFileSync(${JSON.stringify(ready)}, 'ready\\n');
await new Promise(() => { setInterval(() => {}, 1000); });
`, 'utf8');
    const owner = spawn(process.execPath, [helper], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const ownerDone = new Promise<number | null>((resolveDone) => owner.on('close', resolveDone));
    const readyDeadline = Date.now() + 4000;
    while (!existsSync(ready) && Date.now() < readyDeadline) await sleep(10);
    assert.equal(existsSync(ready), true, 'child must stop in the private pre-publication path');
    owner.kill('SIGKILL');
    await ownerDone;

    let successorEntered = false;
    await withWorkspaceValidationCapacity({
      root,
      workspaceRoot: root,
      command: 'post-publication-kill-successor',
      deadlineAt: Date.now() + 1000,
    }, () => { successorEntered = true; });
    assert.equal(successorEntered, true,
      'a killed process before atomic publication must not leave a queue-visible ownerless choosing entry');
    assert.equal(existsSync(abandonedPreparation), true,
      'the simulation must retain the private killed preparation while the successor acquires');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertCapacityAsyncWaitAbortReentrancyAndRelease(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-capacity-async-'));
  const options = {
    root, workspaceRoot: root, command: 'validate', storyId: 'B-owner',
    pollMs: 15, progressIntervalMs: 20, staleMs: 60_000,
  };
  try {
    let releaseOwner: () => void = () => {};
    let ownerEntered = false;
    let nestedEntered = false;
    const owner = withOfficialValidationExecution(options, async () => {
      ownerEntered = true;
      assert.equal(existsSync(validationExecutionLockPath(root, 'B-owner')), true,
        'official owner must acquire the inner story lock after capacity');
      await withOfficialValidationExecution(options, () => { nestedEntered = true; });
      await new Promise<void>((resolveOwner) => { releaseOwner = resolveOwner; });
    });
    while (!ownerEntered) await sleep(5);

    const progress: string[] = [];
    let siblingEntered = false;
    let timerFired = false;
    setTimeout(() => { timerFired = true; }, 25);
    const sibling = withOfficialValidationExecution({
      ...options,
      storyId: 'B-sibling',
      progressIntervalMs: 1000,
      onWaitProgress: (message) => progress.push(message),
    }, () => { siblingEntered = true; });
    await sleep(75);
    assert.equal(timerFired, true, 'capacity wait must not block the event loop');
    assert.equal(nestedEntered, true, 'same AsyncLocal owner must be reentrant');
    assert.equal(siblingEntered, false, 'independent sibling context must remain queued');
    assert.ok(progress.length >= 1 && progress.length <= 4, `wait progress must be visible and bounded: ${progress.length}`);
    assert.match(progress[0]!, /waiting for workspace validation capacity: holder validate for B-owner .*heartbeat/);
    const ownerTicket = capacityTicketPaths(root)[0];
    assert.ok(ownerTicket, 'active capacity owner must expose one unique ticket');
    const heartbeatPath = join(ownerTicket, VALIDATION_EXECUTION_LOCK_HEARTBEAT_FILE);
    const firstHeartbeat = JSON.parse(readFileSync(heartbeatPath, 'utf8')) as { heartbeatAt: string };
    await sleep(2100);
    const secondHeartbeat = JSON.parse(readFileSync(heartbeatPath, 'utf8')) as { heartbeatAt: string };
    assert.ok(Date.parse(secondHeartbeat.heartbeatAt) > Date.parse(firstHeartbeat.heartbeatAt),
      'capacity heartbeat must advance while a sibling waits asynchronously');
    assert.ok(progress.length <= 4, `rate-bounded progress must not emit per poll: ${progress.length}`);
    releaseOwner();
    await Promise.all([owner, sibling]);
    assert.equal(siblingEntered, true, 'queued sibling must enter automatically after release');
    assert.equal(existsSync(validationExecutionLockPath(root, 'B-owner')), false,
      'same-story nested owner must release the inner lock exactly once');

    const assertDetachedGenerationIsolation = async (mode: 'capacity' | 'official'): Promise<void> => {
      const storyId = `B-detached-${mode}`;
      const run = async <T>(command: string, fn: () => Promise<T> | T): Promise<T> => mode === 'official'
        ? await withOfficialValidationExecution({ ...options, command, storyId }, fn)
        : await withWorkspaceValidationCapacity({ ...options, command, storyId }, fn);
      let startDetached!: () => void;
      const detachedGate = new Promise<void>(resolveGate => { startDetached = resolveGate; });
      let detachedTask!: Promise<void>;
      let concurrent = 0;
      let maxConcurrency = 0;
      let detachedEntered = false;

      await run(`${mode}-owner-a`, async () => {
        // This async task captures owner A's ALS generation and intentionally
        // outlives A. It must not inherit a later owner B merely because B uses
        // the same canonical lock path.
        detachedTask = (async () => {
          await detachedGate;
          await run(`${mode}-detached-a`, async () => {
            detachedEntered = true;
            concurrent += 1;
            maxConcurrency = Math.max(maxConcurrency, concurrent);
            await sleep(15);
            concurrent -= 1;
          });
        })();
      });

      let ownerBReady!: () => void;
      const ownerBEntered = new Promise<void>(resolveReady => { ownerBReady = resolveReady; });
      let releaseOwnerB!: () => void;
      const ownerBRelease = new Promise<void>(resolveRelease => { releaseOwnerB = resolveRelease; });
      const ownerB = run(`${mode}-owner-b`, async () => {
        concurrent += 1;
        maxConcurrency = Math.max(maxConcurrency, concurrent);
        ownerBReady();
        await ownerBRelease;
        concurrent -= 1;
      });
      await ownerBEntered;
      startDetached();
      await sleep(75);
      const enteredWhileBHeld = detachedEntered;
      releaseOwnerB();
      await Promise.all([ownerB, detachedTask]);
      assert.equal(enteredWhileBHeld, false,
        `${mode}: detached owner A context must queue behind later owner B's acquisition token`);
      assert.equal(maxConcurrency, 1,
        `${mode}: stale ALS generation must not overlap the later owner (maxConcurrency=1)`);
    };
    await assertDetachedGenerationIsolation('capacity');
    await assertDetachedGenerationIsolation('official');

    let releaseAbortOwner: () => void = () => {};
    let abortOwnerEntered = false;
    const abortOwner = withWorkspaceValidationCapacity(options, async () => {
      abortOwnerEntered = true;
      await new Promise<void>((resolveOwner) => { releaseAbortOwner = resolveOwner; });
    });
    while (!abortOwnerEntered) await sleep(5);
    const abortController = new AbortController();
    let abortedEntered = false;
    const aborted = withOfficialValidationExecution({
      ...options,
      storyId: 'B-aborted',
      abortSignal: abortController.signal,
    }, () => { abortedEntered = true; });
    abortController.abort(new Error('capacity wait cancelled by smoke'));
    await assert.rejects(() => aborted, /cancelled by smoke/);
    assert.equal(abortedEntered, false, 'aborted waiter must stop before callback entry');
    assert.equal(existsSync(validationExecutionLockPath(root, 'B-aborted')), false,
      'aborted capacity waiter must never acquire the inner story lock');

    let deadlineEntered = false;
    await assert.rejects(
      () => withOfficialValidationExecution({
        ...options,
        storyId: 'B-deadline',
        deadlineAt: Date.now() + 40,
        deadlineError: () => new Error('capacity deadline smoke'),
      }, () => { deadlineEntered = true; }),
      /capacity deadline smoke/,
    );
    assert.equal(deadlineEntered, false, 'deadline waiter must stop before callback entry');
    assert.equal(existsSync(validationExecutionLockPath(root, 'B-deadline')), false,
      'deadline capacity waiter must never acquire the inner story lock');
    releaseAbortOwner();
    await abortOwner;

    await assert.rejects(
      () => withWorkspaceValidationCapacity(options, async () => { throw new Error('owner callback truth'); }),
      /owner callback truth/,
    );
    let successorEntered = false;
    await withWorkspaceValidationCapacity(options, () => { successorEntered = true; });
    assert.equal(successorEntered, true, 'throw path must release capacity for its successor');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertBareNpmAndReadOnlyCommandsBypassCapacity(): Promise<void> {
  const { root, storyId } = setupFixture({ storyId: 'B-capacity-bypass' });
  try {
    const holder = spawnValidate(root, storyId, 'bypass-holder');
    assert.equal(await waitForEntered(root, 1, 4000), true, 'official validate must hold capacity');
    const ticketBefore = capacityTicketPaths(root);
    assert.equal(ticketBefore.length, 1);

    const bareOutput = execFileSync('npm', ['test'], { cwd: root, encoding: 'utf8' });
    assert.match(bareOutput, /bare npm test passed/);
    assert.equal(existsSync(join(root, 'bare-entered.log')), true,
      'bare npm test must execute while official capacity is held');
    for (const [command, args] of [
      ['session_brief', {}],
      ['story_get', { storyId, slim: true }],
      ['checklist_get', { storyId, slim: true }],
    ] as const) {
      const output = await runProofOrStop(root, command, args);
      assert.ok(output.trim(), `${command} must complete while validation capacity is held`);
    }
    assert.deepEqual(capacityTicketPaths(root), ticketBefore,
      'bare npm and read-only commands must neither acquire nor replace the official capacity ticket');
    assert.equal(enteredCount(root), 1, 'bypass commands must not enter the configured validation probe');

    release(root);
    const holderResult = await waitChild(holder, 12000);
    assert.equal(holderResult.code, 0, holderResult.output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDerivedVerdictCannotBypassCapacity(): Promise<void> {
  const { root, storyId } = setupFixture({ storyId: 'B-capacity-derived-verdict' });
  const originalCwd = process.cwd();
  try {
    const store = new StoryStore(root);
    store.writeChecklist(storyId, { items: [] });
    commitAll(root, 'seed empty checklist for derived verdict');
    const coverage = { total: 0, required: 0, covered: 0, missingRequired: 0, entries: [] };
    store.writeTestEvidence(storyId, {
      result: 'PASS',
      command: `proof-or-stop validate --story=${storyId} --json`,
      output: JSON.stringify({ allPass: true, verificationCoverage: coverage }),
      timestamp: NOW,
      headHash: git(root, ['rev-parse', 'HEAD']).trim(),
      materialHash: currentMaterialHash(root)!,
      storyFilesHash: currentStoryFilesHash(root)!,
      verificationCoverage: coverage,
    });
    process.chdir(root);

    // B-3434 F-055: everything below asserts a NEGATIVE (the derived verdict must
    // not settle while capacity is held). A negative is only evidence about the
    // capacity guard if the input would otherwise have been accepted, so the
    // seeded evidence is proven admissible FIRST — against the same gate the
    // derive path calls, which is also what pins the command string above without
    // this file restating the expected command.
    const gateContext = { store, root, scanRoot: join(root, 'packages/main') } as HandlerContext;
    const seededAdmissibility = assessStoredValidationPassAdmissibility(gateContext, storyId);
    assert.equal(
      seededAdmissibility.ok,
      true,
      `seeded validation evidence must be admissible before the capacity negative is meaningful: ${seededAdmissibility.reasons.join('; ')}`,
    );

    let releaseOwner!: () => void;
    let ownerReady!: () => void;
    const ready = new Promise<void>(resolveReady => { ownerReady = resolveReady; });
    const releasePromise = new Promise<void>(resolveRelease => { releaseOwner = resolveRelease; });
    const holder = withWorkspaceValidationCapacity({
      root,
      workspaceRoot: root,
      requireGitIdentity: true,
      command: 'starved-live-validation-writer',
    }, async () => {
      ownerReady();
      await releasePromise;
    });
    await ready;

    let verdictSettled = false;
    const verdictPromise = Promise.resolve(createVerdictHandlers({ root, scanRoot: join(root, 'packages/main'), store })
      .autopilot_review_submit({
        storyId,
        runId: 'capacity-race',
        hostId: 'capacity-host',
        provider: 'codex',
        sessionId: 'capacity-session',
        decision: 'pass',
        deriveBindings: true,
        json: true,
      }));
    verdictPromise.finally(() => { verdictSettled = true; }).catch(() => undefined);
    await sleep(75);
    assert.equal(verdictSettled, false,
      'derived verdict must queue behind the same outer capacity as a validation evidence writer');
    assert.equal(store.readProcessEvents(storyId).filter(event => event.type === 'host_verdict').length, 0,
      'derived verdict must not persist while validation capacity is held');

    releaseOwner();
    await holder;
    const verdict = await verdictPromise;
    assert.notEqual(typeof verdict, 'string', 'JSON derived verdict must return a structured verdict');
    if (typeof verdict === 'string') assert.fail(verdict);
    assert.equal(verdict.runId, 'capacity-race');
    assert.equal(store.readProcessEvents(storyId).filter(event => event.type === 'host_verdict').length, 1,
      'derived verdict must persist after the capacity owner releases');
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertNoStoryConfiguredGitRootFailureDoesNotMintWrapperCapacity(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-capacity-configured-gitroot-failure-'));
  const marker = join(root, 'validate-callback-entered');
  try {
    mkdirSync(join(root, 'configured-repo'), { recursive: true });
    write(root, 'packages/main/src/index.ts', 'export const configuredGitRootFailure = true;\n');
    write(root, 'validate-marker.mjs', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'entered\\n');\n`);
    write(root, PROOF_OR_STOP_CONFIG_FILENAME, JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: PROOF_OR_STOP_STORY_DIR,
      requirementsDir: 'docs/requirements',
      gitRoot: 'configured-repo',
      validate: {
        commands: [{ label: 'configured-gitroot-marker', command: process.execPath, args: ['validate-marker.mjs'] }],
      },
    }, null, 2) + '\n');
    const store = new StoryStore(root);
    const handlers = createVerifierHandlers({ root, scanRoot: join(root, 'packages/main'), store });
    await assert.rejects(
      () => handlers.validate({ json: true, noSync: true }) as Promise<string>,
      /configured gitRoot could not be resolved for workspace validation capacity/,
    );
    assert.equal(existsSync(marker), false,
      'unresolved configured gitRoot must stop before the no-story validation callback');
    assert.equal(existsSync(join(root, PROOF_OR_STOP_DIR, 'locks/validation-capacity.lock')), false,
      'unresolved configured gitRoot must not mint a split capacity lock under the metadata wrapper');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertCapacityReleaseFailureIsExplicitAndRecoverable(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-capacity-release-failure-'));
  const lockRoot = validationCapacityLockPath(root);
  try {
    let callbackRan = false;
    let releaseFailure: unknown;
    try {
      await withWorkspaceValidationCapacity({
        root,
        workspaceRoot: root,
        command: 'release-failure-success-callback',
      }, () => {
        callbackRan = true;
        chmodSync(lockRoot, 0o555);
        return 'callback-ok';
      });
    } catch (error) {
      releaseFailure = error;
    }
    assert.equal(callbackRan, true, 'release fault must occur after the callback succeeds');
    assert.match(String(releaseFailure), /workspace validation capacity release failed after 3 ownership-safe attempts/,
      'a successful callback must not hide an unreleased numbered ticket');
    assert.equal(capacityTicketPaths(root).length, 1,
      'deterministic chmod fault must leave the exact numbered ticket for successor recovery');

    chmodSync(lockRoot, 0o755);
    let successorEntered = false;
    await withWorkspaceValidationCapacity({
      root,
      workspaceRoot: root,
      command: 'release-failure-successor',
      deadlineAt: Date.now() + 1000,
    }, () => { successorEntered = true; });
    assert.equal(successorEntered, true,
      'after filesystem repair, a successor must mechanically reclaim the explicitly released ticket');
    assert.equal(capacityTicketPaths(root).length, 0, 'successor recovery must leave no numbered ticket');

    const originalError = new Error('original callback failure sentinel');
    let observedError: unknown;
    try {
      await withWorkspaceValidationCapacity({
        root,
        workspaceRoot: root,
        command: 'release-failure-error-callback',
      }, () => {
        chmodSync(lockRoot, 0o555);
        throw originalError;
      });
    } catch (error) {
      observedError = error;
    }
    assert.equal(observedError, originalError,
      'release cleanup failure must preserve the original callback error object and semantics');
    assert.equal(capacityTicketPaths(root).length, 1,
      'original callback failure path must still mark its exact ticket for recovery');
    chmodSync(lockRoot, 0o755);
    let errorSuccessorEntered = false;
    await withWorkspaceValidationCapacity({
      root,
      workspaceRoot: root,
      command: 'release-failure-error-successor',
      deadlineAt: Date.now() + 1000,
    }, () => { errorSuccessorEntered = true; });
    assert.equal(errorSuccessorEntered, true,
      'successor must recover after a callback error plus release isolation failure');
    assert.equal(capacityTicketPaths(root).length, 0);
  } finally {
    try { chmodSync(lockRoot, 0o755); } catch { /* fixture may not have created the lock root */ }
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertQueuedWaitFailureCleanupIsRecoverable(): Promise<void> {
  for (const mode of ['abort', 'deadline'] as const) {
    const root = mkdtempSync(join(tmpdir(), `proof-or-stop-capacity-waiter-${mode}-cleanup-`));
    const lockRoot = validationCapacityLockPath(root);
    let releaseOwner: () => void = () => {};
    let owner: Promise<void> | null = null;
    try {
      let ownerReady!: () => void;
      const ready = new Promise<void>(resolveReady => { ownerReady = resolveReady; });
      const held = new Promise<void>(resolveRelease => { releaseOwner = resolveRelease; });
      let ownerExited = false;
      owner = withWorkspaceValidationCapacity({
        root,
        workspaceRoot: root,
        command: `${mode}-cleanup-owner`,
      }, async () => {
        ownerReady();
        await held;
      }).then(() => { ownerExited = true; });
      await ready;

      const abortController = new AbortController();
      const abortError = new Error('permission-fault queued waiter abort sentinel');
      const deadlineError = new Error('permission-fault queued waiter deadline sentinel');
      const waiterOptions = {
        root,
        workspaceRoot: root,
        command: `${mode}-cleanup-waiter`,
        pollMs: 10,
        abortSignal: abortController.signal,
        deadlineAt: Date.now() + 5000,
        deadlineError: () => deadlineError,
      };
      let waiterEntered = false;
      const waiter = withWorkspaceValidationCapacity(waiterOptions, () => { waiterEntered = true; });
      assert.equal(await waitForCapacityTicketCount(root, 2), true,
        `${mode}: owner and queued waiter must both publish unique tickets before the permission fault`);
      chmodSync(lockRoot, 0o555);
      if (mode === 'abort') abortController.abort(abortError);
      else waiterOptions.deadlineAt = Date.now() + 40;

      let observedError: unknown;
      try { await waiter; } catch (error) { observedError = error; }
      assert.equal(observedError, mode === 'abort' ? abortError : deadlineError,
        `${mode}: cleanup isolation failure must preserve the original wait classification and error object`);
      assert.equal(waiterEntered, false, `${mode}: failed waiter must never enter its callback`);
      assert.equal(ownerExited, false, `${mode}: waiter cleanup must not affect the active owner`);
      assert.equal(capacityTicketPaths(root).length, 2,
        `${mode}: permission fault must retain owner plus released-marker waiter tickets before repair`);

      chmodSync(lockRoot, 0o755);
      releaseOwner();
      await owner;
      owner = null;
      assert.equal(capacityTicketPaths(root).length, 1,
        `${mode}: owner release must leave only the failed waiter's exact ticket`);
      let successorEntered = false;
      await withWorkspaceValidationCapacity({
        root,
        workspaceRoot: root,
        command: `${mode}-cleanup-successor`,
        deadlineAt: Date.now() + 1000,
      }, () => { successorEntered = true; });
      assert.equal(successorEntered, true,
        `${mode}: post-repair successor must mechanically reclaim the failed waiter's released ticket`);
      assert.equal(capacityTicketPaths(root).length, 0, `${mode}: successor release must leave no ticket leak`);
    } finally {
      try { chmodSync(lockRoot, 0o755); } catch { /* fixture may not have created the lock root */ }
      releaseOwner();
      if (owner) await owner.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }

  const cliFixture = setupFixture({ storyId: 'B-capacity-cli-watchdog' });
  let releaseCliOwner: () => void = () => {};
  let cliOwner: Promise<void> | null = null;
  try {
    let ownerReady!: () => void;
    const ready = new Promise<void>(resolveReady => { ownerReady = resolveReady; });
    const held = new Promise<void>(resolveRelease => { releaseCliOwner = resolveRelease; });
    cliOwner = withWorkspaceValidationCapacity({
      root: cliFixture.root,
      workspaceRoot: cliFixture.root,
      requireGitIdentity: true,
      command: 'cli-watchdog-owner',
    }, async () => {
      ownerReady();
      await held;
    });
    await ready;

    const waiter = spawnValidate(cliFixture.root, cliFixture.storyId, 'cli-watchdog-waiter', {
      PROOF_OR_STOP_MAX_TIMEOUT_MS: '250',
      PROOF_OR_STOP_IDLE_TIMEOUT_MS: '5000',
    });
    assert.equal(await waitForCapacityTicketCount(cliFixture.root, 2), true,
      'real validate CLI must publish one queued ticket behind the active workspace owner');
    assert.equal(enteredCount(cliFixture.root), 0,
      'queued validate CLI must not enter the configured validation callback');
    assert.equal(existsSync(validationExecutionLockPath(cliFixture.root, cliFixture.storyId)), false,
      'queued validate CLI must not enter the inner story lock before capacity');
    const result = await waitChild(waiter, 5000);
    assert.equal(result.code, 1, result.output);
    assert.match(waiter.stderr(), /validate failed: CLI max timeout exceeded 250ms/,
      `direct validate watchdog must terminate through the structured deadline channel: ${waiter.stderr()}`);
    assert.equal(waiter.stdout().trim(), '', 'timed-out --json validate must not emit a partial stdout payload');
    assert.equal(enteredCount(cliFixture.root), 0,
      'watchdog cancellation must stop before callback entry');
    assert.equal(existsSync(validationExecutionLockPath(cliFixture.root, cliFixture.storyId)), false,
      'watchdog cancellation must never acquire the inner story lock');
    assert.equal(capacityTicketPaths(cliFixture.root).length, 1,
      'structured cancellation must remove the waiter ticket and leave only the live owner');

    releaseCliOwner();
    await cliOwner;
    cliOwner = null;
    assert.equal(capacityTicketPaths(cliFixture.root).length, 0,
      'owner release after CLI cancellation must leave no ticket requiring successor reclaim');
    let successorEntered = false;
    await withWorkspaceValidationCapacity({
      root: cliFixture.root,
      workspaceRoot: cliFixture.root,
      requireGitIdentity: true,
      command: 'cli-watchdog-successor',
      deadlineAt: Date.now() + 1000,
    }, () => { successorEntered = true; });
    assert.equal(successorEntered, true,
      'successor must acquire directly after watchdog cleanup without first recovering a leaked waiter');
  } finally {
    releaseCliOwner();
    if (cliOwner) await cliOwner.catch(() => undefined);
    rmSync(cliFixture.root, { recursive: true, force: true });
  }
}

async function assertCapacityRepositoryScopeAndSelectiveModes(): Promise<void> {
  const first = setupFixture({ storyId: 'B-cap-scope' });
  const second = setupFixture({ storyId: 'B-independent' });
  const linked = join(tmpdir(), `proof-or-stop-capacity-linked-${process.pid}-${Date.now()}`);
  const wrapper = mkdtempSync(join(tmpdir(), 'proof-or-stop-capacity-wrapper-'));
  try {
    git(first.root, ['worktree', 'add', '-b', `capacity-linked-${Date.now()}`, linked]);
    assert.equal(validationCapacityLockPath(first.root), validationCapacityLockPath(linked),
      'linked worktrees must resolve one git-common-dir capacity path');
    assert.notEqual(validationCapacityLockPath(first.root), validationCapacityLockPath(second.root),
      'independent repositories must not share capacity');

    let wrapperEntered = false;
    await withWorkspaceValidationCapacity({
      root: wrapper,
      workspaceRoot: first.root,
      requireGitIdentity: true,
      command: 'validate',
    }, () => {
      wrapperEntered = true;
      assert.equal(capacityTicketPaths(first.root).length, 1,
        'metadata wrapper must place capacity under the signed git workspace common dir');
      assert.equal(existsSync(join(wrapper, PROOF_OR_STOP_DIR, 'locks/validation-capacity.lock')), false,
        'metadata wrapper must not mint a split capacity root');
    });
    assert.equal(wrapperEntered, true);
    await assert.rejects(
      () => withWorkspaceValidationCapacity({
        root: wrapper,
        workspaceRoot: wrapper,
        requireGitIdentity: true,
        command: 'validate',
      }, () => undefined),
      /cannot resolve git-common-dir identity/,
      'expected git identity failure must fail closed instead of falling back to metadataRoot',
    );

    const holder = spawnValidate(first.root, first.storyId, 'selective-holder');
    assert.equal(await waitForEntered(first.root, 1, 4000), true);
    const selective = spawnCommand(linked, ['validate', '--concept', '--json'], 'selective-contender');
    assert.equal(await waitForOutput(selective, /waiting for workspace validation capacity/, 4000), true,
      `selective mode must visibly wait; output=${selective.output()}`);
    release(first.root);
    const [holderResult, selectiveResult] = await Promise.all([
      waitChild(holder, 12000), waitChild(selective, 12000),
    ]);
    assert.equal(holderResult.code, 0, holderResult.output);
    assert.equal(selectiveResult.code, 0, selectiveResult.output);
    assert.doesNotMatch(selective.stdout(), /waiting for workspace validation capacity/,
      'capacity progress must not pollute JSON stdout');
    assert.match(selective.stderr(), /waiting for workspace validation capacity/);
    assert.doesNotThrow(() => JSON.parse(selective.stdout().trim()),
      `queued --json stdout must remain parseable: ${selective.stdout()}`);

    const verifierSource = readFileSync(join(repoRoot(), 'packages/main/src/handlers/verifier.ts'), 'utf8');
    const doneSource = readFileSync(join(repoRoot(), 'packages/main/src/handlers/done-required-validation.ts'), 'utf8');
    const verdictSource = readFileSync(join(repoRoot(), 'packages/main/src/handlers/verdict.ts'), 'utf8');
    assert.match(verifierSource, /return await withOfficialValidationExecution[\s\S]*if \(args\.channel \|\| args\.concept \|\| args\.lint\)/,
      'all selective validate returns must be below the official capacity boundary');
    assert.match(doneSource, /return await withOfficialValidationExecution/,
      'done_required_validate must use the same official capacity boundary');
    assert.match(verdictSource, /submitWithDerivedBindings[\s\S]*return withOfficialValidationExecution/,
      'derived verdict binding must not bypass the validation writer capacity boundary');
    assert.doesNotMatch(verdictSource, /withValidationExecutionLock/,
      'production derived verdict binding must not call the inner story lock directly');
  } finally {
    try { git(first.root, ['worktree', 'remove', '--force', linked]); } catch { /* fixture cleanup */ }
    rmSync(linked, { recursive: true, force: true });
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
    rmSync(wrapper, { recursive: true, force: true });
  }
}

function assertProtectedInventoryAndTimeoutSourcesUnchanged(): void {
  // B-cc10 CHK-007: `git diff -- <path>` on a path that does not exist on EITHER side
  // silently diffs nothing and passes vacuously, so naming only one config spelling
  // would quietly stop protecting this file after the rename. Both accepted spellings
  // are listed so whichever one the checkout has is really compared.
  const protectedFiles = [
    ...CONFIG_FILENAMES,
    'package.json',
    'packages/main/package.json',
    'packages/main/src/tasks/full-suite-runner.ts',
    'packages/main/src/tasks/full-suite-runner-smoke.ts',
  ];
  assert.doesNotThrow(() => execFileSync('git', [
    'diff', '--exit-code', 'main...HEAD', '--', ...protectedFiles,
  ], { cwd: repoRoot(), stdio: ['ignore', 'pipe', 'pipe'] }),
  'CHK-003 adversarial inventory proof requires zero story-branch diff over protected command/timeout sources');
  assert.doesNotThrow(() => execFileSync('git', [
    'diff', '--exit-code', 'HEAD', '--', ...protectedFiles,
  ], { cwd: repoRoot(), stdio: ['ignore', 'pipe', 'pipe'] }),
  'CHK-003 adversarial inventory proof requires zero uncommitted diff over protected command/timeout sources');

  const runnerSource = readFileSync(join(repoRoot(), 'packages/main/src/tasks/full-suite-runner.ts'), 'utf8');
  const smokeSource = readFileSync(join(repoRoot(), 'packages/main/src/tasks/full-suite-runner-smoke.ts'), 'utf8');
  assert.match(runnerSource, /120_000|120000/, '120-second member timeout source must remain present');
  assert.match(runnerSource + smokeSource, /180_000|180000/, '180-second member timeout source must remain present');
  assert.match(runnerSource + smokeSource, /300_000|300000/, '300-second proof threshold source must remain present');
}

function assertCapacityReclaimImplementationIsIdentityStable(): void {
  const source = readFileSync(join(repoRoot(), 'packages/main/src/core/validation-execution-lock.ts'), 'utf8');
  const start = source.indexOf('export async function withWorkspaceValidationCapacity');
  const end = source.indexOf('export async function withOfficialValidationExecution', start);
  assert.ok(start >= 0 && end > start, 'capacity implementation source section must be locatable');
  const capacitySource = source.slice(start, end);
  assert.doesNotMatch(capacitySource, /acquireMkdirLock\(/,
    'capacity reclaim must not delegate a classified ticket to fixed-path recursive removal');
  assert.match(source, /renameSync\(candidatePath, quarantinePath\)/,
    'capacity reclaim must atomically isolate the exact classified UUID ticket');
  assert.match(source, /writeValidationHeartbeat\(preparingPath, holder\);\s*renameSync\(preparingPath, path\)/,
    'capacity choosing publication must occur atomically only after holder and heartbeat metadata are complete');
  assert.match(source, /rmSync\(quarantinePath, \{ recursive: true, force: true \}\)/,
    'capacity reclaim may recursively remove only its unique quarantine');
  assert.match(source, /!quarantineValidationCapacityCandidate\(candidate\.path, 'stale'\) && existsSync\(candidate\.path\)[\s\S]*active\.push\(candidate\)/,
    'failed stale isolation must remain active rather than admitting a successor');
  assert.doesNotMatch(capacitySource, /rmSync\(lockKey/,
    'capacity acquisition must never recursively remove the shared canonical capacity root');
  assert.match(source, /releaseValidationCapacityTicket[\s\S]*markValidationCapacityTicketReleased/,
    'capacity release failure must retry and mechanically mark only its exact ticket for recovery');
  assert.match(capacitySource, /if \(callbackFailed\) throw callbackError;\s*if \(releaseError\) throw releaseError;/,
    'an original callback failure must take precedence over a later release failure');
  assert.match(capacitySource, /for \(const candidatePath of \[ticketPath, choosingPath\]\)[\s\S]*await releaseValidationCapacityTicket\(candidatePath, holderInfo\)/,
    'queued waiter abort/deadline cleanup must use bounded exact-ticket release recovery');
}

function assertManagedVerificationIntentPinSchemaRoundTrip(): void {
  const pinnedIntent = {
    id: 'capacity-contract-pin',
    desc: 'Pinned capacity contract remains writable through the managed CLI schema.',
    type: 'cli_blackbox',
    requiredIn: 'strict',
    priority: 'must',
    plannedPathDeclarations: [{
      schemaVersion: 'proofstory.verification_planned_path_declaration.v1',
      id: 'capacity-pin-path',
      relation: 'producer_to_consumer',
      producer: {
        id: 'capacity-pin-producer', role: 'producer', expectedArtifactKind: 'source_file',
        expectedFileRef: 'packages/main/src/cli/command-schemas.ts',
        expectedSymbolOrFact: 'verificationIntentItemSchema', fileDeclarationRef: 'CHK-001:files:modify:0',
      },
      consumers: [{
        id: 'capacity-pin-consumer', role: 'consumer', expectedArtifactKind: 'handler',
        expectedFileRef: 'packages/main/src/handlers/checklist.ts',
        expectedSymbolOrFact: 'checklist_update', fileDeclarationRef: 'CHK-001:files:modify:1',
      }],
      outputFactRef: 'verificationIntent.verification',
    }],
    verification: {
      command: 'node packages/main/dist/tasks/validate-execution-lock-smoke.js --workspace-capacity-contract-only',
      selector: 'validate-execution-lock workspace capacity contract passed: 15 assertion groups',
    },
  };
  const parsed = verificationIntentSchema.parse({ happy: [pinnedIntent], edge: [], adversarial: [] });
  assert.equal(parsed.happy[0]?.type, 'cli', 'legacy cli_blackbox type must still normalize to cli');
  assert.deepEqual(parsed.happy[0]?.verification, pinnedIntent.verification,
    'managed CLI schema must round-trip an existing command/selector pin');
  assert.deepEqual(parsed.happy[0]?.plannedPathDeclarations, pinnedIntent.plannedPathDeclarations,
    'adding the pin must preserve planned path declarations');

  for (const [label, verification] of [
    ['missing selector', { command: pinnedIntent.verification.command }],
    ['missing command', { selector: pinnedIntent.verification.selector }],
    ['empty command', { command: '   ', selector: pinnedIntent.verification.selector }],
    ['empty selector', { command: pinnedIntent.verification.command, selector: '   ' }],
    ['unknown pin key', { ...pinnedIntent.verification, receipt: 'forged' }],
  ] as const) {
    assert.equal(verificationIntentSchema.safeParse({ happy: [{ ...pinnedIntent, verification }] }).success, false,
      `${label} must remain rejected by the strict shared verificationIntent schema`);
  }
  assert.equal(verificationIntentSchema.safeParse({
    happy: [{ ...pinnedIntent, unknownIntentKey: true }],
  }).success, false, 'unknown verificationIntent item keys must remain rejected');
}

void (async () => {
  try {
    await assertWorkspaceWaitAndRun();
    await assertCapacityAtomicStaleQuarantineStress();
    await assertKilledCapacityOwnerReplacement();
    await assertKilledBeforeCapacityPublicationDoesNotBlock();
    await assertCapacityStrictStaleClassifier();
    await assertCapacityAsyncWaitAbortReentrancyAndRelease();
    await assertBareNpmAndReadOnlyCommandsBypassCapacity();
    await assertDerivedVerdictCannotBypassCapacity();
    await assertNoStoryConfiguredGitRootFailureDoesNotMintWrapperCapacity();
    await assertCapacityReleaseFailureIsExplicitAndRecoverable();
    await assertQueuedWaitFailureCleanupIsRecoverable();
    await assertCapacityRepositoryScopeAndSelectiveModes();
    assertProtectedInventoryAndTimeoutSourcesUnchanged();
    assertCapacityReclaimImplementationIsIdentityStable();
    assertManagedVerificationIntentPinSchemaRoundTrip();
    if (process.argv.includes('--workspace-capacity-contract-only')) {
      console.log('validate-execution-lock workspace capacity contract passed: 15 assertion groups');
      return;
    }
    await assertPostCommandPersistenceHoldsLock();
    await assertRetiredRaceSeamIsProductionUnreachable();
    await assertDifferentWorktreesCanValidateConcurrently();
    await assertReviewerWritesAreNotBlocked();
    await assertDeliveryCheckSetIsNotBlocked();
    await assertStoryAdvanceInternalValidateDoesNotSelfLock();
    await assertDoneRequiredSharesValidateLock();
    await assertStaleLockReclaimed();
    await assertVanishedOwnerReclaimed();
    await assertMismatchedOwnerReclaimed();
    await assertReentrantButNotSiblingBypass();
    execFileSync(process.execPath, [join(repoRoot(), 'scripts/verify-performance-production.mjs')], {
      cwd: repoRoot(), stdio: 'inherit', timeout: 180000,
    });
    console.log('validate-execution-lock smoke passed: 26 assertion groups plus production regressions');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
})();

import { acquireOwnerLease, readOwnerLease } from '../core/story-owner-lease.js';
// Direct handler tests bypass the CLI ownership gate. Establish its prerequisite
// only in these disposable fixtures; production heartbeat never acquires leases.
function createVerifierHandlers(ctx: Parameters<typeof unownedcreateVerifierHandlers>[0]) {
  for (const id of ctx.store.listStoryIds()) {
    const directory = ctx.store.storyDirPath(id);
    if (!readOwnerLease(directory)) acquireOwnerLease(directory, {command:'fixture-owner',cwd:ctx.root});
  }
  return unownedcreateVerifierHandlers(ctx);
}
