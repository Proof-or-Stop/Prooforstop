/**
 * B-e8c8 CHK-007: Round-based decreasing advisory rule (shared function)
 *
 * The blocking severity level of REVIEW phase findings decreases with each Round:
 *   - Round 1: critical + high + medium are blocking; low is always advisory (policy's
 *     effectiveBlockingSeverities never includes low; returning false for low in Round 1 would mislead
 *     finding_list into grouping low under Blocking, which is inconsistent with actual gate behavior)
 *   - Round 2: medium is downgraded to advisory; critical + high remain blocking; low remains advisory
 *   - Round 3+: high is downgraded to advisory; critical remains blocking (critical is always blocking)
 *
 * This function is shared by handlers/finding.ts (finding_list label tagging) and core/machine.ts
 * (canPassReview gate's decision on whether to skip blocker computation), to avoid duplicating hardcoded logic in two places.
 */
import type { StoryStore } from './store.js';
import type { Finding, FindingEvidenceState, StoryEvent } from './types.js';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * B-3fad CHK-001: The set of valid evidenceState values.
 * Both handler runtime / gate consumption points must validate against this set (not just rely on Zod; see CLAUDE.md "Handler coding conventions").
 */
export const FINDING_EVIDENCE_STATES: readonly FindingEvidenceState[] = ['suspected', 'verified', 'disproven'] as const;

/** B-3fad CHK-001: runtime narrow, rejects invalid evidenceState strings. */
export function isFindingEvidenceState(value: unknown): value is FindingEvidenceState {
  return typeof value === 'string' && (FINDING_EVIDENCE_STATES as readonly string[]).includes(value);
}

/**
 * B-3fad CHK-001: The evidenceState dimension of the REVIEW→TEST gate blocking decision.
 *
 * A finding can only block REVIEW→TEST when its evidenceState is 'verified' (or the field is missing = legacy compat treated as verified).
 * 'suspected' / 'disproven' never block (suspected is advisory only,
 * disproven has been refuted). Invalid strings are conservatively treated as non-verified (non-blocking, to avoid polluting the gate).
 *
 * Full gate predicate (machine.ts canPassReview / guard-utils.ts):
 *   status === 'open'
 *   && severity ∈ {critical,high} (from effectiveBlockingSeverities)
 *   && isEvidenceStateBlocking(evidenceState)
 *   && !isAdvisoryThisRound(severity, round)
 */
export function isEvidenceStateBlocking(evidenceState: FindingEvidenceState | string | undefined | null): boolean {
  if (evidenceState == null) return true; // legacy finding missing field → treated as verified
  return evidenceState === 'verified';
}

/**
 * B-3fad CHK-001: The complete decision for "whether this finding blocks REVIEW→TEST".
 * effectiveBlockingSeverities is passed in by the caller after resolving round decay.
 */
export function isFindingBlocking(
  finding: Pick<Finding, 'status' | 'severity' | 'evidenceState'>,
  effectiveBlockingSeverities: readonly string[],
  round: number,
): boolean {
  return finding.status === 'open'
    && effectiveBlockingSeverities.includes(finding.severity)
    && isEvidenceStateBlocking(finding.evidenceState)
    && !isAdvisoryThisRound(finding.severity, round);
}

/**
 * Determines whether a finding of a given severity is advisory (not blocking) in the current round.
 * critical always returns false (blocking in any round).
 * low always returns true (policy.blockingSeverities never contains low; low is never blocking).
 */
export function isAdvisoryThisRound(severity: FindingSeverity | string, round: number): boolean {
  if (severity === 'critical') return false;
  // low is never blocking: policy.review.blockingSeverities never contains low under any profile,
  // so low is grouped as advisory in all rounds, preventing finding_list from misplacing low into Blocking.
  if (severity === 'low') return true;
  if (round >= 3) {
    // Round 3+: high and medium are downgraded to advisory
    return severity === 'high' || severity === 'medium';
  }
  if (round >= 2) {
    // Round 2: medium is downgraded to advisory
    return severity === 'medium';
  }
  // Round 1: critical/high/medium are all blocking (low has already short-circuited above)
  return false;
}

/**
 * Gives the advisory label text for Round N (e.g. "R2-ADVISORY"); returns null for Round 1 or critical.
 */
export function advisoryLabelFor(severity: FindingSeverity | string, round: number): string | null {
  if (!isAdvisoryThisRound(severity, round)) return null;
  return `R${round}-ADVISORY`;
}

/**
 * Derives the current REVIEW roundCount from story.events.
 * Stays consistent with resolveEffectiveBlockingSeverities in machine.ts:
 *   roundCount = number of entries in events where phase==='REVIEW' && action==='advance',
 *   defaulting to 1 when there is no match (to avoid divide-by-zero / first-round edge cases).
 *
 * Rationale: handlers/transition-orchestrator.ts writes events on DEV→REVIEW (and on re-advance after REVIEW rollback)
 * by calling collectContext('REVIEW', 'advance') (see the collectContext signature
 * `action: 'create' | 'advance' | 'discard'` in handlers/context.ts plus the
 * story.events.push(collectContext(args.phase, 'advance')) in transition-orchestrator). Therefore
 * phase==='REVIEW' && action==='advance' precisely matches each event of entering REVIEW.
 */
export function resolveReviewRoundCount(store: StoryStore, storyId: string): number {
  try {
    const story = store.readStory(storyId);
    if (story.events) {
      const reviewEntries = story.events.filter(
        (e: StoryEvent) => e.phase === 'REVIEW' && e.action === 'advance',
      );
      return reviewEntries.length || 1;
    }
  } catch { /* fallback */ }
  return 1;
}
