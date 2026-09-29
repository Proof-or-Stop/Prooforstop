import assert from 'node:assert/strict';



import { existsSync } from 'node:fs';




import { acquireHostRunSlot, defaultHostRunRunner, releaseSlot, runHostRun, hostRunSlotsDir, HOST_RUN_FAILURE_TEXT_CAP, type HostRunRunner, type HostRunRunnerRuntime } from '../../core/host-run.js';











import { checkAsync, deterministicHostRuntime, freshRoot, baseArgs, slotMeta, trackedAbortSignal } from "./support.js";

export async function case78(): Promise<void> {


  // =========================================================================
  // B-3aec: independent first-output and total deadlines.
  // =========================================================================
  await checkAsync('B-3aec startup watchdog: silent child is killed/reaped before total timeout and reports startup_no_output_timeout', async () => {
    const silent = deterministicHostRuntime();
    const resultPromise = defaultHostRunRunner({
      command: 'fake-host', argv: [], env: process.env, cwd: process.cwd(), startupTimeoutMs: 40, timeoutMs: 1000,
    }, {
      ...silent.runtime,
      processGroupIsolated: true,
      readProcessStartFingerprint: () => 'verified-silent-leader',
      isProcessGroupAlive: () => false,
      signalProcessGroup: () => true,
    });
    silent.fire(40);
    silent.child.emit('close', null, 'SIGTERM');
    const result = await resultPromise;
    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, true);
    assert.equal(result.timeoutKind, 'startup_no_output_timeout');
    assert.equal(result.terminalReason, 'startup_no_output_timeout');
    assert.equal(result.firstOutputMs, null);
    assert.equal(silent.activeTimers(), 0, 'startup timeout clears the total deadline after the verified cleanup path');
  });
}

