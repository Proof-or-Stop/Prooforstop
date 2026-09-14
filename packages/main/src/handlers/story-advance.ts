
import type { HandlerContext } from './context.js';
import type { StoryPhase } from '../core/types.js';
// B-6974: thin story_advance handler. Transition coordination lives in
// handlers/transition-orchestrator.ts; this file keeps only the public command
// entrypoint and legacy exports.
import { runStoryTransition, renderTransitionResult } from './transition-orchestrator.js';
import { reconcileFindingDeferralRecalls } from './finding-deferral-recall.js';

// B-9d95 CHK-003: re-export for stray file cleanup before DONE merge. The main implementation is in a standalone
// file (stray-file-cleanup.ts), imported directly by logicTest, to avoid pulling heavy dependencies like xstate/machine
// into the test process.
export { cleanStrayWorktreeFiles, STRAY_FILE_WHITELIST } from './stray-file-cleanup.js';


// B-37e9: buildDoneChecklist + DoneCheckRow + doneCheckRow + renderDoneChecklist
// + their private helpers (checkEvidenceFreshness etc.) moved into
// core/done-oracle.ts. A thin re-export keeps the legacy `./story-advance.js`
// import path working — there is exactly one implementation in
// core/done-oracle.ts.
export { buildDoneChecklist, type DoneCheckRow } from '../core/done-oracle.js';

export function createStoryAdvanceHandlers(ctx: HandlerContext) {
  return {
    // B-6974: parse args, delegate, format.
    async story_advance(args: {
      storyId: string;
      phase: StoryPhase;
      checklist?: Array<{ id: string; title: string }>;
      // B-8b69: required, audited reason for the gated PLAN->INIT reopen; ignored for
      // every other transition. Threaded straight into runStoryTransition.
      reason?: string;
      json?: boolean;
    }): Promise<string> {
      if (['DEV', 'REVIEW', 'TEST'].includes(ctx.store.readStory(args.storyId).phase)) {
        try {
          const recalled = reconcileFindingDeferralRecalls(ctx, args.storyId);
          if (recalled.rows.length) process.stderr.write(`Dynamic Finding recall: ${recalled.rows.filter(row => row.created === 1).length} new candidates; obligations unchanged.\n`);
        } catch (error) {
          // Persistence failure never waives a floor and must not disable DEV rework.
          process.stderr.write(`Dynamic Finding recall pending: ${error instanceof Error ? error.message : String(error)}; gate projection remains authoritative.\n`);
        }
      }
      const result = await runStoryTransition(ctx, args);
      return args.json ? JSON.stringify(result, null, 2) : renderTransitionResult(result);
    },
  };
}
