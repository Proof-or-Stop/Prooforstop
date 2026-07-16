#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  enforceStoryOwnerLeaseGate,
  MAIN_TOOLS,
  resolveEffectiveOwnershipClass,
} from '../cli-engine.js';
import { getCommandPolicy } from '../core/command-policy.js';
import { DEFAULT_PHASE_TOOLS, isCommandAllowed, resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';
import type { LiveSmokeTranscriptReport } from '../handlers/live-smoke-transcript.js';
import { acquireOwnerLease, ownerLeasePath, resetSessionIdForTest } from '../core/story-owner-lease.js';
import { commandCliMaxBudget, effectiveCommandCliMaxBudget, LIVE_SMOKE_CAPTURE_CLEANUP_GRACE_MS, liveSmokeCaptureBudget, NODE_TIMER_MAX_MS } from '../core/done-required-timeout-budget.js';
import { validationExecutionLockPath, withValidationExecutionLock } from '../core/validation-execution-lock.js';

const STORY_ID = 'B-livesmoke';
const NOW = '2026-06-20T00:00:00.000Z';
const MARKER = 'P5-MARKER-7f3a';
const USER_SEES = 'lattice live_smoke_transcript --storyId=<story> prints the expected output and transcript status.';
const ARTIFACT_REL = 'evidence/live-smoke-transcript.json';
const CLI_ENTRYPOINT = fileURLToPath(new URL('../cli.js', import.meta.url));

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'live-smoke-transcript-smoke',
      GIT_AUTHOR_EMAIL: 'live-smoke-transcript-smoke@example.com',
      GIT_COMMITTER_NAME: 'live-smoke-transcript-smoke',
      GIT_COMMITTER_EMAIL: 'live-smoke-transcript-smoke@example.com',
    },
  }).trim();
}

// ---- handler forwards the mechanically selected nested max to the child ----

