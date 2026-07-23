import { createPublicKey, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  exportPublicKeyRaw,
  importPrivateKeyRaw,
  signCanonical,
  verifyCanonical,
} from './authority-signing.js';
import { digestCanonicalJson } from './digest.js';
import {
  checkEvidenceFreshnessForGit,
  currentGitHead,
  currentMaterialHash,
  currentStoryFilesHash,
} from './evidence-freshness.js';
import type {
  AcceptanceRolloutArtifactV1,
  AcceptanceRolloutCohortInputV1,
  AcceptanceRolloutDiagnosticCodeV1,
  AcceptanceRolloutMetricsV1,
  AcceptanceRolloutReceiptV1,
  AcceptanceRolloutReportV1,
  AcceptanceRolloutSourceRecordV1,
} from './types.js';

const ROLLOUT_KEY_FILE = 'lattice-acceptance-rollout-verifier-v1.key';
export const ACCEPTANCE_ROLLOUT_MIN_MATCHED_PAIRS = 3;
export const ACCEPTANCE_ROLLOUT_ELIGIBILITY_VERSION = 'proofstory.acceptance_rollout_eligibility.v1' as const;
export const ACCEPTANCE_ROLLOUT_THRESHOLD_VERSION = 'proofstory.acceptance_rollout_thresholds.v1' as const;
export const ACCEPTANCE_ROLLOUT_SUPPORTED_ADAPTER = 'codex-cli+claude-cli' as const;
export const ACCEPTANCE_ROLLOUT_FULL_QUORUM = 'full-3x2' as const;

export type AcceptanceRolloutMode = 'observe' | 'warn' | 'enforce';

export interface AcceptanceRolloutBinding {
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
}

export interface AcceptanceRolloutVerification {
  ok: boolean;
  status: 'pass' | 'fail' | 'missing';
  mode: AcceptanceRolloutMode;
  blocking: boolean;
  diagnostics: AcceptanceRolloutDiagnosticCodeV1[];
  receipt: 'current' | 'missing' | 'invalid' | 'stale';
  quorum: 'full-3x2' | 'degraded-or-missing';
  report?: AcceptanceRolloutReportV1;
}

