
export type {
  ValidationCommand,
  ValidationCommandResult,
  ValidationPlan,
  ValidationResult,
  ValidationStatus,
  DoneRequiredCommandSpecEnvelope,
  DoneRequiredCommandReceipt,
  DoneRequiredEvidenceData,
  DoneRequiredEvidenceStatus,
  RoutineValidationIdentity,
  RoutineValidationCommandExecution,
} from './validation-types.js';
import type { RoutineValidationIdentity, RoutineValidationCommandExecution } from './validation-types.js';
import type { SignatureTagSource } from './experience-layer-types.js';
// W2c (B-506e): the RED-evidence subsystem's v2 record union (chain / control
// records). RedEvidenceData.records is a mixed v1+v2 array, schemaVersion-
// discriminated — the on-disk layout is unchanged (still one append-only
// records[] under the v1 FILE schemaVersion).
import type { RedEvidenceRecordV2 } from './red-evidence/record-v2.js';
export type { RedEvidenceRecordV2 } from './red-evidence/record-v2.js';

export type StoryPhase = 'IDEA' | 'INIT' | 'INIT_CHECK' | 'PLAN' | 'DEV' | 'REVIEW' | 'TEST' | 'DONE' | 'DISCARDED'
  // Legacy phases kept for backward compat with existing story data
  | 'TEST_CASE' | 'TEST_CASE_REVIEW'
  // B-9bd9 CHK-002: meta-story dedicated phase, never enters DONE (cross-story container, only attaches findings)
  | 'META';

/** Canonical role names accepted by the typed dispatch contract. */
export type AgentDispatchCanonicalType =
  | 'proof-or-stop-implementer'
  | 'proof-or-stop-verification-intent'
  | 'proof-or-stop-test-intent'
  | 'proof-or-stop-test-case-reviewer'
  | 'proof-or-stop-review-story-init'
  | 'proof-or-stop-product-reviewer'
  | 'proof-or-stop-review-scope-plan'
  | 'proof-or-stop-review-topology-critic'
  | 'proof-or-stop-review-concept'
  | 'proof-or-stop-review-quality'
  | 'proof-or-stop-review-test-coverage'
  | 'proof-or-stop-review-behavior'
  | 'proof-or-stop-review-docs'
  | 'proof-or-stop-review-channel'
  | 'proof-or-stop-review-delivery'
  | 'proof-or-stop-finding-repair'
  | 'proof-or-stop-cluster-repair'
  // Accepted only as legacy input/read values. Runtime registry rows always
  // use the proof-or-stop spellings above.
  | 'lattice-implementer'
  | 'verification-intent'
  | 'proof-or-stop-review-story-init'
  | 'product-reviewer'
  | 'lattice-review-scope-plan'
  | 'lattice-review-topology-critic'
  | 'lattice-review-concept'
  | 'lattice-review-quality'
  | 'lattice-review-test-coverage'
  | 'lattice-review-behavior'
  | 'lattice-review-docs'
  | 'lattice-review-channel'
  | 'lattice-review-delivery'
  | 'lattice-finding-repair'
  | 'lattice-cluster-repair'
  | 'acceptance-rollout-verifier';

export type AgentDispatchRoleClass =
  | 'implementer'
  | 'verification-intent'
  | 'init-reviewer'
  | 'scope-reviewer'
  | 'story-reviewer'
  | 'item-reviewer'
  | 'coverage-reviewer'
  | 'delivery-reviewer'
  | 'repairer';

export type AgentDispatchTargetCardinality = 'story-only' | 'exactly-one';
export type AgentDispatchIdentifierKind = 'itemId' | 'findingId' | 'clusterId';
export type AgentDispatchPromptBuilderKey =
  | 'implementer-dispatch'
  | 'verification-intent-item'
  | 'init-review'
  | 'product-init-review'
  | 'scope-plan-review'
  | 'topology-critic-review'
  | 'story-review'
  | 'item-review'
  | 'coverage-review'
  | 'delivery-review'
  | 'finding-repair'
  | 'cluster-repair'
  | 'rollout-verify';

export type AgentDispatchMutationCommand =
  | 'checklist_update'
  | 'init_check_set'
  | 'scope_check_save'
  | 'topology_exclusion_approval_set'
  | 'topology_critic_receipt_set'
  | 'review_run_start'
  | 'finding_add'
  | 'review_pass_set'
  | 'review_inventory_critic_set'
  | 'delivery_check_set'
  | 'finding_resolve'
  // B-e10d (W2b): the RED-evidence subsystem's first mutating command. The
  // implementer registers the per-story target binding before a RED run.
  | 'red_evidence_binding_set'
  // B-506e (W2c): the two owner-gated chain-control commands — retire a bad
  // record without mutating history, and undo a mistaken quarantine (§4.1).
  | 'red_evidence_quarantine'
  | 'red_evidence_recover';

export type AgentDispatchReviewerLane =
  | 'proof-or-stop-review-story-init'
  | 'proof-or-stop-product-reviewer'
  | 'proof-or-stop-review-scope-plan'
  | 'proof-or-stop-review-topology-critic'
  | 'proof-or-stop-review-concept'
  | 'proof-or-stop-review-quality'
  | 'proof-or-stop-review-test-coverage'
  | 'proof-or-stop-review-behavior'
  | 'proof-or-stop-review-docs'
  | 'proof-or-stop-review-channel'
  | 'proof-or-stop-review-delivery'
  | 'acceptance-rollout-verifier'
  // Historical spellings are accepted at the input/compatibility boundary;
  // canonical proof-or-stop lanes remain the runtime authority.
  | 'lattice-review-story-init'
  | 'product-reviewer'
  | 'proof-or-stop-review-scope-plan'
  | 'proof-or-stop-review-topology-critic'
  | 'proof-or-stop-review-concept'
  | 'proof-or-stop-review-quality'
  | 'proof-or-stop-review-test-coverage'
  | 'proof-or-stop-review-behavior'
  | 'proof-or-stop-review-docs'
  | 'proof-or-stop-review-channel'
  | 'proof-or-stop-review-delivery';

export type AgentDispatchEvidenceOwnership =
  | 'checklist-status'
  | 'verification-intent'
  | 'init-check'
  | 'scope-check'
  | 'topology-exclusion-approval'
  | 'topology-critic-receipt'
  | 'review-inventory-critic-receipt'
  | 'review-run'
  | 'finding'
  | 'review-pass'
  | 'delivery-check'
  | 'finding-resolution'
  | 'cluster-resolution';

/** One mechanically consumable row in the agent dispatch authority table. */
export interface AgentDispatchRegistryEntry {
  canonicalName: AgentDispatchCanonicalType;
  aliases: readonly string[];
  roleClass: AgentDispatchRoleClass;
  allowedPhases: readonly StoryPhase[];
  targetCardinality: AgentDispatchTargetCardinality;
  identifierKinds: readonly AgentDispatchIdentifierKind[];
  promptBuilder: AgentDispatchPromptBuilderKey;
  /** Exactly-one roles declare the prompt selected for each accepted target kind. Story-only roles keep this empty. */
  promptBuilderByIdentifier: Readonly<Partial<Record<AgentDispatchIdentifierKind, AgentDispatchPromptBuilderKey>>>;
  permittedMutations: readonly AgentDispatchMutationCommand[];
  commitAllowed: boolean;
  reviewerLane: AgentDispatchReviewerLane | null;
  evidenceOwnership: readonly AgentDispatchEvidenceOwnership[];
}

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

/**
 * B-70a6 F-004: the durable crash-recovery record for the gated PLAN->INIT
 * reopen audit.
 *
 * WHY IT EXISTS. The reopen's audit facts (the validated reason + the reopen
 * marker) live in an append-only `phase_transition` process event, but the
 * phase write and the event append are two separate fs operations. A crash
 * between them used to leave phase=INIT with NO audit record at all — and
 * because REOPEN only fires FROM PLAN, the story had already left the only
 * phase that could retry it, so that audit event was UNRECOVERABLE.
 *
 * HOW IT CLOSES THAT WINDOW. This record is set on the story index in the SAME
 * `store.writeStory` that persists phase=INIT. `StoryStore.writeJsonFile` is
 * tmp-write + `renameSync`, so the record and the new phase land in ONE atomic
 * rename: either the reopen did not happen, or it happened AND the reason is
 * already durably on disk. `reconcilePendingReopenAudit`
 * (handlers/transition-orchestrator.ts) then emits the missing event and clears
 * this record — but ONLY at the points enumerated in the next paragraph, NOT on
 * every command and under NO concurrency guarantee; `auditId` is the idempotency
 * key that makes that recovery emit EXACTLY ONE event, never two.
 *
 * (B-70a6 F-016: the sentence above used to promise that recovery "on the next
 * transition", with no qualifier at all. It is EDITED IN PLACE rather than merely
 * supplemented by the paragraph below, so a reader who stops reading here is not
 * left with the pre-F-005 impression that some later transition always heals it.)
 *
 * WHAT THAT DOES AND DOES NOT GUARANTEE. Recovery fires on the next ORCHESTRATED
 * transition, and — since B-70a6 F-005 — at the two out-of-band phase writers
 * (story_discard, the story_reconcile zombie repair) before they destroy the copy
 * holding this record. It is NOT a concurrency guarantee: those two sites hold no
 * lock, so a reopen that writes this record while one of them is already running
 * can still lose both the record and its event — see
 * CONCURRENCY RESIDUAL (B-70a6 F-013), documented in full on
 * `reconcileReopenAuditBeforeOutOfBandPhaseChange`. Finding this record on disk
 * therefore means "a reopen committed whose audit event may be missing", not
 * "every committed reopen is guaranteed to leave one".
 *
 * It is audit/recovery bookkeeping, NOT gate evidence: no gate consumes it.
 */
