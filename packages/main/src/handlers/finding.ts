/**
 * Finding handlers — reviewer 发现项管理（带签名防伪造）
 */

import { mkdirSync, rmSync, statSync } from 'fs';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import type { DisprovenEvidence, Finding, FindingEvidenceState } from '../core/types.js';
import { isFindingEvidenceState, FINDING_EVIDENCE_STATES } from '../core/advisory.js';
import { signFinding, signReviewPass } from '../core/finding-verify.js';
import { computeProcessMetrics } from '../core/process-metrics.js';
import { syncClusterResolves } from '../core/cluster-sync.js';
import { isPassOnlyReviewFindingRecord } from '../core/flow-fact-policy.js';
import { assertCurrentReviewRunForEvidence, resolveReviewRunLane } from '../core/review-run.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';

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

/**
 * B-3fad CHK-001: 解析 finding_add 的 evidenceState 输入并做 runtime 校验 + guard。
 *
 * 默认表（plan.md#CHK-001）：
 * - 未传 evidenceState → 默认 'verified'（reviewer 在 REVIEW 阶段提的 finding；保持现有 gate 行为）。
 * - 显式 'suspected' → 必须带 uncertaintyReason（≥10 字符），缺则报错（防止把 suspected 当绕 gate 按钮）。
 * - 显式 'disproven' → 必须带 disprovenEvidence.summary（≥10 字符），缺则报错（disproven 必须带反证）。
 * - 非法字符串 → 报错（不只靠 Zod，runtime 同标准校验，见 CLAUDE.md「Handler 编码约定」）。
 */
function resolveEvidenceState(args: {
  evidenceState?: string;
  uncertaintyReason?: string;
  disprovenEvidence?: DisprovenEvidence;
}): {
  evidenceState: FindingEvidenceState;
  uncertaintyReason?: string;
  disprovenEvidence?: DisprovenEvidence;
} {
  const raw = args.evidenceState;
  // 默认 verified（reviewer REVIEW 阶段 finding_add）
  if (raw === undefined || raw === null || raw === '') {
    return { evidenceState: 'verified' };
  }
  if (!isFindingEvidenceState(raw)) {
    throw new Error(
      `finding_add: evidenceState must be one of ${FINDING_EVIDENCE_STATES.join('|')}`,
    );
  }
  if (raw === 'suspected') {
    const reason = (args.uncertaintyReason ?? '').trim();
    if (reason.length < 10) {
      throw new Error(
        'finding_add: evidenceState=suspected 必须带 uncertaintyReason（≥10 字符），' +
        '说明为什么只是怀疑（未复现 / 缺源码证据），防止把 suspected 当绕 gate 的按钮',
      );
    }
    return { evidenceState: 'suspected', uncertaintyReason: reason };
  }
  if (raw === 'disproven') {
    const summary = (args.disprovenEvidence?.summary ?? '').trim();
    if (summary.length < 10) {
      throw new Error(
        'finding_add: evidenceState=disproven 必须带 disprovenEvidence.summary（≥10 字符），' +
        '记录反证摘要；可附 sourceRefs / reproCommand',
      );
    }
    const sourceRefs = args.disprovenEvidence?.sourceRefs?.filter(r => r.trim().length > 0);
    const reproCommand = args.disprovenEvidence?.reproCommand?.trim();
    return {
      evidenceState: 'disproven',
      disprovenEvidence: {
        summary,
        ...(sourceRefs && sourceRefs.length > 0 ? { sourceRefs } : {}),
        ...(reproCommand ? { reproCommand } : {}),
      },
    };
  }
  // verified：不需要附加字段
  return { evidenceState: 'verified' };
}

function recordReviewPass(ctx: HandlerContext, storyId: string, agent: string, note: string, reviewRunId: string): string {
  return withReviewPassLock(ctx, storyId, () => {
    const story = ctx.store.readStory(storyId);
    assertCurrentReviewRunForEvidence(ctx.store, story, ctx.root, agent, reviewRunId);
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
      reviewRunId,
      _hash: signReviewPass(storyId, id, agent, trimmedNote, createdAt, reviewRound, reviewRunId),
    };
    data.passes.push(pass);
    ctx.store.writeReviewPasses(storyId, data);
    const persisted = ctx.store.readReviewPasses(storyId);
    const persistedPass = persisted.passes.find(p => p.id === id);
    if (!persistedPass || persistedPass._hash !== pass._hash || persistedPass.agent !== agent || persistedPass.reviewRunId !== reviewRunId) {
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
    const commitHint = autoCommitStoryMetadata(ctx.root, storyId, 'review_pass_set');
    return `Review pass ${id} recorded by ${agent}${commitHint}`;
  });
}

