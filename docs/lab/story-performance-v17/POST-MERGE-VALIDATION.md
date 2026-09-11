# Post-merge validation

Incoming main: `b715dd7b30f90add3c19dbc939a4f8cffd4b45b7`. Official builds passed. Durations are observed check runtime, not RED/GREEN speedup measurements.

| Command | Exit | Seconds |
|---|---:|---:|
| `node packages/main/tests/validation-tree-delegate-binding.mjs` | 0 | 1.260 |
| `node scripts/verify-process-fact-contract.mjs` | 0 | 8.517 |
| `node packages/main/dist/tasks/verification-freshness-smoke.js` | 0 | 42.648 |
| `node packages/main/tests/validation-queue-lease-loss.test.mjs` | 0 | 4.693 |
| `node packages/main/tests/certification-consumed-saturation.mjs` | 0 | 0.233 |
| `node packages/main/dist/tasks/dynamic-finding-applicability-smoke.js` | 0 | 1.850 |
| `node packages/main/tests/red/red-repro-first-p0m-component-mapping.mjs` | 0 | 0.128 |
| `node scripts/verify-runtime-fact-contract.mjs` | 0 | 9.088 |
| `node packages/main/tests/certification-mutator-identity.mjs` | 0 | 1.846 |
| `node packages/main/dist/tasks/validation-evidence-reuse-smoke.js` | 0 | 81.814 |
| `node scripts/verify-process-fact-contract.mjs` | 0 | 10.369 |
| `node packages/main/tests/validation-git-tree-observation.mjs` | 0 | 0.546 |
| `node packages/main/tests/validation-stage-entry-count.mjs` | 0 | 0.869 |
| `node packages/main/tests/validation-signing-root.mjs` | 0 | 2.134 |

## Additional RED/GREEN

| Issue | Before | After | Evidence |
|---|---|---|---|
| Certification mutator pin enforcement | Tampered inventory module reached store access | Both begin/cancel refuse before any store access; restored module reaches ordinary path | evidence/lab-cert-mutator-red.log; evidence/audit-fix-check-0.log |
| Scope-positive fixture | Unclassified root witness made certification inputs unavailable | Recognized scripts-domain witness executes once; missing contract remains zero launches | full freshness log, evidence/latest-check-2.log |
| Semantic non-PASS decoration | Missing/unknown status with allPass true became surfaced PASS, exit 0 | Non-PASS remains fail; full reuse smoke passes with semantic negative controls | evidence/semantic-nonpass-red.log (failed attempt); evidence/audit-fix-check-1.log |

The earlier misleading admission-green archive filename was renamed semantic-nonpass-red.log; its bytes remain the original failed attempt. New synthetic fixture admission is test-only, signed by existing test helper, and does not prove production review or admission readiness. Changed environment with consumed admission still refuses and starts no additional test.

The full reuse smoke now passes. Remaining limits: no full comparable Story lifecycle benchmark, no proof of long-term review convergence, no full final dual-worktree throughput benchmark, no universal short-command reuse benefit, and no arbitrary-fault or OS-wide transaction guarantee. The full quorum suite was not rerun: the latest merge did not change its implementation; focused shared-handler and contract regressions were selected. Historical performance rows are unchanged and not re-labelled as current measurements.


## Final synchronized version 0.3.315

CLI reports `Proof-or-Stop 0.3.315`; official build passed. All four repeated checks below used the bumped candidate runtime. Durations are check runtimes.

| Command | Exit | Seconds |
|---|---:|---:|
| `node packages/main/dist/tasks/verification-freshness-smoke.js` | 0 | 31.090 |
| `node packages/main/dist/tasks/validation-evidence-reuse-smoke.js` | 0 | 79.285 |
| `node scripts/verify-runtime-fact-contract.mjs` | 0 | 7.306 |
| `node scripts/verify-process-fact-contract.mjs` | 0 | 9.244 |
