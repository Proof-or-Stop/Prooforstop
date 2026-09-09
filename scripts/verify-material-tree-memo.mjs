import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const original = cp.execFileSync;
let trees = 0;
cp.execFileSync = function(command, args, ...rest) {
  if (command === 'git' && args[0] === 'ls-tree') trees++;
  return original.call(this, command, args, ...rest);
};
syncBuiltinESMExports();
const { currentMaterialHash } = await import('../packages/main/src/core/evidence-freshness.ts');
const root = mkdtempSync(join(tmpdir(), 'material-memo-'));
const git = (...args) => original('git', args, { cwd: root, stdio: 'pipe' });
try {
  git('init', '-b', 'main');
  git('config', 'user.name', 'Memo witness');
  git('config', 'user.email', 'memo@example.invalid');
  writeFileSync(join(root, 'source.txt'), 'first');
  git('add', '.'); git('commit', '-m', 'first');
  const before = currentMaterialHash(root);
  assert.ok(before);
  for (let i = 0; i < 5; i++) assert.equal(currentMaterialHash(root), before);
  assert.equal(trees, 1, 'U17: repeated committed material reads must enumerate one tree');
  writeFileSync(join(root, 'source.txt'), 'second');
  git('add', '.'); git('commit', '-m', 'second');
  assert.notEqual(currentMaterialHash(root), before);
  assert.equal(trees, 2);
  git('commit', '--allow-empty', '-m', 'new HEAD with identical tree');
  assert.notEqual(currentMaterialHash(root), before);
  assert.equal(trees, 3, 'U17: a new HEAD must refresh the process memo');
  const originalHead = git('rev-parse', 'HEAD').toString().trim();
  const originalHash = currentMaterialHash(root);
  writeFileSync(join(root, 'source.txt'), 'replacement');
  git('add', '.'); git('commit', '-m', 'replacement tree');
  const replacementHead = git('rev-parse', 'HEAD').toString().trim();
  const replacementHash = currentMaterialHash(root);
  assert.equal(currentMaterialHash(root, originalHead), originalHash);
  git('replace', originalHead, replacementHead);
  assert.equal(currentMaterialHash(root, originalHead), replacementHash,
    'U17: replacement refs must invalidate cached committed trees');
  git('pack-refs', '--all');
  assert.equal(currentMaterialHash(root, originalHead), replacementHash, 'packed replacement refs remain visible');
  const oldNoReplace = process.env.GIT_NO_REPLACE_OBJECTS;
  try {
    process.env.GIT_NO_REPLACE_OBJECTS = '1';
    assert.equal(currentMaterialHash(root, originalHead), originalHash, 'disabled replacement uses original bytes');
    delete process.env.GIT_NO_REPLACE_OBJECTS;
    assert.equal(currentMaterialHash(root, originalHead), replacementHash, 'reenabled replacement cannot reuse original bytes');
  } finally {
    if (oldNoReplace === undefined) delete process.env.GIT_NO_REPLACE_OBJECTS;
    else process.env.GIT_NO_REPLACE_OBJECTS = oldNoReplace;
  }
  git('replace', '-d', originalHead);
  assert.equal(currentMaterialHash(root, originalHead), originalHash,
    'deleting a replacement must restore the original tree');
  const oldBase = process.env.GIT_REPLACE_REF_BASE;
  try {
    process.env.GIT_REPLACE_REF_BASE = 'refs/lab-replacements/';
    git('update-ref', `refs/lab-replacements/${originalHead}`, replacementHead);
    assert.equal(currentMaterialHash(root, originalHead), replacementHash, 'custom replacement namespace invalidates memo');
    git('update-ref', '-d', `refs/lab-replacements/${originalHead}`);
    assert.equal(currentMaterialHash(root, originalHead), originalHash);
  } finally {
    if (oldBase === undefined) delete process.env.GIT_REPLACE_REF_BASE;
    else process.env.GIT_REPLACE_REF_BASE = oldBase;
  }
  assert.equal(currentMaterialHash(root, 'missing'), undefined);
  console.log('PASS U17 material-tree-memo');
} finally {
  cp.execFileSync = original; syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
}
