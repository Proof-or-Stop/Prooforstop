#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, ClosingSelfCheck, DocsPromise, RealMachineTest, StoryInfo } from '../core/types.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { signDeliveryCheck } from '../handlers/delivery-check.js';
import { assertCwdInWorktree } from '../handlers/context.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function gitSucceeds(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function runKoala(root: string, command: string, args: Record<string, unknown>): string {
  return execFileSync(process.execPath, [cliPath, command, JSON.stringify(args)], {
    cwd: root,
    env: { ...process.env, KOALA_PROJECT_ROOT: root },
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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

function runKoalaExpectFail(root: string, command: string, args: Record<string, unknown>): string {
  try {
    runKoala(root, command, args);
  } catch (e: any) {
    return [
      e?.stdout?.toString?.() ?? '',
      e?.stderr?.toString?.() ?? '',
      e?.message ?? '',
    ].join('\n');
  }
  assert.fail(`${command} should have failed`);
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

function validBackground(): string {
  return [
    '## 触发事件',
    '2026-05-08 B-from-draft smoke reproduces the field report where story_create fromDraft reached INIT_CHECK but did not create a worktree, leaving the next command unable to proceed without manual git worktree add.',
    '',
    '## 关键洞察',
    'The draft path already has reviewed story material, so the missing behavior is not planning validation. The CLI must run the same worktree bootstrap that story_advance INIT_CHECK uses after materializing the story.',
    '',
    '## 方案取舍',
    'The smoke keeps the story tiny and validates the user visible path. It prefers exercising the public CLI over importing private helper internals because the bug lived in CLI orchestration.',
    '',
    '## 对话纹理',
    'A user expects a completed from-draft command to print the worktree path and a direct cd instruction. Seeing phase INIT_CHECK without a directory is confusing and blocks the workflow.',
    '',
  ].join('\n');
}

function writeStory(store: StoryStore, storyId: string, phase: StoryInfo['phase'], worktree?: StoryInfo['worktree']): void {
  const now = '2026-05-08T10:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'worktree-authority-smoke',
    title: 'Worktree authority smoke',
    description: 'Synthetic story for worktree authority.',
    type: 'chore',
    phase,
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: phase === 'DONE' ? now : null,
    ...(worktree ? { worktree } : {}),
    events: [{ phase, action: 'advance', timestamp: now }],
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
}

function assertRecordedWorktreeRejectsMainCwd(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-authority-recorded-'));
  const previousCwd = process.cwd();
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
    }, null, 2));
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    write(root, 'README.md', 'authority smoke\n');
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
    resetConfigCache();
    const store = new StoryStore(root);
    const storyId = 'B-authority';
    const worktreePath = join(root, '.worktrees', storyId);
    mkdirSync(dirname(worktreePath), { recursive: true });
    git(root, ['branch', `story/${storyId}`]);
    git(root, ['worktree', 'add', worktreePath, `story/${storyId}`]);
    writeStory(store, storyId, 'PLAN', {
      path: `.worktrees/${storyId}`,
      branch: `story/${storyId}`,
      createdAt: '2026-05-08T10:00:00.000Z',
    });

    process.chdir(root);
    assert.throws(
      () => assertCwdInWorktree(store, storyId),
      /必须在 worktree 里执行 koala 命令/,
    );
    process.chdir(worktreePath);
    assert.doesNotThrow(() => assertCwdInWorktree(store, storyId));
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

function assertInitCheckChecklistMutationRejectsMainCwd(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-authority-init-check-'));
  const previousCwd = process.cwd();
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
    }, null, 2));
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    write(root, 'README.md', 'init check authority smoke\n');
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
    resetConfigCache();
    const store = new StoryStore(root);
    const storyId = 'B-init-authority';
    const worktreePath = join(root, '.worktrees', storyId);
    mkdirSync(dirname(worktreePath), { recursive: true });
    git(root, ['branch', `story/${storyId}`]);
    git(root, ['worktree', 'add', worktreePath, `story/${storyId}`]);
    writeStory(store, storyId, 'INIT_CHECK', {
      path: `.worktrees/${storyId}`,
      branch: `story/${storyId}`,
      createdAt: '2026-05-08T10:00:00.000Z',
    });

    process.chdir(root);
    const output = runKoalaExpectFail(root, 'checklist_add', {
      storyId,
      title: 'Should not land in main',
      context: 'INIT_CHECK linked stories must still use the story worktree authority.',
    });
    assert.match(output, /必须在 worktree 里执行 koala 命令/);
    assert.equal(new StoryStore(root).readChecklist(storyId).items.length, 1);
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

