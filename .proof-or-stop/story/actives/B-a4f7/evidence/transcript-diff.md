# Live Smoke Transcript Diff

Story: B-a4f7
Captured: 2026-07-03T10:53:56.415Z

## Expected

A single command can convert eligible DONE/story seeds into candidate playbooks
and report created/skipped/blocked counts.

## Actual Command

```bash
node packages/main/dist/cli.js playbook_candidate_ingest --json
```

## Actual Result

Exit code: 0

Key output:

```json
{
  "schemaVersion": "proofbound.playbook-candidate-ingest.v1",
  "dryRun": true,
  "applied": false,
  "sourceFilter": "done-experience",
  "limit": 5,
  "proposedCount": 5,
  "candidateCreatedCount": 0,
  "candidatePlaybookIds": ["PBP-001", "PBP-002", "PBP-003", "PBP-004", "PBP-005"],
  "skippedCount": 120,
  "blockedCount": 0,
  "invalidProposalCount": 0,
  "authority": "non_authoritative",
  "gateEvidence": false
}
```

## Diff Notes

- PASS: the command is available through the worktree `dist/cli.js` build.
- PASS: default source is `done-experience`.
- PASS: the command reports proposed, skipped, blocked, and invalid counts.
- PASS: dry-run mode did not create candidate playbooks (`candidateCreatedCount: 0`).
- PASS: the surface remains non-authoritative and cannot become gate evidence.

This live smoke proves the user-visible preview path. Mutation behavior is
covered by `node packages/main/dist/tasks/playbook-seed-promotion-loop-smoke.js`,
including scoped apply, idempotency, unrelated proposal preservation, no helped
outcome rows, and no auto-activation rows.