export async function case79(): Promise<void> {


  await checkAsync('B-3aec first byte: stderr clears startup timer; productive runtime may exceed startup budget and still finish', async () => {
    const result = await defaultHostRunRunner({
      command: process.execPath,
      argv: ['-e', 'setTimeout(() => process.stderr.write("ready\\n"), 50); setTimeout(() => process.exit(0), 450)'],
      env: process.env,
      cwd: process.cwd(),
      startupTimeoutMs: 300,
      timeoutMs: 1000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.timeoutKind, null);
    assert.equal(result.terminalReason, 'completed');
    assert.ok((result.firstOutputMs ?? 1000) < 300);
    assert.ok((result.durationMs ?? 0) >= 400, 'run continues beyond startup budget after first output');
  });
}

export async function case80(): Promise<void> {


  await checkAsync('B-3aec total deadline: early stdout preserves first-output evidence but a later hang is total_timeout', async () => {
    const result = await defaultHostRunRunner({
      command: process.execPath,
      argv: ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'],
      env: process.env,
      cwd: process.cwd(),
      // Keep the real OS child while giving process launch/observer scheduling
      // enough headroom under a loaded aggregate. The independent deadlines
      // remain close enough to prove first-output clears only the startup timer.
      startupTimeoutMs: 1_000,
      timeoutMs: 1_200,
    });
    assert.equal(result.exitCode, 124);
    assert.equal(result.timeoutKind, 'total_timeout');
    assert.equal(result.terminalReason, 'total_timeout');
    assert.ok(result.firstOutputMs !== null);
  });
}

export async function case81(): Promise<void> {


  await checkAsync('B-3aec abort cleanup: caller abort waits for close and runHostRun releases cap=1 slot for immediate reacquisition', async () => {
    const sub = freshRoot();
    const env = { PROOF_OR_STOP_USAGE_LEDGER: '1', PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
    const controller = new AbortController();
    const runner: HostRunRunner = plan => defaultHostRunRunner({
      ...plan,
      command: process.execPath,
      argv: ['-e', 'setInterval(() => {}, 1000)'],
    });
    setTimeout(() => controller.abort(), 40);
    const result = await runHostRun({ ...baseArgs({ root: sub, host: 'codex', env }), signal: controller.signal, timeoutMs: 1000 }, { runner });
    assert.equal(result.terminalReason, 'aborted');
    assert.equal(result.exitCode, 130);
    assert.equal(result.timedOut, false);
    const dir = hostRunSlotsDir(sub);
    const reacquired = acquireHostRunSlot(dir, 1, 6 * 60 * 60 * 1000, Date.now(), slotMeta('after-abort'));
    assert.ok(reacquired, 'slot is released only after the aborted child closes');
    if (reacquired) releaseSlot(reacquired.file, reacquired.token);
  });
}

export async function case82(): Promise<void> {


  await checkAsync('B-3aec async spawn error: ENOENT is stable spawn_error/missing_executable exit 1 and settles once on close', async () => {
    const result = await defaultHostRunRunner({
      command: '/definitely/missing/b3aec-host',
      argv: [],
      env: process.env,
      cwd: process.cwd(),
      startupTimeoutMs: 100,
      timeoutMs: 500,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.terminalReason, 'spawn_error');
    assert.equal(result.failureKind, 'missing_executable');
    assert.equal(result.timedOut, false);
  });
}

export async function case83(): Promise<void> {


  await checkAsync('B-3aec post-readiness diagnostics: bounded stderr classifies auth and interactive terminal failures', async () => {
    for (const row of [
      { text: 'authentication required: please login', failureKind: 'auth' },
      { text: 'interactive terminal required; cannot prompt', failureKind: 'interactive' },
    ] as const) {
      const result = await defaultHostRunRunner({
        command: process.execPath,
        argv: ['-e', `process.stderr.write(${JSON.stringify(row.text)}); process.exit(1)`],
        env: process.env,
        cwd: process.cwd(),
        startupTimeoutMs: 300,
        timeoutMs: 1000,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.failureKind, row.failureKind);
      assert.equal(result.terminalReason, 'exit_nonzero');
      assert.ok(result.stderr.includes(row.text));
      assert.ok(Buffer.byteLength(result.stderr) <= HOST_RUN_FAILURE_TEXT_CAP);
    }
  });
}

export async function case84(): Promise<void> {


  await checkAsync('B-3aec dual-stream sticky diagnostics: stdout-only and early auth/interactive survive a later >64KiB tail', async () => {
    for (const row of [
      { text: 'authentication required: please login', failureKind: 'auth' },
      { text: 'interactive terminal required; cannot prompt', failureKind: 'interactive' },
    ] as const) {
      const stdoutOnly = await defaultHostRunRunner({
        command: process.execPath,
        argv: ['-e', `process.stdout.write(${JSON.stringify(row.text)}); process.exit(1)`],
        env: process.env,
        cwd: process.cwd(),
        startupTimeoutMs: 300,
        timeoutMs: 1000,
      });
      assert.equal(stdoutOnly.failureKind, row.failureKind, `${row.failureKind} is classified from stdout alone`);
      const tailed = await defaultHostRunRunner({
        command: process.execPath,
        argv: ['-e', `process.stdout.write(${JSON.stringify(`${row.text}\n`)}); process.stdout.write('x'.repeat(70 * 1024)); process.exit(1)`],
        env: process.env,
        cwd: process.cwd(),
        startupTimeoutMs: 300,
        timeoutMs: 1000,
      });
      assert.equal(tailed.failureKind, row.failureKind, `${row.failureKind} is sticky after a bounded tail evicts the diagnostic text`);
      assert.ok(Buffer.byteLength(tailed.stderr) <= HOST_RUN_FAILURE_TEXT_CAP);
    }
    const singleChunk = deterministicHostRuntime();
    const singleChunkPromise = defaultHostRunRunner({ command: 'fake-host', argv: [], env: process.env, cwd: process.cwd() }, singleChunk.runtime);
    singleChunk.child.stdout.emit('data', `authentication required: please login\n${'x'.repeat(70 * 1024)}`);
    singleChunk.child.emit('close', 1, null);
    assert.equal((await singleChunkPromise).failureKind, 'auth', 'a diagnostic at the start of one oversized delivered chunk is classified before only the bounded boundary tail is retained');

    const crossStream = deterministicHostRuntime();
    const crossStreamPromise = defaultHostRunRunner({ command: 'fake-host', argv: [], env: process.env, cwd: process.cwd() }, crossStream.runtime);
    crossStream.child.stdout.emit('data', 'auth');
    crossStream.child.stderr.emit('data', 'entication required');
    crossStream.child.emit('close', 1, null);
    assert.notEqual((await crossStreamPromise).failureKind, 'auth', 'stdout and stderr fragments are never concatenated into a fabricated authentication diagnostic');

    const sameStream = deterministicHostRuntime();
    const sameStreamPromise = defaultHostRunRunner({ command: 'fake-host', argv: [], env: process.env, cwd: process.cwd() }, sameStream.runtime);
    sameStream.child.stdout.emit('data', 'auth');
    sameStream.child.stdout.emit('data', 'entication required');
    sameStream.child.emit('close', 1, null);
    assert.equal((await sameStreamPromise).failureKind, 'auth', 'split diagnostic chunks remain recognizable within one stream');
  });
}

export async function case85(): Promise<void> {


  await checkAsync('B-3aec deterministic race schedules settle once, kill at most once, and clean timers/listeners', async () => {
    const basePlan = {
      command: 'fake-host', argv: [], env: process.env, cwd: process.cwd(),
      startupTimeoutMs: 10, timeoutMs: 20,
    };

    const outputFirst = deterministicHostRuntime();
    let outputSettles = 0;
    const outputPromise = defaultHostRunRunner(basePlan, outputFirst.runtime).then(result => { outputSettles += 1; return result; });
    outputFirst.child.stdout.emit('data', 'ready\n');
    assert.equal(outputFirst.activeTimers(), 1, 'first output cancels only the startup timer');
    outputFirst.child.emit('close', 0, null);
    const outputResult = await outputPromise;
    outputFirst.child.emit('close', 1, null);
    assert.equal(outputResult.terminalReason, 'completed');
    assert.equal(outputFirst.killCount(), 0);
    assert.equal(outputSettles, 1);
    assert.equal(outputFirst.activeTimers(), 0);
    assert.equal(outputFirst.listenerCount(), 0);

    // The close event starts asynchronous process-group cleanup. It must fence
    // the total deadline before that cleanup await, otherwise a queued deadline
    // can flip timedOut while the already-computed exitCode remains 0.
    const closeFirst = deterministicHostRuntime();
    let closeFenceGroupChecks = 0;
    const closeFirstPromise = defaultHostRunRunner({
      command: 'fake-host', argv: [], env: process.env, cwd: process.cwd(), timeoutMs: 20,
    }, {
      ...closeFirst.runtime,
      processGroupIsolated: true,
      readProcessStartFingerprint: () => 'close-fence-leader',
      isProcessGroupAlive: () => closeFenceGroupChecks++ === 0,
      signalProcessGroup: () => true,
    });
    closeFirst.child.emit('close', 0, null);
    assert.equal(closeFirst.activeTimers(), 0,
      'the authoritative close fences the still-queued total deadline before async group cleanup');
    const closeFirstResult = await closeFirstPromise;
    assert.equal(closeFirstResult.closeObserved, true);
    assert.equal(closeFirstResult.exitCode, 0);
    assert.equal(closeFirstResult.timedOut, false,
      'a deadline callback after the close fence cannot contradict the successful exit code');
    assert.equal(closeFirstResult.terminalReason, 'completed');

    const timeoutFirst = deterministicHostRuntime();
    let timeoutSettles = 0;
    const timeoutPromise = defaultHostRunRunner(basePlan, timeoutFirst.runtime).then(result => { timeoutSettles += 1; return result; });
    timeoutFirst.fire(20);
    timeoutFirst.child.emit('close', null, 'SIGKILL');
    const timeoutResult = await timeoutPromise;
    timeoutFirst.child.emit('close', 0, null);
    assert.equal(timeoutResult.timeoutKind, 'total_timeout');
    assert.equal(timeoutFirst.killCount(), 1);
    assert.equal(timeoutSettles, 1);
    assert.equal(timeoutFirst.activeTimers(), 0);
    assert.equal(timeoutFirst.listenerCount(), 0);

    const errorFirst = deterministicHostRuntime();
    let errorSettles = 0;
    const errorPromise = defaultHostRunRunner(basePlan, errorFirst.runtime).then(result => { errorSettles += 1; return result; });
    errorFirst.child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
    errorFirst.child.emit('close', null, null);
    const errorResult = await errorPromise;
    errorFirst.child.emit('close', 0, null);
    assert.equal(errorResult.terminalReason, 'spawn_error');
    assert.equal(errorResult.failureKind, 'missing_executable');
    assert.equal(errorFirst.killCount(), 0);
    assert.equal(errorSettles, 1);
    assert.equal(errorFirst.activeTimers(), 0);
    assert.equal(errorFirst.listenerCount(), 0);

    const abortFirst = deterministicHostRuntime();
    const trackedAbort = trackedAbortSignal();
    const abortPromise = defaultHostRunRunner({ ...basePlan, signal: trackedAbort.signal }, abortFirst.runtime);
    trackedAbort.abort();
    abortFirst.child.stdout.emit('data', 'late output\n');
    abortFirst.child.emit('close', null, 'SIGKILL');
    const abortResult = await abortPromise;
    assert.equal(abortResult.terminalReason, 'aborted');
    assert.equal(abortResult.exitCode, 130);
    assert.equal(abortFirst.killCount(), 1);
    assert.equal(abortFirst.activeTimers(), 0);
    assert.equal(abortFirst.listenerCount(), 0);
    assert.equal(trackedAbort.listenerCount(), 0, 'abort listener is removed at settlement');

    const releaseRoot = freshRoot();
    const releaseEnv = { PROOF_OR_STOP_USAGE_LEDGER: '1', PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
    const releaseRace = deterministicHostRuntime();
    const releaseController = new AbortController();
    const releasePromise = runHostRun({
      ...baseArgs({ root: releaseRoot, host: 'codex', env: releaseEnv }),
      signal: releaseController.signal,
      startupTimeoutMs: 10,
      timeoutMs: 20,
    }, { runner: plan => defaultHostRunRunner(plan, releaseRace.runtime) });
    releaseController.abort();
    releaseRace.child.emit('close', null, 'SIGKILL');
    await releasePromise;
    const releaseDir = hostRunSlotsDir(releaseRoot);
    const reacquired = acquireHostRunSlot(releaseDir, 1, 6 * 60 * 60 * 1000, Date.now(), slotMeta('deterministic-reacquire'));
    assert.ok(reacquired, 'abort close releases the slot for immediate deterministic reacquisition');
    releaseRace.child.emit('close', 0, null);
    assert.equal(reacquired && existsSync(reacquired.file), true, 'a duplicate close cannot release the new owner slot');
    if (reacquired) releaseSlot(reacquired.file, reacquired.token);
  });
}

export async function case86(): Promise<void> {


  await checkAsync('B-137a:F-160/F-232 process-group timeout/abort refuse stale leader fingerprints before signalling a reused PGID or direct child', async () => {
    const staleTimeout = deterministicHostRuntime();
    const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
    let fingerprintReads = 0;
    const runtime: HostRunRunnerRuntime = {
      ...staleTimeout.runtime,
      processGroupIsolated: true,
      readProcessStartFingerprint: () => (fingerprintReads++ === 0 ? 'leader-original' : 'leader-reused'),
      isProcessGroupAlive: () => true,
      signalProcessGroup: (pgid, signal) => { signals.push({ pgid, signal }); return true; },
    };
    const timeout = defaultHostRunRunner({
      command: 'fake-host', argv: [], env: process.env, cwd: process.cwd(), timeoutMs: 20,
    }, runtime);
    staleTimeout.fire(20);
    assert.deepEqual(signals, [], 'total timeout must not signal a PGID after its leader start fingerprint changed');
    assert.equal(staleTimeout.killCount(), 0,
      'total timeout must not fall back to child.kill when the isolated leader identity is ambiguous');
    staleTimeout.child.emit('close', null, 'SIGTERM');
    const timedOut = await timeout;
    assert.equal(timedOut.replacementSafe, false,
      'an identity-ambiguous isolated child remains replacement-unsafe for reconciliation');
    assert.equal(timedOut.processCleanup?.residualProcessGroup, true,
      'an identity-ambiguous isolated child records residual process risk instead of signalling');

    const staleAbort = deterministicHostRuntime();
    const abortSignals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
    let abortFingerprintReads = 0;
    const controller = new AbortController();
    const aborted = defaultHostRunRunner({
      command: 'fake-host', argv: [], env: process.env, cwd: process.cwd(), signal: controller.signal,
    }, {
      ...staleAbort.runtime,
      processGroupIsolated: true,
      readProcessStartFingerprint: () => (abortFingerprintReads++ === 0 ? 'leader-original' : 'leader-reused'),
      isProcessGroupAlive: () => true,
      signalProcessGroup: (pgid, signal) => { abortSignals.push({ pgid, signal }); return true; },
    });
    controller.abort();
    assert.deepEqual(abortSignals, [], 'abort must apply the same leader-fingerprint revalidation before PGID signalling');
    assert.equal(staleAbort.killCount(), 0,
      'abort must not fall back to child.kill when the isolated leader identity is ambiguous');
    staleAbort.child.emit('close', null, 'SIGTERM');
    const abortedResult = await aborted;
    assert.equal(abortedResult.replacementSafe, false,
      'abort keeps an identity-ambiguous isolated child replacement-unsafe');
    assert.equal(abortedResult.processCleanup?.residualProcessGroup, true,
      'abort records the unresolved process group without signalling it');
  });
}

export async function case87(): Promise<void> {


  await checkAsync('B-3aec timeout cleanup through runHostRun: startup and total timeout both release cap=1 for the next run', async () => {
    for (const scenario of [
      { script: 'setInterval(() => {}, 1000)', startupTimeoutMs: 40, timeoutMs: 500, expected: 'startup_no_output_timeout' },
      { script: 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)', startupTimeoutMs: 300, timeoutMs: 80, expected: 'total_timeout' },
    ] as const) {
      const sub = freshRoot();
      const env = { PROOF_OR_STOP_USAGE_LEDGER: '1', PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
      const runner: HostRunRunner = plan => defaultHostRunRunner({ ...plan, command: process.execPath, argv: ['-e', scenario.script] });
      const result = await runHostRun({ ...baseArgs({ root: sub, host: 'codex', env }), startupTimeoutMs: scenario.startupTimeoutMs, timeoutMs: scenario.timeoutMs }, { runner });
      assert.equal(result.timeoutKind, scenario.expected);
      const dir = hostRunSlotsDir(sub);
      const next = acquireHostRunSlot(dir, 1, 6 * 60 * 60 * 1000, Date.now(), slotMeta(`after-${scenario.expected}`));
      assert.ok(next, `${scenario.expected} close/reap released the slot exactly once`);
      if (next) releaseSlot(next.file, next.token);
    }
  });
}
