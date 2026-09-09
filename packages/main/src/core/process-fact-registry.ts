import {
  COMMAND_POLICIES,
  type CommandPolicy,
  type CommandDestructiveRisk,
  type CommandLifecycleStatus,
  type CommandPhase,
  type KnownCommandName,
} from './command-policy.js';
import { FLOW_FACT_POLICIES } from './flow-fact-policy.js';
import { PROCESS_FACT_LEVELS, type ProcessFactLevel, type ProcessFactLevelEntry } from './process-fact-levels.js';

export type ProcessFactKind =
  | 'command'
  | 'runtime-behavior'
  | 'gate-evidence'
  | 'execution-status'
  | 'validation-status'
  | 'review-run'
  | 'review-pass'
  | 'prompt-envelope'
  | 'finding'
  | 'flow-policy'
  | 'host-availability-probe'
  | 'host-verdict'
  | 'reviewer-lane'
  | 'signed-artifact'
  | 'artifact';

export type ProcessFactSemantic =
  | 'artifact'
  | 'atomic-persistence'
  | 'blocker-state'
  | 'command'
  | 'execution-evidence'
  | 'finding-state'
  | 'flow-policy'
  | 'freshness-policy'
  | 'gate-evidence'
  | 'host-availability'
  | 'host-readiness'
  | 'host-verdict'
  | 'no-blocker-evidence'
  | 'normalization-policy'
  | 'review-run'
  | 'review-pass'
  | 'prompt-envelope'
  | 'reviewer-lane'
  | 'runtime-behavior'
  | 'schema-contract'
  | 'signed-artifact'
  | 'supersession-policy'
  | 'test-evidence'
  | 'validation-result'
  | 'validation-status'
  | 'verification-evidence'
  | 'verification-policy'
  | 'workspace-binding';

export interface ProcessFactArtifactRef {
  name: string;
  path: string;
  signed: boolean;
  signature?: string;
  producerCommand?: string;
  consumerGate?: string;
  reviewerLane?: string;
}

export interface ProcessFactRegistryEntry {
  name: string;
  kind: ProcessFactKind;
  semantics: readonly ProcessFactSemantic[];
  level: ProcessFactLevel;
  lifecycle?: CommandLifecycleStatus;
  allowedPhases?: readonly CommandPhase[] | 'all';
  rootOnly?: boolean;
  legacy?: boolean;
  gateEvidence?: boolean;
  destructiveRisk?: CommandDestructiveRisk;
  producer: string;
  /** Canonical repository sources that implement/register the producer. */
  producerSourceRefs?: readonly string[];
  consumerGate?: string;
  /** Canonical repository sources that declare or implement the consumer. */
  consumerSourceRefs?: readonly string[];
  artifact?: ProcessFactArtifactRef;
  reviewerLane?: string;
  rationale: string;
}

export interface Story3PersistenceOnlyRecordPolicy {
  recordClass: 'persistence' | 'candidate' | 'route' | 'baseline' | 'history' | 'standalone-receipt' | 'ledger-receipt';
  recordTypes: readonly string[];
  level: 'L2';
  producer: string;
  allowedConsumers: readonly ['finding_ledger_query'];
  gateEvidence: false;
  lifecycleAuthority: 'none';
  rationale: string;
}

/**
 * Persistence authority is deliberately narrower than semantic authority.
 * These rows can prove exact durable bytes only; no row in this table may be
 * promoted to L4 or consumed directly by a lifecycle predicate.
 */
export const PROCESS_FACT_STORY3_PERSISTENCE_ONLY_RECORD_POLICIES = [
  { recordClass: 'persistence', recordTypes: ['finding', 'assessment_proposal', 'assessment', 'mandatory_repair', 'deferral_expiry_policy', 'deferral', 'manifest', 'supersession', 'material_drift_reattestation'], level: 'L2', producer: 'core/finding-ledger', allowedConsumers: ['finding_ledger_query'], gateEvidence: false, lifecycleAuthority: 'none', rationale: 'Atomic persistence proves durable exact bytes, not blocker/pass/unblock truth.' },
  { recordClass: 'candidate', recordTypes: ['candidate', 'candidate_route'], level: 'L2', producer: 'Story 2 schema-neutral caller through core/finding-ledger', allowedConsumers: ['finding_ledger_query'], gateEvidence: false, lifecycleAuthority: 'none', rationale: 'Candidate bytes remain advisory until a separately registered semantic authority acts.' },
  { recordClass: 'route', recordTypes: ['route'], level: 'L2', producer: 'Story 2 schema-neutral caller through core/finding-ledger', allowedConsumers: ['finding_ledger_query'], gateEvidence: false, lifecycleAuthority: 'none', rationale: 'Persisted route bytes never establish applicability or lifecycle disposition.' },
  { recordClass: 'baseline', recordTypes: ['progress_baseline', 'progress_baseline_set', 'baseline_set'], level: 'L2', producer: 'Story 2 schema-neutral caller through core/finding-ledger', allowedConsumers: ['finding_ledger_query'], gateEvidence: false, lifecycleAuthority: 'none', rationale: 'Baseline bytes preserve a non-gate before-state and cannot block, pass, or unblock alone.' },
  { recordClass: 'history', recordTypes: ['historical', 'canonical_defect', 'canonical_defect_supersession'], level: 'L2', producer: 'Story 2 schema-neutral caller through core/finding-ledger', allowedConsumers: ['finding_ledger_query'], gateEvidence: false, lifecycleAuthority: 'none', rationale: 'Historical identity and recall bytes remain advisory rather than current lifecycle evidence.' },
  { recordClass: 'standalone-receipt', recordTypes: ['standalone_receipt', 'route_receipt'], level: 'L2', producer: 'Story 2 schema-neutral caller through core/finding-ledger', allowedConsumers: ['finding_ledger_query'], gateEvidence: false, lifecycleAuthority: 'none', rationale: 'A standalone target receipt remains non-authoritative until an exact-CAS semantic consumer is registered.' },
  { recordClass: 'ledger-receipt', recordTypes: ['finding_ledger_receipt'], level: 'L2', producer: 'handlers/finding-ledger.appendFindingLedger', allowedConsumers: ['finding_ledger_query'], gateEvidence: false, lifecycleAuthority: 'none', rationale: 'The signed commit receipt proves persistence integrity only and never the truth of committed content.' },
] as const satisfies readonly Story3PersistenceOnlyRecordPolicy[];

export const PROCESS_FACT_STORY3_RUNTIME_RECEIPT_POLICY = {
  recordType: 'runtime_evidence_receipt',
  level: 'L3',
  producer: 'core/runtime-evidence-receipt + handlers/finding-ledger.verify',
  allowedConsumers: ['finding_ledger_query'],
  gateEvidence: false,
  lifecycleAuthority: 'gate-eligible-input-only',
  rationale: 'A current signed runtime receipt can be an input to a separately registered future gate consumer; persistence or query output alone never changes lifecycle state.',
} as const;

export const PROCESS_FACT_STORY3_FINDING_LIFECYCLE_POLICY = {
  recordType: 'finding_lifecycle_transition',
  level: 'L4',
  producer: 'handlers/finding.appendFindingLifecycleTransition + handlers/finding-ledger.bindLegacyFindingLedgerReceipts',
  allowedConsumers: ['StoryStore.readFindings', 'storyMachine.canPassReview'],
  gateEvidence: true,
  lifecycleAuthority: 'terminal-finding-state',
  rationale: 'A current exact-signed append-only terminal transition is the canonical resolve/dismiss fact folded by readFindings before the REVIEW blocker gate. A pre-upgrade current-key transition missing only the nested exact digest remains fail-closed unless a separate current exact-signed legacy_lifecycle_receipt_binding re-attests its immutable carrier, record, source identity, and chain. Original Finding rows and historical transition bytes remain immutable.',
} as const;

export const PROCESS_FACT_STORY3_FINDING_PROJECTION_POLICY = {
  recordType: 'finding_projection',
  level: 'L4',
  producer: 'handlers/finding-ledger.createAuthoritativeFindingMutation',
  allowedConsumers: ['StoryStore.readFindings', 'storyMachine.canPassReview'],
  gateEvidence: true,
  lifecycleAuthority: 'current-finding-projection',
  rationale: 'A current-key exact-signed, source-record CAS-bound append preserves live legacy Finding mutations without rewriting the immutable source row; StoryStore folds only verified projections in ledger order.',
} as const;

export const PROCESS_FACT_KIND_BY_COMMAND: Record<string, ProcessFactKind> = {
  validate: 'validation-status',
  done_required_validate: 'validation-status',
  test_add: 'execution-status',
  test_story: 'execution-status',
  verification_evidence_add: 'execution-status',
  verification_evidence_batch_add: 'execution-status',
  verification_evidence_refresh_stale: 'execution-status',
  verification_run: 'execution-status',
  // B-1482: the narrowing-only re-pin rewrites the selector every past and future
  // receipt of the pinned command is judged against, so it states the same kind of
  // fact as the sibling writers rather than the generic L4 gate-evidence fallback.
  verification_pin_narrow: 'execution-status',
  review_run_start: 'review-run',
  certification_window_begin: 'gate-evidence',
  certification_window_status: 'gate-evidence',
  certification_window_cancel: 'gate-evidence',
  review_inventory_begin: 'gate-evidence',
  review_inventory_status: 'gate-evidence',
  review_inventory_critic_set: 'gate-evidence',
  review_inventory_wave_advance: 'gate-evidence',
  review_inventory_finalize: 'gate-evidence',
  review_inventory_cancel: 'gate-evidence',

  review_pass_set: 'review-pass',
  finding_add: 'finding',
  finding_resolve: 'finding',
  finding_dismiss: 'finding',
  autopilot_review_submit: 'host-verdict',
  quorum_submit: 'host-verdict',
  decision_doc_proposal: 'gate-evidence',
  decision_doc_save: 'gate-evidence',
  review_escalation_policy_set: 'gate-evidence',
  review_host_availability_probe: 'host-availability-probe',
  review_escalation_fallback_set: 'gate-evidence',
  story_create_from_repro: 'gate-evidence',
  acceptance_basis_generate: 'signed-artifact',
  pre_review_check: 'signed-artifact',
  acceptance_rollout_report: 'signed-artifact',
};

