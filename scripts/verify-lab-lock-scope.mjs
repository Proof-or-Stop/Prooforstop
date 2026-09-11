#!/usr/bin/env node
import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import { installLabAuditFixtureProviders } from './lab-audit-fixture-provider.mjs';
import { copyLabFixtureSources } from './lab-fixture-sources.mjs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, readlinkSync, existsSync, rmSync, renameSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Load after the source resolver has registered its .js -> .ts hook.
const { acquireMainWriteLock } = await import('../packages/main/src/core/main-write-lock.ts');

// All writes and actual main-lock acquisitions are confined to disposable Git
// repositories. Invoke the real Lab command; never mint a passing Lab record.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/lab-worktree.mjs');
const temp = mkdtempSync(join(tmpdir(), 'proof-or-stop-lab-lock-scope-'));
const children = new Set(), failures = [], results = [];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (cwd, path, value) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), value); };
const commit = (cwd, message) => { git(cwd, 'add', '-A', '--', '.', ':!AGENTS.override.md'); git(cwd, 'commit', '-qm', message); };
const fixtureBin=installLabAuditFixtureProviders(temp);
const env = { ...process.env, CODEX_THREAD_ID: 'fixture-developer', CLAUDECODE: '', PATH: fixtureBin + ':' + process.env.PATH, npm_config_prefix: join(temp, 'global'), NPM_CONFIG_PREFIX: join(temp, 'global') };
for (const key of ['NODE_OPTIONS', 'PROOF_OR_STOP_IMPLEMENTATION_MANIFEST', 'PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN']) delete env[key];
function command(repo, args, entry = script, childEnv = env) {
  const row = spawnSync(process.execPath, [entry, ...args], { cwd: repo, encoding: 'utf8', env: childEnv, timeout: 15000 });
  return { status: row.status, signal: row.signal, error: row.error?.message, stdout: row.stdout || '', output: (row.stdout || '') + (row.stderr || '') };
}
function start(repo, args, entry = script, childEnv = env) {
  const child = spawn(process.execPath, [entry, ...args], { cwd: repo, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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
      if (entry.isDirectory()) visit(full, name); else if (entry.isSymbolicLink()) hash.update(readlinkSync(full)); else hash.update(readFileSync(full));
    }
  }
  visit(path); return hash.digest('hex');
}
function fixture(name) {
  const repo = join(temp, name); mkdirSync(repo);
  git(repo, 'init', '-qb', 'main'); git(repo, 'config', 'user.name', 'Lab lock regression'); git(repo, 'config', 'user.email', 'lab@example.invalid');
  write(repo, '.gitignore', '.worktrees/\n.proof-or-stop/\n');
  for (const rel of ['package.json', 'packages/main/package.json']) write(repo, rel, JSON.stringify({ name: 'proof-or-stop', version: '1.0.0', type: 'module' }));
  write(repo, 'CHANGELOG.md', '# Changelog\n');
  copyLabFixtureSources(root, repo, ['main-write-lock', 'mkdir-lock', 'brand-env', 'brand-paths', 'proof-or-stop-paths', 'runtime-artifact-registry', 'version-bump', 'runtime-version-policy']);
  for (const rel of ['package-lock.json','packages/main/package-lock.json']) write(repo,rel,JSON.stringify({name:'proof-or-stop',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'proof-or-stop',version:'1.0.0'}}}));
  for (const rel of ['packages/lab/package-lock.json','packages/utils/package-lock.json']) write(repo,rel,JSON.stringify({lockfileVersion:3,packages:{'../main':{name:'@proof-or-stop/core',version:'1.0.0'}}}));
  const brand='packages/main/src/core/proof-or-stop-brand.ts';
  write(repo,brand,readFileSync(join(repo,brand),'utf8').replace(/(PROOF_OR_STOP_CLI_VERSION\s*=\s*)'[^']+'/ , "$1'1.0.0'"));
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
const state = (repo, name) => JSON.parse(command(repo, ['status', name]).stdout);

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

  const auditHold=join(temp,'finish-audit-hold');
  const finishing=start(repo,['finish','alpha','--notes',notes,'--confirm'],script,{...env,LAB_FIXTURE_AUDIT_HOLD:auditHold});
  await until(()=>finishing.done || existsSync(auditHold+'.ready'),'finish audit start');
  assert.equal(finishing.done,false,finishing.output);
  let auditWriter=false;
  try {
    const lock=acquireMainWriteLock(repo,{label:'unrelated writer during provider audit'});
    try {auditWriter=true;write(repo,'concurrent-main.txt','another local writer');commit(repo,'test: main advances during audit');} finally {lock.release();}
  } finally {writeFileSync(auditHold+'.release','release');}
  await finishing.promise;
  expect('main writer acquires while finish audit is in flight',auditWriter);
  expect('main movement during audit blocks merge and preserves candidate',finishing.status===1 && /main changed while the audit ran/.test(finishing.output) && state(repo,'alpha').phase==='prepared' && existsSync(lab(repo,'alpha')) && git(repo,'rev-parse','HEAD')!==state(repo,'alpha').candidate,{output:finishing.output.slice(-800)});

  // Actual pre-repair 0.3.311 Lab CLI, frozen in Git, not a simulated legacy
  // writer. Old scripts know only the main lock and schema 1. Migration must
  // coordinate with them once, then make them refuse the new signed schema.
  const legacyRoot = join(temp, 'legacy-tools');
  const legacyRef = '33e7408c580d174329f71b977b73bab00a569262';
  for (const rel of ['scripts/lab-worktree.mjs', 'scripts/lab-source-loader.mjs', 'packages/main/src/core/runtime-fact-registry.ts']) {
    write(legacyRoot, rel, git(root, 'show', `${legacyRef}:${rel}`));
  }
  const legacyScript = join(legacyRoot, 'scripts/lab-worktree.mjs');
  const migration = fixture('migration'); assert.equal(command(migration, ['create', 'old'], legacyScript).status, 0);
  const migrationBefore = tree(migration);
  expect('schema-1 status stays read-only before migration', state(migration, 'old').schema === 1 && tree(migration) === migrationBefore);
  const migrationEvents = join(temp, 'migration-events');
  const oldRun = start(migration, red('old', migrationEvents, 1000), legacyScript);
  await until(() => oldRun.done || eventsAt(migrationEvents).length > 0, 'legacy RED start');
  assert.equal(oldRun.done, false, oldRun.output);
  const overlapping = command(migration, red('old', migrationEvents, 1));
  expect('schema migration refuses a still-running old main-lock writer', overlapping.status === 1 && eventsAt(migrationEvents).filter(e => e.event === 'start').length === 1);
  await oldRun.promise; assert.equal(oldRun.status, 0, oldRun.output);
  assert.equal(command(migration, red('old', migrationEvents, 20)).status, 0);
  const adopted = state(migration, 'old'); const eventCount = eventsAt(migrationEvents).length;
  const legacyRetry = command(migration, red('old', migrationEvents, 1), legacyScript);
  expect('old CLI cannot mutate or execute after signed schema migration', adopted.schema === 3 && legacyRetry.status === 1 && /Invalid Lab record/.test(legacyRetry.output) && eventsAt(migrationEvents).length === eventCount);

  for (const fault of ['key', 'ownership']) {
    const fenced = fixture(`fence-${fault}`); assert.equal(command(fenced, ['create', 'fence']).status, 0);
    assert.equal(command(fenced, red('fence', join(temp, `fence-${fault}-events`), 1)).status, 0);
    write(lab(fenced, 'fence'), 'check.mjs', `import fs from 'node:fs'; import path from 'node:path'; import {execFileSync} from 'node:child_process';
const common=execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim();
${fault === 'key' ? "fs.writeFileSync(path.join(common,'lab-maintenance/local.key'),Buffer.alloc(32,7));" : "const p=path.join(common,'lab-maintenance/locks/fence.lock/holder.json');const h=JSON.parse(fs.readFileSync(p));h.lockId='controlled-replacement-owner';fs.writeFileSync(p,JSON.stringify(h));"}
console.log('child succeeded but publication must fail');\n`);
    commit(lab(fenced, 'fence'), 'controlled publication fault');
    const rejected = command(fenced, ['green', 'fence']);
    const durable = JSON.parse(readFileSync(join(fenced, '.git/lab-maintenance/fence.json'))).payload;
    expect(`successful child cannot publish GREEN after ${fault} changes`, rejected.status === 1 && /ownership or signing key changed/.test(rejected.output) && !durable.green);
    if (fault === 'ownership') expect('release preserves replacement operation ownership', JSON.parse(readFileSync(join(fenced, '.git/lab-maintenance/locks/fence.lock/holder.json'))).lockId === 'controlled-replacement-owner');
  }

  // Degrade the real process-start probe, then age the actually acquired
  // fixture lock to a point between the old 10s stale limit and its 30s beat.
  // This is controlled clock-state injection, not a 15-second stress run.
  const uncertain = fixture('unknown-process'); assert.equal(command(uncertain, ['create', 'held']).status, 0);
  const shim = join(temp, 'without-ps'); write(shim, 'ps', '#!/bin/sh\nexit 1\n'); chmodSync(join(shim, 'ps'), 0o700);
  const noProbeEnv = { ...env, PATH: shim + ':' + env.PATH }, uncertainEvents = join(temp, 'unknown-process-events');
  const held = start(uncertain, red('held', uncertainEvents, 1300), script, noProbeEnv);
  await until(() => held.done || eventsAt(uncertainEvents).length > 0, 'unknown-process owner starts'); assert.equal(held.done, false, held.output);
  await delay(100);
  const operationLock = join(uncertain, '.git/lab-maintenance/locks/held.lock'), oldTime = new Date(Date.now() - 15000);
  utimesSync(operationLock, oldTime, oldTime); utimesSync(join(operationLock, 'holder.json'), oldTime, oldTime);
  const contender = command(uncertain, red('held', uncertainEvents, 1), script, noProbeEnv);
  await held.promise;
  expect('unknown process identity retains the live lock between heartbeats', contender.status === 1 && held.status === 0 && eventsAt(uncertainEvents).filter(e => e.event === 'start').length === 1, { contenderStatus: contender.status, holderStatus: held.status });

  console.log('LAB_LOCK_RESULTS ' + JSON.stringify({ results, failures, timeline }, null, 2));
  if (failures.length) { console.error('LAB_LOCK_SCOPE_RED ' + failures.join('; ')); process.exitCode = 1; }
  else console.log('LAB_LOCK_SCOPE_GREEN');
} finally {
  for (const child of children) child.kill('SIGTERM');
  // Normal executions have joined every child before removing private data.
  if (children.size === 0) rmSync(temp, { recursive: true, force: true });
  else console.error(`Unfinished fixture children: evidence retained at ${temp}`);
}
