
export type {
  ValidationCommand,
  ValidationCommandResult,
  ValidationPlan,
  ValidationResult,
  ValidationStatus,
  DoneRequiredCommandReceipt,
  DoneRequiredEvidenceData,
  DoneRequiredEvidenceStatus,
} from './validation-types.js';
import type { SignatureTagSource } from './experience-layer-types.js';

export type StoryPhase = 'IDEA' | 'INIT' | 'INIT_CHECK' | 'PLAN' | 'DEV' | 'REVIEW' | 'TEST' | 'DONE' | 'DISCARDED'
  // Legacy phases kept for backward compat with existing story data
  | 'TEST_CASE' | 'TEST_CASE_REVIEW'
  // B-9bd9 CHK-002: meta-story dedicated phase, never enters DONE (cross-story container, only attaches findings)
  | 'META';

export type StoryType = 'feature' | 'bug' | 'refactor' | 'chore' | 'meta';

export interface StoryEvent {
  phase: StoryPhase;
  action: 'create' | 'advance' | 'discard' | 'reviewer_forced';
  timestamp: string;
  branch?: string;
  user?: string;
  sessionId?: string;
  agent?: string;
  reason?: string;
  reviewer?: string;
}

export interface StoryInfo {
  storyId: string;
  name: string;
  title: string;
  description: string;
  type: StoryType;
  phase: StoryPhase;
  priority: string;
  source?: string;
  depends?: string[];
  /** Keywords: domain/module/concept, used for deduplication and inventory (not tied to checklist items) */
  keywords?: string[];
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  events?: StoryEvent[];
  worktree?: {
    path: string;
    branch: string;
    createdAt: string;
  };
  /** Current REVIEW round ID (ISO 8601 timestamp), generated each time REVIEW is entered */
  currentReviewRound?: string;
  /** High-risk signals (auto-detection): triggered keyword categories */
  riskSignals?: Array<{ category: string; matched: string }>;
  /**
   * B-5010 CHK-004: risk signal explicitly dismissed by the main agent (false-positive whitelist).
   * story_review skips dismissed categories when determining isHighRisk / advisory message.
   * Dismiss is append-only, no revocation supported (so dismissal reasons remain visible during retrospectives).
   */
  riskSignalsDismissed?: Array<{ category: string; reason: string; at: string }>;
  /**
   * B-30b2 CHK-001: records the original (pre-elevation) priority when story_create automatically
   * elevates priority due to riskSignals hits. Only written when "auto-elevation actually changed priority"; user-explicitly-set
   * high/critical does not write this field. After story_review_dismiss, if no active riskSignal
   * remains, priority is reverted to this value (only when it's a legal priority < high), thereby relieving
   * the high-risk gate cost derived from auto-elevation, without erroneously downgrading user-explicitly-set high/critical.
   */
  priorityElevatedFrom?: string;

  // Parallel policy fields (B-c622)
  lane?: 'mainline' | 'supporting' | 'exploratory';
  parallelSafe?: 'yes' | 'no' | 'plan_only';
  sharedHotspots?: string[];
  blockingFor?: string[];
}

export type ChecklistStatus = 'pending' | 'in_progress' | 'done';

export type VerificationLane = 'happy' | 'edge' | 'adversarial';
export type VerificationIntentType = 'logic' | 'cli' | 'browser' | 'manual' | 'docs';
export type VerificationRequiredIn = 'light' | 'balanced' | 'strict';
export type VerificationPriority = 'must' | 'should' | 'nice';
export type VerificationEvidenceKind = 'logic_test' | 'integration_test' | 'browser_test' | 'manual_transcript' | 'docs_check' | 'waiver';
export const VERIFICATION_EVIDENCE_VERDICTS = ['success', 'blocked_classified', 'audit_only', 'waived'] as const;
export type VerificationEvidenceVerdict = typeof VERIFICATION_EVIDENCE_VERDICTS[number];

export function formatVerificationEvidenceVerdict(verdict: VerificationEvidenceVerdict): string {
  return verdict.replaceAll('_', '-');
}

export interface VerificationIntentItem {
  /** Optional stable id. If absent, Proofbound derives CHK-001:happy:0 from lane/index. */
  id?: string;
  desc: string;
  type: VerificationIntentType;
  requiredIn?: VerificationRequiredIn;
  priority?: VerificationPriority;
}

export type VerificationIntent = Record<VerificationLane, VerificationIntentItem[]>;

export interface AttestationMetadata {
  /** Source kind: ci = automated pipeline, human = manual reviewer. */
  kind?: 'ci' | 'human';
  /** Actor identity (CI job name, username, agent id). */
  actor?: string;
  /** Claims that were checked (feature/behavior descriptions). */
  checkedClaims?: string[];
  /** Command or test that produced the evidence. */
  command?: string;
  /** Path or URL of the CI artifact, log, or transcript. */
  artifactRef?: string;
  /** Digest of the artifact for integrity binding. */
  artifactDigest?: string;
  /** Pass/fail summary from the attestor. */
  result?: 'pass' | 'fail';
  /** ISO timestamp when the attestation was recorded. */
  attestedAt?: string;
}

export interface ActorTrustMetadata {
  /** Identity of the actor that produced this evidence (agent id, user id, CI job). */
  actorId?: string;
  /** Actor that produced/ran the verification (may equal actorId). */
  producerActorId?: string;
  /** Actor that independently verified the result (should differ from producerActorId in strict). */
  verifierActorId?: string;
  /** Run/job identifier for the producer (e.g. CI run id, session id). */
  producerRunId?: string;
  /** Run/job identifier for the verifier. */
  verifierRunId?: string;
  /** Provider/platform (e.g. "github-actions", "claude-agent"). */
  provider?: string;
  /** Vendor of the agent or tool (e.g. "anthropic", "openai"). */
  vendor?: string;
  /** Model identifier if the actor is an LLM. */
  model?: string;
  /** Provider of the producer actor (for cross-provider independence checks). */
  producerProvider?: string;
  /** Vendor of the producer actor. */
  producerVendor?: string;
  /** Model of the producer actor. */
  producerModel?: string;
  /** Provider of the verifier actor (should differ from producerProvider in strict). */
  verifierProvider?: string;
  /** Vendor of the verifier actor. */
  verifierVendor?: string;
  /** Model of the verifier actor. */
  verifierModel?: string;
  /** Explicit trust status override ("trusted" | "revoked"). */
  trustStatus?: 'trusted' | 'revoked';
}

export interface FactProvenanceMetadata {
  /** Classifies whether the evidence refers to external, local, or internal facts. */
  kind?: 'external_fact' | 'local' | 'internal';
  /** Source reliability tier. */
  sourceClass?: 'primary' | 'secondary' | 'tertiary' | 'internal';
  /** URL of the external source. */
  sourceUrl?: string;
  /** Stable reference (DOI, RFC number, commit SHA, etc.) */
  sourceRef?: string;
  /** Human-readable title of the source. */
  sourceTitle?: string;
  /** ISO timestamp when the external fact was fetched. */
  fetchedAt?: string;
  /** ISO timestamp after which the fact should be re-verified. */
  expiresAt?: string;
  /** Content digest (hash) of the fetched source for integrity binding. */
  digest?: string;
  /** Specific claims that were checked against the source. */
  checkedClaims?: string[];
  /** Other sources that contradict this fact. Non-empty triggers a warning/block. */
  conflictingSources?: string[];
}

export interface VerificationEvidence {
  /** Reference like CHK-001:happy:0 or a custom VerificationIntentItem.id. */
  intentRef: string;
  kind: VerificationEvidenceKind;
  /** Human-facing classification; does not override result/pass/fail gate semantics. */
  verdict?: VerificationEvidenceVerdict;
  /** Deferred waivers are temporary gate-self-test receipts and must be replaced by real evidence before TEST. */
  waiverType?: 'permanent' | 'deferred_gate_evidence';
  file?: string;
  command?: string;
  result?: 'pass' | 'fail';
  note: string;
  /** Optional git HEAD captured when evidence was recorded. */
  headHash?: string;
  /** Hash of tracked non-story-metadata files captured when evidence was recorded. */
  materialHash?: string;
  /** Hash of story-owned material files vs merge-base main captured when evidence was recorded. */
  storyFilesHash?: string;
  timestamp?: string;
  /** Structured CI/human attestation metadata. All fields optional for legacy compatibility. */
  attestation?: AttestationMetadata;
  /** Actor trust metadata for producer/verifier identity and revocation checks. All fields optional. */
  actorTrust?: ActorTrustMetadata;
  /** External fact provenance metadata. All fields optional for legacy compatibility. */
  factProvenance?: FactProvenanceMetadata;
}

export interface ChecklistItem {
  id: string;
  title: string;
  /** Root cause/reference solution, provides context to the executing agent (optional) */
  context?: string;
  /** Related document paths, manually declared in PLAN phase, used for triple reminders (DEV/done/DONE) */
  relatedDocs?: string[];
  /** User-visible output description: the specific text the user sees in the terminal/UI after completing this item (not an abstract description) */
  userSees?: string;
  /** Explicitly declared features that are not included */
  excludes?: string[];
  /**
   * B-45ed CHK-001: Set of affected files, declared in PLAN phase.
   * story_review will use this to perform coverage validation against understanding.touchpoints (CHK-002).
   * modify: files to be modified; create: files to be newly created; test: test files to be covered.
   */
  files?: {
    readonly modify: readonly string[];
    readonly create: readonly string[];
    readonly test: readonly string[];
  };
  /**
   * Test discipline folded into the second lifecycle:
   * PLAN records happy/edge/adversarial intent, DEV/REVIEW/TEST attach evidence.
   */
  verificationIntent?: VerificationIntent;
  verificationEvidence?: VerificationEvidence[];
  /** @deprecated Legacy item phase from TEST_CASE lifecycle. New flow uses DEV/REVIEW/TEST only. */
  phase?: 'DEV' | 'TEST_CASE';
  /** @deprecated Legacy testIntent kept for old story data and compatibility helpers. */
  testIntent?: TestIntent | null;
  status: ChecklistStatus;
  startTime: string | null;
  endTime: string | null;
}

