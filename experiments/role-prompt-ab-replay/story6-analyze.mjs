#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCanonicalStory6Provenance, isCanonicalStory6Provenance } from './lib/story6-provenance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(HERE, 'runtime', 'story6');
const EXPECTED_SAMPLES = ['clean-pass-01', 'clean-pass-02', 'critical-01', 'critical-02', 'closeout-01', 'closeout-02'];
const EXPECTED_ARMS = ['legacy', 'modular'];
const EXPECTED_HOSTS = ['codex-cli', 'claude-cli'];
const EXPECTED_REPEATS = [1, 2, 3];
const EXPECTED_ROLES = new Set([
  'proof-or-stop-review-story-init', 'proof-or-stop-review-scope-plan', 'proof-or-stop-implementer',
  'proof-or-stop-review-delivery', 'proof-or-stop-evaluator',
]);
const SAMPLE_ROLE = Object.freeze({
  'clean-pass-01': 'proof-or-stop-review-story-init',
  'clean-pass-02': 'proof-or-stop-review-scope-plan',
  'critical-01': 'proof-or-stop-implementer',
  'critical-02': 'proof-or-stop-evaluator',
  'closeout-01': 'proof-or-stop-review-delivery',
  'closeout-02': 'proof-or-stop-implementer',
});

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function parseArgs(argv) {
  const options = { campaignId: null, adjudication: null, provenanceSelfcheck: null };
  for (const arg of argv) {
    if (arg.startsWith('--campaign-id=')) options.campaignId = arg.slice(14);
    else if (arg.startsWith('--adjudication=')) options.adjudication = arg.slice(15);
    else if (arg.startsWith('--provenance-selfcheck=')) options.provenanceSelfcheck = path.resolve(arg.slice(23));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.campaignId && !options.provenanceSelfcheck) throw new Error('--campaign-id is required');
  return options;
}

function expectedKeys() {
  const keys = [];
  for (const sampleId of EXPECTED_SAMPLES) for (const host of EXPECTED_HOSTS) {
    for (const arm of EXPECTED_ARMS) for (const repeat of EXPECTED_REPEATS) keys.push(`${sampleId}|${host}|${arm}|${repeat}`);
  }
  return keys;
}

