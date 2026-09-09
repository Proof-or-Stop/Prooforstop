#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const campaignId = 'story6-20260721-v3';
const sourceRuntime = path.join(here, 'runtime', 'story6');
const reportScript = path.join(here, 'story6-report.mjs');
const temp = await mkdtemp(path.join(os.tmpdir(), 'proof-or-stop-story6-report-'));
const runtime = path.join(temp, 'runtime');
const adjudication = path.join(runtime, `${campaignId}.independent-adjudication.json`);
const summary = path.join(temp, 'summary.json');

function args(mode) {
  return [reportScript, `--campaign-id=${campaignId}`, `--runtime-dir=${runtime}`, `--adjudication=${adjudication}`, `${mode}=${summary}`];
}

try {
  await cp(sourceRuntime, runtime, { recursive: true });
  await assert.rejects(
    exec(process.execPath, args('--output')),
    error => /missing campaign cell|invalid production receipt provenance|binding/i.test(error?.stderr ?? ''),
    'the active report reader must reject the archived pre-cutover receipt set',
  );
  console.log('story6-report-selfcheck: PASS (archived pre-cutover receipts rejected by the active canonical reader)');
} finally {
  await rm(temp, { recursive: true, force: true });
}
