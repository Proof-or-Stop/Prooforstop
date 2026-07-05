# B-fe25 Plan: Multi-Model Ablation M2 Launch Readiness

## Goal

Prepare the provider-free M2 launch-readiness layer for the multi-model ablation replication protocol. This story produces local artifacts and a checker that say which launch blockers are cleared, which blockers remain execution-derived, and why no Phase 1 outcome data exists yet.

## Non-Goals

- Do not run Phase 1 provider cells.
- Do not create `records-multi-model-ablation.jsonl` or any outcome dataset.
- Do not fabricate the ③ A4 calibration budget lock.
- Do not mark ⑥ A2prime sequencing satisfied before real ③ calibration records exist.
- Do not modify `experiments/recovery-runner/tasks`.
- Do not change paper wording, product gates, playbooks, DONE behavior, or runtime guidance.

## Milestone Table

| Milestone | Work | Completion Signal |
|---|---|---|
| M2-R1 | Launch authorization and snapshot readiness | `m2-launch-readiness.json` and `model-snapshot-lock.m2.json` exist and keep provider execution disabled |
| M2-R2 | Concrete task inventory and runner manifest | `task-inventory.m2.json` binds exactly 24 existing task directories, and `phase1-runner-manifest.m2.json` represents required cells ③/⑥/② |
| M2-R3 | Budget and sequencing discipline | `phase1-launch-readiness.m2.json` keeps ③ calibration pending and ⑥ blocked until a real budget lock exists |
| M2-R4 | Status and local verification | `m2-status.md` has the progress table, and `m2-launch-readiness-check.mjs` passes with negative controls |

## CHK-001 Bind M2 launch authorization and dated snapshot inputs

Create:

- `experiments/multi-model-ablation/m2-launch-readiness.json`
- `experiments/multi-model-ablation/model-snapshot-lock.m2.json`
- `experiments/multi-model-ablation/m2-status.md`

Implementation notes:

- Record the user-approved readiness boundary from 2026-07-05.
- Distinguish readiness approval from provider-execution authorization.
- Keep `providerCallsMade=false`, `containsOutcomeData=false`, `phase1OrPhase2CellsRun=false`, and `productGateImpact="none"`.
- Record E1 and E2 as distinct provider families, not host labels.
- Treat dated snapshots as readiness declarations. Actual run metadata remains the responsibility of future M2-a provider execution.

Verification:

- Checker accepts distinct E1/E2 provider families and disabled provider execution.
- Checker rejects host labels used as model families.
- Checker rejects outcome fields or enabled provider calls in readiness artifacts.

## CHK-002 Bind the concrete 24-task inventory and Phase 1 runner manifest

Create:

- `experiments/multi-model-ablation/task-inventory.m2.json`
- `experiments/multi-model-ablation/phase1-runner-manifest.m2.json`

Implementation notes:

- Read the canonical task source from `experiments/recovery-runner/tasks`.
- Bind exactly 24 task directories without editing them.
- Record per-task path and content digest over the stable task files needed to prove identity.
- Preserve M1 required cells ③, ⑥, and ②.
- Keep optional ④ budget-permitting and not required.
- Prevent duplicate runner ownership of the same cell key family.

Verification:

- Checker confirms exactly 24 unique task ids.
- Checker rejects missing/duplicate tasks.
- Checker rejects illegal ② vs ④ confirmatory use.
- Checker accepts required-only Phase 1 readiness when ④ is absent.

## CHK-003 Preserve A4 budget-lock and A2prime sequencing discipline

Create:

- `experiments/multi-model-ablation/phase1-launch-readiness.m2.json`

Implementation notes:

- Do not reuse M0 example budget locks as formal evidence.
- Mark ③ A4 calibration as the next execution step.
- Mark ⑥ A2prime as blocked until the matching ③-derived budget lock exists.
- Keep M2 readiness DONE-compatible while budget lock state remains `pending_execution`.

Verification:

- Checker reports that static readiness is prepared but A2prime sequencing is not satisfied.
- Checker rejects any artifact that claims ⑥ can run before a real ③ budget lock.

## CHK-004 Update M2 status reporting and protocol progress table

Create/update:

- `experiments/multi-model-ablation/m2-status.md`
- `experiments/multi-model-ablation/README.md`

Implementation notes:

- Show M0 and M1 complete.
- Show M2 launch readiness prepared after this story.
- Show formal M2 execution not started.
- Show M3-M6 pending.
- State that H-M1/H-M3 are not proven and no model-agnostic paper claim is unlocked.

Verification:

- `m2-status.md` is readable and explicit about remaining work.
- Checker rejects status text that claims Phase 1 has run or outcome data exists.

## Verification Commands

```bash
node experiments/multi-model-ablation/m2-launch-readiness-check.mjs
node experiments/multi-model-ablation/m0-smoke-check.mjs
node experiments/multi-model-ablation/m1-freeze-check.mjs
lattice validate --story=B-fe25
```

## Expected User-Visible Result

The user can run:

```bash
node experiments/multi-model-ablation/m2-launch-readiness-check.mjs
```

and see a PASS line. The user can open `experiments/multi-model-ablation/m2-status.md` and see exactly what is complete, what is ready, what has not executed, and why ③ calibration and ⑥ A2prime still require the future provider-execution story.
