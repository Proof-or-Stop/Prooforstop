#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertRecordedWorktreeRejectsMainCwd();
assertInitCheckChecklistMutationRejectsMainCwd();
assertTerminalStoriesDoNotRedirect();
assertFromDraftCreatesWorktreeThroughCli();

console.log('✓ worktree authority smoke passed');
