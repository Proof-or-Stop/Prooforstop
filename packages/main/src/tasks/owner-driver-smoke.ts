#!/usr/bin/env node
/**
 * Owner-driver lab (old-PoS runs 40/54/56 owner request classes, run 55 hang):
 * `next --storyId=<id> --untilAgent` (handlers/next-drive.ts) loops `next --run`
 * calls with no owner turn in between and hands back exactly one step.
 *
 *   L1-L7 drive loop rules (fake calls): paused / maxSteps -> called again;
 *         agent / human / DONE / refusal / framework step with no command ->
 *         returned; the loop itself never runs a step (it only asks `next --run`).
 *   W1    watchdog, run 55 shape: a call that prints nothing and has no step
 *         process below it is killed as a group after stallMs and decided again.
 *   W2    watchdog, hung step: a call blocked on a step process (sleep) is not
 *         killed at stallMs, only at stepStallMs, and the step dies with it.
 *   W3    a call that keeps printing is never killed.
 *   W4    repeated kills end the drive (outcome watchdog) instead of looping forever.
 *   O1    owner.driver: absent / malformed = llm, framework = framework.
 *
 * The full lifecycle (INIT to DONE, finding round, hung import) runs in
 * tasks/e2e-review-to-done-smoke.ts NOD-INIT / NOD / NOD-W.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const failures: string[] = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

// Loaded at run time so this smoke compiles before the module exists (RED).
const drivePath = '../handlers/next-drive.js';
const variantsPath = '../core/ab-variants.js';
const drive = await import(drivePath).catch(() => ({})) as Record<string, any>;
const variants = await import(variantsPath) as Record<string, any>;

type Step = { kind: 'agent' | 'framework' | 'human'; reason: string; phase: string; done?: boolean; cli?: { command: string; payload: Record<string, unknown> } | null };
const fw = (reason: string): Step => ({ kind: 'framework', reason, phase: 'REVIEW', cli: { command: 'host_run_status', payload: {} } });
const agent = (reason: string): Step => ({ kind: 'agent', reason, phase: 'TEST', cli: { command: 'summary_set', payload: { summary: '<summary>' } } });
const call = (body: Record<string, unknown>) => ({ exit: 0, ms: 5, stdout: JSON.stringify({ schemaVersion: 'proof-or-stop.next_step.v1', storyId: 'B-1', executed: [], stopped: null, paused: null, ...body }) });
const row = (reason: string, exit = 0) => ({ command: `proof-or-stop ${reason}`, reason, exit, ms: 1, tail: '' });

function scripted(results: Array<ReturnType<typeof call> | { exit: number | null; ms: number; stdout: string; killed?: unknown }>): { calls: () => number; fn: (index: number) => Promise<unknown> } {
  let n = 0;
  return { calls: () => n, fn: async () => { const result = results[Math.min(n, results.length - 1)]; n += 1; return result; } };
}

await check('L1 paused and maxSteps calls are driven again without the owner; the first agent step is returned', async () => {
  const s = scripted([
    call({ executed: [row('review_lane_launch'), row('managed_run_wait')], paused: 'wait budget of 285 s used', next: fw('managed_run_wait') }),
    call({ executed: [row('managed_run_wait')], paused: 'wait budget of 285 s used', next: fw('managed_run_wait') }),
    call({ executed: Array.from({ length: 40 }, () => row('review_evidence_import')), stopped: 'maxSteps=40 reached', next: fw('review_evidence_import') }),
    call({ executed: [row('story_advance')], next: agent('test_authoring') }),
  ]);
  const result = await drive.driveUntilAgent({ call: s.fn });
  assert.equal(result.outcome, 'agent');
  assert.equal(result.next.reason, 'test_authoring');
  assert.equal(s.calls(), 4, 'four next --run calls, no owner turn between them');
  assert.equal(result.executed.length, 44);
  assert.equal(result.stopped, null);
});

await check('L2 a refused step ends the drive with the refusal (the owner judges it); nothing is retried by the driver', async () => {
  const s = scripted([call({ executed: [row('review_evidence_import', 1)], stopped: 'step refused (exit 1)', next: fw('review_evidence_import') }), call({ next: agent('never') })]);
  const result = await drive.driveUntilAgent({ call: s.fn });
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.stopped, 'step refused (exit 1)');
  assert.equal(s.calls(), 1);
});

await check('L3 human and DONE end the drive', async () => {
  const human = await drive.driveUntilAgent({ call: scripted([call({ next: { kind: 'human', reason: 'review_stop_loss', phase: 'REVIEW', cli: null } })]).fn });
  assert.equal(human.outcome, 'human');
  const done = await drive.driveUntilAgent({ call: scripted([call({ executed: [row('story_advance')], next: { kind: 'human', reason: 'story_done', phase: 'DONE', done: true, cli: null } })]).fn });
  assert.equal(done.outcome, 'done');
});

await check('L4 a framework step with no runnable command is handed back (framework_blocked), never looped on', async () => {
  const s = scripted([call({ next: { kind: 'framework', reason: 'none_runnable', phase: 'REVIEW', cli: null } })]);
  const result = await drive.driveUntilAgent({ call: s.fn });
  assert.equal(result.outcome, 'framework_blocked');
  assert.equal(s.calls(), 1);
});

await check('L5 an agent step is returned untouched: the loop has no way to run it (judgment never auto-performed)', async () => {
  const step = agent('plan_authoring');
  const result = await drive.driveUntilAgent({ call: scripted([call({ next: step })]).fn });
  assert.deepEqual(result.next, step);
  assert.deepEqual(result.executed, []);
});

await check('L6 the drive budget returns outcome budget between calls', async () => {
  let clock = 0;
  const result = await drive.driveUntilAgent({ budgetMs: 1000, now: () => clock, call: async () => { clock += 600; return call({ executed: [row('managed_run_wait')], paused: 'wait budget used', next: fw('managed_run_wait') }); } });
  assert.equal(result.outcome, 'budget');
  assert.equal(result.calls.length, 2);
});

await check('L7 two unparseable results in a row end the drive with outcome error', async () => {
  const result = await drive.driveUntilAgent({ call: scripted([{ exit: 1, ms: 1, stdout: 'boom' }]).fn });
  assert.equal(result.outcome, 'error');
});

const dir = mkdtempSync(join(tmpdir(), 'owner-driver-smoke-'));
const fake = (name: string, body: string): string => { const path = join(dir, name); writeFileSync(path, body); return path; };
const NEXT_JSON = JSON.stringify({ schemaVersion: 'proof-or-stop.next_step.v1', storyId: 'B-1', executed: [], stopped: null, paused: null, next: { kind: 'agent', reason: 'x', phase: 'TEST', cli: null } });
const argvOf = (script: string): string[] => [process.execPath, script, 'next', JSON.stringify({ storyId: 'B-1', run: true, json: true })];
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

await check('W1 run 55 shape: no output and no step process below the call -> killed after stallMs', async () => {
  const script = fake('stall.js', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);\n');
  const started = Date.now();
  const outcome = await drive.runWatchedCall({ argv: argvOf(script), cwd: dir, stallMs: 1500, stepStallMs: 60_000, pollMs: 200 });
  assert.equal(outcome.killed?.reason, 'stall', JSON.stringify(outcome));
  assert.ok(Date.now() - started < 10_000, 'killed long before the 60 s block ended');
  assert.ok(outcome.killed.silentMs >= 1500);
});

await check('W2 a hung step process: not killed at stallMs, killed at stepStallMs with its whole process group', async () => {
  const pidFile = join(dir, 'sleep.pid');
  const script = fake('step.js', `const { spawn, spawnSync } = require('node:child_process');\nconst c = spawn('sleep', ['60']);\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));\nspawnSync('sleep', ['60']);\n`);
  const outcome = await drive.runWatchedCall({ argv: argvOf(script), cwd: dir, stallMs: 1000, stepStallMs: 3500, pollMs: 200 });
  assert.equal(outcome.killed?.reason, 'step_stall', JSON.stringify(outcome));
  assert.ok(outcome.killed.silentMs >= 3500, `not killed before stepStallMs (${outcome.killed.silentMs} ms)`);
  assert.ok(outcome.killed.tree.some((line: string) => /sleep 60/.test(line)), `the tree names the hung step: ${outcome.killed.tree.join(' | ')}`);
  const sleepPid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(alive(sleepPid), false, 'the step process group died with the call');
});

await check('W3 a call that keeps printing is never killed and its result is returned', async () => {
  const script = fake('chatty.js', `let n = 0; const t = setInterval(() => { console.error('ran: step ' + n); if (++n === 8) { clearInterval(t); console.log(${JSON.stringify(NEXT_JSON)}); } }, 300);\n`);
  const lines: string[] = [];
  const outcome = await drive.runWatchedCall({ argv: argvOf(script), cwd: dir, stallMs: 1000, stepStallMs: 1000, pollMs: 100, onLine: (line: string) => lines.push(line) });
  assert.equal(outcome.killed, undefined);
  assert.equal(outcome.exit, 0);
  assert.equal(JSON.parse(outcome.stdout).next.reason, 'x');
  assert.equal(lines.length, 8, 'every ran: line streamed through');
});

await check('W4 kills in a row end the drive with outcome watchdog; a kill followed by a good call recovers', async () => {
  const killed = { exit: null, ms: 10, stdout: '', killed: { reason: 'stall', silentMs: 180_000, tree: [] } };
  const recovered = await drive.driveUntilAgent({ call: scripted([killed, call({ next: agent('test_authoring') })]).fn });
  assert.equal(recovered.outcome, 'agent');
  assert.equal(recovered.watchdog.length, 1);
  const stuck = await drive.driveUntilAgent({ call: scripted([killed]).fn });
  assert.equal(stuck.outcome, 'watchdog');
  assert.equal(stuck.watchdog.length, 3);
});

await check('O1 owner.driver: absent or malformed = llm; framework = framework', () => {
  assert.equal(variants.ownerDriver({}), 'llm');
  assert.equal(variants.ownerDriver({ owner: { driver: 'robot' } }), 'llm');
  assert.equal(variants.ownerDriver({ owner: { driver: 'framework' } }), 'framework');
});

rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  console.log(`owner-driver-smoke: FAIL (${failures.join(', ')})`);
  process.exit(1);
}
console.log('owner-driver-smoke: PASS');
