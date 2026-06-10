export type AuthorityGateReceiptClassification =
  | 'production-gate-decision'
  | 'server-receipt-local-test'
  | 'contract-only'
  | 'transport-accepted'
  | 'invalid';

export type AuthorityGateReceiptFailReason =
  | 'authority_receipt_missing'
  | 'authority_receipt_schema_unsupported'
  | 'authority_receipt_not_production_classified'
  | 'authority_receipt_not_gate_decision'
  | 'authority_receipt_key_missing'
  | 'authority_receipt_state_version_missing'
  | 'authority_receipt_state_version_mismatch'
  | 'authority_receipt_digest_missing'
  | 'authority_receipt_story_mismatch'
  | 'authority_receipt_phase_mismatch'
  | 'authority_receipt_head_mismatch'
  | 'authority_receipt_stale_material'
  | 'authority_receipt_policy_unacceptable'
  | 'authority_receipt_authority_mode_unacceptable'
  | 'authority_receipt_verified_at_missing'
  | 'authority_receipt_freshness_expired'
  | 'authority_receipt_verdict_not_pass'
  | 'authority_receipt_evidence_missing'
  | 'authority_receipt_run_binding_missing'
  | 'authority_receipt_stale_or_revoked';

// Gate receipts are intentionally short lived: server policy can revoke or
// supersede a receipt without changing the local head/material hashes.
export const DEFAULT_AUTHORITY_RECEIPT_MAX_VERIFIED_AGE_MS = 15 * 60 * 1000;

export interface AuthorityGateReceiptConsumptionEvent {
  consumedAt: string;
  targetPhase: string;
  storyId: string;
  headHash: string;
  materialHash: string;
  decisionDigest: string;
}

export interface AuthorityGateDecisionReceiptRef {
  receiptId: string;
  receiptKind: string;
  classification: AuthorityGateReceiptClassification;
  authorityUrl?: string;
  authorityKeyId?: string;
  authorityPublicKeyDigest?: string;
  decisionId?: string;
  stateVersion?: number;
  gateInputDigest?: string;
  decisionDigest?: string;
  decisionVerdict?: string;
  storyId: string;
  targetPhase: string;
  headHash: string;
  materialHash: string;
  policyMode?: string;
  authorityMode?: string;
  producerRunIds?: string[];
  verifierRunIds?: string[];
  sessionId?: string;
  runnerSessionIds?: string[];
  evidenceDigests?: string[];
  verifiedAt?: string;
  verifiedBy?: string;
  eligibleGates?: string[];
  status?: 'active' | 'stale' | 'revoked' | 'superseded';
  consumptionEvents?: AuthorityGateReceiptConsumptionEvent[];
}

export interface AuthorityReceiptRefDocument {
  schemaVersion: 'lattice.authority_receipt_refs.v1';
  storyId: string;
  updatedAt: string;
  refs: AuthorityGateDecisionReceiptRef[];
}

export interface AuthorityGateReceiptContext {
  storyId: string;
  targetPhase: string;
  headHash: string;
  materialHash: string;
  currentServerStateVersion?: number;
  now?: string;
  maxVerifiedAgeMs?: number;
  acceptablePolicyModes?: readonly string[];
  acceptableAuthorityModes?: readonly string[];
  requireRunBindings?: boolean;
  requireEvidenceDigests?: boolean;
}

export interface AuthorityGateReceiptEligibility {
  eligible: boolean;
  reason?: AuthorityGateReceiptFailReason;
  ref?: AuthorityGateDecisionReceiptRef;
}

export interface StrongEvidenceConsumedFact {
  fact: 'strongEvidenceConsumed';
  value: true;
  source: 'authority_gate_decision_receipt';
  receiptId: string;
  stateVersion: number;
  targetPhase: string;
  storyId: string;
  headHash: string;
  materialHash: string;
  decisionDigest: string;
}

export interface AuthorityGateReceiptConsumption {
  consumed: boolean;
  reason?: AuthorityGateReceiptFailReason;
  ref?: AuthorityGateDecisionReceiptRef;
  fact?: StrongEvidenceConsumedFact;
}

