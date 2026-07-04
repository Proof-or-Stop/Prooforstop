# Multi-Model Ablation M1 Status

Research boundary: `providerCallsMade=false`, `containsOutcomeData=false`, `phase1OrPhase2CellsRun=false`, `productGateImpact="none"`.

M1 DONE here means the provider-free protocol freeze artifacts exist and are locally checkable. It does not authorize provider execution, Phase 1, Phase 2, outcome collection, or any Proofbound product gate change.

| Milestone | Status | Checked artifact |
|---|---|---|
| M1 protocol digest lock | DONE | `protocol.lock.json` binds `docs/requirements/decisions/multi-model-ablation-replication.md` to SHA-256 and records the provider-free boundary. |
| M1 seed planning manifest | DONE | `seed-manifest.m1.json` freezes 24 task slots, 16 scenario slots, 3 repeats, and the SHA-256 seed derivation policy. |
| M1 Phase 1 cell matrix | DONE | `cell-matrix.m1.json` freezes required cells ③/⑥/②, optional ④, required count 3,456, and optional total 4,608. |
| M1 launch gate | DONE | `phase1-launch-gate.m1.json` keeps `launchAllowed=false`, `providerCallEnabled=false`, and `formalPhase1UseAllowed=false`. |
| M1 freeze checker | DONE | `m1-freeze-check.mjs` recomputes the protocol digest, validates counts/semantics, and rejects negative controls. |
| M2 provider execution | BLOCKED | Human approval, dated snapshots, concrete task inventory, A4 budget lock, and A2prime sequencing proof are absent. |
| Provider execution | OFF | No provider calls are enabled by these artifacts. |
| Outcome data | ABSENT | The JSON artifacts contain no `outcome` fields and no Phase 1 or Phase 2 cells have run. |

Operator note: clearing M1 only checks off the provider-free freeze layer. A separate human-approved M2 launch record is required before any provider call or formal Phase 1 campaign.
