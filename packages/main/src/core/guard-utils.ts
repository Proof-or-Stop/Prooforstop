/**
 * Machine helpers extracted out of machine.ts to satisfy the "Machine = pure
 * config object, zero function definitions" rule (CLAUDE.md §代码范式).
 *
 * These helpers back the xstate guards in machine.ts as well as the handler-
 * layer preflight logic in handlers/story-advance.ts. They perform I/O
 * (store.readStory / store.readReview / store.readFindings / store.readChecklist
 * / store.readTestEvidence / store.readBugs / loadConfig) and so deliberately
 * do NOT live in machine.ts.
 *
 * See B-c351 F-006 for the extraction rationale.
 */

import { createActor } from 'xstate';
import { createHash } from 'crypto';
import type { StoryStore } from './store.js';
import { loadConfig } from './config.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
import { verifyFinding } from './finding-verify.js';
import type { Finding } from './types.js';
import { storyMachine, type StoryMachineContext } from './machine.js';
import { resolveOptInReviewers, resolveChannel, findingAgentMatchesReviewer } from './reviewer-opt-in.js';
import { isAdvisoryThisRound } from './advisory.js';
import { detectMdTouchpointsFromGit } from './touchpoints-fallback.js';

/**
 * Resolve effective blocking severities with round decay.
 * Round count is derived from story events (how many times the story entered REVIEW phase),
 * not from review.json which also contains PLAN-phase story_review entries.
 */
export function resolveEffectiveBlockingSeverities(
  store: StoryStore,
  storyId: string,
  policy: { review: { blockingSeverities: readonly string[] | string[] } },
): { effectiveBlockingSeverities: string[]; roundCount: number } {
  let roundCount = 1;
  try {
    const story = store.readStory(storyId);
    if (story.events) {
      const reviewEntries = story.events.filter(
        (e: any) => e.phase === 'REVIEW' && e.action === 'advance',
      );
      roundCount = reviewEntries.length || 1;
    }
  } catch { /* fallback to 1 */ }

  let effectiveBlockingSeverities: string[];
  if (roundCount >= 3) {
    effectiveBlockingSeverities = ['critical'];
  } else if (roundCount >= 2) {
    effectiveBlockingSeverities = ['critical', 'high'];
  } else {
    effectiveBlockingSeverities = policy.review.blockingSeverities as string[];
  }
  return { effectiveBlockingSeverities, roundCount };
}

export function createStoryActor(
  storyId: string,
  store: StoryStore,
  restoredState?: string,
  projectRoot?: string,
) {
  const context: StoryMachineContext = { storyId, store, projectRoot: projectRoot ?? process.cwd() };

  if (restoredState) {
    const snapshot = storyMachine.resolveState({
      value: restoredState,
      context,
    });
    return createActor(storyMachine, { snapshot, input: context });
  }

  return createActor(storyMachine, { input: context });
}

export function getStateName(actor: ReturnType<typeof createActor<typeof storyMachine>>): string {
  const snapshot = actor.getSnapshot();
  return typeof snapshot.value === 'string' ? snapshot.value : JSON.stringify(snapshot.value);
}

