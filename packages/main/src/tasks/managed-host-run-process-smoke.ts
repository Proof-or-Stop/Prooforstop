#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defaultHostRunRunner,
  runHostRun,
  type HostRunSpawnPlan,
  type HostRunRunner,
} from '../core/host-run.js';
import {
  assertManagedHostRunPlatformSupported,
  cancelManagedHostRun,
  getManagedHostRunStatus,
  recoverManagedHostRun,
  runManagedHostRunSupervisor,
  managedHostRunDirectory,
  readManagedHostRunResult,
  managedHostRunsRoot,
  managedHostRunReceipt,
  reapManagedHostRunProviderProcess,
  runManagedHostRunWorker,
  scanManagedHostRunRuntime,
  submitManagedHostRun,
  type ManagedHostRunWorkerLauncher,
} from '../core/managed-host-run.js';
import { StoryStore } from '../core/store.js';
import { PROOF_OR_STOP_DIR } from '../core/proof-or-stop-paths.js';
import { createDoctorHandlers } from '../handlers/doctor.js';

// Keep the executable doctor assertions hermetic: host burn scans are unrelated
// to ManagedHostRun runtime diagnosis and may inspect user-level provider logs.
process.env.LATTICE_BURN_ALERT_RECENT_HOURS = '0';

const root = mkdtempSync(join(tmpdir(), 'managed-host-run-process-smoke-'));

function args(caseRoot: string, deadlineMs = 3_000) {
  return {
    root: caseRoot,
    cwd: caseRoot,
    host: 'codex' as const,
    storyId: 'B-process',
    phase: 'REVIEW',
    agentType: 'lattice-review-quality',
    promptText: 'process supervision fixture',
    deadlineMs,
    projectRootHash: 'sha256:process-smoke',
  };
}

async function eventually(predicate: () => Promise<boolean>, message: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

const OWNED_WORKER_SETTLEMENT_MS = 5_000;

/**
 * Fixture workers are intentionally launched through the durable detached
 * worker entrypoint.  A failing assertion must still release their owned
 * provider control and bound the wait for that worker; otherwise a deliberately
 * silent fixture can retain this smoke process until its production deadline.
 */
async function settleOwnedWorker(
  worker: Promise<unknown> | null,
  timeoutMs = OWNED_WORKER_SETTLEMENT_MS,
): Promise<boolean> {
  if (!worker) return true;
  return new Promise(resolvePromise => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs);
    worker.then(
      () => {
        clearTimeout(timer);
        resolvePromise(true);
      },
      () => {
        clearTimeout(timer);
        resolvePromise(true);
      },
    );
  });
}

