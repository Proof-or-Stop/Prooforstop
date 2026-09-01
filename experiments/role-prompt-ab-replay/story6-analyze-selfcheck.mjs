#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(here, 'runtime', 'story6');
const campaignId = `selfcheck-provenance-${process.pid}`;
const corpus = JSON.parse(await readFile(path.join(here, 'corpus.json'), 'utf8'));
const sample = corpus.samples.find(row => row.id === 'clean-pass-01');
const baseCell = { sampleId: sample.id, host: 'codex-cli', arm: 'legacy', repeat: 1, roleId: 'proof-or-stop-review-story-init', cellId: 'clean-pass-01.proof-or-stop-review-story-init.codex-cli.legacy.r1' };
const base = () => ({
  schemaVersion: 'proofbound.story6-live-ab-receipt.v1', campaignId,
  campaignBindingDigest: 'a'.repeat(64), cell: { ...baseCell },
  promptDigest: 'b'.repeat(64), materialDigest: sample.materialDigest, findingSetDigest: sample.findingSetDigest,
  observedAt: '2026-07-20T00:00:00.000Z',
  provenance: {
    kind: 'production-provider-dispatch', producer: 'agent_prompt',
    producerMode: 'legacy-full-context', producerResponseDigest: 'c'.repeat(64),
    envelopeId: null, eventBinding: null, gateEvidence: false,
  },
  provider: { availability: 'unavailable' },
});

async function runRejected(name, mutate, duplicate = false) {
  const files = await readdir(runtime).catch(() => []);
  await Promise.all(files.filter(file => file.startsWith(`${campaignId}.`)).map(file => rm(path.join(runtime, file), { force: true })));
  const first = base();
  const firstFileCellId = first.cell.cellId;
  mutate(first);
  await writeFile(path.join(runtime, `${campaignId}.${firstFileCellId}.json`), `${JSON.stringify(first)}\n`);
  if (duplicate) {
    const second = base();
    second.cell.cellId = `${second.cell.cellId}.duplicate`;
    await writeFile(path.join(runtime, `${campaignId}.${second.cell.cellId}.json`), `${JSON.stringify(second)}\n`);
  }
  await assert.rejects(
    exec(process.execPath, [path.join(here, 'story6-analyze.mjs'), `--campaign-id=${campaignId}`]),
    error => /RECEIPT_PROVENANCE_INVALID/.test(error?.stdout ?? ''),
    `mutation ${name} must be rejected`,
  );
}

async function runBindingMismatchRejected() {
  const files = await readdir(runtime).catch(() => []);
  await Promise.all(files.filter(file => file.startsWith(`${campaignId}.`)).map(file => rm(path.join(runtime, file), { force: true })));
  const first = base();
  const second = base();
  second.cell.repeat = 2;
  second.cell.cellId = second.cell.cellId.replace(/\.r1$/, '.r2');
  second.campaignBindingDigest = 'c'.repeat(64);
  await writeFile(path.join(runtime, `${campaignId}.${first.cell.cellId}.json`), `${JSON.stringify(first)}\n`);
  await writeFile(path.join(runtime, `${campaignId}.${second.cell.cellId}.json`), `${JSON.stringify(second)}\n`);
  await assert.rejects(
    exec(process.execPath, [path.join(here, 'story6-analyze.mjs'), `--campaign-id=${campaignId}`]),
    error => /RECEIPT_PROVENANCE_INVALID/.test(error?.stdout ?? '')
      && /campaignBindingDigest mismatch/.test(error?.stdout ?? ''),
    'valid-looking receipts from different campaign bindings must be rejected',
  );
}

async function runModularProducerRejected(name, mutate) {
  const files = await readdir(runtime).catch(() => []);
  await Promise.all(files.filter(file => file.startsWith(`${campaignId}.`)).map(file => rm(path.join(runtime, file), { force: true })));
  const receipt = base();
  receipt.cell.arm = 'modular';
  receipt.cell.cellId = receipt.cell.cellId.replace('.legacy.', '.modular.');
  receipt.provenance.producerMode = 'full-envelope';
  receipt.provenance.envelopeId = 'd'.repeat(64);
  receipt.provenance.eventBinding = { promptEnvelopeId: 'd'.repeat(64), assembledPromptDigest: 'e'.repeat(64) };
  mutate(receipt);
  await writeFile(path.join(runtime, `${campaignId}.${receipt.cell.cellId}.json`), `${JSON.stringify(receipt)}\n`);
  await assert.rejects(
    exec(process.execPath, [path.join(here, 'story6-analyze.mjs'), `--campaign-id=${campaignId}`]),
    error => /RECEIPT_PROVENANCE_INVALID/.test(error?.stdout ?? ''),
    `modular producer mutation ${name} must be rejected`,
  );
}

