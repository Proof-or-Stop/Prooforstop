/** Owner-side mutation boundary. Gate/triage readers never append candidates. */
import type { HandlerContext } from './context.js';
import type { JsonValue } from '../core/finding-ledger.js';
import { applicabilityDigest, verifyDynamicFindingRecord, type FindingApplicabilityAssessment, type FindingDeferralDisposition } from '../core/finding-applicability.js';
import { readDynamicFindingDecision, resolveDynamicFindingRollout, currentApplicabilityContext } from '../core/finding-applicability-projection.js';
import { exactLedgerRecordHash } from './finding-ledger.js';
import { createFindingHistoryHandlers, findingHistoryRecallObservation, type DeferralInvalidationObservationProvider } from './finding-history.js';
import { verifiedIdentityCarrier, identityTrust, readCanonicalCatalog } from './finding-identity-store.js';
import { identityHash } from '../core/finding-identity.js';

/** Story1 owns L4 invalidation; Story2 receives only a non-authoritative recall observation. */
export const observeDeferralInvalidation: DeferralInvalidationObservationProvider = (ctx, args, source, receipt) => {
  if (args.deferral!.storyId !== receipt.source.storyId || args.storyId !== receipt.source.storyId) throw new Error('history: deferral recall requires source owner');
  const ledger = source.store.readFindingLedger<JsonValue>(args.storyId);
  const row = verifiedIdentityCarrier(ledger, args.storyId, args.deferral!.recordId, identityTrust(source)).record;
  const deferral = row.payload as unknown as FindingDeferralDisposition;
  if (row.recordType !== 'finding_deferral_disposition' || exactLedgerRecordHash(row) !== args.deferral!.recordHash
    || !verifyDynamicFindingRecord(deferral as unknown as Record<string, unknown>, identityTrust(source).publicKey)
    || deferral.routeReceiptId !== receipt.routeReceiptId || deferral.ownerStoryId !== receipt.target.id) throw new Error('history: invalid deferral/route binding');
  const latest = [...ledger.records].reverse().find(item => item.recordType === 'finding_deferral_disposition'
    && (item.payload as unknown as FindingDeferralDisposition).findingId === deferral.findingId);
  if (latest?.recordId !== row.recordId) throw new Error('history: superseded deferral is not a current recall trigger');
  const assessment = ledger.records.find(item => item.recordType === 'finding_applicability_assessment'
    && (item.payload as unknown as FindingApplicabilityAssessment).assessmentId === deferral.assessmentId)?.payload as unknown as FindingApplicabilityAssessment | undefined;
  if (!assessment || assessment.proposalRef?.recordId !== receipt.source.recordId) throw new Error('history: deferral proposal substituted');
  const finding = source.store.readFindings(args.storyId).findings.find(item => item.id === deferral.findingId);
  if (!finding) throw new Error('history: deferral Finding missing');
  const decision = readDynamicFindingDecision({ store: source.store, projectRoot: source.root, storyId: args.storyId, finding,
    effectiveBlockingSeverities: ['critical', 'high', 'medium'], round: 3, diagnostic: true });
  if (!decision.floors.includes('deferral_lineage')) throw new Error('history: deferral invalidation not observed');
  // Clock values and unrelated append-only rows cannot manufacture another trigger.
  let binding: unknown;
  try { const { headHash: _head, baseHash: _base, ...semantic } = currentApplicabilityContext(source.store, source.root, args.storyId, assessment.runtimeReceiptIds); binding = semantic; }
  catch { binding = { state: 'unavailable' }; }
  const currentAssessment = [...ledger.records].reverse().find(item => item.recordType === 'finding_applicability_assessment'
    && (item.payload as unknown as FindingApplicabilityAssessment).findingId === finding.id);
  return { deferral: args.deferral, reason: decision.reason, canonicalDefectId: deferral.canonicalDefectId,
    currentAssessment: currentAssessment ? exactLedgerRecordHash(currentAssessment) : null, binding, severity: finding.severity,
    canonicalGraph: identityHash(readCanonicalCatalog(ctx).input), expired: Date.now() >= Date.parse(deferral.expiresAt),
    expiresAt: deferral.expiresAt, validity: 'invalidated' };
};

export function reconcileFindingDeferralRecalls(ctx: HandlerContext, storyId: string) {
  const rollout = resolveDynamicFindingRollout(ctx.root);
  if (rollout.killSwitch || rollout.mode === 'observe') return { rows: [], gateEvidence: false, skipped: 'compatibility_mode' };
  const ledger = ctx.store.readFindingLedger<JsonValue>(storyId);
  const latest = new Map<string, typeof ledger.records[number]>();
  for (const row of ledger.records) if (row.recordType === 'finding_deferral_disposition') {
    const payload = row.payload as unknown as FindingDeferralDisposition;
    if (payload.findingId) latest.set(payload.findingId, row);
  }
  const findings = ctx.store.readFindings(storyId).findings;
  const rows = [];
  for (const [findingId, row] of latest) {
    const finding = findings.find(item => item.id === findingId);
    if (!finding) throw new Error('deferral recall: historical Finding missing');
    const decision = readDynamicFindingDecision({ store: ctx.store, projectRoot: ctx.root, storyId, finding,
      effectiveBlockingSeverities: ['critical', 'high', 'medium'], round: 3, diagnostic: true });
    if (!decision.floors.includes('deferral_lineage')) continue;
    const deferral = row.payload as unknown as FindingDeferralDisposition;
    const assessment = ledger.records.find(item => item.recordType === 'finding_applicability_assessment'
      && (item.payload as unknown as FindingApplicabilityAssessment).assessmentId === deferral.assessmentId)?.payload as unknown as FindingApplicabilityAssessment | undefined;
    const route = assessment?.acceptedRoute;
    if (!route?.receiptRecordId || !route.receiptRecordHash) throw new Error('deferral recall: historical exact route missing; obligation remains blocking');
    const ref = { storyId, recordId: row.recordId, recordHash: exactLedgerRecordHash(row) };
    const request = { storyId, route: { storyId: route.ownerStoryId, recordId: route.receiptRecordId, recordHash: route.receiptRecordHash }, idempotencyKey: 'derive-only' };
    const causes = [];
    // Reuse existing observation keys so an explicit recall and the automatic
    // path cannot create two candidates for the same route/owner/expiry event.
    for (const trigger of ['expired', 'owner_invalid', 'target_closed_unfixed', 'severity_escalation', 'source_hash_drift', 'runtime_drift'] as const) {
      try { const input = { ...request, trigger }; const observed = findingHistoryRecallObservation(ctx, input, observeDeferralInvalidation); causes.push({ input, observed }); }
      catch { /* The L4 fallback below remains fail-closed if no known cause can be proven. */ }
    }
    if (!causes.length) {
      const input = { ...request, trigger: 'deferral_invalidated' as const, deferral: ref };
      causes.push({ input, observed: findingHistoryRecallObservation(ctx, input, observeDeferralInvalidation) });
    }
    for (const { input, observed } of causes) rows.push(createFindingHistoryHandlers(ctx, observeDeferralInvalidation).finding_history_recall({ ...input,
      idempotencyKey: `deferral-recall:${observed.triggerDigest}` }));
  }
  return { rows, gateEvidence: false };
}
