/**
 * Finding closure rule (no round decay).
 *
 * Every VERIFIED open finding (legacy findings without evidenceState count as
 * verified) whose severity is in the profile's review.blockingSeverities must
 * be closed before REVIEW->TEST and before DONE, whichever review round raised
 * it. Findings from earlier rounds count. A finding is closed only through its
 * recorded lifecycle transition: finding_resolve with repair evidence (including
 * resolutionType=accepted_risk, the named accepted-risk record),
 * review_remediation_close, or the pre-existing finding_dismiss record with its
 * reason (REVIEW only, never for critical). Suspected / disproven findings keep their advisory
 * treatment, and signed Dynamic Finding dispositions (enforce mode) still apply
 * through readDynamicFindingDecision. There is no review-round limit anywhere:
 * the round number never changes which severities block.
 */
import type { StoryStore } from './store.js';
import type { Finding } from './types.js';
import { readDynamicFindingDecision } from './finding-applicability-projection.js';

/**
 * The profile's blocking severities for every review round (round decay was
 * removed). roundCount is still derived from story events (REVIEW/advance), not
 * from review.json, and is returned for lane-coverage diagnostics only.
 */
export function resolveEffectiveBlockingSeverities(
  store: StoryStore,
  storyId: string,
  policy: { review: { blockingSeverities: readonly string[] | string[] } },
): { effectiveBlockingSeverities: string[]; roundCount: number } {
  let roundCount = 1;
  try {
    const story = store.readStory(storyId);
    if (story.events) {
      roundCount = story.events.filter(event => event.phase === 'REVIEW' && event.action === 'advance').length || 1;
    }
  } catch { /* fallback to 1 */ }
  return { effectiveBlockingSeverities: [...policy.review.blockingSeverities], roundCount };
}

export interface UnclosedBlockingFinding {
  finding: Finding;
  decision: ReturnType<typeof readDynamicFindingDecision>;
}

/** All findings of the story (every round, every agent) that still block closure. */
export function unclosedBlockingFindings(args: {
  store: StoryStore;
  projectRoot: string;
  storyId: string;
  findings: readonly Finding[];
  effectiveBlockingSeverities: readonly string[];
  round: number;
}): UnclosedBlockingFinding[] {
  return args.findings
    .filter(finding => finding.status === 'open')
    .map(finding => ({ finding, decision: readDynamicFindingDecision({ store: args.store, projectRoot: args.projectRoot,
      storyId: args.storyId, finding, effectiveBlockingSeverities: args.effectiveBlockingSeverities, round: args.round }) }))
    .filter(row => row.decision.blocking);
}

export { FINDING_RESOLUTION_PLACEHOLDER, findingResolveCommand, findingClosureAction, findingClosureNextAction, storyPhaseOrUndefined } from './finding-closure-hint.js';
