# B-c3b0 Execution Plan

## Execution Boundary

Do:
- Add a post-DONE merge rebuild hook for the local packages/main CLI dist when the merged story changes CLI runtime inputs.
- Keep the rebuild local to the main repo after story branch merge succeeds.
- Add deterministic smoke coverage for changed-path trigger, skip behavior, successful build reporting, and failed build recovery text.
- Update the lifecycle truth source only if the implementation changes operator-visible DONE behavior.

Do not:
- Do not change remote push, release approval, npm publish, or global package installation policy.
- Do not refactor unrelated DONE gates, Authority gates, worktree cleanup, or story lifecycle phases.
- Do not make docs-only stories run package builds.
- Do not touch .omx, docs/story files directly, or fixture files directly.

STOP conditions:
- Stop before DEV implementation if PLAN review still has blockers.
- Stop and report if the existing DONE merge code cannot expose before/after main SHAs without broad lifecycle refactor.
- Stop if a smoke requires real npm publish, remote operations, or global install state.
- Stop if build failure handling would mark DONE as successful while dist may be stale.

Allowed files:
- packages/main/src/handlers/done-effects.ts
- packages/main/src/tasks/flow-stability-smoke.ts
- packages/main/src/tasks/worktree-authority-smoke.ts
- packages/main/package.json
- package.json
- docs/requirements/decisions/story-lifecycle.md

## CHK-001 Run package build after DONE merge when CLI runtime inputs changed

Implementation approach:
- In the DONE merge path, capture the main branch SHA immediately before merging the story branch.
- After the merge succeeds, capture the new main SHA and compute changed files with git diff --name-only <before> <after>.
- Add a narrow predicate for runtime-affecting paths: packages/main/src/**, packages/main/package.json, packages/main/tsconfig.json, root package.json, and package-lock.json.
- If the predicate matches, run npm --prefix packages/main run build from the main repo root.
- Append a visible success line to DONE output when the build ran and passed.

Verification:
- Logic/smoke coverage proves watched paths trigger a rebuild and docs-only paths do not.
- A successful stubbed build emits the expected DONE report line.

## CHK-002 Fail visibly when post-merge CLI rebuild fails

Implementation approach:
- Wrap the post-merge build call and capture stdout/stderr/error text.
- If build fails, throw an error that says the story branch has merged but packages/main dist may be stale.
- Include the exact recovery command: npm --prefix packages/main run build.
- Keep the failure explicit rather than silently continuing to a clean DONE success message.

Verification:
- Smoke coverage stubs a non-zero build result and asserts the failure message includes the command, stale-dist warning, and recovery step.
- Confirm skipped builds do not emit stale-dist failure guidance.

## CHK-003 Cover rebuild trigger and skip cases with smoke tests

Implementation approach:
- Export or otherwise isolate small helper functions for changed-path classification and post-DONE build execution so tests avoid a full real package-manager lifecycle.
- Add focused smoke cases to an existing lifecycle/worktree smoke file if that is the local pattern; otherwise add a new small task script and package script.
- Keep tests deterministic: use stubbed command runners for success/failure branches and pure arrays for path classification.

Verification:
- Build the package first so smoke runs against dist.
- Run the focused smoke, plus existing DONE/worktree or flow-stability smoke that covers the surrounding lifecycle behavior.
- Run lattice validate for the story before DONE.
