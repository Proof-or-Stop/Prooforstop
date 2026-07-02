#!/usr/bin/env node

import { existsSync, rmSync } from 'node:fs';

import {
  generatePlaybookRuntimeBaseline,
  runPlaybookRuntimeOptimizedParityReport,
  verifyPlaybookRuntimeBaseline,
  type PlaybookRuntimeBaselineProfile,
} from '../core/playbook-runtime-baseline.js';

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

function targetWarmMsFromArgs(): number {
  const raw = argValue('--targetWarmMs');
  const parsed = raw ? Number.parseInt(raw, 10) : 2000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2000;
}

async function run(): Promise<void> {
  const profile = profileFromArgs();
  const targetWarmMs = targetWarmMsFromArgs();
  const generated = generatePlaybookRuntimeBaseline({ profile });
  try {
    const verified = verifyPlaybookRuntimeBaseline({ inputDir: generated.outputDir, profile });
    const report = runPlaybookRuntimeOptimizedParityReport({
      inputDir: generated.outputDir,
      profile,
      targetWarmMs,
    });
    const semanticPass = verified.status === 'pass'
      && verified.correctness.expectedIdsFoundRate === 1
      && verified.correctness.goldQueryPresenceRate === 1
      && verified.correctness.goldRecordPresenceRate === 1
      && verified.correctness.expectedSuppressedIdsFoundRate === 1
      && verified.correctness.expectedDeprecatedTermHitsFoundRate === 1
      && verified.correctness.candidateFalseSurfaceRate === 0
      && verified.correctness.supersededFalseSurfaceRate === 0
      && verified.correctness.deprecatedFalseSurfaceRate === 0
      && verified.correctness.currentOverSupersededPreferenceRate === 1
      && verified.correctness.partitionContractPass
      && verified.correctness.sourceDigestMutationMatrixPass;
    const advisoryPass = verified.authority === 'non_authoritative'
      && verified.gateEvidence === false
      && report.authority === 'non_authoritative'
      && report.gateEvidence === false;
    const performancePass = report.parityPass
      && report.indexedWarmCacheMs <= targetWarmMs
      && report.targetStatus === 'met';
    const statusLine = [
      semanticPass && advisoryPass && performancePass
        ? 'playbook-runtime-memory performance smoke passed'
        : 'playbook-runtime-memory performance smoke failed',
      `profile=${report.profile}`,
      `recordCount=${report.recordCount}`,
      `semanticParity=${semanticPass ? 'pass' : 'fail'}`,
      `parityPass=${report.parityPass}`,
      `referenceResultDigest=${report.referenceResultDigest}`,
      `optimizedResultDigest=${report.indexedWarmCacheResultDigest}`,
      `referenceFullScanMs=${report.referenceFullScanMs}`,
      `indexedColdMs=${report.indexedColdMs}`,
      `indexedWarmCacheMs=${report.indexedWarmCacheMs}`,
      `targetWarmMs=${report.targetWarmMs}`,
      `targetStatus=${report.targetStatus}`,
      `p50WarmMs=${report.latency.p50Ms}`,
      `p95WarmMs=${report.latency.p95Ms}`,
      `peakRssBytes=${report.performance.peakRssBytes}`,
      `cacheHitRate=${report.cacheHitRate.toFixed(3)}`,
      `warmCacheHits=${report.warmCacheStats.hits}`,
      `exactFastPathHits=${report.timingBreakdown.tokenMatching.indexedCold.exactFastPathHits}`,
      `fuzzyIndexHits=${report.timingBreakdown.tokenMatching.indexedCold.fuzzyIndexHits}`,
      `fuzzyFallbacks=${report.timingBreakdown.tokenMatching.indexedCold.fuzzyFallbacks}`,
      `tokenScanFallbacks=${report.timingBreakdown.tokenMatching.indexedCold.tokenScanFallbacks}`,
      `indexBuildMs=${report.timingBreakdown.indexBuildMs}`,
      `performancePolicy=${report.performancePolicy}`,
      `authority=${report.authority}`,
      `gateEvidence=${report.gateEvidence}`,
    ].join(' ');
    console.log(statusLine);
    if (!semanticPass || !advisoryPass || !performancePass) process.exitCode = 1;
  } finally {
    if (existsSync(generated.outputDir)) rmSync(generated.outputDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