{
  const { root, ctx } = createFixture(checklistWithUserSees);
  const savedArgv1 = process.argv[1];
  const savedMax = process.env.LATTICE_MAX_TIMEOUT_MS;
  try {
    const observer = join(root, 'active-lattice-observer');
    writeFileSync(observer, [
      '#!/usr/bin/env node',
      "process.stdout.write(JSON.stringify({ max: process.env.LATTICE_MAX_TIMEOUT_MS ?? null }));",
    ].join('\n') + '\n', 'utf8');
    chmodSync(observer, 0o755);
    process.argv[1] = observer;
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');

    delete process.env.LATTICE_MAX_TIMEOUT_MS;
    const derived = await handler!({
      storyId: STORY_ID,
      capture: `${observer} done_required_validate --storyId=${STORY_ID}`,
      json: true,
    }) as LiveSmokeTranscriptReport;
    assert.equal(JSON.parse(derived.actual?.stdout ?? '{}').max, '30000', 'default-derived nested max is forwarded to the trusted child');

    process.env.LATTICE_MAX_TIMEOUT_MS = String(Number.MAX_SAFE_INTEGER);
    const saturated = await handler!({
      storyId: STORY_ID,
      capture: `${observer} done_required_validate --storyId=${STORY_ID}`,
      json: true,
    }) as LiveSmokeTranscriptReport;
    assert.equal(
      JSON.parse(saturated.actual?.stdout ?? '{}').max,
      String(NODE_TIMER_MAX_MS - LIVE_SMOKE_CAPTURE_CLEANUP_GRACE_MS - 30_000),
      'saturation-adjusted effective nested max is forwarded to the trusted child',
    );
  } finally {
    process.argv[1] = savedArgv1;
    if (savedMax === undefined) delete process.env.LATTICE_MAX_TIMEOUT_MS;
    else process.env.LATTICE_MAX_TIMEOUT_MS = savedMax;
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- actual CLI always prints one structured timeout terminal --------------

{
  const { root } = createFixture(checklistWithUserSees);
  try {
    for (let index = 0; index < 10; index += 1) {
      const stdout = execFileSync(process.execPath, [
        CLI_ENTRYPOINT,
        'live_smoke_transcript',
        JSON.stringify({ storyId: STORY_ID, capture: 'sleep 5', json: true }),
      ], {
        cwd: root,
        env: { ...process.env, LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS: '100' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5_000,
      });
      assert.ok(stdout.trim().length > 0, `actual CLI timeout run ${index + 1} emits a terminal payload`);
      const report = JSON.parse(stdout) as LiveSmokeTranscriptReport;
      assert.equal(report.actual?.exitCode, null, `actual CLI timeout run ${index + 1} remains non-pass`);
      assert.match(report.actual?.stderr ?? '', /process group terminated/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- descendant reap uses a PID-written readiness handshake ----------------

type HarnessFailure = 'none' | 'readiness' | 'assertion' | 'read' | 'close-never' | 'disappearance-timeout';

interface HarnessPids {
  capture: number;
  descendant: number;
}

let activeDisappearanceProbes = 0;
let injectedDisappearanceSignals = 0;
let injectedDisappearanceElapsedMs = 0;

type HarnessSignalSender = (pid: number, signalName: NodeJS.Signals) => unknown;

function signalHarnessProcess(
  pid: number,
  signalName: NodeJS.Signals,
  sendSignal: HarnessSignalSender = process.kill,
): void {
  try {
    sendSignal(pid, signalName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitUntilGone(
  pid: number,
  isAlive: (candidate: number) => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  if (!isAlive(pid)) return;
  activeDisappearanceProbes += 1;
  let probe: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolveGone, rejectGone) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) rejectGone(error);
        else resolveGone();
      };
      probe = setInterval(() => {
        if (!isAlive(pid)) settle();
      }, 20);
      deadline = setTimeout(
        () => settle(new Error(`process ${pid} did not terminate during harness cleanup`)),
        timeoutMs,
      );
    });
  } finally {
    if (probe) clearInterval(probe);
    if (deadline) clearTimeout(deadline);
    activeDisappearanceProbes -= 1;
  }
}

async function runDescendantHarness(failure: HarnessFailure): Promise<void> {
  const { root } = createFixture(checklistWithUserSees);
  const pidPath = join(root, 'actual-cli-descendant.json');
  let cli: ReturnType<typeof spawn> | undefined;
  let actualClosed: Promise<number | null> | undefined;
  let cliClosed = false;
  let observedPids: HarnessPids | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let bodyCompleted = false;
  const disposers = new Set<() => void>();

  const bounded = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      disposers.add(() => clearTimeout(timer));
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      for (const dispose of [...disposers]) dispose();
      disposers.clear();

      const targets = [
        ...(cli?.pid ? [-cli.pid] : []),
        ...(observedPids ? [observedPids.capture, observedPids.descendant] : []),
      ];
      if (!bodyCompleted) {
        for (const pid of targets) signalHarnessProcess(pid, 'SIGTERM');
        if (actualClosed) {
          try {
            await bounded(actualClosed, 250, 'CLI ignored harness TERM grace');
          } catch {
            // The KILL pass below is the bounded fallback for an uncooperative CLI.
          }
        }
        const killTargets = [
          ...(!cliClosed && cli?.pid ? [-cli.pid] : []),
          ...(observedPids ? [observedPids.capture, observedPids.descendant].filter(isAlive) : []),
        ];
        for (const pid of killTargets) signalHarnessProcess(pid, 'SIGKILL');
        if (actualClosed) await bounded(actualClosed, 2_000, 'CLI did not close after harness KILL');
      }
      for (const pid of targets.filter((pid) => pid > 0)) {
        await waitUntilGone(pid, isAlive);
      }
      if (failure === 'disappearance-timeout') {
        const syntheticPid = 987_654_321;
        const injectedSignal: HarnessSignalSender = () => { injectedDisappearanceSignals += 1; };
        signalHarnessProcess(syntheticPid, 'SIGTERM', injectedSignal);
        signalHarnessProcess(syntheticPid, 'SIGKILL', injectedSignal);
        const probeStartedAt = Date.now();
        try {
          await waitUntilGone(syntheticPid, () => true, 100);
        } finally {
          injectedDisappearanceElapsedMs = Date.now() - probeStartedAt;
        }
      }
    })();
    return cleanupPromise;
  };

  try {
    const hangingScript = join(root, 'actual-cli-descendant-hang.cjs');
    writeFileSync(hangingScript, [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'process.on(\\\"SIGTERM\\\",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });",
      "writeFileSync(process.argv[2], JSON.stringify({ capture: process.pid, descendant: child.pid }));",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join('\n') + '\n', 'utf8');

    const ready = new Promise<HarnessPids>((resolveReady, rejectReady) => {
      let settled = false;
      const disposeReady = () => {
        watcher.close();
        clearInterval(probe);
        clearTimeout(deadline);
      };
      const finishReady = () => {
        if (settled) return;
        let parsed: HarnessPids;
        try {
          parsed = JSON.parse(readFileSync(pidPath, 'utf8')) as HarnessPids;
          if (!Number.isInteger(parsed.capture) || !Number.isInteger(parsed.descendant)) return;
        } catch {
          return;
        }
        settled = true;
        observedPids = parsed;
        disposeReady();
        disposers.delete(disposeReady);
        if (failure === 'readiness') rejectReady(new Error('injected readiness rejection'));
        else resolveReady(parsed);
      };
      const watcher = watch(root, (_event, filename) => {
        if (filename === 'actual-cli-descendant.json' && existsSync(pidPath)) finishReady();
      });
      // fs.watch is the primary handshake; the state probe closes the narrow
      // create-before-watch-delivery race without relying on a fixed sleep.
      const probe = setInterval(() => {
        if (existsSync(pidPath)) finishReady();
      }, 25);
      const deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        disposeReady();
        disposers.delete(disposeReady);
        rejectReady(new Error('descendant PID readiness handshake timed out'));
      }, 15_000);
      disposers.add(disposeReady);
      if (existsSync(pidPath)) finishReady();
    });

    const capture = `${JSON.stringify(process.execPath)} ${JSON.stringify(hangingScript)} ${JSON.stringify(pidPath)}`;
    const spawnedCli = spawn(process.execPath, [
      CLI_ENTRYPOINT,
      'live_smoke_transcript',
      JSON.stringify({ storyId: STORY_ID, capture, json: true }),
    ], {
      cwd: root,
      env: { ...process.env, LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS: '2000' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    cli = spawnedCli;
    let stdout = '';
    let stderr = '';
    spawnedCli.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    spawnedCli.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    actualClosed = new Promise<number | null>((resolveClose, rejectClose) => {
      spawnedCli.once('error', (error) => {
        cliClosed = true;
        rejectClose(error);
      });
      spawnedCli.once('close', (exitCode) => {
        cliClosed = true;
        resolveClose(exitCode);
      });
    });

    const pids = await ready;
    assert.equal(spawnedCli.exitCode, null, 'PID readiness is observed while the CLI capture is still active');
    if (failure === 'assertion') throw new Error('injected post-readiness assertion failure');
    if (failure === 'read') {
      writeFileSync(pidPath, '{invalid', 'utf8');
      JSON.parse(readFileSync(pidPath, 'utf8'));
    }
    const closeWaiter = failure === 'close-never' ? new Promise<number | null>(() => {}) : actualClosed;
    const exitCode = await bounded(closeWaiter, failure === 'close-never' ? 100 : 15_000, 'CLI close deadline exceeded');
    assert.equal(exitCode, 0, `actual CLI transcript producer exits successfully: ${stderr}`);
    assert.ok(stdout.trim().length > 0, 'descendant-reap run emits a terminal payload');
    const report = JSON.parse(stdout) as LiveSmokeTranscriptReport;
    assert.equal(report.actual?.exitCode, null);
    assert.throws(() => process.kill(pids.descendant, 0), /ESRCH/, 'handshake-confirmed descendant is reaped after timeout');
    bodyCompleted = true;
  } finally {
    try {
      await Promise.all([cleanup(), cleanup()]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false, 'temp root removal happens after process cleanup settlement');
    }
  }
}

await runDescendantHarness('none');
const syntheticEsrch = Object.assign(new Error('gone'), { code: 'ESRCH' });
assert.doesNotThrow(
  () => signalHarnessProcess(123, 'SIGTERM', () => { throw syntheticEsrch; }),
  'ESRCH signal races are treated as already cleaned',
);
const syntheticEperm = Object.assign(new Error('denied'), { code: 'EPERM' });
assert.throws(
  () => signalHarnessProcess(123, 'SIGTERM', () => { throw syntheticEperm; }),
  /denied/,
  'a genuine EPERM remains the primary cleanup error',
);
for (const failure of ['readiness', 'assertion', 'read', 'close-never', 'disappearance-timeout'] as const) {
  await assert.rejects(runDescendantHarness(failure), new RegExp(
    failure === 'readiness' ? 'injected readiness rejection'
      : failure === 'assertion' ? 'injected post-readiness assertion failure'
        : failure === 'read' ? 'Unexpected token|JSON'
          : failure === 'close-never' ? 'CLI close deadline exceeded'
            : 'did not terminate during harness cleanup',
  ));
  assert.equal(activeDisappearanceProbes, 0, `${failure} leaves no active disappearance probe handles`);
  if (failure === 'disappearance-timeout') {
    assert.ok(
      injectedDisappearanceElapsedMs >= 80 && injectedDisappearanceElapsedMs < 1_000,
      `disappearance timeout is bounded near its 100ms deadline (${injectedDisappearanceElapsedMs}ms)`,
    );
    assert.equal(injectedDisappearanceSignals, 2, 'synthetic disappearance seam injects TERM and KILL without real process signals');
  }
}

function gitStatus(root: string): string {
  return git(root, ['status', '--short']);
}

function writeConfig(root: string): void {
  writeFileSync(
    join(root, 'lattice.config.json'),
    JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
    }, null, 2) + '\n',
    'utf8',
  );
  resetConfigCache();
}

function baseStory(): StoryInfo {
  return {
    storyId: STORY_ID,
    name: 'live-smoke-transcript-smoke',
    title: 'Implement live_smoke_transcript',
    description: 'Explicit live-smoke transcript producer with independent capture/write opt-ins.',
    type: 'feature',
    phase: 'TEST',
    priority: 'high',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  };
}

function checklistWithUserSees(): ChecklistData {
  return {
    items: [
      {
        id: 'CHK-001',
        title: 'Item with a userSees expected output',
        context: 'live-smoke transcript expected vs actual',
        status: 'done',
        startTime: null,
        endTime: null,
        userSees: USER_SEES,
      },
    ],
  };
}

function createFixture(
  seedChecklist: () => ChecklistData,
  storyPhase: StoryInfo['phase'] = 'TEST',
): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-live-smoke-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# live smoke transcript smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 1;\n', 'utf8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'lattice.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);

  const store = new StoryStore(root);
  store.writeStory(STORY_ID, { ...baseStory(), phase: storyPhase });
  store.writeChecklist(STORY_ID, seedChecklist());
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  return { root, store, ctx };
}

