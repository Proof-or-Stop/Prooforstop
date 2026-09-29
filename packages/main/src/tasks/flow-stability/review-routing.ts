import { runImplementationWorkerAuthorityGate } from '../../handlers/phase-gates.js';
import { createStoryDispatchHandlers } from '../../handlers/story-dispatch.js';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetConfigCache } from '../../core/config.js';

import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../../core/evidence-freshness.js';

import { signFinding } from '../../core/finding-verify.js';

import { getArtifactContractStatus } from '../../core/artifact-contract.js';

import { getGuardFailureReason } from '../../core/machine.js';
import { getGuardFailureReason as legacyGetGuardFailureReason } from '../../core/guard-utils.js';

import { collectReviewerEvidenceState } from '../../core/review-run.js';

import { summarizeReviewerStatus } from '../../core/reviewer-status.js';

import type { Finding, StoryInfo, TestEvidenceData } from '../../core/types.js';

import { createStoryAdvanceHandlers } from '../../handlers/story-advance.js';
import { createProofStoryHandlers } from '../../handlers/proofstory.js';
import { signScopeCheck } from '../../handlers/scope-check.js';

import { decorateResult } from '../../handlers/hints.js';
import { createSessionHandlers } from '../../handlers/session.js';

import { checkCommitAuthor } from '../../handlers/validate-channel.js';

import { deriveAcceptanceCoverageBasis } from '../../core/acceptance-coverage-basis.js';

import { createReviewStore, seedReviewRuns, makeReviewPass, makeLegacyFindingWithoutRun, makeFinding, write, writeAcceptanceBasisDiscoveryFixture, git, localCliPath } from './support.js';
import { renderedDetails } from './done-reporting.js';

