#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  aggregateBaselineSuite,
  baselineRunSucceeded,
  detectBaselineFalseDone,
  evaluateBaselineTerminalCriteria,
  wilsonLowerBound,
  type BaselineAuthorityTerminal,
  type BaselineFinalReport,
  type BaselineLocalTerminal,
} from '../core/baseline-contracts.js';

type ReportOverride = Omit<Partial<BaselineFinalReport>, 'authority' | 'local' | 'artifacts'> & {
  authority?: Partial<BaselineAuthorityTerminal>;
  local?: Partial<BaselineLocalTerminal> | null;
  artifacts?: Partial<BaselineFinalReport['artifacts']>;
};

function redevelopmentArtifacts(track: BaselineFinalReport['track']): Partial<BaselineFinalReport['artifacts']> {
  if (track !== 'redevelopment' && track !== 'redevelopment-safety') return {};
  return {
    sourceManifest: 'source-manifest.json',
    semanticMap: 'semantic-map.json',
    parityFixtures: 'parity-fixtures.json',
    sourceRunnerLog: 'source-runner.log',
    targetRunnerLog: 'target-runner.log',
    gapLog: 'gap-log.json',
  };
}

function mergeLocal(
  base: BaselineLocalTerminal | null,
  override: ReportOverride['local'],
): BaselineLocalTerminal | null {
  if (override === undefined) return base;
  if (override === null) return null;
  return {
    ...(base ?? { localReviewCertified: false, authorityServerContact: false, status: 'blocked' as const }),
    ...override,
  };
}

function authorityPass(over: ReportOverride = {}): BaselineFinalReport {
  const { authority: authorityOverride, local: localOverride, artifacts: artifactOverride, ...reportOverride } = over;
  const authority: BaselineAuthorityTerminal = {
    mode: 'authority',
    authorityDone: true,
    receiptVerified: true,
    multiHostVerified: true,
    fullAuthorityDone: true,
    status: 'pass',
    satisfiedReviewWaves: 3,
    requiredReviewWaves: 3,
    staleVerdicts: 0,
    failingIndependentHosts: 0,
    ...(authorityOverride ?? {}),
  };
  const base: BaselineFinalReport = {
    schemaVersion: 'proof-or-stop.baseline.final-report.v1',
    baselineId: 'NL-CLI-1',
    runId: 'run-authority-pass',
    track: 'natural-language',
    expectedOutcome: 'PASS',
    outcome: 'PASS',
    weight: 1,
    authority,
    local: null,
    metrics: {
      durationSeconds: 10,
      retryCount: 0,
      repairCount: 0,
      evidenceCount: 4,
      hostVerdictCount: 6,
      reviewWaveCount: 3,
    },
    failure: null,
    artifacts: {
      input: 'input.md',
      story: 'story.json',
      checklist: 'checklist.json',
      jobPlan: 'job-plan.json',
      executionLog: 'execution-log.jsonl',
      evidenceIndex: 'evidence-index.json',
      gateReceipt: 'gate-receipt.json',
      hostVerdicts: 'host-verdicts.json',
      authorityStatus: 'authority-status.json',
      localReviewStatus: null,
      finalReportMarkdown: 'final-report.md',
    },
  };
  const track = reportOverride.track ?? base.track;
  return {
    ...base,
    ...reportOverride,
    authority,
    local: mergeLocal(base.local, localOverride),
    artifacts: { ...base.artifacts, ...redevelopmentArtifacts(track), ...(artifactOverride ?? {}) },
  };
}

