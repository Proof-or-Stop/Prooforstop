import { strict as assert } from 'node:assert';

import { COMMIT_SUBJECT_PREFIX, DEPRECATED_COMMIT_SUBJECT_PREFIX, matchesRuntimeCommitSubject } from '../../core/auto-commit-metadata.js';

import { runAgentLivenessSuiteForPinnedEvidence } from '../agent-liveness-suite-smoke.js';

import { assertProductionHelperPassesProjectRootToClassifier, assertCustomStoryDirDirtyWorktreeClassification, assertDonePrepareOnePassConvergenceContract } from './done-convergence.js';
import { assertSessionBriefGate, assertFlowFactPolicyRegistry, assertPhaseGatePolicyHints, assertPhaseToolsOverrideStillBlocks, assertLifecycleRegistryConsistency, assertPhaseFlowDerivedValuesByteIdentical, assertStoryAdvanceTestGateFailClosedContracts, assertManagedAssetExpandedDocsAndTrueDrift, assertDispatchPromptsPinImplementerCommitAuthor } from './lifecycle.js';
import { assertDirtyWorktreeClassifierGroupsOwnership, assertDirtyGatePolicyAcrossGates } from './workspace.js';
import { assertDeclaredArtifactsChannel, assertDeclaredArtifactGateHotfix, assertDeclaredArtifactDoneCommittedRow, assertGlobalLinkRepair, assertAutoCommitMetadataAcrossHandlers } from './artifacts.js';
import { assertReviewGateUsesOptIn, assertReviewRunBindingRejectsInvalidEvidence, assertReviewRunStoryFilesHashBindingIsSigned, assertVerificationEvidenceStoryFilesHashDowngradesUnrelatedDrift, assertTestEvidenceStoryFilesHashDowngradesActiveDoneFreshness, assertReviewPreflightDoesNotDowngradePromptEnvelopeDriftToStoryHashAdvisory, assertSupersededReviewPassDoesNotBlockLatestReviewerRun, assertResolvedFindingStaleBindingIsForgivenWithoutValidLaneEvidence, assertReviewRunBindingRaceAcceptsNonLatestFreshPass, assertLegacyReviewEvidenceWithoutCurrentRoundStaysReadable } from './review-evidence.js';
import { assertNonReviewerFindingsDoNotCountAsReviewerEvidence, assertStoryAdvanceGuardIgnoresMainAgentDevFindings, assertStoryAdvanceReviewEchoOmitsRetiredChannel, assertReviewerStatusUsesMdFallback, assertSessionBriefStatusHintsMatchGates, assertReviewNextUsesReviewerGateState, assertDevGuidanceUsesReviewPhase, assertValidateHintsFollowStoryPhase, assertRealCliValidateHintFollowsActiveStoryPhase, assertBugUpdateTestHintUsesDonePrecheck, assertChannelGateRejectsProofOrStopSubjectForRealFiles, assertChannelGateAcceptsStructuredEvidenceWithSharedGitAuthor, assertChannelGateAcceptsSuccessfulSubagentResultEvidence, assertChannelGateAcceptsDispatchEvidence, assertChannelGateRejectsImplementerAuthorWithoutDispatch } from './review-routing.js';
import { assertDoneChecklistUsesStableOracleRows, assertDoneClosureProjectionSeparatesAuthority, assertDoneOracleSameSource } from './done-reporting.js';
import { assertPhaseGatesAndEffectsExtraction } from './phase-effects.js';

async function assertHistoricalCommitSubjects() {
  const body = 'story B-readboth init';
  assert.equal(
    matchesRuntimeCommitSubject(`${COMMIT_SUBJECT_PREFIX} ${body}`, body),
    true,
    'read-both must accept the canonical proof-or-stop: subject',
  );
  assert.equal(
    matchesRuntimeCommitSubject(`${DEPRECATED_COMMIT_SUBJECT_PREFIX} ${body}`, body),
    true,
    'read-both must STILL accept the deprecated proofOrStop: subject — pre-rename history depends on it',
  );
  assert.equal(
    matchesRuntimeCommitSubject(`chore: ${body}`, body),
    false,
    'read-both must reject an unrelated prefix rather than matching on the body alone',
  );
  assert.equal(
    matchesRuntimeCommitSubject(`${COMMIT_SUBJECT_PREFIX} something else`, body),
    false,
    'read-both must not match a canonical-prefixed subject with a different body',
  );
  assert.equal(COMMIT_SUBJECT_PREFIX, 'proof-or-stop:', 'writer prefix is the canonical bin name');
  assert.equal(DEPRECATED_COMMIT_SUBJECT_PREFIX, 'proofOrStop:', 'deprecated prefix is retained verbatim for compatibility');
}