export interface PendingReopenAudit {
  /**
   * Unique per reopen. The idempotency key: reconciliation appends the audit
   * event only when NO `phase_transition` event carries this `reopenAuditId`,
   * so a crash between the append and the clear cannot double-emit.
   */
  auditId: string;
  /** The operator reason, verbatim, already validated (>= REOPEN_REASON_MIN, non-blank). */
  reason: string;
  /** The phase the reopen left (PLAN — the only phase REOPEN fires from). */
  fromPhase: string;
  /** ISO 8601 timestamp of the reopen persist. */
  at: string;
  /** Evidence-binding facts captured with the reopen, so a recovered event matches the in-line one. */
  materialHash: string;
  storyFilesHash: string;
  reviewRound: string;
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
  /** Dynamic validation capability triggers declared by Story planning. */
  affectedCapabilities?: string[];
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

  /**
   * B-70a6 F-004: present ONLY between a gated PLAN->INIT reopen's phase write
   * and its audit-event append. Written in the SAME atomic writeStory rename as
   * phase=INIT and cleared immediately after the event is durably appended, so
   * finding it on disk means "a reopen committed whose audit event may be
   * missing" — the recoverable state that replaces the old unrecoverable one.
   * See PendingReopenAudit and reconcilePendingReopenAudit.
   */
  pendingReopenAudit?: PendingReopenAudit;

  // Parallel policy fields (B-c622)
  lane?: 'mainline' | 'supporting' | 'exploratory';
  parallelSafe?: 'yes' | 'no' | 'plan_only';
  sharedHotspots?: string[];
  blockingFor?: string[];
}

export type ChecklistStatus = 'pending' | 'in_progress' | 'done' | 'withdrawn';

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

/**
 * B-ec67: the tool-executed proof unit pinned onto an executable verification
 * intent. `command` is the executable+argv string the evidence writer runs;
 * `selector` is the string that MUST appear in captured output to prove the
 * intent. Pinned on the FIRST selector-bearing evidence write, and every later
 * evidence write carrying a different command/selector is refused.
 *
 * B-1482: the pin is NOT immutable without exception. Once set it can still move,
 * but in the TIGHTENING direction only and only through `verification_pin_narrow`:
 * the `selector` only, never the `command`, at most once per recorded-receipt set,
 * and only when receipts this tool recorded prove the new selector is absent from a
 * failing render the current selector matched and present in every recorded passing
 * receipt. A loosening re-pin stays refused everywhere, and each accepted movement
 * is retained on `narrowings`.
 */
export interface VerificationIntentPin {
  command: string;
  selector: string;
  /**
   * B-1482: append-only log of the NARROWING-ONLY re-pins this intent has taken.
   * Absent until the first narrowing. Each record retains the old pin, the new pin,
   * the caller-supplied reason and the ids of the tool-recorded receipts the proof
   * used, so a reader can re-check the proof against the same receipts.
   *
   * Written ONLY by the narrowing entry point after a proof drawn from recorded
   * receipts; the caller-facing pin schema does not accept it, so it can never be
   * injected. Loosening remains impossible: a re-pin that is not provably stricter
   * on recorded receipts is refused and never produces a record.
   */
  narrowings?: VerificationPinNarrowingRecord[];
}

/**
 * B-1482: one accepted narrowing re-pin, retained on the pin it changed.
 *
 * `receiptSetDigest` identifies the exact set of recorded receipts the proof read.
 * A set admits at most ONE narrowing: a later request whose corpus digests to the
 * same value is refused, so repeated narrowing cannot home in on one hand-picked
 * run without new recorded evidence.
 */
export interface VerificationPinNarrowingRecord {
  /** The pin as it stood BEFORE this narrowing. */
  previousSelector: string;
  /** The pin as it stands AFTER it, identical to the owning pin's current selector. */
  selector: string;
  /** Caller-supplied justification. Never evidence on its own — the proof is the receipts. */
  reason: string;
  /** The pinned command whose recorded receipts the proof was drawn from (unchanged by a narrowing). */
  command: string;
  /** Digest of the recorded-receipt set the proof read; bounds this set to one narrowing. */
  receiptSetDigest: string;
  /** Recorded receipts the OLD selector matched on a FAILING run where the new selector is absent. */
  failingReceiptIds: string[];
  /** Recorded PASSING receipts the new selector matches; all of them must, or the re-pin is refused. */
  passingReceiptIds: string[];
  /** Shared recorded material binding of every receipt the proof used. */
  materialKey: string;
  narrowedAt: string;
  /** Git/material binding of the narrowing REQUEST itself (not of the receipts). */
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
}

export interface VerificationIntentItem {
  /** Optional stable id. If absent, Proof-or-Stop derives CHK-001:happy:0 from lane/index. */
  id?: string;
  desc: string;
  type: VerificationIntentType;
  requiredIn?: VerificationRequiredIn;
  priority?: VerificationPriority;
  /** PLAN-only, verification-intent-owned declarations for paths DEV will add. */
  plannedPathDeclarations?: VerificationPlannedPathDeclarationV1[];
  /**
   * B-ec67: tool-executed evidence proof unit for an executable intent
   * (logic|cli|browser). Absent until the first selector-bearing evidence write
   * pins it. Never present on manual|docs intents.
   *
   * Immutable to every evidence write, with exactly ONE audited exception (B-1482):
   * `verification_pin_narrow` can move the `selector` — never the `command` — to a
   * STRICTER one, at most once per recorded-receipt set, and only when receipts this
   * tool recorded prove the new selector is absent from a failing render the current
   * selector matched and present in every recorded passing receipt. A loosening re-pin
   * stays refused everywhere, and each accepted movement is retained on `narrowings`.
   */
  verification?: VerificationIntentPin;
}

export type VerificationPlannedPathArtifactKind = 'source_file' | 'handler' | 'dispatch' | 'process_fact';

export interface VerificationPlannedPathEndpointV1 {
  id: string;
  role: 'producer' | 'consumer';
  expectedArtifactKind: VerificationPlannedPathArtifactKind;
  expectedFileRef: string;
  expectedSymbolOrFact: string;
  fileDeclarationRef: string;
}

export interface VerificationPlannedPathDeclarationV1 {
  schemaVersion: 'proofstory.verification_planned_path_declaration.v1';
  id: string;
  relation: 'producer_to_consumer';
  producer: VerificationPlannedPathEndpointV1;
  consumers: VerificationPlannedPathEndpointV1[];
  outputFactRef: string;
}

export interface ExistingTopologySourceRefV1 {
  refKind: 'existing';
  canonicalSourceRef: string;
}

export interface PlannedTopologySourceRefV1 {
  refKind: 'planned';
  plannedPathDeclarationRef: string;
  endpointRef: string;
}

export type TopologySourceRefV1 = ExistingTopologySourceRefV1 | PlannedTopologySourceRefV1;

export interface AcceptanceTopologyProducerRefV1 {
  id: string;
  sourceRef: TopologySourceRefV1;
}

export interface AcceptanceTopologyConsumerRefV1 {
  id: string;
  sourceRef: TopologySourceRefV1;
  producerRefs: string[];
}

export interface AcceptanceTopologyAssertionRefV1 {
  id: string;
  sourceRef: TopologySourceRefV1;
  producerRefs: string[];
  consumerRefs: string[];
}

/**
 * Wave 1 is deliberately reference-only. It contains no copied edge semantics,
 * observed outcomes, coverage basis, authority, freshness, or verdict fields.
 */
export interface AcceptanceVerificationTopologyV1 {
  schemaVersion: 'proofstory.acceptance_topology.v1';
  producerRefs: AcceptanceTopologyProducerRefV1[];
  consumerRefs: AcceptanceTopologyConsumerRefV1[];
  positiveAssertionRefs: AcceptanceTopologyAssertionRefV1[];
  mutationCaseRefs: AcceptanceTopologyAssertionRefV1[];
  transcriptAssertionRefs: AcceptanceTopologyAssertionRefV1[];
  commandRefs: TopologySourceRefV1[];
}

export type CoverageDiscoveryMethodV1 =
  | 'scope_contract'
  | 'actual_diff_hunks'
  | 'process_fact_registry'
  | 'handler_dispatch_inventory'
  | 'static_call_graph'
  | 'runtime_trace';

export interface CoverageAdapterResultV1 {
  schemaVersion: 'proofstory.coverage_adapter_result.v1';
  adapterId: string;
  method: CoverageDiscoveryMethodV1;
  pathRefs: string[];
  coverageClaim: 'complete_for_scope' | 'partial' | 'unsupported';
  blindSpots: string[];
  provenanceRefs: string[];
  asymmetryPolicy: {
    kind: 'exhaustive' | 'bounded_non_exhaustive' | 'unsupported';
    policyRef: string;
    scopeRefs: string[];
  };
  resultDigest: string;
}

export interface PlannedCoveragePathV1 {
  schemaVersion: 'proofstory.planned_coverage_path.v1';
  plannedPathRef: string;
  plannedPathDeclarationRef: string;
  declarationDigest: string;
  producer: VerificationPlannedPathEndpointV1;
  consumers: VerificationPlannedPathEndpointV1[];
  outputFactRef: string;
  acceptanceBindingRefs: string[];
  verificationIntentRefs: string[];
  declarationRefs: string[];
  plannedPathDigest: string;
}

export interface PlannedActualPathReconciliationV1 {
  schemaVersion: 'proofstory.planned_actual_path_reconciliation.v1';
  plannedPathRef: string;
  actualPathRefs: string[];
  relation: 'exact' | 'expanded' | 'replaced';
  replacementDecisionRef?: string;
  reconciliationDigest: string;
}

export type AcceptanceSnapshotSealIssueCodeV1 =
  | 'directory_changed'
  | 'source_file_changed'
  | 'safe_no_follow_unsupported'
  | 'inventory_unsealable'
  | 'snapshot_missing'
  | 'derivation_diagnostic';

export interface AcceptanceSnapshotSealIssueV1 {
  code: AcceptanceSnapshotSealIssueCodeV1;
  targetKind: 'directory' | 'source_file' | 'config' | 'inventory';
  canonicalRef: string;
}

export interface AcceptanceSnapshotSealV1 {
  schemaVersion: 'proofstory.acceptance_snapshot_seal.v1';
  inventoryDirectoryDigest: string;
  inventoryDirectoryCount: number;
  sourceSnapshotDigest: string;
  sourceSnapshotCount: number;
  configSnapshotDigest: string;
  status: 'complete' | 'partial';
  issues: AcceptanceSnapshotSealIssueV1[];
  sealDigest: string;
}

