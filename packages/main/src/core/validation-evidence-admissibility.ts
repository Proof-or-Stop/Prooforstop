import { execFileSync } from 'node:child_process';
import {
  currentGitHead,
  currentMaterialHash,
  currentStoryFilesHash,
  isStoryMetadataPath,
} from './evidence-freshness.js';
import type { TestEvidenceData } from './types.js';

export type ValidationEvidenceLineage = 'exact-head' | 'trusted-story-metadata-descendant' | 'rejected';

export interface ValidationEvidenceAdmissibility {
  ok: boolean;
  reasons: string[];
  lineage: ValidationEvidenceLineage;
  evidence: TestEvidenceData | null;
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
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

function outputIsAllPass(output: string): boolean {
  try {
    const parsed = JSON.parse(output);
    return parsed?.allPass === true || parsed?.allPassed === true;
  } catch {
    return false;
  }
}

function validationHeadLineage(args: {
  evidenceHead: string;
  currentHead: string;
  gitCwd: string;
  metadataRoot: string;
}): { lineage: ValidationEvidenceLineage; reason?: string } {
  if (args.evidenceHead === args.currentHead) return { lineage: 'exact-head' };
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', args.evidenceHead, args.currentHead], {
      cwd: args.gitCwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const commits = execFileSync('git', ['rev-list', '--reverse', `${args.evidenceHead}..${args.currentHead}`], {
      cwd: args.gitCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\n').map(value => value.trim()).filter(Boolean);
    const changed = [...new Set(commits.flatMap(commit => execFileSync(
      'git',
      ['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-m', commit],
      { cwd: args.gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).split('\n').map(value => value.trim()).filter(Boolean)))];
    if (changed.length === 0) return { lineage: 'rejected', reason: 'validation evidence descendant lineage is empty' };
    const untrusted = changed.filter(path => !isStoryMetadataPath(path, args.metadataRoot));
    if (untrusted.length > 0) {
      return { lineage: 'rejected', reason: `validation evidence descendant lineage includes non-story-metadata path(s): ${untrusted.slice(0, 5).join(', ')}` };
    }
    return { lineage: 'trusted-story-metadata-descendant' };
  } catch {
    return { lineage: 'rejected', reason: 'validation evidence head is not an ancestor of current HEAD' };
  }
}

export function evaluateValidationEvidenceAdmissibility(
  input: ValidationEvidenceAdmissibilityInput,
): ValidationEvidenceAdmissibility {
  const reasons: string[] = [];
  const evidence = input.evidence;
  if (!evidence) {
    return { ok: false, reasons: ['validation evidence is missing'], lineage: 'rejected', evidence: null };
  }
  if (evidence.result !== 'PASS') reasons.push('validation evidence result is not PASS');
  if (evidence.command !== input.expectedCommand) reasons.push(`validation evidence command is not ${input.expectedCommand}`);
  if (!outputIsAllPass(evidence.output)) reasons.push('validation evidence output is not parseable allPass/allPassed=true JSON');
  if (!evidence.verificationCoverage) reasons.push('validation evidence is missing verificationCoverage');
  else {
    if (typeof evidence.verificationCoverage.missingRequired !== 'number') reasons.push('validation evidence verificationCoverage is missing missingRequired');
    else if (evidence.verificationCoverage.missingRequired !== 0) reasons.push(`validation evidence has ${evidence.verificationCoverage.missingRequired} required verification coverage gap(s)`);
    if (!input.recordedCoverageSnapshot) reasons.push('validation evidence verificationCoverage has no entries snapshot');
    else if (input.recordedCoverageSnapshot !== input.currentCoverageSnapshot) reasons.push('validation evidence verificationCoverage does not match current checklist inputs/evidence');
  }
  if (input.blockingDirtyReason) reasons.push(input.blockingDirtyReason);
  if (!evidence.headHash || !evidence.materialHash || !evidence.storyFilesHash) {
    reasons.push('validation evidence is missing headHash/materialHash/storyFilesHash freshness bindings');
  }

  const headHash = currentGitHead(input.gitCwd);
  const materialHash = currentMaterialHash(input.gitCwd, 'HEAD', input.metadataRoot);
  const storyFilesHash = currentStoryFilesHash(input.gitCwd, 'HEAD', input.metadataRoot);
  if (!headHash || !materialHash || !storyFilesHash) reasons.push('current head/material/story-files identity is unavailable');
  if (evidence.materialHash && materialHash && evidence.materialHash !== materialHash) reasons.push('validation evidence materialHash does not match current materialHash');
  if (evidence.storyFilesHash && storyFilesHash && evidence.storyFilesHash !== storyFilesHash) reasons.push('validation evidence storyFilesHash does not match current storyFilesHash');

  let lineage: ValidationEvidenceLineage = 'rejected';
  if (evidence.headHash && headHash) {
    const evaluated = validationHeadLineage({
      evidenceHead: evidence.headHash,
      currentHead: headHash,
      gitCwd: input.gitCwd,
      metadataRoot: input.metadataRoot,
    });
    lineage = evaluated.lineage;
    if (evaluated.reason) reasons.push(evaluated.reason);
  }
  const headAfter = currentGitHead(input.gitCwd);
  if (!headHash || headAfter !== headHash) {
    lineage = 'rejected';
    reasons.push('HEAD changed during validation evidence admissibility evaluation');
  }
  return {
    ok: reasons.length === 0 && lineage !== 'rejected',
    reasons: [...new Set(reasons)],
    lineage,
    evidence,
    ...(headHash ? { headHash } : {}),
    ...(materialHash ? { materialHash } : {}),
    ...(storyFilesHash ? { storyFilesHash } : {}),
  };
}