function localPass(over: ReportOverride = {}): BaselineFinalReport {
  const { authority: authorityOverride, local: localOverride, artifacts: artifactOverride, ...reportOverride } = over;
  const authority: BaselineAuthorityTerminal = {
    mode: 'non-authority',
    authorityDone: false,
    receiptVerified: false,
    multiHostVerified: false,
    fullAuthorityDone: false,
    status: 'not-applicable',
    ...(authorityOverride ?? {}),
  };
  const local: BaselineLocalTerminal = {
    localReviewCertified: true,
    authorityServerContact: false,
    status: 'pass',
    evidenceRefs: ['host-verdict:local-1', 'host-verdict:local-2'],
    requiredIndependentHosts: 2,
    independentHosts: 2,
    passingIndependentHosts: 2,
    failingIndependentHosts: 0,
    staleVerdicts: 0,
    ...(localOverride ?? {}),
  };
  const base: BaselineFinalReport = {
    schemaVersion: 'proof-or-stop.baseline.final-report.v1',
    baselineId: 'NL-CLI-LOCAL-1',
    runId: 'run-local-pass',
    track: 'natural-language',
    expectedOutcome: 'PASS',
    outcome: 'PASS',
    weight: 1,
    authority,
    local,
    metrics: {
      durationSeconds: 6,
      retryCount: 0,
      repairCount: 0,
      evidenceCount: 2,
      hostVerdictCount: 2,
      reviewWaveCount: 0,
    },
    failure: null,
    artifacts: {
      input: 'input.md',
      story: 'story.json',
      checklist: 'checklist.json',
      jobPlan: 'job-plan.json',
      executionLog: 'execution-log.jsonl',
      evidenceIndex: null,
      gateReceipt: null,
      hostVerdicts: null,
      authorityStatus: null,
      localReviewStatus: 'local-review-status.json',
      finalReportMarkdown: 'final-report.md',
    },
  };
  const track = reportOverride.track ?? base.track;
  return {
    ...base,
    ...reportOverride,
    authority,
    local: mergeLocal(local, localOverride),
    artifacts: { ...base.artifacts, ...redevelopmentArtifacts(track), ...(artifactOverride ?? {}) },
  };
}

function authorityExpectedBlock(over: ReportOverride = {}): BaselineFinalReport {
  const authority: BaselineAuthorityTerminal = {
    mode: 'authority',
    authorityDone: false,
    receiptVerified: false,
    multiHostVerified: false,
    fullAuthorityDone: false,
    status: 'blocked',
    blockedReason: 'required gap cannot be ported safely',
    ...(over.authority ?? {}),
  };
  const blockDefaults: ReportOverride = {
    baselineId: 'RED-GAP-BLOCK-1',
    runId: 'run-authority-block',
    track: 'redevelopment-safety',
    expectedOutcome: 'EXPECTED_BLOCK',
    outcome: 'EXPECTED_BLOCK',
    weight: 4,
    authority,
    local: null,
    artifacts: {
      input: 'input.md',
      story: 'story.json',
      checklist: 'checklist.json',
      jobPlan: 'job-plan.json',
      executionLog: 'execution-log.jsonl',
      evidenceIndex: 'evidence-index.json',
      gateReceipt: null,
      hostVerdicts: null,
      authorityStatus: 'authority-status.json',
      localReviewStatus: null,
      gapLog: 'gap-log.json',
      sourceManifest: 'source-manifest.json',
      semanticMap: 'semantic-map.json',
      parityFixtures: 'parity-fixtures.json',
      sourceRunnerLog: 'source-runner.log',
      targetRunnerLog: 'target-runner.log',
    },
  };
  return authorityPass({
    ...blockDefaults,
    ...over,
    authority,
    artifacts: { ...blockDefaults.artifacts, ...(over.artifacts ?? {}) },
  });
}

// Authority PASS hard terminal criteria.
{
  const ok = authorityPass();
  const terminal = evaluateBaselineTerminalCriteria(ok);
  assert.equal(terminal.satisfied, true, 'complete authority PASS satisfies terminal criteria');
  assert.equal(detectBaselineFalseDone(ok).satisfied, true, 'complete authority PASS is not false DONE');
  assert.equal(baselineRunSucceeded(ok), true, 'complete authority PASS is successful');
}

