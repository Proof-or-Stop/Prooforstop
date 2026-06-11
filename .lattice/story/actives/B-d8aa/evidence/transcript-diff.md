# B-d8aa Transcript Diff

## Expected

Running `node packages/main/dist/cli.js convergence_check` should show active worktree stories as hard blockers while parked `INIT` backlog stays visible as advisory:

- `所有 Story 完成`: `B-6974` remains a hard blocker because it has a linked `story/B-6974` worktree.
- `Parked backlog`: `B-4622`, `B-d7af`, and `B-da5b` are advisory only.
- `B-META-framework-audit` stays out of the hard Story completion check.

## Actual

Command:

```bash
node packages/main/dist/cli.js convergence_check
```

Observed transcript:

```json
{
  "converged": false,
  "checks": [
    { "name": "所有 Story 完成", "passed": false, "detail": "2 个 Story 未完成: B-6974, B-d8aa" },
    { "name": "Parked backlog", "passed": true, "detail": "3 个 parked backlog advisory: B-4622, B-d7af, B-da5b" },
    { "name": "Audit backlog", "passed": true, "detail": "0 blocking; 4 advisory; B-META-framework-audit:F-001 [low/suspected], B-META-framework-audit:F-002 [medium/suspected], B-META-framework-audit:F-003 [medium/suspected], B-META-framework-audit:F-006 [low/verified]" }
  ]
}
```

`B-d8aa` appears in the hard story check only because this story is still in progress during verification. After `B-d8aa` reaches DONE, the remaining hard blocker should be `B-6974`; the three parked backlog stories should remain advisory.

## Diff

Matches the expected product behavior. The parked backlog is visible but no longer independently makes convergence red.
