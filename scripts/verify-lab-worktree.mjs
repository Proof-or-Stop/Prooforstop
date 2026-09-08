#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/lab-worktree.mjs');
const dir = mkdtempSync(join(tmpdir(), 'lab-worktree-test-'));
let checks = 0;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root, path, body) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); };
const commit = (cwd, message) => { git(cwd, 'add', '-A', '--', '.', ':!AGENTS.override.md'); git(cwd, 'commit', '-m', message); };
const cmd = (cwd, args, expected = 0, match) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, npm_config_prefix: join(dir, 'global'), NPM_CONFIG_PREFIX: join(dir, 'global') } });
  const output = (r.stdout || '') + (r.stderr || '');
  assert.equal(r.status, expected, `${args.join(' ')}\n${output}`);
  if (match) assert.match(output, match);
  checks++; return r.stdout || '';
};
function fixture(name) {
  const repo = join(dir, name); mkdirSync(repo);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Lab Test'); git(repo, 'config', 'user.email', 'lab@example.invalid');
  write(repo, '.gitignore', '.worktrees/\n.proof-or-stop/\nbuilt-version\n');
  write(repo, 'CHANGELOG.md', '# Changelog\n');
  for (const rel of ['package.json', 'packages/main/package.json']) write(repo, rel, JSON.stringify({ name: 'proof-or-stop', version: '1.0.0', scripts: { build: 'node ../../build.cjs' } }, null, 2));
  for (const rel of ['package-lock.json', 'packages/main/package-lock.json']) write(repo, rel, JSON.stringify({ name: 'proof-or-stop', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'proof-or-stop', version: '1.0.0' } } }, null, 2));
  write(repo, 'packages/main/src/core/proof-or-stop-brand.ts', "export const PROOF_OR_STOP_CLI_VERSION = '1.0.0';\n");
  for (const name of ['main-write-lock', 'mkdir-lock', 'brand-env', 'brand-paths', 'proof-or-stop-paths', 'runtime-artifact-registry', 'version-bump', 'runtime-version-policy']) {
    write(repo, `packages/main/src/core/${name}.ts`, readFileSync(join(root, `packages/main/src/core/${name}.ts`)));
  }
  write(repo, 'check.cjs', "const fs=require('fs'); if(fs.readFileSync('bug.txt','utf8')!=='fixed'){ console.error('TARGET regression: broken behavior'); process.exit(1); } console.log('target and regression checks passed');\n");
  write(repo, 'bug.txt', 'broken');
  write(repo, 'build.cjs', "const fs=require('fs'); const p=require('path'); const root=p.resolve(__dirname); if(fs.existsSync(p.join(root,'.fail-build'))){process.exit(3)} fs.writeFileSync(p.join(root,'built-version'),JSON.parse(fs.readFileSync(p.join(root,'package.json'))).version);\n");
  write(repo, 'bin/proof-or-stop.js', "console.log('Proof-or-Stop '+require('fs').readFileSync(require('path').join(__dirname,'../built-version'),'utf8'));\n");
  commit(repo, 'fixture baseline'); return repo;
}
const notes = join(dir, 'notes.md'); writeFileSync(notes, 'Fix the reproduced system regression while preserving the existing behavior contract. Verify the target regression and the synchronized built version.');
const finish = name => ['finish', name, '--notes', notes, '--confirm'];
try {
  const repo = fixture('normal');
  cmd(repo, ['create', '../escape'], 1, /NAME/);
  cmd(repo, ['create', 'one']);
  const lab = join(repo, '.worktrees/Lab-one');
  assert.equal(git(lab, 'branch', '--show-current'), 'codex/lab-one');
  cmd(repo, ['create', 'one'], 1, /already/);
  cmd(repo, ['green', 'one'], 1, /recorded RED/);
  cmd(repo, finish('one'), 1, /Fresh GREEN/);
  cmd(repo, ['red', 'one', '--expect', 'unrelated', '--', process.execPath, 'check.cjs'], 1, /not observed/);
  cmd(repo, ['red', 'one', '--expect', 'TARGET regression', '--', process.execPath, 'missing.cjs'], 1, /not observed/);
  cmd(repo, ['red', 'one', '--expect', 'TARGET regression', '--', process.execPath, 'check.cjs']);
  cmd(repo, ['green', 'one'], 1, /Commit a repair/);
  write(lab, 'bug.txt', 'fixed');
  cmd(repo, ['sync', 'one'], 1, /Uncommitted/);
  // A runtime change exercises the real shared version helper and both build stages.
  write(lab, 'packages/main/src/fix.ts', 'export const repaired = true;\n');
  commit(lab, 'fix: target regression');
  cmd(repo, ['green', 'one']);
  write(repo, 'unrelated.txt', 'pending');
  cmd(repo, finish('one'), 1, /Uncommitted/); assert.ok(existsSync(lab));
  rmSync(join(repo, 'unrelated.txt'));
  write(lab, 'extra.txt', 'another bounded check'); commit(lab, 'test: cover edge');
  cmd(repo, finish('one'), 1, /Fresh GREEN/);
  cmd(repo, ['green', 'one']);
  write(repo, 'main-advance.txt', 'concurrent main change'); commit(repo, 'docs: advance main');
  const before = git(repo, 'rev-parse', 'HEAD');
  cmd(repo, ['finish', 'one', '--notes', notes], 1, /--confirm/);
  cmd(repo, finish('one'), 0, /worktree and branch removed/);
  assert.ok(!existsSync(lab)); assert.equal(git(repo, 'branch', '--list', 'codex/lab-one'), '');
  assert.notEqual(git(repo, 'rev-parse', 'HEAD'), before);
  assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'))).version, '1.0.1');
  assert.match(readFileSync(join(repo, 'CHANGELOG.md'), 'utf8'), /Lab one - v1.0.1/);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(JSON.parse(cmd(repo, ['status', 'one'])).phase, 'closed');
  cmd(repo, finish('one'), 1, /already integrated/);

  const retry = fixture('retry'); cmd(retry, ['create', 'retry']);
  const retryLab = join(retry, '.worktrees/Lab-retry');
  cmd(retry, ['red', 'retry', '--expect', 'TARGET regression', '--', process.execPath, 'check.cjs']);
  write(retryLab, 'bug.txt', 'fixed'); write(retryLab, 'packages/main/src/fix.ts', 'export const fixed = true;'); commit(retryLab, 'fix: retry target'); cmd(retry, ['green', 'retry']);
  // Ignored marker makes main build fail only AFTER successful candidate verification.
  write(retry, '.git/info/exclude', '.fail-build\n'); write(retry, '.fail-build', 'fail');
  cmd(retry, finish('retry'), 1, /Build failed/);
  assert.ok(existsSync(retryLab)); assert.equal(JSON.parse(cmd(retry, ['status', 'retry'])).phase, 'integrated');
  rmSync(join(retry, '.fail-build')); cmd(retry, finish('retry'));
  assert.equal(JSON.parse(readFileSync(join(retry, 'package.json'))).version, '1.0.1');

  const docs = fixture('docs'); cmd(docs, ['create', 'docs']);
  const docsLab = join(docs, '.worktrees/Lab-docs');
  cmd(docs, ['red', 'docs', '--expect', 'TARGET regression', '--', process.execPath, 'check.cjs']);
  write(docsLab, 'bug.txt', 'fixed'); commit(docsLab, 'docs: repair non-runtime content');
  cmd(docs, ['green', 'docs']); cmd(docs, finish('docs'));
  assert.equal(JSON.parse(readFileSync(join(docs, 'package.json'))).version, '1.0.0');
  assert.ok(!existsSync(join(docs, 'built-version')));

  const reopen = fixture('reopen'); cmd(reopen, ['create', 'reopen']);
  const reopenLab = join(reopen, '.worktrees/Lab-reopen');
  cmd(reopen, ['red', 'reopen', '--expect', 'TARGET regression', '--', process.execPath, 'check.cjs']);
  write(reopenLab, 'bug.txt', 'fixed'); write(reopenLab, 'packages/main/src/fix.ts', 'export const fixed = true;');
  commit(reopenLab, 'fix: reopen target'); cmd(reopen, ['green', 'reopen']);
  write(reopen, '.git/info/exclude', '.fail-build\n'); write(reopenLab, '.fail-build', 'fail');
  cmd(reopen, finish('reopen'), 1, /Build failed/);
  assert.equal(JSON.parse(cmd(reopen, ['status', 'reopen'])).phase, 'prepared');
  write(reopen, 'main-news.txt', 'advance main'); commit(reopen, 'docs: main advanced');
  cmd(reopen, finish('reopen'), 1, /main moved/);
  cmd(reopen, ['reopen', 'reopen'], 1, /--confirm/);
  const candidate = JSON.parse(cmd(reopen, ['status', 'reopen'])).candidate;
  // This reset is confined to the disposable fixture: a rewritten Lab must not
  // let reopen revert release content against an unrelated commit.
  git(reopenLab, 'reset', '--hard', 'main');
  cmd(reopen, ['reopen', 'reopen', '--confirm'], 1, /not integrated/);
  git(reopenLab, 'reset', '--hard', candidate);
  cmd(reopen, ['reopen', 'reopen', '--confirm']);
  assert.equal(JSON.parse(readFileSync(join(reopenLab, 'package.json'))).version, '1.0.0');
  assert.equal(readFileSync(join(reopenLab, 'bug.txt'), 'utf8'), 'fixed');
  rmSync(join(reopenLab, '.fail-build')); cmd(reopen, ['sync', 'reopen']);
  cmd(reopen, finish('reopen'), 1, /Fresh GREEN/);
  cmd(reopen, ['green', 'reopen']); cmd(reopen, finish('reopen'));
  assert.equal(JSON.parse(readFileSync(join(reopen, 'package.json'))).version, '1.0.1');

  const linked = fixture('linked'); cmd(linked, ['create', 'linked']);
  const linkedLab = join(linked, '.worktrees/Lab-linked');
  cmd(linked, ['red', 'linked', '--expect', 'TARGET regression', '--', process.execPath, 'check.cjs']);
  write(linkedLab, 'bug.txt', 'fixed'); commit(linkedLab, 'fix: linked target'); cmd(linked, ['green', 'linked']);
  const globalLink = join(dir, 'global/lib/node_modules/proof-or-stop'); mkdirSync(dirname(globalLink), { recursive: true });
  symlinkSync(join(linkedLab, 'packages/main'), globalLink);
  cmd(linked, finish('linked'), 1, /Global package links into Lab/);
  assert.ok(existsSync(linkedLab)); assert.equal(JSON.parse(cmd(linked, ['status', 'linked'])).phase, 'verified');
  rmSync(globalLink); cmd(linked, finish('linked'));

  const guarded = fixture('guards'); cmd(guarded, ['create', 'guard']);
  const guardLab = join(guarded, '.worktrees/Lab-guard');
  const marker = join(guarded, '.proof-or-stop/locks/main-write.lock'); mkdirSync(marker, { recursive: true });
  writeFileSync(join(marker, 'holder.json'), JSON.stringify({ pid: process.pid, hostname: (await import('node:os')).hostname(), command: 'test active writer', acquiredAt: new Date().toISOString() }));
  cmd(guarded, ['sync', 'guard'], 1, /lock is held/); rmSync(marker, { recursive: true });
  write(guardLab, 'AGENTS.override.md', 'modified by user'); cmd(guarded, ['sync', 'guard'], 1, /Uncommitted/);
  const record = join(guarded, '.git/lab-maintenance/guard.json'); const envelope = JSON.parse(readFileSync(record)); envelope.payload.phase = 'verified'; writeFileSync(record, JSON.stringify(envelope));
  cmd(guarded, ['status', 'guard'], 1, /Invalid Lab record/);
  assert.ok(existsSync(guardLab));
  console.log(`Lab worktree verification passed (${checks} command checks plus state, version and cleanup assertions).`);
} finally { rmSync(dir, { recursive: true, force: true }); }
