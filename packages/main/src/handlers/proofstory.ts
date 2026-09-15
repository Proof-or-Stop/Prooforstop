import { withScopeShrinkageTransaction } from '../core/scope-shrinkage-transaction.js';
import { isValidationMetadataBusy } from '../core/validation-execution-lock.js';
import { canonicalDigest } from '../core/authority-signing.js';
import { rethrowIntentAmendmentIntegrityError } from '../core/verification-intent-amendment.js';
/**
 * ProofStory handlers.
 *
 * These commands persist story-scoped intent-hardening artifacts and expose
 * observe/warn/enforce diagnostics. Enforcement is opt-in by command mode or
 * project policy; this file does not create a parallel lifecycle machine.
 */

import type { HandlerContext } from './context.js';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { AcceptanceBasisArtifactV1, AcceptanceRolloutCohortInputV1, ChecklistData, MilestoneNotApplicableDecision, ProofStoryBindingDisposition, ProofStoryContractData, ProofStoryGateMode, RedEvidenceData, RedEvidenceRecord } from '../core/types.js';
import {
  describeRedEvidenceReadFailure,
  redEvidenceQuarantinedRecords,
  redEvidenceRepairGuidance,
  renderRedEvidenceQuarantineNotice,
  restoreQuarantinedRecords,
} from '../core/red-evidence-artifact-validation.js';
import {
  addMilestoneToLedger,
  appendRedEvidence,
  buildIntentCollision,
  buildMilestoneLedger,
  buildOriginalIntentSnapshot,
  buildParentLedgerRollup,
  buildProofStoryContract,
  buildScopeShrinkageDecision,
  buildSlicePlan,
  confirmMilestoneLedger,
  effectiveAcceptanceBindings,
  evaluateDoneIntentEquivalence,
  evaluateProofStoryDiagnostics,
  evaluateReviewCompleteness,
  optionalStringArray,
  renderProofStoryDiagnosticReport,
  setSpikeResult,
  setSpikeStatus,
  startSpike,
  type ProofStoryDiagnosticInput,
} from '../core/proofstory.js';
import { withMkdirLock } from '../core/mkdir-lock.js';
import { withReviewInventoryMutationLock } from '../core/review-inventory-epoch.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { currentMilestoneStatusEvidenceBinding } from '../core/milestone-status.js';
import { tryBuildMaterialClassificationSnapshotForDiagnostics } from '../core/material-code-policy.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { resolveFullStoryBaseHead } from '../core/review-incremental-context.js';
import { readTrustedProofStoryScopeArtifacts } from '../core/closeout-trust.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import {
  buildAcceptanceMatrixReport,
  evaluateAcceptanceTopologyCheck,
  type AcceptanceTopologyCheckReport,
} from '../core/acceptance-topology.js';
import { acceptanceCoverageBasisSemanticDigest, deriveAcceptanceCoverageBasis, reconcileTopologyWithCoverageBasis } from '../core/acceptance-coverage-basis.js';
import { issueAcceptanceBasisReceipt, verifyAcceptanceBasisReceipt } from '../core/acceptance-basis-receipt.js';
import { currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resolveStoryCommandWorkspace } from './context.js';
import { digestCanonicalJson } from '../core/digest.js';
import { verifyScopeCheckSignature } from './scope-check.js';
import { loadConfig, resolveAcceptanceRolloutGateMode, resolveAcceptanceTopologyGateMode } from '../core/config.js';
import { getSessionId, getSessionIdentity } from '../core/owner-session.js';
import { resolveAgentMutationAuthority } from '../core/agent-dispatch-registry.js';
import {
  canonicalTopologyReceiptContext,
  deriveImplementationProvenance,
  deriveRoleProvenance,
  issueTopologyCriticReceipt,
  issueTopologyExclusionApproval,
  TOPOLOGY_CRITIC_ROLE,
  TOPOLOGY_EXCLUSION_APPROVER_ROLE,
  verifyTopologyCriticReceipt,
} from '../core/topology-critic-receipt.js';
import { issuePreReviewCheckArtifact, loadVerifiedPreReviewExecutableProof, verifyPreReviewCheckArtifact, type PreReviewCheckInput, type PreReviewCheckReport } from '../core/pre-review-check.js';
import {
  currentAcceptanceRolloutBinding,
  deriveAcceptanceRolloutReport,
  issueAcceptanceRolloutArtifact,
  verifyAcceptanceRolloutArtifact,
  type AcceptanceRolloutVerification,
} from '../core/acceptance-rollout.js';
import { readBrandEnv } from '../core/brand-env.js';
import { resolveAcceptanceVerificationProfile } from '../core/acceptance-discovery-adapters.js';

type JsonFlag = { json?: boolean };
type ModeFlag = { mode?: ProofStoryGateMode; dryRun?: boolean };

function emptyChecklist(): ChecklistData {
  return { items: [] };
}

function stringify(data: unknown, pretty = true): string {
  return JSON.stringify(data, null, pretty ? 2 : 0);
}

function renderStored(kind: string, data: unknown, args: JsonFlag): string {
  if (args.json) return stringify(data);
  return `${kind}: configured\n${stringify(data)}`;
}

function resolveMode(args: ModeFlag): ProofStoryGateMode {
  return args.mode ?? 'observe';
}

function loadRegisteredAcceptanceRolloutCohort(workspaceRoot: string): AcceptanceRolloutCohortInputV1 {
  const runner = join(workspaceRoot, 'scripts/run-proofstory-acceptance-rollout-cohort.mjs');
  const output = execFileSync(process.execPath, [runner], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    // The verifier name is an artifact issuer, not a registered mutation
    // role. The cohort runner invokes signed reviewer lanes itself, so its
    // parent process must use the trusted host actor rather than laundering
    // an unregistered actor through nested CLI calls.
    env: { ...process.env, PROOF_OR_STOP_AGENT: 'main' },
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(output) as AcceptanceRolloutCohortInputV1;
  if (parsed.schemaVersion !== 'proofstory.acceptance_rollout_cohort_input.v1'
    || parsed.generatedBy !== 'runProofStoryAcceptanceRolloutCohort'
    || parsed.runnerPath !== 'scripts/run-proofstory-acceptance-rollout-cohort.mjs') {
    throw new Error('acceptance rollout: registered cohort runner returned an invalid envelope');
  }
  return parsed;
}

/** Shared production verifier for CLI read/check and transition-orchestrator. */
export function evaluateAcceptanceRolloutForContext(ctx: HandlerContext, storyId: string): AcceptanceRolloutVerification {
  const workspace = resolveStoryCommandWorkspace(ctx.store, storyId, ctx.root);
  const artifact = ctx.store.readAcceptanceRolloutReport(storyId);
  const cohort = artifact ? {
    schemaVersion: 'proofstory.acceptance_rollout_cohort_input.v1' as const,
    generatedBy: 'runProofStoryAcceptanceRolloutCohort' as const,
    evaluationWindow: artifact.report.evaluationWindow,
    eligibilityRuleVersion: artifact.report.eligibilityRuleVersion,
    thresholdVersion: artifact.report.thresholdVersion,
    registeredSeedIds: artifact.report.registeredSeedIds,
    sourceRecords: artifact.report.sourceRecords,
    sourceInventoryDigest: artifact.report.sourceInventoryDigest,
    runnerPath: 'scripts/run-proofstory-acceptance-rollout-cohort.mjs' as const,
    runnerDigest: artifact.report.binding.runnerDigest,
  } : undefined;
  return verifyAcceptanceRolloutArtifact({
    artifact,
    gitCwd: workspace.signedWorkspaceRoot,
    metadataRoot: workspace.metadataRoot,
    expectedStoryId: storyId,
    ...(cohort ? { expectedCohort: cohort } : {}),
    mode: resolveAcceptanceRolloutGateMode(loadConfig(ctx.root)),
  });
}

function enforceOrRender(report: { blocking: boolean; mode: ProofStoryGateMode }, text: string): string {
  if (report.mode === 'enforce' && report.blocking) {
    throw new Error(text);
  }
  return text;
}

function readChecklistForTopology(ctx: HandlerContext, storyId: string): ChecklistData {
  try { return ctx.store.readChecklist(storyId); }
  catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError); return emptyChecklist(); }
}

function currentBasisDerivationForContext(ctx: HandlerContext, storyId: string, phaseBasis: 'plan' | 'pre_review' = 'plan', priorPlanBasisDigest?: string) {
  const { store } = ctx;
  const workspace = resolveStoryCommandWorkspace(store, storyId, ctx.root);
  const headHash = currentGitHead(workspace.signedWorkspaceRoot);
  const materialHash = currentMaterialHash(workspace.signedWorkspaceRoot, 'HEAD', workspace.metadataRoot);
  const storyFilesHash = currentStoryFilesHash(workspace.signedWorkspaceRoot, 'HEAD', workspace.metadataRoot);
  if (!headHash || !materialHash || !storyFilesHash) throw new Error('acceptance basis: current workspace hashes are unavailable');
  const storedScopeCheck = store.readScopeCheck(storyId);
  const scopeCheck = storedScopeCheck && verifyScopeCheckSignature(storyId, storedScopeCheck) ? storedScopeCheck : null;
  const scopeContract = store.readScopeContract(storyId);
  const derivation = deriveAcceptanceCoverageBasis({
    storyId,
    workspaceRoot: workspace.signedWorkspaceRoot,
    checklist: readChecklistForTopology(ctx, storyId),
    contract: store.readProofStoryContract(storyId),
    scopeCheck,
    scopeContract,
    foundationalDecision: store.readDecision(storyId),
    headHash,
    materialHash,
    storyFilesHash,
    phaseBasis,
    ...(priorPlanBasisDigest ? { priorPlanBasisDigest } : {}),
  });
  return { workspace, scopeCheck, scopeContract, derivation };
}

