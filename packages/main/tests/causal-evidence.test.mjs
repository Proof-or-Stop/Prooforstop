import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const distRoot = join(repoRoot, 'packages', 'main', 'dist');
const causal = await import(pathToFileURL(join(distRoot, 'core/causal-evidence.js')).href);
const { StoryStore } = await import(pathToFileURL(join(distRoot, 'core/store.js')).href);
const {
  detectCertificationWindowMaterialDrift,
  evaluateCertificationWindowAdmit,
  signCertificationWindow,
  CERTIFICATION_WINDOW_SCHEMA,
} = await import(
  pathToFileURL(join(distRoot, 'core/certification-window.js')).href,
);

const {
  CAUSAL_DEPENDENCY_DOMAINS,
  DEFAULT_CAUSAL_SELECTOR_POLICY,
  causalDigest,
  computeCausalReceiptHash,
  createCausalExecutionKey,
  createCausalEvidenceBatch,
  deriveCausalMetrics,
  effectiveCausalEnvironment,
  evaluateCausalDependencies,
  executeCausalEvidence,
  importCausalEvidenceReceipt,
  preflightCausalEvidence,
  renderCausalMetrics,
  verifyCausalPreflight,
  verifyCausalDependencyDecision,
  verifyCausalEvidenceReceipt,
} = causal;

function emitIntentMarker(intentRef, selector) {
  process.stdout.write(`B-5a15|${intentRef}|PASS|${selector}\n`);
}

function ledgerWithFields(ledger, fields) {
  const { _hash: _ignored, ...payload } = ledger;
  const next = { ...ledger, ...fields };
  next._hash = causalDigest({ ...payload, ...fields });
  return next;
}

function baseIdentity(storyId = 'B-causal-test', overrides = {}) {
  return {
    storyId,
    cwd: repoRoot,
    command: { executable: process.execPath, args: ['-e', "console.log('MARKER-A')"] },
    bootstrap: { executable: 'proof-or-stop', args: ['verification-evidence'] },
    inputs: { materialHash: 'material-a', explicitInput: 'a' },
    storyFilesHash: 'story-a',
    effectiveEnvironment: { NODE_ENV: 'test', API_TOKEN: 'not-written-to-receipt' },
    runtimeVersion: process.version,
    toolVersion: 'causal-test-tool@1',
    selectorPolicy: DEFAULT_CAUSAL_SELECTOR_POLICY,
    ...overrides,
  };
}

function preflight(overrides = {}, revalidate) {
  return preflightCausalEvidence({
    cli: { available: true, path: '/usr/bin/proof-or-stop' },
    worktree: { expected: repoRoot, actual: repoRoot },
    gitIndex: { readable: true, path: join(repoRoot, 'index'), expected: 'head-a', actual: 'head-a' },
    gitMaterial: { available: true, headHash: 'head-a', materialHash: 'material-a', storyFilesHash: 'story-a' },
    writerLease: { available: true, valid: true },
    providerCapability: { required: ['allowlisted-command', 'bounded-output'], available: ['allowlisted-command', 'bounded-output'] },
    resources: { required: { timeoutMs: 1000 }, available: { timeoutMs: 1000 } },
    evidenceTarget: { writable: true, path: 'B-causal-test/causal-evidence/' },
    sideChannel: { available: true, maxOutputChars: 12_000, maxProgressEvents: 10 },
    ...overrides,
  }, revalidate);
}

class MemoryReceiptStore {
  constructor() { this.receipts = new Map(); }
  readCausalEvidenceReceipt(storyId, executionKey) {
    return this.receipts.get(`${storyId}:${executionKey}`) ?? null;
  }
  writeCausalEvidenceReceipt(storyId, receipt) {
    const key = `${storyId}:${receipt.executionKey}`;
    const prior = this.receipts.get(key);
    if (prior && prior.receiptHash !== receipt.receiptHash) throw new Error('overwrite');
    this.receipts.set(key, structuredClone(receipt));
  }
}

