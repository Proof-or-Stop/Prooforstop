/**
 * REVIEW→DEV material reopen (old-PoS run 25, F2).
 *
 * A review round certifies the material it was entered with (the committed
 * material hash recorded on the round's REVIEW-entry phase_transition). When
 * that material changes during REVIEW and no finding is open (an owner
 * test-only commit, a hand fix), the round can never certify the new material:
 * its passes, critic and inventory receipt are bound to the old one. Before
 * this door the only way back to DEV was a FINALIZED unconsumed inventory
 * receipt, which a clean round has already consumed, so `next` ended at
 * `human — none runnable` and the run livelocked for 52 min.
 *
 * The reopen is framework-owned: the REVIEW→DEV transition takes it whenever
 * this decision is eligible, records the reason on the phase_transition
 * (transitionType review_reopen), cancels the round's still-open or
 * unconsumed inventory epoch, and leaves the rest to DEV (stale evidence is
 * refreshed by its evidence-chain step) and the next REVIEW entry (a fresh
 * round). With an open blocking finding the ordinary remediation path applies.
 *
 * Owner source edits during REVIEW are routed here, not refused: a git commit
 * cannot be refused reliably (it is plain git), and the edit may be a genuine
 * fix. Routing re-reviews it in a fresh round; nothing reaches TEST unreviewed.
 */
import type { StoryStore } from './store.js';
import { currentMaterialHash } from './evidence-freshness.js';
import { resolveEffectiveBlockingSeverities, unclosedBlockingFindings } from './finding-closure.js';
import { loadConfig } from './config.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';

export const REVIEW_REOPEN_TRANSITION_TYPE = 'review_reopen';

export interface ReviewMaterialReopenDecision {
  eligible: boolean;
  /** Eligible: the reason recorded on the transition. Otherwise: why not (diagnostic). */
  reason: string;
  reviewRound?: string;
  roundMaterialHash?: string;
  liveMaterialHash?: string;
}

/**
 * Pure-read decision: REVIEW, a current round with a recorded entry material
 * hash, committed material that differs from it, and no open blocking finding.
 * Never throws (an unreadable input is "not eligible").
 */
export function evaluateReviewMaterialReopen(args: {
  store: StoryStore;
  storyId: string;
  gitCwd: string;
  metadataRoot: string;
}): ReviewMaterialReopenDecision {
  const { store, storyId } = args;
  try {
    const story = store.readStory(storyId);
    if (story.phase !== 'REVIEW') return { eligible: false, reason: `phase is ${story.phase}, not REVIEW` };
    const round = story.currentReviewRound;
    if (!round) return { eligible: false, reason: 'REVIEW has no current round' };
    const entry = store.readProcessEvents(storyId).filter(event => event.type === 'phase_transition'
      && (event as { toPhase?: string }).toPhase === 'REVIEW' && (event as { reviewRound?: string }).reviewRound === round).at(-1) as
      { materialHash?: string } | undefined;
    const roundMaterialHash = entry?.materialHash;
    if (!roundMaterialHash) return { eligible: false, reason: `review round ${round} has no recorded entry material hash`, reviewRound: round };
    const liveMaterialHash = currentMaterialHash(args.gitCwd, 'HEAD', args.metadataRoot);
    if (!liveMaterialHash) return { eligible: false, reason: 'committed material hash is unreadable', reviewRound: round, roundMaterialHash };
    if (liveMaterialHash === roundMaterialHash) {
      return { eligible: false, reason: 'material is unchanged since the round began', reviewRound: round, roundMaterialHash, liveMaterialHash };
    }
    const policy = resolveWorkflowPolicy(loadConfig(args.metadataRoot), story);
    const { effectiveBlockingSeverities, roundCount } = resolveEffectiveBlockingSeverities(store, storyId, policy);
    const open = unclosedBlockingFindings({ store, projectRoot: args.metadataRoot, storyId,
      findings: store.readFindings(storyId).findings ?? [], effectiveBlockingSeverities, round: roundCount });
    if (open.length > 0) {
      return { eligible: false, reason: `open blocking finding(s) ${open.map(row => row.finding.id).join(', ')} take the remediation path`,
        reviewRound: round, roundMaterialHash, liveMaterialHash };
    }
    return {
      eligible: true,
      reason: `material changed since review round ${round} began (round material ${roundMaterialHash.slice(0, 12)}, live ${liveMaterialHash.slice(0, 12)}) and no open finding: the round cannot certify the new material; DEV refreshes evidence and REVIEW re-enters with a fresh round`,
      reviewRound: round,
      roundMaterialHash,
      liveMaterialHash,
    };
  } catch (error) {
    return { eligible: false, reason: `reopen inputs unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
