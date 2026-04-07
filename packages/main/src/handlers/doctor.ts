/**
 * koala doctor — 输出最近 24 小时的 health issue（按 category 分组）
 *
 * 让用户能定期 `koala doctor` 检查 koala 自己有没有隐藏的 PERSIST 失败。
 * 之前这些失败被 silent catch 吞掉，事后无法回溯。
 */

import type { HandlerContext } from './context.js';
import { readHealthIssues, summarizeHealthIssues, getHealthPath } from '../core/health.js';

export function createDoctorHandlers(_ctx: HandlerContext) {
  return {
    doctor(args?: { format?: 'text' | 'json'; limit?: number }): string | object {
      const limit = args?.limit ?? 1000;
      const issues = readHealthIssues(limit);
      const summary = summarizeHealthIssues(issues);

      if (args?.format === 'json') {
        return {
          healthPath: getHealthPath(),
          ...summary,
        };
      }

      // text 输出
      const lines: string[] = [];
      lines.push(`koala doctor — health issues`);
      lines.push(`  source: ${getHealthPath()}`);
      lines.push(`  total : ${summary.total} issues recorded`);
      lines.push(`  shown : ${summary.recent.length} (${summary.recentWindow === '24h' ? 'last 24h' : 'most recent'})`);
      lines.push('');

      if (summary.total === 0) {
        lines.push('✓ No health issues recorded. koala is healthy.');
        return lines.join('\n');
      }

      lines.push('By category:');
      const sorted = Object.entries(summary.byCategory).sort((a, b) => b[1] - a[1]);
      for (const [cat, count] of sorted) {
        lines.push(`  ${cat.padEnd(30)} ${count}`);
      }
      lines.push('');

      lines.push('Recent issues:');
      for (const issue of summary.recent.slice(0, 20)) {
        const ctxStr = Object.entries(issue.context)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ');
        lines.push(`  [${issue.timestamp}] ${issue.category}`);
        lines.push(`    error: ${issue.error}`);
        if (ctxStr) lines.push(`    context: ${ctxStr}`);
      }
      if (summary.recent.length > 20) {
        lines.push(`  ... and ${summary.recent.length - 20} more (use --format=json for full list)`);
      }
      lines.push('');
      lines.push(`→ 这些 issue 都是非致命错误（被 reportHealthIssue 接住），但可能预示数据/审计不完整。`);
      lines.push(`→ 如需清空：rm ${getHealthPath()}`);

      return lines.join('\n');
    },
  };
}
