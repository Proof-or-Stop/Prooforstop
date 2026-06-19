#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBaselineSuiteReport,
  renderBaselineSuiteMarkdown,
  wilsonLowerBound,
  writeBaselineSuiteReport,
} from '../core/baseline-suite-report.js';
import { resetConfigCache } from '../core/config.js';
import { getCommandLifecyclePolicy } from '../core/command-policy.js';
import { PROCESS_FACT_LEVELS } from '../core/process-fact-levels.js';
import { StoryStore } from '../core/store.js';
import type { HandlerContext } from '../handlers/context.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { createMainRegistry } from '../registry.js';

const MINIMUM_SUITE = [
  ['NL-CLI-1', 'natural-language', 1],
  ['NL-API-1', 'natural-language', 2],
  ['NL-REPAIR-1', 'natural-language', 3],
  ['RED-CLI-TS-PY-1', 'redevelopment', 4],
  ['RED-API-TS-GO-1', 'redevelopment', 4],
  ['RED-GAP-BLOCK-1', 'redevelopment-safety', 4],
] as const;

type FinalReportFixture = Record<string, unknown> & {
  baselineId: string;
  runId: string;
  expectedOutcome: 'PASS' | 'EXPECTED_BLOCK';
  outcome: 'PASS' | 'EXPECTED_BLOCK' | 'FAIL' | 'INVALID';
};

const GATE_INPUT_DIGEST_PREFIX = 'gate-input-digest';
const RECEIPT_INPUT_DIGEST_PREFIX = 'receipt-input-digest';