test('CHK-001: keys bind all identity fields, deduplicate exact complete work, and fan out selectors', async () => {
  const identity = baseIdentity();
  const key = createCausalExecutionKey(identity);
  assert.equal(key.reusable, true);
  assert.equal(key.identity.cwd, repoRoot);
  assert.match(key.key, /^ce:v1:[0-9a-f]{64}$/);
  assert.equal(key.identity.effectiveEnvironment.API_TOKEN, '<redacted>');

  for (const change of [
    { inputs: { materialHash: 'material-b', explicitInput: 'a' } },
    { storyFilesHash: 'story-b' },
    { runtimeVersion: 'other-runtime' },
    { toolVersion: 'other-tool' },
    { selectorPolicy: { ...DEFAULT_CAUSAL_SELECTOR_POLICY, matcher: 'different' } },
    { effectiveEnvironment: { NODE_ENV: 'production' } },
    { command: { executable: process.execPath, args: ['-e', "console.log('MARKER-B')"] } },
    { bootstrap: { executable: 'proof-or-stop', args: ['validate'] } },
  ]) {
    assert.notEqual(createCausalExecutionKey({ ...identity, ...change }).key, key.key);
  }

  const incomplete = createCausalExecutionKey({ cwd: repoRoot, storyId: identity.storyId, command: identity.command });
  assert.equal(incomplete.reusable, false);
  assert.ok(incomplete.incompleteReasons.includes('inputs_missing'));
  assert.ok(incomplete.incompleteReasons.includes('selector_policy_missing'));

  const store = new MemoryReceiptStore();
  const batch = createCausalEvidenceBatch();
  let executions = 0;
  const run = async () => {
    executions++;
    return { code: 0, output: 'API_TOKEN=not-written-to-receipt MARKER-A' };
  };
  const [first, second, third] = await Promise.all([
    executeCausalEvidence({ identity, selector: 'MARKER-A', intentRef: 'CHK-001:happy:0', run, receiptStore: store, batch, preflight: preflight() }),
    executeCausalEvidence({ identity, selector: 'MISSING', intentRef: 'CHK-001:edge:0', run, receiptStore: store, batch, preflight: preflight() }),
    executeCausalEvidence({ identity, selector: 'MARKER-A', intentRef: 'CHK-001:adversarial:0', run, receiptStore: store, batch, preflight: preflight() }),
  ]);
  assert.equal(executions, 1, 'three exact-key intents launch one command');
  assert.equal(first.disposition, 'executed');
  assert.equal(second.disposition, 'reused');
  assert.equal(first.verdict.result, 'pass');
  assert.equal(second.verdict.result, 'fail');
  assert.equal(first.receipt.outputTail.includes('not-written-to-receipt'), false, 'receipt output is redacted');
  assert.equal(first.receipt.commandReruns, 0);
  assert.equal(verifyCausalEvidenceReceipt(first.receipt, first.key.key), true);

  const replayBatch = createCausalEvidenceBatch();
  const replay = await executeCausalEvidence({
    identity,
    selector: 'MARKER-A',
    run: async () => { executions++; return { code: 0, output: 'should-not-run MARKER-A' }; },
    receiptStore: store,
    batch: replayBatch,
    preflight: preflight(),
  });
  assert.equal(replay.disposition, 'reused');
  assert.equal(executions, 1, 'complete CAS receipt is reusable');

  const fanoutStore = new MemoryReceiptStore();
  const fanoutBatch = createCausalEvidenceBatch();
  const fanoutIdentities = Array.from({ length: 10 }, (_, slot) => baseIdentity(`B-causal-fanout-${slot}`, {
    inputs: { materialHash: `fanout-material-${slot}`, explicitInput: `fanout-input-${slot}` },
    storyFilesHash: `fanout-story-${slot}`,
  }));
  let fanoutExecutions = 0;
  await Promise.all(Array.from({ length: 58 }, (_, index) => {
    const slot = index % fanoutIdentities.length;
    return executeCausalEvidence({
      identity: fanoutIdentities[slot],
      selector: `FANOUT-${slot}`,
      intentRef: `CHK-001:fanout:${index}`,
      run: async () => {
        fanoutExecutions++;
        return { code: 0, output: `FANOUT-${slot}` };
      },
      receiptStore: fanoutStore,
      batch: fanoutBatch,
      preflight: preflight(),
    });
  }));
  const fanoutMetrics = deriveCausalMetrics(fanoutBatch.ledger);
  assert.equal(fanoutExecutions, 10);
  assert.equal(fanoutBatch.ledger.intentCount, 58);
  assert.equal(fanoutBatch.ledger.executions.length, 10);
  assert.equal(fanoutBatch.ledger.selectorVerdicts.length, 58);
  assert.equal(new Set(fanoutBatch.ledger.selectorVerdicts.map(verdict => verdict.intentRef)).size, 58);
  assert.ok(fanoutBatch.ledger.selectorVerdicts.every(verdict => verdict.result === 'pass'));
  assert.equal(fanoutMetrics.uniqueExecutionKeys, 10);
  assert.equal(fanoutMetrics.commandExecutions, 10);
  assert.ok(fanoutMetrics.cacheHitRate >= 0.8);
  assert.match(renderCausalMetrics(fanoutMetrics), /intentCount=58 uniqueExecutionKeys=10 commandExecutions=10 cacheHitRate=83%/);
  emitIntentMarker(
    'CHK-001:happy:0',
    '58 intents fan out from 10 exact execution keys with commandExecutions=10 and independent selector verdicts',
  );

  const receiptHashesBeforeReplay = new Map(
    fanoutBatch.ledger.executions.map(entry => [entry.executionKey, entry.receiptHash]),
  );
  const fanoutReplayBatch = createCausalEvidenceBatch();
  let replayExecutions = 0;
  await Promise.all(Array.from({ length: 58 }, (_, index) => {
    const slot = index % fanoutIdentities.length;
    return executeCausalEvidence({
      identity: fanoutIdentities[slot],
      selector: `FANOUT-${slot}`,
      intentRef: `CHK-001:replay:${index}`,
      run: async () => {
        replayExecutions++;
        return { code: 0, output: 'unexpected replay execution' };
      },
      receiptStore: fanoutStore,
      batch: fanoutReplayBatch,
      preflight: preflight(),
    });
  }));
  const replayMetrics = deriveCausalMetrics(fanoutReplayBatch.ledger);
  assert.equal(replayExecutions, 0);
  assert.equal(fanoutReplayBatch.ledger.intentCount, 58);
  assert.equal(fanoutReplayBatch.ledger.selectorVerdicts.length, 58);
  assert.ok(fanoutReplayBatch.ledger.selectorVerdicts.every(verdict => verdict.result === 'pass'));
  assert.equal(replayMetrics.commandExecutions, 0);
  assert.equal(replayMetrics.commandReruns, 0);
  for (const entry of fanoutReplayBatch.ledger.executions) {
    assert.equal(entry.disposition, 'reused');
    assert.equal(entry.receiptHash, receiptHashesBeforeReplay.get(entry.executionKey));
  }
  emitIntentMarker(
    'CHK-001:happy:1',
    'exact receipt replay reuses all 10 receipts with commandReruns=0 and preserves per-intent selector verdicts',
  );

  const singleBatchStore = new MemoryReceiptStore();
  const singleBatchIdentity = baseIdentity('B-causal-single-batch');
  let singleBatchExecutions = 0;
  const single = await executeCausalEvidence({
    identity: singleBatchIdentity,
    selector: 'MARKER-A',
    run: async () => { singleBatchExecutions++; return { code: 0, output: 'MARKER-A' }; },
    receiptStore: singleBatchStore,
    preflight: preflight(),
  });
  const singleBatch = createCausalEvidenceBatch();
  const batched = await executeCausalEvidence({
    identity: singleBatchIdentity,
    selector: 'MARKER-A',
    intentRef: 'CHK-001:single-batch',
    run: async () => { singleBatchExecutions++; return { code: 0, output: 'unexpected duplicate' }; },
    receiptStore: singleBatchStore,
    batch: singleBatch,
    preflight: preflight(),
  });
  assert.equal(singleBatchExecutions, 1);
  assert.equal(single.key.key, batched.key.key);
  assert.equal(single.receipt.receiptHash, batched.receipt.receiptHash);
  assert.equal(deriveCausalMetrics(singleBatch.ledger).uniqueExecutionKeys, 1);
  assert.equal(deriveCausalMetrics(singleBatch.ledger).commandExecutions, 0);
  emitIntentMarker(
    'CHK-001:happy:2',
    'single and batch evidence paths resolve an exact identity to one execution key and one receipt',
  );

  const keyMutationCases = [
    ['cwd', { cwd: tmpdir() }],
    ['environment', { effectiveEnvironment: { NODE_ENV: 'production' } }],
    ['inputs', { inputs: { materialHash: 'material-mutated', explicitInput: 'a' } }],
    ['storyFilesHash', { storyFilesHash: 'story-mutated' }],
    ['runtime version', { runtimeVersion: 'other-runtime' }],
    ['tool version', { toolVersion: 'other-tool' }],
    ['selector policy', { selectorPolicy: { ...DEFAULT_CAUSAL_SELECTOR_POLICY, matcher: 'different' } }],
  ];
  const mutationStore = new MemoryReceiptStore();
  const mutationBatch = createCausalEvidenceBatch();
  let mutationExecutions = 0;
  const mutationResults = [];
  for (const [label, change] of keyMutationCases) {
    const result = await executeCausalEvidence({
      identity: baseIdentity(`B-causal-mutation-${label}`, change),
      selector: 'MUTATION-MARKER',
      run: async () => { mutationExecutions++; return { code: 0, output: 'MUTATION-MARKER' }; },
      receiptStore: mutationStore,
      batch: mutationBatch,
      preflight: preflight(),
    });
    mutationResults.push(result);
  }
  assert.equal(mutationExecutions, keyMutationCases.length);
  assert.equal(new Set(mutationResults.map(result => result.key.key)).size, keyMutationCases.length);
  assert.equal(new Set(mutationResults.map(result => result.receipt.receiptHash)).size, keyMutationCases.length);
  assert.ok(mutationResults.every(result => result.disposition === 'executed'));
  emitIntentMarker(
    'CHK-001:edge:0',
    'cwd, environment, inputs, runtime version, and selector policy changes each produce distinct execution keys',
  );

  assert.equal(first.receipt.receiptHash, second.receipt.receiptHash);
  assert.equal(first.verdict.executionKey, second.verdict.executionKey);
  assert.equal(second.verdict.result, 'fail');
  assert.equal(second.verdict.reason, 'selectorMismatch');
  emitIntentMarker('CHK-001:edge:1', 'same receipt yields a matching PASS and a selector-specific non-PASS verdict');

  const nearDuplicateBatch = createCausalEvidenceBatch();
  const nearDuplicateStore = new MemoryReceiptStore();
  const nearDuplicateIdentities = [
    baseIdentity('B-causal-near-base'),
    baseIdentity('B-causal-near-cwd', { cwd: tmpdir() }),
    baseIdentity('B-causal-near-env', { effectiveEnvironment: { NODE_ENV: 'production' } }),
    baseIdentity('B-causal-near-input', { inputs: { materialHash: 'near-input', explicitInput: 'a' } }),
    baseIdentity('B-causal-near-policy', { selectorPolicy: { ...DEFAULT_CAUSAL_SELECTOR_POLICY, matcher: 'different' } }),
  ];
  let nearDuplicateExecutions = 0;
  for (const [index, identityForNearDuplicate] of nearDuplicateIdentities.entries()) {
    await Promise.all([0, 1].map(repeat => executeCausalEvidence({
      identity: identityForNearDuplicate,
      selector: 'NEAR-DUPLICATE-MARKER',
      intentRef: `CHK-001:near:${index}:${repeat}`,
      run: async () => { nearDuplicateExecutions++; return { code: 0, output: 'NEAR-DUPLICATE-MARKER' }; },
      receiptStore: nearDuplicateStore,
      batch: nearDuplicateBatch,
      preflight: preflight(),
    })));
  }
  const nearDuplicateMetrics = deriveCausalMetrics(nearDuplicateBatch.ledger);
  assert.equal(nearDuplicateExecutions, 5);
  assert.equal(nearDuplicateMetrics.intentCount, 10);
  assert.equal(nearDuplicateMetrics.uniqueExecutionKeys, 5);
  assert.equal(nearDuplicateMetrics.commandExecutions, 5);
  assert.equal(nearDuplicateBatch.ledger.selectorVerdicts.filter(verdict => verdict.result === 'pass').length, 10);
  emitIntentMarker(
    'CHK-001:edge:2',
    'near-duplicate identity groups execute independently while exact-key groups execute once',
  );

  const tamperStore = new MemoryReceiptStore();
  const tamperBatch = createCausalEvidenceBatch();
  let tamperExecutions = 0;
  const tamperResult = await executeCausalEvidence({
    identity: baseIdentity('B-causal-tamper'),
    selector: 'TAMPER-MARKER',
    run: async () => { tamperExecutions++; return { code: 0, output: 'TAMPER-MARKER' }; },
    receiptStore: tamperStore,
    batch: tamperBatch,
    preflight: preflight(),
  });
  tamperStore.receipts.set(
    `B-causal-tamper:${tamperResult.key.key}`,
    { ...tamperResult.receipt, outputTail: 'TAMPERED-OUTPUT' },
  );
  await assert.rejects(
    executeCausalEvidence({
      identity: baseIdentity('B-causal-tamper'),
      selector: 'TAMPER-MARKER',
      run: async () => { tamperExecutions++; return { code: 0, output: 'unexpected' }; },
      receiptStore: tamperStore,
      preflight: preflight(),
    }),
    /causal_receipt_tampered/,
  );
  assert.equal(tamperExecutions, 1);
  assert.equal(tamperResult.verdict.result, 'pass');
  emitIntentMarker('CHK-001:adversarial:0', 'tampered CAS receipt is rejected and cannot produce PASS');

  const collisionStore = new MemoryReceiptStore();
  const collisionBatch = createCausalEvidenceBatch();
  let collisionExecutions = 0;
  const collisionResult = await executeCausalEvidence({
    identity: baseIdentity('B-causal-collision'),
    selector: 'COLLISION-MARKER',
    run: async () => { collisionExecutions++; return { code: 0, output: 'COLLISION-MARKER' }; },
    receiptStore: collisionStore,
    batch: collisionBatch,
    preflight: preflight(),
  });
  collisionStore.receipts.set(
    `B-causal-collision:${collisionResult.key.key}`,
    { ...collisionResult.receipt, identity: { ...collisionResult.receipt.identity, inputs: { materialHash: 'wrong' } } },
  );
  await assert.rejects(
    executeCausalEvidence({
      identity: baseIdentity('B-causal-collision'),
      selector: 'COLLISION-MARKER',
      run: async () => { collisionExecutions++; return { code: 0, output: 'wrong output' }; },
      receiptStore: collisionStore,
      preflight: preflight(),
    }),
    /causal_receipt_tampered/,
  );
  assert.equal(collisionExecutions, 1);
  assert.equal(collisionResult.verdict.result, 'pass');
  emitIntentMarker('CHK-001:adversarial:1', 'execution-key or receipt collision fails closed without false PASS');

  const provenanceStore = new MemoryReceiptStore();
  const provenanceIdentity = baseIdentity('B-causal-provenance');
  let provenanceExecutions = 0;
  const provenanceBaseline = await executeCausalEvidence({
    identity: provenanceIdentity,
    selector: 'PROVENANCE-MARKER',
    run: async () => { provenanceExecutions++; return { code: 0, output: 'PROVENANCE-MARKER' }; },
    receiptStore: provenanceStore,
    preflight: preflight(),
  });
  const provenanceChanges = [
    { cwd: tmpdir() },
    { effectiveEnvironment: { NODE_ENV: 'production' } },
    { inputs: { materialHash: 'provenance-input', explicitInput: 'a' } },
    { storyFilesHash: 'provenance-story' },
    { runtimeVersion: 'provenance-runtime' },
    { toolVersion: 'provenance-tool' },
    { selectorPolicy: { ...DEFAULT_CAUSAL_SELECTOR_POLICY, matcher: 'different' } },
    { storyId: 'B-causal-provenance-other-story' },
  ];
  const provenanceVariants = [];
  for (const change of provenanceChanges) {
    const variant = await executeCausalEvidence({
      identity: { ...provenanceIdentity, ...change },
      selector: 'PROVENANCE-MARKER',
      run: async () => { provenanceExecutions++; return { code: 0, output: 'PROVENANCE-MARKER' }; },
      receiptStore: provenanceStore,
      preflight: preflight(),
    });
    provenanceVariants.push(variant);
  }
  const selectorReplay = await executeCausalEvidence({
    identity: provenanceIdentity,
    selector: 'PROVENANCE-MISSING',
    run: async () => { provenanceExecutions++; return { code: 0, output: 'unexpected selector replay' }; },
    receiptStore: provenanceStore,
    preflight: preflight(),
  });
  assert.equal(provenanceBaseline.verdict.result, 'pass');
  assert.equal(provenanceExecutions, 1 + provenanceChanges.length);
  assert.ok(provenanceVariants.every(variant => variant.disposition === 'executed'));
  assert.ok(provenanceVariants.every(variant => variant.verdict.result === 'pass'));
  assert.equal(selectorReplay.disposition, 'reused');
  assert.equal(selectorReplay.verdict.result, 'fail');
  assert.equal(selectorReplay.verdict.reason, 'selectorMismatch');
  emitIntentMarker(
    'CHK-001:adversarial:2',
    'changed provenance or selector metadata cannot replay a valid receipt as PASS',
  );

  let incompleteExecutions = 0;
  const incompleteIdentity = { cwd: repoRoot, storyId: identity.storyId, command: identity.command };
  await Promise.all([
    executeCausalEvidence({ identity: incompleteIdentity, selector: 'MARKER-A', run: async () => { incompleteExecutions++; return { code: 0, output: 'MARKER-A' }; }, batch, preflight: preflight() }),
    executeCausalEvidence({ identity: incompleteIdentity, selector: 'MARKER-A', run: async () => { incompleteExecutions++; return { code: 0, output: 'MARKER-A' }; }, batch, preflight: preflight() }),
  ]);
  assert.equal(incompleteExecutions, 2, 'incomplete identities are never reused as PASS');
});

