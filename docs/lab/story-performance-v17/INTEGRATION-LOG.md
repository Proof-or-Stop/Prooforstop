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

## Latest remote-main integration

Fetched origin/main at `b715dd7b30f90add3c19dbc939a4f8cffd4b45b7` (0.3.314). Local main matched that exact commit. Managed Lab sync entered three conflicts: certification handler imports, process-fact registry declaration type, and process contract checks. Retained dynamic finding applicability, Lab recovery helpers, measured reuse boundaries, new complete registry mapping, and a single final failure verdict after all checks.

Official build passed. Scope-positive fixture now uses the recognized `scripts/` integration domain; unknown arbitrary paths were correctly refused by production. Freshness full smoke now passes, including missing-scope zero-launch and valid-scope one-launch controls. Historical table SHA-256 is unchanged. See POST-MERGE-VALIDATION.md for exact commands and results; timing is verification duration, not a performance claim. Independent Claude review is pending.

The user subsequently explicitly authorized GitHub publication, tag/release, and synchronized next patch version after current verification. The frozen historical report retains its original authorization snapshot; this entry records the later authorization. Release/tag notes must embed all 24 original comparison rows, not merely link to them.

Claude initial integration review requested changes: mutating certification entry points did not enforce active-identity pins, and preservation proof needed this merge identity. Added before-store checks to begin/cancel, a direct-handler tamper/restored-control regression, and latest-table-preservation.json binding candidate parent `d66ffc6a7abfdb17bfa412f23fa705b3e6fbf6f2` plus incoming main `b715dd7b30f90add3c19dbc939a4f8cffd4b45b7`. Actual RED reached STORE_TOUCHED before pin refusal. A later reuse-smoke case exposed semantic non-PASS becoming PASS during coverage decoration; normalize that result to fail before decoration. Old fixture now explicitly obtains another synthetic test admission before a new actual execution; consumed admission plus changed environment remains rejected with zero additional commands.

Post-fix results: full reuse smoke exit 0 (81.814 s), mutator pin test exit 0 (1.846 s), process contract exit 0 (10.369 s), tree observation exit 0, stage count exit 0, signing-root exit 0. These durations are check runtimes, not product speedup comparisons. Full freshness previously passed in this resolved integration (42.648 s). Final independent audit remains pending.

Committed resolved latest-main merge as `fcac40f34d`. Applied the repository atomic version-bump helper for the explicitly authorized retained Lab prerelease: 0.3.314 -> 0.3.315, seven synchronized paths. This is a retained experimental tag publication, not Lab finish, main integration, or formal Story completion. The pre-push policy forbids remote task branches; publish the authorized annotated experimental tag and GitHub prerelease, keeping local Lab available for inspection.

Claude final bounded audit APPROVE, with independent execution of mutator pin, tree-delegate pin and process contract (all exit 0). Its reuse-log observations were captured during the running sequential matrix: final matrix now contains six completed exit-0 results and the full reuse PASS. Preserve the audit verbatim and append this later completion. Added explicit remaining-scope table to release notes; renamed the failed semantic attempt to semantic-nonpass-red.log without changing bytes.

Claude evidence/disclosure supplement APPROVE: six final prior matrix rows all exit 0; independently verified frozen table, release table and all 21 then-bundled evidence checksums. Historical public archive assembled from 29 report directories: 1,960 top-level reports/logs, per-file digest verification passed, private/runtime fixture trees excluded. Final bumped-version checks are recorded separately.


## Final synchronized version 0.3.315

CLI reports `Proof-or-Stop 0.3.315`; official build passed. All four repeated checks below used the bumped candidate runtime. Durations are check runtimes.

| Command | Exit | Seconds |
|---|---:|---:|
| `node packages/main/dist/tasks/verification-freshness-smoke.js` | 0 | 31.090 |
| `node packages/main/dist/tasks/validation-evidence-reuse-smoke.js` | 0 | 79.285 |
| `node scripts/verify-runtime-fact-contract.mjs` | 0 | 7.306 |
| `node scripts/verify-process-fact-contract.mjs` | 0 | 9.244 |
