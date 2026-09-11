import type { StoryStore } from './store.js';
import type { Finding } from './types.js';
import type { JsonValue, LedgerRecord } from './finding-ledger.js';
import { canonicalHash, currentFindingLedgerTrustFromWorkspace } from './finding-ledger.js';
import { loadConfig } from './config.js';
import { execFileSync } from 'node:child_process';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash, readMaterialDirtyFiles } from './evidence-freshness.js';
import { reviewInventoryAcceptanceSubjectDigestForStore } from './review-inventory-epoch.js';
import {
  applicabilityDigest, isDynamicFindingBlocking, verifyApplicabilityAssessment, verifyAssessmentFreshness, verifyDynamicFindingRecord,
  type DynamicFindingMode, type FindingApplicabilityAssessment, type ApplicabilityCurrentContext,
  type FindingDeferralDisposition, type MandatoryRepairClassification,
} from './finding-applicability.js';
import { createFindingRouteHandlers } from '../handlers/finding-route.js';
import { readApplicabilityProof } from '../handlers/finding-applicability-proof.js';
import { readFindingQualificationScorecard } from '../handlers/finding-qualification.js';
import { StoryStore as QualificationStore } from './store.js';
import { verifyDeferralProjection } from '../handlers/finding-deferral-proof.js';
import { verifiedIdentityCarrier } from '../handlers/finding-identity-store.js';

/** Metadata-only commits must not reopen a proven repair. All material, scope,
 * acceptance and exact selected runtime evidence bindings remain mandatory. */
export function repairClosureContext(context: ApplicabilityCurrentContext) {
  const { headHash: _head, baseHash: _base, ...semantic } = context;
  return semantic;
}

