
import type { HandlerContext } from './context.js';
import { createStoryCreateHandlers } from './story-create.js';
import { createStoryAdvanceHandlers } from './story-advance.js';
import { createStoryQueryHandlers } from './story-query.js';
import { createStoryReviewHandlers } from './story-review.js';
import {
  readBreakerState,
  writeBreakerState,
  resumeBreakerState,
  resetGateFailureCounts,
  collectBreakerCounters,
  isInteractiveAckAllowed,
} from '../core/convergence-breaker.js';

/**
 * B-bbaf CHK-003: the human-only ack that clears a convergence-breaker freeze.
 *
 * A frozen story is the hard brake for the B-f458 death loop; clearing it MUST
 * require a human, because the 14-hour burn happened precisely because a looping
 * agent had nobody in the loop. So this command:
 *   - refuses under autopilot / non-interactive sessions (isInteractiveAckAllowed);
 *   - requires an explicit --ack and a human --reason;
 *   - resets the breaker (fresh auto-recovery budget, re-baselined advance window)
 *     and clears the repeated-gate-failure counter so the story can advance again.
 */
function createStoryResumeHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    story_resume(args: { storyId: string; ack?: boolean; reason?: string }): string {
      const storyId = args.storyId;
      if (!storyId) throw new Error('story_resume requires --storyId.');

      if (!isInteractiveAckAllowed(process.env, process.stdin.isTTY)) {
        throw new Error(
          `story_resume is refused: clearing a convergence-breaker freeze REQUIRES an interactive human session. ` +
          `This looks like an autopilot / non-interactive / CI session (no TTY, or LATTICE_AUTOPILOT/CI set). ` +
          `A human must run this at a real terminal — the freeze exists to stop exactly the unattended loop that ` +
          `caused the B-f458 14-hour burn.`,
        );
      }

      const reason = (args.reason ?? '').trim();
      if (args.ack !== true) {
        throw new Error('story_resume requires --ack to confirm a human is deliberately clearing the freeze.');
      }
      if (reason.length < 10) {
        throw new Error('story_resume requires --reason="<why it is safe to continue>" (at least 10 characters).');
      }

      const storyDir = store.storyDirPath(storyId);
      const prior = readBreakerState(storyDir);
      if (!prior || !prior.frozen) {
        return `Story ${storyId} is not frozen by the convergence breaker; nothing to resume.`;
      }

      const counters = collectBreakerCounters(store, storyId, storyDir);
      const next = resumeBreakerState(counters);
      writeBreakerState(storyDir, next);
      resetGateFailureCounts(storyDir);

      const tripped = (prior.trippedReasons ?? []).join(', ') || '(none recorded)';
      return (
        `Convergence breaker CLEARED for ${storyId}. Previously tripped: ${tripped}. ` +
        `Reason: "${reason}". A fresh one-shot auto-recovery budget is restored and the advance window is re-baselined; ` +
        `story_advance will proceed. If it trips again, it will freeze once more and require another human ack.`
      );
    },
  };
}

export function createStoryHandlers(ctx: HandlerContext) {
  return {
    ...createStoryCreateHandlers(ctx),
    ...createStoryAdvanceHandlers(ctx),
    ...createStoryQueryHandlers(ctx),
    ...createStoryReviewHandlers(ctx),
    ...createStoryResumeHandlers(ctx),
  };
}
