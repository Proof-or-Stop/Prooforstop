# Plan: B-77e4 Koala outcome semantics and dashboard clarity

## CHK-001
**Owner**: koala-implementer

Add a small outcome classification helper that reads summary outcome metadata for DONE stories and defaults legacy DONE stories to success. Render dashboard/session text as lifecycle progress plus outcome breakdown, with concrete strings like `Lifecycle DONE 23/26 (88%); outcomes success=20 blocked=2 audit-only=1`. Keep the lifecycle percent visible but explicitly named lifecycle progress.

## CHK-002
**Owner**: koala-implementer

Extend StorySummaryData and summary_set schema with `outcomeKind: success | blocked | audit_only`. Render it in summary hints and DONE pre-check/user value summary. Existing summary_set calls without outcomeKind must keep working and default as success-compatible for display. Invalid enum values must fail schema validation before summary metadata is written.

## CHK-003
**Owner**: koala-implementer

Extend VerificationEvidence with optional `verdict: success | blocked_classified | audit_only | waived`. Do not let verdict bypass existing evidence gate logic: result=fail remains failed unless existing rules say otherwise; permanent waiver remains waiver. Add render output so coverage can show `verdict=blocked-classified` next to explicit evidence.

## CHK-004
**Owner**: koala-implementer

Rephrase session_brief mismatch wording from alarming `main metadata still says` to a normal authority/mirror-lag phrase, e.g. `authority: worktree phase REVIEW; main metadata mirror lag INIT_CHECK`. Keep exact cd guidance unchanged.

## CHK-005
**Owner**: koala-implementer

Create focused smoke coverage, likely `packages/main/src/tasks/outcome-semantics-smoke.ts`, and wire an npm script if useful. The user-visible output should be a concrete pass line such as `✓ outcome semantics smoke passed`. It must cover dashboard/session outcome breakdown, summary outcomeKind parsing/defaults, verdict evidence rendering/gate behavior, and phase authority wording. It must not expand aux_doc_list scope.

## Non-goals
- Do not add DONE_SUCCESS/DONE_BLOCKED phases.
- Do not change TEST/DONE gate strictness.
- Do not implement aux_doc_list wider indexing in this story.
