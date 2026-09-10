/** Shared read-only gate: raw activity counters are diagnostic, never stall authority. */
import type { StoryStore } from './store.js';
import { readConvergenceProgress, evaluateConvergenceProgress } from './convergence-progress-journal.js';
import { resolveGitCwd } from './story-signed-workspace-resolution.js';

export function convergenceProgressUnavailable(error: unknown) {
  return { blocked: true, code: 'convergence_progress_unavailable',
    prompt: `Convergence progress unavailable: ${error instanceof Error ? error.message : String(error)}. Repair the observation integrity; this is not a design-stall conclusion.` };
}

export function assessConvergenceProgressGate(store: StoryStore, storyId: string): { blocked: boolean; code?: string; prompt?: string } {
  try {
    if (!store.readConvergenceProgress(storyId)) return { blocked: false };
    const root = resolveGitCwd({ store, storyId, metadataRoot: store.projectRoot, projectRoot: store.projectRoot });
    const journal = readConvergenceProgress(store, storyId, root);
    // Without two observed stagnant completions, no live comparison can freeze.
    if (!journal || journal.state.stagnantEpochIds.length < 2) return { blocked: false };
    const progress = evaluateConvergenceProgress(store, storyId, root);
    if (progress.decision !== 'request-decision') return { blocked: false };
    return { blocked: true, code: 'effective_progress_stalled', prompt:
      `Convergence breaker FROZEN for ${storyId}: two complete verified review epochs made no effective progress. ` +
      `Completed epochs: ${progress.state.stagnantEpochIds.join(', ')}. ` +
      `Repair a verified finding or missing required coverage, or request a human decision. ` +
      `A human may run proof-or-stop story_resume --storyId=${storyId} --ack --reason="<why continuation is justified>".` };
  } catch (error) {
    // Integrity failure is distinct from a design/stall conclusion. Never launder
    // malformed observations into a fresh baseline or count them as completed work.
    return convergenceProgressUnavailable(error);
  }
}
