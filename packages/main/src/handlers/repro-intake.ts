/**
 * repro-intake handlers — thin CLI wrappers around core/repro-intake.ts.
 *
 * B-0aa1: Candidate-only repro-first evidence intake MVP.
 *
 * All artifacts are evidence-candidate scope and are NOT production/DONE evidence.
 * Commands: repro_probe, repro_probe_get, repro_review_set, spike_record,
 *   spike_review_set, red_green_relation_create, red_green_relation_evaluate,
 *   regression_matrix_review_set, story_create_from_repro
 */

import type { HandlerContext } from './context.js';
import {
  createProbe,
  getProbe,
  reviewProbe,
  recordSpike,
  reviewSpike,
  createRedGreenRelation,
  evaluateRedGreenRelation,
  reviewRegressionMatrix,
  createStoryFromRepro,
} from '../core/repro-intake.js';
import { createStoryCreateHandlers } from './story-create.js';
import type {
  CommandSpec,
  ReproVerdict,
  SpikeReviewVerdict,
  ReviewedFailureClass,
  ExecutionStatus,
} from '../core/evidence/types.js';

// ---------------------------------------------------------------------------
// repro_probe
// ---------------------------------------------------------------------------

export interface ReproProbeArgs {
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

// ---------------------------------------------------------------------------
// repro_review_set
// ---------------------------------------------------------------------------

export interface ReproReviewSetArgs {
  probeId: string;
  probeDigest?: string;
  verdict: ReproVerdict;
  reviewedFailureClass: ReviewedFailureClass;
  notes: string;
}

// ---------------------------------------------------------------------------
// spike_record
// ---------------------------------------------------------------------------

export interface SpikeRecordArgs {
  probeId: string;
  description: string;
  steps: string[];
  observations: string;
  commandSpec?: CommandSpec;
  expectedFailurePattern?: string;
  executionStatus: ExecutionStatus;
  observedOutput: string;
}

// ---------------------------------------------------------------------------
// spike_review_set
// ---------------------------------------------------------------------------

export interface SpikeReviewSetArgs {
  spikeId: string;
  spikeDigest?: string;
  verdict: SpikeReviewVerdict;
  notes: string;
}

// ---------------------------------------------------------------------------
// red_green_relation_create
// ---------------------------------------------------------------------------

export interface RedGreenRelationCreateArgs {
  probeId: string;
  baselineCommandSpec: CommandSpec;
  baselineExpectedFailurePattern: string;
  currentCommandSpec: CommandSpec;
  currentExpectedFailurePattern: string;
  description: string;
}

// ---------------------------------------------------------------------------
// red_green_relation_evaluate
// ---------------------------------------------------------------------------

export interface RedGreenRelationEvaluateArgs {
  relationId: string;
  relationDigest?: string;
}

// ---------------------------------------------------------------------------
// regression_matrix_review_set
// ---------------------------------------------------------------------------

export interface RegressionMatrixReviewSetArgs {
  probeId: string;
  relationId?: string;
  spikeId?: string;
  status: 'accepted' | 'gap' | 'blocked';
  notes: string;
}

// ---------------------------------------------------------------------------
// story_create_from_repro
// ---------------------------------------------------------------------------

export interface StoryCreateFromReproArgs {
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

// ---------------------------------------------------------------------------
// createReproIntakeHandlers
// ---------------------------------------------------------------------------

export function createReproIntakeHandlers(ctx: HandlerContext) {
  const { root } = ctx;

  function repro_probe(args: ReproProbeArgs) {
    const artifact = createProbe(root, args);
    return {
      artifactId: artifact.artifactId,
      artifactDigest: artifact.artifactDigest,
      artifactKind: artifact.artifactKind,
      evidenceScope: artifact.evidenceScope,
      candidateId: artifact.payload.candidateId,
      stage: 'probe',
      note: 'Candidate artifact — not production/DONE evidence. allowedConsumers: STORY_INTAKE only.',
    };
  }

  function repro_probe_get(args: { probeId: string }) {
    const artifact = getProbe(root, args.probeId);
    return {
      artifactId: artifact.artifactId,
      artifactDigest: artifact.artifactDigest,
      artifactKind: artifact.artifactKind,
      evidenceScope: artifact.evidenceScope,
      candidateId: artifact.payload.candidateId,
      stage: 'probe',
      payload: artifact.payload,
    };
  }

  function repro_review_set(args: ReproReviewSetArgs) {
    const artifact = reviewProbe(root, args);
    return {
      artifactId: artifact.artifactId,
      artifactDigest: artifact.artifactDigest,
      artifactKind: artifact.artifactKind,
      evidenceScope: artifact.evidenceScope,
      candidateId: artifact.subjectBinding.candidateId,
      stage: 'review',
      verdict: artifact.payload.verdict,
      note: 'Candidate review — not production/DONE evidence.',
    };
  }

  function spike_record(args: SpikeRecordArgs) {
    const artifact = recordSpike(root, args);
    return {
      artifactId: artifact.artifactId,
      artifactDigest: artifact.artifactDigest,
      artifactKind: artifact.artifactKind,
      evidenceScope: artifact.evidenceScope,
      candidateId: artifact.payload.candidateId,
      stage: 'spike',
      note: 'Candidate spike record — not production/DONE evidence.',
    };
  }

  function spike_review_set(args: SpikeReviewSetArgs) {
    const artifact = reviewSpike(root, args);
    return {
      artifactId: artifact.artifactId,
      artifactDigest: artifact.artifactDigest,
      artifactKind: artifact.artifactKind,
      evidenceScope: artifact.evidenceScope,
      candidateId: artifact.subjectBinding.candidateId,
      stage: 'spike-review',
      verdict: artifact.payload.verdict,
    };
  }

  function red_green_relation_create(args: RedGreenRelationCreateArgs) {
    const artifact = createRedGreenRelation(root, args);
    return {
      artifactId: artifact.artifactId,
      artifactDigest: artifact.artifactDigest,
      artifactKind: artifact.artifactKind,
      evidenceScope: artifact.evidenceScope,
      candidateId: artifact.payload.candidateId,
      stage: 'relation',
    };
  }

  function red_green_relation_evaluate(args: RedGreenRelationEvaluateArgs) {
    const artifact = evaluateRedGreenRelation(root, args);
    return {
      artifactId: artifact.artifactId,
      artifactDigest: artifact.artifactDigest,
      artifactKind: artifact.artifactKind,
      evidenceScope: artifact.evidenceScope,
      candidateId: artifact.subjectBinding.candidateId,
      stage: 'evaluation',
      pass: artifact.payload.pass,
      reasons: artifact.payload.reasons,
    };
  }

  function regression_matrix_review_set(args: RegressionMatrixReviewSetArgs) {
    const artifact = reviewRegressionMatrix(root, args);
    return {
      artifactId: artifact.artifactId,
      artifactDigest: artifact.artifactDigest,
      artifactKind: artifact.artifactKind,
      evidenceScope: artifact.evidenceScope,
      candidateId: artifact.payload.candidateId,
      stage: 'matrix-review',
      status: artifact.payload.status,
    };
  }

  async function story_create_from_repro(args: StoryCreateFromReproArgs) {
    const storyHandlers = createStoryCreateHandlers(ctx);

    const result = await createStoryFromRepro(
      root,
      args,
      async (storyArgs) => {
        const createResult = await storyHandlers.story_create({
          name: storyArgs.name,
          title: storyArgs.title,
          description: storyArgs.description,
          type: storyArgs.type,
          priority: storyArgs.priority,
          checklist: storyArgs.checklist,
          background: storyArgs.background,
          reproFirstBypassReason: storyArgs.reproFirstBypassReason,
        });
        // Extract story ID from result string (e.g. "Story B-xxxx created...")
        const match = String(createResult).match(/B-[a-z0-9]{4,6}/i);
        if (!match) {
          throw new Error(`repro-intake: could not extract story ID from story_create result: ${createResult}`);
        }
        return match[0];
      },
    );

    return {
      storyId: result.storyId,
      bindingArtifactId: result.bindingArtifact.artifactId,
      bindingArtifactDigest: result.bindingArtifact.artifactDigest,
      artifactKind: result.bindingArtifact.artifactKind,
      evidenceScope: result.bindingArtifact.evidenceScope,
      candidateId: result.bindingArtifact.payload.candidateId,
      note: 'Story created. Candidate artifacts remain evidence-candidate. No verificationEvidence set. Green evidence is produced later by DEV/TEST.',
      hasVerificationEvidence: false,
    };
  }

  return {
    repro_probe,
    repro_probe_get,
    repro_review_set,
    spike_record,
    spike_review_set,
    red_green_relation_create,
    red_green_relation_evaluate,
    regression_matrix_review_set,
    story_create_from_repro,
  };
}