export function createFindingHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    finding_add(args: {
      storyId: string;
      desc: string;
      severity: string;
      category: string;
      agent?: string;
      files?: string[];
      reviewRunId?: string;
      evidenceState?: string;
      uncertaintyReason?: string;
      disprovenEvidence?: DisprovenEvidence;
    }): string {
      assertCwdInWorktree(store, args.storyId);

      // 记录调用者身份（环境变量 KOALA_AGENT 由 subagent 设置）
      const missingAttribution = !args.agent && !process.env.KOALA_AGENT;
      const agent = args.agent || process.env.KOALA_AGENT || 'main';
      const category = normalizeFindingCategory(args.category);
      // B-3fad CHK-001: evidenceState 默认 verified；显式 suspected/disproven 需配套字段。
      const evidence = resolveEvidenceState(args);
      const isReviewerAgent = agent.startsWith('koala-review-');
      const reviewerLane = isReviewerAgent ? resolveReviewRunLane(agent) : undefined;

      const story = store.readStory(args.storyId);
      if (reviewerLane) {
        assertCurrentReviewRunForEvidence(store, story, ctx.root, reviewerLane, args.reviewRunId);
      }

      if (isPassOnlyReviewFindingRecord({ desc: args.desc, severity: args.severity, agent })) {
        return recordReviewPass(ctx, args.storyId, reviewerLane || agent, `Converted pass-only finding_add record: ${args.desc}`, args.reviewRunId || '');
      }

      const data = store.readFindings(args.storyId);
      const nextNum = data.findings.length + 1;
      const id = `${args.storyId}:F-${String(nextNum).padStart(3, '0')}`;
      const timestamp = new Date().toISOString();

      // 自动注入当前 review round（reviewer 无需传参）
      const reviewRound = story.currentReviewRound || '';

      const finding: Finding = {
        id,
        desc: args.desc,
        severity: args.severity as 'critical' | 'high' | 'medium' | 'low',
        category: category as Finding["category"],
        status: 'open',
        evidenceState: evidence.evidenceState,
        ...(evidence.uncertaintyReason ? { uncertaintyReason: evidence.uncertaintyReason } : {}),
        ...(evidence.disprovenEvidence ? { disprovenEvidence: evidence.disprovenEvidence } : {}),
        agent,
        createdAt: timestamp,
        reviewRound,
        ...(args.reviewRunId ? { reviewRunId: args.reviewRunId } : {}),
        _hash: signFinding(args.storyId, id, args.desc, args.severity, timestamp, reviewRound, args.reviewRunId || ''),
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
      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'finding_add');
      const advisoryHint = evidence.evidenceState === 'suspected'
        ? '\n→ evidenceState=suspected：不阻塞 REVIEW→TEST，仅作 advisory/attention item 进 review summary。'
        : evidence.evidenceState === 'disproven'
          ? '\n→ evidenceState=disproven：已被反证，不阻塞 REVIEW→TEST。'
          : '';
      return `Finding ${id} created by ${agent}: [${args.severity}/${category}] (evidenceState=${evidence.evidenceState}) ${args.desc}${warning}${advisoryHint}${commitHint}`;
    },

    review_pass_set(args: { storyId: string; agent?: string; note: string; reviewRunId?: string }): string {
      if (!args.note || args.note.trim().length < 10) {
        throw new Error('review_pass_set: note 必须 ≥ 10 字符，说明 reviewer 检查了什么以及为什么无 blocker');
      }
      const agent = resolveReviewRunLane(args.agent || process.env.KOALA_AGENT || 'main');
      assertCwdInWorktree(store, args.storyId);
      return recordReviewPass(ctx, args.storyId, agent, args.note, args.reviewRunId || '');
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
      const findings = data.findings.map(normalizeFindingForList);
      // B-3fad CHK-001: review summary 分区 — suspected/disproven open finding 进 advisory/attention 区，
      // 不进 blocking 区（与 REVIEW→TEST gate 的 evidenceState 维度同源）。
      // 每条 finding 自带 evidenceState 字段，缺失时按 legacy verified 渲染。
      const attention = {
        suspected: findings
          .filter(f => f.status === 'open' && f.evidenceState === 'suspected')
          .map(f => f.id),
        disproven: findings
          .filter(f => f.status === 'open' && f.evidenceState === 'disproven')
          .map(f => f.id),
      };
      return {
        ...data,
        findings: findings.map(f => ({
          ...f,
          // 渲染显式 evidenceState（legacy 缺字段 → verified，gate 同口径）
          evidenceState: f.evidenceState ?? 'verified',
        })),
        attention,
      };
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

      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'finding_resolve');
      return `Finding ${args.findingId} resolved${commitHint}`;
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
