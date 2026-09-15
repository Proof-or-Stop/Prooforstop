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

Forwarding is explicit only at Node spawn boundaries. On macOS every
Node-spawned child receives only its explicitly listed stdio descriptors, so
the reserved descriptor and the locator reach exactly the child spawned with
the controlled stdio and environment helpers; a non-Node child or a shell
wrapper then passes both to its own descendants by ordinary exec inheritance
(the mapped descriptor is not close-on-exec), and the registered policy names
this boundary as `explicit-node-spawn-boundary-only`. Holding the descriptor
grants nothing: every operation still needs the cooperating client, the
kernel-matched owner identity and the signed protocol, and a process that
merely inherited the descriptor without the client runs exactly as before
delegation existed. One spawn verifies its inherited bootstrap once: the
environment and stdio helpers share a memo that dies with the synchronous turn
in which both are called, halving the descriptor observations per spawn, while
the post-response freshness check of every protocol round trip always observes
anew. The reserved slot forces a five-entry stdio array, so a caller that
declares three entries gets descriptor 3 padded as an ignored slot; an ignored
slot at descriptor 3 or above is left closed by the spawn (libuv opens
`/dev/null` only for the three standard descriptors), so a delegated child's
descriptor 3 is whatever its own runtime opens first, exactly as before
delegation existed, and never `/dev/null`. The wrapper-transport probes assert
that for every shape (dropped, silent, linked and cooperating).

