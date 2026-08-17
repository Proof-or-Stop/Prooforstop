# B-cc10 — blocked on one human command

Phase: **PLAN**, fully prepared. Blocked by the convergence breaker (`gate-repeat 2>=2`).

**Progress: CHK-001 done (committed 63b9b081d5, mechanical receipt exit=0 selectorMatched=true).**
CHK-002..008 are hard-blocked and this was verified, not assumed:

```
dispatch failed: lattice-implementer cannot be dispatched during PLAN;
allowed phases: DEV, TEST_CASE
```

This story is normal channel (8 items + riskSignal `Data Migration/Destructive`), so the remaining
seven are code items an implementer subagent must write — the planner writing them would defeat the
channel constraint. Implementer dispatch needs DEV; DEV needs the ack below. Closed loop.

## To unblock

Run as **two separate commands** in an interactive terminal. A `cd … && node …` chain strips
the TTY and the ack is refused (`isInteractiveAckAllowed`, `core/convergence-breaker.ts`,
requires `stdin.isTTY === true`). Do **not** add `--takeover` / `--forceTakeover` — the breaker
gates takeover-carrying commands too (line 848), which is what blocked the first attempt on
B-cdf6.

```
cd /Users/qipan/work/repo/Prooforstop/.worktrees/B-cc10
```

```
node bin/proof-or-stop.js story_resume --storyId=B-cc10 --ack \
  --reason="three DEV gate attempts each followed a real fix; all six intent artifacts recorded, story_review 0 blockers, scope-check 0 gaps, scope-contract 0 blocking violations"
```

If it still refuses, check `env | grep -iE '^CI=|AUTOPILOT|NON_INTERACTIVE'` — any truthy value
refuses the ack regardless of TTY.

## Why the breaker fired

I ran `story_advance DEV` three times. Each attempt followed a real fix — (1) dev-memory
preflight ack, (2) intent artifacts, (3) scope-contract — but two consecutive gate failures is
the `gate-repeat 2>=2` signature. It fired correctly: I was iterating against a gate instead of
collecting all its requirements first. The lesson for next time is to read the *full* gate
requirement list once (`lifecycle_check --target=<phase>`) rather than discovering it one
rejection at a time.

## PLAN state — all gates satisfied

| Check | Result |
|---|---|
| `story_review` | 2 issues, **0 blockers** |
| scope-check | 9 covered, 9 excluded, **0 gaps**, 0 orphan-suspects |
| scope-contract | **0 blocking violations** |
| intent equivalence | `Blocking: no`, uncovered milestones: none |

Artifacts present: `original-intent-snapshot.json`, `intent-collision.json` (pass, independent),
`proofstory.json` (binding AB-001 → CHK-001..008), `scope-contract.json`, `scope-check.json`,
`dev-memory-preflight-ack.json`.

## After unfreezing

`story_advance --phase=DEV`, then execute in DEPENDENCY order (**not** id order):

```
CHK-001 → CHK-002 → CHK-008 → CHK-003 → {CHK-004, CHK-005} → CHK-006 → CHK-007
```

CHK-003 (the ~7580-file `git mv`) must NOT start until CHK-008's apply-then-revert rehearsal is
done and its evidence recorded. See `plan.md` for per-item Owner/Files/Verify/DoneWhen.

## Two findings worth carrying into DEV

1. **`storyFilesHash` hashes PATHS**, not just content (`story-files-hash-material-drift.md:30-31`,
   `path + blob-object-id` sorted by path). The state-dir rename therefore shifts it for all 344
   archives. CHK-001 must record the chosen handling before CHK-003 runs.
2. **`packages/main/package-lock.json` is legitimately in scope.** The scope-contract check failed
   closed on it; reading the diff showed a real change (`"proof-or-stop": "dist/cli.js"` added to
   the bin map), not install noise. Both lockfiles are now in CHK-005's declared files.

## Deliberately out of scope (verified, not convenience)

Root npm package name `lattice` (`brand-rename-mapping.md:131`, publishable — no `private:true`);
managed-block markers `<!-- lattice:start/end -->` (:134); `lattice.remote-push-approval.v1`
schema literal (:135); the 8 `lattice-*-integrity-v1` salts; the 13 `lattice-*` role IDs.
