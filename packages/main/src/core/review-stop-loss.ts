/**
 * REVIEW stale-wave stop-loss (old-PoS run 25, F4).
 *
 * Run 25 (B-2b04) relaunched the review lanes five times on one unchanged
 * material (8d9641c9) while a verified finding (F-002) stayed open: each wave
 * went stale (framework metadata commits, superseded critic runs), re-reported
 * the same defect, changed the live inventory aggregate, and so never produced
 * the FINALIZED remediation receipt that REVIEW→DEV requires. `next` ended at
 * `human — none runnable` after 52 min / 54M input.
 *
 * The stop-loss caps that loop. When the lanes of the current round already
 * observed the live material STALE_WAVE_STOP_LOSS times and a verified blocking
 * finding is open, another observation cannot add authority the earlier ones
 * lacked: the finding is already verified. REVIEW→DEV is then admitted without
 * a remediation receipt (no receipt is consumed; the round's inventory epoch is
 * left to `next`, which cancels an epoch of an earlier round). Nothing is
 * dropped: every open finding goes to repair, and the next REVIEW entry starts
 * a fresh round with fresh lanes and a fresh inventory over the repaired code.
 * Below the cap, or with the remediation receipt available, the ordinary
 * remediation path applies.
 */
import type { StoryStore } from './store.js';
import { currentMaterialHash } from './evidence-freshness.js';
import { resolveEffectiveBlockingSeverities, unclosedBlockingFindings } from './finding-closure.js';
import { loadConfig } from './config.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
import { reviewInventoryRemediationGate } from './review-inventory-epoch.js';

/** Lane runs per lane on unchanged material in one round before the stop-loss applies. */
export const STALE_WAVE_STOP_LOSS = 3;
/** transitionType recorded on the stop-loss REVIEW→DEV phase_transition. */
export const REVIEW_STOP_LOSS_TRANSITION_TYPE = 'review_stop_loss';

/** The most lane runs (inventory critics excluded) any lane has in this round on the given material. */
export function maxLaneRunsOnMaterial(store: StoryStore, storyId: string, round: string, materialHash: string | undefined): number {
  if (!materialHash) return 0;
  const counts = new Map<string, number>();
  for (const run of store.readReviewRuns(storyId).runs) {
    if (run.reviewRound !== round || run.reviewPurpose === 'inventory-completeness' || run.materialHash !== materialHash) continue;
    counts.set(run.lane, (counts.get(run.lane) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

export interface ReviewStopLossDecision {
  eligible: boolean;
  /** Eligible: the reason recorded on the transition. Otherwise: why not (diagnostic). */
  reason: string;
  openFindingIds?: string[];
}

/** Pure-read decision; never throws (unreadable input = not eligible). */
export function evaluateReviewStopLossReopen(args: { store: StoryStore; storyId: string; gitCwd: string; metadataRoot: string }): ReviewStopLossDecision {
  const { store, storyId } = args;
  try {
    const story = store.readStory(storyId);
    if (story.phase !== 'REVIEW') return { eligible: false, reason: `phase is ${story.phase}, not REVIEW` };
    const round = story.currentReviewRound;
    if (!round) return { eligible: false, reason: 'REVIEW has no current round' };
    if (reviewInventoryRemediationGate(store, storyId, round).ok) return { eligible: false, reason: 'the remediation receipt is available' };
    const policy = resolveWorkflowPolicy(loadConfig(args.metadataRoot), story);
    const { effectiveBlockingSeverities, roundCount } = resolveEffectiveBlockingSeverities(store, storyId, policy);
    const open = unclosedBlockingFindings({ store, projectRoot: args.metadataRoot, storyId,
      findings: store.readFindings(storyId).findings ?? [], effectiveBlockingSeverities, round: roundCount }).map(row => row.finding.id);
    if (open.length === 0) return { eligible: false, reason: 'no open verified blocking finding' };
    const waves = maxLaneRunsOnMaterial(store, storyId, round, currentMaterialHash(args.gitCwd, 'HEAD', args.metadataRoot));
    if (waves < STALE_WAVE_STOP_LOSS) return { eligible: false, reason: `the lanes observed the live material ${waves} time(s) this round (stop-loss at ${STALE_WAVE_STOP_LOSS})`, openFindingIds: open };
    return {
      eligible: true,
      reason: `stale-wave stop-loss: the lanes of review round ${round} observed the unchanged material ${waves} times without a remediation receipt while verified finding(s) ${open.join(', ')} stay open; repair them in DEV, REVIEW re-enters with a fresh round`,
      openFindingIds: open,
    };
  } catch (error) {
    return { eligible: false, reason: `stop-loss inputs unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
