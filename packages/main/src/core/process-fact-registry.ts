import {
  COMMAND_POLICIES,
  type CommandPolicy,
  type CommandDestructiveRisk,
  type CommandLifecycleStatus,
  type CommandPhase,
  type KnownCommandName,
} from './command-policy.js';
import { PROCESS_FACT_LEVELS, type ProcessFactLevel, type ProcessFactLevelEntry } from './process-fact-levels.js';

export type ProcessFactKind =
  | 'command'
  | 'runtime-behavior'
  | 'gate-evidence'
  | 'execution-status'
  | 'validation-status'
  | 'review-pass'
  | 'finding'
  | 'reviewer-lane'
  | 'signed-artifact'
  | 'artifact';

export type ProcessFactSemantic =
  | 'artifact'
  | 'blocker-state'
  | 'command'
  | 'execution-evidence'
  | 'finding-state'
  | 'gate-evidence'
  | 'no-blocker-evidence'
  | 'review-pass'
  | 'reviewer-lane'
  | 'runtime-behavior'
  | 'signed-artifact'
  | 'test-evidence'
  | 'validation-result'
  | 'validation-status'
  | 'verification-evidence';

export interface ProcessFactArtifactRef {
  name: string;
  path: string;
  signed: boolean;
  signature?: string;
  producerCommand?: string;
  consumerGate?: string;
  reviewerLane?: string;
}

export interface ProcessFactRegistryEntry {
  name: string;
  kind: ProcessFactKind;
  semantics: readonly ProcessFactSemantic[];
  level: ProcessFactLevel;
  lifecycle?: CommandLifecycleStatus;
  allowedPhases?: readonly CommandPhase[] | 'all';
  rootOnly?: boolean;
  legacy?: boolean;
  gateEvidence?: boolean;
  destructiveRisk?: CommandDestructiveRisk;
  producer: string;
  consumerGate?: string;
  artifact?: ProcessFactArtifactRef;
  reviewerLane?: string;
  rationale: string;
}

export const PROCESS_FACT_KIND_BY_COMMAND: Record<string, ProcessFactKind> = {
  validate: 'validation-status',
  test_add: 'execution-status',
  test_story: 'execution-status',
  verification_evidence_add: 'execution-status',
  verification_evidence_batch_add: 'execution-status',
  verification_evidence_refresh_stale: 'execution-status',
  review_pass_set: 'review-pass',
  finding_add: 'finding',
  finding_resolve: 'finding',
  finding_dismiss: 'finding',
};

export const PROCESS_FACT_REQUIRED_SEMANTICS = {
  validate: ['validation-status', 'validation-result', 'gate-evidence'],
  test_add: ['test-evidence', 'validation-result'],
  test_story: ['test-evidence', 'validation-result'],
  verification_evidence_add: ['execution-evidence', 'verification-evidence', 'gate-evidence'],
  verification_evidence_batch_add: ['execution-evidence', 'verification-evidence', 'gate-evidence'],
  verification_evidence_refresh_stale: ['execution-evidence', 'verification-evidence', 'gate-evidence'],
  review_pass_set: ['review-pass', 'no-blocker-evidence', 'gate-evidence'],
  finding_add: ['finding-state', 'blocker-state', 'gate-evidence'],
  finding_resolve: ['finding-state', 'blocker-state', 'gate-evidence'],
  finding_dismiss: ['finding-state', 'blocker-state', 'gate-evidence'],
} as const satisfies Record<string, readonly ProcessFactSemantic[]>;

