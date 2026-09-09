#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '..', '..');

const build = spawnSync('npm', ['--prefix', 'packages/main', 'run', 'build'], {
  cwd: repoRoot,
  encoding: 'utf8',
});
assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);

const { buildScopeBoundary } = await import(join(packageRoot, 'dist/core/scope-anti-expansion.js'));
const { REQUIRED_INIT_CHECK_AGENTS } = await import(join(packageRoot, 'dist/core/init-check-gate.js'));
const { COMMAND_POLICIES } = await import(join(packageRoot, 'dist/core/command-policy.js'));
const { classifyRuntimeEntrypointAuthority } = await import(join(packageRoot, 'dist/core/runtime-environment-checks.js'));

const boundary = buildScopeBoundary({
  storyId: 'B-lab',
  mode: 'custom',
  allowed: ['canonical identity'],
  excluded: [],
  confirmedBy: 'human',
  confirmationNote: 'Lab regression contract',
  now: '2026-09-09T00:00:00.000Z',
});
assert.equal(boundary.schemaVersion, 'proof-or-stop.scope_boundary.v1.1');

assert.ok(REQUIRED_INIT_CHECK_AGENTS.includes('proof-or-stop-review-story-init'));
assert.equal(REQUIRED_INIT_CHECK_AGENTS.some((agent) => /lattice/i.test(agent)), false);

const storyWriters = Object.entries(COMMAND_POLICIES)
  .filter(([, policy]) => policy.ownershipClass === 'storyScopedMutating')
  .map(([command]) => command);
assert.ok(storyWriters.length > 0);
const topologyContainer = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-focused-topology-'));
try {
  const targetRoot = join(topologyContainer, 'main');
  mkdirSync(join(targetRoot, 'packages', 'main'), { recursive: true });
  mkdirSync(join(targetRoot, 'bin'), { recursive: true });
  writeFileSync(join(targetRoot, 'package.json'), '{"name":"proof-or-stop"}\n');
  writeFileSync(join(targetRoot, 'packages', 'main', 'package.json'), '{"name":"@proof-or-stop/core"}\n');
  writeFileSync(join(targetRoot, 'bin', 'proof-or-stop.js'), '#!/usr/bin/env node\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: targetRoot, stdio: 'pipe' });
  execFileSync('git', ['add', '.'], { cwd: targetRoot, stdio: 'pipe' });
  execFileSync('git', [
    '-c', 'user.name=Proof-or-Stop Test',
    '-c', 'user.email=proof-or-stop@example.invalid',
    'commit', '-m', 'fixture baseline',
  ], { cwd: targetRoot, stdio: 'pipe' });
  const foreignRoot = join(topologyContainer, 'story-worktree');
  execFileSync('git', ['worktree', 'add', '-b', 'story/B-lab', foreignRoot], { cwd: targetRoot, stdio: 'pipe' });

  const admitted = storyWriters.filter((command) => classifyRuntimeEntrypointAuthority({
    command,
    commandArgs: ['{"storyId":"B-lab"}'],
    projectRoot: targetRoot,
    invokedEntrypoint: join(foreignRoot, 'bin', 'proof-or-stop.js'),
    loadedCorePackageRoot: join(foreignRoot, 'packages', 'main'),
    env: {},
  }).status !== 'blocked');
  assert.deepEqual(admitted, [], `foreign runtime admitted Story writers: ${admitted.join(', ')}`);
} finally {
  rmSync(topologyContainer, { recursive: true, force: true });
}

const validationHandler = readFileSync(join(packageRoot, 'src/handlers/story-aware-validation.ts'), 'utf8');
const config = readFileSync(join(repoRoot, 'proof-or-stop.config.json'), 'utf8');
assert.doesNotMatch(validationHandler, /\bLATTICE_VALIDATION_SHARD_ADAPTER\b/);
assert.doesNotMatch(config, /"LATTICE_VALIDATION_SHARD_ADAPTER"/);

process.stdout.write('GREEN Lab B-49df canonical active identity contract\n');
