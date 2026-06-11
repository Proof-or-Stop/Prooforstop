# B-0a80 User-Value Acceptance Transcript Diff

## Expected

From the PLAN outcome, a user should be able to inspect the merged B-688d artifacts and see three concrete results:

1. Artifact provenance is internally consistent: dependent `generatedAt` values are not earlier than their declared input artifacts, and no B-688d artifact points to the deleted `.worktrees/B-688d` path.
2. Baseline failure semantics are internally consistent: expected-PASS failed runs still fail because local independent review evidence is missing, not because terminal criteria failed while `terminalCriteriaSatisfied=true`.
3. Authority and host-neutral boundaries are unchanged: B-688d remains `GO-NOT-YET`, `authorityMode=off`, `evidenceClass=local-lifecycle`, with 2 hosts, 8 lanes, and 4 locks.

## Actual Transcript

Command:

```bash
lattice validate --story=B-0a80
```

Observed result:

```text
✓ Project validation commands passed; validate.ts/js/mts not found and no configured validate.command(s); used advisory fallback command discovery
  ✓ package.json test script: npm test
    ✓ story-lifecycle (5 steps)
    ✓ gap-convergence (4 steps)
    ✓ ALL PASS
  Verification intent coverage: 9/9 covered (0 required missing)
```

Earlier real-machine command:

```bash
npm test
```

Observed result:

```text
✓ story-lifecycle (5 steps)
✓ gap-convergence (4 steps)
✓ ALL PASS
```

Mechanical artifact acceptance output:

```text
artifact provenance check: PASS (generatedAt order ok, old worktree paths: 0)
baseline failure semantics check: PASS (terminal criteria contradictions: 0)
authority/host-neutral regression check: PASS (GO-NOT-YET/off/local-lifecycle, hosts=2, lanes=8, locks=4)
```

## Diff Notes

- Expected provenance consistency matches actual: the stale `.worktrees/B-688d` references are absent from the repaired B-688d artifacts, and dependent artifacts now have a non-inverted `generatedAt`.
- Expected failure semantics match actual: five expected-PASS baseline runs remain `FAIL` with `blockedReason=local independent review evidence is missing`; contradictory terminal-criteria wording is absent.
- Expected Authority / host-neutral boundary matches actual: no Authority receipt claim was added, `GO-NOT-YET` is preserved, and the 2-host / 8-lane / 4-lock shape is unchanged.
- No product claim was upgraded from local lifecycle evidence to Authority-backed evidence.
