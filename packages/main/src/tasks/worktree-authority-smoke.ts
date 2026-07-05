#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, ClosingSelfCheck, DocsPromise, RealMachineTest, StoryInfo } from '../core/types.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { assertCwdInWorktree } from '../handlers/context.js';
import { createDoneRecoverHandlers } from '../handlers/done-recover.js';
import {
  isDoneMainRuntimeBuildInput,
  runDoneMainPackageBuildAfterMerge,
  shouldBuildDoneMainPackageForChangedPaths,
} from '../handlers/done-effects.js';
import { commitInitCheckMetadataAndMergeMain } from '../cli/init-check-metadata-sync.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function gitSucceeds(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function runLattice(root: string, command: string, args: Record<string, unknown>): string {
  return execFileSync(process.execPath, [cliPath, command, JSON.stringify(args)], {
    cwd: root,
    env: { ...process.env, LATTICE_PROJECT_ROOT: root },
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runLatticeFromCwd(cwd: string, command: string, args: Record<string, unknown>): string {
  const env = { ...process.env };
  delete env.LATTICE_PROJECT_ROOT;
  return execFileSync(process.execPath, [cliPath, command, JSON.stringify(args)], {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runLatticeExpectFail(root: string, command: string, args: Record<string, unknown>): string {
  try {
    runLattice(root, command, args);
  } catch (e: any) {
    return [
      e?.stdout?.toString?.() ?? '',
      e?.stderr?.toString?.() ?? '',
      e?.message ?? '',
    ].join('\n');
  }
  assert.fail(`${command} should have failed`);
}

function runLatticeFromCwdExpectFail(cwd: string, command: string, args: Record<string, unknown>): string {
  try {
    runLatticeFromCwd(cwd, command, args);
  } catch (e: any) {
    return [
      e?.stdout?.toString?.() ?? '',
      e?.stderr?.toString?.() ?? '',
      e?.message ?? '',
    ].join('\n');
  }
  assert.fail(`${command} should have failed`);
}

/**
 * Spawn one real `lattice story_advance` OS child process from `cwd`; resolves
 * with its exit code + combined stdout/stderr. Real child processes (not an
 * in-process `Promise.all`) are required for a genuine multi-session race: an
 * in-process call would serialize on a single event loop and the unified main
 * write lock — a cross-process filesystem lock — would never be exercised.
 */
function spawnStoryAdvance(cwd: string, args: Record<string, unknown>): Promise<{ code: number; output: string }> {
  return new Promise((resolveP) => {
    const env = { ...process.env };
    delete env.LATTICE_PROJECT_ROOT;
    const child = spawn(process.execPath, [cliPath, 'story_advance', JSON.stringify(args)], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { out += d; });
    child.on('close', (code) => resolveP({ code: code ?? -1, output: out }));
  });
}

function validBackground(): string {
  return [
    '## Trigger Event',
    '2026-06-12 B-85ba F-006 smoke pins the new fromDraft lifecycle after the old direct INIT_CHECK bootstrap expectation was retired.',
    '',
    '## Key Insights',
    'The draft path only materializes reviewed story material into INIT. The normal INIT reviewers and scope anti-expansion artifacts must pass before story_advance INIT_CHECK creates a worktree.',
    '',
    '## Solution Tradeoffs',
    'The smoke keeps the story tiny and validates the user visible path. It exercises public CLI commands for both fromDraft creation and the later INIT_CHECK bootstrap instead of importing private helper internals.',
    '',
    '## Conversation Texture',
    'A user expects fromDraft to stop conservatively in INIT and point at the gated next step. The worktree path should appear only after the explicit INIT_CHECK advance succeeds.',
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-authority-recorded-'));
  const previousCwd = process.cwd();
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
    }, null, 2));
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    write(root, 'README.md', 'authority smoke\n');
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'base']);
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
      /must execute lattice commands inside the worktree/,
    );
    process.chdir(worktreePath);
    assert.doesNotThrow(() => assertCwdInWorktree(store, storyId));
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

function assertInitCheckChecklistMutationRejectsMainCwd(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-authority-init-check-'));
  const previousCwd = process.cwd();
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
    }, null, 2));
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    write(root, 'README.md', 'init check authority smoke\n');
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'base']);
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
    const output = runLatticeExpectFail(root, 'checklist_add', {
      storyId,
      title: 'Should not land in main',
      context: 'INIT_CHECK linked stories must still use the story worktree authority.',
    });
    assert.match(output, /must execute lattice commands inside the worktree/);
    assert.equal(new StoryStore(root).readChecklist(storyId).items.length, 1);
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

