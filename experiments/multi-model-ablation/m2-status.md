# Multi-Model Ablation M2 Status

Research boundary: `providerCallsMade=false`, `containsOutcomeData=false`, `phase1OrPhase2CellsRun=false`, `productGateImpact="none"`.

M2 in this directory began as a provider-free launch-readiness layer. B-991d now opens a separate Cell 03-only execution window while preserving B-6529 as historical readiness/no-provider-call evidence. The window authorizes provider calls only for Cell 03 / protocol cell ③ under the frozen envelope; it does not authorize Cell 02, Cell 04, Cell 06, Phase 2 execution, paper claim upgrades, playbook activation, or any Proofbound product gate change.

| Milestone | Status | Checked artifact |
|---|---|---|
| M0 research smoke | COMPLETE | `m0-smoke-check.mjs` still validates the provider-safe M0 examples and local invariants. |
| M1 protocol freeze | COMPLETE | `m1-freeze-check.mjs` still validates the protocol digest, seed slots, cell matrix, and launch gate. |
| M2 launch readiness | PREPARED | `m2-launch-readiness.json` records the 2026-07-05 readiness boundary while provider execution stays disabled. |
| M2 snapshot declarations | PREPARED | `model-snapshot-lock.m2.json` declares distinct E1 Anthropic Claude and E2 OpenAI GPT provider families without treating host labels as model families. |
| M2 task inventory | PREPARED | `task-inventory.m2.json` binds exactly 24 existing task directories read-only by digest. |
| M2 runner manifest | PREPARED | `phase1-runner-manifest.m2.json` represents required cells ③/⑥/② and keeps optional ④ budget-permitting. |
| M2 static checker | PREPARED | `m2-launch-readiness-check.mjs` recomputes task digests, checks launch blockers, and rejects in-memory negative controls. |
| M2 provider execution launch gate | CELL 03 WINDOW OPEN | `m2-provider-execution-launch.json` preserves B-6529 `authorization_ready_execution_not_run` evidence and records B-991d `open_cell03_only`, with `providerCallEnabled=true` only inside the Cell 03 execution window and no outcome records. |
| M2-provider authorization metadata | DONE | `m2-provider-execution-authorization.json` records B-11be metadata authorization with provider spend USD 0.00 as a historical no-spend boundary, no provider cells ran, no result rows exist, cell 03 is next, and cell 06 remains blocked. |
| Cell 03 execution envelope | FROZEN | `m2-cell03-execution-envelope.json` freezes exact Cell 03 scope, 24 tasks, 1,152 planned rows, retry/time/token/output limits, stop conditions, dated E2 target snapshots, prompt/tool digests, runner ownership, duplicate policy, and result output policy. |
| Cell 03 usage accounting | POSTFLIGHT REQUIRED | `m2-cell03-usage-accounting-policy.json` makes provider-reported usage mandatory after future execution; any estimate is diagnostic only and not final usage or a launch gate. |
| Cell 03 launch guardrail | WINDOW OPEN | `m2-cell03-provider-launch-authorization.json` preserves B-6529 guardrails and records B-991d as the Cell 03-only execution window owner; postflight provider-reported usage is still required after execution. |
| M2 provider execution checker | PREPARED | `m2-provider-execution-check.mjs` validates accidental authorization, host-label-only snapshot, provider fallback, and sequencing negative controls. |
| Formal M2 execution | NOT STARTED | No formal rows have been run or counted yet; B-991d opens only the Cell 03 execution window, with no claim unlock and no product gate impact. |
| B-991d Cell 03 execution window | OPEN | Provider calls are enabled only for B-991d Cell 03 / ③ A4 E2 same-family execution under the frozen envelope. |
| ③ A4 calibration | PENDING EXECUTION | `nextPermittedFormalStep=cell-03-calibration`; B-991d may run Cell 03 probe/full rows under the frozen envelope before any ⑥ A2prime budget can be locked. |
| ⑥ A2prime | BLOCKED | `cell-06-a2prime-blocked` until a real cell-03-derived budget/usage lock exists. M0 example budget locks are not formal evidence. |
| M3 Phase 2 decision | PENDING | No Phase 1 directional readout exists yet, so the Phase 2 decision is not available. |
| M4 powered matrix | PENDING | The powered matrix is not launched by M2 readiness. |
| M5 analysis and recompute | PENDING | There are no result rows to analyze or recompute. |
| M6 wording guard | PENDING | H-M1/H-M3 claims are not proven and no model-agnostic paper claim is unlocked. |

Operator note: clearing M2 readiness means a future provider-execution story has deterministic local inputs to check before spending budget. It does not prove H-M1, H-M3, or model-agnostic generalization.

## Latest Local Validation

Local-only validation on 2026-07-06:

| Command | Result |
|---|---|
| `node experiments/multi-model-ablation/m0-smoke-check.mjs` | PASS |
| `node experiments/multi-model-ablation/m1-freeze-check.mjs` | PASS |
| `node experiments/multi-model-ablation/m2-launch-readiness-check.mjs` | PASS |
| `node experiments/multi-model-ablation/m2-provider-execution-check.mjs` | PASS; reports Cell 03 envelope frozen, B-991d Cell 03 execution window open, B-6529 no-provider-call evidence preserved, postflight provider-reported usage required, and Cell 06 blocked. |

M2-provider authorization metadata: DONE. B-11be records provider spend USD 0.00 as a historical no-spend boundary, not a future launch cap; no provider cells ran; no result rows exist; cell 03 is next; cell 06 remains blocked.

Cell 03 execution envelope: frozen. Pre-run dollar guess: not required. B-991d Cell 03 execution window: open for Cell 03 only with `providerCallEnabled=true`. B-6529 no-provider-call readiness evidence: preserved with `providerExecutionAuthorized=false` and `providerCallEnabled=false`. Postflight usage accounting: provider-reported usage required after execution. Cell 06 A2prime: blocked.

Cell 03 launch guardrail: WINDOW OPEN. B-991d authorizes provider calls only for Cell 03 under the frozen envelope. B-6529 does not become an execution story, no outcome rows are present yet, and cell 06 remains blocked until a real cell-03-derived budget/usage lock exists after execution.

These checks are local parse and invariant checks only. They opened the Cell 03 execution window but did not yet run provider calls, full Phase 1, full Phase 2, or any external provider execution.
