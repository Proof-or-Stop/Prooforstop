#!/usr/bin/env node
import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireMainWriteLock } from '../packages/main/src/core/main-write-lock.ts';

// All writes and actual main-lock acquisitions are confined to disposable Git
// repositories. Invoke the real Lab command; never mint a passing Lab record.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/lab-worktree.mjs');
const temp = mkdtempSync(join(tmpdir(), 'proof-or-stop-lab-lock-scope-'));
const children = new Set(), failures = [], results = [];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (cwd, path, value) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), value); };
const commit = (cwd, message) => { git(cwd, 'add', '-A', '--', '.', ':!AGENTS.override.md'); git(cwd, 'commit', '-qm', message); };
const env = { ...process.env, npm_config_prefix: join(temp, 'global'), NPM_CONFIG_PREFIX: join(temp, 'global') };
for (const key of ['NODE_OPTIONS', 'PROOF_OR_STOP_IMPLEMENTATION_MANIFEST', 'PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN']) delete env[key];
function command(repo, args) {
  const row = spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8', env, timeout: 15000 });
  return { status: row.status, signal: row.signal, error: row.error?.message, output: (row.stdout || '') + (row.stderr || '') };
}
function start(repo, args) {
  const child = spawn(process.execPath, [script, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const row = { child, done: false, output: '', startedAt: performance.now() };
  child.stdout.on('data', x => { row.output += x; }); child.stderr.on('data', x => { row.output += x; });
  row.promise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => { children.delete(child); Object.assign(row, { done: true, status, signal, elapsedMs: performance.now() - row.startedAt }); resolve(row); });
  });
  return row;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const deadline = performance.now() + 10000;
  while (!fn()) { if (performance.now() > deadline) throw new Error(`fixture orchestration timed out: ${label}`); await delay(10); }
}
function expect(name, condition, details = {}) {
  results.push({ name, pass: Boolean(condition), ...details });
  if (!condition) failures.push(name);
}
function tree(path) {
  const hash = createHash('sha256');
  function visit(base, rel = '') {
    if (!existsSync(base)) { hash.update(`absent:${rel}`); return; }
    for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(rel, entry.name), full = join(base, entry.name); hash.update(`${name}\0`);
      if (entry.isDirectory()) visit(full, name); else hash.update(readFileSync(full));
    }
  }
  visit(path); return hash.digest('hex');
}
function fixture(name) {
  const repo = join(temp, name); mkdirSync(repo);
  git(repo, 'init', '-qb', 'main'); git(repo, 'config', 'user.name', 'Lab lock regression'); git(repo, 'config', 'user.email', 'lab@example.invalid');
  write(repo, '.gitignore', '.worktrees/\n.proof-or-stop/\n');
  for (const rel of ['package.json', 'packages/main/package.json']) write(repo, rel, JSON.stringify({ name: 'proof-or-stop', version: '1.0.0' }));
  write(repo, 'CHANGELOG.md', '# Changelog\n');
  for (const name of ['main-write-lock', 'mkdir-lock', 'brand-env', 'brand-paths', 'proof-or-stop-paths', 'runtime-artifact-registry', 'version-bump', 'runtime-version-policy']) {
    write(repo, `packages/main/src/core/${name}.ts`, readFileSync(join(root, `packages/main/src/core/${name}.ts`)));
  }
  write(repo, 'bug.txt', 'broken');
  write(repo, 'check.mjs', `import fs from 'node:fs'; import path from 'node:path';
const [events, holdText] = process.argv.slice(2); const id = path.basename(process.cwd());
fs.appendFileSync(events, JSON.stringify({event:'start',id,at:Date.now(),pid:process.pid})+'\\n');
await new Promise(resolve=>setTimeout(resolve,Number(holdText)));
fs.appendFileSync(events, JSON.stringify({event:'end',id,at:Date.now(),pid:process.pid})+'\\n');
if(fs.readFileSync('bug.txt','utf8')!=='fixed'){console.error('INNER_TARGET_RED');process.exit(1)}
console.log('INNER_GREEN');\n`);
  commit(repo, 'fixture baseline'); return repo;
}
const notes = join(temp, 'notes.md'); writeFileSync(notes, 'Verify the bounded Lab lock-scope repair with actual isolated repository concurrency and unchanged signing and lifecycle checks.');
const lab = (repo, name) => join(repo, '.worktrees', `Lab-${name}`);
const red = (name, events, ms = 1800) => ['red', name, '--expect', 'INNER_TARGET_RED', '--', process.execPath, 'check.mjs', events, String(ms)];
const eventsAt = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)) : [];
const state = (repo, name) => JSON.parse(command(repo, ['status', name]).output);

