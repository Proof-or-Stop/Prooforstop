# B-3e47 Plan

## Goal

Fix the DONE-phase milestone progress display so `lattice milestone_status --storyId=<DONE-story>` uses the frozen `milestone-closeout.json` snapshot when one exists, while active stories continue to use live milestone/checklist/evidence projection.

## CHK-001 - Use frozen closeout for DONE milestone_status

Implementation steps:

1. Add a conversion helper that maps a valid `MilestoneCloseoutSnapshot` back into a `MilestoneStatusReport` shape.
2. In the `milestone_status` handler, read the story first and, only when the story phase is `DONE`, prefer a schema-valid closeout snapshot if present.
3. Preserve the existing live path for non-DONE stories and for DONE stories with no closeout snapshot.
4. Preserve JSON output shape by returning a `MilestoneStatusReport`, not a closeout-specific object.

Verification:

1. Extend the existing milestone-status tests with a DONE story containing a closeout snapshot and stale live evidence; assert text output shows `Completed` rows without `🔴 Blocked` stale rows.
2. Assert JSON output has `groups.completed` populated and empty `current` / `remaining` arrays.
3. Assert active stories still use live projection and missing closeout snapshots do not fabricate success.

## CHK-002 - Document DONE snapshot status contract

Implementation steps:

1. Update `docs/CLI.md` to state that active stories use live milestone projection.
2. Document that DONE stories with `milestone-closeout.json` use the frozen snapshot for `milestone_status`.
3. Keep JSON/no-ledger behavior explicit and do not claim `milestone_completion_set` or completion ledger support.

Verification:

1. Add or update docs assertions in `packages/main/tests/milestone-status.test.mjs`.
2. Run `node packages/main/tests/milestone-status.test.mjs`.
3. Run `npm --prefix packages/main run build`.

## Rollback

If the closeout conversion produces ambiguous or lossy status reports, revert the handler change and keep `milestone_closeout` as the only historical DONE reader until a richer closeout snapshot schema is designed.
