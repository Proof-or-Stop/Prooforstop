# Detailed verification module and capability inventory

Each original entry remains the public command. Internal modules do not register new routine gates. `--list-capabilities` lists selectors; repeated `--capability=<id>` arguments select bounded capabilities. Default and `--all` retain the complete entry behavior. Legacy selectors remain supported. A partial PASS is not authority to skip other production checks.

| Entry | Entry lines | Modules | Maximum lines | Capability IDs | Registration |
|---|---:|---:|---:|---|---|
| `scripts/verify-process-fact-contract.mjs` | 7 | 16 | 1857 | `support`, `proofstory-closeout`, `reopen`, `prompt-contracts`, `review-inventory`, `registry-parser`, `command-contracts`, `review-verification`, `scope-runtime`, `story3` | Existing entry retained; explicit internal capability map |
| `packages/main/tests/red/red-B-e40f-quorum-submit-harness.mjs` | 7 | 27 | 1024 | `selector-contract`, `inventory-bijection`, `partition-contract`, `fixture-template-contract`, `coordinator-fault-contract`, `detached-containment-contract`, `worker-safety-contract`, `exact-head-supervisor-contract`, `resource-parallel-contract`, `performance-preflight-isolation-contract`, `performance-host-accounting-contract`, `performance-idle-wait-contract`, `performance-idle-budget-contract`, `performance-preflight-idle-contract`, `performance-contamination-retry-contract`, `performance-current-jobs1-contract`, `performance-current-jobs2-contract`, `performance-contract` | Existing entry retained; explicit internal capability map |
| `scripts/verify-proof-or-stop-identity-cutover.mjs` | 9 | 25 | 1433 | `ordering`, `current-guidance`, `history-contexts`, `schema-inventory`, `active-residue` | Existing entry retained; explicit internal capability map |
| `packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts` | 7 | 14 | 1577 | `vocabulary-controls`, `import-controls`, `dynamic-controls`, `loader-provenance`, `compatibility-controls`, `public-contract` | Existing entry retained; explicit internal capability map |
| `packages/main/src/tasks/validation-tier-planner-smoke.ts` | 7 | 9 | 1652 | `command-identity`, `historical-pins`, `change-inputs`, `selection-widening`, `cli-integration`, `hash-completeness`, `acceptance-guards` | Existing entry retained; explicit internal capability map |
| `packages/main/src/tasks/flow-stability-smoke.ts` | 7 | 11 | 989 | `done-convergence`, `lifecycle`, `workspace`, `artifacts`, `review-evidence`, `review-routing`, `done-reporting`, `phase-effects`, `liveness`, `history-compatibility` | Existing entry retained; explicit internal capability map |
| `packages/main/tests/canonical-new-story-artifacts.test.mjs` | 7 | 22 | 691 | `scope`, `init`, `runtime`, `runtime-topology`, `release`, `inventory`, `identity-cutover`, `identity-migration-archive`, `identity-consumer-smoke`, `identity-inventory`, `identity-cache`, `identity-sites`, `identity-canonical`, `identity-config-boundary`, `identity-policy`, `identity-policy-boundary`, `identity-snapshot`, `identity-entrypoint`, `reviewer-read`, `f050`, `round23`, `round24`, `memory-identity`, `artifact-append`, `finding-trust` | Existing entry retained; explicit internal capability map |
| `packages/main/src/tasks/finding-ledger-runtime-smoke.ts` | 6 | 9 | 1134 | `proposal-envelope`, `projection-receipt`, `base-authority`, `legacy-authority`, `transactions`, `readonly-mutations`, `runtime-evidence`, `rollback-concurrency`, `historical-migration`, `build-distribution`, `tamper-dependency` | Existing entry retained; explicit internal capability map |
| `packages/main/src/tasks/managed-review-evidence-smoke.ts` | 7 | 15 | 926 | `codex-transport`, `claude-transport`, `evidence-binding`, `native-attestation`, `sealed-receipts`, `descriptor-transport`, `supersession` | Existing entry retained; explicit internal capability map |
| `packages/main/src/tasks/host-run-usage-smoke.ts` | 6 | 15 | 587 | `proposal`, `prompt-supervision`, `usage-parsing`, `story-binding`, `streaming`, `ledger-failures`, `output-errors`, `admission`, `integrations`, `ledger-concurrency`, `process-supervision`, `evidence-mapping` | Existing entry retained; explicit internal capability map |
| `scripts/verify-proof-or-stop-prompt-baseline.mjs` | 7 | 6 | 1344 | `registry`, `prompt-policy`, `baseline-drift`, `role-matrix`, `legacy-vocabulary`, `direct-story-policy`, `measurement` | Existing entry retained; explicit internal capability map |
| `packages/main/tests/milestone-status.test.mjs` | 6 | 9 | 670 | `reporting`, `planning`, `closeout`, `freshness`, `coverage`, `read-only`, `cli-behavior` | Existing entry retained; explicit internal capability map |
| `scripts/verify-validation-build-artifact-binding.mjs` | 7 | 7 | 1409 | `routine`, `done-required`, `shared-cache`, `executor`, `handler` | Existing entry retained; explicit internal capability map |
| `packages/main/src/tasks/verification-run-and-guard-smoke.ts` | 7 | 7 | 776 | `foundation`, `fanout`, `integrity`, `story-identity` | Existing entry retained; explicit internal capability map |

