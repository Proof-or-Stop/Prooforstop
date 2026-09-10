/** Pure target-consent contracts; none grant Finding or lifecycle authority. */
import { z } from 'zod';
import { identityHash, parseIdentityInput, sortedUnique } from './finding-identity.js';

export const routeText = z.string().trim().min(1);
export const routeHash = z.string().regex(/^[a-f0-9]{64}$/);
export const routeTime = z.string().datetime();
const texts = z.array(routeText).min(1);
export const ledgerRefSchema = z.object({ storyId: routeText, recordId: routeText, recordHash: routeHash }).strict();
export const routeSourceSchema = z.discriminatedUnion('subjectKind', [
  z.object({ ...ledgerRefSchema.shape, subjectKind: z.literal('candidate_finding'), subjectId: routeText, subjectHash: routeHash }).strict(),
  z.object({ ...ledgerRefSchema.shape, subjectKind: z.literal('finding_assessment_proposal'), subjectId: routeText, subjectHash: routeHash }).strict(),
]);
export const targetSnapshotSchema = z.object({ kind: z.enum(['existing_story', 'b_meta_gap']), id: routeText,
  state: routeText, scopeDigest: routeHash, headHash: routeText, materialHash: routeHash, storyFilesHash: routeHash,
  responsibility: z.object({ workItemRef: routeText, workItemHash: routeHash, state: z.enum(['pending', 'in_progress', 'done']) }).strict(), stateDigest: routeHash,
  owner: z.object({ identity: routeText, authority: z.enum(['target_story_owner', 'b_meta_canonical_audit']), leaseId: routeText,
    leaseDigest: routeHash, authorityPolicyVersion: routeText }).strict(), policyDigest: routeHash }).strict();
export const routeSubjectSchema = z.object({ affectedContractRefs: texts, targetChecklistItemRefs: texts,
  targetAcceptanceRefs: z.array(routeText), sourcePaths: z.array(routeText),
  command: z.object({ executable: routeText, args: z.array(z.string()), selector: routeText }).strict().optional() }).strict();
export const routeProfileSchema = z.enum(['candidate_route', 'finding_route']);
export const routeRequestSchema = z.object({ storyId: routeText, idempotencyKey: routeText, source: routeSourceSchema,
  targetItemId: routeText, subject: routeSubjectSchema, expiresAt: routeTime,
  canonicalDefect: ledgerRefSchema.optional(), predecessor: ledgerRefSchema.optional(), progress: ledgerRefSchema.optional() }).strict();
export const routeRevokeSchema = z.object({ storyId: routeText, idempotencyKey: routeText, receipt: ledgerRefSchema,
  reason: z.enum(['owner_changed', 'target_closed_unfixed', 'target_scope_changed', 'policy_changed', 'target_rejected']) }).strict();
export const routeVerifySchema = z.object({ storyId: routeText, receipt: ledgerRefSchema }).strict();
export const routeRecallBindingsSchema = z.object({ schemaVersion: z.literal(1), targetCreatedAt: routeTime.optional(),
  targetStartedAt: routeTime.optional(), targetPhase: routeText,
  sourceSeverity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  sourcePathsDigest: routeHash, sourceOriginPaths: z.array(routeText), sourceOriginDigest: routeHash,
  runtimeReferenceAuthority: z.literal('persistence_only'), runtimeRefs: z.array(ledgerRefSchema) }).strict();
export const routeReceiptSchema = z.object({ schemaVersion: z.literal(1), authority: z.literal('non_authoritative'), gateEvidence: z.literal(false),
  evidenceAuthority: z.object({ profile: routeProfileSchema, authority: z.literal('target_route_semantic_only'), gateEvidence: z.literal(false) }).strict(),
  routeReceiptId: routeText, source: routeSourceSchema, target: targetSnapshotSchema, subject: routeSubjectSchema,
  decision: z.enum(['accepted', 'rejected']), acceptedAt: routeTime.optional(), rejectedAt: routeTime.optional(), expiresAt: routeTime,
  revokedAt: routeTime.optional(), revocationReason: routeRevokeSchema.shape.reason.optional(), supersedesRouteReceiptId: routeText.optional(),
  predecessor: ledgerRefSchema.optional(), canonicalDefect: ledgerRefSchema.optional(), routeSubjectDigest: routeHash,
  visitedTargetDigests: texts, routeChainDigest: routeHash, policyDigest: routeHash, signedBy: routeText,
  signedByAuthority: targetSnapshotSchema.shape.owner.shape.authority,
  initialProgressBaselineSet: z.object({ baselineSetId: routeText, baselineSetHash: routeHash }).strict().optional(),
  progress: ledgerRefSchema.optional(), recallBindings: routeRecallBindingsSchema.optional(), receiptHash: routeHash }).strict();