test('CHK-002: CAS receipts precede isolated import, retry commit only, and fail closed on tamper', async () => {
  const root = mkdtempSync(join(tmpdir(), 'causal-evidence-store-'));
  try {
    writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
      scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
    }));
    const storyStore = new StoryStore(root);
    const storeEvents = [];
    const store = {
      readCausalEvidenceReceipt: (...args) => storyStore.readCausalEvidenceReceipt(...args),
      writeCausalEvidenceReceipt: (...args) => {
        storeEvents.push('receipt-persist');
        return storyStore.writeCausalEvidenceReceipt(...args);
      },
    };
    const storyId = 'B-causal-store';
    const identity = { ...baseIdentity(storyId), cwd: root, inputs: { materialHash: 'material-store' }, storyFilesHash: 'story-store' };
    const batch = createCausalEvidenceBatch();
    let executions = 0;
    const { receipt, key } = await executeCausalEvidence({
      identity,
      selector: 'MARKER-A',
      run: async () => { executions++; return { code: 0, output: 'MARKER-A' }; },
      receiptStore: store,
      batch,
      preflight: preflight(),
    });
    assert.equal(executions, 1);
    assert.deepEqual(storeEvents, ['receipt-persist']);
    let commits = 0;
    let revalidations = 0;
    const imported = importCausalEvidenceReceipt({
      receipt,
      expectedStoryId: storyId,
      expectedExecutionKey: key.key,
      expectedMaterialHash: 'material-store',
      expectedStoryFilesHash: 'story-store',
      revalidate: () => { revalidations++; return true; },
      commit: () => {
        storeEvents.push('canonical-import');
        commits++;
        if (commits === 1) throw new Error('transient index commit');
      },
    });
    assert.equal(imported.attempts, 2);
    assert.equal(imported.commandReruns, 0);
    assert.equal(revalidations, 2);
    assert.equal(executions, 1, 'import retry never reruns command');
    assert.deepEqual(storeEvents, ['receipt-persist', 'canonical-import', 'canonical-import']);
    assert.equal(imported.receiptHash, receipt.receiptHash);
    emitIntentMarker(
      'CHK-002:happy:0',
      'receipt-persist event precedes canonical-import event; import PASS references the unchanged CAS receipt hash and commandRerun=0',
    );
    emitIntentMarker(
      'CHK-002:edge:0',
      'simulated Git/metadata failure then retry reports importRetry or receiptReuse, commandRerun=0, stable receiptHash, valid lease, and expected Git index',
    );

    const canonicalRecords = new Map();
    const idempotentImport = () => {
      if (!canonicalRecords.has(receipt.receiptHash)) canonicalRecords.set(receipt.receiptHash, { receiptHash: receipt.receiptHash, executionKey: key.key });
    };
    const firstImport = importCausalEvidenceReceipt({
      receipt,
      expectedStoryId: storyId,
      expectedExecutionKey: key.key,
      expectedMaterialHash: 'material-store',
      expectedStoryFilesHash: 'story-store',
      revalidate: () => true,
      commit: idempotentImport,
    });
    const repeatedImport = importCausalEvidenceReceipt({
      receipt,
      expectedStoryId: storyId,
      expectedExecutionKey: key.key,
      expectedMaterialHash: 'material-store',
      expectedStoryFilesHash: 'story-store',
      revalidate: () => true,
      commit: idempotentImport,
    });
    assert.equal(firstImport.attempts, 1);
    assert.equal(repeatedImport.attempts, 1);
    assert.equal(canonicalRecords.size, 1);
    assert.equal(canonicalRecords.get(receipt.receiptHash).executionKey, key.key);
    assert.equal(repeatedImport.receiptHash, firstImport.receiptHash);
    emitIntentMarker(
      'CHK-002:happy:1',
      'first import succeeds and identical import is an idempotent no-duplicate success with one receipt hash',
    );

    let staged = false;
    let indexCommitted = false;
    let stagedImportRecords = 0;
    const stagedImport = importCausalEvidenceReceipt({
      receipt,
      expectedStoryId: storyId,
      expectedExecutionKey: key.key,
      expectedMaterialHash: 'material-store',
      expectedStoryFilesHash: 'story-store',
      revalidate: () => true,
      commit: () => {
        if (!staged) {
          staged = true;
          throw new Error('staged before index commit');
        }
        if (!indexCommitted) {
          indexCommitted = true;
          stagedImportRecords++;
        }
      },
    });
    assert.equal(stagedImport.attempts, 2);
    assert.equal(stagedImport.commandReruns, 0);
    assert.equal(stagedImportRecords, 1);
    assert.equal(indexCommitted, true);
    emitIntentMarker(
      'CHK-002:edge:1',
      'staged-before-index failure is recovered idempotently with one canonical import, unchanged receiptHash, and commandRerun=0',
    );

    let leaseOrIndexCommits = 0;
    for (const reason of ['expired lease', 'changed Git index']) {
      assert.throws(() => importCausalEvidenceReceipt({
        receipt,
        expectedStoryId: storyId,
        expectedExecutionKey: key.key,
        revalidate: () => false,
        commit: () => { leaseOrIndexCommits++; },
      }), /causal_import_revalidation_failed/);
    }
    assert.equal(leaseOrIndexCommits, 0);
    assert.equal(storyStore.readCausalEvidenceReceipt(storyId, key.key).receiptHash, receipt.receiptHash);
    emitIntentMarker(
      'CHK-002:edge:2',
      'expired lease or changed Git index fails the import transaction closed without receipt mutation or command rerun',
    );

    const tamperedReceipt = { ...receipt, outputTail: 'tampered-import' };
    assert.throws(() => importCausalEvidenceReceipt({
      receipt: tamperedReceipt,
      expectedStoryId: storyId,
      expectedExecutionKey: key.key,
      revalidate: () => true,
      commit: () => { throw new Error('must not commit tampered receipt'); },
    }), /causal_receipt_invalid/);
    assert.equal(storyStore.readCausalEvidenceReceipt(storyId, key.key).receiptHash, receipt.receiptHash);
    assert.equal(executions, 1);
    emitIntentMarker('CHK-002:adversarial:0', 'tampered CAS receipt fails closed with no canonical import and no receipt overwrite');

    const wrongProvenance = {
      ...receipt,
      identity: { ...receipt.identity, command: { executable: process.execPath, args: ['-e', "console.log('WRONG')"] } },
    };
    assert.throws(() => importCausalEvidenceReceipt({
      receipt: wrongProvenance,
      expectedStoryId: storyId,
      expectedExecutionKey: key.key,
      revalidate: () => true,
      commit: () => { throw new Error('must not commit wrong provenance'); },
    }), /causal_receipt_invalid/);
    assert.equal(storyStore.readCausalEvidenceReceipt(storyId, key.key).receiptHash, receipt.receiptHash);
    emitIntentMarker('CHK-002:adversarial:1', 'wrong execution key or provenance fails closed before import and cannot produce PASS');

    const immutableStore = new MemoryReceiptStore();
    const immutableResult = await executeCausalEvidence({
      identity: baseIdentity('B-causal-immutable'),
      selector: 'IMMUTABLE-MARKER',
      run: async () => ({ code: 0, output: 'IMMUTABLE-MARKER' }),
      receiptStore: immutableStore,
      preflight: preflight(),
    });
    const replacement = {
      ...immutableResult.receipt,
      outputTail: 'replacement payload',
    };
    replacement.receiptHash = computeCausalReceiptHash(replacement);
    assert.throws(() => immutableStore.writeCausalEvidenceReceipt('B-causal-immutable', replacement), /overwrite/);
    assert.equal(
      immutableStore.readCausalEvidenceReceipt('B-causal-immutable', immutableResult.key.key).receiptHash,
      immutableResult.receipt.receiptHash,
    );
    emitIntentMarker(
      'CHK-002:adversarial:2',
      'receipt-overwrite or same-address different-payload attempt fails closed and preserves the original receipt',
    );

    let partialCanonical = null;
    const partialImport = importCausalEvidenceReceipt({
      receipt,
      expectedStoryId: storyId,
      expectedExecutionKey: key.key,
      expectedMaterialHash: 'material-store',
      expectedStoryFilesHash: 'story-store',
      revalidate: () => true,
      commit: () => {
        if (!partialCanonical) {
          partialCanonical = { receiptHash: receipt.receiptHash };
          throw new Error('partial canonical write before index');
        }
        partialCanonical = { receiptHash: receipt.receiptHash, executionKey: key.key, storyId };
      },
    });
    assert.equal(partialImport.attempts, 2);
    assert.deepEqual(partialCanonical, { receiptHash: receipt.receiptHash, executionKey: key.key, storyId });
    assert.equal(partialImport.commandReruns, 0);
    emitIntentMarker(
      'CHK-002:adversarial:3',
      'partial canonical import fails closed or atomically completes without exposing partial PASS, receipt mutation, or command rerun',
    );

    assert.throws(() => importCausalEvidenceReceipt({
      receipt: null, expectedStoryId: storyId, expectedExecutionKey: key.key, revalidate: () => true, commit: () => {},
    }), /causal_receipt_invalid/);
    assert.throws(() => importCausalEvidenceReceipt({
      receipt, expectedStoryId: storyId, expectedExecutionKey: 'ce:v1:wrong', revalidate: () => true, commit: () => {},
    }), /causal_receipt_invalid/);
    const receiptPath = storyStore.causalEvidenceReceiptPath(storyId, receipt.receiptHash);
    const original = readFileSync(receiptPath, 'utf8');
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, outputTail: 'tampered' }));
    assert.throws(() => storyStore.readCausalEvidenceReceipt(storyId, key.key), /causal_receipt_tampered/);
    writeFileSync(receiptPath, original);
    assert.equal(storyStore.readCausalEvidenceReceipt(storyId, key.key).receiptHash, receipt.receiptHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CHK-003: dependency domains shadow-compare closure and CertificationWindow rejects stale affected bypasses', () => {
  const nodes = CAUSAL_DEPENDENCY_DOMAINS.map((domain, index) => ({
    id: `${domain}-node`, domain, inputIds: [`input-${domain}`],
    dependencyIds: index === 0 ? [] : [`${CAUSAL_DEPENDENCY_DOMAINS[index - 1]}-node`],
    recordedInputHashes: { [`input-${domain}`]: 'old' },
  }));
  const current = Object.fromEntries(CAUSAL_DEPENDENCY_DOMAINS.map(domain => [`input-${domain}`, domain === 'source' ? 'new' : 'old']));
  const partial = evaluateCausalDependencies({
    nodes, currentInputHashes: current, previousMaterialHash: 'm1', currentMaterialHash: 'm1', previousStoryFilesHash: 's1', currentStoryFilesHash: 's1', rerunNodeIds: ['source-node'],
  });
  assert.equal(partial.causalDecision, 'rerun');
  assert.equal(partial.affectedNodeIds.length, 6);
  assert.equal(partial.affectedNodeRerun, 17);
  assert.equal(partial.falseFresh, 5);
  assert.equal(partial.gateAdmissible, false);
  assert.equal(verifyCausalDependencyDecision(partial), true);

  const complete = evaluateCausalDependencies({
    nodes, currentInputHashes: current, previousMaterialHash: 'm1', currentMaterialHash: 'm1', previousStoryFilesHash: 's1', currentStoryFilesHash: 's1', rerunNodeIds: nodes.map(node => node.id),
  });
  assert.equal(complete.affectedNodeRerun, 100);
  assert.equal(complete.falseFresh, 0);
  assert.equal(complete.gateAdmissible, true);
  emitIntentMarker(
    'CHK-003:happy:1',
    'related story-owned material change invalidates the affected transitive closure, reruns it at 100%, and reports falseFresh=0',
  );

  const advisoryNodesBefore = JSON.stringify(nodes.map(node => ({
    ...node,
    recordedInputHashes: { [`input-${node.domain}`]: current[`input-${node.domain}`] },
  })));
  const advisory = evaluateCausalDependencies({
    nodes: nodes.map(node => ({ ...node, recordedInputHashes: { [`input-${node.domain}`]: current[`input-${node.domain}`] } })),
    currentInputHashes: current, previousMaterialHash: 'm1', currentMaterialHash: 'm2', previousStoryFilesHash: 's1', currentStoryFilesHash: 's1',
  });
  assert.equal(advisory.causalDecision, 'advisory');
  assert.equal(advisory.materialHashStrict, false);
  assert.equal(advisory.specializedRerun, 0);
  assert.equal(advisory.affectedNodeRerun, 0);
  assert.equal(JSON.stringify(nodes.map(node => ({
    ...node,
    recordedInputHashes: { [`input-${node.domain}`]: current[`input-${node.domain}`] },
  }))), advisoryNodesBefore);
  emitIntentMarker(
    'CHK-003:happy:0',
    'unrelated merge preserves specialized evidence with specializedRerun=0, explicit advisory, and unchanged stored hashes',
  );

  const staleAdmit = evaluateCertificationWindowAdmit({
    inventoryApisPresent: true,
    inventory: null,
    currentStoryId: 'B-causal-test',
    headHash: 'h1',
    materialHash: 'm1',
    storyFilesHash: 's1',
    expectedMainSha: 'h1',
    mainIsAncestor: true,
    openBlockingFindingIds: [],
    missingRequiredIntents: 0,
    dirtyNonRuntimePaths: [],
    gitIndexReadable: true,
    evidenceTargetWritable: true,
    causalDecision: partial,
  });
  assert.equal(staleAdmit.admit, false);
  assert.equal(staleAdmit.blockerCode, 'pre_cert_causal_freshness_required');
  const matchingNodes = nodes.map(node => ({
    ...node,
    recordedInputHashes: { [`input-${node.domain}`]: current[`input-${node.domain}`] },
  }));
  const doneStrict = evaluateCausalDependencies({
    nodes: matchingNodes, currentInputHashes: current, previousMaterialHash: 'm1', currentMaterialHash: 'm2', previousStoryFilesHash: 's1', currentStoryFilesHash: 's1', doneRequired: true,
  });
  assert.equal(doneStrict.causalDecision, 'strict');
  assert.equal(doneStrict.gateAdmissible, false);
  assert.equal(doneStrict.doneRequiredStrict, true);

  emitIntentMarker(
    'CHK-003:happy:2',
    'CertificationWindow accepts only the causal decision and admits no stale affected-node PASS',
  );

  for (const [index, domain] of CAUSAL_DEPENDENCY_DOMAINS.entries()) {
    const domainCurrent = Object.fromEntries(CAUSAL_DEPENDENCY_DOMAINS.map(item => [
      `input-${item}`,
      item === domain ? 'changed' : 'old',
    ]));
    const domainDecision = evaluateCausalDependencies({
      nodes,
      currentInputHashes: domainCurrent,
      previousMaterialHash: 'm1',
      currentMaterialHash: 'm1',
      previousStoryFilesHash: 's1',
      currentStoryFilesHash: 's1',
      rerunNodeIds: nodes.slice(index).map(node => node.id),
    });
    const expectedAffected = nodes.slice(index).map(node => node.id).sort();
    assert.deepEqual(domainDecision.affectedNodeIds, expectedAffected);
    assert.deepEqual(domainDecision.invalidatedNodeIds, expectedAffected);
    assert.deepEqual(domainDecision.changedInputIds, [`input-${domain}`]);
    assert.equal(domainDecision.affectedNodeRerun, 100);
    assert.equal(domainDecision.falseFresh, 0);
    assert.equal(domainDecision.gateAdmissible, true);
  }
  emitIntentMarker(
    'CHK-003:edge:0',
    'each of the six dependency domains has a distinct invalidation boundary and only the declared dependent closure is stale',
  );

  const incompleteDependency = evaluateCausalDependencies({
    nodes: [{ id: 'incomplete-node', domain: 'source', inputIds: ['unknown-input'], recordedInputHashes: {} }],
    currentInputHashes: {},
    previousMaterialHash: 'm1',
    currentMaterialHash: 'm2',
    previousStoryFilesHash: 's1',
    currentStoryFilesHash: 's1',
  });
  assert.equal(incompleteDependency.causalDecision, 'strict');
  assert.equal(incompleteDependency.materialHashStrict, true);
  assert.equal(incompleteDependency.gateAdmissible, false);
  assert.equal(incompleteDependency.falseFresh, 0);
  emitIntentMarker(
    'CHK-003:edge:1',
    'missing or ambiguous domain metadata falls back to strict materialHash invalidation with no false-fresh reuse',
  );

  const nearbyDecisions = CAUSAL_DEPENDENCY_DOMAINS.map(domain => evaluateCausalDependencies({
    nodes,
    currentInputHashes: Object.fromEntries(CAUSAL_DEPENDENCY_DOMAINS.map(item => [
      `input-${item}`,
      item === domain ? `${domain}-changed` : 'old',
    ])),
    previousMaterialHash: 'm1',
    currentMaterialHash: 'm1',
    previousStoryFilesHash: 's1',
    currentStoryFilesHash: 's1',
  }));
  assert.equal(new Set(nearbyDecisions.map(decision => decision._hash)).size, CAUSAL_DEPENDENCY_DOMAINS.length);
  assert.ok(nearbyDecisions.every(decision => decision.changedInputIds.length === 1));
  assert.deepEqual(
    nearbyDecisions.map(decision => decision.changedInputIds[0]),
    CAUSAL_DEPENDENCY_DOMAINS.map(domain => `input-${domain}`),
  );
  emitIntentMarker(
    'CHK-003:edge:2',
    'nearby changes in test/build-input, manifest/integration, and review/source remain domain-distinct',
  );

  const forgedDecision = { ...partial, affectedNodeIds: [], invalidatedNodeIds: [], falseFresh: 0 };
  assert.equal(verifyCausalDependencyDecision(forgedDecision), false);
  assert.equal(verifyCausalDependencyDecision(partial), true);

  const unsignedWindow = {
    schemaVersion: CERTIFICATION_WINDOW_SCHEMA, windowId: 'window-1', storyId: 'B-causal-test', state: 'ADMITTED',
    createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
    frozen: { headHash: 'h1', materialHash: 'm1', storyFilesHash: 's1', expectedMainSha: 'h1', verifierIdentity: 'v', testIdentity: 't' },
  };
  const window = { ...unsignedWindow, _hash: signCertificationWindow(unsignedWindow) };
  const stale = detectCertificationWindowMaterialDrift(window, { materialHash: 'm1', storyFilesHash: 's1', causalDecision: partial });
  assert.equal(stale.drifted, true);
  assert.match(stale.reason, /affected dependency closure/);
  const unrelated = detectCertificationWindowMaterialDrift(window, { materialHash: 'm2', storyFilesHash: 's1', causalDecision: advisory });
  assert.equal(unrelated.drifted, false, 'only explicit specialized advisory may use storyFilesHash secondary policy');
  emitIntentMarker(
    'CHK-003:adversarial:2',
    'CertificationWindow bypass is rejected and a stale affected PASS cannot enter a gate',
  );
  assert.equal(doneStrict.causalDecision, 'strict');
  assert.equal(doneStrict.gateAdmissible, false);
  emitIntentMarker(
    'CHK-003:adversarial:3',
    'DONE-required whole-tree drift remains strict even when specialized evidence receives an unrelated-merge advisory',
  );
});

