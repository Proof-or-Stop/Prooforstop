import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
const repo = fs.realpathSync(process.cwd());
const original = cp.execFileSync;
let observing = false, calls = [];
cp.execFileSync = function(command, args, ...rest) {
  if (observing && command === 'git') calls.push([...args]);
  return original.call(this, command, args, ...rest);
};
syncBuiltinESMExports();
const { getRepoRoot } = await import(pathToFileURL(path.join(repo, 'packages/main/dist/core/worktree-runtime.js')));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-root-efficiency-'));
const main = path.join(base, 'main'), linked = path.join(base, 'linked');
const before = process.cwd();
let checks = 0;
function git(cwd, ...args) { return original('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim(); }
function check(label, cwd, expected, budget = 1) {
  calls = []; observing = true;
  let result;
  try { result = getRepoRoot(cwd); } finally { observing = false; }
  assert.equal(result, fs.realpathSync(expected), label);
  assert.ok(calls.length <= budget, `REPO_ROOT_REDUNDANT_GIT_PROBES: ${label}: ${calls.length} > ${budget}`);
  checks++;
}
try {
  fs.mkdirSync(main);
  git(main, 'init', '-b', 'main');
  git(main, 'config', 'user.name', 'Fixture');
  git(main, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(main, 'file'), 'fixture');
  git(main, 'add', '.'); git(main, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  git(main, 'worktree', 'add', '-b', 'linked', linked);
  // This linked-root case was already correct before the repair. RED detects
  // its redundant subprocesses independently of the subdirectory defect.
  check('linked root', linked, main);
  check('main root', main, main);
  for (const root of [main, linked]) {
    fs.mkdirSync(path.join(root, 'sub'));
    check('subdirectory', path.join(root, 'sub'), main);
  }
  process.chdir(base);
  check('relative main child', 'main/sub', main);
  check('relative linked child', 'linked/sub', main);
  const alias = path.join(base, 'alias'); fs.symlinkSync(linked, alias);
  check('symlinked child', path.join(alias, 'sub'), main);
  check('git internals preserve non-worktree fallback', path.join(main, '.git'), path.join(main, '.git'));
  const bare = path.join(base, 'bare'); git(base, 'init', '--bare', bare);
  check('bare repository fallback', bare, bare);
  const outside = path.join(base, 'outside'), child = path.join(outside, 'child'); fs.mkdirSync(child, { recursive: true });
  check('non-Git fallback', child, child);
  git(outside, 'init'); check('live repository initialization', child, outside);
  const custom = path.join(base, 'custom'), metadata = path.join(base, 'metadata'); fs.mkdirSync(custom);
  git(custom, 'init', '--separate-git-dir', metadata);
  fs.mkdirSync(path.join(custom, 'sub'));
  check('separate Git directory', path.join(custom, 'sub'), custom, 2);
  const multiline = path.join(base, 'line\nrepo'); fs.mkdirSync(multiline); git(multiline, 'init');
  check('embedded newline in repository path', multiline, multiline);
  const moved = path.join(base, 'moved'); git(main, 'worktree', 'move', linked, moved);
  check('moved linked worktree remains live', moved, main);
  const missing = path.join(base, 'missing');
  calls = []; observing = true;
  try { assert.equal(getRepoRoot(missing), missing); } finally { observing = false; }
  assert.ok(calls.length <= 1); checks++;
  console.log(`REPO_ROOT_ONE_PROBE_PASS checks=${checks}`);
} finally {
  process.chdir(before); cp.execFileSync = original; syncBuiltinESMExports();
  fs.rmSync(base, { recursive: true, force: true });
}
