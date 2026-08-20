# Plan: B-69b8 Execute Multi-Model Ablation Research M0 smoke checks

## CHK-001: Create Research M0 execution artifacts and status table

**Owner**: main-agent
**DependsOn**: none
**Files**:
- Modify: none
- Create: experiments/multi-model-ablation/m0-research-smoke.json, experiments/multi-model-ablation/m0-status.md
- Test: node experiments/multi-model-ablation/m0-smoke-check.mjs

**Verify**:
- `node experiments/multi-model-ablation/m0-smoke-check.mjs` reports the M0 boundary assertions.
- `rg -n "providerCallsMade=false|phase1OrPhase2CellsRun=false|productGateImpact=none" experiments/multi-model-ablation/m0-status.md`

**DoneWhen**:
- The status table lists every requested Research M0 milestone.
- The artifact states that no Phase 1/2 cells ran and no product gates, playbooks, DONE policy, or runtime guidance changed.

## CHK-002: Implement provider-safe M0 smoke checker

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-003, CHK-004
**Files**:
- Modify: none
- Create: experiments/multi-model-ablation/m0-smoke-check.mjs
- Test: experiments/multi-model-ablation/m0-smoke-check.mjs

**Verify**:
- `node experiments/multi-model-ablation/m0-smoke-check.mjs`

**DoneWhen**:
- The checker validates host/model separation, snapshot readiness fields, prompt/tool digests, A2prime budget-lock binding, and contrast legality.
- The checker includes negative controls for missing A2prime budget lock, missing reviewer snapshot, host-as-model confusion, and illegal cell 2 vs cell 4 confirmatory comparison.

## CHK-003: Record runner and snapshot readiness evidence

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: none
- Create: experiments/multi-model-ablation/runner-registry.m0.json, experiments/multi-model-ablation/model-snapshot-lock.m0.json
- Test: node experiments/multi-model-ablation/m0-smoke-check.mjs

**Verify**:
- `node experiments/multi-model-ablation/m0-smoke-check.mjs`

**DoneWhen**:
- E1 and E2 provider families are distinct.
- Each runner records `hostKind` separately from `executorSnapshot` and `reviewerSnapshot`.
- Formal Phase 1 launch blockers are explicit if a dated provider snapshot is candidate-only rather than execution-locked.

## CHK-004: Verify budget-lock and analysis contrast mechanics

**Owner**: main-agent
**DependsOn**: CHK-003
**Files**:
- Modify: none
- Create: experiments/multi-model-ablation/cell-manifest.m0.json, experiments/multi-model-ablation/phase1-budget-lock.m0.json
- Test: node experiments/multi-model-ablation/m0-smoke-check.mjs

**Verify**:
- `node experiments/multi-model-ablation/m0-smoke-check.mjs`

**DoneWhen**:
- Cell 6 A2prime rows bind to exactly one frozen budget lock derived from cell 3 calibration rows.
- Legal confirmatory contrasts are cell 3 vs cell 6, cell 1 vs cell 2, and cell 3 vs cell 4.
- Cell 2 vs cell 4 is explicitly rejected as confirmatory because executor and reviewer both change.

## CHK-005: Run verification and close the Research M0 story

**Owner**: main-agent
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004
**Files**:
- Modify: none
- Create: none
- Test: node experiments/multi-model-ablation/m0-smoke-check.mjs

**Verify**:
- `node experiments/multi-model-ablation/m0-smoke-check.mjs`
- Provider-free example checks from `experiments/multi-model-ablation/README.md` still pass.
- Lattice validation evidence records this as M0 readiness, not Phase 1/2 results.

**DoneWhen**:
- Checklist verification evidence covers every happy, edge, and adversarial intent.
- Summary and delivery evidence state no H-M1/H-M3 outcome data exists yet.
- The story can advance through REVIEW, TEST, and DONE without changing product runtime behavior.
