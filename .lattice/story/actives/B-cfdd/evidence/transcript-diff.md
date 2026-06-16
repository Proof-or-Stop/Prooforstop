# B-cfdd real-machine transcript vs PLAN-outcome diff

The change adds a SOFT, advisory-only REVIEW convergence-stall detector and wires it into the
`story_advance REVIEW` output. It never blocks a transition.

## Expected (understanding.outcome)
> Re-entering REVIEW on a non-converging story prints an English advisory and the story can still
> advance; a healthy/below-threshold story prints nothing; the advisory never blocks REVIEW->TEST.

## ACTUAL (real machine, in the B-cfdd worktree)

Detector smoke (the behavior), `node packages/main/dist/tasks/review-convergence-smoke.js`:
```
review-convergence-smoke: (a) STALLED fires — advisory present
review-convergence-smoke: (b) CONVERGING [2,1,0] -> stalled=false, no advisory
review-convergence-smoke: (c) BELOW THRESHOLD (3 < 4 rounds) -> stalled=false
review-convergence-smoke: (d) SINGLE CLEAN ROUND -> stalled=false
review-convergence-smoke: (e) NON-BLOCKING PROOF: append path is text-only, base preserved, no error/blocking signal
review-convergence-smoke: (f) SHORT-WINDOW PRECONDITION: [2,1]->false, [2,2]->false; full windows unchanged
review-convergence-smoke: PASS                                                            (exit 0)
```

The advisory text emitted for a stalled story (completed rounds [2,2,1] at round 4):
```
WARN review convergence stall: REVIEW has cycled 4 rounds and the most recent rounds still surface
blocking findings with no downward trend (recent rounds: [2, 2, 1]).
  - Debugging Contract escalation: 3+ fix attempts that keep surfacing new problems usually point to
    an architecture/design issue. Consider escalating the design instead of patching another round.
  - Prefer dismissing advisory-level findings (finding_dismiss + reason) over re-rounding: every
    source-changing fix-commit stales the round and forces a fresh REVIEW round.
```

`lattice validate '{"storyId":"B-cfdd"}'` -> ALL PASS; verification intent coverage 9/9 covered;
the smoke is invoked inside the validate battery (chained as test:review-convergence-smoke before test:e2e).

## Diff notes
- **Match.** The detector fires only on a stalled, non-converging history and stays silent on healthy /
  below-threshold / single-clean / short-window stories. The message is English-only (per the user directive).
- **Key correctness point (the no-op trap).** At REVIEW-entry render time the just-entered round has no
  reviewer findings yet, so its blocking count is structurally 0. `assessReviewConvergenceAtEntry` drops
  that trailing current round and assesses COMPLETED rounds only; otherwise the clean-tail rule would
  suppress the advisory forever. Smoke case (a) proves the advisory fires over completed [2,2,1] (raw-dense
  [2,2,1,0] would be the no-op).
- **Non-blocking.** The injection in transition-effects.ts is a try/catch append-only block: it never
  throws out of the transition and never alters the transition result (smoke case e).
- **Inputs reuse existing helpers** (resolveReviewRoundCount, isFindingBlocking, effective per-round decay);
  the per-round counts are dense + round-aligned so the decay tier keys on the actual round number.
- REVIEW found and fixed two findings across rounds: F-001 round 1 (behavior — exported assessReviewConvergence
  false-positived on a short window; fixed with a documented short-window guard) was the only blocking one;
  Round 2 was clean. Thresholds (STALL_MIN_ROUNDS=4, STALL_WINDOW=3) are module constants, no CLI/config.
- OUT OF SCOPE (deferred): any hard cap/blocking gate, auto-dismiss, changing the round de-escalation rules,
  per-session config, and targeted/partial re-review (the per-round cost-reduction option B).
