# Plan: B-fc0f

This story resolves five validation and floor-assurance blockers that repeatedly block DONE convergence.

## CHK-001
- Keep the CLI JSON stdout contract smoke non-hanging and enforce direct-JSON parsing behavior.
- In DEV/TEST, execute `packages/main/src/tasks/cli-json-stdout-contract-smoke.ts`.
- If `validate --json` hangs, isolate which command in the task deadlocks and patch child process handling (timeout / stream close / stdin control).
- Ensure `authority_status` and `host_list` JSON formats remain direct-parseable.
- Evidence: updated smoke assertions and a green task run.

## CHK-002
- Keep `field-regression-cli-smoke.ts` section headers aligned to active validator requirements: `Key Insights`, `Solution Tradeoffs`, `Conversational Texture`.
- Preserve hotfix-priority assertion behavior.
- Evidence: single-task run and no story-create header mismatch failures after run.

## CHK-003
- Preserve explicit visibility when `autopilot_review_submit` receives incomplete binding fields (`materialDigest`, `validationDigest`, `promptDigest`).
- Add strong warning text for incomplete submits and keep submission path non-blocking (no silent ignore).
- Evidence: local dry-runs with missing bindings and note text in persisted verdict.

## CHK-004
- Triage recurring pre-existing main smoke failures: `english-open-source-surface-smoke`, `prompt-token-cost-smoke`, `global-agents-init-smoke`.
- Determine which failures are fixtures/regressions and record root cause with explicit status per smoke.
- Evidence: command logs + issue notes attached to CHK-004.

## CHK-005
- Align DONE review-assurance diagnostics with `review_escalation_status` for degraded 3x1 fallback semantics when high-risk floor is satisfied by explicit degraded fallback.
- Ensure DONE closure text/rules do not report contradictory blocked-state on satisfied degraded floors.
- Evidence: local repro with 3 degraded single-host rounds and `lattice done_prepare` pass on assurance row.

## Execution boundary
- Scope: only this story’s checklist files plus relevant core review/verification handlers.
- Skip broad validator rewrites or production/deployment config changes.
- Stop condition: all 5 checklist items have done evidence, tests pass, and TEST/lifecycle gates are clear.