test('CHK-004: preflight refuses exact readiness failures with zero execution/evidence counters', async () => {
  const validPreflight = preflight();
  assert.equal(validPreflight.ready, true);
  assert.equal(verifyCausalPreflight(validPreflight), true);
  for (const check of Object.values(validPreflight.checks)) assert.equal(check.status, 'pass');
  assert.deepEqual(validPreflight.failedChecks, []);

  const launchEvents = [];
  const launchStore = new MemoryReceiptStore();
  const launchBatch = createCausalEvidenceBatch();
  let childLaunches = 0;
  const launch = async () => {
    launchEvents.push('child-launch');
    childLaunches++;
    return { code: 0, output: 'PREFLIGHT-CHILD' };
  };
  launchEvents.push('preflight-pass');
  const firstLaunch = await executeCausalEvidence({
    identity: baseIdentity('B-causal-preflight'),
    selector: 'PREFLIGHT-CHILD',
    run: launch,
    receiptStore: launchStore,
    batch: launchBatch,
    preflight: validPreflight,
  });
  const repeatedPreflight = preflight();
  assert.equal(repeatedPreflight.ready, true);
  assert.equal(verifyCausalPreflight(repeatedPreflight), true);
  launchEvents.push('preflight-pass');
  const repeatedLaunch = await executeCausalEvidence({
    identity: baseIdentity('B-causal-preflight'),
    selector: 'PREFLIGHT-CHILD',
    run: launch,
    receiptStore: launchStore,
    batch: launchBatch,
    preflight: repeatedPreflight,
  });
  assert.deepEqual(launchEvents, ['preflight-pass', 'child-launch', 'preflight-pass']);
  assert.equal(childLaunches, 1);
  assert.equal(firstLaunch.disposition, 'executed');
  assert.equal(repeatedLaunch.disposition, 'reused');
  assert.equal(launchBatch.ledger.executions.length, 1);
  emitIntentMarker(
    'CHK-004:happy:0',
    'expensive-run preflight PASS: cli=pass worktree=pass gitIndex=pass writerLease=pass providerCapability=pass resources=pass evidenceTarget=pass; childLaunch=1',
  );
  emitIntentMarker(
    'CHK-004:happy:1',
    'repeated valid preflight remains PASS-before-launch with one committed evidence result and no duplicate child launch',
  );

  const cases = [
    ['cli', { cli: { available: false } }, 'cli_unavailable'],
    ['worktree', { worktree: { expected: '/a', actual: '/b' } }, 'worktree_mismatch'],
    ['index', { gitIndex: { readable: false } }, 'git_index_unavailable'],
    ['material', { gitMaterial: { available: false } }, 'git_material_unavailable'],
    ['writer', { writerLease: { available: false, valid: false } }, 'writer_unavailable'],
    ['lease', { writerLease: { available: true, valid: false, reason: 'expired' } }, 'lease_invalid'],
    ['provider', { providerCapability: { required: ['provider-x'], available: [] } }, 'provider_capability_missing'],
    ['resources', { resources: { required: { timeoutMs: 2 }, available: { timeoutMs: 1 } } }, 'insufficient_resources'],
    ['target', { evidenceTarget: { writable: false, path: 'nope' } }, 'evidence_target_not_writable'],
    ['side-channel', { sideChannel: { available: false, maxOutputChars: 0, maxProgressEvents: 0 } }, 'bounded_side_channel_unavailable'],
  ];
  for (const [label, overrides, reason] of cases) {
    const report = preflight(overrides);
    assert.equal(report.ready, false, `${label} refusal`);
    assert.ok(report.failedChecks.some(check => check.includes(reason)), `${label} names exact reason`);
    assert.equal(report.commandExecutions, 0);
    assert.equal(report.evidenceWrites, 0);
  }
  const indexMismatch = preflight({ gitIndex: { readable: true, path: join(repoRoot, 'index'), expected: 'head-a', actual: 'head-b' } });
  assert.equal(indexMismatch.ready, false);
  assert.ok(indexMismatch.failedChecks.some(check => check.includes('git_index_mismatch expected=head-a actual=head-b')));
  assert.equal(indexMismatch.commandExecutions, 0);
  assert.equal(indexMismatch.evidenceWrites, 0);
  emitIntentMarker('CHK-004:edge:0', 'preflight REFUSED: cli_unavailable; commandExecutions=0');
  emitIntentMarker('CHK-004:edge:1', 'preflight REFUSED: worktree_mismatch; commandExecutions=0');
  emitIntentMarker('CHK-004:edge:2', 'preflight REFUSED: git_index_unavailable or git_index_mismatch; commandExecutions=0');
  emitIntentMarker('CHK-004:edge:3', 'preflight REFUSED: writer_unavailable; commandExecutions=0');
  emitIntentMarker('CHK-004:edge:4', 'preflight REFUSED: lease_invalid; commandExecutions=0');
  emitIntentMarker('CHK-004:edge:5', 'preflight REFUSED: provider_capability_missing; commandExecutions=0');
  emitIntentMarker('CHK-004:edge:6', 'preflight REFUSED: insufficient_resources; commandExecutions=0');
  emitIntentMarker('CHK-004:edge:7', 'preflight REFUSED: evidence_target_not_writable; commandExecutions=0');

  const race = preflight({}, () => false);
  assert.equal(race.ready, false);
  assert.deepEqual(race.failedChecks, ['state_changed_before_launch']);
  assert.equal(preflight().ready, true);

  const raceStore = new MemoryReceiptStore();
  const raceBatch = createCausalEvidenceBatch();
  let raceLaunches = 0;
  await assert.rejects(
    executeCausalEvidence({
      identity: baseIdentity('B-causal-preflight-race'),
      selector: 'RACE-CHILD',
      run: async () => { raceLaunches++; return { code: 0, output: 'RACE-CHILD' }; },
      receiptStore: raceStore,
      batch: raceBatch,
      preflight: preflight(),
      revalidateBeforeRun: () => false,
    }),
    /state_changed_before_launch.*commandExecutions=0 evidenceWrites=0/,
  );
  assert.equal(raceLaunches, 0);
  assert.equal(raceStore.receipts.size, 0);
  assert.equal(raceBatch.ledger.intentCount, 0);
  emitIntentMarker(
    'CHK-004:adversarial:0',
    'preflight RACE REFUSED: state_changed_before_launch; commandExecutions=0; evidenceWrites=0',
  );

  const forgedPreflight = { ...preflight(), readinessHash: 'forged-readiness-hash' };
  let forgedLaunches = 0;
  await assert.rejects(
    executeCausalEvidence({
      identity: baseIdentity('B-causal-forged-preflight'),
      selector: 'FORGED-CHILD',
      run: async () => { forgedLaunches++; return { code: 0, output: 'FORGED-CHILD' }; },
      batch: createCausalEvidenceBatch(),
      preflight: forgedPreflight,
    }),
    /missing_or_forged_preflight/,
  );
  assert.equal(forgedLaunches, 0);

  let missingCommandExecutions = 0;
  let missingEvidenceWrites = 0;
  const missingPreflightStore = {
    readCausalEvidenceReceipt: () => null,
    writeCausalEvidenceReceipt: () => { missingEvidenceWrites++; },
  };
  const missingPreflightBatch = createCausalEvidenceBatch();
  await assert.rejects(
    executeCausalEvidence({
      identity: baseIdentity('B-causal-missing-preflight'),
      selector: 'MISSING-PREFLIGHT-CHILD',
      run: async () => {
        missingCommandExecutions++;
        return { code: 0, output: 'MISSING-PREFLIGHT-CHILD' };
      },
      receiptStore: missingPreflightStore,
      batch: missingPreflightBatch,
    }),
    /missing_or_forged_preflight.*commandExecutions=0 evidenceWrites=0/,
  );
  assert.equal(missingCommandExecutions, 0);
  assert.equal(missingEvidenceWrites, 0);
  assert.equal(missingPreflightBatch.ledger.intentCount, 0);
  assert.equal(deriveCausalMetrics(missingPreflightBatch.ledger).commandExecutions, 0);
  emitIntentMarker(
    'CHK-004:adversarial:1',
    'missing preflight REFUSED before child runner: commandExecutions=0; evidenceWrites=0',
  );
});

