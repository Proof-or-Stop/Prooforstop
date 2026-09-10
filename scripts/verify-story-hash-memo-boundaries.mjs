import assert from 'node:assert/strict';
import cp, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const repo = resolve(process.argv[2] ?? process.cwd());
const originalExec = cp.execFileSync;
let diffCalls = 0;
cp.execFileSync = function(command, args, ...rest) {
  if (command === 'git' && args?.[0] === 'diff') diffCalls++;
  return originalExec.call(this, command, args, ...rest);
};
syncBuiltinESMExports();
const moduleUrl = pathToFileURL(join(repo, 'packages/main/dist/core/evidence-freshness.js')).href;
const { currentStoryFilesHash } = await import(moduleUrl);
const { resetConfigCache } = await import(pathToFileURL(join(repo, 'packages/main/dist/core/config.js')).href);
const parent = mkdtempSync(join(tmpdir(), 'u17-story-boundaries-'));
const root = join(parent, 'repo');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
const commit = message => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', message); return git('rev-parse', 'HEAD'); };
const write = (path, bytes) => { mkdirSync(resolve(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), bytes); };
let assertions = 0;
function matchesCold(label, ref = 'HEAD', metadataRoot = root, cwd = root) {
  const actual = currentStoryFilesHash(cwd, ref, metadataRoot);
  const cold = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {currentStoryFilesHash} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify({value:currentStoryFilesHash(...JSON.parse(process.argv[1]))}));`,
    JSON.stringify([cwd, ref, metadataRoot]),
  ], { encoding: 'utf8', env: process.env })).value;
  assert.equal(actual, cold, label);
  assert.equal(currentStoryFilesHash(cwd, ref, metadataRoot), cold, `${label}: repeated hit`);
  assertions += 2;
  console.log(`PASS ${label}`);
  return actual;
}
function bypassesDiffMemo(label, ref = 'HEAD', metadataRoot = root, cwd = root) {
  const before = diffCalls;
  matchesCold(label, ref, metadataRoot, cwd);
  assert.ok(diffCalls - before >= 2, `${label}: both calls must use authoritative Git diff`);
}
function resumesDiffMemo(label) {
  const before = diffCalls;
  matchesCold(label);
  assert.ok(diffCalls - before <= 1, `${label}: repeated default-context calls must resume immutable diff reuse`);
}

try {
  mkdirSync(root); git('init', '-q'); git('checkout', '-qb', 'main');
  write('a.ts', 'export const a = 1;\n'); write('b.ts', 'export const b = 1;\n');
  const base = commit('base'); git('checkout', '-qb', 'story');
  write('a.ts', 'export const a = 2;\n'); write('custom-story/record.txt', 'material until excluded\n');
  const head = commit('story');
  const initial = matchesCold('unchanged target'); assert.equal(typeof initial, 'string');
  git('update-ref', 'refs/heads/main', head);
  assert.notEqual(matchesCold('main advances with unchanged HEAD'), initial);
  assert.equal(git('rev-parse', 'HEAD'), head);
  git('update-ref', 'refs/heads/main', base);
  assert.equal(matchesCold('main returns to previous merge base'), initial);
  git('update-ref', 'refs/remotes/origin/main', base); git('update-ref', '-d', 'refs/heads/main');
  assert.equal(matchesCold('missing main uses origin/main'), initial);
  git('update-ref', 'refs/remotes/origin/main', head);
  assert.notEqual(matchesCold('origin/main advances at unchanged HEAD'), initial);
  git('update-ref', 'refs/heads/main', base); git('update-ref', '-d', 'refs/remotes/origin/main');

  const metadataRoot = join(parent, 'metadata'); mkdirSync(metadataRoot);
  writeFileSync(join(metadataRoot, 'proof-or-stop.config.json'), JSON.stringify({ storyDir: 'custom-story' }));
  const excluded = matchesCold('separate metadata root exclusion', 'HEAD', metadataRoot);
  assert.notEqual(excluded, initial);
  writeFileSync(join(metadataRoot, 'proof-or-stop.config.json'), JSON.stringify({ storyDir: 'different-story-directory' }));
  // Config has an explicit process-lifetime cache. Exercise its existing reload
  // boundary while retaining the new immutable Git memo in the same process.
  resetConfigCache();
  assert.equal(matchesCold('metadata policy reload keeps Git memo but changes exclusion', 'HEAD', metadataRoot), initial);

  write('b.ts', 'export const b = 2;\n'); const changed = commit('HEAD advances');
  assert.notEqual(matchesCold('HEAD advances'), initial);
  git('mv', 'a.ts', 'renamed.ts'); git('rm', '-q', 'b.ts'); commit('rename and delete');
  matchesCold('rename and deletion preserve source and destination');
  git('config', 'diff.renames', 'copies'); bypassesDiffMemo('live diff configuration');
  git('config', '--unset', 'diff.renames');
  write('.gitattributes', '*.ts -diff\n'); bypassesDiffMemo('uncommitted worktree attributes');
  rmSync(join(root, '.gitattributes'));
  write('.git/info/attributes', '*.ts diff\n'); bypassesDiffMemo('live info attributes');
  rmSync(join(root, '.git/info/attributes'));
  write('.gitattributes', 'b.ts -diff\n'); bypassesDiffMemo('attributes for a deleted source path');
  rmSync(join(root, '.gitattributes'));
  resumesDiffMemo('attribute removal restores safe reuse');
  write('.gitattributes', '*.ts -diff\n'); git('add', '.gitattributes'); rmSync(join(root, '.gitattributes'));
  bypassesDiffMemo('attributes retained only in index');
  git('reset', '-q', 'HEAD', '--', '.gitattributes'); resumesDiffMemo('index attribute removal');
  const externalAttributes = join(parent, 'external-attributes');
  writeFileSync(externalAttributes, '*.xx -diff\n');
  symlinkSync(externalAttributes, join(root, '.git/info/attributes'));
  resumesDiffMemo('nonmatching symlinked info attributes');
  writeFileSync(externalAttributes, '*.ts -diff\n');
  bypassesDiffMemo('same-size symlink target content change');
  rmSync(join(root, '.git/info/attributes')); resumesDiffMemo('symlinked attributes removed');
  git('update-index', '--split-index'); bypassesDiffMemo('split-index dependency is not cached');
  git('update-index', '--no-split-index');
  for (const name of readdirSync(join(root, '.git')).filter(name => name.startsWith('sharedindex.'))) rmSync(join(root, '.git', name));
  resumesDiffMemo('ordinary index restores reuse');
  for (const name of ['alternates', 'http-alternates']) {
    write(`.git/objects/info/${name}`, ''); bypassesDiffMemo(`${name} dependency is not cached`);
    rmSync(join(root, '.git/objects/info', name)); resumesDiffMemo(`${name} removed`);
  }

  const oldHome = process.env.HOME, oldXdg = process.env.XDG_CONFIG_HOME;
  const home = join(parent, 'home'), xdg = join(home, '.config');
  mkdirSync(join(xdg, 'git'), { recursive: true });
  try {
    process.env.HOME = home; process.env.XDG_CONFIG_HOME = xdg;
    resumesDiffMemo('empty global configuration candidates');
    writeFileSync(join(home, '.gitconfig'), '[diff]\nalgorithm = histogram\n');
    bypassesDiffMemo('previously absent global config appears');
    rmSync(join(home, '.gitconfig'));
    resumesDiffMemo('global config removed');
    writeFileSync(join(xdg, 'git/attributes'), '*.ts -diff\n');
    bypassesDiffMemo('previously absent global attributes appear');
    rmSync(join(xdg, 'git/attributes'));
    resumesDiffMemo('global attributes removed');
    const newlineHome = join(parent, 'home\nwith-newline'); mkdirSync(newlineHome);
    process.env.HOME = newlineHome;
    bypassesDiffMemo('newline routing input cannot corrupt path discovery');
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
  }

  const beforeReplacement = matchesCold('original explicit HEAD', head);
  // Give the replacement the original base as parent; replacing an ancestor
  // with its descendant would create a synthetic commit-graph cycle.
  const replacement = git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit-tree', git('rev-parse', `${changed}^{tree}`), '-p', base, '-m', 'replacement');
  git('replace', head, replacement); assert.notEqual(matchesCold('replacement enabled', head), beforeReplacement);
  git('pack-refs', '--all'); matchesCold('packed replacement', head);
  const oldNoReplace = process.env.GIT_NO_REPLACE_OBJECTS;
  try { process.env.GIT_NO_REPLACE_OBJECTS = '1'; assert.equal(matchesCold('replacement disabled by environment', head), beforeReplacement); }
  finally { if (oldNoReplace === undefined) delete process.env.GIT_NO_REPLACE_OBJECTS; else process.env.GIT_NO_REPLACE_OBJECTS = oldNoReplace; }
  git('replace', '-d', head); assert.equal(matchesCold('replacement removed', head), beforeReplacement);
  const oldPrefix = process.env.GIT_REPLACE_REF_BASE;
  try {
    process.env.GIT_REPLACE_REF_BASE = 'refs/test-replacement';
    git('update-ref', `refs/test-replacement${head}`, replacement);
    matchesCold('custom replacement prefix without slash', head);
    git('update-ref', '-d', `refs/test-replacement${head}`);
    assert.equal(matchesCold('custom replacement removed', head), beforeReplacement);
  } finally { if (oldPrefix === undefined) delete process.env.GIT_REPLACE_REF_BASE; else process.env.GIT_REPLACE_REF_BASE = oldPrefix; }
  assert.equal(matchesCold('invalid ref never returns cached hash', 'missing-ref'), undefined);

  const alias = join(parent, 'alias'); symlinkSync(root, alias);
  matchesCold('canonical worktree alias', 'HEAD', root, alias);
  const nested = join(root, 'nested'); mkdirSync(nested);
  matchesCold('nested cwd initially uses outer repository', 'HEAD', root, nested);
  const nestedGit = (...args) => execFileSync('git', args, { cwd: nested, encoding: 'utf8', stdio: 'pipe' }).trim();
  nestedGit('init', '-q'); nestedGit('checkout', '-qb', 'main');
  writeFileSync(join(nested, 'nested.ts'), 'first\n'); nestedGit('add', '.');
  nestedGit('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'nested base');
  nestedGit('checkout', '-qb', 'story'); writeFileSync(join(nested, 'nested.ts'), 'second\n'); nestedGit('add', '.');
  nestedGit('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'nested story');
  nestedGit('config', 'diff.algorithm', 'histogram');
  bypassesDiffMemo('new nested Git root uses its own configuration', 'HEAD', nested, nested);
  rmSync(nested, { recursive: true, force: true });
  const oldPath = process.env.PATH;
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const relativeBin = join(root, 'relative-git-bin'); mkdirSync(relativeBin);
  const wrapper = join(relativeBin, 'git');
  const wrapperBytes = suffix => `#!${process.execPath}\nconst r=require('node:child_process').spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);\n// ${suffix}\n`;
  try {
    writeFileSync(wrapper, wrapperBytes('first')); chmodSync(wrapper, 0o755);
    process.env.PATH = `relative-git-bin:${oldPath ?? ''}`;
    matchesCold('relative PATH resolves the executable in the child cwd');
    writeFileSync(wrapper, wrapperBytes('changed executable identity'));
    const before = diffCalls;
    matchesCold('relative executable changed while configuration stayed equal');
    assert.ok(diffCalls > before, 'new executable identity must invalidate the existing raw diff cache');
  } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
  const worktree = join(parent, 'worktree'); git('worktree', 'add', '--detach', worktree, base);
  assert.notEqual(matchesCold('separate linked worktree', 'HEAD', worktree, worktree), initial);
  git('worktree', 'remove', worktree);
  rmSync(root, { recursive: true, force: true }); mkdirSync(root);
  git('init', '-q'); git('checkout', '-qb', 'main'); write('new.ts', 'rebuilt repository\n'); commit('new base');
  git('checkout', '-qb', 'story'); write('new.ts', 'different story\n'); commit('new story');
  assert.notEqual(matchesCold('repository recreated at same path'), initial);
  console.log(`PASS U17 story hash memo boundaries (${assertions} cold/repeated comparisons)`);
} finally { cp.execFileSync = originalExec; syncBuiltinESMExports(); rmSync(parent, { recursive: true, force: true }); }
