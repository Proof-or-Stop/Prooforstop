#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  acquireProviderProcessAdmission,
  releaseProviderProcessAdmission,
  transferProviderProcessAdmissionToProvider,
} from '../core/provider-process-admission.js';
import {
  acquireProviderProcessSlot,
  PROVIDER_EXECUTION_SURFACES,
  providerProcessSlotsDir,
  releaseProviderProcessSlot,
  releaseProviderProcessSlotBestEffort,
} from '../core/provider-process-registry.js';
import { acquireMkdirLock } from '../core/mkdir-lock.js';
import { runHostRun } from '../core/host-run.js';
import {
  PROVIDER_LAUNCH_OWNER_ADMISSION_CHILD_FLAG,
  runProviderLaunchOwnerAdmissionSuite,
} from './provider-launch-owner-admission-suite.js';
import { assertProviderExecutionInventoryContract } from './provider-execution-inventory-contract.js';

const root = mkdtempSync(join(tmpdir(), 'provider-process-registry-smoke-'));
const sourceRoot = join(resolve(fileURLToPath(new URL('../..', import.meta.url))), 'src');
const self = fileURLToPath(import.meta.url);

function source(relativePath: string): string {
  return readFileSync(join(sourceRoot, relativePath), 'utf8');
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  throw new Error(message);
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', code => resolvePromise(code));
  });
}

