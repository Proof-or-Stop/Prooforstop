/**
 * Health issue tracking — silent catch 分类处理的接收端
 *
 * 设计目的：
 *   koala 之前有几十处 silent catch（try ... catch ignore），按 CC 的 fail-fast
 *   原则分四类处理：
 *     - DEBUG  (日志/进度)         → 保留 silent
 *     - PROBE  (探测，如文件不存在) → 保留 silent
 *     - PERSIST (writeLog/save 失败) → 改为 reportHealthIssue（不抛错，但留痕）
 *     - MUTATION (git/fs.write 失败) → 改为 throw
 *
 *   PERSIST 类失败之前会被 swallow，事后无法回溯。本模块提供一个轻量的
 *   JSONL append 接收器：每条 issue 写到 ~/.koala/health.jsonl，
 *   `koala doctor` 可以读出来。
 *
 * 设计约束：
 *   - reportHealthIssue 自身不能抛错。health 模块崩溃不能拖死主流程。
 *   - JSONL 行格式稳定（schemaVersion=1），方便外部 tooling 消费。
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface HealthIssue {
  schemaVersion: 1;
  /** 写入时间 (ISO 8601) */
  timestamp: string;
  /** 分类标签：persist:writeLog / persist:state / mutation:git / etc */
  category: string;
  /** 错误消息（不含 stack） */
  error: string;
  /** 上下文：命令名、storyId、文件路径等 */
  context: Record<string, unknown>;
}

/** 默认 health.jsonl 路径：~/.koala/health.jsonl */
export function getHealthPath(): string {
  // 允许通过 env 覆盖路径，方便测试
  if (process.env.KOALA_HEALTH_PATH) return process.env.KOALA_HEALTH_PATH;
  return join(homedir(), '.koala', 'health.jsonl');
}

/**
 * 记录一条 health issue。
 *
 * **本函数永不抛错** — 即使 health 文件写入失败也不影响主流程。
 * 写入失败时会尝试 stderr 输出一条警告，但不抛出。
 */
export function reportHealthIssue(
  category: string,
  error: Error | { message: string },
  context: Record<string, unknown>,
): void {
  try {
    const healthPath = getHealthPath();
    const dir = join(healthPath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const issue: HealthIssue = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      category,
      error: error.message,
      context,
    };
    appendFileSync(healthPath, JSON.stringify(issue) + '\n');
  } catch (e: unknown) {
    // 最后防线：health 自己崩了，写 stderr 但不抛错
    try {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[koala-health] failed to record health issue: ${msg}\n`);
    } catch { /* 真的没辙了 */ }
  }
}

/**
 * 读取所有 health issue（最新在前）。
 * 返回空数组表示没有 issue 或 health.jsonl 不存在。
 */
export function readHealthIssues(maxCount = 1000): HealthIssue[] {
  const healthPath = getHealthPath();
  if (!existsSync(healthPath)) return [];
  try {
    const content = readFileSync(healthPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    const issues: HealthIssue[] = [];
    // 从尾部往前读，保证最新在前
    for (let i = lines.length - 1; i >= 0 && issues.length < maxCount; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as HealthIssue;
        if (parsed && typeof parsed.timestamp === 'string' && typeof parsed.category === 'string') {
          issues.push(parsed);
        }
      } catch { /* 跳过损坏行 */ }
    }
    return issues;
  } catch {
    return [];
  }
}

/**
 * 按分类聚合 issues — doctor 命令用。
 */
export function summarizeHealthIssues(issues: HealthIssue[]): {
  total: number;
  byCategory: Record<string, number>;
  recent: HealthIssue[];
  recentWindow: '24h' | 'all';
} {
  const byCategory: Record<string, number> = {};
  for (const i of issues) {
    byCategory[i.category] = (byCategory[i.category] || 0) + 1;
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = issues.filter(i => {
    const t = Date.parse(i.timestamp);
    return Number.isFinite(t) && t >= cutoff;
  });
  return {
    total: issues.length,
    byCategory,
    recent: recent.length > 0 ? recent.slice(0, 50) : issues.slice(0, 50),
    recentWindow: recent.length > 0 ? '24h' : 'all',
  };
}
