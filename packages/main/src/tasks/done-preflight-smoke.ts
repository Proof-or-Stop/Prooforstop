#!/usr/bin/env node
/**
 * B-e74e CHK-003 — Regression coverage for DONE main worktree preflight.
 *
 * Proves:
 *   1. DONE rejected (phase stays TEST) when main worktree is on a non-main branch.
 *   2. DONE rejected (phase stays TEST) when main worktree is dirty.
 *   3. DONE succeeds when branch main is owned by a separate registered worktree.
 *   4. done_recover succeeds from a non-main root when branch main is owned elsewhere.
 *   5. The success path is not regressed — a clean main-on-main setup still completes.
 *
 * Uses an isolated temporary git repo so no real developer checkout is touched.
 * The story worktree is linked via `git worktree add` so detectDoneStoryWorktreeContext
 * resolves correctly, then the main repo is put into the test condition AFTER the
 * worktree is linked.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import type { ChecklistData, ClosingSelfCheck, DocsPromise, RealMachineTest, StoryInfo } from '../core/types.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function runKoalaFromCwd(cwd: string, command: string, args: Record<string, unknown>): string {
  const env = { ...process.env };
  delete env.KOALA_PROJECT_ROOT;
  return execFileSync(process.execPath, [cliPath, command, JSON.stringify(args)], {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runKoalaFromCwdExpectFail(cwd: string, command: string, args: Record<string, unknown>): string {
  try {
    runKoalaFromCwd(cwd, command, args);
  } catch (e: any) {
    return [
      e?.stdout?.toString?.() ?? '',
      e?.stderr?.toString?.() ?? '',
      e?.message ?? '',
    ].join('\n');
  }
  assert.fail(`${command} should have failed`);
}

function writeDoneGateEvidence(store: StoryStore, root: string, storyId: string): void {
  const now = '2026-06-04T10:00:00.000Z';
  store.writeTestEvidence(storyId, {
    command: 'done-preflight-smoke',
    output: JSON.stringify({ allPass: true, summary: 'done preflight smoke passed' }),
    result: 'PASS',
    timestamp: now,
    headHash: currentGitHead(root),
    materialHash: currentMaterialHash(root),
    verificationCoverage: {
      total: 0,
      required: 0,
      covered: 0,
      missingRequired: 0,
      entries: [],
    },
  });

  const docsPromises: DocsPromise[] = [];
  const realMachineTests: RealMachineTest[] = [{
    featureId: 'CHK-001',
    transcript: 'DONE preflight smoke: main worktree branch and cleanliness checks verified.',
  }];
  const closingSelfCheck: ClosingSelfCheck = {
    hasRealMachineTest: true,
    hasEdgeCaseCoverage: true,
    hasUnresolvedTodos: false,
    summary: 'DONE preflight main worktree readiness checks verified.',
  };
  store.writeDeliveryCheck(storyId, {
    storyId,
    checkedAt: now,
    reviewRound: '',
    agentId: 'koala-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, ''),
  });
}

/**
 * Build a minimal TEST-phase story with a linked worktree and DONE-gate
 * evidence committed on the story branch. Main stays on branch main throughout
 * this helper — callers mutate it afterwards to create the test condition.
 */
function buildDoneReadyStoryWithLinkedWorktree(
  root: string,
  storyId: string,
): { worktreePath: string; store: StoryStore } {
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'light' },
  }, null, 2));
  write(root, 'README.md', `done-preflight-smoke ${storyId}\n`);
  write(root, '.gitignore', '.worktrees/\n.linked-worktrees/\n.koala/activity.jsonl\n');

  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
  resetConfigCache();

  const now = '2026-06-04T10:00:00.000Z';
  const worktreePath = join(root, '.worktrees', storyId);
  const store = new StoryStore(root);

  const story: StoryInfo = {
    storyId,
    name: 'done-preflight-smoke',
    title: `Done preflight smoke ${storyId}`,
    description: 'Synthetic story for DONE preflight smoke.',
    type: 'chore',
    phase: 'TEST',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    worktree: {
      path: `.worktrees/${storyId}`,
      branch: `story/${storyId}`,
      createdAt: now,
    },
    events: [{ phase: 'TEST' as StoryInfo['phase'], action: 'advance', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic item',
      context: 'Synthetic context',
      status: 'pending',
      startTime: null,
      endTime: null,
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);

  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'story metadata']);
  git(root, ['branch', `story/${storyId}`]);
  git(root, ['worktree', 'add', worktreePath, `story/${storyId}`]);

  resetConfigCache();
  const worktreeStore = new StoryStore(worktreePath);
  writeDoneGateEvidence(worktreeStore, worktreePath, storyId);
  git(worktreePath, ['add', '.']);
  git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'done gate evidence']);

  return { worktreePath, store };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

