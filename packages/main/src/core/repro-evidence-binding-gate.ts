import { rethrowIntentAmendmentIntegrityError } from './verification-intent-amendment.js';
import { listArtifacts, readArtifact, verifyArtifactDigest } from './evidence/artifact-store.js';
import { loadConfig, PROOF_OR_STOP_CONFIG_FILENAME } from './config.js';
import { buildProofAdmissibilityDiagnostic } from './proof-admissibility-gates.js';
import {
  buildMaterialClassificationSnapshot,
  classifyDeclaredPaths,
  ensureFreshMaterialClassificationSnapshot,
  MaterialCodePolicyError,
  type MaterialClassificationSnapshot,
} from './material-code-policy.js';
import type {
  EvidenceArtifact,
  RegressionMatrixReviewPayload,
  ReproProbePayload,
  ReproReviewPayload,
  SpikeRecordPayload,
  SpikeReviewPayload,
  StoryEvidenceBindingPayload,
} from './evidence/types.js';
import { resolveGitCwd } from './story-signed-workspace-resolution.js';
import type { StoryStore } from './store.js';
import type { ChecklistData, StoryInfo } from './types.js';

export type StoryEvidenceBindingGateReasonCode =
  | 'missing_story_evidence_binding'
  | 'stale_story_evidence_binding'
  | 'repro_first_bypassed'
  | 'repro_first_preflight_engine_error'
  // B-956f FIX 5: the material-code policy/classification failed closed (malformed
  // proof-or-stop.config.json, or unverifiable git-snapshot freshness) while evaluating
  // repro-first requirements. Fails the gate regardless of reproFirst mode.
  | 'repro_first_material_policy_error';

export type ReproFirstPreflightMode = 'off' | 'warn' | 'enforce';

export type ReproFirstRequirementReason =
  | 'code_verifiable_behavior_change'
  | 'high_risk_code_verifiable'
  | 'bypass_eligible_no_files'
  // Legacy reasons (B-8628: no longer produced; retained for backward-compat with any consumer).
  | 'file_declarations'
  | 'bug_story';

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

/**
 * B-8628 / B-956f: collect the checklist's declared files that are MATERIAL CODE
 * using the shared, config-resolved classification snapshot (language-neutral:
 * .ts/.js/.py/.rs/.go/… + cross-ecosystem manifests = material; docs/metadata =
 * not). The snapshot parameter is REQUIRED (compile-time fail-closed) so this
 * path can never regress to the old config-blind call that dropped projectRoot
 * and silently classified non-JS code as non-material.
 */
function collectMaterialCodeFiles(
  checklist: ChecklistData | null | undefined,
  snapshot: MaterialClassificationSnapshot,
): string[] {
  if (!checklist) return [];
  const declared = checklist.items.flatMap(item => [
    ...(item.files?.modify ?? []),
    ...(item.files?.create ?? []),
    ...(item.files?.test ?? []),
  ]);
  return classifyDeclaredPaths(snapshot, declared)
    .filter(entry => entry.materialCode)
    .map(entry => entry.path);
}

/**
 * B-8628: repro-first is required only when a reproduce-the-failure red test can
 * exist — i.e. the task (a) writes material code AND (b) is a code-verifiable
 * behavior change (type bug|feature). docs-only / refactor / chore / no-material
 * are exempt at intake (the DEV-phase repro-evidence-binding gate re-checks once
 * material files are known). The high/critical + code-verifiable-risk safety net
 * is kept. This changes WHO is classified required, not the warn/enforce/bypass
 * mechanics. Replaces the over-reaching file_declarations + bug_story rules.
 */
