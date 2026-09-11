/** Query-derived qualification inputs. Never consumes a caller's rates/counts.
 * A preregistered adversarial experiment contributes exactly one test outcome;
 * a command reporting thousands of passed checks still contributes only one. */
import type { HandlerContext } from './context.js';
import { historicalStoryContext } from './finding-identity-store.js';
import { createFindingLedgerHandlers, readCurrentFindingRuntimeEvidence } from './finding-ledger.js';
import { findingWitnessCommandText } from './finding-applicability-proof.js';
import { applicabilityDigest } from '../core/finding-applicability.js';
import { readDynamicFindingDecision } from '../core/finding-applicability-projection.js';
import { readCanonicalCatalog } from './finding-identity-store.js';
import { FINDING_QUALIFICATION_METRICS, type FindingQualificationMetric, type QualificationMeasurement } from '../core/finding-rollout-qualification.js';

export interface QualificationExperimentRef { metric: FindingQualificationMetric; scenarioId: string; runtimeReceiptId: string; }
export interface QualificationGold { applicable: boolean; eligibleDeferral: boolean; ownerStoryId: string | null;
  canonical?: { recordId: string; rootCauseState: string; rootCause: string | null }; }
const EXPERIMENT_METRICS = FINDING_QUALIFICATION_METRICS.filter(row => !['candidate_conversion', 'workflow_operation_reduction', 'review_convergence_reduction', 'triage_latency'].includes(row[0])).map(row => row[0]);