function assertTerminalStoriesDoNotRedirect(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-authority-terminal-'));
  const previousCwd = process.cwd();
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
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

function recordPassingInitAndScopeGates(root: string, storyId: string): void {
  runLattice(root, 'init_check_set', { storyId, issues: [], agentId: 'lattice-review-story-init' });
  runLattice(root, 'init_check_set', { storyId, issues: [], agentId: 'product-reviewer', agent: 'product-reviewer' });
  runLattice(root, 'scope_boundary_set', {
    storyId,
    mode: 'custom',
    allowedScope: ['Materialize reviewed draft metadata and bootstrap the story worktree only through INIT_CHECK.'],
    excludedScope: ['Do not create a story worktree during story_create --fromDraft.'],
    userConfirmed: true,
    actor: 'worktree-authority-smoke',
    confirmation: 'B-85ba F-006 fromDraft smoke expects conservative INIT creation followed by explicit INIT_CHECK bootstrap.',
  });
  runLattice(root, 'execution_boundary_set', {
    storyId,
    allowedCommands: [
      'story_create --fromDraft',
      'init_check_set',
      'scope_boundary_set',
      'execution_boundary_set',
      'scope_freeze_check',
      'story_advance INIT_CHECK',
      'git status',
      'git worktree list',
      'git merge-base',
    ],
    allowedPaths: ['.lattice/story/actives', 'docs/story/drafts', '.worktrees'],
    actor: 'worktree-authority-smoke',
    notes: 'FromDraft smoke may inspect bounded lifecycle metadata and the eventual worktree bootstrap.',
  });
  runLattice(root, 'scope_freeze_check', {
    storyId,
    status: 'PASS',
    actor: 'worktree-authority-smoke',
    note: 'FromDraft smoke scope is frozen before INIT_CHECK worktree bootstrap.',
  });
}

function assertFromDraftStopsAtInitThenBootstrapsThroughInitCheck(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-from-draft-worktree-'));
  const draftName = 'from-draft-smoke';
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
    }, null, 2));
    write(root, 'README.md', 'from draft smoke\n');
    write(root, '.gitignore', '.worktrees/\n.lattice/activity.jsonl\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'base']);
    resetConfigCache();

    runLattice(root, 'story_draft', {
      name: draftName,
      title: 'From draft smoke story',
      description: 'Synthetic from-draft story for worktree bootstrap.',
      type: 'chore',
      priority: 'medium',
      background: validBackground(),
      checklist: [{
        title: 'Create INIT story from draft',
        context: 'The fromDraft CLI path must stop at INIT; worktree bootstrap happens later through gated INIT_CHECK.',
      }],
    });
    runLattice(root, 'draft_check_set', {
      draftName,
      issues: [],
      agentId: 'lattice-review-story-init',
    });
    const output = runLattice(root, 'story_create', { fromDraft: draftName });
    const storyId = output.match(/Story\s+(B-[a-f0-9]+)/)?.[1];
    assert.ok(storyId, `story_create --from-draft should print story id, got: ${output}`);
    const story = new StoryStore(root).readStory(storyId);
    assert.equal(story.phase, 'INIT');
    assert.equal(story.worktree, undefined, 'fromDraft story must not record worktree metadata at creation');
    assert.match(output, /created from draft .* \(INIT\)/, 'fromDraft output should report conservative INIT creation');
    assert.match(output, /normal INIT reviewer and scope anti-expansion gates/, 'fromDraft output should point at normal INIT gates');
    assert.doesNotMatch(output, /main merged into story\//, 'story_create --fromDraft must not run worktree bootstrap sync');
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`), 'fromDraft creation must not register a story worktree');

    recordPassingInitAndScopeGates(root, storyId);
    const advanced = runLattice(root, 'story_advance', { storyId, phase: 'INIT_CHECK' });
    assert.match(advanced, /advanced to INIT_CHECK/, 'explicit INIT_CHECK advance should succeed');
    assert.match(advanced, /INIT_CHECK metadata committed/, 'INIT_CHECK output should report main metadata commit');

    const advancedStory = new StoryStore(root).readStory(storyId);
    assert.equal(advancedStory.phase, 'INIT_CHECK');
    assert.ok(advancedStory.worktree?.path, 'explicit INIT_CHECK should record worktree metadata');
    assert.match(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`));
    assert.equal(
      git(root, ['status', '--porcelain', '--', `.lattice/story/actives/${storyId}`, `docs/story/drafts/${draftName}`]),
      '',
      'fromDraft + INIT_CHECK should leave bounded story/draft metadata clean',
    );
    assert.equal(
      gitSucceeds(root, ['merge-base', '--is-ancestor', 'main', `story/${storyId}`]),
      true,
      'fromDraft story branch should contain current main after explicit INIT_CHECK bootstrap',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertFromDraftStopsAtInitWithDirtyMainPreserved(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-from-draft-dirty-main-'));
  const draftName = 'from-draft-dirty-main-smoke';
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
    }, null, 2));
    write(root, 'README.md', 'from draft dirty main smoke\n');
    write(root, '.gitignore', '.worktrees/\n.lattice/activity.jsonl\n');
    write(root, 'unrelated-tracked.txt', 'tracked baseline\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'base']);
    resetConfigCache();

    runLattice(root, 'story_draft', {
      name: draftName,
      title: 'From draft dirty main smoke story',
      description: 'Synthetic from-draft story for dirty main preservation.',
      type: 'chore',
      priority: 'medium',
      background: validBackground(),
      checklist: [{
        title: 'Create INIT story from draft while main has unrelated edits',
        context: 'The fromDraft CLI path must commit bounded metadata without consuming user changes or creating a worktree.',
      }],
    });
    runLattice(root, 'draft_check_set', {
      draftName,
      issues: [],
      agentId: 'lattice-review-story-init',
    });
    git(root, ['add', '--', `docs/story/drafts/${draftName}`]);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'draft metadata']);

    write(root, 'unrelated-tracked.txt', 'tracked user edit that must remain dirty\n');
    write(root, 'unrelated-untracked.txt', 'untracked user edit that must remain dirty\n');
    const dirtyBefore = git(root, ['status', '--porcelain']);
    assert.equal(git(root, ['diff', '--name-only', '--', 'unrelated-tracked.txt']), 'unrelated-tracked.txt');
    assert.match(dirtyBefore, /\?\? unrelated-untracked\.txt/);

    const output = runLattice(root, 'story_create', { fromDraft: draftName });
    const storyId = output.match(/Story\s+(B-[a-f0-9]+)/)?.[1];
    assert.ok(storyId, `story_create --from-draft should print story id, got: ${output}`);
    const story = new StoryStore(root).readStory(storyId);
    assert.equal(story.phase, 'INIT');
    assert.equal(story.worktree, undefined, 'fromDraft should not record worktree metadata while stopping at INIT');
    assert.match(output, /created from draft .* \(INIT\)/, 'fromDraft output should report conservative INIT creation');
    assert.doesNotMatch(output, /main merged into story\//, 'fromDraft creation should not merge main into a story branch');
    assert.equal(
      git(root, ['status', '--porcelain', '--', `.lattice/story/actives/${storyId}`, `docs/story/drafts/${draftName}`]),
      '',
      'fromDraft should leave bounded story/draft metadata clean after committing',
    );
    const dirtyAfter = git(root, ['status', '--porcelain']);
    assert.equal(
      git(root, ['diff', '--name-only', '--', 'unrelated-tracked.txt']),
      'unrelated-tracked.txt',
      'tracked user edits should remain dirty',
    );
    assert.match(dirtyAfter, /\?\? unrelated-untracked\.txt/, 'untracked user edits should remain dirty');
    assert.equal(
      gitSucceeds(root, ['show-ref', '--verify', `refs/heads/story/${storyId}`]),
      false,
      'fromDraft creation must not create a story branch while stopping at INIT',
    );
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`), 'fromDraft creation must not register a story worktree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertFromDraftRejectsStagedMainBeforeMutation(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-from-draft-staged-main-'));
  const draftName = 'from-draft-staged-main-smoke';
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
    }, null, 2));
    write(root, 'README.md', 'from draft staged main smoke\n');
    write(root, '.gitignore', '.worktrees/\n.lattice/activity.jsonl\n');
    write(root, 'unrelated-staged.txt', 'tracked baseline\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'base']);
    resetConfigCache();

    runLattice(root, 'story_draft', {
      name: draftName,
      title: 'From draft staged main smoke story',
      description: 'Synthetic from-draft story for staged main preflight.',
      type: 'chore',
      priority: 'medium',
      background: validBackground(),
      checklist: [{
        title: 'Reject from draft while main has unrelated staged edits',
        context: 'The fromDraft CLI path must reject staged user changes before mutating story, draft, or worktree state.',
      }],
    });
    runLattice(root, 'draft_check_set', {
      draftName,
      issues: [],
      agentId: 'lattice-review-story-init',
    });
    git(root, ['add', '--', `docs/story/drafts/${draftName}`]);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'draft metadata']);

    write(root, 'unrelated-staged.txt', 'staged user edit that must remain staged\n');
    git(root, ['add', '--', 'unrelated-staged.txt']);
    assert.equal(git(root, ['diff', '--cached', '--name-status', '--', 'unrelated-staged.txt']), 'M\tunrelated-staged.txt');

    const output = runLatticeExpectFail(root, 'story_create', { fromDraft: draftName });
    assert.match(output, /requires a clean git index before mutating story\/draft\/worktree metadata/);
    assert.match(output, /unrelated-staged\.txt/);
    const store = new StoryStore(root);
    assert.deepEqual(store.listStoryIds(), [], 'fromDraft staged-main preflight must not create an active story');
    assert.equal(existsSync(join(root, 'docs', 'story', 'drafts', draftName, 'index.json')), true, 'source draft should remain present');
    assert.equal(
      git(root, ['ls-files', '--error-unmatch', `docs/story/drafts/${draftName}/index.json`]),
      `docs/story/drafts/${draftName}/index.json`,
      'source draft should remain tracked',
    );
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), /story\/B-/, 'no story worktree should be registered');
    assert.equal(
      git(root, ['diff', '--cached', '--name-status', '--', 'unrelated-staged.txt']),
      'M\tunrelated-staged.txt',
      'unrelated staged change should remain staged',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeDoneGateEvidence(store: StoryStore, root: string, storyId: string): void {
  const now = '2026-05-08T10:00:00.000Z';
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root);
  assert.ok(headHash, 'worktree authority smoke fixture must have git HEAD for delivery-check freshness');
  assert.ok(materialHash, 'worktree authority smoke fixture must have materialHash for delivery-check freshness');
  store.writeTestEvidence(storyId, {
    command: 'worktree authority smoke',
    output: JSON.stringify({ allPass: true, summary: 'nested DONE cleanup smoke passed' }),
    result: 'PASS',
    timestamp: now,
    headHash,
    materialHash,
    verificationCoverage: {
      total: 0,
      required: 0,
      covered: 0,
      missingRequired: 0,
      entries: [],
    },
  });

  const docsPromises: DocsPromise[] = [];
  const realMachineTests: RealMachineTest[] = [{
    featureId: 'nested-done-cleanup',
    transcript: 'lattice story_advance DONE was invoked from PVSC/child and cleaned the canonical worktree root.',
  }];
  const closingSelfCheck: ClosingSelfCheck = {
    hasRealMachineTest: true,
    hasEdgeCaseCoverage: true,
    hasUnresolvedTodos: false,
    summary: 'Nested cwd DONE cleanup path verified.',
  };
  store.writeDeliveryCheck(storyId, {
    storyId,
    checkedAt: now,
    headHash,
    materialHash,
    reviewRound: '',
    agentId: 'lattice-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, '', materialHash),
  });
}

function assertDoneFromNestedCwdUsesCanonicalWorktreeRoot(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-nested-done-cleanup-'));
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
      workflow: { profile: 'light' },
    }, null, 2));
    write(root, 'README.md', 'nested done cleanup smoke\n');
    // B-9027 CHK-003: PVSC/ holds simulated runtime residue written inside the
    // nested invocation cwd. B-6326/B-4b22 dirty-gate hardening classifies any
    // non-whitelisted untracked path under the worktree as unexpected_dirty_files
    // and blocks DONE — that would short-circuit this test before it reaches the
    // canonical-cleanup-root logic it exists to prove. Declaring PVSC/ in
    // .gitignore makes `git status --porcelain --untracked-files=all` (the dirty
    // gate's only source) stop reporting the residue, so the tree reads clean and
    // the DONE merge/cleanup path runs. The fix is scoped to this test fixture:
    // it does NOT touch the dirty gate, the runtime-artifact registry, or any
    // allowlist. The test's original intent is preserved — the residue file is
    // still written into the nested cwd and the assertions still prove DONE
    // cleans the canonical worktree root, not the nested cwd.
    write(root, '.gitignore', 'PVSC/\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'base']);
    resetConfigCache();

    const storyId = 'B-nested-done';
    const worktreePath = join(root, '.worktrees', storyId);
    const store = new StoryStore(root);
    writeStory(store, storyId, 'TEST', {
      path: `.worktrees/${storyId}`,
      branch: `story/${storyId}`,
      createdAt: '2026-05-08T10:00:00.000Z',
    });
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'story metadata']);
    git(root, ['branch', `story/${storyId}`]);
    git(root, ['worktree', 'add', worktreePath, `story/${storyId}`]);

    resetConfigCache();
    const worktreeStore = new StoryStore(worktreePath);
    writeDoneGateEvidence(worktreeStore, worktreePath, storyId);
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'done gate evidence']);

    const nestedCwd = join(worktreePath, 'PVSC', 'child');
    mkdirSync(nestedCwd, { recursive: true });
    writeFileSync(join(nestedCwd, 'runtime.txt'), 'runtime residue that must not become the cleanup root\n');

    const output = runLatticeFromCwd(nestedCwd, 'story_advance', { storyId, phase: 'DONE' });
    assert.doesNotMatch(output, /PVSC/, 'DONE output must not target the nested invocation cwd');
    assert.doesNotMatch(output, new RegExp(nestedCwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'DONE output must not mention the child cwd as cleanup target');

    const doneStory = new StoryStore(root).readStory(storyId);
    assert.equal(doneStory.phase, 'DONE');
    assert.equal(doneStory.worktree, undefined, 'main metadata should clear worktree after DONE merge');
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '', 'story branch should be deleted');
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`), 'worktree registry should be clean');
    assert.equal(existsSync(worktreePath), false, 'canonical worktree directory should be removed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDoneRejectsMismatchedStoryBranchBeforeMutation(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-mismatched-done-branch-'));
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
      workflow: { profile: 'light' },
    }, null, 2));
    write(root, 'README.md', 'mismatched done branch smoke\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'base']);
    resetConfigCache();

    const storyId = 'B-expected';
    const wrongBranch = 'story/B-other';
    const worktreePath = join(root, '.worktrees', storyId);
    const store = new StoryStore(root);
    writeStory(store, storyId, 'TEST', {
      path: `.worktrees/${storyId}`,
      branch: `story/${storyId}`,
      createdAt: '2026-05-08T10:00:00.000Z',
    });
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'story metadata']);
    git(root, ['branch', wrongBranch]);
    git(root, ['worktree', 'add', worktreePath, wrongBranch]);
    write(root, 'main-only-after-wrong-story-branch.txt', 'main commit that must not auto-merge before wrong-branch rejection\n');
    git(root, ['add', 'main-only-after-wrong-story-branch.txt']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'main moves after wrong story branch checkout']);
    const mainHeadAfterCheckout = git(root, ['rev-parse', 'main']);

    resetConfigCache();
    const worktreeStore = new StoryStore(worktreePath);
    writeDoneGateEvidence(worktreeStore, worktreePath, storyId);
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'done gate evidence on wrong branch']);

    const output = runLatticeFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(output, /detected branch story\/B-other but expected story\/B-expected/);
    assert.match(output, /merge\/delete aborted before mutating story state/);
    assert.equal(new StoryStore(worktreePath).readStory(storyId).phase, 'TEST', 'wrong branch must not mark story DONE');
    assert.equal(gitSucceeds(root, ['merge-base', '--is-ancestor', mainHeadAfterCheckout, wrongBranch]), false, 'wrong branch must not be auto-synced with main before rejection');
    assert.equal(existsSync(join(worktreePath, 'main-only-after-wrong-story-branch.txt')), false, 'wrong branch worktree must not receive main-only files before rejection');
    assert.notEqual(git(root, ['branch', '--list', wrongBranch]), '', 'wrong branch must not be deleted');
    assert.match(git(root, ['worktree', 'list', '--porcelain']), new RegExp(wrongBranch), 'wrong worktree must remain registered');
    assert.equal(existsSync(worktreePath), true, 'wrong worktree directory must not be removed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDoneRejectsNonStoryLinkedWorktreeBeforeMutation(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-non-story-done-branch-'));
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
      workflow: { profile: 'light' },
    }, null, 2));
    write(root, 'README.md', 'non-story done branch smoke\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'base']);
    resetConfigCache();

    const storyId = 'B-non-story';
    const wrongBranch = 'feature/not-story';
    const worktreePath = join(root, '.worktrees', storyId);
    const store = new StoryStore(root);
    writeStory(store, storyId, 'TEST', {
      path: `.worktrees/${storyId}`,
      branch: `story/${storyId}`,
      createdAt: '2026-05-08T10:00:00.000Z',
    });
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'story metadata']);
    git(root, ['branch', wrongBranch]);
    git(root, ['worktree', 'add', worktreePath, wrongBranch]);
    write(root, 'main-only-after-non-story-branch.txt', 'main commit that must not auto-merge before non-story rejection\n');
    git(root, ['add', 'main-only-after-non-story-branch.txt']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'main moves after non-story branch checkout']);
    const mainHeadAfterCheckout = git(root, ['rev-parse', 'main']);

    resetConfigCache();
    const worktreeStore = new StoryStore(worktreePath);
    writeDoneGateEvidence(worktreeStore, worktreePath, storyId);
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'done gate evidence on non-story branch']);

    const output = runLatticeFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(output, /detected branch feature\/not-story but expected story\/B-non-story/);
    assert.match(output, /merge\/delete aborted before mutating story state/);
    assert.equal(new StoryStore(worktreePath).readStory(storyId).phase, 'TEST', 'non-story branch must not mark worktree story DONE');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'TEST', 'non-story branch must not mutate main story metadata');
    assert.equal(gitSucceeds(root, ['merge-base', '--is-ancestor', mainHeadAfterCheckout, wrongBranch]), false, 'non-story branch must not be auto-synced with main before rejection');
    assert.equal(existsSync(join(worktreePath, 'main-only-after-non-story-branch.txt')), false, 'non-story worktree must not receive main-only files before rejection');
    assert.notEqual(git(root, ['branch', '--list', wrongBranch]), '', 'non-story branch must not be deleted');
    assert.match(git(root, ['worktree', 'list', '--porcelain']), new RegExp(wrongBranch), 'non-story worktree must remain registered');
    assert.equal(existsSync(worktreePath), true, 'non-story worktree directory must not be removed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// B-9027 CHK-002 / CHK-003 regression coverage for the done-effects.ts
// extraction (runDonePreMergeGate / applyDoneMergeEffects). These prove that
// the behavior-preserving extraction kept two invariants intact:
//   - pre-merge gate failures throw while the story is still TEST (phase=DONE
//     is never written) — CHK-002 case ①
//   - post-merge / cleanup failures throw AFTER phase=DONE is persisted, with
//     the manual-recovery guidance, and never silently swallow the error —
//     CHK-002 cases ②③
// and that the success path (Step1 metadata commit → Step3 merge → Step4
// worktree remove → Step5 branch delete) still produces byte-identical output
// (CHK-003).
// ---------------------------------------------------------------------------

/**
 * Build a TEST-phase story with a linked story worktree and (optionally) the
 * DONE-gate evidence committed onto the story branch. Returns the paths the
 * caller needs. The story branch always contains main (worktree is added from
 * the story branch after the metadata commit), so DONE's merge-base ancestor
 * check passes by construction.
 *
 * `opts.beforeEvidence` runs after the worktree is created but BEFORE the
 * DONE-gate evidence is written/committed — callers that need extra commits on
 * the story branch must mutate the worktree there so the recorded materialHash
 * reflects the final tree (otherwise the evidence-freshness gate fails). It is
 * not invoked when `withGateEvidence` is false.
 */
function buildDoneReadyStory(
  root: string,
  storyId: string,
  opts?: { withGateEvidence?: boolean; beforeEvidence?: (worktreePath: string) => void },
): { worktreePath: string; store: StoryStore } {
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'light' },
  }, null, 2));
  write(root, 'README.md', `done-effects regression smoke ${storyId}\n`);
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'base']);
  resetConfigCache();

  const worktreePath = join(root, '.worktrees', storyId);
  const store = new StoryStore(root);
  writeStory(store, storyId, 'TEST', {
    path: `.worktrees/${storyId}`,
    branch: `story/${storyId}`,
    createdAt: '2026-05-08T10:00:00.000Z',
  });
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'story metadata']);
  git(root, ['branch', `story/${storyId}`]);
  git(root, ['worktree', 'add', worktreePath, `story/${storyId}`]);

  if (opts?.withGateEvidence !== false) {
    // Extra branch commits must land BEFORE writeDoneGateEvidence so the
    // materialHash recorded in the evidence matches the final worktree tree.
    opts?.beforeEvidence?.(worktreePath);
    resetConfigCache();
    const worktreeStore = new StoryStore(worktreePath);
    writeDoneGateEvidence(worktreeStore, worktreePath, storyId);
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'done gate evidence']);
  }
  return { worktreePath, store };
}

