import {
  currentGitHead,
  currentMaterialHash,
  currentStoryFilesHash,
} from './evidence-freshness.js';
import { classifyMergeLineage } from './validation-lineage.js';
import { currentBuildArtifactsHash } from './build-artifacts-identity.js';
import type { TestEvidenceData } from './types.js';
import { artifactProtectionSatisfied } from './build-artifacts-protection.js';

export type ValidationEvidenceLineage = 'exact-head' | 'trusted-story-metadata-descendant' | 'rejected';

export interface ValidationEvidenceAdmissibility {
  ok: boolean;
  reasons: string[];
  reasonCodes: string[];
  lineage: ValidationEvidenceLineage;
  evidence: TestEvidenceData | null;
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
  buildArtifactsHash?: string;
}

export interface ValidationEvidenceAdmissibilityInput {
  evidence: TestEvidenceData | null;
  expectedCommand: string;
  currentCoverageSnapshot: string;
  recordedCoverageSnapshot: string | null;
  blockingDirtyReason: string;
  gitCwd: string;
  metadataRoot: string;
}

function outputPassState(output: string): 'pass' | 'not-all-pass' | 'invalid-json' {
  try {
    const parsed = JSON.parse(output);
    return parsed?.allPass === true || parsed?.allPassed === true ? 'pass' : 'not-all-pass';
  } catch {
    return 'invalid-json';
  }
}

function validationHeadLineage(args: {
  evidenceHead: string;
  currentHead: string;
  gitCwd: string;
  metadataRoot: string;
}): { lineage: ValidationEvidenceLineage; reason?: string; code?: string } {
  const classification = classifyMergeLineage(args);
  switch (classification.kind) {
    case 'exact-head':
      return { lineage: 'exact-head' };
    case 'trusted-descendant':
      // An empty net diff (byte-identical endpoint trees) is trusted: the
      // validation ran against identical content. A merge that re-touches a
      // content-unchanged file no longer surfaces here.
      return { lineage: 'trusted-story-metadata-descendant' };
    case 'untrusted':
      return { lineage: 'rejected', code: 'lineage_untrusted', reason: `validation evidence descendant lineage includes material path(s): ${classification.untrustedPaths.slice(0, 5).join(', ')}` };
    case 'not-ancestor':
      return { lineage: 'rejected', code: 'lineage_not_ancestor', reason: 'validation evidence head is not an ancestor of current HEAD' };
    case 'diff-failed':
      return { lineage: 'rejected', code: 'lineage_diff_failed', reason: `validation evidence lineage diff failed: ${classification.error}` };
    default: {
      const _exhaustive: never = classification;
      return _exhaustive;
    }
  }
}

export function evaluateValidationEvidenceAdmissibility(
  input: ValidationEvidenceAdmissibilityInput,
): ValidationEvidenceAdmissibility {
  const reasons: string[] = [];
  const reasonCodes: string[] = [];
  const add = (code: string, reason: string) => { reasonCodes.push(code); reasons.push(reason); };
  const evidence = input.evidence;
  if (!evidence) {
    return { ok: false, reasons: ['validation evidence is missing'], reasonCodes: ['evidence_missing'], lineage: 'rejected', evidence: null };
  }
  if (evidence.result !== 'PASS') add('result_not_pass', 'validation evidence result is not PASS');
  if (evidence.command !== input.expectedCommand) add('command_mismatch', `validation evidence command is not ${input.expectedCommand}`);
  const outputState = outputPassState(evidence.output);
  if (outputState === 'invalid-json') add('output_invalid_json', 'validation evidence output is not valid JSON');
  else if (outputState === 'not-all-pass') add('output_not_all_pass', 'validation evidence output is not allPass/allPassed=true');
  if (!evidence.verificationCoverage) add('coverage_missing', 'validation evidence is missing verificationCoverage');
  else {
    if (typeof evidence.verificationCoverage.missingRequired !== 'number') add('coverage_missing_required', 'validation evidence verificationCoverage is missing missingRequired');
    else if (evidence.verificationCoverage.missingRequired !== 0) add('coverage_gap', `validation evidence has ${evidence.verificationCoverage.missingRequired} required verification coverage gap(s)`);
    if (!input.recordedCoverageSnapshot) add('coverage_entries_missing', 'validation evidence verificationCoverage has no entries snapshot');
    else if (input.recordedCoverageSnapshot !== input.currentCoverageSnapshot) add('coverage_stale', 'validation evidence verificationCoverage does not match current checklist inputs/evidence');
  }
  if (input.blockingDirtyReason) add('blocking_dirty', input.blockingDirtyReason);
  if (!evidence.headHash || !evidence.materialHash || !evidence.storyFilesHash) {
    add('freshness_bindings_missing', 'validation evidence is missing headHash/materialHash/storyFilesHash freshness bindings');
  }

  const headHash = currentGitHead(input.gitCwd);
  const materialHash = currentMaterialHash(input.gitCwd, 'HEAD', input.metadataRoot);
  const storyFilesHash = currentStoryFilesHash(input.gitCwd, 'HEAD', input.metadataRoot);
  if (!headHash || !materialHash || !storyFilesHash) add('current_identity_unavailable', 'current head/material/story-files identity is unavailable');
  if (evidence.materialHash && materialHash && evidence.materialHash !== materialHash) add('material_mismatch', 'validation evidence materialHash does not match current materialHash');
  if (evidence.storyFilesHash && storyFilesHash && evidence.storyFilesHash !== storyFilesHash) add('story_files_mismatch', 'validation evidence storyFilesHash does not match current storyFilesHash');
  // The committed-tree digests above cannot see the gitignored dist the commands
  // executed. Legacy evidence without the binding is refused rather than trusted.
  const buildArtifactsHash = currentBuildArtifactsHash(input.gitCwd);
  if (!evidence.buildArtifactsHash) add('build_artifacts_unbound', 'validation evidence has no buildArtifactsHash binding; run validate again');
  else if (!buildArtifactsHash) add('build_artifacts_unavailable', 'current build artifacts identity is unavailable');
  else if (evidence.buildArtifactsHash !== buildArtifactsHash) add('build_artifacts_mismatch', 'validation evidence buildArtifactsHash does not match the compiled artifacts on disk');
  else if (!artifactProtectionSatisfied(evidence.buildArtifactsProtection)) add('build_artifacts_protection_unenforced', `validation evidence was recorded without enforced artifact write protection (${evidence.buildArtifactsProtection ?? 'not recorded'}); it cannot prove which build it executed`);

  let lineage: ValidationEvidenceLineage = 'rejected';
  if (evidence.headHash && headHash) {
    const evaluated = validationHeadLineage({
      evidenceHead: evidence.headHash,
      currentHead: headHash,
      gitCwd: input.gitCwd,
      metadataRoot: input.metadataRoot,
    });
    lineage = evaluated.lineage;
    if (evaluated.reason) add(evaluated.code ?? 'lineage_rejected', evaluated.reason);
  }
  const headAfter = currentGitHead(input.gitCwd);
  if (!headHash || headAfter !== headHash) {
    lineage = 'rejected';
    add('head_changed_during_evaluation', 'HEAD changed during validation evidence admissibility evaluation');
  }
  return {
    ok: reasons.length === 0 && lineage !== 'rejected',
    reasons: [...new Set(reasons)],
    reasonCodes: [...new Set(reasonCodes)],
    lineage,
    evidence,
    ...(headHash ? { headHash } : {}),
    ...(materialHash ? { materialHash } : {}),
    ...(storyFilesHash ? { storyFilesHash } : {}),
    ...(buildArtifactsHash ? { buildArtifactsHash } : {}),
  };
}
