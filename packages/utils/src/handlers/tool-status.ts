/**
 * tool_status — report actual Proof-or-Stop tool usage
 *
 * The data source is the dual-source activity.jsonl (runtime path .proof-or-stop/activity.jsonl + legacy path docs/story/activity.jsonl).
 * Both CLI calls and the Claude hook write to the new path; the legacy path is read-only for compatibility.
 * Writes no state; pure read-only analysis.
 */
import type { HandlerContext } from '@proof-or-stop/core/extension-api';
import { requireCoreRuntime } from '../core-runtime.js';
// B-cc10 CHK-002: the state-dir name comes from the single read-both resolver, so
// this reader follows the rename instead of silently reading a path that no longer
// exists (which would look like "no activity recorded" rather than an error).
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

interface LogEntry {
  source?: 'cli' | 'claude' | 'codex' | string;
  role?: string;
  startTime?: string | null;
  endTime?: string | null;
  tool?: string;
  status?: 'ok' | 'fail';
  error?: string | null;
  storyId?: string | null;
}

interface ToolStat {
  tool: string;
  total: number;
  ok: number;
  fail: number;
  cli: number;
  claude: number;
  codex: number;
  byRole: Record<string, number>;
  lastUsed: string | null;
}

export function createToolStatusHandlers(ctx: HandlerContext) {
  const { root } = ctx;
  const { STATE_DIR_NAMES } = requireCoreRuntime(ctx);

  return {
    tool_status(args?: {
      source?: 'cli' | 'claude' | 'codex' | 'all';
      role?: string;
      days?: number;
      limit?: number;
      format?: 'text' | 'json';
    }) {
      const source = args?.source ?? 'all';
      const role = args?.role;
      const days = args?.days ?? 30;
      const limit = args?.limit ?? 20;
      const format = args?.format ?? 'text';

      // Dual-source: runtime state-dir activity log + legacy docs/story path.
      // B-cc10 F-021: probe EVERY accepted state-dir spelling, canonical first. This
      // only checked the canonical dir, so a repo whose activity.jsonl still sits under
      // the deprecated spelling (e.g. right after the git-mv, before any command has
      // recreated it canonically) silently undercounted its own history — contradicting
      // this handler's documented dual-source design.
      const runtimeLogPaths = STATE_DIR_NAMES.map(dir => join(root, dir, 'activity.jsonl'));
      const legacyLogPath = join(root, 'docs', 'story', 'activity.jsonl');
      const logPaths = [...runtimeLogPaths, legacyLogPath].filter(p => existsSync(p));

      if (logPaths.length === 0) {
        return format === 'json'
          ? { error: 'activity.jsonl not found', logPaths: [...runtimeLogPaths, legacyLogPath] }
          : `(no data) activity.jsonl not found (looked in ${[...runtimeLogPaths, legacyLogPath].join(', ')})`;
      }

      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const stats = new Map<string, ToolStat>();
      let totalLines = 0;
      let parsedLines = 0;
      let filteredOut = 0;

      // Read and merge all log sources
      let raw = '';
      for (const lp of logPaths) {
        try { raw += readFileSync(lp, 'utf-8') + '\n'; } catch { /* skip unreadable */ }
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        totalLines++;
        let entry: LogEntry;
        try { entry = JSON.parse(line); } catch { continue; }
        parsedLines++;

        if (!entry.tool || typeof entry.tool !== 'string') continue;
        if (source !== 'all' && entry.source !== source) { filteredOut++; continue; }
        if (role && entry.role !== role) { filteredOut++; continue; }

        // Time filter: prefer endTime, fall back to startTime
        const ts = entry.endTime || entry.startTime;
        if (ts) {
          const t = Date.parse(ts);
          if (!isNaN(t) && t < cutoff) { filteredOut++; continue; }
        }

        let s = stats.get(entry.tool);
        if (!s) {
          s = { tool: entry.tool, total: 0, ok: 0, fail: 0, cli: 0, claude: 0, codex: 0, byRole: {}, lastUsed: null };
          stats.set(entry.tool, s);
        }
        s.total++;
        if (entry.status === 'ok') s.ok++;
        else if (entry.status === 'fail') s.fail++;
        if (entry.source === 'cli') s.cli++;
        else if (entry.source === 'claude') s.claude++;
        else if (entry.source === 'codex') s.codex++;
        const entryRole = entry.role || 'unknown';
        s.byRole[entryRole] = (s.byRole[entryRole] || 0) + 1;
        if (ts && (!s.lastUsed || ts > s.lastUsed)) s.lastUsed = ts;
      }

      const sorted = [...stats.values()].sort((a, b) => b.total - a.total);
      const top = sorted.slice(0, limit);

      const grandTotal = sorted.reduce((sum, s) => sum + s.total, 0);
      const grandOk = sorted.reduce((sum, s) => sum + s.ok, 0);
      const grandFail = sorted.reduce((sum, s) => sum + s.fail, 0);
      const grandCli = sorted.reduce((sum, s) => sum + s.cli, 0);
      const grandClaude = sorted.reduce((sum, s) => sum + s.claude, 0);
      const grandCodex = sorted.reduce((sum, s) => sum + s.codex, 0);
      const byRole = sorted.reduce<Record<string, number>>((acc, s) => {
        for (const [key, value] of Object.entries(s.byRole)) {
          acc[key] = (acc[key] || 0) + value;
        }
        return acc;
      }, {});
      const successPct = grandTotal > 0 ? Math.round(grandOk / grandTotal * 100) : 0;

      const summary = {
        source,
        role: role ?? 'all',
        days,
        logFiles: logPaths,
        totalLines,
        parsedLines,
        filteredOut,
        distinctTools: sorted.length,
        totalCalls: grandTotal,
        ok: grandOk,
        fail: grandFail,
        successRate: `${successPct}%`,
        bySource: { cli: grandCli, claude: grandClaude, codex: grandCodex },
        byRole,
      };

      if (format === 'json') {
        return { summary, top };
      }

      // text format: dashboard
      const lines: string[] = [];
      lines.push(`=== Proof-or-Stop tool usage (last ${days} days, source=${source}, role=${role ?? 'all'}) ===`);
      lines.push(`Log files: ${logPaths.join(' + ')}`);
      lines.push(`Total records: ${totalLines} (parsed ${parsedLines}, filtered ${filteredOut})`);
      lines.push(`Tools: ${sorted.length}`);
      lines.push(`Total calls: ${grandTotal} (cli ${grandCli}, claude ${grandClaude}, codex ${grandCodex})`);
      lines.push(`Success rate: ${grandOk}/${grandTotal} (${successPct}%) — fail ${grandFail}`);
      lines.push('');
      lines.push(`Top ${Math.min(limit, sorted.length)} tools:`);
      const maxNameLen = Math.max(...top.map(s => s.tool.length), 4);
      for (const s of top) {
        const last = s.lastUsed ? s.lastUsed.slice(0, 16).replace('T', ' ') : '-';
        lines.push(
          `  ${s.tool.padEnd(maxNameLen + 2)}` +
          `${String(s.total).padStart(5)}  ` +
          `ok=${String(s.ok).padStart(4)} ` +
          `fail=${String(s.fail).padStart(3)}  ` +
          `[cli ${s.cli}, claude ${s.claude}, codex ${s.codex}]  ` +
          `last ${last}`
        );
      }
      if (sorted.length > limit) {
        lines.push(`  ... ${sorted.length - limit} more tools not listed`);
      }

      return lines.join('\n');
    },
  };
}