export interface AcceptanceCoverageBasisV1 {
  schemaVersion: 'proofstory.acceptance_coverage_basis.v1';
  storyId: string;
  phaseBasis: 'plan' | 'pre_review';
  priorPlanBasisDigest?: string;
  status: 'complete' | 'partial' | 'unsupported';
  generatedBy: {
    verifier: 'acceptance-coverage-basis-verifier';
    command: 'proof-or-stop acceptance_basis_generate' | 'proof-or-stop pre_review_check';
    algorithmVersion: 'v1';
  };
  discoveryProfileRef: string;
  discoveryProfileDigest: string;
  discoveryMethods: CoverageDiscoveryMethodV1[];
  adapterResults: CoverageAdapterResultV1[];
  scopeRefs: string[];
  sourceInventoryRefs: string[];
  plannedPathRecords: PlannedCoveragePathV1[];
  plannedActualReconciliations: PlannedActualPathReconciliationV1[];
  enumeratedPathRefs: string[];
  excludedPathRefs: Array<{ pathRef: string; decisionRef: string }>;
  blindSpots: string[];
  snapshotSeal: AcceptanceSnapshotSealV1;
  binding: {
    headHash: string;
    materialHash: string;
    storyFilesHash: string;
    scopeCheckDigest: string;
    scopeContractDigest?: string;
    closureFilesHash: string;
  };
  receiptRef: string;
  basisDigest: string;
}

export interface AcceptanceBasisReceiptV1 {
  schemaVersion: 'proofstory.acceptance_basis_receipt.v1';
  receiptRef: string;
  issuer: 'acceptance-coverage-basis-verifier';
  issuerKeyId: string;
  signerPublicKey: string;
  storyId: string;
  phaseBasis: 'plan' | 'pre_review';
  basisDigest: string;
  topologyDigest: string;
  scopeCheckDigest: string;
  scopeContractDigest?: string;
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  closureFilesHash: string;
  sealDigest: string;
  workspaceIdentityDigest: string;
  signature: string;
}

export interface AcceptanceBasisArtifactV1 {
  schemaVersion: 'proofstory.acceptance_basis_artifact.v1';
  basis: AcceptanceCoverageBasisV1;
  receipt: AcceptanceBasisReceiptV1;
}

export type PreReviewCheckCodeV1 =
  | 'ok'
  | 'PR_ARTIFACT_MISSING'
  | 'PR_COVERAGE_BASIS_CHANGED'
  | 'PR_COVERAGE_INCONCLUSIVE'
  | 'PR_PLANNED_PATH_UNRESOLVED'
  | 'PR_PLANNED_PATH_RECONCILIATION_TAMPERED'
  | 'PR_POSITIVE_EVIDENCE_MISSING'
  | 'PR_PRODUCTION_PATH_UNPROVEN'
  | 'PR_MUTATION_EVIDENCE_MISSING'
  | 'PR_MUTATION_DID_NOT_BITE'
  | 'PR_CONTROL_NOT_RESTORED'
  | 'PR_TRANSCRIPT_MISSING'
  | 'PR_TRANSCRIPT_UNRELATED'
  | 'PR_AUTHORITY_INADMISSIBLE'
  | 'PR_EVIDENCE_STALE'
  | 'PR_CUTOFF_UNBOUND'
  | 'PR_NEW_PATH_UNMAPPED'
  | 'PR_REQUIRED_ADAPTER_RESULT_MISSING'
  | 'PR_ADAPTER_RESULT_DIGEST_MISMATCH'
  | 'PR_ADAPTER_RESULT_INVALID'
  | 'PR_CLOSURE_FILES_CHANGED'
  | 'PR_TOPOLOGY_CRITIC_REATTESTATION_REQUIRED'
  | 'PR_ARTIFACT_TAMPERED';

export interface PreReviewMutationProofV1 {
  mutationId: string;
  expectedCode: string;
  observedCode: string;
  controlRestored: boolean;
}

export interface PreReviewTranscriptProofV1 {
  transcriptId: string;
  producerRefs: string[];
  consumerRefs: string[];
  producerSequence: number;
  consumerSequence: number;
}

export interface PreReviewBindingProofV1 {
  bindingId: string;
  positiveAssertionIds: string[];
  mutationProofs: PreReviewMutationProofV1[];
  transcriptProofs: PreReviewTranscriptProofV1[];
}

/** Compact, canonical machine record: id, kind, target, mutationKind, operation,
 * expected, observed, controlRestored, ordered producer/consumer events, and
 * the exact topology assertion sourceRef. */
export type PreReviewCaseRecordV1 = [
  id: string,
  kind: 'positive' | 'mutation' | 'transcript',
  target: string,
  mutationKind: string,
  operation: string,
  expectedCode: string,
  observedCode: string,
  controlRestored: boolean,
  events: Array<[event: string, sequence: number]>,
  assertionSourceRef: string,
];

export interface PreReviewExecutableProvenanceV1 {
  runnerPath: string;
  runnerDigest: string;
  targetPath: string;
  targetDigest: string;
  buildCommand: string;
}

export interface PreReviewExecutableProofV1 {
  schemaVersion: 'proofstory.pre_review_executable_proof.v1';
  storyId: string;
  producer: 'registered-verification-command';
  verifier: 'pre-review-check-command-runner';
  commandDigests: string[];
  caseRecordsEncoding: 'gzip-base64';
  caseRecords: string;
  provenance: PreReviewExecutableProvenanceV1;
  bindingProofs: PreReviewBindingProofV1[];
}

export interface PreReviewEvidenceRefV1 {
  intentRef: string;
  itemId: string;
  evidenceIndex: number;
  kind: VerificationEvidenceKind;
  evidenceDigest: string;
}

export interface PreReviewCheckArtifactV1 {
  schemaVersion: 'proofstory.pre_review_check.v1';
  storyId: string;
  mode: 'observe' | 'warn' | 'enforce';
  cutoffAt: string;
  planBasisDigest: string;
  preReviewBasisArtifact: AcceptanceBasisArtifactV1;
  topologyDigest: string;
  scopeCheckDigest: string;
  scopeContractDigest?: string;
  storyFilesHash: string;
  closureFilesHash: string;
  evidenceRefs: PreReviewEvidenceRefV1[];
  executableProof: PreReviewExecutableProofV1;
  criticReceiptDigest?: string;
  codes: PreReviewCheckCodeV1[];
  status: 'pass' | 'fail' | 'inconclusive';
  issuedAt: string;
  signerPublicKey: string;
  signature: string;
}

export type AcceptanceRolloutClaimClassV1 =
  | 'user_visible'
  | 'orchestration'
  | 'behavior'
  | 'lifecycle'
  | 'proof'
  | 'safety'
  | 'docs_only'
  | 'legacy'
  | 'ordinary';

export type AcceptanceRolloutDefectClassV1 =
  | 'omission'
  | 'forgery'
  | 'freshness'
  | 'authority'
  | 'quorum'
  | 'threshold'
  | 'control';

export interface AcceptanceRolloutGateArtifactV1 {
  schemaVersion: 'proofstory.acceptance_rollout_gate_artifact.v1';
  command: 'acceptance_topology_check' | 'pre_review_check';
  storyId: string;
  pairId: string;
  arm: 'baseline' | 'candidate';
  report: Record<string, unknown>;
  artifactDigest: string;
}

export interface AcceptanceRolloutHostVerdictReceiptV1 {
  type: 'host_verdict';
  verdictId: string;
  runId: string;
  hostId: 'codex-cli' | 'claude-cli';
  provider: 'codex' | 'claude';
  sessionId: string;
  keyId: string;
  decision: 'pass' | 'fail' | 'blocked';
  materialDigest: string;
  storyFilesHash: string;
  validationDigest: string;
  promptDigest: string;
  timestamp: string;
}

export interface AcceptanceRolloutObservationReceiptV1 {
  schemaVersion: 'proofstory.acceptance_rollout_observation_receipt.v1';
  storyId: string;
  pairId: string;
  arm: 'baseline' | 'candidate';
  gateArtifacts: AcceptanceRolloutGateArtifactV1[];
  hostVerdicts: AcceptanceRolloutHostVerdictReceiptV1[];
  quorumReceipt: {
    schemaVersion: 'lattice.quorum_submit.v1';
    storyId: string;
    rounds: number;
    emittedCount: number;
    verdictIds: string[];
    runIds: string[];
    metadataCommitSha: string;
    reviewerPasses: Array<{ lane: string; passId: string; reviewRunId?: string }>;
    assuranceLevel: 'full-3x2' | 'degraded-single-host' | 'ordinary-review';
  };
  reviewRoundIds: string[];
  waiverRefs: string[];
  usageEvents: Array<{ eventId: string; costUnits: number }>;
  transcriptRefs: string[];
  mutationResults: Array<{
    mutationId: string;
    expectedCode: string;
    observedCode: string;
    mutationCommitSha: string;
    restorationCommitSha: string;
    controlRestored: boolean;
  }>;
  checkInventory: string[];
  issuedAt: string;
  issuerKeyId: string;
  signerPublicKey: string;
  signature: string;
}

export interface AcceptanceRolloutSourceRecordV1 {
  schemaVersion: 'proofstory.acceptance_rollout_source_record.v1';
  pairId: string;
  arm: 'baseline' | 'candidate';
  storyId: string;
  completedAt: string;
  comparableGroup: 'high_assurance';
  eligible: boolean;
  claimClass: AcceptanceRolloutClaimClassV1;
  seededDefectId?: string;
  defectClass: AcceptanceRolloutDefectClassV1;
  defectPresent: boolean;
  shouldBlock: boolean;
  observationReceipt: AcceptanceRolloutObservationReceiptV1;
  sourceDigest: string;
}

export interface AcceptanceRolloutCohortInputV1 {
  schemaVersion: 'proofstory.acceptance_rollout_cohort_input.v1';
  generatedBy: 'runProofStoryAcceptanceRolloutCohort';
  evaluationWindow: { start: string; end: string };
  eligibilityRuleVersion: 'proofstory.acceptance_rollout_eligibility.v1';
  thresholdVersion: 'proofstory.acceptance_rollout_thresholds.v1';
  registeredSeedIds: string[];
  sourceRecords: AcceptanceRolloutSourceRecordV1[];
  sourceInventoryDigest: string;
  runnerPath: 'scripts/run-proofstory-acceptance-rollout-cohort.mjs';
  runnerDigest: string;
}

