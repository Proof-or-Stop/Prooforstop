# B-b8c8 Plan

This story closes the recovery-runner accounting / A2-prime compute-matching gap by verifying the already-implemented runner behavior, then synchronizing paper-facing wording to the same spend-matched semantics.

## CHK-001
Confirm `run-recovery.mjs` counts every executor/reviewer call in `agentCallCount` and persists the canonical §7 run-record fields.

Files: `experiments/recovery-runner/run-recovery.mjs`, `experiments/recovery-runner/spend-accounting-selfcheck.mjs`

Checks: selfcheck assertions for executor/reviewer increments, record-field presence, and zero-live-LLM execution.

## CHK-002
Confirm `run-ablation.mjs` derives A2-prime budgets from A4 medians, and that `budgetPass` requires both token and wall-clock to stay inside the ±20% band.

Files: `experiments/recovery-runner/run-ablation.mjs`, `experiments/recovery-runner/spend-accounting-selfcheck.mjs`

Checks: median derivation, spend-budget caps, `budgetPass` symmetry, and fail-closed boundary behavior.

## CHK-003
Align the recovery-runner comments and companion paper wording to the spend-matched A2-prime semantics.

Files: `experiments/recovery-runner/run-recovery.mjs`, `experiments/recovery-runner/run-ablation.mjs`, `experiment-protocol.md`, `paper/main.tex`

Checks: no stale call-count wording remains in the implementation narrative; the paper protocol appendix matches the same spend-matched definition.

## CHK-004
Verify the story without live LLM calls.

Files: `experiments/recovery-runner/spend-accounting-selfcheck.mjs`

Checks: the no-LLM selfcheck passes, the helper suite remains pure, and the runner/accounting API remains stable.
