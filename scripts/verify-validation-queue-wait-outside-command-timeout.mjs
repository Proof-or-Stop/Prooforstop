#!/usr/bin/env node
// Lab validation-queue-wait-outside-command-timeout RED/GREEN.
//
// Bug: a validation command's configured timeoutMs starts BEFORE it waits for the
// same-user machine validation queue. Time spent queued behind another session's
// validation consumes the command's budget, so a healthy command whose wait exceeds
// its timeout is reported timed out without ever starting, and one that does start
// gets only the remainder. The queue wait has its own bound
// (MACHINE_FIXED_PORT_RUNTIME_POLICY.queueDeadlineMs) and the caller's outer deadline;
// the command timeout should measure the command.
//
// Drives this checkout's built executor in child processes that share a private
// fixture machine queue (never the real cross-session queue). A helper holds a real
// queue ticket through the product API. Controls: a command that overruns its
// timeout after starting is still killed, and an outer deadline still bounds the wait.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'machine queue wait consumes the validation command timeout';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repoRoot, 'packages/main/dist');
const build = spawnSync('npm', ['--prefix', 'packages/main', 'run', 'build'], { cwd: repoRoot, encoding: 'utf8' });
if (build.status !== 0) { process.stderr.write(`${build.stdout}\n${build.stderr}\n`); throw new Error('packages/main build failed; this is not the target RED'); }

const sandbox = mkdtempSync(join(tmpdir(), 'pos-queue-timeout-'));
const { createFixtureMachineEnvironment } = await import(`file://${join(dist, 'tasks/helpers/fixture-machine-environment.js')}`);
const machine = createFixtureMachineEnvironment();
const machineEnv = { ...process.env, NODE_OPTIONS: machine.env.NODE_OPTIONS };
const red = [];
let checks = 0;
const expectRepaired = (ok, message) => { if (ok) checks++; else red.push(message); };
const control = (ok, message) => { if (!ok) throw new Error(`control failed (not the target RED): ${message}`); checks++; };

const workspace = join(sandbox, 'workspace');
execFileSync('mkdir', ['-p', workspace]);
execFileSync('git', ['init', '-q'], { cwd: workspace });

