#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const distRoot = process.env.DONE_PARITY_DIST_ROOT
  ? resolve(process.env.DONE_PARITY_DIST_ROOT)
  : resolve('packages/main/dist');
const load = (path) => import(pathToFileURL(join(distRoot, path)).href);
const [
  { resetConfigCache },
  { currentGitHead, currentMaterialHash },
  { getGuardFailureReason },
  { StoryStore },
  { createDeliveryCheckHandlers },
  { buildDoneClosureRunbook },
  { createPlaybookRuntimeMemoryHandlers },
  { createStoryDispatchHandlers },
  { createReviewRunHandlers },
  { createFindingHandlers },
] = await Promise.all([
  load('core/config.js'),
  load('core/evidence-freshness.js'),
  load('core/machine.js'),
  load('core/store.js'),
  load('handlers/delivery-check.js'),
  load('handlers/done-closure.js'),
  load('handlers/playbook-runtime-memory.js'),
  load('handlers/story-dispatch.js'),
  load('handlers/review-run.js'),
  load('handlers/finding.js'),
]);

// This standalone fixture must also run after validation strips host identity.
process.env.PROOF_OR_STOP_SESSION_ID = 'fixture-done-parity';
process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER = 'codex';

const STORY_ID = 'B-done-parity-red';
const NOW = '2026-09-04T12:00:00.000Z';
let failures = 0;

function write(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function git(root, args) {
  execFileSync('git', args, {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'done-parity-red',
      GIT_AUTHOR_EMAIL: 'done-parity-red@example.invalid',
      GIT_COMMITTER_NAME: 'done-parity-red',
      GIT_COMMITTER_EMAIL: 'done-parity-red@example.invalid',
    },
  });
}

function gitStatus(root) {
  return execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  });
}

function expect(name, condition, detail) {
  if (condition) {
    console.log(`GREEN ${name}`);
    return;
  }
  failures += 1;
  console.error(`RED   ${name}: ${detail}`);
}

function row(rows, id) {
  return rows.find((candidate) => candidate.id === id);
}

