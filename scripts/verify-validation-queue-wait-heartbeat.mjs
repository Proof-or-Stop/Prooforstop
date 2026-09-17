#!/usr/bin/env node
// Lab heartbeat-smoke-memory-pressure RED/GREEN.
//
// Bug: every validation command without a resource declaration takes the
// same-user, cross-repository machine validation queue exclusively
// (MACHINE_FIXED_PORT_RUNTIME_POLICY.unknownResources = exclusive-machine-queue).
// While queued behind another session's validation the executor passes no wait
// reporter, so the CLI prints nothing: the capacity queue only reports through
// onWaitProgress (every 30s by default) and the executor does not supply it. The
// CLI idle watchdog therefore sees a silent process and kills a healthy validation.
// Reproduced 2026-09-17: validate-progress-heartbeat-smoke run directly (outside the
// fixture wrapper that isolates the machine queue per fixture) failed deterministically
// with "validate stuck: 1 seconds without output" while another Story's validation
// held the queue. The machine queue dates from 2026-09-10, so this does NOT explain
// the July-September historical heartbeat failures; those had other, since-fixed causes.
//
// Drives this checkout's built CLI against a disposable fixture while a helper
// holds a real machine queue ticket through the product API. Controls: without
// contention the same run passes; a CLI that is genuinely silent still dies.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'validation queued for machine capacity is silent and killed as idle';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repoRoot, 'packages/main/dist');
const build = spawnSync('npm', ['--prefix', 'packages/main', 'run', 'build'], { cwd: repoRoot, encoding: 'utf8' });
if (build.status !== 0) { process.stderr.write(`${build.stdout}\n${build.stderr}\n`); throw new Error('packages/main build failed; this is not the target RED'); }

const sandbox = mkdtempSync(join(tmpdir(), 'pos-queue-wait-'));
// The holder and every CLI run share a private machine queue (fixture homedir),
// so replaying this script never occupies the real cross-session queue.
const { createFixtureMachineEnvironment } = await import(`file://${join(dist, 'tasks/helpers/fixture-machine-environment.js')}`);
const machine = createFixtureMachineEnvironment();
const machineEnv = { NODE_OPTIONS: machine.env.NODE_OPTIONS };
const red = [];
let checks = 0;
const expectRepaired = (ok, message) => { if (ok) checks++; else red.push(message); };
const check = (ok, message) => { if (!ok) throw new Error(`control failed (not the target RED): ${message}`); checks++; };

function fixture(name) {
  const root = join(sandbox, name);
  execFileSync('mkdir', ['-p', root]);
  const git = (args) => execFileSync('git', ['-c', 'user.name=Queue Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'silent.mjs'), 'await new Promise((resolve) => setTimeout(resolve, 1500));\n');
  writeFileSync(join(root, '.gitignore'), '.proof-or-stop/\n');
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', workflow: { profile: 'light' },
    validate: { commands: [{ label: 'silent', command: process.execPath, args: ['silent.mjs'], timeoutMs: 280_000 }] } }));
  git(['init', '-q']); git(['checkout', '-q', '-B', 'main']); git(['add', '.']); git(['commit', '-qm', 'base']);
  return root;
}
function runValidate(root, env) {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(dist, 'cli.js'), '--root', root, 'validate', '--json'], {
      cwd: root, env: { ...process.env, ...machineEnv, PROOF_OR_STOP_MAX_TIMEOUT_MS: '290000', ...env },
    });
    let stderr = ''; let stdout = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('exit', (code) => resolveRun({ code, stderr, stdout, ms: Date.now() - started }));
  });
}
async function waitFor(path, ms) {
  const deadline = Date.now() + ms;
  while (!existsSync(path)) { if (Date.now() > deadline) return false; await new Promise((r) => setTimeout(r, 100)); }
  return true;
}

