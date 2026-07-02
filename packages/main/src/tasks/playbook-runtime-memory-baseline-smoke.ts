#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  generatePlaybookRuntimeBaseline,
  runPlaybookRuntimeOptimizedParityReport,
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

function refreshManifest(outputDir: string, overrides: Record<string, unknown> = {}): void {
  const manifestPath = `${outputDir}/manifest.json`;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const domain = {
    schemaVersion: manifest.schemaVersion,
    profile: manifest.profile,
    seed: manifest.seed,
    recordCount: overrides.recordCount ?? manifest.recordCount,
    partitionCounts: overrides.partitionCounts ?? manifest.partitionCounts,
    fullProfileExactMillion: overrides.fullProfileExactMillion ?? manifest.fullProfileExactMillion,
    recordsDigest: digestText(readFileSync(`${outputDir}/records.jsonl`, 'utf8')),
    goldDigest: digestText(readFileSync(`${outputDir}/gold-queries.json`, 'utf8')),
    corruptRows: overrides.corruptRows ?? manifest.corruptRows,
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

function replaceRecord(outputDir: string, id: string, replacement: Record<string, unknown>): void {
  rewriteRecord(outputDir, id, () => replacement);
}

function removeGoldQuery(outputDir: string, queryId: string): void {
  const goldPath = `${outputDir}/gold-queries.json`;
  const gold = JSON.parse(readFileSync(goldPath, 'utf8')) as { queries?: Array<Record<string, unknown>> };
  const before = gold.queries?.length ?? 0;
  const queries = (gold.queries ?? []).filter((query) => query.id !== queryId);
  assert.equal(queries.length, before - 1, `expected to remove gold query ${queryId}`);
  writeFileSync(goldPath, `${JSON.stringify({ ...gold, queries }, null, 2)}\n`, 'utf8');
  refreshManifest(outputDir);
}

function assertBrokenCandidateWouldFail(): void {
  const generated = generatePlaybookRuntimeBaseline({ profile: 'small' });
  try {
    rewriteRecord(generated.outputDir, 'pb-candidate-only', (row) => ({ ...row, status: 'active' }));
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
    rewriteRecord(generated.outputDir, 'mem-superseded-default-current', (row) => {
      const next = { ...row };
      delete next.supersedes;
      return next;
    });
    const verified = verifyPlaybookRuntimeBaseline({ inputDir: generated.outputDir });
    assert.equal(verified.status, 'fail');
    assert.ok(verified.correctness.supersededFalseSurfaceRate > 0, 'unsuppressed superseded row must be counted as a false surface');
    assert.ok(verified.correctness.expectedSuppressedIdsFoundRate < 1, 'missing suppression evidence must fail the gold contract');
  } finally {
    if (existsSync(generated.outputDir)) rmSync(generated.outputDir, { recursive: true, force: true });
  }
}

function assertMissingCandidateOnlyClassWouldFail(): void {
  const generated = generatePlaybookRuntimeBaseline({ profile: 'small' });
  try {
    replaceRecord(generated.outputDir, 'pb-candidate-only', {
      id: 'noise-replaced-candidate-only',
      kind: 'playbook',
      status: 'candidate',
      partition: 'playbook-candidates',
      recordClass: 'noise',
      text: 'candidate replacement row keeps manifest self consistent but removes the required class',
    });
    const verified = verifyPlaybookRuntimeBaseline({ inputDir: generated.outputDir });
    assert.equal(verified.status, 'fail');
    assert.ok(verified.correctness.goldRecordPresenceRate < 1, 'required candidate-only gold record must be present');
  } finally {
    if (existsSync(generated.outputDir)) rmSync(generated.outputDir, { recursive: true, force: true });
  }
}

function assertBrokenDeprecatedBrandResidueWouldFail(): void {
  const generated = generatePlaybookRuntimeBaseline({ profile: 'small' });
  try {
    rewriteRecord(generated.outputDir, 'mem-deprecated-brand-current', (row) => {
      const next = { ...row };
      delete next.supersedes;
      return next;
    });
    const verified = verifyPlaybookRuntimeBaseline({ inputDir: generated.outputDir });
    assert.equal(verified.status, 'fail');
    assert.ok(verified.correctness.deprecatedFalseSurfaceRate > 0, 'deprecated brand residue must not surface as current guidance');
    assert.ok(verified.correctness.expectedSuppressedIdsFoundRate < 1, 'deprecated residue suppression must be recorded');
  } finally {
    if (existsSync(generated.outputDir)) rmSync(generated.outputDir, { recursive: true, force: true });
  }
}

function assertBrokenSourceDigestGoldWouldFail(): void {
  const generated = generatePlaybookRuntimeBaseline({ profile: 'small' });
  try {
    rewriteRecord(generated.outputDir, 'pb-source-mutation-active', (row) => ({ ...row, status: 'candidate' }));
    const verified = verifyPlaybookRuntimeBaseline({ inputDir: generated.outputDir });
    assert.equal(verified.status, 'fail');
    assert.ok(verified.correctness.expectedIdsFoundRate < 1, 'source-digest active playbook must surface for its gold query');
    assert.equal(verified.correctness.sourceDigestMutationMatrixPass, true, 'fixture break is separate from matrix mechanics');
  } finally {
    if (existsSync(generated.outputDir)) rmSync(generated.outputDir, { recursive: true, force: true });
  }
}

function assertMissingGoldQueryClassWouldFail(): void {
  const generated = generatePlaybookRuntimeBaseline({ profile: 'small' });
  try {
    removeGoldQuery(generated.outputDir, 'deprecated-brand-residue');
    const verified = verifyPlaybookRuntimeBaseline({ inputDir: generated.outputDir });
    assert.equal(verified.status, 'fail');
    assert.ok(verified.correctness.goldQueryPresenceRate < 1, 'required gold query classes must not be removable by refreshing the manifest');
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

function assertTruncatedSelfConsistentManifestWouldFail(): void {
  const generated = generatePlaybookRuntimeBaseline({ profile: 'small' });
  try {
    const recordsPath = `${generated.outputDir}/records.jsonl`;
    const truncated = readFileSync(recordsPath, 'utf8').split('\n').filter(Boolean).slice(0, 11).join('\n') + '\n';
    writeFileSync(recordsPath, truncated, 'utf8');
    refreshManifest(generated.outputDir, { recordCount: 11, corruptRows: 0 });
    const verified = verifyPlaybookRuntimeBaseline({ inputDir: generated.outputDir });
    assert.equal(verified.status, 'fail');
    assert.equal(verified.recordCount, 11);
    assert.equal(verified.expectedProfileRecordCount, 1_000);
    assert.equal(verified.profileRecordCountMatches, false);
  } finally {
    if (existsSync(generated.outputDir)) rmSync(generated.outputDir, { recursive: true, force: true });
  }
}

function assertRequestedProfileMismatchWouldFail(): void {
  const generated = generatePlaybookRuntimeBaseline({ profile: 'small' });
  try {
    const verified = verifyPlaybookRuntimeBaseline({ inputDir: generated.outputDir, profile: 'full' });
    assert.equal(verified.status, 'fail');
    assert.equal(verified.requestedProfile, 'full');
    assert.equal(verified.requestedProfileMatches, false);
  } finally {
    if (existsSync(generated.outputDir)) rmSync(generated.outputDir, { recursive: true, force: true });
  }
}

function assertGeneratorRefusesNonEmptyOutputDir(): void {
  const unrelatedDir = mkdtempSync(join(tmpdir(), 'proofbound-baseline-nonempty-'));
  const targetFileDir = mkdtempSync(join(tmpdir(), 'proofbound-baseline-target-file-'));
  try {
    writeFileSync(join(unrelatedDir, 'unrelated.txt'), 'occupied\n', 'utf8');
    assert.throws(
      () => generatePlaybookRuntimeBaseline({ profile: 'small', outputDir: unrelatedDir }),
      /must be empty unless force=true/,
    );
    writeFileSync(join(targetFileDir, 'records.jsonl'), 'occupied\n', 'utf8');
    assert.throws(
      () => generatePlaybookRuntimeBaseline({ profile: 'small', outputDir: targetFileDir }),
      /must be empty unless force=true|target file already exists/,
    );
  } finally {
    if (existsSync(unrelatedDir)) rmSync(unrelatedDir, { recursive: true, force: true });
    if (existsSync(targetFileDir)) rmSync(targetFileDir, { recursive: true, force: true });
  }
}

function assertGeneratedVerifyCleanupDefaults(): void {
  const cleaned = verifyPlaybookRuntimeBaseline({ profile: 'small' });
  assert.equal(cleaned.status, 'pass');
  assert.equal(cleaned.generatedInput, true);
  assert.equal(cleaned.generatedOutputKept, false);
  assert.equal(existsSync(cleaned.inputDir), false, 'generated verifier outputDir should be cleaned by default');

  const kept = verifyPlaybookRuntimeBaseline({ profile: 'small', keepGenerated: true });
  try {
    assert.equal(kept.status, 'pass');
    assert.equal(kept.generatedInput, true);
    assert.equal(kept.generatedOutputKept, true);
    assert.equal(existsSync(kept.inputDir), true, 'keepGenerated should preserve generated verifier outputDir');
  } finally {
    if (existsSync(kept.inputDir)) rmSync(kept.inputDir, { recursive: true, force: true });
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
    if (profile === 'small') {
      assert.equal(generated.manifest.recordCount, 1_000);
      assert.equal(generated.manifest.fullProfileExactMillion, false);
    }
    const verified = verifyPlaybookRuntimeBaseline({ inputDir: generated.outputDir });
    assert.equal(verified.status, 'pass');
    assert.equal(verified.authority, 'non_authoritative');
    assert.equal(verified.gateEvidence, false);
    assert.equal(verified.recordCount, generated.manifest.recordCount);
    assert.equal(verified.expectedProfileRecordCount, generated.manifest.recordCount);
    assert.equal(verified.profileRecordCountMatches, true);
    assert.equal(verified.requestedProfileMatches, true);
    assert.equal(verified.fullProfileExactMillionMatches, true);
    assert.equal(verified.recordsDigestStable, true);
    assert.equal(verified.goldDigestStable, true);
    assert.equal(verified.manifestDigestStable, true);
    assert.equal(verified.correctness.expectedIdsFoundRate, 1);
    assert.equal(verified.correctness.goldQueryPresenceRate, 1);
    assert.equal(verified.correctness.goldRecordPresenceRate, 1);
    assert.equal(verified.correctness.expectedSuppressedIdsFoundRate, 1);
    assert.equal(verified.correctness.expectedDeprecatedTermHitsFoundRate, 1);
    assert.equal(verified.correctness.candidateFalseSurfaceRate, 0);
    assert.equal(verified.correctness.supersededFalseSurfaceRate, 0);
    assert.equal(verified.correctness.deprecatedFalseSurfaceRate, 0);
    assert.equal(verified.correctness.currentOverSupersededPreferenceRate, 1);
    assert.equal(verified.correctness.partitionContractPass, true);
    assert.equal(verified.correctness.sourceDigestMutationMatrixPass, true);
    assert.deepEqual(verified.sourceDigestMutationMatrix, {
      projectMemoryRelevant: 'stale-relevant',
      projectMemoryIrrelevant: 'stale-irrelevant',
      globalMemoryRelevant: 'stale-relevant',
      globalMemoryIrrelevant: 'stale-irrelevant',
      playbookRelevant: 'stale-relevant',
      playbookIrrelevant: 'stale-irrelevant',
      signatureRegistryRelevant: 'stale-relevant',
      signatureRegistryIrrelevant: 'stale-irrelevant',
      initialSurfacePass: true,
      pass: true,
    });
    const optimizedParity = runPlaybookRuntimeOptimizedParityReport({ inputDir: generated.outputDir });
    assert.equal(optimizedParity.profile, verified.profile);
    assert.equal(optimizedParity.recordCount, generated.manifest.recordCount);
    assert.equal(optimizedParity.performancePolicy, 'report-first');
    assert.equal(optimizedParity.parityPass, true);
    assert.equal(optimizedParity.authority, 'non_authoritative');
    assert.equal(optimizedParity.gateEvidence, false);
    assert.match(optimizedParity.referenceResultDigest, /^[0-9a-f]{64}$/);
    assert.equal(optimizedParity.indexedColdResultDigest, optimizedParity.referenceResultDigest);
    assert.equal(optimizedParity.indexedWarmCacheResultDigest, optimizedParity.referenceResultDigest);
    assert.equal(typeof optimizedParity.referenceFullScanMs, 'number');
    assert.equal(typeof optimizedParity.indexedColdMs, 'number');
    assert.equal(typeof optimizedParity.indexedWarmCacheMs, 'number');
    assertBrokenCandidateWouldFail();
    assertBrokenSupersessionWouldFail();
    assertMissingCandidateOnlyClassWouldFail();
    assertBrokenDeprecatedBrandResidueWouldFail();
    assertBrokenSourceDigestGoldWouldFail();
    assertMissingGoldQueryClassWouldFail();
    assertGoldTamperWouldFail();
    assertTruncatedSelfConsistentManifestWouldFail();
    assertRequestedProfileMismatchWouldFail();
    assertGeneratorRefusesNonEmptyOutputDir();
    assertGeneratedVerifyCleanupDefaults();
    console.log([
      'playbook-runtime-memory baseline smoke passed',
      `profile=${verified.profile}`,
      `recordCount=${verified.recordCount}`,
      `fullProfileExactMillion=${verified.fullProfileExactMillion}`,
      `referenceFullScanMs=${optimizedParity.referenceFullScanMs}`,
      `indexedColdMs=${optimizedParity.indexedColdMs}`,
      `indexedWarmCacheMs=${optimizedParity.indexedWarmCacheMs}`,
      `performancePolicy=${optimizedParity.performancePolicy}`,
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
