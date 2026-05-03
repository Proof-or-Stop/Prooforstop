/**
 * Result hint registry — 给每个 state-mutating 命令的成功返回追加 next-step 提示
 *
 * hint 函数是纯函数：不抛错、不做副作用、不写 store。
 * 返回 null → 不追加；返回 string → 追加到结果尾部。
 */

import type { StoryStore } from '../core/store.js';

export interface ActiveStoryInfo {
  storyId: string;
  phase: string;
}

export interface HintContext {
  cmd: string;
  args: Record<string, unknown>;
  result: unknown;
  store: StoryStore;
  root: string;
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
    total: cl.items.length, done: 0, inProgress: 0, pending: 0,
    inProgressIds: [], pendingIds: [], allDone: false,
  };
  for (const it of cl.items) {
    if (it.status === 'done') summary.done++;
    else if (it.status === 'in_progress') { summary.inProgress++; summary.inProgressIds.push(it.id); }
    else { summary.pending++; summary.pendingIds.push(it.id); }
  }
  summary.allDone = summary.total > 0 && summary.done === summary.total;
  return summary;
}

// ── hint 函数 ──

const checklistUpdateHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  const args = ctx.args as { status?: string };
  const cl = getChecklist(ctx, storyId);
  const story = getStory(ctx, storyId);
  if (!cl) return null;
  const summary = summarizeChecklist(cl);
  if (!summary) return null;

  if (args.status === 'in_progress') {
    return `→ 标记为 in_progress。写代码，完成后 git commit + checklist_update --status=done`;
  }

  if (args.status === 'done') {
    if (summary.allDone) {
      const phase = story?.phase ?? '';
      if (phase === 'DEV') {
        return `→ 所有 ${summary.total} 个 item 已 done。下一步：git commit，然后 story_advance --storyId=${storyId} --phase=REVIEW 进入代码审查`;
      }
      return `→ 所有 ${summary.total} 个 item 已 done。下一步：git commit + story_advance 推进到下一阶段`;
    }
    if (summary.inProgress > 0) {
      return `→ 还有 ${summary.inProgress} 个 in_progress item（${summary.inProgressIds.slice(0, 3).join(', ')}），继续完成`;
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
  return `→ 新 item 已加入 checklist。下一步：跑 story_review 审查完整性`;
};

const storyCreateHint: HintFn = (ctx) => {
  const result = ctx.result;
  if (typeof result !== 'string') return null;
  if (result.includes('(INIT)')) return null; // cli-engine wrapper 已处理
  if (result.includes('(IDEA)')) {
    return `→ Story 停在 IDEA（无 checklist）。下一步：checklist_add 追加，或重新 story_create 带 checklist`;
  }
  if (result.includes('(DONE)')) {
    return `→ Story 直接创建在 DONE（onboard 模式）。已无后续步骤`;
  }
  return null;
};

const bugReportHint: HintFn = (ctx) => {
  return `→ Bug 已记录。修复后跑 koala validate 验证，然后 bug_update --status=fixed`;
};

const bugUpdateHint: HintFn = (ctx) => {
  const args = ctx.args as { status?: string };
  if (args.status !== 'fixed') return null;
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  const bugs = getBugs(ctx, storyId);
  if (!bugs) return null;
  const open = bugs.bugs.filter((b: any) => b.status === 'open');
  if (open.length === 0) {
    const story = getStory(ctx, storyId);
    if (story?.phase === 'TEST') {
      return `→ 所有 bug 已 fixed。下一步：story_advance --storyId=${storyId} --phase=DONE`;
    }
    return `→ 所有 bug 已 fixed。继续推进 story`;
  }
  return `→ 还有 ${open.length} 个 open bug：${open.slice(0, 3).map((b: any) => b.id).join(', ')}。继续修复`;
};

const understandingSetHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  const args = ctx.args as { unknowns?: string[] };
  if (Array.isArray(args.unknowns) && args.unknowns.length > 0) {
    return `→ Understanding 已记录但有 ${args.unknowns.length} 个 unknown。建议先调研消化 unknown，再开拆 checklist`;
  }
  return `→ Understanding 已记录。下一步：拆 checklist（title + context + relatedDocs），然后 story_review`;
};

const decisionSetHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  return `→ Decision 已落档。下一步：根据 chosen option 拆 checklist item`;
};

const devStartHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  return `→ Worktree 已创建。cd 到上述路径，然后 story_advance --storyId=${storyId} --phase=PLAN`;
};

const devFinishHint: HintFn = (ctx) => {
  return `→ Worktree 已合并回 main。可以开始下一个 story 或 git push`;
};

const storyDiscardHint: HintFn = (ctx) => {
  const result = String(ctx.result || '');
  if (result.includes('⚠')) {
    return `→ Story discard 已执行，但存在未清理项；按上方 warning 处理后重试`;
  }
  if (result.includes('Story metadata 已清理')) {
    return `→ 临时 Story metadata 已清理；如上方提示未回退 init commit，请按提示手动确认`;
  }
  return `→ Story discard 已完成；清理明细以上方输出为准`;
};

const validateHint: HintFn = (ctx) => {
  const result = String(ctx.result || '');
  let parsed: any = null;
  try {
    parsed = JSON.parse(result);
  } catch { /* non-json validate output */ }
  if (parsed && parsed.allPass === false) {
    const missing = parsed.verificationCoverage?.missingRequired;
    if (typeof missing === 'number' && missing > 0) {
      const storyId = getStoryId(ctx);
      const stale = Array.isArray(parsed.verificationCoverage?.entries)
        ? parsed.verificationCoverage.entries.filter((e: any) => e.status === 'stale').length
        : 0;
      return stale > 0 && storyId
        ? `→ 验证命令通过，但 verification evidence 有 ${stale} 项 stale。下一步：verification_evidence_refresh_stale --storyId=${storyId}，然后重跑 koala validate --story=${storyId} --json`
        : `→ 验证未通过：verification coverage 缺 ${missing} 项 required intent。补 evidence 后重跑 koala validate`;
    }
    return `→ 验证未通过。按上方 details 修复后重跑 koala validate`;
  }
  if (parsed ? parsed.allPass === true : (result.includes('allPass') && result.includes('true'))) {
    const storyId = getStoryId(ctx);
    if (storyId) {
      return `→ 验证全绿。下一步：story_advance --storyId=${storyId} --phase=DONE`;
    }
    return `→ 验证全绿。可以提交`;
  }
  return null;
};

// ── registry ──

const HINTS: Record<string, HintFn> = {
  checklist_update: checklistUpdateHint,
  checklist_add: checklistAddHint,
  story_create: storyCreateHint,
  bug_report: bugReportHint,
  bug_update: bugUpdateHint,
  understanding_set: understandingSetHint,
  decision_set: decisionSetHint,
  dev_start: devStartHint,
  dev_finish: devFinishHint,
  story_discard: storyDiscardHint,
  validate: validateHint,
};

export function listHintCommands(): string[] {
  return Object.keys(HINTS);
}

/**
 * 装饰命令返回值：尝试追加 next-step 提示。
 */
export function decorateResult(ctx: HintContext): unknown {
  const fn = HINTS[ctx.cmd];
  if (!fn) return ctx.result;
  let hint: string | null = null;
  try { hint = fn(ctx); } catch { return ctx.result; }
  if (!hint) return ctx.result;

  const result = ctx.result;
  if (typeof result === 'string') {
    if (result.includes(hint)) return result;
    return `${result}\n${hint}`;
  }
  if (result && typeof result === 'object') {
    return { ...(result as Record<string, unknown>), _nextStep: hint };
  }
  return result;
}