function rowText(candidate) {
  return candidate?.detail ?? candidate?.reason ?? '';
}

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-done-parity-red-'));
try {
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
  }, null, 2));
  write(root, 'packages/main/src/index.ts', 'export const stable = true;\n');
  write(root, 'docs/requirements/decisions/parity.md', '# parity fixture\n');
  resetConfigCache();

  git(root, ['init', '-b', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['checkout', '-b', `story/${STORY_ID}`]);
  write(root, 'packages/main/src/index.ts', 'export const stable = true;\nexport const reviewed = true;\n');
  git(root, ['add', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'reviewed story change']);

  const store = new StoryStore(root);
  store.writeStory(STORY_ID, {
    storyId: STORY_ID,
    name: 'done-prepare-done-parity',
    title: 'DONE prepare and DONE parity fixture',
    description: 'Synthetic TEST story proving the two closure surfaces disagree.',
    type: 'bug',
    phase: 'TEST',
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    currentReviewRound: 'round-1',
    events: [],
  });
  store.writeChecklist(STORY_ID, { items: [] });
  const scopeContract = {
    storyId: STORY_ID,
    mode: 'enforce',
    allowedModify: ['packages/main/src/index.ts'],
    allowedCreate: [],
    allowedTest: [],
    protectedFiles: [],
    explicitExcludes: [],
    acknowledgements: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  store.writeScopeContract(STORY_ID, scopeContract);

  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root, 'HEAD', root);
  assert.ok(headHash);
  assert.ok(materialHash);
  store.writeTestEvidence(STORY_ID, {
    command: 'red-done-prepare-done-parity',
    output: JSON.stringify({ allPass: true }),
    result: 'PASS',
    timestamp: NOW,
    headHash,
    materialHash,
  });
  const ctx = { store, root, scanRoot: join(root, 'packages/main'), log: () => {} };
  createDeliveryCheckHandlers(ctx).delivery_check_set({
    storyId: STORY_ID,
    docsPromises: [],
    realMachineTests: [{ featureId: 'done-parity', transcript: 'synthetic executable parity probe' }],
    closingSelfCheck: {
      hasRealMachineTest: true,
      hasEdgeCaseCoverage: true,
      hasUnresolvedTodos: false,
      summary: 'The real DONE guard and done_prepare oracle are compared on identical state.',
    },
    agentId: 'proof-or-stop-review-delivery',
  });

  const missingReason = getGuardFailureReason(STORY_ID, store, 'DONE', root, root) ?? '';
  const missingRows = buildDoneClosureRunbook(ctx, STORY_ID).blockers;
  expect(
    'control: real DONE rejects the missing finish decision',
    missingReason.includes('[missing_dev_memory_finish_decision]'),
    `DONE reason was ${JSON.stringify(missingReason)}`,
  );
  expect(
    'parity: done_prepare oracle rejects the missing finish decision with the same code',
    row(missingRows, 'dev-memory-finish-decision')?.status === 'fail'
      && rowText(row(missingRows, 'dev-memory-finish-decision')).includes('missing_dev_memory_finish_decision'),
    `oracle row was ${JSON.stringify(row(missingRows, 'dev-memory-finish-decision'))}`,
  );

  createPlaybookRuntimeMemoryHandlers(ctx).dev_memory_finish_decision({
    storyId: STORY_ID,
    decision: 'no-reusable-lesson',
    reason: 'synthetic parity fixture',
  });
  const lane = 'proof-or-stop-review-quality';
  const reviewStory = store.readStory(STORY_ID);
  store.writeStory(STORY_ID, { ...reviewStory, phase: 'REVIEW' });
  const priorCwd = process.cwd();
  try {
    process.chdir(root);
    createStoryDispatchHandlers(ctx).dispatch({ storyId: STORY_ID, agentType: lane });
    const runOutput = createReviewRunHandlers(ctx).review_run_start({ storyId: STORY_ID, agent: lane });
    const reviewRunId = runOutput.match(/B-[^:\s]+:RR-\d+/)?.[0];
    assert.ok(reviewRunId, `review_run_start should return a current signed run id: ${runOutput}`);
    const note = 'Signed pass over the pre-closeout material diff pack.';
    createFindingHandlers(ctx).review_pass_set({
      storyId: STORY_ID,
      agent: lane,
      note,
      reviewRunId,
      readManifest: {
        filesReadFully: ['packages/main/src/index.ts'],
        filesTriagedByName: ['docs/requirements/decisions/parity.md'],
        scanEscalationReason: null,
      },
      readEvents: [
        { path: 'packages/main/src/index.ts', action: 'Read' },
        { path: 'docs/requirements/decisions/parity.md', mode: 'triage' },
      ],
    });
  } finally {
    process.chdir(priorCwd);
  }
  store.writeStory(STORY_ID, { ...store.readStory(STORY_ID), phase: 'TEST' });

  // Change only the live diff pack after the pass was signed. HEAD and its
  // materialHash remain unchanged, isolating scopeBinding.diffPackHash drift.
  write(root, 'packages/main/src/index.ts', 'export const stable = true;\nexport const reviewed = true;\nexport const closeoutDrift = true;\n');

  const reviewReason = getGuardFailureReason(STORY_ID, store, 'DONE', root, root) ?? '';
  const storyDir = join(root, '.proof-or-stop/story/actives', STORY_ID);
  const reviewerEvidencePaths = [
    join(storyDir, 'review-runs.json'),
    join(storyDir, 'review-passes.json'),
  ];
  const reviewerEvidenceBefore = reviewerEvidencePaths.map((path) => readFileSync(path));
  const gitStatusBefore = gitStatus(root);
  const reviewRows = buildDoneClosureRunbook(ctx, STORY_ID).blockers;
  const reviewerEvidenceAfter = reviewerEvidencePaths.map((path) => readFileSync(path));
  const gitStatusAfter = gitStatus(root);
  expect(
    'control: real DONE rejects the stale lane diffPackHash',
    reviewReason.includes('[stale_closeout_review]') && reviewReason.includes('diff_pack_changed'),
    `DONE reason was ${JSON.stringify(reviewReason)}`,
  );
  expect(
    'parity: done_prepare oracle rejects the same stale lane diffPackHash with stale_closeout_review',
    row(reviewRows, 'review-verdict')?.status === 'fail'
      && rowText(row(reviewRows, 'review-verdict')).includes('stale_closeout_review')
      && rowText(row(reviewRows, 'review-verdict')).includes('diff_pack_changed'),
    `oracle row was ${JSON.stringify(row(reviewRows, 'review-verdict'))}`,
  );
  const reviewerEvidenceUnchanged = reviewerEvidenceBefore.every(
    (before, index) => before.equals(reviewerEvidenceAfter[index]),
  );
  expect(
    'adversarial: done_prepare parity evaluation leaves reviewer evidence and git state unchanged',
    reviewerEvidenceUnchanged && gitStatusBefore === gitStatusAfter,
    `reviewerEvidenceUnchanged=${reviewerEvidenceUnchanged}; gitStatusBefore=${JSON.stringify(gitStatusBefore)}; gitStatusAfter=${JSON.stringify(gitStatusAfter)}`,
  );

  if (failures > 0) {
    console.error(`\nRED red-done-prepare-done-parity: ${failures} parity assertion(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nGREEN red-done-prepare-done-parity: done_prepare and DONE reject both missing finish decision and stale lane diffPackHash with matching codes');
  }
} finally {
  resetConfigCache();
  rmSync(root, { recursive: true, force: true });
}