function snapshotDir(root: string, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  function walk(abs: string): void {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const path = join(abs, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out[relative(root, path)] = readFileSync(path, 'utf8');
    }
  }
  walk(dir);
  return out;
}

function assertNoAuthorityOrEvidenceArtifacts(store: StoryStore): void {
  for (const artifact of [
    'test-evidence.json',
    'review-runs.json',
    'review-passes.json',
    'findings.json',
    'delivery-check.json',
    'summary.json',
    'done-required-evidence.json',
    'authority-receipt-refs.json',
    'verification-evidence.json',
  ]) {
    assert.equal(existsSync(store.storyFilePath(STORY_ID, artifact)), false, `${artifact} must not be written`);
  }
}

function artifactPath(store: StoryStore): string {
  return store.storyFilePath(STORY_ID, ARTIFACT_REL);
}

function assertOnlyTranscriptArtifactInEvidenceDir(store: StoryStore): void {
  const evidenceDir = join(store.storyDirPath(STORY_ID), 'evidence');
  const entries = readdirSync(evidenceDir).sort();
  assert.deepEqual(entries, ['live-smoke-transcript.json'], 'evidence dir contains only the transcript artifact after --write');
  assert.equal(entries.some((entry) => entry.includes('.tmp-')), false, 'evidence dir contains no live-smoke transcript temp residue');
}

// ---- Policy / registration assertions -------------------------------------

assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'live_smoke_transcript'), 'MAIN_TOOLS exposes live_smoke_transcript');
const policy = getCommandPolicy('live_smoke_transcript');
assert.equal(policy?.ownershipClass, 'readOnly', 'live_smoke_transcript base policy is readOnly');
assert.equal(policy?.destructiveRisk, 'none', 'live_smoke_transcript policy has no static destructive risk');
assert.equal(isCommandAllowed('live_smoke_transcript', 'REVIEW', DEFAULT_PHASE_TOOLS), true, 'available in REVIEW');
assert.equal(isCommandAllowed('live_smoke_transcript', 'TEST', DEFAULT_PHASE_TOOLS), true, 'available in TEST');
assert.equal(isCommandAllowed('live_smoke_transcript', 'DONE', DEFAULT_PHASE_TOOLS), true, 'available in DONE');

// The ownership gate escalates --write only; default and --capture-only stay readOnly for WRITES.
assert.equal(
  resolveEffectiveOwnershipClass('live_smoke_transcript', { storyId: STORY_ID }, STORY_ID),
  'readOnly',
  'read-only default remains effectively readOnly',
);
assert.equal(
  resolveEffectiveOwnershipClass('live_smoke_transcript', { storyId: STORY_ID, capture: 'echo hi' }, STORY_ID),
  'readOnly',
  '--capture-without-write is NOT a story-scoped metadata write (it runs a command but persists nothing)',
);
assert.equal(
  resolveEffectiveOwnershipClass('live_smoke_transcript', { storyId: STORY_ID, write: true }, STORY_ID),
  'storyScopedMutating',
  '--write is effectively storyScopedMutating',
);
assert.equal(
  resolveEffectiveOwnershipClass('live_smoke_transcript', { storyId: STORY_ID, write: 'true' }, STORY_ID),
  'storyScopedMutating',
  '--write string truth is still owner-gated before schema-normalized callers',
);