export const FLOW_CASES = [
  { id: 'assertProductionHelperPassesProjectRootToClassifier', capability: 'done-convergence', run: assertProductionHelperPassesProjectRootToClassifier },
  { id: 'assertCustomStoryDirDirtyWorktreeClassification', capability: 'done-convergence', run: assertCustomStoryDirDirtyWorktreeClassification },
  { id: 'assertDonePrepareOnePassConvergenceContract', capability: 'done-convergence', run: assertDonePrepareOnePassConvergenceContract },
  { id: 'assertSessionBriefGate', capability: 'lifecycle', run: assertSessionBriefGate },
  { id: 'assertDirtyWorktreeClassifierGroupsOwnership', capability: 'workspace', run: assertDirtyWorktreeClassifierGroupsOwnership },
  { id: 'assertDirtyGatePolicyAcrossGates', capability: 'workspace', run: assertDirtyGatePolicyAcrossGates },
  { id: 'assertDeclaredArtifactsChannel', capability: 'artifacts', run: assertDeclaredArtifactsChannel },
  { id: 'assertDeclaredArtifactGateHotfix', capability: 'artifacts', run: assertDeclaredArtifactGateHotfix },
  { id: 'assertDeclaredArtifactDoneCommittedRow', capability: 'artifacts', run: assertDeclaredArtifactDoneCommittedRow },
  { id: 'assertFlowFactPolicyRegistry', capability: 'lifecycle', run: assertFlowFactPolicyRegistry },
  { id: 'assertPhaseGatePolicyHints', capability: 'lifecycle', run: assertPhaseGatePolicyHints },
  { id: 'assertPhaseToolsOverrideStillBlocks', capability: 'lifecycle', run: assertPhaseToolsOverrideStillBlocks },
  { id: 'assertLifecycleRegistryConsistency', capability: 'lifecycle', run: assertLifecycleRegistryConsistency },
  { id: 'assertPhaseFlowDerivedValuesByteIdentical', capability: 'lifecycle', run: assertPhaseFlowDerivedValuesByteIdentical },
  { id: 'assertStoryAdvanceTestGateFailClosedContracts', capability: 'lifecycle', run: assertStoryAdvanceTestGateFailClosedContracts },
  { id: 'assertManagedAssetExpandedDocsAndTrueDrift', capability: 'lifecycle', run: assertManagedAssetExpandedDocsAndTrueDrift },
  { id: 'assertDispatchPromptsPinImplementerCommitAuthor', capability: 'lifecycle', run: assertDispatchPromptsPinImplementerCommitAuthor },
  { id: 'assertReviewGateUsesOptIn', capability: 'review-evidence', run: assertReviewGateUsesOptIn },
  { id: 'assertReviewRunBindingRejectsInvalidEvidence', capability: 'review-evidence', run: assertReviewRunBindingRejectsInvalidEvidence },
  { id: 'assertReviewRunStoryFilesHashBindingIsSigned', capability: 'review-evidence', run: assertReviewRunStoryFilesHashBindingIsSigned },
  { id: 'assertVerificationEvidenceStoryFilesHashDowngradesUnrelatedDrift', capability: 'review-evidence', run: assertVerificationEvidenceStoryFilesHashDowngradesUnrelatedDrift },
  { id: 'assertTestEvidenceStoryFilesHashDowngradesActiveDoneFreshness', capability: 'review-evidence', run: assertTestEvidenceStoryFilesHashDowngradesActiveDoneFreshness },
  { id: 'assertReviewPreflightDoesNotDowngradePromptEnvelopeDriftToStoryHashAdvisory', capability: 'review-evidence', run: assertReviewPreflightDoesNotDowngradePromptEnvelopeDriftToStoryHashAdvisory },
  { id: 'assertSupersededReviewPassDoesNotBlockLatestReviewerRun', capability: 'review-evidence', run: assertSupersededReviewPassDoesNotBlockLatestReviewerRun },
  { id: 'assertResolvedFindingStaleBindingIsForgivenWithoutValidLaneEvidence', capability: 'review-evidence', run: assertResolvedFindingStaleBindingIsForgivenWithoutValidLaneEvidence },
  { id: 'assertReviewRunBindingRaceAcceptsNonLatestFreshPass', capability: 'review-evidence', run: assertReviewRunBindingRaceAcceptsNonLatestFreshPass },
  { id: 'assertLegacyReviewEvidenceWithoutCurrentRoundStaysReadable', capability: 'review-evidence', run: assertLegacyReviewEvidenceWithoutCurrentRoundStaysReadable },
  { id: 'assertNonReviewerFindingsDoNotCountAsReviewerEvidence', capability: 'review-routing', run: assertNonReviewerFindingsDoNotCountAsReviewerEvidence },
  { id: 'assertStoryAdvanceGuardIgnoresMainAgentDevFindings', capability: 'review-routing', run: assertStoryAdvanceGuardIgnoresMainAgentDevFindings },
  { id: 'assertStoryAdvanceReviewEchoOmitsRetiredChannel', capability: 'review-routing', run: assertStoryAdvanceReviewEchoOmitsRetiredChannel },
  { id: 'assertReviewerStatusUsesMdFallback', capability: 'review-routing', run: assertReviewerStatusUsesMdFallback },
  { id: 'assertSessionBriefStatusHintsMatchGates', capability: 'review-routing', run: assertSessionBriefStatusHintsMatchGates },
  { id: 'assertReviewNextUsesReviewerGateState', capability: 'review-routing', run: assertReviewNextUsesReviewerGateState },
  { id: 'assertDevGuidanceUsesReviewPhase', capability: 'review-routing', run: assertDevGuidanceUsesReviewPhase },
  { id: 'assertValidateHintsFollowStoryPhase', capability: 'review-routing', run: assertValidateHintsFollowStoryPhase },
  { id: 'assertRealCliValidateHintFollowsActiveStoryPhase', capability: 'review-routing', run: assertRealCliValidateHintFollowsActiveStoryPhase },
  { id: 'assertBugUpdateTestHintUsesDonePrecheck', capability: 'review-routing', run: assertBugUpdateTestHintUsesDonePrecheck },
  { id: 'assertChannelGateRejectsProofOrStopSubjectForRealFiles', capability: 'review-routing', run: assertChannelGateRejectsProofOrStopSubjectForRealFiles },
  { id: 'assertChannelGateAcceptsStructuredEvidenceWithSharedGitAuthor', capability: 'review-routing', run: assertChannelGateAcceptsStructuredEvidenceWithSharedGitAuthor },
  { id: 'assertChannelGateAcceptsSuccessfulSubagentResultEvidence', capability: 'review-routing', run: assertChannelGateAcceptsSuccessfulSubagentResultEvidence },
  { id: 'assertChannelGateAcceptsDispatchEvidence', capability: 'review-routing', run: assertChannelGateAcceptsDispatchEvidence },
  { id: 'assertChannelGateRejectsImplementerAuthorWithoutDispatch', capability: 'review-routing', run: assertChannelGateRejectsImplementerAuthorWithoutDispatch },
  { id: 'assertDoneChecklistUsesStableOracleRows', capability: 'done-reporting', run: assertDoneChecklistUsesStableOracleRows },
  { id: 'assertDoneClosureProjectionSeparatesAuthority', capability: 'done-reporting', run: assertDoneClosureProjectionSeparatesAuthority },
  { id: 'assertDoneOracleSameSource', capability: 'done-reporting', run: assertDoneOracleSameSource },
  { id: 'assertPhaseGatesAndEffectsExtraction', capability: 'phase-effects', run: assertPhaseGatesAndEffectsExtraction },
  { id: 'assertGlobalLinkRepair', capability: 'artifacts', run: assertGlobalLinkRepair },
  { id: 'assertAutoCommitMetadataAcrossHandlers', capability: 'artifacts', run: assertAutoCommitMetadataAcrossHandlers },
  { id: 'runAgentLivenessSuiteForPinnedEvidence', capability: 'liveness', run: runAgentLivenessSuiteForPinnedEvidence },
  { id: 'assertHistoricalCommitSubjects', capability: 'history-compatibility', run: assertHistoricalCommitSubjects },
];

