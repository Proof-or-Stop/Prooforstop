#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  releasePushApprovalPath,
  writeReleasePushApproval,
} from '../core/release-push-approval.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..', '..');
const cliPath = join(packageRoot, 'cli.js');
const hookPath = join(repoRoot, '.githooks', 'pre-push');
const zeroSha = '0'.repeat(40);
const shaA = '1'.repeat(40);
const shaB = '2'.repeat(40);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

function setupRepo(prefix = 'proof-or-stop-push-approval-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'push-approval@test']);
  git(root, ['config', 'user.name', 'Push Approval Test']);
  write(root, '.gitignore', '.proof-or-stop/tmp/\n.proof-or-stop/\n');
  write(root, 'README.md', '# temp\n');
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

function runHook(root: string, input: string, remote = 'origin') {
  const result = spawnSync('bash', [hookPath, remote, 'unused-url'], {
    cwd: root,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function refUpdate(localSha: string, remoteRef = 'refs/heads/main'): string {
  const localRef = remoteRef === 'refs/heads/main' ? 'refs/heads/main' : 'refs/heads/codex/test';
  return `${localRef} ${localSha} ${remoteRef} ${zeroSha}\n`;
}

// Test 1: main push is default-denied without approval.
{
  const root = setupRepo();
  try {
    const result = runHook(root, refUpdate(shaA));
    assert.notEqual(result.status, 0, 'main push must be denied without one-shot approval');
    assert.match(result.output, /missing one-shot approval file/, 'missing approval message should be visible');
    console.log('✓ Test 1: default-deny main push without approval');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Test 2: non-main remote branches are always denied.
{
  const root = setupRepo();
  try {
    const result = runHook(root, refUpdate(shaA, 'refs/heads/codex/test'));
    assert.notEqual(result.status, 0, 'non-main remote branch push must be denied');
    assert.match(result.output, /refusing to push remote branch 'codex\/test'/, 'non-main rejection should name the branch');
    console.log('✓ Test 2: deny non-main remote branch push');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Test 3: exact approved main SHA is allowed and consumes the approval.
// An approval cannot nominate an arbitrary non-task branch.
{
  const root = setupRepo();
  try {
    writeReleasePushApproval({ root, sha: shaA, branch: 'release/candidate', remote: 'origin', ttlSeconds: 60, reason: 'wrong target' });
    const result = runHook(root, refUpdate(shaA, 'refs/heads/release/candidate'));
    assert.notEqual(result.status, 0, 'approval for a non-integration branch must be denied');
    assert.match(result.output, /only valid for refs\/heads\/main/, 'rejection should name the resolved integration branch');
    assert.equal(existsSync(releasePushApprovalPath(root)), true, 'rejected approval must not be consumed');
    console.log('✓ Test 2b: deny approval-selected non-integration branch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Every unapproved non-task branch is denied as well.
{
  const root = setupRepo();
  try {
    const result = runHook(root, refUpdate(shaA, 'refs/heads/release/candidate'));
    assert.notEqual(result.status, 0, 'unapproved non-task branch push must be denied');
    assert.match(result.output, /missing one-shot approval file/, 'default-deny message should remain visible');
    console.log('✓ Test 2c: default-deny unapproved non-task branch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Test 3: exact approved main SHA is allowed and consumes the approval.
{
  const root = setupRepo();
  try {
    writeReleasePushApproval({ root, sha: shaA, remote: 'origin', ttlSeconds: 60, reason: 'smoke exact sha' });
    const result = runHook(root, refUpdate(shaA));
    assert.equal(result.status, 0, `approved exact main push should pass:\n${result.output}`);
    assert.equal(existsSync(releasePushApprovalPath(root)), false, 'approval must be consumed after use');
    console.log('✓ Test 3: allow exact approved main SHA and consume approval');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Test 4: wrong SHA is denied.
{
  const root = setupRepo();
  try {
    writeReleasePushApproval({ root, sha: shaA, remote: 'origin', ttlSeconds: 60, reason: 'smoke wrong sha' });
    const result = runHook(root, refUpdate(shaB));
    assert.notEqual(result.status, 0, 'wrong sha must be denied');
    assert.match(result.output, /approval sha mismatch/, 'wrong sha rejection should be visible');
    console.log('✓ Test 4: deny wrong SHA');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Test 5: expired approval is denied.
{
  const root = setupRepo();
  try {
    writeReleasePushApproval({
      root,
      sha: shaA,
      remote: 'origin',
      ttlSeconds: 1,
      now: new Date(Date.now() - 10_000),
      reason: 'smoke expired',
    });
    const result = runHook(root, refUpdate(shaA));
    assert.notEqual(result.status, 0, 'expired approval must be denied');
    assert.match(result.output, /approval expired/, 'expired approval rejection should be visible');
    console.log('✓ Test 5: deny expired approval');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Test 6: release_approve_push creates a local approval but does not dirty git.
{
  const root = setupRepo();
  try {
    const stdout = execFileSync(process.execPath, [
      cliPath,
      '--root', root,
      'release_approve_push',
      '--confirm',
      '--ttlSeconds=60',
      '--reason=smoke-test',
      '--json',
    ], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, 'approved-local-only', 'CLI should report local-only approval');
    assert.equal(parsed.approval.branch, 'refs/heads/main', 'CLI approval must target main');
    assert.equal(existsSync(releasePushApprovalPath(root)), true, 'CLI must write approval file');
    const approval = JSON.parse(readFileSync(releasePushApprovalPath(root), 'utf8'));
    assert.equal(approval.sha, git(root, ['rev-parse', 'HEAD']), 'CLI approval SHA must default to HEAD');
    assert.equal(git(root, ['status', '--porcelain']), '', 'approval file should be ignored and keep git clean');
    console.log('✓ Test 6: release_approve_push creates local-only approval');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('\n✓ All remote-push approval smoke tests passed');
