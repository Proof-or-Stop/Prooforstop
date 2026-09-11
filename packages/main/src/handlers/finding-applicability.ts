import { randomUUID } from 'node:crypto';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { withMkdirLock, captureMkdirLockFence } from '../core/mkdir-lock.js';
import { getSessionIdentity } from '../core/owner-session.js';
import { readOwnerLease } from '../core/story-owner-lease.js';
import type { Finding } from '../core/types.js';
import type { JsonValue, LedgerRecord } from '../core/finding-ledger.js';
import {
  applicabilityDigest, DEFERRAL_EXPIRY_POLICY, deferralExpiry, dynamicFindingScorecard,
  signApplicabilityAssessment, signDynamicFindingRecord, verifyApplicabilityAssessment, verifyAssessmentFreshness, verifyDynamicFindingRecord,
  type ApplicabilityVerdict, type DispositionPlan, type DynamicFindingMode,
  type FindingApplicabilityAssessment, type FindingDeferralDisposition,
  type MandatoryRepairClassification, type DynamicFindingBatchRow,
} from '../core/finding-applicability.js';
import { currentApplicabilityContext, readDynamicFindingDecision, resolveDynamicFindingRollout, routeStillCurrent } from '../core/finding-applicability-projection.js';
import {
  appendFindingLedger, exactLedgerRecordHash, findingLedgerSignerFromWorkspace,
} from './finding-ledger.js';
import { createFindingRouteHandlers } from './finding-route.js';

type RouteRef = { storyId: string; receipt: { storyId: string; recordId: string; recordHash: string } };
export interface FindingApplicabilityAssessArgs {
  storyId: string; findingId: string; idempotencyKey: string; verdict: ApplicabilityVerdict;
  proofStrength: 'strong' | 'weak' | 'unknown'; dispositionPlan?: DispositionPlan;
  gateImpact?: 'blocks' | 'does_not_block' | 'unknown'; route?: RouteRef; expiresAt?: string;
  evidenceRefs?: string[]; recheckTriggers?: string[];
}
export interface FindingDeferralRecordArgs {
  storyId: string; findingId: string; idempotencyKey: string; assessmentId: string;
  renewalCount?: number;
}
export interface FindingMandatoryRepairCloseArgs { storyId: string; findingId: string; idempotencyKey: string; classificationId: string; closureEvidenceRefs: string[]; }
export interface FindingTriageArgs { storyId: string; findingIds?: string[]; mode?: DynamicFindingMode; }
export interface FindingApplicabilityBatchArgs {
  storyId: string; idempotencyKey: string;
  items: Array<Omit<FindingApplicabilityAssessArgs, 'storyId' | 'idempotencyKey'>>;
}

