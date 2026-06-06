/**
 * B-e8c8 CHK-001: Finding cluster data model (Data atom)
 *
 * Cluster = a merging unit where multiple findings share the same root cause and can be resolved by a single change.
 * Storage location: docs/story/actives/<storyId>/clusters.json
 *
 * Clustering is based on "whether a single change can resolve them together", not on description keyword similarity.
 * See background.md "Solution Trade-offs" section and plan.md CHK-002 for details.
 *
 * This file only defines types, no functions (following the data.ts paradigm). The clustering algorithm is in cluster-compute.ts (CHK-002).
 */

import type { Finding } from './types.js';

export interface ClusterRecord {
  /** Cluster ID, format CL-001, CL-002... (unique within a story, incrementing from 001) */
  clusterId: string;
  /** Root cause description; the first round of clustering may leave "<to be filled by main agent>", to be filled in by subsequent cluster_update */
  rootCause: string;
  /** List of all finding ids in the cluster (full Finding.id, not just the number) */
  findingIds: string[];
  /** Deduplicated union of file paths involved in the cluster (from the files field of each finding in the cluster) */
  files: string[];
  /** Severity shared by findings in the cluster (the merging rule requires severity to be exactly consistent) */
  severity: Finding['severity'];
  /** Creation time ISO8601 */
  createdAt: string;
  /** Optional signature, reserved for subsequent cluster generation flow (CHK-002+); not enforced in CHK-001 */
  _hash?: string;
}

export interface ClusterData {
  clusters: ClusterRecord[];
}