export const PROCESS_FACT_REQUIRED_SEMANTICS = {
  agent_prompt: ['artifact', 'prompt-envelope', 'schema-contract'],
  validate: ['validation-status', 'validation-result', 'gate-evidence'],
  done_required_validate: ['schema-contract', 'execution-evidence', 'validation-result', 'gate-evidence'],
  test_add: ['test-evidence', 'validation-result'],
  test_story: ['test-evidence', 'validation-result'],
  verification_evidence_add: ['execution-evidence', 'verification-evidence', 'gate-evidence'],
  verification_evidence_batch_add: ['execution-evidence', 'verification-evidence', 'gate-evidence'],
  verification_evidence_refresh_stale: ['execution-evidence', 'verification-evidence', 'gate-evidence'],
  verification_run: ['execution-evidence', 'verification-evidence', 'gate-evidence'],
  verification_pin_narrow: ['execution-evidence', 'verification-evidence', 'gate-evidence'],
  verification_intent_recover: ['signed-artifact','verification-policy','gate-evidence'],
  verification_intent_append: ['signed-artifact','verification-policy','gate-evidence'],
  finding_ledger_query: ['schema-contract', 'signed-artifact', 'atomic-persistence'],
  finding_runtime_evidence_run: ['atomic-persistence', 'signed-artifact', 'schema-contract'],
  finding_runtime_evidence_verify: ['execution-evidence', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding'],
  review_run_start: ['review-run', 'prompt-envelope', 'schema-contract', 'workspace-binding', 'gate-evidence'],
  certification_window_begin: ['artifact', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'blocker-state', 'gate-evidence'],
  certification_window_status: ['artifact', 'signed-artifact', 'blocker-state', 'freshness-policy', 'gate-evidence'],
  certification_window_cancel: ['artifact', 'signed-artifact', 'blocker-state', 'gate-evidence'],
  review_inventory_begin: ['artifact', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'reviewer-lane', 'gate-evidence'],
  review_inventory_status: ['artifact', 'signed-artifact', 'blocker-state', 'freshness-policy', 'gate-evidence'],
  review_inventory_critic_set: ['artifact', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'reviewer-lane', 'review-pass', 'gate-evidence', 'normalization-policy'],
  review_inventory_wave_advance: ['artifact', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'reviewer-lane', 'blocker-state', 'gate-evidence'],
  review_inventory_finalize: ['artifact', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'reviewer-lane', 'no-blocker-evidence', 'gate-evidence'],
  review_inventory_cancel: ['artifact', 'signed-artifact', 'blocker-state', 'gate-evidence'],

  review_pass_set: ['review-pass', 'prompt-envelope', 'no-blocker-evidence', 'gate-evidence'],
  review_loop_start: ['blocker-state', 'schema-contract', 'gate-evidence'],
  review_loop_iteration_add: ['blocker-state', 'schema-contract', 'gate-evidence'],
  review_loop_close: ['blocker-state', 'schema-contract', 'gate-evidence'],
  scope_boundary_set: ['schema-contract', 'gate-evidence'],
  scope_contract_set: ['schema-contract', 'atomic-persistence', 'gate-evidence'],
  scope_contract_init_from_plan: ['schema-contract', 'atomic-persistence', 'gate-evidence'],
  execution_boundary_set: ['schema-contract', 'workspace-binding', 'gate-evidence'],
  scope_freeze_check: ['validation-result', 'schema-contract', 'gate-evidence'],
  scope_extension_proposal: ['blocker-state', 'schema-contract', 'gate-evidence'],
  scope_extension_decide: ['blocker-state', 'schema-contract', 'gate-evidence'],
  finding_add: ['finding-state', 'blocker-state', 'gate-evidence'],
  finding_resolve: ['finding-state', 'blocker-state', 'gate-evidence'],
  finding_dismiss: ['finding-state', 'blocker-state', 'gate-evidence'],
  autopilot_review_submit: ['host-verdict', 'execution-evidence', 'freshness-policy', 'schema-contract', 'gate-evidence'],
  quorum_submit: ['host-verdict', 'execution-evidence', 'atomic-persistence', 'gate-evidence'],
  decision_doc_proposal: ['schema-contract', 'gate-evidence'],
  decision_doc_save: ['artifact', 'schema-contract', 'execution-evidence', 'gate-evidence'],
  review_escalation_policy_set: ['schema-contract', 'gate-evidence'],
  review_host_availability_probe: ['host-availability', 'host-readiness', 'execution-evidence', 'freshness-policy', 'schema-contract', 'gate-evidence'],
  review_escalation_fallback_set: ['schema-contract', 'freshness-policy', 'host-availability', 'host-readiness', 'gate-evidence'],
  story_create_from_repro: ['artifact', 'schema-contract', 'workspace-binding', 'gate-evidence'],
  original_intent_snapshot_set: ['schema-contract', 'gate-evidence'],
  milestone_ledger_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  milestone_ledger_add: ['schema-contract', 'verification-policy', 'gate-evidence'],
  slice_plan_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  parent_ledger_rollup_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  proofstory_contract_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  acceptance_topology_check: ['schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'gate-evidence'],
  acceptance_basis_generate: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding'],
  acceptance_basis: ['schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding'],
  pre_review_check: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'execution-evidence', 'gate-evidence'],
  pre_review_check_read: ['schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'execution-evidence', 'gate-evidence'],
  acceptance_rollout_report: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'execution-evidence', 'host-verdict', 'gate-evidence'],
  acceptance_rollout_report_read: ['schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'execution-evidence', 'host-verdict', 'gate-evidence'],
  acceptance_rollout_check: ['schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'execution-evidence', 'host-verdict', 'gate-evidence'],
  topology_exclusion_approval_set: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'reviewer-lane'],
  topology_critic_receipt_set: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'reviewer-lane'],
  topology_critic_receipt_check: ['schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'reviewer-lane'],
  intent_collision_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  scope_shrinkage_decision_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  red_evidence_create: ['schema-contract', 'verification-policy', 'gate-evidence'],
  // W2b (B-e10d): the target-binding writer records structured metadata under a
  // schema and enforces the §3.3 expectedRedTargets membership policy, but is a
  // run PREREQUISITE — deliberately NOT 'gate-evidence' (nothing consumes the
  // binding as a gate in this leaf; chain freeze / green-confirm match are W2c).
  red_evidence_binding_set: ['schema-contract', 'verification-policy'],
  // W2c (B-506e): the two chain-control commands write schema-bound records and
  // enforce the §3.3 expectedRedTargets membership policy, but are NOT
  // 'gate-evidence' — the v1 gate predicate ignores their v2 records and no gate
  // consumes the chain in this leaf (gate rewiring is W3).
  red_evidence_quarantine: ['schema-contract', 'verification-policy'],
  red_evidence_recover: ['schema-contract', 'verification-policy'],
  // W2d (B-9ff1): the read-only envelope pre-flight validates a candidate
  // assertion against the §1.1 schema and the §1.2 policy registries, so it
  // carries schema-contract + verification-policy semantics — but NOT
  // 'gate-evidence': no gate consumes its answer (the gate-consumption query is
  // §5 / W3). Canonical scope sentence, used verbatim at every site that states
  // this guarantee: Scoped to the command handler itself and the CLI
  // story-evidence writers, it writes no RED-evidence record, chain record or
  // story/evidence artifact, emits no process event, changes no gate verdict,
  // and runs no preCommand or postCommand hook. Nothing outside that scope is
  // covered: see the red_evidence_envelope_check note in cli/activity-policy.ts,
  // which lists the surfaces known when it was written and is not a proof of
  // exhaustiveness.
  red_evidence_envelope_check: ['schema-contract', 'verification-policy'],
  spike_start: ['schema-contract', 'verification-policy', 'gate-evidence'],
  spike_result_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  spike_result: ['schema-contract', 'verification-policy', 'gate-evidence'],
  spike_discard: ['schema-contract', 'verification-policy', 'gate-evidence'],
  spike_promote: ['schema-contract', 'verification-policy', 'gate-evidence'],
  intent_coverage_check: ['schema-contract', 'verification-policy'],
  proofstory_gate_check: ['schema-contract', 'verification-policy'],
  done_intent_equivalence_check: ['schema-contract', 'verification-policy'],
  proofstory_review_completeness_check: ['schema-contract', 'verification-policy'],
  parent_roadmap_status: ['schema-contract', 'verification-policy'],
  parent_roadmap_evaluate: ['schema-contract', 'verification-policy'],
} as const satisfies Record<string, readonly ProcessFactSemantic[]>;

export const PROCESS_FACT_RUNTIME_SEMANTICS = {
  'runtime:agent_dispatch_role_authority_gate': ['runtime-behavior', 'schema-contract', 'reviewer-lane', 'gate-evidence'],
  'runtime:legacy_role_alias_sunset_contract': ['runtime-behavior', 'schema-contract', 'normalization-policy'],
  'runtime:review_escalation_done_gate': ['runtime-behavior', 'host-verdict', 'host-availability', 'gate-evidence'],
  'runtime:review_assurance_floor_done_gate': ['runtime-behavior', 'host-verdict', 'host-availability', 'gate-evidence'],
  'runtime:review_run_story_files_hash_gate': ['runtime-behavior', 'freshness-policy', 'workspace-binding', 'review-run', 'gate-evidence'],
  'runtime:review_run_atomic_persistence_gate': ['runtime-behavior', 'atomic-persistence', 'prompt-envelope', 'review-run', 'gate-evidence'],
  'runtime:review_inventory_temporal_integrity_gate': ['runtime-behavior', 'atomic-persistence', 'signed-artifact', 'schema-contract', 'freshness-policy', 'reviewer-lane', 'finding-state', 'gate-evidence'],
  'runtime:prompt_envelope_review_gate': ['runtime-behavior', 'prompt-envelope', 'schema-contract', 'freshness-policy', 'review-run', 'review-pass', 'gate-evidence'],
  'runtime:incremental_review_eligibility_gate': ['runtime-behavior', 'prompt-envelope', 'schema-contract', 'normalization-policy', 'freshness-policy', 'review-run', 'review-pass', 'verification-policy', 'gate-evidence'],
  'runtime:post_remediation_review_selection_gate': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'normalization-policy', 'freshness-policy', 'reviewer-lane', 'gate-evidence'],
  'runtime:prompt_role_body_rollout_gate': ['runtime-behavior', 'prompt-envelope', 'schema-contract', 'reviewer-lane', 'gate-evidence'],
  'runtime:prompt_role_evidence_eligibility_gate': ['runtime-behavior', 'schema-contract', 'reviewer-lane', 'gate-evidence'],
  'runtime:story_files_hash_freshness_gate': ['runtime-behavior', 'freshness-policy', 'workspace-binding', 'verification-evidence', 'review-run', 'host-verdict', 'gate-evidence'],
  'runtime:causal_execution_key_gate': ['runtime-behavior', 'execution-evidence', 'schema-contract', 'workspace-binding', 'freshness-policy', 'verification-policy', 'gate-evidence'],
  'runtime:causal_receipt_import_gate': ['runtime-behavior', 'execution-evidence', 'schema-contract', 'atomic-persistence', 'freshness-policy', 'workspace-binding', 'gate-evidence'],
  'runtime:causal_dependency_preflight_metrics_gate': ['runtime-behavior', 'execution-evidence', 'schema-contract', 'freshness-policy', 'verification-policy', 'gate-evidence'],
  'runtime:repro_first_story_intake_preflight': ['runtime-behavior', 'schema-contract', 'workspace-binding', 'gate-evidence'],
  'runtime:evidence_environment_gate_projection': ['runtime-behavior', 'execution-evidence', 'schema-contract', 'normalization-policy', 'freshness-policy', 'verification-policy', 'gate-evidence'],
  'runtime:proof_admissibility_gate_diagnostic': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'gate-evidence'],
  'runtime:parent_roadmap_totality_claim_consumer': ['runtime-behavior', 'schema-contract', 'verification-policy', 'gate-evidence'],
  'runtime:closeout_artifact_trust_boundary': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'gate-evidence'],
  'runtime:composite_scope_digest_review_gate': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'review-run', 'gate-evidence'],
  'runtime:trusted_closeout_artifact_validation': ['runtime-behavior', 'schema-contract', 'verification-policy', 'gate-evidence'],
  'runtime:routine_validation_fresh_pass_reuse_gate': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'validation-result', 'verification-policy', 'gate-evidence'],
  'runtime:story_aware_dynamic_selection_manifest': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'verification-policy', 'gate-evidence'],
  'runtime:story_aware_dynamic_closure_receipt': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'execution-evidence', 'verification-policy', 'gate-evidence'],
  'runtime:story_aware_dynamic_shard_aggregate': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'workspace-binding', 'execution-evidence', 'verification-policy', 'gate-evidence'],
  'runtime:story_aware_dynamic_authority_gate': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'freshness-policy', 'validation-result', 'verification-policy', 'gate-evidence'],
  'runtime:acceptance_topology_plan_dev_gate': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'workspace-binding', 'verification-policy', 'gate-evidence'],
  'runtime:acceptance_rollout_dev_review_gate': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'verification-policy', 'execution-evidence', 'host-verdict', 'gate-evidence'],
  'runtime:topology_critic_authority_verification': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'reviewer-lane', 'verification-policy'],
  'runtime:canonical_scope_path_gate': ['runtime-behavior', 'schema-contract', 'normalization-policy', 'freshness-policy', 'gate-evidence'],
  'runtime:ast_semantic_anchor_gate': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'gate-evidence'],
  'runtime:shared_gap_log_metadata_gate': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'gate-evidence'],
  'runtime:delivery_promise_outcome_done_gate': ['runtime-behavior', 'schema-contract', 'normalization-policy', 'gate-evidence'],
} as const satisfies Record<string, readonly ProcessFactSemantic[]>;