export function assertNonReviewerFindingsDoNotCountAsReviewerEvidence(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-non-reviewer-evidence-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, [
      'proof-or-stop-review-concept',
      'proof-or-stop-review-quality',
      'proof-or-stop-review-test-coverage',
    ]);

    const nonReviewerAgents = ['main', 'main-agent', 'proof-or-stop-implementer'];
    const nonReviewerFindings = nonReviewerAgents.map((agent, idx) => {
      const id = `${storyId}:F-${String(900 + idx).padStart(3, '0')}`;
      const createdAt = `2026-04-27T13:00:${String(idx).padStart(2, '0')}.000Z`;
      const desc = `${agent} DEV-phase note without reviewRunId`;
      const severity = 'high';
      return {
        id,
        desc,
        severity: severity as Finding['severity'],
        category: 'missing' as Finding['category'],
        status: 'resolved' as Finding['status'],
        agent,
        createdAt,
        reviewRound,
        _hash: signFinding(storyId, id, desc, severity, createdAt, reviewRound),
      };
    });
    store.writeFindings(storyId, { findings: nonReviewerFindings });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'proof-or-stop-review-concept', reviewRound, '901', runIds.get('proof-or-stop-review-concept')!),
        makeReviewPass(storyId, 'proof-or-stop-review-quality', reviewRound, '902', runIds.get('proof-or-stop-review-quality')!),
        makeReviewPass(storyId, 'proof-or-stop-review-test-coverage', reviewRound, '903', runIds.get('proof-or-stop-review-test-coverage')!),
      ],
    });

    const state = collectReviewerEvidenceState(store, storyId, root);
    for (const agent of nonReviewerAgents) {
      assert.equal(
        state.invalid.some(issue => issue.agent === agent),
        false,
        `non-reviewer agent ${agent} must not appear in reviewer evidence issues (was treated as reviewer)`,
      );
      assert.equal(
        state.valid.some(record => record.agent === agent),
        false,
        `non-reviewer agent ${agent} must not appear in valid reviewer evidence`,
      );
    }
    assert.equal(
      state.invalid.length,
      0,
      `clean reviewer passes + non-reviewer findings should produce no invalid issues, got: ${JSON.stringify(state.invalid)}`,
    );
    assert.equal(
      getGuardFailureReason(storyId, store, 'TEST', root),
      null,
      'REVIEW→TEST gate must pass when only reviewer passes are bound and non-reviewer findings exist',
    );

    // Negative arm: a real proof-or-stop-review-* finding without reviewRunId in the
    // current round must STILL be rejected — proves the fix narrowed the
    // classifier but did not weaken the reviewRunId requirement for real lanes.
    const reviewerFindingWithoutRun = makeLegacyFindingWithoutRun(
      storyId,
      'proof-or-stop-review-quality',
      reviewRound,
      '910',
    );
    store.writeFindings(storyId, {
      findings: [...nonReviewerFindings, reviewerFindingWithoutRun],
    });
    const stateWithReviewerMiss = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      stateWithReviewerMiss.invalid.some(issue =>
        issue.agent === 'proof-or-stop-review-quality' && issue.code === 'missing_review_run_id',
      ),
      true,
      'a real proof-or-stop-review-* finding without reviewRunId must still raise missing_review_run_id',
    );
    assert.equal(
      stateWithReviewerMiss.invalid.some(issue => issue.agent === 'main-agent'),
      false,
      'main-agent findings must remain excluded even when a reviewer evidence issue is also present',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertStoryAdvanceGuardIgnoresMainAgentDevFindings(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-dev-finding-gate-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, [
      'proof-or-stop-review-concept',
      'proof-or-stop-review-quality',
      'proof-or-stop-review-test-coverage',
    ]);

    // Mirror live B-ad2c F-001 shape: main-agent authored, status=resolved,
    // high severity, EMPTY reviewRound, no reviewRunId. Signed via the same
    // legacy path that finding_add takes when the story has no currentReviewRound.
    const devFindingId = `${storyId}:F-001`;
    const devCreatedAt = '2026-04-27T13:30:00.000Z';
    const devDesc = 'main-agent DEV-phase replan note (mirrors B-ad2c F-001)';
    const devFinding: Finding = {
      id: devFindingId,
      desc: devDesc,
      severity: 'high',
      category: 'missing',
      status: 'resolved',
      agent: 'main-agent',
      createdAt: devCreatedAt,
      reviewRound: '',
      _hash: signFinding(storyId, devFindingId, devDesc, 'high', devCreatedAt, ''),
    };
    // One bound reviewer finding per opt-in lane — covers the legacy
    // guard-utils.ts gate (which reads findings only, not review passes).
    const reviewerFindings: Finding[] = [
      makeFinding(storyId, 'proof-or-stop-review-concept', reviewRound, '821', runIds.get('proof-or-stop-review-concept')!),
      makeFinding(storyId, 'proof-or-stop-review-quality', reviewRound, '822', runIds.get('proof-or-stop-review-quality')!),
      makeFinding(storyId, 'proof-or-stop-review-test-coverage', reviewRound, '823', runIds.get('proof-or-stop-review-test-coverage')!),
    ];
    store.writeFindings(storyId, { findings: [devFinding, ...reviewerFindings] });
    // Add review passes too — covers machine.ts canPassReview's quorum check
    // which reads valid evidence (findings ∪ passes) from collectReviewerEvidenceState.
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'proof-or-stop-review-concept', reviewRound, '801', runIds.get('proof-or-stop-review-concept')!),
        makeReviewPass(storyId, 'proof-or-stop-review-quality', reviewRound, '802', runIds.get('proof-or-stop-review-quality')!),
        makeReviewPass(storyId, 'proof-or-stop-review-test-coverage', reviewRound, '803', runIds.get('proof-or-stop-review-test-coverage')!),
      ],
    });

    // Live story_advance guard path (machine.ts) — what `proof-or-stop story_advance
    // --phase=TEST` actually calls — must let the transition through.
    assert.equal(
      getGuardFailureReason(storyId, store, 'TEST', root),
      null,
      'machine.ts guard must ignore a main-agent DEV finding with empty reviewRound when reviewer lanes are covered',
    );
    // Legacy guard-utils.ts mirror — no source import today, but it exports
    // the same `getGuardFailureReason` shape and must stay in sync so future
    // code that wires it back in inherits the same isReviewerAgent
    // classification. Without the F-005 fix this returned a "Cannot enter
    // TEST" reason because main-agent F-001 was misclassified as a reviewer
    // finding that lacked a current-round reviewRound.
    assert.equal(
      legacyGetGuardFailureReason(storyId, store, 'TEST', root),
      null,
      'guard-utils.ts mirror must ignore a main-agent DEV finding with empty reviewRound when reviewer lanes are covered',
    );

    // Negative arm: a real proof-or-stop-review-* finding in the current round with
    // no reviewRunId must still block the live path — the narrowing only
    // changed agent classification, not the reviewRunId binding contract for
    // real reviewer lanes.
    const reviewerMiss = makeLegacyFindingWithoutRun(
      storyId,
      'proof-or-stop-review-quality',
      reviewRound,
      '811',
    );
    store.writeFindings(storyId, { findings: [devFinding, ...reviewerFindings, reviewerMiss] });
    const liveBlocked = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.ok(
      liveBlocked && /Cannot enter TEST/.test(liveBlocked),
      `machine.ts guard must still block when a real proof-or-stop-review-* finding lacks reviewRunId, got: ${liveBlocked}`,
    );
    assert.ok(
      liveBlocked && /missing_review_run_id|reviewer evidence/.test(liveBlocked),
      `machine.ts block reason should reference the reviewRunId binding, got: ${liveBlocked}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function assertStoryAdvanceReviewEchoOmitsRetiredChannel(basisOnly = false): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-review-echo-'));
  const oldCwd = process.cwd();
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    write(root, 'packages/main/tsconfig.json', '{}\n');
    writeAcceptanceBasisDiscoveryFixture(root);
    const story = store.readStory(storyId);
    story.phase = 'DEV';
    story.currentReviewRound = undefined;
    story.events = [{ phase: 'DEV', action: 'advance', timestamp: '2026-04-27T12:02:00.000Z' }];
    store.writeStory(storyId, story);
    const scopeCheckedAt = '2026-04-27T12:01:30.000Z';
    store.writeScopeCheck(storyId, {
      storyId,
      checkedAt: scopeCheckedAt,
      features: [],
      summary: { total: 0, covered: 0, excluded: 0, gaps: 0, orphanSuspect: 0, drift: 0 },
      reviewRound: '',
      _hash: signScopeCheck(storyId, scopeCheckedAt, 0, 0, ''),
    });
    store.writeProofStoryContract(storyId, {
      schemaVersion: 'proofstory.contract.v1',
      storyId,
      diagnosticOnly: true,
      hardeningLevel: 'standard',
      triggerReasons: [],
      acceptanceBindings: [{
        id: 'AC-REVIEW-ECHO',
        checklistRefs: ['CHK-001'],
        verificationIntentRefs: [],
        milestoneIds: [],
        verificationTopology: {
          schemaVersion: 'proofstory.acceptance_topology.v1',
          producerRefs: [],
          consumerRefs: [],
          positiveAssertionRefs: [],
          mutationCaseRefs: [],
          transcriptAssertionRefs: [],
          commandRefs: [
            { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis' },
            { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_basis_generate' },
            { refKind: 'existing', canonicalSourceRef: 'process-fact:acceptance_topology_check' },
            { refKind: 'existing', canonicalSourceRef: 'process-fact:artifact:acceptance-basis.json' },
          ],
        },
      }],
      diagnosticGaps: [],
      createdAt: scopeCheckedAt,
      updatedAt: scopeCheckedAt,
    });
    git(root, ['init']);
    git(root, ['config', 'user.email', 'proofOrStop@example.test']);
    git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);

    process.chdir(root);
    const basisOutput = createProofStoryHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }).acceptance_basis_generate({ storyId });
    assert.match(basisOutput, /Acceptance coverage basis: complete/, JSON.stringify(store.readAcceptanceBasis(storyId)));
    const planArtifact = store.readAcceptanceBasis(storyId);
    assert.match(
      basisOutput,
      /Acceptance coverage basis: complete/,
      `acceptance basis fixture must remain complete: ${JSON.stringify({
        output: basisOutput,
        status: planArtifact?.basis.status,
        blindSpots: planArtifact?.basis.blindSpots,
        snapshotSeal: planArtifact?.basis.snapshotSeal,
      })}`,
    );
    assert.equal(planArtifact?.basis.generatedBy.verifier, 'acceptance-coverage-basis-verifier');
    assert.equal(planArtifact?.basis.generatedBy.command, 'proof-or-stop acceptance_basis_generate');
    if (basisOnly) return;
    // Supply the current normal-channel prerequisite through its real writer.
    const implementationDispatch = createStoryDispatchHandlers({ store, root, scanRoot: join(root, 'packages/main') });
    for (const item of store.readChecklist(storyId).items) {
      implementationDispatch.dispatch({ storyId, itemId: item.id, agentType: 'proof-or-stop-implementer' });
    }
    const output = await createStoryAdvanceHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }).story_advance({ storyId, phase: 'REVIEW' });

    assert.match(
      output,
      /Active reviewers: proof-or-stop-review-concept, proof-or-stop-review-quality, proof-or-stop-review-test-coverage/,
    );
    assert.doesNotMatch(output, /lattice-review-channel/);
    assert.doesNotMatch(output, /legacy alias:/);
    assert.doesNotMatch(output, /channel \(normal channel\)/);

    // Removing one genuinely present fixture source must still fail the seal.
    // This calls only the pure derivation API: no negative receipt is signed,
    // and all file/git mutations stay inside this test's mkdtemp-owned root.
    const missingSource = 'packages/main/src/core/proof-admissibility.ts';
    assert.equal(readFileSync(join(root, missingSource), 'utf8'), 'export {};\n');
    rmSync(join(root, missingSource));
    git(root, ['add', missingSource]);
    git(root, ['commit', '-m', 'remove required fixture snapshot input']);
    const missing = deriveAcceptanceCoverageBasis({
      storyId, workspaceRoot: root,
      checklist: store.readChecklist(storyId),
      contract: store.readProofStoryContract(storyId),
      scopeCheck: store.readScopeCheck(storyId),
      scopeContract: store.readScopeContract(storyId),
      headHash: currentGitHead(root)!,
      materialHash: currentMaterialHash(root, 'HEAD', root)!,
      storyFilesHash: currentStoryFilesHash(root, 'HEAD', root)!,
      phaseBasis: 'plan',
    });
    assert.equal(missing.basis.status, 'partial', 'F090: missing registered source cannot yield a complete basis');
    assert.equal(missing.basis.snapshotSeal.status, 'partial');
    assert.ok(missing.basis.snapshotSeal.issues.some(issue => issue.code === 'snapshot_missing'
      && issue.targetKind === 'source_file' && issue.canonicalRef === missingSource),
    'F090: partial seal identifies the exact missing registered source');
    assert.deepEqual(missing.basis.enumeratedPathRefs, planArtifact!.basis.enumeratedPathRefs,
      'F090: physical snapshot completeness remains independent of the same discovered command paths');
    console.log('B-aa5f F090 fixture-snapshot-inputs PASS complete-control=complete missing-input=partial');
  } finally {
    process.chdir(oldCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertReviewerStatusUsesMdFallback(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-doc-review-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    store.writeUnderstanding(storyId, {
      task: 'Check review gate',
      outcome: 'Review gate reports git-detected docs reviewers',
      facts: [],
      constraints: [],
      unknowns: [],
      timestamp: '2026-04-27T12:00:00.000Z',
    } as any);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'proofOrStop@example.test']);
    git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'docs/review-notes.md', '# Review notes\n\nDocs changed in story branch.\n');
    git(root, ['add', 'docs/review-notes.md']);
    git(root, ['commit', '-m', 'docs change']);
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, [
      'proof-or-stop-review-concept',
      'proof-or-stop-review-quality',
      'proof-or-stop-review-test-coverage',
    ]);

    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'proof-or-stop-review-concept', reviewRound, '010', runIds.get('proof-or-stop-review-concept')!),
        makeFinding(storyId, 'proof-or-stop-review-quality', reviewRound, '011', runIds.get('proof-or-stop-review-quality')!),
      ],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'proof-or-stop-review-test-coverage', reviewRound, '012', runIds.get('proof-or-stop-review-test-coverage')!),
      ],
    });

    const status = summarizeReviewerStatus(store, storyId, root);
    const byName = new Map(status.entries.map(e => [e.name, e]));
    assert.equal(byName.get('docs')?.verdict, 'pending', 'reviewer status should include docs from git diff fallback');

    const reviewBrief = createSessionHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }).session_brief({ concise: true });
    assert.match(reviewBrief, /\[pending\] docs/i);
    assert.match(reviewBrief, /review_run_start/, 'REVIEW anti-stall should tell reviewers to start a signed review run');
    assert.match(reviewBrief, /reviewRunId/, 'REVIEW anti-stall should mention the returned reviewRunId');
    assert.match(reviewBrief, /review_pass_set/, 'REVIEW anti-stall should still explain no-blocker pass evidence');
    assert.match(reviewBrief, /<reviewRunId from proof-or-stop review_run_start>/, 'REVIEW anti-stall should not imply a hard-coded reviewRunId');
    assert.doesNotMatch(reviewBrief, /:RR-001/, 'REVIEW anti-stall must not hard-code a synthetic reviewRunId');

    const contract = getArtifactContractStatus(store, storyId, 'TEST', { projectRoot: root });
    const findingsClear = contract.entries.find(entry => entry.name === 'findings-clear');
    assert.equal(findingsClear?.present, false, 'artifact contract should use the same docs reviewer fallback as status');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertSessionBriefStatusHintsMatchGates(): void {
  const reviewRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-session-review-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(reviewRoot);
    git(reviewRoot, ['init']);
    git(reviewRoot, ['config', 'user.email', 'proofOrStop@example.test']);
    git(reviewRoot, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    git(reviewRoot, ['checkout', '-B', 'main']);
    git(reviewRoot, ['add', '.']);
    git(reviewRoot, ['commit', '-m', 'base']);
    git(reviewRoot, ['checkout', '-b', `story/${storyId}`]);
    const runIds = seedReviewRuns(reviewRoot, store, storyId, reviewRound, [
      'proof-or-stop-review-concept',
      'proof-or-stop-review-quality',
      'proof-or-stop-review-test-coverage',
    ]);
    store.writeReview(storyId, {
      reviews: [{
        timestamp: reviewRound,
        issueCount: 0,
        blockerCount: 0,
        issues: [],
      }],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'proof-or-stop-review-concept', reviewRound, '020', runIds.get('proof-or-stop-review-concept')!),
        makeReviewPass(storyId, 'proof-or-stop-review-quality', reviewRound, '021', runIds.get('proof-or-stop-review-quality')!),
        makeReviewPass(storyId, 'proof-or-stop-review-test-coverage', reviewRound, '022', runIds.get('proof-or-stop-review-test-coverage')!),
      ],
    });
    const reviewBrief = createSessionHandlers({
      store,
      root: reviewRoot,
      scanRoot: join(reviewRoot, 'packages/main'),
    }).session_brief({ concise: true });
    const reviewNext = createSessionHandlers({
      store,
      root: reviewRoot,
      scanRoot: join(reviewRoot, 'packages/main'),
    }).next({ concise: true });
    assert.doesNotMatch(reviewBrief, /REVIEW blocked by unresolved findings/);
    assert.match(reviewNext, /All reviewer gates passed/);
    assert.match(reviewNext, /review_inventory_begin/);
    assert.doesNotMatch(reviewNext, /story_advance .*phase=TEST/);

    const testStory = store.readStory(storyId);
    testStory.phase = 'TEST';
    store.writeStory(storyId, testStory);
    const missingPassNext = createSessionHandlers({
      store,
      root: reviewRoot,
      scanRoot: join(reviewRoot, 'packages/main'),
    }).next({ concise: true });
    assert.match(missingPassNext, /current signed REVIEW routine PASS is missing/);
    assert.match(missingPassNext, /phase=DEV to restore PRE_CERT/);
    assert.doesNotMatch(missingPassNext, /Next: proof-or-stop validate/);

    const evidence: TestEvidenceData = {
      command: 'proof-or-stop validate --json',
      output: JSON.stringify({ allPass: true }),
      result: 'PASS',
      timestamp: '2026-04-27T12:20:00.000Z',
    };
    store.writeTestEvidence(storyId, evidence);
    const testBrief = createSessionHandlers({
      store,
      root: reviewRoot,
      scanRoot: join(reviewRoot, 'packages/main'),
    }).session_brief({ concise: true });
    const nextStep = createSessionHandlers({
      store,
      root: reviewRoot,
      scanRoot: join(reviewRoot, 'packages/main'),
    }).next({ concise: true });
    assert.match(testBrief, /\[FAIL\] delivery-check/);
    assert.match(testBrief, /\[FAIL\] Story summary/);
    assert.match(testBrief, /DONE pre-check still has/);
    // B-4b22: proof_or_stop_metadata_changes is a passing category, so the git-working-tree
    // row now reports PASS with "pass: blocking=0 ...; passed=N (proof_or_stop_metadata_changes=N)".
    // The PROOF_OR_STOP_WRITE side-effect hint only appears when the row fails, so it is
    // no longer asserted here. session_brief still surfaces "Working tree dirty
    // (N files)" because dirt exists even when policy allows it.
    assert.match(testBrief, /\[PASS\] git working tree/);
    assert.match(testBrief, /pass: blocking=0/);
    assert.match(testBrief, /proof_or_stop_metadata_changes/);
    assert.match(testBrief, /Working tree dirty/);
    assert.match(testBrief, /delivery_check_set/);
    assert.match(testBrief, /agentId=proof-or-stop-review-delivery/);
    assert.match(testBrief, /main agent must not self-sign/);
    assert.match(testBrief, /summary_set/);
    // B-4b22: proof_or_stop_metadata-only pollution passes via dirty-gate-policy, so
    // git-working-tree no longer appears in the blocked-row list.
    assert.match(nextStep, /delivery-check, story-summary/);
    assert.match(nextStep, /After all pass, run proof-or-stop story_advance --phase=DONE/);
    assert.match(testBrief, /After all pass, run proof-or-stop story_advance --phase=DONE/);
    assert.doesNotMatch(testBrief, /Next step: story_advance --storyId=B-smoke --phase=DONE/);
    assert.doesNotMatch(testBrief, /Next step: first git add \+ git commit to commit all changes, then advance DONE/);
  } finally {
    rmSync(reviewRoot, { recursive: true, force: true });
  }
}

export function assertReviewNextUsesReviewerGateState(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-review-next-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'proofOrStop@example.test']);
    git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, [
      'proof-or-stop-review-concept',
      'proof-or-stop-review-quality',
      'proof-or-stop-review-test-coverage',
    ]);

    const handlers = createSessionHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    });
    const pendingNext = handlers.next({ concise: true });
    assert.match(pendingNext, /Waiting for reviewer evidence/);
    assert.match(pendingNext, /story-review/);
    assert.match(pendingNext, /concept/);
    assert.match(pendingNext, /quality/);
    assert.match(pendingNext, /test-coverage/);
    assert.doesNotMatch(pendingNext, /channel/);
    assert.doesNotMatch(pendingNext, /All critical\/high findings resolved/);
    assert.doesNotMatch(pendingNext, /story_advance .*phase=TEST/);

    const id = `${storyId}:F-open`;
    const createdAt = '2026-04-27T12:30:00.000Z';
    const desc = 'concept blocking issue';
    const severity = 'high';
    store.writeReview(storyId, {
      reviews: [{
        timestamp: reviewRound,
        issueCount: 0,
        blockerCount: 0,
        issues: [],
      }],
    });
    store.writeFindings(storyId, {
      findings: [{
        id,
        desc,
        severity,
        category: 'happy',
        status: 'open',
        agent: 'proof-or-stop-review-concept',
        createdAt,
        reviewRound,
        reviewRunId: runIds.get('proof-or-stop-review-concept')!,
        _hash: signFinding(storyId, id, desc, severity, createdAt, reviewRound, runIds.get('proof-or-stop-review-concept')!),
      }],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'proof-or-stop-review-quality', reviewRound, '041', runIds.get('proof-or-stop-review-quality')!),
        makeReviewPass(storyId, 'proof-or-stop-review-test-coverage', reviewRound, '042', runIds.get('proof-or-stop-review-test-coverage')!),
      ],
    });
    const blockerNext = handlers.next({ concise: true });
    assert.match(blockerNext, /1 blocking finding/);
    assert.match(blockerNext, /concept\(1\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertDevGuidanceUsesReviewPhase(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-dev-guidance-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'proofOrStop@example.test']);
    git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const story = store.readStory(storyId);
    story.phase = 'DEV';
    store.writeStory(storyId, story);

    const brief = createSessionHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }).session_brief({ concise: true });
    assert.match(brief, /phase=REVIEW/);
    assert.doesNotMatch(brief, /enter verification via phase=TEST/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertValidateHintsFollowStoryPhase(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-validate-hint-'));
  try {
    const { store, storyId } = createReviewStore(root);
    const result = JSON.stringify({ provider: 'proof-or-stop-verifier', allPass: true });
    const render = (phase: StoryInfo['phase']) => {
      const story = store.readStory(storyId);
      story.phase = phase;
      store.writeStory(storyId, story);
      return String(decorateResult({
        cmd: 'validate',
        args: { story: storyId },
        result,
        store,
        root,
        activeStory: { storyId, phase },
      }));
    };

    const devHint = render('DEV');
    assert.match(devHint, /phase=REVIEW/);
    assert.doesNotMatch(devHint, /phase=DONE/);
    assert.doesNotMatch(devHint, /phase=TEST/);

    const reviewHint = render('REVIEW');
    assert.match(reviewHint, /phase=TEST/);
    assert.doesNotMatch(reviewHint, /phase=DONE/);

    const testHint = render('TEST');
    assert.match(testHint, /DONE pre-check/);
    assert.match(testHint, /phase=DONE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertRealCliValidateHintFollowsActiveStoryPhase(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-real-cli-validate-'));
  try {
    const { store, storyId } = createReviewStore(root);
    write(root, 'validate-smoke.js', 'console.log(JSON.stringify({ provider: "smoke", status: "pass", allPass: true, summary: "ok", details: [] }));\n');
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      validate: { command: 'node validate-smoke.js' },
      workflow: { profile: 'balanced' },
    }));
    resetConfigCache();
    git(root, ['init']);
    git(root, ['config', 'user.email', 'proofOrStop@example.test']);
    git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const story = store.readStory(storyId);
    story.phase = 'DEV';
    store.writeStory(storyId, story);

    // B-7fc2 keeps --json stdout machine-parseable, so human next-step hints
    // are intentionally text-mode only. This flow assertion covers that the
    // real CLI hint still follows the active story phase; JSON purity is
    // covered separately by cli-json-stdout-contract-smoke.
    const output = execFileSync('node', [localCliPath(), 'validate'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(output, /phase=REVIEW/);
    assert.doesNotMatch(output, /phase=DONE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertBugUpdateTestHintUsesDonePrecheck(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-bug-hint-'));
  try {
    const { store, storyId } = createReviewStore(root);
    const story = store.readStory(storyId);
    story.phase = 'TEST';
    store.writeStory(storyId, story);
    store.writeBugs(storyId, {
      bugs: [{
        id: 'BUG-001',
        title: 'last test bug',
        status: 'fixed',
        foundAt: '2026-04-27T12:00:00.000Z',
        fixedAt: '2026-04-27T12:30:00.000Z',
      }],
    });

    const output = String(decorateResult({
      cmd: 'bug_update',
      args: { storyId, id: 'BUG-001', status: 'fixed' },
      result: 'Bug BUG-001 updated to fixed',
      store,
      root,
      activeStory: { storyId, phase: 'TEST' },
    }));
    assert.match(output, /DONE pre-check/);
    assert.match(output, /phase=DONE/);
    assert.doesNotMatch(output, /Next step: story_advance --storyId=.*--phase=DONE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertChannelGateRejectsProofOrStopSubjectForRealFiles(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-channel-author-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'proofOrStop@example.test']);
    git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/real-code.ts', 'export const realCode = true;\n');
    git(root, ['add', 'packages/main/src/real-code.ts']);
    git(root, [
      '-c', 'user.name=main-agent',
      '-c', 'user.email=main@example.test',
      'commit',
      '-m', 'proof-or-stop: implement real code',
    ]);

    const result = checkCommitAuthor(storyId, { store, projectRoot: root });
    assert.equal(result.status, 'fail');
    assert.match(result.summary, /missing dispatch\/subagent_result evidence/);
    assert.match(result.summary, /unexpected implementation attribution/);
    assert.match(result.details.join('\n'), /proof-or-stop: implement real code/);
    assert.match(result.details.join('\n'), /canonical proof-or-stop dispatch\/subagent_result evidence is required/);
    assert.match(result.details.join('\n'), /commit author is an independent audit signal/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertChannelGateAcceptsStructuredEvidenceWithSharedGitAuthor(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-channel-shared-author-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'proofOrStop@example.test']);
    git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/real-code.ts', 'export const realCode = true;\n');
    git(root, ['add', 'packages/main/src/real-code.ts']);
    git(root, [
      '-c', 'user.name=main-agent',
      '-c', 'user.email=main@example.test',
      'commit',
      '-m', 'implement real code through dispatched worker',
    ]);
    for (const suffix of ['001', '002', '003']) {
      store.appendProcessEvent(storyId, {
        type: 'subagent_result',
        checklistId: `CHK-${suffix}`,
        success: true,
      });
    }

    const result = checkCommitAuthor(storyId, { store, projectRoot: root });
    assert.equal(result.status, 'pass');
    assert.equal(result.evidenceSource, 'subagent_result');
    assert.match(result.summary, /structured evidence coverage complete/);
    assert.match(result.details.join('\n'), /commit author advisory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertChannelGateRejectsImplementerAuthorWithoutDispatch(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-channel-author-fallback-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'proofOrStop@example.test']);
    git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/real-code.ts', 'export const realCode = true;\n');
    git(root, ['add', 'packages/main/src/real-code.ts']);
    git(root, [
      '-c', 'user.name=proof-or-stop-implementer',
      '-c', 'user.email=implementer@example.test',
      'commit',
      '-m', 'implement real code',
    ]);

    const result = checkCommitAuthor(storyId, { store, projectRoot: root });
    assert.equal(result.status, 'fail', 'IMPLEMENTATION_WORKER_AUTHORITY_RED: an implementer author string must not replace canonical dispatch evidence');
    assert.equal(result.evidenceSource, undefined);
    assert.match(result.summary, /missing dispatch\/subagent_result evidence/);
    assert.match(result.details.join('\n'), /canonical proof-or-stop dispatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertChannelGateAcceptsSuccessfulSubagentResultEvidence(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-channel-subagent-evidence-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'proofOrStop@example.test']);
    git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/real-code.ts', 'export const realCode = true;\n');
    git(root, ['add', 'packages/main/src/real-code.ts']);
    git(root, [
      '-c', 'user.name=proof-or-stop-implementer',
      '-c', 'user.email=implementer@example.test',
      'commit',
      '-m', 'implement real code',
    ]);
    for (const suffix of ['001', '002', '003']) {
      store.appendProcessEvent(storyId, {
        type: 'subagent_result',
        checklistId: `CHK-${suffix}`,
        success: true,
      });
    }

    const result = checkCommitAuthor(storyId, { store, projectRoot: root });
    assert.equal(result.status, 'pass');
    assert.equal(result.evidenceSource, 'subagent_result');
    assert.match(renderedDetails(result), /Covered: CHK-001, CHK-002, CHK-003/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertChannelGateAcceptsDispatchEvidence(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-channel-dispatch-evidence-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'proofOrStop@example.test']);
    git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/real-code.ts', 'export const realCode = true;\n');
    git(root, ['add', 'packages/main/src/real-code.ts']);
    git(root, [
      '-c', 'user.name=proof-or-stop-implementer',
      '-c', 'user.email=implementer@example.test',
      'commit',
      '-m', 'implement real code',
    ]);
    for (const suffix of ['001', '002', '003']) {
      store.appendProcessEvent(storyId, {
        type: 'dispatch',
        checklistId: `CHK-${suffix}`,
      });
    }

    const result = checkCommitAuthor(storyId, { store, projectRoot: root });
    assert.equal(result.status, 'pass');
    assert.equal(result.evidenceSource, 'dispatch');
    assert.match(renderedDetails(result), /Covered: CHK-001, CHK-002, CHK-003/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertImplementationWorkerAuthorityUsesFrozenMasterIntegrationTarget(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-channel-master-base-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['branch', '-M', 'master']);
    assert.throws(
      () => execFileSync('git', ['rev-parse', '--verify', 'main'], {
        cwd: root,
        stdio: 'pipe',
      }),
      'the regression fixture must not retain a main ref',
    );
    const parentCommitAtCreation = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    const story = store.readStory(storyId);
    story.phase = 'DEV';
    story.integrationTarget = {
      parentBranch: 'master',
      parentCommitAtCreation,
      source: 'creation_branch',
      deliveryMode: 'merge_to_parent',
    };
    store.writeStory(storyId, story);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'freeze master integration target']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/master-only.ts', 'export const masterOnly = true;\n');
    git(root, ['add', 'packages/main/src/master-only.ts']);
    git(root, [
      '-c', 'user.name=main-agent',
      '-c', 'user.email=main@example.test',
      'commit',
      '-m', 'implement through managed workers on a master repository',
    ]);
    for (const suffix of ['001', '002', '003']) {
      store.appendProcessEvent(storyId, {
        type: 'subagent_result',
        checklistId: `CHK-${suffix}`,
        success: true,
      });
    }

    let observedBase: string | undefined;
    const channel = checkCommitAuthor(storyId, {
      store,
      projectRoot: root,
      gitLogReader: ({ base }) => {
        observedBase = base;
        return '';
      },
    });
    assert.equal(observedBase, 'master', 'channel attribution must consume the frozen master target');
    assert.equal(channel.status, 'pass', 'resolved master target must preserve valid worker evidence');

    assert.doesNotThrow(
      () => runImplementationWorkerAuthorityGate({ store, root }, storyId),
      'DEV to REVIEW authority must use the Story frozen master integration target without inventing a main ref',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

export function assertImplementationWorkerAuthorityReportsUnresolvedIntegrationTarget(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-channel-unresolved-base-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['branch', '-M', `story/${storyId}`]);
    const story = store.readStory(storyId);
    story.phase = 'DEV';
    delete story.integrationTarget;
    store.writeStory(storyId, story);

    let message = '';
    try {
      runImplementationWorkerAuthorityGate({ store, root }, storyId);
      assert.fail('a Story-only repository without an integration target must fail closed');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.match(message, /integration_branch_unresolved/);
    assert.doesNotMatch(message, /implementation_worker_authority_invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}
