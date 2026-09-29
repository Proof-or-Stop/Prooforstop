#!/usr/bin/env node
import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyLabFixtureSources } from './lab-fixture-sources.mjs';
import { installLabAuditFixtureProviders } from './lab-audit-fixture-provider.mjs';
import { LAB_MAINTENANCE_RUNTIME_REQUIREMENTS as policy } from '../packages/main/src/core/runtime-fact-registry.ts';

// Real CLI execution in disposable repositories; synthetic auditors exercise
// timeout replay during finish, not independent approval of this repair.
assert.equal(policy.auditTimeoutMs, 1800000, 'LAB_TIMEOUT_1800: audit total budget');
assert.equal(policy.commandTimeoutMs, 1800000, 'LAB_TIMEOUT_1800: maintenance default');
assert.equal(policy.auditStartupTimeoutMs, 90000, 'Audit startup budget is unchanged');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/lab-worktree.mjs');
const source = readFileSync(script, 'utf8');
for (const consumer of [
  'function run(cwd, command, timeoutMs = labPolicy.commandTimeoutMs)',
  'timeout: labPolicy.commandTimeoutMs',
  'declaredDeveloper, timeoutMs = labPolicy.commandTimeoutMs',
]) assert(source.includes(consumer), `Registered command budget must reach ${consumer}`);
const temp = mkdtempSync(join(tmpdir(), 'lab-timeout-budget-'));
const bin = installLabAuditFixtureProviders(temp);
const env = { ...process.env, CODEX_THREAD_ID: 'fixture-developer', CLAUDECODE: '',
  PATH: bin + ':' + process.env.PATH, npm_config_prefix: join(temp, 'global'), NPM_CONFIG_PREFIX: join(temp, 'global') };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (cwd, path, body) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), body); };
const commit = cwd => { git(cwd, 'add', '-A', '--', '.', ':!AGENTS.override.md'); git(cwd, 'commit', '-qm', 'test: timeout fixture'); };
const command = (cwd, args, expected = 0, match) => {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
  const output = (result.stdout || '') + (result.stderr || '');
  assert.equal(result.status, expected, `${args.join(' ')}\n${output}`);
  if (match) assert.match(output, match);
  return result.stdout;
};
const state = (repo, name) => JSON.parse(command(repo, ['status', name]));
function fixture(name) {
  const repo = join(temp, name); mkdirSync(repo);
  git(repo, 'init', '-qb', 'main'); git(repo, 'config', 'user.name', 'Lab timeout fixture'); git(repo, 'config', 'user.email', 'lab@example.invalid');
  write(repo, '.gitignore', '.worktrees/\n.proof-or-stop/\n');
  write(repo, 'CHANGELOG.md', '# Changelog\n');
  for (const rel of ['package.json', 'packages/main/package.json']) write(repo, rel, JSON.stringify({ name: 'proof-or-stop', version: '1.0.0', type: 'module' }));
  for (const rel of ['package-lock.json', 'packages/main/package-lock.json']) write(repo, rel, JSON.stringify({ name: 'proof-or-stop', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'proof-or-stop', version: '1.0.0' } } }));
  for (const rel of ['packages/lab/package-lock.json', 'packages/utils/package-lock.json']) write(repo, rel, JSON.stringify({ lockfileVersion: 3, packages: { '../main': { name: '@proof-or-stop/core', version: '1.0.0' } } }));
  copyLabFixtureSources(root, repo, ['main-write-lock', 'mkdir-lock', 'brand-env', 'brand-paths', 'proof-or-stop-paths', 'runtime-artifact-registry', 'version-bump', 'runtime-version-policy']);
  const brand = 'packages/main/src/core/proof-or-stop-brand.ts';
  write(repo, brand, readFileSync(join(repo, brand), 'utf8').replace(/(PROOF_OR_STOP_CLI_VERSION\s*=\s*)'[^']+'/, "$1'1.0.0'"));
  write(repo, 'check.mjs', "import {readFileSync} from 'node:fs'; if(readFileSync('bug.txt','utf8')!=='fixed'){console.error('TIMEOUT_TARGET_RED');process.exit(1)} console.log('TIMEOUT_TARGET_GREEN');\n");
  write(repo, 'bug.txt', 'broken'); commit(repo);
  command(repo, ['create', name]);
  return { repo, work: join(repo, '.worktrees', `Lab-${name}`) };
}
try {
  const notes = join(temp, 'notes.md');
  writeFileSync(notes, 'Verify timeout pinning with disposable CLI RED, GREEN and integration replays. This synthetic fixture is not an independent provider audit.');
  for (const [name, timeout] of [['default', undefined], ['pinned-old', 900000]]) {
    const { repo, work } = fixture(name);
    command(repo, ['red', name, '--expect', 'TIMEOUT_TARGET_RED', ...(timeout ? ['--timeout-ms', String(timeout)] : []), '--', process.execPath, 'check.mjs']);
    assert.equal(state(repo, name).red.timeoutMs, timeout ?? 1800000);
    write(work, 'bug.txt', 'fixed'); commit(work);
    command(repo, ['green', name]);
    command(repo, ['finish', name, '--notes', notes, '--confirm']);
    const result = state(repo, name);
    for (const kind of ['red', 'green', 'synced-green', 'candidate-green', 'main-green']) {
      const rows = result.history.filter(row => row.kind === kind);
      assert(rows.length > 0, `Missing ${kind} coverage`);
      assert(rows.every(row => row.timeoutMs === (timeout ?? 1800000)), `${name}: ${kind} must replay the pinned budget`);
    }
  }
  const { repo, work } = fixture('short');
  for (const value of ['0', '-1', '3600001']) command(repo, ['red', 'short', '--expect', 'TIMEOUT_TARGET_RED', '--timeout-ms', value, '--', process.execPath, 'check.mjs'], 1, /--timeout-ms must/);
  command(repo, ['red', 'short', '--expect', 'TIMEOUT_TARGET_RED', '--timeout-ms', '100', '--', process.execPath, '-e', "console.error('TIMEOUT_TARGET_RED');setTimeout(()=>process.exit(1),2000)"], 1, /Expected target RED was not observed/);
  assert(!state(repo, 'short').red, 'A killed command cannot become RED even when its marker appeared');
  command(repo, ['red', 'short', '--expect', 'TIMEOUT_TARGET_RED', '--timeout-ms', '1000', '--', process.execPath, 'check.mjs']);
  write(work, 'check.mjs', "setTimeout(()=>console.log('late success'),2000);\n"); commit(work);
  command(repo, ['green', 'short'], 1, /GREEN failed/);
  assert.equal(state(repo, 'short').green, null, 'Timed-out GREEN cannot become passing evidence');
  write(work, 'check.mjs', "console.log('bounded success');\n"); commit(work);
  command(repo, ['green', 'short']);
  assert.equal(state(repo, 'short').green.timeoutMs, 1000);
  console.log('LAB_TIMEOUT_BUDGET_GREEN: 1800-second defaults, pinned replay and timeout refusals');
} finally { rmSync(temp, { recursive: true, force: true }); }
