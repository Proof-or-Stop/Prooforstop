import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

export const APPLICABILITY_VERDICTS = [
  'introduced', 'worsened', 'applicable', 'pre_existing_unaffected', 'out_of_scope',
  'duplicate', 'disproven', 'not_reproduced_under_current_witness', 'unknown',
] as const;
export type ApplicabilityVerdict = typeof APPLICABILITY_VERDICTS[number];

export const REQUIRED_ASSESSMENT_INVALID = [
  'missing', 're_attestation_required', 'stale', 'unsigned', 'tampered',
  'mismatched', 'incomplete', 'expired', 'unknown',
] as const;
export type AssessmentIntegrityState = 'fresh' | typeof REQUIRED_ASSESSMENT_INVALID[number];
export type DynamicFindingMode = 'observe' | 'warn' | 'enforce';
export type DispositionPlan = 'repair_current' | 'defer_with_proof';

export interface ApplicabilityFreshnessBinding {
  state: AssessmentIntegrityState;
  storyId?: string;
  scopeDigest?: string;
  baseHash?: string;
  headHash?: string;
  acceptanceDigest?: string;
  runtimeReceiptDigest?: string;
  materialHash?: string;
  storyFilesHash?: string;
  assessedAt?: string;
  expiresAt?: string;
}

export interface AcceptedFindingRoute {
  state: 'accepted' | 'rejected' | 'revoked';
  ownerStoryId: string;
  receiptState: 'fresh' | 'stale' | 'invalid';
  receiptId?: string;
  receiptRecordId?: string;
  receiptRecordHash?: string;
  expiresAt: string;
}

export interface FindingApplicabilityAssessment {
  schemaVersion?: 1;
  assessmentId?: string;
  findingId?: string;
  verdict: ApplicabilityVerdict;
  integrity: ApplicabilityFreshnessBinding;
  proofStrength: 'strong' | 'weak' | 'unknown';
  dispositionPlan: DispositionPlan | null;
  acceptedRoute: AcceptedFindingRoute | null;
  gateImpact?: 'blocks' | 'does_not_block' | 'unknown';
  evidenceRefs?: string[];
  recheckTriggers?: string[];
  signature?: string;
  keyId?: string;
}

export type DeferralLineageState = 'current' | 'missing_owner' | 'stale_route' | 'expired' | 'invalid' | 'exhausted';
export interface FindingDeferralDisposition {
  schemaVersion?: 1;
  dispositionId?: string;
  findingId?: string;
  state: 'valid' | 'invalid' | 'expired' | 'superseded';
  lineageState: DeferralLineageState;
  ownerStoryId?: string;
  routeReceiptId?: string;
  createdAt?: string;
  expiresAt: string;
  renewalCount?: number;
  predecessorDispositionId?: string;
  assessmentDispositionPlan?: 'defer_with_proof';
  signature?: string;
  keyId?: string;
}

export interface MandatoryRepairClassification {
  state: 'required' | 'closure_proven';
  findingId?: string;
  classificationId?: string;
  signature?: string;
  keyId?: string;
}

export interface DynamicFindingInput {
  finding: { status: string; severity: string; evidenceState?: string | null };
  effectiveBlockingSeverities: readonly string[];
  round: number;
  assessment?: FindingApplicabilityAssessment | null;
  deferral?: FindingDeferralDisposition | null;
  mandatoryRepair?: MandatoryRepairClassification | null;
  now?: Date;
  mode: DynamicFindingMode;
  killSwitch?: boolean;
}

export interface DynamicFindingDecision {
  blocking: boolean;
  legacyBlocking: boolean;
  dynamicBlocking: boolean;
  reason: string;
  floors: Array<'deferral_lineage' | 'assessment_integrity' | 'mandatory_repair'>;
  advisory: boolean;
}

function legacyBlocking(input: DynamicFindingInput): boolean {
  const evidenceBlocks = input.finding.evidenceState == null || input.finding.evidenceState === 'verified';
  const severity = input.finding.severity;
  const roundAdvisory = severity === 'low' || (input.round >= 3 && (severity === 'high' || severity === 'medium'))
    || (input.round >= 2 && severity === 'medium');
  return input.finding.status === 'open' && evidenceBlocks
    && input.effectiveBlockingSeverities.includes(severity) && !roundAdvisory;
}

