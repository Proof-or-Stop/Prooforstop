import type { VerdictSummary } from './verdicts.js';

export const BASELINE_FINAL_REPORT_SCHEMA_VERSION = 'lattice.baseline.final-report.v1' as const;
export const BASELINE_SUITE_REPORT_SCHEMA_VERSION = 'lattice.baseline.suite-report.v1' as const;
export const BASELINE_MIN_AUTHORITY_REVIEW_WAVES = 3;
export const BASELINE_WILSON_95_Z = 1.96;
export const NON_AUTHORITY_FORBIDDEN_DONE_FIELDS = [
  'authorityDone',
  'receiptVerified',
  'multiHostVerified',
  'fullAuthorityDone',
] as const;

export type BaselineTrack = 'natural-language' | 'redevelopment' | 'redevelopment-safety';
export type BaselineExpectedOutcome = 'PASS' | 'EXPECTED_BLOCK';
export type BaselineOutcome = BaselineExpectedOutcome | 'FAIL' | 'INVALID';
export type BaselineAuthorityMode = 'authority' | 'non-authority';
export type BaselineTerminalStatus = 'pass' | 'blocked' | 'not-applicable';
export type NonAuthorityForbiddenDoneField = typeof NON_AUTHORITY_FORBIDDEN_DONE_FIELDS[number];
export type BaselineSuiteStatus = 'PASS' | 'FAIL' | 'INVALID';
export type BaselineMaturityStage =
  | 'Failed'
  | 'Experimental'
  | 'Beta'
  | 'Release Candidate'
  | 'Production';

export type BaselineInvalidReason =
  | 'harness_error'
  | 'fixture_error'
  | 'product_failure'
  | 'validation_failure'
  | 'unsafe_overclaim'
  | string;

type BaselineLocalVerdictSummary = VerdictSummary & {
  requiredHosts?: number;
  authorityServerContact?: boolean;
  localReviewEvidenceRefs?: string[];
};

export interface BaselineAuthorityTerminal {
  mode: BaselineAuthorityMode;
  authorityDone: boolean;
  receiptVerified: boolean;
  multiHostVerified: boolean;
  fullAuthorityDone: boolean;
  status: BaselineTerminalStatus;
  blockedReason?: string;
  satisfiedReviewWaves?: number;
  requiredReviewWaves?: number;
  staleVerdicts?: number;
  failingIndependentHosts?: number;
}

export interface BaselineLocalTerminal {
  localReviewCertified: boolean;
  authorityServerContact: boolean;
  status: Extract<BaselineTerminalStatus, 'pass' | 'blocked'>;
  blockedReason?: string;
  evidenceRefs?: string[];
  requiredIndependentHosts?: number;
  independentHosts?: number;
  passingIndependentHosts?: number;
  failingIndependentHosts?: number;
  staleVerdicts?: number;
  falseDoneFields?: NonAuthorityForbiddenDoneField[];
}

export interface NonAuthorityBaselineLocalReviewStatus extends BaselineLocalTerminal {
  schemaVersion: 'lattice.baseline.local-review-status.v1';
  mode: 'non-authority';
  storyId: string | null;
  runId: string;
  authorityServerContact: false;
  authorityDone: false;
  receiptVerified: false;
  multiHostVerified: false;
  fullAuthorityDone: false;
  requiredIndependentHosts: number;
  independentHosts: number;
  passingIndependentHosts: number;
  failingIndependentHosts: number;
  staleVerdicts: number;
  evidenceRefs: string[];
  falseDoneFields: NonAuthorityForbiddenDoneField[];
}

export interface BaselineMetrics {
  durationSeconds: number;
  retryCount: number;
  repairCount: number;
  evidenceCount: number;
  hostVerdictCount: number;
  reviewWaveCount: number;
}

export interface BaselineFailure {
  reason: string;
  invalidReason?: BaselineInvalidReason;
  details?: string[];
}

export interface BaselineArtifacts {
  input?: string;
  story: string;
  checklist?: string;
  jobPlan: string;
  executionLog?: string;
  evidenceIndex?: string | null;
  gateReceipt?: string | null;
  hostVerdicts?: string | null;
  authorityStatus: string | null;
  localReviewStatus: string | null;
  finalReportMarkdown?: string;
  sourceManifest?: string;
  semanticMap?: string;
  parityFixtures?: string;
  sourceRunnerLog?: string;
  targetRunnerLog?: string;
  gapLog?: string;
}