Non-macOS execution retains the existing non-delegated queue path. It does not
claim detached delegation support. On macOS every Node-spawned child receives
only its explicitly listed stdio descriptors, so a plain wrapper such as `npm run`
or a runner spawning with `stdio: 'inherit'` drops the reserved descriptor while
the locator environment survives. That state is classified as a dropped
transport: the descendant runs without a borrowed reservation exactly as before
delegation existed, forwards no locator, and diagnoses the loss at most once on
stderr (`VALIDATION_DELEGATION_UNAVAILABLE`) only when
`PROOF_OR_STOP_DELEGATION_DIAGNOSTICS=1` is set; by default its output stays
byte-identical. An unrelated linked regular file that later occupies the reserved
number degrades the same way, naming that reason. Nothing is repaired from the
environment, and an unlinked foreign descriptor at the reserved slot is never
downgraded: a copied bootstrap stays refused. The repository's own
`scripts/run-validation-fixture-suite.mjs` deliberately strips the locator and
forwards no reserved descriptor, so fixture-suite targets run non-delegated in
their own machine environment (see "Normal validation under the changed
executor" for why); npm-wrapped fixture targets remain non-delegated, which is
their pre-existing behavior on main.
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

`attemptValidationReservationSpawn(pendingToken, options)` is called
immediately before the spawn call and stamps the pending fence with a
spawn-attempt marker (locally through the frame, remotely through an `attempt`
operation bound to the same private capability). The contract for every
spawning caller is prepare, attempt, spawn, register, and the process that
performs the spawn call owns that fence; the executor, both spawning processes
of the isolated Finding fixture (the fixture process for its launcher, the
registered launcher for its worker) and every raw-API holder in the controls
follow it: the sixteen raw-API spawn sites across the fault, cancellation,
wrapper-transport, cleanup-diagnostics, owner-loss, handshake-deadline and
registration-race controls and the lifecycle support each mark their fence
immediately before the spawn call, and the only unmarked fence in the controls
belongs to the `unattempted-owner-loss` descendant, which never spawns. `noteValidationReservationSpawn(pendingToken, pid, options)` records the
spawned PID on the marked fence immediately after the spawn call returns and
before the registration handshake (locally through the frame, remotely through
a `spawned` operation bound to the same private capability); the executor, the
isolated fixture process (for its launcher) and that launcher (for its worker)
note every spawn, so an owner lost between the
spawn call and the applied registration leaves a fence that resolves once that
PID and its whole group are proven absent, and only the window between the
mark and the return of the spawn call is terminal. Raw-API holders in the
controls register immediately after their spawn call instead.
`cancelValidationReservationChild(pendingToken, options)` is
cleanup-only and its caller must have proved that no child was spawned.
Separately, controller retirement can resolve an already-observed owned target
after fresh PID and whole-group absence checks, and it resolves an unmarked
pending fence whose owner PID is proven absent (or observed with a different
start), because an unmarked fence proves that no child was ever spawned under
it. A marked fence without an observed target remains fenced. Immediate
operations, including the local frame's own prepare, attempt and cancel subject
observations, retry their single kernel observation before refusing; a queued grant
request is observed only inside the retirement tick, where a transient
observation failure leaves it queued until its own deadline. Retirement polling is
event-driven and backs off: any grant, release or disconnect re-arms a 20 ms tick
(`retirementPollMs`), and while a tick changes nothing the interval doubles up
to 500 ms (`retirementPollMaxMs`); within one tick the process table and each
process identity are observed at most once. `verify-nested-reservation-faults.mjs`
mode `retirement-backoff` leaves a released grant with lingering same-group work
and counts kernel identity observations over one second: 49 against the
pre-repair fixed 20 ms interval, at most 12 (measured 4) afterwards. Mode
`drain-observation-transient` fails the tick's first four observations of a
requesting sibling, more than one bounded retry, and proves the queued grant
survives a requeue; the pre-repair controller refused it on the first failure.
Mode `controller-transport-unavailable` makes the controller's first socket
listen fail and proves the admission is refused by name
(`controller transport unavailable`), leaves no scratch directory behind and
keeps the ticket usable; the socket path additionally falls back to `/tmp` when
a deep scratch TMPDIR would exceed Darwin's unix-socket path limit. A refused
registration keeps its private cleanup capability only until the caller's
withdrawal, which releases it whether applied or refused, and a withdrawal that
races an already-applied registration is an idempotent success on the
controller; `verify-nested-reservation-cancellation.mjs` mode
`client-rejects-applied-registration` rejects a registration on the client after
the controller applied it and proves the delegated command's bounded result
survives without a cleanup-refusal diagnostic. Against the pre-repair pair the
controller answered `cleanup capability not owned` to that withdrawal: the
completed result was still recovered through the diagnostic's `completed`
field, but it carried a false `refused-registration cleanup refused` line and
the descendant retained the capability entry.
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
A grant request from an enrolled descendant whose command carries no
classification resolves, on the controller, to the tightest enclosing
declaration (its parent grant's claims, else the owner's declaration) and can
never widen it; the client accepts such a grant only when its claims stay within
the owner's declaration carried by the bootstrap. A declared claim outside the
enclosing grant or declaration is never borrowed at all: one that conflicts
with the owner's declaration is refused at the inherited entry itself, because
on the machine queue it could only wait behind the owner's own ticket (the
queue's ancestor rule cannot see a reparented descendant), while a
non-conflicting one is acquired on the machine queue exactly as before
delegation existed and holds its own ticket beside the owner's; the controller
keeps refusing a raw superset grant request as `resource expansion`. Inside one process a nested
unclassified request under a declared frame is still refused as expansion,
because one invocation cannot widen its own claim.
`verify-nested-reservation-faults.mjs` modes `declared-owner-unclassified` and
`declared-owner-expansion` prove this across a real process boundary under an
owner that declares exactly the claims the registered selectors declare: the
expansion mode asserts that a conflicting claim outside the declaration is
refused at the entry, that a non-conflicting one is admitted with a second
ticket, and that an exact subset borrows without a ticket of its own; under
its undeclared owner, where every claim is borrowable and widening a borrowed
frame is an expansion, the pinned driver's resources group asserts that
expansion refusal for an unclassified request and for a declared claim outside
the frame, and the same refusal for widening a borrowed port claim.
The unclassified mode fails against the pre-repair controller with
`resource expansion`, which is what every registered selector hit under the
real executor before this repair; against the module as it stood before the
full configured-command comparison of the thirteenth round, which refused every
claim outside the declaration as `resource expansion`, the conflicting and the
non-conflicting alike, the expansion mode fails at its first assertion with that
refusal, and that refusal is what the precert fast set (configured index 6,
whose `real-port-collision` member declares a fixed port the outer command does
not) hit in that comparison while passing on main.

## Retirement and cleanup

| State or associated work | May resource claims retire? |
| --- | --- |
| Live caller explicitly completes a callback; no associated work remains | Yes; the caller need not exit before its next invocation. |
| Unexpected EOF or holder death; its group still exists | No. |
| Registered descendant group still exists | No, including after normal callback return. |
| Registered descendant PID and whole group provably absent | Yes; the enrollment row is pruned from the residual record, and its consumed withdrawal capability survives one bounded cleanup window so a withdrawal racing the applied registration stays idempotent. |
| Transitive descendant grant remains | No; revocation does not prove completion. |
| Pending registration has no proven target absence | No; unknown work remains fenced. |
| Pending registration noted its spawned PID, its owner is provably dead, and that PID and its whole group are absent | Yes; the note written immediately after the spawn call resolves the fence without a registration. |
| Pending registration is marked but noted no spawned PID and its preparing owner is dead | No; a child may have been spawned between the mark and the return of the spawn call, so the fence is terminal until a different-boot witness or explicit operator action. |
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
leadership and pre-orphan ancestry are observed. Every kernel observation on the
registration path, including the owner's own start identity, is retried a
bounded number of times (`observationRetries` with `observationBackoffMs` in the
registered runtime policy) and falls back to proven target absence before the
registration is refused, so a single `ps` hiccup does not strand a targetless
token. The owner's start identity is compared against the observation that
recorded the pending row: a socket caller supplies the subject identity it
already observed, and the local frame observes itself with the same retry. The
isolated Finding fixture retries its worker observation with the same policy;
its launcher, which performs the worker spawn call and therefore owns that
fence, terminates a refused worker with its group and withdraws the fence only
once the worker's PID and whole group are proven absent, so the live controller
releases cleanly. The executor applies the same rule to every
validation command: a refused registration signals the spawned group exactly
as a timeout does, and once the direct child's PID and its whole group are
proven absent (the exported `unregisteredValidationReservationChildGone`
predicate, shared with the fixture) the owned pending fence is withdrawn before
the command result is returned; a live or unobservable group keeps the fence
for the controller to report, and a refused withdrawal is surfaced with the
bounded result preserved. `verify-nested-reservation-registration-race.mjs`
modes `retry-recovers` and `retry-exhausted` fail the inner observation itself
and assert the attempt count, `retry-exhausted-withdrawn` shows a raw API caller
withdrawing after proven absence, `verify-nested-isolated-observation.mjs` proves the fixture's recovery and
withdrawal under a live controller, and its `unavailable-no-token` mode proves
that without a borrowed reservation an unobservable worker degrades (the worker
runs and cleanup stays best-effort) instead of refusing, where the pre-repair
fixture reported its cleanup as unproven; only observation unavailability
degrades, while a definitive non-leader observation is still refused with or
without a reservation, as `verify-nested-isolated-cleanup.mjs --non-isolated`
asserts, and
`verify-nested-reservation-cancellation.mjs` modes
`refused-registration-withdrawn` and `refused-registration-live` drive the real
executor through a refused registration: an exiting workload releases the ticket
cleanly, while a workload that leaves a same-group grandchild ignoring the signal
keeps the pending fence (`owned group cleanup unproven`; since the executor
notes every spawned PID, the doctor classification reports one pending fence
whose noted spawned PID or group is still present and no targetless fence). Replayed against the pre-repair executor the
withdrawn mode fails with `owned group cleanup unproven`. A token that still
ends targetless because its owner died between prepare and registration, or
because every bounded observation failed, cannot be resolved by owner death
alone: a detached child may already exist. `proof-or-stop doctor` lists every
fencing shape of the release predicate under "Nested reservation fences" through
the same exported classifier (`classifyMachineReservationResiduals`): live or
unobservable registered groups, pending fences whose proven target is still
live, and pending fences without an observed target, with dead-owner counts;
`verify-nested-reservation-owner-loss.mjs` asserts that classification on the
dead owner's ticket while its orphan lives and after it stops. An unmarked pre-spawn fence (its owner died before ever reaching the spawn
call) resolves automatically once that owner is proven absent, so the window
that captureValidationCommand opens before every spawn cannot wedge the
same-user pool. A marked fence that noted its spawned PID resolves once its
owner is provably gone and that PID and whole group are absent, so an owner lost
anywhere between the return of the spawn call and the applied registration (the
registration observations and socket round trip) no longer wedges the pool;
doctor lists such a fence as a pending fence whose noted spawned PID or group is
still present until then. A marked fence that noted no spawned PID (its owner
died between the mark and the return of the spawn call, a window of
microseconds) keeps the ticket fenced by design, because a detached child may
already exist; doctor counts it as a pending fence without an observed target.
Recovery for that case
is the different-boot witness path after a reboot, or removal of the ticket
directory only after an operator has independently confirmed that no detached
child remains; the tool never releases it automatically. A ticket whose holder
is provably absent is reclaimed by the ordinary stale path as soon as every
residual row is resolved, that is once every registered group and every noted
spawned PID and group are proven absent, so a leaked descendant fences the
same-user pool only while it is actually alive; the reclaim predicate and the
doctor classification are the same exported classifier.
`verify-nested-reservation-faults.mjs` modes `unattempted-owner-loss` and
`attempted-owner-loss` prove both outcomes with a real descendant that dies
between prepare and spawn; against the pre-repair source the unmarked fence
stayed and the owner's release was refused. Mode `spawned-owner-loss` has a
descendant mark its fence, spawn a detached leaf, note the leaf PID and die
before registering: while the leaf lives the doctor classifier reports the
noted spawned PID and no targetless fence, and once the leaf is terminated the
fence resolves and the owner releases cleanly; against the pre-repair
controller the same fence stayed targetless and terminal. The lifecycle support
runs the extracted resolution predicate as unit controls for every row shape.