export function currentApplicabilityContext(store: StoryStore, projectRoot: string, storyId: string, runtimeReceiptIds: string[] = []) {
  const dirty = readMaterialDirtyFiles(projectRoot, projectRoot);
  if (dirty.error || dirty.files.length) throw new Error('CAS_CONFLICT: uncommitted material changes cannot bind current applicability');
  const headHash = currentGitHead(projectRoot); const materialHash = currentMaterialHash(projectRoot);
  const storyFilesHash = currentStoryFilesHash(projectRoot, 'HEAD', projectRoot);
  if (!headHash || !materialHash || !storyFilesHash) throw new Error('dynamic finding: current Git/material hashes unavailable');
  let baseHash: string;
  try { baseHash = execFileSync('git', ['merge-base', 'main', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' }).trim(); }
  catch { throw new Error('dynamic finding: base hash unavailable'); }
  const ledger = store.readFindingLedger<JsonValue>(storyId);
  return { storyId, scopeDigest: reviewInventoryAcceptanceSubjectDigestForStore(store, storyId), baseHash, headHash,
    materialHash, storyFilesHash, acceptanceDigest: applicabilityDigest(store.readChecklist(storyId)),
    runtimeReceiptDigest: applicabilityDigest(ledger.records.filter(row => row.recordType === 'runtime_evidence_receipt'
      && runtimeReceiptIds.includes((row.payload as unknown as { receiptId: string }).receiptId))
      .map(row => ({ recordId: row.recordId, hash: canonicalHash(row) }))) };
}

export function routeStillCurrent(store: StoryStore, projectRoot: string, route: FindingApplicabilityAssessment['acceptedRoute'], now: Date,
  proposalRef?: FindingApplicabilityAssessment['proposalRef']): boolean {
  if (!route?.receiptRecordId || !route.receiptRecordHash) return false;
  try {
    if (Date.parse(route.expiresAt) <= now.getTime()) return false;
    const result = createFindingRouteHandlers({ store, root: projectRoot, scanRoot: projectRoot }).finding_route_verify({
      storyId: route.ownerStoryId,
      receipt: { storyId: route.ownerStoryId, recordId: route.receiptRecordId, recordHash: route.receiptRecordHash },
    }) as { valid?: boolean; envelope?: { payload?: { routeReceiptId?: string; expiresAt?: string; source?: FindingApplicabilityAssessment['proposalRef'] } } };
    const payload = result.envelope?.payload;
    return result.valid === true && payload?.routeReceiptId === route.receiptId
      && payload?.expiresAt === route.expiresAt
      && (!proposalRef || applicabilityDigest(payload?.source) === applicabilityDigest(proposalRef));
  } catch { return false; }
}

function latest<T>(records: LedgerRecord<JsonValue>[], kind: string, findingId: string): T | undefined {
  const row = [...records].reverse().find(record => record.recordType === kind && record.payload
    && typeof record.payload === 'object' && (record.payload as Record<string, unknown>).findingId === findingId);
  return row?.payload as T | undefined;
}

export function resolveDynamicFindingRollout(projectRoot: string, requested?: DynamicFindingMode): { mode: DynamicFindingMode; configuredMode: DynamicFindingMode; killSwitch: boolean; refusalReasons: string[] } {
  const policy = loadConfig(projectRoot).dynamicFinding;
  const configuredMode: DynamicFindingMode = policy?.mode === 'warn' || policy?.mode === 'enforce' ? policy.mode : 'observe';
  if (requested && requested !== configuredMode) throw new Error(`dynamic finding: requested mode ${requested} differs from configured ${configuredMode}`);
  if (configuredMode !== 'enforce' || policy?.killSwitch) return { mode: configuredMode, configuredMode, killSwitch: policy?.killSwitch === true, refusalReasons: [] };
  const report = readFindingQualificationScorecard({ root: projectRoot, scanRoot: projectRoot, store: new QualificationStore(projectRoot) });
  return { mode: report.qualification.eligible ? 'enforce' : 'warn', configuredMode, killSwitch: false, refusalReasons: report.refusalReasons };
}

/** Read the current signed projection. Missing or invalid authority fails closed in enforce mode. */
export function readDynamicFindingDecision(args: {
  store: StoryStore; projectRoot: string; storyId: string; finding: Finding;
  effectiveBlockingSeverities: readonly string[]; round: number; requestedMode?: DynamicFindingMode;
  /** Internal shadow evaluation; never grants caller-selected gate authority. */
  diagnostic?: boolean;
}) {
  const rollout = resolveDynamicFindingRollout(args.projectRoot, args.requestedMode);
  if (rollout.killSwitch || (!args.diagnostic && rollout.mode === 'observe')) {
    return isDynamicFindingBlocking({ finding: args.finding, effectiveBlockingSeverities: args.effectiveBlockingSeverities,
      round: args.round, mode: rollout.mode, killSwitch: rollout.killSwitch });
  }
  const ledger = args.store.readFindingLedger<JsonValue>(args.storyId);
  const trust = currentFindingLedgerTrustFromWorkspace(args.projectRoot);
  const stored = latest<FindingApplicabilityAssessment>(ledger.records, 'finding_applicability_assessment', args.finding.id);
  const now = new Date();
  let assessment = stored && trust && verifyApplicabilityAssessment(stored, trust.publicKey) ? stored : stored
    ? { ...stored, integrity: { ...stored.integrity, state: 'tampered' as const } } : undefined;
  if (assessment) {
    // Never trust a stored/host-supplied "verified" bit, even when signed.
    assessment = { ...assessment, evidenceVerification: undefined };
    try {
      const record = [...ledger.records].reverse().find(row => row.recordType === 'finding_applicability_assessment'
        && (row.payload as unknown as FindingApplicabilityAssessment).findingId === args.finding.id)!;
      verifiedIdentityCarrier(ledger, args.storyId, record.recordId, trust!);
      const context = currentApplicabilityContext(args.store, args.projectRoot, args.storyId, assessment.runtimeReceiptIds);
      const state = verifyAssessmentFreshness(assessment, context, now);
      assessment = { ...assessment, integrity: { ...assessment.integrity, state } };
      if (state === 'fresh') {
        const proof = readApplicabilityProof({ store: args.store, root: args.projectRoot, scanRoot: args.projectRoot }, args.storyId, args.finding, assessment, false);
        assessment = { ...assessment, evidenceVerification: proof.proof };
      }
    } catch { assessment = { ...assessment, integrity: { ...assessment.integrity, state: 'incomplete' } }; }
  }
  if (assessment?.acceptedRoute && !routeStillCurrent(args.store, args.projectRoot, assessment.acceptedRoute, now, assessment.proposalRef)) {
    assessment = { ...assessment, acceptedRoute: { ...assessment.acceptedRoute, receiptState: 'stale' } };
  }
  const storedDeferral = latest<FindingDeferralDisposition>(ledger.records, 'finding_deferral_disposition', args.finding.id);
  let deferral = storedDeferral && trust && verifyDynamicFindingRecord(storedDeferral as FindingDeferralDisposition & Record<string, unknown>, trust.publicKey)
    ? storedDeferral : storedDeferral ? { ...storedDeferral, state: 'invalid' as const, lineageState: 'invalid' as const } : undefined;
  if (deferral) {
    try {
      const record = [...ledger.records].reverse().find(row => row.recordType === 'finding_deferral_disposition'
        && (row.payload as unknown as FindingDeferralDisposition).findingId === args.finding.id)!;
      deferral = verifyDeferralProjection({ store: args.store, root: args.projectRoot, scanRoot: args.projectRoot }, args.storyId, args.finding.severity, assessment, record, now);
    } catch { deferral = { ...deferral, state: 'invalid', lineageState: 'invalid' }; }
  }
  const storedMandatory = latest<MandatoryRepairClassification>(ledger.records, 'mandatory_repair', args.finding.id);
  let mandatoryRepair = storedMandatory && trust && verifyDynamicFindingRecord(storedMandatory as MandatoryRepairClassification & Record<string, unknown>, trust.publicKey)
    ? storedMandatory : storedMandatory ? { ...storedMandatory, state: 'required' as const } : undefined;
  if (mandatoryRepair?.state === 'closure_proven') {
    try {
      const record = [...ledger.records].reverse().find(row => row.recordType === 'mandatory_repair'
        && (row.payload as unknown as MandatoryRepairClassification).findingId === args.finding.id)!;
      verifiedIdentityCarrier(ledger, args.storyId, record.recordId, trust!);
      const context = repairClosureContext(currentApplicabilityContext(args.store, args.projectRoot, args.storyId, mandatoryRepair.closureEvidenceRefs));
      if (applicabilityDigest(mandatoryRepair.closureBinding) !== applicabilityDigest(context)) mandatoryRepair = { ...mandatoryRepair, state: 'required' };
    } catch { mandatoryRepair = { ...mandatoryRepair, state: 'required' }; }
  }
  const decision = isDynamicFindingBlocking({
    finding: args.finding, effectiveBlockingSeverities: args.effectiveBlockingSeverities, round: args.round,
    assessment, deferral, mandatoryRepair, now, ...rollout, ...(args.diagnostic ? { mode: 'warn' as const, killSwitch: false } : {}),
  });
  return { ...decision, validation: {
    evidenceDigest: applicabilityDigest({ assessment, deferral, mandatoryRepair }),
    requiredCommands: assessment?.evidenceVerification?.state === 'verified' && decision.dynamicBlocking
      ? assessment.evidenceVerification.requiredCommands : [],
    affectedPaths: assessment?.evidenceVerification?.state === 'verified' ? assessment.evidenceVerification.affectedPaths : [],
    needsReassessment: decision.floors.includes('assessment_integrity') || decision.floors.includes('deferral_lineage'),
  } };
}