function expectedReceiptFileNames(campaignId) {
  const names = new Set();
  for (const sampleId of EXPECTED_SAMPLES) for (const host of EXPECTED_HOSTS) {
    for (const arm of EXPECTED_ARMS) for (const repeat of EXPECTED_REPEATS) {
      names.add(`${campaignId}.${sampleId}.${SAMPLE_ROLE[sampleId]}.${host}.${arm}.r${repeat}.json`);
    }
  }
  return names;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.provenanceSelfcheck) {
    const probes = JSON.parse(await readFile(options.provenanceSelfcheck, 'utf8'));
    if (!Array.isArray(probes) || probes.length !== 2) throw new Error('provenance selfcheck requires exactly two arm probes');
    for (const probe of probes) assertCanonicalStory6Provenance(probe?.provenance, `analyze/${probe?.arm}`);
    process.stdout.write(`story6-analyze provenance selfcheck: PASS arms=${probes.length}\n`);
    return;
  }
  const campaignFiles = (await readdir(RUNTIME).catch(() => []))
    .filter(file => file.startsWith(`${options.campaignId}.`) && file.endsWith('.json'));
  const expectedReceiptFiles = expectedReceiptFileNames(options.campaignId);
  const adjudicationFile = `${options.campaignId}.independent-adjudication.json`;
  const files = campaignFiles.filter(file => expectedReceiptFiles.has(file));
  const fileBoundaryErrors = campaignFiles
    .filter(file => !expectedReceiptFiles.has(file) && file !== adjudicationFile)
    .map(file => `unknown campaign artifact filename: ${file}`);
  if (campaignFiles.includes(adjudicationFile)) {
    try {
      const candidate = JSON.parse(await readFile(path.join(RUNTIME, adjudicationFile), 'utf8'));
      if (candidate?.schemaVersion !== 'proof-or-stop.story6-independent-adjudication.v1'
          || candidate?.campaignId !== options.campaignId) {
        fileBoundaryErrors.push(`invalid independent adjudication artifact: ${adjudicationFile}`);
      }
    } catch {
      fileBoundaryErrors.push(`invalid independent adjudication artifact: ${adjudicationFile}`);
    }
  }
  const receipts = await Promise.all(files.map(async file => JSON.parse(await readFile(path.join(RUNTIME, file), 'utf8'))));
  const corpus = JSON.parse(await readFile(path.join(HERE, 'corpus.current.json'), 'utf8'));
  const samples = new Map(corpus.samples.map(sample => [sample.id, sample]));
  const byKey = new Map();
  let campaignBindingDigest = null;
  const provenanceErrors = [...fileBoundaryErrors];
  for (const [index, row] of receipts.entries()) {
    const cell = row?.cell;
    const key = cell && `${cell.sampleId}|${cell.host}|${cell.arm}|${cell.repeat}`;
    const expectedSample = cell && samples.get(cell.sampleId);
    const requiredDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const valid = row?.schemaVersion === 'proof-or-stop.story6-live-ab-receipt.v1'
      && row.campaignId === options.campaignId
      && cell && typeof cell.cellId === 'string'
      && EXPECTED_ROLES.has(cell.roleId)
      && cell.roleId === SAMPLE_ROLE[cell.sampleId]
      && EXPECTED_HOSTS.includes(cell.host) && EXPECTED_ARMS.includes(cell.arm)
      && EXPECTED_REPEATS.includes(cell.repeat)
      && row.campaignBindingDigest && requiredDigest(row.campaignBindingDigest)
      && row.promptDigest && requiredDigest(row.promptDigest)
      && row.materialDigest && requiredDigest(row.materialDigest)
      && row.findingSetDigest && requiredDigest(row.findingSetDigest)
      && isCanonicalStory6Provenance(row.provenance)
      && typeof row.observedAt === 'string' && !Number.isNaN(Date.parse(row.observedAt))
      && expectedSample && row.materialDigest === expectedSample.materialDigest
      && row.findingSetDigest === expectedSample.findingSetDigest;
    if (!valid) provenanceErrors.push(`${index}: invalid production receipt provenance`);
    if (row?.campaignBindingDigest && campaignBindingDigest === null) campaignBindingDigest = row.campaignBindingDigest;
    if (campaignBindingDigest !== null && row?.campaignBindingDigest !== campaignBindingDigest) provenanceErrors.push(`${index}: campaignBindingDigest mismatch`);
    if (key && byKey.has(key)) provenanceErrors.push(`${index}: duplicate cell key`);
    if (key) byKey.set(key, row);
  }
  const receiptCellIds = receipts.map(row => row?.cell?.cellId).filter(cellId => typeof cellId === 'string');
  if (new Set(receiptCellIds).size !== receiptCellIds.length) throw new Error('duplicate receipt cellId');
  const missingCells = expectedKeys().filter(key => !byKey.has(key));
  const unavailableDimensions = [];
  for (const [key, row] of byKey) {
    if (row.provider?.availability !== 'available') unavailableDimensions.push(`${key}:provider`);
    for (const dimension of ['inputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens', 'outputTokens', 'latencyMs']) {
      if (row.provider?.[dimension] === null || row.provider?.[dimension] === undefined) unavailableDimensions.push(`${key}:${dimension}`);
    }
  }
  let adjudication = null;
  if (options.adjudication) adjudication = JSON.parse(await readFile(path.resolve(options.adjudication), 'utf8'));
  const adjudicationCellIds = Array.isArray(adjudication?.cells) ? adjudication.cells.map(row => row.cellId) : [];
  const exactAdjudicationCells = adjudicationCellIds.length === receiptCellIds.length
    && new Set(adjudicationCellIds).size === adjudicationCellIds.length
    && [...adjudicationCellIds].sort().join('\n') === [...receiptCellIds].sort().join('\n');
  const adjudicationValid = adjudication?.schemaVersion === 'proof-or-stop.story6-independent-adjudication.v1'
    && adjudication.campaignId === options.campaignId
    && typeof adjudication.adjudicatorId === 'string'
    && adjudication.adjudicatorId.trim().length > 0
    && !['main', 'main-agent', 'proof-or-stop-implementer'].includes(adjudication.adjudicatorId.trim())
    && typeof adjudication.method === 'string'
    && adjudication.method.trim().length > 0
    && typeof adjudication.evidenceDigest === 'string'
    && /^[a-f0-9]{64}$/.test(adjudication.evidenceDigest)
    && Array.isArray(adjudication.cells)
    && exactAdjudicationCells
    && adjudication.cells.every(row =>
      typeof row.cellId === 'string'
      && Array.isArray(row.oracleResults)
      && row.oracleResults.every(result =>
        typeof result.oracleId === 'string'
        && ['detected', 'not-detected', 'not-applicable'].includes(result.verdict)
        && typeof result.evidence === 'string'
        && result.evidence.trim().length > 0)
      && Number.isSafeInteger(row.falsePositiveCount)
      && row.falsePositiveCount >= 0
      && Number.isSafeInteger(row.commandMisuseCount)
      && row.commandMisuseCount >= 0);
  const reasonCodes = [];
  if (missingCells.length) reasonCodes.push('REPEAT_FLOOR_INCOMPLETE');
  if (provenanceErrors.length) reasonCodes.push('RECEIPT_PROVENANCE_INVALID');
  if (unavailableDimensions.length) reasonCodes.push('PROVIDER_USAGE_UNAVAILABLE');
  if (!adjudicationValid) reasonCodes.push('ADJUDICATION_EVIDENCE_UNVERIFIED');
  const status = reasonCodes.length ? 'INCONCLUSIVE' : 'EVALUABLE';
  const result = {
    schemaVersion: 'proof-or-stop.story6-live-ab-analysis.v1',
    campaignId: options.campaignId,
    status,
    reasonCodes,
    receiptCount: receipts.length,
    expectedReceiptCount: 72,
    missingCells,
    unavailableDimensions,
    provenanceErrors,
    independentAdjudication: adjudicationValid ? { adjudicatorId: adjudication.adjudicatorId, digest: digest(adjudication) } : null,
    savingsClaim: null,
    recallClaim: null,
    gateEvidence: false,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (status === 'INCONCLUSIVE') process.exitCode = 2;
}

main().catch(error => {
  process.stderr.write(`story6-analyze: INCONCLUSIVE ${error.message}\n`);
  process.exitCode = 2;
});
