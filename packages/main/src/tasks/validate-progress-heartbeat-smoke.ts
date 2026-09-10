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
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistSyntheticAdmittedWindowForTest } from '../core/certification-window.js';
import { PROOF_OR_STOP_DIR, PROOF_OR_STOP_STORY_DIR } from '../core/proof-or-stop-paths.js';
import { deriveCertificationDomainInputHashes } from '../handlers/certification-window.js';
import { StoryStore } from '../core/store.js';
import { acquireOwnerLease } from '../core/story-owner-lease.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
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
    '.proof-or-stop/activity.jsonl',
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
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-validate-heartbeat-timeout-'));
  write(root, '.gitignore', '.proof-or-stop/locks/\n');
  // B-137a main-merge fix: this fixture wrote the DEPRECATED config filename, so
  // loadConfig never picked up its validate.commands and the run completed
  // instantly instead of executing the hanging command the timeout assertion
  // needs. Its sibling fixture already used the canonical name.
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
  // This fixture tests routine execution/transition ownership, not checklist evidence.
  store.writeChecklist(storyId, { items: [] });
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
      admitSyntheticWindow(fixture.root, fixture.storyId);
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
      admitSyntheticWindow(fixture.root, fixture.storyId);
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
    admitSyntheticWindow(fixture.root, fixture.storyId);
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
    admitSyntheticWindow(fixture.root, fixture.storyId);
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
    const routine = await runCli(root, ['validate', '--story', storyId, '--json'], NON_MAX_HARNESS_CEILING_MS);
    assert.equal(routine.status, 0, `REVIEW routine must pass with heartbeat: ${routine.stderr}\n${routine.stdout}`);
    const terminalBeforeTest = readFileSync(finished, 'utf8');
    const result = await runCli(root, ['story_advance', JSON.stringify({ storyId, phase: 'TEST' })], NON_MAX_HARNESS_CEILING_MS);
    assert.equal(readFileSync(finished, 'utf8'), terminalBeforeTest, 'TEST consumes routine PASS without another configured child');
    assert.equal(result.status, 0, `story_advance should survive active validate heartbeat:\n${result.stderr}\n${result.stdout}`);
    assert.ok(existsSync(started), 'story_advance internal validate command must start');
    assert.ok(existsSync(finished), 'story_advance internal validate command must finish');
    assert.ok(!result.stderr.includes('without output; forcing exit'), `story_advance must not hit idle watchdog:\n${result.stderr}`);
    assert.match(routine.stderr, /validate heartbeat: command 1\/1 silent-active-validate elapsedMs=/);
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
    admitSyntheticWindow(root, storyId);
    const routine = await runCli(root, ['validate', '--story', storyId, '--json'], NON_MAX_HARNESS_CEILING_MS);
    assert.equal(routine.status, 0, `main REVIEW routine must pass: ${routine.stderr}\n${routine.stdout}`);
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
      ['validate', '--story', storyId, '--json'],
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
    const verdict = JSON.parse(result.stdout) as ValidateJson;
    assert.equal(verdict.allPass, false, 'foreign canonical append cannot produce a validation PASS');
    assert.equal(verdict.failureKind, 'infra_failure', 'foreign append is attributed to evidence persistence');
    assert.match(result.stdout, /canonical metadata was already dirty/);
    const preservedEvents = readFileSync(processEventsPath, 'utf8');
    assert.ok(preservedEvents.startsWith(foreignLine),
      'foreign bytes must remain the exact prefix when the validator appends its dirty-gate audit');
    assert.match(preservedEvents, /"type":"dirty_gate_audit"/,
      'validation side-effect diagnostics remain preserved after fail-closed persistence');
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

    admitSyntheticWindow(root, storyId);
    const routine = await runCli(root, ['validate', '--story', storyId, '--json'], NON_MAX_HARNESS_CEILING_MS);
    assert.equal((JSON.parse(routine.stdout) as ValidateJson).allPass, false, 'the sole REVIEW routine records its real command failure');
    const failedEvidence = new StoryStore(root).readTestEvidence(storyId);
    const result = await runCli(
      root,
      ['story_advance', JSON.stringify({ storyId, phase: 'TEST' })],
      NON_MAX_HARNESS_CEILING_MS,
    );
    assert.notEqual(result.status, 0, 'failed internal validation must block TEST transition');
    assert.match(`${result.stderr}\n${result.stdout}`, /pre_cert_routine_pass_required/);

    const store = new StoryStore(root);
    assert.equal(store.readStory(storyId).phase, 'REVIEW',
      'capture-before-gate must never persist TEST phase when validation fails');
    const evidence = store.readTestEvidence(storyId);
    assert.deepEqual(evidence, failedEvidence, 'TEST refusal preserves the original routine failure without rerunning');
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
    assert.match(details, /timeout diagnostic: command 1\/1 "true-hang" reached its execution deadline; configured timeoutMs=1000ms, effective timeoutMs=\d+ms, elapsedMs=/);
    assert.match(details, /command: /);
    assert.match(details, /args: \["-e","setInterval\(\(\) => \{\}, 1000\)"\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type RefreshFixture = {
  root: string;
  storyId: string;
  checklistPath: string;
  executionLog: string;
  parentPidFile: string;
  descendantPidFile: string;
  parentIdentityFile: string;
  descendantIdentityFile: string;
  batchEvidences: Array<Record<string, unknown>>;
};

type RefreshFixtureProcessIdentity = {
  pid: number;
  startFingerprint: string;
};

function pinnedNodeCommand(script: string): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
}

function setupRefreshFixture(mode: 'heartbeat' | 'batch-heartbeat' | 'hang' | 'selector-fail', suffix: string, commitMaterialDrift = false): RefreshFixture {
  const root = mkdtempSync(join(tmpdir(), `lattice-refresh-watchdog-${suffix}-`));
  const storyId = `B-refresh-${suffix}`;
  const executionLog = join(root, 'refresh-executions.jsonl');
  const parentPidFile = join(root, 'refresh-parent.pid');
  const descendantPidFile = join(root, 'refresh-descendant.pid');
  const parentIdentityFile = join(root, 'refresh-parent.identity.json');
  const descendantIdentityFile = join(root, 'refresh-descendant.identity.json');
  write(root, '.gitignore', [
    'refresh-executions.jsonl',
    'refresh-parent.pid',
    'refresh-descendant.pid',
    'refresh-parent.identity.json',
    'refresh-descendant.identity.json',
    '.lattice/activity.jsonl',
    '.lattice/locks/',
    '${PROOF_OR_STOP_DIR}/runtime/',
    '',
  ].join('\n'));
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: PROOF_OR_STOP_STORY_DIR,
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'light' },
  }, null, 2) + '\n');
  write(root, 'packages/main/src/base.ts', 'export const refreshWatchdogFixture = true;\n');
  git(root, ['init', '-b', 'work']);
  commitAll(root, 'seed refresh watchdog fixture');
  git(root, ['branch', 'main']);

  const sharedCommand = pinnedNodeCommand([
    "const fs=require('fs');",
    ...(commitMaterialDrift ? [
      "const cp=require('child_process');const marker='.git/material-drift-once';if(!fs.existsSync(marker)){fs.writeFileSync('packages/main/src/base.ts','export const drifted = true;\\n');cp.execFileSync('git',['add','packages/main/src/base.ts']);cp.execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','material drift']);fs.writeFileSync(marker,'done');}",
    ] : []),
    `fs.appendFileSync(${JSON.stringify(executionLog)},JSON.stringify({kind:'shared',cwd:process.cwd()})+'\\n');`,
    "setTimeout(()=>console.log('SHARED_ALPHA\\nSHARED_BETA'),260);",
  ].join(''));
  const uniqueCommand = pinnedNodeCommand([
    "const fs=require('fs');",
    `fs.appendFileSync(${JSON.stringify(executionLog)},JSON.stringify({kind:'unique',cwd:process.cwd()})+'\\n');`,
    "setTimeout(()=>console.log('UNIQUE_GAMMA'),260);",
  ].join(''));
  const nearMissCommand = pinnedNodeCommand([
    "const fs=require('fs');",
    `fs.appendFileSync(${JSON.stringify(executionLog)},JSON.stringify({kind:'near',cwd:process.cwd()})+'\\n');`,
    "setTimeout(()=>console.log('SHARED_NEAR'),260);",
  ].join(''));
  const hangCommand = pinnedNodeCommand([
    "const fs=require('fs');const {spawn,execFileSync}=require('child_process');",
    "const identity=(pid)=>{try{const startFingerprint=execFileSync('ps',['-o','lstart=','-p',String(pid)],{encoding:'utf8',timeout:1000,stdio:['ignore','pipe','ignore']}).trim();return Number.isSafeInteger(pid)&&pid>1&&startFingerprint?{pid,startFingerprint}:null;}catch{return null;}};",
    `fs.writeFileSync(${JSON.stringify(parentPidFile)},String(process.pid));`,
    `fs.writeFileSync(${JSON.stringify(parentIdentityFile)},JSON.stringify(identity(process.pid)));`,
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
    `fs.writeFileSync(${JSON.stringify(descendantPidFile)},String(child.pid));`,
    `fs.writeFileSync(${JSON.stringify(descendantIdentityFile)},JSON.stringify(identity(child.pid)));`,
    "setInterval(()=>{},1000);",
  ].join(''));

  const now = '2026-08-14T00:00:00.000Z';
  const oldReceipt = {
    exitCode: 0,
    outputDigest: '0'.repeat(64),
    outputTail: 'old output',
    selectorMatched: true,
    executedAt: now,
  };
  const intents = mode === 'heartbeat'
    ? [
        { id: 'INT-SHARED-A', desc: 'shared selector A', type: 'cli' as const, priority: 'must' as const, verification: { command: sharedCommand, selector: 'SHARED_ALPHA' } },
        { id: 'INT-SHARED-B', desc: 'shared selector B', type: 'cli' as const, priority: 'must' as const, verification: { command: sharedCommand, selector: 'SHARED_BETA' } },
        { id: 'INT-UNIQUE', desc: 'unique selector', type: 'cli' as const, priority: 'must' as const, verification: { command: uniqueCommand, selector: 'UNIQUE_GAMMA' } },
      ]
    : mode === 'batch-heartbeat'
    ? [
        { id: 'INT-SHARED-A', desc: 'shared selector A', type: 'cli' as const, priority: 'must' as const, verification: { command: sharedCommand, selector: 'SHARED_ALPHA' } },
        { id: 'INT-SHARED-B', desc: 'shared selector B', type: 'cli' as const, priority: 'must' as const, verification: { command: sharedCommand, selector: 'SHARED_BETA' } },
        { id: 'INT-SHARED-NEAR', desc: 'near-miss command identity', type: 'cli' as const, priority: 'must' as const, verification: { command: nearMissCommand, selector: 'SHARED_NEAR' } },
        { id: 'INT-UNIQUE', desc: 'unique selector', type: 'cli' as const, priority: 'must' as const, verification: { command: uniqueCommand, selector: 'UNIQUE_GAMMA' } },
      ]
    : mode === 'selector-fail'
      ? [
          { id: 'INT-SHARED-A', desc: 'shared selector A', type: 'cli' as const, priority: 'must' as const, verification: { command: sharedCommand, selector: 'SHARED_ALPHA' } },
          { id: 'INT-SHARED-MISSING', desc: 'shared selector missing', type: 'cli' as const, priority: 'must' as const, verification: { command: sharedCommand, selector: 'SHARED_MISSING' } },
        ]
      : [
        { id: 'INT-HANG', desc: 'hanging process tree', type: 'cli' as const, priority: 'must' as const, verification: { command: hangCommand, selector: 'NEVER_PRINTED' } },
      ];
  const evidence = intents.map((entry) => ({
    intentRef: entry.id,
    kind: 'integration_test' as const,
    command: entry.verification.command,
    result: 'pass' as const,
    note: 'stale mechanical receipt for refresh watchdog smoke',
    headHash: '0'.repeat(40),
    materialHash: '0'.repeat(64),
    mechanical: true,
    receipt: { ...oldReceipt },
  }));
  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId,
    name: `refresh-watchdog-${suffix}`,
    title: 'Refresh watchdog smoke',
    description: 'Hermetic stale verifier refresh exercising progress and structured abort.',
    type: 'chore',
    phase: 'DEV',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
  } as StoryInfo);
  store.writeChecklist(storyId, {
    items: [{
      id: 'CHK-001',
      title: 'Refresh stale pinned commands',
      context: 'Watchdog fixture',
      status: 'done',
      startTime: now,
      endTime: now,
      verificationIntent: { happy: intents, edge: [], adversarial: [] },
      verificationEvidence: evidence,
    }],
  } as ChecklistData);
  commitAll(root, 'seed stale refresh evidence');
  return {
    root,
    storyId,
    checklistPath: join(root, PROOF_OR_STOP_STORY_DIR, storyId, 'checklist.json'),
    executionLog,
    parentPidFile,
    descendantPidFile,
    parentIdentityFile,
    descendantIdentityFile,
    batchEvidences: intents.map(entry => ({
      itemId: 'CHK-001',
      intentRef: entry.id,
      kind: 'integration_test',
      command: entry.verification.command,
      selector: entry.verification.selector,
      result: 'pass',
      note: `batch watchdog evidence for ${entry.id}`,
    })),
  };
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function refreshProcessStartFingerprint(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const value = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function readRefreshFixtureIdentity(path: string): RefreshFixtureProcessIdentity | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RefreshFixtureProcessIdentity>;
    const pid = parsed.pid;
    const startFingerprint = parsed.startFingerprint;
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1
      && typeof startFingerprint === 'string' && startFingerprint.length > 0
      ? { pid, startFingerprint }
      : null;
  } catch {
    return null;
  }
}

