/**
 * B-e8c8 CHK-002 / CHK-009: 纯函数 clusterFindings — 按 (files 交集占比 ≥50% + severity 一致) 合并。
 *
 * 聚簇规则（CHK-009 收紧版，替代 CHK-002 的 "交集 ≥ 1"）：
 *   - 两 finding 属同一簇 ⇔ severity 相等 且 |files_a ∩ files_b| / max(|files_a|,|files_b|) ≥ 0.5
 *   - 两侧 files 集合都必须非空才考虑合并（空侧走 singleton）
 *   - 不跨 severity 合并（符合 background.md 洞察3：一次改动能同解 而非关键词相似，F-037 时序 bug 不应并入 MAX_SEATS 簇）
 *
 * CHK-009 regex 兜底：
 *   - finding.files 为空/缺失时，从 finding.desc 用 DESC_PATH_REGEX 抽取路径作为"有效 files"
 *     参与聚簇判定。**不写回 finding.files**（原件只读，签名范围不变）。
 *   - 抽取无结果 → 仍当作 singleton
 *
 * CHK-009 rootCause 自动生成：
 *   - 单成员簇：保持占位符 "<待主 agent 填写>"
 *   - 多成员簇：rootCause = "多个 finding 都涉及 <top N 共享文件>"（F-034 加"都"与 userSees 对齐）
 *     - top 共享 = 所有成员共有的 files（intersection）前 2 个
 *     - intersection 为空时退化为 union 前 2 个
 *
 * 幂等保证：按 finding.id 升序排序后使用 union-find 合并；
 *   同一批 finding 多次调用输出相同 clusterId 和成员顺序。
 *
 * 本文件遵循 fn.ts 范式：纯函数、无副作用、无 I/O。
 */

import type { Finding } from './types.js';
import type { ClusterRecord } from './cluster-types.js';

const CLUSTER_PLACEHOLDER_ROOT_CAUSE = '<待主 agent 填写>';
const CLUSTER_OVERLAP_THRESHOLD = 0.5;

/**
 * CHK-009: 从 finding.desc 兜底抽取文件路径。
 *
 * 匹配四类路径：
 *   - `packages/<path>` / `src/<path>` / `docs/<path>` / `tests/<path>` (带目录前缀的相对路径)
 *   - `CLAUDE.md` (顶层常见文档)
 *   - 任何包含常见代码/文档扩展名的 token（.ts/.tsx/.js/.jsx/.md/.json）
 *
 * 导出供其它 handler（如 future cluster_update）复用。
 */
const DESC_PATH_REGEX = /(packages\/[\w./-]+|src\/[\w./-]+|docs\/[\w./-]+|tests\/[\w./-]+|CLAUDE\.md|[\w./-]+\.(?:ts|tsx|js|jsx|md|json))/g;

export function extractFilesFromDesc(desc: string): string[] {
  if (!desc) return [];
  const matches = desc.match(DESC_PATH_REGEX);
  if (!matches) return [];
  return dedupStable(matches);
}

/** 取有效 files：优先 finding.files，否则 desc 兜底抽取；用于聚簇判定，**不改动 finding 原件**。 */
function effectiveFiles(f: Finding): string[] {
  if (f.files && f.files.length > 0) return f.files;
  return extractFilesFromDesc(f.desc || '');
}

function overlapRatio(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  let inter = 0;
  for (const x of b) if (setA.has(x)) inter++;
  const denom = Math.max(a.length, b.length);
  return denom === 0 ? 0 : inter / denom;
}

/**
 * 把 findings 聚簇成 ClusterRecord[]。
 *
 * @param findings 输入 finding 列表（可含 files/severity/status 混合）
 * @param now 创建时间（可注入测试时钟）；默认 new Date().toISOString()
 * @param existingClusters 可选：已存在的 cluster 列表。若提供：
 *   - **保留**这些 cluster（不覆盖、不重命名），新 cluster 从 max(existingId)+1 开始编号；
 *   - 已在 existingClusters.findingIds 中的 finding **不参与**本次重新聚簇（当作已归属）；
 *   - 返回值 = existingClusters（原样保留） + 对剩余 finding 新计算出的 cluster。
 *   不传时行为与旧版一致：忽略历史状态，从 CL-001 全量重算。
 *
 * F-012: 引入 existingClusters 避免与已有 "Resolves: CL-001" commit 引用的编号冲突。
 *
 * @returns 稳定排序的 cluster 列表（existingClusters 在前，新簇按 CL-xxx 递增分配在后）
 */