// ---- Fail-closed boundary (no store read on side-effect flags) ------------

{
  const throwingStore = new Proxy({}, {
    get(_t, prop) {
      throw new Error(`store read should not happen before live_smoke_transcript rejection: ${String(prop)}`);
    },
  }) as StoryStore;
  const ctx: HandlerContext = { store: throwingStore, root: '/tmp/live-smoke-no-read', scanRoot: '/tmp/live-smoke-no-read/packages/main' };
  const handler = createMainRegistry(ctx).get('live_smoke_transcript');
  assert.ok(handler, 'registry exposes live_smoke_transcript for rejection test');
  for (const flag of ['runCommands', 'advancePhase', 'launchReviewers', 'authorityDone', 'fullAuthorityDone', 'productionDone'] as const) {
    assert.throws(
      () => handler!({ storyId: 'B-no-read', [flag]: true, json: true }),
      /refuses unsupported side effects|no story facts were read/,
      `${flag}=true fails closed before store reads`,
    );
  }
  // --capture and --write are the sanctioned opt-ins and must NOT be rejected by assertBoundary.
  for (const ok of [{ capture: 'echo ok' }, { write: true }] as const) {
    try {
      handler!({ storyId: 'B-no-read', ...ok, json: true });
    } catch (err) {
      assert.doesNotMatch(
        err instanceof Error ? err.message : String(err),
        /refuses unsupported side effects/,
        `${JSON.stringify(ok)} is NOT rejected by assertBoundary (sanctioned opt-in)`,
      );
    }
  }
}

// ---- invalid storyId is rejected before storyExists/path use ---------------

