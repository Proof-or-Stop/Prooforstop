import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
execFileSync(process.execPath, ['scripts/ensure-dist.mjs'], { cwd: repo, stdio: 'inherit' });
const { CONFIG_FILENAMES } = await import('../dist/core/brand-paths.js');
const sourcePath = join(repo, 'packages/main/src/tasks/validate-execution-lock-smoke.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
const matches = ast.statements.filter(node => ts.isFunctionDeclaration(node)
  && node.name?.text === 'assertProtectedInventoryAndTimeoutSourcesUnchanged');
assert.equal(matches.length, 1, 'execute exactly the actual smoke group source');
const emitted = ts.transpileModule(matches[0].getText(ast) + '\nassertProtectedInventoryAndTimeoutSourcesUnchanged();',
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const root = fs.mkdtempSync(join(tmpdir(), 'protected-inventory-caller-'));
const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const git = (cwd, args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
const write = (file, content) => { fs.mkdirSync(dirname(join(root, file)), { recursive: true }); fs.writeFileSync(join(root, file), content); };
try {
  const config = { validate: { commands: [{ command: 'node', args: ['original.js'], timeoutMs: 120000 }] },
    storyScopeBudget: { limits: { responsibilityDomains: 1 } } };
  write(CONFIG_FILENAMES[0], JSON.stringify(config));
  write('package.json', JSON.stringify({ scripts: { test: 'node original.js' } }));
  write('packages/main/package.json', JSON.stringify({ scripts: { build: 'tsc' } }));
  write('packages/main/src/tasks/full-suite-runner.ts', 'export const timeout = 120_000;\n');
  write('packages/main/src/tasks/full-suite-runner-smoke.ts', 'export const thresholds = [180_000, 300_000];\n');
  git(root, ['init', '-q', '-b', 'main']); git(root, ['add', '.']); git(root, ['commit', '-qm', 'baseline']);
  git(root, ['switch', '-c', 'story/legitimate-feature']);
  config.validate.commands.push({ command: 'node', args: ['feature.js'], timeoutMs: 180000 });
  write(CONFIG_FILENAMES[0], JSON.stringify(config));
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'intentional feature registration']);
  const headBefore = git(root, ['rev-parse', 'HEAD']);
  const bytesBefore = fs.readFileSync(join(root, CONFIG_FILENAMES[0]), 'utf8');
  const created = [], messages = [];
  const context = { ...fs, assert, execFileSync, tmpdir, dirname, join, CONFIG_FILENAMES, git,
    repoRoot: () => root,
    mkdtempSync: prefix => { const value = fs.mkdtempSync(prefix); created.push(value); return value; },
    console: { log: message => messages.push(String(message)) },
  };
  assert.doesNotThrow(() => runInNewContext(emitted, context, { timeout: 30000 }),
    'repeatable inventory regression must run on a legitimate feature branch');
  assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore, 'caller Git history remains unchanged');
  assert.equal(git(root, ['status', '--porcelain']), '', 'caller worktree remains clean');
  assert.equal(fs.readFileSync(join(root, CONFIG_FILENAMES[0]), 'utf8'), bytesBefore);
  assert.ok(created.length > 0, 'the regression owns its mutation fixture');
  assert.ok(created.every(path => !fs.existsSync(path)), 'owned mutation fixtures are removed');
  assert.ok(messages.some(message => message.startsWith('PROTECTED_INVENTORY_MUTATIONS_PASS ')),
    'the real smoke group must execute its committed and working mutation controls');
  console.log('PROTECTED_INVENTORY_FIXTURE_PASS: actual-source test group; real Git mutations; caller untouched');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