export function clusterFindings(
  findings: readonly Finding[],
  now: string = new Date().toISOString(),
  existingClusters?: readonly ClusterRecord[],
): ClusterRecord[] {
  // F-012: 预处理 existingClusters — 摘出 max id 和已归属的 finding 集合
  const preserved: ClusterRecord[] = existingClusters ? existingClusters.map(c => ({ ...c })) : [];
  const existingMaxId = preserved.reduce((m, c) => {
    const match = c.clusterId.match(/^CL-(\d+)$/);
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  const claimedIds = new Set<string>();
  for (const c of preserved) for (const fid of c.findingIds) claimedIds.add(fid);

  // 跳过已归属的 finding — 它们不参与本次重新聚簇
  const remaining = findings.filter(f => !claimedIds.has(f.id));

  // 稳定排序：按 finding.id 字典序，使得 union-find 输入顺序确定。
  const sorted = [...remaining].sort((a, b) => a.id.localeCompare(b.id));
  const n = sorted.length;
  if (n === 0) return preserved;

  // 预计算 effective files（一次性，避免重复扫描 desc）
  const effective: string[][] = sorted.map(f => effectiveFiles(f));

  // Union-find by index
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    // 小编号做根，保证幂等和可读性
    if (ra < rb) parent[rb] = ra; else parent[ra] = rb;
  };

  for (let i = 0; i < n; i++) {
    const fi = sorted[i];
    const efi = effective[i];
    if (efi.length === 0) continue; // 双侧都为空的 singleton 不参与合并
    for (let j = i + 1; j < n; j++) {
      const fj = sorted[j];
      const efj = effective[j];
      if (efj.length === 0) continue;
      if (fi.severity !== fj.severity) continue;
      if (overlapRatio(efi, efj) >= CLUSTER_OVERLAP_THRESHOLD) union(i, j);
    }
  }

  // 按 root 分组（root 的第一出现顺序决定 CL-xxx 编号）
  const rootOrder: number[] = [];
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); rootOrder.push(r); }
    g.push(i);
  }

  // F-012: 新 cluster 从 existingMaxId+1 开始编号，避免与已 commit Resolves: CL-xxx 引用的历史编号冲突。
  // F-030: padStart(3) 保持最小 3 位宽度；CL-1000+ 4 位自然匹配 /CL-\d{3,}/。
  const clusters: ClusterRecord[] = [...preserved];
  rootOrder.forEach((root, idx) => {
    const memberIdxs = groups.get(root)!;
    const members = memberIdxs.map(i => sorted[i]);
    // files 以原件 finding.files 为准（不把 desc 兜底路径污染到 cluster.files）
    // 若所有成员都依赖兜底，则 cluster.files 会取兜底联合，保证 cluster.files 非空以反映聚簇依据。
    const hasAnyReal = members.some(m => m.files && m.files.length > 0);
    const filesUnion = hasAnyReal
      ? dedupStable(members.flatMap(m => m.files ?? []))
      : dedupStable(memberIdxs.flatMap(i => effective[i]));
    const severity = members[0].severity;
    const rootCause = computeAutoRootCause(memberIdxs.map(i => effective[i]));
    clusters.push({
      clusterId: `CL-${String(existingMaxId + idx + 1).padStart(3, '0')}`,
      rootCause,
      findingIds: members.map(m => m.id),
      files: filesUnion,
      severity,
      createdAt: now,
    });
  });

  return clusters;
}

/**
 * 按成员 effective-files 计算自动 rootCause。
 * - 单成员 → 占位符（CHK-002 原行为）
 * - 多成员 → 取所有成员 files 交集前 2 个，空交集退化为 union 前 2 个
 */
function computeAutoRootCause(memberFiles: string[][]): string {
  if (memberFiles.length < 2) return CLUSTER_PLACEHOLDER_ROOT_CAUSE;

  // 求所有成员的 files 交集（全员共享）
  let intersect: string[] | null = null;
  for (const mf of memberFiles) {
    if (mf.length === 0) continue;
    if (intersect === null) {
      intersect = [...mf];
    } else {
      const s = new Set(mf);
      intersect = intersect.filter(x => s.has(x));
    }
  }
  if (intersect === null) intersect = [];

  let top: string[];
  if (intersect.length > 0) {
    top = intersect.slice(0, 2);
  } else {
    top = dedupStable(memberFiles.flat()).slice(0, 2);
  }
  if (top.length === 0) return CLUSTER_PLACEHOLDER_ROOT_CAUSE;
  // F-034: 文案与 CHK-009 userSees "多个 finding 都涉及" 对齐（加"都"）。
  return `多个 finding 都涉及 ${top.join(', ')}`;
}

/**
 * 强制把指定 finding ids 合并为一个新簇（用于 finding_cluster --merge）。
 * 前置校验：ids 非空、全部存在、severity 一致。
 * 返回新簇 + 移除了这些 findings 后的剩余簇（剩余簇保留原 clusterId）。
 */
export function forceMergeCluster(
  existing: ClusterRecord[],
  allFindings: readonly Finding[],
  mergeIds: readonly string[],
  now: string = new Date().toISOString()
): ClusterRecord {
  if (!mergeIds || mergeIds.length < 2) {
    throw new Error('finding_cluster --merge 至少需要 2 个 finding id');
  }
  const byId = new Map(allFindings.map(f => [f.id, f]));
  const members: Finding[] = [];
  for (const id of mergeIds) {
    const f = byId.get(id);
    if (!f) throw new Error(`finding ${id} 不存在`);
    members.push(f);
  }
  const sev = members[0].severity;
  if (members.some(m => m.severity !== sev)) {
    throw new Error(
      `finding_cluster --merge 要求 severity 一致，当前混杂：${members.map(m => `${m.id}=${m.severity}`).join(', ')}`
    );
  }
  const sortedMembers = [...members].sort((a, b) => a.id.localeCompare(b.id));
  const maxN = existing.reduce((m, c) => {
    const match = c.clusterId.match(/^CL-(\d+)$/);
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  const clusterId = `CL-${String(maxN + 1).padStart(3, '0')}`;
  const memberEffective = sortedMembers.map(m => effectiveFiles(m));
  const hasAnyReal = sortedMembers.some(m => m.files && m.files.length > 0);
  const files = hasAnyReal
    ? dedupStable(sortedMembers.flatMap(m => m.files ?? []))
    : dedupStable(memberEffective.flat());
  return {
    clusterId,
    rootCause: computeAutoRootCause(memberEffective),
    findingIds: sortedMembers.map(f => f.id),
    files,
    severity: sev,
    createdAt: now,
  };
}

function dedupStable(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of items) {
    if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

export { CLUSTER_PLACEHOLDER_ROOT_CAUSE, CLUSTER_OVERLAP_THRESHOLD };
