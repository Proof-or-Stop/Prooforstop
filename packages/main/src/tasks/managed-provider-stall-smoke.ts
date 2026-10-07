#!/usr/bin/env node
/**
 * Old-PoS run 20 (PoS 14e4c9b): the managed CHK-002 implementer printed
 * `thread.started` 2 s after spawn and then NO further provider stdout for 30
 * minutes (Codex 0.154 -> DeepSeek v4-flash through an OpenCode credential
 * proxy). The supervisor kept heartbeating and the owner waited until the
 * absolute deadline (timed_out, absolute_deadline_exceeded, 30 min lost).
 *
 * Measured on 388 managed codex runs of 18 earlier bench runs (21,545 stdout
 * inter-event gaps, including reasoning turns and tool commands): p50 1.2 s,
 * p99 22.7 s, p99.9 43.2 s, max 92.5 s; spawn -> first stdout max 15.7 s;
 * thread.started -> next event max 4.0 s. Default stall window 300 s.
 *
 * Contract:
 *  - a managed provider with no stdout for the stall window (sealed in the
 *    spec from PROOF_OR_STOP_MANAGED_PROVIDER_STALL_MS, default 300 s, 0 off)
 *    is terminated (process group) long before its deadline: state failed,
 *    reason `provider_stalled:...` naming the silence, never success;
 *  - replacement-safe (and auto-replaceable by `next`) only when the cleanup
 *    reaped the group AND the provider left no work product (cwd HEAD and
 *    working tree unchanged since launch);
 *  - steady output with gaps below the window is never a stall;
 *  - next relaunches a target whose earlier runs all failed auto-replaceably
 *    as a framework step, at most MANAGED_AUTO_RELAUNCHES_PER_TARGET times.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFixtureMachineEnvironment } from './helpers/fixture-machine-environment.js';

const STALL_MS = 1_500;
const root = mkdtempSync(join(tmpdir(), 'managed-provider-stall-'));
const bin = join(root, 'bin');
mkdirSync(bin);
const THREAD = '{"type":"thread.started","thread_id":"00000000-0000-0000-0000-000000000000"}';

function fakeCodex(dir: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'codex');
  writeFileSync(file, `#!/bin/sh\ncat >/dev/null\n${body}\n`);
  chmodSync(file, 0o755);
  return dir;
}

function gitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
}

async function eventually<T>(read: () => Promise<T | null>, message: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function main(): Promise<void> {
  const core = await import('../core/managed-host-run.js') as Record<string, any>;
  const facts = await import('../core/runtime-fact-registry.js') as Record<string, any>;
  const STALL_ENV = 'PROOF_OR_STOP_MANAGED_PROVIDER_STALL_MS';
  process.env[STALL_ENV] = String(STALL_MS);

  const run = async (name: string, providerDir: string, deadlineMs: number, cwd?: string) => {
    const caseRoot = join(root, name);
    mkdirSync(caseRoot, { recursive: true });
    const started = Date.now();
    const submitted = await core.submitManagedHostRun({
      root: caseRoot, cwd: cwd ?? caseRoot, host: 'codex', storyId: 'B-stall', phase: 'DEV',
      agentType: 'lattice-review-quality', promptText: `stall fixture ${name}`, deadlineMs,
      projectRootHash: 'sha256:stall-smoke',
    }, {
      launchWorker: async (request: unknown) => {
        void core.runManagedHostRunWorker(request, {
          env: { PROOF_OR_STOP_USAGE_LEDGER: '0', PATH: `${providerDir}:/usr/bin:/bin` }, cancelPollMs: 20,
        });
        return { pid: process.pid };
      },
      claimTimeoutMs: 2_000, claimPollMs: 5,
    });
    const status = await eventually(async () => {
      const value = await core.getManagedHostRunStatus({ root: caseRoot, runId: submitted.runId });
      return value.run.terminal ? value.run : null;
    }, `${name}: no terminal within ${deadlineMs + 5_000} ms`, deadlineMs + 5_000);
    return { status, elapsedMs: Date.now() - started, receipt: core.managedHostRunReceipt(caseRoot, submitted.runId) };
  };

  // 1. thread.started, then silence (run 20). Deadline 20 s; the stall must end it after ~1.5 s.
  const silent = fakeCodex(join(root, 'p-silent'), `echo '${THREAD}'\nsleep 60`);
  const stalled = await run('silent', silent, 20_000);
  assert.ok(String(stalled.status.terminal.reason).startsWith('provider_stalled:'),
    `run-20 shape ends provider_stalled, got ${stalled.status.state}/${stalled.status.terminal.reason} after ${stalled.elapsedMs} ms`);
  assert.equal(stalled.status.state, 'failed', 'a stall is never success and never a deadline timeout');
  assert.match(stalled.status.terminal.reason, /no provider stdout for \d+(\.\d+)? s/, 'the reason names the silence length');
  assert.ok(stalled.elapsedMs < 10_000, `detected early (${stalled.elapsedMs} ms of a 20 s deadline)`);
  assert.equal(stalled.receipt.processCleanup?.reaped, true, 'the provider process group is reaped');
  assert.equal(stalled.receipt.processCleanup?.residualProcessGroup, false);
  assert.equal(stalled.status.replacementSafe, true, 'no work product: replacement-safe');
  assert.equal(core.isAutoReplaceableManagedLaunchFailure({ state: stalled.status.state, replacementSafe: true, terminalReason: stalled.status.terminal.reason }), true,
    'a clean stall is auto-replaceable (next relaunches it as a framework step)');

  const policy = facts.MANAGED_PROVIDER_STALL_RUNTIME_POLICY;
  assert.equal(policy?.environment, STALL_ENV, 'the stall window is configurable through one named variable');
  assert.ok(policy.defaultWindowMs >= 120_000 && policy.defaultWindowMs <= 600_000,
    `default window ${policy.defaultWindowMs} ms sits above the measured max gap (92.5 s) and well below the deadline`);

  // 2. Steady output with every gap below the window, total longer than the window: not a stall.
  const steady = fakeCodex(join(root, 'p-steady'), `echo '${THREAD}'\nfor i in 1 2 3 4 5 6; do sleep 0.5; echo '{"type":"turn.started"}'; done\necho '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}'`);
  const fine = await run('steady', steady, 20_000);
  assert.ok(!String(fine.status.terminal.reason).startsWith('provider_stalled'), `steady output is not a stall (${fine.status.terminal.reason})`);

  // 3. A stall after the provider committed in its cwd: never auto-replaced.
  const work = join(root, 'work');
  gitRepo(work);
  const committing = fakeCodex(join(root, 'p-commit'), `echo '${THREAD}'\necho x > f.txt\ngit add f.txt\ngit -c user.email=t@t -c user.name=t commit -q -m work\necho '{"type":"item.completed","item":{"type":"agent_message","text":"committed"}}'\nsleep 60`);
  const dirty = await run('commit', committing, 20_000, work);
  assert.ok(String(dirty.status.terminal.reason).startsWith('provider_stalled:'), `stall after a commit is still a stall (${dirty.status.terminal.reason})`);
  assert.equal(dirty.status.replacementSafe, false, 'a stalled provider that committed work is replacement-unsafe');
  assert.equal(core.isAutoReplaceableManagedLaunchFailure({ state: 'failed', replacementSafe: false, terminalReason: dirty.status.terminal.reason }), false);

  // 4. Window 0 disables detection: the deadline governs.
  process.env[STALL_ENV] = '0';
  const off = await run('disabled', silent, 3_000);
  assert.equal(off.status.terminal.reason, 'absolute_deadline_exceeded', 'window 0 turns stall detection off');

  // 5. next: a target whose earlier runs all failed auto-replaceably is relaunched by the framework, bounded.
  const next = await import('../handlers/next-driver.js') as Record<string, any>;
  assert.equal(typeof next.targetRelaunchIsFramework, 'function', 'next has one relaunch rule for item/finding/scope-plan targets');
  const auto = { autoReplaceable: true }, other = { autoReplaceable: false };
  assert.equal(next.targetRelaunchIsFramework([]), true, 'first run of a target');
  assert.equal(next.targetRelaunchIsFramework([auto]), true, 'one stalled run: framework relaunch');
  assert.equal(next.targetRelaunchIsFramework([auto, auto, auto]), true);
  assert.equal(next.targetRelaunchIsFramework([auto, auto, auto, auto]), false, 'beyond 3 auto relaunches it is the agent\'s call');
  assert.equal(next.targetRelaunchIsFramework([other]), false, 'any other failure stays the agent\'s call');
  assert.equal(core.isAutoReplaceableManagedLaunchFailure({ state: 'timed_out', replacementSafe: true, terminalReason: 'absolute_deadline_exceeded' }), false,
    'a deadline timeout is not auto-replaced');
  console.log('managed-provider-stall-smoke: PASS');
}

if (process.env.MANAGED_PROVIDER_STALL_SMOKE_CHILD === '1') {
  try {
    await main();
  } finally {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
  process.exit(process.exitCode ?? 0);
} else {
  rmSync(root, { recursive: true, force: true });
  const machine = createFixtureMachineEnvironment();
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...machine.env, MANAGED_PROVIDER_STALL_SMOKE_CHILD: '1' }, stdio: 'inherit' });
    process.exitCode = child.status ?? 1;
  } finally { machine.cleanup(); }
}