export function classifyReproFirstRequirement(
  story: StoryInfo | null | undefined,
  checklist: ChecklistData | null | undefined,
  snapshot: MaterialClassificationSnapshot,
): ReproFirstRequirementClassification {
  // CX4 FIX A: this consumer entry point validates the received snapshot's
  // embedded HEAD/materialHash against the live tree and its policyDigest
  // against live config, re-resolving on drift — a stale or config-drifted
  // snapshot is never consumed as-is.
  const fresh = ensureFreshMaterialClassificationSnapshot(snapshot);
  const materialFiles = collectMaterialCodeFiles(checklist, fresh);
  if ((story?.type === 'bug' || story?.type === 'feature') && materialFiles.length > 0) {
    return {
      required: true,
      reason: 'code_verifiable_behavior_change',
      details: [`story.type=${story.type}`, `material code files: ${materialFiles.slice(0, 5).join(', ')}`],
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
    details: ['not a material-code bug/feature and no code-verifiable high-risk signal'],
  };
}

function resultFor(
  args: Omit<StoryEvidenceBindingGateResult, 'blocking'>,
): StoryEvidenceBindingGateResult {
  // B-956f FIX 5: a material-code policy/classification fail-closed error blocks
  // the transition regardless of reproFirst mode (mirrors the review-assurance
  // floor, which fails closed on the same errors) — a malformed config or an
  // unverifiable git-snapshot must never be laundered into a passing gate.
  const alwaysBlocking = args.reasonCode === 'repro_first_material_policy_error';
  return {
    ...args,
    blocking: alwaysBlocking || (args.mode === 'enforce' && args.required && args.reasonCode !== null && args.reasonCode !== 'repro_first_bypassed' && args.reasonCode !== 'repro_first_preflight_engine_error'),
  };
}

/**
 * B-956f FIX 5: convert a MaterialCodePolicyError raised by the shared classifier
 * (config-resolve, snapshot build, or freshness re-check) into a STRUCTURED
 * failing gate result naming the file + remediation. Freshness failures point at
 * the workspace/git tree; config failures point at proof-or-stop.config.json. Anything
 * that is NOT a MaterialCodePolicyError is re-thrown by the caller.
 */
function materialPolicyErrorResult(
  mode: ReproFirstPreflightMode,
  err: MaterialCodePolicyError,
): StoryEvidenceBindingGateResult {
  const isFreshness = err.offendingKey === 'materialClassification.freshness';
  const remediation = isFreshness
    ? `→ Ensure the story workspace/git tree is present and readable (this is a workspace/git error, not a ${PROOF_OR_STOP_CONFIG_FILENAME} problem), then re-run the transition.`
    : `→ Fix ${PROOF_OR_STOP_CONFIG_FILENAME} (the material-code policy fails closed rather than degrading to a TS-only whitelist), then re-run the transition.`;
  return resultFor({
    ok: false,
    required: true,
    mode,
    reasonCode: 'repro_first_material_policy_error',
    details: [err.message, remediation],
  });
}

function isArtifactIntegrityFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /^evidence-store: (?:malformed artifact (?:object|ref)|artifact (?:object|ref) integrity mismatch)/.test(message);
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
  } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
    checklist = null;
  }

  // B-956f FIX 1 (R7 F-008 — triple-confirmed integration gap): thread the
  // resolveGitCwd-resolved git root into the snapshot build, the SAME threading
  // the review-assurance-floor consumers use (machine.ts DONE guard/failure
  // reason: `gitCwd: resolveGitCwd({ store, storyId, metadataRoot, projectRoot })`).
  // Without it the builder's gitCwd stayed projectRoot: `git diff` (which walks
  // upward to the real repository) still emitted repo-root-relative paths on a
  // wrapper-root layout, so material files leaked through UNTRANSLATED
  // (project/bin/tool non-material instead of bin/tool material) and
  // project-relative excludePaths silently failed. resolveGitCwd never throws:
  // on a plain repo it resolves the metadata git root (identity translation), and
  // only when NO signed workspace resolves at all (e.g. absent story metadata)
  // does it fall back to projectRoot — the same fallback contract the machine.ts
  // floor/escalation consumers rely on.
  const gitCwd = resolveGitCwd({ store, storyId, metadataRoot: projectRoot, projectRoot });

  // B-956f FIX 5: the shared classifier fails CLOSED (throws MaterialCodePolicyError)
  // on a malformed proof-or-stop.config.json or an unverifiable git-snapshot. Catch it
  // here — the SAME narrow catch as the review-assurance floor — so the raw error
  // never escapes uncaught through the PLAN/DEV guard boolean or getGuardFailureReason.
  let classification: ReproFirstRequirementClassification;
  try {
    const snapshot = buildMaterialClassificationSnapshot(projectRoot, { gitCwd });
    classification = classifyReproFirstRequirement(story, checklist, snapshot);
  } catch (err) {
    if (err instanceof MaterialCodePolicyError) return materialPolicyErrorResult(mode, err);
    throw err;
  }
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
    if (isArtifactIntegrityFailure(err)) {
      return resultFor({
        ok: mode !== 'enforce',
        required: true,
        mode,
        reasonCode: 'stale_story_evidence_binding',
        details: [`story-evidence-binding artifact failed integrity validation: ${message}`],
        requirementReason: classification.reason,
        requirementDetails: classification.details,
      });
    }
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
    case 'code_verifiable_behavior_change':
      return 'this is a code-verifiable behavior change (a bug/feature that writes material code)';
    case 'high_risk_code_verifiable':
      return 'the story has code-verifiable high-risk signals';
    case 'bypass_eligible_no_files':
      return 'the story is not repro-first required';
    // Legacy reasons (B-8628: no longer produced; retained for backward-compat with any consumer).
    case 'file_declarations':
      return 'the checklist declares files.modify/create/test';
    case 'bug_story':
      return 'story.type=bug';
    default:
      return 'the repro-first classifier requires accepted repro evidence';
  }
}

