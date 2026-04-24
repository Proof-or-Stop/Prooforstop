/**
 * B-e8c8 CHK-005: commit message Resolves: CL-xxx 自动 resolve 整簇。
 *
 * 设计要点（见 plan.md CHK-005 + decision.json preMortem 1）：
 *   - 纯 sub-function `applyCommitResolves(findings, clusters, commitMessages)` 承担核心逻辑，
 *     便于 fixture 内脱离 git 环境直接测试（scratch-first）。
 *   - `syncClusterResolves` 外壳负责跑 `git log --format=%H%x00%B main..HEAD` 拿真实 commit，
 *     解析成 `{ sha, message }[]` 后喂给 pure fn。git 失败（非 git 目录 / 无 main 分支）→ zeros。
 *   - 正则 /Resolves?:\s+(CL-\d{3})/gi 宽容大小写和单复数。
 *   - 幂等：finding.status !== 'open' 的跳过（不覆盖已 resolved/dismissed 的条目）。
 *
 * CHK-010 会在此基础上追加 `resolvedBy` 审计字段 + unknown-cluster warning。
 */

import { execSync } from 'child_process';
import type { StoryStore } from './store.js';
import type { Finding } from './types.js';
import type { ClusterRecord } from './cluster-types.js';

export interface CommitMeta {
  /** 完整 commit sha (40 char) */
  sha: string;
  /** commit message (full body) */
  message: string;
}

export interface ClusterSyncResult {
  /** 本次扫描新标记为 resolved 的 finding 数量 */
  resolved: number;
  /** 非致命告警（如 Resolves: CL-xxx references unknown cluster） */
  warnings: string[];
  /** 命中的 commit → clusterId 映射（按扫描顺序） */
  matchedCommits: Array<{ sha: string; clusterId: string }>;
}

/**
 * 正则模板：Resolves: CL-001 / Resolve: CL-002 / resolves: CL-003（大小写 + 单复数不敏感）。
 *
 * F-010: 每次 applyCommitResolves 执行时在函数体内 new RegExp 生成新实例，
 * 避免模块级带 /g flag 的 lastIndex 在并发/重入场景被污染。
 * F-030: CL-\d{3,} 允许 3 位及以上数字（padStart(3) 保证最小宽度，CL-1000+ 4 位自然匹配）。
 */
const RESOLVES_RE_SOURCE = 'Resolves?:\\s+(CL-\\d{3,})';

/**
 * Pure sub-function：给定 findings / clusters / commitMessages，返回应用 Resolves 后的结果。
 *
 * 副作用限定在传入的 findings 数组（就地修改 status）——调用方负责持久化。
 * 不读 git，不读文件；便于 fixture 直接喂 commit message 字符串数组测试。
 */
export function applyCommitResolves(
  findings: Finding[],
  clusters: ClusterRecord[],
  commitMessages: CommitMeta[],
): ClusterSyncResult {
  const clusterById = new Map<string, ClusterRecord>();
  for (const c of clusters) clusterById.set(c.clusterId, c);

  const findingById = new Map<string, Finding>();
  for (const f of findings) findingById.set(f.id, f);

  const matchedCommits: Array<{ sha: string; clusterId: string }> = [];
  const warnings: string[] = [];
  let resolved = 0;

  // F-010: 函数局部 RegExp，每次调用独立 lastIndex，线程/重入安全。
  const re = new RegExp(RESOLVES_RE_SOURCE, 'gi');
  for (const { sha, message } of commitMessages) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    const seenInThisCommit = new Set<string>();
    while ((m = re.exec(message)) !== null) {
      const clusterId = m[1].toUpperCase();
      if (seenInThisCommit.has(clusterId)) continue; // 同 commit 重复 tag 只算一次
      seenInThisCommit.add(clusterId);

      const cluster = clusterById.get(clusterId);
      if (!cluster) {
        const short = sha.slice(0, 7);
        warnings.push(`Resolves: ${clusterId} references unknown cluster (commit ${short})`);
        continue;
      }

      matchedCommits.push({ sha, clusterId });

      const shortSha = sha.slice(0, 7);
      for (const fid of cluster.findingIds) {
        const f = findingById.get(fid);
        if (!f) continue;
        if (f.status !== 'open') continue; // 幂等：已 resolved/dismissed 的跳过，不覆盖 resolvedBy
        f.status = 'resolved';
        // CHK-010: 审计字段 — 记录是哪个 cluster 的哪个 commit 导致的 resolve
        f.resolvedBy = `${clusterId}@${shortSha}`;
        resolved += 1;
      }
    }
  }

  return { resolved, warnings, matchedCommits };
}

