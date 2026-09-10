#!/usr/bin/env node
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as child from 'node:child_process';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { RUNTIME_ARTIFACT_REGISTRY } from '../dist/core/runtime-artifact-registry.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = fs.readFileSync(path.join(repo, 'packages/main/tests/canonical-new-story-artifacts.test.mjs'), 'utf8');
const ast = ts.createSourceFile('actual-test.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = ['git', 'snapshotGitMaterial', 'publicFixtureProjection', 'createPublicOperationClone'];
const declarations = ast.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && functions.includes(node.name?.text)) ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(ast) === 'INERT_PUBLIC_FIXTURE_LOG_SUBTREE')),
).map(node => node.getText(ast)).join('\n');
for (const name of ['git', 'snapshotGitMaterial', 'createPublicOperationClone']) assert.ok(declarations.includes(`function ${name}(`));
const seed = fs.mkdtempSync(path.join(tmpdir(), 'proof-or-stop-fixture-read-scope-seed-'));
const fixtureRoots = [];
const retiredRoot = RUNTIME_ARTIFACT_REGISTRY.find(row => row.id === 'retired-generated-cache-deny-only').matchers.find(row => row.kind === 'prefix').value.split('/')[0];
const seedFiles = {
  '.remember/logs/autonomous/old.txt': 'old inert log',
  [`${retiredRoot}/runtime/host-runs/old.jsonl`]: 'R'.repeat(65536),
  [`${retiredRoot}/learning/runtime-memory-pack-cache/old.txt`]: 'C'.repeat(65536),
  [`${retiredRoot}/runtime/framework-audit/state.json`]: '{}\n',
  [`${retiredRoot}/learning/finding-signals.json`]: '{}\n',
  [`${retiredRoot}/learning/playbook-promotion-health.jsonl`]: '{}\n',
  [`${retiredRoot}/learning/playbooks.json`]: '{}\n',
  [`${retiredRoot}/learning/signature-registry.json`]: '{}\n',
  [`${retiredRoot}/runtime/not-declared/protected.txt`]: 'keep unknown runtime bytes',
  '.proof-or-stop/story/actives/B-49df/protected.txt': 'keep target evidence',
  '.proof-or-stop/story/actives/B-022e/protected.txt': 'keep historical sample',
  '.proof-or-stop/story/actives/B-unrelated/history.txt': 'H'.repeat(65536),
  '.proof-or-stop/story/actives/B-49df-other/history.txt': 'P'.repeat(65536),
  '.proof-or-stop/story/actives/index.txt': 'keep direct index',
  '.proof-or-stop/story/other/protected.txt': 'keep unspecified Story area',
  '.proof-or-stop/runtime/protected.txt': 'keep current runtime',
  'code.txt': 'keep implementation',
  'packages/main/dist/probe.js': 'export {};\n',
  'packages/main/templates/probe.md': 'template',
};
const retired = RUNTIME_ARTIFACT_REGISTRY.find(row => row.id === 'retired-generated-cache-deny-only');
assert.ok(retired);
const retiredPath = name => retired.matchers.some(m => m.kind === 'prefix' ? name.startsWith(m.value) : m.kind === 'exact' && name === m.value);
const expectedOmitted = Object.keys(seedFiles).filter(name => retiredPath(name) || name.startsWith('.remember/logs/autonomous/') || name.includes('/B-unrelated/') || name.includes('/B-49df-other/'));
const retained = Object.keys(seedFiles).filter(name => !expectedOmitted.includes(name));
let clone;
try {
  for (const [name, bytes] of Object.entries(seedFiles)) {
    const absolute = path.join(seed, name);fs.mkdirSync(path.dirname(absolute), { recursive: true });fs.writeFileSync(absolute, bytes);
  }
  fs.mkdirSync(path.join(seed, 'node_modules'));
  child.execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  child.execFileSync('git', ['add', '.'], { cwd: seed });
  child.execFileSync('git', ['-c', 'user.name=Lab fixture', '-c', 'user.email=lab@example.test', 'commit', '-qm', 'Seed bounded read-scope controls'], { cwd: seed });
  const injected = { ...fs, ...child, ...path, createHash: crypto.createHash, assert, tmpdir, fixtureRoots, repoRoot: seed, mainRoot: seed, packageRoot: path.join(seed, 'packages/main'), ACTIVE_IDENTITY_OPERATION_BOUNDARIES: [], runtimeArtifactRegistry: RUNTIME_ARTIFACT_REGISTRY, installFixtureFindingLedgerPrivateKey: () => assert.fail('No copied trust is needed for these private controls') };
  delete injected.default;
  const actual = new Function(...Object.keys(injected), `${declarations}\nreturn { clone: createPublicOperationClone, snapshot: snapshotGitMaterial, git };`)(...Object.values(injected));
  clone = actual.clone('proof-or-stop-fixture-read-scope-clone-', false);
  const rows = expectedOmitted.map(name => ({ name, absent: fs.lstatSync(path.join(clone, name), { throwIfNoEntry: false }) === undefined }));
  for (const name of retained) assert.equal(fs.readFileSync(path.join(clone, name), 'utf8'), seedFiles[name], `retained path changed: ${name}`);
  const index = actual.git(clone, ['ls-files', '--stage', '-z']);
  assert.equal(index, actual.git(seed, ['ls-files', '--stage', '-z']), 'All indexed paths, modes and blobs remain identical');
  assert.equal(actual.git(clone, ['rev-parse', 'HEAD']), actual.git(seed, ['rev-parse', 'HEAD']));
  const baseline = actual.snapshot(clone);
  let creationControls = 0;
  // Every absent representative remains indexed, including old caches and unrelated Story paths.
  for (const { name, absent } of rows.filter(row => row.absent)) {
    const absolute = path.join(clone, name);fs.mkdirSync(path.dirname(absolute), { recursive: true });
    for (const kind of ['empty', 'nonempty', 'symlink']) {
      try {
        if (kind === 'symlink') fs.symlinkSync('missing-target', absolute);
        else fs.writeFileSync(absolute, kind === 'empty' ? '' : 'unexpected write');
        assert.notEqual(actual.snapshot(clone), baseline, `missed ${kind} at ${name}`);
        assert.equal(actual.git(clone, ['ls-files', '--stage', '-z']), index);
        creationControls++;
      } finally { fs.rmSync(absolute); }
      assert.equal(actual.snapshot(clone), baseline);
    }
  }
  let retainedMutationControls = 0;
  for (const name of retained.filter(name => !name.startsWith('packages/'))) {
    const absolute = path.join(clone, name), bytes = fs.readFileSync(absolute), stat = fs.statSync(absolute);
    try {
      const changed = Buffer.from(bytes);changed[0] ^= 1;fs.writeFileSync(absolute, changed);fs.utimesSync(absolute, stat.atime, stat.mtime);
      assert.notEqual(actual.snapshot(clone), baseline, `missed equal-size/restored-mtime mutation at ${name}`);retainedMutationControls++;
    } finally { fs.writeFileSync(absolute, bytes);fs.utimesSync(absolute, stat.atime, stat.mtime); }
    assert.equal(actual.snapshot(clone), baseline);
  }
  const observedReadBytes = Object.keys(seedFiles).filter(name => fs.lstatSync(path.join(clone, name), { throwIfNoEntry: false })?.isFile()).reduce((n, name) => n + fs.statSync(path.join(clone, name)).size, 0);
  console.log(JSON.stringify({ rows, retained: retained.length, creationControls, retainedMutationControls, observedReadBytes, expectedReadBytes: retained.reduce((n,name)=>n+Buffer.byteLength(seedFiles[name]),0) }, null, 2));
  assert.ok(rows.every(row => row.absent), 'PUBLIC_FIXTURE_HISTORY_READ_BUDGET_RED: unused Story history or retired cache remains materialized');
  assert.equal(creationControls, expectedOmitted.length * 3, 'All omitted categories must have actual write detection controls');
  console.log('PUBLIC_FIXTURE_HISTORY_READ_BUDGET_GREEN');
} finally {
  for (const root of fixtureRoots) { assert.notEqual(root, seed);fs.rmSync(root, { recursive: true, force: true }); }
  fs.rmSync(seed, { recursive: true, force: true });
}
