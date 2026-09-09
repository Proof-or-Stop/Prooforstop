/**
 * Evidence artifact types for candidate intake and bounded local gate evidence.
 *
 * Candidate artifacts use evidenceScope "evidence-candidate" and cannot
 * independently satisfy REVIEW, TEST, or DONE gates. `local-gate-evidence` and
 * `verification-output` are eligible as local lifecycle gate inputs only when a
 * dedicated tool-owned producer creates them and the consuming gate verifies
 * integrity, required signatures, and proof-admissibility. Eligibility is not
 * authority: neither EvidenceScope nor ArtifactKind grants authority by itself.
 */

export const EVIDENCE_SCHEMA_VERSION = 'lattice.evidence.v1' as const;
export type EvidenceSchemaVersion = typeof EVIDENCE_SCHEMA_VERSION;

/**
 * Scope classification, not an authority grant. `evidence-candidate` is intake-only;
 * `local-gate-evidence` is merely eligible for a dedicated validated local gate path.
 */
export type EvidenceScope = 'evidence-candidate' | 'local-gate-evidence';

/**
 * Artifact kind discriminants, not proof authority. Candidate workflow kinds remain
 * non-authoritative; `verification-output` requires its tool-owned receipt producer
 * and integrity/signature/proof-admissibility validator before any gate may consume it.
 */
export type ArtifactKind =
  | 'repro-probe'
  | 'repro-review'
  | 'spike-record'
  | 'spike-review'
  | 'red-green-relation'
  | 'red-green-relation-evaluation'
  // `red-green-evaluation` kept as legacy alias to preserve compatibility with pre-baseline stories.
  | 'red-green-evaluation'
  | 'regression-matrix-review'
  | 'story-evidence-binding'
  | 'verification-output';

/** Subject binding identifies what this artifact is about. */
export interface SubjectBinding {
  candidateId: string;
  storyId?: string;
  executionId?: string;
  probeId?: string;
  spikeId?: string;
  relationId?: string;
}

/** Immutable artifact envelope; content addressing alone does not make its payload authoritative. */
export interface EvidenceArtifact<TPayload = unknown> {
  artifactId: string;
  artifactKind: ArtifactKind;
  schemaVersion: EvidenceSchemaVersion;
  createdAt: string;
  producer: string;
  evidenceScope: EvidenceScope;
  subjectBinding: SubjectBinding;
  payload: TPayload;
  artifactDigest: string;
}

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export type ExecutionStatus = 'not_run' | 'run_attempted' | 'confirmed_failing';
export type ReviewedFailureClass = 'target-bug' | 'bootstrap-noise' | 'environment-noise' | 'unknown';
export type ReproVerdict = 'red-reviewed' | 'repro-rejected' | 'needs-spike';
export type SpikeReviewVerdict = 'confirmed' | 'inconclusive' | 'rejected';

export interface CommandSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ReproProbePayload {
  candidateId: string;
  taskSummary: string;
  eligibility: string;
  reason: string;
  commandSpec: CommandSpec;
  expectedFailure: string;
  expectedFailurePattern: string;
  executionStatus: ExecutionStatus;
  observedFailureSummary: string;
  boundedOutputExcerpt: string;
  producerObservedClass: ReviewedFailureClass;
  baselineHeadHash?: string;
  materialHash?: string;
}

export interface ReproReviewPayload {
  probeId: string;
  probeDigest: string;
  verdict: ReproVerdict;
  reviewedFailureClass: ReviewedFailureClass;
  notes: string;
}

export interface SpikeRecordPayload {
  candidateId: string;
  probeId: string;
  probeDigest: string;
  description: string;
  steps: string[];
  observations: string;
  commandSpec?: CommandSpec;
  expectedFailurePattern?: string;
  executionStatus: ExecutionStatus;
  observedOutput: string;
}

export interface SpikeReviewPayload {
  spikeId: string;
  spikeDigest: string;
  verdict: SpikeReviewVerdict;
  notes: string;
}

export interface RedGreenRelationPayload {
  candidateId: string;
  probeId: string;
  baselineCommandSpec: CommandSpec;
  baselineExpectedFailurePattern: string;
  currentCommandSpec: CommandSpec;
  currentExpectedFailurePattern: string;
  description: string;
}

export interface RedGreenEvaluationPayload {
  relationId: string;
  relationDigest: string;
  pass: boolean;
  reasons: string[];
}

export interface RegressionMatrixReviewPayload {
  candidateId: string;
  probeId: string;
  relationId?: string;
  spikeId?: string;
  status: 'accepted' | 'gap' | 'blocked';
  notes: string;
}

export interface StoryEvidenceBindingPayload {
  storyId: string;
  candidateId: string;
  probeId: string;
  probeDigest: string;
  reviewId: string;
  reviewDigest: string;
  spikeId?: string;
  spikeDigest?: string;
  spikeReviewId?: string;
  spikeReviewDigest?: string;
  matrixReviewId?: string;
  matrixReviewDigest?: string;
  derivedChecklistRefs: string[];
  derivedVerificationIntentRefs: string[];
  note: string;
}
