# B-c1b1 Transcript Diff

## Expected

DONE recovery guidance for ordering-sensitive blockers should route through the
host-neutral `lattice done_prepare` path. DONE-required validation should remain
distinctly classified, but the user should not be sent back to the old direct
`done_required_validate` recovery loop for this DONE readiness path.

## Actual

Command captured on this machine:

```bash
npm --prefix packages/main run test:lifecycle-check-smoke
```

Observed transcript:

```text
> @lattice/core@0.3.68 test:lifecycle-check-smoke
> node dist/tasks/lifecycle-check-smoke.js

lifecycle_check smoke passed
```

The captured command passed after the smoke assertion was updated to require the
`done_prepare` next action while preserving the
`missing_done_required_validation` readiness classification.

## Diff

No user-visible mismatch remains for the tested path. The actual transcript
matches the expected recovery behavior.
