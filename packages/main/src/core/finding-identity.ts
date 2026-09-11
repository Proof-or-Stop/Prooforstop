/** Pure candidate normalization, immutable state transitions and strict signing. */
import { z } from 'zod';
import type { FindingLedgerSigner, FindingLedgerReceiptTrust } from './finding-ledger.js';
import { canonicalDigest, signCanonical, verifyCanonical } from './authority-signing.js';
import type { CandidateFinding, CandidateReproductionAttestation, CandidateReproductionContract, CanonicalDefect, DetectorSignal, FindingIdentityRef, IdentitySemanticEnvelope, IdentitySourceAnchor } from './finding-identity-types.js';

const text = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const headHash = z.string().regex(/^[a-f0-9]{40,64}$/);
const texts = z.array(text).min(1);
export const CANDIDATE_REPRODUCTION_MARKER_TOKEN = '{{candidateMarker}}';
export const candidateReproductionContractSchema = z.object({
  executable: text,
  argsTemplate: z.array(z.string()).min(1),
  selector: text,
}).strict().superRefine((contract, context) => {
  const occurrences = contract.argsTemplate.reduce((count, arg) => count + arg.split(CANDIDATE_REPRODUCTION_MARKER_TOKEN).length - 1, 0);
  if (occurrences !== 1) context.addIssue({ code: z.ZodIssueCode.custom, message: 'reproduction contract requires exactly one candidate marker token' });
  if (contract.selector.includes(CANDIDATE_REPRODUCTION_MARKER_TOKEN)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'reproduction selector must be candidate-independent' });
});
export const identityAnchorSchema = z.object({ path: text, contentDigest: hash, line: z.number().int().positive().optional(), symbol: text.optional() }).strict();
const anchors = z.array(identityAnchorSchema).min(1);
const authority = { authority: z.literal('non_authoritative'), gateEvidence: z.literal(false) };
export const findingIdentityRefSchema = z.object({ storyId: text, findingId: text, recordId: text, recordHash: hash }).strict();
export const detectorSignalSchema = z.object({
  schemaVersion: z.literal(1), ...authority, signalId: text, detectorId: text, detectorVersion: text,
  observedAt: z.string().datetime(), targetStoryId: text, headHash, materialHash: hash,
  sourceIds: texts, sourceLineageKeys: texts, outputDigest: hash, matchCount: z.number().int().nonnegative(), anchors, rawCategory: text,
}).strict();
export const candidateFindingSchema = z.object({
  schemaVersion: z.literal(1), ...authority, candidateId: text, targetStoryId: text, sourceSignalIds: texts,
  sourceLineageKeys: texts, suspectedDefect: text, affectedSymbols: z.array(text), affectedContracts: texts,
  candidateGroupKey: hash, state: z.enum(['pending_verification', 'merged', 'disproven', 'promoted']),
  previousVersionHash: hash.optional(), currentProjectionHash: hash, currentEvidenceRefs: texts, sourceBindings: anchors,
  reproductionContract: candidateReproductionContractSchema.optional(),
  mergedIntoCandidateId: text.optional(), promotionFindingRef: findingIdentityRefSchema.optional(),
  decision: z.object({ reason: text, evidenceRefs: texts, evidenceAnchors: anchors }).strict().optional(),
}).strict();
const inputSignal = z.object({ detectorId: text, detectorVersion: text, sourceIds: texts, outputDigest: hash,
  matchCount: z.number().int().nonnegative(), anchors, rawCategory: text }).strict();
const candidateInput = z.object({ suspectedDefect: text, affectedSymbols: z.array(text), affectedContracts: texts, evidenceRefs: texts,
  reproductionContract: candidateReproductionContractSchema }).strict();
const request = { storyId: text, idempotencyKey: text };
const expected = { candidateId: text, expectedCandidateHash: hash };
export const candidateAddSchema = z.object({ ...request, signal: inputSignal, candidate: candidateInput }).strict();
export const candidateGetSchema = z.object({ storyId: text, candidateId: text.optional() }).strict();
export const candidateMergeSchema = z.object({ ...request, ...expected, targetCandidateId: text, expectedTargetHash: hash,
  reason: text, evidenceRefs: texts, evidenceAnchors: anchors }).strict();