export const PROCESS_FACT_ARTIFACT_BY_COMMAND: Record<string, ProcessFactArtifactRef> = {
  certification_window_begin: {
    name: 'certification-window.json',
    path: 'certification-window.json',
    signed: true,
    signature: 'signCertificationWindow/verifyCertificationWindow and signPrecertReceipt/verifyPrecertReceipt; inventory-completeness-only receipts never authorize PRE_CERT',
    producerCommand: 'certification_window_begin/certification_window_status/certification_window_cancel',
    consumerGate: 'done_required_validate / validate --full PRE_CERT certification-window gate',
  },
  certification_window_status: {
    name: 'certification-window.json',
    path: 'certification-window.json',
    signed: true,
    signature: 'signCertificationWindow/verifyCertificationWindow',
    producerCommand: 'certification_window_status',
    consumerGate: 'done_required_validate / validate --full PRE_CERT certification-window gate',
  },
  certification_window_cancel: {
    name: 'certification-window.json',
    path: 'certification-window.json',
    signed: true,
    signature: 'signCertificationWindow/verifyCertificationWindow with CANCELLED state',
    producerCommand: 'certification_window_cancel',
    consumerGate: 'done_required_validate / validate --full PRE_CERT certification-window gate',
  },
  review_inventory_begin: {
    name: 'review-inventory-epochs.json',
    path: 'review-inventory-epochs.json',
    signed: true,
    signature: 'signReviewInventoryEpoch/verifyReviewInventoryEpoch including initialRunSequenceBoundary, complete acceptance scopeDigest, candidateSpecSetDigest, corpusDigest, requiredLanes, and baselineFindingIds; signReviewInventoryReceipt/verifyReviewInventoryReceipt',
    producerCommand: 'review_inventory_begin/review_inventory_status/review_inventory_wave_advance/review_inventory_finalize/review_inventory_cancel',
    consumerGate: 'storyMachine.canReenterDev REVIEW to DEV inventory remediation/completeness gate',
  },
  review_inventory_status: {
    name: 'review-inventory-epochs.json', path: 'review-inventory-epochs.json', signed: true,
    signature: 'signReviewInventoryEpoch/verifyReviewInventoryEpoch', producerCommand: 'review_inventory_status',
    consumerGate: 'storyMachine.canReenterDev REVIEW to DEV inventory freshness gate',
  },
  review_inventory_critic_set: {
    name: 'review-inventory-epochs.json', path: 'review-inventory-epochs.json', signed: true,
    signature: 'signReviewInventoryCriticReceipt/verifyReviewInventoryCriticReceipt with explicit inventory-completeness purpose and exact signed epoch/wave/cutoff binding in dispatch and ReviewRun, terminal read evidence, and complete per-finding dispositions including current purpose-bound critic discoveries; never topology business-author provenance. OPEN inventory pass producers and lane consumers require both signed readManifest and mechanical readLog, including pass-only finding normalization.', producerCommand: 'review_inventory_critic_set',
    consumerGate: 'review_inventory_finalize current-wave independent completeness critic gate',
    reviewerLane: 'proof-or-stop-review-topology-critic',
  },
  review_inventory_wave_advance: {
    name: 'review-inventory-epochs.json', path: 'review-inventory-epochs.json', signed: true,
    signature: 'signReviewInventoryEpoch/verifyReviewInventoryEpoch after validated current-wave critic receipt and nonzero new families; nextRunSequenceBoundary seals every lower/equal ReviewRun independent of timestamp equality', producerCommand: 'review_inventory_wave_advance',
    consumerGate: 'review_inventory_finalize authority-specific completeness gate and reviewer terminal admission boundary',
    reviewerLane: 'proof-or-stop-review-topology-critic',
  },
  review_inventory_finalize: {
    name: 'review-inventory-epochs.json',
    path: 'review-inventory-epochs.json',
    signed: true,
    signature: 'signReviewInventoryEpoch/verifyReviewInventoryEpoch and signReviewInventoryReceipt/verifyReviewInventoryReceipt and signReviewInventoryCriticReceipt/verifyReviewInventoryCriticReceipt under withReviewInventoryMutationLock; authorizesTest=false inventory-completeness-only never authorizes PRE_CERT',
    producerCommand: 'review_inventory_finalize',
    consumerGate: 'storyMachine.canReenterDev REVIEW to DEV inventory remediation/completeness gate with live terminal/finding aggregate replay before consume; certification_window_begin',
  },
  review_inventory_cancel: {
    name: 'review-inventory-epochs.json', path: 'review-inventory-epochs.json', signed: true,
    signature: 'signReviewInventoryEpoch/verifyReviewInventoryEpoch and, for FINALIZED recovery, signReviewInventoryReceipt/verifyReviewInventoryReceipt with invalidatedAt/invalidationReason', producerCommand: 'review_inventory_cancel',
    consumerGate: 'storyMachine.canReenterDev REVIEW to DEV inventory state gate',
  },
  agent_prompt: {
    name: 'prompt-envelopes.json',
    path: 'prompt-envelopes.json',
    signed: false,
    producerCommand: 'agent_prompt/review_run_start',
    consumerGate: 'audit-only for story-dispatch; review-run envelopeId is consumed through the signed ReviewRun by REVIEW, assurance-floor, and quorum gates',
  },
  closeout_write_receipt: {
    name: 'closeout-write-receipts.jsonl',
    path: 'closeout-write-receipts.jsonl',
    signed: false,
    producerCommand: 'core/auto-commit-metadata',
    consumerGate: 'review-run metadata-only retention classifier (artifact gate validation remains independent)',
  },
  story_advance: {
    name: 'index.json',
    path: 'index.json',
    signed: false,
    producerCommand: 'story_advance',
    consumerGate: 'storyMachine phase guards and story_advance preflight gates',
  },
  story_discard: {
    name: 'scope-discard-digest.json',
    path: 'scope-discard-digest.json',
    signed: false,
    producerCommand: 'story_discard',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
  },
  story_review: {
    name: 'review.json',
    path: 'review.json',
    signed: true,
    signature: 'sha256(storyId:timestamp:issueCount:blockerCount:lattice-review-integrity-v1)',
    producerCommand: 'story_review',
    consumerGate: 'storyMachine.canStartDev PLAN to DEV gate',
  },
  candidate_spec_route: {
    name: 'candidate-spec-set.json',
    path: 'candidate-spec-set.json',
    signed: true,
    signature: 'artifactDigest over proofbound.candidate-spec-set.v1 canonical fields, signed rollout mode, pre-budget document-frequency and zero-hit query filtering, typed protected direct sources and missing diagnostics, ordinary-only cutoff/truncation classification, non-story-metadata changed paths, and freshness bindings',
    producerCommand: 'candidate_spec_route',
    consumerGate: 'scope_check_save, reviewer read-evidence candidate routing gate, and review inventory candidate-universe freshness gate',
  },
  checklist_update: {
    name: 'checklist.json',
    path: 'checklist.json',
    signed: false,
    producerCommand: 'checklist_update',
    consumerGate: 'storyMachine.checklistAllDone DEV to REVIEW gate',
  },
  verification_intent_recover: {name:'checklist.json',path:'checklist.json',signed:false,signature:'exact repository-signed Git-metadata checkpoint is verified before projection recovery',producerCommand:'verification_intent_recover',consumerGate:'StoryStore canonical readers reject missing, stripped or mismatched checkpoint projections'},
  verification_intent_append: {name:'checklist.json',path:'checklist.json',signed:false,signature:'repository-local Ed25519 amendment chain binding owner, scope, before and after intent semantics',producerCommand:'verification_intent_append',consumerGate:'StoryStore.readChecklist and writeChecklist validate signatures before coverage and review consumers'},
  verification_evidence_add: {
    name: 'checklist.json',
    path: 'checklist.json',
    signed: false,
    producerCommand: 'verification_evidence_add',
    consumerGate: 'validate verification coverage and freshness gates',
  },
  verification_evidence_batch_add: {
    name: 'checklist.json',
    path: 'checklist.json',
    signed: false,
    producerCommand: 'verification_evidence_batch_add',
    consumerGate: 'validate verification coverage and freshness gates',
  },
  verification_evidence_refresh_stale: {
    name: 'checklist.json',
    path: 'checklist.json',
    signed: false,
    producerCommand: 'verification_evidence_refresh_stale',
    consumerGate: 'validate verification freshness gate: every immutable pinned intent, including docs/manual, re-executes through the same command/selector/timeout stamping boundary; raw refresh execution binds command/cwd/effective-timeout/provenance and current material/environment/runtime context, while selector/type/kind bind distinct signed causal identities and receipt-keyed import checks; execution time is projected from the signed causal receipt; failed or pinless rows never regain mechanical authority',
  },
  verification_run: {
    name: 'checklist.json',
    path: 'checklist.json',
    signed: false,
    producerCommand: 'verification_run',
    consumerGate: 'validate verification coverage and freshness gates',
  },
  recover_evidence: {
    name: 'checklist.json',
    path: 'checklist.json',
    signed: false,
    producerCommand: 'recover_evidence',
    consumerGate: 'validate verification freshness gate',
  },
  artifact_declare: {
    name: 'declared-artifacts.json',
    path: 'declared-artifacts.json',
    signed: false,
    producerCommand: 'artifact_declare',
    consumerGate: 'dirty-worktree classifier and DONE declared artifact gate',
  },
  original_intent_snapshot_set: {
    name: 'original-intent-snapshot.json',
    path: 'original-intent-snapshot.json',
    signed: false,
    producerCommand: 'original_intent_snapshot_set',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
  },
  milestone_ledger_set: {
    name: 'milestone-ledger.json',
    path: 'milestone-ledger.json',
    signed: false,
    producerCommand: 'milestone_ledger_set',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
  },
  milestone_ledger_add: {
    name: 'milestone-ledger.json',
    path: 'milestone-ledger.json',
    signed: false,
    producerCommand: 'milestone_ledger_add',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
  },
  // Deliberate key/producerCommand deviation: milestone_closeout_capture is NOT an
  // invocable CLI command. The snapshot is written by the story_advance DONE-time
  // capture in handlers/milestone-status, but story_advance already claims index.json
  // in this map and the read-only milestone_closeout command is a consumer, not the
  // producer. A synthetic unquoted key keeps this ref reachable from the
  // artifact:milestone-closeout.json fact entry without attaching a false producer
  // claim to any command fact (a 'runtime:'-style quoted key would not parse in
  // verify-process-fact-contract.mjs key extraction).
  milestone_closeout_capture: {
    name: 'milestone-closeout.json',
    path: 'milestone-closeout.json',
    signed: false,
    producerCommand: 'story_advance',
    consumerGate: 'DONE-phase milestone_status and milestone_closeout snapshot-first read path (snapshot-only; never re-blocks DONE)',
  },
  slice_plan_set: {
    name: 'slice-plan.json',
    path: 'slice-plan.json',
    signed: false,
    producerCommand: 'slice_plan_set',
    consumerGate: 'ProofStory DEV admission and DONE intent-equivalence gates',
  },
  parent_ledger_rollup_set: {
    name: 'parent-ledger-rollup.json',
    path: 'parent-ledger-rollup.json',
    signed: false,
    producerCommand: 'parent_ledger_rollup_set',
    consumerGate: 'ProofStory DONE intent-equivalence gate',
  },
  delivery_context_pack: {
    name: 'delivery-context-pack.json',
    path: 'evidence/delivery-context-pack.json',
    signed: false,
    producerCommand: 'delivery_context_pack',
  },
  proofstory_contract_set: {
    name: 'proofstory.json',
    path: 'proofstory.json',
    signed: false,
    producerCommand: 'proofstory_contract_set',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
  },
  acceptance_basis_generate: {
    name: 'acceptance-basis.json',
    path: 'acceptance-basis.json',
    signed: true,
    signature: 'Ed25519(canonical receipt binding basis/topology/scope/workspace/storyFilesHash/closureFilesHash)',
    producerCommand: 'acceptance_basis_generate',
    consumerGate: 'acceptance_topology_check and transition-orchestrator PLAN to DEV structural gate',
  },
  pre_review_check: {
    name: 'pre-review-check.json',
    path: 'pre-review-check.json',
    signed: true,
    signature: 'Ed25519(canonical current basis/topology/scope/storyFilesHash/closureFilesHash/evidence/cutoff/critic binding)',
    producerCommand: 'pre_review_check',
    consumerGate: 'pre_review_check_read and transition-orchestrator DEV to REVIEW executable gate',
  },
  acceptance_rollout_report: {
    name: 'acceptance-rollout-report.json',
    path: 'acceptance-rollout-report.json',
    signed: true,
    signature: 'Ed25519(canonical verifier-derived report binding frozen membership/source inventory/window/thresholds/verdict/workspace/full-3x2)',
    producerCommand: 'acceptance_rollout_report',
    consumerGate: 'acceptance_rollout_report_read, acceptance_rollout_check, and transition-orchestrator DEV to REVIEW rollout gate',
  },
  topology_exclusion_approval_set: {
    name: 'topology-exclusion-approvals.json', path: 'topology-exclusion-approvals.json', signed: true,
    signature: 'Ed25519(canonical scope-plan approval binding exclusion/basis/topology/scope/story/closure/provenance)',
    producerCommand: 'topology_exclusion_approval_set', consumerGate: 'topology_critic_receipt_set and topology_critic_receipt_check',
  },
  topology_critic_receipt_set: {
    name: 'topology-critic-receipt.json', path: 'topology-critic-receipt.json', signed: true,
    signature: 'Ed25519(canonical critic receipt binding role/provenance/basis/topology/scope/story/closure/findings/exclusions/verdict/time)',
    producerCommand: 'topology_critic_receipt_set', consumerGate: 'topology_critic_receipt_check CLI verification',
  },
  intent_collision_set: {
    name: 'intent-collision.json',
    path: 'intent-collision.json',
    signed: false,
    producerCommand: 'intent_collision_set',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
  },
  scope_shrinkage_decision_set: {
    name: 'scope-shrinkage-decision.json',
    path: 'scope-shrinkage-decision.json',
    signed: false,
    producerCommand: 'scope_shrinkage_decision_set',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
  },
  red_evidence_create: {
    name: 'red-evidence.json',
    path: 'red-evidence.json',
    signed: false,
    producerCommand: 'red_evidence_create',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
  },
  spike_start: {
    name: 'spike.json',
    path: 'spike.json',
    signed: false,
    producerCommand: 'spike_start',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
  },
  spike_result_set: {
    name: 'spike.json',
    path: 'spike.json',
    signed: false,
    producerCommand: 'spike_result_set',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
  },
  spike_result: {
    name: 'spike.json',
    path: 'spike.json',
    signed: false,
    producerCommand: 'spike_result',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
  },
  spike_discard: {
    name: 'spike.json',
    path: 'spike.json',
    signed: false,
    producerCommand: 'spike_discard',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
  },
  spike_promote: {
    name: 'spike.json',
    path: 'spike.json',
    signed: false,
    producerCommand: 'spike_promote',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
  },
  review_run_start: {
    name: 'review-runs.json',
    path: 'review-runs.json',
    signed: true,
    signature: 'signReviewRun/verifyReviewRun; ReviewRun.storyFilesHash, workspaceBinding.bindingHash, and optional Prompt Envelope envelopeId are folded into new review-run signatures. Explicit critic reviewPurpose and inventoryBinding use a versioned signature suffix; absent legacy fields retain their old signature domain but never authorize a new inventory receipt. Inventory precheck, monotonic RR allocation, Prompt Envelope and ReviewRun durable publication share one outer inventory critical section. In full-envelope mode promptHash equals the exact assembledPrompt domain digest and envelopeId signs the immutable run-start finding projection.',
    producerCommand: 'review_run_start',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  review_pass_set: {
    name: 'review-passes.json',
    path: 'review-passes.json',
    signed: true,
    signature: 'signReviewPass/verifyReviewPass; envelope-bound records use the versioned envelopeId-inclusive domain, reviewRunId-inclusive records do not fall back to legacy signatures, writerSessionId-inclusive records bind writer session provenance, and exact terminal semantic retries return the existing RP id while conflicts fail closed',
    producerCommand: 'review_pass_set',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  review_loop_start: {
    name: 'review-loops.jsonl',
    path: 'review-loops.jsonl',
    signed: false,
    producerCommand: 'review_loop_start',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  review_loop_iteration_add: {
    name: 'review-loops.jsonl',
    path: 'review-loops.jsonl',
    signed: false,
    producerCommand: 'review_loop_iteration_add',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  review_loop_close: {
    name: 'review-loops.jsonl',
    path: 'review-loops.jsonl',
    signed: false,
    producerCommand: 'review_loop_close',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  finding_add: {
    name: 'findings.json',
    path: 'findings.json',
    signed: true,
    signature: 'signFinding/verifyFinding; reviewRunId-inclusive records do not fall back to legacy signatures',
    producerCommand: 'finding_add',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  finding_resolve: {
    name: 'findings.json',
    path: 'findings.json',
    signed: true,
    signature: 'existing finding signature remains gate-verified',
    producerCommand: 'finding_resolve',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  finding_dismiss: {
    name: 'findings.json',
    path: 'findings.json',
    signed: true,
    signature: 'existing finding signature remains gate-verified',
    producerCommand: 'finding_dismiss',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  init_check_set: {
    name: 'init-check.json',
    path: 'init-check.json',
    signed: true,
    signature: 'signInitCheck/recomputeInitCheckHash',
    producerCommand: 'init_check_set',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    reviewerLane: 'proof-or-stop-review-story-init',
  },
  init_check_repair: {
    name: 'init-check.json',
    path: 'init-check.json',
    signed: true,
    signature: 'signInitCheck/recomputeInitCheckHash',
    producerCommand: 'init_check_repair',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
  },
  scope_boundary_set: {
    name: 'scope-boundary.json',
    path: 'scope-boundary.json',
    signed: true,
    signature: 'stable scope boundary _hash over schemaVersion/storyId/mode/allowed/excluded/confirmationNote',
    producerCommand: 'scope_boundary_set',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
  },
  execution_boundary_set: {
    name: 'execution-boundary.json',
    path: 'execution-boundary.json',
    signed: true,
    signature: 'stable execution boundary _hash over schemaVersion/storyId/allowedCommands/allowedTools/excludedCommands/excludedTools',
    producerCommand: 'execution_boundary_set',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
  },
  scope_freeze_check: {
    name: 'scope-freeze-check.json',
    path: 'scope-freeze-check.json',
    signed: true,
    signature: 'stable scope freeze _hash plus freshnessHash over bounded story/checklist projection and boundary hashes',
    producerCommand: 'scope_freeze_check',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
  },
  scope_extension_proposal: {
    name: 'scope-extension-proposals.json',
    path: 'scope-extension-proposals.json',
    signed: true,
    signature: 'stable proposal _hash over proposal identity, reason, patch, reviewerRunId, status, and decision hash',
    producerCommand: 'scope_extension_proposal',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
  },
  scope_extension_decide: {
    name: 'scope-extension-proposals.json',
    path: 'scope-extension-proposals.json',
    signed: true,
    signature: 'stable decision _hash folded into proposal _hash; accepted proposals require a fresh scope freeze check',
    producerCommand: 'scope_extension_decide',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
  },
  decision_doc_proposal: {
    name: 'decision-doc-proposals.json',
    path: 'decision-doc-proposals.json',
    signed: false,
    producerCommand: 'decision_doc_proposal',
    consumerGate: 'decision_doc_save proposal freshness and target render gate',
  },
  decision_doc_save: {
    name: 'process-events.jsonl',
    path: 'process-events.jsonl',
    signed: false,
    producerCommand: 'decision_doc_save',
    consumerGate: 'decision_doc_save audit evidence and existing decision-doc quorum DONE gate through changed docs/requirements/decisions/*.md',
  },
  delivery_check_set: {
    name: 'delivery-check.json',
    path: 'delivery-check.json',
    signed: true,
    signature: 'signDeliveryCheck/recomputeDeliveryCheckHash',
    producerCommand: 'delivery_check_set',
    consumerGate: 'storyMachine.canFinish DONE gate',
    reviewerLane: 'proof-or-stop-review-delivery',
  },
  delivery_waiver_add: {
    name: 'delivery-check.json',
    path: 'delivery-check.json',
    signed: true,
    signature: 'signDeliveryCheck/recomputeDeliveryCheckHash',
    producerCommand: 'delivery_waiver_add',
    consumerGate: 'storyMachine.canFinish DONE gate',
  },
  scope_check_save: {
    name: 'scope-check.json',
    path: 'scope-check.json',
    signed: true,
    signature: 'signScopeCheck',
    producerCommand: 'scope_check_save',
    consumerGate: 'story_review scope-check gate',
    reviewerLane: 'proof-or-stop-review-scope-plan',
  },
  scope_question_resolve: {
    name: 'scope-check.json',
    path: 'scope-check.json',
    signed: true,
    signature: 'scope-check signature domain intentionally excludes main-agent resolution',
    producerCommand: 'scope_question_resolve',
    consumerGate: 'story_review open question gate',
  },
  draft_check_set: {
    name: 'draft-check.json',
    path: 'draft-check.json',
    signed: true,
    signature: 'computeDraftCheckHash',
    producerCommand: 'draft_check_set',
    consumerGate: 'story_create fromDraft preflight',
  },
  draft_issue_resolve: {
    name: 'draft-check.json',
    path: 'draft-check.json',
    signed: true,
    signature: 'draft-check signature domain intentionally excludes issue resolution',
    producerCommand: 'draft_issue_resolve',
    consumerGate: 'story_create fromDraft preflight',
  },
  summary_set: {
    name: 'summary.json',
    path: 'summary.json',
    signed: false,
    producerCommand: 'summary_set',
    consumerGate: 'story_advance DONE summary checklist',
  },
  test_add: {
    name: 'test-evidence.json',
    path: 'test-evidence.json',
    signed: false,
    producerCommand: 'test_add',
    consumerGate: 'storyMachine.canFinish DONE gate',
  },
  test_story: {
    name: 'test-evidence.json',
    path: 'test-evidence.json',
    signed: false,
    producerCommand: 'test_story',
    consumerGate: 'storyMachine.canFinish DONE gate',
  },
  validate: {
    name: 'test-evidence.json',
    path: 'test-evidence.json',
    signed: false,
    producerCommand: 'validate',
    consumerGate: 'story_advance TEST and DONE validation gate',
  },
  done_required_validate: {
    name: 'done-required-evidence.json',
    path: 'done-required-evidence.json',
    signed: false,
    producerCommand: 'done_required_validate',
    consumerGate: 'story_advance DONE done-required-validation gate',
  },
  evaluate_save: {
    name: 'eval-evidence.json',
    path: 'eval-evidence.json',
    signed: false,
    producerCommand: 'evaluate_save',
    consumerGate: 'story_advance DONE evaluator evidence gate',
  },
  verify_codex: {
    name: 'process-events.jsonl',
    path: 'process-events.jsonl',
    signed: false,
    producerCommand: 'verify_codex',
    consumerGate: 'Codex adapter REVIEW and DONE evidence gate',
  },
  autopilot_review_submit: {
    name: 'process-events.jsonl',
    path: 'process-events.jsonl',
    signed: false,
    producerCommand: 'autopilot_review_submit',
    consumerGate: 'storyMachine.canFinish DONE review escalation gate and storyMachine.canFinish DONE review assurance floor gate',
  },
  quorum_submit: {
    name: 'process-events.jsonl',
    path: 'process-events.jsonl',
    signed: false,
    producerCommand: 'quorum_submit',
    consumerGate: 'storyMachine.canFinish DONE review escalation gate and storyMachine.canFinish DONE review assurance floor gate',
  },
  review_escalation_policy_set: {
    name: 'process-events.jsonl',
    path: 'process-events.jsonl',
    signed: false,
    producerCommand: 'review_escalation_policy_set',
    consumerGate: 'storyMachine.canFinish DONE review escalation gate',
  },
  review_host_availability_probe: {
    name: 'process-events.jsonl',
    path: 'process-events.jsonl',
    signed: false,
    producerCommand: 'review_host_availability_probe',
    consumerGate: 'storyMachine.canFinish DONE review escalation gate and storyMachine.canFinish DONE review assurance floor gate',
  },
  review_escalation_fallback_set: {
    name: 'process-events.jsonl',
    path: 'process-events.jsonl',
    signed: false,
    producerCommand: 'review_escalation_fallback_set',
    consumerGate: 'storyMachine.canFinish DONE review escalation gate and storyMachine.canFinish DONE review assurance floor gate',
  },
  story_create_from_repro: {
    name: 'story-evidence-binding',
    path: 'story-evidence-binding',
    signed: false,
    producerCommand: 'story_create_from_repro',
    consumerGate: 'storyMachine.canEnterPlan IDEA to PLAN gate and storyMachine.canStartDev/canSkipPlan DEV-entry gates',
  },
};

export const PROCESS_FACT_REVIEWER_LANE_NAMES = [
  'proof-or-stop-review-story-init',
  'proof-or-stop-product-reviewer',
  'proof-or-stop-review-scope-plan',
  'proof-or-stop-review-topology-critic',
  'proof-or-stop-review-concept',
  'proof-or-stop-review-quality',
  'proof-or-stop-review-test-coverage',
  'proof-or-stop-review-behavior',
  'proof-or-stop-review-docs',
  'proof-or-stop-review-channel',
  'proof-or-stop-review-delivery',
] as const;

function isRequiredArtifactRef(artifact: ProcessFactArtifactRef): boolean {
  return artifact.signed || Boolean(artifact.consumerGate);
}

export const PROCESS_FACT_REQUIRED_ARTIFACT_NAMES = [...new Set(
  Object.values(PROCESS_FACT_ARTIFACT_BY_COMMAND)
    .filter(isRequiredArtifactRef)
    .map((artifact) => artifact.path),
)] as readonly string[];

export const PROCESS_FACT_REVIEWER_LANE_DEFINITIONS = [
  {
    name: 'reviewer-lane:proof-or-stop-review-story-init',
    producer: 'proof-or-stop-review-story-init',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    reviewerLane: 'proof-or-stop-review-story-init',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.init_check_set,
    rationale: 'INIT reviewer writes signed init-check evidence before worktree bootstrap.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-product-reviewer',
    producer: 'proof-or-stop-product-reviewer',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    reviewerLane: 'proof-or-stop-product-reviewer',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.init_check_set,
    rationale: 'Product init reviewer is a required init-check producer for user-value readiness.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-review-scope-plan',
    producer: 'proof-or-stop-review-scope-plan',
    consumerGate: 'story_review scope-check gate',
    reviewerLane: 'proof-or-stop-review-scope-plan',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.scope_check_save,
    rationale: 'PLAN scope reviewer signs scope-check evidence before implementation.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-review-topology-critic',
    producer: 'proof-or-stop-review-topology-critic',
    consumerGate: 'topology_critic_receipt_check CLI verification and review_inventory_finalize saturation gate',
    reviewerLane: 'proof-or-stop-review-topology-critic',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_inventory_critic_set,
    rationale: 'Default topology critic dispatch preserves business-author provenance. Explicit inventory-completeness dispatch derives the signed current OPEN epoch/wave/cutoff under the inventory lock, supplies no topology provenance, and requires a purpose-bound fresh ReviewRun plus terminal read evidence before signing the exact inventory critic receipt. No topology-refusal fallback or promotion to TEST/DONE.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-review-concept',
    producer: 'proof-or-stop-review-concept',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'proof-or-stop-review-concept',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Baseline concept reviewer records findings or no-blocker review pass evidence.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-review-quality',
    producer: 'proof-or-stop-review-quality',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'proof-or-stop-review-quality',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Baseline quality reviewer records findings or no-blocker review pass evidence.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-review-test-coverage',
    producer: 'proof-or-stop-review-test-coverage',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'proof-or-stop-review-test-coverage',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Coverage reviewer checks verificationIntent to verificationEvidence coverage.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-review-behavior',
    producer: 'proof-or-stop-review-behavior',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'proof-or-stop-review-behavior',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Risk-triggered behavior reviewer records findings or no-blocker evidence.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-review-docs',
    producer: 'proof-or-stop-review-docs',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'proof-or-stop-review-docs',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Docs reviewer records docs drift findings or no-blocker evidence.',
  },
  {
    name: 'reviewer-lane:proof-or-stop-review-delivery',
    producer: 'proof-or-stop-review-delivery',
    consumerGate: 'storyMachine.canFinish DONE gate',
    reviewerLane: 'proof-or-stop-review-delivery',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.delivery_check_set,
    rationale: 'Delivery reviewer signs delivery-check evidence before DONE.',
  },
] as const;

function uniqueSemantics(...groups: ReadonlyArray<readonly ProcessFactSemantic[]>): ProcessFactSemantic[] {
  const out = new Set<ProcessFactSemantic>();
  for (const group of groups) {
    for (const semantic of group) out.add(semantic);
  }
  return [...out];
}

function commandFactKind(name: string, level: ProcessFactLevel): ProcessFactKind {
  if (PROCESS_FACT_KIND_BY_COMMAND[name]) return PROCESS_FACT_KIND_BY_COMMAND[name];
  if (name.startsWith('runtime:')) return 'runtime-behavior';
  return level === 'L4' ? 'gate-evidence' : 'command';
}

function commandFactSemantics(name: string, level: ProcessFactLevel): ProcessFactSemantic[] {
  if (name.startsWith('runtime:')) {
    return uniqueSemantics(PROCESS_FACT_RUNTIME_SEMANTICS[name as keyof typeof PROCESS_FACT_RUNTIME_SEMANTICS] ?? ['runtime-behavior'], level === 'L4' ? ['gate-evidence'] : []);
  }
  const required: readonly ProcessFactSemantic[] =
    PROCESS_FACT_REQUIRED_SEMANTICS[name as keyof typeof PROCESS_FACT_REQUIRED_SEMANTICS] ?? [];
  const defaults: ProcessFactSemantic[] = [];
  if (level === 'L4') defaults.push('gate-evidence');
  if (required.length === 0 && level !== 'L4') defaults.push('command');
  return uniqueSemantics(required, defaults);
}

function artifactFactSemantics(artifact: ProcessFactArtifactRef): ProcessFactSemantic[] {
  const semantics: ProcessFactSemantic[] = ['artifact'];
  if (artifact.signed) semantics.push('signed-artifact');
  if (artifact.path === 'review-runs.json') semantics.push('review-run', 'schema-contract', 'workspace-binding', 'freshness-policy');
  if (artifact.path === 'review-loops.jsonl') semantics.push('blocker-state', 'schema-contract');
  if (artifact.path === 'test-evidence.json') semantics.push('validation-result', 'test-evidence');
  if (artifact.path === 'eval-evidence.json') semantics.push('validation-result');
  if (artifact.path === 'scope-boundary.json' || artifact.path === 'execution-boundary.json') semantics.push('schema-contract');
  if (artifact.path === 'scope-freeze-check.json') semantics.push('validation-result', 'schema-contract');
  if (artifact.path === 'scope-extension-proposals.json') semantics.push('blocker-state', 'schema-contract');
  if (artifact.path === 'scope-discard-digest.json') semantics.push('supersession-policy');
  if (artifact.path === 'decision-doc-proposals.json') semantics.push('schema-contract', 'execution-evidence');
  if (artifact.path === 'story-evidence-binding') semantics.push('schema-contract', 'workspace-binding');
  if (
    artifact.path === 'original-intent-snapshot.json'
    || artifact.path === 'milestone-ledger.json'
    || artifact.path === 'slice-plan.json'
    || artifact.path === 'parent-ledger-rollup.json'
    || artifact.path === 'proofstory.json'
    || artifact.path === 'intent-collision.json'
    || artifact.path === 'scope-shrinkage-decision.json'
    || artifact.path === 'red-evidence.json'
    || artifact.path === 'spike.json'
  ) {
    semantics.push('schema-contract', 'verification-policy');
  }
  return semantics;
}

function commandPolicy(name: string): CommandPolicy | undefined {
  return COMMAND_POLICIES[name as KnownCommandName] as CommandPolicy | undefined;
}

const COMMAND_PROCESS_FACTS: ProcessFactRegistryEntry[] = PROCESS_FACT_LEVELS
  .filter((entry: ProcessFactLevelEntry) => !entry.name.startsWith('flow-policy:'))
  .map((entry: ProcessFactLevelEntry) => {
  const policy = commandPolicy(entry.name);
  const rootOnly = policy ? policy.rootOnly === true || policy.status === 'rootOnly' : undefined;
  const gateEvidence = policy ? policy.gateEvidence === true || policy.status === 'gateEvidence' : undefined;
  return {
    name: entry.name,
    kind: commandFactKind(entry.name, entry.level),
    semantics: commandFactSemantics(entry.name, entry.level),
    level: entry.level,
    lifecycle: policy?.status,
    allowedPhases: policy?.allowedPhases,
    rootOnly,
    legacy: policy ? policy.status === 'legacy' : undefined,
    gateEvidence,
    destructiveRisk: policy?.destructiveRisk,
    producer: entry.owner,
    producerSourceRefs: ['pre_review_check', 'pre_review_check_read'].includes(entry.name)
      ? ['packages/main/src/core/pre-review-check.ts', 'packages/main/src/core/pre-review-live-proof.ts', 'scripts/run-proofstory-pre-review-live-proof.mjs']
      : ['acceptance_basis_generate', 'acceptance_basis', 'acceptance_topology_check'].includes(entry.name)
      ? ['packages/main/src/handlers/proofstory.ts', 'packages/main/src/registry.ts']
      : undefined,
    consumerGate: entry.gateConsumer,
    consumerSourceRefs: ['pre_review_check', 'pre_review_check_read'].includes(entry.name)
      ? ['packages/main/src/core/pre-review-check.ts', 'packages/main/src/handlers/transition-orchestrator.ts']
      : ['acceptance_basis_generate', 'acceptance_basis', 'acceptance_topology_check'].includes(entry.name)
      ? ['packages/main/src/core/acceptance-topology.ts', 'packages/main/src/handlers/transition-orchestrator.ts', 'scripts/verify-process-fact-contract.mjs']
      : undefined,
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND[entry.name],
    reviewerLane: PROCESS_FACT_ARTIFACT_BY_COMMAND[entry.name]?.reviewerLane,
    rationale: entry.rationale,
  };
});

export const PROCESS_FACT_FLOW_POLICIES = FLOW_FACT_POLICIES.map((policy) => ({
  name: policy.name,
  kind: 'flow-policy' as const,
  semantics: policy.semantics as readonly ProcessFactSemantic[],
  level: policy.level as ProcessFactLevel,
  producer: policy.owner,
  consumerGate: policy.consumerGate,
  artifact: 'artifactCommand' in policy && policy.artifactCommand
    ? PROCESS_FACT_ARTIFACT_BY_COMMAND[policy.artifactCommand]
    : undefined,
  rationale: policy.rationale,
})) as readonly ProcessFactRegistryEntry[];

export const PROCESS_FACT_REVIEWER_LANES = PROCESS_FACT_REVIEWER_LANE_DEFINITIONS.map((entry) => ({
  ...entry,
  kind: 'reviewer-lane' as const,
  semantics: ['reviewer-lane', 'gate-evidence'] as const,
  level: 'L4' as const,
})) as readonly ProcessFactRegistryEntry[];

export const PROCESS_FACT_ARTIFACTS = [
  {
    name: 'artifact:index.json',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/story-advance',
    consumerGate: 'storyMachine phase guards and story_advance preflight gates',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.story_advance,
    rationale: 'Story index state is consumed by lifecycle phase guards and preflight checks.',
  },
  {
    name: 'artifact:review.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/story-review',
    consumerGate: 'storyMachine.canStartDev PLAN to DEV gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.story_review,
    rationale: 'PLAN review signature is checked before DEV.',
  },
  {
    name: 'artifact:checklist.json',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/checklist',
    consumerGate: 'storyMachine.checklistAllDone DEV to REVIEW gate and validate verification coverage/freshness gates',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.checklist_update,
    rationale: 'Checklist status and verification evidence are consumed by REVIEW and validate gates.',
  },
  {
    name: 'artifact:init-check.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/init-check',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.init_check_set,
    rationale: 'Init-check signature is checked before worktree bootstrap.',
  },
  {
    name: 'artifact:scope-boundary.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'schema-contract'],
    level: 'L4',
    producer: 'handlers/scope-anti-expansion',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.scope_boundary_set,
    rationale: 'User-confirmed allowed/excluded scope is mandatory before INIT_CHECK worktree bootstrap.',
  },
  {
    name: 'artifact:execution-boundary.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'schema-contract', 'workspace-binding'],
    level: 'L4',
    producer: 'handlers/scope-anti-expansion',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.execution_boundary_set,
    rationale: 'User-confirmed execution boundary is mandatory before INIT_CHECK worktree bootstrap.',
  },
  {
    name: 'artifact:scope-freeze-check.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'validation-result', 'schema-contract'],
    level: 'L4',
    producer: 'handlers/scope-anti-expansion',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.scope_freeze_check,
    rationale: 'Fresh pass/fail anti-expansion evidence is consumed before a worktree can be created.',
  },
  {
    name: 'artifact:scope-extension-proposals.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'blocker-state', 'schema-contract'],
    level: 'L4',
    producer: 'handlers/scope-anti-expansion',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.scope_extension_proposal,
    rationale: 'Pending reviewer scope expansion proposals block INIT_CHECK until explicitly decided.',
  },
  {
    name: 'artifact:decision-doc-proposals.json',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence', 'schema-contract', 'execution-evidence'],
    level: 'L4',
    producer: 'handlers/decision-doc-promotion',
    consumerGate: 'decision_doc_save proposal freshness and target render gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.decision_doc_proposal,
    rationale: 'Story-local decision-doc proposals bind drafted policy content, source decision digest, target path, and save records before durable decision docs are materialized.',
  },
  {
    name: 'artifact:scope-discard-digest.json',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence', 'supersession-policy'],
    level: 'L4',
    producer: 'handlers/worktree story_discard',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.story_discard,
    rationale: 'Discarded story direction digests prevent repeated discarded work from being recreated without mitigation.',
  },
  {
    name: 'artifact:scope-check.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/scope-check',
    consumerGate: 'story_review scope-check gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.scope_check_save,
    rationale: 'Scope-check signature is consumed by PLAN review.',
  },
  {
    name: 'artifact:candidate-spec-set.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'freshness-policy', 'workspace-binding', 'verification-policy'],
    level: 'L4',
    producer: 'handlers/candidate-spec-routing',
    consumerGate: 'scope_check_save, reviewer read-evidence candidate routing gate, and review inventory candidate-universe freshness gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.candidate_spec_route,
    rationale: 'Candidate routing artifact binds deterministic seeds, corpus digest, rollout mode, pre-budget query filtering, typed protected direct sources/missing diagnostics, bounded ordinary-only ranking/cutoff, optional sanitized host proposals, query-level omitted-score/cutoff truncation evidence, current freshness, and a fail-closed enforce-mode requiresEscalation/fullScan resolution fact for PLAN and REVIEW consumers; shadow/warn retain nonblocking diagnostics.',
  },
  {
    name: 'artifact:original-intent-snapshot.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.original_intent_snapshot_set,
    rationale: 'Original intent snapshot freezes sourceText/keyRequirementIds into an immutable requestHash for progressive intent diagnostics and opt-in enforcement.',
  },
  {
    name: 'artifact:acceptance-basis.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory.acceptance_basis_generate',
    producerSourceRefs: ['packages/main/src/handlers/proofstory.ts', 'packages/main/src/registry.ts'],
    consumerGate: 'acceptance_topology_check and transition-orchestrator PLAN to DEV structural gate',
    consumerSourceRefs: ['packages/main/src/core/acceptance-topology.ts', 'packages/main/src/handlers/proofstory.ts', 'packages/main/src/handlers/transition-orchestrator.ts', 'scripts/verify-process-fact-contract.mjs'],
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.acceptance_basis_generate,
    rationale: 'Verifier-only PLAN coverage basis receipt binds the registered adapter profile and full adapter results, deterministic union, planned paths, topology/scope/workspace identity, storyFilesHash, closureFilesHash, and the structured snapshotSeal/sealDigest integrity fact. The canonical topology evaluator verifies it before PLAN to DEV; no read-only caller can mint or rebind it.',
  },
  {
    name: 'artifact:pre-review-check.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'execution-evidence', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory.pre_review_check',
    producerSourceRefs: ['packages/main/src/core/pre-review-check.ts', 'packages/main/src/core/pre-review-live-proof.ts', 'scripts/run-proofstory-pre-review-live-proof.mjs'],
    consumerGate: 'pre_review_check_read and transition-orchestrator DEV to REVIEW executable gate',
    consumerSourceRefs: ['packages/main/src/core/pre-review-check.ts', 'packages/main/src/handlers/transition-orchestrator.ts'],
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.pre_review_check,
    rationale: 'Verifier-owned signed pre-review artifact binds the recomputed current-worktree basis, artifact-kind/runtime-aware planned-to-actual reconciliation, and the gzip-carried canonical machine records emitted only after the bounded production scenario ledger executes. The loader requires every exact current-topology assertion ID, kind, and canonical sourceRef with no missing/extra/duplicate rows; records are assembled by ID rather than positional kind queues, so permutations or swaps cannot reattribute executed outcomes. It also requires distinct mutation target/kind pairs, observed polarity plus clean controls, ordered producer/consumer events, and a mechanically recomputed aggregate root. Both live loading and signed-artifact readback compare proof provenance against the current tracked runner and built target; the fixed runner performs a fresh build before emission. Stale runner/target bytes, stale gitignored dist, arbitrary formatted digests, hard-coded story/counts, arbitrary commands, raw verificationEvidence checkedClaims/actorTrust, and global transcript presence grant no authority. The artifact also binds the strict cutoff, topology/scope/story/closure hashes, flat project mode, and enforced independent critic re-attestation. Non-enforcing semantic readback retains the signed artifact critic-receipt digest so legal reviewer receipt renewal alone is not mislabeled as tampering; enforce mode remains bound to the current critic receipt while signature and basis/story/closure drift checks stay fail-closed.',
  },
  {
    name: 'artifact:acceptance-rollout-report.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'execution-evidence', 'host-verdict', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory.acceptance_rollout_report',
    producerSourceRefs: ['scripts/run-proofstory-acceptance-rollout-cohort.mjs', 'packages/main/src/core/acceptance-rollout.ts', 'packages/main/src/handlers/proofstory.ts'],
    consumerGate: 'acceptance_rollout_report_read, acceptance_rollout_check, and transition-orchestrator DEV to REVIEW rollout gate',
    consumerSourceRefs: ['packages/main/src/core/acceptance-rollout.ts', 'packages/main/src/handlers/proofstory.ts', 'packages/main/src/handlers/transition-orchestrator.ts', 'scripts/verify-process-fact-contract.mjs'],
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.acceptance_rollout_report,
    rationale: 'Versioned verifier-owned report freezes every eligible source record in the declared window and deterministically derives membership, metrics, diagnostics, and verdict. The signed receipt binds source inventory, >=3 matched pairs in each arm, every registered seed, zero false pass, 100% omission detection, zero false block, zero mislabeled 3x1, non-positive waiver delta, non-shrinking inventory, supported adapters, genuine full-3x2, runner digest, and current workspace hashes. Rollback changes only flat project mode and preserves this artifact.',
  },
  {
    name: 'artifact:topology-exclusion-approvals.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'reviewer-lane'],
    level: 'L3',
    producer: 'handlers/proofstory.topology_exclusion_approval_set',
    producerSourceRefs: ['packages/main/src/core/topology-critic-receipt.ts', 'packages/main/src/handlers/proofstory.ts', 'packages/main/src/core/agent-dispatch-registry.ts'],
    consumerGate: 'topology_critic_receipt_set and topology_critic_receipt_check',
    consumerSourceRefs: ['packages/main/src/core/topology-critic-receipt.ts', 'packages/main/src/handlers/proofstory.ts', 'scripts/verify-process-fact-contract.mjs'],
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.topology_exclusion_approval_set,
    rationale: 'Every topology exclusion is covered exactly once by a signed current proof-or-stop-review-scope-plan approval that is independently attributable from both implementation and critic provenance.',
  },
  {
    name: 'artifact:topology-critic-receipt.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'verification-policy', 'freshness-policy', 'workspace-binding', 'reviewer-lane'],
    level: 'L3',
    producer: 'handlers/proofstory.topology_critic_receipt_set',
    producerSourceRefs: ['packages/main/src/core/topology-critic-receipt.ts', 'packages/main/src/handlers/proofstory.ts', 'packages/main/src/core/agent-dispatch-registry.ts'],
    consumerGate: 'topology_critic_receipt_check CLI verification only',
    consumerSourceRefs: ['packages/main/src/core/topology-critic-receipt.ts', 'packages/main/src/handlers/proofstory.ts', 'scripts/verify-process-fact-contract.mjs'],
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.topology_critic_receipt_set,
    rationale: 'The eligible critic receipt signs complete current basis/topology/scope/story/closure bindings, deterministic findings/exclusions, verdict/time, and four-dimensional actor/implementation provenance. Partial or unsupported discovery remains non-pass.',
  },
  {
    name: 'artifact:milestone-ledger.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.milestone_ledger_set,
    rationale: 'Milestone ledger makes multi-deliverable intent countable; candidate rows guide diagnostics and confirmed rows can be gate-consumed.',
  },
  {
    name: 'artifact:milestone-closeout.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/milestone-status',
    consumerGate: 'DONE-phase milestone_status and milestone_closeout snapshot-first read path (snapshot-only; never re-blocks DONE)',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.milestone_closeout_capture,
    rationale: 'Milestone closeout snapshot freezes the DONE-time milestone report (schemaVersion-checked) so later reads stay stable without recomputing live freshness; it is written by the story_advance DONE capture in handlers/milestone-status and never re-gates DONE.',
  },
  {
    name: 'artifact:slice-plan.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DEV admission and DONE intent-equivalence gates',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.slice_plan_set,
    rationale: 'Slice plans bind oversized ledger exceptions to the current ledger hash and complete milestone coverage without auto-creating child stories.',
  },
  {
    name: 'artifact:parent-ledger-rollup.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DONE intent-equivalence gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.parent_ledger_rollup_set,
    rationale: 'Parent ledger roll-up records child-story coverage for slice-plan DONE equivalence.',
  },
  {
    name: 'artifact:closeout-write-receipts.jsonl',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'freshness-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'core/auto-commit-metadata',
    consumerGate: 'review-run metadata-only retention classifier (artifact gate validation remains independent)',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.closeout_write_receipt,
    rationale: 'Append-only integrity-chained cooperative local-runtime lineage. It may classify a registered nonmaterial closeout write as a review-retention descendant only when material, story-owned files, scope, review round, and HEAD evaluation remain unchanged. writerCommand is a registered writer label, not same-UID authentication; this lineage does not approve an artifact, and artifact gate validation remains independent.',
  },
  {
    name: 'artifact:evidence/delivery-context-pack.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy'],
    level: 'L3',
    producer: 'handlers/delivery-context-pack',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.delivery_context_pack,
    rationale: 'Delivery context is a runtime-validated canonical closeout input, not a signed delivery verdict and not authority evidence.',
  },
  {
    name: 'artifact:proofstory.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.proofstory_contract_set,
    rationale: 'ProofStory contract stores hardening level, trigger reasons, acceptance bindings, and diagnostic gaps for diagnostics and opt-in enforcement.',
  },
  {
    name: 'artifact:intent-collision.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.intent_collision_set,
    rationale: 'Intent collision records accepted interpretation decisions; pass confirms candidate ledger rows for gate consumption.',
  },
  {
    name: 'artifact:scope-shrinkage-decision.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.scope_shrinkage_decision_set,
    rationale: 'Scope shrinkage decisions explicitly preserve audit trail when DONE delivery no longer covers a required milestone.',
  },
  {
    name: 'artifact:red-evidence.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.red_evidence_create,
    rationale: 'Red evidence records pre-fix failures bound to baseline head/material and a green relation target; it remains distinct from green verificationEvidence.',
  },
  {
    name: 'artifact:spike.json',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'verification-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/proofstory',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.spike_start,
    rationale: 'Spike evidence records investigation state and disposable code policy; it never satisfies red or verification evidence unless separately promoted by explicit commands.',
  },
  {
    name: 'artifact:delivery-check.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/delivery-check',
    consumerGate: 'storyMachine.canFinish DONE gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.delivery_check_set,
    rationale: 'Delivery-check signature is consumed by DONE. Its docsPromises use the shared total delivery-promise outcome normalizer: contradictions fail closed, explicit unverified stays unresolved, and only missing-status legacy rows use bounded inference. The signature folds in storyFilesHash: whole-tree materialHash drift with a matching signed storyFilesHash downgrades to a mandatory re-attestation advisory (delivery_check_drift_advisory), while a story-owned change or missing storyFilesHash stays strict stale.',
  },
  {
    name: 'artifact:prompt-envelopes.json',
    kind: 'artifact',
    semantics: ['artifact', 'prompt-envelope', 'schema-contract'],
    level: 'L1',
    producer: 'handlers/agent-prompt + handlers/review-run',
    consumerGate: 'story-dispatch rows are audit-only; review-run rows are verified through signed ReviewRun envelopeId by REVIEW and quorum gates; the assurance floor consumes host-verdict rounds emitted after quorum admission',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.agent_prompt,
    rationale: 'Content-addressed full Prompt Envelopes are append-only. createdAt is provenance outside the envelopeId digest; story-dispatch cannot carry reviewer authority. Review-run envelopes bind roleId/lane, the exact story-dispatch prompt bytes, host identity, delivered assembledPrompt, and an immutable as-of-run finding projection plus digest. Verification snapshots preserve optional-property absence, canonical integrity and trusted-prior selection while isolating valid arrays; explicit malformed values remain rejected, never normalized or re-signed. Later mutable finding disposition metadata therefore cannot rewrite historical eligibility. Unsupported hosts fail closed and review_run_start supplies exactly one selected role-body render.',
  },
  {
    name: 'artifact:review-runs.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'review-run', 'prompt-envelope', 'schema-contract', 'workspace-binding', 'freshness-policy'],
    level: 'L4',
    producer: 'handlers/review-run',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_run_start,
    rationale: 'Signed reviewer runs bind current REVIEW findings and passes to a fresh lane-specific boundary, including ReviewRun.storyFilesHash for unrelated main-drift freshness and, in full-envelope mode, the exact canonical assembledPrompt bytes delivered by review_run_start.',
  },
  {
    name: 'artifact:review-inventory-epochs.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'schema-contract', 'freshness-policy', 'workspace-binding', 'reviewer-lane', 'no-blocker-evidence'],
    level: 'L4',
    producer: 'handlers/review-inventory',
    producerSourceRefs: ['packages/main/src/core/review-inventory-epoch.ts', 'packages/main/src/handlers/review-inventory.ts'],
    consumerGate: 'storyMachine.canReenterDev REVIEW to DEV inventory remediation/completeness gate and certification_window_begin',
    consumerSourceRefs: ['packages/main/src/core/machine.ts', 'packages/main/src/handlers/transition-orchestrator.ts'],
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_inventory_finalize,
    rationale: 'Signed epochs freeze REVIEW material/scope/round/required lanes plus complete checklist and effective ProofStory acceptance contract/dispositions; signed critic receipts bind complete per-finding verified-family/duplicate/not-verified dispositions plus pass/finding read evidence; signed inventory receipts either prove bounded zero-new verified-finding saturation or explicitly grant review-remediation-only authority after a complete critic-certified wave; remediation-only receipts cannot enter certification. Both are revalidated against the live acceptance subject, and are single-use for aggregated remediation DEV, never TEST authority. Inventory-completeness receipts bind current head/material/storyFiles hashes; authorizesTest stays false and completeness is not PRE_CERT.',
  },
  {
    name: 'artifact:findings.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'blocker-state', 'finding-state'],
    level: 'L4',
    producer: 'handlers/finding',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.finding_add,
    rationale: 'Reviewer finding signatures prevent main-agent forgery.',
  },
  {
    name: 'artifact:finding-ledger.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'atomic-persistence'],
    level: 'L2',
    producer: 'handlers/finding + handlers/finding-ledger',
    artifact: {
      name: 'finding-ledger.json',
      path: 'finding-ledger.json',
      signed: true,
      signature: 'signFindingLedgerReceipt/verifyFindingLedgerReceipt; every committed semantic row is covered by an exact signed commit receipt',
      producerCommand: 'finding_add/finding_runtime_evidence_run',
    },
    rationale: 'Append-only Finding persistence carrier and REVIEW-retention metadata. It has no lifecycle/gate authority; protected query and runtime verification establish its receipt trust independently.',
  },
  {
    name: 'artifact:finding-ledger-lifecycle-transition',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'atomic-persistence', 'gate-evidence', 'blocker-state', 'finding-state'],
    level: 'L4',
    producer: 'handlers/finding.appendFindingLifecycleTransition + handlers/finding-ledger.bindLegacyFindingLedgerReceipts',
    consumerGate: 'StoryStore.readFindings projection consumed by storyMachine.canPassReview REVIEW to TEST gate',
    artifact: {
      name: 'finding-ledger-lifecycle-transition',
      path: 'finding-ledger.json',
      signed: true,
      signature: 'FindingLedgerReceipt covers the immutable finding_lifecycle_transition record and exact source-record CAS binding; pre-upgrade nested-digest omission additionally requires a current exact-signed legacy_lifecycle_receipt_binding over exact carrier/record/source/chain bytes',
      producerCommand: 'finding_resolve/finding_dismiss',
      consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    },
    rationale: 'Only a current exact-signed finding_lifecycle_transition, or the same current-key pre-upgrade transition with a unique valid current exact-signed legacy_lifecycle_receipt_binding, carries terminal Finding authority; the binding alone and all other ledger rows retain narrower levels.',
  },
  {
    name: 'artifact:finding-ledger-projection',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'schema-contract', 'atomic-persistence', 'gate-evidence', 'blocker-state', 'finding-state'],
    level: 'L4',
    producer: 'handlers/finding-ledger.createAuthoritativeFindingMutation',
    consumerGate: 'StoryStore.readFindings projection consumed by storyMachine.canPassReview REVIEW to TEST gate',
    artifact: {
      name: 'finding-ledger-projection',
      path: 'finding-ledger.json',
      signed: true,
      signature: 'FindingLedgerReceipt covers each immutable finding_projection record and its exact source-record/current-chain CAS binding',
      producerCommand: 'audit/gap_log/finding_cluster/finding_list/validate/signature_backfill',
      consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    },
    rationale: 'Legacy live mutation surfaces gain durable exactly-once current-state authority only through a current-key exact-signed source-bound projection; unsigned findings.json changes remain non-authoritative.',
  },
  {
    name: 'artifact:review-passes.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'review-pass', 'prompt-envelope', 'no-blocker-evidence'],
    level: 'L4',
    producer: 'handlers/finding',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'No-blocker review pass signatures are accepted by the review gate.',
  },
  {
    name: 'artifact:review-loops.jsonl',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence', 'blocker-state', 'schema-contract'],
    level: 'L4',
    producer: 'handlers/review-loop',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_loop_start,
    rationale: 'Review reflection loop start/iteration/close records provide REVIEW blocker-state for bounded retry and escalation policy.',
  },
  {
    name: 'artifact:certification-window.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'blocker-state', 'freshness-policy', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/certification-window',
    consumerGate: 'done_required_validate / validate --full PRE_CERT certification-window gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.certification_window_begin,
    rationale: 'Signed CertificationWindow and PRE_CERT receipt bind frozen head/main/storyFiles identity. Exact canonical artifact-releases.jsonl and capability-releases.jsonl paths are review-subject causal inputs bound to actual Git blobs/tombstones, with integration/test dependency invalidation; release provenance is never gate evidence and unknown paths fail closed. Inventory completeness receipts never authorize certification.',
  },
  {
    name: 'artifact:draft-check.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence'],
    level: 'L3',
    producer: 'handlers/draft-check',
    consumerGate: 'story_create fromDraft preflight',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.draft_check_set,
    rationale: 'Draft check signature protects reviewed draft inputs before story creation.',
  },
  {
    name: 'artifact:summary.json',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/summary',
    consumerGate: 'story_advance DONE summary checklist',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.summary_set,
    rationale: 'DONE summary content is consumed by completion and delivery gates.',
  },
  {
    name: 'artifact:test-evidence.json',
    kind: 'artifact',
    semantics: ['artifact', 'validation-result', 'test-evidence', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/verifier',
    consumerGate: 'storyMachine.canFinish DONE gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.validate,
    rationale: 'Validation status artifact is required before DONE; zero-command reuse must use the shared immutable-tree/CAS metadata primitive to commit canonical PASS, terminal, and receipt before returning PASS.',
  },
  {
    name: 'artifact:done-required-evidence.json',
    kind: 'artifact',
    semantics: ['artifact', 'validation-result', 'execution-evidence', 'schema-contract', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/done-required-validation',
    consumerGate: 'story_advance DONE done-required-validation gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.done_required_validate,
    rationale: 'Opt-in DONE-required command receipts are consumed by the local DONE oracle separately from ordinary TEST validation evidence, with coverage and identity rechecked against the active policy. done_prepare may skip execution only after that canonical evaluator passes, every path touched by every intervening commit is trusted story metadata, and HEAD remains stable across evaluation. Command/phase/CLI-idle/CLI-max timeout terminals are structured and retain cleanup before result emission. The configured root suite consumes the retired vocabulary guard; its test-only envelope mutation loader admission requires exact call shape, whole-source fingerprint and producer provenance, with drift and rebinding rejection controls. Loader admission is not a validation PASS or a dynamic-code exemption.',
  },
  {
    name: 'artifact:declared-artifacts.json',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/artifact-declare',
    consumerGate: 'dirty-worktree classifier and DONE declared artifact gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.artifact_declare,
    rationale: 'Declared product artifacts are consumed by dirty-worktree classification and DONE reference checks.',
  },
  {
    name: 'artifact:eval-evidence.json',
    kind: 'artifact',
    semantics: ['artifact', 'validation-result', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/evaluate',
    consumerGate: 'story_advance DONE evaluator evidence gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.evaluate_save,
    rationale: 'Evaluator evidence artifact is consumed by DONE for browser projects.',
  },
  {
    name: 'artifact:process-events.jsonl',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/verify-codex',
    consumerGate: 'Codex adapter REVIEW and DONE evidence gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.verify_codex,
    rationale: 'Codex adapter verification evidence is recorded in process events and consumed by adapter gates.',
  },
  {
    name: 'artifact:story-evidence-binding',
    kind: 'artifact',
    semantics: ['artifact', 'schema-contract', 'workspace-binding', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/repro-intake',
    consumerGate: 'storyMachine.canEnterPlan IDEA to PLAN gate and storyMachine.canStartDev/canSkipPlan DEV-entry gates',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.story_create_from_repro,
    rationale: 'Story evidence binding artifacts bind accepted repro candidate evidence to a story before material-code bug/feature stories may enter PLAN or DEV.',
  },
] as const satisfies readonly ProcessFactRegistryEntry[];

export const PROCESS_FACT_SIGNED_ARTIFACTS = PROCESS_FACT_ARTIFACTS.filter(
  (entry) => entry.artifact?.signed === true,
) as readonly ProcessFactRegistryEntry[];

/**
 * L4 predicates shared by the real TEST→DONE guard and the read-only
 * done_closure/done_prepare projection. These entries make the projection's
 * consumption explicit without making the shared read-only projection an
 * evidence producer. The full done_prepare command can execute mutating steps.
 */
export const PROCESS_FACT_DONE_PREFLIGHT_CONSUMERS = [
  {
    name: 'runtime:done_shared_predicate_projection',
    kind: 'runtime-behavior',
    semantics: ['runtime-behavior', 'schema-contract', 'blocker-state', 'gate-evidence'],
    level: 'L4',
    producer: 'core/machine evaluateDonePredicates ordered lazy outcomes',
    consumerGate: 'storyMachine.canFinish DONE gate and buildDoneChecklist done_closure/done_prepare preflight',
    rationale: 'The boolean DONE gate and diagnostic consume the first failed shared outcome. Active readiness generically projects every failure, including future predicates, and preserves stricter preflight failures. Explicit actual-DONE snapshot inspection retains the pre-existing historical artifact/assurance presentation, not a new admission attempt; reviewer eligibility is informational, never a fresh PASS or full historical audit. TEST cannot select that exception. Rejected delivery contents are not traversed. Literal code/row identities, finite adapter syntax, and executable mutations guard this boundary without claiming arbitrary TypeScript semantic equivalence.',
  },
  {
    name: 'runtime:done_finish_decision_presence',
    kind: 'runtime-behavior',
    semantics: ['runtime-behavior', 'schema-contract', 'blocker-state', 'gate-evidence'],
    level: 'L4',
    producer: 'core/machine evaluateDonePredicates via core/playbook-runtime-memory readDevMemoryFinishDecision',
    consumerGate: 'storyMachine.canFinish DONE gate and buildDoneChecklist done_closure/done_prepare preflight',
    rationale: 'DONE and its read-only preflight projection consume the same fail-closed finish-decision presence predicate. A missing or malformed record yields missing_dev_memory_finish_decision; the projection reads but never creates or repairs the record.',
  },
  {
    name: 'runtime:done_phase_agnostic_reviewer_verdict',
    kind: 'runtime-behavior',
    semantics: ['runtime-behavior', 'freshness-policy', 'review-run', 'review-pass', 'blocker-state', 'gate-evidence'],
    level: 'L4',
    producer: 'core/machine evaluateDonePredicates via evaluateReviewVerdict',
    consumerGate: 'storyMachine.canFinish DONE gate and buildDoneChecklist done_closure/done_prepare preflight',
    rationale: 'DONE and its read-only preflight projection call the same phase-agnostic evaluateReviewVerdict predicate. Dynamic reviewer verdict codes use the shared review-verdict row; only review_evidence_invalid is presented through the established stale_closeout_review compatibility code, and reviewer evidence is never rebound or rewritten.',
  },
] as const satisfies readonly ProcessFactRegistryEntry[];

export interface DonePreflightPredicateInventoryEntry {
  blockerCode: string;
  processFactName: string;
  oracleRowId: string;
}

/**
 * Every literal machine-readable blocker code in machine.ts's shared
 * evaluateDonePredicates generator must be represented here. The DONE branch
 * and boolean guard are thin consumers of its first failed result; the oracle
 * projects all failed results without a manually maintained row whitelist.
 * The verifier checks source-owned code/row identities, finite adapter shapes,
 * and executable propagation/mutation witnesses. It does not attempt to prove
 * semantic equivalence between arbitrary independently written predicates.
 */
export const DONE_PREFLIGHT_PREDICATE_INVENTORY = [
  {
    blockerCode: 'delivery_check_tampered',
    processFactName: 'artifact:delivery-check.json',
    oracleRowId: 'delivery-check',
  },
  {
    blockerCode: 'live_smoke_transcript_failed',
    processFactName: 'runtime:live_smoke_transcript_done_gate',
    oracleRowId: 'live-smoke-transcript',
  },
  {
    blockerCode: 'missing_delivery_check',
    processFactName: 'artifact:delivery-check.json',
    oracleRowId: 'delivery-check',
  },
  {
    blockerCode: 'missing_dev_memory_finish_decision',
    processFactName: 'runtime:done_finish_decision_presence',
    oracleRowId: 'dev-memory-finish-decision',
  },
  {
    blockerCode: 'stale_closeout_review',
    processFactName: 'runtime:done_phase_agnostic_reviewer_verdict',
    oracleRowId: 'review-verdict',
  },
  {
    blockerCode: 'stale_delivery_check',
    processFactName: 'artifact:delivery-check.json',
    oracleRowId: 'delivery-check',
  },
  {
    blockerCode: 'unverified_promise',
    processFactName: 'runtime:delivery_promise_outcome_done_gate',
    oracleRowId: 'delivery-check',
  },
] as const satisfies readonly DonePreflightPredicateInventoryEntry[];

export const PROCESS_FACT_CLOSEOUT_TELEMETRY = [
  {
    name: 'runtime:closeout_phase_transition',
    kind: 'runtime-behavior',
    semantics: ['runtime-behavior', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/transition-orchestrator',
    consumerGate: 'done_prepare convergence acceptance',
    rationale: 'Typed from/to phase transitions bind attempt, review round, materialHash, and storyFilesHash so metadata-only rollback counts are mechanically derived. The gated PLAN->INIT reopen records three further durable audit semantics on the same append-only, appended-only-on-success event: transitionType: "reopen" marks the backward reopen so it is distinguishable from a forward transition, reason carries the operator reason already validated at the REOPEN remap (non-blank, at least REOPEN_REASON_MIN characters) so a validated reason is never dropped, and reopenAuditId carries the recovery idempotency key. All three are strictly additive and are set ONLY on a REOPEN; every ordinary transition must omit them and keep its exact prior event shape. RECOVERY SEMANTICS (B-70a6 F-004): the phase write and this event append are two separate fs operations, so a crash between them once left a committed reopen with NO audit record — unrecoverable, because REOPEN only fires FROM PLAN and the story had already left the only phase that could retry it. The reopen therefore writes a pendingReopenAudit recovery record (auditId, verbatim reason, fromPhase, at, materialHash, storyFilesHash, reviewRound) onto the story index in the SAME atomic writeStory rename that persists phase=INIT, so the reason is durable the instant the reopen commits; reconcilePendingReopenAudit then emits any missing event at the next ORCHESTRATED transition and clears the record, narrowed further by the OUT-OF-BAND PHASE MUTATIONS and CONCURRENCY RESIDUAL paragraphs below and never on an arbitrary read-only command. Recovery is idempotent by exact reopenAuditId identity, never by reason text: a missing event is appended exactly once, an already-audited record is cleared without appending, and the clear happens only after the event is durable. The record can only exist because the phase write it rode committed, so an aborted or refused reopen leaves neither record nor event and nothing can later fabricate a transition that did not happen. The record and reopenAuditId are audit-only recovery bookkeeping, not gate evidence: no gate consumes them, and the convergence counters above stay derived from the typed from/to phases. OUT-OF-BAND PHASE MUTATIONS (B-70a6 F-005): runStoryTransitionInner is NOT the only writer of story.phase, so the F-004 reconciliation at its entry does not by itself make the invariant framework-wide. Two production sites mutate story.phase directly through store.writeStory: story_discard (handlers/worktree.ts) and the story_reconcile zombie repair (handlers/story-query.ts). Both write a TERMINAL phase (DISCARDED / DONE) that has no outgoing machine edge, and story_discard additionally force-deletes the worktree and branch, so an unaudited reopen there was lost PERMANENTLY rather than deferred to the next transition. Both sites must therefore call reconcileReopenAuditBeforeOutOfBandPhaseChange BEFORE their destructive steps and before their phase write. That rescue reads the record from the DOOMED copy when necessary, because cli/runtime-root.ts redirects story_discard to the MAIN root while the reopen is cwd-gated into the worktree, so the handler store cannot see the record; it then appends the event to the SURVIVING store through the same reconcilePendingReopenAudit, keeping ONE append site and the same exact-auditId idempotency. The rescue never blocks the operation: discarding or reconciling a story stays legitimate, and every failure is surfaced as a warning instead of thrown, including a doomed copy that exists but cannot be read (corrupt index.json, permission error); the single deliberate silence is a doomed copy that holds no story metadata at all, which is a no-op rather than a failure. Declared residuals: the record on the DOOMED copy is deliberately not cleared, because writing into a worktree that is about to be status-checked could turn it dirty and refuse a non-force discard, so a destructive step that fails can later yield a DUPLICATE event sharing one auditId, never a lost one; and story_discard --purge removes the story metadata directory holding the log this event is appended to, so a rescued event does not survive a purge, an explicit erase of every process event this story holds rather than a silent audit loss. Stated to the precision that is actually verified: the git rollback purge performs may restore an OLDER committed copy of that directory, so metadata files can remain on disk after a purge, but that copy predates the rescue and never carries the rescued event. CONCURRENCY RESIDUAL (B-70a6 F-013): the out-of-band rescue is a one-time scan that does not hold the per-story transition lock, so it serializes against nothing. A PLAN->INIT reopen that commits its recovery record AFTER that scan has already run can still have that record destroyed by the same story_discard, and the reopen then dies against the removed worktree, so neither the record nor the event survives. The guarantee is therefore SEQUENTIAL and is claimed only at that strength: a reopen whose record is already on disk when the terminal operation starts is recovered, by the next orchestrated transition or by these two sites, while a reopen racing the terminal operation is not covered; a separate lock-independent case is story_discard --force on a story whose worktree is already gone, where the record only ever lived in that worktree and no mutex could have saved it. It is named rather than locked, and B-70a6 F-014 corrected the reason recorded for that. The earlier text argued that the transition-cas persist claim, a fail-fast 15s claim built for a millisecond fully synchronous section, could not be stretched across the git work story_discard performs. That argument was misdirected: the persist claim was never the candidate primitive. The only candidate is acquireStoryTransitionLock, whose 120s stale threshold is documented as generously exceeding any legitimate long transition, and story_discard is itself fully synchronous, so the millisecond-section objection never applied to it. The accurate reasons are three. First, acquireStoryTransitionLock is documented as a best-effort advisory contention reducer that is not the correctness guarantee and is disabled outright by PROOF_OR_STOP_TEST_DISABLE_TRANSITION_ADVISORY_LOCK, so taking it could narrow this window but never close it and the claim would still be SEQUENTIAL, which makes this a defence-in-depth question and not a correctness one. Second, story_discard is the recovery command an operator reaches for when a story is already wedged, and that lock exposes no fail-fast option: an acquire polls its 180s deadline and then throws, and a leaked lock whose recorded pid has been recycled by an unrelated live process is classified active and never stale-reclaimed at any age, so the recovery command would hang behind a lock file; the one shape without that hazard, a non-blocking try-acquire that proceeds unlocked on failure, was considered and declined because it covers only a reopen that has not yet taken the lock while leaving a mutex that reads as a serialization it does not provide. Third, and specific to story_reconcile rather than to story_discard, that repair already runs inside the main write lock, so acquiring the transition lock there would invert the established transitionLock to mainWriteLock order and let a repair block the main write lock while a DONE holding the transition lock fail-fasts on it; story_discard is not in that position, because its main write lock calls all come after the rescue and after the destruction. Hardening that race is a follow-up story and is not claimed here.',
  },
  {
    name: 'runtime:closeout_reviewer_reattestation_boundary',
    kind: 'runtime-behavior',
    semantics: ['runtime-behavior', 'review-run', 'review-pass', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/review-run review_run_start + handlers/finding review_pass_set',
    consumerGate: 'done_prepare convergence acceptance',
    rationale: 'Signed completed reviewer run/pass pairs on the same attempt, materialHash, storyFilesHash, and reviewRound remain total telemetry. The first completed identity per lane is ordered by verified ReviewPass.createdAt with reviewRunId/pass id tie-breakers, independent of run start order. Re-attestations completed before TEST entry are exempt; completion at or after TEST entry increments the fail-closed post-TEST counter.',
  },
  {
    name: 'runtime:closeout_human_confirmation',
    kind: 'runtime-behavior',
    semantics: ['runtime-behavior', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/story story_resume',
    consumerGate: 'done_prepare convergence acceptance',
    rationale: 'A successful human convergence-breaker acknowledgement emits a durable typed event inside the active review attempt.',
  },
  {
    name: 'runtime:closeout_validation_terminal',
    kind: 'runtime-behavior',
    semantics: ['runtime-behavior', 'validation-result', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/verifier',
    consumerGate: 'done_prepare convergence acceptance',
    rationale: 'Routine validation terminals bind attempt, command-set identity, disposition, commandExecutions, materialHash, and storyFilesHash, grouped per commandSetHash, materialHash, and storyFilesHash for duplicate-suite accounting. Blocking unchangedSuiteExecutions counts only per-group duplicate executed terminals at or after TEST entry (facts.testEntryAt, B-f824) plus reused terminals with commandExecutions > 0 in any phase; reviewWindowSuiteExecutions records whole-window per-group duplicates as observable, never-blocking telemetry.',
  },
] as const satisfies readonly ProcessFactRegistryEntry[];

export const PROCESS_FACT_REQUIRED_ARTIFACTS = PROCESS_FACT_ARTIFACTS.filter(
  (entry) => entry.artifact && PROCESS_FACT_REQUIRED_ARTIFACT_NAMES.includes(entry.artifact.path as typeof PROCESS_FACT_REQUIRED_ARTIFACT_NAMES[number]),
) as readonly ProcessFactRegistryEntry[];

// Lab maintenance is an explicit local integration exception, never Story evidence.
export const PROCESS_FACT_LAB_MAINTENANCE = [{
  name: 'runtime:lab_local_maintenance_integration',
  kind: 'runtime-behavior',
  semantics: ['runtime-behavior', 'validation-result', 'gate-evidence'],
  level: 'L4',
  producer: 'scripts/lab-worktree.mjs',
  consumerGate: 'Lab finish only; never Story REVIEW/TEST/DONE',
  rationale: 'Explicit local finish requires a keyed tool-recorded RED command and fresh committed GREEN; replays after synchronizing main and on the prepared candidate and main. The shared main write lock, unchanged HEAD checks, synchronized version helper and fast-forward-only merge protect integration. Cleanup requires post-merge verification and ancestor reachability and never force-deletes. These local records grant no formal Story or signed product-release credentials.',
}] as const satisfies readonly ProcessFactRegistryEntry[];

export const PROCESS_FACT_VALIDATION_EXECUTION = [{
  name:'runtime:acceptance_history_checkpoint',kind:'runtime-behavior',semantics:['runtime-behavior','signed-artifact','gate-evidence','verification-policy'],level:'L4',producer:'core/verification-intent-checkpoint',producerSourceRefs:['packages/main/src/core/verification-intent-checkpoint.ts','packages/main/src/core/verification-intent-amendment.ts','packages/main/src/core/store.ts','packages/main/src/handlers/checklist.ts'],consumerGate:'canonical checklist reads, all gate callers and owner-only checkpoint recovery',rationale:'Authorized INIT/PLAN revisions append signed lineage without rewriting history or bypassing field authority. Revisions reopen planning; old gate evidence retains normal freshness checks. A signed write-ahead full checklist checkpoint in shared Git metadata detects history-field deletion and restores interrupted projection without rerunning commands. Typed integrity errors propagate instead of becoming empty checklists. The Git signing key and checkpoint metadata remain a local trust boundary, not hostile-host protection.',
}, {
  name: 'runtime:execution_implementation_pin', kind: 'runtime-behavior',
  semantics: ['runtime-behavior', 'workspace-binding', 'verification-policy'],
  level: 'L4', producer: 'core/execution-implementation',
  producerSourceRefs: ['packages/main/src/core/execution-implementation.ts', 'packages/main/src/cli-engine.ts', 'bin/bootstrap-runner.js', 'scripts/build-lock-target.mjs'],
  consumerGate: 'CLI dispatch when an explicit implementation transport pin is required; automatic checklist execution and canonical import implementation binding',
  rationale: 'An opt-in host transport pin compares actual implementation, bin bootstrap helpers, the build-lock helper and dependency bytes plus Node before dispatch; package version equality is not an implementation proof. Missing required pins and mismatches refuse. Unpinned invocations retain compatibility and are not claimed pinned. Checklist receipts automatically bind actual implementation bytes; same-version drift executes anew, mutation during a command cannot publish a receipt, and canonical import rechecks the current implementation.',
}, {
  name: 'runtime:shared_validation_execution', kind: 'runtime-behavior',
  semantics: ['runtime-behavior', 'validation-result', 'signed-artifact', 'freshness-policy', 'workspace-binding'],
  level: 'L4', producer: 'core/shared-validation-execution',
  producerSourceRefs: ['packages/main/src/core/shared-validation-execution.ts', 'packages/main/src/handlers/verifier.ts', 'packages/main/src/core/causal-evidence.ts', 'packages/main/src/core/validation-execution-lock.ts', 'packages/main/src/core/story-owner-lease.ts', 'packages/main/src/handlers/checklist.ts', 'packages/main/src/handlers/done-required-validation.ts', 'packages/main/src/core/auto-commit-metadata.ts'],
  consumerGate: 'validate and done_required_validate retain their independent acceptance and build-proof predicates',
  rationale: 'DONE admission commits only the canonical certification-running delta through the existing immutable-index transaction before execution; dirty source and adjacent staged changes remain untrusted. Explicit exact-inputs reuse consumes signed causal PASS receipts only with current material, clean workspace, environment, executable, loaded implementation digest and policy identity. The actual loaded tool package supplies the tool version; target-project package versions cannot substitute for it. The explicit validate.sharedExecution option enables execution sharing independently of dynamic selection mode, while per-command exclusions still apply. Forbidden reuse and build proof always execute. Declared nonconflicting resources may share capacity; missing claims stay exclusive. Same-owner generation renewal is atomic with takeover and never acquires a missing lease. Reuse retains original execution attribution. Single and batch checklist evidence commands renew the existing owner generation through actual command execution and canonical publication, preserving zero-command receipt import recovery.',
}] as const satisfies readonly ProcessFactRegistryEntry[];

export const PROCESS_FACT_EVIDENCE_HASH_INPUTS = [{
  name:'runtime:causal_complete_selector_output',kind:'runtime-behavior',semantics:['runtime-behavior','signed-artifact','gate-evidence','verification-policy'],level:'L4',producer:'core/causal-evidence',producerSourceRefs:['packages/main/src/core/causal-evidence.ts','packages/main/src/core/store.ts','packages/main/src/handlers/checklist.ts'],consumerGate:'Fresh and reused verification execution selector verdicts',rationale:'Complete redacted output is content-addressed and bound by the signed receipt, separately from bounded display probes. Independent processes verify its digest and length before selecting; missing or changed bytes refuse without rerunning or rewriting evidence. Legacy complete plain probes remain compatible; legacy truncated or redacted display text refuses selector authority. Existing secret redaction is preserved; NUL matching boundaries cannot synthesize selector text. Complete objects are bounded to 1 MiB, with a non-reusable signed selector witness for larger output or legacy stores. Exit-only checks do not read selector objects and retain reuse when durable output fits the bound. Completed output publication retries at most twice without rerunning the command; permanent storage faults refuse. Late batch subscribers join the active retry; single-selector fallback witnesses never decide another selector.',
}, {
  name: 'runtime:evidence_hash_input_boundary', kind: 'runtime-behavior',
  semantics: ['runtime-behavior', 'freshness-policy', 'workspace-binding', 'gate-evidence'],
  level: 'L4', producer: 'core/material-path-policy and core/story-aware-validation',
  producerSourceRefs: ['packages/main/src/core/material-path-policy.ts', 'packages/main/src/core/story-aware-validation.ts', 'packages/main/src/core/evidence-freshness.ts'],
  consumerGate: 'Shared material and Story hashes used by review, validation and evidence freshness consumers',
  rationale: 'Store objects/sha256, refs/by-id and ledger/observed.jsonl are process outputs excluded from material inputs, not disposable runtime artifacts. Unknown evidence paths and policy remain material. Output digest and subject bindings require independent consumer verification; hash stability grants no artifact acceptance. NUL-delimited Git paths retain literal names and target blobs; missing objects fail closed. Existing evidence is never rewritten or automatically re-attested after this correction.',
}] as const satisfies readonly ProcessFactRegistryEntry[];

export const PROCESS_FACT_REGISTRY: readonly ProcessFactRegistryEntry[] = [
  ...PROCESS_FACT_EVIDENCE_HASH_INPUTS,
  ...PROCESS_FACT_VALIDATION_EXECUTION,
  ...PROCESS_FACT_LAB_MAINTENANCE,
  ...COMMAND_PROCESS_FACTS,
  ...PROCESS_FACT_REVIEWER_LANES,
  ...PROCESS_FACT_ARTIFACTS,
  ...PROCESS_FACT_FLOW_POLICIES,
  ...PROCESS_FACT_DONE_PREFLIGHT_CONSUMERS,
  ...PROCESS_FACT_CLOSEOUT_TELEMETRY,
];

export const PROCESS_FACT_REGISTRY_BY_NAME: Record<string, ProcessFactRegistryEntry> = Object.fromEntries(
  PROCESS_FACT_REGISTRY.map((entry) => [entry.name, entry]),
) as Record<string, ProcessFactRegistryEntry>;

export function getProcessFactRegistryEntry(name: string): ProcessFactRegistryEntry | undefined {
  return PROCESS_FACT_REGISTRY_BY_NAME[name];
}

export function hasProcessFactSemantic(name: string, semantic: ProcessFactSemantic): boolean {
  return PROCESS_FACT_REGISTRY_BY_NAME[name]?.semantics.includes(semantic) ?? false;
}

