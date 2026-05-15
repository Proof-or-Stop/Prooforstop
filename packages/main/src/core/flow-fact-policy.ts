export type FlowFactPolicyId =
  | 'review-run-boundary'
  | 'review-pass'
  | 'review-pass-supersession'
  | 'finding'
  | 'pass-only-normalization'
  | 'review-round-iso-string'
  | 'express-verification-policy';

export interface FlowFactPolicyDefinition {
  name: `flow-policy:${FlowFactPolicyId}`;
  policyId: FlowFactPolicyId;
  disposition?: string;
  level: 'L4';
  category: 'flow-policy';
  owner: 'core/flow-fact-policy';
  consumerGate: string;
  artifactCommand?: string;
  semantics: readonly string[];
  rationale: string;
}

export const EXPRESS_VERIFICATION_EXEMPTION_MESSAGE =
  'Verification policy: express-exempt (channel=express; PLAN verificationIntent intentionally skipped)';

export const FLOW_FACT_POLICIES = [
  {
    name: 'flow-policy:review-run-boundary',
    policyId: 'review-run-boundary',
    level: 'L4',
    category: 'flow-policy',
    owner: 'core/flow-fact-policy',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    artifactCommand: 'review_run_start',
    semantics: ['flow-policy', 'review-run', 'schema-contract', 'gate-evidence'],
    rationale: 'Current REVIEW findings and passes only count when bound to the latest signed reviewer run for that lane.',
  },
  {
    name: 'flow-policy:review-pass',
    policyId: 'review-pass',
    level: 'L4',
    category: 'flow-policy',
    owner: 'core/flow-fact-policy',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    artifactCommand: 'review_pass_set',
    semantics: ['flow-policy', 'review-pass', 'no-blocker-evidence', 'gate-evidence'],
    rationale: 'Review pass is a signed no-blocker fact consumed by REVIEW to TEST gates.',
  },
  {
    name: 'flow-policy:review-pass-supersession',
    policyId: 'review-pass-supersession',
    level: 'L4',
    category: 'flow-policy',
    owner: 'core/flow-fact-policy',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    artifactCommand: 'review_pass_set',
    semantics: ['flow-policy', 'review-pass', 'supersession-policy', 'gate-evidence'],
    rationale: 'Older stale review pass receipts are ignored once the same lane records a newer valid pass; stale findings remain blocking.',
  },
  {
    name: 'flow-policy:finding',
    policyId: 'finding',
    level: 'L4',
    category: 'flow-policy',
    owner: 'core/flow-fact-policy',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    artifactCommand: 'finding_add',
    semantics: ['flow-policy', 'finding-state', 'blocker-state', 'gate-evidence'],
    rationale: 'Reviewer findings are signed blocker-state facts consumed by REVIEW gates.',
  },
  {
    name: 'flow-policy:pass-only-normalization',
    policyId: 'pass-only-normalization',
    disposition: 'finding_add:pass-only->review_pass_set',
    level: 'L4',
    category: 'flow-policy',
    owner: 'core/flow-fact-policy',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    artifactCommand: 'review_pass_set',
    semantics: ['flow-policy', 'normalization-policy', 'review-pass', 'gate-evidence'],
    rationale: 'Pass-only low-severity reviewer findings normalize to signed review pass receipts instead of open findings.',
  },
  {
    name: 'flow-policy:review-round-iso-string',
    policyId: 'review-round-iso-string',
    level: 'L4',
    category: 'flow-policy',
    owner: 'core/flow-fact-policy',
    consumerGate: 'review signatures and storyMachine.canPassReview REVIEW to TEST gate',
    artifactCommand: 'finding_add',
    semantics: ['flow-policy', 'schema-contract', 'finding-state', 'review-pass', 'gate-evidence'],
    rationale: 'reviewRound is an ISO 8601 string in signed findings and review passes.',
  },
  {
    name: 'flow-policy:express-verification-policy',
    policyId: 'express-verification-policy',
    disposition: 'express-exempt',
    level: 'L4',
    category: 'flow-policy',
    owner: 'core/flow-fact-policy',
    consumerGate: 'validate verification coverage and story_review PLAN fast-path advisory gate',
    semantics: ['flow-policy', 'verification-policy', 'gate-evidence'],
    rationale: 'Express channel stories may intentionally skip PLAN verificationIntent and must render that exemption explicitly.',
  },
] as const satisfies readonly FlowFactPolicyDefinition[];

export const PASS_ONLY_REVIEW_FINDING_POLICY = {
  reviewerAgentPrefix: 'koala-review-',
  severity: 'low',
  passPatterns: [
    /\b(no blocking issues?|no blocking issue found|no blockers?|0 blocking)\b/i,
    /\b(consistency check\s+passed|consistency check\s+pass|consistency passed)\b/i,
    /\b(?:docs?|documentation)\s+(?:consistency\s+)?(?:check\s+)?passed\b/i,
    /\b(?:test\s+coverage|coverage|concept|quality|channel)?\s*review\s+passed\b/i,
    /\bno\s+findings?\b/i,
    /\b(?:all\s+)?(?:checks?|scan|audit)\s+passed\b/i,
    /\bPASS(?:ED)?\b/,
    /\bno\s+concept\s+(?:changes?|removals?|deletions?|replacements?)\b/i,
    /\bno\s+(?:(?:docs?|documentation)\s+)?(?:drift|inconsistenc(?:y|ies)|mismatch)(?:\s+found)?\b/i,
    /(?:未发现|没有|无)(?:文档)?(?:不一致|漂移|错位|缺少|遗漏)/,
    /(?:本次)?无概念(?:变更|删除|替换)/,
    /文档一致性检查通过/,
    /一致性检查通过/,
    /检查通过/,
    /(?:极速|快速)通道.*(?:主 agent 自写|main agent).*?(?:合规|允许|符合规则)/,
    /退化模式.*(?:主 agent|main agent).*?(?:合规|允许|符合规则)/,
  ],
  neutralizePatterns: [
    /(?:未发现|没有|无)(?:文档)?(?:不一致|漂移|错位|缺少|遗漏)/g,
    /(?:本次)?无概念(?:变更|删除|替换)/g,
    /\bno\s+(?:(?:docs?|documentation)\s+)?(?:drift|inconsistenc(?:y|ies)|mismatch)(?:\s+found)?\b/gi,
  ],
  ambiguityPattern: /\b(?:but|except|however|unless)\b|但|但是|不过|除外|仍|失败|未通过|不一致|缺少|遗漏|blocker found|issue found|problem found|failed/i,
} as const;

export function isPassOnlyReviewFindingRecord(finding: { desc: string; severity: string; agent?: string }): boolean {
  if (finding.severity !== PASS_ONLY_REVIEW_FINDING_POLICY.severity) return false;
  if (!finding.agent?.startsWith(PASS_ONLY_REVIEW_FINDING_POLICY.reviewerAgentPrefix)) return false;
  const desc = finding.desc.trim();
  const neutralizedDesc = PASS_ONLY_REVIEW_FINDING_POLICY.neutralizePatterns.reduce(
    (current, pattern) => current.replace(pattern, ''),
    desc,
  );
  return PASS_ONLY_REVIEW_FINDING_POLICY.passPatterns.some(pattern => pattern.test(desc))
    && !PASS_ONLY_REVIEW_FINDING_POLICY.ambiguityPattern.test(neutralizedDesc);
}
