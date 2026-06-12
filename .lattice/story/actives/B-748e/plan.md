# B-748e Plan

## CHK-001

Bind the unresolved signed-workspace reason from `review-run-start-signed-workspace-resolution-execution-plan.md:262` to existing source behavior. Inspect `resolveStorySignedWorkspace` and add a minimal source-level coverage annotation only if needed. Verification: `lattice gap_analyze` no longer reports line 262 and targeted signed-workspace smoke still passes.

## CHK-002

Bind the no-binding REVIEW diagnostic from `review-run-start-signed-workspace-resolution-execution-plan.md:311` to existing fail-closed `review_run_start` behavior. The failure path must continue to avoid creating reviewer runs. Verification: existing field regression smoke covers unresolved wrapper root and `lattice gap_analyze` no longer reports line 311.

## CHK-003

Run build/regression/gap verification. Success is narrow: signed-workspace line 262 and 311 gaps disappear; no new high/medium gaps appear; customerKeyRef remains the only high gap because Layer4 is out of scope. Commands: `npm --prefix packages/main run build`, targeted field regression smoke, `lattice gap_analyze`, and `lattice validate --story=B-748e`.

## Explicit Non-Goals

Do not implement gitRoot repair UX, config repair commands, Authority server integration, productionDone/fullAuthorityDone/receiptVerified behavior, or customerKeyRef handling in this story.
