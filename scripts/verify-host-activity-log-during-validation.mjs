#!/usr/bin/env node
// Lab host-activity-log-during-validation RED/GREEN.
//
// Bug: the Claude Code PostToolUse hook (.claude/hooks/log-tools.cjs, copied into
// projects by `proof-or-stop init`) appends every tool call into the repository
// (docs/story/activity.jsonl) even while that same worktree is running a
// validation. Validation fixtures that guard the worktree against mutation then
// observe the host's own bookkeeping: on 2026-09-17 a quorum smoke run with 73/73
// cases passing was reported FAIL because of these appends.
//
// Contract after the repair: the hook writes a line ONLY while it holds the
// product's own workspace validation capacity ticket, so a validation can never
// overlap the write. When capacity cannot be held - a validation is running, one
// is arriving, the queue state is unreadable, discovery is uncertain, or the
// destination escapes the worktree - the line is DROPPED. Host bookkeeping is
// advisory; it must never delay, block or disturb a validation, and a durable
// queue was deliberately not used (see the notes for that decision).
//
// Drives this checkout's real hook script against disposable repositories and a
// disposable HOME, and interoperates with the PRODUCT's own capacity allocator.
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'host activity hook writes into the repository during its validation';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hook = join(repoRoot, '.claude/hooks/log-tools.cjs');
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pos-activity-hook-')));
const home = join(sandbox, 'home'); mkdirSync(home);
const red = [];
let checks = 0;
const expectRepaired = (ok, message) => { if (ok) checks++; else red.push(message); };
const control = (ok, message) => { if (!ok) throw new Error(`control failed (not the target RED): ${message}`); checks++; };
const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const deadPid = Number(spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim());
const cleanUp = () => {
  live.kill('SIGKILL');
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
};
process.on('uncaughtException', (error) => { cleanUp(); throw error; });

