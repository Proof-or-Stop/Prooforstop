# Implementation Plan

## CHK-001

Add a focused `review-assurance-floor` core evaluator and a separate DONE oracle row. Do not fold the floor into the existing first-round `review-escalation` predicate, because they are different lifecycle claims. Classify material code diffs from the git diff against main; source/runtime/test/script/package files count as material code, while markdown-only docs changes do not. For material code diffs, require at least one fresh current-material review assurance record before DONE.

Verification: the smoke task will create synthetic stories proving zero-review material code is blocked, one fresh local review round passes, and docs-only markdown is not overblocked.

## CHK-002

Add failure-signal escalation to the new floor evaluator while reusing existing `evaluateHostVerdictRounds` host binding logic. Durable signals include validation failure evidence, bug evidence, verified reviewer findings, and repeated rework signals that are available in story/process artifacts. When such a signal exists for a material code diff, require three fresh local single-host rounds unless the existing stronger 3x2 escalation is required and satisfied separately.

Verification: the smoke task will prove failure-triggered 3x1 is sticky after repair and stale/missing materialDigest verdicts do not count.

## CHK-003

Preserve host-neutral and Authority boundaries. Local assurance evidence must report `authorityDone=false`, `fullAuthorityDone=false`, and `productionDone=false`. A degraded 3x1 result must be labeled `degraded-single-host`, not two-host independent or Authority receipt-backed. Register the new floor predicate as an L4 gate-consumed process fact and update the process-fact contract.

Verification: the smoke task and process-fact contract will assert the local reports keep Authority flags false and the new DONE gate is registered as a gate-consumed process fact.

## CHK-004

Expose actionable diagnostics in the DONE checklist and machine guard failure reason. The blocked output should say whether the story is missing the one-round floor, missing 3x1 rounds, has stale material hashes, or lacks host binding fields. Add a focused smoke task under `packages/main/src/tasks/` and record the exact command as verification evidence.

Verification: run the new smoke task, `scripts/verify-process-fact-contract.mjs`, package build, and `lattice validate` before DONE.

## Out of Scope

No Authority Server changes. No global artifact isolation framework. No external project template dumping. No unrelated active story edits. No `.omx` usage.
