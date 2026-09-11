/** Owner-side mutation boundary. Gate/triage readers never append candidates. */
import type { HandlerContext } from './context.js';
import type { JsonValue } from '../core/finding-ledger.js';
import { applicabilityDigest, type FindingApplicabilityAssessment, type FindingDeferralDisposition } from '../core/finding-applicability.js';
import { readDynamicFindingDecision, resolveDynamicFindingRollout } from '../core/finding-applicability-projection.js';
import { exactLedgerRecordHash } from './finding-ledger.js';
import { createFindingHistoryHandlers, findingHistoryRecallObservation } from './finding-history.js';

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
      try { const input = { ...request, trigger }; const observed = findingHistoryRecallObservation(ctx, input); causes.push({ input, observed }); }
      catch { /* The L4 fallback below remains fail-closed if no known cause can be proven. */ }
    }
    if (!causes.length) {
      const input = { ...request, trigger: 'deferral_invalidated' as const, deferral: ref };
      causes.push({ input, observed: findingHistoryRecallObservation(ctx, input) });
    }
    for (const { input, observed } of causes) rows.push(createFindingHistoryHandlers(ctx).finding_history_recall({ ...input,
      idempotencyKey: `deferral-recall:${observed.triggerDigest}` }));
  }
  return { rows, gateEvidence: false };
}
