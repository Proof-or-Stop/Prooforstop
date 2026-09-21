






import ts from 'typescript';
import nodeAssert from 'node:assert/strict';

import { read, assert, processFactLevelRegistryPath, rolePromptPath, CODEX_AGENTS_DIR, requiredProcessFactSemantics, commandPolicyPath, processFactRegistryPath, lifecycleRegistryPath } from './support.mjs';
import { parseCommandPolicyEntries, parseProcessFactLevelRegistry, processFactRegistryMap } from './registry-parser.mjs';
import { policyBlockHasOwnershipClass } from './command-contracts.mjs';
import { commandAllowedByDefaultConfig } from './registry-alignment.mjs';
import { parseSourceFile, findFunctionDeclaration, hasTestEntryAnchoredComparison, hasPropertyGuardedThrowingBranch, subtreeReferencesProperty } from './source-analysis.mjs';

export function assertProofStoryProgressiveBoundary() {
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
  const dirtyWorktreeText = read('packages/main/src/core/dirty-worktree.ts');
  const externalWorktreeSmokeText = read('packages/main/src/tasks/external-worktree-go-pre-review-smoke.ts');
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
      && preReviewText.includes('evaluateRegisteredCommandEvidence')
      && preReviewText.includes("verificationProfile === 'go-command'")
      && acceptanceDiscoveryText.includes("return 'go-command'")
      && read('packages/main/src/core/validation-executor.ts').includes("'go',")
      && read('packages/main/src/cli/runtime-root.ts').includes('projectControllerAssetsIntoStoryWorktree')
      && read('packages/main/src/core/controller-config-projection.ts').includes('signValidationArtifact')
      && read('packages/main/src/core/controller-config-projection.ts').includes('verifyValidationArtifact')
      && dirtyWorktreeText.includes('isByteIdenticalControllerConfig')
      && dirtyWorktreeText.includes('isByteIdenticalControllerRuntimeAsset')
      && dirtyWorktreeText.includes('trustedRuntimeArtifactMatcher')
      && dirtyWorktreeText.includes("runtimeArtifactId: 'controller-projection'")
      && externalWorktreeSmokeText.includes('valid signed controller config and hook projections must not block review_run_start')
      && read('packages/main/src/handlers/review-run.ts').includes('inspectExpectedControllerRuntimeProjection')
      && read('packages/main/src/cli-engine.ts').includes('hasRepositoryOwnedControllerAssets')
      && read('packages/main/src/cli/runtime-root.ts').includes('hasRepositoryOwnedControllerAssets')
      && read('packages/main/src/cli/runtime-root.ts').includes('controller projection refused differing repository-owned Story directories')
      && read('packages/main/src/core/runtime-artifact-registry.ts').includes('hasRepositoryOwnedControllerAssets')
      && read('packages/main/package.json').includes('test:tracked-controller-bootstrap')
      && read('scripts/verify-runtime-fact-contract.mjs').includes("join(root, 'scripts/verify-tracked-controller-bootstrap.mjs')")
      && read('packages/main/src/core/runtime-artifact-registry.ts').includes('Verify the complete controller-owned runtime projection')
      && externalWorktreeSmokeText.includes('review preflight must reject an entirely absent untracked controller runtime projection')
      && externalWorktreeSmokeText.includes('real review_run_start handler rejects an entirely absent controller projection before snapshotting')
      && externalWorktreeSmokeText.includes('review preflight must reject a single absent untracked controller hook that git status cannot observe')
      && externalWorktreeSmokeText.includes('real review_run_start handler rejects one absent untracked controller hook before snapshotting')
      && externalWorktreeSmokeText.includes('tracked hook projections remain forbidden')
      && externalWorktreeSmokeText.includes('tracked config projection remains forbidden')
      && externalWorktreeSmokeText.includes('a changed projected hook must return to fail-closed dirty classification')
      && read('packages/main/src/core/material-code-policy.ts').includes('resolveRepositoryBaseline')
      && read('packages/main/src/cli-engine.ts').includes('enforceStoryOwnerLeaseGate(cmd, parsed, controllerStore')
      && processRegistryText.includes('runtime:external_story_worktree_bootstrap_authority_gate')
      && processRegistryText.includes('runtime:repository_default_baseline_gate')
      && processRegistryText.includes('runtime:go_command_acceptance_gate')
      && processRegistryText.includes("'packages/main/src/handlers/checklist.ts'")
      && processRegistryText.includes("'packages/main/src/core/git-baseline.ts'")
      && processLevelText.includes('runtime:external_story_worktree_bootstrap_authority_gate')
      && processLevelText.includes('runtime:repository_default_baseline_gate')
      && processLevelText.includes('runtime:go_command_acceptance_gate')
      && read('docs/requirements/decisions/proofstory-acceptance-topology-and-pre-review-gates-execution-plan.md').includes('A pure Go workspace uses the')
      && read('packages/main/package.json').includes('test:external-worktree-go-pre-review')
      && read('proof-or-stop.config.json').includes('external-worktree-go-pre-review-v1')
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
  const storyReviewSource = read('packages/main/src/handlers/story-review.ts');
  const reviewGateIntentSource = read('packages/main/src/core/review-gate-verification-intent.ts');
  assert(storyReviewSource.includes('reviewGateVerificationIntentIssue(intent)') && reviewGateIntentSource.includes('review_gate_as_verification_intent'), 'story-review.ts: PLAN review must consume the shared REVIEW lifecycle-verdict classifier');
  const storyCreateIntentGuards = read('packages/main/src/handlers/story-create.ts').match(/assertNoReviewGateVerificationIntent\(\s*'story_create'/gu) ?? [];
  assert(storyCreateIntentGuards.length >= 2, 'story-create.ts: direct and from-draft Story intake must reject REVIEW lifecycle verdicts before persistence');
  const checklistIntentWriters = read('packages/main/src/handlers/checklist.ts');
  assert(checklistIntentWriters.includes("assertNoReviewGateVerificationIntent('checklist_add'") && checklistIntentWriters.includes("assertNoReviewGateVerificationIntent('checklist_update'") && checklistIntentWriters.includes("assertNoReviewGateVerificationIntent('verification_intent_append'"), 'checklist.ts: PLAN add/replacement and DEV append writers must reject REVIEW lifecycle verdicts before persistence');
  assert(read('packages/main/src/handlers/testintent-handoff.ts').includes('Do not encode REVIEW lifecycle results from review_pass_set or finding_add as verificationIntent'), 'testintent handoff: prompt guidance must prohibit the same REVIEW lifecycle dependency that story_review rejects');
  assert(read('packages/main/src/core/process-fact-registry.ts').includes('runtime:review_gate_intent_cycle_rejection'), 'process-fact registry: REVIEW lifecycle intent-cycle rejection must remain registered');
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
  {
    const managedImportSource = read('packages/main/src/handlers/managed-review-evidence.ts');
    assert(managedImportSource.includes('export function runManagedReviewCandidatePreflight')
      && managedImportSource.includes('export function hasPersistedManagedReceiptEvidence')
      && managedImportSource.includes('const intake = runManagedReviewCandidatePreflight({')
      && managedImportSource.includes('hasPersistedManagedReceiptEvidence(ctx.store, managedRun.storyId, receiptId)')
      && managedImportSource.includes('assertCurrentCandidateReadBinding(proposal);'),
    'managed review import: executable stale-candidate preflight, crash-recovery bypass and lock-held recheck must remain wired');
    assert(read('packages/main/src/core/process-fact-registry.ts').includes('A fresh intake rejects a stale sealed candidate read binding before expensive receipt and proposal intake'),
      'process-fact registry: managed candidate stale fast-failure ordering must remain registered');
  }
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

export function assertProofStoryGateConsumedFacts() {
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

export function assertCloseoutTrustBoundary() {
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
    rolePromptPath('packages/main/templates/agents', 'proof-or-stop-review-delivery'),
    rolePromptPath(CODEX_AGENTS_DIR, 'proof-or-stop-review-delivery'),
    rolePromptPath('.claude/agents', 'proof-or-stop-review-delivery'),
  ]) {
    const promptText = read(promptPath);
    assert(promptText.includes(`docs/story/actives/<storyId>/${canonicalTranscriptPath}`), `${promptPath}: delivery reviewer must consume the canonical live-smoke transcript`);
    assert(!promptText.includes('evidence/transcript-diff.md'), `${promptPath}: delivery reviewer must not consume the legacy transcript-diff path`);
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
  const retiredVocabularyGuardText = ["binding-classification", "cli", "compatibility-controls", "driver", "dynamic-bindings", "dynamic-scan", "execution-controls", "file-scan", "loader-controls", "module-loaders", "positive-controls", "public-contract", "rule-data", "type-analysis"].map(name => read(`packages/main/src/tasks/retired-authority/${name}.ts`)).join('\n');
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
    '68d86faa065e9137986d20775fa8d72ab8e71af6ddf648c9ab94d48be2db7467',
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
  // Merged-source audit: origin/main d354d2b43d measured b4f27e9a, already
  // stale against the old b9eb52d0 pin. Candidate measures 52a283cf. The new
  // withValidationSigningRoot arrow preserves the runCli function anchor and
  // exact initPath producer/import argument. Both coupled pins move together;
  // this whole-file binding does not assert a separate loader provenance graph.
    '631ac1fde46c71126614b7ad293fedc43a79b14c166b10d2f8b7e3cd2b69d408',
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
    '19b243083de02b86b17a76c104222709b35cc223b3a5e2ad4d40ff86e99ad0ed',
    'the twelve existing exact entries plus the B-49df test-only tracer kernel pin make thirteen; no broad pattern exemptions are allowed',
    'any executable drift revokes the envelope mutation loader fingerprint',
    'mutant path rebound to external input',
    'mutant producer type widened',
    'mutant producer nested shadow',
    'mutant URL helper shadow',
    'BENIGN_NON_LITERAL_LOADER_SOURCE_FINGERPRINTS',
    '19b243083de02b86b17a76c104222709b35cc223b3a5e2ad4d40ff86e99ad0ed',
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
  const reviewRunText = read('packages/main/src/core/review-run.ts') + read('packages/main/src/core/review-test-index-transition.ts');
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
