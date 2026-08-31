# B-5952 Execution Plan

## CHK-001 — Restore a bounded instrumentation ceiling for the current source inventory

1. Preserve an absolute finite dynamic-binding build ceiling and change only its explicit value in `packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts`, choosing a small bound above the independently reproduced 804 baseline and no greater than 850.
2. Rebuild `packages/main` so `packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js` is generated from the source of truth; never edit dist independently.
3. Run the targeted smoke twice at unchanged HEAD and verify its PASS transcript reports the measured build count.
4. Exercise the finite boundary and a below-baseline mutation in an isolated temporary copy; ceiling+1 and a ceiling below 804 must fail with the bounded diagnostic.
5. Verify source/dist binding, scope contract compliance, and zero diff for `docs/requirements/decisions/dynamic-finding-system-execution-plan.md`.

Rollback: revert the source assertion commit and rebuild dist. No runtime migration or production state is involved.
