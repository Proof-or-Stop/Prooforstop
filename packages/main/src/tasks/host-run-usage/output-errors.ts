import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import { Writable } from 'node:stream';

import { acquireHostRunSlot, defaultHostRunRunner, runHostRun, scanCodexTurnCompletedUsage, usageLineRetainerFor, hostRunSlotsDir, type HostRunPassthrough, type HostRunRunner } from '../../core/host-run.js';











import { checkAsync, freshRoot, CODEX_STDOUT, baseArgs, readLedger, slotMeta, streamHardeningCheckAsync } from "./support.js";

export async function case42(): Promise<void> {


  // =========================================================================
  // F-008: a throwing passthrough sink must degrade honestly, never crash the
  // run. Against the OLD code this check dies twice: (a) the default runner
  // let the onChunk throw escape a stdout 'data' listener as an uncaught
  // EventEmitter exception (process crash, orphaned child, leaked slot); (b)
  // the core's onChunk wrapper rethrew, so runHostRun rejected with NO ledger
  // final and NO result.
  // =========================================================================
  await checkAsync('F-008: throwing passthrough — run completes, no retry, final row records, slot releases, exit + passthroughError propagate', async () => {
    // (a) Default streaming runner + real child: onChunk throws on the FIRST
    // chunk; later chunks must NOT retry the broken sink but MUST still reach
    // the usage scanner; the child's exit code must still propagate.
    let onChunkCalls = 0;
    const script =
      'process.stdout.write("first-chunk\\n");' +
      'setTimeout(function(){' +
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:5,cached_input_tokens:0,output_tokens:2}})+"\\n");' +
      'setTimeout(function(){process.exit(7);}, 60);' +
      '}, 120);';
    const spawnResult = await defaultHostRunRunner({
      command: process.execPath,
      argv: ['-e', script],
      env: process.env,
      cwd: process.cwd(),
      host: 'codex',
      retainUsageLine: usageLineRetainerFor('codex'),
      onChunk: () => {
        onChunkCalls += 1;
        throw new Error('EPIPE: simulated consumer closed the pipe');
      },
    });
    assert.equal(onChunkCalls, 1, 'delivery stops at the FIRST sink failure (no per-chunk retry)');
    assert.equal(spawnResult.exitCode, 7, 'child exit code still propagates');
    assert.ok(spawnResult.passthroughError?.includes('EPIPE'), 'runner result reports the sink failure');
    const retained = scanCodexTurnCompletedUsage(spawnResult.stdout) as Record<string, unknown> | null;
    assert.ok(retained && retained.input_tokens === 5, 'usage scanner kept consuming after the sink broke');

    // (b) End-to-end through runHostRun (ledger ON, cap=1): a streaming fake
    // runner drives the core onChunk wrapper against a throwing passthrough dep.
    const sub = freshRoot();
    const env = { PROOF_OR_STOP_USAGE_LEDGER: '1', PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1' } as NodeJS.ProcessEnv;
    let sinkCalls = 0;
    const passthrough: HostRunPassthrough = () => {
      sinkCalls += 1;
      throw new Error('EPIPE: simulated consumer closed the pipe');
    };
    const streamingRunner: HostRunRunner = (plan) => {
      plan.onChunk?.({ stream: 'stdout', text: 'live-one\n' });
      plan.onChunk?.({ stream: 'stdout', text: CODEX_STDOUT });
      return { stdout: CODEX_STDOUT, stderr: '', exitCode: 0, timedOut: false };
    };
    const result = await runHostRun(baseArgs({ root: sub, host: 'codex', env }), { runner: streamingRunner, passthrough });
    assert.equal(sinkCalls, 1, 'core wrapper never re-invokes the broken sink');
    assert.equal(result.spawned, true, 'the run completed instead of crashing');
    assert.equal(result.exitCode, 0, 'exit code propagates');
    assert.ok(result.passthroughError?.includes('EPIPE'), 'result surfaces passthroughError honestly');
    const records = readLedger(sub);
    assert.ok(records.some((r) => r.usage.source === 'provider-reported'), 'the ledger final row still records');
    // Slot released despite the broken sink: a fresh cap=1 admission succeeds.
    const dir = hostRunSlotsDir(sub);
    const after = acquireHostRunSlot(dir, 1, 6 * 60 * 60 * 1000, Date.now(), slotMeta('after-broken-sink'));
    assert.equal(after?.file, join(dir, 'slot-0.json'), 'concurrency slot was released (cap=1 re-admission succeeds)');
  });
}

