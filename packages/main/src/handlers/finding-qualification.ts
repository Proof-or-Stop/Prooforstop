/** Public signed-query adapter for the §11 aggregator. No protected-file parsing. */
import { cpus, platform, arch } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { HandlerContext } from './context.js';
import { readBrandEnv } from '../core/brand-env.js';
import { resolveRegisteredAgentActor } from '../core/agent-dispatch-registry.js';
import { collectReviewerEvidenceState, verifyReviewRun } from '../core/review-run.js';
import { verifyReviewPass } from '../core/finding-verify.js';
import { loadConfig } from '../core/config.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { applicabilityDigest, verifyDynamicFindingRecord } from '../core/finding-applicability.js';
import { FINDING_QUALIFICATION_POLICY, buildFindingQualificationScorecard, type FindingQualificationCorpus, type QualificationMeasurement } from '../core/finding-rollout-qualification.js';
import { identityStoryContext, historicalStoryContext, identityTrust, verifiedIdentityCarrier } from './finding-identity-store.js';
import { readCurrentFindingRuntimeEvidence, readHistoricalFindingRuntimeEvidence, exactLedgerRecordHash } from './finding-ledger.js';
import type { JsonValue } from '../core/finding-ledger.js';
import { findingWitnessCommandText } from './finding-applicability-proof.js';
import { createFindingLedgerHandlers } from './finding-ledger.js';
import { createFindingHistoryHandlers } from './finding-history.js';

/** Caller-reported rates are diagnostics, not a source of qualification counts.
 * Only this allowlisted public-query reducer creates aggregate measurements.
 * Missing collectors stay absent, producing explicit insufficient-evidence rows. */
export function deriveQualificationQueryMeasurements(input: {
  identity: ReturnType<ReturnType<typeof createFindingHistoryHandlers>['finding_identity_scorecard']>;
  caseId: string; storyId: string; observedAt: string;
}) {
  return input.identity.detectorMeasurements.map(row => ({ metric: 'candidate_conversion' as const,
    caseId: `${input.caseId}:${row.detectorId}:${row.detectorVersion}:${row.family}`, storyId: input.storyId,
    severity: 'low' as const, observedAt: input.observedAt,
    numerator: row.adjudicatedPromotionFraction.numerator, denominator: row.adjudicatedPromotionFraction.denominator,
    evidenceDigests: [input.identity.digest, input.identity.inputDigest], independentlyAdjudicated: true,
    // Descriptive detector accounting must not manufacture operational cases.
    synthetic: true }));
}

