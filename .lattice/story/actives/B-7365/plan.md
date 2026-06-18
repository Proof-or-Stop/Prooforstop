# Plan: B-7365 INIT_CHECK reconcile must not commit conflict markers into story metadata

> **Scope.** Make `commitInitCheckMetadataAndMergeMain` (cli-engine.ts ~3412) conflict-safe under
> concurrent main churn: wrap the main-commit + merge in `withReentrantMainWriteLock`, and on any
> residual merge conflict resolve all conflicted story-metadata paths deterministically to the
> post-advance (main-committed) state — never leave/commit `<<<<<<< / ======= / >>>>>>>` markers.
> Decision **Option A** (lock + deterministic resolution). No INIT_CHECK semantic change; idempotent;
> single-session flow byte-identical.

## CHK-001: reproduction test

**Owner**: lattice-implementer  **DependsOn**: none
**Files**: Create a function/integration test (packages/main/src/tasks/ style; wire into package.json) that sets up a story-branch index.json (e.g. phase INIT) and a main index.json (phase INIT_CHECK) that conflict, drives the reconcile merge path, and asserts the committed index.json parses as JSON with **no** conflict markers. This is the failing repro per the debugging contract (fails before the fix, passes after).
**Verify**: the test fails on current code (markers) and passes after CHK-002/003; `lattice validate` green.
**DoneWhen**: repro reliably reproduces the marker-corruption pre-fix and is green post-fix.

## CHK-002: conflict-safe reconcile (deterministic metadata resolution)

**Owner**: lattice-implementer  **DependsOn**: CHK-001
**Files**: Modify `commitInitCheckMetadataAndMergeMain` in packages/main/src/cli-engine.ts (~3473 merge). On a conflicted merge of machine-generated story metadata, resolve ALL conflicted paths under the storyDir deterministically to the post-advance/main-committed version (e.g. `git checkout --theirs`/take main + `git add` + complete the merge), so markers are never committed. Never leave the worktree mid-merge with markers.
**Verify**: a forced metadata conflict resolves cleanly (no markers), merge completes; multi-file conflict fully resolved.
**DoneWhen**: reconcile never commits/leaves conflict markers; resolved metadata == expected post-advance state.

## CHK-003: run the reconcile under the main-write-lock

**Owner**: lattice-implementer  **DependsOn**: CHK-001
**Files**: Wrap the reconcile's main metadata commit + merge in `withReentrantMainWriteLock(mainRepoRoot, fn, {label:'INIT_CHECK reconcile'})` from core/main-write-lock.js, so a concurrent session committing to main cannot race between the commit and the merge. Use the **reentrant** variant (the reconcile may run within an already-locked context).
**Verify**: concurrent INIT_CHECK advances are serialized (no corruption); a single-session advance does not deadlock; a thrown reconcile releases the lock.
**DoneWhen**: the metadata-commit + merge run inside one lock acquisition; reentrant; lock released on throw.
