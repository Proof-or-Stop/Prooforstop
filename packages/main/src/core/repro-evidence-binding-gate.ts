import { listArtifacts, readArtifact, verifyArtifactDigest } from './evidence/artifact-store.js';
import { loadConfig } from './config.js';
import { buildProofAdmissibilityDiagnostic } from './proof-admissibility-gates.js';
import type {
  EvidenceArtifact,
  RegressionMatrixReviewPayload,
  ReproProbePayload,
  ReproReviewPayload,
  SpikeRecordPayload,
  SpikeReviewPayload,
  StoryEvidenceBindingPayload,
} from './evidence/types.js';
import type { StoryStore } from './store.js';
import type { ChecklistData, StoryInfo } from './types.js';

export type StoryEvidenceBindingGateReasonCode =
  | 'missing_story_evidence_binding'
  | 'stale_story_evidence_binding'
  | 'repro_first_bypassed'
  | 'repro_first_preflight_engine_error';

export type ReproFirstPreflightMode = 'off' | 'warn' | 'enforce';

export type ReproFirstRequirementReason =
  | 'file_declarations'
  | 'bug_story'
  | 'high_risk_code_verifiable'
  | 'bypass_eligible_no_files';

export interface ReproFirstRequirementClassification {
  required: boolean;
  reason: ReproFirstRequirementReason;
  details: string[];
}

export interface StoryEvidenceBindingGateResult {
  ok: boolean;
  blocking: boolean;
  required: boolean;
  mode: ReproFirstPreflightMode;
  reasonCode: StoryEvidenceBindingGateReasonCode | null;
  details: string[];
  requirementReason?: ReproFirstRequirementReason;
  requirementDetails?: string[];
  bindingArtifactId?: string;
}

const CODE_VERIFIABLE_RISK_CATEGORIES = new Set([
  'Security/Credentials',
  'Data Migration/Destructive',
  'State Machine/Gate',
  'Validation Framework',
  'Production/Emergency',
  'Breaking API Change',
]);

export function resolveReproFirstPreflightMode(projectRoot?: string): ReproFirstPreflightMode {
  if (!projectRoot) return 'warn';
  try {
    const mode = loadConfig(projectRoot).reproFirstPreflight?.mode;
    return mode === 'off' || mode === 'enforce' ? mode : 'warn';
  } catch {
    return 'warn';
  }
}

function checklistHasFileDeclarations(checklist: ChecklistData | null | undefined): boolean {
  if (!checklist) return false;
  return checklist.items.some(item => (
    (item.files?.modify?.length ?? 0) > 0 ||
    (item.files?.create?.length ?? 0) > 0 ||
    (item.files?.test?.length ?? 0) > 0
  ));
}

export function classifyReproFirstRequirement(
  story: StoryInfo | null | undefined,
  checklist: ChecklistData | null | undefined,
): ReproFirstRequirementClassification {
  if (checklistHasFileDeclarations(checklist)) {
    return {
      required: true,
      reason: 'file_declarations',
      details: ['checklist declares files.modify/create/test'],
    };
  }
  if (story?.type === 'bug') {
    return {
      required: true,
      reason: 'bug_story',
      details: ['story.type=bug'],
    };
  }
  const highRiskHits = (story?.riskSignals ?? [])
    .filter(signal => CODE_VERIFIABLE_RISK_CATEGORIES.has(signal.category))
    .map(signal => `${signal.category}:${signal.matched}`);
  if ((story?.priority === 'high' || story?.priority === 'critical') && highRiskHits.length > 0) {
    return {
      required: true,
      reason: 'high_risk_code_verifiable',
      details: [`priority=${story.priority}`, `riskSignals=${highRiskHits.join(', ')}`],
    };
  }
  return {
    required: false,
    reason: 'bypass_eligible_no_files',
    details: ['no checklist file declarations, bug type, or code-verifiable high-risk signal'],
  };
}

function resultFor(
  args: Omit<StoryEvidenceBindingGateResult, 'blocking'>,
): StoryEvidenceBindingGateResult {
  return {
    ...args,
    blocking: args.mode === 'enforce' && args.required && args.reasonCode !== null && args.reasonCode !== 'repro_first_bypassed' && args.reasonCode !== 'repro_first_preflight_engine_error',
  };
}

