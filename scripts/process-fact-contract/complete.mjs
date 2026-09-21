
import { verificationFailureMessage } from ".././verification-subprocess-budget.mjs";
import { readFileSync } from 'node:fs';

import { execFile, execFileSync } from 'node:child_process';
import { join } from 'node:path';

import ts from 'typescript';
import nodeAssert from 'node:assert/strict';

import { promptDirs, read, fail, requiredReviewerRunIdPromptFiles, rolePromptPath, assert, commandPolicyPath, processFactLevelRegistryPath, processFactRegistryPath, flowFactPolicyPath, root, assertCapabilityMaterialContract, warnings, quiet, failures } from './support.mjs';
import { listMarkdown } from './source-analysis.mjs';
import { scanReviewRoundPromptSchema, isReviewerPrompt, scanPromptText, comparePromptSemantics, assertSyntheticAdversarialChecks, scanCliMachineFactNames, scanCodeLikeStringArrayConst } from './prompt-contracts.mjs';
import { assertActiveLifecycleDocGuidance, assertReviewRoundIsoDocs, assertEvidenceBoundaryDocs, assertCurrentVerificationReceiptModel, assertPromptEvidenceBoundaries, assertCurrentPromptIdentityBoundary } from './review-verification.mjs';
import { assertProofStoryGateConsumedFacts, assertCloseoutTrustBoundary } from './proofstory-closeout.mjs';
import { assertPhaseTransitionReopenAuditContract, assertOutOfBandReopenAuditRescueContract, assertReopenAuditConcurrencyResidualContract, assertReopenAuditLockRejectionRationaleContract } from './reopen.mjs';
import { assertValidationPersistenceTransactionContract, assertReviewInventoryRemediationContract } from './review-inventory.mjs';
import { parseProcessFactLevelRegistry, assertDonePreflightPredicateInventoryParity, parseRegistryArrayEntriesFromSource, parseStringArrayProperty } from './registry-parser.mjs';
import { assertLifecycleArtifactScopePolicy, assertStrengtheningRoadmapGovernanceLedger, assertParentRoadmapIntentTotalityPlan, assertParentRoadmapTotalityRuntime, assertStoryAwareDynamicValidationRuntime, assertPromptMeasurementObservationBoundary } from './scope-runtime.mjs';
import { printProcessFactLevelRegistrySummary, assertFilePatterns } from './story3.mjs';

