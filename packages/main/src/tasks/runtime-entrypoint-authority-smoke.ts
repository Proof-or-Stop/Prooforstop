#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyRuntimeEntrypointAuthority,
  renderLocalEntrypointRecoveryCommand,
  renderRuntimeEntrypointAuthorityFailure,
} from '../core/runtime-environment-checks.js';

const tmp = mkdtempSync(join(tmpdir(), 'proof-or-stop-runtime-entrypoint-authority-'));
const compiledMainRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceRepoRoot = resolve(compiledMainRoot, '..', '..', '..');
const sourceNodeModules = [
  join(sourceRepoRoot, 'node_modules'),
  resolve(sourceRepoRoot, '..', '..', 'node_modules'),
].find((candidate) => existsSync(candidate));

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeSelfProject(root: string): void {
  mkdirSync(join(root, 'packages', 'main'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'proof-or-stop', version: '1.0.0', type: 'module' }));
  writeFileSync(join(root, 'packages', 'main', 'package.json'), JSON.stringify({ name: '@proof-or-stop/core', version: '1.0.0', type: 'module' }));
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    hooks: {
      preCommand: {
        validate: ['node -e "require(\'fs\').writeFileSync(\'hook-ran\', \'bad\')"'],
      },
    },
    validate: {
      commands: [{ command: 'node', args: ['-e', "require('fs').writeFileSync('validation-ran', 'bad')"] }],
    },
  }));
  cpSync(join(sourceRepoRoot, 'bin'), join(root, 'bin'), { recursive: true, force: true });
  cpSync(compiledMainRoot, join(root, 'packages', 'main', 'dist'), { recursive: true });
  writeFileSync(join(root, 'packages', 'main', 'dist', 'runtime-generation.txt'), 'main-old');
  mkdirSync(join(root, 'packages', 'utils'), { recursive: true });
  writeFileSync(join(root, 'packages', 'utils', 'package.json'), JSON.stringify({ name: '@proof-or-stop/utils', version: '1.0.0', type: 'module' }));
  cpSync(join(sourceRepoRoot, 'packages', 'utils', 'dist'), join(root, 'packages', 'utils', 'dist'), { recursive: true });
  assert.ok(sourceNodeModules, 'source node_modules required for hermetic copied runtime');
  symlinkSync(sourceNodeModules, join(root, 'node_modules'), 'dir');
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.name', 'Runtime Smoke']);
  git(root, ['config', 'user.email', 'runtime-smoke@example.test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
}

try {
  const mainRoot = join(tmp, 'main checkout');
  mkdirSync(mainRoot, { recursive: true });
  makeSelfProject(mainRoot);
  const worktreeRoot = join(tmp, 'story worktree');
  git(mainRoot, ['worktree', 'add', '-b', 'story/B-test', worktreeRoot]);
  writeFileSync(join(worktreeRoot, 'packages', 'main', 'dist', 'runtime-generation.txt'), 'worktree-new');
  assert.equal(readFileSync(join(mainRoot, 'packages', 'main', 'dist', 'runtime-generation.txt'), 'utf8'), 'main-old');
  assert.equal(readFileSync(join(worktreeRoot, 'packages', 'main', 'dist', 'runtime-generation.txt'), 'utf8'), 'worktree-new');

  const stale = classifyRuntimeEntrypointAuthority({
    command: 'validate',
    commandArgs: ['--story=B-test', '{"payload":"x; touch /tmp/nope"}'],
    projectRoot: worktreeRoot,
    invokedEntrypoint: join(mainRoot, 'bin', 'proofOrStop.js'),
    loadedCorePackageRoot: join(mainRoot, 'packages', 'main'),
    env: {},
  });
  assert.equal(stale.status, 'blocked');
  assert.equal(stale.reasonCode, 'stale_global_runtime_in_worktree');
  assert.equal(stale.selfHostWorktree, true);
  assert.equal(stale.runtimeRoot, realpathSync(mainRoot));
  assert.equal(stale.worktreeRoot, realpathSync(worktreeRoot));
  assert.match(stale.recoveryCommand ?? '', /^cd -- /);
  assert.match(stale.recoveryCommand ?? '', /node bin\/proofOrStop\.js validate/);
  assert.match(stale.recoveryCommand ?? '', /'\{"payload":"x; touch \/tmp\/nope"\}'/);
  assert.match(renderRuntimeEntrypointAuthorityFailure(stale), /Blocked \[stale_global_runtime_in_worktree\]/);

  const local = classifyRuntimeEntrypointAuthority({
    command: 'validate',
    commandArgs: ['--story=B-test'],
    projectRoot: worktreeRoot,
    invokedEntrypoint: join(worktreeRoot, 'bin', 'proofOrStop.js'),
    loadedCorePackageRoot: join(worktreeRoot, 'packages', 'main'),
    env: {},
  });
  assert.equal(local.status, 'pass');

  const symlinkedLauncher = join(tmp, 'linked proofOrStop');
  symlinkSync(join(mainRoot, 'bin', 'proofOrStop.js'), symlinkedLauncher);
  const aliased = classifyRuntimeEntrypointAuthority({
    command: 'story_advance',
    commandArgs: ['{"storyId":"B-test","phase":"TEST"}'],
    projectRoot: join(worktreeRoot, '.', 'packages', '..'),
    invokedEntrypoint: symlinkedLauncher,
    loadedCorePackageRoot: join(mainRoot, 'packages', 'main'),
    env: {},
  });
  assert.equal(aliased.status, 'blocked');
  assert.equal(aliased.reasonCode, stale.reasonCode);
  assert.equal(
    aliased.recoveryCommand,
    renderLocalEntrypointRecoveryCommand(realpathSync(worktreeRoot), 'story_advance', ['{"storyId":"B-test","phase":"TEST"}']),
  );

  const spoofedArgv = classifyRuntimeEntrypointAuthority({
    command: 'validate',
    commandArgs: ['--story=B-test'],
    projectRoot: worktreeRoot,
    invokedEntrypoint: join(worktreeRoot, 'bin', 'proofOrStop.js'),
    loadedCorePackageRoot: join(mainRoot, 'packages', 'main'),
    env: {},
  });
  assert.equal(spoofedArgv.status, 'blocked', 'worktree-looking argv cannot hide a main-loaded runtime');
  assert.equal(spoofedArgv.reasonCode, 'stale_global_runtime_in_worktree');

  const fallback = classifyRuntimeEntrypointAuthority({
    command: 'session_brief',
    commandArgs: [],
    projectRoot: worktreeRoot,
    invokedEntrypoint: join(mainRoot, 'bin', 'proofOrStop.js'),
    loadedCorePackageRoot: join(mainRoot, 'packages', 'main'),
    env: { PROOF_OR_STOP_CODEX_ENTRYPOINT: 'global-fallback' },
  });
  assert.equal(fallback.status, 'exempt');
  const notFallback = classifyRuntimeEntrypointAuthority({
    command: 'validate',
    commandArgs: ['--story=B-test'],
    projectRoot: worktreeRoot,
    invokedEntrypoint: join(mainRoot, 'bin', 'proofOrStop.js'),
    loadedCorePackageRoot: join(mainRoot, 'packages', 'main'),
    env: { PROOF_OR_STOP_CODEX_ENTRYPOINT: 'global-fallback' },
  });
  assert.equal(notFallback.status, 'blocked');

  const externalRoot = join(tmp, 'consumer');
  mkdirSync(externalRoot);
  writeFileSync(join(externalRoot, 'package.json'), JSON.stringify({ name: 'consumer' }));
  git(externalRoot, ['init', '--initial-branch=main']);
  const external = classifyRuntimeEntrypointAuthority({
    command: 'validate',
    commandArgs: ['--story=X'],
    projectRoot: externalRoot,
    invokedEntrypoint: join(mainRoot, 'bin', 'proofOrStop.js'),
    env: {},
  });
  assert.equal(external.status, 'pass');
  assert.equal(external.selfHostWorktree, false);

  const malformedSelf = join(tmp, 'malformed-self');
  mkdirSync(join(malformedSelf, 'packages', 'main'), { recursive: true });
  writeFileSync(join(malformedSelf, 'package.json'), JSON.stringify({ name: 'proof-or-stop' }));
  writeFileSync(join(malformedSelf, 'packages', 'main', 'package.json'), JSON.stringify({ name: '@proof-or-stop/core' }));
  const malformedDecision = classifyRuntimeEntrypointAuthority({
    command: 'story_advance',
    commandArgs: ['{"storyId":"B-test","phase":"TEST"}'],
    projectRoot: malformedSelf,
    invokedEntrypoint: join(malformedSelf, 'bin', 'proofOrStop.js'),
    loadedCorePackageRoot: join(malformedSelf, 'packages', 'main'),
    env: {},
  });
  assert.equal(malformedDecision.status, 'blocked');
  assert.equal(malformedDecision.reasonCode, 'runtime_authority_unresolved_in_worktree');

  // Full CLI proof. The copied main runtime contains the authority gate but is
  // intentionally invoked from the linked story worktree. Rejection must
  // happen before the configured preCommand hook and validation subprocess.
  const mainCli = join(mainRoot, 'packages', 'main', 'dist', 'cli.js');
  const staleCli = spawnSync(process.execPath, [
    mainCli,
    '--root', worktreeRoot,
    'validate', '--story=B-test',
  ], { cwd: join(worktreeRoot, 'packages'), encoding: 'utf8' });
  assert.notEqual(staleCli.status, 0, 'stale main runtime must fail');
  assert.match(staleCli.stderr, /Blocked \[stale_global_runtime_in_worktree\] before dispatch/);
  assert.match(staleCli.stderr, /Retry: cd -- .* && node bin\/proofOrStop\.js validate --story=B-test/);
  assert.equal(existsSync(join(worktreeRoot, 'hook-ran')), false, 'preCommand hook must not run');
  assert.equal(existsSync(join(worktreeRoot, 'validation-ran')), false, 'validation subprocess must not run');
  assert.equal(existsSync(join(worktreeRoot, '.proof-or-stop')), false, 'rejected attempt must not create evidence/runtime state');

  const staleCheck = spawnSync(process.execPath, [mainCli, '--root', worktreeRoot, 'check', '--json'], {
    cwd: join(worktreeRoot, 'packages'),
    encoding: 'utf8',
  });
  assert.notEqual(staleCheck.status, 0);
  const recoveryCommand = staleCheck.stderr.match(/^Retry: (.+)$/m)?.[1];
  assert.ok(recoveryCommand, `stale check should emit a recovery command: ${staleCheck.stderr}`);
  const recovered = spawnSync('/bin/sh', ['-c', recoveryCommand], { cwd: tmp, encoding: 'utf8' });
  assert.equal(recovered.status, 0, `emitted recovery command should dispatch locally: ${recovered.stderr}`);
  assert.match(recovered.stdout, /"runtimeMode"/);

  const linkedMainCli = join(tmp, 'global proof-or-stop cli.js');
  symlinkSync(mainCli, linkedMainCli);
  const linkedStale = spawnSync(process.execPath, [linkedMainCli, '--root', worktreeRoot, 'check', '--json'], {
    cwd: join(worktreeRoot, 'packages'),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(worktreeRoot, 'bin')}:${process.env.PATH ?? ''}` },
  });
  assert.notEqual(linkedStale.status, 0);
  assert.match(linkedStale.stderr, /stale_global_runtime_in_worktree/);

  const fallbackCli = spawnSync(process.execPath, [mainCli, '--root', worktreeRoot, 'session_brief'], {
    cwd: worktreeRoot,
    encoding: 'utf8',
    env: { ...process.env, PROOF_OR_STOP_CODEX_ENTRYPOINT: 'global-fallback' },
  });
  assert.equal(fallbackCli.status, 0, `explicit session_brief fallback should execute: ${fallbackCli.stderr}`);
  assert.doesNotMatch(fallbackCli.stderr, /stale_global_runtime_in_worktree/);

  const blockedFallbackCli = spawnSync(process.execPath, [mainCli, '--root', worktreeRoot, 'check', '--json'], {
    cwd: worktreeRoot,
    encoding: 'utf8',
    env: { ...process.env, PROOF_OR_STOP_CODEX_ENTRYPOINT: 'global-fallback' },
  });
  assert.notEqual(blockedFallbackCli.status, 0);
  assert.match(blockedFallbackCli.stderr, /stale_global_runtime_in_worktree/);

  for (const informationalCommand of [['help'], ['version'], ['check', '--help']]) {
    const staleInformational = spawnSync(process.execPath, [mainCli, '--root', worktreeRoot, ...informationalCommand], {
      cwd: worktreeRoot,
      encoding: 'utf8',
      env: { ...process.env, PROOF_OR_STOP_CODEX_ENTRYPOINT: 'global-fallback' },
    });
    assert.notEqual(staleInformational.status, 0);
    assert.match(staleInformational.stderr, /stale_global_runtime_in_worktree/, `${informationalCommand.join(' ')} must not become a fallback exemption`);
  }

  const externalCli = spawnSync(process.execPath, [mainCli, '--root', externalRoot, 'check', '--json'], {
    cwd: externalRoot,
    encoding: 'utf8',
  });
  assert.equal(externalCli.status, 0, `external consumer must remain executable: ${externalCli.stderr}`);
  assert.match(externalCli.stdout, /"runtimeMode"/);

  // Early-path regressions: authority must run before standalone executors and
  // before stale tool/schema lookup. These requests would otherwise mutate via
  // init, start the long-lived dashboard, or reject a worktree-valid utils
  // command as unknown without ever printing the local recovery.
  const beforeInitStatus = git(worktreeRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  const staleInit = spawnSync(process.execPath, [mainCli, 'init'], {
    cwd: worktreeRoot,
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.notEqual(staleInit.status, 0);
  assert.match(staleInit.stderr, /Blocked \[stale_global_runtime_in_worktree\] before dispatch/);
  assert.equal(git(worktreeRoot, ['status', '--porcelain=v1', '--untracked-files=all']), beforeInitStatus, 'stale init must write nothing');

  const dashboardStarted = Date.now();
  const staleDashboard = spawnSync(process.execPath, [mainCli, '--root', worktreeRoot, 'dashboard', '--interval=999999'], {
    cwd: worktreeRoot,
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.notEqual(staleDashboard.status, 0);
  assert.equal(staleDashboard.signal, null, 'dashboard must be rejected, not killed by the harness timeout');
  assert.ok(Date.now() - dashboardStarted < 2_000, 'dashboard rejection must return before server startup');
  assert.match(staleDashboard.stderr, /Blocked \[stale_global_runtime_in_worktree\] before dispatch/);
  assert.equal(existsSync(join(worktreeRoot, '.proof-or-stop-serve.json')), false, 'dashboard must not create serve metadata');

  const staleWorktreeOnlyCommand = spawnSync(process.execPath, [mainCli, '--root', worktreeRoot, 'aux_doc_list', '--format=json'], {
    cwd: worktreeRoot,
    encoding: 'utf8',
  });
  assert.notEqual(staleWorktreeOnlyCommand.status, 0);
  assert.doesNotMatch(staleWorktreeOnlyCommand.stderr, /Unknown command/);
  assert.match(staleWorktreeOnlyCommand.stderr, /Blocked \[stale_global_runtime_in_worktree\] before dispatch/);
  const auxRecovery = staleWorktreeOnlyCommand.stderr.match(/^Retry: (.+)$/m)?.[1];
  assert.ok(auxRecovery, 'worktree-only command must receive canonical local recovery before stale tool lookup');
  const recoveredAux = spawnSync('/bin/sh', ['-c', auxRecovery], { cwd: tmp, encoding: 'utf8' });
  assert.equal(recoveredAux.status, 0, `worktree-only recovered command should execute: ${recoveredAux.stderr}`);

  console.log('Runtime entrypoint authority smoke: PASS — stale global calls executed 0 handlers; local and external controls passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
