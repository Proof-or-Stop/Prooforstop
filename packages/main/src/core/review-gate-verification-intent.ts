import type { VerificationIntent, VerificationIntentItem, VerificationLane } from './types.js';

export type ReviewGateVerificationIntentIssue = {
  type: 'review_gate_as_verification_intent';
  severity: 'blocker';
  message: string;
};

/**
 * REVIEW outcomes are lifecycle evidence, not acceptance evidence. Requiring a
 * reviewer verdict as a must verificationIntent makes DEV -> REVIEW depend on
 * evidence that reviewers can produce only after that transition.
 */
export function reviewGateVerificationIntentIssue(intent: VerificationIntentItem): ReviewGateVerificationIntentIssue | null {
  if ((intent.priority ?? 'must') !== 'must') return null;
  const text = (typeof intent.desc === 'string' ? intent.desc : '').normalize('NFKC').toLowerCase();
  const executableType = intent.type === 'logic' || intent.type === 'cli' || intent.type === 'browser';
  const executablePin = executableType
    && typeof intent.verification?.command === 'string'
    && intent.verification.command.trim().length > 0
    && typeof intent.verification.selector === 'string'
    && intent.verification.selector.trim().length > 0;
  const reviewLifecycleCommandPin = executablePin
    && /\b(?:review_\w+|finding_\w+|story_advance|story_get|lifecycle_check|reviewer_list)\b/.test(intent.verification!.command);
  const productCommandSubject = executableType
    && /^(?:the\s+)?(?:review_pass_set|finding_add)(?:\s+command)?\b/.test(text);
  if ((executablePin && !reviewLifecycleCommandPin) || productCommandSubject) return null;
  const lifecycleReviewSubject = /\b(?:independent|external|peer|code|quality|security|test(?:[- ]coverage)?)\s+review(?:s|ers?)?\b|\breviewers?\s+(?:run|lane|pass|verdict|finding|record|report)|\breview\s+(?:runs?|lanes?|pass|verdict)\b|\breview_(?:run_start|pass_set)\b|\bfinding_add\b/.test(text);
  const noOpenReviewProblems = /\b(?:no|zero|without)\s+(?:(?:unresolved|open|outstanding|remaining)\s+)?(?:(?:critical|high)(?:\s+or\s+(?:critical|high))?\s+)?(?:blocking\s+)?(?:findings?|blockers?|issues?|defects?)\b/.test(text);
  const formalReviewVerdict = /\b(?:pass|approve(?:d|s)?|approval)\s+verdict\b|\b(?:records?|reports?|produces?|returns?|has|gets?|receives?)\s+(?:a\s+)?(?:pass|approved|approval|verdict)\b|\b(?:is|are|was|were)\s+(?:approved|passed|green|clean)\b|\bsign(?:s|ed)?[- ]off\b|\breview\s+(?:runs?|lanes?)\s+pass(?:es|ed)?\b|\b(?:independent|external|peer|code|quality|security|test(?:[- ]coverage)?)\s+reviews?\s+pass(?:es|ed)?\b/.test(text);
  if (!lifecycleReviewSubject || (!noOpenReviewProblems && !formalReviewVerdict)) return null;
  return {
    type: 'review_gate_as_verification_intent',
    severity: 'blocker',
    message: 'A REVIEW lifecycle outcome cannot be a verificationIntent required before REVIEW. Remove this verificationIntent; independent reviewers record the lifecycle result with review_pass_set or finding_add after the Story enters REVIEW. Keep verificationIntent limited to product behavior that DEV can prove.',
  };
}

export function assertNoReviewGateVerificationIntent(
  command: string,
  verificationIntent: VerificationIntent | undefined,
  itemId: string,
): void {
  if (!verificationIntent) return;
  for (const lane of ['happy', 'edge', 'adversarial'] as const satisfies readonly VerificationLane[]) {
    for (const [index, intent] of (verificationIntent[lane] ?? []).entries()) {
      const issue = reviewGateVerificationIntentIssue(intent);
      if (issue) {
        throw new Error(`${command} refused: ${itemId}:${lane}:${index}: ${issue.message} [${issue.type}]`);
      }
    }
  }
}
