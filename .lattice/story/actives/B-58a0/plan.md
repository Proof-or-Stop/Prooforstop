# Plan — Forced Milestone Ledger Display (B-58a0)

## Goal
Every command in `MILESTONE_STATUS_APPEND_COMMANDS` always emits a status block on
success, and render failures are visible on stdout instead of swallowed to stderr.

## CHK-001 — renderChecklistDerivedLedger renderer
File: `packages/main/src/core/milestone-status.ts`.
Add exported `renderChecklistDerivedLedger(storyId, checklist, phase)` and exported
`CHECKLIST_DERIVED_HEADER`. Group checklist items into ✅ done / ⏳ in_progress /
⬜ pending under the distinct header `Checklist-derived ledger (no milestone ledger set)
- <id>`, plus a `Phase:` line and a `Progress:` summary. Empty checklist renders a stub
`(no checklist items)`. Never reuse the `Milestone Status - <id>` header.
Verification: unit test covers three-status grouping + empty stub.

## CHK-002 — rework appendMilestoneStatusAfterMutation
File: `packages/main/src/cli-engine.ts`.
When no milestone ledger exists, render the checklist-derived ledger instead of
returning bare output. Keep the real milestone table when a ledger exists; keep the DONE
worktree-cleanup main-root fallback. Replace the silent `stderr + return` catches with a
visible stdout block `⚠ Milestone Ledger: render FAILED ...`. Exit code stays 0 (the
mutation already committed). `--json` still suppresses the text block.
Verification: no-ledger CLI mutation shows the derived ledger; real-ledger + --json
regressions stay green.

## CHK-003 — update and extend tests
File: `packages/main/tests/milestone-status.test.mjs`.
Invert the no-ledger assertion (~302-306) to require the checklist-derived ledger and
forbid the `Milestone Status` header; add a `renderChecklistDerivedLedger` unit test
including the empty-checklist stub; keep the real-ledger append and `--json` purity
regressions green.
Verification: `node packages/main/tests/milestone-status.test.mjs` passes; red at
baseline (`renderChecklistDerivedLedger is not a function`).

## Out of scope (YAGNI)
- No `story_advance` freshness/display gate (unsound: the CLI generates the report itself).
- No expansion of the command allowlist (`validate` / `story_create` stay out).
- No change to `--json` suppression. No non-zero exit on display failure.
