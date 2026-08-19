# B-b531 Transcript Diff

## Expected

`lattice done_closure` and `lattice review_escalation_status` for an already DONE story should use the DONE-time evidence snapshot by default. Later current-material drift must be visible as advisory revalidation context, not as a reopened DONE blocker. TEST-phase stories must remain strict.

## Actual

Command captured by `lattice live_smoke_transcript --storyId=B-b531 --capture='node packages/main/dist/cli.js done_closure "{\"storyId\":\"B-da34\"}"' --write`:

```text
DONE closure (lattice.done_closure.v1)
storyId: B-da34
phase: DONE
projection: historical DONE snapshot (delivery-check.json)
localAssuranceAudit: notRequired
Local assurance:
  admissibilityStatus: local-admissible
DONE oracle rows: 15 (0 blocking)
```

The full captured transcript is persisted in `evidence/live-smoke-transcript.json`.

## Diff

No user-visible mismatch. The previously stale current-material blockers are now historical DONE advisories, while unfinished TEST stories remain covered by `post-done-closure-snapshot-smoke`.
