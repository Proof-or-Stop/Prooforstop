/** Pure four-kind baseline and semantic-progress verification. */
import { z } from 'zod';
import { identityHash, parseIdentityInput, verifyIdentityEnvelope } from './finding-identity.js';
import { ledgerRefSchema, routeHash, routeText, routeTime, routeSubjectSchema, targetSnapshotSchema, assertCanonicalSubject } from './finding-route.js';
import type { FindingLedgerReceiptTrust } from './finding-ledger.js';
import type { IdentitySemanticEnvelope } from './finding-identity-types.js';
export const PROGRESS_KINDS = ['target_source_change', 'target_test_result', 'target_delivery_state', 'target_status_transition'] as const;
export const progressKindSchema = z.enum(PROGRESS_KINDS);
export const projectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('target_source_change'), affectedContractRefs: z.array(routeText).min(1), sourcePaths: z.array(routeText).min(1), relevantSourceDigest: routeHash }).strict(),
  z.object({ kind: z.literal('target_test_result'), commandDigest: routeHash, selectorDigest: routeHash, outcome: z.enum(['pass', 'fail']), executionKey: routeText, receiptHash: routeHash }).strict(),
  z.object({ kind: z.literal('target_delivery_state'), itemId: routeText, signedState: z.enum(['pending', 'in_progress', 'done']), stateEvidenceHash: routeHash }).strict(),
  z.object({ kind: z.literal('target_status_transition'), itemId: routeText, state: z.enum(['pending', 'in_progress', 'done']), transitionPolicyDigest: routeHash }).strict(),
]);
const baselineAuthority = z.object({ profile: z.literal('progress_baseline'), authority: z.literal('target_route_semantic_only'), gateEvidence: z.literal(false) }).strict();
const base = { schemaVersion: z.literal(1), authority: z.literal('non_authoritative'), gateEvidence: z.literal(false),
  canonicalDefectId: routeText, routeReceiptId: routeText, routeSubjectDigest: routeHash, subject: routeSubjectSchema,
  targetSnapshot: targetSnapshotSchema, capturedAt: routeTime, derivedBy: z.object({ producer: z.literal('cli'), producerVersion: routeText, commandOrHandlerDigest: routeHash }).strict(),
  signedBy: routeText, signedByAuthority: targetSnapshotSchema.shape.owner.shape.authority };
export const baselineSchema = z.object({ ...base, evidenceAuthority: baselineAuthority, kind: progressKindSchema,
  projectionState: z.enum(['present', 'absent']), projection: projectionSchema.optional(), projectionDigest: routeHash.optional(), absenceDigest: routeHash.optional(), baselineHash: routeHash }).strict();
export type ProgressProjection = z.infer<typeof projectionSchema>;
export type ProgressBaseline = z.infer<typeof baselineSchema>;
export function absenceDigest(base: Pick<ProgressBaseline, 'kind' | 'canonicalDefectId' | 'routeSubjectDigest' | 'subject'>): string {
  return identityHash({ projectionState: 'absent', kind: base.kind, canonicalDefectId: base.canonicalDefectId, routeSubjectDigest: base.routeSubjectDigest, subject: base.subject });
}
export function semanticProjection(projection: ProgressProjection): object {
  switch (projection.kind) {
    case 'target_test_result': return { kind: projection.kind, commandDigest: projection.commandDigest, selectorDigest: projection.selectorDigest, outcome: projection.outcome };
    case 'target_delivery_state': return { kind: projection.kind, itemId: projection.itemId, signedState: projection.signedState };
    default: return projection;
  }
}
export function assertProjectionSubject(projection: ProgressProjection, subject: z.infer<typeof routeSubjectSchema>, target: z.infer<typeof targetSnapshotSchema>): void {
  assertCanonicalSubject(subject);
  if (projection.kind === 'target_source_change') {
    if (identityHash(projection.affectedContractRefs) !== identityHash(subject.affectedContractRefs) || identityHash(projection.sourcePaths) !== identityHash(subject.sourcePaths)) throw new Error('progress: source projection subject mismatch');
  } else if (projection.kind === 'target_test_result') {
    if (!subject.command || projection.commandDigest !== identityHash({ executable: subject.command.executable, args: subject.command.args, shell: false })
      || projection.selectorDigest !== identityHash(subject.command.selector)) throw new Error('progress: test command/selector subject mismatch');
  } else if (!subject.targetChecklistItemRefs.includes(projection.itemId) || projection.itemId !== target.responsibility.workItemRef) throw new Error('progress: delivery/status item subject mismatch');
  if (projection.kind === 'target_status_transition' && projection.transitionPolicyDigest !== identityHash(['pending', 'in_progress', 'done'])) throw new Error('progress: unsupported status transition policy');
}
export function validateBaseline(value: unknown): asserts value is ProgressBaseline {
  const row = parseIdentityInput(baselineSchema, value); assertCanonicalSubject(row.subject);
  if (Date.parse(row.capturedAt) > Date.now()) throw new Error('progress: future baseline capture');
  const { baselineHash, ...rest } = row;
  if (identityHash(value) !== identityHash(row) || identityHash(rest) !== baselineHash) throw new Error('progress: baseline hash mismatch');
  if (row.projectionState === 'present') {
    if (!row.projection || row.projection.kind !== row.kind || row.absenceDigest || row.projectionDigest !== identityHash(semanticProjection(row.projection))) throw new Error('progress: invalid present projection');
    assertProjectionSubject(row.projection, row.subject, row.targetSnapshot);
  } else if (row.projection || row.projectionDigest || row.absenceDigest !== absenceDigest(row)) throw new Error('progress: invalid signed absence');
  if (row.signedBy !== row.targetSnapshot.owner.identity || row.signedByAuthority !== row.targetSnapshot.owner.authority) throw new Error('progress: target signer mismatch');
}
export const baselineSetSchema = z.object({ ...base, evidenceAuthority: baselineAuthority, baselineSetId: routeText,
  baselines: z.array(z.record(z.string(), z.unknown())).length(4), baselineSetHash: routeHash }).strict();
