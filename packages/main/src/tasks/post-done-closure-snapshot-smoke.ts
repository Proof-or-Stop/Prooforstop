#!/usr/bin/env node

/**
 * @task B-b531
 * @checklist CHK-001
 * @title Fix post-DONE closure snapshot material projection
 * @type bugfix
 * @priority high
 * @description
 *   Regression smoke for post-DONE read-only closure/status projections:
 *   completed stories are evaluated against their DONE snapshot, while
 *   unfinished TEST stories keep strict current-material gates.
 * @changes
 *   - [CHK-001] Cover historical DONE closure projection after material drift.
 *   - [CHK-001] Cover review escalation status using the completed snapshot.
 *   - [CHK-001] Cover strict TEST-phase stale evidence behavior.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { runDoneRequiredValidation } from '../core/done-required-validation.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { StoryStore } from '../core/store.js';
import { signReviewRun, verifyReviewRun, buildReviewRunWorkspaceBinding, hashReviewPrompt, collectReviewerEvidenceState, evaluatePersistedReviewToTestIndexTransition, evaluateReviewRunMetadataRetention } from '../core/review-run.js';
import { PROMPT_ENVELOPE_ROLLOUT_VERSION, resolvePromptRoleBody } from '../core/prompt-role-contract-registry.js';
import { signReviewPass, signFinding } from '../core/finding-verify.js';
import { computeReviewScopeBinding, signReviewScopeBinding } from '../core/review-scope-binding.js';
import { buildScopeDiffPack } from '../core/scope-diff-pack.js';
import { evaluateReviewVerdict } from '../core/machine.js';
import { buildDoneChecklist } from '../core/done-oracle.js';
import { createPlaybookRuntimeMemoryHandlers } from '../handlers/playbook-runtime-memory.js';
import type { ClosingSelfCheck, DocsPromise, ProcessEvent, RealMachineTest, ReviewRun, StoryInfo } from '../core/types.js';
import { buildDoneClosureRunbook } from '../handlers/done-closure.js';
import { createReviewEscalationHandlers } from '../handlers/review-escalation.js';
import type { HandlerContext } from '../handlers/context.js';

const STORY_ID = 'B-postdone';
const NOW = '2026-06-29T19:30:00.000Z';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'post-done-closure-smoke',
      GIT_AUTHOR_EMAIL: 'post-done-closure-smoke@example.invalid',
      GIT_COMMITTER_NAME: 'post-done-closure-smoke',
      GIT_COMMITTER_EMAIL: 'post-done-closure-smoke@example.invalid',
    },
  }).trim();
}

function writeConfig(root: string): void {
  writeFileSync(
    join(root, 'proof-or-stop.config.json'),
    JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      doneRequiredCommands: [
        { label: 'required pass', command: process.execPath, args: ['-e', 'process.exit(0)'] },
      ],
    }, null, 2) + '\n',
  );
  resetConfigCache();
}

async function createDoneReadyFixture(): Promise<{
  root: string;
  store: StoryStore;
  ctx: HandlerContext;
  materialHash: string;
  storyFilesHash: string | null;
}> {
  const root = mkdtempSync(join(tmpdir(), 'post-done-closure-snapshot-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  mkdirSync(join(root, 'docs/requirements'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, '.gitignore'), '.proof-or-stop/\n', 'utf8');
  writeFileSync(join(root, 'README.md'), '# post done closure snapshot smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 1;\n', 'utf8');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.gitignore', 'README.md', 'proof-or-stop.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);

  const store = new StoryStore(root);
  const story: StoryInfo = {
    storyId: STORY_ID,
    name: 'post-done-closure-snapshot-smoke',
    title: 'Post DONE closure snapshot smoke',
    description: 'Synthetic DONE story for closure snapshot projection.',
    type: 'bug',
    phase: 'TEST',
    priority: 'high',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    currentReviewRound: 'round-1',
  };
  store.writeStory(STORY_ID, story);
  store.writeChecklist(STORY_ID, {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic completed item',
      context: 'Synthetic completed context',
      status: 'done',
      startTime: NOW,
      endTime: NOW,
      verificationIntent: {
        happy: [{ desc: 'DONE closure remains stable after drift', type: 'logic', priority: 'must' }],
        edge: [{ desc: 'TEST remains strict under stale evidence', type: 'logic', priority: 'must' }],
        adversarial: [{ desc: 'Unfinished story cannot hide stale evidence', type: 'logic', priority: 'must' }],
      },
      verificationEvidence: [{
        intentRef: 'CHK-001:happy:0',
        kind: 'logic_test',
        result: 'pass',
        note: 'synthetic proof for post-DONE closure snapshot smoke',
      }],
    }],
  });

  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root, 'HEAD', root);
  const storyFilesHash = currentStoryFilesHash(root, 'HEAD', root);
  assert.ok(headHash, 'fixture HEAD is available');
  assert.ok(materialHash, 'fixture material hash is available');
  store.writeTestEvidence(STORY_ID, {
    command: 'post-done-closure-snapshot-smoke',
    output: JSON.stringify({ allPass: true, summary: 'post-DONE closure snapshot smoke fixture passed' }),
    result: 'PASS',
    timestamp: NOW,
    headHash,
    materialHash,
    ...(storyFilesHash ? { storyFilesHash } : {}),
    verificationCoverage: {
      total: 3,
      required: 3,
      covered: 3,
      missingRequired: 0,
      entries: [],
    },
  });
  store.writeBugs(STORY_ID, { bugs: [] });
  createPlaybookRuntimeMemoryHandlers({ store, root, scanRoot: join(root, 'packages/main') }).dev_memory_finish_decision({
    storyId: STORY_ID, decision: 'no-reusable-lesson', reason: 'Synthetic historical snapshot regression fixture.',
  });
  const scopeContract = {
    storyId: STORY_ID, mode: 'enforce' as const,
    allowedModify: ['packages/main/src/index.ts'], allowedCreate: [], allowedTest: [],
    protectedFiles: [], explicitExcludes: [], acknowledgements: [], createdAt: NOW, updatedAt: NOW,
  };
  store.writeScopeContract(STORY_ID, scopeContract);
  const scopeBinding = computeReviewScopeBinding({ contract: scopeContract, diffPack: buildScopeDiffPack(root), projectRoot: root });
  assert.ok(scopeBinding);
  const lanes = ['quality', 'concept', 'test-coverage', 'behavior', 'docs'].map(lane => `proof-or-stop-review-${lane}`);
  store.writeReviewRuns(STORY_ID, { runs: lanes.map(lane => {
    const reviewRunId = `${STORY_ID}:${lane}`;
    const promptHash = hashReviewPrompt(resolvePromptRoleBody(lane, {
      version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles: { [lane]: 'legacy-full-context' },
    }).body);
    return { reviewRunId, storyId: STORY_ID, agent: lane, lane, reviewRound: 'round-1', startedAt: NOW,
      headHash, materialHash, storyFilesHash: storyFilesHash ?? undefined, promptHash, scopeBinding,
      _hash: signReviewRun(STORY_ID, reviewRunId, lane, lane, 'round-1', NOW, headHash, materialHash, promptHash, scopeBinding.bindingHash, undefined, storyFilesHash ?? undefined) };
  }) });
  store.writeReviewPasses(STORY_ID, { passes: lanes.map((lane, index) => {
    const id = `RP-${index}`; const reviewRunId = `${STORY_ID}:${lane}`; const note = 'Signed historical snapshot regression fixture';
    return { id, agent: lane, reviewRound: 'round-1', createdAt: NOW, reviewRunId, note,
      _hash: signReviewPass(STORY_ID, id, lane, note, NOW, 'round-1', reviewRunId) };
  }) });

  const docsPromises: DocsPromise[] = [];
  const realMachineTests: RealMachineTest[] = [{
    featureId: 'CHK-001',
    transcript: 'Synthetic closure snapshot smoke has real-machine-style coverage.',
  }];
  const closingSelfCheck: ClosingSelfCheck = {
    hasRealMachineTest: true,
    hasEdgeCaseCoverage: true,
    hasUnresolvedTodos: false,
    summary: 'Synthetic closure snapshot evidence is complete.',
  };
  store.writeDeliveryCheck(STORY_ID, {
    storyId: STORY_ID,
    checkedAt: NOW,
    headHash,
    materialHash,
    reviewRound: 'round-1',
    agentId: 'proof-or-stop-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    ...(storyFilesHash ? { storyFilesHash } : {}),
    _hash: signDeliveryCheck(STORY_ID, docsPromises, realMachineTests, closingSelfCheck, 'round-1', materialHash, storyFilesHash ?? undefined),
  });
  store.writeSummary(STORY_ID, {
    storyId: STORY_ID,
    createdAt: NOW,
    updatedAt: NOW,
    changes: 'Synthetic post-DONE closure snapshot fixture changes.',
    usage: 'Run done_closure and review_escalation_status against the synthetic story.',
    expectedOutcome: 'Historical DONE status remains stable after current material drift.',
    actualTranscript: 'Synthetic fixture records a stable historical DONE snapshot.',
    outcomeDiff: 'No difference.',
    acceptanceVerdict: 'accepted',
    outcomeKind: 'success',
    realMachineCoverage: { ran: [], skipped: [] },
    limitations: 'Synthetic smoke fixture only.',
    pitfalls: 'Do not use current-material revalidation as the default DONE history projection.',
  });
  await runDoneRequiredValidation({ projectRoot: root, storyId: STORY_ID, store, gitCwd: root });

  const policyEvent: Omit<ProcessEvent, 'timestamp'> = {
    type: 'review_escalation_policy',
    storyId: STORY_ID,
    command: 'review_escalation_policy_set',
    policyId: `${STORY_ID}:POL-1`,
    predicate: 'explicitlyConfiguredHighRiskPolicyRequires3x2',
    requires3x2: true,
    policyVersion: 'v1',
    riskClass: 'high',
    sourcePolicyRef: 'post-done-closure-snapshot-smoke',
    rolloutStage: 'ga',
    degradedFallbackAllowed: false,
    issuer: 'smoke',
    issuedAt: NOW,
    headHash,
    materialHash,
  };
  store.appendProcessEvent(STORY_ID, policyEvent);

  for (const runId of ['round-1', 'round-2', 'round-3']) {
    for (const host of ['codex', 'claude']) {
      store.appendProcessEvent(STORY_ID, {
        type: 'host_verdict',
        verdictId: `${runId}-${host}`,
        runId,
        hostId: `${host}-${runId}`,
        provider: host,
        sessionId: `${host}-${runId}-session`,
        keyId: `${host}-${runId}-key`,
        decision: 'pass',
        materialDigest: materialHash,
        ...(storyFilesHash ? { storyFilesHash } : {}),
        validationDigest: `${runId}-validation`,
        promptDigest: `${runId}-prompt`,
      });
    }
  }

  return {
    root,
    store,
    ctx: { store, root, scanRoot: join(root, 'packages/main') },
    materialHash,
    storyFilesHash: storyFilesHash ?? null,
  };
}

function blockingIds(runbook: ReturnType<typeof buildDoneClosureRunbook>): string[] {
  return runbook.blockers
    .filter((row) => row.blocking && row.status === 'fail')
    .map((row) => row.id)
    .sort();
}

function resignRun(run: ReviewRun): ReviewRun {
  return { ...run, _hash: signReviewRun(run.storyId, run.reviewRunId, run.agent, run.lane, run.reviewRound,
    run.startedAt, run.headHash, run.materialHash, run.promptHash, run.scopeBinding?.bindingHash,
    run.workspaceBinding?.bindingHash, run.storyFilesHash, run.envelopeId, run.reviewerEscalationReason) };
}

{
  const { root, store, ctx, materialHash, storyFilesHash } = await createDoneReadyFixture();
  try {
    const readyRunbook = buildDoneClosureRunbook(ctx, STORY_ID);
    assert.equal(readyRunbook.phase, 'TEST');
    assert.equal(readyRunbook.canAttemptDone, true, 'TEST fixture starts DONE-ready');
    assert.deepEqual(blockingIds(readyRunbook), [], 'TEST fixture has no blockers before drift');

    const doneStory = store.readStory(STORY_ID);
    doneStory.phase = 'DONE';
    doneStory.endedAt = NOW;
    doneStory.events = [...(doneStory.events ?? []), { phase: 'DONE', action: 'advance', timestamp: NOW }];
    store.writeStory(STORY_ID, doneStory);

    writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 2;\n', 'utf8');
    git(root, ['add', 'packages/main/src/index.ts']);
    git(root, ['commit', '-m', 'unrelated material drift after done']);
    assert.notEqual(currentMaterialHash(root, 'HEAD', root), materialHash, 'material drift changes current material hash');

    const doneRunbook = buildDoneClosureRunbook(ctx, STORY_ID);
    assert.equal(doneRunbook.phase, 'DONE');
    assert.equal(doneRunbook.historicalSnapshot?.materialHash, materialHash);
    assert.equal(doneRunbook.historicalSnapshot?.storyFilesHash ?? null, storyFilesHash);
    assert.equal(doneRunbook.localAssurance.admissibilityStatus, 'local-admissible');
    assert.deepEqual(blockingIds(doneRunbook), [], 'DONE historical projection must not reopen stale current-material blockers');
    assert.equal(doneRunbook.blockers.find((row) => row.id === 'delivery-check')?.status, 'warn');
    assert.equal(doneRunbook.blockers.find((row) => row.id === 'done-required-validation')?.status, 'warn');
    assert.equal(doneRunbook.blockers.find((row) => row.id === 'review-escalation')?.status, 'pass');
    assert.equal(doneRunbook.blockers.find((row) => row.id === 'review-verdict')?.status, 'warn', 'historical reviewer drift is an explicit advisory');
    assert.equal(evaluateReviewVerdict({ storyId: STORY_ID, store, projectRoot: root, gitCwd: root }).ok, false,
      'default reviewer verdict stays live-strict even for DONE');
    const savedPasses = store.readReviewPasses(STORY_ID);
    for (const mutate of [
      () => { store.writeReviewPasses(STORY_ID, { passes: [] }); },
      () => { const passes = structuredClone(savedPasses); passes.passes[0].note += 'tampered'; store.writeReviewPasses(STORY_ID, passes); },
    ]) {
      mutate();
      assert.ok(buildDoneClosureRunbook(ctx, STORY_ID).blockers.some(row => row.id === 'review-verdict' && row.blocking),
        'historical projection cannot hide missing or tampered passes after drift');
      store.writeReviewPasses(STORY_ID, savedPasses);
    }
    const savedRuns = store.readReviewRuns(STORY_ID);
    const tamperedRuns = structuredClone(savedRuns);
    tamperedRuns.runs[0].scopeBinding!.reviewedIntentRefs = ['tampered-but-outer-run-signature-stays-valid'];
    assert.ok(verifyReviewRun(tamperedRuns.runs[0]), 'control: nested scope tamper is masked behind freshness, not the outer run signature');
    store.writeReviewRuns(STORY_ID, tamperedRuns);
    assert.ok(buildDoneClosureRunbook(ctx, STORY_ID).blockers.some(row => row.id === 'review-verdict' && row.blocking),
      'scope signature rejection survives historical material drift');
    store.writeReviewRuns(STORY_ID, savedRuns);
    assert.equal(buildDoneClosureRunbook(ctx, STORY_ID).blockers.find(row => row.id === 'review-verdict')?.status, 'warn', 'restored signatures restore historical advisory');
    // More than the verdict's five rendered messages: validation must inspect
    // every record, never classify a truncated diagnostic string as authority.
    const manyPasses = structuredClone(savedPasses);
    for (let i = 5; i < 8; i += 1) {
      const pass = { ...savedPasses.passes[0], id: `RP-${i}` };
      pass._hash = signReviewPass(STORY_ID, pass.id, pass.agent, pass.note, pass.createdAt, pass.reviewRound!, pass.reviewRunId);
      manyPasses.passes.push(pass);
    }
    manyPasses.passes.at(-1)!.note += 'late-corruption';
    store.writeReviewPasses(STORY_ID, manyPasses);
    assert.ok(buildDoneClosureRunbook(ctx, STORY_ID).blockers.some(row => row.id === 'review-verdict' && row.blocking),
      'late corrupted evidence cannot be hidden by the first five drift observations');
    store.writeReviewPasses(STORY_ID, savedPasses);
    const finding = { id: 'F-historical', desc: 'Signed open acceptance blocker', severity: 'high' as const, category: 'adversarial' as const,
      status: 'open' as const, agent: savedRuns.runs[0].lane, createdAt: NOW, reviewRound: 'round-1', reviewRunId: savedRuns.runs[0].reviewRunId };
    store.writeFindings(STORY_ID, { findings: [{ ...finding,
      _hash: signFinding(STORY_ID, finding.id, finding.desc, finding.severity, NOW, 'round-1', finding.reviewRunId) }] });
    assert.ok(buildDoneClosureRunbook(ctx, STORY_ID).blockers.some(row => row.id === 'review-verdict' && row.reason.includes('review_finding_blocking') && row.blocking),
      'historical drift cannot hide a signed open blocking finding');
    store.writeFindings(STORY_ID, { findings: [] });
    const mismatchOptions = { completedSnapshot: { materialHash: 'different-snapshot', storyFilesHash } };
    assert.ok(collectReviewerEvidenceState(store, STORY_ID, root, mismatchOptions as Parameters<typeof collectReviewerEvidenceState>[3]).invalid.length > 0,
      'matching empty story hash is no signal and cannot bridge a mismatched material snapshot');

    const retiredRoot = join(root, '.retired-review-worktree');
    git(root, ['worktree', 'add', '--detach', retiredRoot, savedRuns.runs[0].headHash]);
    const relocatedRuns = { runs: savedRuns.runs.map(run => resignRun({ ...run, workspaceBinding: buildReviewRunWorkspaceBinding({
      metadataRoot: retiredRoot, invocationCwd: retiredRoot, repoRoot: root, signedWorkspaceRoot: retiredRoot,
      workspaceMode: 'story-worktree', headHash: run.headHash, materialHash: run.materialHash, storyFilesHash: run.storyFilesHash,
    }) })) };
    git(root, ['worktree', 'remove', retiredRoot]);
    store.writeReviewRuns(STORY_ID, relocatedRuns);
    assert.equal(buildDoneClosureRunbook(ctx, STORY_ID).blockers.find(row => row.id === 'review-verdict')?.status, 'warn',
      'actual removed signed workspace and metadata roots preserve verified historical evidence');
    assert.ok(collectReviewerEvidenceState(store, STORY_ID, root).invalid.length > 0,
      'default collector still rejects a retired live workspace');
    for (const mutate of [
      (run: ReviewRun) => { run.workspaceBinding!.metadataRoot += '-tampered'; return run; },
      (run: ReviewRun) => { run.storyId = 'B-wrong-story'; return resignRun(run); },
      (run: ReviewRun) => { run.promptHash = 'changed-role-prompt'; return resignRun(run); },
      (run: ReviewRun) => { run.envelopeId = 'missing-historical-envelope'; return resignRun(run); },
      (run: ReviewRun) => {
        run.headHash = '1'.repeat(40);
        run.workspaceBinding = buildReviewRunWorkspaceBinding({ ...run.workspaceBinding!, headHash: run.headHash });
        return resignRun(run);
      },
      (run: ReviewRun) => {
        run.materialHash = 'not-the-signed-head-material';
        run.workspaceBinding = buildReviewRunWorkspaceBinding({ ...run.workspaceBinding!, materialHash: run.materialHash });
        return resignRun(run);
      },
    ]) {
      const invalid = structuredClone(relocatedRuns); invalid.runs[0] = mutate(invalid.runs[0]);
      store.writeReviewRuns(STORY_ID, invalid);
      assert.ok(buildDoneClosureRunbook(ctx, STORY_ID).blockers.some(row => row.id === 'review-verdict' && row.blocking),
        'historical relocation rejects tampered binding, wrong Story, missing signed commit or mismatched signed material');
    }
    store.writeReviewRuns(STORY_ID, savedRuns);

    const savedDelivery = store.readDeliveryCheck(STORY_ID)!;
    for (const docsPromises of [undefined, null, {}, [null], [3]]) {
      store.writeDeliveryCheck(STORY_ID, { ...savedDelivery, docsPromises } as unknown as typeof savedDelivery);
      assert.ok(buildDoneClosureRunbook(ctx, STORY_ID).blockers.some(row => row.id === 'delivery-check' && row.blocking),
        `malformed rejected delivery ${JSON.stringify(docsPromises)} stays structured and blocking`);
    }
    store.writeDeliveryCheck(STORY_ID, savedDelivery);

    const reviewStatus = createReviewEscalationHandlers(ctx).review_escalation_status({ storyId: STORY_ID, json: true }) as {
      ok: boolean;
      materialHash: string | null;
      advisories?: string[];
    };
    assert.equal(reviewStatus.ok, true, 'DONE review_escalation_status uses the historical snapshot');
    assert.equal(reviewStatus.materialHash, materialHash);
    assert.ok(
      reviewStatus.advisories?.some((entry) => entry.includes('DONE historical snapshot')),
      'review status labels historical snapshot projection',
    );

    const unfinished = store.readStory(STORY_ID);
    unfinished.phase = 'TEST';
    unfinished.endedAt = null;
    store.writeStory(STORY_ID, unfinished);
    const strictRunbook = buildDoneClosureRunbook(ctx, STORY_ID);
    assert.equal(strictRunbook.phase, 'TEST');
    assert.ok(
      blockingIds(strictRunbook).some((id) => id === 'delivery-check' || id === 'done-required-validation'),
      'TEST phase remains strict under stale current-material evidence',
    );
    assert.ok(buildDoneChecklist(STORY_ID, store, root, { gitCwd: root, completedSnapshot: { materialHash, storyFilesHash } })
      .some(row => row.id === 'review-verdict' && row.blocking), 'TEST cannot opt into historical reviewer projection');
    assert.ok(collectReviewerEvidenceState(store, STORY_ID, root).invalid.length > 0, 'default collection is current-material strict');

    // Exercise composite-scope metadata retention separately from the legacy
    // fixture above, with a real immutable REVIEW index and canonical DONE
    // cleanup. The production metadata checker must still reject all other
    // index edits and unreceipted artifacts after current material drift.
    const reviewedIndex: StoryInfo = { ...unfinished, phase: 'REVIEW', events: [],
      worktree: { path: 'retired-story-worktree', branch: `story/${STORY_ID}`, createdAt: NOW } };
    store.writeStory(STORY_ID, reviewedIndex);
    const indexPath = `.proof-or-stop/story/actives/${STORY_ID}/index.json`;
    git(root, ['add', '-f', indexPath]); git(root, ['commit', '-m', 'signed REVIEW index']);
    const retainedRun = structuredClone(savedRuns.runs[0]);
    retainedRun.headHash = currentGitHead(root)!;
    retainedRun.materialHash = currentMaterialHash(root, 'HEAD', root)!;
    retainedRun.storyFilesHash = currentStoryFilesHash(root, 'HEAD', root) ?? undefined;
    retainedRun.scopeBinding!.compositeScopeDigest = 'stable-composite-fixture';
    retainedRun.scopeBinding!.bindingHash = signReviewScopeBinding(retainedRun.scopeBinding!);
    const retained = resignRun(retainedRun);
    const historicalSnapshot = { materialHash: retained.materialHash, storyFilesHash: retained.storyFilesHash };
    const completedIndex: StoryInfo = { ...reviewedIndex, phase: 'DONE', endedAt: NOW, worktree: undefined,
      events: [{ phase: 'TEST', action: 'advance', timestamp: NOW }, { phase: 'DONE', action: 'advance', timestamp: NOW }] };
    store.writeStory(STORY_ID, completedIndex);
    const indexCheck = evaluatePersistedReviewToTestIndexTransition as (...args: unknown[]) => { ok: boolean };
    assert.equal(indexCheck(root, indexPath, retained, completedIndex).ok, false, 'default index retention is TEST-only');
    assert.equal(indexCheck(root, indexPath, retained, completedIndex, historicalSnapshot).ok, true, 'canonical historical DONE index and worktree removal are retained');
    assert.equal(indexCheck(root, indexPath, retained, { ...completedIndex, title: 'unauthorized changed title' }, historicalSnapshot).ok, false,
      'historical index does not exempt arbitrary stable-field edits');
    assert.equal(indexCheck(root, indexPath, retained, { ...completedIndex, worktree: { ...reviewedIndex.worktree!, path: 'replacement' } }, historicalSnapshot).ok, false,
      'historical index permits worktree removal, not worktree substitution');
    git(root, ['add', '-f', indexPath]); git(root, ['commit', '-m', 'canonical DONE index']);
    writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 3;\n');
    git(root, ['add', 'packages/main/src/index.ts']); git(root, ['commit', '-m', 'post-DONE material drift']);
    const scopeContext = { scopeContractHash: retained.scopeBinding!.scopeContractHash!, diffPackHash: retained.scopeBinding!.diffPackHash!,
      hunkDigests: retained.scopeBinding!.reviewedHunkDigests, compositeScopeDigest: 'stable-composite-fixture' };
    const retentionCheck = evaluateReviewRunMetadataRetention as (...args: unknown[]) => { ok: boolean; reasons: string[] };
    assert.equal(retentionCheck(store, completedIndex, retained, root, scopeContext).ok, false, 'default metadata retention remains live-strict');
    const historicalRetention = retentionCheck(store, completedIndex, retained, root, scopeContext, historicalSnapshot);
    assert.equal(historicalRetention.ok, true, `historical retention preserves canonical cleanup: ${historicalRetention.reasons}`);
    const summaryPath = `.proof-or-stop/story/actives/${STORY_ID}/summary.json`;
    writeFileSync(join(root, summaryPath), '{"tampered":true}\n');
    git(root, ['add', '-f', summaryPath]); git(root, ['commit', '-m', 'unreceipted closeout artifact mutation']);
    assert.equal(retentionCheck(store, completedIndex, retained, root, scopeContext, historicalSnapshot).ok, false,
      'historical material drift never skips closeout artifact integrity/lineage');
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

process.stdout.write('post-done-closure-snapshot smoke passed\n');
