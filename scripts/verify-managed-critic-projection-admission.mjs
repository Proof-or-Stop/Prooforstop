#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const build = spawnSync('npm', ['--prefix', 'packages/main', 'run', 'build'], {
  cwd: root,
  encoding: 'utf8',
});
process.stdout.write(build.stdout || '');
process.stderr.write(build.stderr || '');
if (build.status !== 0) process.exit(build.status ?? 1);

const { projectControllerAssetsIntoStoryWorktree } = await import('../packages/main/dist/cli/runtime-root.js');
const { readManagedInventoryCriticMaterialDirtyFiles } = await import('../packages/main/dist/handlers/review-inventory.js');
const { resetConfigCache } = await import('../packages/main/dist/core/config.js');

assert.equal(typeof readManagedInventoryCriticMaterialDirtyFiles, 'function',
  'readManagedInventoryCriticMaterialDirtyFiles must be exported by the managed critic handler');

const fixture = mkdtempSync(join(tmpdir(), 'managed-critic-projection-admission-'));
const worktree = join(fixture, '.worktrees', 'B-projection');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (cwd, path, bytes) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), bytes);
};

try {
  git(fixture, ['init', '-q', '-b', 'main']);
  git(fixture, ['config', 'user.email', 'fixture@example.invalid']);
  git(fixture, ['config', 'user.name', 'Projection Fixture']);
  write(fixture, 'README.md', 'fixture\n');
  git(fixture, ['add', 'README.md']);
  git(fixture, ['commit', '-qm', 'fixture']);

  write(fixture, '.proof-or-stop/proof-or-stop.json', JSON.stringify({ assetMode: 'global-thin' }));
  write(fixture, 'proof-or-stop.config.json', JSON.stringify({
    storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures',
  }));
  write(fixture, '.proof-or-stop/story/actives/B-projection/index.json', JSON.stringify({ storyId: 'B-projection', phase: 'REVIEW' }));
  write(fixture, '.codex/hooks.json', '{"hooks":[]}\n');
  write(fixture, '.codex/hooks/proof-or-stop-evidence-pretool.cjs', 'module.exports = {};\n');
  write(fixture, '.codex/hooks/proof-or-stop-scope-pretool.cjs', 'module.exports = {};\n');
  git(fixture, ['branch', 'story/B-projection']);
  mkdirSync(dirname(worktree), { recursive: true });
  git(fixture, ['worktree', 'add', '-q', worktree, 'story/B-projection']);
  resetConfigCache();
  projectControllerAssetsIntoStoryWorktree({ controllerRoot: fixture, worktreeRoot: worktree, storyId: 'B-projection' });

  assert.deepEqual(
    readManagedInventoryCriticMaterialDirtyFiles(worktree, worktree, 'B-projection').files,
    [],
    'exact current-Story signed byte-identical projections must not block managed critic import',
  );
  assert.ok(
    readManagedInventoryCriticMaterialDirtyFiles(worktree, worktree, 'B-wrong-story').files.includes('proof-or-stop.config.json'),
    'a projection receipt for another Story must remain material drift',
  );

  write(worktree, 'ordinary-untracked.ts', 'export const drift = true;\n');
  assert.ok(
    readManagedInventoryCriticMaterialDirtyFiles(worktree, worktree, 'B-projection').files.includes('ordinary-untracked.ts'),
    'ordinary untracked material must remain blocked',
  );
  rmSync(join(worktree, 'ordinary-untracked.ts'));

  const configPath = join(worktree, 'proof-or-stop.config.json');
  const configBytes = readFileSync(configPath);
  writeFileSync(configPath, Buffer.concat([configBytes, Buffer.from('\n')]));
  assert.ok(
    readManagedInventoryCriticMaterialDirtyFiles(worktree, worktree, 'B-projection').files.includes('proof-or-stop.config.json'),
    'byte-different projected config must remain material drift',
  );
  writeFileSync(configPath, configBytes);

  console.log('MANAGED_INVENTORY_CRITIC_PROJECTION_ADMISSION_GREEN');
} finally {
  resetConfigCache();
  rmSync(fixture, { recursive: true, force: true });
}
