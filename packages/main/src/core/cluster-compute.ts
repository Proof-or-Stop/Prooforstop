/**
 * B-e8c8 CHK-002 / CHK-009: pure function clusterFindings — merge by (files intersection ratio ≥50% + matching severity).
 *
 * Clustering rules (CHK-009 tightened version, replacing CHK-002's "intersection ≥ 1"):
 *   - Two findings belong to the same cluster ⇔ severity is equal AND |files_a ∩ files_b| / max(|files_a|,|files_b|) ≥ 0.5
 *   - Both sides' files sets must be non-empty to consider merging (empty side falls back to singleton)
 *   - Do not merge across severity (consistent with background.md insight 3: one change can resolve all together rather than keyword similarity; F-037 timing bug should not be merged into MAX_SEATS cluster)
 *
 * CHK-009 regex fallback:
 *   - When finding.files is empty/missing, extract paths from finding.desc using DESC_PATH_REGEX as "effective files"
 *     for cluster determination. **Do not write back to finding.files** (original is read-only, signature scope unchanged).
 *   - No extraction results → still treated as singleton
 *
 * CHK-009 rootCause auto-generation:
 *   - Single-member cluster: keep placeholder "<to be filled by main agent>"
 *   - Multi-member cluster: rootCause = "Multiple findings all involve <top N shared files>" (F-034 adds "all" to align with userSees)
 *     - top shared = top 2 of files common to all members (intersection)
 *     - When intersection is empty, fall back to top 2 of union
 *
 * Idempotency guarantee: sort by finding.id ascending then use union-find to merge;
 *   multiple invocations on the same batch of findings output identical clusterId and member ordering.
 *
 * This file follows the fn.ts paradigm: pure functions, no side effects, no I/O.
 */

import type { Finding } from './types.js';
import type { ClusterRecord } from './cluster-types.js';

const CLUSTER_PLACEHOLDER_ROOT_CAUSE = '<to be filled by main agent>';
const CLUSTER_OVERLAP_THRESHOLD = 0.5;

/**
 * CHK-009: Fallback extraction of file paths from finding.desc.
 *
 * Matches four kinds of paths:
 *   - `packages/<path>` / `src/<path>` / `docs/<path>` / `tests/<path>` (relative paths with directory prefix)
 *   - `CLAUDE.md` (common top-level documentation)
 *   - any token containing common code/doc extensions (.ts/.tsx/.js/.jsx/.md/.json)
 *
 * Exported for reuse by other handlers (such as future cluster_update).
 */
const DESC_PATH_REGEX = /(packages\/[\w./-]+|src\/[\w./-]+|docs\/[\w./-]+|tests\/[\w./-]+|CLAUDE\.md|[\w./-]+\.(?:ts|tsx|js|jsx|md|json))/g;

export function extractFilesFromDesc(desc: string): string[] {
  if (!desc) return [];
  const matches = desc.match(DESC_PATH_REGEX);
  if (!matches) return [];
  return dedupStable(matches);
}

/** Get effective files: prefer finding.files, otherwise fall back to extracting from desc; used for cluster determination, **does not mutate the finding original**. */
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
 * Cluster findings into ClusterRecord[].
 *
 * @param findings input finding list (may contain mixed files/severity/status)
 * @param now creation time (injectable test clock); defaults to new Date().toISOString()
 * @param existingClusters optional: list of already-existing clusters. When provided:
 *   - **preserves** these clusters (no overwrite, no renaming), new clusters are numbered starting from max(existingId)+1;
 *   - findings already in existingClusters.findingIds **do not participate** in this re-clustering (treated as already assigned);
 *   - return value = existingClusters (preserved as-is) + newly computed clusters for the remaining findings.
 *   When omitted, behavior matches the old version: ignore historical state, recompute everything from CL-001.
 *
 * F-012: introduced existingClusters to avoid id collisions with existing "Resolves: CL-001" commit references.
 *
 * @returns stably sorted cluster list (existingClusters first, new clusters assigned afterwards in increasing CL-xxx order)
 */
