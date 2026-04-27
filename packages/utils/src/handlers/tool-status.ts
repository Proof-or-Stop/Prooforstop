/**
 * tool_status — 统计 koala 工具的实际使用情况
 *
 * 数据源是双源 activity.jsonl（新路径 .koala/activity.jsonl + 旧路径 docs/story/activity.jsonl）。
 * CLI 调用 + Claude hook 都会落盘到新路径；旧路径只读兼容。
 * 不写任何状态，纯只读分析。
 */
import type { HandlerContext } from '../../../main/dist/handlers/context.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

interface LogEntry {
  source?: 'cli' | 'claude';
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
  lastUsed: string | null;
}

export function createToolStatusHandlers(ctx: HandlerContext) {
  const { root } = ctx;

  return {
    tool_status(args?: {
      source?: 'cli' | 'claude' | 'all';
      days?: number;
      limit?: number;
      format?: 'text' | 'json';
    }) {
      const source = args?.source ?? 'all';
      const days = args?.days ?? 30;
      const limit = args?.limit ?? 20;
      const format = args?.format ?? 'text';

      // Dual-source: new path (.koala/activity.jsonl) + legacy path (docs/story/activity.jsonl)
      const runtimeLogPath = join(root, '.koala', 'activity.jsonl');
      const legacyLogPath = join(root, 'docs', 'story', 'activity.jsonl');
      const logPaths = [runtimeLogPath, legacyLogPath].filter(p => existsSync(p));

      if (logPaths.length === 0) {
        return format === 'json'
          ? { error: 'activity.jsonl 不存在', logPaths: [runtimeLogPath, legacyLogPath] }
          : `(no data) activity.jsonl 不存在（已查找 ${runtimeLogPath} 和 ${legacyLogPath}）`;
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

        // 时间过滤：endTime 优先，没有就用 startTime
        const ts = entry.endTime || entry.startTime;
        if (ts) {
          const t = Date.parse(ts);
          if (!isNaN(t) && t < cutoff) { filteredOut++; continue; }
        }

        let s = stats.get(entry.tool);
        if (!s) {
          s = { tool: entry.tool, total: 0, ok: 0, fail: 0, cli: 0, claude: 0, lastUsed: null };
          stats.set(entry.tool, s);
        }
        s.total++;
        if (entry.status === 'ok') s.ok++;
        else if (entry.status === 'fail') s.fail++;
        if (entry.source === 'cli') s.cli++;
        else if (entry.source === 'claude') s.claude++;
        if (ts && (!s.lastUsed || ts > s.lastUsed)) s.lastUsed = ts;
      }

      const sorted = [...stats.values()].sort((a, b) => b.total - a.total);
      const top = sorted.slice(0, limit);

      const grandTotal = sorted.reduce((sum, s) => sum + s.total, 0);
      const grandOk = sorted.reduce((sum, s) => sum + s.ok, 0);
      const grandFail = sorted.reduce((sum, s) => sum + s.fail, 0);
      const grandCli = sorted.reduce((sum, s) => sum + s.cli, 0);
      const grandClaude = sorted.reduce((sum, s) => sum + s.claude, 0);
      const successPct = grandTotal > 0 ? Math.round(grandOk / grandTotal * 100) : 0;

      const summary = {
        source,
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
        bySource: { cli: grandCli, claude: grandClaude },
      };

      if (format === 'json') {
        return { summary, top };
      }

      // text 格式：dashboard
      const lines: string[] = [];
      lines.push(`=== koala 工具使用统计（最近 ${days} 天，source=${source}） ===`);
      lines.push(`日志文件: ${logPaths.join(' + ')}`);
      lines.push(`总记录: ${totalLines} (解析 ${parsedLines}, 过滤 ${filteredOut})`);
      lines.push(`工具数: ${sorted.length}`);
      lines.push(`总调用: ${grandTotal} (cli ${grandCli}, claude ${grandClaude})`);
      lines.push(`成功率: ${grandOk}/${grandTotal} (${successPct}%) — fail ${grandFail}`);
      lines.push('');
      lines.push(`Top ${Math.min(limit, sorted.length)} 工具:`);
      const maxNameLen = Math.max(...top.map(s => s.tool.length), 4);
      for (const s of top) {
        const last = s.lastUsed ? s.lastUsed.slice(0, 16).replace('T', ' ') : '-';
        lines.push(
          `  ${s.tool.padEnd(maxNameLen + 2)}` +
          `${String(s.total).padStart(5)}  ` +
          `ok=${String(s.ok).padStart(4)} ` +
          `fail=${String(s.fail).padStart(3)}  ` +
          `[cli ${s.cli}, claude ${s.claude}]  ` +
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
