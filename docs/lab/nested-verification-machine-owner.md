# Nested verification machine reservations

This bounded maintenance repair addresses an observed deadlock: an official
verification command held the machine reservation while its isolated Finding
worker lost OS ancestry through intentional orphaning and queued behind that same
reservation. The source-only regression uses the real executor, isolation helper,
and inner executor. Its leaf must both exit successfully and print its selector.
Lab evidence is maintenance evidence, not formal Story DONE or reviewer authority.

## Supported boundary

The machine queue creates the controller only after real admission. On macOS it
holds an unlinked, read-only regular descriptor containing a public bootstrap.
Consumers compare their inherited descriptor's device/inode with the exact
read-only descriptor held by the independently resolved live admitted ticket
owner, using native process and descriptor observations. Both observations also
compare the actual ticket resource declaration. Unknown and finite declarations
are distinct. The signing key stays in the controller process. The ticket does
not independently attest a deadline: the live controller enforces its original
execution deadline and descendant grants cannot extend it.

Descriptor 4 is reserved for this controlled inheritance; descriptor 3 remains
available for native-review attestation or IPC. The environment value is only a
descriptor locator. Missing descriptors, copied bootstrap objects, unsupported or
ambiguous native observations, stale owners, invalid signatures and changed
resource bindings fail closed. This is not socket peer-credential authentication:
the server observes the claimed subject and its enrollment; the consumer checks
its own PID/start, nonce and signed grant. The supported trust boundary is the
registered cooperating executor/fixture chain, not hostile code in the issuer's
own process or a hostile same-user filesystem administrator.

Non-macOS execution retains the existing non-delegated queue path. It does not
claim detached delegation support. Arbitrary shell/npm wrappers that drop the
capability are unsupported; no environment-key fallback repairs a dropped FD.
Resource delegation grants neither Story mutation nor reviewer/provider authority.
The closed verification capsule retains its exact existing leaf environment.

## Controlled child API

Cooperating synchronous descendants forward both
`validationReservationChildEnvironment(env)` and
`validationReservationChildStdio(stdio)`. They remain under a live enrolled
ancestor and must not introduce an unregistered detached boundary.

For a new detached group, call `prepareValidationReservationChild(options)` before
spawn, register the actual returned PID with
`registerValidationReservationChild(pid, pendingToken, options)`, then send the
existing parent-controlled GO. The worker must call
`confirmValidationReservationRegistration(options)` before workload entry.
`options` carries the caller's original absolute `deadlineAt` and optional abort
signal. Handshakes are additionally capped at the registered 5-second startup
limit and remaining reservation time. The executor derives one absolute deadline
from its original configured timeout and uses its remaining time after setup.

`cancelValidationReservationChild(pendingToken, options)` is cleanup-only and
its caller must have proved that no child was spawned. Separately, controller
retirement can resolve an already-observed owned target after fresh PID and
whole-group absence checks. Unknown targets remain fenced.
The executor gives cleanup its own bounded cleanup deadline after workload expiry
or abort; an explicitly expired cleanup deadline still refuses. Cleanup cannot
issue a work grant or extend workload time.

Remote registration and cancellation of a pending token require its private
capability, retained by the invoking module and issuer. That capability is not
published in residual records, environment variables or diagnostics. A claimed
PID and public pending token alone cannot authorize mutation. Enrollment is
immutable; registering the same child again cannot replace its invocation lineage.
All ancestor grants and their deadlines participate in subset and revocation
checks. Conflicting siblings serialize, including while revoked work is stopping.

## Retirement and cleanup

| State or associated work | May resource claims retire? |
| --- | --- |
| Live caller explicitly completes a callback; no associated work remains | Yes; the caller need not exit before its next invocation. |
| Unexpected EOF or holder death; its group still exists | No. |
| Registered descendant group still exists | No, including after normal callback return. |
| Transitive descendant grant remains | No; revocation does not prove completion. |
| Pending registration has no proven target absence | No; unknown work remains fenced. |
| Ownership or process observation is unknown | No. |

