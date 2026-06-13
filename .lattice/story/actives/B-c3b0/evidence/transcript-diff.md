# B-c3b0 Real-Machine Transcript Diff

Date: 2026-06-13
Worktree: `/Users/jek/Documents/Work/Orchestrate/.worktrees/B-c3b0`

## Expected

- `packages/main` runtime-affecting DONE merges refresh local `packages/main/dist` by running `npm --prefix packages/main run build`.
- Non-runtime/docs-only DONE merges do not waste time on a package build and print a visible skip line.
- Partial-DONE recovery through `done_recover` applies the same post-merge build rule after recovery cleanup.
- Build failure after a merge reports that `packages/main/dist` may be stale and prints the recovery command.

## Actual

- `npm --prefix packages/main run build`: PASS (`tsc` completed).
- `npm --prefix packages/main run test:worktree-authority-smoke`: PASS.
  - Covers watched input predicate, including `packages/main/package-lock.json`.
  - Covers DONE helper skip/success/failure messaging.
  - Covers `done_recover` runtime success, docs-only skip, and build-failure-after-cleanup behavior.
- `npm --prefix packages/main run test:flow-stability-smoke`: PASS.
- `KOALA_SESSION_ID=sess-350de45eaf0f0f51 lattice validate --story=B-c3b0 --json`: PASS.
  - Validation summary: project validation commands passed.
  - Verification intent coverage: 9/9 covered, 0 required missing.

## Diff

Expected and actual match for pre-DONE user-value acceptance. The final live acceptance signal will occur when this story advances to DONE: because this story changes `packages/main/src/**`, the new DONE hook should run `npm --prefix packages/main run build` after merging into local main, refreshing the global thin CLI dist path.
