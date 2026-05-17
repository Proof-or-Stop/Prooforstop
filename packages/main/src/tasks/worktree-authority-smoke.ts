#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, ClosingSelfCheck, DocsPromise, RealMachineTest, StoryInfo } from '../core/types.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { assertCwdInWorktree } from '../handlers/context.js';

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

function runKoala(root: string, command: string, args: Record<string, unknown>): string {
  return execFileSync(process.execPath, [cliPath, command, JSON.stringify(args)], {
    cwd: root,
    env: { ...process.env, KOALA_PROJECT_ROOT: root },
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runKoalaFromCwd(cwd: string, command: string, args: Record<string, unknown>): string {
  const env = { ...process.env };
  delete env.KOALA_PROJECT_ROOT;
  return execFileSync(process.execPath, [cliPath, command, JSON.stringify(args)], {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runKoalaExpectFail(root: string, command: string, args: Record<string, unknown>): string {
  try {
    runKoala(root, command, args);
  } catch (e: any) {
    return [
      e?.stdout?.toString?.() ?? '',
      e?.stderr?.toString?.() ?? '',
      e?.message ?? '',
    ].join('\n');
  }
  assert.fail(`${command} should have failed`);
}

function runKoalaFromCwdExpectFail(cwd: string, command: string, args: Record<string, unknown>): string {
  try {
    runKoalaFromCwd(cwd, command, args);
  } catch (e: any) {
    return [
      e?.stdout?.toString?.() ?? '',
      e?.stderr?.toString?.() ?? '',
      e?.message ?? '',
    ].join('\n');
  }
  assert.fail(`${command} should have failed`);
}

function validBackground(): string {
  return [
    '## 触发事件',
    '2026-05-08 B-from-draft smoke reproduces the field report where story_create fromDraft reached INIT_CHECK but did not create a worktree, leaving the next command unable to proceed without manual git worktree add.',
    '',
    '## 关键洞察',
    'The draft path already has reviewed story material, so the missing behavior is not planning validation. The CLI must run the same worktree bootstrap that story_advance INIT_CHECK uses after materializing the story.',
    '',
    '## 方案取舍',
    'The smoke keeps the story tiny and validates the user visible path. It prefers exercising the public CLI over importing private helper internals because the bug lived in CLI orchestration.',
    '',
    '## 对话纹理',
    'A user expects a completed from-draft command to print the worktree path and a direct cd instruction. Seeing phase INIT_CHECK without a directory is confusing and blocks the workflow.',
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
  const root = mkdtempSync(join(tmpdir(), 'koala-authority-recorded-'));
  const previousCwd = process.cwd();
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
    }, null, 2));
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    write(root, 'README.md', 'authority smoke\n');
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
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
      /必须在 worktree 里执行 koala 命令/,
    );
    process.chdir(worktreePath);
    assert.doesNotThrow(() => assertCwdInWorktree(store, storyId));
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

function assertInitCheckChecklistMutationRejectsMainCwd(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-authority-init-check-'));
  const previousCwd = process.cwd();
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
    }, null, 2));
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    write(root, 'README.md', 'init check authority smoke\n');
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
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
    const output = runKoalaExpectFail(root, 'checklist_add', {
      storyId,
      title: 'Should not land in main',
      context: 'INIT_CHECK linked stories must still use the story worktree authority.',
    });
    assert.match(output, /必须在 worktree 里执行 koala 命令/);
    assert.equal(new StoryStore(root).readChecklist(storyId).items.length, 1);
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

function assertTerminalStoriesDoNotRedirect(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-authority-terminal-'));
  const previousCwd = process.cwd();
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
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

function assertFromDraftCreatesWorktreeThroughCli(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-from-draft-worktree-'));
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
    }, null, 2));
    write(root, 'README.md', 'from draft smoke\n');
    write(root, '.gitignore', '.worktrees/\n.koala/activity.jsonl\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
    resetConfigCache();

    runKoala(root, 'story_draft', {
      name: 'from-draft-smoke',
      title: 'From draft smoke story',
      description: 'Synthetic from-draft story for worktree bootstrap.',
      type: 'chore',
      priority: 'medium',
      background: validBackground(),
      checklist: [{
        title: 'Create worktree from draft',
        context: 'The fromDraft CLI path must bootstrap the worktree automatically.',
      }],
    });
    runKoala(root, 'draft_check_set', {
      draftName: 'from-draft-smoke',
      issues: [],
      agentId: 'koala-review-story-init',
    });
    const output = runKoala(root, 'story_create', { fromDraft: 'from-draft-smoke' });
    const storyId = output.match(/Story\s+(B-[a-f0-9]+)/)?.[1];
    assert.ok(storyId, `story_create --from-draft should print story id, got: ${output}`);
    const story = new StoryStore(root).readStory(storyId);
    assert.equal(story.phase, 'INIT_CHECK');
    assert.ok(story.worktree?.path, 'fromDraft story should record worktree metadata');
    assert.match(output, /worktree/i, 'fromDraft output should include worktree bootstrap result');
    assert.match(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`));
    assert.equal(git(root, ['status', '--porcelain']), '', 'fromDraft should leave main clean after bootstrap');
    assert.equal(
      gitSucceeds(root, ['merge-base', '--is-ancestor', 'main', `story/${storyId}`]),
      true,
      'fromDraft story branch should contain current main after bootstrap',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertFromDraftCreatesWorktreeWithDirtyMainPreserved(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-from-draft-dirty-main-'));
  const draftName = 'from-draft-dirty-main-smoke';
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
    }, null, 2));
    write(root, 'README.md', 'from draft dirty main smoke\n');
    write(root, '.gitignore', '.worktrees/\n.koala/activity.jsonl\n');
    write(root, 'unrelated-tracked.txt', 'tracked baseline\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
    resetConfigCache();

    runKoala(root, 'story_draft', {
      name: draftName,
      title: 'From draft dirty main smoke story',
      description: 'Synthetic from-draft story for dirty main preservation.',
      type: 'chore',
      priority: 'medium',
      background: validBackground(),
      checklist: [{
        title: 'Create worktree from draft while main has unrelated edits',
        context: 'The fromDraft CLI path must commit bounded metadata without consuming user changes.',
      }],
    });
    runKoala(root, 'draft_check_set', {
      draftName,
      issues: [],
      agentId: 'koala-review-story-init',
    });
    git(root, ['add', '--', `docs/story/drafts/${draftName}`]);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'draft metadata']);

    write(root, 'unrelated-tracked.txt', 'tracked user edit that must remain dirty\n');
    write(root, 'unrelated-untracked.txt', 'untracked user edit that must remain dirty\n');
    const dirtyBefore = git(root, ['status', '--porcelain']);
    assert.equal(git(root, ['diff', '--name-only', '--', 'unrelated-tracked.txt']), 'unrelated-tracked.txt');
    assert.match(dirtyBefore, /\?\? unrelated-untracked\.txt/);

    const output = runKoala(root, 'story_create', { fromDraft: draftName });
    const storyId = output.match(/Story\s+(B-[a-f0-9]+)/)?.[1];
    assert.ok(storyId, `story_create --from-draft should print story id, got: ${output}`);
    const story = new StoryStore(root).readStory(storyId);
    assert.equal(story.phase, 'INIT_CHECK');
    assert.ok(story.worktree?.path, 'fromDraft story should record worktree metadata');
    assert.match(output, /main merged into story\//, 'fromDraft output should confirm main was merged into the story branch');
    assert.equal(
      git(root, ['status', '--porcelain', '--', `.koala/story/actives/${storyId}`, `docs/story/drafts/${draftName}`]),
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
      gitSucceeds(root, ['merge-base', '--is-ancestor', 'main', `story/${storyId}`]),
      true,
      'fromDraft story branch should contain current main after dirty-main bootstrap',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertFromDraftRejectsStagedMainBeforeMutation(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-from-draft-staged-main-'));
  const draftName = 'from-draft-staged-main-smoke';
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
    }, null, 2));
    write(root, 'README.md', 'from draft staged main smoke\n');
    write(root, '.gitignore', '.worktrees/\n.koala/activity.jsonl\n');
    write(root, 'unrelated-staged.txt', 'tracked baseline\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
    resetConfigCache();

    runKoala(root, 'story_draft', {
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
    runKoala(root, 'draft_check_set', {
      draftName,
      issues: [],
      agentId: 'koala-review-story-init',
    });
    git(root, ['add', '--', `docs/story/drafts/${draftName}`]);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'draft metadata']);

    write(root, 'unrelated-staged.txt', 'staged user edit that must remain staged\n');
    git(root, ['add', '--', 'unrelated-staged.txt']);
    assert.equal(git(root, ['diff', '--cached', '--name-status', '--', 'unrelated-staged.txt']), 'M\tunrelated-staged.txt');

    const output = runKoalaExpectFail(root, 'story_create', { fromDraft: draftName });
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
  store.writeTestEvidence(storyId, {
    command: 'worktree authority smoke',
    output: JSON.stringify({ allPass: true, summary: 'nested DONE cleanup smoke passed' }),
    result: 'PASS',
    timestamp: now,
    headHash: currentGitHead(root),
    materialHash: currentMaterialHash(root),
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
    transcript: 'koala story_advance DONE was invoked from PVSC/child and cleaned the canonical worktree root.',
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
    reviewRound: '',
    agentId: 'koala-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, ''),
  });
}

function assertDoneFromNestedCwdUsesCanonicalWorktreeRoot(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-nested-done-cleanup-'));
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
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
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
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
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'story metadata']);
    git(root, ['branch', `story/${storyId}`]);
    git(root, ['worktree', 'add', worktreePath, `story/${storyId}`]);

    resetConfigCache();
    const worktreeStore = new StoryStore(worktreePath);
    writeDoneGateEvidence(worktreeStore, worktreePath, storyId);
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'done gate evidence']);

    const nestedCwd = join(worktreePath, 'PVSC', 'child');
    mkdirSync(nestedCwd, { recursive: true });
    writeFileSync(join(nestedCwd, 'runtime.txt'), 'runtime residue that must not become the cleanup root\n');

    const output = runKoalaFromCwd(nestedCwd, 'story_advance', { storyId, phase: 'DONE' });
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
  const root = mkdtempSync(join(tmpdir(), 'koala-mismatched-done-branch-'));
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
      workflow: { profile: 'light' },
    }, null, 2));
    write(root, 'README.md', 'mismatched done branch smoke\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
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
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'story metadata']);
    git(root, ['branch', wrongBranch]);
    git(root, ['worktree', 'add', worktreePath, wrongBranch]);
    write(root, 'main-only-after-wrong-story-branch.txt', 'main commit that must not auto-merge before wrong-branch rejection\n');
    git(root, ['add', 'main-only-after-wrong-story-branch.txt']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'main moves after wrong story branch checkout']);
    const mainHeadAfterCheckout = git(root, ['rev-parse', 'main']);

    resetConfigCache();
    const worktreeStore = new StoryStore(worktreePath);
    writeDoneGateEvidence(worktreeStore, worktreePath, storyId);
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'done gate evidence on wrong branch']);

    const output = runKoalaFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
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
  const root = mkdtempSync(join(tmpdir(), 'koala-non-story-done-branch-'));
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
      worktreeDir: '.worktrees',
      workflow: { profile: 'light' },
    }, null, 2));
    write(root, 'README.md', 'non-story done branch smoke\n');
    git(root, ['init']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
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
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'story metadata']);
    git(root, ['branch', wrongBranch]);
    git(root, ['worktree', 'add', worktreePath, wrongBranch]);
    write(root, 'main-only-after-non-story-branch.txt', 'main commit that must not auto-merge before non-story rejection\n');
    git(root, ['add', 'main-only-after-non-story-branch.txt']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'main moves after non-story branch checkout']);
    const mainHeadAfterCheckout = git(root, ['rev-parse', 'main']);

    resetConfigCache();
    const worktreeStore = new StoryStore(worktreePath);
    writeDoneGateEvidence(worktreeStore, worktreePath, storyId);
    git(worktreePath, ['add', '.']);
    git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'done gate evidence on non-story branch']);

    const output = runKoalaFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
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
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
    workflow: { profile: 'light' },
  }, null, 2));
  write(root, 'README.md', `done-effects regression smoke ${storyId}\n`);
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'base']);
  resetConfigCache();

  const worktreePath = join(root, '.worktrees', storyId);
  const store = new StoryStore(root);
  writeStory(store, storyId, 'TEST', {
    path: `.worktrees/${storyId}`,
    branch: `story/${storyId}`,
    createdAt: '2026-05-08T10:00:00.000Z',
  });
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'story metadata']);
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
    git(worktreePath, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'done gate evidence']);
  }
  return { worktreePath, store };
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
  const root = mkdtempSync(join(tmpdir(), 'koala-done-success-path-'));
  try {
    const storyId = 'B-done-success';
    const { worktreePath } = buildDoneReadyStory(root, storyId);

    const output = runKoalaFromCwd(worktreePath, 'story_advance', { storyId, phase: 'DONE' });

    // DONE Gate Checklist段 — the pre-merge gate's rendered checklist is
    // prefixed onto the success message (via doneChecklistPrefix).
    assert.match(output, new RegExp(`DONE Gate Checklist \\(${storyId}\\):`), 'DONE success output must include the rendered DONE Gate Checklist header');
    assert.match(output, /\[✓\] Test evidence: PASS/, 'checklist must include the test-evidence row');
    assert.match(output, /\[✓\] git working tree: clean/, 'checklist must include the clean git-working-tree row');
    assert.match(output, /\[✓\] delivery-check: 0 docsPromises checked/, 'checklist must include the delivery-check row');

    // advance line + merge-report lines, byte-identical. The worktree-cleanup
    // line embeds the canonical (symlink-resolved) absolute worktree path, so
    // it is matched structurally — the line is `✓ Worktree <abs>/<storyId> 已清理`.
    const cleanupLine = new RegExp(`✓ Worktree [^\\n]*${storyId} 已清理`);
    assert.ok(output.includes(`Story ${storyId} advanced to DONE`), 'DONE success output must include the advance line');
    assert.ok(output.includes(`✓ 分支 story/${storyId} 已合并到 main`), 'DONE success output must include the merge confirmation');
    assert.match(output, cleanupLine, 'DONE success output must include the worktree-cleanup confirmation naming the canonical worktree path');
    assert.ok(output.includes(`✓ 分支 story/${storyId} 已删除`), 'DONE success output must include the branch-delete confirmation');

    // Step ordering: metadata commit → merge → worktree remove → branch delete.
    const mergeIdx = output.indexOf(`✓ 分支 story/${storyId} 已合并到 main`);
    const cleanIdx = output.search(cleanupLine);
    const deleteIdx = output.indexOf(`✓ 分支 story/${storyId} 已删除`);
    assert.ok(mergeIdx >= 0 && cleanIdx > mergeIdx && deleteIdx > cleanIdx, 'merge → worktree remove → branch delete must appear in that order');

    // Step1 (metadata commit) — the DONE commit landed on the merged branch.
    const mergedLog = git(root, ['log', '--oneline', 'main']);
    assert.match(mergedLog, new RegExp(`koala: mark ${storyId} DONE \\+ clear worktree`), 'Step2 metadata commit must be merged into main');
    assert.match(mergedLog, new RegExp(`merge: ${storyId}`), 'Step3 --no-ff merge commit must be present on main');

    // Terminal state: story DONE, worktree + branch gone.
    const doneStory = new StoryStore(root).readStory(storyId);
    assert.equal(doneStory.phase, 'DONE', 'story must be DONE on the success path');
    assert.equal(doneStory.worktree, undefined, 'Step1 must clear story.worktree after DONE merge');
    assert.equal(git(root, ['branch', '--list', `story/${storyId}`]), '', 'Step5 must delete the story branch');
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), new RegExp(`story/${storyId}`), 'Step4 must deregister the worktree');
    assert.equal(existsSync(worktreePath), false, 'Step4 must remove the canonical worktree directory');

    // CHK-003 ④ — structural assertion: story-advance.ts is a thin shell with
    // no inline DONE merge implementation. The real `git merge` / `git worktree
    // remove` calls live in done-effects.ts; story-advance.ts only delegates.
    const storyAdvanceSrc = readFileSync(
      resolve(packageRoot, '..', 'src', 'handlers', 'story-advance.ts'),
      'utf-8',
    );
    assert.ok(
      storyAdvanceSrc.includes('applyDoneMergeEffects') && storyAdvanceSrc.includes('runDonePreMergeGate'),
      'story-advance.ts must delegate to done-effects.ts (runDonePreMergeGate / applyDoneMergeEffects)',
    );
    assert.doesNotMatch(
      storyAdvanceSrc,
      /'merge',\s*branch|"merge",\s*branch|\[\s*'worktree',\s*'remove'/,
      'story-advance.ts must not carry an inline git merge / git worktree remove implementation',
    );
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
  const root = mkdtempSync(join(tmpdir(), 'koala-done-oracle-fail-'));
  try {
    const storyId = 'B-oracle-fail';
    // withGateEvidence:false — no test-evidence / no delivery-check committed,
    // so the done-oracle gate fails.
    const { worktreePath } = buildDoneReadyStory(root, storyId, { withGateEvidence: false });

    const output = runKoalaFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
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
  const root = mkdtempSync(join(tmpdir(), 'koala-done-stray-fail-'));
  try {
    const storyId = 'B-stray-fail';
    const { worktreePath } = buildDoneReadyStory(root, storyId);

    // Non-whitelisted untracked file under the MAIN REPO's story dir → the
    // F-020 stray-file dry-run in runDonePreMergeGate scans
    // `git ls-files --others -- <storyDir>` from mainRepoRoot, detects an
    // offender and throws while the story is still TEST.
    const strayPath = join(root, '.koala', 'story', 'actives', storyId, 'stray-offender.txt');
    mkdirSync(dirname(strayPath), { recursive: true });
    writeFileSync(strayPath, 'non-whitelisted stray file that must block DONE pre-merge\n');

    const output = runKoalaFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
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
  const root = mkdtempSync(join(tmpdir(), 'koala-done-merge-conflict-'));
  try {
    const storyId = 'B-conflict-fail';
    // Story branch commits its version of conflict.txt BEFORE the gate
    // evidence so the materialHash matches — this isolates the failing gate
    // row to "branch behind main", not evidence-freshness drift.
    const { worktreePath } = buildDoneReadyStory(root, storyId, {
      beforeEvidence: (wt) => {
        writeFileSync(join(wt, 'conflict.txt'), 'story branch version\n');
        git(wt, ['add', 'conflict.txt']);
        git(wt, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'story edits conflict.txt']);
      },
    });

    // main commits a different version of the same line AFTER the worktree was
    // branched → the branch falls behind main and cannot cleanly merge.
    writeFileSync(join(root, 'conflict.txt'), 'main branch version\n');
    git(root, ['add', 'conflict.txt']);
    git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'main edits conflict.txt']);

    const output = runKoalaFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(output, /Cannot enter DONE/, 'a merge conflict must trip a DONE pre-merge gate');
    assert.match(output, new RegExp(`story/${storyId} 落后 main`), 'the gate must report the branch is behind main');

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
  const root = mkdtempSync(join(tmpdir(), 'koala-done-merge-fail-'));
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
        git(wt, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Koala Smoke', 'commit', '-m', 'story adds shared.txt']);
      },
    });

    // main repo carries an UNTRACKED shared.txt. merge-tree (trees only) merges
    // cleanly, but the real `git merge` from the main repo refuses: the
    // untracked file would be overwritten.
    writeFileSync(join(root, 'shared.txt'), 'untracked main file that blocks merge\n');

    const output = runKoalaFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(output, new RegExp(`Story ${storyId} 已标记为 DONE 但自动合并失败`), 'real merge failure must announce the story is already DONE');
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
 * DONE and merged but throws the "已合并，但 worktree 清理未完成" error with the
 * koala doctor recovery hint. The cleanup is forced to fail by making the
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
  const root = mkdtempSync(join(tmpdir(), 'koala-done-cleanup-fail-'));
  const worktreesDir = join(root, '.worktrees');
  try {
    const storyId = 'B-cleanup-fail';
    const { worktreePath } = buildDoneReadyStory(root, storyId);

    // Make the .worktrees/ parent read-only: `git worktree remove` and the
    // residual rmSync can clear the worktree contents but cannot rmdir the
    // worktree directory itself → cleanupFailure is set → applyDoneMergeEffects
    // throws after the merge succeeded.
    chmodSync(worktreesDir, 0o500);

    const output = runKoalaFromCwdExpectFail(worktreePath, 'story_advance', { storyId, phase: 'DONE' });
    assert.match(output, new RegExp(`Story ${storyId} 已合并，但 worktree 清理未完成`), 'cleanup failure must announce the story merged but cleanup is incomplete');
    assert.match(output, /koala doctor/, 'cleanup failure must point at koala doctor for recovery');

    // phase=DONE persisted and the merge DID land on main (cleanup failed AFTER merge).
    assert.equal(new StoryStore(root).readStory(storyId).phase, 'DONE', 'cleanup failure must leave the story marked DONE');
    assert.match(git(root, ['log', '--oneline', 'main']), new RegExp(`merge: ${storyId}`), 'cleanup failure must occur AFTER a successful merge into main');
  } finally {
    // Restore permissions so the temp-dir teardown can recurse into .worktrees/.
    try { chmodSync(worktreesDir, 0o700); } catch { /* dir may already be gone */ }
    rmSync(root, { recursive: true, force: true });
  }
}

assertRecordedWorktreeRejectsMainCwd();
assertInitCheckChecklistMutationRejectsMainCwd();
assertTerminalStoriesDoNotRedirect();
assertFromDraftCreatesWorktreeThroughCli();
assertFromDraftCreatesWorktreeWithDirtyMainPreserved();
assertFromDraftRejectsStagedMainBeforeMutation();
assertDoneFromNestedCwdUsesCanonicalWorktreeRoot();
assertDoneRejectsMismatchedStoryBranchBeforeMutation();
assertDoneRejectsNonStoryLinkedWorktreeBeforeMutation();
// B-9027 CHK-002 / CHK-003 regression coverage for the done-effects.ts extraction.
assertDoneSuccessPathOutputAndOrdering();
assertDoneOracleGateFailureKeepsStoryTest();
assertStrayFileOffenderKeepsStoryTest();
assertMergeConflictPreMergeGateKeepsStoryTest();
assertRealMergeFailureMarksDoneAndThrows();
assertWorktreeCleanupFailureMarksDoneMergedAndThrows();

console.log('✓ worktree authority smoke passed');
