import { extractCliToolNames, parseProcessFactRegistry, parseProcessFactLevelRegistry, parseCommandPolicyEntries } from './registry-parser.mjs';







import ts from 'typescript';
import nodeAssert from 'node:assert/strict';

import { assert, ALL_PHASES, read, processFactRegistryPath, processFactLevelRegistryPath, quiet } from './support.mjs';
import { policyBlockHasOwnershipClass } from './command-contracts.mjs';
import { sameStringArray } from './registry-alignment.mjs';
import { extractConstInitializer } from './review-inventory.mjs';
import { parseFlowFactPolicies } from './registry-parser.mjs';

export function assertStory3ProcessFactContract(cliToolNameSet, registry, levelRegistry, policyByName) {
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
      phases: ['DEV', 'REVIEW', 'TEST'], ownershipClass: 'storyScopedMutating',
    },
    {
      name: 'finding_runtime_evidence_verify', level: 'L3', category: 'runtime-evidence-verification',
      owner: /core\/runtime-evidence-receipt \+ handlers\/finding-ledger\.verify/,
      semantics: ['execution-evidence', 'signed-artifact', 'schema-contract', 'freshness-policy', 'workspace-binding'],
      phases: ['DEV', 'REVIEW', 'TEST'], ownershipClass: 'readOnly',
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
  assert(read('packages/main/src/core/reviewer-batch-subject.ts').includes('reviewerBatchAdmissionLanes') && read('packages/main/src/core/reviewer-batch-subject.ts').includes("run.reviewPurpose === 'inventory-completeness'") && read('packages/main/src/core/reviewer-batch-subject.ts').includes('admissionLanesDigest'), 'managed batch admission must include only a current purpose-bound inventory critic in a distinct admission subject');
  assert(read('packages/main/src/core/prompt-registry.ts').includes('A metadata-only HEAD advance does not replace the signed inventory cutoff')
    && registrySource.includes('Metadata-only HEAD advancement may differ from the original cutoff HEAD'),
    'metadata-only critic admission requires matching prompt and registry contracts');
  assert(read('packages/main/src/tasks/inventory-critic-live-metadata-projection-smoke.ts').includes('managed inventory critic receives current signed uncommitted inventory metadata in its sealed prompt'), 'managed inventory critic live metadata projection requires focused RED/GREEN coverage');
  assert(read('packages/main/src/core/managed-execution-input-identity.ts').includes('fingerprintCapturedManagedProviderState'), 'execution identity must bind captured provider inputs');
  assert(read('scripts/verify-u08-execution-identity.mjs').includes('fixture-env-secret'), 'input identity requires actual secret/environment drift regression');
  assert(read('scripts/verify-u08-batch-admission.mjs').includes('U08_BATCH_CONTROLLER_CONCURRENT_PASS'), 'shared admission requires actual multi-process regression');
  assert(registrySource.includes('packages/main/src/providers/supervised-process-worker.ts'), 'synchronous provider lifecycle must be registered');
  assert(read('packages/main/src/core/host-execution-readiness.ts').includes('runSupervisedProviderProcess(args.executablePath'), 'readiness probes must share supervised provider lifetime');
  assert(read('scripts/verify-u08-supervised-readiness.mjs').includes('readiness probe must reap its live descendant before returning'), 'readiness has an actual descendant regression');
  assert(read('packages/main/src/core/managed-review-provider-state.ts').includes('materializeManagedProviderState(cache,captureManagedProviderState(host,env))'), 'provider state creation must use the captured input seam');
  assert(registrySource.includes('Grok refuses compatibility-proposal completion') && registrySource.includes('Grok uses its own host identity') && registrySource.includes('Grok requires the configured read-only lane') && read('scripts/verify-managed-provider-state.mjs').includes('ISOLATED_REVIEW_AUTH_PASS'), 'isolated authentication and Grok structured review intake require registered semantics and executable negative controls');
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
  const approvalContinuity = read('packages/main/src/core/scope-approval-continuity.ts');
  for (const invariant of ['unexpiredScopeBudgetApprovals', 'readAuthenticatedAcceptanceAmendmentJournal', 'approval.resultingScopeDigest', 'approval.bindingDigest', 'hasMechanicalExecutionAuthority', 'equivalentConfiguration', '--first-parent', 'firstPinCommits', 'checkBudget()']) {
    assert(approvalContinuity.includes(invariant), `scope continuity requires ${invariant}`);
  }
  assert(read('packages/main/src/core/story-scope-budget.ts').includes('!next && !base && !report.decomposition'), 'scope continuity must not authorize a new amendment or decomposition');
  assert(!approvalContinuity.includes('signValidationArtifact(') && !approvalContinuity.includes('writeScopeBudgetDecisions('), 'scope continuity cannot create or rewrite approval authority');
  assert(approvalContinuity.includes('projected({items:[historical]})') && approvalContinuity.includes('projected({items:[original]})'), 'first-pin execution must bind the approved requirement meaning');
  assert(registrySource.includes('packages/main/src/core/scope-approval-continuity.ts'), 'scope continuity consumer must be registered');
  assert(read('packages/main/src/core/story-scope-budget.ts').includes('undefined, undefined, lineage, false'), 'recursive children must not repeat continuity scans');
  assert(budgetDecision.includes('scopeBudgetDecisionReport(store, root, args.storyId, args.amendmentId, false)'), 'approval issuance must compute exact reports without historical continuity');
  assert(approvalContinuity.includes('break requirements') && approvalContinuity.includes('live_input_changed'), 'mismatched intent references and live drift must stop continuity');
  assert(read('packages/main/src/core/story-scope-budget.ts').includes('allowApprovalContinuity && report.blocking') && read('packages/main/src/core/story-scope-budget.ts').includes('delete report.approvalContinuityRefusal'), 'nonblocking reads skip continuity and grants clear refusal diagnostics');
  assert(approvalContinuity.includes("code === 'ETIMEDOUT'") && approvalContinuity.includes('if(unavailableHistory)'), 'continuity diagnostics preserve terminal Git cause and defer empty-history reporting');
  const continuityPackage = JSON.parse(read('package.json'));
  assert(continuityPackage.scripts?.['test:scope-approval-continuity'] === 'node scripts/verify-scope-approval-continuity.mjs', 'behavioral scope continuity regression must be executable');
  assert(continuityPackage.scripts?.['test:serial-reference']?.includes('npm run test:scope-approval-continuity'), 'behavioral scope continuity regression must remain in the canonical pipeline');
  assert(read('packages/main/src/tasks/full-suite-runner.ts').includes("isolated('test:scope-approval-continuity', { timeoutMs: 120_000 })"), 'scope continuity regression must have its isolated scheduler policy');
  assert(approvalContinuity.includes('onRefusal?.(') && read('packages/main/src/core/story-scope-budget.ts').includes('approvalContinuityRefusal'), 'continuity exhaustion must expose non-authorizing diagnostics');
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
    'hasMechanicalExecutionAuthority', 'isBlockingDirty', 'appendMarker(ctx.store)', 'exactStoryArtifactNames']) {
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

export function formatProcessFactLevelRegistryEntry(entry) {
  const gateSuffix = entry.level === 'L4' && entry.gateConsumer ? ` gate=${entry.gateConsumer}` : '';
  return `- ${entry.name} [${entry.level}] owner=${entry.owner}${gateSuffix}`;
}

export function formatProcessFactRegistryEntry(entry) {
  const gateSuffix = entry.consumerGate ? ` gate=${entry.consumerGate}` : '';
  const producerSuffix = entry.producer ? ` producer=${entry.producer}` : '';
  const artifactSuffix = entry.artifact?.path ? ` artifact=${entry.artifact.path}${entry.artifact.signed ? ':signed' : ''}` : '';
  return `- ${entry.name} [${entry.level}/${entry.kind}]${producerSuffix}${gateSuffix}${artifactSuffix}`;
}

export function printProcessFactLevelRegistrySummary() {
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

export function assertFilePatterns(entryName, relPath, patterns) {
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

export function runStory3Contract() {
  assertStory3ProcessFactContract(
    new Set(extractCliToolNames(read('packages/main/src/cli/command-catalog.ts'))),
    new Map(parseProcessFactRegistry().map(row => [row.name, row])),
    new Map(parseProcessFactLevelRegistry().map(row => [row.name, row])),
    new Map(parseCommandPolicyEntries().map(row => [row.name, row])),
  );
}
