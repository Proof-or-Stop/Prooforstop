# B-785e Plan

## Scope

Prepare the Multi-Model Ablation M2 provider execution launch layer. This story
does not run provider cells, does not spend provider budget, does not produce
Phase 1/Phase 2 outcome rows, and does not unlock paper claims.

The deliverable is an auditable launch plan plus local artifacts that preserve:

- provider execution disabled by default;
- host labels separated from provider model snapshots;
- cell 03 E2 A4 same-family calibration before cell 06 A2prime;
- no H-M1/H-M3/model-agnostic claim until real records exist.

## CHK-001 - Write The M2 Provider Execution Launch Plan

Files:

- Create `docs/requirements/decisions/multi-model-ablation-m2-provider-execution-plan.md`.

Execution:

- Explain why the document exists: M0/M1/M2 readiness is prepared, but provider
  execution is still disabled and formal M2 cells have not run.
- Include a milestone table for M0, M1, M2 readiness, M2 launch, cell 03
  calibration, budget-lock freeze, cell 06 sequencing, cell 02 cross-review,
  optional cell 04, M3, M4, M5, and M6.
- State exact ordering: launch gate first, cell 03 calibration second, real
  budget lock third, cell 06 only after the lock.
- State explicit non-claims: no outcome data, no H-M1/H-M3 proof, no product gate
  impact, no model-agnostic wording unlock.

Verification:

- The doc contains the terms `providerExecutionAuthorized=false`,
  `nextPermittedFormalStep=cell-03-calibration`, and
  `cell-06-a2prime-blocked`.
- The doc rejects host-label-only snapshots and provider fallback.

## CHK-002 - Add Formal Launch Authorization And Runner Readiness Artifacts

Files:

- Create `experiments/multi-model-ablation/m2-provider-execution-launch.json`.
- Update `experiments/multi-model-ablation/m2-status.md`.

Execution:

- Encode a disabled-by-default launch state.
- Record required authorization fields as missing blockers instead of guessing:
  human approval, dated executor snapshot, dated reviewer snapshot, prompt
  digest, tool-surface digest, runner ownership, budget cap, duplicate policy.
- Represent cell 03 as the next permitted formal step only in planning mode.
- Keep provider calls disabled and result rows absent.

Verification:

- The artifact has `providerExecutionAuthorized=false`.
- It has no outcome records and no provider-call enabled runner.
- It marks cell 06 blocked until a real cell-03-derived budget lock exists.

## CHK-003 - Define Cell 03 Calibration And Budget-Lock Verification

Files:

- Create `experiments/multi-model-ablation/m2-provider-execution-check.mjs`.
- Update `experiments/multi-model-ablation/README.md`.

Execution:

- Read the existing M2 readiness artifacts plus the new launch artifact.
- Validate research boundary fields remain false or none:
  `providerCallsMade=false`, `containsOutcomeData=false`,
  `phase1OrPhase2CellsRun=false`, and `productGateImpact=none`.
- Validate provider execution is disabled unless all required authorization
  fields are present.
- Validate host labels such as Codex CLI and Claude Code CLI are not accepted as
  model snapshots.
- Validate cell 03 is the next formal step and cell 06 is blocked without a real
  budget lock.
- Include in-memory negative controls for accidental authorization and
  host-label snapshots.

Verification:

- `node experiments/multi-model-ablation/m2-provider-execution-check.mjs` passes.
- The command output names `nextPermittedFormalStep=cell-03-calibration`.
- The command output names `cell-06-a2prime-blocked`.

## CHK-004 - Run Local Validation And Publish Milestone Status

Files:

- Update `experiments/multi-model-ablation/m2-status.md`.

Execution:

- Run local checks only:
  - `node experiments/multi-model-ablation/m0-smoke-check.mjs`
  - `node experiments/multi-model-ablation/m1-freeze-check.mjs`
  - `node experiments/multi-model-ablation/m2-launch-readiness-check.mjs`
  - `node experiments/multi-model-ablation/m2-provider-execution-check.mjs`
- Update the status table with completed and blocked rows.
- Keep formal M2 execution marked as not started unless real provider records
  exist.

Verification:

- All four local commands pass.
- Status table shows no claim unlock and no product gate impact.
- Main checkout unrelated dirty files are not modified by this story.

## Dependency Order

1. CHK-001
2. CHK-002
3. CHK-003
4. CHK-004

## Stop Conditions

Stop and ask for explicit approval if any step would:

- call an external provider;
- run the full Phase 1 or Phase 2 matrix;
- mark `providerExecutionAuthorized=true`;
- write outcome rows;
- reinterpret host labels as model snapshots;
- modify Tier-C quorum documents or unrelated active-story files.