function assertDoneMainPackageBuildTriggerPredicate(): void {
  const watched = [
    'packages/main/src/handlers/done-effects.ts',
    'packages/main/src/index.ts',
    'packages/main/package.json',
    'packages/main/package-lock.json',
    'packages/main/tsconfig.json',
    'packages/main/tests/smoke.ts',
    'package.json',
    'package-lock.json',
  ];
  for (const path of watched) {
    assert.equal(isDoneMainRuntimeBuildInput(path), true, `${path} must trigger the post-DONE packages/main build`);
  }
  assert.equal(
    shouldBuildDoneMainPackageForChangedPaths(watched),
    true,
    'any watched runtime input in the merge diff must trigger the packages/main build',
  );

  const skipped = [
    'docs/requirements/decisions/story-lifecycle.md',
    'README.md',
    'packages/main/README.md',
    'packages/lab/src/index.ts',
  ];
  for (const path of skipped) {
    assert.equal(isDoneMainRuntimeBuildInput(path), false, `${path} must not trigger the post-DONE packages/main build`);
  }
  assert.equal(
    shouldBuildDoneMainPackageForChangedPaths(skipped),
    false,
    'docs-only and unrelated package changes must skip the packages/main build',
  );
}

function assertDoneMainPackageBuildHookReportsSkipSuccessFailure(): void {
  let buildCalls = 0;
  const skipLine = runDoneMainPackageBuildAfterMerge('/tmp/lattice-unused-main', 'before', 'after', {
    changedPaths: ['docs/requirements/decisions/story-lifecycle.md'],
    buildRunner: () => {
      buildCalls += 1;
      return { status: 0, stdout: 'should not run' };
    },
  });
  assert.equal(buildCalls, 0, 'skip branch must not invoke the build runner');
  assert.match(skipLine, /packages\/main build skipped after DONE merge/, 'skip branch must return a visible skip line');

  const successLine = runDoneMainPackageBuildAfterMerge('/tmp/lattice-main', 'before', 'after', {
    changedPaths: ['packages/main/src/handlers/done-effects.ts'],
    buildRunner: (cwd) => {
      buildCalls += 1;
      assert.equal(cwd, '/tmp/lattice-main', 'success branch must run from the main merge root');
      return { status: 0, stdout: 'build ok\n' };
    },
  });
  assert.equal(buildCalls, 1, 'success branch must invoke the build runner exactly once');
  assert.match(successLine, /packages\/main build refreshed after DONE merge/, 'success branch must return a visible success line');
  assert.match(successLine, /npm --prefix packages\/main run build/, 'success line must name the package build command');

  try {
    runDoneMainPackageBuildAfterMerge('/tmp/lattice-main', 'before', 'after', {
      changedPaths: ['package-lock.json'],
      buildRunner: () => ({
        status: 2,
        stdout: 'tsc started\n',
        stderr: 'dist compile failed\n',
      }),
    });
    assert.fail('failure branch must throw when the post-DONE package build exits non-zero');
  } catch (e: any) {
    const message = String(e?.message ?? e);
    assert.match(message, /packages\/main\/dist may be stale/, 'failure message must say dist may be stale');
    assert.match(message, /Recovery: npm --prefix packages\/main run build/, 'failure message must include the recovery command');
    assert.match(message, /tsc started/, 'failure message must include captured stdout');
    assert.match(message, /dist compile failed/, 'failure message must include captured stderr');
  }
}

