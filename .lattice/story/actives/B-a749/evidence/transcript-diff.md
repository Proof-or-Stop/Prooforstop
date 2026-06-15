# B-a749 Real-machine verification — transcript & diff

Story: Scope `validate --lint` to changed packages so backend-only changes do not fail on unrelated missing deps.

## Expected (PLAN outcome)

> `lattice validate --lint --story=B-a749` for a backend-only change prints `[lint] pass: tsc` and reports
> the out-of-scope frontend tsconfig as skipped (out of change scope / deps absent) instead of
> `[lint] fail: tsc ... Cannot find module`; plain `lattice validate --lint` with no change-scope still
> type-checks every tsconfig recursively.

## Actual (run 2026-06-15 in worktree .worktrees/B-a749 against built dist)

### 1. Smoke test (CommandRunner DI, no real tsc)

```
$ node packages/main/dist/tasks/validate-lint-change-scope-smoke.js
✓ validate-lint change-scope smoke passed
exit=0
```

### 2. Live behavior — backend-only change, frontend deps ABSENT (the reported bug scenario)

Fake monorepo: `backend/` (node_modules present) + `frontend/` (node_modules ABSENT, would TS2307 if tsc ran).
`checkLint({ projectRoot, run, changedFiles: ["backend/src/api.ts"] })`:

```
BACKEND-ONLY CHANGE (frontend deps absent):
  overall status: pass
  tsc invoked on tsconfigs containing: ["<tmp>/backend/tsconfig.json"]
  detail: [lint] pass: tsc (tsc: checked 1 of 2 tsconfigs (1 skipped out of scope))
  detail: [lint] skipped: frontend/tsconfig.json (out of scope, deps absent)
```

=> Frontend is **skipped (out of scope, deps absent)**, backend is type-checked, overall **pass**.
Before this change, the recursive tsc would have run `frontend/tsconfig.json`, hit TS2307
"Cannot find module", and hard-failed the REVIEW->TEST lint gate.

### 3. Backward compatibility — no change-scope (plain `--lint`)

```
(1) NO-SCOPE (plain --lint): status=pass, tsc ran on packages=["backend","frontend"] => tsc: checked 2 tsconfigs
```

=> With no `changedFiles`, BOTH tsconfigs are type-checked and the legacy output string
`tsc: checked 2 tsconfigs` is preserved exactly. B-5a28 recursive coverage is intact.

### 4. Gate still bites — in-scope change with a REAL tsc error

```
(2) IN-SCOPE frontend real error: status=fail (expect fail = gate bites)
```

=> An in-scope package with a genuine tsc error still fails the gate. Scoping only skips
OUT-OF-SCOPE packages that lack deps; it never masks real errors in the changed package.

## Diff vs expected

No diff. Actual matches the PLAN outcome on all four axes:
- backend-only + frontend-deps-absent => pass with frontend skipped (out of scope, deps absent) ✓
- plain --lint (no scope) => full recursive tsc, legacy output preserved ✓
- in-scope real error => fail (gate bites) ✓
- never spawns real tsc in tests (DI seam) ✓

## Build / gate state

- `npm run build` (recursive tsc, all 4 subpackage tsconfigs): exit 0
- `lattice validate --story=B-a749`: PASS, verification coverage 10/10 (0 required missing)
- REVIEW CLI preflight gates (channel/concept/lint/docs-drift): all pass
- REVIEW reviewers (concept, quality, test-coverage): all review-pass, 0 findings
