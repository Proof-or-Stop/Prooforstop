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
  rowTotalTokens,
  sweepClaudeProjects,
  sweepCodexSessions,
  type CodexUsageTotals,
  type ClaudeUsageTotals,
  type SweepReport,
  type SweepSessionRow,
} from '../core/usage-sweep.js';

export interface UsageSweepCommandArgs extends FormatArgs {
  since?: string;
  codexSessionsDir?: string;
  claudeProjectsDir?: string;
  out?: string;
}

export interface CreateUsageSweepHandlersOptions {
  /** Test seam: inject a clock so smoke output is deterministic (default Date.now). */
  now?: () => number;
}

/** The JSON payload: the deterministic core report plus a caller-stamped generatedAt. */
export type UsageSweepReport = SweepReport & { generatedAt: string };

export const NON_AUTHORITATIVE_HEADER =
  'NON-AUTHORITATIVE ESTIMATE — attribution from host transcript stores; not billing truth; ' +
  'sessions lattice did not launch are estimates.';

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
      const latticeHint = row.latticeCwd ? ' [worktree-hint]' : '';
      lines.push(
        `  ${row.host.padEnd(6)} ${shortId.padEnd(8)} ${row.originLabel.padEnd(13)} ` +
          `~${fmt(rowTotalTokens(row))} tok | ${tokensSummary(row)}`,
      );
      lines.push(`      cwd ${cwd}${latticeHint} | ${span} | stories ${stories}`);
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
    async usage_sweep(args: UsageSweepCommandArgs): Promise<UsageSweepReport | string> {
      const since = normalizeString(args.since);
      if (!since) throw new Error('usage_sweep: --since is required (YYYY-MM-DD, ISO datetime, or <N>d)');
      const { sinceMs, label } = parseSinceToMs(since, now());

      const codexDir = normalizeString(args.codexSessionsDir) || join(homedir(), '.codex', 'sessions');
      const claudeDir = normalizeString(args.claudeProjectsDir) || join(homedir(), '.claude', 'projects');

      const [codexRows, claudeRows] = await Promise.all([
        sweepCodexSessions({ dir: codexDir, sinceMs }),
        sweepClaudeProjects({ dir: claudeDir, sinceMs }),
      ]);

      const base = buildSweepReport([...codexRows, ...claudeRows], { since: label, sinceMs });
      const report: UsageSweepReport = { ...base, generatedAt: new Date(now()).toISOString() };

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

      if (wantsJson(args)) return report;
      return renderHuman(report);
    },
  };
}