The isolated Finding fixture previously prepared and marked one fence in the
fixture process for a spawn call that its launcher performed two process hops
later, so a launcher that never delivered a worker PID (a failed worker spawn
call under load, or a launcher lost before its message) left a marked,
targetless fence that wedged the same-user pool. Each process now owns the
fence of the spawn call it performs. The fixture process prepares, marks,
spawns and registers its launcher exactly like an executor child and sends it
GO only after that registration, so the launcher's own requests are those of
an enrolled descendant; the launcher then prepares its own fence, marks it
immediately before its worker spawn call, and registers the worker once the
fixture process has observed a matching group leader, or terminates the
refused worker with its group and withdraws that fence once the worker's PID
and whole group are proven absent. A spawn call that fails creates no child,
so the launcher withdraws its fence at once and reports the failure; the
fixture then names the failed spawn (`isolated fixture worker spawn failed`)
without claiming an unproven cleanup, and a refused launcher registration is
withdrawn under the executor's rule once the launcher is proven absent. A
launcher lost before its attempt mark leaves an unmarked fence that the
controller resolves once its owner is proven gone; the window between the mark
and the spawn call is the same accepted window the executor has.
`verify-nested-isolated-observation.mjs` mode `worker-spawn-failure` replaces
the executable of the launcher's worker spawn call inside the fixture's
launcher template and asserts that the fixture fails naming the spawn, that no
cleanup is reported unproven, that no worker entered its workload and that the
live controller releases its ticket; against the pre-repair fixture the
controller refused its release with `owned group cleanup unproven` and the
ticket stayed fenced.

