#!/usr/bin/env node

/**
 * Smoke: validate progress/heartbeat protects active silent validation from
 * the CLI idle watchdog without corrupting `validate --json` stdout.
 *
 * Red baseline (before B-2fb7): a configured validate command that is active
 * but silent for ~11.5s is killed by `PROOF_OR_STOP_IDLE_TIMEOUT_MS=1000` when the
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
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistSyntheticAdmittedWindowForTest } from '../core/certification-window.js';
import { deriveCertificationDomainInputHashes } from '../handlers/certification-window.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { stripCanonicalBrandEnvTwins } from '../core/brand-env.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'cli.js');

const COMMAND_DURATION_MS = 11_500;
const COMMAND_TIMEOUT_MS = 20_000;
const IDLE_TIMEOUT_MS = 1_000;
const HEARTBEAT_MS = 250;
// Fixture setup and CLI startup are outside the timeout layer under test. Keep
// their guards wide so only rows explicitly named "max" exercise a tight max.
const NON_MAX_OUTER_TIMEOUT_MS = 120_000;
const NON_MAX_HARNESS_CEILING_MS = 60_000;

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
};

// A watchdog result can precede process closure. Keep those facts separate.
type CliRun = Promise<CliResult> & { closed: Promise<void> };

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

function gitOutput(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// A child CLI (or its descendant) publishes fixture files while it runs. Wait
// on the CHILD'S LIFECYCLE, not on a fixed clock: the file or the child's exit,
// whichever comes first, bounded by the child's own configured outer budget
// plus this margin (CLI boot + pre-spawn setup under load). B-83aa: a fixed
// 60s ceiling stalled a full minute for a pid file that no live process could
// write, because the child had already exited without spawning its command.
const CHILD_FILE_WAIT_MARGIN_MS = 10_000;

type StartedCliRun = { result: CliRun; kill: () => void };

type ChildFileWait =
  | { outcome: 'written' }
  | { outcome: 'exited_without_file'; result: CliResult }
  | { outcome: 'bound_expired'; result: CliResult };

function fileHasContent(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

async function waitForChildFile(run: StartedCliRun, path: string, boundMs: number): Promise<ChildFileWait> {
  let exited: CliResult | undefined;
  const settled = run.result.then((result) => { exited = result; return result; });
  const deadline = Date.now() + boundMs;
  while (true) {
    if (fileHasContent(path)) return { outcome: 'written' };
    if (exited) {
      // The file may land in the same instant the child is torn down.
      if (fileHasContent(path)) return { outcome: 'written' };
      return { outcome: 'exited_without_file', result: exited };
    }
    if (Date.now() >= deadline) {
      run.kill();
      return { outcome: 'bound_expired', result: await settled };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function commandStarted(result: CliResult, label: string): boolean {
  return result.stderr.includes(`started ${label}`);
}

function describeChildFileWait(
  wait: Exclude<ChildFileWait, { outcome: 'written' }>,
  path: string,
  label: string,
  boundMs: number,
): string {
  const { result } = wait;
  const head = wait.outcome === 'bound_expired'
    ? `child still running when the ${boundMs}ms bound (configured budget + ${CHILD_FILE_WAIT_MARGIN_MS}ms margin) expired; ${path} was not written`
    : `child exited (status=${result.status}, elapsedMs=${result.elapsedMs}) without writing ${path}: ` + (commandStarted(result, label)
      ? `the configured command "${label}" started but was killed before its descendant published a pid`
      : `the configured command "${label}" never started (the CLI's own setup consumed the outer budget)`);
  return `${head}\nstderr=${result.stderr.slice(-1500)}`;
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(existsSync(path), `timed out waiting for fixture file: ${path}`);
}

async function waitForValidationStart(started: string, finished: string, run: Promise<CliResult>, timeoutMs = 30_000): Promise<void> {
  let terminal: CliResult | undefined;
  const completion = run.then(result => { terminal = result; });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await Promise.resolve();
    assert.ok(!terminal,
      `validation child exited before readiness: status=${terminal?.status}\n${terminal?.stdout ?? ''}\n${terminal?.stderr ?? ''}`);
    assert.ok(!existsSync(finished), 'validation command already finished before foreign append');
    if (existsSync(started)) return;
    assert.ok(Date.now() < deadline, `validation readiness timed out after ${timeoutMs}ms: ${started}`);
    await Promise.race([completion, new Promise(resolve => setTimeout(resolve, 20))]);
  }
}

async function drainBeforeFixtureRemoval(run: CliRun, root: string, closeTimeoutMs = 5_000): Promise<void> {
  const result = await run;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run.closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `child closure unconfirmed; fixture retained at ${root}\n${result.stdout}\n${result.stderr}`,
        )), closeTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Parent close alone does not establish descendant cleanup after a kill.
  assert.notEqual(result.status, null,
    `abnormal child result; fixture retained at ${root}\n${result.stdout}\n${result.stderr}`);
}

function createReadinessProbe(mode: 'delayed' | 'error' | 'zero' | 'finished' | 'never'): {
  root: string; started: string; finished: string; release: string; run: CliRun;
} {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-heartbeat-readiness-'));
  const started = join(root, 'started');
  const finished = join(root, 'finished');
  const release = join(root, 'release');
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const [started, finished, release, mode] = process.argv.slice(1);
    if (mode === 'error') { console.log('probe stdout'); console.error('probe preflight failed'); process.exit(23); }
    if (mode === 'zero') process.exit(0);
    if (mode === 'never') {
      setTimeout(() => process.exit(0), 150);
    } else {
    setTimeout(() => process.exit(98), 45000).unref();
    setTimeout(() => {
      fs.writeFileSync(started, 'ready');
      if (mode === 'finished') fs.writeFileSync(finished, 'finished');
      const poll = setInterval(() => {
        if (!fs.existsSync(release)) return;
        clearInterval(poll);
        fs.writeFileSync(finished, 'finished');
      }, 20);
    }, mode === 'delayed' ? 6000 : 0);
    }
  `,
  started, finished, release, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const closed = new Promise<void>(resolveClosed => child.once('close', () => resolveClosed()));
  const run = Object.assign(new Promise<CliResult>((resolveResult) => {
    child.on('close', status => resolveResult({ status, stdout, stderr, elapsedMs: 0 }));
    child.on('error', error => { stderr += error.message; });
  }), { closed });
  return { root, started, finished, release, run };
}

async function assertDelayedFixtureReadiness(): Promise<void> {
  const { root, started, finished, release, run } = createReadinessProbe('delayed');
  try {
    await waitForValidationStart(started, finished, run);
  } finally {
    writeFileSync(release, 'release');
    const result = await run;
    await drainBeforeFixtureRemoval(run, root);
    rmSync(root, { recursive: true, force: true });
    assert.equal(result.status, 0, `delayed readiness fixture child failed: ${result.stderr}`);
  }
  console.log('B29BC_DELAYED_FIXTURE_READINESS PASS');
}

async function assertReadinessFailureControls(): Promise<void> {
  for (const mode of ['error', 'zero', 'finished', 'never'] as const) {
    const { root, started, finished, release, run } = createReadinessProbe(mode);
    try {
      if (mode === 'finished') await waitForFile(finished, 30_000);
      const expected = mode === 'error' ? /status=23[\s\S]*probe stdout[\s\S]*probe preflight failed/
        : mode === 'zero' ? /status=0/
          : mode === 'finished' ? /already finished/ : /readiness timed out/;
      await assert.rejects(waitForValidationStart(started, finished, run, mode === 'never' ? 40 : 30_000), expected);
    } finally {
      writeFileSync(release, 'release');
      await drainBeforeFixtureRemoval(run, root);
      rmSync(root, { recursive: true, force: true });
    }
  }
  // Model the harness result settling before the actual process close event.
  for (const confirmClose of [true, false]) {
    const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-heartbeat-close-'));
    let close!: () => void;
    const run = Object.assign(Promise.resolve<CliResult>({ status: 0, stdout: '', stderr: '', elapsedMs: 0 }), {
      closed: new Promise<void>(resolve => { close = resolve; }),
    });
    try {
      const cleanup = drainBeforeFixtureRemoval(run, root, 100).then(() => rmSync(root, { recursive: true, force: true }));
      if (confirmClose) {
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(existsSync(root), 'result settlement must not authorize fixture deletion');
        close();
        await cleanup;
        assert.ok(!existsSync(root));
      } else {
        await assert.rejects(cleanup, /closure unconfirmed; fixture retained/);
        assert.ok(existsSync(root), 'unconfirmed closure must preserve the fixture');
      }
    } finally {
      close();
      rmSync(root, { recursive: true, force: true });
    }
  }
  const abnormalRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-heartbeat-abnormal-'));
  try {
    const killed = Object.assign(Promise.resolve<CliResult>({ status: null, stdout: '', stderr: 'harness killed child', elapsedMs: 0 }), {
      closed: Promise.resolve(),
    });
    await assert.rejects(drainBeforeFixtureRemoval(killed, abnormalRoot), /abnormal child result; fixture retained/);
    assert.ok(existsSync(abnormalRoot), 'parent closure after a kill must not imply descendant cleanup');
  } finally {
    rmSync(abnormalRoot, { recursive: true, force: true });
  }
  console.log('B29BC_READINESS_TERMINAL_AND_CLOSE_CONTROLS PASS');
}

function commitAll(root: string, message: string): void {
  git(root, ['add', '.']);
  git(root, ['commit', '-m', message]);
}

function setupFixture(): { root: string; started: string; finished: string } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-validate-heartbeat-'));
  const started = join(root, 'command-started.txt');
  const finished = join(root, 'command-finished.txt');
  write(root, '.gitignore', [
    'command-started.txt',
    'command-finished.txt',
    '.lattice/activity.jsonl',
    '.lattice/locks/',
    '.proof-or-stop/locks/',
    '',
  ].join('\n'));
  write(root, 'silent-active-validate.mjs', `
import { writeFileSync } from 'node:fs';

const [started, finished, durationRaw] = process.argv.slice(2);
const durationMs = Number(durationRaw);
writeFileSync(started, 'started ' + Date.now() + '\\n', 'utf8');
await new Promise((resolve) => setTimeout(resolve, durationMs));
writeFileSync(finished, 'finished ' + Date.now() + '\\n', 'utf8');
`);
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: '.',
    rootDir: '.',
    storyDir: '.proof-or-stop/story/actives',
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
  // Routine validation now binds lock and evidence paths through Git even for
  // an unscoped invocation.  Make the direct heartbeat fixture a clean Git
  // repository, just as the story_advance fixture below already does.
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  commitAll(root, 'seed validate heartbeat fixture');
  return { root, started, finished };
}

function setupTimeoutFixture(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-validate-heartbeat-timeout-'));
  write(root, '.gitignore', '.proof-or-stop/locks/\n');
  write(root, 'proof-or-stop.config.json', JSON.stringify({
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
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  commitAll(root, 'seed validate timeout fixture');
  return { root };
}

function setupStoryAdvanceFixture(): { root: string; storyId: string; started: string; finished: string } {
  const fixture = setupFixture();
  const { root } = fixture;
  const storyId = 'B-heartbeat-advance';

  write(root, 'packages/main/src/index.ts', 'export const heartbeatAdvanceSmoke = true;\n');
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
  persistFixtureCertificationWindow(store, storyId, root);
  return { ...fixture, storyId };
}

function persistFixtureCertificationWindow(store: StoryStore, storyId: string, root: string): void {
  const causalInputHashes = deriveCertificationDomainInputHashes(root, 'HEAD', root);
  assert.ok(causalInputHashes, 'synthetic certification fixture must derive causal input hashes');
  persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes });
}

function admitSyntheticWindow(root: string, storyId: string): void {
  persistFixtureCertificationWindow(new StoryStore(root), storyId, root);
}

function startCli(root: string, args: string[], ceilingMs = NON_MAX_HARNESS_CEILING_MS, env: Record<string, string> = {}): StartedCliRun {
  const start = Date.now();
  const inheritedEnv = stripCanonicalBrandEnvTwins(
    { ...process.env },
    ['IDLE_TIMEOUT_MS', 'MAX_TIMEOUT_MS', 'VALIDATE_HEARTBEAT_MS'],
  );
  const child = spawn(process.execPath, [cliPath, '--root', root, ...args], {
    cwd: root,
    // Remove caller-owned canonical knobs BEFORE installing the fixture's own
    // canonical pins. Clean-break brand-env has no legacy twin to fall back to;
    // stripping the composed object would delete the values this test just set.
    env: {
      ...inheritedEnv,
      PROOF_OR_STOP_IDLE_TIMEOUT_MS: String(IDLE_TIMEOUT_MS),
      PROOF_OR_STOP_MAX_TIMEOUT_MS: String(NON_MAX_OUTER_TIMEOUT_MS),
      PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: String(HEARTBEAT_MS),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  const closed = new Promise<void>(resolveClosed => child.once('close', () => resolveClosed()));
  const result = Object.assign(new Promise<CliResult>((resolveResult) => {
    let ceilingTriggered = false;
    const ceiling = setTimeout(() => {
      ceilingTriggered = true;
      killCliProcessTree(child.pid);
    }, ceilingMs);
    ceiling.unref?.();
    child.on('close', (status) => {
      clearTimeout(ceiling);
      resolveResult({
        status: ceilingTriggered ? null : status,
        stdout,
        stderr: ceilingTriggered ? `${stderr}\nsmoke timed out waiting for validate child pid ${child.pid}` : stderr,
        elapsedMs: Date.now() - start,
      });
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
  }), { closed });
  return {
    result,
    kill: () => killCliProcessTree(child.pid),
  };
}

function killCliProcessTree(rootPid: number | undefined): void {
  if (!rootPid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(rootPid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // The process may already have exited between the lifecycle check and cleanup.
    }
    return;
  }
  const children = new Map<number, number[]>();
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
    for (const row of rows.split('\n')) {
      const [pidText, parentText] = row.trim().split(/\s+/);
      const pid = Number(pidText);
      const parent = Number(parentText);
      if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
      const siblings = children.get(parent) ?? [];
      siblings.push(pid);
      children.set(parent, siblings);
    }
  } catch {
    // Fall through to killing the known root when process enumeration fails.
  }
  const descendants: number[] = [];
  const visit = (pid: number): void => {
    for (const childPid of children.get(pid) ?? []) visit(childPid);
    if (pid !== rootPid) descendants.push(pid);
  };
  visit(rootPid);
  for (const pid of [...descendants, rootPid]) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

function runCli(root: string, args: string[], ceilingMs = NON_MAX_HARNESS_CEILING_MS, env: Record<string, string> = {}): CliRun {
  return startCli(root, args, ceilingMs, env).result;
}

// A platform-neutral hanging DONE-required command whose descendant publishes
// its pid as soon as Node spawns it. The descendant inherits the command's
// process group, which is exactly what each validation timeout must terminate.
function descendantTreeCommand(label: string, pidFile: string, timeoutMs: number, startupDelayMs = 0) {
  const script = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${startupDelayMs});`,
    'const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });',
    'writeFileSync(process.argv[1], `${descendant.pid}\\n`);',
    'descendant.on("exit", () => process.exit(0));',
    'setInterval(() => {}, 600000);',
  ].join('');
  return {
    label,
    command: process.execPath,
    args: ['-e', script, pidFile],
    timeoutMs,
  };
}

interface DescendantKillRow {
  layer: 'command' | 'idle' | 'max';
  /** Budget of the layer under test; doubled only after a vacuous attempt. */
  baseBudgetMs: number;
  /** Optional pre-spawn delay proving that cleanup does not rely on immediate command startup. */
  startupDelayMs?: number;
  /** Command timeoutMs + watchdog env so the layer under test is the FIRST deadline able to fire. */
  plan(budgetMs: number): { commandTimeoutMs: number; env: Record<string, string> };
  killMessage: string;
  extraAssertions?(result: CliResult): void;
}