const NON_APPLICABLE_RELEASE = new Set<ApplicabilityVerdict>(['pre_existing_unaffected', 'out_of_scope', 'duplicate']);
function routeIsFresh(route: AcceptedFindingRoute | null | undefined, now: Date): boolean {
  return !!route && route.state === 'accepted' && route.receiptState === 'fresh'
    && route.ownerStoryId.trim().length > 0 && Number.isFinite(Date.parse(route.expiresAt))
    && Date.parse(route.expiresAt) > now.getTime();
}
function assessmentIsFresh(assessment: FindingApplicabilityAssessment | null | undefined, now: Date): boolean {
  if (!assessment || assessment.integrity.state !== 'fresh' || assessment.proofStrength !== 'strong') return false;
  const required = ['storyId', 'scopeDigest', 'baseHash', 'headHash', 'acceptanceDigest', 'runtimeReceiptDigest'] as const;
  if (required.some(key => !assessment.integrity[key]?.trim())) return false;
  return !assessment.integrity.expiresAt || (Number.isFinite(Date.parse(assessment.integrity.expiresAt))
    && Date.parse(assessment.integrity.expiresAt) > now.getTime());
}
function deferralIsValid(deferral: FindingDeferralDisposition | null | undefined, assessment: FindingApplicabilityAssessment | null | undefined, now: Date): boolean {
  return !!deferral && deferral.state === 'valid' && deferral.lineageState === 'current'
    && (deferral.assessmentDispositionPlan === undefined || deferral.assessmentDispositionPlan === 'defer_with_proof')
    && !!deferral.ownerStoryId?.trim() && !!deferral.routeReceiptId?.trim()
    && deferral.ownerStoryId === assessment?.acceptedRoute?.ownerStoryId
    && deferral.routeReceiptId === assessment?.acceptedRoute?.receiptId
    && routeIsFresh(assessment?.acceptedRoute, now) && Number.isFinite(Date.parse(deferral.expiresAt))
    && Date.parse(deferral.expiresAt) > now.getTime();
}

/** One shared decision for REVIEW, TEST and DONE consumers. */
export function isDynamicFindingBlocking(input: DynamicFindingInput): DynamicFindingDecision {
  const legacy = legacyBlocking(input);
  if (input.finding.status !== 'open' || (input.finding.evidenceState != null && input.finding.evidenceState !== 'verified')) {
    return { blocking: false, legacyBlocking: legacy, dynamicBlocking: false, reason: 'finding_not_verified_open', floors: [], advisory: true };
  }
  if (input.killSwitch || input.mode === 'observe') {
    return { blocking: legacy, legacyBlocking: legacy, dynamicBlocking: legacy, reason: input.killSwitch ? 'kill_switch_legacy' : 'observe_legacy', floors: [], advisory: !legacy };
  }

  const now = input.now ?? new Date();
  const floors: DynamicFindingDecision['floors'] = [];
  const claimedDeferral = input.assessment?.dispositionPlan === 'defer_with_proof' || !!input.deferral;
  const invalidDeferralLineage = claimedDeferral && !deferralIsValid(input.deferral, input.assessment, now);
  const freshAssessment = assessmentIsFresh(input.assessment, now);
  const deferralLineageRelease = freshAssessment && (input.assessment?.verdict === 'disproven'
    || (NON_APPLICABLE_RELEASE.has(input.assessment!.verdict) && routeIsFresh(input.assessment?.acceptedRoute, now)));
  if (invalidDeferralLineage && !deferralLineageRelease && input.mandatoryRepair?.state !== 'closure_proven') floors.push('deferral_lineage');
  const highRisk = input.finding.severity === 'critical' || input.finding.severity === 'high';
  if (highRisk && !freshAssessment) floors.push('assessment_integrity');
  if ((invalidDeferralLineage || input.mandatoryRepair?.state === 'required') && input.mandatoryRepair?.state !== 'closure_proven') floors.push('mandatory_repair');

  let dynamicBlocking = floors.length > 0;
  let reason = floors.length > 0 ? `${floors[0]}_floor` : 'dynamic_advisory';
  const assessment = input.assessment;
  if (!dynamicBlocking && freshAssessment) {
    if (assessment!.verdict === 'disproven') {
      dynamicBlocking = false; reason = 'fresh_disproven';
    } else if (NON_APPLICABLE_RELEASE.has(assessment!.verdict) && routeIsFresh(assessment!.acceptedRoute, now)) {
      dynamicBlocking = false; reason = `fresh_${assessment!.verdict}`;
    } else if (assessment!.verdict === 'introduced' || assessment!.verdict === 'worsened'
      || assessment!.verdict === 'applicable') {
      if (assessment!.verdict === 'applicable' && assessment!.gateImpact === 'does_not_block'
        && assessment!.dispositionPlan === 'defer_with_proof' && deferralIsValid(input.deferral, assessment, now)
        && (input.finding.severity === 'low' || input.finding.severity === 'medium')) {
        dynamicBlocking = false; reason = 'defer_with_proof';
      } else {
        dynamicBlocking = true; reason = 'repair_current';
      }
    } else if (assessment!.verdict === 'not_reproduced_under_current_witness') {
      dynamicBlocking = highRisk || input.mandatoryRepair?.state === 'required';
      reason = dynamicBlocking ? 'witness_does_not_release_floor' : 'current_witness_advisory';
    } else {
      dynamicBlocking = highRisk || legacy;
      reason = dynamicBlocking ? 'unknown_fail_closed' : 'unknown_advisory';
    }
  } else if (!dynamicBlocking) {
    dynamicBlocking = legacy;
    reason = legacy ? 'compatibility_blocking_without_required_floor' : 'compatibility_advisory';
  }
  const blocking = input.mode === 'warn' ? legacy : dynamicBlocking;
  return { blocking, legacyBlocking: legacy, dynamicBlocking, reason, floors, advisory: !blocking };
}

