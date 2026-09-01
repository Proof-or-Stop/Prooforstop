#!/usr/bin/env node
/**
 * repro-first-candidate-smoke — B-0aa1 CHK-004
 *
 * Proves the full happy-path candidate workflow and key failure modes.
 * Uses handler-level invocation against an isolated temp root.
 *
 * Expected final output: "repro-first candidate smoke passed"
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createProbe,
  reviewProbe,
  recordSpike,
  reviewSpike,
  createRedGreenRelation,
  evaluateRedGreenRelation,
  reviewRegressionMatrix,
  createStoryFromRepro,
} from '../core/repro-intake.js';
import { readArtifact } from '../core/evidence/artifact-store.js';
import type {
  ReproProbePayload,
  ReproReviewPayload,
  StoryEvidenceBindingPayload,
} from '../core/evidence/types.js';

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-repro-smoke-'));

// Ensure .proof-or-stop/story structure exists for story_create (uses StoryStore)
mkdirSync(join(root, '.proof-or-stop', 'story', 'actives'), { recursive: true });
mkdirSync(join(root, 'docs', 'story', 'actives'), { recursive: true });

// Minimal proof-or-stop.config.json so loadConfig works
writeFileSync(
  join(root, 'proof-or-stop.config.json'),
  JSON.stringify({ scanRoot: 'docs/story' }),
  'utf8',
);

// Minimal CLAUDE.md for background validator
writeFileSync(join(root, 'CLAUDE.md'), '# Test\n', 'utf8');

// ── Helpers ─────────────────────────────────────────────────────────────────

function section(name: string) {
  process.stdout.write(`\n── ${name} ──\n`);
}

// ── 1. Happy path: repro_probe ───────────────────────────────────────────────

section('1. repro_probe — happy path');
{
  const probe = createProbe(root, {
    candidateId: 'cand-test-001',
    taskSummary: 'Validate that auth guard fails on expired token',
    eligibility: 'Reproducible in dev environment',
    reason: 'Auth guard regression suspected after B-1234 merge',
    commandSpec: { command: 'node', args: ['test/auth.js', '--scenario=expired'] },
    expectedFailure: 'Expected 401 Unauthorized',
    expectedFailurePattern: 'AuthGuardError.*expired',
    executionStatus: 'confirmed_failing',
    observedFailureSummary: 'Request passed with expired token; returned 200',
    boundedOutputExcerpt: 'GET /api/resource 200 OK (token_exp=past)',
    producerObservedClass: 'target-bug',
  });

  assert.equal(probe.artifactKind, 'repro-probe', 'probe kind');
  assert.equal(probe.evidenceScope, 'evidence-candidate', 'must be evidence-candidate');
  assert.ok(probe.artifactId, 'probe has artifactId');
  assert.ok(probe.artifactDigest, 'probe has digest');
  assert.equal(probe.payload.candidateId, 'cand-test-001');

  // Read it back
  const retrieved = readArtifact<ReproProbePayload>(root, probe.artifactId);
  assert.equal(retrieved.payload.taskSummary, probe.payload.taskSummary, 'roundtrip taskSummary');

  const changedNestedCommandProbe = createProbe(root, {
    candidateId: 'cand-test-001',
    taskSummary: 'Validate that auth guard fails on expired token',
    eligibility: 'Reproducible in dev environment',
    reason: 'Auth guard regression suspected after B-1234 merge',
    commandSpec: { command: 'node', args: ['different.js'] },
    expectedFailure: 'Expected 401 Unauthorized',
    expectedFailurePattern: 'AuthGuardError.*expired',
    executionStatus: 'confirmed_failing',
    observedFailureSummary: 'Request passed with expired token; returned 200',
    boundedOutputExcerpt: 'GET /api/resource 200 OK (token_exp=past)',
    producerObservedClass: 'target-bug',
  });
  assert.notEqual(
    changedNestedCommandProbe.artifactDigest,
    probe.artifactDigest,
    'nested commandSpec values must be included in artifact digest',
  );
  const duplicateProbe = createProbe(root, {
    candidateId: 'cand-test-001',
    taskSummary: 'Validate that auth guard fails on expired token',
    eligibility: 'Reproducible in dev environment',
    reason: 'Auth guard regression suspected after B-1234 merge',
    commandSpec: { command: 'node', args: ['test/auth.js', '--scenario=expired'] },
    expectedFailure: 'Expected 401 Unauthorized',
    expectedFailurePattern: 'AuthGuardError.*expired',
    executionStatus: 'confirmed_failing',
    observedFailureSummary: 'Request passed with expired token; returned 200',
    boundedOutputExcerpt: 'GET /api/resource 200 OK (token_exp=past)',
    producerObservedClass: 'target-bug',
  });
  assert.equal(duplicateProbe.artifactDigest, probe.artifactDigest, 'same canonical artifact subject has same digest');
  assert.equal(duplicateProbe.artifactId, probe.artifactId, 'same canonical artifact subject returns existing artifact id');

  process.stdout.write(`  probe: ${probe.artifactId} digest=${probe.artifactDigest.slice(0, 12)}...\n`);

  // ── 2. repro_review_set — red-reviewed ────────────────────────────────────

  section('2. repro_review_set — red-reviewed');
  const review = reviewProbe(root, {
    probeId: probe.artifactId,
    probeDigest: probe.artifactDigest,
    verdict: 'red-reviewed',
    reviewedFailureClass: 'target-bug',
    notes: 'Confirmed: auth guard skips expiry check on fast path',
  });

  assert.equal(review.artifactKind, 'repro-review', 'review kind');
  assert.equal(review.evidenceScope, 'evidence-candidate', 'review must be evidence-candidate');
  assert.equal(review.payload.verdict, 'red-reviewed');
  assert.equal(review.payload.probeId, probe.artifactId);

  process.stdout.write(`  review: ${review.artifactId} verdict=${review.payload.verdict}\n`);

  // ── 3. spike_record ────────────────────────────────────────────────────────

  section('3. spike_record');
  const spike = recordSpike(root, {
    probeId: probe.artifactId,
    description: 'Investigate JWT decode path',
    steps: ['Check jwt.verify call', 'Check token exp field', 'Trace guard condition'],
    observations: 'jwt.verify called without clockTolerance; exp check bypassed on fast path',
    commandSpec: { command: 'node', args: ['debug/jwt-trace.js'] },
    expectedFailurePattern: 'FAST_PATH.*no_exp_check',
    executionStatus: 'confirmed_failing',
    observedOutput: 'FAST_PATH: no_exp_check triggered',
  });

  assert.equal(spike.artifactKind, 'spike-record', 'spike kind');
  assert.equal(spike.evidenceScope, 'evidence-candidate');
  assert.equal(spike.payload.probeId, probe.artifactId);

  process.stdout.write(`  spike: ${spike.artifactId}\n`);

  // ── 4. spike_review_set ────────────────────────────────────────────────────

  section('4. spike_review_set');
  const spikeReview = reviewSpike(root, {
    spikeId: spike.artifactId,
    verdict: 'confirmed',
    notes: 'Root cause confirmed: missing exp check in jwt fast path',
  });

  assert.equal(spikeReview.payload.verdict, 'confirmed');
  assert.equal(spikeReview.evidenceScope, 'evidence-candidate');

  process.stdout.write(`  spike-review: ${spikeReview.artifactId} verdict=${spikeReview.payload.verdict}\n`);

  // ── 5. red_green_relation_create ───────────────────────────────────────────

  section('5. red_green_relation_create');
  const relation = createRedGreenRelation(root, {
    probeId: probe.artifactId,
    baselineCommandSpec: { command: 'node', args: ['test/auth.js', '--scenario=expired'] },
    baselineExpectedFailurePattern: 'AuthGuardError.*expired',
    currentCommandSpec: { command: 'node', args: ['test/auth.js', '--scenario=expired'] },
    currentExpectedFailurePattern: 'AuthGuardError.*expired',
    description: 'Baseline: token accepted; current: token should be rejected',
  });

  assert.equal(relation.artifactKind, 'red-green-relation');
  assert.equal(relation.evidenceScope, 'evidence-candidate');

  process.stdout.write(`  relation: ${relation.artifactId}\n`);

  // ── 6. red_green_relation_evaluate — happy path ────────────────────────────

  section('6. red_green_relation_evaluate — happy path (commands match)');
  const evaluation = evaluateRedGreenRelation(root, {
    relationId: relation.artifactId,
    relationDigest: relation.artifactDigest,
  });

  assert.equal(evaluation.artifactKind, 'red-green-relation-evaluation');
  assert.equal(evaluation.evidenceScope, 'evidence-candidate');
  assert.equal(evaluation.payload.pass, true, 'evaluation should pass (commands match, patterns defined)');

  process.stdout.write(`  evaluation: pass=${evaluation.payload.pass} reasons=${evaluation.payload.reasons.join('; ')}\n`);

  // ── 7. regression_matrix_review_set ───────────────────────────────────────

  section('7. regression_matrix_review_set');
  const matrix = reviewRegressionMatrix(root, {
    probeId: probe.artifactId,
    relationId: relation.artifactId,
    spikeId: spike.artifactId,
    status: 'accepted',
    notes: 'All checks passed; ready for story creation',
  });

  assert.equal(matrix.payload.status, 'accepted');
  assert.equal(matrix.evidenceScope, 'evidence-candidate');

  process.stdout.write(`  matrix-review: ${matrix.artifactId} status=${matrix.payload.status}\n`);

  // ── 8. story_create_from_repro ────────────────────────────────────────────

  section('8. story_create_from_repro — creates story + binding');

  // Stub story creator to avoid full Proof-or-Stop store setup
  let capturedArgs: Record<string, unknown> | null = null;
  const stubStoryCreator = async (args: Record<string, unknown>): Promise<string> => {
    capturedArgs = args;
    return 'B-test'; // stub story ID
  };

  const fromReproResult = await createStoryFromRepro(
    root,
    {
      probeId: probe.artifactId,
      reviewId: review.artifactId,
      spikeId: spike.artifactId,
      spikeReviewId: spikeReview.artifactId,
      matrixReviewId: matrix.artifactId,
      storyTitle: 'Fix auth guard expiry bypass',
      storyDescription: 'Auth guard allows expired tokens through fast path; fix jwt.verify call to include exp check',
      derivedChecklistRefs: ['CHK-001'],
      derivedVerificationIntentRefs: ['CHK-001:happy:0'],
    },
    stubStoryCreator,
  );

  assert.ok(fromReproResult.storyId, 'storyId is set');
  assert.equal(fromReproResult.storyId, 'B-test', 'storyId from creator');
  assert.ok(capturedArgs, 'story creator was called');

  const binding = readArtifact<StoryEvidenceBindingPayload>(root, fromReproResult.bindingArtifact.artifactId);
  assert.equal(binding.artifactKind, 'story-evidence-binding', 'binding kind');
  assert.equal(binding.evidenceScope, 'evidence-candidate', 'binding must be evidence-candidate');
  assert.equal(binding.payload.storyId, 'B-test');
  assert.equal(binding.payload.probeId, probe.artifactId);
  assert.equal(binding.payload.reviewId, review.artifactId);
  assert.equal(binding.payload.spikeId, spike.artifactId);
  assert.equal(binding.payload.spikeReviewId, spikeReview.artifactId);
  assert.equal(binding.payload.spikeReviewDigest, spikeReview.artifactDigest);
  assert.ok(binding.payload.note.includes('not set'), 'binding note must say verificationEvidence is not set');

  process.stdout.write(`  story: ${fromReproResult.storyId} binding: ${fromReproResult.bindingArtifact.artifactId}\n`);
  process.stdout.write(`  note: ${binding.payload.note}\n`);

  // ── 9. Proof: no verificationEvidence created ──────────────────────────────

  section('9. Proof: story_create_from_repro produces no verificationEvidence');
  {
    // The binding payload must not have any verificationEvidence field
    const bindingPayload = binding.payload as StoryEvidenceBindingPayload & { verificationEvidence?: unknown };
    assert.equal(bindingPayload.verificationEvidence, undefined, 'binding must not have verificationEvidence');
    process.stdout.write('  verificationEvidence is absent from binding — correct\n');
  }

  // ── 10. Mismatch relation fails evaluation ─────────────────────────────────

  section('10. red_green_relation_evaluate — mismatch fails closed');
  {
    // Create a probe with not_run status — evaluation should fail
    const mismatchProbe = createProbe(root, {
      candidateId: 'cand-mismatch-001',
      taskSummary: 'Test mismatch scenario for evaluation',
      eligibility: 'test',
      reason: 'test mismatch',
      commandSpec: { command: 'baseline-cmd' },
      expectedFailure: 'fails',
      expectedFailurePattern: 'pattern-a',
      executionStatus: 'not_run', // not_run should cause failure
      observedFailureSummary: '',
      boundedOutputExcerpt: '',
      producerObservedClass: 'unknown',
    });

    const mismatchRelation = createRedGreenRelation(root, {
      probeId: mismatchProbe.artifactId,
      baselineCommandSpec: { command: 'baseline-cmd' },
      baselineExpectedFailurePattern: 'pattern-a',
      currentCommandSpec: { command: 'different-cmd' }, // different command → should fail
      currentExpectedFailurePattern: 'pattern-b',
      description: 'Mismatch test',
    });

    const mismatchEval = evaluateRedGreenRelation(root, { relationId: mismatchRelation.artifactId });
    assert.equal(mismatchEval.payload.pass, false, 'mismatch evaluation must fail');
    assert.ok(
      mismatchEval.payload.reasons.some(r => r.includes('mismatch') || r.includes('not_run') || r.includes('missing red-reviewed')),
      'reasons must mention the failure cause',
    );

    process.stdout.write(`  mismatch eval: pass=${mismatchEval.payload.pass} reasons=${mismatchEval.payload.reasons.join('; ')}\n`);

    const emptyPatternRelation = createRedGreenRelation(root, {
      probeId: probe.artifactId,
      baselineCommandSpec: { command: 'node', args: ['test/auth.js', '--scenario=expired'] },
      baselineExpectedFailurePattern: '',
      currentCommandSpec: { command: 'node', args: ['test/auth.js', '--scenario=expired'] },
      currentExpectedFailurePattern: '',
      description: 'Empty pattern fail-closed test',
    });
    const emptyPatternEval = evaluateRedGreenRelation(root, { relationId: emptyPatternRelation.artifactId });
    assert.equal(emptyPatternEval.payload.pass, false, 'empty failure patterns must fail closed');
    assert.ok(
      emptyPatternEval.payload.reasons.some(r => r.includes('expected failure patterns')),
      'empty-pattern evaluation should explain missing failure patterns',
    );
  }

  // ── 11. repro-rejected blocks story creation ───────────────────────────────

  section('11. repro-rejected probe blocks story_create_from_repro');
  {
    const rejectedProbe = createProbe(root, {
      candidateId: 'cand-rejected-001',
      taskSummary: 'Should be rejected',
      eligibility: 'test',
      reason: 'test rejection path',
      commandSpec: { command: 'test' },
      expectedFailure: 'fail',
      expectedFailurePattern: 'fail',
      executionStatus: 'confirmed_failing',
      observedFailureSummary: 'bootstrap noise',
      boundedOutputExcerpt: '',
      producerObservedClass: 'bootstrap-noise',
    });
    const rejectedReview = reviewProbe(root, {
      probeId: rejectedProbe.artifactId,
      verdict: 'repro-rejected',
      reviewedFailureClass: 'bootstrap-noise',
      notes: 'Not a real bug',
    });
    await assert.rejects(
      () => createStoryFromRepro(root, {
        probeId: rejectedProbe.artifactId,
        reviewId: rejectedReview.artifactId,
        storyTitle: 'Should not create',
        storyDescription: 'Should not create this story from rejected repro',
      }, async () => 'should-not-reach'),
      /non-accepted repro review/,
      'rejected repro must block story creation',
    );
    process.stdout.write('  correctly blocked story creation from rejected repro\n');
  }

  // ── 12. Proof: all artifacts are evidence-candidate scope ─────────────────

  section('12. Proof: all artifacts are non-production/non-DONE scoped');
  {
    const artifacts = [probe, review, spike, spikeReview, relation, evaluation, matrix, fromReproResult.bindingArtifact];
    for (const a of artifacts) {
      assert.equal(a.evidenceScope, 'evidence-candidate', `${a.artifactKind} must be evidence-candidate`);
    }
    process.stdout.write(`  ${artifacts.length} artifacts verified as evidence-candidate\n`);
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

rmSync(root, { recursive: true, force: true });

process.stdout.write('\nrepro-first candidate smoke passed\n');
