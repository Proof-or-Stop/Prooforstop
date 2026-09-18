import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const distRoot = join(repoRoot, 'packages', 'main', 'dist');
const causal = await import(pathToFileURL(join(distRoot, 'core/causal-evidence.js')).href);
const { StoryStore } = await import(pathToFileURL(join(distRoot, 'core/store.js')).href);
const { createVerifierHandlers } = await import(pathToFileURL(join(distRoot, 'handlers/verifier.js')).href);
const { acquireOwnerLease, releaseOwnerLease } = await import(pathToFileURL(join(distRoot, 'core/story-owner-lease.js')).href);
const {
  acceptanceRolloutHistoryDigest,
  deriveAcceptanceRolloutReport,
  verifyAcceptanceRolloutArtifact,
} = await import(pathToFileURL(join(distRoot, 'core/acceptance-rollout.js')).href);
const {
  detectCertificationWindowMaterialDrift,
  evaluateCertificationWindowAdmit,
  signCertificationWindow,
  verifyCertificationWindow,
  CERTIFICATION_WINDOW_SCHEMA,
  PRE_CERT_MATERIAL_DRIFT_REATTESTATION_ADVISORY,
  PRECERT_TEST_IDENTITY,
  PRECERT_VERIFIER_IDENTITY,
  setReviewInventoryAdmitApisForTest,
  persistSyntheticAdmittedWindowForTest,
  PRECERT_CHEAP_CHECK_AUTHORITY,
  PRECERT_CHEAP_CHECK_RECEIPT_SCHEMA,
  withSignedPrecertCheapCheckReceipt,
} = await import(
  pathToFileURL(join(distRoot, 'core/certification-window.js')).href,
);
const {
  buildCertificationDecision,
  createCertificationWindowHandlers,
  deriveCertificationDomainInputHashes,
} = await import(
  pathToFileURL(join(distRoot, 'handlers/certification-window.js')).href,
);
const { buildRoutineValidationIdentity } = await import(pathToFileURL(join(distRoot, 'core/validation-evidence-reuse.js')).href);

const {
  currentMaterialHash,
  currentStoryFilesHash,
} = await import(
  pathToFileURL(join(distRoot, 'core/evidence-freshness.js')).href,
);