/**
 * DONE main worktree preflight smoke: PASS
 *
 * When the main worktree is on "main" and clean, DONE completes normally.
 * Regression guard — the new preflight must not break the happy path.
 */
function assertDoneSucceedsWhenMainIsCleanAndOnMain(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-preflight-happy-'));
  try {
    const storyId = 'B-preflight-happy';
    const { worktreePath } = buildDoneReadyStoryWithLinkedWorktree(root, storyId);

    const output = runKoalaFromCwd(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.ok(output.includes(`Story ${storyId} advanced to DONE`), `DONE success expected, got:\n${output}`);
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'DONE', 'story must be DONE on happy path');
    assert.equal(existsSync(worktreePath), false, 'worktree directory must be removed on happy path');
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '', 'story branch must be deleted on happy path');
    console.log('  ✓ DONE main worktree preflight smoke: PASS — happy path not regressed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * DONE main worktree preflight smoke: PASS — main branch registered elsewhere.
 *
 * When the repository's primary worktree is not on branch main but branch main
 * is checked out in another registered worktree, DONE must use that registered
 * main worktree as the merge target.
 */
function assertDoneSucceedsWhenMainBranchOwnedBySeparateWorktree(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-preflight-main-holder-'));
  try {
    const storyId = 'B-preflight-main-holder';
    const { worktreePath } = buildDoneReadyStoryWithLinkedWorktree(root, storyId);
    const mainWorktreePath = join(root, '.linked-worktrees', 'main');

    git(root, ['checkout', '-b', 'root-side-branch']);
    git(root, ['worktree', 'add', mainWorktreePath, 'main']);

    const output = runKoalaFromCwd(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.ok(output.includes(`Story ${storyId} advanced to DONE`), `DONE success expected, got:\n${output}`);
    assert.equal(new StoryStore(mainWorktreePath).readStory(storyId).phase, 'DONE', 'story must be DONE on registered main worktree');
    assert.equal(git(mainWorktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'registered main worktree must remain on main');
    assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), 'root-side-branch', 'primary worktree branch must not be switched');
    assert.equal(existsSync(worktreePath), false, 'story worktree directory must be removed');
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '', 'story branch must be deleted');
    console.log('  ✓ DONE main worktree preflight smoke: PASS — separate registered main worktree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function markStoryBranchAsPartialDone(worktreePath: string, storyId: string): void {
  const store = new StoryStore(worktreePath);
  const story = store.readStory(storyId);
  story.phase = 'DONE';
  story.worktree = undefined;
  story.endedAt = story.endedAt || '2026-06-04T10:30:00.000Z';
  store.writeStory(storyId, story);
  git(worktreePath, ['add', store.storyDirRel()]);
  git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'partial done state']);
}

/**
 * done_recover smoke: PASS — main branch registered elsewhere.
 *
 * Partial-DONE recovery must use the registered worktree that owns branch main,
 * even when the repository root used to invoke done_recover is on another branch.
 */
function assertDoneRecoverUsesSeparateRegisteredMainWorktree(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-recover-main-holder-'));
  try {
    const storyId = 'B-recover-main-holder';
    const { worktreePath } = buildDoneReadyStoryWithLinkedWorktree(root, storyId);
    const mainWorktreePath = join(root, '.linked-worktrees', 'main');

    markStoryBranchAsPartialDone(worktreePath, storyId);
    git(root, ['checkout', '-b', 'root-side-branch']);
    git(root, ['worktree', 'add', mainWorktreePath, 'main']);

    const output = runKoalaFromCwd(root, 'done_recover', { storyId });
    assert.ok(output.includes(`partial-DONE recovered: ${storyId}`), `done_recover success expected, got:\n${output}`);
    assert.equal(new StoryStore(mainWorktreePath).readStory(storyId).phase, 'DONE', 'recovered story must be DONE on registered main worktree');
    assert.equal(git(mainWorktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'registered main worktree must remain on main');
    assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), 'root-side-branch', 'primary worktree branch must not be switched by done_recover');
    assert.equal(existsSync(worktreePath), false, 'story worktree directory must be removed by done_recover');
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '', 'story branch must be deleted by done_recover');
    console.log('  ✓ done_recover smoke: PASS — separate registered main worktree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * phase remains TEST after failed preflight — main on wrong branch.
 *
 * When the main worktree is on a branch other than "main", DONE must be
 * rejected BEFORE writing phase=DONE; the story stays TEST, the worktree
 * survives, and the error message names the actual main worktree path.
 */
function assertDoneRejectsWhenMainOnWrongBranch(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-preflight-wrong-branch-'));
  try {
    const storyId = 'B-preflight-wrong-branch';
    const { worktreePath } = buildDoneReadyStoryWithLinkedWorktree(root, storyId);

    // Switch the main repo to a non-main branch AFTER the story worktree is linked.
    // Git allows this because the worktree holds the story branch, not main.
    git(root, ['checkout', '-b', 'some-other-branch']);

    const output = runKoalaFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(output, /Cannot enter DONE/, 'preflight failure must say "Cannot enter DONE"');
    assert.match(output, /some-other-branch/, 'error must name the offending branch');
    assert.match(output, new RegExp(resolve(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'error must name the actual main worktree path');
    assert.match(output, /git checkout main/, 'error must suggest git checkout main');
    assert.match(output, /phase was not changed/, 'error must confirm phase was not changed');

    // phase=DONE must NEVER be written — story stays TEST in both stores.
    assert.equal(new StoryStore(worktreePath).readStory(storyId).phase, 'TEST', 'wrong-branch preflight must leave worktree story TEST');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'TEST', 'wrong-branch preflight must leave main story TEST');

    // Worktree and branch intact — nothing was cleaned up.
    assert.equal(existsSync(worktreePath), true, 'worktree directory must survive a preflight failure');
    assert.notEqual(git(root, ['branch', '--list', `story/${storyId}`]), '', 'story branch must survive a preflight failure');
    console.log('  ✓ phase remains TEST after failed preflight (main on wrong branch)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * phase remains TEST after failed preflight — main worktree dirty.
 *
 * When the main worktree has uncommitted changes, DONE must be rejected
 * BEFORE writing phase=DONE; the story stays TEST and the error message
 * names the actual main worktree path and provides cd guidance.
 */
function assertDoneRejectsWhenMainIsDirty(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-preflight-dirty-main-'));
  try {
    const storyId = 'B-preflight-dirty-main';
    const { worktreePath } = buildDoneReadyStoryWithLinkedWorktree(root, storyId);

    // Dirty the main checkout with a staged tracked modification AFTER worktree
    // creation. Must be a tracked-file change (not untracked) — untracked files
    // in the main repo are skipped by the preflight (runtime artifacts like
    // .koala/locks/ would otherwise trigger a false positive).
    writeFileSync(join(root, 'README.md'), 'dirty main content that must block DONE\n');
    git(root, ['add', 'README.md']);
    // Verify main is actually dirty (tracked changes).
    assert.notEqual(
      git(root, ['status', '--porcelain', '--untracked-files=no']).trim(),
      '',
      'pre-condition: main must have staged tracked changes',
    );

    const output = runKoalaFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(output, /Cannot enter DONE/, 'dirty main preflight failure must say "Cannot enter DONE"');
    assert.match(output, /uncommitted changes to tracked files/, 'error must mention uncommitted changes to tracked files');
    assert.match(output, new RegExp(resolve(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'error must name the actual main worktree path');
    assert.match(output, /phase was not changed/, 'error must confirm phase was not changed');

    // phase=DONE must NEVER be written.
    assert.equal(new StoryStore(worktreePath).readStory(storyId).phase, 'TEST', 'dirty main preflight must leave worktree story TEST');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'TEST', 'dirty main preflight must leave main story TEST');

    // Worktree intact.
    assert.equal(existsSync(worktreePath), true, 'worktree directory must survive a dirty-main preflight failure');
    assert.notEqual(git(root, ['branch', '--list', `story/${storyId}`]), '', 'story branch must survive a dirty-main preflight failure');
    console.log('  ✓ phase remains TEST after failed preflight (main worktree dirty)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

assertDoneSucceedsWhenMainIsCleanAndOnMain();
assertDoneSucceedsWhenMainBranchOwnedBySeparateWorktree();
assertDoneRecoverUsesSeparateRegisteredMainWorktree();
assertDoneRejectsWhenMainOnWrongBranch();
assertDoneRejectsWhenMainIsDirty();

console.log('✓ done-preflight-smoke passed');
