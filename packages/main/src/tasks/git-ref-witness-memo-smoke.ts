#!/usr/bin/env node
/**
 * Lab gate-command-cost: outside a synchronous observation, observedGit and
 * readObservedGitTree answer a ref-state read once per unchanged repository
 * ref state (core/git-ref-witness-memo.ts). This smoke pins both halves:
 *
 *  cost   - identical ref-state reads with no ref change run git once;
 *  fresh  - every change git can make to a ref-state answer is seen on the
 *           next call: a commit, a branch moved away and back (ABA), a
 *           detached linked worktree, a replace ref, a config edit, a ref
 *           created after a remembered failure;
 *  scope  - working-tree reads (diff without two revisions), launch-time
 *           rereads (withoutGitObservation), object-addressed failures and a
 *           non-inert GIT_* environment always run git.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRefStateGitRead, resetGitRefWitnessMemo } from '../core/git-ref-witness-memo.js';
import { observedGit, readObservedGitTree, withGitTreeObservation, withoutGitObservation } from '../core/git-tree-observation.js';

const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const raw = (cwd: string, args: string[]) => execFileSync(realGit, args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

const root = mkdtempSync(join(tmpdir(), 'git-ref-witness-'));
const repo = join(root, 'repo');
const linked = join(root, 'linked');
const shimDir = join(root, 'shim');
const log = join(shimDir, 'git.log');
try {
  mkdirSync(repo);
  raw(repo, ['init', '-q', '-b', 'main']);
  raw(repo, ['config', 'user.email', 'lab@example.test']);
  raw(repo, ['config', 'user.name', 'lab']);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  raw(repo, ['add', '-A']);
  raw(repo, ['commit', '-qm', 'one']);
  const first = raw(repo, ['rev-parse', 'HEAD']);
  raw(repo, ['worktree', 'add', '-q', '-b', 'story/x', linked]);

  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(join(shimDir, 'git'), 0o755);
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`;
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
  resetGitRefWitnessMemo();
  const spawned = () => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  const read = (cwd: string, argv: string[]) => observedGit(cwd, argv, () => execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  const count = <T>(fn: () => T): { value: T; spawns: number } => { const before = spawned(); const value = fn(); return { value, spawns: spawned() - before }; };
  const failing = (cwd: string, argv: string[]) => { try { read(cwd, argv); return 'ok'; } catch { return 'refused'; } };

  // cost: identical ref-state reads run git once while no ref moves.
  const head = ['rev-parse', 'HEAD'];
  assert.equal(count(() => read(repo, head)).spawns, 1, 'the first read runs git');
  const again = count(() => [read(repo, head), read(repo, head), read(repo, head)]);
  assert.deepEqual(again.value, [first, first, first]);
  assert.equal(again.spawns, 0, `identical ref-state reads with no ref change re-ran git ${again.spawns} times (budget 0)`);
  const baseline = ['merge-base', '--end-of-options', 'refs/heads/main', 'HEAD'];
  assert.equal(count(() => [read(linked, baseline), read(linked, baseline)]).spawns, 1, 'a linked-worktree baseline probe runs once');
  const list = ['worktree', 'list', '--porcelain'];
  assert.equal(count(() => [read(repo, list), read(repo, list)]).spawns, 1, 'worktree list runs once');
  const tree = count(() => [readObservedGitTree(repo, first), readObservedGitTree(repo, first)]);
  assert.equal(tree.spawns, 1, 'an object-addressed tree read runs once outside an observation');

  // fresh: a commit moves HEAD; the next read sees it.
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  raw(repo, ['commit', '-qam', 'two']);
  const second = raw(repo, ['rev-parse', 'HEAD']);
  const moved = count(() => read(repo, head));
  assert.equal(moved.value, second, 'a commit is seen by the next read');
  assert.equal(moved.spawns, 1);
  assert.equal(read(linked, baseline), first, 'the linked baseline is unchanged until its own refs move');

  // fresh: ABA. main moves away and back between two reads; the answer is still current.
  raw(repo, ['update-ref', 'refs/heads/main', first]);
  assert.equal(read(repo, head), first, 'a branch moved back to an earlier commit is seen');
  raw(repo, ['update-ref', 'refs/heads/main', second]);
  assert.equal(read(repo, head), second, 'a branch moved forward again is seen');

  // fresh: a linked worktree that detaches changes worktree list for the main checkout.
  const listedBefore = read(repo, list);
  raw(linked, ['checkout', '-q', '--detach']);
  const listedAfter = read(repo, list);
  assert.notEqual(listedAfter, listedBefore, 'a detached linked worktree is seen by worktree list');
  assert.match(listedAfter, /detached/);

  // fresh: a replace ref redirects an object; the object-addressed tree read follows it.
  const treeBefore = readObservedGitTree(repo, second);
  raw(repo, ['replace', second, first]);
  const treeReplaced = readObservedGitTree(repo, second);
  assert.notEqual(treeReplaced, treeBefore, 'a replace ref is seen by the next object-addressed tree read');
  raw(repo, ['replace', '-d', second]);
  assert.equal(readObservedGitTree(repo, second), treeBefore, 'deleting the replace ref is seen');

  // fresh: a config edit changes the witness, so the read runs again.
  read(repo, head);
  raw(repo, ['config', 'core.abbrev', '12']);
  assert.equal(count(() => read(repo, head)).spawns, 1, 'a config edit invalidates the remembered answer');

  // fresh: a remembered ref failure is retried once the ref exists.
  const remoteHead = ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'];
  const refused = count(() => [failing(repo, remoteHead), failing(repo, remoteHead)]);
  assert.deepEqual(refused.value, ['refused', 'refused']);
  assert.equal(refused.spawns, 1, 'a ref-only refusal is remembered while no ref moves');
  raw(repo, ['update-ref', 'refs/remotes/origin/main', second]);
  raw(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  assert.equal(read(repo, remoteHead), 'refs/remotes/origin/main', 'a ref created after a remembered refusal is seen');

  // scope: an object-addressed failure always reruns (the object may appear without a ref moving).
  const missing = ['cat-file', '-e', 'f'.repeat(40)];
  assert.equal(count(() => [failing(repo, missing), failing(repo, missing)]).spawns, 2, 'an object-addressed refusal is never remembered');

  // scope: a working-tree diff always runs git and sees the edit.
  const worktreeDiff = ['diff', '--name-only'];
  assert.equal(isRefStateGitRead(worktreeDiff), false);
  assert.equal(isRefStateGitRead(['diff', '--no-renames', '--name-only', 'refs/heads/main...HEAD']), true);
  assert.equal(isRefStateGitRead(['diff', '--name-status', 'refs/heads/main...HEAD']), false, 'default rename detection uses the checkout diff attributes');
  assert.equal(isRefStateGitRead(['diff', '--name-status', '-M', '-z', `${first}..${first}`]), false);
  assert.equal(isRefStateGitRead(['diff', 'HEAD', 'a.txt']), false, 'one revision plus a path compares against the working tree');
  assert.equal(isRefStateGitRead(['diff', '--unified=20', 'refs/heads/main...HEAD']), false, 'patch text uses the checkout .gitattributes');
  assert.equal(isRefStateGitRead(['log', 'main..HEAD']), false, 'default log format applies the checkout mailmap');
  assert.equal(isRefStateGitRead(['log', '--format=%H%x00%B', 'main..HEAD']), true);
  assert.equal(isRefStateGitRead(['show', `${first}:a.txt`]), true);
  assert.equal(isRefStateGitRead(['cat-file', '--textconv', `${first}:a.txt`]), false);
  assert.equal(isRefStateGitRead(['-C', repo, 'rev-parse', 'HEAD']), false);
  assert.equal(isRefStateGitRead(['rev-parse', 'HEAD@{1}']), false);
  assert.equal(isRefStateGitRead(['show', ':a.txt']), false);
  const clean = count(() => [read(repo, worktreeDiff), read(repo, worktreeDiff)]);
  assert.equal(clean.spawns, 2, 'working-tree reads are never remembered');
  writeFileSync(join(repo, 'a.txt'), 'dirty\n');
  assert.equal(read(repo, worktreeDiff), 'a.txt');

  // scope: launch-time rereads always run git.
  read(repo, head);
  assert.equal(count(() => withoutGitObservation(() => [read(repo, head), read(repo, head)])).spawns, 2, 'withoutGitObservation rereads run git every time');

  // scope: an observation's first read takes the current remembered answer (refs unchanged).
  assert.equal(count(() => withGitTreeObservation(() => [read(repo, head), read(repo, head)])).spawns, 0, 'an observation reuses the answer for the unchanged ref state');
  raw(repo, ['commit', '-q', '--allow-empty', '-m', 'three']);
  const third = raw(repo, ['rev-parse', 'HEAD']);
  const inObservation = count(() => withGitTreeObservation(() => [read(repo, head), read(repo, head)]));
  assert.deepEqual(inObservation.value, [third, third], 'an observation after a commit sees the new HEAD');
  assert.equal(inObservation.spawns, 1, 'an observation after a commit probes once');

  // scope: a non-inert GIT_* variable disables the memo.
  process.env.GIT_DIR = join(repo, '.git');
  try {
    assert.equal(count(() => [read(repo, head), read(repo, head)]).spawns, 2, 'a redirecting GIT_* variable disables the memo');
  } finally { delete process.env.GIT_DIR; }

  console.log('git-ref-witness-memo-smoke: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