export interface AuthorityGateReceiptDocumentConsumption extends AuthorityGateReceiptConsumption {
  document?: AuthorityReceiptRefDocument;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasItems(value: unknown): value is string[] {
  return Array.isArray(value) && value.some(nonEmpty);
}

function parseTimeMs(value: string | undefined): number | undefined {
  if (!nonEmpty(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function eligibleAuthorityGateReceiptDocument(
  document: AuthorityReceiptRefDocument | undefined,
  context: AuthorityGateReceiptContext,
): AuthorityGateReceiptEligibility {
  if (!document) return { eligible: false, reason: 'authority_receipt_missing' };
  if (document.schemaVersion !== 'lattice.authority_receipt_refs.v1') {
    return { eligible: false, reason: 'authority_receipt_schema_unsupported' };
  }
  if (document.storyId !== context.storyId) {
    return { eligible: false, reason: 'authority_receipt_story_mismatch' };
  }
  let firstFailure: AuthorityGateReceiptEligibility | undefined;
  for (const ref of document.refs) {
    const eligibility = eligibleAuthorityGateReceiptRef(ref, context);
    if (eligibility.eligible) return eligibility;
    firstFailure ??= eligibility;
  }
  return firstFailure ?? { eligible: false, reason: 'authority_receipt_missing' };
}

export function eligibleAuthorityGateReceiptRef(
  ref: AuthorityGateDecisionReceiptRef | undefined,
  context: AuthorityGateReceiptContext,
): AuthorityGateReceiptEligibility {
  if (!ref) return { eligible: false, reason: 'authority_receipt_missing' };
  if (ref.classification !== 'production-gate-decision') {
    return { eligible: false, reason: 'authority_receipt_not_production_classified', ref };
  }
  if (ref.receiptKind !== 'gate_decision') {
    return { eligible: false, reason: 'authority_receipt_not_gate_decision', ref };
  }
  if (!nonEmpty(ref.receiptId)) return { eligible: false, reason: 'authority_receipt_missing', ref };
  if (!nonEmpty(ref.authorityKeyId) || !nonEmpty(ref.authorityPublicKeyDigest)) {
    return { eligible: false, reason: 'authority_receipt_key_missing', ref };
  }
  if (typeof ref.stateVersion !== 'number' || !Number.isFinite(ref.stateVersion)) {
    return { eligible: false, reason: 'authority_receipt_state_version_missing', ref };
  }
  if (
    typeof context.currentServerStateVersion === 'number' &&
    context.currentServerStateVersion !== ref.stateVersion
  ) {
    return { eligible: false, reason: 'authority_receipt_state_version_mismatch', ref };
  }
  if (!nonEmpty(ref.gateInputDigest) || !nonEmpty(ref.decisionDigest)) {
    return { eligible: false, reason: 'authority_receipt_digest_missing', ref };
  }
  if (ref.storyId !== context.storyId) {
    return { eligible: false, reason: 'authority_receipt_story_mismatch', ref };
  }
  const hasExplicitEligibleGates = Array.isArray(ref.eligibleGates) && ref.eligibleGates.length > 0;
  const explicitlyEligibleGate = hasExplicitEligibleGates && ref.eligibleGates!.includes(context.targetPhase);
  const phaseMatches = ref.targetPhase === context.targetPhase;
  const explicitTestCoversDone =
    ref.targetPhase === 'TEST'
    && context.targetPhase === 'DONE'
    && explicitlyEligibleGate;
  if (!phaseMatches && !explicitTestCoversDone) {
    return { eligible: false, reason: 'authority_receipt_phase_mismatch', ref };
  }
  if (hasExplicitEligibleGates && !explicitlyEligibleGate) {
    return { eligible: false, reason: 'authority_receipt_phase_mismatch', ref };
  }
  if (ref.headHash !== context.headHash) {
    return { eligible: false, reason: 'authority_receipt_head_mismatch', ref };
  }
  if (ref.materialHash !== context.materialHash) {
    return { eligible: false, reason: 'authority_receipt_stale_material', ref };
  }
  if (context.acceptablePolicyModes?.length && (!ref.policyMode || !context.acceptablePolicyModes.includes(ref.policyMode))) {
    return { eligible: false, reason: 'authority_receipt_policy_unacceptable', ref };
  }
  if (context.acceptableAuthorityModes?.length && (!ref.authorityMode || !context.acceptableAuthorityModes.includes(ref.authorityMode))) {
    return { eligible: false, reason: 'authority_receipt_authority_mode_unacceptable', ref };
  }
  const verifiedAtMs = parseTimeMs(ref.verifiedAt);
  if (verifiedAtMs === undefined) {
    return { eligible: false, reason: 'authority_receipt_verified_at_missing', ref };
  }
  if (typeof context.maxVerifiedAgeMs === 'number') {
    const nowMs = parseTimeMs(context.now);
    if (nowMs === undefined || nowMs - verifiedAtMs > context.maxVerifiedAgeMs) {
      return { eligible: false, reason: 'authority_receipt_freshness_expired', ref };
    }
  }
  if (ref.decisionVerdict !== 'pass') {
    return { eligible: false, reason: 'authority_receipt_verdict_not_pass', ref };
  }
  if (context.requireEvidenceDigests !== false && !hasItems(ref.evidenceDigests)) {
    return { eligible: false, reason: 'authority_receipt_evidence_missing', ref };
  }
  if (
    context.requireRunBindings !== false &&
    (!hasItems(ref.producerRunIds) || !hasItems(ref.verifierRunIds))
  ) {
    return { eligible: false, reason: 'authority_receipt_run_binding_missing', ref };
  }
  if (ref.status && ref.status !== 'active') {
    return { eligible: false, reason: 'authority_receipt_stale_or_revoked', ref };
  }
  return { eligible: true, ref };
}

export function consumeAuthorityGateReceiptRef(
  ref: AuthorityGateDecisionReceiptRef | undefined,
  context: AuthorityGateReceiptContext,
  consumedAt: string,
): AuthorityGateReceiptConsumption {
  const eligibility = eligibleAuthorityGateReceiptRef(ref, context);
  if (!eligibility.eligible || !eligibility.ref) {
    return { consumed: false, reason: eligibility.reason, ref: eligibility.ref };
  }
  const event: AuthorityGateReceiptConsumptionEvent = {
    consumedAt,
    targetPhase: context.targetPhase,
    storyId: context.storyId,
    headHash: context.headHash,
    materialHash: context.materialHash,
    decisionDigest: eligibility.ref.decisionDigest!,
  };
  const priorEvents = eligibility.ref.consumptionEvents ?? [];
  const alreadyConsumed = priorEvents.some((candidate) => (
    candidate.targetPhase === event.targetPhase
    && candidate.storyId === event.storyId
    && candidate.headHash === event.headHash
    && candidate.materialHash === event.materialHash
    && candidate.decisionDigest === event.decisionDigest
  ));
  const consumedRef: AuthorityGateDecisionReceiptRef = {
    ...eligibility.ref,
    consumptionEvents: alreadyConsumed ? priorEvents : [...priorEvents, event],
  };
  return {
    consumed: true,
    ref: consumedRef,
    fact: {
      fact: 'strongEvidenceConsumed',
      value: true,
      source: 'authority_gate_decision_receipt',
      receiptId: consumedRef.receiptId,
      stateVersion: consumedRef.stateVersion!,
      targetPhase: context.targetPhase,
      storyId: context.storyId,
      headHash: context.headHash,
      materialHash: context.materialHash,
      decisionDigest: consumedRef.decisionDigest!,
    },
  };
}

export function consumeAuthorityGateReceiptDocument(
  document: AuthorityReceiptRefDocument | undefined,
  context: AuthorityGateReceiptContext,
  consumedAt: string,
): AuthorityGateReceiptDocumentConsumption {
  const eligibility = eligibleAuthorityGateReceiptDocument(document, context);
  if (!eligibility.eligible || !eligibility.ref) {
    return { consumed: false, reason: eligibility.reason, ref: eligibility.ref };
  }
  const consumption = consumeAuthorityGateReceiptRef(eligibility.ref, context, consumedAt);
  if (!consumption.consumed || !consumption.ref || !document) return consumption;
  return {
    ...consumption,
    document: {
      ...document,
      updatedAt: consumedAt,
      refs: document.refs.map((ref) => (
        ref.receiptId === consumption.ref?.receiptId ? consumption.ref : ref
      )),
    },
  };
}

export function upsertAuthorityGateReceiptRef(
  document: AuthorityReceiptRefDocument | undefined,
  ref: AuthorityGateDecisionReceiptRef,
  updatedAt: string,
): AuthorityReceiptRefDocument {
  const next: AuthorityReceiptRefDocument = document ?? {
    schemaVersion: 'lattice.authority_receipt_refs.v1',
    storyId: ref.storyId,
    updatedAt,
    refs: [],
  };
  const refs = next.refs.filter((candidate) => candidate.receiptId !== ref.receiptId);
  refs.push(ref);
  return {
    ...next,
    storyId: ref.storyId,
    updatedAt,
    refs,
  };
}
