#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJsonStringify } from '../../packages/main/dist/core/prompt-contracts.js';
import { validateExperiment } from './lib/replay.mjs';
import { deriveClaudeCompatibleSchema } from './lib/story6-schema-compat.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNTIME = path.join(HERE, 'runtime', 'story6');
const EXPECTED_SAMPLES = ['clean-pass-01', 'clean-pass-02', 'critical-01', 'critical-02', 'closeout-01', 'closeout-02'];
const EXPECTED_HOSTS = ['codex-cli', 'claude-cli'];
const EXPECTED_ARMS = ['legacy', 'modular'];
const EXPECTED_REPEATS = [1, 2, 3];
const ROLE_ASSIGNMENT = Object.freeze({
  'clean-pass-01': 'proof-or-stop-review-story-init',
  'clean-pass-02': 'proof-or-stop-review-scope-plan',
  'critical-01': 'proof-or-stop-implementer',
  'critical-02': 'proof-or-stop-evaluator',
  'closeout-01': 'proof-or-stop-review-delivery',
  'closeout-02': 'proof-or-stop-implementer',
});
const TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Bash']);
const ORDER = Object.freeze([
  ['legacy', 'modular'],
  ['modular', 'legacy'],
  ['legacy', 'modular'],
]);
const METRICS = ['promptBytes', 'inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'outputTokens', 'latencyMs'];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function boundDigest(domain, value) {
  return createHash('sha256')
    .update(`proofbound.story6-ab.v1\0${domain}\0`, 'utf8')
    .update(typeof value === 'string' ? value : canonicalJsonStringify(value), 'utf8')
    .digest('hex');
}

function parseArgs(argv) {
  const options = { campaignId: null, adjudication: null, runtimeDir: DEFAULT_RUNTIME, output: null, verify: null };
  for (const arg of argv) {
    if (arg.startsWith('--campaign-id=')) options.campaignId = arg.slice(14);
    else if (arg.startsWith('--adjudication=')) options.adjudication = path.resolve(arg.slice(15));
    else if (arg.startsWith('--runtime-dir=')) options.runtimeDir = path.resolve(arg.slice(14));
    else if (arg.startsWith('--output=')) options.output = path.resolve(arg.slice(9));
    else if (arg.startsWith('--verify=')) options.verify = path.resolve(arg.slice(9));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.campaignId || !options.adjudication) throw new Error('--campaign-id and --adjudication are required');
  if (Boolean(options.output) === Boolean(options.verify)) throw new Error('choose exactly one of --output or --verify');
  return options;
}