export function prepareFindingQualificationCase(ctx: HandlerContext, input: {
  storyId: string; findingId: string; assessmentId: string; reviewRunId: string; runtimeReceiptId: string;
}) {
  const actor = resolveRegisteredAgentActor(readBrandEnv('AGENT'));
  const story = ctx.store.readStory(input.storyId);
  if (!actor?.reviewerLane || !actor.permittedMutations.includes('review_pass_set') || story.phase !== 'REVIEW') throw new Error('qualification: independent REVIEW actor required');
  const finding = ctx.store.readFindings(input.storyId).findings.find(row => row.id === input.findingId);
  if (!finding || actor.canonicalName === finding.agent) throw new Error('qualification: independent adjudicator must differ from the source observer');
  const state = collectReviewerEvidenceState(ctx.store, input.storyId, ctx.root);
  if (!state.valid.some(row => row.agent === actor.canonicalName && row.reviewRunId === input.reviewRunId)) throw new Error('qualification: current signed independent reviewer evidence required');
  const ledger = ctx.store.readFindingLedger<JsonValue>(input.storyId);
  const source = ledger.records.find(row => row.recordType === 'finding_applicability_assessment'
    && (row.payload as unknown as { assessmentId?: string; findingId?: string }).assessmentId === input.assessmentId
    && (row.payload as unknown as { findingId?: string }).findingId === finding.id);
  if (!source) throw new Error('qualification: exact proposed assessment required');
  verifiedIdentityCarrier(ledger, input.storyId, source.recordId, identityTrust(ctx));
  if (!verifyDynamicFindingRecord(source.payload as Record<string, unknown>, identityTrust(ctx).publicKey)) throw new Error('qualification: invalid source assessment signature');
  const runtime = readCurrentFindingRuntimeEvidence(ctx, input.storyId, input.runtimeReceiptId);
  if (runtime.receipt.exitCode !== 0) throw new Error('qualification: measurement command failed');
  const reviewMarker = `finding-qualification:${input.assessmentId}:${runtime.receipt.receiptId}:${runtime.receipt.receiptHash}`;
  if (!state.valid.some(row => row.kind === 'pass' && row.agent === actor.canonicalName && row.reviewRunId === input.reviewRunId
    && row.pass?.note?.split(/\r?\n/).includes(reviewMarker))) throw new Error('qualification: independent signed PASS must bind the exact measured case and runtime receipt');
  const pins = ctx.store.readChecklist(input.storyId).items.flatMap(item => Object.values(item.verificationIntent ?? {}).flatMap(rows =>
    Array.isArray(rows) ? rows.flatMap(row => row.verification?.command ? [row.verification.command] : []) : []));
  const command = findingWitnessCommandText(runtime.executionCommand);
  if (!pins.includes(command)) throw new Error('qualification: measurement command must be preregistered in reviewed verification intent');
  const lines = runtime.stdout.split(/\r?\n/).filter(line => line.startsWith('FINDING_QUALIFICATION '));
  if (lines.length !== 1) throw new Error('qualification: one executed measurement document required');
  const measured = JSON.parse(lines[0]!.slice('FINDING_QUALIFICATION '.length)) as {
    schemaVersion: string; assessmentId: string; population: 'operational' | 'adversarial';
    storyClass: string; detectorVersion: string; retryPolicy: string; exclusions: string[];
    timingSeconds: FindingQualificationCorpus['timingSeconds'];
    measurements: Array<Pick<QualificationMeasurement, 'metric' | 'numerator' | 'denominator' | 'latencySeconds' | 'rollbackEvent'>>;
    prerequisites: Array<{ name: string; mergedCommit: string }>;
    simpleStoryRegression: number | null; timeoutRate: number | null; latencyCorpusSize: number; candidateBaselineExplained: boolean;
  };
  if (measured.schemaVersion !== FINDING_QUALIFICATION_POLICY.version || measured.assessmentId !== input.assessmentId
    || !['operational', 'adversarial'].includes(measured.population) || !Array.isArray(measured.measurements) || !measured.measurements.length) throw new Error('qualification: wrong/incomplete measurement subject');
  const observedAt = new Date().toISOString();
  // Reassessment/retry cannot manufacture another independent case.
  if (!finding.recordId) throw new Error('qualification: canonical source observation receipt required');
  const caseId = `${input.storyId}:${finding.recordId}:${measured.population}`;
  const reviewPass = state.valid.find(row => row.kind === 'pass' && row.agent === actor.canonicalName && row.reviewRunId === input.reviewRunId
    && row.pass?.note?.split(/\r?\n/).includes(reviewMarker))!.pass!;
  const evidenceDigests = [exactLedgerRecordHash(source), runtime.receipt.receiptHash,
    applicabilityDigest(ctx.store.readReviewRuns(input.storyId).runs.find(row => row.reviewRunId === input.reviewRunId))];
  const measurements: QualificationMeasurement[] = measured.measurements.map(row => ({ ...row, caseId, storyId: input.storyId,
    severity: finding.severity, observedAt, evidenceDigests, independentlyAdjudicated: true, synthetic: measured.population !== 'operational' }));
  const prerequisites = Object.fromEntries((measured.prerequisites ?? []).map(row => {
    if (!FINDING_QUALIFICATION_POLICY.requiredPrerequisites.includes(row.name) || !/^[a-f0-9]{40,64}$/.test(row.mergedCommit)) throw new Error('qualification: invalid merged prerequisite');
    execFileSync('git', ['merge-base', '--is-ancestor', row.mergedCommit, 'main'], { cwd: ctx.root, stdio: 'pipe' });
    return [row.name, { passed: true, evidenceDigests: [...evidenceDigests, applicabilityDigest({ name: row.name, mergedCommit: row.mergedCommit })] }];
  }));
  const identityQuery = createFindingHistoryHandlers(ctx).finding_identity_scorecard({ storyId: input.storyId, sourceStoryIds: [input.storyId], mode: 'warn' });
  const ledgerQuery = createFindingLedgerHandlers(ctx).finding_ledger_query({ storyId: input.storyId });
  const queryMeasurements = deriveQualificationQueryMeasurements({ identity: identityQuery, caseId, storyId: input.storyId, observedAt });
  return { source, runtime, record: { schemaVersion: 1, action: 'qualification_case', caseId, findingId: finding.id, assessmentId: input.assessmentId,
    actor: actor.canonicalName, reviewRunId: input.reviewRunId, runtimeReceiptId: input.runtimeReceiptId,
    sourceAssessmentRecordId: source.recordId, sourceAssessmentRecordHash: exactLedgerRecordHash(source),
    reviewPassId: reviewPass.id, reviewPassDigest: applicabilityDigest(reviewPass), runtimeReceiptHash: runtime.receipt.receiptHash,
    featureState: loadConfig(ctx.root).dynamicFinding?.mode === 'warn' ? 'warn' as const : 'observe' as const,
    policyDigest: applicabilityDigest(FINDING_QUALIFICATION_POLICY), observedAt,
    repositoryHead: currentGitHead(ctx.root), materialHash: currentMaterialHash(ctx.root),
    storyClass: measured.storyClass, detectorVersion: measured.detectorVersion, retryPolicy: measured.retryPolicy, exclusions: measured.exclusions,
    latencyHardware: `${platform()} ${arch()} ${cpus()[0]?.model ?? 'unknown'} cores=${cpus().length}`,
    timingSeconds: measured.timingSeconds, measurements, prerequisites,
    measurementAuthority: 'reported_statistics_non_qualifying' as const,
    publicQueries: { identity: identityQuery, ledger: ledgerQuery }, queryMeasurements,
    simpleStoryRegression: measured.simpleStoryRegression, timeoutRate: measured.timeoutRate, latencyCorpusSize: measured.latencyCorpusSize,
    candidateBaselineExplained: measured.candidateBaselineExplained } };
}

