/** Versioned §11 scorecard. Measurements are supplied by verified public-query
 * adapters; a system verdict is never its own independent gold label. */
import { applicabilityDigest } from './finding-applicability.js';

export const FINDING_QUALIFICATION_METRICS = [
  ['false_nonblocking_high_critical', 'max', 0, 'Any event'],
  ['stale_tampered_rejection', 'min', 1, 'Any accepted mutation'],
  ['assessment_integrity_fail_closed', 'min', 1, 'Any invalid cell/control/transition'],
  ['mandatory_repair_closure_integrity', 'min', 1, 'Any floor or closure bypass'],
  ['nonblocking_precision', 'min', 0.98, 'Below 98% or any high/critical miss'],
  ['candidate_conversion', 'descriptive', null, 'Unexplained >10 percentage-point baseline drift'],
  ['canonical_root_cause_honesty', 'min', 1, 'Any fabricated or rewritten cause'],
  ['duplicate_route_accuracy', 'min', 0.98, 'Below 98% or any unowned high/critical'],
  ['suspected_route_isolation', 'min', 1, 'Any incomplete route or gate delta'],
  ['route_authority_freshness', 'min', 1, 'Any invalid authority or standalone gate delta'],
  ['initial_baseline_integrity', 'min', 1, 'Any invalid baseline or direct gate dependency'],
  ['exact_cas_deferral_atomicity', 'min', 1, 'Any stale tuple, race or partial commit'],
  ['deferral_route_completeness', 'min', 1, 'Any orphan, stale route or partial commit'],
  ['false_deferral', 'max', 0, 'Any event'],
  ['deferral_recall', 'min', 1, 'Any missing/non-idempotent recall or stale waiver'],
  ['expiry_policy_integrity', 'min', 1, 'Any invalid policy or lineage reset'],
  ['lineage_renewal_compliance', 'min', 1, 'Any invalid progress/count/horizon'],
  ['material_drift_reattestation', 'min', 1, 'Any unsafe release or indefinite valid-proof refusal'],
  ['scorecard_completeness', 'min', 1, 'Any missing row or false enforce eligibility'],
  ['workflow_operation_reduction', 'min', 0.5, 'Safety breach or no reduction for two windows'],
  ['review_convergence_reduction', 'min', 0.3, 'Simple-Story regression >10% for two windows'],
  ['triage_latency', 'latency', 5, 'p95 >10s for two windows or timeout rate >1%'],
] as const;
export type FindingQualificationMetric = typeof FINDING_QUALIFICATION_METRICS[number][0];
export const FINDING_QUALIFICATION_POLICY = Object.freeze({ version: 'dynamic-finding-qualification-v1',
  adjudication: 'per-subject-source-and-decision-author-distinct-v1',
  provenance: 'executed-merged-prerequisites-and-unique-performance-sources-v1',
  minStories: 20, minCases: 200, minDays: 30, confidence: 0.95, method: 'one-sided-binomial-zero-event',
  latency: Object.freeze({ p50Seconds: 2, p95Seconds: 5, minCorpusSize: 2273, maxTimeoutRate: 0.01 }),
  simpleStory: Object.freeze({ maxFindings: 5, maxRegression: 0.1 }),
  metrics: FINDING_QUALIFICATION_METRICS,
  requiredPrerequisites: ['ledger_integrity_merged', 'runtime_integrity_merged', 'identity_lineage_merged',
    'dependency_mutation_suite', 'merged_state_combination_review', 'targeted_adversarial_suite'] });