function isCandidateArtifact(artifact: EvidenceArtifact<unknown>, kind: string, details: string[]): boolean {
  let ok = true;
  if (artifact.artifactKind !== kind) {
    details.push(`${artifact.artifactId}: expected artifactKind=${kind}, got ${artifact.artifactKind}`);
    ok = false;
  }
  if (artifact.evidenceScope !== 'evidence-candidate') {
    details.push(`${artifact.artifactId}: expected evidenceScope=evidence-candidate, got ${artifact.evidenceScope}`);
    ok = false;
  }
  if (!verifyArtifactDigest(artifact, artifact.artifactDigest)) {
    details.push(`${artifact.artifactId}: artifact digest mismatch`);
    ok = false;
  }
  return ok;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function missingStringFields(record: Record<string, unknown>, fields: string[]): string[] {
  return fields.filter(field => typeof record[field] !== 'string' || String(record[field]).trim().length === 0);
}

function readBoundArtifact<TPayload>(
  projectRoot: string,
  artifactId: string,
  expectedKind: string,
  expectedDigest: string,
  details: string[],
): EvidenceArtifact<TPayload> | null {
  try {
    const artifact = readArtifact<TPayload>(projectRoot, artifactId);
    const generic = artifact as EvidenceArtifact<unknown>;
    if (!isCandidateArtifact(generic, expectedKind, details)) return null;
    if (!verifyArtifactDigest(generic, expectedDigest)) {
      details.push(`${artifactId}: expected digest ${expectedDigest}, got ${artifact.artifactDigest}`);
      return null;
    }
    return artifact;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    details.push(`${artifactId}: could not read ${expectedKind}: ${message}`);
    return null;
  }
}

function isAcceptedSpikeReview(payload: SpikeReviewPayload): boolean {
  return payload.verdict === 'confirmed';
}

function validateBindingCandidate(
  projectRoot: string,
  storyId: string,
  binding: EvidenceArtifact<StoryEvidenceBindingPayload>,
): { ok: boolean; details: string[] } {
  const details: string[] = [];
  const payload = binding.payload;

  isCandidateArtifact(binding as EvidenceArtifact<unknown>, 'story-evidence-binding', details);
  if (!isRecord(payload)) {
    details.push(`${binding.artifactId}: malformed story-evidence-binding payload: missing or non-object payload`);
    return { ok: false, details };
  }
  if (!isRecord(binding.subjectBinding)) {
    details.push(`${binding.artifactId}: malformed story-evidence-binding subjectBinding: missing or non-object subjectBinding`);
    return { ok: false, details };
  }
  const missingPayloadFields = missingStringFields(payload, [
    'storyId',
    'candidateId',
    'probeId',
    'probeDigest',
    'reviewId',
    'reviewDigest',
  ]);
  if (missingPayloadFields.length > 0) {
    details.push(`${binding.artifactId}: malformed story-evidence-binding payload missing required field(s): ${missingPayloadFields.join(', ')}`);
    return { ok: false, details };
  }
  const admissibility = buildProofAdmissibilityDiagnostic({
    artifactId: binding.artifactId,
    artifactKind: 'story-evidence-binding',
    consumer: 'STORY_INTAKE',
    claim: 'handoff-context',
    checks: {
      schemaVersion: binding.schemaVersion,
      strictShapeValid: true,
      semanticDigestValid: true,
      subjectMatches: true,
      producerBoundaryTrusted: true,
    },
  });
  if (!admissibility.allowed) {
    details.push(`${binding.artifactId}: proof-admissibility rejected STORY_INTAKE binding (${admissibility.reasons.join(',') || 'inadmissible'})`);
  }

  if (payload.storyId !== storyId) details.push(`${binding.artifactId}: payload.storyId=${payload.storyId} does not match ${storyId}`);
  if (binding.subjectBinding.storyId !== storyId) details.push(`${binding.artifactId}: subjectBinding.storyId=${binding.subjectBinding.storyId ?? '(missing)'} does not match ${storyId}`);
  if (binding.subjectBinding.candidateId !== payload.candidateId) details.push(`${binding.artifactId}: subjectBinding.candidateId does not match payload.candidateId`);
  if (binding.subjectBinding.probeId !== payload.probeId) details.push(`${binding.artifactId}: subjectBinding.probeId does not match payload.probeId`);

  const probe = readBoundArtifact<ReproProbePayload>(
    projectRoot,
    payload.probeId,
    'repro-probe',
    payload.probeDigest,
    details,
  );
  if (probe) {
    if (probe.payload.candidateId !== payload.candidateId) details.push(`${probe.artifactId}: probe candidateId does not match binding candidateId`);
    if (probe.subjectBinding.candidateId !== payload.candidateId) details.push(`${probe.artifactId}: probe subjectBinding.candidateId does not match binding candidateId`);
  }

  const review = readBoundArtifact<ReproReviewPayload>(
    projectRoot,
    payload.reviewId,
    'repro-review',
    payload.reviewDigest,
    details,
  );
  if (review) {
    if (review.subjectBinding.candidateId !== payload.candidateId) details.push(`${review.artifactId}: review subjectBinding.candidateId does not match binding candidateId`);
    if (review.subjectBinding.probeId !== payload.probeId) details.push(`${review.artifactId}: review subjectBinding.probeId does not match binding probeId`);
    if (review.payload.probeId !== payload.probeId) details.push(`${review.artifactId}: review payload.probeId does not match binding probeId`);
    if (review.payload.probeDigest !== payload.probeDigest) details.push(`${review.artifactId}: review payload.probeDigest does not match binding probeDigest`);
    if (review.payload.verdict !== 'red-reviewed') details.push(`${review.artifactId}: repro_first_candidate_unreviewed verdict=${review.payload.verdict}, expected red-reviewed`);
    if (review.payload.reviewedFailureClass !== 'target-bug') details.push(`${review.artifactId}: repro_first_reviewed_class_not_target_bug reviewedFailureClass=${review.payload.reviewedFailureClass}, expected target-bug`);
  }

  if (payload.spikeId || payload.spikeDigest) {
    if (!payload.spikeId || !payload.spikeDigest) {
      details.push(`${binding.artifactId}: spikeId and spikeDigest must be present together`);
    } else {
      const spike = readBoundArtifact<SpikeRecordPayload>(
        projectRoot,
        payload.spikeId,
        'spike-record',
        payload.spikeDigest,
        details,
      );
      if (spike) {
        if (spike.payload.candidateId !== payload.candidateId) details.push(`${spike.artifactId}: spike candidateId does not match binding candidateId`);
        if (spike.payload.probeId !== payload.probeId) details.push(`${spike.artifactId}: spike probeId does not match binding probeId`);
        if (spike.payload.probeDigest !== payload.probeDigest) details.push(`${spike.artifactId}: spike probeDigest does not match binding probeDigest`);
        if (spike.subjectBinding.candidateId !== payload.candidateId) details.push(`${spike.artifactId}: spike subjectBinding.candidateId does not match binding candidateId`);
        if (spike.subjectBinding.probeId !== payload.probeId) details.push(`${spike.artifactId}: spike subjectBinding.probeId does not match binding probeId`);
      }

      if (!payload.spikeReviewId || !payload.spikeReviewDigest) {
        details.push(`${binding.artifactId}: spikeReviewId and spikeReviewDigest are required when spikeId is present`);
      } else {
        const spikeReview = readBoundArtifact<SpikeReviewPayload>(
          projectRoot,
          payload.spikeReviewId,
          'spike-review',
          payload.spikeReviewDigest,
          details,
        );
        if (spikeReview) {
          const spikeReviewPayload = spikeReview.payload as SpikeReviewPayload & { status?: string };
          if (spikeReview.subjectBinding.candidateId !== payload.candidateId) details.push(`${spikeReview.artifactId}: spikeReview subjectBinding.candidateId does not match binding candidateId`);
          if (spikeReview.subjectBinding.probeId !== payload.probeId) details.push(`${spikeReview.artifactId}: spikeReview subjectBinding.probeId does not match binding probeId`);
          if (spikeReview.subjectBinding.spikeId !== payload.spikeId) details.push(`${spikeReview.artifactId}: spikeReview subjectBinding.spikeId does not match binding spikeId`);
          if (spikeReviewPayload.spikeId !== payload.spikeId) details.push(`${spikeReview.artifactId}: spikeReview payload.spikeId does not match binding spikeId`);
          if (spikeReviewPayload.spikeDigest !== payload.spikeDigest) details.push(`${spikeReview.artifactId}: spikeReview payload.spikeDigest does not match binding spikeDigest`);
          if (!isAcceptedSpikeReview(spikeReviewPayload)) {
            details.push(`${spikeReview.artifactId}: spike_review_not_confirmed verdict=${spikeReviewPayload.verdict}, status=${spikeReviewPayload.status ?? '(missing)'}, expected verdict=confirmed`);
          }
        }
      }
    }
  }

  const matrixReviewDigest = (payload as StoryEvidenceBindingPayload & { matrixReviewDigest?: string }).matrixReviewDigest;
  if (payload.matrixReviewId || matrixReviewDigest) {
    if (!payload.matrixReviewId || !matrixReviewDigest) {
      details.push(`${binding.artifactId}: matrixReviewId and matrixReviewDigest must be present together`);
    } else {
      const matrixReview = readBoundArtifact<RegressionMatrixReviewPayload>(
        projectRoot,
        payload.matrixReviewId,
        'regression-matrix-review',
        matrixReviewDigest,
        details,
      );
      if (matrixReview) {
        if (matrixReview.payload.candidateId !== payload.candidateId) details.push(`${matrixReview.artifactId}: matrixReview candidateId does not match binding candidateId`);
        if (matrixReview.payload.probeId !== payload.probeId) details.push(`${matrixReview.artifactId}: matrixReview probeId does not match binding probeId`);
        if (matrixReview.subjectBinding.candidateId !== payload.candidateId) details.push(`${matrixReview.artifactId}: matrixReview subjectBinding.candidateId does not match binding candidateId`);
        if (matrixReview.subjectBinding.probeId !== payload.probeId) details.push(`${matrixReview.artifactId}: matrixReview subjectBinding.probeId does not match binding probeId`);
        if (matrixReview.payload.spikeId && payload.spikeId && matrixReview.payload.spikeId !== payload.spikeId) {
          details.push(`${matrixReview.artifactId}: matrixReview spikeId does not match binding spikeId`);
        }
      }
    }
  }

  return { ok: details.length === 0, details };
}

export function evaluateStoryEvidenceBindingGate(
  projectRoot: string,
  store: StoryStore,
  storyId: string,
  options: { mode?: ReproFirstPreflightMode } = {},
): StoryEvidenceBindingGateResult {
  const mode = options.mode ?? resolveReproFirstPreflightMode(projectRoot);
  if (mode === 'off') {
    return resultFor({ ok: true, required: false, mode, reasonCode: null, details: ['reproFirstPreflight.mode=off'] });
  }

  let story: StoryInfo | null = null;
  try {
    story = store.readStory(storyId);
  } catch {
    story = null;
  }

  let checklist: ChecklistData | null = null;
  try {
    checklist = store.readChecklist(storyId);
  } catch {
    checklist = null;
  }

  const classification = classifyReproFirstRequirement(story, checklist);
  if (!classification.required) {
    return resultFor({
      ok: true,
      required: false,
      mode,
      reasonCode: null,
      details: classification.details,
      requirementReason: classification.reason,
      requirementDetails: classification.details,
    });
  }

  let bindings: EvidenceArtifact<StoryEvidenceBindingPayload>[];
  try {
    bindings = listArtifacts<StoryEvidenceBindingPayload>(projectRoot, 'story-evidence-binding')
      .filter(artifact => artifact.payload?.storyId === storyId || artifact.subjectBinding?.storyId === storyId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return resultFor({
      ok: true,
      required: true,
      mode,
      reasonCode: 'repro_first_preflight_engine_error',
      details: [`repro_first_preflight_engine_error: story-evidence-binding artifacts could not be read: ${message}`],
    });
  }

  if (bindings.length === 0) {
    return resultFor({
      ok: mode !== 'enforce',
      required: true,
      mode,
      reasonCode: 'missing_story_evidence_binding',
      details: ['repro_first_required_no_candidate: no story-evidence-binding candidate artifact is bound to this story', ...classification.details],
      requirementReason: classification.reason,
      requirementDetails: classification.details,
    });
  }

  const staleDetails: string[] = [];
  for (const binding of bindings) {
    const result = validateBindingCandidate(projectRoot, storyId, binding);
    if (result.ok) {
      return resultFor({
        ok: true,
        required: true,
        mode,
        reasonCode: null,
        details: [`bound-accepted: ${binding.artifactId}`],
        requirementReason: classification.reason,
        requirementDetails: classification.details,
        bindingArtifactId: binding.artifactId,
      });
    }
    staleDetails.push(...result.details.map(detail => `${binding.artifactId}: ${detail}`));
  }

  return resultFor({
    ok: mode !== 'enforce',
    required: true,
    mode,
    reasonCode: 'stale_story_evidence_binding',
    details: staleDetails.length > 0 ? staleDetails : ['bound story-evidence-binding artifact is stale or invalid'],
    requirementReason: classification.reason,
    requirementDetails: classification.details,
  });
}

function describeRequirement(result: StoryEvidenceBindingGateResult): string {
  const details = result.requirementDetails?.filter(detail => detail.trim().length > 0) ?? [];
  return `classifier=${result.requirementReason ?? 'unknown'}${details.length > 0 ? `; ${details.join('; ')}` : ''}`;
}

function describeRequirementSubject(result: StoryEvidenceBindingGateResult): string {
  switch (result.requirementReason) {
    case 'file_declarations':
      return 'the checklist declares files.modify/create/test';
    case 'bug_story':
      return 'story.type=bug';
    case 'high_risk_code_verifiable':
      return 'the story has code-verifiable high-risk signals';
    case 'bypass_eligible_no_files':
      return 'the story is not repro-first required';
    default:
      return 'the repro-first classifier requires accepted repro evidence';
  }
}

function describeRequirementRemediation(result: StoryEvidenceBindingGateResult): string {
  switch (result.requirementReason) {
    case 'file_declarations':
      return 'Create this code-changing story from accepted repro evidence with story_create_from_repro, or remove files.modify/create/test for non-code work.';
    case 'bug_story':
      return 'Create this bug story from accepted repro evidence with story_create_from_repro, or change the story type only if this is not actually bug work.';
    case 'high_risk_code_verifiable':
      return 'Create this high-risk code-verifiable story from accepted repro evidence with story_create_from_repro, or dismiss/adjust false-positive risk signals before entering lifecycle work.';
    default:
      return 'Create the story from accepted repro evidence with story_create_from_repro, or correct the classifier inputs before entering lifecycle work.';
  }
}

export function formatStoryEvidenceBindingGateFailure(
  targetPhase: 'PLAN' | 'DEV',
  storyId: string,
  result: StoryEvidenceBindingGateResult,
): string | null {
  if (result.ok || !result.reasonCode) return null;
  const requirementSubject = describeRequirementSubject(result);
  const classifier = describeRequirement(result);
  const lead = result.reasonCode === 'missing_story_evidence_binding'
    ? `Cannot enter ${targetPhase}: ${requirementSubject}, but no valid story-evidence-binding candidate artifact is bound to ${storyId}. [missing_story_evidence_binding]`
    : `Cannot enter ${targetPhase}: ${requirementSubject}, but the bound story-evidence-binding candidate artifact is stale or invalid for ${storyId}. [stale_story_evidence_binding]`;
  const details = result.details.slice(0, 6).map(detail => `  - ${detail}`).join('\n');
  return `${lead}\n  - ${classifier}${details ? `\n${details}` : ''}\n` +
    `→ ${describeRequirementRemediation(result)}`;
}
