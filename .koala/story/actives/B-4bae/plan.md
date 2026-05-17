# Plan

## CHK-001

Update `checkConvergence` in `packages/main/src/tasks/gap-analyze.ts` so `phase === META` stories are excluded from the `所有 Story 完成` active story list. Add a separate audit backlog check for `B-META-framework-audit` open findings. The check should pass unless there is an open finding with `evidenceState` missing/verified and severity `high` or `critical`. Detail should still surface open audit backlog counts so advisory findings remain visible. Extend `packages/main/src/tasks/convergence-discarded-smoke.ts` to build a temp repo containing DONE, DISCARDED, META, and INIT stories, plus synthetic audit findings covering suspected, low/medium verified, and high/critical verified cases.

## CHK-002

Use `koala finding_resolve` for `B-META-framework-audit:F-004` after confirming the B-4c38 merge commit `7350e9df` is present. Do not change F-001, F-002, F-003, F-005, F-006 or any INIT backlog story state. Verify with `koala finding_list` and `koala convergence_check`.
