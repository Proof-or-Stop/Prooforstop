# B-6375 User Acceptance Transcript

## Expected

After syncing Koala managed runtime ignore patterns:

- `koala check` no longer reports `STALE_SAFE .gitignore: missing runtime ignore pattern(s): **/owner-lease.json, .koala/locks/`.
- The `.gitignore` product diff is limited to the managed runtime ignore block for `**/owner-lease.json` and `.koala/locks/`.
- `koala convergence_check` has no remaining non-story blockers; final main verification after DONE should report `converged: true`.

## Actual

Command: `koala check`

```text
Koala managed asset check: OK (profile=all)
Summary: OK=45, MISSING=0, CASE_MISMATCH=0, STALE_SAFE=0, STALE_LOCAL_EDIT=0, INCOMPATIBLE=0
Manifest: .koala/managed-assets.json
```

Command: `git diff HEAD^ HEAD -- .gitignore` for implementation commit `1c3c353e`

```diff
+# koala runtime artifacts (managed)
+**/owner-lease.json
+.koala/locks/
+# /koala runtime artifacts (managed)
```

Command: `koala validate --story=B-6375 --json`

```text
status: pass
allPass: true
package.json test script: npm test
Verification intent coverage: 3/3 covered (0 required missing)
```

Command: `koala convergence_check`

```text
converged: false
all checks passed except: 所有 Story 完成 -> 1 个 Story 未完成: B-6375
```

## Diff

The user-visible `koala check` result matches the expected clean managed asset state. The only remaining convergence difference is expected while B-6375 is active in TEST; it must be rechecked on main after DONE/merge and should become `converged: true`.
