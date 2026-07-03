# B-5f5b Execution Plan

## Goal

Close the remaining playbook lifecycle automation gap without weakening the
Proofbound evidence boundary:

1. Convert historical proposable seeds into inert candidate playbooks.
2. Record bounded candidate trial exposure and matched-control observations.
3. Add an explicit timer command that runs only reviewed, guarded actions.

## Milestones

### M1 Historical Backfill

- Add a dry-run default CLI surface for full historical seed backfill.
- Require the current `playbook_seed_observe` digest on apply.
- Process all currently proposable seeds unless bounded by an explicit limit.
- Write only staged proposals and `status:"candidate"` playbooks.
- Report created, skipped, blocked, and already represented counts.
- Prove repeat apply is idempotent.

### M2 Trial And Matched-Control Observation

- Add an append-only, non-authoritative trial observation ledger.
- Record concrete candidate exposure without writing helped outcomes.
- Record matched-control observations for the same story/context.
- Keep candidates out of active runtime memory packs.
- Surface trial/matched-control counts in status or a dedicated report.

### M3 Timer Automation

- Add an explicit timer/sweep command with dry-run default.
- Allow apply only for explicitly enabled bounded actions.
- Delegate activation to existing `playbook_auto_promotion_apply` guards.
- Never register a hidden daemon and never write lifecycle gate evidence.
- Report disabled, skipped, blocked, and applied steps.

## Validation

- `playbook-seed-backfill-smoke` covers full backfill, idempotency, stale digest
  refusal, and candidate-only safety.
- `playbook-trial-automation-smoke` covers exposure/control observation, timer
  dry-run/apply behavior, and activation fail-closed behavior.
- `lattice validate --storyId=B-5f5b` must pass before TEST/DONE.

