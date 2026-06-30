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
  | 'finding'
  | 'flow-policy'
  | 'host-verdict'
  | 'reviewer-lane'
  | 'signed-artifact'
  | 'artifact';

export type ProcessFactSemantic =
  | 'artifact'
  | 'blocker-state'
  | 'command'
  | 'execution-evidence'
  | 'finding-state'
  | 'flow-policy'
  | 'freshness-policy'
  | 'gate-evidence'
  | 'host-verdict'
  | 'no-blocker-evidence'
  | 'normalization-policy'
  | 'review-run'
  | 'review-pass'
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
  consumerGate?: string;
  artifact?: ProcessFactArtifactRef;
  reviewerLane?: string;
  rationale: string;
}

export const PROCESS_FACT_KIND_BY_COMMAND: Record<string, ProcessFactKind> = {
  validate: 'validation-status',
  done_required_validate: 'validation-status',
  test_add: 'execution-status',
  test_story: 'execution-status',
  verification_evidence_add: 'execution-status',
  verification_evidence_batch_add: 'execution-status',
  verification_evidence_refresh_stale: 'execution-status',
  review_run_start: 'review-run',
  review_pass_set: 'review-pass',
  finding_add: 'finding',
  finding_resolve: 'finding',
  finding_dismiss: 'finding',
  autopilot_review_submit: 'host-verdict',
  quorum_submit: 'host-verdict',
  decision_doc_proposal: 'gate-evidence',
  decision_doc_save: 'gate-evidence',
  review_escalation_policy_set: 'gate-evidence',
  review_escalation_fallback_set: 'gate-evidence',
  story_create_from_repro: 'gate-evidence',
};

export const PROCESS_FACT_REQUIRED_SEMANTICS = {
  validate: ['validation-status', 'validation-result', 'gate-evidence'],
  done_required_validate: ['schema-contract', 'execution-evidence', 'validation-result', 'gate-evidence'],
  test_add: ['test-evidence', 'validation-result'],
  test_story: ['test-evidence', 'validation-result'],
  verification_evidence_add: ['execution-evidence', 'verification-evidence', 'gate-evidence'],
  verification_evidence_batch_add: ['execution-evidence', 'verification-evidence', 'gate-evidence'],
  verification_evidence_refresh_stale: ['execution-evidence', 'verification-evidence', 'gate-evidence'],
  review_run_start: ['review-run', 'schema-contract', 'workspace-binding', 'gate-evidence'],
  review_pass_set: ['review-pass', 'no-blocker-evidence', 'gate-evidence'],
  review_loop_start: ['blocker-state', 'schema-contract', 'gate-evidence'],
  review_loop_iteration_add: ['blocker-state', 'schema-contract', 'gate-evidence'],
  review_loop_close: ['blocker-state', 'schema-contract', 'gate-evidence'],
  scope_boundary_set: ['schema-contract', 'gate-evidence'],
  execution_boundary_set: ['schema-contract', 'workspace-binding', 'gate-evidence'],
  scope_freeze_check: ['validation-result', 'schema-contract', 'gate-evidence'],
  scope_extension_proposal: ['blocker-state', 'schema-contract', 'gate-evidence'],
  scope_extension_decide: ['blocker-state', 'schema-contract', 'gate-evidence'],
  finding_add: ['finding-state', 'blocker-state', 'gate-evidence'],
  finding_resolve: ['finding-state', 'blocker-state', 'gate-evidence'],
  finding_dismiss: ['finding-state', 'blocker-state', 'gate-evidence'],
  autopilot_review_submit: ['host-verdict', 'execution-evidence', 'gate-evidence'],
  quorum_submit: ['host-verdict', 'execution-evidence', 'gate-evidence'],
  decision_doc_proposal: ['schema-contract', 'gate-evidence'],
  decision_doc_save: ['artifact', 'schema-contract', 'execution-evidence', 'gate-evidence'],
  review_escalation_policy_set: ['schema-contract', 'gate-evidence'],
  review_escalation_fallback_set: ['schema-contract', 'gate-evidence'],
  story_create_from_repro: ['artifact', 'schema-contract', 'workspace-binding', 'gate-evidence'],
  original_intent_snapshot_set: ['schema-contract', 'gate-evidence'],
  milestone_ledger_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  milestone_ledger_add: ['schema-contract', 'verification-policy', 'gate-evidence'],
  slice_plan_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  parent_ledger_rollup_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  proofstory_contract_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  intent_collision_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  scope_shrinkage_decision_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  red_evidence_create: ['schema-contract', 'verification-policy', 'gate-evidence'],
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
  'runtime:review_escalation_done_gate': ['runtime-behavior', 'host-verdict', 'gate-evidence'],
  'runtime:review_assurance_floor_done_gate': ['runtime-behavior', 'host-verdict', 'gate-evidence'],
  'runtime:review_run_story_files_hash_gate': ['runtime-behavior', 'freshness-policy', 'workspace-binding', 'review-run', 'gate-evidence'],
  'runtime:story_files_hash_freshness_gate': ['runtime-behavior', 'freshness-policy', 'workspace-binding', 'verification-evidence', 'review-run', 'host-verdict', 'gate-evidence'],
  'runtime:repro_first_story_intake_preflight': ['runtime-behavior', 'schema-contract', 'workspace-binding', 'gate-evidence'],
  'runtime:proof_admissibility_gate_diagnostic': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'gate-evidence'],
  'runtime:parent_roadmap_totality_claim_consumer': ['runtime-behavior', 'schema-contract', 'verification-policy', 'gate-evidence'],
} as const satisfies Record<string, readonly ProcessFactSemantic[]>;

