#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCommandAllowed, resetConfigCache } from '../core/config.js';
import { signFinding, signReviewPass } from '../core/finding-verify.js';
import { getArtifactContractStatus } from '../core/artifact-contract.js';
import { getGuardFailureReason } from '../core/machine.js';
import { summarizeReviewerStatus } from '../core/reviewer-status.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, Finding, StoryInfo, TestEvidenceData } from '../core/types.js';
import { buildDoneChecklist } from '../handlers/story-advance.js';
import { decorateResult } from '../handlers/hints.js';
import { createSessionHandlers } from '../handlers/session.js';
import { checkCommitAuthor } from '../handlers/validate-channel.js';
import { repairGlobalKoalaLinkBeforeWorktreeDelete } from '../handlers/worktree.js';

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

function localCliPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
}

function makeFinding(storyId: string, agent: string, reviewRound: string, idSuffix: string): Finding {
  const id = `${storyId}:F-${idSuffix}`;
  const createdAt = `2026-04-27T12:00:${idSuffix}.000Z`;
  const desc = `${agent} clean finding`;
  const severity = 'low';
  return {
    id,
    desc,
    severity,
    category: 'happy',
    status: 'resolved',
    agent,
    createdAt,
    reviewRound,
    _hash: signFinding(storyId, id, desc, severity, createdAt, reviewRound),
  };
}

function makeReviewPass(storyId: string, agent: string, reviewRound: string, idSuffix: string) {
  const id = `${storyId}:RP-${idSuffix}`;
  const createdAt = `2026-04-27T12:10:${idSuffix}.000Z`;
  const note = `${agent} checked the story and found no blocking issue`;
  return {
    id,
    agent,
    note,
    createdAt,
    reviewRound,
    _hash: signReviewPass(storyId, id, agent, note, createdAt, reviewRound),
  };
}

function createReviewStore(root: string): { store: StoryStore; storyId: string; reviewRound: string } {
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
  }));
  resetConfigCache();

  const store = new StoryStore(root);
  const storyId = 'B-smoke';
  const now = '2026-04-27T12:00:00.000Z';
  const reviewRound = '2026-04-27T12:01:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'flow-stability-smoke',
    title: 'Flow stability smoke',
    description: 'Synthetic story for REVIEW gate smoke coverage.',
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
    items: ['001', '002', '003'].map((suffix) => ({
      id: `CHK-${suffix}`,
      title: `Done item ${suffix}`,
      context: 'Synthetic checklist item.',
      status: 'done',
      startTime: now,
      endTime: now,
    })),
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  store.writeUnderstanding(storyId, {
    task: 'Check review gate',
    outcome: 'Review gate reports opt-in reviewers',
    facts: [],
    constraints: [],
    unknowns: [],
    touchpoints: ['packages/main/src/core/machine.ts'],
    timestamp: now,
  });
  store.writeDecision(storyId, {
    principles: ['keep gates explicit', 'reuse reviewer routing', 'avoid fixture state leakage'],
    drivers: ['normal channel smoke coverage'],
    options: [
      { name: 'A: shared reviewer routing', pros: ['matches reviewer_list'], cons: ['requires signed fixtures'] },
      { name: 'B: local copy', pros: ['simple'], cons: ['drifts from reviewer_list'] },
    ],
    chosen: 'A: shared reviewer routing',
    rationale: 'normal channel requires multiple real options in the smoke fixture',
    timestamp: now,
  });
  return { store, storyId, reviewRound };
}

function assertSessionBriefGate(): void {
  for (const phase of ['INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE']) {
    assert.equal(isCommandAllowed('session_brief', phase), true, `session_brief should be allowed in ${phase}`);
    assert.equal(isCommandAllowed('next', phase), true, `next should be allowed in ${phase}`);
    assert.equal(
      isCommandAllowed('session_brief', phase, { '*': [], [phase]: [] }),
      true,
      `session_brief should bypass custom phase tools in ${phase}`,
    );
    assert.equal(
      isCommandAllowed('next', phase, { '*': [], [phase]: [] }),
      true,
      `next should bypass custom phase tools in ${phase}`,
    );
  }

  assert.equal(isCommandAllowed('finding_add', 'DEV'), true, 'DEV reviewers should be able to register findings');
  assert.equal(isCommandAllowed('review_pass_set', 'DEV'), true, 'DEV reviewers should be able to register passes');
  assert.equal(
    isCommandAllowed('finding_add', 'DEV', { '*': ['status'], DEV: ['checklist_get'] }),
    false,
    'custom phase tools should still reject unrelated mutation commands',
  );
}

