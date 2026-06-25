# Global Lifecycle Control Plane Execution Plan

## Purpose

The global lifecycle control plane is a future read-only coordination layer over existing story lifecycle, evidence, review, runtime, and queue surfaces. B-88ae only establishes the compatibility-first source structure and status vocabulary. It must not change behavior.

This document is the authoritative source for CHK-002 source layout and control-status semantics.

## Source Layout

Recommended lifecycle-control layout:

```text
packages/main/src/core/lifecycle-control/
  index.ts                         # public structural entrypoint
  control-status.ts                # canonical public status/capability type module
  global-control-service.ts        # side-effect-free skeleton helpers/types
  milestones.ts                    # five-milestone structural migration constant
  runtime/index.ts                 # read-only runtime projection namespace
  consumption/index.ts             # CP-2 Consumption Closure Projection namespace
  queue/index.ts                   # read-only queue classification namespace
  dashboard/index.ts               # read-only dashboard/display namespace
```

Existing compatibility shims may remain, but `control-status.ts` owns the public status model. Namespace `index.ts` files may re-export canonical types and skeleton helpers; they must not register CLI commands, write evidence, mutate lifecycle gates, enforce Authority semantics, or perform cleanup.

Recommended evidence compatibility entrypoints:

```text
packages/main/src/core/evidence/artifact/index.ts
packages/main/src/core/evidence/storage/index.ts
packages/main/src/core/evidence/repro/index.ts
packages/main/src/core/evidence/admissibility/index.ts
```

These are adapters over existing modules. They must not duplicate artifact storage, repro workflow implementation, proof admissibility registries, proof definitions, or gate helpers.

## Layer Ownership And Data Flow

Layer ownership is intentionally narrow:

- `runtime/`: presents runtime and lifecycle observations as read-only data.
- `consumption/`: projects what existing lifecycle/evidence consumers can already see into status shapes.
- `queue/`: names queue classifications for visibility only.
- `dashboard/`: exposes display-ready status shapes without action semantics.
- `global-control-service.ts`: hosts side-effect-free construction/introspection helpers for those shapes.

Data flow is one-way:

```text
legacy story/evidence/review/runtime state
  -> CP-2 Consumption Closure Projection
  -> StoryControlStatus / ProjectControlStatus
  -> dashboard or host display
```

There is no reverse edge from dashboard/status back into lifecycle transitions, proof admissibility, Authority receipt handling, or queue cleanup.

## Status Model

`StoryControlStatus` is story-scoped. It carries:

- `storyId`, optional `phase`, and optional display title.
- `ControlPlaneCapabilities`, which must advertise read-only projection and false capability flags for command registration, gate mutation, evidence writes, Authority production semantics, Proof M7 enforcement, queue cleanup enforcement, and Tier-C cleanup.
- lane statuses describing lifecycle-control lanes.
- a queue classification.
- optional CP-2 projection metadata.

`ProjectControlStatus` is project-scoped. It aggregates `StoryControlStatus` entries plus project-level lane and queue summaries under the same read-only capability declaration.

Lane status values and queue classifications are descriptive. They do not advance stories, satisfy gates, write validation evidence, create receipts, or clean queues.

## CP-2 Consumption Closure Projection

CP-2 is a Consumption Closure Projection, not a second waterline implementation.

The projection asks: "Given the existing lifecycle/evidence/review/runtime consumers, what status can be read and displayed without adding new authority?" It may classify readiness, blockers, queues, and lane state based on existing material, but it cannot become a competing source of truth for TEST, DONE, proof admissibility, review quorum, or Authority.

CP-2 output is therefore status data only. It does not create verificationEvidence, DONE evidence, Authority receipts, production proof decisions, or lifecycle gate outcomes.

## Milestones

1. CP-1: Compatibility-first source structure.
2. CP-2: Consumption Closure Projection into read-only status.
3. CP-3: Host-facing read-only surfacing.
4. CP-4: Control-plane readiness diagnostics.
5. CP-5: Separated enforcement tracks.

CP-5 is split before any behavior work:

- CP-5A Runtime Enforcement: Proof M7, Authority semantics, and any gate-consumed runtime enforcement are designed, reviewed, and shipped independently.
- CP-5B Queue Governance Guard: queue policy, cleanup enforcement, and governance safety are designed, reviewed, and shipped independently.

CP-5A must not smuggle cleanup enforcement into proof/Authority work. CP-5B must not smuggle production proof semantics into queue governance.

## Non-Goals

- No `global_control_status` CLI runtime behavior.
- No CLI command registration.
- No lifecycle gate changes.
- No evidence writes.
- No Proof M7 enforcement.
- No Authority production semantics.
- No queue cleanup enforcement.
- No Tier-C cleanup.
- No second waterline implementation.
