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
import { dirname, join, resolve } from 'node:path';
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
const spoolClaims = (root) => { try { return readdirSync(spoolFor(root)).filter((name) => name.includes('.delivering-')); } catch { return []; } };
async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
}
const log = (root) => join(root, 'docs/story/activity.jsonl');
const lines = (root) => existsSync(log(root)) ? readFileSync(log(root), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).detail) : [];

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
  {
    const root = repo();
    const t = ticket(root, live.pid);
    callHook(root, 'pending-1');
    rmSync(t, { recursive: true, force: true });
    const lock = lockFor(root);
    mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, 'owner'), String(live.pid));
    callHook(root, 'while-another-hook-flushes');
    const whileHeld = lines(root);
    rmSync(lock, { recursive: true, force: true });
    callHook(root, 'after-flush');
    const after = lines(root);
    rows.push({ scenario: 'another live hook holds the flush lock', repoLinesDuring: whileHeld.length, after: JSON.stringify(after) });
    expectRepaired(whileHeld.length === 0, `a new line does not overtake a pending flush (found ${JSON.stringify(whileHeld)})`);
    expectRepaired(JSON.stringify(after) === JSON.stringify(['pending-1', 'while-another-hook-flushes', 'after-flush']), `order preserved after the flush lock is released (got ${JSON.stringify(after)})`);
  }
  {
    const root = repo();
    const t = ticket(root, live.pid);
    callHook(root, 'stale-pending');
    rmSync(t, { recursive: true, force: true });
    const lock = lockFor(root);
    mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, 'owner'), String(deadPid));
    callHook(root, 'after-stale-lock');
    const after = lines(root);
    rows.push({ scenario: 'flush lock left by a dead hook', repoLinesDuring: '-', after: JSON.stringify(after) });
    expectRepaired(JSON.stringify(after) === JSON.stringify(['stale-pending', 'after-stale-lock']), `a dead owner's lock does not strand lines (got ${JSON.stringify(after)})`);
  }
  // A validation that starts DURING a flush: the flusher re-checks before every record,
  // so the remaining records stay outside the repository.
  {
    const root = repo();
    const t = ticket(root, live.pid);
    for (let i = 0; i < 4; i++) callHook(root, `mid-flush-${i}`);
    rmSync(t, { recursive: true, force: true });
    const barrier = join(sandbox, 'barrier-mid-flush');
    writeFileSync(barrier, 'hold');
    const flushing = callHookAsync(root, 'flusher', { PROOF_OR_STOP_ACTIVITY_SPOOL_BARRIER: barrier });
    await waitUntil(() => spoolClaims(root).length > 0 || lines(root).length > 0, 10_000);
    const restarted = ticket(root, live.pid); // validation starts again mid-flush
    rmSync(barrier, { force: true });
    await flushing;
    const during = lines(root);
    const pending = spoolRecords(root).length;
    rows.push({ scenario: 'validation starts during a flush', repoLinesDuring: during.length, after: `${pending} records still spooled` });
    expectRepaired(during.length < 5 && pending > 0,
      `a validation starting mid-flush must stop delivery (delivered ${during.length}, still spooled ${pending})`);
    expectRepaired(during.every((detail) => detail.startsWith('mid-flush-')),
      `only deferred records reach the repository while a validation is active (got ${JSON.stringify(during)})`);
    rmSync(restarted, { recursive: true, force: true });
    callHook(root, 'after-second-validation');
    const after = lines(root);
    expectRepaired(after.length === 6 && new Set(after).size === 6,
      `every record is delivered exactly once after the second validation ends (got ${JSON.stringify(after)})`);
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
    await waitUntil(() => spoolClaims(root).length > 0, 10_000);
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
  // Two hooks reclaiming the same stale lock: exactly one wins and nothing is lost.
  {
    const root = repo();
    const t = ticket(root, live.pid);
    for (let i = 0; i < 4; i++) callHook(root, `stale-race-${i}`);
    rmSync(t, { recursive: true, force: true });
    const lock = lockFor(root);
    mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, 'owner'), String(deadPid));
    const reclaimers = await Promise.all([0, 1].map((i) => callHookAsync(root, `reclaimer-${i}`)));
    const after = lines(root);
    rows.push({ scenario: 'two hooks reclaim the same stale lock', repoLinesDuring: '-', after: `${after.length} lines` });
    control(reclaimers.every((code) => code === 0), 'both stale-lock reclaimers exit 0');
    expectRepaired(after.length === 6 && new Set(after).size === 6,
      `a contested stale lock loses and duplicates nothing (got ${JSON.stringify(after)})`);
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
