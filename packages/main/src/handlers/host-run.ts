/**
 * B-70e9 CHK-001 / CHK-002 / CHK-007: the `host_run` CLI command.
 *
 * A thin wrapper over the core choke point (core/host-run.ts): it validates the
 * args (exactly one of --prompt / --promptFile, canonical host, story/reviewRunId
 * binding), reads the prompt, builds the store-backed story resolver (F-005) and
 * the live passthrough sink (F-006), binds the host execution cwd to the
 * resolved project root (F-011 — the same ctx.root the ledger rows attribute,
 * never the caller's process.cwd()), and delegates to runHostRun. Host output is
 * STREAMED LIVE through the passthrough as it arrives; a usage-summary line is
 * written to stderr; the process exit reflects success vs a host failure / cap
 * refusal.
 *
 * Passthrough routing (F-006):
 *   - text mode -> host stdout chunks go to process.stdout live, host stderr to
 *     process.stderr; the handler does NOT re-print buffered output (no
 *     double-print), so on success it returns an empty string;
 *   - json mode -> ALL host output is routed to process.stderr so process.stdout
 *     stays clean for the single JSON result; the JSON `stdout` field carries only
 *     the bounded usage-parse tail, since the full transcript already streamed to
 *     stderr.
 *
 * Output/exit contract (bounded by the CLI engine, which prints the handler
 * return and forces exit 0 on a normal return):
 *   - text mode, success -> host stdout already streamed live; RETURN '' (nothing
 *     to re-print), usage line to stderr, process exit 0;
 *   - text mode, host failure / cap refusal -> host output already streamed;
 *     usage/refusal line to stderr, THROW a concise error so the process exits
 *     nonzero (the exact host code + refusal reason are in the message);
 *   - json mode -> RETURN the structured result (exitCode, usage, refusal, and the
 *     bounded stdout tail are FIELDS); never throws, so machine consumers read
 *     exitCode.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { HandlerContext } from './context.js';
import type { FormatArgs } from './verdict.js';
import {
  runHostRun,
  type HostRunChunk,
  type HostRunHost,
  type HostRunPassthrough,
  type HostRunResult,
  type HostRunRunner,
  type HostRunStoryResolver,
} from '../core/host-run.js';

export interface HostRunCommandArgs extends FormatArgs {
  host?: string;
  storyId?: string;
  agentType?: string;
  phase?: string;
  prompt?: string;
  promptFile?: string;
  reviewRunId?: string;
  lane?: string;
  timeoutMs?: number;
  agyPrintTimeout?: string;
}

export interface CreateHostRunHandlersOptions {
  /**
   * Test seam: inject a fake host runner. Production uses the async streaming
   * defaultHostRunRunner (core/host-run.ts): child_process.spawn with live
   * chunk passthrough and bounded usage-line retention.
   */
  runner?: HostRunRunner;
}

