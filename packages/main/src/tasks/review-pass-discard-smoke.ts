#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { cleanStrayWorktreeFiles, STRAY_FILE_WHITELIST } from '../handlers/stray-file-cleanup.js';
import { checkCommitAuthor } from '../handlers/validate-channel.js';
import { runDocsDriftGate } from '../handlers/validate-docs-drift.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

function reviewerReadManifest(agent: string): Record<string, unknown> {
  return {
    filesReadFully: [`docs/requirements/decisions/${agent}.md`],
    filesTriagedByName: [],
    scanEscalationReason: null,
  };
}

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
  git(root, ['config', 'user.name', 'Proofbound Smoke']);
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
  }, null, 2));
  write(root, '.gitignore', [
    '.worktrees/',
    '**/activity.jsonl',
    '.lattice/*',
    '!.lattice/story/',
    '!.lattice/story/**',
    '',
  ].join('\n'));
  write(root, 'README.md', 'smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  resetConfigCache();
  return root;
}

function writeReviewStory(root: string, storyId: string): void {
  const store = new StoryStore(root);
  const now = '2026-04-30T10:00:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'review-pass-concurrency-smoke',
    title: 'Review pass concurrency smoke',
    description: 'Synthetic story for concurrent review pass writes.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    currentReviewRound: '2026-04-30T10:01:00.000Z',
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic done item',
      context: 'Synthetic context',
      status: 'done',
      startTime: now,
      endTime: now,
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
}

function writeChecklistConcurrencyStory(root: string, storyId: string, phase: StoryInfo['phase']): void {
  const store = new StoryStore(root);
  const now = '2026-04-30T10:00:00.000Z';
  store.writeStory(storyId, {
    storyId,
    name: 'checklist-concurrency-smoke',
    title: 'Checklist concurrency smoke',
    description: 'Synthetic story for concurrent checklist writes.',
    type: 'chore',
    phase,
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase, action: 'advance', timestamp: now }],
  });
  store.writeChecklist(storyId, {
    items: ['CHK-001', 'CHK-002'].map(id => ({
      id,
      title: `Synthetic ${id}`,
      context: 'Synthetic context',
      status: 'pending' as const,
      startTime: null,
      endTime: null,
    })),
  });
}

