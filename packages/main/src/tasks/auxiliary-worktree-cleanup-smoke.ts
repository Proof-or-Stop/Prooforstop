#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { acquireMainWriteLock } from '../core/main-write-lock.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';

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
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf-8');
}

function initRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    worktreeDir: '.worktrees',
  }, null, 2));
  write(root, '.gitignore', [
    '.worktrees/',
    '.proof-or-stop/*',
    '!.proof-or-stop/story/',
    '!.proof-or-stop/story/**',
    '',
  ].join('\n'));
  write(root, 'README.md', 'auxiliary worktree cleanup smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  git(root, ['branch', '-M', 'main']);
  resetConfigCache();
  return root;
}

function story(storyId: string): StoryInfo {
  const now = '2026-06-10T12:00:00.000Z';
  return {
    storyId,
    name: `${storyId.toLowerCase()}-auxiliary-worktree-cleanup-smoke`,
    title: `${storyId} auxiliary worktree cleanup smoke`,
    description: 'Synthetic story for auxiliary agent worktree cleanup smoke.',
    type: 'chore',
    phase: 'DONE',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: now,
    events: [{ phase: 'DONE', action: 'advance', timestamp: now }],
  };
}

function commitStories(root: string): void {
  git(root, ['add', '.proof-or-stop/story/actives']);
  git(root, ['commit', '-m', 'add smoke story metadata']);
}

function createAuxiliaryWorktree(root: string, storyId: string, suffix: string): { branch: string; path: string } {
  const branch = `codex/${storyId}-${suffix}`;
  const path = join(root, '.worktrees', `${storyId}-agent-${suffix}`);
  git(root, ['branch', branch]);
  git(root, ['worktree', 'add', path, branch]);
  return { branch, path };
}

function commitAuxiliaryPatch(root: string, auxPath: string, name: string): string {
  write(auxPath, `packages/main/src/${name}.ts`, `export const ${name.replace(/-/g, '_')} = true;\n`);
  git(auxPath, ['add', '.']);
  git(auxPath, ['commit', '-m', `agent ${name}`]);
  return git(auxPath, ['rev-parse', 'HEAD']);
}

