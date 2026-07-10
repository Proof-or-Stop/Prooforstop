/**
 * B-70e9 CHK-001 / CHK-002 / CHK-007: the `host_run` CLI command.
 *
 * A thin wrapper over the core choke point (core/host-run.ts): it validates the
 * args (exactly one of --prompt / --promptFile, canonical host, story/reviewRunId
 * binding), reads the prompt, builds the store-backed story resolver (F-005) and
 * the live passthrough sink (F-006), and delegates to runHostRun. Host output is
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
  /** Test seam: inject a fake host runner (production uses the piped spawnSync default). */
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

      // F-006: live passthrough. text mode routes host stdout->stdout / stderr->stderr;
      // json mode routes EVERYTHING to stderr so stdout stays clean for the JSON result.
      const passthrough: HostRunPassthrough = (chunk: HostRunChunk) => {
        if (json || chunk.stream === 'stderr') process.stderr.write(chunk.text);
        else process.stdout.write(chunk.text);
      };

      const result = await runHostRun(
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
          root: ctx.root,
          recordedAt: new Date().toISOString(),
          projectRootHash: projectRootHashFor(ctx.root),
        },
        { runner: options.runner, resolveStory, passthrough },
      );

      const usageLine = formatUsageLine(result);

      if (json) {
        // Machine mode: the full host transcript already streamed to stderr; the
        // JSON payload (exitCode, usage, refusal, bounded stdout tail) is the
        // single stdout line. The engine prints it; exitCode is a field.
        process.stderr.write(`${usageLine}\n`);
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
        };
      }

      // Text mode. Host output already streamed live through the passthrough, so
      // the handler never re-prints it (no double-print).
      if (result.blocked || result.exitCode !== 0 || result.timedOut) {
        // Failure / refusal: usage/refusal line to stderr, then throw so the
        // process exits nonzero (engine forces exit 0 on a normal return).
        process.stderr.write(`${usageLine}\n`);
        if (result.blocked) {
          throw new Error(`host_run refused (${result.refusalReason}); no host was launched`);
        }
        const timeoutNote = result.timedOut ? ' (timed out)' : '';
        throw new Error(`host_run: ${result.host} exited ${result.exitCode}${timeoutNote}`);
      }

      // Success: output already streamed; nothing left to print.
      process.stderr.write(`${usageLine}\n`);
      return '';
    },
  };
}
