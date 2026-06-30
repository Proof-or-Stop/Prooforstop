#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const failures = [];
const warnings = [];
const hanCharacterPattern = /[\u3400-\u9fff]/;
const codeLikeCommandNamePattern = /^[a-z][a-z0-9_.-]*(?::[a-z][a-z0-9_.-]*)*$/;

const promptDirs = [
  'packages/main/templates/agents',
  '.claude/agents',
  '.lattice-codex/agents',
];

const currentCategories = new Set(['happy', 'edge', 'adversarial', 'missing']);
const legacyCategories = new Set(['cleanup', 'doc-promise-undelivered', 'doc-code-drift', 'spec-boundary']);
const reviewPassReviewerPrompts = new Set([
  'lattice-evaluator.md',
  'lattice-review-behavior.md',
  'lattice-review-channel.md',
  'lattice-review-concept.md',
  'lattice-review-delivery.md',
  'lattice-review-docs.md',
  'lattice-review-quality.md',
  'lattice-review-scope-plan.md',
  'lattice-review-story-init.md',
  'lattice-review-test-coverage.md',
]);
const requiredReviewerRunIdPromptFiles = new Set([
  'lattice-evaluator.md',
  'lattice-review-delivery.md',
  'lattice-review-scope-plan.md',
  'lattice-review-story-init.md',
]);
const processFactLevelRegistryPath = 'packages/main/src/core/process-fact-levels.ts';
const commandPolicyPath = 'packages/main/src/core/command-policy.ts';
const flowFactPolicyPath = 'packages/main/src/core/flow-fact-policy.ts';
const lifecycleRegistryPath = 'packages/main/src/core/lifecycle-registry.ts';
const legacyTestFixtureCommands = [
  'test_auto',
  'test_story',
  'test_fixture',
  'fixture_batch_add',
  'fixture_update',
  'test_add',
  'task_coverage',
];
const activeLifecycleDocPaths = [
  'AGENTS.md',
  'docs/requirements/decisions/story-lifecycle.md',
  'docs/requirements/decisions/testing-infra.md',
];
const validatePrimaryReferenceDocPaths = [
  'docs/requirements/decisions/dev-memory.md',
  'docs/requirements/decisions/host-neutral-observability-console.md',
  'docs/requirements/decisions/truth-source.md',
];
const activeLifecycleDocCurrentTerms = [
  'verificationIntent',
  'verificationEvidence',
  'lattice validate',
  'checklist_update',
];
const legacyCommandDocContextPattern = /\blegacy\b|\bcompat\b|\bmaintenance\b|兼容|维护|旧|迁移|背景|destructive/i;
const legacyAliasDocContextPattern = /\blegacy\b|\balias\b|\bcompat\b|\bmaintenance\b|兼容|维护|旧|迁移|背景|别名|destructive/i;
const coverageReviewerLaneName = 'lattice-review-test-coverage';
const coverageReviewerLaneContextPattern = /reviewer|agent|lane|review\s+lane|coverage\s+reviewer|审查员|审查\s*lane|审查\s*通道|覆盖审查/i;
const coverageReviewerCliCommandPatterns = [
  { label: 'CLI invocation', pattern: /\blattice\s+lattice-review-test-coverage\b/i },
  { label: 'tool table row', pattern: /^\s*\|\s*`?lattice-review-test-coverage`?\s*\|/ },
  { label: 'tool bullet', pattern: /^\s*[-*]\s*`?lattice-review-test-coverage`?\s*(?:[:：-]|$)/ },
];
const legacyTestAutoProcessFactClaimPatterns = [
  {
    label: 'auto bug management',
    pattern: /自动\s*bug\s*管理|fail\s*(?:创建|create[s]?)\s+bug|pass\s*(?:自动\s*)?(?:fix|fixed|修复|标记?|mark[s]?).{0,20}bug/i,
  },
  {
    label: 'test-evidence writes',
    pattern: /\btest_auto\b[^。.\n;；]{0,80}(?:写|write[s]?|record[s]?|生成|产出)[^。.\n;；]{0,40}(?:test-?evidence|test evidence|verificationEvidence|测试证据)|(?:test-?evidence|test evidence|verificationEvidence|测试证据)[^。.\n;；]{0,40}(?:由|by)\s*`?test_auto`?|^(?:\d+\.|-)\s*(?:写|write[s]?|record[s]?|生成|产出)[^。.\n;；]{0,40}(?:test-?evidence|test evidence|verificationEvidence|测试证据)/i,
  },
];
const legacyTestAutoNegatedProcessFactPattern = /(?:不会|不写|不再|不能|并不|does\s+not|doesn't|do\s+not|not|never|without|no\s+longer).{0,90}(?:bug|test-?evidence|test evidence|verificationEvidence|测试证据)/i;
const commandPolicyStatuses = new Set(['supported', 'rootOnly', 'legacy', 'retired', 'maintenance', 'gateEvidence']);
const processFactRegistryPath = 'packages/main/src/core/process-fact-registry.ts';
const localAssuranceBoundaryPattern = /local (?:assurance|admissibility|workflow evidence|host verdict|quorum|review escalation|review assurance|validation|DONE-required-validation)|proof-admissibility|receipt-bundle|quorum|admissibility/i;
const noReleaseOrRemoteCompletionBoundaryPattern = /retired remote-completion fields|remote completion|remote-completion|release readiness|release approval|remote publish readiness/i;
const processFactRegistryKinds = new Set([
  'command',
  'runtime-behavior',
  'gate-evidence',
  'execution-status',
  'validation-status',
  'review-run',
  'review-pass',
  'finding',
  'flow-policy',
  'host-verdict',
  'reviewer-lane',
  'signed-artifact',
  'artifact',
]);
const requiredProcessFactSemantics = {
  validate: ['validation-status', 'validation-result', 'gate-evidence'],
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
};
const requiredReviewerLanes = [
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
];
const requiredArtifactFacts = [
  { name: 'artifact:index.json', path: 'index.json', signed: false },
  { name: 'artifact:review.json', path: 'review.json', signed: true, signaturePattern: /sha256\(storyId:timestamp:issueCount:blockerCount/ },
  { name: 'artifact:checklist.json', path: 'checklist.json', signed: false },
  { name: 'artifact:init-check.json', path: 'init-check.json', signed: true, signaturePattern: /signInitCheck\/recomputeInitCheckHash/ },
  { name: 'artifact:scope-boundary.json', path: 'scope-boundary.json', signed: true, signaturePattern: /stable scope boundary _hash/ },
  { name: 'artifact:execution-boundary.json', path: 'execution-boundary.json', signed: true, signaturePattern: /stable execution boundary _hash/ },
  { name: 'artifact:scope-freeze-check.json', path: 'scope-freeze-check.json', signed: true, signaturePattern: /freshnessHash/ },
  { name: 'artifact:scope-extension-proposals.json', path: 'scope-extension-proposals.json', signed: true, signaturePattern: /stable proposal _hash/ },
  { name: 'artifact:scope-discard-digest.json', path: 'scope-discard-digest.json', signed: false },
  { name: 'artifact:scope-check.json', path: 'scope-check.json', signed: true, signaturePattern: /signScopeCheck/ },
  { name: 'artifact:delivery-check.json', path: 'delivery-check.json', signed: true, signaturePattern: /signDeliveryCheck\/recomputeDeliveryCheckHash/ },
  { name: 'artifact:review-runs.json', path: 'review-runs.json', signed: true, signaturePattern: /signReviewRun\/verifyReviewRun; .*ReviewRun\.storyFilesHash.*workspaceBinding\.bindingHash/ },
  { name: 'artifact:findings.json', path: 'findings.json', signed: true, signaturePattern: /signFinding\/verifyFinding; reviewRunId-inclusive records do not fall back to legacy signatures/ },
  { name: 'artifact:review-passes.json', path: 'review-passes.json', signed: true, signaturePattern: /signReviewPass\/verifyReviewPass; reviewRunId-inclusive records do not fall back to legacy signatures/ },
  { name: 'artifact:review-loops.jsonl', path: 'review-loops.jsonl', signed: false },
  { name: 'artifact:draft-check.json', path: 'draft-check.json', signed: true, signaturePattern: /computeDraftCheckHash/ },
  { name: 'artifact:summary.json', path: 'summary.json', signed: false },
  { name: 'artifact:test-evidence.json', path: 'test-evidence.json', signed: false },
  { name: 'artifact:done-required-evidence.json', path: 'done-required-evidence.json', signed: false },
  { name: 'artifact:eval-evidence.json', path: 'eval-evidence.json', signed: false },
  { name: 'artifact:process-events.jsonl', path: 'process-events.jsonl', signed: false },
  { name: 'artifact:decision-doc-proposals.json', path: 'decision-doc-proposals.json', signed: false },
  { name: 'artifact:story-evidence-binding', path: 'story-evidence-binding', signed: false },
  { name: 'artifact:original-intent-snapshot.json', path: 'original-intent-snapshot.json', signed: false },
  { name: 'artifact:milestone-ledger.json', path: 'milestone-ledger.json', signed: false },
  { name: 'artifact:slice-plan.json', path: 'slice-plan.json', signed: false },
  { name: 'artifact:parent-ledger-rollup.json', path: 'parent-ledger-rollup.json', signed: false },
  { name: 'artifact:proofstory.json', path: 'proofstory.json', signed: false },
  { name: 'artifact:intent-collision.json', path: 'intent-collision.json', signed: false },
  { name: 'artifact:scope-shrinkage-decision.json', path: 'scope-shrinkage-decision.json', signed: false },
  { name: 'artifact:red-evidence.json', path: 'red-evidence.json', signed: false },
  { name: 'artifact:spike.json', path: 'spike.json', signed: false },
];
const requiredReviewLoopL4Commands = [
  'review_loop_start',
  'review_loop_iteration_add',
  'review_loop_close',
];
const requiredReviewLoopReadOnlyCommands = [
  'review_loop_status',
  'review_loop_policy_show',
];
const requiredDoneClosureReadOnlyCommands = [
  'done_closure',
];
const requiredDecisionDocQuorumReadOnlyCommands = [
  'decision_doc_quorum_check',
];
const requiredDecisionDocPromotionCommands = [
  'decision_doc_proposal',
  'decision_doc_preview',
  'decision_doc_save',
];
// B-b29e CHK-003 (F-001): the durable scope-contract.json the parallel-decomposition
// hard gate reads at every DEV entry (machine.ts parallelDevEntryBlock →
// parallelDecompositionEnforcedBlock → resolveAuditConfig().parallelGate +
// safeReadScopeContract → computeWriteSet, consumed by canStartDevGuard/
// canSkipPlanGuard/canReenterDevGuard) is WRITTEN only by the three producer
// facts below (all call writeScopeContract). These L4 producers must therefore
// name the parallel-decomposition DEV-entry gate in their gateConsumer — an L4
// fact is a command that WRITES a gate-consumed fact. scope_contract_check is a
// PURE READ (readScopeContract + buildScopeDiffPack, no writeScopeContract) and
// produces nothing the gate consumes, so it is intentionally excluded. This
// assertion is non-vacuous: dropping the registration from any of the three
// producers in process-fact-levels.ts fails it.
const scopeContractParallelDevEntryConsumerCommands = [
  'scope_contract_set',
  'scope_contract_acknowledge',
  'scope_contract_init_from_plan',
];
const scopeContractParallelDevEntryConsumerPattern = /parallel-decomposition DEV-entry gate/;
const legacyCommandPolicyGuidance = {
  test_auto: {
    destructiveRisk: 'workspace-destructive',
    patterns: [/(?:lattice|koala) validate --story=<storyId>/, /verificationEvidence/, /dryRun/, /confirm/, /git restore\/git clean/],
  },
  test_story: {
    destructiveRisk: 'fixture-write',
    patterns: [/(?:lattice|koala) validate --story=<storyId>/, /verification_evidence_add|verificationEvidence/],
  },
  test_fixture: {
    destructiveRisk: 'fixture-write',
    patterns: [/project-native command|(?:lattice|koala) validate --story=<storyId>/, /verification_evidence_add|verificationEvidence/],
  },
  fixture_batch_add: {
    destructiveRisk: 'fixture-write',
    patterns: [/dryRun/, /validateExecute|verification_evidence_add|verificationEvidence/],
  },
  fixture_update: {
    destructiveRisk: 'fixture-write',
    patterns: [/fixture_batch_add/, /dryRun/, /project-native tests|verification_evidence_add|verificationEvidence/],
  },
  test_add: {
    destructiveRisk: 'metadata-write',
    patterns: [/verification_evidence_add|verificationEvidence/, /checklist_update/],
  },
  task_coverage: {
    destructiveRisk: 'none',
    patterns: [/validate|process-fact/, /verificationEvidence/],
  },
};
const requiredRuntimeEntries = [
  {
    name: 'runtime:phase_tools_malformed_policy_ceiling',
    level: 'L1',
    owner: 'core/config',
    line: '- runtime:phase_tools_malformed_policy_ceiling [L1] owner=core/config',
  },
  {
    name: 'runtime:test_auto_recursive_skip',
    level: 'L2',
    owner: 'handlers/test-auto',
    line: '- runtime:test_auto_recursive_skip [L2] owner=handlers/test-auto',
  },
  {
    name: 'runtime:validate_fallback_discovery',
    level: 'L1',
    owner: 'handlers/verifier',
    line: '- runtime:validate_fallback_discovery [L1] owner=handlers/verifier',
  },
  {
    name: 'runtime:validate_side_effect_guard',
    level: 'L2',
    owner: 'core/validation-executor',
    line: '- runtime:validate_side_effect_guard [L2] owner=core/validation-executor',
  },
  {
    // B-3fad CHK-003: Finding.evidenceState is a gate-consumed semantic fact —
    // the REVIEW→TEST canPassReview gate blocks only on verified (or legacy
    // missing-field) open critical/high findings. This required-entry assertion
    // is the hardcoded fallback proving the evidenceState gate dimension stays
    // registered as an L4 process fact.
    name: 'runtime:finding_evidence_state_review_gate',
    level: 'L4',
    owner: 'core/advisory',
    line: '- runtime:finding_evidence_state_review_gate [L4] owner=core/advisory gate=storyMachine.canPassReview REVIEW to TEST gate',
  },
  {
    // B-b750: ReviewRun.workspaceBinding is gate-consumed structured evidence.
    // review_run_start signs it, and REVIEW consumers reject tampered bindings
    // or bindings that no longer match the current story signed workspace
    // resolution, while using signedWorkspaceRoot for freshness and scope checks.
    name: 'runtime:review_run_workspace_binding_gate',
    level: 'L4',
    owner: 'core/review-run',
    line: '- runtime:review_run_workspace_binding_gate [L4] owner=core/review-run gate=storyMachine.canPassReview REVIEW to TEST gate',
  },
  {
    // B-5a9a: storyFilesHash is a gate-consumed secondary freshness signal.
    // review_run_start persists and signs the top-level ReviewRun.storyFilesHash
    // so REVIEW evidence can survive unrelated main drift without falling back
    // to unsigned nested workspaceBinding data.
    name: 'runtime:review_run_story_files_hash_gate',
    level: 'L4',
    owner: 'core/review-run',
    line: '- runtime:review_run_story_files_hash_gate [L4] owner=core/review-run gate=storyMachine.canPassReview REVIEW to TEST gate',
  },
  {
    // B-5a9a: storyFilesHash is a generic gate-consumed secondary freshness signal.
    // It may downgrade unrelated whole-tree materialHash drift to an explicit
    // re-attestation advisory, but story-owned file changes and legacy records
    // without storyFilesHash stay on strict materialHash behavior.
    name: 'runtime:story_files_hash_freshness_gate',
    level: 'L4',
    owner: 'core/evidence-freshness',
    line: '- runtime:story_files_hash_freshness_gate [L4] owner=core/evidence-freshness gate=REVIEW/TEST/DONE freshness gates for review runs, verification evidence, review escalation records, and the review assurance floor DONE freshness gate',
  },
  {
    // B-1731: repro-first intake is a gate-consumed runtime predicate. The
    // story-evidence-binding artifact is written by story_create_from_repro;
    // this runtime fact is the classifier + warn/enforce gate that consumes it.
    name: 'runtime:repro_first_story_intake_preflight',
    level: 'L4',
    owner: 'core/repro-evidence-binding-gate',
    line: '- runtime:repro_first_story_intake_preflight [L4] owner=core/repro-evidence-binding-gate gate=story_create STORY_INTAKE preflight and storyMachine.canEnterPlan/canStartDev/canSkipPlan gates',
  },
  {
    name: 'runtime:review_escalation_done_gate',
    level: 'L4',
    owner: 'core/review-escalation',
    line: '- runtime:review_escalation_done_gate [L4] owner=core/review-escalation gate=storyMachine.canFinish DONE review escalation gate',
  },
  {
    name: 'runtime:review_assurance_floor_done_gate',
    level: 'L4',
    owner: 'core/review-assurance-floor',
    line: '- runtime:review_assurance_floor_done_gate [L4] owner=core/review-assurance-floor gate=storyMachine.canFinish DONE review assurance floor gate',
  },
];
const requiredFlowFactPolicies = [
  {
    name: 'flow-policy:review-run-boundary',
    policyId: 'review-run-boundary',
    artifactPath: 'review-runs.json',
    consumerGatePattern: /storyMachine\.canPassReview/,
    semantics: ['flow-policy', 'review-run', 'schema-contract', 'gate-evidence'],
    disposition: '',
  },
  {
    name: 'flow-policy:review-pass',
    policyId: 'review-pass',
    artifactPath: 'review-passes.json',
    consumerGatePattern: /storyMachine\.canPassReview/,
    semantics: ['flow-policy', 'review-pass', 'no-blocker-evidence', 'gate-evidence'],
    disposition: '',
  },
  {
    name: 'flow-policy:review-pass-supersession',
    policyId: 'review-pass-supersession',
    artifactPath: 'review-passes.json',
    consumerGatePattern: /storyMachine\.canPassReview/,
    semantics: ['flow-policy', 'review-pass', 'supersession-policy', 'gate-evidence'],
    disposition: '',
  },
  {
    name: 'flow-policy:finding',
    policyId: 'finding',
    artifactPath: 'findings.json',
    consumerGatePattern: /storyMachine\.canPassReview/,
    semantics: ['flow-policy', 'finding-state', 'blocker-state', 'gate-evidence'],
    disposition: '',
  },
  {
    name: 'flow-policy:pass-only-normalization',
    policyId: 'pass-only-normalization',
    artifactPath: 'review-passes.json',
    consumerGatePattern: /storyMachine\.canPassReview/,
    semantics: ['flow-policy', 'normalization-policy', 'review-pass', 'gate-evidence'],
    disposition: 'finding_add:pass-only->review_pass_set',
  },
  {
    name: 'flow-policy:review-round-iso-string',
    policyId: 'review-round-iso-string',
    artifactPath: 'findings.json',
    consumerGatePattern: /review signatures.*storyMachine\.canPassReview/,
    semantics: ['flow-policy', 'schema-contract', 'finding-state', 'review-pass', 'gate-evidence'],
    disposition: '',
  },
  {
    name: 'flow-policy:express-verification-policy',
    policyId: 'express-verification-policy',
    artifactPath: '',
    consumerGatePattern: /validate verification coverage.*story_review/,
    semantics: ['flow-policy', 'verification-policy', 'gate-evidence'],
    disposition: 'express-exempt',
  },
];
const reviewRoundIsoDocPaths = [
  'CLAUDE.md',
  'docs/requirements/decisions/story-lifecycle.md',
  'docs/requirements/decisions/testing-infra.md',
];
const evidenceBoundaryDocPaths = [
  'CLAUDE.md',
  'docs/requirements/decisions/testing-infra.md',
];
const requiredEvidenceBoundaryPhrases = [
  'prompt-only worker claims are not mechanical evidence',
  'dispatch/process-event/commit evidence',
  'Lattice cannot mechanically prove true subagent context isolation',
  'transcript/delivery evidence is required; prompt-only user-value claims are not enough',
  'non-mechanical user approval',
];
const requiredControlledMutationEntries = [
  {
    name: 'truth_nav',
    level: 'L2',
    owner: 'handlers/truth',
    rationalePattern: /NAV\.md|documentation mutation/i,
  },
  {
    name: 'truth_extract',
    level: 'L2',
    owner: 'handlers/truth',
    rationalePattern: /writes generated requirements files|controlled mutation/i,
  },
  {
    name: 'doctor',
    level: 'L2',
    owner: 'handlers/doctor',
    rationalePattern: /repair|removes terminal worktree residue/i,
  },
];
const processFactCommandNamePatterns = [
  /^story_advance$/,
  /^story_review$/,
  /^review_run_start$/,
  /^review_pass_set$/,
  /^review_loop_(start|iteration_add|close)$/,
  /^finding_(add|resolve|dismiss|cluster)$/,
  /^verification_evidence_/,
  /_check_set$/,
  /^init_check_set$/,
  /^scope_(check_save|question_resolve)$/,
  /^delivery_(check_set|waiver_add)$/,
  /^draft_(check_set|issue_resolve)$/,
  /^summary_set$/,
  /^evaluate_save$/,
  /^test_add$/,
  /^test_story$/,
  /^validate$/,
  /^checklist_update$/,
  /^verification_context_pack_/,
];

const ALL_PHASES = ['INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE'];

async function importBuiltModule(relPath) {
  const absPath = join(root, relPath);
  if (!existsSync(absPath)) return null;
  try {
    return await import(pathToFileURL(absPath).href);
  } catch (error) {
    warnings.push(`${relPath} could not be imported; falling back to source parsing (${error.message})`);
    return null;
  }
}

// Contract verification is source-first by design. Stale dist output must not be
// allowed to hide current source drift, so the verifier parses src files even
// when compiled modules exist.
const builtCommandPolicyModule = null;
const builtConfigModule = null;
const builtProcessFactRegistryModule = null;

const passOnlyFindingAddPatterns = [
  /文档一致性检查通过/,
  /consistency check\s+PASSED/,
  /检查通过/,
  /\bno\s+findings?\b/i,
  /\bPASS(?:ED)?\b/,
];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertLocalAssuranceNoReleaseBoundary(text, messagePrefix) {
  assert(
    localAssuranceBoundaryPattern.test(text),
    `${messagePrefix} must name the local assurance/admissibility boundary`,
  );
  assert(
    noReleaseOrRemoteCompletionBoundaryPattern.test(text),
    `${messagePrefix} must preserve the no-release/no-remote-completion boundary`,
  );
}

function read(relPath) {
  const absPath = join(root, relPath);
  assert(existsSync(absPath), `${relPath} should exist`);
  if (!existsSync(absPath)) return '';
  return readFileSync(absPath, 'utf8');
}

function listMarkdown(dir) {
  const absDir = join(root, dir);
  assert(existsSync(absDir), `${dir} should exist`);
  if (!existsSync(absDir)) return [];
  return readdirSync(absDir)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => `${dir}/${name}`);
}

function assertProofStoryProgressiveBoundary() {
  const catalogText = read('packages/main/src/cli/command-catalog.ts');
  const handlerText = read('packages/main/src/handlers/proofstory.ts');
  const coreText = read('packages/main/src/core/proofstory.ts');
  const configText = read('packages/main/src/core/config.ts');
  const commandPolicyEntries = new Map(parseCommandPolicyEntries().map(entry => [entry.name, entry]));
  const storyAdvanceText = read('packages/main/src/handlers/story-advance.ts');
  const phaseGatesText = read('packages/main/src/handlers/phase-gates.ts');
  const machineText = read('packages/main/src/core/machine.ts');

  for (const commandName of [
    'original_intent_snapshot_set',
    'original_intent_snapshot_get',
    'milestone_ledger_set',
    'milestone_ledger_add',
    'milestone_ledger_get',
    'slice_plan_set',
    'slice_plan_get',
    'parent_ledger_rollup_set',
    'parent_ledger_rollup_get',
    'proofstory_contract_set',
    'proofstory_contract_get',
    'intent_collision_set',
    'intent_collision_get',
    'scope_shrinkage_decision_set',
    'scope_shrinkage_decision_get',
    'red_evidence_create',
    'red_evidence_get',
    'spike_start',
    'spike_result_set',
    'spike_result',
    'spike_discard',
    'spike_promote',
    'spike_get',
    'intent_coverage_check',
    'proofstory_gate_check',
    'done_intent_equivalence_check',
    'proofstory_review_completeness_check',
  ]) {
    assert(catalogText.includes(`name: '${commandName}'`), `CLI schema: ProofStory command missing from MAIN_TOOLS: ${commandName}`);
  }
  assert(handlerText.includes("mode === 'enforce'") && handlerText.includes('observe'), 'handlers/proofstory.ts: ProofStory checks must support observe/warn/enforce without writing evidence');
  assert(coreText.includes('computeIntentRequestHash'), 'core/proofstory.ts: requestHash helper must remain explicit');
  assert(coreText.includes('sourceText') && coreText.includes('keyRequirementIds'), 'core/proofstory.ts: requestHash must be derived from sourceText and keyRequirementIds');
  assert(coreText.includes('candidate') && coreText.includes('confirmed'), 'core/proofstory.ts: milestone ledger must distinguish candidate and confirmed state');
  assert(catalogText.includes('parentLedgerId') && catalogText.includes('assignedStory'), 'CLI schema: milestone ledger rows must expose optional parent/assigned-story fields');
  assert(coreText.includes('parentLedgerId') && coreText.includes('assignedStory'), 'core/proofstory.ts: milestone rows must preserve optional parent/assigned-story fields');
  assert(coreText.includes('confirmMilestoneLedger'), 'core/proofstory.ts: intent collision pass must be able to confirm a ledger');
  assert(coreText.includes('slicePlanCoversCurrentLedger') && coreText.includes('oversizedClearedBy'), 'core/proofstory.ts: oversized ledger exception must require a current complete slice plan or child assignment');
  assert(coreText.includes('parentRollupCoversSlicePlan') && coreText.includes('parent-ledger-rollup.json'), 'core/proofstory.ts: DONE equivalence must consume parent ledger roll-up when slice plans exist');
  assert(coreText.includes('lightweight_single_outcome') && coreText.includes('strict_milestone'), 'core/proofstory.ts: DONE equivalence must distinguish lightweight single-outcome and strict milestone paths');
  assert(catalogText.includes('userConfirmed') && handlerText.includes('userConfirmed'), 'ProofStory scope shrinkage command must expose userConfirmed');
  assert(coreText.includes('args.userConfirmed !== true'), 'core/proofstory.ts: confirmed scope shrinkage must require userConfirmed:true');
  assert(coreText.includes('decision.userConfirmed === true'), 'core/proofstory.ts: DONE equivalence must only consume user-confirmed shrinkage');
  assert(coreText.includes("row.waiverType === 'deferred_gate_evidence'") && coreText.includes('return false;'), 'core/proofstory.ts: ProofStory evidence coverage must never count deferred_gate_evidence waivers');
  assert(coreText.includes("row.result === 'pass'"), 'core/proofstory.ts: ProofStory evidence coverage must require result=pass for ordinary evidence rows');
  assert(coreText.includes("row.waiverType === 'permanent'") && coreText.includes("row.result !== 'fail'"), 'core/proofstory.ts: ProofStory evidence coverage must allow only non-failed permanent waivers');
  assert(!coreText.includes("row.verdict === 'success'") && !coreText.includes("row.verdict === 'waived'"), 'core/proofstory.ts: ProofStory evidence coverage must not treat verdict labels as pass evidence');
  assert(catalogText.includes('acceptanceTargetRef') && catalogText.includes('baselineHeadHash') && catalogText.includes('baselineMaterialHash'), 'CLI schema: red evidence must bind target and baseline head/material');
  assert(catalogText.includes('failureReceiptHash') && catalogText.includes('gate satisfaction requires this or failureReceiptHash'), 'CLI schema: red evidence must expose command-or-receipt proof boundary');
  assert(coreText.includes('!record.failingCommand && !record.failureReceiptHash'), 'core/proofstory.ts: red evidence satisfaction must require a failing command or receipt hash');
  assert(coreText.includes('!record.expectedGreenCommand && !record.greenRelation.command && !record.greenRelation.greenHeadHash && !record.greenRelation.greenMaterialHash'), 'core/proofstory.ts: red evidence satisfaction must require current green command or hash proof');
  assert(coreText.includes('greenRelation.targetRef !== record.acceptanceTargetRef'), 'core/proofstory.ts: wrong-target red evidence must not satisfy diagnostics');
  assert(coreText.includes('active_disposable_spike_code') && coreText.includes('disposableCodePaths'), 'core/proofstory.ts: active disposable spike code must be a ProofStory diagnostic');
  assert(handlerText.includes('slice_plan_set') && handlerText.includes('parent_ledger_rollup_set'), 'handlers/proofstory.ts: slice plan and parent roll-up writers must be implemented');
  assert(read('packages/main/src/handlers/story-review.ts').includes('ProofStory advisory diagnostics') || read('packages/main/src/handlers/story-review.ts').includes('ProofStory Diagnostics'), 'story-review.ts: story_review must surface ProofStory advisory diagnostics');
  assert(!storyAdvanceText.includes('../core/proofstory') && !storyAdvanceText.includes('./proofstory'), 'story-advance.ts: ProofStory must not be wired through the thin story_advance handler');
  assert(machineText.includes('proofStoryDevGateFailure') && machineText.includes('devGateMode'), 'machine.ts: ProofStory DEV admission must go through the existing story machine guard and explicit policy mode');
  assert(machineText.includes('if (proofStoryDevGateFailure(context.store, context.projectRoot, context.storyId)) return false;'), 'machine.ts: REVIEW/TEST to DEV re-entry must enforce ProofStory devGateMode=enforce');
  assert(phaseGatesText.includes('evaluateReviewCompleteness') && phaseGatesText.includes('evaluateDoneIntentEquivalence'), 'phase-gates.ts: REVIEW/DONE ProofStory diagnostics must be wired through existing phase gates');

  for (const commandName of [
    'milestone_ledger_set',
    'milestone_ledger_add',
    'slice_plan_set',
    'proofstory_contract_set',
    'intent_collision_set',
    'red_evidence_create',
    'spike_start',
    'spike_result_set',
    'spike_result',
    'spike_discard',
    'spike_promote',
  ]) {
    const policy = commandPolicyEntries.get(commandName);
    assert(policy, `${commandPolicyPath}: ProofStory pre-DEV command missing policy: ${commandName}`);
    if (!policy) continue;
    assert(policy.allowedPhases.includes('PLAN'), `${commandPolicyPath}: ${commandName} must remain PLAN-authorable`);
    assert(!policy.allowedPhases.includes('DEV'), `${commandPolicyPath}: ${commandName} must not be authorable in DEV`);
    assert(commandAllowedByDefaultConfig(commandName, 'PLAN', configText), `packages/main/src/core/config.ts: ${commandName} must be allowed in PLAN`);
    assert(!commandAllowedByDefaultConfig(commandName, 'DEV', configText), `packages/main/src/core/config.ts: ${commandName} must not be allowed in DEV`);
  }
  const snapshotPolicy = commandPolicyEntries.get('original_intent_snapshot_set');
  assert(snapshotPolicy?.allowedPhases.includes('INIT') && snapshotPolicy?.allowedPhases.includes('PLAN'), `${commandPolicyPath}: original_intent_snapshot_set must be INIT/PLAN-authorable`);
  assert(!snapshotPolicy?.allowedPhases.includes('DEV'), `${commandPolicyPath}: original_intent_snapshot_set must not be authorable in DEV`);
  const shrinkagePolicy = commandPolicyEntries.get('scope_shrinkage_decision_set');
  assert(shrinkagePolicy?.allowedPhases.includes('DEV') && shrinkagePolicy?.allowedPhases.includes('REVIEW') && shrinkagePolicy?.allowedPhases.includes('TEST'), `${commandPolicyPath}: scope_shrinkage_decision_set remains the documented post-DEV ProofStory writer`);
  assert(/userConfirmed:true/.test(shrinkagePolicy?.reason || ''), `${commandPolicyPath}: scope_shrinkage_decision_set policy must document the userConfirmed:true post-DEV safety condition`);
  const rollupPolicy = commandPolicyEntries.get('parent_ledger_rollup_set');
  assert(rollupPolicy?.allowedPhases.includes('TEST'), `${commandPolicyPath}: parent_ledger_rollup_set must be refreshable before DONE`);
}

function assertProofStoryGateConsumedFacts() {
  const levelRegistry = new Map(parseProcessFactLevelRegistry().map(entry => [entry.name, entry]));
  const registry = processFactRegistryMap();
  const commands = [
    'original_intent_snapshot_set',
    'milestone_ledger_set',
    'milestone_ledger_add',
    'slice_plan_set',
    'parent_ledger_rollup_set',
    'proofstory_contract_set',
    'intent_collision_set',
    'scope_shrinkage_decision_set',
    'red_evidence_create',
    'spike_start',
    'spike_result_set',
    'spike_result',
    'spike_discard',
    'spike_promote',
  ];
  for (const commandName of commands) {
    const levelEntry = levelRegistry.get(commandName);
    assert(levelEntry, `${processFactLevelRegistryPath}: ProofStory gate command missing from PROCESS_FACT_LEVELS: ${commandName}`);
    if (!levelEntry) continue;
    assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${commandName} must stay L4`);
    assert(/ProofStory/.test(levelEntry.gateConsumer || ''), `${processFactLevelRegistryPath}: ${commandName} must name ProofStory gate consumer`);

    const registryEntry = registry.get(commandName);
    assert(registryEntry, `${processFactRegistryPath}: ProofStory gate command missing from registry: ${commandName}`);
    if (!registryEntry) continue;
    assert(registryEntry.level === 'L4', `${processFactRegistryPath}: ${commandName} registry level must stay L4`);
    assert(registryEntry.semantics.includes('gate-evidence'), `${processFactRegistryPath}: ${commandName} must include gate-evidence semantics`);
  }

  for (const artifactName of [
    'artifact:original-intent-snapshot.json',
    'artifact:milestone-ledger.json',
    'artifact:slice-plan.json',
    'artifact:parent-ledger-rollup.json',
    'artifact:proofstory.json',
    'artifact:intent-collision.json',
    'artifact:scope-shrinkage-decision.json',
    'artifact:red-evidence.json',
    'artifact:spike.json',
  ]) {
    const artifactEntry = registry.get(artifactName);
    assert(artifactEntry, `${processFactRegistryPath}: ProofStory gate artifact missing from registry: ${artifactName}`);
    if (!artifactEntry) continue;
    assert(artifactEntry.level === 'L4', `${processFactRegistryPath}: ${artifactName} must stay L4`);
    assert(artifactEntry.semantics.includes('gate-evidence'), `${processFactRegistryPath}: ${artifactName} must include gate-evidence semantics`);
    assert(/ProofStory/.test(artifactEntry.consumerGate || ''), `${processFactRegistryPath}: ${artifactName} must name ProofStory gate consumer`);
  }
}

function isReviewerPrompt(relPath, text) {
  const name = basename(relPath);
  return name.startsWith('lattice-review-') || requiredReviewerRunIdPromptFiles.has(name) || text.includes('review_pass_set');
}

function scanBraceState(line, state) {
  for (const char of line) {
    if (state.escaped) {
      state.escaped = false;
      continue;
    }
    if (state.inString) {
      if (char === '\\') state.escaped = true;
      else if (char === '"') state.inString = false;
      continue;
    }
    if (char === '"') {
      state.inString = true;
      continue;
    }
    if (char === '{') {
      state.seenJson = true;
      state.depth += 1;
      continue;
    }
    if (char === '}') {
      state.depth -= 1;
    }
  }
  return state;
}

function commandBlocks(text, command) {
  const commandPattern = new RegExp(`\\b(?:lattice|koala)\\s+${command}\\b`);
  const anyCliCommandPattern = /\b(?:lattice|koala)\s+[a-z_][a-z0-9_]*\b/;
  const lines = text.split(/\r?\n/);
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(commandPattern);
    if (!match) continue;

    const state = scanBraceState(line.slice(match.index), {
      depth: 0,
      escaped: false,
      inString: false,
      seenJson: false,
    });
    const blockLines = [line];

    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      if (state.seenJson && state.depth <= 0) break;

      const nextLine = lines[nextIndex];
      const trimmed = nextLine.trim();
      if (!state.seenJson && (!trimmed || trimmed.startsWith('```') || anyCliCommandPattern.test(nextLine))) break;

      blockLines.push(nextLine);
      scanBraceState(nextLine, state);
    }

    blocks.push({ block: blockLines.join('\n'), lineNo: index + 1 });
  }

  return blocks;
}