function expectedCells() {
  const cells = [];
  for (const sampleId of EXPECTED_SAMPLES) for (const host of EXPECTED_HOSTS) {
    for (const arm of EXPECTED_ARMS) for (const repeat of EXPECTED_REPEATS) {
      const roleId = ROLE_ASSIGNMENT[sampleId];
      cells.push({
        cellId: `${sampleId}.${roleId}.${host}.${arm}.r${repeat}`,
        sampleId, roleId, host, arm, repeat,
      });
    }
  }
  return cells;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function assertFiniteMetric(value, label, nullable = true) {
  if (nullable && value === null) return;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number${nullable ? ' or null' : ''}`);
}

function aggregateMetric(values) {
  const available = values.filter(value => value !== null);
  if (available.length === 0) return { availableCount: 0, unavailableCount: values.length, sum: null, min: null, max: null, mean: null };
  const sum = available.reduce((total, value) => total + value, 0);
  return {
    availableCount: available.length,
    unavailableCount: values.length - available.length,
    sum,
    min: Math.min(...available),
    max: Math.max(...available),
    mean: Number((sum / available.length).toFixed(3)),
  };
}

function merkleRoot(entries) {
  let level = entries.map(entry => sha256(`proofbound.story6-receipt-leaf.v1\0${entry.cellId}\0${entry.sha256}`));
  if (level.length === 0) throw new Error('cannot compute an empty receipt Merkle root');
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      next.push(sha256(`proofbound.story6-receipt-node.v1\0${left}\0${right}`));
    }
    level = next;
  }
  return level[0];
}

function validateSummaryPolicy(summary) {
  if (summary.status !== 'INCONCLUSIVE') throw new Error('Story 6 report must remain INCONCLUSIVE');
  if (summary.baselineAccepted !== false) throw new Error('baselineAccepted must be false for INCONCLUSIVE or regressed results');
  if (summary.claims?.savingsClaim !== null
      || summary.claims?.recallNonRegressionClaim !== false
      || summary.claims?.enforceReady !== false) {
    throw new Error('INCONCLUSIVE Story 6 report cannot assert savings, recall non-regression, or enforce readiness');
  }
  if (summary.story7?.implemented !== false) throw new Error('Story 7 must remain explicitly unimplemented');
}

async function buildReport(options) {
  const protocol = JSON.parse(await readFile(path.join(HERE, 'protocol.json'), 'utf8'));
  const corpus = JSON.parse(await readFile(path.join(HERE, 'corpus.json'), 'utf8'));
  const identity = validateExperiment(protocol, corpus);
  const canonicalSchemaText = await readFile(path.join(HERE, 'story6-output.schema.json'), 'utf8');
  const canonicalSchema = JSON.parse(canonicalSchemaText);
  const claudeSchema = deriveClaudeCompatibleSchema(canonicalSchema);
  const expected = expectedCells();
  const expectedNames = new Set(expected.map(cell => `${options.campaignId}.${cell.cellId}.json`));
  const campaignFiles = (await readdir(options.runtimeDir))
    .filter(file => file.startsWith(`${options.campaignId}.`) && file.endsWith('.json'));
  const adjudicationName = `${options.campaignId}.independent-adjudication.json`;
  const unknown = campaignFiles.filter(file => !expectedNames.has(file) && file !== adjudicationName);
  if (unknown.length) throw new Error(`unknown campaign artifact filename: ${unknown.sort().join(', ')}`);
  const missing = [...expectedNames].filter(file => !campaignFiles.includes(file));
  if (missing.length) throw new Error(`missing campaign cell: ${missing[0]} (${missing.length} missing)`);

  const receiptEntries = [];
  const receipts = [];
  for (const expectedCell of expected) {
    const file = `${options.campaignId}.${expectedCell.cellId}.json`;
    const raw = await readFile(path.join(options.runtimeDir, file));
    const row = JSON.parse(raw.toString('utf8'));
    const sample = corpus.samples.find(candidate => candidate.id === expectedCell.sampleId);
    if (row.schemaVersion !== 'proofbound.story6-live-ab-receipt.v1'
        || row.campaignId !== options.campaignId
        || row.cell?.cellId !== expectedCell.cellId
        || row.cell?.sampleId !== expectedCell.sampleId
        || row.cell?.sampleClass !== sample?.class
        || row.cell?.roleId !== expectedCell.roleId
        || row.cell?.host !== expectedCell.host
        || row.cell?.arm !== expectedCell.arm
        || row.cell?.repeat !== expectedCell.repeat
        || row.provenance?.kind !== 'production-provider-dispatch'
        || row.provenance?.producer !== 'agent_prompt'
        || row.provenance?.producerMode !== (expectedCell.arm === 'modular' ? 'full-envelope' : 'legacy-full-context')
        || typeof row.provenance?.producerResponseDigest !== 'string'
        || !/^[a-f0-9]{64}$/.test(row.provenance.producerResponseDigest)
        || (expectedCell.arm === 'modular'
          ? typeof row.provenance?.envelopeId !== 'string'
            || !/^[a-f0-9]{64}$/.test(row.provenance.envelopeId)
            || row.provenance?.eventBinding?.promptEnvelopeId !== row.provenance.envelopeId
            || typeof row.provenance?.eventBinding?.assembledPromptDigest !== 'string'
            || !/^[a-f0-9]{64}$/.test(row.provenance.eventBinding.assembledPromptDigest)
          : row.provenance?.envelopeId !== null || row.provenance?.eventBinding !== null)
        || row.provenance?.gateEvidence !== false
        || row.gateEvidence !== false
        || typeof row.observedAt !== 'string'
        || Number.isNaN(Date.parse(row.observedAt))
        || row.outcome !== 'PENDING_INDEPENDENT_ADJUDICATION') {
      throw new Error(`invalid production receipt provenance: ${expectedCell.cellId}`);
    }
    for (const [label, value] of [['campaignBindingDigest', row.campaignBindingDigest], ['promptDigest', row.promptDigest], ['materialDigest', row.materialDigest], ['findingSetDigest', row.findingSetDigest]]) assertDigest(value, `${expectedCell.cellId}.${label}`);
    if (!sample || row.materialDigest !== sample.materialDigest || row.findingSetDigest !== sample.findingSetDigest) throw new Error(`corpus binding mismatch: ${expectedCell.cellId}`);
    if (!Array.isArray(row.toolPolicy) || canonicalJsonStringify(row.toolPolicy) !== canonicalJsonStringify(TOOLS)) throw new Error(`tool policy mismatch: ${expectedCell.cellId}`);
    if (typeof row.model !== 'string' || row.model.length === 0) throw new Error(`model missing: ${expectedCell.cellId}`);
    if (!row.provider || row.provider.availability !== 'available') throw new Error(`provider unavailable: ${expectedCell.cellId}`);
    assertFiniteMetric(row.promptBytes, `${expectedCell.cellId}.promptBytes`, false);
    for (const metric of METRICS.slice(1)) assertFiniteMetric(row.provider[metric] ?? null, `${expectedCell.cellId}.${metric}`);
    receiptEntries.push({ cellId: expectedCell.cellId, sha256: sha256(raw) });
    receipts.push(row);
  }

  const bindingDigests = [...new Set(receipts.map(row => row.campaignBindingDigest))];
  if (bindingDigests.length !== 1) throw new Error('campaignBindingDigest mismatch across receipts');
  const models = Object.fromEntries(EXPECTED_HOSTS.map(host => {
    const values = [...new Set(receipts.filter(row => row.cell.host === host).map(row => row.model))];
    if (values.length !== 1) throw new Error(`model mismatch within ${host}`);
    return [host, values[0]];
  }));
  const protocolBinding = {
    schemaVersion: 'proofbound.story6-live-ab.v1',
    protocolDigest: identity.protocolDigest,
    corpusDigest: identity.corpusDigest,
    hosts: EXPECTED_HOSTS,
    arms: EXPECTED_ARMS,
    repetitions: EXPECTED_REPEATS.length,
    roleAssignment: ROLE_ASSIGNMENT,
    tools: TOOLS,
    order: ORDER,
    sampling: {
      temperature: { availability: 'unavailable', reason: 'Codex CLI and Claude CLI do not expose one shared temperature control in this harness.' },
      providerSeed: { availability: 'unavailable', reason: 'Neither pinned CLI surface exposes one shared deterministic provider seed.' },
    },
    outputSchemaDigest: boundDigest('output-schema', canonicalSchemaText),
    claudeCompatibleOutputSchemaDigest: boundDigest('claude-compatible-output-schema', claudeSchema),
    promptProducer: 'agent_prompt-audit-experiment.v1',
    gateEvidence: false,
  };
  const campaignBinding = { ...protocolBinding, campaignId: options.campaignId, models };
  if (bindingDigests[0] !== boundDigest('campaign-binding', campaignBinding)) throw new Error('campaign binding does not match pinned protocol/corpus/model/tool/order/schema inputs');

  const adjudicationRaw = await readFile(options.adjudication);
  const adjudication = JSON.parse(adjudicationRaw.toString('utf8'));
  if (adjudication.schemaVersion !== 'proofbound.story6-independent-adjudication.v1'
      || adjudication.campaignId !== options.campaignId
      || typeof adjudication.adjudicatorId !== 'string'
      || ['main', 'main-agent', 'proof-or-stop-implementer'].includes(adjudication.adjudicatorId.trim())
      || typeof adjudication.method !== 'string'
      || !Array.isArray(adjudication.cells)) throw new Error('invalid independent adjudication provenance');
  assertDigest(adjudication.evidenceDigest, 'adjudication.evidenceDigest');
  const adjudicationByCell = new Map(adjudication.cells.map(cell => [cell.cellId, cell]));
  if (adjudicationByCell.size !== expected.length || adjudication.cells.length !== expected.length) throw new Error('adjudication must cover exactly 72 unique cells');
  const distributions = Object.fromEntries(EXPECTED_ARMS.map(arm => [arm, { detected: 0, notDetected: 0, notApplicable: 0, falsePositive: 0, explicitCommandMisuse: 0 }]));
  for (const receipt of receipts) {
    const cell = adjudicationByCell.get(receipt.cell.cellId);
    if (!cell || !['detected', 'not-detected', 'not-applicable'].includes(cell.oracleVerdict)
        || !Array.isArray(cell.oracleResults)
        || !cell.oracleResults.every(result => typeof result.oracleId === 'string' && ['detected', 'not-detected', 'not-applicable'].includes(result.verdict))
        || !Number.isSafeInteger(cell.falsePositiveCount) || cell.falsePositiveCount < 0
        || !Number.isSafeInteger(cell.commandMisuseCount) || cell.commandMisuseCount < 0) {
      throw new Error(`invalid adjudication cell: ${receipt.cell.cellId}`);
    }
    const row = distributions[receipt.cell.arm];
    if (cell.oracleVerdict === 'detected') row.detected += 1;
    else if (cell.oracleVerdict === 'not-detected') row.notDetected += 1;
    else row.notApplicable += 1;
    row.falsePositive += cell.falsePositiveCount;
    row.explicitCommandMisuse += cell.commandMisuseCount;
  }

  const aggregates = [];
  const roles = [...new Set(Object.values(ROLE_ASSIGNMENT))].sort();
  for (const host of EXPECTED_HOSTS) for (const arm of EXPECTED_ARMS) for (const roleId of roles) {
    const rows = receipts.filter(row => row.cell.host === host && row.cell.arm === arm && row.cell.roleId === roleId);
    aggregates.push({
      host, arm, roleId,
      cellCount: rows.length,
      sampleCount: new Set(rows.map(row => row.cell.sampleId)).size,
      metrics: Object.fromEntries(METRICS.map(metric => [metric, aggregateMetric(rows.map(row => metric === 'promptBytes' ? row.promptBytes : row.provider[metric] ?? null))])),
    });
  }

  const legacy = distributions.legacy;
  const modular = distributions.modular;
  const report = {
    schemaVersion: 'proofbound.story6-content-addressed-summary.v1',
    campaignId: options.campaignId,
    status: 'INCONCLUSIVE',
    reasonCodes: ['RECALL_REGRESSION_OBSERVED', 'FALSE_POSITIVES_INCREASED', 'COMMAND_MISUSE_PARTIAL_OBSERVATION', 'STORY7_NOT_IMPLEMENTED'],
    gateEvidence: false,
    baselineAccepted: false,
    claims: { savingsClaim: null, recallNonRegressionClaim: false, enforceReady: false },
    story7: { implemented: false, note: 'Story 7 budget observe/warn rollout and its observation window have not been implemented.' },
    bindings: { campaignBindingDigest: bindingDigests[0], models, toolPolicy: TOOLS, order: ORDER, ...protocolBinding },
    coverage: {
      receipts: { observed: receipts.length, expected: 72 },
      hosts: EXPECTED_HOSTS,
      roles,
      sampleClasses: Object.fromEntries([...new Set(corpus.samples.map(sample => sample.class))].sort().map(sampleClass => [sampleClass, corpus.samples.filter(sample => sample.class === sampleClass).length])),
      arms: EXPECTED_ARMS,
      repetitionsPerSampleHostArm: EXPECTED_REPEATS.length,
    },
    usageAggregates: aggregates,
    providerLimitations: {
      codexCacheCreationInputTokens: { availability: 'unavailable', observedCells: receipts.filter(row => row.cell.host === 'codex-cli' && row.provider.cacheCreationInputTokens === null).length },
      commandMisuse: { availability: 'conservative-lower-bound-only', note: 'Receipts omit provider tool transcripts; only explicit blocked lifecycle-mutation attempts can be counted. Absence is not evidence of zero misuse.' },
    },
    adjudication: {
      fileSha256: sha256(adjudicationRaw),
      canonicalDigest: sha256(canonicalJsonStringify(adjudication)),
      evidenceDigest: adjudication.evidenceDigest,
      adjudicatorId: adjudication.adjudicatorId,
      cellCount: adjudication.cells.length,
      distributions,
      recall: {
        legacy: { detected: legacy.detected, applicable: legacy.detected + legacy.notDetected },
        modular: { detected: modular.detected, applicable: modular.detected + modular.notDetected },
      },
      falsePositive: { legacy: legacy.falsePositive, modular: modular.falsePositive },
    },
    receiptSet: {
      algorithm: 'sha256-merkle-v1',
      count: receiptEntries.length,
      merkleRoot: merkleRoot(receiptEntries),
      receipts: receiptEntries,
    },
  };
  report.aggregateDigest = sha256(canonicalJsonStringify({ usageAggregates: report.usageAggregates, adjudication: report.adjudication }));
  report.summaryDigest = sha256(canonicalJsonStringify(report));
  validateSummaryPolicy(report);
  if (report.adjudication.recall.modular.applicable !== report.adjudication.recall.legacy.applicable
      || report.adjudication.recall.modular.detected >= report.adjudication.recall.legacy.detected
      || report.adjudication.falsePositive.modular <= report.adjudication.falsePositive.legacy) {
    throw new Error('adjudication does not support the recorded recall-regression and false-positive-increase reason codes');
  }
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildReport(options);
  if (options.output) {
    await mkdir(path.dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`story6-report: WROTE ${options.output} summaryDigest=${report.summaryDigest}\n`);
    return;
  }
  const expected = JSON.parse(await readFile(options.verify, 'utf8'));
  validateSummaryPolicy(expected);
  const expectedDigest = expected.summaryDigest;
  const withoutDigest = { ...expected };
  delete withoutDigest.summaryDigest;
  if (expectedDigest !== sha256(canonicalJsonStringify(withoutDigest))) throw new Error('stored summaryDigest is invalid');
  if (canonicalJsonStringify(expected) !== canonicalJsonStringify(report)) throw new Error('tracked summary does not match current receipt/adjudication content');
  process.stdout.write(`story6-report: VERIFIED ${options.verify} summaryDigest=${report.summaryDigest}\n`);
}

main().catch(error => {
  process.stderr.write(`story6-report: REJECTED ${error.message}\n`);
  process.exitCode = 2;
});
