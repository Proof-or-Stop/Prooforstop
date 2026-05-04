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
    workflow: { profile: 'balanced' },
  }, null, 2));
  write(root, '.gitignore', [
    '.worktrees/',
    '**/activity.jsonl',
    '.koala/*',
    '!.koala/story/',
    '!.koala/story/**',
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

async function assertReviewPassConcurrentWrites(): Promise<void> {
  const root = initRepo('koala-review-pass-');
  try {
    const storyId = 'B-pass';
    writeReviewStory(root, storyId);
    const agents = ['concept', 'quality', 'test-coverage', 'docs'].map(name => `koala-review-${name}`);
    await Promise.all(agents.map(agent => runKoala(root, 'review_pass_set', {
      storyId,
      agent,
      note: `${agent} checked its assigned review surface and found no blocker.`,
    })));

    const data = new StoryStore(root).readReviewPasses(storyId);
    assert.equal(data.passes.length, agents.length, 'all parallel review passes should persist');
    assert.deepEqual(new Set(data.passes.map(pass => pass.agent)), new Set(agents));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertChecklistConcurrentUpdates(): Promise<void> {
  const root = initRepo('koala-checklist-concurrent-');
  try {
    const storyId = 'B-check';
    writeChecklistConcurrencyStory(root, storyId, 'DEV');
    await Promise.all(['CHK-001', 'CHK-002'].map(itemId => runKoala(root, 'checklist_update', {
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
  const root = initRepo('koala-checklist-intent-concurrent-');
  try {
    const storyId = 'B-intent';
    writeChecklistConcurrencyStory(root, storyId, 'PLAN');
    await Promise.all(['CHK-001', 'CHK-002'].map(itemId => runKoala(root, 'checklist_update', {
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
  const root = initRepo('koala-discard-worktree-');
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

    const output = await runKoala(root, 'story_discard', { storyId, force: true, reason: 'smoke cleanup' });

    assert.doesNotMatch(output, /worktree 和分支已清理/, 'discard hint must not claim blanket cleanup');
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`branch refs/heads/story/${storyId}`));
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'DISCARDED');
    assert.equal(git(root, ['status', '--porcelain']), '', 'story_discard should leave the repo clean after committing discarded metadata');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDiscardCanCleanAlreadyDiscardedResidue(): Promise<void> {
  const root = initRepo('koala-discard-residue-');
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

    const output = await runKoala(root, 'story_discard', { storyId, force: true, reason: 'smoke residue cleanup' });

    assert.match(output, /已是 DISCARDED；残留已检查\/清理/);
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`branch refs/heads/story/${storyId}`));
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'DISCARDED');
    assert.equal(git(root, ['status', '--porcelain']), '', 'already-discarded residue cleanup should leave the repo clean');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDiscardPrunesMissingWorktreeRegistry(): Promise<void> {
  const root = initRepo('koala-discard-prunable-');
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

    const output = await runKoala(root, 'story_discard', { storyId, force: true, reason: 'smoke prunable cleanup' });

    assert.match(output, /stale worktree metadata 已 prune/);
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`branch refs/heads/story/${storyId}`));
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '');
    assert.equal(existsSync(join(root, '.worktrees', storyId)), false, 'missing worktree dir should stay gone');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'DISCARDED');
    assert.equal(git(root, ['status', '--porcelain']), '', 'prunable discard cleanup should leave the repo clean');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDiscardFailureDoesNotMarkSuccess(): Promise<void> {
  const root = initRepo('koala-discard-fail-closed-');
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
      await runKoala(root, 'story_discard', { storyId, force: true, reason: 'smoke fail closed' });
    } catch (error) {
      failed = String((error as Error).message).includes('已停止 discard');
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
  const root = initRepo('koala-discard-purge-');
  try {
    const before = git(root, ['rev-parse', 'HEAD']);
    const storyId = 'B-purge';
    writeReviewStory(root, storyId);
    git(root, ['add', '.koala/story/actives/B-purge']);
    git(root, ['commit', '-m', `koala: story ${storyId} init`]);

    const output = await runKoala(root, 'story_discard', { storyId, force: true, purge: true, reason: 'smoke purge' });

    assert.match(output, /main init commit 已安全回退/, 'purge should report a safe reset');
    assert.equal(git(root, ['rev-parse', 'HEAD']), before, 'safe init commit should be reset');
    assert.equal(existsSync(join(root, '.koala', 'story', 'actives', storyId)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDocsDriftAllowsBootstrapAndLegacyCommands(): void {
  const result = runDocsDriftGate([
    [
      '```bash',
      'koala aux_scan',
      'koala testintent_resume \'{"storyId":"B-001","itemId":"CHK-001"}\'',
      '```',
    ].join('\n'),
  ], new Set(['story_create']));
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.missing, []);
}

function assertChannelAllowsExplicitMainAgentPlanOwnership(): void {
  const root = initRepo('koala-channel-main-owner-');
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
    write(root, '.koala/story/actives/B-channel/plan.md', [
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
  const root = initRepo('koala-init-dispatch-timeout-');
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

    const output = await runKoala(root, 'dispatch', { storyId, agentType: 'koala-review-story-init' });
    assert.match(output, /INIT_REVIEW_START/, 'init dispatch should ask reviewer to emit start heartbeat');
    assert.match(output, /INIT_REVIEW_READ_DONE/, 'init dispatch should ask reviewer to emit read heartbeat');
    assert.match(output, /5 分钟/, 'init dispatch should include an upper time bound');
    assert.match(output, /4 分钟/, 'init dispatch should include main-agent retry guidance');
    assert.match(output, /init_check_set/, 'init dispatch should still require result recording');
    const events = new StoryStore(root).readProcessEvents(storyId);
    const dispatchEvent = events.find(ev => ev.type === 'dispatch');
    assert.equal(dispatchEvent?.targetKind, 'init-review', 'init dispatch should write an init-review dispatch event');
    assert.equal(dispatchEvent?.agentType, 'koala-review-story-init', 'init dispatch should preserve reviewer agentType');
    assert.equal(dispatchEvent?.phase, 'INIT', 'init dispatch event should include story phase');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertItemDispatchWritesChannelEvidence(): Promise<void> {
  const root = initRepo('koala-item-dispatch-event-');
  try {
    const storyId = 'B-dispatch';
    writeChecklistConcurrencyStory(root, storyId, 'DEV');

    const output = await runKoala(root, 'dispatch', {
      storyId,
      itemId: 'CHK-001',
      agentType: 'koala-implementer',
    });
    assert.match(output, /CHK-001/, 'item dispatch should still return the item prompt');

    const events = new StoryStore(root).readProcessEvents(storyId);
    const dispatchEvent = events.find(ev => ev.type === 'dispatch' && ev.itemId === 'CHK-001');
    assert.equal(dispatchEvent?.targetKind, 'checklist', 'item dispatch should write checklist targetKind');
    assert.equal(dispatchEvent?.checklistId, 'CHK-001', 'item dispatch should write checklistId for channel gate');
    assert.equal(dispatchEvent?.agentType, 'koala-implementer', 'item dispatch should write agentType');
    assert.equal(dispatchEvent?.phase, 'DEV', 'item dispatch event should include story phase');
    assert.equal(dispatchEvent?.source, 'koala dispatch', 'item dispatch event should name source');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertDoctorRepairCleansTerminalWorktrees(): Promise<void> {
  const root = initRepo('koala-doctor-worktree-repair-');
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
    git(root, ['add', '.koala/story/actives']);
    git(root, ['commit', '-m', 'add terminal story metadata']);

    git(root, ['branch', 'story/B-termreg']);
    git(root, ['worktree', 'add', join(root, '.worktrees', 'B-termreg'), 'story/B-termreg']);

    mkdirSync(join(root, '.worktrees', 'B-orphan'), { recursive: true });
    writeFileSync(join(root, '.worktrees', 'B-orphan', 'runtime.log'), 'orphan residue\n');

    git(root, ['branch', 'story/B-prune']);
    git(root, ['worktree', 'add', join(root, '.worktrees', 'B-prune'), 'story/B-prune']);
    rmSync(join(root, '.worktrees', 'B-prune'), { recursive: true, force: true });

    const before = JSON.parse(await runKoala(root, 'doctor', { format: 'json' }));
    assert.equal(before.worktrees.needsRepair, true, 'doctor should detect terminal worktree repair targets');
    assert(
      before.worktrees.terminalRegistered.length > 0 || before.worktrees.orphanDirs.length > 0 || before.worktrees.terminalDirs.length > 0,
      'doctor should report at least one terminal/orphan target before repair',
    );

    const repaired = JSON.parse(await runKoala(root, 'doctor', { format: 'json', repair: true }));
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

function assertStrayCleanupAllowsInitSelfCheck(): void {
  const root = initRepo('koala-stray-init-self-check-');
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
    git(root, ['add', '.koala/story/actives']);
    git(root, ['commit', '-m', 'add story metadata']);

    assert(STRAY_FILE_WHITELIST.includes('init-self-check.json'), 'init-self-check.json should be a precise whitelist entry');
    const initSelfCheckPath = join(root, '.koala/story/actives', storyId, 'init-self-check.json');
    writeFileSync(initSelfCheckPath, '{"reviewers":[]}\n');
    const report = cleanStrayWorktreeFiles(root, storyId, join(root, '.worktrees', storyId));
    assert.equal(existsSync(initSelfCheckPath), false, 'init-self-check.json should be removed as generated metadata');
    assert(report.some(line => line.includes('init-self-check.json')), 'cleanup report should name init-self-check.json');

    const draftPath = join(root, '.koala/story/actives', storyId, 'operator-note.txt');
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
await assertDiscardRemovesUntrackedWorktreeAndBranch();
await assertDiscardCanCleanAlreadyDiscardedResidue();
await assertDiscardPrunesMissingWorktreeRegistry();
await assertDiscardFailureDoesNotMarkSuccess();
await assertPurgeDropsSafeInitCommit();
await assertDoctorRepairCleansTerminalWorktrees();
await assertInitDispatchPromptHasTimeoutGuidance();
await assertItemDispatchWritesChannelEvidence();
assertStrayCleanupAllowsInitSelfCheck();
assertDocsDriftAllowsBootstrapAndLegacyCommands();
assertChannelAllowsExplicitMainAgentPlanOwnership();

console.log('✓ review pass and discard smoke passed');
