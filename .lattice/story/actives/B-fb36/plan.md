# B-fb36 Plan

## CHK-001 Add done_prepare command surface and preflight

Create a new handler module for `done_prepare` and register it in the main CLI registry/help surfaces. The command accepts `storyId`, `mergeMain`, `refreshStale`, `validate`, `build`, and `dryRun`. Preflight verifies the active branch is `story/<storyId>`, the story is in TEST phase, local `main` exists, and `git status --porcelain` is clean before any mutation. The command must not accept or perform version bump arguments.

## CHK-002 Orchestrate merge-main, stale evidence classification, validate, and done_closure

Implement an ordered step runner that records pass/skipped/blocked for `mergeMain`, `staleEvidenceRefresh`, `validate`, and `doneClosure`. Prefer in-process existing handlers for `verification_evidence_refresh_stale`, `validate`, and `done_closure`; use git subprocess only for `git merge main` and status probes. Run stale evidence dry-run first and surface its transcript. If stale evidence exists and `refreshStale=false`, block. If refresh is enabled, run existing refresh, then validate. If any step fails, stop and render `DONE prepare: BLOCKED` with the step id and next command.

## CHK-003 Report runtime-change post-DONE finalization guidance without mutating versions

Add a path-based runtime-change detector over `git diff --name-only main...HEAD`. Runtime-affecting paths include `packages/main/src/core/**`, `packages/main/src/handlers/**`, `packages/main/src/tasks/**`, CLI entrypoints, and `bin/**`. Docs-only, story metadata-only, review evidence-only, and comment-only changes should not request post-DONE finalization. The detector only reports `postDoneRuntimeVersionBumpRequired` and `postDoneNext`; it never edits version files.

## CHK-004 Render host-neutral readiness output and clean-tree blockers

Render stable text and JSON-compatible internal state that distinguishes local readiness from Authority/prod status. Success requires final `git status --porcelain` clean and includes `authorityDone:false`, `fullAuthorityDone:false`, and `productionDone:false`. If refresh/validate writes metadata, stop at `cleanTree` with exact dirty files and commit guidance. Do not call `story_advance DONE` automatically.

## CHK-005 Add focused smoke coverage for done_prepare behavior

Add a focused smoke task, plus validate configuration entry if needed, that exercises the command behavior in temporary repos or controlled fixtures. Coverage must include clean ready path, dirty preflight, merge-main conflict blocking, `refreshStale=false` blocking, stale evidence refresh path or transcript preservation, validate fail before DONE guidance, runtime-change detection without version mutation, docs-only no-finalization guidance, degraded/local Authority wording, prepare-generated `cleanTree` commit-required behavior, and dryRun no mutation. Use assertions on user-visible output, not only internal state.

## Out of Scope

Do not implement `done_finalize` or any post-DONE version mutation in this story. Do not claim Authority DONE, full Authority DONE, production DONE, or two-host quorum. Do not push remote branches or touch senior credential files.
