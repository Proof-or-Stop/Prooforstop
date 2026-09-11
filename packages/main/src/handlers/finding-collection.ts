/** Read-only collection guidance, not a verdict, receipt, or activation input. */
import type { HandlerContext } from './context.js';
import { loadConfig } from '../core/config.js';
import { applicabilityDigest } from '../core/finding-applicability.js';
import { createFindingLedgerHandlers, exactLedgerRecordHash } from './finding-ledger.js';
import { findingQualificationQuery, FINDING_QUALIFICATION_SUBJECT_KINDS } from './finding-qualification.js';
import type { JsonValue } from '../core/finding-ledger.js';

export interface CollectionAction {
  code: string;
  actor: 'story_owner_and_reviewer' | 'independent_reviewer' | 'maintainer';
  commands: string[];
  findingId?: string;
  assessmentId?: string;
  recordRefs?: Array<{ storyId: string; recordId: string; recordHash: string }>;
  instruction: string;
}

export function readFindingCollectionReadiness(ctx: HandlerContext, storyId: string) {
  const config = loadConfig(ctx.root).dynamicFinding;
  const rawIds = config?.qualificationStoryIds;
  const configured = Array.isArray(rawIds) && rawIds.length > 0
    && rawIds.every(id => typeof id === 'string' && id.trim()) && new Set(rawIds).size === rawIds.length;
  const corpus = { configured, included: configured && rawIds.includes(storyId),
    configuredStoryIds: configured ? [...rawIds] : [], automaticEnrollment: false as const };
  const actions: CollectionAction[] = [];
  const refusals: string[] = [];
  const counts = { findings: null as number | null, assessmentRecords: null as number | null,
    qualificationCases: null as number | null, historicalUnassessedFindings: null as number | null };
  const base = { schemaVersion: 1, storyId, authority: 'diagnostic_only' as const, gateEvidence: false as const,
    scopeExpansionAuthorized: false as const, corpus, counts, actions, refusals };
  if (config?.killSwitch) return { ...base, state: 'disabled', snapshotDigest: null };
  const story = ctx.store.readStory(storyId);
  if (!corpus.included) actions.push({ code: configured ? 'corpus_story_not_enrolled' : 'corpus_not_configured', actor: 'maintainer', commands: [],
    instruction: 'Review the complete intended cohort and configure dynamicFinding.qualificationStoryIds; preserve existing members, never select only successes, never enable enforce through this diagnostic.' });
  try {
    const verified = createFindingLedgerHandlers(ctx).finding_ledger_query({ storyId });
    const ledger = ctx.store.readFindingLedger<JsonValue>(storyId);
    const findings = ctx.store.readFindings(storyId).findings;
    const assessments = ledger.records.filter(row => row.recordType === 'finding_applicability_assessment');
    const cases = findingQualificationQuery(ctx, storyId);
    counts.findings = findings.length; counts.assessmentRecords = assessments.length;
    counts.qualificationCases = cases.length; counts.historicalUnassessedFindings = 0;
    for (const finding of findings) {
      const latest = [...assessments].reverse().find(row => (row.payload as Record<string, unknown>).findingId === finding.id);
      if (!latest) {
        if (finding.status !== 'open') { counts.historicalUnassessedFindings++; continue; }
        actions.push({ code: finding.evidenceState === 'verified' ? 'assessment_missing' : 'reproduction_required', actor: 'story_owner_and_reviewer',
          findingId: finding.id, commands: ['finding_runtime_evidence_run', 'finding_assessment_propose', 'finding_applicability_assess'],
          instruction: 'Owner executes reviewed reproduction and acceptance/risk witnesses; reviewer proposes from exact receipts; Owner rechecks current evidence and records assessment. Caller labels, old DONE results and this report cannot establish applicability.' });
      } else if (!cases.some(row => row.payload.sourceAssessmentRecordId === latest.recordId
        && row.payload.sourceAssessmentRecordHash === exactLedgerRecordHash(latest))) {
        actions.push({ code: 'independent_adjudication_missing', actor: 'story_owner_and_reviewer', findingId: finding.id,
          assessmentId: String((latest.payload as Record<string, unknown>).assessmentId),
          commands: ['finding_runtime_evidence_run', 'review_run_start', 'review_pass_set', 'finding_qualification_record'],
          instruction: 'Owner rechecks current assessment and reviewed measurement intent, then executes the measurement. In REVIEW, an adjudicator distinct from observer and decision proposer reviews and signs the exact assessment/runtime receipt. Other phases do not authorize this write; never reopen or rewrite history merely to manufacture samples.' });
      }
    }
    const covered = cases.flatMap(row => row.payload.subjectAdjudications ?? []).map(row => row.ref);
    const missing = ledger.records.filter(row => FINDING_QUALIFICATION_SUBJECT_KINDS.has(row.recordType)
      && !covered.some(ref => ref.storyId === storyId && ref.recordId === row.recordId && ref.recordHash === exactLedgerRecordHash(row)));
    if (missing.length) actions.push({ code: 'subject_census_incomplete', actor: 'independent_reviewer', commands: ['finding_qualification_record'],
      recordRefs: missing.map(row => ({ storyId, recordId: row.recordId, recordHash: exactLedgerRecordHash(row) })),
      instruction: 'Independently adjudicate every listed proposal/route/assessment/disposition/repair subject with expected semantics and rationale through an executed current measurement. Existence, counts and hashes alone are not adjudication.' });
    if (!cases.length || cases.some(row => !row.payload.publicQueries.experiments?.performanceMetadata)) actions.push({ code: 'matched_performance_missing',
      actor: 'story_owner_and_reviewer', commands: ['finding_qualification_record'],
      instruction: 'Collect actual completed comparable baseline/candidate cohorts and server-measured timings through reviewed qualification evidence. Do not fabricate durations, count fixtures as operational cases or credit repair time as a saving.' });
    const after = ctx.store.readFindingLedger<JsonValue>(storyId);
    if (ledger.committedLedgerDigest !== after.committedLedgerDigest) throw new Error('collection_snapshot_changed');
    return { ...base, phase: story.phase, state: 'diagnostic', snapshotDigest: applicabilityDigest({
      ledger: verified.snapshotDigest, ledgerDigest: after.committedLedgerDigest, findings, cases: cases.map(row => row.recordHash), corpus }) };
  } catch (error) {
    // Unknown or untrusted is not zero progress and never triggers fresh writes.
    Object.assign(counts, { findings: null, assessmentRecords: null, qualificationCases: null, historicalUnassessedFindings: null });
    actions.splice(0, actions.length, { code: 'collection_evidence_unavailable', actor: 'maintainer',
      commands: ['finding_ledger_query', 'finding_qualification_query'],
      instruction: 'Resolve this read refusal before collecting or recounting evidence; preserve existing history.' });
    refusals.push(error instanceof Error ? error.message : String(error));
    return { ...base, phase: story.phase, state: 'unavailable', snapshotDigest: null };
  }
}