export function currentPreReviewInputForContext(ctx: HandlerContext, storyId: string): PreReviewCheckInput {
  const planArtifact = ctx.store.readAcceptanceBasis(storyId);
  if (!planArtifact) throw new Error('pre_review_check requires the verifier-owned PLAN acceptance basis');
  const current = currentBasisDerivationForContext(ctx, storyId, 'pre_review', planArtifact.basis.basisDigest);
  const receipt = issueAcceptanceBasisReceipt({
    gitCwd: current.workspace.signedWorkspaceRoot,
    basis: current.derivation.basis,
    topologyDigest: current.derivation.topologyDigest,
  });
  let currentArtifact: AcceptanceBasisArtifactV1 = { schemaVersion: 'proofstory.acceptance_basis_artifact.v1', basis: current.derivation.basis, receipt };
  const priorPreReviewArtifact = ctx.store.readPreReviewCheck(storyId)?.preReviewBasisArtifact;
  if (priorPreReviewArtifact) {
    const priorVerification = verifyAcceptanceBasisReceipt({
      artifact: priorPreReviewArtifact,
      gitCwd: current.workspace.signedWorkspaceRoot,
      metadataRoot: current.workspace.metadataRoot,
      expectedStoryId: storyId,
      expectedTopologyDigest: current.derivation.topologyDigest,
      expectedScopeCheckDigest: current.derivation.basis.binding.scopeCheckDigest,
      ...(current.derivation.basis.binding.scopeContractDigest ? { expectedScopeContractDigest: current.derivation.basis.binding.scopeContractDigest } : {}),
      expectedClosureFilesHash: current.derivation.basis.binding.closureFilesHash,
      expectedSealDigest: current.derivation.basis.snapshotSeal.sealDigest,
      expectedBasisSemanticDigest: acceptanceCoverageBasisSemanticDigest(current.derivation.basis),
    });
    if (priorVerification.ok) currentArtifact = priorPreReviewArtifact;
  }
  const topologyDiagnosticCodes = reconcileTopologyWithCoverageBasis(
    ctx.store.readProofStoryContract(storyId), current.derivation.basis, ctx.store.readDecision(storyId),
  ).map(item => item.code);
  let criticVerification: { ok: boolean; code: string } | undefined;
  try {
    const result = evaluateTopologyCriticReceiptForContext(ctx, storyId);
    criticVerification = { ok: result.ok, code: result.code };
  } catch { criticVerification = { ok: false, code: 'AT_TOPOLOGY_CRITIC_CONTEXT_INVALID' }; }
  const criticReceipt = ctx.store.readTopologyCriticReceipt(storyId);
  const cutoffAt = new Date().toISOString();
  const contract = ctx.store.readProofStoryContract(storyId);
  const verificationProfile = resolveAcceptanceVerificationProfile(current.workspace.signedWorkspaceRoot);
  const executableProof = loadVerifiedPreReviewExecutableProof({
    gitCwd: current.workspace.signedWorkspaceRoot,
    metadataRoot: current.workspace.metadataRoot,
    storyDir: ctx.store.storyDirPath(storyId),
    storyId,
    contract,
    cutoffAt,
    storyFilesHash: current.derivation.basis.binding.storyFilesHash,
  });
  return {
    gitCwd: current.workspace.signedWorkspaceRoot,
    metadataRoot: current.workspace.metadataRoot,
    storyId,
    mode: resolveAcceptanceTopologyGateMode(loadConfig(ctx.root)),
    cutoffAt,
    planArtifact,
    currentArtifact,
    checklist: readChecklistForTopology(ctx, storyId),
    contract,
    executableProof,
    topologyDigest: current.derivation.topologyDigest,
    topologyDiagnosticCodes,
    criticVerification,
    verificationProfile,
    ...(criticReceipt ? { criticReceiptDigest: `sha256:${digestCanonicalJson(criticReceipt)}` } : {}),
  };
}

function missingPlanBasisPreReviewReport(ctx: HandlerContext, storyId: string): PreReviewCheckReport {
  const mode = resolveAcceptanceTopologyGateMode(loadConfig(ctx.root));
  return {
    storyId,
    mode,
    readOnly: true,
    verificationProfile: 'unsupported',
    status: 'fail',
    ok: false,
    blocking: mode === 'enforce',
    codes: ['PR_COVERAGE_BASIS_MISSING'],
    plannedActual: 'incomplete',
    executableEvidence: 'missing',
    mutations: 'missing',
    transcript: 'missing',
    authority: 'inadmissible',
    criticReattestation: mode === 'enforce' ? 'missing' : 'not_required',
    remediation: ['Run proof-or-stop acceptance_basis_generate --storyId=<id>, then rerun proof-or-stop pre_review_check --storyId=<id>.'],
    artifact: null,
  };
}

/** Shared production verifier for the CLI and DEV→REVIEW lifecycle consumer. */
export function evaluatePreReviewCheckForContext(ctx: HandlerContext, storyId: string): PreReviewCheckReport {
  if (!ctx.store.readAcceptanceBasis(storyId)) return missingPlanBasisPreReviewReport(ctx, storyId);
  const stored = ctx.store.readPreReviewCheck(storyId);
  if (!stored) {
    const input = currentPreReviewInputForContext(ctx, storyId);
    return verifyPreReviewCheckArtifact({ ...input, cutoffAt: input.cutoffAt, artifact: null });
  }
  const input = currentPreReviewInputForContext(ctx, storyId);
  return verifyPreReviewCheckArtifact({ ...input, cutoffAt: stored.cutoffAt, artifact: stored });
}

/** Shared production adapter for the CLI and PLAN→DEV lifecycle consumer. */
export function evaluateAcceptanceTopologyForContext(ctx: HandlerContext, storyId: string): AcceptanceTopologyCheckReport {
  const { store } = ctx;
  store.readStory(storyId);
  const current = currentBasisDerivationForContext(ctx, storyId);
  const artifact = store.readAcceptanceBasis(storyId);
  const receiptVerification = verifyAcceptanceBasisReceipt({
    artifact,
    gitCwd: current.workspace.signedWorkspaceRoot,
    metadataRoot: current.workspace.metadataRoot,
    expectedStoryId: storyId,
    expectedTopologyDigest: current.derivation.topologyDigest,
    expectedScopeCheckDigest: `sha256:${digestCanonicalJson(current.scopeCheck)}`,
    ...(current.scopeContract ? { expectedScopeContractDigest: `sha256:${digestCanonicalJson(current.scopeContract)}` } : {}),
    expectedClosureFilesHash: current.derivation.basis.binding.closureFilesHash,
    expectedSealDigest: current.derivation.basis.snapshotSeal.sealDigest,
    expectedBasisSemanticDigest: acceptanceCoverageBasisSemanticDigest(current.derivation.basis),
  });
  const topologyBasisDiagnostics = artifact
    ? reconcileTopologyWithCoverageBasis(store.readProofStoryContract(storyId), artifact.basis, store.readDecision(storyId))
    : [];
  const currentBasisDiagnostics = [...current.derivation.diagnostics];
  if (artifact && artifact.basis.binding.closureFilesHash !== current.derivation.basis.binding.closureFilesHash) {
    currentBasisDiagnostics.push({
      code: 'AT_CLOSURE_FILES_STALE',
      pathRef: 'acceptance-basis.json.basis.binding.closureFilesHash',
      message: 'registered producer/consumer closure changed after the PLAN basis was issued',
    });
  }
  return evaluateAcceptanceTopologyCheck({
    storyId,
    mode: resolveAcceptanceTopologyGateMode(loadConfig(ctx.root)),
    checklist: readChecklistForTopology(ctx, storyId),
    contract: store.readProofStoryContract(storyId),
    ledger: readTrustedProofStoryScopeArtifacts(store, storyId).ledger,
    artifact,
    receiptVerification,
    currentBasisDiagnostics,
    topologyBasisDiagnostics,
  });
}

