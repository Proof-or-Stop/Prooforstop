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

Only proven no-spawn rollback may call
`cancelValidationReservationChild(pendingToken, options)`. An expired or
unavailable cancellation is a refusal, not proof of cleanup. Enrollment is
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
| Pending pre-spawn registration is unresolved | No; its record intentionally has no group ID. |
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

## Verification boundaries

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
measured eager compiler loading at a median172.252ms and lazy loading at52.809ms.
All pairs used the same `console.log(12345)` command and1500ms cap. The shared
Lab resolver already uses native TS stripping and does not import the compiler;
only the generated loader now loads the same compiler lazily on its first TS
load-hook call. Compiler options, source bytes, resolver and original target
commands/groups/assertions/deadlines are unchanged. TS-using workers still load
the compiler. This measured local startup saving does not guarantee aggregate
completion within60seconds or explain every prior timeout.

The separate `node scripts/verify-nested-source-loader-semantics.mjs` control
checks that a plain leaf does not load the compiler, and compares actual helper
exports, budget value and emitted module hashes against the eager preimage's
semantics. Its semantic checks are separate from the original target; the
five-pair benchmark is not added to that target. The external initial comparison
matched173 emitted modules. Its exact source fingerprints and all timings are
retained with the Lab report. The modified driver has no existing static-edge
source, evidence or dependency binding, so this change needs no manifest repin.

The external benchmark resolved a compiler filesystem path. Subsequent owner
review identified that the actual driver resolves a file URL: passing that
string directly to `createRequire` was observed to fail with MODULE_NOT_FOUND.
The generated loader therefore converts its exact resolved URL with
`fileURLToPath`; the durable companion uses `import.meta.resolve` as well. The
initial path-based benchmark is not evidence of URL-handling correctness.
