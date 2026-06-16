# B-72df real-machine transcript ↔ PLAN-outcome diff

The smoke drives the **real** `assertMainWorktreeReadyForMerge` against real git repos (6 cases).

## Expected (understanding.outcome)
> On a shared main worktree with an unrelated session's uncommitted tracked file, DONE proceeds (file untouched); it STILL refuses when a dirty tracked path overlaps the merge's change set.

## BEFORE (pre-fix)
`assertMainWorktreeReadyForMerge` threw on ANY dirty tracked file (`git status --porcelain --untracked-files=no` non-empty) — so an unrelated session's uncommitted file blocked an unrelated story's DONE (observed: B-e791 blocked by B-0414). The repro (case a) threw `...has uncommitted changes to tracked files\nM shared/unrelated.txt` pre-fix.

## AFTER (B-72df fixed)
```
$ node packages/main/dist/tasks/done-merge-scope-smoke.js
  ✓ unrelated dirty tracked path passes + file byte-identical after
  ✓ overlapping dirty path (edited file) still blocks DONE
  ✓ overlapping dirty path (rename source name) still blocks DONE
  ✓ overlapping dirty path (non-ASCII filename) still blocks DONE
  ✓ clean main worktree passes (B-e74e happy path unchanged)
  ✓ main worktree unavailable still throws (B-e74e preserved)
✓ done-merge-scope-smoke passed   (exit 0)
```

## Diff notes
- **Match.** The check now blocks only when a dirty tracked path OVERLAPS the merge's affected set (`git diff main...story --name-status -M -z`, both rename names); unrelated uncommitted work is allowed (and left byte-identical). Clobber-protection holds for edited, rename-source, AND non-ASCII paths (F-001: `core.quotePath=false` so porcelain paths match the `-z` diff). B-e74e (main-worktree-unavailable) preserved; clean path byte-identical. Diff-uncomputable → conservative block-all (fails closed).
- Scope: change isolated to `done-effects.ts` (+ the smoke).
- This is the defensive half of the concurrent-session frictions (DONE no longer blocked by another session's unrelated uncommitted work). The complementary lock-coverage fix is B-9177 (next).
- Known follow-up: smoke not in the default validate battery (B-99b6).
