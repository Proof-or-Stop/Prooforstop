## CHK-001
Implement a DONE main-merge critical-section lock using the existing withMkdirLock primitive. The lock path is `.koala/runtime/done-main-merge.lock`. Acquire it before the existing DONE divergence check (`checkMainDivergence` / `autoSyncMain`) and hold it across `runDonePreMergeGate`, actor.send, phase write, `applyDoneMergeEffects`, and branch/worktree cleanup. On non-stale contention, throw before any DONE mutation with retry text and no story state change. Add smoke coverage for held lock, stale lock reclaim, and normal uncontended DONE.

## CHK-002
Create a pure partial-DONE detector, likely in `core/partial-done-recovery.ts`, that reads story phase, expected branch/worktree, whether main contains the branch, merge-tree status, and cleanup residue. Integrate detector output into `doctor` text and JSON as `partialDone`, separate from existing terminal/orphan worktree cleanup. Doctor must show `koala done_recover --storyId=<id>` when recovery is safe or explain why it is unsafe.

## CHK-003
Add explicit `done_recover` command. It should verify story exists and phase is DONE, branch/worktree match the story, main is safe, merge-base/merge-tree pass, then merge story branch into main, remove worktree, prune registry, and delete branch. It must fail closed for dirty main, merge conflict, missing/mismatched branch, or unsafe worktree path. Register the command in CLI/registry/command policy as explicit maintenance mutation.

## CHK-004
Add operator-visible smoke coverage for the full story: lock contention output, doctor partial-DONE detection output, and done_recover output. Tests should verify user-facing text, not just internal state. Ensure recovery leaves no terminal/orphan worktree residue and does not touch unrelated active story worktrees. Update `docs/requirements/decisions/story-lifecycle.md` so operators are guided to doctor partial-DONE output and `koala done_recover`, not handwritten git recovery.
