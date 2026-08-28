#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyHistoricalReplayArtifact } from '../core/historical-replay-artifact.js';
import { compileValidationCatalog, discoverValidationInventory, signPayload, stableDigest } from '../core/story-aware-validation.js';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function signed<T extends Record<string, unknown>>(body: T): T & { signature: string } {
  return { ...body, signature: signPayload(body) };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function buildReport(root: string): { report: Record<string, unknown>; paired: Record<string, unknown> } {
  const head = git(root, ['rev-parse', 'HEAD']);
  const inventory = discoverValidationInventory(root);
  const catalog = compileValidationCatalog(inventory);
  const pairedRuns = [
    [1, 'full'], [1, 'dynamic'], [2, 'dynamic'], [2, 'full'], [3, 'full'], [3, 'dynamic'],
  ].map(([pair, mode]) => ({ pair, mode, allPass: true, commandCount: 1, verdicts: [{ label: 'smoke', code: 0 }], wallTimeMs: 1, residue: [] }));
  const paired = signed({
    schema: 'proof-or-stop.dynamic-validation.paired-performance.v1',
    head,
    inventoryDigest: inventory.digest,
    catalogDigest: stableDigest(catalog),
    selectionDigest: 'selection', dependencyGraphDigest: 'graph', closureCertificateSetDigest: 'closure',
    canonicalBaselineEpochId: head, toolchainDigest: 'toolchain', revocationLedgerDigest: 'revocations',
    selectedCommandIds: ['validation-smoke'], selectedCount: 1, executedCount: 1, reusedCount: 0, unverifiedCount: 0,
    order: 'full-dynamic / dynamic-full / full-dynamic', runs: pairedRuns,
    medianWallTimeMs: 1, resourceTimelineDigest: 'timeline', perCommandEquivalent: true, verdictEquivalent: true,
  });
  const records = Array.from({ length: 50 }, (_, index) => {
    const storyId = `B-replay-${String(index + 1).padStart(2, '0')}`;
    const receipt = (mode: 'full' | 'dynamic') => signed({
      schema: 'proof-or-stop.dynamic-validation.replay-command-receipt.v1',
      storyId, baseHead: head, head, mode, allPass: true,
    });
    return {
      storyId, baseHead: head, head,
      selectedCommandIds: ['validation-smoke'], selectedCount: 1, reusedCount: 0, fullEscalated: false, dependencyGraphDigest: 'graph',
      execution: {
        selectedCount: 1, reusedCount: 0, fullEscalated: false, dependencyGraphDigest: 'graph',
        perCommandEquivalent: true, residue: [], fullFailures: [],
        receipts: [receipt('full'), receipt('dynamic')],
      },
    };
  });
  const faultRows = ['FI-1', 'FI-2', 'FI-3', 'FI-4', 'FI-5'].map((fiId) => ({ fiId, passed: true }));
  const faultInjection = signed({
    schema: 'proof-or-stop.dynamic-validation.fault-injection.v1',
    rows: faultRows, requiredFamilies: ['FI-1', 'FI-2', 'FI-3', 'FI-4', 'FI-5'],
    familyCounts: Object.fromEntries(faultRows.map((row) => [row.fiId, 1])), allPass: true,
    digest: stableDigest(faultRows), path: 'fault-injection.json',
  });
  const report = signed({
    schema: 'proof-or-stop.dynamic-validation.historical-replay.v1',
    generatedAt: new Date().toISOString(), root, execute: true, storyCount: records.length,
    categories: ['smoke'], recordsDigest: stableDigest(records), records, historicalVerdictDriftCount: 0,
    replayExecution: { resumeRequested: true, repairMissingRequested: true, resumedHistoricalRecords: 50, reexecutedHistoricalRecords: 0 },
    faultInjection,
    admissibility: { execute: true, pairedRequested: true, admissible: true, reasons: [] },
    pairedPerformance: paired,
  });
  return { report, paired };
}

const root = mkdtempSync(join(tmpdir(), 'historical-replay-artifact-smoke-'));
const outputRoot = join(root, '.proof-or-stop', 'runtime', 'dynamic-validation', 'historical-replay');
const reportPath = join(outputRoot, 'report.json');
const pairedPath = join(outputRoot, 'paired-performance.json');
try {
  writeJson(join(root, 'proof-or-stop.config.json'), {
    validate: {
      commands: [{
        id: 'validation-smoke', label: 'validation smoke', command: 'node', args: ['smoke.js'],
        assurance: 'story-selectable', riskTier: 'local', closurePolicy: 'static-and-traced',
        fullBaselineReusePolicy: 'not-applicable', resources: [],
      }],
    },
  });
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'replay@example.test']);
  git(root, ['config', 'user.name', 'Replay Artifact Smoke']);
  git(root, ['add', 'proof-or-stop.config.json']);
  git(root, ['commit', '-m', 'seed replay artifact smoke']);
  mkdirSync(outputRoot, { recursive: true });

  const valid = buildReport(root);
  writeJson(reportPath, valid.report);
  writeJson(pairedPath, valid.paired);
  assert.equal(verifyHistoricalReplayArtifact(root).ok, true, 'a current complete signed report is admitted without executing a replay');

  rmSync(reportPath);
  const missing = verifyHistoricalReplayArtifact(root);
  assert.equal(missing.ok, false);
  assert.ok(missing.reasons.includes('historical-replay-report-missing'), 'missing report fails closed');

  writeJson(reportPath, valid.report);
  const tampered = { ...valid.report, storyCount: 51 };
  writeJson(reportPath, tampered);
  const tamperedResult = verifyHistoricalReplayArtifact(root);
  assert.equal(tamperedResult.ok, false);
  assert.ok(tamperedResult.reasons.includes('historical-replay-report-signature-invalid'), 'tampered report signature is rejected');

  writeJson(reportPath, valid.report);
  writeJson(pairedPath, { ...valid.paired, signature: 'not-a-valid-signature' });
  const invalidPair = verifyHistoricalReplayArtifact(root);
  assert.equal(invalidPair.ok, false);
  assert.ok(invalidPair.reasons.includes('paired-performance-signature-invalid'), 'tampered paired artifact signature is rejected');

  writeJson(pairedPath, valid.paired);
  const metadataPath = join(root, '.proof-or-stop', 'story', 'actives', 'B-smoke', 'checklist.json');
  mkdirSync(join(root, '.proof-or-stop', 'story', 'actives', 'B-smoke'), { recursive: true });
  writeJson(metadataPath, { id: 'B-smoke', refreshedAt: '2026-08-29T00:00:00.000Z' });
  git(root, ['add', '.proof-or-stop/story/actives/B-smoke/checklist.json']);
  git(root, ['commit', '-m', 'record story verification evidence']);
  assert.equal(
    verifyHistoricalReplayArtifact(root).ok,
    true,
    'a signed replay remains admissible across committed Proof-or-Stop story metadata only',
  );

  writeFileSync(join(root, 'validation-subject.ts'), 'export const changed = true;\n');
  git(root, ['add', 'validation-subject.ts']);
  git(root, ['commit', '-m', 'change validation subject']);
  const stale = verifyHistoricalReplayArtifact(root);
  assert.equal(stale.ok, false);
  assert.ok(stale.reasons.includes('paired-performance-head-stale'), 'a valid old report is rejected once a source file changes');
  assert.ok(stale.reasons.includes('paired-performance-head-drift-nonadmissible'), 'source drift is not reclassified as metadata');

  console.log('historical replay artifact smoke PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
