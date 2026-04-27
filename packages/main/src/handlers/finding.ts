/**
 * Finding handlers — reviewer 发现项管理（带签名防伪造）
 */

import type { HandlerContext } from './context.js';
import type { Finding } from '../core/types.js';
import { signFinding } from '../core/finding-verify.js';
import { computeProcessMetrics } from '../core/process-metrics.js';

function isNoBlockingIssuePlaceholder(finding: Pick<Finding, 'desc' | 'severity' | 'agent'>): boolean {
  if (finding.severity !== 'low') return false;
  if (!finding.agent || !finding.agent.startsWith('koala-review-')) return false;
  return /\b(no blocking issues?|no blocking issue found|no blockers?|0 blocking)\b/i.test(finding.desc);
}

function normalizeFindingForList(finding: Finding): Finding {
  if (finding.status !== 'open' || !isNoBlockingIssuePlaceholder(finding)) return finding;
  return {
    ...finding,
    status: 'resolved',
    resolvedReason: 'read-only view: reviewer registered no blocking issue placeholder',
  };
}

export function createFindingHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    finding_add(args: { storyId: string; desc: string; severity: string; category: string; agent?: string; files?: string[] }): string {
      const data = store.readFindings(args.storyId);
      const nextNum = data.findings.length + 1;
      const id = `${args.storyId}:F-${String(nextNum).padStart(3, '0')}`;
      const timestamp = new Date().toISOString();

      // 记录调用者身份（环境变量 KOALA_AGENT 由 subagent 设置）
      const agent = args.agent || process.env.KOALA_AGENT || 'main';

      // 自动注入当前 review round（reviewer 无需传参）
      const story = store.readStory(args.storyId);
      const reviewRound = story.currentReviewRound || '';

      const finding: Finding = {
        id,
        desc: args.desc,
        severity: args.severity as 'critical' | 'high' | 'medium' | 'low',
        category: args.category as Finding["category"],
        status: isNoBlockingIssuePlaceholder({ desc: args.desc, severity: args.severity as Finding['severity'], agent })
          ? 'resolved' as const
          : 'open' as const,
        agent,
        createdAt: timestamp,
        reviewRound,
        _hash: signFinding(args.storyId, id, args.desc, args.severity, timestamp, reviewRound),
        ...(args.files && args.files.length > 0 ? { files: args.files } : {}),
      };
      data.findings.push(finding);
      store.writeFindings(args.storyId, data);

      // B-abd8: auto-recompute process metrics
      try {
        const pm = computeProcessMetrics(args.storyId, store, ctx.root);
        store.writeProcessMetrics(args.storyId, pm);
      } catch (e) {
        console.warn(`[process-metrics] recompute failed for ${args.storyId}:`, (e as Error).message);
      }

      return `Finding ${id} created by ${agent}: [${args.severity}/${args.category}] ${args.desc}`;
    },

    finding_list(args: { storyId: string; cluster?: boolean }) {
      // B-9d95 CHK-005: cluster 视图 — 读 clusters.json + findings.json，按簇归类 + 未归簇列表。
      // Phase-2 TODO：commit-auto-resolve（cluster-sync.ts 的 syncClusterResolves）此处尚未串上；
      //   现阶段只做静态视图聚合，不扫 git log，避免在 finding_list 路径引入 execSync 开销。
      if (args.cluster) {
        const findingsData = store.readFindings(args.storyId);
        const clustersData = store.readClusters(args.storyId);
        const clusters = clustersData.clusters.map(c => ({
          clusterId: c.clusterId,
          rootCause: c.rootCause,
          findingCount: c.findingIds.length,
          severity: c.severity,
          files: c.files,
          findingIds: c.findingIds,
        }));
        const grouped = new Set<string>();
        for (const c of clustersData.clusters) {
          for (const fid of c.findingIds) grouped.add(fid);
        }
        const ungrouped = findingsData.findings.filter(f => !grouped.has(f.id)).map(normalizeFindingForList);
        return { clusters, ungrouped };
      }
      const data = store.readFindings(args.storyId);
      return { ...data, findings: data.findings.map(normalizeFindingForList) };
    },

    finding_resolve(args: { storyId: string; findingId: string }): string {
      const data = store.readFindings(args.storyId);
      const f = data.findings.find(f => f.id === args.findingId);
      if (!f) throw new Error(`Finding ${args.findingId} not found`);
      f.status = 'resolved';
      store.writeFindings(args.storyId, data);

      // B-abd8: auto-recompute process metrics
      try {
        const pm = computeProcessMetrics(args.storyId, store, ctx.root);
        store.writeProcessMetrics(args.storyId, pm);
      } catch (e) {
        console.warn(`[process-metrics] recompute failed for ${args.storyId}:`, (e as Error).message);
      }

      return `Finding ${args.findingId} resolved`;
    },

    finding_dismiss(args: { storyId: string; findingId: string; reason: string }): string {
      if (!args.reason || args.reason.trim().length < 10) {
        throw new Error('finding_dismiss: reason 必须 ≥ 10 字符，说清楚为什么不修');
      }
      const data = store.readFindings(args.storyId);
      const f = data.findings.find(f => f.id === args.findingId);
      if (!f) throw new Error(`Finding ${args.findingId} not found`);

      if (f.status === 'resolved') {
        return `Finding ${args.findingId} 已经 resolved，不需要 dismiss`;
      }
      // B-0f47: critical finding 不允许 dismiss（放在 resolved 检查之后）
      if (f.severity === 'critical') {
        throw new Error(`critical finding 不允许 dismiss，任何轮次都必须修复。Finding: ${args.findingId}`);
      }
      f.status = 'dismissed';
      f.dismissReason = args.reason.trim();
      f.dismissedAt = new Date().toISOString();
      store.writeFindings(args.storyId, data);

      // B-abd8: auto-recompute process metrics
      try {
        const pm = computeProcessMetrics(args.storyId, store, ctx.root);
        store.writeProcessMetrics(args.storyId, pm);
      } catch (e) {
        console.warn(`[process-metrics] recompute failed for ${args.storyId}:`, (e as Error).message);
      }

      return `Finding ${args.findingId} dismissed: ${args.reason.trim()}`;
    },
  };
}
