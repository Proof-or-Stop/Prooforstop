/**
 * B-000c CHK-001: Experience Layer Phase 1a — leaf types for the finding-signals
 * derived cache.
 *
 * This module is a LEAF: it has ZERO outward imports (only `node:` builtins are
 * permitted, and none are needed today). It defines the pure data shapes shared
 * by the learning-store (read/write) and the finding-signals derivation (pure +
 * store-port adapter). Keeping these shapes in an import-free leaf is the
 * load-bearing isolation bar (mirrors the usage-ledger module's isolation): the
 * Experience Layer cannot couple back into the gate/handler graph through its
 * type surface.
 *
 * Phase boundary note: the optional enum-ish fields on `SignalSourceFinding`
 * (`signatureTag`, `resolutionType`, `dismissReasonType`) are FORWARD-COMPATIBLE.
 * Real findings do NOT carry them until Phase 1b — derivation must tolerate their
 * absence and degrade conservatively (no positive/negative signal => signalScore
 * 0).
 */

/** Per-signal status/outcome tallies. All values are plain non-negative numbers. */
export interface FindingSignalCounts {
  /** Findings whose status is `resolved`. */
  resolved: number;
  /** Findings whose status is `dismissed`. */
  dismissed: number;
  /** Findings dismissed specifically as a false positive (subset of dismissed). */
  falsePositive: number;
  /** Findings dismissed/closed as accepted risk. */
  acceptedRisk: number;
  /** Findings dismissed/closed as unclear. */
  unclear: number;
  /** Findings resolved as partially mitigated (subset of resolved). */
  partiallyMitigated: number;
}

/**
 * A single aggregated signal: one row per `localSignature`. `signalScore` is a
 * conservative positive-fraction in [0, 1]; `support` is the count of decisive
 * (positive + negative) samples backing the score.
 */
export interface FindingSignal {
  /** Aggregation key: `${category}|${signatureTag ?? ''}|${fileKind}|${lifecyclePhase ?? 'review'}`. */
  localSignature: string;
  /** Finding category bucket (e.g. happy/edge/adversarial/missing or a domain tag). */
  category: string;
  /** Optional finer-grained signature tag; absent until Phase 1b. */
  signatureTag?: string;
  /** Distinct file-kind buckets observed for this signature (deduped, sorted). */
  fileKinds: string[];
  /** Status/outcome tallies. */
  counts: FindingSignalCounts;
  /** positive / (positive + negative + 1). Never NaN: zero-sample => 0. */
  signalScore: number;
  /** positive + negative — the decisive-sample count backing `signalScore`. */
  support: number;
  /** Most recent `createdAt` observed for this signature (ISO string), if any. */
  lastSeen?: string;
  /** Up to a few example story ids contributing to this signature (deduped, sorted). */
  exampleStoryIds: string[];
  /** Up to a few example finding ids contributing to this signature (deduped, sorted). */
  exampleFindingIds: string[];
  /**
   * Bounded union of the concrete file paths the composing findings referenced
   * (deduped, sorted, capped). Used for referential re-validation — checking
   * whether a signal's code anchors still exist at HEAD. Absent when no composing
   * finding carried any files.
   */
  anchorFiles?: string[];
}

/**
 * B-5d48 CHK-001 (Experience Layer ③.2): provenance of a finding's `signatureTag`.
 * - `'confirmed'`: a reviewer (or LLM) explicitly supplied the tag — real quality.
 * - `'auto'`: a deterministic mechanical FALLBACK candidate (deriveSignatureCandidate)
 *   filled in because none was supplied.
 * - `'backfill'`: B-17a9 — a previously-empty `signatureTag` retroactively filled
 *   from a committed signature map by `signature_backfill`. Distinguishes
 *   LLM/operator-backfilled tags from live auto fallbacks and confirmed tags.
 *
 * AUDIT-ONLY: like `signatureTag` itself, this field MUST NOT be read by any gate
 * and MUST be excluded from the finding `_hash` / signFinding signature. It exists
 * only to distinguish low-quality auto fallbacks from confirmed tags downstream.
 */
