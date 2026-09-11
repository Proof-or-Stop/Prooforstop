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
  console.log('LOCAL_BASELINE native scope and diff GREEN');
} finally {
  for (const root of temporary) rmSync(root, { recursive: true, force: true });
}
