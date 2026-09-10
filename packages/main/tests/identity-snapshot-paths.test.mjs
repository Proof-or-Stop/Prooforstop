import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Exercise the actual snapshot oracle without booting its unrelated long suite.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = fs.readFileSync(join(repo, 'packages/main/tests/canonical-new-story-artifacts.test.mjs'), 'utf8');
const ast = ts.createSourceFile('oracle.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const selected = ['git', 'snapshotGitMaterial'].map(name => {
  const fn = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(fn, `Missing actual ${name}`); return fn.getText(ast);
}).join('\n');
const imports = { execFileSync, join, lstatSync: fs.lstatSync, readFileSync: fs.readFileSync, readlinkSync: fs.readlinkSync, createHash };
const actual = new Function(...Object.keys(imports), selected + '\nreturn { snapshotGitMaterial, git };')(...Object.values(imports));
const snapshot = actual.snapshotGitMaterial;
const root = fs.mkdtempSync(join(tmpdir(), 'proof-or-stop-snapshot-paths-'));
const runGit = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const hash = value => createHash('sha256').update(value).digest('hex');
const rows = [];
const rawProtocolRows = [];
try {
  runGit(['init', '-q']);
  for (const name of [' leading.txt', 'plain.txt', '中文.txt', 'tab\tfile.txt', 'line\nfile.txt', 'quote"file.txt', 'slash\\file.txt', 'trailing.txt ']) {
    const file = join(root, name);
    fs.writeFileSync(file, 'before'); runGit(['add', '--', name]);
    rawProtocolRows.push({ name, pass: actual.git(root, ['ls-files', '-z']) === `${name}\0` });
    const baseline = snapshot(root);
    const expectedBefore = `${name}\0${hash('before')}`;
    const stat = fs.statSync(file);
    fs.writeFileSync(file, 'after!'); fs.utimesSync(file, stat.atime, stat.mtime);
    const after = snapshot(root);
    const expectedAfter = `${name}\0${hash('after!')}`;
    rows.push({ name, presentBefore: baseline.includes(expectedBefore), presentAfter: after.includes(expectedAfter), mutationDetected: baseline !== after });
    runGit(['rm', '-f', '--', name]);
  }
  // Untracked additions and tracked deletions must remain observable as well.
  fs.writeFileSync(join(root, '新增\t.txt'), 'new');
  rows.push({ name: 'untracked', pass: snapshot(root).includes(`新增\t.txt\0${hash('new')}`) });
  runGit(['add', '--', '新增\t.txt']); fs.unlinkSync(join(root, '新增\t.txt'));
  rows.push({ name: 'deleted', pass: snapshot(root).includes('新增\t.txt\0deleted') });
  fs.symlinkSync('missing-target', join(root, '符号\tlink'));
  rows.push({ name: 'dangling-symlink', pass: snapshot(root).includes(`符号\tlink\0symlink:${hash('missing-target')}`) });
  const failed = rows.filter(r => r.pass === false || r.presentBefore === false || r.presentAfter === false || r.mutationDetected === false);
  const rawFailures = rawProtocolRows.filter(r => !r.pass);
  console.log(JSON.stringify({ rows, failures: failed.length, rawProtocolRows, rawFailures: rawFailures.length }, null, 2));
  assert.equal(failed.length + rawFailures.length, 0, 'IDENTITY_SNAPSHOT_PATH_RED: a valid Git filename was missed by the protected-state oracle');
  console.log('IDENTITY_SNAPSHOT_PATH_GREEN');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