function currentTopologyReceiptStateForContext(ctx: HandlerContext, storyId: string) {
  const { store } = ctx;
  const preReview = store.readPreReviewCheck(storyId);
  const planArtifact = store.readAcceptanceBasis(storyId);
  const current = preReview && planArtifact
    ? currentBasisDerivationForContext(ctx, storyId, 'pre_review', planArtifact.basis.basisDigest)
    : currentBasisDerivationForContext(ctx, storyId);
  const artifact = preReview?.preReviewBasisArtifact ?? planArtifact;
  if (!artifact) throw new Error('topology critic requires the verifier-owned acceptance-basis.json artifact');
  const basisVerification = verifyAcceptanceBasisReceipt({
    artifact,
    gitCwd: current.workspace.signedWorkspaceRoot,
    metadataRoot: current.workspace.metadataRoot,
    expectedStoryId: storyId,
    expectedTopologyDigest: current.derivation.topologyDigest,
    expectedScopeCheckDigest: current.derivation.basis.binding.scopeCheckDigest,
    ...(current.derivation.basis.binding.scopeContractDigest ? { expectedScopeContractDigest: current.derivation.basis.binding.scopeContractDigest } : {}),
    expectedClosureFilesHash: current.derivation.basis.binding.closureFilesHash,
    expectedSealDigest: current.derivation.basis.snapshotSeal.sealDigest,
    expectedBasisSemanticDigest: acceptanceCoverageBasisSemanticDigest(current.derivation.basis),
  });
  // B-3f3d: a failed basis verification must NOT close the negative verdict. Refusing
  // request_changes on a stale basis is what made the deadlock inescapable: the frozen
  // pre-review snapshot preferred above can only be refreshed by pre_review_check (DEV-only),
  // DEV needs a finalized review-inventory receipt, and that needs a critic terminal state --
  // the very thing this throw blocks. A critic must always be able to say "this fails".
  // The caller decides: a PASS verdict still requires basisVerification.ok (enforced at the
  // pass branch), while request_changes may be signed over a stale/unverified basis, which is
  // an honest record of exactly what the critic judged. basisVerification is returned so the
  // signer can bind its outcome into the receipt rather than silently ignoring it.
  const context = canonicalTopologyReceiptContext({
    storyId,
    basisStatus: artifact.basis.status,
    basisDigest: artifact.basis.basisDigest,
    topologyDigest: current.derivation.topologyDigest,
    scopeCheckDigest: current.derivation.basis.binding.scopeCheckDigest,
    ...(current.derivation.basis.binding.scopeContractDigest ? { scopeContractDigest: current.derivation.basis.binding.scopeContractDigest } : {}),
    storyFilesHash: current.derivation.basis.binding.storyFilesHash,
    closureFilesHash: current.derivation.basis.binding.closureFilesHash,
    exclusions: artifact.basis.excludedPathRefs,
    findingRefs: store.readFindings(storyId).findings.filter(finding => finding.status === 'open').map(finding => finding.id),
  });
  const events = store.readProcessEvents(storyId);
  const story = store.readStory(storyId);
  const frozenStoryBase = story.integrationTarget !== undefined
    ? resolveFullStoryBaseHead(store, ctx.root, storyId)
    : undefined;
  const implementation = deriveImplementationProvenance(
    current.workspace.signedWorkspaceRoot,
    events,
    context,
    frozenStoryBase,
  );
  return { current, artifact, context, events, implementation, basisVerification };
}

/** Canonical read-only CLI verifier; reusable by a future phase-appropriate gate without creating a Wave 2A lifecycle consumer. */
export function evaluateTopologyCriticReceiptForContext(ctx: HandlerContext, storyId: string) {
  const state = currentTopologyReceiptStateForContext(ctx, storyId);
  const approvals = ctx.store.readTopologyExclusionApprovals(storyId).approvals;
  return verifyTopologyCriticReceipt({
    gitCwd: state.current.workspace.signedWorkspaceRoot,
    context: state.context,
    receipt: ctx.store.readTopologyCriticReceipt(storyId),
    approvals,
    implementation: state.implementation,
    events: ctx.store.readProcessEvents(storyId),
  });
}

