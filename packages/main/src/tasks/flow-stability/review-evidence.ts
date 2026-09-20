import { strict as assert } from 'node:assert';

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetConfigCache } from '../../core/config.js';

import { EMPTY_STORY_FILES_HASH, checkEvidenceFreshnessForGit, currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../../core/evidence-freshness.js';

import { verifyFinding, verifyReviewPass } from '../../core/finding-verify.js';

import { getGuardFailureReason } from '../../core/machine.js';

import { assertCurrentReviewRunForEvidence, buildReviewRunWorkspaceBinding, collectReviewerEvidenceState, isTerminalReviewerFindingStatus, signReviewRun, verifyReviewRun } from '../../core/review-run.js';

import { summarizeReviewerStatus } from '../../core/reviewer-status.js';
import { StoryStore } from '../../core/store.js';
import type { ChecklistData, Finding, ReviewRun, StoryInfo, TestEvidenceData } from '../../core/types.js';
import { findStaleEvidence } from '../../core/evidence-stale-hint.js';

import { buildDoneChecklist } from '../../core/done-oracle.js';
import { buildVerificationCoverage } from '../../core/verification.js';

import { refreshStaleEvidenceMetadataOnly } from '../../handlers/checklist.js';

import { runReviewCliGates, renderPreflight } from '../../handlers/review-preflight.js';

import { createStoryDispatchHandlers } from '../../handlers/story-dispatch.js';

import { nativeReviewFixtureBrokers, withNativeReviewFixtureHostIdentity } from '../native-review-fixture.js';
import { createReviewRunHandlers } from '../../handlers/review-run.js';

import { createReviewStore, seedReviewRuns, makeFinding, makeReviewPass, makeLegacyFindingWithoutRun, makeLegacyReviewPassWithoutRun, reviewEnvelopeIds, nativeReviewFixtureContexts, write, git, currentPromptEnvelopeBinding } from './support.js';

export function assertReviewGateUsesOptIn(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-review-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, [
      'proof-or-stop-review-concept',
      'proof-or-stop-review-quality',
      'proof-or-stop-review-docs',
      'proof-or-stop-review-test-coverage',
    ]);
    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'proof-or-stop-review-concept', reviewRound, '001', runIds.get('proof-or-stop-review-concept')!),
        makeFinding(storyId, 'proof-or-stop-review-quality', reviewRound, '002', runIds.get('proof-or-stop-review-quality')!),
        makeFinding(storyId, 'proof-or-stop-review-docs', reviewRound, '003', runIds.get('proof-or-stop-review-docs')!),
      ],
    });

    const missing = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(missing ?? '', /Expected 3 reviewers \(opt-in: concept,quality,test-coverage\)/);
    assert.match(missing ?? '', /Missing: test-coverage/);
    assert.match(missing ?? '', /proof-or-stop-review-docs/);
    assert.doesNotMatch(missing ?? '', /all 5 reviewers/);

    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'proof-or-stop-review-concept', reviewRound, '004', runIds.get('proof-or-stop-review-concept')!),
        makeFinding(storyId, 'proof-or-stop-review-quality', reviewRound, '005', runIds.get('proof-or-stop-review-quality')!),
      ],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'proof-or-stop-review-test-coverage', reviewRound, '006', runIds.get('proof-or-stop-review-test-coverage')!),
      ],
    });
    const pass = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.equal(pass, null);

    const status = summarizeReviewerStatus(store, storyId, root);
    const byName = new Map(status.entries.map(e => [e.name, e]));
    assert.equal(byName.get('test-coverage')?.verdict, 'pass');
    assert.equal(byName.has('channel'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertReviewRunBindingRejectsInvalidEvidence(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-review-run-binding-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const agents = [
      'proof-or-stop-review-concept',
      'proof-or-stop-review-quality',
      'proof-or-stop-review-test-coverage',
    ];
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, agents);

    const retrofittedLegacyFinding = {
      ...makeLegacyFindingWithoutRun(storyId, 'proof-or-stop-review-quality', reviewRound, '045'),
      reviewRunId: runIds.get('proof-or-stop-review-quality')!,
    };
    const retrofittedLegacyPass = {
      ...makeLegacyReviewPassWithoutRun(storyId, 'proof-or-stop-review-quality', reviewRound, '046'),
      reviewRunId: runIds.get('proof-or-stop-review-quality')!,
    };
    assert.equal(
      verifyFinding(storyId, retrofittedLegacyFinding),
      false,
      'retrofitting reviewRunId onto a legacy-signed finding must invalidate the signature',
    );
    assert.equal(
      verifyReviewPass(storyId, retrofittedLegacyPass),
      false,
      'retrofitting reviewRunId onto a legacy-signed review pass must invalidate the signature',
    );
    store.writeFindings(storyId, { findings: [retrofittedLegacyFinding] });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'proof-or-stop-review-concept', reviewRound, '047', runIds.get('proof-or-stop-review-concept')!),
        retrofittedLegacyPass,
        makeReviewPass(storyId, 'proof-or-stop-review-test-coverage', reviewRound, '048', runIds.get('proof-or-stop-review-test-coverage')!),
      ],
    });
    const retrofitState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      retrofitState.invalid.some(issue => issue.code === 'invalid_evidence_signature' && issue.agent === 'proof-or-stop-review-quality'),
      true,
      'review-run evidence collection must reject reviewRunId-retrofitted legacy signatures',
    );
    const retrofitFailure = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(retrofitFailure ?? '', /Invalid signature|reviewRunId/, 'review gate must fail retrofitted legacy signatures');
    store.writeFindings(storyId, { findings: [] });

    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'proof-or-stop-review-concept', reviewRound, '050', runIds.get('proof-or-stop-review-concept')!),
        makeLegacyReviewPassWithoutRun(storyId, 'proof-or-stop-review-quality', reviewRound, '051'),
        makeReviewPass(storyId, 'proof-or-stop-review-test-coverage', reviewRound, '052', runIds.get('proof-or-stop-review-test-coverage')!),
      ],
    });
    const missingRun = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(missingRun ?? '', /Missing reviewRunId/, 'current REVIEW evidence without reviewRunId must be rejected');
    const missingRunStatus = summarizeReviewerStatus(store, storyId, root);
    const missingRunByName = new Map(missingRunStatus.entries.map(e => [e.name, e]));
    const qualityStatus = missingRunByName.get('quality');
    assert.equal(qualityStatus?.present, true, 'invalid reviewer evidence should count as present evidence');
    assert.equal(qualityStatus?.verdict, 'fail', 'invalid reviewer evidence must not be shown as pending');
    assert.equal(qualityStatus?.blockerCount, 1, 'invalid reviewer evidence should count as a blocking reviewer issue');
    assert.match(qualityStatus?.detail ?? '', /Missing reviewRunId/);
    assert.equal(missingRunStatus.totalBlockers, 1, 'invalid reviewer evidence should surface in totalBlockers');
    assert.equal(missingRunStatus.allPassed, false);

    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'proof-or-stop-review-concept', reviewRound, '053', runIds.get('proof-or-stop-review-concept')!),
        makeReviewPass(storyId, 'proof-or-stop-review-quality', reviewRound, '054', runIds.get('proof-or-stop-review-concept')!),
        makeReviewPass(storyId, 'proof-or-stop-review-test-coverage', reviewRound, '055', runIds.get('proof-or-stop-review-test-coverage')!),
      ],
    });
    const wrongLane = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(wrongLane ?? '', /lane=proof-or-stop-review-concept/, 'evidence bound to a different reviewer lane must be rejected');

    const runs = store.readReviewRuns(storyId);
    runs.runs[1]._hash = 'tampered-review-run-signature';
    store.writeReviewRuns(storyId, runs);
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'proof-or-stop-review-concept', reviewRound, '056', runIds.get('proof-or-stop-review-concept')!),
        makeReviewPass(storyId, 'proof-or-stop-review-quality', reviewRound, '057', runIds.get('proof-or-stop-review-quality')!),
        makeReviewPass(storyId, 'proof-or-stop-review-test-coverage', reviewRound, '058', runIds.get('proof-or-stop-review-test-coverage')!),
      ],
    });
    const tamperedRun = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(tamperedRun ?? '', /Invalid signature|tampered/, 'tampered review-runs.json signature must be rejected');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertSupersededReviewPassDoesNotBlockLatestReviewerRun(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-review-pass-supersede-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const agents = [
      'proof-or-stop-review-concept',
      'proof-or-stop-review-quality',
      'proof-or-stop-review-test-coverage',
    ];
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, agents);
    const conceptFinding = makeFinding(
      storyId,
      'proof-or-stop-review-concept',
      reviewRound,
      '061',
      runIds.get('proof-or-stop-review-concept')!,
    );
    const qualityFinding = makeFinding(
      storyId,
      'proof-or-stop-review-quality',
      reviewRound,
      '062',
      runIds.get('proof-or-stop-review-quality')!,
    );
    const initialTestCoveragePass = makeReviewPass(
      storyId,
      'proof-or-stop-review-test-coverage',
      reviewRound,
      '063',
      runIds.get('proof-or-stop-review-test-coverage')!,
    );
    store.writeFindings(storyId, { findings: [conceptFinding, qualityFinding] });
    store.writeReviewPasses(storyId, { passes: [initialTestCoveragePass] });

    const lane = 'proof-or-stop-review-test-coverage';
    const context = { store, root, scanRoot: join(root, 'packages/main') };
    withNativeReviewFixtureHostIdentity({ agent: lane, invoke: () => createStoryDispatchHandlers(context).dispatch({ storyId, agentType: lane }) });
    const previousAgent = process.env.PROOF_OR_STOP_AGENT;
    process.env.PROOF_OR_STOP_AGENT = lane;
    try {
      withNativeReviewFixtureHostIdentity({ agent: lane, invoke: () => createReviewRunHandlers(context).review_run_start({ storyId, agent: lane }) });
    } finally {
      if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
      else process.env.PROOF_OR_STOP_AGENT = previousAgent;
    }
    const latestTestCoverageRun = store.readReviewRuns(storyId).runs.at(-1);
    assert.ok(latestTestCoverageRun?.envelopeId, 'latest test-coverage run must bind a Prompt Envelope');
    const latestTestCoverageRunId = latestTestCoverageRun.reviewRunId;
    reviewEnvelopeIds.set(latestTestCoverageRunId, latestTestCoverageRun.envelopeId);
    nativeReviewFixtureContexts.set(`${storyId}\0${lane}\0${latestTestCoverageRunId}`, { root, store });

    store.writeFindings(storyId, {
      findings: [conceptFinding, qualityFinding],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        initialTestCoveragePass,
        makeReviewPass(storyId, 'proof-or-stop-review-test-coverage', reviewRound, '064', latestTestCoverageRunId),
      ],
    });

    const supersededState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      supersededState.invalid.some(issue => issue.kind === 'pass' && issue.code === 'stale_run'),
      false,
      'older review pass should be superseded by a newer valid pass for the same lane',
    );
    assert.equal(getGuardFailureReason(storyId, store, 'TEST', root), null);
    const status = summarizeReviewerStatus(store, storyId, root);
    const byName = new Map(status.entries.map(e => [e.name, e]));
    assert.equal(byName.get('test-coverage')?.verdict, 'pass');
    assert.equal(status.totalBlockers, 0);

    const staleFinding = {
      ...makeFinding(storyId, 'proof-or-stop-review-test-coverage', reviewRound, '065', runIds.get('proof-or-stop-review-test-coverage')!),
      status: 'open' as const,
    };
    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'proof-or-stop-review-concept', reviewRound, '066', runIds.get('proof-or-stop-review-concept')!),
        makeFinding(storyId, 'proof-or-stop-review-quality', reviewRound, '067', runIds.get('proof-or-stop-review-quality')!),
        staleFinding,
      ],
    });
    const staleFindingState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      staleFindingState.invalid.some(issue => issue.kind === 'finding' && issue.code === 'stale_run'),
      true,
      'older stale findings must not be hidden by a newer pass for the same lane',
    );
    assert.match(
      getGuardFailureReason(storyId, store, 'TEST', root) ?? '',
      /Not the latest run on the current lane/,
      'supersede logic applies only to stale passes, not stale findings',
    );

    const resolvedStaleFinding = {
      ...staleFinding,
      status: 'resolved' as const,
      resolvedReason: 'fixed and rechecked by latest reviewer run',
      resolvedAt: '2026-04-27T11:04:00.000Z',
    };
    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'proof-or-stop-review-concept', reviewRound, '068', runIds.get('proof-or-stop-review-concept')!),
        makeFinding(storyId, 'proof-or-stop-review-quality', reviewRound, '069', runIds.get('proof-or-stop-review-quality')!),
        resolvedStaleFinding,
      ],
    });
    const resolvedStaleFindingState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      resolvedStaleFindingState.invalid.some(issue => issue.kind === 'finding' && issue.code === 'stale_run'),
      false,
      'resolved stale findings should be superseded by a newer valid pass for the same lane',
    );
    assert.equal(getGuardFailureReason(storyId, store, 'TEST', root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertResolvedFindingStaleBindingIsForgivenWithoutValidLaneEvidence(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-f019-terminal-forgive-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const agents = [
      'proof-or-stop-review-concept',
      'proof-or-stop-review-quality',
      'proof-or-stop-review-test-coverage',
    ];
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, agents);

    // Stale the ENTIRE test-coverage lane with a SUPERSEDED_PASS_ISSUE_CODES-class
    // binding issue, using the same mechanism as the adjacent supersede test: mint
    // a NEWER signed run on the lane so every record still bound to the older run
    // is non-latest (`stale_run`). Signatures stay valid throughout — this is a
    // binding-freshness issue, exactly like the real B-cdf6 envelope-recomputation
    // drift, not a forgery. (A materialHash mutation cannot be used here: the
    // fixture root is not a git repo, so checkEvidenceFreshnessForGit
    // short-circuits to fresh when git HEAD is unavailable.)
    //
    // Both the resolved finding AND the lane's pass stay bound to the OLD run, so
    // the lane ends up with NO valid evidence — the precondition that used to
    // withhold forgiveness.
    const laneAgent = 'proof-or-stop-review-test-coverage';
    const context = { store, root, scanRoot: join(root, 'packages/main') };
    withNativeReviewFixtureHostIdentity({ agent: laneAgent, invoke: () => createStoryDispatchHandlers(context).dispatch({ storyId, agentType: laneAgent }) });
    const previousAgent = process.env.PROOF_OR_STOP_AGENT;
    process.env.PROOF_OR_STOP_AGENT = laneAgent;
    try {
      withNativeReviewFixtureHostIdentity({ agent: laneAgent, invoke: () => createReviewRunHandlers(context).review_run_start({ storyId, agent: laneAgent }) });
    } finally {
      if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
      else process.env.PROOF_OR_STOP_AGENT = previousAgent;
    }

    const laneRunId = runIds.get(laneAgent)!;
    const resolvedFinding: Finding = {
      ...makeFinding(storyId, laneAgent, reviewRound, '120', laneRunId),
      status: 'resolved',
      resolvedReason: 'defect fixed; the recorded defect no longer exists',
      resolvedAt: '2026-04-27T12:30:00.000Z',
    };
    const openFinding: Finding = {
      ...makeFinding(storyId, laneAgent, reviewRound, '121', laneRunId),
      status: 'open',
    };
    // The lane's pass carries a SUPERSEDED_PASS_ISSUE_CODES-class defect too
    // (`prompt_envelope_mismatch`: an envelopeId that is not its run's signed
    // binding) — the same code class as the real B-cdf6 failure. A non-latest-run
    // pass alone would NOT do: that rejection is deliberately relaxed for passes
    // (review-run-binding-race friction #2), so this uses a cause that genuinely
    // invalidates a pass, proving forgiveness is not extended to passes.
    const lanePass = {
      ...makeReviewPass(storyId, laneAgent, reviewRound, '122', laneRunId),
      envelopeId: 'envelope-that-is-not-the-signed-run-binding',
    };

    // 1. RESOLVED finding on a fully stale lane (NO valid evidence for that lane).
    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'proof-or-stop-review-concept', reviewRound, '123', runIds.get('proof-or-stop-review-concept')!),
        makeFinding(storyId, 'proof-or-stop-review-quality', reviewRound, '124', runIds.get('proof-or-stop-review-quality')!),
        resolvedFinding,
      ],
    });
    store.writeReviewPasses(storyId, { passes: [lanePass] });

    const forgivenState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      forgivenState.valid.some(record => record.agent === laneAgent),
      false,
      'F-019 precondition: the whole test-coverage lane must have NO valid evidence (this is what used to withhold forgiveness)',
    );
    assert.equal(
      forgivenState.invalid.some(issue => issue.kind === 'finding' && issue.evidenceId === resolvedFinding.id),
      false,
      'F-019: a RESOLVED finding with a stale binding must be forgiven even when its lane holds no currently-valid evidence',
    );

    // 2. A PASS with the same stale binding must STILL block — a pass is an
    // affirmative claim about current material, so it must be re-earned.
    assert.equal(
      forgivenState.invalid.some(issue => issue.kind === 'pass' && issue.evidenceId === lanePass.id),
      true,
      'F-019 must NOT extend forgiveness to a stale-bound review pass',
    );

    // 3. An OPEN finding with the same stale binding must STILL block — that is
    // the case where staleness could genuinely mislead.
    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'proof-or-stop-review-concept', reviewRound, '125', runIds.get('proof-or-stop-review-concept')!),
        makeFinding(storyId, 'proof-or-stop-review-quality', reviewRound, '126', runIds.get('proof-or-stop-review-quality')!),
        resolvedFinding,
        openFinding,
      ],
    });
    const openState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      openState.invalid.some(issue => issue.kind === 'finding' && issue.evidenceId === openFinding.id),
      true,
      'F-019 must NOT forgive an OPEN finding with a stale binding',
    );
    assert.equal(
      openState.invalid.some(issue => issue.kind === 'finding' && issue.evidenceId === resolvedFinding.id),
      false,
      'F-019: the resolved finding stays forgiven alongside a blocking open finding',
    );
    assert.ok(
      getGuardFailureReason(storyId, store, 'TEST', root),
      'F-019: the REVIEW gate must still fail closed while the stale open finding / pass are unresolved',
    );

    // 4. Handler 编码约定 — a payload that bypasses Zod must still be rejected.
    // A finding carrying a non-canonical / injected "terminal-looking" status
    // must NOT earn forgiveness; only the explicit allowlist counts.
    for (const bypassStatus of ['RESOLVED', 'resolved ', 'closed', 'fixed', 'suspected', 'disproven', '', undefined]) {
      assert.equal(
        isTerminalReviewerFindingStatus(bypassStatus),
        false,
        `F-019 allowlist must reject non-canonical status ${JSON.stringify(bypassStatus)}`,
      );
    }
    assert.equal(isTerminalReviewerFindingStatus('resolved'), true, 'resolved must be terminal');
    assert.equal(isTerminalReviewerFindingStatus('dismissed'), true, 'dismissed must be terminal');

    const injectedFinding = {
      ...makeFinding(storyId, laneAgent, reviewRound, '127', laneRunId),
      status: 'closed' as unknown as Finding['status'],
    } as Finding;
    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'proof-or-stop-review-concept', reviewRound, '128', runIds.get('proof-or-stop-review-concept')!),
        makeFinding(storyId, 'proof-or-stop-review-quality', reviewRound, '129', runIds.get('proof-or-stop-review-quality')!),
        injectedFinding,
      ],
    });
    const injectedState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      injectedState.invalid.some(issue => issue.kind === 'finding' && issue.evidenceId === injectedFinding.id),
      true,
      'F-019: a bypassing finding with an injected non-allowlisted status must still be rejected',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