function requiresReviewPassProtocol(label) {
  return reviewPassReviewerPrompts.has(basename(label)) || label.startsWith('synthetic-');
}

function requiresNoFindingReviewPassProtocol(label) {
  return basename(label) !== 'lattice-evaluator.md' && requiresReviewPassProtocol(label);
}

function hasHardCodedReviewRunIdExample(block) {
  return /\breviewRunId\b[\s\S]{0,160}\b(?:B-[A-Za-z0-9_-]+|<ID>|\$\{[^}]+\}):RR-001\b/.test(block);
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function scanAgentMachineValues(block, label, lineNo) {
  const issues = [];
  for (const match of block.matchAll(/["']?agent["']?\s*:\s*["']([^"']+)["']/g)) {
    const value = match[1];
    if (hanCharacterPattern.test(value)) {
      issues.push(`${label}:${lineNo} machine field "agent" uses non-code value "${value}"; use an English/code-like reviewer id or placeholder`);
    }
  }
  return issues;
}

function scanPromptText(text, label) {
  const issues = [];
  const reviewRunBlocks = commandBlocks(text, 'review_run_start');
  for (const { block, lineNo } of reviewRunBlocks) {
    issues.push(...scanAgentMachineValues(block, label, lineNo));
  }

  const findingBlocks = commandBlocks(text, 'finding_add');
  for (const { block, lineNo } of findingBlocks) {
    issues.push(...scanAgentMachineValues(block, label, lineNo));
    if (requiresReviewPassProtocol(label) && hasHardCodedReviewRunIdExample(block)) {
      issues.push(`${label}:${lineNo} active reviewer command example must use the reviewRunId returned by review_run_start, not a hard-coded RR-001`);
    }
    if (passOnlyFindingAddPatterns.some(pattern => pattern.test(block))) {
      issues.push(`${label}:${lineNo} pass-only finding_add must use review_pass_set`);
    }
    if (requiresReviewPassProtocol(label) && block.includes('{') && !/\breviewRunId\b/.test(block)) {
      issues.push(`${label}:${lineNo} reviewer finding_add example must include reviewRunId from review_run_start`);
    }
    for (const match of block.matchAll(/["']?category["']?\s*:\s*["']([^"']+)["']/g)) {
      const category = match[1];
      if (currentCategories.has(category)) continue;
      if (legacyCategories.has(category)) {
        issues.push(`${label}:${lineNo} active finding_add example uses legacy category "${category}"; use "missing" and keep legacy names only in compatibility text`);
      } else {
        issues.push(`${label}:${lineNo} active finding_add example uses unknown category "${category}"`);
      }
    }
  }

  const reviewPassBlocks = commandBlocks(text, 'review_pass_set');
  for (const { block, lineNo } of reviewPassBlocks) {
    issues.push(...scanAgentMachineValues(block, label, lineNo));
    if (requiresReviewPassProtocol(label) && hasHardCodedReviewRunIdExample(block)) {
      issues.push(`${label}:${lineNo} active reviewer command example must use the reviewRunId returned by review_run_start, not a hard-coded RR-001`);
    }
    if (requiresReviewPassProtocol(label) && block.includes('{') && !/\breviewRunId\b/.test(block)) {
      issues.push(`${label}:${lineNo} reviewer review_pass_set example must include reviewRunId from review_run_start`);
    }
  }

  const hasFindingProtocol = text.includes('finding_add');
  const hasReviewPassProtocol = text.includes('review_pass_set');
  const claimsNoFindings = /\bno\s+(?:blocking\s+)?findings?\b|\bno\s+blockers?\b|没有\s*findings?|没有\s*finding|无\s*blocker|无\s+blocking|无\s+finding|审查通过|review\s+passed/i.test(text);
  if (requiresNoFindingReviewPassProtocol(label) && hasFindingProtocol && claimsNoFindings && !text.includes('review_pass_set')) {
    issues.push(`${label}: reviewer prompt claims no findings or completion but never uses review_pass_set`);
  }
  if (requiresReviewPassProtocol(label) && (hasFindingProtocol || hasReviewPassProtocol)) {
    if (!text.includes('review_run_start')) {
      issues.push(`${label}: reviewer prompt emits REVIEW evidence but never starts review_run_start`);
    }
    if (!text.includes('reviewRunId')) {
      issues.push(`${label}: reviewer prompt emits REVIEW evidence but never mentions reviewRunId`);
    }
  }
  return issues;
}

function scanCliMachineFactNames(text, label) {
  const issues = [];
  for (const match of text.matchAll(/\bname\s*:\s*['"]([^'"]+)['"]/g)) {
    const name = match[1];
    if (hanCharacterPattern.test(name) || !codeLikeCommandNamePattern.test(name)) {
      issues.push(`${label}:${lineNumberAt(text, match.index)} CLI command/fact name "${name}" must stay English/code-like`);
    }
  }

  for (const match of text.matchAll(/\b(status|level|category|kind|destructiveRisk|allowedPhases|disposition)\s*:\s*['"]([^'"]+)['"]/g)) {
    const property = match[1];
    const value = match[2];
    if (hanCharacterPattern.test(value)) {
      issues.push(`${label}:${lineNumberAt(text, match.index)} machine fact ${property} value "${value}" must stay English/code-like`);
    }
  }

  for (const match of text.matchAll(/z\.enum\(\s*\[([\s\S]*?)\]\s*\)/g)) {
    const enumBody = match[1];
    const enumLine = lineNumberAt(text, match.index);
    for (const valueMatch of enumBody.matchAll(/['"]([^'"]+)['"]/g)) {
      const value = valueMatch[1];
      if (hanCharacterPattern.test(value)) {
        issues.push(`${label}:${enumLine} CLI schema enum value "${value}" must stay English/code-like`);
      }
    }
  }

  return issues;
}

function scanCodeLikeStringArrayConst(text, label, constName) {
  const issues = [];
  const pattern = new RegExp(`(?:export\\s+)?const\\s+${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s+const`);
  const match = text.match(pattern);
  if (!match) {
    issues.push(`${label}: missing code-like string array const ${constName}`);
    return issues;
  }

  const body = match[1];
  for (const valueMatch of body.matchAll(/['"]([^'"]+)['"]/g)) {
    const value = valueMatch[1];
    if (hanCharacterPattern.test(value) || !/^[a-z][a-z0-9_]*$/.test(value)) {
      issues.push(`${label}: ${constName} value "${value}" must stay English/code-like`);
    }
  }
  return issues;
}

function scanReviewRoundPromptSchema(text, label) {
  const issues = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const context = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3)).join('\n');
    if (context.includes('story_review.planReviewRound')) continue;

    if (/\breviewRound\s*:\s*number\b/.test(line)) {
      issues.push(`${label}:${index + 1} bare reviewRound:number drift; signed reviewRound must be ISO string`);
    }
    if (/["']reviewRound["']\s*:\s*\d+\b/.test(line)) {
      issues.push(`${label}:${index + 1} numeric reviewRound example drift; signed reviewRound must be ISO string`);
    }
    if (/F-035\b/.test(line) && /reviewRound/.test(line) && /\bnumber\b/.test(line)) {
      issues.push(`${label}:${index + 1} F-035 numeric reviewRound drift; use ISO string signed reviewRound wording`);
    }
  }
  return issues;
}

function promptSemanticTokens(text) {
  const tokens = new Set();
  for (const match of text.matchAll(/\bkoala\s+([a-z_][a-z0-9_]*)\b/g)) {
    tokens.add(`cmd:${match[1]}`);
  }
  for (const match of text.matchAll(/(?:^|[\s`"'(])((?:\.koala|\.lattice-codex|\.claude|docs|packages|bin)\/[A-Za-z0-9._/@:-]+(?:\/[A-Za-z0-9._/@:-]+)*)/g)) {
    tokens.add(`path:${match[1].replace(/[),.;:]+$/, '')}`);
  }
  for (const name of ['review_run_start', 'finding_add', 'review_pass_set', 'init_check_set', 'scope_check_save', 'delivery_check_set', 'verification_evidence_add', 'verification_evidence_batch_add']) {
    if (text.includes(name)) tokens.add(`cmd:${name}`);
  }
  return [...tokens].sort();
}

function comparePromptSemantics(promptMap) {
  const templateDir = 'packages/main/templates/agents';
  const mirrorDirs = ['.claude/agents', '.lattice-codex/agents'];
  const templateFiles = [...promptMap.keys()]
    .filter(relPath => relPath.startsWith(`${templateDir}/`))
    .sort();

  for (const templateRel of templateFiles) {
    const name = basename(templateRel);
    const templateTokens = promptSemanticTokens(promptMap.get(templateRel));
    for (const mirrorDir of mirrorDirs) {
      const mirrorRel = `${mirrorDir}/${name}`;
      if (!promptMap.has(mirrorRel)) {
        warn(`${mirrorRel} missing; no semantic drift comparison available`);
        continue;
      }
      const mirrorTokens = promptSemanticTokens(promptMap.get(mirrorRel));
      const missing = templateTokens.filter(token => !mirrorTokens.includes(token));
      const extra = mirrorTokens.filter(token => !templateTokens.includes(token));
      if (missing.length || extra.length) {
        const changed = [...missing, ...extra];
        const commandOrPathDrift = changed.some(token => token.startsWith('cmd:') || token.startsWith('path:'));
        const message = `${mirrorRel} command/path semantics drifted from template ${templateRel}; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`;
        if (commandOrPathDrift) fail(message);
        else warn(message);
      }
    }
  }
}

function paragraphBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let current = [];
  let startLine = 1;

  function flush() {
    if (!current.length) return;
    blocks.push({ block: current.join('\n'), lineNo: startLine });
    current = [];
  }

  for (const [index, line] of lines.entries()) {
    if (/^\s*$/.test(line)) {
      flush();
      continue;
    }
    if (!current.length) startLine = index + 1;
    current.push(line);
  }
  flush();

  return blocks;
}

function scanActiveLifecycleDocText(text, label) {
  const issues = [];
  const lines = text.split(/\r?\n/);

  for (const { block, lineNo } of paragraphBlocks(text)) {
    if (!/\btest_auto\b/.test(block)) continue;

    const blockLines = block.split(/\r?\n/);
    for (const [offset, rawLine] of blockLines.entries()) {
      const line = rawLine.replace(/\s+/g, ' ').trim();
      if (!line || legacyTestAutoNegatedProcessFactPattern.test(line)) continue;
      const namesOtherLegacyCommand = legacyTestFixtureCommands
        .filter(commandName => commandName !== 'test_auto')
        .some(commandName => new RegExp(`\\b${commandName}\\b`).test(line));
      if (namesOtherLegacyCommand && !/\btest_auto\b/.test(line)) continue;

      for (const { label: claimLabel, pattern } of legacyTestAutoProcessFactClaimPatterns) {
        if (pattern.test(line)) {
          issues.push(`${label}:${lineNo + offset} active lifecycle doc must not claim legacy test_auto ${claimLabel}`);
        }
      }
    }
  }

  for (const [index, line] of lines.entries()) {
    if (/\bkoala\s+validate\b/.test(line)) {
      const lineNo = index + 1;
      const context = lines
        .slice(Math.max(0, index - 2), Math.min(lines.length, index + 3))
        .join('\n');
      if (!legacyAliasDocContextPattern.test(context)) {
        issues.push(`${label}:${lineNo} active lifecycle docs must use lattice validate as current primary; koala validate may appear only as a legacy alias/compat reference`);
      }
    }

    if (!line.includes(coverageReviewerLaneName)) continue;

    const lineNo = index + 1;
    for (const { label: claimLabel, pattern } of coverageReviewerCliCommandPatterns) {
      if (pattern.test(line)) {
        issues.push(`${label}:${lineNo} ${coverageReviewerLaneName} must not be documented as a CLI/tool command (${claimLabel})`);
      }
    }

    const context = lines
      .slice(Math.max(0, index - 1), Math.min(lines.length, index + 2))
      .join('\n');
    if (!coverageReviewerLaneContextPattern.test(context)) {
      issues.push(`${label}:${lineNo} ${coverageReviewerLaneName} must be described as a reviewer agent/lane`);
    }
  }

  return issues;
}

function assertSyntheticAdversarialChecks() {
  const badPassOnlyLines = [
    'lattice finding_add \'{"storyId":"B-x","desc":"文档一致性检查通过","severity":"low","category":"happy","agent":"lattice-review-docs"}\'',
    'lattice finding_add \'{"storyId":"B-x","desc":"consistency check PASSED","severity":"low","category":"happy","agent":"lattice-review-docs"}\'',
    'lattice finding_add \'{"storyId":"B-x","desc":"no findings","severity":"low","category":"happy","agent":"lattice-review-quality"}\'',
    'lattice finding_add \'{"storyId":"B-x","desc":"PASS","severity":"low","category":"happy","agent":"lattice-review-quality"}\'',
  ];
  for (const [index, line] of badPassOnlyLines.entries()) {
    assert(
      scanPromptText(line, `synthetic-pass-only-${index}`).some(issue => issue.includes('pass-only finding_add')),
      `synthetic pass-only finding_add prompt ${index + 1} should fail`,
    );
  }
  const multilinePassOnly = [
    "lattice finding_add '{",
    '  storyId:"B-x",',
    '  desc:"PASS",',
    '  severity:"low",',
    '  category:"happy",',
    '  agent:"lattice-review-quality"',
    "}'",
  ].join('\n');
  assert(
    scanPromptText(multilinePassOnly, 'synthetic-multiline-pass-only').some(issue => issue.includes('pass-only finding_add')),
    'synthetic multiline pass-only finding_add prompt should fail',
  );

  const noReviewPass = [
    'Use lattice finding_add for every problem.',
    'No findings. Review passed.',
  ].join('\n');
  assert(
    scanPromptText(noReviewPass, 'synthetic-no-review-pass').some(issue => issue.includes('review_pass_set')),
    'synthetic no-finding prompt without review_pass_set should fail',
  );

  const activeLegacy = 'lattice finding_add \'{"storyId":"B-x","desc":"cleanup","severity":"medium","category":"cleanup","agent":"lattice-review-quality"}\'';
  assert(
    scanPromptText(activeLegacy, 'synthetic-active-legacy').some(issue => issue.includes('legacy category')),
    'synthetic active legacy category should fail',
  );
  const multilineLegacy = [
    "lattice finding_add '{",
    '  storyId:"B-x",',
    '  desc:"real issue",',
    '  severity:"medium",',
    '  category:"cleanup",',
    '  agent:"lattice-review-quality"',
    "}'",
  ].join('\n');
  assert(
    scanPromptText(multilineLegacy, 'synthetic-multiline-legacy').some(issue => issue.includes('legacy category')),
    'synthetic multiline legacy category should fail',
  );

  const unknownCategory = 'lattice finding_add \'{"storyId":"B-x","desc":"docs","severity":"medium","category":"docs","agent":"lattice-review-quality"}\'';
  assert(
    scanPromptText(unknownCategory, 'synthetic-unknown-category').some(issue => issue.includes('unknown category')),
    'synthetic unknown category should fail',
  );
  const literalReviewRunId = 'lattice finding_add \'{"storyId":"B-x","reviewRunId":"B-x:RR-001","desc":"real issue","severity":"medium","category":"missing","agent":"lattice-review-quality"}\'';
  assert(
    scanPromptText(literalReviewRunId, 'synthetic-literal-review-run-id').some(issue => issue.includes('hard-coded RR-001')),
    'synthetic literal RR-001 reviewer command should fail',
  );
  const missingFindingReviewRunId = 'lattice finding_add \'{"storyId":"B-x","desc":"real issue","severity":"medium","category":"missing","agent":"lattice-review-quality"}\'';
  assert(
    scanPromptText(missingFindingReviewRunId, 'packages/main/templates/agents/lattice-review-story-init.md')
      .some(issue => issue.includes('finding_add example must include reviewRunId')),
    'synthetic reviewer finding_add JSON example without reviewRunId should fail',
  );
  const missingPassReviewRunId = 'lattice review_pass_set \'{"storyId":"B-x","agent":"lattice-review-quality","note":"quality review passed: checked changed files and found no blocker."}\'';
  assert(
    scanPromptText(missingPassReviewRunId, 'packages/main/templates/agents/lattice-evaluator.md')
      .some(issue => issue.includes('review_pass_set example must include reviewRunId')),
    'synthetic reviewer review_pass_set JSON example without reviewRunId should fail',
  );
  assert(
    scanReviewRoundPromptSchema('reviewRound: number, // 当前 REVIEW 轮次（1 / 2 / 3+）', 'synthetic-review-round-number')
      .some(issue => issue.includes('bare reviewRound:number drift')),
    'synthetic bare reviewRound:number prompt schema should fail',
  );
  assert(
    scanReviewRoundPromptSchema('reviewRound: number, // F-035: 顶层 reviewRound', 'synthetic-review-round-f035')
      .some(issue => issue.includes('bare reviewRound:number drift')),
    'synthetic F-035 numeric reviewRound prompt schema should fail',
  );
  assert(
    scanReviewRoundPromptSchema('"reviewRound": 1,', 'synthetic-review-round-json-number')
      .some(issue => issue.includes('numeric reviewRound example drift')),
    'synthetic numeric reviewRound JSON example should fail',
  );
  assert(
    scanReviewRoundPromptSchema('story_review.planReviewRound: number (PLAN review round count)', 'synthetic-plan-review-round').length === 0,
    'synthetic story_review.planReviewRound numeric docs should pass',
  );
  const multilineUnknown = [
    "lattice finding_add '{",
    '  storyId:"B-x",',
    '  desc:"real issue",',
    '  severity:"medium",',
    '  category:"docs",',
    '  agent:"lattice-review-quality"',
    "}'",
  ].join('\n');
  assert(
    scanPromptText(multilineUnknown, 'synthetic-multiline-unknown').some(issue => issue.includes('unknown category')),
    'synthetic multiline unknown category should fail',
  );

  const goodPrompt = [
    'lattice review_run_start \'{"storyId":"B-x","agent":"lattice-review-quality"}\'',
    'lattice finding_add \'{"storyId":"B-x","reviewRunId":"<reviewRunId from review_run_start>","desc":"real issue","severity":"medium","category":"missing","agent":"lattice-review-quality"}\'',
    'lattice review_pass_set \'{"storyId":"B-x","agent":"lattice-review-quality","reviewRunId":"<reviewRunId from review_run_start>","note":"quality review passed: checked changed files and found no blocker."}\'',
  ].join('\n');
  assert(scanPromptText(goodPrompt, 'synthetic-good').length === 0, 'synthetic good prompt should pass');

  const localizedAgentPlaceholder = 'lattice review_run_start \'{"storyId":"B-x","agent":"<本 reviewer 名>"}\'';
  assert(
    scanPromptText(localizedAgentPlaceholder, 'synthetic-localized-agent-placeholder')
      .some(issue => issue.includes('machine field "agent" uses non-code value')),
    'synthetic localized agent placeholder should fail',
  );

  const localizedCliEnum = "  section: z.enum(['触发事件', '关键洞察']).describe('target'),";
  assert(
    scanCliMachineFactNames(localizedCliEnum, 'synthetic-localized-cli-enum')
      .some(issue => issue.includes('CLI schema enum value')),
    'synthetic localized CLI enum should fail',
  );

  const localizedCliName = "  { name: '状态_检查', description: 'bad', schema: {} },";
  assert(
    scanCliMachineFactNames(localizedCliName, 'synthetic-localized-cli-name')
      .some(issue => issue.includes('CLI command/fact name')),
    'synthetic localized CLI command name should fail',
  );

  const localizedConstArray = "export const BACKGROUND_SECTION_IDS = ['trigger_event', '触发事件'] as const;";
  assert(
    scanCodeLikeStringArrayConst(localizedConstArray, 'synthetic-localized-section-ids', 'BACKGROUND_SECTION_IDS')
      .some(issue => issue.includes('BACKGROUND_SECTION_IDS value')),
    'synthetic localized background section id const should fail',
  );

  const syntheticCli = "  { name: 'surprise_check_set', description: '保存新的流程确认', schema: {} },";
  assert(
    findUninventoriedProcessFactCommands(syntheticCli).includes('surprise_check_set'),
    'synthetic new process fact handler should fail until inventoried',
  );

  const syntheticTypedPolicy = [
    'export const COMMAND_POLICIES: Record<string, CommandPolicy> = {',
    '  tricky_command: {',
    '    status: "supported",',
    '    allowedPhases: ["PLAN", "REVIEW"],',
    '    destructiveRisk: "none",',
    '    reason: "Reviewer\\\'s plan artifact with \\"quotes\\" stays parseable.",',
    '    replacement: `Use lattice validate --story=<storyId> and record verificationEvidence`,',
    '  },',
    '} as const satisfies Record<string, CommandPolicy>;',
  ].join('\n');
  const syntheticBody = extractExportedObjectBody(syntheticTypedPolicy, 'COMMAND_POLICIES', 'synthetic-command-policy.ts');
  const syntheticOpen = syntheticBody.indexOf('{');
  const syntheticBlock = extractBalancedBlock(syntheticBody, syntheticOpen, '{', '}', 'synthetic-command-policy.ts tricky_command');
  assert(
    readStringProperty(syntheticBlock, 'reason').includes('Reviewer\'s plan artifact') &&
      readStringProperty(syntheticBlock, 'replacement').includes('verificationEvidence') &&
      parseStringArrayProperty(syntheticBlock, 'allowedPhases').includes('REVIEW'),
    'synthetic command policy parser should tolerate typed exports, apostrophes, escaped quotes, and template strings',
  );

  const syntheticPhaseTools = [
    'const unrelated = "DEV: [\'comment_only_command\']";',
    '// DEV: [\'line_comment_command\']',
    'export const DEFAULT_PHASE_TOOLS: Record<string, string[]> = {',
    "  // '*': ['commented_global_tool']",
    "  '*': [",
    "    'session_brief',",
    "    'aux_*', // 'comment_only_command' must not be parsed",
    "    'quoted # value',",
    '  ],',
    '  DEV: [',
    "    'checklist_update',",
    '    /*',
    "      '*': ['commented_star_command']",
    "      'commented_dev_command'",
    '    */',
    "    'finding_add',",
    '  ],',
    '  REVIEW: [',
    "    'review_pass_set',",
    '  ],',
    '} as const;',
  ].join('\n');
  const syntheticGlobalTools = extractPhaseToolEntries(syntheticPhaseTools, '*');
  assert(
    syntheticGlobalTools.has('session_brief') &&
      syntheticGlobalTools.has('aux_*') &&
      syntheticGlobalTools.has('quoted # value') &&
      !syntheticGlobalTools.has('comment_only_command') &&
      !syntheticGlobalTools.has('commented_global_tool') &&
      !syntheticGlobalTools.has('commented_star_command'),
    'synthetic DEFAULT_PHASE_TOOLS parser should handle quoted "*" key, strings, and comments',
  );
  const syntheticDevTools = extractPhaseToolEntries(syntheticPhaseTools, 'DEV');
  assert(
    syntheticDevTools.has('checklist_update') &&
      syntheticDevTools.has('finding_add') &&
      !syntheticDevTools.has('commented_dev_command') &&
      !syntheticDevTools.has('line_comment_command'),
    'synthetic DEFAULT_PHASE_TOOLS parser should handle ordinary phase keys without reading comments',
  );

  const widenedPhaseTools = {
    DEV: ['test_auto', 'test_add', 'review_pass_set', 'validate'],
  };
  assert(
    !commandAllowedByConfiguredPhaseTools('test_auto', 'DEV', widenedPhaseTools) &&
      !commandAllowedByConfiguredPhaseTools('test_add', 'DEV', widenedPhaseTools) &&
      !commandAllowedByConfiguredPhaseTools('review_pass_set', 'DEV', widenedPhaseTools) &&
      commandAllowedByConfiguredPhaseTools('validate', 'DEV', widenedPhaseTools),
    'runtime phaseTools config must narrow only: it cannot widen rootOnly/legacy commands or REVIEW-only gate evidence',
  );

  const badTestAutoBugDoc = [
    'Legacy `test_auto` 是兼容 runner。',
    '6. 自动 bug 管理：fail 创建 bug，pass 自动 fix bug',
  ].join('\n');
  assert(
    scanActiveLifecycleDocText(badTestAutoBugDoc, 'synthetic-test-auto-bug-doc').some(issue => issue.includes('auto bug management')),
    'synthetic active lifecycle doc that gives test_auto automatic bug management should fail',
  );

  const badTestAutoEvidenceDoc = [
    'Legacy `test_auto` 是兼容 runner。',
    '6. writes test-evidence.json and records verificationEvidence',
  ].join('\n');
  assert(
    scanActiveLifecycleDocText(badTestAutoEvidenceDoc, 'synthetic-test-auto-evidence-doc').some(issue => issue.includes('test-evidence writes')),
    'synthetic active lifecycle doc that gives test_auto test-evidence writes should fail',
  );

  const goodTestAutoDoc = [
    'Legacy `test_auto` 是兼容 runner。',
    '它不会写 `bug.json`，也不会写 `test-evidence.json`。',
  ].join('\n');
  assert(
    scanActiveLifecycleDocText(goodTestAutoDoc, 'synthetic-test-auto-good-doc').length === 0,
    'synthetic active lifecycle doc may explicitly say test_auto does not write bug/test evidence',
  );

  const badCoverageToolDoc = '| `lattice-review-test-coverage` | 检查 verificationIntent 覆盖 |';
  assert(
    scanActiveLifecycleDocText(badCoverageToolDoc, 'synthetic-coverage-tool-doc').some(issue => issue.includes('CLI/tool command')),
    'synthetic coverage reviewer documented as a tool table row should fail',
  );

  const badCoverageBareDoc = '`lattice-review-test-coverage` checks coverage.';
  assert(
    scanActiveLifecycleDocText(badCoverageBareDoc, 'synthetic-coverage-bare-doc').some(issue => issue.includes('reviewer agent/lane')),
    'synthetic bare coverage reviewer name without reviewer/lane context should fail',
  );

  const goodCoverageLaneDoc = 'reviewer lane `lattice-review-test-coverage` checks verificationIntent coverage and uses review_pass_set when no blocker exists.';
  assert(
    scanActiveLifecycleDocText(goodCoverageLaneDoc, 'synthetic-coverage-good-doc').length === 0,
    'synthetic coverage reviewer lane wording should pass',
  );

  const badKoalaValidatePrimaryDoc = 'TEST 阶段运行 `koala validate`，写 validation evidence。';
  assert(
    scanActiveLifecycleDocText(badKoalaValidatePrimaryDoc, 'synthetic-koala-validate-primary-doc').some(issue => issue.includes('lattice validate as current primary')),
    'synthetic active lifecycle doc that documents koala validate as current primary should fail',
  );

  const goodKoalaValidateAliasDoc = 'TEST 阶段运行 `lattice validate`（legacy alias: `koala validate`），写 validation evidence。';
  assert(
    scanActiveLifecycleDocText(goodKoalaValidateAliasDoc, 'synthetic-koala-validate-alias-doc').length === 0,
    'synthetic active lifecycle doc may mention koala validate only as a legacy alias',
  );
}

function extractExportedArrayBody(text, exportName) {
  const match = new RegExp(`\\bexport\\s+const\\s+${exportName}\\b(?:\\s*:\\s*[^=]+)?\\s*=\\s*\\[`).exec(text);
  assert(Boolean(match), `source should export ${exportName}`);
  if (!match) return '';

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  const arrayStart = match.index + match[0].lastIndexOf('[');

  for (let index = arrayStart; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = true;
      quote = char;
      continue;
    }
    if (char === '[') {
      depth += 1;
      continue;
    }
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(arrayStart + 1, index);
    }
  }

  fail(`${processFactLevelRegistryPath} ${exportName} array should close`);
  return '';
}

function extractBalancedBlock(text, openIndex, openChar, closeChar, label) {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = true;
      quote = char;
      continue;
    }
    if (char === openChar) {
      depth += 1;
      continue;
    }
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, index);
    }
  }

  fail(`${label} block should close`);
  return '';
}

function extractExportedObjectBody(text, exportName, relPath) {
  const match = new RegExp(`\\bexport\\s+const\\s+${exportName}\\b(?:\\s*:\\s*[^=]+)?\\s*=\\s*\\{`).exec(text);
  assert(Boolean(match), `${relPath} should export ${exportName}`);
  if (!match) return '';
  const objectStart = match.index + match[0].lastIndexOf('{');
  return extractBalancedBlock(text, objectStart, '{', '}', `${relPath} ${exportName}`);
}

function extractConstInitializer(text, constName, relPath) {
  const match = new RegExp(`\\b(?:export\\s+)?const\\s+${constName}\\b(?:\\s*:\\s*[^=]+)?\\s*=\\s*`).exec(text);
  assert(Boolean(match), `${relPath} should declare ${constName}`);
  if (!match) return '';

  const startIndex = match.index + match[0].length;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = true;
      quote = char;
      continue;
    }
    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth -= 1;
      continue;
    }
    if (char === '[') {
      bracketDepth += 1;
      continue;
    }
    if (char === ']') {
      bracketDepth -= 1;
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
      continue;
    }
    if (char === '}') {
      braceDepth -= 1;
      continue;
    }
    if (char === ';' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      return text.slice(startIndex, index).trim();
    }
  }

  fail(`${relPath} ${constName} initializer should terminate with a semicolon`);
  return '';
}

function assertInitializerPattern(initializer, label, pattern, message) {
  assert(pattern.test(initializer), `${processFactRegistryPath}: ${label} ${message}`);
}

function extractObjectPropertyBlock(objectText, propertyName, label) {
  const match = new RegExp(`\\b${propertyName}\\s*:\\s*\\{`).exec(objectText);
  assert(Boolean(match), `${label} should declare ${propertyName}`);
  if (!match) return '';

  const openIndex = match.index + match[0].lastIndexOf('{');
  return extractBalancedBlock(objectText, openIndex, '{', '}', `${label} ${propertyName}`);
}

function assertArrayPropertyIncludesValue(block, propertyName, value, label) {
  const match = new RegExp(`\\b${propertyName}\\s*:\\s*\\[`).exec(block);
  assert(Boolean(match), `${label} should declare ${propertyName}`);
  if (!match) return;

  const openIndex = match.index + match[0].lastIndexOf('[');
  const arrayBody = extractBalancedBlock(block, openIndex, '[', ']', `${label} ${propertyName}`);
  assert(
    new RegExp(`['"]${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(arrayBody),
    `${label} ${propertyName} must include '${value}'`,
  );
}

function assertProcessFactMappedSourceContracts(sourceText) {
  const commandFactsInitializer = extractConstInitializer(sourceText, 'COMMAND_PROCESS_FACTS', processFactRegistryPath);
  assertInitializerPattern(
    commandFactsInitializer,
    'COMMAND_PROCESS_FACTS',
    /\bPROCESS_FACT_LEVELS\s*[\s\S]*\.filter\s*\(\s*\(entry:\s*ProcessFactLevelEntry\)\s*=>\s*!entry\.name\.startsWith\('flow-policy:'\)\s*\)\s*[\s\S]*\.map\s*\(/,
    'must map PROCESS_FACT_LEVELS directly while excluding flow-policy facts from command facts',
  );
  assertInitializerPattern(
    commandFactsInitializer,
    'COMMAND_PROCESS_FACTS',
    /\bconst\s+policy\s*=\s*commandPolicy\(entry\.name\)\s*;/,
    'must derive lifecycle policy from commandPolicy(entry.name)',
  );
  assertInitializerPattern(
    commandFactsInitializer,
    'COMMAND_PROCESS_FACTS',
    /\bconst\s+rootOnly\s*=\s*policy\s*\?\s*policy\.rootOnly\s*===\s*true\s*\|\|\s*policy\.status\s*===\s*'rootOnly'\s*:\s*undefined\s*;/,
    'must wire rootOnly from policy.rootOnly/status',
  );
  assertInitializerPattern(
    commandFactsInitializer,
    'COMMAND_PROCESS_FACTS',
    /\bconst\s+gateEvidence\s*=\s*policy\s*\?\s*policy\.gateEvidence\s*===\s*true\s*\|\|\s*policy\.status\s*===\s*'gateEvidence'\s*:\s*undefined\s*;/,
    'must wire gateEvidence from policy.gateEvidence/status',
  );
  for (const [fieldLabel, pattern] of [
    ['name', /\bname:\s*entry\.name\b/],
    ['kind', /\bkind:\s*commandFactKind\(entry\.name,\s*entry\.level\)/],
    ['semantics', /\bsemantics:\s*commandFactSemantics\(entry\.name,\s*entry\.level\)/],
    ['level', /\blevel:\s*entry\.level\b/],
    ['lifecycle', /\blifecycle:\s*policy\?\.status\b/],
    ['allowedPhases', /\ballowedPhases:\s*policy\?\.allowedPhases\b/],
    ['rootOnly', /\brootOnly\s*,/],
    ['legacy', /\blegacy:\s*policy\s*\?\s*policy\.status\s*===\s*'legacy'\s*:\s*undefined\b/],
    ['gateEvidence', /\bgateEvidence\s*,/],
    ['destructiveRisk', /\bdestructiveRisk:\s*policy\?\.destructiveRisk\b/],
    ['producer', /\bproducer:\s*entry\.owner\b/],
    ['consumerGate', /\bconsumerGate:\s*entry\.gateConsumer\b/],
    ['artifact', /\bartifact:\s*PROCESS_FACT_ARTIFACT_BY_COMMAND\[entry\.name\]/],
    ['reviewerLane', /\breviewerLane:\s*PROCESS_FACT_ARTIFACT_BY_COMMAND\[entry\.name\]\?\.reviewerLane\b/],
    ['rationale', /\brationale:\s*entry\.rationale\b/],
  ]) {
    assertInitializerPattern(
      commandFactsInitializer,
      'COMMAND_PROCESS_FACTS',
      pattern,
      `must wire ${fieldLabel} from level/policy/artifact sources`,
    );
  }

  const reviewerLanesInitializer = extractConstInitializer(sourceText, 'PROCESS_FACT_REVIEWER_LANES', processFactRegistryPath);
  assertInitializerPattern(
    reviewerLanesInitializer,
    'PROCESS_FACT_REVIEWER_LANES',
    /\bPROCESS_FACT_REVIEWER_LANE_DEFINITIONS\.map\s*\(/,
    'must map PROCESS_FACT_REVIEWER_LANE_DEFINITIONS directly',
  );
  assertInitializerPattern(
    reviewerLanesInitializer,
    'PROCESS_FACT_REVIEWER_LANES',
    /\.\.\.entry\b/,
    'must preserve name/producer/consumerGate/reviewerLane/artifact/rationale via ...entry',
  );
  assertInitializerPattern(
    reviewerLanesInitializer,
    'PROCESS_FACT_REVIEWER_LANES',
    /\bkind:\s*'reviewer-lane'\s+as\s+const\b/,
    'must hard-code reviewer-lane kind',
  );
  assertInitializerPattern(
    reviewerLanesInitializer,
    'PROCESS_FACT_REVIEWER_LANES',
    /\bsemantics:\s*\[\s*'reviewer-lane'\s*,\s*'gate-evidence'\s*\]\s+as\s+const\b/,
    'must hard-code reviewer-lane gate-evidence semantics',
  );
  assertInitializerPattern(
    reviewerLanesInitializer,
    'PROCESS_FACT_REVIEWER_LANES',
    /\blevel:\s*'L4'\s+as\s+const\b/,
    'must hard-code L4 reviewer-lane level',
  );

  const flowPoliciesInitializer = extractConstInitializer(sourceText, 'PROCESS_FACT_FLOW_POLICIES', processFactRegistryPath);
  assertInitializerPattern(
    flowPoliciesInitializer,
    'PROCESS_FACT_FLOW_POLICIES',
    /\bFLOW_FACT_POLICIES\.map\s*\(/,
    'must map FLOW_FACT_POLICIES directly',
  );
  assertInitializerPattern(
    flowPoliciesInitializer,
    'PROCESS_FACT_FLOW_POLICIES',
    /\bkind:\s*'flow-policy'\s+as\s+const\b/,
    'must hard-code flow-policy kind',
  );
  assertInitializerPattern(
    flowPoliciesInitializer,
    'PROCESS_FACT_FLOW_POLICIES',
    /\bsemantics:\s*policy\.semantics\s+as\s+readonly\s+ProcessFactSemantic\[\]/,
    'must wire semantics from centralized policy',
  );
  assertInitializerPattern(
    flowPoliciesInitializer,
    'PROCESS_FACT_FLOW_POLICIES',
    /\bartifact:\s*'artifactCommand'\s+in\s+policy\s*&&\s*policy\.artifactCommand\s*\?\s*PROCESS_FACT_ARTIFACT_BY_COMMAND\[policy\.artifactCommand\]/,
    'must resolve artifact metadata from policy artifactCommand',
  );
}

let cachedProcessFactLevelEntries = null;

function parseProcessFactLevelRegistry() {
  if (cachedProcessFactLevelEntries) return cachedProcessFactLevelEntries;

  const text = read(processFactLevelRegistryPath);
  const body = extractExportedArrayBody(text, 'PROCESS_FACT_LEVELS');
  const entryPattern = /\{\s*name:\s*'([^']+)'\s*,\s*level:\s*'(L[0-4])'\s*,\s*category:\s*'([^']+)'\s*,\s*owner:\s*'([^']+)'\s*,\s*rationale:\s*'([^']+)'(?:\s*,\s*gateConsumer:\s*'([^']+)')?\s*,?\s*\}/g;
  const entries = [...body.matchAll(entryPattern)].map(match => ({
    name: match[1],
    level: match[2],
    category: match[3],
    owner: match[4],
    rationale: match[5],
    gateConsumer: match[6],
  }));
  const declaredObjectCount = [...body.matchAll(/\{\s*name:\s*'/g)].length;
  assert(entries.length === declaredObjectCount, `${processFactLevelRegistryPath}: every registry entry must declare name/level/category/owner/rationale in parseable order`);
  assert(entries.length > 0, `${processFactLevelRegistryPath}: registry should not be empty`);

  cachedProcessFactLevelEntries = entries;
  return entries;
}

function parseProcessFactLevelDefinitions() {
  const text = read(processFactLevelRegistryPath);
  const body = extractExportedArrayBody(text, 'PROCESS_FACT_LEVEL_DEFINITIONS');
  return [...body.matchAll(/level:\s*'(L[0-4])'/g)].map(match => match[1]);
}

let cachedCommandPolicyEntries = null;

function readStringProperty(block, propertyName) {
  const match = new RegExp(`\\b${propertyName}\\s*:\\s*(['"\`])`).exec(block);
  if (!match) return '';

  const quote = match[1];
  let escaped = false;
  let value = '';
  for (let index = match.index + match[0].length; index < block.length; index += 1) {
    const char = block[index];
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote) return value;
    value += char;
  }
  return '';
}

function parseStringArrayProperty(block, propertyName) {
  const match = new RegExp(`\\b${propertyName}\\s*:\\s*\\[`).exec(block);
  if (!match) return null;
  const openIndex = match.index + match[0].lastIndexOf('[');
  const body = extractBalancedBlock(block, openIndex, '[', ']', `${propertyName} array`);
  const values = [];
  let index = 0;
  while (index < body.length) {
    const quoteIndex = body.slice(index).search(/['"`]/);
    if (quoteIndex === -1) break;
    const absoluteQuoteIndex = index + quoteIndex;
    const quote = body[absoluteQuoteIndex];
    let escaped = false;
    let value = '';
    for (let cursor = absoluteQuoteIndex + 1; cursor < body.length; cursor += 1) {
      const char = body[cursor];
      if (escaped) {
        value += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        values.push(value);
        index = cursor + 1;
        break;
      }
      value += char;
    }
    if (index <= absoluteQuoteIndex) break;
  }
  return values;
}

function allowedPhasesFromPolicy(policy) {
  if (policy.allowedPhases === 'all') return [...ALL_PHASES];
  if (Array.isArray(policy.allowedPhases)) return [...policy.allowedPhases];
  return [];
}

function parseCommandPolicyEntries() {
  if (cachedCommandPolicyEntries) return cachedCommandPolicyEntries;

  if (builtCommandPolicyModule?.COMMAND_POLICIES) {
    const policies = builtCommandPolicyModule.COMMAND_POLICIES;
    const entries = Object.entries(policies).map(([name, policy]) => ({
      name,
      block: JSON.stringify(policy),
      status: policy.status || '',
      reason: policy.reason || '',
      replacement: policy.replacement || '',
      destructiveRisk: policy.destructiveRisk || '',
      hasAllowedPhases: policy.allowedPhases === 'all' || Array.isArray(policy.allowedPhases),
      allowedPhases: allowedPhasesFromPolicy(policy),
      rootOnly: policy.rootOnly === true || policy.status === 'rootOnly',
      gateEvidence: policy.gateEvidence === true || policy.status === 'gateEvidence',
    }));
    assert(entries.length > 0, `${commandPolicyPath}: compiled command policy should not be empty`);
    cachedCommandPolicyEntries = entries;
    return entries;
  }

  const text = read(commandPolicyPath);
  const body = extractExportedObjectBody(text, 'COMMAND_POLICIES', commandPolicyPath);
  const entries = [];
  const keyPattern = /^\s*([a-z_][a-z0-9_]*):\s*\{/gm;
  for (const match of body.matchAll(keyPattern)) {
    const name = match[1];
    const openIndex = match.index + match[0].lastIndexOf('{');
    const block = extractBalancedBlock(body, openIndex, '{', '}', `${commandPolicyPath} ${name}`);
    const status = readStringProperty(block, 'status');
    const reason = readStringProperty(block, 'reason');
    const replacement = readStringProperty(block, 'replacement');
    const destructiveRisk = readStringProperty(block, 'destructiveRisk');
    const allowedPhases = /\ballowedPhases\s*:\s*(['"`])all\1/.test(block)
      ? [...ALL_PHASES]
      : (parseStringArrayProperty(block, 'allowedPhases') || []);
    entries.push({
      name,
      block,
      status,
      reason,
      replacement,
      destructiveRisk,
      hasAllowedPhases: /\ballowedPhases\s*:/.test(block),
      allowedPhases,
      rootOnly: /\brootOnly:\s*true\b/.test(block) || status === 'rootOnly',
      gateEvidence: /\bgateEvidence:\s*true\b/.test(block) || status === 'gateEvidence',
    });
  }

  const declaredObjectCount = [...body.matchAll(/^\s*[a-z_][a-z0-9_]*:\s*\{/gm)].length;
  assert(entries.length === declaredObjectCount, `${commandPolicyPath}: every policy entry must be parseable as commandName: { ... }`);
  assert(entries.length > 0, `${commandPolicyPath}: command policy should not be empty`);

  cachedCommandPolicyEntries = entries;
  return entries;
}

function duplicateNames(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

let cachedProcessFactRegistryEntries = null;

function parseTopLevelObjectBlocks(arrayBody, label) {
  const blocks = [];
  for (let index = 0; index < arrayBody.length; index += 1) {
    const char = arrayBody[index];
    if (char === '\'' || char === '"' || char === '`') {
      const literal = readQuotedLiteralAt(arrayBody, index);
      index = literal ? literal.endIndex - 1 : index;
      continue;
    }
    if (char !== '{') continue;
    const block = extractBalancedBlock(arrayBody, index, '{', '}', `${label} entry`);
    blocks.push(block);
    index += block.length + 1;
  }
  return blocks;
}

function parseRegistryArrayEntriesFromSource(text, exportName) {
  const body = extractExportedArrayBody(text, exportName);
  return parseTopLevelObjectBlocks(body, `${processFactRegistryPath} ${exportName}`)
    .map(block => ({
      name: readStringProperty(block, 'name'),
      kind: readStringProperty(block, 'kind'),
      semantics: parseStringArrayProperty(block, 'semantics') || [],
      level: readStringProperty(block, 'level'),
      producer: readStringProperty(block, 'producer'),
      consumerGate: readStringProperty(block, 'consumerGate') || undefined,
      reviewerLane: readStringProperty(block, 'reviewerLane') || undefined,
      rationale: readStringProperty(block, 'rationale'),
      block,
    }))
    .filter(entry => entry.name);
}

function parseProcessFactKindByCommandFromSource(text) {
  const body = extractExportedObjectBody(text, 'PROCESS_FACT_KIND_BY_COMMAND', processFactRegistryPath);
  return new Map([...body.matchAll(/^\s*([a-z_][a-z0-9_]*):\s*'([^']+)'/gm)].map(match => [match[1], match[2]]));
}

function parseProcessFactArtifactByCommandFromSource(text) {
  const body = extractExportedObjectBody(text, 'PROCESS_FACT_ARTIFACT_BY_COMMAND', processFactRegistryPath);
  const artifacts = new Map();
  const keyPattern = /^\s*([a-z_][a-z0-9_]*):\s*\{/gm;
  for (const match of body.matchAll(keyPattern)) {
    const commandName = match[1];
    const openIndex = match.index + match[0].lastIndexOf('{');
    const block = extractBalancedBlock(body, openIndex, '{', '}', `${processFactRegistryPath} artifact ${commandName}`);
    artifacts.set(commandName, {
      path: readStringProperty(block, 'path'),
      signed: /\bsigned:\s*true\b/.test(block),
      signature: readStringProperty(block, 'signature'),
      producerCommand: readStringProperty(block, 'producerCommand'),
      consumerGate: readStringProperty(block, 'consumerGate'),
      reviewerLane: readStringProperty(block, 'reviewerLane'),
      block,
    });
  }
  return artifacts;
}

function parseProcessFactRequiredSemanticsFromSource(text) {
  const body = extractExportedObjectBody(text, 'PROCESS_FACT_REQUIRED_SEMANTICS', processFactRegistryPath);
  const semantics = new Map();
  const keyPattern = /^\s*([a-z_][a-z0-9_]*):\s*\[/gm;
  for (const match of body.matchAll(keyPattern)) {
    const name = match[1];
    const openIndex = match.index + match[0].lastIndexOf('[');
    const block = extractBalancedBlock(body, openIndex, '[', ']', `${processFactRegistryPath} semantics ${name}`);
    semantics.set(name, [...block.matchAll(/['"`]([^'"`]+)['"`]/g)].map(([, value]) => value));
  }
  return semantics;
}

function parseProcessFactRuntimeSemanticsFromSource(text) {
  const body = extractExportedObjectBody(text, 'PROCESS_FACT_RUNTIME_SEMANTICS', processFactRegistryPath);
  const semantics = new Map();
  const keyPattern = /^\s*['"`]([^'"`]+)['"`]:\s*\[/gm;
  for (const match of body.matchAll(keyPattern)) {
    const name = match[1];
    const openIndex = match.index + match[0].lastIndexOf('[');
    const block = extractBalancedBlock(body, openIndex, '[', ']', `${processFactRegistryPath} runtime semantics ${name}`);
    semantics.set(name, [...block.matchAll(/['"`]([^'"`]+)['"`]/g)].map(([, value]) => value));
  }
  return semantics;
}

let cachedFlowFactPolicyEntries = null;

function parseFlowFactPolicies() {
  if (cachedFlowFactPolicyEntries) return cachedFlowFactPolicyEntries;

  const text = read(flowFactPolicyPath);
  for (const token of [
    'FLOW_FACT_POLICIES',
    'PASS_ONLY_REVIEW_FINDING_POLICY',
    'EXPRESS_VERIFICATION_EXEMPTION_MESSAGE',
    'isPassOnlyReviewFindingRecord',
    'express-exempt',
    'review-round-iso-string',
  ]) {
    assert(text.includes(token), `${flowFactPolicyPath}: centralized flow fact policy must expose ${token}`);
  }

  const body = extractExportedArrayBody(text, 'FLOW_FACT_POLICIES');
  const entries = parseTopLevelObjectBlocks(body, `${flowFactPolicyPath} FLOW_FACT_POLICIES`)
    .map(block => ({
      name: readStringProperty(block, 'name'),
      policyId: readStringProperty(block, 'policyId'),
      disposition: readStringProperty(block, 'disposition'),
      level: readStringProperty(block, 'level'),
      category: readStringProperty(block, 'category'),
      owner: readStringProperty(block, 'owner'),
      consumerGate: readStringProperty(block, 'consumerGate'),
      artifactCommand: readStringProperty(block, 'artifactCommand'),
      semantics: parseStringArrayProperty(block, 'semantics') || [],
      rationale: readStringProperty(block, 'rationale'),
      block,
    }))
    .filter(entry => entry.name);

  const declaredObjectCount = [...body.matchAll(/\{\s*name:\s*'/g)].length;
  assert(entries.length === declaredObjectCount, `${flowFactPolicyPath}: every flow policy must be parseable`);
  cachedFlowFactPolicyEntries = entries;
  return entries;
}

function processFactKindForCommand(name, level, kindByCommand) {
  if (kindByCommand.has(name)) return kindByCommand.get(name);
  if (name.startsWith('runtime:')) return 'runtime-behavior';
  return level === 'L4' ? 'gate-evidence' : 'command';
}

function processFactSemanticsForCommand(name, level, semanticsByCommand, runtimeSemanticsByCommand = new Map()) {
  const semantics = new Set(name.startsWith('runtime:')
    ? runtimeSemanticsByCommand.get(name) || []
    : semanticsByCommand.get(name) || []);
  if (name.startsWith('runtime:')) {
    semantics.add('runtime-behavior');
    if (name === 'runtime:review_escalation_done_gate') semantics.add('host-verdict');
    if (name === 'runtime:review_assurance_floor_done_gate') semantics.add('host-verdict');
  }
  if (level === 'L4') semantics.add('gate-evidence');
  if (semantics.size === 0) semantics.add('command');
  return [...semantics].sort();
}

function parseProcessFactRegistry() {
  if (cachedProcessFactRegistryEntries) return cachedProcessFactRegistryEntries;

  const sourceText = read(processFactRegistryPath);
  for (const token of [
    'PROCESS_FACT_REGISTRY',
    'PROCESS_FACT_REQUIRED_SEMANTICS',
    'PROCESS_FACT_RUNTIME_SEMANTICS',
    'PROCESS_FACT_FLOW_POLICIES',
    'PROCESS_FACT_SIGNED_ARTIFACTS',
    'PROCESS_FACT_REQUIRED_ARTIFACTS',
    'semantics',
    'kind',
    'lifecycle',
    'allowedPhases',
    'rootOnly',
    'destructiveRisk',
    'producer',
    'consumerGate',
    'artifact',
    'signature',
    'reviewerLane',
  ]) {
    assert(sourceText.includes(token), `${processFactRegistryPath}: typed registry must expose ${token}`);
  }

  const finalRegistryBody = extractExportedArrayBody(sourceText, 'PROCESS_FACT_REGISTRY');
  for (const requiredSpread of ['COMMAND_PROCESS_FACTS', 'PROCESS_FACT_REVIEWER_LANES', 'PROCESS_FACT_ARTIFACTS', 'PROCESS_FACT_FLOW_POLICIES']) {
    assert(
      finalRegistryBody.includes(`...${requiredSpread}`),
      `${processFactRegistryPath}: final PROCESS_FACT_REGISTRY export missing ...${requiredSpread}`,
    );
  }

  assertProcessFactMappedSourceContracts(sourceText);

  if (builtProcessFactRegistryModule?.PROCESS_FACT_REGISTRY) {
    const entries = builtProcessFactRegistryModule.PROCESS_FACT_REGISTRY.map(entry => ({
      name: entry.name,
      kind: entry.kind,
      semantics: Array.isArray(entry.semantics) ? [...entry.semantics] : [],
      level: entry.level,
      lifecycle: entry.lifecycle,
      allowedPhases: entry.allowedPhases === 'all'
        ? [...ALL_PHASES]
        : (Array.isArray(entry.allowedPhases) ? [...entry.allowedPhases] : []),
      rootOnly: entry.rootOnly === true,
      legacy: entry.legacy === true,
      gateEvidence: entry.gateEvidence === true,
      destructiveRisk: entry.destructiveRisk || '',
      producer: entry.producer || '',
      consumerGate: entry.consumerGate || '',
      artifact: entry.artifact || null,
      reviewerLane: entry.reviewerLane || '',
      rationale: entry.rationale || '',
    }));
    assert(entries.length > 0, `${processFactRegistryPath}: compiled PROCESS_FACT_REGISTRY should not be empty`);
    cachedProcessFactRegistryEntries = entries;
    return entries;
  }

  const policyByName = new Map(parseCommandPolicyEntries().map(entry => [entry.name, entry]));
  const kindByCommand = parseProcessFactKindByCommandFromSource(sourceText);
  const semanticsByCommand = parseProcessFactRequiredSemanticsFromSource(sourceText);
  const runtimeSemanticsByCommand = parseProcessFactRuntimeSemanticsFromSource(sourceText);
  const artifactByCommand = parseProcessFactArtifactByCommandFromSource(sourceText);
  const commandEntries = parseProcessFactLevelRegistry().filter(entry => !entry.name.startsWith('flow-policy:')).map(entry => {
    const policy = policyByName.get(entry.name);
    const semantics = processFactSemanticsForCommand(entry.name, entry.level, semanticsByCommand, runtimeSemanticsByCommand);
    const inferredRootOnly = Boolean(policy) && (policy.rootOnly || policy.status === 'rootOnly');
    const inferredGateEvidence = Boolean(policy?.gateEvidence) || policy?.status === 'gateEvidence';
    return {
      name: entry.name,
      kind: processFactKindForCommand(entry.name, entry.level, kindByCommand),
      semantics,
      level: entry.level,
      lifecycle: policy?.status || '',
      allowedPhases: policy?.allowedPhases || [],
      rootOnly: inferredRootOnly,
      legacy: policy?.status === 'legacy',
      gateEvidence: inferredGateEvidence,
      destructiveRisk: policy?.destructiveRisk || '',
      producer: entry.owner,
      consumerGate: entry.gateConsumer || '',
      artifact: artifactByCommand.get(entry.name) || null,
      reviewerLane: artifactByCommand.get(entry.name)?.reviewerLane || '',
      rationale: entry.rationale,
    };
  });

  const laneEntries = parseRegistryArrayEntriesFromSource(sourceText, 'PROCESS_FACT_REVIEWER_LANE_DEFINITIONS').map(entry => {
    const artifactRefMatch = /artifact:\s*PROCESS_FACT_ARTIFACT_BY_COMMAND\.([a-z_][a-z0-9_]*)/.exec(entry.block);
    const artifact = artifactRefMatch ? artifactByCommand.get(artifactRefMatch[1]) : null;
    return {
      ...entry,
      kind: 'reviewer-lane',
      semantics: ['gate-evidence', 'reviewer-lane'],
      level: 'L4',
      artifact: artifact || null,
    };
  });
  const artifactEntries = parseRegistryArrayEntriesFromSource(sourceText, 'PROCESS_FACT_ARTIFACTS').map(entry => {
    const artifactRefMatch = /artifact:\s*PROCESS_FACT_ARTIFACT_BY_COMMAND\.([a-z_][a-z0-9_]*)/.exec(entry.block);
    const artifact = artifactRefMatch ? artifactByCommand.get(artifactRefMatch[1]) : null;
    return { ...entry, artifact: artifact || null };
  });
  const flowPolicyEntries = parseFlowFactPolicies().map(entry => ({
    name: entry.name,
    kind: 'flow-policy',
    semantics: [...entry.semantics],
    level: entry.level,
    producer: entry.owner,
    consumerGate: entry.consumerGate,
    artifact: entry.artifactCommand ? artifactByCommand.get(entry.artifactCommand) || null : null,
    reviewerLane: '',
    rationale: entry.rationale,
  }));

  cachedProcessFactRegistryEntries = [...commandEntries, ...laneEntries, ...artifactEntries, ...flowPolicyEntries];
  return cachedProcessFactRegistryEntries;
}

function processFactRegistryMap() {
  return new Map(parseProcessFactRegistry().map(entry => [entry.name, entry]));
}

function extractCliToolNames(cliText) {
  return [...cliText.matchAll(/name:\s*['"]([a-z_][a-z0-9_]*)['"]/g)]
    .map(match => match[1])
    .sort();
}

function isProcessFactCommandName(commandName) {
  if (commandName.endsWith('_dispatch')) return false;
  return processFactCommandNamePatterns.some(pattern => pattern.test(commandName));
}

function findUninventoriedProcessFactCommands(cliText, inventory = processFactRegistryMap()) {
  return extractCliToolNames(cliText)
    .filter(isProcessFactCommandName)
    .filter(commandName => !inventory.has(commandName));
}

function assertCommandPolicyInventory(cliToolNames) {
  const text = read(commandPolicyPath);
  for (const helperName of ['getCommandLifecyclePolicy', 'formatCommandLifecycleHint', 'getCommandPolicyEntries']) {
    assert(text.includes(helperName), `${commandPolicyPath}: missing helper ${helperName}`);
  }

  const policyEntries = parseCommandPolicyEntries();
  const policyNames = policyEntries.map(entry => entry.name);
  const policyByName = new Map(policyEntries.map(entry => [entry.name, entry]));
  const cliToolNameSet = new Set(cliToolNames);

  const duplicatePolicyNames = duplicateNames(policyNames);
  assert(
    duplicatePolicyNames.length === 0,
    `${commandPolicyPath}: duplicate policy entries: ${duplicatePolicyNames.join(', ')}`,
  );

  const missingPolicyEntries = cliToolNames.filter(commandName => !policyByName.has(commandName));
  assert(
    missingPolicyEntries.length === 0,
    `${commandPolicyPath}: MAIN_TOOLS command(s) missing lifecycle policy: ${missingPolicyEntries.join(', ')}`,
  );

  const unknownPolicyEntries = policyNames.filter(name => !cliToolNameSet.has(name));
  assert(
    unknownPolicyEntries.length === 0,
    `${commandPolicyPath}: lifecycle policy entry not present in MAIN_TOOLS: ${unknownPolicyEntries.join(', ')}`,
  );

  for (const entry of policyEntries) {
    assert(commandPolicyStatuses.has(entry.status), `${commandPolicyPath}: ${entry.name} has unknown status "${entry.status}"`);
    assert(entry.reason.trim().length > 0, `${commandPolicyPath}: ${entry.name} must explain lifecycle reason`);
    assert(entry.hasAllowedPhases || entry.rootOnly, `${commandPolicyPath}: ${entry.name} must declare allowedPhases or rootOnly`);
    assert(entry.destructiveRisk !== '', `${commandPolicyPath}: ${entry.name} must declare destructiveRisk, even when none`);
  }

  for (const commandName of legacyTestFixtureCommands) {
    const entry = policyByName.get(commandName);
    assert(entry, `${commandPolicyPath}: legacy test/fixture command missing policy: ${commandName}`);
    if (!entry) continue;

    const guidance = legacyCommandPolicyGuidance[commandName];
    assert(entry.status === 'legacy', `${commandPolicyPath}: ${commandName} must be classified as legacy`);
    assert(entry.rootOnly, `${commandPolicyPath}: ${commandName} must stay rootOnly/phase-gated`);
    assert(entry.replacement.trim().length > 0, `${commandPolicyPath}: ${commandName} must include replacement guidance`);
    assert(
      entry.destructiveRisk === guidance.destructiveRisk,
      `${commandPolicyPath}: ${commandName} destructiveRisk drifted: expected ${guidance.destructiveRisk}, got ${entry.destructiveRisk || '<missing>'}`,
    );
    for (const pattern of guidance.patterns) {
      assert(
        pattern.test(entry.block),
        `${commandPolicyPath}: ${commandName} replacement/destructive guidance missing ${pattern}`,
      );
    }
  }
}

function policyBlockHasOwnershipClass(policy, ownershipClass) {
  return new RegExp(`ownershipClass\\s*:\\s*(['"\`])${ownershipClass}\\1`).test(policy.block)
    || policy.block.includes(`"ownershipClass":"${ownershipClass}"`);
}

function assertReviewLoopCommandContract(cliToolNameSet, registry, levelRegistry, policyByName) {
  const artifact = registry.get('artifact:review-loops.jsonl');
  assert(artifact, `${processFactRegistryPath}: review-loop artifact missing: artifact:review-loops.jsonl`);
  if (artifact) {
    assert(artifact.artifact?.path === 'review-loops.jsonl', `${processFactRegistryPath}: review-loop artifact path drift`);
    assert(artifact.level === 'L4', `${processFactRegistryPath}: review-loop artifact must stay L4`);
    assert(artifact.semantics.includes('blocker-state'), `${processFactRegistryPath}: review-loop artifact missing blocker-state semantic`);
    assert(artifact.semantics.includes('gate-evidence'), `${processFactRegistryPath}: review-loop artifact missing gate-evidence semantic`);
    assert(/storyMachine\.canPassReview/.test(artifact.consumerGate), `${processFactRegistryPath}: review-loop artifact consumerGate drifted (${artifact.consumerGate})`);
  }

  for (const commandName of requiredReviewLoopL4Commands) {
    assert(cliToolNameSet.has(commandName), `CLI schema: required review-loop command missing from MAIN_TOOLS: ${commandName}`);

    const policy = policyByName.get(commandName);
    assert(policy, `${commandPolicyPath}: required review-loop command missing lifecycle policy: ${commandName}`);
    if (policy) {
      assert(policy.gateEvidence, `${commandPolicyPath}: ${commandName} must stay gateEvidence`);
      assert(
        policy.allowedPhases.length === 1 && policy.allowedPhases[0] === 'REVIEW',
        `${commandPolicyPath}: ${commandName} must be REVIEW-only`,
      );
      assert(policy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: ${commandName} destructiveRisk must stay metadata-write`);
      assert(
        policyBlockHasOwnershipClass(policy, 'storyScopedMutating'),
        `${commandPolicyPath}: ${commandName} must stay storyScopedMutating`,
      );
    }

    const levelEntry = levelRegistry.get(commandName);
    assert(levelEntry, `${processFactLevelRegistryPath}: required review-loop command missing level entry: ${commandName}`);
    if (levelEntry) {
      assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${commandName} must stay L4`);
      assert(levelEntry.category === 'review-loop', `${processFactLevelRegistryPath}: ${commandName} category must stay review-loop`);
      assert(levelEntry.owner === 'handlers/review-loop', `${processFactLevelRegistryPath}: ${commandName} owner drifted`);
      assert(/storyMachine\.canPassReview/.test(levelEntry.gateConsumer || ''), `${processFactLevelRegistryPath}: ${commandName} gateConsumer drifted`);
    }

    const registryEntry = registry.get(commandName);
    assert(registryEntry, `${processFactRegistryPath}: required review-loop command missing registry entry: ${commandName}`);
    if (registryEntry) {
      assert(registryEntry.level === 'L4', `${processFactRegistryPath}: ${commandName} registry level must stay L4`);
      assert(registryEntry.gateEvidence === true, `${processFactRegistryPath}: ${commandName} registry gateEvidence must stay true`);
      assert(registryEntry.artifact?.path === 'review-loops.jsonl', `${processFactRegistryPath}: ${commandName} must write review-loops.jsonl`);
      for (const semantic of ['blocker-state', 'schema-contract', 'gate-evidence']) {
        assert(registryEntry.semantics.includes(semantic), `${processFactRegistryPath}: ${commandName} missing ${semantic} semantic`);
      }
      assert(/storyMachine\.canPassReview/.test(registryEntry.consumerGate), `${processFactRegistryPath}: ${commandName} consumerGate drifted (${registryEntry.consumerGate})`);
    }
  }

  for (const commandName of requiredReviewLoopReadOnlyCommands) {
    assert(cliToolNameSet.has(commandName), `CLI schema: required review-loop read command missing from MAIN_TOOLS: ${commandName}`);
    const policy = policyByName.get(commandName);
    assert(policy, `${commandPolicyPath}: required review-loop read command missing lifecycle policy: ${commandName}`);
    if (policy) {
      assert(!policy.gateEvidence, `${commandPolicyPath}: ${commandName} must not be gateEvidence`);
      assert(policy.allowedPhases.length === ALL_PHASES.length, `${commandPolicyPath}: ${commandName} must be allowed in all phases`);
      assert(policy.destructiveRisk === 'none', `${commandPolicyPath}: ${commandName} destructiveRisk must stay none`);
      assert(policyBlockHasOwnershipClass(policy, 'readOnly'), `${commandPolicyPath}: ${commandName} must stay readOnly`);
    }
    const levelEntry = levelRegistry.get(commandName);
    assert(levelEntry, `${processFactLevelRegistryPath}: required review-loop read command missing level entry: ${commandName}`);
    if (levelEntry) {
      assert(levelEntry.level === 'L0', `${processFactLevelRegistryPath}: ${commandName} must stay L0`);
      assert(levelEntry.category === 'review-loop-read', `${processFactLevelRegistryPath}: ${commandName} category must stay review-loop-read`);
    }
  }
}

function assertDoneClosureCommandContract(cliToolNameSet, registry, levelRegistry, policyByName) {
  for (const commandName of requiredDoneClosureReadOnlyCommands) {
    assert(cliToolNameSet.has(commandName), `CLI schema: required DONE closure read command missing from MAIN_TOOLS: ${commandName}`);
    const policy = policyByName.get(commandName);
    assert(policy, `${commandPolicyPath}: required DONE closure command missing lifecycle policy: ${commandName}`);
    if (policy) {
      assert(!policy.gateEvidence, `${commandPolicyPath}: ${commandName} must not be gateEvidence`);
      assert(policy.allowedPhases.length === ALL_PHASES.length, `${commandPolicyPath}: ${commandName} must be allowed in all phases`);
      assert(policy.destructiveRisk === 'none', `${commandPolicyPath}: ${commandName} destructiveRisk must stay none`);
      assert(policyBlockHasOwnershipClass(policy, 'readOnly'), `${commandPolicyPath}: ${commandName} must stay readOnly`);
      assert(
        /without writing lifecycle artifacts|without mutating/i.test(policy.reason),
        `${commandPolicyPath}: ${commandName} policy must state the read-only/no lifecycle mutation boundary`,
      );
      assertLocalAssuranceNoReleaseBoundary(policy.reason, `${commandPolicyPath}: ${commandName} policy`);
    }

    const levelEntry = levelRegistry.get(commandName);
    assert(levelEntry, `${processFactLevelRegistryPath}: required DONE closure command missing level entry: ${commandName}`);
    if (levelEntry) {
      assert(levelEntry.level === 'L0', `${processFactLevelRegistryPath}: ${commandName} must stay L0`);
      assert(levelEntry.category === 'done-closure-read', `${processFactLevelRegistryPath}: ${commandName} category must stay done-closure-read`);
      assert(levelEntry.owner === 'handlers/done-closure', `${processFactLevelRegistryPath}: ${commandName} owner drifted`);
      assert(!levelEntry.gateConsumer, `${processFactLevelRegistryPath}: ${commandName} must not declare a gateConsumer`);
    }

    const registryEntry = registry.get(commandName);
    assert(registryEntry, `${processFactRegistryPath}: required DONE closure command missing registry entry: ${commandName}`);
    if (registryEntry) {
      assert(registryEntry.level === 'L0', `${processFactRegistryPath}: ${commandName} registry level must stay L0`);
      assert(registryEntry.kind === 'command', `${processFactRegistryPath}: ${commandName} registry kind must stay command`);
      assert(registryEntry.gateEvidence === false, `${processFactRegistryPath}: ${commandName} registry gateEvidence must stay false`);
      assert(!registryEntry.artifact, `${processFactRegistryPath}: ${commandName} must not produce a process artifact`);
      assert(!registryEntry.consumerGate, `${processFactRegistryPath}: ${commandName} must not be consumed by a lifecycle gate`);
      assert(registryEntry.semantics.includes('command'), `${processFactRegistryPath}: ${commandName} must remain a command projection semantic`);
      assert(!registryEntry.semantics.includes('gate-evidence'), `${processFactRegistryPath}: ${commandName} must not gain gate-evidence semantic`);
    }
  }
}

function assertDoneRequiredValidationCommandContract(cliToolNameSet, registry, levelRegistry, policyByName) {
  const commandName = 'done_required_validate';
  assert(cliToolNameSet.has(commandName), `CLI schema: required DONE-required validation command missing from MAIN_TOOLS: ${commandName}`);

  const policy = policyByName.get(commandName);
  assert(policy, `${commandPolicyPath}: required DONE-required validation command missing lifecycle policy`);
  if (policy) {
    assert(policy.gateEvidence, `${commandPolicyPath}: ${commandName} must remain gateEvidence`);
    assert(policy.allowedPhases.length === ALL_PHASES.length, `${commandPolicyPath}: ${commandName} must be allowed in all phases`);
    assert(policy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: ${commandName} destructiveRisk must stay metadata-write`);
    assert(policyBlockHasOwnershipClass(policy, 'storyScopedMutating'), `${commandPolicyPath}: ${commandName} must stay storyScopedMutating`);
    assert(/done-required-evidence\.json/.test(policy.reason), `${commandPolicyPath}: ${commandName} policy must name done-required-evidence.json`);
    assert(/Missing policy is advisory\/non-blocking|advisory\/non-blocking/i.test(policy.reason), `${commandPolicyPath}: ${commandName} policy must keep missing config advisory/non-blocking`);
    assert(/malformed opted-in policy.*fail/i.test(policy.reason), `${commandPolicyPath}: ${commandName} policy must keep malformed opted-in config fail-closed`);
    assertLocalAssuranceNoReleaseBoundary(policy.reason, `${commandPolicyPath}: ${commandName} policy`);
  }

  const levelEntry = levelRegistry.get(commandName);
  assert(levelEntry, `${processFactLevelRegistryPath}: required DONE-required validation command missing level entry`);
  if (levelEntry) {
    assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${commandName} must stay L4`);
    assert(levelEntry.category === 'validation', `${processFactLevelRegistryPath}: ${commandName} category must stay validation`);
    assert(levelEntry.owner === 'handlers/done-required-validation', `${processFactLevelRegistryPath}: ${commandName} owner drifted`);
    assert(/DONE.*done-required-validation/.test(levelEntry.gateConsumer || ''), `${processFactLevelRegistryPath}: ${commandName} gate consumer must name DONE done-required-validation`);
  }

  const registryEntry = registry.get(commandName);
  assert(registryEntry, `${processFactRegistryPath}: required DONE-required validation command missing registry entry`);
  if (registryEntry) {
    for (const semantic of ['schema-contract', 'execution-evidence', 'validation-result', 'gate-evidence']) {
      assert(registryEntry.semantics.includes(semantic), `${processFactRegistryPath}: ${commandName} missing semantic ${semantic}`);
    }
    assert(registryEntry.artifact?.path === 'done-required-evidence.json', `${processFactRegistryPath}: ${commandName} must produce done-required-evidence.json`);
    assert(registryEntry.artifact?.signed === false, `${processFactRegistryPath}: ${commandName} artifact must remain unsigned local evidence`);
  }

  const artifactEntry = registry.get('artifact:done-required-evidence.json');
  assert(artifactEntry, `${processFactRegistryPath}: artifact:done-required-evidence.json registry entry missing`);
  if (artifactEntry) {
    assert(artifactEntry.level === 'L4', `${processFactRegistryPath}: done-required artifact must stay L4`);
    for (const semantic of ['artifact', 'validation-result', 'execution-evidence', 'schema-contract', 'gate-evidence']) {
      assert(artifactEntry.semantics.includes(semantic), `${processFactRegistryPath}: done-required artifact missing semantic ${semantic}`);
    }
  }

  const doneRequiredArtifact = 'done-required-evidence.json';
  const lifecycleRegistryText = read(lifecycleRegistryPath);
  const lifecycleArtifactsInitializer = extractConstInitializer(lifecycleRegistryText, 'LIFECYCLE_ARTIFACTS', lifecycleRegistryPath);
  assert(
    new RegExp(`['"]${doneRequiredArtifact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(lifecycleArtifactsInitializer),
    `${lifecycleRegistryPath}: LIFECYCLE_ARTIFACTS must include '${doneRequiredArtifact}'`,
  );

  const phaseArtifactsInitializer = extractConstInitializer(lifecycleRegistryText, 'LIFECYCLE_PHASE_ARTIFACTS', lifecycleRegistryPath);
  const testPhaseArtifacts = extractObjectPropertyBlock(phaseArtifactsInitializer, 'TEST', `${lifecycleRegistryPath} LIFECYCLE_PHASE_ARTIFACTS`);
  assertArrayPropertyIncludesValue(testPhaseArtifacts, 'produces', doneRequiredArtifact, `${lifecycleRegistryPath}: TEST phase`);
  const donePhaseArtifacts = extractObjectPropertyBlock(phaseArtifactsInitializer, 'DONE', `${lifecycleRegistryPath} LIFECYCLE_PHASE_ARTIFACTS`);
  assertArrayPropertyIncludesValue(donePhaseArtifacts, 'consumes', doneRequiredArtifact, `${lifecycleRegistryPath}: DONE phase`);

  const oracleArtifactRefsInitializer = extractConstInitializer(lifecycleRegistryText, 'LIFECYCLE_ORACLE_ARTIFACT_REFS', lifecycleRegistryPath);
  assert(
    /['"]done-required-validation['"]\s*:\s*['"]done-required-evidence\.json['"]/.test(oracleArtifactRefsInitializer),
    `${lifecycleRegistryPath}: LIFECYCLE_ORACLE_ARTIFACT_REFS must map 'done-required-validation' to '${doneRequiredArtifact}'`,
  );

  const coreText = read('packages/main/src/core/done-required-validation.ts');
  for (const token of ['doneRequiredCommands', 'validationProfiles', 'policyHash', 'commandSetHash', 'missing-build-proof', 'requiresBuildProof', 'providesBuildProof', 'materialHash', 'storyFilesHash', 'validateRequiredReceiptCoverage', 'receipt-count-mismatch', 'receipt-command-mismatch', 'receipt-status-fail']) {
    assert(coreText.includes(token), `packages/main/src/core/done-required-validation.ts: required token missing: ${token}`);
  }
  const oracleText = read('packages/main/src/core/done-oracle.ts');
  assert(oracleText.includes("id: 'done-required-validation'"), 'packages/main/src/core/done-oracle.ts: DONE checklist must contain separate done-required-validation row');
  assert(oracleText.includes('evaluateDoneRequiredEvidence'), 'packages/main/src/core/done-oracle.ts: DONE checklist must consume done-required evaluator');
}

function assertDecisionDocQuorumCommandContract(cliToolNameSet, registry, levelRegistry, policyByName) {
  for (const commandName of requiredDecisionDocQuorumReadOnlyCommands) {
    assert(cliToolNameSet.has(commandName), `CLI schema: required decision-doc quorum read command missing from MAIN_TOOLS: ${commandName}`);
    const policy = policyByName.get(commandName);
    assert(policy, `${commandPolicyPath}: required decision-doc quorum command missing lifecycle policy: ${commandName}`);
    if (policy) {
      assert(!policy.gateEvidence, `${commandPolicyPath}: ${commandName} must not be gateEvidence`);
      assert(policy.allowedPhases.length === ALL_PHASES.length, `${commandPolicyPath}: ${commandName} must be allowed in all phases`);
      assert(policy.destructiveRisk === 'none', `${commandPolicyPath}: ${commandName} destructiveRisk must stay none`);
      assert(policyBlockHasOwnershipClass(policy, 'readOnly'), `${commandPolicyPath}: ${commandName} must stay readOnly`);
      assert(/without mutating|read-only/i.test(policy.reason), `${commandPolicyPath}: ${commandName} policy must state the read-only boundary`);
      assert(/classification-only|do not by themselves require DONE quorum|review_escalation_status/i.test(policy.reason), `${commandPolicyPath}: ${commandName} policy must state decision-doc edits are diagnostic/classification only`);
      assertLocalAssuranceNoReleaseBoundary(policy.reason, `${commandPolicyPath}: ${commandName} policy`);
    }

    const levelEntry = levelRegistry.get(commandName);
    assert(levelEntry, `${processFactLevelRegistryPath}: required decision-doc quorum command missing level entry: ${commandName}`);
    if (levelEntry) {
      assert(levelEntry.level === 'L0', `${processFactLevelRegistryPath}: ${commandName} must stay L0`);
      assert(levelEntry.category === 'decision-doc-quorum-read', `${processFactLevelRegistryPath}: ${commandName} category must stay decision-doc-quorum-read`);
      assert(levelEntry.owner === 'handlers/decision-doc-quorum', `${processFactLevelRegistryPath}: ${commandName} owner drifted`);
      assert(!levelEntry.gateConsumer, `${processFactLevelRegistryPath}: ${commandName} must not declare a gateConsumer`);
    }

    const registryEntry = registry.get(commandName);
    assert(registryEntry, `${processFactRegistryPath}: required decision-doc quorum command missing registry entry: ${commandName}`);
    if (registryEntry) {
      assert(registryEntry.level === 'L0', `${processFactRegistryPath}: ${commandName} registry level must stay L0`);
      assert(registryEntry.kind === 'command', `${processFactRegistryPath}: ${commandName} registry kind must stay command`);
      assert(registryEntry.gateEvidence === false, `${processFactRegistryPath}: ${commandName} registry gateEvidence must stay false`);
      assert(!registryEntry.artifact, `${processFactRegistryPath}: ${commandName} must not produce a process artifact`);
      assert(!registryEntry.consumerGate, `${processFactRegistryPath}: ${commandName} must not be consumed by a lifecycle gate`);
      assert(registryEntry.semantics.includes('command'), `${processFactRegistryPath}: ${commandName} must remain a command projection semantic`);
      assert(!registryEntry.semantics.includes('gate-evidence'), `${processFactRegistryPath}: ${commandName} must not gain gate-evidence semantic`);
    }
  }

  const statusCommand = 'review_escalation_status';
  assert(cliToolNameSet.has(statusCommand), `CLI schema: required review escalation read command missing from MAIN_TOOLS: ${statusCommand}`);
  const statusPolicy = policyByName.get(statusCommand);
  assert(statusPolicy, `${commandPolicyPath}: required review escalation status command missing lifecycle policy`);
  if (statusPolicy) {
    assert(!statusPolicy.gateEvidence, `${commandPolicyPath}: ${statusCommand} must not be gateEvidence`);
    assert(statusPolicy.allowedPhases.length === ALL_PHASES.length, `${commandPolicyPath}: ${statusCommand} must be allowed in all phases`);
    assert(statusPolicy.destructiveRisk === 'none', `${commandPolicyPath}: ${statusCommand} destructiveRisk must stay none`);
    assert(policyBlockHasOwnershipClass(statusPolicy, 'readOnly'), `${commandPolicyPath}: ${statusCommand} must stay readOnly`);
    assert(/first-round verified reviewer findings|explicitlyConfiguredHighRiskPolicyRequires3x2|3x2|degraded 3x1/i.test(statusPolicy.reason), `${commandPolicyPath}: ${statusCommand} must describe the trigger/quorum policy`);
    assertLocalAssuranceNoReleaseBoundary(statusPolicy.reason, `${commandPolicyPath}: ${statusCommand} policy`);
  }
  const statusLevel = levelRegistry.get(statusCommand);
  assert(statusLevel, `${processFactLevelRegistryPath}: ${statusCommand} missing level entry`);
  if (statusLevel) {
    assert(statusLevel.level === 'L0', `${processFactLevelRegistryPath}: ${statusCommand} must stay L0`);
    assert(statusLevel.category === 'review-escalation-read', `${processFactLevelRegistryPath}: ${statusCommand} category drifted`);
    assert(statusLevel.owner === 'handlers/review-escalation', `${processFactLevelRegistryPath}: ${statusCommand} owner drifted`);
    assert(!statusLevel.gateConsumer, `${processFactLevelRegistryPath}: ${statusCommand} must not declare a gateConsumer`);
  }
  const statusRegistry = registry.get(statusCommand);
  assert(statusRegistry, `${processFactRegistryPath}: ${statusCommand} missing registry entry`);
  if (statusRegistry) {
    assert(statusRegistry.level === 'L0', `${processFactRegistryPath}: ${statusCommand} registry level must stay L0`);
    assert(statusRegistry.kind === 'command', `${processFactRegistryPath}: ${statusCommand} registry kind must stay command`);
    assert(statusRegistry.gateEvidence === false, `${processFactRegistryPath}: ${statusCommand} registry gateEvidence must stay false`);
    assert(!statusRegistry.artifact, `${processFactRegistryPath}: ${statusCommand} must not produce a process artifact`);
  }

  const policyCommand = 'review_escalation_policy_set';
  assert(cliToolNameSet.has(policyCommand), `CLI schema: required review escalation policy command missing from MAIN_TOOLS: ${policyCommand}`);
  const policyCommandPolicy = policyByName.get(policyCommand);
  assert(policyCommandPolicy, `${commandPolicyPath}: required review escalation policy command missing lifecycle policy`);
  if (policyCommandPolicy) {
    assert(policyCommandPolicy.gateEvidence, `${commandPolicyPath}: ${policyCommand} must be gateEvidence`);
    assert(policyCommandPolicy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: ${policyCommand} destructiveRisk must stay metadata-write`);
    assert(policyBlockHasOwnershipClass(policyCommandPolicy, 'storyScopedMutating'), `${commandPolicyPath}: ${policyCommand} must stay storyScopedMutating`);
    for (const token of ['explicitlyConfiguredHighRiskPolicyRequires3x2', 'policyVersion', 'sourcePolicyRef', 'rolloutStage', 'head/material', 'degraded fallback']) {
      assert(new RegExp(token, 'i').test(policyCommandPolicy.reason), `${commandPolicyPath}: ${policyCommand} policy must name ${token}`);
    }
    assertLocalAssuranceNoReleaseBoundary(policyCommandPolicy.reason, `${commandPolicyPath}: ${policyCommand} policy`);
  }
  const policyLevel = levelRegistry.get(policyCommand);
  assert(policyLevel, `${processFactLevelRegistryPath}: ${policyCommand} missing level entry`);
  if (policyLevel) {
    assert(policyLevel.level === 'L4', `${processFactLevelRegistryPath}: ${policyCommand} must stay L4`);
    assert(policyLevel.category === 'review-escalation-policy', `${processFactLevelRegistryPath}: ${policyCommand} category drifted`);
    assert(policyLevel.owner === 'handlers/review-escalation', `${processFactLevelRegistryPath}: ${policyCommand} owner drifted`);
    assert(/review escalation/i.test(policyLevel.gateConsumer || ''), `${processFactLevelRegistryPath}: ${policyCommand} gateConsumer drifted`);
    assert(/explicitlyConfiguredHighRiskPolicyRequires3x2/i.test(policyLevel.rationale), `${processFactLevelRegistryPath}: ${policyCommand} rationale must bind explicitlyConfiguredHighRiskPolicyRequires3x2`);
  }
  const policyRegistry = registry.get(policyCommand);
  assert(policyRegistry, `${processFactRegistryPath}: ${policyCommand} missing registry entry`);
  if (policyRegistry) {
    assert(policyRegistry.level === 'L4', `${processFactRegistryPath}: ${policyCommand} registry level must stay L4`);
    assert(policyRegistry.gateEvidence === true, `${processFactRegistryPath}: ${policyCommand} registry gateEvidence must stay true`);
    assert(policyRegistry.artifact?.path === 'process-events.jsonl', `${processFactRegistryPath}: ${policyCommand} must record process-events.jsonl evidence`);
    assert(/review escalation/i.test(policyRegistry.consumerGate), `${processFactRegistryPath}: ${policyCommand} consumerGate drifted`);
  }

  const fallbackCommand = 'review_escalation_fallback_set';
  assert(cliToolNameSet.has(fallbackCommand), `CLI schema: required review escalation fallback command missing from MAIN_TOOLS: ${fallbackCommand}`);
  const fallbackPolicy = policyByName.get(fallbackCommand);
  assert(fallbackPolicy, `${commandPolicyPath}: required review escalation fallback command missing lifecycle policy`);
  if (fallbackPolicy) {
    assert(fallbackPolicy.gateEvidence, `${commandPolicyPath}: ${fallbackCommand} must be gateEvidence`);
    assert(fallbackPolicy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: ${fallbackCommand} destructiveRisk must stay metadata-write`);
    assert(policyBlockHasOwnershipClass(fallbackPolicy, 'storyScopedMutating'), `${commandPolicyPath}: ${fallbackCommand} must stay storyScopedMutating`);
    assert(/degraded 3x1|degraded-single-host|current material hash/i.test(fallbackPolicy.reason), `${commandPolicyPath}: ${fallbackCommand} must describe degraded-single-host material binding`);
    assert(/storyFilesHash/i.test(fallbackPolicy.reason), `${commandPolicyPath}: ${fallbackCommand} must describe storyFilesHash binding`);
    assert(/review escalation DONE gate/i.test(fallbackPolicy.reason), `${commandPolicyPath}: ${fallbackCommand} policy must name the local review escalation DONE gate`);
    assert(/review assurance floor DONE gate/i.test(fallbackPolicy.reason), `${commandPolicyPath}: ${fallbackCommand} policy must name the review assurance floor DONE gate`);
    assertLocalAssuranceNoReleaseBoundary(fallbackPolicy.reason, `${commandPolicyPath}: ${fallbackCommand} policy`);
  }
  const fallbackLevel = levelRegistry.get(fallbackCommand);
  assert(fallbackLevel, `${processFactLevelRegistryPath}: ${fallbackCommand} missing level entry`);
  if (fallbackLevel) {
    assert(fallbackLevel.level === 'L4', `${processFactLevelRegistryPath}: ${fallbackCommand} must stay L4`);
    assert(fallbackLevel.category === 'review-escalation-fallback', `${processFactLevelRegistryPath}: ${fallbackCommand} category drifted`);
    assert(fallbackLevel.owner === 'handlers/review-escalation', `${processFactLevelRegistryPath}: ${fallbackCommand} owner drifted`);
    assert(/storyFilesHash/i.test(fallbackLevel.rationale), `${processFactLevelRegistryPath}: ${fallbackCommand} rationale must name storyFilesHash`);
    assert(/review escalation/i.test(fallbackLevel.gateConsumer || ''), `${processFactLevelRegistryPath}: ${fallbackCommand} gateConsumer drifted`);
    assert(/review assurance floor/i.test(fallbackLevel.gateConsumer || ''), `${processFactLevelRegistryPath}: ${fallbackCommand} gateConsumer must name review assurance floor`);
  }
  const fallbackRegistry = registry.get(fallbackCommand);
  assert(fallbackRegistry, `${processFactRegistryPath}: ${fallbackCommand} missing registry entry`);
  if (fallbackRegistry) {
    assert(fallbackRegistry.level === 'L4', `${processFactRegistryPath}: ${fallbackCommand} registry level must stay L4`);
    assert(fallbackRegistry.gateEvidence === true, `${processFactRegistryPath}: ${fallbackCommand} registry gateEvidence must stay true`);
    assert(fallbackRegistry.artifact?.path === 'process-events.jsonl', `${processFactRegistryPath}: ${fallbackCommand} must record process-events.jsonl evidence`);
    assert(/review escalation/i.test(fallbackRegistry.consumerGate), `${processFactRegistryPath}: ${fallbackCommand} consumerGate drifted`);
    assert(/review assurance floor/i.test(fallbackRegistry.consumerGate), `${processFactRegistryPath}: ${fallbackCommand} consumerGate must name review assurance floor`);
  }

  const commandName = 'autopilot_review_submit';
  const policy = policyByName.get(commandName);
  assert(policy, `${commandPolicyPath}: required local host verdict command missing lifecycle policy: ${commandName}`);
  if (policy) {
    assert(policy.gateEvidence, `${commandPolicyPath}: ${commandName} must stay gateEvidence for local review escalation and review assurance floor`);
    assert(policy.allowedPhases.length === ALL_PHASES.length, `${commandPolicyPath}: ${commandName} must be allowed in all phases`);
    assert(policy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: ${commandName} destructiveRisk must stay metadata-write`);
    assert(policyBlockHasOwnershipClass(policy, 'reviewerWrite'), `${commandPolicyPath}: ${commandName} must stay reviewerWrite so independent hosts can submit verdicts without story owner lease`);
    assert(/storyFilesHash/i.test(policy.reason), `${commandPolicyPath}: ${commandName} policy must name storyFilesHash binding`);
    assert(/review escalation DONE gate/i.test(policy.reason), `${commandPolicyPath}: ${commandName} policy must name the local review escalation DONE gate`);
    assert(/review assurance floor DONE gate/i.test(policy.reason), `${commandPolicyPath}: ${commandName} policy must name the review assurance floor DONE gate`);
    assertLocalAssuranceNoReleaseBoundary(policy.reason, `${commandPolicyPath}: ${commandName} policy`);
  }

  const levelEntry = levelRegistry.get(commandName);
  assert(levelEntry, `${processFactLevelRegistryPath}: required local host verdict command missing level entry: ${commandName}`);
  if (levelEntry) {
    assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${commandName} must stay L4`);
    assert(levelEntry.category === 'lattice-local-host-verdict', `${processFactLevelRegistryPath}: ${commandName} category must stay lattice-local-host-verdict`);
    assert(levelEntry.owner === 'handlers/verdict', `${processFactLevelRegistryPath}: ${commandName} owner drifted`);
    assert(/storyFilesHash/i.test(levelEntry.rationale), `${processFactLevelRegistryPath}: ${commandName} rationale must name storyFilesHash`);
    assert(/review escalation/i.test(levelEntry.gateConsumer || ''), `${processFactLevelRegistryPath}: ${commandName} gateConsumer drifted`);
    assert(/review assurance floor/i.test(levelEntry.gateConsumer || ''), `${processFactLevelRegistryPath}: ${commandName} gateConsumer must name review assurance floor`);
  }

  const registryEntry = registry.get(commandName);
  assert(registryEntry, `${processFactRegistryPath}: required local host verdict command missing registry entry: ${commandName}`);
  if (registryEntry) {
    assert(registryEntry.level === 'L4', `${processFactRegistryPath}: ${commandName} registry level must stay L4`);
    assert(registryEntry.kind === 'host-verdict', `${processFactRegistryPath}: ${commandName} registry kind must stay host-verdict`);
    assert(registryEntry.gateEvidence === true, `${processFactRegistryPath}: ${commandName} registry gateEvidence must stay true`);
    assert(registryEntry.artifact?.path === 'process-events.jsonl', `${processFactRegistryPath}: ${commandName} must record process-events.jsonl evidence`);
    for (const semantic of ['host-verdict', 'execution-evidence', 'gate-evidence']) {
      assert(registryEntry.semantics.includes(semantic), `${processFactRegistryPath}: ${commandName} missing ${semantic} semantic`);
    }
    assert(/review escalation/i.test(registryEntry.consumerGate), `${processFactRegistryPath}: ${commandName} consumerGate drifted (${registryEntry.consumerGate})`);
    assert(/review assurance floor/i.test(registryEntry.consumerGate), `${processFactRegistryPath}: ${commandName} consumerGate must name review assurance floor (${registryEntry.consumerGate})`);
  }

  const quorumCommand = 'quorum_submit';
  const quorumPolicy = policyByName.get(quorumCommand);
  assert(quorumPolicy, `${commandPolicyPath}: required local quorum command missing lifecycle policy: ${quorumCommand}`);
  if (quorumPolicy) {
    assert(quorumPolicy.gateEvidence, `${commandPolicyPath}: ${quorumCommand} must stay gateEvidence for local review escalation and review assurance floor`);
    assert(quorumPolicy.allowedPhases.length === ALL_PHASES.length, `${commandPolicyPath}: ${quorumCommand} must be allowed in all phases`);
    assert(quorumPolicy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: ${quorumCommand} destructiveRisk must stay metadata-write`);
    assert(policyBlockHasOwnershipClass(quorumPolicy, 'reviewerWrite'), `${commandPolicyPath}: ${quorumCommand} must stay reviewerWrite so independent hosts can submit verdicts without story owner lease`);
    assert(/storyFilesHash/i.test(quorumPolicy.reason), `${commandPolicyPath}: ${quorumCommand} policy must name storyFilesHash binding`);
    assert(/review_pass_set|reviewer pass/i.test(quorumPolicy.reason), `${commandPolicyPath}: ${quorumCommand} policy must name the reviewer-pass precondition`);
    assert(/autopilot_review_submit/i.test(quorumPolicy.reason), `${commandPolicyPath}: ${quorumCommand} policy must state it reuses the autopilot_review_submit local path`);
    assert(/review escalation DONE gate/i.test(quorumPolicy.reason), `${commandPolicyPath}: ${quorumCommand} policy must name the local review escalation DONE gate`);
    assert(/review assurance floor DONE gate/i.test(quorumPolicy.reason), `${commandPolicyPath}: ${quorumCommand} policy must name the review assurance floor DONE gate`);
    assertLocalAssuranceNoReleaseBoundary(quorumPolicy.reason, `${commandPolicyPath}: ${quorumCommand} policy`);
  }

  const quorumLevelEntry = levelRegistry.get(quorumCommand);
  assert(quorumLevelEntry, `${processFactLevelRegistryPath}: required local quorum command missing level entry: ${quorumCommand}`);
  if (quorumLevelEntry) {
    assert(quorumLevelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${quorumCommand} must stay L4`);
    assert(quorumLevelEntry.category === 'lattice-local-host-verdict', `${processFactLevelRegistryPath}: ${quorumCommand} category must stay lattice-local-host-verdict`);
    assert(quorumLevelEntry.owner === 'handlers/quorum-submit', `${processFactLevelRegistryPath}: ${quorumCommand} owner drifted`);
    assert(/storyFilesHash/i.test(quorumLevelEntry.rationale), `${processFactLevelRegistryPath}: ${quorumCommand} rationale must name storyFilesHash`);
    assert(/review_pass_set|reviewer pass/i.test(quorumLevelEntry.rationale), `${processFactLevelRegistryPath}: ${quorumCommand} rationale must name the reviewer-pass precondition`);
    assert(/review escalation/i.test(quorumLevelEntry.gateConsumer || ''), `${processFactLevelRegistryPath}: ${quorumCommand} gateConsumer drifted`);
    assert(/review assurance floor/i.test(quorumLevelEntry.gateConsumer || ''), `${processFactLevelRegistryPath}: ${quorumCommand} gateConsumer must name review assurance floor`);
  }

  const quorumRegistryEntry = registry.get(quorumCommand);
  assert(quorumRegistryEntry, `${processFactRegistryPath}: required local quorum command missing registry entry: ${quorumCommand}`);
  if (quorumRegistryEntry) {
    assert(quorumRegistryEntry.level === 'L4', `${processFactRegistryPath}: ${quorumCommand} registry level must stay L4`);
    assert(quorumRegistryEntry.kind === 'host-verdict', `${processFactRegistryPath}: ${quorumCommand} registry kind must stay host-verdict`);
    assert(quorumRegistryEntry.gateEvidence === true, `${processFactRegistryPath}: ${quorumCommand} registry gateEvidence must stay true`);
    assert(quorumRegistryEntry.artifact?.path === 'process-events.jsonl', `${processFactRegistryPath}: ${quorumCommand} must record process-events.jsonl evidence`);
    for (const semantic of ['host-verdict', 'execution-evidence', 'gate-evidence']) {
      assert(quorumRegistryEntry.semantics.includes(semantic), `${processFactRegistryPath}: ${quorumCommand} missing ${semantic} semantic`);
    }
    assert(/review escalation/i.test(quorumRegistryEntry.consumerGate), `${processFactRegistryPath}: ${quorumCommand} consumerGate drifted (${quorumRegistryEntry.consumerGate})`);
    assert(/review assurance floor/i.test(quorumRegistryEntry.consumerGate), `${processFactRegistryPath}: ${quorumCommand} consumerGate must name review assurance floor (${quorumRegistryEntry.consumerGate})`);
  }

  const runtimeName = 'runtime:review_escalation_done_gate';
  const runtimeLevel = levelRegistry.get(runtimeName);
  assert(runtimeLevel, `${processFactLevelRegistryPath}: required review escalation runtime fact missing`);
  if (runtimeLevel) {
    assert(runtimeLevel.level === 'L4', `${processFactLevelRegistryPath}: ${runtimeName} must stay L4`);
    assert(runtimeLevel.owner === 'core/review-escalation', `${processFactLevelRegistryPath}: ${runtimeName} owner drifted`);
    assert(runtimeLevel.gateConsumer === 'storyMachine.canFinish DONE review escalation gate', `${processFactLevelRegistryPath}: ${runtimeName} gateConsumer drifted`);
    for (const token of ['first REVIEW round', 'explicitlyConfiguredHighRiskPolicyRequires3x2', '3x2', 'degraded 3x1', 'current material hash']) {
      assert(new RegExp(token, 'i').test(runtimeLevel.rationale), `${processFactLevelRegistryPath}: ${runtimeName} rationale must name ${token}`);
    }
  }
  const runtimeRegistry = registry.get(runtimeName);
  assert(runtimeRegistry, `${processFactRegistryPath}: required process fact missing from PROCESS_FACT_REGISTRY: ${runtimeName}`);
  if (runtimeRegistry) {
    assert(runtimeRegistry.kind === 'runtime-behavior', `${processFactRegistryPath}: ${runtimeName} kind must stay runtime-behavior`);
    assert(runtimeRegistry.level === 'L4', `${processFactRegistryPath}: ${runtimeName} must stay L4`);
    assert(runtimeRegistry.semantics.includes('runtime-behavior'), `${processFactRegistryPath}: ${runtimeName} missing runtime-behavior semantic`);
    assert(runtimeRegistry.semantics.includes('host-verdict'), `${processFactRegistryPath}: ${runtimeName} missing host-verdict semantic`);
    assert(runtimeRegistry.semantics.includes('gate-evidence'), `${processFactRegistryPath}: ${runtimeName} missing gate-evidence semantic`);
    assert(runtimeRegistry.consumerGate === 'storyMachine.canFinish DONE review escalation gate', `${processFactRegistryPath}: ${runtimeName} consumerGate drifted`);
  }
  const evaluatorText = read('packages/main/src/core/review-escalation.ts');
  for (const token of [
    'REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE',
    'explicitlyConfiguredHighRiskPolicyRequires3x2',
    'review_escalation_policy',
    'degradedFallbackAllowed',
    'assuranceLevel',
    'admissibilityStatus',
    'evidenceScope: local-review-escalation',
  ]) {
    assert(evaluatorText.includes(token), `packages/main/src/core/review-escalation.ts: required explicit high-risk policy token missing: ${token}`);
  }
  const smokeText = read('packages/main/src/tasks/review-escalation-smoke.ts');
  for (const token of [
    'valid explicit high-risk policy fact requires 3x2 without first-round problems',
    'high-risk prose or paths do not trigger without explicit policy fact',
    'explicit high-risk policy can disallow degraded single-host fallback',
  ]) {
    assert(smokeText.includes(token), `packages/main/src/tasks/review-escalation-smoke.ts: required explicit high-risk policy smoke missing: ${token}`);
  }
}

function assertReviewAssuranceFloorContract(registry, levelRegistry) {
  const runtimeName = 'runtime:review_assurance_floor_done_gate';
  const levelEntry = levelRegistry.get(runtimeName);
  assert(levelEntry, `${processFactLevelRegistryPath}: required review assurance floor runtime fact missing`);
  if (levelEntry) {
    assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${runtimeName} must stay L4`);
    assert(levelEntry.owner === 'core/review-assurance-floor', `${processFactLevelRegistryPath}: ${runtimeName} owner drifted`);
    assert(levelEntry.gateConsumer === 'storyMachine.canFinish DONE review assurance floor gate', `${processFactLevelRegistryPath}: ${runtimeName} gateConsumer drifted`);
    for (const token of ['material code diffs', '3x1', '3x2', 'high-risk', 'local evidence', 'release readiness']) {
      assert(new RegExp(token, 'i').test(levelEntry.rationale), `${processFactLevelRegistryPath}: ${runtimeName} rationale must name ${token}`);
    }
  }

  const registryEntry = registry.get(runtimeName);
  assert(registryEntry, `${processFactRegistryPath}: required process fact missing from PROCESS_FACT_REGISTRY: ${runtimeName}`);
  if (registryEntry) {
    assert(registryEntry.kind === 'runtime-behavior', `${processFactRegistryPath}: ${runtimeName} kind must stay runtime-behavior`);
    assert(registryEntry.level === 'L4', `${processFactRegistryPath}: ${runtimeName} must stay L4`);
    assert(registryEntry.semantics.includes('runtime-behavior'), `${processFactRegistryPath}: ${runtimeName} missing runtime-behavior semantic`);
    assert(registryEntry.semantics.includes('host-verdict'), `${processFactRegistryPath}: ${runtimeName} missing host-verdict semantic`);
    assert(registryEntry.semantics.includes('gate-evidence'), `${processFactRegistryPath}: ${runtimeName} missing gate-evidence semantic`);
    assert(registryEntry.consumerGate === 'storyMachine.canFinish DONE review assurance floor gate', `${processFactRegistryPath}: ${runtimeName} consumerGate drifted`);
  }

  const evaluatorText = read('packages/main/src/core/review-assurance-floor.ts');
  for (const token of [
    'evaluateReviewAssuranceFloor',
    'formatReviewAssuranceFloorFailure',
    'REVIEW_ASSURANCE_FLOOR_FAILURE_REQUIRED_ROUNDS = 3',
    'REVIEW_ASSURANCE_FLOOR_HIGH_RISK_HOSTS_PER_ROUND = 2',
    'three-round-two-hosts-or-degraded-single-host',
    'assuranceLevel',
    'markdown documentation',
    'evaluateHostVerdictRounds',
    'review_escalation_fallback',
  ]) {
    assert(evaluatorText.includes(token), `packages/main/src/core/review-assurance-floor.ts: required review assurance floor token missing: ${token}`);
  }

  const doneOracleText = read('packages/main/src/core/done-oracle.ts');
  assert(doneOracleText.includes("id: 'review-assurance-floor'"), 'packages/main/src/core/done-oracle.ts: DONE checklist must contain separate review-assurance-floor row');
  assert(doneOracleText.includes('evaluateReviewAssuranceFloor'), 'packages/main/src/core/done-oracle.ts: DONE checklist must consume review assurance floor evaluator');

  const machineText = read('packages/main/src/core/machine.ts');
  assert(machineText.includes('evaluateReviewAssuranceFloor'), 'packages/main/src/core/machine.ts: canFinish guard must consume review assurance floor evaluator');
  assert(machineText.includes('formatReviewAssuranceFloorFailure'), 'packages/main/src/core/machine.ts: DONE guard failure reason must render review assurance floor diagnostics');

  const smokeText = read('packages/main/src/tasks/review-assurance-floor-smoke.ts');
  for (const token of [
    'zero-review material code is blocked',
    'one fresh local review round passes clean material code',
    'docs-only markdown is not overblocked',
    'failure signals require sticky 3x1 local rounds',
    'high-risk lifecycle gate work requires 3x2 or explicit degraded fallback',
    'wrapper-root machine DONE guard uses resolved gitCwd',
    'assuranceLevel',
  ]) {
    assert(smokeText.includes(token), `packages/main/src/tasks/review-assurance-floor-smoke.ts: required smoke assertion text missing: ${token}`);
  }
}

// B-d243 (host-2 P2 #2): the delivery_check_set process fact MUST record that
// delivery-check signs storyFilesHash and supports the delivery_check_drift_advisory
// outcome. This mirrors how the review-run storyFilesHash gate-consumer semantics
// are asserted (assertReviewRunStoryFilesHashContract): the L4 level rationale,
// the artifact registry rationale, and the signing source must all keep naming
// the storyFilesHash binding + the drift-advisory downgrade so this gate semantic
// cannot silently drift out of the process-fact contract.
function assertDeliveryCheckStoryFilesHashContract(registry, levelRegistry) {
  const commandName = 'delivery_check_set';
  const levelEntry = levelRegistry.get(commandName);
  assert(levelEntry, `${processFactLevelRegistryPath}: required delivery_check_set level entry missing`);
  if (levelEntry) {
    assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${commandName} must stay L4`);
    assert(levelEntry.owner === 'handlers/delivery-check', `${processFactLevelRegistryPath}: ${commandName} owner drifted`);
    assert(/storyMachine\.canFinish DONE gate/.test(levelEntry.gateConsumer || ''), `${processFactLevelRegistryPath}: ${commandName} gateConsumer must name the DONE gate`);
    for (const token of ['storyFilesHash', 'delivery_check_drift_advisory', 'signature', 'strict stale']) {
      assert(
        new RegExp(token, 'i').test(levelEntry.rationale),
        `${processFactLevelRegistryPath}: ${commandName} rationale must name ${token} (delivery-check signs storyFilesHash and supports the drift-advisory outcome)`,
      );
    }
  }

  const artifactEntry = registry.get('artifact:delivery-check.json');
  assert(artifactEntry, `${processFactRegistryPath}: artifact:delivery-check.json missing`);
  if (artifactEntry) {
    assert(artifactEntry.level === 'L4', `${processFactRegistryPath}: artifact:delivery-check.json must stay L4`);
    for (const token of ['storyFilesHash', 'delivery_check_drift_advisory', 'strict stale']) {
      assert(
        new RegExp(token, 'i').test(artifactEntry.rationale || ''),
        `${processFactRegistryPath}: artifact:delivery-check.json rationale must name ${token} (signed storyFilesHash + drift-advisory outcome consumed by DONE)`,
      );
    }
  }

  // The signing source must keep folding storyFilesHash into the signature so the
  // drift-advisory downgrade keyed on it stays non-forgeable.
  const hashSource = read('packages/main/src/core/delivery-check-hash.ts');
  for (const token of ['storyFilesHash', "code: 'delivery_check_drift_advisory'", 'EMPTY_STORY_FILES_HASH']) {
    assert(
      hashSource.includes(token),
      `packages/main/src/core/delivery-check-hash.ts: required delivery-check storyFilesHash token missing: ${token}`,
    );
  }
}

function assertReviewRunStoryFilesHashContract(registry, levelRegistry) {
  const runtimeName = 'runtime:review_run_story_files_hash_gate';
  const levelEntry = levelRegistry.get(runtimeName);
  assert(levelEntry, `${processFactLevelRegistryPath}: required review run storyFilesHash runtime fact missing`);
  if (levelEntry) {
    assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${runtimeName} must stay L4`);
    assert(levelEntry.owner === 'core/review-run', `${processFactLevelRegistryPath}: ${runtimeName} owner drifted`);
    assert(levelEntry.gateConsumer === 'storyMachine.canPassReview REVIEW to TEST gate', `${processFactLevelRegistryPath}: ${runtimeName} gateConsumer drifted`);
    for (const token of ['ReviewRun.storyFilesHash', 'review_run_start', 'signature', 'durable persistence', 'unrelated whole-tree main drift']) {
      assert(new RegExp(token, 'i').test(levelEntry.rationale), `${processFactLevelRegistryPath}: ${runtimeName} rationale must name ${token}`);
    }
  }

  const registryEntry = registry.get(runtimeName);
  assert(registryEntry, `${processFactRegistryPath}: required process fact missing from PROCESS_FACT_REGISTRY: ${runtimeName}`);
  if (registryEntry) {
    assert(registryEntry.kind === 'runtime-behavior', `${processFactRegistryPath}: ${runtimeName} kind must stay runtime-behavior`);
    assert(registryEntry.level === 'L4', `${processFactRegistryPath}: ${runtimeName} must stay L4`);
    for (const semantic of ['runtime-behavior', 'freshness-policy', 'workspace-binding', 'review-run', 'gate-evidence']) {
      assert(registryEntry.semantics.includes(semantic), `${processFactRegistryPath}: ${runtimeName} missing ${semantic} semantic`);
    }
    assert(registryEntry.consumerGate === 'storyMachine.canPassReview REVIEW to TEST gate', `${processFactRegistryPath}: ${runtimeName} consumerGate drifted`);
  }

  const reviewRunsArtifact = registry.get('artifact:review-runs.json');
  assert(reviewRunsArtifact, `${processFactRegistryPath}: artifact:review-runs.json missing`);
  if (reviewRunsArtifact) {
    assert(/ReviewRun\.storyFilesHash/.test(reviewRunsArtifact.artifact?.signature || ''), `${processFactRegistryPath}: review-runs.json signature must mention ReviewRun.storyFilesHash`);
    assert(/workspaceBinding\.bindingHash/.test(reviewRunsArtifact.artifact?.signature || ''), `${processFactRegistryPath}: review-runs.json signature must preserve workspaceBinding.bindingHash`);
    assert(reviewRunsArtifact.semantics.includes('freshness-policy'), `${processFactRegistryPath}: artifact:review-runs.json missing freshness-policy semantic`);
  }

  const handlerText = read('packages/main/src/handlers/review-run.ts');
  for (const token of [
    'const { headHash, materialHash, storyFilesHash } = captureReviewRunSnapshot',
    'persisted.storyFilesHash !== storyFilesHash',
  ]) {
    assert(handlerText.includes(token), `packages/main/src/handlers/review-run.ts: required storyFilesHash token missing: ${token}`);
  }
  assert(
    /buildReviewRunWorkspaceBinding\([\s\S]*storyFilesHash/.test(handlerText),
    'packages/main/src/handlers/review-run.ts: review_run_start must pass storyFilesHash into buildReviewRunWorkspaceBinding',
  );
  assert(
    /signReviewRun\([\s\S]*scopeBinding\?\.bindingHash,[\s\S]*workspaceBinding\.bindingHash,[\s\S]*storyFilesHash/.test(handlerText),
    'packages/main/src/handlers/review-run.ts: review_run_start must fold storyFilesHash into signReviewRun after workspaceBindingHash',
  );

  const smokeText = read('packages/main/src/tasks/field-regression-cli-smoke.ts');
  for (const token of [
    'assertReviewRunStoryFilesHashAcceptsUnrelatedMainDrift',
    'review_run_start should persist top-level storyFilesHash',
    'main unrelated material drift',
    'review_pass_set',
    'whole-tree materialHash drift',
  ]) {
    assert(smokeText.includes(token), `packages/main/src/tasks/field-regression-cli-smoke.ts: required storyFilesHash smoke token missing: ${token}`);
  }
}

function assertDecisionDocPromotionCommandContract(cliToolNameSet, registry, levelRegistry, policyByName) {
  for (const commandName of requiredDecisionDocPromotionCommands) {
    assert(cliToolNameSet.has(commandName), `CLI schema: required decision-doc promotion command missing from MAIN_TOOLS: ${commandName}`);
    const policy = policyByName.get(commandName);
    assert(policy, `${commandPolicyPath}: required decision-doc promotion command missing lifecycle policy: ${commandName}`);
    const levelEntry = levelRegistry.get(commandName);
    assert(levelEntry, `${processFactLevelRegistryPath}: required decision-doc promotion command missing level entry: ${commandName}`);
    const registryEntry = registry.get(commandName);
    assert(registryEntry, `${processFactRegistryPath}: required decision-doc promotion command missing registry entry: ${commandName}`);
  }

  const proposalPolicy = policyByName.get('decision_doc_proposal');
  if (proposalPolicy) {
    assert(proposalPolicy.gateEvidence, `${commandPolicyPath}: decision_doc_proposal must stay gateEvidence`);
    assert(sameStringArray(proposalPolicy.allowedPhases, ['PLAN', 'DEV']), `${commandPolicyPath}: decision_doc_proposal must stay PLAN/DEV only`);
    assert(proposalPolicy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: decision_doc_proposal destructiveRisk must stay metadata-write`);
    assert(policyBlockHasOwnershipClass(proposalPolicy, 'storyScopedMutating'), `${commandPolicyPath}: decision_doc_proposal must stay storyScopedMutating`);
    assert(/digest-bound|proposal/i.test(proposalPolicy.reason), `${commandPolicyPath}: decision_doc_proposal policy must name the digest-bound proposal boundary`);
    assertLocalAssuranceNoReleaseBoundary(proposalPolicy.reason, `${commandPolicyPath}: decision_doc_proposal policy`);
  }
  const proposalLevel = levelRegistry.get('decision_doc_proposal');
  if (proposalLevel) {
    assert(proposalLevel.level === 'L4', `${processFactLevelRegistryPath}: decision_doc_proposal must stay L4`);
    assert(proposalLevel.category === 'decision-doc-promotion', `${processFactLevelRegistryPath}: decision_doc_proposal category must stay decision-doc-promotion`);
    assert(proposalLevel.owner === 'handlers/decision-doc-promotion', `${processFactLevelRegistryPath}: decision_doc_proposal owner drifted`);
    assert(/decision_doc_save|freshness|render/i.test(proposalLevel.gateConsumer || ''), `${processFactLevelRegistryPath}: decision_doc_proposal gateConsumer must name save freshness/render consumption`);
  }
  const proposalRegistry = registry.get('decision_doc_proposal');
  if (proposalRegistry) {
    assert(proposalRegistry.level === 'L4', `${processFactRegistryPath}: decision_doc_proposal registry level must stay L4`);
    assert(proposalRegistry.kind === 'gate-evidence', `${processFactRegistryPath}: decision_doc_proposal registry kind must stay gate-evidence`);
    assert(proposalRegistry.gateEvidence === true, `${processFactRegistryPath}: decision_doc_proposal registry gateEvidence must stay true`);
    assert(proposalRegistry.artifact?.path === 'decision-doc-proposals.json', `${processFactRegistryPath}: decision_doc_proposal must record decision-doc-proposals.json`);
    assert(/decision_doc_save|freshness|render/i.test(proposalRegistry.consumerGate), `${processFactRegistryPath}: decision_doc_proposal consumerGate drifted (${proposalRegistry.consumerGate})`);
    for (const semantic of ['schema-contract', 'gate-evidence']) {
      assert(proposalRegistry.semantics.includes(semantic), `${processFactRegistryPath}: decision_doc_proposal missing ${semantic} semantic`);
    }
  }

  const previewPolicy = policyByName.get('decision_doc_preview');
  if (previewPolicy) {
    assert(!previewPolicy.gateEvidence, `${commandPolicyPath}: decision_doc_preview must not be gateEvidence`);
    assert(previewPolicy.allowedPhases.length === ALL_PHASES.length, `${commandPolicyPath}: decision_doc_preview must be allowed in all phases`);
    assert(previewPolicy.destructiveRisk === 'none', `${commandPolicyPath}: decision_doc_preview destructiveRisk must stay none`);
    assert(policyBlockHasOwnershipClass(previewPolicy, 'readOnly'), `${commandPolicyPath}: decision_doc_preview must stay readOnly`);
    assert(/read-only|writes no files|metadata|process events/i.test(previewPolicy.reason), `${commandPolicyPath}: decision_doc_preview policy must state the read-only/no-mutation boundary`);
    assertLocalAssuranceNoReleaseBoundary(previewPolicy.reason, `${commandPolicyPath}: decision_doc_preview policy`);
  }
  const previewLevel = levelRegistry.get('decision_doc_preview');
  if (previewLevel) {
    assert(previewLevel.level === 'L0', `${processFactLevelRegistryPath}: decision_doc_preview must stay L0`);
    assert(previewLevel.category === 'decision-doc-promotion-read', `${processFactLevelRegistryPath}: decision_doc_preview category must stay decision-doc-promotion-read`);
    assert(previewLevel.owner === 'handlers/decision-doc-promotion', `${processFactLevelRegistryPath}: decision_doc_preview owner drifted`);
    assert(!previewLevel.gateConsumer, `${processFactLevelRegistryPath}: decision_doc_preview must not declare a gateConsumer`);
  }
  const previewRegistry = registry.get('decision_doc_preview');
  if (previewRegistry) {
    assert(previewRegistry.level === 'L0', `${processFactRegistryPath}: decision_doc_preview registry level must stay L0`);
    assert(previewRegistry.kind === 'command', `${processFactRegistryPath}: decision_doc_preview registry kind must stay command`);
    assert(previewRegistry.gateEvidence === false, `${processFactRegistryPath}: decision_doc_preview registry gateEvidence must stay false`);
    assert(!previewRegistry.artifact, `${processFactRegistryPath}: decision_doc_preview must not produce a process artifact`);
    assert(!previewRegistry.consumerGate, `${processFactRegistryPath}: decision_doc_preview must not be consumed by a lifecycle gate`);
    assert(previewRegistry.semantics.includes('command'), `${processFactRegistryPath}: decision_doc_preview must remain a command projection semantic`);
    assert(!previewRegistry.semantics.includes('gate-evidence'), `${processFactRegistryPath}: decision_doc_preview must not gain gate-evidence semantic`);
  }

  const savePolicy = policyByName.get('decision_doc_save');
  if (savePolicy) {
    assert(savePolicy.gateEvidence, `${commandPolicyPath}: decision_doc_save must stay gateEvidence`);
    assert(sameStringArray(savePolicy.allowedPhases, ['DEV']), `${commandPolicyPath}: decision_doc_save must stay DEV-only`);
    assert(savePolicy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: decision_doc_save destructiveRisk must stay metadata-write`);
    assert(policyBlockHasOwnershipClass(savePolicy, 'storyScopedMutating'), `${commandPolicyPath}: decision_doc_save must stay storyScopedMutating`);
    assert(/docs\/requirements\/decisions\/<slug>\.md|decision-doc quorum DONE gate|fresh proposal/i.test(savePolicy.reason), `${commandPolicyPath}: decision_doc_save policy must name canonical path, freshness, and quorum gate`);
    assertLocalAssuranceNoReleaseBoundary(savePolicy.reason, `${commandPolicyPath}: decision_doc_save policy`);
  }
  const saveLevel = levelRegistry.get('decision_doc_save');
  if (saveLevel) {
    assert(saveLevel.level === 'L4', `${processFactLevelRegistryPath}: decision_doc_save must stay L4`);
    assert(saveLevel.category === 'decision-doc-promotion', `${processFactLevelRegistryPath}: decision_doc_save category must stay decision-doc-promotion`);
    assert(saveLevel.owner === 'handlers/decision-doc-promotion', `${processFactLevelRegistryPath}: decision_doc_save owner drifted`);
    assert(/decision-doc quorum DONE gate|docs\/requirements\/decisions/i.test(saveLevel.gateConsumer || ''), `${processFactLevelRegistryPath}: decision_doc_save gateConsumer must name changed decision-doc quorum consumption`);
  }
  const saveRegistry = registry.get('decision_doc_save');
  if (saveRegistry) {
    assert(saveRegistry.level === 'L4', `${processFactRegistryPath}: decision_doc_save registry level must stay L4`);
    assert(saveRegistry.kind === 'gate-evidence', `${processFactRegistryPath}: decision_doc_save registry kind must stay gate-evidence`);
    assert(saveRegistry.gateEvidence === true, `${processFactRegistryPath}: decision_doc_save registry gateEvidence must stay true`);
    assert(saveRegistry.artifact?.path === 'process-events.jsonl', `${processFactRegistryPath}: decision_doc_save must record process-events.jsonl evidence`);
    assert(/decision-doc quorum DONE gate|docs\/requirements\/decisions/i.test(saveRegistry.consumerGate), `${processFactRegistryPath}: decision_doc_save consumerGate drifted (${saveRegistry.consumerGate})`);
    for (const semantic of ['artifact', 'schema-contract', 'execution-evidence', 'gate-evidence']) {
      assert(saveRegistry.semantics.includes(semantic), `${processFactRegistryPath}: decision_doc_save missing ${semantic} semantic`);
    }
  }

  const proposalArtifact = registry.get('artifact:decision-doc-proposals.json');
  assert(proposalArtifact, `${processFactRegistryPath}: decision doc proposal artifact missing from PROCESS_FACT_REGISTRY`);
  if (proposalArtifact) {
    assert(proposalArtifact.level === 'L4', `${processFactRegistryPath}: decision-doc-proposals.json artifact must stay L4`);
    assert(proposalArtifact.kind === 'artifact', `${processFactRegistryPath}: decision-doc-proposals.json artifact kind must stay artifact`);
    assert(proposalArtifact.artifact?.path === 'decision-doc-proposals.json', `${processFactRegistryPath}: decision-doc-proposals.json artifact path drifted`);
    assert(proposalArtifact.artifact?.signed === false, `${processFactRegistryPath}: decision-doc-proposals.json artifact must remain digest-bound, not signed`);
    assert(/decision_doc_save|freshness|render/i.test(proposalArtifact.consumerGate), `${processFactRegistryPath}: decision-doc-proposals.json artifact consumerGate drifted (${proposalArtifact.consumerGate})`);
    for (const semantic of ['artifact', 'schema-contract', 'execution-evidence', 'gate-evidence']) {
      assert(proposalArtifact.semantics.includes(semantic), `${processFactRegistryPath}: decision-doc-proposals.json artifact missing ${semantic} semantic`);
    }
  }

  const handlerText = read('packages/main/src/handlers/decision-doc-promotion.ts');
  for (const token of [
    'assertTargetInScope',
    'expectedProposalDigest',
    'expectedSourceDecisionDigest',
    'renderDecisionDocMarkdown',
    'writeFileSync(targetAbs',
    'authorityBoundary',
    'not local proof-admissibility, receipt-bundle, quorum, or release readiness',
    'does not create proof-admissibility, receipt-bundle, quorum, retired remote-completion fields, or release readiness',
  ]) {
    assert(handlerText.includes(token), `packages/main/src/handlers/decision-doc-promotion.ts: missing decision-doc promotion contract token ${token}`);
  }
}

function assertActiveLifecycleDocGuidance() {
  for (const relPath of activeLifecycleDocPaths) {
    const text = read(relPath);
    for (const term of activeLifecycleDocCurrentTerms) {
      assert(text.includes(term), `${relPath}: active lifecycle docs must mention current flow term "${term}"`);
    }
    for (const issue of scanActiveLifecycleDocText(text, relPath)) fail(issue);

    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const commandName = legacyTestFixtureCommands.find(command => new RegExp(`\\b${command}\\b`).test(line));
      if (!commandName) continue;

      const contextStart = Math.max(0, index - 2);
      const contextEnd = Math.min(lines.length, index + 3);
      const context = lines.slice(contextStart, contextEnd).join('\n');
      assert(
        legacyCommandDocContextPattern.test(context),
        `${relPath}:${index + 1} ${commandName} mention must be labelled legacy/compat/maintenance or be in historical context`,
      );
    }
  }

  for (const relPath of validatePrimaryReferenceDocPaths) {
    const text = read(relPath);
    for (const issue of scanActiveLifecycleDocText(text, relPath)) fail(issue);
  }
}

function assertReviewRoundIsoDocs() {
  for (const relPath of reviewRoundIsoDocPaths) {
    const text = read(relPath);
    assert(
      text.includes('reviewRound: string (ISO 8601 review round id)'),
      `${relPath}: reviewRound must be documented as string (ISO 8601 review round id)`,
    );
    assert(
      text.includes('story_review.planReviewRound: number (PLAN review round count)'),
      `${relPath}: story_review PLAN round must be documented as planReviewRound number`,
    );
    assert(
      text.includes('legacy numeric PLAN review alias'),
      `${relPath}: legacy story_review.reviewRound alias must be distinguished from signed reviewRound`,
    );
    assert(
      text.includes('express-exempt'),
      `${relPath}: express verification exemption must be documented as express-exempt`,
    );
    assert(
      text.includes('pass-only finding_add'),
      `${relPath}: pass-only finding_add normalization must be documented`,
    );
  }
}

function assertEvidenceBoundaryDocs() {
  for (const relPath of evidenceBoundaryDocPaths) {
    const text = read(relPath);
    for (const phrase of requiredEvidenceBoundaryPhrases) {
      assert(text.includes(phrase), `${relPath}: missing process evidence boundary phrase "${phrase}"`);
    }
  }
}

function assertPromptEvidenceBoundaries(promptMap) {
  for (const [relPath, text] of promptMap.entries()) {
    const name = basename(relPath);
    if (text.includes('fresh worker per item')) {
      assert(
        text.includes('prompt-only worker claims are not mechanical evidence'),
        `${relPath}: fresh-worker guidance must state prompt-only worker claims are not mechanical evidence`,
      );
      assert(
        text.includes('dispatch/process-event/commit evidence'),
        `${relPath}: fresh-worker guidance must name dispatch/process-event/commit evidence as the observable boundary`,
      );
    }
    if (text.includes('delivery-check.json') || name === 'product-reviewer.md') {
      assert(
        text.includes('transcript/delivery evidence is required; prompt-only user-value claims are not enough'),
        `${relPath}: delivery/product guidance must reject prompt-only user-value claims`,
      );
      assert(
        text.includes('non-mechanical user approval'),
        `${relPath}: delivery/product guidance must distinguish subjective approval from mechanical evidence`,
      );
    }
  }
}

function stripTsComments(text) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quote) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      out += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      out += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
      out += ' ';
      continue;
    }

    out += char;
  }
  return out;
}

function readQuotedLiteralAt(text, openIndex) {
  const quote = text[openIndex];
  let escaped = false;
  let value = '';
  for (let index = openIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote) return { value, endIndex: index + 1 };
    value += char;
  }
  return null;
}

function skipWhitespace(text, index) {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function findObjectArrayPropertyOpen(body, propertyName) {
  let index = 0;
  while (index < body.length) {
    index = skipWhitespace(body, index);
    if (body[index] === ',') {
      index += 1;
      continue;
    }

    let key = '';
    if (body[index] === '\'' || body[index] === '"' || body[index] === '`') {
      const literal = readQuotedLiteralAt(body, index);
      if (!literal) return -1;
      key = literal.value;
      index = literal.endIndex;
    } else {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(body.slice(index));
      if (!match) {
        index += 1;
        continue;
      }
      key = match[0];
      index += match[0].length;
    }

    index = skipWhitespace(body, index);
    if (body[index] !== ':') continue;
    index = skipWhitespace(body, index + 1);
    if (key === propertyName && body[index] === '[') return index;

    if (body[index] === '{') {
      const block = extractBalancedBlock(body, index, '{', '}', `DEFAULT_PHASE_TOOLS ${key}`);
      index += block.length + 2;
    } else if (body[index] === '[') {
      const block = extractBalancedBlock(body, index, '[', ']', `DEFAULT_PHASE_TOOLS ${key}`);
      index += block.length + 2;
    } else if (body[index] === '\'' || body[index] === '"' || body[index] === '`') {
      const literal = readQuotedLiteralAt(body, index);
      index = literal ? literal.endIndex : index + 1;
    } else {
      while (index < body.length && body[index] !== ',') index += 1;
    }
  }
  return -1;
}

function extractPhaseToolEntries(configText, phaseName) {
  const text = stripTsComments(configText);
  const body = extractExportedObjectBody(text, 'DEFAULT_PHASE_TOOLS', 'packages/main/src/core/config.ts');
  const openIndex = findObjectArrayPropertyOpen(body, phaseName);
  if (openIndex === -1) return new Set();

  let depth = 1;
  let quote = null;
  let escaped = false;
  let block = '';
  for (let index = openIndex + 1; index < body.length; index += 1) {
    const char = body[index];

    if (quote) {
      block += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      block += char;
      continue;
    }

    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
    block += char;
  }

  const entries = new Set();
  for (const literal of block.matchAll(/['"]((?:\\.|[^'"\\])*)['"]/g)) {
    entries.add(literal[1].replace(/\\(['"\\])/g, '$1'));
  }
  return entries;
}

function patternMatchesCommand(pattern, commandName) {
  if (pattern.endsWith('*')) return commandName.startsWith(pattern.slice(0, -1));
  return pattern === commandName;
}

function isPhaseToolsRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function commandAllowedByLifecyclePolicySource(commandName, phaseName) {
  if (commandName === 'session_brief' || commandName === 'next') return true;
  const policy = parseCommandPolicyEntries().find(entry => entry.name === commandName);
  if (!policy) return true;
  return policy.allowedPhases.includes(phaseName);
}

function commandAllowedByConfiguredPhaseTools(commandName, phaseName, phaseTools) {
  if (commandName === 'session_brief' || commandName === 'next') return true;
  if (!commandAllowedByLifecyclePolicySource(commandName, phaseName)) return false;
  if (phaseTools !== undefined && !isPhaseToolsRecord(phaseTools)) return true;
  const pt = phaseTools || {};
  const patterns = [...(pt['*'] || []), ...(pt[phaseName] || [])].filter(value => typeof value === 'string');
  return patterns.some(pattern => patternMatchesCommand(pattern, commandName));
}

function getDefaultPhaseToolEntries(configText, phaseName) {
  if (builtConfigModule?.DEFAULT_PHASE_TOOLS) {
    return new Set([
      ...(builtConfigModule.DEFAULT_PHASE_TOOLS['*'] || []),
      ...(builtConfigModule.DEFAULT_PHASE_TOOLS[phaseName] || []),
    ]);
  }
  return new Set([
    ...extractPhaseToolEntries(configText, '*'),
    ...extractPhaseToolEntries(configText, phaseName),
  ]);
}

function commandAllowedByDefaultConfig(commandName, phaseName, configText) {
  if (builtConfigModule?.isCommandAllowed) {
    return builtConfigModule.isCommandAllowed(commandName, phaseName);
  }
  const patterns = getDefaultPhaseToolEntries(configText, phaseName);
  if (!commandAllowedByLifecyclePolicySource(commandName, phaseName)) return false;
  return [...patterns].some(pattern => patternMatchesCommand(pattern, commandName));
}

function patternHasPolicyApprovedCommand(pattern, phaseName, policyEntries) {
  return policyEntries.some(entry => (
    patternMatchesCommand(pattern, entry.name) && entry.allowedPhases.includes(phaseName)
  ));
}

function patternHasRegistryApprovedCommand(pattern, phaseName, registryCommandEntries) {
  return registryCommandEntries.some(entry => (
    patternMatchesCommand(pattern, entry.name) && entry.allowedPhases.includes(phaseName)
  ));
}

function assertCommandPolicyPhaseAlignment(policyEntries, configText) {
  for (const entry of policyEntries) {
    for (const phaseName of ALL_PHASES) {
      const policyAllows = entry.allowedPhases.includes(phaseName);
      const defaultAllows = commandAllowedByDefaultConfig(entry.name, phaseName, configText);
      assert(
        defaultAllows === policyAllows,
        `${commandPolicyPath} + packages/main/src/core/config.ts: ${entry.name} ${phaseName} policy/default phase drift (policy=${policyAllows}, isCommandAllowed=${defaultAllows})`,
      );
    }
  }

  for (const phaseName of ALL_PHASES) {
    for (const pattern of getDefaultPhaseToolEntries(configText, phaseName)) {
      assert(
        patternHasPolicyApprovedCommand(pattern, phaseName, policyEntries),
        `packages/main/src/core/config.ts: DEFAULT_PHASE_TOOLS ${phaseName} pattern "${pattern}" has no command allowed by COMMAND_POLICIES`,
      );
    }
  }

  assert(
    commandAllowedByDefaultConfig('understanding_get', 'REVIEW', configText) &&
      commandAllowedByDefaultConfig('decision_get', 'REVIEW', configText),
    'packages/main/src/core/config.ts: REVIEW must allow understanding_get and decision_get for reviewer access to planning artifacts',
  );
}

function assertL4ProducerOrReplacement(registryEntries, policyByName, configText) {
  for (const entry of registryEntries.filter(item => item.level === 'L4')) {
    if (entry.name.includes(':')) continue;
    const policy = policyByName.get(entry.name);
    assert(policy, `${commandPolicyPath}: L4 command ${entry.name} must have lifecycle policy`);
    if (!policy) continue;
    const producerPhases = ALL_PHASES.filter(phaseName => commandAllowedByDefaultConfig(entry.name, phaseName, configText));
    assert(
      producerPhases.length > 0 || policy.replacement.trim().length > 0,
      `${commandPolicyPath}: L4 command ${entry.name} must have a DEFAULT_PHASE_TOOLS producer phase or replacement guidance`,
    );
  }
}

function sameStringArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isCommandRegistryEntry(entry) {
  return !entry.name.includes(':');
}

function assertProcessFactRegistryContract(cliToolNames, policyEntries, configText) {
  const registryEntries = parseProcessFactRegistry();
  const registry = new Map(registryEntries.map(entry => [entry.name, entry]));
  const registryCommandEntries = registryEntries.filter(isCommandRegistryEntry);
  const registryCommandByName = new Map(registryCommandEntries.map(entry => [entry.name, entry]));
  const policyByName = new Map(policyEntries.map(entry => [entry.name, entry]));
  const levelRegistry = new Map(parseProcessFactLevelRegistry().map(entry => [entry.name, entry]));

  const duplicateRegistryNames = duplicateNames(registryEntries.map(entry => entry.name));
  assert(
    duplicateRegistryNames.length === 0,
    `${processFactRegistryPath}: duplicate PROCESS_FACT_REGISTRY entries: ${duplicateRegistryNames.join(', ')}`,
  );

  for (const entry of registryEntries) {
    assert(processFactRegistryKinds.has(entry.kind), `${processFactRegistryPath}: ${entry.name} has unknown kind "${entry.kind}"`);
    assert(Array.isArray(entry.semantics), `${processFactRegistryPath}: ${entry.name} must declare semantics[]`);
    assert(entry.producer && entry.producer.trim().length > 0, `${processFactRegistryPath}: ${entry.name} must declare producer`);
    assert(entry.rationale && entry.rationale.trim().length > 0, `${processFactRegistryPath}: ${entry.name} must declare rationale`);
    if (entry.level === 'L4') {
      assert(
        entry.consumerGate && entry.consumerGate.trim().length > 0,
        `${processFactRegistryPath}: L4 gate evidence ${entry.name} must name consumer gate`,
      );
    }
  }

  for (const commandName of cliToolNames) {
    assert(
      registryCommandByName.has(commandName),
      `${processFactRegistryPath}: MAIN_TOOLS command missing from PROCESS_FACT_REGISTRY: command=${commandName}`,
    );
  }

  for (const entry of registryCommandEntries) {
    if (entry.name.startsWith('runtime:')) continue;
    assert(
      cliToolNames.includes(entry.name),
      `${processFactRegistryPath}: command registry entry not present in MAIN_TOOLS: command=${entry.name}`,
    );
  }

  for (const levelEntry of parseProcessFactLevelRegistry()) {
    const registryEntry = registry.get(levelEntry.name);
    assert(
      registryEntry,
      `${processFactRegistryPath}: required process fact missing from PROCESS_FACT_REGISTRY: ${levelEntry.name}`,
    );
    if (!registryEntry) continue;
    assert(
      registryEntry.level === levelEntry.level,
      `${processFactRegistryPath}: level drift for command=${levelEntry.name} (registry=${registryEntry.level}, PROCESS_FACT_LEVELS=${levelEntry.level})`,
    );
    if (levelEntry.gateConsumer) {
      assert(
        registryEntry.consumerGate === levelEntry.gateConsumer,
        `${processFactRegistryPath}: gate drift for command=${levelEntry.name} (registry=${registryEntry.consumerGate || '<missing>'}, PROCESS_FACT_LEVELS=${levelEntry.gateConsumer})`,
      );
    }
  }

  for (const policy of policyEntries) {
    const registryEntry = registryCommandByName.get(policy.name);
    if (!registryEntry) continue;
    assert(
      registryEntry.lifecycle === policy.status,
      `${processFactRegistryPath}: policy drift for command=${policy.name} lifecycle registry=${registryEntry.lifecycle || '<missing>'} policy=${policy.status}`,
    );
    assert(
      registryEntry.destructiveRisk === policy.destructiveRisk,
      `${processFactRegistryPath}: policy drift for command=${policy.name} destructiveRisk registry=${registryEntry.destructiveRisk || '<missing>'} policy=${policy.destructiveRisk || '<missing>'}`,
    );
    assert(
      registryEntry.rootOnly === policy.rootOnly,
      `${processFactRegistryPath}: policy drift for command=${policy.name} rootOnly registry=${registryEntry.rootOnly} policy=${policy.rootOnly}`,
    );
    assert(
      registryEntry.gateEvidence === policy.gateEvidence,
      `${processFactRegistryPath}: policy drift for command=${policy.name} gateEvidence registry=${registryEntry.gateEvidence} policy=${policy.gateEvidence}`,
    );
    assert(
      sameStringArray(registryEntry.allowedPhases, policy.allowedPhases),
      `${processFactRegistryPath}: policy drift for command=${policy.name} allowedPhases registry=[${registryEntry.allowedPhases.join(',')}] policy=[${policy.allowedPhases.join(',')}]`,
    );
  }

  for (const [commandName, expectedSemantics] of Object.entries(requiredProcessFactSemantics)) {
    const entry = registryCommandByName.get(commandName);
    assert(entry, `${processFactRegistryPath}: required process fact missing from PROCESS_FACT_REGISTRY: ${commandName}`);
    if (!entry) continue;
    assert(
      expectedSemantics.every((semantic) => entry.semantics.includes(semantic)),
      `${processFactRegistryPath}: required semantic fact missing for command=${commandName} expected=[${expectedSemantics.join(', ')}] got=[${entry.semantics.join(', ')}]`,
    );
  }

  const l4CommandEntries = registryCommandEntries.filter(entry => entry.level === 'L4');
  for (const entry of l4CommandEntries) {
    const policy = policyByName.get(entry.name);
    assert(policy, `${processFactRegistryPath}: L4 command ${entry.name} must have COMMAND_POLICIES entry`);
    if (!policy) continue;
    assert(
      policy.gateEvidence,
      `${processFactRegistryPath}: L4 gate evidence command=${entry.name} must be gateEvidence in COMMAND_POLICIES`,
    );
    assert(
      entry.semantics.includes('gate-evidence'),
      `${processFactRegistryPath}: L4 gate evidence command=${entry.name} missing gate-evidence semantic`,
    );
  }

  for (const phaseName of ALL_PHASES) {
    for (const pattern of getDefaultPhaseToolEntries(configText, phaseName)) {
      assert(
        patternHasRegistryApprovedCommand(pattern, phaseName, registryCommandEntries),
        `${processFactRegistryPath}: DEFAULT_PHASE_TOOLS phase allowlist drift phase=${phaseName} pattern=${pattern}`,
      );
    }
  }

  for (const lane of requiredReviewerLanes) {
    const entry = registry.get(`reviewer-lane:${lane}`);
    assert(entry, `${processFactRegistryPath}: reviewer lane missing from PROCESS_FACT_REGISTRY: lane=${lane}`);
    if (!entry) continue;
    assert(entry.kind === 'reviewer-lane', `${processFactRegistryPath}: reviewer lane ${lane} must have kind reviewer-lane`);
    assert(entry.reviewerLane === lane, `${processFactRegistryPath}: reviewer lane drift for lane=${lane}`);
    assert(entry.consumerGate, `${processFactRegistryPath}: reviewer lane ${lane} must name consumer gate`);
    assert(entry.artifact, `${processFactRegistryPath}: reviewer lane ${lane} must name produced/consumed artifact`);
  }

  const promptReviewerLanes = listMarkdown('packages/main/templates/agents')
    .map(relPath => basename(relPath, '.md'))
    .filter(name => name.startsWith('lattice-review-') || name === 'product-reviewer');
  for (const lane of promptReviewerLanes) {
    assert(
      registry.has(`reviewer-lane:${lane}`),
      `${processFactRegistryPath}: reviewer lane prompt missing registry fact: lane=${lane}`,
    );
  }

  const artifactEntries = registryEntries.filter(entry => entry.name.startsWith('artifact:'));
  for (const entry of registryEntries.filter(item => item.artifact)) {
    const artifactName = `artifact:${entry.artifact.path}`;
    const artifactEntry = registry.get(artifactName);
    assert(
      artifactEntry,
      `${processFactRegistryPath}: command/reviewer artifact ref missing registry artifact: fact=${entry.name} artifact=${artifactName}`,
    );
    if (!artifactEntry?.artifact) continue;
    assert(
      artifactEntry.artifact.path === entry.artifact.path,
      `${processFactRegistryPath}: artifact ref path drift fact=${entry.name} artifact=${artifactName}`,
    );
    assert(
      artifactEntry.artifact.signed === entry.artifact.signed,
      `${processFactRegistryPath}: artifact ref signed drift fact=${entry.name} artifact=${artifactName}`,
    );
  }

  for (const entry of artifactEntries) {
    assert(entry.artifact, `${processFactRegistryPath}: artifact registry entry ${entry.name} must include artifact metadata`);
    if (!entry.artifact) continue;
    assert(entry.semantics.includes('artifact'), `${processFactRegistryPath}: artifact=${entry.name} missing artifact semantic`);
    assert(
      entry.kind === (entry.artifact.signed ? 'signed-artifact' : 'artifact'),
      `${processFactRegistryPath}: artifact kind drift for artifact=${entry.name}`,
    );
    if (entry.artifact.signed) {
      assert(entry.semantics.includes('signed-artifact'), `${processFactRegistryPath}: artifact=${entry.name} missing signed-artifact semantic`);
      assert(
        (entry.artifact.signature || '').trim().length > 0,
        `${processFactRegistryPath}: signed artifact=${entry.name} must declare signature`,
      );
    }
    if (entry.level === 'L4') {
      assert(entry.consumerGate, `${processFactRegistryPath}: artifact=${entry.name} must name consumer gate`);
      assert(entry.semantics.includes('gate-evidence'), `${processFactRegistryPath}: L4 artifact=${entry.name} missing gate-evidence semantic`);
    }
  }

  for (const expected of requiredArtifactFacts) {
    const entry = registry.get(expected.name);
    assert(entry, `${processFactRegistryPath}: artifact missing from PROCESS_FACT_REGISTRY: artifact=${expected.name}`);
    if (!entry) continue;
    assert(
      entry.kind === (expected.signed ? 'signed-artifact' : 'artifact'),
      `${processFactRegistryPath}: artifact kind drift for artifact=${expected.name} expected=${expected.signed ? 'signed-artifact' : 'artifact'} got=${entry.kind}`,
    );
    assert(entry.artifact, `${processFactRegistryPath}: artifact=${expected.name} must include artifact metadata`);
    if (!entry.artifact) continue;
    assert(entry.artifact.path === expected.path, `${processFactRegistryPath}: artifact path drift for artifact=${expected.name} path=${entry.artifact.path}`);
    assert(entry.artifact.signed === expected.signed, `${processFactRegistryPath}: artifact signed drift for artifact=${expected.name}`);
    if (expected.signed) {
      assert(
        expected.signaturePattern.test(entry.artifact.signature || ''),
        `${processFactRegistryPath}: artifact=${expected.name} signature drift (${entry.artifact.signature || '<missing>'})`,
      );
      assert(entry.semantics.includes('signed-artifact'), `${processFactRegistryPath}: artifact=${expected.name} missing signed-artifact semantic`);
    }
    assert(entry.semantics.includes('artifact'), `${processFactRegistryPath}: artifact=${expected.name} missing artifact semantic`);
    assert(entry.consumerGate, `${processFactRegistryPath}: artifact=${expected.name} must name consumer gate`);
  }

  const flowPolicies = parseFlowFactPolicies();
  const flowPolicyNames = flowPolicies.map(entry => entry.name);
  for (const expected of requiredFlowFactPolicies) {
    const sourcePolicy = flowPolicies.find(entry => entry.name === expected.name);
    assert(sourcePolicy, `${flowFactPolicyPath}: required flow fact policy missing: ${expected.name}`);
    if (sourcePolicy) {
      assert(sourcePolicy.policyId === expected.policyId, `${flowFactPolicyPath}: ${expected.name} policyId drifted`);
      assert(sourcePolicy.level === 'L4', `${flowFactPolicyPath}: ${expected.name} must stay L4`);
      assert(sourcePolicy.category === 'flow-policy', `${flowFactPolicyPath}: ${expected.name} must stay category flow-policy`);
      assert(sourcePolicy.owner === 'core/flow-fact-policy', `${flowFactPolicyPath}: ${expected.name} owner drifted`);
      assert(expected.consumerGatePattern.test(sourcePolicy.consumerGate), `${flowFactPolicyPath}: ${expected.name} consumerGate drifted (${sourcePolicy.consumerGate})`);
      assert(sourcePolicy.disposition === expected.disposition, `${flowFactPolicyPath}: ${expected.name} disposition drifted`);
      assert(
        expected.semantics.every(semantic => sourcePolicy.semantics.includes(semantic)),
        `${flowFactPolicyPath}: ${expected.name} missing semantics [${expected.semantics.join(', ')}]`,
      );
    }

    const levelEntry = levelRegistry.get(expected.name);
    assert(levelEntry, `${processFactLevelRegistryPath}: required flow fact policy missing from level registry: ${expected.name}`);
    if (levelEntry) {
      assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${expected.name} must stay L4`);
      assert(levelEntry.category === 'flow-policy', `${processFactLevelRegistryPath}: ${expected.name} category drifted`);
      assert(levelEntry.owner === 'core/flow-fact-policy', `${processFactLevelRegistryPath}: ${expected.name} owner drifted`);
      assert(expected.consumerGatePattern.test(levelEntry.gateConsumer || ''), `${processFactLevelRegistryPath}: ${expected.name} gateConsumer drifted`);
    }

    const registryEntry = registry.get(expected.name);
    assert(registryEntry, `${processFactRegistryPath}: required flow fact policy missing from PROCESS_FACT_REGISTRY: ${expected.name}`);
    if (!registryEntry) continue;
    assert(registryEntry.kind === 'flow-policy', `${processFactRegistryPath}: ${expected.name} must have kind flow-policy`);
    assert(registryEntry.level === 'L4', `${processFactRegistryPath}: ${expected.name} must stay L4`);
    assert(expected.consumerGatePattern.test(registryEntry.consumerGate || ''), `${processFactRegistryPath}: ${expected.name} consumerGate drifted`);
    assert(
      expected.semantics.every(semantic => registryEntry.semantics.includes(semantic)),
      `${processFactRegistryPath}: ${expected.name} missing required semantics [${expected.semantics.join(', ')}]`,
    );
    if (expected.artifactPath) {
      assert(registryEntry.artifact?.path === expected.artifactPath, `${processFactRegistryPath}: ${expected.name} artifact path drifted`);
    } else {
      assert(!registryEntry.artifact, `${processFactRegistryPath}: ${expected.name} should not claim an artifact`);
    }
  }
  assert(
    duplicateNames(flowPolicyNames).length === 0,
    `${flowFactPolicyPath}: duplicate flow fact policy names`,
  );
}

/**
 * @task B-f3db
 * @checklist CHK-001
 * @title transcript lifecycle artifact regression
 * @type bugfix
 * @priority high
 * @description
 *   Proves TEST transcript evidence paths are the only nested evidence paths
 *   accepted by lifecycle artifact scope classification.
 * @changes
 *   - [CHK-001] Assert transcript evidence paths pass scope as lifecycle artifacts
 *   - [CHK-001] Assert nearby arbitrary evidence files remain out_of_scope
 *
 * B-b9d0 CHK-001/CHK-002/CHK-005: mechanical evidence that the scope-contract
 * lifecycle-artifact classifier
 *   (a) accepts known story-scoped lifecycle artifacts under the story id,
 *   (a2) accepts the narrow TEST transcript evidence relative paths,
 *   (b) rejects arbitrary `.koala/foo.json` and `.koala/story/...` writes
 *       after the `.lattice` migration,
 *   (c) rejects ordinary product source files when unacknowledged,
 *   (d) still passes runtime artifacts via the runtime-artifact registry.
 * The policy doc lives at docs/requirements/decisions/lifecycle-artifact-scope.md.
 */
async function assertLifecycleArtifactScopePolicy() {
  const policyDocPath = 'docs/requirements/decisions/lifecycle-artifact-scope.md';
  const roadmapDocPath = 'docs/requirements/decisions/lattice-strengthening-roadmap-execution-plan.md';
  const guardDocPath = 'docs/guide-scope-guard.md';
  if (!existsSync(join(root, policyDocPath))) {
    fail(`lifecycle artifact scope policy doc missing: ${policyDocPath}`);
    return;
  }
  for (const docPath of [roadmapDocPath, guardDocPath]) {
    if (!existsSync(join(root, docPath))) {
      fail(`B-997b wave 1 doc missing: ${docPath}`);
      return;
    }
  }
  const policyDocText = read(policyDocPath);
  const roadmapDocText = read(roadmapDocPath);
  const guardDocText = read(guardDocPath);
  const requiredPolicyMarkers = [
    'isRuntimeArtifactPath',
    'classifyLifecycleArtifact',
    'evidence/transcript-diff.md',
    'evidence/live-smoke-transcript.json',
    'does not weaken product source scope enforcement',
    'arbitrary',
    'M1-M3 wave complete; M4-M12 remain follow-up milestones',
    'scope.lifecycle_artifact:B-scope:summary.json',
    'scope.runtime_artifact:',
    'scope.out_of_scope:',
    'acknowledged expansion remains warn',
  ];
  for (const marker of requiredPolicyMarkers) {
    if (!policyDocText.includes(marker)) {
      fail(`${policyDocPath}: missing required marker "${marker}"`);
    }
  }
  const requiredRoadmapMarkers = [
    'M1-M3 wave complete; M4-M12 remain follow-up milestones',
    'Wave 1 shipped behavior',
    'scope.out_of_scope:src/other.ts',
    'scope.lifecycle_artifact:B-scope:summary.json',
    'Local-assurance Layer 4/customer key work remains out of scope for B-997b',
  ];
  for (const marker of requiredRoadmapMarkers) {
    if (!roadmapDocText.includes(marker)) {
      fail(`${roadmapDocPath}: missing B-997b marker "${marker}"`);
    }
  }
  const requiredGuardMarkers = [
    'M1-M3 wave complete; M4-M12 remain follow-up milestones',
    'acknowledged expansion remains warn',
    'native-pretool',
    'wrapped-preapply',
    'watcher-fallback',
  ];
  for (const marker of requiredGuardMarkers) {
    if (!guardDocText.includes(marker)) {
      fail(`${guardDocPath}: missing B-997b marker "${marker}"`);
    }
  }

  const scopeContractText = read('packages/main/src/core/scope-contract.ts');
  const scopePathClassifierText = read('packages/main/src/core/scope-path-classifier.ts');
  if (scopeContractText.includes(`if (file.startsWith('.koala/')) continue;`)) {
    fail('packages/main/src/core/scope-contract.ts: blanket `.koala/` exemption regressed — must use isRuntimeArtifactPath instead');
  }
  if (!scopeContractText.includes('classifyScopePath')) {
    fail('packages/main/src/core/scope-contract.ts: must consume the canonical scope path classifier');
  }
  if (!scopePathClassifierText.includes('runtime-artifact-registry') || !scopePathClassifierText.includes('findRuntimeArtifactEntry')) {
    fail('packages/main/src/core/scope-path-classifier.ts: must consume the runtime-artifact-registry');
  }
  if (!scopePathClassifierText.includes('classifyLifecycleArtifact')) {
    fail('packages/main/src/core/scope-path-classifier.ts: must keep classifyLifecycleArtifact for story metadata');
  }

  const scopeMod = await import(pathToFileURL(join(root, 'packages/main/dist/core/scope-contract.js')).href);
  const { checkScopeContract } = scopeMod;
  if (typeof checkScopeContract !== 'function') {
    fail('checkScopeContract export missing from packages/main/dist/core/scope-contract.js');
    return;
  }
  const bindingMod = await import(pathToFileURL(join(root, 'packages/main/dist/core/review-scope-binding.js')).href);
  const {
    computeReviewScopeBinding,
    buildCurrentScopeContext,
    compareScopeBinding,
  } = bindingMod;
  for (const [name, fn] of Object.entries({ computeReviewScopeBinding, buildCurrentScopeContext, compareScopeBinding })) {
    if (typeof fn !== 'function') {
      fail(`${name} export missing from packages/main/dist/core/review-scope-binding.js`);
      return;
    }
  }

  const baseContract = {
    storyId: 'B-scope',
    mode: 'enforce',
    allowedModify: ['src/in-scope.ts'],
    allowedCreate: [],
    allowedTest: [],
    protectedFiles: [],
    explicitExcludes: [],
    acknowledgements: [],
    createdAt: '2026-05-28T00:00:00.000Z',
    updatedAt: '2026-05-28T00:00:00.000Z',
  };
  const probe = (files) => checkScopeContract(baseContract, files);
  const isOop = (result, path) =>
    Array.isArray(result.violations)
      && result.violations.some((v) => v.path === path && v.rule === 'out_of_scope');
  const isClean = (result) => result.violations.length === 0;
  const rowsOf = (result, label) => {
    if (!Array.isArray(result.rows)) {
      fail(`${label}: scope check result must expose stable rows`);
      return [];
    }
    for (const row of result.rows) {
      assert(typeof row.id === 'string' && row.id.length > 0, `${label}: row must include stable id`);
      assert(typeof row.status === 'string' && row.status.length > 0, `${label}: row ${row.id} must include status`);
      assert(typeof row.source === 'string' && row.source.length > 0, `${label}: row ${row.id} must include source`);
      assert(typeof row.blocking === 'boolean', `${label}: row ${row.id} must include blocking boolean`);
      assert(
        typeof row.nextAction === 'string' || typeof row.hint === 'string',
        `${label}: row ${row.id} must include nextAction or hint`,
      );
    }
    return result.rows;
  };
  const expectRow = (result, label, predicate) => {
    const rows = rowsOf(result, label);
    const row = rows.find(predicate);
    if (!row) fail(`${label}: missing expected row in ${JSON.stringify(rows)}`);
    return row;
  };
  const transcriptOnlyFile = '.lattice/story/actives/B-scope/evidence/transcript-diff.md';
  const liveSmokeTranscriptOnlyFile = '.lattice/story/actives/B-scope/evidence/live-smoke-transcript.json';

  const lifecycleAccept = [
    '.lattice/story/actives/B-scope/delivery-check.json',
    '.lattice/story/actives/B-scope/summary.json',
    '.lattice/story/actives/B-scope/scope-contract.json',
    '.lattice/story/actives/B-scope/scope-boundary.json',
    '.lattice/story/actives/B-scope/execution-boundary.json',
    '.lattice/story/actives/B-scope/scope-freeze-check.json',
    '.lattice/story/actives/B-scope/scope-extension-proposals.json',
    '.lattice/story/actives/B-scope/decision-doc-proposals.json',
    '.lattice/story/actives/B-scope/scope-discard-digest.json',
    '.lattice/story/actives/B-scope/process-events.jsonl',
    '.lattice/story/actives/B-scope/done-required-evidence.json',
    transcriptOnlyFile,
    liveSmokeTranscriptOnlyFile,
    'docs/story/actives/B-scope/plan.md',
  ];
  for (const file of lifecycleAccept) {
    const result = probe([file]);
    if (!isClean(result)) {
      fail(`lifecycle artifact unexpectedly rejected: ${file} → ${JSON.stringify(result.violations)}`);
    }
  }
  expectRow(
    probe(['.lattice/story/actives/B-scope/summary.json']),
    'B-997b lifecycle artifact row',
    row => row.id === 'scope.lifecycle_artifact:B-scope:summary.json'
      && row.source === '.lattice/story/actives/B-scope/summary.json'
      && row.status === 'pass'
      && row.blocking === false,
  );
  expectRow(
    probe(['.lattice/story/actives/B-scope/done-required-evidence.json']),
    'B-ac25 done-required lifecycle artifact row',
    row => row.id === 'scope.lifecycle_artifact:B-scope:done-required-evidence.json'
      && row.source === '.lattice/story/actives/B-scope/done-required-evidence.json'
      && row.status === 'pass'
      && row.blocking === false,
  );
  const transcriptOnlyScope = probe([transcriptOnlyFile]);
  if (transcriptOnlyScope.status !== 'pass' || !transcriptOnlyScope.summary.includes('Scope gate: pass')) {
    fail(`transcript-only scope check should pass without acknowledgement: ${JSON.stringify(transcriptOnlyScope)}`);
  }
  const liveSmokeTranscriptOnlyScope = probe([liveSmokeTranscriptOnlyFile]);
  if (liveSmokeTranscriptOnlyScope.status !== 'pass' || !liveSmokeTranscriptOnlyScope.summary.includes('Scope gate: pass')) {
    fail(`live-smoke transcript-only scope check should pass without acknowledgement: ${JSON.stringify(liveSmokeTranscriptOnlyScope)}`);
  }

  const runtimeAccept = [
    '.lattice/activity.jsonl',
    '.lattice/runtime/cache.json',
    '.lattice/traces/abc.json',
    '.lattice/locks/main-write.lock/owner',
    '.lattice/story/actives/B-other/owner-lease.json',
    'docs/story/activity.jsonl',
  ];
  for (const file of runtimeAccept) {
    const result = probe([file]);
    if (!isClean(result)) {
      fail(`runtime artifact unexpectedly rejected: ${file} → ${JSON.stringify(result.violations)}`);
    }
  }
  expectRow(
    probe(['.lattice/activity.jsonl']),
    'B-997b runtime artifact row',
    row => typeof row.id === 'string'
      && row.id.startsWith('scope.runtime_artifact:')
      && row.source === '.lattice/activity.jsonl'
      && row.status === 'pass'
      && row.blocking === false,
  );

  const adversarialReject = [
    '.koala/foo.json',
    '.koala/bar.txt',
    '.koala/secrets.json',
    '.koala/story/actives/B-scope/evidence/notes.md',
    '.koala/story/actives/B-scope/evidence/summary.json',
    '.koala/story/actives/B-scope/evidence/test-evidence.json',
    '.koala/story/actives/B-scope/evidence/transcript-diff.txt',
    '.koala/story/actives/B-scope/evidence/transcript-diff.md',
    '.koala/story/actives/B-scope/evidence/live-smoke-transcript.json',
    '.koala/story/actives/B-scope/delivery-check.json',
    'packages/main/src/handlers/unrelated.ts',
    'src/handlers/random.ts',
  ];
  for (const file of adversarialReject) {
    const result = probe([file]);
    if (!isOop(result, file)) {
      fail(`unauthorized file unexpectedly accepted (no out_of_scope violation): ${file} → ${JSON.stringify(result.violations)}`);
    }
    expectRow(
      result,
      `B-997b fail-closed scope row ${file}`,
      row => row.id === `scope.out_of_scope:${file}`
        && row.source === file
        && row.status === 'fail'
        && row.blocking === true,
    );
  }

  // unknown filenames under a story dir must still fall through scope —
  // the lifecycle classifier is filename-aware (closed set), not a
  // blanket pass on the story dir.
  const unknownFilenameUnderStory = '.lattice/story/actives/B-scope/secrets.json';
  const unknownResult = probe([unknownFilenameUnderStory]);
  if (!isOop(unknownResult, unknownFilenameUnderStory)) {
    fail(`unknown filename under story dir unexpectedly accepted: ${unknownFilenameUnderStory} → ${JSON.stringify(unknownResult.violations)}`);
  }
  expectRow(
    unknownResult,
    'B-997b unknown story metadata row',
    row => row.id === `scope.out_of_scope:${unknownFilenameUnderStory}`
      && row.source === unknownFilenameUnderStory
      && row.status === 'fail'
      && row.blocking === true,
  );

  const emptyDiffPack = {
    diffPackHash: 'unused-empty',
    changedFiles: [],
    hunks: [],
    generatedAt: '2026-06-02T00:00:00.000Z',
  };
  const transcriptOnlyDiffPack = {
    diffPackHash: 'unused-transcript',
    changedFiles: [transcriptOnlyFile],
    hunks: [{
      path: transcriptOnlyFile,
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      header: '@@ -0,0 +1 @@',
      hunkDigest: 'abc12345abc12345',
      changeKind: 'add',
    }],
    generatedAt: '2026-06-02T00:00:01.000Z',
  };
  const reviewerBinding = computeReviewScopeBinding({ contract: baseContract, diffPack: emptyDiffPack });
  const transcriptOnlyContext = buildCurrentScopeContext(baseContract, transcriptOnlyDiffPack);
  const transcriptBindingComparison = compareScopeBinding(reviewerBinding, transcriptOnlyContext);
  if (!transcriptBindingComparison.ok) {
    fail(`transcript-only evidence should not invalidate reviewer scope binding: ${JSON.stringify(transcriptBindingComparison)}`);
  }

  const productDiffPack = {
    diffPackHash: 'unused-product',
    changedFiles: ['packages/main/src/handlers/unrelated.ts'],
    hunks: [{
      path: 'packages/main/src/handlers/unrelated.ts',
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      header: '@@ -1 +1 @@',
      hunkDigest: 'def67890def67890',
      changeKind: 'modify',
    }],
    generatedAt: '2026-06-02T00:00:02.000Z',
  };
  const productBindingComparison = compareScopeBinding(reviewerBinding, buildCurrentScopeContext(baseContract, productDiffPack));
  if (productBindingComparison.ok) {
    fail('ordinary product diff unexpectedly kept reviewer scope binding fresh');
  }
}

function assertStrengtheningRoadmapGovernanceLedger() {
  const roadmapDocPath = 'docs/requirements/decisions/lattice-strengthening-roadmap-execution-plan.md';
  if (!existsSync(join(root, roadmapDocPath))) {
    fail(`B-43de roadmap governance doc missing: ${roadmapDocPath}`);
    return;
  }

  const roadmapDocText = read(roadmapDocPath);
  const requiredGovernanceMarkers = [
    'ProofStory Governance Ledger / M4-M12 Child Story Map',
    'B-43de governs M4-M12 as parent rows',
    'does not claim M5-M12 runtime implementation',
    'B-5082 / B-e1a8',
    'B-cd3a',
    '`child-story-needed`',
    '`packages/main/src/core/process-fact-registry.ts`',
    '`packages/main/src/core/process-fact-levels.ts`',
    '`node scripts/verify-process-fact-contract.mjs`',
    'static verifier for process-fact contract drift',
    'Tier-C provider-execution receipt verification',
    'intentional experiment corpus',
    'Duplicate cleanup applies to non-experiment active stories',
  ];
  for (const marker of requiredGovernanceMarkers) {
    if (!roadmapDocText.includes(marker)) {
      fail(`${roadmapDocPath}: missing B-43de governance marker "${marker}"`);
    }
  }
}

function assertProcessFactCommandInventory() {
  const cliText = read('packages/main/src/cli/command-catalog.ts');
  const configText = read('packages/main/src/core/config.ts');
  const cliToolNames = extractCliToolNames(cliText);
  const cliToolNameSet = new Set(cliToolNames);
  const levelRegistryEntries = parseProcessFactLevelRegistry();
  const registryEntries = parseProcessFactRegistry();
  const registry = new Map(registryEntries.map(entry => [entry.name, entry]));
  const levelRegistry = new Map(levelRegistryEntries.map(entry => [entry.name, entry]));
  const policyEntries = parseCommandPolicyEntries();
  const policyByName = new Map(policyEntries.map(entry => [entry.name, entry]));
  assertCommandPolicyInventory(cliToolNames);
  assertCommandPolicyPhaseAlignment(policyEntries, configText);
  assertProcessFactRegistryContract(cliToolNames, policyEntries, configText);
  assertReviewLoopCommandContract(cliToolNameSet, registry, levelRegistry, policyByName);
  assertDoneClosureCommandContract(cliToolNameSet, registry, levelRegistry, policyByName);
  assertDoneRequiredValidationCommandContract(cliToolNameSet, registry, levelRegistry, policyByName);
  assertDecisionDocQuorumCommandContract(cliToolNameSet, registry, levelRegistry, policyByName);
  assertDecisionDocPromotionCommandContract(cliToolNameSet, registry, levelRegistry, policyByName);

  const definitionLevels = new Set(parseProcessFactLevelDefinitions());
  for (const level of ['L0', 'L1', 'L2', 'L3', 'L4']) {
    assert(definitionLevels.has(level), `${processFactLevelRegistryPath}: missing ${level} definition`);
  }

  const duplicateCliNames = duplicateNames(cliToolNames);
  assert(
    duplicateCliNames.length === 0,
    `CLI schema: duplicate MAIN_TOOLS command(s): ${duplicateCliNames.join(', ')}`,
  );

  const duplicateRegistryNames = duplicateNames(levelRegistryEntries.map(entry => entry.name));
  assert(
    duplicateRegistryNames.length === 0,
    `${processFactLevelRegistryPath}: duplicate registry entries: ${duplicateRegistryNames.join(', ')}`,
  );

  const missingCliEntries = cliToolNames.filter(commandName => !registry.has(commandName));
  assert(
    missingCliEntries.length === 0,
    `${processFactLevelRegistryPath}: MAIN_TOOLS command(s) missing from registry: ${missingCliEntries.join(', ')}`,
  );

  const unknownCliEntries = registryEntries
    .filter(entry => !entry.name.startsWith('runtime:'))
    .map(entry => entry.name)
    .filter(name => !name.includes(':'))
    .filter(name => !cliToolNameSet.has(name));
  assert(
    unknownCliEntries.length === 0,
    `${processFactLevelRegistryPath}: CLI registry entry not present in MAIN_TOOLS: ${unknownCliEntries.join(', ')}`,
  );

  const missing = findUninventoriedProcessFactCommands(cliText);
  assert(
    missing.length === 0,
    `CLI schema: process fact command(s) missing from registry: ${missing.join(', ')}`,
  );

  const l0ProcessFactCandidates = cliToolNames
    .filter(isProcessFactCommandName)
    .filter(commandName => registry.get(commandName)?.level === 'L0');
  assert(
    l0ProcessFactCandidates.length === 0,
    `${processFactLevelRegistryPath}: process-fact candidate command(s) cannot be L0: ${l0ProcessFactCandidates.join(', ')}`,
  );

  const l4WithoutGate = levelRegistryEntries
    .filter(entry => entry.level === 'L4')
    .filter(entry => !entry.gateConsumer || entry.gateConsumer.trim().length === 0)
    .map(entry => entry.name);
  assert(
    l4WithoutGate.length === 0,
    `${processFactLevelRegistryPath}: L4 entry must declare gateConsumer: ${l4WithoutGate.join(', ')}`,
  );

  // B-b29e CHK-003: the parallel-decomposition DEV-entry hard gate (machine.ts)
  // reads each story's scope contract before every door into DEV, so the
  // scope-contract L4 facts must register it as a gateConsumer. Reads the actual
  // registration, so removing it from process-fact-levels.ts fails this check.
  for (const commandName of scopeContractParallelDevEntryConsumerCommands) {
    const entry = levelRegistry.get(commandName);
    assert(
      Boolean(entry),
      `${processFactLevelRegistryPath}: scope-contract fact ${commandName} missing from registry`,
    );
    if (!entry) continue;
    assert(
      scopeContractParallelDevEntryConsumerPattern.test(entry.gateConsumer || ''),
      `${processFactLevelRegistryPath}: ${commandName} gateConsumer must name the parallel-decomposition DEV-entry gate (machine.ts parallelDevEntryBlock reads the scope contract before every DEV entry)`,
    );
  }

  // B-b29e F-002: EXCLUSIVITY — only the three scope-contract producer facts may
  // name the parallel-decomposition DEV-entry gate. The presence loop above
  // guards that each producer still names the gate, but does NOT stop a
  // non-producer (e.g. the pure-read scope_contract_check, the Round-1
  // over-registration) from re-adding the edge. Scan EVERY process-fact entry and
  // assert the set that names the gate equals exactly the producer set, so the
  // drift check guards against the very regression it fixed.
  const actualParallelDevEntryConsumers = levelRegistryEntries
    .filter(entry => scopeContractParallelDevEntryConsumerPattern.test(entry.gateConsumer || ''))
    .map(entry => entry.name)
    .sort();
  const expectedParallelDevEntryConsumers = [...scopeContractParallelDevEntryConsumerCommands].sort();
  assert(
    actualParallelDevEntryConsumers.length === expectedParallelDevEntryConsumers.length &&
      actualParallelDevEntryConsumers.every((name, index) => name === expectedParallelDevEntryConsumers[index]),
    `${processFactLevelRegistryPath}: ONLY the scope-contract producer facts (${expectedParallelDevEntryConsumers.join(', ')}) may name the parallel-decomposition DEV-entry gate, but got [${actualParallelDevEntryConsumers.join(', ')}] — a pure-read or unrelated fact must not claim a producer→gate edge the runtime does not have (offending: ${actualParallelDevEntryConsumers.filter(name => !expectedParallelDevEntryConsumers.includes(name)).join(', ') || '(none extra)'}; missing: ${expectedParallelDevEntryConsumers.filter(name => !actualParallelDevEntryConsumers.includes(name)).join(', ') || '(none)'})`,
  );

  assertL4ProducerOrReplacement(levelRegistryEntries, policyByName, configText);

  const missingRuntimeEntries = requiredRuntimeEntries
    .map(entry => entry.name)
    .filter(name => !registry.has(name));
  assert(
    missingRuntimeEntries.length === 0,
    `${processFactLevelRegistryPath}: runtime behavior entry missing: ${missingRuntimeEntries.join(', ')}`,
  );
  for (const expected of requiredRuntimeEntries) {
    const actual = levelRegistry.get(expected.name);
    if (!actual) continue;
    assert(
      actual.level === expected.level,
      `${processFactLevelRegistryPath}: ${expected.name} level drifted: expected ${expected.level}, got ${actual.level}`,
    );
    assert(
      actual.owner === expected.owner,
      `${processFactLevelRegistryPath}: ${expected.name} owner drifted: expected ${expected.owner}, got ${actual.owner}`,
    );
    assert(
      formatProcessFactLevelRegistryEntry(actual) === expected.line,
      `${processFactLevelRegistryPath}: ${expected.name} summary line drifted`,
    );
  }
  assertReviewRunStoryFilesHashContract(registry, levelRegistry);
  assertReviewAssuranceFloorContract(registry, levelRegistry);
  assertDeliveryCheckStoryFilesHashContract(registry, levelRegistry);

  for (const expected of requiredControlledMutationEntries) {
    const actual = levelRegistry.get(expected.name);
    assert(actual, `${processFactLevelRegistryPath}: controlled mutation entry missing: ${expected.name}`);
    if (!actual) continue;
    assert(
      actual.level === expected.level,
      `${processFactLevelRegistryPath}: ${expected.name} must stay ${expected.level}; got ${actual.level}`,
    );
    assert(
      actual.level !== 'L0',
      `${processFactLevelRegistryPath}: ${expected.name} writes or repairs state and must not be L0`,
    );
    assert(
      actual.owner === expected.owner,
      `${processFactLevelRegistryPath}: ${expected.name} owner drifted: expected ${expected.owner}, got ${actual.owner}`,
    );
    assert(
      expected.rationalePattern.test(actual.rationale),
      `${processFactLevelRegistryPath}: ${expected.name} rationale must mention the mutation/repair condition`,
    );
  }

  const findingClusterEntry = levelRegistry.get('finding_cluster');
  const devPhaseToolEntries = extractPhaseToolEntries(configText, 'DEV');
  assert(
    findingClusterEntry?.level === 'L2',
    `${processFactLevelRegistryPath}: finding_cluster must stay L2 metadata maintenance, not gate evidence`,
  );
  // B-a4e3 CHK-005: the deprecated finding_dispatch alias was removed; the unified `dispatch`
  // is granted all-phase via the DEFAULT_PHASE_TOOLS '*' wildcard bucket, so DEV only needs to
  // keep finding_add/finding_cluster in its own bucket here.
  const wildcardPhaseToolEntries = extractPhaseToolEntries(configText, '*');
  assert(
    devPhaseToolEntries.has('finding_add') &&
      devPhaseToolEntries.has('finding_cluster') &&
      wildcardPhaseToolEntries.has('dispatch'),
    'packages/main/src/core/config.ts: DEV phaseTools must keep finding_add/finding_cluster available together with the all-phase dispatch entry',
  );
  assert(
    devPhaseToolEntries.size > 0 && !devPhaseToolEntries.has('bug_report'),
    'packages/main/src/core/config.ts: DEV finding_cluster fix must not allow unrelated bug_report',
  );
}

function formatProcessFactLevelRegistryEntry(entry) {
  const gateSuffix = entry.level === 'L4' && entry.gateConsumer ? ` gate=${entry.gateConsumer}` : '';
  return `- ${entry.name} [${entry.level}] owner=${entry.owner}${gateSuffix}`;
}

function formatProcessFactRegistryEntry(entry) {
  const gateSuffix = entry.consumerGate ? ` gate=${entry.consumerGate}` : '';
  const producerSuffix = entry.producer ? ` producer=${entry.producer}` : '';
  const artifactSuffix = entry.artifact?.path ? ` artifact=${entry.artifact.path}${entry.artifact.signed ? ':signed' : ''}` : '';
  return `- ${entry.name} [${entry.level}/${entry.kind}]${producerSuffix}${gateSuffix}${artifactSuffix}`;
}

function printProcessFactLevelRegistrySummary() {
  const entries = parseProcessFactRegistry();
  const cliCount = entries.filter(entry => !entry.name.startsWith('runtime:') && !entry.name.includes(':')).length;
  const runtimeCount = entries.filter(entry => entry.name.startsWith('runtime:')).length;
  const laneCount = entries.filter(entry => entry.kind === 'reviewer-lane').length;
  const artifactCount = entries.filter(entry => entry.kind === 'artifact' || entry.kind === 'signed-artifact').length;
  const levelCounts = new Map();
  for (const level of ['L0', 'L1', 'L2', 'L3', 'L4']) levelCounts.set(level, 0);
  for (const entry of entries) levelCounts.set(entry.level, (levelCounts.get(entry.level) || 0) + 1);
  const kindCounts = new Map();
  for (const entry of entries) kindCounts.set(entry.kind, (kindCounts.get(entry.kind) || 0) + 1);

  console.log('');
  console.log('Process Fact Registry');
  console.log(`- entries: ${entries.length} (${cliCount} CLI, ${runtimeCount} runtime, ${laneCount} reviewer lanes, ${artifactCount} artifacts)`);
  console.log(`- levels: ${[...levelCounts.entries()].map(([level, count]) => `${level}=${count}`).join(', ')}`);
  console.log(`- kinds: ${[...kindCounts.entries()].sort().map(([kind, count]) => `${kind}=${count}`).join(', ')}`);
  const flowPolicyMeta = new Map(parseFlowFactPolicies().map(policy => [policy.name, policy]));
  const flowPolicyEntries = entries.filter(entry => entry.kind === 'flow-policy').sort((a, b) => a.name.localeCompare(b.name));
  if (flowPolicyEntries.length > 0) {
    console.log('- flow fact policies:');
    for (const entry of flowPolicyEntries) {
      const policyId = entry.name.replace(/^flow-policy:/, '');
      const disposition = flowPolicyMeta.get(entry.name)?.disposition;
      const dispositionSuffix = disposition ? ` -> ${disposition}` : '';
      const artifactSuffix = entry.artifact?.path ? ` -> artifact ${entry.artifact.path}` : '';
      const gateSuffix = entry.consumerGate ? ` -> gate ${entry.consumerGate}` : '';
      console.log(`flow fact policy: ${policyId}${dispositionSuffix}${artifactSuffix}${gateSuffix}`);
    }
  }
  console.log('- registry entries:');
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(formatProcessFactRegistryEntry(entry));
  }
}

function assertFilePatterns(entryName, relPath, patterns) {
  const text = read(relPath);
  for (const pattern of patterns) {
    if (typeof pattern === 'string') {
      assert(text.includes(pattern), `${entryName}: ${relPath} missing "${pattern}"`);
      continue;
    }
    if (pattern.any) {
      assert(
        pattern.any.some(needle => text.includes(needle)),
        `${entryName}: ${relPath} missing ${pattern.label || pattern.any.join(' or ')}`,
      );
      continue;
    }
    if (pattern.regex) {
      assert(pattern.regex.test(text), `${entryName}: ${relPath} missing ${pattern.label || pattern.regex}`);
    }
  }
}

const inventory = [
  {
    name: 'phase advance',
    files: [
      {
        // B-6974 CHK-002: story-advance.ts is a thin public command shell. It
        // delegates the transition to handlers/transition-orchestrator.ts, which
        // owns cwd/actor preflight wiring and phase persistence.
        relPath: 'packages/main/src/handlers/story-advance.ts',
        patterns: [
          { label: 'storyAdvanceHandler/current createStoryAdvanceHandlers', any: ['storyAdvanceHandler', 'createStoryAdvanceHandlers'] },
          'runStoryTransition',
          'renderTransitionResult',
        ],
      },
      {
        // B-6974 CHK-003: transition-orchestrator.ts is now the process-fact
        // owner for story_advance guard wiring, actor lifecycle, phase timing,
        // and DONE pre/post merge sequencing.
        relPath: 'packages/main/src/handlers/transition-orchestrator.ts',
        patterns: [
          'assertCwdInWorktree',
          'actor.getSnapshot().can',
          'runReviewToTestPreflightGate',
          'runValidateGate',
          'runDonePreMergeGate',
          'store.writeStory',
          'applyDoneMergeEffects',
          'actor?.stop()',
        ],
      },
      {
        // B-3fad CHK-003: phase-gate symbols relocated by B-56d3.
        relPath: 'packages/main/src/handlers/phase-gates.ts',
        patterns: [
          'getGuardFailureReason',
          'runReviewCliGates',
          'lattice validate --json',
          'writeTestEvidence',
          'Cannot enter TEST: CLI gate preflight execution error',
          'Cannot enter TEST: lattice validate execution error',
        ],
      },
      {
        relPath: 'packages/main/src/core/machine.ts',
        patterns: ['canStartDev', 'canFinish', 'canEnterInitCheck', 'canPassReview'],
      },
    ],
  },
  {
    name: 'review_run_start',
    files: [
      {
        relPath: 'packages/main/src/handlers/review-run.ts',
        patterns: ['review_run_start', 'resolveReviewRunLane', 'captureReviewRunSnapshot', 'buildReviewRunWorkspaceBinding', 'workspaceBinding', 'signReviewRun', 'writeReviewRuns', 'Review run'],
      },
      {
        relPath: 'packages/main/src/cli-engine.ts',
        patterns: ['review_run_start', 'promptHash: z.string()', 'lane: z.enum'],
      },
    ],
  },
  {
    name: 'finding_add',
    files: [
      {
        relPath: 'packages/main/src/handlers/finding.ts',
        patterns: [
          'finding_add',
          'reviewRunId',
          'assertCurrentReviewRunForEvidence',
          'isPassOnlyReviewFindingRecord',
          { label: 'recordFinding/current findings persistence', any: ['recordFinding', 'data.findings.push'] },
          'normalizeFindingCategory',
          'signFinding',
          'category must be one of',
        ],
      },
      {
        relPath: 'packages/main/src/cli-engine.ts',
        patterns: ['finding_add', 'category: z.enum', "'cleanup'", "'doc-promise-undelivered'", "'doc-code-drift'", "'spec-boundary'"],
      },
    ],
  },
  {
    name: 'flow fact policy',
    files: [
      {
        relPath: 'packages/main/src/core/flow-fact-policy.ts',
        patterns: [
          'FLOW_FACT_POLICIES',
          'PASS_ONLY_REVIEW_FINDING_POLICY',
          'EXPRESS_VERIFICATION_EXEMPTION_MESSAGE',
          'isPassOnlyReviewFindingRecord',
          'express-exempt',
          'review-round-iso-string',
        ],
      },
      {
        relPath: 'packages/main/src/core/process-fact-registry.ts',
        patterns: ['PROCESS_FACT_FLOW_POLICIES', 'FLOW_FACT_POLICIES', 'flow-policy'],
      },
    ],
  },
  {
    // B-3fad CHK-003: prove the Finding.evidenceState REVIEW→TEST gate
    // dimension has a hardcoded fallback. evidenceState is a gate-consumed
    // semantic fact: the canPassReview guard and its getGuardFailureReason
    // mirror both filter blocking findings through isFindingBlocking, which
    // applies isEvidenceStateBlocking (verified or legacy missing-field blocks;
    // suspected/disproven are advisory).
    name: 'finding evidenceState gate dimension',
    files: [
      {
        relPath: 'packages/main/src/core/advisory.ts',
        patterns: ['isEvidenceStateBlocking', 'isFindingBlocking', 'FINDING_EVIDENCE_STATES', 'isFindingEvidenceState'],
      },
      {
        relPath: 'packages/main/src/core/machine.ts',
        patterns: ['isFindingBlocking', 'evidenceState'],
      },
      {
        relPath: 'packages/main/src/core/types.ts',
        patterns: ['evidenceState', 'FindingEvidenceState', 'uncertaintyReason', 'disprovenEvidence'],
      },
    ],
  },
  {
    // B-3fad CHK-003: prove the gap_log manual archival entry has a hardcoded
    // fallback. gap_log archives a framework gap into B-META-framework-audit as
    // a suspected finding; runtime category/severity narrowing, the required
    // source/evidence gate, the verified guardrail, and ensureMetaStory
    // bootstrap are all enforced in the handler, not just Zod.
    name: 'gap_log',
    files: [
      {
        relPath: 'packages/main/src/handlers/gap-log.ts',
        patterns: ['gap_log', 'createGapLogHandlers', 'isGapLogCategory', 'isGapLogSeverity', 'ensureMetaStory', 'appendGapFinding', 'evidenceState'],
      },
      {
        relPath: 'packages/main/src/core/audit-meta-store.ts',
        patterns: ['ensureMetaStory', 'appendGapFinding', 'META_STORY_ID'],
      },
      {
        relPath: 'packages/main/src/registry.ts',
        patterns: ['createGapLogHandlers'],
      },
    ],
  },
  {
    name: 'review_pass_set',
    files: [
      {
        relPath: 'packages/main/src/handlers/finding.ts',
        patterns: ['review_pass_set', 'reviewRunId', 'assertCurrentReviewRunForEvidence', 'signReviewPass', { label: 'persistReviewPass/current durable write-read', any: ['persistReviewPass', 'writeReviewPasses'] }, 'withReviewPassLock', 'Review pass'],
      },
      {
        relPath: 'packages/main/src/cli-engine.ts',
        patterns: ['review_pass_set', 'reviewRunId: z.string()', 'note: z.string()'],
      },
    ],
  },
  {
    name: 'verification evidence',
    files: [
      {
        relPath: 'packages/main/src/handlers/checklist.ts',
        patterns: ['verification_evidence_add', 'verification_evidence_batch_add', 'normalizeEvidence', 'makeEvidence', 'evidenceHashes'],
      },
      {
        relPath: 'packages/main/src/core/verification.ts',
        patterns: ['getBlockingVerificationEvidenceIssues', 'makeEvidence'],
      },
      {
        relPath: 'packages/main/src/core/machine.ts',
        patterns: ['getBlockingVerificationEvidenceIssues', 'checklistAllDone'],
      },
    ],
  },
  {
    name: 'init check',
    files: [
      {
        relPath: 'packages/main/src/handlers/init-check.ts',
        patterns: ['init_check_set', 'computeBackgroundHash', 'computeChecklistHash'],
      },
      {
        relPath: 'packages/main/src/core/init-check-gate.ts',
        patterns: ['INIT_CHECK_SALT', 'signInitCheck', 'recomputeInitCheckHash', 'missingRequiredInitCheckAgents', 'blockingInitCheckIssues'],
      },
      {
        relPath: 'packages/main/src/core/machine.ts',
        patterns: ['canEnterInitCheck', 'missingRequiredInitCheckAgents', 'blockingInitCheckIssues'],
      },
    ],
  },
  {
    name: 'scope anti-expansion',
    files: [
      {
        relPath: 'packages/main/src/core/machine.ts',
        patterns: [
          'evaluateScopeAntiExpansionGate',
          'getScopeAntiExpansionGuardFailureReason',
          'evaluateScopeFreeze',
          'digestScopeFreezeCheck',
          'missing_scope_boundary',
          'scope_freeze_check_stale',
          'excluded_keyword',
          'repeat_discarded_direction',
        ],
      },
      {
        relPath: 'packages/main/src/handlers/story-create.ts',
        patterns: [
          'assertStoryCreateExplicitExcludes',
          'scanExcludedKeywordHits',
          'excluded_keyword_in_story_create',
          'story_create cannot directly create INIT_CHECK stories',
          "created from draft '${draftName}' (INIT)",
        ],
      },
      {
        relPath: 'packages/main/src/handlers/checklist.ts',
        patterns: [
          'assertChecklistScopeChangeAllowed',
          'effectiveExcludedKeywords',
          'excluded_keyword_in_checklist',
          'INIT_REVIEWER_CHECKLIST_MUTATION_BLOCKED_AGENTS',
          'init_reviewer_checklist_mutation_blocked',
          'scope_extension_proposal',
        ],
      },
      {
        relPath: 'packages/main/src/handlers/story-query.ts',
        patterns: [
          'INIT_REVIEWER_STORY_SCOPE_MUTATION_BLOCKED_AGENTS',
          'storyLevelScopeMutations',
          'init_reviewer_story_scope_mutation_blocked',
          'scope_extension_proposal',
        ],
      },
      {
        relPath: 'packages/main/src/handlers/scope-anti-expansion.ts',
        patterns: [
          'allowedPaths: args.allowedPaths',
          'excludedPaths: [...normalizeBoundaryArray(args.blockedPaths), ...normalizeBoundaryArray(args.excludedPaths)]',
          'proposal: args.proposal',
        ],
      },
      {
        relPath: 'packages/main/src/core/scope-anti-expansion.ts',
        patterns: [
          'scopeBoundary.allowed must include at least one non-empty entry',
          'executionBoundary must include at least one allowed or excluded command/tool/path entry',
          'proposalTextHash: proposalTextDigest(proposalText)',
        ],
      },
      {
        relPath: 'packages/main/src/cli-engine.ts',
        patterns: [
          'allowedScope: z.array(z.string().min(1)).min(1)',
          'allowedPaths: z.array(z.string().min(1)).optional()',
          'excludedPaths: z.array(z.string().min(1)).optional()',
          'INIT reviewer lanes may not directly change requirement definitions.',
          'INIT reviewer lanes may not directly change story-level scope fields.',
        ],
      },
      {
        relPath: 'packages/main/src/core/command-policy.ts',
        patterns: [
          'INIT reviewer lanes cannot edit story title/description/source/depends',
          'INIT reviewer lanes cannot edit title/context/excludes',
          'must use scope_extension_proposal',
        ],
      },
      {
        relPath: 'packages/main/src/handlers/worktree.ts',
        patterns: ['getScopeAntiExpansionGuardFailureReason', 'buildScopeDiscardDigestEntry', 'discard digest recorded'],
      },
      {
        relPath: 'packages/main/src/core/process-fact-registry.ts',
        patterns: ['scope-boundary.json', 'execution-boundary.json', 'scope-freeze-check.json', 'scope-extension-proposals.json', 'scope-discard-digest.json'],
      },
      {
        relPath: 'packages/main/src/core/lifecycle-registry.ts',
        patterns: ['scope-boundary', 'execution-boundary', 'scope-freeze-check', 'scope-extension-proposals', 'scope-discard-digest'],
      },
    ],
  },
  {
    name: 'scope check',
    files: [
      {
        relPath: 'packages/main/src/handlers/scope-check.ts',
        patterns: ['scope_check_save', 'signScopeCheck'],
      },
      {
        relPath: 'packages/main/src/handlers/story-review.ts',
        patterns: ['signScopeCheck', 'scope-check.json', 'scope_check_save'],
      },
    ],
  },
  {
    name: 'delivery check',
    files: [
      {
        relPath: 'packages/main/src/handlers/delivery-check.ts',
        patterns: ['delivery_check_set', 'signDeliveryCheck', 'delivery_waiver_add'],
      },
      {
        relPath: 'packages/main/src/core/machine.ts',
        patterns: ['canFinish', 'delivery_waiver_add', 'delivery-check.json'],
      },
    ],
  },
  {
    name: 'REVIEW/TEST/DONE gates',
    files: [
      {
        // B-3fad CHK-003: B-56d3 moved the REVIEW→TEST gate machinery
        // (runReviewCliGates / writeTestEvidence / the `lattice validate --json`
        // gate / the two English `Cannot enter TEST` strings) into phase-gates.ts.
        // story-advance.ts keeps buildDoneChecklist (DONE checklist assembly).
        relPath: 'packages/main/src/handlers/story-advance.ts',
        patterns: ['buildDoneChecklist'],
      },
      {
        relPath: 'packages/main/src/handlers/phase-gates.ts',
        patterns: ['runReviewCliGates', 'lattice validate --json', 'buildDoneChecklist', 'writeTestEvidence', 'Cannot enter TEST: CLI gate preflight execution error', 'Cannot enter TEST: lattice validate execution error'],
      },
      {
        relPath: 'packages/main/src/handlers/review-preflight.ts',
        patterns: ['runReviewCliGates', 'checkCommitAuthor', 'checkConcept', 'checkLint'],
      },
      {
        relPath: 'packages/main/src/core/machine.ts',
        patterns: ['canPassReview', 'canFinish', 'getGuardFailureReason'],
      },
    ],
  },
  {
    name: 'lifecycle registry',
    files: [
      {
        relPath: 'packages/main/src/core/lifecycle-registry.ts',
        patterns: ['ACTIVE_LIFECYCLE_PHASES', 'LIFECYCLE_TRANSITIONS', 'PHASE_EVENT_BY_TARGET', 'CWD_GATED_LIFECYCLE_PHASES', 'LEGACY_LIFECYCLE_PHASE_ALIASES'],
      },
      {
        relPath: 'packages/main/src/core/phase-flow.ts',
        patterns: ['ACTIVE_LIFECYCLE_PHASES', 'lifecycleForwardTransitionsByPhase', 'normalizeLifecyclePhase'],
      },
      {
        relPath: 'packages/main/src/handlers/context.ts',
        patterns: ['PHASE_EVENT_BY_TARGET', 'CWD_GATED_LIFECYCLE_PHASES'],
      },
      {
        relPath: 'packages/main/src/tasks/flow-stability-smoke.ts',
        patterns: ['assertLifecycleRegistryConsistency', 'Lifecycle registry mismatch', 'assertStoryAdvanceTestGateFailClosedContracts'],
      },
    ],
  },
  {
    name: 'CLI schema',
    files: [
      {
        relPath: 'packages/main/src/cli/command-catalog.ts',
        patterns: ['MAIN_TOOLS', 'review_run_start', 'finding_add', 'review_pass_set', 'verification_evidence_add', 'init_check_set', 'scope_check_save', 'delivery_check_set', 'lifecycle_check'],
      },
      {
        relPath: 'packages/main/src/core/config.ts',
        patterns: ['DEFAULT_PHASE_TOOLS', 'isCommandAllowed', 'review_run_start', 'finding_add', 'review_pass_set', 'delivery_check_set'],
      },
    ],
  },
];

console.log('Process Fact Contract');
console.log('Prompt guides; CLI/handler/gate decides');
console.log('');
console.log('Scope: process facts only — phase/state transitions, pass/no-issue confirmations, findings/categories/roles, and evidence/check artifacts.');
console.log('Out of scope: ordinary explanatory prose, narrative rationale, and benign Claude/Codex wording differences that do not alter commands or artifact paths.');
console.log('');

const promptMap = new Map();
let reviewerPromptCount = 0;
for (const dir of promptDirs) {
  for (const relPath of listMarkdown(dir)) {
    const text = read(relPath);
    promptMap.set(relPath, text);
    for (const issue of scanReviewRoundPromptSchema(text, relPath)) fail(issue);
    if (!isReviewerPrompt(relPath, text)) continue;
    reviewerPromptCount += 1;
    for (const issue of scanPromptText(text, relPath)) fail(issue);
  }
}
for (const dir of promptDirs) {
  for (const fileName of requiredReviewerRunIdPromptFiles) {
    assert(
      promptMap.has(`${dir}/${fileName}`),
      `${dir}/${fileName}: reviewer-facing prompt must be included in prompt drift scan`,
    );
  }
}
comparePromptSemantics(promptMap);
assertSyntheticAdversarialChecks();
for (const relPath of [
  'packages/main/src/cli-engine.ts',
  commandPolicyPath,
  processFactLevelRegistryPath,
  processFactRegistryPath,
  flowFactPolicyPath,
]) {
  for (const issue of scanCliMachineFactNames(read(relPath), relPath)) fail(issue);
}
for (const issue of scanCodeLikeStringArrayConst(
  read('packages/main/src/core/background-validator.ts'),
  'packages/main/src/core/background-validator.ts',
  'BACKGROUND_SECTION_IDS',
)) fail(issue);
assertActiveLifecycleDocGuidance();
assertReviewRoundIsoDocs();
assertEvidenceBoundaryDocs();
assertPromptEvidenceBoundaries(promptMap);
assertProofStoryProgressiveBoundary();
assertProofStoryGateConsumedFacts();
assertProcessFactCommandInventory();
await assertLifecycleArtifactScopePolicy();
assertStrengtheningRoadmapGovernanceLedger();
printProcessFactLevelRegistrySummary();

console.log(`Prompt drift scan: ${reviewerPromptCount} reviewer prompt files checked`);
if (warnings.length) {
  console.log('Warnings:');
  for (const message of warnings.sort()) console.log(`- ${message}`);
}
console.log('');
console.log('Process Fact Inventory');
for (const entry of inventory) {
  console.log(`- ${entry.name}`);
  for (const file of entry.files) {
    assertFilePatterns(entry.name, file.relPath, file.patterns);
    console.log(`  ${file.relPath}`);
  }
}

if (failures.length) {
  console.error('');
  console.error('Process fact contract failed:');
  for (const message of failures.sort()) console.error(`- ${message}`);
  process.exit(1);
}

console.log('');
console.log('Process fact contract verified');