export type SignatureTagSource = 'auto' | 'confirmed' | 'backfill';

/** The derived-cache envelope persisted to `.lattice/learning/finding-signals.json`. */
export interface FindingSignalsCache {
  /** Schema version of this cache shape. */
  schemaVersion: number;
  /** ISO timestamp the cache was derived (deterministic; passed into derivation). */
  updatedAt: string;
  /** Aggregated signals, one per `localSignature` (stable, sorted). */
  signals: FindingSignal[];
  /**
   * B-1a91 CHK-003: coverage watermark — how much of the finding corpus this cache
   * actually summarizes, so a silently-missed/failed DONE auto-refresh (CHK-001 is
   * never-throw) is DETECTABLE by comparing this watermark against the live store.
   * ALL THREE fields are ADDITIVE + OPTIONAL: a legacy cache written before this
   * field set carries none of them, and learning_validate degrades to a "coverage
   * unknown" report rather than crashing or producing a false gap.
   *
   * Counted with the SAME enumeration deriveFindingSignals(FromStore) uses to build
   * the signals (every considered finding / every distinct story id / the max
   * createdAt|resolvedAt folded in), so a fresh scan yields a 0 gap (no false
   * positive). Story ids are B-xxxx hashes, NOT a monotone sequence, so the
   * watermark is a count + a max-timestamp, never a literal story sequence number.
   */
  /** Number of findings considered when this cache was derived. */
  coveredFindingCount?: number;
  /** Number of distinct story ids that contributed findings to this cache. */
  coveredStoryCount?: number;
  /** Max finding `createdAt`/`resolvedAt` (ISO) folded into this cache; absent when none had a timestamp. */
  coveredThrough?: string;
}

// ── B-8387 (Experience Layer Phase 2): staged Process Playbook lifecycle ──────
//
// A Playbook distils a resolved finding into a reusable check the team can apply
// proactively. The lifecycle is STAGED and human-gated:
//   finding -> PlaybookProposal (proposed) -> [diff] -> Playbook (candidate)
// `active` is NEVER auto-set by approve; promoting a candidate to active is a
// separate fail-closed activation command. These shapes stay in this LEAF (zero
// outward imports) so the playbook surface cannot couple back into the
// gate/handler graph through its type surface.

/**
 * Provenance binding a playbook (and its proposal) back to the source finding it
 * was distilled from. All three carried verbatim through the approve boundary.
 */
export interface PlaybookLineage {
  /** Story the source finding belonged to. */
  sourceStoryId: string;
  /** Finding id the playbook was distilled from (e.g. `B-xxx:F-001`). */
  sourceFindingId: string;
  /** Optional coarse signatureTag of the source finding (Phase 1b), if present. */
  sourceSignature?: string;
}

/**
 * Cheap surfacing predicates: when a future surfacing step (out of scope here)
 * decides whether to remind on a playbook. All arrays may be empty (a proposal
 * with no obvious trigger is still valid; surfacing simply never fires).
 */
export interface PlaybookTrigger {
  /** Free-text keywords seeded from the finding (deduped, sorted). */
  keywords: string[];
  /** File-kind buckets seeded from the finding's files (deduped, sorted). */
  fileKinds: string[];
  /** Story phases the playbook is relevant in (deduped, sorted). */
  storyPhases: string[];
}

/** Lifecycle status of a Playbook. `active` requires explicit activation. */
export type PlaybookStatus = 'proposed' | 'candidate' | 'active' | 'stale' | 'archived';

export type PlaybookSeedSourceKind = 'dev_memory' | 'finding_signal' | 'done_experience' | 'finding';