export async function case43(): Promise<void> {


  // =========================================================================
  // F-020: a REAL async stream EPIPE must be contained too. F-008 only proved a
  // SYNCHRONOUSLY-throwing sink degrades honestly; a closed downstream pipe
  // instead surfaces as an ASYNCHRONOUS 'error' event on process.stdout/stderr,
  // which the sink try/catch cannot see. Against the OLD handler (no stream
  // 'error' listener) this crashes the driver mid-run: the process dies with a
  // nonzero exit, NO ledger final row, the slot leaks, and no passthroughError is
  // ever surfaced. A REAL subprocess proves the fix: the driver drives the
  // compiled handler in --json mode (host output routes to stderr) with a fake
  // streaming runner emitting many chunks over ~250ms; the parent reads the first
  // line then DESTROYS the pipe, so the driver's later writes hit a real EPIPE.
  // =========================================================================
  await checkAsync('F-020: real subprocess — a live-output consumer that closes mid-stream (async EPIPE) is CONTAINED: driver exits 0, slot released, ledger final recorded, passthroughError surfaced', async () => {
    const sub = freshRoot();
    mkdirSync(sub, { recursive: true });
    const resultFile = join(sub, 'f020-result.json');
    const driverFile = join(sub, 'f020-driver.mjs');

    // The driver imports the COMPILED handler + core and runs host_run against a
    // fake streaming runner. Chunks carry no newline: the parent triggers on the
    // first stderr 'data' event (not a line), and the codex usage line parses
    // without a trailing newline — so no escaping is needed in this template.
    const driverScript = `
import { writeFileSync, readdirSync } from 'node:fs';
const ROOT = process.env.F020_ROOT;
const RESULT = process.env.F020_RESULT;
const { createHostRunHandlers } = await import(process.env.F020_HANDLER_URL);
const { hostRunSlotsDir, acquireHostRunSlot } = await import(process.env.F020_CORE_URL);
const store = { readStory() { throw new Error('no store'); } };
const ctx = { store, root: ROOT, scanRoot: ROOT };
const runner = (plan) => new Promise((resolve) => {
  const chunk = 'x'.repeat(8192);
  let n = 0;
  const tick = () => {
    if (plan.onChunk) plan.onChunk({ stream: 'stdout', text: chunk });
    n += 1;
    if (n >= 120) {
      resolve({ stdout: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 } }), stderr: '', exitCode: 0, timedOut: false });
      return;
    }
    setTimeout(tick, 2);
  };
  setTimeout(tick, 2);
});
const handlers = createHostRunHandlers(ctx, { runner });
const out = await handlers.host_run({ host: 'codex', agentType: 'reviewer', prompt: 'driver prompt', phase: 'adhoc', json: true });
let leftover = [];
try { leftover = readdirSync(hostRunSlotsDir(ROOT)).filter((f) => f.startsWith('slot-') && f.endsWith('.json')); } catch { /* no slot dir */ }
const reAcquired = acquireHostRunSlot(hostRunSlotsDir(ROOT), 1, 6 * 60 * 60 * 1000, Date.now(), { pid: process.pid, startedAt: new Date().toISOString(), host: 'codex', storyId: null, agentType: 'after' }) !== null;
const obj = out && typeof out === 'object' ? out : {};
writeFileSync(RESULT, JSON.stringify({ passthroughError: obj.passthroughError ?? null, spawned: obj.spawned ?? null, exitCode: obj.exitCode ?? null, leftover, reAcquired }));
`;
    writeFileSync(driverFile, driverScript, 'utf8');

    const childEnv = {
      ...process.env,
      PROOF_OR_STOP_USAGE_LEDGER: '1',
      PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1',
      F020_ROOT: sub,
      F020_RESULT: resultFile,
      F020_HANDLER_URL: new URL('../../handlers/host-run.js', import.meta.url).href,
      F020_CORE_URL: new URL('../../core/host-run.js', import.meta.url).href,
    } as NodeJS.ProcessEnv;

    // --json mode routes host output to process.stderr; close THAT pipe mid-stream.
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [driverFile], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
      let closed = false;
      child.stderr?.on('data', () => {
        if (!closed) {
          closed = true;
          // Read one line's worth, then destroy the read end so the driver's next
          // writes hit a real EPIPE.
          setTimeout(() => child.stderr?.destroy(), 5);
        }
      });
      child.on('close', (code) => resolve(code));
    });

    assert.equal(exitCode, 0, 'the driver exited 0 — the async EPIPE was CONTAINED (the OLD handler crashes nonzero here)');
    assert.ok(existsSync(resultFile), 'the driver wrote its result AFTER host_run returned (it never crashed mid-run)');
    const res = JSON.parse(readFileSync(resultFile, 'utf8')) as { passthroughError: unknown; spawned: unknown; exitCode: unknown; leftover: unknown; reAcquired: unknown };
    assert.equal(res.spawned, true, 'the run completed');
    assert.equal(res.exitCode, 0, 'the host exit code propagates on the result surface');
    assert.ok(typeof res.passthroughError === 'string' && res.passthroughError.length > 0, 'the JSON result surface carries a non-null passthroughError (the real EPIPE surfaced honestly)');
    assert.ok(/EPIPE|stream error/i.test(res.passthroughError as string), 'passthroughError names the async stream failure');
    assert.deepEqual(res.leftover, [], 'the concurrency slot was released (no leftover slot files after the run)');
    assert.equal(res.reAcquired, true, 'a fresh cap=1 slot admission succeeds after the run (the slot was truly released)');
    const records = readLedger(sub);
    assert.ok(records.some((r) => r.usage.source === 'provider-reported'), 'the ledger final row recorded despite the broken live pipe');
  });
}

