
import { setup, createActor, type SnapshotFrom } from 'xstate';
import type { StoryStore } from './store.js';
import { createHash } from 'crypto';
import { loadConfig } from './config.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
import type { Finding } from './types.js';
import { blockingInitCheckIssues, missingRequiredInitCheckAgents, recomputeInitCheckHash } from '../handlers/init-check.js';
import { recomputeDeliveryCheckHash } from './delivery-check-hash.js';
import { getBlockingVerificationEvidenceIssues } from './verification.js';
import { normalizeLegacyPhase } from './phase-flow.js';
import { findingAgentMatchesReviewer } from './reviewer-opt-in.js';
import { detectMdTouchpointsFromGit } from './touchpoints-fallback.js';
import { computeActiveReviewers } from '../handlers/reviewer-list.js';
import { collectReviewerEvidenceState } from './review-run.js';

/**
 * Resolve effective blocking severities with round decay.
 * Round count is derived from story events (how many times the story entered REVIEW phase),
 * not from review.json which also contains PLAN-phase story_review entries.
 */
function resolveEffectiveBlockingSeverities(
  store: StoryStore, storyId: string, policy: { review: { blockingSeverities: readonly string[] | string[] } }
): { effectiveBlockingSeverities: string[]; roundCount: number } {
  let roundCount = 1;
  try {
    const story = store.readStory(storyId);
    if (story.events) {
      const reviewEntries = story.events.filter(
        (e: any) => e.phase === 'REVIEW' && e.action === 'advance'
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

export interface StoryMachineContext {
  storyId: string;
  store: StoryStore;
  projectRoot: string;
}

export const storyMachine = setup({
  types: {
    context: {} as StoryMachineContext,
    input: {} as StoryMachineContext,
    events: {} as
      | { type: 'INIT' }
      | { type: 'INIT_CHECK' }
      | { type: 'PLAN' }
      | { type: 'START' }
      | { type: 'REPLAN' }
      | { type: 'CODE_REVIEW' }
      | { type: 'REVIEW_PASS' }
      | { type: 'FINISH' },
  },
  guards: {
    checklistAllDone: ({ context }) => {
      const cl = context.store.readChecklist(context.storyId);
      if (!cl.items.every(item => item.status === 'done')) return false;
      return getBlockingVerificationEvidenceIssues(cl).length === 0;
    },
    // B-e71f CHK-006: INIT→INIT_CHECK 硬门槛 xstate 端兜底。
    // getGuardFailureReason 在 story-advance.ts:335 仅当 actor.can() 返回 false 时才被调用，
    // 因此必须在这里给 INIT→INIT_CHECK 转换挂 guard，否则 can() 始终 true，gate 永不触发。
    // guard 与 getGuardFailureReason 共享同一判定逻辑：缺 init-check.json → false；
    // _hash 失配 → false；通过 → true。失败原因由 getGuardFailureReason 渲染人类可读消息。
    canEnterInitCheck: ({ context }) => {
      try {
        const story = context.store.readStory(context.storyId);
        if (story.phase !== 'INIT') return true; // IDEA→INIT_CHECK 等其他来源不门禁
        const initCheck = context.store.readInitCheck(context.storyId);
        if (!initCheck) return false;
        const expected = recomputeInitCheckHash(context.storyId, context.store, context.projectRoot);
        return initCheck._hash === expected
          && missingRequiredInitCheckAgents(initCheck).length === 0
          && blockingInitCheckIssues(initCheck).length === 0;
      } catch (err) {
        // B-e71f F-016: xstate guard 不能 throw（会让 actor 进 error state），但完全静默会
        // 让 store 异常根因（fs 读不到 / json parse 失败 / recompute 路径 bug）被吞——
        // 用户只看到 gate 拒绝、拿不到诊断。此处 console.warn 不影响 guard 返回值。
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[canEnterInitCheck] ${context.storyId}: ${msg}`);
        return false;
      }
    },
    canStartDev: ({ context }) => {
      // story_review 通过是进 DEV 的前提（除非 policy 不要求）
      try {
        const config = loadConfig(context.projectRoot);
        const story = context.store.readStory(context.storyId);
        const policy = resolveWorkflowPolicy(config, story);
        if (!policy.plan.requireStoryReview) return true;
        const review = context.store.readReview(context.storyId);
        if (!review || !review.reviews || review.reviews.length === 0) return false;
        const lastRound = review.reviews[review.reviews.length - 1];
        const REVIEW_SALT = 'koala-review-integrity-v1';
        const hashInput = `${context.storyId}:${lastRound.timestamp}:${lastRound.issueCount}:${lastRound.blockerCount ?? lastRound.issueCount}:${REVIEW_SALT}`;
        const expectedHash = createHash('sha256').update(hashInput).digest('hex');
        if (!lastRound._hash || lastRound._hash !== expectedHash) return false;
        return (lastRound.blockerCount ?? lastRound.issueCount) === 0;
      } catch {
        return false;
      }
    },
    canSkipPlan: ({ context }) => {
      // 快速通道：由 WorkflowPolicy 决定是否允许跳过 PLAN
      try {
        const config = loadConfig(context.projectRoot);
        const story = context.store.readStory(context.storyId);
        const policy = resolveWorkflowPolicy(config, story);
        if (!policy.quickPath.enabled) return false;
        if (!policy.quickPath.allowRiskSignals && story.riskSignals && story.riskSignals.length > 0) return false;
        const cl = context.store.readChecklist(context.storyId);
        return cl.items.length <= policy.quickPath.maxChecklistItems;
      } catch {
        return false;
      }
    },
    canPassReview: ({ context }) => {
      try {
        const config = loadConfig(context.projectRoot);
        const story = context.store.readStory(context.storyId);
        const policy = resolveWorkflowPolicy(config, story);

        // If policy doesn't require reviewer, skip finding checks entirely
        if (!policy.review.requireReviewer) return true;

        const findings = context.store.readFindings(context.storyId);
        const reviewPasses = context.store.readReviewPasses(context.storyId);
        if ((!findings.findings || findings.findings.length === 0) && (!reviewPasses.passes || reviewPasses.passes.length === 0)) return false;
        const evidenceState = collectReviewerEvidenceState(context.store, context.storyId, context.projectRoot);
        if (evidenceState.invalid.length > 0) return false;

        // Check for reviewer-produced finding if policy requires it
        if (policy.review.requireReviewerFinding) {
          const currentRoundReviewerEvidence = evidenceState.valid.map((e) => ({ agent: e.agent, kind: e.kind }));

          const { roundCount } = resolveEffectiveBlockingSeverities(context.store, context.storyId, policy);
          if (roundCount <= 1) {
            // Round 1: require findings from every opt-in reviewer (same source as reviewer_list).
            let checklist: { items: unknown[] } = { items: [] };
            try { checklist = context.store.readChecklist(context.storyId); } catch {}
            let decision = null;
            try { decision = context.store.readDecision(context.storyId); } catch {}
            const understanding = context.store.readUnderstanding(context.storyId);
            const touchpoints = understanding?.touchpoints
              ?? detectMdTouchpointsFromGit(context.projectRoot ?? process.cwd());
            const optIn = computeActiveReviewers(story, checklist, decision, touchpoints);
            const missing = optIn.filter(reviewer => !currentRoundReviewerEvidence.some(
              e => findingAgentMatchesReviewer(e.agent, reviewer.name),
            ));
            if (missing.length > 0) return false;
          } else {
            // Round 2+: require at least 1 reviewer finding or pass receipt
            if (currentRoundReviewerEvidence.length === 0) return false;
          }
        }

        const { effectiveBlockingSeverities } = resolveEffectiveBlockingSeverities(context.store, context.storyId, policy);

        // Check blocking severities from policy (with round decay)
        const blocking = evidenceState.valid
          .map((e) => e.finding)
          .filter((finding): finding is Finding => !!finding)
          .filter(
            (f) => effectiveBlockingSeverities.includes(f.severity) && f.status === 'open',
        );
        return blocking.length === 0;
      } catch {
        return false;
      }
    },
    canFinish: ({ context }) => {
      // verifier result (test-evidence.json) must be PASS + all bugs fixed
      const evidence = context.store.readTestEvidence(context.storyId);
      const hasEvidence = evidence !== null && evidence.result === 'PASS';
      const bugs = context.store.readBugs(context.storyId);
      const bugsOk = bugs.bugs.every(b => b.status === 'fixed');
      if (!hasEvidence || !bugsOk) return false;

      // delivery-check.json must exist and _hash must match
      const deliveryCheck = context.store.readDeliveryCheck(context.storyId);
      if (!deliveryCheck) return false;
      const expectedHash = recomputeDeliveryCheckHash(context.storyId, context.store);
      if (expectedHash === null || deliveryCheck._hash !== expectedHash) return false;

      // every docsPromise must be verified or waived
      const unverified = deliveryCheck.docsPromises.filter(
        p => !p.verifiedBy && !p.waiverReason && !['met', 'verified', 'waived'].includes(p.status || ''),
      );
      if (unverified.length > 0) return false;

      return true;
    },
  },
}).createMachine({
  id: 'story',
  context: ({ input }: { input: StoryMachineContext }) => input,
  initial: 'IDEA',
  states: {
    IDEA: {
      on: {
        INIT: { target: 'INIT' },
        PLAN: { target: 'PLAN' }, // legacy direct path
      },
    },
    INIT: {
      on: {
        // B-e71f CHK-006: 必须挂 guard，否则 actor.can() 始终 true，
        // story-advance.ts 的 getGuardFailureReason 失败消息渲染永不触发。
        INIT_CHECK: { target: 'INIT_CHECK', guard: 'canEnterInitCheck' },
      },
    },
    INIT_CHECK: {
      on: {
        PLAN: { target: 'PLAN' },
        START: { target: 'DEV', guard: 'canSkipPlan' },
      },
    },
    PLAN: {
      on: {
        START: { target: 'DEV', guard: 'canStartDev' },
      },
    },
    DEV: {
      on: {
        CODE_REVIEW: {
          target: 'REVIEW',
          guard: 'checklistAllDone',
        },
        REPLAN: {
          target: 'PLAN',
        },
      },
    },
    REVIEW: {
      on: {
        REVIEW_PASS: {
          target: 'TEST',
          guard: 'canPassReview',
        },
        START: {
          target: 'DEV',
        },
      },
    },
    TEST: {
      on: {
        FINISH: {
          target: 'DONE',
          guard: 'canFinish',
        },
        START: {
          target: 'DEV',
        },
      },
    },
    DONE: {
      type: 'final',
    },
  },
});

export type StoryMachineSnapshot = SnapshotFrom<typeof storyMachine>;

export function createStoryActor(
  storyId: string,
  store: StoryStore,
  restoredState?: string,
  projectRoot?: string,
) {
  const context: StoryMachineContext = { storyId, store, projectRoot: projectRoot ?? process.cwd() };
  const normalizedState = restoredState ? normalizeLegacyPhase(restoredState) : undefined;

  if (normalizedState) {
    const snapshot = storyMachine.resolveState({
      value: normalizedState,
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
  // B-e71f CHK-005: INIT→INIT_CHECK 硬门槛。
  // 仅当 story.phase === 'INIT' 时启用，IDEA→INIT_CHECK 等其他来源不门禁。
  // 缺 init-check.json → missing_init_check；_hash 失配 → init_check_tampered。
  // recomputeInitCheckHash 复用 CHK-001 已导出函数（禁两份实现）。
  if (targetPhase === 'INIT_CHECK') {
    const story = store.readStory(storyId);
    if (story.phase !== 'INIT') return null;
    const initCheck = store.readInitCheck(storyId);
    if (!initCheck) {
      return `Cannot enter INIT_CHECK: 未跑 koala-review-story-init agent（缺 init-check.json）。 [missing_init_check]\n→ Agent({ subagent_type: "koala-review-story-init", prompt: \`koala dispatch '{"storyId":"${storyId}","agentType":"koala-review-story-init"}'\` })\n→ 若 reviewer 4 分钟无输出，重新运行 dispatch 并重启 reviewer。`;
    }
    const expected = recomputeInitCheckHash(storyId, store, projectRoot ?? process.cwd());
    if (initCheck._hash !== expected) {
      return `Cannot enter INIT_CHECK: init-check.json _hash 失配（背景/标题/描述/checklist 已修改），请重跑 koala-review-story-init agent。 [init_check_tampered]`;
    }
    const missingAgents = missingRequiredInitCheckAgents(initCheck);
    if (missingAgents.length > 0) {
      return `Cannot enter INIT_CHECK: init-check.json 缺少必需 reviewer 记录: ${missingAgents.join(', ')}。 [missing_init_check_agent]\n→ 分别运行 koala dispatch '{"storyId":"${storyId}","agentType":"koala-review-story-init"}' 和 product-reviewer；每个 reviewer 无论 pass/fail 都必须调用 init_check_set。`;
    }
    const blockers = blockingInitCheckIssues(initCheck);
    if (blockers.length > 0) {
      const lines = blockers.slice(0, 8).map(({ agentId, issue }) =>
        `  - ${agentId}: ${issue.severity} ${issue.id ? `${issue.id} ` : ''}${issue.desc}`,
      );
      return `Cannot enter INIT_CHECK: init-check reviewer 记录了 high/critical issue，必须先修复并重跑对应 reviewer。 [init_check_blocking_issues]\n${lines.join('\n')}`;
    }
    return null;
  }

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
    const missingEvidence = getBlockingVerificationEvidenceIssues(cl);
    if (missingEvidence.length > 0) {
      return `Cannot enter REVIEW: ${missingEvidence.length} required verification intent(s) lack passing evidence or waiver:\n${missingEvidence.map(i => `  - ${i}`).join('\n')}\n→ 运行 verification_evidence_add 记录 logic/integration/browser/manual 证据，或用 waiver 明确豁免`;
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
        const reviewPasses = store.readReviewPasses(storyId);
        if ((!findings.findings || findings.findings.length === 0) && (!reviewPasses.passes || reviewPasses.passes.length === 0)) {
          return `Cannot enter TEST: reviewer 未跑（无 findings 或 review pass）\n→ 按 opt-in 结果启动 reviewer（见 koala reviewer_list）；无问题时用 review_pass_set 记录通过`;
        }
        const evidenceState = collectReviewerEvidenceState(store, storyId, projectRoot ?? process.cwd());
        if (evidenceState.invalid.length > 0) {
          return `Cannot enter TEST: reviewer evidence 存在无效/过期的 review run 绑定：\n${evidenceState.invalid.slice(0, 5).map(issue => `  - ${issue.message}`).join('\n')}`;
        }
        if (policy.review.requireReviewerFinding) {
          const currentRound = story.currentReviewRound;
          const currentRoundReviewerEvidence = evidenceState.valid.map((e) => ({ agent: e.agent, kind: e.kind }));

          const { roundCount: rc } = resolveEffectiveBlockingSeverities(store, storyId, policy);
          if (rc <= 1) {
            // Round 1: require findings from every opt-in reviewer (same source as reviewer_list).
            let checklist: { items: unknown[] } = { items: [] };
            try { checklist = store.readChecklist(storyId); } catch {}
            let decision = null;
            try { decision = store.readDecision(storyId); } catch {}
            const understanding = store.readUnderstanding(storyId);
            const touchpoints = understanding?.touchpoints
              ?? detectMdTouchpointsFromGit(projectRoot ?? process.cwd());
            const optIn = computeActiveReviewers(story, checklist, decision, touchpoints);
            const missing = optIn.filter(reviewer => !currentRoundReviewerEvidence.some(
              e => findingAgentMatchesReviewer(e.agent, reviewer.name),
            ));
            if (missing.length > 0) {
              const names = optIn.map(r => r.name).join(',');
              const missingNames = missing.map(r => r.name).join(',');
              const presentAgents = Array.from(new Set(currentRoundReviewerEvidence.map(e => e.agent))).join(', ') || '无';
              return `Cannot enter TEST: Round 1 期望 ${optIn.length} 个 reviewer（opt-in: ${names}）当前 ${currentRoundReviewerEvidence.length} 个 reviewer 证据覆盖 ${optIn.length - missing.length} 个 reviewer（缺: ${missingNames}；已见 agent: ${presentAgents}）\n→ 并行启动缺失的 koala-review-* agent；无问题时用 review_pass_set`;
            }
          } else {
            if (currentRoundReviewerEvidence.length === 0) {
              return currentRound
                ? `Cannot enter TEST: Round ${rc} 当前 review round (${currentRound}) 无 reviewer finding/pass，请启动对应的 koala-review-* agent`
                : `Cannot enter TEST: findings 全部来自 main agent（reviewer 未跑）\n→ 启动 koala-review-* subagent`;
            }
          }
        }
        const { effectiveBlockingSeverities, roundCount } = resolveEffectiveBlockingSeverities(store, storyId, policy);

        const blocking = evidenceState.valid
          .map((e) => e.finding)
          .filter((finding): finding is Finding => !!finding)
          .filter((f) => effectiveBlockingSeverities.includes(f.severity) && f.status === 'open');
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

    // delivery-check.json 签名校验
    const deliveryCheck = store.readDeliveryCheck(storyId);
    if (!deliveryCheck) {
      return `Cannot enter DONE: 缺 delivery-check.json（需 koala-review-delivery reviewer 签名）。 [missing_delivery_check] → 运行 story_advance DEV 回炉补齐`;
    }
    const expectedDeliveryHash = recomputeDeliveryCheckHash(storyId, store);
    if (expectedDeliveryHash === null || deliveryCheck._hash !== expectedDeliveryHash) {
      return `Cannot enter DONE: delivery-check.json _hash 失配（内容已被篡改），请重跑 koala-review-delivery reviewer。 [delivery_check_tampered] → 运行 story_advance DEV 回炉补齐`;
    }

    // every docsPromise must be verified or waived
    const unverifiedPromises = deliveryCheck.docsPromises.filter(
      p => !p.verifiedBy && !p.waiverReason && !['met', 'verified', 'waived'].includes(p.status || ''),
    );
    if (unverifiedPromises.length > 0) {
      const names = unverifiedPromises.map(p => p.docPath).join(', ');
      return `Cannot enter DONE: ${unverifiedPromises.length} 条 docsPromise 未验证且无豁免: ${names}。 [unverified_promise] → 用 delivery_waiver_add 写豁免或重跑 reviewer → 运行 story_advance DEV 回炉补齐`;
    }
  }

  return null;
}
