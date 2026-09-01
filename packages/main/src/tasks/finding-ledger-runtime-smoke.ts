import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FINDING_LEDGER_LOCAL_FS_CAPABILITY,
  FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY,
  FINDING_LEDGER_SCHEMA_EPOCH,
  LedgerRefusal,
  appendLedgerTransaction,
  readLedger,
  recoverLedger,
  type AppendRequest,
  type DurableCommitTrace,
  type JsonValue,
} from '../core/finding-ledger.js';
import {
  acquireMkdirLock,
  captureMkdirLockFence,
} from '../core/mkdir-lock.js';
import {
  acquireMainWriteLock,
  mainWriteLockPath,
} from '../core/main-write-lock.js';
import { StoryStore } from '../core/store.js';
import type { Finding } from '../core/types.js';

interface WorkerSpec {
  ledgerFile: string;
  lockDir: string;
  prefix: string;
  count: number;
  recordType: string;
  payloadBase: Record<string, JsonValue>;
  uniqueBindingKey?: string;
}

function request(
  fenceToken: string,
  idempotencyKey: string,
  recordType: string,
  payload: JsonValue,
  uniqueBindingKey?: string,
): AppendRequest<JsonValue> {
  return {
    operation: recordType === 'legacy_identity_binding'
      ? 'append_legacy_identity_binding'
      : `append_${recordType}`,
    idempotencyKey,
    records: [{ recordType, payload, ...(uniqueBindingKey ? { uniqueBindingKey } : {}) }],
    ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH,
    writerCapability: FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY,
    writerSessionId: `smoke-${process.pid}`,
    writerFenceToken: fenceToken,
    storageCapability: FINDING_LEDGER_LOCAL_FS_CAPABILITY,
  };
}

function appendUnderLock(spec: WorkerSpec): Array<{ recordId: string; receiptId: string }> {
  const committed: Array<{ recordId: string; receiptId: string }> = [];
  for (let index = 0; index < spec.count; index += 1) {
    const lock = acquireMkdirLock(spec.lockDir, {
      label: 'finding ledger smoke worker',
      requireHolderToken: true,
      deadlineMs: 60_000,
      staleMs: 20_000,
    });
    try {
      const fence = captureMkdirLockFence(spec.lockDir);
      const idempotencyKey = `${spec.prefix}:${index}`;
      const payload = spec.uniqueBindingKey
        ? spec.payloadBase as JsonValue
        : { ...spec.payloadBase, writer: spec.prefix, index } as JsonValue;
      const result = appendLedgerTransaction(
        spec.ledgerFile,
        request(fence.writerFenceToken, idempotencyKey, spec.recordType, payload, spec.uniqueBindingKey),
        fence,
      );
      committed.push({ recordId: result.records[0]!.recordId, receiptId: result.receipt.receiptId });
    } finally {
      lock.release();
    }
  }
  return committed;
}

