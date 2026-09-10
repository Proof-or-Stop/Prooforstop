import type { StoryStore } from './store.js';
import type { Finding } from './types.js';
import type { JsonValue, LedgerRecord } from './finding-ledger.js';
import { canonicalHash, currentFindingLedgerTrustFromWorkspace } from './finding-ledger.js';
import { loadConfig } from './config.js';
import { execFileSync } from 'node:child_process';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from './evidence-freshness.js';
import { reviewInventoryAcceptanceSubjectDigestForStore } from './review-inventory-epoch.js';
import {
  applicabilityDigest, isDynamicFindingBlocking, verifyApplicabilityAssessment, verifyAssessmentFreshness, verifyDynamicFindingRecord,
  type DynamicFindingMode, type FindingApplicabilityAssessment,
  type FindingDeferralDisposition, type MandatoryRepairClassification,
} from './finding-applicability.js';
import { createFindingRouteHandlers } from '../handlers/finding-route.js';

export function currentApplicabilityContext(store: StoryStore, projectRoot: string, storyId: string) {
  const headHash = currentGitHead(projectRoot); const materialHash = currentMaterialHash(projectRoot);
  const storyFilesHash = currentStoryFilesHash(projectRoot, 'HEAD', projectRoot);
  if (!headHash || !materialHash || !storyFilesHash) throw new Error('dynamic finding: current Git/material hashes unavailable');
  let baseHash: string;
  try { baseHash = execFileSync('git', ['merge-base', 'main', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' }).trim(); }
  catch { throw new Error('dynamic finding: base hash unavailable'); }
  const ledger = store.readFindingLedger<JsonValue>(storyId);
  return { storyId, scopeDigest: reviewInventoryAcceptanceSubjectDigestForStore(store, storyId), baseHash, headHash,
    materialHash, storyFilesHash, acceptanceDigest: applicabilityDigest(store.readChecklist(storyId)),
    runtimeReceiptDigest: applicabilityDigest(ledger.records.filter(row => row.recordType === 'runtime_receipt')
      .map(row => ({ recordId: row.recordId, hash: canonicalHash(row) }))) };
}

export function routeStillCurrent(store: StoryStore, projectRoot: string, route: FindingApplicabilityAssessment['acceptedRoute'], now: Date): boolean {
  if (!route?.receiptRecordId || !route.receiptRecordHash) return false;
  try {
    if (Date.parse(route.expiresAt) <= now.getTime()) return false;
    const result = createFindingRouteHandlers({ store, root: projectRoot, scanRoot: projectRoot }).finding_route_verify({
      storyId: route.ownerStoryId,
      receipt: { storyId: route.ownerStoryId, recordId: route.receiptRecordId, recordHash: route.receiptRecordHash },
    }) as { valid?: boolean; envelope?: { payload?: { routeReceiptId?: string; expiresAt?: string } } };
    const payload = result.envelope?.payload;
    return result.valid === true && payload?.routeReceiptId === route.receiptId
      && payload?.expiresAt === route.expiresAt;
  } catch { return false; }
}

function latest<T>(records: LedgerRecord<JsonValue>[], kind: string, findingId: string): T | undefined {
  const row = [...records].reverse().find(record => record.recordType === kind && record.payload
    && typeof record.payload === 'object' && (record.payload as Record<string, unknown>).findingId === findingId);
  return row?.payload as T | undefined;
}

export function resolveDynamicFindingRollout(projectRoot: string, requested?: DynamicFindingMode): { mode: DynamicFindingMode; killSwitch: boolean } {
  const policy = loadConfig(projectRoot).dynamicFinding;
  const mode: DynamicFindingMode = policy?.mode === 'warn' || policy?.mode === 'enforce' ? policy.mode : 'observe';
  if (requested && requested !== mode) throw new Error(`dynamic finding: requested mode ${requested} differs from configured ${mode}`);
  return { mode, killSwitch: policy?.killSwitch === true };
}

/** Read the current signed projection. Missing or invalid authority fails closed in enforce mode. */
export function readDynamicFindingDecision(args: {
  store: StoryStore; projectRoot: string; storyId: string; finding: Finding;
  effectiveBlockingSeverities: readonly string[]; round: number; requestedMode?: DynamicFindingMode;
}) {
  const ledger = args.store.readFindingLedger<JsonValue>(args.storyId);
  const trust = currentFindingLedgerTrustFromWorkspace(args.projectRoot);
  const stored = latest<FindingApplicabilityAssessment>(ledger.records, 'finding_applicability_assessment', args.finding.id);
  const now = new Date();
  let assessment = stored && trust && verifyApplicabilityAssessment(stored, trust.publicKey) ? stored : stored
    ? { ...stored, integrity: { ...stored.integrity, state: 'tampered' as const } } : undefined;
  if (assessment?.integrity.state === 'fresh') {
    const state = verifyAssessmentFreshness(assessment, currentApplicabilityContext(args.store, args.projectRoot, args.storyId), now);
    assessment = { ...assessment, integrity: { ...assessment.integrity, state } };
  }
  if (assessment?.acceptedRoute && !routeStillCurrent(args.store, args.projectRoot, assessment.acceptedRoute, now)) {
    assessment = { ...assessment, acceptedRoute: { ...assessment.acceptedRoute, receiptState: 'stale' } };
  }
  const storedDeferral = latest<FindingDeferralDisposition>(ledger.records, 'finding_deferral_disposition', args.finding.id);
  const deferral = storedDeferral && trust && verifyDynamicFindingRecord(storedDeferral as FindingDeferralDisposition & Record<string, unknown>, trust.publicKey)
    ? storedDeferral : storedDeferral ? { ...storedDeferral, state: 'invalid' as const, lineageState: 'invalid' as const } : undefined;
  const storedMandatory = latest<MandatoryRepairClassification>(ledger.records, 'mandatory_repair', args.finding.id);
  const mandatoryRepair = storedMandatory && trust && verifyDynamicFindingRecord(storedMandatory as MandatoryRepairClassification & Record<string, unknown>, trust.publicKey)
    ? storedMandatory : storedMandatory ? { ...storedMandatory, state: 'required' as const } : undefined;
  return isDynamicFindingBlocking({
    finding: args.finding, effectiveBlockingSeverities: args.effectiveBlockingSeverities, round: args.round,
    assessment, deferral, mandatoryRepair, now, ...resolveDynamicFindingRollout(args.projectRoot, args.requestedMode),
  });
}
