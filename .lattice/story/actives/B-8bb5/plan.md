# B-8bb5 Plan

## CHK-001

Goal: make the default phase gate accept `finding_cluster` in DEV when reviewer findings are already actionable.

Implementation steps:
- Edit `packages/main/src/core/config.ts` only enough to add `finding_cluster` to the DEV default phaseTools list.
- Keep `finding_cluster` in REVIEW and TEST unchanged.
- Do not move it to the global all-phase list, because INIT/PLAN clustering is outside the observed workflow.

Verification:
- `packages/main/src/tasks/flow-stability-smoke.ts` asserts DEV, REVIEW, and TEST all allow `finding_cluster`.
- It also asserts custom project phaseTools can still block `finding_cluster`, preserving explicit overrides.

Negative boundary:
- Confirm unrelated gated commands such as `bug_report` remain blocked in DEV by default.

## CHK-002

Goal: prevent the SimCell B-cacf failure mode from returning: a DEV story with reviewer findings must be able to run cluster maintenance before dispatching grouped fixes.

Implementation steps:
- Extend existing flow-stability smoke coverage near the current DEV reviewer command assertions.
- Extend the process-fact contract script so the L2 `finding_cluster` registry entry and DEV phaseTools cannot drift apart.

Verification:
- `npm --prefix packages/main run test:flow-stability-smoke` passes.
- `npm run test:process-fact-contract` passes and would fail if DEV allows `finding_add` / `finding_dispatch` but not `finding_cluster`.

Negative boundary:
- The contract should not imply that all L2 commands are globally available. It only protects this specific reviewer finding workflow consistency rule.