export function clusterFindings(
  findings: readonly Finding[],
  now: string = new Date().toISOString(),
  existingClusters?: readonly ClusterRecord[],
): ClusterRecord[] {
  // F-012: preprocess existingClusters — extract max id and the set of already-assigned findings
  const preserved: ClusterRecord[] = existingClusters ? existingClusters.map(c => ({ ...c })) : [];
  const existingMaxId = preserved.reduce((m, c) => {
    const match = c.clusterId.match(/^CL-(\d+)$/);
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  const claimedIds = new Set<string>();
  for (const c of preserved) for (const fid of c.findingIds) claimedIds.add(fid);

  // Skip already-assigned findings — they do not participate in this re-clustering
  const remaining = findings.filter(f => !claimedIds.has(f.id));

  // Stable sort: by finding.id lexicographic order, so that the union-find input order is deterministic.
  const sorted = [...remaining].sort((a, b) => a.id.localeCompare(b.id));
  const n = sorted.length;
  if (n === 0) return preserved;

  // Precompute effective files (one-shot, avoids repeated desc scanning)
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
    // Smaller id as root, ensuring idempotency and readability
    if (ra < rb) parent[rb] = ra; else parent[ra] = rb;
  };

  for (let i = 0; i < n; i++) {
    const fi = sorted[i];
    const efi = effective[i];
    if (efi.length === 0) continue; // singletons with both sides empty don't participate in merging
    for (let j = i + 1; j < n; j++) {
      const fj = sorted[j];
      const efj = effective[j];
      if (efj.length === 0) continue;
      if (fi.severity !== fj.severity) continue;
      if (overlapRatio(efi, efj) >= CLUSTER_OVERLAP_THRESHOLD) union(i, j);
    }
  }

  // Group by root (the first appearance order of root determines CL-xxx numbering)
  const rootOrder: number[] = [];
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); rootOrder.push(r); }
    g.push(i);
  }

  // F-012: New clusters are numbered starting from existingMaxId+1 to avoid conflicting with historical numbers referenced by already-committed Resolves: CL-xxx.
  // F-030: padStart(3) keeps a minimum width of 3 digits; CL-1000+ 4 digits naturally matches /CL-\d{3,}/.
  const clusters: ClusterRecord[] = [...preserved];
  rootOrder.forEach((root, idx) => {
    const memberIdxs = groups.get(root)!;
    const members = memberIdxs.map(i => sorted[i]);
    // files is based on the original finding.files (don't pollute cluster.files with desc fallback paths)
    // If all members rely on the fallback, then cluster.files takes the fallback union, ensuring cluster.files is non-empty to reflect the clustering basis.
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
 * Compute automatic rootCause based on member effective-files.
 * - Single member → placeholder (original CHK-002 behavior)
 * - Multiple members → take the first 2 from the intersection of all members' files; empty intersection falls back to the first 2 of the union
 */
function computeAutoRootCause(memberFiles: string[][]): string {
  if (memberFiles.length < 2) return CLUSTER_PLACEHOLDER_ROOT_CAUSE;

  // Compute the intersection of all members' files (shared by all)
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
  // F-034: Wording aligned with CHK-009 userSees "multiple findings all involve" (adding "all").
  return `Multiple findings all involve ${top.join(', ')}`;
}

/**
 * Force-merge the specified finding ids into a new cluster (used by finding_cluster --merge).
 * Preconditions: ids non-empty, all exist, severity consistent.
 * Returns the new cluster + the remaining clusters with these findings removed (remaining clusters retain their original clusterId).
 */
export function forceMergeCluster(
  existing: ClusterRecord[],
  allFindings: readonly Finding[],
  mergeIds: readonly string[],
  now: string = new Date().toISOString()
): ClusterRecord {
  if (!mergeIds || mergeIds.length < 2) {
    throw new Error('finding_cluster --merge requires at least 2 finding ids');
  }
  const byId = new Map(allFindings.map(f => [f.id, f]));
  const members: Finding[] = [];
  for (const id of mergeIds) {
    const f = byId.get(id);
    if (!f) throw new Error(`finding ${id} does not exist`);
    members.push(f);
  }
  const sev = members[0].severity;
  if (members.some(m => m.severity !== sev)) {
    throw new Error(
      `finding_cluster --merge requires consistent severity, currently mixed: ${members.map(m => `${m.id}=${m.severity}`).join(', ')}`
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