export type BaselineSet = z.infer<typeof baselineSetSchema>;
export function validateBaselineSet(value: unknown, trust: FindingLedgerReceiptTrust): asserts value is BaselineSet {
  const row = parseIdentityInput(baselineSetSchema, value); const { baselineSetHash, ...rest } = row;
  if (identityHash(row) !== identityHash(value) || identityHash(rest) !== baselineSetHash) throw new Error('progress: baseline set hash mismatch');
  if (row.signedBy !== row.targetSnapshot.owner.identity || row.signedByAuthority !== row.targetSnapshot.owner.authority) throw new Error('progress: set signer mismatch');
  row.baselines.forEach((envelope, index) => {
    verifyIdentityEnvelope(envelope, trust, validateBaseline); const entry = envelope.payload as unknown as ProgressBaseline;
    if (envelope.kind !== 'progress_baseline' || entry.kind !== PROGRESS_KINDS[index] || entry.routeReceiptId !== row.routeReceiptId
      || entry.routeSubjectDigest !== row.routeSubjectDigest || entry.canonicalDefectId !== row.canonicalDefectId || entry.capturedAt !== row.capturedAt
      || envelope.storyId !== row.targetSnapshot.id || envelope.producedAt !== row.capturedAt
      || identityHash(entry.derivedBy) !== identityHash(row.derivedBy) || entry.signedBy !== row.signedBy || entry.signedByAuthority !== row.signedByAuthority
      || identityHash(entry.targetSnapshot) !== identityHash(row.targetSnapshot) || identityHash(entry.subject) !== identityHash(row.subject)) throw new Error('progress: baseline set kind/subject/capture mismatch');
  });
}
export const targetEvidenceSchema = z.object({ ...base, kind: progressKindSchema, projection: projectionSchema }).strict();
export const progressBindingSchema = z.object({ ...base, kind: progressKindSchema, projection: projectionSchema, projectionDigest: routeHash,
  predecessor: ledgerRefSchema, previousDeferralRef: ledgerRefSchema, predecessorBaselineDigest: routeHash, predecessorProjectionDigest: routeHash,
  evidence: z.record(z.string(), z.unknown()), tupleDigest: routeHash }).strict();
export type ProgressBinding = z.infer<typeof progressBindingSchema>;
export const progressCaptureSchema = z.object({ storyId: routeText, idempotencyKey: routeText, receipt: ledgerRefSchema,
  kind: progressKindSchema, predecessor: ledgerRefSchema, previousDeferralRef: ledgerRefSchema,
  executionKey: routeText.optional() }).strict();
/** Neutral reference only. A future deferral consumer must independently prove
 * sourceRecord is its exact preceding canonical deferral; this port cannot. */
export const progressPredecessorRequestSchema = z.object({ storyId: routeText, idempotencyKey: routeText,
  sourceRecord: ledgerRefSchema, routeReceiptRef: ledgerRefSchema, baselineSetRef: ledgerRefSchema }).strict();
export const progressPredecessorSchema = z.object({ schemaVersion: z.literal(1), authority: z.literal('non_authoritative'), gateEvidence: z.literal(false),
  sourceRecord: ledgerRefSchema, routeReceiptRef: ledgerRefSchema, baselineSetRef: ledgerRefSchema,
  canonicalDefectId: routeText, routeReceiptId: routeText, routeSubjectDigest: routeHash,
  createdAt: routeTime, sourceOwner: routeText, sourceLeaseDigest: routeHash, bindingHash: routeHash }).strict();
