#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  classifyRuntimeEntrypointAuthority,
  renderLocalEntrypointRecoveryCommand,
  renderRuntimeEntrypointAuthorityFailure,
} from '../core/runtime-environment-checks.js';

const tmp = mkdtempSync(join(tmpdir(), 'lattice-runtime-entrypoint-authority-'));

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeSelfProject(root: string): void {
  mkdirSync(join(root, 'packages', 'main'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'lattice', version: '1.0.0' }));
  writeFileSync(join(root, 'packages', 'main', 'package.json'), JSON.stringify({ name: '@lattice/core', version: '1.0.0' }));
  writeFileSync(join(root, 'bin', 'lattice.js'), '#!/usr/bin/env node\n');
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

  const stale = classifyRuntimeEntrypointAuthority({
    command: 'validate',
    commandArgs: ['--story=B-test', '{"payload":"x; touch /tmp/nope"}'],
    projectRoot: worktreeRoot,
    invokedEntrypoint: join(mainRoot, 'bin', 'lattice.js'),
    env: {},
  });
  assert.equal(stale.status, 'blocked');
  assert.equal(stale.reasonCode, 'stale_global_runtime_in_worktree');
  assert.equal(stale.selfHostWorktree, true);
  assert.equal(stale.runtimeRoot, realpathSync(mainRoot));
  assert.equal(stale.worktreeRoot, realpathSync(worktreeRoot));
  assert.match(stale.recoveryCommand ?? '', /^cd -- /);
  assert.match(stale.recoveryCommand ?? '', /node bin\/lattice\.js validate/);
  assert.match(stale.recoveryCommand ?? '', /'\{"payload":"x; touch \/tmp\/nope"\}'/);
  assert.match(renderRuntimeEntrypointAuthorityFailure(stale), /Blocked \[stale_global_runtime_in_worktree\]/);

  const local = classifyRuntimeEntrypointAuthority({
    command: 'validate',
    commandArgs: ['--story=B-test'],
    projectRoot: worktreeRoot,
    invokedEntrypoint: join(worktreeRoot, 'bin', 'lattice.js'),
    env: {},
  });
  assert.equal(local.status, 'pass');

  const symlinkedLauncher = join(tmp, 'linked lattice');
  symlinkSync(join(mainRoot, 'bin', 'lattice.js'), symlinkedLauncher);
  const aliased = classifyRuntimeEntrypointAuthority({
    command: 'story_advance',
    commandArgs: ['{"storyId":"B-test","phase":"TEST"}'],
    projectRoot: join(worktreeRoot, '.', 'packages', '..'),
    invokedEntrypoint: symlinkedLauncher,
    env: {},
  });
  assert.equal(aliased.status, 'blocked');
  assert.equal(aliased.reasonCode, stale.reasonCode);
  assert.equal(
    aliased.recoveryCommand,
    renderLocalEntrypointRecoveryCommand(realpathSync(worktreeRoot), 'story_advance', ['{"storyId":"B-test","phase":"TEST"}']),
  );

  const fallback = classifyRuntimeEntrypointAuthority({
    command: 'session_brief',
    commandArgs: [],
    projectRoot: worktreeRoot,
    invokedEntrypoint: join(mainRoot, 'bin', 'lattice.js'),
    env: { LATTICE_CODEX_ENTRYPOINT: 'global-fallback' },
  });
  assert.equal(fallback.status, 'exempt');
  const notFallback = classifyRuntimeEntrypointAuthority({
    command: 'validate',
    commandArgs: ['--story=B-test'],
    projectRoot: worktreeRoot,
    invokedEntrypoint: join(mainRoot, 'bin', 'lattice.js'),
    env: { LATTICE_CODEX_ENTRYPOINT: 'global-fallback' },
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
    invokedEntrypoint: join(mainRoot, 'bin', 'lattice.js'),
    env: {},
  });
  assert.equal(external.status, 'pass');
  assert.equal(external.selfHostWorktree, false);

  console.log('Runtime entrypoint authority smoke: PASS — stale global calls executed 0 handlers; local and external controls passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
