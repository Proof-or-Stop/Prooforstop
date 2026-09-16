#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [join(repository, 'scripts/ensure-dist.mjs')], { cwd: repository, stdio: 'inherit', timeout: 240000 });
const { inspectExpectedControllerRuntimeProjection, isByteIdenticalControllerRuntimeAsset } = await import('../packages/main/dist/core/runtime-artifact-registry.js');
const { CONTROLLER_RUNTIME_ASSET_PATHS } = await import('../packages/main/dist/core/controller-runtime-projection.js');
const root = mkdtempSync(join(tmpdir(), 'pos-tracked-bootstrap-'));
const storyId = 'B-tracked-config';
const worktree = join(root, '.worktrees', storyId);
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (cwd, path, bytes) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), bytes); };
const inspect = () => inspectExpectedControllerRuntimeProjection({ projectRoot: worktree, gitCwd: worktree, storyId });
try {
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'lab@example.invalid']);
  git(root, ['config', 'user.name', 'Lab regression']);
  write(root, '.gitignore', '.worktrees/\n');
  write(root, '.proof-or-stop/proof-or-stop.json', JSON.stringify({ assetMode: 'global-thin' }));
  const config = { storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: 'src', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' };
  write(root, 'proof-or-stop.config.json', JSON.stringify(config));
  write(root, `.proof-or-stop/story/actives/${storyId}/index.json`, JSON.stringify({ storyId, name: 'Tracked configuration regression', phase: 'REVIEW', currentReviewRound: '2026-09-16T00:00:00.000Z' }));
  for (const path of CONTROLLER_RUNTIME_ASSET_PATHS) write(root, path, path.endsWith('.json') ? '{"hooks":[]}\n' : 'module.exports = {};\n');
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'tracked repository baseline']);
  git(root, ['worktree', 'add', '-qb', `story/${storyId}`, worktree]);
  const branchConfig = JSON.stringify({ ...config, description: 'Authorized Story-owned config difference' });
  write(worktree, 'proof-or-stop.config.json', branchConfig);
  git(worktree, ['add', 'proof-or-stop.config.json']); git(worktree, ['commit', '-qm', 'scoped config change']);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(PROOF_OR_STOP|PROOFBOUND|LATTICE)_/.test(key)) delete env[key];
  env.PROOF_OR_STOP_SESSION_ID = 'tracked-bootstrap-regression';
  const result = spawnSync(process.execPath, [join(repository, 'packages/main/dist/cli.js'), 'aux_doc_list'], { cwd: worktree, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, `TRACKED_CONFIG_BOOTSTRAP_RED: normal CLI must preserve tracked branch config instead of projecting the controller copy\n${result.stderr}`);
  assert.equal(readFileSync(join(worktree, 'proof-or-stop.config.json'), 'utf8'), branchConfig);
  assert.deepEqual([inspect().expected, inspect().valid], [false, true], 'repository-owned hooks require ordinary material review, not projection receipts');
  const review = spawnSync(process.execPath, [join(repository, 'packages/main/dist/cli.js'), 'review_run_start', `--storyId=${storyId}`, '--agent=proof-or-stop-review-quality'], { cwd: worktree, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(review.status, 0, `the actual reviewer-run producer must remain reachable with tracked assets\n${review.stdout}\n${review.stderr}`);
  assert.match(review.stdout, /Review run .* started/);
  for (const path of CONTROLLER_RUNTIME_ASSET_PATHS) assert.equal(isByteIdenticalControllerRuntimeAsset({ projectRoot: worktree, gitCwd: worktree, storyId, path }), false, 'tracked hooks never receive runtime scope exemption');

  // A worktree-only staged/committed conversion cannot confer repository ownership.
  const hook = CONTROLLER_RUNTIME_ASSET_PATHS[0];
  git(root, ['rm', '--cached', hook]); git(root, ['commit', '-qm', 'controller-only hook']);
  assert.equal(inspect().valid, false, 'mixed controller ownership retains the strict projection gate');
  git(root, ['add', hook]);
  assert.equal(inspect().valid, false, 'index-only tracking is not a committed ownership baseline');
  git(root, ['commit', '-qm', 'restore tracked controller baseline']);
  assert.equal(inspect().expected, false);
  git(worktree, ['rm', '--cached', hook]);
  assert.equal(inspect().valid, false, 'index deletion must not inherit HEAD ownership');
  git(worktree, ['add', hook]);
  write(worktree, hook, '{"hooks":[],"changed":true}\n');
  assert.equal(isByteIdenticalControllerRuntimeAsset({ projectRoot: worktree, gitCwd: worktree, storyId, path: hook }), false, 'changed tracked hooks remain material');
  console.log('TRACKED_CONFIG_BOOTSTRAP_GREEN: CLI preservation, projection admission and ownership negative controls passed');
} finally { rmSync(root, { recursive: true, force: true }); }
for (const path of [
  'packages/main/dist/tasks/benchmark-framework-hardening-smoke.js',
  'packages/main/dist/tasks/external-worktree-go-pre-review-smoke.js',
  'scripts/verify-runtime-fact-contract.mjs',
  'scripts/verify-process-fact-contract.mjs',
]) execFileSync(process.execPath, [path], { cwd: repository, stdio: 'inherit', timeout: 240000 });