const holderScript = join(sandbox, 'holder.mjs');
writeFileSync(holderScript, `
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const { withMachineValidationResources } = await import(${JSON.stringify(`file://${join(dist, 'core/validation-execution-lock.js')}`)});
const [ready, holdMs, parent] = process.argv.slice(2);
const root = mkdtempSync(join(parent, 'queue-holder-'));
execFileSync('git', ['init', '-q'], { cwd: root });
await withMachineValidationResources({ root, workspaceRoot: root, command: 'other-repository-validation' }, async () => {
  writeFileSync(ready, String(Date.now()));
  await new Promise((r) => setTimeout(r, Number(holdMs)));
});
`);
const runnerScript = join(sandbox, 'runner.mjs');
writeFileSync(runnerScript, `
const { runValidationCommand } = await import(${JSON.stringify(`file://${join(dist, 'core/validation-executor.js')}`)});
const { command, root, outerDeadlineMs } = JSON.parse(process.argv[2]);
const started = Date.now();
const options = outerDeadlineMs ? { deadlineAt: started + outerDeadlineMs } : {};
const result = await runValidationCommand(command, root, undefined, options);
console.log(JSON.stringify({ code: result.code, timedOut: result.timedOut === true, ran: /COMMAND-RAN/.test(result.output), effectiveTimeoutMs: result.effectiveTimeoutMs, wallMs: Date.now() - started }));
`);

// Drives the lock API directly: the admission-wait bound is separate from the deadline
// that bounds the admitted work.
const lockScript = join(sandbox, 'lock.mjs');
writeFileSync(lockScript, `
const { withMachineValidationResources } = await import(${JSON.stringify(`file://${join(dist, 'core/validation-execution-lock.js')}`)});
const { root, waitMs, holdMs, workMs } = JSON.parse(process.argv[2]);
const started = Date.now();
let ran = false, error = null;
try {
  await withMachineValidationResources({ root, workspaceRoot: root, command: 'lock-probe', deadlineAt: started + holdMs, waitDeadlineAt: started + waitMs,
    deadlineError: () => new Error('CALLER-DEADLINE') }, async () => { await new Promise((r) => setTimeout(r, workMs)); ran = true; });
} catch (e) { error = e instanceof Error ? e.message : String(e); }
console.log(JSON.stringify({ ran, error, wallMs: Date.now() - started }));
`);
function lockRun(input) {
  const r = spawnSync(process.execPath, [lockScript, JSON.stringify({ root: workspace, ...input })], { env: machineEnv, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`lock runner failed (not the target RED): ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

async function waitFor(path, ms) {
  const deadline = Date.now() + ms;
  while (!existsSync(path)) { if (Date.now() > deadline) return false; await new Promise((r) => setTimeout(r, 50)); }
  return true;
}
function run(command, outerDeadlineMs) {
  const r = spawnSync(process.execPath, [runnerScript, JSON.stringify({ command, root: workspace, outerDeadlineMs })], { env: machineEnv, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`runner failed (not the target RED): ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}
async function behindHolder(holdMs, fn) {
  const ready = join(sandbox, `ready-${Date.now()}`);
  const holder = spawn(process.execPath, [holderScript, ready, String(holdMs), sandbox], { env: machineEnv, stdio: 'inherit' });
  const exited = new Promise((r) => holder.on('exit', r));
  if (!(await waitFor(ready, 60_000))) throw new Error('holder could not acquire the private fixture ticket (not the target RED)');
  try { return await fn(); } finally { await exited; }
}
const node = (label, source, timeoutMs) => ({ label, command: process.execPath, args: ['-e', source], timeoutMs });
const quick = node('quick', 'console.log("COMMAND-RAN")', 2000);
const oneSecond = node('one-second', 'setTimeout(() => console.log("COMMAND-RAN"), 1000)', 2500);
const overrun = node('overrun', 'setTimeout(() => console.log("COMMAND-RAN"), 4000)', 1500);

const rows = [];
try {
  const alone = run(quick);
  rows.push({ scenario: 'control: no queue wait, 2000ms command', ...alone });
  control(alone.code === 0 && alone.ran, 'an uncontended quick command runs');

  const waited = await behindHolder(4000, async () => run(quick));
  rows.push({ scenario: 'queued ~4s, command timeout 2000ms', ...waited });
  expectRepaired(waited.code === 0 && waited.ran, `a command queued longer than its timeout must still run (code ${waited.code}, timedOut ${waited.timedOut}, ran ${waited.ran})`);
  expectRepaired(waited.effectiveTimeoutMs >= 1900, `the command receives its full timeout after the wait (effective ${waited.effectiveTimeoutMs}ms)`);

  const partial = await behindHolder(2000, async () => run(oneSecond));
  rows.push({ scenario: 'queued ~2s, 1s command, timeout 2500ms', ...partial });
  expectRepaired(partial.code === 0 && partial.ran, `queue wait must not shorten the budget of a command that fits its timeout (code ${partial.code}, timedOut ${partial.timedOut})`);

  const killed = run(overrun);
  rows.push({ scenario: 'control: 4s command, timeout 1500ms', ...killed });
  control(killed.timedOut && !killed.ran, 'a command that overruns its own timeout is still killed');

  const outer = await behindHolder(4000, async () => run(quick, 1500));
  rows.push({ scenario: 'control: queued ~4s, outer deadline 1500ms', ...outer });
  control(!outer.ran && outer.code !== 0 && outer.wallMs < 3500, 'an outer deadline still bounds the queue wait');

  // Lock API: the admission-wait bound stops a wait on its own, reported as a capacity wait
  // (not as the caller's deadline), and never cuts short work that was admitted in time.
  const waitBound = await behindHolder(4000, async () => lockRun({ waitMs: 1000, holdMs: 60_000, workMs: 0 }));
  rows.push({ scenario: 'lock: queued, wait bound 1000ms, caller deadline 60s', code: '-', timedOut: waitBound.error, ran: waitBound.ran, effectiveTimeoutMs: '-', wallMs: waitBound.wallMs });
  expectRepaired(!waitBound.ran && waitBound.error === 'workspace validation capacity wait deadline exceeded' && waitBound.wallMs < 3000,
    `the admission-wait bound ends the wait as a capacity wait (ran ${waitBound.ran}, error ${waitBound.error}, ${waitBound.wallMs}ms)`);
  const admitted = lockRun({ waitMs: 300, holdMs: 60_000, workMs: 1500 });
  rows.push({ scenario: 'lock: admitted at once, work 1500ms past a 300ms wait bound', code: '-', timedOut: admitted.error, ran: admitted.ran, effectiveTimeoutMs: '-', wallMs: admitted.wallMs });
  control(admitted.ran && admitted.error === null, `admitted work runs past the admission-wait bound (error ${admitted.error})`);
  const callerFirst = await behindHolder(4000, async () => lockRun({ waitMs: 60_000, holdMs: 1000, workMs: 0 }));
  rows.push({ scenario: 'control: lock queued, caller deadline 1000ms', code: '-', timedOut: callerFirst.error, ran: callerFirst.ran, effectiveTimeoutMs: '-', wallMs: callerFirst.wallMs });
  control(!callerFirst.ran && callerFirst.error === 'CALLER-DEADLINE', `the caller's own deadline still reports the caller's error (got ${callerFirst.error})`);
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  machine.cleanup();
}
console.log('scenario | code | timedOut | ran | effectiveTimeoutMs | wallMs');
for (const r of rows) console.log(`${r.scenario} | ${r.code} | ${r.timedOut} | ${r.ran} | ${r.effectiveTimeoutMs} | ${r.wallMs}`);
if (red.length) {
  console.log(`${MARKER} (${red.length} failing expectations, ${checks} passing checks)`);
  for (const line of red) console.log(`  - ${line}`);
  process.exit(1);
}
console.log(`machine queue wait is outside the validation command timeout (${checks} checks)`);