export const candidateDisproveSchema = z.object({ ...request, ...expected, reason: text, evidenceRefs: texts, evidenceAnchors: anchors }).strict();
export const candidateReproductionAttestationInputSchema = z.object({
  selector: text,
  semanticAssertion: z.string().trim().min(20),
}).strict();
export const candidatePromoteSchema = z.object({ ...request, ...expected, findingId: text, reviewRunId: text,
  reproductionExecutionKey: text, reproductionReceiptHash: hash,
  reproductionAttestation: candidateReproductionAttestationInputSchema,
}).strict();
export const candidateReproductionAttestationSchema = z.object({
  schemaVersion: z.literal(1), ...authority, attestationId: text, targetStoryId: text, candidateId: text,
  candidateProjectionHash: hash, reproductionContract: candidateReproductionContractSchema,
  reproductionContractHash: hash, reproductionSelector: text, reproductionExecutionKey: text,
  reproductionReceiptHash: hash, findingRef: findingIdentityRefSchema, reviewRunId: text, reviewer: text,
  semanticAssertion: z.string().trim().min(20), evidenceAnchors: anchors, attestedAt: z.string().datetime(),
}).strict();
export function materializeCandidateReproductionCommand(contract: CandidateReproductionContract, marker: string): { executable: string; args: string[] } {
  const parsed = parseIdentityInput(candidateReproductionContractSchema, contract);
  return { executable: parsed.executable, args: parsed.argsTemplate.map(arg => arg.replace(CANDIDATE_REPRODUCTION_MARKER_TOKEN, marker)) };
}
export type CandidateAddInput = z.infer<typeof candidateAddSchema>;
const canonicalInputFields = { title: text, triggerCondition: text, reproduction: text,
  rootCauseState: z.enum(['unknown', 'hypothesized', 'confirmed']), rootCause: text.optional(),
  identityEvidenceRefs: texts, evidenceAnchors: anchors, affectedSymbols: z.array(text), affectedContracts: texts,
  memberFindingRefs: z.array(findingIdentityRefSchema).min(1), canonicalFindingRef: findingIdentityRefSchema };
export const identityConfirmSchema = z.object({ ...request, ...canonicalInputFields, reviewRunId: text }).strict();
export const identityQuerySchema = z.object({ storyId: text, canonicalDefectId: text.optional(), includeSuperseded: z.boolean().optional() }).strict();
export const canonicalDefectSchema = z.object({ schemaVersion: z.literal(1), ...authority, ...canonicalInputFields,
  canonicalDefectId: text, identityState: z.literal('reviewer_confirmed'), confirmedBy: text, confirmedAt: z.string().datetime(),
  reviewRunId: text, sourceLineageKeys: texts, identityDigest: hash, currentProjectionHash: hash }).strict();
export function assertCauseEvidence(value: Pick<CanonicalDefect, 'rootCauseState' | 'rootCause' | 'triggerCondition' | 'reproduction' | 'identityEvidenceRefs' | 'affectedContracts'>): void {
  if (!value.triggerCondition.trim() || !value.reproduction.trim() || !value.identityEvidenceRefs.length || !value.affectedContracts.length) throw new Error('identity: empty identity evidence');
  if ((value.rootCauseState === 'unknown') !== (value.rootCause === undefined)) throw new Error('identity: cause state mismatch');
  if (value.rootCause !== undefined && /^(unknown|n\/?a|none|tbd|todo|placeholder|unspecified|not known|\?)$/i.test(value.rootCause.trim())) throw new Error('identity: fabricated cause placeholder');
}
export function canonicalIdentityDigest(value: Pick<CanonicalDefect, 'triggerCondition' | 'reproduction' | 'affectedContracts' | 'memberFindingRefs'>): string {
  return identityHash({ triggerCondition: value.triggerCondition, reproduction: value.reproduction, affectedContracts: value.affectedContracts, memberFindingRefs: value.memberFindingRefs });
}
export function validateCanonicalDefect(value: unknown): asserts value is CanonicalDefect {
  const row = parseIdentityInput(canonicalDefectSchema, value); assertCauseEvidence(row);
  if (identityHash(value) !== identityHash(row)) throw new Error('identity: noncanonical defect bytes');
  const { currentProjectionHash, ...base } = row;
  if (identityHash(base) !== currentProjectionHash || canonicalIdentityDigest(row) !== row.identityDigest) throw new Error('identity: canonical digest mismatch');
  const ids = row.memberFindingRefs.map(ref => ref.recordId);
  if (new Set(ids).size !== ids.length || identityHash(ids) !== identityHash([...ids].sort())
    || !row.memberFindingRefs.some(ref => identityHash(ref) === identityHash(row.canonicalFindingRef))) throw new Error('identity: invalid canonical members');
}

