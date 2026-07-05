# Plan: B-11be Multi-Model M2 Provider Authorization Metadata

## Goal

Record a metadata-only, authorized-but-bounded launch layer for the Multi-Model
Ablation M2 provider execution track without running provider cells.

The user-visible outcome is a status table that says:

```text
M2-provider authorization metadata: Done
Provider spend in B-11be: USD 0.00
Provider cells run in B-11be: none
Result rows present: none
Next formal provider-execution story: cell 03 calibration
Cell 06 A2prime: blocked until a real cell-03-derived budget lock exists
```

## Non-Goals

- Do not run provider cells.
- Do not create outcome rows or result rows.
- Do not enable cell 06.
- Do not unlock H-M1, H-M3, model-agnostic wording, paper claims, or product
  gates.
- Do not treat host labels such as Codex CLI, Claude Code CLI, Antigravity CLI,
  or agy as provider model snapshots.
- Do not touch B-8128 capability-lineage work or unrelated Tier-C docs.

## CHK-001: Define Authorized-But-Bounded Launch Metadata Artifact

Files:

- Create `experiments/multi-model-ablation/m2-provider-execution-authorization.json`.
- Modify `experiments/multi-model-ablation/m2-provider-execution-check.mjs`
  only as needed to read and validate the new artifact.

Implementation:

- Add an authorization artifact with stable fields for:
  - human approval source and date;
  - approved story id `B-11be`;
  - provider budget cap `USD 0.00`;
  - execution window `2026-07-05 through B-11be DONE`;
  - approved cell scope: metadata/checker/docs for cell 03 boundary only;
  - provider call state disabled;
  - result/outcome rows absent;
  - cell 03 marked as the next separately budgeted step;
  - cell 06 marked blocked until a real cell-03-derived budget lock exists.
- Keep dated provider model snapshots as future execution metadata, not host
  labels and not fabricated values.

Acceptance:

- `test -f experiments/multi-model-ablation/m2-provider-execution-authorization.json`
  passes.
- The artifact records USD 0.00 provider budget and no provider calls.
- The artifact does not claim real model snapshots or result rows.

## CHK-002: Update Provider Execution Checker

Files:

- Modify `experiments/multi-model-ablation/m2-provider-execution-check.mjs`.

Implementation:

- Teach the checker to load the new authorization artifact.
- Preserve the existing disabled launch checks for `m2-provider-execution-launch.json`.
- Add a separate metadata-only authorization validation path:
  - required metadata fields must be present in the new artifact;
  - provider calls must remain disabled for B-11be;
  - provider fallback must remain rejected;
  - host-label-only snapshots remain invalid;
  - no result/outcome row path may appear;
  - cell 06 remains blocked unless a real cell-03-derived budget lock is
    present, which is out of scope for this story.
- Add negative controls in the checker for:
  - missing budget cap;
  - nonzero budget cap in B-11be;
  - host label used as provider snapshot;
  - providerCallEnabled flipped to true;
  - cell 06 unblocked;
  - outcome/result record path present.

Acceptance:

- `node experiments/multi-model-ablation/m2-provider-execution-check.mjs` passes.
- Existing M0/M1/M2 readiness checkers still pass.
- No provider CLI command is invoked.

## CHK-003: Update M2 Status Documentation

Files:

- Modify `experiments/multi-model-ablation/m2-status.md`.
- Modify `experiments/multi-model-ablation/README.md`.

Implementation:

- Update status docs to show that B-11be records metadata-only authorization.
- State explicitly:
  - provider spend is USD 0.00;
  - provider calls were not made;
  - no result rows or outcome rows exist;
  - cell 03 calibration is the next separately budgeted provider-execution story;
  - cell 06 remains blocked;
  - no H-M1/H-M3/model-agnostic/paper/product-gate claim is unlocked.

Acceptance:

- Docs mention `m2-provider-execution-authorization.json`.
- Docs do not claim provider execution happened.
- Docs do not claim Phase 1 results or product gate impact.

## Verification

Run local-only checks:

```bash
node experiments/multi-model-ablation/m0-smoke-check.mjs
node experiments/multi-model-ablation/m1-freeze-check.mjs
node experiments/multi-model-ablation/m2-launch-readiness-check.mjs
node experiments/multi-model-ablation/m2-provider-execution-check.mjs
```

Expected:

- all commands pass;
- no provider calls are made;
- no result rows are created;
- checker output still reports cell 03 as next and cell 06 blocked.

## Status Reporting

After each milestone, report a visible table with these statuses:

- Done
- In Progress
- Pending Review
- Not Started
- Blocked
- Failed

The final user-facing table must distinguish:

- metadata authorization done;
- actual provider execution not started;
- cell 03 next;
- cell 06 blocked;
- Phase 1/M3/M4/M5/M6 still pending real data.