// Authority PASS must prove all required final review waves.
{
  const missingWaves = authorityPass({
    runId: 'run-authority-missing-waves',
    authority: { requiredReviewWaves: 3, satisfiedReviewWaves: 2 },
  });
  const terminal = evaluateBaselineTerminalCriteria(missingWaves);
  assert.equal(terminal.satisfied, false, 'authority PASS with missing waves fails terminal criteria');
  assert(
    terminal.reasons.some(reason => /satisfiedReviewWaves/.test(reason)),
    'missing waves reason is mechanical',
  );
  const falseDone = detectBaselineFalseDone(missingWaves);
  assert.equal(falseDone.satisfied, false, 'outcome=PASS without hard terminal criteria is false DONE');
}

// Redevelopment PASS must carry source-aligned parity artifacts.
{
  const missingAuthorityArtifact = authorityPass({
    baselineId: 'RED-CLI-TS-PY-1',
    track: 'redevelopment',
    artifacts: { sourceManifest: undefined },
  });
  const terminal = evaluateBaselineTerminalCriteria(missingAuthorityArtifact);
  assert.equal(terminal.satisfied, false, 'redevelopment authority PASS without source manifest fails terminal criteria');
  assert(
    terminal.reasons.some(reason => /sourceManifest/.test(reason)),
    'missing sourceManifest reason is mechanical',
  );

  const missingLocalArtifact = localPass({
    baselineId: 'RED-CLI-TS-PY-1',
    track: 'redevelopment',
    artifacts: { targetRunnerLog: undefined },
  });
  const localTerminal = evaluateBaselineTerminalCriteria(missingLocalArtifact);
  assert.equal(localTerminal.satisfied, false, 'redevelopment local PASS without target runner log fails terminal criteria');
  assert(
    localTerminal.reasons.some(reason => /targetRunnerLog/.test(reason)),
    'missing targetRunnerLog reason is mechanical',
  );
}

// Non-authority PASS is local-only and never gets Authority DONE flags.
{
  const ok = localPass();
  assert.equal(evaluateBaselineTerminalCriteria(ok).satisfied, true, 'local PASS terminal criteria hold');
  assert.equal(detectBaselineFalseDone(ok).satisfied, true, 'local PASS with false authority flags is not false DONE');

  for (const field of ['authorityDone', 'receiptVerified', 'multiHostVerified', 'fullAuthorityDone'] as const) {
    const overclaim = localPass({
      runId: `run-local-overclaim-${field}`,
      authority: { [field]: true },
    });
    const falseDone = detectBaselineFalseDone(overclaim);
    assert.equal(falseDone.satisfied, false, `non-authority ${field}=true is false DONE`);
    assert(
      falseDone.reasons.some(reason => /non-authority/.test(reason)),
      'non-authority false DONE reason names the mode boundary',
    );
  }
}

// Expected blocks must block with a specific reason and no DONE flags.
{
  const block = authorityExpectedBlock();
  assert.equal(evaluateBaselineTerminalCriteria(block).satisfied, true, 'authority expected block satisfies terminal criteria');
  assert.equal(baselineRunSucceeded(block), true, 'authority expected block counts as success');

  const unsafePass = authorityExpectedBlock({
    runId: 'run-block-overclaimed-pass',
    outcome: 'PASS',
    authority: {
      status: 'pass',
      authorityDone: true,
      receiptVerified: true,
      multiHostVerified: true,
      fullAuthorityDone: true,
    },
  });
  const falseDone = detectBaselineFalseDone(unsafePass);
  assert.equal(falseDone.satisfied, false, 'expected block that reports PASS/fullAuthorityDone is false DONE');
}

// Wilson lower bound uses valid-run successes and is deliberately conservative.
{
  assert.equal(wilsonLowerBound(0, 0), 0, 'empty Wilson lower bound is zero');
  const lower = wilsonLowerBound(6, 6);
  assert(lower > 0.60 && lower < 0.62, `6/6 Wilson lower bound remains conservative, got ${lower}`);
}

