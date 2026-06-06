/**
 * Finding handlers — reviewer finding management (signed to prevent forgery)
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
import { withReentrantMainWriteLock } from '../core/main-write-lock.js';
import { resolveMainRepoRoot } from '../core/partial-done-recovery.js';

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

/**
 * B-f60c CHK-003: a finding mutation on the shared `B-META-framework-audit`
 * container writes shared main / B-META state, so per
 * session-ownership-and-write-leases.md Rule 5 it must serialize on the unified
 * main write lock. A mutation on a NORMAL story writes story-scoped metadata
 * (the story owner lease's territory, NOT the main write lock) and is run
 * unchanged.
 *
 * The lock is reentrant: a B-META finding mutation can be reached from inside
 * another shared-write critical section (e.g. `audit` upserts B-META findings
 * while already holding the lock), and a non-reentrant acquire would self-
 * deadlock. The reentrant wrapper makes the nested call a pass-through.
 */
function withMetaFindingLock<T>(ctx: HandlerContext, storyId: string, fn: () => T): T {
  if (!storyId.startsWith('B-META-')) {
    return fn();
  }
  const mainRepoRoot = resolveMainRepoRoot(ctx.root);
  // A B-META finding write is a sub-second critical section — serialize-and-wait
  // on contention so a concurrent write completes rather than fail-fasting.
  return withReentrantMainWriteLock(mainRepoRoot, fn, {
    label: `finding write (${storyId})`,
    onContention: 'wait',
  });
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
 * B-3fad CHK-001: Parse evidenceState input of finding_add and perform runtime validation + guard.
 *
 * Default table (plan.md#CHK-001):
 * - evidenceState not provided → default 'verified' (finding raised by reviewer during REVIEW phase; preserves existing gate behavior).
 * - Explicit 'suspected' → must include uncertaintyReason (≥10 characters); error if missing (prevents using suspected as a button to bypass the gate).
 * - Explicit 'disproven' → must include disprovenEvidence.summary (≥10 characters); error if missing (disproven must carry counter-evidence).
 * - Invalid string → error (don't rely on Zod alone; runtime validates to the same standard, see CLAUDE.md "Handler Coding Conventions").
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
  // Default verified (reviewer finding_add during REVIEW phase)
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
        'finding_add: evidenceState=suspected must include uncertaintyReason (≥10 characters), ' +
        'explaining why it is merely suspected (not reproduced / lacking source evidence), to prevent using suspected as a button to bypass the gate',
      );
    }
    return { evidenceState: 'suspected', uncertaintyReason: reason };
  }
  if (raw === 'disproven') {
    const summary = (args.disprovenEvidence?.summary ?? '').trim();
    if (summary.length < 10) {
      throw new Error(
        'finding_add: evidenceState=disproven must include disprovenEvidence.summary (≥10 characters), ' +
        'recording the counter-evidence summary; may attach sourceRefs / reproCommand',
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
  // verified: no additional fields required
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

      // Record caller identity (env var KOALA_AGENT is set by subagent)
      const missingAttribution = !args.agent && !process.env.KOALA_AGENT;
      const agent = args.agent || process.env.KOALA_AGENT || 'main';
      const category = normalizeFindingCategory(args.category);
      // B-3fad CHK-001: evidenceState defaults to verified; explicit suspected/disproven requires the accompanying fields.
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

      // Auto-inject the current review round (reviewer does not need to pass it)
      const reviewRound = story.currentReviewRound || '';

      // B-f60c CHK-003: the readFindings → push → writeFindings critical section
      // for a B-META story is serialized under the main write lock; a normal
      // story runs it unchanged (withMetaFindingLock is a pass-through there).
      const id = withMetaFindingLock(ctx, args.storyId, () => {
        const data = store.readFindings(args.storyId);
        const nextNum = data.findings.length + 1;
        const fid = `${args.storyId}:F-${String(nextNum).padStart(3, '0')}`;
        const timestamp = new Date().toISOString();
        const finding: Finding = {
          id: fid,
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
          _hash: signFinding(args.storyId, fid, args.desc, args.severity, timestamp, reviewRound, args.reviewRunId || ''),
          ...(args.files && args.files.length > 0 ? { files: args.files } : {}),
        };
        data.findings.push(finding);
        store.writeFindings(args.storyId, data);
        return fid;
      });

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
        ? '\n⚠ finding_add is missing agent/KOALA_AGENT and has been recorded as main; reviewer must pass agent="koala-review-*", otherwise it will not count as reviewer evidence.'
        : '';
      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'finding_add');
      const advisoryHint = evidence.evidenceState === 'suspected'
        ? '\n→ evidenceState=suspected: does not block REVIEW→TEST; treated only as an advisory/attention item in the review summary.'
        : evidence.evidenceState === 'disproven'
          ? '\n→ evidenceState=disproven: has been refuted by counter-evidence, does not block REVIEW→TEST.'
          : '';
      return `Finding ${id} created by ${agent}: [${args.severity}/${category}] (evidenceState=${evidence.evidenceState}) ${args.desc}${warning}${advisoryHint}${commitHint}`;
    },

    review_pass_set(args: { storyId: string; agent?: string; note: string; reviewRunId?: string }): string {
      if (!args.note || args.note.trim().length < 10) {
        throw new Error('review_pass_set: note must be ≥ 10 characters, explaining what the reviewer checked and why there is no blocker');
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
      // B-9d95 CHK-005: cluster view — reads clusters.json + findings.json, groups by cluster + lists ungrouped items.
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
      // B-3fad CHK-001: review summary partitioning — suspected/disproven open findings go into advisory/attention sections,
      // not into the blocking section (same source as the evidenceState dimension of the REVIEW→TEST gate).
      // Each finding carries its own evidenceState field; when missing, render as legacy verified.
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
          // Render explicit evidenceState (legacy missing field → verified, same convention as gate)
          evidenceState: f.evidenceState ?? 'verified',
        })),
        attention,
      };
    },

    finding_resolve(args: { storyId: string; findingId: string; resolution?: string }): string {
      assertCwdInWorktree(store, args.storyId);
      // B-f60c CHK-003: a B-META finding mutation is serialized under the main
      // write lock; a normal story runs unchanged (pass-through).
      withMetaFindingLock(ctx, args.storyId, () => {
        const data = store.readFindings(args.storyId);
        const f = data.findings.find(f => f.id === args.findingId);
        if (!f) throw new Error(`Finding ${args.findingId} not found`);
        f.status = 'resolved';
        const resolution = args.resolution?.trim();
        if (resolution) f.resolvedReason = resolution;
        f.resolvedAt = new Date().toISOString();
        store.writeFindings(args.storyId, data);
      });

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
        throw new Error('finding_dismiss: reason must be >= 10 characters, explaining why it will not be fixed');
      }
      // B-f60c CHK-003: a B-META finding mutation is serialized under the main
      // write lock; a normal story runs unchanged (pass-through). `alreadyResolved`
      // carries the "already resolved, no-op dismiss" branch out of the lock.
      const alreadyResolved = withMetaFindingLock(ctx, args.storyId, () => {
        const data = store.readFindings(args.storyId);
        const f = data.findings.find(f => f.id === args.findingId);
        if (!f) throw new Error(`Finding ${args.findingId} not found`);

        if (f.status === 'resolved') {
          return true;
        }
        // B-0f47: critical findings cannot be dismissed (placed after the resolved check)
        if (f.severity === 'critical') {
          throw new Error(`critical findings cannot be dismissed, must be fixed in any round. Finding: ${args.findingId}`);
        }
        f.status = 'dismissed';
        f.dismissReason = args.reason.trim();
        f.dismissedAt = new Date().toISOString();
        store.writeFindings(args.storyId, data);
        return false;
      });
      if (alreadyResolved) {
        return `Finding ${args.findingId} is already resolved, no need to dismiss`;
      }

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