export function collectFindingQualificationEvents(ctx: HandlerContext, args: {
  storyId: string; findingId: string; caseId: string; severity: QualificationMeasurement['severity']; observedAt: string;
  experiments: QualificationExperimentRef[]; reportReceiptId: string;
  gold?: QualificationGold; population?: 'operational' | 'adversarial';
  matchedCohort?: { baselineStoryId: string; candidateStoryId: string };
}) {
  const pins = ctx.store.readChecklist(args.storyId).items.flatMap(item => Object.values(item.verificationIntent ?? {}).flatMap(rows =>
    Array.isArray(rows) ? rows.flatMap(row => row.verification ? [row.verification] : []) : []));
  const registered = pins.filter(pin => typeof pin.selector === 'string' && pin.selector.startsWith('FINDING_METRIC '));
  const seen = new Set<string>(); const receipts = new Set<string>();
  const measurements: QualificationMeasurement[] = [];
  const sources: Array<{ metric: string; scenarioId: string; receiptId: string; receiptHash: string; command: string; selector: string; exitCode: number }> = [];
  if (!Array.isArray(args.experiments)) throw new Error('qualification: experiment references must be an array');
  for (const ref of args.experiments) {
    const selector = `FINDING_METRIC ${ref.metric} ${ref.scenarioId}`;
    if (!EXPERIMENT_METRICS.includes(ref.metric) || !/^[a-zA-Z0-9._:-]+$/.test(ref.scenarioId)
      || seen.has(selector) || receipts.has(ref.runtimeReceiptId) || ref.runtimeReceiptId === args.reportReceiptId) throw new Error('qualification: invalid, repeated or self-reported experiment');
    const runtime = readCurrentFindingRuntimeEvidence(ctx, args.storyId, ref.runtimeReceiptId);
    const command = findingWitnessCommandText(runtime.executionCommand);
    if (!registered.some(pin => pin.selector === selector && pin.command === command)
      || !runtime.stdout.split(/\r?\n/).includes(selector)) throw new Error('qualification: experiment command/selector not preregistered or executed');
    seen.add(selector); receipts.add(ref.runtimeReceiptId);
    const spec = FINDING_QUALIFICATION_METRICS.find(row => row[0] === ref.metric)!;
    // The independently reviewed pinned test asserts the property. Counts come
    // from actual distinct tool executions, not stdout's self-reported totals.
    const succeeded = runtime.receipt.exitCode === 0;
    measurements.push({ metric: ref.metric, caseId: `${args.caseId}:${ref.metric}:${ref.scenarioId}`, storyId: args.storyId,
      severity: args.severity, observedAt: args.observedAt, numerator: spec[1] === 'max' ? Number(!succeeded) : Number(succeeded), denominator: 1,
      independentlyAdjudicated: true, synthetic: true, rollbackEvent: !succeeded,
      evidenceDigests: [runtime.receipt.receiptHash, applicabilityDigest({ command, selector })] });
    sources.push({ metric: ref.metric, scenarioId: ref.scenarioId, receiptId: ref.runtimeReceiptId, receiptHash: runtime.receipt.receiptHash,
      command, selector, exitCode: runtime.receipt.exitCode });
  }
  // Excluding a registered failure or missing run cannot improve the score.
  if (registered.some(pin => !seen.has(pin.selector!))) throw new Error('qualification: preregistered experiment omitted');
  const supportingQueries: unknown[] = [];
  let performanceMetadata: { simpleStoryRegression: number | null; timeoutRate: number | null; latencyCorpusSize: number;
    timingSeconds: { classifier: number; triage: number; repair: number; convergence: number } } | undefined;
  const add = (metric: FindingQualificationMetric, numerator: number, denominator: number, evidence: unknown, synthetic: boolean, latencySeconds?: number) => {
    measurements.push({ metric, caseId: args.caseId, storyId: args.storyId, severity: args.severity, observedAt: args.observedAt,
      numerator, denominator, evidenceDigests: [applicabilityDigest(evidence)], independentlyAdjudicated: true, synthetic,
      ...(latencySeconds === undefined ? {} : { latencySeconds }) });
  };
  if (args.gold) {
    if (typeof args.gold.applicable !== 'boolean' || typeof args.gold.eligibleDeferral !== 'boolean'
      || !(args.gold.ownerStoryId === null || typeof args.gold.ownerStoryId === 'string')) throw new Error('qualification: incomplete independent gold');
    const finding = ctx.store.readFindings(args.storyId).findings.find(row => row.id === args.findingId);
    if (!finding || finding.evidenceState !== 'verified') throw new Error('qualification: verified source Finding required');
    const decision = readDynamicFindingDecision({ store: ctx.store, projectRoot: ctx.root, storyId: args.storyId, finding,
      effectiveBlockingSeverities: ['critical', 'high', 'medium'], round: 3, diagnostic: true });
    const ledger = ctx.store.readFindingLedger(args.storyId);
    const assessment = [...ledger.records].reverse().find(row => row.recordType === 'finding_applicability_assessment'
      && (row.payload as Record<string, unknown>).findingId === finding.id)?.payload as Record<string, unknown> | undefined;
    const evidence = { gold: args.gold, decision, assessment: assessment ?? null }; supportingQueries.push(evidence);
    const synthetic = args.population !== 'operational';
    if (!decision.dynamicBlocking) {
      add('nonblocking_precision', Number(!args.gold.applicable), 1, evidence, synthetic);
      if (['critical', 'high'].includes(finding.severity)) add('false_nonblocking_high_critical', Number(args.gold.applicable), 1, evidence, synthetic);
      if (['duplicate', 'out_of_scope', 'pre_existing_unaffected'].includes(String(assessment?.verdict))) {
        const route = assessment?.acceptedRoute as { ownerStoryId?: string } | undefined;
        add('duplicate_route_accuracy', Number(!args.gold.applicable && route?.ownerStoryId === args.gold.ownerStoryId), 1, evidence, synthetic);
      }
    }
    if (assessment?.dispositionPlan === 'defer_with_proof') add('false_deferral', Number(!args.gold.eligibleDeferral), 1, evidence, synthetic);
    if (args.gold.canonical) {
      const catalog = readCanonicalCatalog(ctx); const row = catalog.rows.find(row => row.record.recordId === args.gold!.canonical!.recordId);
      if (!row) throw new Error('qualification: canonical gold source unavailable');
      const actual = row.envelope.payload;
      if (!actual.memberFindingRefs.some(ref => ref.storyId === args.storyId && ref.findingId === args.findingId
        && ref.recordId === finding.recordId)) throw new Error('qualification: canonical gold does not contain source observation');
      add('canonical_root_cause_honesty', Number(actual.rootCauseState === args.gold.canonical.rootCauseState
        && (actual.rootCause ?? null) === args.gold.canonical.rootCause), 1, { actual, gold: args.gold.canonical }, synthetic);
    }
  }
  if (args.matchedCohort) {
    if (args.matchedCohort.baselineStoryId === args.matchedCohort.candidateStoryId) throw new Error('qualification: matched cohorts must be distinct');
    const before = findingQualificationWorkflowQuery(ctx, args.matchedCohort.baselineStoryId);
    const after = findingQualificationWorkflowQuery(ctx, args.matchedCohort.candidateStoryId);
    if (before.phase !== 'DONE' || after.phase !== 'DONE' || before.storyClass !== after.storyClass) throw new Error('qualification: comparable completed cohorts required');
    supportingQueries.push({ before, after });
    const completed = after.timing.filter(row => row.durationMs !== null);
    const timeoutRate = after.timing.length ? after.timing.filter(row => row.timedOut).length / after.timing.length : null;
    performanceMetadata = { simpleStoryRegression: before.findingCount <= 5 && before.reviewElapsedMs > 0
      ? Math.max(0, after.reviewElapsedMs / before.reviewElapsedMs - 1) : null,
      timeoutRate, latencyCorpusSize: after.timing.length ? Math.min(...after.timing.map(row => row.candidateCount)) : 0,
      timingSeconds: { classifier: completed.reduce((sum, row) => sum + row.durationMs!, 0) / 1000,
        triage: after.adjudicationElapsedMs / 1000, repair: after.repairElapsedMs / 1000,
        convergence: Math.max(0, after.reviewElapsedMs - after.adjudicationElapsedMs) / 1000 } };
    if (before.operations.length) add('workflow_operation_reduction', Math.max(0, before.operations.length - after.operations.length), before.operations.length, { before, after }, false);
    if (before.rounds.length && before.reviewElapsedMs > 0) {
      const reduction = Math.min((before.rounds.length - after.rounds.length) / before.rounds.length,
        (before.reviewElapsedMs - after.reviewElapsedMs) / before.reviewElapsedMs);
      add('review_convergence_reduction', Math.max(0, reduction), 1, { before, after }, false);
    }
    for (const row of after.timing) {
      if (row.candidateCount < 2273 || row.durationMs === null || !Number.isFinite(row.durationMs) || row.durationMs < 0) continue;
      measurements.push({ metric: 'triage_latency', caseId: `${args.caseId}:${row.attemptId}`, storyId: after.storyId, severity: args.severity,
        observedAt: row.createdAt, numerator: 1, denominator: 1, latencySeconds: row.durationMs / 1000,
        evidenceDigests: [after.queryDigest], independentlyAdjudicated: true, synthetic: false });
      measurements.at(-1)!.rollbackEvent = row.outcome !== 'signed';
    }
  }
  const coveredMetrics = [...new Set(measurements.map(row => row.metric))].sort();
  const missingSourceMetrics = FINDING_QUALIFICATION_METRICS.filter(row => !coveredMetrics.includes(row[0]) && row[0] !== 'candidate_conversion').map(row => row[0]);
  return { measurements, sources, supportingQueries, coveredMetrics, missingSourceMetrics, performanceMetadata: performanceMetadata ?? null };
}

