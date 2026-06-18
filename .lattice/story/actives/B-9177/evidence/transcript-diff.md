# B-9177 real-machine transcript ↔ PLAN-outcome diff

The change closes the main-write-lock coverage gaps (generalizing the B-7365 fix) and adds a mechanical
regression guard that runs inside `lattice validate`.

## Expected (understanding.outcome)
> Running the new guard shows it green and proves it bites; `lattice validate` prints ALL PASS, so a future
> B-7365-class gap (a main commit/merge shipped without the lock) turns the guard red instead of silently
> corrupting concurrent sessions' metadata.

## ACTUAL (real machine, in the B-9177 worktree)

Guard on the real tree:
```
$ node packages/main/dist/tasks/main-write-lock-coverage.js
main-write-lock-coverage: scanned 277 source files, 17 git mutation-verb sites
main-write-lock-coverage: PASS — all 7 main-mutating path(s) hold the main write lock      (exit 0)
```

Guard proves it bites (negative demo):
```
$ node packages/main/dist/tasks/main-write-lock-coverage.js --negative-demo
  ✗ core/__negative_fixture__.ts:3  [commit]  mutates-main=YES  locked=NO   VIOLATION
main-write-lock-coverage: FAIL — 1 unlocked main-mutating path(s):                          (exit 1)
```

Guard runs inside `lattice validate`:
```
$ lattice validate '{"storyId":"B-9177"}'
    main-write-lock-coverage: scanned 277 source files, 17 git mutation-verb sites
    main-write-lock-coverage: negative fixture bites (unlocked main commit ⇒ VIOLATION; locked ⇒ OK;
      worktree-only merge ⇒ OK; gitFile commit/update-ref on main ⇒ VIOLATION; gitFile story-branch bootstrap ⇒ OK)
    main-write-lock-coverage: PASS — all 7 main-mutating path(s) hold the main write lock
    ✓ ALL PASS
Verification intent coverage: 9/9 covered (0 required missing)
```

## Diff notes
- **Match.** The audit (CHK-001) found B-7365 was NOT the only gap: four unlocked main-mutating paths existed —
  `commitFromDraftMetadataOnMain`, `commitFromDraftMetadataAndMergeMain` (cli-engine.ts), `story_discard`
  (reset --hard + metadata commit on main) and dormant `dev_merge` (worktree.ts). CHK-002 wrapped all four in
  `withReentrantMainWriteLock` (reentrant, lock-only — no semantic change). CHK-003 added the
  `main-write-lock-coverage` guard which now reports all 7 main-mutating paths locked and bites (exit 1) on any
  unlocked main mutation, including future `gitFile`-based commits (the F-001 fix closed that wrapper blind spot).
- The guard classifies by **target** (which ref is written) and resolved git **cwd**, fail-closed: an unrecognized
  cwd is treated as main, so a new unlocked primitive fails BY CONSTRUCTION rather than slipping through an
  allowlist. Story-worktree-only merges (merging main INTO a story branch) are correctly NOT required to hold the lock.
- REVIEW found and fixed two findings: F-001 (medium — guard `gitFile` blind spot, behavior reviewer) and
  F-002 (low — header comment over-claimed write-tree coverage, quality reviewer). Both resolved; Round 3 clean.
- B-7365 + B-72df (this session) plus B-9177 together close the concurrent-shared-main-worktree corruption class:
  B-7365 locked the reconcile, B-72df stopped DONE blocking on unrelated dirty main, B-9177 locks the remaining
  paths and adds the mechanical guard so a regression can't ship unnoticed.
- OUT OF SCOPE (deferred Option B): full per-session physical checkout isolation — recorded in scope-boundary.json.
