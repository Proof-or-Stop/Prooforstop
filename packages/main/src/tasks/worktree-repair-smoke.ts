#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo, StoryPhase } from '../core/types.js';
import { repairGlobalLatticeLinkBeforeWorktreeDelete } from '../handlers/worktree.js';

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
  git(root, ['config', 'user.name', 'Lattice Smoke']);
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
  }, null, 2));
  write(root, '.gitignore', [
    '.worktrees/',
    '.lattice/*',
    '!.lattice/story/',
    '!.lattice/story/**',
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
  git(root, ['add', '.lattice/story/actives']);
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
      env: { ...process.env, LATTICE_PROJECT_ROOT: root },
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
    writeFileSync(join(root, '.worktrees', 'B-ignored', '.lattice-repair-ignore'), 'already quarantined\n');
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

function assertMixedCanonicalLegacyGlobalLinksAreRepaired(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-mixed-global-link-'));
  try {
    const globalRoot = join(root, 'global-node-modules');
    const canonicalPath = join(globalRoot, '@lattice-agent', 'core');
    const legacyPath = join(globalRoot, '@koala-agent', 'core');
    const worktreePath = join(root, '.worktrees', 'B-mixed');
    const mainPackagePath = join(root, 'packages', 'main');

    mkdirSync(canonicalPath, { recursive: true });
    mkdirSync(dirname(legacyPath), { recursive: true });
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(mainPackagePath, { recursive: true });
    symlinkSync(worktreePath, legacyPath, 'dir');

    const result = repairGlobalLatticeLinkBeforeWorktreeDelete(worktreePath, root, {
      globalPackageRoot: globalRoot,
    });

    assert.equal(result.action, 'relinked');
    assert.match(result.message, /@koala-agent\/core \(legacy fallback/);
    assert.equal(lstatSync(canonicalPath).isDirectory(), true, 'canonical install should remain untouched when it is not the stale symlink');
    assert.equal(lstatSync(legacyPath).isSymbolicLink(), true, 'legacy global package should remain a symlink after repair');
    assert.equal(resolve(dirname(legacyPath), readlinkSync(legacyPath)), mainPackagePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

    assert.match(output, /stale worktree metadata pruned|stale git worktree admin cleaned/);
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
  git(worktreePath, ['add', '.lattice/story/actives']);
  git(worktreePath, ['commit', '-m', `lattice: mark ${storyId} DONE + clear worktree`]);
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
    assert.match(text, new RegExp(`lattice done_recover --storyId=${storyId}`));

    const recovered = await runKoala(root, 'done_recover', { storyId });
    assert.match(recovered, new RegExp(`partial-DONE recovered: ${storyId}`));
    assert.match(recovered, new RegExp(`story/${storyId} merged into main`));
    assert.match(recovered, new RegExp(`Worktree .*${storyId}.*removed`), 'operator transcript must report worktree removal');
    assert.match(recovered, new RegExp(`story/${storyId} deleted`), 'operator transcript must report branch deletion');

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

async function assertDoneRecoverUsesDoneMainMergeLock(): Promise<void> {
  const root = initRepo('koala-partial-done-live-lock-');
  try {
    const storyId = 'B-partial-lock';
    buildPartialDone(root, storyId);
    mkdirSync(join(root, '.lattice', 'locks', 'main-write.lock'), { recursive: true });

    const output = await runKoalaExpectFail(root, 'done_recover', { storyId });
    assert.match(output, /DONE main merge lock is held/, 'done_recover must use the same DONE main merge lock');
    assert.notEqual(git(root, ['branch', '--list', `story/${storyId}`]), '');
    const stillPartial = JSON.parse(await runKoala(root, 'doctor', { format: 'json' }));
    assert.equal(stillPartial.partialDone.needsRecovery, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDoneRecoverRefusesDirtyStoryWorktree(): Promise<void> {
  const root = initRepo('koala-partial-done-dirty-worktree-');
  try {
    const storyId = 'B-partial-worktree-dirty';
    const worktreePath = buildPartialDone(root, storyId);
    writeFileSync(join(worktreePath, 'local-draft.txt'), 'draft that recovery must not delete\n');

    const output = await runKoalaExpectFail(root, 'done_recover', { storyId });
    assert.match(output, /story worktree is not clean/);
    assert.equal(existsSync(join(worktreePath, 'local-draft.txt')), true, 'dirty worktree file must survive refused recovery');
    assert.notEqual(git(root, ['branch', '--list', `story/${storyId}`]), '');
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
    git(worktreePath, ['commit', '-m', `lattice: mark ${storyId} DONE with conflict`]);

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

async function assertDoneRecoverRequiresBranchDoneState(): Promise<void> {
  const root = initRepo('koala-partial-done-branch-not-done-');
  try {
    const storyId = 'B-branch-test';
    const store = new StoryStore(root);
    store.writeStory(storyId, story(storyId, 'DONE'));
    commitStories(root);
    addStoryWorktree(root, storyId);

    const worktreePath = join(root, '.worktrees', storyId);
    const worktreeStore = new StoryStore(worktreePath);
    worktreeStore.writeStory(storyId, story(storyId, 'TEST'));
    writeFileSync(join(worktreePath, 'story-only.txt'), 'branch-local work that is not DONE\n');
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['commit', '-m', `story branch remains TEST`]);

    const before = JSON.parse(await runKoala(root, 'doctor', { format: 'json' }));
    assert.equal(before.partialDone.needsRecovery, false);
    assert.deepEqual(before.partialDone.stories, []);

    const output = await runKoalaExpectFail(root, 'done_recover', { storyId });
    assert.match(output, /not a recoverable partial-DONE story/);
    assert.notEqual(git(root, ['branch', '--list', `story/${storyId}`]), '', 'non-DONE story branch must not be deleted');
    assert.match(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertMixedCanonicalLegacyGlobalLinksAreRepaired();
await assertDoctorRepairCleansAndProtects();
await assertStoryDiscardRepairsMissingRegistry();
await assertDoctorDetectsPartialDoneAndRecoverRepairs();
await assertDoneRecoverRefusesDirtyMain();
await assertDoneRecoverUsesDoneMainMergeLock();
await assertDoneRecoverRefusesDirtyStoryWorktree();
await assertDoneRecoverRefusesMergeTreeConflict();
await assertDoneRecoverRefusesMissingBranchWithoutDeletingUnrelated();
await assertDoneRecoverRequiresBranchDoneState();

console.log('✓ worktree repair smoke passed');
