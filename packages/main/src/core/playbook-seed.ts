import { digestCanonicalJson } from './digest.js';
import type {
  NonDeducibleSourceRecord,
  Playbook,
  PlaybookAutoActivationEvent,
  PlaybookLineage,
  PlaybookOutcomeEvent,
  PlaybookPromotionDecisionRow,
  PlaybookProposal,
  PlaybookSeedMaterial,
  PlaybookSeedReference,
  PlaybookSeedSourceKind,
  PlaybookStatus,
  PlaybookTrialControlEvent,
  PlaybookTrigger,
  SourceLineageArtifactKind,
  SourceLineageAuditRecord,
  SourceLineageAuditReport,
} from './experience-layer-types.js';
import type { Finding } from './types.js';
import {
  aggregatePlaybookPromotion,
  appendPlaybookOutcomeEvent,
  appendPlaybookPromotionDecision,
  appendPlaybookAutoActivationEvent,
  appendPlaybookTrialControlEvent,
  assertCanAppendPlaybookAutoActivationEvents,
  computePlaybookDigest,
  computePlaybookProposalDigest,
  deleteProposal,
  DEFAULT_PLAYBOOK_PROMOTION_CONFIG,
  evaluatePlaybookPromotion,
  isCandidateConsumedPlaybookOutcome,
  listProposals,
  markNonDeducibleSource,
  readNonDeducibleSourcesRegistry,
  readPlaybookAutoActivationEvents,
  readPlaybookOutcomeEventsWithDiagnostics,
  readPlaybookPromotionDecisionRows,
  readPlaybooks,
  readPlaybookTrialControlEventsWithDiagnostics,
  validatePlaybook,
  writePlaybooks,
  writeProposal,
} from './learning-store.js';
import { buildMemoryFreshnessPack, type RuntimeConsumer } from './playbook-runtime-memory.js';
import { buildLearningSourceLineageAudit } from './source-lineage-audit.js';

export const PLAYBOOK_SEED_OBSERVE_SCHEMA_VERSION = 'proofbound.playbook-seed-observe.v1' as const;
export const PLAYBOOK_SEED_PROPOSE_BATCH_SCHEMA_VERSION = 'proofbound.playbook-seed-propose-batch.v1' as const;
export const PLAYBOOK_SEED_BACKFILL_SCHEMA_VERSION = 'proofbound.playbook-seed-backfill.v1' as const;
export const PLAYBOOK_CANDIDATE_BATCH_MANIFEST_SCHEMA_VERSION = 'proofbound.playbook-candidate-batch-manifest.v1' as const;
export const PLAYBOOK_CANDIDATE_INGEST_SCHEMA_VERSION = 'proofbound.playbook-candidate-ingest.v1' as const;
export const PLAYBOOK_RUNTIME_CONSUMPTION_VERIFY_SCHEMA_VERSION = 'proofbound.playbook-runtime-consumption-verify.v1' as const;
export const PLAYBOOK_TRIAL_RUN_SCHEMA_VERSION = 'proofbound.playbook-trial-run.v1' as const;
export const PLAYBOOK_PROMOTION_TIMER_SCHEMA_VERSION = 'proofbound.playbook-promotion-timer.v1' as const;
export const PLAYBOOK_AUTO_PROMOTION_APPLY_SCHEMA_VERSION = 'proofbound.playbook-auto-promotion-apply.v1' as const;

const ID_SUFFIX_RE = /^PBP?-(\d+)$/;
const SEED_SOURCE_KINDS: readonly PlaybookSeedSourceKind[] = ['dev_memory', 'finding_signal', 'done_experience', 'finding'] as const;
const SEED_KIND_PRIORITY: Record<PlaybookSeedSourceKind, number> = {
  dev_memory: 1,
  finding_signal: 2,
  done_experience: 3,
  finding: 4,
};
const FINDING_SIGNAL_MIN_SUPPORT = 1;
const REPRESENTED_KINDS = new Set<SourceLineageArtifactKind>(['playbook_proposal', 'playbook']);
const RUNTIME_VERIFY_CONSUMERS: RuntimeConsumer[] = [
  'session_brief',
  'dev_memory_start',
  'story_create',
  'story_advance',
  'done_prepare',
  'done_closure',
  'final_response_check',
];

const REVIEWED_EVIDENCE_ACTIVATION_POLICY_DOMAIN = {
  policyId: 'proofbound.evidence-activated-advisory-playbook.v1',
  reviewedBy: 'B-7ee1-plan-and-review',
  thresholds: {
    minDecisiveSamples: DEFAULT_PLAYBOOK_PROMOTION_CONFIG.minDecisiveSamples,
    minHelpedCount: DEFAULT_PLAYBOOK_PROMOTION_CONFIG.minHelpedCount,
    minContextClasses: DEFAULT_PLAYBOOK_PROMOTION_CONFIG.minContextClasses,
    maxDismissalRate: DEFAULT_PLAYBOOK_PROMOTION_CONFIG.maxDismissalRate,
    maxHarmfulCount: DEFAULT_PLAYBOOK_PROMOTION_CONFIG.maxHarmfulCount,
    maxWrongClaimCount: DEFAULT_PLAYBOOK_PROMOTION_CONFIG.maxWrongClaimCount,
  },
} as const;

const REVIEWED_EVIDENCE_ACTIVATION_POLICY: PlaybookEvidenceActivationPolicy = {
  ...REVIEWED_EVIDENCE_ACTIVATION_POLICY_DOMAIN,
  policyDigest: digestCanonicalJson(REVIEWED_EVIDENCE_ACTIVATION_POLICY_DOMAIN),
};

export type PlaybookSeedSourceFilter = 'all' | 'dev-memory' | 'finding-signals' | 'done-experience' | 'raw-findings';

export interface PlaybookSeedStorePort {
  listStoryIds(): string[];
  readStory?(storyId: string): { phase?: unknown; title?: unknown; description?: unknown; type?: unknown };
  readFindings(storyId: string): { findings?: unknown[] };
  readSummary?(storyId: string): unknown | null;
  readDeliveryCheck?(storyId: string): unknown | null;
  storyFilePath?(storyId: string, file: string): string;
}

export interface PlaybookSeedCandidate extends PlaybookSeedMaterial {
  seedId: string;
  sourceArtifactKind: PlaybookSeedSourceKind;
  sourceArtifactId: string;
  sourceRef: string;
  canonicalSourceKey: string;
  canonicalSourceKeyVersion: string;
  canonicalizationPolicyHash: string;
  rawSourceKey?: string;
  sourceStoryId?: string;
  sourceFindingId?: string;
  sourceSignature?: string;
  priority: number;
  priorityReason: string;
}

export interface PlaybookSeedBlocked extends PlaybookSeedCandidate {
  blockReasons: string[];
  representingArtifacts?: Array<{
    artifactKind: SourceLineageArtifactKind;
    artifactId: string;
    sourceRef: string;
    status?: PlaybookStatus;
  }>;
  nonPromotableSource?: NonDeducibleSourceRecord;
}

export interface PlaybookDuplicateSeedGroup {
  canonicalSourceKey: string;
  primarySeedId: string;
  records: PlaybookSeedCandidate[];
}

export interface PlaybookSeedObserveReport {
  schemaVersion: typeof PLAYBOOK_SEED_OBSERVE_SCHEMA_VERSION;
  observedAt: string;
  sourceFilter: PlaybookSeedSourceFilter;
  audit: Pick<
    SourceLineageAuditReport,
    | 'sourceRecordCount'
    | 'missingLineageCount'
    | 'canonicalSourceKeyVersion'
    | 'canonicalizationPolicyHash'
  >;
  proposableSeeds: PlaybookSeedCandidate[];
  blockingSeeds: PlaybookSeedBlocked[];
  duplicateSeedGroups: PlaybookDuplicateSeedGroup[];
  duplicateCanonicalSourceGroups: SourceLineageAuditReport['duplicateCanonicalSourceGroups'];
  missingLineage: SourceLineageAuditRecord[];
  nonPromotableBlocks: PlaybookSeedBlocked[];
  alreadyRepresentedSources: PlaybookSeedBlocked[];
  rawFindingsWithoutDistilledExperience: PlaybookSeedCandidate[];
  diagnostics: SourceLineageAuditReport['diagnostics'];
  observeDigest: string;
  authority: 'non_authoritative';
  gateEvidence: false;
}

export interface PlaybookSeedProposalPreview {
  proposalId: string;
  seed: PlaybookSeedCandidate;
  proposalDigest: string;
  candidatePlaybookDigest: string;
  title: string;
  sourceLineage: PlaybookLineage;
}

export interface PlaybookSeedProposalBatchReport {
  schemaVersion: typeof PLAYBOOK_SEED_PROPOSE_BATCH_SCHEMA_VERSION;
  dryRun: boolean;
  applied: boolean;
  sourceFilter: PlaybookSeedSourceFilter;
  limit: number;
  observeDigest: string;
  expectedObserveDigest?: string;
  proposalManifestDigest: string;
  proposalCount: number;
  proposals: PlaybookSeedProposalPreview[];
  blockedSeedCount: number;
  skippedSeedCount: number;
  authority: 'non_authoritative';
  gateEvidence: false;
}

export interface PlaybookSeedBackfillCandidateRow {
  playbookId: string;
  seedId: string;
  sourceArtifactKind: PlaybookSeedSourceKind;
  sourceArtifactId: string;
  canonicalSourceKey: string;
  candidatePlaybookDigest: string;
  fromStagedProposal: boolean;
  title: string;
}

export interface PlaybookSeedBackfillBlockedRow {
  seedId: string;
  canonicalSourceKey: string;
  sourceArtifactKind: PlaybookSeedSourceKind;
  sourceArtifactId: string;
  reasons: string[];
}

export interface PlaybookSeedBackfillReport {
  schemaVersion: typeof PLAYBOOK_SEED_BACKFILL_SCHEMA_VERSION;
  dryRun: boolean;
  applied: boolean;
  sourceFilter: PlaybookSeedSourceFilter;
  limit: number | null;
  observeDigest: string;
  expectedObserveDigest?: string;
  selectedSeedCount: number;
  plannedCount: number;
  createdCount: number;
  skippedCount: number;
  blockedCount: number;
  alreadyRepresentedCount: number;
  stagedProposalCount: number;
  deletedProposalCount: number;
  createdPlaybookIds: string[];
  candidates: PlaybookSeedBackfillCandidateRow[];
  blocked: PlaybookSeedBackfillBlockedRow[];
  authority: 'non_authoritative';
  gateEvidence: false;
}

export interface PlaybookCandidateBatchManifestRow {
  proposalId: string;
  proposalDigest: string;
  candidatePlaybookDigest: string;
  canonicalSourceKey: string;
  sourceArtifactKind: PlaybookSeedSourceKind;
  sourceArtifactId: string;
  title: string;
}

export interface PlaybookCandidateBatchManifestReport {
  schemaVersion: typeof PLAYBOOK_CANDIDATE_BATCH_MANIFEST_SCHEMA_VERSION;
  dryRun: boolean;
  applied: boolean;
  manifestDigest: string;
  expectedManifestDigest?: string;
  proposalIdFilter?: string[];
  canonicalSourceKeyFilter?: string[];
  sourceFilter?: PlaybookSeedSourceFilter;
  storyId?: string;
  proposalCount: number;
  proposals: PlaybookCandidateBatchManifestRow[];
  invalidProposals: Array<{ proposalId: string; reason: string }>;
  candidatePlaybookIds: string[];
  authority: 'non_authoritative';
  gateEvidence: false;
}

export interface PlaybookCandidateIngestReport {
  schemaVersion: typeof PLAYBOOK_CANDIDATE_INGEST_SCHEMA_VERSION;
  dryRun: boolean;
  applied: boolean;
  sourceFilter: PlaybookSeedSourceFilter;
  storyId?: string;
  limit: number;
  observeDigest: string;
  proposalManifestDigest: string;
  manifestDigest: string;
  proposedCount: number;
  candidateCreatedCount: number;
  candidatePlaybookIds: string[];
  skippedCount: number;
  blockedCount: number;
  skippedSeedCount: number;
  blockedSeedCount: number;
  invalidProposalCount: number;
  authority: 'non_authoritative';
  gateEvidence: false;
}

export interface PlaybookRuntimeConsumptionVerifyReport {
  schemaVersion: typeof PLAYBOOK_RUNTIME_CONSUMPTION_VERIFY_SCHEMA_VERSION;
  verifiedAt: string;
  status: 'pass' | 'warn';
  activeChecks: Array<{
    playbookId: string;
    query: string;
    consumedByAll: boolean;
    consumers: Array<{
      consumer: RuntimeConsumer;
      consumed: boolean;
      playbookIds: string[];
      packDigest: string;
    }>;
  }>;
  candidateInertness: Array<{
    playbookId: string;
    query: string;
    inert: boolean;
    observedPlaybookIds: string[];
    label: 'pending learning only';
  }>;
  diagnostics: string[];
  authority: 'non_authoritative';
  gateEvidence: false;
}

export interface PlaybookTrialObservationRow {
  playbookId: string;
  playbookDigest: string;
  outcomeIdempotencyKey: string;
  controlIdempotencyKey: string;
  outcomeAlreadyExists: boolean;
  controlAlreadyExists: boolean;
}

export interface PlaybookTrialRunReport {
  schemaVersion: typeof PLAYBOOK_TRIAL_RUN_SCHEMA_VERSION;
  dryRun: boolean;
  applied: boolean;
  storyId: string;
  consumer: string;
  playbookId?: string;
  limit: number | null;
  candidateCount: number;
  selectedCount: number;
  skippedByLimitCount: number;
  skippedNonCandidateCount: number;
  outcomeCreatedCount: number;
  outcomeAlreadyExistsCount: number;
  controlCreatedCount: number;
  controlAlreadyExistsCount: number;
  observations: PlaybookTrialObservationRow[];
  authority: 'non_authoritative';
  gateEvidence: false;
}

export type PlaybookPromotionTimerStepName = 'backfill' | 'trial' | 'sweep' | 'activate';
export type PlaybookPromotionTimerStepStatus = 'disabled' | 'skipped' | 'blocked' | 'applied' | 'dry-run';

export interface PlaybookPromotionTimerStep {
  step: PlaybookPromotionTimerStepName;
  requested: boolean;
  status: PlaybookPromotionTimerStepStatus;
  applied: boolean;
  dryRun: boolean;
  limit: number | null;
  message: string;
  detail?: unknown;
}

