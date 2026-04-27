/**
 * B-e8c8 CHK-002: finding_cluster handler — 自动聚簇 findings + 手动 merge/split。
 *
 * 三种模式（以 merge / split 参数区分）：
 *   - 默认：跑 clusterFindings 重算全量 cluster，回写 findings.clusterId + clusters.json
 *   - merge: string[]（finding id 列表）→ 强制合为新簇，不动其他簇
 *   - split: string（clusterId）→ 删除该簇，成员 finding.clusterId 清空（singleton）
 *
 * 幂等：默认模式同一输入多次运行产生同一 ClusterRecord 排序（clusterFindings 内部稳定排序）。
 * CHK-005 将扩展 commit Resolves: CL-xxx 自动解析；本 CHK 不涉及。
 */

import type { HandlerContext } from './context.js';
import type { Finding } from '../core/types.js';
import type { ClusterRecord } from '../core/cluster-types.js';
import { clusterFindings, forceMergeCluster } from '../core/cluster-compute.js';

export function createClusterHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    finding_cluster(args: { storyId: string; merge?: string[] | string; split?: string }): string {
      if (args.merge && args.split) {
        throw new Error('finding_cluster 不能同时传 merge 和 split');
      }

      const findingsData = store.readFindings(args.storyId);
      const findings = findingsData.findings;

      if (args.split) {
        return handleSplit(args.storyId, args.split, findings, store);
      }
      if (args.merge) {
        // F-013: 支持 CLI 逗号分隔（--merge=F-001,F-002）；数组形式直接透传。
        const mergeIds = Array.isArray(args.merge)
          ? args.merge
          : args.merge.split(',').map(s => s.trim()).filter(Boolean);
        return handleMerge(args.storyId, mergeIds, findings, store);
      }
      return handleDefault(args.storyId, findings, store);
    },

    /**
     * B-e8c8 CHK-004: finding_dispatch — 生成 implementer prompt 文本。
     *
     * 与 B-45ed story_dispatch 对称：输出包含 background.md 引用，让 implementer
     * 理解 cluster 背后的业务动机而非只看 finding 条目。commit 约定 `Resolves: CL-xxx`
     * 由 CHK-005 的 cluster-sync 扫描自动解析并 resolve 全簇。
     */
    finding_dispatch(args: { storyId: string; clusterId: string }): string {
      const { storyId, clusterId } = args;
      const clustersData = store.readClusters(storyId);
      const cluster = clustersData.clusters.find(c => c.clusterId === clusterId);
      if (!cluster) {
        throw new Error(`Cluster ${clusterId} not found in ${storyId}`);
      }

      const findingsData = store.readFindings(storyId);
      const memberIds = new Set(cluster.findingIds);
      const members = findingsData.findings.filter(f => memberIds.has(f.id));

      return renderDispatchPrompt(store.storyDirRel(), storyId, cluster, members);
    },
  };
}

function handleDefault(
  storyId: string,
  findings: Finding[],
  store: HandlerContext['store']
): string {
  // F-012: 保留已存在的 cluster，避免重新编号后与已 commit "Resolves: CL-001" 历史引用冲突。
  // existingClusters 非空 → clusterFindings 只对未归属 finding 新建 cluster，新编号从 max(existing)+1 起。
  const existing = store.readClusters(storyId).clusters;
  const clusters = clusterFindings(findings, new Date().toISOString(), existing);

  // 写回 finding.clusterId（clusterId 归属以新计算结果为准；未参与任一簇 = 清空）
  const byId = new Map<string, string>();
  for (const c of clusters) {
    for (const fid of c.findingIds) byId.set(fid, c.clusterId);
  }
  for (const f of findings) {
    const cid = byId.get(f.id);
    if (cid) f.clusterId = cid;
    else delete f.clusterId;
  }

  store.writeFindings(storyId, { findings });
  store.writeClusters(storyId, { clusters });

  return renderSummary(findings.length, clusters);
}

