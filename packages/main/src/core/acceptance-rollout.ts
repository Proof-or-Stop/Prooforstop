import { createHash, createPublicKey, randomBytes } from 'node:crypto';
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
  AcceptanceRolloutGateArtifactV1,
  AcceptanceRolloutHostVerdictReceiptV1,
  AcceptanceRolloutMetricsV1,
  AcceptanceRolloutObservationReceiptV1,
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

function byteDigest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
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

function keyPath(gitCwd: string, file = ROLLOUT_KEY_FILE): string {
  return join(gitCommonDir(gitCwd), file);
}

function readOrCreatePrivateKey(gitCwd: string, file = ROLLOUT_KEY_FILE): string {
  const path = keyPath(gitCwd, file);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(32).toString('base64'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  return readFileSync(path, 'utf8').trim();
}

function publicKeyForPrivate(privateKey: string): string {
  return exportPublicKeyRaw(createPublicKey(importPrivateKeyRaw(privateKey)));
}

function registeredPublicKey(gitCwd: string, file = ROLLOUT_KEY_FILE): string | null {
  const path = keyPath(gitCwd, file);
  if (!existsSync(path)) return null;
  try {
    return publicKeyForPrivate(readFileSync(path, 'utf8').trim());
  } catch {
    return null;
  }
}

function unsignedObservation(
  receipt: AcceptanceRolloutObservationReceiptV1,
): Omit<AcceptanceRolloutObservationReceiptV1, 'signature'> {
  const { signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

export type RegisteredAcceptanceRolloutScenario = 'control' | 'omission' | 'forgery' | 'freshness';

type ProductionRolloutCaseEvidence = {
  storyId: string;
  arm: 'baseline' | 'candidate';
  scenario: RegisteredAcceptanceRolloutScenario;
  topologyReport: Record<string, unknown>;
  preReviewReport: Record<string, unknown>;
  quorumResult: {
    schemaVersion: string;
    storyId: string;
    rounds: number;
    emittedCount: number;
    verdictIds: string[];
    runIds: string[];
    metadataCommitSha: string;
    reviewerPasses: Array<{ lane: string; passId: string; reviewRunId?: string }>;
    reviewEscalationStatus?: {
      assuranceLevel?: string;
      voluntaryLocalRounds?: {
        requiredRounds?: number;
        requiredPassingHostsPerRound?: number;
        validRoundCount?: number;
        complete?: boolean;
      };
    };
  };
  hostVerdicts: AcceptanceRolloutHostVerdictReceiptV1[];
  reviewRuns: Array<Record<string, unknown>>;
  reviewPasses: Array<Record<string, unknown>>;
};

/**
 * Seal only production command output. This writer refuses invented gate or
 * quorum summaries: the quorum metadata commit must exist in the preserved
 * temp repository and contain the exact six host_verdict rows supplied here.
 */
export function issueAcceptanceRolloutObservationFromProduction(args: {
  gitCwd: string;
  evidenceGitCwd: string;
  storyId: string;
  pairId: string;
  arm: 'baseline' | 'candidate';
  scenario: RegisteredAcceptanceRolloutScenario;
  issuedAt: string;
  evidence: ProductionRolloutCaseEvidence;
}): AcceptanceRolloutObservationReceiptV1 {
  const { evidence } = args;
  if (evidence.storyId !== args.storyId || evidence.arm !== args.arm || evidence.scenario !== args.scenario) {
    throw new Error('acceptance rollout observation: production evidence story/arm/scenario mismatch');
  }
  if (evidence.topologyReport.storyId !== args.storyId || evidence.preReviewReport.storyId !== args.storyId) {
    throw new Error('acceptance rollout observation: gate report story mismatch');
  }
  const quorum = evidence.quorumResult;
  if (quorum.schemaVersion !== 'lattice.quorum_submit.v1'
    || quorum.storyId !== args.storyId
    || quorum.rounds !== 3
    || quorum.emittedCount !== 6
    || quorum.verdictIds.length !== 6
    || quorum.runIds.length !== 3
    || quorum.reviewerPasses.length === 0
    || quorum.reviewEscalationStatus?.voluntaryLocalRounds?.requiredRounds !== 3
    || quorum.reviewEscalationStatus.voluntaryLocalRounds.requiredPassingHostsPerRound !== 2
    || quorum.reviewEscalationStatus.voluntaryLocalRounds.validRoundCount !== 3
    || quorum.reviewEscalationStatus.voluntaryLocalRounds.complete !== true) {
    throw new Error('acceptance rollout observation: production quorum receipt is not full-3x2');
  }
  execFileSync('git', ['cat-file', '-e', `${quorum.metadataCommitSha}^{commit}`], {
    cwd: args.evidenceGitCwd,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const storyPath = `.lattice/story/actives/${args.storyId}/process-events.jsonl`;
  const committedEvents = execFileSync('git', ['show', `${quorum.metadataCommitSha}:${storyPath}`], {
    cwd: args.evidenceGitCwd,
    encoding: 'utf8',
  }).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  const committedVerdicts = committedEvents.filter(event => event.type === 'host_verdict');
  const committedById = new Map(committedVerdicts.map(event => [String(event.verdictId), event]));
  if (evidence.hostVerdicts.length !== 6
    || quorum.verdictIds.some(id => !committedById.has(id))
    || evidence.hostVerdicts.some(row => digest(row) !== digest(committedById.get(row.verdictId)))) {
    throw new Error('acceptance rollout observation: host verdict rows do not match the immutable quorum commit');
  }
  const actualPassIds = new Set(evidence.reviewPasses.map(row => String(row.id ?? '')));
  if (quorum.reviewerPasses.some(pass => !actualPassIds.has(pass.passId))) {
    throw new Error('acceptance rollout observation: quorum reviewer-pass refs are missing from actual production passes');
  }
  const gateArtifacts: AcceptanceRolloutGateArtifactV1[] = [
    {
      schemaVersion: 'proofstory.acceptance_rollout_gate_artifact.v1',
      command: 'acceptance_topology_check',
      storyId: args.storyId,
      pairId: args.pairId,
      arm: args.arm,
      report: evidence.topologyReport,
      artifactDigest: digest(evidence.topologyReport),
    },
    {
      schemaVersion: 'proofstory.acceptance_rollout_gate_artifact.v1',
      command: 'pre_review_check',
      storyId: args.storyId,
      pairId: args.pairId,
      arm: args.arm,
      report: evidence.preReviewReport,
      artifactDigest: digest(evidence.preReviewReport),
    },
  ];
  const privateKey = readOrCreatePrivateKey(args.gitCwd);
  const signerPublicKey = publicKeyForPrivate(privateKey);
  const topologyStatus = String(evidence.topologyReport.status ?? '');
  const preReviewStatus = String(evidence.preReviewReport.status ?? '');
  const expectedCode = args.scenario === 'omission'
    ? 'PR_NEW_PATH_UNMAPPED'
    : args.scenario === 'forgery'
      ? 'PR_ARTIFACT_TAMPERED'
      : args.scenario === 'freshness'
        ? 'PR_EVIDENCE_STALE'
        : 'CONTROL_PASS';
  const preReviewCodes = Array.isArray(evidence.preReviewReport.codes)
    ? evidence.preReviewReport.codes.map(String)
    : [];
  const mutationObserved = args.arm === 'candidate' && args.scenario !== 'control'
    ? (preReviewCodes.includes(expectedCode) ? expectedCode : preReviewCodes[0] ?? 'MISSING')
    : (topologyStatus === 'pass' && (preReviewStatus === 'pass' || evidence.preReviewReport.ok === true)
      ? 'CONTROL_PASS'
      : 'CONTROL_FAILED');
  const reviewRoundIds = uniqueSorted(evidence.reviewRuns
    .map(row => String(row.reviewRound ?? row.startedAt ?? ''))
    .filter(Boolean));
  const unsigned: Omit<AcceptanceRolloutObservationReceiptV1, 'signature'> = {
    schemaVersion: 'proofstory.acceptance_rollout_observation_receipt.v1',
    storyId: args.storyId,
    pairId: args.pairId,
    arm: args.arm,
    gateArtifacts,
    hostVerdicts: evidence.hostVerdicts,
    quorumReceipt: {
      schemaVersion: 'lattice.quorum_submit.v1',
      storyId: quorum.storyId,
      rounds: quorum.rounds,
      emittedCount: quorum.emittedCount,
      verdictIds: [...quorum.verdictIds],
      runIds: [...quorum.runIds],
      metadataCommitSha: quorum.metadataCommitSha,
      reviewerPasses: quorum.reviewerPasses.map(pass => ({ ...pass })),
      assuranceLevel: 'full-3x2',
    },
    reviewRoundIds,
    waiverRefs: [],
    usageEvents: [],
    transcriptRefs: evidence.preReviewReport.transcript === 'related'
      ? [`${args.storyId}:pre-review:related-transcript`]
      : [],
    mutationResults: [{
      mutationId: `${args.storyId}:${args.scenario}`,
      expectedCode,
      observedCode: mutationObserved,
      controlRestored: true,
    }],
    checkInventory: ['acceptance_topology_check', 'pre_review_check', 'acceptance_rollout_check'],
    issuedAt: args.issuedAt,
    issuerKeyId: digest(signerPublicKey),
    signerPublicKey,
  };
  return { ...unsigned, signature: signCanonical(unsigned, privateKey) };
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

interface VerifiedRolloutObservation {
  valid: boolean;
  adapterProfile: typeof ACCEPTANCE_ROLLOUT_SUPPORTED_ADAPTER | 'unsupported';
  transcriptPresent: boolean;
  mutationBites: boolean;
  detected: boolean;
  blocked: boolean;
  reviewRounds: number;
  waiverCount: number;
  checkInventory: string[];
  costUnits: number;
  full3x2: boolean;
}

const LEGACY_CALLER_OBSERVATION_FIELDS = [
  'adapterProfile',
  'transcriptPresent',
  'mutationRequired',
  'mutationBites',
  'detected',
  'blocked',
  'reviewRounds',
  'waiverCount',
  'checkInventory',
  'costUnits',
  'quorum',
] as const;

function verifyGateArtifact(
  record: AcceptanceRolloutSourceRecordV1,
  artifact: AcceptanceRolloutGateArtifactV1,
): boolean {
  if (artifact.storyId !== record.storyId || artifact.pairId !== record.pairId || artifact.arm !== record.arm) return false;
  if (!['acceptance_topology_check', 'pre_review_check'].includes(artifact.command)) return false;
  return artifact.report.storyId === record.storyId
    && artifact.artifactDigest === digest(artifact.report);
}

function verifyHostVerdict(
  record: AcceptanceRolloutSourceRecordV1,
  receipt: AcceptanceRolloutHostVerdictReceiptV1,
): boolean {
  const provider = receipt.hostId === 'codex-cli' ? 'codex' : 'claude';
  return receipt.type === 'host_verdict'
    && receipt.provider === provider
    && receipt.decision === 'pass'
    && /^[a-f0-9]{64}$/.test(receipt.materialDigest)
    && /^[a-f0-9]{64}$/.test(receipt.storyFilesHash)
    && /^[a-f0-9]{64}$/.test(receipt.validationDigest)
    && /^[a-f0-9]{64}$/.test(receipt.promptDigest);
}

function full3x2FromReceipts(receipts: AcceptanceRolloutHostVerdictReceiptV1[]): boolean {
  const byRun = new Map<string, AcceptanceRolloutHostVerdictReceiptV1[]>();
  for (const receipt of receipts) {
    const rows = byRun.get(receipt.runId) ?? [];
    rows.push(receipt);
    byRun.set(receipt.runId, rows);
  }
  if (byRun.size !== 3 || receipts.length !== 6) return false;
  return [...byRun.values()].every(rows =>
    rows.length === 2
    && uniqueSorted(rows.map(row => row.hostId)).join(',') === 'claude-cli,codex-cli'
    && uniqueSorted(rows.map(row => row.provider)).join(',') === 'claude,codex'
    && new Set(rows.map(row => row.sessionId)).size === 2
    && new Set(rows.map(row => row.keyId)).size === 2
    && rows.every(row => row.decision === 'pass'));
}

function verifyObservation(
  gitCwd: string,
  record: AcceptanceRolloutSourceRecordV1,
): VerifiedRolloutObservation {
  const empty: VerifiedRolloutObservation = {
    valid: false,
    adapterProfile: 'unsupported',
    transcriptPresent: false,
    mutationBites: false,
    detected: false,
    blocked: true,
    reviewRounds: 0,
    waiverCount: 0,
    checkInventory: [],
    costUnits: 0,
    full3x2: false,
  };
  if (LEGACY_CALLER_OBSERVATION_FIELDS.some(field => Object.prototype.hasOwnProperty.call(record, field))) return empty;
  const receipt = record.observationReceipt;
  if (!receipt || receipt.schemaVersion !== 'proofstory.acceptance_rollout_observation_receipt.v1') return empty;
  const trusted = registeredPublicKey(gitCwd);
  if (!trusted
    || receipt.signerPublicKey !== trusted
    || receipt.issuerKeyId !== digest(trusted)
    || receipt.storyId !== record.storyId
    || receipt.pairId !== record.pairId
    || receipt.arm !== record.arm
    || !verifyCanonical(unsignedObservation(receipt), receipt.signature, trusted)) return empty;
  if (receipt.gateArtifacts.length !== 2
    || uniqueSorted(receipt.gateArtifacts.map(item => item.command)).join(',') !== 'acceptance_topology_check,pre_review_check'
    || !receipt.gateArtifacts.every(item => verifyGateArtifact(record, item))
    || !receipt.hostVerdicts.every(item => verifyHostVerdict(record, item))) return empty;
  const quorum = receipt.quorumReceipt;
  if (quorum.schemaVersion !== 'lattice.quorum_submit.v1'
    || quorum.storyId !== record.storyId
    || quorum.rounds !== 3
    || quorum.emittedCount !== 6
    || quorum.assuranceLevel !== 'full-3x2'
    || uniqueSorted(quorum.verdictIds).join(',') !== uniqueSorted(receipt.hostVerdicts.map(item => item.verdictId)).join(',')
    || uniqueSorted(quorum.runIds).join(',') !== uniqueSorted(receipt.hostVerdicts.map(item => item.runId)).join(',')
    || quorum.reviewerPasses.length === 0
    || !/^[a-f0-9]{40}$/.test(quorum.metadataCommitSha)) return empty;
  const full3x2 = full3x2FromReceipts(receipt.hostVerdicts);
  const gateFailures = receipt.gateArtifacts.filter(item => {
    const status = String(item.report.status ?? '');
    const ok = item.report.ok;
    const diagnostics = item.command === 'pre_review_check'
      ? item.report.codes
      : item.report.diagnostics;
    return (status === 'fail' || ok === false) && Array.isArray(diagnostics) && diagnostics.length > 0;
  });
  const mutationBites = receipt.mutationResults.length > 0
    && receipt.mutationResults.every(item =>
      item.expectedCode.length > 0 && item.expectedCode === item.observedCode && item.controlRestored === true);
  const costUnits = receipt.usageEvents.reduce((sum, event) =>
    sum + (Number.isFinite(event.costUnits) && event.costUnits >= 0 ? event.costUnits : Number.NaN), 0);
  if (!Number.isFinite(costUnits)
    || new Set(receipt.reviewRoundIds).size !== receipt.reviewRoundIds.length
    || new Set(receipt.waiverRefs).size !== receipt.waiverRefs.length
    || new Set(receipt.checkInventory).size !== receipt.checkInventory.length) return empty;
  return {
    valid: true,
    adapterProfile: full3x2 ? ACCEPTANCE_ROLLOUT_SUPPORTED_ADAPTER : 'unsupported',
    transcriptPresent: receipt.transcriptRefs.length > 0,
    mutationBites,
    detected: record.defectPresent && gateFailures.length > 0,
    blocked: gateFailures.some(item => item.report.blocking === true || item.report.ok === false),
    reviewRounds: receipt.reviewRoundIds.length,
    waiverCount: receipt.waiverRefs.length,
    checkInventory: [...receipt.checkInventory],
    costUnits,
    full3x2,
  };
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
  gitCwd: string;
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
    if (!verifyObservation(args.gitCwd, record).valid) diagnostics.add('AR_SOURCE_EVIDENCE_INVALID');
  }
  const sourceInventoryDigest = digest(canonicalRecords);
  if (cohort.sourceInventoryDigest !== sourceInventoryDigest) diagnostics.add('AR_MEMBERSHIP_DIGEST_MISMATCH');

  const eligibleRecords = canonicalRecords.filter(record => recordIsEligible(record, cohort.evaluationWindow));
  const observationByRecord = new Map(eligibleRecords.map(record => [record, verifyObservation(args.gitCwd, record)]));
  const unsupported = eligibleRecords.filter(record =>
    observationByRecord.get(record)?.adapterProfile !== ACCEPTANCE_ROLLOUT_SUPPORTED_ADAPTER);
  if (unsupported.length > 0) diagnostics.add('AR_ADAPTER_UNSUPPORTED');
  const supported = eligibleRecords.filter(record =>
    observationByRecord.get(record)?.adapterProfile === ACCEPTANCE_ROLLOUT_SUPPORTED_ADAPTER);
  const baseline = supported.filter(record => record.arm === 'baseline');
  const candidate = supported.filter(record => record.arm === 'candidate');
  const membership = pairedMembership(supported);

  if (baseline.length < ACCEPTANCE_ROLLOUT_MIN_MATCHED_PAIRS
    || candidate.length < ACCEPTANCE_ROLLOUT_MIN_MATCHED_PAIRS
    || membership.length < ACCEPTANCE_ROLLOUT_MIN_MATCHED_PAIRS) diagnostics.add('AR_SAMPLE_COUNT_LT_3');
  if (membership.length !== new Set([...baseline, ...candidate].map(record => record.pairId)).size) {
    diagnostics.add('AR_MATCHED_PAIR_MISSING');
  }

  if (candidate.some(record => needsTranscript(record) && !observationByRecord.get(record)?.transcriptPresent)) diagnostics.add('AR_TRANSCRIPT_REQUIRED');
  if (candidate.some(record => needsMutation(record) && !observationByRecord.get(record)?.mutationBites)) {
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
    const observation = record ? observationByRecord.get(record) : undefined;
    return !record || !record.defectPresent || !observation?.detected || !observation.blocked;
  }).length;
  if (falsePassCount > 0) diagnostics.add('AR_FALSE_PASS_NONZERO');

  const omissionRecords = registeredSeedIds
    .map(seedId => seededById.get(seedId))
    .filter((record): record is AcceptanceRolloutSourceRecordV1 => record?.defectClass === 'omission');
  const omissionDetected = omissionRecords.filter(record => {
    const observation = observationByRecord.get(record);
    return observation?.detected && observation.blocked;
  });
  const omissionDetectionRate = omissionRecords.length === 0 ? 0 : omissionDetected.length / omissionRecords.length;
  if (omissionRecords.length === 0 || omissionDetectionRate !== 1) diagnostics.add('AR_OMISSION_DETECTION_BELOW_100');

  const falseBlockCount = candidate.filter(record => observationByRecord.get(record)?.blocked && !record.shouldBlock).length;
  if (falseBlockCount > 0) diagnostics.add('AR_FALSE_BLOCK_NONZERO');

  const mislabeled3x1Count = candidate.filter(record => !observationByRecord.get(record)?.full3x2).length;
  if (mislabeled3x1Count > 0) diagnostics.add('AR_MISLABELED_3X1_NONZERO');
  if (candidate.some(record => !observationByRecord.get(record)?.full3x2)) diagnostics.add('AR_QUORUM_NOT_FULL_3X2');

  const waiverDelta = candidate.reduce((sum, record) => sum + (observationByRecord.get(record)?.waiverCount ?? 0), 0)
    - baseline.reduce((sum, record) => sum + (observationByRecord.get(record)?.waiverCount ?? 0), 0);
  if (waiverDelta > 0) diagnostics.add('AR_WAIVER_DELTA_POSITIVE');

  const baselineByPair = new Map(baseline.map(record => [record.pairId, record]));
  const inventoryShrankCount = candidate.filter(record => {
    const before = baselineByPair.get(record.pairId);
    const beforeInventory = before ? observationByRecord.get(before)?.checkInventory ?? [] : [];
    const afterInventory = observationByRecord.get(record)?.checkInventory ?? [];
    return Boolean(before && beforeInventory.some(check => !afterInventory.includes(check)));
  }).length;
  if (inventoryShrankCount > 0) diagnostics.add('AR_CHECK_INVENTORY_SHRANK');

  const metrics: AcceptanceRolloutMetricsV1 = {
    ...zeroMetrics(),
    matchedPairCount: membership.length,
    baselineSampleCount: baseline.length,
    candidateSampleCount: candidate.length,
    registeredSeedCount: registeredSeedIds.length,
    detectedSeedCount: registeredSeedIds.filter(seedId => {
      const record = seededById.get(seedId);
      return record ? observationByRecord.get(record)?.detected : false;
    }).length,
    falsePassCount,
    omissionSeedCount: omissionRecords.length,
    omissionDetectedCount: omissionDetected.length,
    omissionDetectionRate,
    falseBlockCount,
    falseBlockRate: candidate.length === 0 ? 0 : falseBlockCount / candidate.length,
    mislabeled3x1Count,
    waiverDelta,
    inventoryShrankCount,
    baselineReviewRounds: baseline.reduce((sum, record) => sum + (observationByRecord.get(record)?.reviewRounds ?? 0), 0),
    candidateReviewRounds: candidate.reduce((sum, record) => sum + (observationByRecord.get(record)?.reviewRounds ?? 0), 0),
    baselineCostUnits: baseline.reduce((sum, record) => sum + (observationByRecord.get(record)?.costUnits ?? 0), 0),
    candidateCostUnits: candidate.reduce((sum, record) => sum + (observationByRecord.get(record)?.costUnits ?? 0), 0),
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
  gitCwd: string,
): boolean {
  const recomputed = deriveAcceptanceRolloutReport({
    storyId: report.storyId,
    cohort,
    binding: {
      headHash: report.binding.headHash,
      materialHash: report.binding.materialHash,
      storyFilesHash: report.binding.storyFilesHash,
    },
    gitCwd,
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
  if (args.expectedCohort && !reportMatchesRecomputation(report, args.expectedCohort, args.gitCwd)) {
    diagnostics.add(report.sourceInventoryDigest === args.expectedCohort.sourceInventoryDigest
      ? 'AR_REPORT_TAMPERED'
      : 'AR_ELIGIBLE_MEMBERSHIP_INCOMPLETE');
  }
  const runnerPath = join(args.gitCwd, 'scripts/run-proofstory-acceptance-rollout-cohort.mjs');
  if (!existsSync(runnerPath) || report.binding.runnerDigest !== byteDigest(readFileSync(runnerPath))) {
    diagnostics.add('AR_REPORT_STALE');
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
