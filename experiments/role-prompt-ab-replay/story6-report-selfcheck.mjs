#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const campaignId = 'story6-20260720-v2';
const sourceRuntime = path.join(here, 'runtime', 'story6');
const reportScript = path.join(here, 'story6-report.mjs');
const temp = await mkdtemp(path.join(os.tmpdir(), 'proofbound-story6-report-'));
const runtime = path.join(temp, 'runtime');
const adjudication = path.join(runtime, `${campaignId}.independent-adjudication.json`);
const summary = path.join(temp, 'summary.json');

function args(mode) {
  return [reportScript, `--campaign-id=${campaignId}`, `--runtime-dir=${runtime}`, `--adjudication=${adjudication}`, `${mode}=${summary}`];
}

async function mustReject(label, pattern) {
  await assert.rejects(exec(process.execPath, args('--verify')), error => pattern.test(error?.stderr ?? ''), label);
}

function assertNoSensitivePayloadKeys(value) {
  const forbidden = new Set(['output', 'providerOutput', 'rawOutput', 'prompt', 'rawPrompt', 'transcript', 'credential', 'toolArguments']);
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitivePayloadKeys(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!forbidden.has(key), `summary must not persist sensitive payload field ${key}`);
    assertNoSensitivePayloadKeys(child);
  }
}

try {
  await cp(sourceRuntime, runtime, { recursive: true });
  await exec(process.execPath, args('--output'));
  await exec(process.execPath, args('--verify'));
  const generated = JSON.parse(await readFile(summary, 'utf8'));
  assert.equal(generated.coverage.receipts.observed, 72);
  assert.equal(generated.adjudication.recall.modular.detected, 12);
  assert.equal(generated.adjudication.recall.modular.applicable, 24);
  assert.equal(generated.adjudication.recall.legacy.detected, 16);
  assert.equal(generated.adjudication.recall.legacy.applicable, 24);
  assert.deepEqual(generated.adjudication.falsePositive, { legacy: 2, modular: 5 });
  assert.equal(generated.baselineAccepted, false);
  assert.equal(generated.claims.enforceReady, false);
  assert.equal(generated.story7.implemented, false);
  assertNoSensitivePayloadKeys(generated);

  const receiptFile = (await readdir(runtime)).find(file => file.includes('.codex-cli.modular.r1.json'));
  const receiptPath = path.join(runtime, receiptFile);
  const originalReceipt = await readFile(receiptPath, 'utf8');
  const forgedReceipt = JSON.parse(originalReceipt);
  forgedReceipt.promptBytes += 1;
  await writeFile(receiptPath, `${JSON.stringify(forgedReceipt)}\n`);
  await mustReject('forged receipt must invalidate the tracked report', /tracked summary does not match current receipt\/adjudication content/);
  await writeFile(receiptPath, originalReceipt);

  const originalAdjudication = await readFile(adjudication, 'utf8');
  const forgedAdjudication = JSON.parse(originalAdjudication);
  forgedAdjudication.cells[0].falsePositiveCount += 1;
  await writeFile(adjudication, `${JSON.stringify(forgedAdjudication)}\n`);
  await mustReject('forged adjudication must invalidate the tracked report', /tracked summary does not match current receipt\/adjudication content|observed adjudication distribution differs/);
  await writeFile(adjudication, originalAdjudication);

  await unlink(receiptPath);
  await mustReject('a missing campaign cell must fail closed', /missing campaign cell/);
  await writeFile(receiptPath, originalReceipt);

  const forgedSummary = JSON.parse(await readFile(summary, 'utf8'));
  forgedSummary.baselineAccepted = true;
  await writeFile(summary, `${JSON.stringify(forgedSummary)}\n`);
  await mustReject('INCONCLUSIVE/regressed evidence cannot accept a baseline', /baselineAccepted must be false/);

  console.log('story6-report-selfcheck: PASS (receipt/adjudication/cell/claim mutations rejected; no raw provider content persisted)');
} finally {
  await rm(temp, { recursive: true, force: true });
}
