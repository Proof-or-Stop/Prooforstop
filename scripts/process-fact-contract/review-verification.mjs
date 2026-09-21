

import { existsSync } from 'node:fs';


import { basename, join } from 'node:path';

import ts from 'typescript';
import nodeAssert from 'node:assert/strict';

import { assert, processFactLevelRegistryPath, processFactRegistryPath, read, closeoutPolicyModule, requiredRuntimeFactSemantics, root, requiredDecisionDocPromotionCommands, commandPolicyPath, assertLocalAssuranceNoReleaseBoundary, ALL_PHASES, activeLifecycleDocPaths, activeLifecycleDocCurrentTerms, fail, legacyTestFixtureCommands, legacyCommandDocContextPattern, validatePrimaryReferenceDocPaths, reviewRoundIsoDocPaths, evidenceBoundaryDocPaths, requiredEvidenceBoundaryPhrases, positiveCurrentBundleV3Patterns, verificationReceiptModelPaths, canonicalRoleId } from './support.mjs';
import { sameStringArray } from './registry-alignment.mjs';
import { policyBlockHasOwnershipClass } from './command-contracts.mjs';
import { scanActiveLifecycleDocText } from './prompt-contracts.mjs';
import { extractNamedFunctionBody } from './review-inventory.mjs';

