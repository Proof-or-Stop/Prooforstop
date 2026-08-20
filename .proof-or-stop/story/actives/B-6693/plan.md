# Workspace Validation Capacity Lease — Revised Implementation Plan

## Decision summary

Add an outer async workspace capacity lease for every official validation mode and retain the legacy per-story evidence lock inside it. The order is always workspace capacity → story evidence. Capacity uses a stricter liveness classifier than the legacy story lock: age or malformed/unknown ownership alone never authorizes reclaim.

## Invariants

- Protected: lattice validate with or without story ID, including --channel, --concept, --lint, no-validator, configured/fallback, and validate-file branches; plus lattice done_required_validate.
- Unprotected: direct npm test or direct full-suite invocation.
- Only one protected validation callback executes per git-common-dir workspace.
- Wait is asynchronous, visible on stderr/log side channel, rate-bounded, abortable, and automatically continues after release.
- Capacity is acquired before the existing story evidence lock. The story lock keeps its current compatibility semantics.
- Capacity stale reclaim requires mechanical proof: local PID dead, process-start identity mismatch, or holder/heartbeat identity mismatch. Unknown or malformed ownership stays blocked even when old.
- Commands, inventories, 120/180/300-second proof budgets, evidence formats, freshness, and routine/DONE-required separation are unchanged.
- Runtime artifact registry already covers .lattice/locks; doctor, runtime registry, and process-fact registry are out of scope.

## CHK-001 — Acquire a shared workspace validation capacity lease before story validation

1. In packages/main/src/core/validation-execution-lock.ts add validationCapacityLockPath(root), canonicalized by git common dir and separate from the <storyId>.lock path.
2. Add a capacity-specific classifier. It must not reuse the age-first return in classifyValidationExecutionLock. Known local-dead or identity-mismatched holders may be stale; live, remote-indeterminate, missing, or malformed ownership must remain active/blocked. Do not change legacy story-lock classification.
3. Add async capacity acquisition built from fail-fast mkdir attempts plus awaited abortable delays. Never call synchronous waiting or Atomics.wait.
4. Add bounded wait progress with the stable phrase "waiting for workspace validation capacity", holder command/story, PID/host where available, and heartbeat age. Progress goes only to callback/log/stderr.
5. Reuse holder token, 2-second heartbeat, AsyncLocalStorage ownership, safe release, and nested-owner reentrancy. Reentrancy is context-local, never process-wide.
6. Export one official wrapper that always acquires capacity and conditionally acquires the inner story lock.
7. In packages/main/src/handlers/verifier.ts put the capacity boundary before all validate branch returns, explicitly including --channel/--concept/--lint. Pass abortSignal, deadlineAt, deadlineError, and ctx.log. Story-aware work then acquires the existing inner lock.
8. In packages/main/src/handlers/done-required-validation.ts use the same official wrapper and pass the same cancellation/log inputs.

Acceptance: linked worktrees and no-story/selective modes share one capacity path; independent repositories do not; the second callback waits and automatically enters only after complete first-handler release.

## CHK-002 — Prove cross-story wait-and-run, stale recovery, reentrancy, and release behavior

Extend packages/main/src/tasks/validate-execution-lock-smoke.ts with a fast --workspace-capacity-contract-only path and full integration coverage:

1. Different-story linked-worktree A/B: B stays outside, reports A, then runs and persists its own result after A releases.
2. Validate ↔ done_required_validate in both orders.
3. No-story validate ↔ story validate and real CLI --channel/--concept/--lint selective modes; none may bypass an active holder.
4. Heartbeat advances and independent event-loop timer fires while one or more callers wait.
5. Abort/deadline during wait never enters callback or inner story lock.
6. Nested same AsyncLocal owner is reentrant; independent same-process and cross-process siblings remain queued.
7. Success and throw release; queued successors enter exactly once and preserve original failure truth.
8. Multiple waiters remain maxConcurrency=1, eventually run, and do not flood progress.
9. Capacity covers child execution plus evidence persistence.
10. Capacity-specific stale tests reverse the legacy ownerless-age expectation: old unknown/malformed/live holders are not reclaimed; only mechanically proven dead or identity-mismatched holders are. Existing story-lock legacy assertion remains scoped to story lock.
11. Linked worktrees serialize; independent repositories overlap.
12. JSON stdout stays parseable; wait progress is stderr-only.
13. Source contract asserts every production validate return path is under the capacity wrapper and the wrapper order is capacity then story.

Negative proof: fail-fast, wait-forever, age-only reclaim, selective-mode bypass, process-wide reentrancy, evidence overlap, or stdout pollution fails.

## CHK-003 — Prove official validation gates retain their existing commands and budgets

1. In packages/main/src/cli/command-catalog.ts update both command descriptions/help to state workspace waiting and that bare npm test is outside the lease. No cli-prompts.ts change is required because the catalog descriptions are rendered by both --help commands.
2. Update docs/CLI.md, docs/requirements/decisions/testing-infra.md, and docs/requirements/decisions/done-full-test-gate-execution-plan.md with official-only boundary, global→story order, strict unknown-holder behavior, and bare npm warning.
3. Focused smoke snapshots command labels/args/timeoutMs and asserts no rewrite; representative read-only session_brief/story_get/checklist_get remain unlocked.
4. Assert no diff to lattice.config.json, package.json, packages/main/package.json, full-suite-runner.ts, or full-suite-runner-smoke.ts.
5. Build, run fast capacity contract, then full lock smoke.
6. After competing external validation ends, run routine lattice validate --story=B-6693 and canonical root npm test; retain 47/47 inventory and existing thresholds.
7. Run lattice done_required_validate --storyId=B-6693 and prove its separate fresh evidence remains accepted.

## Delivery order

Independent intent → revised independent scope pass → DEV implementation → focused proof/evidence → independent implementation and coverage review → routine validate → DONE-required validate → done_prepare → DONE. Then use the merged capacity mechanism to close B-6f23 and B-d0b8 without concurrent official validation.