function handleMerge(
  storyId: string,
  mergeIds: string[],
  findings: Finding[],
  store: HandlerContext['store']
): string {
  const clustersData = store.readClusters(storyId);
  const existing = clustersData.clusters;
  const newCluster = forceMergeCluster(existing, findings, mergeIds);

  // 从现有簇里移除被 merge 的 finding（防重复归属）
  const mergeSet = new Set(mergeIds);
  const remaining: ClusterRecord[] = [];
  for (const c of existing) {
    const kept = c.findingIds.filter(id => !mergeSet.has(id));
    if (kept.length === c.findingIds.length) {
      remaining.push(c);
    } else if (kept.length > 0) {
      remaining.push({
        ...c,
        findingIds: kept,
        files: recomputeFilesUnion(kept, findings),
      });
    }
    // kept.length === 0 → 整簇已被 merge，丢弃
  }

  const updated = [...remaining, newCluster];
  // 更新 finding.clusterId
  for (const f of findings) {
    if (mergeSet.has(f.id)) f.clusterId = newCluster.clusterId;
  }
  store.writeFindings(storyId, { findings });
  store.writeClusters(storyId, { clusters: updated });

  return `Force-merged ${mergeIds.length} findings into ${newCluster.clusterId} (${newCluster.severity}, files: ${newCluster.files.join(', ') || 'none'})`;
}

function handleSplit(
  storyId: string,
  clusterId: string,
  findings: Finding[],
  store: HandlerContext['store']
): string {
  const clustersData = store.readClusters(storyId);
  const target = clustersData.clusters.find(c => c.clusterId === clusterId);
  if (!target) {
    throw new Error(`Cluster ${clusterId} 不存在`);
  }
  const memberSet = new Set(target.findingIds);
  for (const f of findings) {
    if (memberSet.has(f.id)) delete f.clusterId;
  }
  const remaining = clustersData.clusters.filter(c => c.clusterId !== clusterId);
  store.writeFindings(storyId, { findings });
  store.writeClusters(storyId, { clusters: remaining });
  return `Split cluster ${clusterId}: ${memberSet.size} findings back to singleton`;
}

function recomputeFilesUnion(findingIds: string[], findings: Finding[]): string[] {
  const byId = new Map(findings.map(f => [f.id, f]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of findingIds) {
    const f = byId.get(id);
    if (!f?.files) continue;
    for (const p of f.files) {
      if (!seen.has(p)) { seen.add(p); out.push(p); }
    }
  }
  return out;
}

function renderDispatchPrompt(
  storyDirRel: string,
  storyId: string,
  cluster: ClusterRecord,
  members: Finding[]
): string {
  const lines: string[] = [];
  lines.push(`# Implementer task: Resolve cluster ${cluster.clusterId} (${cluster.rootCause})`);
  lines.push('');
  lines.push(`**Story**: ${storyId}`);
  lines.push(`**Must read first**: ${storyDirRel}/${storyId}/background.md`);
  lines.push('');
  lines.push(`## Findings in this cluster (${members.length})`);
  lines.push('');
  if (members.length === 0) {
    lines.push('_(no findings currently resolved to members — cluster may be stale; re-run `finding_cluster` to refresh)_');
  } else {
    for (const f of members) {
      const filesPart = f.files && f.files.length > 0 ? ` (files: ${f.files.join(', ')})` : '';
      lines.push(`- ${f.id} [${f.severity}/${f.category}] ${f.desc}${filesPart}`);
    }
  }
  lines.push('');
  lines.push('## Files touched');
  lines.push('');
  if (cluster.files.length === 0) {
    lines.push('_(no files declared on member findings — infer from background.md + finding descriptions)_');
  } else {
    for (const p of cluster.files) lines.push(`- ${p}`);
  }
  lines.push('');
  lines.push('## Commit requirement');
  lines.push('');
  lines.push('Your commit message MUST include a line:');
  lines.push('');
  lines.push(`    Resolves: ${cluster.clusterId}`);
  lines.push('');
  lines.push('(koala validate / finding_list auto-resolve the cluster via this marker.)');
  return lines.join('\n');
}

function renderSummary(totalFindings: number, clusters: ClusterRecord[]): string {
  // F-028: 无 finding 时输出 "No findings to cluster"，避免 "Clustered 0 findings into 0 clusters" 歧义。
  if (totalFindings === 0) {
    return `No findings to cluster`;
  }
  if (clusters.length === 0) {
    return `Clustered 0 findings into 0 clusters`;
  }
  const segments = clusters.map(c => {
    const filesPart = c.files.length === 0
      ? 'no files'
      : c.files.length <= 3
        ? c.files.join(', ')
        : `${c.files.slice(0, 1).join(', ')}+${c.files.length - 1}`;
    return `${c.clusterId} (${c.rootCause}, ${c.findingIds.length} findings, ${c.severity}, ${filesPart})`;
  });
  return `Clustered ${totalFindings} findings into ${clusters.length} clusters: ${segments.join(', ')}`;
}
