import { assertStory3VerifierPositiveControl } from './process-mutation-proof.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { existsSync, readFileSync } from 'node:fs';

import { join } from 'node:path';

import { FINDING_LEDGER_SCHEMA_EPOCH, LedgerRefusal, appendLedgerTransaction, readLedger, type AppendRequest, type JsonValue } from '../../core/finding-ledger.js';

import { canonicalJson } from '../../handlers/finding-ledger.js';

import {
  acquireMkdirLock,
  captureMkdirLockFence,
} from '../../core/mkdir-lock.js';
import { acquireMainWriteLock } from '../../core/main-write-lock.js';
import { StoryStore } from '../../core/store.js';

import { getProcessFactRegistryEntry } from '../../core/process-fact-registry.js';

import { request, WorkerSpec, runWorkers, runtimeStory, git } from './support.js';
import { story3VerifierMutationAccepted } from './authority.js';

export function runRollbackKillSwitchMatrix(scratch: string): void {
  const ledgerFile = join(scratch, 'rollback', 'finding-ledger.json');
  const lockDir = join(scratch, 'locks', 'rollback.lock');
  const lock = acquireMkdirLock(lockDir, { label: 'rollback kill-switch', requireHolderToken: true });
  try {
    const fence = captureMkdirLockFence(lockDir);
    appendLedgerTransaction(
      ledgerFile,
      request(fence.writerFenceToken, 'rollback:seed', 'finding', { id: 'history-before-kill-switch' }),
      fence,
    );
    const committedBefore = readFileSync(ledgerFile, 'utf8');
    const unsupported = request(fence.writerFenceToken, 'rollback:unsupported', 'finding', { id: 'must-not-commit' });
    assert.throws(() => appendLedgerTransaction(
      ledgerFile,
      { ...unsupported, ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH + 1 },
      fence,
    ), /SCHEMA_EPOCH_UNSUPPORTED|schema epoch/i);
    assert.equal(readFileSync(ledgerFile, 'utf8'), committedBefore, 'kill-switch refusal changed committed history');
    const restored = appendLedgerTransaction(
      ledgerFile,
      request(fence.writerFenceToken, 'rollback:restored', 'finding', { id: 'supported-after-rollback' }),
      fence,
    );
    assert.equal(restored.action, 'append');
  } finally {
    lock.release();
  }
  const recovered = readLedger(ledgerFile);
  assert.deepEqual(recovered.records.map((record) => (record.payload as Record<string, JsonValue>).id), [
    'history-before-kill-switch', 'supported-after-rollback',
  ]);
  console.log('green.rollback_kill_switch: PASS dataLoss=0');
}

