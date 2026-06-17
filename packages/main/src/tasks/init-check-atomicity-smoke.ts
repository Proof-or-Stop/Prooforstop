#!/usr/bin/env node

/**
 * B-804c: regression smoke for the atomic INIT_CHECK bootstrap + dev_start recovery.
 *
 * Covers three load-bearing properties of the B-804c fix:
 *   (a) Atomicity / no-partial-advance: when the worktree bootstrap fails during
 *       `story_advance --phase=INIT_CHECK`, the story stays at its prior phase
 *       (INIT) — it must NOT be left half-advanced at INIT_CHECK with no worktree.
 *       Deterministic failure injection: an UNFROZEN INIT story makes dev_start
 *       throw on the scope-anti-expansion freeze gate (no flaky real git failure).
 *       This assertion fails loudly if anyone reverts to advancing-before-bootstrap.
 *   (b) Recovery: a story stuck at INIT_CHECK with no worktree on disk is
 *       re-bootstrapped by `lattice dev_start`, which recreates the worktree and
 *       prints its Path. Idempotent: a second run returns the existing path.
 *   (c) Guard refusals: `lattice dev_start` is refused in a terminal phase (DONE)
 *       and in REVIEW, and refused for an unfrozen INIT story (freeze gate).
 *   (d) Clean-INIT success path (B-804c:F-001): a genuine, fully-gated INIT story
 *       — frozen AND carrying a valid signed init-check.json (the
 *       lattice-review-story-init evidence, here via the controlled
 *       init_check_repair fallback) — advances through the REAL
 *       `story_advance --phase=INIT_CHECK` success path: phase ends at INIT_CHECK
 *       (advanced exactly once), the worktree exists on disk, and the story index
 *       records story.worktree.path. This directly guards the happy-path sequencing
 *       (bootstrap -> persist phase -> record worktree) that the failure/recovery
 *       tests above never exercise.
 *
 * Pattern mirrors worktree-repair-smoke.ts (self-contained node script, mkdtemp
 * git repo, execFileSync/spawn of dist/cli.js, lattice.config.json + .gitignore,
 * StoryStore seeding) and the frozen-story seeding from scope-anti-expansion-smoke.ts.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import {
  buildExecutionBoundary,
  buildScopeBoundary,
  evaluateScopeFreeze,
} from '../core/scope-anti-expansion.js';
import type { ChecklistData, StoryInfo, StoryPhase } from '../core/types.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');
const NOW = '2026-06-15T12:00:00.000Z';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
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
  write(root, 'lattice.config.json', JSON.stringify({
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
  write(root, 'README.md', 'init-check atomicity smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  resetConfigCache();
  return root;
}

function story(storyId: string, phase: StoryPhase, worktree = false): StoryInfo {
  return {
    storyId,
    name: `${storyId.toLowerCase()}-init-check-atomicity-smoke`,
    title: `${storyId} init-check atomicity smoke`,
    description: 'Synthetic story for the B-804c INIT_CHECK atomicity + recovery smoke.',
    type: 'chore',
    phase,
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: phase === 'DONE' || phase === 'DISCARDED' ? NOW : null,
    events: [{ phase, action: phase === 'DONE' ? 'advance' : 'create', timestamp: NOW }],
    ...(worktree ? {
      worktree: { path: `.worktrees/${storyId}`, branch: `story/${storyId}`, createdAt: NOW },
    } : {}),
  };
}

function seedChecklist(store: StoryStore, storyId: string): void {
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Bootstrap atomicity coverage',
      context: 'Synthetic checklist item for the freeze gate.',
      status: 'pending',
      startTime: null,
      endTime: null,
    }],
  };
  store.writeChecklist(storyId, checklist);
}

/**
 * Make a story pass the scope-anti-expansion freeze gate so dev_start does not
 * reject it on the freeze guard (it would otherwise block the recovery/happy
 * paths). Mirrors scope-anti-expansion-smoke.ts seeding.
 */
