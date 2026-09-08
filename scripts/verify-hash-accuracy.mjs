#!/usr/bin/env node
// Golden hashes originate from an independent declared-file Python oracle.
import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const M = await import('../packages/main/src/core/evidence-freshness.ts');
const fixture = JSON.parse(readFileSync(new URL('./test-data/hash-accuracy-oracle.json', import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'proof-hash-oracle-'));
const env = { ...process.env, GIT_AUTHOR_NAME: 'Hash oracle', GIT_AUTHOR_EMAIL: 'hash@example.test', GIT_COMMITTER_NAME: 'Hash oracle', GIT_COMMITTER_EMAIL: 'hash@example.test' };
const git = (args, input) => execFileSync('git', args, { cwd: root, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const blobs = new Map();
function commit(manifest, parent) {
  git(['read-tree', '--empty']);
  let records = '';
  for (const [path, bytes] of Object.entries(manifest)) {
    if (!blobs.has(bytes)) blobs.set(bytes, git(['hash-object', '-w', '--stdin'], bytes));
    records += `100644 ${blobs.get(bytes)}\t${path}\0`;
  }
  git(['update-index', '-z', '--index-info'], records);
  return git(['commit-tree', git(['write-tree']), ...(parent ? ['-p', parent] : [])], 'Hash oracle fixture\n');
}
try {
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'proof-or-stop.config.json'), fixture.base['proof-or-stop.config.json']);
  const base = commit(fixture.base);
  const other = commit({ ...fixture.base, 'src/unrelated-base.mjs': 'export const unrelatedBase = 1;\n' }, base);
  const failures = [];
  const actuals = new Map();
  for (const test of fixture.cases) {
    const parent = test.unrelatedBase ? other : base;
    const files = { ...fixture.base, ...test.changes };
    for (const path of test.remove) delete files[path];
    const head = commit(files, parent);
    git(['update-ref', 'refs/heads/main', parent]);
    git(['update-ref', 'refs/heads/witness', head]);
    git(['symbolic-ref', 'HEAD', 'refs/heads/witness']);
    const actual = { materialHash: M.currentMaterialHash(root, head, root), storyFilesHash: M.currentStoryFilesHash(root, head, root) };
    actuals.set(test.name, actual);
    try { assert.deepEqual(actual, test.expected); } catch { failures.push(test.name); }
  }
  assert.equal(M.currentMaterialHash(root, 'missing-ref-oracle'), undefined);
  assert.equal(M.currentStoryFilesHash(root, 'missing-ref-oracle'), undefined);
  for (const kind of ['unicode', 'tab']) {
    if (actuals.get(`${kind}-material-path`).storyFilesHash === actuals.get(`${kind}-content-change`).storyFilesHash) failures.push(`${kind}-content-must-invalidate`);
  }
  console.log(`Exact independent oracle: ${fixture.cases.length - fixture.cases.filter(c => failures.includes(c.name)).length}/${fixture.cases.length}`);
  assert.equal(failures.length, 0, `HASH_ORACLE_MISMATCH: ${failures.join(', ')}`);
  console.log('HASH_ACCURACY_GREEN: independent digests and content invalidation passed');
} finally { rmSync(root, { recursive: true, force: true }); }