export async function runCombinedConcurrencyMatrix(scratch: string): Promise<void> {
  const ledgerFile = join(scratch, 'combined', 'finding-ledger.json');
  const lockDir = join(scratch, 'locks', 'combined.lock');
  const specs: WorkerSpec[] = ['finding', 'candidate_route', 'assessment', 'manifest'].map((recordType, index) => ({
    ledgerFile,
    lockDir,
    prefix: `combined-${index}`,
    count: 5,
    recordType,
    payloadBase: { matrix: 'combined', ref: 'root' },
  }));
  const workers = runWorkers(specs);

  // These independent writes run while the external ledger workers contend,
  // covering the repository's separate process-event and B-META lock trees.
  const activityStore = new StoryStore(join(scratch, 'combined-activity'));
  activityStore.writeStory('B-COMBINED', runtimeStory('B-COMBINED'));
  for (let index = 0; index < 8; index += 1) {
    activityStore.appendProcessEvent('B-COMBINED', {
      type: 'verification', storyId: 'B-COMBINED', command: `combined-${index}`, role: 'main', result: 'pass',
    });
  }
  const metaLock = acquireMainWriteLock(join(scratch, 'combined-activity'), {
    label: 'combined B-META append', onContention: 'wait',
  });
  try {
    const fence = captureMkdirLockFence(metaLock.lockDir);
    appendLedgerTransaction(
      activityStore.storyFilePath('B-META-combined', 'finding-ledger.json'),
      request(fence.writerFenceToken, 'combined:meta', 'finding', { id: 'B-META-combined:F-001' }),
      fence,
    );
  } finally {
    metaLock.release();
  }

  const crashLock = acquireMkdirLock(lockDir, {
    label: 'combined crash injection', requireHolderToken: true, deadlineMs: 60_000,
  });
  try {
    const fence = captureMkdirLockFence(lockDir);
    assert.throws(() => appendLedgerTransaction(
      ledgerFile,
      request(fence.writerFenceToken, 'combined:crash', 'manifest', { id: 'half-visible' }),
      fence,
      { beforeRename: () => { throw new Error('combined crash injection'); } },
    ), /combined crash injection/);
  } finally {
    crashLock.release();
  }
  await workers;

  const beforeReplay = readLedger(ledgerFile);
  assert.equal(beforeReplay.records.length, 20);
  assert.equal(beforeReplay.receipts.length, 20);
  assert.equal(new Set(beforeReplay.records.map((record) => record.recordId)).size, 20);
  assert.equal(beforeReplay.records.some((record) => canonicalJson(record.payload).includes('half-visible')), false);
  const replayLock = acquireMkdirLock(lockDir, { label: 'combined replay', requireHolderToken: true });
  try {
    const fence = captureMkdirLockFence(lockDir);
    for (const record of beforeReplay.records) {
      const replay = appendLedgerTransaction(
        ledgerFile,
        request(fence.writerFenceToken, record.idempotencyKey, record.recordType, record.payload),
        fence,
      );
      assert.equal(replay.action, 'replay');
    }
  } finally {
    replayLock.release();
  }
  const afterReplay = readLedger(ledgerFile);
  assert.equal(afterReplay.records.length, 20);
  assert.equal(afterReplay.receipts.length, 20);
  assert.equal(activityStore.readProcessEvents('B-COMBINED').length, 8);
  assert.equal(activityStore.readFindingLedger('B-META-combined').records.length, 1);
  console.log('green.combined_concurrency: PASS lost=0 duplicates=0 halfVisible=0 deadlocks=0');
}

export function runFailClosedBoundaryMatrix(scratch: string): void {
  const ledgerFile = join(scratch, 'fail-closed', 'finding-ledger.json');
  const lockDir = join(scratch, 'locks', 'fail-closed.lock');
  const lock = acquireMkdirLock(lockDir, { label: 'fail-closed boundary', requireHolderToken: true });
  try {
    const fence = captureMkdirLockFence(lockDir);
    const base = request(fence.writerFenceToken, 'fail-closed', 'finding', { id: 'unsafe' });
    const unsafeRequests: AppendRequest<JsonValue>[] = [
      { ...base, storageCapability: 'nfs-multi-host' },
      { ...base, ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH + 1 },
      { ...base, writerCapability: 'unsupported-writer-v0' },
    ];
    const refusals = unsafeRequests.map((attempt) => {
      try {
        appendLedgerTransaction(ledgerFile, attempt, fence);
        return false;
      } catch (error) {
        return error instanceof LedgerRefusal;
      }
    });
    assert.deepEqual(refusals, [true, true, true]);
  } finally {
    lock.release();
  }
  assert.equal(existsSync(ledgerFile), false, 'an unsafe boundary request wrote a ledger');
  console.log('green.fail_closed_boundary: PASS unsafeWrites=0');
}

export function runAggregateTamperMatrix(repositoryRoot: string): void {
  assertStory3VerifierPositiveControl(repositoryRoot);
  const mutations = [
    'story3-promote-query-l4',
    'story3-promote-runtime-run-l4',
    'story3-drop-runtime-freshness',
    'story3-unregistered-direct-consumer',
  ];
  const lifecycleBefore = git(repositoryRoot, ['status', '--porcelain=v1']);
  assert.equal(mutations.filter((mutation) => story3VerifierMutationAccepted(repositoryRoot, mutation)).length, 0);
  assert.equal(git(repositoryRoot, ['status', '--porcelain=v1']), lifecycleBefore, 'mutation verifier changed lifecycle/worktree state');
  console.log('green.tamper_matrix: PASS lifecycleDelta=0');
}

export function runDependencyScorecardBoundary(repositoryRoot: string): void {
  assertStory3VerifierPositiveControl(repositoryRoot);
  const query = getProcessFactRegistryEntry('finding_ledger_query');
  assert.ok(query);
  assert.equal(query.level, 'L0');
  assert.equal(query.consumerGate, undefined);
  assert.equal(query.semantics.includes('gate-evidence'), false);
  assert.equal(story3VerifierMutationAccepted(repositoryRoot, 'story3-forbidden-story2-import'), false);
  assert.equal(story3VerifierMutationAccepted(repositoryRoot, 'story3-forbidden-story1-import'), false);
  assert.equal(story3VerifierMutationAccepted(repositoryRoot, 'story3-query-path-leak'), false);
  console.log('green.dependency_scorecard_boundary: PASS');
}

