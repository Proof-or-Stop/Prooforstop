# B-4fd3 Real-machine acceptance — transcript & diff

Verified on 2026-06-16 in worktree `.worktrees/B-4fd3` (branch `story/B-4fd3`), built from the fixed source.

## Expected (PLAN outcome)
> 在干净 main 的 worktree 运行 `npm run test:thin-init-assets-smoke`，终端输出
> `✓ global-thin init assets smoke passed` 且退出码 0，不再出现
> `AssertionError ... STALE_SAFE .gitignore: missing runtime ignore pattern(s): .lattice/usage/`；
> 运行 `git diff main -- .gitignore` 看到 managed 块内新增一行 `.lattice/usage/`。

## Actual

### 1. `npm run test:thin-init-assets-smoke`
```
> @lattice-agent/core@0.3.5 test:thin-init-assets-smoke
> node dist/tasks/thin-init-assets-smoke.js

✓ global-thin init assets smoke passed
```
Exit code 0. No `STALE_SAFE .gitignore` / `.lattice/usage/` AssertionError.

Before the fix (reproduction on clean main) the same command failed with:
```
AssertionError [ERR_ASSERTION]: Lattice managed asset check: DRIFT (profile=core, assetMode=global-thin)
  - STALE_SAFE .gitignore: missing runtime ignore pattern(s): .lattice/usage/
```

### 2. `git diff main -- .gitignore`
```
@@ -54,6 +54,7 @@
 # lattice runtime artifacts (managed)
 **/owner-lease.json
 .lattice/locks/
+.lattice/usage/
 .Lattice/authority.md
 .Lattice/artifacts/baseline/
 .lattice/artifacts/baseline/
```

### 3. Full battery — `lattice validate`
All green (static + logic + integration + e2e + main-write-lock-coverage). `npm test` fallback also PASS in the TEST gate.

### 4. Regression guard sanity (drift detection is not silent)
`runtimeIgnoreMissing` on a `.gitignore` with `.lattice/usage/` removed returns `[".lattice/usage/"]`
(the new `assertGitignoreCoversRegistry` would FAIL), while the repo `.gitignore` returns `[]`.

## Diff vs expected
No difference. Actual matches the PLAN outcome on every point.

## Out of scope (unchanged by this story)
- `thin-init-assets-smoke` is still not part of the `lattice validate` battery — aggregation is owned by B-99b6.
