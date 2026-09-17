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
// Drives this checkout's real hook script against a disposable repository and a
// disposable HOME. "Validation active" is the product's own signal: a workspace
// validation capacity ticket for this worktree whose holder process is alive.
// Controls: no ticket, a dead holder, and a ticket for another worktree keep the
// original behavior (write into the repository immediately); after the validation
// ends, the next tool call delivers the deferred lines in order.
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

let n = 0;
function repo() {
  const root = join(sandbox, `repo-${n++}`); mkdirSync(root);
  const git = (args) => execFileSync('git', ['-c', 'user.name=Hook Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, stdio: 'ignore' });
  git(['init', '-q']); writeFileSync(join(root, '.gitignore'), '**/activity.jsonl\n'); git(['add', '.']); git(['commit', '-qm', 'base']);
  return root;
}
function ticket(root, pid, workspace = root) {
  const key = createHash('sha256').update(realpathSync(workspace)).digest('hex');
  const dir = join(root, '.proof-or-stop/locks/validation-capacity.lock/workspaces', key, `0000000000000001-fixture-${pid}.ticket`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'holder.json'), JSON.stringify({ lockId: `fixture-${pid}`, pid, hostname: 'fixture', command: 'validate', acquiredAt: new Date().toISOString() }));
  return dir;
}
function callHook(root, command) {
  const input = JSON.stringify({ cwd: root, tool_name: 'Bash', tool_input: { command }, hook_event_name: 'PostToolUse', session_id: 'hook-fixture', tool_output: 'ok' });
  const r = spawnSync(process.execPath, [hook], { input, env: { ...process.env, HOME: home }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`hook exited ${r.status}: ${r.stderr}`);
}
function callHookAsync(root, command, env = {}) {
  const input = JSON.stringify({ cwd: root, tool_name: 'Bash', tool_input: { command }, hook_event_name: 'PostToolUse', session_id: 'hook-fixture', tool_output: 'ok' });
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [hook], { env: { ...process.env, HOME: home, ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('exit', (code) => resolveExit(code));
    child.stdin.end(input);
  });
}
const spoolFor = (root) => join(home, '.proof-or-stop/activity-spool', createHash('sha256').update(realpathSync(root)).digest('hex'));
const lockFor = (root) => join(spoolFor(root), '.flush.lock');
const spoolRecords = (root) => { try { return readdirSync(spoolFor(root)).filter((name) => name.endsWith('.json')).sort(); } catch { return []; } };
const capacityDir = (root) => join(root, '.proof-or-stop/locks/validation-capacity.lock/workspaces', createHash('sha256').update(realpathSync(root)).digest('hex'));
const capacityEntriesFor = (root) => {
  try {
    const top = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim());
    const commonRaw = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: top, encoding: 'utf8' }).trim();
    const common = realpathSync(isAbsolute(commonRaw) ? commonRaw : resolve(top, commonRaw));
    const shared = common.endsWith('/.git') ? dirname(common) : common;
    return readdirSync(join(shared, '.proof-or-stop/locks/validation-capacity.lock/workspaces', createHash('sha256').update(top).digest('hex')));
  } catch { return []; }
};
const capacityEntries = (root) => { try { return readdirSync(capacityDir(root)); } catch { return []; } };
const spoolClaims = (root) => { try { return readdirSync(spoolFor(root)).filter((name) => name.includes('.delivering-')); } catch { return []; } };
async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
}
const log = (root) => join(root, 'docs/story/activity.jsonl');
const lines = (root) => existsSync(log(root)) ? readFileSync(log(root), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).detail) : [];

// A child that takes workspace validation capacity through the PRODUCT's own allocator,
// so interoperability is exercised against the real implementation, not a fixture.
const dist = join(repoRoot, 'packages/main/dist');
const build = spawnSync('npm', ['--prefix', 'packages/main', 'run', 'build'], { cwd: repoRoot, encoding: 'utf8' });
if (build.status !== 0) { process.stderr.write(`${build.stdout}\n${build.stderr}\n`); throw new Error('packages/main build failed; this is not the target RED'); }
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

