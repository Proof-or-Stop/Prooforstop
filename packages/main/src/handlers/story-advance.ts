
import type { HandlerContext } from './context.js';
import type { StoryPhase } from '../core/types.js';
// B-6974: thin story_advance handler. Transition coordination lives in
// handlers/transition-orchestrator.ts; this file keeps only the public command
// entrypoint and legacy exports.
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
