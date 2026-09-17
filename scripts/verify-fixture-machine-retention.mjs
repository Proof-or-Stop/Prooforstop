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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
  unrelated: [makeDir('some-other-tool-dir', 8 * HOUR)],
};
const symlinkPath = join(parent, `${PREFIX}symlink`);
symlinkSync(groups.unrelated[0], symlinkPath);

let created;
try {
  const helper = `file://${join(dist, 'tasks/helpers/fixture-machine-environment.js')}`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { createFixtureMachineEnvironment } = await import(${JSON.stringify(helper)}); const m = createFixtureMachineEnvironment(); console.log(JSON.stringify({ root: m.root }));`],
    { env: { ...process.env, TMPDIR: parent }, encoding: 'utf8' });
  if (child.status !== 0) throw new Error(`helper failed: ${child.stderr}`);
  created = JSON.parse(child.stdout.trim().split('\n').at(-1)).root;
  const exists = (p) => { try { lstatSync(p); return true; } catch { return false; } };
  const count = (list) => list.filter(exists).length;
  const before = 8 + 2 + 25 + 2 + 1;
  const after = readdirSync(parent).filter((n) => n.startsWith(PREFIX) && n !== 'proof-or-stop-fixture-machine-symlink' && join(parent, n) !== created).length;
  console.log('group | seeded | remaining');
  for (const [name, list] of Object.entries(groups)) console.log(`${name} | ${list.length} | ${count(list)}`);
  console.log(`prefixed retained directories: before=${before} after=${after}`);

  control(existsSync(created), 'the new fixture directory exists');
  control(count(groups.liveOwner) === 1, 'a directory whose owner is alive is kept');
  control(count(groups.deadRecent) === 2, 'recently retained directories keep their diagnosis grace');
  control(count(groups.legacyYoung) === 2, 'young legacy directories without an owner record are kept');
  control(count(groups.unrelated) === 1 && exists(symlinkPath), 'unrelated directories and prefixed symlinks are untouched');
  expectRepaired(count(groups.legacyOld) === 0, `legacy directories older than 6h must be pruned (remaining ${count(groups.legacyOld)})`);
  expectRepaired(count(groups.deadAged) === 20, `dead-owner directories past grace must be capped to the 20 newest (remaining ${count(groups.deadAged)})`);
  expectRepaired(groups.deadAged.slice(0, 20).every(exists), 'the cap keeps the newest dead-owner directories');
  expectRepaired(existsSync(join(created, 'owner.json')), 'a new fixture directory records its owner for later pruning');
} finally {
  live.kill('SIGKILL');
  rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
if (red.length) {
  console.log(`${MARKER} (${red.length} failing expectations, ${checks} passing checks)`);
  for (const line of red) console.log(`  - ${line}`);
  process.exit(1);
}
console.log(`retained fixture machine directories are bounded (${checks} checks)`);