The teardown escalation and the isolated fixture's worker cleanup apply one
exported signal-target rule (`validationReservationOwnedGroupSignalTarget`,
the rule the controller teardown itself uses): a previously observed owned
group leader is a signal target while it is still observed with its recorded
identity, and also once its PID is absent while its recorded group persists.
The second case is the common shape after a normal exit, because a direct child
or worker that exited 0 while a same-group descendant lingers leaves exactly a
persisting group without its leader; the kernel allocates no PID that any live
or zombie process still carries as its process-group or session id, so a
persisting group whose leader PID is absent is the recorded group, and a live
process observed at that PID with a different start is a recycled PID that is
never signalled. Before the thirteenth round both escalations required the
leader to still match, so nothing was ever signalled in that shape, the
two-second cleanup budget elapsed, the residual record kept the group, the
completed command was converted into an infrastructure failure and the machine
ticket stayed fenced behind a leaked descendant. Mode
`completed-group-residual` of `verify-nested-validation-result-contract.mjs`
runs, under the owner's own controller, a command that exits 0 after spawning a
same-group sleeper, and asserts that the result keeps the command's exit 0 with
no cleanup refusal, that the sleeper is gone once the result is returned and
that the ticket is released; against the pre-repair delegation module the
result was a code-1 infrastructure failure naming the unproven cleanup, with the
sleeper alive. The fixture signals its recorded worker group as soon as the
group persists after the outcome is published, or without one, and SIGKILL
follows at the half-budget point; `verify-nested-isolated-cleanup.mjs` and its
`--primary-failure` variant now assert that the same-group orphan its worker
leaves is cleared before the fixture returns, with the outcome (a pass, or the
worker's own failure without a cleanup suffix) preserved, while the new
`--unclearable` variant records the fixture's own group signals instead of
delivering them, standing in for a residual the kernel does not clear within
the budget, and asserts that the refusal still fires and the orphan is still
observable afterwards; against the pre-repair fixture the default variant left
the orphan alive behind a refusal and the unclearable variant recorded no
signal at all. The non-isolated variant asserts the observation refusal it
exercises (`isolated worker group identity unavailable`), because its earlier
check that no signal was attempted cannot fail without an observed identity.

The controller's own admission observation at controller start
(`inspectMachineReservationOwner`) is a ticket and kernel observation like every
other one in the module: it is retried with the registered observation policy,
and when it stays unavailable the command is refused at once with the typed
`controller owner observation unavailable`; an owner observed with a different
identity or declaration is still refused. A controller-less run in that case
was tried first and rejected: an owner without a controller leaves its
delegated leaf commands queued behind its own ticket until their deadline,
which is the failure delegation exists to remove. The full configured-command
comparison below recorded, while that fallback was in place and the machine
pool was shared with another session, a shape consistent with it for the
fixture suite at index 14 (a 19-minute wait for the pool, then its 20-minute
budget spent without progress after the first shard), where the same command
completes in 139.5 seconds in isolation with its controller formed; the cause
of that stall was not observed directly, and the fallback is gone regardless.
`verify-nested-reservation-faults.mjs` mode `controller-inspection-transient`
refuses the first inspection and asserts that the controller still forms and a
registered descendant sees the locator, and mode
`controller-inspection-unavailable` refuses every inspection and asserts that
the command is refused immediately with that reason, never entered, and its
ticket released; against the module before this round the transient mode failed
the command with `controller owner/declaration mismatch`, and against the
rejected fallback the unavailable mode entered the command. A queued controller request is
dequeued only where it still sits (a request already removed must never remove
a neighbour, which a splice at index -1 would silently do); the closure is
defined above the retirement slice the lifecycle unit controls evaluate.

Kernel process-table (`ps`) and descriptor (`lsof`) observation failures are
typed delegation refusals like every other kernel observation: the descriptor
observation inside the bootstrap reader retries with the registered policy and
refuses as `kernel descriptor observation unavailable`, the process table
refuses as `process table unavailable`, and immediate socket operations observe
the process table with the same bounded retry, so a transient `lsof` or `ps`
failure on the pre-launch path folds into a bounded infrastructure result
instead of escaping as a raw error. `verify-nested-validation-result-contract.mjs`
mode `descriptor-unavailable` registers a real child of a live controller whose
own nested executor meets a failing descriptor observation while reading its
inherited bootstrap and asserts the folded non-success result naming that
refusal, with no leaf launched; against the pre-repair reader the raw error
escaped the executor as an exception. A foreign unlinked regular descriptor
whose bytes are not a JSON envelope is refused as `bootstrap is not a bounded
JSON envelope`, a typed refusal that folds like every other bootstrap refusal;
the pinned driver's `descriptor` group passes such a descriptor at the reserved
slot as its third case and asserts the typed refusal without a dropped-transport
diagnostic. Replayed against the pre-repair delegation source the pinned command
stops before that group, because the lifecycle support it imports extracts the
pruning closure that source does not contain; the reader-level RED was therefore
shown with a direct probe of the same queue entry and the same descriptor, which
reported a raw `SyntaxError` before the repair and the typed refusal after it.

Resolved enrollments are pruned. Once a registered child's PID and whole group
are proven absent, the retirement tick removes its row from the published
residual record, so the record stays bounded across a run of many commands,
every publish and residual probe rescans only live and unresolved rows, and a
PID the kernel later recycles can be enrolled again instead of being refused as
an immutable enrollment. A live row, or a PID observed absent while its group
is still present, stays. The pruned row's consumed withdrawal capability
survives one bounded cleanup window (twice `cleanupMs`) so a withdrawal racing
the applied registration stays an idempotent success, then expires.
`verify-nested-reservation-faults.mjs` mode `registered-row-pruned` registers a
descendant that exits and asserts that the doctor classifier of the live ticket
reports neither a live nor a resolved enrollment within four seconds, where the
pre-repair controller carried the resolved row for the rest of the run;
`scripts/support/nested-reservation-lifecycle.mjs` runs the extracted pruning
closure as unit controls for the resolution predicate, the capability window
and the half-observed row. Recycled process-group ids remain the accepted
limitation recorded under worker exit.

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
state. A canonical machine ticket directory is published with the registered
private directory mode, because the reader refuses any ticket readable by group
or others, while workspace capacity tickets under a repository's shared lock root
keep the process default mode since the reader never consults them; an
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

When a completed command's enclosing cleanup fails, the complete authenticated
output artifact is preserved verbatim with the cleanup diagnostic appended and
only the bounded projection is trimmed; the `post-capture-cleanup` mode drives
the wrapper-returning entry point with a 5000-character payload and asserts the
artifact still carries it, where the pre-repair executor returned a 2000-byte
slice under the same name. The same holds on the other cleanup path: when a
completed command's refused-registration withdrawal or no-spawn cleanup is
itself refused, the cleanup error carries the complete artifact alongside the
bounded result and the fold appends the diagnostic to that artifact. Mode
`refused-registration-cleanup` completes a 5000-character command, refuses its
registration only after the payload has been flushed, refuses the withdrawal,
and asserts that the artifact still carries the payload, that the projection's
prefix is the artifact's prefix and that the projection does not carry the
whole payload; against the pre-repair executor the bounded projection was
returned under the artifact's name.

A refused spawn-attempt mark is handled the same way: the executor withdraws
the fence it prepared at once, because no spawn call was made under it, and
the refusal folds into a bounded infrastructure result; a refused withdrawal is
reported together with the refusal, never in place of it. Mode
`attempt-refusal` refuses the mark inside a live owner's own executor and
asserts the folded result, that no cleanup was refused, that the leaf never
launched and that the owner's ticket is released; against the pre-repair
executor the mark sat outside the withdrawing block, the fence stayed and the
controller refused its release with `owned group cleanup unproven`.

A refused registration of a command that already ran never writes into that
command's complete authenticated output artifact. The refusal is carried as a
separate `delegationDiagnostic` field on the wrapper result and on the flat
single-command result, appended only to the wrapper's bounded projection, and
the child's own exit status is kept in `observedExitCode` next to the
fail-closed `code` of 1 with `failureKind` `infra_failure`, so a run that
executed without an applied registration can never earn a passing receipt
while its artifact stays exactly the bytes the command printed. Mode
`refused-registration-cleanup` asserts that the artifact carries the payload
and not the refusal, that the diagnostic and the observed exit status are
recorded, and that the projection still names both refusals. The post-capture
cleanup diagnostic remains appended after the complete artifact, separated by a
newline, as the seventh round required.

The armed per-command timer is fixed at capture entry, before setup and the
pre-launch handshakes, exactly as before delegation existed: the configured
timeout capped by the caller's remaining deadline at entry. Measured from the
comparison runs below, the setup-to-arming delta was 0 to 14 ms per command on
main 0.3.363 and 136 to 366 ms (median 151 ms) on the tenth-round candidate,
which is the cost of the prepare, attempt and note handshakes and their kernel
observations; that delta no longer reduces any command's budget. A refused
registration or note that arrives after the child has already exited sends no
signal, guarded exactly like the timeout path, so a recycled process group is
never targeted; mode `refused-registration-cleanup` refuses only after the
child exited and asserts that the refusal path sent nothing, and mode
`refused-registration-short` repeats it with a short output in its own process
(the first refused command deliberately leaves its ticket fenced) and asserts
that the artifact is exactly the command bytes followed by the
newline-separated withdrawal diagnostic, that the registration refusal is
absent from it, and that the folded projection is, byte for byte, the
untainted command bytes, the registration refusal once and the withdrawal
diagnostic once; against the pre-repair executor the projection carried the
registration refusal twice. Mode `armed-timeout` asserts that without a
caller deadline the armed timer equals the configured budget; the capture
receives the caller's own deadline, and the bounded deadline the outer stage
derives governs only the capacity wait and the pre-launch handshakes. Under
delegation the live grant's deadline is the ceiling at which the grant's
revocation kills the command, so the armed timer, and with it the reported
effective timeout, is bounded by that deadline as well
(`currentValidationReservationDeadline`); mode `nested-grant-deadline` runs a
registered child's nested command whose configured budget exceeds its owner's
remaining deadline and asserts that the result is a timeout whose reported
effective timeout is at most the owner's budget and matches the observed kill
time; against the pre-repair executor the same run reported the configured
8000 ms as its effective timeout after being killed at 1648 ms.

The caller's own abort, or a caller-supplied deadline error, is decided before
any pending fence is prepared and again ahead of a delegation refusal, so it
keeps its exception behaviour instead of folding into a delegation result; a
default deadline that expires during preparation still folds into the bounded
result, which is what `verify-nested-reservation-handshake-deadline.mjs` asserts.
`verify-nested-validation-result-contract.mjs` mode
`caller-deadline-before-prepare` expires the caller deadline ahead of that
preparation and asserts the caller's own error object propagates; against the
pre-repair executor the same run returned a folded result with no exception.

### Version and build

Candidate commits carry no CLI version bump by Lab policy: `finish --bump patch`
applies the atomic patch bump to both manifests, both lockfiles and the CLI brand
constant, rebuilds, checks `proof-or-stop --version` and only then merges to
local main (`docs/lab-maintenance.md`, "Finish"). The two build-product
consumers this Lab adds, the fixture-suite wrapper's import of the delegation
runtime policy and the registered selectors' use of the compiled executor, run
against a dist that the content-bound build binding (`scripts/ensure-dist.mjs`
through `build-main-with-binding.mjs`, a sha256 over all sources) rebuilds
whenever source changed, independently of the version constant; the wrapper
additionally names a stale dist explicitly instead of failing at module link.
Every registered selector and the executor evidence in this record were run
against a dist rebuilt from the candidate source.

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
fixture repository error unrelated to delegation. These were bounded targeted
observations; the full configured-command comparison below covers every
configured command on both trees.

### Candidate-versus-main comparison of the descriptor-channel and native-fixture commands

Every configured command whose entry consumes a numbered descriptor channel or
the native review and isolated Finding fixtures, the three named validation
smokes (command timeout, progress heartbeat, parallel equivalence) and the
npm-wrapped test targets were run through the real compiled executor with the
machine reservation held, first on local main 0.3.363 and then on the
candidate, sequentially because both use the same machine pool (no configured
command sets `shell: true`, and no caller passes `exactEnvironment`). Command
indexes are identical in both configurations because this Lab only appends
entries. The comparison was made against main 0.3.363, before the candidate
was resynchronized with main 0.3.366 and then with main 0.3.367; the full
configured-command comparison below was made on the candidate resynchronized
with main 0.3.367, and the finish-time bounded
dynamic revalidation replays the impacted commands on the merged candidate and
on post-merge main.

| index | command | main 0.3.363 | candidate | main s | candidate s |
| --- | --- | --- | --- | --- | --- |
| 0 | `npm --prefix packages/main run test:dynamic-finding-evidence-closure` | timeout (124) | timeout (124) | 180.5 | 180.4 |
| 1 | `npm --prefix packages/main run test:dynamic-finding-applicability` | pass | pass | 1.3 | 1.3 |
| 2 | `packages/main/dist/tasks/finding-identity-lineage-smoke.js --section=d` | fail (1, validation_failure) | fail (1, validation_failure) | 442.1 | 402.4 |
| 12 | `packages/main/dist/tasks/review-pass-discard-smoke.js` | fail (1, validation_failure) | fail (1, validation_failure) | 37.2 | 30.5 |
| 15 | `scripts/verify-process-fact-contract.mjs --quiet` | fail (1, validation_failure) | fail (1, validation_failure) | 9.7 | 9.9 |
| 16 | `scripts/verify-runtime-fact-contract.mjs` | fail (1, validation_failure) | fail (1, validation_failure) | 3.7 | 6.4 |
| 19 | `scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/vali` | pass | pass | 8.0 | 7.8 |
| 20 | `scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/vali` | pass | pass | 116.8 | 109.7 |
| 25 | `packages/main/dist/tasks/reviewer-scan-budget-guard-smoke.js` | pass | pass | 4.8 | 5.2 |
| 85 | `packages/main/tests/red/red-done-prepare-done-parity.mjs` | pass | pass | 6.5 | 5.8 |
| 126 | `scripts/run-validation-fixture-suite.mjs packages/main/dist/tasks/vali` | pass | pass | 9.5 | 9.9 |
| 155 | `scripts/verify-managed-inventory-critic-transport.mjs` | pass | pass | 160.0 | 169.3 |
| 156 | `packages/main/dist/tasks/managed-review-evidence-smoke.js` | fail (1, validation_failure) | fail (1, validation_failure) | 0.5 | 0.5 |
| 159 | `packages/main/dist/tasks/semantic-scope-guard-smoke.js` | pass | pass | 17.3 | 17.9 |
| 166 | `packages/main/dist/tasks/provider-codex-smoke.js --canonical-core` | pass | pass | 3.0 | 3.2 |
| 168 | `scripts/verify-validation-static-edges.mjs` | fail (1, validation_failure) | fail (1, validation_failure) | 1.6 | 4.8 |

Fifteen of the sixteen outcomes were identical on the first candidate run. The
seven shared failures are main's own: index 0 reaches its 180-second timeout
on both, index 2 fails a signed reproduction receipt check inside the
finding-identity lineage smoke, index 12 fails with the fixture repository
error already recorded above, index 15 fails on both only under the executor
because the acceptance-closure publication-lifecycle experiment it spawns
fails in that context (run directly, the contract exits 0 on the candidate),
index 16 is the runtime fact contract, which fails identically when run
directly on main 0.3.366 and on the candidate with exactly one failure entry,
its static AST reuse control, because the static-edge scanner it runs reports
the same sixty residual rows on both; the contract now evaluates its
delegation assertions (the registered runtime fact, the imported policy and
each of its ten bound consumption sites) before the build-share step and
before any subprocess step, so all are demonstrably reached and absent from
the failure list on the candidate; index 156 fails on
both with `Cannot access 'DIRTY_WORKTREE_CATEGORIES' before initialization`
at module load, and index 168 is the static-edge scanner (71 rows on main, 60
on the candidate). The one difference was a genuine candidate regression that
this comparison found: `verify-managed-inventory-critic-transport.mjs` (index
155) extracts the tail of `verify-process-fact-contract.mjs` after its marker
`Managed inventory transport checks must precede the final failure gate` and
executes it in a subprocess whose `read` resolves only three synthetic
sources, and this Lab had appended its structural delegation process-fact
check after that marker, so the sandboxed tail failed in half a second. The
block now sits above the marker; the contract still runs it against the real
registry source, the transport check passes again on the candidate through
the executor in 169.3 seconds (160.0 on main), and the table records that
rerun. Aggregate wall clock over the sixteen commands was 1002.5 seconds on
main and 965.0 seconds on the candidate with that rerun (796.3 seconds before
it, when index 155 stopped in half a second; index 2 and index 20 dominate the
remaining difference and vary between runs of the same source), so the
per-command delegation observations add no measurable aggregate cost at this
scale; the candidate's index 16 and 168 rows run a few seconds longer because
they compare more rows.

The static-edge scanner's remaining rows are, up to moved line numbers inside
Lab-changed files, exactly the rows already present on local main 0.3.367: 60
NEEDS_REVIEW rows on both, where every differing group is the same
`incomplete exception` row at a moved line (`native-review-fixture.ts` 189 to
190 and `isolated-finding-fixture.ts` 73 to 144, both inherited stale
dependency pins on main), and every stale exception id on the candidate is
stale on main (32 of main's 32). The manifest
and the identity verifier pin each other, so the refresh order is fixed: every
source, script and verifier edit is finished first, then the reviewed identity
inventories and the verifier's own pins are refreshed, then the manifest is
regenerated last so its dependency digests record the final verifier bytes, and
the verifier is run once more; the verifier's pin over the manifest covers only
the token-bearing excerpt lines, which a dependency-digest refresh never
touches, so one pass reaches the fixed point (checked: every manifest occurrence
of the verifier digest equals the committed file, and the verifier output is
byte-identical before and after the regeneration).

The identity-cutover verifier reports on the candidate exactly the issue list it
reports on local main 0.3.367 (238 lines there, 233 on the candidate) minus
five inherited rows that the candidate rebinds because it modified their files
(the reviewed-source rows of `runtime-fact-registry.ts`,
`runtime-artifact-registry.ts` and `run-validation-fixture-suite.mjs`, and the
negative source integrity pins of `verify-process-fact-contract.mjs` and
`verify-runtime-fact-contract.mjs`); its self-test fails identically on both.
The rule for every identity re-pin in this Lab is checkable: a re-pinned row is
bound to a file this Lab modified, and no row bound to an unmodified file is
refreshed. Enumerated from
`git diff main -- scripts/identity-reviewed-source-data.json scripts/identity-reviewed-fixture-data.json scripts/identity-reviewed-json-data.json scripts/verify-proof-or-stop-identity-cutover.mjs scripts/identity-reviewed-*-contexts.mjs scripts/identity-child-contract.json`
against `git diff --name-only main`, the 36 re-pinned rows are, by the
Lab-changed file that caused each one:

- `packages/main/src/core/runtime-artifact-registry.ts` (one added export): the
  reviewed-source row for `.lattice/runtime/host-runs/`, line 367 to 485 with
  its source digest, same line hash and occurrence count.
- `packages/main/src/core/runtime-fact-registry.ts` (delegation policy and
  fact): the reviewed-source row for `LATTICE_AGENT`, line 502 to 511 with its
  source digest, same line hash and occurrence count.
- `scripts/run-validation-fixture-suite.mjs` (named stale-build failure and
  namespace import): the reviewed-source row for `env.LATTICE_HEALTH_PATH`,
  line 37 to 45 with its source digest, same line hash and occurrence count,
  and the `wrapperDigest` of `scripts/identity-child-contract.json`, which
  pins that file's sha256.
- `packages/main/src/tasks/native-review-fixture.ts` (delegation environment
  forwarding): six reviewed-fixture rows (`lattice` line 44 to 45,
  `LATTICE_NATIVE_REVIEW_ATTESTATION_FD` lines 194, 234 and 342 shifted by one,
  `process.env.LATTICE_NATIVE_REVIEW_ATTESTATION_FD` lines 244 and 352 shifted
  by one) with the source digest.
- `scripts/verify-process-fact-contract.mjs` (delegation process fact): nine
  reviewed-fixture rows re-digested at unchanged lines (6536 to 6572, 7301,
  7393, 7422) and its negative source integrity pin.
- `scripts/verify-runtime-fact-contract.mjs` (delegation runtime fact): its
  negative source integrity pin.
- `scripts/lab/u18-static-edges/exceptions.json` (repinned manifest): eight
  reviewed-JSON context digests for the copied excerpts of
  `native-review-fixture.ts` under `/entries/39`, `/entries/269` and
  `/entries/270`, plus the CURRENT_COMPATIBLE_SCHEMA_ROWS context digest for
  the native review invocation attestation schema token (count unchanged at 4).
- the three reviewed-context readers (`identity-reviewed-source-contexts.mjs`,
  `-fixture-contexts.mjs`, `-json-contexts.mjs`): their EXPECTED_SHA256 and
  entry-count pins and the verifier's digest pin of each reader, because the
  inventories above changed.

Inherited main drift on files this Lab did not modify is left visible, not
refreshed.

### Full configured-command comparison

Every configured command of local main 0.3.367 (indexes 0 to 168; the candidate
appends its fifty-seven selectors after them) was run through the real compiled
executor with the machine reservation held, sequentially and in the same order,
first in the main checkout and then in the candidate worktree, with the same
harness as the targeted comparison above; the complete table is
`nested-verification-machine-owner-full-comparison.md` beside this record.
Of the 169 commands, 166 have the same outcome on both trees
(136 pass on main and 133 on the candidate; the failures shared
with main are main's own, listed in the table) and 3 differ:
2 (main pass, candidate fail (1, validation_failure)), 3 (main pass, candidate fail (2, validation_failure)), 142 (main pass, candidate fail (1, validation_failure)). Aggregate wall clock over the set was 3296.2 seconds on main
and 3277.4 seconds on the candidate.

The differing rows are attributed as follows. Indexes 2, 3 and 142 fail on the
candidate only because the candidate is a linked worktree: main 0.3.367's
runtime-root projection refuses story-scoped commands from any linked worktree
that is not the story's own (`controller projection refused unsigned or
unregistered linked worktree for B-cdf6`, and the same for B-fe8f), indexes 2
and 3 invoke `finding_list --storyId=B-cdf6` and index 142 invokes
`red_evidence_get` for B-fe8f, the same refusals were reproduced for all three
commands from a throwaway linked worktree of unmodified main 6d6884c940, and all
three pass in the main checkout. Index 2 is the identity-lineage delivery smoke,
whose ninety-three cases pass on main and of which exactly the one that invokes
that command fails on the candidate; index 3 is its red harness; index 142 is
the ledger runtime-integrity red harness. A first candidate
run, stopped after forty-nine commands once its differences were known, had two
more: the precert fast set (index 6) failed with the `resource expansion`
refusal repaired in the controlled child API section, and the fixture suite at
index 14 spent its budget without progress after a nineteen-minute wait for a
machine pool shared with another session, the shape discussed with the owner
inspection above; both pass in the complete rerun on the repaired candidate
recorded here. The commands that reach `runIsolatedFindingFixture` directly,
through an npm alias or through one script hop (indexes 0, 2, 8, 15, 39, 155
and 168) have the same outcome on both trees except index 2, whose single
failing case is the environmental refusal above.

## Verification boundaries

Fifty-seven direct `node scripts/verify-nested-reservation-registered.mjs <selector>`
commands are registered in `proof-or-stop.config.json`; the matching
`test:nested-reservation-*` entries in `packages/main/package.json` are
convenience aliases for manual runs and are not validation gate inputs. The
closed selector wrapper normalizes the repository working directory; selectors
that need Darwin kernel descriptor or process identity observation print an
explicit skip on other platforms before loading native controls, while eight of
the thirteen executor result-contract selectors (`result-prepare-refusal`,
`result-cleanup-primary`, `result-cleanup-result`, `result-ordinary-error`,
`result-armed-timeout`, `result-caller-deadline`,
`result-refused-registration-cleanup` and `result-refused-registration-short`)
run through the platform-independent
queue in a private OS-home namespace and are not gated (they were exercised
only on Darwin in this Lab); `result-post-capture-cleanup` patches the
Darwin-only controller cleanup, and `result-descriptor-unavailable`,
`result-attempt-refusal`, `result-completed-group-residual` and
`result-nested-grant-deadline` need a live controller and the Darwin descriptor
observation, so the five are gated like the native controls. The entries declare the existing exclusive machine heavy and
process-fanout resources so validation serializes them against other heavy
commands; under the real executor each selector process inherits that declared
reservation and its unclassified leaf commands resolve to the declaration (see
the controlled child API). The `core` selector first removes the locator and
rebinds the machine pool root (`os.userInfo().homedir`) to a private scratch
home, in place and through NODE_OPTIONS for every child, and only then loads
the unchanged pinned driver through a dynamic import, so the override is in
place before the driver's module graph loads and the driver is the genuine
owner of that namespace's pool instead of an inheriting descendant; registered index 169 was
executed through the real compiled executor with the machine reservation held
and passed in 34.6 seconds, where before this round it failed at its first leaf
command. The Lab's own RED/GREEN replay still
runs the driver against the real pool.
Registered budgets strictly exceed each wrapped child's own timeout plus setup
and are evidence-backed: measured sequentially on 2026-09-14 against the merged
candidate, `core` completed in 30.8 to 41.1 seconds against a 120-second budget
(five 15-second outer cases plus setup stack in the worst case),
`registration-race` in 9.5 to 20.1 seconds against 120 seconds (eleven 10-second
modes stack in the worst case), `cleanup-diagnostics` in 6 to 9.1 seconds against
90 seconds (six 10-second modes), the result-contract, cancellation and
boot-recovery selectors, including the three refused-registration and
client-rejection cancellation selectors and the two eighth-round result-contract
selectors and the ninth-round `result-attempt-refusal`, in 1 to 5 seconds
against 30 seconds (each wraps one child whose own timeout is at most 12
seconds), and every remaining selector, including the four isolated-observation
selectors whose child allows 40 seconds and the ninth- and tenth-round
`fault-registered-row-pruned` and `fault-spawned-owner-loss`, in under 13
seconds against its 60-second budget; the eighth-round sequential sweep of all
forty-eight selectors passed in 181.5 seconds in total, the ninth-round sweep of
all fifty in 184.6 seconds (`core` 36.4 seconds) and the tenth-round sweep of
all fifty-one in 205.4 seconds (`core` 38.5 seconds, measured while the
candidate-versus-main evidence runs below held the real machine pool), and the
eleventh-round sweep of all fifty-one on the candidate resynchronized with main
0.3.366 in 205.4 seconds (`core` 37.4 seconds, every 30-second selector
under 3.7 seconds, every 60-second selector under 10.6 seconds), and the
twelfth-round sweep of all fifty-two in 201.1 seconds (`core` 35.9 seconds,
every 30-second selector under 3.8 seconds, every 60-second selector under
10.9 seconds), and the thirteenth-round sweep of all fifty-seven on the
candidate resynchronized with main 0.3.367 in 200.7 seconds (`core` 37.0
seconds, every 30-second selector under 4.2 seconds, every 60-second selector
under 9.9 seconds). Before the `core` selector
moved into a private namespace it exercised the real machine pool and failed
once in a sequential sweep with NESTED_FIXTURE_STARTED_REQUIRED while an
identity verifier self-test in another checkout held that pool; the Lab replay
of the pinned command is the one remaining real-pool user and must not be
scheduled concurrently with another real-pool holder.
The pinned driver, as replayed by the Lab tool, admits its leaf commands through
the real same-user machine pool: run concurrently with another holder of that
pool, its 1.5-second leaf deadline is reached before launch and it fails exactly
like the original RED. The registered `core` selector isolates the same driver
in a private OS-home pool, and the machine heavy and process-fanout claims its
entry declares are what the executor's delegated reservation carries for it.

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
slot while the forwarded transport keeps the pending-fence capability; a third
run of the plain wrapper passes an unrelated linked regular file at descriptor 4
and proves that it degrades identically, naming the linked-file reason, where
the pre-repair reader refused it as a foreign bootstrap. The Lab's source-runtime
helper resolves the TypeScript compiler from `packages/main` through Node's own
resolution, hoisted or not, instead of a hardcoded nested `node_modules` path,
and every control composes its source hooks through that helper's patch
parameter; the handshake-deadline control previously rewrote the helper's
loader with a hardcoded compiler path and now composes its stall hook the same
way.

Supplemental source-bound native fault commands are recorded separately:
`verify-nested-reservation-faults.mjs` modes `registered`, `same-group`, `pending`,
`coalesced`, `finite-owner`, `pending-lineage`, `declared-owner-unclassified`,
`declared-owner-expansion`, `retirement-backoff`, `controller-transport-unavailable`,
`drain-observation-transient`, `unattempted-owner-loss`, `attempted-owner-loss`,
`registered-row-pruned` and `spawned-owner-loss`
(every mode composes `--preimage` for the delegation source and
`--preimage-executor` for the executor of the same revision, so a pre-repair
replay is a consistent pair and can never silently run current source), plus
`verify-nested-reservation-handshake-deadline.mjs`,
`verify-nested-reservation-owner-loss.mjs`,
`verify-nested-isolated-cleanup.mjs`, and
`verify-nested-isolated-observation.mjs`. They use real queue APIs in a
test-only private OS-home namespace. In `pending` mode the sibling's queued
grant request is refused at its deadline either by its own handshake timer or,
when the controller's expiry response arrives first, by the controller
(`reservation/request expired`); the control accepts both wordings of that one
deadline refusal and asserts non-entry separately through the owner's `entered`
flag. Before that widening the mode failed once in twenty-three sequential runs
on 2026-09-14; afterwards it passed sixty-six consecutive runs, and the control's
own fifteen-second deadline now reports the partial transcript. Fault injection changes only disposable
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

The worker-exit controls arm a 20-second diagnostic limit and print the elapsed
time (about 4 seconds measured), far above the run and far below the 120-second
fixture deadline the unrepaired wrapper waited on, so a loaded machine cannot
turn the repair into a false RED while the original RED signal is preserved. The
`core` selector removes the locator through a named constant that is checked
against the registered policy source, so a renamed locator fails loudly instead
of leaving the driver on the outer reservation. The residual record rewrite
inside retirement is guarded: a ticket directory removed or made unwritable
under a live controller leaves the on-disk record at its more conservative
fenced state instead of crashing the owner from a timer or socket handler.

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
The release predicates compare only PID and group presence, never a recorded
start identity: a process group id that the kernel later reuses for an unrelated
group keeps a resolved row fenced until that group exits. This is an accepted
limitation, not a bound; releasing on identity alone would risk releasing an
unobservable group, so the fence stays until the group is provably absent.

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
