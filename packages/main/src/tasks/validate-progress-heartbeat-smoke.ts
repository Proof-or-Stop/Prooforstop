#!/usr/bin/env node

/**
 * Smoke: validate progress/heartbeat protects active silent validation from
 * the CLI idle watchdog without corrupting `validate --json` stdout.
 *
 * Red baseline (before B-2fb7): a configured validate command that is active
 * but silent for ~11.5s is killed by `LATTICE_IDLE_TIMEOUT_MS=1000` when the
 * CLI watchdog checks at ~10s:
 *
 *   validate stuck: 1 seconds without output; forcing exit
 *
 * Green behavior: validate emits flushed progress/heartbeat to stderr, the
 * watchdog sees liveness, the finite command timeout is not extended or used,
 * and stdout is exactly one parseable JSON payload.
 *
 * Run:
 *   node packages/main/dist/tasks/validate-progress-heartbeat-smoke.js
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'cli.js');

const COMMAND_DURATION_MS = 11_500;
const COMMAND_TIMEOUT_MS = 20_000;
const IDLE_TIMEOUT_MS = 1_000;
const HEARTBEAT_MS = 250;

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
};

type ValidateJson = {
  allPass?: boolean;
  failureKind?: string;
  details?: string[];
  commands?: Array<{
    label?: string;
    code?: number;
    timedOut?: boolean;
    timeoutMs?: number;
    failureKind?: string;
    durationMs?: number;
  }>;
};

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function git(root: string, args: string[]): void {
  execFileSync('git', args, {
    cwd: root,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'validate-progress-heartbeat-smoke',
      GIT_AUTHOR_EMAIL: 'validate-progress-heartbeat-smoke@example.test',
      GIT_COMMITTER_NAME: 'validate-progress-heartbeat-smoke',
      GIT_COMMITTER_EMAIL: 'validate-progress-heartbeat-smoke@example.test',
    },
  });
}

function commitAll(root: string, message: string): void {
  git(root, ['add', '.']);
  git(root, ['commit', '-m', message]);
}

function setupFixture(): { root: string; started: string; finished: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-validate-heartbeat-'));
  const started = join(root, 'command-started.txt');
  const finished = join(root, 'command-finished.txt');
  write(root, 'silent-active-validate.mjs', `
import { writeFileSync } from 'node:fs';

const [started, finished, durationRaw] = process.argv.slice(2);
const durationMs = Number(durationRaw);
writeFileSync(started, 'started ' + Date.now() + '\\n', 'utf8');
await new Promise((resolve) => setTimeout(resolve, durationMs));
writeFileSync(finished, 'finished ' + Date.now() + '\\n', 'utf8');
`);
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: '.',
    rootDir: '.',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'light' },
    validate: {
      commands: [{
        label: 'silent-active-validate',
        command: process.execPath,
        args: ['silent-active-validate.mjs', started, finished, String(COMMAND_DURATION_MS)],
        timeoutMs: COMMAND_TIMEOUT_MS,
      }],
    },
  }, null, 2) + '\n');
  return { root, started, finished };
}

function setupTimeoutFixture(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-validate-heartbeat-timeout-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: '.',
    rootDir: '.',
    validate: {
      commands: [{
        label: 'true-hang',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        timeoutMs: 1_000,
      }],
    },
  }, null, 2) + '\n');
  return { root };
}

function setupStoryAdvanceFixture(): { root: string; storyId: string; started: string; finished: string } {
  const fixture = setupFixture();
  const { root } = fixture;
  const storyId = 'B-heartbeat-advance';
  write(root, '.gitignore', [
    'command-started.txt',
    'command-finished.txt',
    '.lattice/activity.jsonl',
    '.lattice/locks/',
    '',
  ].join('\n'));
  write(root, 'packages/main/src/index.ts', 'export const heartbeatAdvanceSmoke = true;\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  commitAll(root, 'seed heartbeat story_advance fixture');

  const now = '2026-07-07T00:00:00.000Z';
  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId,
    name: 'heartbeat-advance-smoke',
    title: 'Heartbeat advance smoke',
    description: 'Hermetic story proving story_advance receives validate heartbeat progress.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    currentReviewRound: now,
    riskSignals: [],
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: now }],
  } as StoryInfo);
  store.writeChecklist(storyId, {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic heartbeat verification',
      context: 'Synthetic done item for story_advance heartbeat smoke.',
      status: 'done',
      startTime: now,
      endTime: now,
    }],
  } as ChecklistData);
  commitAll(root, 'seed heartbeat story metadata');
  return { ...fixture, storyId };
}

function runCli(root: string, args: string[], ceilingMs = 25_000, env: Record<string, string> = {}): Promise<CliResult> {
  const start = Date.now();
  const child = spawn(process.execPath, [cliPath, '--root', root, ...args], {
    cwd: root,
    env: {
      ...process.env,
      LATTICE_IDLE_TIMEOUT_MS: String(IDLE_TIMEOUT_MS),
      LATTICE_MAX_TIMEOUT_MS: '30000',
      LATTICE_VALIDATE_HEARTBEAT_MS: String(HEARTBEAT_MS),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  return new Promise((resolveResult) => {
    const ceiling = setTimeout(() => {
      child.kill('SIGKILL');
      resolveResult({
        status: null,
        stdout,
        stderr: `${stderr}\nsmoke timed out waiting for validate child pid ${child.pid}`,
        elapsedMs: Date.now() - start,
      });
    }, ceilingMs);
    ceiling.unref?.();
    child.on('close', (status) => {
      clearTimeout(ceiling);
      resolveResult({ status, stdout, stderr, elapsedMs: Date.now() - start });
    });
    child.on('error', (error) => {
      clearTimeout(ceiling);
      resolveResult({
        status: null,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        elapsedMs: Date.now() - start,
      });
    });
  });
}

function configureDoneRequired(root: string, durationMs: number, timeoutMs: number): void {
  const configPath = join(root, 'lattice.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  config.doneRequiredCommands = [{
    label: 'direct-silent-done-required',
    command: process.execPath,
    args: ['-e', `setTimeout(() => process.exit(0), ${durationMs})`],
    timeoutMs,
  }];
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  commitAll(root, `configure direct DONE-required ${durationMs}/${timeoutMs}`);
}

function configureRoutineValidate(root: string, durationMs: number): void {
  const configPath = join(root, 'lattice.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    validate: { commands: Array<{ args: string[] }> };
  };
  config.validate.commands[0].args[3] = String(durationMs);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  commitAll(root, `configure routine validate ${durationMs}`);
}

function prepareDonePrepareRoutineFixture(): ReturnType<typeof setupStoryAdvanceFixture> {
  const fixture = setupStoryAdvanceFixture();
  const branch = `story/${fixture.storyId}`;
  git(fixture.root, ['checkout', '-b', branch]);
  const store = new StoryStore(fixture.root);
  const story = store.readStory(fixture.storyId);
  story.phase = 'TEST';
  story.worktree = {
    path: fixture.root,
    branch,
    createdAt: new Date().toISOString(),
  };
  story.events = [...(story.events ?? []), {
    phase: 'TEST',
    action: 'advance',
    timestamp: new Date().toISOString(),
  }];
  store.writeStory(fixture.storyId, story);
  commitAll(fixture.root, 'prepare TEST story for done_prepare routine timeout');
  return fixture;
}

async function assertDirectDoneRequiredTimeoutMatrix(): Promise<void> {
  const cases = [
    { name: 'pass', durationMs: 800, commandTimeoutMs: 5_000, idleMs: 300, maxMs: 5_000, heartbeatMs: 50, result: 'pass', layer: null },
    { name: 'command', durationMs: 2_000, commandTimeoutMs: 180, idleMs: 1_000, maxMs: 5_000, heartbeatMs: 50, result: 'timed_out', layer: 'command' },
    { name: 'idle', durationMs: 2_000, commandTimeoutMs: 5_000, idleMs: 120, maxMs: 5_000, heartbeatMs: 2_000, result: 'timed_out', layer: 'idle' },
    { name: 'max', durationMs: 2_000, commandTimeoutMs: 5_000, idleMs: 1_000, maxMs: 180, heartbeatMs: 50, result: 'timed_out', layer: 'max' },
  ] as const;
  for (const testCase of cases) {
    const fixture = setupStoryAdvanceFixture();
    try {
      configureDoneRequired(fixture.root, testCase.durationMs, testCase.commandTimeoutMs);
      const result = await runCli(fixture.root, ['done_required_validate', JSON.stringify({ storyId: fixture.storyId, json: true })], 8_000, {
        LATTICE_IDLE_TIMEOUT_MS: String(testCase.idleMs),
        LATTICE_MAX_TIMEOUT_MS: String(testCase.maxMs),
        LATTICE_VALIDATE_HEARTBEAT_MS: String(testCase.heartbeatMs),
      });
      assert.equal(
        result.status,
        testCase.result === 'pass' ? 0 : 1,
        `${testCase.name} must expose structured output with truthful shell status:\n${result.stderr}`,
      );
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.disposition, 'executed');
      assert.equal(parsed.result, testCase.result);
      assert.equal(parsed.timeoutLayer, testCase.layer);
      assert.ok(Array.isArray(parsed.refusalReasons));
      assert.match(parsed.existingEvidenceBasis, /^(fresh|stale|missing)$/);
      if (testCase.name === 'pass') assert.match(result.stderr, /validate heartbeat: command 1\/1 direct-silent-done-required/);

      if (testCase.result === 'timed_out') {
        configureDoneRequired(fixture.root, 0, 2_000);
        const retry = await runCli(fixture.root, ['done_required_validate', JSON.stringify({ storyId: fixture.storyId, json: true })], 5_000, {
          LATTICE_IDLE_TIMEOUT_MS: '1000',
          LATTICE_MAX_TIMEOUT_MS: '3000',
          LATTICE_VALIDATE_HEARTBEAT_MS: '50',
        });
        assert.equal(retry.status, 0, `${testCase.name} timeout must permit a successful immediate rerun`);
        assert.equal(JSON.parse(retry.stdout).result, 'pass', `${testCase.name} timeout must release lock/timers for immediate rerun`);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  const descendantFixture = setupStoryAdvanceFixture();
  try {
    const pidFile = join(descendantFixture.root, 'descendant.pid');
    const configPath = join(descendantFixture.root, 'lattice.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config.doneRequiredCommands = [{
      label: 'descendant-tree-timeout',
      command: process.execPath,
      args: ['-e', `const {spawn}=require('child_process');const fs=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`],
      timeoutMs: 200,
    }];
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    commitAll(descendantFixture.root, 'configure descendant timeout');
    const timed = await runCli(descendantFixture.root, ['done_required_validate', JSON.stringify({ storyId: descendantFixture.storyId, json: true })], 5_000, {
      LATTICE_IDLE_TIMEOUT_MS: '1000', LATTICE_MAX_TIMEOUT_MS: '3000', LATTICE_VALIDATE_HEARTBEAT_MS: '50',
    });
    assert.equal(timed.status, 1, 'structured command timeout must exit nonzero');
    assert.equal(JSON.parse(timed.stdout).timeoutLayer, 'command');
    assert.ok(existsSync(pidFile), 'descendant fixture must record grandchild pid');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const descendantPid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(descendantPid, 0), /ESRCH/, 'command timeout must kill descendant process group');
    configureDoneRequired(descendantFixture.root, 0, 2_000);
    const retry = await runCli(descendantFixture.root, ['done_required_validate', JSON.stringify({ storyId: descendantFixture.storyId, json: true })], 5_000, {
      LATTICE_IDLE_TIMEOUT_MS: '1000', LATTICE_MAX_TIMEOUT_MS: '3000', LATTICE_VALIDATE_HEARTBEAT_MS: '50',
    });
    assert.equal(retry.status, 0, 'descendant timeout cleanup must permit a successful immediate rerun');
    assert.equal(JSON.parse(retry.stdout).result, 'pass');
  } finally {
    rmSync(descendantFixture.root, { recursive: true, force: true });
  }
}

async function assertDonePrepareRoutineTimeoutMatrix(): Promise<void> {
  const cases = [
    { name: 'idle', idleMs: 120, maxMs: 5_000, heartbeatMs: 2_000, layer: 'idle' },
    { name: 'max', idleMs: 1_000, maxMs: 180, heartbeatMs: 50, layer: 'max' },
  ] as const;
  for (const testCase of cases) {
    const fixture = prepareDonePrepareRoutineFixture();
    try {
      configureRoutineValidate(fixture.root, 2_000);
      const result = await runCli(fixture.root, [
        'done_prepare',
        '--storyId', fixture.storyId,
        '--mergeMain=false',
        '--refreshStale=false',
        '--validate=true',
        '--json',
      ], 8_000, {
        LATTICE_IDLE_TIMEOUT_MS: String(testCase.idleMs),
        LATTICE_MAX_TIMEOUT_MS: String(testCase.maxMs),
        LATTICE_VALIDATE_HEARTBEAT_MS: String(testCase.heartbeatMs),
      });
      assert.equal(result.status, 1, `done_prepare routine ${testCase.name} timeout must exit nonzero:\n${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.status, 'blocked');
      assert.equal(parsed.blockedAt, 'validate', result.stdout);
      assert.equal(parsed.disposition, 'executed');
      assert.equal(parsed.result, 'timed_out');
      assert.equal(parsed.timeoutLayer, testCase.layer);
      assert.ok(Array.isArray(parsed.refusalReasons) && parsed.refusalReasons.length > 0);
      assert.equal(parsed.existingEvidenceBasis, 'stale');

      configureRoutineValidate(fixture.root, 0);
      const retry = await runCli(fixture.root, ['validate', '--story', fixture.storyId, '--json'], 5_000, {
        LATTICE_IDLE_TIMEOUT_MS: '1000',
        LATTICE_MAX_TIMEOUT_MS: '3000',
        LATTICE_VALIDATE_HEARTBEAT_MS: '50',
      });
      assert.equal(retry.status, 0, `${testCase.name} timeout must release locks/timers for an immediate validation rerun`);
      const retryParsed = parseValidateJson(retry.stdout);
      const command = retryParsed.commands?.find((entry) => entry.label === 'silent-active-validate');
      assert.equal(command?.code, 0, `${testCase.name} timeout cleanup must allow the routine command to finish`);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
}

async function assertOuterWatchdogsKillDescendants(): Promise<void> {
  const cases = [
    { name: 'idle', idleMs: '500', maxMs: '5000', heartbeatMs: '2000' },
    { name: 'max', idleMs: '2000', maxMs: '700', heartbeatMs: '50' },
  ] as const;
  for (const testCase of cases) {
    const fixture = setupStoryAdvanceFixture();
    try {
      const pidFile = join(fixture.root, `${testCase.name}-descendant.pid`);
      const configPath = join(fixture.root, 'lattice.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      config.doneRequiredCommands = [{
        label: `${testCase.name}-descendant-tree-timeout`,
        command: process.execPath,
        args: ['-e', `const {spawn}=require('child_process');const fs=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`],
        timeoutMs: 5_000,
      }];
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
      writeFileSync(join(fixture.root, '.gitignore'), `${readFileSync(join(fixture.root, '.gitignore'), 'utf8')}${testCase.name}-descendant.pid\n`, 'utf8');
      commitAll(fixture.root, `configure ${testCase.name} descendant timeout`);
      const result = await runCli(fixture.root, ['done_required_validate', JSON.stringify({ storyId: fixture.storyId, json: true })], 5_000, {
        LATTICE_IDLE_TIMEOUT_MS: testCase.idleMs,
        LATTICE_MAX_TIMEOUT_MS: testCase.maxMs,
        LATTICE_VALIDATE_HEARTBEAT_MS: testCase.heartbeatMs,
      });
      assert.equal(result.status, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.result, 'timed_out');
      assert.equal(parsed.timeoutLayer, testCase.name);
      assert.ok(existsSync(pidFile));
      await new Promise((resolve) => setTimeout(resolve, 150));
      const descendantPid = Number(readFileSync(pidFile, 'utf8'));
      assert.throws(() => process.kill(descendantPid, 0), /ESRCH/, `${testCase.name} watchdog must kill descendants before structured return`);
      const terminalIndex = result.stderr.lastIndexOf('completed with structured failure');
      const heartbeatAfterTerminal = result.stderr.slice(Math.max(0, terminalIndex)).includes('validate heartbeat:');
      assert.equal(heartbeatAfterTerminal, false, `${testCase.name} timeout must not emit heartbeat after terminal output`);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
}

async function assertNonDivisibleMaxUsesNamedDeadline(): Promise<void> {
  const fixture = prepareDonePrepareRoutineFixture();
  try {
    configureRoutineValidate(fixture.root, 2_000);
    const result = await runCli(fixture.root, [
      'done_prepare',
      '--storyId', fixture.storyId,
      '--mergeMain=false',
      '--refreshStale=false',
      '--validate=true',
      '--json',
    ], 5_000, {
      LATTICE_IDLE_TIMEOUT_MS: '5000',
      LATTICE_MAX_TIMEOUT_MS: '1005',
      LATTICE_VALIDATE_HEARTBEAT_MS: '50',
    });
    assert.equal(result.status, 1, `1005ms max with 251ms watchdog polling must exit nonzero:\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, 'blocked');
    assert.equal(parsed.blockedAt, 'validate');
    assert.equal(parsed.disposition, 'executed');
    assert.equal(parsed.result, 'timed_out');
    assert.equal(parsed.timeoutLayer, 'max');
    assert.equal(parsed.existingEvidenceBasis, 'stale');
    assert.ok(!/validation failed/i.test(parsed.reason ?? ''), 'named deadline must not collapse into generic validation failure');

    configureRoutineValidate(fixture.root, 0);
    const retry = await runCli(fixture.root, ['validate', '--story', fixture.storyId, '--json'], 5_000, {
      LATTICE_IDLE_TIMEOUT_MS: '1000',
      LATTICE_MAX_TIMEOUT_MS: '3000',
      LATTICE_VALIDATE_HEARTBEAT_MS: '50',
    });
    assert.equal(retry.status, 0, 'named deadline path must preserve cleanup for immediate rerun');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function runValidate(root: string, ceilingMs?: number): Promise<CliResult> {
  return runCli(root, ['validate', '--json'], ceilingMs);
}

function parseValidateJson(stdout: string): ValidateJson {
  const trimmed = stdout.trim();
  assert.ok(trimmed.startsWith('{') && trimmed.endsWith('}'), `stdout must be a single JSON object, got:\n${stdout}`);
  return JSON.parse(trimmed) as ValidateJson;
}

function assertRedBaseline(result: CliResult, started: string, finished: string): never {
  assert.ok(
    existsSync(started),
    [
      'red baseline precondition failed: validate command never started',
      `status=${result.status}`,
      `stderr=${result.stderr.slice(0, 1200)}`,
    ].join('\n'),
  );
  assert.ok(
    !existsSync(finished),
    'red baseline precondition failed: silent command finished; repro no longer exercises idle-kill',
  );
  assert.match(
    result.stderr,
    /validate stuck: 1 seconds without output; forcing exit/,
    [
      'expected the old silent validate idle-kill transcript before the heartbeat fix',
      `status=${result.status}`,
      `elapsedMs=${result.elapsedMs}`,
      `stdout=${result.stdout.slice(0, 1200)}`,
      `stderr=${result.stderr.slice(0, 2000)}`,
    ].join('\n'),
  );
  throw new Error([
    'red repro observed: active silent validate was killed by the CLI idle watchdog before command timeoutMs',
    result.stderr.split('\n').find((line) => line.includes('without output; forcing exit')) ?? result.stderr.trim(),
    'implement JSON-safe validate progress/heartbeat to turn this smoke green',
  ].join('\n'));
}

function assertGreenBehavior(result: CliResult, started: string, finished: string): void {
  assert.equal(result.status, 0, `validate should exit 0 once heartbeat reaches the watchdog:\n${result.stderr}`);
  assert.ok(existsSync(started), 'validate command must actually start');
  assert.ok(existsSync(finished), 'validate command must actually finish');
  assert.ok(result.elapsedMs >= COMMAND_DURATION_MS, 'validate must not skip the silent command');
  assert.ok(
    !result.stderr.includes('without output; forcing exit'),
    `idle watchdog must not fire while heartbeat is active:\n${result.stderr}`,
  );
  assert.match(result.stderr, /validate progress: command 1\/1 started silent-active-validate/);
  assert.match(result.stderr, /validate heartbeat: command 1\/1 silent-active-validate elapsedMs=/);
  assert.match(result.stderr, /validate progress: command 1\/1 ended silent-active-validate/);

  const parsed = parseValidateJson(result.stdout);
  assert.equal(parsed.allPass, true, `validate JSON should report pass:\n${result.stdout}`);
  const command = parsed.commands?.find((entry) => entry.label === 'silent-active-validate');
  assert.ok(command, 'validate JSON must include the configured command result');
  assert.equal(command.code, 0, 'silent command should exit 0');
  assert.equal(command.timedOut, undefined, 'heartbeat must not convert active validation into a timeout');
  assert.ok(
    typeof command.durationMs === 'number' && command.durationMs >= COMMAND_DURATION_MS,
    'command duration proves the finite timeoutMs was not bypassed by skipping validation',
  );
}

async function assertStoryAdvanceReceivesHeartbeat(): Promise<void> {
  const { root, storyId, started, finished } = setupStoryAdvanceFixture();
  try {
    const result = await runCli(root, ['story_advance', JSON.stringify({ storyId, phase: 'TEST' })], 35_000);
    assert.equal(result.status, 0, `story_advance should survive active validate heartbeat:\n${result.stderr}\n${result.stdout}`);
    assert.ok(existsSync(started), 'story_advance internal validate command must start');
    assert.ok(existsSync(finished), 'story_advance internal validate command must finish');
    assert.ok(!result.stderr.includes('without output; forcing exit'), `story_advance must not hit idle watchdog:\n${result.stderr}`);
    assert.match(result.stderr, /validate heartbeat: command 1\/1 silent-active-validate elapsedMs=/);
    const store = new StoryStore(root);
    assert.equal(store.readStory(storyId).phase, 'TEST', 'story_advance should persist TEST phase');
    const evidence = store.readTestEvidence(storyId);
    assert.equal(evidence?.result, 'PASS', 'story_advance validate evidence should pass');
    assert.equal(evidence?.failureKind, undefined, 'passing story_advance evidence should not carry failureKind');
    const parsed = JSON.parse(evidence?.output ?? '{}') as ValidateJson;
    assert.equal(parsed.allPass, true, 'story_advance evidence output should be passing validate JSON');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertTrueHangFailsClosedWithNamedDiagnostics(): Promise<void> {
  const { root } = setupTimeoutFixture();
  try {
    const result = await runValidate(root, 15_000);
    assert.equal(result.status, 0, `validate command should return JSON even for failed validation:\n${result.stderr}`);
    assert.ok(!result.stderr.includes('without output; forcing exit'), `true hang should fail by command timeout, not idle watchdog:\n${result.stderr}`);
    assert.match(result.stderr, /validate timeout: command 1\/1 true-hang: command=.* args=.* timeoutMs=1000 elapsedMs=/);
    const parsed = parseValidateJson(result.stdout);
    assert.equal(parsed.allPass, false, 'true hang validate JSON should fail closed');
    assert.equal(parsed.failureKind, 'infra_failure', 'true hang should be classified as infra_failure');
    const command = parsed.commands?.find((entry) => entry.label === 'true-hang');
    assert.ok(command, 'true hang command result should be present');
    assert.equal(command.timedOut, true, 'true hang command must be timedOut');
    assert.equal(command.timeoutMs, 1_000, 'true hang command must preserve timeoutMs');
    assert.equal(command.failureKind, 'infra_failure', 'true hang command should carry infra_failure');
    const details = parsed.details?.join('\n') ?? '';
    assert.match(details, /timeout diagnostic: command 1\/1 "true-hang" exceeded configured timeoutMs=1000ms after elapsedMs=/);
    assert.match(details, /command: /);
    assert.match(details, /args: \["-e","setInterval\(\(\) => \{\}, 1000\)"\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void (async () => {
  const { root, started, finished } = setupFixture();
  try {
    const result = await runValidate(root);
    if (result.status !== 0) {
      assertRedBaseline(result, started, finished);
    }
    assertGreenBehavior(result, started, finished);
    const startText = readFileSync(started, 'utf8').trim();
    const finishText = readFileSync(finished, 'utf8').trim();
    assert.match(startText, /^started \d+$/);
    assert.match(finishText, /^finished \d+$/);
    await assertStoryAdvanceReceivesHeartbeat();
    await assertTrueHangFailsClosedWithNamedDiagnostics();
    await assertDirectDoneRequiredTimeoutMatrix();
    await assertDonePrepareRoutineTimeoutMatrix();
    await assertOuterWatchdogsKillDescendants();
    await assertNonDivisibleMaxUsesNamedDeadline();
    console.log('validate-progress-heartbeat smoke passed');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();