export function getGuardFailureReason(
  storyId: string,
  store: StoryStore,
  targetPhase: string,
  projectRoot?: string,
): string | null {
  // B-e71f F-006/F-012: INIT_CHECK 分支已迁出此文件。
  // 历史现状：guard-utils.ts 整个文件未被任何 source import（grep `from.*guard-utils` 仅命中 CLAUDE.md 路径文档），
  // INIT_CHECK 真相源是 machine.ts 的 getGuardFailureReason（被 story-advance.ts:335 调用渲染失败消息）+
  // canEnterInitCheck guard（actor.can() 决定 transition）。删除此处死分支以消除 DRY 违背。
  // 其余分支（DEV/REVIEW/TEST/DONE）暂保留——它们也是死代码但属于 B-e71f scope 外历史遗留。

  if (targetPhase === 'DEV') {
    // 先检查是否从 INIT_CHECK 走快速通道
    const story = store.readStory(storyId);
    if (story.phase === 'INIT_CHECK') {
      // 快速通道失败原因 — 读 WorkflowPolicy
      const reasons: string[] = [];
      try {
        const config = loadConfig(projectRoot);
        const policy = resolveWorkflowPolicy(config, story);
        if (!policy.quickPath.enabled) {
          reasons.push(`当前 profile=${policy.profile} 禁用快速通道`);
        } else {
          if (!policy.quickPath.allowRiskSignals && story.riskSignals && story.riskSignals.length > 0) {
            reasons.push(`有高风险信号（${story.riskSignals.map(r => r.category).join(', ')}），必须走完整 PLAN`);
          }
          try {
            const cl = store.readChecklist(storyId);
            if (cl.items.length > policy.quickPath.maxChecklistItems) {
              reasons.push(`checklist 有 ${cl.items.length} 项（> ${policy.quickPath.maxChecklistItems}），必须走完整 PLAN`);
            }
          } catch {
            reasons.push('无 checklist，必须先 story_advance PLAN');
          }
        }
      } catch {
        reasons.push('无法加载配置，必须走完整 PLAN');
      }
      if (reasons.length > 0) {
        return `Cannot skip PLAN:\n${reasons.map(r => `  - ${r}`).join('\n')}\n→ story_advance '{"storyId":"${storyId}","phase":"PLAN"}' 进入完整 PLAN 流程`;
      }
    }

    // 正常 PLAN → DEV 路径：需要 story_review 通过（除非 policy 不要求）
    try {
      const config2 = loadConfig(projectRoot);
      const story2 = store.readStory(storyId);
      const policy2 = resolveWorkflowPolicy(config2, story2);
      if (!policy2.plan.requireStoryReview) {
        // policy says no review needed — pass through
      } else {
        const reasons: string[] = [];
        try {
          const review = store.readReview(storyId);
          if (!review || !review.reviews || review.reviews.length === 0) {
            reasons.push('未通过 story_review 审查（无审查记录）');
          } else {
            const lastRound = review.reviews[review.reviews.length - 1];
            const REVIEW_SALT = 'koala-review-integrity-v1';
            const hashInput = `${storyId}:${lastRound.timestamp}:${lastRound.issueCount}:${lastRound.blockerCount ?? lastRound.issueCount}:${REVIEW_SALT}`;
            const expectedHash = createHash('sha256').update(hashInput).digest('hex');
            if (!lastRound._hash || lastRound._hash !== expectedHash) {
              reasons.push('review.json 签名校验失败，审查报告必须由 story_review CLI 生成');
            } else if ((lastRound.blockerCount ?? lastRound.issueCount) > 0) {
              reasons.push(`最近一轮 story_review 有 ${lastRound.blockerCount ?? lastRound.issueCount} 个 blocker 未修复`);
            }
          }
        } catch {
          reasons.push('未通过 story_review 审查（无审查记录）');
        }
        if (reasons.length > 0) {
          return `Cannot enter DEV:\n${reasons.map(r => `  - ${r}`).join('\n')}`;
        }
      }
    } catch {
      // config load failed — fall through (don't block on config error)
    }
  }

  if (targetPhase === 'REVIEW') {
    const cl = store.readChecklist(storyId);
    const pending = cl.items.filter(i => i.status !== 'done');
    if (pending.length > 0) {
      return `Cannot enter REVIEW: ${pending.length} checklist item(s) not done: ${pending.map(i => i.id).join(', ')}`;
    }
  }

  if (targetPhase === 'TEST') {
    const config = loadConfig(projectRoot);
    const story = store.readStory(storyId);
    const policy = resolveWorkflowPolicy(config, story);

    // If policy doesn't require reviewer, skip finding checks
    if (!policy.review.requireReviewer) {
      // no review gate — pass through
    } else {
      try {
        const findings = store.readFindings(storyId);
        if (!findings.findings || findings.findings.length === 0) {
          return `Cannot enter TEST: reviewer 未跑（findings.json 为空）\n→ 按 opt-in 结果启动 reviewer（见 koala reviewer_list）`;
        }
        if (policy.review.requireReviewerFinding) {
          const currentRound = story.currentReviewRound;
          const currentRoundReviewerFindings = findings.findings.filter(
            (f: Finding) => f.agent && f.agent !== 'main' && verifyFinding(storyId, f)
              // backward compat: 旧 story 无 currentReviewRound 时不拒绝
              && (!currentRound || f.reviewRound === currentRound),
          );

          const { roundCount: rc } = resolveEffectiveBlockingSeverities(store, storyId, policy);
          if (rc <= 1) {
            // Round 1: require findings from every opt-in reviewer (B-e8c8)
            let checklistItemsCount = 0;
            try { checklistItemsCount = store.readChecklist(storyId).items.length; } catch {}
            const channel = resolveChannel(checklistItemsCount, story.riskSignals);
            const understanding = store.readUnderstanding(storyId);
            // F-021: touchpoints 为空时回退扫 git diff，避免只改 .md 的 story 丢 docs reviewer。
            const touchpoints = understanding?.touchpoints
              ?? detectMdTouchpointsFromGit(projectRoot ?? process.cwd());
            const optIn = resolveOptInReviewers(story, channel, touchpoints);
            const missing = optIn.filter(reviewer => !currentRoundReviewerFindings.some(
              (f: Finding) => findingAgentMatchesReviewer(f.agent, reviewer.name),
            ));
            if (missing.length > 0) {
              const names = optIn.map(r => r.name).join(',');
              const missingNames = missing.map(r => r.name).join(',');
              const presentAgents = Array.from(new Set(currentRoundReviewerFindings.map((f: Finding) => f.agent))).join(', ') || '无';
              return `Cannot enter TEST: Round 1 期望 ${optIn.length} 个 reviewer（opt-in: ${names}）当前 ${currentRoundReviewerFindings.length} 个 finding 覆盖 ${optIn.length - missing.length} 个 reviewer（缺: ${missingNames}；已见 agent: ${presentAgents}）\n→ 并行启动缺失的 koala-review-* agent`;
            }
          } else {
            if (currentRoundReviewerFindings.length === 0) {
              return currentRound
                ? `Cannot enter TEST: Round ${rc} 当前 review round (${currentRound}) 无 reviewer finding，请启动对应的 koala-review-* agent`
                : `Cannot enter TEST: findings 全部来自 main agent（reviewer 未跑）\n→ 启动 koala-review-* subagent`;
            }
          }
        }
        const { effectiveBlockingSeverities, roundCount } = resolveEffectiveBlockingSeverities(store, storyId, policy);

        // B-e8c8 CHK-007: advisory findings 不算 blocker（与 canPassReview 同源）。
        const blocking = findings.findings.filter(
          f => effectiveBlockingSeverities.includes(f.severity)
            && f.status === 'open'
            && !isAdvisoryThisRound(f.severity, roundCount),
        );
        if (blocking.length > 0) {
          return `Cannot enter TEST: ${blocking.length} blocking finding(s) open (Round ${roundCount}, blocking: ${effectiveBlockingSeverities.join('/')}):\n${blocking.map(f => `  - ${f.id} [${f.severity}] ${f.desc}`).join('\n')}\n→ 修复后 finding_resolve，或确认不修 finding_dismiss（需说明理由 ≥10 字符）`;
        }
      } catch {
        return `Cannot enter TEST: reviewer 未跑（无 findings.json）\n→ 按 opt-in 结果启动 reviewer（见 koala reviewer_list）`;
      }
    }
  }

  if (targetPhase === 'DONE') {
    const evidence = store.readTestEvidence(storyId);
    if (!evidence) {
      return 'Cannot enter DONE: no test evidence (run koala validate first)';
    }
    if (evidence.result !== 'PASS') {
      return `Cannot enter DONE: test ${evidence.result}: ${evidence.output}`;
    }
    const bugs = store.readBugs(storyId);
    const openBugs = bugs.bugs.filter(b => b.status !== 'fixed');
    if (openBugs.length > 0) {
      return `Cannot enter DONE: ${openBugs.length} unfixed bug(s): ${openBugs.map(b => b.id).join(', ')}`;
    }
  }

  return null;
}
