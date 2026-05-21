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

/**
 * B-c55d CHK-002: story owner lease ownership classification.
 *
 * Every registered command is assigned EXACTLY ONE `ownershipClass`. This is the
 * single authoritative source the CLI choke-point gate
 * (`cli-engine.ts` `run()`) consults to decide whether a command must hold the
 * story owner lease. The classification is intentionally a per-command static
 * table — the gate never scatters ownership checks into individual handlers.
 *
 * The five classes (session-ownership-and-write-leases.md "Story Owner Lease
 * Rules"):
 *
 *  - `readOnly` — does NOT mutate story / main / B-META state. Never gated by
 *    the owner lease; a non-owner session can always run these (`story_get`,
 *    `checklist_get`, `finding_list`, `session_brief`, every `*_get` / `*_list`,
 *    `convergence_check`, `dispatch`, diagnostic `validate` without `--story`).
 *
 *  - `storyScopedMutating` — writes a SINGLE story's metadata / checklist /
 *    evidence / lifecycle. **Owner-lease-gated**: a non-owner session is
 *    rejected fail-closed (`checklist_*`, `understanding_set`, `decision_set`,
 *    `story_advance`, `grill_*`, `verification_evidence_*`, `summary_set`,
 *    `background_*`, `plan_set`, `bug_*`, `validate --story=...`, …).
 *
 *  - `reviewerWrite` — a reviewer-lane write of review evidence. EXEMPT from the
 *    owner lease (a reviewer is not the story's authoring owner) but STILL bound
 *    by its own phase / reviewer-run / `_hash` / signature / lane gates; the
 *    invoking session id / actor is still recorded.
 *
 *  - `mainSharedMutating` — writes shared main / B-META / audit state. NOT owner-
 *    lease-gated; its cross-session serialization is the B-f60c main write
 *    lock's job, not the story owner lease's.
 *
 *  - `dangerousMutating` — owner-lease-gated AND requires explicit operator
 *    intent (force takeover, discarding someone else's story, recovery merges
 *    into main, deleting a worktree / branch).
 *
 * BOUNDARY RULES (applied dynamically by the gate on top of this static class —
 * see `resolveEffectiveOwnershipClass` in `cli-engine.ts`):
 *  1. `finding_resolve` / `finding_dismiss` are `storyScopedMutating`, EXCEPT a
 *     B-META finding mutation, which is `mainSharedMutating` (main write lock).
 *  2. `validate` is `storyScopedMutating` only with `--story=...` (it writes
 *     story evidence); a diagnostic `validate` without `--story` is `readOnly`.
 *  3. `delivery_check_set` is `reviewerWrite` only when the resolved actor is
 *     `koala-review-delivery`; otherwise it is treated as `storyScopedMutating`.
 *
 * UNCLASSIFIED IS FAIL-CLOSED: a command without an `ownershipClass` is rejected
 * by the gate, never default-allowed. The `command-ownership-contract` task
 * enumerates the real registry and fails if any command is missing the field.
 */
export type OwnershipClass =
  | 'readOnly'
  | 'storyScopedMutating'
  | 'reviewerWrite'
  | 'mainSharedMutating'
  | 'dangerousMutating';

/**
 * The canonical set of `OwnershipClass` values. Used for runtime re-validation
 * (per "Handler 编码约定": an enum field is re-checked at every consumer, not
 * only at the Zod boundary) and by the contract test.
 */
export const OWNERSHIP_CLASSES: readonly OwnershipClass[] = [
  'readOnly',
  'storyScopedMutating',
  'reviewerWrite',
  'mainSharedMutating',
  'dangerousMutating',
] as const;

/** Runtime guard: whether `value` is a valid `OwnershipClass`. */
export function isOwnershipClass(value: unknown): value is OwnershipClass {
  return typeof value === 'string' && (OWNERSHIP_CLASSES as readonly string[]).includes(value);
}