export const PROCESS_FACT_ARTIFACT_BY_COMMAND: Record<string, ProcessFactArtifactRef> = {
  story_advance: {
    name: 'index.json',
    path: 'index.json',
    signed: false,
    producerCommand: 'story_advance',
    consumerGate: 'storyMachine phase guards and story_advance preflight gates',
  },
  story_review: {
    name: 'review.json',
    path: 'review.json',
    signed: true,
    signature: 'sha256(storyId:timestamp:issueCount:blockerCount:koala-review-integrity-v1)',
    producerCommand: 'story_review',
    consumerGate: 'storyMachine.canStartDev PLAN to DEV gate',
  },
  checklist_update: {
    name: 'checklist.json',
    path: 'checklist.json',
    signed: false,
    producerCommand: 'checklist_update',
    consumerGate: 'storyMachine.checklistAllDone DEV to REVIEW gate',
  },
  verification_evidence_add: {
    name: 'checklist.json',
    path: 'checklist.json',
    signed: false,
    producerCommand: 'verification_evidence_add',
    consumerGate: 'validate verification coverage and freshness gates',
  },
  verification_evidence_batch_add: {
    name: 'checklist.json',
    path: 'checklist.json',
    signed: false,
    producerCommand: 'verification_evidence_batch_add',
    consumerGate: 'validate verification coverage and freshness gates',
  },
  verification_evidence_refresh_stale: {
    name: 'checklist.json',
    path: 'checklist.json',
    signed: false,
    producerCommand: 'verification_evidence_refresh_stale',
    consumerGate: 'validate verification freshness gate',
  },
  review_pass_set: {
    name: 'review-passes.json',
    path: 'review-passes.json',
    signed: true,
    signature: 'signReviewPass/verifyReviewPass',
    producerCommand: 'review_pass_set',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  finding_add: {
    name: 'findings.json',
    path: 'findings.json',
    signed: true,
    signature: 'signFinding/verifyFinding',
    producerCommand: 'finding_add',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  finding_resolve: {
    name: 'findings.json',
    path: 'findings.json',
    signed: true,
    signature: 'existing finding signature remains gate-verified',
    producerCommand: 'finding_resolve',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  finding_dismiss: {
    name: 'findings.json',
    path: 'findings.json',
    signed: true,
    signature: 'existing finding signature remains gate-verified',
    producerCommand: 'finding_dismiss',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
  },
  init_check_set: {
    name: 'init-check.json',
    path: 'init-check.json',
    signed: true,
    signature: 'signInitCheck/recomputeInitCheckHash',
    producerCommand: 'init_check_set',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    reviewerLane: 'koala-review-story-init',
  },
  delivery_check_set: {
    name: 'delivery-check.json',
    path: 'delivery-check.json',
    signed: true,
    signature: 'signDeliveryCheck/recomputeDeliveryCheckHash',
    producerCommand: 'delivery_check_set',
    consumerGate: 'storyMachine.canFinish DONE gate',
    reviewerLane: 'koala-review-delivery',
  },
  delivery_waiver_add: {
    name: 'delivery-check.json',
    path: 'delivery-check.json',
    signed: true,
    signature: 'signDeliveryCheck/recomputeDeliveryCheckHash',
    producerCommand: 'delivery_waiver_add',
    consumerGate: 'storyMachine.canFinish DONE gate',
  },
  scope_check_save: {
    name: 'scope-check.json',
    path: 'scope-check.json',
    signed: true,
    signature: 'signScopeCheck',
    producerCommand: 'scope_check_save',
    consumerGate: 'story_review scope-check gate',
    reviewerLane: 'koala-review-scope-plan',
  },
  scope_question_resolve: {
    name: 'scope-check.json',
    path: 'scope-check.json',
    signed: true,
    signature: 'scope-check signature domain intentionally excludes main-agent resolution',
    producerCommand: 'scope_question_resolve',
    consumerGate: 'story_review open question gate',
  },
  draft_check_set: {
    name: 'draft-check.json',
    path: 'draft-check.json',
    signed: true,
    signature: 'computeDraftCheckHash',
    producerCommand: 'draft_check_set',
    consumerGate: 'story_create fromDraft preflight',
  },
  draft_issue_resolve: {
    name: 'draft-check.json',
    path: 'draft-check.json',
    signed: true,
    signature: 'draft-check signature domain intentionally excludes issue resolution',
    producerCommand: 'draft_issue_resolve',
    consumerGate: 'story_create fromDraft preflight',
  },
  summary_set: {
    name: 'summary.json',
    path: 'summary.json',
    signed: false,
    producerCommand: 'summary_set',
    consumerGate: 'story_advance DONE summary checklist',
  },
  test_add: {
    name: 'test-evidence.json',
    path: 'test-evidence.json',
    signed: false,
    producerCommand: 'test_add',
    consumerGate: 'storyMachine.canFinish DONE gate',
  },
  test_story: {
    name: 'test-evidence.json',
    path: 'test-evidence.json',
    signed: false,
    producerCommand: 'test_story',
    consumerGate: 'storyMachine.canFinish DONE gate',
  },
  validate: {
    name: 'test-evidence.json',
    path: 'test-evidence.json',
    signed: false,
    producerCommand: 'validate',
    consumerGate: 'story_advance TEST and DONE validation gate',
  },
  evaluate_save: {
    name: 'eval-evidence.json',
    path: 'eval-evidence.json',
    signed: false,
    producerCommand: 'evaluate_save',
    consumerGate: 'story_advance DONE evaluator evidence gate',
  },
  verify_codex: {
    name: 'process-events.jsonl',
    path: 'process-events.jsonl',
    signed: false,
    producerCommand: 'verify_codex',
    consumerGate: 'Codex adapter REVIEW and DONE evidence gate',
  },
};

export const PROCESS_FACT_REVIEWER_LANE_NAMES = [
  'koala-review-story-init',
  'product-reviewer',
  'koala-review-scope-plan',
  'koala-review-concept',
  'koala-review-quality',
  'koala-review-test-coverage',
  'koala-review-behavior',
  'koala-review-docs',
  'koala-review-channel',
  'koala-review-delivery',
] as const;

function isRequiredArtifactRef(artifact: ProcessFactArtifactRef): boolean {
  return artifact.signed || Boolean(artifact.consumerGate);
}

export const PROCESS_FACT_REQUIRED_ARTIFACT_NAMES = [...new Set(
  Object.values(PROCESS_FACT_ARTIFACT_BY_COMMAND)
    .filter(isRequiredArtifactRef)
    .map((artifact) => artifact.path),
)] as readonly string[];

export const PROCESS_FACT_REVIEWER_LANE_DEFINITIONS = [
  {
    name: 'reviewer-lane:koala-review-story-init',
    producer: 'koala-review-story-init',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    reviewerLane: 'koala-review-story-init',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.init_check_set,
    rationale: 'INIT reviewer writes signed init-check evidence before worktree bootstrap.',
  },
  {
    name: 'reviewer-lane:product-reviewer',
    producer: 'product-reviewer',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    reviewerLane: 'product-reviewer',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.init_check_set,
    rationale: 'Product init reviewer is a required init-check producer for user-value readiness.',
  },
  {
    name: 'reviewer-lane:koala-review-scope-plan',
    producer: 'koala-review-scope-plan',
    consumerGate: 'story_review scope-check gate',
    reviewerLane: 'koala-review-scope-plan',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.scope_check_save,
    rationale: 'PLAN scope reviewer signs scope-check evidence before implementation.',
  },
  {
    name: 'reviewer-lane:koala-review-concept',
    producer: 'koala-review-concept',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'koala-review-concept',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Baseline concept reviewer records findings or no-blocker review pass evidence.',
  },
  {
    name: 'reviewer-lane:koala-review-quality',
    producer: 'koala-review-quality',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'koala-review-quality',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Baseline quality reviewer records findings or no-blocker review pass evidence.',
  },
  {
    name: 'reviewer-lane:koala-review-test-coverage',
    producer: 'koala-review-test-coverage',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'koala-review-test-coverage',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Coverage reviewer checks verificationIntent to verificationEvidence coverage.',
  },
  {
    name: 'reviewer-lane:koala-review-behavior',
    producer: 'koala-review-behavior',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'koala-review-behavior',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Risk-triggered behavior reviewer records findings or no-blocker evidence.',
  },
  {
    name: 'reviewer-lane:koala-review-docs',
    producer: 'koala-review-docs',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'koala-review-docs',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Docs reviewer records docs drift findings or no-blocker evidence.',
  },
  {
    name: 'reviewer-lane:koala-review-channel',
    producer: 'koala-review-channel',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    reviewerLane: 'koala-review-channel',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'Retired compatibility reviewer lane still uses signed findings/review-pass evidence when invoked.',
  },
  {
    name: 'reviewer-lane:koala-review-delivery',
    producer: 'koala-review-delivery',
    consumerGate: 'storyMachine.canFinish DONE gate',
    reviewerLane: 'koala-review-delivery',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.delivery_check_set,
    rationale: 'Delivery reviewer signs delivery-check evidence before DONE.',
  },
] as const;

function uniqueSemantics(...groups: ReadonlyArray<readonly ProcessFactSemantic[]>): ProcessFactSemantic[] {
  const out = new Set<ProcessFactSemantic>();
  for (const group of groups) {
    for (const semantic of group) out.add(semantic);
  }
  return [...out];
}

function commandFactKind(name: string, level: ProcessFactLevel): ProcessFactKind {
  if (PROCESS_FACT_KIND_BY_COMMAND[name]) return PROCESS_FACT_KIND_BY_COMMAND[name];
  if (name.startsWith('runtime:')) return 'runtime-behavior';
  return level === 'L4' ? 'gate-evidence' : 'command';
}

function commandFactSemantics(name: string, level: ProcessFactLevel): ProcessFactSemantic[] {
  if (name.startsWith('runtime:')) return ['runtime-behavior'];
  const required: readonly ProcessFactSemantic[] =
    PROCESS_FACT_REQUIRED_SEMANTICS[name as keyof typeof PROCESS_FACT_REQUIRED_SEMANTICS] ?? [];
  const defaults: ProcessFactSemantic[] = [];
  if (level === 'L4') defaults.push('gate-evidence');
  if (required.length === 0 && level !== 'L4') defaults.push('command');
  return uniqueSemantics(required, defaults);
}

function artifactFactSemantics(artifact: ProcessFactArtifactRef): ProcessFactSemantic[] {
  const semantics: ProcessFactSemantic[] = ['artifact'];
  if (artifact.signed) semantics.push('signed-artifact');
  if (artifact.path === 'test-evidence.json') semantics.push('validation-result', 'test-evidence');
  if (artifact.path === 'eval-evidence.json') semantics.push('validation-result');
  return semantics;
}

function commandPolicy(name: string): CommandPolicy | undefined {
  return COMMAND_POLICIES[name as KnownCommandName] as CommandPolicy | undefined;
}

const COMMAND_PROCESS_FACTS: ProcessFactRegistryEntry[] = PROCESS_FACT_LEVELS.map((entry: ProcessFactLevelEntry) => {
  const policy = commandPolicy(entry.name);
  const rootOnly = policy ? policy.rootOnly === true || policy.status === 'rootOnly' : undefined;
  const gateEvidence = policy ? policy.gateEvidence === true || policy.status === 'gateEvidence' : undefined;
  return {
    name: entry.name,
    kind: commandFactKind(entry.name, entry.level),
    semantics: commandFactSemantics(entry.name, entry.level),
    level: entry.level,
    lifecycle: policy?.status,
    allowedPhases: policy?.allowedPhases,
    rootOnly,
    legacy: policy ? policy.status === 'legacy' : undefined,
    gateEvidence,
    destructiveRisk: policy?.destructiveRisk,
    producer: entry.owner,
    consumerGate: entry.gateConsumer,
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND[entry.name],
    reviewerLane: PROCESS_FACT_ARTIFACT_BY_COMMAND[entry.name]?.reviewerLane,
    rationale: entry.rationale,
  };
});

export const PROCESS_FACT_REVIEWER_LANES = PROCESS_FACT_REVIEWER_LANE_DEFINITIONS.map((entry) => ({
  ...entry,
  kind: 'reviewer-lane' as const,
  semantics: ['reviewer-lane', 'gate-evidence'] as const,
  level: 'L4' as const,
})) as readonly ProcessFactRegistryEntry[];

export const PROCESS_FACT_ARTIFACTS = [
  {
    name: 'artifact:index.json',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/story-advance',
    consumerGate: 'storyMachine phase guards and story_advance preflight gates',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.story_advance,
    rationale: 'Story index state is consumed by lifecycle phase guards and preflight checks.',
  },
  {
    name: 'artifact:review.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/story-review',
    consumerGate: 'storyMachine.canStartDev PLAN to DEV gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.story_review,
    rationale: 'PLAN review signature is checked before DEV.',
  },
  {
    name: 'artifact:checklist.json',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/checklist',
    consumerGate: 'storyMachine.checklistAllDone DEV to REVIEW gate and validate verification coverage/freshness gates',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.checklist_update,
    rationale: 'Checklist status and verification evidence are consumed by REVIEW and validate gates.',
  },
  {
    name: 'artifact:init-check.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/init-check',
    consumerGate: 'storyMachine.canEnterInitCheck INIT to INIT_CHECK gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.init_check_set,
    rationale: 'Init-check signature is checked before worktree bootstrap.',
  },
  {
    name: 'artifact:scope-check.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/scope-check',
    consumerGate: 'story_review scope-check gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.scope_check_save,
    rationale: 'Scope-check signature is consumed by PLAN review.',
  },
  {
    name: 'artifact:delivery-check.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/delivery-check',
    consumerGate: 'storyMachine.canFinish DONE gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.delivery_check_set,
    rationale: 'Delivery-check signature is consumed by DONE.',
  },
  {
    name: 'artifact:findings.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'blocker-state', 'finding-state'],
    level: 'L4',
    producer: 'handlers/finding',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.finding_add,
    rationale: 'Reviewer finding signatures prevent main-agent forgery.',
  },
  {
    name: 'artifact:review-passes.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence', 'review-pass', 'no-blocker-evidence'],
    level: 'L4',
    producer: 'handlers/finding',
    consumerGate: 'storyMachine.canPassReview REVIEW to TEST gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.review_pass_set,
    rationale: 'No-blocker review pass signatures are accepted by the review gate.',
  },
  {
    name: 'artifact:draft-check.json',
    kind: 'signed-artifact',
    semantics: ['artifact', 'signed-artifact', 'gate-evidence'],
    level: 'L3',
    producer: 'handlers/draft-check',
    consumerGate: 'story_create fromDraft preflight',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.draft_check_set,
    rationale: 'Draft check signature protects reviewed draft inputs before story creation.',
  },
  {
    name: 'artifact:summary.json',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/summary',
    consumerGate: 'story_advance DONE summary checklist',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.summary_set,
    rationale: 'DONE summary content is consumed by completion and delivery gates.',
  },
  {
    name: 'artifact:test-evidence.json',
    kind: 'artifact',
    semantics: ['artifact', 'validation-result', 'test-evidence', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/verifier',
    consumerGate: 'storyMachine.canFinish DONE gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.validate,
    rationale: 'Validation status artifact is required before DONE.',
  },
  {
    name: 'artifact:eval-evidence.json',
    kind: 'artifact',
    semantics: ['artifact', 'validation-result', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/evaluate',
    consumerGate: 'story_advance DONE evaluator evidence gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.evaluate_save,
    rationale: 'Evaluator evidence artifact is consumed by DONE for browser projects.',
  },
  {
    name: 'artifact:process-events.jsonl',
    kind: 'artifact',
    semantics: ['artifact', 'gate-evidence'],
    level: 'L4',
    producer: 'handlers/verify-codex',
    consumerGate: 'Codex adapter REVIEW and DONE evidence gate',
    artifact: PROCESS_FACT_ARTIFACT_BY_COMMAND.verify_codex,
    rationale: 'Codex adapter verification evidence is recorded in process events and consumed by adapter gates.',
  },
] as const satisfies readonly ProcessFactRegistryEntry[];

export const PROCESS_FACT_SIGNED_ARTIFACTS = PROCESS_FACT_ARTIFACTS.filter(
  (entry) => entry.artifact?.signed === true,
) as readonly ProcessFactRegistryEntry[];

export const PROCESS_FACT_REQUIRED_ARTIFACTS = PROCESS_FACT_ARTIFACTS.filter(
  (entry) => entry.artifact && PROCESS_FACT_REQUIRED_ARTIFACT_NAMES.includes(entry.artifact.path as typeof PROCESS_FACT_REQUIRED_ARTIFACT_NAMES[number]),
) as readonly ProcessFactRegistryEntry[];

export const PROCESS_FACT_REGISTRY: readonly ProcessFactRegistryEntry[] = [
  ...COMMAND_PROCESS_FACTS,
  ...PROCESS_FACT_REVIEWER_LANES,
  ...PROCESS_FACT_ARTIFACTS,
];

export const PROCESS_FACT_REGISTRY_BY_NAME: Record<string, ProcessFactRegistryEntry> = Object.fromEntries(
  PROCESS_FACT_REGISTRY.map((entry) => [entry.name, entry]),
) as Record<string, ProcessFactRegistryEntry>;

export function getProcessFactRegistryEntry(name: string): ProcessFactRegistryEntry | undefined {
  return PROCESS_FACT_REGISTRY_BY_NAME[name];
}

export function hasProcessFactSemantic(name: string, semantic: ProcessFactSemantic): boolean {
  return PROCESS_FACT_REGISTRY_BY_NAME[name]?.semantics.includes(semantic) ?? false;
}
