# B-4622 Plan

## Outcome

Close the parked scope evidence hygiene backlog without weakening the PLAN scope reviewer gate. The final state should say: `scope_check_save` remains PLAN-only, and later DEV/REVIEW scope changes use `scope_contract_acknowledge` as explicit acknowledgement evidence.

## CHK-001

Update `docs/requirements/decisions/story-lifecycle.md` with a concise scope evidence hygiene section. The section must clarify that `scope_check_save` is signed PLAN review evidence consumed by `story_review`, while later-phase scope changes are acknowledgements, not replacement scope reviewer passes.

Verification: grep the doc for `scope_check_save`, `scope_contract_acknowledge`, and language that acknowledgement is not a replacement for PLAN scope reviewer pass.

## CHK-002

Add focused regression assertions in `packages/main/src/tasks/command-ownership-contract.ts`: `scope_check_save` must remain exactly PLAN-only; `scope_contract_acknowledge` must remain DEV/REVIEW-only; and widening `scope_check_save` to DEV/REVIEW would fail the test.

Verification: run the command ownership contract task directly after building packages/main, and include the relevant command output as checklist evidence.

## Out of Scope

No authority-client changes, no worktree cleanup changes, no new later-phase reviewer artifact command. B-da5b remains a separate story.