export interface CommandPolicy {
  status: CommandLifecycleStatus;
  reason: string;
  /**
   * B-c55d CHK-002: story owner lease ownership class. Required on every
   * registered command — the gate fails closed on a missing value.
   */
  ownershipClass: OwnershipClass;
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
  story_create: { status: 'rootOnly', rootOnly: true, ownershipClass: 'mainSharedMutating', destructiveRisk: 'metadata-write', reason: 'Creates a new story envelope; run from the project root before entering a story worktree. Serialized by the B-f60c main write lock, not the per-story owner lease.' },
  story_advance: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'storyScopedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Lifecycle transition command guarded by story phase preflight checks.' },
  story_update: { status: 'supported', ownershipClass: 'storyScopedMutating', allowedPhases: ['INIT', 'PLAN'], destructiveRisk: 'metadata-write', reason: 'Story metadata may be edited only before development freezes scope.' },
  story_get: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only story inspection.' },
  story_list: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only story listing.' },
  story_reconcile: { status: 'maintenance', ownershipClass: 'mainSharedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Repairs zombie story/worktree residue through explicit maintenance flow; touches shared worktree state, not single-story authoring.' },
  story_discard: { status: 'maintenance', ownershipClass: 'dangerousMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Terminal story cleanup path with explicit discard semantics; discarding another session’s story requires explicit operator intent.' },
  story_draft: { status: 'supported', ownershipClass: 'storyScopedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Drafts are pre-story metadata and remain available across phases; no storyId resolves so the lease gate is a no-op.' },
  story_draft_list: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only draft listing.' },
  story_draft_discard: { status: 'maintenance', ownershipClass: 'dangerousMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Explicit draft cleanup command with discard semantics.' },
  draft_check_set: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'reviewerWrite', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Writes durable draft review evidence before formal story creation; a reviewer-lane write exempt from the owner lease but bound by its own signature gate.' },
  draft_issue_resolve: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'reviewerWrite', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Adds durable resolution evidence to a draft check; reviewer-lane write exempt from the owner lease but bound by its own signature gate.' },
  story_review: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'storyScopedMutating', allowedPhases: ['PLAN'], destructiveRisk: 'metadata-write', reason: 'PLAN review evidence is produced before DEV starts.' },
  story_review_dismiss: { status: 'supported', ownershipClass: 'storyScopedMutating', allowedPhases: ['PLAN'], destructiveRisk: 'metadata-write', reason: 'Risk dismissals belong to PLAN review before implementation starts.' },
  testintent_handoff: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: ['PLAN'], destructiveRisk: 'none', reason: 'Generates verification handoff context during planning; produces text, mutates nothing.' },
  checklist_get: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only checklist inspection.' },
  checklist_add: { status: 'supported', ownershipClass: 'storyScopedMutating', allowedPhases: ['PLAN', 'DEV'], destructiveRisk: 'metadata-write', reason: 'Checklist structure changes are limited to planning and active development.' },
  checklist_remove: { status: 'supported', ownershipClass: 'storyScopedMutating', allowedPhases: ['PLAN', 'DEV'], destructiveRisk: 'metadata-write', reason: 'Checklist removal requires explicit disposition before review/test phases.' },
  checklist_update: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'storyScopedMutating', allowedPhases: ['INIT', 'PLAN', 'DEV'], destructiveRisk: 'metadata-write', reason: 'Checklist status and verification evidence feed DEV/REVIEW gates.' },
  verification_evidence_add: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'storyScopedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Writes structured verification evidence consumed by checklist and freshness gates.' },
  verification_evidence_batch_add: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'storyScopedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Batch writes structured verification evidence consumed by gates.' },
  verification_evidence_refresh_stale: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'storyScopedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Refreshes hashes on evidence used by stale-evidence gates.' },
  verification_context_pack_create: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Generates a verifier context pack from git diff without writing story metadata.' },
  verification_context_pack_expand: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Creates a parent-linked verifier context pack expansion without writing story metadata.' },
  recover_evidence: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'storyScopedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Single-shot recover: refuses on non-metadata dirt, then runs verification_evidence_refresh_stale + koala validate (writes the same evidence hashes the underlying refresh handler writes).' },
  artifact_declare: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'storyScopedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Writes per-story declared-artifacts.json consumed by dirty-worktree classifier and DONE gate reference check.' },
  light_review: { status: 'supported', ownershipClass: 'storyScopedMutating', allowedPhases: ['DEV'], destructiveRisk: 'metadata-write', reason: 'Light review is a DEV coordination note, not REVIEW gate evidence.' },
  review_run_start: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'reviewerWrite', allowedPhases: ['REVIEW'], destructiveRisk: 'metadata-write', reason: 'Starts a signed current-round reviewer run required by REVIEW evidence; reviewer-lane write exempt from the owner lease but bound by its REVIEW-phase reviewer-run gate.' },
  review_pass_set: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'reviewerWrite', allowedPhases: ['REVIEW'], destructiveRisk: 'metadata-write', reason: 'Reviewer no-blocker receipt must be bound to a current REVIEW reviewer run; reviewer-lane write exempt from the owner lease but bound by its reviewer-run/signature gate.' },
  understanding_set: { status: 'supported', ownershipClass: 'storyScopedMutating', allowedPhases: ['PLAN'], destructiveRisk: 'metadata-write', reason: 'Planning context is captured before implementation.' },
  understanding_get: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: ['PLAN', 'REVIEW'], destructiveRisk: 'none', reason: 'Read-only planning-context inspection; reviewers need planning artifacts during REVIEW.' },
  decision_set: { status: 'supported', ownershipClass: 'storyScopedMutating', allowedPhases: ['PLAN'], destructiveRisk: 'metadata-write', reason: 'Structured decision record belongs to PLAN.' },
  decision_get: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: ['PLAN', 'REVIEW'], destructiveRisk: 'none', reason: 'Read-only decision inspection; reviewers need planning artifacts during REVIEW.' },
  grill_start: { status: 'supported', ownershipClass: 'storyScopedMutating', allowedPhases: ['PLAN'], destructiveRisk: 'metadata-write', reason: 'Starts a PLAN grill planning session; grill context clarifies intent but is not gate evidence.' },
  grill_record: { status: 'supported', ownershipClass: 'storyScopedMutating', allowedPhases: ['PLAN'], destructiveRisk: 'metadata-write', reason: 'Records typed grill planning questions and answers without writing verification or validation evidence.' },
  grill_close: { status: 'supported', ownershipClass: 'storyScopedMutating', allowedPhases: ['PLAN'], destructiveRisk: 'metadata-write', reason: 'Closes a grill planning session and reports remaining unknowns as advisory planning context.' },
  grill_get: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Reads grill planning context without mutating evidence or lifecycle state.' },
  summary_set: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'storyScopedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Writes DONE summary evidence consumed by completion gates.' },
  summary_get: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only summary inspection.' },
  bug_report: { status: 'supported', ownershipClass: 'storyScopedMutating', allowedPhases: ['REVIEW', 'TEST'], destructiveRisk: 'metadata-write', reason: 'Bug records are REVIEW/TEST feedback artifacts, not DEV implementation state.' },
  bug_update: { status: 'supported', ownershipClass: 'storyScopedMutating', allowedPhases: ['REVIEW', 'TEST'], destructiveRisk: 'metadata-write', reason: 'Bug status changes belong to REVIEW/TEST feedback loops.' },
  bug_list: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only bug inspection.' },
  bug_analyze: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: ['TEST'], destructiveRisk: 'none', reason: 'Bug quality analysis is a TEST-phase diagnostic.' },
  test_add: { status: 'legacy', rootOnly: true, gateEvidence: true, ownershipClass: 'storyScopedMutating', destructiveRisk: 'metadata-write', replacement: 'Use verification_evidence_add or checklist_update verificationEvidence after running koala validate/project-native tests.', reason: 'Legacy test-evidence writer retained for compatibility; current flow records verificationEvidence on checklist items.' },
  test_list: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only latest test evidence snapshot.' },
  fixture_get: { status: 'rootOnly', rootOnly: true, ownershipClass: 'readOnly', destructiveRisk: 'none', replacement: 'Prefer verification_evidence_add/checklist_update evidence over direct fixture inspection in active stories.', reason: 'Fixture JSON is legacy test infrastructure and is kept out of active story phase tools by default.' },
  fixture_update: { status: 'legacy', rootOnly: true, ownershipClass: 'dangerousMutating', destructiveRisk: 'fixture-write', replacement: 'Prefer project-native tests plus verification_evidence_add; if maintaining fixtures, use fixture_batch_add --dryRun first.', reason: 'Legacy fixture replacement command can overwrite case arrays in the shared workspace; destructive maintenance requiring explicit intent.' },
  fixture_batch_add: { status: 'legacy', rootOnly: true, ownershipClass: 'dangerousMutating', destructiveRisk: 'fixture-write', replacement: 'Prefer koala validate/project-native tests plus verification_evidence_add; for fixture maintenance, use --dryRun and validateExecute before writing.', reason: 'Legacy fixture authoring writes shared workspace fixtures; destructive maintenance requiring explicit intent.' },
  test_auto: { status: 'legacy', rootOnly: true, ownershipClass: 'dangerousMutating', destructiveRisk: 'workspace-destructive', replacement: 'Use koala validate --story=<storyId> and record verificationEvidence; test_auto full regression requires dryRun/confirm and is blocked for koala self-project full runs.', reason: 'Legacy full fixture runner performs git restore/git clean cleanup — workspace-destructive maintenance requiring explicit intent.' },
  test_story: { status: 'legacy', rootOnly: true, gateEvidence: true, ownershipClass: 'storyScopedMutating', destructiveRisk: 'fixture-write', replacement: 'Use koala validate --story=<storyId> plus verification_evidence_add/checklist_update verificationEvidence in the current flow.', reason: 'Legacy story-scoped fixture runner writes old test evidence; current verification evidence is checklist-scoped.' },
  test_fixture: { status: 'legacy', rootOnly: true, ownershipClass: 'dangerousMutating', destructiveRisk: 'fixture-write', replacement: 'Use a focused project-native command or koala validate --story=<storyId>, then record verification_evidence_add.', reason: 'Legacy single-fixture runner writes shared workspace fixtures; destructive maintenance requiring explicit intent.' },
  task_coverage: { status: 'legacy', rootOnly: true, ownershipClass: 'readOnly', destructiveRisk: 'none', replacement: 'Use koala validate/process-fact contract checks and checklist verificationEvidence coverage.', reason: 'Legacy task annotation coverage is advisory and no longer drives the active verification flow.' },
  truth_scan: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only truth source scan.' },
  truth_nav: { status: 'maintenance', ownershipClass: 'mainSharedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Regenerates shared requirements navigation as controlled documentation maintenance.' },
  truth_analyze: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only truth-source ambiguity report.' },
  truth_to_story: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Reports candidate stories without creating them.' },
  truth_extract: { status: 'maintenance', ownershipClass: 'mainSharedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Extracts code metadata into shared requirements files as controlled maintenance.' },
  gap_analyze: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only truth/code gap report.' },
  convergence_check: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only convergence report.' },
  dashboard: { status: 'rootOnly', rootOnly: true, ownershipClass: 'readOnly', destructiveRisk: 'none', reason: 'Long-running dashboard is a project-root session tool, not an active story phase command; renders state without mutating it.' },
  session_brief: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only recovery entrypoint deliberately allowed in every phase.' },
  next: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only next-action hint deliberately allowed in every phase.' },
  aux_doc_list: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only documentation index used for planning and recovery.' },
  doctor: { status: 'maintenance', ownershipClass: 'mainSharedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Health inspection and optional repair are explicit maintenance actions over shared project / worktree state.' },
  done_recover: { status: 'maintenance', ownershipClass: 'dangerousMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Explicitly recovers a partial-DONE story by validating main safety, merging the story branch into main, and cleaning the worktree/branch residue — a recovery merge requiring explicit operator intent.' },
  check: { status: 'maintenance', ownershipClass: 'mainSharedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Checks Koala managed asset drift and only mutates shared templates when --apply/--upgrade is explicitly provided.' },
  verify_codex: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'storyScopedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Writes Codex adapter verification evidence consumed by adapter gates.' },
  audit: { status: 'maintenance', ownershipClass: 'mainSharedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Framework self-audit writes shared B-META audit findings/reports; serialized by the B-f60c main write lock.' },
  gap_log: { status: 'supported', ownershipClass: 'mainSharedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Manually archives a framework gap into the shared B-META-framework-audit container; serialized by the B-f60c main write lock, not a per-story owner lease.' },
  validate: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'storyScopedMutating', allowedPhases: ['DEV', 'REVIEW', 'TEST'], destructiveRisk: 'metadata-write', reason: 'Verification runner; with --story=<id> it writes story TEST/DONE gate evidence (owner-gated). A diagnostic validate without --story mutates no story state and the gate downgrades it to readOnly.' },
  status: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only project status report.' },
  serve: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: ['DEV'], destructiveRisk: 'none', reason: 'Debug server support is limited to active development; serves state without mutating story metadata.' },
  evaluate: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: ['TEST'], destructiveRisk: 'none', reason: 'Browser evaluator is a TEST-phase diagnostic; produces a score, mutates no story state.' },
  evaluate_save: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'storyScopedMutating', allowedPhases: ['TEST'], destructiveRisk: 'metadata-write', reason: 'Persists evaluator evidence consumed by DONE checks.' },
  finding_add: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'reviewerWrite', allowedPhases: ['DEV', 'REVIEW'], destructiveRisk: 'metadata-write', reason: 'Writes reviewer finding evidence used by review gates; a reviewer-lane write exempt from the owner lease but bound by its REVIEW-phase reviewer-run/signature gate.' },
  finding_list: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only reviewer finding inspection.' },
  finding_resolve: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'storyScopedMutating', allowedPhases: ['REVIEW'], destructiveRisk: 'metadata-write', reason: 'Changes blocker state consumed by REVIEW gates — owner-gated for a normal story. A B-META finding mutation is reclassified mainSharedMutating by the gate (boundary rule 1).' },
  finding_dismiss: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'storyScopedMutating', allowedPhases: ['REVIEW'], destructiveRisk: 'metadata-write', reason: 'Dismisses finding evidence with a reason consumed by review gates — owner-gated for a normal story. A B-META finding mutation is reclassified mainSharedMutating by the gate (boundary rule 1).' },
  finding_cluster: { status: 'maintenance', ownershipClass: 'storyScopedMutating', allowedPhases: ['DEV', 'REVIEW', 'TEST'], destructiveRisk: 'metadata-write', reason: 'Maintains a single story’s finding clusters; story-scoped metadata mutation.' },
  init_check_set: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'reviewerWrite', allowedPhases: ['INIT'], destructiveRisk: 'metadata-write', reason: 'Writes INIT check evidence consumed before INIT_CHECK; a reviewer-lane write exempt from the owner lease but bound by its INIT signature gate.' },
  init_check_repair: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'storyScopedMutating', allowedPhases: ['INIT'], destructiveRisk: 'metadata-write', reason: 'B-95d8: explicit, auditable INIT_CHECK fallback for environments that cannot spawn the init reviewer subagent. Owner-gated (NOT a reviewer-lane write) — a deliberate human attestation in lieu of the independent reviewer, recorded with a fallback audit block and bound by the same INIT signature gate.' },
  delivery_check_set: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'reviewerWrite', allowedPhases: ['REVIEW', 'TEST'], destructiveRisk: 'metadata-write', reason: 'Writes delivery evidence consumed by DONE — reviewerWrite only when the resolved actor is koala-review-delivery; the gate reclassifies a non-delivery-reviewer caller to storyScopedMutating (boundary rule 3).' },
  delivery_waiver_add: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'storyScopedMutating', allowedPhases: ['REVIEW', 'TEST'], destructiveRisk: 'metadata-write', reason: 'Adds a delivery waiver to a story’s delivery-check.json; an owner-side authoring action, not a reviewer-lane write.' },
  scope_check_save: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'reviewerWrite', allowedPhases: ['PLAN'], destructiveRisk: 'metadata-write', reason: 'Writes scope review evidence consumed by PLAN review; a reviewer-lane write exempt from the owner lease but bound by its PLAN signature gate.' },
  scope_question_resolve: { status: 'gateEvidence', gateEvidence: true, ownershipClass: 'reviewerWrite', allowedPhases: ['PLAN'], destructiveRisk: 'metadata-write', reason: 'Resolves open scope questions consumed by PLAN review; a reviewer-lane write exempt from the owner lease but bound by its PLAN gate.' },
  story_dispatch: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: ['DEV'], destructiveRisk: 'none', reason: 'Generates implementer handoff text during DEV; produces text, mutates no story state.' },
  finding_dispatch: { status: 'legacy', ownershipClass: 'readOnly', allowedPhases: ['DEV', 'REVIEW'], destructiveRisk: 'none', replacement: 'Use koala dispatch with itemId, findingId, or clusterId.', reason: 'Deprecated alias retained for compatibility with older finding-repair prompts; generates text, mutates nothing.' },
  dispatch: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Unified dispatch text generator available across phases; produces text, mutates no story state.' },
  background_set: { status: 'supported', ownershipClass: 'storyScopedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Background context is coordination metadata, not direct gate evidence.' },
  background_append: { status: 'supported', ownershipClass: 'storyScopedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Background context append is story-scoped coordination metadata.' },
  background_get: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only background inspection.' },
  plan_set: { status: 'supported', ownershipClass: 'storyScopedMutating', allowedPhases: ['PLAN'], destructiveRisk: 'metadata-write', reason: 'Implementation plan is set during PLAN.' },
  plan_get: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only implementation plan inspection.' },
  reviewer_list: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only active reviewer calculation.' },
  workflow_set: { status: 'supported', ownershipClass: 'mainSharedMutating', allowedPhases: 'all', destructiveRisk: 'metadata-write', reason: 'Workflow profile configuration is shared project metadata, not single-story authoring state.' },
  workflow_show: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only workflow profile inspection.' },
  workflow_explain: { status: 'supported', ownershipClass: 'readOnly', allowedPhases: 'all', destructiveRisk: 'none', reason: 'Read-only effective workflow explanation.' },
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
