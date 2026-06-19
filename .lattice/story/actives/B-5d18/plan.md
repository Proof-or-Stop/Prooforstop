# Plan — B-5d18: harden validate with a default per-command timeout

## Overview
A hung/slow validate command currently produces no output until the process-wide 300s idle watchdog (cli-engine.ts) force-exits the WHOLE validate, which skips re-stamping test-evidence.materialHash and silently blocks DONE for all stories. Make the existing per-command SIGTERM/SIGKILL timer (validation-executor.ts) default-on so a hung command fails loud (exit 124, attributed) and validate completes/reports. Diagnosis: the smokes use isolated /tmp locks (no global-lock contention); the hang was transient machine saturation under the concurrent swarm.

## CHK-001 — Bound the slow mutating smokes + record the diagnosis
- Add a per-command `timeoutMs` to `review-pass-discard-smoke` and `init-window-data-loss-smoke` in `lattice.config.json` (convert those two bare-string entries to `{command,args,timeoutMs}` form, e.g. timeoutMs ~120000) so under load they fail loud instead of silently hanging the suite.
- Record in the story that the smokes use isolated /tmp locks (resolveMainRepoRoot returns the tmp repo) — no global main-write-lock contention; the prior hang was transient saturation.
- Verify: the two smokes still pass when run directly on an idle machine.

## CHK-002 — Default per-command timeout in validation-executor.ts
- Introduce `DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS` (~240000, strictly below the cli-engine 300s idle watchdog, above the build's ~160s) and use it when `command.timeoutMs` is unset/<=0 so the SIGTERM/SIGKILL timer ALWAYS arms; keep explicit override.
- The timed-out command must finish with code 124 and an attributable message; SIGKILL escalation after 1s preserved.
- Verify (new packages/main/src/tasks/validate-command-timeout-smoke.ts): a command that sleeps past the ceiling is killed and reported timed-out (exit 124); a fast command completes normally. tsc + node smoke green.