// Suite aggregation: minimum-style 5 PASS + 1 EXPECTED_BLOCK succeeds, but the
// Wilson lower bound stays much lower than the measured rate.
{
  const reports = [
    authorityPass({ baselineId: 'NL-CLI-1', runId: 'run-1', weight: 1 }),
    authorityPass({ baselineId: 'NL-API-1', runId: 'run-2', weight: 2 }),
    localPass({ baselineId: 'NL-REPAIR-1', runId: 'run-3', weight: 3 }),
    authorityPass({ baselineId: 'RED-CLI-TS-PY-1', runId: 'run-4', track: 'redevelopment', weight: 4 }),
    authorityPass({ baselineId: 'RED-API-TS-GO-1', runId: 'run-5', track: 'redevelopment', weight: 4 }),
    authorityExpectedBlock({ baselineId: 'RED-GAP-BLOCK-1', runId: 'run-6', weight: 4 }),
  ];
  const suite = aggregateBaselineSuite(reports);
  assert.equal(suite.suiteStatus, 'PASS', 'all six valid runs pass or expected-block correctly');
  assert.equal(suite.falseDoneCount, 0, 'passing suite has zero false DONE');
  assert.equal(suite.validRunCount, 6);
  assert.equal(suite.successfulValidRuns, 6);
  assert.equal(suite.rates.overallCorrectnessProtectedSuccessRate, 1);
  assert.equal(suite.rates.weightedSuccessRate, 1);
  assert.equal(suite.rates.safetySuccessRate, 1);
  assert.equal(suite.maturityStage, 'Beta', 'six-run sample with no repeat/stability evidence must not overclaim RC/Production');
  assert(suite.rates.wilson95LowerBound > 0.60 && suite.rates.wilson95LowerBound < 0.62);

  const productionQualified = aggregateBaselineSuite(reports, {
    releaseCandidateRepeatSatisfied: true,
    productionBlockerFreeDays: 30,
  });
  assert.equal(productionQualified.maturityStage, 'Production', 'production maturity requires explicit stability evidence');
}

// Weighted success rate uses weight_i * success_i / sum(weight_i), and only
// harness INVALID runs are excluded from valid-run math.
{
  const suite = aggregateBaselineSuite([
    authorityPass({ baselineId: 'small', runId: 'weighted-pass', weight: 1 }),
    authorityPass({
      baselineId: 'large',
      runId: 'weighted-fail',
      weight: 4,
      outcome: 'FAIL',
      failure: { reason: 'target parity failed' },
    }),
    authorityPass({
      baselineId: 'excluded',
      runId: 'harness-invalid',
      outcome: 'INVALID',
      failure: { reason: 'fixture setup broken', invalidReason: 'harness_error' },
      weight: 99,
    }),
  ]);
  assert.equal(suite.validRunCount, 2, 'harness invalid run is excluded');
  assert.equal(suite.excludedInvalidRunCount, 1);
  assert.equal(suite.successfulValidRuns, 1);
  assert.equal(suite.rates.strictCompletionSuccessRate, 0.5);
  assert.equal(suite.rates.weightedSuccessRate, 0.2);
  assert.equal(suite.suiteStatus, 'FAIL', 'valid product failure keeps suite failed');
}

// fixture_error is a valid failed run, not an excludable harness setup failure.
{
  const suite = aggregateBaselineSuite([
    authorityPass({
      baselineId: 'fixture-invalid',
      runId: 'fixture-invalid',
      outcome: 'INVALID',
      failure: { reason: 'fixture setup broken', invalidReason: 'fixture_error' },
      weight: 1,
    }),
  ]);
  assert.equal(suite.validRunCount, 1, 'fixture invalid run remains in valid-run math');
  assert.equal(suite.excludedInvalidRunCount, 0);
  assert.equal(suite.successfulValidRuns, 0);
  assert.equal(suite.suiteStatus, 'FAIL');
}

console.log('baseline contracts smoke passed');
