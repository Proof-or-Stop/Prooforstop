#!/usr/bin/env node
// Lab fixture-machine-retention RED/GREEN.
//
// Bug: every fixture validation creates <tmpdir>/proof-or-stop-fixture-machine-*,
// and any failure retains it "for diagnosis". Nothing ever removes retained
// directories, so they accumulate without bound: 125 were present on this
// machine on 2026-09-17 (the oldest from 2026-09-14, up to 8.1 MB each).
//
// Drives this checkout's built helper in a child whose TMPDIR is a disposable
// parent populated with aged directories. Controls: a directory whose owner is
// alive, a recently retained one (diagnosis grace), a young legacy one, an
// unrelated directory and a prefixed symlink are never removed.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'retained fixture machine directories are never pruned';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repoRoot, 'packages/main/dist');
const build = spawnSync('npm', ['--prefix', 'packages/main', 'run', 'build'], { cwd: repoRoot, encoding: 'utf8' });
if (build.status !== 0) { process.stderr.write(`${build.stdout}\n${build.stderr}\n`); throw new Error('packages/main build failed; this is not the target RED'); }

const parent = mkdtempSync(join(tmpdir(), 'pos-fixture-retention-'));
const red = [];
let checks = 0;
const expectRepaired = (ok, message) => { if (ok) checks++; else red.push(message); };
const control = (ok, message) => { if (!ok) throw new Error(`control failed (not the target RED): ${message}`); checks++; };
const PREFIX = 'proof-or-stop-fixture-machine-';
const MIN = 60_000, HOUR = 3_600_000;

// A process that has exited: its pid is dead.
const deadPid = (() => { const r = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }); return Number(r.stdout.trim()); })();
const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

function makeDir(name, ageMs, owner) {
  const root = join(parent, name);
  mkdirSync(join(root, 'home'), { recursive: true });
  writeFileSync(join(root, 'preload.mjs'), '// fixture\n');
  if (owner) writeFileSync(join(root, 'owner.json'), JSON.stringify({ schema: 'proof-or-stop.fixture-machine-owner.v1', pid: owner, createdAtMs: Date.now() - ageMs }));
  const at = new Date(Date.now() - ageMs);
  for (const path of [join(root, 'preload.mjs'), ...(owner ? [join(root, 'owner.json')] : []), join(root, 'home'), root]) utimesSync(path, at, at);
  return root;
}
const groups = {
  legacyOld: Array.from({ length: 8 }, (_, i) => makeDir(`${PREFIX}legacy-old-${i}`, 7 * HOUR + i * MIN)),
  legacyYoung: Array.from({ length: 2 }, (_, i) => makeDir(`${PREFIX}legacy-young-${i}`, 1 * HOUR + i * MIN)),
  deadAged: Array.from({ length: 25 }, (_, i) => makeDir(`${PREFIX}dead-aged-${String(i).padStart(2, '0')}`, 20 * MIN + i * MIN, deadPid)),
  deadRecent: Array.from({ length: 2 }, (_, i) => makeDir(`${PREFIX}dead-recent-${i}`, 2 * MIN + i * 10_000, deadPid)),
  liveOwner: [makeDir(`${PREFIX}live-owner`, 8 * HOUR, live.pid)],
  legacyOldRootRecentNested: [(() => {
    const root = makeDir(`${PREFIX}legacy-nested-activity`, 7 * HOUR);
    mkdirSync(join(root, 'home/queue'), { recursive: true });
    writeFileSync(join(root, 'home/queue/active.ticket'), 'in use\n');
    const old = new Date(Date.now() - 7 * HOUR);
    utimesSync(join(root, 'home'), old, old); utimesSync(root, old, old);
    return root;
  })()],
  // An entry the pruner cannot inspect may hold recent activity: never deleted.
  unreadableSubtree: [(() => {
    const root = makeDir(`${PREFIX}unreadable-subtree`, 7 * HOUR);
    mkdirSync(join(root, 'home/private'), { recursive: true });
    writeFileSync(join(root, 'home/private/recent.log'), 'in use\n');
    chmodSync(join(root, 'home/private'), 0o000);
    const old = new Date(Date.now() - 7 * HOUR);
    for (const path of [join(root, 'home'), root]) utimesSync(path, old, old);
    return root;
  })()],
  // A FIFO (or a symlink to one) named owner.json must never block the pruner.
  fifoOwner: [(() => {
    const root = makeDir(`${PREFIX}fifo-owner`, 7 * HOUR);
    spawnSync('mkfifo', [join(root, 'owner.json')]);
    const old = new Date(Date.now() - 7 * HOUR);
    utimesSync(root, old, old);
    return root;
  })()],
  symlinkedOwner: [(() => {
    const root = makeDir(`${PREFIX}symlinked-owner`, 7 * HOUR);
    spawnSync('mkfifo', [join(root, 'pipe')]);
    symlinkSync(join(root, 'pipe'), join(root, 'owner.json'));
    const old = new Date(Date.now() - 7 * HOUR);
    utimesSync(root, old, old);
    return root;
  })()],
  unrelated: [makeDir('some-other-tool-dir', 8 * HOUR)],
};
const symlinkPath = join(parent, `${PREFIX}symlink`);
symlinkSync(groups.unrelated[0], symlinkPath);

