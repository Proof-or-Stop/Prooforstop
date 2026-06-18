# Plan: B-72df DONE merge tolerant of unrelated uncommitted changes in shared main

> **Scope.** Narrow `assertMainWorktreeReadyForMerge` (done-effects.ts) so it blocks the DONE merge
> only when a dirty tracked path OVERLAPS the merge's affected path set (`git diff main...HEAD --name-only`,
> incl. rename names), instead of on ANY dirty tracked file. Decision **Option A**. Preserve B-e74e's
> main-worktree-unavailable handling; never clobber overlapping uncommitted work; clean-tree byte-identical.

## CHK-001: reproduction test

**Owner**: lattice-implementer  **DependsOn**: none
**Files**: Create a function test (packages/main/src/tasks/ style; wire into package.json) that puts one dirty tracked file in a main worktree UNRELATED to the story's merge change set, invokes the precondition, and asserts it is blocked today and (after CHK-002) proceeds with the file untouched.
**Verify**: fails before the fix, passes after; `lattice validate` green.
**DoneWhen**: failing repro reliably reproduces the over-broad block.

## CHK-002: scope the precondition to the merge's affected paths

**Owner**: lattice-implementer  **DependsOn**: CHK-001
**Files**: Modify `assertMainWorktreeReadyForMerge` in packages/main/src/handlers/done-effects.ts. Compute the merge's affected path set (`git diff main...HEAD --name-only`, including both names of renames). Block only when a dirty tracked path intersects that set; allow DONE otherwise. Keep B-e74e's worktree-unavailable check intact; keep `--untracked-files=no`.
**Verify**: unrelated-dirty → proceeds; overlapping-dirty → still blocked; main-unavailable → still fails.
**DoneWhen**: only overlapping dirty paths block; unrelated uncommitted work allowed; no clobber; availability preserved.

## CHK-003: tests (three cases + availability)

**Owner**: lattice-implementer  **DependsOn**: CHK-002
**Files**: Tests covering: (a) unrelated dirty path → DONE precondition passes + the file is byte-identical after; (b) a dirty path inside the merge change set → still blocked (protection); (c) clean → unchanged; (d) main-worktree-unavailable → still fails (B-e74e preserved). Function level.
**Verify**: `lattice validate` green.
**DoneWhen**: all four cases asserted.