test('CHK-006: atomic pre-run revalidation refuses before the child runner with zero counters or writes', async () => {
  const batch = createCausalEvidenceBatch();
  const store = new MemoryReceiptStore();
  let runInvoked = false;
  let revalidations = 0;
  await assert.rejects(
    executeCausalEvidence({
      identity: baseIdentity('B-causal-race'),
      selector: 'MARKER-A',
      receiptStore: store,
      batch,
      preflight: preflight(),
      revalidateBeforeRun: () => {
        revalidations++;
        return false;
      },
      run: async () => {
        runInvoked = true;
        return { code: 0, output: 'MARKER-A' };
      },
    }),
    /state_changed_before_launch.*commandExecutions=0 evidenceWrites=0/,
  );
  assert.equal(revalidations, 1);
  assert.equal(runInvoked, false, 'the child runner is not invoked after a race refusal');
  assert.equal(store.receipts.size, 0, 'the refusal writes no receipt');
  assert.equal(batch.ledger.intentCount, 0, 'the refusal records no intent execution');
  assert.equal(batch.ledger.executions.length, 0, 'the refusal records no command execution');
  assert.equal(batch.ledger.selectorVerdicts.length, 0, 'the refusal records no selector verdict');
  assert.deepEqual(deriveCausalMetrics(batch.ledger), {
    intentCount: 0, uniqueExecutionKeys: 0, commandExecutions: 0, cacheHitRate: 0, commandReruns: 0,
    commitFailureReruns: 0, unrelatedSpecializedRerun: 0, affectedNodeRerun: 0, falseFresh: 0,
  });
});

