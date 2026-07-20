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
const baseCell = { sampleId: sample.id, host: 'codex-cli', arm: 'legacy', repeat: 1, roleId: 'lattice-review-story-init', cellId: 'clean-pass-01.lattice-review-story-init.codex-cli.legacy.r1' };
const base = () => ({
  schemaVersion: 'proofbound.story6-live-ab-receipt.v1', campaignId,
  campaignBindingDigest: 'a'.repeat(64), cell: { ...baseCell },
  promptDigest: 'b'.repeat(64), materialDigest: sample.materialDigest, findingSetDigest: sample.findingSetDigest,
  observedAt: '2026-07-20T00:00:00.000Z',
  provenance: { kind: 'production-provider-dispatch', gateEvidence: false },
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

await mkdir(runtime, { recursive: true });
try {
  const mutations = [
    ['schemaVersion', row => { row.schemaVersion = 'forged.v0'; }],
    ['campaignId', row => { row.campaignId = 'other-campaign'; }],
    ['bindingDigest', row => { row.campaignBindingDigest = 'short'; }],
    ['role', row => { row.cell.roleId = 'lattice-evaluator'; }],
    ['sample', row => { row.cell.sampleId = 'critical-01'; }],
    ['arm', row => { row.cell.arm = 'forged'; }],
    ['host', row => { row.cell.host = 'forged-cli'; }],
    ['repeat', row => { row.cell.repeat = 9; }],
    ['promptDigest', row => { row.promptDigest = 'short'; }],
    ['materialDigest', row => { row.materialDigest = '0'.repeat(64); }],
    ['findingDigest', row => { row.findingSetDigest = '0'.repeat(64); }],
    ['productionProvenance', row => { row.provenance.kind = 'synthetic-forged'; }],
    ['observedAt', row => { row.observedAt = 'not-a-date'; }],
    ['staleReceipt', row => { delete row.observedAt; }],
    ['missingCell', row => { delete row.cell; }],
  ];
  for (const [name, mutate] of mutations) await runRejected(name, mutate);
  await runRejected('duplicate-cell-key', row => { row.cell.cellId = baseCell.cellId; }, true);
  await runBindingMismatchRejected();
  console.log(`story6-analyze-selfcheck: PASS (${mutations.length + 2} receipt mutations rejected)`);
} finally {
  const files = await readdir(runtime).catch(() => []);
  await Promise.all(files.filter(file => file.startsWith(`${campaignId}.`)).map(file => rm(path.join(runtime, file), { force: true })));
}
