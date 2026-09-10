import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const distRoot = join(repoRoot, 'packages', 'main', 'dist');
const causal = await import(pathToFileURL(join(distRoot, 'core/causal-evidence.js')).href);
const { StoryStore } = await import(pathToFileURL(join(distRoot, 'core/store.js')).href);

const {
  DEFAULT_CAUSAL_SELECTOR_POLICY,
  createCausalEvidenceBatch,
  executeCausalEvidence,
  preflightCausalEvidence,
} = causal;

class MemoryReceiptStore {
  constructor() {
    this.receipts = new Map();
    this.flights = new Map();
  }

  readCausalEvidenceReceipt(storyId, executionKey) {
    return this.receipts.get(`${storyId}:${executionKey}`) ?? null;
  }

  writeCausalEvidenceReceipt(storyId, receipt) {
    const key = `${storyId}:${receipt.executionKey}`;
    const prior = this.receipts.get(key);
    if (prior && prior.receiptHash !== receipt.receiptHash) throw new Error('receipt overwrite');
    this.receipts.set(key, structuredClone(receipt));
  }

  withCausalEvidenceExecution(storyId, executionKey, fn) {
    const flightKey = `${storyId}:${executionKey}`;
    const prior = this.flights.get(flightKey);
    if (prior) return prior;
    const flight = Promise.resolve().then(fn);
    this.flights.set(flightKey, flight);
    return flight.finally(() => {
      if (this.flights.get(flightKey) === flight) this.flights.delete(flightKey);
    });
  }
}

function identity(cwd, storyId = 'B-5a15-concurrency', overrides = {}) {
  return {
    storyId,
    cwd,
    command: { executable: process.execPath, args: ['-e', "console.log('CONCURRENCY-MARKER')"] },
    bootstrap: { executable: 'proof-or-stop', args: ['verification-evidence'] },
    inputs: { materialHash: 'concurrency-material', explicitInput: 'same' },
    storyFilesHash: 'concurrency-story',
    effectiveEnvironment: { NODE_ENV: 'test' },
    runtimeVersion: process.version,
    toolVersion: 'causal-evidence-concurrency@1',
    selectorPolicy: DEFAULT_CAUSAL_SELECTOR_POLICY,
    ...overrides,
  };
}

function readyPreflight(runIdentity) {
  const { cwd, storyId } = runIdentity;
  return preflightCausalEvidence({
    cli: { available: true, path: '/usr/bin/proof-or-stop' },
    worktree: { expected: cwd, actual: cwd },
    gitIndex: { readable: true, path: join(cwd, 'index'), expected: 'head', actual: 'head', contentDigest: 'sha256:test-index' },
    gitMaterial: { available: true, headHash: 'head', materialHash: runIdentity.inputs?.materialHash, storyFilesHash: runIdentity.storyFilesHash },
    writerLease: { available: true, valid: true },
    providerCapability: { required: ['allowlisted-command', 'bounded-output'], available: ['allowlisted-command', 'bounded-output'] },
    resources: { required: { timeoutMs: 1000 }, available: { timeoutMs: 1000 } },
    evidenceTarget: { writable: true, path: `${storyId}/causal-evidence/` },
    sideChannel: { available: true, maxOutputChars: 12_000, maxProgressEvents: 10 },
  }, undefined, runIdentity);
}

function delayedRun(counter, marker) {
  return async () => {
    counter.count++;
    await new Promise(resolve => setTimeout(resolve, 25));
    return { code: 0, output: marker };
  };
}

