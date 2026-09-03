#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StoryStore } from '../packages/main/dist/core/store.js';
import { detectZombieStories } from '../packages/main/dist/handlers/story-query.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

const temp = mkdtempSync(join(tmpdir(), 'proof-or-stop-zombie-linked-'));

try {
  mkdirSync(join(temp, 'docs', 'story', 'actives'), { recursive: true });
  writeFileSync(join(temp, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));

  git(temp, ['init']);
  git(temp, ['config', 'user.name', 'ProofOrStop Test']);
  git(temp, ['config', 'user.email', 'proofOrStop@example.com']);
  writeFileSync(join(temp, '.gitignore'), 'node_modules\n');
  git(temp, ['add', '.']);
  git(temp, ['commit', '-m', 'init']);

  const store = new StoryStore(temp);
  const storyId = 'B-test';
  const branch = `story/${storyId}`;
  const worktreePath = '.worktrees/B-test';
  const absWorktree = join(temp, worktreePath);

  store.writeStory(storyId, {
    storyId,
    name: 'linked-worktree-zombie',
    title: 'Linked worktree zombie fixture',
    description: 'tmp',
    type: 'bug',
    phase: 'DEV',
    priority: 'high',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    worktree: {
      path: worktreePath,
      branch,
      createdAt: new Date().toISOString(),
    },
  });

  git(temp, ['add', 'docs/story/actives']);
  git(temp, ['commit', '-m', 'story']);

  git(temp, ['worktree', 'add', '-b', branch, absWorktree]);
  writeFileSync(join(absWorktree, 'scratch.txt'), 'linked worktree change\n');
  git(absWorktree, ['add', 'scratch.txt']);
  git(absWorktree, ['commit', '-m', 'linked-worktree-change']);
  const noZombie = detectZombieStories(store, temp);
  assert(noZombie.length === 0, 'linked worktree branch should not be treated as zombie');

  git(temp, ['worktree', 'remove', '--force', absWorktree]);
  git(temp, ['branch', '-D', branch]);
  const zombies = detectZombieStories(store, temp);
  assert(zombies.some((z) => z.storyId === storyId), 'deleted branch should still be treated as zombie');

  console.log('linked worktree zombie verified');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
