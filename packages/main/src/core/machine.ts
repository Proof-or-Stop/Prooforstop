
import { setup, createActor, type SnapshotFrom } from 'xstate';
import type { StoryStore } from './store.js';
import { createHash } from 'crypto';
import type { PhaseInvariantIssue, PhaseGateDecision } from './types.js';
import { buildPhaseGateDecision, formatPhaseGateDecision } from './phase-protocol.js';

export interface StoryMachineContext {
  storyId: string;
  store: StoryStore;
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
      | { type: 'WRITE_CASES' }
      | { type: 'REQUEST_REVIEW' }
      | { type: 'REVIEW' }
      | { type: 'ROLLBACK_DEV' }
      | { type: 'ROLLBACK_TEST_CASE' }
      | { type: 'FINISH' },
  },
  guards: {
    checklistAllDone: ({ context }) => {
      // B-2fd7 / B-5010 CHK-002: honor item.phase here for the DEV→TEST_CASE
      // transition. Items whose phase==='TEST_CASE' are intentionally deferred
      // (fixture writing, smoke cases, perf sanity) and should not block
      // leaving DEV. This mirrors the phase-aware logic in
      // getGuardFailureReason (machine.ts:269). Without this, the xstate
      // guard runs first and fails before getGuardFailureReason is reached,
      // and forcing DEV-completion on TEST_CASE items would make the agent
      // mark them done before doing the work.
      const cl = context.store.readChecklist(context.storyId);
      const devPhaseItems = cl.items.filter((item: any) => (item.phase || 'DEV') !== 'TEST_CASE');
      return devPhaseItems.every(item => item.status === 'done');
    },
    canStartDev: ({ context }) => {
      // B-0af4 CHK-002: trivial-story 绕过 testIntent 要求（和 story_review 保持一致）
      const cl = context.store.readChecklist(context.storyId);
      let isTrivial = false;
      try {
        const storyInfo = context.store.readStory(context.storyId) as any;
        const trivialTypes = ['chore', 'refactor', 'docs'];
        isTrivial =
          storyInfo?.priority === 'low' &&
          cl.items.length <= 1 &&
          trivialTypes.includes(storyInfo?.type);
      } catch { /* treat as non-trivial */ }

      if (!isTrivial) {
        // happy 必填；edge/adversarial 选填（B-569d）
        const allHaveIntent = cl.items.every((item: any) => {
          const ti = item.testIntent;
          if (ti === null) return true; // 显式标记不可测试，跳过
          return ti && Array.isArray(ti.happy) && ti.happy.length > 0;
        });
        if (!allHaveIntent) return false;
      }
      try {
        const review = context.store.readReview(context.storyId);
        if (!review || !review.reviews || review.reviews.length === 0) return false;
        const lastRound = review.reviews[review.reviews.length - 1];
        // 验证签名
        const REVIEW_SALT = 'koala-review-integrity-v1';
        const hashInput = `${context.storyId}:${lastRound.timestamp}:${lastRound.issueCount}:${lastRound.blockerCount ?? lastRound.issueCount}:${REVIEW_SALT}`;
        const expectedHash = createHash('sha256').update(hashInput).digest('hex');
        if (!lastRound._hash || lastRound._hash !== expectedHash) return false;
        // blockerCount=0 即可放行（advisory 不阻塞）
        return (lastRound.blockerCount ?? lastRound.issueCount) === 0;
      } catch {
        return false;
      }
    },
    hasTestEvidence: ({ context }) => {
      const evidence = context.store.readTestEvidence(context.storyId);
      return evidence !== null && evidence.result === 'PASS';
    },
    allBugsFixed: ({ context }) => {
      const bugs = context.store.readBugs(context.storyId);
      return bugs.bugs.every(b => b.status === 'fixed');
    },
    allTestIntentsPass: ({ context }) => {
      const cl = context.store.readChecklist(context.storyId);
      for (const item of cl.items) {
        if (!item.testIntent) return false;
        for (const category of ['happy', 'edge', 'adversarial'] as const) {
          const entries = (item.testIntent as any)[category] || [];
          for (const entry of entries) {
            if (typeof entry === 'string') continue;
            if (!entry.results || entry.results.length === 0) return false;
            const last = entry.results[entry.results.length - 1];
            if (last.pass !== true) return false;
          }
        }
      }
      return true;
    },
    canFinish: ({ context }) => {
      const evidence = context.store.readTestEvidence(context.storyId);
      const hasEvidence = evidence !== null && evidence.result === 'PASS';
      const bugs = context.store.readBugs(context.storyId);
      const bugsOk = bugs.bugs.every(b => b.status === 'fixed');
      return hasEvidence && bugsOk;
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
        INIT_CHECK: { target: 'INIT_CHECK' },
      },
    },
    INIT_CHECK: {
      on: {
        PLAN: { target: 'PLAN' },
      },
    },
    PLAN: {
      on: {
        START: { target: 'DEV', guard: 'canStartDev' },
      },
    },
    DEV: {
      on: {
        WRITE_CASES: {
          target: 'TEST_CASE',
          guard: 'checklistAllDone',
        },
        REPLAN: {
          target: 'PLAN',
        },
      },
    },
    TEST_CASE: {
      on: {
        REQUEST_REVIEW: {
          target: 'TEST_CASE_REVIEW',
        },
        START: {
          target: 'DEV',
        },
      },
    },
    TEST_CASE_REVIEW: {
      on: {
        REVIEW: {
          target: 'TEST',
        },
        ROLLBACK_DEV: {
          target: 'DEV',
        },
        ROLLBACK_TEST_CASE: {
          target: 'TEST_CASE',
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
        ROLLBACK_TEST_CASE: {
          target: 'TEST_CASE',
        },
      },
    },
    DONE: {
      type: 'final',
    },
  },
});

