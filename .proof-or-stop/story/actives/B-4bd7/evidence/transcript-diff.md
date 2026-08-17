# B-4bd7 User-Value Transcript Diff

## Expected

The user can point future Lattice CLI work at:

- `docs/requirements/decisions/lattice-workflow-efficiency-baseline.md`
- `experiments/baselines/lattice-workflow-efficiency-baseline-v1.json`

and require every optimization story to compare against that baseline before
claiming a fix.

## Actual Transcript

Command captured by `lattice live_smoke_transcript --storyId=B-4bd7 --capture=... --write --json`:

```text
Registered docs/requirements/decisions/lattice-workflow-efficiency-baseline.md as the workflow-efficiency baseline protocol.
Registered experiments/baselines/lattice-workflow-efficiency-baseline-v1.json with six observedBefore/targetAfter dimensions.
Verified the baseline JSON parses, registrationStory=B-4bd7, and this story made no runtime optimization changes.
```

## Diff Notes

No user-value gap. The actual transcript confirms the expected baseline document
and baseline JSON are present, the JSON is parseable, the registration story is
`B-4bd7`, all six dimensions are present, and the story does not claim runtime
optimization changes.

This is local Lattice workflow evidence only. It does not claim
`authorityDone`, `fullAuthorityDone`, or `productionDone`.
