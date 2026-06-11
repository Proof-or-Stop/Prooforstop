# Transcript Diff: B-1b01

## Expected

User runs the repaired Koala workflow and sees:

```text
koala doctor
terminal registered: 0
orphan dirs        : 0
terminal dirs      : 0
✓ No orphan or terminal worktree cleanup issues.

koala story_list
_bugSummary does not contain Terminal worktrees (...)

git worktree list
does not contain B-e8bb 0000000 [story/B-e8bb]
active worktrees remain registered
```

## Actual

Validation commands run on final code:

```text
npm run build
PASS

npm --prefix packages/main run test:worktree-repair-smoke
✓ worktree repair smoke passed

npm test
✓ story-lifecycle (5 steps)
✓ gap-convergence (4 steps)
✓ ALL PASS

koala validate
✓ package.json test script: npm test
```

Manual product check from the original affected Prodenovo project after installing the global package fix:

```text
koala doctor
registered: 2
terminal registered: 0
orphan dirs        : 0
terminal dirs      : 0
✓ No orphan or terminal worktree cleanup issues.

git worktree list
main
.worktrees/B-89bd
```

## Difference

The expected user-facing health transcript is satisfied. `B-96c1` is gone, `B-e8bb` no longer appears in `git worktree list` as a `0000000` registry entry, and the remaining physical `B-e8bb` directory is quarantined with `.koala-repair-ignore` so Koala no longer reports it as a terminal worktree problem.
