#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { prepareVerification } from './verification-subprocess-budget.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spawnSync = prepareVerification(repository, { shareBuild: true });
const { isValidationTransportEnvKey } = await import('../packages/main/dist/core/validation-command-environment.js');
const { inspectExpectedControllerRuntimeProjection, isByteIdenticalControllerRuntimeAsset } = await import('../packages/main/dist/core/runtime-artifact-registry.js');
const { CONTROLLER_RUNTIME_ASSET_PATHS, CONTROLLER_RUNTIME_PROJECTION_STORY_RECEIPT, hasRepositoryOwnedControllerAssets } = await import('../packages/main/dist/core/controller-runtime-projection.js');
const { classifyScopePath } = await import('../packages/main/dist/core/scope-path-classifier.js');
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
  write(root, `.proof-or-stop/story/actives/${storyId}/index.json`, JSON.stringify({ storyId, name: 'tracked-configuration-regression', title: 'Tracked configuration regression', description: 'Fixture for repository-owned config and native hook bootstrap admission.', type: 'bug', priority: 'medium', phase: 'REVIEW', createdAt: '2026-09-16T00:00:00.000Z', startedAt: '2026-09-16T00:00:00.000Z', endedAt: null, currentReviewRound: '2026-09-16T00:00:00.000Z', worktree: { path: worktree, branch: `story/${storyId}`, createdAt: '2026-09-16T00:00:00.000Z' } }));
  write(root, `.proof-or-stop/story/actives/${storyId}/checklist.json`, JSON.stringify({ items: [] }));
  for (const path of CONTROLLER_RUNTIME_ASSET_PATHS) write(root, path, path.endsWith('.json') ? '{"hooks":[]}\n' : 'module.exports = {};\n');
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'tracked repository baseline']);
  git(root, ['worktree', 'add', '-qb', `story/${storyId}`, worktree]);
  const branchConfig = JSON.stringify({ ...config, description: 'Authorized Story-owned config difference' });
  write(worktree, 'proof-or-stop.config.json', branchConfig);
  git(worktree, ['add', 'proof-or-stop.config.json']); git(worktree, ['commit', '-qm', 'scoped config change']);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(PROOF_OR_STOP|PROOFBOUND|LATTICE)_/.test(key) || isValidationTransportEnvKey(key)) delete env[key];
  env.PROOF_OR_STOP_SESSION_ID = 'tracked-bootstrap-regression';
  env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER = 'codex'; // Temporary fixture owner; no provider process is launched.
  const result = spawnSync(process.execPath, [join(repository, 'packages/main/dist/cli.js'), 'aux_doc_list'], { cwd: worktree, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, `TRACKED_CONFIG_BOOTSTRAP_RED: normal CLI must preserve tracked branch config instead of projecting the controller copy\n${result.stderr}`);
  assert.equal(readFileSync(join(worktree, 'proof-or-stop.config.json'), 'utf8'), branchConfig);
  for (const configPath of ['README.md', '../proof-or-stop.config.json', ':(glob)*', '.codex/hooks.json']) {
    assert.equal(hasRepositoryOwnedControllerAssets({ controllerRoot: root, worktreeRoot: worktree, configPath }), false, `noncanonical config rejected: ${configPath}`);
  }
  const controllerAlias = join(root, 'controller-alias');
  const worktreeAlias = join(root, 'worktree-alias');
  symlinkSync(root, controllerAlias); symlinkSync(worktree, worktreeAlias);
  assert.equal(hasRepositoryOwnedControllerAssets({ controllerRoot: controllerAlias, worktreeRoot: worktreeAlias, configPath: 'proof-or-stop.config.json' }), true, 'canonical root aliases preserve repository ownership');
  assert.equal(hasRepositoryOwnedControllerAssets({ controllerRoot: root, worktreeRoot: join(root, 'absent'), configPath: 'proof-or-stop.config.json' }), false, 'unresolvable roots fail closed');
  assert.deepEqual([inspect().expected, inspect().valid], [false, true], 'repository-owned hooks require ordinary material review, not projection receipts');
  const dispatch = spawnSync(process.execPath, [join(repository, 'packages/main/dist/cli.js'), 'dispatch', `--storyId=${storyId}`, '--agentType=proof-or-stop-review-quality'], { cwd: worktree, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(dispatch.status, 0, `the fixture must acquire a real owner dispatch\n${dispatch.stderr}`);
  const review = spawnSync(process.execPath, [join(repository, 'packages/main/dist/cli.js'), 'review_run_start', `--storyId=${storyId}`, '--agent=proof-or-stop-review-quality'], { cwd: worktree, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(review.status, 0, `the actual reviewer-run producer must remain reachable with tracked assets\n${review.stdout}\n${review.stderr}`);
  assert.match(review.stdout, /Review run .* started/);
  for (const path of CONTROLLER_RUNTIME_ASSET_PATHS) assert.equal(isByteIdenticalControllerRuntimeAsset({ projectRoot: worktree, gitCwd: worktree, storyId, path }), false, 'tracked hooks never receive runtime scope exemption');

  // A worktree-only staged/committed conversion cannot confer repository ownership.
  const hook = CONTROLLER_RUNTIME_ASSET_PATHS[0];
  const controllerHookBytes = readFileSync(join(root, hook));
  rmSync(join(root, hook));
  assert.equal(hasRepositoryOwnedControllerAssets({ controllerRoot: root, worktreeRoot: worktree, configPath: 'proof-or-stop.config.json' }), false, 'an uncommitted controller deletion is not an integrated absence');
  write(root, hook, controllerHookBytes);
  git(root, ['rm', '--cached', hook]); git(root, ['commit', '-qm', 'controller-only hook']);
  assert.equal(inspect().valid, false, 'mixed controller ownership retains the strict projection gate');
  git(root, ['add', hook]);
  assert.equal(inspect().valid, false, 'index-only tracking is not a committed ownership baseline');
  git(root, ['commit', '-qm', 'restore tracked controller baseline']);
  assert.equal(inspect().expected, false, 'restored committed ownership removes the projection requirement');
  git(worktree, ['rm', '--cached', hook]);
  assert.equal(inspect().expected, false, 'candidate index deletion remains ordinary repository material');
  const dirtyReview = spawnSync(process.execPath, [join(repository, 'packages/main/dist/cli.js'), 'review_run_start', `--storyId=${storyId}`, '--agent=proof-or-stop-review-quality'], { cwd: worktree, env, encoding: 'utf8', timeout: 60000 });
  assert.notEqual(dirtyReview.status, 0, 'uncommitted asset removal must still block review');
  assert.match(dirtyReview.stderr, /uncommitted|unexpected_dirty_files/, 'the ordinary cleanliness gate rejects dirty material');
  git(worktree, ['add', hook]);
  write(worktree, hook, '{"hooks":[],"changed":true}\n');
  assert.equal(isByteIdenticalControllerRuntimeAsset({ projectRoot: worktree, gitCwd: worktree, storyId, path: hook }), false, 'changed tracked hooks remain material');
  const contract = { storyId, mode: 'enforce', allowedModify: [], allowedCreate: [], allowedTest: [], protectedFiles: [], explicitExcludes: [], acknowledgements: [], createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z' };
  assert.equal(classifyScopePath(contract, hook, { projectRoot: worktree, gitCwd: worktree }).allowed, false, 'ordinary scope enforcement still rejects undeclared tracked hook changes');
  rmSync(join(worktree, hook));
  assert.equal(inspect().expected, false, 'missing candidate material does not become an external projection');
  assert.equal(classifyScopePath(contract, hook, { projectRoot: worktree, gitCwd: worktree }).allowed, false, 'undeclared deletion is still outside scope');
  symlinkSync(join(root, hook), join(worktree, hook));
  assert.equal(isByteIdenticalControllerRuntimeAsset({ projectRoot: worktree, gitCwd: worktree, storyId, path: hook }), false, 'candidate symlink receives no runtime exemption');
  assert.equal(classifyScopePath(contract, hook, { projectRoot: worktree, gitCwd: worktree }).allowed, false, 'escaping candidate symlink is refused by scope enforcement');
  rmSync(join(worktree, hook));
  git(worktree, ['rm', '--', hook]); git(worktree, ['commit', '-qm', 'legitimate material hook deletion']);
  assert.deepEqual([inspect().expected, inspect().valid], [false, true], 'committed hook deletion avoids the projection deadlock');
  assert.equal(classifyScopePath({ ...contract, allowedModify: [hook] }, hook, { projectRoot: worktree, gitCwd: worktree }).allowed, true, 'declared material deletion retains ordinary scope admission');
  const deletionDispatch = spawnSync(process.execPath, [join(repository, 'packages/main/dist/cli.js'), 'dispatch', `--storyId=${storyId}`, '--agentType=proof-or-stop-review-quality'], { cwd: worktree, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(deletionDispatch.status, 0, `fresh deletion dispatch\n${deletionDispatch.stderr}`);
  const deletionReview = spawnSync(process.execPath, [join(repository, 'packages/main/dist/cli.js'), 'review_run_start', `--storyId=${storyId}`, '--agent=proof-or-stop-review-quality'], { cwd: worktree, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(deletionReview.status, 0, `committed material deletion reaches the real reviewer producer\n${deletionReview.stderr}`);

  // Exercise the second CLI bootstrap branch: the controller creates its Story
  // after the linked branch exists, while that branch owns a different config.
  const lateId = 'B-tracked-late';
  const lateTree = join(root, '.worktrees', lateId);
  git(root, ['worktree', 'add', '-qb', `story/${lateId}`, lateTree]);
  write(lateTree, 'proof-or-stop.config.json', branchConfig);
  git(lateTree, ['add', 'proof-or-stop.config.json']); git(lateTree, ['commit', '-qm', 'late Story config']);
  const originalStory = JSON.parse(readFileSync(join(root, `.proof-or-stop/story/actives/${storyId}/index.json`), 'utf8'));
  const lateStory = { ...originalStory, storyId: lateId, worktree: { ...originalStory.worktree, path: lateTree, branch: `story/${lateId}` } };
  write(root, `.proof-or-stop/story/actives/${lateId}/index.json`, JSON.stringify(lateStory));
  write(root, `.proof-or-stop/story/actives/${lateId}/checklist.json`, '{"items":[]}');
  const lateDispatch = spawnSync(process.execPath, [join(repository, 'packages/main/dist/cli.js'), 'dispatch', `--storyId=${lateId}`, '--agentType=proof-or-stop-review-quality'], { cwd: lateTree, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(lateDispatch.status, 0, `late Story bootstrap preserves tracked material\n${lateDispatch.stderr}`);
  assert.equal(readFileSync(join(lateTree, 'proof-or-stop.config.json'), 'utf8'), branchConfig, 'second bootstrap branch preserves branch config');
  assert.equal(JSON.parse(readFileSync(join(lateTree, `.proof-or-stop/story/actives/${lateId}/index.json`), 'utf8')).storyId, lateId, 'missing Story is actually projected to the registered branch');

  const mismatchId = 'B-different-story-dir';
  const mismatchTree = join(root, '.worktrees', mismatchId);
  git(root, ['worktree', 'add', '-qb', `story/${mismatchId}`, mismatchTree]);
  write(mismatchTree, 'proof-or-stop.config.json', JSON.stringify({ ...config, storyDir: '.alternate/stories' }));
  git(mismatchTree, ['add', 'proof-or-stop.config.json']); git(mismatchTree, ['commit', '-qm', 'different Story destination']);
  write(root, `.proof-or-stop/story/actives/${mismatchId}/index.json`, JSON.stringify({ ...originalStory, storyId: mismatchId, worktree: { ...originalStory.worktree, path: mismatchTree, branch: `story/${mismatchId}` } }));
  write(root, `.proof-or-stop/story/actives/${mismatchId}/checklist.json`, '{"items":[]}');
  const mismatch = spawnSync(process.execPath, [join(repository, 'packages/main/dist/cli.js'), 'dispatch', `--storyId=${mismatchId}`, '--agentType=proof-or-stop-review-quality'], { cwd: mismatchTree, env, encoding: 'utf8', timeout: 60000 });
  assert.notEqual(mismatch.status, 0, 'different configured Story directories must refuse copying');
  assert.match(mismatch.stderr, /differing repository-owned Story directories/);
  for (const dir of [config.storyDir, '.alternate/stories']) assert.equal(existsSync(join(mismatchTree, dir, mismatchId)), false, 'no Story copy is created on a mismatched destination');

  git(root, ['rm', '--', hook]); git(root, ['commit', '-qm', 'integrated material hook removal']);
  assert.equal(hasRepositoryOwnedControllerAssets({ controllerRoot: root, worktreeRoot: worktree, configPath: 'proof-or-stop.config.json' }), true, 'committed controller removal does not reintroduce a later-Story deadlock');
  const afterRemoval = spawnSync(process.execPath, [join(repository, 'packages/main/dist/cli.js'), 'aux_doc_list'], { cwd: worktree, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(afterRemoval.status, 0, `CLI remains usable after the deletion reaches the controller\n${afterRemoval.stderr}`);
  write(root, hook, '{"hooks":[]}\n');
  assert.equal(hasRepositoryOwnedControllerAssets({ controllerRoot: root, worktreeRoot: worktree, configPath: 'proof-or-stop.config.json' }), false, 'new untracked controller hook cannot borrow material ownership');

  // Pin the opposite CLI branch with genuine untracked controller assets.
  git(root, ['rm', '--cached', '--ignore-unmatch', 'proof-or-stop.config.json', ...CONTROLLER_RUNTIME_ASSET_PATHS]);
  git(root, ['commit', '-qm', 'external controller baseline']);
  const externalId = 'B-controller-only';
  const externalTree = join(root, '.worktrees', externalId);
  git(root, ['worktree', 'add', '-qb', `story/${externalId}`, externalTree]);
  write(root, `.proof-or-stop/story/actives/${externalId}/index.json`, JSON.stringify({ ...originalStory, storyId: externalId, worktree: { ...originalStory.worktree, path: externalTree, branch: `story/${externalId}` } }));
  write(root, `.proof-or-stop/story/actives/${externalId}/checklist.json`, '{"items":[]}');
  const externalDispatch = spawnSync(process.execPath, [join(repository, 'packages/main/dist/cli.js'), 'dispatch', `--storyId=${externalId}`, '--agentType=proof-or-stop-review-quality'], { cwd: externalTree, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(externalDispatch.status, 0, `external controller bootstrap still projects assets\n${externalDispatch.stderr}`);
  const externalReceipt = join(externalTree, `.proof-or-stop/story/actives/${externalId}`, CONTROLLER_RUNTIME_PROJECTION_STORY_RECEIPT);
  assert.equal(existsSync(externalReceipt), true, 'untracked native hooks receive signed projection evidence');
  rmSync(externalReceipt);
  const recovered = spawnSync(process.execPath, [join(repository, 'packages/main/dist/cli.js'), 'aux_doc_list'], { cwd: externalTree, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(recovered.status, 0, `existing external Story still repairs a missing redundant receipt\n${recovered.stderr}`);
  assert.equal(existsSync(externalReceipt), true, 'the same CLI read restores only the redundant projection receipt');
  assert.equal(inspectExpectedControllerRuntimeProjection({ projectRoot: externalTree, gitCwd: externalTree, storyId: externalId }).valid, true, 'external projection retains complete signed verification');
  console.log('TRACKED_CONFIG_BOOTSTRAP_GREEN: CLI preservation, projection admission and ownership negative controls passed');
} finally { rmSync(root, { recursive: true, force: true }); }
