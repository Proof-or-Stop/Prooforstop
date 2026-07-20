#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(here, 'runtime', 'story6');
const campaignId = `selfcheck-provenance-${process.pid}`;
const cell = { sampleId: 'clean-pass-01', host: 'codex-cli', arm: 'legacy', repeat: 1, roleId: 'lattice-review-story-init', cellId: 'clean-pass-01.lattice-review-story-init.codex-cli.legacy.r1' };
const forged = {
  schemaVersion: 'proofbound.story6-live-ab-receipt.v1', campaignId,
  campaignBindingDigest: 'a'.repeat(64), cell,
  promptDigest: 'b'.repeat(64), materialDigest: 'c'.repeat(64), findingSetDigest: 'd'.repeat(64),
  observedAt: '2026-01-01T00:00:00.000Z',
  provenance: { kind: 'synthetic-forged', gateEvidence: false },
  provider: { availability: 'unavailable' },
};
await mkdir(runtime, { recursive: true });
const file = path.join(runtime, `${campaignId}.${cell.cellId}.json`);
try {
  await writeFile(file, `${JSON.stringify(forged)}\n`);
  await assert.rejects(
    exec(process.execPath, [path.join(here, 'story6-analyze.mjs'), `--campaign-id=${campaignId}`]),
    error => /RECEIPT_PROVENANCE_INVALID/.test(error?.stdout ?? '') || /INCONCLUSIVE/.test(error?.stderr ?? ''),
  );
  console.log('story6-analyze-selfcheck: PASS (forged provenance rejected)');
} finally {
  await rm(file, { force: true });
}
