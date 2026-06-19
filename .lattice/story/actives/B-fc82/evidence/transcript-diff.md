# B-fc82 Transcript Diff

## Expected

- `review_run_start` runs the dirty-tree preflight before `captureReviewRunSnapshot`.
- Blocking material-source dirtiness is reported as the dirty preflight error and no review run is persisted.
- Unreadable git-status remains fail-open and still reaches the existing snapshot diagnostic path.
- Broader field-regression and configured project validation remain green after merging current `main`.

## Actual

Run from `/Users/jek/Documents/Work/Orchestrate/.worktrees/B-fc82` on 2026-06-19.

```text
$ node packages/main/dist/tasks/review-run-clean-tree-preflight-smoke.js
  ✓ (i) ordering: dirty preflight beats missing-material snapshot diagnostics
  ✓ (a)+(e) material-source dirty: review_run_start REFUSES, names the file, no run recorded
  ✓ (b) fixture dirty: review_run_start REFUSES, no run recorded
  ✓ (c) clean tree: review_run_start PROCEEDS, records RR-001
  ✓ (d) metadata-only dirty: review_run_start PROCEEDS (non-blocking category)
  ✓ (f) isBlockingDirty parity with DONE evaluateDirtyGate; (g) DONE gate classify/block unchanged
  ✓ (h) fail-open: unreadable git status yields ok=false and skips the blocking path
✓ review-run-clean-tree-preflight-smoke passed

$ node packages/main/dist/tasks/field-regression-cli-smoke.js
✓ field regression CLI smoke passed

$ lattice validate --story=B-fc82
✓ Project validation commands passed
  ✓ configured validate.commands[0]: npm --prefix packages/main run build
  ✓ configured validate.commands[1]: node packages/main/dist/tasks/authority-client-smoke.js
  ✓ configured validate.commands[2]: node packages/main/dist/tasks/authority-completion-smoke.js
  ✓ configured validate.commands[3]: node packages/main/dist/tasks/review-pass-discard-smoke.js
  ✓ configured validate.commands[4]: node packages/main/dist/tasks/init-window-data-loss-smoke.js
  Verification intent coverage: 6/6 covered (0 required missing)
```

## Diff

No user-visible deviation from the expected outcome. The new ordering assertion proves the dirty preflight wins before the snapshot-derived `missing_material_hash` path, while the fail-open and clean-tree paths remain unchanged.
