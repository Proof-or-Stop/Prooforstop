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
// that answers after 1500 ms. Controls: a real ancestor conflict is still
// refused, and a probe that never answers never admits the waiter early.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'slow ps crashes a validation waiting in the machine queue';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repoRoot, 'packages/main/dist');
const build = spawnSync('npm', ['--prefix', 'packages/main', 'run', 'build'], { cwd: repoRoot, encoding: 'utf8' });
if (build.status !== 0) { process.stderr.write(`${build.stdout}\n${build.stderr}\n`); throw new Error('packages/main build failed; this is not the target RED'); }
const { createFixtureMachineEnvironment } = await import(`file://${join(dist, 'tasks/helpers/fixture-machine-environment.js')}`);

const sandbox = mkdtempSync(join(tmpdir(), 'pos-ancestor-probe-'));
const machine = createFixtureMachineEnvironment();
const red = [];
let checks = 0;
const expectRepaired = (ok, message) => { if (ok) checks++; else red.push(message); };
const control = (ok, message) => { if (!ok) throw new Error(`control failed (not the target RED): ${message}`); checks++; };
const realPs = execFileSync('/usr/bin/which', ['ps'], { encoding: 'utf8' }).trim();

function shim(name, delaySeconds, neverAnswers = false) {
  const dir = join(sandbox, name); mkdirSync(dir);
  const body = neverAnswers ? 'exec sleep 3600\n' : `sleep ${delaySeconds}\nexec ${realPs} "$@"\n`;
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
const root = mkdtempSync(join(tmpdir(), 'ancestor-probe-' + role + '-'));
execFileSync('git', ['init', '-q'], { cwd: root });
const started = Date.now();
try {
  await withMachineValidationResources({ root, workspaceRoot: root, command: role, deadlineAt: Date.now() + 40000 }, async () => {
    if (ready) writeFileSync(ready, 'held');
    if (childRole) {
      // Nested acquisition by a descendant: a genuine ancestor conflict.
      const child = spawn(process.execPath, [process.argv[1], childRole, '', '', result], { stdio: 'inherit', env: process.env });
      await new Promise((r) => child.on('exit', r));
      return;
    }
    if (release) { const d = Date.now() + 30000; while (!existsSync(release) && Date.now() < d) await new Promise((r) => setTimeout(r, 50)); }
  });
  if (!childRole && !ready) writeFileSync(result, JSON.stringify({ outcome: 'acquired', ms: Date.now() - started }));
} catch (error) {
  writeFileSync(result, JSON.stringify({ outcome: 'error', message: String(error && error.message || error).slice(0, 300), ms: Date.now() - started }));
}
`);
async function waitFor(path, ms) { const d = Date.now() + ms; while (!existsSync(path)) { if (Date.now() > d) return false; await new Promise((r) => setTimeout(r, 50)); } return true; }
const run = (args, env) => { const child = spawn(process.execPath, [workerScript, ...args], { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: machine.env.NODE_OPTIONS, ...env } }); return new Promise((r) => child.on('exit', r)); };
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
    control(early.outcome === 'none' || early.outcome === 'error', 'a waiter whose ancestry is unknown is never admitted while another process holds the ticket');
  }
} finally {
  try { machine.cleanup(); } catch (error) { console.log(`fixture machine cleanup: ${error.message}`); }
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
console.log('scenario | outcome | ms | message');
for (const r of rows) console.log(`${r.scenario} | ${r.outcome} | ${r.ms} | ${r.message}`);
if (red.length) {
  console.log(`${MARKER} (${red.length} failing expectations, ${checks} passing checks)`);
  for (const line of red) console.log(`  - ${line}`);
  process.exit(1);
}
console.log(`machine queue ancestor probe tolerates a slow ps (${checks} checks)`);
