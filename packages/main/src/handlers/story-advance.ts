
import type { HandlerContext } from './context.js';
import type { StoryPhase } from '../core/types.js';
// B-6974 (Lifecycle Phase 2, Story 3c): transition coordination extracted into
// handlers/transition-orchestrator.ts. story_advance now delegates one whole
// transition to runStoryTransition and only formats the structured result via
// renderTransitionResult — external CLI behavior / phase-write timing / DONE
// pre/post-merge semantics are byte-identical. The orchestrator owns the actor
// lifecycle (create/start/send/stop) and the DONE merge lock scope; the actor
// is stopped exactly once in the orchestrator's finally on every exit path.
import { runStoryTransition, renderTransitionResult } from './transition-orchestrator.js';

// B-9d95 CHK-003: re-export 供 DONE merge 前 stray 文件清理。主实现在独立
// 文件（stray-file-cleanup.ts），logicTest 直接 import，避免把 xstate/machine
// 等重依赖拖进测试进程。
export { cleanStrayWorktreeFiles, STRAY_FILE_WHITELIST } from './stray-file-cleanup.js';


// B-37e9: buildDoneChecklist + DoneCheckRow + doneCheckRow + renderDoneChecklist
// + their private helpers (checkEvidenceFreshness etc.) moved into
// core/done-oracle.ts. A thin re-export keeps the legacy `./story-advance.js`
// import path working — there is exactly one implementation in
// core/done-oracle.ts.
export { buildDoneChecklist, type DoneCheckRow } from '../core/done-oracle.js';

export function createStoryAdvanceHandlers(ctx: HandlerContext) {
  return {
    // B-6974 (Story 3c): thin handler — parse args, delegate the whole
    // transition to runStoryTransition (which owns actor lifecycle + DONE
    // merge lock scope + pre/post gate ordering), then format the structured
    // result. The transition-coordination body that previously lived inline
    // here moved verbatim (behavior-preserving) into
    // handlers/transition-orchestrator.ts.
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
