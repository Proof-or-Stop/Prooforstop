/**
 * B-e8c8 CHK-001: Finding cluster 数据模型（Data 原子）
 *
 * Cluster = 多条 finding 根因相同、能被一次改动同时解决的归并单元。
 * 存储位置：docs/story/actives/<storyId>/clusters.json
 *
 * 聚簇依据是"一次改动能不能同时解决"，不是描述关键词相似。
 * 详见 background.md "方案取舍" 段与 plan.md CHK-002。
 *
 * 本文件只定义类型，不含函数（遵循 data.ts 范式）。聚簇算法在 cluster-compute.ts（CHK-002）。
 */

import type { Finding } from './types.js';

export interface ClusterRecord {
  /** 簇 ID，格式 CL-001、CL-002……（story 内唯一，从 001 递增） */
  clusterId: string;
  /** 根因描述；首轮聚簇可留 "<待主 agent 填写>"，由后续 cluster_update 填实 */
  rootCause: string;
  /** 簇内所有 finding 的 id 列表（全量 Finding.id，不只是编号） */
  findingIds: string[];
  /** 簇涉及的文件路径去重并集（来自簇内每条 finding 的 files 字段） */
  files: string[];
  /** 簇内 finding 共享的 severity（合并规则要求 severity 完全一致） */
  severity: Finding['severity'];
  /** 创建时间 ISO8601 */
  createdAt: string;
  /** 可选签名，保留给后续 cluster 生成流程（CHK-002+）使用；CHK-001 不强制 */
  _hash?: string;
}

export interface ClusterData {
  clusters: ClusterRecord[];
}
