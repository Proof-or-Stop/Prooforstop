# Multi-Model Ablation M0 Status

Research boundary: `providerCallsMade=false`, `containsOutcomeData=false`, `phase1OrPhase2CellsRun=false`, `productGateImpact="none"`.

This status covers M0 smoke artifacts only. It does not run provider calls, Phase 1 cells, Phase 2 cells, or outcome recording, and it has no product gate impact.

| Milestone | Status | Evidence |
|---|---|---|
| M0.1 Provider-safe scope boundary | ✓ | `m0-research-smoke.json` records the local-only boundary and checker command. |
| M0.2 Host/model separation | ✓ | `runner-registry.m0.json` separates `hostKind` from `executorSnapshot` / `reviewerSnapshot` and records codex-cli 0.141.0, Claude Code 2.1.201, and agy 1.0.16 as host availability, not model families. |
| M0.3 Provider family selection | blocker | `model-snapshot-lock.m0.json` records E1=Anthropic/Claude and E2=OpenAI/GPT as distinct provider families, but exact dated execution snapshots are not locked. |
| M0.4 Cell semantics and contrasts | ✓ | `cell-manifest.m0.json` defines ①/②/③/④/⑤/⑥, allows ③ vs ⑥, ① vs ②, and ③ vs ④, and rejects ② vs ④ as confirmatory. |
| M0.5 Budget-lock ordering | ✓ | `cell-manifest.m0.json` and `phase1-budget-lock.m0.json` prove ③ precedes budget-lock precedes ⑥, and A2prime rows require matching `budgetLockDigest`. |
| M0.6 Local smoke checker | ✓ | `m0-smoke-check.mjs` validates M0 artifacts, validates existing example artifacts, and runs required negative controls in memory. |
| M0.7 Phase 1 launch gate | blocker | Phase 1 is not ready from M0 because human approval, execution-locked dated snapshots, and execution-locked budget/protocol locks are absent. |

Next step: Phase 1 may start only after human approval and execution-locked dated snapshots/budget; this M0 smoke does not grant formal Phase 1 readiness.
