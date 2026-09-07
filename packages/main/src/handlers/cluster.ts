/**
 * B-e8c8 CHK-002: finding_cluster handler — auto-cluster findings + manual merge/split.
 *
 * Three modes (distinguished by merge / split parameter):
 *   - Default: run clusterFindings to recompute all clusters, write back findings.clusterId + clusters.json
 *   - merge: string[] (list of finding ids) → force merge into a new cluster, leave other clusters untouched
 *   - split: string (clusterId) → delete the cluster, clear member finding.clusterId (singleton)
 *
 * Idempotent: in default mode, the same input run multiple times produces the same ClusterRecord ordering (clusterFindings has stable internal sorting).
 * CHK-005 will extend commit Resolves: CL-xxx auto-parsing; not covered in this CHK.
 */

import type { HandlerContext } from './context.js';
import type { Finding } from '../core/types.js';
import type { ClusterRecord } from '../core/cluster-types.js';
import { clusterFindings, forceMergeCluster } from '../core/cluster-compute.js';
import { createAuthoritativeFindingMutation } from './finding-ledger.js';

export function createClusterHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  const authoritativeMutation = createAuthoritativeFindingMutation(ctx);
  return {
    finding_cluster(args: { storyId: string; merge?: string[] | string; split?: string }): string {
      if (args.merge && args.split) {
        throw new Error('finding_cluster cannot pass both merge and split');
      }

      if (args.split) {
        return authoritativeMutation(args.storyId, `cluster-split:${args.split}`, (data) => ({
          result: handleSplit(args.storyId, args.split!, data.findings, store),
        }));
      }
      if (args.merge) {
        // F-013: support CLI comma-separated (--merge=F-001,F-002); array form is passed through directly.
        const mergeIds = Array.isArray(args.merge)
          ? args.merge
          : args.merge.split(',').map(s => s.trim()).filter(Boolean);
        return authoritativeMutation(args.storyId, `cluster-merge:${mergeIds.slice().sort().join(',')}`, (data) => ({
          result: handleMerge(args.storyId, mergeIds, data.findings, store),
        }));
      }
      return authoritativeMutation(args.storyId, 'cluster-default', (data) => ({
        result: handleDefault(args.storyId, data.findings, store),
      }));
    },

    /**
     * B-e8c8 CHK-004: finding_dispatch — generate implementer prompt text.
     *
     * Symmetric to B-45ed story_dispatch: output includes a background.md reference, letting the implementer
     * understand the business motivation behind the cluster rather than only seeing finding entries. The commit convention `Resolves: CL-xxx`
     * is auto-parsed by CHK-005's cluster-sync scan to resolve the whole cluster.
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
  // F-012: preserve existing clusters to avoid conflicts with already-committed "Resolves: CL-001" historical references after renumbering.
  // existingClusters non-empty → clusterFindings only creates new clusters for unassigned findings, with new numbering starting from max(existing)+1.
  const existing = store.readClusters(storyId).clusters;
  const clusters = clusterFindings(findings, new Date().toISOString(), existing);

  // Write back finding.clusterId (clusterId assignment follows the newly computed result; not participating in any cluster = cleared)
  const byId = new Map<string, string>();
  for (const c of clusters) {
    for (const fid of c.findingIds) byId.set(fid, c.clusterId);
  }
  for (const f of findings) {
    const cid = byId.get(f.id);
    if (cid) f.clusterId = cid;
    else delete f.clusterId;
  }

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

  // Remove merged findings from existing clusters (prevent duplicate assignment)
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
    // kept.length === 0 → entire cluster has been merged, discard
  }

  const updated = [...remaining, newCluster];
  // Update finding.clusterId
  for (const f of findings) {
    if (mergeSet.has(f.id)) f.clusterId = newCluster.clusterId;
  }
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
    throw new Error(`Cluster ${clusterId} does not exist`);
  }
  const memberSet = new Set(target.findingIds);
  for (const f of findings) {
    if (memberSet.has(f.id)) delete f.clusterId;
  }
  const remaining = clustersData.clusters.filter(c => c.clusterId !== clusterId);
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
  lines.push('(proof-or-stop validate / finding_list auto-resolve the cluster via this marker.)');
  return lines.join('\n');
}

function renderSummary(totalFindings: number, clusters: ClusterRecord[]): string {
  // F-028: When there are no findings, output "No findings to cluster" to avoid the ambiguity of "Clustered 0 findings into 0 clusters".
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
