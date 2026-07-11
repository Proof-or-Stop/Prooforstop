# B-b264 Plan

## Goal

Implement DONE merge-preflight and done_prepare rerun-delta UX for the scoped M5/M6 items without changing DONE gates or evidence authority.

## CHK-001

Add pre-DONE merge hazard guidance inside done_prepare. Inspect the existing mergeMain, dirty-worktree, generated metadata, and clean-tree reporting paths. Add output that identifies untracked-overwrite hazards, branch divergence, generated metadata, and unrelated dirty files with exact paths and safe next steps. Keep behavior fail-closed and do not auto-resolve, stash, delete, or commit unrelated work.

Verification: focused smoke creates representative hazard fixtures and asserts exact path reporting plus no mutation of unrelated files.

## CHK-002

Explain repeated done_prepare runs and metadata deltas. Add a compact rerun reason summary when a previous attempt wrote done-required evidence, merged main, changed material/storyFiles binding, or refreshed evidence. The text must explain why rerun is required, or why validation can be skipped when freshness is proven, without implying reviewer or host evidence can be self-attested.

Verification: focused smoke asserts the rerun transcript includes generated metadata and binding-change reasons, and does not suggest committing unrelated dirty files or self-signing review/host evidence.

## CHK-003

Prove dryRun and generated-file ownership are safe. Add a new smoke script and package script. The smoke snapshots git status and story metadata before and after done_prepare --dryRun, verifies no evidence/process/review/timestamp files are written, and checks real-run guidance separates current-run generated files from pre-existing dirty lifecycle metadata.

Verification: npm --prefix packages/main run build, npm --prefix packages/main run test:done-prepare-merge-rerun-smoke, and process-fact contract verification if any signed-flow surface changes.

## Scope Boundary

In scope: packages/main/src/handlers/done-prepare.ts, the new focused smoke, and packages/main/package.json script wiring.

Out of scope: gate relaxation, auto-writing reviewer/host/fallback evidence, version bumping before DONE, remote push, and broad lifecycle refactors.

## Execution Order

1. Inspect done_prepare helpers and existing smoke fixture patterns.
2. Add helper-level output for merge hazards and generated metadata ownership.
3. Add rerun delta summary using existing material/storyFiles evidence state where available.
4. Add dryRun immutability and generated-file ownership smoke coverage.
5. Build, run focused smoke, run story validation, then complete REVIEW/TEST/DONE gates.
