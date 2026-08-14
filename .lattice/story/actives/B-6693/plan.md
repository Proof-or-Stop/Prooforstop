# Workspace Validation Capacity Lease — Implementation Plan

## Decision summary

Implement an outer workspace-wide capacity lease for official validation and keep the existing per-story validation execution lock as the inner evidence-serialization lock. The canonical acquisition order is always workspace capacity → story evidence. The canonical path is derived from the git common directory, so main and linked worktrees contend, while independent repositories do not. Direct npm test remains outside this boundary.

## Invariants

- Protected entrypoints: lattice validate with or without a Story ID, and lattice done_required_validate.
- Unprotected entrypoint: direct npm test or a direct full-suite runner invocation.
- Only one protected validation callback may execute per git-common-dir workspace.
- A contender waits asynchronously, emits bounded stderr/log progress, and starts automatically after release.
- Workspace capacity is acquired before the existing story evidence lock; reverse order is forbidden.
- Commands, timeouts, full-suite thresholds, evidence schemas, freshness predicates, and routine/DONE-required separation remain unchanged.
- Abort or deadline while waiting fails before validation callback entry.
- Release is ownership checked and occurs after success, throw, and cooperative abort cleanup.
- Stale reclaim uses existing heartbeat, PID, process-start, host, and age classification; active or unknown holders are never removed optimistically.

## CHK-001 — Acquire a shared workspace validation capacity lease before story validation

1. Extend packages/main/src/core/validation-execution-lock.ts with validationCapacityLockPath(root) under the shared git-common-dir lock root, separate from validationExecutionLockPath(root, storyId).
2. Reuse one ownership-aware lock runner so capacity and story locks share holder identity, 2-second heartbeat, 120-second stale classification, safe reclaim, AsyncLocalStorage reentrancy, and ownership-checked release.
3. Add an asynchronous capacity acquisition loop. Each mkdir attempt is fail-fast; contention delays with an awaited timer rather than synchronous polling. Inputs include abortSignal, deadlineAt, deadlineError, bounded retry interval, and bounded progress callback.
4. The first and periodic contention messages contain the stable phrase "waiting for workspace validation capacity" plus holder command/story, PID/host when available, and heartbeat age. Acquisition emits a continuation message before callback entry.
5. Export an official wrapper that always acquires capacity and conditionally acquires the current story lock. This mechanically enforces workspace → story order and covers no-story validate.
6. Replace all routine validate branches in packages/main/src/handlers/verifier.ts with the official wrapper, including no-validator, configured/fallback command, and validate-file paths. Pass existing abort/deadline inputs and ctx.log for wait progress.
7. Replace the DONE-required wrapper in packages/main/src/handlers/done-required-validation.ts with the same official wrapper and inputs.

Acceptance: linked worktrees resolve one capacity path; a second callback stays outside until release; it then starts automatically; independent repositories do not contend; no-story validate contends with story-aware validate and DONE-required validation.

## CHK-002 — Prove cross-story wait-and-run, stale recovery, reentrancy, and release behavior

Extend packages/main/src/tasks/validate-execution-lock-smoke.ts with deterministic short cases:

1. Different Story IDs in linked worktrees: A holds capacity; B reports its holder, remains outside, then runs after release.
2. Validate versus DONE-required: both finish in order and each retains its normal result/evidence.
3. No-story validate versus story validate: they share capacity.
4. Holder heartbeat advances while a contender waits, proving polling does not block the event loop.
5. First wait output is prompt, periodic output is rate-limited, holder fields are present, and JSON stdout stays clean.
6. A provably dead holder is reclaimed; a live or unknown holder is not.
7. Same-context nesting is reentrant for both capacity and story locks.
8. A waiter proceeds after callback success or throw; abort/deadline during wait never enters its callback.
9. The official wrapper acquires capacity before any story lock; no production caller reverses this.
10. Separate git common directories remain concurrent.

Negative proof: fail-fast contention is not success; a waiter that never runs after release fails; active/unknown reclaim fails; progress text on JSON stdout fails.

## CHK-003 — Prove official validation gates retain their existing commands and budgets

1. Add CLI help text in packages/main/src/cli/command-catalog.ts stating that validate and done_required_validate use the workspace lease, contenders wait then run, and bare npm test is outside the lease.
2. Update docs/CLI.md, docs/requirements/decisions/testing-infra.md, and docs/requirements/decisions/done-full-test-gate-execution-plan.md with the same boundary and global → story order.
3. Add focused contract assertions that coordination does not rewrite validation command inventories or timeout configuration.
4. Build and run the focused lock smoke, then routine lattice validate --story=B-6693.
5. Run canonical root npm test only when no other official validation is active. Preserve 47/47 inventory, current member timeouts, milestone/flow thresholds, and strict under-300-second proof.
6. Run lattice done_required_validate --storyId=B-6693 through the lease and confirm separate fresh evidence remains accepted by DONE.

Non-goals: no timeout increases, validation inventory changes, scheduler changes, arbitrary shell interception, cross-clone distributed lock, story owner lease replacement, or main-write-lock replacement.

## Delivery order

1. Record independent adversarial verification intent.
2. Implement core capacity lease and official entrypoint wiring.
3. Add concurrency/stale/abort/reentrancy/boundary smokes.
4. Update CLI help and documentation.
5. Record focused evidence and independent implementation/coverage review.
6. Run routine and canonical DONE-required validation without competing direct full-suite processes.
7. Complete with done_prepare and DONE, then return to B-6f23 and B-d0b8 so their cold closeout proofs run under this mechanism.
