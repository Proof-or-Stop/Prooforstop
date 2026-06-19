# Implementation Plan

## CHK-001

Extend the existing `evaluateReviewEscalation` path into the Review Assurance Floor instead of adding a second DONE gate. Classify whether the story has a material code diff from the git diff against main; source/runtime/test/script/package files count as material code, while markdown-only docs changes do not. For material code diffs, require at least one fresh current-material local review evidence round before DONE. Keep `done-oracle` and `machine.canFinish` consuming the same evaluator.

Verification: the smoke task will create synthetic stories proving zero-review material code is blocked, one fresh local review round passes, and docs-only markdown is not overblocked.

## CHK-002

Add failure-signal escalation to the same evaluator. Durable signals include validation failure evidence, open or historical bug evidence, verified reviewer findings, post-DONE regression markers if present, and repeated rework signals available in story events/process events. When such a signal exists for a material code diff, require three fresh local single-host rounds unless the existing stronger 3x2 escalation is required and satisfied.

Verification: the smoke task will prove failure-triggered 3x1 is sticky after repair and stale/missing materialDigest verdicts do not count.

## CHK-003

Preserve host-neutral and Authority boundaries. Local assurance evidence must report `authorityDone=false`, `fullAuthorityDone=false`, and `productionDone=false`. A degraded 3x1 result must be labeled `degraded-single-host`, not two-host independent or Authority receipt-backed. Update process-fact registry/contract only if the gate semantics change in a way the registry must expose.

Verification: the smoke task and process-fact contract will assert the local reports keep Authority flags false and the new DONE gate is registered as a gate-consumed process fact.

## CHK-004

Expose actionable diagnostics in the DONE checklist and status report. The blocked output should say whether the story is missing one review round, missing 3x1 rounds, has stale material hashes, or lacks binding fields. Add a focused smoke task under `packages/main/src/tasks/` and wire it into package scripts only if the existing validation discovery needs it; otherwise record the exact command as verification evidence.

Verification: run the new smoke task, `scripts/verify-process-fact-contract.mjs`, package build, and `lattice validate` before DONE.

## Out of Scope

No Authority Server changes. No global artifact isolation framework. No external project template dumping. No unrelated active story edits. No `.omx` usage.