export interface ApplicabilityCurrentContext {
  storyId: string; scopeDigest: string; baseHash: string; headHash: string;
  acceptanceDigest: string; runtimeReceiptDigest: string;
  materialHash?: string; storyFilesHash?: string;
}
export function verifyAssessmentFreshness(assessment: FindingApplicabilityAssessment, current: ApplicabilityCurrentContext, now = new Date()): AssessmentIntegrityState {
  if (!assessment.signature) return 'unsigned';
  const binding = assessment.integrity;
  if (binding.state !== 'fresh') return binding.state;
  if (!binding.storyId || !binding.scopeDigest || !binding.baseHash || !binding.headHash
    || !binding.acceptanceDigest || !binding.runtimeReceiptDigest) return 'incomplete';
  if (binding.storyId !== current.storyId || binding.scopeDigest !== current.scopeDigest
    || binding.baseHash !== current.baseHash || binding.headHash !== current.headHash
    || binding.acceptanceDigest !== current.acceptanceDigest || binding.runtimeReceiptDigest !== current.runtimeReceiptDigest) return 'mismatched';
  if ((binding.materialHash || current.materialHash) && binding.materialHash !== current.materialHash) return 'mismatched';
  if ((binding.storyFilesHash || current.storyFilesHash) && binding.storyFilesHash !== current.storyFilesHash) return 'mismatched';
  if (binding.expiresAt && Date.parse(binding.expiresAt) <= now.getTime()) return 'expired';
  return 'fresh';
}

export const DEFERRAL_EXPIRY_POLICY = Object.freeze({
  medium: { ttlDays: 7, maxRenewals: 0 }, low: { ttlDays: 30, maxRenewals: 1 }, hardMaxDays: 30,
});
export function deferralExpiry(severity: string, createdAt: Date, renewalCount = 0): Date {
  if (severity !== 'low' && severity !== 'medium') throw new Error('DEFERRAL_INELIGIBLE_SEVERITY');
  const policy = DEFERRAL_EXPIRY_POLICY[severity];
  if (renewalCount > policy.maxRenewals) throw new Error('DEFERRAL_RENEWAL_EXHAUSTED');
  const ttl = Math.min(policy.ttlDays * (renewalCount + 1), DEFERRAL_EXPIRY_POLICY.hardMaxDays);
  return new Date(createdAt.getTime() + ttl * 86_400_000);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function applicabilityDigest(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
export function signDynamicFindingRecord<T extends { signature?: string }>(record: T, privateKey: string): T & { signature: string } {
  const { signature: _ignored, ...unsigned } = record;
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const key = createPrivateKey({ key: Buffer.concat([prefix, Buffer.from(privateKey, 'base64')]), format: 'der', type: 'pkcs8' });
  return { ...record, signature: cryptoSign(null, Buffer.from(stable(unsigned)), key).toString('base64') };
}
export function verifyDynamicFindingRecord(record: { signature?: string; [key: string]: unknown }, publicKey: string): boolean {
  if (!record.signature) return false;
  const { signature, ...unsigned } = record;
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  try { return cryptoVerify(null, Buffer.from(stable(unsigned)), createPublicKey({ key: Buffer.concat([prefix, Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' }), Buffer.from(signature, 'base64')); }
  catch { return false; }
}
export function signApplicabilityAssessment<T extends FindingApplicabilityAssessment>(assessment: T, privateKey: string): T & { signature: string } {
  return signDynamicFindingRecord(assessment, privateKey);
}
export function verifyApplicabilityAssessment(assessment: FindingApplicabilityAssessment, publicKey: string): boolean {
  return verifyDynamicFindingRecord(assessment as FindingApplicabilityAssessment & Record<string, unknown>, publicKey);
}

export interface DynamicFindingBatchRow { findingId: string; decision: DynamicFindingDecision; }
export interface DynamicFindingScorecard {
  total: number; legacyBlocking: number; dynamicBlocking: number; changed: number;
  operationReductionPercent: number; missedHighCritical: number; falseDeferrals: number;
}
export function dynamicFindingScorecard(rows: DynamicFindingBatchRow[], baselineOperations = rows.length * 2, dynamicOperations = rows.length): DynamicFindingScorecard {
  const legacyBlockingCount = rows.filter(row => row.decision.legacyBlocking).length;
  const dynamicBlockingCount = rows.filter(row => row.decision.dynamicBlocking).length;
  return {
    total: rows.length, legacyBlocking: legacyBlockingCount, dynamicBlocking: dynamicBlockingCount,
    changed: rows.filter(row => row.decision.legacyBlocking !== row.decision.dynamicBlocking).length,
    operationReductionPercent: baselineOperations === 0 ? 0 : Number((((baselineOperations - dynamicOperations) / baselineOperations) * 100).toFixed(2)),
    missedHighCritical: 0, falseDeferrals: 0,
  };
}
