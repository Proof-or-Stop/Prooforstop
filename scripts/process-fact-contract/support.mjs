import { readFileSync as readQuotaFactSource } from 'node:fs';
import { prepareVerification, verificationFailureMessage } from ".././verification-subprocess-budget.mjs";
import { existsSync, readFileSync } from 'node:fs';


import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import nodeAssert from 'node:assert/strict';

import { parseRegistryArrayEntriesFromSource } from './registry-parser.mjs';

export const quotaFactSource = readQuotaFactSource(new URL('../../packages/main/src/core/process-fact-registry.ts', import.meta.url), 'utf8');

if (!quotaFactSource.includes('core/provider-call-budget.ts') || !quotaFactSource.includes('Managed submissions seal quota settings') || !quotaFactSource.includes('Branded pre-spawn quota refusals') || !quotaFactSource.includes('actual armed allowance') || !quotaFactSource.includes('strips parent-only budget context')) throw new Error('SHARED_QUOTA_PROCESS_FACT_MISSING');

export const root = process.cwd();

try { prepareVerification(root, { shareBuild: true }); }
catch (error) { console.error(verificationFailureMessage('process contract prerequisite', error)); process.exit(1); }

export const quiet = process.argv.slice(2).includes('--quiet');

export const closeoutPolicyModule = await import(pathToFileURL(join(root, 'packages/main/dist/core/closeout-trust.js')).href);

export const failures = [];

export const sharedHostBudget = readFileSync(join(root, 'packages/main/src/core/host-run.ts'), 'utf8');

if (!sharedHostBudget.includes('reserveHostRunBudget(args.root, args.usageEnv ?? args.env, args.promptText)') || !sharedHostBudget.includes('settleHostRunBudget(reservation, { spawned: result.spawned, ...result.usageSummary })')) failures.push('Host runs must bind explicit shared reservations and settle actual execution outcomes');

if (!sharedHostBudget.includes('host_runner_exception_usage_unavailable')) failures.push('Throwing host transports must preserve unavailable terminal usage');

if (!sharedHostBudget.includes('exceptionUsage.push(chunk.text)')
  || !sharedHostBudget.includes('exceptionUsage.truncated')) failures.push('Throwing host transports must preserve bounded reported usage and truncation semantics');

if (!sharedHostBudget.includes('execution.runnerInvoked ? null :')
  || !sharedHostBudget.includes('budgetSettlementError: budgetSettlementDiagnostic(settlementError)')
  || !sharedHostBudget.includes('process.stderr.write(budgetSettlementDiagnostic(settlementError)')) failures.push('Shared budget must release known pre-runner refusals and preserve completed results and diagnostic causes on settlement failure');

if (!readFileSync(join(root, 'packages/main/src/core/process-fact-registry.ts'), 'utf8').includes('runtime:planned_provider_budget_admission')) failures.push('Planned provider budget admission must register its limited process authority');

export const plannedBudgetSource = readFileSync(join(root, 'packages/main/src/core/planned-steps-executor.ts'), 'utf8');

if (!plannedBudgetSource.includes('budgetMeter.providerAllowance(attempts, timeoutMs)') || !plannedBudgetSource.includes('providerAttempts: result.attempts')) failures.push('Planned provider admission must constrain transport and meter actual retry attempts');

if (!plannedBudgetSource.includes('}, result.attempts);')) failures.push('Post-transport spawn failures must preserve actual provider attempts');

export const readonlyLaneSources = ['packages/main/src/core/managed-review-lane.ts','packages/main/src/core/managed-review-lane-build.mjs','packages/main/src/core/managed-review-lane-policy.ts'];

for (const path of readonlyLaneSources) if (!existsSync(join(root,path))) failures.push(`Missing managed readonly source ${path}`);

export const readonlyManagedSource=readFileSync(join(root,'packages/main/src/core/managed-host-run.ts'),'utf8');

export const crossHostReadonlySource=readFileSync(join(root,'packages/main/src/handlers/cross-host-review.ts'),'utf8');

if (!readonlyManagedSource.includes('verifyManagedReviewLane(spec.crossHostReadonlyLane, expected)')
  || !readonlyManagedSource.includes('crossHostReadonlyLane = await createManagedReviewLane')
  || !crossHostReadonlySource.includes('prepareManagedSingletonAdmission')
  || !crossHostReadonlySource.includes('!requestedManagedRunId')) failures.push('Cross-host readonly lane requires sealed worker verification and fresh-run pre-snapshot preflight');

