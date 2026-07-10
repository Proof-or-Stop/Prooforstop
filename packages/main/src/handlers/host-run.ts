/**
 * B-70e9 CHK-001 / CHK-002 / CHK-007: the `host_run` CLI command.
 *
 * A thin wrapper over the core choke point (core/host-run.ts): it validates the
 * args (exactly one of --prompt / --promptFile, canonical host, story/reviewRunId
 * binding), reads the prompt, and delegates to runHostRun. The HOST STDOUT is the
 * command output (echoed to stdout); a usage-summary line is written to stderr;
 * the process exit reflects success (host exit 0) vs a host failure / cap refusal.
 *
 * Output/exit contract (bounded by the CLI engine, which prints the handler
 * return and forces exit 0 on a normal return):
 *   - text mode, success -> RETURN the host stdout (engine prints it), usage line
 *     to stderr, process exit 0;
 *   - text mode, host failure / cap refusal -> echo host stdout to stdout directly,
 *     usage/refusal line to stderr, THROW a concise error so the process exits
 *     nonzero (the exact host code + refusal reason are in the message);
 *   - json mode -> RETURN the structured result (host stdout, exitCode, usage, and
 *     any refusal are FIELDS); never throws, so machine consumers read exitCode.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { HandlerContext } from './context.js';
import type { FormatArgs } from './verdict.js';
import {
  runHostRun,
  type HostRunHost,
  type HostRunResult,
  type HostRunRunner,
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

      const result = runHostRun(
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
        { runner: options.runner },
      );

      const usageLine = formatUsageLine(result);

      if (wantsJson(args)) {
        // Machine mode: the whole result (incl. host stdout, exitCode, usage,
        // refusal) is the JSON payload. The engine prints it; exitCode is a field.
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

      // Text mode.
      if (result.blocked || result.exitCode !== 0 || result.timedOut) {
        // Failure / refusal: echo any host stdout directly, then throw so the
        // process exits nonzero (engine forces exit 0 on a normal return).
        if (result.stdout.length > 0) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
        process.stderr.write(`${usageLine}\n`);
        if (result.blocked) {
          throw new Error(`host_run refused (${result.refusalReason}); no host was launched`);
        }
        const timeoutNote = result.timedOut ? ' (timed out)' : '';
        throw new Error(`host_run: ${result.host} exited ${result.exitCode}${timeoutNote}`);
      }

      // Success: the engine prints the returned host stdout to stdout.
      process.stderr.write(`${usageLine}\n`);
      return result.stdout;
    },
  };
}