export interface QualificationMeasurement {
  metric: FindingQualificationMetric;
  /** Reassessments of one observation are measured but do not inflate cases. */
  observationId?: string;
  caseId: string; storyId: string; severity: 'critical' | 'high' | 'medium' | 'low';
  observedAt: string; numerator: number; denominator: number;
  /** Produced by the query adapter only after checking independent review and receipt provenance. */
  evidenceDigests: string[];
  independentlyAdjudicated: boolean;
  synthetic: boolean;
  latencySeconds?: number;
  latencyPopulationSize?: number;
  rollbackEvent?: boolean;
  performanceSource?: QualificationPerformanceSource;
}
export interface QualificationPerformanceSource {
  baselineStoryId: string; candidateStoryId: string;
  baselineDigest: string; candidateDigest: string; attemptId?: string;
}
export const QUALIFICATION_PERFORMANCE_METRICS = ['workflow_operation_reduction', 'review_convergence_reduction', 'triage_latency'];
export interface FindingQualificationCorpus {
  policyDigest: string; featureState: 'observe' | 'warn';
  window: { start: string; end: string };
  repositoryHeads: string[]; storyClasses: string[]; detectorVersions: string[];
  retryPolicy: string; exclusions: string[]; latencyHardware: string;
  /** Separate buckets: repair is reported, never credited as saved time. */
  timingSeconds: { classifier: number; triage: number; repair: number; convergence: number };
  prerequisites: Record<string, { passed: boolean; evidenceDigests: string[] }>;
  measurements: QualificationMeasurement[];
  simpleStoryRegression: number | null;
  timeoutRate: number | null;
  latencyCorpusSize: number;
  candidateBaselineExplained: boolean;
}
function finiteNonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function digestList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item));
}
function nonemptyList(value: unknown): value is string[] { return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.trim()); }
function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)]!;
}
// Compensated addition preserves threshold boundaries (e.g. 200 × 0.3).
function sum(values: number[]): number {
  let total = 0; let correction = 0;
  for (const value of values) { const next = total + value; correction += Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total; total = next; }
  return total + correction;
}
export function buildFindingQualificationScorecard(corpus?: FindingQualificationCorpus, now = new Date()) {
  const refusalReasons: string[] = [];
  const policyDigest = applicabilityDigest(FINDING_QUALIFICATION_POLICY);
  const measurements = Array.isArray(corpus?.measurements) ? corpus.measurements : [];
  const start = Date.parse(corpus?.window?.start ?? ''); const end = Date.parse(corpus?.window?.end ?? '');
  const validWindow = Number.isFinite(start) && Number.isFinite(end) && end <= now.getTime() && end >= start;
  if (!corpus || corpus.policyDigest !== policyDigest) refusalReasons.push('qualification_policy_missing_or_mismatched');
  if (!validWindow || end - start < FINDING_QUALIFICATION_POLICY.minDays * 86_400_000) refusalReasons.push('qualification_window_under_30_days');
  if (!corpus || !nonemptyList(corpus.repositoryHeads) || !nonemptyList(corpus.storyClasses) || !nonemptyList(corpus.detectorVersions)
    || !corpus.retryPolicy?.trim() || !Array.isArray(corpus.exclusions) || !corpus.latencyHardware?.trim()
    || !['observe', 'warn'].includes(corpus.featureState)
    || !corpus.timingSeconds || !['classifier', 'triage', 'repair', 'convergence'].every(key => finiteNonnegative(corpus.timingSeconds[key as keyof typeof corpus.timingSeconds]))) {
    refusalReasons.push('qualification_metadata_incomplete');
  }
  const seen = new Set<string>();
  const performanceSeen = new Map<string, string>();
  const valid = measurements.filter(row => {
    if (QUALIFICATION_PERFORMANCE_METRICS.includes(row.metric) && !row.synthetic) {
      const source = row.performanceSource;
      if (!source?.baselineStoryId || !source.candidateStoryId || source.baselineStoryId === source.candidateStoryId
        || !digestList([source.baselineDigest, source.candidateDigest]) || row.metric === 'triage_latency' && !source.attemptId) {
        refusalReasons.push('performance_source_missing'); return false;
      }
      // An actual candidate cohort (or attempt) is independent of the Finding
      // case that references it. A different baseline cannot recount it either.
      const key = `${row.metric}:${source.candidateStoryId}:${row.metric === 'triage_latency' ? source.attemptId : ''}`;
      const fingerprint = applicabilityDigest({ source, numerator: row.numerator, denominator: row.denominator,
        latencySeconds: row.latencySeconds ?? null, latencyPopulationSize: row.latencyPopulationSize ?? null,
        rollbackEvent: row.rollbackEvent ?? false, evidenceDigests: row.evidenceDigests,
        independentlyAdjudicated: row.independentlyAdjudicated });
      if (performanceSeen.has(key)) {
        if (performanceSeen.get(key) !== fingerprint) refusalReasons.push(`conflicting_performance_source:${key}`);
        return false;
      }
      performanceSeen.set(key, fingerprint);
    }
    const key = `${row.metric}:${row.caseId}`; const duplicate = seen.has(key); seen.add(key);
    const time = Date.parse(row.observedAt);
    const ok = !duplicate && FINDING_QUALIFICATION_METRICS.some(spec => spec[0] === row.metric)
      && typeof row.storyId === 'string' && row.storyId.length > 0 && typeof row.caseId === 'string' && row.caseId.length > 0
      && ['critical', 'high', 'medium', 'low'].includes(row.severity)
      && row.independentlyAdjudicated === true && digestList(row.evidenceDigests)
      && finiteNonnegative(row.numerator) && finiteNonnegative(row.denominator) && row.numerator <= row.denominator
      && validWindow && time >= start && time <= end;
    if (!ok) refusalReasons.push(`invalid_or_duplicate_measurement:${key}`);
    return ok;
  });
  const operational = valid.filter(row => row.synthetic === false && !QUALIFICATION_PERFORMANCE_METRICS.includes(row.metric));
  const storyCount = new Set(operational.map(row => row.storyId)).size;
  const caseCount = new Set(operational.map(row => `${row.storyId}:${row.observationId ?? row.caseId}`)).size;
  const observedTimes = operational.map(row => Date.parse(row.observedAt));
  const observedDays = observedTimes.length ? (Math.max(...observedTimes) - Math.min(...observedTimes)) / 86_400_000 : 0;
  if (storyCount < FINDING_QUALIFICATION_POLICY.minStories) refusalReasons.push('fewer_than_20_finding_bearing_stories');
  if (caseCount < FINDING_QUALIFICATION_POLICY.minCases) refusalReasons.push('fewer_than_200_independent_cases');
  if (observedDays < FINDING_QUALIFICATION_POLICY.minDays) refusalReasons.push('observed_cases_do_not_span_30_days');
  for (const prerequisite of FINDING_QUALIFICATION_POLICY.requiredPrerequisites) {
    const row = corpus?.prerequisites?.[prerequisite];
    if (!row?.passed || !digestList(row.evidenceDigests)) refusalReasons.push(`prerequisite:${prerequisite}`);
  }
  const rows = FINDING_QUALIFICATION_METRICS.map(([metric, comparison, threshold, rollbackThreshold]) => {
    const allCases = valid.filter(row => row.metric === metric);
    const operationalMetric = ['false_nonblocking_high_critical', 'nonblocking_precision', 'canonical_root_cause_honesty',
      'duplicate_route_accuracy', 'false_deferral', 'workflow_operation_reduction', 'review_convergence_reduction', 'triage_latency'].includes(metric);
    const cases = operationalMetric ? allCases.filter(row => !row.synthetic) : allCases;
    const synthetic = allCases.filter(row => row.synthetic);
    const numerator = sum(cases.map(row => row.numerator));
    const denominator = sum(cases.map(row => row.denominator));
    const latency = cases.map(row => row.latencySeconds).filter(finiteNonnegative);
    const observed = denominator === 0 ? null : comparison === 'latency' ? percentile(latency, 0.95)
      : metric === 'review_convergence_reduction' ? percentile(cases.filter(row => row.denominator > 0).map(row => row.numerator / row.denominator), 0.5) : numerator / denominator;
    const p50 = comparison === 'latency' ? percentile(latency, 0.5) : null;
    const safetyStrata = ['high', 'critical'].map(severity => {
      const selected = cases.filter(row => row.severity === severity);
      const n = selected.reduce((sum, row) => sum + row.denominator, 0);
      const events = selected.reduce((sum, row) => sum + (comparison === 'min' ? row.denominator - row.numerator : row.numerator), 0);
      return { severity, sampledN: n, events, zeroEventUpperBound: n > 0 && events === 0 ? 1 - Math.pow(0.05, 1 / n) : null };
    });
    let status: 'pass' | 'refuse' | 'insufficient_evidence' | 'descriptive' = observed === null ? 'insufficient_evidence'
      : comparison === 'descriptive' ? 'descriptive'
      : comparison === 'min' ? (observed >= threshold! ? 'pass' : 'refuse')
      : comparison === 'max' ? (observed <= threshold! ? 'pass' : 'refuse')
      : (p50 !== null && p50 <= FINDING_QUALIFICATION_POLICY.latency.p50Seconds && observed <= FINDING_QUALIFICATION_POLICY.latency.p95Seconds
        && corpus!.latencyCorpusSize >= FINDING_QUALIFICATION_POLICY.latency.minCorpusSize
        && cases.every(row => finiteNonnegative(row.latencyPopulationSize) && row.latencyPopulationSize >= FINDING_QUALIFICATION_POLICY.latency.minCorpusSize) ? 'pass' : 'refuse');
    // Adversarial failures are an independent veto, never extra successful
    // operational denominators that can dilute observed misses.
    if (allCases.some(row => row.rollbackEvent) || operationalMetric && synthetic.some(row =>
      comparison === 'min' ? row.numerator < row.denominator * threshold! : comparison === 'max' ? row.numerator > 0
        : comparison === 'latency' ? !finiteNonnegative(row.latencySeconds) || row.latencySeconds > FINDING_QUALIFICATION_POLICY.latency.p95Seconds : false)) status = 'refuse';
    if (['false_nonblocking_high_critical', 'assessment_integrity_fail_closed', 'mandatory_repair_closure_integrity', 'nonblocking_precision', 'duplicate_route_accuracy'].includes(metric)
      && safetyStrata.some(row => row.sampledN === 0)) status = 'insufficient_evidence';
    if (['nonblocking_precision', 'duplicate_route_accuracy'].includes(metric) && safetyStrata.some(row => row.events > 0)) status = 'refuse';
    if (comparison === 'descriptive' && !corpus?.candidateBaselineExplained) status = 'refuse';
    if (metric === 'review_convergence_reduction' && (corpus?.simpleStoryRegression == null || corpus.simpleStoryRegression > FINDING_QUALIFICATION_POLICY.simpleStory.maxRegression)) status = 'refuse';
    if (metric === 'triage_latency' && (corpus?.timeoutRate == null || corpus.timeoutRate > FINDING_QUALIFICATION_POLICY.latency.maxTimeoutRate)) status = 'refuse';
    if (status !== 'pass' && status !== 'descriptive') refusalReasons.push(`metric:${metric}:${status}`);
    return { metric, numerator, denominator, observed, p50, status, promotionThreshold: { comparison, value: threshold }, rollbackThreshold,
      reason: status === 'insufficient_evidence' ? 'No complete independently adjudicated denominator/stratum' : status,
      evidenceDigests: [...new Set(cases.flatMap(row => row.evidenceDigests))].sort(), strata: safetyStrata,
      synthetic: { numerator: sum(synthetic.map(row => row.numerator)), denominator: sum(synthetic.map(row => row.denominator)), promotionDenominator: !operationalMetric },
      confidence: { level: 0.95, method: FINDING_QUALIFICATION_POLICY.method }, promotionRequired: comparison !== 'descriptive' };
  });
  return { schemaVersion: FINDING_QUALIFICATION_POLICY.version, policyDigest,
    metadata: corpus ? { featureState: corpus.featureState, window: corpus.window, repositoryHeads: corpus.repositoryHeads,
      storyClasses: corpus.storyClasses, detectorVersions: corpus.detectorVersions, retryPolicy: corpus.retryPolicy,
      exclusions: corpus.exclusions, latencyHardware: corpus.latencyHardware, timingSeconds: corpus.timingSeconds } : null,
    qualification: { storyCount, caseCount, observedDays, eligible: refusalReasons.length === 0 }, rows,
    refusalReasons: [...new Set(refusalReasons)], gateEvidence: false as const };
}