function markStoryBranchPartialDone(worktreePath: string, storyId: string): void {
  const worktreeStore = new StoryStore(worktreePath);
  const story = worktreeStore.readStory(storyId);
  story.phase = 'DONE';
  story.worktree = undefined;
  story.endedAt = story.endedAt || '2026-05-08T10:30:00.000Z';
  worktreeStore.writeStory(storyId, story);
  git(worktreePath, ['add', worktreeStore.storyDirRel()]);
  git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'partial done state']);
}

function assertDoneRecoverRunsPostMergeBuildForRuntimeChanges(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-recover-build-'));
  try {
    const storyId = 'B-recover-build';
    const { worktreePath } = buildDoneReadyStory(root, storyId, {
      beforeEvidence: (wt) => {
        write(wt, 'packages/main/src/recovered-runtime.ts', 'export const recoveredRuntime = true;\n');
        git(wt, ['add', 'packages/main/src/recovered-runtime.ts']);
        git(wt, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'runtime input change']);
      },
    });
    git(root, ['config', 'user.email', 'smoke@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    write(root, '.gitignore', '.worktrees/\n');
    git(root, ['add', '.gitignore']);
    git(root, ['commit', '-m', 'ignore recovery worktrees']);
    markStoryBranchPartialDone(worktreePath, storyId);

    let buildCalls = 0;
    const output = createDoneRecoverHandlers({
      root,
      store: new StoryStore(root),
      scanRoot: join(root, 'packages/main'),
      doneMainBuildRunner: (cwd) => {
        buildCalls += 1;
        assert.equal(realpathSync(cwd), realpathSync(root), 'done_recover build runner must execute from the main merge root');
        return { status: 0, stdout: 'stubbed recover build ok\n' };
      },
    }).done_recover({ storyId });

    assert.equal(buildCalls, 1, 'done_recover must run the post-merge build when watched runtime inputs changed');
    assert.match(output, /packages\/main build refreshed after DONE merge/, 'done_recover output must include the shared build success line');
    assert.match(output, new RegExp(`partial-DONE recovered: ${storyId}`), 'done_recover must still report recovery success');
    assert.match(output, new RegExp(`story/${storyId} merged into main`), 'done_recover must merge the story branch');
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '', 'done_recover must still delete the recovered story branch');
    assert.equal(existsSync(worktreePath), false, 'done_recover must still remove the recovered worktree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDoneRecoverFailingPostMergeBuildThrowsAfterCleanup(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-recover-build-fail-'));
  try {
    const storyId = 'B-recover-build-fail';
    const { worktreePath } = buildDoneReadyStory(root, storyId, {
      beforeEvidence: (wt) => {
        write(wt, 'packages/main/src/recovered-runtime-fail.ts', 'export const recoveredRuntimeFail = true;\n');
        git(wt, ['add', 'packages/main/src/recovered-runtime-fail.ts']);
        git(wt, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'runtime input change']);
      },
    });
    git(root, ['config', 'user.email', 'smoke@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    write(root, '.gitignore', '.worktrees/\n');
    git(root, ['add', '.gitignore']);
    git(root, ['commit', '-m', 'ignore recovery worktrees']);
    markStoryBranchPartialDone(worktreePath, storyId);

    let buildCalls = 0;
    let message = '';
    try {
      createDoneRecoverHandlers({
        root,
        store: new StoryStore(root),
        scanRoot: join(root, 'packages/main'),
        doneMainBuildRunner: (cwd) => {
          buildCalls += 1;
          assert.equal(realpathSync(cwd), realpathSync(root), 'done_recover build runner must execute from the main merge root');
          assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '', 'done_recover must delete the story branch before running the recovery build');
          assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`), 'done_recover must deregister the story worktree before running the recovery build');
          assert.equal(existsSync(worktreePath), false, 'done_recover must remove the story worktree before running the recovery build');
          return {
            status: 2,
            stdout: 'stubbed recover build started\n',
            stderr: 'stubbed recover build failed\n',
          };
        },
      }).done_recover({ storyId });
      assert.fail('done_recover must throw stale-dist guidance when the recovery post-merge build fails');
    } catch (e: any) {
      message = String(e?.message ?? e);
    }

    assert.equal(buildCalls, 1, 'done_recover must run the failing post-merge build exactly once');
    assert.match(message, /packages\/main\/dist may be stale/, 'failure message must say dist may be stale');
    assert.match(message, /Recovery: npm --prefix packages\/main run build/, 'failure message must include stale-dist recovery guidance');
    assert.match(message, /stubbed recover build started/, 'failure message must include captured stdout');
    assert.match(message, /stubbed recover build failed/, 'failure message must include captured stderr');
    assert.match(git(root, ['log', '--oneline', 'main']), new RegExp(`merge: ${storyId}`), 'recovery merge must have landed before the failing build');
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '', 'failing recovery build must leave the story branch deleted');
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`), 'failing recovery build must leave the story worktree deregistered');
    assert.equal(existsSync(worktreePath), false, 'failing recovery build must leave the story worktree removed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDoneRecoverSkipsPostMergeBuildForUnwatchedChanges(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-recover-build-skip-'));
  try {
    const storyId = 'B-recover-build-skip';
    const { worktreePath } = buildDoneReadyStory(root, storyId, {
      beforeEvidence: (wt) => {
        write(wt, 'docs/requirements/decisions/recover-skip.md', '# Recover skip smoke\n');
        git(wt, ['add', 'docs/requirements/decisions/recover-skip.md']);
        git(wt, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'docs only change']);
      },
    });
    git(root, ['config', 'user.email', 'smoke@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    write(root, '.gitignore', '.worktrees/\n');
    git(root, ['add', '.gitignore']);
    git(root, ['commit', '-m', 'ignore recovery worktrees']);
    markStoryBranchPartialDone(worktreePath, storyId);

    let buildCalls = 0;
    const output = createDoneRecoverHandlers({
      root,
      store: new StoryStore(root),
      scanRoot: join(root, 'packages/main'),
      doneMainBuildRunner: () => {
        buildCalls += 1;
        return { status: 0, stdout: 'should not run\n' };
      },
    }).done_recover({ storyId });

    assert.equal(buildCalls, 0, 'done_recover must skip the build when only unwatched paths changed');
    assert.match(output, /packages\/main build skipped after DONE merge/, 'done_recover output must include the shared build skip line');
    assert.match(output, new RegExp(`partial-DONE recovered: ${storyId}`), 'done_recover must still report recovery success');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * CHK-003 task 2 — success path is byte-identical after extraction.
 * Drives a clean DONE through runDonePreMergeGate → writeStory(phase=DONE) →
 * applyDoneMergeEffects and asserts the rendered DONE Gate Checklist, the
 * advance line, and the merge-report lines in their exact Step1→Step3→Step4→
 * Step5 order. Also a structural assertion that story-advance.ts no longer
 * carries an inline DONE merge implementation (CHK-003 task 2 ④).
 */
function assertDoneSuccessPathOutputAndOrdering(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-success-path-'));
  try {
    const storyId = 'B-done-success';
    const { worktreePath } = buildDoneReadyStory(root, storyId);

    const output = runLatticeFromCwd(worktreePath, 'story_advance', { storyId, phase: 'DONE' });

    // DONE Gate Checklist section — the pre-merge gate's rendered checklist is
    // prefixed onto the success message (via doneChecklistPrefix).
    assert.match(output, new RegExp(`DONE Gate Checklist \\(${storyId}\\):`), 'DONE success output must include the rendered DONE Gate Checklist header');
    assert.match(output, /\[✓\] Test evidence: PASS/, 'checklist must include the test-evidence row');
  assert.match(
    output,
    /\[✓\] git working tree: (?:clean|pass: blocking=0)/,
    'checklist must include the passing git-working-tree row',
  );
    assert.match(output, /\[✓\] delivery-check: 0 docsPromises checked/, 'checklist must include the delivery-check row');

    // advance line + merge-report lines, byte-identical. The worktree-cleanup
    // line embeds the canonical (symlink-resolved) absolute worktree path, so
    // it is matched structurally — current output is localized, but older
    // transcripts used English, so keep the smoke tolerant of either wording.
    const mergeLine = new RegExp(`✓ (?:Branch|分支) story/${storyId} (?:merged into|已合并到) main`);
    const cleanupLine = new RegExp(`✓ Worktree [^\\n]*${storyId} (?:cleaned up|已(?:强制)?清理)`);
    const deleteLine = new RegExp(`✓ (?:Branch|分支) story/${storyId} (?:deleted|已删除)`);
    assert.ok(output.includes(`Story ${storyId} advanced to DONE`), 'DONE success output must include the advance line');
    assert.match(output, mergeLine, 'DONE success output must include the merge confirmation');
    assert.match(output, cleanupLine, 'DONE success output must include the worktree-cleanup confirmation naming the canonical worktree path');
    assert.match(output, deleteLine, 'DONE success output must include the branch-delete confirmation');
    assert.match(
      output,
      /packages\/main build skipped after DONE merge \(no watched runtime or capability contract inputs changed\)/,
      'DONE metadata-only success output must include the post-merge build skip line',
    );

    // Step ordering: metadata commit → merge → worktree remove → branch delete.
    const mergeIdx = output.search(mergeLine);
    const cleanIdx = output.search(cleanupLine);
    const deleteIdx = output.search(deleteLine);
    assert.ok(mergeIdx >= 0 && cleanIdx > mergeIdx && deleteIdx > cleanIdx, 'merge → worktree remove → branch delete must appear in that order');

    // Step1 (metadata commit) — the DONE commit landed on the merged branch.
    const mergedLog = git(root, ['log', '--oneline', 'main']);
    assert.match(mergedLog, new RegExp(`lattice: mark ${storyId} DONE \\+ clear worktree`), 'Step2 metadata commit must be merged into main');
    assert.match(mergedLog, new RegExp(`merge: ${storyId}`), 'Step3 --no-ff merge commit must be present on main');

    // Terminal state: story DONE, worktree + branch gone.
    const doneStory = new StoryStore(root).readStory(storyId);
    assert.equal(doneStory.phase, 'DONE', 'story must be DONE on the success path');
    assert.equal(doneStory.worktree, undefined, 'Step1 must clear story.worktree after DONE merge');
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '', 'Step5 must delete the story branch');
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`), 'Step4 must deregister the worktree');
    assert.equal(existsSync(worktreePath), false, 'Step4 must remove the canonical worktree directory');

    // B-da5b regression — post-DONE activity heartbeat must NOT recreate the
    // removed worktree dir, and the final successful story_advance DONE record
    // must land in the MAIN repo .lattice/activity.jsonl (not a ghost worktree log).
    // 1) The removed worktree path stays absent — no .lattice (re)created under it.
    //    The worktree-dir absence itself is already asserted by the Step4 check
    //    above; the dedicated assertPostDoneHeartbeatLandsInMainAfterWorktreeRemoval
    //    test is the discriminating B-da5b regression guard. Here we only add the
    //    finer-grained sub-path checks so a ghost recreation surfaces with B-da5b
    //    diagnostics rather than being masked by the older Step4 message.
    assert.equal(existsSync(join(worktreePath, '.lattice')), false, 'post-DONE activity logging must not recreate a .lattice dir inside the removed worktree');
    assert.equal(existsSync(join(worktreePath, '.lattice', 'activity.jsonl')), false, 'post-DONE activity logging must not write activity.jsonl into the removed worktree');
    // 2) The main repo activity log holds the final successful story_advance DONE.
    const mainActivityLog = join(root, '.lattice', 'activity.jsonl');
    assert.equal(existsSync(mainActivityLog), true, 'main repo .lattice/activity.jsonl must exist after DONE');
    const activityRecords = readFileSync(mainActivityLog, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const doneRecord = activityRecords.find(
      (r) => r.tool === 'story_advance' && r.storyId === storyId && r.status === 'ok',
    );
    assert.ok(
      doneRecord,
      'main repo activity.jsonl must contain the final successful story_advance DONE record for this story',
    );

    // CHK-003 ④ — structural assertion: story-advance.ts is a thin shell with
    // no inline DONE merge implementation. B-6974 (Story 3c): story-advance.ts
    // no longer references done-effects directly — it delegates one whole
    // transition to transition-orchestrator.runStoryTransition, which owns the
    // DONE pre/post-merge call sites (runDonePreMergeGate / applyDoneMergeEffects).
    // The structural assertion follows the indirection: story-advance.ts must
    // delegate to the orchestrator, and the orchestrator must own the DONE
    // merge call sites. Neither file may carry an inline git merge / git
    // worktree remove implementation (that lives only in done-effects.ts).
    const handlersDir = resolve(packageRoot, '..', 'src', 'handlers');
    const storyAdvanceSrc = readFileSync(join(handlersDir, 'story-advance.ts'), 'utf-8');
    const orchestratorSrc = readFileSync(join(handlersDir, 'transition-orchestrator.ts'), 'utf-8');
    assert.ok(
      storyAdvanceSrc.includes('runStoryTransition') && storyAdvanceSrc.includes('renderTransitionResult'),
      'story-advance.ts must delegate to transition-orchestrator.ts (runStoryTransition / renderTransitionResult)',
    );
    assert.ok(
      orchestratorSrc.includes('applyDoneMergeEffects') && orchestratorSrc.includes('runDonePreMergeGate'),
      'transition-orchestrator.ts must own the DONE pre/post-merge call sites (runDonePreMergeGate / applyDoneMergeEffects)',
    );
    const inlineMergeImpl = /'merge',\s*branch|"merge",\s*branch|\[\s*'worktree',\s*'remove'/;
    assert.doesNotMatch(
      storyAdvanceSrc,
      inlineMergeImpl,
      'story-advance.ts must not carry an inline git merge / git worktree remove implementation',
    );
    assert.doesNotMatch(
      orchestratorSrc,
      inlineMergeImpl,
      'transition-orchestrator.ts must not carry an inline git merge / git worktree remove implementation',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * B-da5b CHK-001 — post-DONE activity heartbeat must land in the MAIN repo
 * .lattice/activity.jsonl and must NOT recreate the removed story worktree dir.
 *
 * Failure mode this discriminates: when LATTICE_PROJECT_ROOT points at the story
 * worktree (the realistic agent setup — they cd into the worktree and the env
 * var pins the root there), story_advance --phase=DONE removes that worktree
 * mid-command. The post-command writeLog then sees root/lattice.config.json gone
 * and, in the old code, fell back to resolveRoot() — which returns the now-ghost
 * worktree path again (LATTICE_PROJECT_ROOT wins), so the final successful DONE
 * record was silently dropped (heartbeat lost) instead of landing in main.
 *
 * The fix captures a durable main-root fallback at command start (while
 * root/.git still exists). This test pins LATTICE_PROJECT_ROOT to the worktree so
 * the old fallback would drop the record; the assertions require the DONE
 * heartbeat to be present in main and the worktree dir to stay absent.
 */
function assertPostDoneHeartbeatLandsInMainAfterWorktreeRemoval(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-post-done-heartbeat-'));
  try {
    const storyId = 'B-heartbeat';
    const { worktreePath } = buildDoneReadyStory(root, storyId);

    // Run DONE with cwd AND LATTICE_PROJECT_ROOT pinned to the worktree — this is
    // the env that made the old resolveRoot() fallback return the ghost path.
    const output = execFileSync(
      process.execPath,
      [cliPath, 'story_advance', JSON.stringify({ storyId, phase: 'DONE' })],
      {
        cwd: worktreePath,
        env: { ...process.env, LATTICE_PROJECT_ROOT: worktreePath },
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    assert.ok(output.includes(`Story ${storyId} advanced to DONE`), 'DONE must succeed with LATTICE_PROJECT_ROOT on the worktree');

    // The removed worktree must stay absent — activity logging must not recreate
    // it (no resurrected dir / .lattice / activity.jsonl under the ghost path).
    assert.equal(existsSync(worktreePath), false, 'post-DONE heartbeat must not recreate the removed worktree directory');
    assert.equal(existsSync(join(worktreePath, '.lattice')), false, 'post-DONE heartbeat must not recreate a .lattice dir under the removed worktree');
    assert.equal(existsSync(join(worktreePath, '.lattice', 'activity.jsonl')), false, 'post-DONE heartbeat must not write activity.jsonl into the removed worktree');

    // The final successful story_advance DONE record must land in main's log.
    const mainActivityLog = join(root, '.lattice', 'activity.jsonl');
    assert.equal(existsSync(mainActivityLog), true, 'main repo .lattice/activity.jsonl must exist after DONE');
    const doneRecord = readFileSync(mainActivityLog, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.tool === 'story_advance' && r.storyId === storyId && r.status === 'ok');
    assert.ok(doneRecord, 'main repo activity.jsonl must contain the final successful story_advance DONE record');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * CHK-002 case ① — done-oracle pre-merge gate failure keeps the story TEST.
 * Omits the delivery-check evidence so runDoneOracleGate throws before
 * phase=DONE is persisted.
 */
function assertDoneOracleGateFailureKeepsStoryTest(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-oracle-fail-'));
  try {
    const storyId = 'B-oracle-fail';
    // withGateEvidence:false — no test-evidence / no delivery-check committed,
    // so the done-oracle gate fails.
    const { worktreePath } = buildDoneReadyStory(root, storyId, { withGateEvidence: false });

    const output = runLatticeFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(output, /Cannot enter DONE/, 'done-oracle gate failure must report Cannot enter DONE');

    // phase=DONE never written — story stays TEST in BOTH stores.
    assert.equal(new StoryStore(worktreePath).readStory(storyId).phase, 'TEST', 'done-oracle gate failure must not mark the worktree story DONE');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'TEST', 'done-oracle gate failure must not mark the main story DONE');
    // merge / cleanup never ran.
    assert.notEqual(git(root, ['branch', '--list', `story/${storyId}`]), '', 'story branch must survive a pre-merge gate failure');
    assert.match(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`), 'worktree must stay registered after a pre-merge gate failure');
    assert.equal(existsSync(worktreePath), true, 'worktree directory must survive a pre-merge gate failure');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * CHK-002 case ① — stray-file offender pre-merge gate failure keeps the story
 * TEST. Writes a non-whitelisted untracked file under the story dir so the
 * F-020 stray-file dry-run in runDonePreMergeGate throws before phase=DONE.
 */
function assertStrayFileOffenderKeepsStoryTest(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-stray-fail-'));
  try {
    const storyId = 'B-stray-fail';
    const { worktreePath } = buildDoneReadyStory(root, storyId);

    // Non-whitelisted untracked file under the MAIN REPO's story dir → the
    // F-020 stray-file dry-run in runDonePreMergeGate scans
    // `git ls-files --others -- <storyDir>` from mainRepoRoot, detects an
    // offender and throws while the story is still TEST.
    const strayPath = join(root, '.lattice', 'story', 'actives', storyId, 'stray-offender.txt');
    mkdirSync(dirname(strayPath), { recursive: true });
    writeFileSync(strayPath, 'non-whitelisted stray file that must block DONE pre-merge\n');

    const output = runLatticeFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(output, /stray-offender\.txt/, 'stray-file gate failure must name the offending file');

    assert.equal(new StoryStore(worktreePath).readStory(storyId).phase, 'TEST', 'stray-file gate failure must not mark the worktree story DONE');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'TEST', 'stray-file gate failure must not mark the main story DONE');
    assert.notEqual(git(root, ['branch', '--list', `story/${storyId}`]), '', 'story branch must survive a stray-file gate failure');
    assert.match(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`), 'worktree must stay registered after a stray-file gate failure');
    assert.equal(existsSync(worktreePath), true, 'worktree directory must survive a stray-file gate failure');
    // The offender file itself is untouched — the dry-run never deletes.
    assert.equal(existsSync(strayPath), true, 'stray-file pre-merge dry-run must not delete the offender');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * CHK-002 case ① — a main/story-branch merge conflict trips the DONE
 * pre-merge gate (block A in runDonePreMergeGate) and keeps the story TEST.
 *
 * main and the story branch edit the same line of conflict.txt. The DONE
 * pre-check's autoSyncMain cannot fast-forward the conflict in, so the branch
 * stays behind main and block A's done-oracle gate throws `Cannot enter DONE`
 * before phase=DONE is persisted. This proves the merge-tree / branch-sync
 * pre-merge gate is fail-closed: a branch that cannot cleanly merge into main
 * never reaches the post-merge effects.
 */
function assertMergeConflictPreMergeGateKeepsStoryTest(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-merge-conflict-'));
  try {
    const storyId = 'B-conflict-fail';
    // Story branch commits its version of conflict.txt BEFORE the gate
    // evidence so the materialHash matches — this isolates the failing gate
    // row to "branch behind main", not evidence-freshness drift.
    const { worktreePath } = buildDoneReadyStory(root, storyId, {
      beforeEvidence: (wt) => {
        writeFileSync(join(wt, 'conflict.txt'), 'story branch version\n');
        git(wt, ['add', 'conflict.txt']);
        git(wt, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'story edits conflict.txt']);
      },
    });

    // main commits a different version of the same line AFTER the worktree was
    // branched → the branch falls behind main and cannot cleanly merge.
    writeFileSync(join(root, 'conflict.txt'), 'main branch version\n');
    git(root, ['add', 'conflict.txt']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'main edits conflict.txt']);

    const output = runLatticeFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(output, /Cannot enter DONE/, 'a merge conflict must trip a DONE pre-merge gate');
    assert.match(output, new RegExp(`story/${storyId} is behind main`), 'the gate must report the branch is behind main');

    // phase=DONE never written — block A threw before actor.send.
    assert.equal(new StoryStore(worktreePath).readStory(storyId).phase, 'TEST', 'a merge-conflict pre-merge gate failure must not mark the worktree story DONE');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'TEST', 'a merge-conflict pre-merge gate failure must not mark the main story DONE');
    assert.notEqual(git(root, ['branch', '--list', `story/${storyId}`]), '', 'story branch must survive a merge-conflict pre-merge gate failure');
    assert.match(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`), 'worktree must stay registered after a merge-conflict pre-merge gate failure');
    assert.equal(existsSync(worktreePath), true, 'worktree directory must survive a merge-conflict pre-merge gate failure');
    // The branch never received the conflicting main commit (no silent auto-merge).
    assert.equal(
      gitSucceeds(root, ['merge-base', '--is-ancestor', 'main', `story/${storyId}`]),
      false,
      'a conflicting main commit must not be force-synced into the story branch',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * CHK-002 case ② — a real `git merge` failure (post phase=DONE) leaves the
 * story DONE but throws with the manual cd / git merge / git worktree remove /
 * git branch -d recovery steps.
 *
 * The setup keeps every pre-merge gate green so block A passes and phase=DONE
 * is persisted: the story branch only ADDS a new file (shared.txt), so it
 * still contains all of main (branch-sync passes) and merge-tree dry-runs
 * cleanly. The real merge then fails because the main repo has an UNTRACKED
 * shared.txt that the merge would overwrite — `git merge` aborts. main's
 * untracked file is invisible to the worktree's git-working-tree gate, so the
 * failure surfaces only inside applyDoneMergeEffects' real merge step.
 */
function assertRealMergeFailureMarksDoneAndThrows(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-merge-fail-'));
  try {
    const storyId = 'B-merge-fail';
    // Story branch ADDS shared.txt — committed BEFORE the gate evidence so the
    // recorded materialHash matches the final tree. main has no competing
    // commit, so the branch still contains all of main and every pre-merge
    // gate stays green.
    const { worktreePath } = buildDoneReadyStory(root, storyId, {
      beforeEvidence: (wt) => {
        writeFileSync(join(wt, 'shared.txt'), 'story branch content\n');
        git(wt, ['add', 'shared.txt']);
        git(wt, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'story adds shared.txt']);
      },
    });

    // main repo carries an UNTRACKED shared.txt. merge-tree (trees only) merges
    // cleanly, but the real `git merge` from the main repo refuses: the
    // untracked file would be overwritten.
    writeFileSync(join(root, 'shared.txt'), 'untracked main file that blocks merge\n');

    const output = runLatticeFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(
      output,
      new RegExp(`Story ${storyId} (?:has been marked DONE but auto-merge failed|已标记为 DONE 但自动合并失败)`),
      'real merge failure must announce the story is already DONE',
    );
    // Manual-recovery guidance — must not swallow the failure.
    assert.match(output, /cd "/, 'merge failure guidance must include a cd step');
    assert.match(output, /git merge story\//, 'merge failure guidance must include git merge');
    assert.match(output, /git worktree remove --force/, 'merge failure guidance must include git worktree remove');
    assert.match(output, /git branch -d story\//, 'merge failure guidance must include git branch -d');

    // phase=DONE WAS persisted before the merge ran (block B runs after writeStory).
    assert.equal(new StoryStore(worktreePath).readStory(storyId).phase, 'DONE', 'real merge failure must leave the story marked DONE');
    // Merge did not land on main.
    assert.doesNotMatch(git(root, ['log', '--oneline', 'main']), new RegExp(`merge: ${storyId}`), 'failed merge must not produce a merge commit on main');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * CHK-002 case ③ — a worktree cleanup failure (post-merge) leaves the story
 * DONE and merged but throws the "merged, but worktree cleanup did not complete" error with the
 * lattice doctor recovery hint. The cleanup is forced to fail by making the
 * .worktrees/ parent directory read-only so neither `git worktree remove` nor
 * the residual `rm -rf` can rmdir the worktree.
 *
 * Skipped when running as root (uid 0 ignores POSIX permission bits, so the
 * directory would still be removable and the failure path could not be
 * exercised). On a normal uid the path is deterministic.
 */
function assertWorktreeCleanupFailureMarksDoneMergedAndThrows(): void {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('  (skipped assertWorktreeCleanupFailureMarksDoneMergedAndThrows — running as root, permission bits are ignored)');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-cleanup-fail-'));
  const worktreesDir = join(root, '.worktrees');
  try {
    const storyId = 'B-cleanup-fail';
    const { worktreePath } = buildDoneReadyStory(root, storyId);

    // Make the .worktrees/ parent read-only: `git worktree remove` and the
    // residual rmSync can clear the worktree contents but cannot rmdir the
    // worktree directory itself → cleanupFailure is set → applyDoneMergeEffects
    // throws after the merge succeeded.
    chmodSync(worktreesDir, 0o500);

    const output = runLatticeFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(
      output,
      new RegExp(`Story ${storyId} (?:merged, but worktree cleanup did not complete|已合并，但 worktree 清理未完成)`),
      'cleanup failure must announce the story merged but cleanup is incomplete',
    );
    assert.match(output, /lattice doctor/, 'cleanup failure must point at lattice doctor for recovery');

    // phase=DONE persisted and the merge DID land on main (cleanup failed AFTER merge).
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'DONE', 'cleanup failure must leave the story marked DONE');
    assert.match(git(root, ['log', '--oneline', 'main']), new RegExp(`merge: ${storyId}`), 'cleanup failure must occur AFTER a successful merge into main');
  } finally {
    // Restore permissions so the temp-dir teardown can recurse into .worktrees/.
    try { chmodSync(worktreesDir, 0o700); } catch { /* dir may already be gone */ }
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * B-4c38 CHK-001 — a live DONE main-merge lock blocks before any phase=DONE
 * mutation. This is the regression for the B-9027 partial-DONE incident:
 * contention must be surfaced to the operator while the story is still TEST.
 */
function assertDoneMainMergeLiveLockFailsBeforeMutation(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-main-lock-live-'));
  try {
    const storyId = 'B-lock-live';
    const { worktreePath } = buildDoneReadyStory(root, storyId);
    const lockDir = join(root, '.lattice', 'locks', 'main-write.lock');
    mkdirSync(lockDir, { recursive: true });

    const output = runLatticeFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(output, /DONE main merge lock is held/, 'live DONE lock must produce an operator-visible lock message');
    assert.equal(new StoryStore(worktreePath).readStory(storyId).phase, 'TEST', 'live DONE lock must leave worktree story TEST');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'TEST', 'live DONE lock must leave main story TEST');
    assert.notEqual(git(root, ['branch', '--list', `story/${storyId}`]), '', 'live DONE lock must not delete the story branch');
    assert.match(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`), 'live DONE lock must not clean the worktree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDoneMainMergeLockBlocksBeforeAutoSyncMain(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-main-lock-before-sync-'));
  try {
    const storyId = 'B-lock-before-sync';
    const { worktreePath } = buildDoneReadyStory(root, storyId);
    writeFileSync(join(root, 'main-only-after-story-branch.txt'), 'main commit that lock must not auto-sync\n');
    git(root, ['add', 'main-only-after-story-branch.txt']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Proofbound Smoke', 'commit', '-m', 'main moves after story branch']);
    const mainHeadAfterBranch = git(root, ['rev-parse', 'main']);
    const lockDir = join(root, '.lattice', 'locks', 'main-write.lock');
    mkdirSync(lockDir, { recursive: true });

    const output = runLatticeFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(output, /DONE main merge lock is held/, 'live DONE lock must fail before autoSyncMain');
    assert.equal(new StoryStore(worktreePath).readStory(storyId).phase, 'TEST', 'lock-before-sync failure must leave story TEST');
    assert.equal(
      gitSucceeds(root, ['merge-base', '--is-ancestor', mainHeadAfterBranch, `story/${storyId}`]),
      false,
      'DONE lock must be acquired before autoSyncMain can merge main into the story branch',
    );
    assert.equal(
      existsSync(join(worktreePath, 'main-only-after-story-branch.txt')),
      false,
      'DONE lock must fail before autoSyncMain can materialize main-only files in the worktree',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * B-4c38 CHK-001 — stale DONE locks are reclaimed rather than deadlocking all
 * future DONE transitions. The stale timestamp is older than the production
 * stale threshold, so story_advance should reclaim it and complete normally.
 */
function assertDoneMainMergeStaleLockIsReclaimed(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-main-lock-stale-'));
  try {
    const storyId = 'B-lock-stale';
    const { worktreePath } = buildDoneReadyStory(root, storyId);
    const lockDir = join(root, '.lattice', 'locks', 'main-write.lock');
    mkdirSync(lockDir, { recursive: true });
    const old = new Date(Date.now() - 5 * 60 * 1000);
    utimesSync(lockDir, old, old);

    const output = runLatticeFromCwd(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(output, new RegExp(`Story ${storyId} advanced to DONE`), 'stale DONE lock should be reclaimed and allow DONE');
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'DONE', 'stale lock recovery should still complete DONE');
    assert.equal(existsSync(lockDir), false, 'DONE lock directory should be released after successful DONE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * B-f60c CHK-002 — F-008 regression: `story_advance INIT_CHECK` must not leave
 * an uncommitted story-metadata mirror in the main checkout that later
 * self-blocks the DONE `git merge story/<id>` (partial-DONE).
 *
 * F-008 (verified, B-6974 / B-ad12 real-machine repros): `dev_start` writes
 * `story.worktree` into the MAIN repo's `.lattice/story/actives/<id>/index.json`
 * but commits the story dir onto the `story/<id>` branch via a temporary git
 * index — the main working tree is left with an UNTRACKED story-metadata
 * mirror (story_create only wrote files, never committed them). At DONE,
 * `applyDoneMergeEffects` runs `git merge story/<id>` from the main repo root;
 * the story branch has that path committed, the main working tree has it
 * untracked → git aborts ("untracked working tree files would be overwritten
 * by merge") → partial-DONE.
 *
 * This test drives the real `story_advance INIT_CHECK` CLI path end-to-end and
 * then performs the exact DONE Step-3 operation (`git merge story/<id>` from
 * the main repo root). Post-fix the INIT_CHECK path commits the metadata
 * mirror on the base branch and merges the base branch into the story branch,
 * so the DONE merge has nothing uncommitted to collide with and completes.
 */
function assertInitCheckLeavesNoUncommittedMainMirrorForDone(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-init-check-f008-'));
  try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'smoke@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
      storyPrefix: 'B',
    }, null, 2));
    write(root, 'README.md', 'F-008 init-check mirror smoke\n');
    write(root, '.gitignore', '.worktrees/\n.lattice/activity.jsonl\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    resetConfigCache();

    const created = runLattice(root, 'story_create', {
      name: 'init-check-f008',
      title: 'Init check F-008 regression',
      description: 'Verify INIT_CHECK commits its main-side story metadata mirror so DONE does not self-block.',
      type: 'chore',
      priority: 'medium',
      background: [
        '## Trigger Event',
        '2026-05-18 B-f60c F-008 smoke reproduces the partial-DONE incident where INIT_CHECK left an uncommitted story metadata mirror in the main checkout.',
        '## Key Insights',
        'The DONE merge runs from the main repo root and aborts when the story dir is untracked there while committed on the story branch.',
        '## Solution Tradeoffs',
        'The smoke drives the real INIT_CHECK CLI path and replays the DONE Step-3 merge instead of importing private helpers, because the bug lived in CLI orchestration.',
        '## Conversation Texture',
        'A maintainer expects story_advance DONE to merge the branch cleanly rather than mark the story DONE while leaving the branch unmerged.',
      ].join('\n\n'),
      checklist: [{ title: 'Verify INIT_CHECK metadata mirror is committed', context: 'INIT_CHECK must not leave an uncommitted main-side mirror.' }],
    });
    const storyId = created.match(/B-[a-f0-9]+/)?.[0];
    assert.ok(storyId, `story_create should return story id, got: ${created}`);

    recordPassingInitAndScopeGates(root, storyId);

    const advanced = runLattice(root, 'story_advance', { storyId, phase: 'INIT_CHECK' });
    assert.match(advanced, /advanced to INIT_CHECK/, 'INIT_CHECK advance should succeed');
    assert.match(advanced, /INIT_CHECK metadata committed/, 'INIT_CHECK output should report the metadata mirror was committed');

    const storyRel = `.lattice/story/actives/${storyId}`;
    // The F-008 stale mirror is gone: the main working tree has no uncommitted
    // (untracked or modified) story metadata.
    assert.equal(
      git(root, ['status', '--porcelain', '--', storyRel]),
      '',
      'INIT_CHECK must leave no uncommitted story-metadata mirror in the main checkout',
    );
    // The story metadata is tracked on the base branch.
    assert.equal(
      git(root, ['ls-files', '--', `${storyRel}/index.json`]),
      `${storyRel}/index.json`,
      'INIT_CHECK must commit the story index.json onto the base branch',
    );
    // The story branch contains the base branch (so a later DONE merge-base
    // ancestor check passes).
    assert.equal(
      gitSucceeds(root, ['merge-base', '--is-ancestor', 'main', `story/${storyId}`]),
      true,
      'INIT_CHECK must merge the base branch into the story branch',
    );

    // Core F-008 assertion: replay the exact DONE Step-3 operation —
    // `git merge story/<id>` from the main repo root. Pre-fix this aborted on
    // the untracked story-metadata mirror; post-fix it completes cleanly.
    const mergeOk = gitSucceeds(root, [
      '-c', 'commit.gpgsign=false',
      'merge', `story/${storyId}`, '--no-ff', '-m', `merge: ${storyId} init-check f008 regression`,
    ]);
    assert.equal(mergeOk, true, 'DONE-equivalent merge of the story branch must not self-block on a stale main mirror');
    assert.equal(
      gitSucceeds(root, ['merge-base', '--is-ancestor', `story/${storyId}`, 'main']),
      true,
      'the story branch must be contained in main without a partial-DONE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertInitCheckRejectsPreStagedOutOfBoundsBeforeStagingMetadata(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-init-check-staged-main-'));
  const storyId = 'B-init-staged';
  const storyRel = `.lattice/story/actives/${storyId}`;
  const worktreePath = join(root, '.worktrees', storyId);
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
      storyPrefix: 'B',
    }, null, 2));
    write(root, 'README.md', 'INIT_CHECK staged-main preflight smoke\n');
    write(root, '.gitignore', '.worktrees/\n.lattice/activity.jsonl\n');
    write(root, 'unrelated-staged.txt', 'tracked baseline\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['config', 'user.email', 'smoke@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    resetConfigCache();

    const store = new StoryStore(root);
    writeStory(store, storyId, 'INIT', {
      path: `.worktrees/${storyId}`,
      branch: `story/${storyId}`,
      createdAt: '2026-05-08T10:00:00.000Z',
    });
    git(root, ['add', '-f', '--', storyRel]);
    git(root, ['commit', '-m', 'story metadata init']);
    git(root, ['worktree', 'add', '-b', `story/${storyId}`, worktreePath, 'HEAD']);

    writeStory(store, storyId, 'INIT_CHECK', {
      path: `.worktrees/${storyId}`,
      branch: `story/${storyId}`,
      createdAt: '2026-05-08T10:00:00.000Z',
    });
    write(root, 'unrelated-staged.txt', 'staged user edit that must remain staged\n');
    git(root, ['add', '--', 'unrelated-staged.txt']);
    assert.equal(
      git(root, ['diff', '--cached', '--name-status', '--', 'unrelated-staged.txt']),
      'M\tunrelated-staged.txt',
      'precondition: unrelated user path is staged before INIT_CHECK reconcile',
    );
    assert.equal(
      git(root, ['diff', '--cached', '--name-only', '--', storyRel]),
      '',
      'precondition: story metadata is dirty but not staged yet',
    );
    const headBefore = git(root, ['rev-parse', 'HEAD']);

    assert.throws(
      () => commitInitCheckMetadataAndMergeMain(root, store, storyId),
      /INIT_CHECK metadata commit refused out-of-bounds staged paths:\nunrelated-staged\.txt/,
    );

    assert.equal(
      git(root, ['rev-parse', 'HEAD']),
      headBefore,
      'refused INIT_CHECK reconcile must not create a metadata commit',
    );
    assert.equal(
      git(root, ['show', 'HEAD:unrelated-staged.txt']),
      'tracked baseline',
      'unrelated staged content must not be swept into HEAD by the metadata helper',
    );
    assert.equal(
      git(root, ['diff', '--cached', '--name-status', '--', 'unrelated-staged.txt']),
      'M\tunrelated-staged.txt',
      'unrelated staged path should remain staged for the user',
    );
    assert.equal(
      git(root, ['diff', '--cached', '--name-only', '--', storyRel]),
      '',
      'INIT_CHECK refusal must happen before staging story metadata',
    );
    assert.match(
      git(root, ['diff', '--name-only', '--', storyRel]),
      new RegExp(`${storyRel}/index\\.json`),
      'story metadata should remain an unstaged working-tree change after refusal',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * B-f60c CHK-005 — multi-session regression: two concurrent `story_advance
 * DONE` OS processes racing the SAME DONE-ready story must serialize through
 * the unified main write lock with NO partial-DONE.
 *
 * This is the multi-session counterpart to CHK-002's
 * `assertInitCheckLeavesNoUncommittedMainMirrorForDone` (single-process F-008
 * repro) and CHK-001's `main-write-lock-smoke` (in-process lock primitive).
 * Neither of those drives two REAL concurrent `story_advance DONE` processes
 * end-to-end; CHK-002's lock-contention cases pre-plant a static lock dir
 * rather than running a genuine DONE↔DONE race. This closes that gap.
 *
 * F-008 root cause (verified, B-6974 / B-ad12): the DONE flow writes a stale
 * main-mirror and then self-blocks its own `git merge`. The unified main write
 * lock + in-lock idempotency must guarantee that, however the two processes
 * interleave, exactly ONE DONE completes (story=DONE, branch merged into main,
 * worktree + branch cleaned) and the other exits non-zero WITHOUT leaving a
 * partial-DONE — i.e. it must never be the case that the story is marked DONE
 * while `story/<id>` is still unmerged, nor that main is mutated twice.
 */
async function assertConcurrentDoneSerializesWithoutPartialDone(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-concurrent-done-'));
  try {
    const storyId = 'B-concurrent-done';
    const { worktreePath } = buildDoneReadyStory(root, storyId);

    // Two REAL `story_advance DONE` child processes race the same story.
    const [a, b] = await Promise.all([
      spawnStoryAdvance(worktreePath, { storyId, phase: 'DONE' }),
      spawnStoryAdvance(worktreePath, { storyId, phase: 'DONE' }),
    ]);
    const results = [a, b];

    // Exactly one DONE wins; the other fails (lock-contention fail-fast, or it
    // loses the lock race after the winner already finished and finds the
    // story no longer TEST / the worktree gone). Either way: not two winners.
    const winners = results.filter(r => r.code === 0
      && new RegExp(`Story ${storyId} advanced to DONE`).test(r.output));
    const losers = results.filter(r => r.code !== 0);
    assert.equal(winners.length, 1,
      `exactly one concurrent story_advance DONE must succeed, got ${winners.length}: ` +
      results.map((r, i) => `proc${i}(exit=${r.code})`).join(' ') + '\n' +
      results.map((r, i) => `--- proc${i} ---\n${r.output}`).join('\n'));
    assert.equal(losers.length, 1,
      `exactly one concurrent story_advance DONE must fail (serialized), got ${losers.length}`);

    // The losing process must surface a benign reason — never a partial-DONE.
    // Acceptable: the live main-write-lock contention message, or a guard
    // refusal because the story is already past TEST / the worktree is gone.
    const loserOut = losers[0].output;
    assert.ok(
      /DONE main merge lock is held/.test(loserOut)
      || /main write lock is held/.test(loserOut)
      || /DONE/.test(loserOut),
      `the losing DONE racer must explain itself (lock contention or already-advanced), got:\n${loserOut}`,
    );

    // Terminal state on main is a clean, complete DONE — NOT partial-DONE.
    const doneStory = new StoryStore(root).readStory(storyId);
    assert.equal(doneStory.phase, 'DONE', 'the winning race must leave the story DONE on main');
    assert.equal(doneStory.worktree, undefined, 'a complete DONE must clear story.worktree');
    // The story branch is merged into main (the F-008 self-block is gone) ...
    assert.match(
      git(root, ['log', '--oneline', 'main']),
      new RegExp(`merge: ${storyId}`),
      'the story branch must be merged into main — a partial-DONE would leave it unmerged',
    );
    // ... and the branch + worktree are cleaned exactly once.
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '',
      'a complete DONE must delete the story branch (no partial-DONE leftover)');
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`),
      'a complete DONE must deregister the worktree');
    assert.equal(existsSync(worktreePath), false, 'a complete DONE must remove the worktree directory');

    // No uncommitted story-metadata mirror was left behind by the racing
    // processes — that uncommitted mirror is the exact F-008 self-block
    // precondition. Scoped to the story dir (not the whole tree) so lattice's own
    // gitignored runtime artifacts — .lattice/activity.jsonl, .lattice/runtime/ —
    // do not masquerade as partial-DONE residue.
    assert.equal(
      git(root, ['status', '--porcelain', '--', `.lattice/story/actives/${storyId}`]),
      '',
      'concurrent DONE must leave no uncommitted story-metadata mirror (the F-008 self-block precondition)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

assertRecordedWorktreeRejectsMainCwd();
assertInitCheckChecklistMutationRejectsMainCwd();
assertTerminalStoriesDoNotRedirect();
assertFromDraftStopsAtInitThenBootstrapsThroughInitCheck();
assertFromDraftStopsAtInitWithDirtyMainPreserved();
assertFromDraftRejectsStagedMainBeforeMutation();
assertDoneFromNestedCwdUsesCanonicalWorktreeRoot();
assertDoneRejectsMismatchedStoryBranchBeforeMutation();
assertDoneRejectsNonStoryLinkedWorktreeBeforeMutation();
assertDoneMainPackageBuildTriggerPredicate();
assertDoneMainPackageBuildHookReportsSkipSuccessFailure();
assertDoneRecoverRunsPostMergeBuildForRuntimeChanges();
assertDoneRecoverFailingPostMergeBuildThrowsAfterCleanup();
assertDoneRecoverSkipsPostMergeBuildForUnwatchedChanges();
// B-9027 CHK-002 / CHK-003 regression coverage for the done-effects.ts extraction.
assertDoneSuccessPathOutputAndOrdering();
// B-da5b CHK-001 — post-DONE activity heartbeat lands in main, never recreates
// the removed worktree (LATTICE_PROJECT_ROOT-on-worktree discriminating case).
assertPostDoneHeartbeatLandsInMainAfterWorktreeRemoval();
assertDoneOracleGateFailureKeepsStoryTest();
assertStrayFileOffenderKeepsStoryTest();
assertMergeConflictPreMergeGateKeepsStoryTest();
assertRealMergeFailureMarksDoneAndThrows();
assertWorktreeCleanupFailureMarksDoneMergedAndThrows();
assertDoneMainMergeLiveLockFailsBeforeMutation();
assertDoneMainMergeLockBlocksBeforeAutoSyncMain();
assertDoneMainMergeStaleLockIsReclaimed();
// B-f60c CHK-002 — F-008 regression: INIT_CHECK must not leave an uncommitted
// main-side story metadata mirror that self-blocks the DONE merge.
assertInitCheckLeavesNoUncommittedMainMirrorForDone();
assertInitCheckRejectsPreStagedOutOfBoundsBeforeStagingMetadata();

// B-f60c CHK-005 — multi-session regression: two concurrent story_advance DONE
// processes serialize through the unified main write lock with no partial-DONE.
(async () => {
  await assertConcurrentDoneSerializesWithoutPartialDone();
  console.log('✓ worktree authority smoke passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