export async function runFlowStabilityCli(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--acceptance-basis-fixture') {
    await assertStoryAdvanceReviewEchoOmitsRetiredChannel(true);
    console.log('PASS acceptance basis discovery fixture'); return;
  }
  if (args.length === 1 && args[0] === '--terminal-finding-forgiveness') {
    assertResolvedFindingStaleBindingIsForgivenWithoutValidLaneEvidence();
    console.log('TERMINAL_FINDING_FORGIVENESS_PASS'); return;
  }
  const capabilities = [...new Set(FLOW_CASES.map(row => row.capability))];
  if (args.length === 1 && args[0] === '--list-capabilities') {
    console.log(JSON.stringify(capabilities.map(id => ({ id, checks: FLOW_CASES.filter(row => row.capability === id).map(row => row.id) })))); return;
  }
  const canonicalCore = args.length === 1 && args[0] === '--canonical-core';
  let selected = canonicalCore ? capabilities.filter(id => id !== 'liveness') : capabilities;
  if (args.length && !canonicalCore && !(args.length === 1 && args[0] === '--all')) {
    selected = [...new Set(args.map(arg => {
      if (!arg.startsWith('--capability=') || !capabilities.includes(arg.slice(13))) throw new Error('Unknown flow verification argument: ' + arg);
      return arg.slice(13);
    }))];
  }
  for (const row of FLOW_CASES) if (selected.includes(row.capability)) await row.run();
  if (canonicalCore) console.log('flow-stability-smoke: CANONICAL CORE PASS');
  else if (selected.length === capabilities.length) console.log('✓ flow stability smoke passed');
  else console.log('FLOW_PARTIAL_PASS ' + JSON.stringify({ full: false, capabilities: selected }));
}
