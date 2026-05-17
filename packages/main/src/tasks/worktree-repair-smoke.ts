#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo, StoryPhase } from '../core/types.js';

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

function initRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Koala Smoke']);
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
  }, null, 2));
  write(root, '.gitignore', [
    '.worktrees/',
    '.koala/*',
    '!.koala/story/',
    '!.koala/story/**',
    '',
  ].join('\n'));
  write(root, 'README.md', 'worktree repair smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  resetConfigCache();
  return root;
}

function story(storyId: string, phase: StoryPhase, worktree = false): StoryInfo {
  const now = '2026-05-01T12:00:00.000Z';
  return {
    storyId,
    name: `${storyId.toLowerCase()}-worktree-repair-smoke`,
    title: `${storyId} worktree repair smoke`,
    description: 'Synthetic story for terminal worktree repair smoke.',
    type: 'chore',
    phase,
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: phase === 'DONE' || phase === 'DISCARDED' ? now : null,
    events: [{ phase, action: phase === 'DONE' ? 'advance' : 'create', timestamp: now }],
    ...(worktree ? {
      worktree: {
        path: `.worktrees/${storyId}`,
        branch: `story/${storyId}`,
        createdAt: now,
      },
    } : {}),
  };
}

function commitStories(root: string): void {
  git(root, ['add', '.koala/story/actives']);
  git(root, ['commit', '-m', 'add smoke story metadata']);
}

function addStoryWorktree(root: string, storyId: string): void {
  git(root, ['branch', `story/${storyId}`]);
  git(root, ['worktree', 'add', join(root, '.worktrees', storyId), `story/${storyId}`]);
}

