import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import ts from 'typescript';

// Execute this checkout's actual source; no dist sharing or alternate resolver.
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('.ts') && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(source)) return next(source.href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.endsWith('.ts')) return next(url, context);
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText };
  },
});
const { resolveRepositoryBaseline } = await import('../packages/main/src/core/git-baseline.ts');
const { readChangedFiles, checkScopeContract } = await import('../packages/main/src/core/scope-contract.ts');
const { buildScopeDiffPack } = await import('../packages/main/src/core/scope-diff-pack.ts');
const { SCOPE_PATH_CANONICALIZER_VERSION } = await import('../packages/main/src/core/scope-path-classifier.ts');
const temporary = [];
function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function fixture(primary = 'main', remoteBranch = primary) {
  const root = mkdtempSync(join(tmpdir(), 'local-main-baseline-'));
  temporary.push(root);
  const main = join(root, 'primary');
  const work = join(root, 'linked');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', primary);
  git(main, 'config', 'user.name', 'Lab Fixture');
  git(main, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(main, 'owned-unstaged.ts'), 'export const value = 1;\n');
  git(main, 'add', '.'); git(main, 'commit', '-qm', 'common baseline');
  const base = git(main, 'rev-parse', 'HEAD');
  git(main, 'update-ref', 'refs/remotes/origin/' + remoteBranch, base);
  git(main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/' + remoteBranch);
  git(main, 'worktree', 'add', '-qb', 'story/B-fixture', work, base);
  writeFileSync(join(main, 'main-only.ts'), 'export const importedMain = 1;\n');
  git(main, 'add', '.'); git(main, 'commit', '-qm', 'local integration advances');
  const local = git(main, 'rev-parse', 'HEAD');
  git(work, 'merge', '--ff-only', primary);
  return { root, main, work, base, local, primary, remoteBranch };
}
function contract(paths = ['allowed-unused.ts']) {
  return {
    storyId: 'B-fixture', mode: 'enforce', allowedModify: paths, allowedCreate: paths,
    allowedTest: [], protectedFiles: [], explicitExcludes: [], acknowledgements: [],
    pathCanonicalizerVersion: SCOPE_PATH_CANONICALIZER_VERSION, pathCanonicalizationMode: 'enforce',
    createdAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z',
  };
}
try {
  const f = fixture();
  const owned = ['owned-committed.ts', 'owned-staged.ts', 'owned-unstaged.ts', 'owned-untracked.ts'];
  writeFileSync(join(f.work, owned[0]), 'export const committed = 1;\n');
  git(f.work, 'add', owned[0]); git(f.work, 'commit', '-qm', 'Story implementation');
  writeFileSync(join(f.work, owned[1]), 'export const staged = 1;\n'); git(f.work, 'add', owned[1]);
  writeFileSync(join(f.work, owned[2]), 'export const value = 2;\n');
  writeFileSync(join(f.work, owned[3]), 'export const untracked = 1;\n');
  const changed = readChangedFiles(f.work);
  const rejected = checkScopeContract(contract(), changed, { projectRoot: f.work, gitCwd: f.work });
  for (const path of owned) {
    assert.ok(changed.includes(path), 'native changed-file control ' + path);
    assert.ok(rejected.violations.some(row => row.path === path), 'native scope still blocks ' + path);
  }
  const pack = buildScopeDiffPack(f.work);
  assert.ok(pack.changedFiles.includes(owned[0]), 'native diff pack control');
  console.log('LOCAL_BASELINE setup: actual committed/staged/unstaged/untracked scope controls PASS');
  console.log('LOCAL_BASELINE observed ' + JSON.stringify({ baseline: resolveRepositoryBaseline(f.work), changed, violations: rejected.violations.map(row => row.path), packFiles: pack.changedFiles }));
  assert.equal(changed.includes('main-only.ts'), false, 'LOCAL_MAIN_BASELINE_FALSE_SCOPE: imported local-main file must not be Story scope');
  assert.equal(rejected.violations.some(row => row.path === 'main-only.ts'), false);
  assert.equal(pack.changedFiles.includes('main-only.ts'), false);
  assert.equal(pack.hunks.some(row => row.path === 'main-only.ts'), false);
  assert.equal(checkScopeContract(contract(owned), changed, { projectRoot: f.work, gitCwd: f.work }).status, 'pass');
  assert.equal(resolveRepositoryBaseline(f.work).ref, 'refs/heads/main');
  writeFileSync(join(f.work, 'main-only.ts'), 'export const importedMain = 2;\n');
  const editedImport = readChangedFiles(f.work);
  assert.ok(editedImport.includes('main-only.ts'), 'Story edits to an imported path remain visible');
  assert.ok(checkScopeContract(contract(owned), editedImport, { projectRoot: f.work, gitCwd: f.work }).violations.some(row => row.path === 'main-only.ts'));
  assert.ok(buildScopeDiffPack(f.work).hunks.some(row => row.path === 'main-only.ts'));
  console.log('LOCAL_BASELINE native scope and diff GREEN');

  const controls = [];
  const candidateCache = new Map();
  function expectRef(label, instance, ref, cwd = instance.work) {
    const direct = resolveRepositoryBaseline(cwd);
    const cached = resolveRepositoryBaseline(cwd, 'HEAD', { candidateCache });
    assert.equal(direct?.ref, ref, label);
    assert.equal(cached?.ref, direct?.ref, label + ' cached selection');
    assert.equal(cached?.mergeBase, direct?.mergeBase, label + ' cached ancestry');
    controls.push(label);
  }
  for (const branch of ['master', 'develop']) {
    const instance = fixture(branch);
    expectRef(branch + ' same-name local advancement', instance, 'refs/heads/' + branch);
    assert.equal(readChangedFiles(instance.work).includes('main-only.ts'), false);
  }
  const ahead = fixture();
  const aheadCommit = git(ahead.main, 'commit-tree', git(ahead.main, 'rev-parse', 'HEAD^{tree}'), '-p', ahead.local, '-m', 'remote ahead');
  git(ahead.main, 'update-ref', 'refs/remotes/origin/main', aheadCommit);
  expectRef('remote ahead', ahead, 'refs/remotes/origin/main');

  const diverged = fixture();
  const divergedCommit = git(diverged.main, 'commit-tree', git(diverged.main, 'rev-parse', diverged.base + '^{tree}'), '-p', diverged.base, '-m', 'remote divergence');
  git(diverged.main, 'update-ref', 'refs/remotes/origin/main', divergedCommit);
  expectRef('diverged tips', diverged, 'refs/remotes/origin/main');

  const different = fixture('develop', 'main');
  expectRef('different primary branch', different, 'refs/remotes/origin/main');
  const detached = fixture();
  git(detached.main, 'checkout', '--detach', '-q');
  expectRef('detached primary', detached, 'refs/remotes/origin/main');
  const ordinary = fixture();
  expectRef('ordinary primary checkout', ordinary, 'refs/remotes/origin/main', ordinary.main);
  expectRef('linked checkout shares Git directory but keeps its selection policy', ordinary, 'refs/heads/main');
  const snapshot = resolveRepositoryBaseline(ordinary.work, 'HEAD', { candidateCache });
  git(ordinary.main, 'update-ref', 'refs/heads/main', ordinary.base);
  assert.equal(resolveRepositoryBaseline(ordinary.work, 'HEAD', { candidateCache }).commit, snapshot.commit,
    'one observation keeps the baseline commit it actually observed');
  assert.equal(resolveRepositoryBaseline(ordinary.work, 'HEAD', { candidateCache: new Map() }).commit, ordinary.base,
    'a new observation sees changed refs');
  git(ordinary.work, 'checkout', '--orphan', 'unrelated-head', '-q');
  git(ordinary.work, 'commit', '--allow-empty', '-qm', 'independent history');
  assert.equal(resolveRepositoryBaseline(ordinary.work, 'HEAD', { candidateCache }), undefined,
    'a cached repository candidate cannot supply ancestry to an unrelated HEAD');
  controls.push('observation snapshot and unrelated HEAD isolation');
  const missing = fixture('develop');
  git(missing.main, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  expectRef('missing remote HEAD', missing, 'refs/heads/develop');
  const invalid = fixture();
  git(invalid.main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/missing');
  expectRef('unresolvable remote HEAD', invalid, 'refs/heads/main');
  const poison = fixture('master');
  git(poison.main, 'update-ref', 'refs/remotes/origin/story/poison', poison.local);
  git(poison.main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/story/poison');
  expectRef('remote Story ref poison', poison, 'refs/heads/master');
  const localPoison = fixture('story/primary', 'story/primary');
  assert.equal(resolveRepositoryBaseline(localPoison.work), undefined, 'local and remote Story refs remain ineligible');
  controls.push('local Story ref poison');
  console.log('LOCAL_BASELINE fallback controls PASS ' + JSON.stringify(controls));

} finally {
  for (const root of temporary) rmSync(root, { recursive: true, force: true });
}
