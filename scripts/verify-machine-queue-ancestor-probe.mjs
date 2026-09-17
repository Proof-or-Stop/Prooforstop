#!/usr/bin/env node
// Lab machine-queue-ancestor-probe RED/GREEN.
//
// Bug: a validation waiting in the same-user machine queue behind another
// process's ticket runs a synchronous `ps -axo pid=,ppid=` with a 1000 ms
// timeout to detect ancestor conflicts. On a busy machine ps takes longer, the
// spawn times out, and the ETIMEDOUT escapes the wait loop: the waiting
// validation crashes instead of waiting (observed 2026-09-17:
// "spawnSync ps ETIMEDOUT at machinePortAncestorPids").
//
// Drives this checkout's built queue in child processes that share a private
// fixture machine queue (never the real one). The waiting process sees a `ps`
// that answers the ancestor probe (`-axo pid=,ppid=`) after 1500 ms. Controls: a real ancestor conflict is still
// refused, and a probe that never answers never admits the waiter early.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'slow ps crashes a validation waiting in the machine queue';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repoRoot, 'packages/main/dist');
const build = spawnSync('npm', ['--prefix', 'packages/main', 'run', 'build'], { cwd: repoRoot, encoding: 'utf8' });
if (build.status !== 0) { process.stderr.write(`${build.stdout}\n${build.stderr}\n`); throw new Error('packages/main build failed; this is not the target RED'); }
const { createFixtureMachineEnvironment } = await import(`file://${join(dist, 'tasks/helpers/fixture-machine-environment.js')}`);

const tempResidue = () => readdirSync(tmpdir()).filter((name) => name.startsWith('ancestor-probe-')).sort();
const residueBefore = tempResidue();
const sandbox = mkdtempSync(join(tmpdir(), 'pos-ancestor-probe-'));
const machine = createFixtureMachineEnvironment();
const red = [];
let checks = 0;
const expectRepaired = (ok, message) => { if (ok) checks++; else red.push(message); };
const control = (ok, message) => { if (!ok) throw new Error(`control failed (not the target RED): ${message}`); checks++; };
const realPs = execFileSync('/usr/bin/which', ['ps'], { encoding: 'utf8' }).trim();
const machineQueueDir = join(machine.root, 'home', '.proof-or-stop', 'locks', 'machine-fixed-port-capacity');