A continuous bounded frame parser handles the signed grant and subsequent
revocation frames, including multiple frames in one socket read. Completion uses
an explicit socket-bound terminal release. EOF alone is insufficient. Cleanup
signals only previously observed owned group leaders whose identity still
matches, then requires group absence. The isolated helper also observes its local group before returning, including
standalone use; an outcome file alone does not establish absence.
Unknown residuals retain the machine
reservation and produce a non-PASS cleanup result. This fence applies only to the
machine queue, not unrelated workspace capacity or metadata locks.

### Prior-boot recovery

Unknown pending work cannot be reclaimed from a deadline or owner death alone:
a detached child may still be running. New canonical machine tickets record the
kernel boot-session UUID before atomic publication and before workload entry.
The private boot witness binds the ticket holder, host and OS user separately
from the residual record.

An already-stale ticket can follow the existing atomic quarantine path when its
bounded witness matches the holder and a fresh kernel observation proves a
different boot session. This proves that processes from the recorded boot cannot
remain. The reader rejects missing, malformed, oversized, symlinked or mismatched
witnesses. Same-boot and unavailable observations retain the fence. A live or
unobservable holder PID also retains it, including conservative PID-reuse cases.
Legacy tickets without a boot witness cannot use this recovery path.

The witness uses the existing private ticket-filesystem trust boundary; it is
not cryptographic protection against an actor who can rewrite that private
state. `scripts/verify-nested-reservation-boot-recovery.mjs` exercises actual
pre-publication recording and controlled reader/queue conditions. Those controls
do not claim that the host was rebooted during verification.

### Command result preservation

A typed refusal before launch becomes a non-success infrastructure result.
Ordinary caller errors retain their exception behavior. Cleanup failure preserves
the original error through the cause chain, or retains an already-captured
command result with a bounded cleanup diagnostic; it does not relabel completed
execution as a prelaunch refusal. Reported effective timeout uses the same value
as the armed execution timer, excluding time already consumed by setup.

## Verification boundaries

The named `test:nested-reservation-*` targets in `packages/main/package.json`
are registered individually in normal validation. A closed selector wrapper
normalizes the repository working directory and prints an explicit skip on
unsupported platforms before loading native controls. The entries preserve the
underlying workload limits and declare the existing exclusive machine heavy and
process-fanout resources; private fixture directories do not permit concurrent
machine contention. The original pinned Lab driver remains unchanged.

Static evidence for this route must directly bind the resource configuration,
registered runtime policy and actual loaded implementation helpers. Regression
controls remove individual bindings while keeping the global configuration
fresh, proving that missing direct evidence is rejected. These scanner fixtures
are source-only controls and do not stand in for native behavioral verification.

The originally pinned Lab command remains
`node scripts/verify-nested-verification-machine-owner.mjs`, with its original
60-second Lab cap, 15-second outer executor cases and 1.5-second leaf timeout. It
covers the actual deadlock regression, absent leaf output, sibling/ancestor
nesting, revoked contexts, subset and fixed-port refusal, copied/dropped
capabilities, transitive release/expiry and immutable enrollment.

Supplemental source-bound native fault commands are recorded separately:
`verify-nested-reservation-faults.mjs` modes `registered`, `same-group`, `pending`,
`coalesced`, `finite-owner`, and `pending-lineage`, plus
`verify-nested-reservation-handshake-deadline.mjs`,
`verify-nested-reservation-owner-loss.mjs`, and
`verify-nested-isolated-cleanup.mjs`. They use real queue APIs in a
test-only private OS-home namespace. Fault injection changes only disposable
source-loader inputs or signals the diagnostic's own controlled processes. No
production alternate-pool switch, forged ticket, receipt or authority is used.
Their results must be rerun against the final source/HEAD, separately from the
pinned command; source hashes alone do not claim these behaviors passed.