export function createProofStoryHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store } = ctx;

  function readChecklistSafe(storyId: string): ChecklistData {
    try {
      return store.readChecklist(storyId);
    } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
      return emptyChecklist();
    }
  }

  function currentEvidenceBinding(storyId: string): ReturnType<typeof currentMilestoneStatusEvidenceBinding> {
    try {
      const gitCwd = resolveGitCwd({
        store,
        storyId,
        metadataRoot: ctx.root,
        projectRoot: ctx.root,
        cwd: process.cwd(),
      });
      return currentMilestoneStatusEvidenceBinding(gitCwd, ctx.root);
    } catch {
      // Freshness is a diagnostic; a resolution failure must never break the
      // read-path gate. Absent binding => base coverage semantics only.
      return undefined;
    }
  }

  // B-956f FIX G: production materialClassification for the handler diagnostic
  // input. Resolution failures yield undefined (diagnostic field; a broken
  // policy/config surfaces through the fail-closed resolve/floor/repro
  // consumers, never by breaking the read-path diagnostics).
  function materialClassification(storyId: string): ReturnType<typeof tryBuildMaterialClassificationSnapshotForDiagnostics> {
    let gitCwd: string | undefined;
    try {
      gitCwd = resolveGitCwd({
        store,
        storyId,
        metadataRoot: ctx.root,
        projectRoot: ctx.root,
        cwd: process.cwd(),
      });
    } catch {
      gitCwd = undefined;
    }
    return tryBuildMaterialClassificationSnapshotForDiagnostics(ctx.root, gitCwd);
  }

  /**
   * B-2aa7 CHK-006. `store.readRedEvidence` REJECTS an unreadable artifact with
   * a typed error (D-8 / row E7). That error already opens with the corruption
   * marker and names the artifact path, so it is corruption-distinct on its own;
   * this only adds the §9 repair instruction at a TERMINAL rendering site.
   *
   * Deliberately applied around the caller, never inside `diagnosticInput`: that
   * builder is shared, and rewrapping there would launder
   * `RedEvidenceArtifactError` / `RedEvidenceSchemaError` into a plain `Error`
   * for every consumer that discriminates on the class.
   */
  function withRedEvidenceCorruptionContext<T>(storyId: string, fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      const corruption = describeRedEvidenceReadFailure(e);
      if (corruption === null) throw e;
      throw new Error(
        `ProofStory diagnostics cannot be evaluated for ${storyId}: its red-evidence artifact is corrupt, which is ` +
          `NOT the same as an absent one — there is no verdict to report.\n${corruption}\n${redEvidenceRepairGuidance(storyId)}`,
      );
    }
  }

  function diagnosticInput(storyId: string): ProofStoryDiagnosticInput {
    const story = store.readStory(storyId);
    const checklist = readChecklistSafe(storyId);
    const trusted = readTrustedProofStoryScopeArtifacts(store, storyId);
    return {
      story,
      checklist,
      originalIntentSnapshot: store.readOriginalIntentSnapshot(storyId),
      milestoneLedger: trusted.ledger,
      slicePlan: trusted.slicePlan,
      parentLedgerRollup: trusted.parentRollup,
      proofStoryContract: store.readProofStoryContract(storyId),
      intentCollision: store.readIntentCollision(storyId),
      scopeContract: store.readScopeContract(storyId),
      scopeShrinkageDecision: store.readScopeShrinkageDecision(storyId),
      // The typed read-boundary error propagates from here UNCHANGED (B-2aa7
      // CHK-006); operator context is added by callers, not by this builder.
      redEvidence: store.readRedEvidence(storyId),
      spikeEvidence: store.readProofStorySpikes(storyId),
      summary: store.readSummary(storyId),
      currentEvidenceBinding: currentEvidenceBinding(storyId),
      materialClassification: materialClassification(storyId),
    };
  }

  function renderGateReport(storyId: string, args: JsonFlag & ModeFlag): string {
    const input = withRedEvidenceCorruptionContext(storyId, () => diagnosticInput(storyId));
    const report = evaluateProofStoryDiagnostics(input, resolveMode(args));
    // B-2aa7 CHK-006. A QUARANTINED artifact does not throw: `records` arrives
    // clean, so the report can read exactly like "no red evidence configured".
    // Lead with the corruption so the operator is never told a corrupt file is
    // an absent one. The VERDICT is untouched — this renders, it does not judge.
    const corruption = renderRedEvidenceQuarantineNotice(storyId, input.redEvidence);
    if (args.json) {
      return enforceOrRender(report, stringify(corruption === null ? report : { ...report, redEvidenceCorruption: corruption }));
    }
    const rendered = renderProofStoryDiagnosticReport(report);
    return enforceOrRender(report, corruption === null ? rendered : `${corruption}\n${rendered}`);
  }

  function rejectBasisWriteShape(args: Record<string, unknown>, allowed: readonly string[]): void {
    const unexpected = Object.keys(args).filter(key => !allowed.includes(key));
    if (unexpected.length > 0) {
      throw new Error(`acceptance basis requests are verifier-derived; unsupported caller fields: ${unexpected.sort().join(', ')}`);
    }
  }

  function currentBasisDerivation(storyId: string) {
    return currentBasisDerivationForContext(ctx, storyId);
  }

  function currentTopologyReceiptState(storyId: string) {
    return currentTopologyReceiptStateForContext(ctx, storyId);
  }

  function basisReport(storyId: string) {
    const artifact = store.readAcceptanceBasis(storyId);
    if (!artifact) {
      return {
        storyId,
        mode: 'read_only',
        evidentiary: false,
        status: 'legacy_missing',
        basisStatus: 'unsupported',
        receiptVerification: { ok: false, code: 'AT_COVERAGE_BASIS_MISSING', diagnostics: ['acceptance basis receipt is missing'] },
        diagnostics: [{ code: 'AT_COVERAGE_BASIS_MISSING', message: 'Run acceptance_basis_generate from the registered verifier.' }],
      };
    }
    const current = currentBasisDerivation(storyId);
    const verification = verifyAcceptanceBasisReceipt({
      artifact,
      gitCwd: current.workspace.signedWorkspaceRoot,
      metadataRoot: current.workspace.metadataRoot,
      expectedStoryId: storyId,
      expectedTopologyDigest: current.derivation.topologyDigest,
      expectedScopeCheckDigest: `sha256:${digestCanonicalJson(current.scopeCheck)}`,
      ...(current.scopeContract ? { expectedScopeContractDigest: `sha256:${digestCanonicalJson(current.scopeContract)}` } : {}),
      expectedClosureFilesHash: current.derivation.basis.binding.closureFilesHash,
      expectedSealDigest: current.derivation.basis.snapshotSeal.sealDigest,
      expectedBasisSemanticDigest: acceptanceCoverageBasisSemanticDigest(current.derivation.basis),
    });
    const topologyDiagnostics = reconcileTopologyWithCoverageBasis(
      store.readProofStoryContract(storyId),
      artifact.basis,
      store.readDecision(storyId),
    );
    const effectiveVerification = artifact.basis.status === 'complete' && (current.derivation.diagnostics.length > 0 || topologyDiagnostics.length > 0)
      ? {
        ok: false as const,
        code: 'AT_ADAPTER_RESULT_DIGEST_MISMATCH' as const,
        diagnostics: [
          ...verification.diagnostics,
          ...current.derivation.diagnostics.map(item => `${item.code}: ${item.message}`),
          ...topologyDiagnostics.map(item => `${item.code}: ${item.message}`),
        ],
      }
      : verification;
    return {
      storyId,
      mode: 'read_only',
      evidentiary: false,
      status: effectiveVerification.ok ? 'verified' : 'invalid',
      basisStatus: artifact.basis.status,
      discoveryProfileRef: artifact.basis.discoveryProfileRef,
      discoveryProfileDigest: artifact.basis.discoveryProfileDigest,
      adapterResults: artifact.basis.adapterResults,
      enumeratedPathRefs: artifact.basis.enumeratedPathRefs,
      plannedPathRecords: artifact.basis.plannedPathRecords,
      excludedPathRefs: artifact.basis.excludedPathRefs,
      blindSpots: artifact.basis.blindSpots,
      binding: artifact.basis.binding,
      receipt: artifact.receipt,
      receiptVerification: effectiveVerification,
      diagnostics: current.derivation.diagnostics,
    };
  }

  return {
    topology_exclusion_approval_set(args: { storyId: string; exclusionRef: string; json?: boolean }): string {
      if (!args.storyId || !args.exclusionRef) throw new Error('storyId and exclusionRef are required');
      const authority = resolveAgentMutationAuthority({ command: 'topology_exclusion_approval_set', payloadActors: [], envActor: readBrandEnv('AGENT') });
      if (authority.entry?.canonicalName !== TOPOLOGY_EXCLUSION_APPROVER_ROLE) throw new Error('topology exclusion approval requires registered proof-or-stop-review-scope-plan authority');
      const state = currentTopologyReceiptState(args.storyId);
      const actor = deriveRoleProvenance({ gitCwd: state.current.workspace.signedWorkspaceRoot, events: state.events, expectedRole: TOPOLOGY_EXCLUSION_APPROVER_ROLE, actor: authority.actor, sessionId: getSessionId(), sessionSource: getSessionIdentity().sessionSource, context: state.context, implementation: state.implementation });
      const approval = issueTopologyExclusionApproval({ gitCwd: state.current.workspace.signedWorkspaceRoot, context: state.context, exclusionRef: args.exclusionRef, actor, implementation: state.implementation });
      const approvals = store.readTopologyExclusionApprovals(args.storyId);
      approvals.approvals = [...approvals.approvals.filter(item => item.exclusionRef !== approval.exclusionRef), approval];
      store.writeTopologyExclusionApprovals(args.storyId, approvals);
      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'topology_exclusion_approval_set');
      if (args.json) return stringify({ approval, verification: 'PASS' });
      return `Topology exclusion approval: PASS\nStory: ${args.storyId}\nExclusion: ${approval.exclusionRef}\nApproval: ${approval.approvalRef}${commitHint}`;
    },

    topology_critic_receipt_set(args: { storyId: string; verdict: 'pass' | 'request_changes'; json?: boolean }): string {
      if (!args.storyId || !args.verdict) throw new Error('storyId and verdict are required');
      const authority = resolveAgentMutationAuthority({ command: 'topology_critic_receipt_set', payloadActors: [], envActor: readBrandEnv('AGENT') });
      if (authority.entry?.canonicalName !== TOPOLOGY_CRITIC_ROLE) throw new Error('topology critic receipt requires registered proof-or-stop-review-topology-critic authority');
      const state = currentTopologyReceiptState(args.storyId);
      const critic = deriveRoleProvenance({ gitCwd: state.current.workspace.signedWorkspaceRoot, events: state.events, expectedRole: TOPOLOGY_CRITIC_ROLE, actor: authority.actor, sessionId: getSessionId(), sessionSource: getSessionIdentity().sessionSource, context: state.context, implementation: state.implementation });
      const approvals = store.readTopologyExclusionApprovals(args.storyId).approvals;
      const receipt = issueTopologyCriticReceipt({ gitCwd: state.current.workspace.signedWorkspaceRoot, context: state.context, critic, implementation: state.implementation, approvals, events: state.events, verdict: args.verdict });
      store.writeTopologyCriticReceipt(args.storyId, receipt);
      const verification = verifyTopologyCriticReceipt({ gitCwd: state.current.workspace.signedWorkspaceRoot, context: state.context, receipt, approvals, implementation: state.implementation, events: store.readProcessEvents(args.storyId) });
      // B-3f3d: PASS keeps the full basis requirement that used to be enforced by an
      // unconditional throw in currentTopologyReceiptStateForContext. That throw also blocked
      // request_changes, making the deadlock inescapable; the check now lives here, on the
      // pass branch only, so a critic can always record a NEGATIVE verdict on a stale basis.
      if (args.verdict === 'pass' && !state.basisVerification.ok) {
        throw new Error(`topology critic pass refused: basis verification failed: ${state.basisVerification.code}: ${state.basisVerification.diagnostics.join('; ')}`);
      }
      if (args.verdict === 'pass' && !verification.ok) throw new Error(`topology critic receipt self-verification failed: ${verification.code}: ${verification.diagnostics.join('; ')}`);
      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'topology_critic_receipt_set', {
        closeoutArtifactPaths: ['topology-critic-receipt.json'],
      });
      if (args.json) return stringify({ receipt, verification });
      return `Topology critic receipt: ${verification.ok ? 'PASS' : 'REJECTED'}\nStory: ${args.storyId}\nVerdict: ${receipt.verdict}\nIndependence: agent=${verification.independence.agent} session=${verification.independence.session} dispatch=${verification.independence.dispatch} businessCommitAuthor=${verification.independence.businessCommitAuthor}${commitHint}`;
    },

    topology_critic_receipt_check(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      try {
        const state = currentTopologyReceiptState(args.storyId);
        const verification = evaluateTopologyCriticReceiptForContext(ctx, args.storyId);
        if (args.json) return stringify({ storyId: args.storyId, basisStatus: state.context.basisStatus, verification });
        return [`Topology critic receipt: ${verification.ok ? 'PASS' : 'REJECTED'}`, `Story: ${args.storyId}`, `Code: ${verification.code}`, `Independence: agent=${verification.independence.agent} session=${verification.independence.session} dispatch=${verification.independence.dispatch} businessCommitAuthor=${verification.independence.businessCommitAuthor}`, ...verification.diagnostics.map(item => `  - ${item}`)].join('\n');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const report = { storyId: args.storyId, verification: { ok: false, code: 'AT_TOPOLOGY_CRITIC_CONTEXT_INVALID', diagnostics: [message] } };
        if (args.json) return stringify(report);
        return `Topology critic receipt: REJECTED\nStory: ${args.storyId}\nCode: AT_TOPOLOGY_CRITIC_CONTEXT_INVALID\n  - ${message}`;
      }
    },

    acceptance_basis_generate(args: { storyId: string; json?: boolean }): string {
      rejectBasisWriteShape(args as Record<string, unknown>, ['storyId', 'json']);
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const current = currentBasisDerivation(args.storyId);
      if (current.derivation.basis.status === 'complete' && current.derivation.diagnostics.length > 0) {
        throw new Error(`acceptance_basis_generate refused unreconciled complete basis: ${current.derivation.diagnostics.map(item => item.code).join(', ')}`);
      }
      const receipt = issueAcceptanceBasisReceipt({
        gitCwd: current.workspace.signedWorkspaceRoot,
        basis: current.derivation.basis,
        topologyDigest: current.derivation.topologyDigest,
      });
      const artifact = {
        schemaVersion: 'proofstory.acceptance_basis_artifact.v1' as const,
        basis: current.derivation.basis,
        receipt,
      };
      const verification = verifyAcceptanceBasisReceipt({
        artifact,
        gitCwd: current.workspace.signedWorkspaceRoot,
        metadataRoot: current.workspace.metadataRoot,
        expectedStoryId: args.storyId,
        expectedTopologyDigest: current.derivation.topologyDigest,
        expectedScopeCheckDigest: current.derivation.basis.binding.scopeCheckDigest,
        ...(current.derivation.basis.binding.scopeContractDigest ? { expectedScopeContractDigest: current.derivation.basis.binding.scopeContractDigest } : {}),
        expectedClosureFilesHash: current.derivation.basis.binding.closureFilesHash,
        expectedSealDigest: current.derivation.basis.snapshotSeal.sealDigest,
        expectedBasisSemanticDigest: acceptanceCoverageBasisSemanticDigest(current.derivation.basis),
      });
      if (!verification.ok) throw new Error(`acceptance_basis_generate refused invalid receipt: ${verification.code}: ${verification.diagnostics.join('; ')}`);
      store.writeAcceptanceBasis(args.storyId, artifact);
      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'acceptance_basis_generate');
      if (args.json) return stringify({ artifact, diagnostics: current.derivation.diagnostics, verification });
      return [
        `Acceptance coverage basis: ${artifact.basis.status}`,
        `Story: ${args.storyId}`,
        `Profile: ${artifact.basis.discoveryProfileRef}`,
        `Adapters: ${artifact.basis.adapterResults.length}`,
        `Paths: ${artifact.basis.enumeratedPathRefs.length}`,
        `Basis digest: ${artifact.basis.basisDigest}`,
        `Receipt: ${artifact.receipt.receiptRef} (verified)`,
        ...current.derivation.diagnostics.map(item => `${item.code}: ${item.message}`),
      ].join('\n') + commitHint;
    },

    acceptance_basis(args: { storyId: string; json?: boolean }): string {
      rejectBasisWriteShape(args as Record<string, unknown>, ['storyId', 'json']);
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const report = basisReport(args.storyId);
      if (args.json) return stringify(report);
      return [
        `Acceptance coverage basis: ${report.basisStatus}`,
        `Story: ${report.storyId}`,
        `Receipt verification: ${report.receiptVerification.ok ? 'PASS' : report.receiptVerification.code}`,
        `Mode: read-only; evidentiary: false`,
        ...report.receiptVerification.diagnostics.map(message => `  - ${message}`),
      ].join('\n');
    },

    pre_review_check(args: { storyId: string; json?: boolean }): string {
      rejectBasisWriteShape(args as Record<string, unknown>, ['storyId', 'json']);
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      if (!store.readAcceptanceBasis(args.storyId)) {
        const report = missingPlanBasisPreReviewReport(ctx, args.storyId);
        const rendered = args.json ? stringify(report) : [
          `Pre-review check: FAIL code=${report.codes[0]}`,
          `Story: ${args.storyId}`,
          `Mode: ${report.mode}; blocking=${report.blocking}`,
          `Codes: ${report.codes.join(',')}`,
          ...report.remediation.map(item => `Remediation: ${item.replace('<id>', args.storyId)}`),
        ].join('\n');
        return enforceOrRender(report, rendered);
      }
      const input = currentPreReviewInputForContext(ctx, args.storyId);
      const artifact = issuePreReviewCheckArtifact(input);
      store.writePreReviewCheck(args.storyId, artifact);
      const report = verifyPreReviewCheckArtifact({ ...input, artifact });
      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'pre_review_check');
      if (args.json) return stringify({ ...report, artifact });
      return [
        `Pre-review check: ${report.ok ? 'PASS' : 'FAIL'}${report.codes[0] ? ` code=${report.codes[0]}` : ''}`,
        `Story: ${args.storyId}`,
        `Mode: ${report.mode}; blocking=${report.blocking}`,
        `plannedActual=${report.plannedActual} executableEvidence=${report.executableEvidence} mutations=${report.mutations} transcript=${report.transcript} authority=${report.authority} criticReattestation=${report.criticReattestation}`,
        `Codes: ${report.codes.join(',') || 'none'}`,
        ...report.remediation.map(item => `Remediation: ${item}`),
      ].join('\n') + commitHint;
    },

    pre_review_check_read(args: { storyId: string; json?: boolean }): string {
      rejectBasisWriteShape(args as Record<string, unknown>, ['storyId', 'json']);
      if (!args.storyId) throw new Error('storyId is required');
      const report = evaluatePreReviewCheckForContext(ctx, args.storyId);
      if (args.json) return stringify(report);
      return [
        `Pre-review check: ${report.ok ? 'PASS' : 'FAIL'}${report.codes[0] ? ` code=${report.codes[0]}` : ''}`,
        `Story: ${args.storyId}`,
        `Mode: ${report.mode}; readOnly=true; blocking=${report.blocking}`,
        `plannedActual=${report.plannedActual} executableEvidence=${report.executableEvidence} mutations=${report.mutations} transcript=${report.transcript} authority=${report.authority} criticReattestation=${report.criticReattestation}`,
        `Codes: ${report.codes.join(',') || 'none'}`,
        ...report.remediation.map(item => `Remediation: ${item}`),
      ].join('\n');
    },

    acceptance_rollout_report(args: { storyId: string; json?: boolean }): string {
      rejectBasisWriteShape(args as Record<string, unknown>, ['storyId', 'json']);
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const workspace = resolveStoryCommandWorkspace(store, args.storyId, ctx.root);
      const cohort = loadRegisteredAcceptanceRolloutCohort(workspace.signedWorkspaceRoot);
      const report = deriveAcceptanceRolloutReport({
        storyId: args.storyId,
        cohort,
        binding: currentAcceptanceRolloutBinding(workspace.signedWorkspaceRoot, workspace.metadataRoot),
        gitCwd: workspace.signedWorkspaceRoot,
      });
      const artifact = issueAcceptanceRolloutArtifact({
        gitCwd: workspace.signedWorkspaceRoot,
        report,
      });
      const verification = verifyAcceptanceRolloutArtifact({
        artifact,
        gitCwd: workspace.signedWorkspaceRoot,
        metadataRoot: workspace.metadataRoot,
        expectedStoryId: args.storyId,
        expectedCohort: cohort,
        mode: resolveAcceptanceRolloutGateMode(loadConfig(ctx.root)),
      });
      if (!verification.ok) {
        throw new Error(`acceptance_rollout_report refused non-promotable cohort: ${verification.diagnostics.join(',')}`);
      }
      store.writeAcceptanceRolloutReport(args.storyId, artifact);
      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'acceptance_rollout_report');
      if (args.json) return stringify({ artifact, verification });
      return [
        'Acceptance rollout report: PASS',
        `Story: ${args.storyId}`,
        `sampleCount=${report.metrics.registeredSeedCount}`,
        `seededDetection=${report.metrics.detectedSeedCount === report.metrics.registeredSeedCount ? '100%' : '0%'}`,
        `falseBlockRate=${report.metrics.falseBlockRate * 100}%`,
        `waiverDelta=${report.metrics.waiverDelta}`,
        'quorum=full-3x2',
        `receipt=${artifact.receipt.receiptRef}`,
      ].join('\n') + commitHint;
    },

    acceptance_rollout_report_read(args: { storyId: string; json?: boolean }): string {
      rejectBasisWriteShape(args as Record<string, unknown>, ['storyId', 'json']);
      if (!args.storyId) throw new Error('storyId is required');
      const verification = evaluateAcceptanceRolloutForContext(ctx, args.storyId);
      if (args.json) return stringify(verification);
      return [
        `Acceptance rollout report: ${verification.ok ? 'PASS' : 'FAIL'}`,
        `Story: ${args.storyId}`,
        `receipt=${verification.receipt}`,
        `quorum=${verification.quorum}`,
        `codes=${verification.diagnostics.join(',') || 'none'}`,
      ].join('\n');
    },

    acceptance_rollout_check(args: { storyId: string; json?: boolean }): string {
      rejectBasisWriteShape(args as Record<string, unknown>, ['storyId', 'json']);
      if (!args.storyId) throw new Error('storyId is required');
      const verification = evaluateAcceptanceRolloutForContext(ctx, args.storyId);
      if (args.json) return stringify(verification);
      return [
        `Acceptance rollout policy: ${verification.ok ? 'PASS promotionEligible=true' : 'FAIL promotionEligible=false'}`,
        `Story: ${args.storyId}`,
        `mode=${verification.mode}; status=${verification.status}; blocking=${verification.blocking}`,
        `receipt=${verification.receipt}; quorum=${verification.quorum}`,
        `codes=${verification.diagnostics.join(',') || 'none'}`,
      ].join('\n');
    },

    original_intent_snapshot_set(args: {
      storyId: string;
      sourceText: string;
      normalizedOutcome: string;
      acceptanceClaim: string;
      keyRequirementIds?: string[];
      json?: boolean;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const existing = store.readOriginalIntentSnapshot(args.storyId);
      const snapshot = buildOriginalIntentSnapshot(args, existing);
      store.writeOriginalIntentSnapshot(args.storyId, snapshot);
      if (args.json) return stringify(snapshot);
      return [
        'Original intent snapshot: configured',
        `Story: ${snapshot.storyId}`,
        `Request hash: ${snapshot.requestHash}`,
        `Key requirement ids: [${snapshot.keyRequirementIds.join(', ')}]`,
      ].join('\n');
    },

    original_intent_snapshot_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const snapshot = store.readOriginalIntentSnapshot(args.storyId);
      if (!snapshot) {
        const result = {
          storyId: args.storyId,
          status: 'not_configured',
          message: 'No original intent snapshot. Run original_intent_snapshot_set.',
        };
        return args.json ? stringify(result) : `Original intent snapshot: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('Original intent snapshot', snapshot, args);
    },

    milestone_ledger_set(args: { storyId: string; milestones: unknown[]; state?: 'candidate' | 'confirmed'; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const existing = store.readMilestoneLedger(args.storyId);
      const ledger = buildMilestoneLedger({
        storyId: args.storyId,
        milestones: args.milestones ?? [],
        existing,
        state: args.state,
      });
      store.writeMilestoneLedger(args.storyId, ledger);
      if (args.json) return stringify(ledger);
      return [
        'Milestone ledger: configured',
        `Story: ${ledger.storyId}`,
        `State: ${ledger.state ?? 'candidate'}`,
        `Ledger hash: ${ledger.ledgerHash}`,
        `Milestones: ${ledger.milestones.length}`,
        ...ledger.milestones.map((milestone) => `  - ${milestone.id}: ${milestone.claim}`),
      ].join('\n');
    },

    milestone_ledger_add(args: {
      storyId: string;
      milestone?: unknown;
      id?: string;
      sourceRequirementId?: string;
      claim?: string;
      doneMeans?: string;
      requiredEvidence?: string[];
      checklistRefs?: string[];
      verificationIntentRefs?: string[];
      parentLedgerId?: string;
      assignedStory?: string;
      status?: string;
      notApplicableDecision?: MilestoneNotApplicableDecision;
      json?: boolean;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const existing = store.readMilestoneLedger(args.storyId);
      const rawMilestone = args.milestone ?? {
        id: args.id,
        sourceRequirementId: args.sourceRequirementId,
        claim: args.claim,
        doneMeans: args.doneMeans,
        requiredEvidence: args.requiredEvidence,
        checklistRefs: args.checklistRefs,
        verificationIntentRefs: args.verificationIntentRefs,
        parentLedgerId: args.parentLedgerId,
        assignedStory: args.assignedStory,
        status: args.status,
        notApplicableDecision: args.notApplicableDecision,
      };
      const ledger = addMilestoneToLedger(args.storyId, rawMilestone, existing);
      store.writeMilestoneLedger(args.storyId, ledger);
      if (args.json) return stringify(ledger);
      return `Milestone ledger: added ${ledger.milestones.at(-1)?.id ?? '(unknown)'}\nState: ${ledger.state ?? 'candidate'}\nMilestones: ${ledger.milestones.length}`;
    },

    milestone_ledger_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const ledger = store.readMilestoneLedger(args.storyId);
      if (!ledger) {
        const result = {
          storyId: args.storyId,
          status: 'not_configured',
          message: 'No milestone ledger. It is optional unless structural/semantic milestone triggers exist or milestones are provided.',
        };
        return args.json ? stringify(result) : `Milestone ledger: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('Milestone ledger', ledger, args);
    },

    slice_plan_set(args: { storyId: string; slices: unknown[]; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const plan = buildSlicePlan({
        storyId: args.storyId,
        ledger: store.readMilestoneLedger(args.storyId),
        slices: args.slices ?? [],
        existing: store.readProofStorySlicePlan(args.storyId),
      });
      store.writeProofStorySlicePlan(args.storyId, plan);
      if (args.json) return stringify(plan);
      return [
        'Slice plan: configured',
        `Story: ${plan.storyId}`,
        `Ledger hash: ${plan.ledgerHash}`,
        `Plan hash: ${plan.planHash}`,
        `Slices: ${plan.slices.length}`,
        ...plan.slices.map((slice) => `  - ${slice.id}: ${slice.milestoneIds.join(', ')}${slice.assignedStory ? ` -> ${slice.assignedStory}` : ''}`),
        'No child stories were created automatically.',
      ].join('\n');
    },

    slice_plan_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const plan = store.readProofStorySlicePlan(args.storyId);
      if (!plan) {
        const result = {
          storyId: args.storyId,
          status: 'not_configured',
          message: 'No slice plan. It is optional unless the milestone ledger exceeds the single-story threshold.',
        };
        return args.json ? stringify(result) : `Slice plan: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('Slice plan', plan, args);
    },

    parent_ledger_rollup_set(args: { storyId: string; children: unknown[]; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const trusted = readTrustedProofStoryScopeArtifacts(store, args.storyId);
      const rollup = buildParentLedgerRollup({
        storyId: args.storyId,
        ledger: trusted.ledger,
        slicePlan: trusted.slicePlan,
        children: args.children ?? [],
        existing: store.readProofStoryParentLedgerRollup(args.storyId),
      });
      store.writeProofStoryParentLedgerRollup(args.storyId, rollup);
      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'parent_ledger_rollup_set', {
        closeoutArtifactPaths: ['parent-ledger-rollup.json'],
      });
      if (args.json) return stringify(rollup);
      return [
        'Parent ledger roll-up: configured',
        `Story: ${rollup.storyId}`,
        `Ledger hash: ${rollup.ledgerHash}`,
        `Slice plan hash: ${rollup.slicePlanHash ?? 'none'}`,
        `Children: ${rollup.children.length}`,
        ...rollup.children.map((child) => `  - ${child.storyId} [${child.status}]: ${child.milestoneIds.join(', ')}`),
      ].join('\n') + commitHint;
    },

    parent_ledger_rollup_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const rollup = store.readProofStoryParentLedgerRollup(args.storyId);
      if (!rollup) {
        const result = {
          storyId: args.storyId,
          status: 'not_configured',
          message: 'No parent ledger roll-up. It is optional unless a slice plan exists and DONE equivalence needs child coverage.',
        };
        return args.json ? stringify(result) : `Parent ledger roll-up: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('Parent ledger roll-up', rollup, args);
    },

    intent_collision_set(args: {
      storyId: string;
      decision: 'pass' | 'revise_intent' | 'human_gate' | 'stop';
      acceptedInterpretation?: string;
      notes?: string;
      id?: string;
      json?: boolean;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const existing = store.readIntentCollision(args.storyId);
      const ledger = store.readMilestoneLedger(args.storyId);
      const collision = buildIntentCollision(args, existing, ledger);
      store.writeIntentCollision(args.storyId, collision);
      const confirmed = confirmMilestoneLedger(args.storyId, ledger, collision);
      if (confirmed && confirmed !== ledger) store.writeMilestoneLedger(args.storyId, confirmed);
      const result = { collision, confirmedLedger: confirmed?.state === 'confirmed' ? confirmed : null };
      if (args.json) return stringify(result);
      return [
        'Intent collision: configured',
        `Story: ${collision.storyId}`,
        `Decision: ${collision.decision}`,
        `Status: ${collision.status}`,
        confirmed?.state === 'confirmed' ? `Confirmed ledger hash: ${confirmed.ledgerHash}` : 'Confirmed ledger hash: none',
      ].join('\n');
    },

    intent_collision_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const collision = store.readIntentCollision(args.storyId);
      if (!collision) {
        const result = {
          storyId: args.storyId,
          status: 'not_configured',
          message: 'No intent collision artifact. Run intent_collision_set.',
        };
        return args.json ? stringify(result) : `Intent collision: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('Intent collision', collision, args);
    },

    proofstory_contract_set(args: {
      storyId: string;
      acceptanceBindings?: unknown[];
      note?: string;
      json?: boolean;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      return withReviewInventoryMutationLock(store, args.storyId, () => {
      const state = diagnosticInput(args.storyId);
      const existing = store.readProofStoryContract(args.storyId);
      const contract = buildProofStoryContract(
        { storyId: args.storyId, acceptanceBindings: args.acceptanceBindings, note: args.note },
        {
          story: state.story,
          checklist: state.checklist,
          originalIntentSnapshot: state.originalIntentSnapshot,
          milestoneLedger: state.milestoneLedger,
          slicePlan: state.slicePlan,
          parentLedgerRollup: state.parentLedgerRollup,
          intentCollision: state.intentCollision,
          scopeContract: state.scopeContract,
          scopeShrinkageDecision: state.scopeShrinkageDecision,
          redEvidence: state.redEvidence,
          spikeEvidence: state.spikeEvidence,
          summary: state.summary,
        },
        existing,
      );
      if (['DEV', 'REVIEW', 'TEST', 'DONE'].includes(state.story.phase) && canonicalDigest(existing?.acceptanceBindings ?? []) !== canonicalDigest(contract.acceptanceBindings)) throw new Error('DEV topology growth requires acceptance_amendment_propose; frozen acceptance bindings cannot be rewritten');
      store.writeProofStoryContract(args.storyId, contract);
      if (args.json) return stringify(contract);
      return [
        'ProofStory contract: configured',
        `Story: ${contract.storyId}`,
        `Hardening level: ${contract.hardeningLevel}`,
        `Acceptance bindings: ${contract.acceptanceBindings.length}`,
        `Diagnostic gaps: ${contract.diagnosticGaps.length}`,
      ].join('\n');
      });
    },

    proofstory_contract_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const contract = store.readProofStoryContract(args.storyId);
      if (!contract) {
        const result = {
          storyId: args.storyId,
          status: 'not_configured',
          message: 'No ProofStory contract. Run proofstory_contract_set.',
        };
        return args.json ? stringify(result) : `ProofStory contract: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('ProofStory contract', contract, args);
    },

    acceptance_topology_check(args: { storyId: string; json?: boolean }): string {
      rejectBasisWriteShape(args as Record<string, unknown>, ['storyId', 'json']);
      if (!args.storyId) throw new Error('storyId is required');
      const report = evaluateAcceptanceTopologyForContext(ctx, args.storyId);
      if (args.json) return enforceOrRender(report, stringify(report));
      const text = [
        `Acceptance topology check for ${report.storyId}`,
        `Mode: ${report.mode} (flat project policy)`,
        `Status: ${report.status}`,
        `Basis status: ${report.basisStatus}`,
        `Structural pass: ${report.structuralPass ? 'yes' : 'no'}`,
        `Blocking: ${report.blocking ? 'yes' : 'no'}`,
        'Authority: diagnostic_only (read-only, non-evidentiary, PLAN structural semantics only)',
        'Diagnostics:',
        ...(report.diagnostics.length === 0
          ? ['  none']
          : report.diagnostics.map(item => `  ${item.code} ${item.bindingId} ${item.path}: ${item.message}`)),
        `Next action: ${report.nextAction}`,
      ].join('\n');
      return enforceOrRender(report, text);
    },

    acceptance_matrix(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const report = buildAcceptanceMatrixReport({
        storyId: args.storyId,
        checklist: readChecklistSafe(args.storyId),
        contract: store.readProofStoryContract(args.storyId),
        ledger: store.readMilestoneLedger(args.storyId),
      });
      if (args.json) return stringify(report);
      const lines = [
        `Acceptance matrix for ${report.storyId}`,
        'Mode: observe (read-only, non-evidentiary)',
        `Topology state: ${report.topologyState}`,
        `Result: ${report.result}`,
        'Rows:',
      ];
      for (const row of report.rows) {
        lines.push(
          `  ${row.acceptanceBindingRef} | result=${row.result} | checklist=[${row.checklistRefs.join(',')}] | intents=[${row.verificationIntentRefs.join(',')}] | milestones=[${row.milestoneRefs.join(',')}] | declarations=[${row.plannedPathDeclarationRefs.join(',')}] | endpoints=[${row.endpointRefs.join(',')}] | evidence=[${row.evidenceRefs.join(',')}] | diagnostics=[${row.diagnosticCodes.join(',')}]`,
        );
      }
      lines.push('Diagnostics:');
      if (report.diagnostics.length === 0) lines.push('  none');
      else report.diagnostics.forEach(diagnostic => lines.push(`  ${diagnostic.code} ${diagnostic.bindingId} ${diagnostic.path}: ${diagnostic.message}`));
      return lines.join('\n');
    },

    // B-1909: SOLE APPLIER of both withdrawal dispositions. It records the
    // decision, flips the named checklist items to status='withdrawn' (stamping
    // decisionRef), and appends append-only acceptance-binding withdrawal
    // records — all under one lock, after validating every ref, so a bad ref
    // mutates nothing. checklist_update and proofstory_contract_set refuse
    // withdrawn/disposition writes and redirect here.
    scope_shrinkage_decision_set(args: {
      storyId: string;
      decision: 'confirmed' | 'rejected';
      userConfirmed?: boolean;
      removedMilestoneIds?: string[];
      reason: string;
      approvedBy: string;
      decisionId?: string;
      withdrawnChecklistItemRefs?: string[];
      withdrawnAcceptanceBindingRefs?: string[];
      evidenceRefs?: string[];
      fullWithdrawalReapproval?: { approvedBy: string; reason: string; at: string };
      json?: boolean;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);

      // CHK-005: handler-entry re-validation of the ref arrays (belt-and-suspenders
      // over Zod; the internal fn path bypasses the CLI schema). Reuses the core
      // optionalStringArray helper so the validation rule cannot drift (B-1909 F-003).
      const withdrawnChecklistItemRefs = optionalStringArray(args.withdrawnChecklistItemRefs, 'withdrawnChecklistItemRefs');
      const withdrawnAcceptanceBindingRefs = optionalStringArray(args.withdrawnAcceptanceBindingRefs, 'withdrawnAcceptanceBindingRefs');
      const hasWithdrawals = withdrawnChecklistItemRefs.length > 0 || withdrawnAcceptanceBindingRefs.length > 0;

      return withReviewInventoryMutationLock(store, args.storyId, () => withMkdirLock(
        store.runtimeLockDirPath(args.storyId, 'checklist', 'checklist'),
        () => withScopeShrinkageTransaction(ctx.root, store, args.storyId, (tx) => {
          // Build (and shape-validate) the decision. buildScopeShrinkageDecision
          // enforces confirmed⇒userConfirmed and confirmed⇒non-empty removal set,
          // and stamps a stable decisionId.
          const decision = buildScopeShrinkageDecision(args, store.readScopeShrinkageDecision(args.storyId));
          const decisionId = decision.decisionId;
          if (!decisionId) throw new Error('internal: scope-shrinkage decisionId was not assigned');

          // A withdrawal is only authorized by a confirmed + userConfirmed decision.
          if (hasWithdrawals && !(decision.decision === 'confirmed' && decision.userConfirmed === true)) {
            throw new Error(
              'scope_shrinkage_decision_set refused: withdrawnChecklistItemRefs / withdrawnAcceptanceBindingRefs require decision=confirmed with userConfirmed:true',
            );
          }

          const contract = store.readProofStoryContract(args.storyId);
          const checklist = withdrawnChecklistItemRefs.length > 0
            ? store.readChecklist(args.storyId)
            : null;

          // VALIDATE every ref BEFORE any write (so a bad ref mutates nothing).
          if (checklist) {
            const checklistIds = new Set(checklist.items.map((item) => item.id));
            for (const ref of withdrawnChecklistItemRefs) {
              if (!checklistIds.has(ref)) {
                throw new Error(`scope_shrinkage_decision_set refused: withdrawnChecklistItemRef ${ref} is not a checklist item on ${args.storyId}`);
              }
            }
          }
          if (withdrawnAcceptanceBindingRefs.length > 0) {
            const bindingIds = new Set((contract?.acceptanceBindings ?? []).map((binding) => binding.id));
            for (const ref of withdrawnAcceptanceBindingRefs) {
              if (!bindingIds.has(ref)) {
                throw new Error(`scope_shrinkage_decision_set refused: withdrawnAcceptanceBindingRef ${ref} is not an acceptance binding on ${args.storyId}`);
              }
            }
          }

          // EMPTY-SCOPE FLOOR (CHK-006 / OQ-1): applying the binding withdrawals
          // must not empty the effective (non-withdrawn) binding set when the
          // contract originally had >= 1 binding, unless the confirmed decision
          // carries an explicit fullWithdrawalReapproval. Write-time refusal,
          // independent of doneGateMode.
          const originalBindingCount = contract?.acceptanceBindings?.length ?? 0;
          if (originalBindingCount > 0) {
            const effective = effectiveAcceptanceBindings(contract, decision);
            if (effective.length === 0 && !decision.fullWithdrawalReapproval) {
              throw new Error(
                'scope_shrinkage_decision_set refused: this withdrawal would empty the effective acceptance-binding set. ' +
                'Emptying scope requires an explicit fullWithdrawalReapproval {approvedBy, reason, at} on the confirmed decision. [empty_scope_after_withdrawal]',
              );
            }
          }

          // APPLY (validation passed): write all artifacts under the same lock.
          tx.write('scope-shrinkage-decision.json', decision, () => store.writeScopeShrinkageDecision(args.storyId, decision));

          if (checklist && withdrawnChecklistItemRefs.length > 0) {
            const now = new Date().toISOString();
            const targets = new Set(withdrawnChecklistItemRefs);
            for (const item of checklist.items) {
              if (!targets.has(item.id)) continue;
              item.status = 'withdrawn';
              item.decisionRef = decisionId;
              if (!item.endTime) item.endTime = now;
            }
            tx.write('checklist.json', checklist, () => store.writeChecklist(args.storyId, checklist));
          }

          if (withdrawnAcceptanceBindingRefs.length > 0 && contract) {
            const dispositions: ProofStoryBindingDisposition[] = [...(contract.bindingDispositions ?? [])];
            const alreadyWithdrawn = new Set(
              dispositions.filter((d) => d.disposition === 'withdrawn').map((d) => d.bindingId),
            );
            const withdrawnAt = new Date().toISOString();
            for (const bindingId of withdrawnAcceptanceBindingRefs) {
              if (alreadyWithdrawn.has(bindingId)) continue; // idempotent: no duplicate dispositions
              dispositions.push({ bindingId, disposition: 'withdrawn', decisionRef: decisionId, withdrawnAt });
              alreadyWithdrawn.add(bindingId);
            }
            const updatedContract: ProofStoryContractData = {
              ...contract,
              bindingDispositions: dispositions,
              updatedAt: new Date().toISOString(),
            };
            tx.write('proofstory.json', updatedContract, () => store.writeProofStoryContract(args.storyId, updatedContract));
          }

          if (hasWithdrawals) {
            try { autoCommitStoryMetadata(ctx.root, args.storyId, 'scope_shrinkage_decision_set'); } catch (error) { if (isValidationMetadataBusy(error)) throw error; /* Other persistence hints remain best-effort. */ }
          }

          if (args.json) return stringify(decision);
          return [
            `Scope shrinkage decision: ${decision.decision}`,
            `Decision id: ${decisionId}`,
            `User confirmed: ${decision.userConfirmed ? 'yes' : 'no'}`,
            `Removed milestones: ${decision.removedMilestoneIds.join(', ') || 'none'}`,
            `Withdrawn checklist items: ${withdrawnChecklistItemRefs.join(', ') || 'none'}`,
            `Withdrawn acceptance bindings: ${withdrawnAcceptanceBindingRefs.join(', ') || 'none'}`,
          ].join('\n');
        }),
        { label: 'checklist metadata' },
      ));
    },

    scope_shrinkage_decision_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const decision = store.readScopeShrinkageDecision(args.storyId);
      if (!decision) {
        const result = { storyId: args.storyId, status: 'not_configured', message: 'No scope shrinkage decision.' };
        return args.json ? stringify(result) : `Scope shrinkage decision: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('Scope shrinkage decision', decision, args);
    },

    red_evidence_create(args: {
      storyId: string;
      trigger: string;
      acceptanceTargetRef?: string;
      baselineHeadHash?: string;
      baselineMaterialHash?: string;
      observedFailure: string;
      failingCommand?: string;
      failureReceiptHash?: string;
      expectedGreenCommand?: string;
      greenTargetRef?: string;
      greenRelation?: 'same_acceptance' | 'regression_to_green' | 'replacement';
      greenHeadHash?: string;
      greenMaterialHash?: string;
      note?: string;
      id?: string;
      json?: boolean;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const baselineHeadHash = args.baselineHeadHash ?? currentGitHead(ctx.root);
      const baselineMaterialHash = args.baselineMaterialHash ?? currentMaterialHash(ctx.root, 'HEAD', ctx.root);
      // ── B-2aa7 CHK-006, §10.4 row C2 — THE DATA-LOSS SITE.
      //
      // This is the repair path: §9 says an operator must be able to fix a
      // corrupt artifact by appending a good record. But the append REBUILDS the
      // envelope from the read result, and D-4 quarantine hands it a CLEAN
      // `records` array — so a naive read→append→write would persist the clean
      // subset and DELETE the malformed originals. The operator would destroy
      // the evidence they came to repair, silently, with one command.
      //
      // Two branches, and each is one of the two outcomes C2 allows:
      //
      //   ENVELOPE FAULT -> REFUSE, with a message that names the corruption and
      //     the repair path. There is no readable envelope to append to, so any
      //     write here would overwrite a file whose contents we cannot even
      //     enumerate. `red_evidence_get` still displays it (C1), so the
      //     artifact stays diagnosable — it is refused, not abandoned.
      //
      //   QUARANTINE -> REPAIR BY APPENDING. `restoreQuarantinedRecords` puts
      //     every quarantined original back at its on-disk index, so what is
      //     written is the artifact as it was plus the new record. Nothing is
      //     lost, and the next read quarantines the same entries again.
      let existing: RedEvidenceData | null;
      try {
        existing = store.readRedEvidence(args.storyId);
      } catch (e) {
        const corruption = describeRedEvidenceReadFailure(e);
        if (corruption === null) throw e;
        throw new Error(
          `red_evidence_create refused: this story's red-evidence artifact cannot be read as an envelope, so appending ` +
            `would overwrite records that are still on disk. Nothing written.\n${corruption}\n` +
            `${redEvidenceRepairGuidance(args.storyId)}`,
        );
      }
      const quarantined = redEvidenceQuarantinedRecords(existing);
      const appended = appendRedEvidence({
        ...args,
        baselineHeadHash,
        baselineMaterialHash,
      }, existing);
      // Identity on a clean/absent read; throws rather than write a lossy
      // envelope if retention cannot be proven.
      const evidence = restoreQuarantinedRecords(existing, appended);
      store.writeRedEvidence(args.storyId, evidence);
      if (args.json) return stringify(evidence);
      // red_evidence_create only ever appends a v1 record (appendRedEvidence),
      // so the freshly-appended tail is a v1 RedEvidenceRecord.
      const latest = evidence.records.at(-1) as RedEvidenceRecord | undefined;
      return [
        'Red evidence: recorded',
        `Records: ${evidence.records.length}`,
        `Target: ${latest?.acceptanceTargetRef ?? 'unknown'}`,
        `Baseline head: ${latest?.baselineHeadHash ?? 'unknown'}`,
        `Baseline material: ${latest?.baselineMaterialHash ?? 'unknown'}`,
        ...(quarantined.length === 0
          ? []
          : [
            `Retained quarantined records: ${quarantined.length} (still on disk, at their original positions — repaired by appending, nothing dropped)`,
            renderRedEvidenceQuarantineNotice(args.storyId, existing) ?? '',
          ]),
      ].join('\n');
    },

    red_evidence_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      // ── B-2aa7 CHK-006, §10.4 row C1 / §9.
      //
      // This is the DIAGNOSTIC command, so a throwing read boundary breaks it
      // first and locks the operator out of inspecting the very file they must
      // repair. It must DISPLAY corruption, never abort on it — and it must not
      // reuse the `not configured` wording, because "corrupt" reading as
      // "absent" is the defect this story exists to remove.
      let evidence: RedEvidenceData | null;
      try {
        evidence = store.readRedEvidence(args.storyId);
      } catch (e) {
        const corruption = describeRedEvidenceReadFailure(e);
        if (corruption === null) throw e;
        const result = {
          storyId: args.storyId,
          status: 'corrupt',
          corruption: { kind: 'read_rejected', message: corruption },
        };
        return args.json
          ? stringify(result)
          : `Red evidence: CORRUPT\nStory: ${args.storyId}\n${corruption}\n${redEvidenceRepairGuidance(args.storyId)}`;
      }
      if (!evidence) {
        const result = { storyId: args.storyId, status: 'not_configured', message: 'No red evidence.' };
        return args.json ? stringify(result) : `Red evidence: not configured\nStory: ${args.storyId}`;
      }
      const quarantined = redEvidenceQuarantinedRecords(evidence);
      if (quarantined.length > 0) {
        // The artifact loaded, so the well-formed records are shown as usual —
        // but the quarantined originals are shown TOO, verbatim, which is what
        // makes this a diagnosis rather than a partial view.
        const corruption = renderRedEvidenceQuarantineNotice(args.storyId, evidence) ?? '';
        const result = {
          storyId: args.storyId,
          status: 'corrupt',
          corruption: { kind: 'quarantined_records', count: quarantined.length, message: corruption, records: quarantined },
          evidence,
        };
        return args.json
          ? stringify(result)
          : `Red evidence: CORRUPT (${quarantined.length} quarantined record(s))\nStory: ${args.storyId}\n`
            + `${corruption}\n${redEvidenceRepairGuidance(args.storyId)}\n${stringify(evidence)}`;
      }
      return renderStored('Red evidence', evidence, args);
    },

    spike_start(args: { storyId: string; id?: string; question: string; disposableCodePaths?: string[]; note?: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const spikes = startSpike(args, store.readProofStorySpikes(args.storyId));
      store.writeProofStorySpikes(args.storyId, spikes);
      if (args.json) return stringify(spikes);
      return `Spike: started ${spikes.spikes.at(-1)?.id ?? '(unknown)'}\nActive spikes: ${spikes.spikes.filter(s => s.status === 'active').length}`;
    },

    spike_result_set(args: { storyId: string; id: string; result: string; note?: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const spikes = setSpikeResult(args, store.readProofStorySpikes(args.storyId));
      store.writeProofStorySpikes(args.storyId, spikes);
      if (args.json) return stringify(spikes);
      return `Spike: resolved ${args.id}`;
    },

    spike_result(args: { storyId: string; id: string; result: string; note?: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const spikes = setSpikeResult(args, store.readProofStorySpikes(args.storyId));
      store.writeProofStorySpikes(args.storyId, spikes);
      if (args.json) return stringify(spikes);
      return `Spike: resolved ${args.id}`;
    },

    spike_discard(args: { storyId: string; id: string; note?: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const spikes = setSpikeStatus(args, store.readProofStorySpikes(args.storyId), 'discarded');
      store.writeProofStorySpikes(args.storyId, spikes);
      if (args.json) return stringify(spikes);
      return `Spike: discarded ${args.id}`;
    },

    spike_promote(args: { storyId: string; id: string; promotedAs?: 'red_evidence' | 'verification_evidence' | 'scope_decision' | 'implementation_note'; note?: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const spikes = setSpikeStatus(args, store.readProofStorySpikes(args.storyId), 'promoted');
      store.writeProofStorySpikes(args.storyId, spikes);
      if (args.json) return stringify(spikes);
      return `Spike: promoted ${args.id}\nPromotion is audit metadata only; create red or verification evidence separately.`;
    },

    spike_get(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const spikes = store.readProofStorySpikes(args.storyId);
      if (!spikes) {
        const result = { storyId: args.storyId, status: 'not_configured', message: 'No spike evidence.' };
        return args.json ? stringify(result) : `Spike evidence: not configured\nStory: ${args.storyId}`;
      }
      return renderStored('Spike evidence', spikes, args);
    },

    intent_coverage_check(args: { storyId: string; dryRun?: boolean; mode?: ProofStoryGateMode; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const report = evaluateProofStoryDiagnostics(diagnosticInput(args.storyId), resolveMode(args));
      const coverageGaps = [
        ...report.missingMvpArtifacts,
        ...report.missingMilestoneCoverage,
        ...report.missingConfirmedLedger,
        ...report.missingAcceptanceBindings,
      ];
      const coverageBlocking = report.mode === 'enforce' && coverageGaps.length > 0;
      const coverageStatus: 'pass' | 'warn' | 'fail' = coverageBlocking ? 'fail' : coverageGaps.length > 0 ? 'warn' : 'pass';
      const coverageReport = {
        ...report,
        status: coverageStatus,
        blocking: coverageBlocking,
        gaps: coverageGaps,
        wouldBlockFutureDevAdmission: coverageGaps.length > 0,
      };
      if (args.json) return enforceOrRender(coverageReport, stringify(coverageReport));
      return enforceOrRender(coverageReport, renderProofStoryDiagnosticReport(coverageReport));
    },

    proofstory_gate_check(args: { storyId: string; dryRun?: boolean; mode?: ProofStoryGateMode; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      return renderGateReport(args.storyId, args);
    },

    done_intent_equivalence_check(args: { storyId: string; mode?: ProofStoryGateMode; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const report = evaluateDoneIntentEquivalence(diagnosticInput(args.storyId), resolveMode(args));
      if (args.json) return enforceOrRender(report, stringify(report));
      return enforceOrRender(
        report,
        [
          `DONE intent equivalence for ${report.storyId}`,
          `Mode: ${report.mode}`,
          `Equivalence mode: ${report.equivalenceMode}`,
          `Status: ${report.status}`,
          `Blocking: ${report.blocking ? 'yes' : 'no'}`,
          `Uncovered required milestones: ${report.uncoveredRequiredMilestoneIds.join(', ') || 'none'}`,
          `Accepted shrinkage milestones: ${report.acceptedShrinkageMilestoneIds.join(', ') || 'none'}`,
          `Gaps: ${report.gaps.length}`,
          ...report.gaps.map((gap) => `  - ${gap.code}: ${gap.message}`),
        ].join('\n'),
      );
    },

    proofstory_review_completeness_check(args: { storyId: string; mode?: ProofStoryGateMode; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const report = evaluateReviewCompleteness(diagnosticInput(args.storyId), resolveMode(args));
      if (args.json) return enforceOrRender(report, stringify(report));
      return enforceOrRender(
        report,
        [
          `ProofStory REVIEW completeness for ${report.storyId}`,
          `Mode: ${report.mode}`,
          `Status: ${report.status}`,
          `Blocking: ${report.blocking ? 'yes' : 'no'}`,
          `Gaps: ${report.gaps.length}`,
          ...report.gaps.map((gap) => `  - ${gap.code}: ${gap.message}`),
        ].join('\n'),
      );
    },
  };
}