export async function runCompleteProcessContract() {

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
      { relPath: 'scripts/verify-lab-lock-scope.mjs', patterns: ['main changed while the audit ran', 'LAB_FIXTURE_AUDIT_HOLD'] },
      { relPath: 'scripts/lab-audit.mjs', patterns: ['selectAuditor', 'runHostRun', 'parseAuditResult', 'processCleanup', 'inputDigest', 'readRefs', 'candidateVerificationContext', 'checkoutVerified===true', 'row.verifiedHead===head', '!row.error', 'files, verification'] },
      { relPath: 'packages/main/src/core/process-fact-registry.ts', patterns: ['runtime:lab_local_maintenance_integration', 'never Story REVIEW/TEST/DONE'] },
      { relPath: 'scripts/lab-worktree.mjs', patterns: ['candidateVerificationContext(s.history,head,s.red?.command)', 'record.checkoutVerified=true', 'record.verifiedHead=before', 'selection: selected, verification', 'ensureAudit', 'auditIsFresh', 'repairContentDigest', 'changed repair content', 'resumeMainHead', 'no pinned developer', 'acquireMainWriteLock', 'createHmac', 'Fresh GREEN', 'synced-green', 'candidate-green', 'main-green', 'candidate-story-baseline', 'main-story-baseline', 'candidate-story-integration', 'main-story-integration', '--ff-only', "phase = 'verified'", "'branch', '-d'", "action === 'carry'", "action === 'baseline'", 'story-baseline-supplement', 'baselineWitnesses', 'finishBaselineWitnesses', 'integrationWitnesses', 'createVerificationEvidenceGateEvaluator', 'currentMaterialHash', 'currentStoryFilesHash', 'failureIdentity', "['node', 'scripts/ensure-dist.mjs']", "!path.startsWith('.proof-or-stop/')", 'preservedMainDirty', 'Dirty main changed during Story carry-forward integration'] },
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
          { label: 'test-evidence writer call', absentRegex: /\.(?:writeTestEvidence|writePreparedTestEvidence)\s*\(/ },
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
          'ctx.store.writePreparedTestEvidence',
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
        patterns: ['init_check_set', 'computeBackgroundHash', 'computeChecklistHash', 'computeInitReviewerAuthorityInputHash', 'authorityInputHash', 'authorityBaselineIssues', 'deliveryRunId', 'resolveManagedDispatchInvocation', 'delivery_not_acknowledged', 'normalizeSubmittedInitCheckIssue', 'normalizeReviewerBlockingAuthority', 'normalizeUnchangedInputBlockerExpansion', 'missing_or_invalid_requirement_ref', 'outside_init_reviewer_blocking_authority', 'unchanged_input_blocker_expansion'],
      },
      {
        relPath: 'packages/main/src/core/types.ts',
        patterns: ['PRODUCT_INIT_BLOCKING_ISSUE_KINDS', 'STORY_INIT_BLOCKING_ISSUE_KINDS', 'requirementRef', 'reportedSeverity', 'dispositionReason', 'authorityInputHash', 'authorityBaselineIssues', 'deliveryRunId', 'unchanged_input_blocker_expansion'],
      },
      {
        relPath: 'packages/main/src/core/init-check-gate.ts',
        patterns: ['INIT_CHECK_SALT', 'signInitCheck', 'recomputeInitCheckHash', 'missingRequiredInitCheckAgents', 'invalidInitReviewerDeliveries', 'verifyManagedDispatchDelivery', 'blockingInitCheckIssues'],
      },
      {
        relPath: 'packages/main/src/core/machine.ts',
        patterns: ['canEnterInitCheck', 'missingRequiredInitCheckAgents', 'invalidInitReviewerDeliveries', 'delivery_not_acknowledged', 'renderManagedInitReviewerDispatches', 'blockingInitCheckIssues'],
      },
      {
        relPath: 'packages/main/src/core/reviewer-launch-guidance.ts',
        patterns: ['renderManagedInitReviewerDispatches', 'managedDispatch: true', 'host_run_status', 'init_check_set accepts only a matching live managed dispatch'],
      },
      {
        relPath: 'packages/main/src/core/managed-host-run.ts',
        patterns: ['resolveManagedDispatchInvocation', 'signManagedInitInvocation', 'lattice.managed_init_invocation.v1', 'initInvocationConsumption', 'lattice.managed_dispatch_invocation_consumption.v2', 'lattice.managed_dispatch_process_group_consumption.v1', 'managed_dispatch_process_group_invocation_consumed', 'managedDispatchInvocationConsumptionIsValid', 'managedDispatchOutputDigest', 'managed-dispatch-output', 'managed dispatch scope output does not match the completed receipt', "spec.profile !== 'managed_dispatch'", 'verifyManagedDispatchDelivery', 'bindingProjectionDigest', 'managedDispatchOutputValidation', 'afterManagedDispatchOutputValidated', 'managed_dispatch_output_changed_before_seal', 'managedDispatchOutputFailureReason', 'managed_dispatch_story_missing', 'managed_dispatch_output_missing', 'managed_dispatch_invocation_unconsumed', 'managed_dispatch_output_unreadable', 'managed_dispatch_output_invalid', 'initCheckSignatureIsValid', 'row.deliveryRunId === input.runId', 'verifyScopeCheckContentSignature', 'scopeCheck?.deliveryRunId !== input.runId'],
      },
      {
        relPath: 'packages/main/src/handlers/host-run.ts',
        patterns: ['managedDispatch?: boolean', 'createStoryDispatchHandlers(ctx).dispatch', "profile: 'managed_dispatch'", 'proof-or-stop-review-scope-plan', 'managed_review_candidate_spec_missing', 'candidate_spec_route'],
      },
      {
        relPath: 'packages/main/tests/managed-init-reviewer-dispatch-e2e.test.mjs',
        patterns: ['caller-supplied required reviewer role must fail closed', 'Promise.all(agentTypes.map', 'barrier timeout: peer reviewer never became ready', 'tamper-story', 'tamper-role', 'tamper-signature', 'missing-signature', 'malformed-null', 'attestation-$peer.json', 'env -u LATTICE_MANAGED_INIT_INVOCATION', 'a terminal managed dispatch attestation must stay unusable', 'MANAGED_INIT_REVIEWER_DISPATCH_E2E_GREEN'],
      },
      {
        relPath: 'packages/main/src/core/host-run.ts',
        patterns: ['CANONICAL_CODEX_NONINTERACTIVE_FLAGS', 'managedDispatchCodexSandboxMode', 'materializeHostRunLaunch', "existsSync('/.dockerenv')", "existsSync('/run/.containerenv')", "launchProfile === 'managed_dispatch'", "'danger-full-access'", 'read_manifest_candidate_spec_digest_missing'],
      },
      {
        relPath: 'packages/main/tests/managed-review-candidate-preflight.test.mjs',
        patterns: ['read_manifest_candidate_spec_digest_missing', 'managed_review_candidate_spec_missing', 'missing candidate routing must not launch the provider', 'MANAGED_REVIEW_CANDIDATE_PREFLIGHT_GREEN'],
      },
      {
        relPath: 'packages/main/src/core/host-execution-readiness.ts',
        patterns: ['CANONICAL_CODEX_NONINTERACTIVE_FLAGS', "'--skip-git-repo-check'", "'--ephemeral'", "'--ignore-rules'"],
      },
      {
        relPath: 'packages/main/tests/managed-init-dispatch-required-output.test.mjs',
        patterns: ['managedDispatch must fail when the provider exits zero without its bound init_check_set output', 'a same-role result from another run must not satisfy managed dispatch output', 'a direct init-check Store write must not substitute for invocation consumption', 'a tampered INIT result must not satisfy managed dispatch output', 'an unreadable INIT result must remain fail-closed', 'materializeHostRunLaunch', 'managed_dispatch_output_missing', 'managed_dispatch_invocation_unconsumed', 'managed_dispatch_output_unreadable', "managedDispatchCodexSandboxMode('linux', true)", "managedDispatchCodexSandboxMode('linux', false)", "managedDispatchCodexSandboxMode('darwin', true)"],
      },
      {
        relPath: 'packages/main/tests/managed-scope-dispatch-required-output.test.mjs',
        patterns: ['managed scope dispatch must fail when provider completion lacks scope_check_save output', 'direct Store writes must not substitute for scope_check_save invocation consumption', 'managed_dispatch_invocation_unconsumed', 'story_review must reject a scope artifact whose managed delivery did not complete', 'tampered scope evidence must not satisfy managed dispatch output', 'resolveManagedDispatchInvocation', 'deliveryRunId', 'MANAGED_SCOPE_DISPATCH_REQUIRED_OUTPUT_GREEN'],
      },
      {
        relPath: 'packages/main/tests/managed-scope-reviewer-dispatch-e2e.test.mjs',
        patterns: ['Review PLAN scope coverage', 'scope_check_save', 'deliveryRunId', 'verifyManagedDispatchDelivery', 'a rejected non-empty owner payload must not consume the managed scope invocation before a corrected zero-owner retry', 'a completed scope run cannot authorize replacement evidence with a recomputed public hash', 'story_review must reject post-terminal replacement of managed scope evidence', 'a real isolated provider cannot replace scope_check_save with a direct public-hash Store write', 'managed_dispatch_invocation_unconsumed', 'validated scope bytes cannot be replaced before terminal sealing', 'managed_dispatch_output_changed_before_seal', 'MANAGED_SCOPE_REVIEWER_DISPATCH_E2E_GREEN'],
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
          'story_create_direct_lifecycle_phase_forbidden',
          "created from draft '${draftName}' (INIT)",
        ],
      },
      {
        relPath: 'packages/main/src/cli/command-catalog.ts',
        patterns: [
          "phase: z.enum(['IDEA','INIT']",
          'story_create_direct_lifecycle_phase_forbidden',
          'post-intake lifecycle phases require story_advance',
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
        patterns: ['scope_check_save', 'signScopeCheck', 'resolveManagedDispatchInvocation', 'deliveryRunId'],
      },
      {
        relPath: 'packages/main/src/core/scope-check-integrity.ts',
        patterns: ['scopeCheckContentHash', 'verifyScopeCheckContentSignature', 'deliveryRunId'],
      },
      {
        relPath: 'packages/main/src/handlers/story-review.ts',
        patterns: ['verifyScopeCheckSignature', 'verifyManagedDispatchDelivery', 'scope_check_delivery_invalid', 'scope-check.json', 'scope_check_save'],
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
          { label: 'test-evidence writer call', absentRegex: /\.(?:writeTestEvidence|writePreparedTestEvidence)\s*\(/ },
          'Cannot enter TEST: CLI gate preflight execution error',
          'PRE_CERT_ROUTINE_PASS_REQUIRED',
        ],
      },
      {
        relPath: 'packages/main/src/handlers/verifier.ts',
        patterns: [
          'persistStoryValidationEvidence',
          'ctx.store.writePreparedTestEvidence',
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
        relPath: 'packages/main/src/tasks/flow-stability/lifecycle.ts',
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
  const regression = read('packages/main/src/tasks/verification-run-and-guard/publication.ts');
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
      && source.includes("from './validation-pass-admissibility.js'")
      && /assessStoredValidationPassAdmissibility\(ctx, storyId, \{ allowDynamicCoverage: true \}\)/.test(source)
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

assertDonePreflightPredicateInventoryParity();

await assertLifecycleArtifactScopePolicy();

assertStrengtheningRoadmapGovernanceLedger();

assertParentRoadmapIntentTotalityPlan();

assertParentRoadmapTotalityRuntime();

assertStoryAwareDynamicValidationRuntime();

assertPromptMeasurementObservationBoundary();

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

function findingDagDependencyIssues(source, owner) {
  const allowed = { '3A': ['3A'], '3B': ['3A', '3B'], Story2: ['3A', 'Story2'], Story1: ['3A', '3B', 'Story2', 'Story1'] };
  const component = specifier => {
    const name = specifier.split('/').at(-1).replace(/\.(?:[cm]?js|tsx?)$/, '');
    if (name === 'finding-ledger') return '3A';
    if (/^(?:runtime-evidence-receipt|finding-runtime-evidence)$/.test(name)) return '3B';
    if (/^finding-(?:identity(?:-types|-store)?|history|route|progress)$/.test(name)) return 'Story2';
    if (/^(?:dynamic-finding-blocking|finding-(?:applicability|assessment|triage|deferral|mandatory-repair|rollout|qualification|material-reattestation|runtime-pair|collection))(?:-|$)/.test(name)) return 'Story1';
    return undefined;
  };
  if (!allowed[owner]) throw new Error(`FINDING_DAG_SETUP: unknown owner ${owner}`);
  const issues = [], parsed = ts.createSourceFile('finding-dag.ts', source, ts.ScriptTarget.Latest, true);
  const visit = node => {
    const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
      : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require') ? node.arguments[0] : undefined;
    if (specifier && ts.isStringLiteral(specifier)) {
      const provider = component(specifier.text);
      if (provider && !allowed[owner].includes(provider)) issues.push(`FINDING_DAG_FORBIDDEN: ${owner}->${provider}: ${specifier.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed); return issues;
}

const routeRestorationSource = read('packages/main/src/handlers/finding-route.ts');

assert(routeRestorationSource.includes('readRestoration?.(ctx, source)')
  && routeRestorationSource.includes('restored.sourceRoot !== realpathSync(ctx.root)')
  && routeRestorationSource.includes('canonicalDigest(restored.assessment?.proposalRef) !== canonicalDigest(source)')
  && routeRestorationSource.includes('sourceRouteRecord(source, receipt.source, false, readRestoration)'),
  'route restoration must retain internal reader and exact root/proposal binding');

assert(read('packages/main/src/registry.ts').includes('createFindingRouteHandlers(ctx, readRouteSourceRestoration)')
  && read('packages/main/src/registry.ts').includes('createFindingHistoryHandlers(ctx, observeDeferralInvalidation, readRouteSourceRestoration)'),
  'official route/history composition must install signed restoration reader');

assert(read('packages/main/src/handlers/finding-material-reattestation.ts').includes('readMaterialDriftReattestation(ctx, source.storyId, source.recordId)')
  && read('packages/main/src/core/process-fact-registry.ts').includes('sourceRestorationBoundary'),
  'restoration adapter and process registry must retain signed native verification');

const findingDagOwners = [
  ['3A', 'core/finding-ledger.ts'],
  ['3B', 'core/runtime-evidence-receipt.ts'], ['3B', 'core/finding-runtime-evidence.ts'],
  ...['core/finding-identity.ts', 'core/finding-history.ts', 'core/finding-route.ts', 'core/finding-progress.ts',
    'handlers/finding-identity.ts', 'handlers/finding-identity-store.ts', 'handlers/finding-history.ts', 'handlers/finding-route.ts'].map(path => ['Story2', path]),
];

for (const [owner, path] of findingDagOwners) {
  for (const issue of findingDagDependencyIssues(read(`packages/main/src/${path}`), owner)) fail(`${issue} in ${path}`);
}

const findingDagForbiddenCases = [
  ['3A', '3B', './runtime-evidence-receipt.js'], ['3A', 'Story2', './finding-identity.js'], ['3A', 'Story1', './finding-applicability.js'],
  ['3B', 'Story2', './finding-identity.js'], ['3B', 'Story1', './finding-applicability.js'],
  ['Story2', '3B', './runtime-evidence-receipt.js'], ['Story2', 'Story1', './finding-applicability.js'],
  ['Story2', '3B', './finding-runtime-evidence.js'],
];

for (const [owner, provider, dependency] of findingDagForbiddenCases) {
  for (const source of [`import { x } from '${dependency}';`, `export { x } from '${dependency}';`, `await import('${dependency}');`, `require('${dependency}');`]) {
    assert(findingDagDependencyIssues(source, owner).some(issue => issue === `FINDING_DAG_FORBIDDEN: ${owner}->${provider}: ${dependency}`), `FINDING_DAG_MUTATION_MISSED: ${owner}->${provider}`);
  }
}

for (const [owner, dependency] of [
  ['3B', './finding-ledger.js'], ['Story2', './finding-ledger.js'], ['Story1', './finding-ledger.js'],
  ['Story1', './runtime-evidence-receipt.js'], ['Story1', './finding-route.js'],
  ['3B', './runtime-evidence-receipt.js'], ['Story2', './finding-identity.js'], ['3A', './authority-signing.js'],
]) assert(findingDagDependencyIssues(`import { x } from '${dependency}';`, owner).length === 0, `FINDING_DAG_ALLOWED_EDGE_REJECTED: ${owner} ${dependency}`);

function story2DependencyIssues(source) {
  const issues = []; const parsed = ts.createSourceFile('story2.ts', source, ts.ScriptTarget.Latest, true);
  const visit = node => {
    const dependency = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
    if (dependency && ts.isStringLiteral(dependency)
      && /(?:runtime-evidence-receipt|finding-runtime-evidence|dynamic-finding-blocking|finding-(?:applicability|assessment|triage|deferral|mandatory-repair|rollout|ledger-runtime-smoke|ledger-enforce))/.test(dependency.text)) issues.push('Story1/3B dependency');
    if (ts.isCallExpression(node) && /^(?:readJson|readJsonCandidate)$/.test(ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(parsed))) issues.push('protected parser');
    ts.forEachChild(node, visit);
  }; visit(parsed); return issues;
}

for (const file of ['core/finding-identity.ts', 'core/finding-history.ts', 'core/finding-route.ts', 'core/finding-progress.ts',
  'handlers/finding-identity.ts', 'handlers/finding-identity-store.ts', 'handlers/finding-history.ts', 'handlers/finding-route.ts']) {
  const source = read(`packages/main/src/${file}`);
  for (const issue of story2DependencyIssues(source)) fail(`Story2 ${file}: ${issue}`);
  for (const injection of ["import { gate } from './finding-deferral.js';", "import { enforce } from './finding-ledger-runtime-smoke.js';", "store.readJson(storyId, 'findings.json');", "import { gate } from './finding-applicability-projection.js';", "export { gate } from './finding-applicability.js';", "await import('./finding-applicability.js');"]) {
    assert(story2DependencyIssues(`${source}\n${injection}`).length > 0, `Story2 dependency verifier detects ${injection}`);
  }
}

assert(read('packages/main/src/registry.ts').includes('createFindingHistoryHandlers(ctx, observeDeferralInvalidation, readRouteSourceRestoration)'), 'Official recall composition must supply the Story1 provider');

assert(read('packages/main/src/handlers/finding-history.ts').includes('deferral invalidation provider unavailable'), 'Standalone Story2 must refuse unavailable provider');

assert(read('packages/main/src/core/process-fact-registry.ts').includes('invalidationComposition:'), 'Recall provider boundary requires registry coverage');

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

assert(read(processFactRegistryPath).includes('...PROCESS_FACT_EVIDENCE_HASH_INPUTS'), 'Evidence hash input facts must be registered');

const hashPolicySource = read('packages/main/src/core/material-path-policy.ts');

for (const boundary of ['objects/sha256/', 'refs/by-id/', 'ledger/observed.jsonl']) assert(hashPolicySource.includes(boundary), `Missing bounded evidence output location: ${boundary}`);

assert(read('packages/main/src/core/story-git-bytes.ts').includes("'--name-status', '-z'") && read('packages/main/src/core/story-aware-validation.ts').includes("raw.diff.split('\\0')"), 'Story diff must preserve NUL-framed Git filenames');

assert(read('packages/main/src/tasks/story-files-hash-batch-smoke.ts').includes('verify-hash-accuracy.mjs'), 'Independent hash oracle must run in the existing validation inventory');

const immutablePublicationSource = read('packages/main/src/core/done-prepare-generated-metadata.ts');

for (const token of ['isRegularMetadataPath', 'lateIndexDrift', 'finalDrift', 'foreignIndex', 'restoreErrors.push']) assert(immutablePublicationSource.includes(token), `Publication recovery protection missing: ${token}`);

assert(read('packages/main/src/tasks/done-prepare-auto-closeout-smoke.ts').includes('scripts/verify-closeout-late-drift-v3.mjs'), 'Full closeout must run the external drift controls');

const doneAdmissionSource = read('packages/main/src/handlers/done-required-validation.ts').split('export function createDoneRequiredValidationHandlers')[1];

assert(doneAdmissionSource.indexOf('}, async () => {') < doneAdmissionSource.indexOf('requireCurrentHeavyCertificationWindow({'), 'Mutating certification admission must execute inside official validation ownership');

assert(doneAdmissionSource.includes('donePolicyConfigIdentity(ctx.root) !== policyConfigIdentity'), 'Queued policy drift must not be hidden by process-cached configuration');

assert(read('packages/main/src/tasks/validate-execution-lock-smoke.ts').includes('UNADMITTED_DONE_REQUIRED_GREEN') && read('packages/main/src/tasks/validate-execution-lock-smoke.ts').includes('QUEUED_POLICY_DRIFT_GREEN'), 'Admission requires zero-execution and queued physical-policy drift controls');

const certificationAdvanceSource = read('packages/main/src/core/certification-window.ts');

for (const token of ["prior.state !== 'ADMITTED'", "next.state !== 'RUNNING'", 'verifyCertificationWindow(prior)', 'verifyCertificationWindow(next)', 'verifyPrecertReceipt(receipt)', 'windowAuthorizesHeavyCertification(prior, receipt)', 'isDeepStrictEqual(after,']) {
  assert(certificationAdvanceSource.includes(token), `Bounded certification closeout authority check missing: ${token}`);
}

assert(read('packages/main/src/handlers/done-prepare.ts').includes('isCertificationRunningOnlyAdvance(JSON.parse(before.output), JSON.parse(after.output), storyId)'), 'Closeout must verify certification content deltas rather than trust a filename');

assert(read('packages/main/src/tasks/done-prepare-auto-closeout-smoke.ts').includes('scripts/verify-closeout-certification-order.mjs'), 'Existing full closeout regression must run the certification delta controls');

const publicationVerifier = read('packages/main/src/handlers/verifier.ts');

assert(publicationVerifier.includes('VALIDATION_PUBLICATION_NOT_READY') && publicationVerifier.indexOf('VALIDATION_PUBLICATION_NOT_READY') < publicationVerifier.indexOf('if (!args.noSync)'), 'Publication readiness must precede invocation-owned cluster synchronization');

assert(publicationVerifier.includes('assertCurrentValidationPublicationOwner(ctx.root, storyId)') && publicationVerifier.includes('assertCurrentValidationPublicationOwner(args.ctx.root, args.storyId)'), 'Both executed and reused publication require current ownership');

assert(publicationVerifier.includes('VALIDATION_TERMINAL_RECEIPT_MISSING'), 'Canonical publication requires an explicit terminal receipt');

assert(publicationVerifier.includes('terminal.start !== before.length'), 'Terminal append must bind captured baseline bytes');

assert(read('packages/main/src/core/auto-commit-metadata.ts').includes('verifiedHashes: args.expectedHashes'), 'Validation publication must consume intended hashes rather than reread-authorize outputs');

assert(read('packages/main/src/tasks/done-prepare-auto-closeout-smoke.ts').includes('scripts/probe-validation-publication-integrity.mjs'), 'Registered closeout regression must execute publication integrity controls');

assert(read('packages/main/src/core/done-prepare-generated-metadata.ts').includes('foreign index entries preserved'), 'Index recovery must preserve unowned entries');

assert(read('packages/main/src/handlers/done-prepare.ts').includes('expectedHashes: expectedCloseoutOutputs'), 'Outer closeout rollback must bind intended outputs');

assert(read('packages/main/src/handlers/done-prepare.ts').includes('rollback.rollbackConflicts'), 'Selective rollback conflicts must be surfaced without treating every refusal as rollback failure');

assert(read('packages/main/src/tasks/done-prepare-auto-closeout-smoke.ts').includes('DONE_PREPARE_OUTER_FOREIGN_INDEX_GREEN'), 'Actual outer closeout branch must prove foreign preservation');

assert(read('packages/main/src/handlers/proofstory.ts').includes('withScopeShrinkageTransaction'), 'Withdrawal must use checkpoint-aware compensation');

assert(read('packages/main/src/handlers/certification-window.ts').includes('isValidationMetadataBusy(error)'), 'Certification persistence contention must propagate');

assert(read('packages/main/src/tasks/scope-shrinkage-withdrawal-floor-smoke.ts').includes('probe-scope-checkpoint-interrupted.mjs'), 'Checkpoint interruption must be registered');

for (const probe of ['probe-scope-checkpoint-compensation.mjs', 'probe-scope-transaction-boundaries.mjs', 'probe-closeout-busy-propagation.mjs']) assert(read('packages/main/src/tasks/scope-shrinkage-withdrawal-floor-smoke.ts').includes(probe), 'Missing scope control: ' + probe);

for (const token of ['runScopeGateAndDiffPack', 'VALIDATION_SCOPE_NOT_READY', '[missing_scope_contract]', '[scope_contract_unreadable]']) assert(read('packages/main/src/handlers/verifier.ts').includes(token), 'Missing scope preflight contract: '+token);

assert(read('packages/main/src/tasks/verification-freshness-smoke.ts').includes('probe-validation-scope-readiness.mjs'), 'Freshness smoke must exercise real scope preflight');

assert(read('packages/main/src/handlers/done-prepare.ts').includes('const reviewPrerequisite'), 'Closeout must diagnose review before execution');

assert(read('packages/main/src/tasks/done-prepare-auto-closeout-smoke.ts').includes('UPSTREAM_REVIEW_MUST_REFUSE_BEFORE_COMMANDS'), 'Actual closeout command count must be protected');

for (const token of ['expectedPendingWindowId', 'nonInventoryAdmitRefusal', 'persistAdmittingCertificationWindow']) assert(read('packages/main/src/core/certification-window.ts').includes(token), 'Missing admission contract: '+token);

assert(read('packages/main/src/core/review-inventory-epoch.ts').includes('consumeReviewInventoryCompletenessReceiptUnlocked'), 'Admission must avoid nested inventory mutex');

assert(read('packages/main/src/tasks/certification-window-smoke.ts').includes('certification-admission-recovery.mjs'), 'Recovery protocol controls must remain registered');

assert(read('packages/main/src/handlers/graph.ts').includes('readManagedRunDashboard(probe.root!)'), 'Graph must wire real managed runtime observations');

assert(read('packages/graph/src/shells/web/app.js').includes('renderManagedRunStatus(st)'), 'Graph status polling must render managed changes independently');

assert(read('packages/main/src/handlers/verifier.ts').includes('dynamicValidationPreflightFallbackReasons(projectRoot, dynamic)'), 'dynamic rejection preflight must guard real validation launch');

assert(read('packages/main/src/handlers/validation-pass-admissibility.ts').includes('storedDynamicReceiptIntegrityReasons'), 'TEST admissibility must recheck stored dynamic receipt integrity');

const repeatLaunchSource = read('packages/main/src/handlers/reviewer-batch.ts');

for (const token of ['blockingObservationAwaitsRepair', 'CURRENT_MATERIAL', 'KNOWN_METADATA_ONLY_HEAD_DRIFT', 'classifyEvidenceFreshness']) {
  nodeAssert.ok(repeatLaunchSource.includes(token), 'Missing bounded repeat-launch contract: ' + token);
}

{
  const mappingSource = read(processFactRegistryPath);
  for (const token of [
    'projectProcessFactRegistry',
    'projectComponentProcessFactMapping',
    'registry-component-mapping-unavailable',
    'process-generated-without-lineage',
    'runtime:registry_component_mapping_projection',
  ]) assert(mappingSource.includes(token), `${processFactRegistryPath}: P0m mapping contract missing ${token}`);
  const sourceProbe = execFileSync(process.execPath, [
    '--import', join(root, 'scripts/lab-source-loader.mjs'),
    '--input-type=module',
    '--eval',
    `import { PROCESS_FACT_REGISTRY, projectProcessFactRegistry, projectComponentProcessFactMapping } from './packages/main/src/core/process-fact-registry.ts';
const projection = projectProcessFactRegistry();
const p0m = projectComponentProcessFactMapping('P0m');
let refusal = null;
try { projectProcessFactRegistry([{ kind: 'artifact', paths: ['missing-id.ts'] }]); } catch (error) { refusal = error?.code; }
process.stdout.write(JSON.stringify({ ownerCoverage: projection.find(entry => entry.factId === 'runtime:plan_selected_owner_coverage'), registry: PROCESS_FACT_REGISTRY.length, projection: projection.length, generatedInWhole: projection.some(entry => Object.hasOwn(entry, 'generatedFrom')), p0m: p0m.length, p0mOnly: p0m.every(entry => entry.componentId === 'P0m'), refusal }));`,
  ], { cwd: root, encoding: 'utf8' });
  const sourceResult = JSON.parse(sourceProbe);
  assert(sourceResult.ownerCoverage?.paths?.includes('packages/main/src/core/plan-touchpoint-coverage.ts'), 'selected owner coverage must be canonically registered');
  assert(sourceResult.registry > 0 && sourceResult.projection === sourceResult.registry,
    'current source process registry component mapping must be total');
  assert(sourceResult.generatedInWhole === false, 'whole process registry projection must omit generatedFrom');
  assert(sourceResult.p0m > 0 && sourceResult.p0mOnly === true,
    'P0m component-filtered process mapping must be explicit and non-empty');
  assert(sourceResult.refusal === 'registry-component-mapping-unavailable',
    'process registry missing mapping must use the typed unavailable diagnostic');
  const ownerCoverageSource = read('packages/main/src/core/plan-touchpoint-coverage.ts');
  assert(ownerCoverageSource.includes("input !== undefined && (!Array.isArray(input) || input.length !== 0)"),
    'zero mapped owners must accept omitted or empty owner dispositions while rejecting non-empty input');
  assert(read('packages/main/src/handlers/story-dispatch.ts').includes('omit ownerDispositions or submit an empty array'),
    'scope reviewer prompt must explain the zero-owner disposition contract');
  assert(read('packages/main/src/cli/command-catalog.ts').includes('omit or use [] when the mapped-owner count is zero'),
    'scope_check_save command schema must explain the zero-owner disposition contract');
}

{
  const guards = [
    ['packages/main/src/core/finding-applicability-projection.ts', 'rollout.killSwitch || (!args.diagnostic', 'verifiedIdentityCarrier(ledger', 'readMaterialBoundRepairRuntimeEvidence({'],
    ['packages/main/src/handlers/finding-ledger.ts', 'receipt.sourceMaterialHash !== material', "['merge-base', '--is-ancestor', receipt.headHash, currentHead]", 'closureReuse ? receipt.headHash : currentHead'],
    ['packages/main/src/core/finding-validation.ts', "rollout.mode !== 'enforce'", 'scopeExpansionAuthorized: false'],
    ['packages/main/src/handlers/finding.ts', "hasObligation && rollout.mode === 'enforce' && !rollout.killSwitch"],
    ['packages/main/src/handlers/finding-applicability-proof.ts', 'readCurrentFindingRuntimeEvidence(ctx', 'row.stdout.includes(intent.selector)', 'FINDING_PROTECTED_SURFACES.every'],
    ['packages/main/src/handlers/finding-deferral-proof.ts', 'readFindingRouteProgressProof(ctx', 'assertNoCanonicalDeferralReset(ctx', 'previous.payload.renewalCount! + 1'],
    ['packages/main/src/handlers/finding-applicability.ts', 'revalidateDeferrals.forEach(check => check())', 'repairClosureContext(currentApplicabilityContext'],
    ['packages/main/src/handlers/finding-qualification.ts', 'createFindingLedgerHandlers(ctx).finding_ledger_query', 'createFindingHistoryHandlers(ctx).finding_identity_scorecard', 'measurements: cases.flatMap(row => row.queryMeasurements ?? [])', 'collectFindingQualificationEvents(ctx', 'qualification_case_requires_query_event_recollection', 'collectQualificationSubjectAdjudications(ctx', '(row.subjectAdjudications ?? []).map(row => row.ref)', 'prerequisites: admissionPrerequisites', "currentPrerequisites = 'invalid'", 'report.qualification.eligible = report.refusalReasons.length === 0', 'readQualificationSubjectCensus(source, id)', 'findingLedgerTrustFromWorkspace(ctx.root)', 'verifyFindingLedgerQueryRow(row, trust)', 'ledgerDetails.recordCount !== details.records.length', 'recordIds.has(row.recordId)', 'canonicalHash(census.evidenceDigests)'],
    ['packages/main/src/handlers/finding-collection.ts', "authority: 'diagnostic_only'", 'gateEvidence: false', 'automaticEnrollment: false', 'FINDING_QUALIFICATION_SUBJECT_KINDS.has', "state: 'unavailable'", 'qualificationCases: null'],
    ['packages/main/src/handlers/finding-qualification-adjudication.ts', 'authors.has(adjudicator)', 'exactLedgerRecordHash(proposal) !== ref.recordHash', 'applicabilityDigest(Object.keys(observed).sort())', 'correct: applicabilityDigest(observed) === applicabilityDigest(input.expected)'],
    ['packages/main/src/handlers/finding-qualification-prerequisites.ts', 'readCurrentFindingRuntimeEvidence(ctx', 'runtime.receipt.headHash !== ref.mergedCommit', 'pin.command === command && pin.selector === selector', 'readHistoricalFindingRuntimeEvidence(ctx', 'runtime.receipt.receiptHash !== proof.runtimeReceiptHash'],
    ['packages/main/src/core/finding-rollout-qualification.ts', 'conflicting_performance_source:', '!QUALIFICATION_PERFORMANCE_METRICS.includes(row.metric)', 'executed-merged-prerequisites-and-unique-performance-sources-v1'],
    ['packages/main/src/handlers/finding-qualification-events.ts', 'performanceSource: { ...source, attemptId: row.attemptId }', 'conflicting cohort timing'],
    ['packages/main/src/handlers/finding-runtime-pair.ts', 'readHistoricalFindingRuntimeEvidence(ctx', 'readCurrentFindingRuntimeEvidence(ctx', 'base.receipt.executionCommandDigest !== head.receipt.executionCommandDigest', 'b[key] > a[key]'],
    ['packages/main/src/handlers/finding-material-reattestation.ts', 'verifyDynamicFindingRecord(record, trust.publicKey)', 'current.storyFilesHash !== assessment.integrity.storyFilesHash', 'checkedReexecution(ctx', 'reviewPassDigest', "record.driftKind === 'head_only'", 'old.baseHash === current.baseHash', "['merge-base', '--is-ancestor', prior, current]", 'current.baseHash !== record.currentBinding.baseHash'],
    ['packages/main/src/handlers/finding-deferral-recall.ts', "rollout.mode === 'observe'", 'findingHistoryRecallObservation(ctx', 'observed.triggerDigest'],
  ];
  for (const [path, ...required] of guards) {
    const source = read(path);
    const check = value => required.every(token => value.includes(token));
    assert(check(source), `${path}: dynamic Finding evidence contract missing`);
    for (const token of required) assert(!check(source.replaceAll(token, 'REMOVED_DFEC_GUARD')),
      `${path}: dynamic Finding guard mutation escaped: ${token}`);
  }
  const qualificationSource = read('packages/main/src/handlers/finding-qualification.ts');
  const publicReducer = qualificationSource.slice(qualificationSource.indexOf('function readQualificationSubjectCensus('));
  assert(publicReducer.length < qualificationSource.length && !publicReducer.includes('.readFindingLedger'),
    'scorecard reducer and census helper must stay on the signed public query boundary');
  const policy = read(processFactRegistryPath);
  for (const token of ['PROCESS_FACT_DYNAMIC_FINDING_POLICY', 'reported statistics remain diagnostic', 'findingConstraintDigest']) {
    assert(policy.includes(token), `dynamic Finding process registry must describe ${token}`);
  }
  for (const token of ['finding_assessment_propose', 'finding_runtime_evidence_run', 'signed PASS', 'killSwitch=true']) {
    assert(read('packages/main/src/core/prompt-registry.ts').includes(token), `dynamic Finding prompt contract must describe ${token}`);
  }
  const closureCommand = JSON.parse(read('packages/main/package.json')).scripts['test:dynamic-finding-evidence-closure'];
  const headRecoveryCommand = 'node dist/tasks/finding-material-reattestation-smoke.js --head-continuity';
  assert(closureCommand.split(' && ').includes(headRecoveryCommand), 'dynamic Finding head-only regression must remain in the registered package chain');
  for (const flag of ['--collection-proof', '--qualification-history-proof']) {
    assert(closureCommand.split(' && ').includes(`node dist/tasks/dynamic-finding-runtime-integration-smoke.js ${flag}`),
      `dynamic Finding collection regression must remain registered: ${flag}`);
  }
  assert(!closureCommand.replace(headRecoveryCommand, 'REMOVED_HEAD_RECOVERY_REGRESSION').split(' && ').includes(headRecoveryCommand),
    'dynamic Finding head-only registration removal must be detected');
}

{
  const context = readFileSync(join(root, 'packages/main/src/core/review-incremental-context.ts'), 'utf8');
  const producer = readFileSync(join(root, 'packages/main/src/handlers/review-run.ts'), 'utf8');
  const consumer = readFileSync(join(root, 'packages/main/src/core/review-run.ts'), 'utf8');
  const envelope = readFileSync(join(root, 'packages/main/src/core/prompt-envelope.ts'), 'utf8');
  const contracts = readFileSync(join(root, 'packages/main/src/core/prompt-contracts.ts'), 'utf8');
  assert(producer.includes('resolveFullStoryBaseHead(store, signedWorkspaceRoot, args.storyId)'), 'Review-run producer must resolve its own full-story comparison base');
  assert(!producer.includes('args.fullStoryBaseHead'), 'Caller-supplied full-story base cannot become evidence');
  assert(context.includes('resolveStoryIntegrationTarget(gitCwd, story)')
    && context.includes('story.integrationTarget !== undefined')
    && context.includes('FULL_STORY_BASE_INVALID:'), 'Review-run comparison base must distinguish a frozen Story integration target from legacy fallback and fail closed on malformed stored authority');
  assert(context.includes("['rev-parse', '--verify', `${ref}^{commit}`]"), 'Full-story base must resolve to an existing commit, not merely a revision-shaped string');
  assert(context.includes('FULL_STORY_BASE_UNAVAILABLE:'), 'Unavailable signed comparison bases must have a distinct refusal');
  assert(context.includes('changedFilesBetweenRenameAware(gitCwd, fullStoryBaseRef, asOfRef)')
    && context.includes('fixtureCaseClosure(gitCwd, fullStoryBaseRef, storyId, path, currentStoryIntentRefs, asOfRef)')
    && context.includes('changedFileStatusesBetweenRenameAware(gitCwd, fullStoryBaseRef, asOfRef)'), 'Every full-diff probe must use the same bound base');
  assert(context.includes('...(fullStoryBaseHead !== undefined ? { fullStoryBaseHead } : {})'), 'Legacy eligibility digests must omit the new base key entirely');
  assert(envelope.includes('...(input.fullStoryBaseHead !== undefined ? { fullStoryBaseHead: input.fullStoryBaseHead } : {})'), 'Optional comparison base must enter the authenticated envelope bytes');
  assert(consumer.includes('fullStoryBaseHead: envelope.fullStoryBaseHead'), 'Historical verifier must consume the signed comparison base');
  assert(contracts.includes('validateFullStoryBaseHead(record.fullStoryBaseHead)'), 'Prompt contract must validate the base object-id syntax');
  assert(readFileSync(join(root, 'packages/main/src/core/process-fact-registry.ts'), 'utf8').includes('optional fullStoryBaseHead'), 'Comparison-base process semantics must remain registered');
}

{
  const provenance = read('packages/main/src/core/topology-critic-receipt.ts');
  const dispatch = read('packages/main/src/handlers/story-dispatch.ts');
  const receipt = read('packages/main/src/handlers/proofstory.ts');
  assert(provenance.includes("['log', `${baseCommit}..HEAD`")
    && !provenance.includes("['log', 'main..HEAD'")
    && !provenance.includes("['log', '-n', '50'"),
  'Topology implementation provenance must use only the frozen commit range');
  assert(dispatch.includes('resolveFullStoryBaseHead(store, root, story.storyId)')
    && dispatch.includes('story.integrationTarget !== undefined')
    && dispatch.includes('currentImplementationBusinessCommit(gitCwd, frozenStoryBase)'),
  'Topology dispatch must bind implementation provenance to the frozen Story base');
  assert(receipt.includes('resolveFullStoryBaseHead(store, ctx.root, storyId)')
    && receipt.includes('story.integrationTarget !== undefined')
    && receipt.includes('deriveImplementationProvenance(')
    && receipt.includes('frozenStoryBase,'),
  'Topology receipt production must verify implementation provenance against the frozen Story base');
  assert(provenance.includes('IMPLEMENTATION_PROVENANCE_COMMIT_MISSING')
    && dispatch.includes('topologyProvenanceDiagnostic')
    && dispatch.includes('required,'),
  'Topology provenance refusal must expose stable optional/required diagnostics');
}

if (failures.length) {
  console.error('');
  console.error('Process fact contract failed:');
  for (const message of failures.sort()) console.error(`- ${message}`);
  process.exit(1);
}

assert(read(processFactRegistryPath).includes('runtime:headless_baseline_production'), 'Headless baseline boundary must be registered');

assert(read('packages/main/src/tasks/story-aware-validation-production-smoke.ts').includes('HEADLESS_BASELINE_REFUSED'), 'Producer must test no-HEAD refusal without baseline writes');

nodeAssert.ok(readFileSync(join(root, 'packages/main/src/core/validation-artifact-signing.ts'), 'utf8').includes('gitCwd = resolveValidationSigningRoot()'));

nodeAssert.ok(readFileSync(join(root, 'packages/main/src/handlers/story-aware-validation.ts'), 'utf8').includes('withValidationSigningRoot(projectSigningRoot(projectRoot)'));

nodeAssert.ok(readFileSync(join(root,'packages/main/src/handlers/verifier.ts'),'utf8').includes("reuseEconomics: 'measured'"));

nodeAssert.ok(readFileSync(join(root,'packages/main/src/handlers/done-required-validation.ts'),'utf8').includes("reuseEconomics:'measured'"));

nodeAssert.ok(read(processFactRegistryPath).includes('schedulerWaitMs is diagnostic'));

{
  const progress = read('packages/main/src/core/convergence-progress-journal.ts');
  for (const token of ['verifyValidationArtifact', 'signValidationArtifact', 'finalizedLiveAggregateError', 'readFindingLedger', 'buildVerificationCoverage', 'collectReviewerEvidenceState', 'revokedCompletedEpochIds', 'assessEffectiveProgress', 'hasMechanicalExecutionAuthority', 'captureEvidenceHashSnapshot']) {
    assert(progress.includes(token), `U11 progress authority missing ${token}`);
  }
  for (const token of ['consumedByCertificationWindowId: _epochWindow', 'consumedByCertificationWindowId: _receiptWindow']) assert(progress.includes(token), `U11 legitimate certification consumption must preserve completion claims: ${token}`);
  assert(read('packages/main/src/handlers/review-inventory.ts').includes('captureConvergenceProgress(ctx, args.storyId, finalized.epochId)'), 'U11 actual inventory finalization must record verified progress');
  assert(read('packages/main/src/core/process-fact-registry.ts').includes('artifact:convergence-progress.json'), 'U11 signed progress artifact must be registered');
  assert(read('packages/main/src/handlers/finding.ts').includes('reviewPurpose: run.reviewPurpose, inventoryBinding: run.inventoryBinding'), 'native direct terminal authority must retain the signed review purpose');
}

assert(read('packages/main/src/handlers/review-remediation.ts').includes('hasMechanicalExecutionAuthority'), 'remediation and progress must share exact mechanical execution authority');

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
  assert(outputReader.includes("index.schemaVersion === CAUSAL_EVIDENCE_INDEX_SCHEMA")
    && outputReader.includes('verifyCausalEvidenceReceipt(receipt)')
    && outputReader.includes('verified.get(key) === hash'), 'CAS output exemption must match canonical writer and authenticated exact receipt map');
  const regression = read('scripts/verify-canonical-journal-authority.mjs');
  for (const token of ['executeCausalEvidence', 'execFileSync(command.executable', 'CANONICAL_INDEX_WRITER_MUST_BE_RECOGNIZED', 'controller.propose', 'recordConvergenceProgress', 'signValidationArtifact(c,root)', 'acceptanceAmendmentBlocker', 'readConvergenceProgress'])
    assert(regression.includes(token), `Canonical journal real producer regression missing ${token}`);
}

{
  const core = read('packages/main/src/core/review-inventory-epoch.ts');
  const handler = read('packages/main/src/handlers/review-inventory.ts');
  assert(core.includes('export function reviewInventoryFinalizedNextCommand'), 'inventory advice must have one receipt-bound selector');
  assert(core.includes('verifyReviewInventoryReceipt(receipt)') && core.includes('REVIEW_INVENTORY_RECEIPT_INVALID'), 'inventory advice must refuse invalid authority');
  assert(handler.includes('reviewInventoryFinalizedNextCommand(pendingReceipt.epoch, pendingReceipt.receipt)'), 'duplicate begin must retain finalized receipt guidance');
  assert(handler.includes('reviewInventoryFinalizedNextCommand(epoch, projection.receipt)'), 'status must use the same finalized authority');
  assert(handler.includes('Authority: ${receipt.authority}'), 'first finalize must print actual authority');
}

execFileSync(process.execPath, [join(root, "packages/main/tests/certification-consumed-saturation.mjs")], { cwd: root, stdio: "inherit", timeout: 30000 });

execFileSync(process.execPath, [join(root, 'packages/main/tests/certification-mutator-identity.mjs')], { cwd: root, stdio: 'inherit', timeout: 30000 });

function boundaryProofCompletion(resolveProof, rejectProof, label, marker) {
  return (error, stdout, stderr) => {
    try {
      if (error) { Object.assign(error, { stdout, stderr }); throw error; }
      nodeAssert(stdout.includes(marker), label + ' requires its exact completion selector');
      resolveProof();
    } catch (failure) {
      rejectProof(new Error(failure?.signal
        ? 'PROOF_UNAVAILABLE: ' + label + '\n' + String(failure) + '\n' + stdout + '\n' + stderr
        : verificationFailureMessage(label, failure)));
    }
  };
}

const boundaryProofResults = await Promise.allSettled([
  new Promise((resolveProof, rejectProof) => {
    execFile(process.execPath, [join(root, 'scripts/verify-reviewer-read-boundaries.mjs')], {
      cwd: root, encoding: 'utf8', timeout: 450000,
    }, boundaryProofCompletion(resolveProof, rejectProof, 'reviewer read boundary', 'REVIEWER_READ_BOUNDARY_GREEN'));
  }),
  new Promise((resolveProof, rejectProof) => {
    execFile(process.execPath, [join(root, 'scripts/verify-maintenance-preview-boundaries.mjs')], {
      cwd: root, encoding: 'utf8', timeout: 450000,
    }, boundaryProofCompletion(resolveProof, rejectProof, 'maintenance preview', 'MAINTENANCE_PREVIEW_GREEN'));
  }),
]);

for (const result of boundaryProofResults) {
  if (result.status === 'rejected') assert(false, String(result.reason));
}

if (boundaryProofResults.every(result => result.status === 'fulfilled')) console.log('PROCESS_BOUNDARY_PROOFS_COMPLETE 2');

assert(read(processFactRegistryPath).includes('Focused process-boundary proofs retain both actual CLI executions'),
  'Process boundary proof concurrency must remain registered with complete failure propagation');

{
  const engine = read('packages/main/src/cli-engine.ts');
  assert(engine.includes('commandObservationEffects(effectiveOwnership,')
    && engine.includes('commandObservationEffects(eventOwnership).recordStoryEvent'),
    'Command effects and generic Story events must share effective admission ownership');
  const engineAst = ts.createSourceFile('cli-engine.ts', engine, ts.ScriptTarget.Latest, true);
  const legacy = new Set(['isReadOnlyCommand', 'READ_ONLY_COMMANDS', 'shouldWriteActivityLog']);
  let legacyConsumption = false;
  const inspect = node => {
    if (ts.isImportSpecifier(node) && legacy.has((node.propertyName ?? node.name).text)) legacyConsumption = true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && legacy.has(node.expression.text)) legacyConsumption = true;
    ts.forEachChild(node, inspect);
  };
  inspect(engineAst);
  assert(!legacyConsumption, 'cli-engine must not consume compatibility name-only observation helpers; direct compatibility re-exports remain available');
  assert(read('packages/main/src/core/process-fact-registry.ts').includes('Generic CLI command observation consumes argument-aware effective ownership'), 'Command observation semantics must be registered');
  try {
    const output = execFileSync(process.execPath, [join(root, 'scripts/verify-command-observation-boundaries.mjs')], {
      cwd: root, encoding: 'utf8', timeout: 450000,
    });
    assert(output.includes('COMMAND_OBSERVATION_GREEN'), 'Real CLI, worktree and lock observation proof must pass');
    execFileSync(process.execPath, [join(root, 'scripts/verify-command-observation-controls.mjs')], { cwd: root, stdio: 'pipe', timeout: 30000 });
  } catch (error) { assert(false, verificationFailureMessage('Command observation', error)); }
}

for (const [path, tokens] of [
 ['packages/main/src/core/plan-touchpoint-coverage.ts',['projectProcessFactRegistry','signValidationArtifact','verifyValidationArtifact','validateOwnerDispositions']],
 ['packages/main/src/handlers/scope-check.ts',['signPlanOwnerCoverage','dispatched-env']],
 ['packages/main/src/handlers/story-review.ts',['planOwnerCoverageFailure']],
 ['packages/main/src/core/machine.ts',['planOwnerCoverageFailure']],
 ['packages/main/src/handlers/story-dispatch.ts',['ownerDispositions']],
]) for (const token of tokens) assert(read(path).includes(token), 'Missing selected owner contract: '+path+':'+token);

for (const file of ['process-fact-registry','command-policy','process-fact-levels','flow-fact-policy','managed-artifact-descriptors']) {
  assert(read('packages/main/src/core/plan-touchpoint-coverage.ts').includes('packages/main/src/core/'+file+'.ts'), 'Unbound registry projection input: '+file);
}

for (const [file, expected] of [
 ['process-fact-registry',['./command-policy.js','./flow-fact-policy.js','./managed-artifact-descriptors.js','./process-fact-levels.js','node:path']],
 ['command-policy',[]], ['process-fact-levels',[]],
 // This helper import serves only evaluator functions, not the literal FLOW_FACT_POLICIES projection.
 ['flow-fact-policy',['./agent-dispatch-registry.js']],
]) {
 const source=read('packages/main/src/core/'+file+'.ts');
 const imports=[...source.matchAll(/^import[\s\S]*?from ['"]([^'"]+)['"]/gm)].map(match=>match[1]).sort();
 assert(JSON.stringify(imports)===JSON.stringify([...expected].sort()), 'Review changed registry projection import dependencies: '+file);
}

const baselineResolver = read('packages/main/src/core/git-baseline.ts');

for (const token of ['linkedWorktree && primaryBranch', "'refs/remotes/origin/' + primaryBranch.slice", "'--is-ancestor', remoteCommit, localCommit", 'add(remoteHead)']) {
  assert(baselineResolver.includes(token), 'Missing local integration baseline boundary: ' + token);
}

assert(read('packages/main/src/core/process-fact-levels.ts').includes('same-named primary local branch'), 'Baseline policy rationale must describe local containment');

assert(read('scripts/verify-local-main-baseline.mjs').includes('LOCAL_MAIN_BASELINE_FALSE_SCOPE'), 'Native baseline regression must remain available');

{
  const review = read('packages/main/src/core/review-run.ts');
  const nativeRead = review.slice(review.indexOf("if (authority.reviewGatePath === 'direct-signed-review' && nativeBinding)"));
  const dispatch = nativeRead.slice(0, nativeRead.indexOf('const writerSessionId'));
  if (!dispatch.includes('reviewPurpose: run.reviewPurpose') || !dispatch.includes('inventoryBinding: run.inventoryBinding')) failures.push('native read-side dispatch verification must retain signed purpose and inventory subject');
  if (!read(processFactRegistryPath).includes('Native read-side authority preserves the signed reviewPurpose and inventoryBinding')) failures.push('native read-side purpose binding must be registered');
}

{
  const cert = read('packages/main/src/handlers/certification-window.ts');
  for (const token of ['reviewEpochBatch', 'record ${storyId} review epoch metadata', 'isVerifiedReviewMaintenanceCommit({']) {
    if (!cert.includes(token)) failures.push(`PRE_CERT canonical review epoch continuity missing ${token}`);
  }
  const epochReader=read('packages/main/src/core/review-maintenance-lineage.ts');
  for (const token of ['REVIEW_EPOCH_COMMIT_ARTIFACTS','p.slice(prefix.length)','isPromptBodyArtifactPath(p)']) {
    if (!epochReader.includes(token)) failures.push(`PRE_CERT shared canonical reader missing ${token}`);
  }
  if (cert.includes('prompt-bodies')) failures.push('PRE_CERT must reuse the canonical prompt-body path owner');
  if (!read(processFactRegistryPath).includes('prompt-body paths recognized by the canonical prompt-body store')) failures.push('bounded canonical review epoch continuity must be registered');
  const scripts = JSON.parse(read('package.json')).scripts;
  if (scripts['test:review-epoch-certification-continuity'] !== 'node scripts/verify-review-epoch-certification-continuity.mjs' || !scripts['test:serial-reference'].includes('npm run test:review-epoch-certification-continuity')) failures.push('native review epoch continuity regression must run in the serial reference suite');
}

{
  // Ownership class is exercised programmatically by verify-intent-owner-lease.mjs.
  if(!read('packages/main/src/core/command-policy.ts').includes("checklist_remove: { status: 'supported', ownershipClass: 'storyScopedMutating', allowedPhases: ['INIT']")) failures.push('checklist removal must remain INIT-only');
  const handler = read('packages/main/src/handlers/checklist.ts');
  for (const token of ['INTENT_PROPOSAL_OWNER_REQUIRED','INTENT_PROPOSAL_BINDING_INVALID','verification_intent_writer_phase_invalid','verificationIntentAuthorship','verification_intent_applied','independentlyAttested: false']) if(!handler.includes(token)) failures.push('intent proposal contract missing '+token);
  if (!read(processFactRegistryPath).includes('runtime:independent_intent_owner_lease')) failures.push('intent proposal process registration missing');
  const scripts=JSON.parse(read('package.json')).scripts;
  if(!read('packages/main/src/tasks/full-suite-runner.ts').includes("repoRead('test:intent-owner-lease',")) failures.push('intent proposal regression requires full-suite resource policy');
  if(scripts['test:intent-owner-lease']!=='node scripts/verify-intent-owner-lease.mjs' || !scripts['test:serial-reference'].includes('npm run test:intent-owner-lease')) failures.push('intent proposal regression must remain in serial suite');
}

try {
  const output = execFileSync(process.execPath, [join(root, 'scripts/verify-cli-lab-audit-repairs.mjs')], { cwd: root, encoding: 'utf8', timeout: 450000 });
  assert(output.includes('CLI_LAB_AUDIT_REPAIRS_GREEN'), 'CLI Lab audit repair controls must pass');
} catch (error) { assert(false, verificationFailureMessage('CLI Lab audit repairs', error)); }

try {
  const output = execFileSync(process.execPath, [join(root, 'scripts/verify-cli-audit-hardening.mjs')], { cwd: root, encoding: 'utf8', timeout: 450000 });
  assert(output.includes('CLI_AUDIT_HARDENING_GREEN'), 'CLI audit hardening controls must pass');
} catch (error) { assert(false, verificationFailureMessage('CLI audit hardening', error)); }

try {
  const output = execFileSync(process.execPath, [join(root, 'scripts/verify-cli-audit-closure-controls.mjs')], { cwd: root, encoding: 'utf8', timeout: 450000 });
  assert(output.includes('CLI_AUDIT_CLOSURE_GREEN'), 'Queue, admission, compatibility and shared prerequisite controls must pass');
} catch (error) { assert(false, verificationFailureMessage('CLI audit closure', error)); }

try {
  const output = execFileSync(process.execPath, [join(root, 'scripts/verify-cli-audit-budget-controls.mjs')], { cwd: root, encoding: 'utf8', timeout: 750000 });
  assert(output.includes('CLI_AUDIT_BUDGET_GREEN'), 'CLI budget and companion diagnostic controls must pass');
} catch (error) { assert(false, verificationFailureMessage('CLI budget and diagnostics', error)); }

{
  const authority = read('packages/main/src/core/verification-receipt-authority.ts');
  for (const token of ['validateVerificationReceipt', "validation.kind === 'split-v5'", 'storyId, intentRef:', 'freshness:', 'store.projectRoot', 'Execution authority verifier unavailable', '{ cause: error }']) {
    nodeAssert(authority.includes(token), `execution authority missing V5 binding: ${token}`);
  }
  const remediation = read('packages/main/src/handlers/review-remediation.ts');
  nodeAssert(!remediation.includes('readCausalEvidenceReceipt'), 'publication recheck must not revert to legacy-only authority');
  nodeAssert(remediation.match(/hasMechanicalExecutionAuthority\(ctx.store/g)?.length === 2, 'initial and publication authority must share the strict verifier');
}

const receiptScripts = JSON.parse(read('package.json')).scripts;

nodeAssert(receiptScripts['test:receipt-authority-v5'] === 'node scripts/verify-review-remediation-close.mjs' && receiptScripts['test:serial-reference'].includes('npm run test:receipt-authority-v5'), 'V5 authority regression must run in canonical suite');

nodeAssert(read('packages/main/src/tasks/full-suite-runner.ts').includes("repoRead('test:receipt-authority-v5',"), 'V5 authority needs canonical resource policy');

{
 const receiptSource = read('packages/main/src/core/verification-execution-evidence.ts');
 nodeAssert(receiptSource.includes('location.unchanged(receipt.executionReceipt.cwd)'), 'Receipt validation requires final current signer location comparison');
 nodeAssert(receiptSource.includes('if (cwd !== gitCwd) return null;'), 'Cached location must reject another requested signer cwd');
 nodeAssert(receiptSource.includes("publicKeyForPrivate(readFileSync(join(location.commonDir, VERIFICATION_SIGNER_KEY_FILE), 'utf8').trim())"), 'Each signature stage must read current key bytes');
 nodeAssert(receiptScripts['test:verification-key-location'] === 'node scripts/verify-verification-key-location.mjs' && receiptScripts['test:serial-reference'].includes('npm run test:verification-key-location'), 'Location continuity regression must run in canonical suite');
 nodeAssert(read('packages/main/src/tasks/full-suite-runner.ts').includes("repoRead('test:verification-key-location')"), 'Location regression needs canonical resource policy');
}

const managedCriticArtifact = parseRegistryArrayEntriesFromSource(read(processFactRegistryPath), 'PROCESS_FACT_ARTIFACTS')
  .find(entry => entry.name === 'artifact:managed-inventory-critic-receipt');

assert(managedCriticArtifact?.producer === 'handlers/managed-review-evidence.managed_review_evidence_import'
  && managedCriticArtifact.kind === 'signed-artifact', 'Managed importer must explicitly register its second signed critic artifact');

{
 const source=read(processFactRegistryPath), name='runtime:validation_machine_reservation_delegation';
 const valid=text=>{const row=parseRegistryArrayEntriesFromSource(text,'PROCESS_FACT_VALIDATION_EXECUTION').find(entry=>entry.name===name);return Boolean(row&&row.level==='L4'&&row.kind==='runtime-behavior'&&['runtime-behavior','verification-policy','workspace-binding'].every(value=>row.semantics.includes(value))&&['packages/main/src/core/validation-reservation-delegation.ts','packages/main/src/core/validation-execution-lock.ts','packages/main/src/core/validation-executor.ts'].every(value=>(parseStringArrayProperty(row.block,'producerSourceRefs')??[]).includes(value)));};
 nodeAssert(valid(source),'Controlled machine delegation must retain its structural process-fact declaration');
 const row=parseRegistryArrayEntriesFromSource(source,'PROCESS_FACT_VALIDATION_EXECUTION').find(entry=>entry.name===name);
 for(const block of [row.block.replace(name,'removed-delegation-fact'),row.block.replace("level: 'L4'","level: 'L1'"),row.block.replace("'verification-policy'", "'runtime-behavior'"),row.block.replace("'packages/main/src/core/validation-executor.ts'","'removed-executor.ts'")])nodeAssert(!valid(source.replace(row.block,block)),'Changed delegation declaration must be refused');
}

{
  const registrySource = read(processFactRegistryPath);
  const checklistArtifact = parseRegistryArrayEntriesFromSource(registrySource, 'PROCESS_FACT_ARTIFACTS')
    .find(entry => entry.name === 'artifact:checklist.json');
  assert(checklistArtifact?.producer === 'handlers/story-create and handlers/checklist',
    'checklist artifact must register Story creation and later checklist mutations as producers');
  const checklistArtifactStart = registrySource.indexOf("name: 'artifact:checklist.json'");
  const checklistArtifactEnd = registrySource.indexOf("name: 'artifact:init-check.json'", checklistArtifactStart);
  const checklistArtifactSource = registrySource.slice(checklistArtifactStart, checklistArtifactEnd);
  for (const sourceRef of ['packages/main/src/handlers/story-create.ts', 'packages/main/src/handlers/checklist.ts']) {
    assert(checklistArtifactSource.includes(sourceRef), `checklist artifact producer source missing: ${sourceRef}`);
  }
  const storyCreateSource = read('packages/main/src/handlers/story-create.ts');
  const checklistWrites = [...storyCreateSource.matchAll(/store\.writeChecklist\(storyId, preflightChecklist\)/g)].map(match => match.index);
  const creationCommits = [...storyCreateSource.matchAll(/commitSafeInitMetadata\(storyId\)/g)]
    .map(match => match.index)
    .filter(index => index > (checklistWrites[0] ?? Number.MAX_SAFE_INTEGER));
  assert(checklistWrites.length === 2,
    'story_create must persist the canonical checklist in both explicit and default creation paths');
  assert(creationCommits.length === 3
    && checklistWrites[0] < creationCommits[0]
    && creationCommits[0] < checklistWrites[1]
    && checklistWrites[1] < creationCommits[1]
    && checklistWrites[1] < creationCommits[2],
    'story_create must persist checklist.json before each safe creation commit');
}

{
  const planner = read('packages/main/src/handlers/evidence-plan.ts');
  const fingerprints = read('packages/main/src/core/verification-intent-fingerprints.ts');
  const requireTokens = (label, source, tokens) => {
    for (const requirement of tokens) {
      const [token, expected] = typeof requirement === 'string' ? [requirement, 1] : requirement;
      const occurrences = source.split(token).length - 1;
      assert(occurrences === expected, `${label}: expected ${expected} source occurrence(s) of ${token}, found ${occurrences}`);
    }
  };
  requireTokens('Intent fingerprint diagnostic contract', fingerprints, [
    'collectVerificationIntents(item)',
    'intentFingerprintKey(item.id, ref)',
    'group.intentKeys.push(row.intentKey)',
    "group.requiresExecution ||= row.action !== 'current' && row.action !== 'reuse' && row.action !== 'manual'",
    'const admission = evaluateVerificationEvidenceForGate({',
    "authority: 'diagnostic-only', storyId: input.storyId",
    "isReusableVerificationReceipt(evidence.receipt) && row.action !== 'invalid'",
    '...(identity.reusable ? {} : { materialHash: materialHash ?? null, storyFilesHash: storyFilesHash ?? null })',
    '...(identity.reusable && execution.inputClosureComplete ? {} : { materialHash: evidence.materialHash ?? null, storyFilesHash: evidence.storyFilesHash ?? null })',
  ]);
  requireTokens('Dynamic evidence planner', planner, [['buildIntentFingerprintReport', 2], 'row.description', 'fingerprintByRef.get(intentFingerprintKey(item.id, collected.ref))', 'refreshCommand: `proof-or-stop verification_evidence_refresh_stale --storyId=${storyId}`']);
  requireTokens('Manual refresh recommendation', planner, ['const manualRefreshUnsafe = checklist.items.some(', 'Manual refresh withheld: a shared metadata-only refresh can demote executable receipts.']);
  requireTokens('Discovered intent regression binding', read('packages/main/src/tasks/evidence-plan-smoke.ts'), [
    "await import(new URL('../../tests/intent-fingerprint-reuse.test.mjs', import.meta.url).href);",
  ]);
  requireTokens('Intent fingerprint registration', read(processFactRegistryPath), ['packages/main/src/core/verification-intent-fingerprints.ts']);
  requireTokens('Legacy refresh preview semantics', read('packages/main/src/handlers/evidence-refresh.ts'), [
    ["kind: 'metadata-drift-only'", 2], ["executableAdmission: 'not-evaluated'", 2], 'metadata drift only; not executable receipt admission',
  ]);
}

if (failures.length) {
  console.error('');
  console.error('Process fact contract failed:');
  for (const message of failures.sort()) console.error(`- ${message}`);
  process.exit(1);
}

let completedPositiveProofs = 0;

function positiveProofCompletion(resolveProof, rejectProof, label, marker, display) {
  return (error, stdout, stderr) => {
    try {
      if (error) { Object.assign(error, { stdout, stderr }); throw error; }
      if (marker) nodeAssert(stdout.includes(marker), label + ' requires its exact completion selector');
      if (display) { process.stdout.write(stdout); process.stderr.write(stderr); }
      completedPositiveProofs++;
      resolveProof();
    } catch (failure) {
      rejectProof(new Error(failure?.signal
        ? 'PROOF_UNAVAILABLE: ' + label + '\n' + String(failure) + '\n' + stdout + '\n' + stderr
        : verificationFailureMessage(label, failure)));
    }
  };
}

const inventoryCriticProof = new Promise((resolveProof, rejectProof) => {
  execFile(process.execPath, [join(root, 'scripts/verify-inventory-critic-metadata-head.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 900000, maxBuffer: 8 * 1024 * 1024,
  }, positiveProofCompletion(resolveProof, rejectProof, 'inventory critic metadata HEAD', 'INVENTORY_CRITIC_METADATA_HEAD_GREEN', true));
});

const remainingPositiveProofs = (async () => {
  // Real verdict consumer, raw-stream digest and refusal guards remain mandatory.
  await new Promise((resolveProof, rejectProof) => {
    execFile(process.execPath, ['packages/main/tests/codex-review-jsonl.test.mjs'], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      positiveProofCompletion(resolveProof, rejectProof, 'codex review JSONL', null, true));
  });
  await new Promise((resolveProof, rejectProof) => {
    execFile(process.execPath, ['packages/main/tests/review-history-buffer.test.mjs'], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      positiveProofCompletion(resolveProof, rejectProof, 'review history buffer', null, true));
  });
  // Match CLI module initialization before the actual sealed managed-review fixture.
  await new Promise((resolveProof, rejectProof) => {
    execFile(process.execPath, ['--import', './packages/main/dist/index.js', 'packages/main/dist/tasks/managed-review-evidence-smoke.js', '--supersession-regression'], { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
      positiveProofCompletion(resolveProof, rejectProof, 'managed review supersession', null, true));
  });
  await new Promise((resolveProof, rejectProof) => {
    execFile(process.execPath, ['packages/main/tests/certification-recovery-lineage.test.mjs'], { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
      positiveProofCompletion(resolveProof, rejectProof, 'certification recovery lineage', null, true));
  });
  // Managed delivery still uses an actual provider process and real CLI.
  await new Promise((resolveProof, rejectProof) => {
    execFile(process.execPath, ['packages/main/tests/managed-delivery-dispatch.test.mjs'], { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
      positiveProofCompletion(resolveProof, rejectProof, 'managed delivery dispatch', null, true));
  });
  // Real writer/coverage proofs; unavailable execution can never grant GREEN.
  for (const [file, marker, timeout] of [
    ['experiments/acceptance-closure/regression.mjs', 'ACCEPTANCE_CLOSURE_GREEN', 60000],
    ['experiments/acceptance-closure/publication-snapshot.mjs', 'PUBLICATION_SNAPSHOT_GREEN', 60000],
    ['experiments/acceptance-closure/publication-lifecycle.mjs', 'PUBLICATION_LIFECYCLE_GREEN', 720000],
  ]) {
    await new Promise((resolveProof, rejectProof) => {
      execFile(process.execPath, [join(root, file)], { cwd: root, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 },
        positiveProofCompletion(resolveProof, rejectProof, 'acceptance closure ' + file, marker, !quiet));
    });
  }
})();

const positiveProofResults = await Promise.allSettled([inventoryCriticProof, remainingPositiveProofs]);

const positiveProofFailures = positiveProofResults.filter(result => result.status === 'rejected').map(result => result.reason);

if (positiveProofFailures.length) throw new AggregateError(positiveProofFailures, 'Complete positive process-fact proofs failed');

nodeAssert.equal(completedPositiveProofs, 9, 'all nine actual positive child completions are required');

console.log('PROCESS_POSITIVE_PROOFS_COMPLETE 9');

const admissionOrderOutput = execFileSync(process.execPath, [join(root, 'scripts/verify-process-runtime-admission-order.mjs')], { cwd: root, encoding: 'utf8', timeout: 60000 });

nodeAssert(admissionOrderOutput.includes('PASS process runtime admission order:'), 'Runtime admission ordering witness must emit its PASS marker');

if (!quiet) process.stdout.write(admissionOrderOutput);

if (!read('packages/main/src/core/process-fact-registry.ts').includes('runtime:validate_argument_compatibility')) failures.push('validate argument compatibility must remain registered');

assert(read('packages/main/src/core/managed-host-run.ts').includes('isManagedInventoryCritic'), 'Managed proposal writer must validate critic shape');

assert(read('packages/main/src/core/managed-review-evidence.ts').includes('isManagedInventoryCritic'), 'Managed evidence consumer must validate critic shape');

{
 const hostRunSource = read('packages/main/src/core/host-run.ts');
 const registrySource = read(processFactRegistryPath);
 const requiredSchemaTokens = [
   "...(args.lane === MANAGED_REVIEW_TOPOLOGY_CRITIC ? ['inventoryCritic'] : [])",
   '(parsed.lane === MANAGED_REVIEW_TOPOLOGY_CRITIC && parsed.inventoryCritic === undefined)',
   'hasOnlyKeys(readManifest, MANAGED_REVIEW_READ_MANIFEST_FIELDS)',
   'hasOnlyKeys(readLog, MANAGED_REVIEW_READ_LOG_FIELDS)',
   'parsed.readDiagnostics.every(isStrictManagedReviewReadDiagnostic)',
 ];
 for (const token of requiredSchemaTokens) {
   assert(hostRunSource.includes(token), `Managed final-proposal schema contract missing enforcement token: ${token}`);
   nodeAssert(!hostRunSource.replace(token, '').includes(token), `Managed final-proposal negative control must remove enforcement token: ${token}`);
 }
 const compatibilityGuardSources = {
   managedHostRun: read('packages/main/src/core/managed-host-run.ts'),
   managedReviewEvidence: read('packages/main/src/core/managed-review-evidence.ts'),
 };
 const compatibilityGuards = [
   [compatibilityGuardSources.managedHostRun,
     'if (!isManagedInventoryCriticEnvelopeValid(proposal.inventoryCritic, proposal.lane, proposal.providerAgent, proposal.findings?.length ?? 0)) return null;',
     'persisted-proposal read'],
   [compatibilityGuardSources.managedHostRun,
     'if (!isManagedInventoryCriticEnvelopeValid(args.proposal.inventoryCritic, spec.lane, spec.agentType, args.proposal.findings?.length ?? 0)) {',
     'compatibility proposal write'],
   [compatibilityGuardSources.managedReviewEvidence,
     '&& isManagedInventoryCriticEnvelopeValid(proposal.inventoryCritic, proposal.lane, proposal.providerAgent, proposal.findings?.length ?? 0)',
     'managed evidence import'],
 ];
 for (const [source, token, label] of compatibilityGuards) {
   assert(source.includes(token), `Managed topology critic ${label} is missing its shared required-envelope guard`);
   nodeAssert(!source.replace(token, '').includes(token),
     `Managed topology critic ${label} negative control must independently remove its guard`);
 }
 assert(registrySource.includes('the topology-critic lane requires inventoryCritic across terminal and compatibility ingress'),
   'Managed final-proposal process fact must register critic receipt completeness');
 assert(registrySource.includes('routing digests share one grammar') && registrySource.includes('unknown nested fields fail closed'),
   'Managed final-proposal process fact must register schema and terminal-validator consistency');
}

{
 const source = read('packages/main/src/handlers/review-inventory.ts');
 const required = ['export function importManagedInventoryCritic', 'createManagedReviewEvidenceBinding',
   'verifyManagedReviewLiveBinding', 'proposalFindingIndex',
   'only proof-or-stop-review-topology-critic may write critic authority'];
 const missing = candidate => required.filter(token => !candidate.includes(token));
 assert(missing(source).length === 0, 'Managed critic transport must authenticate its receipt and preserve native actor checks');
 for (const token of required) {
   nodeAssert(missing(source.replaceAll(token, '')).includes(token), 'Managed critic negative control must detect removed authority token: ' + token);
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

console.log('execution_assertion_reuse_contract=PASS');

console.log('Process-fact contract verification passed');
}