Cleanup refusal retains a bounded `validation-reservation-cleanup.v1` diagnostic
with the original callback error as its cause, or a bounded snapshot of known
child result fields, including the executor's exact `{completeOutput, result}`
wrapper. The wrapper is read one level deep without general object traversal. It records enrolled PID/start/group identities separately
from current group presence observations; unresolved pending work has no invented
group identity. Accessor properties are not evaluated. This failure-only record
does not relax retirement, add waiting, or identify the retrospective cause of
an earlier generic refusal. `verify-nested-reservation-cleanup-diagnostics.mjs`
uses actual private-home queue admission and deliberately unresolved no-spawn
fences to check error/result preservation and normal unchanged returns.

A short-lived registered target can disappear between separate group, identity
and ancestry observations. After validating pending ownership, parent invocation
lineage and immutable enrollment, a target-observation failure resolves only
that pending token only when independent target PID and whole-group observations
both report ESRCH. The initial absent-target shortcut uses the same predicate.
A live non-leader is refused even when no group exists at its PID. Live or
unknown groups retain the refusal and fence. The registration-race regression
uses an actual detached child and a separate launcher that reaps it at controlled
identity/ancestry observation boundaries; unavailable-observation negatives
remain distinct from actual child disappearance.

### Worker exit without an outcome

The unchanged 60-second target replay stopped during the lifetime group after
four earlier groups passed. Its isolated wrapper subsequently remained alive
while polling a missing outcome under the existing 120-second fixture deadline;
the worker group had already exited. The wrapper eventually exited without a
manual signal or queue-fence removal. This does not establish the cause of the
aggregate target's elapsed time.

The wrapper now checks its previously validated worker group's absence while
waiting. Only the existing ESRCH-only whole-group observer establishes absence.
It rechecks the outcome after that observation, so published outcomes take
precedence. A still-missing outcome fails promptly with captured output through
the unchanged cleanup path; live or unknown groups retain the original wait and
deadline. This does not cover every owner-loss case with surviving descendants.

`node scripts/verify-nested-isolated-worker-exit.mjs` uses an actual worker that
calls `process.exit(7)` before publishing an outcome. The committed pre-repair
control failed because the wrapper was still waiting at the separate six-second
diagnostic limit (6.066747 seconds); after repair it passed in 4.108328 seconds.
The `--normal` control passed in 4.381860 seconds. Both controls independently
observed the worker group absent. These are supplemental controls, not an
aggregate target GREEN or a changed workload budget.

### Generated loader setup cost

An external five-pair, alternating-order comparison of fresh plain Node leaves
measured eager compiler loading at a median of 172.252 ms and lazy loading at 52.809 ms.
All pairs used the same `console.log(12345)` command and a 1500 ms cap. The shared
Lab resolver already uses native TS stripping and does not import the compiler;
only the generated loader now loads the same compiler lazily on its first TS
load-hook call. Compiler options, source bytes, resolver and original target
commands/groups/assertions/deadlines are unchanged. TS-using workers still load
the compiler. This measured local startup saving does not guarantee aggregate
completion within 60 seconds or explain every prior timeout.

The separate `node scripts/verify-nested-source-loader-semantics.mjs` control
checks that a plain leaf does not load the compiler, and compares actual helper
exports, budget value and emitted module hashes against the eager preimage's
semantics. Its semantic checks are separate from the original target; the
five-pair benchmark is not added to that target. The external initial comparison
matched 173 emitted modules. Its exact source fingerprints and all timings are
retained with the Lab report. The modified driver has no existing static-edge
source, evidence or dependency binding, so this change needs no manifest repin.

The external benchmark resolved a compiler filesystem path. Subsequent owner
review identified that the actual driver resolves a file URL: passing that
string directly to `createRequire` was observed to fail with MODULE_NOT_FOUND.
The generated loader therefore converts its exact resolved URL with
`fileURLToPath`; the durable companion uses `import.meta.resolve` as well. The
initial path-based benchmark is not evidence of URL-handling correctness.
