# B-7de9 real-machine acceptance transcript

Run 6ee8f25e2 on Darwin arm64. PLAN outcome (expected) → run → actual → diff.

## Expected (PLAN outcome)
On LATTICE_EXPERIMENT_ARM=control the runtime-memory pack is EMPTY at every JSON surface + final_response_check text suppressed + parallel_dispatch experienceRefs=[] + corpus tools refused; treatment/no-experiment byte-identical (populated).

## Actual — acceptance smokes
```
$ node packages/main/dist/tasks/experience-arm-gate-smoke.js
experience-arm-gate smoke: all cases passed
$ node packages/main/dist/tasks/experience-arm-isolation-e2e-smoke.js
✓ experience-arm-isolation-e2e smoke passed (21 checks)
```

## Actual — live control vs treatment probes
```
# CONTROL done_closure --json (expect empty pack + empty-set digest 4f53cda1...)
  ids: [] digest: 4f53cda18c srcDigests-null: True
# TREATMENT done_closure --json (expect populated)
  ids: ['9890b83', '7ffe281', 'a4d08a8'] digest: 259151dc3d
# CONTROL parallel_dispatch experienceRefs (expect 0)
  experienceRefs: 0
# CONTROL source_lineage_audit (expect refused)
memory retrieval is disabled on the control arm
```

## Diff vs expected
Actual == expected: control packs empty + empty-set digest + null sourceDigests + experienceRefs 0 + corpus tools refused; treatment populated. No discrepancy. Measurement preserved via experience_pack_surfaced event (unchanged). Both smokes + main's B-ab8d smokes green.