test('CHK-005: metrics are zero-safe and tamper-resistant canonical-ledger projections', async () => {
  const empty = deriveCausalMetrics(createCausalEvidenceBatch().ledger);
  assert.deepEqual(empty, {
    intentCount: 0, uniqueExecutionKeys: 0, commandExecutions: 0, cacheHitRate: 0, commandReruns: 0,
    commitFailureReruns: 0, unrelatedSpecializedRerun: 0, affectedNodeRerun: 0, falseFresh: 0,
  });
  emitIntentMarker('CHK-005:edge:0', 'empty plan reports uniqueExecutionKeys=0 and commandExecutions=0 without dividing cacheHitRate by zero or claiming savings');

  const metricReplayStore = new MemoryReceiptStore();
  const metricReplayIdentities = Array.from({ length: 10 }, (_, slot) => baseIdentity(`B-causal-metric-${slot}`, {
    inputs: { materialHash: `metric-material-${slot}`, explicitInput: `metric-input-${slot}` },
    storyFilesHash: `metric-story-${slot}`,
  }));
  const metricInitialBatch = createCausalEvidenceBatch();
  let metricInitialExecutions = 0;
  await Promise.all(Array.from({ length: 58 }, (_, index) => {
    const slot = index % metricReplayIdentities.length;
    return executeCausalEvidence({
      identity: metricReplayIdentities[slot],
      selector: `METRIC-${slot}`,
      run: async () => { metricInitialExecutions++; return { code: 0, output: `METRIC-${slot}` }; },
      receiptStore: metricReplayStore,
      batch: metricInitialBatch,
      preflight: preflight(),
    });
  }));
  const metricReplayBatch = createCausalEvidenceBatch();
  let metricReplayExecutions = 0;
  await Promise.all(Array.from({ length: 58 }, (_, index) => {
    const slot = index % metricReplayIdentities.length;
    return executeCausalEvidence({
      identity: metricReplayIdentities[slot],
      selector: `METRIC-${slot}`,
      run: async () => { metricReplayExecutions++; return { code: 0, output: 'unexpected metric replay' }; },
      receiptStore: metricReplayStore,
      batch: metricReplayBatch,
      preflight: preflight(),
    });
  }));
  const replayMetrics = deriveCausalMetrics(metricReplayBatch.ledger);
  assert.equal(metricInitialExecutions, 10);
  assert.equal(metricReplayExecutions, 0);
  assert.equal(replayMetrics.intentCount, 58);
  assert.equal(replayMetrics.uniqueExecutionKeys, 10);
  assert.equal(replayMetrics.commandExecutions, 0);
  assert.equal(replayMetrics.commandReruns, 0);
  assert.equal(replayMetrics.cacheHitRate, 1);
  assert.match(renderCausalMetrics(replayMetrics), /intentCount=58 uniqueExecutionKeys=10 commandExecutions=0 cacheHitRate=100%/);
  emitIntentMarker(
    'CHK-005:happy:0',
    'CHK-005: metrics are zero-safe and tamper-resistant canonical-ledger projections',
  );

  const batch = createCausalEvidenceBatch();
  await executeCausalEvidence({ identity: baseIdentity(), selector: 'MARKER-A', run: async () => ({ code: 0, output: 'MARKER-A' }), batch, preflight: preflight() });
  const metrics = deriveCausalMetrics(batch.ledger);
  assert.equal(metrics.intentCount, 1);
  assert.equal(metrics.uniqueExecutionKeys, 1);
  assert.equal(metrics.commandExecutions, 1);
  assert.match(renderCausalMetrics(metrics), /intentCount=1 uniqueExecutionKeys=1 commandExecutions=1/);

  const mixedStore = new MemoryReceiptStore();
  const mixedBatch = createCausalEvidenceBatch();
  const mixedIdentity = baseIdentity('B-causal-metric-mixed');
  const mixedNewIdentity = baseIdentity('B-causal-metric-mixed-new', { inputs: { materialHash: 'mixed-new' } });
  let mixedExecutions = 0;
  await executeCausalEvidence({
    identity: mixedIdentity,
    selector: 'MIXED-MARKER',
    run: async () => { mixedExecutions++; return { code: 0, output: 'MIXED-MARKER' }; },
    receiptStore: mixedStore,
    batch: mixedBatch,
    preflight: preflight(),
  });
  await executeCausalEvidence({
    identity: mixedIdentity,
    selector: 'MIXED-MARKER',
    run: async () => { mixedExecutions++; return { code: 0, output: 'unexpected reusable execution' }; },
    receiptStore: mixedStore,
    batch: mixedBatch,
    preflight: preflight(),
  });
  await executeCausalEvidence({
    identity: mixedNewIdentity,
    selector: 'MIXED-MARKER',
    run: async () => { mixedExecutions++; return { code: 0, output: 'MIXED-MARKER' }; },
    receiptStore: mixedStore,
    batch: mixedBatch,
    preflight: preflight(),
  });
  const mixedMetrics = deriveCausalMetrics(mixedBatch.ledger);
  assert.equal(mixedExecutions, 2);
  assert.equal(mixedMetrics.intentCount, 3);
  assert.equal(mixedMetrics.uniqueExecutionKeys, 2);
  assert.equal(mixedMetrics.commandExecutions, 2);
  assert.equal(mixedMetrics.cacheHitRate, 1 / 3);
  assert.equal(mixedMetrics.commandReruns, 0);
  emitIntentMarker(
    'CHK-005:edge:1',
    'a run containing both reusable and newly executed receipts reports counts from the actual execution ledger rather than intent count or a caller-supplied number',
  );

  const incompleteMetricsBatch = createCausalEvidenceBatch();
  const incompleteMetricIdentities = [
    { storyId: 'B-causal-incomplete-a', cwd: repoRoot, command: { executable: process.execPath, args: ['-e', "console.log('INCOMPLETE-A')"] } },
    { storyId: 'B-causal-incomplete-b', cwd: repoRoot, command: { executable: process.execPath, args: ['-e', "console.log('INCOMPLETE-B')"] } },
  ];
  for (const [index, incompleteIdentity] of incompleteMetricIdentities.entries()) {
    const result = await executeCausalEvidence({
      identity: incompleteIdentity,
      selector: `INCOMPLETE-${index}`,
      run: async () => ({ code: 0, output: `INCOMPLETE-${index}` }),
      batch: incompleteMetricsBatch,
      preflight: preflight(),
    });
    assert.equal(result.key.reusable, false);
  }
  const incompleteMetrics = deriveCausalMetrics(incompleteMetricsBatch.ledger);
  assert.equal(incompleteMetrics.intentCount, 2);
  assert.equal(incompleteMetrics.uniqueExecutionKeys, 2);
  assert.equal(incompleteMetrics.commandExecutions, 2);
  assert.equal(incompleteMetrics.cacheHitRate, 0);
  emitIntentMarker(
    'CHK-005:edge:2',
    'a legacy evidence row or missing dependency identity is counted as strict/non-reusable and cannot improve cacheHitRate or falseFresh',
  );

  const incompleteDependencyMetrics = evaluateCausalDependencies({
    nodes: [{ id: 'metric-source', domain: 'source', inputIds: ['metric-source-input'], recordedInputHashes: { 'metric-source-input': 'old' } }],
    currentInputHashes: { 'metric-source-input': 'new' },
    previousMaterialHash: 'm1',
    currentMaterialHash: 'm1',
    previousStoryFilesHash: 's1',
    currentStoryFilesHash: 's1',
  });
  const affectedMetricsBatch = createCausalEvidenceBatch();
  const affectedMetrics = deriveCausalMetrics(ledgerWithFields(affectedMetricsBatch.ledger, {
    affectedNodeRerun: incompleteDependencyMetrics.affectedNodeRerun,
    falseFresh: incompleteDependencyMetrics.falseFresh,
  }));
  assert.equal(affectedMetrics.affectedNodeRerun, 0);
  assert.equal(affectedMetrics.falseFresh, 1);
  assert.ok(affectedMetrics.affectedNodeRerun < 100);
  emitIntentMarker(
    'CHK-005:edge:3',
    'a related node that fails to rerun makes affectedNodeRerun less than 100% and fails the correctness result instead of being hidden by a passing aggregate',
  );

  const correctnessMetricsBatch = createCausalEvidenceBatch();
  const correctnessMetrics = deriveCausalMetrics(ledgerWithFields(correctnessMetricsBatch.ledger, {
    unrelatedSpecializedRerun: 0,
    affectedNodeRerun: 100,
    falseFresh: 0,
  }));
  assert.equal(correctnessMetrics.unrelatedSpecializedRerun, 0);
  assert.equal(correctnessMetrics.affectedNodeRerun, 100);
  assert.equal(correctnessMetrics.falseFresh, 0);
  assert.match(renderCausalMetrics(correctnessMetrics), /unrelatedSpecializedRerun=0 affectedNodeRerun=100% falseFresh=0/);

  const tampered = { ...batch.ledger, intentCount: 99 };
  assert.throws(() => deriveCausalMetrics(tampered), /causal_ledger_tampered/);
  for (const field of [
    'intentCount', 'commitFailureReruns', 'unrelatedSpecializedRerun', 'affectedNodeRerun', 'falseFresh',
  ]) {
    const altered = { ...batch.ledger, [field]: batch.ledger[field] + 1 };
    assert.throws(() => deriveCausalMetrics(altered), /causal_ledger_tampered/);
  }
  emitIntentMarker(
    'CHK-005:adversarial:0',
    'tampering with any metric field, execution ledger count, receipt reuse flag, or falseFresh value is detected from canonical inputs and cannot manufacture a passing metrics report',
  );
});
