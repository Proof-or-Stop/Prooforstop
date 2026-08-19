# Plan: B-7dff Run the routine validate command plan through the keyed parallel scheduler

Baseline to beat, measured twice independently (B-3434 test-evidence 2026-08-16T22:58, B-d0b8
test-evidence 2026-08-17T00:09): 858s serial total across 99-102 commands, with
`quorum-submit-smoke.js` at 267-271s as the critical-path floor. Target is that floor, not better.

Execution order is strictly serial across checklist items: CHK-001 -> CHK-002 -> CHK-003 -> CHK-005
-> CHK-004. CHK-005 was added during DEV once CHK-003 measured the real outcome, and CHK-004 runs
last because it measures the final state rather than an intermediate one.
Two implementers must never run at once in this worktree, even on disjoint files, because they share
one git index and auto-commit path.

## CHK-001: Extract the full-suite keyed scheduler into a core module shared by both callers

**Owner**: lattice-implementer
**DependsOn**: none
**Files**:
- Create: `packages/main/src/core/keyed-scheduler.ts`
- Modify: `packages/main/src/tasks/full-suite-runner.ts`
- Test: `packages/main/src/tasks/full-suite-runner-smoke.ts` (existing, must stay green)

**Verify**:
- `npm --prefix packages/main run build` exits 0
- `npm run test:full-suite-runner-smoke` passes
- `npm test` prints `full-suite: 47/47 passed in <N>s; retries=0; jobs=4`

**DoneWhen**:
- `runScheduled`, `ResourceClaim`, `ResourceClass`, `claimsConflict`, `validateResourceClaims` and
  claim canonicalization live in core; `full-suite-runner.ts` imports them and defines none of them.
- Scheduler run state (`activeChildren`, `interruptSignal`, `schedulerCancellationReason`,
  `terminalFailureName`) is per-run, not module-level. Two schedulers running concurrently do not
  observe each other's cancellation.
- The scheduler takes an explicit cancellation policy. `cancel-on-first-failure` reproduces today's
  full-suite behaviour; `run-all` lets every entry finish. Full-suite keeps `cancel-on-first-failure`.
- Result order is still restored to input order.

## CHK-002: Declare a resource claim for every configured validate command, failing closed when undeclared

**Owner**: lattice-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: `packages/main/src/core/validation-types.ts` (claim field on `ValidationCommand`)
- Modify: `lattice.config.json` (claims for the configured commands)
- Modify: `packages/main/src/core/validation-executor.ts` (claim resolution + fail-closed default)
- Test: new logic test under `packages/main/tests/`

**Verify**:
- A command with no declared claim resolves to a single exclusive claim on a synthetic key
- Two commands with disjoint declared claims are admitted together
- An unrecognised resource class is rejected at declaration time

**DoneWhen**:
- Every entry in `validate.commands` either carries a declared claim or is demonstrably scheduled
  exclusively by the fail-closed default.
- The default is exclusive. There is a test that asserts an unclassified command never overlaps
  another command.
- Commands that write under `.lattice/`, take a fixed port, or touch the git common dir carry claims
  in the matching class, mirroring `RESOURCE_POLICY` in the full-suite runner.

## CHK-003: Replace the sequential loop in executeValidationPlan with the shared scheduler, preserving evidence semantics

**Owner**: lattice-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: `packages/main/src/core/validation-executor.ts` (`executeValidationPlan`)
- Test: new logic test under `packages/main/tests/`

**Verify**:
- `node bin/lattice.js validate --json` on a small fixture plan returns `commands[]` in plan order
  with unchanged per-entry fields
- A plan whose middle command fails still produces `commands[].length === plan.commands.length`
- An exceeded `deadlineAt` still throws the deadline error rather than returning a partial pass

**DoneWhen**:
- Routine validate uses the `run-all` cancellation policy: one failing command never cancels the rest.
- `commands[]` and `details[]` are emitted in plan order regardless of completion order; `details`
  entries are buffered per command instead of pushed inline.
- `durationMs`, `code`, `timedOut`, `optional`, `commandExecution` counts,
  `routineValidationIdentity` and `identityDigest` keep their existing shape and meaning.
- `progress` / `heartbeatMs` reporting still identifies each command, and `abortSignal` /
  `deadlineAt` / `deadlineError` propagate to every concurrently running command.

## CHK-004: Prove parallel equals serial on the real plan and record the measured makespan

**Owner**: lattice-implementer
**DependsOn**: CHK-003
**Files**:
- Create: `packages/main/src/tasks/validate-parallel-equivalence-smoke.ts`
- Modify: `package.json` (register the script), `lattice.config.json` (add to validate.commands)

**Verify**:
- `npm run test:validate-parallel-equivalence` prints `serial=<N>s parallel=<N>s speedup=<N>x`
- The smoke fails when a command's outcome differs between modes
- The smoke fails when two conflicting commands are observed overlapping

**DoneWhen**:
- One run measures the same plan both ways on the same host, so the comparison is not across
  machines or load conditions.
- Per-command pass/fail sets are asserted identical; a difference fails the smoke.
- Observed overlap between two conflicting claims fails the smoke rather than being reported as a
  faster run.
- The printed speedup is the measured one. No hardcoded 3.17x.

## CHK-005: Classify the heavy validate commands so the fail-closed default stops dominating the makespan

Added during DEV after CHK-003 measured the real outcome. Kept in this story because without it the
story delivers no speedup at all; the original four items build the mechanism, this one supplies the
input that mechanism needs.

**Owner**: lattice-implementer
**DependsOn**: CHK-003
**Files**:
- Modify: `lattice.config.json`
- Test: `packages/main/tests/validate-resource-claims.test.mjs`

**Measured starting point** (two full `validate --json` runs, same host, CHK-003):

| | wall | sum(durationMs) | undeclared barrier | declared |
|---|---|---|---|---|
| jobs=1 | 1056s | 1054.4s | 1005.2s | 49.2s |
| jobs=4 | 1006s | 1030.4s | 982.4s | 48.1s |

68 of 104 commands are undeclared and hold the plan-wide barrier, carrying 982.4s of the 1030.4s of
work. The infinite-worker floor under current claims is 1003.8s and the achieved makespan is 1006s,
so the scheduler is within 0.2% of optimal. Declaration coverage is the only remaining lever.

**Verify**:
- A real `node bin/lattice.js validate --json` run prints `validate scheduler: jobs=<N> commands=<N> declared=<N> exclusiveByDefault=<N>` with a declared count materially above 36
- Wall time on the same host is below the 1006s recorded at 36 declarations
- A collision probe fails if a declared command actually writes a repo-shared path

**DoneWhen**:
- Each newly declared command has a stated reason it is safe: it writes only inside a per-process
  temp root, or it is provably read-only against the repo.
- Every command that could NOT be proven isolated is still a barrier and is NAMED in the report as
  still-unclassified. Under-declaring is the correct outcome for anything uncertain; the fail-closed
  default from CHK-002 must not be weakened, and no command may be declared to improve the number.
- `packages/main/src/tasks/quorum-submit-smoke.ts` is untouched. If it stays a barrier, the report
  says so and states the floor it imposes.
- The report states the measured before/after wall time on the same host, not a projection.
