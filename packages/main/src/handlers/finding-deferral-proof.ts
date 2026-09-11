import { DEFERRAL_EXPIRY_POLICY, applicabilityDigest, signDynamicFindingRecord, verifyDynamicFindingRecord,
  deferralExpiry, type FindingApplicabilityAssessment, type FindingDeferralDisposition } from '../core/finding-applicability.js';
import type { HandlerContext } from './context.js';
import type { JsonValue, LedgerRecord } from '../core/finding-ledger.js';
import { exactLedgerRecordHash, findingLedgerSignerFromWorkspace } from './finding-ledger.js';
import { readFindingRouteProgressProof } from './finding-route.js';
import { historicalStoryContext, readCanonicalCatalog, identityTrust, verifiedIdentityCarrier } from './finding-identity-store.js';
import { canonicalCurrent } from '../core/finding-history.js';

export interface SignedDeferralPolicy extends Record<string, unknown> {
  version: 'finding-deferral-expiry-v1'; effectiveAt: string; policyDigest: string;
  constants: typeof DEFERRAL_EXPIRY_POLICY; keyId: string; signature?: string;
}
export function verifyDeferralPolicy(policy: SignedDeferralPolicy, publicKey: string, now: Date): boolean {
  const { policyDigest, signature, ...unsigned } = policy;
  return verifyDynamicFindingRecord(policy, publicKey) && policy.version === 'finding-deferral-expiry-v1'
    && applicabilityDigest(unsigned) === policyDigest && applicabilityDigest(policy.constants) === applicabilityDigest(DEFERRAL_EXPIRY_POLICY)
    && Number.isFinite(Date.parse(policy.effectiveAt)) && Date.parse(policy.effectiveAt) <= now.getTime();
}
export function deferralPolicyForWrite(ctx: HandlerContext, records: LedgerRecord<JsonValue>[], now: Date, previous?: FindingDeferralDisposition) {
  const signer = findingLedgerSignerFromWorkspace(ctx.root);
  const policies = records.filter(row => row.recordType === 'deferral_expiry_policy').map(row => row.payload as unknown as SignedDeferralPolicy);
  let policy = previous ? policies.find(row => row.policyDigest === previous.policyDigest) : policies.at(-1);
  if (previous && !policy) throw new Error('dynamic finding: original signed expiry policy missing');
  let create = false;
  if (!policy) {
    const unsigned = { version: 'finding-deferral-expiry-v1' as const, effectiveAt: now.toISOString(), constants: DEFERRAL_EXPIRY_POLICY, keyId: signer.keyId };
    policy = signDynamicFindingRecord({ ...unsigned, policyDigest: applicabilityDigest(unsigned) } as SignedDeferralPolicy, signer.privateKey); create = true;
  }
  if (!verifyDeferralPolicy(policy, signer.publicKey, now)) throw new Error('dynamic finding: invalid/effective expiry policy');
  return { policy, create };
}