export type TestIntentType = 'cli_blackbox' | 'browser_blackbox';

export interface TestIntentItem {
  desc: string;
  type: TestIntentType;
  results?: TestIntentResult[];
}

export interface TestIntentResult {
  time: string;
  pass?: boolean;
  note: string;
  role?: 'reviewer' | 'author' | 'intent';
}

export type TestIntentEntry = TestIntentItem | string;

/** @deprecated Use verificationIntent. */
export interface TestIntent {
  happy: TestIntentEntry[];
  edge: TestIntentEntry[];
  adversarial: TestIntentEntry[];
}

export interface ChecklistAuditEntry {
  timestamp: string;
  phase: StoryPhase;
  itemId: string;
  action: 'update' | 'delete' | 'add';
  from: ChecklistStatus;
  to: ChecklistStatus;
  reason: string;
  agent?: string;
  /** On add, records the initial content of the newly added item, for story_review to display PLAN replan/scope audit */
  addedTitle?: string;
  addedContext?: string;
  /** On delete, records the original content of the deleted item, for story_review gate display */
  removedTitle?: string;
  removedContext?: string;
  removedUserSees?: string;
  /** checklist_dispose adjudication result */
  disposition?: 'accept' | 'reject' | 'partial';
  justification?: string;
  disposedAt?: string;
}

export interface ChecklistData {
  items: ChecklistItem[];
  auditLog?: ChecklistAuditEntry[];
}

export interface ReviewIssue {
  type: string;
  severity?: 'blocker' | 'advisory';
  itemId?: string;
  message: string;
}

export interface ReviewEntry {
  timestamp: string;
  issueCount: number;
  blockerCount?: number;
  issues: ReviewIssue[];
  _hash?: string;
}

export interface ReviewData {
  reviews: ReviewEntry[];
}

export type StoryAdvanceReasonCode =
  | 'missing_test_intent'
  | 'story_review_missing'
  | 'story_review_failed'
  | 'review_signature_invalid'
  | 'dev_checklist_incomplete'
  | 'review_failed'
  | 'test_evidence_missing'
  | 'test_failed'
  | 'bug_open'
  | 'transition_blocked';

export interface PhaseInvariantIssue {
  code: string;
  detail: string;
}

export interface PhaseGateDecision {
  targetPhase: string;
  ok: boolean;
  outcome: 'allow' | 'block' | 'rollback';
  reasonCode: StoryAdvanceReasonCode | null;
  issues: PhaseInvariantIssue[];
  humanHint: string | null;
  rollbackPhase?: StoryPhase | null;
}

export interface ImplementationReviewFinding {
  file: string;
  line: number;
  why: string;
  severity: 'info' | 'medium' | 'high';
}

