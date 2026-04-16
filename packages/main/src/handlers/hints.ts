/**
 * Result hint registry — 给每个 state-mutating 命令的成功返回追加 next-step 提示
 *
 * 设计目的：
 *   CC 的 TodoWrite 每次返回都强化 "Continue to use the todo list..."。
 *   koala 现在只有 story_advance 在返回里加 hint，其它命令成功后 agent
 *   只能猜下一步该做什么，猜错就跳过流程。
 *
 * 用法：
 *   - 每个命令对应一个 HintFn，根据 (args, result, store 状态) 推导出下一步提示
 *   - cli-engine 在 run() 函数里 import decorateResult，handler 返回后调用
 *   - hint 函数返回 null → 不追加；返回 string → 追加到结果尾部
 *
 * 设计约束：
 *   - hint 函数不能抛错。store 查询失败时降级返回 null。
 *   - hint 函数不要做副作用（不要 write store / spawn process）。
 *   - hint 文本要短，不要超过 5 行。
 */

import type { StoryStore } from '../core/store.js';

export interface ActiveStoryInfo {
  storyId: string;
  phase: string;
}

export interface HintContext {
  /** 命令名，如 "checklist_update" */
  cmd: string;
  /** 解析后的参数 */
  args: Record<string, unknown>;
  /** handler 返回值（string 或 object） */
  result: unknown;
  /** Store 实例（用于查询当前状态） */
  store: StoryStore;
  /** 项目根 */
  root: string;
  /** 当前 active story（来自 git 分支） */
  activeStory: ActiveStoryInfo | null;
}

export type HintFn = (ctx: HintContext) => string | null;

// ── helpers ──

function safeRead<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

function getStoryId(ctx: HintContext): string | null {
  const fromArgs = (ctx.args.storyId ?? ctx.args.id) as string | undefined;
  if (fromArgs && typeof fromArgs === 'string' && /^[A-Z]-/.test(fromArgs)) return fromArgs;
  if (ctx.activeStory) return ctx.activeStory.storyId;
  return null;
}

function getStory(ctx: HintContext, storyId: string) {
  return safeRead(() => ctx.store.readStory(storyId));
}

function getChecklist(ctx: HintContext, storyId: string) {
  return safeRead(() => ctx.store.readChecklist(storyId));
}

function getBugs(ctx: HintContext, storyId: string) {
  return safeRead(() => ctx.store.readBugs(storyId));
}

interface ChecklistSummary {
  total: number;
  done: number;
  inProgress: number;
  pending: number;
  inProgressIds: string[];
  pendingIds: string[];
  allDone: boolean;
}

function summarizeChecklist(cl: { items: Array<{ id: string; status: string }> } | null): ChecklistSummary | null {
  if (!cl || !Array.isArray(cl.items)) return null;
  const summary: ChecklistSummary = {
    total: cl.items.length,
    done: 0,
    inProgress: 0,
    pending: 0,
    inProgressIds: [],
    pendingIds: [],
    allDone: false,
  };
  for (const it of cl.items) {
    if (it.status === 'done') summary.done++;
    else if (it.status === 'in_progress') {
      summary.inProgress++;
      summary.inProgressIds.push(it.id);
    } else {
      summary.pending++;
      summary.pendingIds.push(it.id);
    }
  }
  summary.allDone = summary.total > 0 && summary.done === summary.total;
  return summary;
}

// ── hint 函数 ──

const checklistUpdateHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  const args = ctx.args as { itemId?: string; status?: string; testIntent?: unknown };
  const cl = getChecklist(ctx, storyId);
  const story = getStory(ctx, storyId);
  if (!cl) return null;
  const summary = summarizeChecklist(cl);
  if (!summary) return null;

  // testIntent 更新分支
  if (args.testIntent !== undefined && !args.status) {
    const missingIntent = cl.items.filter((i: any) => !i.testIntent).length;
    if (missingIntent > 0) {
      return `→ testIntent 已记录。还有 ${missingIntent} 个 item 待补 testIntent，全部填完后跑 story_review`;
    }
    return `→ 所有 item 的 testIntent 已就绪。下一步：story_review --storyId=${storyId} 对抗审查`;
  }

  // status → in_progress
  if (args.status === 'in_progress') {
    return `→ 标记为 in_progress。开始写代码/写 fixture，完成后再次 checklist_update --status=done`;
  }

  // status → done
  if (args.status === 'done') {
    if (summary.allDone) {
      const phase = story?.phase ?? '';
      if (phase === 'DEV') {
        return `→ 所有 ${summary.total} 个 checklist item 已 done。下一步：如需本地 git commit，未经用户 confirm 不允许；确认后再提交当前改动，并 story_advance --storyId=${storyId} --phase=TEST_CASE 进入测试编写`;
      }
      if (phase === 'TEST_CASE') {
        return `→ 所有 item 已 done。下一步：如需本地 git commit fixture，未经用户 confirm 不允许；确认后再提交，并 story_advance --storyId=${storyId} --phase=TEST_CASE_REVIEW 进入审核`;
      }
      return `→ 所有 ${summary.total} 个 item 已 done。下一步：如需本地 git commit，未经用户 confirm 不允许；确认后再提交并 story_advance 推进到下一阶段`;
    }
    if (summary.inProgress > 0) {
      return `→ 还有 ${summary.inProgress} 个 in_progress item（${summary.inProgressIds.slice(0, 3).join(', ')}），继续完成它们`;
    }
    if (summary.pending > 0) {
      return `→ 完成 ${summary.done}/${summary.total}。下一项：checklist_update --storyId=${storyId} --itemId=${summary.pendingIds[0]} --status=in_progress`;
    }
  }

  return null;
};

const checklistAddHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  return `→ 新 item 已加入 checklist。下一步：让 test-intent agent 为这条 item 补 testIntent，然后跑 story_review`;
};

const fixtureBatchAddHint: HintFn = (ctx) => {
  if ((ctx.args as { dryRun?: boolean }).dryRun) {
    return `→ 这是 dry-run 预览。确认计划无误后，去掉 --dry-run 再真实执行`;
  }
  const storyId = getStoryId(ctx) ?? ctx.activeStory?.storyId;
  if (!storyId) return `→ Fixture cases 已添加。继续添加更多 case，或 story_advance phase=TEST_CASE_REVIEW 进入审核`;
  const story = getStory(ctx, storyId);
  const phase = story?.phase ?? '';
  if (phase === 'TEST_CASE') {
    return `→ Fixture cases 已添加。若要本地 git commit fixture，未经用户 confirm 不允许；确认后建议先提交，再跑 test_story --storyId=${storyId} 本地验证一遍，然后 story_advance --storyId=${storyId} --phase=TEST_CASE_REVIEW`;
  }
  if (phase === 'DEV') {
    return `→ Fixture cases 已添加。注意当前还在 DEV 阶段，应先 story_advance phase=TEST_CASE 后再写 fixture（已写的不会丢，但流程上反了）`;
  }
  return `→ Fixture cases 已添加。下一步：先 test_story 验证；如需本地 git commit，未经用户 confirm 不允许；确认后再提交并 story_advance 推进`;
};

const fixtureUpdateHint: HintFn = (ctx) => {
  return `→ Fixture 已更新。下一步：先用 test_fixture 确认改动正确；如需本地 git commit，未经用户 confirm 不允许`;
};

const storyCreateHint: HintFn = (ctx) => {
  // 注意：story_create 在 cli-engine.ts 已有 INIT 路径的特殊 wrapper（贴 worktree 流程），
  // 这里只补充 IDEA 路径（无 checklist）和直接 phase 路径的提示。
  const result = ctx.result;
  if (typeof result !== 'string') return null;
  if (result.includes('(INIT)')) return null; // 已有 wrapper 处理
  if (result.includes('(IDEA)')) {
    const m = result.match(/Story\s+([\w-]+)/);
    const sid = m ? m[1] : 'B-xxx';
    return `→ Story 停在 IDEA 阶段（无 checklist）。下一步：和用户讨论 checklist 后用 checklist_add 追加，或重新 story_create 时带上 checklist 字段`;
  }
  if (result.includes('(DONE)')) {
    return `→ Story 直接创建在 DONE 阶段（onboard 模式）。已无后续步骤`;
  }
  return null;
};

const bugReportHint: HintFn = (ctx) => {
  const args = ctx.args as { storyId?: string; id?: string; fixtureId?: string };
  if (!args.fixtureId) {
    return `→ Bug 已记录但未关联 fixtureId。建议在写 fixture case 后用同一 id 重新 bug_report 并传 fixtureId，否则 bug_update fixed 时无法验证`;
  }
  return `→ Bug 已记录（fixtureId=${args.fixtureId}）。修复后跑 test_fixture --fixtureId=${args.fixtureId}，pass 后用 bug_update --status=fixed 自动验证`;
};

const bugUpdateHint: HintFn = (ctx) => {
  const args = ctx.args as { storyId?: string; status?: string };
  if (args.status !== 'fixed') return null;
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  const bugs = getBugs(ctx, storyId);
  if (!bugs) return null;
  const open = bugs.bugs.filter((b: any) => b.status === 'open');
  if (open.length === 0) {
    const story = getStory(ctx, storyId);
    if (story?.phase === 'TEST') {
      return `→ 所有 bug 已 fixed。下一步：先 story_advance --storyId=${storyId} --phase=DONE --dryRun 预览；确认后再带 --confirm 完成 story`;
    }
    return `→ 所有 bug 已 fixed。继续推进 story 流程`;
  }
  return `→ 还有 ${open.length} 个 open bug：${open.slice(0, 3).map((b: any) => b.id).join(', ')}。继续修复`;
};