async function runAdjudicationBoundaryAccepted() {
  const files = await readdir(runtime).catch(() => []);
  await Promise.all(files.filter(file => file.startsWith(`${campaignId}.`)).map(file => rm(path.join(runtime, file), { force: true })));
  const receipt = base();
  const receiptPath = path.join(runtime, `${campaignId}.${receipt.cell.cellId}.json`);
  const adjudicationPath = path.join(runtime, `${campaignId}.independent-adjudication.json`);
  const adjudication = {
    schemaVersion: 'proofbound.story6-independent-adjudication.v1',
    campaignId,
    adjudicatorId: 'independent-schema-selfcheck',
    method: 'deterministic boundary selfcheck',
    evidenceDigest: 'd'.repeat(64),
    cells: [{
      cellId: receipt.cell.cellId,
      oracleResults: [],
      falsePositiveCount: 0,
      commandMisuseCount: 0,
    }],
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  await writeFile(adjudicationPath, `${JSON.stringify(adjudication)}\n`);
  await assert.rejects(
    exec(process.execPath, [
      path.join(here, 'story6-analyze.mjs'),
      `--campaign-id=${campaignId}`,
      `--adjudication=${adjudicationPath}`,
    ]),
    error => {
      const result = JSON.parse(error?.stdout ?? '{}');
      return result.receiptCount === 1
        && !result.reasonCodes.includes('RECEIPT_PROVENANCE_INVALID')
        && result.independentAdjudication?.adjudicatorId === adjudication.adjudicatorId;
    },
    'the legal colocated adjudication artifact must not be consumed as receipt #2',
  );
}

async function runUnknownReceiptFileRejected() {
  const files = await readdir(runtime).catch(() => []);
  await Promise.all(files.filter(file => file.startsWith(`${campaignId}.`)).map(file => rm(path.join(runtime, file), { force: true })));
  const receipt = base();
  await writeFile(path.join(runtime, `${campaignId}.${receipt.cell.cellId}.json`), `${JSON.stringify(receipt)}\n`);
  await writeFile(path.join(runtime, `${campaignId}.forged-receipt.json`), `${JSON.stringify(receipt)}\n`);
  await assert.rejects(
    exec(process.execPath, [path.join(here, 'story6-analyze.mjs'), `--campaign-id=${campaignId}`]),
    error => /RECEIPT_PROVENANCE_INVALID/.test(error?.stdout ?? '')
      && /unknown campaign artifact filename/.test(error?.stdout ?? ''),
    'an extra receipt-looking JSON file must fail closed instead of being ignored',
  );
}

await mkdir(runtime, { recursive: true });
try {
  const mutations = [
    ['schemaVersion', row => { row.schemaVersion = 'forged.v0'; }],
    ['campaignId', row => { row.campaignId = 'other-campaign'; }],
    ['bindingDigest', row => { row.campaignBindingDigest = 'short'; }],
    ['role', row => { row.cell.roleId = 'proof-or-stop-evaluator'; }],
    ['sample', row => { row.cell.sampleId = 'critical-01'; }],
    ['arm', row => { row.cell.arm = 'forged'; }],
    ['host', row => { row.cell.host = 'forged-cli'; }],
    ['repeat', row => { row.cell.repeat = 9; }],
    ['promptDigest', row => { row.promptDigest = 'short'; }],
    ['materialDigest', row => { row.materialDigest = '0'.repeat(64); }],
    ['findingDigest', row => { row.findingSetDigest = '0'.repeat(64); }],
    ['productionProvenance', row => { row.provenance.kind = 'synthetic-forged'; }],
    ['directCoreProducer', row => { row.provenance.producer = 'direct-core-assembly'; }],
    ['producerMode', row => { row.provenance.producerMode = 'full-envelope'; }],
    ['producerResponseDigest', row => { row.provenance.producerResponseDigest = 'short'; }],
    ['observedAt', row => { row.observedAt = 'not-a-date'; }],
    ['staleReceipt', row => { delete row.observedAt; }],
    ['missingCell', row => { delete row.cell; }],
  ];
  for (const [name, mutate] of mutations) await runRejected(name, mutate);
  await runRejected('duplicate-cell-key', row => { row.cell.cellId = baseCell.cellId; }, true);
  await runBindingMismatchRejected();
  await runModularProducerRejected('missing-event', row => { row.provenance.eventBinding = null; });
  await runModularProducerRejected('wrong-event-envelope', row => { row.provenance.eventBinding.promptEnvelopeId = 'f'.repeat(64); });
  await runModularProducerRejected('wrong-event-digest', row => { row.provenance.eventBinding.assembledPromptDigest = 'short'; });
  await runModularProducerRejected('missing-envelope', row => { row.provenance.envelopeId = null; });
  await runAdjudicationBoundaryAccepted();
  await runUnknownReceiptFileRejected();
  console.log(`story6-analyze-selfcheck: PASS (${mutations.length + 7} receipt mutations rejected; agent_prompt producer/event binding enforced)`);
} finally {
  const files = await readdir(runtime).catch(() => []);
  await Promise.all(files.filter(file => file.startsWith(`${campaignId}.`)).map(file => rm(path.join(runtime, file), { force: true })));
}