export type ProgressPredecessor = z.infer<typeof progressPredecessorSchema>;
export function validateProgressPredecessor(value: unknown): asserts value is ProgressPredecessor {
  const row = parseIdentityInput(progressPredecessorSchema, value); const { bindingHash, ...base } = row;
  if (identityHash(row) !== identityHash(value) || identityHash(base) !== bindingHash
    || row.routeReceiptRef.storyId !== row.baselineSetRef.storyId || row.sourceRecord.storyId === row.routeReceiptRef.storyId) throw new Error('progress: invalid neutral source predecessor binding');
}
export function validateProgress(value: unknown, trust: FindingLedgerReceiptTrust): asserts value is ProgressBinding {
  const row = parseIdentityInput(progressBindingSchema, value); const { tupleDigest, ...rest } = row;
  if (Date.parse(row.capturedAt) > Date.now()) throw new Error('progress: future progress capture');
  if (identityHash(value) !== identityHash(row) || identityHash(rest) !== tupleDigest) throw new Error('progress: binding digest mismatch');
  assertCanonicalSubject(row.subject);
  verifyIdentityEnvelope(row.evidence, trust, value => {
    const evidence = parseIdentityInput(targetEvidenceSchema, value);
    if (identityHash(evidence) !== identityHash(value)) throw new Error('progress: noncanonical nested evidence');
    assertProjectionSubject(evidence.projection, evidence.subject, evidence.targetSnapshot);
  });
  const evidence = row.evidence as unknown as IdentitySemanticEnvelope<z.infer<typeof targetEvidenceSchema>>;
  assertProjectionSubject(row.projection, row.subject, row.targetSnapshot);
  if (evidence.kind !== 'target_progress_evidence' || evidence.storyId !== row.targetSnapshot.id || evidence.producedAt !== row.capturedAt
    || identityHash(evidence.payload.projection) !== identityHash(row.projection) || evidence.payload.canonicalDefectId !== row.canonicalDefectId
    || evidence.payload.routeReceiptId !== row.routeReceiptId || evidence.payload.routeSubjectDigest !== row.routeSubjectDigest
    || row.signedBy !== row.targetSnapshot.owner.identity || row.signedByAuthority !== row.targetSnapshot.owner.authority
    || evidence.payload.signedBy !== row.signedBy || evidence.payload.signedByAuthority !== row.signedByAuthority || evidence.payload.kind !== row.kind
    || evidence.payload.capturedAt !== row.capturedAt || identityHash(evidence.payload.derivedBy) !== identityHash(row.derivedBy)
    || identityHash(evidence.payload.subject) !== identityHash(row.subject) || identityHash(evidence.payload.targetSnapshot) !== identityHash(row.targetSnapshot)
    || row.projection.kind !== row.kind || row.projectionDigest !== identityHash(semanticProjection(row.projection))) throw new Error('progress: nested target subject mismatch');
}
export function assertProgressTransition(before: ProgressBaseline, after: ProgressBinding): void {
  validateBaseline(before);
  assertProjectionSubject(after.projection, after.subject, after.targetSnapshot);
  if (before.kind !== after.kind || before.baselineHash !== after.predecessorBaselineDigest
    || (before.projectionDigest ?? before.absenceDigest) !== after.predecessorProjectionDigest
    || before.canonicalDefectId !== after.canonicalDefectId || before.routeSubjectDigest !== after.routeSubjectDigest
    || identityHash(before.subject) !== identityHash(after.subject) || before.targetSnapshot.id !== after.targetSnapshot.id
    || before.targetSnapshot.scopeDigest !== after.targetSnapshot.scopeDigest || Date.parse(after.capturedAt) <= Date.parse(before.capturedAt)) throw new Error('progress: wrong/stale same-kind predecessor');
  if (before.projectionDigest === after.projectionDigest) throw new Error('progress: no semantic progress');
  if (after.projection.kind === 'target_delivery_state' && after.projection.signedState !== 'done') throw new Error('progress: delivery completion required');
  if (after.projection.kind === 'target_status_transition') {
    const rank = { pending: 0, in_progress: 1, done: 2 };
    if (after.projection.itemId !== before.targetSnapshot.responsibility.workItemRef
      || rank[after.projection.state] <= rank[before.targetSnapshot.responsibility.state]) throw new Error('progress: status regression/no-op from signed initial work-item state');
  }
  if (after.projection.kind === 'target_test_result' && (after.projection.outcome !== 'pass'
    || (before.projection?.kind === 'target_test_result' && (before.projection.commandDigest !== after.projection.commandDigest || before.projection.selectorDigest !== after.projection.selectorDigest)))) throw new Error('progress: wrong command/selector or test regression');
  if (after.projection.kind === 'target_source_change' && (identityHash(after.projection.sourcePaths) !== identityHash(after.subject.sourcePaths)
    || identityHash(after.projection.affectedContractRefs) !== identityHash(after.subject.affectedContractRefs))) throw new Error('progress: source subject mismatch');
  if (before.projection?.kind === 'target_status_transition' && after.projection.kind === 'target_status_transition') {
    const rank = { pending: 0, in_progress: 1, done: 2 };
    if (before.projection.itemId !== after.projection.itemId || rank[after.projection.state] <= rank[before.projection.state]) throw new Error('progress: status regression/no-op');
  }
  if (before.projection?.kind === 'target_delivery_state' && after.projection.kind === 'target_delivery_state'
    && (before.projection.itemId !== after.projection.itemId || after.projection.signedState !== 'done')) throw new Error('progress: delivery regression');
}