async function runLattice(root: string, command: string, args: Record<string, unknown>, envOverrides: Record<string, string> = {}): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, command, JSON.stringify(args)], {
      cwd: root,
      env: { ...process.env, LATTICE_PROJECT_ROOT: root, ...envOverrides },
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

function extractReviewRunId(output: string): string {
  const match = output.match(/B-[^:\s]+:RR-\d+/);
  assert.ok(match?.[0], `expected review run id in output: ${output}`);
  return match![0];
}

async function startReviewRun(root: string, storyId: string, agent: string): Promise<string> {
  return extractReviewRunId(await runLattice(root, 'review_run_start', { storyId, agent }));
}

async function runLatticeFromCwd(cwd: string, command: string, args: Record<string, unknown>): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const env = { ...process.env };
    delete env.LATTICE_PROJECT_ROOT;
    const child = spawn(process.execPath, [cliPath, command, JSON.stringify(args)], {
      cwd,
      env,
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

async function assertReviewPassConcurrentWrites(): Promise<void> {
  const root = initRepo('lattice-review-pass-');
  try {
    const storyId = 'B-pass';
    writeReviewStory(root, storyId);
    const agents = ['concept', 'quality', 'test-coverage', 'docs'].map(name => `lattice-review-${name}`);
    const runIds = new Map(await Promise.all(agents.map(async (agent) => [agent, await startReviewRun(root, storyId, agent)] as const)));
    await Promise.all(agents.map(agent => runLattice(root, 'review_pass_set', {
      storyId,
      agent,
      reviewRunId: runIds.get(agent),
      note: `${agent} checked its assigned review surface and found no blocker.`,
      readManifest: reviewerReadManifest(agent),
    })));

    const data = new StoryStore(root).readReviewPasses(storyId);
    assert.equal(data.passes.length, agents.length, 'all parallel review passes should persist');
    assert.deepEqual(new Set(data.passes.map(pass => pass.agent)), new Set(agents));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertChecklistConcurrentUpdates(): Promise<void> {
  const root = initRepo('lattice-checklist-concurrent-');
  try {
    const storyId = 'B-check';
    writeChecklistConcurrencyStory(root, storyId, 'DEV');
    await Promise.all(['CHK-001', 'CHK-002'].map(itemId => runLattice(root, 'checklist_update', {
      storyId,
      itemId,
      status: 'done',
    })));

    const checklist = new StoryStore(root).readChecklist(storyId);
    const statuses = new Map(checklist.items.map(item => [item.id, item.status]));
    assert.equal(statuses.get('CHK-001'), 'done', 'CHK-001 status should survive concurrent checklist_update');
    assert.equal(statuses.get('CHK-002'), 'done', 'CHK-002 status should survive concurrent checklist_update');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertChecklistConcurrentVerificationIntentUpdates(): Promise<void> {
  const root = initRepo('lattice-checklist-intent-concurrent-');
  try {
    const storyId = 'B-intent';
    writeChecklistConcurrencyStory(root, storyId, 'PLAN');
    await Promise.all(['CHK-001', 'CHK-002'].map(itemId => runLattice(root, 'checklist_update', {
      storyId,
      itemId,
      verificationIntent: {
        happy: [{ desc: `${itemId} happy path`, type: 'cli', priority: 'must' }],
        edge: [],
        adversarial: [],
      },
    })));

    const checklist = new StoryStore(root).readChecklist(storyId);
    const intents = new Map(checklist.items.map(item => [item.id, item.verificationIntent?.happy?.[0]?.desc]));
    assert.equal(intents.get('CHK-001'), 'CHK-001 happy path', 'CHK-001 verificationIntent should survive concurrent checklist_update');
    assert.equal(intents.get('CHK-002'), 'CHK-002 happy path', 'CHK-002 verificationIntent should survive concurrent checklist_update');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDiscardRemovesUntrackedWorktreeAndBranch(): Promise<void> {
  const root = initRepo('lattice-discard-worktree-');
  try {
    const storyId = 'B-drop';
    const store = new StoryStore(root);
    const now = '2026-04-30T10:00:00.000Z';
    store.writeStory(storyId, {
      storyId,
      name: 'discard-worktree-smoke',
      title: 'Discard worktree smoke',
      description: 'Synthetic story with branch/worktree residue.',
      type: 'chore',
      phase: 'INIT_CHECK',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [],
    });
    git(root, ['branch', `story/${storyId}`]);
    git(root, ['worktree', 'add', join(root, '.worktrees', storyId), `story/${storyId}`]);

    const output = await runLattice(root, 'story_discard', { storyId, force: true, reason: 'smoke cleanup' });

    assert.doesNotMatch(output, /worktree and branch have been cleaned up/, 'discard hint must not claim blanket cleanup');
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`branch refs/heads/story/${storyId}`));
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'DISCARDED');
    assert.equal(git(root, ['status', '--porcelain']), '', 'story_discard should leave the repo clean after committing discarded metadata');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDiscardCanCleanAlreadyDiscardedResidue(): Promise<void> {
  const root = initRepo('lattice-discard-residue-');
  try {
    const storyId = 'B-residue';
    const store = new StoryStore(root);
    const now = '2026-04-30T10:00:00.000Z';
    store.writeStory(storyId, {
      storyId,
      name: 'discard-residue-smoke',
      title: 'Discard residue smoke',
      description: 'Synthetic story already marked discarded with branch/worktree residue.',
      type: 'chore',
      phase: 'DISCARDED',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: now,
      events: [],
    });
    git(root, ['branch', `story/${storyId}`]);
    git(root, ['worktree', 'add', join(root, '.worktrees', storyId), `story/${storyId}`]);

    const output = await runLattice(root, 'story_discard', { storyId, force: true, reason: 'smoke residue cleanup' });

    assert.match(output, /is already DISCARDED; residuals checked\/cleaned/);
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`branch refs/heads/story/${storyId}`));
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'DISCARDED');
    assert.equal(git(root, ['status', '--porcelain']), '', 'already-discarded residue cleanup should leave the repo clean');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDiscardPrunesMissingWorktreeRegistry(): Promise<void> {
  const root = initRepo('lattice-discard-prunable-');
  try {
    const storyId = 'B-prunedrop';
    const store = new StoryStore(root);
    const now = '2026-04-30T10:00:00.000Z';
    store.writeStory(storyId, {
      storyId,
      name: 'discard-prunable-smoke',
      title: 'Discard prunable smoke',
      description: 'Synthetic story whose git worktree metadata survived after the directory disappeared.',
      type: 'chore',
      phase: 'INIT_CHECK',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [],
      worktree: {
        path: `.worktrees/${storyId}`,
        branch: `story/${storyId}`,
        createdAt: now,
      },
    });
    git(root, ['branch', `story/${storyId}`]);
    git(root, ['worktree', 'add', join(root, '.worktrees', storyId), `story/${storyId}`]);
    rmSync(join(root, '.worktrees', storyId), { recursive: true, force: true });

    const output = await runLattice(root, 'story_discard', { storyId, force: true, reason: 'smoke prunable cleanup' });

    assert.match(output, /stale worktree metadata pruned/);
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`branch refs/heads/story/${storyId}`));
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '');
    assert.equal(existsSync(join(root, '.worktrees', storyId)), false, 'missing worktree dir should stay gone');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'DISCARDED');
    assert.equal(git(root, ['status', '--porcelain']), '', 'prunable discard cleanup should leave the repo clean');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDiscardCleansInvalidGitPointerResidue(): Promise<void> {
  const root = initRepo('lattice-discard-invalid-pointer-');
  try {
    const storyId = 'B-badptr';
    const store = new StoryStore(root);
    const now = '2026-04-30T10:00:00.000Z';
    store.writeStory(storyId, {
      storyId,
      name: 'discard-invalid-pointer-smoke',
      title: 'Discard invalid pointer smoke',
      description: 'Synthetic story whose physical worktree dir survived after git admin metadata disappeared.',
      type: 'chore',
      phase: 'INIT_CHECK',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [],
      worktree: {
        path: `.worktrees/${storyId}`,
        branch: `story/${storyId}`,
        createdAt: now,
      },
    });
    git(root, ['branch', `story/${storyId}`]);
    const worktreePath = join(root, '.worktrees', storyId);
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, '.git'), `gitdir: ${join(root, '.git', 'worktrees', storyId)}\n`);
    writeFileSync(join(worktreePath, 'runtime.log'), 'stale residue\n');

    let refusedWithoutForce = false;
    try {
      await runLattice(root, 'story_discard', { storyId, reason: 'smoke invalid pointer cleanup' });
    } catch (error) {
      refusedWithoutForce = String((error as Error).message).includes('Worktree git metadata is corrupted');
    }
    assert.equal(refusedWithoutForce, true, 'invalid pointer cleanup should ask for force before deleting a physical residue dir');
    assert.equal(existsSync(worktreePath), true, 'non-forced invalid pointer cleanup should keep the residue dir');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'INIT_CHECK', 'non-forced invalid pointer cleanup must not discard');

    const output = await runLattice(root, 'story_discard', { storyId, force: true, reason: 'smoke invalid pointer cleanup' });

    assert.match(output, /invalid worktree residue cleaned up/);
    assert.equal(existsSync(worktreePath), false, 'forced invalid pointer cleanup should remove the physical residue dir');
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'DISCARDED');
    assert.equal(git(root, ['status', '--porcelain']), '', 'invalid pointer discard cleanup should leave the repo clean');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDiscardForceFromInvalidWorktreeCwd(): Promise<void> {
  const root = initRepo('lattice-discard-invalid-cwd-');
  try {
    const storyId = 'B-badcwd';
    const store = new StoryStore(root);
    const now = '2026-04-30T10:00:00.000Z';
    store.writeStory(storyId, {
      storyId,
      name: 'discard-invalid-cwd-smoke',
      title: 'Discard invalid cwd smoke',
      description: 'Synthetic story whose discard is invoked from the broken worktree cwd.',
      type: 'chore',
      phase: 'INIT_CHECK',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [],
      worktree: {
        path: `.worktrees/${storyId}`,
        branch: `story/${storyId}`,
        createdAt: now,
      },
    });
    store.writeChecklist(storyId, { items: [] });
    git(root, ['add', '.lattice/story/actives']);
    git(root, ['commit', '-m', `lattice: story ${storyId} init`]);
    git(root, ['branch', `story/${storyId}`]);
    const worktreePath = join(root, '.worktrees', storyId);
    git(root, ['worktree', 'add', worktreePath, `story/${storyId}`]);
    rmSync(join(root, '.git', 'worktrees', storyId), { recursive: true, force: true });
    writeFileSync(join(worktreePath, 'runtime.log'), 'stale residue\n');

    const output = await runLatticeFromCwd(worktreePath, 'story_discard', {
      storyId,
      force: true,
      reason: 'smoke invalid cwd cleanup',
    });

    assert.match(output, /invalid worktree residue cleaned up|Worktree .* cleaned up/);
    assert.equal(existsSync(worktreePath), false, 'forced discard from broken worktree cwd should remove the physical residue dir');
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'DISCARDED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDiscardFailureDoesNotMarkSuccess(): Promise<void> {
  const root = initRepo('lattice-discard-fail-closed-');
  const storyId = 'B-stuck';
  try {
    const store = new StoryStore(root);
    const now = '2026-04-30T10:00:00.000Z';
    store.writeStory(storyId, {
      storyId,
      name: 'discard-fail-closed-smoke',
      title: 'Discard fail closed smoke',
      description: 'Synthetic story with an undeletable worktree metadata entry.',
      type: 'chore',
      phase: 'INIT_CHECK',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [],
    });
    git(root, ['branch', `story/${storyId}`]);
    git(root, ['worktree', 'add', join(root, '.worktrees', storyId), `story/${storyId}`]);
    chmodSync(join(root, '.worktrees', storyId), 0o500);
    chmodSync(join(root, '.worktrees'), 0o500);

    let failed = false;
    try {
      await runLattice(root, 'story_discard', { storyId, force: true, reason: 'smoke fail closed' });
    } catch (error) {
      failed = String((error as Error).message).includes('discard stopped');
    }
    assert.equal(failed, true, 'story_discard should fail closed when worktree metadata cannot be removed');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'INIT_CHECK', 'failed discard must not mark story DISCARDED');
    assert.notEqual(git(root, ['branch', '--list', `story/${storyId}`]), '', 'failed discard must not delete the story branch');
  } finally {
    try { chmodSync(join(root, '.worktrees'), 0o700); } catch { /* best-effort cleanup */ }
    try { chmodSync(join(root, '.worktrees', storyId), 0o700); } catch { /* best-effort cleanup */ }
    try { chmodSync(join(root, '.git', 'worktrees'), 0o700); } catch { /* best-effort cleanup */ }
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertPurgeDropsSafeInitCommit(): Promise<void> {
  const root = initRepo('lattice-discard-purge-');
  try {
    const before = git(root, ['rev-parse', 'HEAD']);
    const storyId = 'B-purge';
    writeReviewStory(root, storyId);
    git(root, ['add', '.lattice/story/actives/B-purge']);
    git(root, ['commit', '-m', `lattice: story ${storyId} init`]);

    const output = await runLattice(root, 'story_discard', { storyId, force: true, purge: true, reason: 'smoke purge' });

    assert.match(output, /main init commit safely rolled back/, 'purge should report a safe reset');
    assert.equal(git(root, ['rev-parse', 'HEAD']), before, 'safe init commit should be reset');
    assert.equal(existsSync(join(root, '.lattice', 'story', 'actives', storyId)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * B-02a6 F-003: the buried-init-commit tombstone path.
 *
 * In production the safe-init commit is rarely at HEAD by the time a story is
 * discarded: other stories' init commits and the INIT-review metadata
 * auto-commits routinely land on main AFTER it, BURYING the init commit. Then
 * `purgeSafeInitCommit` cannot `git reset --hard HEAD~1` (HEAD is no longer the
 * pure-metadata init commit), so it bails with a ⚠ warning and discard falls
 * through to the `commitDiscardMetadata` tombstone: it `rmSync`s the story dir,
 * then COMMITS the deletion so main still converges to a clean tree instead of
 * leaving a tracked-but-deleted dirty state.
 *
 * This asserts the buried path end-to-end: discard converges, the metadata dir
 * is gone, the main checkout is clean (no dirty tracked-delete), and — crucially
 * — the buried init commit was NOT `HEAD~1`-reset away (the history above it,
 * including the unrelated later commit, is preserved).
 */
async function assertPurgeTombstonesBuriedSafeInitCommit(): Promise<void> {
  const root = initRepo('lattice-discard-purge-buried-');
  try {
    const storyId = 'B-buried';
    writeReviewStory(root, storyId);
    git(root, ['add', '.lattice/story/actives/B-buried']);
    git(root, ['commit', '-m', `lattice: story ${storyId} init`]);
    const initCommit = git(root, ['rev-parse', 'HEAD']);

    // BURY the init commit under an unrelated later commit on main, so it is no
    // longer HEAD and `purgeSafeInitCommit` cannot safe-reset it.
    write(root, 'unrelated.txt', 'later work on top of the init commit\n');
    git(root, ['add', 'unrelated.txt']);
    git(root, ['commit', '-m', 'unrelated: later commit burying the init commit']);
    const buryingCommit = git(root, ['rev-parse', 'HEAD']);

    const output = await runLattice(root, 'story_discard', { storyId, force: true, purge: true, reason: 'smoke buried purge' });

    // (a) discard converges to a clean tree via the tombstone, not a safe reset.
    assert.doesNotMatch(output, /main init commit safely rolled back/, 'buried init commit must NOT be safe-reset');
    assert.match(output, /discard metadata committed/, 'buried path must tombstone-commit the deletion');
    // (b) the story metadata dir is gone.
    assert.equal(existsSync(join(root, '.lattice', 'story', 'actives', storyId)), false, 'story metadata dir must be removed');
    // (c) the main checkout is clean — no tracked-but-deleted dirty state.
    assert.equal(git(root, ['status', '--porcelain']), '', 'main checkout must be clean after a buried-init tombstone discard');
    // (d) the buried init commit was NOT HEAD~1-reset: history above it is preserved.
    assert.equal(git(root, ['cat-file', '-t', initCommit]), 'commit', 'the buried init commit must still exist (not reset away)');
    const ancestry = git(root, ['rev-list', 'HEAD']).split('\n').filter(Boolean);
    assert.ok(ancestry.includes(initCommit), 'the buried init commit must remain reachable from HEAD (not reset away)');
    assert.ok(ancestry.includes(buryingCommit), 'the unrelated later commit must remain in main history');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDocsDriftAllowsBootstrapAndLegacyCommands(): void {
  const result = runDocsDriftGate([
    [
      '```bash',
      'lattice aux_scan',
      'lattice testintent_resume \'{"storyId":"B-001","itemId":"CHK-001"}\'',
      '```',
    ].join('\n'),
  ], new Set(['story_create']));
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.missing, []);
}

function assertChannelAllowsExplicitMainAgentPlanOwnership(): void {
  const root = initRepo('lattice-channel-main-owner-');
  try {
    const storyId = 'B-channel';
    const store = new StoryStore(root);
    const now = '2026-04-30T10:00:00.000Z';
    store.writeStory(storyId, {
      storyId,
      name: 'channel-main-owner-smoke',
      title: 'Channel main owner smoke',
      description: 'Synthetic normal-channel story with explicit main-agent ownership.',
      type: 'chore',
      phase: 'REVIEW',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [],
    });
    const ids = ['001', '002', '003', '004', '005', '006'].map(suffix => `CHK-${suffix}`);
    store.writeChecklist(storyId, {
      items: ids.map(id => ({
        id,
        title: `Synthetic ${id}`,
        context: 'Synthetic context',
        status: 'done' as const,
        startTime: now,
        endTime: now,
      })),
    });
    write(root, '.lattice/story/actives/B-channel/plan.md', [
      '# Plan: B-channel',
      ...ids.flatMap(id => [
        '',
        `## ${id}`,
        '**Owner**: main-agent',
        '**DependsOn**: none',
        '**Files**:',
        '- Modify: packages/main/src/example.ts',
        '**Verify**:',
        '- npm test',
        '**DoneWhen**:',
        '- synthetic condition',
      ]),
      '',
    ].join('\n'));

    const result = checkCommitAuthor(storyId, {
      store,
      projectRoot: root,
      gitLogReader: () => 'abcdef1234567890|Jane Developer|ordinary implementation commit',
    });

    assert.equal(result.status, 'pass');
    assert.match(result.summary, /Owner=main-agent/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertInitDispatchPromptHasTimeoutGuidance(): Promise<void> {
  const root = initRepo('lattice-init-dispatch-timeout-');
  try {
    const storyId = 'B-init';
    const now = '2026-04-30T10:00:00.000Z';
    new StoryStore(root).writeStory(storyId, {
      storyId,
      name: 'init-dispatch-timeout-smoke',
      title: 'Init dispatch timeout smoke',
      description: 'Synthetic story for init reviewer dispatch guidance.',
      type: 'chore',
      phase: 'INIT',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [],
    });

    const output = await runLattice(root, 'dispatch', { storyId, agentType: 'lattice-review-story-init' });
    assert.match(output, /INIT_REVIEW_START/, 'init dispatch should ask reviewer to emit start heartbeat');
    assert.match(output, /INIT_REVIEW_READ_DONE/, 'init dispatch should ask reviewer to emit read heartbeat');
    assert.match(output, /5 minutes/, 'init dispatch should include an upper time bound');
    assert.match(output, /4 minutes/, 'init dispatch should include main-agent retry guidance');
    assert.match(output, /init_check_set/, 'init dispatch should still require result recording');
    const events = new StoryStore(root).readProcessEvents(storyId);
    const dispatchEvent = events.find(ev => ev.type === 'dispatch');
    assert.equal(dispatchEvent?.targetKind, 'init-review', 'init dispatch should write an init-review dispatch event');
    assert.equal(dispatchEvent?.agentType, 'lattice-review-story-init', 'init dispatch should preserve reviewer agentType');
    assert.equal(dispatchEvent?.phase, 'INIT', 'init dispatch event should include story phase');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertItemDispatchWritesChannelEvidence(): Promise<void> {
  const root = initRepo('lattice-item-dispatch-event-');
  try {
    const storyId = 'B-dispatch';
    writeChecklistConcurrencyStory(root, storyId, 'DEV');

    const output = await runLattice(root, 'dispatch', {
      storyId,
      itemId: 'CHK-001',
      agentType: 'lattice-implementer',
    });
    assert.match(output, /CHK-001/, 'item dispatch should still return the item prompt');
    assert.match(output, /DISPATCH_START:lattice-implementer\/CHK-001/, 'item dispatch should ask worker to emit a liveness heartbeat');
    assert.match(output, /4 minutes/, 'item dispatch should include status-check timing');
    assert.match(output, /10 minutes\/600s/, 'item dispatch should include stalled retry timing');

    const events = new StoryStore(root).readProcessEvents(storyId);
    const dispatchEvent = events.find(ev => ev.type === 'dispatch' && ev.itemId === 'CHK-001');
    assert.equal(dispatchEvent?.targetKind, 'checklist', 'item dispatch should write checklist targetKind');
    assert.equal(dispatchEvent?.checklistId, 'CHK-001', 'item dispatch should write checklistId for channel gate');
    assert.equal(dispatchEvent?.agentType, 'lattice-implementer', 'item dispatch should write agentType');
    assert.equal(dispatchEvent?.phase, 'DEV', 'item dispatch event should include story phase');
    assert.equal(dispatchEvent?.source, 'lattice dispatch', 'item dispatch event should name source');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertTypedDispatchUsesRoleSafePromptsAndBoundaries(): Promise<void> {
  const root = initRepo('lattice-reviewer-item-dispatch-');
  try {
    const storyId = 'B-review-dispatch';
    writeChecklistConcurrencyStory(root, storyId, 'REVIEW');

    const output = await runLattice(root, 'dispatch', { storyId, agentType: 'lattice-review-quality' });
    assert.match(output, /As lattice-review-quality, review story/, 'story reviewer dispatch should identify reviewer role');
    assert.match(output, /Review only; do not change code/, 'reviewer item dispatch should constrain the role to review only');
    assert.match(output, /review_run_start/, 'reviewer item dispatch should require review_run_start before REVIEW evidence');
    assert.match(output, /finding_add/, 'reviewer item dispatch should tell reviewers how to record findings');
    assert.match(output, /review_pass_set/, 'reviewer item dispatch should tell reviewers how to record pass evidence');
    assert.match(output, /<reviewRunId>/, 'reviewer dispatch should use a fresh returned reviewRunId placeholder');
    assert.doesNotMatch(output, /:RR-001/, 'reviewer dispatch must not hard-code a synthetic reviewRunId');
    assert.doesNotMatch(output, /as lattice-implementer/, 'reviewer item dispatch must not generate implementer prompt');
    assert.doesNotMatch(output, /git commit/, 'reviewer item dispatch must not ask reviewer to commit');
    assert.doesNotMatch(output, /checklist_update/, 'reviewer item dispatch must not ask reviewer to mark checklist done');

    const events = new StoryStore(root).readProcessEvents(storyId);
    const dispatchEvent = events.find(ev => ev.type === 'dispatch' && ev.agentType === 'lattice-review-quality');
    assert.equal(dispatchEvent?.targetKind, 'story-review', 'reviewer dispatch should write story-review targetKind');
    assert.equal(dispatchEvent?.agentType, 'lattice-review-quality', 'reviewer item dispatch should preserve reviewer agentType');

    await assert.rejects(
      runLattice(root, 'dispatch', { storyId, itemId: 'CHK-001', agentType: 'lattice-review-quality' }),
      /story-only.*omit itemId/i,
      'story reviewer with itemId must fail closed with cardinality guidance',
    );
    await assert.rejects(
      runLattice(root, 'dispatch', { storyId, agentType: 'unknown-reviewer' }),
      /Invalid parameters|accepted|Invalid option|expected one of/i,
      'unknown explicit agent type must fail before prompt generation',
    );
    await assert.rejects(
      runLattice(root, 'checklist_update', { storyId, itemId: 'CHK-001', status: 'done' }, { LATTICE_AGENT: 'lattice-review-quality' }),
      /agent_dispatch_mutation_denied/,
      'reviewer role must not complete checklist status',
    );

    const planStoryId = 'B-verification-dispatch';
    writeChecklistConcurrencyStory(root, planStoryId, 'PLAN');
    for (const agentType of ['verification-intent', 'test-intent', 'test-case-reviewer']) {
      const verificationPrompt = await runLattice(root, 'dispatch', {
        storyId: planStoryId,
        itemId: 'CHK-001',
        agentType,
      });
      assert.match(verificationPrompt, /define verification intent/, `${agentType} must route to verification-intent prompt`);
      assert.doesNotMatch(verificationPrompt, /git commit|status["': ]+done/i, `${agentType} must not receive implementer completion guidance`);
    }
    await assert.rejects(
      runLattice(root, 'checklist_update', { storyId: planStoryId, itemId: 'CHK-001', status: 'done' }, { LATTICE_AGENT: 'test-intent' }),
      /agent_dispatch_mutation_scope_denied/,
      'verification-intent alias must not mark checklist done',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDoctorRepairCleansTerminalWorktrees(): Promise<void> {
  const root = initRepo('lattice-doctor-worktree-repair-');
  try {
    const store = new StoryStore(root);
    const now = '2026-04-30T10:00:00.000Z';
    for (const storyId of ['B-termreg', 'B-orphan', 'B-prune']) {
      store.writeStory(storyId, {
        storyId,
        name: `${storyId}-repair-smoke`,
        title: `${storyId} repair smoke`,
        description: 'Synthetic terminal story for doctor worktree repair smoke.',
        type: 'chore',
        phase: 'DONE',
        priority: 'medium',
        createdAt: now,
        startedAt: now,
        endedAt: now,
        events: [],
      });
    }
    git(root, ['add', '.lattice/story/actives']);
    git(root, ['commit', '-m', 'add terminal story metadata']);

    git(root, ['branch', 'story/B-termreg']);
    git(root, ['worktree', 'add', join(root, '.worktrees', 'B-termreg'), 'story/B-termreg']);

    mkdirSync(join(root, '.worktrees', 'B-orphan'), { recursive: true });
    writeFileSync(join(root, '.worktrees', 'B-orphan', 'runtime.log'), 'orphan residue\n');

    git(root, ['branch', 'story/B-prune']);
    git(root, ['worktree', 'add', join(root, '.worktrees', 'B-prune'), 'story/B-prune']);
    rmSync(join(root, '.worktrees', 'B-prune'), { recursive: true, force: true });

    const before = JSON.parse(await runLattice(root, 'doctor', { format: 'json' }));
    assert.equal(before.worktrees.needsRepair, true, 'doctor should detect terminal worktree repair targets');
    assert(
      before.worktrees.terminalRegistered.length > 0 || before.worktrees.orphanDirs.length > 0 || before.worktrees.terminalDirs.length > 0,
      'doctor should report at least one terminal/orphan target before repair',
    );

    const repaired = JSON.parse(await runLattice(root, 'doctor', { format: 'json', repair: true }));
    assert.equal(repaired.worktrees.needsRepair, false, 'doctor --repair should clear all terminal/orphan worktree targets');
    assert.equal(repaired.worktrees.terminalRegistered.length, 0, 'terminal registered worktrees should be gone after repair');
    assert.equal(repaired.worktrees.orphanDirs.length, 0, 'orphan dirs should be gone after repair');
    assert.equal(repaired.worktrees.terminalDirs.length, 0, 'terminal dirs should be gone after repair');
    assert.equal(existsSync(join(root, '.worktrees', 'B-termreg')), false, 'registered terminal worktree dir should be removed');
    assert.equal(existsSync(join(root, '.worktrees', 'B-orphan')), false, 'orphan terminal dir should be removed');
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), /story\/B-(termreg|prune)/, 'git worktree registry should be pruned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertStrayCleanupAllowsGeneratedReviewMetadata(): void {
  const root = initRepo('lattice-stray-generated-review-metadata-');
  try {
    const storyId = 'B-stray';
    const now = '2026-04-30T10:00:00.000Z';
    new StoryStore(root).writeStory(storyId, {
      storyId,
      name: 'stray-init-self-check-smoke',
      title: 'Stray init self check smoke',
      description: 'Synthetic story for DONE stray metadata cleanup.',
      type: 'chore',
      phase: 'TEST',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [],
    });
    git(root, ['add', '.lattice/story/actives']);
    git(root, ['commit', '-m', 'add story metadata']);

    assert(STRAY_FILE_WHITELIST.includes('init-self-check.json'), 'init-self-check.json should be a precise whitelist entry');
    assert(STRAY_FILE_WHITELIST.includes('review-passes.json'), 'review-passes.json should be a precise whitelist entry');
    const initSelfCheckPath = join(root, '.lattice/story/actives', storyId, 'init-self-check.json');
    const reviewPassesPath = join(root, '.lattice/story/actives', storyId, 'review-passes.json');
    writeFileSync(initSelfCheckPath, '{"reviewers":[]}\n');
    writeFileSync(reviewPassesPath, '{"passes":[]}\n');
    const report = cleanStrayWorktreeFiles(root, storyId, join(root, '.worktrees', storyId));
    assert.equal(existsSync(initSelfCheckPath), false, 'init-self-check.json should be removed as generated metadata');
    assert.equal(existsSync(reviewPassesPath), false, 'review-passes.json should be removed as generated metadata');
    assert(report.some(line => line.includes('init-self-check.json')), 'cleanup report should name init-self-check.json');
    assert(report.some(line => line.includes('review-passes.json')), 'cleanup report should name review-passes.json');

    const draftPath = join(root, '.lattice/story/actives', storyId, 'operator-note.txt');
    writeFileSync(draftPath, 'manual draft\n');
    assert.throws(
      () => cleanStrayWorktreeFiles(root, storyId, join(root, '.worktrees', storyId)),
      /operator-note\.txt/,
      'non-whitelisted story files should still block cleanup',
    );
    assert.equal(existsSync(draftPath), true, 'non-whitelisted story files should not be deleted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await assertReviewPassConcurrentWrites();
await assertChecklistConcurrentUpdates();
await assertChecklistConcurrentVerificationIntentUpdates();
await assertTypedDispatchUsesRoleSafePromptsAndBoundaries();
console.log('typed dispatch role/cardinality/mutation smoke PASS');
await assertDiscardRemovesUntrackedWorktreeAndBranch();
await assertDiscardCanCleanAlreadyDiscardedResidue();
await assertDiscardPrunesMissingWorktreeRegistry();
await assertDiscardCleansInvalidGitPointerResidue();
await assertDiscardForceFromInvalidWorktreeCwd();
await assertDiscardFailureDoesNotMarkSuccess();
await assertPurgeDropsSafeInitCommit();
await assertPurgeTombstonesBuriedSafeInitCommit();
await assertDoctorRepairCleansTerminalWorktrees();
await assertInitDispatchPromptHasTimeoutGuidance();
await assertItemDispatchWritesChannelEvidence();
assertStrayCleanupAllowsGeneratedReviewMetadata();
assertDocsDriftAllowsBootstrapAndLegacyCommands();
assertChannelAllowsExplicitMainAgentPlanOwnership();

console.log('✓ review pass and discard smoke passed');
