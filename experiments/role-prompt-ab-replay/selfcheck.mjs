#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EXPERIMENT_ROOT,
  canonicalJson,
  digest,
  evaluateBoundFixture,
  findingSetDigest,
  historicalFindingSnapshotDigest,
  loadPinnedExperiment,
  materialDigest,
  replayExperiment,
  validateExperiment,
} from './lib/replay.mjs';
import {
  appendLedgerRecord,
  makeLedgerRecord,
  readLedger,
  resolveLedgerPath,
  summarizeLedger,
  verifyLedgerRows,
} from './lib/ledger.mjs';

const repoRoot = path.resolve(EXPERIMENT_ROOT, '..', '..');
const runtimeDir = path.join(EXPERIMENT_ROOT, 'runtime');
const ledgerPath = `runtime/selfcheck-${process.pid}.jsonl`;
let checks = 0;

async function check(name, fn) {
  await fn();
  checks += 1;
  process.stdout.write(`  ✓ ${name}\n`);
}

async function expectCode(code, fn) {
  await assert.rejects(fn, error => error?.code === code, `expected ${code}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function reverseObjectInsertion(value) {
  if (Array.isArray(value)) return value.map(reverseObjectInsertion);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectInsertion(child)]));
}

async function hashTree(relativePaths) {
  const rows = [];
  const visit = async relative => {
    const absolute = path.join(repoRoot, relative);
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        rows.push([relative, 'absent']);
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      rows.push([relative, 'symlink']);
      return;
    }
    if (stat.isDirectory()) {
      const names = (await readdir(absolute)).sort();
      rows.push([relative, 'dir']);
      for (const name of names) await visit(path.posix.join(relative, name));
      return;
    }
    const bytes = await readFile(absolute);
    rows.push([relative, createHash('sha256').update(bytes).digest('hex'), bytes.length]);
  };
  for (const relative of relativePaths) await visit(relative);
  return digest('role-prompt-ab.production-evidence-snapshot.v1', rows);
}

function usage(cell, overrides = {}) {
  return {
    assembledPromptTokens: {
      availability: 'unavailable',
      reason: 'Exact content-addressed prompt snapshot bytes are not pinned for this canonical sample.',
    },
    knownDispatchInputTokens: cell.providerObservation.knownDispatchInputTokens,
    providerProcessedInputTokens: cell.providerObservation.providerProcessedInputTokens,
    uncachedInputTokens: cell.providerObservation.uncachedInputTokens,
    cacheCreationInputTokens: cell.providerObservation.cacheCreationInputTokens,
    cacheReadInputTokens: cell.providerObservation.cacheReadInputTokens,
    outputTokens: cell.providerObservation.outputTokens,
    ...overrides,
  };
}

function inputFor(result, cell, overrides = {}) {
  return {
    experimentId: result.experimentId,
    cellId: cell.cellId,
    ledgerCallId: 'selfcheck-call',
    attemptId: 'attempt-1',
    sequence: 1,
    event: 'assembled',
    disposition: null,
    observedAt: '2026-01-01T00:00:00.000Z',
    inputDigest: cell.inputDigest,
    promptDigest: cell.measurement.promptDigest,
    materialDigest: cell.materialDigest,
    findingSetDigest: cell.findingComparison.findingSetDigest,
    modelId: 'historical-observation-only.v1',
    contractVersion: cell.promptContract,
    usage: usage(cell),
    latencyMs: null,
    findingMeasurement: {
      seededOracleCount: cell.findingComparison.seededOracleCount,
      detectedCount: cell.findingComparison.detectedCount,
      status: cell.findingComparison.status,
      reasonCode: cell.findingComparison.reasonCode,
    },
    ...overrides,
  };
}

function makeHermeticFixture() {
  const oracles = [{
    id: 'HERMETIC-001',
    category: 'missing',
    severity: 'critical',
    sourceBinding: 'fixture/source.mjs',
    claimBinding: 'fixture-claim',
  }];
  const arms = [
    {
      id: 'A',
      promptContract: 'fixture-legacy.v1',
      promptSnapshot: {
        content: 'PROMPT CONTRACT: fixture-legacy.v1\nLegacy fixture instructions.\nShared fixture input.',
      },
    },
    {
      id: 'B',
      promptContract: 'fixture-modular.v1',
      promptSnapshot: {
        content: 'PROMPT CONTRACT: fixture-modular.v1\nModular fixture instructions.\nShared fixture input.',
      },
    },
  ];
  for (const arm of arms) {
    arm.promptSnapshot.contentDigest = digest(
      'role-prompt-ab.hermetic-prompt-snapshot.v1',
      arm.promptSnapshot.content,
    );
  }
  const reviewerOutputs = arms.map(arm => {
    const content = {
      findings: [{
        oracleId: 'HERMETIC-001',
        category: 'missing',
        sourceBinding: 'fixture/source.mjs',
        claimBinding: 'fixture-claim',
      }],
    };
    return {
      armId: arm.id,
      content,
      contentDigest: digest('role-prompt-ab.hermetic-reviewer-output.v1', content),
    };
  });
  const matches = arms.map(arm => ({
    armId: arm.id,
    seededOracleCount: 1,
    detectedCount: 1,
    criticalAllDetected: true,
    recall: 1,
  }));
  const adjudicationContent = { matches };
  return {
    schemaVersion: 'proofbound.role-prompt-ab.hermetic-fixture.v1',
    arms,
    oracles,
    oracleSetDigest: digest('role-prompt-ab.hermetic-oracle-set.v1', oracles),
    reviewerOutputs,
    independentAdjudication: {
      content: adjudicationContent,
      contentDigest: digest('role-prompt-ab.hermetic-independent-adjudication.v1', adjudicationContent),
    },
  };
}

const productionPaths = [
  '.lattice/story',
  '.lattice/usage/llm-usage.jsonl',
  '.lattice/activity.jsonl',
  '.lattice/process-events.jsonl',
];
const beforeProduction = await hashTree(productionPaths);

try {
  const { protocol, corpus } = await loadPinnedExperiment();
  let identity;
  let baseline;
  let hermeticResult;

  await check('pinned protocol has 3 classes, 6 samples, >=3 repeats and signed historical findings', () => {
    identity = validateExperiment(protocol, corpus);
    assert.equal(identity.classes, 3);
    assert.equal(identity.samples, 6);
    assert.ok(identity.repeats >= 3);
    assert.equal(identity.seededOracleCount, 4);
    assert.equal(identity.signedHistoricalFindings, 2);
    assert.equal(identity.adjudicatedFindings, 0);
    assert.equal(identity.recallStatus, 'INCONCLUSIVE');
    assert.equal(
      corpus.historicalFindingSnapshotDigest,
      historicalFindingSnapshotDigest(corpus.historicalFindingSnapshot),
    );
  });

  await check('all pinned material and finding digests recompute exactly', () => {
    for (const sample of corpus.samples) {
      assert.equal(sample.materialDigest, materialDigest(sample));
      assert.equal(sample.findingSetDigest, findingSetDigest(sample));
    }
  });

  await check('same frozen contract and corpus yield the same experiment identity', () => {
    assert.equal(validateExperiment(clone(protocol), clone(corpus)).experimentId, identity.experimentId);
  });

  await check('frozen protocol mutation changes content-addressed experiment identity', () => {
    const changed = clone(protocol);
    changed.arms[0].description += ' changed';
    assert.notEqual(validateExperiment(changed, corpus).experimentId, identity.experimentId);
  });

  await check('repeat floor regression is rejected', async () => {
    const changed = clone(protocol);
    changed.sampling.repeats = 2;
    changed.sampling.armOrderByRepeat = changed.sampling.armOrderByRepeat.slice(0, 2);
    await expectCode('REPEAT_FLOOR_INCOMPLETE', async () => validateExperiment(changed, corpus));
  });

  await check('sample-class floor regression is rejected', async () => {
    const changed = clone(corpus);
    changed.samples = changed.samples.filter(sample => sample.id !== 'clean-pass-02');
    await expectCode('SAMPLE_FLOOR_INCOMPLETE', async () => validateExperiment(protocol, changed));
  });

  await check('duplicate sample identity is rejected', async () => {
    const changed = clone(corpus);
    changed.samples.push(clone(changed.samples[0]));
    await expectCode('DUPLICATE_SAMPLE', async () => validateExperiment(protocol, changed));
  });

  await check('unverified oracle rows cannot masquerade as independent adjudication', async () => {
    const changed = clone(corpus);
    changed.samples[2].oracles[0].adjudication = {
      status: 'verified',
      reason: 'unsupported prose-only claim',
    };
    changed.samples[2].findingSetDigest = findingSetDigest(changed.samples[2]);
    await expectCode('ADJUDICATION_EVIDENCE_UNVERIFIED', async () => validateExperiment(protocol, changed));
  });

  await check('forged historical finding signature is rejected even when the snapshot digest is repinned', async () => {
    const changed = clone(corpus);
    changed.historicalFindingSnapshot[0]._hash = '0'.repeat(64);
    changed.historicalFindingSnapshotDigest = historicalFindingSnapshotDigest(changed.historicalFindingSnapshot);
    await expectCode('HISTORICAL_FINDING_SIGNATURE_INVALID', async () => validateExperiment(protocol, changed));
  });

  await check('cross-story historical finding reference is rejected even when the snapshot digest is repinned', async () => {
    const changed = clone(corpus);
    changed.historicalFindingSnapshot[0].reviewRunId = 'B-other:RR-001';
    changed.historicalFindingSnapshotDigest = historicalFindingSnapshotDigest(changed.historicalFindingSnapshot);
    await expectCode('HISTORICAL_FINDING_REFERENCE_INVALID', async () => validateExperiment(protocol, changed));
  });

  await check('unavailable controls carry reasons and never masquerade as zero', () => {
    for (const key of ['temperature', 'providerSeed', 'toolChoice']) {
      assert.equal(protocol.sampling[key].availability, 'unavailable');
      assert.ok(protocol.sampling[key].reason.length > 10);
      assert.equal(Object.hasOwn(protocol.sampling[key], 'tokens'), false);
    }
  });

  await check('unbound available historical provider or dispatch metrics are rejected', async () => {
    const dispatch = clone(corpus);
    dispatch.samples[0].providerObservation.knownDispatchInputTokens = {
      availability: 'available',
      tokens: 1,
      source: 'unbound claim',
    };
    await expectCode('UNBOUND_HISTORICAL_METRIC', async () => validateExperiment(protocol, dispatch));
    const provider = clone(corpus);
    provider.samples[0].providerObservation.providerProcessedInputTokens = {
      availability: 'available',
      tokens: 0,
      source: 'unbound zero claim',
    };
    await expectCode('UNBOUND_HISTORICAL_METRIC', async () => validateExperiment(protocol, provider));
  });

  await check('inline corpus content is the exact snapshot authority and sourceHintPath is non-authoritative', async () => {
    for (const sample of corpus.samples) {
      assert.equal(sample.material.sourceKind, 'inline-corpus-snapshot');
      assert.equal(sample.material.snapshotAuthority, 'corpus-json-content-addressed.v1');
      assert.equal(sample.material.snapshotId, sample.id);
      assert.ok(sample.material.content && typeof sample.material.content === 'object');
    }
    const wrongAuthority = clone(corpus);
    wrongAuthority.samples[0].material.snapshotAuthority = 'repository-path-claim.v1';
    wrongAuthority.samples[0].materialDigest = materialDigest(wrongAuthority.samples[0]);
    await expectCode('MUTABLE_MATERIAL', async () => validateExperiment(protocol, wrongAuthority));
    const missingContent = clone(corpus);
    delete missingContent.samples[0].material.content;
    missingContent.samples[0].materialDigest = materialDigest(missingContent.samples[0]);
    await expectCode('MATERIAL_MISSING', async () => validateExperiment(protocol, missingContent));
  });

  await check('valid replay is deterministic and same-input across arms', () => {
    baseline = replayExperiment({ protocol, corpus });
    const repeated = replayExperiment({ protocol, corpus });
    assert.equal(repeated.resultDigest, baseline.resultDigest);
    assert.equal(baseline.sameInput, true);
    assert.equal(baseline.cells.length, corpus.samples.length * protocol.arms.length * protocol.sampling.repeats);
    for (const sample of corpus.samples) {
      const cells = baseline.cells.filter(cell => cell.sampleId === sample.id);
      assert.equal(new Set(cells.map(cell => cell.inputDigest)).size, 1);
      assert.deepEqual([...new Set(cells.map(cell => cell.repeat))].sort(), [1, 2, 3]);
    }
  });

  await check('reverse arm execution order preserves all canonical cell measurements', () => {
    const reversed = replayExperiment({ protocol, corpus, armOrder: ['B', 'A'] });
    assert.equal(reversed.resultDigest, baseline.resultDigest);
    assert.deepEqual(reversed.cells, baseline.cells);
  });

  await check('equivalent object insertion order preserves identities and measurements', () => {
    const reorderedProtocol = reverseObjectInsertion(protocol);
    const reorderedCorpus = reverseObjectInsertion(corpus);
    const reordered = replayExperiment({ protocol: reorderedProtocol, corpus: reorderedCorpus });
    assert.equal(reordered.experimentId, baseline.experimentId);
    assert.equal(reordered.resultDigest, baseline.resultDigest);
  });

  await check('meaningful model change changes shared input while prompt cost stays honestly unavailable', () => {
    const changedProtocol = clone(protocol);
    changedProtocol.model.modelId = 'historical-observation-only.v2';
    const changed = replayExperiment({ protocol: changedProtocol, corpus });
    assert.notEqual(changed.cells[0].inputDigest, baseline.cells[0].inputDigest);
    assert.equal(changed.cells[0].measurement.promptDigest, null);
    assert.equal(changed.cells[0].measurement.status, 'INCONCLUSIVE');
  });

  await check('arm contract mutation changes contract identity but cannot fabricate prompt bytes', () => {
    const changedProtocol = clone(protocol);
    changedProtocol.arms[0].promptContract = 'legacy-full-context.v2';
    const changed = replayExperiment({ protocol: changedProtocol, corpus });
    const baselineA = baseline.cells.find(cell => cell.armId === 'A');
    const changedA = changed.cells.find(cell => cell.armId === 'A');
    assert.notEqual(changedA.promptContractDigest, baselineA.promptContractDigest);
    assert.equal(changedA.measurement.bytes, null);
    assert.equal(changedA.measurement.promptDigest, null);
  });

  await check('hermetic bound fixture computes exact prompt metrics and semantic finding comparison', () => {
    hermeticResult = evaluateBoundFixture(makeHermeticFixture());
    assert.equal(hermeticResult.status, 'EVALUABLE');
    assert.equal(hermeticResult.evidenceScope, 'hermetic-selfcheck-only');
    assert.equal(hermeticResult.historicalEvidence, false);
    assert.ok(hermeticResult.cells.every(cell => cell.measurement.bytes > 0));
    assert.ok(hermeticResult.cells.every(cell => /^[a-f0-9]{64}$/.test(cell.measurement.promptDigest)));
    assert.ok(hermeticResult.cells.every(cell => cell.findingComparison.recall === 1));
  });

  await check('hermetic prompt contract/content and reviewer-output tamper fail closed', async () => {
    const contractOnly = makeHermeticFixture();
    contractOnly.arms[0].promptContract = 'fixture-legacy.v2';
    await expectCode('PROMPT_CONTRACT_SNAPSHOT_MISMATCH', async () => evaluateBoundFixture(contractOnly));
    const updated = makeHermeticFixture();
    const oldDigest = updated.arms[0].promptSnapshot.contentDigest;
    updated.arms[0].promptContract = 'fixture-legacy.v2';
    updated.arms[0].promptSnapshot.content =
      'PROMPT CONTRACT: fixture-legacy.v2\nLegacy fixture instructions.\nShared fixture input.';
    updated.arms[0].promptSnapshot.contentDigest = digest(
      'role-prompt-ab.hermetic-prompt-snapshot.v1',
      updated.arms[0].promptSnapshot.content,
    );
    const evaluated = evaluateBoundFixture(updated);
    assert.notEqual(evaluated.cells.find(cell => cell.armId === 'A').promptSnapshotDigest, oldDigest);
    const outputTamper = makeHermeticFixture();
    outputTamper.reviewerOutputs[0].content.findings[0].category = 'edge';
    await expectCode('FINDING_OUTPUT_DIGEST_MISMATCH', async () => evaluateBoundFixture(outputTamper));
  });

  await check('meaningful material/tool change changes digests after explicit repinning', () => {
    const changedCorpus = clone(corpus);
    changedCorpus.samples[0].tools.push('Bash');
    changedCorpus.samples[0].materialDigest = materialDigest(changedCorpus.samples[0]);
    const changed = replayExperiment({ protocol, corpus: changedCorpus });
    assert.notEqual(changed.cells.find(cell => cell.cellId === 'clean-pass-01/A/repeat-1').inputDigest,
      baseline.cells.find(cell => cell.cellId === 'clean-pass-01/A/repeat-1').inputDigest);
  });

  await check('unrepinned material mutation fails closed', async () => {
    const changed = clone(corpus);
    changed.samples[0].material.content.diff += ' tampered';
    await expectCode('MATERIAL_DIGEST_MISMATCH', async () => replayExperiment({ protocol, corpus: changed }));
  });

  await check('protocol and corpus version skew fail closed', async () => {
    const changedProtocol = clone(protocol);
    changedProtocol.schemaVersion = 'proofbound.role-prompt-ab.protocol.v2';
    await expectCode('UNSUPPORTED_PROTOCOL_VERSION', async () => replayExperiment({ protocol: changedProtocol, corpus }));
    const changedCorpus = clone(corpus);
    changedCorpus.schemaVersion = 'proofbound.role-prompt-ab.corpus.v2';
    await expectCode('UNSUPPORTED_CORPUS_VERSION', async () => replayExperiment({ protocol, corpus: changedCorpus }));
  });

  await check('path traversal and mutable live Story material are rejected', async () => {
    const traversal = clone(corpus);
    traversal.samples[0].material.sourceHintPath = '../.lattice/story/actives/B-8d4b/index.json';
    traversal.samples[0].materialDigest = materialDigest(traversal.samples[0]);
    await expectCode('PATH_ESCAPE', async () => replayExperiment({ protocol, corpus: traversal }));
    const mutable = clone(corpus);
    mutable.samples[0].material.sourceKind = 'live-story';
    mutable.samples[0].materialDigest = materialDigest(mutable.samples[0]);
    await expectCode('MUTABLE_MATERIAL', async () => replayExperiment({ protocol, corpus: mutable }));
  });

  await check('caller-supplied digest or finding results are rejected', async () => {
    await expectCode('CALLER_SUBSTITUTION_REJECTED', async () => replayExperiment({
      protocol, corpus, resultDigest: '0'.repeat(64),
    }));
    await expectCode('CALLER_SUBSTITUTION_REJECTED', async () => replayExperiment({
      protocol, corpus, findingOutcomes: [],
    }));
  });

  const firstCell = baseline.cells[0];
  await check('experiment record is private, non-authoritative and identity bound', () => {
    const row = makeLedgerRecord(inputFor(baseline, firstCell));
    assert.equal(row.namespace, 'experiment-only');
    assert.equal(row.gateEvidence, false);
    assert.equal(row.privacy.contentStored, false);
    assert.equal(row.experimentId, baseline.experimentId);
    assert.equal(row.promptDigest, firstCell.measurement.promptDigest);
  });

  await check('normal usage-ledger and process-fact consumers do not admit experiment rows', async () => {
    const row = makeLedgerRecord(inputFor(baseline, firstCell));
    const normalLedger = await import(pathToFileURL(
      path.join(repoRoot, 'packages/main/dist/core/usage-ledger/record.js'),
    ).href);
    const normalValidation = normalLedger.validateUsageLedgerRecord(row);
    assert.equal(normalValidation.ok, false);
    const [factRegistry, factLevels] = await Promise.all([
      readFile(path.join(repoRoot, 'packages/main/src/core/process-fact-registry.ts'), 'utf8'),
      readFile(path.join(repoRoot, 'packages/main/src/core/process-fact-levels.ts'), 'utf8'),
    ]);
    assert.equal(factRegistry.includes('proofbound.role-prompt-ab.experiment-ledger.v1'), false);
    assert.equal(factLevels.includes('proofbound.role-prompt-ab.experiment-ledger.v1'), false);
    assert.equal(factRegistry.includes('experiments/role-prompt-ab-replay/runtime'), false);
  });

  await check('forged authority and production Story references are rejected', async () => {
    await expectCode('PRIVATE_OR_AUTHORITATIVE_FIELD', async () => makeLedgerRecord(inputFor(baseline, firstCell, {
      authority: { receiptVerified: true },
    })));
    await expectCode('PRIVATE_OR_AUTHORITATIVE_FIELD', async () => makeLedgerRecord(inputFor(baseline, firstCell, {
      storyId: 'B-forged',
    })));
  });

  await check('raw prompts, tool arguments and secrets are rejected recursively', async () => {
    await expectCode('PRIVATE_OR_AUTHORITATIVE_FIELD', async () => makeLedgerRecord(inputFor(baseline, firstCell, {
      rawPrompt: 'private',
    })));
    const poisoned = inputFor(baseline, firstCell);
    poisoned.usage.toolArguments = { authorization: 'secret' };
    await expectCode('PRIVATE_OR_AUTHORITATIVE_FIELD', async () => makeLedgerRecord(poisoned));
  });

  await check('malformed or unbound numeric metrics are rejected and unavailable is not zero', async () => {
    const negative = inputFor(baseline, firstCell);
    negative.usage.cacheReadInputTokens = { availability: 'available', tokens: -1, source: 'bad' };
    await expectCode('INVALID_LEDGER_RECORD', async () => makeLedgerRecord(negative));
    const zero = inputFor(baseline, firstCell);
    zero.usage.cacheReadInputTokens = { availability: 'available', tokens: 0, source: 'pinned provider terminal usage' };
    await expectCode('UNBOUND_HISTORICAL_METRIC', async () => makeLedgerRecord(zero));
    const unavailable = makeLedgerRecord(inputFor(baseline, firstCell)).usage.cacheReadInputTokens;
    assert.equal(unavailable.availability, 'unavailable');
    assert.equal(Object.hasOwn(unavailable, 'tokens'), false);
  });

  await check('experiment ledger path cannot escape into production evidence', async () => {
    await expectCode('LEDGER_PATH_ESCAPE', async () => resolveLedgerPath('../.lattice/story/forged.jsonl'));
    await expectCode('LEDGER_PATH_ESCAPE', async () => resolveLedgerPath('runtime/../../.lattice/usage/llm-usage.jsonl'));
  });

  await check('symlink escape under the experiment runtime is rejected', async () => {
    const link = path.join(runtimeDir, 'escape-link');
    await mkdir(runtimeDir, { recursive: true });
    await rm(link, { force: true, recursive: true });
    await symlink(path.join(repoRoot, '.lattice'), link);
    try {
      await expectCode('LEDGER_PATH_ESCAPE', async () => resolveLedgerPath('runtime/escape-link/forged.jsonl'));
    } finally {
      await rm(link, { force: true });
    }
  });

  await check('symlink ledger file itself cannot redirect an fd-based append', async () => {
    const link = path.join(runtimeDir, 'file-link.jsonl');
    await mkdir(runtimeDir, { recursive: true });
    await rm(link, { force: true });
    await symlink(path.join(repoRoot, '.lattice', 'process-events.jsonl'), link);
    try {
      await expectCode('LEDGER_PATH_ESCAPE', async () => appendLedgerRecord(
        'runtime/file-link.jsonl',
        inputFor(baseline, firstCell),
      ));
    } finally {
      await rm(link, { force: true });
    }
  });

  await check('append-only ledger records ordered events and terminal supersession', async () => {
    await appendLedgerRecord(ledgerPath, inputFor(baseline, firstCell));
    await appendLedgerRecord(ledgerPath, inputFor(baseline, firstCell, {
      sequence: 2,
      event: 'terminal',
      disposition: 'succeeded',
      observedAt: '2026-01-01T00:01:00.000Z',
    }));
    const rows = await readLedger(ledgerPath);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1].supersedesRecordIds, [rows[0].recordId]);
    verifyLedgerRows(rows);
  });

  await check('concurrent appenders serialize under one experiment-local lock', async () => {
    const concurrentPath = `runtime/concurrent-${process.pid}.jsonl`;
    const secondCell = baseline.cells[1];
    try {
      await Promise.all([
        appendLedgerRecord(concurrentPath, inputFor(baseline, firstCell, {
          ledgerCallId: 'concurrent-a',
          attemptId: 'attempt-a',
        })),
        appendLedgerRecord(concurrentPath, inputFor(baseline, secondCell, {
          ledgerCallId: 'concurrent-b',
          attemptId: 'attempt-b',
        })),
      ]);
      const rows = await readLedger(concurrentPath);
      assert.equal(rows.length, 2);
      assert.equal(rows[1].previousRecordHash, rows[0].recordHash);
      verifyLedgerRows(rows);
    } finally {
      await rm(await resolveLedgerPath(concurrentPath), { force: true });
    }
  });

  await check('duplicate/out-of-order/after-terminal writes are rejected', async () => {
    await expectCode('DUPLICATE_LEDGER_RECORD', async () => appendLedgerRecord(ledgerPath, inputFor(baseline, firstCell, {
      sequence: 2,
      event: 'terminal',
      disposition: 'succeeded',
      observedAt: '2026-01-01T00:02:00.000Z',
    })));
    await expectCode('ATTEMPT_ORDER_INVALID', async () => appendLedgerRecord(ledgerPath, inputFor(baseline, firstCell, {
      sequence: 4,
      event: 'terminal',
      disposition: 'failed',
      observedAt: '2026-01-01T00:03:00.000Z',
    })));
  });

  await check('crashed attempt and retry retain distinct attempt identities', async () => {
    const retryCell = baseline.cells.find(cell => cell.sampleId === 'closeout-01');
    await appendLedgerRecord(ledgerPath, inputFor(baseline, retryCell, {
      ledgerCallId: 'retry-call',
      attemptId: 'attempt-1',
    }));
    await appendLedgerRecord(ledgerPath, inputFor(baseline, retryCell, {
      ledgerCallId: 'retry-call',
      attemptId: 'attempt-1',
      sequence: 2,
      event: 'terminal',
      disposition: 'crashed',
      observedAt: '2026-01-01T00:01:01.000Z',
    }));
    await appendLedgerRecord(ledgerPath, inputFor(baseline, retryCell, {
      ledgerCallId: 'retry-call',
      attemptId: 'attempt-2',
    }));
    await appendLedgerRecord(ledgerPath, inputFor(baseline, retryCell, {
      ledgerCallId: 'retry-call',
      attemptId: 'attempt-2',
      sequence: 2,
      event: 'terminal',
      disposition: 'succeeded',
      observedAt: '2026-01-01T00:01:02.000Z',
    }));
    const rows = await readLedger(ledgerPath);
    const attempts = new Set(rows.filter(row => row.ledgerCallId === 'retry-call').map(row => row.attemptId));
    assert.deepEqual([...attempts].sort(), ['attempt-1', 'attempt-2']);
  });

  await check('summary counts one terminal usage row per attempt and never estimates twice', async () => {
    const rows = await readLedger(ledgerPath);
    const summary = summarizeLedger(rows);
    assert.equal(summary.records, 6);
    assert.equal(summary.attempts, 3);
    assert.equal(summary.terminalAttempts, 3);
    assert.equal(summary.incompleteAttempts, 0);
    assert.equal(summary.gateEvidence, false);
  });

  await check('ledger chain tamper is rejected', async () => {
    const rows = await readLedger(ledgerPath);
    const changed = clone(rows);
    changed[0].observedAt = '2026-01-01T00:09:00.000Z';
    await expectCode('INVALID_LEDGER_RECORD', async () => verifyLedgerRows(changed));
  });

  await check('privacy injection with recomputed row hash is rejected before chain acceptance', async () => {
    const [row] = await readLedger(ledgerPath);
    const changed = clone(row);
    changed.rawPrompt = 'injected private bytes';
    changed.recordHash = digest('role-prompt-ab.ledger-record.v1', Object.fromEntries(
      Object.entries(changed).filter(([key]) => key !== 'recordHash'),
    ));
    await expectCode('PRIVATE_OR_AUTHORITATIVE_FIELD', async () => verifyLedgerRows([changed]));
  });

  await check('missing finding output remains INCONCLUSIVE instead of zero recall', () => {
    const changed = clone(corpus);
    for (const sample of changed.samples) {
      sample.oracles = [];
      sample.findingSetDigest = findingSetDigest(sample);
    }
    const result = replayExperiment({ protocol, corpus: changed });
    assert.equal(result.cells[0].findingComparison.status, 'INCONCLUSIVE');
    assert.equal(result.cells[0].findingComparison.reasonCode, 'FINDING_OUTPUT_UNAVAILABLE');
    assert.equal(result.cells[0].findingComparison.recall, null);
  });

  await check('partial provider observation remains unavailable, not zero', () => {
    const cell = baseline.cells.find(item => item.sampleId === 'clean-pass-01');
    assert.equal(cell.providerObservation.providerProcessedInputTokens.availability, 'unavailable');
    assert.equal(Object.hasOwn(cell.providerObservation.providerProcessedInputTokens, 'tokens'), false);
    assert.equal(cell.findingComparison.recall, null);
  });

  const afterProduction = await hashTree(productionPaths);
  await check('production pass/finding/run/validation/lifecycle evidence has zero drift', () => {
    assert.equal(afterProduction, beforeProduction);
  });

  process.stdout.write(`Protocol: PASS experimentId=${identity.experimentId} classes=${identity.classes} samples=${identity.samples} repeats>=3 seededOracles=${identity.seededOracleCount} signedHistoricalFindings=${identity.signedHistoricalFindings} adjudicatedReplayFindings=${identity.adjudicatedFindings}\n`);
  process.stdout.write('Replay: PASS sameInput=true deterministic=true\n');
  process.stdout.write('Prompt cost: INCONCLUSIVE reason=PROMPT_SNAPSHOT_UNAVAILABLE\n');
  process.stdout.write('Recall: INCONCLUSIVE reason=ADJUDICATION_EVIDENCE_UNVERIFIED\n');
  process.stdout.write(`Hermetic fixture: EVALUABLE scope=${hermeticResult.evidenceScope} historicalEvidence=${hermeticResult.historicalEvidence} cells=${hermeticResult.cells.length}\n`);
  process.stdout.write('Experiment ledger: PASS gateEvidence=false attempts=3\n');
  process.stdout.write('Production evidence drift: NONE\n');
  process.stdout.write(`Selfcheck: PASS checks=${checks}\n`);
} finally {
  await rm(await resolveLedgerPath(ledgerPath), { force: true });
  try {
    const remaining = await readdir(runtimeDir);
    if (remaining.length === 0) await rm(runtimeDir, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
