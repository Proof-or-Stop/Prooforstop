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
      return `运行 testintent_handoff --storyId=${storyId} 生成交接包，交给 test-intent agent 补齐 testIntent.happy，然后重新执行 story_review 与 story_advance --storyId=${storyId} --phase=${targetPhase}`;
    case 'story_review_missing':
      return `先执行 story_review --storyId=${storyId} 生成审查记录，再推进 ${targetPhase}`;
    case 'review_signature_invalid':
      return `不要手改 review.json。重新执行 story_review --storyId=${storyId}，让 CLI 重建合法签名。`;
    case 'story_review_failed':
      return `先修复最近一轮 story_review 的 blocker，再执行 story_advance --storyId=${storyId} --phase=${targetPhase}`;
    case 'dev_checklist_incomplete':
      return `先把 DEV 阶段 checklist 做完并标成 done，再推进到 ${targetPhase}`;
    case 'review_failed':
      return rollbackPhase
        ? `reviewer 还没通过。先回 ${rollbackPhase} 修代码或 case，再重新申请进入 ${targetPhase}`
        : `reviewer 还没通过。先修代码或 case，再重新申请进入 ${targetPhase}`;
    case 'test_evidence_missing':
      return `先执行 test_story --storyId=${storyId} 生成测试证据，再推进到 ${targetPhase}`;
    case 'test_failed':
      return `先修复失败测试并确认最新 evidence=PASS，再推进到 ${targetPhase}`;
    case 'bug_open':
      return `先修复所有 open bug 并标 fixed，再推进到 ${targetPhase}`;
    case 'transition_blocked':
      return `检查 ${targetPhase} 的 phase gate 缺口，补齐后再执行 story_advance --storyId=${storyId} --phase=${targetPhase}`;
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