function childMain(mode: string, childRoot: string, resultPath: string, releasePath: string): void {
  if (mode === 'hold-registry-lock') {
    const dir = providerProcessSlotsDir(childRoot);
    const lock = acquireMkdirLock(`${dir}.lock`, {
      label: 'provider-process-registry-test-holder',
      deadlineMs: 1_000,
      staleMs: 40,
      pollMs: 5,
      requireHolderToken: true,
      holderInfo: {
        pid: process.pid,
        hostname: hostname(),
        command: 'provider-process-registry live holder',
        acquiredAt: new Date().toISOString(),
        processStartTimeMs: Math.floor(Date.now() - process.uptime() * 1_000),
      },
    });
    writeFileSync(resultPath, 'ready', { mode: 0o600 });
    const deadline = Date.now() + 3_000;
    while (!existsSync(releasePath) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    lock.release();
    return;
  }
  const admission = acquireProviderProcessAdmission({
    root: childRoot,
    env: { ...process.env, PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' },
    host: 'codex',
    storyId: 'B-child',
    agentType: mode,
  });
  if (mode === 'orphan-provider' && admission.admitted) {
    // This fixture deliberately proves the "worker died, provider group still
    // owns capacity" transition without ever sending a negative-PID signal.
    // A malformed PID of 1 would make a negative-PID signal a system-wide
    // broadcast on POSIX. Natural, marker-backed exit exercises the same slot
    // reclamation boundary and leaves a bounded fallback if an assertion fails.
    const provider = spawn(process.execPath, ['-e', [
      "const fs=require('node:fs')",
      `setTimeout(()=>{fs.writeFileSync(${JSON.stringify(releasePath)},'exited');process.exit(0)},1200)`,
    ].join(';')], {
      detached: true,
      stdio: 'ignore',
    });
    provider.unref();
    transferProviderProcessAdmissionToProvider(admission, {
      pid: provider.pid!,
      pgid: provider.pid!,
      spawnedAt: new Date().toISOString(),
      startFingerprint: 'orphan-provider-smoke-start',
      processGroupIsolated: true,
    });
    writeFileSync(resultPath, JSON.stringify({ admitted: true, providerPid: provider.pid }), { mode: 0o600 });
    return;
  }
  writeFileSync(resultPath, JSON.stringify({ admitted: admission.admitted }), { mode: 0o600 });
  if (mode === 'contend' && admission.admitted) {
    const deadline = Date.now() + 3_000;
    while (!existsSync(releasePath) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    releaseProviderProcessAdmission(admission);
  }
  // leak mode deliberately exits without release; parent must reclaim dead pid.
}

/**
 * B-137a F-119 regression: the `finally`-path release must be BEST-EFFORT while
 * the primitive stays OBSERVABLE.
 *
 * Production releases happen in bare `finally` blocks (autopilot-executor:413,
 * codex-review-leaf:650), and host-run.ts's original releaseSlot wrapped its
 * body in try/catch for exactly that reason -- a refactor dropped it. But
 * silently swallowing inside the primitive would destroy the opposite, equally
 * correct requirement pinned just below ("slot unlink mutation failure must be
 * observable instead of silently leaking capacity").
 *
 * The resolution keeps both: releaseProviderProcessSlot still throws, and
 * `finally` callers use releaseProviderProcessSlotBestEffort, which reports the
 * failure instead of hijacking control flow. This asserts the wrapper cannot
 * throw, reports the failure, still really frees a healthy slot, and -- the
 * bug's actual damage -- lets the caller's own exception survive.
 */
function assertReleaseProviderProcessSlotIsBestEffort(): void {
  const env = { ...process.env, PROOF_OR_STOP_USAGE_LEDGER: '0', PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' };
  const admission = acquireProviderProcessAdmission({
    root,
    env,
    host: 'codex',
    storyId: 'B-f119',
    agentType: 'release-best-effort',
  });
  assert.equal(admission.admitted, true, 'fixture requires an admitted slot');
  assert.ok(admission.slot, 'admitted admission must carry a slot');
  const slot = admission.slot!;

  const throwing = {
    unlink: () => {
      throw new Error('simulated unlink failure (EIO / concurrent reclaim)');
    },
  };

  // 1. The primitive still THROWS -- observability is not weakened.
  assert.throws(
    () => releaseProviderProcessSlot(slot.file, slot.token, {}, throwing),
    /simulated unlink failure/,
    'the primitive must keep surfacing release failures',
  );

  // 2. The finally-path wrapper never throws, and reports the failure.
  const reported: unknown[] = [];
  assert.doesNotThrow(
    () => releaseProviderProcessSlotBestEffort(
      slot.file,
      slot.token,
      (error) => reported.push(error),
      {},
      throwing,
    ),
    'the best-effort wrapper must never throw out of a finally block',
  );
  assert.equal(reported.length, 1, 'a failed best-effort release must be reported, not silent');

  // 3. A broken reporter must not resurrect the throw.
  assert.doesNotThrow(
    () => releaseProviderProcessSlotBestEffort(
      slot.file,
      slot.token,
      () => { throw new Error('broken reporter'); },
      {},
      throwing,
    ),
    'a throwing failure reporter must not escape the best-effort wrapper',
  );

  // 4. The bug's actual damage: the caller's real exception must survive a
  //    failing release in finally instead of being replaced by it.
  let surfaced: Error | null = null;
  try {
    try {
      throw new Error('real provider failure');
    } finally {
      releaseProviderProcessSlotBestEffort(slot.file, slot.token, () => {}, {}, throwing);
    }
  } catch (error) {
    surfaced = error instanceof Error ? error : new Error(String(error));
  }
  assert.equal(
    surfaced?.message,
    'real provider failure',
    'a failing release must not replace the in-flight provider exception',
  );

  // 5. The admission adapter is also used in production bare finally blocks;
  // it must route through the same best-effort path for both success and error.
  const admissionReleaseReports: unknown[] = [];
  let providerSucceeded = false;
  assert.doesNotThrow(() => {
    try {
      providerSucceeded = true;
    } finally {
      releaseProviderProcessAdmission(admission, {
        onFailure: error => admissionReleaseReports.push(error),
        mutationOps: throwing,
      });
    }
  }, 'a failed admission release must not replace provider success');
  assert.equal(providerSucceeded, true);
  assert.equal(admissionReleaseReports.length, 2,
    'the admission adapter reports a failed release instead of throwing from finally');

  let admissionSurfaced: Error | null = null;
  try {
    try {
      throw new Error('provider failure through admission adapter');
    } finally {
      releaseProviderProcessAdmission(admission, {
        onFailure: () => {},
        mutationOps: throwing,
      });
    }
  } catch (error) {
    admissionSurfaced = error instanceof Error ? error : new Error(String(error));
  }
  assert.equal(admissionSurfaced?.message, 'provider failure through admission adapter',
    'a failed admission release must not replace the in-flight provider exception');

  // 6. Best-effort must not degrade into a no-op: a healthy release still frees.
  releaseProviderProcessAdmission(admission);
  assert.equal(existsSync(slot.file), false, 'a successful best-effort release removes the slot file');
  assert.equal(existsSync(admission.machineSlot!.file), false, 'a successful admission release removes the machine sidecar too');
}

async function main(): Promise<void> {
  assertReleaseProviderProcessSlotIsBestEffort();
  const env = { ...process.env, PROOF_OR_STOP_USAGE_LEDGER: '0', PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' };
  const first = acquireProviderProcessAdmission({
    root,
    env,
    host: 'codex',
    storyId: 'B-cap',
    agentType: 'surface-a',
  });
  assert.equal(first.admitted, true);
  assert.equal(providerProcessSlotsDir(root).includes('/usage/'), false, 'provider admission registry must not live under usage-ledger storage');
  const second = acquireProviderProcessAdmission({
    root,
    env,
    host: 'claude',
    storyId: 'B-cap',
    agentType: 'surface-b',
  });
  assert.equal(second.admitted, false, 'ledger-off mode must still enforce shared cap before spawn');
  assert.equal(second.liveRuns.length, 1);
  releaseProviderProcessAdmission(first);
  const afterRelease = acquireProviderProcessAdmission({
    root,
    env,
    host: 'claude',
    storyId: 'B-cap',
    agentType: 'surface-b',
  });
  assert.equal(afterRelease.admitted, true);
  releaseProviderProcessAdmission(afterRelease);

  const loweringRoot = join(root, 'cap-lowering');
  const capTwo = { ...process.env, PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '2' };
  const lowerFirst = acquireProviderProcessAdmission({ root: loweringRoot, env: capTwo, host: 'codex', storyId: 'B-cap', agentType: 'lower-first' });
  const lowerSecond = acquireProviderProcessAdmission({ root: loweringRoot, env: capTwo, host: 'claude', storyId: 'B-cap', agentType: 'lower-second' });
  assert.equal(lowerFirst.admitted, true);
  assert.equal(lowerSecond.admitted, true);
  releaseProviderProcessAdmission(lowerFirst);
  const lowered = acquireProviderProcessAdmission({ root: loweringRoot, env: { ...process.env, PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' }, host: 'codex', storyId: 'B-cap', agentType: 'lowered' });
  assert.equal(lowered.admitted, false, 'a high-index live slot must count after cap lowering; no replacement may enter until total live count is below the new cap');
  releaseProviderProcessAdmission(lowerSecond);
  const afterHighIndexRelease = acquireProviderProcessAdmission({ root: loweringRoot, env: { ...process.env, PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' }, host: 'codex', storyId: 'B-cap', agentType: 'lowered-after-release' });
  assert.equal(afterHighIndexRelease.admitted, true, 'after the high-index holder releases, the lowered cap admits one replacement');
  assert.match(afterHighIndexRelease.slot?.file ?? '', /slot-0\.json$/,
    'the replacement is allocated inside the new lowered index range');
  releaseProviderProcessAdmission(afterHighIndexRelease);

  const contentionRoot = join(root, 'contention');
  const resultA = join(root, 'contender-a.json');
  const resultB = join(root, 'contender-b.json');
  const releasePath = join(root, 'release-contender');
  const childA = spawn(process.execPath, [self, '--child', 'contend', contentionRoot, resultA, releasePath], { stdio: 'ignore' });
  const childB = spawn(process.execPath, [self, '--child', 'contend', contentionRoot, resultB, releasePath], { stdio: 'ignore' });
  const exitA = waitForExit(childA);
  const exitB = waitForExit(childB);
  await waitFor(() => existsSync(resultA) && existsSync(resultB), 'concurrent admission children did not publish results');
  const contention = [resultA, resultB].map(path => JSON.parse(readFileSync(path, 'utf8')) as { admitted: boolean });
  assert.deepEqual(contention.map(row => row.admitted).sort(), [false, true], 'two simultaneous provider starts at cap=1 must yield exactly one admission');
  writeFileSync(releasePath, 'release');
  assert.equal(await exitA, 0);
  assert.equal(await exitB, 0);

  const leakedResult = join(root, 'leaked-result.json');
  const leaked = spawn(process.execPath, [self, '--child', 'leak', join(root, 'leaked'), leakedResult, join(root, 'unused')], { stdio: 'ignore' });
  const leakedExit = waitForExit(leaked);
  assert.equal(await leakedExit, 0);
  const reclaimed = acquireProviderProcessAdmission({ root: join(root, 'leaked'), env: { ...process.env, PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' }, host: 'claude', storyId: 'B-cap', agentType: 'after-crash' });
  assert.equal(reclaimed.admitted, true, 'a crashed holder pid must be reconciled and its slot reclaimed');
  releaseProviderProcessAdmission(reclaimed);

  const orphanRoot = join(root, 'orphan-provider');
  const orphanResult = join(root, 'orphan-provider.json');
  const orphanProviderExited = join(root, 'orphan-provider.exited');
  const orphanOwner = spawn(process.execPath, [self, '--child', 'orphan-provider', orphanRoot, orphanResult, orphanProviderExited], { stdio: 'ignore' });
  assert.equal(await waitForExit(orphanOwner), 0, 'supervising worker exits after transferring its slot to the provider group');
  const orphanProvider = JSON.parse(readFileSync(orphanResult, 'utf8')) as { providerPid: number };
  assert.ok(Number.isSafeInteger(orphanProvider.providerPid) && orphanProvider.providerPid > 1,
    'orphan fixture records a real provider PID and never permits a broadcast-shaped target');
  const whileProviderAlive = acquireProviderProcessAdmission({
    root: orphanRoot,
    env: { ...process.env, PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' },
    host: 'claude',
    storyId: 'B-cap',
    agentType: 'must-remain-blocked-by-orphan-provider',
  });
  assert.equal(whileProviderAlive.admitted, false,
    'worker death must not free capacity while its isolated provider process group is still alive');
  await waitFor(() => existsSync(orphanProviderExited),
    'orphan provider fixture did not publish its bounded natural exit');
  await waitFor(() => {
    const afterProviderExit = acquireProviderProcessAdmission({
      root: orphanRoot,
      env: { ...process.env, PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' },
      host: 'claude',
      storyId: 'B-cap',
      agentType: 'after-provider-exit',
    });
    if (!afterProviderExit.admitted) return false;
    releaseProviderProcessAdmission(afterProviderExit);
    return true;
  }, 'capacity is reclaimed only after the naturally exited provider process group is gone');

  const reusedGroupRoot = join(root, 'reused-provider-group');
  const reusedProviderReady = join(root, 'reused-provider.ready');
  const reusedProviderExited = join(root, 'reused-provider.exited');
  const reusedGroupAdmission = acquireProviderProcessAdmission({
    root: reusedGroupRoot,
    env: { ...process.env, PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' },
    host: 'codex',
    storyId: 'B-cap',
    agentType: 'recorded-provider-before-pgid-reuse',
  });
  assert.equal(reusedGroupAdmission.admitted, true);
  const recordedProvider = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify([
      "const fs=require('node:fs')",
      `setTimeout(()=>{fs.writeFileSync(${JSON.stringify(reusedProviderExited)},'exited');process.exit(0)},1200)`,
    ].join(';'))}], { stdio: 'ignore' });
    // Keep the isolated group leader alive until it has reaped its descendant.
    // The pre-exit admission check below still proves capacity stays blocked;
    // waitForExit(recordedProvider) then becomes a real PGID-liveness boundary,
    // rather than relying on the child's pre-exit marker.
    fs.writeFileSync(${JSON.stringify(reusedProviderReady)}, 'ready');
    child.once('exit', code => process.exit(code ?? 1));
  `], { detached: true, stdio: 'ignore' });
  transferProviderProcessAdmissionToProvider(reusedGroupAdmission, {
    pid: recordedProvider.pid!,
    pgid: recordedProvider.pid!,
    spawnedAt: new Date().toISOString(),
    startFingerprint: 'recorded-provider-fingerprint-before-reuse',
    processGroupIsolated: true,
  });
  assert.ok(Number.isSafeInteger(recordedProvider.pid) && recordedProvider.pid! > 1,
    'reused-PGID fixture records a real leader PID and never permits a broadcast-shaped target');
  await waitFor(() => existsSync(reusedProviderReady),
    'reused-PGID fixture leader did not publish its live-group boundary');
  const blockedByReusedLiveGroup = acquireProviderProcessAdmission({
    root: reusedGroupRoot,
    env: { ...process.env, PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' },
    host: 'claude',
    storyId: 'B-cap',
    agentType: 'must-not-reclaim-ambiguous-reused-pgid',
  });
  assert.equal(blockedByReusedLiveGroup.admitted, false,
    'a live isolated provider group is fail-closed capacity, never an oversubscribing reclaim');
  assert.equal(await waitForExit(recordedProvider), 0,
    'reused-PGID fixture leader must reap its child before the group is treated as gone');
  assert.equal(existsSync(reusedProviderExited), true,
    'reused-PGID fixture child must publish its bounded natural exit before leader reaping');
  await waitFor(() => {
    const afterNaturalGroupExit = acquireProviderProcessAdmission({
      root: reusedGroupRoot,
      env: { ...process.env, PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' },
      host: 'claude',
      storyId: 'B-cap',
      agentType: 'after-natural-reused-group-exit',
    });
    if (!afterNaturalGroupExit.admitted) return false;
    releaseProviderProcessAdmission(afterNaturalGroupExit);
    return true;
  }, 'capacity is reclaimed after the naturally exited reused provider group disappears');
  releaseProviderProcessAdmission(reusedGroupAdmission);

  const corruptRoot = join(root, 'corrupt-slot');
  const corruptDir = providerProcessSlotsDir(corruptRoot);
  mkdirSync(corruptDir, { recursive: true });
  const corruptSlot = join(corruptDir, 'slot-0.json');
  writeFileSync(corruptSlot, '{corrupt');
  const old = new Date(Date.now() - 7 * 60 * 60 * 1_000);
  utimesSync(corruptSlot, old, old);
  const afterCorrupt = acquireProviderProcessAdmission({ root: corruptRoot, env: { ...process.env, PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' }, host: 'codex', storyId: 'B-cap', agentType: 'after-corrupt' });
  assert.equal(afterCorrupt.admitted, true, 'an expired corrupt slot is reclaimed under the serialized registry mutation boundary');
  releaseProviderProcessAdmission(afterCorrupt);

  const concurrentCorruptRoot = join(root, 'concurrent-corrupt-slot');
  const concurrentCorruptDir = providerProcessSlotsDir(concurrentCorruptRoot);
  mkdirSync(concurrentCorruptDir, { recursive: true });
  const concurrentCorruptSlot = join(concurrentCorruptDir, 'slot-0.json');
  writeFileSync(concurrentCorruptSlot, '{corrupt');
  utimesSync(concurrentCorruptSlot, old, old);
  const corruptResultA = join(root, 'corrupt-contender-a.json');
  const corruptResultB = join(root, 'corrupt-contender-b.json');
  const corruptReleasePath = join(root, 'release-corrupt-contender');
  const corruptChildA = spawn(process.execPath, [self, '--child', 'contend', concurrentCorruptRoot, corruptResultA, corruptReleasePath], { stdio: 'ignore' });
  const corruptChildB = spawn(process.execPath, [self, '--child', 'contend', concurrentCorruptRoot, corruptResultB, corruptReleasePath], { stdio: 'ignore' });
  const corruptExitA = waitForExit(corruptChildA);
  const corruptExitB = waitForExit(corruptChildB);
  await waitFor(() => existsSync(corruptResultA) && existsSync(corruptResultB), 'concurrent corrupt-slot reclaimers did not publish results');
  const corruptContention = [corruptResultA, corruptResultB]
    .map(path => JSON.parse(readFileSync(path, 'utf8')) as { admitted: boolean });
  assert.deepEqual(corruptContention.map(row => row.admitted).sort(), [false, true],
    'serialized corrupt replacement must admit exactly one provider under concurrent reclaim');
  writeFileSync(corruptReleasePath, 'release');
  assert.equal(await corruptExitA, 0);
  assert.equal(await corruptExitB, 0);

  const unstatableRoot = join(root, 'unstatable-slot');
  const unstatableDir = providerProcessSlotsDir(unstatableRoot);
  mkdirSync(unstatableDir, { recursive: true });
  symlinkSync('slot-0.json', join(unstatableDir, 'slot-0.json'));
  const afterUnstatable = acquireProviderProcessAdmission({
    root: unstatableRoot,
    env: { ...process.env, PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' },
    host: 'codex',
    storyId: 'B-cap',
    agentType: 'must-not-admit-unstatable-slot',
  });
  assert.equal(afterUnstatable.admitted, false,
    'an unstatable corrupt slot must occupy capacity instead of being treated as reclaimable');
  assert.equal(afterUnstatable.slot, null);

  const unreadableDirRoot = join(root, 'unreadable-slots-dir');
  const unreadableDir = providerProcessSlotsDir(unreadableDirRoot);
  mkdirSync(unreadableDir, { recursive: true });
  const deadHolder = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const deadPid = deadHolder.pid!;
  assert.equal(await waitForExit(deadHolder), 0);
  writeFileSync(join(unreadableDir, 'slot-0.json'), JSON.stringify({
    pid: deadPid,
    startedAt: new Date().toISOString(),
    host: 'codex',
    storyId: 'B-cap',
    agentType: 'dead-low-index',
    token: 'dead-low-index-token',
  }));
  writeFileSync(join(unreadableDir, 'slot-1.json'), JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    host: 'claude',
    storyId: 'B-cap',
    agentType: 'live-high-index',
    token: 'live-high-index-token',
  }));
  chmodSync(unreadableDir, 0o111);
  try {
    assert.throws(
      () => readdirSync(unreadableDir),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EACCES',
      'fixture requires execute-only slots dir so readdir fails while named paths still resolve',
    );
    assert.throws(
      () => acquireProviderProcessAdmission({
        root: unreadableDirRoot,
        env: { ...process.env, PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' },
        host: 'codex',
        storyId: 'B-cap',
        agentType: 'must-not-admit-unreadable-slots-dir',
      }),
      /provider-process-registry slots directory unreadable/,
      'an unreadable slots directory must fail closed instead of looking empty and admitting over the cap',
    );
  } finally {
    chmodSync(unreadableDir, 0o700);
  }

  const staleReleaseRoot = join(root, 'stale-release-token');
  const staleReleaseSlot = acquireProviderProcessSlot(providerProcessSlotsDir(staleReleaseRoot), 1, 1_000, Date.now(), {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    host: 'codex',
    storyId: 'B-stale-release',
    agentType: 'old-holder',
  });
  assert.ok(staleReleaseSlot);
  const replacementToken = 'replacement-owner-token';
  writeFileSync(staleReleaseSlot.file, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    host: 'claude',
    storyId: 'B-stale-release',
    agentType: 'replacement-holder',
    token: replacementToken,
  }));
  releaseProviderProcessSlot(staleReleaseSlot.file, staleReleaseSlot.token);
  assert.equal((JSON.parse(readFileSync(staleReleaseSlot.file, 'utf8')) as { token: string }).token, replacementToken,
    'a stale releaser must not delete a slot whose ownership token has changed');
  releaseProviderProcessSlot(staleReleaseSlot.file, replacementToken);

  const releaseMutationRoot = join(root, 'release-mutation-failure');
  const releaseMutationSlot = acquireProviderProcessSlot(
    providerProcessSlotsDir(releaseMutationRoot),
    1,
    1_000,
    Date.now(),
    {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      host: 'codex',
      storyId: 'B-release-mutation',
      agentType: 'release-owner',
    },
  );
  assert.ok(releaseMutationSlot);
  assert.throws(
    () => releaseProviderProcessSlot(
      releaseMutationSlot.file,
      releaseMutationSlot.token,
      {},
      { unlink: () => { throw new Error('injected provider slot unlink failure'); } },
    ),
    /injected provider slot unlink failure/,
    'slot unlink mutation failure must be observable instead of silently leaking capacity',
  );
  assert.equal(existsSync(releaseMutationSlot.file), true, 'failed release leaves the exact owned slot diagnosable');
  releaseProviderProcessSlot(releaseMutationSlot.file, releaseMutationSlot.token);

  const releaseLockRoot = join(root, 'release-lock-failure');
  const releaseLockDir = providerProcessSlotsDir(releaseLockRoot);
  const releaseLockSlot = acquireProviderProcessSlot(releaseLockDir, 1, 1_000, Date.now(), {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    host: 'codex',
    storyId: 'B-release-lock',
    agentType: 'release-lock-owner',
  });
  assert.ok(releaseLockSlot);
  const heldReleaseLock = acquireMkdirLock(`${releaseLockDir}.lock`, {
    label: 'provider release failure fixture',
    requireHolderToken: true,
    holderInfo: {
      pid: process.pid,
      hostname: hostname(),
      command: 'provider release failure fixture',
      acquiredAt: new Date().toISOString(),
      lockId: 'provider-release-held-lock',
      processStartTimeMs: Math.floor(Date.now() - process.uptime() * 1_000),
    },
  });
  try {
    assert.throws(
      () => releaseProviderProcessSlot(
        releaseLockSlot.file,
        releaseLockSlot.token,
        { deadlineMs: 30, staleMs: 10_000, pollMs: 5 },
      ),
      /provider-process-registry lock timeout/,
      'registry-lock mutation failure must reach the supervising owner',
    );
  } finally {
    heldReleaseLock.release();
  }
  releaseProviderProcessSlot(releaseLockSlot.file, releaseLockSlot.token);

  const liveLockRoot = join(root, 'live-registry-lock');
  const liveLockReady = join(root, 'live-registry-lock.ready');
  const liveLockRelease = join(root, 'live-registry-lock.release');
  const liveLockChild = spawn(process.execPath, [self, '--child', 'hold-registry-lock', liveLockRoot, liveLockReady, liveLockRelease], {
    env: process.env,
    stdio: 'ignore',
  });
  const liveLockExit = waitForExit(liveLockChild);
  await waitFor(() => existsSync(liveLockReady), 'live registry lock holder did not become ready');
  const liveLockDir = `${providerProcessSlotsDir(liveLockRoot)}.lock`;
  const oldLiveLockTime = new Date(Date.now() - 200);
  utimesSync(liveLockDir, oldLiveLockTime, oldLiveLockTime);
  let liveLockContender: ReturnType<typeof acquireProviderProcessSlot> | null = null;
  let liveLockError: unknown;
  try {
    const acquireWithTiming = acquireProviderProcessSlot as typeof acquireProviderProcessSlot & ((
      dir: string,
      cap: number,
      staleMs: number,
      now: number,
      meta: Parameters<typeof acquireProviderProcessSlot>[4],
      lockTiming: { deadlineMs: number; staleMs: number; pollMs: number },
    ) => ReturnType<typeof acquireProviderProcessSlot>);
    liveLockContender = acquireWithTiming(providerProcessSlotsDir(liveLockRoot), 1, 1_000, Date.now(), {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      host: 'codex',
      storyId: 'B-live-lock',
      agentType: 'contender',
    }, { deadlineMs: 120, staleMs: 40, pollMs: 5 });
  } catch (error) {
    liveLockError = error;
  }
  if (liveLockContender) releaseProviderProcessSlot(liveLockContender.file, liveLockContender.token);
  writeFileSync(liveLockRelease, 'release');
  assert.equal(await liveLockExit, 0, 'live registry lock holder exits cleanly');
  assert.match(String(liveLockError), /provider-process-registry lock timeout/, 'a live holder remains authoritative after staleMs instead of being stolen');

  const inventory = new Map(PROVIDER_EXECUTION_SURFACES.map(entry => [entry.path, entry]));
  assertProviderExecutionInventoryContract(sourceRoot);

  const hostRunRoot = join(root, 'surface-admission', 'host-run');
  const hostRunHolder = acquireProviderProcessAdmission({
    root: hostRunRoot,
    env,
    host: 'codex',
    storyId: 'B-surface-admission',
    agentType: 'holder:core/host-run.ts',
  });
  assert.equal(hostRunHolder.admitted, true);
  let hostRunRunnerCalls = 0;
  const blockedHostRun = await runHostRun({
    host: 'codex',
    storyId: 'B-surface-admission',
    agentType: 'surface:core/host-run.ts',
    phase: 'REVIEW',
    promptText: 'pre-spawn admission contract',
    cwd: hostRunRoot,
    root: hostRunRoot,
    recordedAt: new Date().toISOString(),
    projectRootHash: 'sha256:surface-admission',
    env,
  }, {
    runner: async () => {
      hostRunRunnerCalls += 1;
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, terminalReason: 'completed' };
    },
  });
  assert.equal(blockedHostRun.refusalReason, 'concurrency_cap_exceeded');
  assert.equal(hostRunRunnerCalls, 0, 'host-run admission must run before its injected provider runner');
  releaseProviderProcessAdmission(hostRunHolder);

  for (const path of [
    'core/managed-host-run.ts',
    'core/host-run.ts',
    'core/codex-review-leaf.ts',
    'core/autopilot-executor.ts',
    'core/proof-or-stop-dispatch.ts',
    'core/planned-steps-executor.ts',
  ]) {
    assert.ok(inventory.get(path)?.admissionOwner, `${path} must remain a classified production launch owner`);
  }

  assert.match(source('core/managed-host-run.ts'), /runHostRun\s*\(/);
  assert.match(source('core/host-run.ts'), /provider-process-admission\.js/);
  assert.doesNotMatch(source('core/host-run.ts'), /function\s+(?:acquireHostRunSlot|scanLiveSlots|releaseSlot|readSlotOccupant)\b/, 'host-run compatibility surface must delegate instead of retaining a second slot registry');
  assert.doesNotMatch(source('core/provider-process-registry.ts'), /from ['"]\.\/host-run\.js['"]/, 'provider registry must own admission instead of re-exporting host-run internals');
  assert.match(
    source('core/provider-process-registry.ts'),
    /provider-process-registry slots directory unreadable/,
    'slots-dir readdir failures must fail closed instead of looking like an empty registry',
  );
  assert.match(source('core/autopilot-executor.ts'), /provider-process-registry\.js/);
  assert.match(source('core/codex-review-leaf.ts'), /provider-process-registry\.js/);
  assert.equal(
    inventory.get('handlers/candidate-spec-routing.ts')?.status,
    'admission_only',
    'candidate-spec routing calls runHostRun directly and must not claim ManagedHostRun ownership',
  );
  assert.equal(
    inventory.get('handlers/candidate-spec-routing.ts')?.admissionOwner,
    'core/provider-process-registry.ts',
    'candidate-spec routing admission is owned by the canonical provider-process registry',
  );
  for (const owner of ['core/autopilot-executor.ts', 'core/codex-review-leaf.ts']) {
    assert.doesNotMatch(
      source(owner),
      /\b(?:acquireHostRunSlot|hostRunSlotsDir|releaseSlot|AcquiredHostRunSlot)\b|host-run slot/i,
      `${owner} must use canonical provider-process admission terminology outside the host-run compatibility boundary`,
    );
  }
  for (const path of [
    'core/codex-review-leaf.ts',
    'core/usage-ledger/writer.ts',
    'tasks/host-run-usage-smoke.ts',
  ]) {
    assert.doesNotMatch(
      source(path),
      /ledger OFF byte-identical|restores the byte-identical legacy|Absent => no rows\s*\* \(byte-identical/i,
      `${path} must not claim that disabling usage accounting disables mandatory provider admission/registry I/O`,
    );
  }
  assert.match(source('core/proof-or-stop-dispatch.ts'), /provider-process-admission\.js/);
  assert.match(source('core/planned-steps-executor.ts'), /provider-process-admission\.js/);
  for (const adapter of ['providers/codex-cli.ts', 'providers/claude-cli.ts', 'providers/gemini-cli.ts']) {
    assert.equal(inventory.get(adapter)?.status, 'adapter_only');
    assert.match(source(adapter), /spawn(?:Sync)?\s*\(/, `${adapter} remains a low-level bounded adapter whose caller owns admission`);
  }

  if (!process.argv.includes(PROVIDER_LAUNCH_OWNER_ADMISSION_CHILD_FLAG)) {
    runProviderLaunchOwnerAdmissionSuite({ skipProcessRegistrySelf: true });
  }
  // Immutable verification receipts pin this selector. Emit it only after the
  // direct command has executed every production launch-owner admission proof.
  console.log(process.argv.includes(PROVIDER_LAUNCH_OWNER_ADMISSION_CHILD_FLAG)
    ? 'provider-process-registry-core PASS' : 'provider-process-registry-smoke PASS');
}

if (process.argv[2] === '--child') {
  try {
    childMain(process.argv[3] ?? '', process.argv[4] ?? '', process.argv[5] ?? '', process.argv[6] ?? '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} else {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
