/**
 * B-56d3 (Lifecycle Phase 2, Story 3a): transition-effects — the non-DONE
 * transition side effects of story_advance.
 *
 * The effect bodies were mechanically relocated here from
 * handlers/story-advance.ts with ZERO semantic change — effect order, output
 * text, and timing are byte-identical before and after the move (preMortem
 * #3). After the B-6974 refactor, handlers/transition-orchestrator.ts is the
 * direct caller: its runStoryTransition delegates to these functions in the
 * exact same order story-advance.ts ran them inline.
 *
 * What lives here:
 *   - recomputeProcessMetrics — process metrics write (writeProcessMetrics)
 *   - runPhaseChangeHooks     — onPhaseChange hooks (runHooks)
 *   - commitReviewMetadata    — REVIEW metadata auto-commit (autoCommitStoryMetadata)
 *   - renderRelatedDocsHint   — relatedDocs reminder hint emission
 *   - buildNextSteps          — next-step rendering map
 *
 * NOT here: DONE merge / worktree cleanup — that lives in done-effects.ts
 * (Story 3b). This module only owns the non-DONE effects.
 *
 * Layering: this module lives in handlers/ (NOT core/) on purpose. It depends
 * on handler-only modules (reviewer-list.ts). A core/ module importing those
 * would be a core→handlers layer violation, so transition-effects.ts is placed
 * alongside them in handlers/. It must NOT import handlers/story-advance.js
 * (no circular import — preMortem #2); transition-orchestrator imports
 * transition-effects, never the reverse.
 */

import type { StoryStore } from '../core/store.js';
import type { StoryPhase } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import { computeChannel, CHANNEL_LABELS } from '../core/workflow-policy.js';
import { computeProcessMetrics } from '../core/process-metrics.js';
import { runHooks, buildHookEnv } from '../core/hooks.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { detectMdTouchpointsFromGit } from '../core/touchpoints-fallback.js';
import { computeActiveReviewers, renderActiveReviewersText } from './reviewer-list.js';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * process metrics write.
 *
 * B-abd8: auto-recompute process metrics on DEV/TEST/DONE transitions.
 * DEV included so fast-channel stories get initial metrics. The caller is
 * responsible for restricting this to DEV/TEST/DONE — this function runs
 * unconditionally when called (same as the inline `try { ... } catch` block).
 */
export function recomputeProcessMetrics(storyId: string, store: StoryStore, root: string): void {
  try {
    const pm = computeProcessMetrics(storyId, store, root);
    store.writeProcessMetrics(storyId, pm);
  } catch (e) {
    console.warn(`[process-metrics] recompute failed for ${storyId}:`, (e as Error).message);
  }
}

/**
 * onPhaseChange hook — fires after the new phase is persisted, so the hook can
 * read the up-to-date story state. Failures are non-blocking. Uses the shared
 * buildHookEnv helper so KOALA_ARGS_JSON / KOALA_STORY_ID / KOALA_PHASE stay
 * consistent with the cli-engine code path.
 */
export async function runPhaseChangeHooks(
  root: string,
  storyId: string,
  args: unknown,
  oldPhase: string,
  newState: string,
): Promise<void> {
  try {
    const cfg = loadConfig(root);
    const env = buildHookEnv({
      stage: 'onPhaseChange',
      command: 'story_advance',
      // B-9d95 CHK-001 whitelist: hook 执行上下文——hook 子进程需继承调用方真实 cwd（用户 shell 的当前目录）
      // 而非 ctx.root，否则 hook 脚本看不到调用方的 worktree。这是 hook 协议约定（详见 buildHookEnv docs）。
      cwd: process.cwd(),
      root,
      argsJson: JSON.stringify(args),
      storyId,
      phase: newState,
      extra: {
        KOALA_OLD_PHASE: oldPhase,
        KOALA_NEW_PHASE: newState,
      },
    });
    await runHooks('onPhaseChange', `${oldPhase}->${newState}`, env, cfg, root);
  } catch { /* runHooks itself never throws, but defensive */ }
}

/**
 * REVIEW metadata auto-commit.
 *
 * Returns the auto-commit report string (empty string when nothing to commit).
 * The caller is responsible for only calling this on the REVIEW transition —
 * same as the inline `if (args.phase === 'REVIEW') { ... }` guard.
 */
export function commitReviewMetadata(root: string, storyId: string, phase: StoryPhase): string {
  return autoCommitStoryMetadata(root, storyId, phase);
}

