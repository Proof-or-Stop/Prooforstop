#!/usr/bin/env node
/**
 * @task B-381e
 * @checklist CHK-001
 * @title story_authority_resolve smoke
 * @type feature
 * @priority high
 * @description
 *   Focused smoke for the host-neutral resolver surface. Covers the three
 *   verification rows from the CHK-001 plan:
 *
 *   - happy: schemaVersion is `lattice.story_authority_resolve.v1`, readOnly is
 *     true, and each row carries storyId / title / authority / mirrorPhase /
 *     authoritativePhase / authoritativeCwd / worktreePath.
 *   - edge: a worktree-authoritative story whose main mirror is stale resolves
 *     to the worktree-side phase and cwd, not the main mirror.
 *   - adversarial: output cannot set productionDone / receiptVerified /
 *     authorityChanged to true.
 * @changes
 *   - [CHK-001] Add validator-required changes metadata for the story authority resolve smoke task header.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import {
  resolveStoryAuthority,
  STORY_AUTHORITY_RESOLVE_SCHEMA_VERSION,
  type StoryAuthorityResolveResult,
} from '../core/story-authority-resolver.js';
import { createStoryAuthorityResolveHandlers } from '../handlers/story-authority-resolve.js';
import type { HandlerContext } from '../handlers/context.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function writeConfig(root: string): void {
  writeFileSync(
    join(root, 'lattice.config.json'),
    JSON.stringify(
      {
        scanRoot: 'packages/main',
        rootDir: 'src',
        storyDir: '.lattice/story/actives',
        requirementsDir: 'docs/requirements',
        worktreeDir: '.worktrees',
      },
      null,
      2,
    ) + '\n',
  );
}

function seedRepo(root: string): void {
  writeConfig(root);
  writeFileSync(join(root, '.gitignore'), '.worktrees/\n.lattice/activity.jsonl\n');
  writeFileSync(join(root, 'README.md'), 'story-authority-resolve smoke fixture\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, [
    '-c', 'user.email=smoke@example.test',
    '-c', 'user.name=Lattice Smoke',
    'commit', '-m', 'base',
  ]);
}

function writeStory(store: StoryStore, storyId: string, phase: StoryInfo['phase'], title: string, worktree?: StoryInfo['worktree']): void {
  const now = '2026-06-03T00:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'story-authority-resolve-smoke',
    title,
    description: 'Synthetic story for resolver smoke.',
    type: 'chore',
    phase,
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: phase === 'DONE' ? now : null,
    ...(worktree ? { worktree } : {}),
    events: [{ phase, action: 'advance', timestamp: now }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, {
    items: [
      {
        id: 'CHK-001',
        title: 'Synthetic checklist item',
        context: 'Synthetic context',
        status: 'pending',
        startTime: null,
        endTime: null,
      },
    ],
  });
}

function findRow(result: StoryAuthorityResolveResult, storyId: string) {
  const row = result.stories.find((r) => r.storyId === storyId);
  assert.ok(row, `expected row for ${storyId}, got ${result.stories.map((r) => r.storyId).join(',')}`);
  return row;
}

function assertEnvelope(result: StoryAuthorityResolveResult): void {
  assert.equal(result.schemaVersion, STORY_AUTHORITY_RESOLVE_SCHEMA_VERSION);
  assert.equal(result.schemaVersion, 'lattice.story_authority_resolve.v1');
  assert.equal(result.readOnly, true);
  // Adversarial: conservative authority fields are never true on this surface.
  assert.equal(result.productionDone, false);
  assert.equal(result.receiptVerified, false);
  assert.equal(result.authorityChanged, false);
  for (const row of result.stories) {
    // Row shape contract (happy path).
    assert.equal(typeof row.storyId, 'string');
    assert.equal(typeof row.title, 'string');
    assert.ok(row.authority === 'main' || row.authority === 'worktree');
    assert.equal(typeof row.mirrorPhase, 'string');
    assert.equal(typeof row.authoritativePhase, 'string');
    assert.equal(typeof row.authoritativeCwd, 'string');
    assert.ok(row.worktreePath === null || typeof row.worktreePath === 'string');
  }
}

function assertHappyAndEdgeAndAdversarial(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-story-authority-resolve-'));
  try {
    seedRepo(root);
    resetConfigCache();
    const store = new StoryStore(root);

    // Story A: main-only PLAN story (no worktree).
    writeStory(store, 'B-mainonly', 'PLAN', 'Main-only PLAN story');

    // Story B: worktree-authoritative DEV story whose MAIN mirror is stale at
    // INIT_CHECK. This is the §2.1(1) trap described in the host-neutral
    // observability decision: querying main returns INIT_CHECK, the
    // authoritative phase only exists in the worktree-side StoryStore.
    const storyId = 'B-wtdrift';
    const worktreeRelPath = `.worktrees/${storyId}`;
    const worktreeAbsPath = join(root, worktreeRelPath);
    writeStory(store, storyId, 'INIT_CHECK', 'Worktree-authoritative drift story', {
      path: worktreeRelPath,
      branch: `story/${storyId}`,
      createdAt: '2026-06-03T00:00:00.000Z',
    });
    git(root, ['add', '.']);
    git(root, [
      '-c', 'user.email=smoke@example.test',
      '-c', 'user.name=Lattice Smoke',
      'commit', '-m', 'main mirror at INIT_CHECK',
    ]);
    mkdirSync(dirname(worktreeAbsPath), { recursive: true });
    git(root, ['branch', `story/${storyId}`]);
    git(root, ['worktree', 'add', worktreeAbsPath, `story/${storyId}`]);

    // Mutate the worktree-side StoryStore to DEV. The worktree-side copy is the
    // authoritative phase, the main-side copy stays at INIT_CHECK (stale).
    resetConfigCache();
    const worktreeStore = new StoryStore(worktreeAbsPath);
    const worktreeStory = worktreeStore.readStory(storyId);
    worktreeStory.phase = 'DEV';
    worktreeStory.events = [
      ...(worktreeStory.events ?? []),
      { phase: 'DEV', action: 'advance', timestamp: '2026-06-03T01:00:00.000Z' },
    ];
    worktreeStore.writeStory(storyId, worktreeStory);

    // Resolver invocation via core API.
    resetConfigCache();
    const rootStore = new StoryStore(root);
    const result = resolveStoryAuthority(rootStore, root, { now: '2026-06-03T02:00:00.000Z' });
    assertEnvelope(result);
    assert.equal(result.generatedAt, '2026-06-03T02:00:00.000Z');
    assert.ok(result.stories.length >= 2);

    // Happy row.
    const main = findRow(result, 'B-mainonly');
    assert.equal(main.authority, 'main');
    assert.equal(main.mirrorPhase, 'PLAN');
    assert.equal(main.authoritativePhase, 'PLAN');
    assert.equal(main.worktreePath, null);
    assert.equal(main.title, 'Main-only PLAN story');
    // For main-only stories the authoritativeCwd is the repo root the resolver
    // saw — adapters use this to know where to run subsequent CLI calls.
    assert.equal(typeof main.authoritativeCwd, 'string');
    assert.ok(main.authoritativeCwd.length > 0);

    // Edge row: drift — main mirror at INIT_CHECK, worktree at DEV.
    const drift = findRow(result, storyId);
    assert.equal(drift.authority, 'worktree');
    assert.equal(drift.mirrorPhase, 'INIT_CHECK');
    assert.equal(drift.authoritativePhase, 'DEV');
    assert.ok(drift.worktreePath && drift.worktreePath.length > 0, 'drift row exposes worktree path');
    assert.ok(drift.authoritativeCwd === drift.worktreePath, 'drift authoritativeCwd points at the worktree, not main');

    // Adversarial: nothing in the surface area allows promoting to production.
    // The handler wrapper must preserve those guarantees too.
    const ctx: HandlerContext = { store: rootStore, root, scanRoot: join(root, 'packages/main') };
    const handlers = createStoryAuthorityResolveHandlers(ctx);
    const viaHandler = handlers.story_authority_resolve({}) as StoryAuthorityResolveResult;
    assertEnvelope(viaHandler);
    const driftViaHandler = findRow(viaHandler, storyId);
    assert.equal(driftViaHandler.authoritativePhase, 'DEV', 'handler exposes worktree authoritative phase');
    assert.equal(driftViaHandler.authority, 'worktree');

    // Text format mirrors the JSON fields without unlocking authority.
    const textOut = handlers.story_authority_resolve({ format: 'text' }) as string;
    assert.match(textOut, new RegExp(`lattice\\.story_authority_resolve\\.v1`));
    assert.match(textOut, /productionDone=false/);
    assert.match(textOut, /receiptVerified=false/);
    assert.match(textOut, /authorityChanged=false/);
    assert.match(textOut, /B-wtdrift authority=worktree/);

    // storyIds filter narrows the result without breaking the envelope.
    const narrowed = handlers.story_authority_resolve({ storyIds: [storyId] }) as StoryAuthorityResolveResult;
    assertEnvelope(narrowed);
    assert.equal(narrowed.stories.length, 1);
    assert.equal(narrowed.stories[0].storyId, storyId);

    // Terminal stories are excluded by default.
    const terminalStore = new StoryStore(root);
    writeStory(terminalStore, 'B-done', 'DONE', 'Terminal story');
    git(root, ['add', '.']);
    git(root, [
      '-c', 'user.email=smoke@example.test',
      '-c', 'user.name=Lattice Smoke',
      'commit', '-m', 'add terminal story',
    ]);
    resetConfigCache();
    const afterTerminal = resolveStoryAuthority(new StoryStore(root), root);
    assert.ok(!afterTerminal.stories.some((r) => r.storyId === 'B-done'), 'DONE stories are excluded from the active surface');
    const withTerminal = resolveStoryAuthority(new StoryStore(root), root, { activeOnly: false });
    assert.ok(withTerminal.stories.some((r) => r.storyId === 'B-done'), 'activeOnly:false includes terminal stories');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertHappyAndEdgeAndAdversarial();
console.log('✓ story_authority_resolve smoke passed');