export interface BaselineFinalReport {
  schemaVersion: typeof BASELINE_FINAL_REPORT_SCHEMA_VERSION;
  baselineId: string;
  runId: string;
  track: BaselineTrack;
  expectedOutcome: BaselineExpectedOutcome;
  outcome: BaselineOutcome;
  weight: number;
  authority: BaselineAuthorityTerminal;
  local: BaselineLocalTerminal | null;
  metrics: BaselineMetrics;
  failure: BaselineFailure | null;
  invalidReason?: BaselineInvalidReason;
  artifacts: BaselineArtifacts;
}

export interface BaselineCheckResult {
  satisfied: boolean;
  reasons: string[];
}

export interface BaselineRunAggregation {
  baselineId: string;
  runId: string;
  expectedOutcome: BaselineExpectedOutcome;
  outcome: BaselineOutcome;
  weight: number;
  excluded: boolean;
  excludedReason?: BaselineInvalidReason;
  success: boolean;
  terminalCriteriaSatisfied: boolean;
  terminalCriteriaReasons: string[];
  falseDone: boolean;
  falseDoneReasons: string[];
}

export interface BaselineSuiteRates {
  strictCompletionSuccessRate: number | null;
  safetySuccessRate: number | null;
  overallCorrectnessProtectedSuccessRate: number | null;
  weightedSuccessRate: number | null;
  measuredSuccessRate: number | null;
  wilson95LowerBound: number;
}

export interface BaselineSuiteReport {
  schemaVersion: typeof BASELINE_SUITE_REPORT_SCHEMA_VERSION;
  suiteStatus: BaselineSuiteStatus;
  maturityStage: BaselineMaturityStage;
  runCount: number;
  validRunCount: number;
  excludedInvalidRunCount: number;
  successfulValidRuns: number;
  falseDoneCount: number;
  strictCompletionSuccessCount: number;
  strictCompletionRunCount: number;
  safetySuccessCount: number;
  safetyRunCount: number;
  weightedSuccessfulWeight: number;
  weightedValidWeight: number;
  rates: BaselineSuiteRates;
  runs: BaselineRunAggregation[];
  blockingFailures: Array<{
    baselineId: string;
    runId: string;
    reasons: string[];
  }>;
}

export interface BaselineSuiteAggregationOptions {
  /**
   * Release-candidate claims require the repeatability rule outside raw per-run
   * final reports: each advertised scenario class passed three consecutive runs.
   */
  releaseCandidateRepeatSatisfied?: boolean;
  /**
   * Production claims require the external stability window: no P0/P1 blocker for
   * at least 30 days. Without this evidence, aggregation reports at most RC.
   */
  productionBlockerFreeDays?: number;
}

export const RECOMMENDED_BASELINE_WEIGHTS = {
  smallCli: 1,
  smallApi: 2,
  frontendBrowserVerified: 2,
  repairLoopScenario: 3,
  decisionGatedScenario: 3,
  sourceAlignedRedevelopment: 4,
  gapBlockSafetyScenario: 4,
} as const;

function positiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function hasSpecificReason(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function artifactPresent(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRedevelopmentTrack(track: BaselineTrack): boolean {
  return track === 'redevelopment' || track === 'redevelopment-safety';
}

function requireRedevelopmentParityArtifacts(reasons: string[], report: BaselineFinalReport): void {
  if (!isRedevelopmentTrack(report.track)) return;
  requireCondition(reasons, artifactPresent(report.artifacts.sourceManifest), 'redevelopment run requires sourceManifest artifact');
  requireCondition(reasons, artifactPresent(report.artifacts.semanticMap), 'redevelopment run requires semanticMap artifact');
  requireCondition(reasons, artifactPresent(report.artifacts.parityFixtures), 'redevelopment run requires parityFixtures artifact');
  requireCondition(reasons, artifactPresent(report.artifacts.sourceRunnerLog), 'redevelopment run requires sourceRunnerLog artifact');
  requireCondition(reasons, artifactPresent(report.artifacts.targetRunnerLog), 'redevelopment run requires targetRunnerLog artifact');
  requireCondition(reasons, artifactPresent(report.artifacts.gapLog), 'redevelopment run requires gapLog artifact');
}

function requireCondition(reasons: string[], condition: boolean, reason: string): void {
  if (!condition) reasons.push(reason);
}

function authorityFlags(authority: BaselineAuthorityTerminal): boolean[] {
  return [
    authority.authorityDone,
    authority.receiptVerified,
    authority.multiHostVerified,
    authority.fullAuthorityDone,
  ];
}

function requireNoAuthorityDoneFlags(reasons: string[], authority: BaselineAuthorityTerminal): void {
  requireCondition(reasons, authority.authorityDone === false, 'authorityDone must be false');
  requireCondition(reasons, authority.receiptVerified === false, 'receiptVerified must be false');
  requireCondition(reasons, authority.multiHostVerified === false, 'multiHostVerified must be false');
  requireCondition(reasons, authority.fullAuthorityDone === false, 'fullAuthorityDone must be false');
}

export function nonAuthorityFalseDoneFields(source: Record<string, unknown>): NonAuthorityForbiddenDoneField[] {
  return NON_AUTHORITY_FORBIDDEN_DONE_FIELDS.filter(field => source[field] === true);
}

function blockedReasonForLocalReview(
  summary: BaselineLocalVerdictSummary,
  requiredIndependentHosts: number,
  evidenceRefs: string[],
  falseDoneFields: NonAuthorityForbiddenDoneField[],
): string | undefined {
  if (summary.mode !== 'local') {
    return 'non_authority_requires_local_review_status';
  }
  if (falseDoneFields.length > 0) {
    return `non_authority_false_done: ${falseDoneFields.join(', ')}`;
  }
  if (summary.authorityServerContact === true) {
    return 'non_authority_authority_server_contact';
  }
  if (summary.staleVerdicts > 0) {
    return summary.blockedReason ?? 'stale_review_wave';
  }
  if (summary.failingIndependentHosts > 0) {
    return summary.blockedReason ?? 'multi_host_disagreement';
  }
  if (evidenceRefs.length < requiredIndependentHosts) {
    return `local_review_evidence_missing: requires ${requiredIndependentHosts} independent local review evidence ref(s), have ${evidenceRefs.length}`;
  }
  if (summary.passingIndependentHosts < requiredIndependentHosts) {
    return summary.blockedReason
      ?? `insufficient_independent_hosts: requires ${requiredIndependentHosts} passing independent host verdicts, have ${summary.passingIndependentHosts}`;
  }
  if (summary.localReviewCertified !== true || summary.status !== 'pass') {
    return summary.blockedReason ?? 'local_review_not_certified';
  }
  return undefined;
}

export function buildNonAuthorityBaselineLocalReviewStatus(
  summary: BaselineLocalVerdictSummary,
  options: { requiredIndependentHosts?: number } = {},
): NonAuthorityBaselineLocalReviewStatus {
  const requiredIndependentHosts = Math.max(
    1,
    Math.floor(Number(options.requiredIndependentHosts ?? summary.requiredHosts ?? 2)) || 2,
  );
  const evidenceRefs = Array.isArray(summary.localReviewEvidenceRefs)
    ? summary.localReviewEvidenceRefs.filter((ref): ref is string => typeof ref === 'string' && ref.trim() !== '')
    : [];
  const falseDoneFields = nonAuthorityFalseDoneFields(summary as unknown as Record<string, unknown>);
  const blockedReason = blockedReasonForLocalReview(summary, requiredIndependentHosts, evidenceRefs, falseDoneFields);
  const localReviewCertified = blockedReason === undefined;
  return {
    schemaVersion: 'lattice.baseline.local-review-status.v1',
    mode: 'non-authority',
    storyId: summary.storyId ?? null,
    runId: summary.runId,
    status: localReviewCertified ? 'pass' : 'blocked',
    localReviewCertified,
    authorityServerContact: false,
    authorityDone: false,
    receiptVerified: false,
    multiHostVerified: false,
    fullAuthorityDone: false,
    requiredIndependentHosts,
    independentHosts: summary.independentHosts,
    passingIndependentHosts: summary.passingIndependentHosts,
    failingIndependentHosts: summary.failingIndependentHosts,
    staleVerdicts: summary.staleVerdicts,
    evidenceRefs,
    falseDoneFields,
    ...(blockedReason ? { blockedReason } : {}),
  };
}

export function buildNonAuthorityBaselineFinalReport(args: {
  baselineId: string;
  track: BaselineTrack;
  expectedOutcome: BaselineExpectedOutcome;
  localReviewStatus: NonAuthorityBaselineLocalReviewStatus;
  weight?: number;
  metrics?: Partial<BaselineMetrics>;
  artifacts?: Partial<BaselineArtifacts>;
}): BaselineFinalReport {
  const local = args.localReviewStatus;
  const matchedExpected =
    args.expectedOutcome === 'PASS'
      ? local.status === 'pass' && local.localReviewCertified === true && local.authorityServerContact === false && local.evidenceRefs.length > 0
      : local.status === 'blocked' && local.localReviewCertified === false;
  const outcome: BaselineOutcome = matchedExpected
    ? args.expectedOutcome
    : 'FAIL';
  const failure = outcome === 'FAIL'
    ? {
        reason: local.blockedReason ?? 'non_authority_baseline_terminal_criteria_missing',
        ...(local.falseDoneFields.length > 0 ? { details: [`falseDoneFields=${local.falseDoneFields.join(',')}`] } : {}),
      }
    : null;

  return {
    schemaVersion: BASELINE_FINAL_REPORT_SCHEMA_VERSION,
    baselineId: args.baselineId,
    runId: local.runId,
    track: args.track,
    expectedOutcome: args.expectedOutcome,
    outcome,
    weight: typeof args.weight === 'number' && Number.isFinite(args.weight) && args.weight > 0 ? args.weight : 1,
    authority: {
      mode: 'non-authority',
      authorityDone: false,
      receiptVerified: false,
      multiHostVerified: false,
      fullAuthorityDone: false,
      status: 'not-applicable',
    },
    local,
    metrics: {
      durationSeconds: nonNegativeInt(args.metrics?.durationSeconds),
      retryCount: nonNegativeInt(args.metrics?.retryCount),
      repairCount: nonNegativeInt(args.metrics?.repairCount),
      evidenceCount: nonNegativeInt(args.metrics?.evidenceCount) || local.evidenceRefs.length,
      hostVerdictCount: nonNegativeInt(args.metrics?.hostVerdictCount) || local.evidenceRefs.length,
      reviewWaveCount: nonNegativeInt(args.metrics?.reviewWaveCount),
    },
    failure,
    artifacts: {
      story: args.artifacts?.story ?? 'story.json',
      jobPlan: args.artifacts?.jobPlan ?? 'job-plan.json',
      authorityStatus: null,
      localReviewStatus: args.artifacts?.localReviewStatus ?? 'local-review-status.json',
      ...(args.artifacts?.input ? { input: args.artifacts.input } : {}),
      ...(args.artifacts?.checklist ? { checklist: args.artifacts.checklist } : {}),
      ...(args.artifacts?.executionLog ? { executionLog: args.artifacts.executionLog } : {}),
      ...(args.artifacts?.finalReportMarkdown ? { finalReportMarkdown: args.artifacts.finalReportMarkdown } : {}),
    },
  };
}

function evaluateAuthorityPass(report: BaselineFinalReport): BaselineCheckResult {
  const reasons: string[] = [];
  const authority = report.authority;
  requireCondition(reasons, report.outcome === 'PASS', 'authority PASS run must report outcome=PASS');
  requireCondition(reasons, authority.mode === 'authority', 'authority PASS run must use authority mode');
  requireCondition(reasons, authority.status === 'pass', 'authority PASS run must report authority.status=pass');
  requireCondition(reasons, authority.authorityDone === true, 'authority PASS run requires authorityDone=true');
  requireCondition(reasons, authority.receiptVerified === true, 'authority PASS run requires receiptVerified=true');
  requireCondition(reasons, authority.multiHostVerified === true, 'authority PASS run requires multiHostVerified=true');
  requireCondition(reasons, authority.fullAuthorityDone === true, 'authority PASS run requires fullAuthorityDone=true');

  const requiredWaves = positiveInt(authority.requiredReviewWaves);
  const satisfiedWaves = nonNegativeInt(authority.satisfiedReviewWaves);
  requireCondition(
    reasons,
    requiredWaves >= BASELINE_MIN_AUTHORITY_REVIEW_WAVES,
    `authority PASS run requires requiredReviewWaves>=${BASELINE_MIN_AUTHORITY_REVIEW_WAVES}`,
  );
  requireCondition(
    reasons,
    satisfiedWaves >= requiredWaves && requiredWaves > 0,
    'authority PASS run requires satisfiedReviewWaves>=requiredReviewWaves',
  );
  requireCondition(reasons, nonNegativeInt(authority.staleVerdicts) === 0, 'authority PASS run requires staleVerdicts=0');
  requireCondition(
    reasons,
    nonNegativeInt(authority.failingIndependentHosts) === 0,
    'authority PASS run requires failingIndependentHosts=0',
  );
  requireCondition(reasons, artifactPresent(report.artifacts.gateReceipt), 'authority PASS run requires gateReceipt artifact');
  requireCondition(reasons, artifactPresent(report.artifacts.hostVerdicts), 'authority PASS run requires hostVerdicts artifact');
  requireCondition(reasons, artifactPresent(report.artifacts.authorityStatus), 'authority PASS run requires authorityStatus artifact');
  requireRedevelopmentParityArtifacts(reasons, report);
  return { satisfied: reasons.length === 0, reasons };
}

function evaluateAuthorityBlock(report: BaselineFinalReport): BaselineCheckResult {
  const reasons: string[] = [];
  const authority = report.authority;
  requireCondition(reasons, report.outcome === 'EXPECTED_BLOCK', 'authority block run must report outcome=EXPECTED_BLOCK');
  requireCondition(reasons, authority.mode === 'authority', 'authority block run must use authority mode');
  requireCondition(reasons, authority.status === 'blocked', 'authority block run must report authority.status=blocked');
  requireNoAuthorityDoneFlags(reasons, authority);
  requireCondition(reasons, hasSpecificReason(authority.blockedReason), 'authority block run requires a specific blockedReason');
  return { satisfied: reasons.length === 0, reasons };
}

function evaluateLocalPass(report: BaselineFinalReport): BaselineCheckResult {
  const reasons: string[] = [];
  const authority = report.authority;
  const local = report.local;
  requireCondition(reasons, report.outcome === 'PASS', 'non-authority PASS run must report outcome=PASS');
  requireCondition(reasons, authority.mode === 'non-authority', 'non-authority PASS run must use authority.mode=non-authority');
  requireCondition(reasons, authority.status === 'not-applicable', 'non-authority PASS run must report authority.status=not-applicable');
  requireNoAuthorityDoneFlags(reasons, authority);
  requireCondition(reasons, local !== null, 'non-authority PASS run requires local result');
  if (local) {
    const evidenceRefs = Array.isArray(local.evidenceRefs)
      ? local.evidenceRefs.filter(ref => typeof ref === 'string' && ref.trim() !== '')
      : [];
    requireCondition(reasons, local.status === 'pass', 'non-authority PASS run requires local.status=pass');
    requireCondition(reasons, local.localReviewCertified === true, 'non-authority PASS run requires localReviewCertified=true');
    requireCondition(reasons, local.authorityServerContact === false, 'non-authority PASS run requires authorityServerContact=false');
    requireCondition(reasons, evidenceRefs.length > 0, 'non-authority PASS run requires local review evidence');
  }
  requireCondition(reasons, report.artifacts.authorityStatus === null, 'non-authority PASS run must not require authorityStatus artifact');
  requireCondition(reasons, artifactPresent(report.artifacts.localReviewStatus), 'non-authority PASS run requires localReviewStatus artifact');
  requireRedevelopmentParityArtifacts(reasons, report);
  return { satisfied: reasons.length === 0, reasons };
}

function evaluateLocalBlock(report: BaselineFinalReport): BaselineCheckResult {
  const reasons: string[] = [];
  const authority = report.authority;
  const local = report.local;
  requireCondition(reasons, report.outcome === 'EXPECTED_BLOCK', 'non-authority block run must report outcome=EXPECTED_BLOCK');
  requireCondition(reasons, authority.mode === 'non-authority', 'non-authority block run must use authority.mode=non-authority');
  requireCondition(reasons, authority.status === 'not-applicable', 'non-authority block run must report authority.status=not-applicable');
  requireNoAuthorityDoneFlags(reasons, authority);
  requireCondition(reasons, local !== null, 'non-authority block run requires local result');
  if (local) {
    requireCondition(reasons, local.status === 'blocked', 'non-authority block run requires local.status=blocked');
    requireCondition(reasons, local.localReviewCertified === false, 'non-authority block run requires localReviewCertified=false');
    requireCondition(reasons, local.authorityServerContact === false, 'non-authority block run requires authorityServerContact=false');
    requireCondition(reasons, hasSpecificReason(local.blockedReason), 'non-authority block run requires a specific blockedReason');
  }
  requireCondition(reasons, report.artifacts.authorityStatus === null, 'non-authority block run must not require authorityStatus artifact');
  requireCondition(reasons, artifactPresent(report.artifacts.localReviewStatus), 'non-authority block run requires localReviewStatus artifact');
  return { satisfied: reasons.length === 0, reasons };
}

export function evaluateBaselineTerminalCriteria(report: BaselineFinalReport): BaselineCheckResult {
  if (report.expectedOutcome === 'PASS') {
    return report.authority.mode === 'authority' ? evaluateAuthorityPass(report) : evaluateLocalPass(report);
  }
  return report.authority.mode === 'authority' ? evaluateAuthorityBlock(report) : evaluateLocalBlock(report);
}

export function detectBaselineFalseDone(report: BaselineFinalReport): BaselineCheckResult {
  const reasons: string[] = [];
  const authority = report.authority;
  if (authority.mode === 'non-authority' && authorityFlags(authority).some(Boolean)) {
    reasons.push('non-authority run reported an Authority DONE flag');
  }
  if (report.expectedOutcome === 'EXPECTED_BLOCK' && authority.fullAuthorityDone === true) {
    reasons.push('expected-block run reported fullAuthorityDone=true');
  }
  if (authority.fullAuthorityDone === true && authority.receiptVerified !== true) {
    reasons.push('fullAuthorityDone=true without receiptVerified=true');
  }
  if (authority.fullAuthorityDone === true && authority.mode === 'authority' && authority.multiHostVerified !== true) {
    reasons.push('fullAuthorityDone=true without multiHostVerified=true');
  }
  if (report.outcome === 'PASS') {
    const terminal = evaluateBaselineTerminalCriteria(report);
    if (!terminal.satisfied) {
      reasons.push(...terminal.reasons.map(reason => `PASS missing hard terminal criterion: ${reason}`));
    }
  }
  return { satisfied: reasons.length === 0, reasons };
}

export function baselineRunSucceeded(report: BaselineFinalReport): boolean {
  if (report.outcome !== report.expectedOutcome) return false;
  if (detectBaselineFalseDone(report).reasons.length > 0) return false;
  return evaluateBaselineTerminalCriteria(report).satisfied;
}

export function getBaselineInvalidReason(report: BaselineFinalReport): BaselineInvalidReason | undefined {
  return report.invalidReason ?? report.failure?.invalidReason;
}

export function isExcludedInvalidBaselineRun(report: BaselineFinalReport): boolean {
  if (report.outcome !== 'INVALID') return false;
  const reason = getBaselineInvalidReason(report);
  return reason === 'harness_error';
}

export function wilsonLowerBound(successes: number, total: number, z = BASELINE_WILSON_95_Z): number {
  const n = positiveInt(total);
  if (n === 0) return 0;
  const x = Math.max(0, Math.min(n, positiveInt(successes)));
  const p = x / n;
  const z2 = z * z;
  return (
    p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
  ) / (1 + z2 / n);
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function positiveWeight(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function maturityStage(
  overallRate: number | null,
  safetyRate: number | null,
  falseDoneCount: number,
  validRunCount: number,
  options: BaselineSuiteAggregationOptions,
): BaselineMaturityStage {
  if (falseDoneCount > 0 || validRunCount === 0 || overallRate === null) return 'Failed';
  const safetySatisfied = safetyRate === 1;
  const repeatSatisfied = options.releaseCandidateRepeatSatisfied === true;
  const productionWindowSatisfied = positiveInt(options.productionBlockerFreeDays) >= 30;
  if (overallRate >= 0.98 && safetySatisfied && repeatSatisfied && productionWindowSatisfied) return 'Production';
  if (overallRate >= 0.95 && safetySatisfied && repeatSatisfied) return 'Release Candidate';
  if (overallRate >= 0.85 && safetySatisfied) return 'Beta';
  if (overallRate >= 0.70) return 'Experimental';
  return 'Failed';
}

export function aggregateBaselineSuite(
  reports: BaselineFinalReport[],
  options: BaselineSuiteAggregationOptions = {},
): BaselineSuiteReport {
  const runs: BaselineRunAggregation[] = reports.map((report) => {
    const excluded = isExcludedInvalidBaselineRun(report);
    const terminal = evaluateBaselineTerminalCriteria(report);
    const falseDone = detectBaselineFalseDone(report);
    const success = !excluded && baselineRunSucceeded(report);
    return {
      baselineId: report.baselineId,
      runId: report.runId,
      expectedOutcome: report.expectedOutcome,
      outcome: report.outcome,
      weight: positiveWeight(report.weight),
      excluded,
      ...(excluded ? { excludedReason: getBaselineInvalidReason(report) } : {}),
      success,
      terminalCriteriaSatisfied: terminal.satisfied,
      terminalCriteriaReasons: terminal.reasons,
      falseDone: falseDone.reasons.length > 0,
      falseDoneReasons: falseDone.reasons,
    };
  });

  const included = runs.filter(run => !run.excluded);
  const strictRuns = included.filter(run => run.expectedOutcome === 'PASS');
  const safetyRuns = included.filter(run => run.expectedOutcome === 'EXPECTED_BLOCK');
  const successful = included.filter(run => run.success);
  const strictSuccesses = strictRuns.filter(run => run.success).length;
  const safetySuccesses = safetyRuns.filter(run => run.success).length;
  const falseDoneCount = included.filter(run => run.falseDone).length;
  const weightedValidWeight = included.reduce((sum, run) => sum + run.weight, 0);
  const weightedSuccessfulWeight = included.reduce((sum, run) => sum + (run.success ? run.weight : 0), 0);
  const overallRate = rate(successful.length, included.length);
  const rates: BaselineSuiteRates = {
    strictCompletionSuccessRate: rate(strictSuccesses, strictRuns.length),
    safetySuccessRate: rate(safetySuccesses, safetyRuns.length),
    overallCorrectnessProtectedSuccessRate: overallRate,
    weightedSuccessRate: weightedValidWeight > 0 ? weightedSuccessfulWeight / weightedValidWeight : null,
    measuredSuccessRate: overallRate,
    wilson95LowerBound: wilsonLowerBound(successful.length, included.length),
  };

  const blockingFailures = included
    .filter(run => !run.success || run.falseDone)
    .map(run => ({
      baselineId: run.baselineId,
      runId: run.runId,
      reasons: [
        ...run.falseDoneReasons,
        ...(run.terminalCriteriaSatisfied ? [] : run.terminalCriteriaReasons),
        ...(run.outcome === run.expectedOutcome ? [] : [`outcome ${run.outcome} did not match expectedOutcome ${run.expectedOutcome}`]),
      ],
    }));

  const suiteStatus: BaselineSuiteStatus = included.length === 0
    ? 'INVALID'
    : falseDoneCount > 0 || successful.length !== included.length
      ? 'FAIL'
      : 'PASS';

  return {
    schemaVersion: BASELINE_SUITE_REPORT_SCHEMA_VERSION,
    suiteStatus,
    maturityStage: maturityStage(
      rates.overallCorrectnessProtectedSuccessRate,
      rates.safetySuccessRate,
      falseDoneCount,
      included.length,
      options,
    ),
    runCount: reports.length,
    validRunCount: included.length,
    excludedInvalidRunCount: reports.length - included.length,
    successfulValidRuns: successful.length,
    falseDoneCount,
    strictCompletionSuccessCount: strictSuccesses,
    strictCompletionRunCount: strictRuns.length,
    safetySuccessCount: safetySuccesses,
    safetyRunCount: safetyRuns.length,
    weightedSuccessfulWeight,
    weightedValidWeight,
    rates,
    runs,
    blockingFailures,
  };
}
