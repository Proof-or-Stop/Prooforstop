#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateBaselineReports,
  isFalseDone,
  runBaseline,
  type BaselineFinalReport,
} from '../core/baseline.js';

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-baseline-suite-'));
const localReviewEvidenceRefs = ['host-verdict:codex-local-review', 'host-verdict:claude-local-review'];
const gateInputDigest = 'input-digest-baseline-smoke';
const receiptInputDigest = 'input-digest-baseline-smoke';
const gateReceiptJson = JSON.stringify({
  receiptId: 'receipt-baseline-smoke',
  kind: 'gate_decision',
  serverKeyId: 'server-key-baseline-smoke',
  inputDigest: receiptInputDigest,
  decisionDigest: 'decision-digest-baseline-smoke',
  signature: 'signature-baseline-smoke',
});
const hostVerdictsJson = JSON.stringify({
  jobId: 'job-baseline-smoke',
  reconciliation: {
    jobId: 'job-baseline-smoke',
    passingIndependentHostCount: 6,
    requiredIndependentHostCount: 2,
    multiHostGateSatisfied: true,
    hasFailingVerdict: false,
  },
  verdicts: [
    ['wave-1', 'codex', 'host-codex-wave-1'],
    ['wave-1', 'claude', 'host-claude-wave-1'],
    ['wave-2', 'codex', 'host-codex-wave-2'],
    ['wave-2', 'gemini', 'host-gemini-wave-2'],
    ['wave-3', 'claude', 'host-claude-wave-3'],
    ['wave-3', 'gemini', 'host-gemini-wave-3'],
  ].map(([reviewWaveId, provider, hostId]) => ({
    verdictId: `verdict-${hostId}`,
    jobId: 'job-baseline-smoke',
    runId: 'run-baseline-smoke',
    reviewWaveId,
    provider,
    model: `${provider}-cli`,
    verdict: 'pass',
    checkedReceiptId: 'receipt-baseline-smoke',
    checkedGateInputDigest: gateInputDigest,
    checkedEvidenceRefs: ['evidence-1'],
    hostId,
    receiptId: `host-receipt-${hostId}`,
  })),
});

try {
  const outputRoot = join(root, '.proof-or-stop', 'artifacts', 'baseline');
  const reports = [
    runBaseline(root, { baselineId: 'NL-CLI-1', runId: 'run-nl-cli', authorityMode: 'non-authority', outputRoot, localReviewEvidenceRefs }),
    runBaseline(root, { baselineId: 'NL-API-1', runId: 'run-nl-api', authorityMode: 'non-authority', outputRoot, localReviewEvidenceRefs }),
    runBaseline(root, { baselineId: 'NL-REPAIR-1', runId: 'run-nl-repair', authorityMode: 'non-authority', outputRoot, localReviewEvidenceRefs }),
    runBaseline(root, { baselineId: 'RED-CLI-TS-PY-1', runId: 'run-red-cli', authorityMode: 'non-authority', outputRoot, localReviewEvidenceRefs }),
    runBaseline(root, { baselineId: 'RED-API-TS-GO-1', runId: 'run-red-api', authorityMode: 'non-authority', outputRoot, localReviewEvidenceRefs }),
    runBaseline(root, { baselineId: 'RED-GAP-BLOCK-1', runId: 'run-red-gap', authorityMode: 'non-authority', outputRoot }),
  ];

  assert.deepEqual(reports.map(report => report.outcome), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'EXPECTED_BLOCK']);
  for (const report of reports) {
    assert.equal(report.authority.mode, 'non-authority');
    assert.equal(report.authority.authorityDone, false);
    assert.equal(report.authority.receiptVerified, false);
    assert.equal(report.authority.multiHostVerified, false);
    assert.equal(report.authority.fullAuthorityDone, false);
    assert.equal(isFalseDone(report), false);
  }

  const suite = aggregateBaselineReports(reports);
  assert.equal(suite.suiteStatus, 'PASS');
  assert.equal(suite.validRunCount, 6);
  assert.equal(suite.falseDoneCount, 0);
  assert.equal(suite.strictCompletionSuccessRate, 1);
  assert.equal(suite.safetySuccessRate, 1);
  assert.equal(suite.overallCorrectnessProtectedSuccessRate, 1);
  assert.equal(suite.weightedSuccessRate, 1);
  assert.equal(suite.maturityStage, 'Beta', 'legacy aggregate cannot overclaim RC/Production without repeat/stability evidence');
  assert.equal(suite.blockingFailures.length, 0);

  const forged: BaselineFinalReport = {
    ...reports[0],
    authority: {
      ...reports[0].authority,
      authorityDone: true,
    },
  };
  assert.equal(isFalseDone(forged), true, 'non-authority Authority flag overclaim must be false DONE');
  const forgedSuite = aggregateBaselineReports([forged]);
  assert.equal(forgedSuite.suiteStatus, 'FAIL');
  assert.equal(forgedSuite.falseDoneCount, 1);

  const authorityMissingWaves = runBaseline(root, {
    baselineId: 'NL-CLI-1',
    runId: 'run-authority-missing-waves',
    authorityMode: 'authority',
    outputRoot,
    receiptVerified: true,
    gateReceiptVerifiedAgainstPinnedKey: true,
    gateReceiptJson,
    hostVerdictsJson,
    satisfiedReviewWaves: 1,
    requiredReviewWaves: 3,
    staleVerdicts: 0,
    failingIndependentHosts: 0,
    serverBackedVerdictsAccepted: true,
    gateInputDigest,
    receiptInputDigest,
  });
  assert.equal(authorityMissingWaves.outcome, 'FAIL');
  assert.equal(authorityMissingWaves.authority.authorityDone, true);
  assert.equal(authorityMissingWaves.authority.fullAuthorityDone, false);

  const authorityPass = runBaseline(root, {
    baselineId: 'NL-CLI-1',
    runId: 'run-authority-pass',
    authorityMode: 'authority',
    outputRoot,
    receiptVerified: true,
    gateReceiptVerifiedAgainstPinnedKey: true,
    gateReceiptJson,
    hostVerdictsJson,
    satisfiedReviewWaves: 3,
    requiredReviewWaves: 3,
    staleVerdicts: 0,
    failingIndependentHosts: 0,
    serverBackedVerdictsAccepted: true,
    gateInputDigest,
    receiptInputDigest,
  });
  assert.equal(authorityPass.outcome, 'PASS', `authority PASS fixture failed: ${JSON.stringify({ authority: authorityPass.authority, failure: authorityPass.failure })}`);
  assert.equal(authorityPass.authority.fullAuthorityDone, true);

  const unsupportedNaturalLanguage = runBaseline(root, {
    baselineId: 'NL-UI-1',
    runId: 'run-nl-ui-unsupported',
    authorityMode: 'authority',
    outputRoot,
    receiptVerified: true,
    gateReceiptVerifiedAgainstPinnedKey: true,
    gateReceiptJson,
    hostVerdictsJson,
    satisfiedReviewWaves: 3,
    requiredReviewWaves: 3,
    staleVerdicts: 0,
    failingIndependentHosts: 0,
    serverBackedVerdictsAccepted: true,
    gateInputDigest,
    receiptInputDigest,
  });
  assert.equal(unsupportedNaturalLanguage.outcome, 'FAIL', 'unsupported natural-language PASS cannot ignore scenarioProofValid=false');
  assert.equal(unsupportedNaturalLanguage.failure?.code, 'scenario_evidence_missing');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ baseline suite smoke passed');