export function runBuildLockFifoRegression(repositoryRoot: string, scratch: string): void {
  const buildLockPath = join(repositoryRoot, 'scripts', 'build-lock.mjs');
  const fixture = String.raw`
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const {
      BUILD_LOCK_MAX_IN_PROCESS_WAITERS,
      buildLockAdmissionState,
      buildLockAdmissionTargetCount,
      buildLockTarget,
      withBuildLock,
    } = await import(pathToFileURL(process.argv[1]).href);
    const scratch = process.argv[2];
    const fifoTarget = join(scratch, 'fifo-target');
    const order = [];
    let active = 0;
    let maxActive = 0;
    const enter = async (label, shouldFail = false) => withBuildLock(fifoTarget, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(label + '-enter');
      assert.equal(existsSync(buildLockTarget(fifoTarget) + '.lock'), true, 'proper-lockfile lock directory missing');
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      order.push(label + (shouldFail ? '-fail' : '-exit'));
      if (shouldFail) throw new Error('injected build failure');
      return label;
    });
    const jobs = [enter('first'), enter('second', true), enter('third')];
    assert.deepEqual(buildLockAdmissionState(fifoTarget), { running: true, waiting: 2 });
    const settled = await Promise.allSettled(jobs);
    assert.deepEqual(settled.map((item) => item.status), ['fulfilled', 'rejected', 'fulfilled']);
    assert.deepEqual(order, [
      'first-enter', 'first-exit', 'second-enter', 'second-fail', 'third-enter', 'third-exit',
    ]);
    assert.equal(maxActive, 1);
    assert.equal(buildLockAdmissionState(fifoTarget), undefined);

    let releaseFirst;
    let markEntered;
    const releaseGate = new Promise((resolve) => { releaseFirst = resolve; });
    const entered = new Promise((resolve) => { markEntered = resolve; });
    const independentA = join(scratch, 'independent-a');
    const independentB = join(scratch, 'independent-b');
    const a = withBuildLock(independentA, async () => {
      markEntered();
      await releaseGate;
    });
    await entered;
    const b = withBuildLock(independentB, async () => {
      assert.equal(existsSync(buildLockTarget(independentB) + '.lock'), true);
      return 'independent';
    });
    const winner = await Promise.race([
      b,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);
    assert.equal(winner, 'independent', 'a different target was serialized behind the first target');
    releaseFirst();
    await a;
    assert.equal(buildLockAdmissionTargetCount(), 0);

    let releaseBounded;
    let markBoundedEntered;
    const boundedGate = new Promise((resolve) => { releaseBounded = resolve; });
    const boundedEntered = new Promise((resolve) => { markBoundedEntered = resolve; });
    const boundedTarget = join(scratch, 'bounded-target');
    const boundedHolder = withBuildLock(boundedTarget, async () => {
      markBoundedEntered();
      await boundedGate;
    });
    await boundedEntered;
    const boundedWaiters = Array.from({ length: BUILD_LOCK_MAX_IN_PROCESS_WAITERS }, () => (
      withBuildLock(boundedTarget, async () => undefined)
    ));
    assert.equal(buildLockAdmissionState(boundedTarget).waiting, BUILD_LOCK_MAX_IN_PROCESS_WAITERS);
    await assert.rejects(
      withBuildLock(boundedTarget, async () => undefined),
      (error) => error?.code === 'EBUILDLOCKQUEUEFULL',
    );
    releaseBounded();
    await Promise.all([boundedHolder, ...boundedWaiters]);
    assert.equal(buildLockAdmissionState(boundedTarget), undefined);
    assert.equal(buildLockAdmissionTargetCount(), 0);
  `;
  const result = spawnSync(process.execPath, [
    '--input-type=module', '-e', fixture, buildLockPath, join(scratch, 'build-lock-fifo'),
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, `build-lock FIFO regression failed: ${result.stderr}\n${result.stdout}`);
  console.log('build-lock.fifo_admission: PASS order=true bounded=true mutualExclusion=true failureRecovery=true targetIndependence=true queueCleanup=true properLockfile=true');
}