test('separate concurrent requests single-flight exact keys and isolate near-duplicates', async () => {
  const store = new MemoryReceiptStore();
  const sameIdentity = identity(repoRoot);
  const preflight = readyPreflight(sameIdentity);
  const counter = { count: 0 };
  const [pass, mismatch] = await Promise.all([
    executeCausalEvidence({
      identity: sameIdentity,
      selector: 'CONCURRENCY-MARKER',
      run: delayedRun(counter, 'CONCURRENCY-MARKER'),
      receiptStore: store,
      preflight,
      revalidateBeforeRun: () => true,
    }),
    executeCausalEvidence({
      identity: sameIdentity,
      selector: 'MISSING-MARKER',
      run: delayedRun(counter, 'CONCURRENCY-MARKER'),
      receiptStore: store,
      preflight,
      revalidateBeforeRun: () => true,
    }),
  ]);

  assert.equal(counter.count, 1, 'separate requests execute one exact reusable key once');
  assert.equal(pass.receipt.receiptHash, mismatch.receipt.receiptHash);
  assert.equal(pass.verdict.result, 'pass');
  assert.equal(mismatch.verdict.result, 'fail', 'selectors still fan out independently');

  const nearStore = new MemoryReceiptStore();
  const nearCounter = { count: 0 };
  const nearIdentity = identity(repoRoot, sameIdentity.storyId, {
    inputs: { materialHash: 'near-material', explicitInput: 'same' },
  });
  const nearPreflight = readyPreflight(nearIdentity);
  const [first, near] = await Promise.all([
    executeCausalEvidence({
      identity: sameIdentity,
      selector: 'CONCURRENCY-MARKER',
      run: delayedRun(nearCounter, 'CONCURRENCY-MARKER'),
      receiptStore: nearStore,
      preflight,
      revalidateBeforeRun: () => true,
    }),
    executeCausalEvidence({
      identity: nearIdentity,
      selector: 'CONCURRENCY-MARKER',
      run: delayedRun(nearCounter, 'CONCURRENCY-MARKER'),
      receiptStore: nearStore,
      preflight: nearPreflight,
      revalidateBeforeRun: () => true,
    }),
  ]);
  assert.equal(nearCounter.count, 2, 'a near-duplicate identity executes separately');
  assert.notEqual(first.key.key, near.key.key);
});

test('batch retries a non-pass exact key through one shared retry flight', async () => {
  const batch = createCausalEvidenceBatch();
  const runIdentity = identity(repoRoot, 'B-5a15-batch-retry');
  const preflight = readyPreflight(runIdentity);
  const counter = { count: 0 };
  const run = async () => {
    counter.count++;
    await new Promise(resolve => setTimeout(resolve, 25));
    return counter.count === 1
      ? { code: 1, output: 'FIRST-FAILURE' }
      : { code: 0, output: 'RETRY-PASS' };
  };
  const call = () => executeCausalEvidence({
    identity: runIdentity,
    selector: 'RETRY-PASS',
    run,
    batch,
    preflight,
    revalidateBeforeRun: () => true,
  });
  const [first, second, third] = await Promise.all([call(), call(), call()]);

  assert.equal(counter.count, 2, 'one failed attempt and one shared retry serve the exact key');
  assert.equal(first.receipt.reusable, false);
  assert.equal(second.receipt.reusable, true);
  assert.equal(third.receipt.reusable, true);
  assert.equal(batch.ledger.executions[0]?.executionAttempts, 2, 'ledger counts child executions, not retry followers');
});

test('StoryStore single-flight preserves one exact receipt and concurrent index writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'causal-evidence-concurrency-'));
  try {
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    const store = new StoryStore(root);
    const storyId = 'B-5a15-store-concurrency';
    const runIdentity = identity(root, storyId);
    const preflight = readyPreflight(runIdentity);
    const counter = { count: 0 };
    const [first, second] = await Promise.all([
      executeCausalEvidence({
        identity: runIdentity,
        selector: 'CONCURRENCY-MARKER',
        run: delayedRun(counter, 'CONCURRENCY-MARKER'),
        receiptStore: store,
        preflight,
        revalidateBeforeRun: () => true,
      }),
      executeCausalEvidence({
        identity: runIdentity,
        selector: 'CONCURRENCY-MARKER',
        run: delayedRun(counter, 'CONCURRENCY-MARKER'),
        receiptStore: store,
        preflight,
        revalidateBeforeRun: () => true,
      }),
    ]);

    assert.equal(counter.count, 1, 'StoryStore executes one exact reusable key once');
    assert.equal(first.receipt.receiptHash, second.receipt.receiptHash);
    assert.equal(store.readCausalEvidenceReceipt(storyId, first.key.key).receiptHash, first.receipt.receiptHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
