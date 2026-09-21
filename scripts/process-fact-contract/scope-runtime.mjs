

import { existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import nodeAssert from 'node:assert/strict';

import { parseProcessFactLevelRegistry, processFactRegistryMap, parseCommandPolicyEntries, readStringProperty, extractCliToolNames, parseProcessFactRegistry, parseProcessFactLevelDefinitions, duplicateNames } from './registry-parser.mjs';
import { root, fail, read, assert, storyRuntimeAdmissionPath, commandPolicyPath, processFactLevelRegistryPath, scopeContractParallelDevEntryConsumerCommands, scopeContractParallelDevEntryConsumerPattern, requiredRuntimeEntries, requiredControlledMutationEntries } from './support.mjs';
import { policyBlockHasOwnershipClass, assertCommandPolicyInventory, assertCertificationWindowCommandContract, assertReviewLoopCommandContract, assertDoneClosureCommandContract, assertDoneRequiredValidationCommandContract, assertAcceptanceTopologyLifecycleFilenameContract, assertDecisionDocQuorumCommandContract, findUninventoriedProcessFactCommands, isProcessFactCommandName, assertReviewAssuranceFloorContract } from './command-contracts.mjs';
import { parseSourceFile } from './source-analysis.mjs';
import { assertCommandPolicyPhaseAlignment, assertProcessFactRegistryContract, assertCrossHostReviewManagedDelegationContract, assertL4ProducerOrReplacement, extractPhaseToolEntries } from './registry-alignment.mjs';
import { assertDecisionDocPromotionCommandContract, assertReviewExecutionAuthorityContract, assertReviewRunStoryFilesHashContract, assertEvidenceHashSnapshotFailClosedContract, assertDeliveryCheckStoryFilesHashContract, assertDeliveryPromiseOutcomeContract } from './review-verification.mjs';
import { assertStory3ProcessFactContract, formatProcessFactLevelRegistryEntry } from './story3.mjs';

export async function assertLifecycleArtifactScopePolicy() {
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
    'typescript_baseline_pin_unresolved_fail_closed',
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

export function assertStrengtheningRoadmapGovernanceLedger() {
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

export function assertParentRoadmapIntentTotalityPlan() {
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

export function assertParentRoadmapTotalityRuntime() {
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
  for (const token of ['domain-separated signed selection', 'current review round', 'canonical bidirectional transitive dependency closure', 'fail closed to all active lanes', 'Required host and escalation assurance remain independent and unchanged', 'any one current pass never substitute', 'All open findings require the full active set', 'cannot themselves be narrowed', 'semantic roster basis', 'including bare runtime aliases; only proven builtins are exempt']) {
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
  for (const token of ['OPEN_FINDINGS_REQUIRE_FULL_SET', 'SOURCE_ROSTER_INCOMPLETE', 'openFindingDigest']) {
    assert(postRemediationSource.includes(token), `post-remediation selection missing finding/source-roster guard: ${token}`);
  }
  for (const file of ['handlers/reviewer-batch.ts', 'core/lifecycle-readiness.ts', 'handlers/review-inventory.ts', 'handlers/quorum-submit.ts', 'core/reviewer-status.ts']) {
    const source = read(`packages/main/src/${file}`);
    assert(source.includes('computeFinalReviewRoster') || source.includes('projectFinalReviewRoster') || source.includes('readinessReport.reviewRoster'), `review roster consumer is disconnected: ${file}`);
  }
  assert(read('packages/main/src/core/review-inventory-epoch.ts').includes('finalReviewRosterBasis(current)'), 'inventory consumption must revalidate narrowed roster semantics');
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

export function assertStoryAwareDynamicValidationRuntime() {
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
    if (fact === 'runtime:story_aware_dynamic_authority_gate') {
      assert(level?.rationale.includes('DEV, REVIEW and TEST may consume an authoritative complete execute-or-reuse inventory ledger'), 'dynamic authority must bind eligible Story phases to complete logical coverage');
      assert(level?.rationale.includes('The DONE consumer may admit that signed dynamic ledger, while explicit full and DONE-phase validation invocations remain on the complete canonical policy'), 'dynamic authority must distinguish DONE evidence consumption from DONE-phase execution');
      assert(level?.rationale.includes('DONE-required evidence stays independent'), 'dynamic authority must not replace DONE-required proof');
      assert(level?.rationale.includes('Authority risk is derived from the complete live catalog; any non-local catalog row disables low-risk dynamic authority'), 'dynamic authority risk must retain the complete live catalog floor');
      assert(level?.rationale.includes('this origin routing is not authentication, which occurs inside that evaluator'), 'dynamic DONE routing must not claim that unsigned origin classification authenticates evidence');
      assert(level?.rationale.includes('DONE routing verifies the signed selection manifest before trusting its mode'), 'dynamic DONE routing must authenticate selection mode before using it');
      assert(level?.rationale.includes('DONE routing binds that signature to the current Story identity'), 'dynamic DONE routing must bind the target Story');
    }
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
  assert(handlerText.includes('verifyValidationSelectionManifest(selection, { storyId })'), 'foreign signed observe manifests cannot suppress current Story dynamic lineage');
  assert(handlerText.includes('automatic selector changed paths are malformed'), 'malformed changed paths must yield the typed selector-context refusal');
  assert(executorText.includes('fragment.schemaVersion !== VALIDATION_RUNTIME_TRACE_POLICY.schemaVersion'), 'executor must refuse unsupported trace fragments');
  assert(executorText.includes('merged.unknownRuntimeInputs.add(value)') && !executorText.includes('...observed, unknownRuntimeInputs: []'), 'executor must preserve unknown input evidence');
  assert(handlerText.includes('boundary.readPathSchema !== VALIDATION_RUNTIME_TRACE_POLICY.schemaVersion') && handlerText.includes('sourceAuthorityPath(rel)'), 'closure must require physical trace schema and map contained relative paths');
  const signingText = read('packages/main/src/core/validation-artifact-signing.ts');
  const validationText = read('packages/main/src/core/story-aware-validation.ts');
  assert(validationText.includes("VALIDATION_RECEIPT_SCHEMA = 'proof-or-stop.validation-command-receipt.v3'"), 'dynamic reuse must reject legacy receipts without executor source observations or an executed-build binding');
  assert(validationText.includes("reasons.push('missing-executed-build-binding')") && validationText.includes('receipt.buildArtifactsDigest !== ctx.buildArtifactsHash'), 'dynamic receipts must bind the compiled artifacts their command executed and reuse must require the current build');
  assert(validationText.includes('certifiedTreesEqual(ctx.gitCwd, sourceHead, actualHead, entry, closure)') && validationText.includes('environmentDigest: declaredEnvironmentDigest(entry, ctx)'), 'cross-commit reuse must bind receipt-relative trees and effective declared environment');
  assert(handlerText.includes('!provenance.cleanBefore || !provenance.cleanAfter') && handlerText.includes('provenance.headBefore !== args.head || provenance.headAfter !== args.head'), 'receipt issuance requires executor-observed unchanged clean source at both boundaries');
  const registeredAdapterDigest = handlerText.match(/const DYN5_ADAPTER_SOURCE_DIGEST = '([a-f0-9]{64})'/)?.[1];
  assert(handlerText.includes('sourceDigest: DYN5_ADAPTER_SOURCE_DIGEST'), 'registered adapter must consume the checked digest constant');
  const registeredChildDigest = handlerText.match(/const DYN5_CHILD_ENVIRONMENT_SOURCE_DIGEST = '([a-f0-9]{64})'/)?.[1];
  assert(handlerText.includes('sourceDigest: DYN5_CHILD_ENVIRONMENT_SOURCE_DIGEST') && registeredChildDigest === createHash('sha256').update(JSON.stringify(read('packages/main/src/tasks/validation-child-environment.mjs'))).digest('hex'), 'adapter child environment dependency must retain audited source identity');
  assert(registeredAdapterDigest === createHash('sha256').update(JSON.stringify(read('packages/main/src/tasks/story-aware-validation-case-adapter.mjs'))).digest('hex'), 'registered shard adapter digest must match audited source bytes');

  assert(signingText.includes("VALIDATION_ARTIFACT_SIGNING_KEY_ID = 'validation-artifact-v1'"), 'dynamic validation provenance must retain an explicit signing key ID');
  assert(signingText.includes('ed25519:${VALIDATION_ARTIFACT_SIGNING_KEY_ID}:'), 'dynamic validation provenance must retain its Ed25519 signature prefix');
  assert(signingText.includes('git-common-dir') && signingText.includes("openSync(temporary, 'wx', 0o600)") && signingText.includes('linkSync(temporary, path)'), 'dynamic validation provenance key must retain Git-common metadata and atomic no-replace publication');
  assert(read('scripts/probe-validation-key-race-v6.mjs').includes('ALL_COLD_VALIDATION_SIGNERS_MUST_SUCCEED'), 'atomic key initialization requires a real concurrent signer witness');
  assert(validationText.includes('signValidationArtifact(value)') && validationText.includes('verifyValidationArtifact(value, signature)'), 'dynamic validation artifacts must delegate signing and verification to the trusted signer');
  assert(read('packages/main/src/handlers/story-aware-validation.ts').includes('originalOracle'), 'DYN-5 aggregate must retain complete-plan oracle equivalence evidence');

  const tierPlannerText = read('packages/main/src/core/validation-tier-planner.ts');
  assert(tierPlannerText.includes("entry.inputPatterns.every((pattern) => typeof pattern === 'string')") && tierPlannerText.includes("input.changedPaths.every((path) => typeof path === 'string')"), 'automatic promotion must validate path and pattern elements before matching');
  const tierPlanHandlerText = read('packages/main/src/handlers/validation-plan.ts');
  const validationPlanLevel = levels.find((entry) => entry.name === 'validation_plan');
  assert(validationPlanLevel?.level === 'L0', 'The read-only validation_plan explanation must remain non-authoritative L0 observation');
  for (const token of ['selectValidationTiers', 'selectAutomaticValidationTier', 'buildAutomaticValidationTierSelectionBinding', 'buildValidationImpactIndexFromCatalog', 'command_exclusion_unproven', 'snapshotDigest', 'finalAuthority: false', "selectionInputCoverage === 'complete'"]) {
    assert(tierPlannerText.includes(token), `Story-relevance tier selector must retain fail-closed token ${token}`);
  }
  assert(tierPlanHandlerText.includes('catalog: compile(discover(args.projectRoot))') && !tierPlanHandlerText.includes('return { impactIndex: args.configuredImpactIndex }'), 'validation_plan must derive ownership from the execution catalog');
  assert(tierPlanHandlerText.includes('impactIndex is deprecated and ignored'), 'validation_plan must disclose ignored legacy impact indexes');
  assert(tierPlannerText.includes("entry.policySource === 'explicit' && entry.selectionInputCoverage === 'complete'"), 'defaulted policy cannot establish complete selector ownership');
  assert(tierPlanHandlerText.includes('selectorDecisionDigest'), 'validation_plan must expose the snapshot-bound selector decision digest');
}

export function assertPromptMeasurementObservationBoundary() {
  const command = 'prompt_measurement_report';
  const catalogText = read('packages/main/src/cli/command-catalog.ts');
  const policyText = read('packages/main/src/core/command-policy.ts');
  const configText = read('packages/main/src/core/config.ts');
  const activityText = read('packages/main/src/cli/activity-policy.ts');
  const levelsText = read('packages/main/src/core/process-fact-levels.ts');
  const registryText = read('packages/main/src/registry.ts');
  const handlerText = read('packages/main/src/handlers/prompt-measurement.ts');
  const verifierText = read('scripts/prompt-baseline/cli.mjs') + '\n' + read('scripts/prompt-baseline/collection.mjs');
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

export function assertStoryWriterRuntimeAdmissionContract() {
  const admission = read(storyRuntimeAdmissionPath);
  const engine = read('packages/main/src/cli-engine.ts');
  const policy = read(commandPolicyPath);
  const processFacts = read('packages/main/src/core/process-fact-registry.ts');
  const scopeEvaluator = read('packages/main/src/core/scope-anti-expansion.ts');
  const policyEntries = parseCommandPolicyEntries();
  const crossOwnershipEffects = new Map([
    ['story_create', 'always'],
    ['story_reconcile', 'whenDryRunFalse'],
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
    ['review_inventory_status', 'whenRefresh'],
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
    ['review_inventory_status', 'args.refresh'],
    ['check', 'args.upgrade'],
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

export function assertProcessFactCommandInventory() {
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
  const storyCreateText = read('packages/main/src/handlers/story-create.ts');
  for (const token of [
    "args.phase !== 'IDEA' && args.phase !== 'INIT'",
    'story_create_direct_lifecycle_phase_forbidden',
    'story_advance through INIT_CHECK, PLAN, DEV, REVIEW, TEST, and DONE',
  ]) {
    assert(
      storyCreateText.includes(token),
      `packages/main/src/handlers/story-create.ts: story_create lifecycle admission gate missing ${JSON.stringify(token)}`,
    );
  }
  assert(
    read('packages/main/src/cli/command-catalog.ts').includes('Post-intake lifecycle phases require story_advance'),
    'packages/main/src/cli/command-catalog.ts: story_create phase help must disclose lifecycle admission policy',
  );
  assertReviewRunStoryFilesHashContract(registry, levelRegistry);
  assertEvidenceHashSnapshotFailClosedContract(registry, levelRegistry);
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
