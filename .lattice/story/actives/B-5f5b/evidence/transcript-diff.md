# B-5f5b User-Value Acceptance Transcript Diff

Story: B-5f5b - Complete historical playbook backfill and bounded trial automation
Date: 2026-07-03
Machine: local macOS worktree `/Users/jek/Documents/Work/proofbound/.worktrees/B-5f5b`

## Expected

- The built CLI exposes `playbook_seed_backfill`, `playbook_trial_run`, and `playbook_promotion_timer`.
- All three user-facing automation commands default to dry-run behavior.
- Historical backfill can preview eligible seeds without writing candidate playbooks unless `--apply` is supplied with the current `observeDigest`.
- Candidate trial can preview candidate exposure and matched-control rows without writing outcome/control rows unless `--apply` is supplied.
- Timer automation is one-shot and bounded. Requested steps are explicit; unrequested steps are rendered as disabled instead of disappearing.
- Activation remains guarded by the existing evidence-activation policy. Candidate existence or DONE success alone must not activate a playbook.
- Dry-run output remains non-authoritative and never becomes lifecycle gate evidence.

## Actual Transcript

Command:

```bash
node packages/main/dist/cli.js playbook_seed_backfill --help
```

Observed:

- Command is present.
- Help says dry-run is default.
- `--apply` requires `--observeDigest`.
- `--limit` omitted means all proposable seeds, not the legacy capped batch.

Command:

```bash
node packages/main/dist/cli.js playbook_trial_run --help
```

Observed:

- Command is present.
- `--storyId` is required.
- Help says dry-run is default.
- `--apply` appends idempotent unknown candidate-trial outcome rows and matched-control rows, and never records helped.

Command:

```bash
node packages/main/dist/cli.js playbook_promotion_timer --help
```

Observed:

- Command is present.
- Help says dry-run is default.
- It supports explicit `--backfill`, `--trial`, `--sweep`, and `--activate` steps.
- `--apply` runs requested bounded steps once; activation still uses `playbook_auto_promotion_apply` guards.

Command:

```bash
node packages/main/dist/cli.js playbook_seed_backfill --limit=3 --json
```

Observed key fields:

```json
{
  "schemaVersion": "proofbound.playbook-seed-backfill.v1",
  "dryRun": true,
  "applied": false,
  "limit": 3,
  "observeDigest": "2ac8c6216355fd430686e67808a29bb3942c5e49886cce7146a1094ff7dbb82b",
  "selectedSeedCount": 3,
  "plannedCount": 3,
  "createdCount": 0,
  "skippedCount": 861,
  "blockedCount": 742,
  "alreadyRepresentedCount": 4,
  "createdPlaybookIds": [],
  "authority": "non_authoritative",
  "gateEvidence": false
}
```

The dry-run preview listed candidate plans for `PBP-006`, `PBP-007`, and `PBP-008` without writing them.

Command:

```bash
node packages/main/dist/cli.js playbook_trial_run --storyId=B-5f5b --limit=3 --json
```

Observed key fields:

```json
{
  "schemaVersion": "proofbound.playbook-trial-run.v1",
  "dryRun": true,
  "applied": false,
  "storyId": "B-5f5b",
  "limit": 3,
  "candidateCount": 5,
  "selectedCount": 3,
  "skippedByLimitCount": 2,
  "outcomeCreatedCount": 0,
  "controlCreatedCount": 0,
  "authority": "non_authoritative",
  "gateEvidence": false
}
```

The dry-run preview selected `PBP-001`, `PBP-002`, and `PBP-003` and emitted deterministic candidate-exposure and matched-control idempotency keys without writing rows.

Command:

```bash
node packages/main/dist/cli.js playbook_promotion_timer --backfill --trial --activate --storyId=B-5f5b --backfillLimit=3 --trialLimit=3 --json
```

Observed key fields:

```json
{
  "schemaVersion": "proofbound.playbook-promotion-timer.v1",
  "dryRun": true,
  "applied": false,
  "storyId": "B-5f5b",
  "bounded": true,
  "limits": {
    "backfill": 3,
    "trial": 3,
    "sweep": 25
  },
  "authority": "non_authoritative",
  "gateEvidence": false
}
```

Observed timer steps:

```json
[
  {
    "step": "backfill",
    "requested": true,
    "status": "dry-run",
    "applied": false,
    "message": "planned=3 created=0 blocked=742 alreadyRepresented=4"
  },
  {
    "step": "trial",
    "requested": true,
    "status": "dry-run",
    "applied": false,
    "message": "selected=3 outcomeCreated=0 controlCreated=0"
  },
  {
    "step": "sweep",
    "requested": false,
    "status": "disabled",
    "applied": false,
    "message": "sweep step not requested"
  },
  {
    "step": "activate",
    "requested": true,
    "status": "dry-run",
    "applied": false,
    "message": "activated=0 blocked=5 globalBlockers=no_candidate_passed_activation_guards"
  }
]
```

Activation guard detail showed all current candidates blocked by evidence prerequisites such as insufficient decisive samples, insufficient helped count, missing concrete exposure, and hold recommendations.

## Diff Notes

- PASS: The three new command surfaces exist in the built CLI.
- PASS: Help text exposes dry-run defaults and apply guard conditions.
- PASS: Backfill dry-run planned candidate creation without writing candidates, outcomes, decisions, lifecycle evidence, or gate evidence.
- PASS: Trial dry-run selected bounded candidate playbooks and produced deterministic exposure/control keys without writing outcomes or controls.
- PASS: Timer dry-run rendered disabled `sweep` explicitly instead of silently omitting it.
- PASS: Timer activation remained blocked for all current candidates; candidate existence did not activate playbooks.
- PASS: All dry-run outputs were `authority=non_authoritative` and `gateEvidence=false`.

Observed live-store note:

- The local learning store already contains 5 candidate playbooks and 4 already represented historical sources before the full historical apply. This is compatible with the expected state: B-5f5b adds the safe backfill/trial/timer machinery; the full historical apply should run after DONE from canonical main so the global CLI and dist are synchronized.
