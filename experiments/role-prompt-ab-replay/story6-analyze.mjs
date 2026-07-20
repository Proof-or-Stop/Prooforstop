#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(HERE, 'runtime', 'story6');
const EXPECTED_SAMPLES = ['clean-pass-01', 'clean-pass-02', 'critical-01', 'critical-02', 'closeout-01', 'closeout-02'];
const EXPECTED_ARMS = ['legacy', 'modular'];
const EXPECTED_HOSTS = ['codex-cli', 'claude-cli'];
const EXPECTED_REPEATS = [1, 2, 3];

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function parseArgs(argv) {
  const options = { campaignId: null, adjudication: null };
  for (const arg of argv) {
    if (arg.startsWith('--campaign-id=')) options.campaignId = arg.slice(14);
    else if (arg.startsWith('--adjudication=')) options.adjudication = arg.slice(15);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.campaignId) throw new Error('--campaign-id is required');
  return options;
}

function expectedKeys() {
  const keys = [];
  for (const sampleId of EXPECTED_SAMPLES) for (const host of EXPECTED_HOSTS) {
    for (const arm of EXPECTED_ARMS) for (const repeat of EXPECTED_REPEATS) keys.push(`${sampleId}|${host}|${arm}|${repeat}`);
  }
  return keys;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = (await readdir(RUNTIME).catch(() => []))
    .filter(file => file.startsWith(`${options.campaignId}.`) && file.endsWith('.json'));
  const receipts = await Promise.all(files.map(async file => JSON.parse(await readFile(path.join(RUNTIME, file), 'utf8'))));
  const byKey = new Map(receipts.map(row => [`${row.cell.sampleId}|${row.cell.host}|${row.cell.arm}|${row.cell.repeat}`, row]));
  const receiptCellIds = receipts.map(row => row.cell.cellId);
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
  const adjudicationValid = adjudication?.schemaVersion === 'proofbound.story6-independent-adjudication.v1'
    && adjudication.campaignId === options.campaignId
    && typeof adjudication.adjudicatorId === 'string'
    && adjudication.adjudicatorId.trim().length > 0
    && !['main', 'main-agent', 'lattice-implementer'].includes(adjudication.adjudicatorId.trim())
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
  if (unavailableDimensions.length) reasonCodes.push('PROVIDER_USAGE_UNAVAILABLE');
  if (!adjudicationValid) reasonCodes.push('ADJUDICATION_EVIDENCE_UNVERIFIED');
  const status = reasonCodes.length ? 'INCONCLUSIVE' : 'EVALUABLE';
  const result = {
    schemaVersion: 'proofbound.story6-live-ab-analysis.v1',
    campaignId: options.campaignId,
    status,
    reasonCodes,
    receiptCount: receipts.length,
    expectedReceiptCount: 72,
    missingCells,
    unavailableDimensions,
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
