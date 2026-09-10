#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distRoot = join(here, '..', '..', 'dist');
const { StoryStore } = await import(`${distRoot}/core/store.js`);
const { createStoryCreateHandlers } = await import(`${distRoot}/handlers/story-create.js`);

const marker = 'RED::DIRECT_DONE_STORY_CREATE_BYPASS';
const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-direct-done-'));

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(relativePath, content) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

const background = `## Trigger Event

B-de09 identified that the direct story creation API accepts phase DONE and persists a terminal Story without traversing the registered lifecycle gates.

## Key Insights

Terminal state is a gate result, not intake data, so creation must never mint DONE, TEST, REVIEW, DEV, or PLAN authority directly.

## Solution Tradeoffs

Keep IDEA and INIT creation for normal intake while refusing later phases before any Story metadata is persisted or committed.

## Conversational Texture

The operator asked for mechanical proof that every Story follows the lifecycle, with documentation-only work exempt only from executable RED.
`;

try {
  write('proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
  }, null, 2));
  write('README.md', '# direct DONE regression fixture\n');
  write('packages/main/src/index.ts', 'export const fixture = true;\n');
  git('init', '-b', 'main');
  git('config', 'user.name', 'Proof-or-Stop Lab');
  git('config', 'user.email', 'lab@example.invalid');
  git('add', '.');
  git('commit', '-m', 'fixture: initialize direct done reproduction');

  const store = new StoryStore(root);
  const handlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });
  let thrown;
  let output = '';
  try {
    output = handlers.story_create({
      name: 'direct-done-bypass',
      title: 'Direct DONE bypass',
      description: 'Reproduce direct terminal Story creation without lifecycle evidence.',
      type: 'chore',
      priority: 'low',
      phase: 'DONE',
      background,
      forceNew: true,
    });
  } catch (error) {
    thrown = error;
  }

  if (thrown) {
    assert.match(String(thrown.message ?? thrown), /story_create_direct_lifecycle_phase_forbidden/);
    assert.deepEqual(store.listStoryIds(), [], 'refusal must happen before persistence');
    console.log('GREEN::DIRECT_DONE_STORY_CREATE_REFUSED');
  } else {
    const storyId = output.match(/B-[a-z0-9]+/i)?.[0];
    assert.ok(storyId, 'pre-fix story_create should reveal the persisted Story id');
    assert.equal(store.readStory(storyId).phase, 'DONE');
    console.error(`${marker}: story_create persisted ${storyId} directly in DONE`);
    process.exitCode = 1;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