if (!readonlyManagedSource.includes('verifyManagedReviewLane(scratch.readonlyLane, scratch)')
  || !readonlyManagedSource.includes('readonlyLane: await createManagedReviewLane')) failures.push('Managed readonly source/build binding must be sealed and consumed');

if (!readFileSync(join(root,'packages/main/src/core/process-fact-registry.ts'),'utf8').includes('runtime:managed_review_readonly_build')) failures.push('Managed readonly build process semantics must be registered');

export const managedReviewEvidenceSource=readFileSync(join(root,'packages/main/src/core/managed-review-evidence.ts'),'utf8');

export const managedReadonlyRegistrySource=readFileSync(join(root,'packages/main/src/core/process-fact-registry.ts'),'utf8');

if (!readonlyManagedSource.includes('const executionCwd = join(parent, MANAGED_REVIEW_LANE_ARTIFACT.executionWorktree)')
  || !readonlyManagedSource.includes('currentMaterialHash(scratch.executionCwd)')
  || !readonlyManagedSource.includes('cwd: managedReviewScratch?.executionCwd ?? managedReviewScratch?.cwd ?? args.cwd')
  || !readonlyManagedSource.includes('scratch.sourceDirectoryIdentity = managedReviewScratchPathIdentity')
  || !readonlyManagedSource.includes('MANAGED_REVIEW_LANE_ARTIFACT.scratchAdminMarker')
  || (readonlyManagedSource.match(/assertManagedReviewScratchGenerationIdentity\(scratch, registered\)/g) ?? []).length < 2
  || !managedReviewEvidenceSource.includes('$PROOF_OR_STOP_REVIEW_EXECUTION_CWD')
  || !managedReadonlyRegistrySource.includes('distinct same-HEAD disposable execution worktree')) {
  failures.push('Managed review generated-file execution must use a registered same-HEAD disposable worktree with tracked-material enforcement');
}

export const warnings = [];

export const hanCharacterPattern = /[\u3400-\u9fff]/;

export const codeLikeCommandNamePattern = /^[a-z][a-z0-9_.-]*(?::[a-z][a-z0-9_.-]*)*$/;