async function main(): Promise<void> {
  assert.throws(
    () => assertManagedHostRunPlatformSupported('win32'),
    /unsupported platform win32/,
    'the unsupported-platform seam must be executable on every CI host before any provider spawn',
  );
  if (process.platform === 'win32') {
    console.log('managed-host-run-process-smoke PASS (POSIX-only cases skipped on unsupported win32)');
    return;
  }

  // F-250: the durable worker's Codex adapter is a protected stdin transport,
  // with JSON usage/progress retention and the caller timeout preserved in the
  // exact production spawn plan. This uses only an injected runner: no provider
  // executable or signal is involved.
  const codexAdapterRoot = join(root, 'codex-managed-review-adapter');
  mkdirSync(codexAdapterRoot, { recursive: true });
  const codexAdapterPlans: HostRunSpawnPlan[] = [];
  const codexUsageEvent = JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 13, cached_input_tokens: 5, output_tokens: 3 },
  });
  const codexAdapter = await runHostRun({
    host: 'codex',
    storyId: 'B-process',
    phase: 'REVIEW',
    agentType: 'lattice-review-quality',
    reviewRunId: 'B-process:codex-adapter',
    lane: 'lattice-review-quality',
    promptText: 'protected managed review prompt',
    timeoutMs: 777,
    launchProfile: 'managed_reviewer',
    env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
    cwd: codexAdapterRoot,
    root: codexAdapterRoot,
    recordedAt: new Date().toISOString(),
    projectRootHash: 'sha256:codex-managed-review-adapter',
  }, {
    runner: async plan => {
      codexAdapterPlans.push(plan);
      return { stdout: codexUsageEvent, stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
    },
  });
  assert.equal(codexAdapter.exitCode, 0, 'injected Codex adapter plan completes without a provider subprocess');
  assert.equal(codexAdapterPlans.length, 1, 'the injected Codex adapter reaches exactly one runner plan');
  const codexAdapterPlan = codexAdapterPlans[0]!;
  assert.deepEqual(codexAdapterPlan.argv, ['exec', '--json', '-s', 'read-only', '-C', codexAdapterRoot, '-'],
    'managed Codex keeps the observable JSON stream, scratch cwd, and stdin sentinel');
  assert.equal(codexAdapterPlan.stdinText, 'protected managed review prompt',
    'managed Codex receives the prompt only through stdin');
  assert.equal(codexAdapterPlan.argv.includes('protected managed review prompt'), false,
    'managed prompt text cannot leak into Codex argv');
  assert.equal(codexAdapterPlan.timeoutMs, 777,
    'the managed provider timeout reaches the actual Codex runner plan');
  assert.equal(codexAdapterPlan.retainUsageLine?.(codexUsageEvent), true,
    'the observable Codex turn.completed usage event is retained for the bound usage adapter');

  const gitRoot = join(root, 'durable-root-git');
  const linkedRoot = join(root, 'durable-root-linked');
  mkdirSync(gitRoot, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: gitRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'managed-smoke@example.invalid'], { cwd: gitRoot });
  execFileSync('git', ['config', 'user.name', 'managed-smoke'], { cwd: gitRoot });
  writeFileSync(join(gitRoot, 'README.md'), 'managed runtime root fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: gitRoot });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: gitRoot, stdio: 'ignore' });
  execFileSync('git', ['worktree', 'add', '-b', 'story/runtime-root', linkedRoot], { cwd: gitRoot, stdio: 'ignore' });
  assert.equal(
    managedHostRunsRoot(linkedRoot),
    join(realpathSync.native(gitRoot), PROOF_OR_STOP_DIR, 'runtime', 'host-runs'),
    'linked Story worktrees must persist ManagedHostRun state under the primary worktree that survives DONE cleanup',
  );

  const treeRoot = join(root, 'tree');
  const treeRelease = join(root, 'tree-provider.release');
  const childScript = [
    "const fs=require('node:fs')",
    "process.on('SIGTERM',()=>{})",
    "process.stdout.write('ready')",
    `const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(root)})||fs.existsSync(${JSON.stringify(treeRelease)})){clearInterval(timer);process.exit(0)}},10)`,
  ].join(';');
  const leaderScript = [
    "const {spawn}=require('node:child_process')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:['ignore','pipe','ignore']})`,
    "child.stdout.once('data',()=>process.exit(0))",
  ].join(';');
  const treeRunner: HostRunRunner = plan => defaultHostRunRunner({
    ...plan,
    command: process.execPath,
    argv: ['-e', leaderScript],
    stdinText: '',
  });
  let treeWorker: Promise<unknown> | null = null;
  let treeWorkerSettled = false;
  const treeLauncher: ManagedHostRunWorkerLauncher = async request => {
    treeWorker = runManagedHostRunWorker(request, { runner: treeRunner, env: { PROOF_OR_STOP_USAGE_LEDGER: '0' } });
    return { pid: process.pid };
  };
  try {
    const tree = await submitManagedHostRun(args(treeRoot), {
      launchWorker: treeLauncher,
      claimTimeoutMs: 500,
      claimPollMs: 5,
    });
    await eventually(async () => (await getManagedHostRunStatus({ root: treeRoot, runId: tree.runId })).run.state === 'completed', 'provider tree did not complete');
    const treeReceipt = managedHostRunReceipt(treeRoot, tree.runId);
    assert.equal(treeReceipt.processCleanup?.reaped, !treeReceipt.processCleanup?.residualProcessGroup,
      'normal leader-exit cleanup must either reap its observed descendants or retain explicit residual truth');
  } finally {
    // This is an owned fixture control, never a process signal.  It must be
    // released even when an assertion above aborts the smoke early.
    writeFileSync(treeRelease, 'release');
    treeWorkerSettled = await settleOwnedWorker(treeWorker);
  }
  assert.equal(treeWorkerSettled, true, 'tree worker must settle after its owned release is published');

  const liveTreeRoot = join(root, 'live-tree');
  const liveTreeReady = join(root, 'live-tree.ready');
  // Failure cleanup removes this fixture root. Each TERM-resistant process
  // independently observes that release, including descendants whose identity
  // cannot safely be established by the production process-group reaper.
  const fixtureKeepAliveScript = `setInterval(()=>{if(!require('node:fs').existsSync(${JSON.stringify(root)}))process.exit(0)},25)`;
  const liveChildScript = [
    "process.on('SIGTERM',()=>{})",
    fixtureKeepAliveScript,
  ].join(';');
  const liveLeaderScript = [
    "const {spawn}=require('node:child_process')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(liveChildScript)}],{stdio:'ignore'})`,
    `require('node:fs').writeFileSync(${JSON.stringify(liveTreeReady)},'ready')`,
    "process.on('SIGTERM',()=>{})",
    fixtureKeepAliveScript,
  ].join(';');
  const liveTreeRunner: HostRunRunner = plan => defaultHostRunRunner({
    ...plan,
    command: process.execPath,
    argv: ['-e', liveLeaderScript],
    stdinText: '',
  });
  const liveTreeLauncher: ManagedHostRunWorkerLauncher = async request => {
    void runManagedHostRunSupervisor(request);
    void runManagedHostRunWorker(request, {
      runner: liveTreeRunner,
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
      cancelPollMs: 5,
    });
    return { pid: process.pid };
  };
  const liveTree = await submitManagedHostRun(args(liveTreeRoot, 500), {
    launchWorker: liveTreeLauncher,
    claimTimeoutMs: 500,
    claimPollMs: 5,
  });
  await eventually(
    async () => existsSync(liveTreeReady),
    'live tree fixture never proved that the provider leader and descendant spawned',
  );
  await eventually(
    async () => existsSync(join(managedHostRunDirectory(liveTreeRoot, liveTree.runId), 'terminal.json')),
    'absolute deadline did not reap the live provider process group including descendants',
    4_000,
  );
  const liveTreeReceipt = managedHostRunReceipt(liveTreeRoot, liveTree.runId);
  assert.equal(liveTreeReceipt.processCleanup?.termSent, true, 'live tree cleanup must send TERM');
  assert.equal(liveTreeReceipt.processCleanup?.killSent, true, 'live tree cleanup must send KILL');
  assert.equal(liveTreeReceipt.processCleanup?.reaped, true, 'live tree cleanup must reap the group');
  assert.equal(liveTreeReceipt.processCleanup?.residualProcessGroup, false, 'live tree cleanup must leave no residual group member');

  // A leaderless but nonempty group has no continuously verified original
  // member. Reconciliation must retain it as replacement-unsafe instead of
  // sending a negative-PGID signal, even through this injected seam.
  const leaderlessSignals: NodeJS.Signals[] = [];
  const leaderlessCleanup = await reapManagedHostRunProviderProcess({
    pid: 41001,
    pgid: 41001,
    spawnedAt: new Date().toISOString(),
    startFingerprint: 'original-leader-start',
    processGroupIsolated: true,
  }, {
    rows: () => [{ pid: 41002, pgid: 41001, sessionId: 41001, start: 'descendant-start' }],
    signal: (_pgid, signal) => { leaderlessSignals.push(signal); },
    wait: async () => {},
  });
  assert.deepEqual(leaderlessSignals, [],
    'leader exit with surviving descendants must not authorize a negative-PGID signal');
  assert.deepEqual(leaderlessCleanup, { termSent: false, killSent: false, reaped: false, residualProcessGroup: true });

  const reusedLeaderSignals: NodeJS.Signals[] = [];
  const reusedLeaderCleanup = await reapManagedHostRunProviderProcess({
    pid: 42001,
    pgid: 42001,
    spawnedAt: new Date().toISOString(),
    startFingerprint: 'original-leader-start',
    processGroupIsolated: true,
  }, {
    rows: () => [{ pid: 42001, pgid: 42001, sessionId: 42001, start: 'reused-leader-start' }],
    signal: (_pgid, signal) => { reusedLeaderSignals.push(signal); },
    wait: async () => {},
  });
  assert.deepEqual(reusedLeaderSignals, [], 'a present leader with a changed fingerprint remains untrusted');
  assert.deepEqual(reusedLeaderCleanup, { termSent: false, killSent: false, reaped: false, residualProcessGroup: true });

  const deadlineCleanupRoot = join(root, 'deadline-cleanup');
  const deadlineProviderReady = join(root, 'deadline-provider.ready');
  const deadlineCleanupRunner: HostRunRunner = plan => defaultHostRunRunner({
    ...plan,
    command: process.execPath,
    argv: [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(deadlineProviderReady)},'ready');process.on('SIGTERM',()=>{});${fixtureKeepAliveScript}`,
    ],
    stdinText: '',
  });
  const deadlineCleanupLauncher: ManagedHostRunWorkerLauncher = async request => {
    void runManagedHostRunWorker(request, {
      runner: deadlineCleanupRunner,
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
      cancelPollMs: 5,
    });
    return { pid: process.pid };
  };
  const deadlineCleanup = await submitManagedHostRun(args(deadlineCleanupRoot, 500), {
    launchWorker: deadlineCleanupLauncher,
    claimTimeoutMs: 500,
    claimPollMs: 5,
  });
  await eventually(
    async () => existsSync(deadlineProviderReady),
    'deadline cleanup fixture never proved that the provider process spawned',
  );
  await eventually(
    async () => existsSync(join(managedHostRunDirectory(deadlineCleanupRoot, deadlineCleanup.runId), 'terminal.json')),
    'absolute deadline did not reap the TERM-resistant provider process group',
    4_000,
  );
  const deadlineCleanupReceipt = managedHostRunReceipt(deadlineCleanupRoot, deadlineCleanup.runId);
  assert.equal(deadlineCleanupReceipt.processCleanup?.termSent, true);
  assert.equal(deadlineCleanupReceipt.processCleanup?.killSent, true);
  assert.equal(deadlineCleanupReceipt.processCleanup?.reaped, true);
  assert.equal(deadlineCleanupReceipt.processCleanup?.residualProcessGroup, false);

  // The provider leader closes before the absolute deadline while its inherited
  // process-group descendant remains. The close fence must give a controlled
  // deadline request time to persist, then retain completed provider facts. A
  // leaderless group is intentionally residual-unknown: it cannot authorize a
  // negative-PGID signal after F-209.
  const closeFenceRoot = join(root, 'close-before-deadline');
  let notifyCloseObserved: (() => void) | null = null;
  const closeObserved = new Promise<void>(resolve => { notifyCloseObserved = resolve; });
  let closeFenceControl: Promise<void> | null = null;
  let closeFenceWorker: Promise<unknown> | null = null;
  // The fallback self-exit bounds residue even if a failing assertion aborts
  // this executable smoke before the real process-group KILL finishes.
  const closeFenceDescendantScript = "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),100)";
  const closeFenceProviderScript = [
    "const {spawn}=require('node:child_process')",
    `spawn(process.execPath,['-e',${JSON.stringify(closeFenceDescendantScript)}],{stdio:'ignore'})`,
    'setTimeout(()=>process.exit(0),10)',
  ].join(';');
  const closeFenceRunner: HostRunRunner = plan => defaultHostRunRunner({
    ...plan,
    command: process.execPath,
    argv: ['-e', closeFenceProviderScript],
    stdinText: '',
  }, {
    onChildCloseObserved: () => notifyCloseObserved?.(),
  });
  const closeFenceLauncher: ManagedHostRunWorkerLauncher = async request => {
    closeFenceWorker = runManagedHostRunWorker(request, {
      runner: closeFenceRunner,
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
      cancelPollMs: 5,
    });
    closeFenceControl = (async () => {
      await closeObserved;
      // This is deliberately an authoritative close-observed callback, not a
      // short wall-clock deadline: request the exact deadline reason only while
      // defaultHostRunRunner is reaping the TERM-resistant descendant.
      const projection = await cancelManagedHostRun({
        root: request.root,
        runId: request.runId,
        reason: 'absolute_deadline_exceeded',
      });
      assert.equal(projection.terminal, null,
        'the controlled deadline request must be recorded during cleanup, before any terminal can be sealed');
    })();
    return { pid: process.pid };
  };
  const closeFence = await submitManagedHostRun(args(closeFenceRoot, 5_000), {
    launchWorker: closeFenceLauncher,
    claimTimeoutMs: 500,
    claimPollMs: 5,
  });
  await eventually(
    async () => existsSync(join(managedHostRunDirectory(closeFenceRoot, closeFence.runId), 'terminal.json')),
    'close-before-deadline fixture did not converge on a terminal record',
    4_000,
  );
  assert.ok(closeFenceControl, 'the close-observed fixture must install its controlled deadline request');
  await closeFenceControl;
  assert.ok(closeFenceWorker, 'the close-observed fixture must keep its worker promise until terminal settlement');
  await closeFenceWorker;
  const closeFenceStatus = await getManagedHostRunStatus({ root: closeFenceRoot, runId: closeFence.runId });
  const closeFenceResult = readManagedHostRunResult(closeFenceRoot, closeFence.runId);
  const closeFenceReceipt = managedHostRunReceipt(closeFenceRoot, closeFence.runId);
  assert.equal(closeFenceStatus.run.state, 'completed',
    'the provider close fence wins over a deadline callback that arrives during descendant cleanup');
  assert.equal(closeFenceStatus.run.terminal?.reason, 'provider_completed',
    'the persisted terminal reason remains the completed provider result, never absolute_deadline_exceeded');
  assert.equal(closeFenceResult?.closeObserved, true);
  assert.match(closeFenceResult?.closeObservedAt ?? '', /^\d{4}-\d{2}-\d{2}T/,
    'the production close fence persists the authoritative close boundary used to order the deadline request');
  assert.equal(closeFenceResult?.exitCode, 0);
  assert.equal(closeFenceResult?.timedOut, false);
  assert.equal(closeFenceReceipt.processCleanup?.reaped, false,
    'the close fence never claims a leaderless descendant group was reaped');
  assert.equal(closeFenceReceipt.processCleanup?.residualProcessGroup, true,
    'a leaderless completed run retains explicit replacement-unsafe residual truth');
  assert.equal(closeFenceReceipt.replacementSafe, false,
    'a retained leaderless group cannot be replacement-safe');
  assert.equal(closeFenceReceipt.state, 'completed',
    'the receipt projects the same completed terminal state');
  assert.equal(
    closeFenceReceipt.terminalDigest,
    `sha256:${createHash('sha256').update(readFileSync(join(managedHostRunDirectory(closeFenceRoot, closeFence.runId), 'terminal.json'), 'utf8'), 'utf8').digest('hex')}`,
    'the receipt is bound to the persisted completed terminal bytes',
  );
  assert.equal(
    closeFenceReceipt.resultDigest,
    `sha256:${createHash('sha256').update(readFileSync(join(managedHostRunDirectory(closeFenceRoot, closeFence.runId), 'result.json'), 'utf8'), 'utf8').digest('hex')}`,
    'the receipt seals the same completed result bytes whose exit/deadline fields it projects',
  );

  const silentRoot = join(root, 'silent');
  const silentReady = join(root, 'silent-provider.ready');
  const silentRelease = join(root, 'silent-provider.release');
  const silentSpawn = join(root, 'silent-provider.spawn');
  const silentProviderScript = [
    "const fs=require('node:fs')",
    `fs.writeFileSync(${JSON.stringify(silentSpawn)},String(process.pid),{flag:'wx'})`,
    `fs.writeFileSync(${JSON.stringify(silentReady)},'ready')`,
    `const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(root)})||fs.existsSync(${JSON.stringify(silentRelease)})){clearInterval(timer);process.exit(0)}},10)`,
  ].join(';');
  const silentRunner: HostRunRunner = plan => defaultHostRunRunner({
    ...plan,
    command: process.execPath,
    argv: ['-e', silentProviderScript],
    stdinText: '',
  });
  const silentLauncher: ManagedHostRunWorkerLauncher = async request => {
    void runManagedHostRunWorker(request, { runner: silentRunner, env: { PROOF_OR_STOP_USAGE_LEDGER: '0' }, heartbeatMs: 60_000 });
    return { pid: process.pid };
  };
  const silent = await submitManagedHostRun(args(silentRoot, 20 * 60_000), {
    launchWorker: silentLauncher,
    claimTimeoutMs: 500,
    claimPollMs: 5,
  });
  await eventually(async () => existsSync(silentReady), 'real silent provider child did not start');
  const legacyObservationNow = Date.now() + 11 * 60_000;
  for (let touch = 0; touch < 3; touch += 1) {
    const oldAndSilent = await recoverManagedHostRun({
      root: silentRoot,
      runId: silent.runId,
      waitMs: 0,
      now: () => legacyObservationNow + touch,
    });
    assert.equal(oldAndSilent.run.state, 'running', `next-touch ${touch + 1}: ten-minute output/heartbeat silence is not a terminal condition`);
    assert.equal(oldAndSilent.run.lastProviderProgressAt, null);
    assert.equal(oldAndSilent.run.providerProgressMode, 'output-observable');
    assert.equal(readFileSync(silentSpawn, 'utf8').trim().length > 0, true, 'the exact real provider child remains the sole spawn');
  }
  writeFileSync(silentRelease, 'release');
  await eventually(async () => (await getManagedHostRunStatus({ root: silentRoot, runId: silent.runId })).run.state === 'completed', 'silent run did not complete after release');

  const unobservableRoot = join(root, 'unobservable-progress');
  let releaseUnobservable!: () => void;
  const unobservableGate = new Promise<void>(resolve => { releaseUnobservable = resolve; });
  const unobservableLauncher: ManagedHostRunWorkerLauncher = async request => {
    void runManagedHostRunWorker(request, {
      runner: async () => {
        await unobservableGate;
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
      },
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
      heartbeatMs: 10,
      cancelPollMs: 5,
    });
    return { pid: process.pid };
  };
  const unobservable = await submitManagedHostRun({
    ...args(unobservableRoot),
    providerProgressMode: 'unobservable',
  }, { launchWorker: unobservableLauncher, claimTimeoutMs: 500, claimPollMs: 5 });
  const firstUnobservableHeartbeat = unobservable.workerHeartbeatAt;
  await new Promise(resolve => setTimeout(resolve, 40));
  const unobservableStatus = await getManagedHostRunStatus({ root: unobservableRoot, runId: unobservable.runId });
  assert.equal(unobservableStatus.run.providerProgressMode, 'unobservable');
  assert.notEqual(unobservableStatus.run.workerHeartbeatAt, firstUnobservableHeartbeat, 'worker heartbeat may advance for an unobservable provider');
  assert.equal(unobservableStatus.run.lastProviderProgressAt, null, 'worker heartbeat must never manufacture provider output progress');
  const unobservableDiagnostic = scanManagedHostRunRuntime(unobservableRoot);
  assert.equal(unobservableDiagnostic.runs[0]?.providerProgressMode, 'unobservable');
  assert.equal(unobservableDiagnostic.runs[0]?.lastProviderProgressAt, null);
  releaseUnobservable();
  await eventually(async () => (await getManagedHostRunStatus({ root: unobservableRoot, runId: unobservable.runId })).run.state === 'completed',
    'unobservable provider control did not complete');

  const missingExecutableRoot = join(root, 'missing-executable');
  const missingExecutableLauncher: ManagedHostRunWorkerLauncher = async request => {
    void runManagedHostRunWorker(request, {
      env: { PROOF_OR_STOP_USAGE_LEDGER: '0', PATH: join(root, 'definitely-missing-bin') },
      cancelPollMs: 5,
    });
    return { pid: process.pid };
  };
  const missingExecutable = await submitManagedHostRun(args(missingExecutableRoot, 1_000), {
    launchWorker: missingExecutableLauncher,
    claimTimeoutMs: 500,
    claimPollMs: 5,
  });
  await eventually(async () => (await getManagedHostRunStatus({ root: missingExecutableRoot, runId: missingExecutable.runId })).run.state === 'failed', 'missing provider executable did not reach failed terminal truth');
  const missingDiagnostic = scanManagedHostRunRuntime(missingExecutableRoot);
  assert.equal(missingDiagnostic.runs[0]?.terminalReason, 'missing_executable', 'doctor runtime projection must surface the missing executable classification');
  const missingDoctor = await createDoctorHandlers({
    store: new StoryStore(missingExecutableRoot),
    root: missingExecutableRoot,
    scanRoot: missingExecutableRoot,
  }).doctor({ format: 'text' });
  assert.match(String(missingDoctor), /Managed host runs:[\s\S]*terminalReason=missing_executable/,
    'the executable doctor report must render the missing provider executable diagnosis');

  const corruptRoot = join(root, 'corrupt-runtime');
  // Create one complete run directory, then publish deliberately malformed state.
  const corruptSubmitted = await submitManagedHostRun(args(corruptRoot, 1_000), {
    launchWorker: async () => ({ pid: process.pid }),
    claimTimeoutMs: 10,
    claimPollMs: 5,
  });
  writeFileSync(join(managedHostRunDirectory(corruptRoot, corruptSubmitted.runId), 'spec.json'), '{corrupt');
  await assert.rejects(
    getManagedHostRunStatus({ root: corruptRoot, runId: corruptSubmitted.runId }),
    /JSON|Unexpected|position/i,
    'status must fail closed on corrupt runtime artifacts instead of fabricating a terminal or replacement',
  );
  const corruptDiagnostic = scanManagedHostRunRuntime(corruptRoot);
  assert.equal(corruptDiagnostic.corrupt, 1, 'doctor runtime projection must report corrupt managed artifacts explicitly');
  const corruptDoctor = await createDoctorHandlers({
    store: new StoryStore(corruptRoot),
    root: corruptRoot,
    scanRoot: corruptRoot,
  }).doctor({ format: 'text' });
  assert.match(String(corruptDoctor), /Managed host runs:[\s\S]*corrupt=1[\s\S]*state=corrupt/,
    'the executable doctor report must render corrupt managed runtime artifacts');

  for (const missingArtifact of ['owner.json', 'snapshot.json', 'terminal.json'] as const) {
    const partialRoot = join(root, `partial-${missingArtifact}`);
    const partial = await submitManagedHostRun(args(partialRoot, 1_000), {
      launchWorker: async () => ({ pid: process.pid }),
      claimTimeoutMs: 10,
      claimPollMs: 5,
    });
    unlinkSync(join(managedHostRunDirectory(partialRoot, partial.runId), missingArtifact));
    await assert.rejects(
      getManagedHostRunStatus({ root: partialRoot, runId: partial.runId }),
      /managed host run .* partial runtime: .* missing|ENOENT/i,
      `status must fail closed when ${missingArtifact} is missing instead of projecting a resumable run`,
    );
    const partialDiagnostic = scanManagedHostRunRuntime(partialRoot);
    assert.equal(partialDiagnostic.corrupt, 1,
      `doctor must classify missing ${missingArtifact} as corrupt runtime state`);
    assert.equal(partialDiagnostic.runs[0]?.replacementSafe, null,
      `missing ${missingArtifact} must preserve unknown replacement safety rather than authorize restart`);
    assert.equal(partialDiagnostic.runs[0]?.residualProcessGroup, null,
      `missing ${missingArtifact} must preserve unknown residual process state`);
  }

  const ambiguousRoot = join(root, 'ambiguous');
  const ambiguousRunner: HostRunRunner = () => new Promise(() => {
    // Intentionally wedged: ignores AbortSignal so next-touch reconciliation,
    // not cooperative worker completion, must make the terminal decision.
  });
  const ambiguousLauncher: ManagedHostRunWorkerLauncher = async request => {
    void runManagedHostRunWorker(request, { runner: ambiguousRunner, env: { PROOF_OR_STOP_USAGE_LEDGER: '0' }, cancelPollMs: 5 });
    return { pid: process.pid };
  };
  // B-137a:F-102 (sibling of the managed-host-run-smoke case): with
  // deadlineMs=40 this raced the next-touch reconciler. If the absolute
  // deadline expired before the ambiguous providerIdentity below was written,
  // the launch fence revoked instead of granting, the reconciler chose
  // REAPED_WITHOUT_SIGNAL, and replacementSafe came back true -- failing an
  // assertion about a state this case never actually reached. It passed 6/6 in
  // isolation but failed under load. Give the run enough deadline to plant the
  // ambiguous identity deterministically, then let the deadline elapse.
  const ambiguousDeadlineMs = 3_000;
  const ambiguous = await submitManagedHostRun(args(ambiguousRoot, ambiguousDeadlineMs), {
    launchWorker: ambiguousLauncher,
    claimTimeoutMs: 500,
    claimPollMs: 5,
  });
  const ambiguousSubmittedAt = Date.now();
  const snapshotPath = join(managedHostRunDirectory(ambiguousRoot, ambiguous.runId), 'snapshot.json');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(snapshotPath, `${JSON.stringify({
    ...snapshot,
    providerIdentity: {
      pid: process.pid,
      pgid: 1,
      spawnedAt: new Date().toISOString(),
      startFingerprint: 'definitely-not-the-live-process-start-fingerprint',
      processGroupIsolated: true,
    },
  })}\n`);
  // Do not consult or signal the real PGID 1. The injected group is deliberately
  // nonempty, so an unsafe "leader absent means safe" cleanup would attempt to
  // signal it; the regression assertion below requires zero signal attempts.
  const ambiguousSignals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
  const unsafePgidOps = {
    rows: (pgid: number) => pgid === 1
      ? [{ pid: 1, pgid: 1, sessionId: 1, start: 'init' }]
      : [],
    signal: (pgid: number, signal: NodeJS.Signals) => { ambiguousSignals.push({ pgid, signal }); },
    wait: async () => {},
  };
  // Let the absolute deadline elapse now that the ambiguous identity is planted.
  await new Promise(resolve => setTimeout(resolve,
    Math.max(1, ambiguousSubmittedAt + ambiguousDeadlineMs + 60 - Date.now())));
  const ambiguousTerminal = await recoverManagedHostRun({
    root: ambiguousRoot,
    runId: ambiguous.runId,
    waitMs: 500,
    processGroupOps: unsafePgidOps,
  });
  assert.equal(ambiguousTerminal.run.state, 'timed_out');
  assert.equal(ambiguousTerminal.run.replacementSafe, false, 'PID/PGID fingerprint ambiguity must never authorize replacement');
  assert.deepEqual(ambiguousSignals, [], 'pgid 1 is never eligible for a process-group signal');
  assert.doesNotThrow(() => process.kill(process.pid, 0), 'ambiguous reconciliation must not signal the mismatched live process');

  console.log('managed-host-run-process-smoke PASS');
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  })
  .finally(() => rmSync(root, { recursive: true, force: true }));
