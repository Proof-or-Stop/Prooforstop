## CHK-001

Implement a central CLI post-command renderer in `packages/main/src/cli-engine.ts`. After a configured story-scoped mutating command succeeds, derive the target storyId, skip machine JSON mode, check that `milestone-ledger.json` exists, then render the existing `milestone_status` text table and append it to human stdout. The command set starts with checklist/evidence/phase/delivery/summary/milestone-ledger mutations and must not fabricate output for missing-ledger stories.

Risk controls: keep the logic in the CLI output path rather than duplicating handler storage logic; catch status rendering failures so the original successful command is not turned into a failed write; skip `--json` and `--format=json`; use the existing milestone_status renderer so headings and table columns stay identical.

## CHK-002

Extend `packages/main/tests/milestone-status.test.mjs` with CLI-level regressions. Build-time tests should create temporary story metadata with a milestone ledger, execute the built CLI on a representative mutation such as `checklist_update`, and assert stdout contains `Milestone Status - B-post-progress`, `Completed`, `Current`, and `Remaining`.

Negative controls: run the same representative command with JSON mode where available and assert stdout remains parseable JSON or at minimum does not contain the human table; run a mutation on a story without `milestone-ledger.json` and assert no milestone table is appended. Documentation in `docs/CLI.md` should state that the CLI now appends the consumed table for configured mutating commands on milestone-ledger stories.
