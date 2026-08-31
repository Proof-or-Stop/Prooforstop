# B-5952 Execution Plan

## CHK-001 — Restore the bounded baseline and six TEST blockers

1. Keep the retired-authority instrumentation guard finite: accept the causally measured 804 builds at ceiling 808, enforce the absolute cap 850, rebuild dist, and retain the existing mutation and detached-baseline proofs.
2. Update repository-root checks in the three affected regressions to recognize canonical `proof-or-stop.config.json`, retaining legacy `lattice.config.json` only for isolated compatibility fixtures.
3. Give the two legacy red-evidence fixtures an explicit `.lattice/story/actives` storyDir so their intended non-empty runtime manifest is created and compared. Do not claim or implement a new missing-tree snapshot contract.
4. Preserve caller PATH during Unix global-CLI discovery by using a non-login shell; keep Windows discovery unchanged and prove timeout classification with the heartbeat smoke.
5. Rebuild packages/main, run the original smoke and all six former failing commands, require source/dist binding and scope-contract PASS, and record fresh receipts for every must intent.
6. Because the Story changes `packages/main/src/core/codex-adapter-checks.ts`, run `node bin/proof-or-stop.js verify_codex` under Node v26 and require fresh passing adapter evidence before REVIEW.
7. Keep the Dynamic Finding decision document, all handlers, CLI sources, and unrelated medium/low diagnostics outside this Story. Any newly proven critical/high or acceptance/lifecycle blocker returns to current repair; nonblocking findings are recorded for a later Story.

Rollback: revert the bounded baseline/config-fixture commit and rebuild dist. Reverting the heartbeat production change restores login-shell discovery; if that rollback is needed, also revert its timeout-smoke expectation and rerun verify_codex. No persistent user data migration is involved.