function assertReviewGateUsesOptIn(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-review-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'koala-review-concept', reviewRound, '001'),
        makeFinding(storyId, 'koala-review-quality', reviewRound, '002'),
        makeFinding(storyId, 'koala-review-docs', reviewRound, '003'),
      ],
    });

    const missing = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(missing ?? '', /期望 3 个 reviewer（opt-in: concept,quality,test-coverage）/);
    assert.match(missing ?? '', /缺: test-coverage/);
    assert.match(missing ?? '', /koala-review-docs/);
    assert.doesNotMatch(missing ?? '', /全部 5 个 reviewer/);

    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'koala-review-concept', reviewRound, '004'),
        makeFinding(storyId, 'koala-review-quality', reviewRound, '005'),
      ],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'koala-review-test-coverage', reviewRound, '006'),
      ],
    });
    const pass = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.equal(pass, null);

    const status = summarizeReviewerStatus(store, storyId);
    const byName = new Map(status.entries.map(e => [e.name, e]));
    assert.equal(byName.get('test-coverage')?.verdict, 'pass');
    assert.equal(byName.has('channel'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertReviewerStatusUsesMdFallback(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-doc-review-'));
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
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'docs/review-notes.md', '# Review notes\n\nDocs changed in story branch.\n');
    git(root, ['add', 'docs/review-notes.md']);
    git(root, ['commit', '-m', 'docs change']);

    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'koala-review-concept', reviewRound, '010'),
        makeFinding(storyId, 'koala-review-quality', reviewRound, '011'),
      ],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'koala-review-test-coverage', reviewRound, '012'),
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

    const contract = getArtifactContractStatus(store, storyId, 'TEST', { projectRoot: root });
    const findingsClear = contract.entries.find(entry => entry.name === 'findings-clear');
    assert.equal(findingsClear?.present, false, 'artifact contract should use the same docs reviewer fallback as status');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertSessionBriefStatusHintsMatchGates(): void {
  const reviewRoot = mkdtempSync(join(tmpdir(), 'koala-flow-session-review-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(reviewRoot);
    git(reviewRoot, ['init']);
    git(reviewRoot, ['config', 'user.email', 'koala@example.test']);
    git(reviewRoot, ['config', 'user.name', 'Koala Smoke']);
    git(reviewRoot, ['checkout', '-B', 'main']);
    git(reviewRoot, ['add', '.']);
    git(reviewRoot, ['commit', '-m', 'base']);
    git(reviewRoot, ['checkout', '-b', `story/${storyId}`]);
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
        makeReviewPass(storyId, 'koala-review-concept', reviewRound, '020'),
        makeReviewPass(storyId, 'koala-review-quality', reviewRound, '021'),
        makeReviewPass(storyId, 'koala-review-test-coverage', reviewRound, '022'),
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
    assert.match(reviewNext, /reviewer gate 全部通过/);
    assert.match(reviewNext, /phase=TEST/);

    const testStory = store.readStory(storyId);
    testStory.phase = 'TEST';
    store.writeStory(storyId, testStory);
    const evidence: TestEvidenceData = {
      command: 'koala validate --json',
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
    assert.match(testBrief, /DONE pre-check 还有/);
    assert.match(testBrief, /git add \+ git commit/);
    assert.match(testBrief, /delivery_check_set/);
    assert.match(testBrief, /summary_set/);
    assert.match(nextStep, /git-working-tree, delivery-check, story-summary/);
    assert.match(nextStep, /全部通过后再 story_advance --phase=DONE/);
    assert.match(testBrief, /全部通过后再 story_advance --phase=DONE/);
    assert.doesNotMatch(testBrief, /下一步：story_advance --storyId=B-smoke --phase=DONE/);
    assert.doesNotMatch(testBrief, /下一步：先 git add \+ git commit 提交所有改动，再 advance DONE/);
  } finally {
    rmSync(reviewRoot, { recursive: true, force: true });
  }
}

function assertReviewNextUsesReviewerGateState(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-review-next-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);

    const handlers = createSessionHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    });
    const pendingNext = handlers.next({ concise: true });
    assert.match(pendingNext, /等待 reviewer evidence/);
    assert.match(pendingNext, /story-review/);
    assert.match(pendingNext, /concept/);
    assert.match(pendingNext, /quality/);
    assert.match(pendingNext, /test-coverage/);
    assert.doesNotMatch(pendingNext, /channel/);
    assert.doesNotMatch(pendingNext, /critical\/high finding 全部 resolved/);

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
        agent: 'koala-review-concept',
        createdAt,
        reviewRound,
        _hash: signFinding(storyId, id, desc, severity, createdAt, reviewRound),
      }],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'koala-review-quality', reviewRound, '041'),
        makeReviewPass(storyId, 'koala-review-test-coverage', reviewRound, '042'),
      ],
    });
    const blockerNext = handlers.next({ concise: true });
    assert.match(blockerNext, /1 个 blocking finding/);
    assert.match(blockerNext, /concept\(1\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDevGuidanceUsesReviewPhase(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-dev-guidance-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
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
    assert.doesNotMatch(brief, /phase=TEST 进入验证/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertValidateHintsFollowStoryPhase(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-validate-hint-'));
  try {
    const { store, storyId } = createReviewStore(root);
    const result = JSON.stringify({ provider: 'koala-verifier', allPass: true });
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

function assertRealCliValidateHintFollowsActiveStoryPhase(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-real-cli-validate-'));
  try {
    const { store, storyId } = createReviewStore(root);
    write(root, 'validate-smoke.js', 'console.log(JSON.stringify({ provider: "smoke", status: "pass", allPass: true, summary: "ok", details: [] }));\n');
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
      validate: { command: 'node validate-smoke.js' },
      workflow: { profile: 'balanced' },
    }));
    resetConfigCache();
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const story = store.readStory(storyId);
    story.phase = 'DEV';
    store.writeStory(storyId, story);

    const output = execFileSync('node', [localCliPath(), 'validate', '--json'], {
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

function assertBugUpdateTestHintUsesDonePrecheck(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-bug-hint-'));
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
    assert.doesNotMatch(output, /下一步：story_advance --storyId=.*--phase=DONE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertChannelGateRejectsKoalaSubjectForRealFiles(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-channel-author-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
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
      '-m', 'koala: implement real code',
    ]);
    for (const suffix of ['001', '002', '003']) {
      store.appendProcessEvent(storyId, {
        type: 'subagent_result',
        checklistId: `CHK-${suffix}`,
        success: true,
      });
    }

    const result = checkCommitAuthor(storyId, { store, projectRoot: root });
    assert.equal(result.status, 'fail');
    assert.match(result.summary, /commit 不符合 author 要求/);
    assert.match(result.details.join('\n'), /koala: implement real code/);
    assert.match(result.details.join('\n'), /metadata-only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertChannelGateAcceptsImplementerAuthorWithoutDispatch(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-channel-author-fallback-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/real-code.ts', 'export const realCode = true;\n');
    git(root, ['add', 'packages/main/src/real-code.ts']);
    git(root, [
      '-c', 'user.name=koala-implementer',
      '-c', 'user.email=implementer@example.test',
      'commit',
      '-m', 'implement real code',
    ]);

    const result = checkCommitAuthor(storyId, { store, projectRoot: root });
    assert.equal(result.status, 'pass');
    assert.equal(result.evidenceSource, 'commit_author');
    assert.match(result.summary, /commit author 作为直派执行证据/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDoneChecklistUsesStableOracleRows(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-oracle-row-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);

    const testStory = store.readStory(storyId);
    testStory.phase = 'TEST';
    store.writeStory(storyId, testStory);
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
        makeReviewPass(storyId, 'koala-review-concept', reviewRound, '030'),
        makeReviewPass(storyId, 'koala-review-quality', reviewRound, '031'),
        makeReviewPass(storyId, 'koala-review-test-coverage', reviewRound, '032'),
      ],
    });
    const evidence: TestEvidenceData = {
      command: 'koala validate --json',
      output: JSON.stringify({ allPass: true }),
      result: 'PASS',
      timestamp: '2026-04-27T12:25:00.000Z',
    };
    store.writeTestEvidence(storyId, evidence);
    write(root, 'packages/main/src/core/dirty.ts', 'export const dirty = true;\n');

    const rows = buildDoneChecklist(storyId, store, root);
    const byId = new Map(rows.map(row => [row.id, row]));
    assert.deepEqual(
      ['id', 'status', 'detail', 'hint', 'source', 'blocking'].every(key => key in (byId.get('delivery-check') ?? {})),
      true,
      'delivery-check row should expose the stable oracle contract',
    );
    assert.equal(byId.get('git-working-tree')?.status, 'fail');
    assert.equal(byId.get('git-working-tree')?.source, 'git diff --quiet');
    assert.equal(byId.get('git-working-tree')?.blocking, true);
    assert.match(byId.get('delivery-check')?.hint ?? '', /delivery_check_set/);
    assert.equal(byId.get('delivery-check')?.source, 'delivery-check.json');
    assert.equal(byId.get('story-summary')?.status, 'fail');
    assert.equal(byId.get('story-summary')?.source, 'summary.json');
    assert.equal(byId.get('story-summary')?.blocking, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertGlobalLinkRepair(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-link-'));
  try {
    const mainRepo = join(root, 'repo');
    const worktree = join(root, 'repo', '.worktrees', 'B-smoke');
    const worktreePackage = join(worktree, 'packages', 'main');
    const mainPackage = join(mainRepo, 'packages', 'main');
    const globalPackage = join(root, 'global', 'node_modules', '@koala-agent', 'core');
    mkdirSync(worktreePackage, { recursive: true });
    mkdirSync(mainPackage, { recursive: true });
    mkdirSync(dirname(globalPackage), { recursive: true });
    symlinkSync(worktreePackage, globalPackage, process.platform === 'win32' ? 'junction' : 'dir');

    const repaired = repairGlobalKoalaLinkBeforeWorktreeDelete(worktree, mainRepo, { globalPackagePath: globalPackage });
    assert.equal(repaired.action, 'relinked');
    assert.equal(lstatSync(globalPackage).isSymbolicLink(), true);
    assert.equal(resolve(dirname(globalPackage), readlinkSync(globalPackage)), resolve(mainPackage));

    const otherPackage = join(root, 'other', 'packages', 'main');
    const otherGlobalPackage = join(root, 'other-global', 'node_modules', '@koala-agent', 'core');
    mkdirSync(otherPackage, { recursive: true });
    mkdirSync(dirname(otherGlobalPackage), { recursive: true });
    symlinkSync(otherPackage, otherGlobalPackage, process.platform === 'win32' ? 'junction' : 'dir');
    const skipped = repairGlobalKoalaLinkBeforeWorktreeDelete(worktree, mainRepo, { globalPackagePath: otherGlobalPackage });
    assert.equal(skipped.action, 'skipped');
    assert.equal(resolve(dirname(otherGlobalPackage), readlinkSync(otherGlobalPackage)), resolve(otherPackage));

    const normalInstall = join(root, 'normal-global', 'node_modules', '@koala-agent', 'core');
    mkdirSync(normalInstall, { recursive: true });
    const normalSkipped = repairGlobalKoalaLinkBeforeWorktreeDelete(worktree, mainRepo, { globalPackagePath: normalInstall });
    assert.equal(normalSkipped.action, 'skipped');
    assert.equal(existsSync(normalInstall), true);
    assert.equal(lstatSync(normalInstall).isDirectory(), true);

    const failingGlobalPackage = join(root, 'failing-global', 'node_modules', '@koala-agent', 'core');
    mkdirSync(dirname(failingGlobalPackage), { recursive: true });
    symlinkSync(worktreePackage, failingGlobalPackage, process.platform === 'win32' ? 'junction' : 'dir');

    assert.throws(
      () => repairGlobalKoalaLinkBeforeWorktreeDelete(worktree, mainRepo, {
        globalPackagePath: failingGlobalPackage,
        unlinkImpl: () => {
          throw new Error('mock unlink failure');
        },
      }),
      /已阻止删除 .*mock unlink failure/,
    );
    assert.equal(resolve(dirname(failingGlobalPackage), readlinkSync(failingGlobalPackage)), resolve(worktreePackage));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertSessionBriefGate();
assertReviewGateUsesOptIn();
assertReviewerStatusUsesMdFallback();
assertSessionBriefStatusHintsMatchGates();
assertReviewNextUsesReviewerGateState();
assertDevGuidanceUsesReviewPhase();
assertValidateHintsFollowStoryPhase();
assertRealCliValidateHintFollowsActiveStoryPhase();
assertBugUpdateTestHintUsesDonePrecheck();
assertChannelGateRejectsKoalaSubjectForRealFiles();
assertChannelGateAcceptsImplementerAuthorWithoutDispatch();
assertDoneChecklistUsesStableOracleRows();
assertGlobalLinkRepair();

console.log('✓ flow stability smoke passed');
