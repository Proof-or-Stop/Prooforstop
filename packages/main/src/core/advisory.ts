/**
 * Finding advisory rule (shared function). No round decay.
 *
 * The closure severities (critical/high/medium in every profile,
 * core/finding-closure-severities.ts) block in EVERY review round:
 * a verified open finding of a blocking severity stays blocking until it is
 * closed (finding_resolve with repair evidence, review_remediation_close, or a
 * recorded finding_dismiss), whichever round raised it (core/finding-closure.ts).
 * low is always advisory (the closure set never contains low).
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
 * Full gate predicate (machine.ts evaluateReviewVerdict / guard-utils.ts), over
 * findings of every review round:
 *   status === 'open'
 *   && severity ∈ closure severities (critical/high/medium)
 *   && isEvidenceStateBlocking(evidenceState)
 *   && !isAdvisorySeverity(severity)
 */
export function isEvidenceStateBlocking(evidenceState: FindingEvidenceState | string | undefined | null): boolean {
  if (evidenceState == null) return true; // legacy finding missing field → treated as verified
  return evidenceState === 'verified';
}

/**
 * B-3fad CHK-001: The complete decision for "whether this finding blocks REVIEW→TEST".
 * effectiveBlockingSeverities is the closure set; `_round` is accepted for
 * existing callers and never changes the outcome (no round decay).
 */
export function isFindingBlocking(
  finding: Pick<Finding, 'status' | 'severity' | 'evidenceState'>,
  effectiveBlockingSeverities: readonly string[],
  _round: number,
): boolean {
  return finding.status === 'open'
    && effectiveBlockingSeverities.includes(finding.severity)
    && isEvidenceStateBlocking(finding.evidenceState)
    && !isAdvisorySeverity(finding.severity);
}

/**
 * Whether a severity is advisory (never blocking) in every review round.
 * low only: the closure severities never contain low, so low is
 * grouped as advisory and finding_list never places it under Blocking.
 */
export function isAdvisorySeverity(severity: FindingSeverity | string): boolean {
  return severity === 'low';
}

/**
 * Derives the current REVIEW roundCount from story.events.
 * Stays consistent with resolveEffectiveBlockingSeverities in core/finding-closure.ts:
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