export interface PlaybookPromotionTimerReport {
  schemaVersion: typeof PLAYBOOK_PROMOTION_TIMER_SCHEMA_VERSION;
  dryRun: boolean;
  applied: boolean;
  sourceFilter: PlaybookSeedSourceFilter;
  storyId?: string;
  bounded: true;
  limits: {
    backfill: number;
    trial: number;
    sweep: number;
  };
  steps: PlaybookPromotionTimerStep[];
  authority: 'non_authoritative';
  gateEvidence: false;
}

export interface PlaybookAutoPromotionCandidateGuard {
  playbookId: string;
  playbookDigest: string;
  aggregateDigest: string;
  promotionDecisionId?: string;
  promotionDecisionIdempotencyKey?: string;
  promotionDecisionDigest?: string;
  recommendation: string;
  reasonCodes: string[];
  eligible: boolean;
  blockers: string[];
  activationIdempotencyKey: string;
  realOutcomeCount: number;
  exposureCount: number;
  decisiveSamples: number;
  helpedCount: number;
  dismissedCount: number;
  harmfulCount: number;
  wrongClaimCount: number;
  contextClassCount: number;
  lineageCanonicalSourceKey?: string;
}

export interface PlaybookEvidenceActivationPolicy {
  policyId: string;
  policyDigest: string;
  reviewedBy: string;
  thresholds: {
    minDecisiveSamples: number;
    minHelpedCount: number;
    minContextClasses: number;
    maxDismissalRate: number;
    maxHarmfulCount: number;
    maxWrongClaimCount: number;
  };
}

export interface PlaybookAutoPromotionActivationSummary {
  playbookId: string;
  activationId: string;
  candidatePlaybookDigest: string;
  activePlaybookDigest: string;
  aggregateDigest: string;
  promotionDecisionDigest: string;
  policyDigest: string;
}

export interface PlaybookAutoPromotionDemotionRecommendation {
  playbookId: string;
  aggregateDigest: string;
  recommendation: string;
  reasonCodes: string[];
  autoActivated: boolean;
}

export interface PlaybookAutoPromotionApplyReport {
  schemaVersion: typeof PLAYBOOK_AUTO_PROMOTION_APPLY_SCHEMA_VERSION;
  dryRun: boolean;
  applied: boolean;
  activationImplemented: true;
  activationPolicy: PlaybookEvidenceActivationPolicy | null;
  prerequisites: string[];
  candidateGuards: PlaybookAutoPromotionCandidateGuard[];
  globalBlockers: string[];
  activatedCount: number;
  skippedCount: number;
  blockedCount: number;
  activatedPlaybooks: PlaybookAutoPromotionActivationSummary[];
  demotionRecommendations: PlaybookAutoPromotionDemotionRecommendation[];
  authority: 'non_authoritative';
  gateEvidence: false;
}

export interface BuildPlaybookSeedObservationOptions {
  projectRoot: string;
  store: PlaybookSeedStorePort;
  source?: string;
  storyId?: string;
  now?: string;
}

export interface BuildPlaybookSeedProposalBatchOptions extends BuildPlaybookSeedObservationOptions {
  apply?: boolean;
  limit?: number;
  observeDigest?: string;
}

export interface BuildPlaybookSeedBackfillOptions extends BuildPlaybookSeedObservationOptions {
  apply?: boolean;
  limit?: number;
  observeDigest?: string;
}

export interface BuildPlaybookCandidateBatchOptions {
  projectRoot: string;
  store: PlaybookSeedStorePort;
  apply?: boolean;
  limit?: number;
  manifestDigest?: string;
  proposalIds?: string[];
  canonicalSourceKeys?: string[];
  source?: string;
  storyId?: string;
}

export interface BuildPlaybookCandidateIngestOptions extends BuildPlaybookSeedObservationOptions {
  apply?: boolean;
  limit?: number;
}

export interface BuildPlaybookRuntimeConsumptionVerifyOptions {
  projectRoot: string;
  now?: string;
}

export interface BuildPlaybookTrialRunOptions {
  projectRoot: string;
  store: PlaybookSeedStorePort;
  storyId: string;
  playbookId?: string;
  consumer?: string;
  apply?: boolean;
  limit?: number;
  now?: string;
}

export interface BuildPlaybookPromotionTimerOptions {
  projectRoot: string;
  store: PlaybookSeedStorePort;
  apply?: boolean;
  backfill?: boolean;
  trial?: boolean;
  sweep?: boolean;
  activate?: boolean;
  backfillLimit?: number;
  trialLimit?: number;
  sweepLimit?: number;
  source?: string;
  storyId?: string;
  now?: string;
  sweepApplyEnabled?: boolean;
}

export interface BuildPlaybookAutoPromotionApplyOptions {
  projectRoot: string;
  store: PlaybookSeedStorePort;
  apply?: boolean;
  activationPolicy?: PlaybookEvidenceActivationPolicy | null;
  now?: string;
}

function idSuffix(id: string): number {
  const match = id.match(ID_SUFFIX_RE);
  return match ? Number(match[1]) : 0;
}

function nextProposalIds(existingProposals: PlaybookProposal[], playbooks: Playbook[], count: number): string[] {
  let max = 0;
  for (const proposal of existingProposals) max = Math.max(max, idSuffix(proposal.id));
  for (const playbook of playbooks) max = Math.max(max, idSuffix(playbook.id));
  return Array.from({ length: count }, (_, index) => `PBP-${String(max + index + 1).padStart(3, '0')}`);
}

function isSeedKind(kind: SourceLineageArtifactKind): kind is PlaybookSeedSourceKind {
  return (SEED_SOURCE_KINDS as readonly string[]).includes(kind);
}

function normalizeSourceFilter(source: string | undefined): PlaybookSeedSourceFilter {
  const value = (source ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!value || value === 'all') return 'all';
  if (value === 'dev-memory' || value === 'dev-memories') return 'dev-memory';
  if (value === 'finding-signals' || value === 'finding-signal') return 'finding-signals';
  if (value === 'done-experience' || value === 'done-experiences' || value === 'done') return 'done-experience';
  if (value === 'raw-findings' || value === 'raw-finding' || value === 'findings' || value === 'finding') return 'raw-findings';
  throw new Error(`playbook_seed_observe: unsupported source ${JSON.stringify(source)} (supported: dev-memory, finding-signals, done-experience, raw-findings)`);
}

function normalizeStoryFilter(storyId: string | undefined): string | undefined {
  const value = (storyId ?? '').trim();
  return value || undefined;
}

function sourceFilterKinds(filter: PlaybookSeedSourceFilter): Set<PlaybookSeedSourceKind> {
  if (filter === 'dev-memory') return new Set(['dev_memory']);
  if (filter === 'finding-signals') return new Set(['finding_signal']);
  if (filter === 'done-experience') return new Set(['done_experience']);
  if (filter === 'raw-findings') return new Set(['finding']);
  return new Set(SEED_SOURCE_KINDS);
}

function seedKindLabel(kind: PlaybookSeedSourceKind): string {
  return kind.replace(/_/g, '-');
}