function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`dynamic finding: ${field} is required`);
}
function nonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(row => typeof row === 'string' && row.trim().length > 0);
}
function validateAssessmentClaim(input: FindingApplicabilityAssessArgs, severity: string, acceptedRoute: FindingApplicabilityAssessment['acceptedRoute']): void {
  const applicable = input.verdict === 'introduced' || input.verdict === 'worsened' || input.verdict === 'applicable';
  const nonApplicable = input.verdict === 'pre_existing_unaffected' || input.verdict === 'out_of_scope' || input.verdict === 'duplicate';
  if (input.dispositionPlan === 'repair_current' && acceptedRoute) throw new Error('dynamic finding: repair_current forbids acceptedRoute');
  if (input.dispositionPlan === 'defer_with_proof' && (input.verdict !== 'applicable' || input.gateImpact !== 'does_not_block'
    || !acceptedRoute || !['low', 'medium'].includes(severity) || !nonEmptyStrings(input.evidenceRefs)
    || !nonEmptyStrings(input.recheckTriggers))) throw new Error('dynamic finding: defer_with_proof requires non-regression applicable low/medium Finding, non-blocking gate impact, evidence, recheck triggers, and accepted route');
  if (nonApplicable && !acceptedRoute) throw new Error('dynamic finding: non-applicable verdict requires exact accepted route');
  if (!applicable && input.dispositionPlan) throw new Error('dynamic finding: non-applicable verdict binds route, not dispositionPlan');
  if (input.verdict === 'unknown' && (input.dispositionPlan || acceptedRoute)) throw new Error('dynamic finding: unknown binds neither plan nor route');
  if (input.verdict === 'disproven' && !nonEmptyStrings(input.evidenceRefs)) throw new Error('dynamic finding: disproven requires current counter-evidence');
  if (input.verdict === 'not_reproduced_under_current_witness' && (!nonEmptyStrings(input.evidenceRefs) || !acceptedRoute)) {
    throw new Error('dynamic finding: not_reproduced_under_current_witness requires current receipt evidence and accepted route');
  }
}
function resolveAcceptedRoute(ctx: HandlerContext, route: RouteRef | undefined, storyId: string, findingId: string, now: Date): {
  acceptedRoute: FindingApplicabilityAssessment['acceptedRoute']; record?: LedgerRecord<JsonValue>;
} {
  if (!route) return { acceptedRoute: null };
  const verified = createFindingRouteHandlers(ctx).finding_route_verify(route) as {
    envelope: { payload: { decision: string; target: { id: string }; source: { storyId: string; recordId: string; subjectKind: string };
      expiresAt: string; routeReceiptId: string } }; record: LedgerRecord<JsonValue>;
  };
  const payload = verified.envelope.payload;
  if (payload.decision !== 'accepted' || payload.source.subjectKind !== 'finding_assessment_proposal'
    || Date.parse(payload.expiresAt) <= now.getTime()) throw new Error('dynamic finding: fresh accepted finding route required');
  const sourceLedger = ctx.store.readFindingLedger<JsonValue>(payload.source.storyId);
  const proposal = sourceLedger.records.find(row => row.recordId === payload.source.recordId);
  const findingRef = proposal?.payload && typeof proposal.payload === 'object'
    ? (proposal.payload as Record<string, unknown>).findingRef as Record<string, unknown> | undefined : undefined;
  if (proposal?.recordType !== 'assessment_proposal' || payload.source.storyId !== storyId
    || findingRef?.storyId !== storyId || findingRef.findingId !== findingId) throw new Error('dynamic finding: accepted route is bound to another Finding');
  return { acceptedRoute: { state: 'accepted', ownerStoryId: payload.target.id, receiptState: 'fresh', receiptId: payload.routeReceiptId,
    receiptRecordId: verified.record.recordId, receiptRecordHash: exactLedgerRecordHash(verified.record), expiresAt: payload.expiresAt }, record: verified.record };
}
function deferralLineageInvalid(row: { payload: FindingDeferralDisposition } | undefined, severity: string, publicKey: string, now: Date): boolean {
  if (!row) return false;
  const maxRenewals = severity === 'low' || severity === 'medium' ? DEFERRAL_EXPIRY_POLICY[severity].maxRenewals : -1;
  return !verifyDynamicFindingRecord(row.payload as FindingDeferralDisposition & Record<string, unknown>, publicKey)
    || row.payload.state !== 'valid' || row.payload.lineageState !== 'current'
    || !Number.isFinite(Date.parse(row.payload.expiresAt)) || Date.parse(row.payload.expiresAt) <= now.getTime()
    || (row.payload.renewalCount ?? 0) > maxRenewals;
}
function findPayload<T>(records: LedgerRecord<JsonValue>[], kind: string, predicate: (value: T) => boolean): { record: LedgerRecord<JsonValue>; payload: T } | undefined {
  for (const record of [...records].reverse()) {
    if (record.recordType !== kind || !record.payload || typeof record.payload !== 'object') continue;
    const payload = record.payload as T;
    if (predicate(payload)) return { record, payload };
  }
  return undefined;
}
function exactFindingRecord(records: LedgerRecord<JsonValue>[], findingId: string): LedgerRecord<JsonValue> {
  const record = [...records].reverse().find(row => row.recordType === 'finding'
    && row.payload && typeof row.payload === 'object' && (row.payload as Record<string, unknown>).id === findingId);
  if (!record) throw new Error(`dynamic finding: authoritative Finding record missing for ${findingId}`);
  return record;
}
function resolveMode(ctx: HandlerContext, requested?: DynamicFindingMode): { mode: DynamicFindingMode; killSwitch: boolean } {
  return resolveDynamicFindingRollout(ctx.root, requested);
}
function withLedgerLock<T>(ctx: HandlerContext, storyId: string, action: (fence: ReturnType<typeof captureMkdirLockFence>) => T): T {
  assertCwdInWorktree(ctx.store, storyId);
  const lockDir = ctx.store.runtimeLockDirPath(storyId, 'finding', 'findings');
  return withMkdirLock(lockDir, () => action(captureMkdirLockFence(lockDir)), {
    label: `dynamic finding applicability (${storyId})`, requireHolderToken: true,
  });
}
function append(ctx: HandlerContext, storyId: string, fence: ReturnType<typeof captureMkdirLockFence>, idempotencyKey: string,
  operation: 'append_assessment' | 'append_deferral' | 'append_mandatory_repair' | 'apply_manifest', records: Array<{ recordType: string; payload: JsonValue; uniqueBindingKey: string }>,
  sourceRecords: LedgerRecord<JsonValue>[]) {
  const ledger = ctx.store.readFindingLedger<JsonValue>(storyId);
  const head = ledger.records.at(-1);
  const observedChainHeadId = head?.recordId ?? 'ledger:empty';
  const observedChainHeadHash = head ? exactLedgerRecordHash(head) : applicabilityDigest([]);
  const predicateDigest = applicabilityDigest({ predicate: 'dynamic-finding-sources-current-v1', sources: sourceRecords.map(row => ({ id: row.recordId, hash: exactLedgerRecordHash(row) })) });
  const identity = getSessionIdentity();
  return appendFindingLedger({
    storyId, store: ctx.store, fence, signer: findingLedgerSignerFromWorkspace(ctx.root), operation, idempotencyKey, records,
    writerSessionId: identity.sessionId, writerLeaseId: readOwnerLease(ctx.store.storyDirPath(storyId))?.sessionId ?? identity.sessionId,
    writerFenceToken: fence.writerFenceToken, expectedPriorLedgerDigest: ledger.committedLedgerDigest,
    casBindings: sourceRecords.map(record => ({ recordType: record.recordType, expectedRecordId: record.recordId,
      expectedRecordHash: exactLedgerRecordHash(record), observedChainHeadId, observedChainHeadHash, predicateDigest })),
    verifyPredicate: ({ ledger: current }) => ({ accepted: sourceRecords.every(source => current.records.some(row => row.recordId === source.recordId
      && exactLedgerRecordHash(row) === exactLedgerRecordHash(source))), predicateDigest }),
  });
}

