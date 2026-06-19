# B-7adb User-Value Transcript Diff

## Expected

- `autopilot_review_status` keeps the default-run top-level view, but also shows
  custom local review rounds through all-runs/latest-runs diagnostics.
- `review_escalation_status` stays `required: false` / `ok: true` for this
  story, while showing voluntary local 3x2 evidence when it exists.
- Stale-material DONE blocking output names stale host verdicts and prints the
  recovery commands without suggesting a bypass.

## Actual

Command:

```bash
node packages/main/dist/cli.js autopilot_review_status '{"storyId":"B-7adb"}'
```

Key output:

```text
runId: default-run
status: blocked
runCount: 4
runs: default-run, round-1, round-2, round-3
latestRuns: 4
  - round-2: pass 2/2 passing hosts, total=2, stale=0, duplicate=0
  - round-3: pass 2/2 passing hosts, total=2, stale=0, duplicate=0
  - round-1: pass 2/2 passing hosts, total=2, stale=0, duplicate=0
  - default-run: blocked 0/2 passing hosts, total=0, stale=0, duplicate=0
diagnosticOnly: true
authorityServerContact: false
```

Command:

```bash
node packages/main/dist/cli.js review_escalation_status '{"storyId":"B-7adb"}'
```

Key output:

```text
required: false
ok: true
assuranceLevel: ordinary-review
authorityDone: false
fullAuthorityDone: false
productionDone: false
voluntaryLocalRounds: 3/3 rounds x 2 hosts (submitted=3, complete=true)
```

Command:

```bash
node --input-type=module -e '<formatReviewAssuranceFloorFailure stale verdict demo>'
```

Key output:

```text
stale host verdicts: verdict-stale-demo@round-1 materialDigest=old-material
Stale material recovery:
  1. Re-run validation: lattice validate --story=B-7adb --json
  2. Refresh stale verificationEvidence: lattice verification_evidence_refresh_stale --storyId=B-7adb --dryRun; rerun listed evidence commands; rerun without --dryRun.
  3. Re-submit local host verdicts over materialHash=ed6d7fcd224c9ea60dc9e78cd44d45daa1ea797ec560ac0575a46c88dd4f3c48: lattice autopilot_review_submit ...
  4. Re-check local diagnostics: lattice autopilot_review_status --storyId=B-7adb; lattice review_escalation_status --storyId=B-7adb
  - Do not bypass stale material checks; stale verdicts/evidence stay ignored until refreshed or resubmitted over the current material.
```

## Diff Notes

No user-value gap found. The actual output matches the expected diagnostic UX:
custom local runs are visible, voluntary local 3x2 evidence is visible without
changing required/ok semantics, and stale-material recovery is explicit and
fail-closed.

One environment note: the global `lattice` binary in this worktree still pointed
at the previously built global package, so this transcript used
`node packages/main/dist/cli.js` after `npm --prefix packages/main run build`.
After B-7adb is merged to main, main must be built so the global entrypoint sees
the new diagnostics.