export interface PlaybookSeedMaterial {
  sourceSummary?: string;
  sourcePitfalls?: string[];
  sourceVerification?: string[];
}

/**
 * Additive metadata for proposals created by the historical seed batch flow.
 * Older hand-authored proposals omit this field and remain valid. Candidate
 * playbooks keep the existing Playbook shape; source lineage is still carried
 * through `lineage`.
 */
export interface PlaybookSeedReference {
  sourceArtifactKind: PlaybookSeedSourceKind;
  sourceArtifactId: string;
  sourceRef: string;
  canonicalSourceKey: string;
  canonicalSourceKeyVersion: string;
  canonicalizationPolicyHash: string;
  rawSourceKey?: string;
}

/**
 * A staged proposal: the pre-approval form of a Playbook, persisted to
 * `.lattice/learning/proposals/<id>.json`. `proposalDigest` binds the proposal
 * content (everything EXCEPT the digest field itself) so approve can fail closed
 * on a stale `--expectedProposalDigest` — exactly the decision-doc pattern.
 */
export interface PlaybookProposal {
  /** Minted proposal id (e.g. `PBP-001`). */
  id: string;
  title: string;
  trigger: PlaybookTrigger;
  /** The proactive check the playbook recommends. */
  check: string;
  /** Pitfalls to watch for (deduped order-preserving). */
  pitfalls: string[];
  /** How to verify the check was honoured. */
  verification: string[];
  lineage: PlaybookLineage;
  seed?: PlaybookSeedReference;
  /** Always `proposed` while it lives as a proposal file. */
  status: 'proposed';
  /** sha256 over the canonical proposal domain MINUS this field. */
  proposalDigest: string;
}

/** Per-playbook usage counters. All non-negative; zeroed at candidate creation. */
export interface PlaybookUsage {
  /** Times the playbook was surfaced to a worker/reviewer. */
  surfacedCount: number;
  /** Surfaced and the worker reported it helped resolve something. */
  resolvedHits: number;
  /** Surfaced and the worker dismissed it as not relevant. */
  dismissedHits: number;
}

/**
 * An approved Playbook, persisted in `.lattice/learning/playbooks.json`.
 * `playbook_approve` creates status `candidate`; `playbook_activate` is the
 * only explicit boundary to status `active`. Carries the same core content as
 * the proposal plus a lifecycle status and usage counters.
 */
export interface Playbook {
  id: string;
  title: string;
  trigger: PlaybookTrigger;
  check: string;
  pitfalls: string[];
  verification: string[];
  lineage: PlaybookLineage;
  status: PlaybookStatus;
  usage: PlaybookUsage;
}

// ── B-dddd M0-M2: append-only playbook outcome ledger ────────────────────────
//
// Outcome events are explicit, audit-only learning observations. They do NOT
// activate, reject, promote, demote, or surface playbooks at runtime; they only
// record what a caller observed after a concrete exposure (or non-exposure).

export type PlaybookOutcomeSchemaVersion = 'proofbound.playbook-outcome.v1';
export type PlaybookExposureMode = 'candidate-inspection' | 'active-advisory' | 'none';
export type PlaybookOutcomeVerdict = 'helped' | 'neutral' | 'dismissed' | 'harmful' | 'unknown';

export interface PlaybookOutcomeContext {
  storyPhase?: string;
  storyType?: string;
  fileKinds: string[];
  triggerClasses: string[];
  host?: string;
  hostProvider?: string;
  hostCapabilityId?: string;
}

export interface PlaybookOutcomeVerdictData {
  verdict: PlaybookOutcomeVerdict;
  verdictSource: string;
  causedNoise: boolean;
  causedWrongClaim: boolean;
  preventedRepeatFinding: boolean;
  note?: string;
}

export interface PlaybookOutcomeBindings {
  headHash?: string;
  storyFilesHash?: string;
  materialHash?: string;
  summaryDigest?: string;
  deliveryCheckDigest?: string;
}