const rows = [];
try {
  // Active validation in this worktree: the repository must not be written.
  {
    const root = repo();
    const t = ticket(root, live.pid);
    callHook(root, 'during-validation-1');
    callHook(root, 'during-validation-2');
    const during = lines(root);
    rows.push({ scenario: 'validation active in this worktree', repoLinesDuring: during.length, after: '-' });
    expectRepaired(during.length === 0, `no repository write while this worktree validates (found ${JSON.stringify(during)})`);
    rmSync(t, { recursive: true, force: true });
    callHook(root, 'after-validation');
    const after = lines(root);
    rows[rows.length - 1].after = JSON.stringify(after);
    expectRepaired(JSON.stringify(after) === JSON.stringify(['during-validation-1', 'during-validation-2', 'after-validation']),
      `deferred lines are delivered in order once validation ends (got ${JSON.stringify(after)})`);
  }
  // Ordering: while older deferred lines are pending, new lines queue behind them.
  {
    const root = repo();
    const t = ticket(root, live.pid);
    for (let i = 0; i < 20; i++) callHook(root, `queued-${i}`);
    rmSync(t, { recursive: true, force: true });
    const parallel = await Promise.all(Array.from({ length: 8 }, (_, i) => callHookAsync(root, `parallel-${i}`)));
    // A producer whose flush is blocked by another flusher leaves its record for the
    // next hook, so one more call settles whatever is still queued.
    callHook(root, 'settle');
    const after = lines(root);
    const queued = Array.from({ length: 20 }, (_, i) => `queued-${i}`);
    rows.push({ scenario: 'eight hooks start together after validation ends', repoLinesDuring: '-', after: `${after.length} lines` });
    control(parallel.every((code) => code === 0), 'every concurrent hook exits 0');
    expectRepaired(JSON.stringify(after.slice(0, 20)) === JSON.stringify(queued),
      `deferred lines precede every line written after validation (got ${JSON.stringify(after.slice(0, 22))})`);
    expectRepaired(after.length === 29 && new Set(after).size === 29
      && after.slice(20, 28).every((d) => d.startsWith('parallel-')) && after[28] === 'settle',
      `no line is lost or duplicated under concurrent flushes (got ${after.length} lines, ${new Set(after).size} distinct, tail ${JSON.stringify(after.slice(20))})`);
  }
  // Another hook is mid-delivery: its claim on the oldest record is live, so a new line
  // must not overtake it (ordering no longer depends on any lock).
  {
    const root = repo();
    const t = ticket(root, live.pid);
    callHook(root, 'pending-1');
    rmSync(t, { recursive: true, force: true });
    const spool = spoolFor(root);
    const [oldest] = spoolRecords(root);
    renameSync(join(spool, oldest), join(spool, `${oldest}.delivering-${live.pid}`));
    callHook(root, 'while-another-hook-delivers');
    const whileHeld = lines(root);
    renameSync(join(spool, `${oldest}.delivering-${live.pid}`), join(spool, oldest));
    callHook(root, 'after-delivery');
    const after = lines(root);
    rows.push({ scenario: 'another live hook is delivering the oldest record', repoLinesDuring: whileHeld.length, after: JSON.stringify(after) });
    expectRepaired(whileHeld.length === 0, `a new line does not overtake a record another hook is delivering (found ${JSON.stringify(whileHeld)})`);
    expectRepaired(JSON.stringify(after) === JSON.stringify(['pending-1', 'while-another-hook-delivers', 'after-delivery']),
      `order is preserved once the other hook's claim is released (got ${JSON.stringify(after)})`);
  }
  // A validation that starts DURING a flush: the flusher re-checks before every record,
  // so not one further line reaches the repository once it is active.
  {
    const root = repo();
    const t = ticket(root, live.pid);
    for (let i = 0; i < 4; i++) callHook(root, `mid-flush-${i}`);
    rmSync(t, { recursive: true, force: true });
    const barrier = join(sandbox, 'barrier-mid-flush');
    writeFileSync(barrier, 'hold');
    const flushing = callHookAsync(root, 'flusher', { PROOF_OR_STOP_ACTIVITY_SPOOL_BARRIER: barrier });
    // The flusher publishes its own record and then pauses at the barrier before the
    // first delivery: five queued records prove it is inside the delivery loop.
    const reached = await waitUntil(() => spoolRecords(root).length >= 5, 10_000);
    control(reached, 'the flusher reached its first delivery before the barrier was released');
    const beforeRestart = lines(root).length;
    const restarted = ticket(root, live.pid); // a validation starts while the flusher is paused
    rmSync(barrier, { force: true });
    await flushing;
    const during = lines(root);
    const pending = spoolRecords(root).length + spoolClaims(root).length;
    rows.push({ scenario: 'validation starts during a flush', repoLinesDuring: `${beforeRestart} -> ${during.length}`, after: `${pending} records still spooled` });
    expectRepaired(during.length === beforeRestart,
      `no further line may reach the repository once a validation is active (was ${beforeRestart}, now ${during.length}: ${JSON.stringify(during)})`);
    expectRepaired(pending > 0, 'the undelivered records stay outside the repository');
    rmSync(restarted, { recursive: true, force: true });
    callHook(root, 'after-second-validation');
    const after = lines(root);
    expectRepaired(after.length === 6 && new Set(after).size === 6,
      `every record is delivered exactly once after the second validation ends (got ${JSON.stringify(after)})`);
  }
  // The same check governs a hook with nothing pending: a validation arriving inside its
  // write window leaves the line outside the repository.
  {
    const root = repo();
    const barrier = join(sandbox, 'barrier-immediate');
    writeFileSync(barrier, 'hold');
    const writing = callHookAsync(root, 'immediate', { PROOF_OR_STOP_ACTIVITY_SPOOL_BARRIER: barrier });
    // Every repository write must go through the queue, so even a hook with nothing
    // pending publishes its record first and can be paused before delivering it.
    const reached = await waitUntil(() => spoolRecords(root).length > 0, 10_000);
    expectRepaired(reached, 'an immediate write must be queued before it reaches the repository');
    const arriving = ticket(root, live.pid);
    rmSync(barrier, { force: true });
    await writing;
    const during = lines(root);
    rows.push({ scenario: 'validation arrives inside an immediate write window', repoLinesDuring: during.length, after: `${spoolRecords(root).length} records spooled` });
    expectRepaired(during.length === 0, `an immediate write must not land once a validation is active (found ${JSON.stringify(during)})`);
    rmSync(arriving, { recursive: true, force: true });
    callHook(root, 'immediate-after');
    expectRepaired(JSON.stringify(lines(root)) === JSON.stringify(['immediate', 'immediate-after']),
      `the deferred immediate line is delivered in order afterwards (got ${JSON.stringify(lines(root))})`);
  }
  // A producer publishing while another hook drains: nothing is lost.
  {
    const root = repo();
    const t = ticket(root, live.pid);
    for (let i = 0; i < 6; i++) callHook(root, `pre-${i}`);
    rmSync(t, { recursive: true, force: true });
    const barrier = join(sandbox, 'barrier-producer');
    writeFileSync(barrier, 'hold');
    const flushing = callHookAsync(root, 'draining', { PROOF_OR_STOP_ACTIVITY_SPOOL_BARRIER: barrier });
    control(await waitUntil(() => spoolRecords(root).length >= 7, 10_000), 'the draining hook reached its first delivery');
    const producers = await Promise.all([0, 1, 2].map((i) => callHookAsync(root, `concurrent-${i}`)));
    rmSync(barrier, { force: true });
    await flushing;
    callHook(root, 'settle');
    const after = lines(root);
    rows.push({ scenario: 'producers publish while another hook drains', repoLinesDuring: '-', after: `${after.length} lines` });
    control(producers.every((code) => code === 0), 'every concurrent producer exits 0');
    expectRepaired(after.length === 11 && new Set(after).size === 11,
      `no record is lost or duplicated when producers and a flusher overlap (got ${after.length} lines, ${new Set(after).size} distinct)`);
  }
  // Two hooks delivering at the same time: only the oldest record is ever claimable, so
  // order is preserved and nothing is lost or duplicated.
  {
    const root = repo();
    const t = ticket(root, live.pid);
    for (let i = 0; i < 4; i++) callHook(root, `ordered-${i}`);
    rmSync(t, { recursive: true, force: true });
    const racers = await Promise.all([0, 1].map((i) => callHookAsync(root, `racer-${i}`)));
    callHook(root, 'settle-race');
    const after = lines(root);
    rows.push({ scenario: 'two hooks deliver concurrently', repoLinesDuring: '-', after: `${after.length} lines` });
    control(racers.every((code) => code === 0), 'both concurrent hooks exit 0');
    expectRepaired(JSON.stringify(after.slice(0, 4)) === JSON.stringify(['ordered-0', 'ordered-1', 'ordered-2', 'ordered-3'])
      && after.length === 7 && new Set(after).size === 7,
      `concurrent delivery keeps the deferred order and loses nothing (got ${JSON.stringify(after)})`);
  }
  // A record claimed by a flusher that died, and a target that cannot be written yet.
  {
    const root = repo();
    const t = ticket(root, live.pid);
    callHook(root, 'abandoned-1');
    rmSync(t, { recursive: true, force: true });
    const spool = spoolFor(root);
    const [record] = spoolRecords(root);
    // Without per-record files there is nothing a dead flusher could have claimed; that
    // absence is itself the defect, so report it instead of crashing.
    if (record) renameSync(join(spool, record), join(spool, `${record}.delivering-${deadPid}`));
    else red.push('a deferred record must be an individually recoverable file (no record file found)');
    callHook(root, 'after-abandoned');
    const after = lines(root);
    rows.push({ scenario: 'record claimed by a dead flusher', repoLinesDuring: '-', after: JSON.stringify(after) });
    expectRepaired(JSON.stringify(after) === JSON.stringify(['abandoned-1', 'after-abandoned']),
      `a record claimed by a dead flusher is recovered in order (got ${JSON.stringify(after)})`);
  }
  {
    const root = repo();
    const t = ticket(root, live.pid);
    callHook(root, 'retry-1');
    rmSync(t, { recursive: true, force: true });
    mkdirSync(join(root, 'docs/story'), { recursive: true });
    chmodSync(join(root, 'docs/story'), 0o500); // target temporarily unwritable
    callHook(root, 'retry-2');
    const blocked = spoolRecords(root).length + spoolClaims(root).length;
    chmodSync(join(root, 'docs/story'), 0o700);
    callHook(root, 'retry-3');
    const after = lines(root);
    rows.push({ scenario: 'target unwritable, then writable', repoLinesDuring: blocked, after: JSON.stringify(after) });
    expectRepaired(blocked >= 2, `a failed target write retains its records (retained ${blocked})`);
    expectRepaired(JSON.stringify(after) === JSON.stringify(['retry-1', 'retry-2', 'retry-3']),
      `retained records are delivered in order once the target is writable again (got ${JSON.stringify(after)})`);
  }
  // A validation publishing its ticket while this hook is between announcing its arrival
  // and publishing its own ticket: the hook must see it and leave the line queued.
  {
    const root = repo();
    const barrier = join(sandbox, 'barrier-choosing');
    writeFileSync(barrier, 'hold');
    const writing = callHookAsync(root, 'choosing-window', { PROOF_OR_STOP_ACTIVITY_TICKET_BARRIER: barrier });
    // Announcing the arrival before reading ticket numbers is itself part of the repair:
    // without it there is no window in which a validation can be seen at all.
    const announced = await waitUntil(() => capacityEntries(root).some((name) => name.endsWith('.choosing')), 10_000);
    expectRepaired(announced, 'the hook announces its arrival before reading ticket numbers');
    const validator = ticket(root, live.pid); // a validation publishes while the hook is choosing
    rmSync(barrier, { force: true });
    await writing;
    const during = lines(root);
    rows.push({ scenario: 'validation publishes while the hook is choosing', repoLinesDuring: during.length, after: `${spoolRecords(root).length} records spooled` });
    expectRepaired(during.length === 0, `a validation that publishes during the choosing window must keep the hook out (found ${JSON.stringify(during)})`);
    rmSync(validator, { recursive: true, force: true });
    callHook(root, 'choosing-after');
    expectRepaired(JSON.stringify(lines(root)) === JSON.stringify(['choosing-window', 'choosing-after']),
      `the queued line is delivered in order afterwards (got ${JSON.stringify(lines(root))})`);
  }
  // An older record in flight blocks a newer one, so nothing is delivered out of order.
  {
    const root = repo();
    const t = ticket(root, live.pid);
    callHook(root, 'older'); callHook(root, 'newer');
    rmSync(t, { recursive: true, force: true });
    const spool = spoolFor(root);
    const [oldest] = spoolRecords(root);
    renameSync(join(spool, oldest), join(spool, `${oldest}.delivering-${live.pid}`));
    callHook(root, 'arrives-during');
    const during = lines(root);
    rows.push({ scenario: 'older record in flight, newer records queued', repoLinesDuring: during.length, after: '-' });
    expectRepaired(during.length === 0, `no newer record may pass a record still in flight (found ${JSON.stringify(during)})`);
    renameSync(join(spool, `${oldest}.delivering-${live.pid}`), join(spool, oldest));
    callHook(root, 'settle-order');
    expectRepaired(JSON.stringify(lines(root)) === JSON.stringify(['older', 'newer', 'arrives-during', 'settle-order']),
      `delivery resumes in the original order (got ${JSON.stringify(lines(root))})`);
  }
  // A choosing marker left by a crashed process must not stall host bookkeeping.
  {
    const root = repo();
    const t = ticket(root, live.pid);
    callHook(root, 'stale-choosing-pending');
    rmSync(t, { recursive: true, force: true });
    const dir = capacityDir(root);
    const dead = join(dir, 'dead-owner.choosing');
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, 'holder.json'), JSON.stringify({ lockId: 'dead', pid: deadPid, hostname: 'fixture', command: 'validate', acquiredAt: new Date().toISOString() }));
    callHook(root, 'after-stale-choosing');
    const after = lines(root);
    rows.push({ scenario: 'choosing marker left by a dead process', repoLinesDuring: '-', after: JSON.stringify(after) });
    expectRepaired(JSON.stringify(after) === JSON.stringify(['stale-choosing-pending', 'after-stale-choosing']),
      `a dead choosing marker does not stall delivery (got ${JSON.stringify(after)})`);
    const liveChoosing = join(dir, 'live-owner.choosing');
    mkdirSync(liveChoosing, { recursive: true });
    writeFileSync(join(liveChoosing, 'holder.json'), JSON.stringify({ lockId: 'live', pid: live.pid, hostname: 'fixture', command: 'validate', acquiredAt: new Date().toISOString() }));
    callHook(root, 'blocked-by-live-choosing');
    control(JSON.stringify(lines(root)) === JSON.stringify(after), 'a live choosing owner still keeps the hook out');
    rmSync(liveChoosing, { recursive: true, force: true });
  }
  // A competing validator turns its choosing marker into an earlier ticket between the
  // hook's listing of the queue and its inspection of the holders.
  {
    const root = repo();
    const dir = capacityDir(root);
    mkdirSync(dir, { recursive: true });
    const competing = join(dir, 'competing.choosing');
    mkdirSync(competing, { recursive: true });
    // The marker starts with a dead owner, so it is not an active validation yet and the
    // hook proceeds; it becomes a live, lexically earlier ticket during the pause.
    writeFileSync(join(competing, 'holder.json'), JSON.stringify({ lockId: 'competing', pid: deadPid, hostname: 'fixture', command: 'validate', acquiredAt: new Date().toISOString() }));
    const barrier = join(sandbox, 'barrier-admission');
    writeFileSync(barrier, 'hold');
    const writing = callHookAsync(root, 'handoff', { PROOF_OR_STOP_ACTIVITY_ADMISSION_BARRIER: barrier });
    // Pausing between listing the queue and inspecting it is part of the repair: without
    // that observable point the hook cannot notice the queue moving under it.
    const listed = await waitUntil(() => capacityEntries(root).some((name) => name.endsWith('.ticket')), 10_000);
    expectRepaired(listed, 'the hook publishes its ticket and inspects the queue as a separate, observable step');
    // The marker becomes a live, lexically earlier ticket: the entry the hook listed is gone.
    writeFileSync(join(competing, 'holder.json'), JSON.stringify({ lockId: 'competing', pid: live.pid, hostname: 'fixture', command: 'validate', acquiredAt: new Date().toISOString() }));
    renameSync(competing, join(dir, `${'0'.repeat(15)}1-competing.ticket`));
    rmSync(barrier, { force: true });
    await writing;
    const during = lines(root);
    rows.push({ scenario: 'competing marker becomes an earlier ticket mid-admission', repoLinesDuring: during.length, after: `${spoolRecords(root).length} records spooled` });
    expectRepaired(during.length === 0, `a queue entry that vanishes mid-admission must keep the hook out (found ${JSON.stringify(during)})`);
    expectRepaired(spoolRecords(root).length === 1, 'the undelivered record is retained');
    rmSync(join(dir, `${'0'.repeat(15)}1-competing.ticket`), { recursive: true, force: true });
    callHook(root, 'handoff-after');
    expectRepaired(JSON.stringify(lines(root)) === JSON.stringify(['handoff', 'handoff-after']),
      `the retained record is delivered in order afterwards (got ${JSON.stringify(lines(root))})`);
  }
  // Git discovery failing while a validation runs must not fall back to a direct write.
  {
    const root = repo();
    const t = ticket(root, live.pid);
    const brokenGit = join(sandbox, 'broken-git'); mkdirSync(brokenGit, { recursive: true });
    writeFileSync(join(brokenGit, 'git'), '#!/bin/sh\nexit 128\n'); chmodSync(join(brokenGit, 'git'), 0o755);
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ cwd: root, tool_name: 'Bash', tool_input: { command: 'discovery-failed' }, hook_event_name: 'PostToolUse', session_id: 'hook-fixture', tool_output: 'ok' }),
      env: { ...process.env, HOME: home, PATH: `${brokenGit}:${process.env.PATH}` }, encoding: 'utf8',
    });
    control(r.status === 0, 'the hook still exits 0 when git discovery fails');
    const during = lines(root);
    rows.push({ scenario: 'git discovery fails during a validation', repoLinesDuring: during.length, after: '-' });
    expectRepaired(during.length === 0, `a failed discovery must not fall back to a repository write (found ${JSON.stringify(during)})`);
    rmSync(t, { recursive: true, force: true });
    callHook(root, 'after-discovery-failure');
    expectRepaired(JSON.stringify(lines(root)) === JSON.stringify(['discovery-failed', 'after-discovery-failure']),
      `the record published during failed discovery is adopted and delivered in order (got ${JSON.stringify(lines(root))})`);
  }
  // Interoperability with the REAL allocator, in both acquisition orders, including a
  // linked worktree: the protected intervals must never overlap.
  for (const linked of [false, true]) {
    const base = repo();
    let root = base;
    if (linked) {
      root = join(sandbox, `linked-${n++}`);
      execFileSync('git', ['-c', 'user.name=Hook Fixture', '-c', 'user.email=fixture@example.invalid', 'worktree', 'add', '-q', '--detach', root], { cwd: base, stdio: 'ignore' });
    }
    // Order 1: the product holds capacity first; the hook must write nothing meanwhile.
    const ready = join(sandbox, `alloc-ready-${linked}`), release = join(sandbox, `alloc-release-${linked}`);
    const holder = spawn(process.execPath, [allocatorScript, root, ready, release], { stdio: 'inherit', env: { ...process.env, HOME: home } });
    const holderExit = new Promise((r) => holder.on('exit', r));
    control(await waitUntil(() => existsSync(ready), 30_000), `the product allocator acquired workspace capacity (${linked ? 'linked worktree' : 'main worktree'})`);
    callHook(root, `allocator-first-${linked}`);
    const during = lines(root);
    writeFileSync(release, 'go');
    await holderExit;
    expectRepaired(during.length === 0, `the real allocator's capacity keeps the hook out (${linked ? 'linked' : 'main'}: found ${JSON.stringify(during)})`);
    // Order 2: the hook holds its ticket first; the allocator must wait for it.
    const ready2 = join(sandbox, `alloc2-ready-${linked}`), release2 = join(sandbox, `alloc2-release-${linked}`);
    const barrier = join(sandbox, `barrier-alloc-${linked}`);
    writeFileSync(barrier, 'hold');
    const writing = callHookAsync(root, `hook-first-${linked}`, { PROOF_OR_STOP_ACTIVITY_ADMISSION_BARRIER: barrier });
    control(await waitUntil(() => capacityEntriesFor(root).some((name) => name.endsWith('.ticket')), 15_000), 'the hook published its ticket');
    const contender = spawn(process.execPath, [allocatorScript, root, ready2, release2], { stdio: 'inherit', env: { ...process.env, HOME: home } });
    const contenderExit = new Promise((r) => contender.on('exit', r));
    const admittedEarly = await waitUntil(() => existsSync(ready2), 2000);
    rmSync(barrier, { force: true });
    await writing;
    control(await waitUntil(() => existsSync(ready2), 30_000), 'the product allocator is admitted once the hook releases its ticket');
    writeFileSync(release2, 'go');
    await contenderExit;
    rows.push({ scenario: `real allocator interop (${linked ? 'linked worktree' : 'main worktree'})`, repoLinesDuring: during.length, after: JSON.stringify(lines(root)) });
    expectRepaired(!admittedEarly, `the real allocator waits behind the hook's ticket (${linked ? 'linked' : 'main'})`);
    // While the validator waits behind the hook's ticket, the hook yields its remaining
    // records to it rather than queue-jumping; the next hook call delivers them.
    callHook(root, `settle-${linked}`);
    expectRepaired(lines(root).includes(`hook-first-${linked}`) && lines(root).includes(`settle-${linked}`),
      `queued lines are delivered once the allocator released capacity (${linked ? 'linked' : 'main'}: got ${JSON.stringify(lines(root))})`);
  }
  // A directory that is genuinely not a repository keeps the original behavior: the line
  // is written immediately and nothing accumulates in a pending queue.
  {
    const plain = join(sandbox, `plain-${n++}`); mkdirSync(plain, { recursive: true });
    callHook(plain, 'not-a-repository');
    const pending = readdirSync(join(home, '.proof-or-stop/activity-spool')).filter((name) => name.startsWith('pending-'));
    rows.push({ scenario: 'directory outside any repository', repoLinesDuring: lines(plain).length, after: `${pending.length} pending queues` });
    expectRepaired(JSON.stringify(lines(plain)) === JSON.stringify(['not-a-repository']),
      `a directory outside any repository keeps immediate logging (got ${JSON.stringify(lines(plain))})`);
    expectRepaired(pending.length === 0, `a non-repository directory accumulates no pending records (found ${JSON.stringify(pending)})`);
  }
  // Discovery that succeeds, then fails, then succeeds again: nothing is stranded.
  {
    const root = repo();
    callHook(root, 'healthy-1');
    const brokenGit = join(sandbox, 'broken-git-2'); mkdirSync(brokenGit, { recursive: true });
    writeFileSync(join(brokenGit, 'git'), '#!/bin/sh\nexit 128\n'); chmodSync(join(brokenGit, 'git'), 0o755);
    spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ cwd: root, tool_name: 'Bash', tool_input: { command: 'while-discovery-fails' }, hook_event_name: 'PostToolUse', session_id: 'hook-fixture', tool_output: 'ok' }),
      env: { ...process.env, HOME: home, PATH: `${brokenGit}:${process.env.PATH}` }, encoding: 'utf8',
    });
    callHook(root, 'healthy-2');
    const after = lines(root);
    const pending = readdirSync(join(home, '.proof-or-stop/activity-spool')).filter((name) => name.startsWith('pending-'));
    rows.push({ scenario: 'discovery succeeds, fails, succeeds', repoLinesDuring: '-', after: JSON.stringify(after) });
    expectRepaired(JSON.stringify(after) === JSON.stringify(['healthy-1', 'while-discovery-fails', 'healthy-2']),
      `a record published during a failed lookup is adopted, not stranded (got ${JSON.stringify(after)})`);
    expectRepaired(pending.length === 0, `no pending queue is left behind (found ${JSON.stringify(pending)})`);
  }
  // A record that cannot be read right now is retained, not discarded.
  {
    const root = repo();
    const t = ticket(root, live.pid);
    callHook(root, 'unreadable-1'); callHook(root, 'unreadable-2');
    rmSync(t, { recursive: true, force: true });
    const spool = spoolFor(root);
    const [oldest] = spoolRecords(root);
    chmodSync(join(spool, oldest), 0o000); // transient read failure
    callHook(root, 'during-read-failure');
    const blocked = lines(root);
    const retained = spoolRecords(root).length + spoolClaims(root).length;
    // The rejected behavior deletes the record outright, so restoring it may find nothing.
    try { chmodSync(join(spool, oldest), 0o600); } catch { /* already discarded: reported below */ }
    callHook(root, 'after-read-failure');
    const after = lines(root);
    rows.push({ scenario: 'spool record temporarily unreadable', repoLinesDuring: blocked.length, after: JSON.stringify(after) });
    expectRepaired(blocked.length === 0 && retained === 3, `an unreadable record is retained, not discarded (delivered ${JSON.stringify(blocked)}, retained ${retained})`);
    expectRepaired(JSON.stringify(after) === JSON.stringify(['unreadable-1', 'unreadable-2', 'during-read-failure', 'after-read-failure']),
      `every record is delivered in order once it can be read again (got ${JSON.stringify(after)})`);
  }
  // Outside any repository: discovery success, failure, success delivers everything.
  {
    const plain = join(sandbox, `plain-recovery-${n++}`); mkdirSync(plain, { recursive: true });
    callHook(plain, 'outside-1');
    const brokenGit = join(sandbox, 'broken-git-3'); mkdirSync(brokenGit, { recursive: true });
    writeFileSync(join(brokenGit, 'git'), '#!/bin/sh\nexit 128\n'); chmodSync(join(brokenGit, 'git'), 0o755);
    spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ cwd: plain, tool_name: 'Bash', tool_input: { command: 'outside-while-broken' }, hook_event_name: 'PostToolUse', session_id: 'hook-fixture', tool_output: 'ok' }),
      env: { ...process.env, HOME: home, PATH: `${brokenGit}:${process.env.PATH}` }, encoding: 'utf8',
    });
    callHook(plain, 'outside-2');
    const after = lines(plain);
    const pending = readdirSync(join(home, '.proof-or-stop/activity-spool')).filter((name) => name.startsWith('pending-'));
    rows.push({ scenario: 'outside a repository: discovery fails, then recovers', repoLinesDuring: '-', after: JSON.stringify(after) });
    expectRepaired(JSON.stringify(after) === JSON.stringify(['outside-1', 'outside-while-broken', 'outside-2']),
      `a record deferred outside a repository is delivered in order once discovery recovers (got ${JSON.stringify(after)})`);
    expectRepaired(pending.length === 0, `the pending queue is cleared outside a repository (found ${JSON.stringify(pending)})`);
  }
  // Controls: unchanged immediate writes.
  for (const [name, setup] of [
    ['no validation ticket', () => {}],
    ['dead ticket holder', (root) => ticket(root, deadPid)],
    ['ticket for another worktree', (root) => ticket(root, live.pid, sandbox)],
  ]) {
    const root = repo();
    setup(root);
    callHook(root, `control-${name}`);
    rows.push({ scenario: `control: ${name}`, repoLinesDuring: lines(root).length, after: '-' });
    control(JSON.stringify(lines(root)) === JSON.stringify([`control-${name}`]), `${name}: the hook writes into the repository immediately`);
  }
} finally {
  live.kill('SIGKILL');
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
console.log('scenario | repository lines while active | lines after validation ended');
for (const r of rows) console.log(`${r.scenario} | ${r.repoLinesDuring} | ${r.after}`);
if (red.length) {
  console.log(`${MARKER} (${red.length} failing expectations, ${checks} passing checks)`);
  for (const line of red) console.log(`  - ${line}`);
  process.exit(1);
}
console.log(`host activity hook defers repository writes during validation (${checks} checks)`);