/** Public server-derived workflow projection. The ledger query verifies every
 * carrier before receipts can be counted. Repair/resolve/dismiss are excluded. */
export function findingQualificationWorkflowQuery(ctx: HandlerContext, storyId: string) {
  const source = historicalStoryContext(ctx, storyId);
  const query = createFindingLedgerHandlers(source).finding_ledger_query({ storyId });
  const ledger = source.store.readFindingLedger(storyId);
  const allowed = new Set(['append_candidate', 'append_assessment_proposal', 'append_assessment', 'append_route_receipt', 'append_candidate_route', 'append_deferral', 'apply_manifest']);
  const operations = ledger.receipts.filter(row => allowed.has(row.operation)
    && row.recordIds.some(id => { const payload = ledger.records.find(row => row.recordId === id)?.payload as Record<string, unknown>;
      return payload && !String(payload.action ?? '').startsWith('proposal_timing_') && payload.action !== 'qualification_case'; }))
    .map(row => ({ id: row.receiptId, operation: row.operation }));
  const story = source.store.readStory(storyId);
  const rounds = (story.events ?? []).filter(event => event.phase === 'REVIEW' && event.action === 'advance').map(event => ({ phase: event.phase, timestamp: event.timestamp }));
  let reviewElapsedMs = 0;
  let repairElapsedMs = 0;
  const transitions = (story.events ?? []).filter(event => event.action === 'advance');
  for (let i = 0; i + 1 < transitions.length; i++) if (['REVIEW', 'DEV'].includes(transitions[i]!.phase)) {
    const elapsed = Date.parse(transitions[i + 1]!.timestamp) - Date.parse(transitions[i]!.timestamp);
    if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error('qualification: invalid phase clock');
    if (transitions[i]!.phase === 'REVIEW') reviewElapsedMs += elapsed;
    else repairElapsedMs += elapsed;
  }
  const rows = ledger.records.filter(row => row.recordType === 'dynamic_finding_manifest').map(row => row.payload as Record<string, unknown>);
  const timing = rows.filter(row => row.action === 'proposal_timing_start').map(start => {
    const ends = rows.filter(row => row.action === 'proposal_timing_end' && row.attemptId === start.attemptId);
    if (ends.length > 1 || !Array.isArray(start.population) || applicabilityDigest(start.population) !== start.populationDigest
      || start.candidateCount !== start.population.length || new Set(start.population.map(row => (row as { recordId: string }).recordId)).size !== start.population.length) throw new Error('qualification: proposal clock/population invalid');
    const end = ends[0];
    if (end && (!Number.isFinite(end.durationMs) || Number(end.durationMs) < 0 || end.populationDigest !== start.populationDigest
      || (end.outcome === 'signed' && !ledger.records.some(row => row.recordType === 'assessment_proposal'
        && (row.payload as Record<string, unknown>).proposalId === end.proposalId)))) throw new Error('qualification: unbound proposal clock');
    return { attemptId: String(start.attemptId), proposalId: end?.proposalId ?? null, durationMs: end ? Number(end.durationMs) : null, candidateCount: Number(start.candidateCount),
      outcome: end?.outcome ?? 'interrupted', createdAt: String(start.startedAt), completedAt: end ? String(end.completedAt) : null,
      timedOut: !end || Number(end.durationMs) > Number(start.timeoutBudgetMs) };
  });
  // Union wall-clock proposal-to-assessment intervals. Concurrent cases cannot
  // multiply elapsed time; DEV repair is excluded by REVIEW intersections.
  const intervals: Array<[number, number]> = [];
  for (const assessment of ledger.records.filter(row => row.recordType === 'finding_applicability_assessment')) {
    const ref = (assessment.payload as Record<string, unknown>).proposalRef as { recordId?: string } | undefined;
    const proposal = ledger.records.find(row => row.recordId === ref?.recordId)?.payload as Record<string, unknown> | undefined;
    const clock = timing.find(row => row.proposalId === proposal?.proposalId);
    const receipt = ledger.receipts.find(row => row.recordIds.includes(assessment.recordId));
    if (!clock?.completedAt || !receipt) continue;
    const from = Date.parse(clock.completedAt); const to = Date.parse(receipt.committedAt);
    for (let i = 0; i + 1 < transitions.length; i++) if (transitions[i]!.phase === 'REVIEW') {
      const a = Math.max(from, Date.parse(transitions[i]!.timestamp)); const b = Math.min(to, Date.parse(transitions[i + 1]!.timestamp));
      if (b > a) intervals.push([a, b]);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]); let adjudicationElapsedMs = 0; let until = -Infinity;
  for (const [from, to] of intervals) { adjudicationElapsedMs += Math.max(0, to - Math.max(from, until)); until = Math.max(until, to); }
  return { storyId, storyClass: story.type, phase: story.phase, operations, rounds, reviewElapsedMs, repairElapsedMs, adjudicationElapsedMs, timing,
    findingCount: source.store.readFindings(storyId).findings.length, queryDigest: applicabilityDigest({ query, transitions }), gateEvidence: false as const };
}