export function buildVerifiedDeferral(ctx: HandlerContext, args: { storyId: string; findingId: string; severity: string;
  dispositionId: string; assessment: FindingApplicabilityAssessment; now: Date; policy: SignedDeferralPolicy;
  previous?: { record: LedgerRecord<JsonValue>; payload: FindingDeferralDisposition }; assertedRenewalCount?: number }) {
  const { assessment, previous, now } = args; const route = assessment.acceptedRoute;
  if (!route?.receiptRecordId || !route.receiptRecordHash || !route.receiptId) throw new Error('dynamic finding: exact route tuple required');
  const signer = findingLedgerSignerFromWorkspace(ctx.root);
  const count = previous ? (previous.payload.renewalCount ?? -1) + 1 : 0;
  if (args.assertedRenewalCount !== undefined && args.assertedRenewalCount !== count) throw new Error('dynamic finding: caller renewal count differs from ledger');
  if (previous && (!verifyDynamicFindingRecord(previous.payload as unknown as Record<string, unknown>, signer.publicKey)
    || previous.payload.state !== 'valid' || previous.payload.lineageState !== 'current' || Date.parse(previous.payload.expiresAt) <= now.getTime())) {
    throw new Error('dynamic finding: exhausted/expired/invalid lineage requires repair, not renewal');
  }
  const evidence = readFindingRouteProgressProof(ctx, { storyId: route.ownerStoryId, recordId: route.receiptRecordId, recordHash: route.receiptRecordHash },
    previous ? { storyId: args.storyId, recordId: previous.record.recordId, recordHash: exactLedgerRecordHash(previous.record) } : undefined);
  assertNoCanonicalDeferralReset(ctx, evidence.canonicalDefect.canonicalDefectId, args.storyId, args.findingId);
  if (evidence.receipt.source.recordId !== assessment.proposalRef?.recordId || evidence.receipt.source.subjectHash !== assessment.proposalRef?.subjectHash) {
    throw new Error('dynamic finding: route belongs to a different assessment proposal');
  }
  if (previous && (previous.payload.canonicalDefectId !== evidence.canonicalDefect.canonicalDefectId
    || previous.payload.initialProgressBaselineSetId !== evidence.baseline.baselineSetId
    || previous.payload.initialProgressBaselineSetHash !== evidence.baseline.baselineSetHash
    || previous.payload.policyDigest !== args.policy.policyDigest)) throw new Error('dynamic finding: renewal changed canonical/baseline/policy lineage');
  const firstDeferredAt = previous?.payload.firstDeferredAt ?? now.toISOString();
  const severity = args.severity === 'medium' || previous?.payload.severityBound === 'medium' ? 'medium' : args.severity;
  const horizon = deferralExpiry(severity, new Date(firstDeferredAt), count);
  const expiresAt = new Date(Math.min(horizon.getTime(), Date.parse(route.expiresAt), Date.parse(assessment.integrity.expiresAt ?? route.expiresAt)));
  if (expiresAt.getTime() <= now.getTime()) throw new Error('dynamic finding: deferral horizon exhausted');
  const disposition: FindingDeferralDisposition = {
    schemaVersion: 1, findingId: args.findingId, dispositionId: args.dispositionId, assessmentId: assessment.assessmentId,
    state: 'valid', lineageState: 'current', ownerStoryId: route.ownerStoryId, routeReceiptId: route.receiptId,
    createdAt: firstDeferredAt, firstDeferredAt, expiresAt: expiresAt.toISOString(), renewalCount: count,
    ...(previous ? { predecessorDispositionId: previous.payload.dispositionId } : {}),
    canonicalDefectId: evidence.canonicalDefect.canonicalDefectId,
    initialProgressBaselineSetId: evidence.baseline.baselineSetId, initialProgressBaselineSetHash: evidence.baseline.baselineSetHash,
    ...(evidence.progress ? { progressEvidenceBindingDigest: evidence.progress.tupleDigest, predecessorBaselineDigest: evidence.progress.predecessorBaselineDigest } : {}),
    lineageRootDeferralId: previous?.payload.lineageRootDeferralId ?? args.dispositionId,
    policyDigest: args.policy.policyDigest, expiryPolicyVersion: args.policy.version,
    severityBound: severity as 'low' | 'medium',
    assessmentDispositionPlan: 'defer_with_proof', keyId: signer.keyId,
  };
  return signDynamicFindingRecord({ ...disposition, lineageDigest: applicabilityDigest({ previous: previous ? exactLedgerRecordHash(previous.record) : null, disposition }) }, signer.privateKey);
}

