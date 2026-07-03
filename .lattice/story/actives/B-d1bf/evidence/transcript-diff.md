# B-d1bf Live Smoke Transcript Diff

## Expected

- Complete bound Q5 evidence returns a local claim-admissibility `advance` decision.
- The command remains read-only: `writesLifecycleEvidence=false` and `mutatesLifecycle=false`.
- Production and Authority boundary booleans remain false.
- Non-Q5 stronger requestedStrength overclaims fail closed to a degraded scoped claim instead of advancing.
- Production/Authority overclaims stop instead of advancing.

## Actual

Command captured by `lattice live_smoke_transcript --storyId=B-d1bf --capture=... --write` on 2026-07-03T02:43:57.455Z:

```text
complete decision=advance allowed=true writesLifecycleEvidence=false mutatesLifecycle=false productionClaim=false authorityClaim=false
q1-quantum-advantage decision=degrade allowed=false reason=weak_evidence_overclaim:quantum-advantage productionClaim=false authorityClaim=false
overclaim decision=stop allowed=false reasons=claim_boundary_violation:requestedStrength.production,claim_boundary_violation:productionClaim,claim_boundary_violation:authorityClaim,claim_boundary_violation:narrativeClaim productionClaim=false authorityClaim=false
```

The captured command exited with code `0`.

## Diff

- Complete evidence matched expected behavior: `advance`, `allowed=true`, no lifecycle mutation, and no production/Authority claim.
- Non-Q5 stronger requestedStrength matched expected F-010 behavior: `degrade`, `allowed=false`, and `weak_evidence_overclaim:quantum-advantage`.
- Production/Authority overclaim matched expected fail-closed behavior: `stop`, `allowed=false`, and explicit boundary violation reasons.
- No user-visible mismatch found.

## Artifact Reference

- `evidence/live-smoke-transcript.json`