export interface PlaybookOutcomeEvent {
  schemaVersion: PlaybookOutcomeSchemaVersion;
  eventId: string;
  idempotencyKey: string;
  observedAt: string;
  storyId: string;
  playbookId: string;
  playbookStatusAtObservation: 'candidate' | 'active';
  exposureMode: PlaybookExposureMode;
  consumer: string;
  context: PlaybookOutcomeContext;
  outcome: PlaybookOutcomeVerdictData;
  bindings: PlaybookOutcomeBindings;
  authority: 'non_authoritative';
  gateEvidence: false;
}

export type PlaybookTrialControlSchemaVersion = 'proofbound.playbook-trial-control.v1';

export interface PlaybookTrialControlEvent {
  schemaVersion: PlaybookTrialControlSchemaVersion;
  controlId: string;
  idempotencyKey: string;
  observedAt: string;
  storyId: string;
  playbookId: string;
  candidatePlaybookDigest: string;
  consumer: string;
  context: PlaybookOutcomeContext;
  control: {
    exposureMode: 'none';
    matchedOn: string[];
    verdict: 'unknown';
    verdictSource: 'matched-control';
    causedNoise: false;
    causedWrongClaim: false;
    preventedRepeatFinding: false;
  };
  authority: 'non_authoritative';
  gateEvidence: false;
}

// ── B-6241: playbook promotion worker V1 metadata ───────────────────────────
//
// These rows are local learning metadata under `.lattice/learning/`. They are
// explicitly non-authoritative and must never be consumed as lifecycle evidence.

export type PlaybookPromotionDecisionSchemaVersion = 'proofbound.playbook-promotion-decision.v1';
export type PlaybookAutoActivationSchemaVersion = 'proofbound.playbook-auto-activation.v1';
export type NonDeducibleSourceSchemaVersion = 'proofbound.non-deducible-sources.v1';
export type PlaybookPromotionHealthSchemaVersion = 'proofbound.playbook-promotion-health.v1';

export type PlaybookPromotionDecisionAction =
  | 'recommend_activate'
  | 'reject'
  | 'hold'
  | 'archive'
  | 'recommend_demote'
  | 'mark_non_deducible';

export interface PlaybookSourceReference {
  sourceKey: string;
  sourceStoryId: string;
  sourceFindingId: string;
  sourceSignature?: string;
}

export interface PlaybookPromotionAggregate {
  playbookId: string;
  status: PlaybookStatus;
  decisiveSamples: number;
  helpedCount: number;
  dismissedCount: number;
  harmfulCount: number;
  wrongClaimCount: number;
  neutralCount: number;
  unknownCount: number;
  contextClassCount: number;
  sourceRejectedSiblingCount: number;
  source: PlaybookSourceReference;
  aggregateDigest: string;
}

export interface PlaybookPromotionConfig {
  minDecisiveSamples: number;
  minHelpedCount: number;
  minContextClasses: number;
  maxDismissalRate: number;
  maxHarmfulCount: number;
  maxWrongClaimCount: number;
  nonDeducibleRejectedSiblingThreshold: number;
  retentionMaxBytes: number;
}

export interface PlaybookPromotionEvaluation {
  action: PlaybookPromotionDecisionAction;
  reasonCodes: string[];
}

export interface PlaybookPromotionDecisionRow {
  schemaVersion: PlaybookPromotionDecisionSchemaVersion;
  decisionId: string;
  idempotencyKey: string;
  decidedAt: string;
  playbookId: string;
  evaluatedStatus: PlaybookStatus;
  action: PlaybookPromotionDecisionAction;
  reasonCodes: string[];
  aggregateDigest: string;
  aggregate: PlaybookPromotionAggregate;
  before: {
    playbookStatus: PlaybookStatus;
    playbookDigest: string;
    sourceKey: string;
  };
  after: {
    playbookStatus: PlaybookStatus;
    recommendation: PlaybookPromotionDecisionAction;
    nonDeducibleSourceKey?: string;
  };
  workerVersion: 'playbook-promotion-worker-v1';
  dryRun: boolean;
  applied: boolean;
  alreadyApplied: boolean;
  authority: 'non_authoritative';
  gateEvidence: false;
}