/** Reader checks the entire immutable chain. A signed "current" label is not a waiver. */
export function verifyDeferralProjection(ctx: HandlerContext, storyId: string, severity: string, assessment: FindingApplicabilityAssessment | undefined,
  record: LedgerRecord<JsonValue>, now = new Date()): FindingDeferralDisposition {
  const ledger = ctx.store.readFindingLedger<JsonValue>(storyId); const trust = identityTrust(ctx);
  const current = record.payload as unknown as FindingDeferralDisposition;
  const fail = (): never => { throw new Error('dynamic finding: invalid deferral policy/lineage/progress'); };
  if (!assessment || assessment.assessmentId !== current.assessmentId || !['low', 'medium'].includes(severity)) fail();
  const chain: Array<{ record: LedgerRecord<JsonValue>; payload: FindingDeferralDisposition }> = [];
  const seen = new Set<string>(); let node = record;
  for (;;) {
    const row = node.payload as unknown as FindingDeferralDisposition;
    verifiedIdentityCarrier(ledger, storyId, node.recordId, trust);
    if (!row.dispositionId || seen.has(row.dispositionId) || row.findingId !== current.findingId
      || !verifyDynamicFindingRecord(row as unknown as Record<string, unknown>, trust.publicKey)) fail();
    seen.add(row.dispositionId!); chain.unshift({ record: node, payload: row });
    if (!row.predecessorDispositionId) break;
    const before = ledger.records.find(candidate => candidate.recordType === 'finding_deferral_disposition'
      && (candidate.payload as unknown as FindingDeferralDisposition).dispositionId === row.predecessorDispositionId);
    if (!before) fail(); node = before!;
  }
  const first = chain[0]!.payload;
  const policyRow = ledger.records.find(row => row.recordType === 'deferral_expiry_policy'
    && (row.payload as unknown as SignedDeferralPolicy).policyDigest === first.policyDigest);
  if (!policyRow) fail();
  verifiedIdentityCarrier(ledger, storyId, policyRow!.recordId, trust);
  const policy = policyRow!.payload as unknown as SignedDeferralPolicy;
  if (!verifyDeferralPolicy(policy, trust.publicKey, now) || !Number.isFinite(Date.parse(first.firstDeferredAt ?? ''))
    || Date.parse(first.firstDeferredAt!) > now.getTime()) fail();
  let previous: typeof chain[number] | undefined;
  let strictSeverity = severity;
  for (const item of chain) {
    const { signature, lineageDigest, ...unsigned } = item.payload;
    if (item.payload.severityBound === 'medium') strictSeverity = 'medium';
    if (!['low', 'medium'].includes(item.payload.severityBound ?? '') || item.payload.state !== 'valid'
      || item.payload.lineageState !== 'current' || item.payload.policyDigest !== policy.policyDigest
      || item.payload.expiryPolicyVersion !== policy.version || item.payload.renewalCount !== (previous ? previous.payload.renewalCount! + 1 : 0)
      || item.payload.firstDeferredAt !== first.firstDeferredAt || item.payload.createdAt !== first.firstDeferredAt
      || item.payload.lineageRootDeferralId !== first.dispositionId || item.payload.canonicalDefectId !== first.canonicalDefectId
      || item.payload.initialProgressBaselineSetId !== first.initialProgressBaselineSetId
      || item.payload.initialProgressBaselineSetHash !== first.initialProgressBaselineSetHash
      || lineageDigest !== applicabilityDigest({ previous: previous ? exactLedgerRecordHash(previous.record) : null, disposition: unsigned })) fail();
    const limit = deferralExpiry(strictSeverity, new Date(first.firstDeferredAt!), item.payload.renewalCount);
    if (!Number.isFinite(Date.parse(item.payload.expiresAt)) || Date.parse(item.payload.expiresAt) > limit.getTime()) fail();
    previous = item;
  }
  if (Date.parse(current.expiresAt) <= now.getTime()) fail();
  assertNoCanonicalDeferralReset(ctx, current.canonicalDefectId!, storyId, current.findingId!);
  const route = assessment!.acceptedRoute;
  if (!route?.receiptRecordId || !route.receiptRecordHash || route.receiptId !== current.routeReceiptId || route.ownerStoryId !== current.ownerStoryId) fail();
  const predecessor = chain.at(-2);
  const proof = readFindingRouteProgressProof(ctx, { storyId: route!.ownerStoryId, recordId: route!.receiptRecordId!, recordHash: route!.receiptRecordHash! },
    predecessor ? { storyId, recordId: predecessor.record.recordId, recordHash: exactLedgerRecordHash(predecessor.record) } : undefined);
  if (proof.baseline.baselineSetId !== current.initialProgressBaselineSetId || proof.baseline.baselineSetHash !== current.initialProgressBaselineSetHash
    || proof.canonicalDefect.canonicalDefectId !== current.canonicalDefectId
    || proof.progress?.tupleDigest !== current.progressEvidenceBindingDigest || proof.progress?.predecessorBaselineDigest !== current.predecessorBaselineDigest) fail();
  return current;
}

/** An alias/supersession or another Story must not restart an existing clock. */
export function assertNoCanonicalDeferralReset(ctx: HandlerContext, canonicalDefectId: string, storyId: string, findingId: string): void {
  const catalog = readCanonicalCatalog(ctx);
  const node = catalog.rows.find(row => row.envelope.payload.canonicalDefectId === canonicalDefectId);
  if (!node) throw new Error('dynamic finding: canonical lineage unavailable');
  const history = canonicalCurrent(catalog.input, node.record.recordId);
  const family = [history.current, ...history.predecessors];
  const ids = new Set(family.map(row => row.entityId));
  const storyIds = new Set(family.flatMap(row => (row.payload as { memberFindingRefs: Array<{ storyId: string }> }).memberFindingRefs.map(ref => ref.storyId)));
  for (const id of storyIds) {
    const source = historicalStoryContext(ctx, id); const ledger = source.store.readFindingLedger<JsonValue>(id);
    for (const row of ledger.records.filter(row => row.recordType === 'finding_deferral_disposition')) {
      const disposition = row.payload as unknown as FindingDeferralDisposition;
      if (!ids.has(disposition.canonicalDefectId ?? '') || (id === storyId && disposition.findingId === findingId)) continue;
      verifiedIdentityCarrier(ledger, id, row.recordId, identityTrust(source));
      throw new Error('dynamic finding: canonical defect already has a deferral lineage; resetting it through another Finding/Story is refused');
    }
  }
}
