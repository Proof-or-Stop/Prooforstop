# B-2fb7 Plan

## Goal
Fix validate/lifecycle coordination so active long-running validation reports progress before the CLI idle watchdog fires, while preserving fail-closed timeout behavior and parseable JSON stdout.

## Constraints
- Keep the lifecycle idle watchdog and per-command timeoutMs semantics intact.
- In --json mode, stdout remains a single parseable JSON payload; progress and heartbeat go to stderr or another parent-visible side channel.
- Heartbeat refreshes idle liveness only; it must not reset command timeoutMs or max lifecycle timeout.
- Stale validation locks must be reclaimed only when the holder is vanished or mismatched; active holders are not stolen.
- Runner/watchdog infrastructure failures are classified distinctly from ordinary validation/test assertion failures.

## Non-Goals
- Do not remove, disable, bypass, or weaken the lifecycle idle watchdog.
- Do not skip lattice validate, reduce configured validate commands, or mark failing tests as passing.
- Do not use unlimited timeout or let heartbeat extend a command timeoutMs wall-clock ceiling.
- Do not rely on POSIX-only /proc checks without a host-neutral abstraction.
- Do not change unrelated story lifecycle behavior, reviewer gates, DONE gates, dispatch behavior, or OMX/.omx material.
- Do not present local diagnostics as remote authority receipts or production/full completion.

## Rollback
All changes are local to validate execution, CLI watchdog integration, validation lock handling, evidence classification, task smokes, and the related execution-plan doc. If regressions appear, revert the B-2fb7 commits on story/B-2fb7 before REVIEW, rerun the red repro to confirm the baseline failure, and leave the story in DEV with findings rather than weakening gates.

## CHK-001 Add red repro for silent validate idle-kill
- Record the existing red evidence: a temporary project with one 12s silent validate command and LATTICE_IDLE_TIMEOUT_MS=1000 is killed by the CLI idle watchdog before timeoutMs.
- Restore the related execution-plan document on the story branch so relatedDocs resolves for reviewers and later evidence.
- Add a durable smoke task that expresses this red/green relation without waiting five minutes by using small env-controlled heartbeat and idle intervals.
- Ensure the repro fails only when the heartbeat/progress fix is absent; it must not pass by disabling the watchdog, skipping validate, or using unlimited timeout.

## CHK-002 Implement JSON-safe progress and heartbeat
- Extend validation-executor with a typed progress reporter for command-start, heartbeat, command-end, and timeout events.
- Emit validate progress to stderr in JSON mode and keep stdout reserved for the final JSON payload.
- Add a heartbeat interval with a production default near 30s and an env override for fast smokes.
- Keep timeoutMs measured from command start so heartbeat never extends the command timeout.

## CHK-003 Harden forced-exit cleanup and stale-lock classification
- Reuse the existing two-stage SIGTERM then SIGKILL command cleanup where possible.
- Strengthen validation lock liveness so a lock is not considered live solely from a reused PID or fresh mtime.
- Add host-neutral holder identity checks using recorded hostname, pid, acquiredAt, and process start/liveness metadata where available, with graceful fallback.
- Cover vanished owner, live owner, and mismatched/PID-reuse-style stale owner cases.

## CHK-004 Classify runner infrastructure failure separately from test failure
- Introduce or propagate an infra_failure classification for watchdog/runner timeouts and forced exits.
- Preserve ordinary validation command failures as validation/test failures.
- Ensure persisted test evidence or validation result details expose the distinction clearly enough that users do not debug product tests for runner failures.

## CHK-005 Verify story_advance TEST integration and safety regressions
- Build the worktree dist and run focused smokes for validate heartbeat, JSON stdout cleanliness, timeout diagnostics, lock staleness, and infra-failure classification.
- Prove the parent lifecycle process receives heartbeat output before the idle deadline.
- Prove true hangs still fail closed through per-command timeout or max lifecycle timeout.
- Record verificationEvidence for every authored verificationIntent before REVIEW.