/** Pure confirmation construction; the caller must first verify reviewer/source authority. */
export function buildConfirmedCanonicalDefect(input: z.infer<typeof identityConfirmSchema>, confirmation: {
  canonicalDefectId: string; confirmedBy: string; confirmedAt: string; sourceLineageKeys: readonly string[];
}): CanonicalDefect {
  const args = parseIdentityInput(identityConfirmSchema, input); assertCauseEvidence(args);
  const refs = [...args.memberFindingRefs].sort((a, b) => a.recordId.localeCompare(b.recordId));
  const fields = { title: args.title, triggerCondition: args.triggerCondition, reproduction: args.reproduction,
    rootCauseState: args.rootCauseState, ...(args.rootCause ? { rootCause: args.rootCause } : {}), identityEvidenceRefs: sortedUnique(args.identityEvidenceRefs),
    evidenceAnchors: args.evidenceAnchors, affectedSymbols: sortedUnique(args.affectedSymbols), affectedContracts: sortedUnique(args.affectedContracts),
    memberFindingRefs: refs, canonicalFindingRef: args.canonicalFindingRef };
  const base = { schemaVersion: 1 as const, authority: 'non_authoritative' as const, gateEvidence: false as const, ...fields,
    canonicalDefectId: confirmation.canonicalDefectId, identityState: 'reviewer_confirmed' as const, confirmedBy: confirmation.confirmedBy,
    confirmedAt: confirmation.confirmedAt, reviewRunId: args.reviewRunId,
    sourceLineageKeys: sortedUnique([...confirmation.sourceLineageKeys, ...refs.map(ref => identityHash({ storyId: ref.storyId, recordId: ref.recordId }))]),
    identityDigest: canonicalIdentityDigest(fields) };
  const canonical = { ...base, currentProjectionHash: identityHash(base) }; validateCanonicalDefect(canonical); return canonical;
}

/** Projection never confirms suggestions: every input must already be a confirmed identity. */
export function projectConfirmedIdentityGroups(defects: readonly CanonicalDefect[]) {
  const members = new Set<string>(); const identities = new Set<string>();
  return [...defects].sort((a, b) => a.canonicalDefectId.localeCompare(b.canonicalDefectId)).map(defect => {
    validateCanonicalDefect(defect);
    if (identities.has(defect.canonicalDefectId)) throw new Error('identity: duplicate canonical identity'); identities.add(defect.canonicalDefectId);
    for (const ref of defect.memberFindingRefs) {
      if (members.has(ref.recordId)) throw new Error('identity: conflicting confirmed membership'); members.add(ref.recordId);
    }
    return { canonicalDefectId: defect.canonicalDefectId, memberFindingRefs: [...defect.memberFindingRefs], sourceLineageKeys: [...defect.sourceLineageKeys],
      authority: 'non_authoritative' as const, gateEvidence: false as const };
  });
}

