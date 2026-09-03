// B-fa65: checkGlobalCoreRealpath must accept a worktree-built CLI whose global
// package resolves to the canonical main checkout of the CLI's own repository,
// while genuine unrelated-path drift and non-git fallbacks keep today's warn.
// B-e256 CHK-003: the row also reports the bin target's mode / executable bit,
// warns with the exact `chmod +x` / `npm link` remediation for a non-executable
// target or a realpath inside a `.worktrees/` checkout, and stays informational
// (pass) when no global install exists.
// B-e256 F-002: a declared bin target that is absent (ENOENT) or is not a
// regular file (a directory) is the distinct "rebuild" remediation
// (`npm --prefix <realpath> run build`), never a `chmod +x`.
// B-e256 cross-host review B-e256-xhr-r6 (MAJOR x2): the executable fact is
// the access(2) X_OK verdict for the CURRENT process (mode bits are display
// only), and an INSTALLED package whose package.json is unreadable, has no
// `bin`, or lacks the proof-or-stop bin entry is drift with a named reason,
// never a pass rendered as executable=unverified.
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
// executable-bit facts are exercised; `binMode` controls the target's mode and
// `binTarget` its shape: 'file' (default), 'absent' (declared but never
// emitted) or 'directory' (declared path exists but is not a regular file).
function writeCorePackage(coreRoot, { binMode = 0o755, binTarget = 'file' } = {}) {
  mkdirSync(join(coreRoot, 'dist'), { recursive: true });
  writeFileSync(join(coreRoot, 'package.json'), JSON.stringify({ name: '@proof-or-stop/core', version: '0.0.0', bin: { 'proof-or-stop': 'dist/cli.js' } }) + '\n');
  const bin = join(coreRoot, 'dist', 'cli.js');
  if (binTarget === 'absent') {
    // keep dist/ non-empty so git tracks the directory without the bin target
    writeFileSync(join(coreRoot, 'dist', 'index.js'), 'export {};\n');
    return bin;
  }
  if (binTarget === 'directory') {
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'index.js'), 'export {};\n');
    chmodSync(bin, binMode);
    return bin;
  }
  writeFileSync(bin, '#!/usr/bin/env node\n');
  chmodSync(bin, binMode);
  return bin;
}

