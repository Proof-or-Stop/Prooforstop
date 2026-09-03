/**
 * B-70e9 CHK-005 (M2): the `usage_sweep` CLI command — a read-only, NON-
 * AUTHORITATIVE retro-attribution report over the host transcript stores.
 *
 * Thin wrapper over the pure core (core/usage-sweep.ts): resolve dirs + the
 * since cutoff, stream-scan both stores, aggregate deterministically, and
 * render either a human table (default) or the full JSON report (--json). The
 * report label 'NON-AUTHORITATIVE ESTIMATE' is present in BOTH modes.
 *
 * Strictly read-only. The ONLY write this command can ever perform is the
 * optional --out report file, and that write is create-only and fenced
 * (F-010): --out must be a RELATIVE path inside the project root, the target
 * must NOT already exist (exclusive 'wx' create — never overwrite/truncate),
 * and symlinked ancestor directories are refused so the write can never be
 * redirected outside the project. It never touches the usage ledger, gate
 * evidence, or story metadata.
 */

import { closeSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HandlerContext } from './context.js';
import type { FormatArgs } from './verdict.js';
import {
  buildSweepReport,
  openReportFileExclusive,
  parseSinceToMs,
  projectSweepReportForOutput,
  rowTotalTokens,
  sweepClaudeProjects,
  sweepCodexSessions,
  type CodexUsageTotals,
  type ClaudeUsageTotals,
  type SweepReport,
  type SweepSessionRow,
} from '../core/usage-sweep.js';
import {
  evaluateBurnAlerts,
  projectBurnAlertEvaluationForOutput,
  renderSweepAlertSection,
  resolveBurnAlertThresholds,
  type BurnAlertEvaluation,
} from '../core/usage-burn-alert.js';

export interface UsageSweepCommandArgs extends FormatArgs {
  since?: string;
  codexSessionsDir?: string;
  claudeProjectsDir?: string;
  out?: string;
  /**
   * B-623a: opt-in burn alert. The handler evaluates the swept rows against the
   * env-tunable burn thresholds and returns a STRUCTURED UsageSweepAlertResult;
   * it never throws or exits on fired alerts itself (the cli-engine dispatch
   * wrapper prints the output first, then throws so cron sees a non-zero exit).
   * Zero writes; the read-only classification is unchanged by this flag.
   */
  alert?: boolean;
}

export interface CreateUsageSweepHandlersOptions {
  /** Test seam: inject a clock so smoke output is deterministic (default Date.now). */
  now?: () => number;
}

/** The JSON payload: the deterministic core report plus a caller-stamped generatedAt. */
export type UsageSweepReport = SweepReport & { generatedAt: string };

/**
 * B-623a: the structured --alert result. `output` is exactly what the CLI
 * prints (human text with the BURN ALERT trailer, or the JSON report carrying
 * the advisory `alert` evaluation); `alertFired` is the machine-readable flag
 * the dispatch wrapper keys the non-zero exit on.
 */
export interface UsageSweepAlertResult {
  kind: 'usage_sweep_alert';
  alertFired: boolean;
  flaggedCount: number;
  scanned: number;
  output: string | (UsageSweepReport & { alert: BurnAlertEvaluation });
}

export const NON_AUTHORITATIVE_HEADER =
  'NON-AUTHORITATIVE ESTIMATE — attribution from host transcript stores; not billing truth; ' +
  'sessions proof-or-stop did not launch are estimates.';

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

/** Group digits with underscores for readable human token counts (locale-free). */
function fmt(n: number): string {
  return Math.trunc(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}

function tailTruncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `…${value.slice(value.length - (max - 1))}`;
}

function tokensSummary(row: SweepSessionRow): string {
  if (!row.usage) return 'unknown';
  if (row.host === 'codex') {
    const u = row.usage as CodexUsageTotals;
    return `in=${fmt(u.inputTokens)}(cache ${fmt(u.cachedInputTokens)}) out=${fmt(u.outputTokens)} reason=${fmt(u.reasoningOutputTokens)}`;
  }
  const u = row.usage as ClaudeUsageTotals;
  return `in=${fmt(u.inputTokens)} cacheR=${fmt(u.cacheReadInputTokens)} cacheC=${fmt(u.cacheCreationInputTokens)} out=${fmt(u.outputTokens)}`;
}

