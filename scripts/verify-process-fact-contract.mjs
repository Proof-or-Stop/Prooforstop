#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { checkSharedDoneAdapterSources, runSharedDonePredicateProof } from '../packages/main/tests/red/red-done-shared-predicates.mjs';

const root = process.cwd();
// --quiet suppresses only the verbose listings (registry entries, inventory
// file paths). Verification logic and asserted literals are unchanged; the
// default (no flag) output stays byte-identical.
const quiet = process.argv.slice(2).includes('--quiet');
const failures = [];
const readonlyLaneSources = ['packages/main/src/core/managed-review-lane.ts','packages/main/src/core/managed-review-lane-build.mjs','packages/main/src/core/managed-review-lane-policy.ts'];
for (const path of readonlyLaneSources) if (!existsSync(join(root,path))) failures.push(`Missing managed readonly source ${path}`);
const readonlyManagedSource=readFileSync(join(root,'packages/main/src/core/managed-host-run.ts'),'utf8');
const crossHostReadonlySource=readFileSync(join(root,'packages/main/src/handlers/cross-host-review.ts'),'utf8');
if (!readonlyManagedSource.includes('verifyManagedReviewLane(spec.crossHostReadonlyLane, expected)')
  || !readonlyManagedSource.includes('crossHostReadonlyLane = await createManagedReviewLane')
  || !crossHostReadonlySource.includes('prepareManagedSingletonAdmission')
  || !crossHostReadonlySource.includes('!requestedManagedRunId')) failures.push('Cross-host readonly lane requires sealed worker verification and fresh-run pre-snapshot preflight');
if (!readonlyManagedSource.includes('verifyManagedReviewLane(scratch.readonlyLane, scratch)')
  || !readonlyManagedSource.includes('readonlyLane: await createManagedReviewLane')) failures.push('Managed readonly source/build binding must be sealed and consumed');
if (!readFileSync(join(root,'packages/main/src/core/process-fact-registry.ts'),'utf8').includes('runtime:managed_review_readonly_build')) failures.push('Managed readonly build process semantics must be registered');

const warnings = [];
const hanCharacterPattern = /[\u3400-\u9fff]/;
const codeLikeCommandNamePattern = /^[a-z][a-z0-9_.-]*(?::[a-z][a-z0-9_.-]*)*$/;
const artifactFactNamePattern = /^artifact:[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/;

// B-cc10: resolve the codex adapter agents dir instead of hardcoding the deprecated
// spelling. With the old name, all 23 prompt mirrors read as "missing; no semantic drift
// comparison available", so this contract failed and took several dependent smokes with it.
const CODEX_AGENTS_DIR = '.proof-or-stop-codex/agents';

// Only current canonical assets and lane identities satisfy this contract.
function canonicalRoleId(roleId) {
  return String(roleId).replace(/\.md$/, '');
}

function capabilityMaterialContractErrors(source) {
  const errors = [];
  const requirePattern = (pattern, label) => { if (!pattern.test(source)) errors.push(label); };
  requirePattern(/value\.schemaVersion !== CAPABILITY_RELEASE_SCHEMA_VERSION/u, 'canonical schema rejection');
  requirePattern(/options\.requireCurrentWrite \|\| value\.changedPathsScope !== undefined/u, 'current-write and unknown-marker rejection');
  requirePattern(/value\.changedPathsScope === 'capability-material'[\s\S]*selectArtifactReleasePathsV1\(paths\)/u, 'marked subset validation');
  requirePattern(/computeCapabilityDigest\(value\.capabilityId,[\s\S]*paths, value\.artifactSetDigest[\s\S]*value\.capabilityDigest !== expectedDigest/u, 'marked digest integrity');
  requirePattern(/capabilityPaths\.some\(path => !fullChangedPaths\.has\(path\)\)/u, 'actual full-input subset binding');
  requirePattern(/changedPathsScope: 'capability-material',\s*changedPaths: capabilityPaths/u, 'current builder material-only output');
  const append = source.slice(source.indexOf('export function appendCapabilityReleaseRecord('));
  const validation = append.indexOf('capabilityReleaseRecordValidationErrors(record, { requireCurrentWrite: true })');
  const lookup = append.indexOf('const existing =');
  if (validation < 0 || lookup < 0 || validation > lookup) errors.push('current-write validation before idempotency');
  return errors;
}

function assertCapabilityMaterialContract() {
  const path = 'packages/main/src/core/capability-release.ts';
  const source = read(path);
  for (const error of capabilityMaterialContractErrors(source)) fail(`${path}: ${error}`);
  const mutations = [
    ['options.requireCurrentWrite || value.changedPathsScope !== undefined', 'false'],
    ['selectArtifactReleasePathsV1(paths)', 'paths'],
    ['value.capabilityDigest !== expectedDigest', 'false'],
    ['capabilityPaths.some(path => !fullChangedPaths.has(path))', 'false'],
    ['changedPaths: capabilityPaths', 'changedPaths: opts.changedPaths'],
    ['value.schemaVersion !== CAPABILITY_RELEASE_SCHEMA_VERSION', 'false'],
  ];
  for (const [before, after] of mutations) {
    assert(source.includes(before) && capabilityMaterialContractErrors(source.replace(before, after)).length > 0,
      `${path}: capability material contract mutation escaped: ${before}`);
  }
  const appendStart = source.indexOf('export function appendCapabilityReleaseRecord(');
  const appendMutation = source.slice(0, appendStart) + source.slice(appendStart).replace('requireCurrentWrite: true', 'requireCurrentWrite: false');
  assert(capabilityMaterialContractErrors(appendMutation).length > 0, `${path}: append current-write bypass escaped`);
  const entry = parseRegistryArrayEntriesFromSource(read(processFactRegistryPath), 'PROCESS_FACT_ARTIFACTS')
    .find(entry => entry.name === 'artifact:.proof-or-stop/capability-releases.jsonl');
  assert(entry?.kind === 'artifact' && entry.level === 'L1' && entry.semantics.includes('schema-contract')
    && /gateEvidence:\s*false/u.test(entry.block) && /capability-material/u.test(entry.rationale),
  `${processFactRegistryPath}: capability material boundary must remain non-authoritative and registered`);
  const doc = read('docs/requirements/decisions/product-capability-release-playbook-lineage-execution-plan.md');
  assert(/changedPathsScope/u.test(doc) && /capability-material/u.test(doc) && /before.*idempotency/u.test(doc),
    'capability execution plan must describe current material-only writes and before-idempotency validation');
}

function rolePromptPath(directory, roleId) {
  return `${directory}/${canonicalRoleId(roleId)}.md`;
}

function reviewerLaneEntry(registry, roleId) {
  return registry.get(`reviewer-lane:${canonicalRoleId(roleId)}`);
}

const promptDirs = [
  'packages/main/templates/agents',
  '.claude/agents',
  CODEX_AGENTS_DIR,
];

const currentCategories = new Set(['happy', 'edge', 'adversarial', 'missing']);
const legacyCategories = new Set(['cleanup', 'doc-promise-undelivered', 'doc-code-drift', 'spec-boundary']);
const reviewPassReviewerPrompts = new Set([
  'proof-or-stop-evaluator.md',
  'proof-or-stop-review-behavior.md',
  'proof-or-stop-review-channel.md',
  'proof-or-stop-review-concept.md',
  'proof-or-stop-review-delivery.md',
  'proof-or-stop-review-docs.md',
  'proof-or-stop-review-quality.md',
  'proof-or-stop-review-scope-plan.md',
  'proof-or-stop-review-story-init.md',
  'proof-or-stop-review-test-coverage.md',
]);
const requiredReviewerRunIdPromptFiles = new Set([
  'proof-or-stop-evaluator.md',
  'proof-or-stop-review-delivery.md',
  'proof-or-stop-review-scope-plan.md',
  'proof-or-stop-review-story-init.md',
]);
const modularReviewerBootstrapFiles = new Set([
  'proof-or-stop-review-behavior.md',
  'proof-or-stop-review-concept.md',
  'proof-or-stop-review-docs.md',
  'proof-or-stop-review-quality.md',
  'proof-or-stop-review-test-coverage.md',
]);
const processFactLevelRegistryPath = 'packages/main/src/core/process-fact-levels.ts';
const commandPolicyPath = 'packages/main/src/core/command-policy.ts';
const flowFactPolicyPath = 'packages/main/src/core/flow-fact-policy.ts';
const lifecycleRegistryPath = 'packages/main/src/core/lifecycle-registry.ts';
const machinePath = 'packages/main/src/core/machine.ts';
const doneOraclePath = 'packages/main/src/core/done-oracle.ts';
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
const verificationReceiptModelPaths = [
  'docs/requirements/decisions/verification-execution-receipt-fanout-and-input-scoped-freshness.md',
  'packages/main/src/core/process-fact-levels.ts',
  'packages/main/src/core/runtime-fact-registry.ts',
  'packages/main/src/core/types.ts',
  'packages/main/src/tasks/certification-window-smoke.ts',
  'packages/main/src/tasks/verification-run-and-guard-smoke.ts',
];
const bundleV3SubjectPattern = String.raw`(?:VerificationReceiptBundleV3|Bundle\s*V3|V3\s+(?:receipt\s+)?bundle)`;
const positiveCurrentBundleV3Patterns = [
  new RegExp(String.raw`\b${bundleV3SubjectPattern}\b[^.!?;]{0,180}\b(?:is|remains|continues\s+to\s+be|serves\s+as)\s+(?:still\s+)?(?:the\s+)?(?:current|authoritative|admissible|eligible)\b`, 'i'),
  new RegExp(String.raw`\b${bundleV3SubjectPattern}\b[^.!?;]{0,180}\b(?:can|may)\s+(?:still\s+)?(?:satisfy\s+lifecycle\s+admission|authorize\s+reuse)\b`, 'i'),
  new RegExp(String.raw`\b(?:current|authoritative|admissible)\s+(?:receipt\s+)?bundle\b[^.!?;]{0,100}\b(?:is|remains)\s+(?:still\s+)?(?:the\s+)?${bundleV3SubjectPattern}\b`, 'i'),
];
// B-cdf6 CHK-005: the validate-command term follows the renamed canonical bin. Every doc in
// activeLifecycleDocPaths is an ACTIVE doc that tells a reader what to run now, so per
// docs/requirements/decisions/brand-rename-mapping.md it is RENAMED, not frozen. The assertion is
// unchanged in strength — each doc must still literally contain each term, so dropping the
// validate guidance from a lifecycle doc still fails.
const activeLifecycleDocCurrentTerms = [
  'verificationIntent',
  'verificationEvidence',
  'proof-or-stop validate',
  'checklist_update',
];
const legacyCommandDocContextPattern = /\blegacy\b|\bcompat\b|\bmaintenance\b|兼容|维护|旧|迁移|背景|destructive/i;
const legacyAliasDocContextPattern = /\blegacy\b|\balias\b|\bcompat\b|\bmaintenance\b|兼容|维护|旧|迁移|背景|别名|destructive/i;
const coverageReviewerLaneName = 'proof-or-stop-review-test-coverage';
const coverageReviewerLaneNames = [coverageReviewerLaneName, 'lattice-review-test-coverage'];
const coverageReviewerLaneContextPattern = /reviewer|agent|lane|review\s+lane|coverage\s+reviewer|审查员|审查\s*lane|审查\s*通道|覆盖审查/i;
const coverageReviewerCliCommandPatterns = [
  { label: 'CLI invocation', pattern: /\bproof-or-stop\s+proof-or-stop-review-test-coverage\b/i },
  { label: 'tool table row', pattern: /^\s*\|\s*`?proof-or-stop-review-test-coverage`?\s*\|/ },
  { label: 'tool bullet', pattern: /^\s*[-*]\s*`?proof-or-stop-review-test-coverage`?\s*(?:[:：-]|$)/ },
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
const storyRuntimeAdmissionPath = 'packages/main/src/cli/story-runtime-admission.ts';
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
  'host-availability-probe',
  'host-verdict',
  'reviewer-lane',
  'signed-artifact',
  'artifact',
]);
const requiredProcessFactSemantics = {
  finding_progress_predecessor: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_identity_confirm: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_identity_query: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_supersession_add: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_identity_supersede: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_history_query: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_identity_scorecard: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_history_recall: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_route_accept: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_route_reject: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_route_revoke: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_route_verify: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_candidate_route: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_progress_capture: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_candidate_add: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_candidate_get: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_candidate_merge: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_candidate_disprove: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_candidate_promote: ['schema-contract', 'signed-artifact', 'atomic-persistence', 'normalization-policy'],
  finding_ledger_query: ['schema-contract', 'signed-artifact', 'atomic-persistence'],
  finding_runtime_evidence_run: ['atomic-persistence', 'signed-artifact', 'schema-contract'],
  finding_runtime_evidence_verify: ['execution-evidence', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding'],
  validate: ['validation-status', 'validation-result', 'gate-evidence'],
  test_add: ['test-evidence', 'validation-result'],
  test_story: ['test-evidence', 'validation-result'],
  verification_evidence_add: ['schema-contract', 'execution-evidence', 'verification-evidence', 'freshness-policy', 'gate-evidence'],
  verification_evidence_batch_add: ['schema-contract', 'execution-evidence', 'verification-evidence', 'freshness-policy', 'atomic-persistence', 'gate-evidence'],
  verification_evidence_refresh_stale: ['schema-contract', 'execution-evidence', 'verification-evidence', 'freshness-policy', 'atomic-persistence', 'gate-evidence'],
  verification_run: ['schema-contract', 'execution-evidence', 'verification-evidence', 'freshness-policy', 'gate-evidence'],
  verification_intent_append: ['signed-artifact','verification-policy','gate-evidence'],
  review_run_start: ['review-run', 'schema-contract', 'workspace-binding', 'gate-evidence'],
  certification_window_begin: ['artifact', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'blocker-state', 'gate-evidence'],
  certification_window_status: ['artifact', 'signed-artifact', 'blocker-state', 'freshness-policy', 'gate-evidence'],
  certification_window_cancel: ['artifact', 'signed-artifact', 'blocker-state', 'gate-evidence'],
  review_inventory_begin: ['artifact', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'reviewer-lane', 'gate-evidence'],
  review_inventory_status: ['artifact', 'signed-artifact', 'blocker-state', 'freshness-policy', 'gate-evidence'],
  review_inventory_critic_set: ['artifact', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'reviewer-lane', 'review-pass', 'gate-evidence', 'normalization-policy'],
  review_inventory_wave_advance: ['artifact', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'reviewer-lane', 'blocker-state', 'gate-evidence'],
  review_inventory_finalize: ['artifact', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'reviewer-lane', 'no-blocker-evidence', 'gate-evidence'],
  review_inventory_cancel: ['artifact', 'signed-artifact', 'blocker-state', 'gate-evidence'],

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
  autopilot_review_submit: ['host-verdict', 'execution-evidence', 'freshness-policy', 'schema-contract', 'gate-evidence'],
  quorum_submit: ['host-verdict', 'execution-evidence', 'atomic-persistence', 'gate-evidence'],
  decision_doc_proposal: ['schema-contract', 'gate-evidence'],
  decision_doc_save: ['artifact', 'schema-contract', 'execution-evidence', 'gate-evidence'],
  review_escalation_policy_set: ['schema-contract', 'gate-evidence'],
  review_host_availability_probe: ['host-availability', 'execution-evidence', 'freshness-policy', 'schema-contract', 'gate-evidence'],
  review_escalation_fallback_set: ['schema-contract', 'freshness-policy', 'host-availability', 'gate-evidence'],
  story_create_from_repro: ['artifact', 'schema-contract', 'workspace-binding', 'gate-evidence'],
  original_intent_snapshot_set: ['schema-contract', 'gate-evidence'],
  milestone_ledger_set: ['schema-contract', 'verification-policy', 'gate-evidence'],
  milestone_ledger_add: ['schema-contract', 'verification-policy', 'gate-evidence'],
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
  // W2b (B-e10d): the target-binding writer is schema + membership-policy bound
  // but NOT gate-evidence — it is a run prerequisite, not gate-consumed evidence
  // in this leaf (chain freeze / green-confirm digest match are W2c).
  red_evidence_binding_set: ['schema-contract', 'verification-policy'],
  // W2c (B-506e): the two chain-control writers are schema + membership-policy
  // bound but NOT gate-evidence — their v2 records are ignored by the v1 gate
  // predicate and no gate consumes the chain in this leaf (gate rewiring is W3).
  red_evidence_quarantine: ['schema-contract', 'verification-policy'],
  red_evidence_recover: ['schema-contract', 'verification-policy'],
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
};
const requiredRuntimeFactSemantics = {
  'runtime:acceptance_topology_plan_dev_gate': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'workspace-binding', 'verification-policy', 'gate-evidence'],
  'runtime:acceptance_rollout_dev_review_gate': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'verification-policy', 'execution-evidence', 'host-verdict', 'gate-evidence'],
  'runtime:topology_critic_authority_verification': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding', 'reviewer-lane', 'verification-policy'],
  'runtime:evidence_environment_gate_projection': ['runtime-behavior', 'execution-evidence', 'schema-contract', 'normalization-policy', 'freshness-policy', 'verification-policy', 'gate-evidence'],
  // B-7abb binds finite reference normalization to the existing signed launch
  // gate; behavioral positive/negative controls run in the envelope smoke task.
  'runtime:prompt_envelope_review_gate': ['runtime-behavior', 'prompt-envelope', 'schema-contract', 'normalization-policy', 'freshness-policy', 'review-run', 'review-pass', 'gate-evidence'],
  'runtime:prompt_role_body_rollout_gate': ['runtime-behavior', 'prompt-envelope', 'schema-contract', 'reviewer-lane', 'gate-evidence'],
  'runtime:prompt_role_evidence_eligibility_gate': ['runtime-behavior', 'schema-contract', 'reviewer-lane', 'gate-evidence'],
  'runtime:review_run_atomic_persistence_gate': ['runtime-behavior', 'atomic-persistence', 'prompt-envelope', 'review-run', 'gate-evidence'],
  'runtime:review_execution_authority_gate': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'reviewer-lane', 'execution-evidence', 'gate-evidence'],
  'runtime:proof_admissibility_gate_diagnostic': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'gate-evidence'],
  'runtime:verification_execution_assertion_reuse_gate': ['runtime-behavior', 'schema-contract', 'execution-evidence', 'verification-evidence', 'freshness-policy', 'atomic-persistence', 'gate-evidence'],
  'runtime:verification_execution_key_producer_lock': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'execution-evidence', 'atomic-persistence', 'gate-evidence'],
  'runtime:parent_roadmap_totality_claim_consumer': ['runtime-behavior', 'schema-contract', 'verification-policy', 'gate-evidence'],
  'runtime:causal_execution_key_gate': ['runtime-behavior', 'execution-evidence', 'schema-contract', 'workspace-binding', 'freshness-policy', 'verification-policy', 'gate-evidence'],
  'runtime:causal_receipt_import_gate': ['runtime-behavior', 'execution-evidence', 'schema-contract', 'atomic-persistence', 'freshness-policy', 'workspace-binding', 'gate-evidence'],
  'runtime:causal_dependency_preflight_metrics_gate': ['runtime-behavior', 'execution-evidence', 'schema-contract', 'freshness-policy', 'verification-policy', 'gate-evidence'],
};
const requiredReviewerLanes = [
  'proof-or-stop-review-story-init',
  'proof-or-stop-product-reviewer',
  'proof-or-stop-review-scope-plan',
  'proof-or-stop-review-topology-critic',
  'proof-or-stop-review-concept',
  'proof-or-stop-review-quality',
  'proof-or-stop-review-test-coverage',
  'proof-or-stop-review-behavior',
  'proof-or-stop-review-docs',
  'proof-or-stop-review-delivery',
];
const requiredArtifactFacts = [
  { name: 'artifact:index.json', path: 'index.json', signed: false },
  { name: 'artifact:review.json', path: 'review.json', signed: true, signaturePattern: /sha256\(storyId:timestamp:issueCount:blockerCount/ },
  { name: 'artifact:checklist.json', path: 'checklist.json', signed: false },
  { name: 'artifact:prompt-envelopes.json', path: 'prompt-envelopes.json', signed: false },
  { name: 'artifact:init-check.json', path: 'init-check.json', signed: true, signaturePattern: /signInitCheck\/recomputeInitCheckHash/ },
  { name: 'artifact:scope-boundary.json', path: 'scope-boundary.json', signed: true, signaturePattern: /stable scope boundary _hash/ },
  { name: 'artifact:execution-boundary.json', path: 'execution-boundary.json', signed: true, signaturePattern: /stable execution boundary _hash/ },
  { name: 'artifact:scope-freeze-check.json', path: 'scope-freeze-check.json', signed: true, signaturePattern: /freshnessHash/ },
  { name: 'artifact:scope-extension-proposals.json', path: 'scope-extension-proposals.json', signed: true, signaturePattern: /stable proposal _hash/ },
  { name: 'artifact:scope-discard-digest.json', path: 'scope-discard-digest.json', signed: false },
  { name: 'artifact:scope-check.json', path: 'scope-check.json', signed: true, signaturePattern: /signScopeCheck/ },
  { name: 'artifact:delivery-check.json', path: 'delivery-check.json', signed: true, signaturePattern: /signDeliveryCheck\/recomputeDeliveryCheckHash/ },
  { name: 'artifact:review-runs.json', path: 'review-runs.json', signed: true, signaturePattern: /signReviewRun\/verifyReviewRun; .*ReviewRun\.storyFilesHash.*workspaceBinding\.bindingHash.*exact-field allowlists/ },
  { name: 'artifact:review-inventory-epochs.json', path: 'review-inventory-epochs.json', signed: true, signaturePattern: /signReviewInventoryEpoch\/verifyReviewInventoryEpoch.*signReviewInventoryReceipt\/verifyReviewInventoryReceipt.*signReviewInventoryCriticReceipt\/verifyReviewInventoryCriticReceipt/ },
  { name: 'artifact:review-passes.json', path: 'review-passes.json', signed: true, signaturePattern: /signReviewPass\/verifyReviewPass; direct native records seal a registered-broker Ed25519 invocation attestation bound to exact story\/lane\/ReviewRun\/writer\/dispatch\/adapter\/host\/nonce.*envelope-bound records use the versioned envelopeId-inclusive domain.*reviewRunId-inclusive records do not fall back to legacy signatures.*writerSessionId-inclusive records bind writer session provenance/ },
  { name: 'artifact:findings.json', path: 'findings.json', signed: true, signaturePattern: /signFinding\/verifyFinding; direct native records bind category\/evidenceState\/uncertaintyReason\/files\/disprovenEvidence in the signed domain, and reviewRunId-inclusive records do not fall back to legacy signatures/ },
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
  { name: 'artifact:milestone-closeout.json', path: 'milestone-closeout.json', signed: false },
  { name: 'artifact:slice-plan.json', path: 'slice-plan.json', signed: false },
  { name: 'artifact:parent-ledger-rollup.json', path: 'parent-ledger-rollup.json', signed: false },
  { name: 'artifact:closeout-write-receipts.jsonl', path: 'closeout-write-receipts.jsonl', signed: false },
  { name: 'artifact:proofstory.json', path: 'proofstory.json', signed: false },
  { name: 'artifact:topology-exclusion-approvals.json', path: 'topology-exclusion-approvals.json', signed: true, signaturePattern: /Ed25519\(canonical scope-plan approval binding exclusion\/basis\/topology\/scope\/story\/closure\/provenance\)/ },
  { name: 'artifact:topology-critic-receipt.json', path: 'topology-critic-receipt.json', signed: true, signaturePattern: /Ed25519\(canonical critic receipt binding role\/provenance\/basis\/topology\/scope\/story\/closure\/findings\/exclusions\/verdict\/time\)/ },
  { name: 'artifact:acceptance-rollout-report.json', path: 'acceptance-rollout-report.json', signed: true, signaturePattern: /Ed25519\(canonical verifier-derived report binding frozen membership\/source inventory\/window\/thresholds\/verdict\/workspace\/full-3x2\)/ },
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
    patterns: [/(?:proof-or-stop|proofOrStop|koala) validate --story=<storyId>/, /verificationEvidence/, /dryRun/, /confirm/, /git restore\/git clean/],
  },
  test_story: {
    destructiveRisk: 'fixture-write',
    patterns: [/(?:proof-or-stop|proofOrStop|koala) validate --story=<storyId>/, /verification_evidence_add|verificationEvidence/],
  },
  test_fixture: {
    destructiveRisk: 'fixture-write',
    patterns: [/project-native command|(?:proofOrStop|koala) validate --story=<storyId>/, /verification_evidence_add|verificationEvidence/],
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
    // B-137a: absence of a managed receipt is not proof of native execution.
    // Direct evidence needs a registered broker invocation attestation; the
    // path revalidates the exact provider proposal through intake/replay/gate.
    name: 'runtime:review_execution_authority_gate',
    level: 'L4',
    owner: 'core/native-review-attestation + core/native-review-evidence + core/managed-review-evidence + core/review-run',
    line: '- runtime:review_execution_authority_gate [L4] owner=core/native-review-attestation + core/native-review-evidence + core/managed-review-evidence + core/review-run gate=storyMachine.canPassReview REVIEW to TEST gate through collectReviewerEvidenceState shared revalidation',
  },
  {
    // B-5a15: causal execution admission is producer-bound signed preflight,
    // not caller-authored identity text; keep the gate-consumer summary line
    // stable while mechanically checking the strengthened rationale.
    name: 'runtime:causal_execution_key_gate',
    level: 'L4',
    owner: 'core/causal-evidence',
    line: '- runtime:causal_execution_key_gate [L4] owner=core/causal-evidence gate=verification_evidence_add / verification_evidence_batch_add execution and verification coverage freshness gates',
    rationaleTokens: ['producer-bound', 'Ed25519-signed preflight', 'current lease/index/identity', 'bounded batch snapshot'],
  },
  {
    // B-5a15: canonical import trusts only durable Ed25519 CAS receipts and
    // fresh lease/index/identity checks; commit retry cannot become a rerun.
    name: 'runtime:causal_receipt_import_gate',
    level: 'L4',
    owner: 'core/causal-evidence + core/store',
    line: '- runtime:causal_receipt_import_gate [L4] owner=core/causal-evidence + core/store gate=verification evidence canonical import and verification coverage/freshness gates',
    rationaleTokens: ['durable CAS receipt', 'registered local Ed25519 authority', 'producer-bound signed preflight facts', 'current lease/index/identity', 'bounded batch snapshot'],
  },
  {
    // B-5a15: dependency admission is identity-bound and accepts signed rerun
    // evidence only; raw rerunNodeIds remain compatibility input, not proof.
    name: 'runtime:causal_dependency_preflight_metrics_gate',
    level: 'L4',
    owner: 'core/causal-evidence + core/evidence-freshness',
    line: '- runtime:causal_dependency_preflight_metrics_gate [L4] owner=core/causal-evidence + core/evidence-freshness gate=specialized verification freshness consumer, CertificationWindow, validation preflight, and closeout metrics',
    rationaleTokens: ['producer-bound dependency decisions', 'durable Ed25519 causal authority', 'Missing or unknown input keys fail closed', 'signed rerun evidence', 'raw rerunNodeIds', 'bounded batch snapshots'],
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
  // B-cdf6 CHK-005: product-name prose follows the renamed canonical form `Proof-or-Stop` (see
  // docs/requirements/decisions/brand-rename-mapping.md, first RENAMED row). The phrase is still
  // pinned in full, so deleting or softening the "cannot mechanically prove isolation" boundary
  // claim from CLAUDE.md / testing-infra.md still fails this check.
  'Proof-or-Stop cannot mechanically prove true subagent context isolation',
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
  /^certification_window_(begin|status|cancel)$/,
  /^review_inventory_(begin|status|critic_set|wave_advance|finalize|cancel)$/,

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

function timeoutWiringFailures(source, sites = [], factories = []) {
    const file = ts.createSourceFile('checklist.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const failures = [];
    if (file.parseDiagnostics.length) {
        return ['checklist source must parse without errors'];
    }
    const expected = new Set([
        'verification_evidence_add', 'verification_evidence_batch_add',
        'verification_run', 'verification_evidence_refresh_stale',
    ]);
    const seen = new Set();
    let declarations = 0;
    let executorCount = 0;
    const named = (node, name) => !!node && ts.isIdentifier(node) && node.text === name;
    const propertyNamed = (node, name) => (ts.isIdentifier(node) || ts.isStringLiteral(node)) && node.text === name;
    const nullishParts = (node) => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ? [...nullishParts(node.left), ...nullishParts(node.right)] : [node];
    const validResolver = (node) => ts.isCallExpression(node)
        && named(node.expression, 'resolvePinnedCommandTimeoutMs')
        && node.arguments.length === 2 && named(node.arguments[0], 'root') && named(node.arguments[1], 'command');
    const validTimeoutProperty = (node) => ts.isPropertyAssignment(node) && propertyNamed(node.name, 'timeoutMs')
        && named(node.initializer, 'effectiveTimeoutMs');
    const visit = (node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === 'resolvePinnedCommandTimeoutMs')
            declarations++;
        if (ts.isCallExpression(node) && named(node.expression, 'createPinnedCommandRunner')) {
            let ancestor = node.parent;
            while (ancestor && !ts.isMethodDeclaration(ancestor))
                ancestor = ancestor.parent;
            const handler = ancestor && ts.isMethodDeclaration(ancestor) ? ancestor : undefined;
            const name = handler?.name.getText(file) ?? '<unknown>';
            const binding = ts.isVariableDeclaration(node.parent) ? node.parent : undefined;
            if (!expected.has(name) || seen.has(name))
                failures.push(`unexpected factory boundary: ${name}`);
            seen.add(name);
            if (!ts.isStringLiteral(node.arguments[0]) || node.arguments[0].text !== name || !named(node.arguments[1], 'args')
                || !binding || !ts.isIdentifier(binding.name) || !ts.isVariableDeclarationList(binding.parent)
                || !(binding.parent.flags & ts.NodeFlags.Const))
                failures.push(`${name}: factory must bind actual caller controls immutably`);
            const uses = [];
            if (handler?.body && binding && ts.isIdentifier(binding.name)) {
                const local = binding.name.text;
                const findUse = (child) => {
                    if (ts.isPropertyAssignment(child) && propertyNamed(child.name, 'runCommand') && named(child.initializer, local))
                        uses.push(child.initializer);
                    if (ts.isShorthandPropertyAssignment(child) && local === 'runCommand' && child.name.text === local)
                        uses.push(child.name);
                    if (name === 'verification_evidence_refresh_stale' && ts.isCallExpression(child) && named(child.expression, local))
                        uses.push(child.expression);
                    ts.forEachChild(child, findUse);
                };
                findUse(handler.body);
            }
            if (uses.length !== 1)
                failures.push(`${name}: producer must consume its guarded runner exactly once`);
            if (binding && uses.length === 1)
                factories.push({ call: node, binding, consumption: uses[0] });
        }
        if (ts.isCallExpression(node) && named(node.expression, 'runSingleAllowlistedCommand')) {
            executorCount++;
            let ancestor = node.parent;
            let scope;
            let handler;
            while (ancestor) {
                if (!scope && ts.isArrowFunction(ancestor))
                    scope = ancestor;
                if (ts.isMethodDeclaration(ancestor)) {
                    handler = ancestor;
                    break;
                }
                ancestor = ancestor.parent;
            }
            let factoryAncestor = node.parent;
            while (factoryAncestor && !(ts.isVariableDeclaration(factoryAncestor) && named(factoryAncestor.name, 'createPinnedCommandRunner')))
                factoryAncestor = factoryAncestor.parent;
            const name = 'createPinnedCommandRunner';
            if (!factoryAncestor)
                failures.push('executor must live inside the guarded shared runner factory');
            if (node.arguments.length !== 3 || !named(node.arguments[0], 'command') || !named(node.arguments[1], 'root')) {
                failures.push(`${name}: executor command and configuration root must match the resolver`);
            }
            const budgets = [];
            let reassigned = false;
            const collect = (child) => {
                if (ts.isVariableDeclaration(child) && named(child.name, 'effectiveTimeoutMs') && child.initializer) {
                    budgets.push(child);
                }
                if (child !== scope?.body && (ts.isArrowFunction(child) || ts.isFunctionExpression(child)))
                    return;
                if (ts.isBinaryExpression(child) && named(child.left, 'effectiveTimeoutMs')
                    && child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && child.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
                    reassigned = true;
                if ((ts.isPrefixUnaryExpression(child) || ts.isPostfixUnaryExpression(child)) && named(child.operand, 'effectiveTimeoutMs')
                    && (child.operator === ts.SyntaxKind.PlusPlusToken || child.operator === ts.SyntaxKind.MinusMinusToken))
                    reassigned = true;
                ts.forEachChild(child, collect);
            };
            if (scope)
                collect(scope.body);
            const budget = budgets.length === 1 ? budgets[0] : undefined;
            if (!budget || !ts.isVariableDeclarationList(budget.parent) || !(budget.parent.flags & ts.NodeFlags.Const) || reassigned) {
                failures.push(`${name}: resolved timeout must be a single immutable binding`);
            }
            const parts = budget?.initializer ? nullishParts(budget.initializer) : [];
            if (!(parts.length >= 2 && parts.length <= 3 && named(parts[0], 'timeoutMs')
                && validResolver(parts[1]) && (parts.length === 2 || named(parts[2], 'DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS')))) {
                failures.push(`${name}: timeout must derive from the caller budget and shared pinned resolver`);
            }
            const options = node.arguments[2];
            const timeoutProperties = [];
            let invalid = false;
            if (options && ts.isObjectLiteralExpression(options)) {
                for (const property of options.properties) {
                    if (ts.isPropertyAssignment(property) && propertyNamed(property.name, 'timeoutMs')) {
                        timeoutProperties.push(property);
                        invalid ||= !validTimeoutProperty(property);
                    }
                    else if (ts.isSpreadAssignment(property)) {
                        const value = ts.isParenthesizedExpression(property.expression) ? property.expression.expression : property.expression;
                        const condition = ts.isConditionalExpression(value) ? value.condition : undefined;
                        if (ts.isConditionalExpression(value) && condition && ts.isBinaryExpression(condition)
                            && named(condition.left, 'effectiveTimeoutMs') && condition.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
                            && named(condition.right, 'undefined') && ts.isObjectLiteralExpression(value.whenTrue)
                            && value.whenTrue.properties.length === 1 && validTimeoutProperty(value.whenTrue.properties[0])
                            && ts.isObjectLiteralExpression(value.whenFalse) && value.whenFalse.properties.length === 0) {
                            timeoutProperties.push(value.whenTrue.properties[0]);
                        }
                        else
                            invalid = true;
                    }
                }
            }
            if (invalid || timeoutProperties.length !== 1)
                failures.push(`${name}: executor must receive the resolved timeout`);
            const controls = [];
            for (const key of ['abortSignal', 'deadlineAt', 'deadlineError']) {
                const matches = options && ts.isObjectLiteralExpression(options)
                    ? options.properties.filter((p) => ts.isPropertyAssignment(p) && propertyNamed(p.name, key)) : [];
                if (matches.length !== 1 || !ts.isPropertyAccessExpression(matches[0].initializer)
                    || !named(matches[0].initializer.expression, 'controls') || !named(matches[0].initializer.name, key)) {
                    failures.push(`${name}: executor must preserve caller ${key}`);
                }
                else
                    controls.push(matches[0]);
            }
            if (budget && timeoutProperties.length === 1)
                sites.push({ call: node, budget, property: timeoutProperties[0], controls });
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    if (executorCount !== 1)
        failures.push('exactly one shared execution boundary is required');
    if (declarations !== 1)
        failures.push('the shared pinned timeout resolver must have exactly one declaration');
    for (const name of expected)
        if (!seen.has(name))
            failures.push(`missing execution boundary: ${name}`);
    return failures;
}
function assertEvidenceFactoryWiring(checklistSource) {
    const check = (name, ok) => assert(ok, name);
    const sites = [];
    const factories = [];
    const wiringFailures = timeoutWiringFailures(checklistSource, sites, factories);
    check(`all evidence execution boundaries preserve configured timeouts: ${wiringFailures.join('; ')}`, wiringFailures.length === 0);
    check('an additional non-executing resolver call does not invalidate execution wiring', timeoutWiringFailures(checklistSource + '\nconst extraCacheIdentity = resolvePinnedCommandTimeoutMs(root, command);').length === 0);
    check('malformed source fails closed', timeoutWiringFailures(checklistSource + '\nfunction {').length > 0);
    const replaced = (node, replacement) => checklistSource.slice(0, node.getStart()) + replacement + checklistSource.slice(node.end);
    check('one shared executor and all four factory consumers are covered', sites.length === 1 && factories.length === 4);
    for (const [index, site] of factories.entries()) {
        check(`factory ${index + 1} cannot lose caller watchdog controls`, timeoutWiringFailures(replaced(site.call.arguments[1], '{}')).length > 0);
        check(`factory ${index + 1} cannot claim another command identity`, timeoutWiringFailures(replaced(site.call.arguments[0], "'unrelated_writer'")).length > 0);
        check(`factory ${index + 1} must be the actual producer runner`, timeoutWiringFailures(replaced(site.consumption, 'unguardedRunner')).length > 0);
    }
    for (const [index, site] of sites.entries()) {
        for (const control of site.controls) {
            check(`shared runner cannot drop ${control.name.getText()}`, timeoutWiringFailures(replaced(control.initializer, 'undefined')).length > 0);
        }
        check(`negative control catches constant timeout at execution boundary ${index + 1}`, timeoutWiringFailures(replaced(site.property.initializer, '270000')).length > 0);
        check(`negative control catches omitted timeout at execution boundary ${index + 1}`, timeoutWiringFailures(replaced(site.property.name, 'unrelatedBudget')).length > 0);
        for (const argument of site.call.arguments.slice(0, 2)) {
            check(`negative control catches mismatched command or root at execution boundary ${index + 1}`, timeoutWiringFailures(replaced(argument, 'unrelatedIdentity')).length > 0);
        }
        const mutable = replaced(site.budget.parent, site.budget.parent.getText().replace(/^const\b/, 'let'));
        check(`negative control catches mutable timeout at execution boundary ${index + 1}`, timeoutWiringFailures(mutable).length > 0);
        const statement = site.budget.parent.parent;
        check(`negative control catches overwritten timeout at execution boundary ${index + 1}`, timeoutWiringFailures(checklistSource.slice(0, statement.end) + '\neffectiveTimeoutMs = 270000;' + checklistSource.slice(statement.end)).length > 0);
    }
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
  let text = readFileSync(absPath, 'utf8');
  const mutation = process.env.PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION;
  const roleId = canonicalRoleId(basename(relPath));
  if (mutation === 'drop-acceptance-basis-prompt' && roleId === 'proof-or-stop-implementer') {
    // B-cc10: accept either brand so the mutation actually drops the live prompt line.
    text = text.replace(/^Acceptance-basis boundary: only `(?:proof-or-stop|proofOrStop) acceptance_basis_generate`.*$/m, '');
  }
  if (mutation === 'story3-promote-query-l4' && relPath === processFactLevelRegistryPath) {
    text = text.replace(
      "name: 'finding_ledger_query', level: 'L0'",
      "name: 'finding_ledger_query', level: 'L4', gateConsumer: 'storyMachine.canPassReview'",
    );
  }
  if (mutation === 'story3-promote-runtime-run-l4' && relPath === processFactLevelRegistryPath) {
    text = text.replace(
      "name: 'finding_runtime_evidence_run', level: 'L2'",
      "name: 'finding_runtime_evidence_run', level: 'L4', gateConsumer: 'storyMachine.canPassReview'",
    );
  }
  if (mutation === 'story3-drop-runtime-freshness' && relPath === processFactRegistryPath) {
    text = text.replace("'execution-evidence', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding'", "'execution-evidence', 'signed-artifact', 'schema-contract', 'workspace-binding'");
  }
  if (mutation === 'story3-forbidden-story2-import' && relPath === 'packages/main/src/handlers/finding-ledger.ts') {
    text += "\nimport { forbiddenStory2Identity } from '../core/finding-identity.js';\n";
  }
  if (mutation === 'story3-forbidden-story1-import' && relPath === 'packages/main/src/handlers/finding-ledger.ts') {
    text += "\nimport { forbiddenStory1Gate } from '../core/finding-applicability-gate.js';\n";
  }
  if (mutation === 'story3-unregistered-direct-consumer' && relPath === 'packages/main/src/core/machine.ts') {
    text += '\nconst forbiddenStory3Consumer = finding_ledger_query({ storyId: "B-X" });\n';
  }
  if (mutation === 'story3-query-path-leak' && relPath === 'packages/main/src/handlers/finding-ledger.ts') {
    text = text.replace(
      '): FindingLedgerQueryResult {',
      '): FindingLedgerQueryResult {\n  const ledgerPath = "/protected/finding-ledger.json";',
    );
  }
  if (relPath === processFactRegistryPath && mutation?.startsWith('story3-promote-record-')) {
    const recordClass = mutation.slice('story3-promote-record-'.length);
    text = text.replace(
      new RegExp(`recordClass: '${recordClass}',([^\\n]+)level: 'L2'`),
      `recordClass: '${recordClass}',$1level: 'L4'`,
    );
  }
  if (mutation === 'drop-acceptance-basis-handler' && relPath === 'packages/main/src/handlers/proofstory.ts') {
    text = text.replace(/acceptance_basis_generate/g, 'basis_generate_removed');
  }
  if (mutation === 'drop-acceptance-topology-prompt' && roleId === 'proof-or-stop-implementer') {
    text = text.replace(/^Acceptance-topology boundary:.*$/m, '');
  }
  if (mutation === 'drop-acceptance-topology-handler' && relPath === 'packages/main/src/handlers/proofstory.ts') {
    text = text.replace(/acceptance_topology_check/g, 'topology_check_removed');
  }
  if (mutation === 'drop-acceptance-topology-gate' && relPath === 'packages/main/src/handlers/transition-orchestrator.ts') {
    text = text.replace(/evaluateAcceptanceTopologyForContext/g, 'topology_gate_removed');
  }
  if (mutation === 'invert-acceptance-topology-polarity' && relPath === 'packages/main/src/handlers/transition-orchestrator.ts') {
    text = text.replace('if (topology.blocking)', 'if (!topology.blocking)');
  }
  if (mutation === 'drop-topology-critic-prompt' && roleId === 'proof-or-stop-review-topology-critic') {
    text = text.replace(/^- A pass is forbidden when the basis.*$/m, '');
  }
  if (mutation === 'drop-topology-critic-handler' && relPath === 'packages/main/src/handlers/proofstory.ts') {
    text = text.replace(/topology_critic_receipt_set/g, 'topology_critic_receipt_removed');
  }
  if (mutation === 'drop-topology-critic-cli-schema' && relPath === 'packages/main/src/cli/command-catalog.ts') {
    text = text.replace(/topology_critic_receipt_set/g, 'topology_critic_receipt_schema_removed');
  }
  if (mutation === 'add-topology-critic-lifecycle-consumer' && relPath === 'packages/main/src/handlers/transition-orchestrator.ts') {
    text += '\n// forbidden Wave 2A lifecycle consumer: evaluateTopologyCriticReceiptForContext; if (!critic.ok) {}\n';
  }
  if (mutation === 'drop-topology-critic-verifier' && relPath === 'packages/main/src/core/topology-critic-receipt.ts') {
    text = text.replace(/verifyTopologyCriticReceipt/g, 'verifyTopologyCriticReceiptRemoved');
  }
  if (mutation === 'weaken-topology-critic-incomplete-basis' && relPath === 'packages/main/src/core/topology-critic-receipt.ts') {
    text = text.replaceAll("context.basisStatus !== 'complete'", "context.basisStatus === 'complete'");
  }
  if (mutation === 'trust-pre-review-raw-claims' && relPath === 'packages/main/src/core/pre-review-check.ts') {
    text = text.replace('const proof = executableProofState', 'const trustedClaims = input.checklist.items.flatMap(item => item.verificationEvidence?.flatMap(evidence => evidence.attestation?.checkedClaims ?? []) ?? []);\n  const proof = executableProofState');
  }
  if (mutation === 'use-planned-self-reference-as-actual' && relPath === 'packages/main/src/core/acceptance-discovery-adapters.ts') {
    text = text.replace('sourceExactSymbolCount(endpoint.expectedFileRef, sourceText, endpoint.expectedSymbolOrFact) === 1', 'sourceText.includes(endpoint.expectedSymbolOrFact)');
  }
  if (mutation === 'accept-global-transcript-proof' && relPath === 'packages/main/src/core/pre-review-check.ts') {
    text = text.replace('const transcriptIds = row.transcriptProofs.map', 'const transcriptIds = proof.bindingProofs.flatMap(item => item.transcriptProofs).map');
  }
  if (mutation === 'allow-arbitrary-pre-review-command' && relPath === 'packages/main/src/core/pre-review-check.ts') {
    text = text.replace('transcript.actual?.command !== PRE_REVIEW_LIVE_PROOF_COMMAND', "typeof transcript.actual?.command !== 'string'");
  }
  if (mutation === 'drop-acceptance-rollout-prompt' && new Set([
    'proof-or-stop-implementer',
    'proof-or-stop-test-case-reviewer',
    'proof-or-stop-review-topology-critic',
    'proof-or-stop-review-concept',
    'proof-or-stop-review-quality',
    'proof-or-stop-review-test-coverage',
    'proof-or-stop-review-docs',
    'proof-or-stop-review-delivery',
  ]).has(roleId)) {
    text = text.replace(/acceptance_rollout_check/g, 'rollout_check_removed');
  }
  if (mutation === 'drop-acceptance-rollout-handler' && relPath === 'packages/main/src/handlers/proofstory.ts') {
    text = text.replace(/acceptance_rollout_report/g, 'rollout_report_removed');
  }
  if (mutation === 'drop-acceptance-rollout-consumer' && relPath === 'packages/main/src/handlers/transition-orchestrator.ts') {
    text = text.replace(/runAcceptanceRolloutGate/g, 'rollout_gate_removed');
  }
  if (mutation === 'weaken-acceptance-rollout-3x2' && relPath === 'packages/main/src/core/acceptance-rollout.ts') {
    text = text.replace("record.quorum.rounds === 3", 'record.quorum.rounds >= 1');
  }
  if (mutation === 'synthetic-story-writer-partial-runtime-admission' && relPath === commandPolicyPath) {
    text = text.replace(
      'export const COMMAND_POLICIES: Record<string, CommandPolicy> = {',
      `export const COMMAND_POLICIES: Record<string, CommandPolicy> = {
  synthetic_story_writer: {
    status: 'supported',
    reason: 'Synthetic mutation: a future Story writer must inherit the shared runtime gate.',
    allowedPhases: 'all',
    ownershipClass: 'storyScopedMutating',
    destructiveRisk: 'metadata-write',
  },`,
    );
  }
  if (mutation === 'synthetic-story-writer-partial-runtime-admission' && relPath === storyRuntimeAdmissionPath) {
    text = text.replace(
      'commandRequiresAuthoritativeRuntime(input.command, input.effectiveOwnership)',
      "input.command === 'story_update'",
    );
  }
  if (mutation === 'omit-dangerous-story-writer-capability' && relPath === commandPolicyPath) {
    text = text.replace("  'story_discard',\n", '');
  }
  if (mutation === 'omit-direct-story-writer-effects' && relPath === commandPolicyPath) {
    for (const command of ['agent_prompt', 'evaluate']) {
      const row = new RegExp(`(${command}: \\{[^\\n]*?)storyWriteEffect: '[^']+', `);
      text = text.replace(row, '$1');
    }
  }
  return text;
}

// ── B-956f FIX 2: STRUCTURAL (AST-anchored) source assertions ──
// codex HIGH: `evaluatorText.includes(token)` passes when a token appears only in
// a comment/import/unused wrapper — commenting out the real delegation while
// keeping the strings kept the verifier green. These helpers parse the TypeScript
// (comments are NOT AST nodes) and assert on REAL call sites inside a specific
// function body, so a commented-out delegation makes the verifier exit 1.
const _sourceFileCache = new Map();
function parseSourceFile(relPath) {
  if (_sourceFileCache.has(relPath)) return _sourceFileCache.get(relPath);
  const sf = ts.createSourceFile(relPath, read(relPath), ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
  _sourceFileCache.set(relPath, sf);
  return sf;
}

/** Locate a top-level function declaration by name; returns the ts.FunctionDeclaration node or undefined. */
function findFunctionDeclaration(sf, name) {
  let found;
  const visit = (node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

/** Set of identifier/property callee names for every CallExpression inside a subtree. */
function collectCalledNames(node) {
  const names = new Set();
  const walk = (n) => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (ts.isIdentifier(e)) names.add(e.text);
      else if (ts.isPropertyAccessExpression(e)) names.add(e.name.text);
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return names;
}

/** True when some PropertyAccessExpression with the given member name appears in a subtree. */
function subtreeReferencesProperty(node, propName) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isPropertyAccessExpression(n) && n.name.text === propName) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** True when a subtree contains an object-literal property `ok: false`. */
function subtreeReturnsFalseOk(node) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'ok'
        && n.initializer.kind === ts.SyntaxKind.FalseKeyword) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** True when a function body contains an `if (…diffEnumerationError…)` whose branch returns ok:false. */
function hasDiffEnumerationBlockingBranch(body) {
  let ok = false;
  const walk = (n) => {
    if (ok) return;
    if (ts.isIfStatement(n)
        && subtreeReferencesProperty(n.expression, 'diffEnumerationError')
        && subtreeReturnsFalseOk(n.thenStatement)) {
      ok = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return ok;
}

/** True when a subtree contains a real binary `<x>.timestamp >= facts.testEntryAt` comparison (F-002: a comment cannot satisfy this — comments are not AST nodes). */
function hasTestEntryAnchoredComparison(body) {
  let ok = false;
  const walk = (n) => {
    if (ok) return;
    if (ts.isBinaryExpression(n)
        && n.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken
        && ts.isPropertyAccessExpression(n.left) && n.left.name.text === 'timestamp'
        && ts.isPropertyAccessExpression(n.right) && n.right.name.text === 'testEntryAt'
        && ts.isIdentifier(n.right.expression) && n.right.expression.text === 'facts') {
      ok = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return ok;
}

/** True when a subtree contains a ThrowStatement. */
function subtreeThrows(node) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isThrowStatement(n)) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** True when a function body contains an `if` whose CONDITION references the given property and whose then-branch throws (F-003: adapts hasDiffEnumerationBlockingBranch; a dead-code reference outside the throwing branch cannot satisfy this). */
function hasPropertyGuardedThrowingBranch(body, propName) {
  let ok = false;
  const walk = (n) => {
    if (ok) return;
    if (ts.isIfStatement(n)
        && subtreeReferencesProperty(n.expression, propName)
        && subtreeThrows(n.thenStatement)) {
      ok = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return ok;
}

/** True when a function body contains an object-literal property with the given name. */
function bodyHasObjectPropertyNamed(body, propName) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    const isNamed = (name) => (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === propName;
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && isNamed(n.name)) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return found;
}

/** True when a subtree reads the exact member `<objName>.<propName>`. */
function subtreeReadsMember(node, objName, propName) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isPropertyAccessExpression(n) && n.name.text === propName
        && ts.isIdentifier(n.expression) && n.expression.text === objName) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** True when a subtree references the identifier `name` (a comment mentioning it does not count). */
function subtreeReferencesIdentifier(node, name) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === name) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** True when a subtree contains an `if` whose CONDITION references the identifier and whose then-branch throws. */
function hasIdentifierGuardedThrowingBranch(node, identifierName) {
  let ok = false;
  const walk = (n) => {
    if (ok) return;
    if (ts.isIfStatement(n)
        && subtreeReferencesIdentifier(n.expression, identifierName)
        && subtreeThrows(n.thenStatement)) {
      ok = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return ok;
}

/** True when a subtree contains a real `<anything>.<propName> === '<value>'` comparison. */
function subtreeHasMemberEqualsString(node, propName, value) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isBinaryExpression(n)
        && n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        && ts.isPropertyAccessExpression(n.left) && n.left.name.text === propName
        && ts.isStringLiteralLike(n.right) && n.right.text === value) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** True when a subtree assigns the string literal `value` to the identifier `name`. */
function subtreeAssignsIdentifierString(node, name, value) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isBinaryExpression(n)
        && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(n.left) && n.left.text === name
        && ts.isStringLiteralLike(n.right) && n.right.text === value) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** Locate the first CallExpression whose callee is the identifier `calleeName`. */
function findCallExpressionByName(node, calleeName) {
  let found;
  const walk = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === calleeName) { found = n; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** Every conditional object spread `...(cond ? A : B)` in a subtree, as { condition, whenTrue, whenFalse }. */
function collectConditionalObjectSpreads(node) {
  const spreads = [];
  const walk = (n) => {
    if (ts.isSpreadAssignment(n)) {
      let expr = n.expression;
      while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
      if (ts.isConditionalExpression(expr)) {
        spreads.push({ condition: expr.condition, whenTrue: expr.whenTrue, whenFalse: expr.whenFalse });
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return spreads;
}

/** True when the expression is a real `<objName>.<propName> !== undefined` check. */
function isDefinedCheckOnMember(expr, objName, propName) {
  return Boolean(expr)
    && ts.isBinaryExpression(expr)
    && expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    && ts.isPropertyAccessExpression(expr.left)
    && expr.left.name.text === propName
    && ts.isIdentifier(expr.left.expression) && expr.left.expression.text === objName
    && ts.isIdentifier(expr.right) && expr.right.text === 'undefined';
}

/** True when the expression is a real `<identifierName> === '<value>'` comparison. */
function isIdentifierEqualsStringLiteral(expr, identifierName, value) {
  return Boolean(expr)
    && ts.isBinaryExpression(expr)
    && expr.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && ts.isIdentifier(expr.left) && expr.left.text === identifierName
    && ts.isStringLiteralLike(expr.right) && expr.right.text === value;
}

/** The initializer of the named object-literal property, or undefined. */
function objectLiteralPropertyInitializer(node, propName) {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop)
        && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
        && prop.name.text === propName) return prop.initializer;
  }
  return undefined;
}

/** True when the node is an object literal with ZERO properties (`{}`). */
function isEmptyObjectLiteral(node) {
  return Boolean(node) && ts.isObjectLiteralExpression(node) && node.properties.length === 0;
}

// ── B-70a6 F-004 helpers: ordering/atomicity-anchored AST assertions ──
// The reopen recovery guarantee is not only "these calls exist" but "they happen
// in THIS order and share ONE atomic write", so these return NODES (for source
// position comparison) rather than booleans.

/** The first real `<objName>.<propName> = ...` assignment in a subtree. */
function findMemberAssignment(node, objName, propName) {
  let found;
  const walk = (n) => {
    if (found) return;
    if (ts.isBinaryExpression(n)
        && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(n.left)
        && n.left.name.text === propName
        && ts.isIdentifier(n.left.expression) && n.left.expression.text === objName) { found = n; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** Every real `<objName>.<methodName>(...)` call in a subtree, in source order. */
function collectMemberCalls(node, objName, methodName) {
  const calls = [];
  const walk = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === methodName
        && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === objName) calls.push(n);
    ts.forEachChild(n, walk);
  };
  walk(node);
  return calls.sort((a, b) => a.pos - b.pos);
}

/** Every real `<calleeName>(...)` call in a subtree, in source order. */
function collectCallExpressionsByName(node, calleeName) {
  const calls = [];
  const walk = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === calleeName) calls.push(n);
    ts.forEachChild(n, walk);
  };
  walk(node);
  return calls.sort((a, b) => a.pos - b.pos);
}

/** The first IfStatement in a subtree satisfying `predicate`. */
function findIfStatement(node, predicate) {
  let found;
  const walk = (n) => {
    if (found) return;
    if (ts.isIfStatement(n) && predicate(n)) { found = n; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** True when a subtree contains a real `delete <anything>.<propName>` expression. */
function subtreeDeletesMember(node, propName) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isDeleteExpression(n)
        && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === propName) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

// ── B-70a6 F-005 helpers: the out-of-band phase writers are object-literal
// METHODS (story_discard / story_reconcile), not top-level functions, so the
// F-004 helpers cannot reach them.

/** Locate a function-like node by name: declaration, object-literal method, or `const x = () => {}`. */
function findFunctionLike(sf, name) {
  let found;
  const named = (node) => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name && ts.isIdentifier(node.name) && node.name.text === name;
    if (ts.isPropertyAssignment(node)) {
      return (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === name
        && (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer));
    }
    if (ts.isVariableDeclaration(node)) {
      return ts.isIdentifier(node.name) && node.name.text === name && node.initializer
        && (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer));
    }
    return false;
  };
  const visit = (node) => {
    if (found) return;
    if (named(node)) {
      found = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ? node : node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

/** True when an object literal carries the named property, shorthand (`{ store }`) included. */
function objectLiteralHasProperty(node, propName) {
  if (!node || !ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some(prop =>
    (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop))
    && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
    && prop.name.text === propName);
}

/** The first `new <ctorName>(...)` expression in a subtree. */
function findNewExpressionByName(node, ctorName) {
  let found;
  const walk = (n) => {
    if (found) return;
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === ctorName) { found = n; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** True when a subtree contains a real `<anything>.<leftProp> === <rightObj>.<rightProp>` comparison. */
function subtreeComparesMembers(node, leftProp, rightObj, rightProp) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isBinaryExpression(n)
        && n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        && ts.isPropertyAccessExpression(n.left) && n.left.name.text === leftProp
        && ts.isPropertyAccessExpression(n.right) && n.right.name.text === rightProp
        && ts.isIdentifier(n.right.expression) && n.right.expression.text === rightObj) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

// ── B-956f FIX 2 (R5): TypeChecker-anchored delegation assertions ──
// codex defeated the includes()/name-match AST assertions three ways: (a) a
// dead-branch call `if (false) buildMaterialClassificationSnapshot();`, (b) a
// same-named LOCAL function shadowing the imported one, (c) ProofStory checks
// scanning the WHOLE FILE instead of the builder body. These helpers build a real
// ts.Program + TypeChecker and assert that each required delegation is a LIVE
// (non-dead-branch), NON-NESTED call whose callee SYMBOL resolves to the intended
// module (not a name match) and whose result is CONSUMED (not a discarded bare
// statement). ProofStory assertions are scoped to the builder FUNCTION BODY and
// follow one hop through the local helper the materialClassification property
// delegates to.
let _materialProgram;
let _materialChecker;
function getMaterialProgram() {
  if (_materialProgram) return _materialProgram;
  const configPath = join(root, 'packages/main/tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, join(root, 'packages/main'));
  const rootFiles = [
    'packages/main/src/core/review-assurance-floor.ts',
    'packages/main/src/core/repro-evidence-binding-gate.ts',
    'packages/main/src/handlers/phase-gates.ts',
    'packages/main/src/handlers/proofstory.ts',
    'packages/main/src/core/material-code-policy.ts',
  ].map((p) => join(root, p));
  _materialProgram = ts.createProgram(rootFiles, { ...parsed.options, noEmit: true, skipLibCheck: true });
  _materialChecker = _materialProgram.getTypeChecker();
  return _materialProgram;
}
function materialProgramSourceFile(relPath) {
  const sf = getMaterialProgram().getSourceFile(join(root, relPath));
  assert(sf, `${relPath}: source file must be present in the material-code type program`);
  return sf;
}
const FUNCTION_LIKE_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);
function isFunctionLike(node) {
  return FUNCTION_LIKE_KINDS.has(node.kind);
}
/** Resolve the callee's (alias-followed) symbol. */
function resolveCalleeSymbol(callExpr) {
  getMaterialProgram();
  let sym = _materialChecker.getSymbolAtLocation(callExpr.expression);
  if (!sym) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) {
    try { sym = _materialChecker.getAliasedSymbol(sym); } catch { /* keep original */ }
  }
  return sym;
}
/**
 * B-956f FIX 2 (codex MED — verifier false positive on aliased imports): identify a
 * required call SOLELY by alias-followed SYMBOL IDENTITY — the callee symbol's
 * EXPORTED name (post getAliasedSymbol) plus its declaring module — never by the
 * source-level callee spelling. `import { buildMaterialClassificationSnapshot as
 * buildSnapshot }` + `buildSnapshot(...)` resolves through getAliasedSymbol to the
 * same export (getName() === 'buildMaterialClassificationSnapshot'), so the aliased
 * call is correctly recognized instead of being rejected as "not found" (exit 1 on
 * legitimate code).
 */
function calleeSymbolMatches(callExpr, name, moduleSubstr) {
  const sym = resolveCalleeSymbol(callExpr);
  if (!sym) return false;
  // Post-alias getName() is the ORIGINAL exported symbol name, not the local alias.
  if (typeof sym.getName === 'function' ? sym.getName() !== name : sym.name !== name) return false;
  const decls = sym.getDeclarations?.() ?? [];
  return decls.some((d) => d.getSourceFile().fileName.includes(moduleSubstr));
}
/** Resolve a callee identifier to its (local) function-like declaration node, if any. */
function resolveCalleeFunctionDeclaration(callExpr) {
  const sym = resolveCalleeSymbol(callExpr);
  const decls = sym?.getDeclarations?.() ?? [];
  return decls.find((d) => isFunctionLike(d));
}
/** True when node sits inside a provably-dead branch (`if (false)`/`if (0)`, or the dead arm of a literal-conditional). */
function inProvablyDeadBranch(node) {
  let cur = node;
  while (cur.parent) {
    const parent = cur.parent;
    if (ts.isIfStatement(parent)) {
      const cond = parent.expression;
      const isFalse = cond.kind === ts.SyntaxKind.FalseKeyword || (ts.isNumericLiteral(cond) && Number(cond.text) === 0);
      const isTrue = cond.kind === ts.SyntaxKind.TrueKeyword || (ts.isNumericLiteral(cond) && Number(cond.text) !== 0 && !Number.isNaN(Number(cond.text)));
      if (isFalse && cur === parent.thenStatement) return true;
      if (isTrue && parent.elseStatement && cur === parent.elseStatement) return true;
    } else if (ts.isConditionalExpression(parent)) {
      const cond = parent.condition;
      const isFalse = cond.kind === ts.SyntaxKind.FalseKeyword || (ts.isNumericLiteral(cond) && Number(cond.text) === 0);
      const isTrue = cond.kind === ts.SyntaxKind.TrueKeyword || (ts.isNumericLiteral(cond) && Number(cond.text) !== 0 && !Number.isNaN(Number(cond.text)));
      if (isFalse && cur === parent.whenTrue) return true;
      if (isTrue && cur === parent.whenFalse) return true;
    }
    cur = parent;
  }
  return false;
}
/**
 * B-956f FIX 3 (codex HIGH defeat a — bind the RETURNED symbol): a snapshot call is
 * "consumed" only when its result actually flows onward. A bare `foo();` /
 * `void foo();` is discarded. When the call is the initializer of a `const x = foo()`
 * declaration, the DECLARED variable's symbol must be REFERENCED again within the
 * enclosing function (the gate branch / classification argument / return property) —
 * the old check accepted ANY non-ExpressionStatement parent, so assigning the real
 * call to an UNUSED variable while passing a FABRICATED snapshot downstream slipped
 * through. Any other position (call used directly as an argument / return value /
 * ternary branch / property initializer) is inherently consumed.
 */
function callResultConsumed(callExpr) {
  const p = callExpr.parent;
  if (ts.isExpressionStatement(p)) return false;
  if (ts.isVoidExpression(p) && p.parent && ts.isExpressionStatement(p.parent)) return false;
  if (ts.isVariableDeclaration(p) && p.initializer === callExpr && ts.isIdentifier(p.name)) {
    return declaredSymbolReferencedBeyondDeclaration(p.name);
  }
  return true;
}
/**
 * B-956f FIX 3 (defeat a): true when the declaration-name identifier's symbol is
 * referenced at least once MORE (beyond its own declaration site) inside the nearest
 * enclosing function body — i.e. the returned snapshot symbol is actually used
 * downstream, not bound to a dead variable.
 */
function declaredSymbolReferencedBeyondDeclaration(nameIdent) {
  getMaterialProgram();
  const declSym = _materialChecker.getSymbolAtLocation(nameIdent);
  if (!declSym) return false;
  let fn = nameIdent.parent;
  while (fn && !isFunctionLike(fn)) fn = fn.parent;
  const scope = fn && fn.body ? fn.body : nameIdent.getSourceFile();
  let refs = 0;
  const walk = (n) => {
    if (n !== nameIdent && ts.isIdentifier(n) && n.text === nameIdent.text) {
      if (_materialChecker.getSymbolAtLocation(n) === declSym) refs++;
    }
    ts.forEachChild(n, walk);
  };
  walk(scope);
  return refs >= 1;
}
/**
 * True when the function body contains a LIVE (non-dead-branch), non-nested call to
 * `name` whose callee symbol resolves to `moduleSubstr`. `requireConsumed` also
 * demands the call result be used (data-flow, non-vacuous).
 */
function functionBodyHasResolvedCall(fnNode, name, moduleSubstr, { requireConsumed = false } = {}) {
  const body = fnNode && fnNode.body;
  if (!body) return false;
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (isFunctionLike(n)) return; // skip nested function bodies
    if (ts.isCallExpression(n)
        && !inProvablyDeadBranch(n)
        && calleeSymbolMatches(n, name, moduleSubstr)
        && (!requireConsumed || callResultConsumed(n))) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(body, walk);
  return found;
}
/**
 * B-956f FIX 3 (codex HIGH defeat b — inspect EVERY reachable return): the
 * object-literal expressions returned by every (non-provably-dead) return statement in
 * the builder body (skipping nested function bodies). The old scan accepted the FIRST
 * `materialClassification` occurrence ANYWHERE, so a valid property inside a
 * runtime-dead-but-not-literal branch (`const enabled=false; if(enabled) return {...}`)
 * satisfied it while the LIVE return used `materialClassification: null`. Collecting
 * every return object lets the caller demand the delegating property in ALL of them.
 */
function builderReturnObjectLiterals(fnNode) {
  const body = fnNode && fnNode.body;
  if (!body) return [];
  const out = [];
  const walk = (n) => {
    if (n !== body && isFunctionLike(n)) return; // stay in this builder body
    if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression)
        && !inProvablyDeadBranch(n)) {
      out.push(n.expression);
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(body, walk);
  return out;
}
/** The `materialClassification` property initializer within an object literal, or undefined. */
function objectLiteralMaterialClassificationInit(objLit) {
  for (const prop of objLit.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'materialClassification') {
      return prop.initializer;
    }
    // shorthand `{ materialClassification }` — an Identifier value, never a delegating
    // call, so surface it (fails the call check below rather than being treated as absent).
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'materialClassification') {
      return prop.name;
    }
  }
  return undefined;
}
/**
 * B-956f FIX 2 + FIX 3: the materialClassification initializer must delegate to
 * tryBuildMaterialClassificationSnapshotForDiagnostics — directly (alias-safe symbol
 * identity) or via ONE local helper that itself makes a live, consumed, resolved call
 * to it.
 */
function initializerDelegatesToTry(init) {
  const TRY = 'tryBuildMaterialClassificationSnapshotForDiagnostics';
  const MCP = 'material-code-policy';
  if (calleeSymbolMatches(init, TRY, MCP)) return true;
  const helperDecl = resolveCalleeFunctionDeclaration(init);
  return !!helperDecl && functionBodyHasResolvedCall(helperDecl, TRY, MCP, { requireConsumed: true });
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
  const topologyText = read('packages/main/src/core/acceptance-topology.ts');
  const verificationText = read('packages/main/src/core/verification.ts');
  const milestoneStatusText = read('packages/main/src/core/milestone-status.ts');
  const checklistHandlerText = read('packages/main/src/handlers/checklist.ts');
  // B-29bc: explicit inventory purpose is a producer/consumer contract, not
  // a prose exemption from topology business-author admission.
  const inventoryDispatchText = read('packages/main/src/handlers/story-dispatch.ts');
  const inventoryRunHandlerText = read('packages/main/src/handlers/review-run.ts');
  const purposeRunText = read('packages/main/src/core/review-run.ts');
  const purposeEpochText = read('packages/main/src/core/review-inventory-epoch.ts');
  const purposeInventoryHandlerText = read('packages/main/src/handlers/review-inventory.ts');
  for (const [label, source] of [['dispatch', inventoryDispatchText], ['run', inventoryRunHandlerText]]) {
    assert(source.includes('requireInventoryCriticSubjectLocked') && source.includes('inventory-completeness'), `${label}: inventory purpose must bind the current signed epoch under the inventory lock`);
  }
  assert(inventoryDispatchText.includes("targetKind: 'inventory-critic-review'") && inventoryDispatchText.includes('topologyDispatchBusinessAuthor'),
    'inventory dispatch must use a distinct carrier while default topology retains Git business-author admission');
  assert(purposeRunText.includes("'critic-review-purpose.v1'") && purposeRunText.includes('run.inventoryBinding')
    && purposeEpochText.includes('inventoryPurposeMatchesEpoch(run.inventoryBinding, epoch)')
    && purposeInventoryHandlerText.includes('REVIEW_INVENTORY_CRITIC_PURPOSE_REQUIRED'),
    'signed run and inventory receipt consumers must enforce purpose and exact epoch subject');
  const configText = read('packages/main/src/core/config.ts');
  const activityPolicyText = read('packages/main/src/cli/activity-policy.ts');
  const commandPolicyEntries = new Map(parseCommandPolicyEntries().map(entry => [entry.name, entry]));
  const storyAdvanceText = read('packages/main/src/handlers/story-advance.ts');
  const phaseGatesText = read('packages/main/src/handlers/phase-gates.ts');
  const machineText = read('packages/main/src/core/machine.ts');
  const liveSmokeGateText = read('packages/main/src/core/live-smoke-transcript-evidence.ts');
  assert(machineText.includes('evaluateOptionalLiveSmokeTranscript')
    && liveSmokeGateText.includes("artifact.actual.exitCode !== 0")
    && liveSmokeGateText.includes("artifact.mode?.runCommands !== true"),
  'DONE must fail closed when a present canonical live-smoke transcript did not execute or did not exit zero');

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
    'acceptance_matrix',
    'acceptance_topology_check',
    'acceptance_basis_generate',
    'acceptance_basis',
    'pre_review_check',
    'pre_review_check_read',
    'acceptance_rollout_report',
    'acceptance_rollout_report_read',
    'acceptance_rollout_check',
    'intent_collision_set',
    'intent_collision_get',
    'scope_shrinkage_decision_set',
    'scope_shrinkage_decision_get',
    'red_evidence_create',
    'red_evidence_get',
    'red_evidence_binding_set',
    'red_evidence_quarantine',
    'red_evidence_recover',
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
  assert(topologyText.includes('isAcceptanceMatrixDerivedEvidence')
    && topologyText.includes('acceptanceMatrixEvidenceProvenance')
    && verificationText.includes('isAcceptanceMatrixDerivedEvidence')
    && coreText.includes('isAcceptanceMatrixDerivedEvidence')
    && milestoneStatusText.includes('isAcceptanceMatrixDerivedEvidence')
    && checklistHandlerText.includes('acceptance_matrix_non_evidentiary_projection'),
  'acceptance_matrix L0 projection must derive bounded provenance, reject evidence writes, and remain ignored by general/ProofStory/milestone consumers');
  const basisText = read('packages/main/src/core/acceptance-coverage-basis.ts');
  const adaptersText = read('packages/main/src/core/acceptance-discovery-adapters.ts');
  const receiptText = read('packages/main/src/core/acceptance-basis-receipt.ts');
  const processRegistryText = read('packages/main/src/core/process-fact-registry.ts');
  const processLevelText = read(processFactLevelRegistryPath);
  const transitionOrchestratorText = read('packages/main/src/handlers/transition-orchestrator.ts');
  const acceptanceWriterPolicy = commandPolicyEntries.get('acceptance_basis_generate');
  const acceptancePromptPaths = [
    rolePromptPath('packages/main/templates/agents', 'proof-or-stop-implementer'),
    rolePromptPath('.claude/agents', 'proof-or-stop-implementer'),
    rolePromptPath(CODEX_AGENTS_DIR, 'proof-or-stop-implementer'),
  ];
  const acceptanceRequiredSemantics = process.env.PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION === 'drop-acceptance-basis-contract'
    ? requiredProcessFactSemantics.acceptance_basis_generate.filter(item => item !== 'workspace-binding')
    : requiredProcessFactSemantics.acceptance_basis_generate;
  assert(
    handlerText.includes('acceptance_basis_generate')
      && handlerText.includes('acceptance_basis(args')
      && catalogText.includes("status: z.never()")
      && basisText.includes('deriveAcceptanceCoverageBasis')
      && basisText.includes('verifyAcceptanceCoverageBasis')
      && basisText.includes('snapshotSeal')
      && adaptersText.includes('AT_REQUIRED_ADAPTER_RESULT_MISSING')
      && adaptersText.includes('AT_DISCOVERY_DISAGREEMENT')
      && receiptText.includes('verifyAcceptanceBasisReceipt')
      && receiptText.includes('checkEvidenceFreshnessForGit')
      && receiptText.includes('sealDigest')
      && processRegistryText.includes('structured snapshotSeal/sealDigest integrity fact')
      && /name:\s*'artifact:acceptance-basis\.json'[\s\S]{0,450}semantics:\s*\[[^\]]*'workspace-binding'[^\]]*'gate-evidence'[^\]]*\][\s\S]{0,100}level:\s*'L4'/.test(processRegistryText)
      && acceptanceWriterPolicy?.status === 'gateEvidence'
      && acceptanceWriterPolicy.gateEvidence === true
      && /name:\s*'acceptance_basis_generate',\s*level:\s*'L4'[\s\S]{0,500}acceptance_topology_check/.test(processLevelText)
      // B-cdf6 CHK-005: the sole-writer command is now taught under the renamed canonical bin.
      // Assertion strength is unchanged — all three prompt surfaces must still name the writer
      // command, so dropping the acceptance-basis boundary from any of them still fails.
      && acceptancePromptPaths.every(path => read(path).includes('proof-or-stop acceptance_basis_generate'))
      && acceptanceRequiredSemantics.includes('workspace-binding'),
    'acceptance basis contract must keep a sole verifier writer, caller-forgery schema rejection, registered adapter omission/disagreement checks, structured seal binding, signed receipt verification, and canonical freshness consumption',
  );
  const topologyPolicy = commandPolicyEntries.get('acceptance_topology_check');
  assert(
    basisText.includes('canonicalStaticTopologyPath')
      && basisText.includes('!discoveredPaths.has(path)')
      && basisText.includes('sourceRefValue(producer) === consumerValue')
      && basisText.includes('matchingRecords.length !== 1')
      && basisText.includes('endpoint.id !== sourceRef.endpointRef')
      && basisText.includes("endpoint.role !== 'producer'")
      && basisText.includes('endpoint.expectedFileRef !== staticCall[1]')
      && basisText.includes('endpoint.expectedSymbolOrFact !== staticCall[2]')
      && processRegistryText.includes('Exact static topology projection requires a discovery-owned path')
      && read('packages/main/src/tasks/proofstory-acceptance-basis-smoke.ts').includes('two different discovered paths despite both commandRefs'),
    'acceptance basis static edge projection must preserve discovery membership and exact producer identity, not manufacture relationships from topology references',
  );
  assert(
    catalogText.includes("name: 'acceptance_topology_check'")
      && catalogText.includes("mode: z.never()")
      && handlerText.includes('acceptance_topology_check(args')
      && handlerText.includes('evaluateAcceptanceTopologyForContext')
      && topologyText.includes('evaluateAcceptanceTopologyCheck')
      && topologyText.includes('structuralPass')
      && topologyText.includes('AT_COVERAGE_BASIS_PARTIAL')
      && basisText.includes('AT_UNMAPPED_SCOPE_REF')
      && configText.includes('acceptanceTopologyGateMode')
      && configText.includes('resolveAcceptanceTopologyGateMode')
      && handlerText.includes('resolveAcceptanceTopologyGateMode')
      && transitionOrchestratorText.includes('evaluateAcceptanceTopologyForContext')
      && transitionOrchestratorText.includes('if (topology.blocking)')
      && processRegistryText.includes('runtime:acceptance_topology_plan_dev_gate')
      && processLevelText.includes('runtime:acceptance_topology_plan_dev_gate')
      && topologyPolicy?.status === 'gateEvidence'
      && topologyPolicy.gateEvidence === true
      && policyBlockHasOwnershipClass(topologyPolicy, 'readOnly')
      && activityPolicyText.includes("'acceptance_topology_check'")
      && acceptancePromptPaths.every(path => read(path).includes('Acceptance-topology boundary:')),
    'acceptance topology contract must bind CLI schema, canonical evaluator, signed basis verification, independent default-observe rollout mode, PLAN gate, process fact, and prompt guidance',
  );
  const preReviewText = read('packages/main/src/core/pre-review-check.ts');
  const acceptanceDiscoveryText = read('packages/main/src/core/acceptance-discovery-adapters.ts');
  const preReviewPolicy = commandPolicyEntries.get('pre_review_check');
  assert(
    catalogText.includes("name: 'pre_review_check'")
      && catalogText.includes("name: 'pre_review_check_read'")
      && handlerText.includes('issuePreReviewCheckArtifact')
      && handlerText.includes('evaluatePreReviewCheckForContext')
      && preReviewText.includes('verifyPreReviewCheckArtifact')
      && preReviewText.includes('PR_MUTATION_DID_NOT_BITE')
      && preReviewText.includes('PR_TOPOLOGY_CRITIC_REATTESTATION_REQUIRED')
      && !preReviewText.includes('attestation?.checkedClaims')
      && !preReviewText.includes('actorTrust')
      && preReviewText.includes('const transcriptIds = row.transcriptProofs.map')
      && preReviewText.includes('sameStrings(transcript.producerRefs, assertion.producerRefs)')
      && preReviewText.includes('transcript.actual?.command !== PRE_REVIEW_LIVE_PROOF_COMMAND')
      && preReviewText.includes("PRE_REVIEW_LIVE_PROOF_COMMAND = 'node scripts/run-proofstory-pre-review-live-proof.mjs'")
      && preReviewText.includes('proof case records/root invalid')
      && preReviewText.includes('proof executable provenance invalid')
      && preReviewText.includes('exactKindsAndSources')
      && preReviewText.includes('preReviewExecutableProvenanceIsCurrent')
      && preReviewText.includes('criticReceiptDigestForPreReviewSemanticComparison')
      && preReviewText.includes("return mode === 'enforce' ? currentDigest : signedDigest")
      && read('packages/main/src/tasks/proofstory-pre-review-check-smoke.ts').includes('--critic-digest-renewal-contract-only')
      && processRegistryText.includes('Non-enforcing semantic readback retains the signed artifact critic-receipt digest')
      && read('packages/main/src/core/pre-review-live-proof.ts').includes('assemblePreReviewCaseRecords')
      && read('packages/main/src/core/pre-review-live-proof.ts').includes('extra assertion IDs')
      && read('scripts/run-proofstory-pre-review-live-proof.mjs').includes("['--prefix', 'packages/main', 'run', 'build']")
      && acceptanceDiscoveryText.includes('exportedCallableCount(source, endpoint.expectedSymbolOrFact)')
      && acceptanceDiscoveryText.includes('endpointMatchesArtifactKind')
      && acceptanceDiscoveryText.includes('endpointIsRuntimeReachable')
      && acceptanceDiscoveryText.includes('producerConsumerRelation')
      && !acceptanceDiscoveryText.includes('sourceText.includes(endpoint.expectedSymbolOrFact)')
      && transitionOrchestratorText.includes('runPreReviewCheckGate')
      && transitionOrchestratorText.includes("story.phase === 'DEV' && args.phase === 'REVIEW'")
      && processRegistryText.includes('artifact:pre-review-check.json')
      && processLevelText.includes("name: 'pre_review_check', level: 'L4'")
      && preReviewPolicy?.status === 'gateEvidence'
      && preReviewPolicy.gateEvidence === true
      && policyBlockHasOwnershipClass(preReviewPolicy, 'storyScopedMutating'),
    'pre-review contract must keep one signed verifier writer, read-only verifier parity, stable PR_* semantics, process-fact registration, and the DEV to REVIEW lifecycle consumer',
  );
  const acceptanceRolloutText = read('packages/main/src/core/acceptance-rollout.ts');
  const acceptanceRolloutSmokeText = read('packages/main/src/tasks/proofstory-acceptance-rollout-smoke.ts');
  const acceptanceRolloutRunnerText = read('scripts/run-proofstory-acceptance-rollout-cohort.mjs');
  const preReviewScenarioText = read('packages/main/src/tasks/proofstory-pre-review-check-smoke.ts');
  const acceptancePlanText = read('docs/requirements/decisions/proofstory-acceptance-topology-and-pre-review-gates-execution-plan.md');
  const rolloutPromptNames = [
    'proof-or-stop-implementer',
    'proof-or-stop-test-case-reviewer',
    'proof-or-stop-review-topology-critic',
    'proof-or-stop-review-concept',
    'proof-or-stop-review-quality',
    'proof-or-stop-review-test-coverage',
    'proof-or-stop-review-docs',
    'proof-or-stop-review-delivery',
  ];
  // B-4043 F-014: the acceptance-rollout role guidance is sourced from the
  // canonical package templates (the REAL delivery path — review_run_start /
  // agent_prompt resolve each role body from templates/agents), NOT from the
  // regenerable host shims under .claude/agents / .proof-or-stop-codex/agents (those
  // are thin/mirror adapters that `proof-or-stop init --upgrade` rewrites). Validate
  // the tokens in the template source, and prove the guidance does not depend
  // on the bootstrap-only modular-reviewer shims.
  // origin/main merge: exempt RETIRED role identities from the rollout-guidance
  // requirement. origin still ships test-case-reviewer as a live 157-line reviewer
  // prompt; this repo deliberately reduced it (and test-intent) to a stub whose own
  // frontmatter reads 'Legacy compatibility identity; not dispatchable for new stories'.
  // A non-dispatchable identity can never act on acceptance-rollout guidance, so
  // requiring the tokens in its body would force us to resurrect a role we retired on
  // purpose -- and copying origin's body back is the one resolution that would silently
  // undo that decision. Detected by reading the retirement marker out of the template
  // rather than hardcoding names, so a future retirement or revival needs no edit here
  // and a role cannot be exempted without declaring itself retired in its own prompt.
  const RETIRED_IDENTITY_MARKER = 'Legacy compatibility identity; not dispatchable for new stories';
  const rolloutPromptTemplates = rolloutPromptNames
    .map(name => rolePromptPath('packages/main/templates/agents', name))
    .filter(relPath => !read(relPath).includes(RETIRED_IDENTITY_MARKER));
  // Modular reviewer roles render as a body-free review_run_start bootstrap in
  // the host shim; their guidance must live in the template and reach them via
  // review_run_start, never via the shim.
  const rolloutBootstrapOnlyReviewerNames = [
    'proof-or-stop-review-concept',
    'proof-or-stop-review-quality',
    'proof-or-stop-review-test-coverage',
    'proof-or-stop-review-docs',
  ];
  const rolloutPromptTokens = [
    'acceptance_topology_check',
    'pre_review_check_read',
    'acceptance_rollout_report_read',
    'acceptance_rollout_check',
    'full 3 rounds',
    'codex-cli',
    'claude-cli',
    '3x1',
    'rollback',
  ];
  const rolloutPolicy = commandPolicyEntries.get('acceptance_rollout_report');
  assert(
    catalogText.includes("name: 'acceptance_rollout_report'")
      && catalogText.includes("name: 'acceptance_rollout_report_read'")
      && catalogText.includes("name: 'acceptance_rollout_check'")
      && catalogText.includes('eligibleMembership: z.never()')
      && catalogText.includes('aggregate: z.never()')
      && handlerText.includes('acceptance_rollout_report(args')
      && handlerText.includes('acceptance_rollout_report_read(args')
      && handlerText.includes('acceptance_rollout_check(args')
      && handlerText.includes('deriveAcceptanceRolloutReport')
      && handlerText.includes('issueAcceptanceRolloutArtifact')
      && handlerText.includes('evaluateAcceptanceRolloutForContext')
      && acceptanceRolloutText.includes('export function deriveAcceptanceRolloutReport')
      && acceptanceRolloutText.includes('ACCEPTANCE_ROLLOUT_MIN_MATCHED_PAIRS = 3')
      && acceptanceRolloutText.includes('issueAcceptanceRolloutObservationFromProduction')
      && acceptanceRolloutText.includes("quorum.schemaVersion !== 'proof-or-stop.quorum_submit.v1'")
      && acceptanceRolloutText.includes("['cat-file', '-e'")
      && acceptanceRolloutText.includes('quorum.reviewerPasses.some')
      && acceptanceRolloutText.includes("run('acceptance_topology_check')")
      && acceptanceRolloutText.includes("run('pre_review_check_read')")
      && acceptanceRolloutText.includes('mutationCommitSha')
      && acceptanceRolloutText.includes('restorationCommitSha')
      && acceptanceRolloutText.includes('restored control did not rerun PASS')
      && acceptanceRolloutText.includes('caller ${label} does not match production command replay')
      && acceptanceRolloutText.includes('AR_REGISTERED_CAMPAIGN_INCOMPLETE')
      && acceptanceRolloutText.includes('AR_OMISSION_DETECTION_BELOW_100')
      && acceptanceRolloutText.includes('AR_FALSE_BLOCK_NONZERO')
      && acceptanceRolloutText.includes('AR_MISLABELED_3X1_NONZERO')
      && acceptanceRolloutText.includes('AR_WAIVER_DELTA_POSITIVE')
      && acceptanceRolloutText.includes('AR_CHECK_INVENTORY_SHRANK')
      && acceptanceRolloutText.includes('checkEvidenceFreshnessForGit')
      && acceptanceRolloutRunnerText.includes('export function runProofStoryAcceptanceRolloutCohort')
      && acceptanceRolloutRunnerText.includes("'.proof-or-stop', 'story', 'actives'")
      && acceptanceRolloutSmokeText.includes('export async function runProofStoryAcceptanceRolloutSmoke')
      && acceptanceRolloutSmokeText.includes('runAcceptanceRolloutGate')
      && acceptanceRolloutSmokeText.includes('mode changes preserve report byte-for-byte')
      && acceptanceRolloutSmokeText.includes('--issuer-mutations')
      && acceptanceRolloutSmokeText.includes('restoration commit is missing or malformed')
      && acceptanceRolloutSmokeText.includes('restoration commit must be later than mutation commit')
      // F-339: the registered scenario catalog includes assertion-specific
      // package-identity/bin-alias controls in addition to the original
      // rollout catalog. The process-fact guard must track both the catalog
      // cardinality and the real migration operations, or a stale guard could
      // silently accept an unrelated semantic projection.
      && preReviewScenarioText.includes('Array.from({ length: 7 }')
      && preReviewScenarioText.includes('Array.from({ length: 21 }')
      && preReviewScenarioText.includes("['A-POS-6', 'positive', 'package-identity:sibling-package-graph'")
      && preReviewScenarioText.includes("['A-POS-7', 'positive', 'bin-alias:canonical-only'")
      && preReviewScenarioText.includes("['A-MUT-19', 'mutation', 'package-identity:mixed-graph'")
      && preReviewScenarioText.includes("['A-MUT-21', 'mutation', 'bin-alias:removed-alias'")
      && preReviewScenarioText.includes("['A-TRANSCRIPT-1', 'transcript']")
      && preReviewScenarioText.includes('PROOF_OR_STOP_ACCEPTANCE_ROLLOUT_COHORT_FILE')
      && preReviewScenarioText.includes('scenario execution refuses to spawn the expensive registered cohort runner')
      && !preReviewScenarioText.includes("execFileSync(process.execPath, [join(repositoryRoot, 'scripts/run-proofstory-acceptance-rollout-cohort.mjs')")
      && acceptancePlanText.includes('five positive paths and the seventeen')
      && acceptancePlanText.includes('5 positive / 17 mutation / 1 transcript')
      && acceptancePlanText.includes('illustrative, abridged shape of the implemented canonical')
      && transitionOrchestratorText.includes('runAcceptanceRolloutGate')
      && transitionOrchestratorText.includes('if (report.blocking)')
      && configText.includes('acceptanceRolloutGateMode')
      && configText.includes('resolveAcceptanceRolloutGateMode')
      && processRegistryText.includes('runtime:acceptance_rollout_dev_review_gate')
      && processRegistryText.includes('artifact:acceptance-rollout-report.json')
      && processLevelText.includes('runtime:acceptance_rollout_dev_review_gate')
      && rolloutPolicy?.status === 'gateEvidence'
      && rolloutPolicy.gateEvidence === true
      && policyBlockHasOwnershipClass(rolloutPolicy, 'storyScopedMutating')
      && rolloutPromptTemplates.every(templatePath =>
        rolloutPromptTokens.every(token => read(templatePath).toLowerCase().includes(token)))
      && rolloutBootstrapOnlyReviewerNames.every(name =>
        !read(rolePromptPath('.claude/agents', name)).toLowerCase().includes('acceptance_rollout_check')
        && !read(rolePromptPath(CODEX_AGENTS_DIR, name)).toLowerCase().includes('acceptance_rollout_check')),
    'acceptance rollout contract must keep verifier-derived frozen membership, >=3 matched pairs per arm, all thresholds, signed current receipt, genuine full-3x2, real lifecycle consumer, mode-invariant rollback, and canonical template-sourced role guidance (not regenerable host shims)',
  );
  const topologyCriticText = read('packages/main/src/core/topology-critic-receipt.ts');
  const topologyCriticTemplatePath = rolePromptPath('packages/main/templates/agents', 'proof-or-stop-review-topology-critic');
  const topologyCriticHostPaths = [
    rolePromptPath('.claude/agents', 'proof-or-stop-review-topology-critic'),
    rolePromptPath(CODEX_AGENTS_DIR, 'proof-or-stop-review-topology-critic'),
  ];
  const topologyCriticPolicy = commandPolicyEntries.get('topology_critic_receipt_set');
  assert(
    catalogText.includes("name: 'topology_exclusion_approval_set'")
      && catalogText.includes("name: 'topology_critic_receipt_set'")
      && catalogText.includes("name: 'topology_critic_receipt_check'")
      && handlerText.includes('topology_critic_receipt_set(args')
      && handlerText.includes('topology_critic_receipt_check(args')
      && handlerText.includes('verifyTopologyCriticReceipt')
      && /export function verifyTopologyCriticReceipt\s*\(/.test(topologyCriticText)
      && topologyCriticText.includes("context.basisStatus !== 'complete'")
      && topologyCriticText.includes('independenceMatrix')
      && topologyCriticText.includes('events: readonly ProcessEvent[];')
      && topologyCriticText.includes('if (!Array.isArray(args.events) || args.events.length === 0)')
      && topologyCriticText.includes('implementationProvenanceDiagnostics')
      && topologyCriticText.includes("const IMPLEMENTER_AUTHOR = 'proof-or-stop-implementer <proof-or-stop-implementer@noreply.local>'")
      && !topologyCriticText.includes('LEGACY_IMPLEMENTER_AUTHOR')
      && /function canonicalBusinessAuthorIdentity\(identity: string\): string \{[^}]*return identity\.trim\(\);\s*\}/.test(topologyCriticText)
      && processRegistryText.includes('retired author spellings cannot be mapped or selected as canonical implementation provenance')
      && topologyCriticText.includes('exact one-to-one independent approvals')
      && processRegistryText.includes('runtime:topology_critic_authority_verification')
      && processLevelText.includes('runtime:topology_critic_authority_verification')
      && processRegistryText.includes('artifact:topology-critic-receipt.json')
      && processRegistryText.includes('artifact:topology-exclusion-approvals.json')
      && !transitionOrchestratorText.includes('evaluateTopologyCriticReceiptForContext')
      && !transitionOrchestratorText.includes('independent topology critic gate rejected PLAN admission')
      && topologyCriticPolicy?.status === 'supported'
      && topologyCriticPolicy.gateEvidence !== true
      && activityPolicyText.includes("'topology_critic_receipt_check'")
      && read(topologyCriticTemplatePath).startsWith('---\n')
      && read(topologyCriticTemplatePath).includes('<!-- proof-or-stop:modular-role-body:v1 -->')
      && read(topologyCriticTemplatePath).includes('- A pass is forbidden when the basis')
      && topologyCriticHostPaths.every(path => read(path).startsWith('---\n')
        && read(path).includes('<!-- proof-or-stop:modular-role-body:v1 -->')
        && read(path).includes('- A pass is forbidden when the basis')
        && read(path).includes('Return after completing the inventory responsibility.')),
    'topology critic contract must bind role prompt, production producer/read-only verifier, required registered dispatch events, signed current fields, four-dimensional independence, exact scope-plan approvals, incomplete-basis rejection, and explicitly no Wave 2A lifecycle admission gate',
  );
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
  assert(read('packages/main/src/core/candidate-spec-routing.ts').includes('candidate routing escalation is unresolved'), 'candidate routing: gate binding must fail closed on unresolved requiresEscalation');
  assert(read('packages/main/src/core/candidate-spec-routing.ts').includes('DEFAULT_MAX_QUERY_DOCUMENT_FREQUENCY_RATIO'), 'candidate routing: generic query terms must use the recorded document-frequency filter');
  assert(read('packages/main/src/core/candidate-spec-routing.ts').includes('MIN_RANKING_AFFECTING_CUTOFF_SCORE'), 'candidate routing: low-confidence body-only cutoff ties must not force broad review');
  assert(read('packages/main/src/core/candidate-spec-routing.ts').includes("classification: 'safe_below_cutoff' | 'ranking_affecting'"), 'candidate routing: signed artifact must carry typed query-level truncation classification');
  assert(read('packages/main/src/core/candidate-spec-routing.ts').includes('protectedSources?: StoryRoutingInput'), 'candidate routing: protected exact sources must use a separate typed input, not narrative prose');
  assert(read('packages/main/src/core/candidate-spec-routing.ts').includes("mode: 'shadow' | 'warn' | 'enforce'"), 'candidate routing: rollout mode must be signed into the candidate artifact');
  assert(read('packages/main/src/core/candidate-spec-routing.ts').includes("filter(diagnostic => diagnostic.blocking)"), 'candidate routing: every mode must diagnose disagreement while shadow/warn never return blocking errors');
  assert(read('packages/main/src/handlers/candidate-spec-routing.ts').includes('withUnattendedReadiness'), 'candidate routing: automatic proposal execution must consume positive unattended readiness before spawn');
  assert(read('packages/main/src/handlers/candidate-spec-routing.ts').includes('CandidateProposalOutputCollector'), 'candidate routing: production proposal execution must use the cumulative bounded collector');
  assert(read('packages/main/src/handlers/candidate-spec-routing.ts').includes('MAX_PROPOSAL_OUTPUT_BYTES = 64 * 1024'), 'candidate routing: provider proposal stdout cap must remain exactly 64 KiB');
  assert(read('packages/main/src/handlers/candidate-spec-routing.ts').includes('!isStoryMetadataPath(path, ctx.root)'), 'candidate routing: its own story metadata writes must not stale storyInputDigest');
  assert(read('packages/main/src/handlers/story-dispatch.ts').includes('STOP — candidate routing escalation is unresolved'), 'candidate routing: PLAN/REVIEW dispatch must render unresolved escalation and resolution action');
  assert(read('packages/main/src/handlers/candidate-spec-routing.ts').includes('BLOCKED_PENDING_ESCALATION'), 'candidate routing: CLI text must prominently render pending escalation');
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

function assertCloseoutTrustBoundary() {
  const levels = new Map(parseProcessFactLevelRegistry().map(entry => [entry.name, entry]));
  const registry = processFactRegistryMap();
  const runtimeFacts = [
    'runtime:closeout_artifact_trust_boundary',
    'runtime:composite_scope_digest_review_gate',
    'runtime:trusted_closeout_artifact_validation',
  ];
  for (const name of runtimeFacts) {
    const level = levels.get(name);
    const fact = registry.get(name);
    assert(level?.level === 'L4' && Boolean(level.gateConsumer), `${processFactLevelRegistryPath}: ${name} must remain an L4 gate-consumed fact`);
    assert(fact?.semantics.includes('schema-contract') && fact?.semantics.includes('gate-evidence'), `${processFactRegistryPath}: ${name} must carry schema-contract + gate-evidence semantics`);
  }

  const trustText = read('packages/main/src/core/closeout-trust.ts');
  for (const token of [
    'CLOSEOUT_ARTIFACT_POLICIES',
    "path: 'scope-contract.json'",
    "path: 'milestone-ledger.json'",
    "path: 'slice-plan.json'",
    "path: 'parent-ledger-rollup.json'",
    "path: 'evidence/delivery-context-pack.json'",
    'computeCompositeScopeDigest',
    'validateTrustedMilestoneLedger',
    'validateTrustedSlicePlan',
    'validateTrustedParentLedgerRollup',
    'validatePersistedDeliveryContextPack',
    'evaluateMetadataOnlyReviewRetention',
    'CLOSEOUT_WRITE_RECEIPTS_PATH',
    'buildCloseoutWriteReceipt',
    'verifyCloseoutWriteReceipt',
    'receipt materialHash is incoherent with headHash',
    'receipt storyFilesHash is incoherent with headHash',
    'causallyBoundToLatestArtifactCommit',
    'previousIntegrityHash',
    'introductionCommit',
  ]) assert(trustText.includes(token), `packages/main/src/core/closeout-trust.ts: missing closeout trust contract token ${token}`);
  assert(trustText.includes('state: ledger.state') && trustText.includes('acceptedIntentBinding: ledger.acceptedIntentBinding'), 'composite scope digest must bind milestone ledger state and accepted intent semantics, not only ledgerHash');
  assert(!/path:\s*['"]milestone-closeout\.json['"]/.test(trustText), 'packages/main/src/core/closeout-trust.ts: milestone-closeout.json remains owned by B-9188 and must not enter the M4.C1 trust set');
  assert(!/path:\s*['"]evidence\/transcript-diff\.md['"]/.test(trustText), 'closeout trust table must not claim the hand-authored legacy transcript-diff has a canonical CLI writer');

  const bindingText = read('packages/main/src/core/review-scope-binding.ts');
  assert(bindingText.includes('compositeScopeDigest') && bindingText.includes('computeCompositeScopeDigest'), 'review-scope-binding must sign and compare the composite semantic-scope digest');
  const reuseText = read('packages/main/src/core/done-prepare-validation-reuse.ts');
  assert(reuseText.includes('compositeScopeDigest') && reuseText.includes("'compositeScopeDigest'"), 'done_prepare validation reuse must compare the composite semantic-scope digest');
  for (const token of ['validateTrustedMilestoneLedger', 'validateTrustedSlicePlan', 'validateTrustedParentLedgerRollup', 'readTrustedProofStoryScopeArtifacts']) {
    assert(trustText.includes(token), `packages/main/src/core/closeout-trust.ts: trust-boundary helper missing ${token}`);
  }
  for (const consumerPath of ['packages/main/src/core/machine.ts', 'packages/main/src/handlers/phase-gates.ts', 'packages/main/src/core/review-run.ts']) {
    assert(read(consumerPath).includes('readTrustedProofStoryScopeArtifacts'), `${consumerPath}: lifecycle trust consumer must validate ProofStory scope artifacts before use`);
  }
  const deliveryText = read('packages/main/src/handlers/delivery-context-pack.ts');
  assert(deliveryText.includes('validatePersistedDeliveryContextPack(JSON.parse'), 'delivery-context-pack writer must validate the persisted shape before rename');
  const canonicalTranscriptPath = 'evidence/live-smoke-transcript.json';
  for (const contractPath of [
    'packages/main/src/handlers/delivery-context-pack.ts',
    commandPolicyPath,
    processFactLevelRegistryPath,
  ]) {
    const contractText = read(contractPath);
    assert(contractText.includes(canonicalTranscriptPath), `${contractPath}: delivery context contract must name ${canonicalTranscriptPath}`);
    assert(!contractText.includes('transcript-diff.md presence'), `${contractPath}: active delivery context contract must not name legacy transcript-diff.md presence`);
  }
  for (const promptPath of [
    rolePromptPath('packages/main/templates/agents', 'proof-or-stop-product-reviewer'),
    rolePromptPath(CODEX_AGENTS_DIR, 'proof-or-stop-product-reviewer'),
    rolePromptPath('.claude/agents', 'proof-or-stop-product-reviewer'),
  ]) {
    const promptText = read(promptPath);
    assert(promptText.includes(`docs/story/actives/<storyId>/${canonicalTranscriptPath}`), `${promptPath}: product-reviewer must consume the canonical live-smoke transcript`);
    assert(!promptText.includes('evidence/transcript-diff.md'), `${promptPath}: product-reviewer must not consume the legacy transcript-diff path`);
  }
  const lifecycleTranscriptText = read(lifecycleRegistryPath);
  assert(lifecycleTranscriptText.includes("'evidence/transcript-diff.md'") && lifecycleTranscriptText.includes("'evidence/live-smoke-transcript.json'"), `${lifecycleRegistryPath}: retain legacy scope compatibility beside the canonical transcript artifact`);
  assert(lifecycleTranscriptText.includes('Legacy scope-classification compatibility only'), `${lifecycleRegistryPath}: legacy transcript-diff recognition must be explicitly compatibility-only`);
  const legacyDeliveryClaimsText = read('packages/main/src/core/legacy-delivery-claims-compat.ts');
  for (const token of ['createLegacyLocalOnlyDeliveryClaims', 'isExactLegacyLocalOnlyDeliveryClaims']) {
    assert(legacyDeliveryClaimsText.includes(token), `dedicated delivery compatibility module must retain ${token}`);
  }
  assert(trustText.includes('isExactLegacyLocalOnlyDeliveryClaims'), 'closeout trust validator must consume the narrow compatibility validator');
  assert(deliveryText.includes('createLegacyLocalOnlyDeliveryClaims'), 'delivery-context producer must construct claims only through the narrow compatibility function');
  const retiredVocabularyGuardText = read('packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts');
  for (const token of [
    'approvedLegacyDeliveryCompatUsages',
    'scanLegacyDeliveryCompatibilityUsage',
    'scanLegacyDeliveryCompatibilityGraph',
    'unapproved legacy delivery compatibility import',
    'transitive legacy delivery compatibility import',
    'legacy delivery compatibility symbol escape',
    'legacy delivery compatibility alias/export escape',
    'true two-hop consumer import through a patched approved exporter must be caught',
    'ts.createSourceFile',
    'ts.isNoSubstitutionTemplateLiteral',
    'template-literal dynamic import',
    'Unicode-escaped compatibility identifier in an exported wrapper must be decoded and caught',
    'downstream consumer of Unicode-escaped compatibility wrapper must be caught',
    'matchesApprovedCallSite',
    'disallowedCompatibilityValueReferences',
    'scanConcealedCompatibilityLoads',
    'metric-preserving exported wrapper with',
    'concatenated dynamic import',
    'interpolated dynamic import',
    'two-argument dynamic import',
    'knownBenignNonLiteralLoaderCalls',
    'unapproved non-literal dynamic module load',
    'non-literal dynamic imports outside the finite benign call-site allowlist must fail closed',
    'the exact registered cli-engine non-literal loader call site must remain allowed',
    'a known benign loader expression relocated to another function must fail closed',
    'typeAnalysisFor',
    'sharedProjectProgram',
    'syntheticTypeService',
    'identifierResolvesToBinding',
    'collectConstStringValues',
    'collectLoaderBindings',
    'createRequire alias import',
    'const variable dynamic import',
    'module require import',
    'relocated approved-shaped claims call must fail its canonical declaration anchor',
    'downstream destructuring of relocated claims object must be caught',
    'shadowed same-name identifiers still must not count as references to the compatibility import binding',
    'non-literal loader rejection must be structural and independent of compat-looking identifier spelling',
    'approvedCompatibilityCallShape',
    'assignment to an exported container inside an approved claims property must break the exact canonical parent chain',
    'assignment/comma wrappers around the compatibility constructor must be rejected as noncanonical binding use',
    'namespace createRequire import',
    'wrapper parameter dynamic import',
    'object property dynamic import',
    'destructured path dynamic import',
    'typescript-printer-remove-comments-sha256-v1',
    'canonicalAstFingerprint',
    'PINNED_EXECUTABLE_SOURCE_FINGERPRINTS',
    'validatePinnedExecutableSourceFingerprint',
    'pinned executable source structural fingerprint drift',
    'review executable structure before updating the pinned fingerprint',
    'b2c006a5becbd456a5728bb7615cf999cb514137383bc935b128073240899d98',
    // B-45a0 F-419: lockstep with the reviewed closeout-trust policy that
    // permits only receipt-bound verification_evidence_refresh_stale writes.
    'fb21d100ac76f9211b3311c04c94e7d8856bc974e29292c8b3485cab485263f5',
    '7c345270f67ccc96bde83280cc2cf2fee2d7b7652b15cfc3e1e4b5b7f97c6fd9',
    // B-45a0 F-421: lockstep with the closeout smoke's canonical-writer and
    // noncanonical-writer retention regression checks, and with B-1e1f's
    // (see B-cdf6:F-057 coupling note). B-5a15 F-361: the pin move is NOT
    // persistSyntheticAdmittedWindowForTest (already on main); it is the new canonical
    // writer topology_critic_receipt_set plus its registry row, a
    // deriveCertificationDomainInputHashes fixture, and an acquireOwnerLease seed.
    // F-363: verification_evidence_refresh_stale is NOT a divergence (4 on both branches).
    // Compat counts are PER FILE: core/closeout-trust.ts 2/2; closeout-trust-smoke.ts has
    // createLegacyLocalOnlyDeliveryClaims 2 and ZERO isExactLegacyLocalOnlyDeliveryClaims.
    'ca1a6aa99b2413a4bdfb31fa59c7f327ad55ec837f8107348de68935ee28e22b',
    // B-cdf6 CHK-002: repinned alongside retired-authority-vocabulary-guard-smoke.ts
    // after the user-facing bin rename changed cli-engine.ts hint/error strings.
    //
    // B-cdf6:F-057 follow-on: this is the SECOND copy of that fingerprint. When the
    // guard's own allowlist was repinned I updated only that file, and this verifier —
    // which cross-checks that the guard pins the expected value — kept the old hash and
    // failed closed. The two are coupled by design (the comment above already said so),
    // so they must always move together. Same re-approval basis as the guard: the
    // cli-engine.ts diff vs main touches zero import()/require() calls, arguments or
    // path producers, and the approved loader call site is byte-identical to main.
    // Moved again with the guard by commit 32a083b987 (delivery-review follow-up:
    // one diagnostic string + a BRAND_ENV_PREFIX import in cli-engine.ts). This time
    // both copies were updated in the same commit, as the note above requires.
    'b9eb52d027ebe388f6c42117a6ed9fcfafe758c53cc79e8ede61fafecff948f5',
    // B-6693 (merged in) also moved this canonical AST, only to separate
    // direct-validate watchdog cancellation from DONE-result classification.
    // The benign runCli/initPath/import(`file://${initPath}`) call site is unchanged.
    'c13ec647c3fe547c4430390779b28da2620d5db24d8ba8609ec6142968f89739',
    '1bf3f1ebd8b63e66965966228a147748c48370bb6bbdf688ff1be149aa4aa82f',
    'f215f9c4e894a84ba7e2e844324902fcd2dec1e208e4259d64e2c447f1c85a83',
    'post-call assignment of canonical report.claims into an exported container must invalidate the complete importer fingerprint',
    'changing the path producer behind an otherwise identical benign loader call must invalidate its source fingerprint',
    'a nested same-name loader anchor cannot inherit the whole-source fingerprint exemption',
    'destructured createRequire import',
    'bound require import',
    'canonical AST fingerprints must ignore comments and formatting trivia',
    "const EXECUTABLE_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const",
    'executable source discovery must stay aligned with the supported compiler extensions',
    'compatibility constructor body mutation must invalidate its pinned executable fingerprint',
    'compatibility validator body mutation must invalidate its pinned executable fingerprint',
    'compatibility export surface mutation must invalidate its pinned executable fingerprint',
    'compatibility type surface mutation must invalidate its pinned executable fingerprint',
    'direct compatibility bypass in ${extension} must be caught',
    'retired import in ${extension} must be caught',
    'compatibility graph escape in ${extension} must be caught',
    'Pinned fingerprints are validated before compatibility-module early return',
    'replacing a benign loader call with unrecognized executable text must still fail the unconditional fingerprint check',
    'listFilesFromRoot',
    'lstatSync',
    'stat.isSymbolicLink()',
    'alias-before-target and self/back-edge symlinks must be skipped while the canonical target is traversed exactly once',
    'all eight pinned canonical executable paths must be checked exactly once by the canonical scan',
    'SHIPPED_EXECUTABLE_SOURCE_DIRS',
    'SHIPPED_EXECUTABLE_ENTRYPOINTS',
    'SHIPPED_PACKAGE_MANIFESTS',
    'deriveShippedPackageEntrypoints',
    'every package bin/exports target must derive to an explicitly pinned scanned source entrypoint',
    // B-cc10 CHK-007: was "'bin/proofOrStop.js'". CHK-006 DELETED that deprecated bin
    // alias, so requiring the guard to still name it forced the guard to pin a
    // non-existent entrypoint (it failed with "pinned shipped executable entrypoint
    // must exist: bin/proofOrStop.js"). The contract now requires the canonical wrapper,
    // keeping the narrow-compatibility-usage requirement intact against a real file.
    "'bin/proof-or-stop.js'",
    "'bin/bootstrap-runner.js'",
    "'packages/lab/src'",
    "'packages/utils/src'",
    'pinned shipped executable entrypoint must exist',
    'direct bin entrypoint compatibility import must be caught',
    'new shipped executable file must enter import scanning',
    'normalizeStaticModuleSpecifier',
    'decodeURIComponent',
    'malformed encoded static module specifier',
    'query suffix',
    'fragment suffix',
    'percent encoding',
    'CJS query and fragment',
    'percent-encoded query/fragment retired module specifier must be caught',
    'malformed percent-encoded static module specifier must fail closed',
    'DYNAMIC_CODE_GENERATION_FINGERPRINT_EXEMPTIONS',
    'collectDynamicExecutionBindings',
    'dangerousSymbols',
    'exactSafeSymbols',
    'vmNamespaceSymbols',
    'functionCallableSymbols',
    'identifierSymbol',
    'checker.getSymbolAtLocation(node)',
    'symbol?.getDeclarations()',
    'ts.SymbolFlags.Transient',
    'source.hasNoDefaultLib',
    "source.fileName.includes('/node_modules/typescript/lib/lib.')",
    "source.fileName.includes('/node_modules/@types/')",
    'allowJs: true',
    'checkJs: true',
    'scanDynamicCodeGeneration',
    'unapproved dynamic code generation',
    'dynamic code generation compatibility payload',
    'direct eval',
    'indirect eval',
    'aliased eval',
    'Function call',
    'new Function',
    'async constructor',
    'nested local eval alias',
    'nested local vm require alias',
    'nested local AsyncFunction derived constructor',
    'nested bind alias chain',
    'nested global destructure alias',
    'nested vm destructure alias',
    'nested reassignment alias',
    'shadowed local eval',
    'shadowed local Function',
    'shadowed globalThis property',
    'shadowed window property',
    'shadowed vm namespace',
    'shadowed local require',
    'vm namespace',
    'vm named alias',
    'global property eval',
    'window eval property',
    'any executable drift must invalidate the dynamic-code exemption',
    '6db7549862141be655e34094323763762511bd00b05f45af4d77c097c7e0dc4f',
    '6025f602afdc354a31333b61b516cb29aa1b59387806d69e6981d5a9ed3969b7',
    '9d09bfd90b67cfa559095b82c8a7012871f0b4d0d38f7ec68941c4f5d0b5e772',
    "'packages/main/src/handlers/fixture-executors.ts'",
    'aee0b8f72d15f79121d14a4805891fae125b76bc9de1cbe073a28ffe90a8eddf',
    'aee0b8f72d15f79121d14a4805891fae125b76bc9de1cbe073a28ffe90a8eddf',
    'd0fa3e4ebad2c985e96f1faa64cd3ca7eac35492203f0eacc121e260298e715e',
    'the twelve existing exact entries plus the B-49df test-only tracer kernel pin make thirteen; no broad pattern exemptions are allowed',
    'any executable drift revokes the envelope mutation loader fingerprint',
    'mutant path rebound to external input',
    'mutant producer type widened',
    'mutant producer nested shadow',
    'mutant URL helper shadow',
    'BENIGN_NON_LITERAL_LOADER_SOURCE_FINGERPRINTS',
    'd0fa3e4ebad2c985e96f1faa64cd3ca7eac35492203f0eacc121e260298e715e',
    '023017290826cb42ede2577f5e43a20b8f13733fc80599056dcd8367a68f8506',
    'PackageAliasEdge',
    'buildPackageAliasEdgeInventory',
    'PACKAGE_ALIAS_EDGE_INVENTORY',
    'package-imports-self-exports-edge-inventory-sha256-v1',
    '3b484827d8704b3952b2fe20528d24a1e0b569bce8f5a8aaa36f69f321e3f7eb',
    'resolvePackageAlias',
    'unresolved package import/self-reference alias',
    'package imports alias',
    'conditional wildcard package imports alias',
    'package self-reference alias',
    'must resolve end-to-end to the protected source target',
    'changing package imports must change the pinned manifest-derived edge inventory fingerprint',
    'unknown package imports alias must fail closed',
    'ts.isParameter',
    'eval parameter default',
    'vm parameter default',
    'AsyncFunction parameter default',
    'object destructure parameter default',
    'array destructure parameter default',
    'rest-fed array destructure default',
    'shadowed eval parameter default',
    'shadowed vm parameter default',
    'shadowed Function parameter default',
    'functionExpressionConstructorKind',
    'functionDeclarationConstructorKind',
    'functionPrototypeLookupKind',
    'typeHasCallableSignature',
    'typeRequiresFailClosedCallableClassification',
    'constructorReceiverKind',
    'hasExactLocalNonCallableEvidence',
    'checker.getSignaturesOfType(type, ts.SignatureKind.Call)',
    'checker.getSignaturesOfType(type, ts.SignatureKind.Construct)',
    'staticallyCallableKind',
    'ordinary function expression constructor',
    'ordinary function declaration constructor alias',
    'generator function constructor',
    'async generator function constructor',
    'class expression constructor',
    'class declaration constructor',
    'class declaration constructor alias',
    'object method constructor',
    'bound arrow constructor',
    'bound function constructor alias',
    'imported node fs callable constructor',
    'imported callable alias constructor',
    'standard Array map constructor',
    'ambient global callable constructor',
    'resolvable imported local noncallable value',
    'function constructor declaration destructure',
    'function constructor assignment destructure',
    'function constructor parameter destructure',
    'class constructor destructure alias',
    'method constructor destructure',
    'bound callable constructor destructure',
    'local named callable import constructor destructure',
    'local default callable import constructor',
    'local namespace callable import constructor',
    'local noncallable constructor declaration destructure',
    'local noncallable constructor parameter destructure',
    'local named noncallable import destructure',
    'local default noncallable import constructor',
    'for-of eval shadow',
    'for-in Function shadow',
    'switch case eval shadow',
    'catch eval shadow',
    'nested block Function shadow',
    'array declaration eval provenance',
    'array assignment vm provenance',
    'array parameter constructor provenance',
    'nested object declaration constructor provenance',
    'nested object assignment constructor provenance',
    'nested object parameter constructor provenance',
    'array declaration noncallable provenance',
    'nested object assignment noncallable provenance',
    'nested object parameter shadow default',
    'classic for initializer eval shadow',
    'classic for local require shadow',
    'for-of local require shadow',
    'for-in local require shadow',
    'enum eval identity shadow',
    'namespace Function identity shadow',
    'array rest declaration relative index provenance',
    'array rest assignment relative index provenance',
    'array rest parameter relative index provenance',
    'nested object array rest provenance',
    'nonliteral array rest element provenance',
    'globalThis object rest declaration provenance',
    'globalThis object rest assignment provenance',
    'globalThis object rest parameter provenance',
    'callable constructor object rest provenance',
    'nonliteral object rest eval type provenance',
    'nonliteral object rest vm type provenance',
    'unknown object rest property access fail closed',
    'nonliteral array rest dynamic index provenance',
    'any array rest dynamic index fail closed',
    'record eval object rest dynamic key provenance',
    'record eval computed binding provenance',
    'any object rest dynamic key fail closed',
    'non-indexable object rest dynamic key fail closed',
    'plain any nested array rest known index fail closed',
    'known any object declaration fail closed',
    'known any object assignment fail closed',
    'known any object parameter fail closed',
    'known unknown object declaration fail closed',
    'known unknown object assignment fail closed',
    'known unknown object parameter fail closed',
    'known any array declaration fail closed',
    'known any array assignment fail closed',
    'known any array parameter fail closed',
    'known unknown array declaration fail closed',
    'known unknown array assignment fail closed',
    'known unknown array parameter fail closed',
    'empty string direct member provenance',
    'empty string const alias provenance',
    'empty string object rest provenance',
    'record eval exact numeric member fallback',
    'record eval exact string member fallback',
    'safe then unknown rest assignment provenance',
    'unknown then safe rest assignment provenance',
    'literal array spread declaration provenance',
    'typed array spread assignment provenance',
    'typed array spread parameter provenance',
    'literal object spread declaration provenance',
    'literal object spread assignment provenance',
    'literal object spread parameter provenance',
    'typed record object spread provenance',
    'typed finite object spread direct provenance',
    'typed finite object spread destructured provenance',
    'typed symbol object spread provenance',
    'typed symbol object spread destructured provenance',
    'mapped global eval object spread provenance',
    'ambient mapped eval object spread provenance',
    'safe then dangerous literal spread override',
    'safe then typed spread remains conservative',
    'nested any array rest declaration fail closed',
    'nested any array rest assignment fail closed',
    'nested any array rest parameter fail closed',
    'nested unknown array rest declaration fail closed',
    'nested unknown array rest assignment fail closed',
    'nested unknown array rest parameter fail closed',
    'nested any rest declaration fail closed',
    'nested unknown rest assignment fail closed',
    'nested unknown rest parameter fail closed',
    'global dangerous eval named member',
    'global dangerous Function named member',
    'global dangerous vm API named member',
    'global dangerous constructor named member',
    'typeof narrowed direct eval remains dangerous',
    'typeof narrowed global eval remains dangerous',
    'typeof narrowed eval alias remains dangerous',
    'typeof narrowed Function alias remains dangerous',
    'typeof narrowed vm alias remains dangerous',
    'typeof narrowed constructor alias remains dangerous',
    'local require direct eval bridge fail closed',
    'local require member Function bridge fail closed',
    'local require destructured vm bridge fail closed',
    'require alias direct bridge fail closed',
    'require alias member bridge fail closed',
    'require alias destructured bridge fail closed',
    'module require direct bridge fail closed',
    'module require member bridge fail closed',
    'module require destructured bridge fail closed',
    'const specifier require bridge fail closed',
    'dynamic specifier require bridge fail closed',
    'createRequire direct bridge fail closed',
    'createRequire member bridge fail closed',
    'createRequire destructured bridge fail closed',
    'parameter loader bridge fail closed',
    'passed parameter loader bridge fail closed',
    'bound require direct bridge fail closed',
    'bound require member bridge fail closed',
    'bound require destructured bridge fail closed',
    'bound module require bridge fail closed',
    'namespace createRequire direct bridge fail closed',
    'namespace createRequire member bridge fail closed',
    'namespace createRequire destructured bridge fail closed',
    'cjs destructured createRequire direct bridge fail closed',
    'cjs destructured createRequire member bridge fail closed',
    'cjs destructured createRequire destructured bridge fail closed',
    'arrow parameter loader bridge fail closed',
    'function expression parameter loader bridge fail closed',
    'method parameter loader bridge fail closed',
    'aliased callable parameter loader bridge fail closed',
    'esm named eval bridge fail closed',
    'esm named Function bridge fail closed',
    'esm named vm bridge fail closed',
    'esm default eval bridge fail closed',
    'esm default Function bridge fail closed',
    'esm default vm bridge fail closed',
    'esm namespace eval bridge fail closed',
    'esm namespace Function bridge fail closed',
    'esm namespace vm bridge fail closed',
    'dynamic import namespace eval bridge fail closed',
    'dynamic import destructured Function bridge fail closed',
    'dynamic import default vm bridge fail closed',
    'dynamic import aliased promise bridge fail closed',
    'dynamic import unknown namespace fail closed',
    'esm export star bridge fail closed',
    'esm named reexport bridge fail closed',
    'esm namespace reexport bridge fail closed',
    'esm imported namespace reexport bridge fail closed',
    'esm default namespace reexport bridge fail closed',
    'esm conditional export danger wins',
    'esm logical export danger wins',
    'esm cyclic export graph danger wins',
    'promise all namespace eval bridge fail closed',
    'promise all destructured Function bridge fail closed',
    'promise all nested vm bridge fail closed',
    'esm reexported createRequire bridge fail closed',
    'esm export star createRequire bridge fail closed',
    'cjs property createRequire bridge fail closed',
    'cjs two step createRequire bridge fail closed',
    'new URL eval bridge fail closed',
    'pathToFileURL object Function bridge fail closed',
    'namespace file URL vm bridge fail closed',
    'file URL query eval bridge fail closed',
    'comma safe left dangerous right fail closed',
    'comma imported safe left dangerous right fail closed',
    'nested static namespace eval bridge fail closed',
    'nested dynamic namespace vm bridge fail closed',
    'nested default namespace Function bridge fail closed',
    'bound module require member bridge fail closed',
    'bound module require destructured bridge fail closed',
    'arrow parameter loader member bridge fail closed',
    'arrow parameter loader destructured bridge fail closed',
    'function expression parameter loader member bridge fail closed',
    'function expression parameter loader destructured bridge fail closed',
    'method parameter loader member bridge fail closed',
    'method parameter loader destructured bridge fail closed',
    'aliased parameter loader member bridge fail closed',
    'aliased parameter loader destructured bridge fail closed',
    'promise all variable array nonzero Function fail closed',
    'promise all variable array danger first fail closed',
    'promise all omitted slot fail closed',
    'promise all unresolved selected slot fail closed',
    'promise all spread vm fail closed',
    'promise race eval fail closed',
    'dynamic import then identity fail closed',
    'then returned eval fail closed',
    'then block returned Function fail closed',
    'then destructured eval callback fail closed',
    'then Promise resolve eval fail closed',
    'then async Function fail closed',
    'then dangerous thenable callback fail closed',
    'catch returned eval fail closed',
    'finally safe callback preserves danger fail closed',
    'finally no callback preserves danger fail closed',
    'promise any danger second fail closed',
    'promise any unresolved fail closed',
    'promise allSettled value fail closed',
    'promise allSettled reason fail closed',
    'dynamic import assignment before await fail closed',
    'inline conditional eval target fail closed',
    'inline logical Function target fail closed',
    'inline await import eval member fail closed',
    'inline nested await import vm member fail closed',
    'new URL href eval bridge fail closed',
    'aliased URL href Function bridge fail closed',
    'conditional nested namespace reassignment danger first',
    'conditional nested namespace reassignment danger last',
    'cyclic nested namespace eval fail closed',
    'logical and namespace reassignment fail closed',
    'logical or namespace reassignment fail closed',
    'logical nullish namespace reassignment fail closed',
    'logical and assignment namespace fail closed',
    'logical or assignment namespace fail closed',
    'logical nullish assignment namespace fail closed',
    'unicode escaped global property eval and payload',
    'hex escaped global Function and payload',
    'constructed computed eval target fail closed',
    'const bound escaped eval and payload fail closed',
    'static computed eval declaration provenance',
    'static computed eval assignment provenance',
    'const computed eval parameter provenance',
    'numeric computed eval provenance',
    'negative zero computed eval provenance',
    'NaN computed eval provenance',
    'Infinity computed eval provenance',
    'enum constant computed eval provenance',
    'const computed vm provenance',
    'const computed constructor provenance',
    'unresolved computed global fail closed',
    'array rest local noncallable negative',
    'array rest omitted local noncallable negative',
    'nonliteral array rest noncallable negative',
    'nonliteral array rest dynamic index noncallable negative',
    'object rest local noncallable negative',
    'object rest excluded eval negative',
    'object rest local constructor negative',
    'nonliteral object rest noncallable negative',
    'record number object rest dynamic key negative',
    'record number computed binding negative',
    'non-indexable object rest known member negative',
    'stable single complete rest safe member negative',
    'empty string local safe member negative',
    'record number exact numeric member negative',
    'record number exact string member negative',
    'dangerous spread then explicit safe override negative',
    'typed spread then explicit safe override negative',
    'function spread inherited constructor negative',
    'typed finite safe object spread negative',
    'typed finite safe object spread destructured negative',
    'typed symbol safe object spread negative',
    'typed symbol safe object spread destructured negative',
    'mapped safe object spread negative',
    'ambient mapped safe object spread negative',
    'literal array spread local safe negative',
    'literal object spread local safe negative',
    'complete local dangerous-name callables negative',
    'local eval direct safe negative',
    'local Function direct safe negative',
    'local runInContext direct safe negative',
    'local constructor direct safe negative',
    'typeof narrowed local callback safe negative',
    'local eval rest safe negative',
    'local Function rest safe negative',
    'local runInContext rest safe negative',
    'local constructor rest safe negative',
    'local eval destructured safe negative',
    'local Function destructured safe negative',
    'local runInContext destructured safe negative',
    'local constructor destructured safe negative',
    'known safe object declaration negative',
    'known safe object assignment negative',
    'known safe object parameter negative',
    'known safe array declaration negative',
    'known safe array assignment negative',
    'known safe array parameter negative',
    'nested array rest declaration local safe negative',
    'nested array rest assignment local safe negative',
    'nested array rest parameter local safe negative',
    'typed local require member safe negative',
    'typed local require destructured safe negative',
    'require alias typed safe negative',
    'module require typed safe negative',
    'const specifier require typed safe negative',
    'dynamic specifier require typed safe negative',
    'createRequire typed safe negative',
    'parameter loader typed safe negative',
    'passed parameter loader typed safe negative',
    'bound require typed safe negative',
    'bound module require typed safe negative',
    'namespace createRequire typed safe negative',
    'cjs destructured createRequire typed safe negative',
    'arrow parameter loader typed safe negative',
    'function expression parameter loader typed safe negative',
    'method parameter loader typed safe negative',
    'aliased callable parameter loader typed safe negative',
    'esm named local callback safe negative',
    'esm default local callback safe negative',
    'esm namespace local callback safe negative',
    'dynamic import namespace local callback safe negative',
    'dynamic import destructured local callback safe negative',
    'esm export star local callback safe negative',
    'esm cyclic export graph local callback safe negative',
    'esm reserved names named local safe negative',
    'esm reserved Function local safe negative',
    'esm reserved names namespace local safe negative',
    'esm reserved names default local safe negative',
    'esm reserved names reexport local safe negative',
    'bound module require direct typed safe negative',
    'bound module require destructured typed safe negative',
    'arrow parameter loader direct typed safe negative',
    'arrow parameter loader destructured typed safe negative',
    'function expression parameter loader direct typed safe negative',
    'function expression parameter loader destructured typed safe negative',
    'method parameter loader direct typed safe negative',
    'method parameter loader destructured typed safe negative',
    'aliased parameter loader direct typed safe negative',
    'aliased parameter loader destructured typed safe negative',
    'promise all namespace local callback safe negative',
    'promise all destructured local callback safe negative',
    'esm reexported createRequire typed safe negative',
    'cjs property createRequire typed safe negative',
    'cjs two step createRequire typed safe negative',
    'new URL local callback safe negative',
    'pathToFileURL object local callback safe negative',
    'namespace file URL local callback safe negative',
    'file URL query local callback safe negative',
    'comma dangerous left safe right negative',
    'comma imported dangerous left safe right negative',
    'nested static namespace local callback safe negative',
    'nested dynamic namespace local callback safe negative',
    'promise all variable array safe negative',
    'promise all spread safe negative',
    'promise race safe negative',
    'dynamic import then identity safe negative',
    'then returned local callback safe negative',
    'catch returned local callback safe negative',
    'finally returned eval ignored safe negative',
    'finally no callback safe negative',
    'then destructured safe callback negative',
    'then Promise resolve safe callback negative',
    'then async local callback safe negative',
    'then safe thenable callback negative',
    'promise any safe negative',
    'promise allSettled value safe negative',
    'inline conditional safe target negative',
    'inline await import safe member negative',
    'inline nested await import safe member negative',
    'new URL href safe negative',
    'aliased URL href safe negative',
    'deterministic final safe namespace reassignment negative',
    'nested default namespace safe negative',
    'cyclic nested namespace safe negative',
    'escaped local property safe negative',
    'logical conditional then final safe namespace negative',
    'bound global require direct safe negative',
    'bound global require destructured safe negative',
    'namespace createRequire direct safe negative',
    'namespace createRequire destructured safe negative',
    'cjs createRequire direct safe negative',
    'cjs createRequire destructured safe negative',
    'nested rest declaration local safe negative',
    'nested rest assignment local safe negative',
    'nested rest parameter local safe negative',
    'const computed local noncallable negative',
    'unresolved computed exact local negative',
    'safe named object property eval fail closed',
    'namespace safe named reexport eval benign fail closed',
    'parameter eval callsite fail closed',
    'parameter merged callsites danger wins',
    'local literal safe named member negative',
    'parameter local safe callsite negative',
    'mutable callable reassigned eval fail closed',
    'mutable callable conditional eval fail closed',
    'function declaration reassigned eval fail closed',
    'local method reassigned eval fail closed',
    'parameter call eval fail closed',
    'parameter apply eval fail closed',
    'parameter bind eval fail closed',
    'parameter partial bind eval fail closed',
    'parameter invocation shapes danger wins',
    'rest parameter index eval fail closed',
    'rest parameter destructured eval fail closed',
    'rest parameter multiple danger wins',
    'mutable callable deterministic final safe negative',
    'local method deterministic final safe negative',
    'parameter call local safe negative',
    'parameter apply local safe negative',
    'parameter bind local safe negative',
    'rest parameter index local safe negative',
    'rest parameter destructured local safe negative',
    'rest parameter mixed local safe negative',
    'default parameter overridden eval fail closed',
    'optional parameter eval fail closed',
    'optional parameter local safe negative',
    'computed call eval fail closed',
    'computed apply eval fail closed',
    'computed bind eval fail closed',
    'unknown computed invocation eval fail closed',
    'spread direct eval fail closed',
    'spread tuple wrapper eval fail closed',
    'spread typed tuple eval fail closed',
    'spread unknown array eval fail closed',
    'spread call eval fail closed',
    'spread prebound bind eval fail closed',
    'full vector spread call eval fail closed',
    'full vector spread apply eval fail closed',
    'computed full vector spread bind eval fail closed',
    'full vector spread invocation danger wins',
    'chained bind safe then eval unknown spread fail closed',
    'chained bind eval then safe unknown spread fail closed',
    'spread default override eval fail closed',
    'spread rest mixed danger wins',
    'computed call local safe negative',
    'computed apply local safe negative',
    'computed bind local safe negative',
    'spread direct local safe negative',
    'spread rest mixed local safe negative',
    'full vector spread call local safe negative',
    'full vector spread apply local safe negative',
    'computed full vector spread bind local safe negative',
    'walkPattern',
    'DynamicProvenance',
    'constantPropertyKey',
    'javascriptPropertyKey',
    'staticPropertyKeyExpression',
    "Object.is(value, -0) ? '0' : String(value)",
    'provenanceForExpression',
    'indexProvenance',
    'arrayRest',
    'objectRest',
    'unresolved-computed-key',
    'memberKinds',
    'indexKinds',
    'knownMembers',
    'knownMembersComplete',
    'safeMemberOverrides',
    'ModuleLoadSource',
    'collectLoaderBindings',
    'isCollectedLoaderExpression',
    'classifyModuleLoad',
    'provenanceForExportSymbol',
    'namespaceImportProvenance',
    'namespaceForModuleSymbol',
    'staticRuntimeModulePath',
    'sourceFileForRuntimeModulePath',
    'mergeAlternativeProvenance',
    'alternativeCarriesDynamicIdentity',
    'dynamicBindingsCache',
    'dynamicBindingBuilds',
    'dynamicBindingBuildFiles',
    'dynamicBindingCacheHits',
    'provenanceBySymbol',
    'boundExpressionProvenance',
    'symbolResolvesToCreateRequire',
    'moduleObjectSymbols',
    'importedNodeHelperExpression',
    'DYNAMIC_CODE_ANALYSIS_PREFILTER',
    'DYNAMIC_PROVENANCE_REACHABILITY_LABELS',
    'DYNAMIC_CODE_UNAPPROVED_ONLY_LABELS',
    'hasDynamicExecutionAstCandidate',
    'emptyDynamicExecutionBindings',
    'isExactLocalSafeExecutionTarget',
    'trustedRuntimeDeclaration',
    'symbolHasMutableWrites',
    'exactSafeMutableWriteCache',
    'orderedFinalProvenance',
    'node.expression.kind === ts.SyntaxKind.ImportKeyword',
    'exactSafe',
    'executionBindings',
    'dynamicFullAnalysisScans',
    'dynamicAstCandidateScans',
    'dynamicPrefilterSkips',
    'dynamicReachabilityAssertions',
    'dynamicFullAnalysisByFile',
    'callbackParameterProvenance',
    'foldStrings',
    'exactlyLocalCallable',
    '__forceFullProvenanceAnalysis',
    'directBindings',
    'bindCallbackPattern',
    'localCallableDeclarations',
    'bindLocalCallArguments',
    'boundArgumentProvenance',
    'packedArgumentProvenance',
    'normalizedInvocationCallee',
    'InvocationMember',
    'ArgumentVector',
    'mergeArgumentValue',
    'exactSpreadValues',
    'spreadTailValue',
    'flattenCallArguments',
    'vectorFromApplied',
    'argumentVectorValueAt',
    'dropArgumentVectorPrefix',
    'projectInvocationArguments',
    'concatenateArgumentVectors',
    'vectorRestAt',
    'suppliedAt',
    'restAt',
    'thenableResults',
    'unresolved-value-provenance',
    'expressionKind',
    'conditionallyExecuted',
    'aliasSourceCounts',
    'mergeProvenanceAlternatives',
    'conservativeIndexProvenance',
    'mergeConservativeIndex',
    'arrayLength',
    'indexDomains',
    'exactSafePrimitive',
    'isExplicitCompleteLocalSafeMember',
    'member === undefined',
    'unresolved-non-indexable-rest',
    'memberProvenanceKind',
    'constructorTypeKind',
    'createProjectTypeProgram',
    'projectTypeProgramRoots',
    'assertProjectTypeProgramContract',
    'project type program root inventory must include',
    'project type program must load TypeScript default libraries',
    'project type program must enable module resolution',
    'TYPE_RESOLUTION_DIAGNOSTIC_CODES',
    'malformed or unresolved executable type analysis',
    'unresolved relevant module source must fail closed',
    'malformed relevant executable source must fail closed',
    'typeProgramInstrumentation',
    'assertTypeProgramInstrumentation',
    'baseline project Program must construct exactly once per guard scan',
    'overlay Program builds must remain bounded at one',
    'synthetic LanguageService must construct exactly once per guard scan',
    'synthetic LanguageService roots must remain bounded at 36',
    'synthetic LanguageService Program requests must remain bounded at 320',
    'LanguageService getProgram must preserve object identity without a version change',
    'distinct LanguageService Program identities across controlled version changes must remain bounded at 128',
    'object element parameter default without outer default',
    'array element parameter default without outer default',
    'nested object array parameter default',
    'nested rest parameter binding default',
    'shadowed nested object parameter default',
    'shadowed nested rest parameter default',
    'node vm default import',
    'ordinary object constructor',
    'AsyncGeneratorFunction',
    'GeneratorFunction',
  ]) {
    assert(retiredVocabularyGuardText.includes(token), `retired vocabulary guard must enforce narrow compatibility usage: ${token}`);
  }
  const requiredValidationFact = registry.get('artifact:done-required-evidence.json');
  for (const token of ['exact call shape', 'whole-source fingerprint', 'producer provenance', 'Loader admission is not a validation PASS or a dynamic-code exemption']) {
    assert(requiredValidationFact?.rationale.includes(token), `${processFactRegistryPath}: test-only loader admission boundary must remain registered: ${token}`);
  }
  const scopeAckPolicy = parseCommandPolicyEntries().find(entry => entry.name === 'scope_contract_acknowledge');
  assert(scopeAckPolicy && !scopeAckPolicy.allowedPhases.includes('TEST'), `${commandPolicyPath}: scope_contract_acknowledge must remain rejected in TEST`);

  const receiptFact = registry.get('artifact:closeout-write-receipts.jsonl');
  assert(receiptFact?.level === 'L4' && receiptFact?.artifact?.signed === false, `${processFactRegistryPath}: local closeout receipts must remain honestly non-signed while their bounded review-retention use is gate-consumed`);
  assert(receiptFact?.consumerGate?.includes('metadata-only retention') && receiptFact?.artifact?.consumerGate?.includes('metadata-only retention') && receiptFact?.semantics.includes('gate-evidence'), `${processFactRegistryPath}: closeout receipt review-retention consumption must be registered as gate evidence`);
  for (const token of ['cooperative local-runtime lineage', 'registered writer label', 'not same-UID authentication', 'does not approve an artifact', 'artifact gate validation remains independent']) {
    assert(receiptFact?.rationale.includes(token), `${processFactRegistryPath}: closeout lineage rationale missing honest boundary token ${token}`);
  }
  assert(read(lifecycleRegistryPath).includes("'closeout-write-receipts.jsonl'"), `${lifecycleRegistryPath}: receipt ledger must remain classified lifecycle metadata`);
  const lifecycleText = read(lifecycleRegistryPath);
  assert(lifecycleText.includes('REVIEW_RETENTION_PROTOCOL_METADATA_PATHS') && lifecycleText.includes("'prompt-envelopes.json'") && lifecycleText.includes("'process-metrics.json'") && lifecycleText.includes("'test-runs.json'") && lifecycleText.includes("'owner-lease.json'"), `${lifecycleRegistryPath}: non-authoritative review-retention companion metadata must remain closed, prompt-envelope complete, and registry-backed`);
  for (const fact of [
    'runtime:closeout_phase_transition',
    'runtime:closeout_reviewer_reattestation_boundary',
    'runtime:closeout_human_confirmation',
    'runtime:closeout_validation_terminal',
  ]) {
    assert(read(processFactRegistryPath).includes(`name: '${fact}'`), `${processFactRegistryPath}: missing durable closeout convergence fact ${fact}`);
  }
  const reattestationBoundaryFact = registry.get('runtime:closeout_reviewer_reattestation_boundary');
  assert(reattestationBoundaryFact?.level === 'L4', `${processFactRegistryPath}: reviewer re-attestation boundary must remain L4`);
  assert(reattestationBoundaryFact?.producer.includes('review_run_start') && reattestationBoundaryFact?.producer.includes('review_pass_set'), `${processFactRegistryPath}: reviewer re-attestation boundary must identify review run/pass producers`);
  assert(reattestationBoundaryFact?.consumerGate === 'done_prepare convergence acceptance', `${processFactRegistryPath}: reviewer re-attestation boundary must identify the done_prepare consumer`);
  for (const token of ['same attempt', 'materialHash', 'storyFilesHash', 'reviewRound', 'first completed identity per lane', 'ReviewPass.createdAt', 'reviewRunId/pass id tie-breakers', 'independent of run start order', 'completed before TEST entry', 'at or after TEST entry', 'fail-closed']) {
    assert(reattestationBoundaryFact?.rationale.includes(token), `${processFactRegistryPath}: reviewer re-attestation boundary rationale missing ${token}`);
  }
  const validationTerminalFact = registry.get('runtime:closeout_validation_terminal');
  assert(validationTerminalFact?.level === 'L4', `${processFactRegistryPath}: validation terminal convergence fact must remain L4`);
  assert(validationTerminalFact?.consumerGate === 'done_prepare convergence acceptance', `${processFactRegistryPath}: validation terminal convergence fact must identify the done_prepare consumer`);
  for (const token of ['commandSetHash', 'materialHash', 'storyFilesHash', 'unchangedSuiteExecutions', 'at or after TEST entry', 'commandExecutions > 0', 'reviewWindowSuiteExecutions', 'never-blocking']) {
    assert(validationTerminalFact?.rationale.includes(token), `${processFactRegistryPath}: validation terminal rationale missing phase-anchored duplicate-suite token ${token}`);
  }
  // B-f824 cross-host MAJOR: the TEST-boundary suite-execution split is gate
  // semantics, not an implementation detail. Anchor it mechanically: the derive
  // must split blocking executed duplicates at the current TEST entry, and the
  // blocking assert must never consume the whole-window telemetry counter
  // (blocking on it recreated the B-956f closeout deadlock). All checks are
  // AST-scoped (comments are not AST nodes): a comment cannot satisfy the
  // positive anchors or trip the negative one, and F-003 additionally requires
  // the blocking counter in a real throwing if-condition, not dead code.
  const donePrepareConvergenceSf = parseSourceFile('packages/main/src/handlers/done-prepare.ts');
  const convergenceDeriveFn = findFunctionDeclaration(donePrepareConvergenceSf, 'deriveDonePreparePassConvergence');
  assert(convergenceDeriveFn && convergenceDeriveFn.body, 'packages/main/src/handlers/done-prepare.ts: deriveDonePreparePassConvergence function declaration must exist');
  assert(convergenceDeriveFn?.body && hasTestEntryAnchoredComparison(convergenceDeriveFn.body), 'packages/main/src/handlers/done-prepare.ts: convergence derive must anchor blocking duplicate-suite counting at the current TEST entry (a real `<event>.timestamp >= facts.testEntryAt` comparison inside deriveDonePreparePassConvergence; a comment cannot satisfy this)');
  const convergenceAssertFn = findFunctionDeclaration(donePrepareConvergenceSf, 'assertDonePreparePassConvergence');
  assert(convergenceAssertFn && convergenceAssertFn.body, 'packages/main/src/handlers/done-prepare.ts: assertDonePreparePassConvergence function declaration must exist');
  assert(convergenceAssertFn?.body && hasPropertyGuardedThrowingBranch(convergenceAssertFn.body, 'unchangedSuiteExecutions'), 'packages/main/src/handlers/done-prepare.ts: convergence blocking assert must keep post-TEST duplicate-suite executions fail-closed via an if-condition referencing unchangedSuiteExecutions whose then-branch throws (a dead-code reference cannot satisfy this)');
  assert(convergenceAssertFn?.body && !subtreeReferencesProperty(convergenceAssertFn.body, 'reviewWindowSuiteExecutions'), 'packages/main/src/handlers/done-prepare.ts: reviewWindowSuiteExecutions must remain observable never-blocking telemetry; the convergence blocking assert must not consume it (whole-window blocking recreated the B-956f DONE deadlock)');
  assert(read(processFactRegistryPath).includes('...PROCESS_FACT_CLOSEOUT_TELEMETRY'), `${processFactRegistryPath}: durable closeout convergence facts must be included in the final registry`);

  const autoCommitText = read('packages/main/src/core/auto-commit-metadata.ts');
  for (const token of ['closeoutArtifactPaths', 'declaredPaths.has(policy.path)', 'buildCloseoutWriteReceipt', 'appendCloseoutWriteReceipt']) {
    assert(autoCommitText.includes(token), `auto-commit closeout receipt choke point missing ${token}`);
  }
  const closeoutSmokeText = read('packages/main/src/tasks/closeout-trust-smoke.ts');
  for (const exactUserLine of [
    'PASS closeout artifact classifications: closed policy set verified',
    'PASS closeout review retention binds material, story files, scope, round, and stable HEAD',
    'review evidence retained: unchanged reviewed material; artifact gate validation remains independent',
  ]) {
    assert(closeoutSmokeText.includes(`console.log('${exactUserLine}')`), `closeout smoke missing revised exact userSees line: ${exactUserLine}`);
  }
  const machineText = read('packages/main/src/core/machine.ts');
  assert(machineText.includes('collectReviewerEvidenceState') && machineText.includes('[stale_closeout_review]'), 'TEST→DONE guard and failure renderer must consume closeout-aware reviewer evidence freshness');
  assert(machineText.includes('export function evaluateReviewVerdict')
    && /function canPassReviewGuard[\s\S]{0,200}evaluateReviewVerdict\(context\)\.ok/.test(machineText)
    && machineText.includes('const reviewVerdict = evaluateReviewVerdict(context);')
    && machineText.includes('return firstDonePredicateFailure(context) === null;')
    && machineText.includes('return firstDonePredicateFailure({ storyId, store, projectRoot:'),
  'REVIEW→TEST and TEST→DONE boolean/reason paths must share the authoritative reviewer verdict evaluator');
  const doneOracleText = read('packages/main/src/core/done-oracle.ts');
  assert(doneOracleText.includes("const completedSnapshot = store.readStory(storyId).phase === 'DONE' ? options.completedSnapshot : undefined;")
    && doneOracleText.includes('not a fresh reviewer PASS')
    && doneOracleText.includes('full historical reviewer audit'),
  'Only explicit completed DONE snapshots may select historical presentation, which must never claim fresh reviewer admission or a full historical audit');
  for (const token of ['review_round_missing', 'review_evidence_missing', 'review_evidence_invalid', 'review_lane_missing', 'review_quorum', 'review_finding_blocking']) {
    assert(machineText.includes(token), `shared reviewer verdict must preserve ${token}`);
  }
  assert(/if \(!story\.currentReviewRound\)[\s\S]{0,300}review_round_missing/.test(machineText), 'reviewer-required lifecycle verdict must fail closed before legacy evidence validation when currentReviewRound is absent');
  const reviewRunText = read('packages/main/src/core/review-run.ts');
  for (const token of ['evaluateReviewRunMetadataRetention', 'evaluateMetadataOnlyReviewRetention', 'evaluatePersistedReviewToTestIndexTransition', 'changedFilesBetween', 'uncommittedPathsUnder', 'classifyCurrentCloseoutArtifactForReviewRetention', 'storyFilesUnchanged', 'stableEvaluationHead', 'relative(gitRoot, storyDir)', 'not writer authentication', "reviewedStory.phase !== 'REVIEW'", "currentStory.phase !== 'TEST'"]) {
    assert(reviewRunText.includes(token), `review-run metadata retention consumer missing ${token}`);
  }
  const transitionText = read('packages/main/src/handlers/transition-orchestrator.ts');
  assert(transitionText.includes("story.events.push(collectContext(args.phase, 'advance'))"), 'persisted REVIEW-to-TEST retention exception must remain tied to the production collectContext transition shape');
  assert(/if \(args\.phase === 'DONE'\)[\s\S]{0,800}runReviewToTestPreflightGate\(ctx, args\.storyId, actor\)/.test(transitionText), 'DONE must independently re-run REVIEW-to-TEST preflight facts so a manual index phase edit grants no privilege');
  assert(reviewRunText.includes('isReviewRetentionProtocolMetadataPath') && !reviewRunText.includes("'process-metrics.json'"), 'review-run must consume the lifecycle registry instead of maintaining a local protocol ignore list');
  for (const [handlerPath, writerCommand, artifactPath] of [
    ['packages/main/src/handlers/proofstory.ts', 'parent_ledger_rollup_set', 'parent-ledger-rollup.json'],
    ['packages/main/src/handlers/delivery-context-pack.ts', 'delivery_context_pack', 'evidence/delivery-context-pack.json'],
    ['packages/main/src/handlers/verifier.ts', 'validate', 'test-evidence.json'],
    ['packages/main/src/handlers/test.ts', 'test_add', 'test-evidence.json'],
    ['packages/main/src/handlers/test-story.ts', 'test_story', 'test-evidence.json'],
    ['packages/main/src/handlers/done-required-validation.ts', 'done_required_validate', 'done-required-evidence.json'],
    ['packages/main/src/handlers/delivery-check.ts', 'delivery_check_set', 'delivery-check.json'],
    ['packages/main/src/handlers/delivery-check.ts', 'delivery_waiver_add', 'delivery-check.json'],
    ['packages/main/src/handlers/evaluate.ts', 'evaluate_save', 'eval-evidence.json'],
    ['packages/main/src/handlers/summary.ts', 'summary_set', 'summary.json'],
    ['packages/main/src/handlers/live-smoke-transcript.ts', 'live_smoke_transcript', 'evidence/live-smoke-transcript.json'],
  ]) {
    const handlerText = read(handlerPath);
    assert(handlerText.includes(`'${writerCommand}'`) && handlerText.includes('closeoutArtifactPaths') && handlerText.includes(artifactPath), `${handlerPath}: ${writerCommand} must explicitly attest its just-written closeout artifact ${artifactPath}`);
  }
  const closeoutConsumerMatrix = [
    {
      artifact: 'test-evidence.json',
      path: 'packages/main/src/core/done-oracle.ts',
      validators: ['readTestEvidence', 'checkEvidenceFreshness'],
    },
    {
      artifact: 'done-required-evidence.json',
      path: 'packages/main/src/core/done-oracle.ts',
      validators: ['evaluateDoneRequiredEvidence'],
    },
    {
      artifact: 'delivery-check.json',
      path: 'packages/main/src/core/machine.ts',
      validators: ['evaluateDeliveryCheckFreshness', 'evaluateReviewVerdict'],
    },
    {
      artifact: 'evidence/live-smoke-transcript.json',
      path: 'packages/main/src/core/machine.ts',
      validators: ['evaluateOptionalLiveSmokeTranscript', 'evaluateReviewVerdict'],
    },
    {
      artifact: 'summary.json',
      path: 'packages/main/src/core/done-oracle.ts',
      validators: ['readSummary', 'summary.changes', 'summary.usage', 'summary.acceptanceVerdict'],
    },
  ];
  for (const consumer of closeoutConsumerMatrix) {
    const consumerText = read(consumer.path);
    for (const validator of consumer.validators) {
      assert(consumerText.includes(validator), `${consumer.path}: ${consumer.artifact} consumer must retain specialized validator ${validator}`);
    }
    for (const forbidden of ['latestCausallyValidCloseoutReceipt', 'CLOSEOUT_WRITE_RECEIPTS_PATH']) {
      assert(!consumerText.includes(forbidden), `${consumer.path}: ${consumer.artifact} consumer must not treat review-retention lineage as artifact approval (${forbidden})`);
    }
  }
  const closeoutTrustText = read('packages/main/src/core/closeout-trust.ts');
  for (const removedHelper of ['latestValidCloseoutReceipt', 'validateCurrentCloseoutArtifact']) {
    assert(!closeoutTrustText.includes(removedHelper), `closeout trust must not expose unused pseudo-authority helper ${removedHelper}`);
  }
  const packageText = read('package.json');
  const rootPackage = JSON.parse(packageText);
  const canonicalRoutineIncludes = (pkg, name) => [pkg.scripts?.['test:serial-reference-prefix'], pkg.scripts?.['test:serial-reference']]
    .filter(Boolean).join(' && ').split(/\s*&&\s*/).includes(`npm run ${name}`);
  assert(rootPackage.scripts?.test === 'node packages/main/dist/tasks/full-suite-runner.js' && canonicalRoutineIncludes(rootPackage, 'test:closeout-trust'), 'package.json: closeout trust handler/replay smoke must remain in canonical routine npm test membership');
  assert(!canonicalRoutineIncludes({ scripts: { ...rootPackage.scripts, 'test:serial-reference': rootPackage.scripts['test:serial-reference'].replace('npm run test:closeout-trust', '') } }, 'test:closeout-trust'), 'package.json: deleting closeout trust from the main serial-reference must fail membership');
  assert(!canonicalRoutineIncludes({ scripts: { ...rootPackage.scripts, 'test:serial-reference-prefix': '' } }, 'test:full-suite-runner-smoke'), 'package.json: deleting the prefix serial-reference must fail membership');
}

// ── B-70a6 F-003 (cross-host MAJOR): PLAN->INIT reopen audit semantics ──
// B-8b69 made `transitionType: 'reopen'` and the validated `reason` DURABLE
// semantics of the append-only phase_transition process event, but only the
// registry prose (the guidance half of the CLAUDE.md dual-layer process-fact
// contract) described the event at all — a later refactor could silently drop
// the reopen marker or the reason and this contract still passed, defeating the
// exact audit guarantee the change exists to establish. This is the hardcoded
// mechanical half. Every production check is AST-anchored on the CURRENT SOURCE
// (comments are not AST nodes, and this verifier is source-first by design so a
// stale dist cannot hide drift): deleting the `eventType === 'REOPEN'` gate at
// the call site, dropping the reason, renaming the marker, or making an ordinary
// transition emit either field makes this exit 1.
function assertPhaseTransitionReopenAuditContract() {
  const registry = processFactRegistryMap();
  const phaseTransitionFact = registry.get('runtime:closeout_phase_transition');
  assert(phaseTransitionFact?.level === 'L4', `${processFactRegistryPath}: phase transition convergence fact must remain L4`);
  assert(phaseTransitionFact?.producer === 'handlers/transition-orchestrator', `${processFactRegistryPath}: phase transition fact must identify the transition-orchestrator producer that emits the reopen audit fields`);
  for (const token of [
    'PLAN->INIT',
    'transitionType: "reopen"',
    'reason',
    'REOPEN_REASON_MIN',
    'append-only',
    'ONLY on a REOPEN',
    'omit',
    'not gate evidence',
    // B-70a6 F-004 recovery semantics — the guidance half of the dual-layer
    // contract for the crash window between the phase write and this append.
    'pendingReopenAudit',
    'reopenAuditId',
    'SAME atomic writeStory rename',
    'reconcilePendingReopenAudit',
    'idempotent',
    'exactly once',
    'without appending',
    'neither record nor event',
  ]) {
    assert(phaseTransitionFact?.rationale.includes(token), `${processFactRegistryPath}: phase transition rationale must declare the reopen audit semantics token ${token}`);
  }

  const orchestratorPath = 'packages/main/src/handlers/transition-orchestrator.ts';
  const orchestratorSf = parseSourceFile(orchestratorPath);

  // (1) BUILDER: both audit fields are emitted only when the caller supplies
  // them, and the else branch stays `{}` — an explicit `field: undefined` would
  // add a key and change every ordinary transition's event shape.
  const builderFn = findFunctionDeclaration(orchestratorSf, 'buildPhaseTransitionProcessEvent');
  assert(builderFn?.body, `${orchestratorPath}: buildPhaseTransitionProcessEvent declaration must exist`);
  const builderSpreads = builderFn?.body ? collectConditionalObjectSpreads(builderFn.body) : [];
  for (const field of ['transitionType', 'reason', 'reopenAuditId']) {
    const spread = builderSpreads.find(item => isDefinedCheckOnMember(item.condition, 'input', field));
    assert(spread, `${orchestratorPath}: buildPhaseTransitionProcessEvent must emit ${field} only through a real \`input.${field} !== undefined\` conditional spread (an unconditional property, or a comment, cannot satisfy this)`);
    assert(spread && objectLiteralPropertyInitializer(spread.whenTrue, field), `${orchestratorPath}: buildPhaseTransitionProcessEvent must actually set ${field} in the supplied branch of its conditional spread`);
    assert(spread && isEmptyObjectLiteral(spread.whenFalse), `${orchestratorPath}: buildPhaseTransitionProcessEvent must OMIT ${field} entirely when the caller passes none (the else branch must stay {}; an explicit \`${field}: undefined\` key would change the ordinary transition event shape)`);
  }

  // (2) CALL SITE: a successful REOPEN emits BOTH fields; every ordinary
  // transition emits NEITHER. Only the call-site gate decides that — the builder
  // above emits whatever it is handed.
  const transitionFn = findFunctionDeclaration(orchestratorSf, 'runStoryTransitionInner');
  assert(transitionFn?.body, `${orchestratorPath}: runStoryTransitionInner declaration must exist`);
  const builderCall = transitionFn?.body ? findCallExpressionByName(transitionFn.body, 'buildPhaseTransitionProcessEvent') : undefined;
  assert(builderCall, `${orchestratorPath}: runStoryTransitionInner must append the phase_transition event through buildPhaseTransitionProcessEvent`);
  const callSpreads = builderCall?.arguments?.[0] ? collectConditionalObjectSpreads(builderCall.arguments[0]) : [];
  const reopenSpread = callSpreads.find(item => isIdentifierEqualsStringLiteral(item.condition, 'eventType', 'REOPEN'));
  assert(reopenSpread, `${orchestratorPath}: the phase_transition call site must gate the reopen audit fields on a real \`eventType === 'REOPEN'\` condition — without that gate either every ordinary transition carries the reopen marker or no reopen does`);
  const markerInit = reopenSpread ? objectLiteralPropertyInitializer(reopenSpread.whenTrue, 'transitionType') : undefined;
  assert(markerInit && ts.isStringLiteralLike(markerInit) && markerInit.text === 'reopen', `${orchestratorPath}: a successful REOPEN must emit the exact marker transitionType: 'reopen' in its phase_transition event`);
  const reasonInit = reopenSpread ? objectLiteralPropertyInitializer(reopenSpread.whenTrue, 'reason') : undefined;
  assert(reasonInit && subtreeReadsMember(reasonInit, 'args', 'reason'), `${orchestratorPath}: a successful REOPEN must persist the validated args.reason next to the marker (a validated-but-dropped reason is not durably auditable)`);
  const auditIdInit = reopenSpread ? objectLiteralPropertyInitializer(reopenSpread.whenTrue, 'reopenAuditId') : undefined;
  assert(auditIdInit && subtreeReadsMember(auditIdInit, 'reopenAudit', 'auditId'), `${orchestratorPath}: a successful REOPEN must stamp its recovery record's auditId onto the event (without that key, recovery cannot tell "my event is already on disk" from "it is missing" and can double-emit)`);
  assert(reopenSpread && isEmptyObjectLiteral(reopenSpread.whenFalse), `${orchestratorPath}: an ordinary transition must omit ALL reopen audit fields (the non-REOPEN branch of the call-site spread must stay {})`);

  // (3) The persisted reason is the VALIDATED one: the PLAN->INIT remap that
  // mints eventType='REOPEN' must still reject a missing/too-short reason before
  // the REOPEN event can be sent, so no under-length reason can reach the event.
  let reopenRemap;
  const findRemap = (n) => {
    if (reopenRemap) return;
    if (ts.isIfStatement(n) && subtreeAssignsIdentifierString(n.thenStatement, 'eventType', 'REOPEN')) { reopenRemap = n; return; }
    ts.forEachChild(n, findRemap);
  };
  if (transitionFn?.body) findRemap(transitionFn.body);
  assert(reopenRemap, `${orchestratorPath}: the gated PLAN->INIT reopen remap (a real \`eventType = 'REOPEN'\` assignment) must exist`);
  assert(reopenRemap && subtreeHasMemberEqualsString(reopenRemap.expression, 'phase', 'INIT') && subtreeHasMemberEqualsString(reopenRemap.expression, 'phase', 'PLAN'), `${orchestratorPath}: the REOPEN remap must stay bound to the PLAN->INIT shape (args.phase === 'INIT' && story.phase === 'PLAN')`);
  assert(reopenRemap && hasIdentifierGuardedThrowingBranch(reopenRemap.thenStatement, 'REOPEN_REASON_MIN'), `${orchestratorPath}: the REOPEN remap must keep the reason requirement fail-closed (an if-condition referencing REOPEN_REASON_MIN whose then-branch throws) so the reason persisted into the audit event is the validated one`);

  // ── B-70a6 F-004: the audit event must survive a crash between the phase
  // write and the append. The event is appended AFTER (and outside) the persist
  // claim, so that window is real; because REOPEN only fires FROM PLAN, a lost
  // event used to be UNRECOVERABLE. Checks (5)-(7) pin the recovery design:
  // ATOMIC record, ordered reconciliation, exact-identity idempotency.

  // (5) ATOMICITY: the recovery record must ride the SAME single writeStory
  // (tmp-write + renameSync) that persists phase=INIT. A record written by its
  // own second write would simply re-open the same crash window.
  const persistWrites = transitionFn?.body ? collectMemberCalls(transitionFn.body, 'store', 'writeStory') : [];
  assert(persistWrites.length === 1, `${orchestratorPath}: runStoryTransitionInner must keep EXACTLY ONE store.writeStory (the single atomic rename the reopen recovery record rides); found ${persistWrites.length}`);
  const phaseWrite = persistWrites[0];
  assert(phaseWrite && phaseWrite.arguments.length === 2 && ts.isIdentifier(phaseWrite.arguments[1]) && phaseWrite.arguments[1].text === 'story', `${orchestratorPath}: the phase write must persist the same \`story\` object the reopen recovery record is attached to`);
  const inventoryConsumes = transitionFn?.body ? collectCallExpressionsByName(transitionFn.body, 'consumeReviewInventoryReceipt') : [];
  assert(inventoryConsumes.length === 1 && phaseWrite && inventoryConsumes[0].end < phaseWrite.end,
    `${orchestratorPath}: REVIEW inventory receipt must be consumed exactly once BEFORE store.writeStory publishes phase=DEV`);
  const reopenRecordBranch = transitionFn?.body
    ? findIfStatement(transitionFn.body, (n) => isIdentifierEqualsStringLiteral(n.expression, 'eventType', 'REOPEN')
        && Boolean(findMemberAssignment(n.thenStatement, 'story', 'pendingReopenAudit')))
    : undefined;
  assert(reopenRecordBranch, `${orchestratorPath}: a REOPEN must attach its durable recovery record via a real \`story.pendingReopenAudit = ...\` assignment under a real \`eventType === 'REOPEN'\` branch — without it a crash before the append leaves an unaudited, unrecoverable reopen`);
  const recordAssignment = reopenRecordBranch ? findMemberAssignment(reopenRecordBranch.thenStatement, 'story', 'pendingReopenAudit') : undefined;
  assert(recordAssignment && phaseWrite && recordAssignment.end < phaseWrite.end, `${orchestratorPath}: the recovery record must be attached BEFORE the phase write so both land in the SAME atomic rename (attaching it afterwards persists nothing)`);
  assert(reopenRecordBranch && collectMemberCalls(reopenRecordBranch.thenStatement, 'store', 'writeStory').length === 0, `${orchestratorPath}: the recovery record must NOT be persisted by a write of its own — a second writeStory re-opens exactly the crash window this record closes`);

  // (6) ORDERED RECONCILIATION: a transition heals a crash-interrupted reopen
  // BEFORE it touches its own state, and retires the record only AFTER the event
  // is durable. That ordering is the guarantee AT THIS CALL SITE: no ORCHESTRATED
  // phase change can follow an unaudited reopen, and no record is dropped before
  // its event exists. Out-of-band writers get only the narrower, unserialized
  // version of it — see assertReopenAuditConcurrencyResidualContract.
  const reconcileCalls = transitionFn?.body ? collectCallExpressionsByName(transitionFn.body, 'reconcilePendingReopenAudit') : [];
  assert(reconcileCalls.length >= 2, `${orchestratorPath}: runStoryTransitionInner must both RECOVER an interrupted reopen at entry and RETIRE its own record after the append (found ${reconcileCalls.length} reconcilePendingReopenAudit call sites)`);
  const transitionAppends = transitionFn?.body ? collectMemberCalls(transitionFn.body, 'store', 'appendProcessEvent') : [];
  assert(transitionAppends.length === 1, `${orchestratorPath}: runStoryTransitionInner must keep exactly one phase_transition append site; found ${transitionAppends.length}`);
  assert(reconcileCalls.length > 0 && phaseWrite && reconcileCalls[0].end < phaseWrite.end, `${orchestratorPath}: the entry reconciliation must run BEFORE this transition's own phase write, so no ORCHESTRATED transition can advance a story while an unaudited reopen is still pending`);
  assert(reconcileCalls.length > 0 && transitionAppends.length > 0 && reconcileCalls[reconcileCalls.length - 1].end > transitionAppends[0].end, `${orchestratorPath}: the recovery record must be retired only AFTER its audit event has been appended (clearing it first re-opens the unrecoverable window)`);

  // (7) THE RECOVERY ITSELF: emits the missing event from the RECORD, guarded by
  // an exact reopenAuditId identity match, and clears only afterwards.
  const reconcileFn = findFunctionDeclaration(orchestratorSf, 'reconcilePendingReopenAudit');
  assert(reconcileFn?.body, `${orchestratorPath}: reconcilePendingReopenAudit declaration must exist (the recovery half of the durable-audit guarantee)`);
  const recoveryBuilderCall = reconcileFn?.body ? findCallExpressionByName(reconcileFn.body, 'buildPhaseTransitionProcessEvent') : undefined;
  assert(recoveryBuilderCall, `${orchestratorPath}: recovery must rebuild the missing event through the SAME buildPhaseTransitionProcessEvent builder as the in-line append`);
  const recoveryArg = recoveryBuilderCall?.arguments?.[0];
  const recoveryMarker = recoveryArg ? objectLiteralPropertyInitializer(recoveryArg, 'transitionType') : undefined;
  assert(recoveryMarker && ts.isStringLiteralLike(recoveryMarker) && recoveryMarker.text === 'reopen', `${orchestratorPath}: a recovered event must still carry the exact marker transitionType: 'reopen'`);
  const recoveryReason = recoveryArg ? objectLiteralPropertyInitializer(recoveryArg, 'reason') : undefined;
  assert(recoveryReason && subtreeReadsMember(recoveryReason, 'pending', 'reason'), `${orchestratorPath}: a recovered event must carry the reason from the RECORD (recomputing or omitting it loses the verbatim operator reason the reopen was gated on)`);
  const recoveryAuditId = recoveryArg ? objectLiteralPropertyInitializer(recoveryArg, 'reopenAuditId') : undefined;
  assert(recoveryAuditId && subtreeReadsMember(recoveryAuditId, 'pending', 'auditId'), `${orchestratorPath}: a recovered event must carry the record's auditId so a repeated recovery is a no-op instead of a second event`);
  assert(reconcileFn?.body && subtreeComparesMembers(reconcileFn.body, 'reopenAuditId', 'pending', 'auditId'), `${orchestratorPath}: "already audited" must be an EXACT reopenAuditId identity match against the record — matching on reason text would mis-handle two reopens sharing a reason and could swallow the second audit event`);
  const recoveryAppends = reconcileFn?.body ? collectMemberCalls(reconcileFn.body, 'store', 'appendProcessEvent') : [];
  assert(recoveryAppends.length === 1, `${orchestratorPath}: reconcilePendingReopenAudit must have exactly one append site; found ${recoveryAppends.length}`);
  const guardedRecoveryAppend = reconcileFn?.body
    ? findIfStatement(reconcileFn.body, (n) => collectMemberCalls(n.thenStatement, 'store', 'appendProcessEvent').length === 1)
    : undefined;
  assert(guardedRecoveryAppend, `${orchestratorPath}: the recovery append must be GUARDED by the already-audited check — an unconditional append would emit a second audit event every time reconciliation runs`);
  assert(guardedRecoveryAppend && ts.isPrefixUnaryExpression(guardedRecoveryAppend.expression) && guardedRecoveryAppend.expression.operator === ts.SyntaxKind.ExclamationToken, `${orchestratorPath}: the recovery append must be guarded by a NEGATED already-audited condition (append only when no matching event exists)`);
  assert(reconcileFn?.body && subtreeDeletesMember(reconcileFn.body, 'pendingReopenAudit'), `${orchestratorPath}: reconciliation must actually clear the recovery record (a record that is never cleared makes every later transition re-scan and never converges)`);
  const recoveryWrites = reconcileFn?.body ? collectMemberCalls(reconcileFn.body, 'store', 'writeStory') : [];
  assert(recoveryWrites.length === 1 && recoveryAppends.length === 1 && recoveryWrites[0].end > recoveryAppends[0].end, `${orchestratorPath}: the recovery record must be cleared only AFTER its event is durably appended — clearing first would lose the reason if the append then failed`);

  // (8) Executable coverage anchors for the same facts, so the structural checks
  // above are not the only proof: flow-stability-smoke (routine npm test) pins
  // the ordinary builder output shape by deepEqual, and the reopen roundtrip
  // smoke asserts key presence/absence on REAL persisted events plus the
  // fault-injected crash-window recovery end to end.
  const flowStabilityText = read('packages/main/src/tasks/flow-stability-smoke.ts');
  assert(/assert\.deepEqual\(buildPhaseTransitionProcessEvent\(/.test(flowStabilityText) && !/transitionType/.test(flowStabilityText), 'packages/main/src/tasks/flow-stability-smoke.ts: the ordinary phase_transition builder shape must stay pinned by deepEqual with NO reopen audit keys');
  const reopenSmokeText = read('packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts');
  for (const token of [
    "assert.equal(reopenEvent.transitionType, 'reopen'",
    'assert.equal(reopenEvent.reason, REOPEN_REASON',
    "hasOwnProperty.call(normalEvent, 'transitionType'), false",
    "hasOwnProperty.call(normalEvent, 'reason'), false",
    // B-70a6 F-004: the crash window is proven by fault injection into the real
    // path, not by hand-written fixture state. B-70a6 F-010 folded the F-004
    // drill's own copy of that injection into the SHARED crashInjectReopen helper,
    // so the same guarantee is now pinned across the two halves: the drill must
    // inject the crash WITH ITS OWN REASON through the helper, and the helper must
    // drive the REAL orchestrator and check the record carries that reason verbatim.
    'class CrashBeforeReopenAuditStore extends StoryStore',
    'await crashInjectReopen(wt, storyId, CRASH_REOPEN_REASON)',
    'await runStoryTransition(ctx, { storyId, phase: \'INIT\', reason })',
    'assert.ok(pending,',
    'assert.equal(pending!.reason, reason',
    "assert.equal(pending.fromPhase, 'PLAN'",
    'assert.equal(recovered.length, 1',
    'assert.equal(recovered[0].reason, CRASH_REOPEN_REASON',
    'assert.equal(recovered[0].reopenAuditId, pending.auditId',
  ]) {
    assert(reopenSmokeText.includes(token), `packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts: end-to-end reopen audit assertion missing ${token}`);
  }
  assert(/assertReopenAuditCrashRecovery\(\)/.test(reopenSmokeText) && /^await assertReopenAuditCrashRecovery\(\);$/m.test(reopenSmokeText), 'packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts: the crash-window recovery drill must actually RUN (a defined-but-uncalled test proves nothing)');
  // B-70a6 F-010: ONE crash-injection implementation, not two. Every drill goes
  // through crashInjectReopen, so a change to how the crash is injected cannot be
  // applied to one copy and silently missed on the other.
  const crashInjectionSites = reopenSmokeText.split('new CrashBeforeReopenAuditStore(').length - 1;
  assert(crashInjectionSites === 1, `packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts: the reopen crash injection must have exactly ONE implementation (the shared crashInjectReopen helper); found ${crashInjectionSites} \`new CrashBeforeReopenAuditStore(\` sites — a second copy is free to drift from the first`);
}

/**
 * B-70a6 F-005: OUT-OF-BAND phase mutations must rescue a pending reopen audit
 * BEFORE they destroy the record that carries it.
 *
 * F-004's reconciliation sits at the top of runStoryTransitionInner, which only
 * covers phase changes that GO THROUGH the orchestrator. story_discard and the
 * story_reconcile zombie repair write story.phase directly, land the story in a
 * TERMINAL phase, and (for discard) force-delete the worktree + branch that hold
 * the record — so the loss there was permanent, not deferred. This is the
 * hardcoded mechanical half of that guarantee: the checks are AST-anchored and
 * ORDERING-anchored, so moving either rescue after the destructive steps, or
 * dropping the doomed-copy search that makes it work at all, exits 1.
 */
function assertOutOfBandReopenAuditRescueContract() {
  const registry = processFactRegistryMap();
  const phaseTransitionFact = registry.get('runtime:closeout_phase_transition');
  for (const token of [
    'OUT-OF-BAND PHASE MUTATIONS',
    'story_discard',
    'story_reconcile',
    'reconcileReopenAuditBeforeOutOfBandPhaseChange',
    'BEFORE their destructive steps',
    'DOOMED copy',
    'SURVIVING store',
    'never blocks',
    'DUPLICATE event sharing one auditId',
    '--purge',
    // B-70a6 F-008: the "surfaced, never swallowed" half of that promise, and its
    // ONE deliberate exception, are declared — not left to the code to imply.
    'no-op rather than a failure',
    // B-70a6 F-012: the purge claim stays at the precision that was actually
    // verified (the rescued event does not survive; the directory may).
    'predates the rescue',
  ]) {
    assert(phaseTransitionFact?.rationale.includes(token), `${processFactRegistryPath}: phase transition rationale must declare the out-of-band rescue semantics token ${token}`);
  }

  // (1) THE RESCUE ITSELF: it must delegate to the one reconciliation function,
  // never grow an append site of its own (two append sites = two idempotency
  // rules that can drift), and must not throw the caller's operation away.
  const orchestratorPath = 'packages/main/src/handlers/transition-orchestrator.ts';
  const orchestratorSf = parseSourceFile(orchestratorPath);
  const rescueFn = findFunctionDeclaration(orchestratorSf, 'reconcileReopenAuditBeforeOutOfBandPhaseChange');
  assert(rescueFn?.body, `${orchestratorPath}: reconcileReopenAuditBeforeOutOfBandPhaseChange must exist — it is what extends the "no unaudited reopen" invariant to phase writes that bypass the orchestrator, at the SEQUENTIAL strength documented on it (see assertReopenAuditConcurrencyResidualContract)`);
  const rescueDelegations = rescueFn?.body ? collectCallExpressionsByName(rescueFn.body, 'reconcilePendingReopenAudit') : [];
  assert(rescueDelegations.length >= 2, `${orchestratorPath}: the out-of-band rescue must delegate to reconcilePendingReopenAudit for BOTH the surviving-store record and the doomed-copy record (found ${rescueDelegations.length} delegations)`);
  assert(rescueFn?.body && collectMemberCalls(rescueFn.body, 'store', 'appendProcessEvent').length === 0, `${orchestratorPath}: the out-of-band rescue must NOT append the audit event itself — a second append site would let its idempotency rule drift from reconcilePendingReopenAudit's`);
  const doomedRead = rescueFn?.body ? findNewExpressionByName(rescueFn.body, 'StoryStore') : undefined;
  assert(doomedRead, `${orchestratorPath}: the rescue must open the DOOMED copy's own store (\`new StoryStore(recordRoot)\`) — story_discard's runtime root is redirected to the MAIN root, so without this it can never SEE the record it is supposed to save`);
  const rescueDoomedDelegation = rescueDelegations[rescueDelegations.length - 1];
  assert(rescueDoomedDelegation && rescueDoomedDelegation.arguments.length === 3, `${orchestratorPath}: the doomed-copy delegation must pass the record READ from the doomed copy while appending to the SURVIVING store (reconcilePendingReopenAudit(store, storyId, doomed))`);

  // (1b) B-70a6 F-008: the rescue's contract is "never thrown, always SURFACED".
  // The doomed-copy read — the one most likely to hit a permission error or a
  // corrupted-but-present index.json — was a bare `catch { continue; }` that
  // silently reported "nothing to rescue" for a real failure, which is the same
  // operator-invisible loss the rescue exists to prevent. Every catch inside the
  // rescue must therefore BIND its error and reach a warnings.push; the deliberate
  // silence for a doomed copy that holds no metadata at all is allowed only as a
  // guarded branch INSIDE such a catch, never as a bare swallow.
  const rescueCatchClauses = [];
  const collectCatchClauses = (n) => {
    if (ts.isCatchClause(n)) rescueCatchClauses.push(n);
    ts.forEachChild(n, collectCatchClauses);
  };
  if (rescueFn?.body) collectCatchClauses(rescueFn.body);
  assert(rescueCatchClauses.length >= 2, `${orchestratorPath}: the out-of-band rescue must keep its failure handling for BOTH the surviving-index reconciliation and the doomed-copy read (found ${rescueCatchClauses.length} catch clauses)`);
  for (const clause of rescueCatchClauses) {
    assert(clause.variableDeclaration, `${orchestratorPath}: every catch in the out-of-band rescue must BIND its error — a bare \`catch {}\` cannot report what actually went wrong`);
    assert(collectMemberCalls(clause.block, 'warnings', 'push').length > 0, `${orchestratorPath}: every catch in the out-of-band rescue must push a warning for the caller to surface (a swallowed read failure is indistinguishable from "there was nothing to rescue", which is exactly the silent loss this rescue is about)`);
  }

  // (2) THE TWO CALL SITES: each must run the rescue BEFORE it destroys anything
  // and BEFORE its own phase write. Ordering IS the guarantee.
  const outOfBandSites = [
    {
      path: 'packages/main/src/handlers/worktree.ts',
      fn: 'story_discard',
      phase: 'DISCARDED',
      // Every call that can destroy the copy holding the record.
      destructive: ['worktreeRemoveWithRetry', 'removePathWithTimeout', 'rmSync', 'pruneWorktreeRegistry'],
    },
    {
      path: 'packages/main/src/handlers/story-query.ts',
      fn: 'story_reconcile',
      phase: 'DONE',
      destructive: ['rmSync'],
    },
  ];
  for (const site of outOfBandSites) {
    const sf = parseSourceFile(site.path);
    const fnNode = findFunctionLike(sf, site.fn);
    assert(fnNode?.body, `${site.path}: ${site.fn} must exist (it is one of the two out-of-band story.phase writers)`);
    const rescueCalls = collectCallExpressionsByName(fnNode.body, 'reconcileReopenAuditBeforeOutOfBandPhaseChange');
    assert(rescueCalls.length === 1, `${site.path}: ${site.fn} must call reconcileReopenAuditBeforeOutOfBandPhaseChange exactly once before mutating story.phase; found ${rescueCalls.length}`);
    // `assert` ACCUMULATES failures here rather than throwing, so every check
    // below must survive a missing call site (otherwise a deleted rescue reports
    // a TypeError instead of the finding it is supposed to name).
    const rescueCall = rescueCalls[0];
    if (!rescueCall) continue;
    const rescueArg = rescueCall.arguments?.[0];
    assert(rescueArg && objectLiteralHasProperty(rescueArg, 'store'), `${site.path}: ${site.fn} must hand the rescue the SURVIVING store (that is where the audit event has to land)`);
    const recordRootsArg = rescueArg ? objectLiteralPropertyInitializer(rescueArg, 'recordRoots') : undefined;
    assert(recordRootsArg && ts.isArrayLiteralExpression(recordRootsArg) && recordRootsArg.elements.length > 0, `${site.path}: ${site.fn} must pass a non-empty recordRoots array (the doomed worktree copy) — dropping it silently reduces the rescue to a no-op for exactly the case the finding reproduced`);

    const phaseAssignment = findMemberAssignment(fnNode.body, 'story', 'phase');
    assert(phaseAssignment, `${site.path}: ${site.fn} must still contain the out-of-band \`story.phase = '${site.phase}'\` assignment this contract is about`);
    assert(Boolean(phaseAssignment) && rescueCall.end < phaseAssignment.pos, `${site.path}: ${site.fn} must rescue the pending reopen audit BEFORE it writes the terminal phase — after it, the record is already unreachable and the reopen is unaudited forever`);
    const phaseWrites = collectMemberCalls(fnNode.body, 'store', 'writeStory');
    assert(phaseWrites.length > 0 && rescueCall.end < phaseWrites[0].pos, `${site.path}: ${site.fn} must rescue the pending reopen audit BEFORE its own store.writeStory`);
    for (const destructive of site.destructive) {
      for (const call of collectCallExpressionsByName(fnNode.body, destructive)) {
        assert(rescueCall.end < call.pos, `${site.path}: ${site.fn} must rescue the pending reopen audit BEFORE the destructive \`${destructive}\` call — that call can delete the only copy holding the record`);
      }
    }
    // The rescue must be SURFACED. A silent rescue repeats the finding's core
    // complaint (silent loss) in a nicer costume.
    assert(collectCallExpressionsByName(fnNode.body, 'renderOutOfBandReopenAuditNotice').length === 1, `${site.path}: ${site.fn} must surface the rescue to the operator through renderOutOfBandReopenAuditNotice`);
  }

  // (3) EXECUTABLE COVERAGE: the ordering checks above are structural, so the
  // end-to-end drills must exist AND run. Each destroys the record-holding copy
  // for real and then asserts the event survived in the surviving log.
  const reopenSmokeText = read('packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts');
  for (const token of [
    // F-005a: the reviewer's exact repro (force discard from inside the worktree).
    "runBoth(wt, 'story_discard', { storyId, force: true",
    'assert.equal(existsSync(wt), false',
    'assert.equal(survived[0].reopenAuditId, pending.auditId',
    // F-005b: the second out-of-band site.
    "runBoth(root, 'story_reconcile', { dryRun: false }",
    "assert.equal(new StoryStore(root).readStory(storyId).phase, 'DONE'",
    // F-006: idempotency by auditId identity is NOT idempotency by reason text.
    'const SHARED_REOPEN_REASON',
    'assert.equal(events.length, 2',
    'assert.equal(new Set(events.map(e => e.reopenAuditId)).size, 2',
  ]) {
    assert(reopenSmokeText.includes(token), `packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts: out-of-band / same-reason drill assertion missing ${token}`);
  }
  for (const drill of [
    'assertReopenAuditSurvivesStoryDiscard',
    'assertReopenAuditSurvivesZombieReconcile',
    'assertSameReasonReopensAreAuditedSeparately',
  ]) {
    assert(new RegExp(`^await ${drill}\\(\\);$`, 'm').test(reopenSmokeText), `packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts: the ${drill} drill must actually RUN (a defined-but-uncalled test proves nothing)`);
  }
  // A discard/reconcile that a rescue could BLOCK would be a worse regression
  // than the audit loss, so both drills pin the success exit code too.
  assert(/assert\.equal\(discard\.code, 0/.test(reopenSmokeText), 'packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts: the discard drill must assert story_discard still SUCCEEDS (the rescue must never block a legitimate discard)');
  assert(/assert\.equal\(reconcile\.code, 0/.test(reopenSmokeText), 'packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts: the zombie drill must assert story_reconcile still SUCCEEDS (the rescue must never block a legitimate repair)');
}

/**
 * B-70a6 F-013: the out-of-band rescue's guarantee is SEQUENTIAL, and every layer
 * that states it must state it at that strength.
 *
 * THE FINDING. `reconcileReopenAuditBeforeOutOfBandPhaseChange` is a ONE-TIME
 * SCAN that holds no per-story transition lock, so it serializes against nothing:
 * a PLAN->INIT reopen can pass the scan before writing its recovery record, land
 * that record in the worktree, and lose it when story_discard removes the
 * worktree a moment later — leaving neither record nor event. The rescue is still
 * a strict improvement (before it there was no rescue at all), so what was wrong
 * was the STRENGTH OF THE CLAIM, not the code. The engineering decision was to
 * NAME the residual rather than force a lock in; the reasons for THAT decision
 * are asserted separately by assertReopenAuditLockRejectionRationaleContract
 * below, because B-70a6 F-014 found one of the three originally recorded here
 * (an argument about the 15s transition-cas persist claim) was aimed at a
 * primitive nobody proposed using.
 *
 * THIS IS THE MECHANICAL HALF OF THAT DECISION (the F-003 lesson). A narrowed
 * claim that only lives in prose can be silently re-inflated by the next
 * refactor, which is exactly how this story got bitten three times. So: the
 * residual must be DECLARED in the registry and next to each site that relies on
 * it, and the absolute formulation ("no phase change can follow an unaudited
 * reopen", with no qualifier) must NOT come back. Restoring the overstated
 * wording — in the registry rationale, in either handler, in the type doc, or in
 * the drill header — exits 1.
 */
function assertReopenAuditConcurrencyResidualContract() {
  const registry = processFactRegistryMap();
  const phaseTransitionFact = registry.get('runtime:closeout_phase_transition');
  for (const token of [
    'CONCURRENCY RESIDUAL (B-70a6 F-013)',
    // The mechanism, not just the word "residual": WHY it does not hold.
    'one-time scan that does not hold the per-story transition lock',
    'neither the record nor the event survives',
    // The narrowed claim itself, and the case it still covers.
    'SEQUENTIAL',
    'not covered',
    // The reasons it is named rather than locked. Each is independently
    // load-bearing: drop one and the decision reads as an excuse.
    'best-effort advisory contention reducer',
    'PROOF_OR_STOP_TEST_DISABLE_TRANSITION_ADVISORY_LOCK',
    'invert the established transitionLock to mainWriteLock order',
    'follow-up story and is not claimed here',
  ]) {
    assert(phaseTransitionFact?.rationale.includes(token), `${processFactRegistryPath}: phase transition rationale must declare the F-013 concurrency residual token ${token} — a rescue documented as stronger than it is is exactly the overclaim this story was bitten by`);
  }

  // The residual must ALSO be where a reader of the CODE meets it: on the rescue
  // itself, at both call sites that depend on it, on the record type, and in the
  // drill header that would otherwise read as proof of a concurrency guarantee.
  const residualMarker = 'CONCURRENCY RESIDUAL (B-70a6 F-013)';
  const orchestratorPath = 'packages/main/src/handlers/transition-orchestrator.ts';
  const residualSites = [
    {
      path: orchestratorPath,
      tokens: [
        residualMarker,
        // The defect in one phrase, plus the two escape hatches that make the
        // lock unusable as a correctness fence.
        'SERIALIZES AGAINST NOTHING',
        'NEITHER the record NOR the event survives',
        'BEST-EFFORT ADVISORY CONTENTION-REDUCER',
        'PROOF_OR_STOP_TEST_DISABLE_TRANSITION_ADVISORY_LOCK',
        'FOLLOW-UP STORY',
      ],
    },
    {
      path: 'packages/main/src/handlers/worktree.ts',
      tokens: [residualMarker, 'ONE-TIME SCAN', 'neither record nor event survives'],
    },
    {
      path: 'packages/main/src/handlers/story-query.ts',
      // The reconcile site carries the ordering reason specifically: it is the
      // one whose lock acquisition would deadlock against the main write lock.
      tokens: [residualMarker, 'ONE-TIME SCAN', 'invert that order'],
    },
    {
      path: 'packages/main/src/core/types.ts',
      tokens: [residualMarker, 'NOT a concurrency guarantee'],
    },
    {
      path: 'packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts',
      // The drills are sequential by construction; saying so stops a later reader
      // from citing them as evidence for the race they never exercise.
      tokens: [residualMarker, 'SEQUENTIAL', 'do NOT prove'],
    },
  ];
  for (const site of residualSites) {
    const text = read(site.path);
    for (const token of site.tokens) {
      assert(text.includes(token), `${site.path}: must document the F-013 concurrency residual (missing ${JSON.stringify(token)}) — the out-of-band reopen-audit rescue is unserialized, and every site that leans on it has to say so`);
    }
  }

  // The residual on the rescue must sit ON the rescue's own docblock, not be
  // parked somewhere else in a 1500-line file where nobody editing it will see it.
  const orchestratorText = read(orchestratorPath);
  const rescueDecl = orchestratorText.indexOf('export function reconcileReopenAuditBeforeOutOfBandPhaseChange');
  assert(rescueDecl !== -1, `${orchestratorPath}: reconcileReopenAuditBeforeOutOfBandPhaseChange must exist`);
  // Anchored to the docblock that immediately precedes the declaration (the last
  // `/**` before it), not to a byte distance: the marker is deliberately
  // cross-referenced from reconcilePendingReopenAudit higher up, and an
  // earliest-occurrence match would be satisfied by that mention alone.
  const docblockStart = rescueDecl === -1 ? -1 : orchestratorText.lastIndexOf('/**', rescueDecl);
  const markerAt = rescueDecl === -1 ? -1 : orchestratorText.lastIndexOf(residualMarker, rescueDecl);
  assert(docblockStart !== -1 && markerAt > docblockStart && markerAt < rescueDecl, `${orchestratorPath}: the F-013 concurrency residual must be documented in the docblock immediately ABOVE reconcileReopenAuditBeforeOutOfBandPhaseChange (a residual filed far from the function it qualifies is one nobody reads before changing it)`);

  // THE RE-INFLATION GUARD. The unqualified invariant is the wording that was
  // false; it must not return. Comment markers are stripped and whitespace
  // collapsed first, so re-wrapping the sentence across lines does not evade it.
  const unqualifiedInvariant = /no phase change can follow an unaudited reopen/i;
  const claimSurfaces = [
    orchestratorPath,
    'packages/main/src/handlers/worktree.ts',
    'packages/main/src/handlers/story-query.ts',
    'packages/main/src/core/types.ts',
    'packages/main/src/tasks/plan-init-reopen-roundtrip-smoke.ts',
    processFactRegistryPath,
  ];
  for (const path of claimSurfaces) {
    const flattened = read(path).replace(/^\s*(?:\/\/|\*)\s?/gm, ' ').replace(/\s+/g, ' ');
    assert(!unqualifiedInvariant.test(flattened), `${path}: states the UNQUALIFIED invariant "no phase change can follow an unaudited reopen". That is false under a concurrent story_discard (B-70a6 F-013): the out-of-band rescue holds no transition lock, so a reopen that records AFTER its scan loses both record and event. Qualify it (e.g. "no ORCHESTRATED phase change ...") and keep the F-013 residual declared`);
  }
}

/** Strip comment markers and collapse whitespace so a re-wrapped sentence cannot evade a token check. */
function flattenComments(text) {
  return text.replace(/^\s*(?:\/\/|\*)\s?/gm, ' ').replace(/\s+/g, ' ');
}

/**
 * B-70a6 F-014: the REASONS recorded for leaving the out-of-band rescue UNLOCKED
 * must be reasons that actually hold.
 *
 * THE FINDING. Three blockers were recorded against giving story_discard the
 * per-story transition lock. A behavior reviewer verified them independently and
 * found the middle one MISDIRECTED: it argued about the transition-cas PERSIST
 * CLAIM (transition-orchestrator.ts — `failFastIfHeld`, `staleMs: 15000`, held
 * for milliseconds across a fully synchronous section), but that claim was never
 * the candidate primitive and nobody proposed reusing it. The candidate is
 * `acquireStoryTransitionLock` (core/story-transition-lock.ts, staleMs 120_000 /
 * deadline 180_000), whose stale threshold is documented as generously exceeding
 * any legitimate long transition — and story_discard's body IS fully synchronous
 * (no `await`; execSync/execFileSync only). The first blocker (advisory lock,
 * env-disableable, so no guarantee can rest on it) was ACCURATE. The third
 * (lock-order inversion) was ACCURATE but is SPECIFIC to story_reconcile, whose
 * repair already runs inside withMainWriteLock; story_discard takes its main
 * write lock only AFTER the rescue and the destruction, so it inverts nothing.
 *
 * WHY THIS IS MECHANISED (the F-003 lesson applied to a rationale rather than to
 * a behaviour). A residual DECLINED for the wrong reason is as dangerous as one
 * that is overclaimed: the next reader either re-litigates a settled question or
 * trusts a decision resting on an argument that does not apply to the site it is
 * filed at. So the corrected reasons — advisory-lock-therefore-no-guarantee,
 * recovery-command-must-not-block, and a site-specific lock order — must be
 * DECLARED in the registry and at both call sites, and the retracted
 * persist-claim argument must not silently come back. Reverting any of it exits 1.
 */
function assertReopenAuditLockRejectionRationaleContract() {
  const registry = processFactRegistryMap();
  const rationale = registry.get('runtime:closeout_phase_transition')?.rationale ?? '';
  for (const token of [
    // The correction is recorded, not quietly swapped in.
    'B-70a6 F-014 corrected the reason',
    'That argument was misdirected',
    // Reason 2, which REPLACED the misdirected one: story_discard is a recovery
    // command and the only exposed acquire shape blocks.
    'recovery command an operator reaches for',
    'exposes no fail-fast option',
    // The alternative that WAS available had to be answered, not ignored.
    'non-blocking try-acquire',
    // Reason 3 stays accurate only while it is scoped to the site it applies to.
    'specific to story_reconcile rather than to story_discard',
  ]) {
    assert(rationale.includes(token), `${processFactRegistryPath}: the phase transition rationale must declare the CORRECTED lock-rejection reason token ${JSON.stringify(token)} (B-70a6 F-014) — a residual declined for a misdirected reason is an overclaim about the decision itself`);
  }
  assert(!rationale.includes('because the authoritative persist claim is a fail-fast 15s claim'), `${processFactRegistryPath}: the phase transition rationale presents the transition-cas persist claim (staleMs 15000) as a REASON the out-of-band rescue is unlocked. B-70a6 F-014: that primitive was never the candidate — acquireStoryTransitionLock (staleMs 120000) is, and it is sized for exactly this kind of long synchronous section. State the reasons that hold`);

  // The same correction must be where a reader of the CODE meets the decision:
  // on the rescue's own docblock and at both call sites that lean on it.
  const orchestratorPath = 'packages/main/src/handlers/transition-orchestrator.ts';
  const orchestratorText = read(orchestratorPath);
  const rescueDecl = orchestratorText.indexOf('export function reconcileReopenAuditBeforeOutOfBandPhaseChange');
  assert(rescueDecl !== -1, `${orchestratorPath}: reconcileReopenAuditBeforeOutOfBandPhaseChange must exist`);
  const rescueDocblock = rescueDecl === -1
    ? ''
    : flattenComments(orchestratorText.slice(orchestratorText.lastIndexOf('/**', rescueDecl), rescueDecl));
  for (const token of [
    'CORRECTED BY B-70a6 F-014',
    'RECOVERY COMMAND',
    // The available alternative had to be ANSWERED, not passed over. `try-acquire`
    // alone is too weak a token (it recurs in the paragraph, so deleting one
    // mention leaves it satisfied), hence the verdict phrase alongside it.
    'try-acquire',
    'was considered and DECLINED',
    'SITE-SPECIFIC',
  ]) {
    assert(rescueDocblock.includes(token), `${orchestratorPath}: the WHY IT IS NAMED RATHER THAN LOCKED docblock on reconcileReopenAuditBeforeOutOfBandPhaseChange must carry the B-70a6 F-014 correction token ${JSON.stringify(token)} — the decision is read HERE, so a stale reason here is the one that misleads`);
  }
  assert(!rescueDocblock.includes('The AUTHORITATIVE fence, the persist claim below'), `${orchestratorPath}: the rescue docblock again gives the transition-cas persist claim as the reason it is unlocked. B-70a6 F-014 retracted that argument: the persist claim was never the candidate primitive (acquireStoryTransitionLock is, and its staleMs is 120000)`);

  const siteTokens = [
    {
      path: 'packages/main/src/handlers/worktree.ts',
      tokens: ['CORRECTED BY B-70a6 F-014', 'RECOVERY COMMAND', 'was considered and declined'],
      // The exact retracted sentence, flattened, so a re-wrapped revert still bites.
      forbidden: 'the authoritative persist claim is a 15s fail-fast claim',
      forbiddenWhy: 'gives the transition-cas persist claim as the reason story_discard is unlocked (B-70a6 F-014 retracted it: that primitive was never the candidate)',
    },
    {
      path: 'packages/main/src/handlers/story-query.ts',
      // The lock-order reason is TRUE here and FALSE at the discard site; the
      // comment has to say which, or it gets copied to the site it does not fit.
      tokens: ['SPECIFIC TO THIS SITE'],
      forbidden: null,
      forbiddenWhy: '',
    },
  ];
  for (const site of siteTokens) {
    const flattened = flattenComments(read(site.path));
    for (const token of site.tokens) {
      assert(flattened.includes(token), `${site.path}: must carry the B-70a6 F-014 lock-rejection correction token ${JSON.stringify(token)} — this call site states why it takes no transition lock, so it is a place the misdirected reason has to be corrected`);
    }
    if (site.forbidden) {
      assert(!flattened.includes(site.forbidden), `${site.path}: ${site.forbiddenWhy}`);
    }
  }

  // B-70a6 F-016: the PendingReopenAudit docblock's own recovery sentence must be
  // accurate on its own, not merely corrected by a paragraph appended after it. A
  // reader who stops at that sentence must not come away with the pre-F-005
  // "some later transition always heals it" impression.
  const typesPath = 'packages/main/src/core/types.ts';
  const typesFlattened = flattenComments(read(typesPath));
  assert(!/emits the missing event on the next transition/i.test(typesFlattened), `${typesPath}: the PendingReopenAudit docblock again says reconcilePendingReopenAudit "emits the missing event on the next transition", unqualified. B-70a6 F-005/F-013: recovery fires at the next ORCHESTRATED transition and at the two out-of-band sites, under no concurrency guarantee — qualify the sentence itself, not only a paragraph after it`);
  for (const token of [
    'ONLY at the points enumerated in the next paragraph',
    'EDITED IN PLACE',
  ]) {
    assert(typesFlattened.includes(token), `${typesPath}: the PendingReopenAudit recovery sentence must carry the B-70a6 F-016 in-place qualification token ${JSON.stringify(token)} (an appended qualifier alone leaves the sentence above it reading as an unconditional promise)`);
  }

  // B-70a6 F-017: the SAME retired wording, at the two IN-FUNCTION comment sites
  // the check above cannot see because it reads types.ts only. Both sat inside
  // runStoryTransitionInner still saying, unqualified, that "the next transition"
  // heals / performs the recovery — the identical over-claim about the identical
  // crash window, untouched by F-005/F-013/F-016 precisely because nothing
  // mechanised them. Recovery is ALSO performed out of band (story_discard, the
  // repairing story_reconcile) and is SEQUENTIAL only, so the unqualified sentence
  // promises more than the code delivers wherever it appears.
  const orchestratorFlattened = flattenComments(orchestratorText);
  for (const retired of [
    'is healed by reconcilePendingReopenAudit on the next transition',
    'the next transition performs the (identical) recovery',
  ]) {
    assert(!orchestratorFlattened.includes(retired), `${orchestratorPath}: the retired unqualified sentence ${JSON.stringify(retired)} is back (B-70a6 F-017). Recovery fires at the next ORCHESTRATED transition AND at the out-of-band rescue (story_discard, the repairing story_reconcile), and only SEQUENTIALLY — a reopen racing a concurrent terminal operation is not recovered at all`);
  }

  // Anchored to each comment's OWN statement, so the qualification has to live at
  // the site a maintainer actually reads, not somewhere else in a 1600-line file.
  const recoveryTimingSites = [
    {
      what: 'the reopen-audit record ATTACH comment (the write that makes a crashed reopen recoverable)',
      from: "// B-70a6 F-004: the gated PLAN->INIT reopen's DURABLE audit record.",
      to: 'let reopenAudit: PendingReopenAudit | undefined;',
    },
    {
      what: 'the reopen-audit record CLEAR comment (the in-line twin of the recovery path)',
      from: '// B-70a6 F-004: the reopen is now durably audited',
      to: 'if (reopenAudit) {',
    },
  ];
  for (const site of recoveryTimingSites) {
    const from = orchestratorText.indexOf(site.from);
    const to = from === -1 ? -1 : orchestratorText.indexOf(site.to, from);
    assert(from !== -1 && to > from, `${orchestratorPath}: could not locate ${site.what} (anchors ${JSON.stringify(site.from)} .. ${JSON.stringify(site.to)}). B-70a6 F-017 guards the recovery-timing wording there — if the code moved, move the anchors with it instead of dropping the guard`);
    if (from === -1 || to <= from) continue;
    // Comment markers stripped and whitespace collapsed FIRST: a raw `includes`
    // over the source walks straight through a comment that merely re-wraps the
    // sentence across two lines (an earlier round of this story hit exactly that).
    const slice = flattenComments(orchestratorText.slice(from, to));
    for (const token of [
      'next ORCHESTRATED transition',
      'reconcileReopenAuditBeforeOutOfBandPhaseChange',
      'story_discard',
      'RACING a concurrent terminal operation is not recovered',
    ]) {
      assert(slice.includes(token), `${orchestratorPath}: ${site.what} must carry the B-70a6 F-017 recovery-timing token ${JSON.stringify(token)} — recovery is not "on the next transition": it is the next ORCHESTRATED transition OR the out-of-band rescue at story_discard / the repairing story_reconcile, and the guarantee is SEQUENTIAL only`);
    }
    assert(!/\bthe next transition\b/i.test(slice), `${orchestratorPath}: ${site.what} again says "the next transition", unqualified (B-70a6 F-017). Write "the next ORCHESTRATED transition" and name the out-of-band rescue, so the sentence is true on its own rather than corrected by a paragraph elsewhere`);
  }
}

function isReviewerPrompt(relPath, text) {
  const name = `${canonicalRoleId(basename(relPath))}.md`;
  return name.startsWith('proof-or-stop-review-') || requiredReviewerRunIdPromptFiles.has(name) || text.includes('review_pass_set');
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
  // `proof-or-stop` is the canonical bin; `proof-or-stop` / `koala` stay accepted so this
  // detector keeps recognizing pre-rename prompt text (B-cdf6 CHK-006).
  const commandPattern = new RegExp(`\\b(?:proof-or-stop|proofOrStop|koala)\\s+${command}\\b`);
  const anyCliCommandPattern = /\b(?:proof-or-stop|proofOrStop|koala)\s+[a-z_][a-z0-9_]*\b/;
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
  const name = `${canonicalRoleId(basename(label))}.md`;
  return reviewPassReviewerPrompts.has(name) || label.startsWith('synthetic-');
}

function requiresNoFindingReviewPassProtocol(label) {
  return canonicalRoleId(basename(label)) !== 'proof-or-stop-evaluator' && requiresReviewPassProtocol(label);
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
    if (hanCharacterPattern.test(name) || (!codeLikeCommandNamePattern.test(name) && !artifactFactNamePattern.test(name))) {
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
  for (const match of text.matchAll(/(?:^|[\s`"'(])((?:\.koala|\.lattice-codex|\.proof-or-stop-codex|\.claude|docs|packages|bin)\/[A-Za-z0-9._/@:-]+(?:\/[A-Za-z0-9._/@:-]+)*)/g)) {
    tokens.add(`path:${match[1].replace(/[),.;:]+$/, '')}`);
  }
  for (const name of ['review_run_start', 'finding_add', 'review_pass_set', 'init_check_set', 'scope_check_save', 'delivery_check_set', 'verification_evidence_add', 'verification_evidence_batch_add']) {
    if (text.includes(name)) tokens.add(`cmd:${name}`);
  }
  return [...tokens].sort();
}

async function comparePromptSemantics(promptMap) {
  const templateDir = 'packages/main/templates/agents';
  // B-cc10 F-055: include the canonical adapter mirror; the renamed one yields nothing.
  // B-cc10 F-056: compare against mirror dirs that EXIST. Listing an absent dir made every
  // role warn 'missing; no semantic drift comparison available' — 17 lines of noise that
  // buried real signal, and (before the canonical dir was added) meant zero mirrors were
  // compared at all while the check still exited 0 because the miss only warn()s.
  const mirrorDirs = ['.claude/agents', '.proof-or-stop-codex/agents', '.proof-or-stop-codex/agents']
    .filter((dir) => existsSync(join(root, dir)));
  const registryModule = await importBuiltModule('packages/main/dist/core/prompt-registry.js');
  if (!registryModule?.readPromptRegistry || !registryModule?.renderPromptEntryForHost) {
    fail('packages/main/dist/core/prompt-registry.js must expose the canonical host prompt renderer');
    return;
  }
  const registryByFile = new Map(
    registryModule.readPromptRegistry().agents.map(entry => [entry.file, entry]),
  );
  const templateFiles = [...promptMap.keys()]
    .filter(relPath => relPath.startsWith(`${templateDir}/`))
    .sort();

  for (const templateRel of templateFiles) {
    const name = `${canonicalRoleId(basename(templateRel))}.md`;
    const entry = registryByFile.get(name);
    if (!entry) {
      fail(`${templateRel} is missing from the canonical prompt registry`);
      continue;
    }
    for (const mirrorDir of mirrorDirs) {
      const mirrorRel = rolePromptPath(mirrorDir, name);
      if (!promptMap.has(mirrorRel)) {
        warn(`${mirrorRel} missing; no semantic drift comparison available`);
        continue;
      }
      if (modularReviewerBootstrapFiles.has(name)) {
        const bootstrap = promptMap.get(mirrorRel);
        if (!bootstrap.includes('review_run_start') || bootstrap.includes('finding_add') || bootstrap.includes('review_pass_set')) {
          fail(`${mirrorRel} must be a body-free reviewer bootstrap that selects exactly one runtime prompt`);
        }
        continue;
      }
      const host = mirrorDir === '.claude/agents' ? 'claude' : 'codex';
      const canonicalTokens = promptSemanticTokens(
        registryModule.renderPromptEntryForHost(entry, host),
      );
      const mirrorTokens = promptSemanticTokens(promptMap.get(mirrorRel));
      const missing = canonicalTokens.filter(token => !mirrorTokens.includes(token));
      const extra = mirrorTokens.filter(token => !canonicalTokens.includes(token));
      if (missing.length || extra.length) {
        const changed = [...missing, ...extra];
        const commandOrPathDrift = changed.some(token => token.startsWith('cmd:') || token.startsWith('path:'));
        const message = `${mirrorRel} command/path semantics drifted from canonical ${host} host render for ${templateRel}; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`;
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
        issues.push(`${label}:${lineNo} active lifecycle docs must use proof-or-stop validate as current primary; koala validate may appear only as a legacy alias/compat reference`);
      }
    }

    const coverageReviewerLane = coverageReviewerLaneNames.find(name => line.includes(name));
    if (!coverageReviewerLane) continue;

    const lineNo = index + 1;
    for (const { label: claimLabel, pattern } of coverageReviewerCliCommandPatterns) {
      if (pattern.test(line)) {
        issues.push(`${label}:${lineNo} ${coverageReviewerLane} must not be documented as a CLI/tool command (${claimLabel})`);
      }
    }

    const context = lines
      .slice(Math.max(0, index - 1), Math.min(lines.length, index + 2))
      .join('\n');
    if (!coverageReviewerLaneContextPattern.test(context)) {
      issues.push(`${label}:${lineNo} ${coverageReviewerLane} must be described as a reviewer agent/lane`);
    }
  }

  return issues;
}

function assertSyntheticAdversarialChecks() {
  const badPassOnlyLines = [
    'proof-or-stop finding_add \'{"storyId":"B-x","desc":"文档一致性检查通过","severity":"low","category":"happy","agent":"proof-or-stop-review-docs"}\'',
    'proof-or-stop finding_add \'{"storyId":"B-x","desc":"consistency check PASSED","severity":"low","category":"happy","agent":"proof-or-stop-review-docs"}\'',
    'proof-or-stop finding_add \'{"storyId":"B-x","desc":"no findings","severity":"low","category":"happy","agent":"proof-or-stop-review-quality"}\'',
    'proof-or-stop finding_add \'{"storyId":"B-x","desc":"PASS","severity":"low","category":"happy","agent":"proof-or-stop-review-quality"}\'',
  ];
  for (const [index, line] of badPassOnlyLines.entries()) {
    assert(
      scanPromptText(line, `synthetic-pass-only-${index}`).some(issue => issue.includes('pass-only finding_add')),
      `synthetic pass-only finding_add prompt ${index + 1} should fail`,
    );
  }
  const multilinePassOnly = [
    "proof-or-stop finding_add '{",
    '  storyId:"B-x",',
    '  desc:"PASS",',
    '  severity:"low",',
    '  category:"happy",',
    '  agent:"proof-or-stop-review-quality"',
    "}'",
  ].join('\n');
  assert(
    scanPromptText(multilinePassOnly, 'synthetic-multiline-pass-only').some(issue => issue.includes('pass-only finding_add')),
    'synthetic multiline pass-only finding_add prompt should fail',
  );

  const noReviewPass = [
    'Use proof-or-stop finding_add for every problem.',
    'No findings. Review passed.',
  ].join('\n');
  assert(
    scanPromptText(noReviewPass, 'synthetic-no-review-pass').some(issue => issue.includes('review_pass_set')),
    'synthetic no-finding prompt without review_pass_set should fail',
  );

  const activeLegacy = 'proof-or-stop finding_add \'{"storyId":"B-x","desc":"cleanup","severity":"medium","category":"cleanup","agent":"proof-or-stop-review-quality"}\'';
  assert(
    scanPromptText(activeLegacy, 'synthetic-active-legacy').some(issue => issue.includes('legacy category')),
    'synthetic active legacy category should fail',
  );
  const multilineLegacy = [
    "proof-or-stop finding_add '{",
    '  storyId:"B-x",',
    '  desc:"real issue",',
    '  severity:"medium",',
    '  category:"cleanup",',
    '  agent:"proof-or-stop-review-quality"',
    "}'",
  ].join('\n');
  assert(
    scanPromptText(multilineLegacy, 'synthetic-multiline-legacy').some(issue => issue.includes('legacy category')),
    'synthetic multiline legacy category should fail',
  );

  const unknownCategory = 'proof-or-stop finding_add \'{"storyId":"B-x","desc":"docs","severity":"medium","category":"docs","agent":"proof-or-stop-review-quality"}\'';
  assert(
    scanPromptText(unknownCategory, 'synthetic-unknown-category').some(issue => issue.includes('unknown category')),
    'synthetic unknown category should fail',
  );
  const literalReviewRunId = 'proof-or-stop finding_add \'{"storyId":"B-x","reviewRunId":"B-x:RR-001","desc":"real issue","severity":"medium","category":"missing","agent":"proof-or-stop-review-quality"}\'';
  assert(
    scanPromptText(literalReviewRunId, 'synthetic-literal-review-run-id').some(issue => issue.includes('hard-coded RR-001')),
    'synthetic literal RR-001 reviewer command should fail',
  );
  const missingFindingReviewRunId = 'proof-or-stop finding_add \'{"storyId":"B-x","desc":"real issue","severity":"medium","category":"missing","agent":"proof-or-stop-review-quality"}\'';
  assert(
    scanPromptText(missingFindingReviewRunId, 'packages/main/templates/agents/proof-or-stop-review-story-init.md')
      .some(issue => issue.includes('finding_add example must include reviewRunId')),
    'synthetic reviewer finding_add JSON example without reviewRunId should fail',
  );
  const missingPassReviewRunId = 'proof-or-stop review_pass_set \'{"storyId":"B-x","agent":"proof-or-stop-review-quality","note":"quality review passed: checked changed files and found no blocker."}\'';
  assert(
    scanPromptText(missingPassReviewRunId, 'packages/main/templates/agents/proof-or-stop-evaluator.md')
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
    "proof-or-stop finding_add '{",
    '  storyId:"B-x",',
    '  desc:"real issue",',
    '  severity:"medium",',
    '  category:"docs",',
    '  agent:"proof-or-stop-review-quality"',
    "}'",
  ].join('\n');
  assert(
    scanPromptText(multilineUnknown, 'synthetic-multiline-unknown').some(issue => issue.includes('unknown category')),
    'synthetic multiline unknown category should fail',
  );

  const goodPrompt = [
    'proof-or-stop review_run_start \'{"storyId":"B-x","agent":"proof-or-stop-review-quality"}\'',
    'proof-or-stop finding_add \'{"storyId":"B-x","reviewRunId":"<reviewRunId from review_run_start>","desc":"real issue","severity":"medium","category":"missing","agent":"proof-or-stop-review-quality"}\'',
    'proof-or-stop review_pass_set \'{"storyId":"B-x","agent":"proof-or-stop-review-quality","reviewRunId":"<reviewRunId from review_run_start>","note":"quality review passed: checked changed files and found no blocker."}\'',
  ].join('\n');
  assert(scanPromptText(goodPrompt, 'synthetic-good').length === 0, 'synthetic good prompt should pass');

  const localizedAgentPlaceholder = 'proof-or-stop review_run_start \'{"storyId":"B-x","agent":"<本 reviewer 名>"}\'';
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
    '    replacement: `Use proof-or-stop validate --story=<storyId> and record verificationEvidence`,',
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

  const badCoverageToolDoc = '| `proof-or-stop-review-test-coverage` | 检查 verificationIntent 覆盖 |';
  assert(
    scanActiveLifecycleDocText(badCoverageToolDoc, 'synthetic-coverage-tool-doc').some(issue => issue.includes('CLI/tool command')),
    'synthetic coverage reviewer documented as a tool table row should fail',
  );

  const badCoverageBareDoc = '`proof-or-stop-review-test-coverage` checks coverage.';
  assert(
    scanActiveLifecycleDocText(badCoverageBareDoc, 'synthetic-coverage-bare-doc').some(issue => issue.includes('reviewer agent/lane')),
    'synthetic bare coverage reviewer name without reviewer/lane context should fail',
  );

  const goodCoverageLaneDoc = 'reviewer lane `proof-or-stop-review-test-coverage` checks verificationIntent coverage and uses review_pass_set when no blocker exists.';
  assert(
    scanActiveLifecycleDocText(goodCoverageLaneDoc, 'synthetic-coverage-good-doc').length === 0,
    'synthetic coverage reviewer lane wording should pass',
  );

  const badKoalaValidatePrimaryDoc = 'TEST 阶段运行 `koala validate`，写 validation evidence。';
  assert(
    scanActiveLifecycleDocText(badKoalaValidatePrimaryDoc, 'synthetic-koala-validate-primary-doc').some(issue => issue.includes('proof-or-stop validate as current primary')),
    'synthetic active lifecycle doc that documents koala validate as current primary should fail',
  );

  const goodKoalaValidateAliasDoc = 'TEST 阶段运行 `proof-or-stop validate`（legacy alias: `koala validate`），写 validation evidence。';
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

function findBalancedCloseIndex(text, openIndex, openChar, closeChar) {
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
    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function extractNamedFunctionBody(text, functionName) {
  const declaration = new RegExp(`\\bfunction\\s+${functionName}\\s*\\(`).exec(text);
  if (!declaration) return null;
  const paramsStart = text.indexOf('(', declaration.index);
  const paramsEnd = findBalancedCloseIndex(text, paramsStart, '(', ')');
  if (paramsEnd < 0) return null;
  const bodyStart = text.indexOf('{', paramsEnd);
  if (bodyStart < 0) return null;
  const bodyEnd = findBalancedCloseIndex(text, bodyStart, '{', '}');
  if (bodyEnd < 0) return null;
  return text.slice(bodyStart + 1, bodyEnd);
}

function validationPersistenceTransactionIssues(verifierText) {
  const issues = [];
  const writerCallCount = [...verifierText.matchAll(/\bcommitValidationReuseMetadataTransaction\s*\(/g)].length;
  if (writerCallCount !== 2) {
    issues.push(`verifier must contain exactly two canonical validation transaction writer calls; found ${writerCallCount}`);
  }

  const localContracts = [
    {
      functionName: 'reusedStoryValidationResult',
      evidenceWriter: 'args.ctx.store.writeTestEvidence',
    },
    {
      functionName: 'persistStoryValidationEvidence',
      evidenceWriter: 'ctx.store.writeTestEvidence',
    },
  ];
  for (const contract of localContracts) {
    const body = extractNamedFunctionBody(verifierText, contract.functionName);
    if (!body) {
      issues.push(`verifier must declare ${contract.functionName}`);
      continue;
    }
    for (const token of [
      contract.evidenceWriter,
      'recordValidationTerminal',
      'commitValidationReuseMetadataTransaction',
      "reason: 'validate'",
      'transaction',
      "closeoutArtifactPaths: ['test-evidence.json']",
    ]) {
      if (!body.includes(token)) {
        issues.push(`${contract.functionName} must locally bind canonical validation persistence token "${token}"`);
      }
    }
  }
  return issues;
}

function assertValidationPersistenceTransactionContract() {
  const verifierPath = 'packages/main/src/handlers/verifier.ts';
  const verifierText = read(verifierPath);
  for (const issue of validationPersistenceTransactionIssues(verifierText)) {
    fail(`${verifierPath}: ${issue}`);
  }

  const executedBody = extractNamedFunctionBody(verifierText, 'persistStoryValidationEvidence');
  assert(Boolean(executedBody), 'validation persistence contract self-test requires the executed-validation function');
  if (!executedBody) return;
  const mutatedExecutedBody = executedBody.replace(
    'commitValidationReuseMetadataTransaction',
    'removedValidationTransactionWriter',
  );
  assert(
    mutatedExecutedBody !== executedBody,
    'validation persistence contract self-test must remove the executed-validation writer',
  );
  const mutatedVerifier = verifierText.replace(executedBody, mutatedExecutedBody);
  const mutationIssues = validationPersistenceTransactionIssues(mutatedVerifier);
  assert(
    mutationIssues.some(issue => issue.includes('persistStoryValidationEvidence'))
      && mutationIssues.some(issue => issue.includes('exactly two')),
    'validation persistence contract bite must fail when executed persistence is deleted while reuse persistence remains',
  );
}

function assertReviewInventoryRemediationContract() {
  const transitionPath = 'packages/main/src/handlers/transition-orchestrator.ts';
  const transitionText = read(transitionPath);
  assert(
    /captureEvidenceHashSnapshot[\s\S]*materialDirtyFiles\.length\s*>\s*0[\s\S]*REVIEW_INVENTORY_REMEDIATION_BLOCKED/.test(transitionText),
    `${transitionPath}: REVIEW to DEV must reject dirty story material before consuming the finalized inventory receipt`,
  );

  const epochPath = 'packages/main/src/core/review-inventory-epoch.ts';
  const epochText = read(epochPath);
  assert(
    /const runPasses = passes\.filter\([\s\S]*?verifyReviewPass\(run\.storyId, pass\)[\s\S]*?Boolean\(pass\.readManifest\)[\s\S]*?Boolean\(pass\.readLog\)/.test(epochText),
    `${epochPath}: inventory PASS coverage requires both signed read fields`,
  );
  assert(
    /const inventoryCriticRuns = candidates\.filter\([\s\S]*?canonicalAgentRoleId\(run\.lane\)[\s\S]*?run\.reviewPurpose === 'inventory-completeness'[\s\S]*?inventoryPurposeMatchesEpoch\(run\.inventoryBinding, args\.epoch\)[\s\S]*?for \(const run of inventoryCriticRuns\)[\s\S]*?evidenceForRun\(run, args\.passes, args\.findings, args\.promptStore\)\.findings[\s\S]*?rawFindings\.set\(finding\.id, finding\)/.test(epochText),
    `${epochPath}: exact inventory aggregate must include signed current purpose-bound critic discoveries without lane promotion`,
  );
  assert(
    /\['verified_family',\s*'duplicate',\s*'not_verified'\]\.includes\(row\.disposition\)/.test(epochText),
    `${epochPath}: critic finding dispositions must be runtime-enumerated and reject unknown values`,
  );

  const dispatchPath = 'packages/main/src/handlers/story-dispatch.ts';
  const dispatchText = read(dispatchPath);
  assert(
    /promptBuilder\s*===\s*'topology-critic-review'[\s\S]*targetKind:\s*'topology-critic-review'[\s\S]*reviewRound/.test(dispatchText),
    `${dispatchPath}: topology critic dispatch must persist its dedicated target kind and current review-round binding`,
  );

  assert(
    dispatchText.includes("args.reviewPurpose === 'inventory-completeness'")
      && dispatchText.includes('requireInventoryCriticSubjectLocked(ctx, args.storyId, args.inventoryEpochId!)')
      && dispatchText.includes('withReviewInventoryMutationLock(store, args.storyId')
      && dispatchText.includes('const authorityBinding = topologyAuthorityDispatchBinding(story, true)')
      && dispatchText.includes("reviewPurpose: 'inventory-completeness', inventoryBinding, reviewerResponsibility"),
    `${dispatchPath}: inventory-only critic dispatch requires signed current OPEN context and leaves topology provenance strict`,
  );
  assert(
    read('packages/main/src/core/process-fact-registry.ts').includes('inventory receipts never substitute for topology proof'),
    'process-fact registry must distinguish inventory completeness and topology proof authority',
  );
  for (const rolePath of [
    'packages/main/templates/agents/proof-or-stop-review-topology-critic.md',
    '.proof-or-stop-codex/agents/proof-or-stop-review-topology-critic.md',
    '.claude/agents/proof-or-stop-review-topology-critic.md',
  ]) {
    const role = read(rolePath);
    assert(role.includes('Inventory completeness only') && role.includes('review_inventory_critic_set')
      && role.includes('Return after completing the inventory responsibility.')
      && role.includes('topology_critic_receipt_set'),
    `${rolePath}: critic instructions must follow the dispatched responsibility and preserve topology rules`);
  }

  const reviewRunPath = 'packages/main/src/core/review-run.ts';
  const reviewRunText = read(reviewRunPath);
  assert(
    /canonicalLane\s*===\s*'proof-or-stop-review-topology-critic'\s*\?\s*'topology-critic-review'\s*:\s*'story-review'/.test(reviewRunText),
    `${reviewRunPath}: ReviewRun verification must consume the topology critic dispatch target kind`,
  );

  const roleContracts = read('packages/main/src/core/prompt-role-contract-registry.ts');
  const reviewRunHandler = read('packages/main/src/handlers/review-run.ts');
  assert(
    roleContracts.includes('const INVENTORY_CRITIC_CONTRACT')
      && roleContracts.includes('return deepFreezeRoleContract(contract)')
      && roleContracts.includes("requiredOutputIds: ['review-finding-or-pass', 'review-inventory-critic-receipt']")
      && roleContracts.includes('promptRoleContractForSemanticDigest')
      && roleContracts.includes('unregistered Role Contract semantics')
      && dispatchText.includes("assembleComplexStoryDispatch(currentStory, canonicalType, dispatchPrompt, 'inventory-completeness')")
      && dispatchText.includes('promptRoleContract(agentType, responsibility)')
      && reviewRunHandler.includes('currentOpenReviewInventory(store, args.storyId)')
      && reviewRunHandler.includes('inventory.reviewRound !== story.currentReviewRound')
      && reviewRunHandler.includes("promptRoleContract(lane, inventoryResponsibility ? 'inventory-completeness' : undefined)")
      && reviewRunText.includes('promptRoleContractForSemanticDigest(canonicalLane, envelope.roleSemanticDigest)'),
    'full-envelope inventory semantics must be registered, selected by both signed OPEN producers, and reconstructed by authenticated digest after finalization',
  );

  const contractsText = read('packages/main/src/core/prompt-contracts.ts');
  assert(contractsText.includes('reviewerResponsibility?: ReviewerDispatchResponsibility')
    && contractsText.includes('parseReviewerDispatchResponsibility')
    && reviewRunText.includes('parseReviewerDispatchResponsibility(event.reviewerResponsibility)')
    && reviewRunText.includes('...(reviewerResponsibility ? { reviewerResponsibility } : {})')
    && reviewRunHandler.includes('responsibility.epochId !== inventory.epochId')
    && reviewRunHandler.includes('responsibility.wave !== inventory.waves.length + 1')
    && reviewRunHandler.includes('responsibility.materialHash !== inventory.cutoff.materialHash')
    && reviewRunHandler.includes("responsibility.storyFilesHash !== (inventory.cutoff.storyFilesHash ?? '')")
    && reviewRunHandler.indexOf('critic dispatch lacks bound responsibility') < reviewRunHandler.indexOf('const reviewRunId ='),
    'critic new-run responsibility must be digest-bound and compared before run/envelope publication');
  const envelopeText = read('packages/main/src/core/prompt-envelope.ts');
  assert(contractsText.includes('reviewerDispatchBindingDigest?: string')
    && envelopeText.includes('reviewerDispatchBindingDigest: input.reviewerDispatchBindingDigest')
    && envelopeText.includes('envelope.reviewerDispatchBindingDigest === input.reviewerDispatchBindingDigest')
    && reviewRunHandler.includes('reviewerDispatchBindingDigest: dispatchBinding.binding.dispatchBindingDigest')
    && reviewRunText.includes('verifyHistoricalReviewerDispatchBinding')
    && reviewRunText.includes('expectedDispatchBindingDigest: expected')
    && reviewRunText.includes("domainSeparatedDigest('prompt-launcher-spec.v1'")
    && reviewRunText.includes('identities.length !== 1'),
    'historical envelopes must authenticate and select the original dispatch; legacy fallback requires exact launcher reconstruction');
  const incrementalText = read('packages/main/src/core/review-incremental-context.ts');
  assert(contractsText.includes('eligibilityRoleSemanticDigest?: string')
    && envelopeText.includes('envelope.eligibilityRoleSemanticDigest === input.eligibilityRoleSemanticDigest')
    && envelopeText.includes('envelope.eligibilityRoleSemanticDigest === input.roleContract.semanticDigest')
    && reviewRunHandler.includes('roleSemanticDigest: selectedRoleContract.semanticDigest')
    && reviewRunHandler.includes('eligibilityRoleSemanticDigest: selectedRoleContract.semanticDigest')
    && incrementalText.includes('promptRoleContractForSemanticDigest(role, options.roleSemanticDigest)')
    && reviewRunText.includes('envelope.eligibilityRoleSemanticDigest ?? promptRoleContract(run.lane).semanticDigest'),
    'incremental eligibility must consume authenticated registered responsibility semantics while preserving pre-marker history');
  const certificationText = read('packages/main/src/handlers/certification-window.ts');
  assert(certificationText.includes('templates\\/agents\\/[^/]+\\.md$')
    && certificationText.includes("matches.length === 1")
    && certificationText.includes('if (!domain) return undefined'),
    'certification must classify the narrow canonical agent family while unknown or ambiguous paths refuse');

  const inventoryHandlerPath = 'packages/main/src/handlers/review-inventory.ts';
  const inventoryHandlerText = read(inventoryHandlerPath);
  assert(
    /review_inventory_critic_set[\s\S]*findingDispositions:\s*conservativeDispositions/.test(inventoryHandlerText),
    `${inventoryHandlerPath}: the unique critic Next command must include executable findingDispositions`,
  );
  assert(
    /REVIEW_INVENTORY_NEW_FINDINGS_REQUIRE_NEXT_WAVE[\s\S]*review_inventory_wave_advance/.test(inventoryHandlerText),
    `${inventoryHandlerPath}: explicit saturation finalization must preserve the wave-advance blocker and command`,
  );
  assert(
    /review_inventory_finalize:[\s\S]*REVIEW_INVENTORY_NEW_FINDINGS_REQUIRE_NEXT_WAVE[\s\S]*review_inventory_wave_advance/.test(inventoryHandlerText),
    `${inventoryHandlerPath}: finalize must fail closed on new finding families instead of checkpointing implicitly`,
  );
  assert(
    /withReviewInventoryMutationLock/.test(inventoryHandlerText),
    `${inventoryHandlerPath}: finalize and wave persistence must use the shared reviewer-evidence lock`,
  );

  const findingHandlerPath = 'packages/main/src/handlers/finding.ts';
  const findingHandlerText = read(findingHandlerPath);
  const passProducer = extractNamedFunctionBody(findingHandlerText, 'recordReviewPass') ?? '';
  assert(
    /currentOpenReviewInventory\(ctx\.store, storyId\)[\s\S]*?!readEvidence\.readManifest \|\| !readEvidence\.readLog[\s\S]*?OPEN review inventory requires signed readManifest plus mechanical readEvents\/readLog/.test(passProducer),
    `${findingHandlerPath}: the shared pass producer must reject incomplete OPEN-inventory read evidence before publication`,
  );
  assert(
    /withReviewInventoryMutationLock[\s\S]*assertReviewInventoryEvidenceWritable/.test(findingHandlerText),
    `${findingHandlerPath}: reviewer finding/pass writes must share the inventory lock and enforce temporal evidence admission`,
  );
  assert(
    /latest\.state === 'FINALIZED'[\s\S]*reviewer evidence for that round remains sealed after receipt consumption[\s\S]*REVIEW_INVENTORY_WAVE_EVIDENCE_SEALED/.test(epochText),
    `${epochPath}: finalized review rounds and old-wave ReviewRuns must remain sealed`,
  );
  assert(
    /captureReviewInventoryBaselineFindingIds[\s\S]*baselineFindingIds[\s\S]*REVIEW_INVENTORY_BASELINE_FINDINGS_CHANGED/.test(inventoryHandlerText),
    `${inventoryHandlerPath}: begin must sign and consumers must fail-close the carried-forward verified finding baseline`,
  );
  assert(
    /epoch\.state === 'FINALIZED'[\s\S]*invalidatedAt:[\s\S]*invalidationReason:[\s\S]*signReviewInventoryReceipt/.test(inventoryHandlerText),
    `${inventoryHandlerPath}: an unconsumed FINALIZED receipt needs a signed late-evidence invalidation path`,
  );
  assert(
    /initialRunSequenceBoundary[\s\S]*nextRunSequenceBoundary[\s\S]*reviewRunSequence\(run\)[\s\S]*sequence <= sequenceBoundary/.test(epochText),
    `${epochPath}: inventory waves must use signed monotonic ReviewRun boundaries instead of millisecond ordering`,
  );
  assert(
    /runEvidence\.forEach[\s\S]*row\.findings\.forEach/.test(epochText),
    `${epochPath}: every eligible same-lane ReviewRun must contribute verified findings even when one newer terminal is selected`,
  );
  const scopeContractHandlerText = read('packages/main/src/handlers/scope-contract.ts');
  // B-adc3: a saved scope must fit the same bounded authority shape reviewers consume.
  assert(scopeContractHandlerText.includes('validateFullTaskScopeContext(projectScopeInventory(contract))'),
    'scope writers must validate the final projected scope before persistence');
  for (const command of ['scope_contract_set', 'scope_contract_init_from_plan']) {
    const fact = processFactRegistryMap().get(command);
    assert(fact?.semantics.includes('schema-contract') && fact?.semantics.includes('atomic-persistence'),
      `${command} must register bounded scope schema and fail-before-write semantics`);
  }
  assert(
    /scope_contract_acknowledge[\s\S]*withReviewInventoryMutationLock/.test(scopeContractHandlerText)
      || /withReviewInventoryMutationLock[\s\S]*scope_contract_acknowledge/.test(scopeContractHandlerText),
    'packages/main/src/handlers/scope-contract.ts: scope acknowledgement must share the inventory mutation lock',
  );
  assert(
    /captureReviewInventoryScope[\s\S]*scopeDigest[\s\S]*requiredLanes[\s\S]*OPEN_REVIEW_INVENTORY_SCOPE_MUTATION/.test(inventoryHandlerText),
    `${inventoryHandlerPath}: inventory consumers must recompute frozen scope and active lanes`,
  );
  const checklistHandlerText = read('packages/main/src/handlers/checklist.ts');
  assert(
    /withChecklistLock[\s\S]*withReviewInventoryMutationLock[\s\S]*withMkdirLock/.test(checklistHandlerText),
    'packages/main/src/handlers/checklist.ts: every checklist acceptance writer must use inventory -> checklist lock order',
  );
  const refreshSource = ts.createSourceFile('checklist.ts', checklistHandlerText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const refreshCandidate = findFunctionDeclaration(refreshSource, 'staleReexecCandidate')?.body?.getText(refreshSource) ?? '';
  // Finite admission-shape check complements the real handler smoke; it is not
  // a claim of arbitrary semantic equivalence from source tokens.
  assert(refreshCandidate.includes('if (!resolved || !pin) return undefined;')
    && !refreshCandidate.includes('isExecutableIntentType')
    && refreshCandidate.includes('resolveEvidenceCommandTimeout'),
    'stale refresh candidate must admit every immutable pin, including docs/manual, without bypassing timeout enforcement');
  assert(read(processFactRegistryPath).includes('every immutable pinned intent, including docs/manual'),
    'stale pinned docs/manual recovery must remain registered as mechanical gate evidence');
  const causalVersionSource = ts.createSourceFile('causal-evidence.ts', read('packages/main/src/core/causal-evidence.ts'), ts.ScriptTarget.Latest, true);
  const causalVersionBody = findFunctionDeclaration(causalVersionSource, 'resolveCausalToolVersion')?.body?.getText(causalVersionSource) ?? '';
  assert(/return PROOF_OR_STOP_CLI_VERSION;/.test(causalVersionBody)
    && !/readFileSync|process\.cwd|package\.json/.test(causalVersionBody),
    'causal tool version must use the executing CLI constant, never target or cwd manifests');
  const causalVersionSemantics = 'causal toolVersion binds the executing CLI build independently of target-project and cwd manifests';
  const causalVersionArtifacts = parseProcessFactArtifactByCommandFromSource(read(processFactRegistryPath));
  for (const producerCommand of [
    'verification_evidence_add',
    'verification_evidence_batch_add',
    'verification_evidence_refresh_stale',
    'verification_run',
    'validate',
  ]) {
    assert(causalVersionArtifacts.get(producerCommand)?.consumerGate?.includes(causalVersionSemantics),
      `executing CLI tool version must remain registered for causal-version producer ${producerCommand}`);
  }
  const stampBody = findFunctionDeclaration(refreshSource, 'enforceAndStampEvidence')?.body?.getText(refreshSource) ?? '';
  const actualLaunches = [];
  const inspectLaunch = (node) => {
    if (ts.isCallExpression(node)
      && ['deps.runCommand', 'executePinnedCommand'].includes(node.expression.getText(refreshSource))) {
      actualLaunches.push(node);
      let owner = node.parent;
      while (owner && !ts.isPropertyAssignment(owner)) owner = owner.parent;
      assert(owner?.name?.getText(refreshSource) === 'run'
        && ts.isCallExpression(owner.parent.parent)
        && owner.parent.parent.expression.getText(refreshSource) === 'executeCausalEvidence',
      'actual verification launch must occur inside the causal run callback, after its last-moment preflight');
    }
    ts.forEachChild(node, inspectLaunch);
  };
  inspectLaunch(refreshSource);
  assert(actualLaunches.length === 2, 'both existing verification launch paths retain causal launch ownership');
  assert(read(processFactRegistryPath).includes('actual child launch occurs inside the causal runner'),
    'causal last-moment preflight launch ownership remains a registered process fact');
  assert(stampBody.includes('sharedExecution?.executedAt ?? causal?.receipt.executedAt')
    && stampBody.includes('executedAt: sourceExecutedAt')
    && checklistHandlerText.includes('executedAt: causal.receipt.executedAt')
    && !stampBody.includes('executedAt: new Date()'),
    'V3 execution time must project the actual signed causal source and V5 fan-out must preserve it, never per-intent restamping time');
  for (const binding of [
    'verificationExecutionKey: createVerificationExecutionKey({',
    'verificationExecutionKey: executionKey',
    'verificationObservationId: randomUUID()',
    'inputs: sharedCausalReceipt?.identity.inputs ?? {',
    'const causal = !sharedExecution || sharedCausalReceipt',
    'causalReceipt: stamp.causalReceipt',
    'groups.get(candidate.executionKey)',
    'currentExecutionKey === reexec.executionKey',
    'currentCandidate.assertionKey === executionOutcome.assertionKey',
    'preflightInputKey(input, sourceReceipt.executionKey)',
    'preflightInputKey(input, receipt.executionKey)',
    'preflightInputKey(causalPreflight.input, receipt.executionKey)',
    'preflightInputKey(firstPreflight.input, firstReceipt.executionKey)',
  ]) assert(checklistHandlerText.includes(binding), `strict refresh identity binding missing: ${binding}`);
  assert(!refreshCandidate.includes('verificationObservationId')
    && !refreshCandidate.includes('randomUUID'),
    'observation addressing must never split physical execution grouping');
  assert(read(processFactRegistryPath).includes('selector-free physical execution keys bind signed causal identity')
    && read(processFactRegistryPath).includes('observation-only identifier'),
    'physical/CAS/import identity, independent assertions and actual signed execution time must remain registered');
  const refreshSmoke = read('packages/main/src/tasks/verification-run-and-guard-smoke.ts');
  for (const marker of ['pinned manual verifier re-earns mechanical authority', 'pinned docs verifier re-earns mechanical authority',
    'a failing re-run leaves the row demoted', 'pin-less demotion strips the receipt',
    'shared rows bind the same selector-free execution receipt', 'only different effective timeout values split execution',
    'selector-specific evidence identities remain distinct over one raw run',
    'independent selector assertions preserve the same signed source execution',
    'nonmatching selector receives no mechanical receipt',
    'raw verifier refreshed git index without cross-receipt identity mismatch',
    'cross-identity cached preflight is refused before execution', 'actual production import refuses substituted signed CAS receipt',
    'cross-identity refusal leaves prior receipts and pins unchanged', 'fan-out retains source signed execution time, never publication time',
    'new ordinary executions borrowed an older same-key CAS observation', 'B-aa5f CHK008 causal-import-integration PASS',
    'causal ledger counts every independently evaluated intent, including shared-execution followers',
    'bounded diagnostic probe still omits the middle-of-large-output selector',
    'causal replay binds durable complete selector output',
    'complete-output replay does not launch another execution',
    'authenticated complete causal output finds the middle-of-large-output selector',
    'authenticated complete-output V5 assertion agrees with causal replay']) {
    assert(refreshSmoke.includes(marker), `stale refresh executable control missing: ${marker}`);
  }
  assert(
    /reviewInventoryAcceptanceSubjectDigest[\s\S]*verificationIntent[\s\S]*verificationEvidence[\s\S]*userSeesSnapshot/.test(epochText),
    `${epochPath}: the frozen acceptance subject must include complete checklist review semantics`,
  );
  assert(
    /proofStoryContract[\s\S]*scopeShrinkageDecision[\s\S]*reviewInventoryAcceptanceSubjectDigestForStore/.test(epochText)
      && /currentAcceptanceSubjectDigest[\s\S]*effective ProofStory\/checklist acceptance subject changed/.test(epochText),
    `${epochPath}: OPEN and FINALIZED consumers must bind and recompute the effective ProofStory acceptance subject`,
  );
  const proofStoryHandlerText = read('packages/main/src/handlers/proofstory.ts');
  assert(
    /scope_shrinkage_decision_set[\s\S]*withReviewInventoryMutationLock[\s\S]*withMkdirLock/.test(proofStoryHandlerText),
    'packages/main/src/handlers/proofstory.ts: scope shrinkage must use inventory -> checklist lock order',
  );
  const idempotentFindingHandlerText = read('packages/main/src/handlers/finding.ts');
  assert(
    /sameTerminal[\s\S]*verifyReviewPass[\s\S]*idempotent retry[\s\S]*conflicting terminal pass/.test(idempotentFindingHandlerText),
    'packages/main/src/handlers/finding.ts: review-pass terminal writes must be strongly idempotent and reject semantic conflicts',
  );
  const passAst = ts.createSourceFile('finding.ts', idempotentFindingHandlerText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const passFunction = passAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'recordReviewPass');
  let authenticatedRetryBlock = false;
  const visitPassBlock = node => {
    if (ts.isBlock(node)) {
      const declarations = node.statements.flatMap((statement, index) => ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.map(declaration => ({ declaration, index })) : []);
      const auth = declarations.find(({ declaration }) => ts.isIdentifier(declaration.name) && declaration.name.text === 'nativeEvidenceBinding'
        && declaration.initializer && ts.isCallExpression(declaration.initializer)
        && ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text === 'issueDirectReviewAuthority');
      const terminal = declarations.find(({ declaration }) => ts.isIdentifier(declaration.name) && declaration.name.text === 'sameTerminal');
      if (auth && terminal && auth.index < terminal.index) authenticatedRetryBlock = true;
    }
    ts.forEachChild(node, visitPassBlock);
  };
  if (passFunction) visitPassBlock(passFunction);
  assert(authenticatedRetryBlock, 'review_pass_set must authenticate direct authority in the same execution block before terminal retry selection');
  const agentsDocText = read('AGENTS.md');
  const storyLifecycleText = read('docs/requirements/decisions/story-lifecycle.md');
  const testingInfraText = read('docs/requirements/decisions/testing-infra.md');
  for (const [label, text] of [['AGENTS.md', agentsDocText], ['story-lifecycle.md', storyLifecycleText], ['testing-infra.md', testingInfraText]]) {
    assert(/fresh (?:non-latest )?PASS|fresh PASS/.test(text) && /open FINDING/.test(text), `${label}: latest-run guidance must preserve the kind-aware PASS/FINDING distinction`);
  }
  const latestRunHintBody = reviewRunText.match(/function latestRunHint\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(
    /resubmit finding_add/.test(latestRunHintBody) && !/review_pass_set/.test(latestRunHintBody),
    'packages/main/src/core/review-run.ts: FINDING-only non-latest-run recovery hint must never tell a valid PASS to resubmit review_pass_set',
  );
  const candidateHandlerText = read('packages/main/src/handlers/candidate-spec-routing.ts');
  assert(
    /withReviewInventoryMutationLock[\s\S]*writeCandidateSpecSet[\s\S]*refreshReviewInventoryContextLocked/.test(candidateHandlerText),
    'packages/main/src/handlers/candidate-spec-routing.ts: candidate reroute must atomically invalidate an OPEN epoch',
  );
  assert(
    /candidateSpecSetDigest[\s\S]*corpusDigest[\s\S]*OPEN_REVIEW_INVENTORY_CANDIDATE_ROUTING_MUTATION/.test(inventoryHandlerText),
    `${inventoryHandlerPath}: epoch consumers must recompute the signed candidate universe`,
  );
  const reviewRunHandlerText = read('packages/main/src/handlers/review-run.ts');
  assert(
    /withReviewInventoryMutationLock[\s\S]*assertReviewInventoryContextFreshLocked[\s\S]*withReviewMetadataTransactionLock[\s\S]*writeReviewRuns/.test(reviewRunHandlerText),
    'packages/main/src/handlers/review-run.ts: inventory precheck and durable RR publication must be one outer critical section',
  );
  const promptContractsText = read('packages/main/src/core/prompt-contracts.ts');
  const promptEnvelopeText = read('packages/main/src/core/prompt-envelope.ts');
  assert(
    /findingProjection[\s\S]*findingProjectionDigest/.test(promptContractsText)
      && /prompt-finding-projection\.v1/.test(promptEnvelopeText)
      && /findingProjection:\s*envelope\.findingProjection/.test(reviewRunText),
    'Prompt Envelope: historical eligibility must consume an envelope-signed run-start finding projection',
  );
  const mkdirLockText = read('packages/main/src/core/mkdir-lock.ts');
  assert(
    /classifyDefaultHolder[\s\S]*process\.kill\(holder\.pid, 0\)[\s\S]*observedProcessStartTimeMs[\s\S]*return 'active'/.test(mkdirLockText),
    'packages/main/src/core/mkdir-lock.ts: stale reclaim must preserve a live same-host process incarnation beyond mtime expiry',
  );
  assert(
    /REVIEW_INVENTORY_LIVE_AGGREGATE_CHANGED[\s\S]*begin a fresh inventory epoch/.test(epochText),
    `${epochPath}: remediation consumption must fail closed after replaying a changed live terminal/finding aggregate`,
  );

  const projectConfig = read('proof-or-stop.config.json');
  assert(
    /"acceptanceRolloutGateMode"\s*:\s*"enforce"/.test(projectConfig),
    'proof-or-stop.config.json: mandatory Wave 4 acceptance authority must be mechanically enforced for this repository',
  );
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
  const runtimeSourceRefsInitializer = extractConstInitializer(sourceText, 'RUNTIME_PROCESS_FACT_SOURCE_REFS', processFactRegistryPath);
  const sourceContracts = [
    {
      name: 'verification_pin_narrow',
      producerSourceRefs: [
        'packages/main/src/core/verification-execution-evidence.ts',
        'packages/main/src/handlers/checklist.ts',
      ],
      consumerSourceRefs: [
        'packages/main/src/core/verification.ts',
        'packages/main/src/handlers/checklist.ts',
      ],
    },
    {
      name: 'runtime:verification_execution_assertion_reuse_gate',
      producerSourceRefs: [
        'packages/main/src/core/verification-execution-evidence.ts',
        'packages/main/src/core/evidence-freshness.ts',
        'packages/main/src/core/proof-admissibility.ts',
        'packages/main/src/core/verification.ts',
      ],
      consumerSourceRefs: [
        'packages/main/src/core/machine.ts',
        'packages/main/src/core/lifecycle-readiness.ts',
        'packages/main/src/handlers/phase-gates.ts',
        'packages/main/src/handlers/verifier.ts',
        'packages/main/src/handlers/done-prepare.ts',
        'packages/main/src/handlers/certification-window.ts',
        'packages/main/src/handlers/checklist.ts',
      ],
    },
    {
      name: 'runtime:verification_execution_key_producer_lock',
      producerSourceRefs: [
        'packages/main/src/core/verification-execution-evidence.ts',
        'packages/main/src/handlers/checklist.ts',
      ],
      consumerSourceRefs: [
        'packages/main/src/handlers/checklist.ts',
        'packages/main/src/core/proof-admissibility.ts',
        'packages/main/src/core/verification.ts',
      ],
    },
  ];
  for (const contract of sourceContracts) {
    const match = new RegExp(`['"]${contract.name}['"]\\s*:\\s*\\{`).exec(runtimeSourceRefsInitializer);
    assert(Boolean(match), `${processFactRegistryPath}: ${contract.name} must declare explicit source refs`);
    if (!match) continue;
    const openIndex = match.index + match[0].lastIndexOf('{');
    const block = extractBalancedBlock(runtimeSourceRefsInitializer, openIndex, '{', '}', `${processFactRegistryPath} ${contract.name}`);
    for (const ref of contract.producerSourceRefs) assertArrayPropertyIncludesValue(block, 'producerSourceRefs', ref, contract.name);
    for (const ref of contract.consumerSourceRefs) assertArrayPropertyIncludesValue(block, 'consumerSourceRefs', ref, contract.name);
  }

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
    /\bconst\s+sourceRefs\s*=\s*RUNTIME_PROCESS_FACT_SOURCE_REFS\[entry\.name\]\s*;/,
    'must derive explicit runtime producer/consumer sources from RUNTIME_PROCESS_FACT_SOURCE_REFS',
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
    ['producerSourceRefs', /\bproducerSourceRefs:\s*sourceRefs\?\.producerSourceRefs\s*\?\?/],
    ['consumerGate', /\bconsumerGate:\s*entry\.gateConsumer\b/],
    ['consumerSourceRefs', /\bconsumerSourceRefs:\s*sourceRefs\?\.consumerSourceRefs\s*\?\?/],
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

function parseInlineProcessFactArtifactFromSource(block, label) {
  const artifactMatch = /\bartifact\s*:\s*\{/.exec(block);
  if (!artifactMatch) return null;
  const openIndex = artifactMatch.index + artifactMatch[0].lastIndexOf('{');
  const artifactBlock = extractBalancedBlock(block, openIndex, '{', '}', `${label} inline artifact`);
  return {
    name: readStringProperty(artifactBlock, 'name'),
    path: readStringProperty(artifactBlock, 'path'),
    signed: /\bsigned:\s*true\b/.test(artifactBlock),
    signature: readStringProperty(artifactBlock, 'signature'),
    producerCommand: readStringProperty(artifactBlock, 'producerCommand'),
    consumerGate: readStringProperty(artifactBlock, 'consumerGate'),
    reviewerLane: readStringProperty(artifactBlock, 'reviewerLane'),
    block: artifactBlock,
  };
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
  for (const requiredSpread of ['COMMAND_PROCESS_FACTS', 'PROCESS_FACT_REVIEWER_LANES', 'PROCESS_FACT_ARTIFACTS', 'PROCESS_FACT_FLOW_POLICIES', 'PROCESS_FACT_DONE_PREFLIGHT_CONSUMERS']) {
    assert(
      finalRegistryBody.includes(`...${requiredSpread}`),
      `${processFactRegistryPath}: final PROCESS_FACT_REGISTRY export missing ...${requiredSpread}`,
    );
  }

  assertProcessFactMappedSourceContracts(sourceText);

  if (builtProcessFactRegistryModule?.PROCESS_FACT_REGISTRY) {
    let entries = builtProcessFactRegistryModule.PROCESS_FACT_REGISTRY.map(entry => ({
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
    // Mutation seam used by the focused production-contract smoke: remove one
    // side of registration and require the ordinary cross-registry assertions
    // below to fail. It never changes normal verification behavior.
    if (process.env.PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION === 'drop-acceptance-basis-registry') {
      entries = entries.filter(entry => entry.name !== 'acceptance_basis_generate');
    }
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
    const artifact = artifactRefMatch
      ? artifactByCommand.get(artifactRefMatch[1])
      : parseInlineProcessFactArtifactFromSource(entry.block, `${processFactRegistryPath} ${entry.name}`);
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
  const closeoutTelemetryEntries = parseRegistryArrayEntriesFromSource(sourceText, 'PROCESS_FACT_CLOSEOUT_TELEMETRY');
  const donePreflightConsumerEntries = parseRegistryArrayEntriesFromSource(sourceText, 'PROCESS_FACT_DONE_PREFLIGHT_CONSUMERS');

  cachedProcessFactRegistryEntries = [
    ...commandEntries,
    ...laneEntries,
    ...artifactEntries,
    ...flowPolicyEntries,
    ...donePreflightConsumerEntries,
    ...closeoutTelemetryEntries,
  ];
  if (process.env.PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION === 'drop-acceptance-basis-registry') {
    cachedProcessFactRegistryEntries = cachedProcessFactRegistryEntries.filter(entry => entry.name !== 'acceptance_basis_generate');
  }
  return cachedProcessFactRegistryEntries;
}

function processFactRegistryMap() {
  return new Map(parseProcessFactRegistry().map(entry => [entry.name, entry]));
}

function parseDonePreflightPredicateInventory(sourceText) {
  const body = extractExportedArrayBody(sourceText, 'DONE_PREFLIGHT_PREDICATE_INVENTORY');
  return parseTopLevelObjectBlocks(body, `${processFactRegistryPath} DONE_PREFLIGHT_PREDICATE_INVENTORY`)
    .map(block => ({
      blockerCode: readStringProperty(block, 'blockerCode'),
      processFactName: readStringProperty(block, 'processFactName'),
      oracleRowId: readStringProperty(block, 'oracleRowId'),
    }));
}

/** Inventory the single source, not purported equivalence of two programs. */
function collectSharedDoneBlockerBindings(machineSource) {
  const sf = ts.createSourceFile(machinePath, machineSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const evaluator = sf.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'evaluateDonePredicates');
  const errors = [];
  const byCode = new Map();
  if (!evaluator?.body || !evaluator.asteriskToken) {
    return { errors: ['shared DONE predicate generator missing'], byCode };
  }
  const visit = node => {
    if (ts.isYieldExpression(node)) {
      const call = node.expression;
      if (node.asteriskToken || !call || !ts.isCallExpression(call) || call.expression.getText(sf) !== 'donePredicate'
        || call.arguments.length !== 4 || !ts.isStringLiteral(call.arguments[0]) || !ts.isStringLiteral(call.arguments[1])) {
        errors.push('shared DONE outcomes must be direct yields of donePredicate with literal predicate/row identities');
        return;
      }
      const rowId = call.arguments[1].text;
      const collect = child => {
        const literal = ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)
          || ts.isTemplateHead(child) || ts.isTemplateMiddle(child) || ts.isTemplateTail(child);
        if (literal) {
          for (const match of child.text.matchAll(/\[([a-z][a-z0-9_]*)\]/g)) {
            const rows = byCode.get(match[1]) ?? new Set();
            rows.add(rowId);
            byCode.set(match[1], rows);
          }
        }
        ts.forEachChild(child, collect);
      };
      collect(call.arguments[3]);
    }
    ts.forEachChild(node, visit);
  };
  visit(evaluator.body);
  return { errors, byCode };
}

function checkDonePreflightPredicateInventory({ machineSource, doneOracleSource, mappings, registry }) {
  const extracted = collectSharedDoneBlockerBindings(machineSource);
  const errors = [...extracted.errors, ...checkSharedDoneAdapterSources(machineSource, doneOracleSource)];
  const mapped = new Map();
  for (const entry of mappings) {
    if (!entry.blockerCode || !entry.processFactName || !entry.oracleRowId) {
      errors.push('DONE predicate inventory requires code, process fact and oracle row');
      continue;
    }
    if (mapped.has(entry.blockerCode)) errors.push('duplicate DONE predicate mapping: ' + entry.blockerCode);
    mapped.set(entry.blockerCode, entry);
    const fact = registry.get(entry.processFactName);
    if (fact?.level !== 'L4' || !fact?.semantics.includes('gate-evidence')) {
      errors.push('DONE predicate [' + entry.blockerCode + '] requires an L4 gate-evidence process fact');
    }
    const rows = extracted.byCode.get(entry.blockerCode);
    if (!rows || rows.size !== 1 || !rows.has(entry.oracleRowId)) {
      errors.push('DONE predicate [' + entry.blockerCode + '] must map to its exact shared outcome row ' + entry.oracleRowId);
    }
  }
  for (const code of extracted.byCode.keys()) {
    if (!mapped.has(code)) errors.push('DONE predicate [' + code + '] has no done-preflight mapping');
  }
  return errors;
}

function assertDonePreflightPredicateInventoryParity() {
  const before = failures.length;
  const machineSource = read(machinePath);
  const doneOracleSource = read(doneOraclePath);
  const registry = processFactRegistryMap();
  const mappings = parseDonePreflightPredicateInventory(read(processFactRegistryPath));
  for (const error of checkDonePreflightPredicateInventory({ machineSource, doneOracleSource, mappings, registry })) fail(error);
  for (const name of ['runtime:done_shared_predicate_projection', 'runtime:done_finish_decision_presence', 'runtime:done_phase_agnostic_reviewer_verdict']) {
    const fact = registry.get(name);
    assert(fact?.level === 'L4' && fact?.consumerGate?.includes('storyMachine.canFinish DONE gate')
      && fact?.consumerGate?.includes('done_closure/done_prepare preflight'), name + ': both DONE consumers must stay registered at L4');
  }
  assert(registry.get('runtime:done_finish_decision_presence')?.rationale.includes('byte-exact proof-or-stop.dev-memory-finish-decision.v1'),
    'finish-decision process fact must require exact canonical schema admission');
  const finishReader = read('packages/main/src/core/playbook-runtime-memory.ts');
  assert(finishReader.includes("if (record.schemaVersion !== 'proof-or-stop.dev-memory-finish-decision.v1') {")
    && finishReader.includes('return { record: null, unsupportedIdentity:')
    && finishReader.includes('return inspectDevMemoryFinishDecision(root, storyId).record;'),
    'finish-decision reader must reject unsupported schema before DONE admission');
  assert(registry.get('runtime:done_finish_decision_presence')?.rationale.includes('unsupported_identity')
    && machineSource.includes('const finishDecisionRead = inspectDevMemoryFinishDecision(projectRoot, storyId);')
    && doneOracleSource.includes("donePredicateValue<ReturnType<typeof inspectDevMemoryFinishDecision>>(donePredicates, 'dev-memory-finish-decision')"),
    'unsupported finish identity must retain its shared diagnostic in DONE and the read-only oracle');
  const sf = ts.createSourceFile(machinePath, machineSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const evaluator = sf.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'evaluateDonePredicates');
  if (evaluator?.body) {
    const offset = evaluator.body.getStart(sf) + 1;
    const future = machineSource.slice(0, offset)
      + "\n yield donePredicate('future', 'future-row', null, '[future_done_predicate]');\n"
      + machineSource.slice(offset);
    const missing = checkDonePreflightPredicateInventory({ machineSource: future, doneOracleSource, mappings, registry });
    assert(missing.some(error => error.includes('[future_done_predicate]') && error.includes('no done-preflight mapping')),
      'future shared DONE literal must fail the inventory until registered');
    const registered = [...mappings, { blockerCode: 'future_done_predicate', oracleRowId: 'future-row', processFactName: 'artifact:delivery-check.json' }];
    assert(checkDonePreflightPredicateInventory({ machineSource: future, doneOracleSource, mappings: registered, registry }).length === 0,
      'new registered shared predicate needs no manual oracle row whitelist');
    const wrong = registered.map(entry => entry.blockerCode === 'future_done_predicate' ? { ...entry, oracleRowId: 'test-evidence' } : entry);
    assert(checkDonePreflightPredicateInventory({ machineSource: future, doneOracleSource, mappings: wrong, registry })
      .some(error => error.includes('[future_done_predicate]') && error.includes('exact shared outcome row')),
    'wrong row mapping must fail against source-owned outcome identity');
  }
  try {
    assert(registry.get('artifact:prompt-envelopes.json')?.rationale?.includes('Verification snapshots preserve optional-property absence'),
      'Prompt Envelope snapshot fidelity must remain registered; isolation must not invalidate signed trusted-prior evidence');
    // Includes source-executed canonical envelope/signature/trusted-prior proof:
    // optional-key absence and malformed values are preserved, not normalized.
    runSharedDonePredicateProof(machineSource, doneOracleSource);
  } catch (error) {
    fail('executable shared DONE predicate proof: ' + (error?.message ?? String(error)));
  }
  if (failures.length === before) console.log('DONE/preflight predicate inventory parity passed');
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

function assertCertificationWindowCommandContract(cliToolNameSet, registry, levelRegistry, policyByName) {
  const commands = ['certification_window_begin', 'certification_window_status', 'certification_window_cancel'];
  for (const commandName of commands) {
    assert(cliToolNameSet.has(commandName), `MAIN_TOOLS missing ${commandName}`);
    const levelEntry = levelRegistry.get(commandName);
    assert(levelEntry, `${processFactLevelRegistryPath}: ${commandName} missing from PROCESS_FACT_LEVELS`);
    assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${commandName} must stay L4`);
    assert(levelEntry.category === 'certification-window', `${processFactLevelRegistryPath}: ${commandName} category must stay certification-window`);
    assert(levelEntry.owner === 'handlers/certification-window', `${processFactLevelRegistryPath}: ${commandName} owner drifted`);
    assert(
      /done_required_validate \/ validate --full PRE_CERT certification-window gate/.test(levelEntry.gateConsumer || ''),
      `${processFactLevelRegistryPath}: ${commandName} must name the PRE_CERT certification-window gateConsumer`,
    );
    const registryEntry = registry.get(commandName);
    assert(registryEntry, `${processFactRegistryPath}: ${commandName} missing from PROCESS_FACT_REGISTRY`);
    assert(registryEntry.level === 'L4', `${processFactRegistryPath}: ${commandName} registry level must stay L4`);
    assert(registryEntry.artifact?.path === 'certification-window.json', `${processFactRegistryPath}: ${commandName} must write certification-window.json`);
    assert(registryEntry.artifact?.signed === true, `${processFactRegistryPath}: ${commandName} artifact must stay signed`);
    assert(
      registryEntry.semantics.includes('signed-artifact') && registryEntry.semantics.includes('gate-evidence'),
      `${processFactRegistryPath}: ${commandName} must carry signed-artifact + gate-evidence`,
    );
    const policy = policyByName.get(commandName);
    assert(policy, `${commandPolicyPath}: ${commandName} missing COMMAND_POLICIES entry`);
    assert(policy.gateEvidence, `${commandPolicyPath}: ${commandName} must stay gateEvidence`);
    assert(policy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: ${commandName} destructiveRisk must stay metadata-write`);
    if (commandName === 'certification_window_status') {
      assert(policyBlockHasOwnershipClass(policy, 'readOnly'), `${commandPolicyPath}: ${commandName} default must stay readOnly`);
      assert(readStringProperty(policy.block, 'storyWriteEffect') === 'whenRefresh', `${commandPolicyPath}: ${commandName} explicit refresh must stay a declared Story write`);
    } else {
      assert(
        policyBlockHasOwnershipClass(policy, 'storyScopedMutating'),
        `${commandPolicyPath}: ${commandName} must stay storyScopedMutating`,
      );
    }
  }
  const certificationArtifact = registry.get('artifact:certification-window.json');
  for (const term of ['artifact-releases.jsonl', 'capability-releases.jsonl', 'review-subject',
    'Git blobs/tombstones', 'integration/test', 'never gate evidence', 'unknown paths fail closed']) {
    assert(certificationArtifact?.rationale.includes(term),
      `${processFactRegistryPath}: certification release provenance contract missing ${term}`);
  }
  const statusSource = read('packages/main/src/core/certification-window.ts');
  const verifier = read('packages/main/src/handlers/verifier.ts');
  const phaseGate = read('packages/main/src/handlers/phase-gates.ts');
  const doneRequired = read('packages/main/src/handlers/done-required-validation.ts');
  for (const consumer of ['packages/main/src/handlers/phase-gates.ts', 'packages/main/src/handlers/certification-window.ts']) {
    assert(read(consumer).includes("from './validation-pass-admissibility.js'"), `${consumer}: status and TEST must share routine PASS admissibility`);
  }
  assert(registry.get('runtime:precert_routine_single_execution')?.level === 'L4', 'PRE_CERT single execution must be a real registered L4 fact');
  assert(/claimTestAdmissibleRoutineValidationWindow/.test(verifier), 'routine validation requires an execution claim');
  assert(/persistPrecertCheapCheckIfQualified/.test(verifier), 'fast validation must publish its own bound receipt');
  assert(/currentIdentity: currentPrecertFastIdentity\(ctx, storyId\)/.test(read('packages/main/src/handlers/certification-window.ts')), 'PRE_CERT must reconstruct current fast identity before consuming a receipt');
  assert(/requireCurrentHeavyCertificationWindow/.test(doneRequired), 'DONE-required must retain PRE_CERT admission');
  assert(!/refuseHeavyCertificationUnlessAdmitted/.test(doneRequired), 'DONE-required must not consume routine execution allocation');
  assert(!/captureLifecycleMetadataTransaction|commitLifecycleMetadataTransaction|persistRunningCertificationWindow|claimTestAdmissibleRoutineValidationWindow/.test(doneRequired), 'DONE-required must not claim or commit the routine certification allocation');
  const doneCloseouts = [...doneRequired.matchAll(/closeoutArtifactPaths\s*:\s*\[([^\]]*)\]/g)];
  assert(doneCloseouts.length === 1 && /^\s*['"]done-required-evidence\.json['"]\s*$/.test(doneCloseouts[0][1]), 'DONE-required must commit only its own evidence artifact');
  const testGate = phaseGate.slice(phaseGate.indexOf('export async function runValidateGate('), phaseGate.indexOf('export function runDoneOracleGate('));
  assert(/PRE_CERT_ROUTINE_PASS_REQUIRED/.test(testGate) && !/createVerifierHandlers|await.*\.validate\(/.test(testGate), 'TEST must consume signed routine PASS without executing a second suite');
  assert(
    /status must never claim inventory completeness is certification/.test(statusSource),
    'packages/main/src/core/certification-window.ts must refuse status prose that treats inventory completeness as certification',
  );
  assert(
    /inventoryReceiptAuthorizesPrecert/.test(statusSource),
    'packages/main/src/core/certification-window.ts must keep inventoryReceiptAuthorizesPrecert as the inventory-not-PRE_CERT fence',
  );
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
  const reuseText = read('packages/main/src/core/done-prepare-validation-reuse.ts');
  for (const token of ['evaluateDoneRequiredEvidence', 'classifyTrustedValidationLineage', 'head-changed-during-reuse-evaluation', 'evidence-malformed-or-unreadable']) {
    assert(reuseText.includes(token), `DONE-required pre-run reuse must preserve canonical/shared-lineage check: ${token}`);
  }
  const routineReuseText = read('packages/main/src/core/validation-evidence-reuse.ts');
  for (const token of ['untrusted-lineage-path', 'effectiveEnvironmentDigest', 'buildValidationExecutableLookup', "env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'", "command.includes('\\\\')", 'platformPath.isAbsolute(command)', 'identity-missing-malformed-or-legacy', 'current-verification-coverage-incomplete', 'head-changed-during-reuse-evaluation']) {
    assert(routineReuseText.includes(token), `shared routine validation reuse contract missing ${token}`);
  }
  // B-f00c: the merge-lineage git-command logic was extracted into the shared
  // validation-lineage.ts classifier (used by both the reuse and admissibility copies).
  // The net-endpoint diff replaces the per-commit union, so rev-list is no longer used.
  const lineageText = read('packages/main/src/core/validation-lineage.ts');
  for (const token of ['merge-base', '--is-ancestor', 'diff-tree', 'isStoryMetadataPath']) {
    assert(lineageText.includes(token), `shared merge-lineage classifier contract missing ${token}`);
  }
  const validationEnvironmentText = read('packages/main/src/core/validation-command-environment.ts');
  const expectedValidationTransportKeys = [
    'AGY_SESSION_ID',
    'ANTIGRAVITY_SESSION_ID',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_SESSION_ID',
    'CODEX_SESSION_ID',
    'CODEX_THREAD_ID',
    'GEMINI_SESSION_ID',
    'LATTICE_ACTIVITY_RECORD_READONLY',
    'LATTICE_ACTIVITY_ROLE',
    'LATTICE_ACTIVITY_SESSION',
    'LATTICE_ACTIVITY_SOURCE',
    'LATTICE_AGENT',
    'LATTICE_CODEX_ENTRYPOINT',
    'LATTICE_OWNER_SESSION_ADAPTER_AGENT',
    'LATTICE_OWNER_SESSION_ADAPTER_BOUNDARY',
    'LATTICE_OWNER_SESSION_ADAPTER_GENERATED',
    'LATTICE_OWNER_SESSION_ADAPTER_PROVIDER',
    'LATTICE_OWNER_SESSION_ADAPTER_ROLE',
    'LATTICE_OWNER_SESSION_ADAPTER_SESSION',
    'LATTICE_OWNER_SESSION_ADAPTER_TASK',
    'LATTICE_SESSION_ID',
    'OLDPWD',
    'OPENAI_SESSION_ID',
    'SHLVL',
    'TERM_SESSION_ID',
    '_',
  ];
  const transportListMatch = validationEnvironmentText.match(
    /export const VALIDATION_TRANSPORT_ENV_KEY_LIST = \[([\s\S]*?)\] as const;/,
  );
  assert(transportListMatch, 'shared validation command environment must export the canonical transport key list');
  const actualValidationTransportKeys = transportListMatch
    ? [...transportListMatch[1].matchAll(/'([A-Z0-9_]+)'/g)].map((match) => match[1])
    : [];
  assert(
    JSON.stringify(actualValidationTransportKeys) === JSON.stringify(expectedValidationTransportKeys),
    `shared validation command environment canonical transport set mismatch: expected ${JSON.stringify(expectedValidationTransportKeys)}, got ${JSON.stringify(actualValidationTransportKeys)}`,
  );
  const expectedTransportDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(expectedValidationTransportKeys))
    .digest('hex')}`;
  assert(
    validationEnvironmentText.includes(`'${expectedTransportDigest}'`),
    `shared validation command environment transport digest mismatch: ${expectedTransportDigest}`,
  );
  for (const token of [
    // B-cdf6 CHK-006 Pass B: the pinned list stays byte-frozen (its digest is
    // compared against already-persisted receipts), and the new brand spellings
    // are derived only at the active FILTER boundary; retired keys are not read.
    "const FROZEN_RETIRED_ENV_PREFIX = ['LAT', 'TICE_'].join('')",
    '.filter((key) => !key.startsWith(FROZEN_RETIRED_ENV_PREFIX))',
    ".map((key) => `PROOF_OR_STOP_${key.slice(FROZEN_RETIRED_ENV_PREFIX.length)}`)",
    "platform === 'win32'",
    "effective[canonicalKey('PWD')] = cwd",
    'effective[canonicalKey(key)] = value',
  ]) {
    assert(validationEnvironmentText.includes(token), `shared validation command environment contract missing ${token}`);
  }
  const doneRequiredSmokeText = read('packages/main/src/tasks/done-required-validation-smoke.ts');
  for (const token of [
    'const behaviorEnvironmentMutations = [',
    "{ name: 'LANG', environment: { ...deliveryEnvironment, LANG: 'en_GB.UTF-8' } }",
    "{ name: 'LC_ALL', environment: { ...deliveryEnvironment, LC_ALL: 'en_GB.UTF-8' } }",
    "/effective-environment-digest-mismatch\\[0\\]/",
    "/effective-environment-digest-mismatch\\[1\\]/",
    'for (const mutation of behaviorEnvironmentMutations)',
  ]) {
    assert(doneRequiredSmokeText.includes(token), `DONE-required environment mutation contract missing ${token}`);
  }
  const validationExecutorEnvironmentText = read('packages/main/src/core/validation-executor.ts');
  assert(
    routineReuseText.includes('effectiveValidationCommandEnvironment(processEnvironment, command.env, cwd, platform)')
      && validationExecutorEnvironmentText.includes('effectiveValidationCommandEnvironment(process.env, command.env, cwd)'),
    'routine identity and validation command spawn must consume the same effective environment normalizer',
  );
  const budgetText = read('packages/main/src/core/done-required-timeout-budget.ts');
  // B-cdf6 CHK-006 Pass B: the phase-timeout override is now read through the
  // read-both brand resolver, so the pinned token is the resolver call (which
  // accepts BOTH `PROOF_OR_STOP_DONE_PREPARE_PHASE_TIMEOUT_MS` and the legacy
  // `PROOF_OR_STOP_` spelling) rather than one hardcoded variable name.
  for (const token of ['NODE_TIMER_MAX_MS', 'resolveCommandTimeoutMs', 'derived-command-budget', "readBrandEnv('DONE_PREPARE_PHASE_TIMEOUT_MS')"]) {
    assert(budgetText.includes(token), `DONE-required timeout budget contract missing ${token}`);
  }
  const validationExecutorText = read('packages/main/src/core/validation-executor.ts');
  for (const token of ['MAX_NODE_TIMER_DELAY_MS', 'Math.min(MAX_NODE_TIMER_DELAY_MS', 'resolveCommandTimeoutMs', 'deadlineError']) {
    assert(validationExecutorText.includes(token), `validation timer overflow contract missing ${token}`);
  }
  const verifierText = read('packages/main/src/handlers/verifier.ts');
  assert(verifierText.includes('deadlineError: args.deadlineError'), 'routine verifier must preserve the named CLI deadline source');
  const cliEngineText = read('packages/main/src/cli-engine.ts');
  for (const token of ['structuredWatchdog', 'watchdogAbort.abort', 'CliWatchdogTimeoutError', 'isStructuredDoneFailure', "process.exitCode = structuredDoneFailure ? 1 : 0"]) {
    assert(cliEngineText.includes(token), `DONE-required structured CLI watchdog contract missing ${token}`);
  }
  const refreshHandlerWatchdogText = read('packages/main/src/handlers/checklist.ts');
  for (const token of [
    'abortSignal?: AbortSignal',
    "assertVerificationEvidenceWriteActive('verification_evidence_refresh_stale', args)",
    'return writeStaleRefresh',
    'totalCommands: commandOrdinals.size',
    'progress: event => ctx.log?.(formatValidationProgressEvent(event))',
    'abortSignal: controls.abortSignal',
    'deadlineAt: controls.deadlineAt',
    'deadlineError: controls.deadlineError',
  ]) {
    assert(refreshHandlerWatchdogText.includes(token), `stale refresh progress/abort-atomic contract missing ${token}`);
  }
  for (const token of [
    "|| cmd === 'verification_evidence_add'",
    "|| cmd === 'verification_evidence_refresh_stale'",
    "|| cmd === 'verification_evidence_batch_add'",
    "|| cmd === 'verification_run'",
    "(cmd === 'verification_evidence_add'",
    'Object.assign(v.data as Record<string, unknown>, watchdogControl)',
  ]) {
    assert(cliEngineText.includes(token), `evidence writer structured CLI watchdog contract missing ${token}`);
  }
  for (const token of [
    'async verification_evidence_add(args:',
    'async verification_run(args:',
    'abortSignal?: AbortSignal',
    'deadlineAt?: number',
    'assertVerificationEvidenceWriteActive',
    "assertVerificationEvidenceWriteActive('verification_evidence_add', args)",
    "assertVerificationEvidenceWriteActive('verification_run', args)",
  ]) {
    assert(refreshHandlerWatchdogText.includes(token), `single verification evidence progress/abort contract missing ${token}`);
  }
  for (const token of [
    'async verification_evidence_batch_add(args:',
    "assertVerificationEvidenceWriteActive('verification_evidence_batch_add', args)",
    'assertVerificationFreshnessUnchanged(launchFreshness, captureVerificationFreshness(deps.cwd, deps.metadataRoot))',
    'abortSignal?: AbortSignal',
    'deadlineAt?: number',
  ]) {
    assert(refreshHandlerWatchdogText.includes(token), `verification evidence batch progress/abort-atomic contract missing ${token}`);
  }
  assertEvidenceFactoryWiring(refreshHandlerWatchdogText);
  const stampStart = refreshHandlerWatchdogText.indexOf('async function enforceAndStampEvidence(');
  const stampEnd = refreshHandlerWatchdogText.indexOf('function applyVerificationPin', stampStart);
  const stampSource = refreshHandlerWatchdogText.slice(stampStart, stampEnd);
  const postflight = stampSource.indexOf('assertVerificationFreshnessUnchanged(launchFreshness, captureVerificationFreshness(deps.cwd, deps.metadataRoot))');
  const publishExecution = stampSource.indexOf('createVerificationExecutionReceipt({');
  assert(stampStart >= 0 && postflight >= 0 && publishExecution > postflight
    && stampSource.includes('assertVerificationInputUnchanged(beforeIdentity, afterIdentity)'),
    'V5 execution receipt must be signed only after command input and current material postflight checks');
  assert(read('packages/main/src/tasks/validate-progress-heartbeat-smoke.ts').includes('failed batch must not publish reusable new-material CAS from old raw output'),
    'V5 snapshot protection requires the real failed-batch follow-up execution regression');

  const refreshValidationExecutorText = read('packages/main/src/core/validation-executor.ts');
  for (const token of [
    'SingleCommandExecutionOptions extends RunValidationCommandOptions',
    'options.abortSignal?.aborted',
    'options.deadlineAt',
    'resolveEvidenceCommandTimeoutMs',
    'loadConfig(projectRoot).validate?.evidenceCommandTimeoutOverrides',
    'Number.isSafeInteger(row.timeoutMs)',
    'identities.has(key)',
    'row.args.every((arg, index) => arg === identity.args[index])',
  ]) {
    assert(refreshValidationExecutorText.includes(token), `single pinned verifier abort/progress contract missing ${token}`);
  }
  const configTypeText = read('packages/main/src/core/config.ts');
  assert(configTypeText.includes('evidenceCommandTimeoutOverrides?: EvidenceCommandTimeoutOverrideConfig[]'),
    'config contract must expose the evidence-only exact-command timeout override surface');
  const repoLatticeConfig = JSON.parse(read('proof-or-stop.config.json'));
  const aggregateIdentity = ['packages/main/dist/tasks/managed-cross-provider-suite-smoke.js'];
  const routineAggregate = (repoLatticeConfig.validate?.commands ?? []).some((entry) => (
    typeof entry === 'object'
    && entry !== null
    && entry.command === 'node'
    && JSON.stringify(entry.args ?? []) === JSON.stringify(aggregateIdentity)
  ));
  assert(!routineAggregate, 'managed cross-provider aggregate must not be added to routine validate.commands');
  const evidenceAggregateOverrides = (repoLatticeConfig.validate?.evidenceCommandTimeoutOverrides ?? []).filter((entry) => (
    entry?.command === 'node'
    && JSON.stringify(entry.args ?? []) === JSON.stringify(aggregateIdentity)
    && entry.timeoutMs === 900_000
  ));
  assert(evidenceAggregateOverrides.length === 1,
    'managed cross-provider aggregate must have one exact evidence-only 900000ms timeout override');
  const reviewPassDiscardIdentity = ['packages/main/dist/tasks/review-pass-discard-smoke.js'];
  const routineReviewPassDiscard = (repoLatticeConfig.validate?.commands ?? []).filter((entry) => (
    typeof entry === 'object'
    && entry !== null
    && entry.command === 'node'
    && JSON.stringify(entry.args ?? []) === JSON.stringify(reviewPassDiscardIdentity)
    && entry.timeoutMs === 1_200_000
  ));
  assert(routineReviewPassDiscard.length === 1,
    'review-pass-discard nested cross-host aggregate must retain one exact routine 1200000ms timeout');
  const proofAdmissibilityIdentity = ['packages/main/dist/tasks/proof-admissibility-registry-smoke.js'];
  const routineProofAdmissibility = (repoLatticeConfig.validate?.commands ?? []).filter((entry) => (
    typeof entry === 'object'
    && entry !== null
    && entry.command === 'node'
    && JSON.stringify(entry.args ?? []) === JSON.stringify(proofAdmissibilityIdentity)
    && entry.timeoutMs === 600_000
  ));
  assert(routineProofAdmissibility.length === 1,
    'proof-admissibility registry smoke must retain one exact routine 600000ms timeout');
  const evidenceProofAdmissibilityOverrides = (repoLatticeConfig.validate?.evidenceCommandTimeoutOverrides ?? []).filter((entry) => (
    entry?.command === 'node'
    && JSON.stringify(entry.args ?? []) === JSON.stringify(proofAdmissibilityIdentity)
  ));
  assert(evidenceProofAdmissibilityOverrides.length === 0,
    'proof-admissibility registry smoke remains a routine validate command, not an evidence-only timeout override');
  const commandPolicyText = read('packages/main/src/core/command-policy.ts');
  assert(
    !/verification_evidence_refresh_stale:\s*\{[^}]*runtimeContinuation\s*:\s*true/s.test(commandPolicyText),
    'verification_evidence_refresh_stale must use cooperative progress/abort and must never become runtimeContinuation',
  );
  assert(
    !/verification_evidence_batch_add:\s*\{[^}]*runtimeContinuation\s*:\s*true/s.test(commandPolicyText),
    'verification_evidence_batch_add must use cooperative progress/abort and must never become runtimeContinuation',
  );
  const refreshWatchdogSmokeText = read('packages/main/src/tasks/validate-progress-heartbeat-smoke.ts');
  for (const token of [
    'REFRESH_STALE_WATCHDOG_ONLY',
    'assertRefreshHeartbeatAndDedupe',
    'assertRefreshWatchdogReapsWithoutPartialWrites',
    'assertBatchHeartbeatAndExactCommandDedupe',
    'assertBatchSharedExecutionStillFailsAtomicOnSelector',
    'assertBatchWatchdogReapsWithoutPartialWrites',
  ]) {
    assert(refreshWatchdogSmokeText.includes(token), `evidence writer watchdog/orphan smoke contract missing ${token}`);
  }
  const donePrepareText = read('packages/main/src/handlers/done-prepare.ts');
  for (const token of ['cliWatchdogTimeoutBlock', 'throwIfParentTimedOut', 'deadlineAt', 'Await the cooperative task after aborting it']) {
    assert(donePrepareText.includes(token), `done_prepare cooperative watchdog/cleanup contract missing ${token}`);
  }
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
  const generatedMetadataText = read('packages/main/src/core/done-prepare-generated-metadata.ts');
  for (const token of ['commitImmutableMetadataTree', "'commit-tree'", "'update-ref'", 'beforeCasUpdate', "'post-commit'"]) {
    assert(generatedMetadataText.includes(token), `shared immutable metadata commit contract missing ${token}`);
  }
  const autoCommitText = read('packages/main/src/core/auto-commit-metadata.ts');
  assert(
    autoCommitText.includes('commitValidationReuseMetadataTransaction')
      && autoCommitText.includes('commitImmutableMetadataTree'),
    'canonical validation reuse must consume the shared immutable metadata commit primitive',
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

function assertAcceptanceTopologyLifecycleFilenameContract() {
  // B-5e4a CHK-002: the four acceptance-topology StoryStore artifact filenames
  // must stay registered in the classifier's closed set. Runtime classification
  // + the StoryStore write-set coverage invariant live in
  // packages/main/src/tasks/lifecycle-registry-contract.ts; this is the
  // doc-canonical source-level projection of the same fact.
  const lifecycleRegistryText = read(lifecycleRegistryPath);
  const artifactFilenamesInitializer = extractConstInitializer(
    lifecycleRegistryText,
    'PROOF_OR_STOP_LIFECYCLE_ARTIFACT_FILENAMES',
    lifecycleRegistryPath,
  );
  for (const fileName of [
    'acceptance-basis.json',
    'pre-review-check.json',
    'topology-critic-receipt.json',
    'topology-exclusion-approvals.json',
  ]) {
    assert(
      new RegExp(`['"]${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(artifactFilenamesInitializer),
      `${lifecycleRegistryPath}: PROOF_OR_STOP_LIFECYCLE_ARTIFACT_FILENAMES must include '${fileName}' (acceptance-topology StoryStore artifact; B-5e4a)`,
    );
  }
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

  const probeCommand = 'review_host_availability_probe';
  assert(cliToolNameSet.has(probeCommand), `CLI schema: required review host availability probe command missing from MAIN_TOOLS: ${probeCommand}`);
  const probePolicy = policyByName.get(probeCommand);
  assert(probePolicy, `${commandPolicyPath}: required review host availability probe command missing lifecycle policy`);
  if (probePolicy) {
    assert(probePolicy.gateEvidence, `${commandPolicyPath}: ${probeCommand} must be gateEvidence`);
    assert(probePolicy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: ${probeCommand} destructiveRisk must stay metadata-write`);
    assert(policyBlockHasOwnershipClass(probePolicy, 'storyScopedMutating'), `${commandPolicyPath}: ${probeCommand} must stay storyScopedMutating`);
    for (const token of ['codex', 'claude', 'agy', '--version', 'executionReady', 'reviewReady', 'progressMode', 'failureKind', 'reviewReadyHostCount', 'material hash', 'storyFilesHash', 'review escalation DONE gate', 'review assurance floor DONE gate']) {
      assert(new RegExp(token, 'i').test(probePolicy.reason), `${commandPolicyPath}: ${probeCommand} policy must name ${token}`);
    }
    assertLocalAssuranceNoReleaseBoundary(probePolicy.reason, `${commandPolicyPath}: ${probeCommand} policy`);
  }
  const probeLevel = levelRegistry.get(probeCommand);
  assert(probeLevel, `${processFactLevelRegistryPath}: ${probeCommand} missing level entry`);
  if (probeLevel) {
    assert(probeLevel.level === 'L4', `${processFactLevelRegistryPath}: ${probeCommand} must stay L4`);
    assert(probeLevel.category === 'review-host-availability-probe', `${processFactLevelRegistryPath}: ${probeCommand} category drifted`);
    assert(probeLevel.owner === 'handlers/review-escalation', `${processFactLevelRegistryPath}: ${probeCommand} owner drifted`);
    assert(/review_host_availability_probe/i.test(probeLevel.rationale), `${processFactLevelRegistryPath}: ${probeCommand} rationale must name review_host_availability_probe`);
    assert(/reviewReadyHostCount below 2 canonical hosts/i.test(probeLevel.rationale), `${processFactLevelRegistryPath}: ${probeCommand} rationale must name the degraded fallback review-readiness threshold`);
    assert(/review escalation/i.test(probeLevel.gateConsumer || ''), `${processFactLevelRegistryPath}: ${probeCommand} gateConsumer must name review escalation`);
    assert(/review assurance floor/i.test(probeLevel.gateConsumer || ''), `${processFactLevelRegistryPath}: ${probeCommand} gateConsumer must name review assurance floor`);
  }
  const probeRegistry = registry.get(probeCommand);
  assert(probeRegistry, `${processFactRegistryPath}: ${probeCommand} missing registry entry`);
  if (probeRegistry) {
    assert(probeRegistry.level === 'L4', `${processFactRegistryPath}: ${probeCommand} registry level must stay L4`);
    assert(probeRegistry.kind === 'host-availability-probe', `${processFactRegistryPath}: ${probeCommand} registry kind must stay host-availability-probe`);
    assert(probeRegistry.gateEvidence === true, `${processFactRegistryPath}: ${probeCommand} registry gateEvidence must stay true`);
    assert(probeRegistry.semantics.includes('host-availability'), `${processFactRegistryPath}: ${probeCommand} registry missing host-availability semantic`);
    assert(probeRegistry.semantics.includes('host-readiness'), `${processFactRegistryPath}: ${probeCommand} registry missing host-readiness semantic`);
    assert(probeRegistry.artifact?.path === 'process-events.jsonl', `${processFactRegistryPath}: ${probeCommand} must record process-events.jsonl evidence`);
    assert(/review escalation/i.test(probeRegistry.consumerGate), `${processFactRegistryPath}: ${probeCommand} consumerGate must name review escalation`);
    assert(/review assurance floor/i.test(probeRegistry.consumerGate), `${processFactRegistryPath}: ${probeCommand} consumerGate must name review assurance floor`);
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
    assert(/review_host_availability_probe|reviewReadyHostCount below 2 canonical hosts/i.test(fallbackPolicy.reason), `${commandPolicyPath}: ${fallbackCommand} policy must describe fresh host readiness probe binding for non-human fallback`);
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
    assert(/review_host_availability_probe/i.test(fallbackLevel.rationale), `${processFactLevelRegistryPath}: ${fallbackCommand} rationale must name review_host_availability_probe`);
    assert(/review escalation/i.test(fallbackLevel.gateConsumer || ''), `${processFactLevelRegistryPath}: ${fallbackCommand} gateConsumer drifted`);
    assert(/review assurance floor/i.test(fallbackLevel.gateConsumer || ''), `${processFactLevelRegistryPath}: ${fallbackCommand} gateConsumer must name review assurance floor`);
  }
  const fallbackRegistry = registry.get(fallbackCommand);
  assert(fallbackRegistry, `${processFactRegistryPath}: ${fallbackCommand} missing registry entry`);
  if (fallbackRegistry) {
    assert(fallbackRegistry.level === 'L4', `${processFactRegistryPath}: ${fallbackCommand} registry level must stay L4`);
    assert(fallbackRegistry.gateEvidence === true, `${processFactRegistryPath}: ${fallbackCommand} registry gateEvidence must stay true`);
    assert(fallbackRegistry.semantics.includes('host-availability'), `${processFactRegistryPath}: ${fallbackCommand} registry missing host-availability semantic`);
    assert(fallbackRegistry.semantics.includes('host-readiness'), `${processFactRegistryPath}: ${fallbackCommand} registry missing host-readiness semantic`);
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
    assert(levelEntry.category === 'proof-or-stop-local-host-verdict', `${processFactLevelRegistryPath}: ${commandName} category must stay proof-or-stop-local-host-verdict`);
    assert(levelEntry.owner === 'handlers/verdict', `${processFactLevelRegistryPath}: ${commandName} owner drifted`);
    assert(/storyFilesHash/i.test(levelEntry.rationale), `${processFactLevelRegistryPath}: ${commandName} rationale must name storyFilesHash`);
    for (const token of ['deriveBindings', 'validation execution lock', 'canonical PASS-admissibility', 'trusted story-metadata-descendant', 'keyId', 'validationDigest', 'promptDigest', 'fails closed', 'exactly one', 'legacy']) {
      assert(new RegExp(token, 'i').test(levelEntry.rationale), `${processFactLevelRegistryPath}: ${commandName} rationale must name ${token}`);
    }
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
    for (const semantic of ['host-verdict', 'execution-evidence', 'freshness-policy', 'schema-contract', 'gate-evidence']) {
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
    assert(quorumLevelEntry.category === 'proof-or-stop-local-host-verdict', `${processFactLevelRegistryPath}: ${quorumCommand} category must stay proof-or-stop-local-host-verdict`);
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
    for (const semantic of ['host-verdict', 'execution-evidence', 'atomic-persistence', 'gate-evidence']) {
      assert(quorumRegistryEntry.semantics.includes(semantic), `${processFactRegistryPath}: ${quorumCommand} missing ${semantic} semantic`);
    }
    for (const token of ['one immutable metadata commit', 'pre-dirty refusal', 'HEAD CAS', 'all-row rollback']) {
      assert(new RegExp(token, 'i').test(quorumLevelEntry?.rationale || ''), `${processFactLevelRegistryPath}: ${quorumCommand} rationale must name ${token}`);
    }
    assert(/review escalation/i.test(quorumRegistryEntry.consumerGate), `${processFactRegistryPath}: ${quorumCommand} consumerGate drifted (${quorumRegistryEntry.consumerGate})`);
    assert(/review assurance floor/i.test(quorumRegistryEntry.consumerGate), `${processFactRegistryPath}: ${quorumCommand} consumerGate must name review assurance floor (${quorumRegistryEntry.consumerGate})`);
  }
  const cliEngineText = read('packages/main/src/cli-engine.ts');
  assert(
    cliEngineText.includes("if (entry.command === 'quorum_submit') return;"),
    'packages/main/src/cli-engine.ts: quorum_submit must retain sole ownership of its atomic process-events terminal instead of receiving a generic post-handler codex_cli append',
  );

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
    assert(runtimeRegistry.semantics.includes('host-availability'), `${processFactRegistryPath}: ${runtimeName} missing host-availability semantic`);
    assert(runtimeRegistry.semantics.includes('gate-evidence'), `${processFactRegistryPath}: ${runtimeName} missing gate-evidence semantic`);
    assert(runtimeRegistry.consumerGate === 'storyMachine.canFinish DONE review escalation gate', `${processFactRegistryPath}: ${runtimeName} consumerGate drifted`);
  }
  const evaluatorText = read('packages/main/src/core/review-escalation.ts');
  for (const token of [
    'REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE',
    'explicitlyConfiguredHighRiskPolicyRequires3x2',
    'review_escalation_policy',
    'degradedFallbackAllowed',
    'review_host_availability_probe',
    'hostAvailabilityProbeId',
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
    'missing host readiness probe blocks non-human degraded fallback',
    'probe with reviewReadyHostCount below two permits degraded 3x1',
    'probe with two executable canonical hosts blocks single-host fallback',
    'explicit-human-approval remains lower assurance degraded fallback',
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
    // B-956f FIX 2: the L4 rationale must ALSO name the language-neutral
    // material-code policy semantics the floor now delegates to — policy
    // resolution, hash-bound snapshot freshness, the diff-enumeration hard-block,
    // and the shared repro/ProofStory consumers.
    for (const token of [
      'material code diffs', '3x1', '3x2', 'high-risk', 'local evidence', 'release readiness',
      'language-neutral', 'material-code policy', 'snapshot freshness', 'diff enumeration', 'repro-evidence-binding',
    ]) {
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
    assert(registryEntry.semantics.includes('host-availability'), `${processFactRegistryPath}: ${runtimeName} missing host-availability semantic`);
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
    'evaluateHostVerdictRounds',
    'review_escalation_fallback',
    'reviewEscalationFallbackRecordFromEvent',
  ]) {
    assert(evaluatorText.includes(token), `packages/main/src/core/review-assurance-floor.ts: required review assurance floor token missing: ${token}`);
  }

  // B-956f FIX 2 (R5 — codex defeated the includes()/name-match AST assertions with
  // dead-branch calls, same-named LOCAL shadows, and whole-file ProofStory scans):
  // assert via a real ts.Program + TypeChecker that each delegation is a LIVE,
  // non-nested call whose callee SYMBOL resolves to material-code-policy (not a name
  // match), with the snapshot builds also DATA-FLOW-checked (result consumed). The
  // ProofStory assertions are scoped to the builder FUNCTION BODY (not the file) and
  // follow one hop through the local helper the property delegates to.
  const MCP = 'material-code-policy';
  const floorSf = materialProgramSourceFile('packages/main/src/core/review-assurance-floor.ts');
  const floorFn = findFunctionDeclaration(floorSf, 'evaluateReviewAssuranceFloor');
  assert(floorFn && floorFn.body, 'packages/main/src/core/review-assurance-floor.ts: evaluateReviewAssuranceFloor function declaration must exist');
  assert(
    functionBodyHasResolvedCall(floorFn, 'buildMaterialClassificationSnapshot', MCP, { requireConsumed: true }),
    'packages/main/src/core/review-assurance-floor.ts: evaluateReviewAssuranceFloor MUST make a LIVE call to buildMaterialClassificationSnapshot resolving to material-code-policy whose result is consumed (not a dead-branch / discarded / same-named-local call)',
  );
  assert(
    functionBodyHasResolvedCall(floorFn, 'ensureFreshMaterialClassificationSnapshot', MCP),
    'packages/main/src/core/review-assurance-floor.ts: evaluateReviewAssuranceFloor MUST call ensureFreshMaterialClassificationSnapshot from material-code-policy (hash-bound snapshot freshness validation of a supplied classification)',
  );
  assert(
    hasDiffEnumerationBlockingBranch(floorFn.body),
    'packages/main/src/core/review-assurance-floor.ts: evaluateReviewAssuranceFloor MUST have a diffEnumerationError blocking branch that returns an ok:false outcome (an unenumerable diff hard-blocks, never a silent empty change set)',
  );
  // The exported per-path classifier itself must delegate to the pure 8-step chain.
  const classifyFn = findFunctionDeclaration(floorSf, 'classifyReviewAssuranceFloorPath');
  assert(classifyFn && classifyFn.body, 'packages/main/src/core/review-assurance-floor.ts: classifyReviewAssuranceFloorPath function declaration must exist');
  assert(
    functionBodyHasResolvedCall(classifyFn, 'classifyMaterialCodePath', MCP, { requireConsumed: true }),
    'packages/main/src/core/review-assurance-floor.ts: classifyReviewAssuranceFloorPath MUST make a LIVE call to classifyMaterialCodePath from material-code-policy whose result is consumed (delegate to the config-resolved policy, no TS-only whitelist)',
  );

  // The repro-evidence-binding gate consumer: evaluateStoryEvidenceBindingGate must
  // build the snapshot and feed it into the snapshot-required repro classify.
  const reproSf = materialProgramSourceFile('packages/main/src/core/repro-evidence-binding-gate.ts');
  const reproFn = findFunctionDeclaration(reproSf, 'evaluateStoryEvidenceBindingGate');
  assert(reproFn && reproFn.body, 'packages/main/src/core/repro-evidence-binding-gate.ts: evaluateStoryEvidenceBindingGate function declaration must exist');
  assert(
    functionBodyHasResolvedCall(reproFn, 'buildMaterialClassificationSnapshot', MCP, { requireConsumed: true }),
    'packages/main/src/core/repro-evidence-binding-gate.ts: evaluateStoryEvidenceBindingGate MUST make a LIVE call to buildMaterialClassificationSnapshot resolving to material-code-policy whose result is consumed (shared classifier delegation, not a dead-branch / same-named-local call)',
  );
  assert(
    functionBodyHasResolvedCall(reproFn, 'classifyReproFirstRequirement', 'repro-evidence-binding-gate', { requireConsumed: true }),
    'packages/main/src/core/repro-evidence-binding-gate.ts: evaluateStoryEvidenceBindingGate MUST feed the snapshot into a LIVE classifyReproFirstRequirement call (snapshot-required repro classification)',
  );

  // The ProofStory diagnostic-input builders must POPULATE materialClassification in
  // the builder BODY with a real delegation to tryBuildMaterialClassificationSnapshotForDiagnostics
  // (resolved to material-code-policy) — either directly or via one local helper. A
  // `materialClassification: null` in the builder while the token lingers elsewhere
  // in the file (codex defeat c) now exits 1.
  for (const [relPath, builderFn] of [
    ['packages/main/src/handlers/phase-gates.ts', 'proofStoryDiagnosticInput'],
    ['packages/main/src/handlers/proofstory.ts', 'diagnosticInput'],
  ]) {
    const sf = materialProgramSourceFile(relPath);
    const fn = findFunctionDeclaration(sf, builderFn);
    assert(fn && fn.body, `${relPath}: ${builderFn} function declaration must exist`);
    const TRY = 'tryBuildMaterialClassificationSnapshotForDiagnostics';
    // B-956f FIX 3 (defeat b): EVERY reachable return object — not just the first
    // materialClassification occurrence anywhere in the body — must carry the property
    // bound to the try-build delegation. A live return with `materialClassification:
    // null`/undefined now exits 1 even when a decoy delegation sits in a runtime-dead
    // (non-literal) branch.
    const returnObjects = builderReturnObjectLiterals(fn);
    assert(
      returnObjects.length > 0,
      `${relPath}: ${builderFn} MUST return a diagnostic-input object literal`,
    );
    for (const objLit of returnObjects) {
      const init = objectLiteralMaterialClassificationInit(objLit);
      const initIsCall = !!init && ts.isCallExpression(init);
      assert(
        initIsCall,
        `${relPath}: ${builderFn} MUST populate the materialClassification property in EVERY reachable return with a function call (a real delegation, not a null/constant/omitted field)`,
      );
      // Only resolve the delegation when the initializer is actually a call — the
      // verifier's assert() records failures and CONTINUES, so guard against running
      // callee resolution on a null/constant initializer (defeat b/c: `: null`).
      if (initIsCall) {
        assert(
          initializerDelegatesToTry(init),
          `${relPath}: ${builderFn} materialClassification MUST delegate (directly or via one local helper) to ${TRY} from material-code-policy in EVERY reachable return (real production population, not a whole-file token)`,
        );
      }
    }
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
    'missing host readiness probe blocks non-human high-risk degraded fallback',
    'probe with reviewReadyHostCount below two permits high-risk degraded 3x1',
    'probe with two executable canonical hosts blocks high-risk single-host fallback',
    'explicit-human-approval remains lower assurance without host probe',
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

function assertDeliveryPromiseOutcomeContract(registry, levelRegistry) {
  const runtimeName = 'runtime:delivery_promise_outcome_done_gate';
  const levelEntry = levelRegistry.get(runtimeName);
  assert(levelEntry, `${processFactLevelRegistryPath}: required delivery-promise outcome runtime fact missing`);
  if (levelEntry) {
    assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${runtimeName} must stay L4`);
    assert(levelEntry.owner === 'core/delivery-promise-outcome', `${processFactLevelRegistryPath}: ${runtimeName} owner drifted`);
    for (const token of ['total shared normalizer', 'delivery_promise_outcome_contradiction', 'before persistence', 'missing-status legacy']) {
      assert(new RegExp(token, 'i').test(levelEntry.rationale), `${processFactLevelRegistryPath}: ${runtimeName} rationale must name ${token}`);
    }
  }

  const registryEntry = registry.get(runtimeName);
  assert(registryEntry, `${processFactRegistryPath}: required process fact missing: ${runtimeName}`);
  if (registryEntry) {
    assert(registryEntry.level === 'L4', `${processFactRegistryPath}: ${runtimeName} must stay L4`);
    for (const semantic of ['runtime-behavior', 'schema-contract', 'normalization-policy', 'gate-evidence']) {
      assert(registryEntry.semantics.includes(semantic), `${processFactRegistryPath}: ${runtimeName} missing semantic ${semantic}`);
    }
  }

  const normalizer = read('packages/main/src/core/delivery-promise-outcome.ts');
  for (const token of ['normalizeDeliveryPromiseOutcome', 'verified', 'waived', 'unresolved', 'delivery_promise_outcome_contradiction']) {
    assert(normalizer.includes(token), `delivery-promise-outcome.ts: required totality token missing: ${token}`);
  }
  for (const [path, token] of [
    ['packages/main/src/handlers/delivery-check.ts', 'normalizeDeliveryPromiseOutcome'],
    ['packages/main/src/core/machine.ts', 'deliveryPromiseBlocksDone'],
    ['packages/main/src/core/done-oracle.ts', 'deliveryPromiseBlocksDone'],
    ['packages/main/src/cli/command-catalog.ts', 'normalizeDeliveryPromiseOutcome'],
  ]) {
    assert(read(path).includes(token), `${path}: must consume shared delivery-promise outcome contract (${token})`);
  }
}

function assertReviewExecutionAuthorityContract(registry, levelRegistry) {
  const runtimeName = 'runtime:review_execution_authority_gate';
  const levelEntry = levelRegistry.get(runtimeName);
  assert(levelEntry, `${processFactLevelRegistryPath}: required review execution authority runtime fact missing`);
  if (levelEntry) {
    assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${runtimeName} must stay L4`);
    assert(levelEntry.gateConsumer === 'storyMachine.canPassReview REVIEW to TEST gate through collectReviewerEvidenceState shared revalidation', `${processFactLevelRegistryPath}: ${runtimeName} gateConsumer drifted`);
    for (const token of ['one-shot Ed25519 invocation attestation', 'externally registered host-adapter broker', 'exposes no issuer CLI', 'mixed Codex/Claude ancestry', 'native direct evidence is advisory-only', 'schema-valid bounded Codex agent_message', 'exact standalone Codex raw stdout envelope', 'ordinary Codex progress agent messages are excluded', 'Claude result final-result lane', 'idempotent replay', 'missing, malformed, multiple, oversized', 'compatibility-only']) {
      assert(levelEntry.rationale.includes(token), `${processFactLevelRegistryPath}: ${runtimeName} rationale must name ${token}`);
    }
  }

  const registryEntry = registry.get(runtimeName);
  assert(registryEntry, `${processFactRegistryPath}: required process fact missing from PROCESS_FACT_REGISTRY: ${runtimeName}`);
  if (registryEntry) {
    for (const semantic of ['runtime-behavior', 'signed-artifact', 'schema-contract', 'reviewer-lane', 'execution-evidence', 'gate-evidence']) {
      assert(registryEntry.semantics.includes(semantic), `${processFactRegistryPath}: ${runtimeName} missing ${semantic} semantic`);
    }
  }

  const nativeText = read('packages/main/src/core/native-review-evidence.ts');
  for (const token of ['issueNativeReviewEvidenceBinding', 'verifyNativeReviewEvidenceBinding', 'observeNativeHostProcess', 'mixedProviderFamilies', 'requires a registered host-adapter invocation attestation', 'cross-provider direct reviewer evidence is advisory-only']) {
    assert(nativeText.includes(token), `packages/main/src/core/native-review-evidence.ts: required authority token missing: ${token}`);
  }
  const attestationText = read('packages/main/src/core/native-review-attestation.ts');
  for (const token of ['signNativeReviewInvocationAttestation', 'verifyNativeReviewInvocationAttestation', 'consumeNativeReviewInvocationAttestation', "flag: 'wx'", 'LATTICE_NATIVE_REVIEW_ATTESTATION_FD', 'stores no broker']) {
    assert(attestationText.includes(token), `packages/main/src/core/native-review-attestation.ts: required broker-attestation token missing: ${token}`);
  }
  const reviewGateText = read('packages/main/src/core/review-run.ts');
  for (const token of ['review_execution_authority_missing', 'verifyNativeReviewEvidenceBinding', 'verifyManagedReviewEvidence', 'evidence: { kind:']) {
    assert(reviewGateText.includes(token), `packages/main/src/core/review-run.ts: required authority consumer token missing: ${token}`);
  }
  const importerText = read('packages/main/src/handlers/managed-review-evidence.ts');
  for (const token of ['candidate.evidence', 'proposalFindingIndex', 'existing receipt findings do not exactly cover every provider proposal index', 'storyMetadataLockDir', "'finding', 'review-passes'", "'findings.lock'", 'importedAt: sealedProposal?.authoredAt', 'assertCandidateReadBinding', 'assertCurrentCandidateReadBinding']) {
    assert(importerText.includes(token), `packages/main/src/handlers/managed-review-evidence.ts: required exact replay token missing: ${token}`);
  }
  const managedText = read('packages/main/src/core/managed-review-evidence.ts');
  for (const token of ['proposalArtifacts.length === 1', 'exactEvidenceMatches', 'processCleanup?.reaped === true']) {
    assert(managedText.includes(token), `packages/main/src/core/managed-review-evidence.ts: required managed authority token missing: ${token}`);
  }
  const managedHostRunText = read('packages/main/src/core/managed-host-run.ts');
  for (const token of ['submissionDigest', 'idempotency input conflict', 'idempotent submission pending or interrupted']) {
    assert(managedHostRunText.includes(token), `managed submission must retain durable duplicate-dispatch protection: ${token}`);
  }
  for (const token of ['finalAssistantResult', 'finalAssistantResultCount', 'finalAssistantResultTruncated', 'parseManagedReviewFinalProposal', 'managed_review_final_result_missing', 'assertSealedManagedHostRunArtifacts', 'isRecoverableManagedReviewImportBinding', 'withTerminalAuthorityLock', 'liveOutputDigest', "mismatches.push('live-output')", 'providerLaunchState', 'evidenceBindingSeal', 'cleanupManagedCrossHostReviewWorktree', 'cleanupManagedClaudePromptForTerminal', 'managedClaudePromptDirectoryForRun', 'reapManagedHostRunProviderProcess', 'AMBIGUOUS_PROCESS_CLEANUP', "launchProfile: 'managed_reviewer'", 'delete providerEnvironment.LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD', "descriptor.once('finish'", 'worker capability descriptor closed before write completion', 'classifyManagedHostRunCancellation', "reason === 'absolute_deadline_exceeded'", "state: 'timed_out'"]) {
    assert(managedHostRunText.includes(token), `packages/main/src/core/managed-host-run.ts: required final-result/seal authority token missing: ${token}`);
  }
  const ownershipGateText = read('packages/main/src/cli/ownership-gate.ts');
  assert(ownershipGateText.includes('managedHostRunStoryIdForOwnership'), 'host_run status/cancel/import ownership must resolve immutable spec.storyId from runId');
  assert(ownershipGateText.includes('aggregate targets must share one immutable Story ownership subject'),
    'aggregate observation must retain one mechanically admitted immutable owner subject');
  const aggregateWitness = read('scripts/verify-managed-aggregate-wait.mjs');
  for (const obligation of ['heartbeats across all runs do not wake the owner',
    'an acknowledged terminal does not repeatedly wake a resumed owner',
    'actual CLI schema accepts aggregate targets', 'aggregate retains immutable owner admission']) {
    assert(aggregateWitness.includes(obligation), `aggregate observation requires executable boundary coverage: ${obligation}`);
  }
  const hostRunText = read('packages/main/src/core/host-run.ts');
  for (const token of ['classifyManagedReviewFinalEnvelope', "classification.kind === 'ordinary'", 'MANAGED_REVIEW_FINAL_PROPOSAL_SCHEMA_VERSION', 'MANAGED_REVIEW_CLAUDE_JSON_SCHEMA_MAX_BYTES', 'managedClaudePromptDirectoryForRun', 'managedRunId', "join(args.cwd, PROOF_OR_STOP_DIR, 'runtime', 'host-run-prompts')", "'--permission-mode', 'bypassPermissions'", "'--json-schema', args.finalResultSchema === ACCEPTANCE_REVIEW_FINAL_SCHEMA ? JSON.stringify(acceptanceReviewJsonSchema()) : managedReviewClaudeJsonSchema(args)", "hasOwnProperty.call(event, 'structured_output')", "event.subtype !== 'success'", 'JSON.stringify(event.structured_output)']) {
    assert(hostRunText.includes(token), `packages/main/src/core/host-run.ts: required Codex proposal candidate classifier token missing: ${token}`);
  }
  const smokeText = read('packages/main/src/tasks/managed-review-evidence-smoke.ts');
  for (const token of ['absence of a managed binding is not proof', 'isolated broker-signature fixture succeeds without consulting ambient provider ancestry', 'withoutManagedAmbientAuthority', "'--brokered-native-binding-fixture'", 'raw provider cannot self-mint authority', 'mixed tree is rejected', 'real raw cross-provider CLI review_pass_set must fail', 'real raw cross-provider CLI finding_add must fail', 'idempotent importer replay revalidates the exact persisted provider finding', 'multiple proposal artifacts also fail the persisted REVIEW gate', 'DISPATCH_START reviewer accepted the managed assignment', 'Reviewed the first evidence group; continuing with adversarial paths.', 'the exact provider final-result proposal is importable without a provider tool-shell callback', 'public managed Claude prompt is inside the exact provider cwd', 'public managed Claude launch cannot block on interactive tool approval', 'public managed Claude launch supplies its bounded structured-output schema', 'worker descriptor capability metadata is not inherited as ordinary provider authority', 'public managed Claude final proposal is exactly importable', "name: 'missing'", "name: 'malformed'", "name: 'multiple'", "name: 'oversize'", 'final result fails closed', 'controller must not be able to add or override proposal verdict fields', 'injected crash before story evidence persistence']) {
    assert(smokeText.includes(token), `packages/main/src/tasks/managed-review-evidence-smoke.ts: required executable boundary assertion missing: ${token}`);
  }
  const catalogText = read('packages/main/src/cli/command-catalog.ts');
  const helpText = read('packages/main/src/cli/help-renderer.ts');
  const mainToolsText = read('packages/main/src/cli/main-tools.ts');
  const cliSurfaceSmokeText = read('packages/main/src/tasks/cli-surface-smoke.ts');
  assert(catalogText.includes("name: 'host_run_worker', visibility: 'internal'"), 'host_run_worker must remain internal in the command catalog');
  assert(mainToolsText.includes('publicToolCatalog') && mainToolsText.includes("tool.visibility !== 'internal'"), 'public tool catalog must filter internal runtime-continuation commands');
  assert(catalogText.includes('PUBLIC_MAIN_TOOLS') && catalogText.includes('publicToolCatalog(MAIN_TOOLS)'), 'command catalog must expose a public discovery view distinct from the dispatch registry');
  assert(helpText.includes('publicToolCatalog(options.tools)'), 'ordinary help must consume the public tool catalog filter');
  for (const token of ['brief ordinary discovery hides the internal managed worker', 'node bin/lattice.js help hides the internal worker', 'full ordinary discovery hides the internal managed worker', 'internal continuation remains dispatchable outside public discovery']) {
    assert(cliSurfaceSmokeText.includes(token), `packages/main/src/tasks/cli-surface-smoke.ts: missing internal visibility assertion: ${token}`);
  }

  const hostRunHandlerText = read('packages/main/src/handlers/host-run.ts');
  for (const token of ['optionalPositiveInteger', 'optionalNonnegativeInteger', '[host_run] submitted runId=', 'waitMs, 30_000']) {
    assert(hostRunHandlerText.includes(token), `packages/main/src/handlers/host-run.ts: required managed observability/schema token missing: ${token}`);
  }
  const providerRegistryText = read('packages/main/src/core/provider-process-registry.ts');
  assert(providerRegistryText.includes('mutationOps.unlink(file)'), 'provider slot release must surface the exact unlink mutation failure');
  assert(!providerRegistryText.includes('Best effort: a later acquire reclaims this slot'), 'provider slot release must not suppress registry-lock failure');

  const deliveryAuthorityText = read('packages/main/src/core/delivery-review-authority.ts');
  assert(deliveryAuthorityText.includes("DELIVERY_REVIEW_LANE = 'proof-or-stop-review-delivery'"), 'delivery dispatch and native provenance must use the registered canonical lane');
  for (const token of ['deliveryReviewDispatchBindingDigest', 'authorizeNativeDeliveryReview', 'issueNativeReviewEvidenceBinding']) {
    assert(deliveryAuthorityText.includes(token), `packages/main/src/core/delivery-review-authority.ts: required delivery broker token missing: ${token}`);
  }
  const deliveryHandlerText = read('packages/main/src/handlers/delivery-check.ts');
  assert(deliveryHandlerText.includes('authorizeNativeInvocation'), 'delivery_check_set must authorize the native broker invocation before persistence');
  const deliveryBrokerSmokeText = read('packages/main/src/tasks/delivery-check-native-attestation-smoke.ts');
  assert(read('packages/main/src/core/delivery-check-hash.ts').includes("agentRoleIdsEqual(String(event.agentType ?? ''), DELIVERY_REVIEW_LANE)"), 'delivery DONE reader must compare registered role identities without dropping broker signature checks');
  assert(deliveryBrokerSmokeText.includes('canonical delivery dispatch preserves valid broker provenance at the DONE reader'), 'delivery broker smoke must accept untampered canonical dispatch before testing forged provenance');
  for (const token of ['a raw delivery-reviewer identity without broker provenance must fail closed', 'Brokered delivery reviewer authors exact formal evidence.']) {
    assert(deliveryBrokerSmokeText.includes(token), `delivery-check-native-attestation-smoke.ts: required executable broker assertion missing: ${token}`);
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

function assertCurrentPromptIdentityBoundary() {
  const contracts = read('packages/main/src/core/prompt-contracts.ts');
  const envelope = read('packages/main/src/core/prompt-envelope.ts');
  const reviewRun = read('packages/main/src/core/review-run.ts');
  const registry = read(processFactRegistryPath);

  for (const token of [
    'CURRENT_PROMPT_IDENTITIES',
    'PROMPT_ENVELOPE_ACTIVE_IDENTITY_PATHS',
    'assertPromptEnvelopeIdentityRegistryTotal',
    'validatePromptEnvelopeAgainst(value)',
    "promptEnvelope: 'proof-or-stop.prompt-envelope.v1'",
  ]) {
    assert(contracts.includes(token), `prompt-contracts.ts: current Prompt identity boundary missing ${token}`);
  }
  for (const retiredToken of ['LEGACY_PROMPT_IDENTITIES', 'validateLegacyPromptEnvelope']) {
    assert(!contracts.includes(retiredToken), `prompt-contracts.ts: retired Prompt identity API remains active: ${retiredToken}`);
  }
  for (const path of [
    'schemaVersion',
    'runtimeContractVersion',
    'roleContractVersion',
    'assemblerVersion',
    'dispatchProtocolVersion',
  ]) {
    assert(contracts.includes(`'${path}'`), `prompt-contracts.ts: active Prompt Envelope identity path missing ${path}`);
  }
  assert(
    contracts.includes("proof-or-stop.digest.v1\\0${domain}\\0"),
    'prompt-contracts.ts: current proof-or-stop.digest.v1 domain separator must remain exact',
  );
  for (const token of [
    'verifyPromptEnvelopeIntegrity',
    'validatePromptEnvelope(envelope)',
  ]) {
    assert(envelope.includes(token), `prompt-envelope.ts: current reader boundary missing ${token}`);
  }
  for (const retiredToken of ['verifyLegacyPromptEnvelopeIntegrity', 'validateLegacyPromptEnvelope']) {
    assert(!envelope.includes(retiredToken), `prompt-envelope.ts: retired Prompt identity reader remains active: ${retiredToken}`);
  }
  for (const token of [
    "REVIEW_RUN_SALT = 'proof-or-stop-review-run-integrity-v1'",
    'verifyReviewRunSignatureIntegrity',
    'hasOnlyKeys(run',
    'verifyReviewScopeBinding(run.scopeBinding)',
    'reviewRunPromptUsesCurrentIdentityFamily(run, body)',
    'readReviewPromptBody(promptStore.storyDirPath(run.storyId), run)',
    'if (!verifyReviewRunSignatureIntegrity(run)) return false;',
    'run.assembledPromptRef === run.promptHash',
  ]) {
    assert(reviewRun.includes(token), `review-run.ts: current signed ReviewRun boundary missing ${token}`);
  }
  for (const retiredToken of ['verifyLegacyReviewRun', 'LEGACY_PROMPT_IDENTITIES']) {
    assert(!reviewRun.includes(retiredToken), `review-run.ts: retired ReviewRun reader remains active: ${retiredToken}`);
  }
  for (const token of [
    'Fresh Story writers persist exact proof-or-stop.* Prompt identities',
    'retired identity family remain inert historical bytes',
    'reject them without a compatibility fallback',
    'Fresh rows carry exact proof-or-stop.* Prompt identities; retired-family rows are inert and rejected by active readers without a compatibility fallback.',
  ]) {
    assert(registry.includes(token), `${processFactRegistryPath}: Prompt identity process contract missing ${token}`);
  }
  assert(
    !registry.includes('exact proof-or-stop.* rows are available only through the named legacy verifier'),
    `${processFactRegistryPath}: canonical Prompt identity must never be described as legacy-verifier-only`,
  );
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

function assertCurrentVerificationReceiptModel() {
  // Collapse whitespace before matching so a claim cannot evade the contract by
  // wrapping its subject and predicate onto different Markdown/comment lines.
  // Positive grammatical predicates are matched directly; legacy keywords do
  // not waive a contradictory later clause, and negative/historical predicates
  // are outside the accepted positive forms by construction.
  const staleClaim = (text) => {
    const bounded = text.replace(/\s+/g, ' ').trim();
    return positiveCurrentBundleV3Patterns.some(pattern => pattern.test(bounded));
  };
  for (const sample of [
    'VerificationReceiptBundleV3 is current and admissible.',
    'BundleV3 is legacy but remains current/admissible.',
    'VerificationReceiptBundleV3\ncontinues to be authoritative for lifecycle admission.',
    'The authoritative receipt bundle\nis VerificationReceiptBundleV3.',
  ]) {
    assert(staleClaim(sample), `receipt-model scanner must reject positive current/admissible Bundle V3 claim: ${JSON.stringify(sample)}`);
  }
  for (const sample of [
    'VerificationReceiptBundleV3 is not current or admissible.',
    'VerificationReceiptBundleV3 cannot satisfy lifecycle admission or authorize reuse.',
    'VerificationReceiptBundleV3 was historically authoritative before V5.',
    'VerificationReceiptBundleV3 is legacy read-only and non-reusable.',
    'The current authoritative receipt bundle is VerificationReceiptBundleV5; VerificationReceiptBundleV3 remains readable for audit only.',
  ]) {
    assert(!staleClaim(sample), `receipt-model scanner must allow negative/historical/legacy Bundle V3 description: ${JSON.stringify(sample)}`);
  }
  for (const relPath of verificationReceiptModelPaths) {
    assert(
      !staleClaim(read(relPath)),
      `${relPath}: Bundle V3 / V1 assertion are legacy read-only compatibility; current authoritative evidence is Bundle V5 with a V3 execution component`,
    );
  }
  const decisionDoc = read('docs/requirements/decisions/verification-execution-receipt-fanout-and-input-scoped-freshness.md');
  assert(
    decisionDoc.includes('`VerificationReceiptBundleV5`')
      && decisionDoc.includes('is the only split bundle eligible for lifecycle admission and reuse'),
    'verification receipt decision must identify Bundle V5 as the sole lifecycle-admissible/reusable split bundle',
  );
  assert(
    decisionDoc.includes('`VerificationAssertionReceiptV1`, `VerificationReceiptBundleV2`, `VerificationReceiptBundleV3`')
      && decisionDoc.includes('cannot satisfy lifecycle admission'),
    'verification receipt decision must identify V1 assertion and Bundle V2/V3/V4 as legacy non-admissible compatibility',
  );
  assert(
    decisionDoc.includes('SHA-256 of the top-level compatibility selector must equal the selector digest carried by the independently signed assertion')
      && decisionDoc.includes('ExecutionReceipt remains selector-free'),
    'verification receipt decision must bind the V5 compatibility selector to the signed assertion without polluting the execution identity',
  );
  const narrowingDecision = read('docs/requirements/decisions/narrowing-only-evidence-repin.md');
  const normalizedNarrowingDecision = narrowingDecision.replace(/\s+/g, ' ');
  // B-aa5f F-048: an authenticated selector does not authenticate a persisted
  // display tail. Trace the validated complete-output value into every decision.
  const receiptValidator = extractNamedFunctionBody(
    read('packages/main/src/core/verification-execution-evidence.ts'), 'validateVerificationReceipt',
  ) ?? '';
  assert(
    receiptValidator.includes('receipt.outputTail !== boundedOutputTail(output)')
      && receiptValidator.includes('receipt outputTail compatibility mismatch'),
    'V5 receipt validation must compare the display projection with complete authenticated output',
  );
  const verificationSource = read('packages/main/src/core/verification.ts');
  const narrowingLabelSource = read('packages/main/src/handlers/checklist.ts');
  assert(narrowingLabelSource.includes('Proved from current signed authoritative V5 receipts')
    && !narrowingLabelSource.includes('Proved from current signed authoritative V4 receipts'),
    'successful current narrowing must truthfully identify its required V5 authority');
  assert(verificationSource.includes('Complete output returned by authoritative receipt/artifact validation.'),
    'validated complete-output consumer documentation must not imply obsolete V4-only authority');
  assert(read('packages/main/src/core/process-fact-registry.ts').includes('unprovable executable resolution fails closed'),
    'verification process facts must retain actual-spawn toolchain currentness and fail-closed resolution');
  assert(receiptValidator.includes('authenticated execution command mismatch'), 'receipt reader must authenticate the requested command');
  assert(receiptValidator.includes('publication freshness binding mismatch'), 'receipt reader must bind unsigned outer coordinates to the signed context');
  const inventoryProjection = read('packages/main/src/core/review-inventory-epoch.ts');
  assert(inventoryProjection.includes('proof-or-stop.inventory-verification-observation.v1')
    && inventoryProjection.includes('validateVerificationReceipt')
    && inventoryProjection.includes('executionIdentityDigest: execution.executionIdentityDigest'),
    'inventory projection must authenticate first and retain versioned execution-input semantics');
  const publicationIssuer = extractNamedFunctionBody(read('packages/main/src/core/verification-execution-evidence.ts'), 'createCurrentVerificationAssertionReceipt') ?? '';
  assert(publicationIssuer.includes("'publication', digested") && publicationIssuer.includes('freshness: { ...input.freshness }'),
    'current publication must sign the exact freshness tuple in its own authenticity domain');
  const collector = extractNamedFunctionBody(verificationSource, 'collectRecordedPinnedReceipts') ?? '';
  const narrowing = extractNamedFunctionBody(verificationSource, 'evaluateSelectorNarrowing') ?? '';
  const narrowingHandler = extractNamedFunctionBody(read('packages/main/src/handlers/checklist.ts'), 'narrowVerificationPin') ?? '';
  assert(
    collector.includes('const output = readValidatedOutput(') && !collector.includes('receipt.outputTail'),
    'narrowing collection must require validated complete output without a compatibility-tail fallback',
  );
  assert(
    narrowingHandler.includes("typeof validation.output !== 'string'")
      && narrowingHandler.includes('return validation.output;'),
    'narrowing handler must fail closed without complete output and return the authoritative validator output',
  );
  for (const expression of [
    'r.output.includes(selector) && !r.output.includes(previousSelector)',
    'judgedByPin.filter(r => !r.output.includes(selector))',
    'passing.filter(r => !r.output.includes(selector))',
  ]) {
    assert(narrowing.includes(expression), `narrowing must decide against complete output: ${expression}`);
  }
  assert(!narrowing.includes('outputTail'), 'narrowing evaluator must never use a display tail as proof');
  assert(
    normalizedNarrowingDecision.includes('complete authenticated output')
      && normalizedNarrowingDecision.includes('never a proof fallback')
      && decisionDoc.includes('`outputTail` is display-only'),
    'receipt and narrowing decisions must distinguish complete-output proof from display tails',
  );
  const narrowingSmoke = read('packages/main/src/tasks/narrowing-repin-smoke.ts');
  for (const regression of ['CHK-002/B16', 'CHK-002/B17', 'CHK-002/B18']) {
    assert(narrowingSmoke.includes(regression), `registered narrowing smoke must retain ${regression}`);
  }
  assert(
    normalizedNarrowingDecision.includes('The narrowing consumer runs')
      && normalizedNarrowingDecision.includes('authoritative receipt validation before reading any projected witness fields')
      && normalizedNarrowingDecision.includes('narrowing_recorded_receipt_invalid')
      && normalizedNarrowingDecision.includes('Legacy combined receipts and Bundle V2/V3/V4 remain')
      && normalizedNarrowingDecision.includes('narrowing_recorded_receipt_not_authoritative'),
    'narrowing decision must require current signed V5 authority before consuming projected selector witnesses',
  );
  const commandCatalog = read('packages/main/src/cli/command-catalog.ts').replace(/\s+/g, ' ');
  assert(
    commandCatalog.includes('Only current signed authoritative VerificationReceiptBundleV5 receipts recorded by this tool for that pinned command may be proof witnesses')
      && commandCatalog.includes('legacy combined and Bundle V2/V3/V4 receipts remain audit-readable but are rejected with narrowing_recorded_receipt_not_authoritative')
      && commandCatalog.includes('record current signed V5 evidence first'),
    'verification_pin_narrow help must state the signed V5-only witness boundary, legacy refusal code, and remediation',
  );
  assert(
    !commandCatalog.includes('the proof is drawn ONLY from receipts this tool recorded for that pinned command'),
    'verification_pin_narrow help must not describe every tool-recorded legacy receipt as an authoritative witness',
  );
  const receiptTypes = read('packages/main/src/core/types.ts');
  assert(
    receiptTypes.includes('Current V3 execution component carried by the authoritative V5 bundle'),
    'verification receipt types must identify Execution V3 as the current V5 bundle execution component',
  );
  assert(
    receiptTypes.includes('Legacy V1 assertion: read-only, non-reusable, and non-admissible compatibility'),
    'verification receipt types must identify Assertion V1 as legacy read-only/non-reusable/non-admissible compatibility',
  );
  assert(
    receiptTypes.includes('Legacy V2 split bundle')
      && receiptTypes.includes('Legacy V3 split bundle: read-only, non-reusable, non-promotable, and')
      && receiptTypes.includes('cannot satisfy lifecycle admission'),
    'verification receipt types must identify Bundle V2/V3/V4 as legacy read-only/non-reusable/non-admissible compatibility',
  );
  const runtimeReceiptFacts = read('packages/main/src/core/runtime-fact-registry.ts');
  assert(
    runtimeReceiptFacts.includes('V2 assertions and V5 bundles bind executed versus reused publication'),
    'verification receipt runtime fact must assign publication mode and reuse binding to Assertion V2 / Bundle V5',
  );
  assert(
    runtimeReceiptFacts.includes('validates the V5 bundle, V3 execution, V2 assertion, required mode-specific V1 reuse lineage'),
    'verification gate runtime fact must name the current V5/V3/V2/V1 record model exactly',
  );
  assert(
    read(processFactLevelRegistryPath).includes('V5 bundle links across its V3 execution, V2 assertion, and optional V1 reuse components'),
    `${processFactLevelRegistryPath}: verification gate fact must name the current V5/V3/V2/V1 component model`,
  );
  assert(
    read('packages/main/src/tasks/certification-window-smoke.ts').includes('authoritative V5 bundle and V3 execution component'),
    'certification-window smoke fixture must describe the current V5 bundle rather than an authoritative V3 receipt',
  );
  assert(
    read('packages/main/src/tasks/verification-run-and-guard-smoke.ts').includes('authoritative V5 bundle and its V3 execution component'),
    'verification lifecycle smoke must describe the current V5 bundle rather than authoritative V3 validation',
  );
  const verificationReceiptSmoke = read('packages/main/src/tasks/verification-run-and-guard-smoke.ts');
  assert(
    verificationReceiptSmoke.includes('expected VerificationReceiptBundleV5 with VerificationAssertionReceiptV2 and VerificationExecutionReceiptV3'),
    'verification split-receipt helper diagnostic must name Bundle V5, Assertion V2, and Execution V3 exactly',
  );
  assert(
    verificationReceiptSmoke.includes('expected reuse-capable VerificationReceiptBundleV5 with VerificationExecutionReceiptV3 component'),
    'verification reusable-receipt helper diagnostic must name reuse-capable Bundle V5 and its Execution V3 component',
  );
  for (const staleDiagnostic of [
    'expected a v2 split receipt',
    'expected a v3 reuse-capable receipt',
  ]) {
    assert(
      !verificationReceiptSmoke.includes(staleDiagnostic),
      `verification receipt helper must reject stale ambiguous diagnostic: ${JSON.stringify(staleDiagnostic)}`,
    );
  }

  const refreshHelp = read('packages/main/src/cli/command-catalog.ts');
  for (const phrase of [
    'may reuse immutable evidence with zero subprocesses',
    'fails closed to at most one real rerun per affected execution key',
    'Timeout/nonzero failure demotes every dependent row, selector mismatch demotes only that row',
  ]) {
    assert(refreshHelp.includes(phrase), `verification_evidence_refresh_stale help must state: ${JSON.stringify(phrase)}`);
  }
  const normalizeCommentSurface = (text) => text
    .replace(/^\s*\/\*+\s?/gmu, ' ')
    .replace(/^\s*\*\/?\s?/gmu, ' ')
    .replace(/\s+/g, ' ');
  const refreshHandler = read('packages/main/src/handlers/checklist.ts');
  const normalizedRefreshHandler = normalizeCommentSurface(refreshHandler);
  for (const phrase of [
    'Safe input-scoped reuse can publish the prior immutable execution with zero subprocesses',
    'freshness fails closed',
    'at most one real rerun per affected execution key',
    'Timeout/nonzero failure demotes',
    'selector mismatch demotes only that row',
  ]) {
    assert(normalizedRefreshHandler.includes(phrase), `stale-refresh implementation contract must state: ${JSON.stringify(phrase)}`);
  }
  const normalizedVerificationReceiptSmoke = normalizeCommentSurface(verificationReceiptSmoke);
  for (const phrase of [
    'may reuse immutable evidence with zero subprocesses',
    'freshness fails closed to at most one real rerun per affected execution key',
    'Timeout/nonzero failure demotes every',
    'selector mismatch demotes only its row',
  ]) {
    assert(normalizedVerificationReceiptSmoke.includes(phrase), `stale-refresh smoke contract must state: ${JSON.stringify(phrase)}`);
  }
  for (const refreshDocPath of [
    'docs/step2-evidence-receipts-handoff.md',
    'docs/requirements/decisions/testing-infra.md',
    'docs/requirements/decisions/story-lifecycle.md',
  ]) {
    const refreshDoc = normalizeCommentSurface(read(refreshDocPath));
    for (const phrase of [
      'policy-owned deterministic capsule',
      'signed `ReuseReceipt` with zero subprocesses',
      'at most once per affected execution key',
      'fails closed',
    ]) {
      assert(refreshDoc.includes(phrase), `${refreshDocPath}: stale-refresh contract must state ${JSON.stringify(phrase)}`);
    }
  }
  const storyFilesHashDecision = normalizeCommentSurface(read('docs/requirements/decisions/story-files-hash-material-drift.md'));
  for (const phrase of [
    'Bounded input-closure exception for checklist verification',
    'current `VerificationReceiptBundleV5`, not a legacy bundle',
    'policy-owned deterministic capsule, not an arbitrary command',
    '`evidenceInputDigest` and selector-free execution identity are unchanged',
    'signed `ReuseReceipt` referencing the immutable prior execution',
    '`storyFilesHash` remains the strict fallback',
  ]) {
    assert(storyFilesHashDecision.includes(phrase), `story-files-hash drift decision must state ${JSON.stringify(phrase)}`);
  }
  for (const diagnostic of [
    ['[verification_refresh_execution_timeout]', 'shared execution was attempted and timed out'],
    ['[verification_refresh_execution_nonzero]', 'shared execution was attempted and exited nonzero'],
  ]) {
    const [code, phrase] = diagnostic;
    assert(refreshHandler.includes(code) && refreshHandler.includes(phrase),
      `stale-refresh handler must persist truthful execution-failure provenance ${code}`);
    assert(verificationReceiptSmoke.includes(code.slice(1, -1)) && verificationReceiptSmoke.includes(phrase),
      `stale-refresh smoke must assert handler and persisted provenance ${code}`);
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
    if (text.includes('delivery-check.json') || canonicalRoleId(name) === 'proof-or-stop-product-reviewer') {
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

function assertCrossHostReviewManagedDelegationContract(levelRegistry, policyByName) {
  const commandName = 'cross_host_review';
  const levelEntry = levelRegistry.get(commandName);
  const policy = policyByName.get(commandName);
  assert(levelEntry, `${processFactLevelRegistryPath}: ${commandName} managed-delegation fact missing`);
  assert(policy, `${commandPolicyPath}: ${commandName} managed-delegation policy missing`);
  if (!levelEntry || !policy) return;

  const descriptions = [
    { label: `${processFactLevelRegistryPath}: ${commandName} rationale`, text: levelEntry.rationale },
    { label: `${commandPolicyPath}: ${commandName} reason`, text: policy.reason },
  ];
  for (const description of descriptions) {
    for (const token of ['ManagedHostRun', 'terminal receipt', 'supervision/reaping']) {
      assert(description.text.includes(token), `${description.label} must describe ManagedHostRun terminal-receipt ownership: missing ${token}`);
    }
    assert(
      /fail-closed before ManagedHostRun submission/i.test(description.text),
      `${description.label} must preserve the fail-closed review-policy admission before ManagedHostRun submission`,
    );
    assert(
      !/\bspawns?\s+(?:a\s+)?bounded\s+read-only\s+codex\s+review\s+(?:leaf|subprocess)\b/i.test(description.text),
      `${description.label} must not regress to the retired controller-direct Codex spawn description`,
    );
  }
  assert(
    policy.reason.includes('allowReviewOnlyRealHostSubprocess for a codex host'),
    `${commandPolicyPath}: ${commandName} must retain the real Codex review-only dispatch-policy grant`,
  );

  const handlerText = read('packages/main/src/handlers/cross-host-review.ts');
  for (const token of ['authorizeReviewPolicy', 'allowReviewOnlyRealHostSubprocess === true', "includes('codex')", 'submitManagedHostRun(submitArgs,', 'bindManagedSingletonSubmission(submitArgs,', 'managedHostRunReceipt(']) {
    assert(handlerText.includes(token), `packages/main/src/handlers/cross-host-review.ts: ${commandName} managed delegation contract missing ${token}`);
  }
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

  for (const [factName, expectedSemantics] of Object.entries(requiredRuntimeFactSemantics)) {
    const entry = registry.get(factName);
    assert(entry, `${processFactRegistryPath}: required runtime process fact missing from PROCESS_FACT_REGISTRY: ${factName}`);
    if (!entry) continue;
    assert(
      expectedSemantics.every((semantic) => entry.semantics.includes(semantic)),
      `${processFactRegistryPath}: required runtime semantic fact missing for name=${factName} expected=[${expectedSemantics.join(', ')}] got=[${entry.semantics.join(', ')}]`,
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
    const entry = reviewerLaneEntry(registry, lane);
    assert(entry, `${processFactRegistryPath}: reviewer lane missing from PROCESS_FACT_REGISTRY: lane=${lane}`);
    if (!entry) continue;
    assert(entry.kind === 'reviewer-lane', `${processFactRegistryPath}: reviewer lane ${lane} must have kind reviewer-lane`);
    assert(canonicalRoleId(entry.reviewerLane) === lane, `${processFactRegistryPath}: reviewer lane drift for lane=${lane}`);
    assert(entry.consumerGate, `${processFactRegistryPath}: reviewer lane ${lane} must name consumer gate`);
    assert(entry.artifact, `${processFactRegistryPath}: reviewer lane ${lane} must name produced/consumed artifact`);
  }

  const promptReviewerLanes = listMarkdown('packages/main/templates/agents')
    .map(relPath => canonicalRoleId(basename(relPath, '.md')))
    .filter((name, index, names) => (name.startsWith('proof-or-stop-review-') || name === 'proof-or-stop-product-reviewer')
      && name !== 'proof-or-stop-review-channel'
      && names.indexOf(name) === index);
  for (const lane of promptReviewerLanes) {
    assert(
      reviewerLaneEntry(registry, lane),
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
    if (expected.gateRequired !== false) {
      assert(entry.consumerGate, `${processFactRegistryPath}: artifact=${expected.name} must name consumer gate`);
    } else {
      assert(!entry.consumerGate, `${processFactRegistryPath}: audit-only artifact=${expected.name} must not name a consumer gate`);
    }
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
 *       after the `.proof-or-stop` migration,
 *   (c) rejects ordinary product source files when unacknowledged,
 *   (d) still passes runtime artifacts via the runtime-artifact registry.
 * The policy doc lives at docs/requirements/decisions/lifecycle-artifact-scope.md.
 */
async function assertLifecycleArtifactScopePolicy() {
  const levelRegistry = new Map(parseProcessFactLevelRegistry().map(entry => [entry.name, entry]));
  const registry = processFactRegistryMap();
  const policyDocPath = 'docs/requirements/decisions/lifecycle-artifact-scope.md';
  const roadmapDocPath = ['docs/requirements/decisions/', 'lat', 'tice-strengthening-roadmap-execution-plan.md'].join('');
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
    'B-e781 closes the B-43de M4-M12 parent roadmap rows with local machine evidence',
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
    'Status: B-e781 closes B-43de M4-M12 parent roadmap rows with local machine evidence and row-level claim boundaries',
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
    'B-e781 closure status: the B-43de M4-M12 parent roadmap rows are closed by',
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
  const scopeDiffPackText = read('packages/main/src/core/scope-diff-pack.ts');
  const lifecycleRegistryText = read('packages/main/src/core/lifecycle-registry.ts');
  const gapLogVerifyText = read('packages/main/src/core/finding-verify.ts');
  const donePrepareMetadataText = read('packages/main/src/core/done-prepare-generated-metadata.ts');
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
  for (const token of [
    'SCOPE_PATH_CANONICALIZER_VERSION',
    'canonicalizeScopePath',
    'ambiguous scope path',
    'malformed glob syntax',
    'symlink',
    'source-root',
    'repo-root',
  ]) {
    assert(scopePathClassifierText.includes(token), `scope path canonicalization contract missing ${token}`);
  }
  for (const token of [
    'SCOPE_ANCHOR_PARSER_VERSION',
    'SCOPE_ANCHOR_ARTIFACT_VERSION',
    'ts.createSourceFile',
    'typescript_parse_error_fail_closed',
    "line === '+++ /dev/null'",
    'file_scope_no_enclosing_declaration',
  ]) {
    assert(scopeDiffPackText.includes(token), `AST semantic anchor contract missing ${token}`);
  }
  for (const token of ['classifySharedLifecycleMetadata', 'verifyGapLogArtifactBinding', 'shared-gap-log-metadata-v1']) {
    assert(lifecycleRegistryText.includes(token), `shared B-META classifier contract missing ${token}`);
  }
  for (const token of ['GAP_LOG_PROVENANCE_SCHEMA', 'GAP_LOG_PROVENANCE_LEDGER_PATH', 'createHmac', 'committedArtifactDigest', 'canonicalEmptyDigest', 'digestGapLogArtifact', 'content_digest_mismatch', 'finding_signature_invalid']) {
    assert(gapLogVerifyText.includes(token), `gap_log provenance contract missing ${token}`);
  }
  assert(donePrepareMetadataText.includes('classifySharedLifecycleMetadata'), 'done_prepare clean-tree must consume shared B-META classifier');
  assert(donePrepareMetadataText.includes('filterDonePrepareTrustedMetadataRows'), 'done_prepare must expose the production shared-metadata row filter for contract testing');
  for (const runtimeName of [
    'runtime:canonical_scope_path_gate',
    'runtime:ast_semantic_anchor_gate',
    'runtime:shared_gap_log_metadata_gate',
  ]) {
    const level = levelRegistry.get(runtimeName);
    const registryEntry = registry.get(runtimeName);
    assert(level?.level === 'L4' && level.gateConsumer, `${runtimeName}: L4 gate-consumed fact missing`);
    assert(registryEntry?.semantics?.includes('gate-evidence'), `${runtimeName}: process registry gate evidence semantic missing`);
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
  const transcriptOnlyFile = '.proof-or-stop/story/actives/B-scope/evidence/transcript-diff.md';
  const liveSmokeTranscriptOnlyFile = '.proof-or-stop/story/actives/B-scope/evidence/live-smoke-transcript.json';

  const lifecycleAccept = [
    '.proof-or-stop/story/actives/B-scope/delivery-check.json',
    '.proof-or-stop/story/actives/B-scope/summary.json',
    '.proof-or-stop/story/actives/B-scope/scope-contract.json',
    '.proof-or-stop/story/actives/B-scope/scope-boundary.json',
    '.proof-or-stop/story/actives/B-scope/execution-boundary.json',
    '.proof-or-stop/story/actives/B-scope/scope-freeze-check.json',
    '.proof-or-stop/story/actives/B-scope/scope-extension-proposals.json',
    '.proof-or-stop/story/actives/B-scope/decision-doc-proposals.json',
    '.proof-or-stop/story/actives/B-scope/scope-discard-digest.json',
    '.proof-or-stop/story/actives/B-scope/process-events.jsonl',
    '.proof-or-stop/story/actives/B-scope/done-required-evidence.json',
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
    probe(['.proof-or-stop/story/actives/B-scope/summary.json']),
    'B-997b lifecycle artifact row',
    row => row.id === 'scope.lifecycle_artifact:B-scope:summary.json'
      && row.source === '.proof-or-stop/story/actives/B-scope/summary.json'
      && row.status === 'pass'
      && row.blocking === false,
  );
  expectRow(
    probe(['.proof-or-stop/story/actives/B-scope/done-required-evidence.json']),
    'B-ac25 done-required lifecycle artifact row',
    row => row.id === 'scope.lifecycle_artifact:B-scope:done-required-evidence.json'
      && row.source === '.proof-or-stop/story/actives/B-scope/done-required-evidence.json'
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
    '.proof-or-stop/activity.jsonl',
    '.proof-or-stop/runtime/cache.json',
    '.proof-or-stop/traces/abc.json',
    '.proof-or-stop/locks/main-write.lock/owner',
    '.proof-or-stop/story/actives/B-other/owner-lease.json',
    'docs/story/activity.jsonl',
  ];
  for (const file of runtimeAccept) {
    const result = probe([file]);
    if (!isClean(result)) {
      fail(`runtime artifact unexpectedly rejected: ${file} → ${JSON.stringify(result.violations)}`);
    }
  }
  expectRow(
    probe(['.proof-or-stop/activity.jsonl']),
    'B-997b runtime artifact row',
    row => typeof row.id === 'string'
      && row.id.startsWith('scope.runtime_artifact:')
      && row.source === '.proof-or-stop/activity.jsonl'
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
  const unknownFilenameUnderStory = '.proof-or-stop/story/actives/B-scope/secrets.json';
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
  const roadmapDocPath = ['docs/requirements/decisions/', 'lat', 'tice-strengthening-roadmap-execution-plan.md'].join('');
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

function assertParentRoadmapIntentTotalityPlan() {
  const planDocPath = 'docs/requirements/decisions/parent-roadmap-intent-totality-gate-execution-plan.md';
  if (!existsSync(join(root, planDocPath))) {
    fail(`parent roadmap intent-totality plan missing: ${planDocPath}`);
    return;
  }

  const planDocText = read(planDocPath);
  const requiredPlanMarkers = [
    'M1. Red/Repro',
    'allRowsClosed=false',
    'partial_parent_done',
    'no full-roadmap claim',
    'ParentRoadmapLedger',
    'ParentRollupResult',
    'child-story-needed',
    'deferred-with-human-approval',
    'B-5082',
  ];
  for (const marker of requiredPlanMarkers) {
    if (!planDocText.includes(marker)) {
      fail(`${planDocPath}: missing parent roadmap intent-totality marker "${marker}"`);
    }
  }
}

function assertParentRoadmapTotalityRuntime() {
  const corePath = 'packages/main/src/core/parent-roadmap-totality.ts';
  const handlerPath = 'packages/main/src/handlers/parent-roadmap.ts';
  const smokePath = 'packages/main/src/tasks/parent-roadmap-totality-smoke.ts';
  const catalogText = read('packages/main/src/cli/command-catalog.ts');
  const registryText = read('packages/main/src/registry.ts');
  const configText = read('packages/main/src/core/config.ts');
  const policyText = read('packages/main/src/core/command-policy.ts');
  const levelText = read('packages/main/src/core/process-fact-levels.ts');
  const registryFactText = read('packages/main/src/core/process-fact-registry.ts');

  for (const relPath of [corePath, handlerPath, smokePath]) {
    if (!existsSync(join(root, relPath))) fail(`parent roadmap runtime file missing: ${relPath}`);
  }

  const coreText = read(corePath);
  const handlerText = read(handlerPath);
  const smokeText = read(smokePath);
  for (const marker of [
    'PARENT_ROADMAP_LEDGER_SCHEMA_VERSION',
    'PARENT_ROLLUP_SCHEMA_VERSION',
    'parent-governed',
    'child-story-needed',
    'child-story-active',
    'closed-by-implementation',
    'closed-by-existing-evidence',
    'deferred-with-human-approval',
    'not-applicable',
    'invalid_parent_rollup',
    'stale_parent_rollup',
    'migration_needed',
    'evaluateParentRoadmapLedger',
    'evaluateParentRoadmapClaim',
    'evaluateParentRoadmapProofStoryBinding',
    'parent_roadmap_summary_overclaim',
    'runtime implementation',
    'B-43de',
  ]) {
    if (!coreText.includes(marker)) fail(`${corePath}: missing parent roadmap runtime marker "${marker}"`);
  }
  assert(
    coreText.includes('ledger.parentLedgerRollup') && coreText.includes('allRowsClosed') && coreText.includes('claimType'),
    `${corePath}: evaluator must visibly ignore caller-provided parentLedgerRollup allRowsClosed/claimType overrides`,
  );
  assert(
    !/AUTHORITY_GATE_DECISION|fullAuthorityDone|productionDone/.test(coreText),
    `${corePath}: parent-roadmap totality must remain local and avoid server-backed completion semantics`,
  );
  for (const commandName of ['parent_roadmap_status', 'parent_roadmap_evaluate']) {
    assert(catalogText.includes(`name: '${commandName}'`), `CLI schema: parent roadmap command missing from MAIN_TOOLS: ${commandName}`);
    assert(configText.includes(commandName), `config phase tools: parent roadmap command missing from global allow list: ${commandName}`);
    assert(policyText.includes(`${commandName}: { status: 'supported'`) && policyText.includes('readOnly'), `command-policy: ${commandName} must be supported/readOnly`);
    assert(levelText.includes(`name: '${commandName}'`) && levelText.includes('parent-roadmap-read'), `process-fact-levels: ${commandName} must be registered as parent-roadmap-read`);
    assert(registryFactText.includes(`${commandName}: ['schema-contract', 'verification-policy']`), `process-fact-registry: ${commandName} must carry schema/verification semantics`);
  }
  assert(registryText.includes('createParentRoadmapHandlers'), 'registry.ts: parent-roadmap handlers must be registered');
  assert(handlerText.includes('buildParentRoadmapSampleCase') && handlerText.includes('summaryText'), `${handlerPath}: handler must expose sample cases and claim wording checks`);
  assert(levelText.includes('runtime:parent_roadmap_totality_claim_consumer'), 'process-fact-levels: parent roadmap runtime claim consumer fact missing');
  assert(registryFactText.includes('runtime:parent_roadmap_totality_claim_consumer'), 'process-fact-registry: parent roadmap runtime claim consumer semantics missing');
  assert(levelText.includes('runtime:agent_dispatch_role_authority_gate'), 'process-fact-levels: typed agent dispatch authority fact missing');
  assert(registryFactText.includes("'runtime:agent_dispatch_role_authority_gate': ['runtime-behavior', 'schema-contract', 'reviewer-lane', 'gate-evidence']"), 'process-fact-registry: typed dispatch authority must remain a gate-consumed reviewer-lane schema contract');
  assert(levelText.includes('runtime:incremental_review_eligibility_gate'), 'process-fact-levels: incremental review eligibility fact missing');
  assert(read('packages/main/src/core/review-run.ts').includes('passesCutoffAt: run.startedAt'), 'review-run verifier must bind prior-pass eligibility to signed run.startedAt');
  assert(read('packages/main/src/core/review-run.ts').includes('asOfRef: run.headHash'), 'review-run verifier must recompute incremental eligibility as-of signed run.headHash');
  assert(read('packages/main/src/core/review-incremental-context.ts').includes('asOfRef'), 'incremental context must accept an as-of git ref so receipt-bound eligibility can pin to ReviewRun.headHash');
  assert(read('packages/main/src/handlers/review-run.ts').includes('passesCutoffAt: startedAt'), 'review_run_start assembly must use the same prior-pass cutoff as verification');
  assert(read('packages/main/src/tasks/review-incremental-context-smoke.ts').includes('passesCutoffAt'), 'incremental review smoke must exercise the prior-pass cutoff contract');
  assert(read('packages/main/src/tasks/review-incremental-context-smoke.ts').includes('asOfRef'), 'incremental review smoke must exercise as-of-run eligibility recomputation');
  const taskContextSource = read('packages/main/src/core/prompt-envelope.ts');
  assert(
    taskContextSource.includes('phase: _phase')
      && taskContextSource.includes("context.phase === 'TEST' ? 'REVIEW' : context.phase")
      && taskContextSource.includes('phase: semanticPhase'),
    'model-relevant TaskContext digest must equate only TEST with REVIEW while preserving every other actual phase',
  );
  const incrementalLevel = parseProcessFactLevelRegistry().find(entry => entry.name === 'runtime:incremental_review_eligibility_gate');
  for (const token of ['only TEST as equivalent', 'mandatory REVIEW-to-TEST transition', 'DEV, DONE, DISCARDED', 'malformed or unknown phases remain distinct', 'checklist', 'scope mutations', 'signed ReviewRun.headHash', 'eligibilityDigest or reviewBasisDigest']) {
    assert(incrementalLevel?.rationale.includes(token), `incremental review eligibility rationale missing lifecycle semantic boundary: ${token}`);
  }
  for (const token of ['reviewer explicitly requests full context', 'discarded incremental candidate', 'later reviewer metadata does not become a dynamic gate fact', 'Material freshness', 'model-relevant TaskContext remain authoritatively recomputed']) {
    assert(incrementalLevel?.rationale.includes(token), `incremental review eligibility rationale missing requested-full metadata boundary: ${token}`);
  }
  assert(incrementalLevel?.gateConsumer.includes('DONE/done_prepare') && incrementalLevel?.gateConsumer.includes('collectReviewerEvidenceState'), 'incremental review eligibility must identify the shared DONE/done_prepare evidence oracle');
  const incrementalSmoke = read('packages/main/src/tasks/review-incremental-context-smoke.ts');
  for (const token of ['REVIEW-TO-TEST TASK SNAPSHOT', 'only REVIEW/TEST are equivalent', 'DEV/DONE/DISCARDED/unknown', 'title/checklist mutations fail closed', 'DONE oracle agrees', 'later different-lane reviewer metadata must not invalidate requested-full quality B', 'shared quorum/current-pass reader accepts quality B', 'requested-full eligibility fields remain immutable envelope-integrity facts', 'AS-OF-RUN ELIGIBILITY']) {
    assert(incrementalSmoke.includes(token), `incremental review smoke missing lifecycle task-context proof token: ${token}`);
  }
  assert(
    registryFactText.includes("'runtime:incremental_review_eligibility_gate': ['runtime-behavior', 'prompt-envelope', 'schema-contract', 'normalization-policy', 'freshness-policy', 'review-run', 'review-pass', 'verification-policy', 'gate-evidence']"),
    'process-fact-registry: incremental review eligibility must remain a versioned gate-consumed prompt/review/normalization/freshness contract',
  );
  const postRemediationLevel = parseProcessFactLevelRegistry().find(entry => entry.name === 'runtime:post_remediation_review_selection_gate');
  assert(postRemediationLevel?.level === 'L4', 'post-remediation review selection must remain L4');
  for (const token of ['domain-separated signed selection', 'current review round', 'canonical bidirectional transitive dependency closure', 'including bare runtime aliases; only proven builtins are exempt', 'fail closed to all active lanes', 'Required host and escalation assurance remain independent and unchanged', 'any one current pass never substitute']) {
    assert(postRemediationLevel?.rationale.includes(token), `post-remediation selection rationale missing trust boundary: ${token}`);
  }
  assert(postRemediationLevel?.gateConsumer.includes('storyMachine.evaluateReviewVerdict REVIEW to TEST selected-lane gate'), 'post-remediation selection must identify its REVIEW-to-TEST consumer');
  assert(
    registryFactText.includes("'runtime:post_remediation_review_selection_gate': ['runtime-behavior', 'signed-artifact', 'schema-contract', 'normalization-policy', 'freshness-policy', 'reviewer-lane', 'gate-evidence']"),
    'process-fact-registry: post-remediation selection must remain a signed lane/freshness gate contract',
  );
  const postRemediationSource = read('packages/main/src/core/review-incremental-context.ts');
  for (const token of ['POST_REMEDIATION_REVIEW_POLICY_VERSION', 'verifyCurrentPostRemediationReviewSelection', 'computeCanonicalDependencyClosure', 'UNTRACKED_OR_IGNORED_MATERIAL', 'UNSUPPORTED_RENAME_OR_DELETE', 'DEPENDENCY_CLOSURE_INCOMPLETE']) {
    assert(postRemediationSource.includes(token), `post-remediation selection source missing fail-closed mechanism: ${token}`);
  }
  assert(read('packages/main/src/core/machine.ts').includes('computeFinalReviewRoster'), 'REVIEW gate must consume the canonical final-review roster');
  assert(read('packages/main/src/handlers/reviewer-list.ts').includes('renderFinalReviewRoster'), 'operator status must project the canonical final-review roster');
  assert(levelText.includes('runtime:prompt_role_body_rollout_gate'), 'process-fact-levels: prompt role-body rollout gate fact missing');
  assert(
    registryFactText.includes("'runtime:prompt_role_body_rollout_gate': ['runtime-behavior', 'prompt-envelope', 'schema-contract', 'reviewer-lane', 'gate-evidence']"),
    'process-fact-registry: prompt role-body rollout must remain a gate-consumed role/envelope contract',
  );
  const roleBodyRolloutLevel = parseProcessFactLevelRegistry().find(entry => entry.name === 'runtime:prompt_role_body_rollout_gate');
  assert(roleBodyRolloutLevel?.level === 'L4', 'prompt role-body rollout must remain L4');
  for (const token of ['five active REVIEW lanes', 'content-addressed', 'byte-exact legacy role body', 'Every supported host mode binds both', 'total model input explicit', 'Compatibility and retired']) {
    assert(roleBodyRolloutLevel?.rationale.includes(token), `prompt role-body rollout rationale must preserve ${token}`);
  }
  const migratedReviewerContractSources = [
    'packages/main/src/init-assets.ts',
    'packages/main/src/registry.ts',
    'packages/main/src/handlers/agent-prompt.ts',
    'packages/main/src/core/process-fact-levels.ts',
    'packages/main/src/tasks/global-agents-init-smoke.ts',
    'docs/requirements/decisions/lifecycle-artifact-scope.md',
  ];
  for (const sourcePath of migratedReviewerContractSources) {
    const source = read(sourcePath);
    assert(/six migrated[\s*]+reviewer/i.test(source), `${sourcePath}: migrated reviewer contract must name all six definitions`);
    assert(!/five migrated[\s*]+reviewer/i.test(source), `${sourcePath}: stale five-migrated-reviewer residue is forbidden`);
  }
  const reviewAtomicLevel = parseProcessFactLevelRegistry().find(entry => entry.name === 'runtime:review_run_atomic_persistence_gate');
  assert(reviewAtomicLevel?.level === 'L4', 'review-run atomic persistence must remain L4');
  for (const token of ['Every Prompt Envelope producer', 'Story-aware agent_prompt', 'bakery-style unique-ticket', 'never-reused UUID ticket path', 'stale reclaim removes only the exact dead acquisition path', 'fixed-path ABA', 'nests no fixed-path Prompt Envelope lock']) {
    assert(reviewAtomicLevel?.rationale.includes(token), `review-run atomic persistence rationale must preserve ${token}`);
  }
  const mkdirLockText = read('packages/main/src/core/mkdir-lock.ts');
  const reviewRunHandlerText = read('packages/main/src/handlers/review-run.ts');
  const agentPromptHandlerText = read('packages/main/src/handlers/agent-prompt.ts');
  const incrementalSmokeText = read('packages/main/src/tasks/review-incremental-context-smoke.ts');
  for (const token of ['acquireMkdirTicketLock', '.choosing', '.ticket', 'randomUUID()', 'rmSync(candidate.path']) {
    assert(mkdirLockText.includes(token), `mkdir ticket lock must preserve identity-conditional reclaim marker ${token}`);
  }
  assert(reviewRunHandlerText.includes('withReviewMetadataTicketLock'), 'review_run_start must use the shared review metadata transaction lock');
  assert(agentPromptHandlerText.includes('withReviewMetadataTicketLock'), 'Story-aware agent_prompt must use the shared review metadata transaction lock');
  assert(!reviewRunHandlerText.includes("'prompt-envelopes.lock'"), 'review_run_start must not nest the legacy fixed-path Prompt Envelope lock');
  assert(!agentPromptHandlerText.includes("'prompt-envelopes.lock'"), 'Story-aware agent_prompt must not use the legacy fixed-path Prompt Envelope lock');
  for (const token of ['MIXED WRITER LOCK ABA:', "'review_run_start'", "'agent_prompt'", 'observed-w2', 'observed-w1', 'allow-remove-w2', 'acquired-w2', 'allow-remove-w1', 'actual mixed producers preserve both Prompt Envelope records', 'verifyReviewRunPromptEnvelope']) {
    assert(incrementalSmokeText.includes(token), `review incremental smoke must preserve deterministic ABA barrier ${token}`);
  }
  const dispatchAuthorityLevel = parseProcessFactLevelRegistry().find(entry => entry.name === 'runtime:agent_dispatch_role_authority_gate');
  assert(dispatchAuthorityLevel?.level === 'L4', 'typed agent dispatch authority must remain L4');
  assert(/dispatch prompt admission and role-gated checklist\/reviewer evidence mutation consumers/.test(dispatchAuthorityLevel?.gateConsumer || ''), 'typed agent dispatch authority must name prompt and mutation consumers');
  for (const marker of [
    '--expected-red=parent-overclaim',
    '--expected-red=test-first',
    '--case=state-model',
    '--case=evaluator',
    '--case=claim-consumer',
    '--case=proofstory-binding',
    '--case=cli',
    '--case=migration',
  ]) {
    if (!smokeText.includes(marker)) fail(`${smokePath}: missing smoke mode marker "${marker}"`);
  }
}

// DYN-1..DYN-5 runtime facts are gate-consumed process facts, not descriptive
// documentation.  Keep a source-level contract here so deleting the level or
// weakening its registry semantics cannot make dynamic validation appear
// authoritative while the production registry silently loses its evidence.
function assertStoryAwareDynamicValidationRuntime() {
  assert(read('packages/main/src/core/validation-authority-graph.ts').includes('PROCESS_FACT_REGISTRY'), 'authority source closure must use registered process facts');
  assert(read('packages/main/src/core/story-aware-validation.ts').includes('authorityReasons(change)'), 'dynamic plan must consume authority closure reasons');
  assert(read('packages/main/src/core/process-fact-registry.ts').includes('runtime:full_task_scope_authority'), 'scope inventory gate must be explicitly registered');
  assert(read('scripts/verify-validation-authority-graph.mjs').includes('base dependency must survive head edge removal'), 'authority graph requires dual-revision regression');
  const routineReuseSource = read('packages/main/src/handlers/verifier.ts');
  for (const token of ['tryReuseRoutinePass', 'reuseFreshRoutinePass', 'readRoutineReuseRevocationBasis', 'preparationHead', 'reusedFromIdentityDigest', "oracleStatus: 'not-run'", "authority: 'observe-only'", 'observe-opt-in']) {
    assert(routineReuseSource.includes(token), `observe whole-PASS reuse must retain ${token}`);
  }
  assert(read('packages/main/src/cli/command-catalog.ts').includes('reuseFreshRoutinePass: z.boolean().optional()'), 'validate must expose the independent whole-PASS reuse option');
  assert(read('packages/main/src/core/types.ts').includes('dynamicRevocationLedgerDigest?: string'), 'canonical evidence must bind the signed revocation state');
  assert(read('packages/main/src/core/process-fact-registry.ts').includes("'runtime:routine_validation_fresh_pass_reuse_gate': ['runtime-behavior', 'schema-contract', 'freshness-policy', 'execution-evidence'"), 'routine reuse must retain execution evidence semantics');

  const levelText = read('packages/main/src/core/process-fact-levels.ts');
  const registryText = read('packages/main/src/core/process-fact-registry.ts');
  const facts = [
    'runtime:story_aware_dynamic_selection_manifest',
    'runtime:story_aware_dynamic_closure_receipt',
    'runtime:story_aware_dynamic_shard_aggregate',
    'runtime:story_aware_dynamic_authority_gate',
  ];
  const levels = parseProcessFactLevelRegistry();
  for (const fact of facts) {
    assert(levelText.includes(`name: '${fact}'`), `process-fact-levels: dynamic fact missing: ${fact}`);
    assert(registryText.includes(`'${fact}':`), `process-fact-registry: dynamic fact missing: ${fact}`);
    const level = levels.find((entry) => entry.name === fact);
    assert(level?.level === 'L4', `process-fact-levels: dynamic fact must remain L4: ${fact}`);
    if (fact === 'runtime:story_aware_dynamic_authority_gate') assert(level?.rationale.includes('explicit full and TEST/DONE invocations execute the complete canonical plan'), 'dynamic authority must retain final full execution');
    assert(level?.gateConsumer && /dynamic|validate|TEST|authority/i.test(level.gateConsumer), `process-fact-levels: dynamic fact must name a gate consumer: ${fact}`);
  }
  for (const token of ['signed-artifact', 'schema-contract', 'gate-evidence']) {
    assert(registryText.includes(`'runtime:story_aware_dynamic_selection_manifest':`) && registryText.includes(`'runtime:story_aware_dynamic_authority_gate':`), 'process-fact-registry: dynamic fact semantic map must remain present');
    assert(registryText.includes(token), `process-fact-registry: dynamic semantic map missing ${token}`);
  }
  for (const fact of [
    'runtime:story_aware_dynamic_selection_manifest',
    'runtime:story_aware_dynamic_closure_receipt',
    'runtime:story_aware_dynamic_shard_aggregate',
  ]) {
    const line = registryText.split('\n').find((candidate) => candidate.includes(`'${fact}':`)) || '';
    assert(line.includes("'workspace-binding'"), `process-fact-registry: ${fact} must retain Git-rooted provenance binding`);
  }
  const closureSemantics = registryText.split('\n').find(line => line.includes("'runtime:story_aware_dynamic_closure_receipt':")) || '';
  assert(closureSemantics.includes("'normalization-policy'"), 'dynamic closure must register physical read normalization');
  const executorText = read('packages/main/src/core/validation-executor.ts');
  const handlerText = read('packages/main/src/handlers/story-aware-validation.ts');
  assert(executorText.includes('fragment.schemaVersion !== VALIDATION_RUNTIME_TRACE_POLICY.schemaVersion'), 'executor must refuse unsupported trace fragments');
  assert(executorText.includes('merged.unknownRuntimeInputs.add(value)') && !executorText.includes('...observed, unknownRuntimeInputs: []'), 'executor must preserve unknown input evidence');
  assert(handlerText.includes('boundary.readPathSchema !== VALIDATION_RUNTIME_TRACE_POLICY.schemaVersion') && handlerText.includes('sourceAuthorityPath(rel)'), 'closure must require physical trace schema and map contained relative paths');
  const signingText = read('packages/main/src/core/validation-artifact-signing.ts');
  const validationText = read('packages/main/src/core/story-aware-validation.ts');
  assert(validationText.includes("VALIDATION_RECEIPT_SCHEMA = 'proof-or-stop.validation-command-receipt.v2'"), 'dynamic reuse must reject legacy receipts without executor source observations');
  assert(validationText.includes('certifiedTreesEqual(ctx.gitCwd, sourceHead, actualHead, entry, closure)') && validationText.includes('environmentDigest: declaredEnvironmentDigest(entry, ctx)'), 'cross-commit reuse must bind receipt-relative trees and effective declared environment');
  assert(handlerText.includes('!provenance.cleanBefore || !provenance.cleanAfter') && handlerText.includes('provenance.headBefore !== args.head || provenance.headAfter !== args.head'), 'receipt issuance requires executor-observed unchanged clean source at both boundaries');
  const registeredAdapterDigest = handlerText.match(/const DYN5_ADAPTER_SOURCE_DIGEST = '([a-f0-9]{64})'/)?.[1];
  assert(handlerText.includes('sourceDigest: DYN5_ADAPTER_SOURCE_DIGEST'), 'registered adapter must consume the checked digest constant');
  const registeredChildDigest = handlerText.match(/const DYN5_CHILD_ENVIRONMENT_SOURCE_DIGEST = '([a-f0-9]{64})'/)?.[1];
  assert(handlerText.includes('sourceDigest: DYN5_CHILD_ENVIRONMENT_SOURCE_DIGEST') && registeredChildDigest === createHash('sha256').update(JSON.stringify(read('packages/main/src/tasks/validation-child-environment.mjs'))).digest('hex'), 'adapter child environment dependency must retain audited source identity');
  assert(registeredAdapterDigest === createHash('sha256').update(JSON.stringify(read('packages/main/src/tasks/story-aware-validation-case-adapter.mjs'))).digest('hex'), 'registered shard adapter digest must match audited source bytes');

  assert(signingText.includes("VALIDATION_ARTIFACT_SIGNING_KEY_ID = 'validation-artifact-v1'"), 'dynamic validation provenance must retain an explicit signing key ID');
  assert(signingText.includes('ed25519:${VALIDATION_ARTIFACT_SIGNING_KEY_ID}:'), 'dynamic validation provenance must retain its Ed25519 signature prefix');
  assert(signingText.includes('git-common-dir') && signingText.includes("flag: 'wx'"), 'dynamic validation provenance key must remain Git-common-metadata-rooted and creation-race-safe');
  assert(validationText.includes('signValidationArtifact(value)') && validationText.includes('verifyValidationArtifact(value, signature)'), 'dynamic validation artifacts must delegate signing and verification to the trusted signer');
  assert(read('packages/main/src/handlers/story-aware-validation.ts').includes('originalOracle'), 'DYN-5 aggregate must retain complete-plan oracle equivalence evidence');
}

function assertPromptMeasurementObservationBoundary() {
  const command = 'prompt_measurement_report';
  const catalogText = read('packages/main/src/cli/command-catalog.ts');
  const policyText = read('packages/main/src/core/command-policy.ts');
  const configText = read('packages/main/src/core/config.ts');
  const activityText = read('packages/main/src/cli/activity-policy.ts');
  const levelsText = read('packages/main/src/core/process-fact-levels.ts');
  const registryText = read('packages/main/src/registry.ts');
  const handlerText = read('packages/main/src/handlers/prompt-measurement.ts');
  const verifierText = read('scripts/verify-proof-or-stop-prompt-baseline.mjs');
  const promptRegistryText = read('packages/main/src/core/prompt-registry.ts');
  const promptRoleRegistryText = read('packages/main/src/core/prompt-role-contract-registry.ts');

  assert(catalogText.includes(`name: '${command}'`), `prompt measurement: ${command} missing from command catalog`);
  assert(
    policyText.includes(`${command}: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all'`),
    `prompt measurement: ${command} must remain readOnly and all-phase in command policy`,
  );
  assert(configText.includes(`'${command}'`), `prompt measurement: ${command} missing from all-phase tools`);
  assert(activityText.includes(`'${command}'`), `prompt measurement: ${command} missing from read-only activity policy`);
  assert(
    levelsText.includes(`name: '${command}', level: 'L0', category: 'prompt-measurement-read'`),
    `prompt measurement: ${command} must remain exactly L0 observational`,
  );
  assert(registryText.includes('createPromptMeasurementHandlers'), 'prompt measurement: handler factory not wired');
  assert(!/\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync)\b/.test(handlerText), 'prompt measurement: handler must not gain filesystem writes');
  assert(handlerText.includes('generatePromptMeasurementReport'), 'prompt measurement: handler must use deterministic local generator');
  assert(verifierText.includes('verifyPromptMeasurementSidecar'), 'prompt measurement: proof-or-stop verifier sidecar check missing');
  assert(verifierText.includes('PromptMeasurementRecord sidecar verified without refresh authority'), 'prompt measurement: verifier must state non-authoritative no-refresh boundary');
  assert(
    promptRegistryText.includes('assertPromptRegistrySnapshotIdentity'),
    'prompt registry: exact schemaVersion/source identity validator missing',
  );
  assert(
    /buildPromptRoleContracts\([\s\S]*?assertPromptRegistrySnapshotIdentity\(snapshot\)/.test(promptRoleRegistryText),
    'prompt registry: role-contract consumer must validate the snapshot identity before deriving contracts',
  );
}

function assertStoryWriterRuntimeAdmissionContract() {
  const admission = read(storyRuntimeAdmissionPath);
  const engine = read('packages/main/src/cli-engine.ts');
  const policy = read(commandPolicyPath);
  const processFacts = read('packages/main/src/core/process-fact-registry.ts');
  const scopeEvaluator = read('packages/main/src/core/scope-anti-expansion.ts');
  const policyEntries = parseCommandPolicyEntries();
  const crossOwnershipEffects = new Map([
    ['story_create', 'always'],
    ['story_reconcile', 'always'],
    ['identity_state_migrate', 'whenConfirm'],
    ['story_discard', 'always'],
    ['story_draft_discard', 'always'],
    ['story_create_from_repro', 'always'],
    ['signature_backfill', 'whenApply'],
    ['done_recover', 'always'],
    ['audit', 'always'],
    ['gap_log', 'always'],
    ['doctor', 'whenRepair'],
    ['certification_window_status', 'whenRefresh'],
    ['reviewer_list', 'whenForceReviewer'],
    ['agent_prompt', 'whenStoryPromptEnvelope'],
    ['evaluate', 'whenEvaluatorPromptEnvelope'],
    ['planner_create_story', 'always'],
    ['planner_run', 'always'],
  ]);
  const storyWriteEffect = entry => readStringProperty(entry.block, 'storyWriteEffect');
  const capabilityCommands = new Set(policyEntries
    .filter(entry =>
      policyBlockHasOwnershipClass(entry, 'storyScopedMutating')
      || policyBlockHasOwnershipClass(entry, 'reviewerWrite')
      || Boolean(storyWriteEffect(entry)))
    .map(entry => entry.name));
  const omittedCapability = process.env.PROOF_OR_STOP_PROCESS_FACT_CONTRACT_OMIT_STORY_WRITER;
  if (omittedCapability === '*') capabilityCommands.clear();
  else if (omittedCapability) capabilityCommands.delete(omittedCapability);
  assert(policy.includes('STORY_WRITE_CAPABILITY_COMMANDS'), `${commandPolicyPath}: missing actual Story-write capability registry`);
  assert(policy.includes('commandRequiresAuthoritativeRuntime'), `${commandPolicyPath}: missing actual Story-write capability predicate`);
  const runtimePredicate = policy.match(/export function commandRequiresAuthoritativeRuntime\([\s\S]*?\n\}/)?.[0].replace(/\s/g, '') ?? '';
  assert(
    runtimePredicate.includes("returneffectiveOwnership!==null&&effectiveOwnership!=='readOnly'&&(effectiveOwnership==='storyScopedMutating'||effectiveOwnership==='reviewerWrite'||STORY_WRITE_CAPABILITY_COMMAND_SET.has(command));"),
    `${commandPolicyPath}: raw and final admission must include intrinsic effective extension writers while preserving null/read-only refusal and declared cross-class effects`,
  );
  assert(policy.includes("policy.ownershipClass === 'storyScopedMutating'"), `${commandPolicyPath}: Story-write capability registry must derive owner writers from command policy`);
  assert(policy.includes("policy.ownershipClass === 'reviewerWrite'"), `${commandPolicyPath}: Story-write capability registry must derive reviewer writers from command policy`);
  assert(policy.includes("'storyWriteEffect' in policy && policy.storyWriteEffect !== undefined"), `${commandPolicyPath}: Story-write capability registry must derive cross-class writers from declared effects`);
  for (const [command, expectedEffect] of crossOwnershipEffects) {
    const entry = policyEntries.find(candidate => candidate.name === command);
    assert(entry, `${commandPolicyPath}: missing cross-class Story writer ${command}`);
    assert(storyWriteEffect(entry) === expectedEffect, `${commandPolicyPath}: ${command} storyWriteEffect must be ${expectedEffect}`);
    assert(capabilityCommands.has(command), `${commandPolicyPath}: Story-write capability registry missing ${command}`);
  }
  for (const entry of policyEntries) {
    if (policyBlockHasOwnershipClass(entry, 'storyScopedMutating') || policyBlockHasOwnershipClass(entry, 'reviewerWrite')) {
      assert(capabilityCommands.has(entry.name), `${commandPolicyPath}: Story-write capability registry missing ${entry.name}`);
      continue;
    }
    const effect = storyWriteEffect(entry);
    if (effect) {
      assert(crossOwnershipEffects.get(entry.name) === effect, `${commandPolicyPath}: unverified cross-class Story writer effect ${entry.name}:${effect}`);
    }
  }
  const policyNames = new Set(policyEntries.map(entry => entry.name));
  const sourceRoot = join(root, 'packages/main/src');
  const sourcePaths = [];
  const collectSourcePaths = (absoluteDir, relativeDir) => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = join(absoluteDir, entry.name);
      const relPath = join(relativeDir, entry.name);
      if (entry.isDirectory()) collectSourcePaths(absolutePath, relPath);
      else if (entry.isFile() && entry.name.endsWith('.ts')) sourcePaths.push(relPath);
    }
  };
  collectSourcePaths(sourceRoot, 'packages/main/src');

  const definitions = [];
  const definitionsByFileAndName = new Map();
  const importsByFile = new Map();
  const namespaceImportsByFile = new Map();
  const callableDescriptor = (node, sourceFile, relPath) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      return { name: node.name.text, body: node.body };
    }
    if (ts.isMethodDeclaration(node) && node.name && node.body) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
      return name ? { name, body: node.body } : null;
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      && node.initializer.body
    ) {
      return { name: node.name.text, body: node.initializer.body };
    }
    return null;
  };
  const resolveImportedModule = (fromRelPath, specifier) => {
    if (!specifier.startsWith('.')) return null;
    const joined = join(dirname(fromRelPath), specifier);
    const candidates = joined.endsWith('.js')
      ? [`${joined.slice(0, -3)}.ts`]
      : [joined, `${joined}.ts`, join(joined, 'index.ts')];
    return candidates.find(candidate => existsSync(join(root, candidate))) ?? null;
  };
  for (const relPath of sourcePaths) {
    const sourceFile = parseSourceFile(relPath);
    const namedImports = new Map();
    const namespaceImports = new Map();
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const importedPath = resolveImportedModule(relPath, statement.moduleSpecifier.text);
      if (!importedPath || !statement.importClause) continue;
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          namedImports.set(element.name.text, { relPath: importedPath, name: element.propertyName?.text ?? element.name.text });
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        namespaceImports.set(bindings.name.text, importedPath);
      }
    }
    importsByFile.set(relPath, namedImports);
    namespaceImportsByFile.set(relPath, namespaceImports);
    const visit = node => {
      const descriptor = callableDescriptor(node, sourceFile, relPath);
      if (descriptor) {
        const definition = {
          key: `${relPath}:${descriptor.name}:${node.pos}`,
          name: descriptor.name,
          relPath,
          node,
          body: descriptor.body,
          directWrites: [],
          calls: [],
        };
        definitions.push(definition);
        const fileKey = `${relPath}:${descriptor.name}`;
        const matches = definitionsByFileAndName.get(fileKey) ?? [];
        matches.push(definition);
        definitionsByFileAndName.set(fileKey, matches);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const isNestedNamedCallable = node => Boolean(callableDescriptor(node));
  for (const definition of definitions) {
    const sourceFile = parseSourceFile(definition.relPath);
    const visitBody = node => {
      if (node !== definition.body && isNestedNamedCallable(node)) return;
      if (ts.isCallExpression(node)) {
        if (ts.isPropertyAccessExpression(node.expression)) {
          const receiver = node.expression.expression.getText(sourceFile);
          const method = node.expression.name.text;
          if (/(?:^|\.)store$/.test(receiver) && /^(?:write|append)/.test(method)) {
            definition.directWrites.push(`${receiver}.${method}`);
          }
          if (ts.isIdentifier(node.expression.expression)) {
            definition.calls.push({ kind: 'property', receiver: node.expression.expression.text, name: method });
          }
        } else if (ts.isIdentifier(node.expression)) {
          definition.calls.push({ kind: 'identifier', name: node.expression.text });
        }
      }
      ts.forEachChild(node, visitBody);
    };
    ts.forEachChild(definition.body, visitBody);
  }

  const edges = new Map(definitions.map(definition => [definition.key, []]));
  for (const definition of definitions) {
    const targets = edges.get(definition.key);
    for (const call of definition.calls) {
      if (call.kind === 'identifier') {
        const local = definitionsByFileAndName.get(`${definition.relPath}:${call.name}`);
        if (local?.length) {
          targets.push(...local);
          continue;
        }
        const imported = importsByFile.get(definition.relPath)?.get(call.name);
        if (imported) targets.push(...(definitionsByFileAndName.get(`${imported.relPath}:${imported.name}`) ?? []));
        continue;
      }
      const importedPath = namespaceImportsByFile.get(definition.relPath)?.get(call.receiver);
      if (importedPath) targets.push(...(definitionsByFileAndName.get(`${importedPath}:${call.name}`) ?? []));
    }
  }

  const storyWriteTraces = new Map();
  const traceWrites = (definition, path, seen) => {
    if (seen.has(definition.key)) return [];
    const nextSeen = new Set(seen).add(definition.key);
    const nextPath = [...path, definition];
    const traces = definition.directWrites.length > 0
      ? [{ path: nextPath, writes: definition.directWrites }]
      : [];
    for (const target of edges.get(definition.key) ?? []) {
      traces.push(...traceWrites(target, nextPath, nextSeen));
    }
    return traces;
  };
  for (const definition of definitions) {
    if (!ts.isMethodDeclaration(definition.node) || !policyNames.has(definition.name)) continue;
    const traces = traceWrites(definition, [], new Set());
    if (traces.length > 0) {
      const existing = storyWriteTraces.get(definition.name) ?? [];
      existing.push(...traces);
      storyWriteTraces.set(definition.name, existing);
    }
  }
  for (const [command, traces] of storyWriteTraces) {
    if (capabilityCommands.has(command)) continue;
    const trace = traces[0];
    const kind = trace.path.length === 1 ? 'direct' : 'transitive';
    const chain = trace.path.map(definition => definition.name).join(' -> ');
    const sink = trace.path.at(-1);
    assert(
      false,
      `${kind} Story-writing handler ${command} is absent from the capability inventory (${chain} -> ${trace.writes.join(', ')} at ${sink.relPath})`,
    );
  }
  const ownership = read('packages/main/src/cli/ownership-gate.ts');
  for (const [command, argument] of [
    ['signature_backfill', 'args.apply'],
    ['identity_state_migrate', 'args.confirm'],
    ['reviewer_list', 'args.forceReviewer'],
    ['doctor', 'args.repair'],
    ['certification_window_status', 'args.refresh'],
    ['agent_prompt', 'args.auditExperiment'],
    ['evaluate', 'hasEvaluatorTarget'],
  ]) {
    assert(ownership.includes(`cmd === '${command}'`), `ownership gate missing conditional Story writer ${command}`);
    assert(ownership.includes(argument), `ownership gate missing ${command} write argument ${argument}`);
  }
  assert(
    admission.includes('commandRequiresAuthoritativeRuntime(input.command, input.effectiveOwnership)'),
    `${storyRuntimeAdmissionPath}: admission must consume the actual Story-write capability predicate`,
  );
  assert(!admission.includes("input.effectiveOwnership === 'storyScopedMutating'"), `${storyRuntimeAdmissionPath}: admission must not enumerate ownership classes`);
  assert(admission.includes('classifyRuntimeEntrypointAuthority'), `${storyRuntimeAdmissionPath}: must consume the shared runtime authority classifier`);
  const rawResolution = engine.indexOf('resolveRawRuntimeAdmissionOwnership(');
  const rawClassifier = engine.indexOf('classifyRuntimeEntrypointAuthority({', rawResolution);
  assert(
    rawResolution >= 0 && rawClassifier > rawResolution,
    'cli-engine: raw runtime preflight must resolve argument-aware effective ownership before classifying runtime authority',
  );
  assert(
    engine.indexOf('commandRequiresAuthoritativeRuntime(', rawResolution) >= rawResolution,
    'cli-engine: raw and parsed runtime admission must consume the actual Story-write capability predicate',
  );
  for (const schema of [
    'proof-or-stop.execution_boundary.v1.1',
    'lattice.execution_boundary.v1',
    'proof-or-stop.scope_freeze_check.v1.1',
    'lattice.scope_freeze_check.v1',
  ]) {
    assert(scopeEvaluator.includes(schema), `scope anti-expansion: missing exact schema contract ${schema}`);
    assert(processFacts.includes(schema), `process fact registry: missing exact schema contract ${schema}`);
  }
  const gate = engine.indexOf('enforceStoryRuntimeAdmission({');
  const hook = engine.indexOf("runHooks('preCommand'", gate);
  assert(gate >= 0 && hook > gate, 'cli-engine: Story runtime admission must precede preCommand hooks');
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
  assertCertificationWindowCommandContract(cliToolNameSet, registry, levelRegistry, policyByName);
  assertCrossHostReviewManagedDelegationContract(levelRegistry, policyByName);
  assertReviewLoopCommandContract(cliToolNameSet, registry, levelRegistry, policyByName);
  assertDoneClosureCommandContract(cliToolNameSet, registry, levelRegistry, policyByName);
  assertDoneRequiredValidationCommandContract(cliToolNameSet, registry, levelRegistry, policyByName);
  assertAcceptanceTopologyLifecycleFilenameContract();
  assertDecisionDocQuorumCommandContract(cliToolNameSet, registry, levelRegistry, policyByName);
  assertDecisionDocPromotionCommandContract(cliToolNameSet, registry, levelRegistry, policyByName);
  assertStory3ProcessFactContract(cliToolNameSet, registry, levelRegistry, policyByName);

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
    for (const token of expected.rationaleTokens || []) {
      assert(
        actual.rationale.includes(token),
        `${processFactLevelRegistryPath}: ${expected.name} rationale missing causal assurance token: ${token}`,
      );
    }
  }
  assertReviewExecutionAuthorityContract(registry, levelRegistry);
  assertReviewRunStoryFilesHashContract(registry, levelRegistry);
  assertReviewAssuranceFloorContract(registry, levelRegistry);
  assertDeliveryCheckStoryFilesHashContract(registry, levelRegistry);
  assertDeliveryPromiseOutcomeContract(registry, levelRegistry);

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

function assertStory3ProcessFactContract(cliToolNameSet, registry, levelRegistry, policyByName) {
  const expected = [
    {
      name: 'finding_ledger_query', level: 'L0', category: 'finding-ledger-read',
      owner: /handlers\/finding-ledger\.queryFindingLedger/,
      semantics: ['schema-contract', 'signed-artifact', 'atomic-persistence'],
      phases: 'all', ownershipClass: 'readOnly',
    },
    {
      name: 'finding_runtime_evidence_run', level: 'L2', category: 'finding-ledger-persistence',
      owner: /core\/finding-ledger \+ handlers\/finding-ledger\.appendRuntimeReceipt/,
      semantics: ['atomic-persistence', 'signed-artifact', 'schema-contract'],
      phases: ['DEV'], ownershipClass: 'storyScopedMutating',
    },
    {
      name: 'finding_runtime_evidence_verify', level: 'L3', category: 'runtime-evidence-verification',
      owner: /core\/runtime-evidence-receipt \+ handlers\/finding-ledger\.verify/,
      semantics: ['execution-evidence', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding'],
      phases: ['DEV'], ownershipClass: 'readOnly',
    },
  ];
  for (const contract of expected) {
    assert(cliToolNameSet.has(contract.name), `Story 3: MAIN_TOOLS missing ${contract.name}`);
    const level = levelRegistry.get(contract.name);
    assert(level?.level === contract.level, `Story 3: ${contract.name} must stay ${contract.level}, never L4 persistence authority`);
    assert(level?.category === contract.category, `Story 3: ${contract.name} category drifted`);
    assert(contract.owner.test(level?.owner || ''), `Story 3: ${contract.name} producer role drifted (${level?.owner || '<missing>'})`);
    assert(!level?.gateConsumer, `Story 3: ${contract.name} must not name a lifecycle gate consumer`);
    const entry = registry.get(contract.name);
    assert(entry, `Story 3: registry missing ${contract.name}`);
    if (entry) {
      assert(entry.level === contract.level, `Story 3: ${contract.name} registry level drifted`);
      assert(contract.semantics.every(semantic => entry.semantics.includes(semantic)), `Story 3: ${contract.name} semantics incomplete`);
      assert(!entry.semantics.includes('gate-evidence'), `Story 3: ${contract.name} must remain non-L4/non-gate evidence`);
      assert(!entry.consumerGate, `Story 3: ${contract.name} acquired an unregistered direct consumer`);
    }
    const policy = policyByName.get(contract.name);
    assert(policy, `Story 3: command policy missing ${contract.name}`);
    if (policy) {
      assert(policyBlockHasOwnershipClass(policy, contract.ownershipClass), `Story 3: ${contract.name} ownershipClass drifted`);
      const expectedPhases = contract.phases === 'all' ? ALL_PHASES : contract.phases;
      assert(sameStringArray(policy.allowedPhases, expectedPhases), `Story 3: ${contract.name} phase policy drifted`);
      assert(!policy.gateEvidence, `Story 3: ${contract.name} policy must not grant gateEvidence`);
    }
  }

  const handlerText = read('packages/main/src/handlers/finding-ledger.ts');
  assert(handlerText.includes('queryFindingLedger') && handlerText.includes('verifyFindingLedgerQueryRow'), 'Story 3: protected read-only query/verifier contract missing');
  assert(handlerText.includes("gateEvidence: false") && handlerText.includes("lifecycleAuthority: 'none'"), 'Story 3: query rows must carry explicit non-authority markers');
  assert(!/from\s+['"]\.\.\/core\/(?:finding-identity|finding-applicability-gate|dynamic-finding-gate|finding-rollout-scorecard)\.js['"]/.test(handlerText), 'Story 3: forbidden Story 2/Story 1 import accepted');
  const protectedQuerySurface = handlerText.slice(
    handlerText.indexOf('export function queryFindingLedger('),
    handlerText.indexOf('export const RUNTIME_EVIDENCE_PRIVATE_KEY_ENV'),
  );
  assert(!/\b(?:ledgerPath|protectedPath|lockPath|tempPath|artifactStoreRoot|storagePath|realPath)\b/.test(protectedQuerySurface), 'Story 3: protected query surface contains a path-bearing field');
  for (const consumerPath of [
    'packages/main/src/core/machine.ts',
    'packages/main/src/core/advisory.ts',
    'packages/main/src/core/lifecycle-registry.ts',
    'packages/main/src/handlers/phase-gates.ts',
    'packages/main/src/handlers/transition-orchestrator.ts',
  ]) {
    const consumerText = read(consumerPath);
    assert(!/\b(?:finding_ledger_query|queryFindingLedger)\b/.test(consumerText), `Story 3: unregistered direct lifecycle consumer in ${consumerPath}`);
  }

  const registrySource = read(processFactRegistryPath);
  const persistencePolicies = extractConstInitializer(
    registrySource,
    'PROCESS_FACT_STORY3_PERSISTENCE_ONLY_RECORD_POLICIES',
    processFactRegistryPath,
  );
  for (const recordClass of ['persistence', 'candidate', 'route', 'baseline', 'history', 'standalone-receipt', 'ledger-receipt']) {
    const escaped = recordClass.replace('-', '\\-');
    assert(
      new RegExp(`recordClass: '${escaped}',[^\\n]+level: 'L2'[^\\n]+allowedConsumers: \\['finding_ledger_query'\\][^\\n]+gateEvidence: false[^\\n]+lifecycleAuthority: 'none'`).test(persistencePolicies),
      `Story 3: ${recordClass} persistence row must remain L2/query-only/non-authoritative`,
    );
  }
  assert(!/level: 'L4'|gateEvidence: true|lifecycleAuthority: '(?:blocker|pass|unblock|gate)'/.test(persistencePolicies), 'Story 3: persistence-only row policy was promoted to lifecycle authority');
  const runtimeReceiptPolicy = extractConstInitializer(
    registrySource,
    'PROCESS_FACT_STORY3_RUNTIME_RECEIPT_POLICY',
    processFactRegistryPath,
  );
  assert(/recordType: 'runtime_evidence_receipt'/.test(runtimeReceiptPolicy), 'Story 3: runtime receipt policy missing');
  assert(/level: 'L3'/.test(runtimeReceiptPolicy), 'Story 3: runtime receipt must stay L3 gate-eligible input, distinct from L2 persistence');
  assert(/producer: 'core\/runtime-evidence-receipt \+ handlers\/finding-ledger\.verify'/.test(runtimeReceiptPolicy), 'Story 3: runtime receipt verifier producer drifted');
  assert(/gateEvidence: false/.test(runtimeReceiptPolicy) && /lifecycleAuthority: 'gate-eligible-input-only'/.test(runtimeReceiptPolicy), 'Story 3: runtime receipt policy must not claim direct lifecycle authority');
  const dependencyTransition = read('packages/main/src/handlers/transition-orchestrator.ts');
  assert(dependencyTransition.includes('assertPlanDevDependenciesDone(store, story, args.phase);'), 'Story 3: PLAN to DEV dependency gate is not wired before transition mutation');
  const dependencyGateIndex = dependencyTransition.indexOf('assertPlanDevDependenciesDone(store, story, args.phase);');
  const firstActorSendAfterGate = dependencyTransition.indexOf('actor.send(', dependencyGateIndex);
  const firstStoryWriteAfterGate = dependencyTransition.indexOf('store.writeStory(', dependencyGateIndex);
  assert(dependencyGateIndex >= 0 && firstActorSendAfterGate > dependencyGateIndex && firstStoryWriteAfterGate > dependencyGateIndex, 'Story 3: dependency gate must precede actor.send and writeStory');
  const levelRegistrySource = read(processFactLevelRegistryPath);
  assert(/name: 'runtime:story_dependency_plan_dev_gate', level: 'L4'[^\n]+gateConsumer: 'runStoryTransition PLAN to DEV admission before phase mutation'/.test(levelRegistrySource), 'Story 3: PLAN to DEV dependency gate process fact missing');
  assert(dependencyTransition.includes("'show', `main:${store.storyDirRel()}/${depId}/index.json`")
    && dependencyTransition.includes("'merge-base', '--is-ancestor', branch, 'main'"),
  'Story 3: dependency gate must prove canonical main DONE and reject an unmerged partial-DONE branch');
  const findingLedgerArtifact = registrySource.match(/name: 'artifact:finding-ledger\.json',[\s\S]*?rationale: 'Append-only Finding persistence carrier[\s\S]*?\n  },/)?.[0] ?? '';
  const amendmentGates = read('packages/main/src/core/acceptance-amendment-gates.ts');
  assert(amendmentGates.includes('missingAcceptance') && amendmentGates.includes('acceptanceAmendmentBlocker'), 'amendment completion must reject pending and zero acceptance');
  for (const path of ['packages/main/src/core/machine.ts', 'packages/main/src/handlers/verifier.ts', 'packages/main/src/handlers/done-required-validation.ts', 'packages/main/src/handlers/certification-window.ts']) {
    assert(read(path).includes('acceptanceCompletionBlocker'), `${path}: amendment completion gate missing`);
  }
  assert(read('packages/main/src/handlers/checklist.ts').includes("if (missingAcceptance(item)) throw"), 'checklist done must reject zero intent and zero evidence');
  assert(read('packages/main/src/handlers/scope-contract.ts').includes('assertAcceptanceScopeReplacementAllowed'), 'DEV direct scope replacement must not bypass amendments');
  assert(read('packages/main/src/handlers/proofstory.ts').includes('DEV topology growth requires acceptance_amendment_propose'), 'DEV topology cannot bypass additive approval');
  const amendmentJournal = read('packages/main/src/core/acceptance-amendment-journal.ts');
  assert(registrySource.includes("name: 'runtime:story_scope_budget'"), 'semantic scope budget process fact must be registered');
  const decomposition = read('packages/main/src/core/story-scope-decomposition.ts');
  for (const invariant of ['readTrustedProofStoryScopeArtifacts', 'inspectChild(id)', 'store.storyExists(id)', 'parentLedgerId', 'verificationIntentRefs', 'decomposition must cover every parent milestone']) assert(decomposition.includes(invariant), `scope decomposition requires ${invariant}`);
  assert(read('packages/main/src/core/story-scope-budget.ts').includes('readScopeDecomposition(store, subject'), 'scope budget must consume live decomposition coverage');
  assert(registrySource.includes("name: 'runtime:machine_provider_admission'"), 'machine provider admission must be a registered process fact');
  assert(read('packages/main/src/core/reviewer-batch-admission.ts').includes('controller-interrupted'), 'shared admission must refuse interrupted controller recovery');
  assert(read('packages/main/src/core/managed-host-run.ts').includes('consumeManagedLaunchAdmission(args, sealedEnvironment, {runId,deadlineAt})') && read('packages/main/src/core/managed-host-run.ts').includes('await verifyManagedLaunchAdmission'), 'managed admission must gate fresh scratch creation and actual provider launch');
  assert(read('packages/main/src/core/managed-launch-admission.ts').includes('withVerifiedExecutionBatchLaunch') && read('packages/main/src/core/reviewer-batch-producer.ts').includes('withReviewerBatchLaunchLock') && read('packages/main/src/core/managed-host-run.ts').includes("result.failureKind === 'auth'"), 'batch current-generation verification and grant must serialize with auth revocation');
  assert(read('packages/main/src/core/reviewer-batch-producer.ts').includes('probeHostExecutionReadiness') && read('packages/main/src/core/reviewer-batch-producer.ts').includes('identifyManagedExecutionRuntimeInputs') && read('packages/main/src/core/reviewer-batch-admit-schema.ts').includes('retryFromGeneration'), 'owner admission requires real supervised probes, current runtime checks and explicit retry identity');
  assert(read('packages/main/src/core/managed-review-provider-state.ts').includes('provider seed integrity mismatch') && read('packages/main/src/core/managed-review-provider-state.ts').includes('provider seed binding mismatch'), 'cross-process seeds must verify keyed integrity and exact expected binding');
  assert(read('packages/main/src/core/reviewer-batch-subject.ts').includes('verifyReviewInventoryEpoch(epoch)') && read('packages/main/src/core/reviewer-batch-subject.ts').includes('BATCH_SUBJECT_CUTOFF_DRIFT') && read('packages/main/src/core/reviewer-batch-subject.ts').includes('BATCH_ASSIGNMENT_MISSING_LANES'), 'batch subject must verify signed current epoch, material cutoff and complete assignments');
  assert(read('packages/main/src/core/managed-execution-input-identity.ts').includes('fingerprintCapturedManagedProviderState'), 'execution identity must bind captured provider inputs');
  assert(read('scripts/verify-u08-execution-identity.mjs').includes('fixture-env-secret'), 'input identity requires actual secret/environment drift regression');
  assert(read('scripts/verify-u08-batch-admission.mjs').includes('U08_BATCH_CONTROLLER_CONCURRENT_PASS'), 'shared admission requires actual multi-process regression');
  assert(registrySource.includes('packages/main/src/providers/supervised-process-worker.ts'), 'synchronous provider lifecycle must be registered');
  assert(read('packages/main/src/core/host-execution-readiness.ts').includes('runSupervisedProviderProcess(args.executablePath'), 'readiness probes must share supervised provider lifetime');
  assert(read('scripts/verify-u08-supervised-readiness.mjs').includes('readiness probe must reap its live descendant before returning'), 'readiness has an actual descendant regression');
  assert(read('packages/main/src/core/managed-review-provider-state.ts').includes('materializeManagedProviderState(cache,captureManagedProviderState(host,env))'), 'provider state creation must use the captured input seam');
  assert(read('scripts/verify-u08-private-state-capture.mjs').includes('capture must prevent source credential drift'), 'provider input drift has a real file regression');
  assert(registrySource.includes('canonical validation command IDs'), 'scope budget canonical validation identities must be registered');
  const legacyBudget = read('packages/main/src/core/story-scope-budget-legacy.ts');
  for (const invariant of ['SCOPE_BUDGET_SUBJECT_SCHEMA', 'capturedPhase', 'row.createdAt === snapshot.createdAt', '[next, base].every', 'subjectDigest !== snapshot.subjectDigest']) {
    assert(legacyBudget.includes(invariant), `legacy scope migration requires ${invariant}`);
  }
  assert(registrySource.includes('packages/main/src/core/story-scope-budget-legacy.ts'), 'legacy migration producer must be registered');
  assert(read('packages/main/src/handlers/story-scope-budget.ts').includes('legacySnapshot: readScopeBudgetLegacySnapshot'), 'migration subject export must use shared read-only projection');
  const budgetDecision = read('packages/main/src/core/story-scope-budget-decisions.ts');
  for (const invariant of ['assertOperator(args)', 'withReviewInventoryMutationLock', 'verifyValidationArtifact', 'report.bindingDigest !== args.bindingDigest', 'currentScopeBudgetApproval', 'expiresAt']) {
    assert(budgetDecision.includes(invariant), `scope budget approval requires ${invariant}`);
  }
  assert(registrySource.includes("name: 'scope-budget-decisions.json'"), 'scope approval signed artifact must be registered');
  assert(read('packages/main/src/core/lifecycle-registry.ts').includes("'scope-budget-decisions.json'"), 'scope decisions must be lifecycle metadata');
  const budgetMachine = read('packages/main/src/core/machine.ts');
  for (const guard of ['canStartDevGuard', 'canSkipPlanGuard', 'canReenterDevGuard']) {
    assert(budgetMachine.includes(`export function ${guard}(context: StoryMachineContext): boolean {\n  if (storyScopeBudgetBlocker(context.store, context.projectRoot, context.storyId)) return false;`),
      `${guard} must check semantic budget outside legacy fail-open handling`);
  }
  const amendmentBudgetOffset = amendmentJournal.indexOf('storyScopeBudgetBlocker(store, root, args.storyId, next, entry.base)');
  assert(amendmentBudgetOffset >= 0 && amendmentBudgetOffset
    < amendmentJournal.indexOf("if (entry.state !== 'APPLYING')"), 'amendment budget must be checked before apply and during recovery');
  assert(read('packages/main/src/handlers/story-review.ts').includes("type: 'scope_budget', severity: 'blocker'"),
    'planning review guidance must expose the mechanical semantic budget blocker');
  assert(registrySource.includes('artifact:acceptance-amendments.json'), 'signed amendment application must be registered');
  for (const invariant of ['verifyValidationArtifact', 'deriveAcceptanceAmendment', 'onAcceptanceReviewKeyCreated', "state: 'APPLYING'", "state: 'APPROVED'", 'Acceptance amendment interrupted']) {
    assert(amendmentJournal.includes(invariant), `amendment journal requires ${invariant}`);
  }
  assert(read('packages/main/src/core/lifecycle-registry.ts').includes("'acceptance-amendments.json'"), 'amendment journal must be classified as lifecycle metadata');
  const acceptanceReviewer = read('packages/main/src/core/managed-host-run.ts');
  assert(registrySource.includes('artifact:acceptance-amendment-review-receipt'), 'DEV amendment review seal must be registered');
  for (const invariant of ['parseAcceptanceReviewFinal', 'readManagedAcceptanceReviewReceipt', 'managedAcceptanceReviewPublicKey', 'verifyCanonical(claims, signature, expected.publicKey)']) {
    assert(acceptanceReviewer.includes(invariant), `DEV amendment review requires ${invariant}`);
  }
  const acceptanceFinal = read('packages/main/src/core/acceptance-amendment-review.ts');
  assert(acceptanceFinal.includes("ACCEPTANCE_REVIEW_FINAL_SCHEMA = 'proof-or-stop.acceptance_amendment_review_final.v1'")
    && acceptanceFinal.includes('schemaVersion: typeof ACCEPTANCE_REVIEW_FINAL_SCHEMA')
    && acceptanceFinal.includes('proposal.schemaVersion !== ACCEPTANCE_REVIEW_FINAL_SCHEMA')
    && acceptanceFinal.includes('enum: [ACCEPTANCE_REVIEW_FINAL_SCHEMA]'), 'DEV final schema declaration/type/parser/transport must use one canonical identity');
  assert(acceptanceReviewer.includes('finalResultSchema: ACCEPTANCE_REVIEW_FINAL_SCHEMA')
    && acceptanceReviewer.includes('seal.proposal.schemaVersion !== ACCEPTANCE_REVIEW_FINAL_SCHEMA'), 'worker scanner and signed receipt consumer must reject retired inner schemas');
  assert(acceptanceReviewer.indexOf('const proposal = parseAcceptanceReviewFinal(result') < acceptanceReviewer.indexOf('signature: signCanonical(claims, proposalInvocationPrivateKey)'), 'worker must parse exact final before signing proposal');
  const acceptanceReviewWitness = read('scripts/verify-acceptance-review-receipt.mjs');
  for (const invariant of ['recomputing every unsigned digest', 'GC preserves approval', 'DEV approval cannot become an old REVIEW final result', 'retired inner schema cannot obtain worker approval', 'authentic signed retired inner schema is not current authority']) {
    assert(acceptanceReviewWitness.includes(invariant), `DEV amendment review needs witness: ${invariant}`);
  }
  const remediationSource = read('packages/main/src/handlers/review-remediation.ts');
  for (const invariant of ['withAtomicFindingLedgerWrites', 'verifyReviewInventoryEpoch', 'verifyReviewInventoryReceipt',
    'verifyCausalEvidenceReceipt', 'isBlockingDirty', 'appendMarker(ctx.store)', 'exactStoryArtifactNames']) {
    assert(remediationSource.includes(invariant), `ReviewRemediation must preserve ${invariant}`);
  }
  assert(/review_remediation_close:[^\n]+ownershipClass: 'storyScopedMutating'[^\n]+allowedPhases: \['DEV'\]/.test(read('packages/main/src/core/command-policy.ts')), 'ReviewRemediation must remain owner-gated DEV repair');
  const atomicLedgerWitness = read('scripts/verify-atomic-finding-ledger.mjs');
  for (const invariant of ['a later refusal must publish none of the batch', 'the whole batch has one durable publication',
    'canonical reader trusts every individual signed carrier', 'exact batch replay is byte-identical']) {
    assert(atomicLedgerWitness.includes(invariant), `atomic ledger publication needs executable coverage: ${invariant}`);
  }
  assert(/kind: 'signed-artifact'/.test(findingLedgerArtifact), 'Story 3: finding-ledger.json must be registered as a signed artifact');
  assert(/level: 'L2'/.test(findingLedgerArtifact) && !/consumerGate:/.test(findingLedgerArtifact), 'Story 3: finding-ledger.json must remain L2 persistence-only with no lifecycle gate consumer');
  assert(/REVIEW_RETENTION_PROTOCOL_METADATA_PATHS[\s\S]*?'finding-ledger\.json'/.test(read('packages/main/src/core/lifecycle-registry.ts')), 'Story 3: finding-ledger.json must be retained as non-authoritative REVIEW protocol metadata');
  const lifecyclePolicy = extractConstInitializer(
    registrySource,
    'PROCESS_FACT_STORY3_FINDING_LIFECYCLE_POLICY',
    processFactRegistryPath,
  );
  assert(/recordType: 'finding_lifecycle_transition'/.test(lifecyclePolicy)
    && /level: 'L4'/.test(lifecyclePolicy)
    && /gateEvidence: true/.test(lifecyclePolicy)
    && /lifecycleAuthority: 'terminal-finding-state'/.test(lifecyclePolicy),
  'Story 3: signed Finding lifecycle transition must be an explicit L4 terminal-state fact');
  assert(/legacy_lifecycle_receipt_binding/.test(lifecyclePolicy)
    && /current exact-signed/.test(lifecyclePolicy)
    && /immutable carrier, record, source identity, and chain/.test(lifecyclePolicy),
  'Story 3: pre-upgrade lifecycle authority must require current-trust exact-byte re-attestation');
  assert(/name: 'runtime:finding_ledger_lifecycle_transition_gate', level: 'L4'[^\n]+gateConsumer: 'storyMachine\.canPassReview REVIEW to TEST gate'/.test(levelRegistrySource),
  'Story 3: lifecycle transition gate fact missing from level registry');
  assert(read('packages/main/src/handlers/finding.ts').includes("operation: 'append_finding_lifecycle_transition'")
    && read('packages/main/src/core/store.ts').includes("record.recordType !== 'finding_lifecycle_transition'")
    && read('packages/main/src/handlers/finding-ledger.ts').includes("recordType: 'legacy_lifecycle_receipt_binding'")
    && read('packages/main/src/core/store.ts').includes('trustedLegacyLifecycleReceiptBindings'),
  'Story 3: resolve/dismiss lifecycle record is not wired to canonical read projection');
  const projectionPolicy = extractConstInitializer(
    registrySource,
    'PROCESS_FACT_STORY3_FINDING_PROJECTION_POLICY',
    processFactRegistryPath,
  );
  assert(/recordType: 'finding_projection'/.test(projectionPolicy)
    && /level: 'L4'/.test(projectionPolicy)
    && /gateEvidence: true/.test(projectionPolicy)
    && /lifecycleAuthority: 'current-finding-projection'/.test(projectionPolicy),
  'Story 3: signed Finding projection must be an explicit L4 current-state fact');
  assert(/name: 'runtime:finding_ledger_projection_gate', level: 'L4'[^\n]+gateConsumer: 'storyMachine\.canPassReview REVIEW to TEST gate'/.test(levelRegistrySource),
  'Story 3: Finding projection gate fact missing from level registry');
  assert(read('packages/main/src/handlers/finding-ledger.ts').includes("operation: 'append_finding_projection'")
    && read('packages/main/src/core/store.ts').includes("record.recordType === 'finding_projection'")
    && read('packages/main/src/core/store.ts').includes("signed.operation !== 'append_finding_projection'"),
  'Story 3: authoritative Finding projection is not wired to signed canonical read projection');
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
  if (!quiet) {
    console.log('- registry entries:');
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(formatProcessFactRegistryEntry(entry));
    }
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
      continue;
    }
    if (pattern.absent) {
      assert(
        !text.includes(pattern.absent),
        `${entryName}: ${relPath} must not contain ${pattern.label || `"${pattern.absent}"`}`,
      );
      continue;
    }
    if (pattern.absentRegex) {
      assert(
        !pattern.absentRegex.test(text),
        `${entryName}: ${relPath} must not contain ${pattern.label || pattern.absentRegex}`,
      );
    }
  }
}

const inventory = [
  {name:'Complete selector output remains receipt-bound',files:[
    {relPath:'packages/main/src/core/causal-evidence.ts',patterns:['readCausalSelectorOutput','selectorOutput','selectorWitness','CAUSAL_SELECTOR_OUTPUT_BOUND_BYTES','causal_legacy_selector_output_unproven','retryExecutions.get(key.key) ??','causal_selector_output_invalid','redactCausalOutput']},
    {relPath:'packages/main/src/core/store.ts',patterns:['readCausalSelectorOutput','writeCausalSelectorOutput','CAUSAL_OUTPUT_DIRECTORY']},
    {relPath:'docs/validation-performance.md',patterns:['complete redacted output','12,000','missing or changed']},
  ]},
  {name:'DONE checks current admission and commits only its own evidence',files:[
    {relPath:'packages/main/src/handlers/done-required-validation.ts',patterns:['policy.commands.some(sharedValidationReuseAllowed)', 'policy.required && requiresCleanWorkspaceForReuse', "['status', '--porcelain=v1', '--untracked-files=all']", "if (dirty) throw new Error('SHARED_DONE_REQUIRES_CLEAN_WORKSPACE')", 'requireCurrentHeavyCertificationWindow', "autoCommitStoryMetadata(ctx.root, storyId, 'done_required_validate'", "closeoutArtifactPaths: ['done-required-evidence.json']"]},
    {relPath:'packages/main/src/core/auto-commit-metadata.ts',patterns:["'certification-running'","['certification-window.json']"]},
  ]},
  {name:'Exact quorum assertion inventory and current main partitioning',files:[
    {relPath:'packages/main/src/tasks/quorum-submit-smoke-case-catalog.ts',patterns:['validateQuorumSmokeInventory','validateQuorumSmokePartitions','unresolved executable callback','missing canonical quorum smoke shard(s)','partition must contain exactly 73 cases','competing quorum smoke selectors']},
    {relPath:'packages/main/src/tasks/quorum-submit-smoke.ts',patterns:['runQuorumSmokeCoordinator','QUORUM_SMOKE_RUN_JSON','QUORUM_SMOKE_CASES_JSON']},
    {relPath:'packages/main/tests/red/red-B-e40f-lab-convergence.mjs',patterns:['MAX_QUORUM_SMOKE_JOBS','validateQuorumSmokeInventory','validateQuorumSmokePartitions','one-process-per-shard']},
    {relPath:'docs/validation-performance.md',patterns:['73','--jobs=2','modular coordinator']},
  ]},
  {name:'Governed acceptance revision and durable recovery',files:[
    {relPath:'packages/main/src/handlers/checklist.ts',patterns:['createIntentRevision','verification_intent_recover','restoreIntentCheckpoint','AMENDMENT_RECOVERY_REASON_REQUIRED']},
    {relPath:'packages/main/src/core/verification-intent-amendment.ts',patterns:['proof-or-stop.intent-revision.v1','AMENDMENT_REPLAN_REQUIRED','IntentAmendmentIntegrityError','beforeScopeHash']},
    {relPath:'packages/main/src/core/verification-intent-checkpoint.ts',patterns:['proof-or-stop-intent-checkpoints','verifyValidationArtifact','AMENDMENT_CHECKPOINT_HISTORY_GAP','linkSync(temp,path)','AMENDMENT_CHECKPOINT_PROJECTION_MISMATCH','refs/proof-or-stop/intent-checkpoints/','update-ref','commit-tree','AMENDMENT_CHECKPOINT_ANCHOR_INVALID','for-each-ref','cat-file','AMENDMENT_CHECKPOINT_ROLLBACK','AMENDMENT_CHECKPOINT_MIRROR_CONFLICT','AMENDMENT_CHECKPOINT_ANCHOR_WRITE_FAILED','reconcileMirror(directory,records)','inspectIntentCheckpointRecovery','repairIntentCheckpointStorage','AMENDMENT_CHECKPOINT_SIGNED_MIRROR_CONFLICT','validateCheckpoints','assertIntentAmendmentItems',"'.quarantine-'"]},
    {relPath:'packages/main/src/core/store.ts',patterns:['assertIntentCheckpointProjection','writeIntentCheckpoint','restoreIntentCheckpoint','digestCanonicalJson(prefix ?? null)']},
    {relPath:'packages/main/src/core/canonical-story.ts',patterns:['rethrowIntentAmendmentIntegrityError(error)']},
    {relPath:'docs/validation-performance.md',patterns:['verification_intent_recover','INIT/PLAN','checkpoint']},
  ]},
  {name:'Pinned implementation and original batch publication',files:[
    {relPath:'packages/main/src/handlers/checklist.ts',patterns:['implementationDigest','currentImplementationDigest','execution_implementation_changed','enforceWithPublicationRecovery','publicationRecoveryKey']},
    {relPath:'packages/main/src/core/causal-evidence.ts',patterns:['createCausalPublicationRecovery','verifyCausalPublicationRecovery','proof-or-stop.causal-publication-recovery.v1']},
    {relPath:'packages/main/src/core/store.ts',patterns:['readPendingPublication','writePendingPublication','removePendingPublication','publication_recovery_invalid']},
    {relPath:'packages/main/src/cli-engine.ts',patterns:['enforceExecutionImplementationPin();','--implementation-identity','enforcedImplementationIdentity ?? executionImplementationIdentity()']},
    {relPath:'packages/main/src/handlers/checklist.ts',patterns:["withOwnerLeaseHeartbeat(store.storyDirPath(args.storyId), { command: 'verification_evidence_add'","withOwnerLeaseHeartbeat(store.storyDirPath(args.storyId), { command: 'verification_evidence_batch_add'",'commitCanonicalCausalEvidence']},
    {relPath:'docs/validation-performance.md',patterns:['PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN','verification_evidence_batch_add','opt-in']},
  ]},
  {
    name: 'Production validation sharing and bounded repair authority',
    files: [
      {relPath:'scripts/verify-routine-precert-entry.mjs',patterns:['PRE_CERT refusal must precede child launch',"focus: 'fast'"]},
      {relPath:'packages/main/src/core/store.ts',patterns:['causalEvidenceOutputPaths','verifyCausalEvidenceReceipt(receipt)','verified.get(key) === hash']},
      {relPath:'scripts/verify-shared-receipt-publication.mjs',patterns:['new StoryStore(root)','dirty material cannot consume a shared receipt']},
      {relPath:'scripts/verify-flat-provider-validation.mjs',patterns:['canonical validation must not launch another registered command','canonical coverage union must retain']},
      {relPath:'scripts/verify-validation-static-edges.mjs',patterns:['exception dependency coverage missing or changed','source parse diagnostics','U18_STATIC_','configDrift','staleExceptions']},
      {relPath:'scripts/verify-validation-static-edge-boundaries.mjs',patterns:['omitted caller dependency refused','removed canonical flag reveals nested suite','source drift invalidates exception']},
      {relPath:'scripts/verify-liveness-validation-union.mjs',patterns:['U18_LIVENESS_UNION_REQUIRED','U18_NESTED_REGISTERED_MEMBER','provider-codex F181 independent child CLI boundary PASS']},
      {relPath:'scripts/verify-convergence-net-progress.mjs',patterns:['verified blocker reduction must not be classified as a stall','canMintReviewRoundGuard(ctx)']},
      {relPath:'scripts/verify-shared-output-boundary.mjs',patterns:['truncated capture must never become reusable evidence','receipt digest binds complete captured output','exactly 12000 complete characters remain reusable']},
      {relPath:'packages/main/src/handlers/verifier.ts',patterns:['validate?.sharedExecution === true']},
      {relPath:'packages/main/src/core/causal-evidence.ts',patterns:['resolveCausalToolVersion(_projectRoot: string)', 'return PROOF_OR_STOP_CLI_VERSION']},
      {relPath:'packages/main/src/tasks/validate-execution-lock-smoke.ts',patterns:['scripts/verify-performance-production.mjs']},
      {relPath:'packages/main/src/core/shared-validation-execution.ts',patterns:['executeCausalEvidence','preflightCausalEvidence','fullBaselineReusePolicy',"'forbidden'",'unchanged()','executionReceipt','executionImplementationIdentity().digest','implementationDigest']},
      {relPath:'packages/main/src/core/review-inventory-epoch.ts',patterns:['review-remediation-only','remediation-only receipt cannot enter certification','rebuilt.newVerifiedFindingCount !== finalWave.newVerifiedFindingCount']},
      {relPath:'packages/main/src/handlers/transition-effects.ts',patterns:['--remediation','cannot enter certification or TEST']},
      {relPath:'docs/validation-performance.md',patterns:['exact-inputs','forbidden','--remediation','no Story-wide speedup']},
    ],
  },
  {
    name: 'Explicit Lab maintenance integration boundary',
    files: [
      { relPath: 'packages/main/src/core/process-fact-registry.ts', patterns: ['runtime:lab_local_maintenance_integration', 'never Story REVIEW/TEST/DONE'] },
      { relPath: 'scripts/lab-worktree.mjs', patterns: ['acquireMainWriteLock', 'createHmac', 'Fresh GREEN', 'synced-green', 'candidate-green', 'main-green', 'candidate-story-baseline', 'main-story-baseline', 'candidate-story-integration', 'main-story-integration', '--ff-only', "phase = 'verified'", "'branch', '-d'", "action === 'carry'", "action === 'baseline'", 'story-baseline-supplement', 'baselineWitnesses', 'finishBaselineWitnesses', 'integrationWitnesses', 'createVerificationEvidenceGateEvaluator', 'currentMaterialHash', 'currentStoryFilesHash', 'failureIdentity', "['node', 'scripts/ensure-dist.mjs']", "!path.startsWith('.proof-or-stop/')", 'preservedMainDirty', 'Dirty main changed during Story carry-forward integration'] },
      { relPath: 'scripts/verify-lab-story-carry-forward.mjs', patterns: ['tamper Story hash binding', 'tamper Story receipt authenticity', 'add open Finding', 'exceed bounded baseline failures', 'product change after evidence', 'overlaps dirty main paths', 'trace_incomplete', 'candidate-story-integration', 'main-story-integration'] },
      { relPath: 'docs/lab-maintenance.md', patterns: ['not formal Story', 'RED', 'GREEN', '--confirm', 'Carry a blocked Story patch', 'not Story DONE', 'strict authoritative', 'normalized diagnostic identity', 'bounded dynamic revalidation'] },
    ],
  },

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
          'proof-or-stop validate --json',
          'assertTestAdmissibleRoutineValidationWindow',
          { label: 'test-evidence writer call', absentRegex: /\.writeTestEvidence\s*\(/ },
          'Cannot enter TEST: CLI gate preflight execution error',
          'PRE_CERT_ROUTINE_PASS_REQUIRED',
        ],
      },
      {
        // B-914f: verifier is the single canonical writer for routine
        // validation evidence. Phase gates consume its signed PASS;
        // they must not persist the same artifact a second time.
        relPath: 'packages/main/src/handlers/verifier.ts',
        patterns: [
          'persistStoryValidationEvidence',
          'ctx.store.writeTestEvidence',
          "disposition: 'reused'",
          'canonical-pass-persistence-failed',
          'commitValidationReuseMetadataTransaction',
          "reason: 'validate'",
          "closeoutArtifactPaths: ['test-evidence.json']",
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
        relPath: 'packages/main/src/core/owner-session-adapters.ts',
        patterns: [
          'explicitProvider',
          "return normalizeProvider(explicitProvider) ?? 'unknown'",
          'CODEX_THREAD_ID',
          'CLAUDE_CODE_SESSION_ID',
        ],
      },
      {
        relPath: 'packages/main/src/handlers/story-dispatch.ts',
        patterns: [
          'reviewerPromptHostForProvider',
          'currentReviewerPromptHost',
          'unsupported session host provider',
          'hostRenderHost',
          'hostRenderIdentityDigest',
          'dispatchBindingDigest',
        ],
      },
      {
        relPath: 'packages/main/src/handlers/review-run.ts',
        patterns: ['review_run_start', 'resolveReviewRunLane', 'captureReviewRunSnapshot', 'buildReviewRunWorkspaceBinding', 'verifyCurrentReviewerDispatchBinding', 'dispatchPrompt', 'hostRenderHost', 'hostRenderIdentityDigest', 'workspaceBinding', 'signReviewRun', 'writeReviewRuns', 'Review run'],
      },
      {
        relPath: 'packages/main/src/cli/command-catalog.ts',
        patterns: [
          'review_run_start',
          'lane: z.enum',
          'reviewedIntentRefs',
          { label: 'caller-controlled promptHash removed', absentRegex: /promptHash:\s*z\.string\(\)/ },
        ],
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
        patterns: ['review_pass_set', 'reviewRunId', 'assertCurrentReviewRunForEvidence', 'signReviewPass', { label: 'persistReviewPass/current durable write-read', any: ['persistReviewPass', 'writeReviewPasses'] }, 'withReviewPassLock', 'Review pass', 'writerSessionId', 'getSessionIdentity', 'evaluateReviewPassProvenance', 'readOwnerLease'],
      },
      {
        relPath: 'packages/main/src/cli-engine.ts',
        patterns: ['review_pass_set', 'reviewRunId: z.string()', 'note: z.string()'],
      },
      {
        // B-3b05: writer-session provenance hardcoded fallback — warn is the
        // hardcoded default (absent/invalid config never enforces), enforce is
        // opt-in, and the same_session_write flag is audit-only.
        relPath: 'packages/main/src/core/review-pass-provenance.ts',
        patterns: ['same_session_write', 'resolveReviewPassProvenanceMode', 'evaluateReviewPassProvenance', "REVIEW_PASS_PROVENANCE_DEFAULT_MODE: ReviewPassProvenanceMode = 'warn'", "'enforce'"],
      },
      {
        // B-3b05: provenance-inclusive records verify only via the versioned
        // domain; records without writerSessionId keep the legacy domains.
        // F-002: the provenanceFlag itself is signed (absent canonicalized to
        // empty), so flag add/strip/flip breaks verification.
        relPath: 'packages/main/src/core/finding-verify.ts',
        patterns: ['writerSessionId', 'sessionSource', 'ReviewPassWriterProvenance', 'provenanceFlag', "provenanceFlag: provenance.provenanceFlag ?? ''"],
      },
    ],
  },
  {
    name: 'verification evidence',
    files: [
      {
        relPath: 'packages/main/src/handlers/checklist.ts',
        patterns: ['verification_evidence_add', 'verification_evidence_batch_add', 'normalizeEvidence', 'makeEvidence', 'evidenceHashes', 'hasExecutableVerifier', 'Boolean(intent.verification)', 'Boolean(callerSelector)'],
      },
      {
        relPath: 'packages/main/src/tasks/tool-executed-evidence-receipt-smoke.ts',
        patterns: ['INT-DOCS-PIN', 'selector-bearing docs check is mechanical', 'verification_run preserves mechanical docs authority'],
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
        patterns: ['verifyScopeCheckSignature', 'scope-check.json', 'scope_check_save'],
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
        // (runReviewCliGates / the `proof-or-stop validate --json` gate / the two
        // English `Cannot enter TEST` strings) into phase-gates.ts. B-914f
        // keeps test-evidence persistence exclusively in verifier.ts.
        // story-advance.ts keeps buildDoneChecklist (DONE checklist assembly).
        relPath: 'packages/main/src/handlers/story-advance.ts',
        patterns: ['buildDoneChecklist'],
      },
      {
        relPath: 'packages/main/src/handlers/phase-gates.ts',
        patterns: [
          'runReviewCliGates',
          'proof-or-stop validate --json',
          'buildDoneChecklist',
          'assertTestAdmissibleRoutineValidationWindow',
          { label: 'test-evidence writer call', absentRegex: /\.writeTestEvidence\s*\(/ },
          'Cannot enter TEST: CLI gate preflight execution error',
          'PRE_CERT_ROUTINE_PASS_REQUIRED',
        ],
      },
      {
        relPath: 'packages/main/src/handlers/verifier.ts',
        patterns: [
          'persistStoryValidationEvidence',
          'ctx.store.writeTestEvidence',
          "disposition: 'reused'",
          'canonical-pass-persistence-failed',
          'commitValidationReuseMetadataTransaction',
          "reason: 'validate'",
          "closeoutArtifactPaths: ['test-evidence.json']",
        ],
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
    const promptPath = rolePromptPath(dir, fileName);
    assert(
      promptMap.has(promptPath),
      `${promptPath}: reviewer-facing prompt must be included in prompt drift scan`,
    );
  }
}
await comparePromptSemantics(promptMap);
assertSyntheticAdversarialChecks();
{
  const admissibility = read('packages/main/src/core/proof-admissibility.ts');
  const verification = read('packages/main/src/core/verification.ts');
  assert(admissibility.includes('evaluateVerificationEvidenceForGate'), 'verification receipt lifecycle evaluator must be authoritative in proof-admissibility');
  assert(admissibility.includes('validateVerificationReceipt'), 'verification lifecycle evaluator must validate receipt and full-output artifact integrity');
  assert(admissibility.includes('VERIFICATION_RECEIPT_BUNDLE_V5'), 'verification lifecycle evaluator must require the publication-bound v5 receipt bundle');
  for (const code of ['verification_receipt_missing', 'verification_receipt_legacy', 'verification_receipt_invalid', 'verification_receipt_stale', 'verification_receipt_not_passing', 'verification_reuse_incomplete']) {
    assert(admissibility.includes(code), `verification lifecycle evaluator missing stable diagnostic: ${code}`);
  }
  assert(verification.includes('receiptAdmissibility'), 'verification coverage must consume a gate-owned receipt admissibility callback');
  assert(verification.includes('nonMechanicalReason: decision.detail'), 'verification coverage must preserve stable receipt diagnostics on denied rows');
  const maintenance = read('packages/main/src/handlers/checklist.ts');
  for (const token of ['hasStaleLegacyMetadata', "entry.status !== 'non_mechanical'", 'evidence.receipt',
    'evidence.mechanical === true', '!evidence.headHash', "evidence.kind === 'waiver'", "evidence.result === 'fail'",
    'resolved.intent.verification', 'checkEvidenceFreshnessForGit(', 'createVerificationEvidenceGateEvaluator(root, storyId)']) {
    assert(maintenance.includes(token), `legacy metadata maintenance must preserve its narrow non-authoritative boundary: ${token}`);
  }
  const regression = read('packages/main/src/tasks/verification-run-and-guard-smoke.ts');
  for (const token of ['partMLegacyMetadataMaintenance', 'partNLiveProducerOwnership',
    'metadata never grants execution authority', 'dry-run is read-only', 'unexecuted command-backed PASS is explicitly demoted']) {
    assert(regression.includes(token), `receipt maintenance and producer ownership regression missing: ${token}`);
  }
  for (const consumerPath of [
    'packages/main/src/core/machine.ts',
    'packages/main/src/core/lifecycle-readiness.ts',
    'packages/main/src/handlers/phase-gates.ts',
    'packages/main/src/handlers/verifier.ts',
    'packages/main/src/handlers/done-prepare.ts',
    'packages/main/src/handlers/certification-window.ts',
  ]) {
    const source = read(consumerPath);
    const direct = source.includes('createVerificationEvidenceGateEvaluator');
    const shared = consumerPath === 'packages/main/src/handlers/phase-gates.ts'
      && source.includes("from './validation-pass-admissibility.js'") && source.includes('assessStoredValidationPassAdmissibility(ctx, storyId)')
      && read('packages/main/src/handlers/validation-pass-admissibility.ts').includes('receiptAdmissibility: createVerificationEvidenceGateEvaluator(ctx.root, storyId)');
    assert(direct || shared, `${consumerPath}: actual gate/reader must use authoritative verification receipt evaluator`);
  }
}
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
assertCurrentVerificationReceiptModel();
assertPromptEvidenceBoundaries(promptMap);
assertProofStoryProgressiveBoundary();
assertProofStoryGateConsumedFacts();
assertCloseoutTrustBoundary();
assertPhaseTransitionReopenAuditContract();
assertOutOfBandReopenAuditRescueContract();
assertReopenAuditConcurrencyResidualContract();
assertReopenAuditLockRejectionRationaleContract();
assertValidationPersistenceTransactionContract();
assert(parseProcessFactLevelRegistry().find(entry => entry.name === 'host_run_status')?.level === 'L0',
  'managed status fact level must match read-only command ownership and runtime behavior');
const durationManagedSource = readFileSync(join(root, 'packages/main/src/core/managed-host-run.ts'), 'utf8');
assert(durationManagedSource.includes('durationEstimate: captureManagedRunDurationEstimate(args, createdAt)')
  && durationManagedSource.includes('durationEstimate: spec.durationEstimate ??'),
  'managed duration estimates must be sampled at submit and projected from sealed spec, not status IO');
const fastDiagnosticSource = readFileSync(join(root, 'scripts/run-precert-fast.mjs'), 'utf8');
assert(fastDiagnosticSource.includes("authority:'diagnostic-only'") && fastDiagnosticSource.includes('writesStoryEvidence:false'),
  'local pre-cert fast diagnostics must not mint Story authority');
const configuredFastSet = JSON.parse(readFileSync(join(root, 'proof-or-stop.config.json'), 'utf8')).validate.commands
  .filter(command => command.args?.[0] === 'scripts/run-precert-fast.mjs');
assert(configuredFastSet.length === 1 && configuredFastSet[0].focus.includes('fast')
  && configuredFastSet[0].fullBaselineReusePolicy === 'forbidden',
  'pre-cert fast set must be consumed exactly once by fresh configured validation');
const entryDiagnosticSource = readFileSync(join(root, 'scripts/entry-preflight.mjs'), 'utf8');
assert(entryDiagnosticSource.includes('diagnosticOnly: true') && entryDiagnosticSource.includes('writesEvidence: false')
  && entryDiagnosticSource.includes('advancesPhase: false') && entryDiagnosticSource.includes('UNAVAILABLE'),
  'entry preflight diagnostics must not claim unavailable checks or transition/evidence authority');
assert(readFileSync(join(root, 'packages/main/src/handlers/story-review.ts'), 'utf8').includes('assessPlanTouchpointCoverage(understanding.touchpoints, cl.items)'),
  'entry preflight and Story review must share the existing touchpoint coverage semantics');
assertReviewInventoryRemediationContract();
assertProcessFactCommandInventory();
assertDonePreflightPredicateInventoryParity();
await assertLifecycleArtifactScopePolicy();
assertStrengtheningRoadmapGovernanceLedger();
assertParentRoadmapIntentTotalityPlan();
assertParentRoadmapTotalityRuntime();
assertStoryAwareDynamicValidationRuntime();
assertPromptMeasurementObservationBoundary();
// B-03b7: Story2 semantics are separate from Story3 persistence authority.
// Mutation probes protect the checker itself; the focused task exercises actual IO.
function candidateBoundaryIssues(core, handler, store, policy) {
  const issues = [];
  if (/^import(?! type).*from ['"](?:node:|.*(?:store|finding-ledger)\.js)/m.test(core)) issues.push('pure core IO import');
  for (const marker of ['assertIdentityJson', 'Reflect.ownKeys', 'canonicalHash(row) !== canonicalHash(value)', 'verifyCanonical(unsigned, signature',
    'evidenceAnchors: anchors', 'validateCandidateReproductionAttestation']) {
    if (!core.includes(marker)) issues.push(`strict semantic guard ${marker}`);
  }
  for (const marker of ['assertCurrentReviewRunForEvidence', 'verifyCausalEvidenceReceipt', 'verifiedIdentityCarrier', 'candidate-reproduced:',
    'candidate.reproductionContract', 'materializeCandidateReproductionCommand', 'receipt.identity.command', 'reproductionContract.selector',
    'receipt.identity.storyFilesHash', 'source.envelope.producedAt',
    'args.reproductionAttestation.selector !== reproductionContract.selector', "kind: 'candidate_reproduction_attestation'",
    'candidateProjectionHash: candidate.currentProjectionHash', 'reproductionContractHash: identityHash(reproductionContract)',
    'reproductionReceiptHash: args.reproductionReceiptHash', 'findingRef', 'reviewRunId: args.reviewRunId', 'reviewer: actor']) {
    if (!handler.includes(marker)) issues.push(`promotion evidence ${marker}`);
  }
  if (/\.(?:finding_add|writeFindings|writeStory)\s*\(/.test(handler)) issues.push('candidate handler mutates Finding/lifecycle');
  for (const marker of ['verifyFindingLedgerReceipt', 'verifyIdentityEnvelope', 'captureMkdirLockFence', 'expectedPriorLedgerDigest: old.priorLedgerDigest', 'old.casBindings', 'requestDigest !== requestDigest']) {
    if (!store.includes(marker)) issues.push(`signed persistence ${marker}`);
  }
  if (!policy.includes("lifecycleAuthority: 'none'") || !policy.includes('gateEvidence: false')) issues.push('candidate gate authority');
  return issues;
}
const candidateSources = [read('packages/main/src/core/finding-identity.ts'), read('packages/main/src/handlers/finding-identity.ts'),
  read('packages/main/src/handlers/finding-identity-store.ts'), read(processFactRegistryPath).split('export const PROCESS_FACT_STORY2_CANDIDATE_POLICY =')[1]?.split('} as const;')[0] ?? ''];
for (const issue of candidateBoundaryIssues(...candidateSources)) fail(`Story2 candidate boundary: ${issue}`);
for (const [index, before, after] of [[0, 'canonicalHash(row) !== canonicalHash(value)', 'false'], [0, 'validateCandidateReproductionAttestation', 'acceptUnboundAttestation'],
  [1, 'verifyCausalEvidenceReceipt', 'acceptCallerClaim'],
  [1, 'materializeCandidateReproductionCommand', 'acceptAnyCommand'], [1, 'reproductionContract.selector', 'marker'],
  [1, 'args.reproductionAttestation.selector !== reproductionContract.selector', 'false'],
  [1, "kind: 'candidate_reproduction_attestation'", "kind: 'candidate'"],
  [2, 'verifyFindingLedgerReceipt', 'acceptUnsignedReceipt'], [3, 'gateEvidence: false', 'gateEvidence: true']]) {
  const mutation = [...candidateSources]; mutation[index] = mutation[index].replaceAll(before, after);
  assert(candidateBoundaryIssues(...mutation).length > 0, `Story2 candidate verifier must catch ${before} removal`);
}
function routeBoundaryIssues(route, progress, handler, policy) {
  const issues = [];
  for (const source of [route, progress]) if (/^import(?! type).*from ['"](?:node:(?!crypto)|.*(?:store|finding-ledger)\.js)/m.test(source)) issues.push('pure route/progress IO import');
  for (const [source, markers] of [[route, ['receiptSubjectDigest', 'assertReceiptCurrent', 'evidenceAuthority', 'target_route_semantic_only']],
    [progress, ['assertProjectionSubject', 'verifyIdentityEnvelope', 'assertProgressTransition', 'predecessorBaselineDigest', 'target signer mismatch']],
    [handler, ['withIdentityLedgerLocks', 'verifyAssessmentProposal', 'proposalScopeDigest', 'proposalFindingHash', 'baselineSetForReceipt', 'execution predates', 'sourceRouteRecord']]]) {
    for (const marker of markers) if (!source.includes(marker)) issues.push(`route/progress guard ${marker}`);
  }
  if (!policy.includes('gateEvidence: false') || !policy.includes("lifecycleAuthority: 'none'")) issues.push('route gate authority');
  if (/\.(?:writeFindings|writeStory|finding_dismiss|finding_resolve)\s*\(/.test(handler)) issues.push('route handler mutates lifecycle');
  return issues;
}
const routeSources = [read('packages/main/src/core/finding-route.ts'), read('packages/main/src/core/finding-progress.ts'),
  read('packages/main/src/handlers/finding-route.ts'), read(processFactRegistryPath).split('export const PROCESS_FACT_STORY2_ROUTE_POLICY =')[1]?.split('} as const;')[0] ?? ''];
for (const issue of routeBoundaryIssues(...routeSources)) fail(`Story2 route boundary: ${issue}`);
for (const [index, marker] of [[0, 'assertReceiptCurrent'], [1, 'assertProjectionSubject'], [1, 'verifyIdentityEnvelope'], [2, 'verifyAssessmentProposal'], [2, 'withIdentityLedgerLocks'], [3, 'gateEvidence: false']]) {
  const mutation = [...routeSources]; mutation[index] = mutation[index].replaceAll(marker, 'REMOVED_GUARD');
  assert(routeBoundaryIssues(...mutation).length > 0, `Story2 route verifier must detect removal of ${marker}`);
}
function historyBoundaryIssues(core, handler, store, policy) {
  const issues = [];
  if (/^import(?! type).*from ['"](?:node:(?!crypto)|.*(?:store|finding-ledger)\.js)/m.test(core)) issues.push('pure history IO import');
  for (const [source, markers] of [[core, ['validateHistoryGraph', 'indexDigest', 'canonicalCurrent']],
    [handler, ['withIdentityCatalogLock', 'triggerDigest', 'verifiedIdentityCarrier', 'currentConsent']],
    [store, ['strictMirror: true', 'historicalFindingRef']], [policy, ['gateEvidence: false', "lifecycleAuthority: 'none'"]]]) {
    for (const marker of markers) if (!source.includes(marker)) issues.push(`missing ${marker}`);
  }
  return issues;
}
const historySources = [read('packages/main/src/core/finding-history.ts'), read('packages/main/src/handlers/finding-history.ts'),
  read('packages/main/src/handlers/finding-identity-store.ts'), read(processFactRegistryPath).split('export const PROCESS_FACT_STORY2_HISTORY_POLICY =')[1]?.split('} as const;')[0] ?? ''];
for (const issue of historyBoundaryIssues(...historySources)) fail(`Story2 history boundary: ${issue}`);
for (const [index, marker] of [[0, 'validateHistoryGraph'], [1, 'triggerDigest'], [1, 'verifiedIdentityCarrier'], [2, 'strictMirror: true'], [3, 'gateEvidence: false']]) {
  const mutation = [...historySources]; mutation[index] = mutation[index].replaceAll(marker, 'REMOVED_GUARD');
  assert(historyBoundaryIssues(...mutation).length > 0, `Story2 history verifier must detect removal of ${marker}`);
}
// Independent Story2 gate-isolation matrix. Inspect actual declarations rather
// than deriving expectations from the policy being checked, then mutate each axis.
const story2ReadCommands = ['finding_candidate_get', 'finding_identity_query', 'finding_history_query', 'finding_route_verify', 'finding_identity_scorecard'];
const story2ReviewCommands = ['finding_candidate_promote', 'finding_identity_confirm', 'finding_supersession_add', 'finding_identity_supersede'];
const story2OwnerCommands = ['finding_candidate_add', 'finding_candidate_merge', 'finding_candidate_disprove', 'finding_route_accept', 'finding_route_reject',
  'finding_route_revoke', 'finding_candidate_route', 'finding_progress_capture', 'finding_progress_predecessor', 'finding_history_recall'];
function staticDeclaration(source, name) {
  const parsed = ts.createSourceFile('contract.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); let found;
  const value = node => {
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) return value(node.expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(value);
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.filter(ts.isPropertyAssignment).map(row => [row.name.getText(parsed).replace(/^['"]|['"]$/g, ''), value(row.initializer)]));
    return undefined;
  };
  const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name && node.initializer) found = value(node.initializer); ts.forEachChild(node, visit); };
  visit(parsed); return found;
}
function story2RegistrationIssues(policySource, configSource, roleSource, registrySource) {
  const issues = []; const policies = staticDeclaration(policySource, 'COMMAND_POLICIES') ?? {};
  const phases = staticDeclaration(configSource, 'DEFAULT_PHASE_TOOLS') ?? {}; const roles = staticDeclaration(roleSource, 'CANDIDATE_MUTATION_POLICIES') ?? {};
  const all = [...story2ReadCommands, ...story2ReviewCommands, ...story2OwnerCommands];
  for (const command of all) {
    const row = policies[command]; const readOnly = story2ReadCommands.includes(command); const reviewer = story2ReviewCommands.includes(command);
    const targetCommand = ['finding_route_accept', 'finding_route_reject', 'finding_route_revoke', 'finding_progress_capture'].includes(command);
    const expectedPhases = readOnly ? 'all' : reviewer ? ['REVIEW'] : targetCommand ? ['INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST'] : ['DEV', 'REVIEW', 'TEST'];
    if (!row || row.status !== 'supported' || row.gateEvidence === true || row.ownershipClass !== (readOnly ? 'readOnly' : reviewer ? 'reviewerWrite' : 'storyScopedMutating')
      || JSON.stringify(row.allowedPhases) !== JSON.stringify(expectedPhases)) issues.push(`command policy ${command}`);
    for (const phase of ['INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE']) {
      const actual = [...(phases['*'] ?? []), ...(phases[phase] ?? [])].includes(command);
      if (actual !== (readOnly || expectedPhases.includes(phase))) issues.push(`phase allowlist ${command}/${phase}`);
    }
  }
  for (const command of Object.keys(roles).filter(command => all.includes(command))) {
    if (roles[command].reviewerOnly !== story2ReviewCommands.includes(command)
      || JSON.stringify(roles[command].phases) !== JSON.stringify(story2ReviewCommands.includes(command) ? ['REVIEW'] : ['DEV', 'REVIEW', 'TEST'])) issues.push(`role authority ${command}`);
  }
  const registeredKinds = [];
  for (const name of ['CANDIDATE', 'ROUTE', 'HISTORY', 'SCORECARD']) {
    const policy = staticDeclaration(registrySource, `PROCESS_FACT_STORY2_${name}_POLICY`);
    registeredKinds.push(...(policy?.recordTypes ?? []));
    if (!policy || policy.gateEvidence !== false || policy.lifecycleAuthority !== 'none'
      || !Array.isArray(policy.allowedConsumers) || policy.allowedConsumers.some(command => !all.includes(command))) issues.push(`direct gate consumer ${name}`);
  }
  const expectedKinds = ['detector_signal', 'candidate', 'candidate_reproduction_attestation', 'canonical_defect', 'canonical_revision', 'route_receipt', 'candidate_route', 'progress_baseline',
    'progress_baseline_set', 'progress_evidence', 'progress_predecessor', 'finding_supersession', 'canonical_defect_supersession', 'history_recall'];
  if (JSON.stringify([...registeredKinds].sort()) !== JSON.stringify(expectedKinds.sort())) issues.push('complete exact semantic kind inventory');
  return issues;
}
const story2Registration = [read('packages/main/src/core/command-policy.ts'), read('packages/main/src/core/config.ts'),
  read('packages/main/src/core/agent-dispatch-registry.ts'), read(processFactRegistryPath)];
for (const issue of story2RegistrationIssues(...story2Registration)) fail(`Story2 registration: ${issue}`);
for (const [index, before, after] of [
  [0, "finding_identity_scorecard: { status: 'supported'", "finding_identity_scorecard: { status: 'gateEvidence', gateEvidence: true"],
  [1, "'finding_identity_scorecard',", "'removed_scorecard',"],
  [2, "finding_candidate_promote: { phases: ['REVIEW'], reviewerOnly: true }", "finding_candidate_promote: { phases: ['DEV'], reviewerOnly: false }"],
  [3, "allowedConsumers: ['finding_identity_scorecard']", "allowedConsumers: ['storyMachine.canPassReview']"],
]) {
  const changed = [...story2Registration]; changed[index] = changed[index].replace(before, after);
  assert(changed[index] !== story2Registration[index], `Story2 mutation target ${before} exists`);
  assert(story2RegistrationIssues(...changed).length > 0, `Story2 verifier rejects independent axis ${index}`);
}
for (const kind of ['detector_signal', 'candidate', 'candidate_reproduction_attestation', 'canonical_defect', 'canonical_revision', 'route_receipt', 'candidate_route', 'progress_baseline',
  'progress_baseline_set', 'progress_evidence', 'progress_predecessor', 'finding_supersession', 'canonical_defect_supersession', 'history_recall']) {
  const mutation = [...story2Registration];
  const start = mutation[3].indexOf('export const PROCESS_FACT_STORY2_CANDIDATE_POLICY');
  const end = mutation[3].indexOf('export const PROCESS_FACT_STORY2_SCORECARD_POLICY');
  const slice = mutation[3].slice(start, end).replace(`'${kind}'`, "'unregistered_kind'");
  mutation[3] = mutation[3].slice(0, start) + slice + mutation[3].slice(end);
  assert(story2RegistrationIssues(...mutation).length > 0, `Story2 independently rejects missing semantic kind ${kind}`);
}
function story2DependencyIssues(source) {
  const issues = []; const parsed = ts.createSourceFile('story2.ts', source, ts.ScriptTarget.Latest, true);
  const visit = node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && /(?:dynamic-finding-blocking|finding-(?:assessment|triage|deferral|mandatory-repair|rollout|ledger-runtime-smoke|ledger-enforce))/.test(node.moduleSpecifier.text)) issues.push('Story1/3B dependency');
    if (ts.isCallExpression(node) && /^(?:readJson|readJsonCandidate)$/.test(ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(parsed))) issues.push('protected parser');
    ts.forEachChild(node, visit);
  }; visit(parsed); return issues;
}
for (const file of ['core/finding-identity.ts', 'core/finding-history.ts', 'core/finding-route.ts', 'core/finding-progress.ts',
  'handlers/finding-identity.ts', 'handlers/finding-identity-store.ts', 'handlers/finding-history.ts', 'handlers/finding-route.ts']) {
  const source = read(`packages/main/src/${file}`);
  for (const issue of story2DependencyIssues(source)) fail(`Story2 ${file}: ${issue}`);
  for (const injection of ["import { gate } from './finding-deferral.js';", "import { enforce } from './finding-ledger-runtime-smoke.js';", "store.readJson(storyId, 'findings.json');"]) {
    assert(story2DependencyIssues(`${source}\n${injection}`).length > 0, `Story2 dependency verifier detects ${injection}`);
  }
}
const currentStory2Validation = JSON.parse(read('proof-or-stop.config.json')).validate.commands;
const expectedStory2Validation = [
  { command: 'node', args: ['packages/main/dist/tasks/finding-identity-lineage-smoke.js', '--section=delivery'], timeoutMs: 600000 },
  { command: 'node', args: ['packages/main/tests/red/red-b03b7-identity-lineage.mjs'], timeoutMs: 180000 },
];
for (const frozenCommand of expectedStory2Validation) {
  assert(currentStory2Validation.some(current => {
    const { resources: _currentResources, ...currentCommand } = current;
    return JSON.stringify(currentCommand) === JSON.stringify(frozenCommand)
      && JSON.stringify(current.resources) === JSON.stringify([
        { class: 'fixed-path', key: '.proof-or-stop/runtime/validate-plan-barrier', access: 'exclusive' },
        { class: 'git-common-dir', key: '.', access: 'shared' },
      ]);
  }), 'Story2 preserves each frozen validation command and declares the exact merged exclusive validation barrier without widening concurrency');
}
assert(currentStory2Validation.some(row => row.command === 'node' && row.args?.includes('--section=delivery') && row.timeoutMs === 600000), 'Story2 full delivery selector has bounded measured-duration timeout');
assertCurrentPromptIdentityBoundary();
assertCapabilityMaterialContract();
assertStoryWriterRuntimeAdmissionContract();
printProcessFactLevelRegistrySummary();

console.log(`Prompt drift scan: ${reviewerPromptCount} reviewer prompt files checked`);
if (warnings.length) {
  console.log('Warnings:');
  for (const message of warnings.sort()) console.log(`- ${message}`);
}
console.log('');
console.log('Process Fact Inventory');
let inventoryFileCount = 0;
for (const entry of inventory) {
  if (!quiet) console.log(`- ${entry.name}`);
  for (const file of entry.files) {
    assertFilePatterns(entry.name, file.relPath, file.patterns);
    inventoryFileCount += 1;
    if (!quiet) console.log(`  ${file.relPath}`);
  }
}
if (quiet) console.log(`- entries: ${inventory.length} (${inventoryFileCount} files checked)`);

// Hash input exclusions must retain the independent integrity boundary.
assert(read(processFactRegistryPath).includes('...PROCESS_FACT_EVIDENCE_HASH_INPUTS'), 'Evidence hash input facts must be registered');
const hashPolicySource = read('packages/main/src/core/material-path-policy.ts');
for (const boundary of ['objects/sha256/', 'refs/by-id/', 'ledger/observed.jsonl']) assert(hashPolicySource.includes(boundary), `Missing bounded evidence output location: ${boundary}`);
assert(read('packages/main/src/core/story-git-bytes.ts').includes("'--name-status', '-z'") && read('packages/main/src/core/story-aware-validation.ts').includes("raw.diff.split('\\0')"), 'Story diff must preserve NUL-framed Git filenames');
assert(read('packages/main/src/tasks/story-files-hash-batch-smoke.ts').includes('verify-hash-accuracy.mjs'), 'Independent hash oracle must run in the existing validation inventory');

// Owner/UI delivery observes the authoritative runtime through a public adapter.
assert(read('packages/main/src/handlers/graph.ts').includes('readManagedRunDashboard(probe.root!)'), 'Graph must wire real managed runtime observations');
assert(read('packages/graph/src/shells/web/app.js').includes('renderManagedRunStatus(st)'), 'Graph status polling must render managed changes independently');


assert(read('packages/main/src/handlers/verifier.ts').includes('dynamicValidationPreflightFallbackReasons(projectRoot, dynamic)'), 'dynamic rejection preflight must guard real validation launch');
assert(read('packages/main/src/handlers/validation-pass-admissibility.ts').includes('storedDynamicReceiptIntegrityReasons'), 'TEST admissibility must recheck stored dynamic receipt integrity');
if (failures.length) {
  console.error('');
  console.error('Process fact contract failed:');
  for (const message of failures.sort()) console.error(`- ${message}`);
  process.exit(1);
}

console.log('');
console.log('Process fact contract verified');
console.log('execution_assertion_reuse_contract=PASS');
console.log('Process-fact contract verification passed');

// U11 tool-owned progress must stay bound to real inventory and evidence verifiers.
{
  const progress = read('packages/main/src/core/convergence-progress-journal.ts');
  for (const token of ['verifyValidationArtifact', 'signValidationArtifact', 'finalizedLiveAggregateError', 'readFindingLedger', 'buildVerificationCoverage', 'collectReviewerEvidenceState', 'revokedCompletedEpochIds', 'assessEffectiveProgress', 'hasMechanicalExecutionAuthority', 'captureEvidenceHashSnapshot']) {
    assert(progress.includes(token), `U11 progress authority missing ${token}`);
  }
  assert(read('packages/main/src/handlers/review-inventory.ts').includes('captureConvergenceProgress(ctx, args.storyId, finalized.epochId)'), 'U11 actual inventory finalization must record verified progress');
  assert(read('packages/main/src/core/process-fact-registry.ts').includes('artifact:convergence-progress.json'), 'U11 signed progress artifact must be registered');
  assert(read('packages/main/src/handlers/finding.ts').includes('reviewPurpose: run.reviewPurpose, inventoryBinding: run.inventoryBinding'), 'native direct terminal authority must retain the signed review purpose');
}

assert(read('packages/main/src/handlers/review-remediation.ts').includes('hasMechanicalExecutionAuthority'), 'remediation and progress must share exact mechanical execution authority');

// U11 hard gates and human decisions share one authority boundary.
for (const path of ['packages/main/src/core/convergence-breaker.ts', 'packages/main/src/core/review-convergence.ts']) {
  assert(read(path).includes('assessConvergenceProgressGate'), `${path}: shared effective-progress gate missing`);
}
assert(read('packages/main/src/core/machine.ts').includes('return convergenceProgressUnavailable(error)'), 'machine must convert progress integrity failures into explicit blocked results');
assert(read('packages/main/src/handlers/story.ts').includes('acknowledgeConvergenceProgress'), 'human resume must reset signed epoch authority');
assert(read('packages/main/src/core/convergence-progress-journal.ts').includes('humanDecisions: [...'), 'human decisions must append signed history');
assert(read('packages/main/src/handlers/stall-adjudication.ts').includes('does not clear the completed-epoch convergence gate'), 'compatibility decisions must not claim new gate authority');
assert(read('packages/main/src/core/managed-burn-guard.ts').includes("progress.code === 'effective_progress_stalled'"), 'burn stop requires the exact verified progress verdict, never generic integrity failure');
assert(read('packages/main/src/core/managed-host-run.ts').includes('onProviderUsage: usage =>'), 'managed burn must use canonical provider usage observations');

assert(read('packages/main/src/core/process-fact-registry.ts').includes('artifact:prompt-bodies'), 'prompt CAS process artifact must be registered');
assert(read('packages/main/src/handlers/review-run.ts').includes('assembledPromptRef: store.writeReviewPromptBody'), 'review-run producer must persist exact prompt CAS before references');
for (const path of ['packages/main/src/core/review-run.ts', 'packages/main/src/core/review-incremental-context.ts', 'packages/main/src/core/managed-review-evidence.ts']) {
  assert(read(path).includes('.readReviewPrompt('), `${path}: prompt authority must explicitly hydrate body references`);
}

const reviewRunCasVerifier = read('packages/main/src/core/review-run.ts');
for (const token of ["'assembledPromptRef'", 'run.assembledPromptRef === run.promptHash', 'readReviewPromptBody(promptStore.storyDirPath(run.storyId), run)', 'reviewRunPromptUsesCurrentIdentityFamily(run, body)']) {
  assert(reviewRunCasVerifier.includes(token), `review run CAS authority contract missing: ${token}`);
}
assert(read('scripts/verify-review-run-prompt-cas.mjs').includes('missing physical body refused'), 'review run CAS requires real missing-body and signature regression coverage');

assert(read('packages/main/src/core/prompt-body-gc.ts').includes('withReviewInventoryMutationLock') && read('packages/main/src/core/prompt-body-gc.ts').includes('withReviewMetadataTicketLock'), 'prompt GC must serialize with prompt publication');
assert(read('packages/main/src/handlers/review-inventory.ts').includes('collectOrphanPromptBodies'), 'prompt GC must have a registered production consumer');

for (const path of ['packages/main/src/handlers/finding.ts', 'packages/main/src/handlers/managed-review-evidence.ts']) {
  assert(read(path).includes('commitReviewResultMetadata'), `${path}: native and managed results must share epoch commit deferral`);
}
assert(read('packages/main/src/core/review-metadata-batch.ts').includes('commitImmutableMetadataTree'), 'epoch commits must preserve isolated-index exact manifest and HEAD CAS semantics');

assert(/prior\.run\.storyFilesHash,\s*asOfRef,/.test(read('packages/main/src/core/review-incremental-context.ts')), 'historical freshness must use the requested as-of commit');
assert(read('packages/main/src/core/review-run.ts').includes('!liveFreshness.fresh || !liveFreshness.currentHead'), 'requested-full verifier must retain explicit live freshness');

assert(read('packages/main/src/core/review-run.ts').includes('!liveFreshness.currentMaterialHash'), 'requested-full current material must be measurable, not merely a readable HEAD');

assert(read('packages/main/src/core/process-fact-registry.ts').includes("name: 'managed-terminal-supervision'"), 'autonomous terminal supervision must remain a registered execution fact');
assert(read('scripts/verify-managed-autonomous-supervisor.mjs').includes('orphaned worker must converge without status polling'), 'autonomous orphan recovery requires a no-status-polling witness');
assert(/host_run_status: \{[^\n]*ownershipClass: 'readOnly'[^\n]*destructiveRisk: 'none'/.test(read('packages/main/src/core/command-policy.ts')), 'managed status must remain read-only without owner lease mutation');
assert(read('scripts/verify-managed-status-readonly.mjs').includes('status observation must not write runtime files'), 'managed observation requires a filesystem non-mutation witness');
assert(read('scripts/verify-managed-provider-missing.mjs').includes("process.kill(workerPid,'SIGSTOP')"), 'missing-provider diagnostics require a real live-worker disappearance witness');
assert(read('packages/main/src/core/managed-host-run.ts').includes("type:'provider_closed'"), 'provider close must be a durable event before asynchronous finalization');
for (const file of ['packages/main/src/handlers/agent-prompt.ts', 'packages/main/src/core/prompt-role-contract-registry.ts']) {
  const source = read(file);
  assert(!source.includes('purposeSelectedCriticBody') && !source.includes('resolvePromptTemplateBody'), `${file} must consume prompt projection rather than reconstructing selected role bodies`);
}
assert(read('packages/main/src/core/prompt-registry.ts').includes('export function projectPromptAsset('), 'host assets and reviewer contract bodies share one projection boundary');
const {scanPromptProjectionConsumers} = await import('./prompt-projection-contract.mjs');
assert(scanPromptProjectionConsumers('packages/main/src').length === 0, 'all production prompt consumers must satisfy the projection contract');

assert(read('packages/main/src/handlers/validation-pass-admissibility.ts').includes('verifyTestValidationEvidence'), 'TEST admission must authenticate the complete PASS before selecting its verification mode');
assert(read('packages/main/src/handlers/verifier.ts').includes('dynamicCoverageAdmitted'), 'dynamic aggregate reuse must consume verified logical coverage without altering actual execution counts');


// Canonical journal authority is checked at both producer and consumer, including
// authentic signed old-domain negatives (not merely broken-signature fixtures).
{
  const schema = read('packages/main/src/core/artifact-schema.ts');
  for (const [name, value] of [
    ['ACCEPTANCE_AMENDMENT_ENTRY_SCHEMA', 'proof-or-stop.acceptance_amendment.v1'],
    ['ACCEPTANCE_AMENDMENT_JOURNAL_SCHEMA', 'proof-or-stop.acceptance_amendments.v1'],
    ['EFFECTIVE_PROGRESS_SCHEMA', 'proof-or-stop.effective_progress.v1'],
    ['CONVERGENCE_PROGRESS_JOURNAL_SCHEMA', 'proof-or-stop.convergence_progress_journal.v1'],
  ]) assert(schema.includes(`export const ${name} = '${value}' as const`), `Canonical journal constant missing ${name}`);
  const amendment = read('packages/main/src/core/acceptance-amendment-journal.ts');
  for (const token of ['schemaVersion: ACCEPTANCE_AMENDMENT_ENTRY_SCHEMA', 'schemaVersion: ACCEPTANCE_AMENDMENT_JOURNAL_SCHEMA',
    'entry.schemaVersion !== ACCEPTANCE_AMENDMENT_ENTRY_SCHEMA', 'journal.schemaVersion !== ACCEPTANCE_AMENDMENT_JOURNAL_SCHEMA',
    'verifyValidationArtifact(journalClaims, journalSignature, root)', 'verifyValidationArtifact(claims, signature, root)'])
    assert(amendment.includes(token), `Amendment canonical signed boundary missing ${token}`);
  const progress = read('packages/main/src/core/convergence-progress-journal.ts');
  for (const token of ['schemaVersion: CONVERGENCE_PROGRESS_JOURNAL_SCHEMA', 'journal.schemaVersion !== CONVERGENCE_PROGRESS_JOURNAL_SCHEMA', 'verifyValidationArtifact(claims, signature, root)', 'assessEffectiveProgress(journal.state, journal.state.snapshot)'])
    assert(progress.includes(token), `Progress canonical signed boundary missing ${token}`);
  assert(amendment.includes("assertCanonicalActiveIdentityBoundary({ boundaryId: 'canonical-journal-authority' })") && progress.includes("assertCanonicalActiveIdentityBoundary({ boundaryId: 'canonical-journal-authority' })"), 'journal business consumers must enforce identity without CLI preflight');
  const effective = read('packages/main/src/core/convergence-effective-progress.ts');
  assert(effective.includes('schemaVersion: EFFECTIVE_PROGRESS_SCHEMA') && effective.includes('prior.schemaVersion !== state.schemaVersion'), 'Nested progress must reject incompatible domains');
  const store = read('packages/main/src/core/store.ts');
  const outputReader = store.slice(store.indexOf('  causalEvidenceOutputPaths('), store.indexOf('  private recoverOrphanedCausalEvidenceReceipt('));
  assert(outputReader.includes("index.schemaVersion === 'proof-or-stop.causal-evidence-index.v1'")
    && outputReader.includes('verifyCausalEvidenceReceipt(receipt)')
    && outputReader.includes('verified.get(key) === hash'), 'CAS output exemption must match canonical writer and authenticated exact receipt map');
  const regression = read('scripts/verify-canonical-journal-authority.mjs');
  for (const token of ['executeCausalEvidence', 'execFileSync(command.executable', 'CANONICAL_INDEX_WRITER_MUST_BE_RECOGNIZED', 'controller.propose', 'recordConvergenceProgress', 'signValidationArtifact(c,root)', 'acceptanceAmendmentBlocker', 'readConvergenceProgress'])
    assert(regression.includes(token), `Canonical journal real producer regression missing ${token}`);
}