function killRefreshFixtureTree(fixture: RefreshFixture): void {
  // This is only a last-resort fixture cleanup. The abort assertions above
  // require both processes to be reaped already. If a test fails mid-flight,
  // target only an identity-revalidated direct child: a PID alone must never
  // authorize a process-group signal (in particular never PGID -1).
  for (const path of [fixture.descendantIdentityFile, fixture.parentIdentityFile]) {
    const identity = readRefreshFixtureIdentity(path);
    if (!identity || refreshProcessStartFingerprint(identity.pid) !== identity.startFingerprint) continue;
    try { process.kill(identity.pid, 'SIGKILL'); } catch { /* already reaped */ }
  }
}

// A pre-spawn watchdog is not evidence that a process tree was reaped. Retry only
// that unobserved case with a bounded larger budget, retaining the exact layer
// and the no-write assertion on every attempt. Any live published PID fails.
async function runRefreshWatchdogCli(
  fixture: RefreshFixture, args: string[], env: Record<string, string>,
): Promise<CliResult> {
  const maxLayer = Number(env.PROOF_OR_STOP_MAX_TIMEOUT_MS) < Number(env.PROOF_OR_STOP_IDLE_TIMEOUT_MS);
  const budgetKey = maxLayer ? 'PROOF_OR_STOP_MAX_TIMEOUT_MS' : 'PROOF_OR_STOP_IDLE_TIMEOUT_MS';
  const before = readFileSync(fixture.checklistPath, 'utf8');
  for (let attempt = 0; attempt < DESCENDANT_KILL_ESCALATIONS; attempt++) {
    const budget = Number(env[budgetKey]) * 2 ** attempt;
    const knobs = { ...env, [budgetKey]: String(budget) };
    if (maxLayer) knobs.PROOF_OR_STOP_IDLE_TIMEOUT_MS = String(NON_MAX_OUTER_TIMEOUT_MS);
    else {
      knobs.PROOF_OR_STOP_MAX_TIMEOUT_MS = String(NON_MAX_OUTER_TIMEOUT_MS);
      knobs.PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS = String(budget * 4);
    }
    const result = await runCli(fixture.root, args, NON_MAX_HARNESS_CEILING_MS, knobs);
    assert.equal(result.status, 1, `watchdog must fail through the structured handler:\n${result.stderr}`);
    const expected = maxLayer
      ? new RegExp(`(?:exceeded max timeout ${budget}ms|CLI max timeout exceeded ${budget}ms)`)
      : new RegExp(`(?:stuck: ${budget / 1000} seconds without output|CLI idle timeout exceeded ${budget}ms)`);
    assert.match(result.stderr, expected);
    assert.equal(readFileSync(fixture.checklistPath, 'utf8'), before, 'every timeout attempt preserves checklist bytes');
    const published = [fixture.parentPidFile, fixture.descendantPidFile].filter(fileHasContent);
    for (const path of published) {
      const pid = Number(readFileSync(path, 'utf8'));
      assert.ok(Number.isSafeInteger(pid) && pid > 1, 'published PID must be valid');
      assert.equal(pidIsAlive(pid), false, 'a published process must be reaped before return');
    }
    if (published.length === 2) return result;
    for (const path of [fixture.parentPidFile, fixture.descendantPidFile, fixture.parentIdentityFile, fixture.descendantIdentityFile]) rmSync(path, { force: true });
  }
  assert.fail('watchdog fired before a complete process tree was published in every bounded attempt');
}

