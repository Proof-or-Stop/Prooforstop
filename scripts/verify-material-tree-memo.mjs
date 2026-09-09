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
  assert.equal(currentMaterialHash(root, 'missing'), undefined);
  console.log('PASS U17 material-tree-memo');
} finally {
  cp.execFileSync = original; syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
}
