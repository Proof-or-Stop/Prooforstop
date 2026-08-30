/**
 * ReproIntakeService — candidate-only repro-first workflow.
 *
 * B-0aa1: Implements the candidate evidence intake workflow.
 *
 * IMPORTANT: All artifacts produced here are evidence-candidate scope only.
 * They do NOT satisfy REVIEW, TEST, DONE, Authority, or production-gate claims.
 * allowedConsumers: STORY_INTAKE only.
 */

import {
  writeArtifact,
  readArtifact,
  verifyArtifactDigest,
  listArtifacts,
} from './evidence/artifact-store.js';
import type {
  EvidenceArtifact,
  ReproProbePayload,
  ReproReviewPayload,
  SpikeRecordPayload,
  SpikeReviewPayload,
  RedGreenRelationPayload,
  RedGreenEvaluationPayload,
  RegressionMatrixReviewPayload,
  StoryEvidenceBindingPayload,
  CommandSpec,
  ReproVerdict,
  SpikeReviewVerdict,
  ReviewedFailureClass,
  ExecutionStatus,
} from './evidence/types.js';
import type { StoryType } from './types.js';

const CANDIDATE_SCOPE = 'evidence-candidate' as const;
const PRODUCER = 'repro-intake-service';

function findAcceptedProbeReview(
  projectRoot: string,
  probeId: string,
  probeDigest: string,
): EvidenceArtifact<ReproReviewPayload> | undefined {
  return listArtifacts<ReproReviewPayload>(projectRoot, 'repro-review').find(artifact => (
    artifact.payload.probeId === probeId &&
    artifact.payload.probeDigest === probeDigest &&
    artifact.payload.verdict === 'red-reviewed' &&
    artifact.payload.reviewedFailureClass === 'target-bug'
  ));
}

// ---------------------------------------------------------------------------
// createProbe
// ---------------------------------------------------------------------------