// These positive/selector witnesses exercise idle heartbeats and atomicity, not
// the max-timeout boundary. V5 signed publication can exceed the old incidental
// 5s cap; use the existing non-max harness policy. Dedicated max-timeout
// negative controls below retain their short independent deadlines.
async function assertRefreshHeartbeatAndDedupe(): Promise<void> {
  const fixture = setupRefreshFixture('heartbeat', 'heartbeat');
  try {
    const result = await runCli(
      fixture.root,
      ['verification_evidence_refresh_stale', JSON.stringify({ storyId: fixture.storyId })],
      NON_MAX_HARNESS_CEILING_MS,
      {
        PROOF_OR_STOP_SESSION_ID: 'refresh-heartbeat-smoke',
        PROOF_OR_STOP_IDLE_TIMEOUT_MS: '180',
        PROOF_OR_STOP_MAX_TIMEOUT_MS: String(NON_MAX_OUTER_TIMEOUT_MS),
        PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: '40',
      },
    );
    assert.equal(result.status, 0, `refresh must outlive the idle window via command heartbeats:\n${result.stderr}\n${result.stdout}`);
    assert.ok(result.elapsedMs > 360, 'two sequential unique commands must make aggregate runtime exceed the idle window');
    assert.doesNotMatch(result.stderr, /without output/);
    assert.match(result.stderr, /validate heartbeat: command 1\/2 verification-evidence-command elapsedMs=/);
    assert.match(result.stderr, /validate heartbeat: command 2\/2 verification-evidence-command elapsedMs=/);
    const executions = readFileSync(fixture.executionLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { kind: string; cwd: string });
    assert.deepEqual(executions.map(entry => entry.kind), ['shared', 'unique'], 'each exact cwd+command executes once despite two shared intents');
    const expectedCwd = realpathSync(fixture.root);
    assert.deepEqual(executions.map(entry => entry.cwd), [expectedCwd, expectedCwd], 'both unique pins execute in the exact refresh cwd');
    const checklist = JSON.parse(readFileSync(fixture.checklistPath, 'utf8')) as ChecklistData;
    const rows = checklist.items[0].verificationEvidence ?? [];
    for (const intentRef of ['INT-SHARED-A', 'INT-SHARED-B', 'INT-UNIQUE']) {
      const row = rows.find(entry => entry.intentRef === intentRef);
      assert.equal(row?.mechanical, true, `${intentRef} keeps an independent mechanical stamp`);
      assert.ok(row?.receipt && 'executionReceipt' in row.receipt, 'fresh evidence carries the actual signed execution');
      const actualBudget = row.receipt.executionReceipt.effectiveTimeoutMs;
      assert.ok(Number.isSafeInteger(actualBudget) && actualBudget > 0 && actualBudget <= NON_MAX_OUTER_TIMEOUT_MS,
        'receipt records the actual deadline-capped budget, never the larger configured policy');
      assert.equal(row.receipt.timeoutMs, actualBudget, 'compatibility and signed execution budgets agree');
      assert.equal(row?.receipt?.selectorMatched, true, `${intentRef} independently evaluates its immutable selector`);
      assert.notEqual(row?.receipt?.executedAt, '2026-08-14T00:00:00.000Z', `${intentRef} receives a fresh receipt`);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function assertRefreshWatchdogReapsWithoutPartialWrites(): Promise<void> {
  const cases = [
    { name: 'idle', idleMs: '140', maxMs: '5000', heartbeatMs: '2000', transcript: /stuck: 0\.14 seconds without output/ },
    { name: 'max', idleMs: '2000', maxMs: '220', heartbeatMs: '40', transcript: /(?:exceeded max timeout 220ms|CLI max timeout exceeded 220ms)/ },
  ] as const;
  for (const testCase of cases) {
    const fixture = setupRefreshFixture('hang', testCase.name);
    const checklistBefore = readFileSync(fixture.checklistPath, 'utf8');
    try {
      const result = await runRefreshWatchdogCli(
        fixture,
        ['verification_evidence_refresh_stale', JSON.stringify({ storyId: fixture.storyId })],
        {
          PROOF_OR_STOP_SESSION_ID: `refresh-${testCase.name}-smoke`,
          PROOF_OR_STOP_IDLE_TIMEOUT_MS: testCase.idleMs,
          PROOF_OR_STOP_MAX_TIMEOUT_MS: testCase.maxMs,
          PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: testCase.heartbeatMs,
        },
      );
      assert.equal(result.status, 1, `${testCase.name} watchdog must surface a structured handler failure, not process.exit(2):\n${result.stderr}`);
      assert.doesNotMatch(result.stdout, /Refreshed /, `${testCase.name} abort cannot claim a refresh result`);
      await waitForFile(fixture.parentPidFile);
      await waitForFile(fixture.descendantPidFile);
      await new Promise(resolve => setTimeout(resolve, 120));
      const parentPid = Number(readFileSync(fixture.parentPidFile, 'utf8'));
      const descendantPid = Number(readFileSync(fixture.descendantPidFile, 'utf8'));
      assert.equal(pidIsAlive(parentPid), false, `${testCase.name} abort must reap the pinned-command group leader`);
      assert.equal(pidIsAlive(descendantPid), false, `${testCase.name} abort must reap its provider-like descendant`);
      assert.equal(readFileSync(fixture.checklistPath, 'utf8'), checklistBefore,
        `${testCase.name} abort must write neither a partial receipt nor a demotion`);
    } finally {
      killRefreshFixtureTree(fixture);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
}

async function assertSingleEvidenceCommandsHeartbeatAndReap(): Promise<void> {
  const heartbeatFixture = setupRefreshFixture('heartbeat', 'single-evidence-heartbeat');
  try {
    const first = heartbeatFixture.batchEvidences[0];
    const addResult = await runCli(
      heartbeatFixture.root,
      ['verification_evidence_add', JSON.stringify({ storyId: heartbeatFixture.storyId, ...first })],
      NON_MAX_HARNESS_CEILING_MS,
      {
        PROOF_OR_STOP_SESSION_ID: 'single-evidence-add-heartbeat-smoke',
        PROOF_OR_STOP_IDLE_TIMEOUT_MS: '180',
        PROOF_OR_STOP_MAX_TIMEOUT_MS: String(NON_MAX_OUTER_TIMEOUT_MS),
        PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: '40',
      },
    );
    assert.equal(addResult.status, 0,
      `single evidence add must outlive the idle window via command heartbeats:\n${addResult.stderr}\n${addResult.stdout}`);
    assert.doesNotMatch(addResult.stderr, /without output/);
    assert.match(addResult.stderr, /validate heartbeat: command 1\/1 verification-evidence-command elapsedMs=/);

    const runResult = await runCli(
      heartbeatFixture.root,
      ['verification_run', JSON.stringify({
        storyId: heartbeatFixture.storyId,
        intentRef: 'INT-UNIQUE',
        note: 'single verification run heartbeat smoke',
      })],
      NON_MAX_HARNESS_CEILING_MS,
      {
        PROOF_OR_STOP_SESSION_ID: 'single-evidence-add-heartbeat-smoke',
        PROOF_OR_STOP_IDLE_TIMEOUT_MS: '180',
        PROOF_OR_STOP_MAX_TIMEOUT_MS: String(NON_MAX_OUTER_TIMEOUT_MS),
        PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: '40',
      },
    );
    assert.equal(runResult.status, 0,
      `verification_run must outlive the idle window via command heartbeats:\n${runResult.stderr}\n${runResult.stdout}`);
    assert.doesNotMatch(runResult.stderr, /without output/);
    assert.match(runResult.stderr, /validate heartbeat: command 1\/1 verification-evidence-command elapsedMs=/);

    const executionsBeforeReuse = readFileSync(heartbeatFixture.executionLog, 'utf8');
    assert.deepEqual(executionsBeforeReuse.trim().split('\n').map(line => JSON.parse(line).kind), ['shared', 'unique'],
      'add and the independent pinned run each execute their command');
    const reused = await runCli(heartbeatFixture.root, ['verification_run', JSON.stringify({
      storyId: heartbeatFixture.storyId, intentRef: 'INT-SHARED-B', note: 'reuse the current shared command with an independent selector',
    })], NON_MAX_HARNESS_CEILING_MS, {
      PROOF_OR_STOP_SESSION_ID: 'single-evidence-add-heartbeat-smoke',
      PROOF_OR_STOP_IDLE_TIMEOUT_MS: '180', PROOF_OR_STOP_MAX_TIMEOUT_MS: String(NON_MAX_OUTER_TIMEOUT_MS), PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: '40',
    });
    assert.equal(reused.status, 0, `ordinary V5 verification run observes the command again:\n${reused.stderr}`);
    assert.match(reused.stderr, /validate heartbeat: command 1\/1 verification-evidence-command elapsedMs=/);
    assert.deepEqual(readFileSync(heartbeatFixture.executionLog, 'utf8').trim().split('\n').map(line => JSON.parse(line).kind),
      ['shared', 'unique', 'shared'],
      'ordinary V5 rerun must record a fresh observation; only explicit shared publication fans out without another execution');
    const checklist = JSON.parse(readFileSync(heartbeatFixture.checklistPath, 'utf8')) as ChecklistData;
    for (const intentRef of ['INT-SHARED-A', 'INT-UNIQUE', 'INT-SHARED-B']) {
      const row = checklist.items[0].verificationEvidence?.find(entry => entry.intentRef === intentRef);
      assert.equal(row?.mechanical, true, `${intentRef} receives a mechanical receipt after its heartbeat-protected command`);
      assert.equal(row?.receipt?.selectorMatched, true, `${intentRef} receipt confirms its exact selector`);
    }
  } finally {
    rmSync(heartbeatFixture.root, { recursive: true, force: true });
  }

  const abortCases = [
    { name: 'idle', idleMs: '140', maxMs: '5000', heartbeatMs: '2000', transcript: /stuck: 0\.14 seconds without output/ },
    { name: 'max', idleMs: '2000', maxMs: '220', heartbeatMs: '40', transcript: /(?:exceeded max timeout 220ms|CLI max timeout exceeded 220ms)/ },
  ] as const;
  for (const commandKind of ['verification_evidence_add', 'verification_run'] as const) {
    for (const testCase of abortCases) {
      const fixture = setupRefreshFixture('hang', `single-${commandKind}-${testCase.name}-abort`);
      const checklistBefore = readFileSync(fixture.checklistPath, 'utf8');
      try {
        const evidence = fixture.batchEvidences[0];
        const args = commandKind === 'verification_evidence_add'
          ? { storyId: fixture.storyId, ...evidence }
          : {
              storyId: fixture.storyId,
              intentRef: 'INT-HANG',
              note: 'single verification run abort smoke',
            };
        const result = await runRefreshWatchdogCli(
          fixture,
          [commandKind, JSON.stringify(args)],
          {
            PROOF_OR_STOP_SESSION_ID: `single-${commandKind}-${testCase.name}-abort-smoke`,
            PROOF_OR_STOP_IDLE_TIMEOUT_MS: testCase.idleMs,
            PROOF_OR_STOP_MAX_TIMEOUT_MS: testCase.maxMs,
            PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: testCase.heartbeatMs,
          },
        );
        assert.equal(result.status, 1,
          `${commandKind} ${testCase.name} watchdog must return a structured handler failure, not process.exit(2):\n${result.stderr}`);
          await waitForFile(fixture.parentPidFile);
        await waitForFile(fixture.descendantPidFile);
        await new Promise(resolve => setTimeout(resolve, 120));
        const parentPid = Number(readFileSync(fixture.parentPidFile, 'utf8'));
        const descendantPid = Number(readFileSync(fixture.descendantPidFile, 'utf8'));
        assert.equal(pidIsAlive(parentPid), false, `${commandKind} ${testCase.name} abort must reap the pinned-command group leader`);
        assert.equal(pidIsAlive(descendantPid), false, `${commandKind} ${testCase.name} abort must reap its provider-like descendant`);
        assert.equal(readFileSync(fixture.checklistPath, 'utf8'), checklistBefore,
          `${commandKind} ${testCase.name} abort must not write a partial receipt or mutation`);
      } finally {
        killRefreshFixtureTree(fixture);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  }
}

/**
 * A watchdog can become aborted after the command returns but while the
 * synchronous receipt transaction is acquiring/reading its checklist lock.
 * The write-side recheck must fail closed before the in-memory mutation reaches
 * store.writeChecklist.
 */
async function assertSingleEvidenceWriteGuardRefusesLateAbort(): Promise<void> {
  const originalCwd = process.cwd();
  try {
    for (const commandKind of ['verification_evidence_add', 'verification_run'] as const) {
      const fixture = setupRefreshFixture('heartbeat', `single-${commandKind}-write-guard`);
      const checklistBefore = readFileSync(fixture.checklistPath, 'utf8');
      try {
        process.chdir(fixture.root);
        const store = new StoryStore(fixture.root);
        acquireOwnerLease(store.storyDirPath(fixture.storyId), { command: 'smoke_fixture_setup', cwd: fixture.root });
        const handlers = createChecklistHandlers({
          store,
          root: fixture.root,
          scanRoot: join(fixture.root, 'packages/main'),
        });
        const abort = new AbortController();
        const lateAbort = new Error(`${commandKind} single write guard synthetic abort`);
        const readChecklist = store.readChecklist.bind(store);
        let lockedChecklistReads = 0;
        store.readChecklist = ((storyId: string) => {
          const checklist = readChecklist(storyId);
          // Hash/provenance preflights can also read the checklist. Trigger
          // only at the actual locked write boundary after execution.
          if (existsSync(store.runtimeLockDirPath(storyId, 'checklist', 'checklist'))) {
            lockedChecklistReads += 1;
            abort.abort(lateAbort);
          }
          return checklist;
        }) as typeof store.readChecklist;
        const evidence = fixture.batchEvidences[0];
        const invocation = commandKind === 'verification_evidence_add'
          ? handlers.verification_evidence_add({
              storyId: fixture.storyId,
              itemId: 'CHK-001',
              intentRef: 'INT-SHARED-A',
              kind: 'integration_test',
              command: String(evidence.command),
              selector: String(evidence.selector),
              result: 'pass',
              note: 'single verification write guard smoke',
              abortSignal: abort.signal,
              deadlineAt: Date.now() + 5_000,
              deadlineError: () => lateAbort,
            })
          : handlers.verification_run({
              storyId: fixture.storyId,
              intentRef: 'INT-SHARED-A',
              note: 'single verification write guard smoke',
              abortSignal: abort.signal,
              deadlineAt: Date.now() + 5_000,
              deadlineError: () => lateAbort,
            });
        await assert.rejects(
          invocation,
          /single write guard synthetic abort/,
          `${commandKind} refuses a watchdog abort raised from its receipt write lock`,
        );
        assert.equal(lockedChecklistReads, 1, `${commandKind} reaches the locked checklist read before the synthetic abort`);
        assert.equal(JSON.parse(readFileSync(fixture.executionLog, 'utf8').trim()).kind, 'shared',
          'the real command must execute before testing a late write-side abort');
        assert.equal(readFileSync(fixture.checklistPath, 'utf8'), checklistBefore,
          `${commandKind} late watchdog abort writes no receipt or checklist mutation`);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  } finally {
    process.chdir(originalCwd);
  }
}

async function assertBatchHeartbeatAndExactCommandDedupe(): Promise<void> {
  const fixture = setupRefreshFixture('batch-heartbeat', 'batch-heartbeat');
  try {
    const result = await runCli(
      fixture.root,
      ['verification_evidence_batch_add', JSON.stringify({
        storyId: fixture.storyId,
        evidences: fixture.batchEvidences,
      })],
      NON_MAX_HARNESS_CEILING_MS,
      {
        PROOF_OR_STOP_SESSION_ID: 'batch-heartbeat-smoke',
        PROOF_OR_STOP_IDLE_TIMEOUT_MS: '180',
        PROOF_OR_STOP_MAX_TIMEOUT_MS: String(NON_MAX_OUTER_TIMEOUT_MS),
        PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: '40',
      },
    );
    assert.equal(result.status, 0, `batch must outlive the idle window via per-entry command heartbeats:\n${result.stderr}\n${result.stdout}`);
    assert.doesNotMatch(result.stderr, /without output/);
    assert.match(result.stderr, /validate heartbeat: command 1\/3 verification-evidence-command elapsedMs=/);
    assert.match(result.stderr, /validate heartbeat: command 2\/3 verification-evidence-command elapsedMs=/);
    assert.match(result.stderr, /validate heartbeat: command 3\/3 verification-evidence-command elapsedMs=/);
    assert.doesNotMatch(result.stderr, /command 4\/4/, 'progress reports real unique executions, not the four intent consumers');
    const executions = readFileSync(fixture.executionLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { kind: string; cwd: string });
    assert.deepEqual(executions.map(entry => entry.kind), ['shared', 'near', 'unique'],
      'batch executes one exact shared command once while a near-miss command remains independent');
    const checklist = JSON.parse(readFileSync(fixture.checklistPath, 'utf8')) as ChecklistData;
    for (const intentRef of ['INT-SHARED-A', 'INT-SHARED-B', 'INT-SHARED-NEAR', 'INT-UNIQUE']) {
      const row = checklist.items[0].verificationEvidence?.find(entry => entry.intentRef === intentRef);
      assert.equal(row?.mechanical, true, `${intentRef} receives its own mechanical batch stamp`);
      assert.equal(row?.receipt?.selectorMatched, true, `${intentRef} independently evaluates its selector`);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function assertBatchSharedExecutionStillFailsAtomicOnSelector(): Promise<void> {
  const fixture = setupRefreshFixture('selector-fail', 'batch-selector-fail');
  const checklistBefore = readFileSync(fixture.checklistPath, 'utf8');
  try {
    const result = await runCli(
      fixture.root,
      ['verification_evidence_batch_add', JSON.stringify({
        storyId: fixture.storyId,
        evidences: fixture.batchEvidences,
      })],
      NON_MAX_HARNESS_CEILING_MS,
      {
        PROOF_OR_STOP_SESSION_ID: 'batch-selector-fail-smoke',
        PROOF_OR_STOP_IDLE_TIMEOUT_MS: '1000',
        PROOF_OR_STOP_MAX_TIMEOUT_MS: String(NON_MAX_OUTER_TIMEOUT_MS),
        PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: '40',
      },
    );
    assert.equal(result.status, 1, 'a missing selector on one consumer fails the whole batch');
    assert.match(result.stderr, /pinned selector "SHARED_MISSING" not found/);
    const executions = readFileSync(fixture.executionLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { kind: string });
    assert.deepEqual(executions.map(entry => entry.kind), ['shared'],
      'two selector consumers reuse one exact command execution even when the second selector fails');
    assert.equal(readFileSync(fixture.checklistPath, 'utf8'), checklistBefore,
      'one selector failure preserves all-or-nothing checklist bytes');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function assertBatchMaterialDriftCannotPublishReusableRawOutput(): Promise<void> {
  const fixture = setupRefreshFixture('heartbeat', 'batch-material-drift', true);
  const env = { PROOF_OR_STOP_SESSION_ID: 'batch-material-drift-fixture', PROOF_OR_STOP_MAX_TIMEOUT_MS: '20000' };
  try {
    const before = readFileSync(fixture.checklistPath, 'utf8');
    const batch = await runCli(fixture.root, ['verification_evidence_batch_add', JSON.stringify({
      storyId: fixture.storyId, evidences: fixture.batchEvidences.slice(0, 2),
    })], NON_MAX_HARNESS_CEILING_MS, env);
    assert.equal(batch.status, 1, `material drift must refuse batch: ${batch.stderr}\n${batch.stdout}`);
    assert.equal(readFileSync(fixture.checklistPath, 'utf8'), before, 'failed batch must remain atomic');
    const executedBefore = readFileSync(fixture.executionLog, 'utf8').trim().split('\n').length;
    const follow = await runCli(fixture.root, ['verification_run', JSON.stringify({
      storyId: fixture.storyId, intentRef: 'INT-SHARED-B', note: 'Execute against current material after failed batch',
    })], NON_MAX_HARNESS_CEILING_MS, env);
    assert.equal(follow.status, 0, `fresh independent execution must pass: ${follow.stderr}\n${follow.stdout}`);
    assert.equal(readFileSync(fixture.executionLog, 'utf8').trim().split('\n').length, executedBefore + 1,
      'failed batch must not publish reusable new-material CAS from old raw output');
  } finally {
    killRefreshFixtureTree(fixture);
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function assertBatchWatchdogReapsWithoutPartialWrites(): Promise<void> {
  const cases = [
    { name: 'batch-idle', idleMs: '140', maxMs: '5000', heartbeatMs: '2000', transcript: /stuck: 0\.14 seconds without output/ },
    { name: 'batch-max', idleMs: '2000', maxMs: '220', heartbeatMs: '40', transcript: /(?:exceeded max timeout 220ms|CLI max timeout exceeded 220ms)/ },
  ] as const;
  for (const testCase of cases) {
    const fixture = setupRefreshFixture('hang', testCase.name);
    const checklistBefore = readFileSync(fixture.checklistPath, 'utf8');
    try {
      const result = await runRefreshWatchdogCli(
        fixture,
        ['verification_evidence_batch_add', JSON.stringify({
          storyId: fixture.storyId,
          evidences: fixture.batchEvidences,
        })],
        {
          PROOF_OR_STOP_SESSION_ID: `${testCase.name}-smoke`,
          PROOF_OR_STOP_IDLE_TIMEOUT_MS: testCase.idleMs,
          PROOF_OR_STOP_MAX_TIMEOUT_MS: testCase.maxMs,
          PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: testCase.heartbeatMs,
        },
      );
      assert.equal(result.status, 1, `${testCase.name} must surface a structured handler failure, not process.exit(2):\n${result.stderr}`);
      assert.doesNotMatch(result.stdout, /Verification evidence batch recorded/, `${testCase.name} cannot claim a batch write`);
      await waitForFile(fixture.parentPidFile);
      await waitForFile(fixture.descendantPidFile);
      await new Promise(resolve => setTimeout(resolve, 120));
      const parentPid = Number(readFileSync(fixture.parentPidFile, 'utf8'));
      const descendantPid = Number(readFileSync(fixture.descendantPidFile, 'utf8'));
      assert.equal(pidIsAlive(parentPid), false, `${testCase.name} abort must reap the command group leader`);
      assert.equal(pidIsAlive(descendantPid), false, `${testCase.name} abort must reap its provider-like descendant`);
      assert.equal(readFileSync(fixture.checklistPath, 'utf8'), checklistBefore,
        `${testCase.name} abort must preserve all-or-nothing checklist bytes`);
    } finally {
      killRefreshFixtureTree(fixture);
      rmSync(fixture.root, { recursive: true, force: true });
    }
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
    if (process.env.REFRESH_STALE_WATCHDOG_ONLY === '1') {
      await assertRefreshHeartbeatAndDedupe();
      await assertRefreshWatchdogReapsWithoutPartialWrites();
      await assertSingleEvidenceCommandsHeartbeatAndReap();
      await assertSingleEvidenceWriteGuardRefusesLateAbort();
      await assertBatchHeartbeatAndExactCommandDedupe();
      await assertBatchSharedExecutionStillFailsAtomicOnSelector();
      await assertBatchWatchdogReapsWithoutPartialWrites();
      await assertBatchMaterialDriftCannotPublishReusableRawOutput();
      console.log('validate-progress-heartbeat single/refresh/batch structured watchdog PASS');
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