async function runKoala(root: string, command: string, args: Record<string, unknown>): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, command, JSON.stringify(args)], {
      cwd: root,
      env: { ...process.env, KOALA_PROJECT_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

async function runKoalaExpectFail(root: string, command: string, args: Record<string, unknown>): Promise<string> {
  try {
    await runKoala(root, command, args);
  } catch (e: any) {
    return e?.message || String(e);
  }
  assert.fail(`${command} should have failed`);
}

async function assertDoctorRepairCleansAndProtects(): Promise<void> {
  const root = initRepo('koala-worktree-repair-');
  const outsideUserDir = mkdtempSync(join(tmpdir(), 'koala-user-dir-'));
  try {
    const store = new StoryStore(root);
    store.writeStory('B-termreg', story('B-termreg', 'DONE', true));
    store.writeStory('B-orphan', story('B-orphan', 'DISCARDED'));
    store.writeStory('B-prune', story('B-prune', 'DONE', true));
    store.writeStory('B-ignored', story('B-ignored', 'DONE'));
    store.writeStory('B-active', story('B-active', 'DEV', true));
    commitStories(root);

    addStoryWorktree(root, 'B-termreg');
    addStoryWorktree(root, 'B-prune');
    addStoryWorktree(root, 'B-active');
    git(root, ['branch', 'unrelated/keep-me']);

    mkdirSync(join(root, '.worktrees', 'B-orphan'), { recursive: true });
    writeFileSync(join(root, '.worktrees', 'B-orphan', 'runtime.log'), 'orphan residue\n');
    mkdirSync(join(root, '.worktrees', 'B-ignored'), { recursive: true });
    writeFileSync(join(root, '.worktrees', 'B-ignored', '.koala-repair-ignore'), 'already quarantined\n');
    writeFileSync(join(outsideUserDir, 'B-orphan'), 'outside worktreeDir must never be touched\n');
    rmSync(join(root, '.worktrees', 'B-prune'), { recursive: true, force: true });

    const before = JSON.parse(await runKoala(root, 'doctor', { format: 'json' }));
    assert.equal(before.worktrees.needsRepair, true);
    assert.equal(before.partialDone.needsRecovery, false, 'terminal/active worktree residue is not partial-DONE');
    assert(before.worktrees.terminalRegistered.some((p: string) => p.includes('B-termreg')));
    assert(before.worktrees.orphanDirs.some((p: string) => p.includes('B-orphan')));

    const repaired = JSON.parse(await runKoala(root, 'doctor', { format: 'json', repair: true }));
    assert.equal(repaired.worktrees.needsRepair, false, 'doctor --repair should clear reported terminal/orphan targets');
    assert.deepEqual(repaired.worktrees.terminalRegistered, []);
    assert.deepEqual(repaired.worktrees.orphanDirs, []);
    assert.deepEqual(repaired.worktrees.terminalDirs, []);
    assert.equal(existsSync(join(root, '.worktrees', 'B-termreg')), false);
    assert.equal(existsSync(join(root, '.worktrees', 'B-orphan')), false);
    assert.equal(existsSync(join(root, '.worktrees', 'B-prune')), false);
    assert.equal(existsSync(join(root, '.worktrees', 'B-ignored')), true, 'quarantined dirs are left in place');
    assert.equal(existsSync(join(outsideUserDir, 'B-orphan')), true, 'outside user dirs are not touched');
    assert.match(git(root, ['worktree', 'list', '--porcelain']), /branch refs\/heads\/story\/B-active/);
    assert.notEqual(git(root, ['branch', '--list', 'story/B-active']), '');
    assert.notEqual(git(root, ['branch', '--list', 'unrelated/keep-me']), '');
    assert.equal(git(root, ['branch', '--list', 'story/B-termreg']), '', 'terminal story branch should be deleted');
    assert.equal(git(root, ['branch', '--list', 'story/B-prune']), '', 'prunable terminal story branch should be deleted');

    const storyList = await runKoala(root, 'story_list', {});
    assert.doesNotMatch(storyList, /Terminal worktrees/, 'ignored terminal dirs should not show in story_list bug summary');
    assert.doesNotMatch(storyList, /\[terminal-worktree\]/, 'ignored terminal dirs should not label stories');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideUserDir, { recursive: true, force: true });
  }
}

async function assertStoryDiscardRepairsMissingRegistry(): Promise<void> {
  const root = initRepo('koala-discard-registry-repair-');
  try {
    const store = new StoryStore(root);
    store.writeStory('B-discard', story('B-discard', 'INIT_CHECK', true));
    commitStories(root);
    addStoryWorktree(root, 'B-discard');
    rmSync(join(root, '.worktrees', 'B-discard'), { recursive: true, force: true });

    const output = await runKoala(root, 'story_discard', {
      storyId: 'B-discard',
      force: true,
      reason: 'smoke registry repair',
    });

    assert.match(output, /stale worktree metadata 已 prune|stale git worktree admin 已清理/);
    assert.equal(new StoryStore(root).readStory('B-discard').phase, 'DISCARDED');
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), /story\/B-discard/);
    assert.equal(git(root, ['branch', '--list', 'story/B-discard']), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function buildPartialDone(root: string, storyId: string): string {
  const store = new StoryStore(root);
  store.writeStory(storyId, story(storyId, 'INIT_CHECK', true));
  commitStories(root);
  addStoryWorktree(root, storyId);
  const worktreePath = join(root, '.worktrees', storyId);
  const worktreeStore = new StoryStore(worktreePath);
  worktreeStore.writeStory(storyId, story(storyId, 'DONE'));
  git(worktreePath, ['add', '.koala/story/actives']);
  git(worktreePath, ['commit', '-m', `koala: mark ${storyId} DONE + clear worktree`]);
  return worktreePath;
}

async function assertDoctorDetectsPartialDoneAndRecoverRepairs(): Promise<void> {
  const root = initRepo('koala-partial-done-recover-');
  try {
    const storyId = 'B-partial';
    const worktreePath = buildPartialDone(root, storyId);

    const before = JSON.parse(await runKoala(root, 'doctor', { format: 'json' }));
    assert.equal(before.partialDone.needsRecovery, true);
    assert.equal(before.partialDone.stories.length, 1);
    assert.equal(before.partialDone.stories[0].storyId, storyId);
    assert.equal(before.partialDone.stories[0].mergeTreeClean, true);

    const text = await runKoala(root, 'doctor', {});
    assert.match(text, /Partial-DONE scan:/);
    assert.match(text, new RegExp(`koala done_recover --storyId=${storyId}`));

    const recovered = await runKoala(root, 'done_recover', { storyId });
    assert.match(recovered, new RegExp(`partial-DONE recovered: ${storyId}`));
    assert.match(recovered, new RegExp(`story/${storyId} merged into main`));

    const after = JSON.parse(await runKoala(root, 'doctor', { format: 'json' }));
    assert.equal(after.partialDone.needsRecovery, false);
    assert.equal(after.worktrees.needsRepair, false);
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'DONE');
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '');
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`));
    assert.equal(existsSync(worktreePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDoneRecoverRefusesDirtyMain(): Promise<void> {
  const root = initRepo('koala-partial-done-dirty-main-');
  try {
    const storyId = 'B-partial-dirty';
    buildPartialDone(root, storyId);
    writeFileSync(join(root, 'dirty.txt'), 'dirty main must block done_recover\n');

    const output = await runKoalaExpectFail(root, 'done_recover', { storyId });
    assert.match(output, /main worktree is not clean/);
    assert.notEqual(git(root, ['branch', '--list', `story/${storyId}`]), '');
    const stillPartial = JSON.parse(await runKoala(root, 'doctor', { format: 'json' }));
    assert.equal(stillPartial.partialDone.needsRecovery, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDoneRecoverRefusesMergeTreeConflict(): Promise<void> {
  const root = initRepo('koala-partial-done-conflict-');
  try {
    const storyId = 'B-partial-conflict';
    const store = new StoryStore(root);
    store.writeStory(storyId, story(storyId, 'INIT_CHECK', true));
    write(root, 'conflict.txt', 'base\n');
    commitStories(root);
    addStoryWorktree(root, storyId);
    const worktreePath = join(root, '.worktrees', storyId);
    writeFileSync(join(worktreePath, 'conflict.txt'), 'story branch version\n');
    const worktreeStore = new StoryStore(worktreePath);
    worktreeStore.writeStory(storyId, story(storyId, 'DONE'));
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['commit', '-m', `koala: mark ${storyId} DONE with conflict`]);

    writeFileSync(join(root, 'conflict.txt'), 'main branch version\n');
    git(root, ['add', 'conflict.txt']);
    git(root, ['commit', '-m', 'main edits conflict']);

    const before = JSON.parse(await runKoala(root, 'doctor', { format: 'json' }));
    assert.equal(before.partialDone.needsRecovery, true);
    assert.equal(before.partialDone.stories[0].mergeTreeClean, false);

    const output = await runKoalaExpectFail(root, 'done_recover', { storyId });
    assert.match(output, /cannot merge cleanly into main/);
    assert.notEqual(git(root, ['branch', '--list', `story/${storyId}`]), '');
    assert.match(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDoneRecoverRefusesMissingBranchWithoutDeletingUnrelated(): Promise<void> {
  const root = initRepo('koala-partial-done-missing-branch-');
  try {
    const storyId = 'B-missing-branch';
    const store = new StoryStore(root);
    store.writeStory(storyId, story(storyId, 'DONE'));
    commitStories(root);
    git(root, ['branch', 'story/B-unrelated']);

    const output = await runKoalaExpectFail(root, 'done_recover', { storyId });
    assert.match(output, /not a recoverable partial-DONE story/);
    assert.notEqual(git(root, ['branch', '--list', 'story/B-unrelated']), '', 'unrelated story branch must not be deleted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await assertDoctorRepairCleansAndProtects();
await assertStoryDiscardRepairsMissingRegistry();
await assertDoctorDetectsPartialDoneAndRecoverRepairs();
await assertDoneRecoverRefusesDirtyMain();
await assertDoneRecoverRefusesMergeTreeConflict();
await assertDoneRecoverRefusesMissingBranchWithoutDeletingUnrelated();

console.log('✓ worktree repair smoke passed');