function freezeStory(store: StoryStore, storyId: string): void {
  store.writeScopeBoundary(storyId, buildScopeBoundary({
    storyId,
    mode: 'correctness_fix',
    allowed: ['INIT_CHECK worktree bootstrap'],
    excluded: ['unrelated expansion'],
    confirmedBy: 'init-check-atomicity-smoke',
    confirmationNote: 'Synthetic user-confirmed boundary for smoke coverage.',
    now: NOW,
  }));
  store.writeExecutionBoundary(storyId, buildExecutionBoundary({
    storyId,
    allowedCommands: ['npm --prefix packages/main run build'],
    allowedTools: ['shell'],
    excludedCommands: ['rm -rf'],
    excludedTools: [],
    confirmedBy: 'init-check-atomicity-smoke',
    confirmationNote: 'Synthetic execution boundary for smoke coverage.',
    now: NOW,
  }));
  const result = evaluateScopeFreeze({
    storyId,
    scopeBoundary: store.readScopeBoundary(storyId),
    executionBoundary: store.readExecutionBoundary(storyId),
    // Mirror the gate's projectScopeFreezeStory projection EXACTLY (title +
    // description + background). Omitting background here makes freshnessHash
    // diverge from the gate's recompute for any story that has a background.md
    // (e.g. a real story_create envelope), tripping [scope_freeze_check_stale].
    story: {
      title: store.readStory(storyId).title,
      description: store.readStory(storyId).description,
      background: store.readStoryBackground(storyId) ?? undefined,
    },
    checklist: store.readChecklist(storyId).items.map(item => ({
      id: item.id,
      title: item.title ?? '',
      ...(item.context ? { context: item.context } : {}),
    })),
    discardDigest: store.readScopeDiscardDigest(storyId),
    now: NOW,
  });
  store.writeScopeFreezeCheck(storyId, result.check);
  assert.equal(result.check.status, 'pass', 'freeze setup must produce a passing scope-freeze-check');
}

function commitStories(root: string): void {
  git(root, ['add', '.lattice/story/actives']);
  git(root, ['commit', '-m', 'add smoke story metadata']);
}

function runLattice(root: string, command: string, args: Record<string, unknown>): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, command, JSON.stringify(args)], {
      cwd: root,
      env: { ...process.env, LATTICE_PROJECT_ROOT: root },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e: any) {
    return {
      code: typeof e?.status === 'number' ? e.status : 1,
      stdout: e?.stdout ? String(e.stdout) : '',
      stderr: e?.stderr ? String(e.stderr) : String(e?.message ?? e),
    };
  }
}

