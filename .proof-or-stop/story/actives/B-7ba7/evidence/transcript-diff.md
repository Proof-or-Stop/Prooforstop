# B-7ba7 Real-Machine Transcript Diff

Story: B-7ba7 — Add read-only milestone status reporting with grouped progress tables
Recorded: 2026-07-04
Environment: local story worktree `/Users/jek/Documents/Work/proofbound/.worktrees/B-7ba7`

## Expected Outcome

- `node packages/main/dist/cli.js milestone_status --storyId=B-7ba7` renders a read-only grouped milestone table.
- Completed group contains M1, M2, M3, and M4.
- Current and Remaining groups contain `none`.
- Risks are `none`.
- Next action reports no remaining milestone action.
- Unknown CLI flags are rejected before story facts are printed.

## Actual Transcript

Command:

```bash
node packages/main/dist/cli.js milestone_status --storyId=B-7ba7
```

Observed:

```text
Milestone Status - B-7ba7
Mode: read-only
Phase: TEST
Ledger: state=confirmed hash=sha256:7e92682a9a2237a1433c8c7f1cda677e4e0567eac7d93d9efcb6e92e5083e33a

Completed
| Milestone | Purpose | Status: | Sub-objectives: | Evidence: | Risks: | Next action: |
|---|---|---|---|---|---|---|
| M1 | Define a machine-readable milestone status report model over existing story facts. | completed ...
| M2 | Expose a read-only lattice milestone_status CLI command. | completed ...
| M3 | Project checklist completion and verification detail into milestone rows. | completed ...
| M4 | Document and test the grouped progress reporting workflow. | completed ...

Current
| none | none | none | none | none | none | none |

Remaining
| none | none | none | none | none | none | none |

Risks: none
Next action: No milestone action; all ledger rows are completed or not applicable.
```

Negative command:

```bash
node packages/main/dist/cli.js milestone_status --storyId=B-7ba7 --format=json --surpriseFlag=true
```

Observed:

```text
Argument validation failed:
  (root): Unrecognized key: "surpriseFlag"
```

Exit code: non-zero.

## Diff Against Expected

- Completed milestones: expected M1-M4; actual M1-M4.
- Current milestones: expected none; actual none.
- Remaining milestones: expected none; actual none.
- Risks: expected none; actual none.
- Unknown flag behavior: expected rejection before story facts; actual argument validation rejection before story facts.

Verdict: PASS.

## Related Validation

- `lattice validate --story=B-7ba7 --forceTakeover`: PASS.
- Configured validate commands: 33/33 passed.
- Verification intent coverage: 12/12 covered.