function renderHuman(report: UsageSweepReport): string {
  const lines: string[] = [];
  lines.push(NON_AUTHORITATIVE_HEADER);
  lines.push(
    `generatedAt ${report.generatedAt} | since ${report.since ?? '(all)'} | ` +
      `${report.sessionCount} session(s) | ${report.parseErrorTotal} parse error(s)`,
  );
  lines.push('');

  if (report.sessions.length === 0) {
    lines.push('(no host transcript sessions matched the cutoff)');
  } else {
    lines.push('SESSIONS (by est. total tokens desc):');
    for (const row of report.sessions) {
      const shortId = row.sessionId.length > 8 ? row.sessionId.slice(0, 8) : row.sessionId;
      const cwd = row.cwd ? tailTruncate(row.cwd, 42) : '(no cwd)';
      const span =
        row.firstTimestamp || row.lastTimestamp
          ? `${row.firstTimestamp ?? '?'} → ${row.lastTimestamp ?? '?'}`
          : '(no timestamps)';
      const stories = row.storyMentions.length > 0 ? row.storyMentions.join(',') : '-';
      const proofOrStopHint = row.proofOrStopCwd ? ' [worktree-hint]' : '';
      lines.push(
        `  ${row.host.padEnd(6)} ${shortId.padEnd(8)} ${row.originLabel.padEnd(13)} ` +
          `~${fmt(rowTotalTokens(row))} tok | ${tokensSummary(row)}`,
      );
      lines.push(`      cwd ${cwd}${proofOrStopHint} | ${span} | stories ${stories}`);
    }
  }

  lines.push('');
  lines.push('PER-STORY ROLLUP (a session counts into EACH story it mentions):');
  if (report.perStory.length === 0) {
    lines.push('  (no story-attributed sessions)');
  } else {
    for (const s of report.perStory) {
      const multi = s.multiAttribution ? ' [multi-attributed: totals shared across stories]' : '';
      lines.push(`  ${s.storyId}: ${s.sessionCount} session(s), ~${fmt(s.totalTokens)} tok${multi}`);
    }
  }

  lines.push('');
  lines.push(
    `UNATTRIBUTED (no story mention): ${report.unattributed.sessionCount} session(s), ` +
      `~${fmt(report.unattributed.totalTokens)} tok`,
  );

  lines.push('');
  const gc = report.grandTotals.codex;
  const ga = report.grandTotals.claude;
  lines.push('GRAND TOTALS (each session counted once):');
  lines.push(
    `  codex : ${gc.sessions} session(s) (${gc.sessionsUnknownUsage} unknown) | ` +
      `input ${fmt(gc.inputTokens)} (cached ${fmt(gc.cachedInputTokens)}, uncached ${fmt(gc.uncachedInputTokens)}) ` +
      `output ${fmt(gc.outputTokens)} reasoning ${fmt(gc.reasoningOutputTokens)}`,
  );
  lines.push(
    `  claude: ${ga.sessions} session(s) (${ga.sessionsUnknownUsage} unknown) | ` +
      `input ${fmt(ga.inputTokens)} cacheRead ${fmt(ga.cacheReadInputTokens)} ` +
      `cacheCreation ${fmt(ga.cacheCreationInputTokens)} output ${fmt(ga.outputTokens)}`,
  );
  lines.push('');
  lines.push(`(${report.label}: attribution is a hint from transcript stores, not billing truth.)`);

  return lines.join('\n');
}