let created;
try {
  const helper = `file://${join(dist, 'tasks/helpers/fixture-machine-environment.js')}`;
  const createStarted = Date.now();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { createFixtureMachineEnvironment } = await import(${JSON.stringify(helper)}); const m = createFixtureMachineEnvironment(); console.log(JSON.stringify({ root: m.root }));`],
    { env: { ...process.env, TMPDIR: parent }, encoding: 'utf8', timeout: 60_000 });
  const createMs = Date.now() - createStarted;
  // A blocking owner record is exactly the defect under test: report it as a failing
  // expectation instead of crashing, so RED reads as a result rather than a stack.
  const blockedCreation = child.error?.code === 'ETIMEDOUT' || child.signal === 'SIGTERM';
  if (child.status !== 0 && !blockedCreation) throw new Error(`helper failed: ${child.stderr}`);
  created = blockedCreation ? null : JSON.parse(child.stdout.trim().split('\n').at(-1)).root;
  const exists = (p) => { try { lstatSync(p); return true; } catch { return false; } };
  const count = (list) => list.filter(exists).length;
  const before = 8 + 2 + 25 + 2 + 1 + 1 + 3;
  const after = readdirSync(parent).filter((n) => n.startsWith(PREFIX) && n !== 'proof-or-stop-fixture-machine-symlink' && join(parent, n) !== created).length;
  if (created === null) console.log('fixture creation was killed after 60s: the pruner blocked on an owner record');
  console.log('group | seeded | remaining');
  for (const [name, list] of Object.entries(groups)) console.log(`${name} | ${list.length} | ${count(list)}`);
  console.log(`prefixed retained directories: before=${before} after=${after}`);

  expectRepaired(createMs < 30_000 && created !== null, `creating a fixture environment completes despite a blocking owner record (took ${createMs}ms${created ? '' : ', helper killed'})`);
  control(created === null || existsSync(created), 'the new fixture directory exists');
  control(count(groups.liveOwner) === 1, 'a directory whose owner is alive is kept');
  control(count(groups.legacyOldRootRecentNested) === 1, 'a legacy directory with recent nested activity is kept');
  expectRepaired(count(groups.unreadableSubtree) === 1, 'a directory whose subtree cannot be fully inspected is kept');
  expectRepaired(count(groups.fifoOwner) === 1 && count(groups.symlinkedOwner) === 1, 'a directory whose owner record is a FIFO or a symlink to one is kept');
  control(count(groups.deadRecent) === 2, 'recently retained directories keep their diagnosis grace');
  control(count(groups.legacyYoung) === 2, 'young legacy directories without an owner record are kept');
  control(count(groups.unrelated) === 1 && exists(symlinkPath), 'unrelated directories and prefixed symlinks are untouched');
  expectRepaired(count(groups.legacyOld) === 0, `legacy directories older than 6h must be pruned (remaining ${count(groups.legacyOld)})`);
  expectRepaired(count(groups.deadAged) === 20, `dead-owner directories past grace must be capped to the 20 newest (remaining ${count(groups.deadAged)})`);
  expectRepaired(groups.deadAged.slice(0, 20).every(exists), 'the cap keeps the newest dead-owner directories');
  expectRepaired(created !== null && existsSync(join(created, 'owner.json')), 'a new fixture directory records its owner for later pruning');
  // Phase 2: the traversal defect on its own, with no blocking owner record in the way.
  {
    const parent2 = mkdtempSync(join(tmpdir(), 'pos-fixture-retention-scan-'));
    const old = new Date(Date.now() - 7 * HOUR);
    const unreadable = join(parent2, `${PREFIX}scan-unreadable`);
    // Accessible diagnostic material is created FIRST, so a recursive delete reaches it
    // before it fails on the unreadable subtree: a partial delete destroys it.
    mkdirSync(join(unreadable, 'aaa-diagnosis'), { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(join(unreadable, `aaa-diagnosis/report-${i}.log`), 'kept for diagnosis\n');
    mkdirSync(join(unreadable, 'zzz-private'), { recursive: true });
    writeFileSync(join(unreadable, 'zzz-private/recent.log'), 'in use\n');
    // The unreadable directory's own timestamp is old too: only its hidden contents are
    // recent, so a scan that cannot list it must not conclude the candidate is idle.
    utimesSync(join(unreadable, 'zzz-private'), old, old);
    chmodSync(join(unreadable, 'zzz-private'), 0o000);
    // Everything the scan CAN see is old; only the unreadable subtree could prove recency.
    for (let i = 0; i < 5; i++) utimesSync(join(unreadable, `aaa-diagnosis/report-${i}.log`), old, old);
    for (const path of [join(unreadable, 'aaa-diagnosis'), unreadable]) utimesSync(path, old, old);
    const plain = join(parent2, `${PREFIX}scan-plain`);
    mkdirSync(plain, { recursive: true }); utimesSync(plain, old, old);
    const helper = `file://${join(dist, 'tasks/helpers/fixture-machine-environment.js')}`;
    const pruned = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(helper)}); console.log(JSON.stringify(m.pruneRetainedFixtureMachines(${JSON.stringify(parent2)})));`],
      { encoding: 'utf8', timeout: 60_000 });
    if (pruned.status !== 0) throw new Error(`prune helper failed: ${pruned.stderr}`);
    const kept = existsSync(unreadable);
    const diagnosisKept = Array.from({ length: 5 }, (_, i) => existsSync(join(unreadable, `aaa-diagnosis/report-${i}.log`))).every(Boolean);
    console.log(`direct prune | unreadable subtree kept=${kept} | accessible diagnosis kept=${diagnosisKept} | plain legacy removed=${!existsSync(plain)}`);
    expectRepaired(kept && diagnosisKept, `pruning a directory whose subtree cannot be fully inspected must leave it intact (kept=${kept}, diagnosis kept=${diagnosisKept})`);
    control(!existsSync(plain), 'pruning still removes a plain legacy directory in the same parent');
    try { chmodSync(join(unreadable, 'zzz-private'), 0o700); } catch { /* already gone */ }
    rmSync(parent2, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
} finally {
  live.kill('SIGKILL');
  // The unreadable-subtree control is deliberately mode 0o000; make it removable again.
  try { chmodSync(join(parent, `${PREFIX}unreadable-subtree`, 'home/private'), 0o700); } catch { /* already gone */ }
  rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
if (red.length) {
  console.log(`${MARKER} (${red.length} failing expectations, ${checks} passing checks)`);
  for (const line of red) console.log(`  - ${line}`);
  process.exit(1);
}
console.log(`retained fixture machine directories are bounded (${checks} checks)`);
