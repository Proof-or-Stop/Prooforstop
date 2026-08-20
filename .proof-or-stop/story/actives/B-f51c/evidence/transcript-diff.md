# B-f51c User-Value Transcript Diff

## Expected

The user can review `docs/requirements/decisions/proofstory-intent-collision-execution-plan.md`
and see these concrete outcomes:

- The progressive model says it has five rules.
- A pre-collision milestone ledger is explicitly candidate-only.
- A milestone ledger becomes gate-consumed only after accepted intent
  interpretation confirms it.
- The ProofStory schema and gate inputs consume `confirmedMilestoneLedger`, not
  an unconfirmed candidate ledger.
- Oversized ledgers require slicing before DEV, but automatic parallel
  child-story dispatch is optional and deferred to Scheduler, Unattended, or
  Autopilot work.

## Actual Transcript

```text
$ rg -n "This progressive model has five rules|candidate only; not gate-consumed yet|confirmedMilestoneLedger|confirmedByIntentInterpretation|no mandatory parallel child-story execution|Automatic parallel child-story dispatch belongs" docs/requirements/decisions/proofstory-intent-collision-execution-plan.md
97:This progressive model has five rules:
177:          (candidate only; not gate-consumed yet)
249:| `confirmedMilestoneLedger` | The gate-consumed milestone ledger after intent interpretation confirms that the decomposition matches the original request |
524:      "confirmedMilestoneLedger",
539:    "confirmedByIntentInterpretation": "accepted",
397:- no mandatory parallel child-story execution;
402:Automatic parallel child-story dispatch belongs to a dedicated Scheduler,

$ rg -n "This progressive model has four rules|must run in parallel|must be parallel" docs/requirements/decisions/proofstory-intent-collision-execution-plan.md
<no matches>

$ rg -n "[\\p{Han}]" docs/requirements/decisions/proofstory-intent-collision-execution-plan.md
<no matches>

$ node bin/lattice.js validate --story=B-f51c --json
Project validation commands passed; allPass=true; 31 configured commands passed.
```

## Diff Notes

No user-value gap remains for this docs-only correction. The document now
matches the requested design: candidate ledgers are not gate evidence, confirmed
ledgers are the gate-consumed contract, and parallel child-story execution is
kept out of the ProofStory M0-M2 MVP.

## Limitations

This story intentionally does not implement Scheduler, Unattended, or Autopilot
parallel execution. That belongs to a separate development story.