function assertTerminalStoriesDoNotRedirect(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-authority-terminal-'));
  const previousCwd = process.cwd();
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
    }, null, 2));
    resetConfigCache();
    const store = new StoryStore(root);
    writeStory(store, 'B-done', 'DONE', {
      path: '.worktrees/B-done',
      branch: 'story/B-done',
      createdAt: '2026-05-08T10:00:00.000Z',
    });
    process.chdir(root);
    assert.doesNotThrow(() => assertCwdInWorktree(store, 'B-done'));
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

function assertFromDraftCreatesWorktreeThroughCli(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-from-draft-worktree-'));
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
    }, null, 2));
    write(root, 'README.md', 'from draft smoke\n');
    write(root, '.gitignore', '.worktrees/\n.koala/activity.jsonl\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
    resetConfigCache();

    runKoala(root, 'story_draft', {
      name: 'from-draft-smoke',
      title: 'From draft smoke story',
      description: 'Synthetic from-draft story for worktree bootstrap.',
      type: 'chore',
      priority: 'medium',
      background: validBackground(),
      checklist: [{
        title: 'Create worktree from draft',
        context: 'The fromDraft CLI path must bootstrap the worktree automatically.',
      }],
    });
    runKoala(root, 'draft_check_set', {
      draftName: 'from-draft-smoke',
      issues: [],
      agentId: 'koala-review-story-init',
    });
    const output = runKoala(root, 'story_create', { fromDraft: 'from-draft-smoke' });
    const storyId = output.match(/Story\s+(B-[a-f0-9]+)/)?.[1];
    assert.ok(storyId, `story_create --from-draft should print story id, got: ${output}`);
    const story = new StoryStore(root).readStory(storyId);
    assert.equal(story.phase, 'INIT_CHECK');
    assert.ok(story.worktree?.path, 'fromDraft story should record worktree metadata');
    assert.match(output, /worktree/i, 'fromDraft output should include worktree bootstrap result');
    assert.match(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`));
    assert.equal(git(root, ['status', '--porcelain']), '', 'fromDraft should leave main clean after bootstrap');
    assert.equal(
      gitSucceeds(root, ['merge-base', '--is-ancestor', 'main', `story/${storyId}`]),
      true,
      'fromDraft story branch should contain current main after bootstrap',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertFromDraftCreatesWorktreeWithDirtyMainPreserved(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-from-draft-dirty-main-'));
  const draftName = 'from-draft-dirty-main-smoke';
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
    }, null, 2));
    write(root, 'README.md', 'from draft dirty main smoke\n');
    write(root, '.gitignore', '.worktrees/\n.koala/activity.jsonl\n');
    write(root, 'unrelated-tracked.txt', 'tracked baseline\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
    resetConfigCache();

    runKoala(root, 'story_draft', {
      name: draftName,
      title: 'From draft dirty main smoke story',
      description: 'Synthetic from-draft story for dirty main preservation.',
      type: 'chore',
      priority: 'medium',
      background: validBackground(),
      checklist: [{
        title: 'Create worktree from draft while main has unrelated edits',
        context: 'The fromDraft CLI path must commit bounded metadata without consuming user changes.',
      }],
    });
    runKoala(root, 'draft_check_set', {
      draftName,
      issues: [],
      agentId: 'koala-review-story-init',
    });
    git(root, ['add', '--', `docs/story/drafts/${draftName}`]);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'draft metadata']);

    write(root, 'unrelated-tracked.txt', 'tracked user edit that must remain dirty\n');
    write(root, 'unrelated-untracked.txt', 'untracked user edit that must remain dirty\n');
    const dirtyBefore = git(root, ['status', '--porcelain']);
    assert.equal(git(root, ['diff', '--name-only', '--', 'unrelated-tracked.txt']), 'unrelated-tracked.txt');
    assert.match(dirtyBefore, /\?\? unrelated-untracked\.txt/);

    const output = runKoala(root, 'story_create', { fromDraft: draftName });
    const storyId = output.match(/Story\s+(B-[a-f0-9]+)/)?.[1];
    assert.ok(storyId, `story_create --from-draft should print story id, got: ${output}`);
    const story = new StoryStore(root).readStory(storyId);
    assert.equal(story.phase, 'INIT_CHECK');
    assert.ok(story.worktree?.path, 'fromDraft story should record worktree metadata');
    assert.match(output, /main merged into story\//, 'fromDraft output should confirm main was merged into the story branch');
    assert.equal(
      git(root, ['status', '--porcelain', '--', `.koala/story/actives/${storyId}`, `docs/story/drafts/${draftName}`]),
      '',
      'fromDraft should leave bounded story/draft metadata clean after committing',
    );
    const dirtyAfter = git(root, ['status', '--porcelain']);
    assert.equal(
      git(root, ['diff', '--name-only', '--', 'unrelated-tracked.txt']),
      'unrelated-tracked.txt',
      'tracked user edits should remain dirty',
    );
    assert.match(dirtyAfter, /\?\? unrelated-untracked\.txt/, 'untracked user edits should remain dirty');
    assert.equal(
      gitSucceeds(root, ['merge-base', '--is-ancestor', 'main', `story/${storyId}`]),
      true,
      'fromDraft story branch should contain current main after dirty-main bootstrap',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeDoneGateEvidence(store: StoryStore, root: string, storyId: string): void {
  const now = '2026-05-08T10:00:00.000Z';
  store.writeTestEvidence(storyId, {
    command: 'worktree authority smoke',
    output: JSON.stringify({ allPass: true, summary: 'nested DONE cleanup smoke passed' }),
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
    featureId: 'nested-done-cleanup',
    transcript: 'koala story_advance DONE was invoked from PVSC/child and cleaned the canonical worktree root.',
  }];
  const closingSelfCheck: ClosingSelfCheck = {
    hasRealMachineTest: true,
    hasEdgeCaseCoverage: true,
    hasUnresolvedTodos: false,
    summary: 'Nested cwd DONE cleanup path verified.',
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

function assertDoneFromNestedCwdUsesCanonicalWorktreeRoot(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-nested-done-cleanup-'));
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
      workflow: { profile: 'light' },
    }, null, 2));
    write(root, 'README.md', 'nested done cleanup smoke\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
    resetConfigCache();

    const storyId = 'B-nested-done';
    const worktreePath = join(root, '.worktrees', storyId);
    const store = new StoryStore(root);
    writeStory(store, storyId, 'TEST', {
      path: `.worktrees/${storyId}`,
      branch: `story/${storyId}`,
      createdAt: '2026-05-08T10:00:00.000Z',
    });
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'story metadata']);
    git(root, ['branch', `story/${storyId}`]);
    git(root, ['worktree', 'add', worktreePath, `story/${storyId}`]);

    resetConfigCache();
    const worktreeStore = new StoryStore(worktreePath);
    writeDoneGateEvidence(worktreeStore, worktreePath, storyId);
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'done gate evidence']);

    const nestedCwd = join(worktreePath, 'PVSC', 'child');
    mkdirSync(nestedCwd, { recursive: true });
    writeFileSync(join(nestedCwd, 'runtime.txt'), 'runtime residue that must not become the cleanup root\n');

    const output = runKoalaFromCwd(nestedCwd, 'story_advance', { storyId, phase: 'DONE' });
    assert.doesNotMatch(output, /PVSC/, 'DONE output must not target the nested invocation cwd');
    assert.doesNotMatch(output, new RegExp(nestedCwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'DONE output must not mention the child cwd as cleanup target');

    const doneStory = new StoryStore(root).readStory(storyId);
    assert.equal(doneStory.phase, 'DONE');
    assert.equal(doneStory.worktree, undefined, 'main metadata should clear worktree after DONE merge');
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '', 'story branch should be deleted');
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`), 'worktree registry should be clean');
    assert.equal(existsSync(worktreePath), false, 'canonical worktree directory should be removed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDoneRejectsMismatchedStoryBranchBeforeMutation(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-mismatched-done-branch-'));
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
      workflow: { profile: 'light' },
    }, null, 2));
    write(root, 'README.md', 'mismatched done branch smoke\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
    resetConfigCache();

    const storyId = 'B-expected';
    const wrongBranch = 'story/B-other';
    const worktreePath = join(root, '.worktrees', storyId);
    const store = new StoryStore(root);
    writeStory(store, storyId, 'TEST', {
      path: `.worktrees/${storyId}`,
      branch: `story/${storyId}`,
      createdAt: '2026-05-08T10:00:00.000Z',
    });
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'story metadata']);
    git(root, ['branch', wrongBranch]);
    git(root, ['worktree', 'add', worktreePath, wrongBranch]);
    write(root, 'main-only-after-wrong-story-branch.txt', 'main commit that must not auto-merge before wrong-branch rejection\n');
    git(root, ['add', 'main-only-after-wrong-story-branch.txt']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'main moves after wrong story branch checkout']);
    const mainHeadAfterCheckout = git(root, ['rev-parse', 'main']);

    resetConfigCache();
    const worktreeStore = new StoryStore(worktreePath);
    writeDoneGateEvidence(worktreeStore, worktreePath, storyId);
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'done gate evidence on wrong branch']);

    const output = runKoalaFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(output, /detected branch story\/B-other but expected story\/B-expected/);
    assert.match(output, /merge\/delete aborted before mutating story state/);
    assert.equal(new StoryStore(worktreePath).readStory(storyId).phase, 'TEST', 'wrong branch must not mark story DONE');
    assert.equal(gitSucceeds(root, ['merge-base', '--is-ancestor', mainHeadAfterCheckout, wrongBranch]), false, 'wrong branch must not be auto-synced with main before rejection');
    assert.equal(existsSync(join(worktreePath, 'main-only-after-wrong-story-branch.txt')), false, 'wrong branch worktree must not receive main-only files before rejection');
    assert.notEqual(git(root, ['branch', '--list', wrongBranch]), '', 'wrong branch must not be deleted');
    assert.match(git(root, ['worktree', 'list', '--porcelain']), new RegExp(wrongBranch), 'wrong worktree must remain registered');
    assert.equal(existsSync(worktreePath), true, 'wrong worktree directory must not be removed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDoneRejectsNonStoryLinkedWorktreeBeforeMutation(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-non-story-done-branch-'));
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
      workflow: { profile: 'light' },
    }, null, 2));
    write(root, 'README.md', 'non-story done branch smoke\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
    resetConfigCache();

    const storyId = 'B-non-story';
    const wrongBranch = 'feature/not-story';
    const worktreePath = join(root, '.worktrees', storyId);
    const store = new StoryStore(root);
    writeStory(store, storyId, 'TEST', {
      path: `.worktrees/${storyId}`,
      branch: `story/${storyId}`,
      createdAt: '2026-05-08T10:00:00.000Z',
    });
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'story metadata']);
    git(root, ['branch', wrongBranch]);
    git(root, ['worktree', 'add', worktreePath, wrongBranch]);
    write(root, 'main-only-after-non-story-branch.txt', 'main commit that must not auto-merge before non-story rejection\n');
    git(root, ['add', 'main-only-after-non-story-branch.txt']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'main moves after non-story branch checkout']);
    const mainHeadAfterCheckout = git(root, ['rev-parse', 'main']);

    resetConfigCache();
    const worktreeStore = new StoryStore(worktreePath);
    writeDoneGateEvidence(worktreeStore, worktreePath, storyId);
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'done gate evidence on non-story branch']);

    const output = runKoalaFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(output, /detected branch feature\/not-story but expected story\/B-non-story/);
    assert.match(output, /merge\/delete aborted before mutating story state/);
    assert.equal(new StoryStore(worktreePath).readStory(storyId).phase, 'TEST', 'non-story branch must not mark worktree story DONE');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'TEST', 'non-story branch must not mutate main story metadata');
    assert.equal(gitSucceeds(root, ['merge-base', '--is-ancestor', mainHeadAfterCheckout, wrongBranch]), false, 'non-story branch must not be auto-synced with main before rejection');
    assert.equal(existsSync(join(worktreePath, 'main-only-after-non-story-branch.txt')), false, 'non-story worktree must not receive main-only files before rejection');
    assert.notEqual(git(root, ['branch', '--list', wrongBranch]), '', 'non-story branch must not be deleted');
    assert.match(git(root, ['worktree', 'list', '--porcelain']), new RegExp(wrongBranch), 'non-story worktree must remain registered');
    assert.equal(existsSync(worktreePath), true, 'non-story worktree directory must not be removed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertRecordedWorktreeRejectsMainCwd();
assertInitCheckChecklistMutationRejectsMainCwd();
assertTerminalStoriesDoNotRedirect();
assertFromDraftCreatesWorktreeThroughCli();
assertFromDraftCreatesWorktreeWithDirtyMainPreserved();
assertDoneFromNestedCwdUsesCanonicalWorktreeRoot();
assertDoneRejectsMismatchedStoryBranchBeforeMutation();
assertDoneRejectsNonStoryLinkedWorktreeBeforeMutation();

console.log('✓ worktree authority smoke passed');
