# Multi-Model Ablation M2 Status

Research boundary: B-6529 readiness evidence remains `providerCallsMade=false`, `containsOutcomeData=false`, `phase1OrPhase2CellsRun=false`, `productGateImpact="none"`. B-991d separately opened a Cell 03-only execution window and completed the ③ A4 E2 same-family Cell 03 run. This is still not a full Phase 1/Phase 2 dataset: Cell 06, Cell 02, optional Cell 04, Phase 2, product gate impact, playbook activation, and paper claim upgrades remain out of scope.

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
| Cell 03 usage accounting | COMPLETE | `future-cell03-results/usage-summary.json` records provider-reported token usage from final Cell 03 rows. Exact dollar cost is not faked because no billing export or versioned pricingRef is present; estimates remain diagnostic only and not final usage or a launch gate. |
| Cell 03 launch guardrail | WINDOW CLOSED FOR CELL 03 DATA COLLECTION | `m2-cell03-provider-launch-authorization.json` preserves B-6529 guardrails and records B-991d as the Cell 03-only execution window owner; postflight provider-reported usage is recorded in `future-cell03-results/usage-summary.json`. |
| M2 provider execution checker | PREPARED | `m2-provider-execution-check.mjs` validates accidental authorization, host-label-only snapshot, provider fallback, and sequencing negative controls. |
| Cell 03 probe execution | COMPLETE | `future-cell03-results/probe/probe-rows.jsonl` contains 2 Cell 03 probe rows with executor usage, fresh same-family reviewer usage, review verdicts, acceptance checks, hidden ground-truth checks, provider-visible workspace isolation, and B-991d provenance. |
| Formal M2 execution | CELL 03 COMPLETE ONLY | `future-cell03-results/full/cell03-summary.json` records `finalRows=1142/1152`, `terminalExhaustedRows=10`, `pendingExecutableRows=0`, and `providerUsageRows=1142`. |
| B-991d Cell 03 execution window | COMPLETED FOR CELL 03 | Provider calls were enabled only for B-991d Cell 03 / ③ A4 E2 same-family execution under the frozen envelope. No Cell 02, Cell 04, Cell 06, or Phase 2 rows ran. |
| ③ A4 calibration | COMPLETE | `future-cell03-results/full/cell03-rows.jsonl` and `future-cell03-results/full/cell03-summary.json` are the real Cell 03 calibration dataset for later analysis. |
| ⑥ A2prime | SEQUENCING DEPENDENCY AVAILABLE; EXECUTION NOT STARTED | `future-cell03-results/cell03-usage-lock.json` is a real Cell 03-derived usage lock, but it does not authorize automatic Cell 06 execution. |
| M3 Phase 2 decision | PENDING | No Phase 1 directional readout exists yet, so the Phase 2 decision is not available. |
| M4 powered matrix | PENDING | The powered matrix is not launched by M2 readiness. |
| M5 analysis and recompute | CELL 03 READY; PHASE 1 INCOMPLETE | `future-cell03-results/analysis-readiness.json` permits Cell 03 descriptive analysis while blocking confirmatory Phase 1, Phase 2, H-M1/H-M3, model-agnostic, product, paper, and playbook claims. |
| M6 wording guard | PENDING | H-M1/H-M3 claims are not proven and no model-agnostic paper claim is unlocked. |

Operator note: clearing M2 readiness means a future provider-execution story has deterministic local inputs to check before spending budget. It does not prove H-M1, H-M3, or model-agnostic generalization.

## Latest Local Validation

Local validation on 2026-07-07:

| Command | Result |
|---|---|
| `node experiments/multi-model-ablation/m0-smoke-check.mjs` | PASS |
| `node experiments/multi-model-ablation/m1-freeze-check.mjs` | PASS |
| `node experiments/multi-model-ablation/m2-launch-readiness-check.mjs` | PASS |
| `node experiments/multi-model-ablation/m2-provider-execution-check.mjs` | PASS; reports Cell 03 envelope frozen, B-991d Cell 03 execution window open, B-6529 no-provider-call evidence preserved, postflight provider-reported usage required, and Cell 06 blocked. |
| `node experiments/multi-model-ablation/future-cell03-results/full/validate-full.mjs --requireComplete` | PASS; `106607` assertions, `13` negative controls rejected, `finalRows=1142/1152`, `terminalExhaustedRows=10`, `pendingExecutableRows=0`. |

M2-provider authorization metadata: DONE. B-11be records provider spend USD 0.00 as a historical no-spend boundary, not a future launch cap; no provider cells ran; no result rows exist; cell 03 is next; cell 06 remains blocked.

Cell 03 execution envelope: frozen. Pre-run dollar guess: not required. B-991d Cell 03 execution window: completed for Cell 03 only with provider calls scoped to ③ A4 E2 same-family rows. B-6529 no-provider-call readiness evidence: preserved with `providerExecutionAuthorized=false` and `providerCallEnabled=false`. Postflight provider-reported usage: `inputTokens=213133626`, `outputTokens=6119875`, `totalTokens=219253501`. Exact dollar cost is not recorded because no billing export or versioned pricingRef is present. Cell 06 A2prime: sequencing dependency now exists, execution remains separate and not started.

Cell 03 launch guardrail: completed for B-991d Cell 03. B-6529 does not become an execution story. `future-cell03-results/cell03-usage-lock.json` provides a real Cell 03-derived usage dependency lock for future Cell 06 planning, but does not authorize automatic Cell 06 execution.

Cell 03 probe on 2026-07-06: `future-cell03-results/probe/probe-summary.json` records `rowCount=2`, `finalRows=2`, `reviewedRows=2`, `groundTruthPassRows=2`, `providerUsageRows=2`, `totalTokens=315877`, and `fullRunUnlocked=true` for CHK-006. Probe validation passed with 225 assertions and 15 negative controls rejected.

These checks opened and completed only the B-991d Cell 03 execution scope. They did not run Cell 06, Cell 02, optional Cell 04, full Phase 2, product gate changes, playbook activation, or paper claim upgrades.
