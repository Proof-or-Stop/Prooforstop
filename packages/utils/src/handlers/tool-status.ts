/**
 * tool_status — 统计 koala 工具的实际使用情况
 *
 * 数据源是 .koala/activity.jsonl + legacy docs/story/activity.jsonl。
 * 不写任何状态，纯只读分析。
 */
import type { HandlerContext } from '../../../main/dist/handlers/context.js';
import { getActivityLogPaths, readActivityLogEntries } from '../../../main/dist/core/activity-log.js';

interface LogEntry {
  source?: string;
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
  bySource: Record<string, number>;
  byRole: Record<string, number>;
  lastUsed: string | null;
}

export function createToolStatusHandlers(ctx: HandlerContext) {
  const { root } = ctx;

  return {
    tool_status(args?: {
      source?: 'cli' | 'claude' | 'codex' | 'all';
      role?: string;
      days?: number;
      limit?: number;
      format?: 'text' | 'json';
    }) {
      const source = args?.source ?? 'all';
      const role = args?.role?.trim() || '';
      const days = args?.days ?? 30;
      const limit = args?.limit ?? 20;
      const format = args?.format ?? 'text';

      const logPaths = getActivityLogPaths(root);
      const entries = readActivityLogEntries(root);
      if (entries.length === 0) {
        return format === 'json'
          ? { error: 'activity.jsonl 不存在', logPaths }
          : `(no data) ${logPaths.join(' / ')} 不存在或没有可解析记录`;
      }

      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const stats = new Map<string, ToolStat>();
      let totalLines = 0;
      let parsedLines = 0;
      let filteredOut = 0;

      for (const rawEntry of entries) {
        totalLines++;
        const entry = rawEntry as LogEntry;
        parsedLines++;

        if (!entry.tool || typeof entry.tool !== 'string') continue;
        if (source !== 'all' && entry.source !== source) { filteredOut++; continue; }
        const roleKey = entry.role || 'unknown';
        if (role && roleKey !== role) { filteredOut++; continue; }

        // 时间过滤：endTime 优先，没有就用 startTime
        const ts = entry.endTime || entry.startTime;
        if (ts) {
          const t = Date.parse(ts);
          if (!isNaN(t) && t < cutoff) { filteredOut++; continue; }
        }

        let s = stats.get(entry.tool);
        if (!s) {
          s = { tool: entry.tool, total: 0, ok: 0, fail: 0, bySource: {}, byRole: {}, lastUsed: null };
          stats.set(entry.tool, s);
        }
        s.total++;
        if (entry.status === 'ok') s.ok++;
        else if (entry.status === 'fail') s.fail++;
        const sourceKey = entry.source || 'unknown';
        s.bySource[sourceKey] = (s.bySource[sourceKey] || 0) + 1;
        s.byRole[roleKey] = (s.byRole[roleKey] || 0) + 1;
        if (ts && (!s.lastUsed || ts > s.lastUsed)) s.lastUsed = ts;
      }

      const sorted = [...stats.values()].sort((a, b) => b.total - a.total);
      const top = sorted.slice(0, limit);

      const grandTotal = sorted.reduce((sum, s) => sum + s.total, 0);
      const grandOk = sorted.reduce((sum, s) => sum + s.ok, 0);
      const grandFail = sorted.reduce((sum, s) => sum + s.fail, 0);
      const grandBySource = sorted.reduce<Record<string, number>>((acc, s) => {
        for (const [key, count] of Object.entries(s.bySource)) {
          acc[key] = (acc[key] || 0) + count;
        }
        return acc;
      }, {});
      const grandByRole = sorted.reduce<Record<string, number>>((acc, s) => {
        for (const [key, count] of Object.entries(s.byRole)) {
          acc[key] = (acc[key] || 0) + count;
        }
        return acc;
      }, {});
      const successPct = grandTotal > 0 ? Math.round(grandOk / grandTotal * 100) : 0;

      const summary = {
        source,
        role: role || 'all',
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
        bySource: grandBySource,
        byRole: grandByRole,
      };

      if (format === 'json') {
        return { summary, top };
      }

      // text 格式：dashboard
      const lines: string[] = [];
      lines.push(`=== koala 工具使用统计（最近 ${days} 天，source=${source}, role=${role || 'all'}） ===`);
      lines.push(`日志文件: ${logPaths.join(' + ')}`);
      lines.push(`总记录: ${totalLines} (解析 ${parsedLines}, 过滤 ${filteredOut})`);
      lines.push(`工具数: ${sorted.length}`);
      const sourceSummary = Object.entries(grandBySource)
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => `${key} ${count}`)
        .join(', ');
      const roleSummary = Object.entries(grandByRole)
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => `${key} ${count}`)
        .join(', ');
      lines.push(`总调用: ${grandTotal}${sourceSummary ? ` [source: ${sourceSummary}]` : ''}${roleSummary ? ` [role: ${roleSummary}]` : ''}`);
      lines.push(`成功率: ${grandOk}/${grandTotal} (${successPct}%) — fail ${grandFail}`);
      lines.push('');
      lines.push(`Top ${Math.min(limit, sorted.length)} 工具:`);
      const maxNameLen = Math.max(...top.map(s => s.tool.length), 4);
      for (const s of top) {
        const last = s.lastUsed ? s.lastUsed.slice(0, 16).replace('T', ' ') : '-';
        const perSource = Object.entries(s.bySource)
          .sort((a, b) => b[1] - a[1])
          .map(([key, count]) => `${key} ${count}`)
          .join(', ');
        const perRole = Object.entries(s.byRole)
          .sort((a, b) => b[1] - a[1])
          .map(([key, count]) => `${key} ${count}`)
          .join(', ');
        lines.push(
          `  ${s.tool.padEnd(maxNameLen + 2)}` +
          `${String(s.total).padStart(5)}  ` +
          `ok=${String(s.ok).padStart(4)} ` +
          `fail=${String(s.fail).padStart(3)}  ` +
          `[src ${perSource || 'unknown 0'} | role ${perRole || 'unknown 0'}]  ` +
          `last ${last}`
        );
      }
      if (sorted.length > limit) {
        lines.push(`  ... 还有 ${sorted.length - limit} 个工具未列出`);
      }

      return lines.join('\n');
    },
  };
}