const testintentRecordHint: HintFn = (ctx) => {
  const args = ctx.args as { storyId?: string; pass?: boolean; agent?: string };
  const storyId = getStoryId(ctx);
  if (!storyId) return null;

  // pass=false → 强引导回 DEV
  if (args.pass === false) {
    return `→ Reviewer fail 记录。回到 DEV 改代码或改 fixture（不是改 testIntent 描述）：story_advance --storyId=${storyId} --phase=DEV`;
  }

  // pass=true 或 纯回复 → 提示是否继续审 / 是否所有都过了
  if (args.pass === true) {
    // 调 testintent_check 看完整状态
    const handlersPath = null; // 不在 hint 里调 handler，避免循环
    return `→ Reviewer pass 记录。下一步：testintent_check --storyId=${storyId} 看是否全部 reviewer pass，全过则 story_advance --phase=TEST`;
  }

  // 纯回复（无 pass）
  return `→ 已追加回复。等待 reviewer 下一轮裁定`;
};

const testintentResumeHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  return `→ 5 轮 cap 已重置，可以继续 testintent_record。注意：人类介入意味着前 5 轮没达成共识，先反思 testIntent 描述本身或 checklist 拆解是否有问题`;
};

const understandingSetHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  const args = ctx.args as { unknowns?: string[] };
  if (Array.isArray(args.unknowns) && args.unknowns.length > 0) {
    return `→ Understanding 已记录但有 ${args.unknowns.length} 个 unknown。建议先调研消化 unknown，再开拆 checklist`;
  }
  return `→ Understanding 已记录。下一步：开拆 checklist（每条 title + context + relatedDocs），然后让 test-intent agent 补 testIntent`;
};

const decisionSetHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  return `→ Decision 已落档。下一步：根据 chosen option 拆 checklist item（title 描述"做什么"，context 引用 decision 中的 rationale）`;
};

const devStartHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  return `→ Worktree 已创建。立即 cd 到上述路径，然后 story_advance --storyId=${storyId} --phase=PLAN 进入 PLAN（不 cd 会被 cwd gate 拒绝）`;
};

const devFinishHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return `→ Story 已进入 TEST。跑 test_story 验证；若后续要自动收尾，先 dry-run 再 confirm 调 dev_merge`;
  return `→ Story 已进入 TEST。先跑 test_story --storyId=${storyId} 验证；若后续要自动收尾，先 dry-run 再 confirm 调 dev_merge(${storyId})`;
};

const storyDiscardHint: HintFn = (ctx) => {
  if ((ctx.args as { dryRun?: boolean }).dryRun) {
    return `→ 这是 dry-run 预览。确认计划无误后，使用 --confirm 真实执行 discard`;
  }
  return `→ Story 已废弃，worktree 和分支已清理。改动如果还想保留，请在被 discard 之前手动 cherry-pick 到其它分支`;
};

// ── registry ──

const HINTS: Record<string, HintFn> = {
  checklist_update: checklistUpdateHint,
  checklist_add: checklistAddHint,
  fixture_batch_add: fixtureBatchAddHint,
  fixture_update: fixtureUpdateHint,
  story_create: storyCreateHint,
  bug_report: bugReportHint,
  bug_update: bugUpdateHint,
  testintent_record: testintentRecordHint,
  testintent_resume: testintentResumeHint,
  understanding_set: understandingSetHint,
  decision_set: decisionSetHint,
  dev_start: devStartHint,
  dev_finish: devFinishHint,
  story_discard: storyDiscardHint,
};

/** 测试用：返回所有已注册命令名 */
export function listHintCommands(): string[] {
  return Object.keys(HINTS);
}

/**
 * 装饰命令返回值：尝试追加 next-step 提示。
 *
 * - result 是 string → 在末尾拼 `\n→ <hint>`（如已含"→"则跳过避免重复）
 * - result 是 object → 写入 `_nextStep` 字段
 * - hint 函数返回 null 或抛错 → 原样返回 result
 */
export function decorateResult(ctx: HintContext): unknown {
  const fn = HINTS[ctx.cmd];
  if (!fn) return ctx.result;
  let hint: string | null = null;
  try {
    hint = fn(ctx);
  } catch {
    return ctx.result;
  }
  if (!hint) return ctx.result;

  const result = ctx.result;
  if (typeof result === 'string') {
    // 避免和 handler 自己写的 hint 重复（story_advance、checklist_update relatedDocs 等会自带 → 标记）
    if (result.includes(hint)) return result;
    return `${result}\n${hint}`;
  }
  if (result && typeof result === 'object') {
    return { ...(result as Record<string, unknown>), _nextStep: hint };
  }
  return result;
}