export type AcceptanceRolloutDiagnosticCodeV1 =
  | 'AR_REPORT_MISSING'
  | 'AR_REPORT_TAMPERED'
  | 'AR_REPORT_STALE'
  | 'AR_WINDOW_INVALID'
  | 'AR_SOURCE_RECORD_INVALID'
  | 'AR_SOURCE_EVIDENCE_INVALID'
  | 'AR_MEMBERSHIP_DIGEST_MISMATCH'
  | 'AR_ELIGIBLE_MEMBERSHIP_INCOMPLETE'
  | 'AR_INELIGIBLE_MEMBER'
  | 'AR_SAMPLE_COUNT_LT_3'
  | 'AR_MATCHED_PAIR_MISSING'
  | 'AR_ADAPTER_UNSUPPORTED'
  | 'AR_TRANSCRIPT_REQUIRED'
  | 'AR_MUTATION_REQUIRED'
  | 'AR_REGISTERED_CAMPAIGN_INCOMPLETE'
  | 'AR_FALSE_PASS_NONZERO'
  | 'AR_OMISSION_DETECTION_BELOW_100'
  | 'AR_FALSE_BLOCK_NONZERO'
  | 'AR_MISLABELED_3X1_NONZERO'
  | 'AR_WAIVER_DELTA_POSITIVE'
  | 'AR_CHECK_INVENTORY_SHRANK'
  | 'AR_QUORUM_NOT_FULL_3X2';

export interface AcceptanceRolloutMetricsV1 {
  matchedPairCount: number;
  baselineSampleCount: number;
  candidateSampleCount: number;
  registeredSeedCount: number;
  detectedSeedCount: number;
  falsePassCount: number;
  omissionSeedCount: number;
  omissionDetectedCount: number;
  omissionDetectionRate: number;
  falseBlockCount: number;
  falseBlockRate: number;
  mislabeled3x1Count: number;
  waiverDelta: number;
  inventoryShrankCount: number;
  baselineReviewRounds: number;
  candidateReviewRounds: number;
  baselineCostUnits: number;
  candidateCostUnits: number;
}

export interface AcceptanceRolloutReportV1 {
  schemaVersion: 'proofstory.acceptance_rollout_report.v1';
  storyId: string;
  projectPolicy: 'flat-project';
  eligibilityRuleVersion: 'proofstory.acceptance_rollout_eligibility.v1';
  thresholdVersion: 'proofstory.acceptance_rollout_thresholds.v1';
  evaluationWindow: { start: string; end: string };
  eligibleMembership: Array<{ pairId: string; baselineStoryId: string; candidateStoryId: string }>;
  membershipDigest: string;
  sourceInventoryDigest: string;
  registeredSeedIds: string[];
  sourceRecords: AcceptanceRolloutSourceRecordV1[];
  metrics: AcceptanceRolloutMetricsV1;
  diagnostics: AcceptanceRolloutDiagnosticCodeV1[];
  verdict: 'pass' | 'fail';
  binding: {
    headHash: string;
    materialHash: string;
    storyFilesHash: string;
    runnerDigest: string;
  };
  reportDigest: string;
}

export interface AcceptanceRolloutReceiptV1 {
  schemaVersion: 'proofstory.acceptance_rollout_receipt.v1';
  receiptRef: string;
  issuer: 'acceptance-rollout-verifier';
  issuerKeyId: string;
  signerPublicKey: string;
  storyId: string;
  reportDigest: string;
  membershipDigest: string;
  sourceInventoryDigest: string;
  verdict: 'pass' | 'fail';
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  issuedAt: string;
  signature: string;
}

export interface AcceptanceRolloutArtifactV1 {
  schemaVersion: 'proofstory.acceptance_rollout_artifact.v1';
  report: AcceptanceRolloutReportV1;
  receipt: AcceptanceRolloutReceiptV1;
}

export interface TopologyActorProvenanceV1 {
  agentId: string;
  sessionId: string;
  dispatchId: string;
  storyId: string;
  headHash: string;
  storyFilesHash: string;
  businessCommit: string;
  businessCommitAuthor: string;
  businessCommitAuthorSource: 'git-var:GIT_AUTHOR_IDENT' | 'git-log:commit-author';
  businessIdentity: string;
}

export interface TopologyImplementationProvenanceV1 extends TopologyActorProvenanceV1 {}

export interface TopologyExclusionApprovalV1 {
  schemaVersion: 'proofstory.topology_exclusion_approval.v1';
  approvalRef: string;
  storyId: string;
  exclusionRef: string;
  scopeRef: string;
  approverIdentity: string;
  approverRole: 'proof-or-stop-review-scope-plan' | 'lattice-review-scope-plan';
  approverProvenance: TopologyActorProvenanceV1;
  implementationProvenance: TopologyImplementationProvenanceV1;
  basisDigest: string;
  topologyDigest: string;
  scopeCheckDigest: string;
  scopeContractDigest?: string;
  storyFilesHash: string;
  closureFilesHash: string;
  issuedAt: string;
  signerPublicKey: string;
  signature: string;
}

export interface TopologyExclusionApprovalsDataV1 {
  schemaVersion: 'proofstory.topology_exclusion_approvals.v1';
  storyId: string;
  approvals: TopologyExclusionApprovalV1[];
}

