// B-fa65: checkGlobalCoreRealpath must accept a worktree-built CLI whose global
// package resolves to the canonical main checkout of the CLI's own repository,
// while genuine unrelated-path drift and non-git fallbacks keep today's warn.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const { runRuntimeEnvironmentChecks } = await import(join(distRoot, 'core', 'runtime-environment-checks.js'));

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
}

function makeRepoWithWorktree(base) {
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'packages', 'main'), { recursive: true });
  writeFileSync(join(repo, 'packages', 'main', 'package.json'), JSON.stringify({ name: '@proof-or-stop/core', version: '0.0.0' }) + '\n');
  git(repo, 'init', '-b', 'main');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
  const worktree = join(base, 'repo-wt');
  git(repo, 'worktree', 'add', '-b', 'story/test', worktree);
  return { repo, worktree };
}

function makeGlobalRootLinkedTo(base, target) {
  const globalRoot = join(base, 'global', 'node_modules');
  mkdirSync(join(globalRoot, '@proof-or-stop'), { recursive: true });
  symlinkSync(target, join(globalRoot, '@proof-or-stop', 'core'), 'dir');
  return globalRoot;
}

function runChecks(base, corePackageRoot, globalRoot) {
  const projectRoot = join(base, 'fixture-project');
  mkdirSync(projectRoot, { recursive: true });
  const bin = join(base, 'fake-proofOrStop');
  writeFileSync(bin, '#!/usr/bin/env node\n');
  return runRuntimeEnvironmentChecks(projectRoot, {
    commandResolver: () => bin,
    globalNpmRootResolver: () => globalRoot,
    corePackageRoot,
  });
}

// 1. Worktree-built CLI + global resolving to the canonical main checkout → pass.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-worktree-pass-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base);
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    assert.equal(report.globalCoreRealpath.status, 'pass',
      `worktree-built core with global at canonical main checkout must pass, got ${report.globalCoreRealpath.status}: ${(report.globalCoreRealpath.warnings ?? []).join(' | ')}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 2. Genuine drift: global resolves to an unrelated path → warn survives.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-drift-warn-'));
  try {
    const { worktree } = makeRepoWithWorktree(base);
    const unrelated = join(base, 'unrelated-core');
    mkdirSync(unrelated, { recursive: true });
    const globalRoot = makeGlobalRootLinkedTo(base, unrelated);
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'unrelated global resolution must not pass');
    assert.match((report.globalCoreRealpath.warnings ?? []).join('\n'), /resolves to/, 'genuine drift keeps the explanatory warning');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 3. Non-git core root falls back to today's behavior: matching path passes, differing path warns.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-nongit-fallback-'));
  try {
    const plainCore = join(base, 'plain-core');
    mkdirSync(plainCore, { recursive: true });
    const globalRootMatch = makeGlobalRootLinkedTo(join(base, 'm'), plainCore);
    const matched = runChecks(join(base, 'm'), plainCore, globalRootMatch);
    assert.equal(matched.globalCoreRealpath.status, 'pass', 'non-git fallback with matching global must pass (unchanged behavior)');

    const other = join(base, 'other-core');
    mkdirSync(other, { recursive: true });
    const globalRootDrift = makeGlobalRootLinkedTo(join(base, 'd'), other);
    const drifted = runChecks(join(base, 'd'), plainCore, globalRootDrift);
    assert.notEqual(drifted.globalCoreRealpath.status, 'pass', 'non-git fallback with differing global must warn (unchanged behavior)');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

console.log('ok global-core-realpath');