export function assertReviewRunBindingRaceAcceptsNonLatestFreshPass(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-review-run-binding-race-'));
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
      nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() },
    }));
    write(root, 'packages/main/src/base.ts', 'export const base = 1;\n');
    git(root, ['init']);
    git(root, ['config', 'user.email', 'flow@example.invalid']);
    git(root, ['config', 'user.name', 'Flow Stability Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-B', 'story/B-smoke']);
    write(root, 'packages/main/src/story.ts', 'export const story = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'story change']);
    resetConfigCache();

    const storyId = 'B-smoke';
    const agent = 'proof-or-stop-review-concept';
    const now = '2026-06-24T12:00:00.000Z';
    const reviewRound = '2026-06-24T12:01:00.000Z';
    const story: StoryInfo = {
      storyId,
      name: 'flow-stability-smoke',
      title: 'Flow stability smoke',
      description: 'Synthetic story for the review-run binding race.',
      type: 'chore',
      phase: 'REVIEW',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      currentReviewRound: reviewRound,
      events: [{ phase: 'REVIEW', action: 'advance', timestamp: reviewRound }],
    };
    const checklist: ChecklistData = {
      items: [{ id: 'CHK-001', title: 'item', context: 'ctx', status: 'done', startTime: now, endTime: now, verificationIntent: { happy: [{ desc: 'A fresh pass on an older current-round run remains valid while stale findings remain blocked.', type: 'manual' }], edge: [], adversarial: [] } }],
    };
    const store = new StoryStore(root);
    store.writeStory(storyId, story);
    store.writeChecklist(storyId, checklist);

    // Two production review runs on ONE lane, SAME round + SAME material tree:
    // run1 (older) then run2 (newer). This is the concurrent/retried
    // review_run_start race, with current Prompt Envelopes rather than a
    // caller-authored legacy signature.
    const context = { store, root, scanRoot: join(root, 'packages/main') };
    const dispatchHandlers = createStoryDispatchHandlers(context);
    const reviewRunHandlers = createReviewRunHandlers(context);
    const startRun = (): ReviewRun => {
      withNativeReviewFixtureHostIdentity({ agent: agent, invoke: () => dispatchHandlers.dispatch({ storyId, agentType: agent }) });
      const previousAgent = process.env.PROOF_OR_STOP_AGENT;
      const previousCwd = process.cwd();
      process.env.PROOF_OR_STOP_AGENT = agent;
      process.chdir(root);
      try {
        withNativeReviewFixtureHostIdentity({ agent: agent, invoke: () => reviewRunHandlers.review_run_start({ storyId, agent }) });
      } finally {
        process.chdir(previousCwd);
        if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
        else process.env.PROOF_OR_STOP_AGENT = previousAgent;
      }
      return store.readReviewRuns(storyId).runs.at(-1)!;
    };
    const run1 = startRun();
    const run2 = startRun();
    const run1Id = run1.reviewRunId;
    assert.notEqual(run1.storyFilesHash, EMPTY_STORY_FILES_HASH, 'story-branch run must carry a non-empty storyFilesHash');
    assert.ok(run1.storyFilesHash, 'story-branch run must carry a storyFilesHash');
    assert.notEqual(run1.reviewRunId, run2.reviewRunId, 'retry should mint a distinct current ReviewRun');
    reviewEnvelopeIds.set(run1.reviewRunId, run1.envelopeId!);
    reviewEnvelopeIds.set(run2.reviewRunId, run2.envelopeId!);
    for (const run of [run1,run2]) nativeReviewFixtureContexts.set(`${storyId}\0${run.agent}\0${run.reviewRunId}`, { root, store });

    // CORE: a PASS bound to the NON-latest run1 (material+scope fresh) is ACCEPTED.
    // Pre-fix this threw "is not the current latest reviewer run".
    const accepted = assertCurrentReviewRunForEvidence(store, story, root, agent, run1Id);
    assert.equal(accepted.reviewRunId, run1Id, 'non-latest material-fresh run must be accepted by assertCurrentReviewRunForEvidence');

    // And collectReviewerEvidenceState must NOT flag that pass as an invalid stale_run.
    store.writeReviewPasses(storyId, {
      passes: [makeReviewPass(storyId, agent, reviewRound, '063', run1Id)],
    });
    const passState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      passState.invalid.some(issue => issue.kind === 'pass' && issue.code === 'stale_run' && issue.agent === agent),
      false,
      'a material-fresh pass bound to a non-latest run must not be an invalid stale_run',
    );

    // KIND-AWARE: an OPEN finding bound to the non-latest run1 STILL surfaces as stale_run
    // (it is not silently relaxed by the pass relax — open findings must keep blocking).
    const openFinding = {
      ...makeFinding(storyId, agent, reviewRound, '064', run1Id),
      status: 'open' as const,
    };
    store.writeFindings(storyId, { findings: [openFinding] });
    const findingState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      findingState.invalid.some(issue => issue.kind === 'finding' && issue.code === 'stale_run' && issue.agent === agent),
      true,
      'kind-aware relax must keep stale_run for an OPEN finding bound to a non-latest run',
    );
    assert.match(
      getGuardFailureReason(storyId, store, 'TEST', root) ?? '',
      /Not the latest run on the current lane|stale_run/,
      'open finding still blocks the gate even though the pass is accepted',
    );
    store.writeFindings(storyId, { findings: [] });

    // GUARD B: an empty-set storyFilesHash on a drifted material tree must still
    // hard-reject at the shared freshness layer; current ReviewRuns cannot be
    // caller-authored with a contradictory Prompt Envelope.
    const emptyHead = currentGitHead(root)!;
    const emptyMaterial = currentMaterialHash(root)!;

    // GUARD A: genuine material drift makes both run1 (real story diff) AND the
    // empty-signal run3 stale → hard-reject, never advisory. Committing the story
    // metadata + drift onto the current story branch keeps store.readStory usable
    // (no branch switch, so the story files never leave the working tree).
    write(root, 'packages/main/src/story.ts', 'export const story = 2; // drift\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'material drift']);
    const story2 = store.readStory(storyId);
    assert.throws(
      () => assertCurrentReviewRunForEvidence(store, story2, root, agent, run1Id),
      /stale/i,
      'a genuinely material-drifted run1 (non-empty storyFilesHash) must still hard-reject',
    );
    assert.equal(
      checkEvidenceFreshnessForGit(root, emptyHead, emptyMaterial, root, EMPTY_STORY_FILES_HASH).fresh,
      false,
      'an empty-set storyFilesHash must not downgrade stale material into an advisory',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertReviewRunStoryFilesHashBindingIsSigned(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-review-run-story-files-hash-'));
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    write(root, 'packages/main/src/base.ts', 'export const base = 1;\n');
    git(root, ['init']);
    git(root, ['config', 'user.email', 'flow@example.invalid']);
    git(root, ['config', 'user.name', 'Flow Stability Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-B', 'story/B-smoke']);
    write(root, 'packages/main/src/story.ts', 'export const story = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'story change']);

    const storyId = 'B-smoke';
    const reviewRunId = `${storyId}:RR-001`;
    const agent = 'proof-or-stop-review-quality';
    const reviewRound = '2026-06-19T12:00:00.000Z';
    const startedAt = '2026-06-19T12:01:00.000Z';
    const headHash = currentGitHead(root)!;
    const materialHash = currentMaterialHash(root)!;
    const storyFilesHash = currentStoryFilesHash(root)!;
    const workspaceBinding = buildReviewRunWorkspaceBinding({
      metadataRoot: root,
      invocationCwd: root,
      repoRoot: root,
      signedWorkspaceRoot: root,
      workspaceMode: 'metadata-git-root',
      headHash,
      materialHash,
    });
    assert.equal(workspaceBinding.storyFilesHash, storyFilesHash, 'workspace binding must capture storyFilesHash when computable');
    const promptBinding = currentPromptEnvelopeBinding(agent, createHash('sha256').update(reviewRunId).digest('hex'));

    const run: ReviewRun = {
      reviewRunId,
      storyId,
      agent,
      lane: agent,
      reviewRound,
      startedAt,
      headHash,
      materialHash,
      ...promptBinding,
      workspaceBinding,
      _hash: signReviewRun(
        storyId,
        reviewRunId,
        agent,
        agent,
        reviewRound,
        startedAt,
        headHash,
        materialHash,
        promptBinding.promptHash,
        undefined,
        workspaceBinding.bindingHash,
        undefined,
        promptBinding.envelopeId,
      ),
    };
    assert.equal(verifyReviewRun(run), true, 'review run with storyFilesHash workspace binding must verify');

    const tampered: ReviewRun = {
      ...run,
      workspaceBinding: {
        ...workspaceBinding,
        storyFilesHash: '0'.repeat(64),
      },
    };
    assert.equal(verifyReviewRun(tampered), false, 'tampering storyFilesHash must invalidate the signed workspace binding');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertVerificationEvidenceStoryFilesHashDowngradesUnrelatedDrift(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-verification-story-files-hash-'));
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    write(root, 'packages/main/src/base.ts', 'export const base = 1;\n');
    git(root, ['init']);
    git(root, ['config', 'user.email', 'flow@example.invalid']);
    git(root, ['config', 'user.name', 'Flow Stability Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-B', 'story/B-smoke']);
    write(root, 'packages/main/src/story.ts', 'export const story = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'story file']);

    const recordedHead = currentGitHead(root)!;
    const recordedMaterial = currentMaterialHash(root)!;
    const recordedStoryFiles = currentStoryFilesHash(root)!;

    git(root, ['checkout', 'main']);
    write(root, 'packages/main/src/unrelated.ts', 'export const unrelated = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'unrelated main file']);
    git(root, ['checkout', 'story/B-smoke']);
    git(root, ['merge', 'main', '--no-edit']);

    const storyId = 'B-smoke';
    const checklist: ChecklistData = {
      items: [{
        id: 'CHK-001',
        title: 'Verify story behavior',
        status: 'done',
        startTime: '2026-06-19T12:00:00.000Z',
        endTime: '2026-06-19T12:01:00.000Z',
        verificationIntent: {
          happy: [{ desc: 'story works', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
        verificationEvidence: [{
          // B-3b88: command-less attestation on purpose — this block asserts the
          // storyFilesHash downgrade semantics and that refresh re-stamps the row.
          // A command-backed result:pass is now refused by refresh (never
          // re-certified without re-execution), which is covered by
          // refresh-stale-honesty-smoke.
          intentRef: 'CHK-001:happy:0',
          kind: 'manual_transcript',
          result: 'pass',
          note: 'synthetic attestation evidence',
          headHash: recordedHead,
          materialHash: recordedMaterial,
          storyFilesHash: recordedStoryFiles,
        }],
      }],
    };

    const coverage = buildVerificationCoverage(
      checklist,
      currentGitHead(root),
      (headHash, evidence) => checkEvidenceFreshnessForGit(root, headHash, evidence?.materialHash, root, evidence?.storyFilesHash).fresh,
      { deferredGateEvidence: 'missing' },
    );
    assert.equal(coverage.entries[0]?.status, 'covered', 'matching storyFilesHash must prevent unrelated material drift from marking evidence stale');
    const store = new StoryStore(root);
    store.writeChecklist(storyId, checklist);
    assert.deepEqual(findStaleEvidence(root, storyId), [], 'session stale hint must also honor matching storyFilesHash');
    const freshness = checkEvidenceFreshnessForGit(root, recordedHead, recordedMaterial, root, recordedStoryFiles);
    assert.equal(freshness.fresh, true);
    assert.equal(freshness.warnings?.some(line => line.includes('re-attestation')), true, 'downgraded material drift must expose a re-attestation warning');

    write(root, 'packages/main/src/story.ts', 'export const story = 2;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'story file changed']);
    const staleCoverage = buildVerificationCoverage(
      checklist,
      currentGitHead(root),
      (headHash, evidence) => checkEvidenceFreshnessForGit(root, headHash, evidence?.materialHash, root, evidence?.storyFilesHash).fresh,
      { deferredGateEvidence: 'missing' },
    );
    assert.equal(staleCoverage.entries[0]?.status, 'stale', 'story-owned file changes must still stale verification evidence');

    // B-1507 CHK-002: metadata-only writer (this non-pinned row exercises the same
    // freshness re-stamp path the re-executing CLI handler falls back to).
    const refreshResult = refreshStaleEvidenceMetadataOnly({ store, root, scanRoot: root }, storyId);
    assert.match(refreshResult, /Refreshed 1\/1 stale evidence/, 'refresh helper should refresh the stale story-owned evidence');
    const refreshed = store.readChecklist(storyId).items[0]?.verificationEvidence?.[0];
    assert.equal(refreshed?.storyFilesHash, currentStoryFilesHash(root), 'refresh helper must preserve the current storyFilesHash binding');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertTestEvidenceStoryFilesHashDowngradesActiveDoneFreshness(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-test-evidence-story-files-hash-'));
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    write(root, 'packages/main/src/base.ts', 'export const base = 1;\n');
    git(root, ['init']);
    git(root, ['config', 'user.email', 'flow@example.invalid']);
    git(root, ['config', 'user.name', 'Flow Stability Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-B', 'story/B-smoke']);
    write(root, 'packages/main/src/story.ts', 'export const story = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'story file']);

    const recordedHead = currentGitHead(root)!;
    const recordedMaterial = currentMaterialHash(root)!;
    const recordedStoryFiles = currentStoryFilesHash(root)!;

    git(root, ['checkout', 'main']);
    write(root, 'packages/main/src/unrelated.ts', 'export const unrelated = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'unrelated main file']);
    git(root, ['checkout', 'story/B-smoke']);
    git(root, ['merge', 'main', '--no-edit']);

    const store = new StoryStore(root);
    const storyId = 'B-smoke';
    const now = '2026-06-19T12:00:00.000Z';
    store.writeStory(storyId, {
      storyId,
      name: 'test-evidence-story-files-hash',
      title: 'Test evidence storyFilesHash smoke',
      description: 'Synthetic story for active DONE evidence freshness.',
      type: 'chore',
      phase: 'TEST',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [],
    });
    store.writeChecklist(storyId, { items: [] });

    const baseEvidence: TestEvidenceData = {
      command: 'proof-or-stop validate --json',
      output: JSON.stringify({ allPass: true }),
      result: 'PASS',
      timestamp: now,
      headHash: recordedHead,
      materialHash: recordedMaterial,
    };
    store.writeTestEvidence(storyId, baseEvidence);
    let rows = buildDoneChecklist(storyId, store, root);
    let byId = new Map(rows.map(row => [row.id, row]));
    assert.equal(byId.get('evidence-freshness')?.status, 'fail', 'legacy test-evidence without storyFilesHash must remain strict');
    assert.match(byId.get('evidence-freshness')?.detail ?? '', /materialHash does not match/);

    store.writeTestEvidence(storyId, { ...baseEvidence, storyFilesHash: recordedStoryFiles });
    rows = buildDoneChecklist(storyId, store, root);
    byId = new Map(rows.map(row => [row.id, row]));
    assert.equal(byId.get('evidence-freshness')?.status, 'pass', 'matching storyFilesHash must downgrade unrelated active DONE material drift');
    assert.match(byId.get('evidence-freshness')?.detail ?? '', /re-attestation advisory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

export function assertReviewPreflightDoesNotDowngradePromptEnvelopeDriftToStoryHashAdvisory(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-review-preflight-story-files-hash-'));
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
      nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() },
    }));
    write(root, 'packages/main/src/base.ts', 'export const base = 1;\n');
    git(root, ['init']);
    git(root, ['config', 'user.email', 'flow@example.invalid']);
    git(root, ['config', 'user.name', 'Flow Stability Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-B', 'story/B-smoke']);
    write(root, 'packages/main/src/story.ts', 'export const story = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'story file']);

    const storyId = 'B-smoke';
    const reviewRound = '2026-06-19T12:00:00.000Z';
    const agent = 'proof-or-stop-review-quality';

    git(root, ['checkout', 'main']);
    write(root, 'packages/main/src/unrelated.ts', 'export const unrelated = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'unrelated main file']);
    git(root, ['checkout', 'story/B-smoke']);

    const store = new StoryStore(root);
    store.writeStory(storyId, {
      storyId,
      name: 'review-preflight-story-files-hash',
      title: 'Review preflight storyFilesHash smoke',
      description: 'Synthetic story for REVIEW preflight advisory coverage.',
      type: 'chore',
      phase: 'REVIEW',
      priority: 'medium',
      createdAt: reviewRound,
      startedAt: reviewRound,
      endedAt: null,
      currentReviewRound: reviewRound,
      events: [{ phase: 'REVIEW', action: 'advance', timestamp: reviewRound }],
    });
    store.writeChecklist(storyId, {
      items: ['001', '002', '003'].map(suffix => ({
        id: `CHK-${suffix}`,
        title: `Reviewer drift item ${suffix}`,
        context: 'Keep reviewer freshness visible to the normal preflight path.',
        status: 'done',
        startTime: reviewRound,
        endTime: reviewRound,
      })),
    });
    resetConfigCache();
    const context = { store, root, scanRoot: join(root, 'packages/main') };
    withNativeReviewFixtureHostIdentity({ agent: agent, invoke: () => createStoryDispatchHandlers(context).dispatch({ storyId, agentType: agent }) });
    const previousAgent = process.env.PROOF_OR_STOP_AGENT;
    const previousCwd = process.cwd();
    process.env.PROOF_OR_STOP_AGENT = agent;
    process.chdir(root);
    try {
      withNativeReviewFixtureHostIdentity({ agent: agent, invoke: () => createReviewRunHandlers(context).review_run_start({ storyId, agent }) });
    } finally {
      process.chdir(previousCwd);
      if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
      else process.env.PROOF_OR_STOP_AGENT = previousAgent;
    }
    const run = store.readReviewRuns(storyId).runs.at(-1);
    assert.ok(run?.envelopeId, 'production review run should bind the current Prompt Envelope');
    reviewEnvelopeIds.set(run.reviewRunId, run.envelopeId);
    nativeReviewFixtureContexts.set(`${storyId}\0${agent}\0${run.reviewRunId}`, { root, store });
    store.writeReviewPasses(storyId, {
      passes: [makeReviewPass(storyId, agent, reviewRound, '099', run.reviewRunId)],
    });
    git(root, ['merge', 'main', '--no-edit']);
    const beforeEnvelopeDrift = runReviewCliGates(storyId, { store, projectRoot: root, registryNames: new Set() });
    assert.equal(beforeEnvelopeDrift.ok, true, 'unrelated main merge remains admissible before actual envelope drift');
    assert.equal(beforeEnvelopeDrift.gates.find(gate => gate.name === 'reviewer-evidence')?.status, 'warn', 'unrelated main merge has its material advisory positive control');
    // Unrelated main material is legitimately advisory; create the actual envelope
    // corruption this negative control names, without changing its expected rejection.
    const driftedEnvelopes = store.readPromptEnvelopes(storyId);
    const driftedEnvelope = driftedEnvelopes.envelopes.find(row => row.envelopeId === run.envelopeId)!;
    driftedEnvelope.assembledPromptDigest = '0'.repeat(64);
    store.writePromptEnvelopes(storyId, driftedEnvelopes);


    const preflight = runReviewCliGates(storyId, {
      store,
      projectRoot: root,
      registryNames: new Set(),
    });
    assert.equal(preflight.ok, true, 'express preflight should remain non-blocking');
    const advisoryGate = preflight.gates.find(gate => gate.name === 'reviewer-evidence');
    assert.equal(advisoryGate, undefined, 'Prompt Envelope drift must not be mislabeled as unrelated material drift');
    const evidenceState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      evidenceState.invalid.some(issue => issue.code === 'prompt_envelope_tampered' || issue.code === 'prompt_envelope_mismatch'),
      true,
      'main drift that invalidates the current Prompt Envelope must require reviewer re-attestation',
    );
    const rendered = renderPreflight(preflight);
    assert.doesNotMatch(rendered, /reviewer-evidence freshness: warn/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

export function assertLegacyReviewEvidenceWithoutCurrentRoundStaysReadable(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-legacy-review-evidence-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const story = store.readStory(storyId);
    delete story.currentReviewRound;
    store.writeStory(storyId, story);
    store.writeReviewPasses(storyId, {
      passes: [makeLegacyReviewPassWithoutRun(storyId, 'proof-or-stop-review-quality', reviewRound, '060')],
    });

    const evidenceState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(evidenceState.invalid.length, 0, 'legacy story without currentReviewRound should not require reviewRunId');
    assert.equal(evidenceState.valid.length, 1, 'legacy signed review pass should remain readable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