/**
 * CHK-002: PLAN→DEV 时收集所有 relatedDocs 列出来作为开工提醒。
 * B-45ed CHK-008: PLAN→DEV 和 DONE 的 docsHint 统一含 background.md。
 *
 * Returns the docs-hint string (empty string when there are no related docs).
 * The caller is responsible for only calling this on DEV / DONE transitions —
 * same as the inline `if (args.phase === 'DEV' || args.phase === 'DONE')`.
 */
export function renderRelatedDocsHint(
  store: StoryStore,
  root: string,
  storyId: string,
  phase: StoryPhase,
): string {
  let docsHint = '';
  try {
    const cl = store.readChecklist(storyId);
    const docMap = new Map<string, string[]>(); // doc → [itemId]
    for (const it of cl.items) {
      const docs = it.relatedDocs;
      if (Array.isArray(docs)) {
        for (const d of docs) {
          if (!docMap.has(d)) docMap.set(d, []);
          docMap.get(d)!.push(it.id);
        }
      }
    }
    // B-45ed CHK-008: background.md 若存在且未出现 → 追加到 docMap（用 special 标签标记来源）
    const bgRel = `${store.storyDirRel()}/${storyId}/background.md`;
    const bgAbs = join(root, bgRel);
    if (existsSync(bgAbs) && !docMap.has(bgRel)) {
      docMap.set(bgRel, ['(story background)']);
    }
    if (docMap.size > 0) {
      const lines: string[] = [];
      for (const [d, items] of docMap.entries()) {
        lines.push(`  - ${d}  (${items.join(', ')})`);
      }
      const header = phase === 'DEV'
        ? '📄 本 story 关联文档（改代码时注意同步）:'
        : '📄 本 story 关联文档（DONE 收尾前核对是否已同步）:';
      docsHint = `\n\n${header}\n${lines.join('\n')}`;
    }
  } catch { /* ignore */ }
  return docsHint;
}

/**
 * next-step rendering map.
 *
 * Builds the per-phase next-step guidance map keyed by the new machine state.
 * The DEV and REVIEW entries are computed lazily (channel detection / opt-in
 * reviewer list) exactly as the inline IIFEs did. transition-orchestrator.ts
 * indexes the returned record with `nextSteps[newState]`.
 */
