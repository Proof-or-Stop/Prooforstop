# Control-Plane And Proof Capability Closure Audit

Status: active closure audit for B-c004.

B-c004 resolves exactly the seven accepted capability rows below. A row is not
closed by status text alone: each row must name an evidence target and an action
that is implemented, already covered, or explicitly retired as a non-goal.

| Milestone | Checklist | Capability row | Closure status | Evidence target | Action |
|---|---|---|---|---|---|
| M1 | CHK-001 | Seven-row closure ledger and coverage audit | implemented | `docs/requirements/decisions/control-plane-proof-capability-closure-audit.md`; `packages/main/src/tasks/lifecycle-control-smoke.ts`; `packages/main/src/tasks/proof-admissibility-hardening-smoke.ts` | Freeze this table and guard that M1-M7 appear exactly once with evidence. |
| M2 | CHK-002 | Retired Authority vocabulary and backlog language | implemented | `docs/requirements/decisions/authority-server-vocabulary-retirement.md`; `packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts` | Active future backlog wording is retired in the control-plane and proof plans; legacy wording remains only inside explicit quarantine. |
| M3 | CHK-003 | Tier-C cleanup policy | implemented | `packages/main/src/core/lifecycle-control/queue/index.ts`; `packages/main/src/tasks/lifecycle-control-smoke.ts` | Preserve valid Tier-C provider-execution experiment evidence and classify malformed Tier-C-like rows as cleanup-required. |
| M4 | CHK-004 | Append-only admissibility ledger | retired/non-goal | `docs/requirements/decisions/proof-admissibility-hardening-execution-plan.md`; `packages/main/src/tasks/proof-admissibility-hardening-smoke.ts` | Durable ledger storage is explicitly retired for the local CLI; tests guard that no ledger writer/path/rows are claimed by the diagnostic waterline. |
| M5 | CHK-005 | Queue cleanup enforcement guard | implemented | `packages/main/src/core/lifecycle-control/queue/index.ts`; `packages/main/src/core/lifecycle-control/control-status.ts`; `packages/main/src/tasks/lifecycle-control-smoke.ts` | Surface duplicate, superseded, and cleanup-required rows without deleting stories; preserve experiment exceptions. |
| M6 | CHK-006 | Runtime closure enforce rollout | implemented | `packages/main/src/core/lifecycle-control/runtime/index.ts`; `packages/main/src/handlers/transition-orchestrator.ts`; `packages/main/src/tasks/lifecycle-control-smoke.ts` | Keep warn mode diagnostic; enforce mode blocks unsafe runtime closure conditions and reports rollback to warn. |
| M7 | CHK-007 | CommandSpec envelope and project waterline coverage | missing-to-implement | `packages/main/src/core/evidence/types.ts`; `packages/main/src/core/lifecycle-control/consumption/index.ts`; `packages/main/src/tasks/proof-admissibility-hardening-smoke.ts`; `packages/main/src/tasks/lifecycle-control-smoke.ts` | Prove command-backed evidence either carries structured `CommandSpec` or is diagnostic/non-goal, and make project waterline no-data distinct from pass. |

## Closure Rules

- M1-M7 are the complete B-c004 scope.
- A missing-to-implement row must become implemented, already-covered, or
  retired/non-goal before DONE.
- Retired/non-goal rows must be named as such in docs and tests; partial runtime
  support must not be called complete.
- This audit does not reintroduce server-backed Authority runtime,
  conformance, or production completion.
