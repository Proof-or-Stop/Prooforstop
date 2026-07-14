# B-fa65 real-machine transcript + diff notes

Recorded at TEST phase, commit b9f2786fb5 lineage, 2026-07-14, from inside .worktrees/B-fa65 (worktree-built dist).

## Expected (userSees)

1. npm test completes green from inside a story worktree (test:brief-output passes, doctor brief under 20000 bytes).
2. doctor evaluated by a worktree-built CLI on a fixture project shows ✓ global-core-realpath, no "Relink or reinstall" advice.
3. A genuinely mismatched global path still warns.

## Actual

### 1. Full DONE-required chain green from the worktree

```
$ npm test          (from .worktrees/B-fa65)
... (34 suites incl. test:global-core-realpath and test:brief-output) ...
exit 0
```

`npm run test:brief-output` → "brief output smoke passed" (re-run twice by the round-2 test-coverage reviewer minutes apart — deterministic after the F-004 burn-scan env switch; all six doctor invocations in the smoke carry LATTICE_BURN_ALERT_RECENT_HOURS=0).

### 2. Worktree-built CLI fixture doctor passes the check

`node packages/main/tests/global-core-realpath.test.mjs` → `ok global-core-realpath`:
scenario 1 builds a real git repo + linked worktree, global @lattice/core symlinked to the canonical main checkout, corePackageRoot in the worktree → `globalCoreRealpath.status === 'pass'`. Round-1 test-coverage reviewer also confirmed via a scratch debug capture that the fixture doctor brief renders ✓ with no Relink text.

### 3. Genuine drift still warns

Scenario 2 (global symlinked to an unrelated path) → status not pass + "resolves to" warning survives. Scenario 3 non-git fallback: matching global passes, differing global warns (pre-fix behavior preserved).

### 4. Self-context regression guard

`node packages/main/dist/tasks/validation-protocol-smoke.js` → "✓ validation protocol smoke passed" (self-project shapes unchanged).

## Diff notes (expected vs actual)

No divergence on the three userSees surfaces. Review round 1 registered four findings (duplicated parser, inaccurate fallback comment, unwired test, environment-dependent byte budget via the live burn scan); all fixed in b9f2786fb5 and re-verified by four lanes in round 2 (RP-003..RP-006). Note the F-004 discovery hardened the fix beyond the original scope: the brief-output smoke's byte budget is now deterministic (burn scan disabled via its documented env switch in the fixture), which is what makes acceptance signal #1 stable rather than time-of-day-dependent.