const {
  CAUSAL_DEPENDENCY_DOMAINS,
  CAUSAL_MAX_OUTPUT_CHARS,
  CAUSAL_OUTPUT_TAIL_CHARS,
  CAUSAL_RECEIPT_INDEX_FILE,
  DEFAULT_CAUSAL_SELECTOR_POLICY,
  causalDigest,
  computeCausalReceiptHash,
  createCausalExecutionKey,
  createCausalEvidenceBatch,
  createCausalDependencyRerunEvidence,
  causalDependencyContextDigests,
  causalDependencyDecisionMatchesCurrentIdentity,
  causalDependencyExecutionInputs,
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

function runProofOrStopJson(command, args) {
  const output = execFileSync(
    process.execPath,
    ['bin/proof-or-stop.js', command, JSON.stringify(args)],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  assert.ok(start >= 0 && end >= start, `${command} did not return structured JSON: ${output}`);
  return JSON.parse(output.slice(start, end + 1));
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

function preflightFor(identity, overrides = {}, revalidate) {
  return preflightCausalEvidence({
    cli: { available: true, path: '/usr/bin/proof-or-stop' },
    worktree: { expected: repoRoot, actual: repoRoot },
    gitIndex: { readable: true, path: join(repoRoot, 'index'), expected: 'head-a', actual: 'head-a', contentDigest: 'sha256:test-index' },
    gitMaterial: { available: true, headHash: 'head-a', materialHash: 'material-a', storyFilesHash: 'story-a' },
    writerLease: { available: true, valid: true },
    providerCapability: { required: ['allowlisted-command', 'bounded-output'], available: ['allowlisted-command', 'bounded-output'] },
    resources: { required: { timeoutMs: 1000 }, available: { timeoutMs: 1000 } },
    evidenceTarget: { writable: true, path: 'B-causal-test/causal-evidence/' },
    sideChannel: { available: true, maxOutputChars: 12_000, maxProgressEvents: 10 },
    ...overrides,
  }, revalidate, identity);
}

function preflight(overrides = {}, revalidate) {
  return preflightFor(baseIdentity(), overrides, revalidate);
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
  assert.match(key.key, /^ce:v2:[0-9a-f]{64}$/);
  assert.match(key.identity.effectiveEnvironment.API_TOKEN, /^<redacted>:sha256:[0-9a-f]{64}$/);

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
    executeCausalEvidence({ identity, selector: 'MARKER-A', intentRef: 'CHK-001:happy:0', run, receiptStore: store, batch, preflight: preflightFor(identity), revalidateBeforeRun: () => true }),
    executeCausalEvidence({ identity, selector: 'MISSING', intentRef: 'CHK-001:edge:0', run, receiptStore: store, batch, preflight: preflightFor(identity), revalidateBeforeRun: () => true }),
    executeCausalEvidence({ identity, selector: 'MARKER-A', intentRef: 'CHK-001:adversarial:0', run, receiptStore: store, batch, preflight: preflightFor(identity), revalidateBeforeRun: () => true }),
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
    preflight: preflightFor(identity),
    revalidateBeforeRun: () => true,
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
      preflight: preflightFor(fanoutIdentities[slot]),
      revalidateBeforeRun: () => true,
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
      preflight: preflightFor(fanoutIdentities[slot]),
      revalidateBeforeRun: () => true,
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
    preflight: preflightFor(singleBatchIdentity),
    revalidateBeforeRun: () => true,
  });
  const singleBatch = createCausalEvidenceBatch();
  const batched = await executeCausalEvidence({
    identity: singleBatchIdentity,
    selector: 'MARKER-A',
    intentRef: 'CHK-001:single-batch',
    run: async () => { singleBatchExecutions++; return { code: 0, output: 'unexpected duplicate' }; },
    receiptStore: singleBatchStore,
    batch: singleBatch,
    preflight: preflightFor(singleBatchIdentity),
    revalidateBeforeRun: () => true,
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
    const mutationIdentity = baseIdentity(`B-causal-mutation-${label}`, change);
    const result = await executeCausalEvidence({
      identity: mutationIdentity,
      selector: 'MUTATION-MARKER',
      run: async () => { mutationExecutions++; return { code: 0, output: 'MUTATION-MARKER' }; },
      receiptStore: mutationStore,
      batch: mutationBatch,
      preflight: preflightFor(mutationIdentity),
      revalidateBeforeRun: () => true,
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
      preflight: preflightFor(identityForNearDuplicate),
      revalidateBeforeRun: () => true,
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
  const tamperIdentity = baseIdentity('B-causal-tamper');
  const tamperResult = await executeCausalEvidence({
    identity: tamperIdentity,
    selector: 'TAMPER-MARKER',
    run: async () => { tamperExecutions++; return { code: 0, output: 'TAMPER-MARKER' }; },
    receiptStore: tamperStore,
    batch: tamperBatch,
    preflight: preflightFor(tamperIdentity),
    revalidateBeforeRun: () => true,
  });
  tamperStore.receipts.set(
    `B-causal-tamper:${tamperResult.key.key}`,
    { ...tamperResult.receipt, outputTail: 'TAMPERED-OUTPUT' },
  );
  await assert.rejects(
    executeCausalEvidence({
      identity: tamperIdentity,
      selector: 'TAMPER-MARKER',
      run: async () => { tamperExecutions++; return { code: 0, output: 'unexpected' }; },
      receiptStore: tamperStore,
      preflight: preflightFor(tamperIdentity),
      revalidateBeforeRun: () => true,
    }),
    /causal_receipt_tampered/,
  );
  assert.equal(tamperExecutions, 1);
  assert.equal(tamperResult.verdict.result, 'pass');
  const oversizedTail = {
    ...tamperResult.receipt,
    outputTail: 'x'.repeat(CAUSAL_OUTPUT_TAIL_CHARS + 1),
  };
  oversizedTail.receiptHash = computeCausalReceiptHash(oversizedTail);
  assert.equal(
    verifyCausalEvidenceReceipt(oversizedTail, tamperResult.key.key),
    false,
    'a receipt exceeding the bounded output tail is rejected',
  );
  emitIntentMarker('CHK-001:adversarial:0', 'tampered CAS receipt is rejected and cannot produce PASS');

  const collisionStore = new MemoryReceiptStore();
  const collisionBatch = createCausalEvidenceBatch();
  let collisionExecutions = 0;
  const collisionIdentity = baseIdentity('B-causal-collision');
  const collisionResult = await executeCausalEvidence({
    identity: collisionIdentity,
    selector: 'COLLISION-MARKER',
    run: async () => { collisionExecutions++; return { code: 0, output: 'COLLISION-MARKER' }; },
    receiptStore: collisionStore,
    batch: collisionBatch,
    preflight: preflightFor(collisionIdentity),
    revalidateBeforeRun: () => true,
  });
  collisionStore.receipts.set(
    `B-causal-collision:${collisionResult.key.key}`,
    { ...collisionResult.receipt, identity: { ...collisionResult.receipt.identity, inputs: { materialHash: 'wrong' } } },
  );
  await assert.rejects(
    executeCausalEvidence({
      identity: collisionIdentity,
      selector: 'COLLISION-MARKER',
      run: async () => { collisionExecutions++; return { code: 0, output: 'wrong output' }; },
      receiptStore: collisionStore,
      preflight: preflightFor(collisionIdentity),
      revalidateBeforeRun: () => true,
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
    preflight: preflightFor(provenanceIdentity),
    revalidateBeforeRun: () => true,
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
    const variantIdentity = { ...provenanceIdentity, ...change };
    const variant = await executeCausalEvidence({
      identity: variantIdentity,
      selector: 'PROVENANCE-MARKER',
      run: async () => { provenanceExecutions++; return { code: 0, output: 'PROVENANCE-MARKER' }; },
      receiptStore: provenanceStore,
      preflight: preflightFor(variantIdentity),
      revalidateBeforeRun: () => true,
    });
    provenanceVariants.push(variant);
  }
  const selectorReplay = await executeCausalEvidence({
    identity: provenanceIdentity,
    selector: 'PROVENANCE-MISSING',
    run: async () => { provenanceExecutions++; return { code: 0, output: 'unexpected selector replay' }; },
    receiptStore: provenanceStore,
    preflight: preflightFor(provenanceIdentity),
    revalidateBeforeRun: () => true,
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
    executeCausalEvidence({ identity: incompleteIdentity, selector: 'MARKER-A', run: async () => { incompleteExecutions++; return { code: 0, output: 'MARKER-A' }; }, batch, preflight: preflightFor(incompleteIdentity), revalidateBeforeRun: () => true }),
    executeCausalEvidence({ identity: incompleteIdentity, selector: 'MARKER-A', run: async () => { incompleteExecutions++; return { code: 0, output: 'MARKER-A' }; }, batch, preflight: preflightFor(incompleteIdentity), revalidateBeforeRun: () => true }),
  ]);
  assert.equal(incompleteExecutions, 2, 'incomplete identities are never reused as PASS');
});

test('CHK-001: oversized output probes stay within the receipt verification bound', async () => {
  const root = mkdtempSync(join(tmpdir(), 'causal-output-probe-boundary-'));
  try {
    const identity = baseIdentity('B-causal-output-probe-boundary', { cwd: root });
    const store = new StoryStore(root);
    const output = 'x'.repeat(CAUSAL_MAX_OUTPUT_CHARS + 1);
    const run = async () => ({ code: 0, output });

    const first = await executeCausalEvidence({
      identity,
      selector: 'BOUNDARY-PASS',
      intentRef: 'CHK-001:edge:oversized-output-probe',
      run,
      receiptStore: store,
      batch: createCausalEvidenceBatch(),
      preflight: preflightFor(identity),
      revalidateBeforeRun: () => true,
    });
    assert.equal(first.receipt.outputLength, CAUSAL_MAX_OUTPUT_CHARS + 1);
    assert.equal(first.receipt.outputProbe.length, CAUSAL_MAX_OUTPUT_CHARS);
    assert.equal(first.receipt.outputProbe.includes('<causal-output-gap>'), true);
    assert.equal(first.receipt.reusable, true);
    assert.equal(verifyCausalEvidenceReceipt(first.receipt, first.key.key), true);
    assert.equal(store.readCausalSelectorOutput(identity.storyId, first.receipt.selectorOutput.digest), output,
      'oversized reusable execution retains the complete selector output in the real store');

    const second = await executeCausalEvidence({
      identity,
      selector: 'BOUNDARY-PASS',
      intentRef: 'CHK-001:edge:oversized-output-probe-reuse',
      run: async () => ({ code: 0, output: 'must-not-rerun' }),
      receiptStore: store,
      batch: createCausalEvidenceBatch(),
      preflight: preflightFor(identity),
      revalidateBeforeRun: () => true,
    });
    assert.equal(second.disposition, 'reused');
    assert.equal(second.receipt.receiptHash, first.receipt.receiptHash);
    emitIntentMarker('CHK-001:edge:oversized-output-probe', 'bounded oversized output probe verifies and reuses');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B-5a15 F-007: non-PASS outcomes never occupy a reusable receipt key or batch cache', async () => {
  const outcomes = [
    ['fail', { code: 1, output: 'FAIL-ONCE' }],
    ['timeout', { code: 124, output: 'TIMEOUT-ONCE', timedOut: true }],
    ['cancelled', { code: 1, output: 'CANCELLED-ONCE', cancelled: true }],
    ['partial', { code: 0, output: 'PARTIAL-ONCE', partial: true }],
  ];
  for (const [label, firstOutcome] of outcomes) {
    const storyId = `B-causal-nonpass-${label}`;
    const store = new MemoryReceiptStore();
    const batch = createCausalEvidenceBatch();
    const identity = baseIdentity(storyId);
    let executions = 0;
    const run = async () => {
      executions++;
      return executions === 1 ? firstOutcome : { code: 0, output: `PASS-AFTER-${label}` };
    };
    const first = await executeCausalEvidence({ identity, selector: `PASS-AFTER-${label}`, run, receiptStore: store, batch, preflight: preflightFor(identity), revalidateBeforeRun: () => true });
    assert.equal(first.receipt.status, label);
    assert.equal(first.receipt.reusable, false);
    assert.equal(verifyCausalEvidenceReceipt(first.receipt, first.key.key), true);
    assert.equal(store.receipts.size, 0, `${label} must not be persisted as a reusable CAS value`);

    const second = await executeCausalEvidence({ identity, selector: `PASS-AFTER-${label}`, run, receiptStore: store, batch, preflight: preflightFor(identity), revalidateBeforeRun: () => true });
    assert.equal(second.receipt.status, 'pass');
    assert.equal(second.receipt.reusable, true);
    assert.equal(second.disposition, 'executed');
    assert.equal(executions, 2, `${label} must allow a later PASS for the same execution key`);
  }
});

test('B-5a15 F-011: raw secret environment values are absent from persisted receipt output', async () => {
  const secret = 'bare-secret-value-123456';
  const store = new MemoryReceiptStore();
  const identity = baseIdentity('B-causal-redaction', { effectiveEnvironment: { API_TOKEN: secret, NODE_ENV: 'test' } });
  const result = await executeCausalEvidence({
    identity,
    selector: 'command-output',
    run: async () => ({ code: 0, output: `command-output ${secret}` }),
    receiptStore: store,
    preflight: preflightFor(identity),
    revalidateBeforeRun: () => true,
  });
  assert.equal(result.receipt.reusable, true);
  assert.equal(result.receipt.outputTail.includes(secret), false);
  assert.equal(result.receipt.outputProbe.includes(secret), false);
  assert.equal(JSON.stringify(result.receipt).includes(secret), false);
  assert.match(result.receipt.outputTail, /<redacted>/);
});

test('B-5a15 F-298/F-300/F-301: long non-secret selector values remain observable in receipt output', async () => {
  const selector = 'VALID-BEHAVIOR-SELECTOR-123456';
  const store = new MemoryReceiptStore();
  const identity = baseIdentity('B-causal-selector-redaction', {
    effectiveEnvironment: { NODE_ENV: 'test', CAUSAL_SELECTOR: selector },
  });
  const result = await executeCausalEvidence({
    identity,
    selector,
    run: async () => ({ code: 0, output: `selected=${selector}` }),
    receiptStore: store,
    preflight: preflightFor(identity),
    revalidateBeforeRun: () => true,
  });

  assert.equal(result.verdict.result, 'pass');
  assert.equal(result.receipt.outputTail.includes(selector), true);
  assert.equal(result.receipt.outputProbe.includes(selector), true);
  assert.equal(result.receipt.outputTail.includes('<redacted>'), false);
});

test('B-5a15 F-298/F-300/F-301: secret-named and token-like output remains redacted', async () => {
  const selector = 'VALID-BEHAVIOR-SELECTOR-654321';
  const secret = 'secret-output-value-123456';
  const store = new MemoryReceiptStore();
  const identity = baseIdentity('B-causal-selector-secret-redaction', {
    effectiveEnvironment: { NODE_ENV: 'test', CAUSAL_SELECTOR: selector, API_TOKEN: secret },
  });
  const result = await executeCausalEvidence({
    identity,
    selector,
    run: async () => ({
      code: 0,
      output: `selected=${selector} API_TOKEN=${secret} authorization=${secret}`,
    }),
    receiptStore: store,
    preflight: preflightFor(identity),
    revalidateBeforeRun: () => true,
  });

  assert.equal(result.verdict.result, 'pass');
  assert.equal(result.receipt.outputProbe.includes(selector), true);
  assert.equal(result.receipt.outputProbe.includes(secret), false);
  assert.match(result.receipt.outputProbe, /API_TOKEN=<redacted>/);
  assert.match(result.receipt.outputProbe, /authorization=<redacted>/i);
});

test('B-5a15 F-047: secret environment mutations split execution receipts without leaking credentials', async () => {
  const firstSecret = 'credential-alpha-123456789';
  const secondSecret = 'credential-beta-987654321';
  const store = new MemoryReceiptStore();
  const firstIdentity = baseIdentity('B-causal-secret-mutation', {
    effectiveEnvironment: { NODE_ENV: 'test', API_TOKEN: firstSecret },
  });
  const secondIdentity = {
    ...firstIdentity,
    effectiveEnvironment: { NODE_ENV: 'test', API_TOKEN: secondSecret },
  };
  const firstKey = createCausalExecutionKey(firstIdentity);
  const secondKey = createCausalExecutionKey(secondIdentity);

  assert.notEqual(firstKey.key, secondKey.key, 'credential changes must change the execution key');
  assert.notEqual(
    firstKey.identity.effectiveEnvironment.API_TOKEN,
    secondKey.identity.effectiveEnvironment.API_TOKEN,
    'credential identity components must be value-specific',
  );
  assert.equal(firstKey.identity.effectiveEnvironment.API_TOKEN.includes(firstSecret), false);
  assert.equal(secondKey.identity.effectiveEnvironment.API_TOKEN.includes(secondSecret), false);

  let executions = 0;
  const first = await executeCausalEvidence({
    identity: firstIdentity,
    selector: 'SECRET-MUTATION-A',
    run: async () => {
      executions++;
      return { code: 0, output: `SECRET-MUTATION-A API_TOKEN=${firstSecret}` };
    },
    receiptStore: store,
    preflight: preflightFor(firstIdentity),
    revalidateBeforeRun: () => true,
  });
  const second = await executeCausalEvidence({
    identity: secondIdentity,
    selector: 'SECRET-MUTATION-B',
    run: async () => {
      executions++;
      return { code: 0, output: `SECRET-MUTATION-B API_TOKEN=${secondSecret}` };
    },
    receiptStore: store,
    preflight: preflightFor(secondIdentity),
    revalidateBeforeRun: () => true,
  });

  assert.equal(executions, 2, 'different credentials must not reuse one receipt');
  assert.equal(first.disposition, 'executed');
  assert.equal(second.disposition, 'executed');
  assert.notEqual(first.receipt.executionKey, second.receipt.executionKey);
  assert.notEqual(first.receipt.receiptHash, second.receipt.receiptHash);
  for (const [receipt, secret] of [[first.receipt, firstSecret], [second.receipt, secondSecret]]) {
    assert.equal(receipt.outputTail.includes(secret), false);
    assert.equal(receipt.outputProbe.includes(secret), false);
    assert.equal(JSON.stringify(receipt).includes(secret), false);
    assert.equal(verifyCausalEvidenceReceipt(receipt, receipt.executionKey), true);
  }
});

test('B-5a15 F-267/F-273/F-274: non-transport SESSION-like environment mutations split execution receipts', () => {
  const base = baseIdentity('B-5a15-session-like-environment', {
    effectiveEnvironment: {
      NODE_ENV: 'test',
      APP_SESSION: 'alpha',
      SESSION_MODE: 'safe',
    },
  });
  const appSessionChanged = createCausalExecutionKey({
    ...base,
    effectiveEnvironment: { ...base.effectiveEnvironment, APP_SESSION: 'beta' },
  });
  const sessionModeChanged = createCausalExecutionKey({
    ...base,
    effectiveEnvironment: { ...base.effectiveEnvironment, SESSION_MODE: 'unsafe' },
  });

  assert.notEqual(appSessionChanged.key, createCausalExecutionKey(base).key);
  assert.notEqual(sessionModeChanged.key, createCausalExecutionKey(base).key);
  assert.match(appSessionChanged.identity.effectiveEnvironment.APP_SESSION, /^<redacted>:sha256:[0-9a-f]{64}$/);
  assert.match(sessionModeChanged.identity.effectiveEnvironment.SESSION_MODE, /^<redacted>:sha256:[0-9a-f]{64}$/);
  emitIntentMarker(
    'CHK-001:adversarial:session-like-environment',
    'only explicit transport keys are removed; behavior-affecting APP_SESSION and SESSION_MODE values remain bound to causal execution identity',
  );
});

test('CHK-002: CAS receipts precede isolated import, retry commit only, and fail closed on tamper', async () => {
  const root = mkdtempSync(join(tmpdir(), 'causal-evidence-store-'));
  try {
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
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
      preflight: preflightFor(identity),
      revalidateBeforeRun: () => true,
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
    const immutableIdentity = baseIdentity('B-causal-immutable');
    const immutableResult = await executeCausalEvidence({
      identity: immutableIdentity,
      selector: 'IMMUTABLE-MARKER',
      run: async () => ({ code: 0, output: 'IMMUTABLE-MARKER' }),
      receiptStore: immutableStore,
      preflight: preflightFor(immutableIdentity),
      revalidateBeforeRun: () => true,
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
      receipt, expectedStoryId: storyId, expectedExecutionKey: 'ce:v2:wrong', revalidate: () => true, commit: () => {},
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

test('B-5a15: an injected index-write failure recovers the orphaned receipt without relaunching', async () => {
  const root = mkdtempSync(join(tmpdir(), 'causal-evidence-index-recovery-'));
  try {
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
    }));
    const storyStore = new StoryStore(root);
    const originalWriteJsonFile = storyStore.writeJsonFile.bind(storyStore);
    // Exhaust both bounded persistence attempts; the runner must still launch once.
    let remainingIndexWriteFailures = 2;
    let writeAttempts = 0;
    storyStore.writeJsonFile = (filePath, data) => {
      if (remainingIndexWriteFailures > 0 && filePath.endsWith(CAUSAL_RECEIPT_INDEX_FILE)) {
        remainingIndexWriteFailures--;
        throw new Error('injected causal-evidence index write failure');
      }
      return originalWriteJsonFile(filePath, data);
    };

    const persistedReceipts = [];
    const store = {
      readCausalEvidenceReceipt: (...args) => storyStore.readCausalEvidenceReceipt(...args),
      writeCausalEvidenceReceipt: (...args) => {
        writeAttempts++;
        if (!persistedReceipts.some(receipt => receipt.receiptHash === args[1].receiptHash)) persistedReceipts.push(args[1]);
        return storyStore.writeCausalEvidenceReceipt(...args);
      },
    };
    const storyId = 'B-causal-index-recovery';
    const identity = { ...baseIdentity(storyId), cwd: root, inputs: { materialHash: 'material-index-recovery' }, storyFilesHash: 'story-index-recovery' };
    const key = createCausalExecutionKey(identity).key;
    const preflight = preflightFor(identity);
    let launches = 0;

    await assert.rejects(
      executeCausalEvidence({
        identity,
        selector: 'INDEX-RECOVERY-MARKER',
        run: async () => { launches++; return { code: 0, output: 'INDEX-RECOVERY-MARKER' }; },
        receiptStore: store,
        preflight,
        revalidateBeforeRun: () => true,
      }),
      /injected causal-evidence index write failure/,
    );
    assert.equal(launches, 1);
    assert.equal(persistedReceipts.length, 1);
    assert.equal(writeAttempts, 2, 'retry publication of the same immutable receipt without rerunning');
    assert.equal(remainingIndexWriteFailures, 0);
    const orphanedReceipt = persistedReceipts[0];
    assert.equal(
      readFileSync(storyStore.causalEvidenceReceiptPath(storyId, orphanedReceipt.receiptHash), 'utf8').length > 0,
      true,
      'the receipt remains durable when its index write fails',
    );

    const retry = await executeCausalEvidence({
      identity,
      selector: 'INDEX-RECOVERY-MARKER',
      run: async () => { launches++; return { code: 0, output: 'unexpected duplicate launch' }; },
      receiptStore: store,
      preflight,
      revalidateBeforeRun: () => true,
    });
    assert.equal(retry.disposition, 'reused');
    assert.equal(launches, 1, 'retry reuses the orphaned receipt instead of launching again');
    assert.equal(retry.receipt.receiptHash, orphanedReceipt.receiptHash);
    assert.equal(verifyCausalEvidenceReceipt(retry.receipt, key), true);
    assert.equal(storyStore.readCausalEvidenceReceipt(storyId, key).receiptHash, orphanedReceipt.receiptHash);

    const index = JSON.parse(readFileSync(
      join(root, '.proof-or-stop/story/actives', storyId, CAUSAL_RECEIPT_INDEX_FILE),
      'utf8',
    ));
    assert.equal(index.receipts[key], orphanedReceipt.receiptHash, 'retry repairs the missing index entry');
    assert.equal(persistedReceipts.length, 1, 'recovery does not write a second receipt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CHK-003: dependency domains shadow-compare closure and CertificationWindow rejects stale affected bypasses', async () => {
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
  assert.equal(partial.affectedNodeRerun, 0, 'caller-supplied rerunNodeIds are not execution evidence');
  assert.equal(partial.falseFresh, 6);
  assert.equal(partial.gateAdmissible, false);
  assert.equal(verifyCausalDependencyDecision(partial), true);

  const complete = evaluateCausalDependencies({
    nodes, currentInputHashes: current, previousMaterialHash: 'm1', currentMaterialHash: 'm1', previousStoryFilesHash: 's1', currentStoryFilesHash: 's1', rerunNodeIds: nodes.map(node => node.id),
  });
  assert.equal(complete.affectedNodeRerun, 0, 'caller-supplied rerunNodeIds cannot manufacture a complete rerun');
  assert.equal(complete.falseFresh, 6);
  assert.equal(complete.gateAdmissible, false);
  emitIntentMarker(
    'CHK-003:happy:1',
    'related story-owned material change invalidates the affected transitive closure and ignores unsigned rerun assertions',
  );

  const advisoryNodesBefore = JSON.stringify(nodes.map(node => ({
    ...node,
    recordedInputHashes: { [`input-${node.domain}`]: current[`input-${node.domain}`] },
  })));
  const advisory = evaluateCausalDependencies({
    nodes: nodes.map(node => ({ ...node, recordedInputHashes: { [`input-${node.domain}`]: current[`input-${node.domain}`] } })),
    currentInputHashes: current, previousMaterialHash: 'm1', currentMaterialHash: 'm2', previousStoryFilesHash: 's1', currentStoryFilesHash: 's1', previousHeadHash: 'h1', currentHeadHash: 'h2',
  });
  assert.equal(advisory.causalDecision, 'advisory');
  assert.equal(advisory.materialHashStrict, false);
  assert.equal(advisory.specializedRerun, 0);
  assert.equal(advisory.affectedNodeRerun, 0);
  assert.equal(verifyCausalDependencyDecision(advisory), true, 'F-002 current identity-bound advisory remains valid at its issuing identity');
  assert.deepEqual(advisory.identityBinding, {
    previousMaterialHash: 'm1',
    currentMaterialHash: 'm2',
    previousStoryFilesHash: 's1',
    currentStoryFilesHash: 's1',
    previousHeadHash: 'h1',
    currentHeadHash: 'h2',
  });
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
  const storyFilesDrift = evaluateCausalDependencies({
    nodes: matchingNodes,
    currentInputHashes: current,
    previousMaterialHash: 'm1',
    currentMaterialHash: 'm1',
    previousStoryFilesHash: 's1',
    currentStoryFilesHash: 's2',
  });
  assert.equal(storyFilesDrift.causalDecision, 'strict');
  assert.equal(storyFilesDrift.gateAdmissible, false, 'storyFilesHash-only drift is never fresh');
  assert.match(storyFilesDrift.reason, /storyFilesHash changed/);
  emitIntentMarker(
    'CHK-003:adversarial:4',
    'storyFilesHash-only drift refuses a fresh decision even when material and dependency inputs are unchanged',
  );
  const boundDecision = evaluateCausalDependencies({
    storyId: 'B-causal-bound',
    nodes: matchingNodes,
    currentInputHashes: current,
    previousMaterialHash: 'm1',
    currentMaterialHash: 'm1',
    previousStoryFilesHash: 's1',
    currentStoryFilesHash: 's1',
  });
  const boundDigests = causalDependencyContextDigests(matchingNodes, current);
  assert.equal(verifyCausalDependencyDecision(boundDecision), true);
  assert.equal(causalDependencyDecisionMatchesCurrentIdentity(boundDecision, {
    storyId: 'B-causal-bound',
    materialHash: 'm1',
    storyFilesHash: 's1',
    dependencyGraphDigest: boundDigests.dependencyGraphDigest,
    currentInputHashesDigest: boundDigests.currentInputHashesDigest,
  }), true);
  assert.equal(causalDependencyDecisionMatchesCurrentIdentity(boundDecision, {
    storyId: 'B-causal-other-story',
    materialHash: 'm1',
    storyFilesHash: 's1',
    dependencyGraphDigest: boundDigests.dependencyGraphDigest,
    currentInputHashesDigest: boundDigests.currentInputHashesDigest,
  }), false, 'a decision cannot cross story identities');
  const alteredGraph = matchingNodes.map(node => node.id === 'source-node'
    ? { ...node, inputIds: ['input-source', 'input-extra'] }
    : node);
  const alteredDigests = causalDependencyContextDigests(alteredGraph, current);
  assert.notEqual(alteredDigests.dependencyGraphDigest, boundDigests.dependencyGraphDigest);
  assert.equal(causalDependencyDecisionMatchesCurrentIdentity(boundDecision, {
    storyId: 'B-causal-bound',
    materialHash: 'm1',
    storyFilesHash: 's1',
    dependencyGraphDigest: alteredDigests.dependencyGraphDigest,
    currentInputHashesDigest: boundDigests.currentInputHashesDigest,
  }), false, 'a decision cannot cross dependency graph identities');
  emitIntentMarker(
    'CHK-003:adversarial:5',
    'story and dependency graph identity mismatches refuse a signed causal decision',
  );
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
    assert.equal(domainDecision.affectedNodeRerun, 0);
    assert.equal(domainDecision.falseFresh, expectedAffected.length);
    assert.equal(domainDecision.gateAdmissible, false);
  }
  emitIntentMarker(
    'CHK-003:edge:0',
    'each of the six dependency domains has a distinct invalidation boundary and only the declared dependent closure is stale',
  );

  // B-5a15 F-325 regression: the loop above builds its OWN linear node graph, so it
  // validates the closure ALGORITHM but says nothing about the graph the PRODUCTION
  // certification path actually declares. buildCertificationDecision previously chained
  // the domains by array declaration order, so a test-only change invalidated four
  // unrelated domains and this suite stayed green. Assert the real production edges.
  const productionClosureFor = domain => {
    const inputIds = CAUSAL_DEPENDENCY_DOMAINS.map(item => `certification:${item}`);
    const identity = (mutated) => ({
      headHash: 'h1',
      materialHash: 'm1',
      storyFilesHash: 's1',
      causalInputHashes: Object.fromEntries(inputIds.map(id => [
        id,
        mutated && id === `certification:${domain}` ? 'new' : 'old',
      ])),
    });
    const decision = buildCertificationDecision('B-f325-regression', identity(true), {
      ...identity(false),
      expectedMainSha: 'h1',
      verifierIdentity: undefined,
      testIdentity: undefined,
    });
    return (decision?.affectedNodeIds ?? [])
      .map(id => id.replace('certification-', ''))
      .sort();
  };
  // B-5a15 (second F-337, DEFERRED): `test` is asserted terminal here because that is what the
  // CURRENT graph declares -- but it is NOT actually terminal. Seven source-domain files hold
  // compile-time imports of ten test-domain modules (handlers/gap.ts:17 imports
  // ../tasks/gap-analyze.js, and registry.ts:206 registers it into the shipped CLI), so a
  // src/tasks/ edit leaves certification-source falsely fresh. The edge is not declared because
  // adding it naively creates the cycle source -> test -> source; the real fix is splitting
  // src/tasks/ library modules from *-smoke.ts executables, which is a dedicated story.
  // This assertion therefore pins CURRENT BEHAVIOR, not desired behavior: when that story lands
  // it MUST change. Recorded so the gap is tracked rather than silently frozen.
  assert.deepEqual(productionClosureFor('test'), ['test'],
    'current graph declares test terminal; see the deferred source<-test finding above');
  // B-5a15 F-336: docs are NOT inert for integration. scripts/ holds contract verifiers that
  // read docs as load-bearing assertion inputs -- verify-process-fact-contract.mjs asserts over
  // AGENTS.md and five docs/requirements/decisions/*.md files and is DONE-required via
  // test:serial-reference -- so a docs-only edit must invalidate the integration domain.
  // Asserting ['review-subject'] here would freeze an UNDER-invalidation false-fresh.
  assert.deepEqual(productionClosureFor('review-subject'), ['integration', 'review-subject', 'test'],
    'a docs-only change must invalidate integration, whose script verifiers read those docs, and test through it');
  // B-5a15 F-337: integration is NOT terminal. 24 test-domain files execute integration
  // artifacts (codex-heartbeat-timeout-smoke.ts:273 runs bin/proof-or-stop.js), so a bin/
  // change must invalidate test; otherwise causalRerunComplete admits the gate while the
  // test node still holds evidence earned against the OLD bin.
  assert.deepEqual(productionClosureFor('integration'), ['integration', 'test'],
    'integration artifacts invalidate the tests that execute them');
  assert.deepEqual(productionClosureFor('manifest-semantic'), ['integration', 'manifest-semantic', 'test'],
    'host adapter manifests invalidate the integration entrypoints that consume them, and test through them');
  assert.deepEqual(productionClosureFor('source'), ['integration', 'source', 'test'],
    'source invalidates what compiles or runs against it, and must NOT invalidate build-input');
  assert.deepEqual(productionClosureFor('build-input'), ['build-input', 'integration', 'manifest-semantic', 'source', 'test'],
    'build inputs invalidate every compiled domain but not the terminal review subject');
  assert.equal(
    new Set(CAUSAL_DEPENDENCY_DOMAINS.map(domain => productionClosureFor(domain).join(','))).size,
    CAUSAL_DEPENDENCY_DOMAINS.length,
    'every production domain keeps a distinct invalidation boundary',
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
  for (const materialIdentity of [
    { previousMaterialHash: undefined, currentMaterialHash: 'm1' },
    { previousMaterialHash: 'm1', currentMaterialHash: undefined },
    { previousMaterialHash: '', currentMaterialHash: 'm1' },
  ]) {
    const missingMaterial = evaluateCausalDependencies({
      nodes: [],
      currentInputHashes: {},
      ...materialIdentity,
      previousStoryFilesHash: 's1',
      currentStoryFilesHash: 's1',
    });
    assert.equal(missingMaterial.causalDecision, 'strict');
    assert.equal(missingMaterial.gateAdmissible, false);
    assert.match(missingMaterial.reason, /material identity is missing or uncomputable/);
  }
  emitIntentMarker(
    'CHK-003:edge:1',
    'missing or ambiguous domain/material identity falls back to strict invalidation with no false-fresh reuse',
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

  const forgedDomainNodes = nodes.map((node, index) => index === 0
    ? { ...node, inputIds: ['omitted-story-owned-input'], recordedInputHashes: {} }
    : node);
  const forgedDomainDecision = evaluateCausalDependencies({
    nodes: forgedDomainNodes,
    currentInputHashes: { ...current, 'omitted-story-owned-input': 'new' },
    previousMaterialHash: 'm1',
    currentMaterialHash: 'm2',
    previousStoryFilesHash: 's1',
    currentStoryFilesHash: 's1',
    rerunNodeIds: forgedDomainNodes.map(node => node.id),
  });
  assert.equal(forgedDomainDecision.causalDecision, 'strict');
  assert.equal(forgedDomainDecision.materialHashStrict, true);
  assert.equal(forgedDomainDecision.gateAdmissible, false);
  assert.equal(forgedDomainDecision.falseFresh, 0);
  emitIntentMarker(
    'CHK-003:adversarial:0',
    'forged or omitted dependency hashes are rejected by shadow compare and cannot create a fresh gate PASS',
  );

  const immutableDependencyDecision = { ...partial };
  const rewrittenDependencyDecision = {
    ...immutableDependencyDecision,
    changedInputIds: [],
  };
  assert.equal(verifyCausalDependencyDecision(rewrittenDependencyDecision), false);
  assert.equal(verifyCausalDependencyDecision(immutableDependencyDecision), true);
  const immutableReceiptStore = new MemoryReceiptStore();
  const immutableReceiptIdentity = baseIdentity('B-causal-dependency-immutable');
  const immutableReceiptResult = await executeCausalEvidence({
    identity: immutableReceiptIdentity,
    selector: 'DEPENDENCY-IMMUTABLE',
    run: async () => ({ code: 0, output: 'DEPENDENCY-IMMUTABLE' }),
    receiptStore: immutableReceiptStore,
    preflight: preflightFor(immutableReceiptIdentity),
    revalidateBeforeRun: () => true,
  });
  const rewrittenReceipt = {
    ...immutableReceiptResult.receipt,
    identity: { ...immutableReceiptResult.receipt.identity, storyFilesHash: 'rewritten-story' },
  };
  rewrittenReceipt.receiptHash = computeCausalReceiptHash(rewrittenReceipt);
  assert.throws(
    () => immutableReceiptStore.writeCausalEvidenceReceipt('B-causal-dependency-immutable', rewrittenReceipt),
    /overwrite/,
  );
  assert.equal(
    immutableReceiptStore.readCausalEvidenceReceipt('B-causal-dependency-immutable', immutableReceiptResult.key.key).receiptHash,
    immutableReceiptResult.receipt.receiptHash,
  );
  assert.equal(verifyCausalEvidenceReceipt(immutableReceiptResult.receipt, immutableReceiptResult.key.key), true);
  emitIntentMarker(
    'CHK-003:adversarial:1',
    'content-addressed dependency and receipt provenance rewrite is rejected and original hashes remain stable',
  );

  const unsignedWindow = {
    schemaVersion: CERTIFICATION_WINDOW_SCHEMA, windowId: 'window-1', storyId: 'B-causal-test', state: 'ADMITTED',
    createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
    frozen: { headHash: 'h1', materialHash: 'm1', storyFilesHash: 's1', expectedMainSha: 'h1', verifierIdentity: 'v', testIdentity: 't' },
  };
  const window = { ...unsignedWindow, _hash: signCertificationWindow(unsignedWindow) };
  const stale = detectCertificationWindowMaterialDrift(window, { materialHash: 'm1', storyFilesHash: 's1', causalDecision: partial });
  assert.equal(stale.drifted, true);
  assert.match(stale.reason, /affected dependency closure/);
  const unrelated = detectCertificationWindowMaterialDrift(window, { materialHash: 'm2', storyFilesHash: 's1', headHash: 'h2', causalDecision: advisory });
  assert.equal(unrelated.drifted, false, 'only explicit specialized advisory may use storyFilesHash secondary policy');
  const laterMaterial = detectCertificationWindowMaterialDrift(window, { materialHash: 'm3', storyFilesHash: 's1', headHash: 'h3', causalDecision: advisory });
  assert.equal(laterMaterial.drifted, true, 'an advisory bound to m2 must not bypass a later live m3 material change');
  assert.match(laterMaterial.reason, /causal advisory binding|materialHash/);

  const officialUnsigned = {
    ...unsignedWindow,
    frozen: {
      ...unsignedWindow.frozen,
      verifierIdentity: PRECERT_VERIFIER_IDENTITY,
      testIdentity: PRECERT_TEST_IDENTITY,
    },
  };
  const officialWindow = { ...officialUnsigned, _hash: signCertificationWindow(officialUnsigned) };
  const officialAdvisory = detectCertificationWindowMaterialDrift(officialWindow, {
    materialHash: 'm2',
    storyFilesHash: 's1',
    headHash: 'h2',
    verifierIdentity: PRECERT_VERIFIER_IDENTITY,
    testIdentity: PRECERT_TEST_IDENTITY,
    causalDecision: advisory,
  });
  assert.equal(officialAdvisory.drifted, false, 'matching official identities keep the unrelated-drift advisory');
  assert.equal(officialAdvisory.advisory?.code, PRE_CERT_MATERIAL_DRIFT_REATTESTATION_ADVISORY);
  const officialIdentityDrift = detectCertificationWindowMaterialDrift(officialWindow, {
    materialHash: 'm2',
    storyFilesHash: 's1',
    headHash: 'h2',
    verifierIdentity: 'mutated-verifier',
    testIdentity: PRECERT_TEST_IDENTITY,
    causalDecision: advisory,
  });
  assert.equal(officialIdentityDrift.drifted, true, 'unrelated-material advisory must not skip official identity invalidation');
  assert.match(String(officialIdentityDrift.reason), /verifier identity/);
  const officialTestIdentityDrift = detectCertificationWindowMaterialDrift(officialWindow, {
    materialHash: 'm2',
    storyFilesHash: 's1',
    headHash: 'h2',
    verifierIdentity: PRECERT_VERIFIER_IDENTITY,
    testIdentity: 'mutated-test',
    causalDecision: advisory,
  });
  assert.equal(officialTestIdentityDrift.drifted, true, 'unrelated-material advisory must not skip official test-identity invalidation');
  assert.match(String(officialTestIdentityDrift.reason), /test identity/);

  const completedRerunNode = {
    id: 'source-node',
    domain: 'source',
    inputIds: ['input-source'],
    recordedInputHashes: { 'input-source': 'old' },
  };
  const completedRerunInputs = { 'input-source': 'new' };
  const completedRerunEvaluationIdentity = {
    storyId: 'B-causal-completed-rerun',
    materialHash: 'm1',
    storyFilesHash: 's1',
    headHash: 'h1',
  };
  const completedRerunIdentity = baseIdentity('B-causal-completed-rerun', {
    storyFilesHash: 's1',
    inputs: causalDependencyExecutionInputs(completedRerunNode.id, completedRerunInputs, completedRerunEvaluationIdentity),
  });
  const completedRerunStore = new MemoryReceiptStore();
  const completedRerunExecution = await executeCausalEvidence({
    identity: completedRerunIdentity,
    selector: 'COMPLETED-RERUN',
    run: async () => ({ code: 0, output: 'COMPLETED-RERUN' }),
    receiptStore: completedRerunStore,
    preflight: preflightFor(completedRerunIdentity),
    revalidateBeforeRun: () => true,
  });
  const completedPreviousMismatch = evaluateCausalDependencies({
    storyId: 'B-causal-completed-rerun',
    nodes: [completedRerunNode],
    currentInputHashes: completedRerunInputs,
    previousMaterialHash: 'm0',
    currentMaterialHash: 'm1',
    previousStoryFilesHash: 's1',
    currentStoryFilesHash: 's1',
    previousHeadHash: 'h0',
    currentHeadHash: 'h1',
    rerunEvidence: [createCausalDependencyRerunEvidence(completedRerunNode.id, completedRerunExecution.receipt)],
  });
  assert.equal(completedPreviousMismatch.causalDecision, 'rerun');
  assert.equal(completedPreviousMismatch.gateAdmissible, true);
  const previousSnapshotMismatch = detectCertificationWindowMaterialDrift(window, {
    materialHash: 'm1',
    storyFilesHash: 's1',
    headHash: 'h1',
    causalDecision: completedPreviousMismatch,
  });
  assert.equal(previousSnapshotMismatch.drifted, true, 'completed rerun from a different frozen snapshot must invalidate');
  assert.match(String(previousSnapshotMismatch.reason), /previous binding/);

  const completedCurrentMismatch = evaluateCausalDependencies({
    storyId: 'B-causal-completed-rerun',
    nodes: [completedRerunNode],
    currentInputHashes: completedRerunInputs,
    previousMaterialHash: 'm1',
    currentMaterialHash: 'm2',
    previousStoryFilesHash: 's1',
    currentStoryFilesHash: 's1',
    previousHeadHash: 'h1',
    currentHeadHash: 'h2',
    rerunEvidence: [createCausalDependencyRerunEvidence(completedRerunNode.id, completedRerunExecution.receipt)],
  });
  const currentSnapshotMismatch = detectCertificationWindowMaterialDrift(window, {
    materialHash: 'm1',
    storyFilesHash: 's1',
    headHash: 'h1',
    causalDecision: completedCurrentMismatch,
  });
  assert.equal(currentSnapshotMismatch.drifted, true, 'completed rerun with a different current snapshot must invalidate');
  assert.match(String(currentSnapshotMismatch.reason), /current binding|affected dependency closure/);
  assert.equal(evaluateCertificationWindowAdmit({
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
    causalDecision: completedCurrentMismatch,
  }).admit, false, 'admission must reject a completed rerun bound to another current snapshot');
  const { _hash: _forgedHash, ...forgedAdvisoryPayload } = advisory;
  const forgedAdvisory = {
    ...advisory,
    storyFilesHashAdvisory: false,
    _hash: causalDigest({ ...forgedAdvisoryPayload, storyFilesHashAdvisory: false }),
  };
  assert.equal(verifyCausalDependencyDecision(forgedAdvisory), false, 'recomputing the content hash cannot create an authority-bound decision');
  const forgedAdvisoryDrift = detectCertificationWindowMaterialDrift(window, {
    materialHash: 'm3', storyFilesHash: 's1', headHash: 'h3', causalDecision: forgedAdvisory,
  });
  assert.equal(forgedAdvisoryDrift.drifted, true);
  assert.match(forgedAdvisoryDrift.reason, /tampered/);
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

test('B-5a15 F-314: production domain inputs invalidate only the declared transitive closure', () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'causal-production-domain-inputs-'));
  const savedCwd = process.cwd();
  const git = (args) => execFileSync('git', args, { cwd: repositoryRoot, stdio: 'ignore' });
  try {
    mkdirSync(join(repositoryRoot, 'packages', 'main', 'tests'), { recursive: true });
    writeFileSync(join(repositoryRoot, 'packages', 'main', 'tests', 'domain-input.test.mjs'), 'export const version = 1;\n');
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'B-5a15 causal-evidence test']);
    git(['config', 'user.email', 'b5a15-causal-evidence@example.test']);
    git(['add', '.']);
    git(['commit', '-m', 'seed production causal domain input']);

    const frozenInputHashes = deriveCertificationDomainInputHashes(repositoryRoot, 'HEAD', repositoryRoot);
    assert.ok(frozenInputHashes, 'production derivation returns a complete domain map at the frozen snapshot');

    git(['switch', '-c', 'story/causal-domain-test']);
    writeFileSync(join(repositoryRoot, 'packages', 'main', 'tests', 'domain-input.test.mjs'), 'export const version = 2;\n');
    git(['add', '.']);
    git(['commit', '-m', 'mutate only the test causal domain']);
    process.chdir(repositoryRoot);

    const currentInputHashes = deriveCertificationDomainInputHashes(repositoryRoot, 'HEAD', repositoryRoot);
    assert.ok(currentInputHashes, 'production derivation returns current domain inputs');
    const currentHeadHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
    const current = {
      storyId: 'B-causal-production-domain',
      headHash: currentHeadHash,
      materialHash: 'material-current',
      storyFilesHash: 'story-current',
      causalInputHashes: currentInputHashes,
    };
    const frozen = {
      headHash: execFileSync('git', ['rev-parse', 'main'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
      materialHash: 'material-frozen',
      storyFilesHash: 'story-frozen',
      causalInputHashes: frozenInputHashes,
      expectedMainSha: currentHeadHash,
      verifierIdentity: 'proof-or-stop:done_required_validate',
      testIdentity: 'npm test',
    };
    const decision = buildCertificationDecision(current.storyId, current, frozen);
    assert.ok(decision);
    assert.deepEqual(decision.changedInputIds, ['certification:test']);
    // B-5a15 F-325: this previously expected FIVE nodes for a test-only change --
    // build-input, integration, manifest-semantic, review-subject and test -- which
    // contradicted this very test's own title. The old production graph chained the
    // domains by array declaration order, so changing a test file was treated as
    // invalidating lockfiles and docs. With real causal edges, a test-only change
    // invalidates only the test domain: nothing is built or derived from tests.
    assert.deepEqual(decision.affectedNodeIds, ['certification-test']);
    assert.equal(decision.affectedNodeIds.includes('certification-source'), false);
    assert.equal(decision.causalDecision, 'rerun');
    assert.equal(decision.gateAdmissible, false);
  } finally {
    process.chdir(savedCwd);
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('B-5a15 F-318/F-320: CertificationWindow handlers preserve advisory drift and invalidate changed test domains', async () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'causal-certification-handler-'));
  const storyId = 'B-5a15-certification-handler';
  const git = (args) => execFileSync('git', args, { cwd: repositoryRoot, stdio: 'ignore' });
  try {
    writeFileSync(join(repositoryRoot, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      validate: { commands: [{ label: 'fast', command: process.execPath, args: ['--version'], timeoutMs: 15000, focus: ['fast'] }] },
    }) + '\n');
    mkdirSync(join(repositoryRoot, 'packages', 'main', 'tests'), { recursive: true });
    writeFileSync(join(repositoryRoot, 'README.md'), 'certification handler regression\n');
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'B-5a15 certification handler test']);
    git(['config', 'user.email', 'b5a15-certification-handler@example.test']);
    git(['add', '.']);
    git(['commit', '-m', 'seed certification handler repository']);

    git(['switch', '-c', 'story/certification-handler']);
    const domainFile = join(repositoryRoot, 'packages', 'main', 'tests', 'domain-input.test.mjs');
    writeFileSync(domainFile, 'export const version = 1;\n');
    git(['add', 'packages/main/tests/domain-input.test.mjs']);
    git(['commit', '-m', 'add story-owned test domain']);

    const store = new StoryStore(repositoryRoot);
    const now = new Date().toISOString();
    store.writeStory(storyId, {
      storyId,
      name: 'certification-handler-regression',
      title: 'Certification handler regression',
      description: 'Production handler mutation regression for CertificationWindow.',
      type: 'feature',
      phase: 'DEV',
      priority: 'high',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [],
    });
    store.writeChecklist(storyId, { items: [] });

    acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: repositoryRoot });
    const fastResult = JSON.parse(await createVerifierHandlers({ store, root: repositoryRoot,
      scanRoot: join(repositoryRoot, 'packages/main') }).validate({ story: storyId, focus: 'fast', json: true }));
    assert.equal(fastResult.status, 'pass', 'actual fast validation must precede admission');
    assert.ok(fastResult.precertCheapCheckReceipt, 'canonical fast command must issue the admission receipt');
    const headHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
    const materialHash = currentMaterialHash(repositoryRoot, 'HEAD', repositoryRoot);
    const storyFilesHash = currentStoryFilesHash(repositoryRoot, 'HEAD', repositoryRoot);
    assert.ok(materialHash && storyFilesHash);
    setReviewInventoryAdmitApisForTest({
      finalizedUnconsumedReviewInventory: () => ({
        epoch: {
          epochId: 'B-5a15:RI-handler',
          storyId,
          reviewRound: 'handler-round',
          state: 'FINALIZED',
          receiptId: 'B-5a15:INV-handler',
          requiredLanes: ['test-reviewer'],
          waves: [{ lanes: [{ lane: 'test-reviewer', terminal: 'pass', evidenceIds: ['test-pass'], coverageDigest: 'coverage' }],
            newVerifiedFindingCount: 0, criticDigest: 'critic', saturated: true }],
          cutoff: { headHash, materialHash, storyFilesHash },
        },
        receipt: {
          receiptId: 'B-5a15:INV-handler',
          storyId,
          reviewRound: 'handler-round',
          epochId: 'B-5a15:RI-handler',
          requiredLanes: ['test-reviewer'], waveCount: 1,
          saturationResult: 'ZERO_NEW_VERIFIED_FINDINGS',
          scopeDigest: 'scope', findingSetDigest: 'findings', coverageDigest: 'coverage',
          authority: 'inventory-completeness-only',
          authorizesTest: false,
          cutoff: { headHash, materialHash, storyFilesHash },
        },
      }),
      // Inventory is the declared fixture seam; the fast command and window
      // signatures are real, but this is not signed-inventory integration proof.
      verifyReviewInventoryEpoch: () => true,
      verifyReviewInventoryReceipt: () => true,
      isInventoryCompletenessOnlyReceipt: () => false,
      consumeReviewInventoryCompletenessReceipt: (_store, _story, _round, _cutoff, recheck) => {
        recheck?.(); return 'B-5a15:INV-handler';
      },
    });
    const handlers = createCertificationWindowHandlers({
      store,
      root: repositoryRoot,
      scanRoot: join(repositoryRoot, 'packages', 'main'),
    });

    assert.match(handlers.certification_window_begin({ storyId }), /^State: ADMITTED$/m);
    const admitted = store.readCertificationWindows(storyId).windows.at(-1);
    assert.ok(admitted?.frozen?.causalInputHashes);
    assert.equal(verifyCertificationWindow(admitted), true, 'begin persists a signed production window');

    git(['switch', 'main']);
    writeFileSync(join(repositoryRoot, 'unrelated-main-change.txt'), 'unrelated material\n');
    git(['add', 'unrelated-main-change.txt']);
    git(['commit', '-m', 'unrelated main material change']);
    git(['switch', 'story/certification-handler']);
    git(['merge', 'main', '--no-edit']);

    const advisoryStatus = handlers.certification_window_status({ storyId });
    assert.match(advisoryStatus, /^State: ADMITTED$/m);
    assert.match(advisoryStatus, new RegExp(`^Warning: \\[${PRE_CERT_MATERIAL_DRIFT_REATTESTATION_ADVISORY}\\] `, 'm'));
    const afterUnrelated = store.readCertificationWindows(storyId).windows.at(-1);
    assert.equal(afterUnrelated?.state, 'ADMITTED', 'unrelated whole-tree drift keeps specialized evidence admitted');
    assert.equal(afterUnrelated?.frozen?.materialHash, materialHash, 'advisory does not rewrite the frozen hash');
    assert.notEqual(currentMaterialHash(repositoryRoot, 'HEAD', repositoryRoot), materialHash);
    assert.equal(currentStoryFilesHash(repositoryRoot, 'HEAD', repositoryRoot), storyFilesHash);

    writeFileSync(domainFile, 'export const version = 2;\n');
    git(['add', 'packages/main/tests/domain-input.test.mjs']);
    git(['commit', '-m', 'mutate story-owned test domain']);
    const invalidatedStatus = handlers.certification_window_status({ storyId });
    assert.match(invalidatedStatus, /^State: INVALIDATED$/m);
    const invalidated = store.readCertificationWindows(storyId).windows.at(-1);
    assert.equal(invalidated?.state, 'INVALIDATED');
    assert.equal(invalidated?.invalidation?.blockerCode, 'pre_cert_window_invalidated');
    assert.equal(verifyCertificationWindow(invalidated), true, 'status persists a signed invalidated window');
    const currentInputHashes = deriveCertificationDomainInputHashes(repositoryRoot, 'HEAD', repositoryRoot);
    assert.ok(currentInputHashes);
    assert.equal(
      invalidated?.frozen?.causalInputHashes?.['certification:source'],
      currentInputHashes['certification:source'],
      'unaffected source domain remains fresh in the frozen production window',
    );
    assert.notEqual(
      invalidated?.frozen?.causalInputHashes?.['certification:test'],
      currentInputHashes['certification:test'],
      'changed test domain is represented as stale in the frozen production window',
    );
  } finally {
    setReviewInventoryAdmitApisForTest(undefined);
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('B-5a15: causal rerun receipts bind the current story and snapshot identity', async () => {
  const node = {
    id: 'source-node',
    domain: 'source',
    inputIds: ['input-source'],
    recordedInputHashes: { 'input-source': 'old' },
  };
  const currentInputHashes = { 'input-source': 'new' };
  const evaluationIdentity = {
    storyId: 'B-causal-rerun-bound',
    materialHash: 'material-current',
    storyFilesHash: 'story-files-current',
    headHash: 'head-current',
  };
  const identity = baseIdentity(evaluationIdentity.storyId, {
    storyFilesHash: evaluationIdentity.storyFilesHash,
    inputs: causalDependencyExecutionInputs(node.id, currentInputHashes, evaluationIdentity),
  });
  const store = new MemoryReceiptStore();
  const execution = await executeCausalEvidence({
    identity,
    selector: 'CAUSAL-RERUN-BOUND',
    run: async () => ({ code: 0, output: 'CAUSAL-RERUN-BOUND' }),
    receiptStore: store,
    preflight: preflightFor(identity),
    revalidateBeforeRun: () => true,
  });
  const baseEvaluation = {
    storyId: evaluationIdentity.storyId,
    nodes: [node],
    currentInputHashes,
    previousMaterialHash: 'material-previous',
    currentMaterialHash: evaluationIdentity.materialHash,
    previousStoryFilesHash: 'story-files-previous',
    currentStoryFilesHash: evaluationIdentity.storyFilesHash,
    previousHeadHash: 'head-previous',
    currentHeadHash: evaluationIdentity.headHash,
    rerunEvidence: [createCausalDependencyRerunEvidence(node.id, execution.receipt)],
  };
  const matching = evaluateCausalDependencies(baseEvaluation);
  assert.deepEqual(matching.verifiedRerunNodeIds, [node.id]);
  assert.equal(matching.affectedNodeRerun, 100);
  assert.equal(matching.gateAdmissible, true, 'matching signed story/snapshot identity completes the rerun');

  for (const [field, value] of [
    ['storyId', 'B-causal-other-story'],
    ['currentMaterialHash', 'material-other'],
    ['currentStoryFilesHash', 'story-files-other'],
    ['currentHeadHash', 'head-other'],
  ]) {
    const mismatched = evaluateCausalDependencies({ ...baseEvaluation, [field]: value });
    assert.deepEqual(mismatched.verifiedRerunNodeIds, [], `${field} mismatch cannot verify the rerun receipt`);
    assert.equal(mismatched.affectedNodeRerun, 0, `${field} mismatch cannot count rerun completion`);
    assert.equal(mismatched.gateAdmissible, false, `${field} mismatch cannot admit the causal gate`);
  }

  const unboundIdentity = baseIdentity(evaluationIdentity.storyId, {
    storyFilesHash: evaluationIdentity.storyFilesHash,
    inputs: causalDependencyExecutionInputs(node.id, currentInputHashes),
  });
  const unboundExecution = await executeCausalEvidence({
    identity: unboundIdentity,
    selector: 'CAUSAL-RERUN-UNBOUND',
    run: async () => ({ code: 0, output: 'CAUSAL-RERUN-UNBOUND' }),
    receiptStore: store,
    preflight: preflightFor(unboundIdentity),
    revalidateBeforeRun: () => true,
  });
  const unbound = evaluateCausalDependencies({
    ...baseEvaluation,
    rerunEvidence: [createCausalDependencyRerunEvidence(node.id, unboundExecution.receipt)],
  });
  assert.deepEqual(unbound.verifiedRerunNodeIds, [], 'an unsigned-in-context legacy dependency input cannot complete a rerun');
  assert.equal(unbound.gateAdmissible, false);
});

test('B-5a15: a dependency decision remains verifiable across linked worktrees', () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'causal-dependency-worktree-'));
  const savedCwd = process.cwd();
  const linkedWorktree = join(repositoryRoot, 'verify-worktree');
  try {
    execFileSync('git', ['init'], { cwd: repositoryRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Causal Evidence Test'], { cwd: repositoryRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'causal-evidence-test@example.com'], { cwd: repositoryRoot, stdio: 'ignore' });
    writeFileSync(join(repositoryRoot, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', 'seed.txt'], { cwd: repositoryRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: repositoryRoot, stdio: 'ignore' });
    execFileSync('git', ['branch', 'verify'], { cwd: repositoryRoot, stdio: 'ignore' });
    execFileSync('git', ['worktree', 'add', linkedWorktree, 'verify'], { cwd: repositoryRoot, stdio: 'ignore' });

    process.chdir(repositoryRoot);
    const decision = evaluateCausalDependencies({
      nodes: [],
      currentInputHashes: {},
      previousMaterialHash: 'material-a',
      currentMaterialHash: 'material-a',
      previousStoryFilesHash: 'story-a',
      currentStoryFilesHash: 'story-a',
    });
    assert.equal(verifyCausalDependencyDecision(decision), true, 'the issuing worktree verifies its signed decision');

    process.chdir(linkedWorktree);
    assert.equal(
      verifyCausalDependencyDecision(decision),
      true,
      'a changed linked worktree resolves the same stable authority context',
    );
  } finally {
    process.chdir(savedCwd);
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('CHK-004: preflight refuses exact readiness failures with zero execution/evidence counters', async () => {
  const preflightIdentity = baseIdentity('B-causal-preflight');
  const validPreflight = preflightFor(preflightIdentity);
  assert.equal(validPreflight.ready, true);
  assert.equal(verifyCausalPreflight(validPreflight), true);
  const incompletePreflightPayload = { ...validPreflight, checks: {}, failedChecks: [] };
  const incompletePreflight = {
    ...incompletePreflightPayload,
    readinessHash: causalDigest(incompletePreflightPayload),
  };
  assert.equal(verifyCausalPreflight(incompletePreflight), false, 'an empty checks map remains invalid after readinessHash recomputation');
  const failedChecks = { ...validPreflight.checks, cli: { status: 'fail', reason: 'forged_cli_failure' } };
  const failedPreflightPayload = { ...validPreflight, checks: failedChecks, failedChecks: [] };
  const failedPreflight = { ...failedPreflightPayload, readinessHash: causalDigest(failedPreflightPayload) };
  assert.equal(verifyCausalPreflight(failedPreflight), false, 'a failed check cannot be made ready by clearing failedChecks and recomputing readinessHash');
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
    identity: preflightIdentity,
    selector: 'PREFLIGHT-CHILD',
    run: launch,
    receiptStore: launchStore,
    batch: launchBatch,
    preflight: validPreflight,
    revalidateBeforeRun: () => true,
  });
  const repeatedPreflight = preflightFor(preflightIdentity);
  assert.equal(repeatedPreflight.ready, true);
  assert.equal(verifyCausalPreflight(repeatedPreflight), true);
  launchEvents.push('preflight-pass');
  const repeatedLaunch = await executeCausalEvidence({
    identity: preflightIdentity,
    selector: 'PREFLIGHT-CHILD',
    run: launch,
    receiptStore: launchStore,
    batch: launchBatch,
    preflight: repeatedPreflight,
    revalidateBeforeRun: () => true,
  });
  assert.deepEqual(launchEvents, ['preflight-pass', 'child-launch', 'preflight-pass']);
  assert.equal(childLaunches, 1);
  assert.equal(firstLaunch.disposition, 'executed');
  assert.equal(repeatedLaunch.disposition, 'reused');
  assert.equal(launchBatch.ledger.executions.length, 1);
  const missingRevalidationIdentity = baseIdentity('B-causal-missing-revalidation');
  const selfRehashedPreflight = preflightFor(missingRevalidationIdentity);
  assert.equal(verifyCausalPreflight(selfRehashedPreflight), true);
  const missingRevalidationStore = new MemoryReceiptStore();
  const missingRevalidationBatch = createCausalEvidenceBatch();
  let missingRevalidationLaunches = 0;
  await assert.rejects(
    executeCausalEvidence({
      identity: missingRevalidationIdentity,
      selector: 'MISSING-REVALIDATION-CHILD',
      run: async () => {
        missingRevalidationLaunches++;
        return { code: 0, output: 'MISSING-REVALIDATION-CHILD' };
      },
      receiptStore: missingRevalidationStore,
      batch: missingRevalidationBatch,
      preflight: selfRehashedPreflight,
    }),
    /missing_last_moment_revalidation.*commandExecutions=0 evidenceWrites=0/,
  );
  assert.equal(selfRehashedPreflight.commandExecutions, 0);
  assert.equal(selfRehashedPreflight.evidenceWrites, 0);
  assert.equal(missingRevalidationLaunches, 0);
  assert.equal(missingRevalidationStore.receipts.size, 0);
  assert.equal(missingRevalidationBatch.ledger.intentCount, 0);
  assert.equal(missingRevalidationBatch.ledger.executions.length, 0);
  assert.equal(deriveCausalMetrics(missingRevalidationBatch.ledger).commandExecutions, 0);
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
  const indexMismatch = preflight({ gitIndex: { readable: true, path: join(repoRoot, 'index'), expected: 'head-a', actual: 'head-b', contentDigest: 'sha256:test-index' } });
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
  const raceIdentity = baseIdentity('B-causal-preflight-race');
  await assert.rejects(
    executeCausalEvidence({
      identity: raceIdentity,
      selector: 'RACE-CHILD',
      run: async () => { raceLaunches++; return { code: 0, output: 'RACE-CHILD' }; },
      receiptStore: raceStore,
      batch: raceBatch,
      preflight: preflightFor(raceIdentity),
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

  const forgedIdentity = baseIdentity('B-causal-forged-preflight');
  const forgedPreflight = { ...preflightFor(forgedIdentity), readinessHash: 'forged-readiness-hash' };
  let forgedLaunches = 0;
  await assert.rejects(
    executeCausalEvidence({
      identity: forgedIdentity,
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
  const missingPreflightIdentity = baseIdentity('B-causal-missing-preflight');
  await assert.rejects(
    executeCausalEvidence({
      identity: missingPreflightIdentity,
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

  const unrelatedIdentity = baseIdentity('B-causal-unrelated-preflight');
  const launchIdentity = baseIdentity('B-causal-bound-launch');
  let unrelatedLaunches = 0;
  await assert.rejects(
    executeCausalEvidence({
      identity: launchIdentity,
      selector: 'UNRELATED-PREFLIGHT-CHILD',
      run: async () => { unrelatedLaunches++; return { code: 0, output: 'UNRELATED-PREFLIGHT-CHILD' }; },
      batch: createCausalEvidenceBatch(),
      preflight: preflightFor(unrelatedIdentity),
      revalidateBeforeRun: () => true,
    }),
    /missing_or_forged_preflight.*causal_preflight_invalid/,
  );
  assert.equal(unrelatedLaunches, 0);

  const boundIdentity = baseIdentity('B-causal-preflight-identity-bound');
  const mismatchedIdentities = [
    ['command', { command: { executable: process.execPath, args: ['-e', "console.log('DIFFERENT-COMMAND')"] } }],
    ['story', { storyId: 'B-causal-preflight-different-story' }],
    ['cwd', { cwd: tmpdir() }],
    ['inputs', { inputs: { materialHash: 'different-material', explicitInput: 'a' } }],
    ['selector policy', { selectorPolicy: { ...DEFAULT_CAUSAL_SELECTOR_POLICY, matcher: 'different' } }],
  ];
  for (const [label, overrides] of mismatchedIdentities) {
    const report = preflightFor(boundIdentity);
    const currentIdentity = { ...boundIdentity, ...overrides };
    const store = new MemoryReceiptStore();
    const batch = createCausalEvidenceBatch();
    let launches = 0;
    let writes = 0;
    const writeTrackingStore = {
      readCausalEvidenceReceipt: store.readCausalEvidenceReceipt.bind(store),
      writeCausalEvidenceReceipt: (...args) => {
        writes++;
        return store.writeCausalEvidenceReceipt(...args);
      },
    };
    await assert.rejects(
      executeCausalEvidence({
        identity: currentIdentity,
        selector: `MISMATCHED-${label}`,
        run: async () => {
          launches++;
          return { code: 0, output: `MISMATCHED-${label}` };
        },
        receiptStore: writeTrackingStore,
        batch,
        preflight: report,
        revalidateBeforeRun: () => true,
      }),
      /missing_or_forged_preflight.*commandExecutions=0 evidenceWrites=0/,
      `${label} mismatch refuses before execution`,
    );
    assert.equal(launches, 0, `${label} mismatch does not launch the child`);
    assert.equal(writes, 0, `${label} mismatch does not write evidence`);
    assert.equal(report.commandExecutions, 0, `${label} report remains zero-execution`);
    assert.equal(report.evidenceWrites, 0, `${label} report remains zero-write`);
    assert.equal(batch.ledger.intentCount, 0, `${label} mismatch does not record an intent`);
    assert.equal(batch.ledger.executions.length, 0, `${label} mismatch does not record an execution`);
  }
  emitIntentMarker(
    'CHK-004:adversarial:1',
    'missing, stale, forged, or identity-mismatched preflight is rejected before child launch with commandExecutions=0 and no gate-admissible PASS',
  );
});

test('CHK-006: atomic pre-run revalidation refuses before the child runner with zero counters or writes', async () => {
  const batch = createCausalEvidenceBatch();
  const store = new MemoryReceiptStore();
  const raceIdentity = baseIdentity('B-causal-race');
  let runInvoked = false;
  let revalidations = 0;
  await assert.rejects(
    executeCausalEvidence({
      identity: raceIdentity,
      selector: 'MARKER-A',
      receiptStore: store,
      batch,
      preflight: preflightFor(raceIdentity),
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
      preflight: preflightFor(metricReplayIdentities[slot]),
      revalidateBeforeRun: () => true,
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
      preflight: preflightFor(metricReplayIdentities[slot]),
      revalidateBeforeRun: () => true,
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
  const completedRunMetrics = deriveCausalMetrics(metricInitialBatch.ledger);
  assert.equal(completedRunMetrics.intentCount, 58);
  assert.equal(completedRunMetrics.uniqueExecutionKeys, 10);
  assert.equal(completedRunMetrics.commandExecutions, 10);
  assert.equal(completedRunMetrics.commandExecutions, completedRunMetrics.uniqueExecutionKeys);
  assert.ok(completedRunMetrics.cacheHitRate >= 0.8);
  assert.match(renderCausalMetrics(completedRunMetrics), /intentCount=58 uniqueExecutionKeys=10 commandExecutions=10/);
  emitIntentMarker(
    'CHK-005:happy:0',
    'completed 58-intent run reports intentCount=58 uniqueExecutionKeys=10 commandExecutions=10 cacheHitRate>=80% with commandExecutions equal to uniqueExecutionKeys',
  );

  const batch = createCausalEvidenceBatch();
  const batchIdentity = baseIdentity();
  await executeCausalEvidence({ identity: batchIdentity, selector: 'MARKER-A', run: async () => ({ code: 0, output: 'MARKER-A' }), batch, preflight: preflightFor(batchIdentity), revalidateBeforeRun: () => true });
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
    preflight: preflightFor(mixedIdentity),
    revalidateBeforeRun: () => true,
  });
  await executeCausalEvidence({
    identity: mixedIdentity,
    selector: 'MIXED-MARKER',
    run: async () => { mixedExecutions++; return { code: 0, output: 'unexpected reusable execution' }; },
    receiptStore: mixedStore,
    batch: mixedBatch,
    preflight: preflightFor(mixedIdentity),
    revalidateBeforeRun: () => true,
  });
  await executeCausalEvidence({
    identity: mixedNewIdentity,
    selector: 'MIXED-MARKER',
    run: async () => { mixedExecutions++; return { code: 0, output: 'MIXED-MARKER' }; },
    receiptStore: mixedStore,
    batch: mixedBatch,
    preflight: preflightFor(mixedNewIdentity),
    revalidateBeforeRun: () => true,
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

  const importRetryBatch = createCausalEvidenceBatch();
  const importRetryStore = new MemoryReceiptStore();
  const importRetryIdentity = baseIdentity('B-causal-metric-import-retry');
  const importRetrySource = await executeCausalEvidence({
    identity: importRetryIdentity,
    selector: 'IMPORT-RETRY',
    run: async () => ({ code: 0, output: 'IMPORT-RETRY' }),
    receiptStore: importRetryStore,
    batch: importRetryBatch,
    preflight: preflightFor(importRetryIdentity),
    revalidateBeforeRun: () => true,
  });
  let importRetryCommits = 0;
  const importRetryResult = importCausalEvidenceReceipt({
    receipt: importRetrySource.receipt,
    expectedStoryId: 'B-causal-metric-import-retry',
    expectedExecutionKey: importRetrySource.key.key,
    expectedMaterialHash: 'material-a',
    expectedStoryFilesHash: 'story-a',
    revalidate: () => true,
    commit: () => {
      importRetryCommits++;
      if (importRetryCommits === 1) throw new Error('transient metric import failure');
    },
    batch: importRetryBatch,
  });
  const importRetryMetrics = deriveCausalMetrics(importRetryBatch.ledger);
  assert.equal(importRetryResult.commandReruns, 0);
  assert.equal(importRetryMetrics.commandReruns, 0);
  assert.equal(importRetryMetrics.commitFailureReruns, 1);
  assert.equal(importRetryResult.receiptHash, importRetrySource.receipt.receiptHash);
  emitIntentMarker(
    'CHK-005:happy:1',
    'receipt-first import retry reports commitFailureReruns=1, commandReruns=0, and preserves receiptHash',
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
      preflight: preflightFor(incompleteIdentity),
      revalidateBeforeRun: () => true,
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
  emitIntentMarker(
    'CHK-005:happy:2',
    'mixed correctness metrics report unrelatedSpecializedRerun=0 affectedNodeRerun=100% falseFresh=0',
  );

  const metricFieldNames = Object.keys(correctnessMetrics).sort();
  assert.deepEqual(metricFieldNames, [
    'affectedNodeRerun', 'cacheHitRate', 'commandExecutions', 'commandReruns', 'commitFailureReruns',
    'falseFresh', 'intentCount', 'uniqueExecutionKeys', 'unrelatedSpecializedRerun',
  ]);
  assert.equal('elapsedMs' in correctnessMetrics, false);
  assert.equal('reviewerLanes' in correctnessMetrics, false);
  assert.equal('coverage' in correctnessMetrics, false);
  assert.equal('waivers' in correctnessMetrics, false);
  assert.doesNotMatch(renderCausalMetrics(correctnessMetrics), /elapsed|reviewer|coverage|waiver/i);
  emitIntentMarker(
    'CHK-005:adversarial:1',
    'metrics expose only U-03 execution and freshness fields without overlapping elapsed time or assurance-reduction fields',
  );

  const strictMetricDecision = evaluateCausalDependencies({
    nodes: [],
    currentInputHashes: {},
    previousMaterialHash: 'metric-material-before',
    currentMaterialHash: 'metric-material-after',
    previousStoryFilesHash: 'metric-story',
    currentStoryFilesHash: 'metric-story',
    doneRequired: true,
  });
  const metricGateFacts = {
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
    causalDecision: strictMetricDecision,
  };
  // B-5a15 F-333: these four refusals previously asserted only `admit === false` against a
  // fixture that ALREADY refused (inventory: null -> pre_cert_inventory_not_finalized), so
  // three of the four branches were never reached and the assertions were vacuous -- a
  // regression deleting the findings, coverage or dirty-tree checks would have stayed green.
  // Fixed by (a) a POSITIVE CONTROL proving the unmutated fixture is admitted, and (b)
  // asserting the SPECIFIC blockerCode each mutation is supposed to produce.
  // Signed evaluator fixture: this establishes admission prerequisites; it
  // does not claim an actual fast command was executed by this pure gate test.
  const routineValidationIdentity = buildRoutineValidationIdentity({
    projectRoot: repoRoot, sourceKind: 'configured',
    sourceInputs: { fixture: 'causal-metrics-admission' },
    commands: [{ label: 'fast', command: 'node', args: ['--version'], timeoutMs: 15000, focus: ['fast'] }],
    focus: 'fast', profile: 'standard', verificationPolicyInputs: { fixture: 'causal-metrics-admission' },
  });
  const cheapCheckReceipt = withSignedPrecertCheapCheckReceipt({
    schemaVersion: PRECERT_CHEAP_CHECK_RECEIPT_SCHEMA,
    receiptId: 'B-causal-test:CHEAP-1', storyId: 'B-causal-test',
    authority: PRECERT_CHEAP_CHECK_AUTHORITY, result: 'PASS', routineValidationIdentity,
    commandExecution: { schema: 'proofOrStop.routine-validation-command-execution', version: 1,
      status: 'PASS', complete: true, commandCount: 1, requiredFailureCount: 0, optionalFailureCount: 0 },
    headHash: 'h1', materialHash: 'm1', storyFilesHash: 's1', createdAt: new Date().toISOString(),
  });
  const admittableGateFacts = {
    ...metricGateFacts,
    inventorySaturated: true,
    cheapCheckReceipt,
    // Shape per inventoryLineageRefusal (certification-window.ts:447-468): a receipt whose
    // cutoff is on the CURRENT materialHash/storyFilesHash lineage for this story.
    inventory: {
      epoch: {
        storyId: 'B-causal-test',
        cutoff: { headHash: 'h1', materialHash: 'm1', storyFilesHash: 's1' },
      },
      receipt: {
        storyId: 'B-causal-test',
        cutoff: { headHash: 'h1', materialHash: 'm1', storyFilesHash: 's1' },
      },
    },
    causalDecision: undefined,
  };
  const control = evaluateCertificationWindowAdmit(admittableGateFacts);
  assert.equal(control.admit, true,
    `positive control must be admitted or the refusals below prove nothing: ${JSON.stringify(control)}`);

  const refusal = (overrides) => evaluateCertificationWindowAdmit({ ...admittableGateFacts, ...overrides });
  const openFindings = refusal({ openBlockingFindingIds: ['F-open'] });
  assert.equal(openFindings.admit, false);
  assert.equal(openFindings.blockerCode, 'pre_cert_blocking_findings_open');
  const missingIntents = refusal({ missingRequiredIntents: 1 });
  assert.equal(missingIntents.admit, false);
  assert.equal(missingIntents.blockerCode, 'pre_cert_coverage_missing');
  const dirtyTree = refusal({ dirtyNonRuntimePaths: ['packages/main/src/example.ts'] });
  assert.equal(dirtyTree.admit, false);
  assert.equal(dirtyTree.blockerCode, 'pre_cert_dirty_tree');
  const strictDrift = refusal({ causalDecision: strictMetricDecision });
  assert.equal(strictDrift.admit, false);
  assert.equal(strictDrift.blockerCode, 'pre_cert_causal_freshness_required');
  emitIntentMarker(
    'CHK-005:adversarial:2',
    'metrics PASS cannot bypass open findings missing coverage dirty tree or strict whole-tree causal drift',
  );

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

test('F-247: verifier-owned topology and pre-review checks are executable and current', async () => {
  const { withCurrentAcceptanceFixture } = await import('./helpers/current-acceptance-fixture.mjs');
  await withCurrentAcceptanceFixture(async ({ storyId, store, cli }) => {
    const topology = JSON.parse(cli('acceptance_topology_check', { storyId, json: true }));
    assert.equal(topology.status, 'pass');
    assert.equal(topology.readOnly, true);
    assert.equal(topology.authority, 'diagnostic_only');
    assert.equal(topology.basisStatus, 'complete');
    assert.equal(topology.structuralPass, true);
    assert.deepEqual(topology.diagnostics, []);

    const original = store.readPreReviewCheck(storyId);
    const preReview = JSON.parse(cli('pre_review_check_read', { storyId, json: true }));
    assert.equal(preReview.readOnly, true);
    assert.equal(preReview.status, 'pass');
    assert.equal(preReview.ok, true);
    assert.equal(preReview.executableEvidence, 'current');
    // This asserts the verifier's interpretation of captured fixture case records.
    // Production mutation execution is covered by the dedicated live-proof suite.
    assert.equal(preReview.mutations, 'biting');
    assert.equal(preReview.transcript, 'related');
    assert.equal(preReview.authority, 'admissible');
    assert.deepEqual(preReview.codes, []);
    assert.deepEqual(store.readPreReviewCheck(storyId), original, 'read does not refresh evidence');

    // Corrupt only isolated test data. A PASS cannot survive a changed signature.
    const tampered = structuredClone(original);
    tampered.signature = 'invalid-fixture-signature';
    store.writePreReviewCheck(storyId, tampered);
    const rejected = JSON.parse(cli('pre_review_check_read', { storyId, json: true }));
    assert.equal(rejected.ok, false);
    assert.ok(rejected.codes.includes('PR_ARTIFACT_TAMPERED'));
    assert.deepEqual(store.readPreReviewCheck(storyId), tampered, 'negative read does not repair its own input');
    store.writePreReviewCheck(storyId, original);
    assert.equal(JSON.parse(cli('pre_review_check_read', { storyId, json: true })).ok, true);
    emitIntentMarker('CHK-004:happy:2', 'acceptance_topology_check reports current complete structural PASS');
    emitIntentMarker('CHK-004:happy:3', 'pre_review_check_read reports current admissible executable PASS');
  });
});

test('B-5a15 F-250/F-252/F-256/F-260/F-262: validate-file execution uses the causal preflight plan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'b5a15-validate-file-causal-'));
  const storyId = 'B-5a15-validate-file-regression';
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  let store;
  try {
    mkdirSync(join(root, 'test-bin'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'validate-file-launched\n**/owner-lease.json\n', 'utf8');
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
    }) + '\n', 'utf8');
    const marker = join(root, 'validate-file-launched');
    writeFileSync(join(root, 'validate.js'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'launched\\n');`,
      "console.log(JSON.stringify({ provider: 'validate-file-regression', status: 'pass', allPass: true }));",
      '',
    ].join('\n'), 'utf8');
    const npx = join(root, 'test-bin', 'npx');
    writeFileSync(npx, '#!/bin/sh\n[ "$1" = "tsx" ] || exit 64\nshift\nexec node "$@"\n', 'utf8');
    chmodSync(npx, 0o755);

    const git = (args) => execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'B-5a15 causal-evidence test']);
    git(['config', 'user.email', 'b5a15-causal-evidence@example.test']);
    git(['add', '.gitignore', 'proof-or-stop.config.json', 'validate.js', 'test-bin/npx']);
    git(['commit', '-m', 'seed validate-file causal-preflight regression']);

    store = new StoryStore(root);
    const now = new Date().toISOString();
    store.writeStory(storyId, {
      storyId,
      name: 'validate-file-causal-preflight',
      title: 'validate-file causal preflight',
      description: 'Synthetic story for the real verifier validate-file branch.',
      type: 'bug',
      phase: 'TEST',
      priority: 'high',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [],
    });
    store.writeChecklist(storyId, { items: [] });
    writeFileSync(join(store.storyDirPath(storyId), 'closeout-write-receipts.jsonl'), '', 'utf8');
    git(['add', '.proof-or-stop']);
    git(['commit', '-m', 'seed validate-file story metadata']);
    acquireOwnerLease(store.storyDirPath(storyId), { command: 'validate', cwd: root });
    const causalInputHashes = deriveCertificationDomainInputHashes(root, 'HEAD', root);
    assert.ok(causalInputHashes, 'race fixture needs current certification domain identity');
    persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes });

    const facts = {
      cli: { available: true, path: join(root, 'test-bin', 'npx') },
      worktree: { expected: root, actual: root },
      gitIndex: { readable: true, path: join(root, '.git', 'index'), contentDigest: 'same-index' },
      gitMaterial: { available: true, headHash: 'head-a', materialHash: 'material-a', storyFilesHash: 'story-a' },
      writerLease: { available: true, valid: true },
      providerCapability: { required: ['validation-plan', 'bounded-output'], available: ['validation-plan', 'bounded-output'] },
      resources: { required: { timeoutMs: 1000 }, available: { timeoutMs: 1000 } },
      evidenceTarget: { writable: true, path: join(root, '.proof-or-stop', 'causal-evidence') },
      sideChannel: { available: true, maxOutputChars: 12000, maxProgressEvents: 1 },
    };

    process.chdir(root);
    process.env.PATH = `${join(root, 'test-bin')}:${originalPath ?? ''}`;
    let factCalls = 0;
    const driftingHandlers = createVerifierHandlers({
      root,
      scanRoot: join(root, 'packages/main'),
      store,
      causalPreflightFacts: () => {
        factCalls++;
        return {
          ...structuredClone(facts),
          gitIndex: { ...facts.gitIndex, contentDigest: factCalls === 2 ? 'drifted-index' : facts.gitIndex.contentDigest },
        };
      },
    });
    await assert.rejects(
      driftingHandlers.validate({ story: storyId, json: true, noSync: true }),
      /causal_preflight_refused/,
      'a validate.js run must refuse after its causal snapshot changes before launch',
    );
    assert.equal(existsSync(marker), false, 'the validate-file child is not launched after preflight drift');
    assert.ok(factCalls >= 2, 'validate-file branch performs the initial and atomic preflight probes');
    assert.equal(store.readCertificationWindows(storyId).windows.at(-1).state, 'ADMITTED',
      'pre-launch causal refusal must not consume the certification window');

    const stableHandlers = createVerifierHandlers({
      root,
      scanRoot: join(root, 'packages/main'),
      store,
      causalPreflightFacts: () => structuredClone(facts),
    });
    const result = JSON.parse(await stableHandlers.validate({ story: storyId, json: true, noSync: true }));
    assert.equal(result.status, 'pass', JSON.stringify(result));
    assert.equal(result.commandExecutions, 1);
    const evidence = store.readTestEvidence(storyId);
    assert.equal(evidence?.result, 'PASS');
    assert.equal(evidence?.commandExecution?.status, 'PASS');
    assert.equal(evidence?.routineValidationIdentity?.commands?.[0]?.label, 'validate.js');
    assert.equal(evidence?.routineValidationIdentity?.commands?.[0]?.command, 'npx');
    assert.equal(readFileSync(marker, 'utf8'), 'launched\n');
  } finally {
    if (store) releaseOwnerLease(store.storyDirPath(storyId));
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('B-5a15 F-249/F-251/F-253/F-255/F-257/F-258/F-259/F-261/F-263/F-264: verifier-owned acceptance reads and rollout mutations are executable', async () => {
  const {withCurrentRolloutFixture}=await import('./helpers/current-rollout-fixture.mjs');
  await withCurrentRolloutFixture(async ({root,storyId,store,cohort,artifact,read,rollout})=>{
 const {acceptanceRolloutHistoryDigest,deriveAcceptanceRolloutReport,verifyAcceptanceRolloutArtifact}=rollout;
 const rolloutRead=read('acceptance_rollout_report_read');
 const rolloutCheck=read('acceptance_rollout_check');
 assert.equal(rolloutRead.ok,true);assert.equal(rolloutRead.receipt,'current');
 assert.equal(rolloutRead.quorum,'full-3x2');assert.equal(rolloutCheck.mode,'enforce');
 assert.equal(rolloutCheck.status,'pass');assert.equal(rolloutCheck.blocking,false);assert.deepEqual(rolloutCheck.diagnostics,[]);
  const originalHistoryDigest = acceptanceRolloutHistoryDigest(artifact);
  const verify = (candidate, mode = 'enforce') => verifyAcceptanceRolloutArtifact({
    artifact: candidate,
    gitCwd: root,
    metadataRoot: root,
    expectedStoryId: storyId,
    expectedCohort: cohort,
    mode,
  });

  const thresholdMutation = structuredClone(artifact);
  thresholdMutation.report.thresholdVersion = 'forged-threshold-v1';
  assert.equal(verify(thresholdMutation).ok, false);
  assert.ok(verify(thresholdMutation).diagnostics.includes('AR_REPORT_TAMPERED'));

  const membershipMutation = structuredClone(artifact);
  membershipMutation.report.eligibleMembership = membershipMutation.report.eligibleMembership.slice(1);
  assert.equal(verify(membershipMutation).ok, false);
  assert.ok(verify(membershipMutation).diagnostics.includes('AR_REPORT_TAMPERED'));

  const freshnessMutation = structuredClone(artifact);
  freshnessMutation.receipt.headHash = '0'.repeat(40);
  freshnessMutation.receipt.materialHash = '0'.repeat(64);
  freshnessMutation.receipt.storyFilesHash = '0'.repeat(64);
  const stale = verify(freshnessMutation);
  assert.equal(stale.ok, false);
  assert.ok(stale.diagnostics.includes('AR_REPORT_STALE'));

  const degradedCohort = structuredClone(cohort);
  const degradedRecord = degradedCohort.sourceRecords.find(record => record.arm === 'candidate');
  assert.ok(degradedRecord?.observationReceipt?.hostVerdicts?.length >= 2);
  degradedRecord.observationReceipt.hostVerdicts = degradedRecord.observationReceipt.hostVerdicts
    .filter(verdict => verdict.provider !== 'codex');
  const degradedReport = deriveAcceptanceRolloutReport({
    storyId: storyId,
    cohort: degradedCohort,
    binding: artifact.report.binding,
    gitCwd: root,
  });
  assert.equal(degradedReport.verdict, 'fail');
  assert.ok(degradedReport.diagnostics.includes('AR_SOURCE_EVIDENCE_INVALID'));
  assert.ok(degradedReport.metrics.candidateSampleCount < 6);

  const modeMutation = structuredClone(artifact);
  modeMutation.receipt.headHash = '0'.repeat(40);
  modeMutation.receipt.materialHash = '0'.repeat(64);
  modeMutation.receipt.storyFilesHash = '0'.repeat(64);
  const modeReports = ['observe', 'warn', 'enforce'].map(mode => verify(modeMutation, mode));
  assert.deepEqual(modeReports.map(report => report.status), ['fail', 'fail', 'fail']);
  assert.deepEqual(modeReports.map(report => report.diagnostics), [
    modeReports[0].diagnostics,
    modeReports[0].diagnostics,
    modeReports[0].diagnostics,
  ]);
  assert.deepEqual(modeReports.map(report => report.blocking), [false, false, true]);

  const after = store.readAcceptanceRolloutReport(storyId);
  assert.deepEqual(after, artifact, 'read/check and in-memory mutation probes do not rewrite rollout history');
  assert.equal(acceptanceRolloutHistoryDigest(after), originalHistoryDigest);
 console.log('PASS F249-F264 current rollout positive and all original negative mutations');
},{cohortPath:process.env.PROOF_OR_STOP_ROLLOUT_COHORT_INPUT_PATH});
});