export async function case44(): Promise<void> {


  // =========================================================================
  // F-023: the residual window of F-020. F-020 attaches stderr 'error' listeners
  // for the run and removes them in the handler's finally. But the FINAL diagnostic
  // stderr write (the usage line) fired synchronously and returned BEFORE the write
  // settled, so a real EPIPE queued by THAT write lands asynchronously AFTER the
  // finally removed the listener — zero 'error' listeners -> process crash. The
  // crux, uncovered by F-020, is a QUIET TEXT-MODE run: host output goes to stdout,
  // stderr sees NO writes during the run, so stderrBroken never opens and the usage
  // line is the FIRST stderr write. When stderr is already closed, the OLD handler
  // crashes here (nonzero exit) even though the run completed and the ledger row
  // was written. The fix makes emitStderr settle-aware and AWAITS it before the
  // finally, so the EPIPE 'error' fires while our listener is still attached.
  // Real subprocess: the driver runs host_run in TEXT mode against a stdout-only
  // runner; the parent destroys the driver's stderr pipe at spawn, before the
  // quiet run's first (usage-line) stderr write.
  // =========================================================================
  await checkAsync('F-023: real subprocess — TEXT-mode quiet run whose stderr is closed before the FIRST (usage-line) stderr write is CONTAINED: driver exits 0, slot released, ledger final recorded (no post-finally async EPIPE crash)', async () => {
    const sub = freshRoot();
    mkdirSync(sub, { recursive: true });
    const resultFile = join(sub, 'f023-result.json');
    const driverFile = join(sub, 'f023-driver.mjs');

    // TEXT mode: host output routes to process.stdout (parent ignores it); the
    // runner emits ONLY stdout — never stderr — so the handler's final usage line
    // is the FIRST stderr write of the whole run (stderrBroken never opened).
    const driverScript = `
import { writeFileSync, readdirSync } from 'node:fs';
const ROOT = process.env.F023_ROOT;
const RESULT = process.env.F023_RESULT;
const { createHostRunHandlers } = await import(process.env.F023_HANDLER_URL);
const { hostRunSlotsDir, acquireHostRunSlot } = await import(process.env.F023_CORE_URL);
const store = { readStory() { throw new Error('no store'); } };
const ctx = { store, root: ROOT, scanRoot: ROOT };
const runner = (plan) => new Promise((resolve) => {
  const chunk = 'y'.repeat(4096);
  let n = 0;
  const tick = () => {
    if (plan.onChunk) plan.onChunk({ stream: 'stdout', text: chunk });
    n += 1;
    if (n >= 40) {
      resolve({ stdout: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 3 } }), stderr: '', exitCode: 0, timedOut: false });
      return;
    }
    setTimeout(tick, 2);
  };
  setTimeout(tick, 2);
});
const handlers = createHostRunHandlers(ctx, { runner });
// TEXT mode (json omitted): success returns '' after the usage line hits stderr.
const out = await handlers.host_run({ host: 'codex', agentType: 'reviewer', prompt: 'driver prompt', phase: 'adhoc' });
let leftover = [];
try { leftover = readdirSync(hostRunSlotsDir(ROOT)).filter((f) => f.startsWith('slot-') && f.endsWith('.json')); } catch { /* no slot dir */ }
const reAcquired = acquireHostRunSlot(hostRunSlotsDir(ROOT), 1, 6 * 60 * 60 * 1000, Date.now(), { pid: process.pid, startedAt: new Date().toISOString(), host: 'codex', storyId: null, agentType: 'after' }) !== null;
writeFileSync(RESULT, JSON.stringify({ completed: out === '', leftover, reAcquired }));
`;
    writeFileSync(driverFile, driverScript, 'utf8');

    const childEnv = {
      ...process.env,
      PROOF_OR_STOP_USAGE_LEDGER: '1',
      PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1',
      F023_ROOT: sub,
      F023_RESULT: resultFile,
      F023_HANDLER_URL: new URL('../../handlers/host-run.js', import.meta.url).href,
      F023_CORE_URL: new URL('../../core/host-run.js', import.meta.url).href,
    } as NodeJS.ProcessEnv;

    // Destroy the stderr read end AT SPAWN — before the run's first stderr write.
    // A quiet stdout-only run issues NO stderr data before the final usage line, so
    // there is no stderr 'data' event to trigger on; destroying proactively makes
    // that final usage line the write that hits the already-closed pipe (EPIPE).
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [driverFile], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
      child.once('spawn', () => child.stderr?.destroy());
      child.on('close', (code) => resolve(code));
    });

    assert.equal(exitCode, 0, 'the driver exited 0 — the post-finally async EPIPE was CONTAINED (the OLD handler crashes nonzero here)');
    assert.ok(existsSync(resultFile), 'the driver wrote its result AFTER host_run returned (it never crashed mid/after run)');
    const res = JSON.parse(readFileSync(resultFile, 'utf8')) as { completed: unknown; leftover: unknown; reAcquired: unknown };
    assert.equal(res.completed, true, 'host_run returned normally in text mode (empty string) — no crash');
    assert.deepEqual(res.leftover, [], 'the concurrency slot was released (no leftover slot files after the run)');
    assert.equal(res.reAcquired, true, 'a fresh cap=1 slot admission succeeds after the run (the slot was truly released)');
    const records = readLedger(sub);
    assert.ok(records.some((r) => r.usage.source === 'provider-reported'), 'the ledger final row recorded intact despite the closed-before-first-write stderr');
  });
}