function describeRequirementRemediation(result: StoryEvidenceBindingGateResult): string {
  switch (result.requirementReason) {
    case 'code_verifiable_behavior_change':
      return 'Create this material-code bug/feature from accepted repro evidence with story_create_from_repro, or pass reproFirstBypassReason for a documented non-reproducible exception.';
    case 'high_risk_code_verifiable':
      return 'Create this high-risk code-verifiable story from accepted repro evidence with story_create_from_repro, or dismiss/adjust false-positive risk signals before entering lifecycle work.';
    // Legacy reasons (B-8628: no longer produced; retained for backward-compat with any consumer).
    case 'file_declarations':
      return 'Create this code-changing story from accepted repro evidence with story_create_from_repro, or remove files.modify/create/test for non-code work.';
    case 'bug_story':
      return 'Create this bug story from accepted repro evidence with story_create_from_repro, or change the story type only if this is not actually bug work.';
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
  // B-956f FIX 5: a material-code policy/classification failure keeps the
  // "Cannot enter <PHASE>:" + "[reason_code]" guard conventions and renders the
  // file + remediation details produced by materialPolicyErrorResult.
  if (result.reasonCode === 'repro_first_material_policy_error') {
    const details = result.details.slice(0, 6).map(detail => `  - ${detail}`).join('\n');
    return `Cannot enter ${targetPhase}: the material-code policy/classification failed closed while checking repro-first requirements for ${storyId}. [repro_first_material_policy_error]${details ? `\n${details}` : ''}`;
  }
  const requirementSubject = describeRequirementSubject(result);
  const classifier = describeRequirement(result);
  const lead = result.reasonCode === 'missing_story_evidence_binding'
    ? `Cannot enter ${targetPhase}: ${requirementSubject}, but no valid story-evidence-binding candidate artifact is bound to ${storyId}. [missing_story_evidence_binding]`
    : `Cannot enter ${targetPhase}: ${requirementSubject}, but the bound story-evidence-binding candidate artifact is stale or invalid for ${storyId}. [stale_story_evidence_binding]`;
  const details = result.details.slice(0, 6).map(detail => `  - ${detail}`).join('\n');
  return `${lead}\n  - ${classifier}${details ? `\n${details}` : ''}\n` +
    `→ ${describeRequirementRemediation(result)}`;
}
