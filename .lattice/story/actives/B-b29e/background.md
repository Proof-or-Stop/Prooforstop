## Trigger Event

During REVIEW of parallel-decomposition program Story 5 (B-086b, merged 2026-06-20, commit 2481cbbc4), Codex host-2 raised two findings (F-009, F-010) that the operator deferred to a dedicated follow-up: the descriptive lifecycle/process-fact contract registries do not record the new parallel-decomposition DEV gate, and verify-process-fact-contract.mjs does not assert it. The runtime gate itself was verified complete and correct by both hosts and is live on main.

## Key Insight

These registries are DESCRIPTIVE, not load-bearing: the actual DEV-entry enforcement is the machine.ts xstate guards (canStartDevGuard/canSkipPlanGuard/canReenterDevGuard via parallelDevEntryBlock), which are the source of truth. lifecycle-registry.ts LIFECYCLE_TRANSITIONS.gates and process-fact-levels.ts are read by audits/projections and the verify-process-fact-contract.mjs drift check (a separate script, not in lattice validate, currently passing). So this story does NOT change runtime behavior — it makes the documentation/contract registries match what machine.ts already does, and extends the drift check so the gate is mechanically protected from future divergence. Nothing about the gate's enforcement, fail-open, or mode semantics changes.

## Tradeoff

Sync-now vs leave-stale: leaving the registries stale means audits/projections under-report the gate and the drift check cannot catch future regressions of it; syncing keeps the contract honest at the cost of touching two core metadata files + one CI script. We sync. Extend-the-existing-check vs add-a-new-smoke: verify-process-fact-contract.mjs already exists as the drift gate, so we EXTEND it (assert canSkipPlan/canReenterDev/parallelDevEntryBlock as consumers) rather than introduce a parallel test surface, keeping one source of drift-truth.

## Conversation Texture

The operator explicitly chose 'another follow-up story' over expanding S5's scope mid-REVIEW, to keep S5's reviewed boundary clean. This story is that follow-up. It must go through the full Lattice workflow with genuine Claude+Codex full-3x2 dual-host review like the rest of the program. The gate's runtime impl in machine.ts (B-086b) is authoritative; the metadata must be reconciled TO it, never the reverse.
