# B-d1bf Live Smoke Transcript Diff

## Expected

- Complete bound Q5 evidence returns a local claim-admissibility `advance` decision.
- The command remains read-only: `writesLifecycleEvidence=false` and `mutatesLifecycle=false`.
- Production and Authority boundary booleans remain false.
- Retired DONE/Authority payload fields fail closed instead of advancing.

## Actual

Command captured by `lattice live_smoke_transcript --storyId=B-d1bf --capture=... --write` on 2026-07-03T02:21:41.127Z:

```text
complete decision=advance allowed=true writesLifecycleEvidence=false mutatesLifecycle=false productionClaim=false authorityClaim=false
retired-field decision=stop allowed=false reasons=claim_boundary_violation:retired_boundary_field
```

The captured command exited with code `0`.

## Diff

- Complete evidence matched expected behavior: `advance`, `allowed=true`, no lifecycle mutation, and no production/Authority claim.
- Retired field payload matched expected fail-closed behavior: `stop`, `allowed=false`, and `claim_boundary_violation:retired_boundary_field`.
- No user-visible mismatch found.

## Artifact Reference

- `evidence/live-smoke-transcript.json`
