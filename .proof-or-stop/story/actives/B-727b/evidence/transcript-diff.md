# B-727b User-Value Transcript Diff

Date: 2026-07-01
Story: B-727b
Scope: G03 prose-only negative-control milestone ledger baseline

## Expected Product Outcome

Running the G03 baseline smoke from the story worktree should prove that a
large milestone ledger cannot be marked complete from prose alone. The expected
observable output is:

```text
parent-roadmap large-ledger G03 baseline smoke PASS
```

The smoke is expected to assert that all 15 `G03-M01` through `G03-M15` rows are
present, none of them carry machine closure evidence, all remain open with
`missing_closure_evidence`, and full-completion wording is blocked.

## Actual Command

```bash
node packages/main/dist/tasks/parent-roadmap-large-ledger-g03-baseline-smoke.js
```

## Actual Output

```text
parent-roadmap large-ledger G03 baseline smoke PASS
```

## Diff

Expected output matches actual output exactly.

User-value conclusion: B-727b delivers the G03 baseline slice only. It adds a
machine-checkable negative control proving prose-only closure cannot satisfy the
parent-roadmap DONE claim, while keeping G04-G10 and the full 10x15 baseline
explicitly incomplete.
