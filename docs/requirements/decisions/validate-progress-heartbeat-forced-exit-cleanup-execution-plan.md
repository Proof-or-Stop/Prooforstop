# Validate Progress Heartbeat And Forced-Exit Cleanup Execution Plan

## Purpose

Proof-or-Stop keeps an idle watchdog to prevent lifecycle commands from hanging forever. This is correct.

The current failure mode is different: `story_advance --phase=TEST` invokes `lattice validate --json`, and `validate` may run many configured commands for several minutes without emitting progress. The CLI idle watchdog interprets silence as stuck work and kills the process, even though validation may still be running normally.

This story fixes the mismatch between validate progress and CLI idle detection.

## Problem Statement

Current behavior:

```text
story_advance --phase=TEST
  -> lattice validate --json
  -> running 42 configured validate.command(s)
  -> no output for about 5 minutes
  -> story_advance stuck: 300 seconds without output; forcing exit
```

Observed consequences:

| Problem | Impact |
|---|---|
| Normal long validation is killed | REVIEW -> TEST cannot complete |
| Validation lock remains | Later validate runs are blocked by stale lock |
| `test-evidence.json` may record infra failure | Looks like test failure when it is lifecycle runner failure |
| Agent retries blindly | Wastes time, tokens, and user attention |
| User cannot see progress | Appears as if work is stuck or looping |

## Design Principle

Keep the idle watchdog. Do not remove fail-closed protection.

Instead, make real validation progress visible.

```text
validate command starts
  -> command i/n started
  -> heartbeat every 30s while command is still running
  -> command i/n passed / failed / timed out
  -> CLI lastActivity refreshes on each heartbeat
```

The watchdog should kill only true silence, not valid long-running work.

## Output Stream Contract

`lattice validate --json` must keep stdout machine-readable.

Progress and heartbeat events must not corrupt the final JSON payload. In JSON mode, they should be emitted through stderr or another structured side channel consumed by the parent lifecycle command. Human-readable mode may print progress to stdout.

Every progress or heartbeat event must be flushed immediately. A heartbeat that remains trapped in a pipe buffer does not refresh parent `lastActivity` and does not solve the idle-timeout bug.

## Timeout Model

| Timeout | Meaning | Behavior |
|---|---|---|
| Idle timeout | Time since last CLI output / heartbeat | Kills only if no heartbeat is emitted |
| Command timeoutMs | Per validate command wall-clock limit | Kills that command and reports exact command |
| Grace period | Time allowed for child self-cleanup after termination request | Parent requests graceful shutdown first, waits briefly, then escalates only if needed |
| Max timeout | Absolute command/lifecycle upper bound | Kills even if heartbeats continue forever |

Example:

```text
Idle timeout = 5 minutes

T+0:00 command starts
T+0:30 heartbeat
T+1:00 heartbeat
T+4:30 heartbeat

After T+4:30, idle timeout resets.
Next idle deadline is T+9:30.
```

Heartbeat extends idle liveness, not total execution permission.

## Milestone Ledger

| Milestone | Status | Goal | Evidence |
|---|---|---|---|
| M0 Red Repro | Not Started | Reproduce current failure: long silent validate command gets killed by idle watchdog | Red test shows `stuck: 300 seconds without output` |
| M1 Validate Progress Events | Not Started | Emit command start/end progress for every validate command without corrupting JSON stdout | Output includes command index, total count, label, elapsed time; `--json` stdout remains parseable |
| M2 Long Command Heartbeat | Not Started | Emit flushed heartbeat every 30s while a validate command is still running | Long command exceeds idle timeout without being killed; heartbeat reaches parent in real time |
| M3 Timeout Diagnostics | Not Started | Report exact command on timeout | Failure includes command index, args, timeoutMs, elapsed |
| M4 Forced-Exit Cleanup | Not Started | Avoid active-looking stale validation locks after forced exit | Stale lock detection is resilient to PID reuse and host differences |
| M5 Evidence Classification | Not Started | Distinguish infra failure from test failure in evidence | `test-evidence.json` records `infra_failure` separately |
| M6 Story Advance Integration | Not Started | `story_advance --phase=TEST` consumes validate heartbeat correctly | REVIEW -> TEST no longer dies from validate silence |
| M7 Safety Regression | Not Started | Confirm true hangs still fail closed | Negative controls still timeout or fail |

## Implementation Guards