const holderScript = join(sandbox, 'holder.mjs');
writeFileSync(holderScript, `
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const { withMachineValidationResources } = await import(${JSON.stringify(`file://${join(dist, 'core/validation-execution-lock.js')}`)});
const [ready, release] = process.argv.slice(2);
const root = mkdtempSync(join(tmpdir(), 'queue-holder-'));
execFileSync('git', ['init', '-q'], { cwd: root });
await withMachineValidationResources({ root, workspaceRoot: root, command: 'other-repository-validation' }, async () => {
  writeFileSync(ready, String(Date.now()));
  const deadline = Date.now() + 120000;
  while (!existsSync(release) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
});
`);

const rows = [];
try {
  // Control: uncontended run passes.
  const quiet = await runValidate(fixture('uncontended'), { PROOF_OR_STOP_IDLE_TIMEOUT_MS: '1000', PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: '250' });
  rows.push({ scenario: 'uncontended, idle 1000ms', exit: quiet.code, ms: quiet.ms, stuck: /validate stuck/.test(quiet.stderr), waitLines: (quiet.stderr.match(/waiting for machine validation capacity/g) ?? []).length });
  // Contended: a helper holds a machine ticket; the fixture validation queues behind it.
  const ready = join(sandbox, 'holder.ready'); const release = join(sandbox, 'holder.release');
  const holder = spawn(process.execPath, [holderScript, ready, release], { stdio: 'inherit', env: { ...process.env, ...machineEnv } });
  const holderExited = new Promise((r) => holder.on('exit', r));
  const acquired = await waitFor(ready, 60_000);
  if (!acquired) throw new Error('holder could not acquire the private fixture machine ticket within 60s; not the target RED');
  const contendedRun = runValidate(fixture('contended'), { PROOF_OR_STOP_IDLE_TIMEOUT_MS: '1000', PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: '250' });
  setTimeout(() => writeFileSync(release, 'release'), 3000);
  const contended = await contendedRun;
  await holderExited;
  const waitLines = (contended.stderr.match(/waiting for machine validation capacity/g) ?? []).length;
  rows.push({ scenario: 'queued 3s behind another validation, idle 1000ms', exit: contended.code, ms: contended.ms, stuck: /validate stuck/.test(contended.stderr), waitLines });
  expectRepaired(!/validate stuck/.test(contended.stderr), 'a validation queued behind another repository must not be killed as idle');
  expectRepaired(contended.code === 0, `the queued validation must complete after the holder releases (exit ${contended.code})`);
  expectRepaired(waitLines >= 2, `queue wait must be reported at heartbeat cadence (saw ${waitLines} wait lines)`);
  // Control: a genuinely silent CLI still dies (heartbeat slower than idle).
  const silent = await runValidate(fixture('silent-control'), { PROOF_OR_STOP_IDLE_TIMEOUT_MS: '600', PROOF_OR_STOP_VALIDATE_HEARTBEAT_MS: '5000' });
  rows.push({ scenario: 'control: heartbeat 5000ms > idle 600ms', exit: silent.code, ms: silent.ms, stuck: /validate stuck/.test(silent.stderr), waitLines: '-' });
  check(silent.code !== 0 && /validate stuck/.test(silent.stderr), 'idle watchdog still kills a CLI whose heartbeat is slower than its idle budget');
  check(quiet.code === 0 && !/validate stuck/.test(quiet.stderr), 'uncontended validation passes');
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  machine.cleanup();
}
console.log('scenario | exit | wallMs | killedAsIdle | queueWaitLines');
for (const r of rows) console.log(`${r.scenario} | ${r.exit} | ${r.ms} | ${r.stuck} | ${r.waitLines}`);
if (red.length) {
  console.log(`${MARKER} (${red.length} failing expectations, ${checks} passing checks)`);
  for (const line of red) console.log(`  - ${line}`);
  process.exit(1);
}
console.log(`queued validation reports its wait and survives the idle watchdog (${checks} checks)`);