export interface PlaybookAutoActivationEvent {
  schemaVersion: PlaybookAutoActivationSchemaVersion;
  activationId: string;
  idempotencyKey: string;
  activatedAt: string;
  playbookId: string;
  before: {
    playbookStatus: 'candidate';
    playbookDigest: string;
  };
  after: {
    playbookStatus: 'active';
    playbookDigest: string;
  };
  policy: {
    policyId: string;
    policyDigest: string;
    reviewedBy: string;
  };
  evidence: {
    aggregateDigest: string;
    decisionId: string;
    decisionIdempotencyKey: string;
    decisionDigest: string;
    recommendation: 'recommend_activate';
    reasonCodes: string[];
    decisiveSamples: number;
    helpedCount: number;
    dismissedCount: number;
    harmfulCount: number;
    wrongClaimCount: number;
    contextClassCount: number;
    realOutcomeCount: number;
    exposureCount: number;
    lineageCanonicalSourceKey: string;
  };
  authority: 'non_authoritative';
  gateEvidence: false;
}

// ── B-521d: read-only playbook promotion observation ─────────────────────────

export type PlaybookPromotionObserveSchemaVersion = 'proofbound.playbook-promotion-observe.v1';
export type PlaybookPromotionObserveSinceMode = 'all' | 'iso' | 'relative';
export type PlaybookPromotionActionableRecommendation = Extract<
  PlaybookPromotionDecisionAction,
  'recommend_activate' | 'reject' | 'archive' | 'recommend_demote' | 'mark_non_deducible'
>;
export type PlaybookPromotionRecommendationHandlingStatus = 'handled' | 'unhandled';

export interface PlaybookPromotionObserveSinceWindow {
  mode: PlaybookPromotionObserveSinceMode;
  input?: string;
  start?: string;
  end: string;
}

export interface PlaybookPromotionCandidateGeneratedObservation {
  playbookId: string;
  title: string;
  status: 'candidate';
  playbookDigest: string;
  source: PlaybookSourceReference;
}

export interface PlaybookPromotionCandidateConsumedObservation {
  eventId: string;
  observedAt: string;
  storyId: string;
  playbookId: string;
  currentPlaybookStatus?: PlaybookStatus;
  exposureMode: PlaybookExposureMode;
  consumer: string;
  verdict: PlaybookOutcomeVerdict;
  verdictSource: string;
}

export interface PlaybookPromotionRecommendationHandlingObservation {
  decisionId: string;
  decidedAt: string;
  playbookId: string;
  action: PlaybookPromotionActionableRecommendation;
  aggregateDigest: string;
  reasonCodes: string[];
  handlingStatus: PlaybookPromotionRecommendationHandlingStatus;
  handledBy?: string;
  currentPlaybookStatus?: PlaybookStatus;
}

export interface PlaybookPromotionObserveReport {
  schemaVersion: PlaybookPromotionObserveSchemaVersion;
  observedAt: string;
  since: PlaybookPromotionObserveSinceWindow;
  candidateGenerated: {
    currentCandidates: number;
    count: number;
    malformedPlaybooks: number;
    candidates: PlaybookPromotionCandidateGeneratedObservation[];
  };
  candidateConsumed: {
    consumedCandidateCount: number;
    count: number;
    uniquePlaybookCount: number;
    unconsumedCurrentCandidateIds: string[];
    malformedOutcomeRows: number;
    excluded: {
      exposureModeNone: number;
      nonCandidateStatus: number;
      outsideSince: number;
    };
    rows: PlaybookPromotionCandidateConsumedObservation[];
  };
  recommendationHandling: {
    actionableCount: number;
    handledCount: number;
    unhandledCount: number;
    malformedDecisionRows: number;
    excluded: {
      unapplied: number;
      nonActionableAction: number;
      outsideSince: number;
    };
    recommendations: PlaybookPromotionRecommendationHandlingObservation[];
  };
  authority: 'non_authoritative';
  gateEvidence: false;
}

