import type { PhaseInvariantIssue, PhaseGateDecision, StoryAdvanceReasonCode, StoryPhase } from './types.js';

function mapIssueCodeToReasonCode(code: string): StoryAdvanceReasonCode {
  switch (code) {
    case 'missing_test_intent_happy':
      return 'missing_test_intent';
    case 'missing_story_review':
      return 'story_review_missing';
    case 'invalid_story_review_signature':
      return 'review_signature_invalid';
    case 'story_review_blockers':
      return 'story_review_failed';
    case 'pending_dev_checklist_items':
      return 'dev_checklist_incomplete';
    case 'testintent_not_passed':
      return 'review_failed';
    case 'missing_test_evidence':
      return 'test_evidence_missing';
    case 'test_not_passed':
      return 'test_failed';
    case 'open_bugs':
      return 'bug_open';
    default:
      return 'transition_blocked';
  }
}

function buildHumanHint(
  reasonCode: StoryAdvanceReasonCode | null,
  storyId: string,
  targetPhase: string,
  rollbackPhase?: StoryPhase | null,
): string | null {
  switch (reasonCode) {
    case 'missing_test_intent':
      return `Run testintent_handoff --storyId=${storyId} to generate the handoff package, hand it to the test-intent agent to fill in testIntent.happy, then re-run story_review and story_advance --storyId=${storyId} --phase=${targetPhase}`;
    case 'story_review_missing':
      return `First run story_review --storyId=${storyId} to generate the review record, then advance to ${targetPhase}`;
    case 'review_signature_invalid':
      return `Do not manually edit review.json. Re-run story_review --storyId=${storyId} to let the CLI rebuild a valid signature.`;
    case 'story_review_failed':
      return `First fix the blockers from the most recent story_review round, then run story_advance --storyId=${storyId} --phase=${targetPhase}`;
    case 'dev_checklist_incomplete':
      return `First complete the DEV phase checklist and mark items as done, then advance to ${targetPhase}`;
    case 'review_failed':
      return rollbackPhase
        ? `Reviewer has not passed yet. First go back to ${rollbackPhase} to fix code or cases, then re-request entry into ${targetPhase}`
        : `Reviewer has not passed yet. First fix code or cases, then re-request entry into ${targetPhase}`;
    case 'test_evidence_missing':
      return `First run test_story --storyId=${storyId} to generate test evidence, then advance to ${targetPhase}`;
    case 'test_failed':
      return `First fix failing tests and confirm the latest evidence=PASS, then advance to ${targetPhase}`;
    case 'bug_open':
      return `First fix all open bugs and mark them fixed, then advance to ${targetPhase}`;
    case 'transition_blocked':
      return `Check the phase gate gaps for ${targetPhase}, fill them in, then run story_advance --storyId=${storyId} --phase=${targetPhase}`;
    default:
      return null;
  }
}

export function buildPhaseGateDecision(args: {
  storyId: string;
  targetPhase: string;
  issues: PhaseInvariantIssue[];
}): PhaseGateDecision {
  const reasonCode = args.issues.length > 0 ? mapIssueCodeToReasonCode(args.issues[0].code) : null;
  return {
    targetPhase: args.targetPhase,
    ok: args.issues.length === 0,
    outcome: args.issues.length === 0 ? 'allow' : 'block',
    reasonCode,
    issues: args.issues,
    humanHint: buildHumanHint(reasonCode, args.storyId, args.targetPhase),
    rollbackPhase: null,
  };
}

export function buildRollbackDecision(args: {
  storyId: string;
  targetPhase: string;
  rollbackPhase: StoryPhase;
  reasonCode: StoryAdvanceReasonCode;
  issues: PhaseInvariantIssue[];
}): PhaseGateDecision {
  return {
    targetPhase: args.targetPhase,
    ok: false,
    outcome: 'rollback',
    reasonCode: args.reasonCode,
    issues: args.issues,
    humanHint: buildHumanHint(args.reasonCode, args.storyId, args.targetPhase, args.rollbackPhase),
    rollbackPhase: args.rollbackPhase,
  };
}

export function formatPhaseGateDecision(decision: PhaseGateDecision): string | null {
  if (decision.ok) return null;
  const lines = [
    decision.outcome === 'rollback'
      ? `Gate failed → auto rollback to ${decision.rollbackPhase ?? 'previous phase'}`
      : `Cannot enter ${decision.targetPhase}:`,
  ];
  if (decision.reasonCode) lines.push(`Reason code: ${decision.reasonCode}`);
  if (decision.issues.length > 0) {
    for (const issue of decision.issues) {
      lines.push(`  - [${issue.code}] ${issue.detail}`);
    }
  }
  if (decision.humanHint) {
    lines.push('');
    lines.push(`Human hint: ${decision.humanHint}`);
  }
  return lines.join('\n');
}