export interface HostRunCommandResult {
  schemaVersion: 'lattice.host_run.v1';
  host: HostRunHost;
  storyId: string | null;
  phase: string;
  agentType: string;
  spawned: boolean;
  blocked: boolean;
  refusalReason: string | null;
  liveRuns: HostRunResult['liveRuns'];
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  usage: HostRunResult['usageSummary'];
  /** F-008: non-null when the live output passthrough failed mid-run (run still completed). */
  passthroughError: string | null;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function normalizeHost(raw: string): HostRunHost {
  const value = raw.trim().toLowerCase();
  if (value === 'codex') return 'codex';
  if (value === 'claude' || value === 'claude-code') return 'claude';
  if (value === 'agy' || value === 'antigravity') return 'agy';
  throw new Error(`host_run: unsupported host "${raw}" (expected codex | claude | agy)`);
}

function projectRootHashFor(root: string): string {
  return `sha256:${createHash('sha256').update(root, 'utf8').digest('hex')}`;
}

/** Format the single stderr usage-summary / refusal line. */
function formatUsageLine(result: HostRunResult): string {
  const u = result.usageSummary;
  if (result.blocked) {
    if (result.refusalReason === 'concurrency_cap_exceeded') {
      const list = (result.liveRuns ?? [])
        .map((r) => `  - pid ${r.pid} ${r.host}${r.storyId ? ` story ${r.storyId}` : ''} agentType ${r.agentType} startedAt ${r.startedAt}`)
        .join('\n');
      return `host_run refused: ${u.reason ?? 'concurrency_cap_exceeded'}${list ? `\n${list}` : ''}`;
    }
    return `host_run refused: ${u.reason ?? result.refusalReason ?? 'blocked'}`;
  }
  if (u.recorded === 'disabled') return 'usage ledger disabled (LATTICE_USAGE_LEDGER=0); no rows recorded';
  if (u.recorded === 'provider-reported') {
    const recordId = u.recordId ? ` (recordId ${u.recordId})` : '';
    return `usage recorded: provider=${u.provider ?? 'unknown'} input=${u.input ?? 'null'} cacheRead=${u.cacheRead ?? 'null'} output=${u.output ?? 'null'}${recordId}`;
  }
  if (u.recorded === 'unavailable') {
    return `usage recorded: unavailable (${u.reason ?? 'no usage surface'})`;
  }
  return `usage: ${u.reason ?? 'not recorded'}`;
}

export function createHostRunHandlers(ctx: HandlerContext, options: CreateHostRunHandlersOptions = {}) {
  return {
    async host_run(args: HostRunCommandArgs): Promise<HostRunCommandResult | string> {
      const host = normalizeHost(normalizeString(args.host));
      const agentType = normalizeString(args.agentType);
      if (!agentType) throw new Error('host_run: --agentType is required');
      const storyId = normalizeString(args.storyId) || null;

      // Exactly one of --prompt / --promptFile.
      const hasPrompt = typeof args.prompt === 'string' && args.prompt.length > 0;
      const promptFilePath = normalizeString(args.promptFile);
      const hasPromptFile = promptFilePath.length > 0;
      if (hasPrompt === hasPromptFile) {
        throw new Error('host_run: provide exactly one of --prompt or --promptFile');
      }
      let promptText: string;
      if (hasPromptFile) {
        try {
          promptText = readFileSync(promptFilePath, 'utf8');
        } catch (err) {
          throw new Error(`host_run: cannot read --promptFile "${promptFilePath}": ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        promptText = args.prompt as string;
      }
      if (promptText.length === 0) {
        throw new Error('host_run: prompt is empty; refuse pre-spawn');
      }

      const reviewRunId = normalizeString(args.reviewRunId) || null;
      // Defense in depth (core enforces this too): a reviewRunId must belong to
      // --storyId so a ledger row cannot silently mis-join across stories.
      if (reviewRunId && storyId && !reviewRunId.startsWith(`${storyId}:`)) {
        throw new Error(
          `host_run: reviewRunId "${reviewRunId}" does not belong to story "${storyId}" ` +
          `(a reviewRunId must be "<storyId>:..."); refuse pre-spawn`,
        );
      }
      const lane = normalizeString(args.lane) || null;
      const agyPrintTimeout = normalizeString(args.agyPrintTimeout) || undefined;
      const json = wantsJson(args);

      // F-005: resolve story phase + existence through the CONFIGURED store, so a
      // project that configures storyDir is honored (the core stays path-free). An
      // explicit --phase never reaches this (the core skips the store entirely).
      const resolveStory: HostRunStoryResolver = (id: string) => {
        try {
          const story = ctx.store.readStory(id);
          const p = typeof story.phase === 'string' && story.phase.length > 0 ? story.phase : null;
          return { phase: p };
        } catch {
          return null; // unknown story per the configured store
        }
      };

      // F-006 / F-008 / F-020: live passthrough. text mode routes host
      // stdout->stdout / stderr->stderr; json mode routes EVERYTHING to stderr so
      // stdout stays clean for the JSON result.
      // F-008: a SYNCHRONOUS write failure is normalized and thrown to the CORE
      // guard, which flips its passthrough-broken flag: delivery stops, the run
      // still completes, and result.passthroughError surfaces the failure honestly.
      // F-020: a real EPIPE (the downstream pipe closed) usually surfaces NOT as a
      // synchronous throw but as an ASYNCHRONOUS 'error' event on process.stdout /
      // process.stderr, which the try/catch below cannot see. The 'error' listeners
      // attached for the duration of the run (below) record the first such failure
      // into `asyncStreamError`; the sink checks it and throws-through so the SAME
      // core passthrough-broken flag flips (delivery stops instead of hammering a
      // dead pipe), and the handler also merges it into the surfaced
      // passthroughError as a backstop for an error that lands after the last chunk.
      let asyncStreamError: string | null = null;
      // F-020 / F-024: track a broken STDOUT and STDERR specifically. Any chunk or
      // diagnostic write issued to a stream we already KNOW is broken would queue an
      // async EPIPE 'error' that can fire AFTER the per-call listener is removed
      // (zero listeners -> process crash). We skip those writes instead — honest
      // degradation, since passthroughError already records the failure.
      let stdoutBroken = false;
      let stderrBroken = false;

      // F-020: contain ASYNC stream 'error' events (real EPIPE) for the DURATION of
      // the run. Node terminates the process only when a stream has ZERO 'error'
      // listeners, so simply attaching ours is sufficient containment: we swallow
      // the error and record the first message. Hygiene: exactly our two named
      // listeners are added below and removed with removeListener in the finally
      // — never removeAllListeners, since other code may hold its own listeners on
      // these shared streams. F-024: a write error surfaced through a write CALLBACK
      // folds into the SAME state, so a late EPIPE reported via callback and one
      // reported via the 'error' event are handled identically.
      const recordStreamError = (streamName: 'stdout' | 'stderr') => (err: unknown): void => {
        if (streamName === 'stderr') stderrBroken = true;
        else stdoutBroken = true;
        if (asyncStreamError === null) {
          const message = err instanceof Error ? err.message : String(err);
          asyncStreamError = `host_run passthrough ${streamName} stream error: ${message}`;
        }
      };
      const onStdoutError = recordStreamError('stdout');
      const onStderrError = recordStreamError('stderr');

      // F-024: outstanding-write accounting for the live passthrough AND the final
      // diagnostics, WITHOUT serializing throughput. Every write below is issued as
      // write(text, cb) and is NOT awaited per-chunk; the callback decrements a
      // shared pending counter. drainPending() — awaited by the finally BEFORE the
      // error listeners are removed — resolves once every in-flight write has
      // settled, so a late EPIPE from the FINAL chunk(s) fires while our named
      // 'error' listeners are still attached. This closes the residual window that
      // F-020/F-023 left on fire-and-forget live passthrough writes.
      let pendingWrites = 0;
      let onDrained: (() => void) | null = null;
      const settleWrite = (): void => {
        pendingWrites -= 1;
        if (pendingWrites <= 0) {
          pendingWrites = 0;
          if (onDrained) {
            const notify = onDrained;
            onDrained = null;
            notify();
          }
        }
      };
      // Defensive cap: a genuinely WEDGED stream (a write that neither flushes nor
      // errors) must never hang host_run. On timeout we mark both streams broken and
      // proceed with listener removal; the ONLY regression is that, for such a
      // pathologically wedged stream, we revert to the pre-fix crash window (a
      // post-removal EPIPE could still be unhandled). Every real closed/broken pipe
      // settles its write callback (with or without error) well within this cap, so
      // in practice drainPending resolves as soon as the last chunk's EPIPE lands.
      const DRAIN_CAP_MS = 2000;
      const drainPending = (): Promise<void> => {
        if (pendingWrites <= 0) return Promise.resolve();
        return new Promise<void>((resolve) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            onDrained = null;
            stdoutBroken = true;
            stderrBroken = true;
            resolve();
          }, DRAIN_CAP_MS);
          if (typeof timer.unref === 'function') timer.unref();
          onDrained = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
        });
      };

      // F-006 / F-008 / F-020 / F-024: live passthrough. text mode routes host
      // stdout->stdout / stderr->stderr; json mode routes EVERYTHING to stderr so
      // stdout stays clean for the JSON result. Each chunk write is settle-aware
      // (write + counted callback) but NOT awaited, so throughput is never
      // serialized. A SYNCHRONOUS write failure is still thrown through to the CORE
      // guard (F-008: delivery stops, the run still completes, passthroughError
      // surfaces); an ASYNCHRONOUS 'error' recorded via the callback/listener flips
      // asyncStreamError so the NEXT chunk throws through instead of hammering a dead
      // pipe (F-020).
      const passthrough: HostRunPassthrough = (chunk: HostRunChunk) => {
        if (asyncStreamError !== null) {
          // The stream already emitted an async 'error' — the pipe is gone. Throw
          // through (the same contract as a sync write failure) so the core flips
          // its passthrough-broken flag instead of writing to a broken stream.
          throw new Error(asyncStreamError);
        }
        const toStderr = json || chunk.stream === 'stderr';
        const streamName: 'stdout' | 'stderr' = toStderr ? 'stderr' : 'stdout';
        // Skip a stream already known broken (honest degradation; passthroughError
        // already records the failure) — never queue a fresh write onto a dead pipe.
        if (toStderr ? stderrBroken : stdoutBroken) return;
        const stream = toStderr ? process.stderr : process.stdout;
        pendingWrites += 1;
        try {
          stream.write(chunk.text, (err) => {
            if (err) recordStreamError(streamName)(err);
            settleWrite();
          });
        } catch (err) {
          // Rare synchronous throw (e.g. write-after-end): settle the counter, then
          // throw through so the core flips its passthrough-broken flag (F-008).
          settleWrite();
          throw err instanceof Error ? err : new Error(`host_run passthrough write failed: ${String(err)}`);
        }
      };

      // F-020 / F-023 / F-024: gated, SETTLE-AWARE stderr diagnostics that also join
      // the pendingWrites accounting. Never write to a stderr already known broken
      // (avoids a late async EPIPE 'error' firing with no listener). When we DO
      // write, the promise resolves on the write CALLBACK and the SAME callback
      // decrements the shared counter — so both the per-call await (F-023) AND the
      // unified drainPending() (F-024) cover this write. The crux F-023 case is a
      // quiet text-mode run whose stderr is already closed, where this final usage
      // line is the FIRST stderr write (stderrBroken never opened, nothing skipped
      // it). A callback/synchronous error folds into the SAME broken/async-error
      // state (recordStreamError via onStderrError) and is swallowed — best-effort
      // diagnostics must never turn a completed run into a crash (F-008 contract).
      const emitStderr = (text: string): Promise<void> => {
        if (stderrBroken) return Promise.resolve();
        return new Promise<void>((resolve) => {
          pendingWrites += 1;
          try {
            process.stderr.write(text, (err) => {
              if (err) onStderrError(err);
              settleWrite();
              resolve();
            });
          } catch (err) {
            // Rare synchronous throw — flip broken state and settle.
            onStderrError(err);
            settleWrite();
            resolve();
          }
        });
      };

      // F-020: attach the async stream-error guards for the DURATION of the run,
      // then remove exactly them in the finally below (never removeAllListeners).
      process.stdout.on('error', onStdoutError);
      process.stderr.on('error', onStderrError);
      let result: HostRunResult;
      try {
        result = await runHostRun(
          {
            host,
            storyId,
            agentType,
            phase: normalizeString(args.phase) || undefined,
            promptText,
            reviewRunId,
            lane,
            timeoutMs: typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : undefined,
            agyPrintTimeout,
            env: process.env,
            // F-011: the host subprocess executes in the resolved project root
            // (ctx.root — the --root target the CLI engine resolved). This is
            // deliberately the SAME value bound as the ledger `root` +
            // projectRootHash below, so where the host actually runs and where
            // the ledger attributes the run can never diverge; the caller's
            // process.cwd() plays no part. Operators launching story-bound host
            // runs point --root at the story's authoritative worktree (the
            // documented reviewer/quorum recipe), which makes that worktree the
            // execution directory too.
            cwd: ctx.root,
            root: ctx.root,
            recordedAt: new Date().toISOString(),
            projectRootHash: projectRootHashFor(ctx.root),
          },
          { runner: options.runner, resolveStory, passthrough },
        );

        // F-020: an async stream 'error' that landed AFTER the final chunk (so the
        // sink's throw-through never ran) is still surfaced honestly here — merge
        // the handler-observed async failure with the core-reported sink failure.
        const passthroughError = result.passthroughError ?? asyncStreamError;

        const usageLine = formatUsageLine(result);

        // F-008 / F-020: honest degradation notice — the run completed, but live
        // output delivery broke partway (text mode prints it; json mode carries the
        // field).
        const passthroughWarning = passthroughError
          ? `host_run warning: live output passthrough failed (${passthroughError}); output delivery degraded but the run and usage recording completed\n`
          : null;

        if (json) {
          // Machine mode: the full host transcript already streamed to stderr; the
          // JSON payload (exitCode, usage, refusal, bounded stdout tail) is the
          // single stdout line. The engine prints it; exitCode is a field.
          // F-023: await the write so it settles (and any EPIPE 'error' fires)
          // while our stderr listener is still attached (finally removes it).
          await emitStderr(`${usageLine}\n`);
          return {
            schemaVersion: 'lattice.host_run.v1',
            host: result.host,
            storyId: result.storyId,
            phase: result.phase,
            agentType: result.agentType,
            spawned: result.spawned,
            blocked: result.blocked,
            refusalReason: result.refusalReason,
            liveRuns: result.liveRuns,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            stdout: result.stdout,
            stderr: result.stderr,
            usage: result.usageSummary,
            passthroughError,
          };
        }

        // Text mode. Host output already streamed live through the passthrough, so
        // the handler never re-prints it (no double-print). F-023: await every
        // diagnostic write so it settles while our stderr listener is still
        // attached (finally removes it) — the crux case is this quiet-run usage
        // line being the FIRST stderr write onto an already-closed stderr.
        if (passthroughWarning) await emitStderr(passthroughWarning);
        if (result.blocked || result.exitCode !== 0 || result.timedOut) {
          // Failure / refusal: usage/refusal line to stderr, then throw so the
          // process exits nonzero (engine forces exit 0 on a normal return).
          await emitStderr(`${usageLine}\n`);
          if (result.blocked) {
            throw new Error(`host_run refused (${result.refusalReason}); no host was launched`);
          }
          const timeoutNote = result.timedOut ? ' (timed out)' : '';
          throw new Error(`host_run: ${result.host} exited ${result.exitCode}${timeoutNote}`);
        }

        // Success: output already streamed; nothing left to print. F-023: await
        // the final usage-line write so a late EPIPE fires under our listener.
        await emitStderr(`${usageLine}\n`);
        return '';
      } finally {
        // F-024: await all in-flight passthrough + diagnostic writes (bounded by the
        // defensive DRAIN_CAP_MS) BEFORE removing the error listeners, so a late
        // EPIPE from the FINAL chunk(s) fires while our named 'error' listeners are
        // still attached. Resolves immediately when nothing is pending.
        await drainPending();
        // F-020: listener hygiene — remove exactly our two listeners, leaving any
        // other listeners on these shared streams untouched.
        process.stdout.removeListener('error', onStdoutError);
        process.stderr.removeListener('error', onStderrError);
      }
    },
  };
}