export interface NonDeducibleOverrideEvent {
  overrideId: string;
  acceptedAt: string;
  sourceKey: string;
  sourceFindingId: string;
  reasonDigest: string;
  reasonLength: number;
  proposalId?: string;
}

export interface NonDeducibleSourceRecord {
  schemaVersion: 'proofbound.non-deducible-source.v1';
  source: PlaybookSourceReference;
  markedAt: string;
  reasonCodes: string[];
  reason: string;
  sourceRejectedSiblingCount: number;
  aggregateDigest?: string;
  latestDecisionId?: string;
  overrideEvents: NonDeducibleOverrideEvent[];
  authority: 'non_authoritative';
  gateEvidence: false;
}

export interface NonDeducibleSourcesRegistry {
  schemaVersion: NonDeducibleSourceSchemaVersion;
  updatedAt: string;
  sources: NonDeducibleSourceRecord[];
  authority: 'non_authoritative';
  gateEvidence: false;
}

export type PlaybookPromotionHealthKind = 'done-settlement' | 'retention' | 'validation';
export type PlaybookPromotionSettlementStatus = 'disabled' | 'recorded' | 'failed';

export interface PlaybookPromotionHealthEvent {
  schemaVersion: PlaybookPromotionHealthSchemaVersion;
  eventId: string;
  idempotencyKey: string;
  observedAt: string;
  kind: PlaybookPromotionHealthKind;
  settlementStatus?: PlaybookPromotionSettlementStatus;
  storyId?: string;
  message: string;
  authority: 'non_authoritative';
  gateEvidence: false;
}

// ── B-7561 (Experience Layer Phase 3): Story Recall — structured-field similarity ──
//
// The FINAL slice distils each story's existing metadata (read through the
// `story_list` scan) into a compact `StoryProfile`, then ranks profiles by a
// MULTI-FIELD structured similarity (Jaccard over keyword/fileKind/touchpoint
// sets + small type/phase boosts). There is NO FTS, NO derived index, and NO
// embedding: recall is a pure, read-only projection over the live story set.
// These shapes stay in this LEAF (zero outward imports) so the recall surface
// cannot couple back into the gate/handler graph through its type surface.

/**
 * A compact, comparable distillation of one story's structured metadata. Every
 * array is deduped + sorted by `buildStoryProfile` so two profiles built from
 * the same metadata are byte-identical (determinism). All free-text fields are
 * conservative projections — recall never reads gate-bearing finding internals.
 */
export interface StoryProfile {
  storyId: string;
  title: string;
  /** Story type bucket (e.g. feature/chore/fix); '' when unknown. */
  type: string;
  /** Lifecycle phase (e.g. DEV/REVIEW/DONE); '' when unknown. */
  phase: string;
  /** Priority bucket (e.g. medium/high); '' when unknown. */
  priority: string;
  /** Domain/module/concept tokens (from title + understanding + finding signatures). */
  keywords: string[];
  /** Coarse file-kind buckets (extensions / top dirs) from touchpoints + finding files. */
  fileKinds: string[];
  /** Code touchpoints (impact-scope paths) from the understanding snapshot + finding files. */
  touchpoints: string[];
  /** High-risk signal categories surfaced on the story. */
  riskSignals: string[];
  /** Short notable-finding summaries (signature/desc projections). */
  notableFindings: string[];
  /** Short notable-decision summaries (the chosen option + rationale gist). */
  notableDecisions: string[];
  /** The story's recorded outcome (understanding.outcome), if any. */
  outcome?: string;
}