// ── (a) + (c-unfrozen): an UNFROZEN INIT story aborts bootstrap and stays at INIT ──
function assertFailedBootstrapLeavesPhaseAtInit(): void {
  const root = initRepo('lattice-initcheck-atomic-partial-');
  try {
    const storyId = 'B-atomic';
    const store = new StoryStore(root);
    store.writeStory(storyId, story(storyId, 'INIT'));
    seedChecklist(store, storyId);
    // NOTE: deliberately NOT frozen → dev_start throws on the scope-anti-expansion
    // freeze gate, a deterministic injected bootstrap failure (no flaky git op).
    commitStories(root);

    const res = runLattice(root, 'story_advance', { storyId, phase: 'INIT_CHECK' });
    // The atomic flow runs dev_start FIRST; the freeze-gate failure aborts the
    // advance, so the command reports failure (not "advanced to INIT_CHECK").
    assert.notEqual(res.code, 0, 'story_advance INIT_CHECK with a failing bootstrap must exit non-zero');
    const combined = `${res.stdout}\n${res.stderr}`;
    assert.match(combined, /INIT_CHECK aborted|scope|freeze/i, 'output must report the aborted bootstrap, not advancement');
    assert.doesNotMatch(res.stdout, /advanced to INIT_CHECK/i, 'must not claim advancement on a failed bootstrap');

    // The load-bearing assertion: phase is STILL INIT (no partial advance). If
    // someone reverts to advancing-before-bootstrap, this fails loudly.
    const after = JSON.parse(runLattice(root, 'story_get', { storyId, detail: true }).stdout);
    assert.equal(after.index.phase, 'INIT', 'failed bootstrap must NOT leave the story partially advanced at INIT_CHECK');

    // And no worktree was created on disk.
    assert.equal(existsSync(join(root, '.worktrees', storyId)), false, 'no worktree should exist after an aborted bootstrap');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── (b): recovery — a frozen story stuck at INIT_CHECK with no worktree re-bootstraps ──
function assertDevStartRecoversStuckInitCheckStory(): void {
  const root = initRepo('lattice-initcheck-atomic-recover-');
  try {
    const storyId = 'B-stuck';
    const store = new StoryStore(root);
    // Stuck victim: phase persisted to INIT_CHECK but NO worktree on disk (the
    // exact unrecoverable state the old non-atomic flow could produce).
    store.writeStory(storyId, story(storyId, 'INIT_CHECK'));
    seedChecklist(store, storyId);
    freezeStory(store, storyId);
    commitStories(root);

    const res = runLattice(root, 'dev_start', { storyId });
    assert.equal(res.code, 0, `dev_start recovery should succeed: ${res.stderr}`);
    assert.match(res.stdout, /Path:/, 'dev_start must print a Path: line');
    assert.equal(existsSync(join(root, '.worktrees', storyId)), true, 'recovery must recreate the worktree on disk');

    // Idempotent: a second run returns the existing path without error.
    const again = runLattice(root, 'dev_start', { storyId });
    assert.equal(again.code, 0, `idempotent dev_start should succeed: ${again.stderr}`);
    assert.match(again.stdout, /already exists|Path:/i, 'second dev_start should report the existing worktree');
    assert.equal(existsSync(join(root, '.worktrees', storyId)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── (c): guard refusals — terminal/REVIEW phases and unfrozen INIT are refused ──
function assertDevStartRefusedInWrongPhases(): void {
  const root = initRepo('lattice-initcheck-atomic-refuse-');
  try {
    const store = new StoryStore(root);
    // DONE (terminal) story — handler allowedPhases gate rejects.
    store.writeStory('B-done', story('B-done', 'DONE'));
    seedChecklist(store, 'B-done');
    // REVIEW story — handler allowedPhases gate rejects.
    store.writeStory('B-review', story('B-review', 'REVIEW'));
    seedChecklist(store, 'B-review');
    // Unfrozen INIT story — scope-anti-expansion freeze gate rejects.
    store.writeStory('B-unfrozen', story('B-unfrozen', 'INIT'));
    seedChecklist(store, 'B-unfrozen');
    commitStories(root);

    const done = runLattice(root, 'dev_start', { storyId: 'B-done' });
    assert.notEqual(done.code, 0, 'dev_start must be refused for a DONE story');
    assert.match(`${done.stdout}\n${done.stderr}`, /INIT \/ INIT_CHECK \/ PLAN \/ DEV|phase DONE/i);

    const review = runLattice(root, 'dev_start', { storyId: 'B-review' });
    assert.notEqual(review.code, 0, 'dev_start must be refused for a REVIEW story');
    assert.match(`${review.stdout}\n${review.stderr}`, /INIT \/ INIT_CHECK \/ PLAN \/ DEV|phase REVIEW/i);

    const unfrozen = runLattice(root, 'dev_start', { storyId: 'B-unfrozen' });
    assert.notEqual(unfrozen.code, 0, 'dev_start must be refused for an unfrozen INIT story');
    assert.match(`${unfrozen.stdout}\n${unfrozen.stderr}`, /scope|freeze|anti-expansion/i, 'unfrozen INIT refusal must cite the freeze gate');
    assert.equal(existsSync(join(root, '.worktrees', 'B-unfrozen')), false, 'an unfrozen INIT story must not bootstrap a worktree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── (d): clean-INIT success path — a fully-gated INIT story advances via the REAL
//        story_advance INIT_CHECK happy path (phase advanced once + worktree recorded) ──
function assertCleanInitCheckAdvanceSucceeds(): void {
  const root = initRepo('lattice-initcheck-atomic-success-');
  try {
    // Use the real story_create CLI so the story has a genuine signed envelope
    // (background.md + index.json + checklist.json). init_check_repair signs over
    // that envelope, so the full INIT_CHECK transition gate (which the synthetic
    // StoryStore.writeStory seeding cannot satisfy — no valid init-check.json) is
    // actually passable here. This is the REAL story_advance INIT_CHECK success
    // path, not the dev_start recovery shortcut.
    const background = [
      '## Trigger Event',
      '2026-06-15 B-0000 smoke needs enough trigger detail to satisfy background validation for the clean-INIT success path.',
      '## Key Insights',
      'A fully-gated INIT story (frozen + signed init-check) must advance through story_advance INIT_CHECK and record its worktree.',
      '## Tradeoffs',
      'The smoke drives the controlled init_check_repair fallback to obtain a signed init-check rather than spawning a reviewer subagent.',
      '## Conversation Texture',
      'A maintainer sees the story advance to INIT_CHECK exactly once with a worktree created on disk and recorded in the index.',
    ].join('\n\n');
    const created = runLattice(root, 'story_create', {
      name: 'clean-init-success',
      title: 'Clean INIT success path',
      description: 'Verify a fully-gated INIT story advances through the real story_advance INIT_CHECK happy path.',
      type: 'chore',
      priority: 'medium',
      background,
      checklist: [{ title: 'Verify clean INIT_CHECK advance', context: 'A frozen, init-checked INIT story must advance and record its worktree.' }],
    });
    assert.equal(created.code, 0, `story_create should succeed: ${created.stderr}`);
    const storyId = created.stdout.match(/B-[a-f0-9]+/)?.[0];
    assert.ok(storyId, 'story_create should return a story id');

    // Satisfy the scope-anti-expansion freeze gate (dev_start refuses an unfrozen
    // INIT story) using the same store-driven helper as the recovery/refusal tests.
    const store = new StoryStore(root);
    freezeStory(store, storyId!);

    // Satisfy the INIT_CHECK transition gate's init-check.json requirement via the
    // controlled, signed fallback (covers both required reviewers as <required>@fallback).
    const repaired = runLattice(root, 'init_check_repair', {
      storyId,
      acknowledge: true,
      fallbackReason: 'No init reviewer subagent can be spawned in this smoke; manually attested background + checklist + product value for the clean-INIT success path.',
      evidenceRefs: ['init-check-atomicity-smoke-clean-init'],
    });
    assert.equal(repaired.code, 0, `init_check_repair should succeed: ${repaired.stderr}`);

    // Commit the story metadata to main BEFORE advancing (mirrors both the real
    // workflow — where story metadata is committed before INIT_CHECK — and the
    // recovery test's commitStories). If it stays uncommitted, dev_start commits
    // index.json onto the new story branch while commitInitCheckMetadataAndMergeMain
    // commits a divergent index.json on main, producing an add/add merge conflict.
    commitStories(root);

    // THE happy path: the real story_advance INIT_CHECK must SUCCEED.
    const advanced = runLattice(root, 'story_advance', { storyId, phase: 'INIT_CHECK' });
    assert.equal(advanced.code, 0, `clean-INIT story_advance INIT_CHECK should succeed: ${advanced.stderr}`);

    // Phase advanced exactly once: story_get detail reports INIT_CHECK.
    const detail = JSON.parse(runLattice(root, 'story_get', { storyId, detail: true }).stdout);
    assert.equal(detail.index.phase, 'INIT_CHECK', 'clean-INIT success path must leave the story at INIT_CHECK');

    // The worktree directory exists on disk.
    assert.equal(existsSync(join(root, '.worktrees', storyId!)), true, 'a successful INIT_CHECK advance must create the worktree on disk');

    // The story index records the worktree path.
    const persisted = new StoryStore(root).readStory(storyId!);
    assert.ok(persisted.worktree?.path, 'the story index must record story.worktree.path after a successful INIT_CHECK advance');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertFailedBootstrapLeavesPhaseAtInit();
assertDevStartRecoversStuckInitCheckStory();
assertDevStartRefusedInWrongPhases();
assertCleanInitCheckAdvanceSucceeds();

console.log('✓ init-check atomicity smoke passed');
