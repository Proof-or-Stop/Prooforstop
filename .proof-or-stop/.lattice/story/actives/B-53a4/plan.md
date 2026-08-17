# Plan: Auto-write milestone ledger from structured planning rows

## CHK-001
**Owner**: main-agent
**Scope**: Extend story_create to accept optional structured milestone rows using the existing ProofStory milestone row shape. Build the candidate ledger before persistence so malformed rows fail before any ledger file is written, then write milestone-ledger.json after the story shell exists. No milestones means no ledger file.
**Verify**: Create a story with explicit milestones and assert candidate ledger rows are present. Create another story without milestones and assert no ledger exists. Try malformed/duplicate rows and assert rejection.

## CHK-002
**Owner**: main-agent
**Scope**: Extend planner draft/story creation plumbing so an explicit draft.milestones array is passed through planner_create_story into story_create. Do not derive rows from request prose, background, planned steps, or checklist titles.
**Verify**: Exercise planner_create_story with and without draft milestones and assert only the structured case writes a candidate ledger.

## CHK-003
**Owner**: main-agent
**Scope**: Extend plan_skeleton arguments and write result so explicit milestones supplied with --write are persisted as a candidate ledger through the same builder. Read-only mode remains preview-only even when milestones are supplied. Empty/missing rows do not synthesize a ledger.
**Verify**: Exercise plan_skeleton preview with milestones and assert no write. Exercise plan_skeleton --write with milestones and assert candidate ledger. Exercise --write without milestones and assert no ledger inference.

## CHK-004
**Owner**: main-agent
**Scope**: Add focused regression coverage around the new planning write boundaries and existing read-only boundary. Preserve milestone_ledger_set/add and milestone_status behavior.
**Verify**: Run the targeted package build/test commands available in this worktree and record any environment limitation if dependencies are absent.