async function runProofOrStop(root: string, command: string, args: Record<string, unknown>): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, command, JSON.stringify(args)], {
      cwd: root,
      env: { ...process.env, PROOF_OR_STOP_PROJECT_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function runProofOrStopExpectFail(root: string, command: string, args: Record<string, unknown>): Promise<string> {
  try {
    await runProofOrStop(root, command, args);
  } catch (e: any) {
    return e?.message || String(e);
  }
  assert.fail(`${command} should have failed`);
}

async function assertStoryReconcileCleansPatchEquivalentAuxiliaryWorktree(): Promise<void> {
  const root = initRepo('proof-or-stop-aux-clean-safe-');
  try {
    const storyId = 'B-auxsafe';
    const store = new StoryStore(root);
    store.writeStory(storyId, story(storyId));
    commitStories(root);

    const aux = createAuxiliaryWorktree(root, storyId, 'owner-help');
    const auxCommit = commitAuxiliaryPatch(root, aux.path, 'owner_help');
    git(root, ['cherry-pick', auxCommit]);

    const dryRun = await runProofOrStop(root, 'story_reconcile', {});
    assert.match(dryRun, /Auxiliary story worktree residues:/);
    assert.match(dryRun, /B-auxsafe safe-cleanup codex\/B-auxsafe-owner-help/);
    assert.equal(existsSync(aux.path), true, 'dry-run must not remove the worktree');

    const repaired = await runProofOrStop(root, 'story_reconcile', { dryRun: false });
    assert.match(repaired, /✓ Cleaned B-auxsafe safe-cleanup codex\/B-auxsafe-owner-help/);
    assert.equal(existsSync(aux.path), false, 'repair should remove the auxiliary worktree');
    assert.equal(git(root, ['branch', '--list', aux.branch]), '', 'repair should delete patch-equivalent auxiliary branch');

    const events = new StoryStore(root).readProcessEvents(storyId);
    assert.equal(events.some((event) => event.type === 'auxiliary_worktree_cleanup'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertStoryReconcilePreservesMissingAndDirtyAuxiliaryWorktrees(): Promise<void> {
  const root = initRepo('proof-or-stop-aux-clean-unsafe-');
  try {
    const missingId = 'B-auxmiss';
    const dirtyId = 'B-auxdirty';
    const store = new StoryStore(root);
    store.writeStory(missingId, story(missingId));
    store.writeStory(dirtyId, story(dirtyId));
    commitStories(root);

    const missing = createAuxiliaryWorktree(root, missingId, 'validate-alias');
    commitAuxiliaryPatch(root, missing.path, 'validate_alias');

    const dirty = createAuxiliaryWorktree(root, dirtyId, 'scope-ux');
    const dirtyCommit = commitAuxiliaryPatch(root, dirty.path, 'scope_ux');
    git(root, ['cherry-pick', dirtyCommit]);
    write(dirty.path, 'packages/main/src/uncommitted.ts', 'export const dirty = true;\n');

    const dryRun = await runProofOrStop(root, 'story_reconcile', {});
    assert.match(dryRun, /B-auxmiss missing-from-main codex\/B-auxmiss-validate-alias/);
    assert.match(dryRun, /B-auxdirty dirty-worktree codex\/B-auxdirty-scope-ux/);

    const repaired = await runProofOrStop(root, 'story_reconcile', { dryRun: false });
    assert.match(repaired, /⚠ Skipped B-auxmiss missing-from-main/);
    assert.match(repaired, /⚠ Skipped B-auxdirty dirty-worktree/);
    assert.equal(existsSync(missing.path), true, 'missing-from-main worktree must be preserved');
    assert.notEqual(git(root, ['branch', '--list', missing.branch]), '', 'missing-from-main branch must be preserved');
    assert.equal(existsSync(dirty.path), true, 'dirty worktree must be preserved');
    assert.notEqual(git(root, ['branch', '--list', dirty.branch]), '', 'dirty branch must be preserved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertStoryReconcileCleansDetachedPatchEquivalentWorktree(): Promise<void> {
  const root = initRepo('proof-or-stop-aux-clean-detached-');
  try {
    const storyId = 'B-auxdet';
    const store = new StoryStore(root);
    store.writeStory(storyId, story(storyId));
    commitStories(root);

    const aux = createAuxiliaryWorktree(root, storyId, 'scope-ux');
    const auxCommit = commitAuxiliaryPatch(root, aux.path, 'detached_scope');
    git(root, ['cherry-pick', auxCommit]);
    git(aux.path, ['checkout', '--detach', 'HEAD']);
    git(root, ['branch', '-D', aux.branch]);

    const dryRun = await runProofOrStop(root, 'story_reconcile', {});
    assert.match(dryRun, /B-auxdet safe-cleanup \(no branch\) @/);

    const repaired = await runProofOrStop(root, 'story_reconcile', { dryRun: false });
    assert.match(repaired, /✓ Cleaned B-auxdet safe-cleanup \(no branch\) @/);
    assert.equal(existsSync(aux.path), false, 'detached safe worktree should be removable');
    assert.equal(git(root, ['branch', '--list', aux.branch]), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertStoryReconcileRepairRequiresMainWriteLock(): Promise<void> {
  const root = initRepo('proof-or-stop-aux-clean-lock-');
  const lock = acquireMainWriteLock(root, { label: 'smoke held lock' });
  try {
    const storyId = 'B-auxlock';
    const store = new StoryStore(root);
    store.writeStory(storyId, story(storyId));
    commitStories(root);

    const aux = createAuxiliaryWorktree(root, storyId, 'owner-help');
    const auxCommit = commitAuxiliaryPatch(root, aux.path, 'locked_owner_help');
    git(root, ['cherry-pick', auxCommit]);

    const failure = await runProofOrStopExpectFail(root, 'story_reconcile', { dryRun: false });
    assert.match(failure, /story_reconcile repair is blocked: the main write lock is held/);
    assert.equal(existsSync(aux.path), true, 'repair must not proceed while main write lock is held');
    assert.notEqual(git(root, ['branch', '--list', aux.branch]), '', 'branch must remain while lock is held');
  } finally {
    lock.release();
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await assertStoryReconcileCleansPatchEquivalentAuxiliaryWorktree();
  await assertStoryReconcilePreservesMissingAndDirtyAuxiliaryWorktrees();
  await assertStoryReconcileCleansDetachedPatchEquivalentWorktree();
  await assertStoryReconcileRepairRequiresMainWriteLock();
  console.log('✓ auxiliary worktree cleanup smoke passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
