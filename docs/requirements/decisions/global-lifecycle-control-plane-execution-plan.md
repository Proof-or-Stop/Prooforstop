# Global Lifecycle Control Plane Execution Plan

## Purpose

Add a compatibility-first source layout for future global lifecycle control work without changing runtime behavior. This plan keeps the first step structural: new import paths, read-only status types, and a migration constant that future stories can consume.

## Source Layout

Recommended lifecycle-control source layout:

```text
packages/main/src/core/lifecycle-control/
  index.ts       # public structural entrypoint
  types.ts       # read-only status and capability types
  milestones.ts  # five-milestone migration constant
```

Recommended evidence compatibility entrypoints:

```text
packages/main/src/core/evidence/artifact/index.ts
packages/main/src/core/evidence/storage/index.ts
packages/main/src/core/evidence/repro/index.ts
packages/main/src/core/evidence/admissibility/index.ts
```

These entrypoints are adapters over existing modules. They must not duplicate artifact storage, repro workflow implementation, proof admissibility registries, proof definitions, or gate helpers.

## Read-Only Status Types

`StoryControlStatus` is the story-scoped projection shape. It carries the story id, optional phase/title, read-only `ControlPlaneCapabilities`, lane statuses, queue classification, and optional CP-2 projection metadata.

`ProjectControlStatus` is the project-scoped projection shape. It aggregates story statuses, project-level lanes, queue classifications, and the same read-only capability declaration.

Lane status values are descriptive only. Queue classifications are descriptive only. Neither type writes evidence, registers commands, mutates gates, advances stories, or cleans queues.

## CP-2 Projection

CP-2 projects legacy lifecycle data into `StoryControlStatus` and `ProjectControlStatus`.

The projection is read-only and side-effect free. It may classify status, lanes, and queues, but it does not produce verification evidence, DONE evidence, Authority receipts, proof decisions, or lifecycle gate outcomes.

## Milestones

1. CP-1: Compatibility-first source structure.
2. CP-2: Read-only control status projection.
3. CP-3: Host-facing read-only surfacing.
4. CP-4: Control-plane readiness checks.
5. CP-5: Separated enforcement tracks.

CP-5 is explicitly split:

- CP-5A: Proof and Authority enforcement track.
- CP-5B: Queue and cleanup enforcement track.

CP-5A and CP-5B must remain separate so production proof semantics cannot be introduced as a side effect of queue cleanup, and cleanup enforcement cannot be introduced as a side effect of Authority or Proof M7 work.

## Non-Goals

- No `global_control_status` CLI runtime behavior.
- No CLI command registration in CP-1.
- No lifecycle gate changes.
- No evidence writes.
- No Proof M7 enforcement.
- No Authority production semantics.
- No queue cleanup enforcement.
- No Tier-C cleanup.
