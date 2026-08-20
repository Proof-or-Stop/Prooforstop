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
const { detectCertificationWindowMaterialDrift, signCertificationWindow, CERTIFICATION_WINDOW_SCHEMA } = await import(
  pathToFileURL(join(distRoot, 'core/certification-window.js')).href,
);

const {
  CAUSAL_DEPENDENCY_DOMAINS,
  DEFAULT_CAUSAL_SELECTOR_POLICY,
  createCausalExecutionKey,
  createCausalEvidenceBatch,
  deriveCausalMetrics,
  effectiveCausalEnvironment,
  evaluateCausalDependencies,
  executeCausalEvidence,
  importCausalEvidenceReceipt,
  preflightCausalEvidence,
  renderCausalMetrics,
  verifyCausalDependencyDecision,
  verifyCausalEvidenceReceipt,
} = causal;

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
    gitIndex: { readable: true, expected: 'head-a', actual: 'head-a' },
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

  let incompleteExecutions = 0;
  const incompleteIdentity = { cwd: repoRoot, storyId: identity.storyId, command: identity.command };
  await Promise.all([
    executeCausalEvidence({ identity: incompleteIdentity, selector: 'MARKER-A', run: async () => { incompleteExecutions++; return { code: 0, output: 'MARKER-A' }; }, batch }),
    executeCausalEvidence({ identity: incompleteIdentity, selector: 'MARKER-A', run: async () => { incompleteExecutions++; return { code: 0, output: 'MARKER-A' }; }, batch }),
  ]);
  assert.equal(incompleteExecutions, 2, 'incomplete identities are never reused as PASS');
});

test('CHK-002: CAS receipts precede isolated import, retry commit only, and fail closed on tamper', async () => {
  const root = mkdtempSync(join(tmpdir(), 'causal-evidence-store-'));
  try {
    writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
      scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
    }));
    const store = new StoryStore(root);
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
    let commits = 0;
    let revalidations = 0;
    const imported = importCausalEvidenceReceipt({
      receipt,
      expectedStoryId: storyId,
      expectedExecutionKey: key.key,
      expectedMaterialHash: 'material-store',
      expectedStoryFilesHash: 'story-store',
      revalidate: () => { revalidations++; return true; },
      commit: () => { commits++; if (commits === 1) throw new Error('transient index commit'); },
    });
    assert.equal(imported.attempts, 2);
    assert.equal(imported.commandReruns, 0);
    assert.equal(revalidations, 2);
    assert.equal(executions, 1, 'import retry never reruns command');
    assert.throws(() => importCausalEvidenceReceipt({
      receipt: null, expectedStoryId: storyId, expectedExecutionKey: key.key, revalidate: () => true, commit: () => {},
    }), /causal_receipt_invalid/);
    assert.throws(() => importCausalEvidenceReceipt({
      receipt, expectedStoryId: storyId, expectedExecutionKey: 'ce:v1:wrong', revalidate: () => true, commit: () => {},
    }), /causal_receipt_invalid/);
    const receiptPath = store.causalEvidenceReceiptPath(storyId, receipt.receiptHash);
    const original = readFileSync(receiptPath, 'utf8');
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, outputTail: 'tampered' }));
    assert.throws(() => store.readCausalEvidenceReceipt(storyId, key.key), /causal_receipt_tampered/);
    writeFileSync(receiptPath, original);
    assert.equal(store.readCausalEvidenceReceipt(storyId, key.key).receiptHash, receipt.receiptHash);
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

  const advisory = evaluateCausalDependencies({
    nodes: nodes.map(node => ({ ...node, recordedInputHashes: { [`input-${node.domain}`]: current[`input-${node.domain}`] } })),
    currentInputHashes: current, previousMaterialHash: 'm1', currentMaterialHash: 'm2', previousStoryFilesHash: 's1', currentStoryFilesHash: 's1',
  });
  assert.equal(advisory.causalDecision, 'advisory');
  assert.equal(advisory.materialHashStrict, false);
  const matchingNodes = nodes.map(node => ({
    ...node,
    recordedInputHashes: { [`input-${node.domain}`]: current[`input-${node.domain}`] },
  }));
  const doneStrict = evaluateCausalDependencies({
    nodes: matchingNodes, currentInputHashes: current, previousMaterialHash: 'm1', currentMaterialHash: 'm2', previousStoryFilesHash: 's1', currentStoryFilesHash: 's1', doneRequired: true,
  });
  assert.equal(doneStrict.causalDecision, 'strict');
  assert.equal(doneStrict.gateAdmissible, false);

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
});

test('CHK-004: preflight refuses exact readiness failures with zero execution/evidence counters', () => {
  const cases = [
    ['cli', { cli: { available: false } }, 'cli_unavailable'],
    ['worktree', { worktree: { expected: '/a', actual: '/b' } }, 'worktree_mismatch'],
    ['index', { gitIndex: { readable: false } }, 'git_index_unavailable'],
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
  const race = preflight({}, () => false);
  assert.equal(race.ready, false);
  assert.deepEqual(race.failedChecks, ['state_changed_before_launch']);
  assert.equal(preflight().ready, true);
});

test('CHK-005: metrics are zero-safe and tamper-resistant canonical-ledger projections', async () => {
  const empty = deriveCausalMetrics(createCausalEvidenceBatch().ledger);
  assert.deepEqual(empty, {
    intentCount: 0, uniqueExecutionKeys: 0, commandExecutions: 0, cacheHitRate: 0, commandReruns: 0,
    commitFailureReruns: 0, unrelatedSpecializedRerun: 0, affectedNodeRerun: 0, falseFresh: 0,
  });
  const batch = createCausalEvidenceBatch();
  await executeCausalEvidence({ identity: baseIdentity(), selector: 'MARKER-A', run: async () => ({ code: 0, output: 'MARKER-A' }), batch, preflight: preflight() });
  const metrics = deriveCausalMetrics(batch.ledger);
  assert.equal(metrics.intentCount, 1);
  assert.equal(metrics.uniqueExecutionKeys, 1);
  assert.equal(metrics.commandExecutions, 1);
  assert.match(renderCausalMetrics(metrics), /intentCount=1 uniqueExecutionKeys=1 commandExecutions=1/);
  const tampered = { ...batch.ledger, intentCount: 99 };
  assert.throws(() => deriveCausalMetrics(tampered), /causal_ledger_tampered/);
});