export function findingQualificationQuery(ctx: HandlerContext, storyId: string) {
  const source = historicalStoryContext(ctx, storyId);
  const ledger = source.store.readFindingLedger<JsonValue>(storyId); const trust = identityTrust(source);
  return ledger.records.filter(row => row.recordType === 'dynamic_finding_manifest'
    && (row.payload as unknown as { action?: string }).action === 'qualification_case').map(row => {
      verifiedIdentityCarrier(ledger, storyId, row.recordId, trust);
      if (!verifyDynamicFindingRecord(row.payload as Record<string, unknown>, trust.publicKey)) throw new Error('qualification: invalid case signature');
      const caseRecord = row.payload as unknown as ReturnType<typeof prepareFindingQualificationCase>['record'];
      const assessment = verifiedIdentityCarrier(ledger, storyId, caseRecord.sourceAssessmentRecordId, trust).record;
      if (exactLedgerRecordHash(assessment) !== caseRecord.sourceAssessmentRecordHash || assessment.recordType !== 'finding_applicability_assessment'
        || !verifyDynamicFindingRecord(assessment.payload as Record<string, unknown>, trust.publicKey)) throw new Error('qualification: source assessment substituted');
      const runtime = readHistoricalFindingRuntimeEvidence(source, storyId, caseRecord.runtimeReceiptId);
      const run = source.store.readReviewRuns(storyId).runs.find(run => run.reviewRunId === caseRecord.reviewRunId);
      const pass = source.store.readReviewPasses(storyId).passes.find(pass => pass.id === caseRecord.reviewPassId);
      if (runtime.receipt.receiptHash !== caseRecord.runtimeReceiptHash || !run || !verifyReviewRun(run, source.store)
        || !pass || !verifyReviewPass(storyId, pass) || applicabilityDigest(pass) !== caseRecord.reviewPassDigest
        || pass.reviewRunId !== run.reviewRunId || pass.agent !== caseRecord.actor) throw new Error('qualification: historical independent/runtime evidence invalid');
      return { recordId: row.recordId, recordHash: exactLedgerRecordHash(row), payload: row.payload as unknown as ReturnType<typeof prepareFindingQualificationCase>['record'] };
    });
}

export function readFindingQualificationScorecard(ctx: HandlerContext) {
  const ids = loadConfig(ctx.root).dynamicFinding?.qualificationStoryIds ?? [];
  const refusalReasons: string[] = [];
  let corpus: FindingQualificationCorpus | undefined;
  try {
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw new Error('qualification corpus not configured');
    const rows = ids.flatMap(id => findingQualificationQuery(ctx, id));
    const cases = rows.map(row => row.payload).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    if (!cases.length || cases.some(row => row.policyDigest !== applicabilityDigest(FINDING_QUALIFICATION_POLICY))) throw new Error('qualification cases missing/stale policy');
    const last = cases.at(-1)!;
    // Historical operational observations retain their original HEAD. Admission
    // prerequisites must additionally be remeasured at this exact material state.
    if (last.materialHash !== currentMaterialHash(ctx.root)) throw new Error('qualification merged-state prerequisites stale');
    const timing = { classifier: 0, triage: 0, repair: 0, convergence: 0 };
    for (const row of cases) for (const key of Object.keys(timing) as Array<keyof typeof timing>) timing[key] += row.timingSeconds[key];
    corpus = { policyDigest: applicabilityDigest(FINDING_QUALIFICATION_POLICY), featureState: last.featureState,
      window: { start: cases[0]!.observedAt, end: last.observedAt }, repositoryHeads: [...new Set(cases.map(row => row.repositoryHead!))],
      storyClasses: [...new Set(cases.map(row => row.storyClass))], detectorVersions: [...new Set(cases.map(row => row.detectorVersion))],
      retryPolicy: [...new Set(cases.map(row => row.retryPolicy))].join('; '), exclusions: [...new Set(cases.flatMap(row => row.exclusions))],
      latencyHardware: [...new Set(cases.map(row => row.latencyHardware))].join('; '), timingSeconds: timing,
      prerequisites: last.prerequisites, measurements: cases.flatMap(row => row.queryMeasurements ?? []), simpleStoryRegression: last.simpleStoryRegression,
      timeoutRate: last.timeoutRate, latencyCorpusSize: last.latencyCorpusSize, candidateBaselineExplained: last.candidateBaselineExplained };
    // The reviewed command's scalar report is retained for diagnosis, never
    // promoted to independent process-event/CAS/mutation measurements. These
    // collectors require their own signed public-query event joins.
    refusalReasons.push('qualification_source_collectors_incomplete: reported_statistics_are_not_independently_derived_counts');
  } catch (error) { refusalReasons.push(error instanceof Error ? error.message : String(error)); }
  const report = buildFindingQualificationScorecard(corpus);
  report.refusalReasons.push(...refusalReasons);
  report.qualification.eligible = report.refusalReasons.length === 0;
  return report;
}