try {
  const virgin = fixture('virgin'); const pristine = tree(virgin);
  const unknown = command(virgin, ['status', 'unknown']);
  expect('unknown status refuses without creating locks, signing keys or records', unknown.status === 1 && tree(virgin) === pristine, { status: unknown.status });

  const repo = fixture('concurrency');
  for (const name of ['alpha', 'bravo']) assert.equal(command(repo, ['create', name]).status, 0);
  const writer = acquireMainWriteLock(repo, { label: 'isolated active writer' });
  try {
    const before = tree(repo), observed = command(repo, ['status', 'alpha']);
    expect('status reads during a real main writer without writes', observed.status === 0 && tree(repo) === before, { status: observed.status });
    expect('sync still refuses an active main writer', command(repo, ['sync', 'alpha']).status === 1);
    const isolatedEvents = join(temp, 'held-writer-events');
    const independent = command(repo, red('alpha', isolatedEvents, 30));
    expect('RED can execute while unrelated main writer remains held', independent.status === 0 && writer.isCurrent(), { status: independent.status });
  } finally { writer.release(); }

  const events = join(temp, 'pair-events'), startedAt = performance.now();
  const first = start(repo, red('alpha', events));
  await until(() => first.done || eventsAt(events).some(e => e.id === 'Lab-alpha' && e.event === 'start'), 'first command start');
  assert.equal(first.done, false, first.output);
  const second = start(repo, red('bravo', events));
  await until(() => second.done || eventsAt(events).some(e => e.id === 'Lab-bravo' && e.event === 'start'), 'second command admitted or refused');
  const during = command(repo, ['status', 'alpha']);
  expect('status remains available during a long RED', during.status === 0, { status: during.status });
  let writerAcquired = false;
  try { const lock = acquireMainWriteLock(repo, { label: 'isolated concurrent main writer' }); writerAcquired = true; lock.release(); } catch { /* RED exposes the real contention failure. */ }
  expect('unrelated main writer acquires during a long RED', writerAcquired);
  const same = command(repo, red('alpha', events, 1));
  expect('same Lab cannot start a conflicting child', same.status === 1 && eventsAt(events).filter(e => e.id === 'Lab-alpha' && e.event === 'start').length === 1);
  const finish = command(repo, ['finish', 'alpha', '--notes', notes, '--confirm']);
  expect('finish cannot mutate or remove a running Lab', finish.status === 1 && existsSync(lab(repo, 'alpha')) && git(repo, 'rev-parse', 'main') === git(lab(repo, 'alpha'), 'rev-parse', 'HEAD'));
  await first.promise; await second.promise;
  // Baseline refuses bravo, so retry after alpha finishes to compare two
  // completed, identically sized commands, including real admission overhead.
  let retry = null;
  if (second.status !== 0) retry = command(repo, red('bravo', events));
  const pairMs = performance.now() - startedAt, timeline = eventsAt(events);
  const aStart = timeline.find(e => e.id === 'Lab-alpha' && e.event === 'start');
  const aEnd = timeline.find(e => e.id === 'Lab-alpha' && e.event === 'end');
  const bStart = timeline.find(e => e.id === 'Lab-bravo' && e.event === 'start');
  const bEnd = timeline.find(e => e.id === 'Lab-bravo' && e.event === 'end');
  const overlapMs = Math.max(0, Math.min(aEnd.at, bEnd.at) - Math.max(aStart.at, bStart.at));
  expect('different Lab commands overlap and both record authentic RED', first.status === 0 && second.status === 0 && overlapMs > 0, { pairMs, overlapMs, completed: Number(first.status === 0) + Number((retry || second).status === 0), retries: Number(Boolean(retry)) });
  const signed = state(repo, 'alpha'); assert.equal(signed.red.command.at(-1), '1800');
  assert.equal(signed.red.timeoutMs, 900000);
  expect('same Lab refusal does not replace the pinned command', signed.red.command.at(-1) === '1800');

  // GREEN uses the exact recorded command, protected by the same Lab lock.
  write(lab(repo, 'alpha'), 'bug.txt', 'fixed'); commit(lab(repo, 'alpha'), 'fix fixture');
  const green = start(repo, ['green', 'alpha']); const previousCount = timeline.length;
  await until(() => green.done || eventsAt(events).length > previousCount, 'GREEN start');
  assert.equal(green.done, false, green.output);
  expect('concurrent GREEN is refused', command(repo, ['green', 'alpha']).status === 1);
  expect('finish cannot race running GREEN', command(repo, ['finish', 'alpha', '--notes', notes, '--confirm']).status === 1 && existsSync(lab(repo, 'alpha')));
  let greenWriter = false;
  try { const lock = acquireMainWriteLock(repo, { label: 'writer during GREEN' }); greenWriter = true; lock.release(); } catch { /* target regression */ }
  expect('main writer acquires during GREEN', greenWriter);
  await green.promise; assert.equal(green.status, 0, green.output);
  const verified = state(repo, 'alpha');
  expect('GREEN retains exact argv, timeout and current HEAD', JSON.stringify(verified.green.command) === JSON.stringify(verified.red.command) && verified.green.timeoutMs === verified.red.timeoutMs && verified.green.head === git(lab(repo, 'alpha'), 'rev-parse', 'HEAD'));

  // Deliberate tampering is limited to this disposable Lab record, never real
  // Story/fixture data; only the real CLI has produced its original HMAC.
  const recordPath = join(repo, '.git/lab-maintenance/alpha.json'), original = readFileSync(recordPath);
  const tampered = JSON.parse(original); tampered.payload.phase = 'verified'; writeFileSync(recordPath, JSON.stringify(tampered));
  const corruptBefore = tree(repo), corrupt = command(repo, ['status', 'alpha']);
  expect('corrupt status fails closed without repair writes', corrupt.status === 1 && /Invalid Lab record/.test(corrupt.output) && tree(repo) === corruptBefore);
  writeFileSync(recordPath, original);
  const key = join(repo, '.git/lab-maintenance/local.key'), savedKey = join(temp, 'saved-local-key'); renameSync(key, savedKey);
  const keyBefore = tree(repo), missing = command(repo, ['status', 'alpha']);
  expect('missing signing key refuses without replacing trust', missing.status === 1 && tree(repo) === keyBefore && !existsSync(key));
  renameSync(savedKey, key);

  console.log('LAB_LOCK_RESULTS ' + JSON.stringify({ results, failures, timeline }, null, 2));
  if (failures.length) { console.error('LAB_LOCK_SCOPE_RED ' + failures.join('; ')); process.exitCode = 1; }
  else console.log('LAB_LOCK_SCOPE_GREEN');
} finally {
  for (const child of children) child.kill('SIGTERM');
  // Normal executions have joined every child before removing private data.
  if (children.size === 0) rmSync(temp, { recursive: true, force: true });
  else console.error(`Unfinished fixture children: evidence retained at ${temp}`);
}