export interface ImplementationReviewResultData {
  storyId: string;
  verdict: 'pass' | 'fail';
  findings: ImplementationReviewFinding[];
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export type BugStatus = 'open' | 'fixed';

export interface BugDiagnose {
  rootCause: string[];
  /** @deprecated Legacy field from trace profiler era, may exist in stored JSON */
  traceDiff?: { added: number; removed: number; forked: number } | null;
  suggestedFix: string;
}

/** Manual debugging evidence chain (Systematic Debugging artifact) */
export interface BugEvidence {
  /** User-observable symptom description */
  symptom: string;
  /** Minimal reproduction steps */
  reproSteps: string[];
  /** Hypotheses validated during debugging */
  hypothesis?: string;
  /** Confirmed root cause */
  rootCause: string;
  /** Fix point description (what was changed, why it works) */
  fixEvidence: string;
  /** Reproduction test path (logicTest / integrationTest) */
  reproTest?: string;
}

export interface BugRecord {
  id: string;
  title: string;
  status: BugStatus;
  foundAt: string;
  fixedAt: string | null;
  /** Associated checklist item ID (optional) */
  checklistId?: string;
  /** Associated fixture case uuid (optional) */
  fixtureId?: string;
  /** Auto-diagnosis result (populated when validate fails) */
  diagnose?: BugDiagnose;
  /** Manual debug evidence chain (populated when bug_update status=fixed) */
  evidence?: BugEvidence;
}

export interface BugData {
  bugs: BugRecord[];
}

export const STORY_OUTCOME_KINDS = ['success', 'blocked', 'audit_only'] as const;
export type StoryOutcomeKind = typeof STORY_OUTCOME_KINDS[number];

/**
 * B-093b: Story completion summary written before advancing to DONE.
 *
 * Agents call `summary_set` to fill this. The `realMachineCoverage` field is
 * auto-scaffolded by scanning test-evidence + fixtures with `sandbox: false`,
 * so agents can't fabricate "already ran" claims. Agents only supply `skipReasons`
 * for the cases marked as not-run.
 *
 * Stored at `docs/story/actives/<storyId>/summary.json`.
 */
export interface StorySummaryData {
  /** Story ID, for sanity check on read/write */
  storyId: string;
  /** What changed: key changes per file, from the user's perspective */
  changes: string;
  /** How to use: slash command / tool / invocation example */
  usage: string;
  /** User-value acceptance: expected user-visible result from PLAN/summary */
  expectedOutcome?: string;
  /** User-value acceptance: transcript / output summary observed after real run */
  actualTranscript?: string;
  /** User-value acceptance: explanation of expected vs actual differences */
  outcomeDiff?: string;
  /** User-value acceptance conclusion */
  acceptanceVerdict?: 'accepted' | 'partial' | 'rejected';
  /** Terminal outcome classification for DONE stories; omitted legacy data defaults to success. */
  outcomeKind?: StoryOutcomeKind;
  /** Real-machine verification coverage: auto-scaffolded by lattice, agent fills skipReasons only */
  realMachineCoverage: {
    /** Cases that were actually run (auto-populated from test-evidence.json + evidence per fixture) */
    ran: Array<{ name: string; where: string }>;
    /** Cases flagged as real-machine (sandbox:false) but NOT run; agent supplies reason per case */
    skipped: Array<{ name: string; where: string; reason: string }>;
  };
  /** Known limitations / design deviations: scenarios not covered by tests, differences between intent and implementation */
  limitations: string;
  /** Pitfall log: where you got stuck doing this story, how many detours, what the next person should know. Required field, cannot be empty */
  pitfalls: string;
  /**
   * Entry count per phase + cumulative duration (auto-computed by summary_set from story.events).
   * count = number of advance events entering this phase (re-entries after rollback count multiple times);
   * durationMs = milliseconds spent in this phase (from entering until advancing away to the next,
   * counted up to now if the current phase has not been left yet).
   */
  phaseStats?: Record<string, { count: number; durationMs: number }>;
  /** Total duration of the whole story (startedAt→endedAt, or createdAt→now fallback), in milliseconds */
  totalDurationMs?: number;
  /**
   * Fixture execution stats (aggregated by summary_set from test-runs.json).
   * totalRuns = number of validate invocations;
   * totalCases = totalCases of the most recent run (snapshot of fixture case count bound to current story);
   * cumulativeCasesRun = sum of totalCases across all runs (cumulative execution count);
   * cumulativePassedCases = sum of passedCases across all runs.
   */
  fixtureStats?: {
    totalRuns: number;
    totalCases: number;
    cumulativeCasesRun: number;
    cumulativePassedCases: number;
  };
  /** Bug stats (aggregated by summary_set from bug.json). */
  bugStats?: {
    found: number;
    fixed: number;
    open: number;
  };
  /** ISO 8601 write time */
  createdAt: string;
  /** ISO 8601 last update time */
  updatedAt: string;
}

export function isStoryOutcomeKind(outcomeKind: unknown): outcomeKind is StoryOutcomeKind {
  return typeof outcomeKind === 'string' && STORY_OUTCOME_KINDS.includes(outcomeKind as StoryOutcomeKind);
}

export function normalizeStoryOutcomeKind(outcomeKind: unknown): StoryOutcomeKind {
  return isStoryOutcomeKind(outcomeKind) ? outcomeKind : 'success';
}

export function formatStoryOutcomeKind(outcomeKind: StoryOutcomeKind): string {
  return outcomeKind === 'audit_only' ? 'audit-only' : outcomeKind;
}

/**
 * B-1522: Append-only log of every validate invocation for a story.
 * test-evidence.json is overwrite-only and loses run history; this file
 * preserves the sequence so summary_set can compute cumulative stats.
 * Stored at `docs/story/actives/<storyId>/test-runs.json`.
 */
export interface StoryTestRun {
  timestamp: string;
  command: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  durationMs: number;
  result: 'PASS' | 'FAIL';
}

export interface StoryTestRunsData {
  runs: StoryTestRun[];
}

/**
 * B-3fad CHK-001: Finding evidence status axis. Orthogonal to status (open/resolved/dismissed).
 * - suspected: only a suspicion, not reproduced / no source evidence, cannot be presented as confirmed. REVIEW→TEST gate does not block, advisory only.
 * - verified: backed by structured evidence (default value for reviewer finding_add in REVIEW phase, preserves existing gate behavior).
 * - disproven: has been refuted (with disprovenEvidence refutation summary + command + source reference), does not block gate.
 * Legacy findings missing this field are treated as verified by the gate (no regression).
 */
export type FindingEvidenceState = 'suspected' | 'verified' | 'disproven';

/**
 * B-3fad CHK-001: Refutation evidence for disproven findings.
 * Required when evidenceState=disproven; stores counter-evidence summary + reproduction command + source code reference.
 */
export interface DisprovenEvidence {
  /** Counter-evidence conclusion summary: why this finding does not hold */
  summary: string;
  /** Source code / documentation location referenced by the counter-evidence (e.g., src/foo.ts:42) */
  sourceRefs?: string[];
  /** Reproduction / verification command used for counter-evidence */
  reproCommand?: string;
}

/** Finding: a finding raised by a lattice reviewer (replaces testIntent) */
export interface Finding {
  id: string;            // format B-xxx:F-001
  desc: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'happy' | 'edge' | 'adversarial' | 'missing';
  status: 'open' | 'resolved' | 'dismissed';
  /**
   * B-3fad CHK-001: evidence state axis (orthogonal to status). When missing, gate treats as verified (legacy compatibility).
   */
  evidenceState?: FindingEvidenceState;
  /**
   * B-3fad CHK-001: required when evidenceState=suspected, explains why it is only suspected (not reproduced / lacks source code evidence).
   * Prevents using suspected as a button to bypass the gate.
   */
  uncertaintyReason?: string;
  /**
   * B-3fad CHK-001: required when evidenceState=disproven, counter-evidence summary + command + source code reference.
   */
  disprovenEvidence?: DisprovenEvidence;
  agent?: string;
  createdAt?: string;
  _hash?: string;
  reviewRound?: string;
  /** Signed reviewer-run binding for current REVIEW evidence. */
  reviewRunId?: string;
  dismissReason?: string;
  dismissedAt?: string;
  /** B-e8c8 / B-9d95 CHK-005: associated file paths (used for cluster files-overlap determination + fallback extraction from desc) */
  files?: string[];
  /** B-e8c8: current cluster ID this belongs to (CL-xxx); undefined if not clustered */
  clusterId?: string;
  /** B-e8c8 CHK-010: audit field for auto-resolution via commit `Resolves: CL-xxx` (format "CL-xxx@<sha7>") */
  resolvedBy?: string;
  /**
   * B-9bd9 CHK-002: dedicated field for meta-story audit findings (non-audit findings can leave empty, old findings treated as legacy).
   * driftHash = first 10 chars of sha1(sectionPath + symbol + driftType), stable across processes, idempotent deduplication.
   * lastSeenAt = refreshed each audit round if the drift still exists (ISO 8601).
   * firstSeenRound = the round number when the drift was first discovered (1-based, monotonically increasing).
   */
  driftHash?: string;
  lastSeenAt?: string;
  firstSeenRound?: number;
  /**
   * B-f60c CHK-003: gap_log idempotency fingerprint. Stable sha256 over the
   * normalized gap description + category + severity + structured evidence
   * source. Two gap_log calls with the same fingerprint dedupe into one
   * canonical B-META finding (inside the main write lock); genuinely different
   * gaps get different fingerprints and are never merged. Absent on non-gap
   * findings (audit drift / reviewer findings).
   */
  gapFingerprint?: string;
  /** leave an evidence chain on auto-resolve, distinct from regular finding_resolve */
  resolvedReason?: string;
  resolvedAt?: string;
  /**
   * B-4f46 CHK-001 (Experience Layer Phase 1b): coarse signature tag grouping a
   * finding into a recurring pattern family.
   * audit-only — MUST NOT be read by any gate; excluded from the finding signature.
   */
  signatureTag?: string;
  /**
   * B-5d48 CHK-002 (Experience Layer ③.2): provenance of `signatureTag` —
   * `'confirmed'` when a reviewer/LLM supplied it, `'auto'` when it is a
   * mechanical fallback candidate (deriveSignatureCandidate).
   * audit-only — MUST NOT be read by any gate; excluded from the finding signature.
   */
  signatureTagSource?: SignatureTagSource;
  /**
   * B-4f46 CHK-001: how this finding was resolved.
   * audit-only — MUST NOT be read by any gate; excluded from the finding signature.
   */
  resolutionType?: 'fixed' | 'duplicate' | 'superseded' | 'accepted_risk' | 'partially_mitigated';
  /**
   * B-4f46 CHK-001: why this finding was dismissed.
   * audit-only — MUST NOT be read by any gate; excluded from the finding signature.
   */
  dismissReasonType?: 'false_positive' | 'out_of_scope' | 'duplicate' | 'wontfix' | 'unclear' | 'already_covered';
  /**
   * B-4f46 CHK-001: confidence strength of the resolve evidence.
   * audit-only — MUST NOT be read by any gate; excluded from the finding signature.
   */
  resolveEvidenceStrength?: 'strong' | 'medium' | 'weak';
  /**
   * B-4f46 CHK-001: confidence strength of the dismiss evidence.
   * audit-only — MUST NOT be read by any gate; excluded from the finding signature.
   */
  dismissEvidenceStrength?: 'strong' | 'medium' | 'weak';
}

export interface FindingData {
  findings: Finding[];
}

/** Reviewer pass receipt: reviewer explicitly checked a round and found no blocker. */
export interface ReviewPass {
  id: string;
  agent: string;
  note: string;
  createdAt: string;
  reviewRound?: string;
  /** Signed reviewer-run binding for current REVIEW evidence. */
  reviewRunId?: string;
  _hash?: string;
}

export interface ReviewPassData {
  passes: ReviewPass[];
}

/** Signed reviewer run receipt created before REVIEW findings/review-pass evidence. */
export interface ReviewRun {
  reviewRunId: string;
  storyId: string;
  agent: string;
  lane: string;
  reviewRound: string;
  startedAt: string;
  headHash: string;
  materialHash: string;
  storyFilesHash?: string;
  promptHash: string;
  /**
   * B-6bfd CHK-005: scope/diff/hunk binding for scope-protected stories. Present
   * only when the story has a scope contract at review_run_start time; absent for
   * legacy / unprotected stories (backward compatible). When present, its
   * bindingHash is folded into the run signature (signReviewRun) so it cannot be
   * tampered, and the REVIEW→TEST gate rejects evidence whose binding is missing,
   * tampered, or stale relative to the live scope contract / diff pack.
   */
  scopeBinding?: ReviewScopeBinding;
  /**
   * B-b750: signed workspace interpretation used to capture headHash,
   * materialHash, and optional scopeBinding. This allows metadataRoot and the
   * git-backed signed workspace root to differ without losing the mechanical
   * root binding that later REVIEW consumers verify.
   */
  workspaceBinding?: ReviewRunWorkspaceBinding;
  _hash?: string;
}

export interface ReviewRunData {
  runs: ReviewRun[];
}

/** Evaluator scoring evidence (consumed by browser project DONE gate) */
export interface EvalEvidenceData {
  scores: { functionality: number; usability: number };
  total: number;
  pass: boolean;
  itemResults: Array<{ itemId: string; pass: boolean; note: string }>;
  findings: string[];
  timestamp: string;
}

export type TestResult = 'PASS' | 'FAIL';

export interface TestEvidenceData {
  /** command of the last test run */
  command: string;
  /** output of the last test run */
  output: string;
  /** PASS / FAIL */
  result: TestResult;
  /** timestamp */
  timestamp: string;
  /** runtime environment */
  environment?: {
    node: string;
    os: string;
  };
  /** list of function names covered by the browser trace */
  traceCoverage?: string[];
  /** git HEAD hash at test time (used by DONE gate evidence freshness check) */
  headHash?: string;
  /** non-Proofbound metadata file tree hash at test time (metadata-only commits should not make evidence stale) */
  materialHash?: string;
  /** Hash of story-owned material files vs merge-base main captured at test time. */
  storyFilesHash?: string;
  /** @deprecated Legacy evidence freshness field. New writes use headHash. */
  git?: {
    head: string | null;
    branch?: string | null;
  };
  /** Story-level verification intent coverage captured during validate/story_advance. */
  verificationCoverage?: VerificationCoverageReport;
}

export interface VerificationCoverageEntry {
  intentRef: string;
  itemId: string;
  lane: VerificationLane;
  desc: string;
  type: VerificationIntentType;
  priority: VerificationPriority;
  status: 'covered' | 'missing' | 'failed' | 'waived' | 'deferred' | 'stale' | 'weak';
  evidence?: VerificationEvidence;
}

export interface VerificationCoverageReport {
  total: number;
  required: number;
  covered: number;
  missingRequired: number;
  entries: VerificationCoverageEntry[];
  /** Present when evidenceQualityProfile is balanced or strict and weak evidence was found */
  qualityIssues?: import('./evidence-quality.js').EvidenceQualityIssue[];
  /** Present when attestation issues were found on covered evidence */
  attestationIssues?: import('./attestation.js').AttestationIssue[];
  /** Present when actor trust issues were found on covered/weak evidence */
  actorTrustIssues?: import('./actor-trust.js').ActorTrustIssue[];
  /** Present when fact provenance issues were found on covered/weak evidence */
  factProvenanceIssues?: import('./fact-provenance.js').FactProvenanceIssue[];
}

/**
 * RALPLAN-DR structured decision.
 * The PLAN stage should produce a decision.json for each non-trivial story,
 * containing principles/drivers/options/choice/pre-mortem.
 * First-version soft introduction: story_review enforces it when priority=high or riskSignals is non-empty.
 */
export interface DecisionOption {
  name: string;
  pros: string[];
  cons: string[];
}

export interface PreMortemScenario {
  scenario: string;
  trigger: string;
  consequence: string;
  mitigation: string;
}

export interface DecisionData {
  /** 3-5 design principles */
  principles: string[];
  /** top 3 key constraints */
  drivers: string[];
  /** ≥ 2 alternatives (or an explicit invalidation rationale explaining why only one remains) */
  options: DecisionOption[];
  /** chosen option name */
  chosen: string;
  /** rationale for the choice (echoing drivers) */
  rationale: string;
  /** pre-mortem failure scenarios (high-risk stories require ≥ 3) */
  preMortem?: PreMortemScenario[];
  /** timestamp */
  timestamp: string;
}

export type DecisionDocProposalStatus = 'proposed' | 'saved' | 'superseded' | 'rejected';
export type DecisionDocProposalSourceDecision = 'decision.json' | 'manual';

export interface DecisionDocProposalAlternative {
  name: string;
  pros: string[];
  cons: string[];
}

export interface DecisionDocProposalSavedRecord {
  savedAt: string;
  savedCommit: string;
  targetPath: string;
  sourceDecisionDigest?: string;
  proposalDigest: string;
  renderedDocDigest: string;
  headHash: string;
  materialHash: string;
  mode: 'create' | 'update';
}

export interface DecisionDocProposal {
  id: string;
  slug: string;
  targetPath: string;
  title: string;
  status: DecisionDocProposalStatus;
  sourceDecision: DecisionDocProposalSourceDecision;
  sourceDecisionDigest?: string;
  decision: string;
  context: string;
  scope: string;
  nonGoals: string[];
  chosenApproach: string;
  alternatives: DecisionDocProposalAlternative[];
  operationalRules: string[];
  verificationRequirements: string[];
  risks: string[];
  createdAt: string;
  updatedAt: string;
  proposalDigest: string;
  savedAt?: string;
  savedCommit?: string;
  saves?: DecisionDocProposalSavedRecord[];
}

export interface DecisionDocProposalFile {
  schemaVersion: 'lattice.decision_doc_proposals.v1';
  storyId: string;
  updatedAt: string;
  proposals: DecisionDocProposal[];
}

/**
 * Pre-context Intake snapshot.
 * Before breaking down the checklist in the PLAN phase, the main agent should first record a structured understanding of the task.
 * First-version soft introduction: when not filled, only a hint reminder is shown, without blocking progress.
 */
export interface UnderstandingData {
  /** one-sentence description of the problem to solve */
  task: string;
  /** what observable change will occur after completion */
  outcome: string;
  /** known facts (from the source of truth, existing code, context) */
  facts: string[];
  /** constraints (rules that must be followed, performance/compatibility requirements) */
  constraints: string[];
  /** unknowns (questions not yet figured out when breaking down the checklist) */
  unknowns: string[];
  /** Possible code touchpoints (impact scope) */
  touchpoints: string[];
  /** Timestamp */
  timestamp: string;
}

// ── Grill Planning Artifact ──

export type GrillSessionStatus = 'open' | 'closed';
export type GrillQuestionStatus = 'answered' | 'unresolved';

export interface GrillQuestion {
  id: string;
  question: string;
  answer?: string;
  status: GrillQuestionStatus;
  recordedAt: string;
  resolvedAt?: string;
  source?: string;
}

export interface GrillSession {
  sessionId: string;
  topic?: string;
  status: GrillSessionStatus;
  startedAt: string;
  closedAt?: string;
  closedBy?: string;
  closeNote?: string;
  questions: GrillQuestion[];
}

export interface GrillData {
  storyId: string;
  updatedAt: string;
  sessions: GrillSession[];
}

// ── Workflow Profile ──

export type WorkflowProfile = 'light' | 'balanced' | 'strict';

export type WorkflowPolicy = {
  profile: WorkflowProfile;
  quickPath: {
    enabled: boolean;
    maxChecklistItems: number;
    allowRiskSignals: boolean;
  };
  plan: {
    requireUnderstanding: 'always' | 'high_risk' | 'never';
    requireDecision: 'always' | 'high_risk' | 'never';
    requirePlanMd: 'always' | 'normal' | 'never';
    requireStoryReview: boolean;
  };
  subagents: {
    requireWorkerInNormalChannel: boolean;
    allowMainAgentCoding: boolean;
  };
  review: {
    requireReviewer: boolean;
    requireReviewerFinding: boolean;
    blockingSeverities: Array<'critical' | 'high' | 'medium'>;
    requireLightReview: boolean;
  };
  test: {
    requireValidatePass: boolean;
    requireAllBugsFixed: boolean;
    requireEvaluatorForBrowser: boolean;
  };
  done: {
    requireSummary: 'full' | 'minimal' | 'none';
    requireBranchSynced: boolean;
    requireCleanGit: boolean;
  };
};

// ── Process Metrics (B-abd8: Phase 2 telemetry) ──

export type MetricConfidence = 'high' | 'medium' | 'low' | 'unknown';

export interface ProcessMetricValue {
  value: number | boolean | string | null;
  unit?: 'count' | 'ratio' | 'ms' | 'hours' | 'bool' | 'text';
  confidence: MetricConfidence;
  sources: string[];
  note?: string;
}

export interface ProcessDimensionMetrics {
  effective: ProcessMetricValue;
  metrics: Record<string, ProcessMetricValue>;
  gaps?: string[];
}

export interface StoryProcessMetrics {
  storyId: string;
  generatedAt: string;
  sourceSnapshot: {
    hasUnderstanding: boolean;
    hasDecision: boolean;
    hasPlan: boolean;
    checklistItems: number;
    reviewRounds: number;
    findings: number;
    bugs: number;
    testRuns: number;
    hasEvalEvidence: boolean;
    hasSummary: boolean;
  };
  dimensions: {
    tdd: ProcessDimensionMetrics;
    requirementCompleteness: ProcessDimensionMetrics;
    debugging: ProcessDimensionMetrics;
    planning: ProcessDimensionMetrics;
    subagentCollaboration: ProcessDimensionMetrics;
    reviewDiscipline: ProcessDimensionMetrics;
  };
  overallGaps: string[];
}

// ── Process Events (B-aa48: Phase 3 telemetry) ──

export type ProcessEventType =
  | 'plan_reviewed'
  | 'bug_reopened'
  | 'dispatch'
  | 'subagent_result'
  | 'light_review'
  | 'plan_updated'
  | 'codex_cli'
  | 'codex_adapter_verification'
  | 'reviewer_finding'
  | 'review_pass'
  | 'dirty_gate_audit'
  | 'init_check_fallback'
  | 'capsule_updated'
  | 'handoff_written'
  | 'run_added'
  | 'run_metrics_recorded'
  | 'autopilot_projection'
  | 'autopilot_execution'
  | 'planner_story_created'
  | 'planner_job_created'
  | 'host_verdict'
  | 'review_escalation_policy'
  | 'review_escalation_fallback'
  | 'legacy_authority_receipt'
  | 'decision_doc_proposal'
  | 'decision_doc_save'
  | 'auxiliary_worktree_cleanup'
  // B-6bfd CHK-004: Proofbound-managed guard session projection lifecycle events.
  | 'guard_session_start'
  | 'guard_session_check';

export type ProcessEvent = {
  type: ProcessEventType;
  timestamp: string;
  [key: string]: unknown;
};

// ── Scope Check (B-d4d1: signed scope-check.json written by lattice-review-scope-plan agent) ──
// B-ed3e CHK-002: schema extended to 5 states + source field (backward compatible, missing fields in old data default to undefined / 0).
// Signing domain (signScopeCheck parameters) unchanged: still only contains storyId / timestamp / gaps / covered / reviewRound,
// newly added source / orphanSuspect / drift / openQuestions do not enter _hash (see decision preMortem 1).

export interface ScopeCheckFeature {
  feature: string;
  covered_by: string | null;
  /**
   * B-ed3e: 5 states. Old scope-check.json only contains covered/excluded/gap three states, backward compatible.
   * - orphan-suspect: reviewer scanned spec promise in the entire decisions/ directory, but checklist did not cover it and did not exclude it
   * - drift: spec deviates from implementation; **always empty set in PLAN phase**, reserved for S3 (diff input + phase flow refactor)
   */
  status: 'covered' | 'excluded' | 'gap' | 'orphan-suspect' | 'drift';
  excluded_by: string | null;
  /**
   * B-ed3e: annotates the source of this feature, for reviewer traceability. Agreed values:
   * - 'description'            (from story description)
   * - 'decisions:<path>'       (from full decisions/ directory scan, e.g. `decisions:docs/requirements/decisions/api.md`)
   * - 'relatedDocs:<path>'     (from checklist.relatedDocs, legacy compatibility)
   * Type remains string without literal union, for future extension. This field missing in old data → undefined.
   */
  source?: string;
}

export interface ScopeCheckData {
  storyId: string;
  checkedAt: string;
  features: ScopeCheckFeature[];
  /**
   * B-ed3e: summary extended with orphanSuspect / drift counts.
   * Old data uses ?? 0 fallback when readScopeCheck is called, ensuring PLAN gate does not crash.
   * drift is always 0 in the PLAN phase (S3 will add diff input).
   */
  summary: {
    total: number;
    covered: number;
    excluded: number;
    gaps: number;
    orphanSuspect: number;
    drift: number;
  };
  /**
   * B-ed3e CHK-003: 6th channel Open Questions. Reviewer writes here when scanning the full decisions/ directory and finding
   * contradictions/questions that are "seen but not classified". Main agent must use `lattice scope_question_resolve`
   * to resolve them in writing (prevents self-absolution); the PLAN gate blocks unresolved OQs.
   * Signature domain excludes this field (resolution is a main agent action, not part of reviewer signature _hash).
   */
  openQuestions?: OpenQuestion[];
  reviewRound?: string;
  _hash: string;
}

// ── Init Check (B-e71f: signed init-check.json written by lattice-review-story-init agent) ──
// INIT → INIT_CHECK hard gate artifact. Written by reviewer subagent after reviewing background.md + initial checklist,
// `_hash` covers storyId / sha256(background.md) / title / description / sha256(initial checklist) / reviewRound + INIT_CHECK_SALT.
// After main agent modifies background / title / description / initial checklist, _hash mismatches → story_advance INIT_CHECK
// reports init_check_tampered blocker (CHK-005 / CHK-006).
// agentId field is reviewer's self-reported id, **for audit traceability only** (EXP-001 disproved mechanical verifiability of agentId, see
// docs/story/actives/B-e71f/experiments/exp-001.md), not involved in signing nor gate decisions.
// issues are advisory: critical / high do not block INIT_CHECK advancement, relying on reviewer template self-discipline to refuse calling the CLI as fallback
// (on critical, reviewer should print issue list to stdout for main agent to fix background then restart reviewer,
// without calling init_check_set).

export interface InitCheckIssue {
  /**
   * Reviewer-assigned id, e.g. "I-1" / "I-2".
   * Aligned with cli-engine.ts init_check_set Zod schema (`id: z.string().optional()`):
   * reviewer may omit it; when omitted JSON.stringify drops the field (no empty string written), consumers need narrowing.
   */
  id?: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** Concrete description (runtime validation trim().length >= 1, blank strings forbidden) */
  desc: string;
}

/**
 * B-9975 CHK-002: Draft check data (parallel to InitCheckData but for drafts).
 * Written by draft_check_set, consumed by draft_issue_resolve.
 */
export interface DraftCheckData {
  draftName: string;
  checkedAt: string;
  reviewRound: string;
  agentId: string;
  issues: InitCheckIssue[];
  resolutions?: Record<string, string>;
  _hash: string;
}

/**
 * B-e71f F-013: the original `InitCheckResolution` interface has been deleted (declared but unreferenced, and
 * the decision is locked on the Concat-Advisory channel — after the main agent edits background, rerunning the reviewer triggers
 * automatic re-review on _hash mismatch, and no standalone `init_issue_resolve` CLI is introduced). If a manual resolution
 * channel is needed in the future, create a dedicated type instead of resurrecting this dead one.
 */
export interface InitCheckData {
  storyId: string;
  /** ISO 8601 write timestamp */
  checkedAt: string;
  /**
   * Snapshot of story.currentReviewRound at write time (empty string during INIT phase).
   * Follows the ScopeCheckData / scope-check.ts:14 pattern; this field is part of the signature domain.
   */
  reviewRound: string;
  /**
   * Reviewer's self-reported agent id (subagent session id or human-assigned identifier).
   * **Not part of the signature / not part of gate validation**, only an audit trace field (EXP-001 has disproved the mechanical distinguishability of agentId).
   */
  agentId: string;
  /**
   * List of issues raised by the reviewer, advisory mode: does not block INIT_CHECK advancement, only echoed in the advance success message.
   * Empty array allowed (when the reviewer considers it fully qualified).
   */
  issues: InitCheckIssue[];
  /**
   * Per-reviewer records. New writes upsert by agentId so separate init reviewers
   * cannot silently overwrite each other. Legacy init-check.json files without
   * this field are interpreted as one record from `agentId`.
   */
  agentResults?: Array<{
    agentId: string;
    checkedAt: string;
    issues: InitCheckIssue[];
  }>;
  /**
   * B-95d8 CHK-001: manual fallback / repair attestation.
   *
   * Present ONLY when init-check.json was produced by the explicit
   * `init_check_repair` command (environments that cannot spawn the init
   * reviewer subagent), NOT by an independent reviewer run via `init_check_set`.
   * An audit/surface field, **not part of the signature / not part of gate validation** — signature is still produced by signInitCheck
   * Computed from background/title/description/checklist; gate is still validated by missingRequiredInitCheckAgents
   * + blockingInitCheckIssues (fallback passes by marking agentResults as `<required>@fallback`
   * to satisfy the required reviewer check, rather than relaxing the gate). story_get / dashboard use this field to distinguish fallback/manual
   * attestation from independent reviewers.
   */
  fallback?: {
    /** repair (fix missing exit) / fallback (one-time substitute in environments without subagent). Semantically equivalent, only used for audit classification. */
    mode: 'repair' | 'fallback';
    /** Manual attestation reason (runtime validation trim().length >= 30). */
    reason: string;
    /** Optional: evidence references the manual verification is based on (file/URL/transcript summary, etc.). */
    evidenceRefs?: string[];
    /** Operator identifier (git user.name or explicitly passed in), audit traceability only. */
    actor?: string;
    /** Session identifier (LATTICE_SESSION_ID / derived session id), audit traceability only. */
    session?: string;
    /** ISO 8601 attestation timestamp. */
    attestedAt: string;
    /** git HEAD at write time (short/full sha), pinning the attestation to the source state at that moment. */
    headHash?: string;
    /** material hash at write time (source freshness), same convention as verificationEvidence. */
    materialHash?: string;
  };
  /**
   * Signature: sha256(`${storyId}:${backgroundHash}:${title}:${description}:${checklistHash}:${reviewRound}:${INIT_CHECK_SALT}`)
   * Computed by signInitCheck. issues / agentId / fallback are not included in the signature domain (issues are reviewer subjective judgment, allowed to be modified later;
   * agentId is self-reported by reviewer and easily forged, backed by reviewer template fence; fallback is surface/audit metadata).
   */
  _hash: string;
}

// ── Scope Anti-Expansion (B-85ba: INIT→INIT_CHECK boundary freeze gate) ──

export type ScopeBoundaryMode = 'correctness_fix' | 'feature' | 'maintenance' | 'custom';

export interface ScopeBoundaryData {
  schemaVersion: 'lattice.scope_boundary.v1';
  storyId: string;
  mode: ScopeBoundaryMode;
  /** User-confirmed in-scope semantic directions, normalized and deduplicated by the core evaluator. */
  allowed: string[];
  /** User-confirmed out-of-scope semantic directions, normalized and deduplicated by the core evaluator. */
  excluded: string[];
  confirmedBy?: string;
  confirmationNote?: string;
  createdAt: string;
  updatedAt: string;
  /** Stable sha256 over schemaVersion/storyId/mode/allowed/excluded/confirmationNote. */
  _hash: string;
}

export interface ExecutionBoundaryData {
  schemaVersion: 'lattice.execution_boundary.v1';
  storyId: string;
  /** Commands/tool invocations explicitly allowed for this story's INIT_CHECK/DEV execution envelope. */
  allowedCommands: string[];
  allowedTools: string[];
  /** Optional path envelope used by the INIT command surface; kept separate from tool names. */
  allowedPaths?: string[];
  /** Commands/tool invocations explicitly excluded from this story's execution envelope. */
  excludedCommands: string[];
  excludedTools: string[];
  /** Optional path exclusions used by the INIT command surface; kept separate from tool names. */
  excludedPaths?: string[];
  confirmedBy?: string;
  confirmationNote?: string;
  createdAt: string;
  updatedAt: string;
  /** Stable sha256 over schemaVersion/storyId and normalized execution boundary arrays. */
  _hash: string;
}

export interface ScopeFreezeTextSource {
  source: 'story.title' | 'story.description' | 'story.background' | 'checklist.title' | 'checklist.context' | 'checklist.excludes' | 'scopeBoundary.allowed' | 'scopeBoundary.excluded';
  text: string;
  itemId?: string;
  /** True when the source is an explicit exclusion channel rather than an in-scope promise. */
  excluded?: boolean;
}

export interface ScopeFreezeKeywordHit {
  keyword: string;
  source: ScopeFreezeTextSource['source'];
  text: string;
  itemId?: string;
  excluded: boolean;
}

export interface ScopeFreezeDiscardOverlap {
  digest: string;
  overlapTerms: string[];
  overlapRatio: number;
  previousStoryId?: string;
  previousReason?: string;
  previousDiscardedAt?: string;
  mitigation?: string;
}

export type ScopeFreezeIssueCode =
  | 'missing_scope_boundary'
  | 'missing_execution_boundary'
  | 'future_capability_keyword'
  | 'repeat_discard_without_mitigation';

export interface ScopeFreezeIssue {
  code: ScopeFreezeIssueCode;
  severity: 'hard' | 'warning';
  message: string;
  keyword?: string;
  source?: ScopeFreezeTextSource['source'];
  itemId?: string;
  digest?: string;
  overlapTerms?: string[];
}

export interface ScopeFreezeCheckData {
  schemaVersion: 'lattice.scope_freeze_check.v1';
  storyId: string;
  checkedAt: string;
  mode: ScopeBoundaryMode;
  status: 'pass' | 'fail';
  scopeBoundaryHash?: string;
  executionBoundaryHash?: string;
  /** Hash over bounded story/checklist projection plus boundary hashes; changes when handlers should rerun the check. */
  freshnessHash: string;
  effectiveExcludedKeywords: string[];
  keywordHits: ScopeFreezeKeywordHit[];
  repeatDiscardOverlaps: ScopeFreezeDiscardOverlap[];
  issues: ScopeFreezeIssue[];
  /** Stable sha256 over the check result fields above. */
  _hash: string;
}

export type ScopeExtensionDecisionValue = 'approved' | 'accepted' | 'rejected';
export type ScopeExtensionProposalStatus = 'pending' | ScopeExtensionDecisionValue | 'withdrawn';

export interface ScopeExtensionPatch {
  allowed?: string[];
  excluded?: string[];
  executionAllowedCommands?: string[];
  executionAllowedTools?: string[];
  executionExcludedCommands?: string[];
  executionExcludedTools?: string[];
}

export interface ScopeExtensionDecision {
  decision: ScopeExtensionDecisionValue;
  decidedBy: string;
  decidedAt: string;
  rationale: string;
  /** Stable sha256 over proposalId/decision/decidedBy/decidedAt/rationale. */
  _hash: string;
}

export interface ScopeExtensionProposal {
  /** Compatibility alias for older handler surfaces; proposalId is canonical. */
  id?: string;
  proposalId: string;
  storyId: string;
  proposedBy: string;
  proposedAt: string;
  /** Human-readable reviewer expansion proposal; does not change scope until accepted. */
  proposal?: string;
  proposalTextHash?: string;
  reason: string;
  patch: ScopeExtensionPatch;
  reviewerRunId?: string;
  findingId?: string;
  evidenceRefs?: string[];
  rejectedDirectionCount?: number;
  status: ScopeExtensionProposalStatus;
  decidedAt?: string;
  decision?: ScopeExtensionDecision;
  /** Stable sha256 over proposal identity, reason, patch, reviewerRunId, status, and decision hash. */
  _hash: string;
}

export interface ScopeExtensionProposalData {
  storyId: string;
  updatedAt: string;
  proposals: ScopeExtensionProposal[];
}

export interface ScopeExtensionDecisionRecord {
  id: string;
  storyId: string;
  proposalId: string;
  proposalTextHash?: string | null;
  decision: 'accepted' | 'rejected';
  reason: string;
  decider: string;
  invalidatesFreezeCheckHash?: string | null;
  priorFreezeCheckStatus?: string | null;
  createdAt: string;
  actor?: string;
  _hash: string;
}

export interface ScopeExtensionDecisionData {
  storyId: string;
  updatedAt: string;
  decisions: ScopeExtensionDecisionRecord[];
  _hash?: string;
}

export interface ScopeDiscardDigestEntry {
  digest: string;
  /** Normalized semantic terms for overlap checks; no raw transcript is required. */
  terms: string[];
  reason: string;
  discardedAt: string;
  storyId?: string;
  mitigation?: string;
}

export interface ScopeDiscardDigestData {
  storyId: string;
  updatedAt: string;
  entries: ScopeDiscardDigestEntry[];
}

// ── Delivery Check (B-35ed: TEST→DONE hard gate) ──

export interface DocsPromise {
  docPath: string;
  promise: string;
  /**
   * Optional reviewer-friendly status. DONE gate treats met/verified as
   * verified and waived as an explicit waiver, matching delivery_check_set help.
   */
  status?: 'met' | 'verified' | 'waived' | 'unverified';
  verifiedBy?: string;
  evidence?: string;
  /** Waiver reason (≥ 30 characters), included in signature to prevent post-hoc tampering */
  waiverReason?: string;
}

export interface RealMachineTest {
  featureId: string;
  transcript: string;
  /** Waiver reason (≥ 30 characters, included in _hash to prevent post-hoc tampering); required when no real machine test exists */
  waiverReason?: string;
}

export interface ClosingSelfCheck {
  hasRealMachineTest: boolean;
  hasEdgeCaseCoverage: boolean;
  hasUnresolvedTodos: boolean;
  summary: string;
}

export interface DeliveryCheckData {
  storyId: string;
  /** ISO 8601 write timestamp */
  checkedAt: string;
  /** Git HEAD at delivery review time, retained for audit/debug only. */
  headHash?: string;
  /** Material tree hash reviewed by lattice-review-delivery; signed and required for freshness. */
  materialHash?: string;
  /**
   * Story-owned file hash (storyFilesHash secondary-freshness signal). Signed.
   * When the whole-tree materialHash drifts (e.g. an unrelated main merge) but
   * this matches the current story-owned file state, the DONE delivery-check
   * gate downgrades to a mandatory re-attestation advisory instead of rejecting
   * as stale. A story-owned change still mismatches and hard-rejects; a missing
   * value falls back to strict materialHash. Because it is folded into _hash,
   * a forged storyFilesHash breaks the signature (delivery_check_tampered).
   */
  storyFilesHash?: string;
  /** Snapshot of story.currentReviewRound at write time */
  reviewRound: string;
  /** Reviewer self-reported agent id, for audit traceability only (not part of signature) */
  agentId: string;
  docsPromises: DocsPromise[];
  realMachineTests: RealMachineTest[];
  closingSelfCheck: ClosingSelfCheck;
  /**
   * Signature for new writes:
   * sha256(storyId:JSON(docsPromises):JSON(realMachineTests):JSON(closingSelfCheck):reviewRound:materialHash:storyFilesHash:salt)
   * materialHash and storyFilesHash are appended only when present, so legacy
   * records without them recompute byte-identically; DONE gates reject a missing
   * materialHash as stale.
   */
  _hash: string;
}

/**
 * B-cf60: Per-story declared product artifact.
 *
 * Records a generated artifact path explicitly declared by a story, so the dirty-worktree classifier categorizes it as
 * `declared_artifact_changes` instead of `unexpected_dirty_files`,
 * and requires the DONE gate to verify the path has a matching verificationEvidence intentRef
 * or delivery-check.docsPromises[*].docPath.
 */
export interface DeclaredArtifactEntry {
  /** Exact path relative to repo root (no glob/wildcards; validated by handler) */
  path: string;
  /** Why this file is declared as an expected output of this story (≥10 characters) */
  reason: string;
  /**
   * Related references:
   * - `CHK-NNN:(happy|edge|adversarial):IDX` form → points to checklist.items[*].verificationIntent
   * - `promise:<docPath>` form → points to delivery-check.docsPromises[*].docPath
   */
  relatedIntent: string;
  /** Declared write timestamp (ISO) */
  declaredAt: string;
}

export interface DeclaredArtifactsData {
  entries: DeclaredArtifactEntry[];
}

/**
 * B-ed3e CHK-003: Open Question entry.
 * - id: e.g. "OQ-1" / "OQ-2" (reviewer assigns itself)
 * - q: question text
 * - evidence: reviewer's observed evidence (which section of which decisions/ file mentions what)
 * - sourcePointers: decisions/ path or checklist item id that the evidence points to
 * - resolution: resolution conclusion written by the main agent via scope_question_resolve (≥ 20 characters)
 * - resolvedAt: timestamp when resolution was written (ISO)
 */
export interface OpenQuestion {
  id: string;
  q: string;
  evidence: string;
  sourcePointers: string[];
  resolution?: string;
  resolvedAt?: string;
}

/** Total order: light=0 < balanced=1 < strict=2 */
export const PROFILE_ORDER: Record<WorkflowProfile, number> = {
  light: 0,
  balanced: 1,
  strict: 2,
};

// ── Scope Contract (B-be27: story-scoped allowed-file contract + post-diff gate) ──

export type ScopeContractMode = 'local' | 'shadow' | 'enforce';

export interface ScopeContractAcknowledgement {
  /** Actor who acknowledged the out-of-scope change */
  actor: string;
  /** Human-readable reason (≥ 20 chars enforced at handler) */
  reason: string;
  /** ISO 8601 */
  timestamp: string;
  /** Paths explicitly added to scope with this acknowledgement */
  paths: string[];
  /** v2: SHA-256 hex of the specific hunk being acknowledged (optional) */
  hunkDigest?: string;
  /** v2: multiple hunk digests covered by one acknowledgement */
  hunkDigests?: string[];
  /** v2: anchors covered by this acknowledgement */
  anchors?: string[];
}

// ── v2 semantic scope fields (B-6bfd) ──

/** Kinds of source-level change allowed for an anchor or file */
export type ChangeKind = 'add' | 'remove' | 'modify' | 'rename';

/**
 * Per-file semantic rule. Applied on top of path-level allow/deny.
 * All anchor lists are optional; absent means unconstrained at that level.
 */
export interface FileRule {
  /** Relative file path or glob (same rules as allowedModify) */
  path: string;
  /** Only these anchors may change in this file (null/absent = all allowed) */
  allowedAnchors?: string[];
  /** These anchors must not change */
  deniedAnchors?: string[];
  /** These anchors must not change and violations block even in shadow mode */
  protectedAnchors?: string[];
  /** Restrict which change kinds are permitted for this file */
  allowedChangeKinds?: ChangeKind[];
  /** Optional verification intent refs this semantic rule exists to protect. */
  intentRefs?: string[];
}

/**
 * Story-scoped scope contract. Stored at <storyDir>/<storyId>/scope-contract.json.
 * Modes:
 *   local   — advisory only; violations never block
 *   shadow  — violations produce warnings but do not block lifecycle gates
 *   enforce — violations block REVIEW/TEST/DONE advancement
 */
export interface ScopeContractData {
  storyId: string;
  mode: ScopeContractMode;
  /** Files/globs allowed to be modified */
  allowedModify: string[];
  /** Files/globs allowed to be created */
  allowedCreate: string[];
  /** Files/globs used for tests (always allowed if they are test files) */
  allowedTest: string[];
  /** Files that must not change regardless of allowedModify */
  protectedFiles: string[];
  /** Files explicitly out of scope (violations always reported, blocked in enforce) */
  explicitExcludes: string[];
  /** Optional human explanation for a deliberate scope change */
  scopeChangeReason?: string;
  /** Explicit out-of-scope acknowledgements recorded by scope_contract_acknowledge */
  acknowledgements: ScopeContractAcknowledgement[];
  createdAt: string;
  updatedAt: string;
  /** v2: per-file semantic rules (anchor-level allow/deny/protect) */
  fileRules?: FileRule[];
  /** v2: globally protected anchor names — violations block regardless of file-level rules */
  protectedAnchors?: string[];
}

export type ScopeGateStatus = 'pass' | 'warn' | 'fail' | 'skip';

export type ScopePathCategory =
  | 'allowed_modify'
  | 'allowed_create'
  | 'allowed_test'
  | 'protected'
  | 'excluded'
  | 'lifecycle_artifact'
  | 'runtime_artifact'
  | 'unknown';

export type ScopePathSource =
  | 'scope-contract.allowedModify'
  | 'scope-contract.allowedCreate'
  | 'scope-contract.allowedTest'
  | 'scope-contract.protectedFiles'
  | 'scope-contract.explicitExcludes'
  | 'lifecycle-registry'
  | 'runtime-artifact-registry'
  | 'changed-files';

export type ScopePathRule =
  | ScopeViolation['rule']
  | 'allowed_modify'
  | 'allowed_create'
  | 'allowed_test'
  | 'lifecycle_artifact'
  | 'runtime_artifact'
  | 'unknown';

export interface ScopePathClassification {
  path: string;
  normalizedPath: string;
  category: ScopePathCategory;
  source: ScopePathSource;
  rule: ScopePathRule;
  allowed: boolean;
  detail: string;
  matchedPattern?: string;
  registryId?: string;
  hint?: string;
}

export interface ScopeCheckRow {
  /** Deterministic row id derived from category/rule/path, stable across reruns. */
  id: string;
  status: ScopeGateStatus;
  blocking: boolean;
  detail: string;
  path?: string;
  /** User-facing source path that produced this row. */
  source?: string;
  /** Classifier table or contract field that classified the source path. */
  classifierSource?: ScopePathSource;
  category?: ScopePathCategory;
  rule?: ScopePathRule;
  nextAction?: string;
  hint?: string;
}

export interface ScopeViolation {
  path: string;
  rule: 'protected' | 'excluded' | 'out_of_scope' | 'denied_anchor' | 'protected_anchor' | 'unmatched_anchor' | 'change_kind';
  acknowledged: boolean;
  anchor?: string;
  hunkDigest?: string;
}

export interface ScopeCheckResult {
  status: ScopeGateStatus;
  mode: ScopeContractMode | null;
  changedFiles: string[];
  violations: ScopeViolation[];
  warnings: ScopeViolation[];
  acknowledgedPaths: string[];
  rows?: ScopeCheckRow[];
  semantic?: SemanticScopeGateResult;
  summary: string;
}

export interface ScopeDiffHunk {
  path: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  hunkDigest: string;
  anchor?: string;
  keyPath?: string;
  parseFallback?: string;
  changeKind?: ChangeKind;
}

export interface ScopeDiffPack {
  diffPackHash: string;
  changedFiles: string[];
  hunks: ScopeDiffHunk[];
  generatedAt: string;
}

export interface SemanticScopeGateResult {
  status: ScopeGateStatus;
  violations: ScopeViolation[];
  warnings: ScopeViolation[];
  summary: string;
}

// ── Guard Session (B-6bfd CHK-004: Proofbound-managed guarded session projection) ──
//
// A guard session is a *projection* of scope protection for a Lattice-dispatched
// agent. It is NOT a competing session truth source and NOT a write-ownership
// authority — the story owner lease (core/story-owner-lease.ts) remains
// authoritative for writes. The guard session only records which provider runs
// the agent, whether that provider can pre-emptively block forbidden tool calls,
// and any forbidden writes detected against the scope contract.

/**
 * Guard capability of the session's provider:
 * - native-pretool   — Claude Code with a verified native PreToolUse hook; forbidden
 *                      writes are intercepted before they land.
 * - wrapped-preapply — Codex, Antigravity/agy, or legacy Gemini invoked via
 *                      Proofbound dispatch/pre-apply flow; the flow's pre-apply step
 *                      checks scope before writing.
 * - watcher-fallback — provider has no pre-write interception; Proofbound can only detect
 *                      forbidden writes after the fact, never pretend blocking exists.
 * - active           — legacy alias for native-pretool (kept for backwards compat).
 * - inactive         — no guard session is running (used by renderers only).
 */
export type GuardSessionMode = 'native-pretool' | 'wrapped-preapply' | 'watcher-fallback' | 'active' | 'inactive';

/** Lifecycle status of a started guard session. */
export type GuardSessionStatus = 'active' | 'violations_detected' | 'stopped';

export interface GuardSessionViolation {
  /** File path of the detected forbidden write. */
  path: string;
  /** Scope rule that was violated (protected/excluded/out_of_scope/*_anchor/...). */
  rule: string;
  /** ISO 8601 detection time. */
  detectedAt: string;
  /** Semantic anchor name when the violation is anchor-level. */
  anchor?: string;
  /** Hunk digest when the violation is hunk-level. */
  hunkDigest?: string;
  /** True when this violation was injected via guard_session_check simulatedWrites (test/dry-run). */
  simulated?: boolean;
}

export interface GuardSessionData {
  storyId: string;
  /** Provider runtime running the guarded agent (e.g. claude-code, codex). */
  provider: string;
  /** Whether the provider can pre-tool block (active) or only watch (watcher-fallback). */
  guardMode: GuardSessionMode;
  /** Lifecycle status; derived from the latest guard_session_check. */
  status: GuardSessionStatus;
  /** Hash of the scope contract this guard session is bound to (digestScopeContract). */
  scopeContractHash?: string;
  startedAt: string;
  updatedAt: string;
  /** Forbidden writes detected by the latest guard_session_check (overwrite, not append). */
  violations: GuardSessionViolation[];
}

/**
 * B-6bfd CHK-005: binds reviewer evidence to the exact scope contract + diff
 * context the reviewer inspected. Computed by core/review-scope-binding.ts.
 */
export interface ReviewScopeBinding {
  /** digestScopeContract(contract) at review_run_start time. */
  scopeContractHash?: string;
  /** Stable digest over the MATERIAL diff (story metadata excluded). */
  diffPackHash?: string;
  /** Material changed files the reviewer inspected (metadata excluded, sorted). */
  reviewedChangedFiles: string[];
  /** Verification intent refs the reviewer recorded as inspected (sorted). */
  reviewedIntentRefs: string[];
  /** Material hunk digests the reviewer inspected (sorted, deduped). */
  reviewedHunkDigests: string[];
  /** sha256 over all fields above + salt; folded into the review run signature. */
  bindingHash: string;
}

/**
 * B-b750: binds a reviewer run to the exact git-backed workspace used for
 * signed material facts while keeping story metadata writes rooted at
 * metadataRoot.
 */
export interface ReviewRunWorkspaceBinding {
  schemaVersion: 'lattice.review_run_workspace_binding.v1';
  metadataRoot: string;
  invocationCwd: string;
  repoRoot: string | null;
  signedWorkspaceRoot: string;
  workspaceMode: string;
  headHash: string;
  materialHash: string;
  storyFilesHash?: string;
  /** sha256 over all fields above + salt; folded into the review run signature. */
  bindingHash: string;
}

// ── ProofStory progressive intent hardening ──

export type ProofStoryHardeningLevel = 'intent_mvp' | 'standard' | 'high_assurance';
export type ProofStoryGateMode = 'observe' | 'warn' | 'enforce';

export interface OriginalIntentSnapshotData {
  schemaVersion: 'proofstory.original_intent_snapshot.v1';
  storyId: string;
  sourceText: string;
  normalizedOutcome: string;
  acceptanceClaim: string;
  /** Stable requirement ids that participate in requestHash. */
  keyRequirementIds: string[];
  /** sha256 over sourceText + sorted keyRequirementIds. Immutable after first set. */
  requestHash: string;
  createdAt: string;
  updatedAt: string;
}

export type MilestoneStatus = 'planned' | 'covered' | 'done' | 'not_applicable';
export type MilestoneLedgerState = 'candidate' | 'confirmed';

export interface MilestoneLedgerItem {
  id: string;
  sourceRequirementId: string;
  claim: string;
  doneMeans: string;
  requiredEvidence: string[];
  checklistRefs: string[];
  verificationIntentRefs: string[];
  /** Optional parent ledger row when this item is a slice of a larger parent intent ledger. */
  parentLedgerId?: string;
  /** Optional child story responsible for delivering this row; advisory until roll-up/DONE checks consume it. */
  assignedStory?: string;
  status: MilestoneStatus;
}

export interface MilestoneLedgerData {
  schemaVersion: 'proofstory.milestone_ledger.v1';
  storyId: string;
  /** Candidate ledgers guide diagnostics; only confirmed ledgers are gate-consumed. */
  state?: MilestoneLedgerState;
  /** Stable sha256 over ledger rows plus state-independent source metadata. */
  ledgerHash?: string;
  acceptedIntentBinding?: {
    intentCollisionId: string;
    acceptedInterpretationHash: string;
    acceptedAt: string;
  };
  milestones: MilestoneLedgerItem[];
  createdAt: string;
  updatedAt: string;
}

export interface ProofStoryTriggerReason {
  code: string;
  message: string;
  requires?:
    | 'milestone-ledger'
    | 'confirmed-milestone-ledger'
    | 'intent-collision'
    | 'red-evidence'
    | 'spike-evidence'
    | 'scope-clarification'
    | 'scope-shrinkage'
    | 'high-assurance'
    | 'done-equivalence';
}

export interface ProofStoryAcceptanceBinding {
  id: string;
  acceptanceClaim?: string;
  checklistRefs: string[];
  verificationIntentRefs: string[];
  milestoneIds: string[];
  note?: string;
}

export interface ProofStoryDiagnosticGap {
  code: string;
  severity: 'info' | 'warn' | 'fail';
  artifact: string;
  message: string;
  triggeredBy?: string[];
}

export interface ProofStoryLedgerSizing {
  milestoneCount: number;
  threshold: number;
  thresholdState: 'within_threshold' | 'too_broad' | 'slice_required';
  oversizedClearedBy?: 'slice_plan' | 'child_assignment';
  suggestedSlices: Array<{
    id: string;
    milestoneIds: string[];
    reason: string;
  }>;
}

export interface ProofStorySlicePlanSlice {
  id: string;
  milestoneIds: string[];
  reason: string;
  assignedStory?: string;
}

export interface ProofStorySlicePlanData {
  schemaVersion: 'proofstory.slice_plan.v1';
  storyId: string;
  ledgerHash: string;
  slices: ProofStorySlicePlanSlice[];
  planHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProofStoryParentLedgerRollupChild {
  storyId: string;
  milestoneIds: string[];
  status: 'planned' | 'covered' | 'done';
  evidenceRefs: string[];
}

export interface ProofStoryParentLedgerRollupData {
  schemaVersion: 'proofstory.parent_ledger_rollup.v1';
  storyId: string;
  ledgerHash: string;
  slicePlanHash?: string;
  children: ProofStoryParentLedgerRollupChild[];
  rollupHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProofStoryContractData {
  schemaVersion: 'proofstory.contract.v1';
  storyId: string;
  diagnosticOnly: boolean;
  hardeningLevel: ProofStoryHardeningLevel;
  triggerReasons: ProofStoryTriggerReason[];
  originalIntentRequestHash?: string;
  confirmedMilestoneLedgerHash?: string;
  acceptanceBindings: ProofStoryAcceptanceBinding[];
  diagnosticGaps: ProofStoryDiagnosticGap[];
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export type IntentCollisionDecision = 'pass' | 'revise_intent' | 'human_gate' | 'stop';

export interface IntentCollisionData {
  schemaVersion: 'proofstory.intent_collision.v1';
  storyId: string;
  id: string;
  decision: IntentCollisionDecision;
  status: 'accepted' | 'open' | 'stopped';
  acceptedInterpretation?: string;
  acceptedInterpretationHash?: string;
  notes?: string;
  ledgerHashBeforeDecision?: string;
  confirmedLedgerHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScopeShrinkageDecisionData {
  schemaVersion: 'proofstory.scope_shrinkage_decision.v1';
  storyId: string;
  decision: 'confirmed' | 'rejected';
  userConfirmed: boolean;
  removedMilestoneIds: string[];
  reason: string;
  approvedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RedEvidenceRecord {
  id: string;
  trigger: string;
  /** Acceptance, verificationIntent, milestone, or request hash target this red proof addresses. */
  acceptanceTargetRef: string;
  baselineHeadHash: string;
  baselineMaterialHash: string;
  failingCommand?: string;
  failureReceiptHash?: string;
  observedFailure: string;
  expectedGreenCommand?: string;
  greenRelation: {
    targetRef: string;
    relation: 'same_acceptance' | 'regression_to_green' | 'replacement';
    command?: string;
    greenHeadHash?: string;
    greenMaterialHash?: string;
  };
  note?: string;
  createdAt: string;
}

export interface RedEvidenceData {
  schemaVersion: 'proofstory.red_evidence.v1';
  storyId: string;
  records: RedEvidenceRecord[];
  createdAt: string;
  updatedAt: string;
}

export type ProofStorySpikeStatus = 'active' | 'resolved' | 'discarded' | 'promoted';

export interface ProofStorySpikeRecord {
  id: string;
  question: string;
  status: ProofStorySpikeStatus;
  result?: string;
  disposableCodePaths?: string[];
  promotedAs?: 'red_evidence' | 'verification_evidence' | 'scope_decision' | 'implementation_note';
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProofStorySpikeData {
  schemaVersion: 'proofstory.spike.v1';
  storyId: string;
  spikes: ProofStorySpikeRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface ProofStoryDiagnosticReport {
  schemaVersion: 'proofstory.diagnostic_report.v1';
  storyId: string;
  dryRun?: true;
  mode: ProofStoryGateMode;
  status: 'pass' | 'warn' | 'fail';
  blocking: boolean;
  hardeningLevel: ProofStoryHardeningLevel;
  triggerReasons: ProofStoryTriggerReason[];
  ledgerState: MilestoneLedgerState | 'missing';
  ledgerSizing: ProofStoryLedgerSizing;
  missingMvpArtifacts: ProofStoryDiagnosticGap[];
  missingMilestoneCoverage: ProofStoryDiagnosticGap[];
  missingConfirmedLedger: ProofStoryDiagnosticGap[];
  missingAcceptanceBindings: ProofStoryDiagnosticGap[];
  missingIntentCollision: ProofStoryDiagnosticGap[];
  missingRedEvidence: ProofStoryDiagnosticGap[];
  missingSpikeEvidence: ProofStoryDiagnosticGap[];
  scopeAmbiguity: ProofStoryDiagnosticGap[];
  oversizedLedger: ProofStoryDiagnosticGap[];
  missingParentRollup: ProofStoryDiagnosticGap[];
  gaps: ProofStoryDiagnosticGap[];
  wouldBlockFutureDevAdmission: boolean;
}

export interface DoneIntentEquivalenceReport {
  schemaVersion: 'proofstory.done_intent_equivalence.v1';
  storyId: string;
  mode: ProofStoryGateMode;
  status: 'pass' | 'warn' | 'fail';
  blocking: boolean;
  checkedAt: string;
  confirmedLedgerHash?: string;
  equivalenceMode: 'lightweight_single_outcome' | 'strict_milestone';
  acceptedShrinkageMilestoneIds: string[];
  uncoveredRequiredMilestoneIds: string[];
  gaps: ProofStoryDiagnosticGap[];
}

export interface ProofStoryReviewCompletenessReport {
  schemaVersion: 'proofstory.review_completeness.v1';
  storyId: string;
  mode: ProofStoryGateMode;
  status: 'pass' | 'warn' | 'fail';
  blocking: boolean;
  checkedAt: string;
  gaps: ProofStoryDiagnosticGap[];
}

// ── Review Reflection Loop (B-7a34) ──

export type ReviewLoopDecision =
  | 'continue'
  | 'retry'
  | 'revise'
  | 'rollback_required'
  | 'handoff_recommended'
  | 'human_gate_required'
  | 'close_candidate'
  | 'stop_blocked';

export type ReviewLoopStatus = 'open' | 'resolved' | 'escalated' | 'blocked';

export interface ReviewLoopTrigger {
  findingIds?: string[];
  bugIds?: string[];
  validationFailureRefs?: string[];
  scopeViolationRefs?: string[];
}

export interface ReviewLoopRollbackRef {
  headHash: string;
  diffHash: string;
  materialHash: string;
  scopeContractHash?: string;
}

export interface ReviewLoopStart {
  schemaVersion: 'lattice.review_loop_start.v1';
  event: 'start';
  loopId: string;
  storyId: string;
  reviewRound: string;
  status: 'open';
  trigger: ReviewLoopTrigger;
  rollbackRef: ReviewLoopRollbackRef;
  openedAt: string;
  actor: string;
}

export interface ReviewLoopIteration {
  schemaVersion: 'lattice.review_loop_iteration.v1';
  event: 'iteration';
  loopId: string;
  storyId: string;
  reviewRound: string;
  status: 'open';
  iteration: number;
  trigger: ReviewLoopTrigger;
  host: {
    hostId: string;
    capabilitySnapshotRef?: string;
    visibleDegradations?: string[];
  };
  rollbackRef: ReviewLoopRollbackRef;
  reflection: {
    progress: 'improved' | 'unchanged' | 'regressed';
    evidenceQuality: 'strong' | 'medium' | 'weak';
    failureType?: 'prompt' | 'context' | 'tool' | 'host' | 'requirement' | 'external';
    riskLevel: 'low' | 'medium' | 'high';
    rootCauseHypothesis: string;
    nextPromptPatch?: string;
    recommendedDecision: ReviewLoopDecision;
    reason: string;
    /** Context-only learning capture. Not review pass, validation, or authority evidence. */
    reusableLearning?: string;
  };
  evaluation: {
    progressScore?: number;
    riskScore?: number;
    regressionScore?: number;
    confidenceScore?: number;
    costMeasured: boolean;
    costUsedUSD?: number;
    timeUsedMs?: number;
    commandsRun: string[];
    evidenceRefs: string[];
  };
  decision: ReviewLoopDecision;
  decisionReason: string;
  nextAction?: {
    nextPrompt?: string;
    rollbackCommandHint?: string;
    handoffHostId?: string;
    humanQuestion?: string;
  };
  createdAt: string;
  actor: string;
}

export interface ReviewLoopClose {
  schemaVersion: 'lattice.review_loop_close.v1';
  event: 'close';
  loopId: string;
  storyId: string;
  reviewRound: string;
  status: 'resolved' | 'escalated' | 'blocked';
  trigger: ReviewLoopTrigger;
  materialHash: string;
  resolvedEvidenceRefs?: string[];
  supersedingEvidenceRefs?: string[];
  closeReason: string;
  closedAt: string;
  actor: string;
}

export type ReviewLoopRecord = ReviewLoopStart | ReviewLoopIteration | ReviewLoopClose;

export interface ReviewLoopPolicy {
  schemaVersion: 'lattice.review_loop_policy.v1';
  maxIterations: number;
  maxNoProgressIterations: number;
  maxRuntimeMinutes: number;
  maxCostUSD: number;
  allowAutoHandoff: boolean;
  allowAutoRollback: boolean;
  requireHumanForScopeExpansion: boolean;
  requireHumanForProtectedFiles: boolean;
  stopOnTestRegression: boolean;
  stopOnScopeViolation: boolean;
}

export const WORKFLOW_PRESETS: Record<WorkflowProfile, WorkflowPolicy> = {
  light: {
    profile: 'light',
    quickPath: { enabled: true, maxChecklistItems: 5, allowRiskSignals: false },
    plan: { requireUnderstanding: 'never', requireDecision: 'never', requirePlanMd: 'never', requireStoryReview: false },
    subagents: { requireWorkerInNormalChannel: false, allowMainAgentCoding: true },
    review: { requireReviewer: false, requireReviewerFinding: false, blockingSeverities: ['critical'], requireLightReview: false },
    test: { requireValidatePass: true, requireAllBugsFixed: true, requireEvaluatorForBrowser: false },
    done: { requireSummary: 'minimal', requireBranchSynced: true, requireCleanGit: true },
  },
  balanced: {
    profile: 'balanced',
    quickPath: { enabled: true, maxChecklistItems: 2, allowRiskSignals: false },
    plan: { requireUnderstanding: 'always', requireDecision: 'high_risk', requirePlanMd: 'normal', requireStoryReview: true },
    subagents: { requireWorkerInNormalChannel: true, allowMainAgentCoding: false },
    review: { requireReviewer: true, requireReviewerFinding: true, blockingSeverities: ['critical', 'high'], requireLightReview: true },
    test: { requireValidatePass: true, requireAllBugsFixed: true, requireEvaluatorForBrowser: true },
    done: { requireSummary: 'full', requireBranchSynced: true, requireCleanGit: true },
  },
  strict: {
    profile: 'strict',
    quickPath: { enabled: false, maxChecklistItems: 0, allowRiskSignals: false },
    plan: { requireUnderstanding: 'always', requireDecision: 'always', requirePlanMd: 'always', requireStoryReview: true },
    subagents: { requireWorkerInNormalChannel: true, allowMainAgentCoding: false },
    review: { requireReviewer: true, requireReviewerFinding: true, blockingSeverities: ['critical', 'high', 'medium'], requireLightReview: true },
    test: { requireValidatePass: true, requireAllBugsFixed: true, requireEvaluatorForBrowser: true },
    done: { requireSummary: 'full', requireBranchSynced: true, requireCleanGit: true },
  },
};
