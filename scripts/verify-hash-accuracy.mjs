#!/usr/bin/env node
// Golden hashes originate from an independent declared-file Python oracle.
import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const M = await import('../packages/main/src/core/evidence-freshness.ts');
const store = await import('../packages/main/src/core/evidence/artifact-store.ts');
const policy = await import('../packages/main/src/core/material-path-policy.ts');
const resolver = await import('../packages/main/src/core/story-aware-validation.ts');
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
  // Independent path/blob oracle beyond the historical 27 cases.
  git(['update-ref', 'refs/heads/main', base]);
  const hashRows = rows => createHash('sha256').update(rows.sort().join('\0')).digest('hex');
  for (const path of ['src/line\nbreak.mjs', 'src/literal\\name.mjs', 'src/ trailing .mjs', 'src/quote"name.mjs']) {
    const first = commit({ ...fixture.base, [path]: 'first bytes' }, base);
    const second = commit({ ...fixture.base, [path]: 'second bytes' }, base);
    assert.equal(M.currentStoryFilesHash(root, first), hashRows([`${path}\0${blobs.get('first bytes')}`]));
    assert.equal(M.currentStoryFilesHash(root, second), hashRows([`${path}\0${blobs.get('second bytes')}`]));
    const target = `${path}.renamed`;
    const renamed = commit({ ...fixture.base, [target]: 'first bytes' }, first);
    const changed = resolver.resolveStoryChangedFiles(root, renamed, root, first);
    assert.ok(changed.some(row => row.path === path && row.blobId === '<deleted>'));
    assert.ok(changed.some(row => row.path === target && row.blobId === blobs.get('first bytes')));
  }
  for (const path of ['.proof-or-stop/evidence/policy.json', '.proof-or-stop/evidence/objects/policy.json', '.proof-or-stop/evidence/ledger/rules.json', '.proof-or-stop/evidence-source/a.ts']) {
    assert.equal(policy.isMaterialExcludedPath(path, root), false, `${path} must remain material`);
    const head = commit({ ...fixture.base, [path]: 'material rule' }, base);
    assert.notEqual(M.currentMaterialHash(root, head), M.currentMaterialHash(root, base));
  }
  // Exercise this checkout's actual store, not a frozen foreign implementation.
  const artifact = store.writeArtifact(root, { artifactKind: 'repro-probe', evidenceScope: 'evidence-candidate', subjectBinding: { candidateId: 'hash-oracle' }, payload: { output: 'completed' } });
  const outputs = {};
  for (const dir of ['objects/sha256', 'refs/by-id', 'ledger']) {
    for (const name of readdirSync(join(root, '.proof-or-stop/evidence', dir))) {
      const path = `.proof-or-stop/evidence/${dir}/${name}`;
      outputs[path] = readFileSync(join(root, path), 'utf8');
    }
  }
  const published = commit({ ...fixture.base, ...outputs }, base);
  git(['update-ref', 'refs/heads/witness', published]);
  assert.equal(M.currentMaterialHash(root, published), M.currentMaterialHash(root, base));
  assert.equal(M.currentStoryFilesHash(root, published), M.currentStoryFilesHash(root, base));
  assert.equal(M.checkEvidenceFreshnessForGit(root, base, M.currentMaterialHash(root, base), root, M.currentStoryFilesHash(root, base)).fresh, true);
  assert.equal(store.verifyArtifactDigest(store.readArtifact(root, artifact.artifactId), artifact.artifactDigest), true);
  const objectPath = `.proof-or-stop/evidence/objects/sha256/${artifact.artifactDigest}.json`;
  const corrupted = { ...artifact, payload: { output: 'tampered' } };
  writeFileSync(join(root, objectPath), JSON.stringify(corrupted));
  assert.throws(
    () => store.readArtifact(root, artifact.artifactId),
    /artifact object integrity mismatch/,
    'the strict artifact reader must reject tampered object bytes before a consumer can inspect them',
  );
  assert.equal(store.verifyArtifactDigest({ ...artifact, subjectBinding: { candidateId: 'wrong-subject' } }, artifact.artifactDigest), false);
  const tamperedHead = commit({ ...fixture.base, ...outputs, [objectPath]: JSON.stringify(corrupted) }, published);
  assert.equal(M.currentMaterialHash(root, tamperedHead), M.currentMaterialHash(root, published));
  const broken = commit({ ...fixture.base, 'src/add.mjs': 'export function add(a,b) { return a-b; }\n' }, base);
  git(['update-ref', 'refs/heads/witness', broken]);
  assert.equal(M.checkEvidenceFreshnessForGit(root, base, M.currentMaterialHash(root, base), root, M.currentStoryFilesHash(root, base)).fresh, false);
  console.log('HASH_ACCURACY_GREEN: 27 independent digests; special paths, production store publication, tampering, subject binding and material invalidation passed');
} finally { rmSync(root, { recursive: true, force: true }); }
