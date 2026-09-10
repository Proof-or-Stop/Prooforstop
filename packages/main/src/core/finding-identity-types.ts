/** Story 2 data contracts. Every record is additive and non-gate. */
export interface IdentityAuthority {
  readonly authority: 'non_authoritative';
  readonly gateEvidence: false;
}
export interface FindingIdentityRef {
  readonly storyId: string;
  readonly findingId: string;
  readonly recordId: string;
  readonly recordHash: string;
}
export interface IdentitySourceAnchor {
  readonly path: string;
  readonly contentDigest: string;
  readonly line?: number;
  readonly symbol?: string;
}
export interface CandidateReproductionContract {
  readonly executable: string;
  readonly argsTemplate: readonly string[];
  readonly selector: string;
}
export interface DetectorSignal extends IdentityAuthority {
  readonly schemaVersion: 1;
  readonly signalId: string;
  readonly detectorId: string;
  readonly detectorVersion: string;
  readonly observedAt: string;
  readonly targetStoryId: string;
  readonly headHash: string;
  readonly materialHash: string;
  readonly sourceIds: readonly string[];
  readonly sourceLineageKeys: readonly string[];
  readonly outputDigest: string;
  readonly matchCount: number;
  readonly anchors: readonly IdentitySourceAnchor[];
  readonly rawCategory: string;
}
export interface CandidateFinding extends IdentityAuthority {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly targetStoryId: string;
  readonly sourceSignalIds: readonly string[];
  readonly sourceLineageKeys: readonly string[];
  readonly suspectedDefect: string;
  readonly affectedSymbols: readonly string[];
  readonly affectedContracts: readonly string[];
  readonly candidateGroupKey: string;
  readonly state: 'pending_verification' | 'merged' | 'disproven' | 'promoted';
  readonly previousVersionHash?: string;
  readonly currentProjectionHash: string;
  readonly currentEvidenceRefs: readonly string[];
  readonly sourceBindings: readonly IdentitySourceAnchor[];
  /** Optional only for legacy/read compatibility; promotion requires this signed preregistration. */
  readonly reproductionContract?: CandidateReproductionContract;
  readonly mergedIntoCandidateId?: string;
  readonly promotionFindingRef?: FindingIdentityRef;
  readonly decision?: { readonly reason: string; readonly evidenceRefs: readonly string[]; readonly evidenceAnchors: readonly IdentitySourceAnchor[] };
}
/** A current eligible reviewer attests that the exact bound execution reproduced
 * the semantic defect, rather than merely printing the candidate marker. */
export interface CandidateReproductionAttestation extends IdentityAuthority {
  readonly schemaVersion: 1;
  readonly attestationId: string;
  readonly targetStoryId: string;
  readonly candidateId: string;
  readonly candidateProjectionHash: string;
  readonly reproductionContract: CandidateReproductionContract;
  readonly reproductionContractHash: string;
  readonly reproductionSelector: string;
  readonly reproductionExecutionKey: string;
  readonly reproductionReceiptHash: string;
  readonly findingRef: FindingIdentityRef;
  readonly reviewRunId: string;
  readonly reviewer: string;
  readonly semanticAssertion: string;
  readonly evidenceAnchors: readonly IdentitySourceAnchor[];
  readonly attestedAt: string;
}
export interface IdentitySemanticEnvelope<T extends object = Record<string, unknown>> extends IdentityAuthority {
  readonly schemaVersion: 1;
  readonly kind: string;
  readonly storyId: string;
  readonly requestDigest: string;
  readonly producedAt: string;
  readonly payload: T;
  readonly payloadDigest: string;
  readonly keyId: string;
  readonly algorithm: 'ed25519';
  readonly trustRootDigest: string;
  readonly keyFreshnessPolicyDigest: string;
  readonly signature: string;
}
export interface CanonicalDefect extends IdentityAuthority {
  readonly schemaVersion: 1;
  readonly canonicalDefectId: string;
  readonly title: string;
  readonly triggerCondition: string;
  readonly reproduction: string;
  readonly rootCauseState: 'unknown' | 'hypothesized' | 'confirmed';
  readonly rootCause?: string;
  readonly identityEvidenceRefs: readonly string[];
  readonly evidenceAnchors: readonly IdentitySourceAnchor[];
  readonly affectedSymbols: readonly string[];
  readonly affectedContracts: readonly string[];
  readonly memberFindingRefs: readonly FindingIdentityRef[];
  readonly canonicalFindingRef: FindingIdentityRef;
  readonly identityState: 'reviewer_confirmed';
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly reviewRunId: string;
  readonly sourceLineageKeys: readonly string[];
  readonly identityDigest: string;
  readonly currentProjectionHash: string;
}
