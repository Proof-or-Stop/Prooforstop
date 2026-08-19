# B-cd3a Real-Machine Transcript Diff

## Expected

The user-facing control-plane audit should preserve Tier-C provider-execution receipt verification stories as experiment-batch-exception evidence, avoid treating them as duplicate cleanup candidates, keep malformed Tier-C records visible for cleanup, and avoid claiming production or authority completion.

## Actual

Command:

```bash
node bin/lattice.js queue_governance_status --format=json
```

Observed summary:

```json
{
  "activeWorktree": 2,
  "staleWorktree": 0,
  "mainInit": 1,
  "experimentBatchException": 23,
  "duplicateCandidate": 0,
  "superseded": 0,
  "cleanupRequired": 2
}
```

The live transcript artifact was also written to `evidence/live-smoke-transcript.json`.

## Diff

No user-visible difference from the expected behavior. Valid Tier-C provider-execution receipt verification stories are grouped as preserved experiment-batch exceptions, no valid batch stories are classified as duplicate candidates, and the two malformed Tier-C records remain cleanup-required instead of being hidden or auto-waived.
