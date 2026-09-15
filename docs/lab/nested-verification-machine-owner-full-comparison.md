# Full configured-command comparison of the nested-verification-machine-owner Lab

Every configured command of local main 0.3.367 (indexes 0 to 168; the candidate
appends its own selectors after them) run through the real compiled executor with
the machine reservation held, sequentially and in the same order, first in the
main checkout and then in the candidate worktree. One row per command; the
outcome is the executor's own result (exit 0 is pass; a timeout is the armed
timer). Rows marked "(fixture consumer)" reach `runIsolatedFindingFixture`
directly, through an npm alias or through one script hop. The attribution of
every differing row is in the Lab record's "Full configured-command comparison"
subsection.

| index | command | main 0.3.367 | candidate | main s | candidate s |
| --- | --- | --- | --- | --- | --- |
| 0 | `npm --prefix packages/main run test:dynamic-finding-evidence-closure` (fixture consumer) | timeout (124) | timeout (124) | 180.6 | 180.9 |
| 1 | `npm --prefix packages/main run test:dynamic-finding-applicability` | pass | pass | 1.3 | 1.4 |
| 2 | `node packages/main/dist/tasks/finding-identity-lineage-smoke.js --section=delivery` (fixture consumer) | pass | fail (1, validation_failure) | 569.3 | 543.7 |
| 3 | `node packages/main/tests/red/red-b03b7-identity-lineage.mjs` | pass | fail (2, validation_failure) | 1.9 | 1.0 |
| 4 | `node scripts/verify-lab-worktree.mjs` | pass | pass | 151.7 | 130.5 |
| 5 | `npm --prefix packages/main run build` | pass | pass | 1.2 | 1.1 |
| 6 | `node scripts/run-precert-fast.mjs` | pass | pass | 10.1 | 9.2 |
| 7 | `node packages/main/tests/milestone-status.test.mjs` | fail (1, validation_failure) | fail (1, validation_failure) | 33.6 | 31.6 |
| 8 | `node packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js` (fixture consumer) | fail (1, validation_failure) | fail (1, validation_failure) | 7.0 | 6.7 |
| 9 | `node packages/main/dist/tasks/production-test-seam-guard.js` | pass | pass | 1.6 | 1.5 |
| 10 | `node packages/main/dist/tasks/capability-list-smoke.js` | pass | pass | 2.2 | 2.0 |
| 11 | `node packages/main/dist/tasks/command-catalog-smoke.js` | fail (1, validation_failure) | fail (1, validation_failure) | 0.6 | 0.6 |
| 12 | `node packages/main/dist/tasks/review-pass-discard-smoke.js` | fail (1, validation_failure) | fail (1, validation_failure) | 31.6 | 32.2 |
| 13 | `node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/tool-executed-evidence-receipt-smoke.js` | pass | pass | 64.1 | 60.6 |
| 14 | `node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/verification-run-and-guard-smoke.js` | pass | pass | 142.6 | 144.4 |
| 15 | `node scripts/verify-process-fact-contract.mjs --quiet` (fixture consumer) | fail (1, validation_failure) | fail (1, validation_failure) | 9.4 | 10.0 |
| 16 | `node scripts/verify-runtime-fact-contract.mjs` | fail (1, validation_failure) | fail (1, validation_failure) | 3.1 | 6.5 |
| 17 | `node packages/main/tests/red/red-repro-first-p0m-component-mapping.mjs` | pass | pass | 0.3 | 0.3 |
| 18 | `node packages/main/dist/tasks/init-window-data-loss-smoke.js` | pass | pass | 1.3 | 1.4 |
| 19 | `node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/validate-command-timeout-smoke.js` | pass | pass | 8.0 | 8.1 |
| 20 | `node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/validate-progress-heartbeat-smoke.js` | pass | pass | 119.3 | 110.5 |
| 21 | `node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/validate-focused-full-layering-smoke.js` | pass | pass | 1.2 | 1.2 |
| 22 | `node packages/main/dist/tasks/validation-evidence-buffer-smoke.js` | pass | pass | 18.1 | 16.2 |
| 23 | `node packages/main/dist/tasks/main-sync-readiness-smoke.js` | pass | pass | 4.4 | 3.4 |
| 24 | `node packages/main/dist/tasks/evidence-hash-snapshot-classifier-smoke.js` | pass | pass | 23.5 | 17.9 |
| 25 | `node packages/main/dist/tasks/reviewer-scan-budget-guard-smoke.js` | pass | pass | 6.6 | 4.8 |
| 26 | `node packages/main/dist/tasks/codex-adapter-gate-scope-smoke.js` | pass | pass | 0.5 | 0.4 |
| 27 | `node packages/main/dist/tasks/codex-heartbeat-timeout-smoke.js` | pass | pass | 3.1 | 2.9 |
| 28 | `node packages/main/dist/tasks/delivery-check-freshness-smoke.js` | pass | pass | 47.3 | 40.8 |
| 29 | `node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/done-required-validation-smoke.js` | pass | pass | 25.7 | 26.0 |
| 30 | `node packages/main/dist/tasks/validation-reuse-merge-lineage-smoke.js` | pass | pass | 6.8 | 7.4 |
| 31 | `node packages/main/dist/tasks/test-suite-utils-autobuild-smoke.js` | pass | pass | 0.3 | 0.3 |
| 32 | `node packages/main/dist/tasks/done-required-freshness-smoke.js` | pass | pass | 1.3 | 1.4 |
| 33 | `node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/done-required-head-drift-proof.js` | pass | pass | 6.0 | 6.4 |
| 34 | `node packages/main/dist/tasks/artifact-release-ledger-smoke.js` | fail (1, validation_failure) | fail (1, validation_failure) | 1.1 | 1.1 |
| 35 | `node packages/main/dist/tasks/version-bump-smoke.js` | pass | pass | 0.6 | 0.6 |
| 36 | `node packages/main/dist/tasks/parallel-decomposition-gate-smoke.js` | pass | pass | 0.3 | 0.3 |
| 37 | `node packages/main/dist/tasks/parallel-gate-config-smoke.js` | pass | pass | 0.3 | 0.3 |
| 38 | `node packages/main/dist/tasks/parallel-wave-advisory-smoke.js` | pass | pass | 0.5 | 0.5 |
| 39 | `node packages/main/dist/tasks/parallel-decomposition-gate-integration-smoke.js` (fixture consumer) | pass | pass | 9.3 | 9.4 |
| 40 | `node packages/main/dist/tasks/adversarial-review-contract-smoke.js` | pass | pass | 0.3 | 0.3 |
| 41 | `node packages/main/dist/tasks/adversarial-review-lens-runner-smoke.js` | pass | pass | 0.5 | 0.5 |
| 42 | `node packages/main/dist/tasks/adversarial-review-verifier-smoke.js` | pass | pass | 0.3 | 0.3 |
| 43 | `node packages/main/dist/tasks/adversarial-review-critic-smoke.js` | pass | pass | 0.5 | 0.5 |
| 44 | `node packages/main/dist/tasks/adversarial-review-round-smoke.js` | pass | pass | 0.3 | 0.3 |
| 45 | `node packages/main/dist/tasks/material-hash-large-tree-smoke.js` | pass | pass | 5.5 | 5.7 |
| 46 | `node packages/main/dist/tasks/lifecycle-orchestrate-smoke.js` | pass | pass | 23.3 | 22.7 |
| 47 | `node packages/main/dist/tasks/init-preflight-smoke.js` | pass | pass | 2.0 | 2.0 |
| 48 | `node packages/main/dist/tasks/english-early-check-smoke.js` | pass | pass | 8.9 | 9.4 |
| 49 | `node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/quorum-submit-smoke.js --jobs=2` | fail (1, validation_failure) | fail (1, validation_failure) | 424.2 | 429.1 |
| 50 | `node packages/main/tests/red/red-B-e40f-quorum-submit-harness.mjs --case=inventory-bijection` | pass | pass | 1.9 | 2.1 |
| 51 | `node packages/main/dist/tasks/receipt-bundle-contract-smoke.js` | pass | pass | 0.3 | 0.3 |
| 52 | `node packages/main/dist/tasks/gate-strength-contract-smoke.js` | pass | pass | 0.3 | 0.3 |
| 53 | `node packages/main/dist/tasks/lifecycle-registry-contract.js` | pass | pass | 0.4 | 0.4 |
| 54 | `node packages/main/dist/tasks/product-capability-release-smoke.js` | fail (1, validation_failure) | fail (1, validation_failure) | 0.7 | 0.8 |
| 55 | `node packages/main/dist/tasks/product-capability-release-red-smoke.js` | pass | pass | 0.4 | 0.4 |
| 56 | `node packages/main/dist/tasks/playbook-capability-lineage-smoke.js` | pass | pass | 2.7 | 3.0 |
| 57 | `node packages/main/dist/tasks/capability-release-invariants-smoke.js` | pass | pass | 3.2 | 3.4 |
| 58 | `node packages/main/dist/tasks/story-files-hash-batch-smoke.js` | fail (1, validation_failure) | fail (1, validation_failure) | 2.4 | 2.7 |
| 59 | `node packages/main/dist/tasks/capability-release-backfill-smoke.js` | pass | pass | 1.9 | 2.0 |
| 60 | `node packages/main/dist/tasks/capability-candidate-exposure-smoke.js` | pass | pass | 3.9 | 3.6 |
| 61 | `node packages/main/dist/tasks/capability-candidate-promotion-smoke.js` | pass | pass | 2.0 | 1.9 |
| 62 | `node packages/main/dist/tasks/repro-evidence-binding-dev-gate-smoke.js` | pass | pass | 31.7 | 31.1 |
| 63 | `node packages/main/dist/tasks/experience-pack-arm-switch-smoke.js` | pass | pass | 13.3 | 13.2 |
| 64 | `node packages/main/dist/tasks/gate-repeat-block-smoke.js` | pass | pass | 0.5 | 0.5 |
| 65 | `node packages/main/dist/tasks/scope-shrinkage-withdrawal-floor-smoke.js` | pass | pass | 9.2 | 9.2 |
| 66 | `node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/withdrawn-disposition-smoke.js` | pass | pass | 5.6 | 5.6 |
| 67 | `node packages/main/dist/tasks/red-evidence-policy-canon-smoke.js` | pass | pass | 0.3 | 0.3 |
| 68 | `node packages/main/dist/tasks/red-evidence-target-binding-smoke.js --canonical-core` | fail (1, validation_failure) | fail (1, validation_failure) | 10.8 | 11.4 |
| 69 | `node packages/main/dist/tasks/review-budget-stall-adjudication-smoke.js` | pass | pass | 4.4 | 5.1 |
| 70 | `node packages/main/dist/tasks/red-evidence-chain-smoke.js` | pass | pass | 3.0 | 3.5 |
| 71 | `node packages/main/tests/red/red-b2aa7-artifact-validation.mjs` | pass | pass | 18.1 | 20.4 |
| 72 | `node packages/main/tests/red/red-b2aa7-migration-scan.mjs` | pass | pass | 13.9 | 0.5 |
| 73 | `node packages/main/tests/red/red-b2aa7-chk004-receipt.mjs --canonical-core` | pass | pass | 2.4 | 2.6 |
| 74 | `node packages/main/tests/red/red-b2aa7-chk005-receipt.mjs --canonical-core` | pass | pass | 0.8 | 0.9 |
| 75 | `node packages/main/tests/red/red-b2aa7-chk006-receipt.mjs` | pass | pass | 5.8 | 6.3 |
| 76 | `node packages/main/tests/red/red-b2aa7-chk007-receipt.mjs --canonical-core` | pass | pass | 39.5 | 42.6 |
| 77 | `node packages/main/tests/red/red-b2aa7-chk009-receipt.mjs --canonical-core` | pass | pass | 0.8 | 0.8 |
| 78 | `node packages/main/tests/red/red-b2aa7-chk011-receipt.mjs` | pass | pass | 55.5 | 57.1 |
| 79 | `node packages/main/tests/red/red-b2aa7-doc-receipt.mjs` | pass | pass | 0.3 | 0.4 |
| 80 | `node packages/main/tests/red/red-b2aa7-baseline-receipt.mjs` | pass | pass | 0.6 | 0.7 |
| 81 | `node packages/main/tests/red/red-b2aa7-f005-receipt.mjs` | pass | pass | 1.2 | 1.4 |
| 82 | `node packages/main/tests/red/red-b2aa7-write-quarantine-race.mjs` | pass | pass | 1.1 | 1.1 |
| 83 | `node packages/main/tests/red/red-b2aa7-quarantine-derivation.mjs` | pass | pass | 8.1 | 8.1 |
| 84 | `node packages/main/tests/red/red-w2c-validate-registration.mjs` | pass | pass | 0.3 | 0.3 |
| 85 | `node packages/main/tests/red/red-done-prepare-done-parity.mjs` | pass | pass | 5.9 | 6.2 |
| 86 | `node packages/main/tests/red/red-done-shared-predicates.mjs` | pass | pass | 1.8 | 2.0 |
| 87 | `node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/post-done-closure-snapshot-smoke.js` | pass | pass | 22.5 | 24.2 |
| 88 | `node packages/main/tests/red/red-b49d4-harness-registration.mjs` | fail (1, validation_failure) | fail (1, validation_failure) | 0.3 | 0.3 |
| 89 | `node scripts/run-validation-fixture-suite.mjs packages/main/tests/red/red-b49d4-registration-derivation.mjs` | fail (1, validation_failure) | fail (1, validation_failure) | 67.1 | 76.6 |
| 90 | `node packages/main/tests/red/red-b49d4-chk002-receipt.mjs` | pass | pass | 0.9 | 0.9 |
| 91 | `node packages/main/tests/red/red-1734-lock-liveness.mjs` | pass | pass | 13.2 | 13.4 |
| 92 | `node packages/main/tests/red/red-1734-content-binding.mjs` | pass | pass | 59.8 | 58.0 |
| 93 | `node packages/main/tests/red/red-1734-reader-race.mjs` | pass | pass | 97.6 | 155.0 |
| 94 | `node packages/main/tests/red/red-bcae-bootstrap-reader-lock.mjs` | fail (1, validation_failure) | fail (1, validation_failure) | 5.4 | 5.6 |
| 95 | `node packages/main/tests/red/red-bcae-admission-coscheduling.mjs` | fail (1, validation_failure) | fail (1, validation_failure) | 0.8 | 0.8 |
| 96 | `node packages/main/tests/red/red-1734-bootstrap-depfree.mjs` | pass | pass | 0.4 | 0.4 |
| 97 | `node packages/main/tests/red/red-global-cli-exec-bit.mjs` | pass | pass | 0.6 | 0.6 |
| 98 | `node packages/main/tests/red/red-1734-desktop-asset-manifest.mjs` | pass | pass | 3.1 | 2.9 |
| 99 | `node packages/main/tests/red/red-b3434-blob-buffer-ceiling.mjs` | pass | pass | 4.6 | 4.3 |
| 100 | `node packages/main/tests/red/red-s3-differential-probe.mjs` | pass | pass | 1.0 | 1.0 |
| 101 | `node packages/main/tests/red/red-s3-digest-collapse.mjs` | pass | pass | 0.4 | 0.5 |
| 102 | `node packages/main/tests/red/red-w2a-canon-differential.mjs` | pass | pass | 0.3 | 0.3 |
| 103 | `node packages/main/tests/red/red-w2a-policy-failclosed.mjs` | pass | pass | 0.3 | 0.3 |
| 104 | `node packages/main/tests/red/red-w2b-binding-store.mjs` | pass | pass | 0.6 | 0.6 |
| 105 | `node packages/main/tests/red/red-w2b-wiring-contract.mjs --canonical-core` | fail (1, validation_failure) | fail (1, validation_failure) | 9.4 | 9.6 |
| 106 | `node packages/main/tests/red/red-w2c-binding-corrupt-chain.mjs` | pass | pass | 0.7 | 0.7 |
| 107 | `node packages/main/tests/red/red-w2c-binding-freeze-race.mjs` | pass | pass | 2.8 | 2.7 |
| 108 | `node packages/main/tests/red/red-w2c-gate-guard.mjs` | pass | pass | 1.7 | 1.6 |
| 109 | `node packages/main/tests/red/red-w2c-head-consistency.mjs` | pass | pass | 0.9 | 0.9 |
| 110 | `node packages/main/tests/red/red-w2c-quarantine-race.mjs` | pass | pass | 1.1 | 1.1 |
| 111 | `node packages/main/tests/red/red-w2c-rejection-matrix.mjs` | pass | pass | 0.9 | 0.9 |
| 112 | `node packages/main/tests/red/red-w2c-schema-failclosed.mjs` | pass | pass | 1.7 | 1.7 |
| 113 | `node packages/main/tests/red/red-w2c-v1-verdict-invariance.mjs` | pass | pass | 1.7 | 1.7 |
| 114 | `node packages/main/tests/red/red-w2c-wiring-detectability.mjs` | pass | pass | 3.3 | 3.3 |
| 115 | `node packages/main/dist/tasks/frozen-claim-drift-smoke.js` | pass | pass | 0.5 | 0.5 |
| 116 | `node packages/main/dist/tasks/frozen-claim-snapshot-hook-smoke.js` | pass | pass | 5.2 | 5.2 |
| 117 | `node packages/main/dist/tasks/proofstory-acceptance-rollout-smoke.js --issuer-mutations` | pass | pass | 53.9 | 53.5 |
| 118 | `node packages/main/dist/tasks/proofstory-acceptance-basis-smoke.js --probe-jobs=4` | fail (1, validation_failure) | fail (1, validation_failure) | 58.4 | 54.4 |
| 119 | `node scripts/verify-external-worktree-go-pre-review.mjs` | fail (1, validation_failure) | fail (1, validation_failure) | 6.2 | 6.4 |
| 120 | `node packages/main/tests/red/red-f88e-quorum-downgrade-collision.mjs` | pass | pass | 0.5 | 0.5 |
| 121 | `node packages/main/tests/red/red-f88e-downgrade-non-regression.mjs` | pass | pass | 0.4 | 0.5 |
| 122 | `node packages/main/dist/tasks/dev-memory-lifecycle-gates-smoke.js` | pass | pass | 15.4 | 15.6 |
| 123 | `node scripts/run-validation-fixture-suite.mjs packages/main/tests/red/red-B-7dff-sequential-validate-plan.mjs` | pass | pass | 2.1 | 2.3 |
| 124 | `node scripts/run-validation-fixture-suite.mjs packages/main/tests/validate-plan-scheduling.test.mjs` | pass | pass | 3.6 | 4.1 |
| 125 | `node packages/main/tests/validate-resource-claims.test.mjs` | fail (1, validation_failure) | fail (1, validation_failure) | 2.1 | 2.7 |
| 126 | `node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/validate-parallel-equivalence-smoke.js` | pass | pass | 9.6 | 10.0 |
| 127 | `node scripts/run-validation-fixture-suite.mjs packages/main/tests/validate-pollution-attribution.test.mjs` | pass | pass | 15.4 | 16.4 |
| 128 | `node packages/main/tests/red/red-b45a5-withdrawal-gates.mjs` | pass | pass | 4.9 | 4.9 |
| 129 | `node packages/main/dist/tasks/red-evidence-envelope-smoke.js --canonical-core` | fail (1, validation_failure) | fail (1, validation_failure) | 10.3 | 10.1 |
| 130 | `node packages/main/tests/red/red-w2d-entropy-differential.mjs` | pass | pass | 0.3 | 0.3 |
| 131 | `node packages/main/tests/red/red-w2d-specificity-conjunction.mjs` | pass | pass | 0.3 | 0.3 |
| 132 | `node packages/main/tests/red/red-w2d-assertion-digest-scope.mjs` | pass | pass | 0.3 | 0.3 |
| 133 | `node packages/main/tests/red/red-w2d-rejection-matrix.mjs` | pass | pass | 0.3 | 0.3 |
| 134 | `node scripts/run-validation-fixture-suite.mjs packages/main/tests/red/red-w2d-command-readonly.mjs --canonical` | pass | pass | 1.5 | 1.5 |
| 135 | `node packages/main/tests/red/red-b8df9-init-check-verdict-signature.mjs` | pass | pass | 50.7 | 49.0 |
| 136 | `node packages/main/tests/red/red-b8df9-chk002-verdict-shapes.mjs` | pass | pass | 0.5 | 0.5 |
| 137 | `node packages/main/tests/red/red-cc10-chk006-removed-bin-aliases.mjs` | pass | pass | 1.3 | 1.3 |
| 138 | `npm --prefix packages/graph run check` | pass | pass | 37.3 | 37.6 |
| 139 | `node packages/main/dist/tasks/cli-surface-smoke.js` | pass | pass | 16.5 | 15.9 |
| 140 | `node packages/main/dist/tasks/command-ownership-contract.js` | pass | pass | 1.1 | 1.0 |
| 141 | `node scripts/verify-orphan-surface.mjs` | pass | pass | 0.4 | 0.4 |
| 142 | `node packages/main/tests/red/red-bfe8f-ledger-runtime-integrity.mjs` | pass | fail (1, validation_failure) | 7.4 | 0.9 |
| 143 | `node packages/main/tests/red/red-partial-hash-snapshot-binding.mjs` | pass | pass | 3.7 | 3.5 |
| 144 | `node packages/main/dist/tasks/validation-tier-planner-smoke.js` | fail (1, validation_failure) | fail (1, validation_failure) | 9.8 | 10.0 |
| 145 | `node packages/main/dist/tasks/single-owner-extraction-smoke.js` | fail (1, validation_failure) | fail (1, validation_failure) | 10.6 | 9.8 |
| 146 | `node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/narrowing-repin-smoke.js` | pass | pass | 33.3 | 35.5 |
| 147 | `node packages/main/tests/canonical-new-story-artifacts.test.mjs --group=identity-cutover` | fail (1, validation_failure) | fail (1, validation_failure) | 96.0 | 92.9 |
| 148 | `node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/review-inventory-epoch-smoke.js` | fail (1, validation_failure) | fail (1, validation_failure) | 1.0 | 0.8 |
| 149 | `node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/validation-protocol-smoke.js` | fail (1, validation_failure) | fail (1, validation_failure) | 0.6 | 0.6 |
| 150 | `node packages/main/dist/tasks/cross-host-review-smoke.js` | pass | pass | 27.0 | 26.1 |
| 151 | `node packages/main/dist/tasks/host-run-usage-smoke.js --canonical-core` | fail (1, validation_failure) | fail (1, validation_failure) | 0.5 | 0.5 |
| 152 | `node packages/main/dist/tasks/managed-host-run-command-smoke.js` | pass | pass | 10.2 | 10.2 |
| 153 | `node packages/main/dist/tasks/managed-host-run-e2e-smoke.js` | fail (1, validation_failure) | fail (1, validation_failure) | 3.2 | 3.3 |
| 154 | `node packages/main/dist/tasks/managed-host-run-process-smoke.js` | pass | pass | 14.1 | 13.4 |
| 155 | `node scripts/verify-managed-inventory-critic-transport.mjs` (fixture consumer) | pass | pass | 164.3 | 165.9 |
| 156 | `node packages/main/dist/tasks/managed-review-evidence-smoke.js` | fail (1, validation_failure) | fail (1, validation_failure) | 0.5 | 0.5 |
| 157 | `node packages/main/dist/tasks/proof-admissibility-registry-smoke.js` | fail (1, validation_failure) | fail (1, validation_failure) | 1.8 | 1.8 |
| 158 | `node packages/main/dist/tasks/provider-process-registry-smoke.js --provider-launch-owner-admission-child` | pass | pass | 4.6 | 4.5 |
| 159 | `node packages/main/dist/tasks/semantic-scope-guard-smoke.js` | pass | pass | 19.5 | 18.7 |
| 160 | `node packages/main/dist/tasks/managed-host-run-smoke.js --canonical-core` | pass | pass | 18.2 | 17.1 |
| 161 | `node packages/main/dist/tasks/dispatch-run-smoke.js` | pass | pass | 25.6 | 21.3 |
| 162 | `node packages/main/dist/tasks/provider-claude-smoke.js` | pass | pass | 0.5 | 0.5 |
| 163 | `node packages/main/dist/tasks/agent-dispatch-registry-smoke.js` | fail (1, validation_failure) | fail (1, validation_failure) | 3.5 | 3.2 |
| 164 | `node scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/flow-stability-smoke.js --canonical-cor` | fail (1, validation_failure) | fail (1, validation_failure) | 0.8 | 0.7 |
| 165 | `node packages/main/dist/tasks/init-check-required-agents-smoke.js` | pass | pass | 14.1 | 13.7 |
| 166 | `node packages/main/dist/tasks/provider-codex-smoke.js --canonical-core` | pass | pass | 2.8 | 2.9 |
| 167 | `node packages/main/dist/tasks/repair-retry-loop-smoke.js` | pass | pass | 0.5 | 0.6 |
| 168 | `node scripts/verify-validation-static-edges.mjs` (fixture consumer) | fail (1, validation_failure) | fail (1, validation_failure) | 1.6 | 4.7 |
