/**
 * Finding handlers — reviewer 发现项管理（带签名防伪造）
 */

import { mkdirSync, rmSync, statSync } from 'fs';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import type { Finding } from '../core/types.js';
import { signFinding, signReviewPass } from '../core/finding-verify.js';
import { computeProcessMetrics } from '../core/process-metrics.js';
import { syncClusterResolves } from '../core/cluster-sync.js';
import { isPassOnlyReviewFindingRecord } from '../core/flow-fact-policy.js';

const CANONICAL_FINDING_CATEGORIES = ['happy', 'edge', 'adversarial', 'missing'] as const;
const LEGACY_FINDING_CATEGORIES = ['cleanup', 'doc-promise-undelivered', 'doc-code-drift', 'spec-boundary'] as const;
const KNOWN_FINDING_CATEGORIES = new Set<string>([
  ...CANONICAL_FINDING_CATEGORIES,
  ...LEGACY_FINDING_CATEGORIES,
]);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withReviewPassLock<T>(ctx: HandlerContext, storyId: string, fn: () => T): T {
  const lockDir = ctx.store.storyFilePath(storyId, 'review-passes.lock');
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (e: any) {
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > 10000) rmSync(lockDir, { recursive: true, force: true });
      } catch { /* PROBE: lock disappeared between mkdir attempts */ }
      if (Date.now() > deadline) {
        throw new Error(`review_pass_set: timed out waiting for metadata lock (${e?.message || e})`);
      }
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function normalizeFindingForList(finding: Finding): Finding {
  if (finding.status !== 'open' || !isPassOnlyReviewFindingRecord(finding)) return finding;
  return {
    ...finding,
    status: 'resolved',
    resolvedReason: 'read-only view: reviewer registered no blocking issue placeholder',
  };
}

function normalizeFindingCategory(category: string): Finding['category'] {
  if (!KNOWN_FINDING_CATEGORIES.has(category)) {
    throw new Error(
      `finding_add: category must be one of ${CANONICAL_FINDING_CATEGORIES.join('|')} ` +
      `(legacy compatibility: ${LEGACY_FINDING_CATEGORIES.join('|')})`,
    );
  }
  if ((LEGACY_FINDING_CATEGORIES as readonly string[]).includes(category)) {
    return 'missing';
  }
  return category as Finding['category'];
}

