# V17 integration log

Historical before/after measurements in REPORT.md are frozen at a7393908f9. This file records subsequent integration separately. This is a local Lab candidate, not release evidence.

## Inputs

- Lab checkpoint: a7393908f98a946d965f9a0fb6531648b70950e4
- Main merge input: 33e7408c580d174329f71b977b73bab00a569262
- Product manifests inherited main 0.3.311; V17 is the Lab evidence revision, not an invented product release.

## Conflict inventory

|Path|Conflict hunks|Current resolution status|
|---|---:|---|
|docs/validation-performance.md|1|Source combined; semantic regressions and independent audit required|
|packages/main/src/cli/command-catalog.ts|1|Source combined; semantic regressions and independent audit required|
|packages/main/src/core/certification-window.ts|3|Source combined; semantic regressions and independent audit required|
|packages/main/src/core/evidence-freshness.ts|4|Source combined; semantic regressions and independent audit required|
|packages/main/src/core/process-fact-levels.ts|1|Source combined; semantic regressions and independent audit required|
|packages/main/src/core/process-fact-registry.ts|7|Source combined; semantic regressions and independent audit required|
|packages/main/src/core/runtime-environment-checks.ts|1|Source combined; semantic regressions and independent audit required|
|packages/main/src/core/shared-validation-execution.ts|3|Source combined; semantic regressions and independent audit required|
|packages/main/src/core/store.ts|1|Source combined; semantic regressions and independent audit required|
|packages/main/src/core/story-aware-validation.ts|1|Source combined; semantic regressions and independent audit required|
|packages/main/src/core/validation-artifact-signing.ts|1|Source combined; semantic regressions and independent audit required|
|packages/main/src/core/validation-execution-lock.ts|2|Source combined; semantic regressions and independent audit required|
|packages/main/src/core/validation-executor.ts|3|Source combined; semantic regressions and independent audit required|
|packages/main/src/core/validation-types.ts|1|Source combined; semantic regressions and independent audit required|
|packages/main/src/handlers/certification-window.ts|4|Source combined; semantic regressions and independent audit required|
|packages/main/src/handlers/doctor.ts|1|Source combined; semantic regressions and independent audit required|
|packages/main/src/handlers/done-required-validation.ts|4|Source combined; semantic regressions and independent audit required|
|packages/main/src/handlers/proofstory.ts|1|Source combined; semantic regressions and independent audit required|
|packages/main/src/handlers/story-aware-validation.ts|2|Source combined; semantic regressions and independent audit required|
|packages/main/src/handlers/verifier.ts|3|Source combined; semantic regressions and independent audit required|
|packages/main/src/tasks/certification-window-smoke.ts|1|Source combined; semantic regressions and independent audit required|
|packages/main/src/tasks/review-inventory-handler-smoke.ts|1|Source combined; semantic regressions and independent audit required|
|packages/main/src/tasks/verification-freshness-smoke.ts|3|Source combined; semantic regressions and independent audit required|
|scripts/verify-process-fact-contract.mjs|3|Source combined; semantic regressions and independent audit required|

## Chronological evidence

- First merge: 24 conflict files. Complete conflicting sides preserved in conflicts.json outside the checkout.
- First/second builds exposed type/import merge errors; corrected. Subsequent official build succeeded.
- Initial test matrix: stage-entry and new main lease-loss checks passed; old cache fault injection was bypassed by new warm memo; abort cancellation precedence failed; wrong fixture wrapper was refused (not a product RED).
- Corrected physical-read harness disables persistent memo through an explicit replacement namespace; repeated physical reads RED, shared scoped read GREEN. Coherent HEAD control already passed the first merged runtime and remains GREEN.
- Cancellation now checked before nested lock admission; identical main abort test RED to GREEN. Machine resource and stage guards retained.
- New main material memo, Story memo boundaries and as-of regression passed.
- Claude initial merge audit found consumed-inventory recovery blockage, contradictory DONE-required contract assertion and stale executable pins. Complete audit retained; no full approval claimed.
- Synthetic signed consumed-saturation projection RED to GREEN, with foreign/partial/unequal-time/tamper controls. Real complete recovery lifecycle still requires follow-up.
- Old reuse smoke reached original dirty/forged metadata exit mismatch after seeding current fixture prerequisites. Expected failure exit corrected; byte preservation, zero additional execution and failed activity assertions remain.
- Freshness fixture duplicate leases, reacquisition in the no-owner negative, missing PRE_CERT prerequisite and forced TEST phase conflicted with existing DEV-to-REVIEW proof; targeted fixture corrections in progress.
- Pin proposal initially computed TS digests incorrectly; that diagnostic is retained as pin-ts-diagnostic-not-runtime.json. Correct executable-JS computation requires only freshness and inventory pins; checklist and verification execution pins remain unchanged.
- Historical table preservation verified byte-for-byte against checkpoint, frozen copy and SHA256; altered bytes fail the comparison.

## Status

Validation is in progress. No tag, remote push, release or main mutation performed by this task. Do not read a completed individual check as whole-candidate approval.

## Candidate checkpoint (not GREEN)

- Claude pin review approved exactly three updates: two compiled-JS executable pins plus the child-environment source digest. Added the requested executable-only Git observation delegate binding and a real tamper/refusal/restored-control test.
- Corrected the signed command-mutation fixture: unsigned mutation must fail signature verification; a separately signed wrong-command fixture must reach the semantic command mismatch.
- Updated scope fixture prerequisites without weakening its missing-contract / zero-launch assertions.
- Moved the process contract final verdict after all checks so late appended checks cannot be lost, and registered consumed-saturation and delegate-binding controls in existing contract commands.
- This commit is an integration candidate. Full recovery integration, several legacy fixture combinations, current whole-workload comparisons and final independent audit remain outstanding. No release or overall GREEN is claimed.
