## B-88ae Execution Plan

Goal: implement the recommended source structure as a compatibility-first structural slice. This story does not move the full implementation or change lifecycle/proof behavior.

Milestones:

1. M1 Evidence artifact/storage entrypoints: add `packages/main/src/core/evidence/artifact/index.ts` and `packages/main/src/core/evidence/storage/index.ts` as compatibility entrypoints over existing artifact storage primitives.
2. M2 Evidence repro/admissibility entrypoints: add `packages/main/src/core/evidence/repro/index.ts` and `packages/main/src/core/evidence/admissibility/index.ts` so new code can import from canonical paths while legacy flat modules still work.
3. M3 Lifecycle-control skeleton: add read-only status types and projection entrypoints under `packages/main/src/core/lifecycle-control`. No CLI command, no gate mutation, no evidence writes.
4. M4 Focused source-structure smoke: add `source-structure-convergence-smoke.ts` to prove new and legacy imports resolve to the same representative symbols and that lifecycle-control skeleton is read-only shape.
5. M5 Build and compatibility verification: run build plus focused smoke, proof-admissibility smoke, and repro-first candidate smoke.

Non-goals: no `global_control_status` command behavior, no Proof M7 enforcement changes, no Authority production semantics, no queue cleanup enforcement, no Tier-C bulk cleanup.

## CHK-001

Implement evidence artifact/repro/admissibility directory entrypoints as compatibility adapters.

Concrete mapping:

- `core/evidence/artifact/index.ts` re-exports existing artifact storage primitives from `core/evidence/artifact-store.ts` and evidence types from `core/evidence/types.ts`.
- `core/evidence/storage/index.ts` re-exports the same storage primitives for the future storage namespace.
- `core/evidence/repro/index.ts` re-exports existing ReproIntakeService functions/types from `core/repro-intake.ts` plus the candidate evidence types.
- `core/evidence/admissibility/index.ts` re-exports existing proof admissibility API from `core/proof-admissibility.ts` and helper modules where appropriate.

Acceptance signal: TypeScript can import representative symbols from all new paths and from legacy paths in the same smoke. The smoke asserts key registry/function references are shared, not copied.

## CHK-002

Implement lifecycle-control skeleton and control status types.

Files:

- `core/lifecycle-control/control-status.ts`: defines `ControlPlaneCapabilities`, `StoryControlStatus`, `ProjectControlStatus`, lane status enums, queue classifications, and milestone constants.
- `core/lifecycle-control/index.ts`: public re-export.
- `core/lifecycle-control/runtime/index.ts`, `consumption/index.ts`, `queue/index.ts`, `dashboard/index.ts`: namespace entrypoints that export types only or typed placeholder projectors.

Rules:

- These modules are read-only skeletons.
- They must not register commands.
- They must not write `.lattice/evidence` or story metadata.
- They must not import concrete receipt verifiers or implement Proof M7.

Acceptance signal: a smoke imports the lifecycle-control types and verifies the exported milestone list preserves the 5-step structural migration plan.

## CHK-003

Add focused smoke coverage and npm script.

Implementation:

- Add `packages/main/src/tasks/source-structure-convergence-smoke.ts`.
- Add `test:source-structure-convergence` script in `packages/main/package.json`.
- Smoke checks new path imports, legacy path imports, representative shared identity, and lifecycle-control skeleton constants.

Verification commands:

```bash
npm --prefix packages/main run build
node packages/main/dist/tasks/source-structure-convergence-smoke.js
node packages/main/dist/tasks/proof-admissibility-smoke.js
node packages/main/dist/tasks/repro-first-candidate-smoke.js
```

Completion message expected from focused smoke:

```text
source-structure convergence smoke passed
```

## Remaining Migration After This Story

This story completes milestone 1 of the broader structure migration: canonical paths and compatibility adapters. Later stories can move implementation bodies behind those paths, update broad callsites, implement control-plane runtime reports, and only then consider runtime/queue enforcement. This story must not claim that the full Global Lifecycle Control Plane is implemented.