// The product's own allocator drives the interoperability scenarios, so the hook's
// ticket protocol is exercised against the real implementation, not a fixture.
const dist = join(repoRoot, 'packages/main/dist');
const build = spawnSync('npm', ['--prefix', 'packages/main', 'run', 'build'], { cwd: repoRoot, encoding: 'utf8' });
if (build.status !== 0) { process.stderr.write(`${build.stdout}\n${build.stderr}\n`); cleanUp(); throw new Error('packages/main build failed; this is not the target RED'); }
const allocatorScript = join(sandbox, 'allocator.mjs');
writeFileSync(allocatorScript, `
import { existsSync, writeFileSync } from 'node:fs';
const { withWorkspaceValidationCapacity } = await import(${JSON.stringify(`file://${join(dist, 'core/validation-execution-lock.js')}`)});
const [root, ready, release] = process.argv.slice(2);
await withWorkspaceValidationCapacity({ root, workspaceRoot: root, workspaceOnly: true, command: 'validate', deadlineAt: Date.now() + 60000 }, async () => {
  writeFileSync(ready, String(Date.now()));
  const deadline = Date.now() + 60000;
  while (!existsSync(release) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
});
`);

let n = 0;
function repo() {
  const root = join(sandbox, `repo-${n++}`); mkdirSync(root);
  const git = (args) => execFileSync('git', ['-c', 'user.name=Hook Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, stdio: 'ignore' });
  git(['init', '-q']); writeFileSync(join(root, '.gitignore'), '**/activity.jsonl\n'); git(['add', '.']); git(['commit', '-qm', 'base']);
  return root;
}
function capacityDirFor(root) {
  const top = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim());
  const commonRaw = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: top, encoding: 'utf8' }).trim();
  const common = realpathSync(isAbsolute(commonRaw) ? commonRaw : resolve(top, commonRaw));
  const shared = common.endsWith('/.git') ? dirname(common) : common;
  return join(shared, '.proof-or-stop/locks/validation-capacity.lock/workspaces', createHash('sha256').update(top).digest('hex'));
}
function ticket(root, pid, workspace = root) {
  const dir = join(capacityDirFor(workspace), `0000000000000001-fixture-${pid}.ticket`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'holder.json'), JSON.stringify({ lockId: `fixture-${pid}`, pid, hostname: 'fixture', command: 'validate', acquiredAt: new Date().toISOString() }));
  return dir;
}
const hookInput = (root, command) => JSON.stringify({ cwd: root, tool_name: 'Bash', tool_input: { command }, hook_event_name: 'PostToolUse', session_id: 'hook-fixture', tool_output: 'ok' });
function callHook(root, command, env = {}, timeout = 20_000) {
  // A hook that blocks (an unreadable destination, a FIFO) is killed rather than hanging
  // the run; scenarios that care report it.
  const r = spawnSync(process.execPath, [hook], { input: hookInput(root, command), env: { ...process.env, HOME: home, ...env }, encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
  if (r.status !== 0 && !(r.error && r.error.code === 'ETIMEDOUT')) throw new Error(`hook exited ${r.status}: ${r.stderr}`);
  return r;
}
function callHookAsync(root, command, env = {}) {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [hook], { env: { ...process.env, HOME: home, ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('exit', (code) => resolveExit(code));
    child.stdin.end(hookInput(root, command));
  });
}
const log = (root) => join(root, 'docs/story/activity.jsonl');
const lines = (root) => existsSync(log(root)) ? readFileSync(log(root), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).detail) : [];
async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
}
const treeSnapshot = (root) => {
  const seen = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name);
      seen.push(full);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
    }
  };
  walk(root);
  return seen.sort();
};

const rows = [];
try {
  // The repair: a live validation in this worktree keeps the hook out entirely.
  {
    const root = repo();
    const t = ticket(root, live.pid);
    const before = treeSnapshot(root);
    callHook(root, 'during-validation-1');
    callHook(root, 'during-validation-2');
    const during = lines(root);
    const created = treeSnapshot(root).filter((entry) => !before.includes(entry));
    rows.push({ scenario: 'validation active in this worktree', during: during.length, detail: `${created.length} entries created` });
    expectRepaired(during.length === 0, `no repository write while this worktree validates (found ${JSON.stringify(during)})`);
    expectRepaired(created.length === 0, `nothing at all may be created inside a validating worktree (created ${JSON.stringify(created)})`);
    rmSync(t, { recursive: true, force: true });
    callHook(root, 'after-validation');
    rows[rows.length - 1].detail += `; after: ${JSON.stringify(lines(root))}`;
    expectRepaired(JSON.stringify(lines(root)) === JSON.stringify(['after-validation']),
      `logging resumes once the validation ends (got ${JSON.stringify(lines(root))})`);
  }
  // A validation that arrives while the hook is choosing its ticket keeps it out too.
  {
    const root = repo();
    const barrier = join(sandbox, 'barrier-choosing');
    writeFileSync(barrier, 'hold');
    const writing = callHookAsync(root, 'choosing-window', { PROOF_OR_STOP_ACTIVITY_TICKET_BARRIER: barrier });
    const announced = await waitUntil(() => { try { return readdirSync(capacityDirFor(root)).some((name) => name.endsWith('.choosing')); } catch { return false; } }, 4000);
    expectRepaired(announced, 'the hook announces its arrival before reading ticket numbers');
    const arriving = ticket(root, live.pid);
    rmSync(barrier, { force: true });
    await writing;
    const during = lines(root);
    rows.push({ scenario: 'validation arrives during the choosing window', during: during.length, detail: '-' });
    expectRepaired(during.length === 0, `a validation arriving mid-admission keeps the hook out (found ${JSON.stringify(during)})`);
    rmSync(arriving, { recursive: true, force: true });
  }
  // A capacity entry whose holder cannot be read is uncertain: the hook stays out.
  {
    const root = repo();
    const t = ticket(root, live.pid);
    chmodSync(join(t, 'holder.json'), 0o000);
    callHook(root, 'unreadable-holder');
    const during = lines(root);
    rows.push({ scenario: 'capacity holder record unreadable', during: during.length, detail: '-' });
    expectRepaired(during.length === 0, `an unreadable capacity holder must keep the hook out (found ${JSON.stringify(during)})`);
    chmodSync(join(t, 'holder.json'), 0o600);
    rmSync(t, { recursive: true, force: true });
  }
  // Interoperability with the REAL allocator, in both orders, including a linked worktree.
  for (const linked of [false, true]) {
    const base = repo();
    let root = base;
    if (linked) {
      root = join(sandbox, `linked-${n++}`);
      execFileSync('git', ['-c', 'user.name=Hook Fixture', '-c', 'user.email=fixture@example.invalid', 'worktree', 'add', '-q', '--detach', root], { cwd: base, stdio: 'ignore' });
    }
    const ready = join(sandbox, `alloc-ready-${linked}`), release = join(sandbox, `alloc-release-${linked}`);
    const holder = spawn(process.execPath, [allocatorScript, root, ready, release], { stdio: 'inherit', env: { ...process.env, HOME: home } });
    const holderExit = new Promise((r) => holder.on('exit', r));
    control(await waitUntil(() => existsSync(ready), 30_000), `the product allocator acquired workspace capacity (${linked ? 'linked' : 'main'})`);
    callHook(root, `allocator-first-${linked}`);
    const during = lines(root);
    writeFileSync(release, 'go');
    await holderExit;
    expectRepaired(during.length === 0, `the real allocator's capacity keeps the hook out (${linked ? 'linked' : 'main'}: found ${JSON.stringify(during)})`);
    // The reverse order: the hook's own ticket makes the allocator wait for it.
    const ready2 = join(sandbox, `alloc2-ready-${linked}`), release2 = join(sandbox, `alloc2-release-${linked}`);
    const barrier = join(sandbox, `barrier-alloc-${linked}`);
    writeFileSync(barrier, 'hold');
    const writing = callHookAsync(root, `hook-first-${linked}`, { PROOF_OR_STOP_ACTIVITY_ADMISSION_BARRIER: barrier });
    // Publishing a ticket at all is part of the repair: without it there is no interval in
    // which the allocator could be made to wait.
    const published = await waitUntil(() => { try { return readdirSync(capacityDirFor(root)).some((name) => name.endsWith('.ticket')); } catch { return false; } }, 15_000);
    expectRepaired(published, `the hook takes a capacity ticket before writing (${linked ? 'linked' : 'main'})`);
    const contender = spawn(process.execPath, [allocatorScript, root, ready2, release2], { stdio: 'inherit', env: { ...process.env, HOME: home } });
    const contenderExit = new Promise((r) => contender.on('exit', r));
    const admittedEarly = published ? await waitUntil(() => existsSync(ready2), 2000) : false;
    rmSync(barrier, { force: true });
    await writing;
    control(await waitUntil(() => existsSync(ready2), 30_000), 'the allocator is admitted once the hook releases its ticket');
    writeFileSync(release2, 'go');
    await contenderExit;
    rows.push({ scenario: `real allocator interop (${linked ? 'linked worktree' : 'main worktree'})`, during: during.length, detail: JSON.stringify(lines(root)) });
    expectRepaired(published && !admittedEarly, `the real allocator waits behind the hook's ticket (${linked ? 'linked' : 'main'})`);
    expectRepaired(lines(root).includes(`hook-first-${linked}`), `the hook's own line is written under its ticket (${linked ? 'linked' : 'main'}: got ${JSON.stringify(lines(root))})`);
  }
  // Destination binding: no symlink may carry the line out of this worktree.
  for (const [name, prepare] of [
    ['directory symlink', (source, other) => { rmSync(join(source, 'docs'), { recursive: true, force: true }); symlinkSync(join(other, 'docs'), join(source, 'docs')); }],
    ['existing log symlink', (source, other) => {
      mkdirSync(join(source, 'docs/story'), { recursive: true }); mkdirSync(join(other, 'docs/story'), { recursive: true });
      writeFileSync(join(other, 'docs/story/activity.jsonl'), '');
      symlinkSync(join(other, 'docs/story/activity.jsonl'), join(source, 'docs/story/activity.jsonl'));
    }],
    ['dangling log symlink', (source, other) => {
      mkdirSync(join(source, 'docs/story'), { recursive: true }); mkdirSync(join(other, 'docs/story'), { recursive: true });
      symlinkSync(join(other, 'docs/story/absent.jsonl'), join(source, 'docs/story/activity.jsonl'));
    }],
  ]) {
    const source = repo();
    const other = repo();
    prepare(source, other);
    const otherTicket = ticket(other, live.pid); // the destination repository is validating
    callHook(source, `escape-${name.replace(/\W+/g, '-')}`);
    const escaped = treeSnapshot(other).filter((entry) => entry.endsWith('.jsonl') && readFileSync(entry, 'utf8').length > 0);
    rows.push({ scenario: `destination escapes through a ${name}`, during: escaped.length, detail: '-' });
    expectRepaired(escaped.length === 0, `a ${name} must not carry the line into another validating repository (wrote ${JSON.stringify(escaped)})`);
    rmSync(otherTicket, { recursive: true, force: true });
  }
  // A symlink CHAIN, and a link to something that is not a plain file.
  {
    const source = repo();
    const other = repo();
    mkdirSync(join(source, 'docs/story'), { recursive: true });
    mkdirSync(join(other, 'docs/story'), { recursive: true });
    writeFileSync(join(other, 'docs/story/activity.jsonl'), '');
    symlinkSync(join(other, 'docs/story/activity.jsonl'), join(source, 'relay.jsonl'));
    symlinkSync(join(source, 'relay.jsonl'), join(source, 'docs/story/activity.jsonl'));
    const otherTicket = ticket(other, live.pid);
    callHook(source, 'chained-symlink');
    const escaped = readFileSync(join(other, 'docs/story/activity.jsonl'), 'utf8');
    rows.push({ scenario: 'destination escapes through a symlink chain', during: escaped.length, detail: '-' });
    expectRepaired(escaped.length === 0, `a symlink chain must not carry the line into another validating repository (wrote ${JSON.stringify(escaped)})`);
    rmSync(otherTicket, { recursive: true, force: true });
  }
  {
    const root = repo();
    mkdirSync(join(root, 'docs/story'), { recursive: true });
    spawnSync('mkfifo', [join(root, 'pipe')]);
    symlinkSync(join(root, 'pipe'), join(root, 'docs/story/activity.jsonl'));
    const started = Date.now();
    const r = callHook(root, 'symlink-to-fifo', {}, 8000);
    const elapsed = Date.now() - started;
    const blocked = Boolean(r.error && r.error.code === 'ETIMEDOUT');
    rows.push({ scenario: 'log symlink points at a FIFO', during: elapsed, detail: blocked ? 'blocked' : `exit ${r.status}` });
    expectRepaired(!blocked && elapsed < 5000, `a FIFO destination must not block the hook (took ${elapsed}ms${blocked ? ', killed' : ''})`);
  }
  // A directory outside any repository whose destination resolves INTO a repository.
  {
    const plain = join(sandbox, `plain-redirect-${n++}`); mkdirSync(plain, { recursive: true });
    const validating = repo();
    mkdirSync(join(validating, 'docs/story'), { recursive: true });
    symlinkSync(join(validating, 'docs'), join(plain, 'docs'));
    const t = ticket(validating, live.pid);
    callHook(plain, 'redirected-into-repository');
    const escaped = lines(validating);
    rows.push({ scenario: 'non-repository cwd redirected into a validating repository', during: escaped.length, detail: '-' });
    expectRepaired(escaped.length === 0, `a destination inside a validating repository must not be written directly (found ${JSON.stringify(escaped)})`);
    rmSync(t, { recursive: true, force: true });
    callHook(plain, 'after-redirect');
    expectRepaired(lines(validating).includes('after-redirect'),
      `the redirected destination is written once nothing is validating (got ${JSON.stringify(lines(validating))})`);
  }
  // A hard link shares an inode with another repository: writing it changes that file.
  {
    const source = repo();
    const other = repo();
    mkdirSync(join(source, 'docs/story'), { recursive: true });
    mkdirSync(join(other, 'docs/story'), { recursive: true });
    writeFileSync(join(other, 'docs/story/activity.jsonl'), '');
    execFileSync('ln', [join(other, 'docs/story/activity.jsonl'), join(source, 'docs/story/activity.jsonl')]);
    const otherTicket = ticket(other, live.pid);
    callHook(source, 'hard-linked-log');
    const escaped = readFileSync(join(other, 'docs/story/activity.jsonl'), 'utf8');
    rows.push({ scenario: 'log hard-linked into another repository', during: escaped.length, detail: '-' });
    expectRepaired(escaped.length === 0, `a hard-linked log must not change another validating repository's file (wrote ${JSON.stringify(escaped)})`);
    rmSync(otherTicket, { recursive: true, force: true });
  }
  // A holder record that is a FIFO must not hang the hook while it holds its own ticket.
  {
    const root = repo();
    const dir = join(capacityDirFor(root), '0000000000000001-fifo-holder.ticket');
    mkdirSync(dir, { recursive: true });
    spawnSync('mkfifo', [join(dir, 'holder.json')]);
    const started = Date.now();
    const r = callHook(root, 'fifo-holder', {}, 8000);
    const elapsed = Date.now() - started;
    const blocked = Boolean(r.error && r.error.code === 'ETIMEDOUT');
    const leftover = readdirSync(capacityDirFor(root)).filter((name) => name.endsWith('.ticket') || name.endsWith('.choosing'));
    rows.push({ scenario: 'capacity holder record is a FIFO', during: elapsed, detail: blocked ? 'blocked' : `${leftover.length} entries left` });
    expectRepaired(!blocked, `a FIFO holder record must not block the hook (took ${elapsed}ms)`);
    expectRepaired(leftover.length === 1, `the hook removes its own ticket (left ${JSON.stringify(leftover)})`);
    rmSync(dir, { recursive: true, force: true });
  }
  // The destination is replaced during admission: the write must not follow it.
  for (const [name, swap] of [
    ['log replaced by a symlink', (source, other) => { rmSync(join(source, 'docs/story/activity.jsonl'), { force: true }); symlinkSync(join(other, 'docs/story/activity.jsonl'), join(source, 'docs/story/activity.jsonl')); }],
    ['parent replaced by a symlink', (source, other) => { rmSync(join(source, 'docs'), { recursive: true, force: true }); symlinkSync(join(other, 'docs'), join(source, 'docs')); }],
  ]) {
    const source = repo();
    const other = repo();
    mkdirSync(join(source, 'docs/story'), { recursive: true });
    mkdirSync(join(other, 'docs/story'), { recursive: true });
    writeFileSync(join(source, 'docs/story/activity.jsonl'), '');
    writeFileSync(join(other, 'docs/story/activity.jsonl'), '');
    const barrier = join(sandbox, `barrier-swap-${n++}`);
    writeFileSync(barrier, 'hold');
    const writing = callHookAsync(source, `swap-${name.replace(/\W+/g, '-')}`, { PROOF_OR_STOP_ACTIVITY_ADMISSION_BARRIER: barrier });
    // Taking a ticket at all is part of the repair; without it there is no admitted
    // interval in which the destination could be swapped.
    const admitted = await waitUntil(() => { try { return readdirSync(capacityDirFor(source)).some((entry) => entry.endsWith('.ticket')); } catch { return false; } }, 4000);
    expectRepaired(admitted, `the hook takes a ticket before writing (${name})`);
    swap(source, other);
    const otherTicket = ticket(other, live.pid); // the destination repository is validating
    rmSync(barrier, { force: true });
    await writing;
    const escaped = readFileSync(join(other, 'docs/story/activity.jsonl'), 'utf8');
    rows.push({ scenario: `destination swapped during admission (${name})`, during: escaped.length, detail: '-' });
    expectRepaired(escaped.length === 0, `a ${name} during admission must not redirect the write (wrote ${JSON.stringify(escaped)})`);
    rmSync(otherTicket, { recursive: true, force: true });
  }
  // Discovery: uncertainty never reads as "no repository".
  for (const [name, script] of [
    ['git exits without a diagnostic', '#!/bin/sh\nexit 128\n'],
    ['git reports broken repository metadata', '#!/bin/sh\necho "fatal: not a git repository: /work/.git" >&2\nexit 128\n'],
  ]) {
    const root = repo();
    const t = ticket(root, live.pid);
    const brokenGit = join(sandbox, `broken-git-${n++}`); mkdirSync(brokenGit, { recursive: true });
    writeFileSync(join(brokenGit, 'git'), script); chmodSync(join(brokenGit, 'git'), 0o755);
    const r = callHook(root, `uncertain-${name.replace(/\W+/g, '-')}`, { PATH: `${brokenGit}:${process.env.PATH}` });
    control(r.status === 0, `the hook exits 0 when ${name}`);
    const during = lines(root);
    rows.push({ scenario: `uncertain discovery: ${name}`, during: during.length, detail: '-' });
    expectRepaired(during.length === 0, `${name}: uncertainty must not be read as "no repository" (found ${JSON.stringify(during)})`);
    rmSync(t, { recursive: true, force: true });
  }
  // Inherited repository overrides must not redirect discovery.
  {
    const validating = repo();
    const other = repo();
    const t = ticket(validating, live.pid);
    callHook(validating, 'override-redirected', { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other });
    const during = lines(validating);
    rows.push({ scenario: 'GIT_DIR/GIT_WORK_TREE point at another repository', during: during.length, detail: '-' });
    expectRepaired(during.length === 0, `overrides must not bypass the cwd worktree's validation (found ${JSON.stringify(during)})`);
    control(lines(other).length === 0, 'nothing is written into the overridden repository either');
    rmSync(t, { recursive: true, force: true });
  }
  // Controls: the unchanged behavior when nothing is validating.
  for (const [name, setup] of [
    ['no validation ticket', () => {}],
    ['dead ticket holder', (root) => ticket(root, deadPid)],
    ['ticket for another worktree', () => { const other = repo(); ticket(other, live.pid); }],
  ]) {
    const root = repo();
    setup(root);
    callHook(root, `control-${name}`);
    rows.push({ scenario: `control: ${name}`, during: lines(root).length, detail: '-' });
    control(JSON.stringify(lines(root)) === JSON.stringify([`control-${name}`]), `${name}: the hook writes into the repository immediately`);
  }
  {
    const plain = join(sandbox, `plain-${n++}`); mkdirSync(plain, { recursive: true });
    callHook(plain, 'not-a-repository');
    rows.push({ scenario: 'control: directory outside any repository', during: lines(plain).length, detail: '-' });
    control(JSON.stringify(lines(plain)) === JSON.stringify(['not-a-repository']), 'a non-repository directory is logged immediately');
  }
  // A failing build must not leave this verifier's own children or sandboxes behind.
  if (!process.env.HOOK_VERIFIER_NESTED) {
    const brokenNpm = join(sandbox, 'broken-npm'); mkdirSync(brokenNpm, { recursive: true });
    writeFileSync(join(brokenNpm, 'npm'), '#!/bin/sh\nexit 1\n'); chmodSync(join(brokenNpm, 'npm'), 0o755);
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith('pos-activity-hook-'));
    const nested = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, HOOK_VERIFIER_NESTED: '1', PATH: `${brokenNpm}:${process.env.PATH}` }, encoding: 'utf8', timeout: 120_000,
    });
    const leaked = readdirSync(tmpdir()).filter((name) => name.startsWith('pos-activity-hook-') && !before.includes(name));
    rows.push({ scenario: 'verifier cleanup when its build fails', during: nested.status, detail: `${leaked.length} sandboxes leaked` });
    control(nested.status !== 0 && /build failed/.test(`${nested.stdout}${nested.stderr}`), 'a failing build stops the verifier');
    expectRepaired(leaked.length === 0, `a failing build leaves no sandbox behind (found ${JSON.stringify(leaked)})`);
  }
} finally {
  cleanUp();
}
console.log('scenario | repository lines while active | detail');
for (const r of rows) console.log(`${r.scenario} | ${r.during} | ${r.detail}`);
if (red.length) {
  console.log(`${MARKER} (${red.length} failing expectations, ${checks} passing checks)`);
  for (const line of red) console.log(`  - ${line}`);
  process.exit(1);
}
console.log(`host activity lines are written only under a validation capacity ticket (${checks} checks)`);