const DESCENDANT_KILL_ESCALATIONS = 5;

// Proves "<layer> timeout kills the command's descendants before the structured
// return". The idle/max layers are wall-clock deadlines counted from CLI start,
// and the CLI's own pre-spawn setup (worktree/cwd checks, capacity lock with
// git probes, status probe) takes a load-dependent share of that clock: 0.4-0.7s
// alone, 1.8-2.2s under a fork-heavy sibling load (B-83aa reproduction). When
// the layer fires before the command is even spawned, the run is VACUOUS - the
// layer classification is still asserted, but there is no descendant to prove
// killed - so the budget is doubled and the attempt repeated, bounded, instead
// of betting a fixed clock. Only an attempt where the descendant actually
// published its pid can pass; a published-but-alive descendant fails outright.
async function proveTimeoutLayerKillsDescendant(
  fixture: { root: string; storyId: string },
  pidFile: string,
  row: DescendantKillRow,
): Promise<void> {
  const label = `${row.layer}-descendant-tree-timeout`;
  const configPath = join(fixture.root, 'proof-or-stop.config.json');
  const gitignorePath = join(fixture.root, '.gitignore');
  const ignored = readFileSync(gitignorePath, 'utf8');
  if (!ignored.split('\n').includes(basename(pidFile))) {
    writeFileSync(gitignorePath, `${ignored}${basename(pidFile)}\n`, 'utf8');
  }
  const vacuous: string[] = [];
  for (let attempt = 0; attempt < DESCENDANT_KILL_ESCALATIONS; attempt++) {
    const budgetMs = row.baseBudgetMs * 2 ** attempt;
    const { commandTimeoutMs, env } = row.plan(budgetMs);
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config.doneRequiredCommands = [descendantTreeCommand(label, pidFile, commandTimeoutMs, row.startupDelayMs)];
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    rmSync(pidFile, { force: true });
    commitAll(fixture.root, `configure ${label} budget ${budgetMs}`);
    admitSyntheticWindow(fixture.root, fixture.storyId);
    const run = startCli(fixture.root, ['done_required_validate', JSON.stringify({ storyId: fixture.storyId, json: true })], NON_MAX_HARNESS_CEILING_MS, env);
    const boundMs = budgetMs + CHILD_FILE_WAIT_MARGIN_MS;
    let descendantPid: number | null = null;
    try {
      const wait = await waitForChildFile(run, pidFile, boundMs);
      const result = await run.result;
      if (wait.outcome === 'bound_expired') {
        assert.fail(`${label}: ${describeChildFileWait(wait, pidFile, label, boundMs)}`);
      }
      assert.equal(result.status, 1, `${label}: structured ${row.layer} timeout must exit nonzero:\n${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.result, 'timed_out', `${label}: budget ${budgetMs}ms must report timed_out`);
      assert.equal(parsed.timeoutLayer, row.layer, `${label}: budget ${budgetMs}ms must attribute the ${row.layer} layer`);
      row.extraAssertions?.(result);
      if (wait.outcome === 'exited_without_file') {
        vacuous.push(`budget ${budgetMs}ms: ${describeChildFileWait(wait, pidFile, label, boundMs)}`);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      const pidText = readFileSync(pidFile, 'utf8').trim();
      descendantPid = Number(pidText);
      assert.ok(Number.isInteger(descendantPid) && descendantPid > 0, `${label}: pid file must hold the descendant pid, got "${pidText}"`);
      assert.throws(() => process.kill(descendantPid as number, 0), /ESRCH/, row.killMessage);
      return;
    } finally {
      run.kill();
      await run.result;
      if (descendantPid === null && fileHasContent(pidFile)) descendantPid = Number(readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(descendantPid) && (descendantPid as number) > 0) {
        try { process.kill(descendantPid as number, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  }
  assert.fail([
    `${label}: the ${row.layer} layer fired before the command published a descendant in all ${DESCENDANT_KILL_ESCALATIONS} escalating budgets, so the kill property could not be observed:`,
    ...vacuous,
  ].join('\n'));
}

function configureDoneRequired(root: string, durationMs: number, timeoutMs: number): void {
  const configPath = join(root, 'proof-or-stop.config.json');
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
  const configPath = join(root, 'proof-or-stop.config.json');
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
    { name: 'pass', durationMs: 800, commandTimeoutMs: 5_000, idleMs: 300, maxMs: NON_MAX_OUTER_TIMEOUT_MS, heartbeatMs: 50, result: 'pass', layer: null },
    { name: 'command', durationMs: 2_000, commandTimeoutMs: 180, idleMs: 1_000, maxMs: NON_MAX_OUTER_TIMEOUT_MS, heartbeatMs: 50, result: 'timed_out', layer: 'command' },
    { name: 'idle', durationMs: 2_000, commandTimeoutMs: 5_000, idleMs: 120, maxMs: NON_MAX_OUTER_TIMEOUT_MS, heartbeatMs: 2_000, result: 'timed_out', layer: 'idle' },
    { name: 'max', durationMs: 2_000, commandTimeoutMs: 5_000, idleMs: 1_000, maxMs: 180, heartbeatMs: 50, result: 'timed_out', layer: 'max' },
  ] as const;
  for (const testCase of cases) {
    const fixture = setupStoryAdvanceFixture();
    try {
      configureDoneRequired(fixture.root, testCase.durationMs, testCase.commandTimeoutMs);
      admitSyntheticWindow(fixture.root, fixture.storyId);
      const result = await runCli(fixture.root, ['done_required_validate', JSON.stringify({ storyId: fixture.storyId, json: true })], NON_MAX_HARNESS_CEILING_MS, {
        PROOF_OR_STOP_IDLE_TIMEOUT_MS: String(testCase.idleMs),
        PROOF_OR_STOP_MAX_TIMEOUT_MS: String(testCase.maxMs),
        PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: String(testCase.heartbeatMs),
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
        admitSyntheticWindow(fixture.root, fixture.storyId);
        const retry = await runCli(fixture.root, ['done_required_validate', JSON.stringify({ storyId: fixture.storyId, json: true })], NON_MAX_HARNESS_CEILING_MS, {
          PROOF_OR_STOP_IDLE_TIMEOUT_MS: '1000',
          PROOF_OR_STOP_MAX_TIMEOUT_MS: String(NON_MAX_OUTER_TIMEOUT_MS),
          PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: '50',
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
    await proveTimeoutLayerKillsDescendant(descendantFixture, pidFile, {
      layer: 'command',
      baseBudgetMs: 200,
      // The command deadline counts from the spawn; keep idle/max at the wide
      // outer budget so no watchdog can fire during pre-spawn silence.
      plan: (budgetMs) => ({
        commandTimeoutMs: budgetMs,
        env: {
          PROOF_OR_STOP_IDLE_TIMEOUT_MS: String(NON_MAX_OUTER_TIMEOUT_MS),
          PROOF_OR_STOP_MAX_TIMEOUT_MS: String(NON_MAX_OUTER_TIMEOUT_MS),
          PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: '50',
        },
      }),
      killMessage: 'command timeout must kill descendant process group',
    });
    configureDoneRequired(descendantFixture.root, 0, 2_000);
    admitSyntheticWindow(descendantFixture.root, descendantFixture.storyId);
    const retry = await runCli(descendantFixture.root, ['done_required_validate', JSON.stringify({ storyId: descendantFixture.storyId, json: true })], NON_MAX_HARNESS_CEILING_MS, {
      PROOF_OR_STOP_IDLE_TIMEOUT_MS: '1000', PROOF_OR_STOP_MAX_TIMEOUT_MS: String(NON_MAX_OUTER_TIMEOUT_MS), PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: '50',
    });
    assert.equal(retry.status, 0, 'descendant timeout cleanup must permit a successful immediate rerun');
    assert.equal(JSON.parse(retry.stdout).result, 'pass');
  } finally {
    rmSync(descendantFixture.root, { recursive: true, force: true });
  }
}

async function assertDonePrepareRoutineTimeoutMatrix(): Promise<void> {
  const cases = [
    { name: 'idle', idleMs: 120, maxMs: NON_MAX_OUTER_TIMEOUT_MS, heartbeatMs: 2_000, layer: 'idle' },
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
      ], NON_MAX_HARNESS_CEILING_MS, {
        PROOF_OR_STOP_IDLE_TIMEOUT_MS: String(testCase.idleMs),
        PROOF_OR_STOP_MAX_TIMEOUT_MS: String(testCase.maxMs),
        PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: String(testCase.heartbeatMs),
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
      const retry = await runCli(fixture.root, ['validate', '--story', fixture.storyId, '--json'], NON_MAX_HARNESS_CEILING_MS, {
        PROOF_OR_STOP_IDLE_TIMEOUT_MS: '1000',
        PROOF_OR_STOP_MAX_TIMEOUT_MS: String(NON_MAX_OUTER_TIMEOUT_MS),
        PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: '50',
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
  const noHeartbeatAfterTerminal = (name: string) => (result: CliResult): void => {
    const terminalIndex = result.stderr.lastIndexOf('completed with structured failure');
    const heartbeatAfterTerminal = result.stderr.slice(Math.max(0, terminalIndex)).includes('validate heartbeat:');
    assert.equal(heartbeatAfterTerminal, false, `${name} timeout must not emit heartbeat after terminal output`);
  };
  const rows: DescendantKillRow[] = [
    {
      layer: 'idle',
      baseBudgetMs: 500,
      // Idle counts from the last output line; a heartbeat slower than idle lets
      // it fire during the command, and the command timeout stays well behind.
      plan: (budgetMs) => ({
        commandTimeoutMs: budgetMs * 10,
        env: {
          PROOF_OR_STOP_IDLE_TIMEOUT_MS: String(budgetMs),
          PROOF_OR_STOP_MAX_TIMEOUT_MS: String(NON_MAX_OUTER_TIMEOUT_MS),
          PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: String(budgetMs * 4),
        },
      }),
      killMessage: 'idle watchdog must kill descendants before structured return',
      extraAssertions: noHeartbeatAfterTerminal('idle'),
    },
    {
      layer: 'max',
      baseBudgetMs: 10_000,
      startupDelayMs: 1_000,
      // This row proves cleanup of an existing descendant, not CLI startup speed.
      // Give fixture/CLI startup explicit headroom and deliberately delay the
      // configured command before it spawns; the separate tight-max rows still
      // pin production deadline enforcement.
      plan: (budgetMs) => ({
        commandTimeoutMs: budgetMs * 2,
        env: {
          PROOF_OR_STOP_IDLE_TIMEOUT_MS: String(Math.max(20_000, budgetMs * 2)),
          PROOF_OR_STOP_MAX_TIMEOUT_MS: String(budgetMs),
          PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: '50',
        },
      }),
      killMessage: 'max watchdog must kill descendants before structured return',
      extraAssertions: noHeartbeatAfterTerminal('max'),
    },
  ];
  for (const row of rows) {
    const fixture = setupStoryAdvanceFixture();
    try {
      const pidFile = join(fixture.root, `${row.layer}-descendant.pid`);
      await proveTimeoutLayerKillsDescendant(fixture, pidFile, row);
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
    ], NON_MAX_HARNESS_CEILING_MS, {
      PROOF_OR_STOP_IDLE_TIMEOUT_MS: '5000',
      PROOF_OR_STOP_MAX_TIMEOUT_MS: '1005',
      PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: '50',
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
    const retry = await runCli(fixture.root, ['validate', '--story', fixture.storyId, '--json'], NON_MAX_HARNESS_CEILING_MS, {
      PROOF_OR_STOP_IDLE_TIMEOUT_MS: '1000',
      PROOF_OR_STOP_MAX_TIMEOUT_MS: String(NON_MAX_OUTER_TIMEOUT_MS),
      PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: '50',
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
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const result = await runCli(root, ['story_advance', JSON.stringify({ storyId, phase: 'TEST' })], NON_MAX_HARNESS_CEILING_MS);
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
    const processEventsRel = `.proof-or-stop/story/actives/${storyId}/process-events.jsonl`;
    assert.equal(
      gitOutput(root, ['status', '--porcelain=v1', '--', processEventsRel]),
      '',
      'direct-handler validation_terminal must be closed by the same exact TEST-transition transaction',
    );
    const committedEvents = gitOutput(root, ['show', `HEAD:${processEventsRel}`]);
    assert.match(committedEvents, /"type":"validation_terminal"/,
      'TEST-transition commit must retain the invocation-owned direct-handler validation terminal');
    assert.match(committedEvents, /"type":"phase_transition"/,
      'TEST-transition commit must retain the later phase transition in the same bounded event path');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertMainDirectHandlerClosesTerminal(): Promise<void> {
  const { root, storyId } = setupStoryAdvanceFixture();
  try {
    configureRoutineValidate(root, 0);
    const result = await runCli(
      root,
      ['story_advance', JSON.stringify({ storyId, phase: 'TEST' })],
      NON_MAX_HARNESS_CEILING_MS,
    );
    assert.equal(result.status, 0,
      `main-branch direct verifier terminal must close independently:\n${result.stderr}\n${result.stdout}`);
    const processEventsRel = `.proof-or-stop/story/actives/${storyId}/process-events.jsonl`;
    assert.equal(gitOutput(root, ['status', '--porcelain=v1', '--', processEventsRel]), '');
    const committedEvents = gitOutput(root, ['show', `HEAD:${processEventsRel}`]);
    assert.match(committedEvents, /"type":"validation_terminal"/);
    assert.match(committedEvents, /"type":"phase_transition"/);
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'TEST');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertMidValidationForeignAppendFailsClosed(): Promise<void> {
  const { root, storyId, started, finished } = setupStoryAdvanceFixture();
  const release = join(root, 'command-release.txt');
  let run: CliRun | undefined;
  try {
    // Hold the command in flight until the foreign write is complete. A
    // started/finished observation alone cannot eliminate an interprocess race.
    appendFileSync(join(root, '.gitignore'), 'command-release.txt\n');
    const commandPath = join(root, 'silent-active-validate.mjs');
    const script = readFileSync(commandPath, 'utf8')
      .replace("import { writeFileSync }", "import { writeFileSync, existsSync }")
      .replace('const durationMs = Number(durationRaw);',
        `const durationMs = Number(durationRaw);\nconst release = ${JSON.stringify(release)};`)
      .replace('await new Promise((resolve) => setTimeout(resolve, durationMs));',
        'while (!existsSync(release)) await new Promise(resolve => setTimeout(resolve, 20));\n'
        + 'await new Promise((resolve) => setTimeout(resolve, durationMs));');
    assert.match(script, /while \(!existsSync\(release\)\)/);
    writeFileSync(commandPath, script);
    commitAll(root, 'bind foreign-append command release handshake');
    admitSyntheticWindow(root, storyId);
    const processEventsRel = `.proof-or-stop/story/actives/${storyId}/process-events.jsonl`;
    const processEventsPath = join(root, processEventsRel);
    run = runCli(
      root,
      ['story_advance', JSON.stringify({ storyId, phase: 'TEST' })],
      NON_MAX_HARNESS_CEILING_MS,
    );
    await waitForValidationStart(started, finished, run);
    mkdirSync(dirname(processEventsPath), { recursive: true });
    const foreignLine = JSON.stringify({
      type: 'human_confirmation',
      storyId,
      phase: 'REVIEW',
      command: 'mid_validation_foreign_append',
      result: 'pass',
    }) + '\n';
    appendFileSync(processEventsPath, foreignLine, 'utf8');
    writeFileSync(release, 'foreign append completed');

    const result = await run;
    assert.notEqual(result.status, 0,
      'mid-validation foreign canonical append must fail closed instead of joining the TEST transaction');
    const preservedEvents = readFileSync(processEventsPath, 'utf8');
    assert.ok(preservedEvents.startsWith(foreignLine),
      'foreign bytes must remain the exact prefix when the validator appends its dirty-gate audit');
    assert.match(preservedEvents, /"type":"dirty_gate_audit"/,
      'existing validation side-effect diagnostics remain preserved after fail-closed persistence');
    assert.doesNotMatch(preservedEvents, /"type":"validation_terminal"|"type":"phase_transition"/,
      'rejected persistence must append neither a validation terminal nor TEST transition');
    assert.match(gitOutput(root, ['status', '--porcelain=v1', '--', processEventsRel]), /^\?\?/,
      'foreign event must remain visible and uncommitted for human recovery');
    assert.throws(
      () => gitOutput(root, ['show', `HEAD:${processEventsRel}`]),
      /does not exist in|exists on disk, but not in/i,
      'foreign event must never enter repository history',
    );
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'REVIEW',
      'foreign append rejection must not persist TEST phase');
  } finally {
    if (run) {
      writeFileSync(release, 'release during cleanup');
      await drainBeforeFixtureRemoval(run, root);
    }
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertFailedStoryAdvancePreservesValidationEvidence(): Promise<void> {
  const { root, storyId } = setupStoryAdvanceFixture();
  try {
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const configPath = join(root, 'proof-or-stop.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      validate: { commands: Array<Record<string, unknown>> };
    };
    config.validate.commands = [{
      label: 'intentional-validation-failure',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      timeoutMs: 10_000,
    }];
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    commitAll(root, 'configure intentional validation failure');

    const result = await runCli(
      root,
      ['story_advance', JSON.stringify({ storyId, phase: 'TEST' })],
      NON_MAX_HARNESS_CEILING_MS,
    );
    assert.notEqual(result.status, 0, 'failed internal validation must block TEST transition');
    assert.match(`${result.stderr}\n${result.stdout}`, /Cannot enter TEST: proof-or-stop validate did not pass/);

    const store = new StoryStore(root);
    assert.equal(store.readStory(storyId).phase, 'REVIEW',
      'capture-before-gate must never persist TEST phase when validation fails');
    const evidence = store.readTestEvidence(storyId);
    assert.equal(evidence?.result, 'FAIL',
      'failed direct-handler validation evidence must retain its existing persistence semantics');
    assert.equal(evidence?.failureKind, 'validation_failure');

    const storyRel = `.proof-or-stop/story/actives/${storyId}`;
    const canonicalPaths = [
      `${storyRel}/index.json`,
      `${storyRel}/process-events.jsonl`,
      `${storyRel}/process-metrics.json`,
    ];
    assert.equal(gitOutput(root, ['status', '--porcelain=v1', '--', ...canonicalPaths]), '',
      'failed validation persistence must leave no staged/worktree transaction residue');
    const committedStory = JSON.parse(gitOutput(root, ['show', `HEAD:${storyRel}/index.json`])) as StoryInfo;
    assert.equal(committedStory.phase, 'REVIEW',
      'failed validation metadata commit must not include a TEST phase mutation');
    const committedEvents = gitOutput(root, ['show', `HEAD:${storyRel}/process-events.jsonl`]);
    assert.match(committedEvents, /"type":"validation_terminal"/);
    assert.match(committedEvents, /"result":"fail"/);
    assert.doesNotMatch(committedEvents, /"toPhase":"TEST"/,
      'failed validation must not manufacture a successful TEST phase transition event');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertTrueHangFailsClosedWithNamedDiagnostics(): Promise<void> {
  const { root } = setupTimeoutFixture();
  try {
    const result = await runValidate(root, NON_MAX_HARNESS_CEILING_MS);
    assert.equal(result.status, 0, `validate command should return JSON even for failed validation:\n${result.stderr}`);
    const parsed = parseValidateJson(result.stdout);
    assert.equal(parsed.commands?.length, 1, 'canonical timeout fixture must schedule its configured command');
    assert.equal(parsed.commands[0].label, 'true-hang', 'the configured hanging command must actually execute');
    assert.ok(!result.stderr.includes('without output; forcing exit'), `true hang should fail by command timeout, not idle watchdog:\n${result.stderr}`);
    assert.match(result.stderr, /validate timeout: command 1\/1 true-hang: command=.* args=.* timeoutMs=1000 elapsedMs=/);
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
    if (process.argv.includes('--readiness-only')) {
      await assertDelayedFixtureReadiness();
      await assertReadinessFailureControls();
      return;
    }
    if (process.env.VALIDATE_HEARTBEAT_F011_ONLY === '1') {
      await assertStoryAdvanceReceivesHeartbeat();
      console.log('validate-progress-heartbeat F-011 story-branch success PASS');
      return;
    }
    if (process.env.VALIDATE_HEARTBEAT_F010_ONLY === '1') {
      await assertMidValidationForeignAppendFailsClosed();
      console.log('validate-progress-heartbeat F-010 foreign-append PASS');
      return;
    }
    if (process.env.VALIDATE_HEARTBEAT_FAILURE_ONLY === '1') {
      await assertFailedStoryAdvancePreservesValidationEvidence();
      console.log('validate-progress-heartbeat validation-failure persistence PASS');
      return;
    }
    if (process.env.VALIDATE_HEARTBEAT_MAIN_ONLY === '1') {
      await assertMainDirectHandlerClosesTerminal();
      console.log('validate-progress-heartbeat main direct-handler PASS');
      return;
    }
    await assertDelayedFixtureReadiness();
    await assertReadinessFailureControls();
    const result = await runValidate(root);
    if (result.status !== 0) {
      assertRedBaseline(result, started, finished);
    }
    assertGreenBehavior(result, started, finished);
    const startText = readFileSync(started, 'utf8').trim();
    const finishText = readFileSync(finished, 'utf8').trim();
    assert.match(startText, /^started \d+$/);
    assert.match(finishText, /^finished \d+$/);
    await assertMainDirectHandlerClosesTerminal();
    await assertStoryAdvanceReceivesHeartbeat();
    await assertMidValidationForeignAppendFailsClosed();
    await assertFailedStoryAdvancePreservesValidationEvidence();
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