export function assertDeliveryCheckStoryFilesHashContract(registry, levelRegistry) {
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

export function assertDeliveryPromiseOutcomeContract(registry, levelRegistry) {
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

export function assertReviewExecutionAuthorityContract(registry, levelRegistry) {
  const subjectReader = read('packages/main/src/core/review-run.ts');
  const subjectOffset = subjectReader.indexOf('const inventorySubject = managedInventorySubjectState(store, run,');
  const managedOffset = subjectReader.indexOf("if (authority.reviewGatePath === 'managed-receipt' && managedBinding && !nativeBinding)");
  assert(subjectOffset >= 0 && managedOffset >= 0 && subjectOffset < managedOffset,
    'inventory subject classification must precede both execution authority paths');
  const liveOffset = subjectReader.indexOf('const live = verifyManagedReviewLiveBinding({', subjectOffset);
  assert(managedOffset >= 0 && liveOffset > managedOffset,
    'managed transport authentication must precede supersedable live freshness classification');
  assert(subjectReader.includes("code: classifyManagedLiveBindingFailure(live.reason, nativeBinding !== undefined)")
    && subjectReader.includes("export function classifyManagedLiveBindingFailure(")
    && subjectReader.includes("return knownDrift ? 'stale_run_hash' : 'managed_receipt_invalid'"),
    'only recognized observable managed freshness drift is supersedable; unknown identity stays refused');
  const retentionOffset = subjectReader.indexOf('const retention = evaluateReviewRunMetadataRetention');
  assert(subjectReader.indexOf('if (!managedBinding && !nativeBinding) {', subjectOffset) > retentionOffset
    && subjectReader.indexOf('if (managedBinding && nativeBinding) {', subjectOffset) > retentionOffset,
    'unbound and conflicting evidence must retain their existing freshness/scope/retention ordering');
  const nativeOffset=subjectReader.indexOf("if (authority.reviewGatePath === 'direct-signed-review' && nativeBinding)");
  const supersededOffset=subjectReader.indexOf("if (inventorySubject === 'superseded') return {");
  assert(nativeOffset>=0 && supersededOffset>managedOffset && supersededOffset>nativeOffset,
    'forgivable inventory supersession must follow both authentication paths');
  assert(read('scripts/verify-review-epoch-certification-continuity.mjs').includes('NATIVE_TWO_WAVE_COLLECTION_GREEN'),
    'native inventory supersession requires behavioral coverage');

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
  const hasExactNativeDispatchSelection = source => {
    const ast = ts.createSourceFile('review-run.ts', source, ts.ScriptTarget.Latest, true);
    const owner = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'validateEvidenceRunBinding');
    const calls = [];
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'verifyCurrentReviewerDispatchBinding') calls.push(node);
      ts.forEachChild(node, visit);
    };
    if (owner) visit(owner);
    return calls.length === 1 && ts.isObjectLiteralExpression(calls[0].arguments[0])
      && calls[0].arguments[0].properties.some(property => ts.isPropertyAssignment(property)
        && property.name.getText(ast) === 'expectedDispatchBindingDigest'
        && property.initializer.getText(ast) === 'nativeBinding.dispatchBindingDigest');
  };
  assert(hasExactNativeDispatchSelection(reviewGateText), 'native review evidence must select its exact sealed historical dispatch');
  assert(!hasExactNativeDispatchSelection(reviewGateText.replace('expectedDispatchBindingDigest: nativeBinding.dispatchBindingDigest,', '')),
    'native historical dispatch contract must reject removing the exact binding argument');
  const importerText = read('packages/main/src/handlers/managed-review-evidence.ts');
  const evidenceFreshnessText = read('packages/main/src/core/evidence-freshness.ts');
  assert(evidenceFreshnessText.includes("statusCode === '??'") && evidenceFreshnessText.includes('isByteIdenticalControllerConfig')
    && evidenceFreshnessText.includes('isByteIdenticalControllerRuntimeAsset'),
  'managed inventory critic projection admission must retain an explicit untracked-only status gate plus signed byte-identity helpers');
  for (const token of ['candidate.evidence', 'proposalFindingIndex', 'existing receipt findings do not exactly cover every provider proposal index', 'storyMetadataLockDir', "'finding', 'review-passes'", "'findings.lock'", 'importedAt: sealedProposal?.authoredAt', 'assertCandidateReadBinding', 'assertCurrentCandidateReadBinding', 'trustedControllerProjectionStoryId: managedRun.storyId!']) {
    assert(importerText.includes(token), `packages/main/src/handlers/managed-review-evidence.ts: required exact replay token missing: ${token}`);
  }
  const managedText = read('packages/main/src/core/managed-review-evidence.ts');
  assert(managedText.includes('isMissingReviewSnapshotError(error)') && managedText.includes("reportHealthIssue('review-maintenance-lineage', error") && reviewGateText.includes('inventorySubjectCause'),
    'unexpected inventory reader errors must retain health diagnostics and blocker cause');
  assert(!read('packages/main/src/core/review-evidence-refresh.ts').includes('proof-or-stop.causal-evidence-index')
    && read('packages/main/src/core/store.ts').includes('schemaVersion: CAUSAL_EVIDENCE_INDEX_SCHEMA'),
    'causal index writer and refresh reader must share the owning schema constant');
  assert(closeoutPolicyModule.CLOSEOUT_ARTIFACT_POLICIES.every(policy => !policy.canonicalWriters.includes('verification_evidence_add')),
    'no closeout policy may grant generic canonical authority to direct evidence writes');
  assert(JSON.stringify(closeoutPolicyModule.closeoutArtifactPolicyFor('checklist.json')?.canonicalWriters) === JSON.stringify(['verification_evidence_refresh_stale']),
    'checklist canonical writers must remain exactly the registered stale refresh command');
  for (const path of ['packages/main/src/core/review-evidence-refresh.ts','packages/main/src/core/review-run.ts']) {
    assert(!read(path).includes('causal-evidence/'), 'refresh path consumers must derive paths from owning constants: ' + path);
    assert(read(path).includes('isRefreshRetainableArtifactPath'), 'refresh consumers must share the path predicate: ' + path);
  }
  assert(read('scripts/verify-review-epoch-certification-continuity.mjs').includes('VALIDATE_PROCESS_METRICS_STORY_BOUNDARY'),
    'validate publication must exercise its own metrics Story boundary');
  assert(!read('packages/main/src/core/review-maintenance-lineage.ts').includes("from './review-run.js'") && !read('packages/main/src/core/closeout-trust.ts').includes("from './review-maintenance-lineage.js'"), 'maintenance readers must not introduce direct importer cycles');

  assert(read('packages/main/src/core/closeout-trust.ts').includes("import type { StoryStore } from './store.js'") && !read('packages/main/src/core/closeout-trust.ts').includes("from './review-evidence-refresh.js'"), 'closeout -> refresh -> store runtime edge must remain absent');
  const maintenanceText = read('packages/main/src/core/review-maintenance-lineage.ts') + read('packages/main/src/core/review-evidence-refresh.ts');
  const convergenceSchema = read('packages/main/src/core/convergence-progress-journal.ts');
  assert(convergenceSchema.includes('completedEpochBindings: { epochId: string; claimDigest: string }[];')
    && convergenceSchema.includes('revokedCompletedEpochIds: string[];') && convergenceSchema.includes('humanDecisions?:'), 'convergence history arrays are mandatory except humanDecisions; reader assumptions bind persisted schema');
  assert(maintenanceText.split('isMissingReviewSnapshotError(error)').length === 4, 'all three maintenance reader catches share the missing-snapshot classifier');

  assert(maintenanceText.includes('const reviewedRemaining=[...reviewedEvidence]')
    && maintenanceText.includes('hasMechanicalExecutionAuthority(store,storyId,reviewedItem,prior)'),
    'parent matches cannot grandfather evidence absent from the reviewed authority anchor');
  assert(maintenanceText.split('reviewRefreshStoryPrefix(gitCwd,store.storyDirPath(storyId))').length===3
    && !read('packages/main/src/core/review-evidence-refresh.ts').includes("prefix.startsWith('../')"), 'refresh readers share one Story containment guard');
  assert(maintenanceText.includes('priorEvidence.length !== nextEvidence.length') && maintenanceText.includes('semanticRows(priorEvidence)') && maintenanceText.includes('remaining.splice(index,1)')
    && maintenanceText.includes('hasMechanicalExecutionAuthority(store,storyId,old!,prior)'), 'review retention cannot add coverage or change the reviewed mechanical result');
  assert(!read('packages/main/src/core/closeout-trust.ts').includes("from './review-evidence-refresh.js'")
    && reviewGateText.includes("isRefreshRetainableArtifactPath(path) && isCurrentVerifiedEvidenceRefreshArtifact("), 'production scoped retention owns strict refresh; generic closeout must retain its type-only store dependency');

  assert(maintenanceText.includes("readAt(reviewedHeadHash,'checklist.json')") && maintenanceText.includes('semanticRows(reviewedEvidence)'), 'refresh proof must bind requirements and coverage to the original reviewed snapshot');
  assert(reviewGateText.includes('const refreshCache=createReviewRefreshReadCache();') && maintenanceText.includes('new WeakMap<ReviewRefreshReadCache,RefreshCacheState>()'), 'one collector-scoped opaque cache prevents repeated full receipt scans');
  assert(!read('packages/main/src/core/closeout-trust.ts').includes('strictEvidenceRefresh'), 'caller boolean input must not confer strict refresh authority');
  assert(managedText.includes('isSealedManagedPromptDigestCurrent(sealedManagedPromptDigest,args.binding.managedPromptDigest,runBinding.promptDigest)')
    && !managedText.includes('sealedManagedPromptDigest ?? args.expected.managedPromptDigest'), 'managed launch seal is mandatory; caller bindings never supply a missing digest');
  assert(managedText.includes('epoch.storyId !== run.storyId') && managedText.includes("binding.wave === currentWave ? 'current' : 'superseded'") && reviewGateText.includes("'superseded_inventory_wave'"), 'finalized managed critic belongs to the current Story and terminal wave');

  assert(maintenanceText.includes('verifyReviewInventoryEpoch(epoch)') && maintenanceText.includes('verifyReviewInventoryReceipt(receipt)')
    && maintenanceText.includes('hasMechanicalExecutionAuthority(store,storyId,item,evidence)'), 'review maintenance lineage requires signed epoch and strict receipt authority');
  assert(maintenanceText.includes('verifyCloseoutWriteReceipt(receipt,') && maintenanceText.includes('evaluatePersistedReviewToTestIndexTransition(gitCwd,')
    && maintenanceText.includes('verifyCertificationWindow(window)') && maintenanceText.includes('consumedByCertificationWindowId !== window.windowId'), 'post-review official lifecycle commits require typed receipt, consumption and exact phase delta checks');
  assert(reviewGateText.includes('managedInventorySubjectState(store, run,')
    && managedText.includes('isSealedManagedPromptDigestCurrent(sealedManagedPromptDigest,args.binding.managedPromptDigest,runBinding.promptDigest)')
    && !reviewGateText.includes('managedPromptDigest: managedReviewerPromptDigest('), 'managed consumption must validate the current subject and authenticated launch digest without rebuilding the OPEN-only prompt');
  assert(read('packages/main/src/handlers/certification-window.ts').includes('isVerifiedReviewMaintenanceCommit({')
    && managedText.includes('isVerifiedReviewMaintenanceCommit({'), 'managed and certification consumers share bounded signed publication lineage');
  assert(read('scripts/verify-review-epoch-certification-continuity.mjs').includes('FINALIZED_MANAGED_REVIEW_CONTINUITY_REQUIRED')
    && read('package.json').includes('npm run test:review-epoch-certification-continuity'), 'actual writer-to-consumer regression remains in the canonical full suite');

  for (const token of ['proposalArtifacts.length === 1', 'exactEvidenceMatches', 'processCleanup?.reaped === true']) {
    assert(managedText.includes(token), `packages/main/src/core/managed-review-evidence.ts: required managed authority token missing: ${token}`);
  }
  for (const token of ['modelSelectionMatches', '(args.binding.model ?? null)', '(receipt.model ?? null)', '(result.model ?? null)']) {
    assert(managedText.includes(token), `packages/main/src/core/managed-review-evidence.ts: required managed model-selection binding missing: ${token}`);
  }
  for (const token of ['buildManagedInventoryCriticEvidencePack', "run.reviewPurpose !== 'inventory-completeness'", 'BEGIN CONTROLLER-FETCHED CURRENT INVENTORY EVIDENCE PACK', 'sealed by the managedPromptDigest', 'do not report that expected lag as missing canonical evidence', 'Do not infer topology, TEST, DONE, or implementation authority from this pack.']) {
    assert(managedText.includes(token), `packages/main/src/core/managed-review-evidence.ts: required inventory critic live metadata projection token missing: ${token}`);
  }
  const managedHostRunText = read('packages/main/src/core/managed-host-run.ts');
  for (const token of ['submissionDigest', 'idempotency input conflict', 'idempotent submission pending or interrupted']) {
    assert(managedHostRunText.includes(token), `managed submission must retain durable duplicate-dispatch protection: ${token}`);
  }
  for (const token of ['finalAssistantResult', 'finalAssistantResultCount', 'finalAssistantResultTruncated', 'parseManagedReviewFinalProposal', 'managed_review_final_result_missing', 'assertSealedManagedHostRunArtifacts', 'isRecoverableManagedReviewImportBinding', 'withTerminalAuthorityLock', 'liveOutputDigest', "mismatches.push('live-output')", 'providerLaunchState', 'evidenceBindingSeal', 'cleanupManagedCrossHostReviewWorktree', 'cleanupManagedClaudePromptForTerminal', 'managedClaudePromptDirectoryForRun', 'reapManagedHostRunProviderProcess', 'AMBIGUOUS_PROCESS_CLEANUP', "launchProfile: 'managed_reviewer'", 'delete providerEnvironment.LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD', "descriptor.once('finish'", 'worker capability descriptor closed before write completion', 'classifyManagedHostRunCancellation', "reason === 'absolute_deadline_exceeded'", "state: 'timed_out'"]) {
    assert(managedHostRunText.includes(token), `packages/main/src/core/managed-host-run.ts: required final-result/seal authority token missing: ${token}`);
  }
  const lowLevelHostRunText = read('packages/main/src/core/host-run.ts');
  for (const token of ['descriptorPeerClosedAfterFinal', "error.code === 'EPIPE'", "error.code === 'ECONNRESET'", 'finalResult.count === 1', 'finalResult.truncated === false']) {
    assert(lowLevelHostRunText.includes(token), `packages/main/src/core/host-run.ts: required late descriptor-close authority boundary missing: ${token}`);
  }
  const lateDescriptorResetTest = read('packages/main/tests/managed-review-late-descriptor-reset.test.mjs');
  const validationConfig = read('proof-or-stop.config.json');
  assert(read('packages/main/package.json').includes('test:managed-review-late-descriptor-reset')
    && validationConfig.includes('packages/main/tests/managed-review-late-descriptor-reset.test.mjs')
    && lateDescriptorResetTest.includes("['EPIPE', 'ECONNRESET']")
    && lateDescriptorResetTest.includes('descriptor reset before any final proposal remains fail closed')
    && lateDescriptorResetTest.includes('a late descriptor close cannot convert a provider failure into success')
    && lateDescriptorResetTest.includes('multiple final proposals remain fail closed')
    && lateDescriptorResetTest.includes('an oversized final proposal remains fail closed'),
  'late descriptor-close tolerance requires canonical validation wiring and executable success/failure controls');
  for (const token of [
    'delete submissionArgs.model',
    'delete submissionArgs.reasoningEffort',
    'selection.model !== null ? { model: selection.model }',
    'selection.reasoningEffort !== null ? { reasoningEffort: selection.reasoningEffort }',
    'model: selection.model',
    'reasoningEffort: selection.reasoningEffort',
  ]) {
    assert(managedHostRunText.includes(token), `packages/main/src/core/managed-host-run.ts: required immutable model-selection seal missing: ${token}`);
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
  const managedReviewerQualificationText = read('packages/main/src/core/managed-reviewer-qualification.ts');
  for (const token of ['classifyManagedReviewFinalEnvelope', "classification.kind === 'ordinary'", 'MANAGED_REVIEW_FINAL_PROPOSAL_SCHEMA_VERSION', 'MANAGED_REVIEW_CLAUDE_JSON_SCHEMA_MAX_BYTES', 'managedClaudePromptDirectoryForRun', 'managedRunId', "join(args.cwd, PROOF_OR_STOP_DIR, 'runtime', 'host-run-prompts')", "'--permission-mode', 'bypassPermissions'", "'--json-schema', args.finalResultSchema === ACCEPTANCE_REVIEW_FINAL_SCHEMA ? JSON.stringify(acceptanceReviewJsonSchema()) : managedReviewClaudeJsonSchema(args)", "hasOwnProperty.call(event, 'structured_output')", "event.subtype !== 'success'", 'JSON.stringify(event.structured_output)']) {
    assert(hostRunText.includes(token), `packages/main/src/core/host-run.ts: required Codex proposal candidate classifier token missing: ${token}`);
  }
  for (const token of [
    'normalizeHostRunModelSelection',
    'resolveQualifiedManagedReviewerSelection',
    'managed reviewer model',
    'managed reviewer reasoningEffort',
    "'--model', selection.model",
    'model_reasoning_effort=',
    "'--effort', selection.reasoningEffort",
    '--model must be a non-empty model id of at most 256 characters without whitespace or controls',
    '--reasoningEffort must be one of',
    'Claude --reasoningEffort must be one of low, medium, high, xhigh, max',
    'canonical Claude launcher ends in its protected prompt-file token',
    'canonical Codex launcher ends in its protected stdin marker',
  ]) {
    assert(hostRunText.includes(token), `packages/main/src/core/host-run.ts: required managed model-selection launch token missing: ${token}`);
  }
  for (const token of ['QUALIFIED_MANAGED_REVIEWER_DEFAULTS', 'CLAUDE_SUPPORTED_REASONING_EFFORTS', 'QUALIFIED_MANAGED_REVIEWER_EFFORTS', "model: 'gpt-5.6-sol'", "model: 'opus'", "reasoningEffort: 'high'"]) {
    assert(managedReviewerQualificationText.includes(token), `packages/main/src/core/managed-reviewer-qualification.ts: required reviewer qualification default missing: ${token}`);
  }
  const smokeText = read('packages/main/src/tasks/managed-review-evidence-smoke.ts');
  for (const token of ['absence of a managed binding is not proof', 'isolated broker-signature fixture succeeds without consulting ambient provider ancestry', 'withoutManagedAmbientAuthority', "'--brokered-native-binding-fixture'", 'raw provider cannot self-mint authority', 'mixed tree is rejected', 'real raw cross-provider CLI review_pass_set must fail', 'real raw cross-provider CLI finding_add must fail', 'idempotent importer replay revalidates the exact persisted provider finding', 'multiple proposal artifacts also fail the persisted REVIEW gate', 'DISPATCH_START reviewer accepted the managed assignment', 'Reviewed the first evidence group; continuing with adversarial paths.', 'the exact provider final-result proposal is importable without a provider tool-shell callback', 'public managed Claude prompt is inside the exact provider cwd', 'public managed Claude launch cannot block on interactive tool approval', 'public managed Claude launch supplies its bounded structured-output schema', 'worker descriptor capability metadata is not inherited as ordinary provider authority', 'public managed Claude final proposal is exactly importable', "name: 'model'", "name: 'reasoningEffort'", "name: 'missing'", "name: 'malformed'", "name: 'multiple'", "name: 'oversize'", 'final result fails closed', 'controller must not be able to add or override proposal verdict fields', 'injected crash before story evidence persistence']) {
    assert(smokeText.includes(token), `packages/main/src/tasks/managed-review-evidence-smoke.ts: required executable boundary assertion missing: ${token}`);
  }
  assert(smokeText.includes('managed Claude model selection preserves the complete canonical argv'),
    'managed Claude selector coverage must pin the complete provider argv');
  const managedHostRunSmokeText = read('packages/main/src/tasks/managed-host-run-smoke.ts');
  for (const token of [
    'omitting model selectors leaves the pre-selection managed Codex argv byte-for-byte unchanged',
    'fresh omitted selectors are explicitly sealed as null in binding, receipt, and result',
    'the same managed review identity cannot be resubmitted with a different model',
    'REVIEW verifier rejects a persisted model that disagrees with the sealed spec, receipt, and result',
    'REVIEW verifier rejects persisted reasoning that disagrees with the sealed spec, receipt, and result',
    'historical selector-less specs still import through the shared REVIEW verifier',
    'ordinary Codex model selection preserves the complete canonical argv',
    'ordinary Claude model selection preserves the complete canonical argv',
    'managed Claude model selection preserves the complete canonical argv',
    'a selector-less resubmit against a historical spec does not dispatch a duplicate worker',
    "process.argv[2] === '--model-selection'",
  ]) {
    assert(managedHostRunSmokeText.includes(token), `packages/main/src/tasks/managed-host-run-smoke.ts: required model-selection regression missing: ${token}`);
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

export function assertReviewRunStoryFilesHashContract(registry, levelRegistry) {
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

export function assertEvidenceHashSnapshotFailClosedContract(registry, levelRegistry) {
  const runtimeName = 'runtime:evidence_hash_snapshot_fail_closed_gate';
  const expectedConsumer = 'checkEvidenceFreshnessForGit fail-closed reader, lifecycle-readiness DONE hash rows, done-oracle evidence-hash-snapshot row, runDoneOracleGate, verifier routine validation reuse, and session_brief DONE pre-check';
  const levelEntry = levelRegistry.get(runtimeName);
  assert(levelEntry, `${processFactLevelRegistryPath}: required ${runtimeName} entry missing`);
  if (levelEntry) {
    assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${runtimeName} must stay L4`);
    assert(levelEntry.owner === 'core/evidence-freshness', `${processFactLevelRegistryPath}: ${runtimeName} owner drifted`);
    assert(levelEntry.gateConsumer === expectedConsumer, `${processFactLevelRegistryPath}: ${runtimeName} consumer drifted`);
    for (const token of ['classifyEvidenceHashSnapshot', 'fails closed', 'DONE target blocks', 'session_brief']) {
      assert(levelEntry.rationale.includes(token), `${processFactLevelRegistryPath}: ${runtimeName} rationale missing ${token}`);
    }
  }
  const registryEntry = registry.get(runtimeName);
  assert(registryEntry, `${processFactRegistryPath}: required ${runtimeName} entry missing`);
  if (registryEntry) {
    assert(registryEntry.level === 'L4', `${processFactRegistryPath}: ${runtimeName} registry level drifted`);
    assert(registryEntry.consumerGate === expectedConsumer, `${processFactRegistryPath}: ${runtimeName} registry consumer drifted`);
    for (const semantic of requiredRuntimeFactSemantics[runtimeName]) {
      assert(registryEntry.semantics.includes(semantic), `${processFactRegistryPath}: ${runtimeName} missing ${semantic}`);
    }
  }

  const freshness = read('packages/main/src/core/evidence-freshness.ts');
  for (const token of [
    'export function classifyEvidenceHashSnapshot(',
    'EVIDENCE_FRESHNESS_HEAD_UNREADABLE_REASON',
    'runtimeUnavailable',
    'the evidence materialHash binding cannot be verified (fail closed)',
  ]) {
    assert(freshness.includes(token), `evidence-freshness.ts: fail-closed contract missing ${token}`);
  }
  assert(!freshness.includes('Unable to get git HEAD, skipping freshness check'), 'evidence-freshness.ts: unreadable HEAD must not be accepted as fresh');

  const consumers = [
    'packages/main/src/core/done-oracle.ts',
    'packages/main/src/core/lifecycle-readiness.ts',
    'packages/main/src/handlers/verifier.ts',
  ];
  for (const relPath of consumers) {
    assert(read(relPath).includes('classifyEvidenceHashSnapshot'), `${relPath}: shared partial-snapshot classifier is not consumed`);
  }
  const phaseGates = read('packages/main/src/handlers/phase-gates.ts');
  for (const token of ["r.id === 'evidence-hash-snapshot'", 'Evidence hash snapshot binding (', 'bindingRow.detail']) {
    assert(phaseGates.includes(token), `packages/main/src/handlers/phase-gates.ts: partial capture disclosure is not load-bearing: ${token}`);
  }
  assert(existsSync(join(root, 'packages/main/src/tasks/evidence-hash-snapshot-classifier-smoke.ts')), 'classifier smoke source missing');
  assert(existsSync(join(root, 'packages/main/tests/red/red-partial-hash-snapshot-binding.mjs')), 'partial-hash RED/GREEN proof missing');
}

export function assertCurrentPromptIdentityBoundary() {
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

export function assertDecisionDocPromotionCommandContract(cliToolNameSet, registry, levelRegistry, policyByName) {
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

export function assertActiveLifecycleDocGuidance() {
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

export function assertReviewRoundIsoDocs() {
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

export function assertEvidenceBoundaryDocs() {
  for (const relPath of evidenceBoundaryDocPaths) {
    const text = read(relPath);
    for (const phrase of requiredEvidenceBoundaryPhrases) {
      assert(text.includes(phrase), `${relPath}: missing process evidence boundary phrase "${phrase}"`);
    }
  }
}

export function assertCurrentVerificationReceiptModel() {
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
    read('packages/main/src/tasks/verification-run-and-guard/support.ts').includes('authoritative V5 bundle and its V3 execution component'),
    'verification lifecycle smoke must describe the current V5 bundle rather than authoritative V3 validation',
  );
  const verificationReceiptSmoke = ['support', 'refresh'].map(name => read(`packages/main/src/tasks/verification-run-and-guard/${name}.ts`)).join('\n');
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

export function assertPromptEvidenceBoundaries(promptMap) {
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
    if (text.includes('delivery-check.json')) {
      assert(
        text.includes('transcript/delivery evidence is required; prompt-only user-value claims are not enough'),
        `${relPath}: delivery/product guidance must reject prompt-only user-value claims`,
      );
      assert(
        text.includes('non-mechanical user approval'),
        `${relPath}: delivery/product guidance must distinguish subjective approval from mechanical evidence`,
      );
    }
    if (canonicalRoleId(name) === 'proof-or-stop-product-reviewer') {
      assert(
        text.includes('implementation has not started') && text.includes('must not require'),
        `${relPath}: INIT product guidance must permit planned evidence before implementation`,
      );
      assert(
        !text.includes('story_advance DONE') && !text.includes('live-smoke-transcript.json'),
        `${relPath}: INIT product guidance must not request post-implementation artifacts`,
      );
    }
  }
}