function makeRepoWithWorktree(base, { binMode = 0o755, binTarget = 'file', worktreeDir } = {}) {
  const repo = join(base, 'repo');
  writeCorePackage(join(repo, 'packages', 'main'), { binMode, binTarget });
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

// Breaks the package.json of an already-committed core package IN PLACE
// (call it on the canonical repo copy after makeRepoWithWorktree so the
// worktree copy that acts as corePackageRoot stays valid).
function breakPackageJson(coreRoot, variant) {
  const path = join(coreRoot, 'package.json');
  if (variant === 'malformed') return writeFileSync(path, '{ this is not json\n');
  if (variant === 'missing') return rmSync(path, { force: true });
  if (variant === 'no-bin') return writeFileSync(path, JSON.stringify({ name: '@proof-or-stop/core', version: '0.0.0' }) + '\n');
  if (variant === 'bin-entry-missing') return writeFileSync(path, JSON.stringify({ name: '@proof-or-stop/core', version: '0.0.0', bin: { 'some-other-cli': 'dist/cli.js' } }) + '\n');
  throw new Error(`unknown variant ${variant}`);
}

function runChecks(base, corePackageRoot, globalRoot, extraOptions = {}) {
  const projectRoot = join(base, 'fixture-project');
  mkdirSync(projectRoot, { recursive: true });
  const bin = join(base, 'fake-proofOrStop');
  writeFileSync(bin, '#!/usr/bin/env node\n');
  return runRuntimeEnvironmentChecks(projectRoot, {
    commandResolver: () => bin,
    globalNpmRootResolver: () => globalRoot,
    corePackageRoot,
    ...extraOptions,
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
    // B-e256-xhr-r6: a bare directory is an unverifiable install (case 10);
    // the non-git fallback is exercised with a real core package.
    const plainCore = join(base, 'plain-core');
    writeCorePackage(plainCore);
    const globalRootMatch = makeGlobalRootLinkedTo(join(base, 'm'), plainCore);
    const matched = runChecks(join(base, 'm'), plainCore, globalRootMatch);
    assert.equal(matched.globalCoreRealpath.status, 'pass', 'non-git fallback with matching global must pass (unchanged behavior)');

    const other = join(base, 'other-core');
    writeCorePackage(other);
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
    assert.equal(actual.executable, null);
    assert.equal(actual.verification, null, 'an ABSENT install has nothing to verify and must not be classified as unverifiable');
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

// 7. B-e256 F-002: canonical realpath but the declared bin target does not
//    exist (ENOENT: dist was never emitted / was wiped) -> warning row with the
//    distinct `npm --prefix <realpath> run build` rebuild remediation, not chmod.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-absent-bin-warn-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base, { binTarget: 'absent' });
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    const actual = report.globalCoreRealpath.actual;
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const expectedBin = join(canonical, 'dist', 'cli.js');
    const rebuild = `npm --prefix ${canonical} run build`;
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'absent bin target must never pass silently');
    assert.equal(actual.executable, false);
    assert.equal(actual.binMode, null, 'an absent target has no mode to report');
    assert.equal(actual.binTarget, expectedBin);
    assert.equal(actual.remediation, rebuild);
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(warnings.includes(`global bin target ${expectedBin} does not exist; rebuild: ${rebuild}`), `warning must carry the exact rebuild command, got: ${warnings}`);
    assert.doesNotMatch(warnings, /chmod \+x/, 'a missing target is a rebuild problem, not a mode problem');
    assert.doesNotMatch(warnings, /resolves to/, 'canonical realpath must not be reported as drift');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 8. B-e256 F-002: the declared bin target path exists but is a directory
//    (not a regular file) -> same rebuild remediation; the mode is still
//    reported so the row explains what was found there.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-dir-bin-warn-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base, { binTarget: 'directory' });
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    const actual = report.globalCoreRealpath.actual;
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const expectedBin = join(canonical, 'dist', 'cli.js');
    const rebuild = `npm --prefix ${canonical} run build`;
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'a directory at the bin target must never pass silently');
    assert.equal(actual.executable, false);
    assert.equal(actual.binMode, '0755', 'the mode of the non-file entry is still reported');
    assert.equal(actual.binTarget, expectedBin);
    assert.equal(actual.remediation, rebuild);
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(warnings.includes(`global bin target ${expectedBin} does not exist; rebuild: ${rebuild}`), `warning must carry the exact rebuild command, got: ${warnings}`);
    assert.doesNotMatch(warnings, /chmod \+x/, 'a non-file target is a rebuild problem, not a mode problem');
    assert.doesNotMatch(warnings, /resolves to/, 'canonical realpath must not be reported as drift');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 9. B-e256-xhr-r6 MAJOR (a): the executable verdict is the access(2) X_OK
//    probe for the current process, not "any 0o111 bit set". The root-owned
//    0100 case cannot be built by an unprivileged test, so the injectable probe
//    (`executableAccessProbe`, the same seam production fills with accessSync
//    X_OK) is what proves the owner/group case: with the bit set and the probe
//    denying, the row reports executable=no; with the bit clear and the probe
//    allowing, executable=yes. The default probe is then exercised on files
//    owned by the current user (0700 -> yes, 0600 -> no).
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-xok-probe-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base, { binMode: 0o755 });
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const expectedBin = realpathSync(join(repo, 'packages', 'main', 'dist', 'cli.js'));

    // (i) mode 0755 but the current user may NOT execute it (probe denies)
    const probed = [];
    const denied = runChecks(join(base, 'deny'), join(worktree, 'packages', 'main'), globalRoot, {
      executableAccessProbe: (path) => { probed.push(path); return false; },
    });
    assert.deepEqual(probed, [expectedBin], 'the probe must be asked about exactly the bin target');
    assert.notEqual(denied.globalCoreRealpath.status, 'pass', 'a target the current user cannot execute must never pass, whatever its mode bits say');
    assert.equal(denied.globalCoreRealpath.actual.executable, false, 'executable is the X_OK verdict, not the mode bits');
    assert.equal(denied.globalCoreRealpath.actual.binMode, '0755', 'the mode is still reported for display');
    assert.equal(denied.globalCoreRealpath.actual.verification, 'ok');
    assert.equal(denied.globalCoreRealpath.actual.remediation, `chmod +x ${expectedBin}`);
    const deniedWarnings = (denied.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(deniedWarnings.includes(`global bin target ${expectedBin} is not executable by the current user (mode 0755); fix: chmod +x ${expectedBin}`), `warning must say the CURRENT USER cannot execute it, got: ${deniedWarnings}`);

    // (ii) mode 0644 but the probe allows -> executable=yes (the probe decides, the mode is display only)
    chmodSync(expectedBin, 0o644);
    const allowed = runChecks(join(base, 'allow'), join(worktree, 'packages', 'main'), globalRoot, { executableAccessProbe: () => true });
    assert.equal(allowed.globalCoreRealpath.status, 'pass', `probe-allowed target must pass, got: ${(allowed.globalCoreRealpath.warnings ?? []).join(' | ')}`);
    assert.equal(allowed.globalCoreRealpath.actual.executable, true);
    assert.equal(allowed.globalCoreRealpath.actual.binMode, '0644');

    // (iii) default probe = real access(2) X_OK for the current user
    chmodSync(expectedBin, 0o700);
    const ownerExec = runChecks(join(base, 'owner-exec'), join(worktree, 'packages', 'main'), globalRoot);
    assert.equal(ownerExec.globalCoreRealpath.status, 'pass');
    assert.equal(ownerExec.globalCoreRealpath.actual.executable, true, 'owner-executable 0700 file is executable by the owning current user');
    assert.equal(ownerExec.globalCoreRealpath.actual.binMode, '0700');
    chmodSync(expectedBin, 0o600);
    const ownerNoExec = runChecks(join(base, 'owner-noexec'), join(worktree, 'packages', 'main'), globalRoot);
    assert.notEqual(ownerNoExec.globalCoreRealpath.status, 'pass');
    assert.equal(ownerNoExec.globalCoreRealpath.actual.executable, false, '0600 file is not executable by the current user');
    assert.equal(ownerNoExec.globalCoreRealpath.actual.binMode, '0600');
    assert.match((ownerNoExec.globalCoreRealpath.warnings ?? []).join('\n'), /is not executable by the current user \(mode 0600\)/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 10-12. B-e256-xhr-r6 MAJOR (b)(c)(d): an INSTALLED global package whose
//    package.json is malformed / missing, declares no `bin`, or whose `bin`
//    lacks the proof-or-stop entry is drift: warning naming the exact reason
//    and the package.json path, a concrete remediation (rebuild + relink for
//    the canonical checkout), and a status that is never pass.
for (const [variant, reasonCode, reasonText] of [
  ['malformed', 'package-json-unreadable', 'package.json is missing or malformed'],
  ['missing', 'package-json-unreadable', 'package.json is missing or malformed'],
  ['no-bin', 'bin-field-missing', 'package.json declares no `bin` field'],
  ['bin-entry-missing', 'bin-entry-missing', 'package.json `bin` has no proof-or-stop entry'],
]) {
  const base = mkdtempSync(join(tmpdir(), `gcr-unverifiable-${variant}-`));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base);
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    breakPackageJson(join(repo, 'packages', 'main'), variant);
    const globalRoot = makeGlobalRootLinkedTo(base, canonical);
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    const actual = report.globalCoreRealpath.actual;
    const rebuild = `npm --prefix ${canonical} run build`;
    const relink = `cd -- ${canonical} && npm link`;
    assert.notEqual(report.globalCoreRealpath.status, 'pass', `[${variant}] an installed but unverifiable package must never pass`);
    assert.equal(actual.installed, true, `[${variant}] the package directory exists, so it IS installed`);
    assert.equal(actual.realpath, canonical);
    assert.equal(actual.executable, null, `[${variant}] nothing could be verified`);
    assert.equal(actual.verification, reasonCode);
    assert.equal(actual.remediation, `${rebuild} && ${relink}`, `[${variant}] canonical checkout gets rebuild + relink`);
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(warnings.includes(`at ${canonical} cannot be verified [${reasonCode}]: ${reasonText} (${join(canonical, 'package.json')})`), `[${variant}] warning must name the reason and the package path, got: ${warnings}`);
    assert.ok(warnings.includes(`rebuild and relink: ${rebuild} && ${relink}`), `[${variant}] warning must carry the exact remediation, got: ${warnings}`);
    assert.doesNotMatch(warnings, /resolves to/, `[${variant}] canonical realpath must not be reported as path drift`);
    assert.doesNotMatch(warnings, /chmod \+x/, `[${variant}] nothing to chmod when the bin target is unknown`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 13. B-e256-xhr-r6: an unverifiable package at a DRIFTED realpath keeps the
//    drift line + relink and adds the reason; the relink is not duplicated.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-unverifiable-drift-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base);
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const unrelated = join(base, 'unrelated-core');
    mkdirSync(unrelated, { recursive: true });
    const globalRoot = makeGlobalRootLinkedTo(base, unrelated);
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    const actual = report.globalCoreRealpath.actual;
    const relink = `cd -- ${canonical} && npm link`;
    assert.notEqual(report.globalCoreRealpath.status, 'pass');
    assert.equal(actual.verification, 'package-json-unreadable');
    assert.equal(actual.executable, null);
    assert.equal(actual.remediation, relink, 'a drifted realpath is repointed, not rebuilt');
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.match(warnings, /resolves to/);
    assert.ok(warnings.includes('cannot be verified [package-json-unreadable]'), `got: ${warnings}`);
    assert.equal(warnings.split(relink).length - 1, 1, 'the relink command appears exactly once');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

console.log('ok global-core-realpath');
