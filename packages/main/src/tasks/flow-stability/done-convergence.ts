import { strict as assert } from 'node:assert';

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { loadConfig, resetConfigCache } from '../../core/config.js';

import { classifyGitStatusRows, dirtyWorktreeClassifierOptionsFromConfig } from '../../core/dirty-worktree.js';

import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../../core/evidence-freshness.js';

import { signReviewPass, verifyReviewPass } from '../../core/finding-verify.js';

import { signReviewRun, verifyReviewRun } from '../../core/review-run.js';

import { CURRENT_PROMPT_IDENTITIES, domainSeparatedDigest } from '../../core/prompt-contracts.js';

import { StoryStore } from '../../core/store.js';
import type { ReviewRun } from '../../core/types.js';

import { formatWorktreePollutionDetails } from '../../core/validation-executor.js';

import { assertDonePreparePassConvergence, collectDonePrepareConvergenceFacts, deriveDonePreparePassConvergence, donePrepareJsonResult, validationCloseoutAdvancePaths } from '../../handlers/done-prepare.js';
import { buildPhaseTransitionProcessEvent } from '../../handlers/transition-orchestrator.js';

import { ORIGINAL_TASKS_DIR } from './support.js';
import { write, git } from './support.js';

export function assertProductionHelperPassesProjectRootToClassifier(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-prod-root-'));
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'src',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: 'workflow/stories',
      requirementsDir: 'docs/requirements',
    }));
    resetConfigCache();

    const worktreePollution: {
      statusLines: string[];
      paths: string[];
      blocking?: boolean;
    } = {
      statusLines: [' M workflow/stories/B-smoke/checklist.json'],
      paths: ['workflow/stories/B-smoke/checklist.json'],
    };
    const mockResult = {
      label: 'smoke-cmd',
      command: 'echo',
      args: ['ok'],
      code: 0,
      output: '',
      durationMs: 0,
      worktreePollution,
    };

    const lines = formatWorktreePollutionDetails(mockResult, root);
    assert.ok(lines.length > 0, 'formatWorktreePollutionDetails must return lines');
    const header = lines[0];
    assert.ok(
      header.startsWith('✓'),
      `Production helper must classify custom storyDir path as proof_or_stop_metadata (passing). ` +
      `Got: ${header} — if this fails, the production helper is not passing projectRoot to dirtyWorktreeClassifierOptionsFromConfig.`,
    );
    assert.equal(
      worktreePollution.blocking, false,
      'worktreePollution.blocking must be false when only proof_or_stop_metadata paths are dirty',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

export function assertCustomStoryDirDirtyWorktreeClassification(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-custom-storydir-'));
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'src',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: 'workflow/stories',
      requirementsDir: 'docs/requirements',
    }));
    resetConfigCache();

    const config = loadConfig(root);
    const opts = dirtyWorktreeClassifierOptionsFromConfig(config, root);

    // 1. Custom storyDir sub-path must be proof_or_stop_metadata_changes.
    const storyMeta = classifyGitStatusRows(
      [' M workflow/stories/B-smoke/test-evidence.json'],
      opts,
    );
    assert.equal(
      storyMeta.groups.proof_or_stop_metadata_changes.length, 1,
      'workflow/stories/B-smoke/test-evidence.json must be proof_or_stop_metadata_changes with custom storyDir',
    );
    assert.equal(storyMeta.groups.unexpected_dirty_files.length, 0);

    // 2. Sibling path outside storyDir must not be classified as proof_or_stop_metadata.
    const notMeta = classifyGitStatusRows(
      ['?? workflow/notes.md'],
      opts,
    );
    assert.equal(
      notMeta.groups.proof_or_stop_metadata_changes.length, 0,
      'workflow/notes.md must not be proof_or_stop_metadata_changes',
    );
    assert.equal(
      notMeta.groups.unexpected_dirty_files.length, 1,
      'workflow/notes.md must be unexpected_dirty_files',
    );

    // 3. Default .proof-or-stop/story/ paths still work even with projectRoot set.
    const defaultMeta = classifyGitStatusRows(
      [' M .proof-or-stop/story/actives/B-xxx/checklist.json'],
      opts,
    );
    assert.equal(
      defaultMeta.groups.proof_or_stop_metadata_changes.length, 1,
      '.proof-or-stop/story/ default prefix must still be proof_or_stop_metadata_changes',
    );

    // 4. Material source path is NOT reclassified as proof_or_stop_metadata even if
    //    projectRoot is set (classifier checks metadata first, but src/ is not
    //    storyDir so it stays material).
    const materialOpts = dirtyWorktreeClassifierOptionsFromConfig(config, root);
    const material = classifyGitStatusRows(
      [' M src/core/foo.ts'],
      materialOpts,
    );
    assert.equal(
      material.groups.material_source_changes.length, 1,
      'src/core/foo.ts must remain material_source_changes with projectRoot set',
    );
    assert.equal(material.groups.proof_or_stop_metadata_changes.length, 0);

    // 5. Fixture path is not reclassified.
    const fixtureOpts = dirtyWorktreeClassifierOptionsFromConfig(config, root);
    const fixture = classifyGitStatusRows(
      ['?? tests/fixtures/my-fixture.json'],
      fixtureOpts,
    );
    assert.equal(
      fixture.groups.fixture_changes.length, 1,
      'tests/fixtures/ path must remain fixture_changes',
    );
    assert.equal(fixture.groups.proof_or_stop_metadata_changes.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

export function assertDonePrepareOnePassConvergenceContract(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-done-prepare-convergence-'));
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: '.', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', testsDir: 'tests',
      fixturesDir: 'tests/fixtures', requirementsDir: 'docs/requirements', storyPrefix: 'B',
    }));
    write(root, 'src/app.ts', 'export const stable = true;\n');
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'convergence@example.test']);
    git(root, ['config', 'user.name', 'convergence-smoke']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'baseline']);
    resetConfigCache();
    const store = new StoryStore(root);
    const storyId = 'B-convergence';
    const ctx = { store, root, scanRoot: root } as any;
    const before = currentGitHead(root)!;
    write(root, `.proof-or-stop/story/actives/${storyId}/test-evidence.json`, '{}\n');
    write(root, `.proof-or-stop/story/actives/${storyId}/closeout-write-receipts.jsonl`, '{}\n');
    write(root, `.proof-or-stop/story/actives/${storyId}/owner-lease.json`, '{}\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'canonical validation closeout metadata']);
    const metadataHead = currentGitHead(root)!;
    const accepted = validationCloseoutAdvancePaths(ctx, storyId, root, before, metadataHead);
    assert.equal(accepted.eligible, true, accepted.reasons.join('; '));
    assert.deepEqual(accepted.paths.sort(), [
      `.proof-or-stop/story/actives/${storyId}/closeout-write-receipts.jsonl`,
      `.proof-or-stop/story/actives/${storyId}/owner-lease.json`,
      `.proof-or-stop/story/actives/${storyId}/test-evidence.json`,
    ]);

    write(root, 'src/app.ts', 'export const stable = false;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'real material drift']);
    const drifted = validationCloseoutAdvancePaths(ctx, storyId, root, metadataHead, currentGitHead(root)!);
    assert.equal(drifted.eligible, false, 'real source drift must never be normalized as closeout metadata');
    assert(drifted.reasons.some((reason) => reason.includes('non-story path')));

    const attemptMaterial = currentMaterialHash(root, 'HEAD', root)!;
    const attemptStoryFiles = currentStoryFilesHash(root, 'HEAD', root)!;
    const reviewRound = '2026-01-01T00:00:00.000Z';
    const makeCompletedReview = (
      suffix: string,
      startedAt: string,
      completedAt: string,
      round = reviewRound,
      binding: { materialHash?: string; storyFilesHash?: string } = {},
    ) => {
      const reviewRunId = `${storyId}:RR-${suffix}`;
      const agent = 'proof-or-stop-review-quality';
      const assembledPrompt = [
        JSON.stringify({ schemaVersion: CURRENT_PROMPT_IDENTITIES.roleContract }),
        JSON.stringify({ schemaVersion: CURRENT_PROMPT_IDENTITIES.fullTaskContext }),
        JSON.stringify({ schemaVersion: CURRENT_PROMPT_IDENTITIES.knownExecutionEnvironment }),
      ].join('\n');
      const promptHash = domainSeparatedDigest('assembled-prompt.raw-utf8.v1', assembledPrompt);
      const envelopeId = `PE-${suffix}`;
      const run: ReviewRun = {
        reviewRunId,
        storyId,
        agent,
        lane: agent,
        reviewRound: round,
        startedAt,
        headHash: currentGitHead(root)!,
        materialHash: binding.materialHash ?? attemptMaterial,
        storyFilesHash: binding.storyFilesHash ?? attemptStoryFiles,
        promptHash,
        envelopeId,
        assembledPrompt,
      };
      run._hash = signReviewRun(
        storyId, reviewRunId, agent, agent, round, startedAt, run.headHash, run.materialHash,
        run.promptHash, undefined, undefined, run.storyFilesHash, envelopeId,
      );
      const pass = {
        id: `RP-${suffix}`,
        agent,
        note: `review ${suffix}`,
        createdAt: completedAt,
        reviewRound: round,
        reviewRunId,
        _hash: signReviewPass(storyId, `RP-${suffix}`, agent, `review ${suffix}`, completedAt, round, reviewRunId),
      };
      return { run, pass };
    };
    const initialReview = makeCompletedReview('001', '2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z');
    const metadataReattestation = makeCompletedReview('002', '2026-01-01T00:03:00.000Z', '2026-01-01T00:04:00.000Z');
    const atTestEntryReattestation = makeCompletedReview('003', '2026-01-01T00:04:30.000Z', '2026-01-01T00:05:00.000Z');
    const postTestReattestation = makeCompletedReview('004', '2026-01-01T00:05:30.000Z', '2026-01-01T00:06:00.000Z');
    const historicalRound = makeCompletedReview('OLD', '2026-01-01T00:03:30.000Z', '2026-01-01T00:04:30.000Z', '2025-12-31T00:00:00.000Z');
    assert.equal(verifyReviewRun(initialReview.run), true);
    assert.equal(verifyReviewRun(metadataReattestation.run), true);
    assert.equal(verifyReviewPass(storyId, initialReview.pass), true);
    assert.equal(verifyReviewPass(storyId, metadataReattestation.pass), true);
    store.writeReviewRuns(storyId, { runs: [historicalRound.run, initialReview.run, metadataReattestation.run] });
    store.writeReviewPasses(storyId, { passes: [historicalRound.pass, initialReview.pass, metadataReattestation.pass] });
    write(root, `.proof-or-stop/story/actives/${storyId}/process-events.jsonl`, [
      JSON.stringify({
        type: 'phase_transition', storyId, timestamp: reviewRound, attemptId: reviewRound,
        fromPhase: 'DEV', toPhase: 'REVIEW', materialHash: attemptMaterial,
        storyFilesHash: attemptStoryFiles, reviewRound,
      }),
      JSON.stringify({
        type: 'phase_transition', storyId, timestamp: '2026-01-01T00:05:00.000Z', attemptId: reviewRound,
        fromPhase: 'REVIEW', toPhase: 'TEST', materialHash: attemptMaterial,
        storyFilesHash: attemptStoryFiles, reviewRound,
      }),
    ].join('\n'));
    const collected = collectDonePrepareConvergenceFacts(ctx, storyId);
    assert.deepEqual(
      collected?.reviewerIdentityIds,
      [metadataReattestation.run.reviewRunId],
      'collector must count a same-binding REVIEW re-attestation completed before TEST and ignore an old round',
    );
    assert.deepEqual(collected?.postTestReviewerIdentityIds, [], 'pre-TEST reviewer re-attestations must not enter the blocking counter');
    const collectedConvergence = deriveDonePreparePassConvergence([
      { id: 'validate', status: 'pass', reason: 'Validation PASS reused; commandExecutions=0' },
      { id: 'doneClosure', status: 'pass' },
      { id: 'cleanTree', status: 'pass' },
    ] as any, { blockers: [] } as any, collected);
    assert.equal(
      collectedConvergence?.reviewerReattestations,
      1,
      'real collector history must make reviewerReattestations non-zero',
    );
    assert.doesNotThrow(
      () => assertDonePreparePassConvergence(collectedConvergence!),
      'legitimate reviewer re-attestations must remain observable without blocking PASS convergence',
    );
    store.writeReviewRuns(storyId, { runs: [historicalRound.run, initialReview.run, metadataReattestation.run, atTestEntryReattestation.run, postTestReattestation.run] });
    store.writeReviewPasses(storyId, { passes: [historicalRound.pass, initialReview.pass, metadataReattestation.pass, atTestEntryReattestation.pass, postTestReattestation.pass] });
    const postTestCollected = collectDonePrepareConvergenceFacts(ctx, storyId);
    assert.deepEqual(
      postTestCollected?.reviewerIdentityIds,
      [metadataReattestation.run.reviewRunId, atTestEntryReattestation.run.reviewRunId, postTestReattestation.run.reviewRunId],
      'total reviewer re-attestation telemetry must include pre- and post-TEST completed passes',
    );
    assert.deepEqual(
      postTestCollected?.postTestReviewerIdentityIds,
      [atTestEntryReattestation.run.reviewRunId, postTestReattestation.run.reviewRunId],
      'a completed reviewer pass at or after TEST entry must enter the blocking counter',
    );
    const postTestConvergence = deriveDonePreparePassConvergence([
      { id: 'validate', status: 'pass', reason: 'Validation PASS reused; commandExecutions=0' },
      { id: 'doneClosure', status: 'pass' },
      { id: 'cleanTree', status: 'pass' },
    ] as any, { blockers: [] } as any, postTestCollected);
    assert.equal(postTestConvergence?.reviewerReattestations, 3);
    assert.equal(postTestConvergence?.postTestReviewerReattestations, 2);
    assert.throws(
      () => assertDonePreparePassConvergence(postTestConvergence!),
      /done_prepare convergence invariant failed/,
      'post-TEST reviewer re-attestation must fail PASS convergence',
    );

    const interleavedLate = makeCompletedReview('INT-A', '2026-01-01T00:01:00.000Z', '2026-01-01T00:06:00.000Z');
    const interleavedEarly = makeCompletedReview('INT-B', '2026-01-01T00:03:00.000Z', '2026-01-01T00:04:00.000Z');
    const invalidRunSignature = makeCompletedReview('BAD-RUN', '2026-01-01T00:01:30.000Z', '2026-01-01T00:02:30.000Z');
    invalidRunSignature.run._hash = 'invalid';
    const invalidPassSignature = makeCompletedReview('BAD-PASS', '2026-01-01T00:01:40.000Z', '2026-01-01T00:02:40.000Z');
    invalidPassSignature.pass._hash = 'invalid';
    const wrongMaterial = makeCompletedReview(
      'WRONG-MATERIAL',
      '2026-01-01T00:01:50.000Z',
      '2026-01-01T00:02:50.000Z',
      reviewRound,
      { materialHash: 'wrong-material' },
    );
    const wrongStoryFiles = makeCompletedReview(
      'WRONG-STORY-FILES',
      '2026-01-01T00:02:00.000Z',
      '2026-01-01T00:03:00.000Z',
      reviewRound,
      { storyFilesHash: 'wrong-story-files' },
    );
    const missingPass = makeCompletedReview('MISSING-PASS', '2026-01-01T00:02:10.000Z', '2026-01-01T00:03:10.000Z');
    store.writeReviewRuns(storyId, { runs: [
      interleavedLate.run,
      invalidRunSignature.run,
      wrongStoryFiles.run,
      interleavedEarly.run,
      invalidPassSignature.run,
      wrongMaterial.run,
      missingPass.run,
      historicalRound.run,
    ] });
    store.writeReviewPasses(storyId, { passes: [
      interleavedLate.pass,
      wrongStoryFiles.pass,
      invalidRunSignature.pass,
      interleavedEarly.pass,
      invalidPassSignature.pass,
      wrongMaterial.pass,
      historicalRound.pass,
    ] });
    const interleavedCollected = collectDonePrepareConvergenceFacts(ctx, storyId);
    assert.deepEqual(
      interleavedCollected?.reviewerIdentityIds,
      [interleavedLate.run.reviewRunId],
      'the first completed identity is the lane baseline even when it started later',
    );
    assert.deepEqual(
      interleavedCollected?.postTestReviewerIdentityIds,
      [interleavedLate.run.reviewRunId],
      'an earlier-started identity that completes after TEST must remain a blocking re-attestation',
    );
    for (const excludedId of [
      invalidRunSignature.run.reviewRunId,
      invalidPassSignature.run.reviewRunId,
      wrongMaterial.run.reviewRunId,
      wrongStoryFiles.run.reviewRunId,
      missingPass.run.reviewRunId,
      historicalRound.run.reviewRunId,
    ]) {
      assert.equal(interleavedCollected?.reviewerIdentityIds.includes(excludedId), false, `${excludedId} must not count as a completed same-binding identity`);
    }
    const interleavedConvergence = deriveDonePreparePassConvergence([
      { id: 'validate', status: 'pass', reason: 'Validation PASS reused; commandExecutions=0' },
      { id: 'doneClosure', status: 'pass' },
      { id: 'cleanTree', status: 'pass' },
    ] as any, { blockers: [] } as any, interleavedCollected);
    assert.equal(interleavedConvergence?.postTestReviewerReattestations, 1);
    assert.throws(
      () => assertDonePreparePassConvergence(interleavedConvergence!),
      /done_prepare convergence invariant failed/,
      'interleaved completion order must not hide a post-TEST re-attestation',
    );
    const tieHigh = makeCompletedReview('TIE-Z', '2026-01-01T00:01:00.000Z', '2026-01-01T00:04:30.000Z');
    const tieLow = makeCompletedReview('TIE-A', '2026-01-01T00:02:00.000Z', '2026-01-01T00:04:30.000Z');
    store.writeReviewRuns(storyId, { runs: [tieHigh.run, tieLow.run] });
    store.writeReviewPasses(storyId, { passes: [tieHigh.pass, tieLow.pass] });
    const tiedCollected = collectDonePrepareConvergenceFacts(ctx, storyId);
    assert.deepEqual(
      tiedCollected?.reviewerIdentityIds,
      [tieHigh.run.reviewRunId],
      'equal completion timestamps must choose the lexically first reviewRunId as baseline regardless of storage order',
    );
    assert.deepEqual(tiedCollected?.postTestReviewerIdentityIds, []);

    const transcript = [
      'DONE prepare: PASS',
      `storyId: ${storyId}`,
      'convergence: metadataRollbacks=0 reviewerReattestations=1 postTestReviewerReattestations=0 humanConfirmations=0 unchangedSuiteExecutions=0 successfulCloseout=1',
    ].join('\n');
    assert.deepEqual(donePrepareJsonResult(storyId, transcript).convergence, {
      metadataRollbacks: 0,
      reviewerReattestations: 1,
      postTestReviewerReattestations: 0,
      humanConfirmations: 0,
      unchangedSuiteExecutions: 0,
      // B-f824: the transcript above uses the pre-split (old) line shape; the
      // backward-tolerant parser must default the missing field to 0.
      reviewWindowSuiteExecutions: 0,
      successfulCloseout: 1,
    });
    const baseFacts = {
      anchor: {
        timestamp: '2026-01-01T00:00:00.000Z',
        attemptId: 'round-1',
        materialHash: 'material-1',
        storyFilesHash: 'story-1',
        reviewRound: 'round-1',
      },
      testEntryAt: '2026-01-01T00:00:30.000Z',
      phaseTransitions: [],
      humanConfirmations: [],
      validationTerminals: [{
        type: 'validation_terminal',
        timestamp: '2026-01-01T00:01:00.000Z',
        commandSetHash: 'commands-1',
        materialHash: 'material-1',
        storyFilesHash: 'story-1',
        disposition: 'executed',
        commandExecutions: 1,
      }],
      reviewerIdentityIds: [],
      postTestReviewerIdentityIds: [],
      closeoutWriterSequence: ['validate:test-evidence.json'],
    } as any;
    assert.deepEqual(buildPhaseTransitionProcessEvent({
      storyId,
      fromPhase: 'REVIEW',
      toPhase: 'TEST',
      materialHash: 'material-1',
      storyFilesHash: 'story-1',
      reviewRound: 'round-1',
    }), {
      type: 'phase_transition',
      storyId,
      attemptId: 'round-1',
      fromPhase: 'REVIEW',
      toPhase: 'TEST',
      materialHash: 'material-1',
      storyFilesHash: 'story-1',
      reviewRound: 'round-1',
    });
    const passSteps = [
      { id: 'validate', status: 'pass', reason: 'Validation PASS reused (trusted-story-metadata-descendant); commandExecutions=0' },
      { id: 'doneClosure', status: 'pass' },
      { id: 'cleanTree', status: 'pass' },
    ] as any;
    const derived = deriveDonePreparePassConvergence(passSteps, { blockers: [] } as any, baseFacts);
    assert.deepEqual(derived, {
      metadataRollbacks: 0,
      reviewerReattestations: 0,
      postTestReviewerReattestations: 0,
      humanConfirmations: 0,
      unchangedSuiteExecutions: 0,
      // B-f824: derive now always emits the observable telemetry field.
      reviewWindowSuiteExecutions: 0,
      successfulCloseout: 1,
    });
    const duplicateExecution = deriveDonePreparePassConvergence(passSteps, { blockers: [] } as any, {
      ...baseFacts,
      validationTerminals: [
        ...baseFacts.validationTerminals,
        { ...baseFacts.validationTerminals[0], timestamp: '2026-01-01T00:02:00.000Z' },
      ],
    });
    assert.equal(duplicateExecution?.unchangedSuiteExecutions, 1, 'a second execution of an unchanged command set must make the PASS convergence invariant fail');
    assert.throws(
      () => assertDonePreparePassConvergence(duplicateExecution!),
      /done_prepare convergence invariant failed/,
      'reused validation with commandExecutions>0 must never render PASS',
    );
    for (const negative of [
      { ...baseFacts, phaseTransitions: [{ type: 'phase_transition', timestamp: '2026-01-01T00:03:00.000Z', fromPhase: 'TEST', toPhase: 'DEV', materialHash: 'material-1', storyFilesHash: 'story-1' }] },
      { ...baseFacts, humanConfirmations: [{ type: 'human_confirmation', timestamp: '2026-01-01T00:03:00.000Z' }] },
    ] as any[]) {
      assert.throws(
        () => assertDonePreparePassConvergence(deriveDonePreparePassConvergence(passSteps, { blockers: [] } as any, negative)!),
        /done_prepare convergence invariant failed/,
      );
    }
    const failedCloseout = deriveDonePreparePassConvergence([
      ...passSteps,
      { id: 'doneClosure', status: 'blocked', reason: 'closeout blocker remains' },
    ] as any, { blockers: [] } as any, baseFacts);
    assert.equal(failedCloseout?.successfulCloseout, 0, 'a blocked closeout must not count as successful convergence');
    assert.throws(
      () => assertDonePreparePassConvergence(failedCloseout!),
      /done_prepare convergence invariant failed/,
      'a failed closeout must never render PASS',
    );
    assert.equal(deriveDonePreparePassConvergence(passSteps, { blockers: [] } as any, null), null, 'legacy/missing attempt telemetry must omit the convergence claim');
    assert.doesNotThrow(() => assertDonePreparePassConvergence(derived!));
    assert.equal(donePrepareJsonResult(storyId, 'DONE prepare: BLOCKED\nblockedAt: cleanTree\nreason: materialHash changed').convergence, undefined);

    const handlerSource = readFileSync(resolve(ORIGINAL_TASKS_DIR, '../handlers/done-prepare.js'), 'utf8');
    assert.equal((handlerSource.match(/await verifier\.validate\(/g) ?? []).length, 1, 'done_prepare must have one routine validation invocation site');
    assert.match(handlerSource, /runDonePrepare\(ctx,[\s\S]{0,500}validate: false/, 'auto-closeout recursion must disable nested validation');
    assert.match(handlerSource, /deriveDonePreparePassConvergence/, 'PASS counters must be derived from steps and runbook facts');
    assert.doesNotMatch(handlerSource, /convergence: metadataRollbacks=0 reviewerReattestations=0/, 'PASS must not print cosmetic hard-coded zero counters');

    // B-f824: phase-anchored suite-execution split (B-956f review-window poisoning repro)
    // Post-fix semantics (CHK-002): blocking unchangedSuiteExecutions counts only
    // per-group duplicate executed terminals at or after facts.testEntryAt (>=
    // comparison, same convention as postTestReviewerIdentityIds) plus contradictory
    // reused terminals with commandExecutions>0 in any phase; observable
    // reviewWindowSuiteExecutions keeps the whole-window per-group duplicate count
    // as non-blocking telemetry.
    const splitAnchorAt = '2026-01-01T10:00:00.000Z';
    const splitTestEntryAt = '2026-01-01T10:30:00.000Z';
    const makeSplitTerminal = (
      timestamp: string,
      commandSetHash: string,
      disposition: 'executed' | 'reused',
      commandExecutions: number,
    ) => ({
      type: 'validation_terminal',
      timestamp,
      commandSetHash,
      materialHash: 'material-split',
      storyFilesHash: 'story-split',
      disposition,
      commandExecutions,
    });
    const splitFacts = (validationTerminals: unknown[]) => ({
      anchor: {
        timestamp: splitAnchorAt,
        attemptId: 'round-split',
        materialHash: 'material-split',
        storyFilesHash: 'story-split',
        reviewRound: 'round-split',
      },
      testEntryAt: splitTestEntryAt,
      phaseTransitions: [],
      humanConfirmations: [],
      validationTerminals,
      reviewerIdentityIds: [],
      postTestReviewerIdentityIds: [],
      closeoutWriterSequence: ['validate:test-evidence.json'],
    }) as any;
    // Case A — B-956f window shape: two reviewer-driven executed terminals during
    // REVIEW (cmdSet X, then cmdSet Y evicting the single-slot receipt), one forced
    // closeout re-execution of cmdSet X at/after TEST entry, one reused post-TEST.
    const reviewWindowPoisoning = deriveDonePreparePassConvergence(passSteps, { blockers: [] } as any, splitFacts([
      makeSplitTerminal('2026-01-01T10:05:00.000Z', 'cmdset-x', 'executed', 46),
      makeSplitTerminal('2026-01-01T10:10:00.000Z', 'cmdset-y', 'executed', 46),
      makeSplitTerminal('2026-01-01T10:35:00.000Z', 'cmdset-x', 'executed', 46),
      makeSplitTerminal('2026-01-01T10:40:00.000Z', 'cmdset-x', 'reused', 0),
    ]));
    assert.equal(
      reviewWindowPoisoning?.unchangedSuiteExecutions, 0,
      'pre-TEST reviewer executions plus one post-TEST closeout execution per group must not block PASS convergence',
    );
    assert.equal(
      reviewWindowPoisoning?.reviewWindowSuiteExecutions, 1,
      'whole-window duplicate executions must stay observable as reviewWindowSuiteExecutions telemetry',
    );
    assert.doesNotThrow(
      () => assertDonePreparePassConvergence(reviewWindowPoisoning!),
      'the B-956f review-window shape must not fail PASS convergence after the phase-anchored split',
    );
    // Case B — closeout thrash: two executed terminals in the SAME identity group
    // both at or after TEST entry must stay blocking.
    const closeoutThrash = deriveDonePreparePassConvergence(passSteps, { blockers: [] } as any, splitFacts([
      makeSplitTerminal('2026-01-01T10:31:00.000Z', 'cmdset-x', 'executed', 46),
      makeSplitTerminal('2026-01-01T10:45:00.000Z', 'cmdset-x', 'executed', 46),
    ]));
    assert.equal(closeoutThrash?.unchangedSuiteExecutions, 1, 'duplicate post-TEST executions of one command set must stay blocking');
    assert.throws(
      () => assertDonePreparePassConvergence(closeoutThrash!),
      /done_prepare convergence invariant failed/,
      'closeout-path duplicate execution must still fail PASS convergence',
    );
    // Case C — boundary: an executed terminal at exactly testEntryAt is post-TEST
    // (>= comparison); one pre-TEST baseline plus one post-TEST execution is allowed.
    const boundaryAtTestEntry = deriveDonePreparePassConvergence(passSteps, { blockers: [] } as any, splitFacts([
      makeSplitTerminal('2026-01-01T10:05:00.000Z', 'cmdset-x', 'executed', 46),
      makeSplitTerminal(splitTestEntryAt, 'cmdset-x', 'executed', 46),
    ]));
    assert.equal(boundaryAtTestEntry?.unchangedSuiteExecutions, 0, 'one pre-TEST baseline plus one execution at exactly testEntryAt must not block');
    assert.equal(
      boundaryAtTestEntry?.reviewWindowSuiteExecutions, 1,
      'the boundary duplicate must still be counted in whole-window telemetry',
    );
    assert.doesNotThrow(() => assertDonePreparePassConvergence(boundaryAtTestEntry!));
    const singlePostTestExecution = deriveDonePreparePassConvergence(passSteps, { blockers: [] } as any, splitFacts([
      makeSplitTerminal('2026-01-01T10:35:00.000Z', 'cmdset-x', 'executed', 46),
    ]));
    assert.equal(singlePostTestExecution?.unchangedSuiteExecutions, 0, 'a single post-TEST execution must not block');
    assert.equal(
      singlePostTestExecution?.reviewWindowSuiteExecutions, 0,
      'a single execution must not register whole-window duplicate telemetry',
    );
    assert.doesNotThrow(() => assertDonePreparePassConvergence(singlePostTestExecution!));
    // Case D — contradictory reused terminal (commandExecutions>0) pre-TEST must
    // stay blocking in any phase.
    const contradictoryReused = deriveDonePreparePassConvergence(passSteps, { blockers: [] } as any, splitFacts([
      makeSplitTerminal('2026-01-01T10:05:00.000Z', 'cmdset-x', 'reused', 46),
    ]));
    assert.ok(
      (contradictoryReused?.unchangedSuiteExecutions ?? 0) >= 1,
      'a reused terminal claiming commandExecutions>0 must stay blocking regardless of phase',
    );
    assert.throws(
      () => assertDonePreparePassConvergence(contradictoryReused!),
      /done_prepare convergence invariant failed/,
      'contradictory reused terminals must still fail PASS convergence',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}
