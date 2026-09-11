#!/usr/bin/env node

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';

import {
  cancelManagedHostRun,
  reapManagedHostRunProviderProcess,
  reapUnidentifiedManagedHostRunWorker,
  runManagedHostRunWorker,
  submitManagedHostRun,
} from '../core/managed-host-run.js';
import { defaultHostRunRunner, type HostRunRunner } from '../core/host-run.js';

function injectedChild(pid: number): ReturnType<typeof spawn> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return Object.assign(new EventEmitter(), {
    pid,
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr],
    kill: () => true,
  }) as unknown as ReturnType<typeof spawn>;
}

async function main(): Promise<void> {
  for (const identity of [
    { pid: 1, pgid: 1 },
    { pid: 424242, pgid: 1 },
    { pid: 424242, pgid: 424241 },
  ]) {
    const signals: Array<{ pgid: number; signal: 'SIGTERM' | 'SIGKILL' }> = [];
    const cleanup = await reapManagedHostRunProviderProcess({
      ...identity,
      spawnedAt: new Date().toISOString(),
      startFingerprint: 'forged-provider-start',
      processGroupIsolated: true,
    }, {
      rows: pgid => [{ pid: pgid, pgid, sessionId: pgid, start: 'untrusted-group' }],
      signal: (pgid, signal) => { signals.push({ pgid, signal }); },
      wait: async () => {},
    });
    assert.deepEqual(signals, [], `unsafe process identity ${identity.pid}/${identity.pgid} must never be signalled`);
    assert.deepEqual(cleanup, { termSent: false, killSent: false, reaped: false, residualProcessGroup: true });
  }

  // SID unavailable is not a wildcard: absent query data, wrong session,
  // reused leader, changed group and absent leader all remain no-signal cases.
  for (const row of [
    null,
    { pid: 62001, pgid: 62001, sessionId: 999, start: 'original-start' },
    { pid: 62001, pgid: 62001, sessionId: 62001, start: 'reused-start' },
    { pid: 62001, pgid: 62002, sessionId: 62001, start: 'original-start' },
    { pid: 62002, pgid: 62001, sessionId: 62001, start: 'original-start' },
    { pid: 62001, pgid: 62001, sessionId: null, start: 'original-start' },
  ]) {
    const signals: string[] = [];
    const cleanup = await reapManagedHostRunProviderProcess({
      pid: 62001, pgid: 62001, spawnedAt: new Date().toISOString(),
      startFingerprint: 'original-start', processGroupIsolated: true,
    }, { rows: () => row ? [row] : null, signal: (_pgid, signal) => { signals.push(signal); }, wait: async () => {} });
    assert.deepEqual(signals, [], 'unproven or mismatched process identity must not authorize signals');
    assert.equal(cleanup.reaped, false);
  }

  const leaderlessSignals: Array<'SIGTERM' | 'SIGKILL'> = [];
  const leaderlessCleanup = await reapManagedHostRunProviderProcess({
    pid: 62001,
    pgid: 62001,
    spawnedAt: new Date().toISOString(),
    startFingerprint: 'original-leader-start',
    processGroupIsolated: true,
  }, {
    rows: () => [{ pid: 62002, pgid: 62001, sessionId: 62001, start: 'descendant-start' }],
    signal: (_pgid, signal) => { leaderlessSignals.push(signal); },
    wait: async () => {},
  });
  assert.deepEqual(leaderlessSignals, [], 'a leaderless detached group has no continuously verified original member to authorize a PGID signal');
  assert.deepEqual(leaderlessCleanup, { termSent: false, killSent: false, reaped: false, residualProcessGroup: true });

  const hostChild = injectedChild(64001);
  const hostSignals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
  let closeObserverRan = false;
  let hostRunnerSettled = false;
  const hostResult = defaultHostRunRunner({
    command: 'injected-host', argv: [], env: process.env, cwd: process.cwd(),
  }, {
    spawnChild: () => hostChild,
    processGroupIsolated: true,
    readProcessStartFingerprint: () => null,
    isProcessGroupAlive: () => true,
    signalProcessGroup: (pgid, signal) => { hostSignals.push({ pgid, signal }); return true; },
    onChildCloseObserved: () => {
      // This models a managed close observer durably recording a cancellation
      // request. The leaderless close fence must leave it a scheduling turn
      // before the runner result can drive terminal sealing.
      closeObserverRan = true;
    },
  });
  void hostResult.then(() => { hostRunnerSettled = true; });
  hostChild.emit('close', 0, null);
  await Promise.resolve();
  assert.equal(closeObserverRan, true, 'the authoritative child-close observer must run');
  assert.equal(hostRunnerSettled, false,
    'leaderless close retains one no-signal event-loop fence so observer persistence precedes terminal settlement');
  const hostCleanup = await hostResult;
  assert.deepEqual(hostSignals, [], 'host-run close cleanup never group-signals a leaderless or unverified PGID');
  assert.equal(hostCleanup.residualProcessGroup, true, 'host-run reports the live unverified group as residual unknown');
  assert.equal(hostCleanup.replacementSafe, false, 'host-run never marks leaderless group cleanup replacement-safe');
  assert.deepEqual(hostCleanup.processCleanup, {
    termSent: false,
    killSent: false,
    reaped: false,
    residualProcessGroup: true,
  }, 'host-run terminal cleanup records the absence of an authorized group signal');

  // This is the managed ordering regression behind the close fence above. The
  // injected child has an unobservable leader and a live detached group, so it
  // is strictly a no-signal fixture. Its close observer persists the exact
  // deadline request and verifies that the worker has not sealed first.
  const closeFenceRoot = mkdtempSync(join(tmpdir(), 'managed-host-run-close-fence-'));
  try {
    let closeFenceRunId: string | null = null;
    let closeFenceWorker: Promise<unknown> | null = null;
    let closeFenceCancel: Promise<unknown> | null = null;
    const closeFenceSignals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
    const closeFenceRunner: HostRunRunner = plan => {
      const child = injectedChild(65001);
      queueMicrotask(() => child.emit('close', 0, null));
      return defaultHostRunRunner(plan, {
        spawnChild: () => child,
        processGroupIsolated: true,
        readProcessStartFingerprint: () => null,
        isProcessGroupAlive: () => true,
        signalProcessGroup: (pgid, signal) => { closeFenceSignals.push({ pgid, signal }); return true; },
        onChildCloseObserved: () => {
          assert.ok(closeFenceRunId, 'the worker run id must be known before its child can close');
          closeFenceCancel = cancelManagedHostRun({
            root: closeFenceRoot,
            runId: closeFenceRunId,
            reason: 'absolute_deadline_exceeded',
          }).then(projection => {
            assert.equal(projection.terminal, null,
              'the close-observed deadline request is durably recorded before any terminal seal');
          });
        },
      });
    };
    const closeFence = await submitManagedHostRun({
      root: closeFenceRoot,
      cwd: closeFenceRoot,
      host: 'codex',
      storyId: 'B-pgid-safety',
      phase: 'REVIEW',
      agentType: 'lattice-review-quality',
      promptText: 'injected close-fence safety fixture',
      deadlineMs: 5_000,
      projectRootHash: 'sha256:pgid-safety',
    }, {
      launchWorker: async request => {
        closeFenceRunId = request.runId;
        closeFenceWorker = runManagedHostRunWorker(request, {
          runner: closeFenceRunner,
          env: { PROOF_OR_STOP_USAGE_LEDGER: '0' },
          cancelPollMs: 5,
        });
        return { pid: process.pid };
      },
      claimTimeoutMs: 500,
      claimPollMs: 5,
    });
    assert.ok(closeFenceCancel, 'the injected child-close callback must request cancellation');
    assert.ok(closeFenceWorker, 'the injected worker must remain observable through terminal settlement');
    await closeFenceCancel;
    const closeFenceTerminal = await closeFenceWorker;
    assert.equal((closeFenceTerminal as { state?: string }).state, 'completed',
      'a provider close observed before the deadline request remains the completed terminal fact');
    assert.deepEqual(closeFenceSignals, [],
      'the close fence must not restore an unsafe leaderless group signal');
    const closeFenceProjection = await cancelManagedHostRun({
      root: closeFenceRoot,
      runId: closeFence.runId,
      reason: 'absolute_deadline_exceeded',
    });
    assert.equal(closeFenceProjection.terminal?.state, 'completed');
    assert.equal(closeFenceProjection.terminal?.replacementSafe, false,
      'a leaderless residual remains replacement-unsafe even when the provider close wins');
    assert.equal(closeFenceProjection.terminal?.processCleanup?.residualProcessGroup, true);
  } finally {
    rmSync(closeFenceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }

  const directSignals: Array<'SIGTERM' | 'SIGKILL'> = [];
  let directExitCode: number | null = null;
  let directSignalCode: NodeJS.Signals | null = null;
  const directCleanup = await reapUnidentifiedManagedHostRunWorker({
    pid: 73001,
    get exitCode() { return directExitCode; },
    get signalCode() { return directSignalCode; },
    kill: signal => {
      directSignals.push(signal as 'SIGTERM' | 'SIGKILL');
      directSignalCode = signal as NodeJS.Signals;
      return true;
    },
    once: (_event, listener) => { listener(); },
  }, async () => {});
  assert.deepEqual(directSignals, ['SIGKILL'],
    'an unidentified launcher child is killed only through its direct-child handle, never a PGID');
  assert.deepEqual(directCleanup, { directKillSent: true, reaped: true });

  const failedDirectCleanup = await reapUnidentifiedManagedHostRunWorker({
    pid: 73002,
    exitCode: null,
    signalCode: null,
    kill: () => { throw new Error('child already unavailable'); },
    once: () => {},
  }, async () => {});
  assert.deepEqual(failedDirectCleanup, { directKillSent: false, reaped: false },
    'an unavailable direct child remains replacement-unsafe and has no group-signal fallback');

  console.log('managed-host-run-pgid-safety-smoke PASS');
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