export function buildNextSteps(
  store: StoryStore,
  root: string,
  storyId: string,
): Record<string, string> {
  return {
    PLAN: `→ 建议立即切到 Claude Code plan 模式（shift-tab 两次到 plan mode）——PLAN 阶段只拆 checklist / 写 understanding_set / decision_set，不应改代码。Edit/Write 被 plan mode 禁掉能防误触。
→ 下一步: checklist_get(${storyId}) 查看待开发项，然后 story_advance(${storyId}, DEV) 开始开发
⚠ 用户价值验收（强制）: understanding_set 的 outcome 字段必须写成一段具体的 user-facing transcript ——用户跑完这个 story 后会在终端/UI 看到的精确文字，不是 "事件 X 通了" 这种抽象描述。判定方法: outcome 读起来必须能让人想象出"用户什么时候说'好了搞定'"的那一刻。详见 CLAUDE.md「用户价值验收」段。`,
    DEV: (() => {
      // B-45ed CHK-004: 实时算三档通道（express/fast/normal）
      let channel: 'express' | 'fast' | 'normal' = 'normal';
      try {
        const s = store.readStory(storyId);
        const cl = store.readChecklist(storyId);
        let decision = null;
        try { decision = store.readDecision(storyId); } catch {}
        channel = computeChannel(s, cl, decision);
      } catch {}
      if (channel === 'express') {
        return `→ 极速通道（${CHANNEL_LABELS.express}，≤2 项，无 riskSignals）：主 agent 自己写代码 + 写测试，只需 checklist。
→ 完成后 story_advance(${storyId}, REVIEW) 进入代码审查`;
      }
      if (channel === 'fast') {
        return `→ 快速通道（${CHANNEL_LABELS.fast}，≤5 项，单一解，无 riskSignals）：主 agent 可自己写代码，省 decision + plan.md，保留 understanding。
→ 完成后 story_advance(${storyId}, REVIEW) 进入代码审查`;
      }
      return `→ 正常通道（${CHANNEL_LABELS.normal}）：必须启动 koala-implementer subagent 写代码，主 agent 不要自己改业务代码。
→ 用 Agent({ subagent_type: "koala-implementer", prompt: "..." }) 分配任务
→ subagent 写完提交后，主 agent 验收合并，然后 story_advance(${storyId}, REVIEW)
→ sub agent 不要使用 isolation:"worktree"，直接在主 agent 的 worktree 中跑
⚠ REVIEW 阶段 koala-reviewer 会检查 commit author——正常通道如果全是主 agent 自己写的代码会被提 critical finding`;
    })(),
    REVIEW: (() => {
      // B-fdcf CHK-002: 按 opt-in 名单动态 echo（channel LLM reviewer 退役后不再固定 5 个）。
      let activeLine = 'Active reviewers: concept, quality (fallback: 无法解析 opt-in 名单，按 baseline)';
      let agentLines = '';
      try {
        const story = store.readStory(storyId);
        let checklistForReview: { items: unknown[] } = { items: [] };
        try { checklistForReview = store.readChecklist(storyId); } catch { /* none */ }
        let decisionForReview = null;
        try { decisionForReview = store.readDecision(storyId); } catch { /* none */ }
        const understandingForReview = store.readUnderstanding(storyId);
        const touchpointsForReview = understandingForReview?.touchpoints
          ?? detectMdTouchpointsFromGit(root);
        const active = computeActiveReviewers(
          story,
          checklistForReview,
          decisionForReview,
          touchpointsForReview,
        );
        activeLine = renderActiveReviewersText(active);
        agentLines = active.map(r =>
          `  Agent({ subagent_type: "koala-review-${r.name}", prompt: "审查 story ${storyId} (${r.reason})" })`,
        ).join('\n');
      } catch {
        agentLines = `  Agent({ subagent_type: "koala-review-concept", prompt: "审查 story ${storyId}" })
  Agent({ subagent_type: "koala-review-quality", prompt: "审查 story ${storyId}" })`;
      }
      return `→ ${activeLine}
→ 并行启动上述 reviewer 审查代码（在同一条消息里发出所有 Agent 调用）：
${agentLines}
→ reviewer liveness：每个 reviewer 启动后应先输出 REVIEW_START:<reviewer>；4 分钟无输出先问状态，10 分钟/600s 无结果视为 stalled，重启该 reviewer 并在 retry prompt 中注明前一次 stalled
→ 全部回来后 koala finding_list 汇总
→ critical/high 全 resolved 后：story_advance(${storyId}, TEST)
→ 需要改代码：story_advance(${storyId}, DEV) 回 DEV
⚠ reviewer 调 finding_add 时必须传 agent 参数（如 "agent":"koala-review-behavior"），否则 finding 会被标记为 main agent，TEST gate 会拒绝推进`;
    })(),
    TEST_CASE: `→ Legacy phase. 建议直接 story_advance(${storyId}, TEST) 进入验证`,
    TEST_CASE_REVIEW: `→ Legacy phase. 建议直接 story_advance(${storyId}, TEST) 进入验证`,
    TEST: `→ 必须立即执行: koala validate 跑验证，写 bug/evidence。fail 自动 aux_diagnose + bug_report，pass 自动标 bug fixed。
⚠ 工程验证 ≠ 用户验收: 即使 validate 全 pass，也必须用用户视角真机跑一次（节奏: 把 PLAN outcome 当 expected → 跑 → 把实际输出当 actual → diff）。验证完把 actual transcript + 差异说明放到 ${store.storyDirRel()}/${storyId}/evidence/transcript-diff.md。CLAUDE.md「用户价值验收」段有完整 5 题自检清单。
⚠ delivery-check 硬门槛: DONE 前必须 spawn koala-review-delivery reviewer 写 delivery-check.json 签名。reviewer 逆向扫 git diff 验证文档承诺落地 + 真机测试覆盖。未签名 → story_advance DONE 会卡 [missing_delivery_check]。`,
    DONE: `→ 必须立即执行: 把下面的 Story 总结段落用你自己的话告诉用户（改了什么/怎么用/真机覆盖/限制/踩坑），然后 convergence_check 检查项目收敛状态
⚠ DONE 自检 5 题（CLAUDE.md「用户价值验收」段）: (1) PLAN outcome 是具体 transcript 还是抽象? (2) 真机测试时读了用户视角输出还是只看事件日志? (3) 用户看到 actual transcript 最后一行会说"完成"还是"然后呢"? (4) 有没有工程 log 在用户眼里是噪音/重复? (5) 有没有一句人话总结任务结果? 任何一题答"没做到"就回 DEV，不要硬推 DONE。`,
  };
}
