#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

function buildReport(
  root: string,
  storyCount = 50,
  // B-45a0 F-427: the digest-staleness branches can only be reached by a report whose
  // signature is VALID but whose signed digest disagrees with live state. Overriding after
  // signing would trip the signature check first, so the override must be signed in here.
  digestOverrides: { inventoryDigest?: string; catalogDigest?: string } = {},
): { report: Record<string, unknown>; paired: Record<string, unknown> } {
  const head = git(root, ['rev-parse', 'HEAD']);
  const inventory = discoverValidationInventory(root);
  const catalog = compileValidationCatalog(inventory);
  const pairedRuns = [
    [1, 'full'], [1, 'dynamic'], [2, 'dynamic'], [2, 'full'], [3, 'full'], [3, 'dynamic'],
  ].map(([pair, mode]) => ({ pair, mode, allPass: true, commandCount: 1, verdicts: [{ label: 'smoke', code: 0 }], wallTimeMs: 1, residue: [] }));
  const paired = signed({
    schema: 'proof-or-stop.dynamic-validation.paired-performance.v1',
    head,
    inventoryDigest: digestOverrides.inventoryDigest ?? inventory.digest,
    catalogDigest: digestOverrides.catalogDigest ?? stableDigest(catalog),
    selectionDigest: 'selection', dependencyGraphDigest: 'graph', closureCertificateSetDigest: 'closure',
    canonicalBaselineEpochId: head, toolchainDigest: 'toolchain', revocationLedgerDigest: 'revocations',
    selectedCommandIds: ['validation-smoke'], selectedCount: 1, executedCount: 1, reusedCount: 0, unverifiedCount: 0,
    order: 'full-dynamic / dynamic-full / full-dynamic', runs: pairedRuns,
    medianWallTimeMs: 1, resourceTimelineDigest: 'timeline', perCommandEquivalent: true, verdictEquivalent: true,
  });
  const records = Array.from({ length: storyCount }, (_, index) => {
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
    replayExecution: { resumeRequested: true, repairMissingRequested: true, resumedHistoricalRecords: storyCount, reexecutedHistoricalRecords: 0 },
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

  const documentationPath = join(root, 'docs', 'requirements', 'decisions', 'dynamic-validation-enforcement-evidence.md');
  mkdirSync(join(root, 'docs', 'requirements', 'decisions'), { recursive: true });
  writeFileSync(documentationPath, '# Verification semantics\n');
  git(root, ['add', 'docs/requirements/decisions/dynamic-validation-enforcement-evidence.md']);
  git(root, ['commit', '-m', 'document verify-only replay admission']);
  assert.equal(
    verifyHistoricalReplayArtifact(root).ok,
    true,
    'an exact decision-document drift remains admissible without executing a replay',
  );

  const preReviewSmokePath = join(root, 'packages', 'main', 'src', 'tasks', 'proofstory-pre-review-check-smoke.ts');
  mkdirSync(join(root, 'packages', 'main', 'src', 'tasks'), { recursive: true });
  writeFileSync(preReviewSmokePath, 'export const consumerOnly = true;\n');
  git(root, ['add', 'packages/main/src/tasks/proofstory-pre-review-check-smoke.ts']);
  git(root, ['commit', '-m', 'change evidence consumer smoke']);
  assert.equal(
    verifyHistoricalReplayArtifact(root).ok,
    true,
    'the bounded pre-review evidence consumer drift remains admissible without executing a replay',
  );

  const consumerOnlyPaths = [
    'packages/main/src/core/closeout-trust.ts',
    'packages/main/src/handlers/checklist.ts',
    'packages/main/src/tasks/closeout-trust-smoke.ts',
    'packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts',
    'scripts/verify-process-fact-contract.mjs',
    'docs/requirements/decisions/story-lifecycle.md',
  ];
  for (const consumerOnlyPath of consumerOnlyPaths) {
    const path = join(root, consumerOnlyPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'export const consumerOnly = true;\n');
  }
  git(root, ['add', ...consumerOnlyPaths]);
  git(root, ['commit', '-m', 'change bounded replay evidence consumers']);
  assert.equal(
    verifyHistoricalReplayArtifact(root).ok,
    true,
    'exact post-replay evidence consumers remain admissible without executing a replay',
  );

  const minimum = buildReport(root, 30);
  writeJson(reportPath, minimum.report);
  writeJson(pairedPath, minimum.paired);
  assert.equal(verifyHistoricalReplayArtifact(root).ok, true, 'a 30-Story signed replay meets the lower bound');

  const tooFew = buildReport(root, 29);
  writeJson(reportPath, tooFew.report);
  writeJson(pairedPath, tooFew.paired);
  const tooFewResult = verifyHistoricalReplayArtifact(root);
  assert.equal(tooFewResult.ok, false);
  assert.ok(tooFewResult.reasons.includes('historical-replay-record-count-invalid'), '29 replay records fail closed');

  const tooMany = buildReport(root, 51);
  writeJson(reportPath, tooMany.report);
  writeJson(pairedPath, tooMany.paired);
  const tooManyResult = verifyHistoricalReplayArtifact(root);
  assert.equal(tooManyResult.ok, false);
  assert.ok(tooManyResult.reasons.includes('historical-replay-record-count-invalid'), '51 replay records fail closed');

  const refreshed = buildReport(root);
  writeJson(reportPath, refreshed.report);
  writeJson(pairedPath, refreshed.paired);
  assert.equal(verifyHistoricalReplayArtifact(root).ok, true, 'the upper-bound probe leaves a valid 50-Story artifact for producer-drift coverage');

  // B-45a0 F-427: the head check above short-circuits on any path-allowlist drift, so the
  // producer-drift case below never reaches the digest comparisons. These two branches exist
  // for a different mechanism entirely: inventory/catalog-affecting source mutated while HEAD
  // still matches, so the LIVE-recomputed digest diverges from the one signed into the report.
  // Hold head constant (no commit) and diverge each stored digest in turn.
  const inventoryStale = buildReport(root, 50, { inventoryDigest: 'sha256:divergent-inventory' });
  writeJson(reportPath, inventoryStale.report);
  writeJson(pairedPath, inventoryStale.paired);
  const inventoryStaleResult = verifyHistoricalReplayArtifact(root);
  assert.equal(inventoryStaleResult.ok, false);
  assert.ok(
    !inventoryStaleResult.reasons.includes('paired-performance-signature-invalid'),
    'the divergent inventory digest is signed in, so the digest branch is reached rather than the signature branch',
  );
  assert.ok(
    inventoryStaleResult.reasons.includes('paired-performance-inventory-stale'),
    'a signed paired report whose inventory digest no longer matches live inventory fails closed at unchanged HEAD',
  );
  assert.ok(
    !inventoryStaleResult.reasons.includes('paired-performance-head-stale'),
    'inventory-digest drift is rejected on its own merits, not misreported as head drift',
  );

  const catalogStale = buildReport(root, 50, { catalogDigest: 'sha256:divergent-catalog' });
  writeJson(reportPath, catalogStale.report);
  writeJson(pairedPath, catalogStale.paired);
  const catalogStaleResult = verifyHistoricalReplayArtifact(root);
  assert.equal(catalogStaleResult.ok, false);
  assert.ok(
    !catalogStaleResult.reasons.includes('paired-performance-signature-invalid'),
    'the divergent catalog digest is signed in, so the digest branch is reached rather than the signature branch',
  );
  assert.ok(
    catalogStaleResult.reasons.includes('paired-performance-catalog-stale'),
    'a signed paired report whose catalog digest no longer matches the live catalog fails closed at unchanged HEAD',
  );
  assert.ok(
    !catalogStaleResult.reasons.includes('paired-performance-head-stale'),
    'catalog-digest drift is rejected on its own merits, not misreported as head drift',
  );

  const restored = buildReport(root);
  writeJson(reportPath, restored.report);
  writeJson(pairedPath, restored.paired);
  assert.equal(verifyHistoricalReplayArtifact(root).ok, true, 'restoring matching digests leaves a valid artifact for producer-drift coverage');

  const producerPath = join(root, 'scripts', 'run-dynamic-validation-replay.mjs');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(producerPath, 'export const producerInputChanged = true;\n');
  git(root, ['add', 'scripts/run-dynamic-validation-replay.mjs']);
  git(root, ['commit', '-m', 'change replay producer input']);
  const stale = verifyHistoricalReplayArtifact(root);
  assert.equal(stale.ok, false);
  assert.ok(stale.reasons.includes('paired-performance-head-stale'), 'a valid old report is rejected once a replay producer input changes');
  assert.ok(stale.reasons.includes('paired-performance-head-drift-nonadmissible'), 'producer drift is not reclassified as non-executing evidence consumption');

  console.log('historical replay artifact smoke PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
