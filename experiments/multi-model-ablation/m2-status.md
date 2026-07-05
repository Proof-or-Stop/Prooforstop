# Multi-Model Ablation M2 Status

Research boundary: `providerCallsMade=false`, `containsOutcomeData=false`, `phase1OrPhase2CellsRun=false`, `productGateImpact="none"`.

M2 in this directory is a provider-free launch-readiness layer. It records the static boundary, dated provider-family declarations, the concrete 24-task inventory, and the Phase 1 cell-family manifest. It does not authorize provider execution, Phase 1 execution, Phase 2 execution, result collection, or any Proofbound product gate change.

| Milestone | Status | Checked artifact |
|---|---|---|
| M0 research smoke | COMPLETE | `m0-smoke-check.mjs` still validates the provider-safe M0 examples and local invariants. |
| M1 protocol freeze | COMPLETE | `m1-freeze-check.mjs` still validates the protocol digest, seed slots, cell matrix, and launch gate. |
| M2 launch readiness | PREPARED | `m2-launch-readiness.json` records the 2026-07-05 readiness boundary while provider execution stays disabled. |
| M2 snapshot declarations | PREPARED | `model-snapshot-lock.m2.json` declares distinct E1 Anthropic Claude and E2 OpenAI GPT provider families without treating host labels as model families. |
| M2 task inventory | PREPARED | `task-inventory.m2.json` binds exactly 24 existing task directories read-only by digest. |
| M2 runner manifest | PREPARED | `phase1-runner-manifest.m2.json` represents required cells ③/⑥/② and keeps optional ④ budget-permitting. |
| M2 static checker | PREPARED | `m2-launch-readiness-check.mjs` recomputes task digests, checks launch blockers, and rejects in-memory negative controls. |
| Formal M2 execution | NOT STARTED | Provider calls remain disabled; real executor/reviewer run metadata must be supplied by a future provider-execution story. |
| ③ A4 calibration | PENDING EXECUTION | This is the next execution step and must run before any ⑥ A2prime budget can be locked. |
| ⑥ A2prime | BLOCKED | ⑥ remains blocked until a real ③-derived budget lock exists. M0 example budget locks are not formal evidence. |
| M3 Phase 2 decision | PENDING | No Phase 1 directional readout exists yet, so the Phase 2 decision is not available. |
| M4 powered matrix | PENDING | The powered matrix is not launched by M2 readiness. |
| M5 analysis and recompute | PENDING | There are no result rows to analyze or recompute. |
| M6 wording guard | PENDING | H-M1/H-M3 claims are not proven and no model-agnostic paper claim is unlocked. |

Operator note: clearing M2 readiness means a future provider-execution story has deterministic local inputs to check before spending budget. It does not prove H-M1, H-M3, or model-agnostic generalization.