export interface CreateProbeInput {
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

export function createProbe(
  projectRoot: string,
  input: CreateProbeInput,
): EvidenceArtifact<ReproProbePayload> {
  if (!input.candidateId || input.candidateId.trim().length === 0) {
    throw new Error('repro-intake: candidateId is required');
  }
  if (!input.taskSummary || input.taskSummary.trim().length < 5) {
    throw new Error('repro-intake: taskSummary must be at least 5 characters');
  }

  const payload: ReproProbePayload = {
    candidateId: input.candidateId.trim(),
    taskSummary: input.taskSummary.trim(),
    eligibility: input.eligibility,
    reason: input.reason,
    commandSpec: input.commandSpec,
    expectedFailure: input.expectedFailure,
    expectedFailurePattern: input.expectedFailurePattern,
    executionStatus: input.executionStatus,
    observedFailureSummary: input.observedFailureSummary,
    boundedOutputExcerpt: input.boundedOutputExcerpt,
    producerObservedClass: input.producerObservedClass,
    ...(input.baselineHeadHash ? { baselineHeadHash: input.baselineHeadHash } : {}),
    ...(input.materialHash ? { materialHash: input.materialHash } : {}),
  };

  return writeArtifact(projectRoot, {
    artifactKind: 'repro-probe',
    evidenceScope: CANDIDATE_SCOPE,
    subjectBinding: { candidateId: input.candidateId },
    payload,
    producer: PRODUCER,
  });
}

// ---------------------------------------------------------------------------
// getProbe
// ---------------------------------------------------------------------------

export function getProbe(
  projectRoot: string,
  probeId: string,
): EvidenceArtifact<ReproProbePayload> {
  return readArtifact<ReproProbePayload>(projectRoot, probeId);
}

// ---------------------------------------------------------------------------
// reviewProbe
// ---------------------------------------------------------------------------

export interface ReviewProbeInput {
  probeId: string;
  probeDigest?: string;
  verdict: ReproVerdict;
  reviewedFailureClass: ReviewedFailureClass;
  notes: string;
}

export function reviewProbe(
  projectRoot: string,
  input: ReviewProbeInput,
): EvidenceArtifact<ReproReviewPayload> {
  const probe = readArtifact<ReproProbePayload>(projectRoot, input.probeId);

  if (input.probeDigest && !verifyArtifactDigest(probe, input.probeDigest)) {
    throw new Error(`repro-intake: probe digest mismatch for ${input.probeId}; expected ${input.probeDigest}, got ${probe.artifactDigest}`);
  }

  const payload: ReproReviewPayload = {
    probeId: input.probeId,
    probeDigest: probe.artifactDigest,
    verdict: input.verdict,
    reviewedFailureClass: input.reviewedFailureClass,
    notes: input.notes,
  };

  return writeArtifact(projectRoot, {
    artifactKind: 'repro-review',
    evidenceScope: CANDIDATE_SCOPE,
    subjectBinding: { candidateId: probe.payload.candidateId, probeId: input.probeId },
    payload,
    producer: PRODUCER,
  });
}

// ---------------------------------------------------------------------------
// recordSpike
// ---------------------------------------------------------------------------

export interface RecordSpikeInput {
  probeId: string;
  description: string;
  steps: string[];
  observations: string;
  commandSpec?: CommandSpec;
  expectedFailurePattern?: string;
  executionStatus: ExecutionStatus;
  observedOutput: string;
}

export function recordSpike(
  projectRoot: string,
  input: RecordSpikeInput,
): EvidenceArtifact<SpikeRecordPayload> {
  const probe = readArtifact<ReproProbePayload>(projectRoot, input.probeId);

  const payload: SpikeRecordPayload = {
    candidateId: probe.payload.candidateId,
    probeId: input.probeId,
    probeDigest: probe.artifactDigest,
    description: input.description,
    steps: input.steps,
    observations: input.observations,
    executionStatus: input.executionStatus,
    observedOutput: input.observedOutput,
    ...(input.commandSpec ? { commandSpec: input.commandSpec } : {}),
    ...(input.expectedFailurePattern ? { expectedFailurePattern: input.expectedFailurePattern } : {}),
  };

  return writeArtifact(projectRoot, {
    artifactKind: 'spike-record',
    evidenceScope: CANDIDATE_SCOPE,
    subjectBinding: { candidateId: probe.payload.candidateId, probeId: input.probeId },
    payload,
    producer: PRODUCER,
  });
}

// ---------------------------------------------------------------------------
// reviewSpike
// ---------------------------------------------------------------------------

export interface ReviewSpikeInput {
  spikeId: string;
  spikeDigest?: string;
  verdict: SpikeReviewVerdict;
  notes: string;
}

export function reviewSpike(
  projectRoot: string,
  input: ReviewSpikeInput,
): EvidenceArtifact<SpikeReviewPayload> {
  const spike = readArtifact<SpikeRecordPayload>(projectRoot, input.spikeId);

  if (input.spikeDigest && !verifyArtifactDigest(spike, input.spikeDigest)) {
    throw new Error(`repro-intake: spike digest mismatch for ${input.spikeId}`);
  }

  const payload: SpikeReviewPayload = {
    spikeId: input.spikeId,
    spikeDigest: spike.artifactDigest,
    verdict: input.verdict,
    notes: input.notes,
  };

  return writeArtifact(projectRoot, {
    artifactKind: 'spike-review',
    evidenceScope: CANDIDATE_SCOPE,
    subjectBinding: { candidateId: spike.payload.candidateId, probeId: spike.payload.probeId, spikeId: input.spikeId },
    payload,
    producer: PRODUCER,
  });
}

// ---------------------------------------------------------------------------
// createRedGreenRelation
// ---------------------------------------------------------------------------

export interface CreateRedGreenRelationInput {
  probeId: string;
  baselineCommandSpec: CommandSpec;
  baselineExpectedFailurePattern: string;
  currentCommandSpec: CommandSpec;
  currentExpectedFailurePattern: string;
  description: string;
}

export function createRedGreenRelation(
  projectRoot: string,
  input: CreateRedGreenRelationInput,
): EvidenceArtifact<RedGreenRelationPayload> {
  const probe = readArtifact<ReproProbePayload>(projectRoot, input.probeId);

  const payload: RedGreenRelationPayload = {
    candidateId: probe.payload.candidateId,
    probeId: input.probeId,
    baselineCommandSpec: input.baselineCommandSpec,
    baselineExpectedFailurePattern: input.baselineExpectedFailurePattern,
    currentCommandSpec: input.currentCommandSpec,
    currentExpectedFailurePattern: input.currentExpectedFailurePattern,
    description: input.description,
  };

  return writeArtifact(projectRoot, {
    artifactKind: 'red-green-relation',
    evidenceScope: CANDIDATE_SCOPE,
    subjectBinding: { candidateId: probe.payload.candidateId, probeId: input.probeId },
    payload,
    producer: PRODUCER,
  });
}

// ---------------------------------------------------------------------------
// evaluateRedGreenRelation
// ---------------------------------------------------------------------------

export interface EvaluateRedGreenRelationInput {
  relationId: string;
  relationDigest?: string;
}

export function evaluateRedGreenRelation(
  projectRoot: string,
  input: EvaluateRedGreenRelationInput,
): EvidenceArtifact<RedGreenEvaluationPayload> {
  // Fail closed: missing relation ref → throw
  const relation = readArtifact<RedGreenRelationPayload>(projectRoot, input.relationId);

  if (input.relationDigest && !verifyArtifactDigest(relation, input.relationDigest)) {
    throw new Error(`repro-intake: relation digest mismatch for ${input.relationId}`);
  }

  const probe = readArtifact<ReproProbePayload>(projectRoot, relation.payload.probeId);
  const reasons: string[] = [];
  let pass = true;

  const acceptedReview = findAcceptedProbeReview(projectRoot, probe.artifactId, probe.artifactDigest);
  if (!acceptedReview) {
    pass = false;
    reasons.push('missing red-reviewed target-bug repro review for probe');
  }

  if (probe.payload.executionStatus === 'not_run') {
    pass = false;
    reasons.push('probe execution status is not_run — cannot evaluate without observed failure');
  }

  // Command spec must be same command (fail closed on mismatch)
  const baseCmd = relation.payload.baselineCommandSpec.command;
  const curCmd = relation.payload.currentCommandSpec.command;
  if (baseCmd !== curCmd) {
    pass = false;
    reasons.push(`command mismatch: baseline="${baseCmd}" current="${curCmd}"`);
  }

  // Expected failure patterns must both be non-empty
  if (!relation.payload.baselineExpectedFailurePattern || !relation.payload.currentExpectedFailurePattern) {
    pass = false;
    reasons.push('expected failure patterns must be non-empty');
  }

  if (pass) {
    reasons.push(`command specs match, failure patterns are defined, and reviewed repro is accepted (${acceptedReview?.artifactId})`);
  }

  const payload: RedGreenEvaluationPayload = {
    relationId: input.relationId,
    relationDigest: relation.artifactDigest,
    pass,
    reasons,
  };

  return writeArtifact(projectRoot, {
    artifactKind: 'red-green-relation-evaluation',
    evidenceScope: CANDIDATE_SCOPE,
    subjectBinding: { candidateId: relation.payload.candidateId, probeId: relation.payload.probeId, relationId: input.relationId },
    payload,
    producer: PRODUCER,
  });
}

// ---------------------------------------------------------------------------
// reviewRegressionMatrix
// ---------------------------------------------------------------------------

export interface ReviewRegressionMatrixInput {
  probeId: string;
  relationId?: string;
  spikeId?: string;
  status: 'accepted' | 'gap' | 'blocked';
  notes: string;
}

export function reviewRegressionMatrix(
  projectRoot: string,
  input: ReviewRegressionMatrixInput,
): EvidenceArtifact<RegressionMatrixReviewPayload> {
  const probe = readArtifact<ReproProbePayload>(projectRoot, input.probeId);

  const payload: RegressionMatrixReviewPayload = {
    candidateId: probe.payload.candidateId,
    probeId: input.probeId,
    status: input.status,
    notes: input.notes,
    ...(input.relationId ? { relationId: input.relationId } : {}),
    ...(input.spikeId ? { spikeId: input.spikeId } : {}),
  };

  return writeArtifact(projectRoot, {
    artifactKind: 'regression-matrix-review',
    evidenceScope: CANDIDATE_SCOPE,
    subjectBinding: { candidateId: probe.payload.candidateId, probeId: input.probeId },
    payload,
    producer: PRODUCER,
  });
}

// ---------------------------------------------------------------------------
// createStoryFromRepro
// ---------------------------------------------------------------------------

export interface CreateStoryFromReproInput {
  probeId: string;
  reviewId: string;
  spikeId?: string;
  spikeReviewId?: string;
  matrixReviewId?: string;
  storyTitle: string;
  storyDescription: string;
  derivedChecklistRefs?: string[];
  derivedVerificationIntentRefs?: string[];
}

export interface CreateStoryFromReproResult {
  storyId: string;
  bindingArtifact: EvidenceArtifact<StoryEvidenceBindingPayload>;
}

export async function createStoryFromRepro(
  projectRoot: string,
  input: CreateStoryFromReproInput,
  storyCreator: (args: {
    title: string;
    description: string;
    name: string;
    type: StoryType;
    priority: string;
    checklist: Array<{ title: string; context?: string }>;
    background: string;
    reproFirstBypassReason: string;
  }) => Promise<string> | string,
): Promise<CreateStoryFromReproResult> {
  // Validate probe and review exist
  const probe = readArtifact<ReproProbePayload>(projectRoot, input.probeId);
  const review = readArtifact<ReproReviewPayload>(projectRoot, input.reviewId);

  // Fail closed: only a red-reviewed target-bug review can create a story from repro.
  if (review.payload.verdict !== 'red-reviewed' || review.payload.reviewedFailureClass !== 'target-bug') {
    throw new Error(
      `repro-intake: cannot create story from non-accepted repro review ` +
      `(verdict=${review.payload.verdict}, reviewedFailureClass=${review.payload.reviewedFailureClass}, reviewId=${input.reviewId})`,
    );
  }

  // Validate probe digest referenced in review matches
  if (review.payload.probeId !== input.probeId) {
    throw new Error(`repro-intake: review ${input.reviewId} references probe ${review.payload.probeId}, not ${input.probeId}`);
  }
  if (review.payload.probeDigest !== probe.artifactDigest) {
    throw new Error(`repro-intake: review ${input.reviewId} digest ${review.payload.probeDigest} does not match probe ${input.probeId} digest ${probe.artifactDigest}`);
  }

  if (input.spikeReviewId && !input.spikeId) {
    throw new Error(`repro-intake: spikeReviewId ${input.spikeReviewId} requires spikeId`);
  }

  const spike = input.spikeId
    ? readArtifact<SpikeRecordPayload>(projectRoot, input.spikeId)
    : undefined;
  const spikeDigest = spike?.artifactDigest;
  const spikeReview = input.spikeReviewId
    ? readArtifact<SpikeReviewPayload>(projectRoot, input.spikeReviewId)
    : undefined;
  if (spike && spike.payload.probeId !== input.probeId) {
    throw new Error(`repro-intake: spike ${input.spikeId} references probe ${spike.payload.probeId}, not ${input.probeId}`);
  }
  if (spike && spike.payload.probeDigest !== probe.artifactDigest) {
    throw new Error(`repro-intake: spike ${input.spikeId} digest ${spike.payload.probeDigest} does not match probe ${input.probeId} digest ${probe.artifactDigest}`);
  }
  if (spikeReview) {
    if (spikeReview.payload.spikeId !== input.spikeId) {
      throw new Error(`repro-intake: spike review ${input.spikeReviewId} references spike ${spikeReview.payload.spikeId}, not ${input.spikeId}`);
    }
    if (spikeReview.payload.spikeDigest !== spikeDigest) {
      throw new Error(`repro-intake: spike review ${input.spikeReviewId} digest ${spikeReview.payload.spikeDigest} does not match spike ${input.spikeId} digest ${spikeDigest}`);
    }
    if (spikeReview.payload.verdict !== 'confirmed') {
      throw new Error(`repro-intake: spike review ${input.spikeReviewId} verdict=${spikeReview.payload.verdict}, expected confirmed`);
    }
  }
  const matrixReview = input.matrixReviewId
    ? readArtifact<RegressionMatrixReviewPayload>(projectRoot, input.matrixReviewId)
    : undefined;
  if (matrixReview && matrixReview.payload.probeId !== input.probeId) {
    throw new Error(`repro-intake: matrix review ${input.matrixReviewId} references probe ${matrixReview.payload.probeId}, not ${input.probeId}`);
  }

  const background = [
    '## Trigger Event',
    `${new Date().toISOString().slice(0, 10)} repro-first intake is creating a story from accepted candidate evidence. Probe ${input.probeId} and review ${input.reviewId} are bound before development starts.`,
    '## Key Insights',
    `The repro review is red-reviewed and classified as target-bug, so this story starts from observed failing behavior instead of a speculative fix. Candidate ${probe.payload.candidateId} remains intake evidence only.`,
    '## Solution Tradeoffs',
    'Using story_create_from_repro keeps the normal story lifecycle intact while adding a pre-story binding artifact. It avoids pretending candidate evidence is verificationEvidence, DONE evidence, Authority proof, or production proof.',
    '## Conversational Texture',
    'The maintainer sees a normal ProofOrStop story with a durable intake binding, then still expects DEV, REVIEW, TEST, validation, and DONE evidence to prove the actual fix after implementation.',
  ].join('\n\n');

  // Create story via injected creator (calls story_create handler)
  const storyId = await storyCreator({
    title: input.storyTitle,
    description: input.storyDescription,
    name: probe.payload.candidateId,
    type: 'bug',
    priority: 'high',
    checklist: [{ title: 'Implement fix for reproduced failure', context: `Probe: ${input.probeId}, Review: ${input.reviewId}` }],
    background,
    reproFirstBypassReason: 'story_create_from_repro writes story-evidence-binding immediately after story_create from accepted repro evidence',
  });

  // Write binding artifact — original candidate artifact remains evidence-candidate
  const bindingPayload: StoryEvidenceBindingPayload = {
    storyId,
    candidateId: probe.payload.candidateId,
    probeId: input.probeId,
    probeDigest: probe.artifactDigest,
    reviewId: input.reviewId,
    reviewDigest: review.artifactDigest,
    derivedChecklistRefs: input.derivedChecklistRefs ?? [],
    derivedVerificationIntentRefs: input.derivedVerificationIntentRefs ?? [],
    note: 'Candidate artifacts remain evidence-candidate; story is created but verificationEvidence is not set. Green evidence is produced later by DEV/TEST.',
    ...(input.spikeId ? { spikeId: input.spikeId, spikeDigest } : {}),
    ...(input.spikeReviewId && spikeReview ? { spikeReviewId: input.spikeReviewId, spikeReviewDigest: spikeReview.artifactDigest } : {}),
    ...(input.matrixReviewId && matrixReview ? { matrixReviewId: input.matrixReviewId, matrixReviewDigest: matrixReview.artifactDigest } : {}),
  };

  const bindingArtifact = writeArtifact(projectRoot, {
    artifactKind: 'story-evidence-binding',
    evidenceScope: CANDIDATE_SCOPE,
    subjectBinding: { candidateId: probe.payload.candidateId, probeId: input.probeId, storyId },
    payload: bindingPayload,
    producer: PRODUCER,
  });

  return { storyId, bindingArtifact };
}