function shim(name, delaySeconds, neverAnswers = false) {
  const dir = join(sandbox, name); mkdirSync(dir);
  // Only the ancestor probe's exact argv is slowed; every other ps call answers normally.
  const slow = neverAnswers ? 'exec sleep 3600' : `sleep ${delaySeconds}`;
  const body = `if [ "$1" = "-axo" ] && [ "$2" = "pid=,ppid=" ]; then\n  ${slow}\nfi\nexec ${realPs} "$@"\n`;
  writeFileSync(join(dir, 'ps'), `#!/bin/sh\n${body}`); chmodSync(join(dir, 'ps'), 0o755);
  return `${dir}:${process.env.PATH}`;
}
const workerScript = join(sandbox, 'worker.mjs');
writeFileSync(workerScript, `
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
const { withMachineValidationResources } = await import(${JSON.stringify(`file://${join(dist, 'core/validation-execution-lock.js')}`)});
const [role, ready, release, result, childRole] = process.argv.slice(2);
const root = mkdtempSync(join(process.env.ANCESTOR_PROBE_SANDBOX, 'ancestor-probe-' + role + '-'));
execFileSync('git', ['init', '-q'], { cwd: root });
const started = Date.now();
const controller = new AbortController();
const abortAfter = Number(process.env.PROBE_ABORT_AFTER_MS || 0);
if (abortAfter > 0) setTimeout(() => controller.abort(new Error('caller aborted the capacity wait')), abortAfter).unref();
let callbackRan = false;
try {
  await withMachineValidationResources({ root, workspaceRoot: root, command: role, abortSignal: controller.signal, deadlineAt: Date.now() + Number(process.env.PROBE_DEADLINE_MS || 40000) }, async () => {
    callbackRan = true;
    if (ready) writeFileSync(ready, 'held');
    if (childRole) {
      // Nested acquisition by a descendant: a genuine ancestor conflict.
      const child = spawn(process.execPath, [process.argv[1], childRole, '', '', result], { stdio: 'inherit', env: process.env });
      await new Promise((r) => child.on('exit', r));
      return;
    }
    if (release) { const d = Date.now() + 30000; while (!existsSync(release) && Date.now() < d) await new Promise((r) => setTimeout(r, 50)); }
  });
  if (!childRole && !ready) writeFileSync(result, JSON.stringify({ outcome: 'acquired', ms: Date.now() - started, callbackRan }));
} catch (error) {
  writeFileSync(result, JSON.stringify({ outcome: 'error', message: String(error && error.message || error).slice(0, 300), ms: Date.now() - started, callbackRan }));
}
`);
async function waitFor(path, ms) { const d = Date.now() + ms; while (!existsSync(path)) { if (Date.now() > d) return false; await new Promise((r) => setTimeout(r, 50)); } return true; }
const run = (args, env) => { const child = spawn(process.execPath, [workerScript, ...args], { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: machine.env.NODE_OPTIONS, ANCESTOR_PROBE_SANDBOX: sandbox, ...env } }); return new Promise((r) => child.on('exit', r)); };
const readResult = (path) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { outcome: 'none' };

const rows = [];
try {
  // 1) Slow but working ps while waiting behind an unrelated holder.
  {
    const ready = join(sandbox, 'h1.ready'), release = join(sandbox, 'h1.release'), result = join(sandbox, 'w1.json');
    const holder = run(['holder', ready, release, join(sandbox, 'h1.json')], {});
    if (!(await waitFor(ready, 20000))) throw new Error('holder did not acquire the private queue; not the target RED');
    const waiter = run(['waiter', '', '', result], { PATH: shim('slow-ps', 1.5) });
    setTimeout(() => writeFileSync(release, 'go'), 4000);
    await waiter; await holder;
    const r = readResult(result);
    rows.push({ scenario: 'waiting behind another holder, ps answers after 1500ms', outcome: r.outcome, ms: r.ms, message: r.message ?? '-' });
    expectRepaired(r.outcome === 'acquired', `a slow ps must not crash the waiting validation (got ${r.outcome}: ${r.message ?? ''})`);
  }
  // 2) Control: a descendant of the holder still hits the ancestor conflict.
  {
    const result = join(sandbox, 'w2.json');
    await run(['ancestor', join(sandbox, 'h2.ready'), '', result, 'nested-child'], {});
    const r = readResult(result);
    rows.push({ scenario: 'control: descendant of the holder requests the queue', outcome: r.outcome, ms: r.ms, message: r.message ?? '-' });
    control(r.outcome === 'error' && /conflicts with an ancestor/.test(r.message ?? ''), `ancestor conflict must still be refused (got ${r.outcome}: ${r.message ?? ''})`);
  }
  // 2b) The same genuine conflict behind a slow ps is still refused as a conflict, not a crash.
  {
    const result = join(sandbox, 'w2b.json');
    await run(['ancestor', join(sandbox, 'h2b.ready'), '', result, 'nested-child'], { PATH: shim('slow-ps-conflict', 1.5) });
    const r = readResult(result);
    rows.push({ scenario: 'descendant of the holder, ps answers after 1500ms', outcome: r.outcome, ms: r.ms, message: r.message ?? '-' });
    expectRepaired(r.outcome === 'error' && /conflicts with an ancestor/.test(r.message ?? ''), `a slow ps must still detect the ancestor conflict (got ${r.outcome}: ${r.message ?? ''})`);
  }
  // 3) Control: a probe that never answers never admits the waiter while the holder still holds.
  {
    const ready = join(sandbox, 'h3.ready'), release = join(sandbox, 'h3.release'), result = join(sandbox, 'w3.json');
    const holder = run(['holder', ready, release, join(sandbox, 'h3.json')], {});
    if (!(await waitFor(ready, 20000))) throw new Error('holder did not acquire the private queue (control 3)');
    const waiter = run(['waiter', '', '', result], { PATH: shim('hung-ps', 0, true) });
    await new Promise((r) => setTimeout(r, 6000));
    const early = readResult(result);
    writeFileSync(release, 'go');
    await waiter; await holder;
    const r = readResult(result);
    rows.push({ scenario: 'control: ps never answers, holder keeps ticket 6s', outcome: `${early.outcome} -> ${r.outcome}`, ms: r.ms, message: r.message ?? '-' });
    control(early.outcome !== 'acquired', 'a waiter whose ancestry is unknown is never admitted while another process holds the ticket');
    expectRepaired(early.outcome === 'none' && r.outcome === 'acquired', `an unanswered probe keeps the waiter queued and it acquires after release (early ${early.outcome}, final ${r.outcome}: ${r.message ?? ''})`);
  }
  // 4) The probe never outlives the caller's own budget: a hung probe must not hold
  // the queued ticket past the deadline, nor survive an abort, nor run the callback.
  // The budget must bound the probe itself: a hung probe started just before the
  // deadline must not keep the ticket for its whole 5000ms allowance afterwards.
  for (const [name, env, expected, boundMs] of [
    ['short deadline', { PROBE_DEADLINE_MS: '2500' }, /capacity wait deadline exceeded/, 2500 + 1500],
    ['abort during the probe', { PROBE_ABORT_AFTER_MS: '1500', PROBE_DEADLINE_MS: '40000' }, /aborted the capacity wait/, 1500 + 1500],
  ]) {
    const ready = join(sandbox, `h4${name}.ready`), release = join(sandbox, `h4${name}.release`), result = join(sandbox, `w4${name}.json`);
    const holder = run(['holder', ready, release, join(sandbox, `h4${name}.json`)], {});
    if (!(await waitFor(ready, 20000))) throw new Error(`holder did not acquire the private queue (${name})`);
    const waiterStarted = Date.now();
    await run(['waiter', '', '', result], { PATH: shim(`hung-ps-${name.replace(/\W+/g, '-')}`, 0, true), ...env });
    const waiterMs = Date.now() - waiterStarted;
    const r = readResult(result);
    const tickets = readdirSync(machineQueueDir).filter((entry) => entry.endsWith('.ticket') || entry.endsWith('.choosing'));
    writeFileSync(release, 'go'); await holder;
    rows.push({ scenario: `hung ps, ${name}`, outcome: r.outcome, ms: waiterMs, message: r.message ?? '-' });
    expectRepaired(r.outcome === 'error' && expected.test(r.message ?? ''), `${name}: the caller's own failure must survive the probe (got ${r.outcome}: ${r.message ?? ''})`);
    expectRepaired(waiterMs < boundMs, `${name}: the waiter must release within its own budget, not the probe's (took ${waiterMs}ms, bound ${boundMs}ms)`);
    control(r.callbackRan !== true, `${name}: the callback never runs when the wait fails`);
    control(tickets.length === 1, `${name}: the waiter leaves no queue ticket behind (found ${tickets.length})`);
  }
} finally {
  try { machine.cleanup(); } catch (error) { console.log(`fixture machine cleanup: ${error.message}`); }
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
const leaked = tempResidue().filter((name) => !residueBefore.includes(name));
control(leaked.length === 0, `the run leaves no worker repository in the shared temp directory (leaked ${leaked.join(',')})`);
console.log('scenario | outcome | ms | message');
for (const r of rows) console.log(`${r.scenario} | ${r.outcome} | ${r.ms} | ${r.message}`);
if (red.length) {
  console.log(`${MARKER} (${red.length} failing expectations, ${checks} passing checks)`);
  for (const line of red) console.log(`  - ${line}`);
  process.exit(1);
}
console.log(`machine queue ancestor probe tolerates a slow ps (${checks} checks)`);
