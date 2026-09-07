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
// B-e256 cross-host review B-e256-xhr-r7 (MAJOR): when the realpath DRIFTS, the
// old target's mode / missing facts are reported but the canonical `npm link`
// stays the sole actionable remediation (no chmod/rebuild of the obsolete path).
// B-e256 cross-host review B-e256-xhr-r11 (MAJOR x2): (i) a global package entry
// that is a BROKEN LINK (its checkout was removed) is present-but-unresolvable
// drift naming the broken target + the relink, never a pass with
// installed=false; (ii) `chmod +x` is offered only when the execute bits are
// actually clear - X_OK denied WITH the bits set is an ownership/ACL/noexec
// denial that chmod cannot repair, so it gets rebuild-and-relink instead.
// B-e256 cross-host review B-e256-xhr-r12 (MAJOR x2): (i) a presence probe that
// FAILS with anything other than ENOENT/ENOTDIR observed nothing, so it is
// unverifiable drift naming the errno - never a green "not installed" - and the
// same holds for an installed candidate whose realpath will not resolve;
// (ii) the global package version is a VERIFIED fact: a missing version, or one
// that differs from the canonical core package's, is drift with a
// rebuild-and-relink remediation, not a decorative `version=unknown`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const { runRuntimeEnvironmentChecks, renderRuntimeEnvironmentReport } = await import(join(distRoot, 'core', 'runtime-environment-checks.js'));
// The documented fallback expectation used when the canonical core package.json
// carries no readable version (B-e256-xhr-r12), read from the same build.
const { PROOF_OR_STOP_CLI_VERSION } = await import(join(distRoot, 'core', 'proof-or-stop-brand.js'));

// The doctor row itself, so "never renders as not installed" is asserted on the
// rendered output an operator actually reads, not only on the structured facts.
function globalCoreRow(report) {
  return renderRuntimeEnvironmentReport(report)
    .split('\n')
    .find((line) => line.includes('global-core-realpath')) ?? '';
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
}

const isWindowsHost = process.platform === 'win32';
const canEnforcePosixPermissions = !isWindowsHost && (typeof process.getuid !== 'function' || process.getuid() !== 0);

// Most historical fixtures below model npm link with a directory link. Windows
// may lack that capability; platform-only cases run first without links, and
// only the link-dependent remainder gets an explicit non-PASS skip marker for
// the documented capability errnos. Any other construction error is fatal.
function probeDirectoryLinkCapability() {
  const base = mkdtempSync(join(tmpdir(), 'gcr-link-capability-'));
  const target = join(base, 'target');
  const link = join(base, 'link');
  try {
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link, isWindowsHost ? 'junction' : 'dir');
    assert.equal(realpathSync(link), realpathSync(target), 'directory-link capability probe resolved to the wrong target');
    return { supported: true, reason: null };
  } catch (error) {
    if (isWindowsHost && ['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      return { supported: false, reason: `${error.code}: ${error.message}` };
    }
    throw error;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const directoryLinkCapability = probeDirectoryLinkCapability();

// Writes a realistic core package (package.json `bin` -> dist/cli.js) so the
// executable-bit facts are exercised; `binMode` controls the target's mode and
// `binTarget` its shape: 'file' (default), 'absent' (declared but never
// emitted) or 'directory' (declared path exists but is not a regular file).
// `version` controls the package.json `version` field: a string declares it,
// `null` omits it entirely (the B-e256-xhr-r12 missing-version case).
// `compiledVersion` (B-e256 cross-host review B-e256-xhr-r13) controls the
// SEPARATE `dist/core/proof-or-stop-brand.js` artifact the check reads for the
// runtime's actually-compiled version; it defaults to the running build's own
// PROOF_OR_STOP_CLI_VERSION when `version` is `null` (mirroring
// `readExpectedCoreVersion`'s fallback) so a fixture that only means to
// exercise the MANIFEST-missing-version case does not also manufacture an
// unrelated stale-compiled-runtime finding. Pass an explicit `compiledVersion`
// distinct from `version` to construct that drift on purpose (case 22 below).
function writeCorePackage(coreRoot, { binMode = 0o755, binTarget = 'file', binRel = 'dist/cli.js', version = '0.0.0', compiledVersion = version ?? PROOF_OR_STOP_CLI_VERSION } = {}) {
  mkdirSync(join(coreRoot, 'dist', 'core'), { recursive: true });
  const manifest = { name: '@proof-or-stop/core', bin: { 'proof-or-stop': binRel } };
  if (version !== null) manifest.version = version;
  writeFileSync(join(coreRoot, 'package.json'), JSON.stringify(manifest) + '\n');
  if (compiledVersion !== null) {
    writeFileSync(join(coreRoot, 'dist', 'core', 'proof-or-stop-brand.js'), `export const PROOF_OR_STOP_CLI_VERSION = '${compiledVersion}';\n`);
  }
  const bin = join(coreRoot, binRel);
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
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, '#!/usr/bin/env node\n');
  chmodSync(bin, binMode);
  return bin;
}

function makeRepoWithWorktree(base, { binMode = 0o755, binTarget = 'file', binRel = 'dist/cli.js', worktreeDir, version = '0.0.0', compiledVersion = version ?? PROOF_OR_STOP_CLI_VERSION } = {}) {
  const repo = join(base, 'repo');
  writeCorePackage(join(repo, 'packages', 'main'), { binMode, binTarget, binRel, version, compiledVersion });
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
  symlinkSync(target, join(globalRoot, '@proof-or-stop', 'core'), isWindowsHost ? 'junction' : 'dir');
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
  const platform = extraOptions.platform ?? process.platform;
  const bin = join(base, platform === 'win32' ? 'proof-or-stop.cmd' : 'fake-proofOrStop');
  if (platform === 'win32' && globalRoot) {
    writeRepresentativeWindowsShim(bin, globalRoot);
  } else if (globalRoot) {
    symlinkSync(join(globalRoot, '@proof-or-stop', 'core', 'dist', 'cli.js'), bin, 'file');
  } else {
    writeFileSync(bin, '#!/usr/bin/env node\n');
  }
  return runRuntimeEnvironmentChecks(projectRoot, {
    commandResolver: () => bin,
    globalNpmRootResolver: () => globalRoot,
    corePackageRoot,
    windowsCommandRuntimeProbe: (_commandPath, expectedVersion) => ({
      exitCode: 0,
      stdout: `Proof-or-Stop ${expectedVersion}\n`,
      stderr: '',
      errorCode: null,
      failureReason: null,
    }),
    ...extraOptions,
  });
}

function writeRepresentativeWindowsShim(shimPath, globalRoot, packageName = '@proof-or-stop/core', binRel = 'dist/cli.js') {
  const commandBase = shimPath.replace(/\.(?:cmd|ps1)$/i, '');
  const lexicalTarget = join(globalRoot, ...packageName.split('/'), binRel);
  const shTarget = relative(dirname(commandBase), lexicalTarget).replaceAll('\\', '/');
  const cmdTarget = shTarget.replaceAll('/', '\\');
  const cmd = '@ECHO off\r\n'
    + 'GOTO start\r\n'
    + ':find_dp0\r\n'
    + 'SET dp0=%~dp0\r\n'
    + 'EXIT /b\r\n'
    + ':start\r\n'
    + 'SETLOCAL\r\n'
    + 'CALL :find_dp0\r\n'
    + '\r\n'
    + 'IF EXIST "%dp0%\\node.exe" (\r\n'
    + '  SET "_prog=%dp0%\\node.exe"\r\n'
    + ') ELSE (\r\n'
    + '  SET "_prog=node"\r\n'
    + '  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n'
    + ')\r\n'
    + '\r\n'
    + `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${cmdTarget}" %*\r\n`;
  const sh = '#!/bin/sh\n'
    + 'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n'
    + '\n'
    + 'case `uname` in\n'
    + '    *CYGWIN*|*MINGW*|*MSYS*)\n'
    + '        if command -v cygpath > /dev/null 2>&1; then\n'
    + '            basedir=`cygpath -w "$basedir"`\n'
    + '        fi\n'
    + '    ;;\n'
    + 'esac\n'
    + '\n'
    + 'if [ -x "$basedir/node" ]; then\n'
    + `  exec "$basedir/node"  "$basedir/${shTarget}" "$@"\n`
    + 'else \n'
    + `  exec node  "$basedir/${shTarget}" "$@"\n`
    + 'fi\n';
  const ps1 = '#!/usr/bin/env pwsh\n'
    + '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n'
    + '\n'
    + '$exe=""\n'
    + 'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {\n'
    + '  # Fix case when both the Windows and Linux builds of Node\n'
    + '  # are installed in the same directory\n'
    + '  $exe=".exe"\n'
    + '}\n'
    + '$ret=0\n'
    + 'if (Test-Path "$basedir/node$exe") {\n'
    + '  # Support pipeline input\n'
    + '  if ($MyInvocation.ExpectingInput) {\n'
    + `    $input | & "$basedir/node$exe"  "$basedir/${shTarget}" $args\n`
    + '  } else {\n'
    + `    & "$basedir/node$exe"  "$basedir/${shTarget}" $args\n`
    + '  }\n'
    + '  $ret=$LASTEXITCODE\n'
    + '} else {\n'
    + '  # Support pipeline input\n'
    + '  if ($MyInvocation.ExpectingInput) {\n'
    + `    $input | & "node$exe"  "$basedir/${shTarget}" $args\n`
    + '  } else {\n'
    + `    & "node$exe"  "$basedir/${shTarget}" $args\n`
    + '  }\n'
    + '  $ret=$LASTEXITCODE\n'
    + '}\n'
    + 'exit $ret\n';
  writeFileSync(commandBase, sh);
  writeFileSync(`${commandBase}.cmd`, cmd);
  writeFileSync(`${commandBase}.ps1`, ps1);
  return shimPath;
}

function expectedCommandPath(path) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(path) ? path : `'${path.replace(/'/g, `'"'"'`)}'`;
}

function expectedRelink(root, platform = process.platform) {
  return platform === 'win32'
    ? expectedWindowsPowerShellCommand(`Set-Location -LiteralPath ${expectedPowerShellLiteral(root)}; & npm.cmd link`)
    : `cd -- ${expectedCommandPath(root)} && npm link`;
}

function expectedRebuild(root, platform = process.platform) {
  return platform === 'win32'
    ? expectedWindowsPowerShellCommand(`& npm.cmd --prefix ${expectedPowerShellLiteral(root)} run build`)
    : `npm --prefix ${expectedCommandPath(root)} run build`;
}

function expectedInspect(path, platform = process.platform) {
  return platform === 'win32'
    ? expectedWindowsPowerShellCommand(`Get-Item -Force -LiteralPath ${expectedPowerShellLiteral(path)} | Format-List -Property FullName,Attributes,LinkType,Target`)
    : `ls -ld -- ${expectedCommandPath(path)}`;
}

function expectedPowerShellLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function expectedWindowsPowerShellCommand(script) {
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

function decodeWindowsPowerShellCommand(command) {
  const prefix = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ';
  assert.ok(command.startsWith(prefix), `expected encoded PowerShell remediation, got: ${command}`);
  return Buffer.from(command.slice(prefix.length), 'base64').toString('utf16le');
}

function globalCoreCompletionMarker(linkSupported, executedAssertionGroups) {
  if (executedAssertionGroups <= 0) throw new Error('global-core-realpath cannot report PASS without executed assertion groups');
  return linkSupported
    ? 'ok global-core-realpath'
    : `SKIP-NOT-PASS global-core-realpath: link-dependent cases unavailable after ${executedAssertionGroups} non-link assertion groups`;
}

assert.throws(() => globalCoreCompletionMarker(true, 0), /cannot report PASS/, 'zero executed assertions must never produce the must selector');

let executedAssertionGroups = 0;

// F-029/F-030/F-033/F-035: these Windows-contract cases use a real package
// directory rather than a directory link, so they still run when this host
// cannot create a symlink/junction.
{
  const base = mkdtempSync(join(tmpdir(), "gcr-win-no-link %TEMP%' Fixture-"));
  try {
    const globalRoot = join(base, 'global', 'node_modules');
    const coreRoot = join(globalRoot, '@proof-or-stop', 'core');
    writeCorePackage(coreRoot, { binMode: 0o644 });
    const canonicalCoreRoot = realpathSync(coreRoot);
    const shim = join(dirname(globalRoot), 'proof-or-stop.cmd');
    writeRepresentativeWindowsShim(shim, globalRoot);

    const healthy = runChecks(join(base, 'healthy'), coreRoot, globalRoot, { platform: 'win32', commandResolver: () => shim });
    assert.equal(healthy.globalCoreRealpath.status, 'pass', (healthy.globalCoreRealpath.warnings ?? []).join(' | '));
    assert.equal(healthy.globalCoreRealpath.actual.commandShim, shim);
    assert.equal(healthy.globalCoreRealpath.actual.executable, true);
    assert.equal(healthy.globalCoreRealpath.actual.verification, 'ok');
    executedAssertionGroups += 1;

    const shimBase = shim.replace(/\.cmd$/i, '');
    for (const selectedPeer of [shimBase, `${shimBase}.cmd`, `${shimBase}.ps1`]) {
      const peerSelected = runChecks(join(base, `healthy-${selectedPeer.endsWith('.ps1') ? 'ps1' : selectedPeer.endsWith('.cmd') ? 'cmd' : 'sh'}`), coreRoot, globalRoot, {
        platform: 'win32', commandResolver: () => selectedPeer,
      });
      assert.equal(peerSelected.globalCoreRealpath.status, 'pass', `exact official peer set must validate when ${selectedPeer} is selected`);
      assert.equal(peerSelected.globalCoreRealpath.actual.verification, 'ok');
      executedAssertionGroups += 1;
    }

    writeFileSync(shim, `@REM node "${join(globalRoot, '@proof-or-stop', 'core', 'dist', 'cli.js')}"\r\nnode other-package\\dist\\cli.js %*\r\n`);
    const malformed = runChecks(join(base, 'malformed'), coreRoot, globalRoot, { platform: 'win32', commandResolver: () => shim });
    assert.notEqual(malformed.globalCoreRealpath.status, 'pass');
    assert.equal(malformed.globalCoreRealpath.actual.verification, 'windows-command-shim-target-mismatch');
    assert.equal(malformed.globalCoreRealpath.actual.executable, false);
    assert.doesNotMatch(renderRuntimeEnvironmentReport(malformed), /contract: global-core-realpath-pass/);
    const expectedMalformedRemediation = `${expectedRebuild(canonicalCoreRoot, 'win32')} && ${expectedRelink(canonicalCoreRoot, 'win32')}`;
    assert.equal(malformed.globalCoreRealpath.actual.remediation, expectedMalformedRemediation);
    const [rebuildCommand, relinkCommand] = expectedMalformedRemediation.split(' && ');
    assert.equal(decodeWindowsPowerShellCommand(rebuildCommand), `& npm.cmd --prefix ${expectedPowerShellLiteral(canonicalCoreRoot)} run build`);
    assert.equal(decodeWindowsPowerShellCommand(relinkCommand), `Set-Location -LiteralPath ${expectedPowerShellLiteral(canonicalCoreRoot)}; & npm.cmd link`);
    executedAssertionGroups += 1;

    writeFileSync(shim, `@ECHO off\r\necho node "${join(globalRoot, '@proof-or-stop', 'core', 'dist', 'cli.js')}"\r\nnode other-package\\dist\\cli.js %*\r\n`);
    const echoedTarget = runChecks(join(base, 'echoed-target'), coreRoot, globalRoot, { platform: 'win32', commandResolver: () => shim });
    assert.notEqual(echoedTarget.globalCoreRealpath.status, 'pass', 'an echo of the expected target is not an executing invocation');
    assert.equal(echoedTarget.globalCoreRealpath.actual.verification, 'windows-command-shim-target-mismatch');
    assert.doesNotMatch(renderRuntimeEnvironmentReport(echoedTarget), /contract: global-core-realpath-pass/);
    executedAssertionGroups += 1;

    const canonicalTarget = join(globalRoot, '@proof-or-stop', 'core', 'dist', 'cli.js');
    const executionMarker = join(base, 'option-decoy-executed');
    const semanticTarget = join(base, 'option-decoy-target.cjs');
    writeFileSync(semanticTarget, `require('node:fs').writeFileSync(${JSON.stringify(executionMarker)}, 'executed');\n`);
    for (const args of [['--version', semanticTarget], ['-e', 'void 0', semanticTarget]]) {
      rmSync(executionMarker, { force: true });
      execFileSync(process.execPath, args, { stdio: 'pipe' });
      assert.equal(existsSync(executionMarker), false, `fixture sanity: node ${args[0]} must not execute the following target`);
    }
    const optionDecoys = [
      ['version-option', `node --version "${canonicalTarget}" %*`],
      ['eval-option', `node -e "console.log(String.raw\`${canonicalTarget}\`)" %*`],
    ];
    for (const [label, invocation] of optionDecoys) {
      assert.ok(invocation.includes(canonicalTarget), `${label} mutation must retain the canonical path as a decoy`);
      writeFileSync(shim, `@ECHO off\r\n${invocation}\r\n`);
      const decoy = runChecks(join(base, label), coreRoot, globalRoot, { platform: 'win32', commandResolver: () => shim });
      assert.notEqual(decoy.globalCoreRealpath.status, 'pass', `${label} does not execute the canonical target as Node's script`);
      assert.equal(decoy.globalCoreRealpath.actual.verification, 'windows-command-shim-target-mismatch');
      assert.equal(decoy.globalCoreRealpath.actual.executable, false);
      assert.doesNotMatch(renderRuntimeEnvironmentReport(decoy), /contract: global-core-realpath-pass/);
      executedAssertionGroups += 1;
    }

    writeFileSync(shim, `@ECHO off\r\nnode -- "${canonicalTarget}" %*\r\n`);
    const optionTerminated = runChecks(join(base, 'option-terminator'), coreRoot, globalRoot, { platform: 'win32', commandResolver: () => shim });
    assert.notEqual(optionTerminated.globalCoreRealpath.status, 'pass', 'a hand-written invocation is outside the bounded official npm launcher contract');
    assert.equal(optionTerminated.globalCoreRealpath.actual.verification, 'windows-command-shim-target-mismatch');
    executedAssertionGroups += 1;

    // F-047..F-062: the supported Windows surface is the exact cmd-shim@8
    // three-peer contract, not an approximation of cmd.exe/PowerShell syntax.
    // Each historical false-pass family is represented as an inverse mutation
    // of an otherwise official launcher and must fail closed.
    const cmdControl = () => readFileSync(shim, 'utf8');
    const cmdMutations = [
      ['runtime-rebound', value => value.replace('SET "_prog=node"', 'SET "_prog=echo"')],
      ['unreachable-target', value => value.replace('CALL :find_dp0\r\n', 'CALL :find_dp0\r\ngoto :eof\r\n')],
      ['target-base-unbound', value => value.replace('SET dp0=%~dp0', 'SET dp0=C:\\definitely-wrong')],
      ['shell-inapplicable-target-base', value => value.replace('"%dp0%\\node.exe"', '"$basedir/node.exe"')],
      ['single-quoted-runtime', value => value.replace('"%_prog%"  ', "'%_prog%'  ")],
      ['single-quoted-target', value => value.replace(/"(%dp0%\\[^"\r\n]+)" %\*\r\n$/, "'$1' %*\r\n")],
      ['caret-escaped-separator', value => value.replace('endLocal & goto', 'echo ^& goto')],
      ['arguments-not-forwarded', value => value.replace(' %*\r\n', '\r\n')],
      ['exit-status-masked', value => `${value}exit /b 0\r\n`],
      ['argument-injected', value => value.replace(' %*\r\n', ' definitely-no-such-command %*\r\n')],
      ['stdout-redirected', value => value.replace(' %*\r\n', ' %* >NUL\r\n')],
      ['adjacent-target-suffix', value => value.replace('" %*\r\n', '"garbage %*\r\n')],
      ['adjacent-target-prefix', value => value.replace('  "%dp0%', '  garbage"%dp0%')],
    ];
    for (const [label, mutate] of cmdMutations) {
      writeRepresentativeWindowsShim(shim, globalRoot);
      writeFileSync(shim, mutate(cmdControl()));
      const report = runChecks(join(base, `mutation-${label}`), coreRoot, globalRoot, { platform: 'win32', commandResolver: () => shim });
      assert.notEqual(report.globalCoreRealpath.status, 'pass', `${label} must not satisfy the official npm shim contract`);
      assert.equal(report.globalCoreRealpath.actual.verification, 'windows-command-shim-target-mismatch');
      assert.doesNotMatch(renderRuntimeEnvironmentReport(report), /contract: global-core-realpath-pass/);
      executedAssertionGroups += 1;
    }

    writeRepresentativeWindowsShim(shim, globalRoot);
    writeFileSync(`${shim.replace(/\.cmd$/i, '')}.ps1`, readFileSync(`${shim.replace(/\.cmd$/i, '')}.ps1`, 'utf8').replace('@proof-or-stop/core', 'other-package'));
    const badPowerShellPeer = runChecks(join(base, 'bad-powershell-peer'), coreRoot, globalRoot, { platform: 'win32', commandResolver: () => shim });
    assert.notEqual(badPowerShellPeer.globalCoreRealpath.status, 'pass', 'a corrupt official PowerShell peer cannot hide behind a healthy .cmd peer');
    assert.equal(badPowerShellPeer.globalCoreRealpath.actual.verification, 'windows-command-shim-target-mismatch');
    executedAssertionGroups += 1;

    writeRepresentativeWindowsShim(shim, globalRoot);
    rmSync(`${shim.replace(/\.cmd$/i, '')}.ps1`);
    const missingPowerShellPeer = runChecks(join(base, 'missing-powershell-peer'), coreRoot, globalRoot, { platform: 'win32', commandResolver: () => shim });
    assert.notEqual(missingPowerShellPeer.globalCoreRealpath.status, 'pass', 'all official npm launcher peers are required');
    assert.equal(missingPowerShellPeer.globalCoreRealpath.actual.verification, 'windows-command-shim-missing');
    executedAssertionGroups += 1;

    writeRepresentativeWindowsShim(shim, globalRoot);
    const unreadablePowerShellPeer = runChecks(join(base, 'unreadable-powershell-peer'), coreRoot, globalRoot, {
      platform: 'win32',
      commandResolver: () => shim,
      commandShimReadProbe: path => {
        if (path.endsWith('.ps1')) {
          const error = new Error('access denied');
          error.code = 'EACCES';
          throw error;
        }
        return readFileSync(path, 'utf8');
      },
    });
    assert.notEqual(unreadablePowerShellPeer.globalCoreRealpath.status, 'pass', 'an unreadable PowerShell peer cannot hide behind a healthy .cmd peer');
    assert.equal(unreadablePowerShellPeer.globalCoreRealpath.actual.verification, 'windows-command-shim-unreadable');
    assert.equal(unreadablePowerShellPeer.globalCoreRealpath.actual.verificationErrorCode, 'EACCES');
    executedAssertionGroups += 1;

    writeRepresentativeWindowsShim(shim, globalRoot);
    const runtimeUnavailable = runChecks(join(base, 'runtime-unavailable'), coreRoot, globalRoot, {
      platform: 'win32',
      commandResolver: () => shim,
      windowsCommandRuntimeProbe: () => ({ exitCode: null, stdout: '', stderr: '', errorCode: 'ENOENT', failureReason: 'node runtime unavailable' }),
    });
    assert.notEqual(runtimeUnavailable.globalCoreRealpath.status, 'pass', 'official launcher text alone cannot prove the selected Node runtime is launchable');
    assert.equal(runtimeUnavailable.globalCoreRealpath.actual.verification, 'windows-command-runtime-probe-failed');
    assert.equal(runtimeUnavailable.globalCoreRealpath.actual.verificationErrorCode, 'ENOENT');
    executedAssertionGroups += 1;

    writeRepresentativeWindowsShim(shim, globalRoot);
    const outputSuppressed = runChecks(join(base, 'runtime-output-wrong'), coreRoot, globalRoot, {
      platform: 'win32',
      commandResolver: () => shim,
      windowsCommandRuntimeProbe: () => ({ exitCode: 0, stdout: '', stderr: '', errorCode: null, failureReason: 'expected compiled version output was absent' }),
    });
    assert.notEqual(outputSuppressed.globalCoreRealpath.status, 'pass', 'the bounded runtime witness must observe version output');
    assert.equal(outputSuppressed.globalCoreRealpath.actual.verification, 'windows-command-runtime-probe-failed');
    executedAssertionGroups += 1;

    const dishonestProbe = runChecks(join(base, 'runtime-probe-contract'), coreRoot, globalRoot, {
      platform: 'win32',
      commandResolver: () => shim,
      windowsCommandRuntimeProbe: () => ({ exitCode: 1, stdout: 'Proof-or-Stop 0.0.0\n', stderr: '', errorCode: null, failureReason: null }),
    });
    assert.notEqual(dishonestProbe.globalCoreRealpath.status, 'pass', 'the caller cannot turn a nonzero bounded witness into a pass by omitting failureReason');
    assert.equal(dishonestProbe.globalCoreRealpath.actual.verification, 'windows-command-runtime-probe-failed');
    executedAssertionGroups += 1;

    const fakeExe = join(dirname(shim), 'proof-or-stop.exe');
    writeFileSync(fakeExe, `node "${canonicalTarget}" %*\r\n`);
    const nonBatchShadow = runChecks(join(base, 'non-batch-shadow'), coreRoot, globalRoot, { platform: 'win32', commandResolver: () => fakeExe });
    assert.notEqual(nonBatchShadow.globalCoreRealpath.status, 'pass', 'plain text under a PATHEXT native extension is not a verified npm shim');
    assert.equal(nonBatchShadow.globalCoreRealpath.actual.verification, 'windows-command-shim-target-mismatch');
    executedAssertionGroups += 1;

    writeRepresentativeWindowsShim(shim, globalRoot);
    const unreadable = runChecks(join(base, 'unreadable-shim'), coreRoot, globalRoot, {
      platform: 'win32',
      commandResolver: () => shim,
      commandShimReadProbe: () => {
        const error = new Error('access denied');
        error.code = 'EACCES';
        throw error;
      },
    });
    assert.notEqual(unreadable.globalCoreRealpath.status, 'pass');
    assert.equal(unreadable.globalCoreRealpath.actual.verification, 'windows-command-shim-unreadable');
    assert.equal(unreadable.globalCoreRealpath.actual.verificationErrorCode, 'EACCES');
    assert.doesNotMatch(renderRuntimeEnvironmentReport(unreadable), /contract: global-core-realpath-pass/);
    executedAssertionGroups += 1;

    const bogusPosix = join(base, 'bogus-posix-command');
    writeFileSync(bogusPosix, '#!/usr/bin/env node\n');
    chmodSync(bogusPosix, 0o755);
    const wrongPosixPath = runChecks(join(base, 'wrong-posix-path'), coreRoot, globalRoot, {
      platform: 'linux',
      commandResolver: () => bogusPosix,
      executableAccessProbe: () => true,
    });
    assert.notEqual(wrongPosixPath.globalCoreRealpath.status, 'pass', 'POSIX X_OK cannot substitute for PATH-to-bin realpath agreement');
    assert.equal(wrongPosixPath.globalCoreRealpath.actual.verification, 'command-entrypoint-target-mismatch');
    assert.equal(wrongPosixPath.globalCoreRealpath.actual.commandEntrypointRealpath, realpathSync(bogusPosix));
    assert.doesNotMatch(renderRuntimeEnvironmentReport(wrongPosixPath), /contract: global-core-realpath-pass/);
    executedAssertionGroups += 1;

    const resolverBin = join(base, 'resolver-bin');
    mkdirSync(resolverBin, { recursive: true });
    writeRepresentativeWindowsShim(join(resolverBin, 'proof-or-stop'), globalRoot);
    writeFileSync(join(resolverBin, 'proof-or-stop.cmd'), '@ECHO off\r\nnode other-package\\dist\\cli.js %*\r\n');
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalPathUpper = process.env.PATH;
    const originalPathMixed = process.env.Path;
    const originalPathExt = process.env.PATHEXT;
    try {
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
      process.env.Path = resolverBin;
      process.env.PATH = resolverBin;
      process.env.PATHEXT = '.CMD;.EXE';
      const selected = runRuntimeEnvironmentChecks(join(base, 'resolver-project'), {
        corePackageRoot: coreRoot,
        globalNpmRootResolver: () => globalRoot,
        platform: 'win32',
      });
      assert.equal(selected.globalCoreRealpath.actual.commandShim.toLowerCase(), join(resolverBin, 'proof-or-stop.cmd').toLowerCase());
      assert.equal(selected.globalCoreRealpath.actual.verification, 'windows-command-shim-target-mismatch');
      assert.notEqual(selected.globalCoreRealpath.status, 'pass', 'PATHEXT-selected broken .cmd must win over a valid extensionless sibling');

      rmSync(join(resolverBin, 'proof-or-stop.cmd'));
      writeRepresentativeWindowsShim(join(resolverBin, 'lattice.cmd'), globalRoot);
      const legacyOnly = runRuntimeEnvironmentChecks(join(base, 'legacy-only-project'), {
        corePackageRoot: coreRoot,
        globalNpmRootResolver: () => globalRoot,
        platform: 'win32',
        windowsCommandRuntimeProbe: (_commandPath, expectedVersion) => ({
          exitCode: 0, stdout: `Proof-or-Stop ${expectedVersion}\n`, stderr: '', errorCode: null, failureReason: null,
        }),
      });
      assert.notEqual(legacyOnly.globalCoreRealpath.status, 'pass', 'a legacy lattice launcher cannot mask absence of the canonical command');
      assert.equal(legacyOnly.globalCoreRealpath.actual.verification, 'command-entrypoint-missing');
      assert.equal(legacyOnly.globalCoreRealpath.actual.availableOnPath, false);
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
      if (originalPathMixed === undefined) delete process.env.Path; else process.env.Path = originalPathMixed;
      if (originalPathUpper === undefined) delete process.env.PATH; else process.env.PATH = originalPathUpper;
      if (originalPathExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = originalPathExt;
    }
    executedAssertionGroups += 1;

    const legacyPosix = join(resolverBin, 'lattice');
    writeFileSync(legacyPosix, '#!/usr/bin/env node\n');
    chmodSync(legacyPosix, 0o755);
    rmSync(join(resolverBin, 'proof-or-stop'), { force: true });
    try {
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
      process.env.PATH = resolverBin;
      const legacyOnlyPosix = runRuntimeEnvironmentChecks(join(base, 'legacy-only-posix-project'), {
        corePackageRoot: coreRoot,
        globalNpmRootResolver: () => globalRoot,
        platform: 'linux',
      });
      assert.notEqual(legacyOnlyPosix.globalCoreRealpath.status, 'pass', 'a POSIX lattice executable cannot mask absence of proof-or-stop');
      assert.equal(legacyOnlyPosix.globalCoreRealpath.actual.verification, 'command-entrypoint-missing');
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
      if (originalPathUpper === undefined) delete process.env.PATH; else process.env.PATH = originalPathUpper;
    }
    executedAssertionGroups += 1;

    writeRepresentativeWindowsShim(shim, globalRoot);
    const deniedStat = runChecks(join(base, 'denied-stat'), coreRoot, globalRoot, {
      platform: 'win32',
      commandResolver: () => shim,
      binTargetStatProbe: () => {
        const error = new Error('I/O failure');
        error.code = 'EIO';
        throw error;
      },
    });
    const expectedTarget = join(canonicalCoreRoot, 'dist', 'cli.js');
    assert.equal(deniedStat.globalCoreRealpath.actual.remediation, expectedInspect(expectedTarget, 'win32'));
    assert.equal(
      decodeWindowsPowerShellCommand(deniedStat.globalCoreRealpath.actual.remediation),
      `Get-Item -Force -LiteralPath ${expectedPowerShellLiteral(expectedTarget)} | Format-List -Property FullName,Attributes,LinkType,Target`,
    );
    executedAssertionGroups += 1;

    rmSync(shim, { force: true });
    const missing = runChecks(join(base, 'missing'), coreRoot, globalRoot, { platform: 'win32', commandResolver: () => shim });
    assert.notEqual(missing.globalCoreRealpath.status, 'pass');
    assert.equal(missing.globalCoreRealpath.actual.verification, 'windows-command-shim-missing');
    assert.equal(missing.globalCoreRealpath.actual.verificationErrorCode, 'ENOENT');
    assert.doesNotMatch(renderRuntimeEnvironmentReport(missing), /contract: global-core-realpath-pass/);
    executedAssertionGroups += 1;

    const noPath = runChecks(join(base, 'no-path'), coreRoot, globalRoot, { platform: 'win32', commandResolver: () => null });
    assert.notEqual(noPath.globalCoreRealpath.status, 'pass', 'a healthy npm package cannot substitute for a missing PATH command');
    assert.equal(noPath.globalCoreRealpath.actual.installed, true);
    assert.equal(noPath.globalCoreRealpath.actual.availableOnPath, false);
    assert.equal(noPath.globalCoreRealpath.actual.verification, 'command-entrypoint-missing');
    assert.match((noPath.globalCoreRealpath.warnings ?? []).join('\n'), /no proof-or-stop command was found on PATH/);
    assert.doesNotMatch(renderRuntimeEnvironmentReport(noPath), /contract: global-core-realpath-pass/);
    const noPathScript = decodeWindowsPowerShellCommand(noPath.globalCoreRealpath.actual.remediation);
    assert.equal(noPathScript, `Set-Location -LiteralPath ${expectedPowerShellLiteral(canonicalCoreRoot)}; & npm.cmd link`);
    assert.ok(noPathScript.includes("%TEMP%'' Fixture"), 'decoded remediation preserves percent tokens and apostrophes literally');
    executedAssertionGroups += 1;

    const noPathPosix = runChecks(join(base, 'no-path-posix'), coreRoot, globalRoot, { platform: 'linux', commandResolver: () => null });
    assert.notEqual(noPathPosix.globalCoreRealpath.status, 'pass', 'PATH absence is not Windows-specific');
    assert.equal(noPathPosix.globalCoreRealpath.actual.verification, 'command-entrypoint-missing');
    assert.equal(noPathPosix.globalCoreRealpath.actual.remediation, expectedRelink(canonicalCoreRoot, 'linux'));
    executedAssertionGroups += 1;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

if (!directoryLinkCapability.supported) {
  const marker = globalCoreCompletionMarker(false, executedAssertionGroups);
  assert.doesNotMatch(marker, /^ok global-core-realpath$/, 'a partial capability skip must not match the must selector');
  console.log(`${marker} (${directoryLinkCapability.reason})`);
  process.exit(0);
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
    assert.equal(actual.binTargetRealpath, realpathSync(join(repo, 'packages', 'main', 'dist', 'cli.js')), 'normal in-dist targets bind their resolved path');
    if (!isWindowsHost) assert.equal(actual.binMode, '0755');
    else assert.match(actual.binMode, /^0[0-7]{3}$/, 'Windows mode remains display-only but must be a formatted observed fact');
    assert.equal(actual.executable, true);
    assert.equal(actual.worktreeCheckout, false);
    assert.equal(actual.remediation, null);
    assert.match(renderRuntimeEnvironmentReport(report), /contract: global-core-realpath-pass/, 'doctor rendering must expose the path-invariant pass selector');
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

// 4. B-e256 CHK-003: POSIX canonical realpath but the bin target lost its
//    executable bit -> warning row with the exact chmod remediation. On Windows
//    the same 0644-shaped fixture follows production semantics: mode is display
//    only and npm's generated command shim makes the target executable.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-nonexec-warn-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base, { binMode: 0o644 });
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    const actual = report.globalCoreRealpath.actual;
    const expectedBin = realpathSync(join(repo, 'packages', 'main', 'dist', 'cli.js'));
    if (isWindowsHost) {
      assert.equal(report.globalCoreRealpath.status, 'pass', 'Windows must not apply a POSIX X_OK/mode-bit failure to an npm shim target');
      assert.equal(actual.executable, true, 'production Windows executable semantics are the npm command-shim contract');
      assert.equal(actual.remediation, null);
      assert.doesNotMatch((report.globalCoreRealpath.warnings ?? []).join('\n'), /chmod \+x|cd --|ls -ld/);
    } else {
      assert.notEqual(report.globalCoreRealpath.status, 'pass', 'non-executable bin target must never pass silently');
      assert.equal(actual.executable, false);
      assert.equal(actual.binMode, '0644');
      assert.equal(actual.binTarget, expectedBin);
      assert.equal(actual.remediation, `chmod +x ${expectedBin}`);
      const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
      assert.ok(warnings.includes(`chmod +x ${expectedBin}`), `warning must carry the exact chmod command, got: ${warnings}`);
      assert.doesNotMatch(warnings, /resolves to/, 'canonical realpath must not be reported as drift');
    }
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
    const relink = expectedRelink(canonical);
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
    const relink = expectedRelink(realpathSync(join(repo, 'packages', 'main')));
    assert.equal(report.globalCoreRealpath.status, 'pass', 'missing global install is informational, not a warning');
    assert.equal(report.globalCoreRealpath.warnings, undefined);
    assert.equal(actual.installed, false);
    assert.equal(actual.presence, 'absent', 'a genuinely absent install is ABSENT, not a broken link');
    assert.equal(actual.realpath, null);
    assert.equal(actual.executable, null);
    assert.equal(actual.verification, null, 'an ABSENT install has nothing to verify and must not be classified as unverifiable');
    assert.equal(actual.remediation, relink);
    assert.doesNotMatch(renderRuntimeEnvironmentReport(report), /contract: global-core-realpath-pass/, 'the stable resolved-install selector must not be emitted for an informational missing-global pass');
    const details = (report.globalCoreRealpath.details ?? []).join('\n');
    assert.ok(details.includes(relink), `informational row must name how to link one, got: ${details}`);

    // B-e256 cross-host review B-e256-xhr-r13 MAJOR: the `npm root -g` PROBE
    // itself failing is NOT the same informational case as a probe that
    // genuinely succeeded and found nothing - the real probe never resolves to
    // nothing on success (it always names SOME directory), so a `null` root
    // (however it was produced) observed nothing at all and must never
    // collapse into this pass. This line used to assert exactly the false pass
    // this finding closes; see case (a) below for the dedicated structured
    // failure-reason coverage.
    const noRoot = runChecks(join(base, 'noroot'), join(worktree, 'packages', 'main'), null);
    assert.notEqual(noRoot.globalCoreRealpath.status, 'pass', 'a probe that resolved to no root at all must never pass silently');
    assert.notEqual(noRoot.globalCoreRealpath.actual.installed, false, 'nothing was observed, so installed=false is a claim the probe cannot make');
    assert.equal(noRoot.globalCoreRealpath.actual.installed, null, 'installed is UNKNOWN for a failed probe');
    const noRootWarnings = (noRoot.globalCoreRealpath.warnings ?? []).join('\n');
    assert.doesNotMatch(noRootWarnings, /not installed/, 'a probe failure is not an absent install');
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
    const rebuild = expectedRebuild(canonical);
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
    const rebuild = expectedRebuild(canonical);
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'a directory at the bin target must never pass silently');
    assert.equal(actual.executable, false);
    if (!isWindowsHost) assert.equal(actual.binMode, '0755', 'the mode of the non-file entry is still reported');
    else assert.match(actual.binMode, /^0[0-7]{3}$/, 'the observed non-file mode remains display-only on Windows');
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
if (isWindowsHost) {
  console.log('SKIP global-core-realpath case 9: POSIX access(2)/mode-bit matrix is not applicable on Windows; the Windows npm-shim contract is covered below');
} else {
  const base = mkdtempSync(join(tmpdir(), 'gcr-xok-probe-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base, { binMode: 0o755 });
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const expectedBin = realpathSync(join(repo, 'packages', 'main', 'dist', 'cli.js'));

    // (i) mode 0755 but the current user may NOT execute it (probe denies).
    // B-e256-xhr-r11 MAJOR: the execute bits ARE set here, so `chmod +x` is a
    // no-op; the row must name the ownership / ACL / noexec cause and hand out
    // the rebuild-and-relink action instead.
    const probed = [];
    const denied = runChecks(join(base, 'deny'), join(worktree, 'packages', 'main'), globalRoot, {
      executableAccessProbe: (path) => { probed.push(path); return false; },
    });
    const rebuild = expectedRebuild(canonical);
    const relink = expectedRelink(canonical);
    assert.deepEqual(probed, [expectedBin], 'the probe must be asked about exactly the bin target');
    assert.notEqual(denied.globalCoreRealpath.status, 'pass', 'a target the current user cannot execute must never pass, whatever its mode bits say');
    assert.equal(denied.globalCoreRealpath.actual.executable, false, 'executable is the X_OK verdict, not the mode bits');
    assert.equal(denied.globalCoreRealpath.actual.binMode, '0755', 'the mode is still reported for display');
    assert.equal(denied.globalCoreRealpath.actual.verification, 'ok');
    assert.equal(denied.globalCoreRealpath.actual.remediation, `${rebuild} && ${relink}`, 'X_OK denied with the execute bits SET must not be remediated with chmod');
    const deniedWarnings = (denied.globalCoreRealpath.warnings ?? []).join('\n');
    // chmod is named ONLY to say it cannot repair this; it is never offered as a command.
    assert.doesNotMatch(deniedWarnings, /fix: chmod/, 'chmod must not be presented as the fix');
    assert.ok(!deniedWarnings.includes(`chmod +x ${expectedBin}`), `no runnable chmod command may be offered, got: ${deniedWarnings}`);
    assert.ok(deniedWarnings.includes(`global bin target ${expectedBin} is marked executable (mode 0755) but the current user still cannot execute it`), `warning must say the file IS marked executable yet the CURRENT USER cannot execute it, got: ${deniedWarnings}`);
    assert.match(deniedWarnings, /ownership or an ACL denying execute to this user, or a filesystem mounted noexec/, `warning must name the likely causes, got: ${deniedWarnings}`);
    assert.ok(deniedWarnings.includes(`rebuild and relink: ${rebuild} && ${relink}`), `warning must carry the canonical rebuild-and-relink action, got: ${deniedWarnings}`);

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
    const rebuild = expectedRebuild(canonical);
    const relink = expectedRelink(canonical);
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
    const relink = expectedRelink(canonical);
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

// 14-15. B-e256 cross-host review B-e256-xhr-r7 MAJOR: a DRIFTED realpath
//    (global points at a `.worktrees/` checkout) whose old bin target is ALSO
//    non-executable (14) or missing (15) — the motivating stale-worktree-plus-
//    rebuilt-0644 scenario — reports both facts but the canonical `npm link`
//    is the SOLE actionable remediation. No chmod/rebuild against the obsolete
//    checkout is appended, so the remediation never reads
//    `relink && chmod/rebuild <old path>`.
if (isWindowsHost) {
  console.log('SKIP global-core-realpath case 14: POSIX chmod remediation is not applicable on Windows; Windows command-shim behavior is covered below');
} else {
  const base = mkdtempSync(join(tmpdir(), 'gcr-drift-nonexec-'));
  try {
    const worktreeDir = join(base, 'repo', '.worktrees', 'B-test');
    const { repo, worktree } = makeRepoWithWorktree(base, { worktreeDir });
    const globalRoot = makeGlobalRootLinkedTo(base, join(worktree, 'packages', 'main'));
    const oldBin = realpathSync(join(worktree, 'packages', 'main', 'dist', 'cli.js'));
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const relink = expectedRelink(canonical);
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot, { executableAccessProbe: () => false });
    const actual = report.globalCoreRealpath.actual;
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'drift + non-executable old target must never pass');
    assert.equal(actual.worktreeCheckout, true);
    assert.equal(actual.executable, false, 'the old target fact is still reported');
    assert.equal(actual.binMode, '0755');
    assert.equal(actual.binTarget, oldBin);
    assert.equal(actual.remediation, relink, 'relink is the SOLE remediation; nothing is appended for the obsolete path');
    assert.doesNotMatch(actual.remediation, /&&\s*(chmod|npm --prefix)/, 'no chmod/rebuild chained after the relink');
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.match(warnings, /resolves to/, 'the drift is named');
    assert.ok(warnings.includes(`global bin target ${oldBin} is not executable by the current user (mode 0755; reported for the obsolete target only; the repoint above is the fix)`), `the old mode is reported as an obsolete-target fact, got: ${warnings}`);
    assert.doesNotMatch(warnings, /chmod \+x/, 'no chmod command is offered for the obsolete target');
    assert.equal(warnings.split(relink).length - 1, 1, 'the relink command appears exactly once');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

{
  const base = mkdtempSync(join(tmpdir(), 'gcr-drift-absent-bin-'));
  try {
    const worktreeDir = join(base, 'repo', '.worktrees', 'B-test');
    const { repo, worktree } = makeRepoWithWorktree(base, { worktreeDir, binTarget: 'absent' });
    const globalRoot = makeGlobalRootLinkedTo(base, join(worktree, 'packages', 'main'));
    const oldRealpath = realpathSync(join(worktree, 'packages', 'main'));
    const oldBin = join(oldRealpath, 'dist', 'cli.js');
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const relink = expectedRelink(canonical);
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    const actual = report.globalCoreRealpath.actual;
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'drift + missing old target must never pass');
    assert.equal(actual.worktreeCheckout, true);
    assert.equal(actual.executable, false);
    assert.equal(actual.binMode, null);
    assert.equal(actual.binTarget, oldBin);
    assert.equal(actual.remediation, relink, 'relink is the SOLE remediation; no rebuild of the obsolete checkout');
    assert.doesNotMatch(actual.remediation, /&&\s*(chmod|npm --prefix)/, 'no chmod/rebuild chained after the relink');
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.match(warnings, /resolves to/, 'the drift is named');
    assert.ok(warnings.includes(`global bin target ${oldBin} does not exist (reported for the obsolete target only; the repoint above is the fix)`), `the missing target is reported as an obsolete-target fact, got: ${warnings}`);
    assert.doesNotMatch(warnings, /npm --prefix/, 'no rebuild command is offered for the obsolete target');
    assert.doesNotMatch(warnings, /chmod \+x/);
    assert.equal(warnings.split(relink).length - 1, 1, 'the relink command appears exactly once');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 16. B-e256-xhr-r7 regression guard: the CANONICAL-path cases keep their
//    single chmod / rebuild remediation (no relink is chained in front).
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-canonical-single-remediation-'));
  try {
    if (!canEnforcePosixPermissions) {
      console.log(`SKIP global-core-realpath case 16a: POSIX chmod fixture is not enforceable on ${isWindowsHost ? 'Windows' : 'uid 0'}`);
    } else {
      const { repo, worktree } = makeRepoWithWorktree(join(base, 'chmod'), { binMode: 0o644 });
      const canonical = realpathSync(join(repo, 'packages', 'main'));
      const globalRoot = makeGlobalRootLinkedTo(join(base, 'chmod'), canonical);
      const chmodReport = runChecks(join(base, 'chmod'), join(worktree, 'packages', 'main'), globalRoot);
      assert.equal(chmodReport.globalCoreRealpath.actual.remediation, `chmod +x ${join(canonical, 'dist', 'cli.js')}`, 'canonical non-executable target keeps the single chmod remediation');
      assert.doesNotMatch(chmodReport.globalCoreRealpath.actual.remediation, /&&/, 'exactly one command');
    }

    const absent = makeRepoWithWorktree(join(base, 'rebuild'), { binTarget: 'absent' });
    const canonicalAbsent = realpathSync(join(absent.repo, 'packages', 'main'));
    const globalRootAbsent = makeGlobalRootLinkedTo(join(base, 'rebuild'), canonicalAbsent);
    const rebuildReport = runChecks(join(base, 'rebuild'), join(absent.worktree, 'packages', 'main'), globalRootAbsent);
    assert.equal(rebuildReport.globalCoreRealpath.actual.remediation, expectedRebuild(canonicalAbsent), 'canonical missing target keeps the single rebuild remediation');
    assert.doesNotMatch(rebuildReport.globalCoreRealpath.actual.remediation, /&&/, 'exactly one command');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 17. B-e256-xhr-r11 MAJOR (a): the global scoped package entry is a symlink
//    whose target checkout was REMOVED (the exact failure this story targets:
//    a globally linked worktree that no longer exists). `existsSync` follows
//    the link and reports false, which used to render the row as a PASS with
//    installed=false. The entry is present but unresolvable: drift naming the
//    broken target and the canonical relink.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-dangling-link-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base);
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const relink = expectedRelink(canonical);
    const removed = join(base, 'removed-core');
    writeCorePackage(removed);
    const globalRoot = makeGlobalRootLinkedTo(base, removed);
    // the link stays; only its target goes away
    rmSync(removed, { recursive: true, force: true });
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    const actual = report.globalCoreRealpath.actual;
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'a broken global link must never pass');
    assert.equal(actual.presence, 'dangling', 'the entry is present but unresolvable, not absent');
    assert.equal(actual.installed, true, 'a broken link is a broken INSTALL, never installed=false');
    assert.equal(actual.realpath, null, 'a broken link has no realpath');
    assert.equal(actual.linkTarget, removed, 'the broken link target is reported');
    assert.equal(actual.packagePath, join(globalRoot, '@proof-or-stop', 'core'));
    assert.equal(actual.remediation, relink, 'the relink is the remediation for a broken link');
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(warnings.includes(`is a broken link -> ${removed}`), `warning must name the broken link target, got: ${warnings}`);
    assert.ok(warnings.includes(relink), `warning must carry the exact relink command, got: ${warnings}`);
    assert.doesNotMatch(warnings, /not installed/, 'a broken link is not an absent install');

    // a broken link INTO a `.worktrees/` checkout also names that condition
    const wtBase = mkdtempSync(join(tmpdir(), 'gcr-dangling-worktree-'));
    try {
      const worktreeDir = join(wtBase, 'repo', '.worktrees', 'B-test');
      const wt = makeRepoWithWorktree(wtBase, { worktreeDir });
      const linkedWorktreeCore = realpathSync(join(wt.worktree, 'packages', 'main'));
      const wtGlobalRoot = makeGlobalRootLinkedTo(wtBase, linkedWorktreeCore);
      rmSync(join(wtBase, 'repo', '.worktrees'), { recursive: true, force: true });
      const wtReport = runChecks(wtBase, join(wt.repo, 'packages', 'main'), wtGlobalRoot);
      const wtActual = wtReport.globalCoreRealpath.actual;
      assert.notEqual(wtReport.globalCoreRealpath.status, 'pass');
      assert.equal(wtActual.presence, 'dangling');
      assert.equal(wtActual.worktreeCheckout, true, 'the removed target was a .worktrees/ checkout');
      assert.match((wtReport.globalCoreRealpath.warnings ?? []).join('\n'), /\.worktrees\//, 'the worktree condition is named');
    } finally {
      rmSync(wtBase, { recursive: true, force: true });
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 18. B-e256-xhr-r11 MAJOR (b) regression guard: when the execute bits really
//    ARE clear, `chmod +x` remains the plausible repair and must still be
//    offered - the mode-aware branch only diverts the bits-set case.
if (isWindowsHost) {
  console.log('SKIP global-core-realpath case 18: POSIX chmod remediation is not applicable on Windows; Windows command-shim behavior is covered below');
} else {
  const base = mkdtempSync(join(tmpdir(), 'gcr-noexec-bits-chmod-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base, { binMode: 0o644 });
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const expectedBin = realpathSync(join(repo, 'packages', 'main', 'dist', 'cli.js'));
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot, { executableAccessProbe: () => false });
    const actual = report.globalCoreRealpath.actual;
    assert.notEqual(report.globalCoreRealpath.status, 'pass');
    assert.equal(actual.binMode, '0644');
    assert.equal(actual.executable, false);
    assert.equal(actual.remediation, `chmod +x ${expectedBin}`, 'bits clear + denied is exactly the case chmod repairs');
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(warnings.includes(`global bin target ${expectedBin} is not executable by the current user (mode 0644); fix: chmod +x ${expectedBin}`), `got: ${warnings}`);
    assert.doesNotMatch(warnings, /marked executable/, 'the bits are clear, so the ownership/ACL diagnostic must not fire');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 19. B-e256-xhr-r12 MAJOR (a): the presence probe itself FAILS with an errno
//    that is NOT ENOENT/ENOTDIR (here EACCES: the scope directory is mode 0).
//    Nothing was observed about the installation, so the row must be
//    unverifiable drift naming the errno - never the green "not installed"
//    informational pass the old catch-all produced.
if (!canEnforcePosixPermissions) {
  console.log(`SKIP global-core-realpath case 19: mode-000 EACCES fixture is not enforceable on ${isWindowsHost ? 'Windows' : 'uid 0'}`);
} else {
  const base = mkdtempSync(join(tmpdir(), 'gcr-probe-eacces-'));
  const scope = join(base, 'global', 'node_modules', '@proof-or-stop');
  try {
    const { repo, worktree } = makeRepoWithWorktree(base);
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const relink = expectedRelink(canonical);
    const globalRoot = join(base, 'global', 'node_modules');
    writeCorePackage(join(scope, 'core'));
    const packagePath = join(scope, 'core');
    chmodSync(scope, 0o000);
    // root ignores the mode bits, so the denial cannot be built there; assert
    // the fixture really denies before trusting it.
    let denied = true;
    try { lstatSync(packagePath); denied = false; } catch { denied = true; }
    assert.ok(denied, 'the EACCES fixture must actually deny the lookup (do not run this suite as root)');
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    const actual = report.globalCoreRealpath.actual;
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'a probe that could not look must never pass');
    assert.equal(actual.presence, 'unreadable', 'a refused probe is unreadable, not absent');
    assert.notEqual(actual.installed, false, 'nothing was observed, so installed=false is a claim the probe cannot make');
    assert.equal(actual.installed, null, 'installed is UNKNOWN for a refused probe');
    assert.equal(actual.errorCode, 'EACCES', 'the errno is carried on the row');
    assert.equal(actual.packagePath, packagePath);
    assert.equal(actual.remediation, relink);
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(warnings.includes(`at ${packagePath} could not be probed [EACCES]`), `the warning must name the path and the errno, got: ${warnings}`);
    assert.match(warnings, /it is not known to be absent/, `the warning must refuse the absent claim, got: ${warnings}`);
    assert.ok(warnings.includes(relink), `the warning must carry the exact repoint command, got: ${warnings}`);
    assert.doesNotMatch(warnings, /not installed/, 'a refused probe is not an absent install');
    const row = globalCoreRow(report);
    assert.doesNotMatch(row, /not installed/, `the doctor row must never render a probe failure as "not installed", got: ${row}`);
    assert.ok(row.includes('[EACCES]'), `the doctor row must name the errno, got: ${row}`);
  } finally {
    try { chmodSync(scope, 0o755); } catch { /* fixture may not exist */ }
    rmSync(base, { recursive: true, force: true });
  }
}

// 20. B-e256-xhr-r12 MAJOR (a, second half): a candidate classified as RESOLVED
//    whose realpath resolution then fails. Every hermetic construction that
//    makes realpath(3) fail (unsearchable parent, removed target, symlink loop)
//    also makes the presence probe fail first, so it would be classified before
//    this branch is reached - hence the injectable `globalCoreRealpathProbe`
//    seam (same shape production fills with realpathSync + errno capture).
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-realpath-fail-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base);
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const relink = expectedRelink(canonical);
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const packagePath = join(globalRoot, '@proof-or-stop', 'core');
    const probed = [];
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot, {
      globalCoreRealpathProbe: (path) => { probed.push(path); return { realpath: null, errorCode: 'EIO' }; },
    });
    const actual = report.globalCoreRealpath.actual;
    assert.deepEqual(probed, [packagePath], 'the probe must be asked about exactly the global package path');
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'an installed package whose realpath will not resolve must never pass');
    assert.equal(actual.presence, 'resolved');
    assert.equal(actual.installed, true, 'the package entry resolved, so it IS installed');
    assert.equal(actual.realpath, null);
    assert.equal(actual.errorCode, 'EIO');
    assert.equal(actual.remediation, relink);
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(warnings.includes(`at ${packagePath} is installed but its realpath could not be resolved [EIO]`), `got: ${warnings}`);
    assert.match(warnings, /it is not known to be absent/);
    assert.doesNotMatch(warnings, /not installed/);
    const row = globalCoreRow(report);
    assert.doesNotMatch(row, /not installed/, `the doctor row must never render a realpath failure as "not installed", got: ${row}`);
    assert.ok(row.includes('[EIO]'), `got: ${row}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 21. B-e256-xhr-r12 regression guard: a GENUINELY absent install (ENOENT, and
//    the ENOTDIR variant where a file sits where the scope directory should be)
//    keeps today's informational pass unchanged. Only these two errnos mean
//    "nothing is installed here". (Case 6 covers the plain ENOENT row facts.)
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-absent-errnos-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base);
    const relink = expectedRelink(realpathSync(join(repo, 'packages', 'main')));

    const enoentRoot = join(base, 'enoent', 'node_modules');
    mkdirSync(enoentRoot, { recursive: true });
    const enoent = runChecks(join(base, 'enoent'), join(worktree, 'packages', 'main'), enoentRoot);
    assert.equal(enoent.globalCoreRealpath.status, 'pass', 'ENOENT stays the informational pass');
    assert.equal(enoent.globalCoreRealpath.warnings, undefined);
    assert.equal(enoent.globalCoreRealpath.actual.presence, 'absent');
    assert.equal(enoent.globalCoreRealpath.actual.installed, false);
    assert.equal(enoent.globalCoreRealpath.actual.errorCode, null);
    assert.ok((enoent.globalCoreRealpath.details ?? []).join('\n').includes(relink));
    assert.match(globalCoreRow(enoent), /not installed/, 'a genuinely absent install still reads as not installed');

    // ENOTDIR: a regular file where the `@proof-or-stop` scope directory belongs.
    const enotdirRoot = join(base, 'enotdir', 'node_modules');
    mkdirSync(enotdirRoot, { recursive: true });
    writeFileSync(join(enotdirRoot, '@proof-or-stop'), 'not a directory\n');
    const enotdir = runChecks(join(base, 'enotdir'), join(worktree, 'packages', 'main'), enotdirRoot);
    assert.equal(enotdir.globalCoreRealpath.status, 'pass', 'ENOTDIR is also genuinely absent');
    assert.equal(enotdir.globalCoreRealpath.warnings, undefined);
    assert.equal(enotdir.globalCoreRealpath.actual.presence, 'absent');
    assert.equal(enotdir.globalCoreRealpath.actual.installed, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 22. B-e256-xhr-r12 MAJOR (b): a canonical, executable global install whose
//    package.json declares NO usable version used to render version=unknown and
//    still pass. The version is a verified fact: missing (or whitespace-only)
//    is drift with the rebuild-and-relink remediation. The expectation falls
//    back to the running build's PROOF_OR_STOP_CLI_VERSION because the
//    canonical package.json this row compares against has no version either.
for (const [label, version] of [['missing', null], ['whitespace-only', '   ']]) {
  const base = mkdtempSync(join(tmpdir(), `gcr-version-${label.split('-')[0]}-`));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base, { version });
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const rebuild = expectedRebuild(canonical);
    const relink = expectedRelink(canonical);
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    const actual = report.globalCoreRealpath.actual;
    assert.notEqual(report.globalCoreRealpath.status, 'pass', `[${label}] a global install without a usable version must never pass`);
    assert.equal(actual.realpath, canonical, `[${label}] the install is otherwise canonical`);
    assert.equal(actual.executable, true, `[${label}] the install is otherwise executable`);
    assert.equal(actual.verification, 'ok', `[${label}] package.json itself is readable`);
    assert.equal(actual.version, null, `[${label}] a whitespace-only or absent version is no version`);
    assert.equal(actual.expectedVersion, PROOF_OR_STOP_CLI_VERSION, `[${label}] the expectation falls back to the running build's version`);
    assert.equal(actual.remediation, `${rebuild} && ${relink}`, `[${label}] a canonical install is rebuilt and relinked`);
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(warnings.includes(`at ${canonical} declares no version in ${join(canonical, 'package.json')}; expected ${PROOF_OR_STOP_CLI_VERSION}`), `[${label}] the warning must name the file and the expectation, got: ${warnings}`);
    assert.ok(warnings.includes(`rebuild and relink: ${rebuild} && ${relink}`), `[${label}] the warning must carry the remediation, got: ${warnings}`);
    assert.doesNotMatch(warnings, /resolves to/, `[${label}] the path itself is canonical`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 23. B-e256-xhr-r12 MAJOR (b, second half): the global version DIFFERS from
//    the canonical core package's. A mismatch is only constructible with a
//    drifted realpath - when the paths match both versions are read from the
//    same package.json, which is exactly why case 22 (missing version) is what
//    bites on the canonical path. The version fact is reported for the obsolete
//    target and the repoint stays the sole actionable remediation (xhr-r7).
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-version-mismatch-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base, { version: '0.0.0' });
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const relink = expectedRelink(canonical);
    const stale = join(base, 'stale-core');
    writeCorePackage(stale, { version: '9.9.9' });
    const globalRoot = makeGlobalRootLinkedTo(base, stale);
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    const actual = report.globalCoreRealpath.actual;
    assert.notEqual(report.globalCoreRealpath.status, 'pass');
    assert.equal(actual.version, '9.9.9');
    assert.equal(actual.expectedVersion, '0.0.0');
    assert.equal(actual.remediation, relink, 'a drifted realpath is repointed, never rebuilt in place');
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(warnings.includes(`reports version 9.9.9; expected 0.0.0 (reported for the obsolete target only; the repoint above is the fix)`), `the warning must name BOTH versions, got: ${warnings}`);
    assert.match(warnings, /resolves to/, 'the path drift is still named');
    assert.equal(warnings.split(relink).length - 1, 1, 'the relink command appears exactly once');
    assert.doesNotMatch(warnings, /npm --prefix/, 'no rebuild of the obsolete checkout');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 24. B-e256-xhr-r12 regression guard: a version that MATCHES the canonical
//    core package produces no version warning at all - on the canonical path
//    (clean pass) and on a drifted path (only the repoint is reported).
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-version-match-'));
  try {
    const worktreeDir = join(base, 'repo', '.worktrees', 'B-test');
    const { repo, worktree } = makeRepoWithWorktree(base, { worktreeDir, version: '1.2.3' });
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const globalRoot = makeGlobalRootLinkedTo(join(base, 'match'), join(repo, 'packages', 'main'));
    const matched = runChecks(join(base, 'match'), join(worktree, 'packages', 'main'), globalRoot);
    assert.equal(matched.globalCoreRealpath.status, 'pass', `a matching version must not warn, got: ${(matched.globalCoreRealpath.warnings ?? []).join(' | ')}`);
    assert.equal(matched.globalCoreRealpath.warnings, undefined);
    assert.equal(matched.globalCoreRealpath.actual.version, '1.2.3');
    assert.equal(matched.globalCoreRealpath.actual.expectedVersion, '1.2.3');
    if (!isWindowsHost) assert.ok(globalCoreRow(matched).includes(`${canonical} version=1.2.3 mode=0755 executable=yes`), `got: ${globalCoreRow(matched)}`);
    else assert.ok(globalCoreRow(matched).includes(`${canonical} version=1.2.3 mode=`) && globalCoreRow(matched).includes('executable=yes'), `got: ${globalCoreRow(matched)}`);

    // Drifted path, identical version (the worktree copy of the same commit):
    // the repoint is reported, the version is not.
    const driftRoot = makeGlobalRootLinkedTo(join(base, 'drift'), join(worktree, 'packages', 'main'));
    const drifted = runChecks(join(base, 'drift'), join(worktree, 'packages', 'main'), driftRoot);
    const driftWarnings = (drifted.globalCoreRealpath.warnings ?? []).join('\n');
    assert.notEqual(drifted.globalCoreRealpath.status, 'pass');
    assert.equal(drifted.globalCoreRealpath.actual.version, '1.2.3');
    assert.equal(drifted.globalCoreRealpath.actual.expectedVersion, '1.2.3');
    assert.match(driftWarnings, /resolves to/);
    assert.doesNotMatch(driftWarnings, /reports version|declares no version/, 'a matching version adds no warning');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 25. B-e256 cross-host review B-e256-xhr-r13 MAJOR (a): the `npm root -g`
//    probe COMMAND itself fails (npm missing / non-zero exit / timeout /
//    unparsable output) -> unverifiable drift naming the failure, never the
//    informational "not installed" pass a genuinely resolved-but-empty root
//    (case 6) or a genuinely absent package (case 21) get.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-npm-root-probe-fail-'));
  try {
    const { worktree } = makeRepoWithWorktree(base);
    const report = runChecks(base, join(worktree, 'packages', 'main'), null, {
      globalNpmRootProbeResolver: () => ({ root: null, failureReason: 'npm root -g exited with code 1' }),
    });
    const actual = report.globalCoreRealpath.actual;
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'an npm root -g probe failure must never pass silently');
    assert.equal(actual.installed, null, 'nothing was observed, so installed is UNKNOWN, never false');
    assert.equal(actual.presence, 'npm-root-probe-failed');
    assert.equal(actual.realpath, null);
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(warnings.includes('npm root -g exited with code 1'), `the warning must name the exact probe failure, got: ${warnings}`);
    assert.match(warnings, /could not be inspected - it is not known to be absent/, `got: ${warnings}`);
    assert.doesNotMatch(warnings, /not installed/, 'a probe failure is not an absent install');
    assert.ok(typeof actual.remediation === 'string' && actual.remediation.length > 0, 'the row must name an actionable next step');
    const row = globalCoreRow(report);
    assert.doesNotMatch(row, /not installed/, `the doctor row must never render a probe failure as "not installed", got: ${row}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 26. B-e256 cross-host review B-e256-xhr-r13 MAJOR (b): a SUCCESSFUL
//    structured `npm root -g` probe (no failureReason) whose scoped package
//    entry does not exist (ENOENT) stays the informational pass - a resolved
//    root is not itself a failure signal, even via the new structured seam.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-npm-root-probe-ok-absent-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base);
    const emptyGlobalRoot = join(base, 'global', 'node_modules');
    mkdirSync(emptyGlobalRoot, { recursive: true });
    const report = runChecks(base, join(worktree, 'packages', 'main'), null, {
      globalNpmRootProbeResolver: () => ({ root: emptyGlobalRoot, failureReason: null }),
    });
    const actual = report.globalCoreRealpath.actual;
    const relink = expectedRelink(realpathSync(join(repo, 'packages', 'main')));
    assert.equal(report.globalCoreRealpath.status, 'pass', 'a resolved root with nothing installed under it is informational, not a warning');
    assert.equal(actual.installed, false);
    assert.equal(actual.presence, 'absent');
    assert.equal(actual.remediation, relink);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 27. B-e256 cross-host review B-e256-xhr-r13 MAJOR (c): package.json was
//    bumped but `dist/` was never rebuilt (the exact silently-non-landing
//    rebuild this story targets) - comparing the manifest to itself sees NO
//    drift (this is the blind spot the finding names), but the compiled
//    runtime's own reported version is stale drift naming BOTH versions, with
//    the rebuild-and-relink remediation.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-stale-compiled-version-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base, { version: '2.0.0', compiledVersion: '1.9.0' });
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const relink = expectedRelink(canonical);
    const rebuild = expectedRebuild(canonical);
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    const actual = report.globalCoreRealpath.actual;
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'a stale compiled runtime must never pass, even when package.json matches its own expectation');
    assert.equal(actual.version, '2.0.0', 'the manifest itself was bumped and reads correctly');
    assert.equal(actual.expectedVersion, '2.0.0', 'the manifest-only comparison alone sees no drift here - exactly the blind spot the fix closes');
    assert.equal(actual.compiledVersion, '1.9.0', 'the never-rebuilt compiled runtime is reported as its own fact');
    assert.equal(actual.remediation, `${rebuild} && ${relink}`, 'a stale compiled runtime on the canonical path is rebuilt and relinked');
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(warnings.includes('compiled runtime reports version 1.9.0; expected 2.0.0'), `the warning must name BOTH the compiled and expected version, got: ${warnings}`);
    assert.ok(warnings.includes(`rebuild and relink: ${rebuild} && ${relink}`), `got: ${warnings}`);
    assert.doesNotMatch(warnings, /resolves to/, 'the realpath itself is canonical; only the compiled runtime is stale');
    const row = globalCoreRow(report);
    assert.ok(row.includes('version=1.9.0'), `the compact row must render the compiled runtime version, got: ${row}`);
    assert.ok(!row.includes('version=2.0.0'), `the compact row must not substitute the manifest version for the running artifact, got: ${row}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 28. B-e256 cross-host review B-e256-xhr-r13 MAJOR (d) regression guard: a
//    compiled runtime version that MATCHES the expected version adds no
//    warning, even though the manifest and the compiled artifact are two
//    independent files read independently.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-compiled-version-match-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base, { version: '3.1.4', compiledVersion: '3.1.4' });
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    assert.equal(report.globalCoreRealpath.status, 'pass', `a matching compiled version must not warn, got: ${(report.globalCoreRealpath.warnings ?? []).join(' | ')}`);
    assert.equal(report.globalCoreRealpath.actual.compiledVersion, '3.1.4');
    assert.equal(report.globalCoreRealpath.warnings, undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 29. B-e256 cross-host review B-e256-xhr-r13 MAJOR (e): the compiled-version
//    PROBE itself failing or timing out is unverifiable drift with a
//    rebuild-and-relink remediation, never a pass.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-compiled-version-probe-fail-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base);
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const relink = expectedRelink(canonical);
    const rebuild = expectedRebuild(canonical);
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot, {
      compiledCoreVersionProbe: () => ({ version: null, failureReason: 'compiled runtime version probe timed out after 5000ms' }),
    });
    const actual = report.globalCoreRealpath.actual;
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'a compiled-version probe failure/timeout must never pass');
    assert.equal(actual.compiledVersion, null);
    assert.equal(actual.remediation, `${rebuild} && ${relink}`);
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(warnings.includes('compiled runtime version could not be verified: compiled runtime version probe timed out after 5000ms'), `got: ${warnings}`);
    assert.ok(warnings.includes(`rebuild and relink: ${rebuild} && ${relink}`), `got: ${warnings}`);
    const row = globalCoreRow(report);
    assert.ok(row.includes('version=unknown'), `a failed compiled-version probe must render unknown, got: ${row}`);
    assert.ok(!row.includes('version=0.0.0'), `the compact row must not substitute the manifest version after probe failure, got: ${row}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 30. B-e256 F-004: the DEFAULT (real, non-stubbed) compiled-version probe's
//    own readFileSync catch branch — an unbuilt/missing
//    dist/core/proof-or-stop-brand.js — is unverifiable drift, never a pass.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-default-probe-missing-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base, { compiledVersion: null });
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const relink = expectedRelink(canonical);
    const rebuild = expectedRebuild(canonical);
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    const actual = report.globalCoreRealpath.actual;
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'a missing compiled brand file must never pass');
    assert.equal(actual.compiledVersion, null);
    assert.equal(actual.remediation, `${rebuild} && ${relink}`);
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(warnings.includes('compiled runtime version could not be verified'), `got: ${warnings}`);
    assert.ok(warnings.includes('could not be read'), `must name the read failure, got: ${warnings}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 31. B-e256 F-004: the DEFAULT probe against a readable but malformed brand
//    file (no PROOF_OR_STOP_CLI_VERSION declaration at all) is unverifiable
//    drift, never a pass.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-default-probe-no-declaration-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base, { compiledVersion: null });
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const relink = expectedRelink(canonical);
    const rebuild = expectedRebuild(canonical);
    writeFileSync(join(repo, 'packages', 'main', 'dist', 'core', 'proof-or-stop-brand.js'), 'export const SOMETHING_ELSE = \'1.2.3\';\n');
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    const actual = report.globalCoreRealpath.actual;
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'a brand file with no declaration must never pass');
    assert.equal(actual.compiledVersion, null);
    assert.equal(actual.remediation, `${rebuild} && ${relink}`);
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(warnings.includes('compiled runtime version could not be verified'), `got: ${warnings}`);
    assert.ok(warnings.includes('no exported PROOF_OR_STOP_CLI_VERSION constant'), `must name the parse failure, got: ${warnings}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 32. B-e256 F-004: the DEFAULT probe against a brand file with TWO real
//    (uncommented) declarations must refuse as ambiguous rather than silently
//    picking either one — never a pass, never a silently-wrong version.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-default-probe-two-declarations-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base, { compiledVersion: null });
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const relink = expectedRelink(canonical);
    const rebuild = expectedRebuild(canonical);
    writeFileSync(
      join(repo, 'packages', 'main', 'dist', 'core', 'proof-or-stop-brand.js'),
      'export const PROOF_OR_STOP_CLI_VERSION = \'1.0.0\';\nexport const PROOF_OR_STOP_CLI_VERSION = \'2.0.0\';\n',
    );
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    const actual = report.globalCoreRealpath.actual;
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'a brand file with two declarations must never pass');
    assert.equal(actual.compiledVersion, null);
    assert.equal(actual.remediation, `${rebuild} && ${relink}`);
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(warnings.includes('compiled runtime version could not be verified'), `got: ${warnings}`);
    assert.ok(/2 exported PROOF_OR_STOP_CLI_VERSION declarations/.test(warnings), `must name the ambiguity, got: ${warnings}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 33. B-e256 F-004: mirrors version-bump.ts's raw-vs-stripped ambiguity guard
//    (the sibling BRAND_EXPORT_RE this probe reuses via findBrandExport) — a
//    brand file whose ONLY extra occurrence of an export-shaped line sits
//    inside a comment must be REFUSED as ambiguous, exactly like
//    version-bump.ts refuses to bump such a file, never silently resolved to
//    the one real declaration.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-default-probe-comment-occurrence-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base, { compiledVersion: null });
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const relink = expectedRelink(canonical);
    const rebuild = expectedRebuild(canonical);
    writeFileSync(
      join(repo, 'packages', 'main', 'dist', 'core', 'proof-or-stop-brand.js'),
      '/*\nexport const PROOF_OR_STOP_CLI_VERSION = \'9.9.9\';\n*/\nexport const PROOF_OR_STOP_CLI_VERSION = \'3.1.4\';\n',
    );
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot);
    const actual = report.globalCoreRealpath.actual;
    assert.notEqual(report.globalCoreRealpath.status, 'pass', 'an export-shaped line hiding in a comment must be refused, never silently resolved to the real declaration');
    assert.equal(actual.compiledVersion, null, 'never silently reports the real 3.1.4 declaration while an ambiguous comment occurrence is present');
    assert.equal(actual.remediation, `${rebuild} && ${relink}`);
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.ok(warnings.includes('compiled runtime version could not be verified'), `got: ${warnings}`);
    assert.ok(warnings.includes('export-shaped line in a comment as well as the real export'), `must name the raw-vs-stripped ambiguity, got: ${warnings}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 32. A successful npm process whose stdout is not one absolute path is a
//     failed production probe, not a known-empty global installation.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-invalid-npm-root-output-'));
  const originalPath = process.env.PATH;
  try {
    const { worktree } = makeRepoWithWorktree(base);
    const fakeBin = join(base, 'fake-bin');
    mkdirSync(fakeBin, { recursive: true });
    const fakeNpm = join(fakeBin, 'npm');
    writeFileSync(fakeNpm, '#!/bin/sh\nprintf "root -g\\n"\n');
    chmodSync(fakeNpm, 0o755);
    process.env.PATH = fakeBin;
    const projectRoot = join(base, 'fixture-project');
    mkdirSync(projectRoot, { recursive: true });
    const report = runRuntimeEnvironmentChecks(projectRoot, {
      commandResolver: () => join(base, 'fake-proof-or-stop'),
      corePackageRoot: join(worktree, 'packages', 'main'),
    });
    const actual = report.globalCoreRealpath.actual;
    assert.notEqual(report.globalCoreRealpath.status, 'pass');
    assert.equal(actual.presence, 'npm-root-probe-failed');
    assert.equal(actual.installed, null);
    assert.match((report.globalCoreRealpath.warnings ?? []).join('\n'), /invalid path output.*root -g/);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(base, { recursive: true, force: true });
  }
}

// 33. A non-absence stat failure preserves its errno and reports the bin state
//     as unknown; it must not prescribe a rebuild for a target it never saw.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-bin-stat-denied-'));
  try {
    const { repo, worktree } = makeRepoWithWorktree(base);
    const globalRoot = makeGlobalRootLinkedTo(base, join(repo, 'packages', 'main'));
    const report = runChecks(base, join(worktree, 'packages', 'main'), globalRoot, {
      binTargetStatProbe: () => {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      },
    });
    const actual = report.globalCoreRealpath.actual;
    assert.notEqual(report.globalCoreRealpath.status, 'pass');
    assert.equal(actual.verification, 'bin-target-stat-failed');
    assert.equal(actual.verificationErrorCode, 'EACCES');
    assert.equal(actual.binTargetExists, null);
    assert.equal(actual.executable, null);
    const warnings = (report.globalCoreRealpath.warnings ?? []).join('\n');
    assert.match(warnings, /could not be inspected \[EACCES\]/);
    assert.doesNotMatch(warnings, /does not exist|rebuild:/);
    assert.match(globalCoreRow(report), /unverifiable=bin-target-stat-failed error=EACCES/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 34. F-026/F-028: exact Windows semantics and cmd.exe remediation rendering,
// exercised on every host through the explicit platform seam.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-win32-contract-'));
  try {
    const fixtureBase = join(base, 'Windows Fixture');
    const { repo, worktree } = makeRepoWithWorktree(fixtureBase, { binMode: 0o644 });
    const canonical = realpathSync(join(repo, 'packages', 'main'));
    const expectedBin = realpathSync(join(canonical, 'dist', 'cli.js'));
    const globalRoot = makeGlobalRootLinkedTo(fixtureBase, canonical);
    const relink = expectedRelink(canonical, 'win32');

    const shimPass = runChecks(join(fixtureBase, 'shim-pass'), join(worktree, 'packages', 'main'), globalRoot, { platform: 'win32' });
    assert.equal(shimPass.globalCoreRealpath.status, 'pass', 'Windows npm-shim semantics must not reject a POSIX-0644-shaped target');
    assert.equal(shimPass.globalCoreRealpath.actual.executable, true);
    assert.equal(shimPass.globalCoreRealpath.actual.remediation, null);
    assert.doesNotMatch((shimPass.globalCoreRealpath.warnings ?? []).join('\n'), /chmod \+x|cd --|ls -ld/);

    const driftBase = join(base, 'Windows Drift Fixture');
    const worktreeDir = join(driftBase, 'repo', '.worktrees', 'B-test');
    const drift = makeRepoWithWorktree(driftBase, { worktreeDir });
    const driftCanonical = realpathSync(join(drift.repo, 'packages', 'main'));
    const driftGlobalRoot = makeGlobalRootLinkedTo(driftBase, join(drift.worktree, 'packages', 'main'));
    const driftRelink = expectedRelink(driftCanonical, 'win32');
    const driftReport = runChecks(driftBase, join(drift.worktree, 'packages', 'main'), driftGlobalRoot, { platform: 'win32' });
    assert.equal(driftReport.globalCoreRealpath.actual.remediation, driftRelink);
    assert.ok((driftReport.globalCoreRealpath.warnings ?? []).join('\n').includes(`repoint: ${driftRelink}`));

    const absentBase = join(base, 'Windows Missing Target');
    const absent = makeRepoWithWorktree(absentBase, { binTarget: 'absent' });
    const absentCanonical = realpathSync(join(absent.repo, 'packages', 'main'));
    const absentGlobalRoot = makeGlobalRootLinkedTo(absentBase, absentCanonical);
    const rebuild = expectedRebuild(absentCanonical, 'win32');
    const absentReport = runChecks(absentBase, join(absent.worktree, 'packages', 'main'), absentGlobalRoot, { platform: 'win32' });
    assert.equal(absentReport.globalCoreRealpath.actual.remediation, rebuild);
    assert.ok((absentReport.globalCoreRealpath.warnings ?? []).join('\n').includes(`rebuild: ${rebuild}`));

    const statDenied = runChecks(join(fixtureBase, 'stat-denied'), join(worktree, 'packages', 'main'), globalRoot, {
      platform: 'win32',
      binTargetStatProbe: () => {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      },
    });
    const inspectTarget = expectedInspect(expectedBin, 'win32');
    assert.equal(statDenied.globalCoreRealpath.actual.remediation, inspectTarget);
    assert.ok((statDenied.globalCoreRealpath.warnings ?? []).join('\n').includes(`inspect filesystem access: ${inspectTarget}`));

    const packagePath = join(globalRoot, '@proof-or-stop', 'core');
    const realpathDenied = runChecks(join(fixtureBase, 'realpath-denied'), join(worktree, 'packages', 'main'), globalRoot, {
      platform: 'win32',
      globalCoreRealpathProbe: () => ({ realpath: null, errorCode: 'EIO' }),
    });
    const inspectPackage = expectedInspect(packagePath, 'win32');
    assert.ok((realpathDenied.globalCoreRealpath.warnings ?? []).join('\n').includes(`inspect then repoint: ${inspectPackage} && ${relink}`));
    assert.equal(realpathDenied.globalCoreRealpath.actual.remediation, relink);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 35. F-034: the declared bin target's resolved path must remain inside the
// canonical package dist tree. Cover a final-link escape, an intermediate-link
// escape, and errno preservation for an unresolvable target.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-bin-realpath-escape-'));
  try {
    const finalFixture = makeRepoWithWorktree(join(base, 'final'));
    const finalCore = join(finalFixture.repo, 'packages', 'main');
    const finalGlobalRoot = makeGlobalRootLinkedTo(join(base, 'final'), finalCore);
    const finalTarget = join(finalCore, 'dist', 'cli.js');
    const outsideFinal = join(base, 'outside-final.js');
    writeFileSync(outsideFinal, '#!/usr/bin/env node\n');
    chmodSync(outsideFinal, 0o755);
    let finalOptions = {};
    if (isWindowsHost) {
      // The production path is realpathSync; this seam avoids requiring the
      // separate Windows file-symlink privilege after the junction probe passed.
      finalOptions = { binTargetRealpathProbe: () => ({ realpath: outsideFinal, errorCode: null }) };
    } else {
      rmSync(finalTarget, { force: true });
      symlinkSync(outsideFinal, finalTarget, 'file');
    }
    const finalReport = runChecks(join(base, 'final'), join(finalFixture.worktree, 'packages', 'main'), finalGlobalRoot, finalOptions);
    assert.notEqual(finalReport.globalCoreRealpath.status, 'pass');
    assert.equal(finalReport.globalCoreRealpath.actual.verification, 'bin-target-realpath-escape');
    assert.equal(finalReport.globalCoreRealpath.actual.binTargetRealpath, realpathSync(outsideFinal));
    assert.match((finalReport.globalCoreRealpath.warnings ?? []).join('\n'), /resolves outside the package dist tree/);

    const intermediateFixture = makeRepoWithWorktree(join(base, 'intermediate'), { binTarget: 'absent', binRel: 'dist/linked/cli.js' });
    const intermediateCore = join(intermediateFixture.repo, 'packages', 'main');
    const outsideDir = join(base, 'outside-dir');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'cli.js'), '#!/usr/bin/env node\n');
    chmodSync(join(outsideDir, 'cli.js'), 0o755);
    symlinkSync(outsideDir, join(intermediateCore, 'dist', 'linked'), isWindowsHost ? 'junction' : 'dir');
    const intermediateGlobalRoot = makeGlobalRootLinkedTo(join(base, 'intermediate'), intermediateCore);
    const intermediateReport = runChecks(join(base, 'intermediate'), join(intermediateFixture.worktree, 'packages', 'main'), intermediateGlobalRoot);
    assert.notEqual(intermediateReport.globalCoreRealpath.status, 'pass');
    assert.equal(intermediateReport.globalCoreRealpath.actual.verification, 'bin-target-realpath-escape');
    assert.equal(intermediateReport.globalCoreRealpath.actual.binTargetRealpath, realpathSync(join(outsideDir, 'cli.js')));

    const errnoFixture = makeRepoWithWorktree(join(base, 'errno'));
    const errnoCore = join(errnoFixture.repo, 'packages', 'main');
    const errnoGlobalRoot = makeGlobalRootLinkedTo(join(base, 'errno'), errnoCore);
    const errnoReport = runChecks(join(base, 'errno'), join(errnoFixture.worktree, 'packages', 'main'), errnoGlobalRoot, {
      binTargetRealpathProbe: () => ({ realpath: null, errorCode: 'EIO' }),
    });
    assert.notEqual(errnoReport.globalCoreRealpath.status, 'pass');
    assert.equal(errnoReport.globalCoreRealpath.actual.verification, 'bin-target-realpath-failed');
    assert.equal(errnoReport.globalCoreRealpath.actual.verificationErrorCode, 'EIO');
    assert.match((errnoReport.globalCoreRealpath.warnings ?? []).join('\n'), /bin-target-realpath-failed.*\[EIO\]/);
    executedAssertionGroups += 3;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 36. F-042: if git topology discovery fails from a disposable Story
// worktree, that worktree may not become the fallback canonical global target.
{
  const base = mkdtempSync(join(tmpdir(), 'gcr-canonical-main-probe-failure-'));
  const originalPath = process.env.PATH;
  const originalPathMixed = process.env.Path;
  try {
    const worktreeDir = join(base, 'repo', '.worktrees', 'B-probe-failure');
    const { worktree } = makeRepoWithWorktree(base, { worktreeDir });
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'proof-or-stop' }) + '\n');
    const worktreeCore = join(worktree, 'packages', 'main');
    const globalRoot = makeGlobalRootLinkedTo(base, worktreeCore);
    const emptyPath = join(base, 'empty-path');
    mkdirSync(emptyPath, { recursive: true });
    const command = join(base, process.platform === 'win32' ? 'proof-or-stop.cmd' : 'proof-or-stop');
    if (process.platform === 'win32') writeRepresentativeWindowsShim(command, globalRoot);
    else symlinkSync(join(globalRoot, '@proof-or-stop', 'core', 'dist', 'cli.js'), command, 'file');
    process.env.PATH = emptyPath; // the production git topology probe now fails with ENOENT
    process.env.Path = emptyPath;

    const report = runRuntimeEnvironmentChecks(worktree, {
      commandResolver: () => command,
      globalNpmRootResolver: () => globalRoot,
      corePackageRoot: worktreeCore,
    });
    assert.notEqual(report.globalCoreRealpath.status, 'pass');
    assert.equal(report.globalCoreRealpath.expected, null, 'failed topology discovery must remain unknown, not fall back to the Story worktree');
    assert.equal(report.globalCoreRealpath.actual.worktreeCheckout, true);
    assert.equal(report.globalCoreRealpath.actual.remediation, 'git worktree list --porcelain');
    assert.match((report.globalCoreRealpath.warnings ?? []).join('\n'), /canonical main worktree could not be discovered/);
    assert.match((report.globalCoreRealpath.warnings ?? []).join('\n'), /inside a `.worktrees\/` checkout/);
    assert.doesNotMatch(renderRuntimeEnvironmentReport(report), /contract: global-core-realpath-pass/);
    executedAssertionGroups += 1;
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalPathMixed === undefined) delete process.env.Path; else process.env.Path = originalPathMixed;
    rmSync(base, { recursive: true, force: true });
  }
}

console.log(globalCoreCompletionMarker(true, executedAssertionGroups));