## Every extracted module

| Module | Lines |
|---|---:|
| `scripts/process-fact-contract/catalog.mjs` | 92 |
| `scripts/process-fact-contract/cli.mjs` | 33 |
| `scripts/process-fact-contract/command-contracts.mjs` | 1106 |
| `scripts/process-fact-contract/complete.mjs` | 1857 |
| `scripts/process-fact-contract/early.mjs` | 64 |
| `scripts/process-fact-contract/prompt-contracts.mjs` | 678 |
| `scripts/process-fact-contract/proofstory-closeout.mjs` | 1620 |
| `scripts/process-fact-contract/registry-alignment.mjs` | 634 |
| `scripts/process-fact-contract/registry-parser.mjs` | 655 |
| `scripts/process-fact-contract/reopen.mjs` | 568 |
| `scripts/process-fact-contract/review-inventory.mjs` | 832 |
| `scripts/process-fact-contract/review-verification.mjs` | 1005 |
| `scripts/process-fact-contract/scope-runtime.mjs` | 1223 |
| `scripts/process-fact-contract/source-analysis.mjs` | 575 |
| `scripts/process-fact-contract/story3.mjs` | 360 |
| `scripts/process-fact-contract/support.mjs` | 1224 |
| `packages/main/tests/red/quorum-submit-harness/callback-inventory.mjs` | 603 |
| `packages/main/tests/red/quorum-submit-harness/catalog.mjs` | 51 |
| `packages/main/tests/red/quorum-submit-harness/cli.mjs` | 20 |
| `packages/main/tests/red/quorum-submit-harness/containment.mjs` | 689 |
| `packages/main/tests/red/quorum-submit-harness/coordinator-wiring.mjs` | 401 |
| `packages/main/tests/red/quorum-submit-harness/driver.mjs` | 60 |
| `packages/main/tests/red/quorum-submit-harness/environment-closure.mjs` | 425 |
| `packages/main/tests/red/quorum-submit-harness/exact-head-authorization.mjs` | 334 |
| `packages/main/tests/red/quorum-submit-harness/exact-head-checkout.mjs` | 433 |
| `packages/main/tests/red/quorum-submit-harness/exact-head-supervisor.mjs` | 444 |
| `packages/main/tests/red/quorum-submit-harness/fixture-source-closure.mjs` | 1024 |
| `packages/main/tests/red/quorum-submit-harness/fixture-templates.mjs` | 629 |
| `packages/main/tests/red/quorum-submit-harness/mutation-controls.mjs` | 242 |
| `packages/main/tests/red/quorum-submit-harness/owned-files.mjs` | 349 |
| `packages/main/tests/red/quorum-submit-harness/partition.mjs` | 163 |
| `packages/main/tests/red/quorum-submit-harness/performance-cases.mjs` | 609 |
| `packages/main/tests/red/quorum-submit-harness/performance-context.mjs` | 452 |
| `packages/main/tests/red/quorum-submit-harness/performance-material.mjs` | 341 |
| `packages/main/tests/red/quorum-submit-harness/process-supervision.mjs` | 252 |
| `packages/main/tests/red/quorum-submit-harness/resource-parallel.mjs` | 271 |
| `packages/main/tests/red/quorum-submit-harness/resource-traces.mjs` | 421 |
| `packages/main/tests/red/quorum-submit-harness/selection-contracts.mjs` | 691 |
| `packages/main/tests/red/quorum-submit-harness/selection.mjs` | 57 |
| `packages/main/tests/red/quorum-submit-harness/supervisor-controls.mjs` | 675 |
| `packages/main/tests/red/quorum-submit-harness/support.mjs` | 416 |
| `packages/main/tests/red/quorum-submit-harness/tree-lease.mjs` | 517 |
| `packages/main/tests/red/quorum-submit-harness/worker-coordination.mjs` | 562 |
| `scripts/identity-cutover/active-scan.mjs` | 104 |
| `scripts/identity-cutover/base-contexts.mjs` | 172 |
| `scripts/identity-cutover/bootstrap.mjs` | 9 |
| `scripts/identity-cutover/certification.mjs` | 154 |
| `scripts/identity-cutover/cli.mjs` | 31 |
| `scripts/identity-cutover/deny-contexts.mjs` | 1112 |
| `scripts/identity-cutover/guidance.mjs` | 112 |
| `scripts/identity-cutover/history-contexts.mjs` | 546 |
| `scripts/identity-cutover/integration-contexts.mjs` | 32 |
| `scripts/identity-cutover/memory-provenance.mjs` | 209 |
| `scripts/identity-cutover/negative-contexts.mjs` | 695 |
| `scripts/identity-cutover/ordering.mjs` | 130 |
| `scripts/identity-cutover/provenance-data.mjs` | 649 |
| `scripts/identity-cutover/public-api.mjs` | 27 |
| `scripts/identity-cutover/release-history.mjs` | 362 |
| `scripts/identity-cutover/repository.mjs` | 175 |
| `scripts/identity-cutover/reviewed-contexts.mjs` | 1433 |
| `scripts/identity-cutover/rules.mjs` | 142 |
| `scripts/identity-cutover/runtime-contexts.mjs` | 560 |
| `scripts/identity-cutover/scanner-contexts.mjs` | 734 |
| `scripts/identity-cutover/schema-data.mjs` | 838 |
| `scripts/identity-cutover/schema-scan.mjs` | 91 |
| `scripts/identity-cutover/self-test.mjs` | 607 |
| `scripts/identity-cutover/source-integrity.mjs` | 192 |
| `scripts/identity-cutover/witness-controls.mjs` | 121 |
| `packages/main/src/tasks/retired-authority/binding-classification.ts` | 427 |
| `packages/main/src/tasks/retired-authority/cli.ts` | 22 |
| `packages/main/src/tasks/retired-authority/compatibility-controls.ts` | 266 |
| `packages/main/src/tasks/retired-authority/driver.ts` | 105 |
| `packages/main/src/tasks/retired-authority/dynamic-bindings.ts` | 1577 |
| `packages/main/src/tasks/retired-authority/dynamic-scan.ts` | 458 |
| `packages/main/src/tasks/retired-authority/execution-controls.ts` | 657 |
| `packages/main/src/tasks/retired-authority/file-scan.ts` | 100 |
| `packages/main/src/tasks/retired-authority/loader-controls.ts` | 205 |
| `packages/main/src/tasks/retired-authority/module-loaders.ts` | 1077 |
| `packages/main/src/tasks/retired-authority/positive-controls.ts` | 205 |
| `packages/main/src/tasks/retired-authority/public-contract.ts` | 129 |
| `packages/main/src/tasks/retired-authority/rule-data.ts` | 747 |
| `packages/main/src/tasks/retired-authority/type-analysis.ts` | 286 |
| `packages/main/src/tasks/validation-tier-planner/acceptance-guards.ts` | 547 |
| `packages/main/src/tasks/validation-tier-planner/change-inputs.ts` | 718 |
| `packages/main/src/tasks/validation-tier-planner/cli-integration.ts` | 821 |
| `packages/main/src/tasks/validation-tier-planner/cli.ts` | 25 |
| `packages/main/src/tasks/validation-tier-planner/command-identity.ts` | 651 |
| `packages/main/src/tasks/validation-tier-planner/hash-completeness.ts` | 255 |
| `packages/main/src/tasks/validation-tier-planner/historical-pins.ts` | 336 |
| `packages/main/src/tasks/validation-tier-planner/selection-widening.ts` | 1652 |
| `packages/main/src/tasks/validation-tier-planner/support.ts` | 942 |
| `packages/main/src/tasks/flow-stability/artifacts.ts` | 904 |
| `packages/main/src/tasks/flow-stability/cli.ts` | 120 |
| `packages/main/src/tasks/flow-stability/discovery-fixture.ts` | 24 |
| `packages/main/src/tasks/flow-stability/done-convergence.ts` | 626 |
| `packages/main/src/tasks/flow-stability/done-reporting.ts` | 407 |
| `packages/main/src/tasks/flow-stability/lifecycle.ts` | 631 |
| `packages/main/src/tasks/flow-stability/phase-effects.ts` | 274 |
| `packages/main/src/tasks/flow-stability/review-evidence.ts` | 989 |
| `packages/main/src/tasks/flow-stability/review-routing.ts` | 896 |
| `packages/main/src/tasks/flow-stability/support.ts` | 427 |
| `packages/main/src/tasks/flow-stability/workspace.ts` | 301 |
| `packages/main/tests/canonical-new-story-artifacts/artifact-inventory.mjs` | 276 |
| `packages/main/tests/canonical-new-story-artifacts/catalog.mjs` | 384 |
| `packages/main/tests/canonical-new-story-artifacts/cli.mjs` | 17 |
| `packages/main/tests/canonical-new-story-artifacts/data.mjs` | 691 |
| `packages/main/tests/canonical-new-story-artifacts/driver.mjs` | 41 |
| `packages/main/tests/canonical-new-story-artifacts/finding-artifacts.mjs` | 186 |
| `packages/main/tests/canonical-new-story-artifacts/fixture-support.mjs` | 72 |
| `packages/main/tests/canonical-new-story-artifacts/identity-cutover.mjs` | 481 |
| `packages/main/tests/canonical-new-story-artifacts/identity-inventory.mjs` | 323 |
| `packages/main/tests/canonical-new-story-artifacts/identity-ownership.mjs` | 274 |
| `packages/main/tests/canonical-new-story-artifacts/identity-policy.mjs` | 143 |
| `packages/main/tests/canonical-new-story-artifacts/identity-runtime-boundaries.mjs` | 282 |
| `packages/main/tests/canonical-new-story-artifacts/identity-sites.mjs` | 548 |
| `packages/main/tests/canonical-new-story-artifacts/memory-runtime.mjs` | 210 |
| `packages/main/tests/canonical-new-story-artifacts/migration-archive.mjs` | 231 |
| `packages/main/tests/canonical-new-story-artifacts/public-fixtures.mjs` | 429 |
| `packages/main/tests/canonical-new-story-artifacts/release.mjs` | 354 |
| `packages/main/tests/canonical-new-story-artifacts/runner.mjs` | 40 |
| `packages/main/tests/canonical-new-story-artifacts/runtime-extensions.mjs` | 127 |
| `packages/main/tests/canonical-new-story-artifacts/runtime-read.mjs` | 137 |
| `packages/main/tests/canonical-new-story-artifacts/runtime-topology.mjs` | 335 |
| `packages/main/tests/canonical-new-story-artifacts/scope-init.mjs` | 557 |
| `packages/main/src/tasks/finding-ledger-runtime/authority.ts` | 624 |
| `packages/main/src/tasks/finding-ledger-runtime/boundaries.ts` | 290 |
| `packages/main/src/tasks/finding-ledger-runtime/cli.ts` | 79 |
| `packages/main/src/tasks/finding-ledger-runtime/distribution.ts` | 295 |
| `packages/main/src/tasks/finding-ledger-runtime/process-mutation-proof.ts` | 52 |
| `packages/main/src/tasks/finding-ledger-runtime/projection.ts` | 845 |
| `packages/main/src/tasks/finding-ledger-runtime/runtime-evidence.ts` | 990 |
| `packages/main/src/tasks/finding-ledger-runtime/support.ts` | 452 |
| `packages/main/src/tasks/finding-ledger-runtime/transactions.ts` | 1134 |
| `packages/main/src/tasks/managed-review-evidence/claude-transport.ts` | 926 |
| `packages/main/src/tasks/managed-review-evidence/cli.ts` | 22 |
| `packages/main/src/tasks/managed-review-evidence/codex-transport.ts` | 785 |
| `packages/main/src/tasks/managed-review-evidence/environment.ts` | 127 |
| `packages/main/src/tasks/managed-review-evidence/evidence-binding.ts` | 654 |
| `packages/main/src/tasks/managed-review-evidence/fixtures.ts` | 336 |
| `packages/main/src/tasks/managed-review-evidence/grok-integration.ts` | 168 |
| `packages/main/src/tasks/managed-review-evidence/legacy-cli.ts` | 79 |
| `packages/main/src/tasks/managed-review-evidence/live-binding.ts` | 407 |
| `packages/main/src/tasks/managed-review-evidence/native-attestation.ts` | 564 |
| `packages/main/src/tasks/managed-review-evidence/prompt-fixture.ts` | 18 |
| `packages/main/src/tasks/managed-review-evidence/sealed-receipts.ts` | 749 |
| `packages/main/src/tasks/managed-review-evidence/suite.ts` | 95 |
| `packages/main/src/tasks/managed-review-evidence/supersession.ts` | 241 |
| `packages/main/src/tasks/managed-review-evidence/transport-workers.ts` | 365 |
| `packages/main/src/tasks/host-run-usage/admission.ts` | 373 |
| `packages/main/src/tasks/host-run-usage/cli.ts` | 119 |
| `packages/main/src/tasks/host-run-usage/evidence-mapping.ts` | 61 |
| `packages/main/src/tasks/host-run-usage/integrations.ts` | 587 |
| `packages/main/src/tasks/host-run-usage/ledger-concurrency.ts` | 277 |
| `packages/main/src/tasks/host-run-usage/ledger-failures.ts` | 285 |
| `packages/main/src/tasks/host-run-usage/output-errors.ts` | 502 |
| `packages/main/src/tasks/host-run-usage/process-supervision.ts` | 396 |
| `packages/main/src/tasks/host-run-usage/prompt-supervision.ts` | 195 |
| `packages/main/src/tasks/host-run-usage/proposal.ts` | 272 |
| `packages/main/src/tasks/host-run-usage/story-binding.ts` | 155 |
| `packages/main/src/tasks/host-run-usage/streaming.ts` | 314 |
| `packages/main/src/tasks/host-run-usage/summary.ts` | 74 |
| `packages/main/src/tasks/host-run-usage/support.ts` | 469 |
| `packages/main/src/tasks/host-run-usage/usage-parsing.ts` | 500 |
| `scripts/prompt-baseline/cli.mjs` | 235 |
| `scripts/prompt-baseline/collection.mjs` | 357 |
| `scripts/prompt-baseline/policy-data.mjs` | 1344 |
| `scripts/prompt-baseline/policy-probes.mjs` | 262 |
| `scripts/prompt-baseline/scanners.mjs` | 751 |
| `scripts/prompt-baseline/verification.mjs` | 804 |
| `packages/main/tests/milestone-status/cli-behavior.mjs` | 622 |
| `packages/main/tests/milestone-status/cli.mjs` | 60 |
| `packages/main/tests/milestone-status/closeout.mjs` | 670 |
| `packages/main/tests/milestone-status/coverage.mjs` | 558 |
| `packages/main/tests/milestone-status/freshness.mjs` | 476 |
| `packages/main/tests/milestone-status/planning.mjs` | 168 |
| `packages/main/tests/milestone-status/read-only.mjs` | 106 |
| `packages/main/tests/milestone-status/reporting.mjs` | 605 |
| `packages/main/tests/milestone-status/support.mjs` | 293 |
| `scripts/validation-build-binding/cli.mjs` | 33 |
| `scripts/validation-build-binding/done-required.mjs` | 736 |
| `scripts/validation-build-binding/executor.mjs` | 1409 |
| `scripts/validation-build-binding/handler.mjs` | 218 |
| `scripts/validation-build-binding/routine.mjs` | 619 |
| `scripts/validation-build-binding/shared-cache.mjs` | 261 |
| `scripts/validation-build-binding/support.mjs` | 106 |
| `packages/main/src/tasks/verification-run-and-guard/causal.ts` | 140 |
| `packages/main/src/tasks/verification-run-and-guard/cli.ts` | 160 |
| `packages/main/src/tasks/verification-run-and-guard/foundation.ts` | 427 |
| `packages/main/src/tasks/verification-run-and-guard/integrity.ts` | 762 |
| `packages/main/src/tasks/verification-run-and-guard/publication.ts` | 517 |
| `packages/main/src/tasks/verification-run-and-guard/refresh.ts` | 776 |
| `packages/main/src/tasks/verification-run-and-guard/support.ts` | 349 |
