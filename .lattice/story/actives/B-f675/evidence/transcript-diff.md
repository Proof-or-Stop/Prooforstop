# B-f675 real-machine transcript vs PLAN-outcome diff

Adds a read-only incremental-review-context helper + `lattice review_incremental_context` CLI + a
round>=2 informed targeted re-review advisory. The REVIEW->TEST gate is unchanged; the framework never
skips a reviewer.

## Expected (understanding.outcome)
> On a round>=2 REVIEW entry the operator sees which reviewers' scope changed and can re-run just those;
> `lattice review_incremental_context --role=<r>` prints the reviewer's prior verdict + the diff since its
> last pass; `lattice validate` stays green with a smoke proving canPassReviewGuard is identical with/without
> the helper.

## ACTUAL (real machine, in the B-f675 worktree, via the worktree dist)

CLI on a reviewer that already passed this story (concept passed in Round 2):
```
$ node packages/main/dist/cli.js review_incremental_context --storyId=B-f675 --role=concept
role: concept
isFirstPass: false
scopeChanged: false
priorHeadHash: abcf35fe416a707e1db84d6571b8472758a9cc7c
priorVerdict: PASS (B-f675:RP-009)
changedFiles: (none)
```
(scopeChanged=false => nothing changed since concept last passed => an operator doing round-2+ targeted
re-review would not need to re-run concept. This is the efficiency signal, surfaced read-only.)

Smoke (helper + gate-unchanged), `node packages/main/dist/tasks/review-incremental-context-smoke.js`:
```
review-incremental-context-smoke: PASS — incremental context is correct for returning/first-timer/rename
(cases a-c), and canPassReviewGuard is behaviorally IDENTICAL with vs without the incremental helper across
all gate branches (round-1 opt-in+quorum, round-2+ single receipt, invalid-binding-blocks-all-rounds,
verified-open-blocking-finding), with the helper proven to write nothing to the store (case d).   (exit 0)
```

REVIEW->TEST CLI gates (channel/concept/lint/docs-drift): all pass; `lattice validate` PASS; verification
intent coverage 9/9; the smoke is chained into the validate battery.

## Diff notes
- **Match.** The helper returns a reviewer's prior verdict + bound headHash + scopeChanged + the rename-aware
  diff since that pass (full main..HEAD diff for a first-timer). The round>=2 advisory in transition-effects
  is append-only and lists scope-changed reviewers + the round-2+ >=1-receipt note, framed as an operator
  choice ("the framework skips nobody; this is your call").
- **HARD INVARIANT held.** core/machine.ts canPassReviewGuard, core/review-run.ts, core/review-scope-binding.ts
  have ZERO diff vs main. Smoke case (d) runs the REAL canPassReviewGuard twice per fixture and proves the
  outcome + gate inputs are byte-identical with/without the helper. The framework never skips a reviewer; the
  round-2+ leniency it surfaces (gate needs >=1 valid receipt) already existed in canPassReviewGuard.
- **Gate behavior corrected in docs.** INIT review caught that the gate is more lenient than first framed
  (Round 1 = all opt-in + quorum; Round 2+ = >=1 receipt; invalid-binding blocks ALL rounds). CLAUDE.md now
  documents the accurate behavior; the docs reviewer verified it matches code.
- **Self-hosting note:** because the global `lattice` binary is the (stale) main-repo dist, the REVIEW->TEST
  docs-drift gate must be run via the worktree dist (`node packages/main/dist/cli.js`), which has the new
  `review_incremental_context` command registered — otherwise docs-drift falsely reports it "unregistered".
- F-001 (low, behavior reviewer): isFirstPass-vs-priorVerdict sub-case (unresolvable prior headHash) was
  undocumented; fixed with interface docs + CLAUDE.md + smoke case (e). Round 2 clean.
- OUT OF SCOPE (deferred): framework-side skipping/carry-forward (the skip variant); any gate/binding change.
