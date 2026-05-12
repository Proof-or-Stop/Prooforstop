export type CommandLifecycleStatus =
  | 'supported'
  | 'rootOnly'
  | 'legacy'
  | 'retired'
  | 'maintenance'
  | 'gateEvidence';

export type CommandPhase = 'INIT' | 'INIT_CHECK' | 'PLAN' | 'DEV' | 'REVIEW' | 'TEST' | 'DONE';

export type CommandDestructiveRisk =
  | 'none'
  | 'metadata-write'
  | 'fixture-write'
  | 'workspace-destructive';

export interface CommandPolicy {
  status: CommandLifecycleStatus;
  reason: string;
  allowedPhases?: readonly CommandPhase[] | 'all';
  rootOnly?: boolean;
  replacement?: string;
  destructiveRisk?: CommandDestructiveRisk;
  gateEvidence?: boolean;
  retiredReason?: string;
}

export const COMMAND_POLICY_SOURCE = 'packages/main/src/core/command-policy.ts';

const ALL_PHASES = ['INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE'] as const;

export const COMMAND_POLICIES = {
  story_create: { status: 'rootOnly', rootOnly: true, destructiveRisk: 'metadata-write', reason: 'Creates a new story envelope; run from the project root before entering a story worktree.' },
  story_advance: { status: 'gateEvidence', gateEvidence: true, allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Lifecycle transition command guarded by story phase preflight checks.' },
  story_update: { status: 'supported', allowedPhases: ['INIT', 'PLAN'], destructiveRisk: 'metadata-write', reason: 'Story metadata may be edited only before development freezes scope.' },
  story_get: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only story inspection.' },
  story_list: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only story listing.' },
  story_reconcile: { status: 'maintenance', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Repairs zombie story/worktree residue through explicit maintenance flow.' },
  story_discard: { status: 'maintenance', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Terminal story cleanup path with explicit discard semantics.' },
  story_draft: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Drafts are pre-story metadata and remain available across phases.' },
  story_draft_list: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only draft listing.' },
  story_draft_discard: { status: 'maintenance', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Explicit draft cleanup command.' },
  draft_check_set: { status: 'gateEvidence', gateEvidence: true, allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Writes durable draft review evidence before formal story creation.' },
  draft_issue_resolve: { status: 'gateEvidence', gateEvidence: true, allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Adds durable resolution evidence to a draft check.' },
  story_review: { status: 'gateEvidence', gateEvidence: true, allowedPhases: ['PLAN'], destructiveRisk: 'metadata-write', reason: 'PLAN review evidence is produced before DEV starts.' },
  story_review_dismiss: { status: 'supported', allowedPhases: ['PLAN'], destructiveRisk: 'metadata-write', reason: 'Risk dismissals belong to PLAN review before implementation starts.' },
  testintent_handoff: { status: 'supported', allowedPhases: ['PLAN'], destructiveRisk: 'none', reason: 'Generates verification handoff context during planning.' },
  checklist_get: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only checklist inspection.' },
  checklist_add: { status: 'supported', allowedPhases: ['PLAN', 'DEV'], destructiveRisk: 'metadata-write', reason: 'Checklist structure changes are limited to planning and active development.' },
  checklist_remove: { status: 'supported', allowedPhases: ['PLAN', 'DEV'], destructiveRisk: 'metadata-write', reason: 'Checklist removal requires explicit disposition before review/test phases.' },
  checklist_update: { status: 'gateEvidence', gateEvidence: true, allowedPhases: ['INIT', 'PLAN', 'DEV'], destructiveRisk: 'metadata-write', reason: 'Checklist status and verification evidence feed DEV/REVIEW gates.' },
  verification_evidence_add: { status: 'gateEvidence', gateEvidence: true, allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Writes structured verification evidence consumed by checklist and freshness gates.' },
  verification_evidence_batch_add: { status: 'gateEvidence', gateEvidence: true, allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Batch writes structured verification evidence consumed by gates.' },
  verification_evidence_refresh_stale: { status: 'gateEvidence', gateEvidence: true, allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Refreshes hashes on evidence used by stale-evidence gates.' },
  light_review: { status: 'supported', allowedPhases: ['DEV'], destructiveRisk: 'metadata-write', reason: 'Light review is a DEV coordination note, not REVIEW gate evidence.' },
  review_pass_set: { status: 'gateEvidence', gateEvidence: true, allowedPhases: ['DEV', 'REVIEW'], destructiveRisk: 'metadata-write', reason: 'Reviewer no-blocker receipt consumed by review gates.' },
  understanding_set: { status: 'supported', allowedPhases: ['PLAN'], destructiveRisk: 'metadata-write', reason: 'Planning context is captured before implementation.' },
  understanding_get: { status: 'supported', allowedPhases: ['PLAN', 'REVIEW'], destructiveRisk: 'none', reason: 'Read-only planning-context inspection; reviewers need planning artifacts during REVIEW.' },
  decision_set: { status: 'supported', allowedPhases: ['PLAN'], destructiveRisk: 'metadata-write', reason: 'Structured decision record belongs to PLAN.' },
  decision_get: { status: 'supported', allowedPhases: ['PLAN', 'REVIEW'], destructiveRisk: 'none', reason: 'Read-only decision inspection; reviewers need planning artifacts during REVIEW.' },
  summary_set: { status: 'gateEvidence', gateEvidence: true, allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Writes DONE summary evidence consumed by completion gates.' },
  summary_get: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only summary inspection.' },
  bug_report: { status: 'supported', allowedPhases: ['REVIEW', 'TEST'], destructiveRisk: 'metadata-write', reason: 'Bug records are REVIEW/TEST feedback artifacts, not DEV implementation state.' },
  bug_update: { status: 'supported', allowedPhases: ['REVIEW', 'TEST'], destructiveRisk: 'metadata-write', reason: 'Bug status changes belong to REVIEW/TEST feedback loops.' },
  bug_list: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only bug inspection.' },
  bug_analyze: { status: 'supported', allowedPhases: ['TEST'], destructiveRisk: 'none', reason: 'Bug quality analysis is a TEST-phase diagnostic.' },
  test_add: { status: 'legacy', rootOnly: true, gateEvidence: true, destructiveRisk: 'metadata-write', replacement: 'Use verification_evidence_add or checklist_update verificationEvidence after running koala validate/project-native tests.', reason: 'Legacy test-evidence writer retained for compatibility; current flow records verificationEvidence on checklist items.' },
  test_list: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only latest test evidence snapshot.' },
  fixture_get: { status: 'rootOnly', rootOnly: true, destructiveRisk: 'none', replacement: 'Prefer verification_evidence_add/checklist_update evidence over direct fixture inspection in active stories.', reason: 'Fixture JSON is legacy test infrastructure and is kept out of active story phase tools by default.' },
  fixture_update: { status: 'legacy', rootOnly: true, destructiveRisk: 'fixture-write', replacement: 'Prefer project-native tests plus verification_evidence_add; if maintaining fixtures, use fixture_batch_add --dryRun first.', reason: 'Legacy fixture replacement command can overwrite case arrays and should not be opened in phaseTools casually.' },
  fixture_batch_add: { status: 'legacy', rootOnly: true, destructiveRisk: 'fixture-write', replacement: 'Prefer koala validate/project-native tests plus verification_evidence_add; for fixture maintenance, use --dryRun and validateExecute before writing.', reason: 'Legacy fixture authoring remains available for maintenance but is not the active story verification path.' },
  test_auto: { status: 'legacy', rootOnly: true, destructiveRisk: 'workspace-destructive', replacement: 'Use koala validate --story=<storyId> and record verificationEvidence; test_auto full regression requires dryRun/confirm and is blocked for koala self-project full runs.', reason: 'Legacy full fixture runner performs git restore/git clean cleanup and is not opened in active story phaseTools.' },
  test_story: { status: 'legacy', rootOnly: true, gateEvidence: true, destructiveRisk: 'fixture-write', replacement: 'Use koala validate --story=<storyId> plus verification_evidence_add/checklist_update verificationEvidence in the current flow.', reason: 'Legacy story-scoped fixture runner writes old test evidence; current verification evidence is checklist-scoped.' },
  test_fixture: { status: 'legacy', rootOnly: true, destructiveRisk: 'fixture-write', replacement: 'Use a focused project-native command or koala validate --story=<storyId>, then record verification_evidence_add.', reason: 'Legacy single-fixture runner is maintenance-only and should not be opened broadly in phaseTools.' },
  task_coverage: { status: 'legacy', rootOnly: true, destructiveRisk: 'none', replacement: 'Use koala validate/process-fact contract checks and checklist verificationEvidence coverage.', reason: 'Legacy task annotation coverage is advisory and no longer drives the active verification flow.' },
  truth_scan: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only truth source scan.' },
  truth_nav: { status: 'maintenance', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Regenerates requirements navigation as controlled documentation maintenance.' },
  truth_analyze: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only truth-source ambiguity report.' },
  truth_to_story: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Reports candidate stories without creating them.' },
  truth_extract: { status: 'maintenance', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Extracts code metadata into requirements files as controlled maintenance.' },
  gap_analyze: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only truth/code gap report.' },
  convergence_check: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only convergence report.' },
  dashboard: { status: 'rootOnly', rootOnly: true, destructiveRisk: 'none', reason: 'Long-running dashboard is a project-root session tool, not an active story phase command.' },
  session_brief: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only recovery entrypoint deliberately allowed in every phase.' },
  next: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only next-action hint deliberately allowed in every phase.' },
  aux_doc_list: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only documentation index used for planning and recovery.' },
  doctor: { status: 'maintenance', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Health inspection and optional repair are explicit maintenance actions.' },
  verify_codex: { status: 'gateEvidence', gateEvidence: true, allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Writes Codex adapter verification evidence consumed by adapter gates.' },
  audit: { status: 'maintenance', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Framework self-audit can write audit findings/reports under controlled policy.' },
  validate: { status: 'gateEvidence', gateEvidence: true, allowedPhases: ['DEV', 'REVIEW', 'TEST'], destructiveRisk: 'metadata-write', reason: 'Current verification runner and gate evidence producer.' },
  status: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only project status report.' },
  serve: { status: 'supported', allowedPhases: ['DEV'], destructiveRisk: 'none', reason: 'Debug server support is limited to active development.' },
  evaluate: { status: 'supported', allowedPhases: ['TEST'], destructiveRisk: 'none', reason: 'Browser evaluator is a TEST-phase diagnostic.' },
  evaluate_save: { status: 'gateEvidence', gateEvidence: true, allowedPhases: ['TEST'], destructiveRisk: 'metadata-write', reason: 'Persists evaluator evidence consumed by DONE checks.' },
  finding_add: { status: 'gateEvidence', gateEvidence: true, allowedPhases: ['DEV', 'REVIEW'], destructiveRisk: 'metadata-write', reason: 'Writes reviewer finding evidence used by review gates.' },
  finding_list: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only reviewer finding inspection.' },
  finding_resolve: { status: 'gateEvidence', gateEvidence: true, allowedPhases: ['REVIEW'], destructiveRisk: 'metadata-write', reason: 'Changes blocker state consumed by REVIEW gates.' },
  finding_dismiss: { status: 'gateEvidence', gateEvidence: true, allowedPhases: ['REVIEW'], destructiveRisk: 'metadata-write', reason: 'Dismisses finding evidence with a reason consumed by review gates.' },
  finding_cluster: { status: 'maintenance', allowedPhases: ['DEV', 'REVIEW', 'TEST'], destructiveRisk: 'metadata-write', reason: 'Maintains finding clusters without satisfying gate evidence.' },
  init_check_set: { status: 'gateEvidence', gateEvidence: true, allowedPhases: ['INIT'], destructiveRisk: 'metadata-write', reason: 'Writes INIT check evidence consumed before INIT_CHECK.' },
  delivery_check_set: { status: 'gateEvidence', gateEvidence: true, allowedPhases: ['REVIEW', 'TEST'], destructiveRisk: 'metadata-write', reason: 'Writes delivery evidence consumed by DONE.' },
  delivery_waiver_add: { status: 'gateEvidence', gateEvidence: true, allowedPhases: ['REVIEW', 'TEST'], destructiveRisk: 'metadata-write', reason: 'Adds delivery waiver evidence consumed by DONE.' },
  scope_check_save: { status: 'gateEvidence', gateEvidence: true, allowedPhases: ['PLAN'], destructiveRisk: 'metadata-write', reason: 'Writes scope review evidence consumed by PLAN review.' },
  scope_question_resolve: { status: 'gateEvidence', gateEvidence: true, allowedPhases: ['PLAN'], destructiveRisk: 'metadata-write', reason: 'Resolves open scope questions consumed by PLAN review.' },
  story_dispatch: { status: 'supported', allowedPhases: ['DEV'], destructiveRisk: 'none', reason: 'Generates implementer handoff text during DEV.' },
  finding_dispatch: { status: 'legacy', allowedPhases: ['DEV', 'REVIEW'], destructiveRisk: 'none', replacement: 'Use koala dispatch with itemId, findingId, or clusterId.', reason: 'Deprecated alias retained for compatibility with older finding-repair prompts.' },
  dispatch: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Unified dispatch text generator available across phases.' },
  background_set: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Background context is coordination metadata, not direct gate evidence.' },
  background_append: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Background context append is coordination metadata.' },
  background_get: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only background inspection.' },
  plan_set: { status: 'supported', allowedPhases: ['PLAN'], destructiveRisk: 'metadata-write', reason: 'Implementation plan is set during PLAN.' },
  plan_get: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only implementation plan inspection.' },
  reviewer_list: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only active reviewer calculation.' },
  workflow_set: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Workflow profile configuration is explicit project metadata.' },
  workflow_show: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only workflow profile inspection.' },
  workflow_explain: { status: 'supported', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only effective workflow explanation.' },
} as const satisfies Record<string, CommandPolicy>;

export type KnownCommandName = keyof typeof COMMAND_POLICIES;

export function getCommandLifecyclePolicy(command: string): CommandPolicy | undefined {
  return COMMAND_POLICIES[command as KnownCommandName];
}

export const getCommandPolicy = getCommandLifecyclePolicy;

export function getCommandPolicyEntries(): Array<readonly [KnownCommandName, CommandPolicy]> {
  return Object.entries(COMMAND_POLICIES) as Array<readonly [KnownCommandName, CommandPolicy]>;
}

export function policyAllowedPhaseLabels(policy: CommandPolicy): string[] {
  if (policy.allowedPhases === 'all') return [...ALL_PHASES];
  if (policy.allowedPhases) return [...policy.allowedPhases];
  return [];
}

function formatPhases(policy: CommandPolicy): string {
  const phases = policyAllowedPhaseLabels(policy);
  if (phases.length > 0) return phases.join(', ');
  if (policy.rootOnly || policy.status === 'rootOnly') return 'root-only (outside an active story phase gate)';
  return 'none declared for active story phases';
}

export function formatCommandLifecycleHint(
  command: string,
  phase?: string,
  currentAllowedPatterns: readonly string[] = [],
): string[] {
  const policy = getCommandLifecyclePolicy(command);
  if (!policy) {
    return [
      `   Lifecycle: missing-policy`,
      ...(phase ? [`   Requested phase: ${phase}`] : []),
      `   Reason: command is registered but has no lifecycle policy entry`,
      `   Policy source: ${COMMAND_POLICY_SOURCE}`,
    ];
  }

  const lifecycleParts = [policy.status];
  if (policy.gateEvidence && policy.status !== 'gateEvidence') lifecycleParts.push('gateEvidence');
  const lines = [
    `   Lifecycle: ${lifecycleParts.join(' + ')}`,
    ...(phase ? [`   Requested phase: ${phase}`] : []),
    `   Allowed phases: ${formatPhases(policy)}`,
    `   Reason: ${policy.reason}`,
  ];

  if (policy.retiredReason) lines.push(`   Retired reason: ${policy.retiredReason}`);
  if (policy.replacement) lines.push(`   Replacement: ${policy.replacement}`);
  if (policy.destructiveRisk && policy.destructiveRisk !== 'none') {
    lines.push(`   Destructive risk: ${policy.destructiveRisk}`);
  }
  if (currentAllowedPatterns.length > 0) {
    lines.push(`   Current phaseTools allow: ${currentAllowedPatterns.join(', ')}`);
  }
  lines.push(`   Policy source: ${COMMAND_POLICY_SOURCE}`);
  return lines;
}

export function formatCommandPolicyHint(command: string, currentAllowedPatterns: readonly string[] = []): string[] {
  return formatCommandLifecycleHint(command, undefined, currentAllowedPatterns);
}