function uniqSorted(values: Iterable<string | undefined>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const trimmed = (value ?? '').trim();
    if (trimmed) out.add(trimmed);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

function seedKeywords(text: string): string[] {
  return uniqSorted(text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).slice(0, 8);
}

function trimTo(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? compact.slice(0, limit - 1).trimEnd() : compact;
}

function fileKind(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : 'noext';
}

function storyIdFromFindingId(findingId: string | undefined): string | undefined {
  if (!findingId) return undefined;
  const idx = findingId.indexOf(':');
  return idx > 0 ? findingId.slice(0, idx) : undefined;
}

function normalizeFindingId(sourceStoryId: string | undefined, sourceFindingId: string | undefined): string | undefined {
  if (!sourceFindingId) return undefined;
  return sourceFindingId.includes(':') ? sourceFindingId : sourceStoryId ? `${sourceStoryId}:${sourceFindingId}` : sourceFindingId;
}

function seedId(record: SourceLineageAuditRecord): string {
  return `PBS-${digestCanonicalJson({
    artifactId: record.artifactId,
    artifactKind: record.artifactKind,
    canonicalSourceKey: record.canonicalSourceKey,
    sourceRef: record.sourceRef,
  }).slice(0, 16)}`;
}

function toSeedCandidate(record: SourceLineageAuditRecord): PlaybookSeedCandidate {
  const kind = record.artifactKind as PlaybookSeedSourceKind;
  return {
    seedId: seedId(record),
    sourceArtifactKind: kind,
    sourceArtifactId: record.artifactId,
    sourceRef: record.sourceRef,
    canonicalSourceKey: record.canonicalSourceKey ?? '',
    canonicalSourceKeyVersion: record.canonicalSourceKeyVersion,
    canonicalizationPolicyHash: record.canonicalizationPolicyHash,
    ...(record.rawSourceKey ? { rawSourceKey: record.rawSourceKey } : {}),
    ...(record.sourceStoryId ? { sourceStoryId: record.sourceStoryId } : {}),
    ...(record.sourceFindingId ? { sourceFindingId: record.sourceFindingId } : {}),
    ...(record.sourceSignature ? { sourceSignature: record.sourceSignature } : {}),
    ...(record.sourceSummary ? { sourceSummary: record.sourceSummary } : {}),
    ...(record.sourcePitfalls && record.sourcePitfalls.length > 0 ? { sourcePitfalls: record.sourcePitfalls } : {}),
    ...(record.sourceVerification && record.sourceVerification.length > 0 ? { sourceVerification: record.sourceVerification } : {}),
    priority: SEED_KIND_PRIORITY[kind],
    priorityReason: `${seedKindLabel(kind)} source priority ${SEED_KIND_PRIORITY[kind]}`,
  };
}

function sortSeeds<T extends PlaybookSeedCandidate>(seeds: T[]): T[] {
  return seeds.slice().sort((a, b) =>
    a.priority - b.priority
    || a.canonicalSourceKey.localeCompare(b.canonicalSourceKey)
    || a.sourceArtifactKind.localeCompare(b.sourceArtifactKind)
    || a.sourceArtifactId.localeCompare(b.sourceArtifactId)
    || a.seedId.localeCompare(b.seedId));
}

function representedArtifacts(
  canonicalSourceKey: string,
  audit: SourceLineageAuditReport,
  playbookStatusById: Map<string, PlaybookStatus>,
): NonNullable<PlaybookSeedBlocked['representingArtifacts']> {
  return audit.records
    .filter((record) => record.canonicalSourceKey === canonicalSourceKey && REPRESENTED_KINDS.has(record.artifactKind))
    .map((record) => ({
      artifactKind: record.artifactKind,
      artifactId: record.artifactId,
      sourceRef: record.sourceRef,
      ...(playbookStatusById.get(record.artifactId) ? { status: playbookStatusById.get(record.artifactId) } : {}),
    }))
    .sort((a, b) => `${a.artifactKind}:${a.artifactId}`.localeCompare(`${b.artifactKind}:${b.artifactId}`));
}

function nonPromotableForSeed(
  seed: PlaybookSeedCandidate,
  groupRecords: SourceLineageAuditRecord[],
  registrySources: NonDeducibleSourceRecord[],
): NonDeducibleSourceRecord | undefined {
  const sourceKeys = new Set(uniqSorted([
    seed.rawSourceKey,
    ...groupRecords.map((record) => record.rawSourceKey),
  ]));
  return registrySources.find((record) => sourceKeys.has(record.source.sourceKey));
}

function findingSignalQualityBlockReasons(record: SourceLineageAuditRecord): string[] {
  if (record.artifactKind !== 'finding_signal') return [];
  const support = typeof record.support === 'number' && Number.isFinite(record.support) ? record.support : 0;
  const anchors = record.anchorRefs ?? [];
  const reasons: string[] = [];
  if (support < FINDING_SIGNAL_MIN_SUPPORT) reasons.push('finding_signal_insufficient_support');
  if (anchors.length === 0) reasons.push('finding_signal_missing_valid_anchors');
  return reasons;
}

function computeObserveDigest(report: Omit<PlaybookSeedObserveReport, 'observeDigest'>): string {
  return digestCanonicalJson({
    audit: report.audit,
    sourceFilter: report.sourceFilter,
    proposableSeeds: report.proposableSeeds,
    blockingSeeds: report.blockingSeeds,
    duplicateSeedGroups: report.duplicateSeedGroups,
    duplicateCanonicalSourceGroups: report.duplicateCanonicalSourceGroups,
    missingLineage: report.missingLineage,
    nonPromotableBlocks: report.nonPromotableBlocks,
    alreadyRepresentedSources: report.alreadyRepresentedSources,
    rawFindingsWithoutDistilledExperience: report.rawFindingsWithoutDistilledExperience,
    diagnostics: report.diagnostics,
    authority: report.authority,
    gateEvidence: report.gateEvidence,
    schemaVersion: report.schemaVersion,
  });
}

export function buildPlaybookSeedObservation(opts: BuildPlaybookSeedObservationOptions): PlaybookSeedObserveReport {
  const sourceFilter = normalizeSourceFilter(opts.source);
  const allowedKinds = sourceFilterKinds(sourceFilter);
  const storyFilter = normalizeStoryFilter(opts.storyId);
  const audit = buildLearningSourceLineageAudit({
    projectRoot: opts.projectRoot,
    store: opts.store,
    now: opts.now ?? 'deterministic-observe-digest-time',
  });
  const playbookStatusById = new Map<string, PlaybookStatus>();
  for (const playbook of readPlaybooks(opts.projectRoot)) {
    if (typeof playbook.id === 'string' && typeof playbook.status === 'string') {
      playbookStatusById.set(playbook.id, playbook.status);
    }
  }
  const registry = readNonDeducibleSourcesRegistry(opts.projectRoot);
  const missingLineage: SourceLineageAuditRecord[] = [];
  const blockingSeeds: PlaybookSeedBlocked[] = [];
  const nonPromotableBlocks: PlaybookSeedBlocked[] = [];
  const alreadyRepresentedSources: PlaybookSeedBlocked[] = [];
  const seedRecords = audit.records
    .filter((record) => isSeedKind(record.artifactKind))
    .filter((record) => !storyFilter || record.sourceStoryId === storyFilter);
  const byCanonical = new Map<string, SourceLineageAuditRecord[]>();

  for (const record of seedRecords) {
    if (!allowedKinds.has(record.artifactKind as PlaybookSeedSourceKind)) continue;
    if (!record.lineagePresent || !record.canonicalSourceKey || !record.sourceStoryId || !record.sourceFindingId) {
      missingLineage.push(record);
      const seed = toSeedCandidate({ ...record, canonicalSourceKey: record.canonicalSourceKey ?? '' });
      blockingSeeds.push({
        ...seed,
        blockReasons: [
          ...(!record.lineagePresent || !record.canonicalSourceKey ? ['missing_lineage'] : []),
          ...(!record.sourceStoryId ? ['missing_source_story_id'] : []),
          ...(!record.sourceFindingId ? ['missing_source_finding_id'] : []),
        ],
      });
      continue;
    }
    const findingSignalQualityBlocks = findingSignalQualityBlockReasons(record);
    if (findingSignalQualityBlocks.length > 0) {
      blockingSeeds.push({
        ...toSeedCandidate(record),
        blockReasons: findingSignalQualityBlocks,
      });
      continue;
    }
    const list = byCanonical.get(record.canonicalSourceKey) ?? [];
    list.push(record);
    byCanonical.set(record.canonicalSourceKey, list);
  }

  const proposableSeeds: PlaybookSeedCandidate[] = [];
  const duplicateSeedGroups: PlaybookDuplicateSeedGroup[] = [];
  const rawFindingsWithoutDistilledExperience: PlaybookSeedCandidate[] = [];

  for (const [canonicalSourceKey, records] of [...byCanonical.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const allSourceRecordsForCanonical = seedRecords.filter((record) => record.canonicalSourceKey === canonicalSourceKey);
    const seedCandidates = sortSeeds(records.map(toSeedCandidate));
    const primary = seedCandidates[0];
    if (!primary) continue;
    if (allSourceRecordsForCanonical.length > 1) {
      duplicateSeedGroups.push({
        canonicalSourceKey,
        primarySeedId: primary.seedId,
        records: sortSeeds(allSourceRecordsForCanonical.map(toSeedCandidate)),
      });
    }

    const representingArtifacts = representedArtifacts(canonicalSourceKey, audit, playbookStatusById);
    const nonPromotableSource = nonPromotableForSeed(primary, allSourceRecordsForCanonical, registry.sources);
    const blockReasons: string[] = [];
    if (representingArtifacts.length > 0) blockReasons.push('already_represented');
    if (nonPromotableSource) blockReasons.push('non_promotable');

    if (blockReasons.length > 0) {
      const blocked: PlaybookSeedBlocked = {
        ...primary,
        blockReasons,
        ...(representingArtifacts.length > 0 ? { representingArtifacts } : {}),
        ...(nonPromotableSource ? { nonPromotableSource } : {}),
      };
      blockingSeeds.push(blocked);
      if (nonPromotableSource) nonPromotableBlocks.push(blocked);
      if (representingArtifacts.length > 0) alreadyRepresentedSources.push(blocked);
      continue;
    }

    proposableSeeds.push(primary);
    if (
      primary.sourceArtifactKind === 'finding'
      && !allSourceRecordsForCanonical.some((record) => record.artifactKind === 'dev_memory' || record.artifactKind === 'finding_signal')
    ) {
      rawFindingsWithoutDistilledExperience.push(primary);
    }
  }

  const digestDomain: Omit<PlaybookSeedObserveReport, 'observeDigest'> = {
    schemaVersion: PLAYBOOK_SEED_OBSERVE_SCHEMA_VERSION,
    observedAt: opts.now ?? new Date().toISOString(),
    sourceFilter,
    audit: {
      sourceRecordCount: audit.sourceRecordCount,
      missingLineageCount: audit.missingLineageCount,
      canonicalSourceKeyVersion: audit.canonicalSourceKeyVersion,
      canonicalizationPolicyHash: audit.canonicalizationPolicyHash,
    },
    proposableSeeds: sortSeeds(proposableSeeds),
    blockingSeeds: sortSeeds(blockingSeeds),
    duplicateSeedGroups: duplicateSeedGroups.sort((a, b) => a.canonicalSourceKey.localeCompare(b.canonicalSourceKey)),
    duplicateCanonicalSourceGroups: audit.duplicateCanonicalSourceGroups,
    missingLineage: missingLineage.sort((a, b) => `${a.artifactKind}:${a.artifactId}`.localeCompare(`${b.artifactKind}:${b.artifactId}`)),
    nonPromotableBlocks: sortSeeds(nonPromotableBlocks),
    alreadyRepresentedSources: sortSeeds(alreadyRepresentedSources),
    rawFindingsWithoutDistilledExperience: sortSeeds(rawFindingsWithoutDistilledExperience),
    diagnostics: audit.diagnostics,
    authority: 'non_authoritative',
    gateEvidence: false,
  };
  return {
    ...digestDomain,
    observeDigest: computeObserveDigest(digestDomain),
  };
}

function findSourceFinding(store: PlaybookSeedStorePort, seed: PlaybookSeedCandidate): Finding | undefined {
  const storyId = seed.sourceStoryId ?? storyIdFromFindingId(seed.sourceFindingId);
  const findingId = normalizeFindingId(storyId, seed.sourceFindingId);
  if (!storyId || !findingId) return undefined;
  const findings = store.readFindings(storyId).findings ?? [];
  return findings.find((raw): raw is Finding => {
    const candidate = raw as Partial<Finding> | undefined;
    return Boolean(candidate && typeof candidate.id === 'string' && normalizeFindingId(storyId, candidate.id) === findingId);
  });
}

function triggerFromSeed(seed: PlaybookSeedCandidate, finding?: Finding): PlaybookTrigger {
  const text = [
    finding?.desc,
    seed.sourceArtifactKind,
    seed.sourceArtifactId,
    seed.sourceSignature,
    seed.canonicalSourceKey,
    seed.sourceSummary,
    ...(seed.sourcePitfalls ?? []),
    ...(seed.sourceVerification ?? []),
  ].filter(Boolean).join(' ');
  return {
    keywords: seedKeywords(text),
    fileKinds: uniqSorted((finding?.files ?? []).map(fileKind)),
    storyPhases: seed.sourceArtifactKind === 'done_experience' ? ['DONE', 'REVIEW'] : ['REVIEW'],
  };
}

function lineageFromSeed(seed: PlaybookSeedCandidate): PlaybookLineage {
  const sourceStoryId = seed.sourceStoryId ?? storyIdFromFindingId(seed.sourceFindingId);
  const sourceFindingId = normalizeFindingId(sourceStoryId, seed.sourceFindingId);
  if (!sourceStoryId || !sourceFindingId) {
    throw new Error(`playbook_seed_propose_batch: seed ${seed.seedId} lacks sourceStoryId/sourceFindingId lineage`);
  }
  return {
    sourceStoryId,
    sourceFindingId,
    ...(seed.sourceSignature ? { sourceSignature: seed.sourceSignature } : {}),
  };
}

function seedReference(seed: PlaybookSeedCandidate): PlaybookSeedReference {
  return {
    sourceArtifactKind: seed.sourceArtifactKind,
    sourceArtifactId: seed.sourceArtifactId,
    sourceRef: seed.sourceRef,
    canonicalSourceKey: seed.canonicalSourceKey,
    canonicalSourceKeyVersion: seed.canonicalSourceKeyVersion,
    canonicalizationPolicyHash: seed.canonicalizationPolicyHash,
    ...(seed.rawSourceKey ? { rawSourceKey: seed.rawSourceKey } : {}),
  };
}

export function candidatePlaybookFromProposal(proposal: PlaybookProposal): Playbook {
  return {
    id: proposal.id,
    title: proposal.title,
    trigger: proposal.trigger,
    check: proposal.check,
    pitfalls: proposal.pitfalls,
    verification: proposal.verification,
    lineage: proposal.lineage,
    status: 'candidate',
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

function proposalFromSeed(id: string, seed: PlaybookSeedCandidate, store: PlaybookSeedStorePort): PlaybookProposal {
  const finding = findSourceFinding(store, seed);
  const desc = (finding?.desc ?? '').trim();
  const sourceLabel = seedKindLabel(seed.sourceArtifactKind);
  const lineage = lineageFromSeed(seed);
  const sourceSummary = seed.sourceSummary ? trimTo(seed.sourceSummary, 220) : '';
  const sourcePitfalls = uniqSorted(seed.sourcePitfalls ?? []).map((item) => trimTo(item, 220));
  const sourceVerification = uniqSorted(seed.sourceVerification ?? []).map((item) => trimTo(item, 220));
  const proposal: PlaybookProposal = {
    id,
    title: desc
      ? `Playbook: ${desc.slice(0, 80)}`
      : seed.sourceArtifactKind === 'done_experience' && sourceSummary
        ? `Playbook: DONE experience ${seed.sourceArtifactId}`
        : `Playbook seed: ${sourceLabel} ${seed.sourceArtifactId}`,
    trigger: triggerFromSeed(seed, finding),
    check: desc
      ? `Proactively check for: ${desc}`
      : sourceSummary
        ? `Before similar work, apply this DONE experience: ${sourceSummary}`
        : `Before similar work, apply the lesson captured by ${sourceLabel} ${seed.sourceArtifactId}.`,
    pitfalls: desc
      ? [desc]
      : sourcePitfalls.length > 0
        ? sourcePitfalls
        : [`Do not treat ${sourceLabel} seed material as authoritative gate evidence.`],
    verification: sourceVerification.length > 0
      ? sourceVerification
      : [`Confirm the source condition behind ${lineage.sourceFindingId} cannot recur`],
    lineage,
    seed: seedReference(seed),
    status: 'proposed',
    proposalDigest: '',
  };
  proposal.proposalDigest = computePlaybookProposalDigest(proposal);
  return proposal;
}

function proposalPreview(proposal: PlaybookProposal, seed: PlaybookSeedCandidate): PlaybookSeedProposalPreview {
  return {
    proposalId: proposal.id,
    seed,
    proposalDigest: proposal.proposalDigest,
    candidatePlaybookDigest: computePlaybookDigest(candidatePlaybookFromProposal(proposal)),
    title: proposal.title,
    sourceLineage: proposal.lineage,
  };
}

function clampLimit(limit: number | undefined, fallback: number, max = 100): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(limit)));
}

function proposalBatchDigest(rows: PlaybookSeedProposalPreview[], observeDigest: string): string {
  return digestCanonicalJson({
    observeDigest,
    proposals: rows.map((row) => ({
      candidatePlaybookDigest: row.candidatePlaybookDigest,
      canonicalSourceKey: row.seed.canonicalSourceKey,
      proposalDigest: row.proposalDigest,
      proposalId: row.proposalId,
      sourceArtifactId: row.seed.sourceArtifactId,
      sourceArtifactKind: row.seed.sourceArtifactKind,
    })),
  });
}

export function buildPlaybookSeedProposalBatch(opts: BuildPlaybookSeedProposalBatchOptions): PlaybookSeedProposalBatchReport {
  const apply = opts.apply === true;
  const limit = clampLimit(opts.limit, 20);
  const observation = buildPlaybookSeedObservation(opts);
  const expectedObserveDigest = (opts.observeDigest ?? '').trim();
  if (apply && !expectedObserveDigest) {
    throw new Error('playbook_seed_propose_batch requires --observeDigest when --apply is set');
  }
  if (apply && expectedObserveDigest !== observation.observeDigest) {
    throw new Error(`playbook_seed_propose_batch: observeDigest drift; expected ${expectedObserveDigest}, current ${observation.observeDigest}`);
  }

  const selected = observation.proposableSeeds.slice(0, limit);
  const ids = nextProposalIds(listProposals(opts.projectRoot), readPlaybooks(opts.projectRoot), selected.length);
  const proposals = selected.map((seed, index) => proposalFromSeed(ids[index], seed, opts.store));
  const previews = proposals.map((proposal, index) => proposalPreview(proposal, selected[index]));
  const manifestDigest = proposalBatchDigest(previews, observation.observeDigest);

  if (apply) {
    for (const proposal of proposals) {
      writeProposal(opts.projectRoot, proposal);
    }
  }

  return {
    schemaVersion: PLAYBOOK_SEED_PROPOSE_BATCH_SCHEMA_VERSION,
    dryRun: !apply,
    applied: apply,
    sourceFilter: observation.sourceFilter,
    limit,
    observeDigest: observation.observeDigest,
    ...(expectedObserveDigest ? { expectedObserveDigest } : {}),
    proposalManifestDigest: manifestDigest,
    proposalCount: previews.length,
    proposals: previews,
    blockedSeedCount: observation.blockingSeeds.length,
    skippedSeedCount: Math.max(0, observation.proposableSeeds.length - selected.length),
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function unboundedLimit(limit: number | undefined): number | null {
  if (limit === undefined || !Number.isFinite(limit)) return null;
  return Math.max(0, Math.floor(limit));
}

function applyLimit<T>(rows: T[], limit: number | null): { selected: T[]; skippedByLimit: number } {
  if (limit === null) return { selected: rows, skippedByLimit: 0 };
  return {
    selected: rows.slice(0, limit),
    skippedByLimit: Math.max(0, rows.length - limit),
  };
}

function stagedProposalOnlySeed(seed: PlaybookSeedBlocked): boolean {
  const reps = seed.representingArtifacts ?? [];
  return seed.blockReasons.length === 1
    && seed.blockReasons[0] === 'already_represented'
    && reps.length > 0
    && reps.every((row) => row.artifactKind === 'playbook_proposal');
}

function proposalsForCanonical(projectRoot: string, canonicalSourceKey: string): PlaybookProposal[] {
  return listProposals(projectRoot)
    .filter((proposal) => proposal.seed?.canonicalSourceKey === canonicalSourceKey)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function backfillBlockedRow(seed: PlaybookSeedCandidate, reasons: string[]): PlaybookSeedBackfillBlockedRow {
  return {
    seedId: seed.seedId,
    canonicalSourceKey: seed.canonicalSourceKey,
    sourceArtifactKind: seed.sourceArtifactKind,
    sourceArtifactId: seed.sourceArtifactId,
    reasons,
  };
}

function backfillCandidateRow(
  seed: PlaybookSeedCandidate,
  candidate: Playbook,
  fromStagedProposal: boolean,
): PlaybookSeedBackfillCandidateRow {
  return {
    playbookId: candidate.id,
    seedId: seed.seedId,
    sourceArtifactKind: seed.sourceArtifactKind,
    sourceArtifactId: seed.sourceArtifactId,
    canonicalSourceKey: seed.canonicalSourceKey,
    candidatePlaybookDigest: computePlaybookDigest(candidate),
    fromStagedProposal,
    title: candidate.title,
  };
}

export function buildPlaybookSeedBackfillReport(opts: BuildPlaybookSeedBackfillOptions): PlaybookSeedBackfillReport {
  const apply = opts.apply === true;
  const limit = unboundedLimit(opts.limit);
  const observation = buildPlaybookSeedObservation(opts);
  const expectedObserveDigest = (opts.observeDigest ?? '').trim();
  if (apply && !expectedObserveDigest) {
    throw new Error('playbook_seed_backfill requires --observeDigest when --apply is set');
  }
  if (apply && expectedObserveDigest !== observation.observeDigest) {
    throw new Error(`playbook_seed_backfill: observeDigest drift; expected ${expectedObserveDigest}, current ${observation.observeDigest}`);
  }

  const stagedSeeds = observation.alreadyRepresentedSources.filter(stagedProposalOnlySeed);
  const playbookRepresented = observation.alreadyRepresentedSources.filter((seed) =>
    !stagedProposalOnlySeed(seed)
    && (seed.representingArtifacts ?? []).some((row) => row.artifactKind === 'playbook'));
  const backfillable = sortSeeds([...observation.proposableSeeds, ...stagedSeeds]);
  const { selected, skippedByLimit } = applyLimit(backfillable, limit);
  const selectedSeedIds = new Set(selected.map((seed) => seed.seedId));
  const blocked: PlaybookSeedBackfillBlockedRow[] = [
    ...observation.blockingSeeds
      .filter((seed) => !selectedSeedIds.has(seed.seedId))
      .filter((seed) => !stagedProposalOnlySeed(seed))
      .map((seed) => backfillBlockedRow(seed, seed.blockReasons)),
  ];

  const existingPlaybooks = readPlaybooks(opts.projectRoot);
  const existingIds = new Set(existingPlaybooks.map((playbook) => playbook.id));
  const directSeeds = selected.filter((seed) => !stagedSeeds.some((staged) => staged.seedId === seed.seedId));
  const directIds = nextProposalIds(listProposals(opts.projectRoot), existingPlaybooks, directSeeds.length);
  const directIdBySeedId = new Map(directSeeds.map((seed, index) => [seed.seedId, directIds[index]]));
  const candidateRows: PlaybookSeedBackfillCandidateRow[] = [];
  const candidates: Array<{ playbook: Playbook; proposalIdsToDelete: string[] }> = [];
  const candidateIds = new Set<string>();

  for (const seed of selected) {
    const staged = stagedSeeds.some((row) => row.seedId === seed.seedId);
    let proposal: PlaybookProposal;
    let proposalIdsToDelete: string[] = [];
    if (staged) {
      const proposals = proposalsForCanonical(opts.projectRoot, seed.canonicalSourceKey);
      if (proposals.length !== 1) {
        blocked.push(backfillBlockedRow(seed, [`staged_proposal_count_${proposals.length}`]));
        continue;
      }
      proposal = proposals[0];
      proposalIdsToDelete = [proposal.id];
      const computed = computePlaybookProposalDigest(proposal);
      if (proposal.proposalDigest !== computed) {
        blocked.push(backfillBlockedRow(seed, ['staged_proposal_digest_stale']));
        continue;
      }
    } else {
      const id = directIdBySeedId.get(seed.seedId);
      if (!id) {
        blocked.push(backfillBlockedRow(seed, ['missing_backfill_id']));
        continue;
      }
      proposal = proposalFromSeed(id, seed, opts.store);
      proposalIdsToDelete = proposalsForCanonical(opts.projectRoot, seed.canonicalSourceKey).map((row) => row.id);
    }
    const candidate = candidatePlaybookFromProposal(proposal);
    const validation = validatePlaybook(candidate);
    if (!validation.ok) {
      blocked.push(backfillBlockedRow(seed, [validation.error]));
      continue;
    }
    if (existingIds.has(candidate.id) || candidateIds.has(candidate.id)) {
      blocked.push(backfillBlockedRow(seed, [`candidate_id_already_exists:${candidate.id}`]));
      continue;
    }
    candidateIds.add(candidate.id);
    candidates.push({ playbook: candidate, proposalIdsToDelete });
    candidateRows.push(backfillCandidateRow(seed, candidate, staged));
  }

  let deletedProposalCount = 0;
  if (apply && candidates.length > 0) {
    writePlaybooks(opts.projectRoot, [...existingPlaybooks, ...candidates.map((row) => row.playbook)]);
    const after = readPlaybooks(opts.projectRoot);
    for (const row of candidates) {
      const persisted = after.find((playbook) => playbook.id === row.playbook.id);
      if (!persisted || persisted.status !== 'candidate' || computePlaybookDigest(persisted) !== computePlaybookDigest(row.playbook)) {
        throw new Error(`playbook_seed_backfill: write verification failed for ${row.playbook.id}`);
      }
    }
    for (const prior of existingPlaybooks) {
      if (!after.some((playbook) => playbook.id === prior.id)) {
        throw new Error(`playbook_seed_backfill: write verification failed; existing playbook ${prior.id} disappeared`);
      }
    }
    const deleteIds = uniqSorted(candidates.flatMap((row) => row.proposalIdsToDelete));
    for (const id of deleteIds) {
      if (deleteProposal(opts.projectRoot, id)) deletedProposalCount += 1;
    }
  }

  return {
    schemaVersion: PLAYBOOK_SEED_BACKFILL_SCHEMA_VERSION,
    dryRun: !apply,
    applied: apply,
    sourceFilter: observation.sourceFilter,
    limit,
    observeDigest: observation.observeDigest,
    ...(expectedObserveDigest ? { expectedObserveDigest } : {}),
    selectedSeedCount: selected.length,
    plannedCount: candidateRows.length,
    createdCount: apply ? candidateRows.length : 0,
    skippedCount: skippedByLimit,
    blockedCount: blocked.length,
    alreadyRepresentedCount: playbookRepresented.length,
    stagedProposalCount: stagedSeeds.length,
    deletedProposalCount,
    createdPlaybookIds: apply ? candidateRows.map((row) => row.playbookId) : [],
    candidates: candidateRows,
    blocked,
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function seedProposalOnly(proposal: PlaybookProposal): boolean {
  return Boolean(proposal.seed?.canonicalSourceKey && proposal.seed.sourceArtifactKind && proposal.seed.sourceArtifactId);
}

function sortedFilter(values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  return uniqSorted(values);
}

function candidateManifestScope(opts: BuildPlaybookCandidateBatchOptions): {
  proposalIds?: string[];
  canonicalSourceKeys?: string[];
  sourceFilter?: PlaybookSeedSourceFilter;
  storyId?: string;
} {
  const sourceFilter = opts.source === undefined ? undefined : normalizeSourceFilter(opts.source);
  const proposalIds = sortedFilter(opts.proposalIds);
  const canonicalSourceKeys = sortedFilter(opts.canonicalSourceKeys);
  const storyId = normalizeStoryFilter(opts.storyId);
  return {
    ...(proposalIds !== undefined ? { proposalIds } : {}),
    ...(canonicalSourceKeys !== undefined ? { canonicalSourceKeys } : {}),
    ...(sourceFilter ? { sourceFilter } : {}),
    ...(storyId ? { storyId } : {}),
  };
}

function proposalInCandidateManifestScope(
  proposal: PlaybookProposal,
  scope: ReturnType<typeof candidateManifestScope>,
): boolean {
  if (!seedProposalOnly(proposal)) return false;
  if (scope.proposalIds !== undefined && !scope.proposalIds.includes(proposal.id)) return false;
  if (scope.canonicalSourceKeys !== undefined && !scope.canonicalSourceKeys.includes(proposal.seed!.canonicalSourceKey)) return false;
  if (scope.sourceFilter !== undefined && !sourceFilterKinds(scope.sourceFilter).has(proposal.seed!.sourceArtifactKind)) return false;
  if (scope.storyId !== undefined && proposal.lineage.sourceStoryId !== scope.storyId) return false;
  return true;
}

function duplicateCanonicalInvalidRows(rows: PlaybookCandidateBatchManifestRow[]): Array<{ proposalId: string; reason: string }> {
  const invalid: Array<{ proposalId: string; reason: string }> = [];
  const rowsByCanonical = new Map<string, PlaybookCandidateBatchManifestRow[]>();
  for (const row of rows) {
    const canonicalSourceKey = row.canonicalSourceKey.trim();
    if (!canonicalSourceKey) continue;
    const list = rowsByCanonical.get(canonicalSourceKey) ?? [];
    list.push(row);
    rowsByCanonical.set(canonicalSourceKey, list);
  }
  for (const [canonicalSourceKey, duplicates] of rowsByCanonical) {
    if (duplicates.length <= 1) continue;
    for (const row of duplicates) {
      invalid.push({
        proposalId: row.proposalId,
        reason: `duplicate canonicalSourceKey in manifest: ${canonicalSourceKey}`,
      });
    }
  }
  return invalid;
}

function buildCandidateManifestRows(projectRoot: string, limit: number, scope: ReturnType<typeof candidateManifestScope>): {
  rows: PlaybookCandidateBatchManifestRow[];
  invalid: Array<{ proposalId: string; reason: string }>;
} {
  const proposals = listProposals(projectRoot)
    .filter((proposal) => proposalInCandidateManifestScope(proposal, scope))
    .slice(0, limit);
  const rows: PlaybookCandidateBatchManifestRow[] = [];
  const invalid: Array<{ proposalId: string; reason: string }> = [];
  for (const proposal of proposals) {
    const computed = computePlaybookProposalDigest(proposal);
    if (proposal.proposalDigest !== computed) {
      invalid.push({ proposalId: proposal.id, reason: 'proposalDigest is stale or inconsistent' });
      continue;
    }
    const candidate = candidatePlaybookFromProposal(proposal);
    const validation = validatePlaybook(candidate);
    if (!validation.ok) {
      invalid.push({ proposalId: proposal.id, reason: validation.error });
      continue;
    }
    rows.push({
      proposalId: proposal.id,
      proposalDigest: computed,
      candidatePlaybookDigest: computePlaybookDigest(candidate),
      canonicalSourceKey: proposal.seed!.canonicalSourceKey,
      sourceArtifactKind: proposal.seed!.sourceArtifactKind,
      sourceArtifactId: proposal.seed!.sourceArtifactId,
      title: proposal.title,
    });
  }
  return { rows, invalid: [...invalid, ...duplicateCanonicalInvalidRows(rows)] };
}

function representedCanonicalSourceConflicts(
  opts: BuildPlaybookCandidateBatchOptions,
  rows: PlaybookCandidateBatchManifestRow[],
): Array<{ proposalId: string; reason: string }> {
  const proposalIds = new Set(rows.map((row) => row.proposalId));
  const audit = buildLearningSourceLineageAudit({
    projectRoot: opts.projectRoot,
    store: opts.store,
    now: 'deterministic-candidate-batch-approval-time',
  });
  const conflicts: Array<{ proposalId: string; reason: string }> = [];
  for (const row of rows) {
    const represented = audit.records.filter((record) =>
      record.canonicalSourceKey === row.canonicalSourceKey
      && REPRESENTED_KINDS.has(record.artifactKind)
      && !(record.artifactKind === 'playbook_proposal' && proposalIds.has(record.artifactId)));
    if (represented.length === 0) continue;
    conflicts.push({
      proposalId: row.proposalId,
      reason: `canonicalSourceKey already represented: ${row.canonicalSourceKey}`,
    });
  }
  return conflicts;
}

function candidateManifestDigest(
  rows: PlaybookCandidateBatchManifestRow[],
  invalid: Array<{ proposalId: string; reason: string }>,
  scope?: ReturnType<typeof candidateManifestScope>,
): string {
  return digestCanonicalJson({
    invalidProposals: invalid,
    proposals: rows,
    ...(scope && Object.keys(scope).length > 0 ? { scope } : {}),
    schemaVersion: PLAYBOOK_CANDIDATE_BATCH_MANIFEST_SCHEMA_VERSION,
  });
}

export function buildPlaybookCandidateBatchManifest(opts: BuildPlaybookCandidateBatchOptions): PlaybookCandidateBatchManifestReport {
  const apply = opts.apply === true;
  const limit = clampLimit(opts.limit, 50);
  const scope = candidateManifestScope(opts);
  const { rows, invalid } = buildCandidateManifestRows(opts.projectRoot, limit, scope);
  const allInvalid = [...invalid, ...representedCanonicalSourceConflicts(opts, rows)];
  const manifestDigest = candidateManifestDigest(rows, allInvalid, scope);
  const expectedManifestDigest = (opts.manifestDigest ?? '').trim();
  if (apply && !expectedManifestDigest) {
    throw new Error('playbook_candidate_batch_approve requires --manifestDigest when --apply is set');
  }
  if (apply && expectedManifestDigest !== manifestDigest) {
    throw new Error(`playbook_candidate_batch_approve: manifestDigest drift; expected ${expectedManifestDigest}, current ${manifestDigest}`);
  }
  if (apply && allInvalid.length > 0) {
    throw new Error(`playbook_candidate_batch_approve: manifest contains invalid proposals: ${allInvalid.map((row) => `${row.proposalId}:${row.reason}`).join(', ')}`);
  }

  if (apply) {
    const proposalIds = new Set(rows.map((row) => row.proposalId));
    const proposals = listProposals(opts.projectRoot).filter((proposal) => proposalIds.has(proposal.id));
    const candidates = proposals.map(candidatePlaybookFromProposal);
    const before = readPlaybooks(opts.projectRoot);
    const existingIds = new Set(before.map((playbook) => playbook.id));
    const duplicate = candidates.find((candidate) => existingIds.has(candidate.id));
    if (duplicate) {
      throw new Error(`playbook_candidate_batch_approve: candidate ${duplicate.id} already exists in playbooks.json`);
    }
    writePlaybooks(opts.projectRoot, [...before, ...candidates]);
    for (const proposal of proposals) {
      deleteProposal(opts.projectRoot, proposal.id);
    }
  }

  return {
    schemaVersion: PLAYBOOK_CANDIDATE_BATCH_MANIFEST_SCHEMA_VERSION,
    dryRun: !apply,
    applied: apply,
    manifestDigest,
    ...(expectedManifestDigest ? { expectedManifestDigest } : {}),
    ...(scope.proposalIds !== undefined ? { proposalIdFilter: scope.proposalIds } : {}),
    ...(scope.canonicalSourceKeys !== undefined ? { canonicalSourceKeyFilter: scope.canonicalSourceKeys } : {}),
    ...(scope.sourceFilter !== undefined ? { sourceFilter: scope.sourceFilter } : {}),
    ...(scope.storyId !== undefined ? { storyId: scope.storyId } : {}),
    proposalCount: rows.length,
    proposals: rows,
    invalidProposals: allInvalid,
    candidatePlaybookIds: rows.map((row) => row.proposalId),
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function candidateManifestRowsFromProposalPreviews(previews: PlaybookSeedProposalPreview[]): PlaybookCandidateBatchManifestRow[] {
  return previews.map((row) => ({
    proposalId: row.proposalId,
    proposalDigest: row.proposalDigest,
    candidatePlaybookDigest: row.candidatePlaybookDigest,
    canonicalSourceKey: row.seed.canonicalSourceKey,
    sourceArtifactKind: row.seed.sourceArtifactKind,
    sourceArtifactId: row.seed.sourceArtifactId,
    title: row.title,
  }));
}

function candidateManifestFromProposalPreview(
  opts: BuildPlaybookCandidateBatchOptions,
  previews: PlaybookSeedProposalPreview[],
): PlaybookCandidateBatchManifestReport {
  const scope = candidateManifestScope(opts);
  const rows = candidateManifestRowsFromProposalPreviews(previews);
  const allInvalid = [
    ...duplicateCanonicalInvalidRows(rows),
    ...representedCanonicalSourceConflicts(opts, rows),
  ];
  const manifestDigest = candidateManifestDigest(rows, allInvalid, scope);
  return {
    schemaVersion: PLAYBOOK_CANDIDATE_BATCH_MANIFEST_SCHEMA_VERSION,
    dryRun: true,
    applied: false,
    manifestDigest,
    ...(scope.proposalIds !== undefined ? { proposalIdFilter: scope.proposalIds } : {}),
    ...(scope.canonicalSourceKeys !== undefined ? { canonicalSourceKeyFilter: scope.canonicalSourceKeys } : {}),
    ...(scope.sourceFilter !== undefined ? { sourceFilter: scope.sourceFilter } : {}),
    ...(scope.storyId !== undefined ? { storyId: scope.storyId } : {}),
    proposalCount: rows.length,
    proposals: rows,
    invalidProposals: allInvalid,
    candidatePlaybookIds: rows.map((row) => row.proposalId),
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

export function buildPlaybookCandidateIngestReport(opts: BuildPlaybookCandidateIngestOptions): PlaybookCandidateIngestReport {
  const apply = opts.apply === true;
  const limit = clampLimit(opts.limit, 5, 25);
  const source = opts.source ?? 'done-experience';
  const storyId = normalizeStoryFilter(opts.storyId);
  const observation = buildPlaybookSeedObservation({
    projectRoot: opts.projectRoot,
    store: opts.store,
    source,
    ...(storyId ? { storyId } : {}),
    now: opts.now,
  });
  const proposalReport = buildPlaybookSeedProposalBatch({
    projectRoot: opts.projectRoot,
    store: opts.store,
    source,
    ...(storyId ? { storyId } : {}),
    apply,
    limit,
    ...(apply ? { observeDigest: observation.observeDigest } : {}),
    now: opts.now,
  });
  const proposalIds = proposalReport.proposals.map((row) => row.proposalId);
  const canonicalSourceKeys = proposalReport.proposals.map((row) => row.seed.canonicalSourceKey);
  const manifestScope = {
    projectRoot: opts.projectRoot,
    store: opts.store,
    limit: proposalIds.length,
    proposalIds,
    canonicalSourceKeys,
    source,
    ...(storyId ? { storyId } : {}),
  };
  const manifestPreview = apply
    ? buildPlaybookCandidateBatchManifest(manifestScope)
    : candidateManifestFromProposalPreview(manifestScope, proposalReport.proposals);
  const manifestReport = apply
    ? buildPlaybookCandidateBatchManifest({
      ...manifestScope,
      apply: true,
      manifestDigest: manifestPreview.manifestDigest,
    })
    : manifestPreview;
  const candidateCreatedCount = apply ? manifestReport.proposalCount : 0;
  return {
    schemaVersion: PLAYBOOK_CANDIDATE_INGEST_SCHEMA_VERSION,
    dryRun: !apply,
    applied: apply,
    sourceFilter: observation.sourceFilter,
    ...(storyId ? { storyId } : {}),
    limit,
    observeDigest: observation.observeDigest,
    proposalManifestDigest: proposalReport.proposalManifestDigest,
    manifestDigest: manifestReport.manifestDigest,
    proposedCount: proposalReport.proposalCount,
    candidateCreatedCount,
    candidatePlaybookIds: manifestReport.candidatePlaybookIds,
    skippedCount: proposalReport.skippedSeedCount,
    blockedCount: proposalReport.blockedSeedCount + manifestReport.invalidProposals.length,
    skippedSeedCount: proposalReport.skippedSeedCount,
    blockedSeedCount: proposalReport.blockedSeedCount,
    invalidProposalCount: manifestReport.invalidProposals.length,
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function runtimeQueryForPlaybook(playbook: Playbook): string {
  return uniqSorted([
    playbook.id,
    playbook.title,
    playbook.check,
    ...playbook.trigger.keywords,
    playbook.lineage.sourceSignature,
    playbook.lineage.sourceFindingId,
  ]).join(' ');
}

export function buildPlaybookRuntimeConsumptionVerifyReport(
  opts: BuildPlaybookRuntimeConsumptionVerifyOptions,
): PlaybookRuntimeConsumptionVerifyReport {
  const valid = readPlaybooks(opts.projectRoot)
    .map((raw) => validatePlaybook(raw))
    .filter((result): result is { ok: true; playbook: Playbook } => result.ok)
    .map((result) => result.playbook);
  const active = valid.filter((playbook) => playbook.status === 'active');
  const candidates = valid.filter((playbook) => playbook.status === 'candidate');
  const diagnostics: string[] = [];
  const activeChecks = active.map((playbook) => {
    const query = runtimeQueryForPlaybook(playbook);
    const consumers = RUNTIME_VERIFY_CONSUMERS.map((consumer) => {
      const pack = buildMemoryFreshnessPack({
        projectRoot: opts.projectRoot,
        query,
        consumer,
        storyPhase: playbook.trigger.storyPhases[0],
        touchedPaths: playbook.trigger.fileKinds.map((kind) => `runtime-consumption.${kind}`),
        maxEntries: 0,
        maxPlaybooks: 5,
        useIndex: false,
        useCache: false,
      });
      return {
        consumer,
        consumed: pack.results.playbookIds.includes(playbook.id),
        playbookIds: pack.results.playbookIds,
        packDigest: pack.packDigest,
      };
    });
    return {
      playbookId: playbook.id,
      query,
      consumedByAll: consumers.every((row) => row.consumed),
      consumers,
    };
  });
  const candidateInertness = candidates.map((playbook) => {
    const query = runtimeQueryForPlaybook(playbook);
    const pack = buildMemoryFreshnessPack({
      projectRoot: opts.projectRoot,
      query,
      consumer: 'session_brief',
      storyPhase: playbook.trigger.storyPhases[0],
      touchedPaths: playbook.trigger.fileKinds.map((kind) => `runtime-consumption.${kind}`),
      maxEntries: 0,
      maxPlaybooks: 10,
      useIndex: false,
      useCache: false,
    });
    return {
      playbookId: playbook.id,
      query,
      inert: !pack.results.playbookIds.includes(playbook.id),
      observedPlaybookIds: pack.results.playbookIds,
      label: 'pending learning only' as const,
    };
  });

  if (active.length === 0) diagnostics.push('no_active_playbooks_to_verify');
  for (const check of activeChecks) {
    if (!check.consumedByAll) diagnostics.push(`active_playbook_not_consumed_by_all:${check.playbookId}`);
  }
  for (const check of candidateInertness) {
    if (!check.inert) diagnostics.push(`candidate_playbook_was_consumed:${check.playbookId}`);
  }

  return {
    schemaVersion: PLAYBOOK_RUNTIME_CONSUMPTION_VERIFY_SCHEMA_VERSION,
    verifiedAt: opts.now ?? new Date().toISOString(),
    status: diagnostics.length === 0 ? 'pass' : 'warn',
    activeChecks,
    candidateInertness,
    diagnostics,
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function normalizedConsumer(value: string | undefined): string {
  const consumer = (value ?? '').trim();
  return consumer || 'playbook_trial';
}

function trialStoryContext(store: PlaybookSeedStorePort, storyId: string): { storyPhase?: string; storyType?: string } {
  const story = store.readStory?.(storyId);
  return {
    ...(typeof story?.phase === 'string' && story.phase.trim() ? { storyPhase: story.phase.trim() } : {}),
    ...(typeof story?.type === 'string' && story.type.trim() ? { storyType: story.type.trim() } : {}),
  };
}

function trialTriggerClasses(playbook: Playbook): string[] {
  return uniqSorted([
    ...playbook.trigger.keywords,
    playbook.lineage.sourceSignature,
    'candidate-trial',
  ]).slice(0, 12);
}

function trialId(prefix: 'PBO-TRIAL' | 'PBC-TRIAL', idempotencyKey: string): string {
  return `${prefix}-${digestCanonicalJson({ idempotencyKey }).slice(0, 16)}`;
}

function trialOutcomeKey(storyId: string, playbookId: string, consumer: string, playbookDigest: string): string {
  return ['playbook-trial-v1', 'candidate-exposure', storyId, playbookId, consumer, playbookDigest].join(':');
}

function trialControlKey(storyId: string, playbookId: string, consumer: string, playbookDigest: string): string {
  return ['playbook-trial-v1', 'matched-control', storyId, playbookId, consumer, playbookDigest].join(':');
}

function buildTrialOutcomeEvent(
  opts: BuildPlaybookTrialRunOptions,
  playbook: Playbook,
  consumer: string,
  playbookDigest: string,
  observedAt: string,
): PlaybookOutcomeEvent {
  const idempotencyKey = trialOutcomeKey(opts.storyId, playbook.id, consumer, playbookDigest);
  return {
    schemaVersion: 'proofbound.playbook-outcome.v1',
    eventId: trialId('PBO-TRIAL', idempotencyKey),
    idempotencyKey,
    observedAt,
    storyId: opts.storyId,
    playbookId: playbook.id,
    playbookStatusAtObservation: 'candidate',
    exposureMode: 'candidate-inspection',
    consumer,
    context: {
      ...trialStoryContext(opts.store, opts.storyId),
      fileKinds: uniqSorted(playbook.trigger.fileKinds),
      triggerClasses: trialTriggerClasses(playbook),
    },
    outcome: {
      verdict: 'unknown',
      verdictSource: 'candidate-trial',
      causedNoise: false,
      causedWrongClaim: false,
      preventedRepeatFinding: false,
    },
    bindings: {},
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function buildTrialControlEvent(
  opts: BuildPlaybookTrialRunOptions,
  playbook: Playbook,
  consumer: string,
  playbookDigest: string,
  observedAt: string,
): PlaybookTrialControlEvent {
  const idempotencyKey = trialControlKey(opts.storyId, playbook.id, consumer, playbookDigest);
  const context = {
    ...trialStoryContext(opts.store, opts.storyId),
    fileKinds: uniqSorted(playbook.trigger.fileKinds),
    triggerClasses: trialTriggerClasses(playbook),
  };
  return {
    schemaVersion: 'proofbound.playbook-trial-control.v1',
    controlId: trialId('PBC-TRIAL', idempotencyKey),
    idempotencyKey,
    observedAt,
    storyId: opts.storyId,
    playbookId: playbook.id,
    candidatePlaybookDigest: playbookDigest,
    consumer,
    context,
    control: {
      exposureMode: 'none',
      matchedOn: uniqSorted([
        context.storyPhase ? `storyPhase:${context.storyPhase}` : undefined,
        context.storyType ? `storyType:${context.storyType}` : undefined,
        ...context.fileKinds.map((kind) => `fileKind:${kind}`),
        ...context.triggerClasses.map((trigger) => `trigger:${trigger}`),
      ]),
      verdict: 'unknown',
      verdictSource: 'matched-control',
      causedNoise: false,
      causedWrongClaim: false,
      preventedRepeatFinding: false,
    },
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

export function buildPlaybookTrialRunReport(opts: BuildPlaybookTrialRunOptions): PlaybookTrialRunReport {
  const storyId = (opts.storyId ?? '').trim();
  if (!storyId) throw new Error('playbook_trial_run requires --storyId');
  const apply = opts.apply === true;
  const consumer = normalizedConsumer(opts.consumer);
  const limit = clampLimit(opts.limit, 10, 1000);
  const observedAt = opts.now ?? new Date().toISOString();
  const requestedPlaybookId = (opts.playbookId ?? '').trim();
  const validPlaybooks = readPlaybooks(opts.projectRoot)
    .map((raw) => validatePlaybook(raw))
    .filter((result): result is { ok: true; playbook: Playbook } => result.ok)
    .map((result) => result.playbook);
  if (requestedPlaybookId && !validPlaybooks.some((playbook) => playbook.id === requestedPlaybookId)) {
    throw new Error(`playbook_trial_run: playbook not found: ${requestedPlaybookId}`);
  }
  const inScope = requestedPlaybookId
    ? validPlaybooks.filter((playbook) => playbook.id === requestedPlaybookId)
    : validPlaybooks;
  const candidates = inScope.filter((playbook) => playbook.status === 'candidate');
  const { selected, skippedByLimit } = applyLimit(candidates, limit);
  const outcomeRows = readPlaybookOutcomeEventsWithDiagnostics(opts.projectRoot);
  const controlRows = readPlaybookTrialControlEventsWithDiagnostics(opts.projectRoot);
  const existingOutcomeKeys = new Set(outcomeRows.events.map((event) => event.idempotencyKey));
  const existingControlKeys = new Set(controlRows.events.map((event) => event.idempotencyKey));
  let outcomeCreatedCount = 0;
  let outcomeAlreadyExistsCount = 0;
  let controlCreatedCount = 0;
  let controlAlreadyExistsCount = 0;
  const observations: PlaybookTrialObservationRow[] = [];

  for (const playbook of selected) {
    const playbookDigest = computePlaybookDigest(playbook);
    const outcome = buildTrialOutcomeEvent(opts, playbook, consumer, playbookDigest, observedAt);
    const control = buildTrialControlEvent(opts, playbook, consumer, playbookDigest, observedAt);
    const outcomeAlreadyExists = existingOutcomeKeys.has(outcome.idempotencyKey);
    const controlAlreadyExists = existingControlKeys.has(control.idempotencyKey);
    if (outcomeAlreadyExists) outcomeAlreadyExistsCount += 1;
    if (controlAlreadyExists) controlAlreadyExistsCount += 1;
    if (apply && !outcomeAlreadyExists) {
      appendPlaybookOutcomeEvent(opts.projectRoot, outcome);
      existingOutcomeKeys.add(outcome.idempotencyKey);
      outcomeCreatedCount += 1;
    }
    if (apply && !controlAlreadyExists) {
      appendPlaybookTrialControlEvent(opts.projectRoot, control);
      existingControlKeys.add(control.idempotencyKey);
      controlCreatedCount += 1;
    }
    observations.push({
      playbookId: playbook.id,
      playbookDigest,
      outcomeIdempotencyKey: outcome.idempotencyKey,
      controlIdempotencyKey: control.idempotencyKey,
      outcomeAlreadyExists,
      controlAlreadyExists,
    });
  }

  return {
    schemaVersion: PLAYBOOK_TRIAL_RUN_SCHEMA_VERSION,
    dryRun: !apply,
    applied: apply,
    storyId,
    consumer,
    ...(requestedPlaybookId ? { playbookId: requestedPlaybookId } : {}),
    limit,
    candidateCount: candidates.length,
    selectedCount: selected.length,
    skippedByLimitCount: skippedByLimit,
    skippedNonCandidateCount: inScope.length - candidates.length,
    outcomeCreatedCount,
    outcomeAlreadyExistsCount,
    controlCreatedCount,
    controlAlreadyExistsCount,
    observations,
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function canonicalForPlaybook(audit: SourceLineageAuditReport, playbook: Playbook): string | undefined {
  return audit.records.find((record) => record.artifactKind === 'playbook' && record.artifactId === playbook.id)?.canonicalSourceKey ?? undefined;
}

function duplicatePlaybookPathBlockers(audit: SourceLineageAuditReport, canonicalSourceKey: string | undefined): number {
  if (!canonicalSourceKey) return 0;
  return audit.records.filter((record) =>
    record.canonicalSourceKey === canonicalSourceKey && REPRESENTED_KINDS.has(record.artifactKind)).length;
}

function appliedRecommendActivateDecisions(
  playbookId: string,
  aggregateDigest: string,
  decisions: PlaybookPromotionDecisionRow[],
): PlaybookPromotionDecisionRow[] {
  return decisions
    .filter((row) =>
      row.applied
      && row.playbookId === playbookId
      && row.action === 'recommend_activate'
      && row.aggregateDigest === aggregateDigest)
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt) || b.decisionId.localeCompare(a.decisionId));
}

function appliedRecommendActivateDecisionsForPlaybook(
  playbookId: string,
  decisions: PlaybookPromotionDecisionRow[],
): PlaybookPromotionDecisionRow[] {
  return decisions
    .filter((row) =>
      row.applied
      && row.playbookId === playbookId
      && row.action === 'recommend_activate')
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt) || b.decisionId.localeCompare(a.decisionId));
}

function promotionDecisionIdempotencyKey(
  aggregate: PlaybookPromotionDecisionRow['aggregate'],
  action: PlaybookPromotionDecisionRow['action'],
): string {
  return [
    'playbook-promotion-v1',
    action,
    aggregate.playbookId,
    aggregate.aggregateDigest,
    aggregate.source.sourceKey,
  ].join(':');
}

function autoPromotionDecisionId(idempotencyKey: string, playbookDigest: string): string {
  return `PBD-AUTO-${digestCanonicalJson({
    idempotencyKey,
    playbookDigest,
    purpose: 'playbook-auto-promotion-apply-decision',
  }).slice(0, 16)}`;
}

function buildAutoPromotionRecommendActivateDecision(
  playbook: Playbook,
  aggregate: PlaybookPromotionDecisionRow['aggregate'],
  reasonCodes: string[],
  decidedAt: string,
): PlaybookPromotionDecisionRow {
  const action: PlaybookPromotionDecisionRow['action'] = 'recommend_activate';
  const playbookDigest = computePlaybookDigest(playbook);
  const idempotencyKey = promotionDecisionIdempotencyKey(aggregate, action);
  return {
    schemaVersion: 'proofbound.playbook-promotion-decision.v1',
    decisionId: autoPromotionDecisionId(idempotencyKey, playbookDigest),
    idempotencyKey,
    decidedAt,
    playbookId: playbook.id,
    evaluatedStatus: playbook.status,
    action,
    reasonCodes,
    aggregateDigest: aggregate.aggregateDigest,
    aggregate,
    before: {
      playbookStatus: playbook.status,
      playbookDigest,
      sourceKey: aggregate.source.sourceKey,
    },
    after: {
      playbookStatus: playbook.status,
      recommendation: action,
    },
    workerVersion: 'playbook-promotion-worker-v1',
    dryRun: false,
    applied: true,
    alreadyApplied: false,
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function activationIdempotencyKey(
  playbookId: string,
  playbookDigest: string,
  aggregateDigest: string,
  promotionDecisionDigest: string,
  policyDigest: string,
): string {
  return digestCanonicalJson({
    aggregateDigest,
    playbookDigest,
    playbookId,
    policyDigest,
    promotionDecisionDigest,
    purpose: 'playbook-auto-activation',
  });
}

export function buildPlaybookAutoPromotionApplyReport(
  opts: BuildPlaybookAutoPromotionApplyOptions,
): PlaybookAutoPromotionApplyReport {
  const apply = opts.apply === true;
  const activatedAt = opts.now ?? new Date().toISOString();
  const activationPolicy = opts.activationPolicy === undefined
    ? REVIEWED_EVIDENCE_ACTIVATION_POLICY
    : opts.activationPolicy;
  const outcomes = readPlaybookOutcomeEventsWithDiagnostics(opts.projectRoot).events;
  let decisions = readPlaybookPromotionDecisionRows(opts.projectRoot).decisions;
  const priorActivations = readPlaybookAutoActivationEvents(opts.projectRoot);
  const priorActivationKeys = new Set(priorActivations.map((row) => row.idempotencyKey));
  const audit = buildLearningSourceLineageAudit({
    projectRoot: opts.projectRoot,
    store: opts.store,
    now: 'deterministic-auto-promotion-guard-time',
  });
  const allPlaybooks = readPlaybooks(opts.projectRoot)
    .map((raw) => validatePlaybook(raw))
    .filter((result): result is { ok: true; playbook: Playbook } => result.ok)
    .map((result) => result.playbook);
  const candidates = allPlaybooks
    .filter((playbook) => playbook.status === 'candidate');

  const globalBlockers: string[] = [];
  if (!activationPolicy) globalBlockers.push('activation_policy_not_reviewed');
  if (candidates.length === 0) globalBlockers.push('no_candidate_playbooks');

  const buildCandidateGuards = (guardDecisions: PlaybookPromotionDecisionRow[]): PlaybookAutoPromotionCandidateGuard[] =>
    candidates.map((playbook): PlaybookAutoPromotionCandidateGuard => {
      const playbookDigest = computePlaybookDigest(playbook);
      const aggregate = aggregatePlaybookPromotion(playbook, outcomes, guardDecisions);
      const evaluation = evaluatePlaybookPromotion(aggregate);
      const playbookRecommendActivateDecisions = appliedRecommendActivateDecisionsForPlaybook(playbook.id, guardDecisions);
      const aggregateDecisions = appliedRecommendActivateDecisions(playbook.id, aggregate.aggregateDigest, guardDecisions);
      const decision = aggregateDecisions.find((row) =>
        row.before.playbookStatus === 'candidate'
        && row.before.playbookDigest === playbookDigest);
      const staleCandidateDigestDecision = playbookRecommendActivateDecisions.find((row) =>
        row.before.playbookStatus === 'candidate'
        && row.before.playbookDigest !== playbookDigest);
      const decisionDigest = decision ? digestCanonicalJson(decision) : '';
      const realOutcomes = outcomes.filter((event) =>
        event.playbookId === playbook.id
        && isCandidateConsumedPlaybookOutcome(event)
        && event.outcome.verdictSource !== 'done-settlement');
      const canonicalSourceKey = canonicalForPlaybook(audit, playbook);
      const duplicatePathCount = duplicatePlaybookPathBlockers(audit, canonicalSourceKey);
      const key = activationPolicy && decisionDigest
        ? activationIdempotencyKey(playbook.id, playbookDigest, aggregate.aggregateDigest, decisionDigest, activationPolicy.policyDigest)
        : '';
      const blockers: string[] = [];
      if (realOutcomes.length === 0) blockers.push('no_real_candidate_consumption_outcomes');
      if (realOutcomes.filter((event) => event.exposureMode !== 'none').length === 0) blockers.push('missing_concrete_exposure');
      if (aggregate.harmfulCount > 0) blockers.push('harmful_outcome_present');
      if (aggregate.wrongClaimCount > 0) blockers.push('wrong_claim_present');
      if (!canonicalSourceKey) blockers.push('missing_lineage');
      if (duplicatePathCount > 1) blockers.push('duplicate_candidate_or_proposal_path');
      if (evaluation.action !== 'recommend_activate') blockers.push(`promotion_recommendation_${evaluation.action}`);
      if (evaluation.action === 'recommend_activate' && !decision) {
        blockers.push(staleCandidateDigestDecision || aggregateDecisions.length > 0
          ? 'applied_recommend_activate_decision_digest_mismatch'
          : 'missing_applied_recommend_activate_decision');
      }
      if (key && priorActivationKeys.has(key)) blockers.push('activation_audit_already_exists');
      return {
        playbookId: playbook.id,
        playbookDigest,
        aggregateDigest: aggregate.aggregateDigest,
        ...(decision ? { promotionDecisionId: decision.decisionId } : {}),
        ...(decision ? { promotionDecisionIdempotencyKey: decision.idempotencyKey } : {}),
        ...(decisionDigest ? { promotionDecisionDigest: decisionDigest } : {}),
        recommendation: evaluation.action,
        reasonCodes: evaluation.reasonCodes,
        eligible: blockers.length === 0,
        blockers,
        activationIdempotencyKey: key,
        realOutcomeCount: realOutcomes.length,
        exposureCount: realOutcomes.filter((event) => event.exposureMode !== 'none').length,
        decisiveSamples: aggregate.decisiveSamples,
        helpedCount: aggregate.helpedCount,
        dismissedCount: aggregate.dismissedCount,
        harmfulCount: aggregate.harmfulCount,
        wrongClaimCount: aggregate.wrongClaimCount,
        contextClassCount: aggregate.contextClassCount,
        ...(canonicalSourceKey ? { lineageCanonicalSourceKey: canonicalSourceKey } : {}),
      };
    });

  let candidateGuards = buildCandidateGuards(decisions);
  const pendingRecommendationRows = new Map<string, PlaybookPromotionDecisionRow>();

  if (apply && activationPolicy) {
    const existingAppliedDecisionKeys = new Set(
      decisions.filter((row) => row.applied).map((row) => row.idempotencyKey),
    );
    const writableRecommendationRows: PlaybookPromotionDecisionRow[] = [];

    for (const guard of candidateGuards) {
      if (
        guard.recommendation !== 'recommend_activate'
        || guard.blockers.length !== 1
        || guard.blockers[0] !== 'missing_applied_recommend_activate_decision'
      ) continue;
      const playbook = candidates.find((row) => row.id === guard.playbookId);
      if (!playbook) continue;
      const aggregate = aggregatePlaybookPromotion(playbook, outcomes, decisions);
      const row = buildAutoPromotionRecommendActivateDecision(playbook, aggregate, guard.reasonCodes, activatedAt);
      if (existingAppliedDecisionKeys.has(row.idempotencyKey)) continue;
      existingAppliedDecisionKeys.add(row.idempotencyKey);
      writableRecommendationRows.push(row);
      pendingRecommendationRows.set(playbook.id, row);
    }

    if (writableRecommendationRows.length > 0) {
      decisions = [...decisions, ...writableRecommendationRows];
      candidateGuards = buildCandidateGuards(decisions);
      for (const guard of candidateGuards) {
        if (!guard.eligible) pendingRecommendationRows.delete(guard.playbookId);
      }
    }
  }

  if (candidates.length > 0 && candidateGuards.every((guard) => guard.blockers.length > 0)) {
    globalBlockers.push('no_candidate_passed_activation_guards');
  }

  const demotionRecommendations = allPlaybooks
    .filter((playbook) => playbook.status === 'active')
    .map((playbook): PlaybookAutoPromotionDemotionRecommendation | null => {
      const aggregate = aggregatePlaybookPromotion(playbook, outcomes, decisions);
      const evaluation = evaluatePlaybookPromotion(aggregate);
      if (evaluation.action !== 'recommend_demote') return null;
      return {
        playbookId: playbook.id,
        aggregateDigest: aggregate.aggregateDigest,
        recommendation: evaluation.action,
        reasonCodes: evaluation.reasonCodes,
        autoActivated: priorActivations.some((row) => row.playbookId === playbook.id),
      };
    })
    .filter((row): row is PlaybookAutoPromotionDemotionRecommendation => row !== null);

  const activatedPlaybooks: PlaybookAutoPromotionActivationSummary[] = [];

  if (apply) {
    const eligibleGuards = candidateGuards.filter((guard) => guard.eligible);
    if (!activationPolicy || (eligibleGuards.length === 0 && candidates.length > 0)) {
      const blockers = [
        ...globalBlockers,
        ...candidateGuards.flatMap((guard) => guard.blockers.map((blocker) => `${guard.playbookId}:${blocker}`)),
      ];
      throw new Error(`playbook_auto_promotion_apply: fail-closed; ${uniqSorted(blockers).join(', ') || 'no_eligible_candidate'}`);
    }

    const before = readPlaybooks(opts.projectRoot);
    const next = before.slice();
    const activationEvents: PlaybookAutoActivationEvent[] = [];
    const recommendationRowsToAppend: PlaybookPromotionDecisionRow[] = [];
    for (const guard of eligibleGuards) {
      const idx = next.findIndex((row) => row.id === guard.playbookId);
      if (idx < 0) continue;
      const validation = validatePlaybook(next[idx]);
      if (!validation.ok || validation.playbook.status !== 'candidate') continue;
      const current = validation.playbook;
      const currentDigest = computePlaybookDigest(current);
      if (
        currentDigest !== guard.playbookDigest
        || !guard.lineageCanonicalSourceKey
        || !guard.promotionDecisionId
        || !guard.promotionDecisionIdempotencyKey
        || !guard.promotionDecisionDigest
      ) continue;
      const pendingRecommendation = pendingRecommendationRows.get(guard.playbookId);
      if (pendingRecommendation) recommendationRowsToAppend.push(pendingRecommendation);
      const activated: Playbook = { ...current, status: 'active' };
      next[idx] = activated;
      const activeDigest = computePlaybookDigest(activated);
      const activationId = `PBA-${guard.activationIdempotencyKey.slice(0, 16)}`;
      activatedPlaybooks.push({
        playbookId: guard.playbookId,
        activationId,
        candidatePlaybookDigest: currentDigest,
        activePlaybookDigest: activeDigest,
        aggregateDigest: guard.aggregateDigest,
        promotionDecisionDigest: guard.promotionDecisionDigest,
        policyDigest: activationPolicy.policyDigest,
      });
      activationEvents.push({
        schemaVersion: 'proofbound.playbook-auto-activation.v1',
        activationId,
        idempotencyKey: guard.activationIdempotencyKey,
        activatedAt,
        playbookId: guard.playbookId,
        before: {
          playbookStatus: 'candidate',
          playbookDigest: currentDigest,
        },
        after: {
          playbookStatus: 'active',
          playbookDigest: activeDigest,
        },
        policy: {
          policyId: activationPolicy.policyId,
          policyDigest: activationPolicy.policyDigest,
          reviewedBy: activationPolicy.reviewedBy,
        },
        evidence: {
          aggregateDigest: guard.aggregateDigest,
          decisionId: guard.promotionDecisionId,
          decisionIdempotencyKey: guard.promotionDecisionIdempotencyKey,
          decisionDigest: guard.promotionDecisionDigest,
          recommendation: 'recommend_activate',
          reasonCodes: guard.reasonCodes,
          decisiveSamples: guard.decisiveSamples,
          helpedCount: guard.helpedCount,
          dismissedCount: guard.dismissedCount,
          harmfulCount: guard.harmfulCount,
          wrongClaimCount: guard.wrongClaimCount,
          contextClassCount: guard.contextClassCount,
          realOutcomeCount: guard.realOutcomeCount,
          exposureCount: guard.exposureCount,
          lineageCanonicalSourceKey: guard.lineageCanonicalSourceKey,
        },
        authority: 'non_authoritative',
        gateEvidence: false,
      });
    }

    if (eligibleGuards.length > 0 && activatedPlaybooks.length === 0) {
      throw new Error('playbook_auto_promotion_apply: fail-closed; eligible candidates became stale before write');
    }
    if (activatedPlaybooks.length > 0) {
      assertCanAppendPlaybookAutoActivationEvents(opts.projectRoot, activationEvents);
      if (recommendationRowsToAppend.length > 0) {
        const existingDecisionKeys = new Set(
          readPlaybookPromotionDecisionRows(opts.projectRoot).decisions
            .filter((row) => row.applied)
            .map((row) => row.idempotencyKey),
        );
        for (const row of recommendationRowsToAppend) {
          if (existingDecisionKeys.has(row.idempotencyKey)) continue;
          appendPlaybookPromotionDecision(opts.projectRoot, row);
          existingDecisionKeys.add(row.idempotencyKey);
        }
        const persistedDecisionKeys = new Set(
          readPlaybookPromotionDecisionRows(opts.projectRoot).decisions
            .filter((row) => row.applied)
            .map((row) => row.idempotencyKey),
        );
        for (const row of recommendationRowsToAppend) {
          if (!persistedDecisionKeys.has(row.idempotencyKey)) {
            throw new Error(`playbook_auto_promotion_apply: recommendation audit verification failed for ${row.playbookId}`);
          }
        }
      }
      writePlaybooks(opts.projectRoot, next);
      let activeStatusPersisted = true;
      try {
        const after = readPlaybooks(opts.projectRoot);
        for (const activated of activatedPlaybooks) {
          const persisted = after.find((row) => row.id === activated.playbookId);
          if (!persisted || persisted.status !== 'active' || computePlaybookDigest(persisted) !== activated.activePlaybookDigest) {
            throw new Error(`playbook_auto_promotion_apply: write verification failed for ${activated.playbookId}`);
          }
        }
        for (const prior of before) {
          if (!after.some((row) => row.id === prior.id)) {
            throw new Error(`playbook_auto_promotion_apply: write verification failed; existing playbook ${prior.id} disappeared`);
          }
        }
        for (const event of activationEvents) {
          appendPlaybookAutoActivationEvent(opts.projectRoot, event);
        }
        const persistedActivationKeys = new Set(
          readPlaybookAutoActivationEvents(opts.projectRoot).map((event) => event.idempotencyKey),
        );
        for (const event of activationEvents) {
          if (!persistedActivationKeys.has(event.idempotencyKey)) {
            throw new Error(`playbook_auto_promotion_apply: activation audit verification failed for ${event.playbookId}`);
          }
        }
        activeStatusPersisted = false;
      } catch (err) {
        if (activeStatusPersisted) {
          try {
            writePlaybooks(opts.projectRoot, before);
          } catch (rollbackErr) {
            throw new Error(`playbook_auto_promotion_apply: activation failed after status write and rollback failed: ${(rollbackErr as Error).message}; original: ${(err as Error).message}`);
          }
        }
        throw err;
      }
    }
  }

  const report: PlaybookAutoPromotionApplyReport = {
    schemaVersion: PLAYBOOK_AUTO_PROMOTION_APPLY_SCHEMA_VERSION,
    dryRun: !apply,
    applied: apply,
    activationImplemented: true,
    activationPolicy,
    prerequisites: [
      'reviewed evidence activation policy is present',
      'candidate has real non-DONE-settlement outcome rows',
      'candidate has explicit exposure records',
      'promotion decision row is applied recommend_activate for the current aggregate and candidate digest, or --apply writes deterministic digest-bound recommendation evidence',
      'no harmful or wrong-claim signal exists',
      'source lineage has no missing-lineage or duplicate proposal/candidate path blocker',
      'candidate digest is current at apply time',
      'activation remains advisory and non-authoritative',
    ],
    candidateGuards,
    globalBlockers: uniqSorted(globalBlockers),
    activatedCount: activatedPlaybooks.length,
    skippedCount: apply ? Math.max(0, candidateGuards.length - activatedPlaybooks.length) : 0,
    blockedCount: candidateGuards.filter((guard) => guard.blockers.length > 0).length,
    activatedPlaybooks,
    demotionRecommendations,
    authority: 'non_authoritative',
    gateEvidence: false,
  };

  return report;
}

function timerLimit(value: number | undefined, fallback: number): number {
  return clampLimit(value, fallback, 1000);
}

function timerStep(
  step: PlaybookPromotionTimerStepName,
  requested: boolean,
  status: PlaybookPromotionTimerStepStatus,
  applied: boolean,
  dryRun: boolean,
  limit: number | null,
  message: string,
  detail?: unknown,
): PlaybookPromotionTimerStep {
  return {
    step,
    requested,
    status,
    applied,
    dryRun,
    limit,
    message,
    ...(detail !== undefined ? { detail } : {}),
  };
}

function timerPromotionDecisionId(idempotencyKey: string, playbookDigest: string): string {
  return `PBD-TIMER-${digestCanonicalJson({
    idempotencyKey,
    playbookDigest,
    purpose: 'playbook-promotion-timer-sweep',
  }).slice(0, 16)}`;
}

function buildTimerPromotionDecisionRow(
  playbook: Playbook,
  aggregate: PlaybookPromotionDecisionRow['aggregate'],
  action: PlaybookPromotionDecisionRow['action'],
  reasonCodes: string[],
  decidedAt: string,
  opts: { dryRun: boolean; applied: boolean; alreadyApplied?: boolean },
): PlaybookPromotionDecisionRow {
  const playbookDigest = computePlaybookDigest(playbook);
  const idempotencyKey = promotionDecisionIdempotencyKey(aggregate, action);
  return {
    schemaVersion: 'proofbound.playbook-promotion-decision.v1',
    decisionId: timerPromotionDecisionId(idempotencyKey, playbookDigest),
    idempotencyKey,
    decidedAt,
    playbookId: playbook.id,
    evaluatedStatus: playbook.status,
    action,
    reasonCodes,
    aggregateDigest: aggregate.aggregateDigest,
    aggregate,
    before: {
      playbookStatus: playbook.status,
      playbookDigest,
      sourceKey: aggregate.source.sourceKey,
    },
    after: {
      playbookStatus: playbook.status,
      recommendation: action,
      ...(action === 'mark_non_deducible' ? { nonDeducibleSourceKey: aggregate.source.sourceKey } : {}),
    },
    workerVersion: 'playbook-promotion-worker-v1',
    dryRun: opts.dryRun,
    applied: opts.applied,
    alreadyApplied: opts.alreadyApplied ?? false,
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function runTimerSweep(opts: BuildPlaybookPromotionTimerOptions, limit: number, now: string): {
  evaluatedCount: number;
  decisionCreatedCount: number;
  alreadyAppliedCount: number;
  decisions: PlaybookPromotionDecisionRow[];
} {
  const apply = opts.apply === true;
  const outcomeRows = readPlaybookOutcomeEventsWithDiagnostics(opts.projectRoot);
  const decisionRows = readPlaybookPromotionDecisionRows(opts.projectRoot);
  const playbooks = readPlaybooks(opts.projectRoot)
    .map((raw) => validatePlaybook(raw))
    .filter((result): result is { ok: true; playbook: Playbook } => result.ok)
    .map((result) => result.playbook)
    .filter((playbook) => playbook.status === 'candidate' || playbook.status === 'active' || playbook.status === 'stale')
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit);
  const decisions = playbooks.map((playbook) => {
    const aggregate = aggregatePlaybookPromotion(playbook, outcomeRows.events, decisionRows.decisions);
    const evaluation = evaluatePlaybookPromotion(aggregate);
    return buildTimerPromotionDecisionRow(playbook, aggregate, evaluation.action, evaluation.reasonCodes, now, {
      dryRun: !apply,
      applied: apply,
    });
  });
  let decisionCreatedCount = 0;
  let alreadyAppliedCount = 0;
  if (apply) {
    const existingKeys = new Set(
      readPlaybookPromotionDecisionRows(opts.projectRoot).decisions
        .filter((row) => row.applied)
        .map((row) => row.idempotencyKey),
    );
    for (const row of decisions) {
      if (existingKeys.has(row.idempotencyKey)) {
        row.alreadyApplied = true;
        row.applied = true;
        alreadyAppliedCount += 1;
        continue;
      }
      appendPlaybookPromotionDecision(opts.projectRoot, row);
      existingKeys.add(row.idempotencyKey);
      decisionCreatedCount += 1;
      if (row.action === 'mark_non_deducible') {
        markNonDeducibleSource(opts.projectRoot, {
          source: row.aggregate.source,
          reasonCodes: row.reasonCodes,
          reason: 'promotion timer sweep marked source non_deducible after repeated rejected siblings',
          sourceRejectedSiblingCount: row.aggregate.sourceRejectedSiblingCount,
          aggregateDigest: row.aggregateDigest,
          latestDecisionId: row.decisionId,
          markedAt: row.decidedAt,
        });
      }
    }
  }
  return {
    evaluatedCount: decisions.length,
    decisionCreatedCount,
    alreadyAppliedCount,
    decisions,
  };
}

export function buildPlaybookPromotionTimerReport(opts: BuildPlaybookPromotionTimerOptions): PlaybookPromotionTimerReport {
  const apply = opts.apply === true;
  const now = opts.now ?? new Date().toISOString();
  const sourceFilter = normalizeSourceFilter(opts.source);
  const backfillLimit = timerLimit(opts.backfillLimit, 25);
  const trialLimit = timerLimit(opts.trialLimit, 10);
  const sweepLimit = timerLimit(opts.sweepLimit, 25);
  const storyId = normalizeStoryFilter(opts.storyId);
  const steps: PlaybookPromotionTimerStep[] = [];

  if (!opts.backfill) {
    steps.push(timerStep('backfill', false, 'disabled', false, !apply, backfillLimit, 'backfill step not requested'));
  } else {
    try {
      const observe = buildPlaybookSeedObservation({
        projectRoot: opts.projectRoot,
        store: opts.store,
        source: sourceFilter,
        now,
      });
      const report = buildPlaybookSeedBackfillReport({
        projectRoot: opts.projectRoot,
        store: opts.store,
        source: sourceFilter,
        apply,
        limit: backfillLimit,
        ...(apply ? { observeDigest: observe.observeDigest } : {}),
        now,
      });
      const status: PlaybookPromotionTimerStepStatus = !apply
        ? 'dry-run'
        : report.createdCount > 0 || report.deletedProposalCount > 0
          ? 'applied'
          : report.blockedCount > 0
            ? 'blocked'
            : 'skipped';
      steps.push(timerStep(
        'backfill',
        true,
        status,
        apply && status === 'applied',
        !apply,
        backfillLimit,
        `planned=${report.plannedCount} created=${report.createdCount} blocked=${report.blockedCount} alreadyRepresented=${report.alreadyRepresentedCount}`,
        report,
      ));
    } catch (err) {
      steps.push(timerStep('backfill', true, 'blocked', false, !apply, backfillLimit, (err as Error).message));
    }
  }

  if (!opts.trial) {
    steps.push(timerStep('trial', false, 'disabled', false, !apply, trialLimit, 'trial step not requested'));
  } else if (!storyId) {
    steps.push(timerStep('trial', true, 'blocked', false, !apply, trialLimit, 'trial step requires storyId'));
  } else {
    try {
      const report = buildPlaybookTrialRunReport({
        projectRoot: opts.projectRoot,
        store: opts.store,
        storyId,
        consumer: 'playbook_timer_trial',
        apply,
        limit: trialLimit,
        now,
      });
      const wrote = report.outcomeCreatedCount + report.controlCreatedCount;
      const status: PlaybookPromotionTimerStepStatus = !apply
        ? 'dry-run'
        : wrote > 0
          ? 'applied'
          : report.selectedCount > 0
            ? 'skipped'
            : 'skipped';
      steps.push(timerStep(
        'trial',
        true,
        status,
        apply && wrote > 0,
        !apply,
        trialLimit,
        `selected=${report.selectedCount} outcomeCreated=${report.outcomeCreatedCount} controlCreated=${report.controlCreatedCount}`,
        report,
      ));
    } catch (err) {
      steps.push(timerStep('trial', true, 'blocked', false, !apply, trialLimit, (err as Error).message));
    }
  }

  if (!opts.sweep) {
    steps.push(timerStep('sweep', false, 'disabled', false, !apply, sweepLimit, 'sweep step not requested'));
  } else if (apply && opts.sweepApplyEnabled !== true) {
    steps.push(timerStep('sweep', true, 'disabled', false, false, sweepLimit, 'PLAYBOOK_PROMOTION_SWEEP_ENABLED is disabled'));
  } else {
    try {
      const report = runTimerSweep(opts, sweepLimit, now);
      const status: PlaybookPromotionTimerStepStatus = !apply
        ? 'dry-run'
        : report.decisionCreatedCount > 0
          ? 'applied'
          : 'skipped';
      steps.push(timerStep(
        'sweep',
        true,
        status,
        apply && report.decisionCreatedCount > 0,
        !apply,
        sweepLimit,
        `evaluated=${report.evaluatedCount} decisionsCreated=${report.decisionCreatedCount} alreadyApplied=${report.alreadyAppliedCount}`,
        report,
      ));
    } catch (err) {
      steps.push(timerStep('sweep', true, 'blocked', false, !apply, sweepLimit, (err as Error).message));
    }
  }

  if (!opts.activate) {
    steps.push(timerStep('activate', false, 'disabled', false, !apply, null, 'activate step not requested'));
  } else {
    try {
      const report = buildPlaybookAutoPromotionApplyReport({
        projectRoot: opts.projectRoot,
        store: opts.store,
        apply,
        now,
      });
      const status: PlaybookPromotionTimerStepStatus = !apply
        ? 'dry-run'
        : report.activatedCount > 0
          ? 'applied'
          : report.blockedCount > 0 || report.globalBlockers.length > 0
            ? 'blocked'
            : 'skipped';
      steps.push(timerStep(
        'activate',
        true,
        status,
        apply && report.activatedCount > 0,
        !apply,
        null,
        `activated=${report.activatedCount} blocked=${report.blockedCount} globalBlockers=${report.globalBlockers.join(',') || 'none'}`,
        report,
      ));
    } catch (err) {
      steps.push(timerStep('activate', true, 'blocked', false, !apply, null, (err as Error).message));
    }
  }

  return {
    schemaVersion: PLAYBOOK_PROMOTION_TIMER_SCHEMA_VERSION,
    dryRun: !apply,
    applied: apply,
    sourceFilter,
    ...(storyId ? { storyId } : {}),
    bounded: true,
    limits: {
      backfill: backfillLimit,
      trial: trialLimit,
      sweep: sweepLimit,
    },
    steps,
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

export function renderPlaybookSeedObservation(report: PlaybookSeedObserveReport, json?: boolean): string {
  if (json) return JSON.stringify(report, null, 2);
  return [
    'Playbook seed observe',
    `authority: ${report.authority}`,
    `gateEvidence: ${report.gateEvidence}`,
    `sourceFilter: ${report.sourceFilter}`,
    `observeDigest: ${report.observeDigest}`,
    `proposableSeeds: ${report.proposableSeeds.length}`,
    ...report.proposableSeeds.map((seed) =>
      `  - ${seed.seedId} ${seed.sourceArtifactKind}:${seed.sourceArtifactId} canonical=${seed.canonicalSourceKey} priority=${seed.priority}`),
    `blockingSeeds: ${report.blockingSeeds.length}`,
    ...report.blockingSeeds.map((seed) =>
      `  - ${seed.seedId} reasons=${seed.blockReasons.join(',')} canonical=${seed.canonicalSourceKey || 'missing'} source=${seed.sourceArtifactKind}:${seed.sourceArtifactId}`),
    `duplicateSeedGroups: ${report.duplicateSeedGroups.length}`,
    `missingLineage: ${report.missingLineage.length}`,
    `non_promotable: ${report.nonPromotableBlocks.length} (legacy storage: non_deducible)`,
    `alreadyRepresentedSources: ${report.alreadyRepresentedSources.length}`,
    `rawFindingsWithoutDistilledExperience: ${report.rawFindingsWithoutDistilledExperience.length}`,
  ].join('\n');
}

export function renderPlaybookSeedProposalBatch(report: PlaybookSeedProposalBatchReport, json?: boolean): string {
  if (json) return JSON.stringify(report, null, 2);
  return [
    'Playbook seed propose batch',
    `dryRun: ${report.dryRun}`,
    `applied: ${report.applied}`,
    `authority: ${report.authority}`,
    `gateEvidence: ${report.gateEvidence}`,
    `observeDigest: ${report.observeDigest}`,
    `proposalManifestDigest: ${report.proposalManifestDigest}`,
    `proposalCount: ${report.proposalCount}`,
    ...report.proposals.map((row) =>
      `  - ${row.proposalId} ${row.seed.sourceArtifactKind}:${row.seed.sourceArtifactId} proposalDigest=${row.proposalDigest} candidateDigest=${row.candidatePlaybookDigest}`),
    `blockedSeedCount: ${report.blockedSeedCount}`,
    `skippedSeedCount: ${report.skippedSeedCount}`,
  ].join('\n');
}

export function renderPlaybookSeedBackfill(report: PlaybookSeedBackfillReport, json?: boolean): string {
  if (json) return JSON.stringify(report, null, 2);
  return [
    'Playbook seed backfill',
    `dryRun: ${report.dryRun}`,
    `applied: ${report.applied}`,
    `authority: ${report.authority}`,
    `gateEvidence: ${report.gateEvidence}`,
    `sourceFilter: ${report.sourceFilter}`,
    `limit: ${report.limit ?? 'all'}`,
    `observeDigest: ${report.observeDigest}`,
    `selectedSeedCount: ${report.selectedSeedCount}`,
    `plannedCount: ${report.plannedCount}`,
    `createdCount: ${report.createdCount}`,
    `skippedCount: ${report.skippedCount}`,
    `blockedCount: ${report.blockedCount}`,
    `alreadyRepresentedCount: ${report.alreadyRepresentedCount}`,
    `stagedProposalCount: ${report.stagedProposalCount}`,
    `deletedProposalCount: ${report.deletedProposalCount}`,
    `createdPlaybookIds: ${report.createdPlaybookIds.join(', ') || 'none'}`,
    ...report.candidates.map((row) =>
      `  - ${row.playbookId} ${row.sourceArtifactKind}:${row.sourceArtifactId} candidateDigest=${row.candidatePlaybookDigest} fromStagedProposal=${row.fromStagedProposal}`),
    ...report.blocked.map((row) =>
      `  blocked ${row.seedId} canonical=${row.canonicalSourceKey || 'missing'} reasons=${row.reasons.join(',')}`),
  ].join('\n');
}

export function renderPlaybookCandidateBatchManifest(report: PlaybookCandidateBatchManifestReport, json?: boolean): string {
  if (json) return JSON.stringify(report, null, 2);
  return [
    'Playbook candidate batch approve',
    `dryRun: ${report.dryRun}`,
    `applied: ${report.applied}`,
    `authority: ${report.authority}`,
    `gateEvidence: ${report.gateEvidence}`,
    `manifestDigest: ${report.manifestDigest}`,
    `proposalCount: ${report.proposalCount}`,
    ...report.proposals.map((row) =>
      `  - ${row.proposalId} ${row.sourceArtifactKind}:${row.sourceArtifactId} proposalDigest=${row.proposalDigest} candidateDigest=${row.candidatePlaybookDigest}`),
    `invalidProposals: ${report.invalidProposals.length}`,
    ...report.invalidProposals.map((row) => `  - ${row.proposalId} ${row.reason}`),
  ].join('\n');
}

export function renderPlaybookCandidateIngest(report: PlaybookCandidateIngestReport, json?: boolean): string {
  if (json) return JSON.stringify(report, null, 2);
  return [
    'Playbook candidate ingest',
    `dryRun: ${report.dryRun}`,
    `applied: ${report.applied}`,
    `authority: ${report.authority}`,
    `gateEvidence: ${report.gateEvidence}`,
    `sourceFilter: ${report.sourceFilter}`,
    `storyId: ${report.storyId ?? 'all'}`,
    `limit: ${report.limit}`,
    `observeDigest: ${report.observeDigest}`,
    `proposalManifestDigest: ${report.proposalManifestDigest}`,
    `manifestDigest: ${report.manifestDigest}`,
    `proposedCount: ${report.proposedCount}`,
    `candidateCreatedCount: ${report.candidateCreatedCount}`,
    `candidatePlaybookIds: ${report.candidatePlaybookIds.join(', ') || 'none'}`,
    `skippedCount: ${report.skippedCount}`,
    `blockedCount: ${report.blockedCount}`,
    `skippedSeedCount: ${report.skippedSeedCount}`,
    `blockedSeedCount: ${report.blockedSeedCount}`,
    `invalidProposalCount: ${report.invalidProposalCount}`,
  ].join('\n');
}

export function renderPlaybookRuntimeConsumptionVerify(report: PlaybookRuntimeConsumptionVerifyReport, json?: boolean): string {
  if (json) return JSON.stringify(report, null, 2);
  return [
    'Playbook runtime consumption verify',
    `status: ${report.status}`,
    `authority: ${report.authority}`,
    `gateEvidence: ${report.gateEvidence}`,
    `activeChecks: ${report.activeChecks.length}`,
    ...report.activeChecks.map((row) =>
      `  - ${row.playbookId} consumedByAll=${row.consumedByAll} consumers=${row.consumers.map((consumer) => `${consumer.consumer}:${consumer.consumed}`).join(',')}`),
    `candidateInertness: ${report.candidateInertness.length}`,
    ...report.candidateInertness.map((row) =>
      `  - ${row.playbookId} inert=${row.inert} label=${row.label}`),
    `diagnostics: ${report.diagnostics.length}`,
    ...report.diagnostics.map((diagnostic) => `  - ${diagnostic}`),
  ].join('\n');
}

export function renderPlaybookTrialRun(report: PlaybookTrialRunReport, json?: boolean): string {
  if (json) return JSON.stringify(report, null, 2);
  return [
    'Playbook trial run',
    `dryRun: ${report.dryRun}`,
    `applied: ${report.applied}`,
    `authority: ${report.authority}`,
    `gateEvidence: ${report.gateEvidence}`,
    `storyId: ${report.storyId}`,
    `consumer: ${report.consumer}`,
    `playbookId: ${report.playbookId ?? 'all-candidates'}`,
    `limit: ${report.limit ?? 'all'}`,
    `candidateCount: ${report.candidateCount}`,
    `selectedCount: ${report.selectedCount}`,
    `skippedByLimitCount: ${report.skippedByLimitCount}`,
    `skippedNonCandidateCount: ${report.skippedNonCandidateCount}`,
    `outcomeCreatedCount: ${report.outcomeCreatedCount}`,
    `outcomeAlreadyExistsCount: ${report.outcomeAlreadyExistsCount}`,
    `controlCreatedCount: ${report.controlCreatedCount}`,
    `controlAlreadyExistsCount: ${report.controlAlreadyExistsCount}`,
    ...report.observations.map((row) =>
      `  - ${row.playbookId} outcomeAlreadyExists=${row.outcomeAlreadyExists} controlAlreadyExists=${row.controlAlreadyExists}`),
  ].join('\n');
}

export function renderPlaybookPromotionTimer(report: PlaybookPromotionTimerReport, json?: boolean): string {
  if (json) return JSON.stringify(report, null, 2);
  return [
    'Playbook promotion timer',
    `dryRun: ${report.dryRun}`,
    `applied: ${report.applied}`,
    `authority: ${report.authority}`,
    `gateEvidence: ${report.gateEvidence}`,
    `bounded: ${report.bounded}`,
    `sourceFilter: ${report.sourceFilter}`,
    `storyId: ${report.storyId ?? 'n/a'}`,
    `limits.backfill: ${report.limits.backfill}`,
    `limits.trial: ${report.limits.trial}`,
    `limits.sweep: ${report.limits.sweep}`,
    ...report.steps.map((step) =>
      `  - ${step.step} requested=${step.requested} status=${step.status} applied=${step.applied} dryRun=${step.dryRun} limit=${step.limit ?? 'n/a'} ${step.message}`),
  ].join('\n');
}

export function renderPlaybookAutoPromotionApply(report: PlaybookAutoPromotionApplyReport, json?: boolean): string {
  if (json) return JSON.stringify(report, null, 2);
  return [
    'Playbook auto promotion apply',
    `dryRun: ${report.dryRun}`,
    `applied: ${report.applied}`,
    `activationImplemented: ${report.activationImplemented}`,
    `authority: ${report.authority}`,
    `gateEvidence: ${report.gateEvidence}`,
    `activationPolicy: ${report.activationPolicy ? `${report.activationPolicy.policyId} digest=${report.activationPolicy.policyDigest}` : 'missing'}`,
    `activatedCount: ${report.activatedCount}`,
    `skippedCount: ${report.skippedCount}`,
    `blockedCount: ${report.blockedCount}`,
    ...report.activatedPlaybooks.map((row) =>
      `  activated ${row.playbookId} activationId=${row.activationId} candidateDigest=${row.candidatePlaybookDigest} activeDigest=${row.activePlaybookDigest} decisionDigest=${row.promotionDecisionDigest}`),
    'prerequisites:',
    ...report.prerequisites.map((item) => `  - ${item}`),
    `globalBlockers: ${report.globalBlockers.length}`,
    ...report.globalBlockers.map((item) => `  - ${item}`),
    `candidateGuards: ${report.candidateGuards.length}`,
    ...report.candidateGuards.map((guard) =>
      `  - ${guard.playbookId} eligible=${guard.eligible} recommendation=${guard.recommendation} blockers=${guard.blockers.join(',') || 'none'} realOutcomes=${guard.realOutcomeCount} digest=${guard.playbookDigest}`),
    `demotionRecommendations: ${report.demotionRecommendations.length}`,
    ...report.demotionRecommendations.map((row) =>
      `  - ${row.playbookId} recommendation=${row.recommendation} autoActivated=${row.autoActivated} reasons=${row.reasonCodes.join(',') || 'none'}`),
  ].join('\n');
}