async function runWorkers(specs: WorkerSpec[]): Promise<void> {
  const self = fileURLToPath(import.meta.url);
  await Promise.all(specs.map((spec) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [self, '--ledger-worker', JSON.stringify(spec)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ledger worker exited ${code}: ${stderr || stdout}`));
    });
  })));
}

if (process.argv[2] === '--ledger-worker') {
  appendUnderLock(JSON.parse(process.argv[3] ?? '{}') as WorkerSpec);
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'finding-ledger-smoke-'));
  try {
    const concurrentFile = join(scratch, 'concurrent', 'finding-ledger.json');
    const concurrentLock = join(scratch, 'locks', 'normal-findings.lock');
    const workerCount = 25;
    await runWorkers(Array.from({ length: workerCount }, (_, worker) => ({
      ledgerFile: concurrentFile,
      lockDir: concurrentLock,
      prefix: `finding-${worker}`,
      count: 4,
      recordType: 'finding',
      payloadBase: { storyId: 'B-SMOKE', status: 'open' },
    })));
    const concurrent = readLedger(concurrentFile);
    assert.equal(concurrent.records.length, 100);
    assert.equal(new Set(concurrent.records.map((record) => record.recordId)).size, 100);
    assert.ok(concurrent.records.every((record) => !/^lr_\d+$/.test(record.recordId)));
    console.log('ledger.concurrent_unique_appends: PASS rows=100 uniqueRecordIds=100');

    const originalIds = new Map(concurrent.receipts.map((receipt) => [
      receipt.idempotencyKey,
      `${receipt.recordIds.join(',')}:${receipt.receiptId}`,
    ]));
    const replayLock = acquireMkdirLock(concurrentLock, { label: 'finding ledger replay', requireHolderToken: true });
    try {
      const fence = captureMkdirLockFence(concurrentLock);
      for (const record of concurrent.records) {
        const replay = appendLedgerTransaction(
          concurrentFile,
          request(fence.writerFenceToken, record.idempotencyKey, record.recordType, record.payload),
          fence,
        );
        assert.equal(replay.action, 'replay');
        assert.equal(
          `${replay.records.map((item) => item.recordId).join(',')}:${replay.receipt.receiptId}`,
          originalIds.get(record.idempotencyKey),
        );
      }
    } finally {
      replayLock.release();
    }
    assert.equal(readLedger(concurrentFile).records.length, 100);
    console.log('ledger.idempotent_replay: PASS replays=100 newRows=0 sameIds=true');

    const durableFile = join(scratch, 'durable', 'finding-ledger.json');
    const durableLockDir = join(scratch, 'locks', 'durable.lock');
    const durableLock = acquireMkdirLock(durableLockDir, { label: 'durable ledger commit', requireHolderToken: true });
    const trace: DurableCommitTrace = { fsyncFile: false, atomicRename: false, fsyncDirectory: false };
    try {
      const fence = captureMkdirLockFence(durableLockDir);
      appendLedgerTransaction(
        durableFile,
        request(fence.writerFenceToken, 'durable:1', 'finding', { id: 'B-SMOKE:F-DURABLE' }),
        fence,
        { trace },
      );
    } finally {
      durableLock.release();
    }
    const durable = readLedger(durableFile);
    assert.equal(durable.ledgerSchemaEpoch, FINDING_LEDGER_SCHEMA_EPOCH);
    assert.equal(durable.minimumWriterCapability, FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY);
    assert.deepEqual(trace, { fsyncFile: true, atomicRename: true, fsyncDirectory: true });

    // Exercise the Store choke point and its crash-safe projection: a ledger
    // commit is readable even when the compatibility findings.json mirror was
    // never written (the exact crash window used by finding_add).
    const storeRoot = join(scratch, 'store-integration');
    const store = new StoryStore(storeRoot);
    const storeStoryId = 'B-SMOKE';
    const storeLockDir = store.storyFilePath(storeStoryId, 'findings.lock');
    const storeLock = acquireMkdirLock(storeLockDir, {
      label: 'Store ledger integration', requireHolderToken: true,
    });
    try {
      const fence = captureMkdirLockFence(storeLockDir);
      const finding: Finding = {
        id: 'B-SMOKE:F-001',
        desc: 'committed before compatibility mirror',
        severity: 'high',
        category: 'adversarial',
        status: 'open',
      };
      store.appendFindingLedgerTransaction(storeStoryId, {
        operation: 'append_finding',
        idempotencyKey: 'store-projection:1',
        records: [{ recordType: 'finding', payload: finding }],
        ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH,
        writerCapability: FINDING_LEDGER_MINIMUM_WRITER_CAPABILITY,
        writerSessionId: 'store-smoke',
        writerFenceToken: fence.writerFenceToken,
        storageCapability: FINDING_LEDGER_LOCAL_FS_CAPABILITY,
      }, fence);
    } finally {
      storeLock.release();
    }
    assert.equal(existsSync(store.storyFilePath(storeStoryId, 'findings.json')), false);
    assert.match(store.readFindings(storeStoryId).findings[0]?.recordId ?? '', /^lr_/);
    console.log('ledger.durable_commit: PASS fsyncFile=true atomicRename=true fsyncDirectory=true');

    const mixedFile = join(scratch, 'mixed', 'finding-ledger.json');
    const mixedLock = join(scratch, 'locks', 'mixed.lock');
    const mixedTypes = [
      'finding',
      'candidate_route',
      'assessment',
      'mandatory_repair',
      'expiry_policy',
      'deferral',
      'route',
      'baseline_set',
      'material_drift_reattestation',
      'manifest',
    ];
    await runWorkers(mixedTypes.map((recordType, index) => ({
      ledgerFile: mixedFile,
      lockDir: mixedLock,
      prefix: `mixed-${index}`,
      count: 2,
      recordType,
      payloadBase: { ref: 'root' },
    })));
    const mixed = readLedger(mixedFile);
    assert.equal(mixed.records.length, mixedTypes.length * 2);
    assert.equal(mixed.records.filter((record) => (record.payload as Record<string, JsonValue>).ref !== 'root').length, 0);
    console.log('ledger.mixed_transactions: PASS lost=0 brokenRefs=0');

    const legacyFile = join(scratch, 'legacy', 'finding-ledger.json');
    const legacyLockDir = join(scratch, 'locks', 'legacy.lock');
    const legacyFindingPath = join(scratch, 'legacy', 'findings.json');
    mkdirSync(join(scratch, 'legacy'), { recursive: true });
    const legacyBytes = '{\n  "findings": [{"id":"B-OLD:F-001","desc":"legacy bytes"}]\n}\n';
    writeFileSync(legacyFindingPath, legacyBytes, 'utf8');
    await runWorkers(Array.from({ length: 12 }, (_, index) => ({
      ledgerFile: legacyFile,
      lockDir: legacyLockDir,
      prefix: `legacy-${index}`,
      count: 1,
      recordType: 'legacy_identity_binding',
      payloadBase: { storyId: 'B-OLD', findingId: 'B-OLD:F-001', findingHash: 'abc123' },
      uniqueBindingKey: 'legacy:B-OLD:B-OLD:F-001',
    })));
    const legacy = readLedger(legacyFile);
    assert.equal(legacy.records.length, 1);
    assert.equal(new Set(legacy.receipts.flatMap((receipt) => receipt.recordIds)).size, 1);
    const legacyConflictLock = acquireMkdirLock(legacyLockDir, {
      label: 'legacy binding conflict', requireHolderToken: true,
    });
    try {
      const fence = captureMkdirLockFence(legacyLockDir);
      assert.throws(() => appendLedgerTransaction(
        legacyFile,
        request(
          fence.writerFenceToken,
          'legacy-conflicting-hash',
          'legacy_identity_binding',
          { storyId: 'B-OLD', findingId: 'B-OLD:F-001', findingHash: 'changed' },
          'legacy:B-OLD:B-OLD:F-001',
        ),
        fence,
      ), /IMMUTABLE_BINDING_CONFLICT|already bound/);
    } finally {
      legacyConflictLock.release();
    }
    assert.equal(readLedger(legacyFile).records.length, 1);
    assert.equal(readFileSync(legacyFindingPath, 'utf8'), legacyBytes);
    console.log('ledger.legacy_binding: PASS singleRecord=true rewrite=false');

    const refusalFile = join(scratch, 'refusal', 'finding-ledger.json');
    const refusalLockDir = join(scratch, 'locks', 'refusal.lock');
    const refusalLock = acquireMkdirLock(refusalLockDir, { label: 'capability refusal', requireHolderToken: true });
    try {
      const fence = captureMkdirLockFence(refusalLockDir);
      const base = request(fence.writerFenceToken, 'refusal', 'finding', { id: 'refused' });
      const attempts: AppendRequest<JsonValue>[] = [
        { ...base, storageCapability: 'nfs-multi-host' },
        { ...base, ledgerSchemaEpoch: FINDING_LEDGER_SCHEMA_EPOCH + 1 },
        { ...base, writerCapability: 'legacy-writer-v0' },
      ];
      for (const attempt of attempts) {
        assert.throws(() => appendLedgerTransaction(refusalFile, attempt, fence), LedgerRefusal);
      }
    } finally {
      refusalLock.release();
    }
    assert.equal(existsSync(refusalFile), false);
    console.log('ledger.capability_boundary: PASS writes=0');

    const crashFile = join(scratch, 'crash', 'finding-ledger.json');
    const crashLockDir = join(scratch, 'locks', 'crash.lock');
    const crashLock = acquireMkdirLock(crashLockDir, { label: 'crash boundary', requireHolderToken: true });
    try {
      const fence = captureMkdirLockFence(crashLockDir);
      assert.throws(() => appendLedgerTransaction(
        crashFile,
        request(fence.writerFenceToken, 'crash:1', 'finding', { id: 'half' }),
        fence,
        { beforeRename: () => { throw new Error('injected crash before rename'); } },
      ), /injected crash/);
    } finally {
      crashLock.release();
    }
    assert.equal(recoverLedger(crashFile).records.length, 0);
    console.log('ledger.crash_recovery: PASS halfVisible=0');

    const staleFile = join(scratch, 'stale', 'finding-ledger.json');
    const staleLockDir = join(scratch, 'locks', 'stale.lock');
    const staleHolder = acquireMkdirLock(staleLockDir, {
      label: 'stale holder', requireHolderToken: true, staleMs: 5, deadlineMs: 50,
    });
    const staleFence = captureMkdirLockFence(staleLockDir);
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(staleLockDir, oldTime, oldTime);
    const successor = acquireMkdirLock(staleLockDir, {
      label: 'successor holder', requireHolderToken: true, staleMs: 5, deadlineMs: 1_000,
    });
    try {
      assert.throws(() => appendLedgerTransaction(
        staleFile,
        request(staleFence.writerFenceToken, 'stale:1', 'finding', { id: 'stale' }),
        staleFence,
      ), /STALE_FENCE|ownership changed/);
      assert.equal(existsSync(staleFile), false);
      const successorFence = captureMkdirLockFence(staleLockDir);
      appendLedgerTransaction(
        staleFile,
        request(successorFence.writerFenceToken, 'successor:1', 'finding', { id: 'current' }),
        successorFence,
      );
      staleHolder.release();
      assert.equal(successor.isCurrent?.(), true);
    } finally {
      successor.release();
    }
    assert.equal(readLedger(staleFile).records.length, 1);
    console.log('ledger.stale_fence: PASS staleWrites=0');

    const normalCompatibilityLock = join(scratch, 'story', 'B-SMOKE', 'findings.lock');
    const normal = acquireMkdirLock(normalCompatibilityLock, {
      label: 'normal Finding compatibility', requireHolderToken: true,
    });
    try {
      const fence = captureMkdirLockFence(normalCompatibilityLock);
      appendLedgerTransaction(
        join(scratch, 'story', 'B-SMOKE', 'finding-ledger.json'),
        request(fence.writerFenceToken, 'lock-normal', 'finding', { id: 'normal' }),
        fence,
      );
    } finally {
      normal.release();
    }
    const main = acquireMainWriteLock(scratch, { label: 'B-META ledger compatibility', onContention: 'wait' });
    try {
      const canonicalMainLock = mainWriteLockPath(scratch);
      assert.equal(main.lockDir, canonicalMainLock);
      const fence = captureMkdirLockFence(canonicalMainLock);
      appendLedgerTransaction(
        join(scratch, 'story', 'B-META-framework-audit', 'finding-ledger.json'),
        request(fence.writerFenceToken, 'lock-meta', 'finding', { id: 'meta' }),
        fence,
      );
    } finally {
      main.release();
    }
    console.log('ledger.lock_compatibility: PASS deadlocks=0');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