export async function case45(): Promise<void> {


  // =========================================================================
  // F-024: the LAST member of the F-020/F-023 EPIPE-window class, now on the LIVE
  // stdout passthrough itself. F-020 attaches stdout/stderr 'error' listeners for
  // the run and F-023 awaits the final DIAGNOSTIC writes, but the live TEXT-mode
  // host stdout CHUNK writes (process.stdout.write(chunk.text)) were fire-and-forget:
  // a late EPIPE from the FINAL chunk(s) can land asynchronously AFTER the finally
  // removes the listeners (zero 'error' listeners -> process crash) — and text mode
  // (host stdout -> process.stdout) is the DEFAULT path, previously exercised only
  // on stderr. The fix gives every passthrough + diagnostic write outstanding-write
  // accounting (write + counted callback, NOT serialized) and drains the pending
  // counter (bounded by a 2s defensive cap) BEFORE listener removal, so the final
  // chunk's EPIPE fires while our named listeners are still attached.
  // Real subprocess (mirrors the F-023 harness but kills STDOUT, not stderr): the
  // driver runs host_run in TEXT mode against a stdout-only runner bursting chunks
  // right up to process exit; the parent pipes the driver's STDOUT and DESTROYS its
  // read end mid/late-stream, so the driver's live chunk writes hit a real EPIPE.
  // =========================================================================
  await checkAsync('F-024: real subprocess — TEXT-mode live stdout passthrough whose consumer destroys the driver STDOUT mid/late-stream is CONTAINED: driver exits 0, slot released, ledger final recorded (no post-finally async EPIPE crash on the final chunk)', async () => {
    const sub = freshRoot();
    mkdirSync(sub, { recursive: true });
    const resultFile = join(sub, 'f024-result.json');
    const driverFile = join(sub, 'f024-driver.mjs');

    // TEXT mode (json omitted): host stdout chunks route to process.stdout — the
    // very pipe the parent destroys. The runner emits a SYNCHRONOUS burst of large
    // stdout chunks and then returns (a burst right up to process exit): every live
    // write is issued in ONE tick so asyncStreamError stays null across the whole
    // burst, and the chunks that overflow the pipe buffer stay queued in the
    // driver's writable — when the parent destroys the read end they all fail with a
    // real EPIPE. Against the pre-F-024 handler (fire-and-forget stdout writes, no
    // drain) host_run returns and the driver WRITES ITS RESULT, then the buffered
    // writes' EPIPE lands AFTER the finally removed the stdout 'error' listener —
    // zero listeners -> the driver crashes (nonzero) post-completion. The fix's
    // outstanding-write accounting + bounded drain settles those writes' callbacks
    // BEFORE listener removal, so the EPIPE is contained. Chunks carry no newline;
    // the codex usage line parses without a trailing newline.
    const driverScript = `
import { writeFileSync, readdirSync } from 'node:fs';
const ROOT = process.env.F024_ROOT;
const RESULT = process.env.F024_RESULT;
const { createHostRunHandlers } = await import(process.env.F024_HANDLER_URL);
const { hostRunSlotsDir, acquireHostRunSlot } = await import(process.env.F024_CORE_URL);
const store = { readStory() { throw new Error('no store'); } };
const ctx = { store, root: ROOT, scanRoot: ROOT };
const runner = (plan) => {
  // Synchronous burst: 40 x 64 KiB stdout chunks then return. The pipe buffer holds
  // ~64 KiB; the remaining ~2.5 MiB stays queued in the driver's writable and fails
  // with EPIPE the instant the parent destroys the read end.
  const chunk = 'z'.repeat(65536);
  for (let i = 0; i < 40; i++) { if (plan.onChunk) plan.onChunk({ stream: 'stdout', text: chunk }); }
  return { stdout: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9, cached_input_tokens: 0, output_tokens: 4 } }), stderr: '', exitCode: 0, timedOut: false };
};
const handlers = createHostRunHandlers(ctx, { runner });
// TEXT mode (json omitted): success returns '' after the usage line hits stderr.
const out = await handlers.host_run({ host: 'codex', agentType: 'reviewer', prompt: 'driver prompt', phase: 'adhoc' });
let leftover = [];
try { leftover = readdirSync(hostRunSlotsDir(ROOT)).filter((f) => f.startsWith('slot-') && f.endsWith('.json')); } catch { /* no slot dir */ }
const reAcquired = acquireHostRunSlot(hostRunSlotsDir(ROOT), 1, 6 * 60 * 60 * 1000, Date.now(), { pid: process.pid, startedAt: new Date().toISOString(), host: 'codex', storyId: null, agentType: 'after' }) !== null;
writeFileSync(RESULT, JSON.stringify({ completed: out === '', leftover, reAcquired }));
`;
    writeFileSync(driverFile, driverScript, 'utf8');

    const childEnv = {
      ...process.env,
      PROOF_OR_STOP_USAGE_LEDGER: '1',
      PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT: '1',
      F024_ROOT: sub,
      F024_RESULT: resultFile,
      F024_HANDLER_URL: new URL('../../handlers/host-run.js', import.meta.url).href,
      F024_CORE_URL: new URL('../../core/host-run.js', import.meta.url).href,
    } as NodeJS.ProcessEnv;

    // TEXT mode routes host stdout to process.stdout; PIPE that (fd 1) and DESTROY
    // the read end the instant the first data arrives (mid-stream) so the driver's
    // still-queued live chunk writes hit a real EPIPE. stderr stays ignored (the
    // usage line writes fine there) — the window under test is purely the live
    // stdout passthrough.
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [driverFile], { env: childEnv, stdio: ['ignore', 'pipe', 'ignore'] });
      let closed = false;
      child.stdout?.on('data', () => {
        if (!closed) {
          closed = true;
          child.stdout?.destroy();
        }
      });
      child.on('close', (code) => resolve(code));
    });

    assert.equal(exitCode, 0, 'the driver exited 0 — the async EPIPE on the still-queued LIVE stdout passthrough writes was CONTAINED (the pre-F-024 handler crashes nonzero here, post-completion, on the unhandled stdout error event)');
    assert.ok(existsSync(resultFile), 'the driver wrote its result AFTER host_run returned (it never crashed mid/after run)');
    const res = JSON.parse(readFileSync(resultFile, 'utf8')) as { completed: unknown; leftover: unknown; reAcquired: unknown };
    assert.equal(res.completed, true, 'host_run returned normally in text mode (empty string) — no crash');
    assert.deepEqual(res.leftover, [], 'the concurrency slot was released (no leftover slot files after the run)');
    assert.equal(res.reAcquired, true, 'a fresh cap=1 slot admission succeeds after the run (the slot was truly released)');
    const records = readLedger(sub);
    assert.ok(records.some((r) => r.usage.source === 'provider-reported'), 'the ledger final row recorded intact despite the destroyed live stdout pipe');
  });
}