export type RouteSource = z.infer<typeof routeSourceSchema>;
export type TargetSnapshot = z.infer<typeof targetSnapshotSchema>;
export type RouteSubject = z.infer<typeof routeSubjectSchema>;
export type RouteReceipt = z.infer<typeof routeReceiptSchema>;
export type IdentityLedgerRef = z.infer<typeof ledgerRefSchema>;
export function assertCanonicalSubject(subject: RouteSubject): void {
  for (const list of [subject.affectedContractRefs, subject.targetChecklistItemRefs, subject.targetAcceptanceRefs, subject.sourcePaths]) {
    if (identityHash(list) !== identityHash(sortedUnique(list))) throw new Error('route: noncanonical subject order');
  }
}
export function receiptSubjectDigest(receipt: Omit<RouteReceipt, 'routeSubjectDigest' | 'receiptHash'> | RouteReceipt): string {
  const { initialProgressBaselineSet: _baseline, progress: _progress, routeSubjectDigest: _subject, receiptHash: _hash, ...domain } = receipt as RouteReceipt;
  return identityHash(domain);
}
export function validateRouteReceipt(value: unknown): asserts value is RouteReceipt {
  const row = parseIdentityInput(routeReceiptSchema, value); assertCanonicalSubject(row.subject);
  if (identityHash(row) !== identityHash(value)) throw new Error('route: noncanonical signed fields');
  const { receiptHash, ...base } = row;
  if (identityHash(base) !== receiptHash || row.routeSubjectDigest !== receiptSubjectDigest(row)) throw new Error('route: receipt digest mismatch');
  if ((row.decision === 'accepted') !== !!row.acceptedAt || (row.decision === 'rejected') !== !!row.rejectedAt) throw new Error('route: decision timestamp mismatch');
  if (!!row.revokedAt !== !!row.revocationReason || (row.revokedAt && (!row.predecessor || !row.supersedesRouteReceiptId))) throw new Error('route: revocation predecessor required');
  if (!!row.predecessor !== !!row.supersedesRouteReceiptId) throw new Error('route: receipt predecessor mismatch');
  if (Date.parse(row.expiresAt) <= Date.parse(row.acceptedAt ?? row.rejectedAt!)) throw new Error('route: nonpositive expiry');
  if ((row.evidenceAuthority.profile === 'candidate_route') !== (row.source.subjectKind === 'candidate_finding')) throw new Error('route: source profile mismatch');
  if (row.evidenceAuthority.profile === 'candidate_route' && (row.initialProgressBaselineSet || row.progress || row.canonicalDefect)) throw new Error('route: candidate receipt cannot carry finding baseline/progress');
  if (row.evidenceAuthority.profile === 'finding_route' && row.decision === 'accepted' && (!row.canonicalDefect || (!row.predecessor && !row.initialProgressBaselineSet))) throw new Error('route: initial finding baseline missing');
  if (row.predecessor && row.initialProgressBaselineSet) throw new Error('route: renewal cannot create initial baseline');
  if (row.progress && (!row.predecessor || row.decision !== 'accepted')) throw new Error('route: invalid progress attachment');
  if (new Set(row.visitedTargetDigests).size !== row.visitedTargetDigests.length) throw new Error('route: forwarding cycle');
  if (row.policyDigest !== row.target.policyDigest || row.signedBy !== row.target.owner.identity || row.signedByAuthority !== row.target.owner.authority) throw new Error('route: signer target mismatch');
}
export function sealRouteReceipt(input: Omit<RouteReceipt, 'receiptHash'>): RouteReceipt {
  const row = { ...input, receiptHash: identityHash(input) }; validateRouteReceipt(row); return row;
}
export function assertReceiptCurrent(receipt: RouteReceipt, snapshot: TargetSnapshot, now = Date.now()): void {
  validateRouteReceipt(receipt);
  if (receipt.decision !== 'accepted' || receipt.revokedAt || now >= Date.parse(receipt.expiresAt)) throw new Error('route: consent rejected/revoked/expired');
  if (Date.parse(receipt.acceptedAt!) > now || identityHash(snapshot) !== identityHash(receipt.target)) throw new Error('route: stale target owner/policy/scope/state/source snapshot');
}
export const candidateRouteRequestSchema = z.object({ storyId: routeText, idempotencyKey: routeText, candidate: routeSourceSchema,
  receipt: ledgerRefSchema, uncertaintyReason: routeText, evidenceRefs: texts, severity: z.enum(['low', 'medium']),
  recheckTriggers: texts }).strict();
export const candidateRouteSchema = z.object({ schemaVersion: z.literal(1), authority: z.literal('non_authoritative'), gateEvidence: z.literal(false),
  candidateRouteId: routeText, source: routeSourceSchema, receipt: ledgerRefSchema, routeReceiptId: routeText, routeReceiptHash: routeHash,
  routeReceiptProfile: z.literal('candidate_route'), targetId: routeText, targetOwner: routeText,
  uncertaintyReason: routeText, evidenceRefs: texts, severity: z.enum(['low', 'medium']), recheckTriggers: texts,
  visitedTargetDigests: texts, createdAt: routeTime, expiresAt: routeTime, currentProjectionHash: routeHash }).strict();
export function validateCandidateRoute(value: unknown): void {
  const row = parseIdentityInput(candidateRouteSchema, value); const { currentProjectionHash, ...base } = row;
  if (identityHash(row) !== identityHash(value) || identityHash(base) !== currentProjectionHash || row.source.subjectKind !== 'candidate_finding') throw new Error('route: invalid candidate route');
}