/**
 * One ranked recall hit: a candidate `StoryProfile` plus the score and the
 * human-readable `reasons` (which field dimensions overlapped) explaining WHY
 * it ranked. `score` is a deterministic, symmetric similarity in [0, ~1.x].
 */
export interface RecallMatch {
  storyId: string;
  title: string;
  score: number;
  reasons: string[];
  profile: StoryProfile;
}

/**
 * The input shape the derivation reads. A narrowed projection of a real Finding
 * plus the Phase-1b forward-compatible optional fields. ALL fields are optional
 * so malformed/legacy findings are tolerated without throwing.
 */
export interface SignalSourceFinding {
  storyId?: string;
  id?: string;
  category?: string;
  status?: string;
  files?: string[];
  /** Phase 1b forward-compat: finer signature tag (absent on real findings today). */
  signatureTag?: string;
  /** Phase 1b forward-compat: e.g. `fixed` | `partially_mitigated` (absent today). */
  resolutionType?: string;
  /** Phase 1b forward-compat: e.g. `false_positive` | `out_of_scope` | ... (absent today). */
  dismissReasonType?: string;
  /** Phase 1b forward-compat: lifecycle phase the finding was raised in. */
  lifecyclePhase?: string;
  createdAt?: string;
  /** B-1a91 CHK-003: resolution timestamp; folded into the coverage watermark (`coveredThrough`). */
  resolvedAt?: string;
}

// -- B-01df M1: read-only learning source lineage audit ----------------------

export type SourceLineageAuditSchemaVersion = 'proofbound.source-lineage-audit.v1';
export type SourceLineageDomain = 'learning';
export type SourceLineageAuthority = 'non_authoritative';
export type SourceLineageCanonicalKeyVersion = 'proofbound.learning-source-key.v1';

export type SourceLineageArtifactKind =
  | 'dev_memory'
  | 'finding_signal'
  | 'done_experience'
  | 'finding'
  | 'playbook_proposal'
  | 'playbook'
  | 'playbook_outcome'
  | 'playbook_promotion_decision'
  | 'playbook_auto_activation';

export interface SourceLineageDiagnostic {
  code: string;
  severity: 'info' | 'warning';
  message: string;
  path?: string;
  artifactKind?: SourceLineageArtifactKind;
  artifactId?: string;
}

export interface SourceLineageAuditRecord {
  artifactKind: SourceLineageArtifactKind;
  artifactId: string;
  sourceRef: string;
  canonicalSourceKey: string | null;
  canonicalSourceKeyVersion: SourceLineageCanonicalKeyVersion;
  canonicalizationPolicyHash: string;
  rawSourceKey?: string;
  sourceStoryId?: string;
  sourceFindingId?: string;
  sourceSignature?: string;
  support?: number;
  anchorRefs?: string[];
  sourceSummary?: string;
  sourcePitfalls?: string[];
  sourceVerification?: string[];
  lineagePresent: boolean;
  authority: SourceLineageAuthority;
  gateEvidence: false;
}

export interface DuplicateCanonicalSourceGroup {
  canonicalSourceKey: string;
  recordCount: number;
  records: SourceLineageAuditRecord[];
}

export interface SourceLineageAuditReport {
  schemaVersion: SourceLineageAuditSchemaVersion;
  domain: SourceLineageDomain;
  auditedAt: string;
  canonicalSourceKey: string;
  canonicalSourceKeyVersion: SourceLineageCanonicalKeyVersion;
  canonicalizationPolicyHash: string;
  sourceRecordCount: number;
  missingLineageCount: number;
  duplicateCanonicalSourceGroups: DuplicateCanonicalSourceGroup[];
  records: SourceLineageAuditRecord[];
  diagnostics: SourceLineageDiagnostic[];
  authority: SourceLineageAuthority;
  gateEvidence: false;
}