/** Reject representations the signing canonicalizer would erase or coerce. */
export function assertIdentityJson(value: unknown): void {
  if (value === null || value === undefined) throw new Error('identity: null/undefined fields are forbidden');
  if (typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error('identity: sparse/decorated array refused');
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('identity: sparse/accessor array refused');
      assertIdentityJson(value[index]);
    }
    return;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('identity: plain JSON objects required');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
      || !('value' in Object.getOwnPropertyDescriptor(value, key)!)) throw new Error('identity: non-JSON property refused');
    assertIdentityJson((value as Record<string, unknown>)[key]);
  }
}
export function identityHash(value: unknown): string { assertIdentityJson(value); return canonicalDigest(value); }
const canonicalHash = identityHash;
export function parseIdentityInput<T>(schema: z.ZodType<T>, value: unknown): T {
  assertIdentityJson(value);
  return schema.parse(value);
}
export const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();
export function candidateSuggestionKey(input: Pick<CandidateFinding, 'affectedContracts' | 'affectedSymbols'>): string {
  return canonicalHash({ contracts: sortedUnique(input.affectedContracts), symbols: sortedUnique(input.affectedSymbols) });
}
export function sourceLineageKeys(signal: Pick<DetectorSignal, 'detectorId' | 'detectorVersion' | 'sourceIds' | 'outputDigest' | 'headHash'>): string[] {
  return sortedUnique(signal.sourceIds.map(sourceId => canonicalHash({ sourceId, detectorId: signal.detectorId,
    detectorVersion: signal.detectorVersion, outputDigest: signal.outputDigest, headHash: signal.headHash })));
}
export function sealCandidate(input: Omit<CandidateFinding, 'currentProjectionHash'>): CandidateFinding {
  const candidate = { ...input, currentProjectionHash: canonicalHash(input) };
  validateCandidate(candidate);
  return candidate;
}
export function validateCandidate(value: unknown): asserts value is CandidateFinding {
  const row = parseIdentityInput(candidateFindingSchema, value);
  if (canonicalHash(row) !== canonicalHash(value)) throw new Error('identity: noncanonical candidate fields');
  const { currentProjectionHash, ...core } = row;
  if (canonicalHash(core) !== currentProjectionHash) throw new Error('identity: candidate projection hash mismatch');
  if (row.candidateGroupKey !== candidateSuggestionKey(row)) throw new Error('identity: suggestion key mismatch');
  if (row.state === 'pending_verification' && (row.promotionFindingRef || row.mergedIntoCandidateId || row.decision)) throw new Error('identity: pending state contains terminal fields');
  if (row.state !== 'pending_verification' && (!row.previousVersionHash || !row.decision)) throw new Error('identity: terminal state missing predecessor/evidence');
  if ((row.state === 'promoted') !== !!row.promotionFindingRef || (row.state === 'merged') !== !!row.mergedIntoCandidateId) throw new Error('identity: state/terminal fields mismatch');
}
export function validateCandidateReproductionAttestation(value: unknown): asserts value is CandidateReproductionAttestation {
  const row = parseIdentityInput(candidateReproductionAttestationSchema, value);
  if (canonicalHash(row) !== canonicalHash(value)) throw new Error('identity: noncanonical candidate reproduction attestation fields');
  if (row.reproductionContractHash !== canonicalHash(row.reproductionContract)
    || row.reproductionSelector !== row.reproductionContract.selector
    || row.targetStoryId !== row.findingRef.storyId) throw new Error('identity: candidate reproduction attestation contract mismatch');
}
export function validateSignal(value: unknown): asserts value is DetectorSignal {
  const signal = parseIdentityInput(detectorSignalSchema, value);
  if (canonicalHash(signal) !== canonicalHash(value)) throw new Error('identity: noncanonical signal fields');
  if (canonicalHash(signal.sourceLineageKeys) !== canonicalHash(sourceLineageKeys(signal))) throw new Error('identity: source lineage mismatch');
}
export function transitionCandidate(candidate: CandidateFinding, state: 'merged' | 'disproven' | 'promoted',
  decision: { reason: string; evidenceRefs: string[]; evidenceAnchors: readonly IdentitySourceAnchor[] }, extra: { mergedIntoCandidateId?: string; promotionFindingRef?: FindingIdentityRef } = {}): CandidateFinding {
  validateCandidate(candidate);
  if (candidate.state !== 'pending_verification') throw new Error('identity: unsupported terminal transition');
  const { currentProjectionHash, ...base } = candidate;
  return sealCandidate({ ...base, state, previousVersionHash: currentProjectionHash, decision, ...extra,
    currentEvidenceRefs: sortedUnique([...candidate.currentEvidenceRefs, ...decision.evidenceRefs]) });
}
const semanticEnvelopeSchema = z.object({ schemaVersion: z.literal(1), ...authority, kind: text, storyId: text,
  requestDigest: hash, producedAt: z.string().datetime(), payload: z.record(z.string(), z.unknown()), payloadDigest: hash,
  keyId: text, algorithm: z.literal('ed25519'), trustRootDigest: hash, keyFreshnessPolicyDigest: hash, signature: text }).strict();
export function signIdentityEnvelope<T extends object>(input: { kind: string; storyId: string; requestDigest: string; producedAt: string; payload: T },
  signer: FindingLedgerSigner, validate: (payload: unknown) => void): IdentitySemanticEnvelope<T> {
  assertIdentityJson(input); validate(input.payload);
  const unsigned = { schemaVersion: 1 as const, authority: 'non_authoritative' as const, gateEvidence: false as const,
    ...input, payloadDigest: canonicalHash(input.payload), keyId: signer.keyId, algorithm: 'ed25519' as const,
    trustRootDigest: signer.trustRootDigest, keyFreshnessPolicyDigest: signer.keyFreshnessPolicyDigest };
  return { ...unsigned, signature: signCanonical(unsigned, signer.privateKey) };
}
export function verifyIdentityEnvelope(value: unknown, trust: FindingLedgerReceiptTrust, validate: (payload: unknown) => void): asserts value is IdentitySemanticEnvelope {
  const row = parseIdentityInput(semanticEnvelopeSchema, value); validate(row.payload);
  if (canonicalHash(row) !== canonicalHash(value)) throw new Error('identity: noncanonical envelope fields');
  const { signature, ...unsigned } = row;
  if (row.payloadDigest !== canonicalHash(row.payload) || row.keyId !== trust.keyId || row.algorithm !== trust.algorithm
    || row.trustRootDigest !== trust.trustRootDigest || row.keyFreshnessPolicyDigest !== trust.keyFreshnessPolicyDigest
    || !verifyCanonical(unsigned, signature, trust.publicKey)) throw new Error('identity: semantic signature invalid');
}
