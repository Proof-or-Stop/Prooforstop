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
claim detached delegation support. On macOS every Node-spawned child receives
only its explicitly listed stdio descriptors, so a plain wrapper such as `npm run`
or a runner spawning with `stdio: 'inherit'` drops the reserved descriptor while
the locator environment survives. That state is classified as a dropped
transport: the descendant is diagnosed once on stderr
(`VALIDATION_DELEGATION_UNAVAILABLE`), runs without a borrowed reservation
exactly as before delegation existed, and forwards no locator. Nothing is repaired
from the environment, and a regular file at the reserved slot is never downgraded:
a copied bootstrap stays refused. The repository's own
`scripts/run-validation-fixture-suite.mjs` is a cooperating wrapper and forwards
the descriptor explicitly; npm-wrapped fixture targets remain non-delegated, which
is their pre-existing behavior on main.
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
| Pending registration never recorded a proven target and its preparing owner is dead | No; a child may have been spawned before the owner died, so the fence is terminal until a different-boot witness or explicit operator action. |
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

A pending row records its proven registration target only after identity, group
leadership and pre-orphan ancestry are observed. Transient kernel observation
failures during registration are retried a bounded number of times
(`observationRetries` with `observationBackoffMs` in the registered runtime
policy) before the registration is refused, so a single `ps` hiccup does not
strand a targetless token. A token that still ends targetless because its owner
died between prepare and registration, or because every bounded observation
failed, cannot be resolved by owner death alone: a detached child may already
exist. `proof-or-stop doctor` lists such tickets under "Nested reservation
fences" with the count of unresolved pending rows and dead owners. Recovery is
the different-boot witness path after a reboot, or removal of the ticket
directory only after an operator has independently confirmed that no detached
child remains; the tool never releases it automatically.

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
state. The ticket directory is published with the registered private directory
mode, because the reader refuses any ticket readable by group or others; an
earlier candidate created it with the process default mode, which left the
recovery branch unreachable on the public path while a hand-made 0o700 fixture
still passed. `scripts/verify-nested-reservation-boot-recovery.mjs` therefore
evaluates the reader against the actually published ticket under controlled
kernel observations, in addition to its pre-publication recording and
controlled reader/queue matrix; against the unfixed publication it fails with
MACHINE_TICKET_PRIVATE_DIRECTORY_MODE_REQUIRED. Those controls do not claim that
the host was rebooted during verification.

### Command result preservation

A typed refusal before launch becomes a non-success infrastructure result.
Ordinary caller errors retain their exception behavior. Cleanup failure preserves
the original error through the cause chain, or retains an already-captured
command result with a bounded cleanup diagnostic; it does not relabel completed
execution as a prelaunch refusal. Reported effective timeout uses the same value
as the armed execution timer, excluding time already consumed by setup.

### Normal validation under the changed executor

Configured commands that reach the changed fixtures were executed through the real
compiled executor on 2026-09-14 with the machine reservation held, on the merged
candidate and on local main 0.3.363 for comparison. The fixture-suite-wrapped
`post-done-closure-snapshot` target passes on both (24 seconds on main, 24 seconds
on the candidate); an intermediate candidate that forwarded the outer reservation
into the fixture's separate machine environment failed it, which is why the suite
wrapper now strips the locator instead. The reviewer-scan budget guard passes on
the candidate. The npm-wrapped `test:dynamic-finding-evidence-closure` target reaches
the same 180-second timeout with the same single failing case on main and on the
candidate, so npm-wrapped fixture targets remain non-delegated and unchanged;
`review-pass-discard-smoke` fails identically on main and on the candidate with a
fixture repository error unrelated to delegation. These are bounded targeted
observations, not a full validation run; the static-edge scanner's remaining rows
equal the set already present on local main.

## Verification boundaries

Thirty direct `node scripts/verify-nested-reservation-registered.mjs <selector>`
commands are registered in `proof-or-stop.config.json`; the matching
`test:nested-reservation-*` entries in `packages/main/package.json` are
convenience aliases for manual runs and are not validation gate inputs. The
closed selector wrapper normalizes the repository working directory and prints
an explicit skip on unsupported platforms before loading native controls. The
entries declare the existing exclusive machine heavy and process-fanout
resources; private fixture directories do not permit concurrent machine
contention. The original pinned Lab driver remains unchanged. Registered budgets
are evidence-backed: measured sequentially on 2026-09-14 against the merged
candidate, `core` completed in 30.8 to 40.6 seconds against a 120-second budget
(five 15-second outer cases plus setup stack in the worst case),
`registration-race` in 9.5 seconds against 120 seconds (eight 10-second modes
stack in the worst case), `cleanup-diagnostics` in 6.2 seconds against 90
seconds (six 10-second modes), and every remaining selector in under 37 seconds
against its 12-second or 60-second budget.
The pinned driver admits its leaf commands through the real same-user machine
pool rather than a private namespace, which is why its command declares the
exclusive machine heavy and process-fanout resources: run concurrently with
another holder of that pool outside validation, its 1.5-second leaf deadline is
reached before launch and it fails exactly like the original RED.

Static evidence for this route must directly bind the resource configuration,
registered runtime policy and actual loaded implementation helpers. Regression
controls remove individual bindings while keeping the global configuration
fresh, proving that missing direct evidence is rejected. These scanner fixtures
are source-only controls and do not stand in for native behavioral verification.
Sixteen reviewed static-edge exception entries cover the route's generated-fixture
and inline-probe subprocess call sites, and the handshake-deadline control asserts
the folded result contract for a stalled issuer rather than an exception.

The originally pinned Lab command remains
`node scripts/verify-nested-verification-machine-owner.mjs`, with its original
60-second Lab cap, 15-second outer executor cases and 1.5-second leaf timeout. It
covers the actual deadlock regression, absent leaf output, sibling/ancestor
nesting, revoked contexts, subset and fixed-port refusal, copied-key refusal with
dropped-descriptor degradation, transitive release/expiry and immutable
enrollment. `verify-nested-reservation-wrapper-transport.mjs` registers a plain
and a cooperating Node wrapper as detached children of a real controller and
proves that the dropped transport degrades without a token, locator or reserved
slot while the forwarded transport keeps the pending-fence capability.

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
