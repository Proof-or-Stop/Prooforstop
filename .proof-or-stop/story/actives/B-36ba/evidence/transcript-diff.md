# B-36ba real-machine acceptance transcript + diff

## Expected (PLAN outcome)
Running the suite prints `review-escalation freshness-root smoke passed` alongside the existing
review-escalation and wrapper-root smokes, `node scripts/verify-process-fact-contract.mjs` still
passes, and in a wrapper-root project the review-escalation and review-assurance-floor agree on
the SAME materialHash/storyFilesHash (escalation no longer reads from the wrong root). Plain repos
byte-identical.

## Actual (run from the story worktree, post-merge of main @ f38a3933d)

```
$ node packages/main/dist/tasks/review-escalation-freshness-root-smoke.js
review-escalation freshness-root smoke passed

$ node packages/main/dist/tasks/review-escalation-smoke.js
review-escalation smoke passed (15 checks)

$ node packages/main/dist/tasks/review-assurance-floor-smoke.js
review-assurance-floor smoke passed (10 checks)

$ node packages/main/dist/tasks/done-oracle-wrapper-root-smoke.js
done-oracle wrapper-root smoke passed

$ node scripts/verify-process-fact-contract.mjs
Process fact contract verified

$ npm test
... (full chain incl. test:review-escalation-freshness-root, test:lattice-residue,
     test:review-assurance-floor-storyfileshash-smoke, e2e, experiments)
NPM_TEST_EXIT=0
```

Escalation/floor status after the genuine 2-host quorum:
```
$ lattice review_escalation_status --storyId=B-36ba
countableProblems: 2/2   fullQuorum: 3/3 rounds x 2 hosts
materialHash: 2da52d1ae3...   storyFilesHash: 8a6b2aeb45...
```

## Diff (expected vs actual)
No difference. The new smoke passes, all existing smokes pass, the process-fact contract passes,
and `npm test` is green (exit 0). The genuine 2-host review (Claude lanes + Codex host-2) is
complete; Codex host-2 caught a real test-genuineness gap (F-003) which was fixed and
independently revert-proven (removing machine.ts:639 gitCwd makes the smoke FAIL).

## Real-machine guard proof (F-003)
Temporarily removing the `gitCwd:` line from the canFinishGuard escalation call (machine.ts:639),
rebuilding, and running the smoke FAILS with `canFinishGuard ... false !== true`; restoring
machine.ts and rebuilding makes it pass again. The DONE-gate escalation call sites genuinely
depend on the gitCwd fix.

## Limitations
The new equivalence/guard coverage is offline (synthetic git fixtures); it exercises the real
evaluators, handlers, and machine guards but not a live multi-repo wrapper-root deployment.
