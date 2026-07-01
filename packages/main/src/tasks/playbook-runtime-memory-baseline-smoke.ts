#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import {
  generatePlaybookRuntimeBaseline,
  verifyPlaybookRuntimeBaseline,
  type PlaybookRuntimeBaselineProfile,
} from '../core/playbook-runtime-baseline.js';
import { digestCanonicalJson, digestText } from '../core/digest.js';

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function profileFromArgs(): PlaybookRuntimeBaselineProfile {
  const raw = argValue('--profile');
  return raw === 'full' ? 'full' : 'small';
}

function refreshManifest(outputDir: string): void {
  const manifestPath = `${outputDir}/manifest.json`;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const domain = {
    schemaVersion: manifest.schemaVersion,
    profile: manifest.profile,
    seed: manifest.seed,
    recordCount: manifest.recordCount,
    fullProfileExactMillion: manifest.fullProfileExactMillion,
    recordsDigest: digestText(readFileSync(`${outputDir}/records.jsonl`, 'utf8')),
    goldDigest: digestText(readFileSync(`${outputDir}/gold-queries.json`, 'utf8')),
    corruptRows: manifest.corruptRows,
    authority: manifest.authority,
    gateEvidence: manifest.gateEvidence,
  };
  writeFileSync(manifestPath, `${JSON.stringify({ ...domain, manifestDigest: digestCanonicalJson(domain) }, null, 2)}\n`, 'utf8');
}

function rewriteRecord(outputDir: string, id: string, update: (row: Record<string, unknown>) => Record<string, unknown>): void {
  const recordsPath = `${outputDir}/records.jsonl`;
  const lines = readFileSync(recordsPath, 'utf8').split('\n');
  let changed = false;
  const rewritten = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.id !== id) return line;
      changed = true;
      return JSON.stringify(update(row));
    } catch {
      return line;
    }
  }).join('\n');
  assert.equal(changed, true, `expected to rewrite baseline row ${id}`);
  writeFileSync(recordsPath, rewritten, 'utf8');
  refreshManifest(outputDir);
}

function assertBrokenCandidateWouldFail(): void {
  const generated = generatePlaybookRuntimeBaseline({ profile: 'small' });
  try {
    rewriteRecord(generated.outputDir, 'pb-host-policy-candidate', (row) => ({ ...row, status: 'active' }));
    const verified = verifyPlaybookRuntimeBaseline({ inputDir: generated.outputDir });
    assert.equal(verified.status, 'fail');
    assert.ok(verified.correctness.candidateFalseSurfaceRate > 0, 'active candidate row must be counted as a false surface');
  } finally {
    if (existsSync(generated.outputDir)) rmSync(generated.outputDir, { recursive: true, force: true });
  }
}

function assertBrokenSupersessionWouldFail(): void {
  const generated = generatePlaybookRuntimeBaseline({ profile: 'small' });
  try {
    rewriteRecord(generated.outputDir, 'mem-truth-current', (row) => {
      const next = { ...row };
      delete next.supersedes;
      return next;
    });
    const verified = verifyPlaybookRuntimeBaseline({ inputDir: generated.outputDir });
    assert.equal(verified.status, 'fail');
    assert.ok(verified.correctness.supersededFalseSurfaceRate > 0, 'unsuppressed superseded row must be counted as a false surface');
  } finally {
    if (existsSync(generated.outputDir)) rmSync(generated.outputDir, { recursive: true, force: true });
  }
}

function assertGoldTamperWouldFail(): void {
  const generated = generatePlaybookRuntimeBaseline({ profile: 'small' });
  try {
    const goldPath = `${generated.outputDir}/gold-queries.json`;
    const gold = JSON.parse(readFileSync(goldPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(goldPath, `${JSON.stringify({ ...gold, tampered: true }, null, 2)}\n`, 'utf8');
    const verified = verifyPlaybookRuntimeBaseline({ inputDir: generated.outputDir });
    assert.equal(verified.status, 'fail');
    assert.equal(verified.staleDetected, true);
    assert.equal(verified.goldDigestStable, false);
    assert.equal(verified.recordsDigestStable, true);
    assert.equal(verified.manifestDigestStable, true, 'manifest stays stable; gold file digest drift must fail verification');
  } finally {
    if (existsSync(generated.outputDir)) rmSync(generated.outputDir, { recursive: true, force: true });
  }
}

async function run(): Promise<void> {
  const profile = profileFromArgs();
  const generated = generatePlaybookRuntimeBaseline({ profile });
  try {
    assert.equal(generated.manifest.authority, 'non_authoritative');
    assert.equal(generated.manifest.gateEvidence, false);
    assert.match(generated.manifest.manifestDigest, /^[0-9a-f]{64}$/);
    if (profile === 'full') {
      assert.equal(generated.manifest.recordCount, 1_000_000);
      assert.equal(generated.manifest.fullProfileExactMillion, true);
    }
    const verified = verifyPlaybookRuntimeBaseline({ inputDir: generated.outputDir });
    assert.equal(verified.status, 'pass');
    assert.equal(verified.authority, 'non_authoritative');
    assert.equal(verified.gateEvidence, false);
    assert.equal(verified.recordCount, generated.manifest.recordCount);
    assert.equal(verified.recordsDigestStable, true);
    assert.equal(verified.goldDigestStable, true);
    assert.equal(verified.manifestDigestStable, true);
    assert.equal(verified.correctness.expectedIdsFoundRate, 1);
    assert.equal(verified.correctness.candidateFalseSurfaceRate, 0);
    assert.equal(verified.correctness.supersededFalseSurfaceRate, 0);
    assert.equal(verified.correctness.currentOverSupersededPreferenceRate, 1);
    assertBrokenCandidateWouldFail();
    assertBrokenSupersessionWouldFail();
    assertGoldTamperWouldFail();
    console.log([
      'playbook-runtime-memory baseline smoke passed',
      `profile=${verified.profile}`,
      `recordCount=${verified.recordCount}`,
      `fullProfileExactMillion=${verified.fullProfileExactMillion}`,
      `elapsedMs=${verified.performance.elapsedMs}`,
      `peakRssBytes=${verified.performance.peakRssBytes}`,
    ].join(' '));
  } finally {
    if (existsSync(generated.outputDir)) rmSync(generated.outputDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