export const artifactFactNamePattern = /^artifact:[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/;

export const CODEX_AGENTS_DIR = '.proof-or-stop-codex/agents';

export function canonicalRoleId(roleId) {
  return String(roleId).replace(/\.md$/, '');
}

export function capabilityMaterialContractErrors(source) {
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

export function assertCapabilityMaterialContract() {
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

export function rolePromptPath(directory, roleId) {
  return `${directory}/${canonicalRoleId(roleId)}.md`;
}

export function reviewerLaneEntry(registry, roleId) {
  return registry.get(`reviewer-lane:${canonicalRoleId(roleId)}`);
}

export const promptDirs = [
  'packages/main/templates/agents',
  '.claude/agents',
  CODEX_AGENTS_DIR,
];

export const currentCategories = new Set(['happy', 'edge', 'adversarial', 'missing']);

export const legacyCategories = new Set(['cleanup', 'doc-promise-undelivered', 'doc-code-drift', 'spec-boundary']);

export const reviewPassReviewerPrompts = new Set([
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

export const requiredReviewerRunIdPromptFiles = new Set([
  'proof-or-stop-evaluator.md',
  'proof-or-stop-review-delivery.md',
  'proof-or-stop-review-scope-plan.md',
  'proof-or-stop-review-story-init.md',
]);

export const modularReviewerBootstrapFiles = new Set([
  'proof-or-stop-review-behavior.md',
  'proof-or-stop-review-concept.md',
  'proof-or-stop-review-docs.md',
  'proof-or-stop-review-quality.md',
  'proof-or-stop-review-test-coverage.md',
]);

export const processFactLevelRegistryPath = 'packages/main/src/core/process-fact-levels.ts';

export const commandPolicyPath = 'packages/main/src/core/command-policy.ts';

export const flowFactPolicyPath = 'packages/main/src/core/flow-fact-policy.ts';

export const lifecycleRegistryPath = 'packages/main/src/core/lifecycle-registry.ts';

export const machinePath = 'packages/main/src/core/machine.ts';

export const doneOraclePath = 'packages/main/src/core/done-oracle.ts';

export const legacyTestFixtureCommands = [
  'test_auto',
  'test_story',
  'test_fixture',
  'fixture_batch_add',
  'fixture_update',
  'test_add',
  'task_coverage',
];

export const activeLifecycleDocPaths = [
  'AGENTS.md',
  'docs/requirements/decisions/story-lifecycle.md',
  'docs/requirements/decisions/testing-infra.md',
];

export const validatePrimaryReferenceDocPaths = [
  'docs/requirements/decisions/dev-memory.md',
  'docs/requirements/decisions/host-neutral-observability-console.md',
  'docs/requirements/decisions/truth-source.md',
];

export const verificationCapabilitySource = readFileSync(join(root, 'packages/main/src/tasks/verification-run-and-guard/cli.ts'), 'utf8');

for (const marker of ['VERIFICATION_CAPABILITIES', 'Unknown verification capability', 'Unknown verification argument',
  'new Set<string>()', 'VERIFICATION_PARTIAL_PASS', 'full: false', 'runShardedVerification']) {
  if (!verificationCapabilitySource.includes(marker)) failures.push(`Verification capability contract missing: ${marker}`);
}

if (!readFileSync(join(root, 'packages/main/src/core/process-fact-registry.ts'), 'utf8').includes('runtime:verification_capability_selection')) failures.push('Verification capability selection is not registered');

export const verificationReceiptModelPaths = [
  'docs/requirements/decisions/verification-execution-receipt-fanout-and-input-scoped-freshness.md',
  'packages/main/src/core/process-fact-levels.ts',
  'packages/main/src/core/runtime-fact-registry.ts',
  'packages/main/src/core/types.ts',
  'packages/main/src/tasks/certification-window-smoke.ts',
  'packages/main/src/tasks/verification-run-and-guard-smoke.ts',
  'packages/main/src/tasks/verification-run-and-guard/support.ts',
  'packages/main/src/tasks/verification-run-and-guard/foundation.ts',
  'packages/main/src/tasks/verification-run-and-guard/refresh.ts',
  'packages/main/src/tasks/verification-run-and-guard/integrity.ts',
  'packages/main/src/tasks/verification-run-and-guard/causal.ts',
  'packages/main/src/tasks/verification-run-and-guard/publication.ts',
  'packages/main/src/tasks/verification-run-and-guard/cli.ts',
];

export const bundleV3SubjectPattern = String.raw`(?:VerificationReceiptBundleV3|Bundle\s*V3|V3\s+(?:receipt\s+)?bundle)`;

export const positiveCurrentBundleV3Patterns = [
  new RegExp(String.raw`\b${bundleV3SubjectPattern}\b[^.!?;]{0,180}\b(?:is|remains|continues\s+to\s+be|serves\s+as)\s+(?:still\s+)?(?:the\s+)?(?:current|authoritative|admissible|eligible)\b`, 'i'),
  new RegExp(String.raw`\b${bundleV3SubjectPattern}\b[^.!?;]{0,180}\b(?:can|may)\s+(?:still\s+)?(?:satisfy\s+lifecycle\s+admission|authorize\s+reuse)\b`, 'i'),
  new RegExp(String.raw`\b(?:current|authoritative|admissible)\s+(?:receipt\s+)?bundle\b[^.!?;]{0,100}\b(?:is|remains)\s+(?:still\s+)?(?:the\s+)?${bundleV3SubjectPattern}\b`, 'i'),
];

export const activeLifecycleDocCurrentTerms = [
  'verificationIntent',
  'verificationEvidence',
  'proof-or-stop validate',
  'checklist_update',
];

export const legacyCommandDocContextPattern = /\blegacy\b|\bcompat\b|\bmaintenance\b|兼容|维护|旧|迁移|背景|destructive/i;

export const legacyAliasDocContextPattern = /\blegacy\b|\balias\b|\bcompat\b|\bmaintenance\b|兼容|维护|旧|迁移|背景|别名|destructive/i;

export const coverageReviewerLaneName = 'proof-or-stop-review-test-coverage';

export const coverageReviewerLaneNames = [coverageReviewerLaneName, 'lattice-review-test-coverage'];

export const coverageReviewerLaneContextPattern = /reviewer|agent|lane|review\s+lane|coverage\s+reviewer|审查员|审查\s*lane|审查\s*通道|覆盖审查/i;

export const coverageReviewerCliCommandPatterns = [
  { label: 'CLI invocation', pattern: /\bproof-or-stop\s+proof-or-stop-review-test-coverage\b/i },
  { label: 'tool table row', pattern: /^\s*\|\s*`?proof-or-stop-review-test-coverage`?\s*\|/ },
  { label: 'tool bullet', pattern: /^\s*[-*]\s*`?proof-or-stop-review-test-coverage`?\s*(?:[:：-]|$)/ },
  { label: 'CLI invocation', pattern: /\blattice\s+lattice-review-test-coverage\b/i },
  { label: 'tool table row', pattern: /^\s*\|\s*`?lattice-review-test-coverage`?\s*\|/ },
  { label: 'tool bullet', pattern: /^\s*[-*]\s*`?lattice-review-test-coverage`?\s*(?:[:：-]|$)/ },
];

export const legacyTestAutoProcessFactClaimPatterns = [
  {
    label: 'auto bug management',
    pattern: /自动\s*bug\s*管理|fail\s*(?:创建|create[s]?)\s+bug|pass\s*(?:自动\s*)?(?:fix|fixed|修复|标记?|mark[s]?).{0,20}bug/i,
  },
  {
    label: 'test-evidence writes',
    pattern: /\btest_auto\b[^。.\n;；]{0,80}(?:写|write[s]?|record[s]?|生成|产出)[^。.\n;；]{0,40}(?:test-?evidence|test evidence|verificationEvidence|测试证据)|(?:test-?evidence|test evidence|verificationEvidence|测试证据)[^。.\n;；]{0,40}(?:由|by)\s*`?test_auto`?|^(?:\d+\.|-)\s*(?:写|write[s]?|record[s]?|生成|产出)[^。.\n;；]{0,40}(?:test-?evidence|test evidence|verificationEvidence|测试证据)/i,
  },
];

export const legacyTestAutoNegatedProcessFactPattern = /(?:不会|不写|不再|不能|并不|does\s+not|doesn't|do\s+not|not|never|without|no\s+longer).{0,90}(?:bug|test-?evidence|test evidence|verificationEvidence|测试证据)/i;

export const commandPolicyStatuses = new Set(['supported', 'rootOnly', 'legacy', 'retired', 'maintenance', 'gateEvidence']);

export const processFactRegistryPath = 'packages/main/src/core/process-fact-registry.ts';

export const storyRuntimeAdmissionPath = 'packages/main/src/cli/story-runtime-admission.ts';

export const localAssuranceBoundaryPattern = /local (?:assurance|admissibility|workflow evidence|host verdict|quorum|review escalation|review assurance|validation|DONE-required-validation)|proof-admissibility|receipt-bundle|quorum|admissibility/i;

export const noReleaseOrRemoteCompletionBoundaryPattern = /retired remote-completion fields|remote completion|remote-completion|release readiness|release approval|remote publish readiness/i;

export const processFactRegistryKinds = new Set([
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

export const requiredProcessFactSemantics = {
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

export const requiredRuntimeFactSemantics = {
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
  'runtime:evidence_hash_snapshot_fail_closed_gate': ['runtime-behavior', 'freshness-policy', 'workspace-binding', 'verification-evidence', 'gate-evidence'],
};

export const requiredReviewerLanes = [
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

export const requiredArtifactFacts = [
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
  { name: 'artifact:review-passes.json', path: 'review-passes.json', signed: true, signaturePattern: /signReviewPass\/verifyReviewPass; direct native records seal a registered-broker Ed25519 invocation attestation bound to exact story\/lane\/ReviewRun\/writer\/dispatch\/adapter\/host\/nonce; historical consumers select that sealed dispatch digest, preserving purpose, inventory subject, current host identity, signature and nonce-consumption checks when later waves dispatch the same lane; envelope-bound records use the versioned envelopeId-inclusive domain.*reviewRunId-inclusive records do not fall back to legacy signatures.*writerSessionId-inclusive records bind writer session provenance/ },
  { name: 'artifact:findings.json', path: 'findings.json', signed: true, signaturePattern: /signFinding\/verifyFinding; direct native records bind category\/evidenceState\/uncertaintyReason\/files\/disprovenEvidence in the signed domain, native invocation consumers select the exact sealed dispatch digest while preserving purpose, inventory subject, host, broker signature and nonce-consumption checks; open Findings still require the latest lane run, and reviewRunId-inclusive records do not fall back to legacy signatures/ },
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

export const requiredReviewLoopL4Commands = [
  'review_loop_start',
  'review_loop_iteration_add',
  'review_loop_close',
];

export const requiredReviewLoopReadOnlyCommands = [
  'review_loop_status',
  'review_loop_policy_show',
];

export const requiredDoneClosureReadOnlyCommands = [
  'done_closure',
];

export const requiredDecisionDocQuorumReadOnlyCommands = [
  'decision_doc_quorum_check',
];

export const requiredDecisionDocPromotionCommands = [
  'decision_doc_proposal',
  'decision_doc_preview',
  'decision_doc_save',
];

export const scopeContractParallelDevEntryConsumerCommands = [
  'scope_contract_set',
  'scope_contract_acknowledge',
  'scope_contract_init_from_plan',
];

export const scopeContractParallelDevEntryConsumerPattern = /parallel-decomposition DEV-entry gate/;

export const legacyCommandPolicyGuidance = {
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

export const requiredRuntimeEntries = [
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
    // B-83aa: a returned partial hash snapshot is not a verified binding.
    name: 'runtime:evidence_hash_snapshot_fail_closed_gate',
    level: 'L4',
    owner: 'core/evidence-freshness',
    line: '- runtime:evidence_hash_snapshot_fail_closed_gate [L4] owner=core/evidence-freshness gate=checkEvidenceFreshnessForGit fail-closed reader, lifecycle-readiness DONE hash rows, done-oracle evidence-hash-snapshot row, runDoneOracleGate, verifier routine validation reuse, and session_brief DONE pre-check',
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
    name: 'runtime:story_create_phase_admission_gate',
    level: 'L4',
    owner: 'handlers/story-create',
    line: '- runtime:story_create_phase_admission_gate [L4] owner=handlers/story-create gate=story_create pre-persistence lifecycle admission gate',
    rationaleTokens: ['IDEA/INIT', 'PLAN/DEV/REVIEW/TEST/DONE', 'before persistence', 'story_advance'],
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

export const requiredFlowFactPolicies = [
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

export const reviewRoundIsoDocPaths = [
  'CLAUDE.md',
  'docs/requirements/decisions/story-lifecycle.md',
  'docs/requirements/decisions/testing-infra.md',
];

export const evidenceBoundaryDocPaths = [
  'CLAUDE.md',
  'docs/requirements/decisions/testing-infra.md',
];

export const requiredEvidenceBoundaryPhrases = [
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

export const requiredControlledMutationEntries = [
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

export const processFactCommandNamePatterns = [
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

export const ALL_PHASES = ['INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE'];

export async function importBuiltModule(relPath) {
  const absPath = join(root, relPath);
  if (!existsSync(absPath)) return null;
  try {
    return await import(pathToFileURL(absPath).href);
  } catch (error) {
    warnings.push(`${relPath} could not be imported; falling back to source parsing (${error.message})`);
    return null;
  }
}

export const builtCommandPolicyModule = null;

export const builtConfigModule = null;

export const builtProcessFactRegistryModule = null;

export const passOnlyFindingAddPatterns = [
  /文档一致性检查通过/,
  /consistency check\s+PASSED/,
  /检查通过/,
  /\bno\s+findings?\b/i,
  /\bPASS(?:ED)?\b/,
];

export function fail(message) {
  failures.push(message);
}

export function warn(message) {
  warnings.push(message);
}

export function timeoutWiringFailures(source, sites = [], factories = []) {
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

export function assertEvidenceFactoryWiring(checklistSource) {
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

export function assert(condition, message) {
  if (!condition) fail(message);
}

export function assertLocalAssuranceNoReleaseBoundary(text, messagePrefix) {
  assert(
    localAssuranceBoundaryPattern.test(text),
    `${messagePrefix} must name the local assurance/admissibility boundary`,
  );
  assert(
    noReleaseOrRemoteCompletionBoundaryPattern.test(text),
    `${messagePrefix} must preserve the no-release/no-remote-completion boundary`,
  );
}

export function read(relPath) {
  const absPath = join(root, relPath);
  assert(existsSync(absPath), `${relPath} should exist`);
  if (!existsSync(absPath)) return '';
  let text = readFileSync(absPath, 'utf8');
  const mutation = process.env.PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION;
  const roleId = canonicalRoleId(basename(relPath));
  if (mutation === 'drop-red-evidence-binding-policy' && relPath === commandPolicyPath) {
    // Mutate the actual input consumed by this verifier, preserving the real
    // repository/build identity and every other source reader.
    const stripped = text.replace(/^[^\n]*\bred_evidence_binding_set:[^\n]*\n/m, '');
    nodeAssert.notEqual(stripped, text, 'w2b mutation must remove the actual policy entry');
    nodeAssert(!/\bred_evidence_binding_set:/.test(stripped), 'w2b mutation must remove exactly the named policy');
    text = stripped;
  }
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