export const PROCESS_FACT_ARTIFACT_BY_COMMAND: Record<string, ProcessFactArtifactRef> = {
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
  checklist_update: {
    name: 'checklist.json',
    path: 'checklist.json',
    signed: false,
    producerCommand: 'checklist_update',
    consumerGate: 'storyMachine.checklistAllDone DEV to REVIEW gate',
  },
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
    consumerGate: 'validate verification freshness gate',
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
  proofstory_contract_set: {
    name: 'proofstory.json',
    path: 'proofstory.json',
    signed: false,
    producerCommand: 'proofstory_contract_set',
    consumerGate: 'ProofStory DEV admission, REVIEW completeness, and DONE intent-equivalence gates',
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
    signature: 'signReviewRun/verifyReviewRun; ReviewRun.storyFilesHash and workspaceBinding.bindingHash are folded into new review-run signatures and compared to current story signed workspace resolution by REVIEW consumers',
    producerCommand: 'review_run_start',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  review_pass_set: {
    name: 'review-passes.json',
    path: 'review-passes.json',
    signed: true,
    signature: 'signReviewPass/verifyReviewPass; reviewRunId-inclusive records do not fall back to legacy signatures',
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
    reviewerLane: 'lattice-review-story-init',
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
    reviewerLane: 'lattice-review-delivery',
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
    reviewerLane: 'lattice-review-scope-plan',
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
  'lattice-review-story-init',
  'product-reviewer',
  'lattice-review-scope-plan',
  'lattice-review-concept',
  'lattice-review-quality',
  'lattice-review-test-coverage',
  'lattice-review-behavior',
  'lattice-review-docs',
  'lattice-review-channel',
  'lattice-review-delivery',
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
    name: 'reviewer-lane:lattice-review-story-init',
    producer: 'lattice-review-story-init',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    reviewerLane: 'lattice-review-story-init',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.init_check_set,
    rationale: 'INIT reviewer writes signed init-check evidence before worktree bootstrap.',
  },
  {
    name: 'reviewer-lane:product-reviewer',
    producer: 'product-reviewer',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    reviewerLane: 'product-reviewer',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.init_check_set,
    rationale: 'Product init reviewer is a required init-check producer for user-value readiness.',
  },
  {
    name: 'reviewer-lane:lattice-review-scope-plan',
    producer: 'lattice-review-scope-plan',
    consumerGate: 'story_review scope-check gate',
    reviewerLane: 'lattice-review-scope-plan',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.scope_check_save,
    rationale: 'PLAN scope reviewer signs scope-check evidence before implementation.',
  },
  {
    name: 'reviewer-lane:lattice-review-concept',
    producer: 'lattice-review-concept',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'lattice-review-concept',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Baseline concept reviewer records findings or no-blocker review pass evidence.',
  },
  {
    name: 'reviewer-lane:lattice-review-quality',
    producer: 'lattice-review-quality',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'lattice-review-quality',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Baseline quality reviewer records findings or no-blocker review pass evidence.',
  },
  {
    name: 'reviewer-lane:lattice-review-test-coverage',
    producer: 'lattice-review-test-coverage',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'lattice-review-test-coverage',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Coverage reviewer checks verificationIntent to verificationEvidence coverage.',
  },
  {
    name: 'reviewer-lane:lattice-review-behavior',
    producer: 'lattice-review-behavior',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'lattice-review-behavior',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Risk-triggered behavior reviewer records findings or no-blocker evidence.',
  },
  {
    name: 'reviewer-lane:lattice-review-docs',
    producer: 'lattice-review-docs',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'lattice-review-docs',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Docs reviewer records docs drift findings or no-blocker evidence.',
  },
  {
    name: 'reviewer-lane:lattice-review-channel',
    producer: 'lattice-review-channel',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'lattice-review-channel',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Retired compatibility reviewer lane still uses signed findings/review-pass evidence when invoked.',
  },
  {
    name: 'reviewer-lane:lattice-review-delivery',
    producer: 'lattice-review-delivery',
    consumerGate: 'storyMachine.canFinish DONE gate',
    reviewerLane: 'lattice-review-delivery',
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
    consumerGate: entry.gateConsumer,
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
    rationale: 'Delivery-check signature is consumed by DONE and folds in storyFilesHash: whole-tree materialHash drift with a matching signed storyFilesHash downgrades to a mandatory re-attestation advisory (delivery_check_drift_advisory), while a story-owned change or missing storyFilesHash stays strict stale.',
  },
  {
    name: 'artifact:review-runs.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'review-run', 'schema-contract', 'workspace-binding', 'freshness-policy'],
    level: 'L4',
    producer: 'handlers/review-run',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_run_start,
    rationale: 'Signed reviewer runs bind current REVIEW findings and passes to a fresh lane-specific boundary, including ReviewRun.storyFilesHash for unrelated main-drift freshness.',
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
    name: 'artifact:review-passes.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'review-pass', 'no-blocker-evidence'],
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
    rationale: 'Validation status artifact is required before DONE.',
  },
  {
    name: 'artifact:done-required-evidence.json',
    kind: 'artifact',
    semantics: ['artifact', 'validation-result', 'execution-evidence', 'schema-contract', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/done-required-validation',
    consumerGate: 'story_advance DONE done-required-validation gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.done_required_validate,
    rationale: 'Opt-in DONE-required command receipts are consumed by the local DONE oracle separately from ordinary TEST validation evidence, with coverage and identity rechecked against the active policy.',
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

export const PROCESS_FACT_REQUIRED_ARTIFACTS = PROCESS_FACT_ARTIFACTS.filter(
  (entry) => entry.artifact && PROCESS_FACT_REQUIRED_ARTIFACT_NAMES.includes(entry.artifact.path as typeof PROCESS_FACT_REQUIRED_ARTIFACT_NAMES[number]),
) as readonly ProcessFactRegistryEntry[];

export const PROCESS_FACT_REGISTRY: readonly ProcessFactRegistryEntry[] = [
  ...COMMAND_PROCESS_FACTS,
  ...PROCESS_FACT_REVIEWER_LANES,
  ...PROCESS_FACT_ARTIFACTS,
  ...PROCESS_FACT_FLOW_POLICIES,
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