function recordReviewPass(ctx: HandlerContext, storyId: string, agent: string, note: string): string {
  return withReviewPassLock(ctx, storyId, () => {
    const story = ctx.store.readStory(storyId);
    const data = ctx.store.readReviewPasses(storyId);
    const nextNum = data.passes.reduce((max, pass) => {
      const m = pass.id.match(/:RP-(\d+)$/);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0) + 1;
    const id = `${storyId}:RP-${String(nextNum).padStart(3, '0')}`;
    if (data.passes.some(pass => pass.id === id)) {
      throw new Error(`review_pass_set: duplicate review pass id ${id}; refusing to report success`);
    }
    const createdAt = new Date().toISOString();
    const reviewRound = story.currentReviewRound || '';
    const trimmedNote = note.trim();
    const pass = {
      id,
      agent,
      note: trimmedNote,
      createdAt,
      reviewRound,
      _hash: signReviewPass(storyId, id, agent, trimmedNote, createdAt, reviewRound),
    };
    data.passes.push(pass);
    ctx.store.writeReviewPasses(storyId, data);
    const persisted = ctx.store.readReviewPasses(storyId);
    const persistedPass = persisted.passes.find(p => p.id === id);
    if (!persistedPass || persistedPass._hash !== pass._hash || persistedPass.agent !== agent) {
      throw new Error(`review_pass_set: ${id} was not durably persisted; refusing to report success`);
    }
    try {
      ctx.store.appendProcessEvent(storyId, {
        type: 'review_pass',
        storyId,
        command: 'review_pass_set',
        role: 'reviewer',
        agent,
        result: 'pass',
        reviewPassId: id,
      });
    } catch (e) {
      console.warn(`[process-events] append failed for ${storyId}:`, (e as Error).message);
    }
    return `Review pass ${id} recorded by ${agent}`;
  });
}

export function createFindingHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    finding_add(args: { storyId: string; desc: string; severity: string; category: string; agent?: string; files?: string[] }): string {
      assertCwdInWorktree(store, args.storyId);

      // 记录调用者身份（环境变量 KOALA_AGENT 由 subagent 设置）
      const missingAttribution = !args.agent && !process.env.KOALA_AGENT;
      const agent = args.agent || process.env.KOALA_AGENT || 'main';

      if (isPassOnlyReviewFindingRecord({ desc: args.desc, severity: args.severity, agent })) {
        return recordReviewPass(ctx, args.storyId, agent, `Converted pass-only finding_add record: ${args.desc}`);
      }
      const category = normalizeFindingCategory(args.category);

      const data = store.readFindings(args.storyId);
      const nextNum = data.findings.length + 1;
      const id = `${args.storyId}:F-${String(nextNum).padStart(3, '0')}`;
      const timestamp = new Date().toISOString();

      // 自动注入当前 review round（reviewer 无需传参）
      const story = store.readStory(args.storyId);
      const reviewRound = story.currentReviewRound || '';

      const finding: Finding = {
        id,
        desc: args.desc,
        severity: args.severity as 'critical' | 'high' | 'medium' | 'low',
        category: category as Finding["category"],
        status: 'open',
        agent,
        createdAt: timestamp,
        reviewRound,
        _hash: signFinding(args.storyId, id, args.desc, args.severity, timestamp, reviewRound),
        ...(args.files && args.files.length > 0 ? { files: args.files } : {}),
      };
      data.findings.push(finding);
      store.writeFindings(args.storyId, data);

      try {
        store.appendProcessEvent(args.storyId, {
          type: 'reviewer_finding',
          storyId: args.storyId,
          command: 'finding_add',
          role: agent.startsWith('koala-review-') ? 'reviewer' : 'main',
          agent,
          result: 'pass',
          findingId: id,
          severity: args.severity,
          missingAttribution,
          hardWarning: missingAttribution
            ? 'finding_add called without agent/KOALA_AGENT; recorded as main and REVIEW/TEST gates may reject it'
            : undefined,
        });
      } catch (e) {
        console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
      }

      // B-abd8: auto-recompute process metrics
      try {
        const pm = computeProcessMetrics(args.storyId, store, ctx.root);
        store.writeProcessMetrics(args.storyId, pm);
      } catch (e) {
        console.warn(`[process-metrics] recompute failed for ${args.storyId}:`, (e as Error).message);
      }

      const warning = missingAttribution
        ? '\n⚠ finding_add 缺少 agent/KOALA_AGENT，已记录为 main；reviewer 必须传 agent="koala-review-*"，否则不会算 reviewer evidence。'
        : '';
      return `Finding ${id} created by ${agent}: [${args.severity}/${category}] ${args.desc}${warning}`;
    },

    review_pass_set(args: { storyId: string; agent?: string; note: string }): string {
      if (!args.note || args.note.trim().length < 10) {
        throw new Error('review_pass_set: note 必须 ≥ 10 字符，说明 reviewer 检查了什么以及为什么无 blocker');
      }
      const agent = args.agent || process.env.KOALA_AGENT || 'main';
      if (!agent.startsWith('koala-review-')) {
        throw new Error('review_pass_set: agent 必须是 koala-review-* reviewer');
      }
      assertCwdInWorktree(store, args.storyId);
      return recordReviewPass(ctx, args.storyId, agent, args.note);
    },

    finding_list(args: { storyId: string; cluster?: boolean }) {
      assertCwdInWorktree(store, args.storyId);
      const synced = syncClusterResolves(args.storyId, store, ctx.root, ctx.log);
      if (synced.resolved > 0) {
        ctx.log?.(`cluster-sync: auto-resolved ${synced.resolved} finding(s) before finding_list`);
      }
      // B-9d95 CHK-005: cluster 视图 — 读 clusters.json + findings.json，按簇归类 + 未归簇列表。
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
      assertCwdInWorktree(store, args.storyId);
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
      assertCwdInWorktree(store, args.storyId);
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