function digest(value: unknown): string {
  return `sha256:${digestCanonicalJson(value)}`;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function unsignedSourceRecord(record: AcceptanceRolloutSourceRecordV1): Omit<AcceptanceRolloutSourceRecordV1, 'sourceDigest'> {
  const { sourceDigest: _sourceDigest, ...unsigned } = record;
  return unsigned;
}

export function acceptanceRolloutSourceRecordDigest(
  record: Omit<AcceptanceRolloutSourceRecordV1, 'sourceDigest'>,
): string {
  return digest(record);
}

function unsignedReport(report: AcceptanceRolloutReportV1): Omit<AcceptanceRolloutReportV1, 'reportDigest'> {
  const { reportDigest: _reportDigest, ...unsigned } = report;
  return unsigned;
}

function unsignedReceipt(receipt: AcceptanceRolloutReceiptV1): Omit<AcceptanceRolloutReceiptV1, 'signature'> {
  const { signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

function gitCommonDir(gitCwd: string): string {
  const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: gitCwd, encoding: 'utf8' }).trim();
  return isAbsolute(raw) ? raw : resolve(gitCwd, raw);
}

function keyPath(gitCwd: string): string {
  return join(gitCommonDir(gitCwd), ROLLOUT_KEY_FILE);
}

function readOrCreatePrivateKey(gitCwd: string): string {
  const path = keyPath(gitCwd);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(32).toString('base64'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  return readFileSync(path, 'utf8').trim();
}

function publicKeyForPrivate(privateKey: string): string {
  return exportPublicKeyRaw(createPublicKey(importPrivateKeyRaw(privateKey)));
}

function registeredPublicKey(gitCwd: string): string | null {
  const path = keyPath(gitCwd);
  if (!existsSync(path)) return null;
  try {
    return publicKeyForPrivate(readFileSync(path, 'utf8').trim());
  } catch {
    return null;
  }
}

function isIso(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function recordIsEligible(
  record: AcceptanceRolloutSourceRecordV1,
  window: AcceptanceRolloutCohortInputV1['evaluationWindow'],
): boolean {
  if (!isIso(record.completedAt) || !isIso(window.start) || !isIso(window.end)) return false;
  const at = Date.parse(record.completedAt);
  return record.comparableGroup === 'high_assurance'
    && at >= Date.parse(window.start)
    && at <= Date.parse(window.end);
}

function hasFull3x2(record: AcceptanceRolloutSourceRecordV1): boolean {
  return record.quorum.class === ACCEPTANCE_ROLLOUT_FULL_QUORUM
    && record.quorum.rounds === 3
    && uniqueSorted(record.quorum.hosts).join(',') === 'claude-cli,codex-cli'
    && uniqueSorted(record.quorum.providers).join(',') === 'claude,codex';
}

function needsTranscript(record: AcceptanceRolloutSourceRecordV1): boolean {
  return record.claimClass === 'user_visible' || record.claimClass === 'orchestration';
}

function needsMutation(record: AcceptanceRolloutSourceRecordV1): boolean {
  return record.claimClass === 'behavior'
    || record.claimClass === 'lifecycle'
    || record.claimClass === 'proof'
    || record.claimClass === 'safety';
}

function pairedMembership(records: AcceptanceRolloutSourceRecordV1[]) {
  const byPair = new Map<string, { baseline?: AcceptanceRolloutSourceRecordV1; candidate?: AcceptanceRolloutSourceRecordV1 }>();
  for (const record of records) {
    const pair = byPair.get(record.pairId) ?? {};
    pair[record.arm] = record;
    byPair.set(record.pairId, pair);
  }
  return [...byPair.entries()]
    .filter((entry): entry is [string, { baseline: AcceptanceRolloutSourceRecordV1; candidate: AcceptanceRolloutSourceRecordV1 }] =>
      Boolean(entry[1].baseline && entry[1].candidate))
    .map(([pairId, pair]) => ({
      pairId,
      baselineStoryId: pair.baseline.storyId,
      candidateStoryId: pair.candidate.storyId,
    }))
    .sort((a, b) => a.pairId.localeCompare(b.pairId));
}

function zeroMetrics(): AcceptanceRolloutMetricsV1 {
  return {
    matchedPairCount: 0,
    baselineSampleCount: 0,
    candidateSampleCount: 0,
    registeredSeedCount: 0,
    detectedSeedCount: 0,
    falsePassCount: 0,
    omissionSeedCount: 0,
    omissionDetectedCount: 0,
    omissionDetectionRate: 0,
    falseBlockCount: 0,
    falseBlockRate: 0,
    mislabeled3x1Count: 0,
    waiverDelta: 0,
    inventoryShrankCount: 0,
    baselineReviewRounds: 0,
    candidateReviewRounds: 0,
    baselineCostUnits: 0,
    candidateCostUnits: 0,
  };
}

/**
 * Sole deterministic aggregate/verdict producer. The input contains source
 * observations only: membership, metrics, diagnostics and verdict are not
 * accepted from a caller.
 */
export function deriveAcceptanceRolloutReport(args: {
  storyId: string;
  cohort: AcceptanceRolloutCohortInputV1;
  binding: AcceptanceRolloutBinding;
}): AcceptanceRolloutReportV1 {
  const { cohort } = args;
  const diagnostics = new Set<AcceptanceRolloutDiagnosticCodeV1>();
  const start = Date.parse(cohort.evaluationWindow.start);
  const end = Date.parse(cohort.evaluationWindow.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) diagnostics.add('AR_WINDOW_INVALID');

  const canonicalRecords = [...cohort.sourceRecords].sort((a, b) =>
    a.pairId.localeCompare(b.pairId) || a.arm.localeCompare(b.arm) || a.storyId.localeCompare(b.storyId));
  for (const record of canonicalRecords) {
    if (record.sourceDigest !== acceptanceRolloutSourceRecordDigest(unsignedSourceRecord(record))) {
      diagnostics.add('AR_SOURCE_RECORD_INVALID');
    }
    if (record.eligible !== recordIsEligible(record, cohort.evaluationWindow)) {
      diagnostics.add(record.eligible ? 'AR_INELIGIBLE_MEMBER' : 'AR_ELIGIBLE_MEMBERSHIP_INCOMPLETE');
    }
  }
  const sourceInventoryDigest = digest(canonicalRecords);
  if (cohort.sourceInventoryDigest !== sourceInventoryDigest) diagnostics.add('AR_MEMBERSHIP_DIGEST_MISMATCH');

  const eligibleRecords = canonicalRecords.filter(record => recordIsEligible(record, cohort.evaluationWindow));
  const unsupported = eligibleRecords.filter(record => record.adapterProfile !== ACCEPTANCE_ROLLOUT_SUPPORTED_ADAPTER);
  if (unsupported.length > 0) diagnostics.add('AR_ADAPTER_UNSUPPORTED');
  const supported = eligibleRecords.filter(record => record.adapterProfile === ACCEPTANCE_ROLLOUT_SUPPORTED_ADAPTER);
  const baseline = supported.filter(record => record.arm === 'baseline');
  const candidate = supported.filter(record => record.arm === 'candidate');
  const membership = pairedMembership(supported);

  if (baseline.length < ACCEPTANCE_ROLLOUT_MIN_MATCHED_PAIRS
    || candidate.length < ACCEPTANCE_ROLLOUT_MIN_MATCHED_PAIRS
    || membership.length < ACCEPTANCE_ROLLOUT_MIN_MATCHED_PAIRS) diagnostics.add('AR_SAMPLE_COUNT_LT_3');
  if (membership.length !== new Set([...baseline, ...candidate].map(record => record.pairId)).size) {
    diagnostics.add('AR_MATCHED_PAIR_MISSING');
  }

  if (candidate.some(record => needsTranscript(record) && !record.transcriptPresent)) diagnostics.add('AR_TRANSCRIPT_REQUIRED');
  if (candidate.some(record => needsMutation(record) && (!record.mutationRequired || !record.mutationBites))) {
    diagnostics.add('AR_MUTATION_REQUIRED');
  }

  const registeredSeedIds = uniqueSorted(cohort.registeredSeedIds);
  const seededCandidate = candidate.filter(record => Boolean(record.seededDefectId));
  const seededById = new Map(seededCandidate.map(record => [record.seededDefectId!, record]));
  if (registeredSeedIds.some(seedId => !seededById.has(seedId))
    || seededCandidate.some(record => !registeredSeedIds.includes(record.seededDefectId!))) {
    diagnostics.add('AR_REGISTERED_CAMPAIGN_INCOMPLETE');
  }
  const falsePassCount = registeredSeedIds.filter(seedId => {
    const record = seededById.get(seedId);
    return !record || !record.defectPresent || !record.detected || !record.blocked;
  }).length;
  if (falsePassCount > 0) diagnostics.add('AR_FALSE_PASS_NONZERO');

  const omissionRecords = registeredSeedIds
    .map(seedId => seededById.get(seedId))
    .filter((record): record is AcceptanceRolloutSourceRecordV1 => record?.defectClass === 'omission');
  const omissionDetected = omissionRecords.filter(record => record.detected && record.blocked);
  const omissionDetectionRate = omissionRecords.length === 0 ? 0 : omissionDetected.length / omissionRecords.length;
  if (omissionRecords.length === 0 || omissionDetectionRate !== 1) diagnostics.add('AR_OMISSION_DETECTION_BELOW_100');

  const falseBlockCount = candidate.filter(record => record.blocked && !record.shouldBlock).length;
  if (falseBlockCount > 0) diagnostics.add('AR_FALSE_BLOCK_NONZERO');

  const mislabeled3x1Count = candidate.filter(record =>
    record.quorum.class === 'full-3x2' && !hasFull3x2(record)).length;
  if (mislabeled3x1Count > 0) diagnostics.add('AR_MISLABELED_3X1_NONZERO');
  if (candidate.some(record => !hasFull3x2(record))) diagnostics.add('AR_QUORUM_NOT_FULL_3X2');

  const waiverDelta = candidate.reduce((sum, record) => sum + record.waiverCount, 0)
    - baseline.reduce((sum, record) => sum + record.waiverCount, 0);
  if (waiverDelta > 0) diagnostics.add('AR_WAIVER_DELTA_POSITIVE');

  const baselineByPair = new Map(baseline.map(record => [record.pairId, record]));
  const inventoryShrankCount = candidate.filter(record => {
    const before = baselineByPair.get(record.pairId);
    return Boolean(before && before.checkInventory.some(check => !record.checkInventory.includes(check)));
  }).length;
  if (inventoryShrankCount > 0) diagnostics.add('AR_CHECK_INVENTORY_SHRANK');

  const metrics: AcceptanceRolloutMetricsV1 = {
    ...zeroMetrics(),
    matchedPairCount: membership.length,
    baselineSampleCount: baseline.length,
    candidateSampleCount: candidate.length,
    registeredSeedCount: registeredSeedIds.length,
    detectedSeedCount: registeredSeedIds.filter(seedId => seededById.get(seedId)?.detected).length,
    falsePassCount,
    omissionSeedCount: omissionRecords.length,
    omissionDetectedCount: omissionDetected.length,
    omissionDetectionRate,
    falseBlockCount,
    falseBlockRate: candidate.length === 0 ? 0 : falseBlockCount / candidate.length,
    mislabeled3x1Count,
    waiverDelta,
    inventoryShrankCount,
    baselineReviewRounds: baseline.reduce((sum, record) => sum + record.reviewRounds, 0),
    candidateReviewRounds: candidate.reduce((sum, record) => sum + record.reviewRounds, 0),
    baselineCostUnits: baseline.reduce((sum, record) => sum + record.costUnits, 0),
    candidateCostUnits: candidate.reduce((sum, record) => sum + record.costUnits, 0),
  };
  const orderedDiagnostics = uniqueSorted([...diagnostics]);
  const unsigned: Omit<AcceptanceRolloutReportV1, 'reportDigest'> = {
    schemaVersion: 'proofstory.acceptance_rollout_report.v1',
    storyId: args.storyId,
    projectPolicy: 'flat-project',
    eligibilityRuleVersion: ACCEPTANCE_ROLLOUT_ELIGIBILITY_VERSION,
    thresholdVersion: ACCEPTANCE_ROLLOUT_THRESHOLD_VERSION,
    evaluationWindow: cohort.evaluationWindow,
    eligibleMembership: membership,
    membershipDigest: digest(membership),
    sourceInventoryDigest,
    registeredSeedIds,
    sourceRecords: canonicalRecords,
    metrics,
    diagnostics: orderedDiagnostics,
    verdict: orderedDiagnostics.length === 0 ? 'pass' : 'fail',
    binding: {
      ...args.binding,
      runnerDigest: cohort.runnerDigest,
    },
  };
  return { ...unsigned, reportDigest: digest(unsigned) };
}

export function issueAcceptanceRolloutArtifact(args: {
  gitCwd: string;
  report: AcceptanceRolloutReportV1;
  issuedAt?: string;
}): AcceptanceRolloutArtifactV1 {
  const privateKey = readOrCreatePrivateKey(args.gitCwd);
  const signerPublicKey = publicKeyForPrivate(privateKey);
  const unsigned: Omit<AcceptanceRolloutReceiptV1, 'signature'> = {
    schemaVersion: 'proofstory.acceptance_rollout_receipt.v1',
    receiptRef: `acceptance-rollout:${args.report.storyId}:${args.report.reportDigest}`,
    issuer: 'acceptance-rollout-verifier',
    issuerKeyId: digest(signerPublicKey),
    signerPublicKey,
    storyId: args.report.storyId,
    reportDigest: args.report.reportDigest,
    membershipDigest: args.report.membershipDigest,
    sourceInventoryDigest: args.report.sourceInventoryDigest,
    verdict: args.report.verdict,
    headHash: args.report.binding.headHash,
    materialHash: args.report.binding.materialHash,
    storyFilesHash: args.report.binding.storyFilesHash,
    issuedAt: args.issuedAt ?? new Date().toISOString(),
  };
  return {
    schemaVersion: 'proofstory.acceptance_rollout_artifact.v1',
    report: args.report,
    receipt: { ...unsigned, signature: signCanonical(unsigned, privateKey) },
  };
}

function reportMatchesRecomputation(
  report: AcceptanceRolloutReportV1,
  cohort: AcceptanceRolloutCohortInputV1,
): boolean {
  const recomputed = deriveAcceptanceRolloutReport({
    storyId: report.storyId,
    cohort,
    binding: {
      headHash: report.binding.headHash,
      materialHash: report.binding.materialHash,
      storyFilesHash: report.binding.storyFilesHash,
    },
  });
  return digest(recomputed) === digest(report);
}

export function verifyAcceptanceRolloutArtifact(args: {
  artifact: AcceptanceRolloutArtifactV1 | null;
  gitCwd: string;
  metadataRoot: string;
  expectedStoryId: string;
  expectedCohort?: AcceptanceRolloutCohortInputV1;
  mode: AcceptanceRolloutMode;
}): AcceptanceRolloutVerification {
  if (!args.artifact) {
    return {
      ok: false,
      status: 'missing',
      mode: args.mode,
      blocking: args.mode === 'enforce',
      diagnostics: ['AR_REPORT_MISSING'],
      receipt: 'missing',
      quorum: 'degraded-or-missing',
    };
  }
  const { report, receipt } = args.artifact;
  const diagnostics = new Set<AcceptanceRolloutDiagnosticCodeV1>();
  const trusted = registeredPublicKey(args.gitCwd);
  if (!trusted
    || receipt.signerPublicKey !== trusted
    || receipt.issuerKeyId !== digest(trusted)
    || !verifyCanonical(unsignedReceipt(receipt), receipt.signature, trusted)) diagnostics.add('AR_REPORT_TAMPERED');
  if (report.reportDigest !== digest(unsignedReport(report))
    || receipt.reportDigest !== report.reportDigest
    || receipt.membershipDigest !== report.membershipDigest
    || receipt.sourceInventoryDigest !== report.sourceInventoryDigest
    || receipt.verdict !== report.verdict
    || receipt.storyId !== args.expectedStoryId
    || report.storyId !== args.expectedStoryId) diagnostics.add('AR_REPORT_TAMPERED');
  if (args.expectedCohort && !reportMatchesRecomputation(report, args.expectedCohort)) {
    diagnostics.add(report.sourceInventoryDigest === args.expectedCohort.sourceInventoryDigest
      ? 'AR_REPORT_TAMPERED'
      : 'AR_ELIGIBLE_MEMBERSHIP_INCOMPLETE');
  }
  const freshness = checkEvidenceFreshnessForGit(
    args.gitCwd,
    receipt.headHash,
    receipt.materialHash,
    args.metadataRoot,
    receipt.storyFilesHash,
  );
  if (!freshness.fresh) diagnostics.add('AR_REPORT_STALE');
  for (const code of report.diagnostics) diagnostics.add(code);
  if (report.verdict !== 'pass') diagnostics.add('AR_FALSE_PASS_NONZERO');
  const ordered = uniqueSorted([...diagnostics]);
  const ok = ordered.length === 0;
  const stale = ordered.includes('AR_REPORT_STALE');
  const invalid = ordered.some(code => code === 'AR_REPORT_TAMPERED' || code === 'AR_ELIGIBLE_MEMBERSHIP_INCOMPLETE');
  return {
    ok,
    status: ok ? 'pass' : 'fail',
    mode: args.mode,
    blocking: args.mode === 'enforce' && !ok,
    diagnostics: ordered,
    receipt: ok ? 'current' : stale ? 'stale' : invalid ? 'invalid' : 'current',
    quorum: report.metrics.mislabeled3x1Count === 0
      && !report.diagnostics.includes('AR_QUORUM_NOT_FULL_3X2')
      ? 'full-3x2'
      : 'degraded-or-missing',
    report,
  };
}

export function currentAcceptanceRolloutBinding(gitCwd: string, metadataRoot: string): AcceptanceRolloutBinding {
  const headHash = currentGitHead(gitCwd);
  const materialHash = currentMaterialHash(gitCwd, 'HEAD', metadataRoot);
  const storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', metadataRoot);
  if (!headHash || !materialHash || !storyFilesHash) {
    throw new Error('acceptance rollout: current workspace hashes are unavailable');
  }
  return { headHash, materialHash, storyFilesHash };
}

export function acceptanceRolloutHistoryDigest(artifact: AcceptanceRolloutArtifactV1): string {
  return digest(artifact);
}

export function acceptanceRolloutWorkspaceIdentity(gitCwd: string): string {
  let common = '<unavailable>';
  let root = gitCwd;
  try { common = realpathSync(gitCommonDir(gitCwd)); } catch { /* stable marker */ }
  try { root = realpathSync(gitCwd); } catch { /* keep input */ }
  return digest({ common, root });
}
