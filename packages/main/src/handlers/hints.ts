/**
 * Result hint registry — 给每个 state-mutating 命令的成功返回追加 next-step 提示
 *
 * hint 函数是纯函数：不抛错、不做副作用、不写 store。
 * 返回 null → 不追加；返回 string → 追加到结果尾部。
 */

import type { StoryStore } from '../core/store.js';
import { findStaleEvidence, renderEvidenceStaleHint } from '../core/evidence-stale-hint.js';
import { currentGitHead } from '../core/evidence-freshness.js';
import { isDeliveredChecklistStatus, isTerminalChecklistStatus, isWithdrawnChecklistStatus } from '../core/checklist-status.js';

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
  const fromArgs = (ctx.args.storyId ?? ctx.args.story ?? ctx.args.id) as string | undefined;
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
  withdrawn: number;
  inProgressIds: string[];
  pendingIds: string[];
  allDone: boolean;
}

function summarizeChecklist(cl: { items: Array<{ id: string; status: string }> } | null): ChecklistSummary | null {
  if (!cl || !Array.isArray(cl.items)) return null;
  const summary: ChecklistSummary = {
    total: cl.items.length, done: 0, inProgress: 0, pending: 0, withdrawn: 0,
    inProgressIds: [], pendingIds: [], allDone: false,
  };
  for (const it of cl.items) {
    // B-1909 CHK-002: withdrawn is terminal-but-not-delivered — count it in its
    // own bucket so it neither inflates `done` (delivered) nor leaks into
    // `pending` (which would keep the story looking outstanding forever).
    if (isDeliveredChecklistStatus(it.status)) summary.done++;
    else if (it.status === 'in_progress') { summary.inProgress++; summary.inProgressIds.push(it.id); }
    else if (isWithdrawnChecklistStatus(it.status)) summary.withdrawn++;
    else { summary.pending++; summary.pendingIds.push(it.id); }
  }
  // allDone = every item TERMINAL (done OR withdrawn) — the advancement signal.
  // Delivered coverage remains `done`.
  summary.allDone = summary.total > 0 && cl.items.every(it => isTerminalChecklistStatus(it.status));
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
    return `→ 标记为 in_progress。写代码，完成后 git commit + proof-or-stop checklist_update --status=done`;
  }

  if (args.status === 'done') {
    if (summary.allDone) {
      const phase = story?.phase ?? '';
      if (phase === 'DEV') {
        return `→ 所有 ${summary.total} 个 item 已 done。下一步：git commit，然后 proof-or-stop story_advance --storyId=${storyId} --phase=REVIEW 进入代码审查`;
      }
      return `→ 所有 ${summary.total} 个 item 已 done。下一步：git commit + proof-or-stop story_advance 推进到下一阶段`;
    }
    if (summary.inProgress > 0) {
      return `→ 还有 ${summary.inProgress} 个 in_progress item（${summary.inProgressIds.slice(0, 3).join(', ')}），继续完成`;
    }
    if (summary.pending > 0) {
      return `→ 完成 ${summary.done}/${summary.total}。下一项：proof-or-stop checklist_update --storyId=${storyId} --itemId=${summary.pendingIds[0]} --status=in_progress`;
    }
  }

  return null;
};

const checklistAddHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  return `→ 新 item 已加入 checklist。下一步：跑 proof-or-stop story_review 审查完整性`;
};

const storyCreateHint: HintFn = (ctx) => {
  const result = ctx.result;
  if (typeof result !== 'string') return null;
  if (result.includes('(INIT)')) return null; // cli-engine wrapper 已处理
  if (result.includes('(IDEA)')) {
    return `→ Story 停在 IDEA（无 checklist）。下一步：proof-or-stop checklist_add 追加，或重新 proof-or-stop story_create 带 checklist`;
  }
  return null;
};

const bugReportHint: HintFn = (ctx) => {
  return `→ Bug 已记录。修复后跑 proof-or-stop validate 验证，然后 proof-or-stop bug_update --status=fixed`;
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
      return `→ 所有 bug 已 fixed。下一步：运行 proof-or-stop next 或 proof-or-stop session_brief 查看 DONE pre-check；全部通过后再 proof-or-stop story_advance --storyId=${storyId} --phase=DONE，未通过先补 gate`;
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
  return `→ Understanding 已记录。下一步：拆 checklist（title + context + relatedDocs），然后 proof-or-stop story_review`;
};

const decisionSetHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  return `→ Decision 已落档。下一步：根据 chosen option 拆 checklist item`;
};

const devStartHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  return `→ Worktree 已创建。cd 到上述路径，然后 proof-or-stop story_advance --storyId=${storyId} --phase=PLAN`;
};

const devFinishHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  const target = storyId ? ` --storyId=${storyId}` : '';
  return `→ Story 已推进到 REVIEW（DEV→REVIEW），worktree 保留未合并。下一步：运行 proof-or-stop reviewer_batch${target} --json；若使用 formal managed review，先按 managedReviewReadiness.nextAction 修复阻塞，再对 executionPlan.launchableLanes 逐条执行对应 lane 的 canonical fresh-context launchInstruction，先收集全部非空且互异的 child IDs，再对完整 ID 集合调用一次 wait；launchableLanes 为空时不要调用 wait。reviewer 自己执行 review_run_start 后写 review_pass_set 或 finding_add，审阅通过后再 story_advance 到 TEST`;
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
      // B-a2f1 CHK-001/002: stale-evidence advice is now produced by the
      // shared renderEvidenceStaleHint helper so session_brief / story_advance
      // / proof-or-stop validate output use byte-identical marker + recovery block.
      // Computed from on-disk checklist (not validate JSON) so we always see
      // the actual storyId-bound evidence and reuse the same freshness logic.
      const staleEntries = storyId ? safeRead(() => findStaleEvidence(ctx.root, storyId)) : null;
      if (storyId && staleEntries && staleEntries.length > 0) {
        const block = renderEvidenceStaleHint(storyId, staleEntries, { currentHead: currentGitHead(ctx.root) });
        return `→ 验证命令通过，但 verification evidence 有 ${staleEntries.length} 项 stale。\n${block}`;
      }
      return `→ 验证未通过：verification coverage 缺 ${missing} 项 required intent。补 evidence 后重跑 proof-or-stop validate`;
    }
    return `→ 验证未通过。按上方 details 修复后重跑 proof-or-stop validate`;
  }
  // B-7fc2: text-mode validate emits "✓ ALL PASS" (cli-e2e) or "✓ Project
  // validation commands passed" (renderExternalResult) when all checks succeed.
  // Without these markers the text-mode hint was silently dropped, so the hint
  // contract promised by `proof-or-stop validate` was only honoured for JSON callers.
  const textModePass = !parsed && (
    result.includes('✓ ALL PASS')
    || result.includes('✓ Project validation commands passed')
  );
  if (parsed ? parsed.allPass === true : ((result.includes('allPass') && result.includes('true')) || textModePass)) {
    const storyId = getStoryId(ctx);
    if (storyId) {
      const phase = getStory(ctx, storyId)?.phase ?? ctx.activeStory?.phase;
      if (phase === 'DEV') {
        return `→ 验证全绿。下一步：git commit，然后 proof-or-stop story_advance --storyId=${storyId} --phase=REVIEW 进入代码审查`;
      }
      if (phase === 'REVIEW') {
        return `→ 验证全绿。下一步：proof-or-stop story_advance --storyId=${storyId} --phase=TEST 进入正式验证`;
      }
      if (phase === 'TEST') {
        return `→ 验证全绿。下一步：运行 proof-or-stop next 或 proof-or-stop session_brief 查看 DONE pre-check；全部通过后 proof-or-stop story_advance --storyId=${storyId} --phase=DONE，未通过先补 gate`;
      }
      return `→ 验证全绿。当前 story 在 ${phase ?? '未知'} 阶段；下一步先运行 proof-or-stop next 确认当前 gate`;
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
 * Machine JSON mode detector — B-7fc2 CLI stdout contract.
 *
 * `--json` / `--format=json` stdout is a machine-only payload that callers
 * (dashboard, host adapters, smoke tests) must be able to feed straight into
 * JSON.parse. Returning true here causes the CLI output pipeline to skip
 * decorateResult so the human next-step hint never contaminates stdout.
 */
export function wantsMachineJson(args: Record<string, unknown> | null | undefined): boolean {
  if (!args || typeof args !== 'object') return false;
  if ((args as { json?: unknown }).json === true) return true;
  if ((args as { format?: unknown }).format === 'json') return true;
  return false;
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