export interface TopologyCriticReceiptV1 {
  schemaVersion: 'proofstory.topology_critic_receipt.v1';
  storyId: string;
  criticIdentity: string;
  criticRole: 'proof-or-stop-review-topology-critic' | 'lattice-review-topology-critic';
  criticProvenance: TopologyActorProvenanceV1;
  implementationProvenance: TopologyImplementationProvenanceV1;
  basisDigest: string;
  topologyDigest: string;
  scopeCheckDigest: string;
  scopeContractDigest?: string;
  storyFilesHash: string;
  closureFilesHash: string;
  findingRefs: string[];
  approvedExclusionRefs: string[];
  verdict: 'pass' | 'request_changes';
  issuedAt: string;
  signerPublicKey: string;
  signature: string;
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

/**
 * B-ec67: tool-owned execution receipt. Stamped by the evidence-write handler when
 * it runs the intent's pinned command, so a reviewer/gate reads the ACTUAL exit +
 * output digest instead of a caller-authored prose number.
 */
export interface VerificationExecutionReceipt {
  /** Real exit code of the pinned command. */
  exitCode: number;
  /** sha256 of the full captured stdout+stderr. */
  outputDigest: string;
  /** Bounded tail of the captured output for human inspection. */
  outputTail: string;
  /** Whether the pinned selector string appeared in the captured output. */
  selectorMatched: boolean;
  /**
   * B-1482: the pinned selector text this run was ACTUALLY judged against, stamped
   * beside {@link selectorMatched} so the receipt answers "which selector?" on its own
   * — without re-reading the (mutable-by-re-pin) intent pin. Auditing whether a receipt
   * was discriminating at all, and proving one selector is strictly narrower than
   * another, both need the selector recorded ON the receipt at execution time.
   *
   * Like the timeout block below this lives inside the TOOL-OWNED receipt, which every
   * caller-facing schema strips, so a caller can never inject a selector the command
   * was not judged by.
   *
   * Optional because receipts written BEFORE B-1482 genuinely lack it; absent means
   * "unknown, not re-derivable", never "no selector". Never back-fill it from the
   * current pin — a later re-pin would silently rewrite history.
   */
  selector?: string;
  /** ISO timestamp when the command was executed. */
  executedAt: string;
  /**
   * B-cdf6 (B-META F-012): the wall-clock ceiling the run was actually armed with, in ms.
   * Always stamped so a reviewer can see the budget the receipt was earned under.
   */
  timeoutMs?: number;
  /**
   * B-cdf6 (B-META F-012): present ONLY when the caller RAISED the per-command ceiling
   * above the {@link DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS} default via
   * `commandTimeoutMs` + `commandTimeoutReason`. A raised budget is an exceptional act,
   * so it must explain itself and stay gate-visible: this block lives inside the
   * TOOL-OWNED receipt (which every caller-facing schema strips), so it can never be
   * caller-injected onto a receipt that was actually earned under the default.
   */
  timeoutOverride?: {
    /** The raised ceiling in ms, as effectively armed. */
    timeoutMs: number;
    /** The default ceiling this run was raised ABOVE, for a reviewer's reference. */
    defaultTimeoutMs: number;
    /** Attributable ≥ 30-char justification for raising the budget. */
    reason: string;
  };
  /** B-5a15: canonical CausalEvidence provenance (legacy receipts omit these). */
  executionKey?: string;
  causalReceiptHash?: string;
  commandReruns?: 0;
}

export interface VerificationEvidence {
  /** Reference like CHK-001:happy:0 or a custom VerificationIntentItem.id. */
  intentRef: string;
  kind: VerificationEvidenceKind;
  /** Human-facing classification; does not override result/pass/fail gate semantics. */
  verdict?: VerificationEvidenceVerdict;
  /**
   * B-ec67: true when this evidence is a tool-executed receipt (the write handler ran
   * the pinned command and derived `result` from the actual exit + selector match);
   * false when it is a non-mechanical attestation (manual|docs intent, or an explicit
   * audited escape). Undefined on legacy evidence written before B-ec67 (grandfathered).
   */
  mechanical?: boolean;
  /** B-ec67: tool-owned execution receipt, present only when mechanical === true. */
  receipt?: VerificationExecutionReceipt;
  /**
   * B-ec67: attributable, gate-visible reason recorded when an executable intent is
   * deliberately covered by a non-mechanical attestation via the audited escape path
   * (execution impossible in this environment). Never grants coverage — the gate still
   * demotes non-mechanical evidence on executable intents.
   */
  nonMechanicalReason?: string;
  /** Deferred waivers are temporary gate-self-test receipts and must be replaced by real evidence before TEST. */
  waiverType?: 'permanent' | 'deferred_gate_evidence';
  file?: string;
  command?: string;
  /**
   * B-a745 CHK-002: OPTIONAL stable id of the validation command this evidence
   * pins (`core/validation-command-identity.ts`).
   *
   * New evidence should record it. Historical evidence has only the free-form
   * `command` string above, which the canonical legacy pin resolver normalizes
   * and matches on the complete executable tuple. A resolved id is written by a
   * future re-record only: the resolver never rewrites historical evidence in
   * place merely to migrate it.
   */
  commandId?: string;
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

/**
 * B-2296 (evidence-integrity §5 follow-on, Phase 1): the immutable snapshot pinned
 * onto a frozen claim (a checklist item's `userSees`) at attestation time. Drift in
 * EITHER the normalized claim text OR the bound material voids the attestation and
 * requires re-attestation (bidirectional binding, per decision.json).
 *
 * IMPORTANT — material binding authority (decision B: storyFilesHash):
 *   `storyFilesHash` is the DRIFT-AUTHORITATIVE material field. It scopes drift to
 *   exactly the files this story delivers (excluding unrelated main-merge / whole-tree
 *   churn — the dominant false-positive source). `materialHash` is retained for
 *   provenance/diagnostics ONLY and is INFORMATIONAL; it MUST NOT be the drift signal.
 */
export interface FrozenClaimSnapshot {
  /** sha256 hex over normalizeClaim(userSees) — see core/frozen-claim-drift.ts. */
  normalizedClaimDigest: string;
  /** Drift-authoritative: hash of story-owned material files vs merge-base main. */
  storyFilesHash: string;
  /** git HEAD captured when the snapshot was taken. */
  headHash: string;
  /** ISO 8601 timestamp when the snapshot was pinned. */
  attestedAt: string;
  /** Informational only (whole-tree material). NOT the drift signal (decision B). */
  materialHash?: string;
}

/**
 * B-2296 (Phase 1): structured, NON-blocking advisory emitted when a frozen claim
 * has drifted relative to its {@link FrozenClaimSnapshot}. Defined here ahead of its
 * CHK-002 (detect) / CHK-003 (surface) consumers.
 *
 * `driftKind` reports WHAT moved: `claim` (normalized digest changed), `material`
 * (story-owned storyFilesHash moved), `both`, or `none`. `classification`
 * distinguishes a snapshot-bound claim (`bound`) from a pre-feature claim with no
 * snapshot (`legacy-unbound`, never an error — grandfathered). Phase 1 only ever
 * asks for `re_attestation`; the blocking gate is Phase 2.
 */
export interface FrozenClaimDriftAdvisory {
  code: 'FROZEN_CLAIM_DRIFT';
  itemId: string;
  claimRef: string;
  previousDigest: string;
  currentDigest: string;
  previousStoryFilesHash: string;
  currentStoryFilesHash: string;
  driftKind: 'claim' | 'material' | 'both' | 'none';
  classification: 'bound' | 'legacy-unbound';
  actionRequired: 're_attestation';
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
  /**
   * B-2296 (evidence-integrity §5 follow-on, Phase 1): immutable frozen-claim
   * snapshot pinned onto this item's `userSees` at attestation time (the
   * checklist_update status→done transition). Written exactly once, when the
   * item first transitions to done with a non-empty userSees and no prior
   * snapshot; NEVER re-taken on a read or a later re-persist (B-ec67 pin-once
   * model). Absent on legacy items and on items with an empty/absent userSees —
   * detectDrift classifies a missing snapshot as `legacy-unbound` (never an error).
   */
  userSeesSnapshot?: FrozenClaimSnapshot;
  /** @deprecated Legacy item phase from TEST_CASE lifecycle. New flow uses DEV/REVIEW/TEST only. */
  phase?: 'DEV' | 'TEST_CASE';
  /** @deprecated Legacy testIntent kept for old story data and compatibility helpers. */
  testIntent?: TestIntent | null;
  status: ChecklistStatus;
  /**
   * B-1909: when status==='withdrawn', the decisionId of the confirmed +
   * userConfirmed scope-shrinkage decision that authorized the withdrawal.
   * Stamped exclusively by scope_shrinkage_decision_set (the sole applier);
   * absent on every non-withdrawn item and on all legacy data.
   */
  decisionRef?: string;
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
  /** Real-machine verification coverage: auto-scaffolded by proofOrStop, agent fills skipReasons only */
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

/** Finding: a finding raised by a proof-or-stop reviewer (replaces testIntent) */
export interface Finding {
  id: string;            // format B-xxx:F-001
  /**
   * Collision-resistant immutable persistence identity. Legacy Findings omit
   * this field and remain byte-preserved; their binding is appended to the
   * separate Finding ledger on first mediated read/backfill.
   */
  recordId?: string;
  /** CHK-002 durable commit acknowledgement; not the signed CHK-003 receipt. */
  ledgerCommitReceiptId?: string;
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
  /** Signed self-reported reviewer read coverage when supplied by reviewer evidence. */
  readManifest?: ReviewerReadManifest;
  /** Signed mechanical reviewer read-log summary when read events/log input was supplied. */
  readLog?: ReviewerReadLogEvidence;
  /** Signed diagnostics comparing readManifest to the mechanical read log. */
  readDiagnostics?: ReviewerReadDiagnostic[];
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
  /** Signed whole-artifact binding written only by the official gap_log path. */
  gapLogBinding?: GapLogProvenanceBinding;
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

export interface GapLogProvenanceBinding {
  schemaVersion: 'lattice.gap-log-provenance.v1';
  command: 'gap_log';
  storyId: 'B-META-framework-audit';
  artifactPath: string;
  findingId: string;
  contentDigest: string;
  createdAt: string;
}

export interface FindingData {
  findings: Finding[];
}

/**
 * Minimal CHK-002 transaction result exposed to existing Finding callers.
 * The signed FindingLedgerReceipt contract is deliberately deferred to CHK-003.
 */
export interface FindingLedgerCommitRef {
  recordIds: string[];
  receiptId: string;
  priorLedgerDigest: string;
  committedLedgerDigest: string;
  replayed: boolean;
}

/**
 * Signed acknowledgement for one durable Finding-ledger transaction.
 *
 * This is deliberately a persistence fact, not a Finding/route/assessment
 * verdict. Consumers must still verify the exact referenced records and their
 * own predicate before assigning semantic authority.
 */
export type FindingLedgerOperation =
  | 'append_finding'
  | 'append_finding_projection'
  | 'append_finding_lifecycle_transition'
  | 'append_legacy_identity_binding'
  | 'append_detector_signal'
  | 'append_candidate_route'
  | 'append_candidate'
  | 'append_assessment_proposal'
  | 'append_assessment'
  | 'append_mandatory_repair'
  | 'append_deferral_expiry_policy'
  | 'append_deferral'
  | 'append_route_receipt'
  | 'append_progress_baseline_set'
  | 'append_material_drift_reattestation'
  | 'append_runtime_receipt'
  | 'append_canonical_defect_supersession'
  | 'append_canonical_defect'
  | 'append_supersession'
  | 'apply_manifest';

/**
 * Immutable terminal-state fact for a Finding. The original `finding` record
 * never changes; resolve/dismiss append one of these records and readers fold
 * the ledger in order to obtain the current projection.
 */
export interface FindingLifecycleTransition {
  schemaVersion: 1;
  transitionId: string;
  findingId: string;
  findingRecordId: string;
  fromStatus: 'open';
  toStatus: 'resolved' | 'dismissed';
  at: string;
  reason?: string;
  resolutionType?: Finding['resolutionType'];
  resolveEvidenceStrength?: Finding['resolveEvidenceStrength'];
  dismissReasonType?: Finding['dismissReasonType'];
  dismissEvidenceStrength?: Finding['dismissEvidenceStrength'];
}

export interface FindingLedgerCasBinding {
  recordType: string;
  expectedRecordId: string;
  expectedRecordHash: string;
  observedChainHeadId: string;
  observedChainHeadHash: string;
  predicateDigest: string;
}

export interface FindingLedgerReceipt {
  schemaVersion: 1;
  ledgerSchemaEpoch: number;
  minimumWriterCapability: string;
  receiptId: string;
  storyId: string;
  idempotencyKey: string;
  /** Canonical digest of every semantic append input; required for safe replay. */
  exactRequestDigest?: string;
  operation: FindingLedgerOperation;
  recordIds: string[];
  casBindings: FindingLedgerCasBinding[];
  priorLedgerDigest: string;
  committedLedgerDigest: string;
  replayed: boolean;
  committedAt: string;
  writerSessionId: string;
  writerLeaseId: string;
  writerFenceToken: string;
  keyId: string;
  algorithm: string;
  trustRootDigest: string;
  keyFreshnessPolicyDigest: string;
  receiptHash: string;
  signature: string;
}

// Story 3B runtime receipts are persistence/freshness facts only. This shared
// type surface is their canonical schema; the executable runtime module imports
// and re-exports these types without defining a second copy.
export type RuntimeEvidenceContentType =
  | 'command'
  | 'stdout'
  | 'stderr'
  | 'environment'
  | 'artifact_manifest';

export interface EvidenceBlobRef {
  blobId: string;
  contentDigest: string;
  contentType: RuntimeEvidenceContentType;
  redactionPolicyDigest: string;
}

export interface RuntimeEvidenceReceipt {
  schemaVersion: 1;
  receiptId: string;
  storyId: string;
  headHash: string;
  sourceMaterialHash: string;
  buildPolicyDigest: string;
  buildCommandDigest: string;
  executionCommandDigest: string;
  buildCommand: EvidenceBlobRef;
  executionCommand: EvidenceBlobRef;
  stdout: EvidenceBlobRef;
  stderr: EvidenceBlobRef;
  environment: EvidenceBlobRef & { allowlistPolicyDigest: string; excludedVariableNames: string[] };
  artifactManifest: EvidenceBlobRef;
  artifacts: Array<{ path: string; digest: string; sourceHead: string; realpathPolicyDigest: string }>;
  startedAt: string;
  completedAt: string;
  exitCode: number;
  stdoutDigest: string;
  stderrDigest: string;
  environmentDigest: string;
  toolchain: { compilerVersion: string; runtimeVersion: string; toolchainDigest: string };
  commandCanonicalizationPolicyDigest: string;
  producer: string;
  keyId: string;
  algorithm: string;
  trustRootDigest: string;
  keyFreshnessPolicyDigest: string;
  receiptHash: string;
  signature: string;
}

export type {
  RuntimeEvidenceRefusalCode,
  RuntimeEvidenceVerification,
  RuntimeReceiptSigner,
  RuntimeReceiptTrust,
} from './runtime-evidence-receipt.js';

export interface ReviewerReadManifest {
  filesReadFully: string[];
  filesTriagedByName: string[];
  scanEscalationReason: string | null;
  candidateSpecSetDigest?: string;
  corpusDigest?: string;
}

export interface ReviewerReadLogEvent {
  path: string;
  mode: 'full' | 'triage';
  tokenCount: number | null;
  agent?: string;
}

export interface ReviewerReadLogSummary {
  readCount: number;
  tokenCount: number | null;
}

export interface ReviewerReadLogEvidence {
  filesReadFully: string[];
  filesTriagedByName: string[];
  summary: ReviewerReadLogSummary;
  digest: string;
}

export type ReviewerReadDiagnosticCode =
  | 'read_manifest_missing_full_read'
  | 'read_manifest_extra_full_read'
  | 'read_manifest_missing_triage'
  | 'read_manifest_extra_triage'
  | 'full_scan_without_scanEscalationReason';

export interface ReviewerReadDiagnostic {
  code: ReviewerReadDiagnosticCode;
  severity: 'finding';
  message: string;
  path?: string;
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
  /** New-format pass must equal the envelopeId signed by its ReviewRun. */
  envelopeId?: string;
  /** Signed self-reported reviewer read coverage. Missing only on legacy passes. */
  readManifest?: ReviewerReadManifest;
  /** Signed mechanical reviewer read-log summary when read events/log input was supplied. */
  readLog?: ReviewerReadLogEvidence;
  /** Signed diagnostics comparing readManifest to the mechanical read log. */
  readDiagnostics?: ReviewerReadDiagnostic[];
  /**
   * B-3b05: session id of the process that wrote this pass, resolved by
   * getSessionIdentity() at write time. Part of the versioned signature domain:
   * records carrying writerSessionId verify ONLY via the provenance-inclusive
   * domain (no legacy fallback); records without it (pre-B-3b05 history) verify
   * via the legacy domains. Coordination-level identity, not cryptographic.
   */
  writerSessionId?: string;
  /**
   * B-3b05: how writerSessionId was identified (explicit-env / host-adapter /
   * generated-token / derived-ppid). Signed alongside writerSessionId so an
   * explicit-env spoof stays a visible, audit-distinguishable claim.
   */
  sessionSource?: string;
  /**
   * B-3b05: audit-only flag — the writer session equals the story owner lease
   * session at write time (subagent-or-self; not mechanically distinguishable
   * per EXP-001/B-e71f). NOT consumed by any blocking gate. Signed into the
   * provenance-inclusive domain (F-002): adding, stripping, or flipping the
   * flag on an already-signed record breaks verification (absent ≡ '' in the
   * signed payload).
   */
  provenanceFlag?: 'same_session_write';
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
  /** Content-addressed full Prompt Envelope; absent only for bounded legacy-full-context history/rollback. */
  envelopeId?: string;
  /**
   * Exact bytes delivered by review_run_start in full-envelope mode. The
   * domain-separated digest is promptHash and is also bound by envelopeId.
   */
  assembledPrompt?: string;
  /** Reviewer-authored reason that forced this otherwise eligible run to full context. */
  reviewerEscalationReason?: string;
  /** Explicit critic purpose; absent retains historical/default topology semantics. */
  reviewPurpose?: 'topology' | 'inventory-completeness';
  inventoryBinding?: ReviewInventoryPurposeBinding;
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

export type ReviewInventoryEpochState = 'OPEN' | 'FINALIZED' | 'INVALIDATED' | 'CANCELLED';

export interface ReviewInventoryLaneTerminal {
  lane: string;
  reviewRunId: string;
  terminal: 'pass' | 'finding';
  hostIdentity: string;
  promptIdentity: string;
  evidenceIds: string[];
  coverageDigest: string;
}

export interface ReviewInventoryWave {
  wave: number;
  startedAt: string;
  completedAt?: string;
  lanes: ReviewInventoryLaneTerminal[];
  verifiedFindingFamilies: string[];
  verifiedFindingSetDigest?: string;
  newVerifiedFindingCount?: number;
  criticDigest?: string;
  saturated?: boolean;
  /** Highest numeric ReviewRun id already existing when this checkpoint sealed the wave. */
  nextRunSequenceBoundary?: number;
}

/** Signed frozen-candidate inventory fact. It never certifies remediated material. */
export interface ReviewInventoryEpoch {
  schemaVersion: 'proofbound.review_inventory_epoch.v1';
  epochId: string;
  storyId: string;
  reviewRound: string;
  state: ReviewInventoryEpochState;
  begunAt: string;
  updatedAt: string;
  cutoff: { headHash: string; materialHash: string; storyFilesHash?: string };
  /** Frozen REVIEW acceptance subject (scope contract + complete checklist semantics). */
  scopeDigest: string;
  /** Frozen signed candidate-routing universe, when routing exists at epoch begin. */
  candidateSpecSetDigest?: string;
  corpusDigest?: string;
  requiredLanes: string[];
  /** Highest numeric ReviewRun id existing at begin; current-wave runs must be strictly newer. */
  initialRunSequenceBoundary?: number;
  /** Signed snapshot of open verified findings from current-cutoff/current-round runs that predate begunAt. */
  baselineFindingIds?: string[];
  maxWaves: number;
  waves: ReviewInventoryWave[];
  invalidation?: {
    detectedAt: string;
    oldMaterialHash: string;
    currentMaterialHash: string;
    oldStoryFilesHash?: string;
    currentStoryFilesHash?: string;
    blockerCode:
      | 'OPEN_REVIEW_INVENTORY_MATERIAL_MUTATION'
      | 'OPEN_REVIEW_INVENTORY_SCOPE_MUTATION'
      | 'OPEN_REVIEW_INVENTORY_CANDIDATE_ROUTING_MUTATION'
      | 'OPEN_REVIEW_INVENTORY_INVALID_CANDIDATE_ARTIFACT';
    oldScopeDigest?: string;
    currentScopeDigest?: string;
    oldRequiredLanes?: string[];
    currentRequiredLanes?: string[];
    oldCandidateSpecSetDigest?: string;
    currentCandidateSpecSetDigest?: string;
    oldCorpusDigest?: string;
    currentCorpusDigest?: string;
  };
  cancelledAt?: string;
  cancelReason?: string;
  /** Highest ReviewRun sequence existing when CANCELLED/INVALIDATED became terminal. */
  terminalRunSequenceBoundary?: number;
  receiptId?: string;
  consumedAt?: string;
  consumedByReviewRound?: string;
  _hash: string;
}

export interface ReviewInventoryReceipt {
  schemaVersion: 'proofbound.review_inventory_receipt.v1';
  receiptId: string;
  epochId: string;
  storyId: string;
  reviewRound: string;
  cutoff: { headHash: string; materialHash: string; storyFilesHash?: string };
  scopeDigest: string;
  requiredLanes: string[];
  waveCount: number;
  findingSetDigest: string;
  coverageDigest: string;
  saturationResult: 'ZERO_NEW_VERIFIED_FINDINGS';
  authority: 'inventory-completeness-only';
  authorizesTest: false;
  issuedAt: string;
  consumedAt?: string;
  /** Signed revocation of an unconsumed receipt; revoked receipts never grant remediation authority. */
  invalidatedAt?: string;
  invalidationReason?: string;
  _hash: string;
}

export interface ReviewInventoryPurposeBinding {
  storyId: string;
  epochId: string;
  reviewRound: string;
  wave: number;
  cutoff: { headHash: string; materialHash: string; storyFilesHash?: string };
  scopeDigest: string;
  requiredLanesDigest: string;
  runSequenceBoundary: number;
}

export interface ReviewInventoryCriticReceipt {
  schemaVersion: 'proofbound.review_inventory_critic_receipt.v1';
  criticReceiptId: string;
  epochId: string;
  storyId: string;
  reviewRound: string;
  wave: number;
  cutoff: { headHash: string; materialHash: string; storyFilesHash?: string };
  aggregateFindingSetDigest: string;
  requiredLaneCoverageDigest: string;
  criticLane: 'proof-or-stop-review-topology-critic' | 'lattice-review-topology-critic';
  reviewRunId: string;
  reviewPurpose?: 'inventory-completeness';
  inventoryBinding?: ReviewInventoryPurposeBinding;
  terminalEvidenceIds: string[];
  readEvidenceDigest: string;
  findingDispositions: ReviewInventoryFindingDisposition[];
  createdAt: string;
  _hash: string;
}

export interface ReviewInventoryFindingDisposition {
  findingId: string;
  disposition: 'verified_family' | 'duplicate' | 'not_verified';
  familyKey?: string;
  canonicalFindingId?: string;
  reason: string;
}

export interface ReviewInventoryEpochData {
  schemaVersion: 'proofbound.review_inventory_epochs.v1';
  epochs: ReviewInventoryEpoch[];
  receipts: ReviewInventoryReceipt[];
  criticReceipts: ReviewInventoryCriticReceipt[];
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
export type TestFailureKind = 'validation_failure' | 'infra_failure';

export interface TestEvidenceData {
  /** command of the last test run */
  command: string;
  /** output of the last test run */
  output: string;
  /** PASS / FAIL */
  result: TestResult;
  /** Distinguishes ordinary validation/test failures from runner infrastructure failures. */
  failureKind?: TestFailureKind;
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
  /** non-Proof-or-Stop metadata file tree hash at test time (metadata-only commits should not make evidence stale) */
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
  /** Versioned identity of the commands and policy inputs used by routine validate. */
  routineValidationIdentity?: RoutineValidationIdentity;
  /** Project command truth, intentionally independent from overall verification coverage. */
  commandExecution?: RoutineValidationCommandExecution;
  /** Whether this canonical receipt came from command execution or a validated zero-command reuse. */
  disposition?: 'executed' | 'reused';
}

export interface VerificationCoverageEntry {
  intentRef: string;
  itemId: string;
  lane: VerificationLane;
  desc: string;
  type: VerificationIntentType;
  priority: VerificationPriority;
  /**
   * B-ec67: `non_mechanical` — an executable intent (logic|cli|browser) whose evidence
   * is an explicit non-mechanical attestation (mechanical === false). It is NOT covered:
   * only an executed receipt (or grandfathered legacy evidence) covers an executable intent.
   */
  status: 'covered' | 'missing' | 'failed' | 'waived' | 'deferred' | 'stale' | 'weak' | 'non_mechanical';
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
 * CausalEvidence receipts are defined with the execution service so their
 * canonical digest helpers stay beside the schema. Re-exporting the shared
 * receipt type here keeps the project-wide core type surface available to
 * stores and handlers without duplicating a mutable receipt shape.
 */
export type { CausalEvidenceReceipt } from './causal-evidence.js';

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
  | 'review_host_availability_probe'
  | 'review_escalation_policy'
  | 'review_escalation_fallback'
  | 'legacy_authority_receipt'
  | 'decision_doc_proposal'
  | 'decision_doc_save'
  | 'auxiliary_worktree_cleanup'
  // B-6bfd CHK-004: Proof-or-Stop-managed guard session projection lifecycle events.
  | 'guard_session_start'
  | 'guard_session_check'
  | 'phase_transition'
  | 'human_confirmation'
  // B-956f: language-neutral degradation signal — a material-code diff in a
  // language without semantic anchors (non-TS/JS) surfaced by the mutating
  // scope-transition validation caller (deduped per extension).
  | 'semantic_analysis_unavailable'
  | 'validation_terminal';

export type ProcessEvent = {
  type: ProcessEventType;
  timestamp: string;
  [key: string]: unknown;
};

// ── Scope Check (B-d4d1: signed scope-check.json written by proof-or-stop-review-scope-plan agent) ──
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
  /** Signed self-reported reviewer read coverage. Missing only on legacy scope checks. */
  readManifest?: ReviewerReadManifest;
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
   * contradictions/questions that are "seen but not classified". Main agent must use `proof-or-stop scope_question_resolve`
   * to resolve them in writing (prevents self-absolution); the PLAN gate blocks unresolved OQs.
   * Signature domain excludes this field (resolution is a main agent action, not part of reviewer signature _hash).
   */
  openQuestions?: OpenQuestion[];
  reviewRound?: string;
  _hash: string;
}

// ── Init Check (B-e71f: signed init-check.json written by proof-or-stop-review-story-init agent) ──
// INIT → INIT_CHECK hard gate artifact. Written by reviewer subagent after reviewing background.md + initial checklist.
// The signed components are declared, once, by INIT_CHECK_SIGNATURE_DOMAIN in core/init-check-gate.ts —
// consult that declaration rather than any restatement of it (B-8df9 CHK-002 widened the domain and every
// hand-written copy of the old list was wrong the moment it did).
// After any signed component is modified, _hash mismatches → story_advance INIT_CHECK
// reports init_check_tampered blocker (CHK-005 / CHK-006).
// agentId field is reviewer's self-reported id, **for audit traceability only** (EXP-001 disproved mechanical verifiability of agentId, see
// docs/story/actives/B-e71f/experiments/exp-001.md), and is not a gate decision input on its own; when `agentResults`
// is absent it is one of the inputs the gate's decision array is synthesized from, and is bound through that value.
// issues DO gate: blockingInitCheckIssues treats critical / high as blockers of INIT_CHECK advancement
// (a reviewer that records one self-blocks); medium / low are advisory and only echoed after the advance.

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
   * List of issues raised by the reviewer. critical / high BLOCK the INIT_CHECK advance
   * (blockingInitCheckIssues); medium / low are advisory and only echoed in the advance
   * success message. Empty array allowed (when the reviewer considers it fully qualified).
   * B-8df9 CHK-002: part of the signature domain — erasing a recorded blocker by hand
   * invalidates `_hash` instead of quietly clearing the gate.
   */
  issues: InitCheckIssue[];
  /**
   * Per-reviewer records. New writes upsert by agentId so separate init reviewers
   * cannot silently overwrite each other. Legacy init-check.json files without
   * this field are interpreted as one record from `agentId`.
   * B-8df9 CHK-002: part of the signature domain — injecting reviewer coverage by hand
   * invalidates `_hash` instead of satisfying missingRequiredInitCheckAgents for free.
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
   * over INIT_CHECK_SIGNATURE_DOMAIN; gate is still validated by missingRequiredInitCheckAgents
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
    /** Session identifier (PROOF_OR_STOP_SESSION_ID / derived session id), audit traceability only. */
    session?: string;
    /** ISO 8601 attestation timestamp. */
    attestedAt: string;
    /** git HEAD at write time (short/full sha), pinning the attestation to the source state at that moment. */
    headHash?: string;
    /** material hash at write time (source freshness), same convention as verificationEvidence. */
    materialHash?: string;
  };
  /**
   * Signature over the components declared by INIT_CHECK_SIGNATURE_DOMAIN (core/init-check-gate.ts),
   * joined in that order and salted with INIT_CHECK_SALT. Computed by signInitCheck; the reviewer
   * verdict enters through computeInitCheckVerdictHash (B-8df9 CHK-002), which covers BOTH the
   * persisted `agentResults` / `issues` values AND the array the gate consumes.
   * Still OUT of the domain: `fallback` (surface/audit metadata) and the top-level `agentId` as such —
   * self-reported by the reviewer and not mechanically verifiable (EXP-001), backed by the reviewer
   * template fence, though it is bound indirectly for records that carry no `agentResults`.
   * Do not restate the component list here or anywhere else; read the declaration.
   */
  _hash: string;
}

// ── Stall Adjudication (B-7813 CHK-002: stall_resolution_set writes a signed
// stall-adjudication.json consumed by the DEV→REVIEW mint gate) ──

/**
 * B-7813: the structured actions an operator may record to clear the
 * convergence-stall block. The first five are the ordinary per-round resolutions
 * (CHK-001/CHK-002); `override_budget` (CHK-003) is the PRIVILEGED hard-ceiling
 * override. Kept in lock-step with the canonical STALL_RESOLUTION_ACTIONS tuple
 * in core/review-convergence.ts — that tuple is the runtime source of truth for
 * membership validation; this union is the compile-time mirror.
 */
export type StallResolutionActionName =
  | 'authorize_continuation'
  | 'replan'
  | 'escalate_root_cause'
  | 'resolve_findings'
  | 'declare_unreachable'
  | 'override_budget';

/**
 * B-7813 CHK-002: the signed stall-adjudication record persisted at
 * .proof-or-stop/story/actives/<id>/stall-adjudication.json. It authorizes clearing
 * the convergence-stall mint block for EXACTLY the review round it is bound to
 * (reviewRound === story.currentReviewRound at record time). Consumed on read by
 * the CHK-001 seam (hasCurrentRoundStallResolution) which re-validates reason
 * length + current-round binding + signature — a stale/previous-round/empty/
 * unsigned record never clears the block.
 */
export interface StallAdjudicationData {
  storyId: string;
  /** One of StallResolutionActionName (validated at runtime against STALL_RESOLUTION_ACTIONS). */
  action: StallResolutionActionName;
  /** Why the operator is consciously clearing the block (trim().length >= STALL_RESOLUTION_REASON_MIN). */
  reason: string;
  /** Snapshot of story.currentReviewRound the resolution is bound to (ISO 8601). Part of the signature domain. */
  reviewRound: string;
  /** Required only for action=declare_unreachable: the checklist item withdrawn as unreachable. Part of the signature domain. */
  itemId?: string;
  /** Audit-only: who recorded the resolution (operator/actor). Not part of the signature domain. */
  approvedBy?: string;
  /** ISO 8601 write timestamp. Not part of the signature domain. */
  recordedAt: string;
  /** Audit link stamped when declare_unreachable withdrew the item (the B-1909 scope-shrinkage decisionId). Not part of the signature domain. */
  withdrawalDecisionRef?: string;
  /**
   * Signature: sha256(`${storyId}:${action}:${sha256(reason)}:${reviewRound}:${itemId ?? ''}:${STALL_ADJUDICATION_SALT}`)
   * Computed by signStallAdjudication. approvedBy / recordedAt / withdrawalDecisionRef are audit fields, NOT in the signature domain.
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
   * Optional reviewer-friendly status. The shared delivery-promise outcome
   * normalizer owns writer and DONE-consumer semantics, including the explicit
   * legacy missing-status compatibility branch.
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
  /** Material tree hash reviewed by proof-or-stop-review-delivery; signed and required for freshness. */
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
  /** Current persisted path representation; absent means signed legacy v1. */
  pathCanonicalizerVersion?: string;
  /** Original caller spellings retained only for repair diagnostics. */
  originalPathInputs?: Record<string, string>;
  /** Rollout state at the write boundary; path and AST rollout are independent. */
  pathCanonicalizationMode?: 'off' | 'warn' | 'enforce';
  /** Parser/artifact identity used by semantic hunks. */
  anchorParserVersion?: string;
  anchorArtifactVersion?: string;
  astAnchorMode?: 'off' | 'warn' | 'enforce';
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
  anchorKind?: string;
  anchorRange?: { start: number; end: number };
  anchorParserVersion?: string;
  anchorArtifactVersion?: string;
  detail?: string;
  nextAction?: string;
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
  anchorKind?: string;
  anchorRange?: { start: number; end: number };
  previousAnchor?: string;
  previousAnchorKind?: string;
  previousAnchorRange?: { start: number; end: number };
  anchors?: ScopeDeclarationAnchor[];
  previousAnchors?: ScopeDeclarationAnchor[];
  anchorParserVersion?: string;
  anchorArtifactVersion?: string;
  keyPath?: string;
  parseFallback?: string;
  changeKind?: ChangeKind;
}

export interface ScopeDiffPack {
  diffPackHash: string;
  changedFiles: string[];
  hunks: ScopeDiffHunk[];
  generatedAt: string;
  anchorParserVersion?: string;
  anchorArtifactVersion?: string;
  astAnchorMode?: 'off' | 'warn' | 'enforce';
  /**
   * B-956f: normalized, deduped extensions (one per extension, no leading dot,
   * sorted) of MATERIAL-code files in the diff that receive NO semantic anchor
   * analysis (semantic anchors stay TS/JS-only, no new parsers). TS/JS files
   * produce none. Derived diagnostic; NOT part of diffPackHash.
   */
  semanticAnalysisUnavailable?: string[];
}

export interface ScopeDeclarationAnchor {
  name: string;
  kind: string;
  range: { start: number; end: number };
}

export interface SemanticScopeGateResult {
  status: ScopeGateStatus;
  violations: ScopeViolation[];
  warnings: ScopeViolation[];
  summary: string;
}

// ── Guard Session (B-6bfd CHK-004: Proof-or-Stop-managed guarded session projection) ──
//
// A guard session is a *projection* of scope protection for a ProofOrStop-dispatched
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
 *                      Proof-or-Stop dispatch/pre-apply flow; the flow's pre-apply step
 *                      checks scope before writing.
 * - watcher-fallback — provider has no pre-write interception; Proof-or-Stop can only detect
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
  /** Composite digest over semantic scope acknowledgements and validated ProofStory intent artifacts. */
  compositeScopeDigest?: string;
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

/**
 * Auditable justification for a `not_applicable` milestone row, mirroring the
 * shipped `ParentRoadmapNotApplicableDecision` triad. Present only on rows the
 * author has deliberately exempted; absence is surfaced as a DONE-gate diagnostic
 * (`not_applicable_missing_decision`), not a read-path throw.
 */
export interface MilestoneNotApplicableDecision {
  /** Non-empty scope reason the row does not apply. */
  reason: string;
  /** Human / agent identity of record for the exemption. */
  decidedBy: string;
  /** ISO timestamp the exemption was decided. */
  decidedAt: string;
}

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
  /**
   * Optional auditable justification when `status === 'not_applicable'`. Absence
   * of a valid decision on a not-applicable row is a DONE-gate diagnostic gap;
   * present-but-malformed shapes are rejected structurally at normalize time.
   */
  notApplicableDecision?: MilestoneNotApplicableDecision;
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
  /**
   * B-956f FIX G: true when the trigger fired ONLY from the production
   * materialClassification snapshot (language-neutral material-code presence in
   * the diff), not from request text/type. Diagnostic-only triggers surface in
   * reports and contracts but MUST NOT create or expand enforce-blocking gaps
   * until the program's language-neutral enforce flip (Workstream 3) — gap
   * creation filters them out, keeping every enforce outcome unchanged for
   * existing (e.g. TS) projects.
   */
  diagnosticOnly?: boolean;
}

export interface ProofStoryAcceptanceBinding {
  id: string;
  acceptanceClaim?: string;
  checklistRefs: string[];
  verificationIntentRefs: string[];
  milestoneIds: string[];
  note?: string;
  verificationTopology?: AcceptanceVerificationTopologyV1;
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
  /**
   * B-1909: append-only acceptance-binding withdrawals recorded post-PLAN by the
   * scope-shrinkage decision applier. Never mutates or removes acceptanceBindings;
   * absent on legacy contracts (treated as no dispositions).
   */
  bindingDispositions?: ProofStoryBindingDisposition[];
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
  /**
   * B-1909: stable identifier the checklist-item withdrawal (decisionRef) and
   * the append-only binding disposition (decisionRef) both cite so the two
   * layers are provably linked to one decision. Optional for legacy load;
   * generated on write when the caller omits it.
   */
  decisionId?: string;
  /**
   * B-1909: checklist item ids withdrawn by this confirmed decision. The sole
   * applier flips each named item to status='withdrawn'. Optional/empty on
   * legacy data and on binding-only shrinkage.
   */
  withdrawnChecklistItemRefs?: string[];
  /**
   * B-1909: acceptance-binding ids withdrawn by this confirmed decision. The
   * sole applier appends an append-only ProofStoryBindingDisposition for each.
   * Optional/empty on legacy data and on checklist-only shrinkage.
   */
  withdrawnAcceptanceBindingRefs?: string[];
  /** B-1909: optional audit references backing the withdrawal (transcripts, findings, docs). */
  evidenceRefs?: string[];
  /**
   * B-1909: explicit, operator-confirmed re-approval that authorizes withdrawing
   * EVERY effective acceptance binding (emptying the effective scope). Never
   * inferable — the write-time empty-scope floor HARD-REFUSES a full withdrawal
   * unless this field is present on the confirmed decision.
   */
  fullWithdrawalReapproval?: {
    approvedBy: string;
    reason: string;
    at: string;
  };
  createdAt: string;
  updatedAt: string;
}

/**
 * B-1909: append-only record beside the PLAN-frozen acceptanceBindings that
 * marks an original binding withdrawn without editing or deleting it. Written
 * exclusively by the scope-shrinkage decision applier so authority is
 * unforgeable, and readable from DEV/REVIEW/TEST without returning to PLAN.
 */
export interface ProofStoryBindingDisposition {
  bindingId: string;
  disposition: 'withdrawn';
  decisionRef: string;
  withdrawnAt: string;
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

/**
 * B-2aa7 (D-4) — one entry the read boundary REJECTED as not well-formed under
 * the legacy v1 schema, retained so corruption stays visible.
 *
 * Quarantine is retain-and-report, never drop: a rejected entry is removed from
 * `records` (so the typed domain only ever sees well-formed records) but is kept
 * here VERBATIM. Silently dropping it would leave a "clean empty array", which
 * reads exactly like an absent artifact — the defect this story removes.
 *
 * Produced only by `core/red-evidence-artifact-validation.ts`; never written to
 * disk by the canonical writer.
 */
export interface RedEvidenceMalformedRecord {
  /** Zero-based position of the rejected entry in the ON-DISK `records` array. */
  index: number;
  /** The entry's `id` when it has a usable one, else `null`. */
  id: string | null;
  /** Operator-facing summary naming the index, the id and every violation. */
  reason: string;
  /** Machine-readable violations: `missing:trigger`, `wrong-type:observedFailure`, … */
  violations: string[];
  /** The rejected entry, verbatim. This is what makes quarantine non-destructive. */
  value: unknown;
}

export interface RedEvidenceData {
  /**
   * The FILE-level schema stays `proofstory.red_evidence.v1` — the on-disk layout
   * is unchanged (W2c / B-506e). Individual records are discriminated by their
   * OWN `schemaVersion`: a legacy v1 record has none, a v2 record carries
   * `proofstory.red_evidence.v2`. No migration of existing v1 stores.
   *
   * B-2aa7 (D-1, E6): the FILE declares the era, so this member is now READ as an
   * authority at the read boundary. A missing or unknown value is rejected there
   * rather than silently degrading to v1.
   */
  schemaVersion: 'proofstory.red_evidence.v1';
  storyId: string;
  /** Append-only, mixed v1 (legacy) + v2 (chain) records in one array. */
  records: (RedEvidenceRecord | RedEvidenceRecordV2)[];
  /**
   * B-2aa7 (D-4): entries the read boundary quarantined. Present ONLY when the
   * artifact actually carried a malformed record, so an artifact that is merely
   * absent, empty or `records`-less never acquires a corruption surface.
   *
   * STRICTLY DERIVED, NEVER INHERITED. This is what the validator concluded on
   * one read; it is NOT part of the on-disk schema and an artifact does not get
   * to assert it about itself. `classifyRedEvidenceArtifact`
   * (`core/red-evidence-artifact-validation.ts`) STRIPS any occurrence found on
   * disk and re-attaches only its own classification — in every outcome,
   * including the one where nothing was malformed and the answer is therefore
   * "absent". Letting an on-disk value through made this an injection vector:
   * the write boundary re-inserts each entry's `value` into `records`, so a
   * crafted or stale artifact could fabricate quarantine state and plant records
   * in the evidence the DEV / REVIEW / DONE gates read.
   *
   * Consumers treat it as untrusted regardless, and by PROVENANCE rather than by
   * shape: `redEvidenceQuarantinedRecords` honours only the entry OBJECTS the
   * validator itself derived and yields `[]` for anything else, so a non-array,
   * a junk entry, or a structurally perfect hand-built one can neither crash a
   * consumer nor be re-inserted. Shape alone would not be enough — an entry is
   * five ordinary members, so any check of its bytes can be typed out by a
   * caller, and this member reaches the write boundary intact on any payload
   * that was built in memory instead of read. That case is REFUSED there rather
   * than ignored, because writing it would drop the records it claims.
   */
  malformedRecords?: RedEvidenceMalformedRecord[];
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
  /**
   * Milestones whose base coverage passed but whose ONLY covering verification
   * evidence is stale against the current binding. Surfaced as a non-blocking
   * (observe) diagnostic so this gate agrees with milestone_status, which demotes
   * the same rows to statusDetail=stale.
   */
  staleMilestoneEvidenceIds: string[];
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

// ── Dev-Memory Lifecycle Gates (B-a7c5) ──

/**
 * Per-story acknowledgement that `dev_memory_preflight`'s pack builder ran
 * (or, if the build threw, that a reasoned downgrade was recorded) before
 * this story entered DEV. This is a structurally SEPARATE artifact from a
 * `DevMemoryEntry` JSONL row: it carries no `gateEvidence`/`authority`
 * fields because it never claimed non-authoritative status over lesson
 * CONTENT in the first place — it only records that the read-side ritual
 * happened. See `evaluateDevMemoryPreflightGate` in core/machine.ts and
 * docs/requirements/decisions/dev-memory.md's Non-Goals annotation.
 */
export interface DevMemoryPreflightAckData {
  schemaVersion: 'lattice.dev_memory_preflight_ack.v1';
  storyId: string;
  /** Digest of the preflight pack actually seen, or null on a reasoned downgrade. */
  packDigest: string | null;
  /** Ids of the entries actually seen in the preflight pack (empty on a reasoned downgrade). */
  topHitIds: string[];
  acknowledgedAt: string;
  acknowledgedBy: string;
  /** Present only when the preflight pack build threw and a bypass reason was recorded instead. */
  downgradeReason?: string;
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
