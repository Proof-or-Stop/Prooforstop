#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distRoot = join(here, '..', '..', 'dist');
const { StoryStore } = await import(`${distRoot}/core/store.js`);
const { createStoryCreateHandlers } = await import(`${distRoot}/handlers/story-create.js`);
const { createChecklistHandlers } = await import(`${distRoot}/handlers/checklist.js`);

const marker = 'RED::EMPTY_CHECKLIST_NOT_PERSISTED';
const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-empty-checklist-'));

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(relativePath, content) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

const background = `## Trigger Event

B-e503 reproduced a Story that entered INIT without an initial checklist file and later failed every checklist_add attempt in PLAN.

## Key Insights

An empty checklist is valid intake state, but the checklist artifact itself is a lifecycle invariant consumed by later handlers and worktrees.

## Solution Tradeoffs

Persist the canonical empty artifact at creation time while retaining fail-closed behavior when an existing artifact is deleted or corrupted later.

## Conversational Texture

The benchmark runner reached PLAN and found that the framework had admitted a Story whose next required command could never read its checklist.
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
  write('README.md', '# empty checklist lifecycle fixture\n');
  write('packages/main/src/index.ts', 'export const fixture = true;\n');
  git('init', '-b', 'main');
  git('config', 'user.name', 'Proof-or-Stop Lab');
  git('config', 'user.email', 'lab@example.invalid');
  git('add', '.');
  git('commit', '-m', 'fixture: initialize empty checklist reproduction');

  const store = new StoryStore(root);
  const context = { root, store, scanRoot: join(root, 'packages/main') };
  const storyHandlers = createStoryCreateHandlers(context);
  const checklistHandlers = createChecklistHandlers(context);

  const explicitOutput = storyHandlers.story_create({
    name: 'empty-init-checklist',
    title: 'Empty INIT checklist',
    description: 'Reproduce INIT creation without caller-provided checklist items.',
    type: 'bug',
    priority: 'low',
    phase: 'INIT',
    background,
    forceNew: true,
  });
  const explicitId = explicitOutput.match(/B-[a-z0-9]+/i)?.[0];
  assert.ok(explicitId, 'explicit INIT creation must return a Story id');

  const implicitOutput = storyHandlers.story_create({
    name: 'empty-idea-checklist',
    title: 'Empty IDEA checklist',
    description: 'Reproduce default IDEA creation without caller-provided checklist items.',
    type: 'bug',
    priority: 'low',
    background,
    forceNew: true,
  });
  const implicitId = implicitOutput.match(/B-[a-z0-9]+/i)?.[0];
  assert.ok(implicitId, 'implicit IDEA creation must return a Story id');

  for (const storyId of [explicitId, implicitId]) {
    const path = join(root, '.proof-or-stop/story/actives', storyId, 'checklist.json');
    if (!existsSync(path)) {
      console.error(`${marker}: ${storyId} has no checklist.json`);
      process.exitCode = 1;
      continue;
    }
    assert.deepEqual(store.readChecklist(storyId), { items: [] });
    assert.match(
      git('ls-tree', '--name-only', 'HEAD', `.proof-or-stop/story/actives/${storyId}/checklist.json`),
      /checklist\.json/,
      'empty checklist must be included in the creation commit',
    );
  }

  if (!process.exitCode) {
    const story = store.readStory(explicitId);
    store.writeStory(explicitId, { ...story, phase: 'PLAN' });
    const added = checklistHandlers.checklist_add({
      storyId: explicitId,
      title: 'First planned requirement',
      context: 'The first requirement must be addable after empty INIT intake.',
      reason: 'Bind the first requirement during PLAN after empty INIT intake.',
    });
    assert.match(added, /CHK-001 added/);
    assert.equal(store.readChecklist(explicitId).items[0]?.id, 'CHK-001');
    console.log('GREEN::EMPTY_CHECKLIST_LIFECYCLE_REACHABLE');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