export type StoryMachineSnapshot = SnapshotFrom<typeof storyMachine>;

/**
 * @task B-1dc6
 * @checklist CHK-001
 * @title Story lifecycle state machine remains the source of gate decisions
 * @type feature
 * @priority high
 * @description
 *   stack-layering 的边界原则要求 gate 的最终判定记录由 Koala 持有。
 *   createStoryActor 是 story 生命周期状态机的统一入口，负责把 phase transition
 *   与 guard 判定绑定到 Koala 自己的 machine/store，而不是交给外部 workflow
 *   自行定义。
 * @changes
 *   - [CHK-001] 把 story lifecycle state machine 与 gate 判定入口回链到 createStoryActor
 * @test high-gap-annotation-backfill
 */
export function createStoryActor(
  storyId: string,
  store: StoryStore,
  restoredState?: string,
) {
  const context: StoryMachineContext = { storyId, store };

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

export function getPhaseInvariantStatus(
  storyId: string,
  store: StoryStore,
  targetPhase: string,
): PhaseGateDecision {
  const issues: PhaseInvariantIssue[] = [];

  if (targetPhase === 'DEV') {
    const cl = store.readChecklist(storyId);
    // B-0af4 CHK-002: trivial-story 模式 — priority=low + checklist.length<=1
    // + type in [chore, refactor, docs] 的 story 跳过 testIntent.happy 要求。
    // 解决 B-5246 发现的问题：单 LLM observer 凑不齐三方制衡过不了这个 gate。
    // 注意：只跳 testIntent 要求，story_review 通过仍然强制。
    let isTrivial = false;
    try {
      const storyInfo = store.readStory(storyId) as any;
      const trivialTypes = ['chore', 'refactor', 'docs'];
      isTrivial =
        storyInfo?.priority === 'low' &&
        cl.items.length <= 1 &&
        trivialTypes.includes(storyInfo?.type);
    } catch { /* read fail → 按非 trivial 处理 */ }

    if (!isTrivial) {
      // happy 必填；edge/adversarial 选填（B-569d）
      const missingIntent = cl.items.filter((item: any) => {
        const ti = item.testIntent;
        if (ti === null) return false; // 显式标记不可测试，跳过
        return !ti || !Array.isArray(ti.happy) || ti.happy.length === 0;
      });
      if (missingIntent.length > 0) {
        issues.push({
          code: 'missing_test_intent_happy',
          detail: `${missingIntent.length} checklist item(s) 缺少 testIntent.happy: ${missingIntent.map((i: any) => i.id).join(', ')}`,
        });
      }
    }
    try {
      const review = store.readReview(storyId);
      if (!review || !review.reviews || review.reviews.length === 0) {
        issues.push({
          code: 'missing_story_review',
          detail: '未通过 story_review 审查（无审查记录）',
        });
      } else {
        const lastRound = review.reviews[review.reviews.length - 1];
        // 验证签名：防止主 agent 伪造 review.json
        const REVIEW_SALT = 'koala-review-integrity-v1';
        const hashInput = `${storyId}:${lastRound.timestamp}:${lastRound.issueCount}:${lastRound.blockerCount ?? lastRound.issueCount}:${REVIEW_SALT}`;
        const expectedHash = createHash('sha256').update(hashInput).digest('hex');
        if (!lastRound._hash || lastRound._hash !== expectedHash) {
          issues.push({
            code: 'invalid_story_review_signature',
            detail: 'review.json 签名校验失败，审查报告必须由 story_review CLI 生成',
          });
        } else if ((lastRound.blockerCount ?? lastRound.issueCount) > 0) {
          issues.push({
            code: 'story_review_blockers',
            detail: `最近一轮 story_review 有 ${lastRound.blockerCount ?? lastRound.issueCount} 个 blocker 未修复`,
          });
        }
      }
    } catch {
      issues.push({
        code: 'missing_story_review',
        detail: '未通过 story_review 审查（无审查记录）',
      });
    }
  }

  if (targetPhase === 'TEST_CASE') {
    const cl = store.readChecklist(storyId);
    // B-5010 CHK-002: 只要求 phase!=='TEST_CASE' 的 item 已 done（即 DEV 阶段工作）。
    // phase==='TEST_CASE' 的 item（fixture 编写 / perf sanity 等）本来就是 TEST_CASE
    // 阶段的工作，不该在进入前强制 done，否则只能"先撒谎 mark done 再做"。
    const devPhaseItems = cl.items.filter((i: any) => (i.phase || 'DEV') !== 'TEST_CASE');
    const pending = devPhaseItems.filter(i => i.status !== 'done');
    if (pending.length > 0) {
      issues.push({
        code: 'pending_dev_checklist_items',
        detail: `${pending.length} DEV-phase checklist item(s) not done: ${pending.map(i => i.id).join(', ')}`,
      });
    }
  }

  if (targetPhase === 'TEST') {
    const cl = store.readChecklist(storyId);
    const failures: Array<{ itemId: string; category: string; desc: string; type: string }> = [];
    for (const item of cl.items) {
      if (!item.testIntent) {
        failures.push({ itemId: item.id, category: '*', desc: 'missing testIntent', type: 'cli_blackbox' });
        continue;
      }
      for (const category of ['happy', 'edge', 'adversarial'] as const) {
        const entries = (item.testIntent as any)[category] || [];
        for (const entry of entries) {
          if (typeof entry === 'string') {
            failures.push({ itemId: item.id, category, desc: entry, type: 'cli_blackbox' });
            continue;
          }
          if (!entry.results || entry.results.length === 0) {
            failures.push({ itemId: item.id, category, desc: entry.desc, type: entry.type || 'cli_blackbox' });
            continue;
          }
          const last = entry.results[entry.results.length - 1];
          if (last.pass !== true) {
            failures.push({ itemId: item.id, category, desc: entry.desc, type: entry.type || 'cli_blackbox' });
          }
        }
      }
    }
    if (failures.length > 0) {
      const detail = failures.map(f => `  - ${f.itemId}:${f.category} [${f.type}] ${f.desc}`).join('\n');
      issues.push({
        code: 'testintent_not_passed',
        detail: `${failures.length} testIntent(s) not passed:\n${detail}`,
      });
    }
  }

  if (targetPhase === 'DONE') {
    const evidence = store.readTestEvidence(storyId);
    if (!evidence) {
      issues.push({
        code: 'missing_test_evidence',
        detail: 'no test evidence found',
      });
    }
    if (evidence && evidence.result !== 'PASS') {
      issues.push({
        code: 'test_not_passed',
        detail: `test ${evidence.result}: ${evidence.output}`,
      });
    }
    const bugs = store.readBugs(storyId);
    const openBugs = bugs.bugs.filter(b => b.status !== 'fixed');
    if (openBugs.length > 0) {
      issues.push({
        code: 'open_bugs',
        detail: `${openBugs.length} unfixed bug(s): ${openBugs.map(b => b.id).join(', ')}`,
      });
    }
  }

  return buildPhaseGateDecision({
    storyId,
    targetPhase,
    issues,
  });
}

export function getGuardFailureReason(
  storyId: string,
  store: StoryStore,
  targetPhase: string,
): string | null {
  return formatPhaseGateDecision(getPhaseInvariantStatus(storyId, store, targetPhase));
}
