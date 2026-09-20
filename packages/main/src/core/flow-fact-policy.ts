import { isRegisteredReviewAgent } from './agent-dispatch-registry.js';

export type FlowFactPolicyId =
  | 'review-run-boundary'
  | 'review-pass'
  | 'review-pass-supersession'
  | 'finding'
  | 'pass-only-normalization'
  | 'review-round-iso-string'
  | 'express-verification-policy'
  | 'implementation-worker-authority'
  | 'repository-wide-verification-intent';

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
    rationale: 'Current REVIEW PASS evidence counts when its bound reviewer run is material- and scope-fresh in the current round; id-recency (being the latest run on the lane) is NOT required. FINDING evidence keeps the latest-run binding so an open finding bound to a non-latest run still surfaces (kind-aware review-run binding; see review-run-binding-race.md).',
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
  {
    name: 'flow-policy:implementation-worker-authority',
    policyId: 'implementation-worker-authority',
    level: 'L4',
    category: 'flow-policy',
    owner: 'core/flow-fact-policy',
    consumerGate: 'validate --channel normal-channel gate before DEV to REVIEW',
    semantics: ['flow-policy', 'gate-evidence'],
    rationale: 'Normal-channel implementation requires canonical dispatch or successful subagent-result process evidence for every non-exempt checklist item. Git commit author text remains audit attribution and cannot grant worker, lifecycle, reviewer, or control-plane authority.',
  },
  {
    name: 'flow-policy:repository-wide-verification-intent',
    policyId: 'repository-wide-verification-intent',
    level: 'L4',
    category: 'flow-policy',
    owner: 'core/flow-fact-policy',
    consumerGate: 'story_review PLAN verification-intent quality gate and REVIEW test-coverage audit',
    artifactCommand: 'story_review',
    semantics: ['flow-policy', 'verification-policy', 'gate-evidence'],
    rationale: 'PLAN rejects a self-authored repository-wide must, including unannotated standard full-suite commands. Repository health stays a baseline-referenced should-level review input; only an explicit external verifier requirement with a source pointer may retain repository-wide success as must.',
  },
] as const satisfies readonly FlowFactPolicyDefinition[];

export const PASS_ONLY_REVIEW_FINDING_POLICY = {
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
    /(?:not found|none|no)(?:documentation)?(?:inconsistency|drift|mismatch|missing|omission)/,
    /(?:this time)?no concept(?:change|deletion|replacement)/,
    /documentation consistency check passed/,
    /consistency check passed/,
    /check passed/,
    /(?:express|fast) channel.*(?:main agent self-write|main agent).*?(?:compliant|allowed|conforms to rules)/i,
    /degraded mode.*(?:main agent|main agent).*?(?:compliant|allowed|conforms to rules)/i,
    /(?:\u65e0|\u6ca1\u6709)(?:\u963b\u585e|\u9ad8\u5371|\u95ee\u9898|\u53d1\u73b0|\u5f02\u5e38|\u9057\u6f0f|\u4e0d\u4e00\u81f4)/u,
    /(?:\u5ba1\u67e5|\u68c0\u67e5|\u626b\u63cf|\u9a8c\u8bc1)(?:\u5df2)?(?:\u901a\u8fc7|\u901a\u8fc7\u4e86)/u,
    /(?:\u901a\u8fc7|\u5168\u90e8\u901a\u8fc7)(?:\uff1a|:)?/u,
  ],
  neutralizePatterns: [
    /(?:not found|none|no)(?:documentation)?(?:inconsistency|drift|mismatch|missing|omission)/g,
    /(?:this time)?no concept(?:change|deletion|replacement)/g,
    /\bno\s+(?:(?:docs?|documentation)\s+)?(?:drift|inconsistenc(?:y|ies)|mismatch)(?:\s+found)?\b/gi,
    /(?:\u65e0|\u6ca1\u6709)(?:\u963b\u585e|\u9ad8\u5371|\u95ee\u9898|\u53d1\u73b0|\u5f02\u5e38|\u9057\u6f0f|\u4e0d\u4e00\u81f4)/gu,
  ],
  ambiguityPattern: /\b(?:but|except|however|unless)\b|but|however|nevertheless|except|still|failed|did not pass|inconsistent|missing|omitted|blocker found|issue found|problem found|failed|\u4f46|\u4f46\u662f|\u7136\u800c|\u4ecd|\u4ecd\u7136|\u8fd8\u6709|\u5931\u8d25|\u672a\u901a\u8fc7|\u4e0d\u901a\u8fc7|\u6709\u95ee\u9898|\u6709\u963b\u585e|\u53d1\u73b0\u95ee\u9898|\u4e0d\u4e00\u81f4|\u7f3a\u5931|\u9057\u6f0f/i,
} as const;

export function isPassOnlyReviewFindingRecord(finding: { desc: string; severity: string; agent?: string }): boolean {
  if (finding.severity !== PASS_ONLY_REVIEW_FINDING_POLICY.severity) return false;
  if (!isRegisteredReviewAgent(finding.agent)) return false;
  const desc = finding.desc.trim();
  const neutralizedDesc = PASS_ONLY_REVIEW_FINDING_POLICY.neutralizePatterns.reduce(
    (current, pattern) => current.replace(pattern, ''),
    desc,
  );
  return PASS_ONLY_REVIEW_FINDING_POLICY.passPatterns.some(pattern => pattern.test(desc))
    && !PASS_ONLY_REVIEW_FINDING_POLICY.ambiguityPattern.test(neutralizedDesc);
}