export function readDynamicFindingProjection(ctx: HandlerContext, storyId: string, finding: Finding,
  effectiveBlockingSeverities: readonly string[], round: number, requestedMode?: DynamicFindingMode) {
  return readDynamicFindingDecision({ store: ctx.store, projectRoot: ctx.root, storyId, finding,
    effectiveBlockingSeverities, round, requestedMode });
}

export function createFindingApplicabilityHandlers(ctx: HandlerContext) {
  const findingTriage = (input: FindingTriageArgs) => {
    text(input.storyId, 'storyId');
    const findings = ctx.store.readFindings(input.storyId).findings.filter(row => !input.findingIds || input.findingIds.includes(row.id));
    const story = ctx.store.readStory(input.storyId);
    const round = Math.max(1, story.events?.filter(row => row.phase === 'REVIEW' && row.action === 'advance').length ?? 0);
    const blocking = ['critical', 'high', 'medium'];
    const rows: DynamicFindingBatchRow[] = findings.map(finding => {
      const decision = readDynamicFindingProjection(ctx, input.storyId, finding, blocking, round, input.mode);
      const ledger = ctx.store.readFindingLedger<JsonValue>(input.storyId);
      const assessment = findPayload<FindingApplicabilityAssessment>(ledger.records, 'finding_applicability_assessment', value => value.findingId === finding.id)?.payload;
      return { findingId: finding.id, severity: finding.severity, assessmentVerdict: assessment?.verdict ?? null,
        dispositionPlan: assessment?.dispositionPlan ?? null, gateImpact: assessment?.gateImpact ?? 'unknown', decision };
    });
    return { storyId: input.storyId, mode: resolveMode(ctx, input.mode), manifestDigest: applicabilityDigest(rows), rows,
      scorecard: dynamicFindingScorecard(rows, findings.length * 2, findings.length === 0 ? 0 : 1 + rows.filter(row => row.decision.blocking).length),
      gateEvidence: true, authority: 'dynamic_finding_applicability' };
  };
  return {
    finding_applicability_batch(input: FindingApplicabilityBatchArgs) {
      text(input.storyId, 'storyId'); text(input.idempotencyKey, 'idempotencyKey');
      if (!Array.isArray(input.items) || input.items.length === 0 || new Set(input.items.map(item => item.findingId)).size !== input.items.length) throw new Error('dynamic finding: batch items must be non-empty and unique');
      return withLedgerLock(ctx, input.storyId, fence => {
        const requestDigest = applicabilityDigest(input); const idempotencyKey = `dynamic-batch:${input.idempotencyKey}`;
        let ledger = ctx.store.readFindingLedger<JsonValue>(input.storyId);
        const prior = ledger.receipts.find(row => row.idempotencyKey === idempotencyKey);
        if (prior) {
          const rows = prior.recordIds.map(id => ledger.records.find(row => row.recordId === id)).filter((row): row is LedgerRecord<JsonValue> => !!row);
          const manifest = rows.find(row => row.recordType === 'dynamic_finding_manifest')?.payload as unknown as Record<string, unknown>;
          if (!manifest || manifest.requestDigest !== requestDigest || !(prior as typeof prior & { findingLedgerReceipt?: unknown }).findingLedgerReceipt) throw new Error('IDEMPOTENCY_CONFLICT: dynamic batch request changed');
          return { manifest, assessments: rows.filter(row => row.recordType === 'finding_applicability_assessment').map(row => row.payload),
            dispositions: rows.filter(row => row.recordType === 'finding_deferral_disposition').map(row => row.payload),
            ledgerReceipt: (prior as typeof prior & { findingLedgerReceipt: unknown }).findingLedgerReceipt, gateEvidence: true, authority: 'dynamic_finding_applicability' };
        }
        const findings = ctx.store.readFindings(input.storyId).findings; const signer = findingLedgerSignerFromWorkspace(ctx.root);
        const context = currentApplicabilityContext(ctx.store, ctx.root, input.storyId); const createdAt = new Date();
        const records: Array<{ recordType: string; payload: JsonValue; uniqueBindingKey: string }> = [];
        const sources: LedgerRecord<JsonValue>[] = []; const entries: Record<string, unknown>[] = []; const assessments: FindingApplicabilityAssessment[] = []; const dispositions: FindingDeferralDisposition[] = [];
        for (const item of input.items) {
          const finding = findings.find(row => row.id === item.findingId);
          if (!finding || finding.status !== 'open' || finding.evidenceState === 'disproven') throw new Error(`dynamic finding: verified open Finding required: ${item.findingId}`);
          ledger = ctx.store.readFindingLedger<JsonValue>(input.storyId); const source = exactFindingRecord(ledger.records, finding.id); sources.push(source);
          const previousDeferral = findPayload<FindingDeferralDisposition>(ledger.records, 'finding_deferral_disposition', value => value.findingId === finding.id);
          if (previousDeferral) sources.push(previousDeferral.record);
          const { acceptedRoute } = resolveAcceptedRoute(ctx, item.route, input.storyId, finding.id, createdAt);
          const applicable = ['introduced', 'worsened', 'applicable'].includes(item.verdict);
          validateAssessmentClaim({ ...item, storyId: input.storyId, idempotencyKey: input.idempotencyKey }, finding.severity, acceptedRoute);
          const assessmentId = `assessment:${applicabilityDigest({ requestDigest, findingId: finding.id }).slice(0, 32)}`;
          const assessment = signApplicabilityAssessment({ schemaVersion: 1, assessmentId, findingId: finding.id, verdict: item.verdict,
            integrity: { state: 'fresh', ...context, assessedAt: createdAt.toISOString(), ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}) },
            proofStrength: item.proofStrength, dispositionPlan: item.dispositionPlan ?? null, acceptedRoute, gateImpact: item.gateImpact ?? 'unknown',
            evidenceRefs: [...new Set(item.evidenceRefs ?? [])].sort(), recheckTriggers: [...new Set(item.recheckTriggers ?? [])].sort(), keyId: signer.keyId }, signer.privateKey);
          assessments.push(assessment); records.push({ recordType: 'finding_applicability_assessment', uniqueBindingKey: `assessment:${assessmentId}`, payload: assessment as unknown as JsonValue });
          let dispositionId: string | undefined; let mandatoryRepairId: string | undefined;
          if (item.dispositionPlan === 'defer_with_proof') {
            if (findPayload<FindingDeferralDisposition>(ledger.records, 'finding_deferral_disposition', value => value.findingId === finding.id)) {
              throw new Error('dynamic finding: batch may only create an initial deferral; renew through finding_deferral_record');
            }
            const expiresAt = deferralExpiry(finding.severity, createdAt);
            if (!acceptedRoute || Date.parse(acceptedRoute.expiresAt) < expiresAt.getTime()) throw new Error('dynamic finding: batch route expires before deferral');
            const dispositionUnsigned: FindingDeferralDisposition & Record<string, unknown> = { schemaVersion: 1, dispositionId: `deferral:${applicabilityDigest({ assessmentId }).slice(0, 32)}`,
              findingId: finding.id, state: 'valid' as const, lineageState: 'current' as const, ownerStoryId: acceptedRoute.ownerStoryId,
              routeReceiptId: acceptedRoute.receiptId, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString(), renewalCount: 0,
              assessmentDispositionPlan: 'defer_with_proof' as const, keyId: signer.keyId };
            const disposition = signDynamicFindingRecord(dispositionUnsigned, signer.privateKey);
            dispositionId = disposition.dispositionId; dispositions.push(disposition);
            records.push({ recordType: 'finding_deferral_disposition', uniqueBindingKey: `deferral:${disposition.dispositionId}`, payload: disposition as unknown as JsonValue });
          }
          const invalidLineage = deferralLineageInvalid(previousDeferral, finding.severity, signer.publicKey, createdAt);
          if ((applicable && ['critical', 'high'].includes(finding.severity)) || invalidLineage) {
            const mandatoryUnsigned: MandatoryRepairClassification & Record<string, unknown> = { schemaVersion: 1, classificationId: `mandatory-repair:${applicabilityDigest({ assessmentId }).slice(0, 32)}`,
              findingId: finding.id, state: 'required' as const, assessmentId,
              reason: invalidLineage ? 'invalid_deferral_lineage' : 'critical_or_high_applicable',
              classifiedAt: createdAt.toISOString(), keyId: signer.keyId };
            const mandatory = signDynamicFindingRecord(mandatoryUnsigned, signer.privateKey);
            mandatoryRepairId = mandatory.classificationId;
            records.push({ recordType: 'mandatory_repair', uniqueBindingKey: `mandatory-repair:${mandatory.classificationId}`, payload: mandatory as unknown as JsonValue });
          }
          entries.push({ findingId: finding.id, assessmentId, verdict: item.verdict, expectedAssessmentDispositionPlan: item.dispositionPlan ?? null,
            ...(dispositionId ? { dispositionId } : {}), ...(mandatoryRepairId ? { mandatoryRepairId } : {}) });
        }
        const manifest = { schemaVersion: 1, manifestId: `manifest:${randomUUID()}`, storyId: input.storyId, action: 'batch_apply', requestDigest,
          expectedInputDigest: applicabilityDigest(input.items), entries, createdAt: createdAt.toISOString() };
        records.push({ recordType: 'dynamic_finding_manifest', uniqueBindingKey: `manifest:${manifest.manifestId}`, payload: manifest as unknown as JsonValue });
        const uniqueSources = sources.filter((row, index) => sources.findIndex(candidate => candidate.recordId === row.recordId) === index);
        const receipt = append(ctx, input.storyId, fence, idempotencyKey, 'apply_manifest', records, uniqueSources);
        return { manifest, assessments, dispositions, ledgerReceipt: receipt, gateEvidence: true, authority: 'dynamic_finding_applicability' };
      });
    },
    finding_applicability_assess(input: FindingApplicabilityAssessArgs) {
      text(input.storyId, 'storyId'); text(input.findingId, 'findingId'); text(input.idempotencyKey, 'idempotencyKey');
      return withLedgerLock(ctx, input.storyId, fence => {
        const requestDigest = applicabilityDigest(input);
        let ledger = ctx.store.readFindingLedger<JsonValue>(input.storyId);
        const prior = ledger.receipts.find(row => row.idempotencyKey === `dynamic-assessment:${input.idempotencyKey}`);
        if (prior) {
          const records = prior.recordIds.map(id => ledger.records.find(row => row.recordId === id)).filter((row): row is LedgerRecord<JsonValue> => !!row);
          const assessment = records.find(row => row.recordType === 'finding_applicability_assessment')?.payload as unknown as FindingApplicabilityAssessment;
          const manifest = records.find(row => row.recordType === 'dynamic_finding_manifest')?.payload as unknown as Record<string, unknown>;
          if (!assessment || !manifest || manifest.requestDigest !== requestDigest || !(prior as typeof prior & { findingLedgerReceipt?: unknown }).findingLedgerReceipt) throw new Error('IDEMPOTENCY_CONFLICT: dynamic assessment request changed');
          return { assessment, manifest, ledgerReceipt: (prior as typeof prior & { findingLedgerReceipt: unknown }).findingLedgerReceipt, gateEvidence: true, authority: 'dynamic_finding_applicability' };
        }
        const finding = ctx.store.readFindings(input.storyId).findings.find(row => row.id === input.findingId);
        if (!finding || finding.status !== 'open' || finding.evidenceState === 'disproven') throw new Error('dynamic finding: verified open Finding required');
        ledger = ctx.store.readFindingLedger<JsonValue>(input.storyId);
        const source = exactFindingRecord(ledger.records, finding.id);
        const previousAssessment = findPayload<FindingApplicabilityAssessment>(ledger.records, 'finding_applicability_assessment', value => value.findingId === finding.id);
        const previousDeferral = findPayload<FindingDeferralDisposition>(ledger.records, 'finding_deferral_disposition', value => value.findingId === finding.id);
        const now = new Date();
        const { acceptedRoute, record: routeRecord } = resolveAcceptedRoute(ctx, input.route, input.storyId, finding.id, now);
        const applicable = input.verdict === 'introduced' || input.verdict === 'worsened' || input.verdict === 'applicable';
        validateAssessmentClaim(input, finding.severity, acceptedRoute);
        const signer = findingLedgerSignerFromWorkspace(ctx.root);
        const context = currentApplicabilityContext(ctx.store, ctx.root, input.storyId);
        const unsigned: FindingApplicabilityAssessment = {
          schemaVersion: 1, assessmentId: `assessment:${randomUUID()}`, findingId: finding.id, verdict: input.verdict,
          integrity: { state: 'fresh', ...context, assessedAt: now.toISOString(), ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) },
          proofStrength: input.proofStrength, dispositionPlan: input.dispositionPlan ?? null, acceptedRoute,
          gateImpact: input.gateImpact ?? 'unknown', evidenceRefs: [...new Set(input.evidenceRefs ?? [])].sort(),
          recheckTriggers: [...new Set(input.recheckTriggers ?? [])].sort(), keyId: signer.keyId,
        };
        const assessment = signApplicabilityAssessment(unsigned, signer.privateKey);
        const invalidLineage = deferralLineageInvalid(previousDeferral, finding.severity, signer.publicKey, now);
        const mandatoryUnsigned: MandatoryRepairClassification & Record<string, unknown> = {
          schemaVersion: 1, classificationId: `mandatory-repair:${randomUUID()}`, findingId: finding.id,
          state: 'required', assessmentId: assessment.assessmentId,
          reason: invalidLineage ? 'invalid_deferral_lineage' : 'critical_or_high_applicable',
          classifiedAt: now.toISOString(), keyId: signer.keyId,
        };
        const mandatoryRepair = ((applicable && ['critical', 'high'].includes(finding.severity)) || invalidLineage)
          ? signDynamicFindingRecord(mandatoryUnsigned, signer.privateKey) : null;
        const manifest = { schemaVersion: 1, manifestId: `manifest:${randomUUID()}`, storyId: input.storyId, findingId: finding.id,
          action: 'assessment', assessmentId: assessment.assessmentId, expectedAssessmentDispositionPlan: assessment.dispositionPlan,
          ...(mandatoryRepair ? { mandatoryRepairId: mandatoryRepair.classificationId } : {}),
          sourceRecordIds: [source.recordId, ...(routeRecord ? [routeRecord.recordId] : [])], requestDigest, createdAt: now.toISOString() };
        const reattestation = previousAssessment ? { schemaVersion: 1, reattestationId: `reattestation:${randomUUID()}`, findingId: finding.id,
          priorAssessmentId: previousAssessment.payload.assessmentId, priorAssessmentRecordId: previousAssessment.record.recordId,
          priorAssessmentRecordHash: exactLedgerRecordHash(previousAssessment.record), currentAssessmentId: assessment.assessmentId,
          currentBindingDigest: applicabilityDigest(assessment.integrity), createdAt: now.toISOString() } : null;
        const receipt = append(ctx, input.storyId, fence, `dynamic-assessment:${input.idempotencyKey}`, 'append_assessment', [
          { recordType: 'finding_applicability_assessment', uniqueBindingKey: `assessment:${assessment.assessmentId}`, payload: assessment as unknown as JsonValue },
          { recordType: 'dynamic_finding_manifest', uniqueBindingKey: `manifest:${manifest.manifestId}`, payload: manifest as unknown as JsonValue },
          ...(mandatoryRepair ? [{ recordType: 'mandatory_repair', uniqueBindingKey: `mandatory-repair:${mandatoryRepair.classificationId}`, payload: mandatoryRepair as unknown as JsonValue }] : []),
          ...(reattestation ? [{ recordType: 'material_drift_reattestation', uniqueBindingKey: `reattestation:${reattestation.reattestationId}`, payload: reattestation as unknown as JsonValue }] : []),
        ], [source, ...(previousAssessment ? [previousAssessment.record] : []), ...(previousDeferral ? [previousDeferral.record] : [])]);
        return { assessment, manifest, ...(mandatoryRepair ? { mandatoryRepair } : {}), ...(reattestation ? { reattestation } : {}), ledgerReceipt: receipt, gateEvidence: true, authority: 'dynamic_finding_applicability' };
      });
    },
    finding_deferral_record(input: FindingDeferralRecordArgs) {
      text(input.storyId, 'storyId'); text(input.findingId, 'findingId'); text(input.assessmentId, 'assessmentId'); text(input.idempotencyKey, 'idempotencyKey');
      return withLedgerLock(ctx, input.storyId, fence => {
        const requestDigest = applicabilityDigest(input);
        const finding = ctx.store.readFindings(input.storyId).findings.find(row => row.id === input.findingId);
        if (!finding || !['low', 'medium'].includes(finding.severity)) throw new Error('dynamic finding: only low/medium Findings may be deferred');
        const ledger = ctx.store.readFindingLedger<JsonValue>(input.storyId);
        const prior = ledger.receipts.find(row => row.idempotencyKey === `dynamic-deferral:${input.idempotencyKey}`);
        if (prior) {
          const records = prior.recordIds.map(id => ledger.records.find(row => row.recordId === id)).filter((row): row is LedgerRecord<JsonValue> => !!row);
          const disposition = records.find(row => row.recordType === 'finding_deferral_disposition')?.payload as unknown as FindingDeferralDisposition;
          const manifest = records.find(row => row.recordType === 'dynamic_finding_manifest')?.payload as unknown as Record<string, unknown>;
          if (!disposition || !manifest || manifest.requestDigest !== requestDigest || !(prior as typeof prior & { findingLedgerReceipt?: unknown }).findingLedgerReceipt) throw new Error('IDEMPOTENCY_CONFLICT: dynamic deferral request changed');
          return { disposition, manifest, ledgerReceipt: (prior as typeof prior & { findingLedgerReceipt: unknown }).findingLedgerReceipt, gateEvidence: true, authority: 'dynamic_finding_applicability' };
        }
        const row = findPayload<FindingApplicabilityAssessment>(ledger.records, 'finding_applicability_assessment', value => value.assessmentId === input.assessmentId && value.findingId === input.findingId);
        const signer = findingLedgerSignerFromWorkspace(ctx.root);
        if (!row || !verifyApplicabilityAssessment(row.payload, signer.publicKey) || row.payload.dispositionPlan !== 'defer_with_proof'
          || row.payload.verdict !== 'applicable' || row.payload.gateImpact !== 'does_not_block'
          || !nonEmptyStrings(row.payload.evidenceRefs) || !nonEmptyStrings(row.payload.recheckTriggers)
          || !row.payload.acceptedRoute || row.payload.acceptedRoute.receiptState !== 'fresh') throw new Error('dynamic finding: current signed defer_with_proof assessment required');
        const now = new Date();
        if (verifyAssessmentFreshness(row.payload, currentApplicabilityContext(ctx.store, ctx.root, input.storyId), now) !== 'fresh'
          || !routeStillCurrent(ctx.store, ctx.root, row.payload.acceptedRoute, now)) throw new Error('dynamic finding: assessment or accepted route is stale');
        const previous = findPayload<FindingDeferralDisposition>(ledger.records, 'finding_deferral_disposition', value => value.findingId === input.findingId);
        const renewalCount = input.renewalCount ?? 0;
        if ((!previous && renewalCount !== 0) || (previous && renewalCount !== (previous.payload.renewalCount ?? 0) + 1)) {
          throw new Error('dynamic finding: renewalCount must advance the ledger lineage exactly once');
        }
        if (previous && !verifyDynamicFindingRecord(previous.payload as FindingDeferralDisposition & Record<string, unknown>, signer.publicKey)) {
          throw new Error('dynamic finding: prior deferral lineage signature invalid');
        }
        const writtenAt = now;
        const lineageCreatedAt = previous?.payload.createdAt ? new Date(previous.payload.createdAt) : writtenAt;
        const expiresAt = deferralExpiry(finding.severity, lineageCreatedAt, renewalCount);
        if (Date.parse(row.payload.acceptedRoute.expiresAt) < expiresAt.getTime()) throw new Error('dynamic finding: owner route expires before deferral');
        const unsignedDisposition: FindingDeferralDisposition = { schemaVersion: 1, dispositionId: `deferral:${randomUUID()}`, findingId: finding.id,
          state: 'valid', lineageState: 'current', ownerStoryId: row.payload.acceptedRoute.ownerStoryId,
          routeReceiptId: row.payload.acceptedRoute.receiptId, createdAt: lineageCreatedAt.toISOString(), expiresAt: expiresAt.toISOString(),
          renewalCount, ...(previous ? { predecessorDispositionId: previous.payload.dispositionId } : {}),
          assessmentDispositionPlan: 'defer_with_proof', keyId: signer.keyId };
        const disposition = signDynamicFindingRecord(unsignedDisposition, signer.privateKey);
        const manifest = { schemaVersion: 1, manifestId: `manifest:${randomUUID()}`, storyId: input.storyId, findingId: finding.id,
          action: 'defer_with_proof', assessmentId: input.assessmentId, dispositionId: disposition.dispositionId,
          expectedAssessmentDispositionPlan: 'defer_with_proof', ownerStoryId: disposition.ownerStoryId, requestDigest, createdAt: writtenAt.toISOString() };
        const receipt = append(ctx, input.storyId, fence, `dynamic-deferral:${input.idempotencyKey}`, 'append_deferral', [
          { recordType: 'finding_deferral_disposition', uniqueBindingKey: `deferral:${disposition.dispositionId}`, payload: disposition as unknown as JsonValue },
          { recordType: 'dynamic_finding_manifest', uniqueBindingKey: `manifest:${manifest.manifestId}`, payload: manifest as unknown as JsonValue },
        ], [row.record, ...(previous ? [previous.record] : [])]);
        return { disposition, manifest, ledgerReceipt: receipt, gateEvidence: true, authority: 'dynamic_finding_applicability' };
      });
    },
    finding_mandatory_repair_close(input: FindingMandatoryRepairCloseArgs) {
      text(input.storyId, 'storyId'); text(input.findingId, 'findingId'); text(input.idempotencyKey, 'idempotencyKey'); text(input.classificationId, 'classificationId');
      if (!Array.isArray(input.closureEvidenceRefs) || input.closureEvidenceRefs.length === 0 || input.closureEvidenceRefs.some(value => typeof value !== 'string' || !value.trim())) throw new Error('dynamic finding: closureEvidenceRefs required');
      return withLedgerLock(ctx, input.storyId, fence => {
        const requestDigest = applicabilityDigest(input); const ledger = ctx.store.readFindingLedger<JsonValue>(input.storyId);
        const priorReceipt = ledger.receipts.find(row => row.idempotencyKey === `dynamic-mandatory-close:${input.idempotencyKey}`);
        if (priorReceipt) {
          const record = priorReceipt.recordIds.map(id => ledger.records.find(row => row.recordId === id)).find(row => row?.recordType === 'mandatory_repair');
          const payload = record?.payload as unknown as MandatoryRepairClassification & { requestDigest?: string };
          if (!payload || payload.requestDigest !== requestDigest || !(priorReceipt as typeof priorReceipt & { findingLedgerReceipt?: unknown }).findingLedgerReceipt) throw new Error('IDEMPOTENCY_CONFLICT: mandatory repair closure request changed');
          return { mandatoryRepair: payload, ledgerReceipt: (priorReceipt as typeof priorReceipt & { findingLedgerReceipt: unknown }).findingLedgerReceipt, gateEvidence: true, authority: 'dynamic_finding_applicability' };
        }
        const finding = ctx.store.readFindings(input.storyId).findings.find(row => row.id === input.findingId);
        if (!finding || finding.status !== 'resolved') throw new Error('dynamic finding: complete repair closure requires resolved Finding');
        const required = findPayload<MandatoryRepairClassification>(ledger.records, 'mandatory_repair', value => value.findingId === input.findingId && value.classificationId === input.classificationId && value.state === 'required');
        const signer = findingLedgerSignerFromWorkspace(ctx.root);
        if (!required || !verifyDynamicFindingRecord(required.payload as MandatoryRepairClassification & Record<string, unknown>, signer.publicKey)) throw new Error('dynamic finding: signed mandatory repair classification required');
        const closureUnsigned: MandatoryRepairClassification & Record<string, unknown> = {
          schemaVersion: 1, classificationId: input.classificationId, findingId: input.findingId,
          state: 'closure_proven', closureEvidenceRefs: [...new Set(input.closureEvidenceRefs)].sort(),
          closedAt: new Date().toISOString(), requestDigest, keyId: signer.keyId,
        };
        const closure = signDynamicFindingRecord(closureUnsigned, signer.privateKey);
        const receipt = append(ctx, input.storyId, fence, `dynamic-mandatory-close:${input.idempotencyKey}`, 'append_mandatory_repair', [
          { recordType: 'mandatory_repair', uniqueBindingKey: `mandatory-repair-closure:${input.classificationId}`, payload: closure as unknown as JsonValue },
        ], [required.record]);
        return { mandatoryRepair: closure, ledgerReceipt: receipt, gateEvidence: true, authority: 'dynamic_finding_applicability' };
      });
    },
    finding_triage: findingTriage,
    finding_rollout_scorecard(input: FindingTriageArgs) {
      const result = findingTriage(input);
      return { storyId: result.storyId, mode: result.mode, manifestDigest: result.manifestDigest, scorecard: result.scorecard,
        rows: result.rows.map(row => ({ findingId: row.findingId, legacyBlocking: row.decision.legacyBlocking,
          dynamicBlocking: row.decision.dynamicBlocking, reason: row.decision.reason })) };
    },
  };
}
