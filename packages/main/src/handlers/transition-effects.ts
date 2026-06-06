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
      // B-9d95 CHK-001 whitelist: hook execution context — hook subprocess must inherit caller's real cwd (current directory of user's shell)
      // rather than ctx.root, otherwise the hook script cannot see the caller's worktree. This is the hook protocol convention (see buildHookEnv docs for details).
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
 * CHK-002: On PLAN→DEV, collect all relatedDocs and list them as a kickoff reminder.
 * B-45ed CHK-008: The docsHint for PLAN→DEV and DONE both include background.md.
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
    // B-45ed CHK-008: if background.md exists and has not appeared → append to docMap (mark source with special tag)
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
        ? '📄 Documents associated with this story (note synchronization when modifying code):'
        : '📄 Documents associated with this story (verify synchronization before DONE wrap-up):';
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
    PLAN: `→ Recommend switching to Claude Code plan mode immediately (shift-tab twice to plan mode) — the PLAN stage only breaks down checklist / writes understanding_set / decision_set, and should not modify code. Edit/Write being disabled in plan mode prevents accidental edits.
→ Next step: checklist_get(${storyId}) to view pending items, then story_advance(${storyId}, DEV) to begin development
⚠ User value acceptance (mandatory): the outcome field of understanding_set must be written as a concrete user-facing transcript — the exact text the user will see in the terminal/UI after running this story, not an abstract description like "event X is wired up". Judgment method: outcome must read in a way that lets one imagine the moment when the user considers the work done. See the "User value acceptance" section in CLAUDE.md for details.`,
    DEV: (() => {
      // B-45ed CHK-004: real-time compute the three-tier channel (express/fast/normal)
      let channel: 'express' | 'fast' | 'normal' = 'normal';
      try {
        const s = store.readStory(storyId);
        const cl = store.readChecklist(storyId);
        let decision = null;
        try { decision = store.readDecision(storyId); } catch {}
        channel = computeChannel(s, cl, decision);
      } catch {}
      if (channel === 'express') {
        return `→ Express channel (${CHANNEL_LABELS.express}, ≤2 items, no riskSignals): the main agent writes code + writes tests itself, only checklist is needed.
→ After completion, story_advance(${storyId}, REVIEW) to enter code review`;
      }
      if (channel === 'fast') {
        return `→ Fast channel (${CHANNEL_LABELS.fast}, ≤5 items, single solution, no riskSignals): the main agent may write code itself, skipping decision + plan.md, keeping understanding.
→ After completion, story_advance(${storyId}, REVIEW) to enter code review`;
      }
      return `→ Normal channel (${CHANNEL_LABELS.normal}): must launch the koala-implementer subagent to write code; the main agent should not modify business code itself.
→ Use Agent({ subagent_type: "koala-implementer", prompt: "..." }) to assign tasks
→ After the subagent finishes and commits, the main agent accepts and merges, then story_advance(${storyId}, REVIEW)
→ sub agent should not use isolation:"worktree", run directly in the main agent's worktree
⚠ During the REVIEW phase, koala-reviewer will check the commit author — in the normal channel, if all code is written by the main agent itself, a critical finding will be raised`;
    })(),
    REVIEW: (() => {
      // B-fdcf CHK-002: Dynamic echo by opt-in list (no longer fixed at 5 after channel LLM reviewer was retired).
      let activeLine = 'Active reviewers: concept, quality (fallback: cannot resolve opt-in list, using baseline)';
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
          `  Agent({ subagent_type: "koala-review-${r.name}", prompt: "Review story ${storyId} (${r.reason})" })`,
        ).join('\n');
      } catch {
        agentLines = `  Agent({ subagent_type: "koala-review-concept", prompt: "Review story ${storyId}" })
  Agent({ subagent_type: "koala-review-quality", prompt: "Review story ${storyId}" })`;
      }
      return `→ ${activeLine}
→ launch the above reviewers in parallel to review code (issue all Agent calls in a single message):
${agentLines}
→ reviewer liveness: each reviewer should first output REVIEW_START after starting; if no output for 4 minutes ask for status, if no result for 10 minutes/600s treat as stalled, restart that reviewer and note the previous stall in the retry prompt
→ After all return, koala finding_list to aggregate
→ Once critical/high are all resolved: story_advance(${storyId}, TEST)
→ Need code changes: story_advance(${storyId}, DEV) to return to DEV
⚠ When reviewers call finding_add they must pass the agent parameter (e.g. "agent":"koala-review-behavior"), otherwise the finding will be marked as main agent and the TEST gate will refuse to advance`;
    })(),
    TEST_CASE: `→ Legacy phase. Recommend directly story_advance(${storyId}, TEST) to enter verification`,
    TEST_CASE_REVIEW: `→ Legacy phase. Recommend directly story_advance(${storyId}, TEST) to enter verification`,
    TEST: `→ Must execute immediately: koala validate to run verification, write bug/evidence. fail auto aux_diagnose + bug_report, pass auto marks bug fixed.
⚠ Engineering verification ≠ user acceptance: even if validate is fully pass, you must run it once on a real machine from the user's perspective (rhythm: treat PLAN outcome as expected → run → treat actual output as actual → diff). After verifying, put the actual transcript + diff notes in ${store.storyDirRel()}/${storyId}/evidence/transcript-diff.md. The "user value acceptance" section in CLAUDE.md has the complete 5-question self-check list.
⚠ delivery-check hard gate: before DONE you must spawn the koala-review-delivery reviewer to write the delivery-check.json signature. The reviewer reverse-scans git diff to verify doc promises are delivered + real-machine test coverage. Unsigned → story_advance DONE will be blocked by [missing_delivery_check].`,
    DONE: `→ Must execute immediately: tell the user the Story summary paragraph below in your own words (what changed / how to use / real-machine coverage / limitations / pitfalls), then convergence_check to check project convergence state
⚠ DONE self-check 5 questions (CLAUDE.md "User value acceptance" section): (1) Is the PLAN outcome a concrete transcript or abstract? (2) During real-machine testing, did you read the user-perspective output or only look at the event log? (3) When the user sees the last line of the actual transcript, would they consider the work done or still wonder what comes next? (4) Are there any engineering logs that are noise/duplicates in the user's eyes? (5) Is there a plain-language summary of the task result? If any question is answered "not done", return to DEV and do not force-push DONE.`,
  };
}
