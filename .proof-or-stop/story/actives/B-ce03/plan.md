## CHK-001 Port done_prepare metadata-only dirty handling

Implement the B-9dfb dirty-worktree classification semantics in `packages/main/src/handlers/done-prepare.ts`. The implementation must classify initial dirty rows, allow only pre-existing unchanged Lattice story lifecycle metadata for the same story, and continue to block source/material dirt, unsafe metadata/source renames, owner-lease escape paths, and failed DONE-required evidence. The final cleanTree check must compare against the initial allowed metadata signatures so newly produced dirty files still require commit before DONE.

Verification: `done-prepare-smoke` must show metadata-only dirty evidence does not block at cleanTree, while dirty source and rename scenarios still block.

## CHK-002 Port lifecycle_check advisory done_prepare readiness semantics

Update `packages/main/src/core/lifecycle-readiness.ts` so the missing `done_prepare` structured report row is blocking only when DONE oracle rows already have blockers. If the DONE oracle rows are clean, the row remains visible as advisory guidance with the next `done_prepare` command, and `claims.localReady` can be true.

Verification: `lifecycle-check-smoke` must include a DONE-ready fixture where the only missing done_prepare report row is advisory and localReady remains true.

## CHK-003 Port regression smokes and benchmark assertions

Port the focused regression coverage from B-9dfb into current main without importing old story metadata. Coverage must include metadata-only dirty PASS behavior, dirty source blocker behavior, metadata/source rename blockers, failed DONE-required evidence preserving doneClosure blocking, lifecycle_check advisory semantics, and the benchmark assertion that metadata-only done_prepare dirt must not regress to blockedAt cleanTree.

Verification: build and run the target smoke/benchmark tasks after the semantic merge.

## CHK-004 Update done_prepare readiness decision documentation

Update `docs/requirements/decisions/done-prepare-automation-execution-plan.md` to describe the allowed metadata-only dirty case precisely: unchanged pre-existing Lattice lifecycle metadata may survive preflight/final cleanTree, but source/material dirt, unsafe renames, new dirty files produced by done_prepare, failed DONE-required evidence, and story-owned drift remain blockers.

Verification: inspect the documentation diff and bind it with docs_check evidence.

## Execution Notes

Do not merge `orchestrate/main`, do not resurrect `.worktrees/B-9dfb`, and do not import `.lattice/story/actives/B-9dfb`. Use the old B-9dfb merge commit only as a semantic patch source for the six scoped target files.