{
  const { root, store, ctx } = createFixture(checklistWithUserSees);
  try {
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');
    assert.ok(handler, 'registry exposes live_smoke_transcript for invalid storyId test');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const invalidCases = [
      { storyId: '../../outside', rogueDir: join(root, '.lattice', 'outside') },
      { storyId: 'B-bad/leaf', rogueDir: join(root, '.lattice', 'story', 'actives', 'B-bad', 'leaf') },
    ];

    for (const { storyId, rogueDir } of invalidCases) {
      mkdirSync(rogueDir, { recursive: true });
      writeFileSync(join(rogueDir, 'index.json'), JSON.stringify({ ...baseStory(), storyId }, null, 2) + '\n', 'utf8');
      assert.throws(
        () => handler!({ storyId, write: true, json: true }),
        /live_smoke_transcript: invalid storyId .*path traversal/,
        `invalid storyId ${storyId} is rejected before path-derived writes`,
      );
      assert.equal(existsSync(join(rogueDir, ARTIFACT_REL)), false, `invalid storyId ${storyId} writes no outside transcript`);
      assert.equal(existsSync(join(rogueDir, 'evidence')), false, `invalid storyId ${storyId} creates no outside evidence dir`);
    }

    assert.equal(existsSync(artifactPath(store)), false, 'invalid storyId attempts do not write the real story artifact');
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'invalid storyId attempts leave the real story metadata unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (a) default read-only: no command run, no artifact written ------------

{
  const { root, store, ctx } = createFixture(checklistWithUserSees);
  try {
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');
    assert.ok(handler, 'registry exposes live_smoke_transcript');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const beforeStatus = gitStatus(root);

    const report = handler!({ storyId: STORY_ID, json: true }) as LiveSmokeTranscriptReport;
    assert.equal(report.storyId, STORY_ID);
    assert.equal(report.mode.runCommands, false, 'default runs no command');
    assert.equal(report.mode.writeEvidence, false, 'default writes nothing');
    assert.equal(report.expected, USER_SEES, 'expected is read from checklist userSees');
    assert.equal(report.transcript.status, 'missing', 'no artifact yet → transcript missing');
    assert.equal(report.actual, null, 'no actual captured by default');
    assert.equal(report.write.requested, false);
    assert.equal(report.write.persisted, false);
    assert.equal(report.claims.authorityDone, false);
    assert.equal(report.claims.fullAuthorityDone, false);
    assert.equal(report.claims.productionDone, false);

    // text render is coherent and read-only.
    const text = handler!({ storyId: STORY_ID, format: 'text' }) as string;
    assert.match(text, /Live smoke transcript \(B-livesmoke\)/);
    assert.match(text, /mode: read-only status \(no command run, no artifact written\)/);
    assert.match(text, /expected \(from userSees\):/);
    assert.match(text, /current transcript: missing/);
    assert.match(text, /Live-smoke readiness row:/);
    assert.match(text, /admissibilityStatus: transcript-context/);

    assert.equal(existsSync(artifactPath(store)), false, 'default writes no transcript artifact');
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'default must not mutate story metadata files');
    assert.equal(gitStatus(root), beforeStatus, 'default must leave git status unchanged');
    assertNoAuthorityOrEvidenceArtifacts(store);
    assert.equal(store.readStory(STORY_ID).phase, 'TEST', 'default must not advance phase');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (b) --capture runs ONLY that command; NOTHING persisted ---------------

{
  const { root, store, ctx } = createFixture(checklistWithUserSees);
  try {
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');
    assert.ok(handler, 'registry exposes live_smoke_transcript for capture test');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);

    const report = await handler!({ storyId: STORY_ID, capture: `echo ${MARKER}`, json: true }) as LiveSmokeTranscriptReport;
    assert.equal(report.mode.runCommands, true, '--capture ran the provided command');
    assert.equal(report.mode.writeEvidence, false, '--capture alone writes nothing (writeEvidence=false)');
    assert.ok(report.actual, '--capture records an actual transcript');
    assert.equal(report.actual!.command, `echo ${MARKER}`, 'records exactly the provided command');
    assert.equal(report.actual!.exitCode, 0, 'records the exit code');
    assert.match(report.actual!.stdout, new RegExp(MARKER), 'captured stdout contains the marker');
    assert.equal(report.write.persisted, false, '--capture-without-write persists no artifact');

    assert.equal(existsSync(artifactPath(store)), false, 'capture-only writes no transcript artifact');
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'capture-only must not mutate story metadata');
    assertNoAuthorityOrEvidenceArtifacts(store);
    assert.equal(store.readStory(STORY_ID).phase, 'TEST', 'capture must not advance phase');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (c) --write persists the expected-vs-actual artifact ------------------

{
  const { root, store, ctx } = createFixture(checklistWithUserSees);
  try {
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');
    assert.ok(handler, 'registry exposes live_smoke_transcript for write test');

    const report = await handler!({ storyId: STORY_ID, capture: `echo ${MARKER}`, write: true, json: true }) as LiveSmokeTranscriptReport;
    assert.equal(report.mode.runCommands, true, '--capture + --write ran the command');
    assert.equal(report.mode.writeEvidence, true, '--write persisted the artifact');
    assert.equal(report.write.requested, true);
    assert.equal(report.write.persisted, true);
    assert.equal(report.write.artifactPath, artifactPath(store), 'reports the persisted artifact path');
    assert.equal(report.transcript.status, 'present-fresh', 'after a fresh --write the artifact is present(fresh)');

    assert.equal(existsSync(artifactPath(store)), true, '--write created the transcript artifact');
    assertOnlyTranscriptArtifactInEvidenceDir(store);
    const persisted = JSON.parse(readFileSync(artifactPath(store), 'utf8'));
    assert.equal(persisted.storyId, STORY_ID, 'artifact records storyId');
    assert.equal(persisted.expected, USER_SEES, 'artifact records expected from userSees');
    assert.ok(persisted.actual, 'artifact records the captured actual');
    assert.equal(persisted.actual.command, `echo ${MARKER}`, 'artifact records the exact command');
    assert.equal(persisted.actual.exitCode, 0, 'artifact records the exit code');
    assert.match(persisted.actual.stdout, new RegExp(MARKER), 'artifact stdout contains the marker');
    assert.equal(persisted.mode.runCommands, true, 'artifact mode reflects the capture');
    assert.equal(persisted.mode.writeEvidence, true, 'artifact mode reflects the write');
    assert.equal(persisted.claims.authorityDone, false, 'artifact claims authorityDone=false');
    assert.equal(persisted.claims.productionDone, false, 'artifact claims productionDone=false');
    assert.equal(typeof persisted.headHash, 'string', 'artifact records a headHash for freshness');

    assertNoAuthorityOrEvidenceArtifacts(store);
    assert.equal(store.readStory(STORY_ID).phase, 'TEST', '--write must not advance phase');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- capture budgets: direct closeout commands get their legal budget only --

{
  const { root } = createFixture(checklistWithUserSees);
  const savedOverride = process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS;
  const savedArgv1 = process.argv[1];
  const phaseEnvName = 'LATTICE_DONE_PREPARE_DONE_CLOSURE_TIMEOUT_MS';
  const savedPhaseTimeout = process.env[phaseEnvName];
  try {
    writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
      doneRequiredCommands: [{ label: 'long legal suite', command: 'npm', args: ['test'], timeoutMs: 120_000 }],
    }, null, 2) + '\n', 'utf8');
    resetConfigCache();
    const installedLattice = execFileSync('/bin/sh', ['-c', 'command -v lattice'], { encoding: 'utf8' }).trim();
    const activeCliEntrypoint = realpathSync(installedLattice);
    process.argv[1] = activeCliEntrypoint;
    const globalBin = join(root, 'global-bin');
    const latticeSymlink = join(globalBin, 'lattice');
    mkdirSync(globalBin, { recursive: true });
    symlinkSync(activeCliEntrypoint, latticeSymlink);
    assert.equal(realpathSync(latticeSymlink), activeCliEntrypoint, 'fixture mirrors a global lattice symlink to the exact active CLI realpath');
    const budgetEnv = { ...process.env, PATH: `${globalBin}${delimiter}${process.env.PATH ?? ''}` };
    const doneRequiredCommand = 'lattice done_required_validate --storyId=B-livesmoke --json';
    const donePrepareCommand = 'lattice done_prepare --storyId=B-livesmoke --json';

    const direct = liveSmokeCaptureBudget(root, `LATTICE_SESSION_ID=stable ${doneRequiredCommand}`, budgetEnv);
    assert.equal(direct.nestedMaxTimeoutMs, 150_000, 'direct DONE-required nested max derives command timeout plus validation grace');
    assert.equal(direct.timeoutMs, 153_000, 'direct DONE-required capture adds cleanup grace above the nested max');
    assert.equal(direct.recognizedCommand, 'done_required_validate');

    const fakeProjectCli = join(root, 'bin', 'lattice.js');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(fakeProjectCli, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(fakeProjectCli, 0o755);
    const selfAuthorized = liveSmokeCaptureBudget(
      root,
      `${fakeProjectCli} done_required_validate --storyId=B-livesmoke`,
      budgetEnv,
    );
    assert.equal(selfAuthorized.recognizedCommand, null, 'chmod fake project CLI cannot self-authorize a widened budget');
    assert.equal(selfAuthorized.timeoutMs, 60_000);

    const nodeAliasBin = join(root, 'node-alias-bin');
    mkdirSync(nodeAliasBin, { recursive: true });
    symlinkSync(process.execPath, join(nodeAliasBin, 'lattice'));
    const nodeAlias = liveSmokeCaptureBudget(
      root,
      doneRequiredCommand,
      { ...budgetEnv, PATH: `${nodeAliasBin}${delimiter}${budgetEnv.PATH ?? ''}` },
    );
    assert.equal(nodeAlias.recognizedCommand, null, 'PATH lattice symlink to node cannot impersonate the active CLI');
    assert.equal(nodeAlias.timeoutMs, 60_000);
    assert.equal(
      commandCliMaxBudget(root, 'live_smoke_transcript', {
        capture: doneRequiredCommand,
      }, budgetEnv).timeoutMs,
      183_000,
      'outer CLI max watchdog allows the derived capture budget plus handler grace',
    );
    const directDonePrepare = liveSmokeCaptureBudget(root, donePrepareCommand, budgetEnv);
    assert.equal(directDonePrepare.recognizedCommand, 'done_prepare');
    assert.equal(
      directDonePrepare.timeoutMs,
      commandCliMaxBudget(root, 'done_prepare', { validate: true }, budgetEnv).timeoutMs + LIVE_SMOKE_CAPTURE_CLEANUP_GRACE_MS,
      'direct done_prepare capture adds cleanup grace above the complete configured nested closeout budget',
    );

    const arbitrary = liveSmokeCaptureBudget(root, 'node long-arbitrary-script.js', budgetEnv);
    assert.equal(arbitrary.timeoutMs, 60_000, 'arbitrary captures retain the fixed safety ceiling');
    const composed = liveSmokeCaptureBudget(root, 'lattice done_required_validate --storyId=B-livesmoke; node extra.js', budgetEnv);
    assert.equal(composed.timeoutMs, 60_000, 'shell-composed input cannot obtain the wider closeout budget');
    for (const injected of [
      `PATH=/tmp/attacker ${doneRequiredCommand}`,
      `LD_PRELOAD=/tmp/attacker.so ${doneRequiredCommand}`,
      `NODE_OPTIONS=--require=/tmp/attacker.cjs ${doneRequiredCommand}`,
      `LATTICE_MAX_TIMEOUT_MS=90000 ${doneRequiredCommand}`,
      `LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS=75 ${doneRequiredCommand}`,
    ]) {
      const budget = liveSmokeCaptureBudget(root, injected, budgetEnv);
      assert.equal(budget.timeoutMs, 60_000, `${injected.split('=')[0]} injection retains arbitrary-command ceiling`);
      assert.equal(budget.recognizedCommand, null);
    }

    const inheritedMaxEnv = { ...budgetEnv, LATTICE_MAX_TIMEOUT_MS: '1000' };
    const inheritedMax = liveSmokeCaptureBudget(root, doneRequiredCommand, inheritedMaxEnv);
    assert.equal(inheritedMax.nestedMaxTimeoutMs, 1_000, 'nested closeout keeps inherited max as its business bound');
    assert.equal(inheritedMax.timeoutMs, 1_000 + LIVE_SMOKE_CAPTURE_CLEANUP_GRACE_MS, 'capture wrapper outlives nested max by cleanup grace');
    assert.equal(inheritedMax.source, 'inherited-cli-max');
    const outerBudget = effectiveCommandCliMaxBudget(
      root,
      'live_smoke_transcript',
      { capture: doneRequiredCommand },
      inheritedMaxEnv,
    );
    assert.equal(outerBudget.timeoutMs, inheritedMax.timeoutMs + 30_000, 'outer live-smoke watchdog outlives capture cleanup by wrapper grace');
    assert.ok(outerBudget.timeoutMs > inheritedMax.timeoutMs && inheritedMax.timeoutMs > inheritedMax.nestedMaxTimeoutMs!);
    assert.equal(
      effectiveCommandCliMaxBudget(root, 'story_get', {}, inheritedMaxEnv).timeoutMs,
      1_000,
      'unrelated commands still honor the raw explicit CLI max',
    );
    const saturatedEnv = {
      ...budgetEnv,
      LATTICE_MAX_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER),
    };
    const clampedInheritedMax = liveSmokeCaptureBudget(root, doneRequiredCommand, saturatedEnv);
    const expectedSaturatedNested = NODE_TIMER_MAX_MS - LIVE_SMOKE_CAPTURE_CLEANUP_GRACE_MS - 30_000;
    assert.equal(clampedInheritedMax.requestedNestedMaxTimeoutMs, NODE_TIMER_MAX_MS, 'oversized inherited max is first clamped to Node timer maximum');
    assert.equal(clampedInheritedMax.nestedMaxTimeoutMs, expectedSaturatedNested, 'saturation reserves both cleanup layers below Node max');
    assert.equal(clampedInheritedMax.timeoutMs, expectedSaturatedNested + LIVE_SMOKE_CAPTURE_CLEANUP_GRACE_MS);
    assert.equal(clampedInheritedMax.source, 'inherited-cli-max-saturation-adjusted');
    assert.equal(clampedInheritedMax.saturationAdjusted, true);
    const saturatedOuter = effectiveCommandCliMaxBudget(
      root,
      'live_smoke_transcript',
      { capture: doneRequiredCommand },
      saturatedEnv,
    );
    assert.equal(saturatedOuter.timeoutMs, NODE_TIMER_MAX_MS);
    assert.ok(
      clampedInheritedMax.nestedMaxTimeoutMs! < clampedInheritedMax.timeoutMs && clampedInheritedMax.timeoutMs < saturatedOuter.timeoutMs,
      'recognized saturated budgets preserve strict nested < capture < outer ordering',
    );

    writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
      doneRequiredCommands: [{ label: 'saturated configured suite', command: 'npm', args: ['test'], timeoutMs: Number.MAX_SAFE_INTEGER }],
    }, null, 2) + '\n', 'utf8');
    resetConfigCache();
    const configSaturated = liveSmokeCaptureBudget(root, doneRequiredCommand, budgetEnv);
    assert.equal(configSaturated.source, 'derived-closeout-saturation-adjusted');
    assert.equal(configSaturated.nestedMaxTimeoutMs, expectedSaturatedNested, 'configured saturation reserves both wrapper grace layers');
    const configOuter = effectiveCommandCliMaxBudget(root, 'live_smoke_transcript', { capture: doneRequiredCommand }, budgetEnv);
    assert.ok(configSaturated.nestedMaxTimeoutMs! < configSaturated.timeoutMs && configSaturated.timeoutMs < configOuter.timeoutMs);

    process.env[phaseEnvName] = String(Number.MAX_SAFE_INTEGER);
    const phaseSaturated = liveSmokeCaptureBudget(root, donePrepareCommand, budgetEnv);
    assert.equal(phaseSaturated.source, 'derived-closeout-saturation-adjusted');
    assert.equal(phaseSaturated.nestedMaxTimeoutMs, expectedSaturatedNested, 'phase-derived saturation reserves both wrapper grace layers');
    const phaseOuter = effectiveCommandCliMaxBudget(root, 'live_smoke_transcript', { capture: donePrepareCommand }, budgetEnv);
    assert.ok(phaseSaturated.nestedMaxTimeoutMs! < phaseSaturated.timeoutMs && phaseSaturated.timeoutMs < phaseOuter.timeoutMs);

    const boundedHighOverride = liveSmokeCaptureBudget(root, 'node arbitrary.js', {
      ...budgetEnv,
      LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS: '999999999',
    });
    assert.equal(boundedHighOverride.timeoutMs, 60_000, 'explicit override cannot raise arbitrary-command safety ceiling');
    const boundedLowOverride = liveSmokeCaptureBudget(root, doneRequiredCommand, {
      ...budgetEnv,
      LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS: '75',
    });
    assert.equal(boundedLowOverride.timeoutMs, 75, 'explicit override may lower a recognized command budget for testing/operations');
  } finally {
    if (savedOverride === undefined) delete process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS;
    else process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS = savedOverride;
    process.argv[1] = savedArgv1;
    if (savedPhaseTimeout === undefined) delete process.env[phaseEnvName];
    else process.env[phaseEnvName] = savedPhaseTimeout;
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- timeout kills the process group and reclaims its dead validation lock --

{
  const { root, store, ctx } = createFixture(checklistWithUserSees);
  const savedOverride = process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS;
  try {
    const lockPath = validationExecutionLockPath(root, STORY_ID);
    const descendantPidPath = join(root, 'descendant.pid');
    const scriptPath = join(root, 'hanging-capture.cjs');
    writeFileSync(scriptPath, [
      "const { spawn } = require('node:child_process');",
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "const { hostname } = require('node:os');",
      `const lockPath = ${JSON.stringify(lockPath)};`,
      `const pidPath = ${JSON.stringify(descendantPidPath)};`,
      "mkdirSync(lockPath, { recursive: true });",
      "writeFileSync(lockPath + '/holder.json', JSON.stringify({ pid: process.pid, hostname: hostname(), command: 'done_required_validate for B-livesmoke', acquiredAt: new Date().toISOString() }));",
      "const child = spawn(process.execPath, ['-e', 'process.on(\\\"SIGTERM\\\",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });",
      "writeFileSync(pidPath, String(child.pid));",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join('\n') + '\n', 'utf8');
    process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS = '2000';
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');
    assert.ok(handler);
    const pidReady = new Promise<void>((resolveReady, rejectReady) => {
      let settled = false;
      const watcher = watch(root, (_event, filename) => {
        if (filename === 'descendant.pid' && existsSync(descendantPidPath)) settle();
      });
      const probe = setInterval(() => {
        if (existsSync(descendantPidPath)) settle();
      }, 25);
      const deadline = setTimeout(
        () => settle(new Error('in-process descendant PID readiness handshake timed out')),
        15_000,
      );
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        watcher.close();
        clearInterval(probe);
        clearTimeout(deadline);
        if (error) rejectReady(error);
        else resolveReady();
      };
      if (existsSync(descendantPidPath)) settle();
    });
    const reportPromise = handler!({
      storyId: STORY_ID,
      capture: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
      write: true,
      json: true,
    }) as Promise<LiveSmokeTranscriptReport>;
    await pidReady;
    const report = await reportPromise;

    assert.equal(report.actual?.exitCode, null, 'capture timeout is represented as a null terminal exit');
    assert.match(report.actual?.stderr ?? '', /exceeded 2000ms timeout; process group terminated/);
    const descendantPid = Number(readFileSync(descendantPidPath, 'utf8'));
    assert.throws(() => process.kill(descendantPid, 0), /ESRCH/, 'timed-out capture leaves no descendant process');
    assert.equal(existsSync(lockPath), false, 'dead validation lock is reclaimed after timeout cleanup');
    assert.equal(report.transcript.status, 'present-fresh', 'timeout with --write persists a readable fresh transcript');
    const persisted = JSON.parse(readFileSync(artifactPath(store), 'utf8'));
    assert.equal(persisted.actual.exitCode, null, 'timeout readback remains a non-pass null exit');
    assert.match(persisted.actual.stderr, /exceeded 2000ms timeout/);

    const validationRetry = await withValidationExecutionLock({
      root,
      storyId: STORY_ID,
      workspaceRoot: root,
      command: 'immediate post-timeout validation rerun',
    }, () => 'rerun-pass');
    assert.equal(validationRetry, 'rerun-pass', 'validation writer can reacquire the story lock immediately after timeout cleanup');

    const immediateRetry = await handler!({
      storyId: STORY_ID,
      capture: `echo ${MARKER}-RETRY`,
      json: true,
    }) as LiveSmokeTranscriptReport;
    assert.equal(immediateRetry.actual?.exitCode, 0, 'capture can rerun immediately after timeout cleanup');
    assert.match(immediateRetry.actual?.stdout ?? '', new RegExp(`${MARKER}-RETRY`));
  } finally {
    if (savedOverride === undefined) delete process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS;
    else process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS = savedOverride;
    rmSync(root, { recursive: true, force: true });
  }
}

// A timeout may reclaim its dead nested validator lock, but must preserve a
// separate live validator owned by another process/context.
{
  const { root, ctx } = createFixture(checklistWithUserSees);
  const savedOverride = process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS;
  try {
    const lockPath = validationExecutionLockPath(root, STORY_ID);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, 'holder.json'), JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      command: 'separate live validate for B-livesmoke',
      acquiredAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8');
    const scriptPath = join(root, 'unrelated-hang.cjs');
    writeFileSync(scriptPath, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n", 'utf8');
    process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS = '100';
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');
    const report = await handler!({
      storyId: STORY_ID,
      capture: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
      json: true,
    }) as LiveSmokeTranscriptReport;
    assert.equal(report.actual?.exitCode, null);
    assert.equal(existsSync(lockPath), true, 'timeout cleanup preserves a separately live validation lock');
  } finally {
    if (savedOverride === undefined) delete process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS;
    else process.env.LATTICE_LIVE_SMOKE_CAPTURE_TIMEOUT_MS = savedOverride;
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (d) INDEPENDENCE: capture-without-write & write-without-capture --------

{
  // capture-without-write: runs the command, writes no artifact (already proven in
  // block (b)); here we additionally prove write-without-capture: persists from the
  // (absent) actual without running any command.
  const { root, store, ctx } = createFixture(checklistWithUserSees);
  try {
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');
    assert.ok(handler, 'registry exposes live_smoke_transcript for independence test');

    const report = handler!({ storyId: STORY_ID, write: true, json: true }) as LiveSmokeTranscriptReport;
    assert.equal(report.mode.runCommands, false, '--write-without-capture runs NO command');
    assert.equal(report.actual, null, '--write-without-capture has no actual (none captured)');
    assert.equal(report.mode.writeEvidence, true, '--write persisted even without a capture');
    assert.equal(report.write.persisted, true);

    assert.equal(existsSync(artifactPath(store)), true, '--write-without-capture still creates the artifact');
    assertOnlyTranscriptArtifactInEvidenceDir(store);
    const persisted = JSON.parse(readFileSync(artifactPath(store), 'utf8'));
    assert.equal(persisted.actual, null, 'write-without-capture records actual=null (no command was run)');
    assert.equal(persisted.expected, USER_SEES, 'write-without-capture still records the expected output');
    assert.equal(persisted.mode.runCommands, false, 'artifact mode records that no command ran');
    assertNoAuthorityOrEvidenceArtifacts(store);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (e) --write through a FAILING owner/scope gate leaves state unchanged --

{
  const { root, store } = createFixture(checklistWithUserSees);
  const savedSession = process.env.LATTICE_SESSION_ID;
  try {
    const storyDir = store.storyDirPath(STORY_ID);
    process.env.LATTICE_SESSION_ID = 'sess-owner';
    resetSessionIdForTest();
    acquireOwnerLease(storyDir, { command: 'checklist_add', cwd: '/tmp/owner-worktree' });
    const leaseBefore = readFileSync(ownerLeasePath(storyDir), 'utf8');
    const snapshotBefore = snapshotDir(root, storyDir);
    const statusBefore = gitStatus(root);

    process.env.LATTICE_SESSION_ID = 'sess-intruder';
    resetSessionIdForTest();

    // Default read-only is ungated even on a foreign-owned story.
    assert.doesNotThrow(
      () => enforceStoryOwnerLeaseGate('live_smoke_transcript', { storyId: STORY_ID }, store, null, root),
      'read-only default is not owner-gated on a foreign-owned story',
    );
    // --capture-without-write is ungated for writes (it runs a command but persists nothing).
    assert.doesNotThrow(
      () => enforceStoryOwnerLeaseGate('live_smoke_transcript', { storyId: STORY_ID, capture: 'echo hi' }, store, null, root),
      '--capture-without-write is not owner-gated on a foreign-owned story',
    );
    // --write is owner-gated and must throw before any write.
    assert.throws(
      () => enforceStoryOwnerLeaseGate('live_smoke_transcript', { storyId: STORY_ID, write: true }, store, null, root),
      /owner|owned by another/i,
      '--write is owner-gated on a foreign-owned story',
    );

    assert.equal(readFileSync(ownerLeasePath(storyDir), 'utf8'), leaseBefore, 'rejected --write leaves the foreign owner lease untouched');
    assert.equal(existsSync(artifactPath(store)), false, 'rejected owner gate leaves no transcript artifact (no partial write)');
    assert.deepEqual(snapshotDir(root, storyDir), snapshotBefore, 'rejected owner gate leaves story metadata unchanged');
    assert.equal(gitStatus(root), statusBefore, 'rejected owner gate leaves git status unchanged');
    assertNoAuthorityOrEvidenceArtifacts(store);
  } finally {
    if (savedSession === undefined) delete process.env.LATTICE_SESSION_ID;
    else process.env.LATTICE_SESSION_ID = savedSession;
    resetSessionIdForTest();
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (f) degenerate input: no userSees / no transcript → missing, no crash --

{
  const { root, store, ctx } = createFixture(() => ({
    items: [
      {
        id: 'CHK-001',
        title: 'Item with no userSees',
        context: 'degenerate',
        status: 'done',
        startTime: null,
        endTime: null,
      },
    ],
  }));
  try {
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');
    assert.ok(handler, 'registry exposes live_smoke_transcript for degenerate test');

    const report = handler!({ storyId: STORY_ID, json: true }) as LiveSmokeTranscriptReport;
    assert.equal(report.expected, null, 'no userSees → expected is null (no crash)');
    assert.equal(report.transcript.status, 'missing', 'no artifact → missing (no crash)');
    const text = handler!({ storyId: STORY_ID, format: 'text' }) as string;
    assert.match(text, /expected \(from userSees\): \(none authored\)/, 'renders the no-userSees case');
    assertNoAuthorityOrEvidenceArtifacts(store);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- nonexistent story errors clearly and writes nothing -------------------

{
  const { root, store, ctx } = createFixture(checklistWithUserSees);
  try {
    const handler = createMainRegistry(ctx).get('live_smoke_transcript');
    assert.ok(handler, 'registry exposes live_smoke_transcript for nonexistent-story test');

    const MISSING_ID = 'B-nonexistent';
    assert.equal(store.storyExists(MISSING_ID), false, 'precondition: the missing story id does not exist');
    const statusBefore = gitStatus(root);

    for (const extra of [{}, { capture: 'echo hi' }, { write: true }] as const) {
      assert.throws(
        () => handler!({ storyId: MISSING_ID, ...extra, json: true }),
        /live_smoke_transcript: story B-nonexistent not found/,
        `nonexistent story (${JSON.stringify(extra)}) throws a clear not-found error`,
      );
    }
    assert.equal(existsSync(store.storyDirPath(MISSING_ID)), false, 'no story directory was created for the missing id');
    assert.equal(gitStatus(root), statusBefore, 'nonexistent-story rejection leaves git status unchanged');
    assert.equal(store.readStory(STORY_ID).phase, 'TEST', 'real story is unaffected by the rejected missing-id calls');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

process.stdout.write('live_smoke_transcript smoke passed\n');
