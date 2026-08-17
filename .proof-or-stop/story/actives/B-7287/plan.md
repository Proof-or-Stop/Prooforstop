# B-7287 Execution Plan

## Scope

Implement only the M0-M2 MVP for progressive intent hardening. This plan deliberately keeps enforcement out of scope. The work adds command surfaces and dry-run diagnostics so future stories can observe would-block gaps before any warn/enforce rollout.

## CHK-001

Add original intent snapshot and milestone ledger commands. Implement the minimal Intent MVP artifact with sourceText, normalizedOutcome, and acceptanceClaim. Persist an immutable requestHash derived from sourceText and stable keyRequirementIds derived from the accepted requirements. Add milestone ledger set/add/get storage with validation for milestone arrays and references. Store artifacts through StoryStore helpers only.

Implementation notes:
- Create a dedicated ProofStory MVP core helper for validation and hardening classification.
- Add store methods for original-intent-snapshot.json and milestone-ledger.json.
- Add CLI handler methods for original_intent_snapshot_set/get and milestone_ledger_set/add/get.
- Keep milestone ledger optional unless structural or semantic triggers exist.
- Preserve source identity: changing sourceText changes requestHash; generated requirement ids stay stable for the saved snapshot.

Verification:
- Smoke command stores and reads an Intent MVP snapshot including requestHash and keyRequirementIds.
- Smoke command stores and appends milestone rows.
- Invalid MVP payload and malformed milestones fail before writing corrupt artifacts.

## CHK-002

Add minimal ProofStory diagnostic envelope storage. This is not full M4 gate integration. It only provides proofstory_contract_set/get as a small envelope consumed by dry-run diagnostics.

Implementation notes:
- Store proofstory.json with storyId, version, intentHardening, and optional references to the M0-M2 artifacts.
- Derive intentHardening classification inside the helper; do not add a standalone hardening command.
- Keep the command PLAN-oriented and non-enforcing.

Verification:
- Smoke command writes and reads proofstory.json.
- Contract output includes level, trigger reasons, and required artifact names.
- No story_advance or machine gate consumes proofstory_gate_check in this story.

## CHK-003

Add read-only and dry-run diagnostics for intent collision, intent coverage, and ProofStory gate readiness.

Implementation notes:
- intent_collision_get is read-only: it reads an existing collision artifact if one exists, or returns an empty diagnostic. It does not implement M3 collision authoring.
- intent_coverage_check --dryRun reads snapshot, milestone ledger, checklist, and contract, then reports coverage gaps.
- proofstory_gate_check --dryRun reports hardening classification, trigger reasons, missing MVP artifacts, missing intent collision when triggered, missing red evidence, missing spike evidence, scope ambiguity, and would-block issues.
- These commands must not enforce DEV admission, advance lifecycle, write red/spike/DONE artifacts, or create a full M4 gate.

Verification:
- Single-outcome request remains Intent MVP with no milestone ledger requirement.
- Explicit count/all-milestones request triggers milestone intent diagnostics.
- Isolated wording such as complete this small typo fix does not trigger milestone intent.
- Missing required MVP artifacts produce would-block diagnostics but do not advance or block lifecycle.
- Red/spike/scope ambiguity appear only as diagnostic gap types when triggered.

## CHK-004

Validate command registration, process-fact registration, and docs alignment.

Implementation notes:
- Register the handler factory in createMainRegistry.
- Add CLI schemas/catalog entries, command policy entries, and PLAN/read-only phase allowlists.
- Add process-fact levels and registry artifact entries for the MVP artifacts.
- Add a focused smoke task and keep orphan-surface/process-fact checks green.

Verification:
- npm --prefix packages/main run build passes.
- npm --prefix packages/utils run build passes if bootstrap needs utils.
- proofstory intent hardening smoke passes.
- process-fact and orphan-surface verification pass.

## CHK-005

Report the user-visible M0-M2 milestone completion table.

Implementation notes:
- The final response must show M0, M1, and M2 rows.
- A row receives a checkmark only after the corresponding implementation and verification evidence exists.
- The table must not imply M3-M9, red/spike, DONE enforce, or full M4 gate work is complete.

Verification:
- Final response includes the table.
- Incomplete rows are not marked complete.
