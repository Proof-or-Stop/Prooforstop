# B-73cf Plan

This story fixes only the `validateCostAndTimeoutRisk` dimension from `lattice-workflow-efficiency-baseline-v1`. It does not change Authority, delivery-check, DONE summary, reviewer proof metadata, Codex adapter behavior, deployment, or remote publishing.

## CHK-001

Add an explicit focused validate profile for configured validation commands. The default `lattice validate` path remains full and continues to execute the existing `validate.commands` list. A focused call such as `lattice validate --focus=fast --json` should select only commands marked for that focus profile, and its provider/summary must identify the result as focused so it cannot be confused with final full validation.

Verification:
- Add `packages/main/src/tasks/validate-focused-full-layering-smoke.ts`.
- The smoke should prove focused selection is narrower than full selection.
- The smoke should prove default selection remains full.
- The smoke should prove focused output is labelled as focused.

## CHK-002

Raise the default validate command timeout and project build validate timeout enough to cover the normal full validate envelope with margin while preserving bounded execution. Explicit `timeoutMs` must still override the default, and hung commands must still be killed and attributed as timeout failures.

Verification:
- Update `validate-command-timeout-smoke.ts` expectations.
- Re-run the focused timeout smoke and package build.
- Do not remove process-group kill or timeout diagnostics.

## CHK-003

Write a derived result artifact under `experiments/baselines/` for baseline item 1. It must reference `baselineId=lattice-workflow-efficiency-baseline-v1` and story `B-73cf`, and it must not rewrite the original baseline JSON. The result may report expected time savings as a projection, but the proof must be behavior and policy correctness, not wall-clock time alone.

Verification:
- JSON parses.
- It names the baseline id and story id.
- It states that full validation and DONE-required validation remain required.