function gateReceiptFixture(baselineId: string, runId: string): Record<string, unknown> {
  return {
    receiptId: `receipt-${runId}`,
    kind: 'gate_decision',
    storyId: `B-baseline-${baselineId}-${runId}`,
    serverKeyId: 'server-key-suite-smoke',
    inputDigest: `${RECEIPT_INPUT_DIGEST_PREFIX}-${runId}`,
    decisionDigest: `decision-digest-${runId}`,
    signature: `signature-${runId}`,
  };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileSha256(path: string): string {
  return sha256(readFileSync(path));
}

function baselineEvidenceDigest(refs: string[]): string {
  return sha256(JSON.stringify([...refs].sort()));
}

function hostVerdictsFixture(baselineId: string, runId: string, evidenceRefs: string[]): Record<string, unknown> {
  const storyId = `B-baseline-${baselineId}-${runId}`;
  return {
    jobId: `job-${runId}`,
    reconciliation: {
      jobId: `job-${runId}`,
      totalVerdictCount: 6,
      independentHostVerdictCount: 6,
      passingIndependentHostCount: 6,
      requiredIndependentHostCount: 2,
      multiHostGateSatisfied: true,
      hasFailingVerdict: false,
    },
    verdicts: [
      ['wave-1', 'codex', 'host-codex-wave-1'],
      ['wave-1', 'claude', 'host-claude-wave-1'],
      ['wave-2', 'codex', 'host-codex-wave-2'],
      ['wave-2', 'antigravity', 'host-antigravity-wave-2'],
      ['wave-3', 'claude', 'host-claude-wave-3'],
      ['wave-3', 'antigravity', 'host-antigravity-wave-3'],
    ].map(([reviewWaveId, provider, hostId]) => ({
      verdictId: `verdict-${runId}-${hostId}`,
      jobId: `job-${runId}`,
      runId,
      storyId,
      reviewWaveId,
      provider,
      model: `${provider}-cli`,
      verdict: 'pass',
      checkedReceiptId: `receipt-${runId}`,
      checkedGateInputDigest: `${RECEIPT_INPUT_DIGEST_PREFIX}-${runId}`,
      checkedEvidenceRefs: evidenceRefs,
      hostId,
      receiptId: `host-receipt-${runId}-${hostId}`,
    })),
  };
}

function scenarioEvidenceFixture(baselineId: string, track: string, runId: string): Record<string, unknown> {
  const assertionsByBaseline: Record<string, Record<string, boolean>> = {
    'NL-CLI-1': { cliHelpPassed: true, cliRunPassed: true },
    'NL-API-1': { apiHealthPassed: true, apiValidationPassed: true, apiCreatePassed: true },
    'NL-REPAIR-1': { initialFailureObserved: true, repairApplied: true, retryPassed: true },
  };
  return {
    schemaVersion: 'lattice.baseline.scenario-evidence.v1',
    baselineId,
    runId,
    track,
    scenarioProofValid: true,
    assertions: assertionsByBaseline[baselineId] ?? { scenarioProofValid: true },
    commands: [{
      command: ['node', `scenario-${baselineId}.js`],
      exitCode: 0,
      stdout: 'ok\n',
      stderr: '',
    }],
  };
}

function redevelopmentArtifacts(track: string): Record<string, string> {
  if (!track.startsWith('redevelopment')) return {};
  return {
    sourceManifest: 'source-manifest.json',
    semanticMap: 'semantic-map.json',
    parityFixtures: 'parity-fixtures.json',
    sourceRunnerLog: 'source-runner.log',
    targetRunnerLog: 'target-runner.log',
    gapLog: 'gap-log.json',
  };
}

function authorityPassReport(baselineId: string, track: string, weight: number, runId = 'run-001'): FinalReportFixture {
  return {
    schemaVersion: 'lattice.baseline.final-report.v1',
    baselineId,
    runId,
    track,
    expectedOutcome: 'PASS',
    outcome: 'PASS',
    weight,
    authority: {
      mode: 'authority',
      authorityDone: true,
      receiptVerified: true,
      multiHostVerified: true,
      fullAuthorityDone: true,
      status: 'pass',
      requiredReviewWaves: 3,
      satisfiedReviewWaves: 3,
      staleVerdicts: 0,
      failingIndependentHosts: 0,
      serverBackedVerdictsAccepted: true,
      gateReceiptVerifiedAgainstPinnedKey: true,
      gateInputDigest: `${RECEIPT_INPUT_DIGEST_PREFIX}-${runId}`,
      receiptInputDigest: `${RECEIPT_INPUT_DIGEST_PREFIX}-${runId}`,
    },
    local: null,
    metrics: {
      durationSeconds: 10,
      retryCount: 0,
      repairCount: 0,
      evidenceCount: 3,
      hostVerdictCount: 2,
      reviewWaveCount: 3,
    },
    failure: null,
    artifacts: {
      story: 'story.json',
      checklist: 'checklist.json',
      jobPlan: 'job-plan.json',
      executionLog: 'execution-log.jsonl',
      evidenceIndex: 'evidence-index.json',
      authorityStatus: 'authority-status.json',
      localReviewStatus: null,
      gateReceipt: 'gate-receipt.json',
      hostVerdicts: 'host-verdicts.json',
      ...(track === 'natural-language' ? { scenarioEvidence: 'scenario-evidence.json' } : {}),
      ...redevelopmentArtifacts(track),
    },
  };
}

function expectedBlockReport(baselineId: string, track: string, weight: number, runId = 'run-001'): FinalReportFixture {
  return {
    schemaVersion: 'lattice.baseline.final-report.v1',
    baselineId,
    runId,
    track,
    expectedOutcome: 'EXPECTED_BLOCK',
    outcome: 'EXPECTED_BLOCK',
    weight,
    authority: {
      mode: 'authority',
      authorityDone: false,
      receiptVerified: false,
      multiHostVerified: false,
      fullAuthorityDone: false,
      status: 'blocked',
    },
    local: null,
    metrics: {
      durationSeconds: 8,
      retryCount: 0,
      repairCount: 0,
      evidenceCount: 2,
      hostVerdictCount: 0,
      reviewWaveCount: 0,
    },
    blockedReason: 'source contains explicitly non-portable behavior that must be recorded as a gap',
    failure: {
      blockedReason: 'source contains explicitly non-portable behavior that must be recorded as a gap',
    },
    artifacts: {
      story: 'story.json',
      checklist: 'checklist.json',
      jobPlan: 'job-plan.json',
      executionLog: 'execution-log.jsonl',
      authorityStatus: 'authority-status.json',
      localReviewStatus: null,
      gateReceipt: null,
      hostVerdicts: null,
      ...redevelopmentArtifacts(track),
    },
  };
}

function invalidHarnessReport(): FinalReportFixture {
  return {
    schemaVersion: 'lattice.baseline.final-report.v1',
    baselineId: 'NL-CLI-1',
    runId: 'run-invalid-harness',
    track: 'natural-language',
    expectedOutcome: 'PASS',
    outcome: 'INVALID',
    weight: 1,
    invalidReason: 'harness_error',
    authority: {
      mode: 'authority',
      authorityDone: false,
      receiptVerified: false,
      multiHostVerified: false,
      fullAuthorityDone: false,
      status: 'invalid',
    },
    local: null,
    metrics: {},
    failure: { invalidReason: 'harness_error' },
    artifacts: {
      story: null,
      checklist: null,
      jobPlan: null,
      executionLog: null,
      evidenceIndex: null,
      authorityStatus: null,
      localReviewStatus: null,
      gateReceipt: null,
      hostVerdicts: null,
    },
  };
}

function writeRun(root: string, report: FinalReportFixture) {
  const dir = join(root, '.lattice', 'artifacts', 'baseline', report.baselineId, report.runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'final-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  const artifacts = report.artifacts as Record<string, unknown> | undefined;
  writeFileSync(join(dir, 'story.json'), JSON.stringify({ baselineId: report.baselineId, runId: report.runId }, null, 2) + '\n', 'utf8');
  writeFileSync(join(dir, 'checklist.json'), JSON.stringify({ items: [{ id: 'CHK-001', baselineId: report.baselineId }] }, null, 2) + '\n', 'utf8');
  writeFileSync(join(dir, 'job-plan.json'), JSON.stringify({ baselineId: report.baselineId, plannedSteps: ['S-001'] }, null, 2) + '\n', 'utf8');
  writeFileSync(join(dir, 'execution-log.jsonl'), `${JSON.stringify({ event: 'baseline.fixture.executed', baselineId: report.baselineId })}\n`, 'utf8');
  if (report.authority && (report.authority as Record<string, unknown>).mode === 'authority' && report.outcome === 'PASS') {
    const gateReceipt = typeof artifacts?.gateReceipt === 'string' ? artifacts.gateReceipt : null;
    const hostVerdicts = typeof artifacts?.hostVerdicts === 'string' ? artifacts.hostVerdicts : null;
    const scenarioEvidence = typeof artifacts?.scenarioEvidence === 'string' ? artifacts.scenarioEvidence : null;
    if (gateReceipt) writeFileSync(join(dir, gateReceipt), JSON.stringify(gateReceiptFixture(report.baselineId, report.runId), null, 2) + '\n', 'utf8');
    if (typeof artifacts?.authorityStatus === 'string') writeFileSync(join(dir, artifacts.authorityStatus), JSON.stringify({ schemaVersion: 'lattice.baseline.authority-status.v1', ...(report.authority as Record<string, unknown>) }, null, 2) + '\n', 'utf8');
    if (scenarioEvidence) writeFileSync(join(dir, scenarioEvidence), JSON.stringify(scenarioEvidenceFixture(report.baselineId, String(report.track), report.runId), null, 2) + '\n', 'utf8');
  }
  const artifactsForFiles = report.artifacts as Record<string, unknown> | undefined;
  const sourceManifest = typeof artifactsForFiles?.sourceManifest === 'string' ? artifactsForFiles.sourceManifest : null;
  const semanticMap = typeof artifactsForFiles?.semanticMap === 'string' ? artifactsForFiles.semanticMap : null;
  const parityFixtures = typeof artifactsForFiles?.parityFixtures === 'string' ? artifactsForFiles.parityFixtures : null;
  const sourceRunnerLog = typeof artifactsForFiles?.sourceRunnerLog === 'string' ? artifactsForFiles.sourceRunnerLog : null;
  const targetRunnerLog = typeof artifactsForFiles?.targetRunnerLog === 'string' ? artifactsForFiles.targetRunnerLog : null;
  const gapLog = typeof artifactsForFiles?.gapLog === 'string' ? artifactsForFiles.gapLog : null;
  if (sourceManifest) writeFileSync(join(dir, sourceManifest), JSON.stringify({ entries: [`source:${report.baselineId}`] }, null, 2) + '\n', 'utf8');
  if (semanticMap) writeFileSync(join(dir, semanticMap), JSON.stringify({ mappings: [`map:${report.baselineId}`] }, null, 2) + '\n', 'utf8');
  if (parityFixtures) writeFileSync(join(dir, parityFixtures), JSON.stringify({ fixtures: [`fixture:${report.baselineId}`] }, null, 2) + '\n', 'utf8');
  if (sourceRunnerLog) writeFileSync(join(dir, sourceRunnerLog), `source runner ok for ${report.baselineId}\n`, 'utf8');
  if (targetRunnerLog) writeFileSync(join(dir, targetRunnerLog), `target runner ok for ${report.baselineId}\n`, 'utf8');
  if (gapLog) writeFileSync(join(dir, gapLog), JSON.stringify({ requiredGaps: [] }, null, 2) + '\n', 'utf8');
  if (report.authority && (report.authority as Record<string, unknown>).mode === 'authority' && report.outcome === 'PASS') {
    const evidenceIndex = typeof artifactsForFiles?.evidenceIndex === 'string' ? artifactsForFiles.evidenceIndex : null;
    const hostVerdicts = typeof artifactsForFiles?.hostVerdicts === 'string' ? artifactsForFiles.hostVerdicts : null;
    const keys = ['story', 'checklist', 'jobPlan', 'executionLog'];
    if (report.track === 'natural-language') keys.push('scenarioEvidence');
    if (String(report.track).startsWith('redevelopment')) keys.push('sourceManifest', 'semanticMap', 'parityFixtures', 'sourceRunnerLog', 'targetRunnerLog', 'gapLog');
    const evidenceArtifacts = keys.map(key => {
      const artifact = artifactsForFiles?.[key];
      if (typeof artifact !== 'string') return null;
      const digest = fileSha256(join(dir, artifact));
      return {
        key,
        path: artifact,
        digest,
        ref: `baseline:${report.baselineId}:${report.runId}:${key}:${digest}`,
      };
    }).filter((item): item is { key: string; path: string; digest: string; ref: string } => item !== null);
    const evidenceRefs = evidenceArtifacts.map(item => item.ref).sort();
    if (evidenceIndex) writeFileSync(join(dir, evidenceIndex), JSON.stringify({
      schemaVersion: 'lattice.baseline.evidence-index.v1',
      baselineId: report.baselineId,
      runId: report.runId,
      evidenceCount: evidenceRefs.length,
      baselineEvidenceDigest: baselineEvidenceDigest(evidenceRefs),
      evidenceRefs,
      artifacts: evidenceArtifacts,
    }, null, 2) + '\n', 'utf8');
    if (hostVerdicts) writeFileSync(join(dir, hostVerdicts), JSON.stringify(hostVerdictsFixture(report.baselineId, report.runId, evidenceRefs), null, 2) + '\n', 'utf8');
  }
}

function writeProjectConfig(root: string): void {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
}

{
  const root = mkdtempSync(join(tmpdir(), 'lattice-baseline-suite-happy-'));
  try {
    writeProjectConfig(root);
    for (const [baselineId, track, weight] of MINIMUM_SUITE) {
      const report = baselineId === 'RED-GAP-BLOCK-1'
        ? expectedBlockReport(baselineId, track, weight)
        : authorityPassReport(baselineId, track, weight);
      writeRun(root, report);
    }
    writeRun(root, invalidHarnessReport());

    const report = buildBaselineSuiteReport({
      root,
      generatedAt: '2026-06-08T00:00:00.000Z',
    });
    assert.equal(report.schemaVersion, 'lattice.baseline.suite-report.v1');
    assert.equal(report.suiteStatus, 'PASS');
    assert.equal(report.maturityStage, 'Beta', 'single-repeat minimum suite can reach Beta but not Release Candidate');
    assert.equal(report.counts.totalReportCount, 7);
    assert.equal(report.counts.validRunCount, 6);
    assert.equal(report.counts.excludedInvalidHarnessCount, 1);
    assert.equal(report.counts.strictCompletionPassCount, 5);
    assert.equal(report.counts.safetyPassCount, 1);
    assert.equal(report.counts.falseDoneCount, 0);
    assert.equal(report.rates.strictCompletionSuccessRate, 1);
    assert.equal(report.rates.safetySuccessRate, 1);
    assert.equal(report.rates.overallCorrectnessProtectedSuccessRate, 1);
    assert.equal(report.rates.weightedSuccessRate, 1);
    assert.equal(report.rates.wilson95LowerBound, wilsonLowerBound(6, 6));
    assert.ok(report.rates.wilson95LowerBound > 0.6 && report.rates.wilson95LowerBound < 0.61);
    assert.equal(report.minimumSuite.satisfied, true);
    assert.deepEqual(report.minimumSuite.missingBaselineIds, []);
    assert.ok(report.maturity.blockers.some(blocker => blocker.includes('three consecutive')), 'RC repeat blocker is explicit');

    const markdown = renderBaselineSuiteMarkdown(report);
    assert.match(markdown, /False DONE count: 0/);
    assert.match(markdown, /Wilson 95% lower bound: 60\.97%/);

    writeBaselineSuiteReport(report);
    assert.equal(existsSync(report.writtenFiles.json), true);
    assert.equal(existsSync(report.writtenFiles.markdown), true);
    const written = JSON.parse(readFileSync(report.writtenFiles.json, 'utf8')) as typeof report;
    assert.equal(written.counts.validRunCount, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'lattice-baseline-suite-missing-minimum-'));
  try {
    writeProjectConfig(root);
    writeRun(root, authorityPassReport('NL-CLI-1', 'natural-language', 1));

    const report = buildBaselineSuiteReport({
      root,
      generatedAt: '2026-06-08T00:00:00.000Z',
    });
    assert.equal(report.suiteStatus, 'FAIL');
    assert.equal(report.maturityStage, 'Failed', 'missing minimum suite cannot report Beta or better');
    assert.equal(report.minimumSuite.satisfied, false);
    assert.ok(report.minimumSuite.missingBaselineIds.includes('NL-API-1'));
    assert.ok(report.maturity.blockers.some(blocker => /minimum baseline suite is incomplete/.test(blocker)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const forbiddenField of ['authorityDone', 'receiptVerified', 'multiHostVerified', 'fullAuthorityDone'] as const) {
  const root = mkdtempSync(join(tmpdir(), `lattice-baseline-suite-false-done-${forbiddenField}-`));
  try {
    writeProjectConfig(root);
    writeRun(root, {
      ...authorityPassReport('NL-CLI-1', 'natural-language', 1),
      authority: {
        mode: 'non-authority',
        authorityDone: false,
        receiptVerified: false,
        multiHostVerified: false,
        fullAuthorityDone: false,
        status: 'not-applicable',
        [forbiddenField]: true,
      },
      local: {
        localReviewCertified: true,
        authorityServerContact: false,
        status: 'pass',
        evidenceRefs: ['host-verdict:local-review-01', 'host-verdict:local-review-02'],
      },
      metrics: {
        durationSeconds: 10,
        retryCount: 0,
        repairCount: 0,
        evidenceCount: 2,
        hostVerdictCount: 2,
        reviewWaveCount: 1,
      },
      artifacts: {
        authorityStatus: null,
        localReviewStatus: 'local-review-status.json',
        gateReceipt: null,
        hostVerdicts: null,
      },
    });
    const report = buildBaselineSuiteReport({
      root,
      minimumSuiteRequired: false,
      generatedAt: '2026-06-08T00:00:00.000Z',
    });
    assert.equal(report.suiteStatus, 'FAIL');
    assert.equal(report.maturityStage, 'Failed');
    assert.equal(report.counts.falseDoneCount, 1);
    assert.match(report.falseDone[0]?.reasons.join('\n') ?? '', new RegExp(`non-authority run set ${forbiddenField}`));
    assert.equal(report.runs[0]?.success, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'lattice-baseline-suite-local-no-evidence-'));
  try {
    writeProjectConfig(root);
    writeRun(root, {
      ...authorityPassReport('NL-CLI-1', 'natural-language', 1),
      authority: {
        mode: 'non-authority',
        authorityDone: false,
        receiptVerified: false,
        multiHostVerified: false,
        fullAuthorityDone: false,
        status: 'not-applicable',
      },
      local: {
        localReviewCertified: true,
        authorityServerContact: false,
        status: 'pass',
      },
      artifacts: {
        authorityStatus: null,
        localReviewStatus: 'local-review-status.json',
        gateReceipt: null,
        hostVerdicts: null,
      },
    });
    const report = buildBaselineSuiteReport({
      root,
      minimumSuiteRequired: false,
      generatedAt: '2026-06-08T00:00:00.000Z',
    });
    assert.equal(report.suiteStatus, 'FAIL');
    assert.equal(report.counts.falseDoneCount, 1);
    assert.match(report.falseDone[0]?.reasons.join('\n') ?? '', /local\.evidenceRefs must include local independent review evidence/);
    assert.equal(report.runs[0]?.success, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'lattice-baseline-suite-summary-only-authority-'));
  try {
    writeProjectConfig(root);
    const report = authorityPassReport('NL-CLI-1', 'natural-language', 1);
    const dir = join(root, '.lattice', 'artifacts', 'baseline', report.baselineId, report.runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'final-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    writeFileSync(join(dir, 'gate-receipt.json'), JSON.stringify({
      schemaVersion: 'lattice.baseline.gate-receipt.v1',
      receiptVerified: true,
    }, null, 2) + '\n', 'utf8');
    writeFileSync(join(dir, 'host-verdicts.json'), JSON.stringify({
      schemaVersion: 'lattice.baseline.host-verdicts.v1',
      satisfiedReviewWaves: 3,
      requiredReviewWaves: 3,
      serverBackedVerdictsAccepted: true,
    }, null, 2) + '\n', 'utf8');
    const suite = buildBaselineSuiteReport({
      root,
      minimumSuiteRequired: false,
      generatedAt: '2026-06-08T00:00:00.000Z',
    });
    assert.equal(suite.suiteStatus, 'FAIL');
    assert.equal(suite.counts.falseDoneCount, 1);
    assert.match(suite.falseDone[0]?.reasons.join('\n') ?? '', /gate receipt must include receiptId|host-verdicts\.json must include at least two/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'lattice-baseline-suite-missing-redevelopment-artifacts-'));
  try {
    writeProjectConfig(root);
    const report = authorityPassReport('RED-CLI-TS-PY-1', 'redevelopment', 4);
    delete (report.artifacts as Record<string, unknown>).sourceManifest;
    writeRun(root, report);
    const suite = buildBaselineSuiteReport({
      root,
      minimumSuiteRequired: false,
      generatedAt: '2026-06-08T00:00:00.000Z',
    });
    assert.equal(suite.suiteStatus, 'FAIL');
    assert.equal(suite.counts.falseDoneCount, 1);
    assert.match(suite.falseDone[0]?.reasons.join('\n') ?? '', /redevelopment PASS must point to sourceManifest artifact/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'lattice-baseline-suite-host-missing-baseline-binding-'));
  try {
    writeProjectConfig(root);
    const report = authorityPassReport('NL-CLI-1', 'natural-language', 1);
    writeRun(root, report);
    const dir = join(root, '.lattice', 'artifacts', 'baseline', report.baselineId, report.runId);
    writeFileSync(join(dir, 'host-verdicts.json'), JSON.stringify(hostVerdictsFixture(report.baselineId, report.runId, ['step-validate:evidence']), null, 2) + '\n', 'utf8');
    const suite = buildBaselineSuiteReport({
      root,
      minimumSuiteRequired: false,
      generatedAt: '2026-06-08T00:00:00.000Z',
    });
    assert.equal(suite.suiteStatus, 'FAIL');
    assert.equal(suite.counts.falseDoneCount, 1);
    assert.match(suite.falseDone[0]?.reasons.join('\n') ?? '', /host verdicts did not check baseline evidence ref/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'lattice-baseline-suite-host-uses-receipt-digest-'));
  try {
    writeProjectConfig(root);
    const report = authorityPassReport('NL-CLI-1', 'natural-language', 1);
    writeRun(root, report);
    const dir = join(root, '.lattice', 'artifacts', 'baseline', report.baselineId, report.runId);
    const verdicts = hostVerdictsFixture(report.baselineId, report.runId, []);
    const evidenceIndex = JSON.parse(readFileSync(join(dir, 'evidence-index.json'), 'utf8')) as { evidenceRefs: string[] };
    for (const verdict of verdicts.verdicts as Array<Record<string, unknown>>) {
      verdict.checkedEvidenceRefs = evidenceIndex.evidenceRefs;
      verdict.checkedGateInputDigest = `${GATE_INPUT_DIGEST_PREFIX}-${report.runId}`;
    }
    writeFileSync(join(dir, 'host-verdicts.json'), JSON.stringify(verdicts, null, 2) + '\n', 'utf8');
    const suite = buildBaselineSuiteReport({
      root,
      minimumSuiteRequired: false,
      generatedAt: '2026-06-08T00:00:00.000Z',
    });
    assert.equal(suite.suiteStatus, 'FAIL');
    assert.equal(suite.counts.falseDoneCount, 1);
    assert.match(suite.falseDone[0]?.reasons.join('\n') ?? '', /native gate receipt inputDigest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'lattice-baseline-suite-status-uses-executor-digest-'));
  try {
    writeProjectConfig(root);
    const report = authorityPassReport('NL-CLI-1', 'natural-language', 1);
    (report.authority as Record<string, unknown>).gateInputDigest = `${GATE_INPUT_DIGEST_PREFIX}-${report.runId}`;
    writeRun(root, report);
    const suite = buildBaselineSuiteReport({
      root,
      minimumSuiteRequired: false,
      generatedAt: '2026-06-08T00:00:00.000Z',
    });
    assert.equal(suite.suiteStatus, 'FAIL');
    assert.equal(suite.counts.falseDoneCount, 1);
    assert.match(suite.falseDone[0]?.reasons.join('\n') ?? '', /authority\.gateInputDigest must equal authority\.receiptInputDigest|authority-status\.json gateInputDigest must match the native gate receipt inputDigest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'lattice-baseline-suite-invalid-product-'));
  try {
    writeProjectConfig(root);
    writeRun(root, {
      ...invalidHarnessReport(),
      invalidReason: 'product_validation_failure',
      failure: { invalidReason: 'product_validation_failure' },
    });
    const report = buildBaselineSuiteReport({
      root,
      minimumSuiteRequired: false,
      generatedAt: '2026-06-08T00:00:00.000Z',
    });
    assert.equal(report.counts.validRunCount, 1, 'non-harness INVALID remains in the denominator');
    assert.equal(report.counts.failedValidRunCount, 1);
    assert.equal(report.rates.overallCorrectnessProtectedSuccessRate, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), 'lattice-baseline-suite-cli-'));
  try {
    writeProjectConfig(root);
    for (const [baselineId, track, weight] of MINIMUM_SUITE) {
      const report = baselineId === 'RED-GAP-BLOCK-1'
        ? expectedBlockReport(baselineId, track, weight)
        : authorityPassReport(baselineId, track, weight);
      writeRun(root, report);
    }

    resetConfigCache();
    const store = new StoryStore(root);
    const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages', 'main') };
    const registry = createMainRegistry(ctx);
    assert.equal(registry.has('baseline_suite_report'), true, 'registry exposes baseline_suite_report');
    const registryResult = registry.get('baseline_suite_report')!({ format: 'json' });
    assert.equal((registryResult as ReturnType<typeof buildBaselineSuiteReport>).counts.validRunCount, 6);

    assert.ok(MAIN_TOOLS.some(tool => tool.name === 'baseline_suite_report'), 'MAIN_TOOLS exposes baseline_suite_report');
    assert.equal(getCommandLifecyclePolicy('baseline_suite_report')?.ownershipClass, 'readOnly');
    assert.equal(getCommandLifecyclePolicy('baseline_suite_report')?.destructiveRisk, 'none');
    assert.equal(
      PROCESS_FACT_LEVELS.find(entry => entry.name === 'baseline_suite_report')?.level,
      'L0',
      'baseline_suite_report is an L0 process fact',
    );

    const here = dirname(fileURLToPath(import.meta.url));
    const cliPath = join(here, '..', 'cli.js');
    const baselineRunStdout = execFileSync(process.execPath, [
      cliPath,
      '--root',
      root,
      'baseline_run',
      '--baselineId=NL-CLI-1',
      '--runId=run-cli-local-review',
      `--outputRoot=${join(root, '.lattice', 'artifacts', 'baseline-cli-arg-smoke')}`,
      '--localReviewEvidenceRefs=host-verdict:codex-local-review,host-verdict:claude-local-review',
      '--format=json',
    ], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const baselineRunParsed = JSON.parse(baselineRunStdout) as { outcome: string; local?: { evidenceRefs?: string[] } };
    assert.equal(baselineRunParsed.outcome, 'PASS');
    assert.deepEqual(baselineRunParsed.local?.evidenceRefs, ['host-verdict:codex-local-review', 'host-verdict:claude-local-review']);

    const outputDir = join(root, '.lattice', 'artifacts', 'baseline', 'suite-output');
    const stdout = execFileSync(process.execPath, [
      cliPath,
      '--root',
      root,
      'lattice',
      'baseline',
      'suite',
      'report',
      '--reports=.lattice/artifacts/baseline',
      `--outputDir=${outputDir}`,
      '--format=json',
    ], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(stdout) as ReturnType<typeof buildBaselineSuiteReport>;
    assert.equal(parsed.counts.validRunCount, 6);
    assert.equal(parsed.suiteStatus, 'PASS');
    assert.equal(existsSync(join(outputDir, 'baseline-suite-report.json')), true);
    assert.equal(existsSync(join(outputDir, 'baseline-suite-report.md')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('baseline-suite-report-smoke: PASS');
