
import type { HandlerContext } from './context.js';
import type { StoryPhase } from '../core/types.js';
// B-6974: thin story_advance handler. Transition coordination lives in
// handlers/transition-orchestrator.ts; this file keeps only the public command
// entrypoint and legacy exports.
import { runStoryTransition, renderTransitionResult } from './transition-orchestrator.js';

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
    }): Promise<string> {
      const result = await runStoryTransition(ctx, args);
      return renderTransitionResult(result);
    },
  };
}
