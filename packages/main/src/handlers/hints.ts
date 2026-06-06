/**
 * Result hint registry — appends next-step hints to the success return of every state-mutating command
 *
 * hint functions are pure: no throws, no side effects, no writes to store.
 * Return null → no append; return string → append to the end of the result.
 */

import type { StoryStore } from '../core/store.js';
import { findStaleEvidence, renderEvidenceStaleHint } from '../core/evidence-stale-hint.js';
import { currentGitHead } from '../core/evidence-freshness.js';

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

// ── hint functions ──

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
    return `→ Marked as in_progress. Write code, then git commit + lattice checklist_update --status=done when finished`;
  }

  if (args.status === 'done') {
    if (summary.allDone) {
      const phase = story?.phase ?? '';
      if (phase === 'DEV') {
        return `→ All ${summary.total} items are done. Next: git commit, then lattice story_advance --storyId=${storyId} --phase=REVIEW to enter code review`;
      }
      return `→ All ${summary.total} items are done. Next: git commit + lattice story_advance to advance to the next phase`;
    }
    if (summary.inProgress > 0) {
      return `→ ${summary.inProgress} in_progress items remain (${summary.inProgressIds.slice(0, 3).join(', ')}), keep going`;
    }
    if (summary.pending > 0) {
      return `→ Completed ${summary.done}/${summary.total}. Next item: lattice checklist_update --storyId=${storyId} --itemId=${summary.pendingIds[0]} --status=in_progress`;
    }
  }

  return null;
};

const checklistAddHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  return `→ New item added to checklist. Next: run lattice story_review to audit completeness`;
};

const storyCreateHint: HintFn = (ctx) => {
  const result = ctx.result;
  if (typeof result !== 'string') return null;
  if (result.includes('(INIT)')) return null; // cli-engine wrapper already handles this
  if (result.includes('(IDEA)')) {
    return `→ Story stopped at IDEA (no checklist). Next: lattice checklist_add to append, or re-run lattice story_create with checklist`;
  }
  if (result.includes('(DONE)')) {
    return `→ Story created directly in DONE (onboard mode). No further steps`;
  }
  return null;
};

const bugReportHint: HintFn = (ctx) => {
  return `→ Bug recorded. After fixing, run lattice validate to verify, then lattice bug_update --status=fixed`;
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
      return `→ All bugs are fixed. Next: run lattice next or lattice session_brief to view the DONE pre-check; once all pass, run lattice story_advance --storyId=${storyId} --phase=DONE, otherwise satisfy the gates first`;
    }
    return `→ All bugs are fixed. Continue advancing the story`;
  }
  return `→ ${open.length} open bugs remain: ${open.slice(0, 3).map((b: any) => b.id).join(', ')}. Keep fixing`;
};

const understandingSetHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  const args = ctx.args as { unknowns?: string[] };
  if (Array.isArray(args.unknowns) && args.unknowns.length > 0) {
    return `→ Understanding recorded but has ${args.unknowns.length} unknowns. Recommend investigating to resolve unknowns first before splitting the checklist`;
  }
  return `→ Understanding recorded. Next: split the checklist (title + context + relatedDocs), then lattice story_review`;
};

const decisionSetHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  return `→ Decision filed. Next: split checklist items based on the chosen option`;
};

const devStartHint: HintFn = (ctx) => {
  const storyId = getStoryId(ctx);
  if (!storyId) return null;
  return `→ Worktree created. cd into the path above, then lattice story_advance --storyId=${storyId} --phase=PLAN`;
};

const devFinishHint: HintFn = (ctx) => {
  return `→ Worktree merged back to main. You can start the next story or git push`;
};

const storyDiscardHint: HintFn = (ctx) => {
  const result = String(ctx.result || '');
  if (result.includes('⚠')) {
    return `→ Story discard executed, but uncleaned items remain; address the warnings above and retry`;
  }
  if (result.includes('Story metadata cleaned')) {
    return `→ Temporary Story metadata cleaned up; if the prompt above did not revert the init commit, please confirm manually as prompted`;
  }
  return `→ Story discard completed; refer to the output above for cleanup details`;
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
      // / lattice validate output use byte-identical marker + recovery block.
      // Computed from on-disk checklist (not validate JSON) so we always see
      // the actual storyId-bound evidence and reuse the same freshness logic.
      const staleEntries = storyId ? safeRead(() => findStaleEvidence(ctx.root, storyId)) : null;
      if (storyId && staleEntries && staleEntries.length > 0) {
        const block = renderEvidenceStaleHint(storyId, staleEntries, { currentHead: currentGitHead(ctx.root) });
        return `→ Validation command passed, but ${staleEntries.length} verification evidence entries are stale.\n${block}`;
      }
      return `→ Validation failed: verification coverage is missing ${missing} required intents. Add evidence and rerun lattice validate`;
    }
    return `→ Validation failed. Fix per the details above and rerun lattice validate`;
  }
  if (parsed ? parsed.allPass === true : (result.includes('allPass') && result.includes('true'))) {
    const storyId = getStoryId(ctx);
    if (storyId) {
      const phase = getStory(ctx, storyId)?.phase ?? ctx.activeStory?.phase;
      if (phase === 'DEV') {
        return `→ Validation all green. Next step: git commit, then lattice story_advance --storyId=${storyId} --phase=REVIEW to enter code review`;
      }
      if (phase === 'REVIEW') {
        return `→ Validation all green. Next step: lattice story_advance --storyId=${storyId} --phase=TEST to enter formal verification`;
      }
      if (phase === 'TEST') {
        return `→ Validation all green. Next step: run lattice next or lattice session_brief to view the DONE pre-check; once all pass, lattice story_advance --storyId=${storyId} --phase=DONE, otherwise address the gates first`;
      }
      return `→ Validation all green. The current story is in the ${phase ?? 'unknown'} phase; next step, run lattice next first to confirm the current gate`;
    }
    return `→ Validation all green. Ready to commit`;
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
 * Decorate command return value: try to append a next-step hint.
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