export async function case46(): Promise<void> {


  // =========================================================================
  // F-152: F-024's 2s defensive drain cap must bound command completion without
  // retaining unbounded per-run error listeners while a write remains pending. A real pipe
  // normally settles before 2s, so drive the exact cap-losing path with an injected
  // writable that delays its callback until after host_run returns, then emits EPIPE.
  // =========================================================================
  await streamHardeningCheckAsync('F-152/F-165: cap-losing live writes keep EPIPE containment with one bounded shared listener until callbacks settle', async () => {
    class DeferredWriteStream extends EventEmitter {
      private callbacks: Array<(error?: Error | null) => void> = [];

      write(_text: string, callback: (error?: Error | null) => void): boolean {
        this.callbacks.push(callback);
        return false;
      }

      settle(error: Error): void {
        const callbacks = this.callbacks.splice(0);
        for (const callback of callbacks) callback(error);
      }
    }

    const sub = freshRoot();
    mkdirSync(sub, { recursive: true });
    const lateStdout = new DeferredWriteStream();
    const { createHostRunHandlers } = await import('../../handlers/host-run.js');
    const handlers = createHostRunHandlers({
      root: sub,
      scanRoot: sub,
      store: { readStory() { throw new Error('no store'); } },
    } as never, {
      runner: async plan => {
        plan.onChunk?.({ stream: 'stdout', text: 'pending live chunk' });
        return { stdout: CODEX_STDOUT, stderr: '', exitCode: 0, timedOut: false };
      },
      outputStreams: { stdout: lateStdout },
      streamWriteDrainCapMs: 5,
    });
    // drainPending deliberately unrefs its cap timer. A real backpressured pipe
    // keeps Node alive itself; this inert fake does not, so retain the test process
    // only through the bounded wait rather than accidentally exiting mid-assertion.
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      const startedAt = Date.now();
      const result = await handlers.host_run({
        host: 'codex', agentType: 'reviewer', prompt: 'late stream settlement', phase: 'adhoc',
      });
      assert.equal(result, '', 'the cap bounds command completion despite the pending live write');
      assert.ok(Date.now() - startedAt < 1_000, 'the smoke seam proves host_run did not wait for the production 2s cap');
      assert.equal(lateStdout.listenerCount('error'), 1,
        'one shared stdout late-EPIPE guard remains attached after the bounded return');
      const second = await handlers.host_run({
        host: 'codex', agentType: 'reviewer', prompt: 'second never-settling stream write', phase: 'adhoc',
      });
      assert.equal(second, '', 'a second capped run also completes boundedly');
      assert.equal(lateStdout.listenerCount('error'), 1,
        'many never-settling writes retain one shared guard per stream, not one listener per run');
      assert.doesNotThrow(() => lateStdout.emit('error', new Error('EPIPE: late pipe close')),
        'a post-return EPIPE is contained instead of becoming an unhandled stream error');
      lateStdout.settle(new Error('EPIPE: late write callback'));
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(lateStdout.listenerCount('error'), 0,
        'the shared guard is removed after the callback/error event turn once every late pending write settles');

      // Node Writable reports a failed write callback before emitting its
      // corresponding error event on a later next-tick. This is the actual
      // callback-then-EPIPE ordering that must remain contained after the cap.
      class DeferredWritable extends Writable {
        private pendingCallback: ((error?: Error | null) => void) | null = null;
        errorEvents = 0;

        _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
          this.pendingCallback = callback;
        }

        override emit(event: string | symbol, ...args: unknown[]): boolean {
          if (event === 'error') this.errorEvents += 1;
          return super.emit(event, ...args);
        }

        failPendingWrite(): void {
          const callback = this.pendingCallback;
          this.pendingCallback = null;
          assert.ok(callback, 'the real Writable has one cap-losing pending callback');
          const error = Object.assign(new Error('EPIPE: real Writable pipe close'), { code: 'EPIPE' });
          callback(error);
        }
      }

      const realWritable = new DeferredWritable();
      const realHandlers = createHostRunHandlers({
        root: sub,
        scanRoot: sub,
        store: { readStory() { throw new Error('no store'); } },
      } as never, {
        runner: async plan => {
          plan.onChunk?.({ stream: 'stdout', text: 'real Writable pending live chunk' });
          return { stdout: CODEX_STDOUT, stderr: '', exitCode: 0, timedOut: false };
        },
        outputStreams: { stdout: realWritable },
        streamWriteDrainCapMs: 5,
      });
      const realResult = await realHandlers.host_run({
        host: 'codex', agentType: 'reviewer', prompt: 'real Writable callback then EPIPE', phase: 'adhoc',
      });
      assert.equal(realResult, '', 'the real Writable cap-losing write still returns boundedly');
      assert.equal(realWritable.listenerCount('error'), 1,
        'the shared guard survives until the real Writable resolves its callback/event pair');
      realWritable.failPendingWrite();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(realWritable.errorEvents, 1,
        'the real Writable emitted its callback-following EPIPE event');
      assert.equal(realWritable.listenerCount('error'), 0,
        'the shared guard releases only after the real Writable EPIPE event is contained');
    } finally {
      clearInterval(keepAlive);
    }
  });
}
