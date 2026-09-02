// B-fa65: checkGlobalCoreRealpath must accept a worktree-built CLI whose global
// package resolves to the canonical main checkout of the CLI's own repository,
// while genuine unrelated-path drift and non-git fallbacks keep today's warn.
// B-e256 CHK-003: the row also reports the bin target's mode / executable bit,
// warns with the exact `chmod +x` / `npm link` remediation for a non-executable
// target or a realpath inside a `.worktrees/` checkout, and stays informational
// (pass) when no global install exists.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const { runRuntimeEnvironmentChecks } = await import(join(distRoot, 'core', 'runtime-environment-checks.js'));

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
}

// Writes a realistic core package (package.json `bin` -> dist/cli.js) so the
// executable-bit facts are exercised; `binMode` controls the target's mode.
function writeCorePackage(coreRoot, { binMode = 0o755 } = {}) {
  mkdirSync(join(coreRoot, 'dist'), { recursive: true });
  writeFileSync(join(coreRoot, 'package.json'), JSON.stringify({ name: '@proof-or-stop/core', version: '0.0.0', bin: { 'proof-or-stop': 'dist/cli.js' } }) + '\n');
  const bin = join(coreRoot, 'dist', 'cli.js');
  writeFileSync(bin, '#!/usr/bin/env node\n');
  chmodSync(bin, binMode);
  return bin;
}

function makeRepoWithWorktree(base, { binMode = 0o755, worktreeDir } = {}) {
  const repo = join(base, 'repo');
  writeCorePackage(join(repo, 'packages', 'main'), { binMode });
  git(repo, 'init', '-b', 'main');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init');
  const worktree = worktreeDir ?? join(base, 'repo-wt');
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
    // B-e256 CHK-003 happy path: the pass row carries realpath, version and mode facts.
    const actual = report.globalCoreRealpath.actual;
    assert.equal(actual.installed, true);
    assert.equal(actual.realpath, realpathSync(join(repo, 'packages', 'main')));
    assert.equal(actual.version, '0.0.0');
    assert.equal(actual.binTarget, realpathSync(join(repo, 'packages', 'main', 'dist', 'cli.js')));
    assert.equal(actual.binMode, '0755');
    assert.equal(actual.executable, true);
    assert.equal(actual.worktreeCheckout, false);
    assert.equal(actual.remediation, null);
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

// 4. B-e256 CHK-003: canonical realpath but the bin target lost its executable bit
//    -> warning row with the exact `chmod +x <absolute path>` remediation.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-nonexec-warn-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base, { binMode: 0o644 });
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    const actual = report.globalCoreRealpath.actual;
    const expectedBin = realpathSync(join(repo, 'packages', 'main', 'dist', 'cli.js'));
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'non-executable bin target must never pass silently');
    assert.equal(actual.executable, false);
    assert.equal(actual.binMode, '0644');
    assert.equal(actual.binTarget, expectedBin);
    assert.equal(actual.remediation, `chmod +x ${expectedBin}`);
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(warnings.includes(`chmod +x ${expectedBin}`), `warning must carry the exact chmod command, got: ${warnings}`);
    assert.doesNotMatch(warnings, /resolves to/, 'canonical realpath must not be reported as drift');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 5. B-e256 CHK-003: global realpath inside a `.worktrees/` checkout of this
//    repository -> warning row with the exact `npm link` repoint from the
//    canonical main checkout.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-worktree-drift-'));
  try {
    const worktreeDir = join(base, 'repo', '.worktrees', 'B-test');
    const { repo, worktree } = makeRepoWithWorktree(base, { worktreeDir });
    const globalRoot = makeGlobalRootLinkedTo(base, join(worktree, 'packages', 'main'));
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    const actual = report.globalCoreRealpath.actual;
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const relink = `cd -- ${canonical} && npm link`;
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'realpath inside .worktrees/ must never pass silently');
    assert.equal(actual.worktreeCheckout, true);
    assert.equal(actual.realpath, realpathSync(join(worktree, 'packages', 'main')));
    assert.equal(actual.executable, true, 'the executable bit is still reported for a drifted realpath');
    assert.equal(actual.remediation, relink);
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.match(warnings, /resolves to/, 'drift keeps the explanatory line');
    assert.match(warnings, /\.worktrees\//, 'the worktree-checkout condition is named');
    assert.ok(warnings.includes(relink), `warning must carry the exact repoint command, got: ${warnings}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 6. B-e256 CHK-003: no global install at all -> informational (pass) row that
//    names how to link one; never a warning.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-no-global-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base);
    const emptyGlobalRoot = join(base, 'global', 'node_modules');
    mkdirSync(emptyGlobalRoot, { recursive: true });
    const report = runChecks(base, join(worktree, 'packages', 'main'), emptyGlobalRoot);
    const actual = report.globalCoreRealpath.actual;
    const relink = `cd -- ${realpathSync(join(repo, 'packages', 'main'))} && npm link`;
    assert.equal(report.globalCoreRealpath.status, 'pass', 'missing global install is informational, not a warning');
    assert.equal(report.globalCoreRealpath.warnings, undefined);
    assert.equal(actual.installed, false);
    assert.equal(actual.realpath, null);
    assert.equal(actual.remediation, relink);
    const details = (report.globalCoreRealpath.details ?? []).join('\n');
    assert.ok(details.includes(relink), `informational row must name how to link one, got: ${details}`);

    // The `npm root -g` probe itself failing is the same informational case.
    const noRoot = runChecks(join(base, 'noroot'), join(worktree, 'packages', 'main'), null);
    assert.equal(noRoot.globalCoreRealpath.status, 'pass');
    assert.equal(noRoot.globalCoreRealpath.actual.installed, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

console.log('ok global-core-realpath');
