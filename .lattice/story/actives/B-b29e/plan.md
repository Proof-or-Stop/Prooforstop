# Plan — B-b29e: register the parallel-decomposition DEV gate in lifecycle + process-fact metadata

Descriptive-metadata sync only — no runtime change. The machine.ts gate (B-086b) is the source of truth; the registries are reconciled TO it.

## CHK-001 — lifecycle-registry.ts: register on the 4 runtime DEV doors
First MAP the to:DEV LIFECYCLE_TRANSITIONS to the runtime START->DEV doors: confirm INIT_CHECK->DEV (~156, gates [quick-path]), PLAN->DEV (~166, [plan-review,scope-check,cwd-worktree]), REVIEW->DEV (~206, [cwd-worktree]), TEST->DEV (~226, [cwd-worktree]) are the four guarded doors (canSkipPlanGuard / canStartDevGuard / canReenterDevGuard x2). Inspect the other to:DEV entries (~247/269, gates []) — register the gate ONLY on transitions that are real runtime START->DEV doors. Add a kebab-case gate id 'parallel-decomposition' to those four gates arrays (and oracleRows if siblings like plan-review/scope-check carry one). Do NOT add it to non-runtime-door entries.

## CHK-002 — process-fact-levels.ts: scope-contract-fact consumer
Add the parallel DEV-entry gate as a consumer of the scope_contract_set / scope_contract_init_from_plan facts (machine.ts reads scope contracts before every DEV entry), matching the existing consumer-registration shape/level. Additive — do not alter other fact consumers.

## CHK-003 — verify-process-fact-contract.mjs: assert the guard surface
Extend the drift check to assert the parallel DEV-entry gate (the canSkipPlan/canReenterDev/parallelDevEntryBlock surface) is registered as a scope-contract-fact consumer, reading the ACTUAL registration so it FAILS if the gate is removed. Run via `npm --prefix . run test:process-fact-contract`. Prove it is non-vacuous by temporarily removing the registration (check fails) then restoring (passes).

## CHK-004 — doc note
Add a short note to docs/parallel-decomposition-spec.md §8 recording the registration on the 4 DEV doors + the process-fact consumer + the drift-check assertion, closing the descriptive-contract loop from Story 5 (B-086b).

## Verification
`npm --prefix . run test:process-fact-contract` passes with the new assertion; `lattice validate` stays all-green; the integration smoke (unchanged) proves runtime behavior is unaffected. userSees: the drift check prints its pass line including the parallel-gate assertion, and the lifecycle/process-fact metadata lists the gate on the 4 DEV doors.