- JSON-mode progress must use stderr or a structured parent-consumed side channel; stdout remains reserved for the JSON result.
- Progress and heartbeat writes must flush immediately.
- Validation lock ownership must not rely on PID alone. Use `pid + processStartTime`, a per-run UUID, or an OS-level lock handle so PID reuse does not make stale locks look active.
- Lock liveness checks must be host-neutral. POSIX-only `/proc` checks are insufficient unless wrapped behind a platform abstraction.
- Forced exit should use a two-stage shutdown: request graceful termination, allow a short cleanup grace period, then hard-kill only if the child remains alive.
- Evidence written after forced exit must identify runner infrastructure failure separately from test failure.

## Acceptance Criteria

- `lattice validate --story=<id> --json` emits progress for configured commands.
- `--json` stdout remains valid JSON; heartbeat/progress events do not pollute the machine-readable result.
- Heartbeat/progress events are flushed immediately and are visible to the parent process before the idle deadline.
- Long-running validate commands emit heartbeat at a bounded interval, preferably 30 seconds.
- `story_advance --phase=TEST` is not killed while validate is actively heartbeating.
- A command that exceeds its own `timeoutMs` still fails.
- Failure output identifies the exact validate command that failed or timed out.
- Forced exit does not leave a fresh-looking validation lock for a vanished process.
- Stale lock detection is resilient to PID reuse and works through a host-neutral abstraction.
- Watchdog termination allows child cleanup before hard kill.
- Infra failure is not recorded as ordinary test failure.
- Existing gate strictness is preserved.

## Non-Goals

- Do not remove the idle watchdog.
- Do not make validate pass when tests fail.
- Do not skip `lattice validate`.
- Do not reduce configured validate commands.
- Do not use unlimited timeout.
- Do not rely on POSIX-only process checks without a host-neutral wrapper.
- Do not change unrelated story behavior.

## Recommended Execution Order

1. Add a red smoke proving silent validate is currently killed.
2. Add validate command start/end progress events.
3. Add the JSON-safe output stream contract and immediate flush behavior.
4. Add long-command heartbeat.
5. Add timeout diagnostics for individual commands.
6. Harden validation lock cleanup / stale classification.
7. Fix evidence classification for infra failures.
8. Verify `story_advance --phase=TEST` with a long-running validate fixture.
9. Run regression controls proving real hangs still fail closed.


## B-c163 convergence contract (implemented)

- Closeout segments check the parent watchdog before and after each segment and await cooperative abort cleanup. Synchronous JavaScript is inherently non-preemptible, so it stops at the first deadline/checkpoint boundary. Pure in-process closeout segments spawn no descendants, making process-tree ESRCH evidence not applicable there; descendant cleanup is required and tested only for validation/phase paths that actually spawn children.

DONE-required execution and reuse use one bounded contract:

- The DONE-required phase budget is the safe sum of effective sequential command timeouts plus bounded grace. A phase-specific override wins the global phase override, which wins the derived budget. The direct `done_required_validate` CLI max covers that derived phase; the `done_prepare` CLI max covers routine validation plus every enabled closeout phase. An explicit `LATTICE_MAX_TIMEOUT_MS` remains authoritative. Each effective command timeout is capped at Node's maximum legal timer delay before arming the real timer, so a huge configured value cannot overflow into an immediate timeout. Structured `failed` / `timed_out` / `blocked` results remain parseable on stdout and exit nonzero; routine `done_prepare` idle/max aborts use the same terminal timeout shape and release child processes, timers, and locks for an immediate rerun.
- `done_prepare` defaults `reuseFreshDoneRequired=true`, independently of post-closeout `reuseFreshValidation`. Reuse requires the canonical DONE-required evaluator to pass and evidence HEAD to equal current HEAD, or be its ancestor with every path touched by every intervening commit classified as trusted story metadata (including modify-then-revert history). HEAD must remain unchanged across evaluation. Any code, config, non-metadata, non-ancestor, unreadable evidence/lineage, or concurrent HEAD movement refuses reuse.
- `validate:false` means `disposition=skipped_explicitly` and `result=not_run`; it neither executes nor reuses nor manufactures evidence, while reporting `existingEvidenceBasis=fresh|stale|missing`. Executed and reused paths report `disposition`, `result`, `refusalReasons`, and any `timeoutLayer` in human and JSON output.
- Progress and heartbeat output uses stderr/the logging side channel, never JSON stdout. Reporter failures are diagnostic-only. Heartbeats refresh idle liveness only; command, phase, idle, and absolute max deadlines, child-tree termination, lock release, and timer cleanup remain independent.