export function createUsageSweepHandlers(ctx: HandlerContext, options: CreateUsageSweepHandlersOptions = {}) {
  const now = options.now ?? (() => Date.now());
  return {
    async usage_sweep(args: UsageSweepCommandArgs): Promise<UsageSweepReport | UsageSweepAlertResult | string> {
      const since = normalizeString(args.since);
      if (!since) throw new Error('usage_sweep: --since is required (YYYY-MM-DD, ISO datetime, or <N>d)');
      const { sinceMs, label } = parseSinceToMs(since, now());

      const codexDir = normalizeString(args.codexSessionsDir) || join(homedir(), '.codex', 'sessions');
      const claudeDir = normalizeString(args.claudeProjectsDir) || join(homedir(), '.claude', 'projects');

      const [codexRows, claudeRows] = await Promise.all([
        sweepCodexSessions({ dir: codexDir, sinceMs }),
        sweepClaudeProjects({ dir: claudeDir, sinceMs }),
      ]);

      const rawReport = buildSweepReport([...codexRows, ...claudeRows], { since: label, sinceMs });
      const report: UsageSweepReport = {
        ...projectSweepReportForOutput(rawReport, ctx.root),
        generatedAt: new Date(now()).toISOString(),
      };

      // The ONLY write path: an explicit --out, create-only via the hardened
      // core fence (relative-only, no overwrite, no symlinked ancestors).
      const outArg = normalizeString(args.out);
      if (outArg) {
        const { absPath, fd } = openReportFileExclusive(ctx.root, outArg);
        try {
          writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        } finally {
          closeSync(fd);
        }
        process.stderr.write(`usage_sweep: wrote report to ${absPath}\n`);
      }

      // B-623a: opt-in burn alert. Evaluate the swept rows against the
      // env-tunable thresholds and return the structured alert result. The
      // recency window is the caller's --since (documented); the handler never
      // throws on fired alerts — exit-code semantics live in the CLI wrapper.
      if (args.alert === true) {
        const evaluation = projectBurnAlertEvaluationForOutput(
          evaluateBurnAlerts(rawReport.sessions, {
            nowMs: now(),
            thresholds: resolveBurnAlertThresholds(process.env),
          }),
          ctx.root,
        );
        const output: UsageSweepAlertResult['output'] = wantsJson(args)
          ? { ...report, alert: evaluation }
          : `${renderHuman(report)}\n\n${renderSweepAlertSection(evaluation).join('\n')}`;
        return {
          kind: 'usage_sweep_alert',
          alertFired: evaluation.findings.length > 0,
          flaggedCount: evaluation.findings.length,
          scanned: evaluation.scanned,
          output,
        } satisfies UsageSweepAlertResult;
      }

      if (wantsJson(args)) return report;
      return renderHuman(report);
    },
  };
}

type UsageSweepAlertHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

type StdoutLike = { write(chunk: string): unknown };

function isUsageSweepAlertResult(result: unknown): result is UsageSweepAlertResult {
  return Boolean(
    result && typeof result === 'object' && (result as any).kind === 'usage_sweep_alert',
  );
}

/**
 * B-623a: cli-engine dispatch for `usage_sweep --alert`, mirroring the
 * recover_evidence print-then-throw pattern: when the alert FIRED, print the
 * full report to stdout FIRST (cron logs keep the details), then throw a
 * one-line error so runCli sets process.exitCode=1. A clean run returns the
 * output for the normal printer, keeping the handler pure for in-process tests.
 */
export async function dispatchUsageSweepAlertWithExit(args: {
  handler: UsageSweepAlertHandler;
  data: Record<string, unknown>;
  stdout?: StdoutLike;
}): Promise<unknown> {
  const r = await args.handler(args.data);
  if (!isUsageSweepAlertResult(r)) return r;
  const rendered = typeof r.output === 'string' ? r.output : JSON.stringify(r.output, null, 2);
  if (!r.alertFired) return rendered;
  (args.stdout || process.stdout).write(`${rendered}\n`);
  throw new Error(
    `usage_sweep --alert: ${r.flaggedCount} session(s) over burn thresholds (${r.scanned} scanned) — advisory alert, exiting non-zero for cron`,
  );
}