/**
 * 从 `git log --format=%H%x00%B main..HEAD` 解析 commit list。
 *
 * Git 不可用（非 git 目录 / 无 main 分支 / 无 commits）→ 返回 { commits: [], error? }。
 * F-023: `fatal: bad revision 'main..HEAD'` / `unknown revision` 之类错误不静默吞，
 * 通过返回值暴露给 syncClusterResolves，由外壳转成 warning 通过 ctx.log 输出。
 */
export function readCommitsSinceMain(projectRoot: string): { commits: CommitMeta[]; error?: string } {
  let raw: string;
  try {
    raw = execSync('git log --format=%H%x00%B%x1e main..HEAD', {
      cwd: projectRoot,
      encoding: 'utf-8',
      // capture stderr so callers can surface fatal: bad revision / unknown revision
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const stderr = String((e as { stderr?: Buffer | string }).stderr ?? '').trim();
    const msg = stderr || String((e as Error).message || '').trim() || 'git log failed';
    return { commits: [], error: msg };
  }
  if (!raw || !raw.trim()) return { commits: [] };

  // 每条 commit 结构: <sha>\x00<body>\x1e
  const commits: CommitMeta[] = [];
  for (const entry of raw.split('\x1e')) {
    const chunk = entry.trim();
    if (!chunk) continue;
    const nullIdx = chunk.indexOf('\x00');
    if (nullIdx < 0) continue;
    const sha = chunk.slice(0, nullIdx).trim();
    const message = chunk.slice(nullIdx + 1);
    if (sha) commits.push({ sha, message });
  }
  return { commits };
}

/**
 * Sync 入口：扫 story 的 commits + clusters，对命中 Resolves: CL-xxx 的簇内 open finding 标 resolved。
 *
 * 调用方：
 *   - `finding_list` handler（每次 list 前扫一遍保持及时）
 *   - `validate` handler（跑 validate 前扫，便于 TEST gate 正确计数）
 *
 * 幂等保护：已 resolved 的不重复标。git 不可用 → 返回 warning（不抛错）。
 *
 * F-007: 调用方传 `log` 回调，syncClusterResolves 把每条 warning 直接 ctx.log 到 validate
 * 主输出 log stream（而非 console.warn 到 stderr 被 validate 吞掉）。
 */
export function syncClusterResolves(
  storyId: string,
  store: StoryStore,
  projectRoot: string,
  log?: (msg: string) => void,
): ClusterSyncResult {
  const clustersData = store.readClusters(storyId);
  if (!clustersData.clusters || clustersData.clusters.length === 0) {
    return { resolved: 0, warnings: [], matchedCommits: [] };
  }
  const { commits, error } = readCommitsSinceMain(projectRoot);
  if (error) {
    // F-023: git fatal (bad revision / main 分支不存在 / 非 git 目录) 转 warning 暴露给用户。
    const short = summarizeGitError(error);
    const w = `cluster-sync skipped: ${short}`;
    log?.(w);
    return { resolved: 0, warnings: [w], matchedCommits: [] };
  }
  if (commits.length === 0) {
    return { resolved: 0, warnings: [], matchedCommits: [] };
  }
  const findingsData = store.readFindings(storyId);
  const result = applyCommitResolves(findingsData.findings, clustersData.clusters, commits);
  if (result.resolved > 0) {
    store.writeFindings(storyId, findingsData);
  }
  // F-007: 每条 warning 主动经 log 回调落地到 validate 主输出
  if (log) {
    for (const w of result.warnings) log(w);
  }
  return result;
}

/**
 * 浓缩 git stderr 为人类可读的一行 warning 摘要。
 * F-023: 把 `fatal: ambiguous argument '<base>..HEAD': unknown revision ...` 压成
 * `<base> branch not found` 之类简短提示，避免 warning 里混入长 stderr。
 */
function summarizeGitError(err: string): string {
  const lower = err.toLowerCase();
  if (lower.includes('unknown revision') || lower.includes('bad revision') || lower.includes('ambiguous argument')) {
    return 'default branch not found (unknown revision for base branch)';
  }
  if (lower.includes('not a git repository')) {
    return 'not a git repository';
  }
  // 其它情况取第一行，截短到 120 字符
  const firstLine = err.split('\n')[0].trim();
  return firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
}
