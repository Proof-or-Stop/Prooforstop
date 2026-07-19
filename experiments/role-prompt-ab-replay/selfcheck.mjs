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
  findingSetDigest,
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
  const unavailable = reason => ({ availability: 'unavailable', reason });
  return {
    assembledPromptTokens: { availability: 'available', tokens: cell.measurement.estimatedTokens, source: 'selfcheck canonical replay' },
    knownDispatchInputTokens: cell.providerObservation.knownDispatchInputTokens,
    providerProcessedInputTokens: cell.providerObservation.providerProcessedInputTokens,
    uncachedInputTokens: cell.providerObservation.uncachedInputTokens ?? unavailable('No separate uncached historical dimension.'),
    cacheCreationInputTokens: cell.providerObservation.cacheCreationInputTokens,
    cacheReadInputTokens: cell.providerObservation.cacheReadInputTokens,
    outputTokens: unavailable('No output-token observation in the pinned corpus.'),
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
      seededCount: cell.findingComparison.seededCount,
      detectedCount: cell.findingComparison.detectedCount,
      status: cell.findingComparison.status,
    },
    ...overrides,
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

  await check('pinned protocol has 3 classes, 6 samples, >=3 repeats and adjudicated findings', () => {
    identity = validateExperiment(protocol, corpus);
    assert.equal(identity.classes, 3);
    assert.equal(identity.samples, 6);
    assert.ok(identity.repeats >= 3);
    assert.ok(identity.adjudicatedFindings >= 4);
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

  await check('missing independent adjudication is rejected', async () => {
    const changed = clone(corpus);
    changed.samples[2].oracles[0].adjudication.evidenceRef = '';
    changed.samples[2].findingSetDigest = findingSetDigest(changed.samples[2]);
    await expectCode('ADJUDICATION_MISSING', async () => validateExperiment(protocol, changed));
  });

  await check('unavailable controls carry reasons and never masquerade as zero', () => {
    for (const key of ['temperature', 'providerSeed', 'toolChoice']) {
      assert.equal(protocol.sampling[key].availability, 'unavailable');
      assert.ok(protocol.sampling[key].reason.length > 10);
      assert.equal(Object.hasOwn(protocol.sampling[key], 'tokens'), false);
    }
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

  await check('meaningful model change changes input and prompt digests', () => {
    const changedProtocol = clone(protocol);
    changedProtocol.model.modelId = 'historical-observation-only.v2';
    const changed = replayExperiment({ protocol: changedProtocol, corpus });
    assert.notEqual(changed.cells[0].inputDigest, baseline.cells[0].inputDigest);
    assert.notEqual(changed.cells[0].measurement.promptDigest, baseline.cells[0].measurement.promptDigest);
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
    traversal.samples[0].material.repositoryPath = '../.lattice/story/actives/B-8d4b/index.json';
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

  await check('malformed counts are rejected while reported zero remains available', async () => {
    const negative = inputFor(baseline, firstCell);
    negative.usage.cacheReadInputTokens = { availability: 'available', tokens: -1, source: 'bad' };
    await expectCode('INVALID_LEDGER_RECORD', async () => makeLedgerRecord(negative));
    const zero = inputFor(baseline, firstCell);
    zero.usage.cacheReadInputTokens = { availability: 'available', tokens: 0, source: 'pinned provider terminal usage' };
    assert.equal(makeLedgerRecord(zero).usage.cacheReadInputTokens.tokens, 0);
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

  await check('symlink ledger file itself cannot redirect an append', async () => {
    const link = path.join(runtimeDir, 'file-link.jsonl');
    await mkdir(runtimeDir, { recursive: true });
    await rm(link, { force: true });
    await symlink(path.join(repoRoot, '.lattice', 'process-events.jsonl'), link);
    try {
      await expectCode('LEDGER_PATH_ESCAPE', async () => resolveLedgerPath('runtime/file-link.jsonl'));
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
    changed[0].promptDigest = '0'.repeat(64);
    await expectCode('LEDGER_CHAIN_BROKEN', async () => verifyLedgerRows(changed));
  });

  await check('invalid finding denominator is rejected rather than reported as zero recall', async () => {
    const changed = clone(corpus);
    for (const sample of changed.samples) {
      sample.oracles = [];
      sample.observedFindingsByArm = { A: [], B: [] };
      sample.findingSetDigest = findingSetDigest(sample);
    }
    await expectCode('RECALL_DENOMINATOR_INVALID', async () => validateExperiment(protocol, changed));
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

  process.stdout.write(`Protocol: PASS experimentId=${identity.experimentId} classes=${identity.classes} samples=${identity.samples} repeats>=3 adjudicatedFindings=${identity.adjudicatedFindings}\n`);
  process.stdout.write('Replay: PASS sameInput=true deterministic=true\n');
  process.stdout.write('Recall: EVALUABLE seeded critical/high denominator is independently adjudicated\n');
  process.stdout.write('Recall: INCONCLUSIVE reason=MATERIAL_DIGEST_MISMATCH (tamper probe)\n');
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
