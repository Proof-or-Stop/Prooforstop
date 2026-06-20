# B-fb36 Real-Machine Transcript Diff

Command run from the B-fb36 story worktree:

```bash
node packages/main/dist/cli.js done_prepare '{"storyId":"B-fb36","mergeMain":false,"refreshStale":false,"validate":false,"dryRun":true}'
```

Expected:

- The local worktree CLI exposes the new `done_prepare` command.
- The command does not mutate version files, evidence, or lifecycle state in
  dry-run mode.
- The command remains fail-closed when the current story is not yet ready for
  DONE, and does not claim `authorityDone`, `fullAuthorityDone`, or
  `productionDone`.

Actual:

```text
[0.0s] running done_prepare...
[1.7s] done_prepare done
DONE prepare: BLOCKED
blockedAt: doneClosure
reason: branch-synced-main: Branch synced with main: story/B-fb36 is behind main by 69 commits; delivery-check: delivery-check: Missing delivery-check.json (requires lattice-review-delivery reviewer signature); review-escalation: Review escalation: ordinary-review; first-round problems 4/2; review-assurance-floor: Review assurance floor: missing; material code paths 10; local rounds 0/3; story-summary: Story summary: No summary.json
commands:
  - lattice review_escalation_status '{"storyId":"B-fb36"}'
  - lattice validate --story=B-fb36 --json
  - lattice verification_evidence_refresh_stale --storyId=B-fb36 --dryRun
  - lattice autopilot_review_submit --storyId=B-fb36 --runId=<round-id> --hostId=<host> --sessionId=<session> --keyId=<key> --decision=pass --materialDigest=<current-materialHash> --validationDigest=<fresh-validation-digest> --promptDigest=<current-prompt-digest>
next: lattice review_escalation_status '{"storyId":"B-fb36"}'

Steps:
  preflight: PASS
  mergeMain: SKIPPED — mergeMain=false
  staleEvidenceRefresh: PASS — no stale verification evidence
  validate: SKIPPED — validate=false
  doneClosure: BLOCKED — branch-synced-main: Branch synced with main: story/B-fb36 is behind main by 69 commits; delivery-check: delivery-check: Missing delivery-check.json (requires lattice-review-delivery reviewer signature); review-escalation: Review escalation: ordinary-review; first-round problems 4/2; review-assurance-floor: Review assurance floor: missing; material code paths 10; local rounds 0/3; story-summary: Story summary: No summary.json
  runtimeChange: PENDING
  cleanTree: PENDING
```

Diff notes:

- Matches expected fail-closed behavior: it did not print `DONE prepare: PASS`
  while delivery check, review escalation, review assurance, summary, and
  branch sync readiness are incomplete.
- Matches host-neutral boundary: no Authority or production completion was
  claimed.
- The global `lattice` binary in this shell did not know `done_prepare` before
  this story is merged/rebuilt; this transcript therefore uses the worktree's
  built CLI entrypoint.
