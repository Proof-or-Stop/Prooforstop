/**
 * koala doctor — 输出最近 24 小时的 health issue（按 category 分组）
 *
 * 让用户能定期 `koala doctor` 检查 koala 自己有没有隐藏的 PERSIST 失败。
 * 之前这些失败被 silent catch 吞掉，事后无法回溯。
 *
 * B-7241 follow-up: `--repair` 模式扫 `.worktrees/` 下的孤儿目录
 * （git worktree list 里没有但目录还在的）并 rm -rf 清理。针对
 * DONE 合并后因为 activity.jsonl / tmp 运行时产物残留导致 git
 * worktree remove 静默只清 registry 不清目录的场景。
 */

import { execSync } from 'child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { readHealthIssues, summarizeHealthIssues, getHealthPath } from '../core/health.js';
import { loadConfig } from '../core/config.js';

export function createDoctorHandlers(ctx: HandlerContext) {
  const { root } = ctx;

  return {
    doctor(args?: { format?: 'text' | 'json'; limit?: number; repair?: boolean }): string | object {
      const limit = args?.limit ?? 1000;
      const issues = readHealthIssues(limit);
      const summary = summarizeHealthIssues(issues);

      // B-7241 follow-up: scan for orphan worktrees (directory exists but
      // `git worktree list` doesn't know about it). This typically happens
      // after a DONE merge when Claude Code's activity.jsonl hook or tmp/
      // runtime files kept file handles open during `git worktree remove`,
      // so git deregistered the worktree but left the dir behind.
      const orphanScan = scanOrphanWorktrees(root);
      const repaired: string[] = [];
      const repairFailed: Array<{ path: string; error: string }> = [];
      if (args?.repair && orphanScan.orphans.length > 0) {
        for (const orphan of orphanScan.orphans) {
          try {
            rmSync(orphan, { recursive: true, force: true });
            repaired.push(orphan);
          } catch (e: any) {
            repairFailed.push({ path: orphan, error: e.message || String(e) });
          }
        }
      }

      if (args?.format === 'json') {
        return {
          healthPath: getHealthPath(),
          ...summary,
          worktrees: {
            registered: orphanScan.registered,
            orphansFound: orphanScan.orphans,
            repaired,
            repairFailed,
            repairRequested: !!args?.repair,
          },
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
      } else {
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
        lines.push('');
      }

      // Worktree orphan section
      lines.push('Worktree scan:');
      lines.push(`  registered: ${orphanScan.registered.length}`);
      lines.push(`  orphans   : ${orphanScan.orphans.length}`);
      if (orphanScan.orphans.length === 0) {
        lines.push('  ✓ No orphan worktree directories.');
      } else {
        for (const o of orphanScan.orphans) {
          lines.push(`  - ${o}`);
        }
        if (args?.repair) {
          lines.push('');
          lines.push(`Repair:`);
          for (const p of repaired) lines.push(`  ✓ removed ${p}`);
          for (const f of repairFailed) lines.push(`  ✗ ${f.path}: ${f.error}`);
        } else {
          lines.push('');
          lines.push(`→ 这些目录不在 git worktree list 里，但 .worktrees/ 下还有残留。`);
          lines.push(`→ 重跑: koala doctor --repair 清理`);
        }
      }

      return lines.join('\n');
    },
  };
}

/**
 * 扫描 .worktrees/ 目录下的孤儿条目。
 *
 * 孤儿 = 目录存在于 worktreeDir 下，但 `git worktree list --porcelain` 没有
 * 把它列为活动的 worktree。典型成因：`git worktree remove` 因为 activity.jsonl
 * 等 gitignored 运行时产物被 hook 持续写入，git 静默只清 registry 而没删目录。
 */
function scanOrphanWorktrees(root: string): {
  registered: string[];
  orphans: string[];
} {
  const cfg = loadConfig(root);
  const worktreeDirName = cfg.worktreeDir || '.worktrees';

  // Find repo root from the current root
  let repoRoot: string;
  try {
    repoRoot = execSync('git rev-parse --show-toplevel', { cwd: root, encoding: 'utf-8' }).trim();
  } catch {
    return { registered: [], orphans: [] };
  }

  const worktreeBase = join(repoRoot, worktreeDirName);
  if (!existsSync(worktreeBase)) {
    return { registered: [], orphans: [] };
  }

  // Collect the set of paths git currently considers active worktrees
  let registered: string[] = [];
  try {
    const raw = execSync('git worktree list --porcelain', { cwd: repoRoot, encoding: 'utf-8' });
    registered = raw
      .split(/\r?\n/)
      .filter(l => l.startsWith('worktree '))
      .map(l => l.slice('worktree '.length).trim())
      .map(p => p.replace(/\\/g, '/'));
  } catch {
    return { registered: [], orphans: [] };
  }

  // Directories directly under worktreeBase
  let entries: string[];
  try {
    entries = readdirSync(worktreeBase);
  } catch {
    return { registered, orphans: [] };
  }

  const orphans: string[] = [];
  for (const name of entries) {
    const abs = join(worktreeBase, name);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const norm = abs.replace(/\\/g, '/');
    const matched = registered.some(r => r === norm);
    if (!matched) orphans.push(abs);
  }

  return { registered, orphans };
}
