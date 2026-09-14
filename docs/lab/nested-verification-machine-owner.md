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

`cancelValidationReservationChild(pendingToken, options)` is cleanup-only and
its caller must have proved that no child was spawned. Separately, controller
retirement can resolve an already-observed owned target after fresh PID and
whole-group absence checks. Unknown targets remain fenced. Retirement polling is
event-driven and backs off: any grant, release or disconnect re-arms a 20 ms tick
(`retirementPollMs`), and while a tick changes nothing the interval doubles up
to 500 ms (`retirementPollMaxMs`); within one tick the process table and each
process identity are observed at most once. `verify-nested-reservation-faults.mjs`
mode `retirement-backoff` leaves a released grant with lingering same-group work
and counts kernel identity observations over one second: 49 against the
pre-repair fixed 20 ms interval, at most 12 (measured 4) afterwards.
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
the owner's declaration carried by the bootstrap. Inside one process a nested
unclassified request under a declared frame is still refused as expansion,
because one invocation cannot widen its own claim.
`verify-nested-reservation-faults.mjs` modes `declared-owner-unclassified` and
`declared-owner-expansion` prove both across a real process boundary under an
owner that declares exactly the claims the registered selectors declare; the
unclassified mode fails against the pre-repair controller with
`resource expansion`, which is what every registered selector hit under the
real executor before this repair.

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
leadership and pre-orphan ancestry are observed. Every kernel observation on the
registration path, including the owner's own start identity, is retried a
bounded number of times (`observationRetries` with `observationBackoffMs` in the
registered runtime policy) and falls back to proven target absence before the
registration is refused, so a single `ps` hiccup does not strand a targetless
token. The owner's start identity is compared against the observation that
recorded the pending row: a socket caller supplies the subject identity it
already observed, and the local frame observes itself with the same retry. The
isolated Finding fixture retries its worker observation with the same policy;
when a refused worker's PID and whole group are proven absent after the launcher
terminates it, the fixture withdraws its owned pending fence so the live
controller releases cleanly. The executor applies the same rule to every
validation command: a refused registration signals the spawned group exactly
as a timeout does, and once the direct child's PID and its whole group are
proven absent (the exported `unregisteredValidationReservationChildGone`
predicate, shared with the fixture) the owned pending fence is withdrawn before
the command result is returned; a live or unobservable group keeps the fence
for the controller to report, and a refused withdrawal is surfaced with the
bounded result preserved. `verify-nested-reservation-registration-race.mjs`
modes `retry-recovers` and `retry-exhausted` fail the inner observation itself
and assert the attempt count, `retry-exhausted-withdrawn` shows a raw API caller
withdrawing after proven absence, `verify-nested-isolated-observation.mjs`
proves the fixture's recovery and withdrawal under a live controller, and
`verify-nested-reservation-cancellation.mjs` modes
`refused-registration-withdrawn` and `refused-registration-live` drive the real
executor through a refused registration: an exiting workload releases the ticket
cleanly, while a workload that leaves a same-group grandchild ignoring the signal
keeps the pending fence (`owned group cleanup unproven`, one targetless pending
row in the doctor classification). Replayed against the pre-repair executor the
withdrawn mode fails with `owned group cleanup unproven`. A token that still
ends targetless because its owner died between prepare and registration, or
because every bounded observation failed, cannot be resolved by owner death
alone: a detached child may already exist. `proof-or-stop doctor` lists every
fencing shape of the release predicate under "Nested reservation fences" through
the same exported classifier (`classifyMachineReservationResiduals`): live or
unobservable registered groups, pending fences whose proven target is still
live, and pending fences without an observed target, with dead-owner counts;
`verify-nested-reservation-owner-loss.mjs` asserts that classification on the
dead owner's ticket while its orphan lives and after it stops. Recovery is
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

The caller's own abort, or a caller-supplied deadline error, is decided before
any pending fence is prepared and again ahead of a delegation refusal, so it
keeps its exception behaviour instead of folding into a delegation result; a
default deadline that expires during preparation still folds into the bounded
result, which is what `verify-nested-reservation-handshake-deadline.mjs` asserts.
`verify-nested-validation-result-contract.mjs` mode
`caller-deadline-before-prepare` expires the caller deadline ahead of that
preparation and asserts the caller's own error object propagates; against the
pre-repair executor the same run returned a folded result with no exception.

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
observations, not a full validation run.

The static-edge scanner's remaining rows are, up to moved line numbers inside
Lab-changed files, a subset of the rows already present on local main: 60
NEEDS_REVIEW rows on the candidate against 71 on main, where every differing
group is the same `incomplete exception` row at a moved line
(`native-review-fixture.ts` 189 to 190 and `isolated-finding-fixture.ts` 73 to
98, both inherited stale dependency pins on main) or main entries for
`verify-process-fact-contract.mjs` whose stale source digest the candidate's
refresh made current (13 rows on main, 2 on the candidate), and every stale
exception id on the candidate is stale on main (32 of main's 45). The manifest
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
reports on local main 0.3.363 minus three inherited rows that the candidate
rebinds because it modified their files (`runtime-fact-registry.ts` reviewed
source row, and the negative source integrity pins of
`verify-process-fact-contract.mjs` and `verify-runtime-fact-contract.mjs`); its
self-test fails identically on both. The rule for every identity re-pin in this
Lab is checkable: a re-pinned row is bound to a file this Lab modified, and no
row bound to an unmodified file is refreshed. Enumerated from
`git diff main -- scripts/identity-reviewed-source-data.json scripts/identity-reviewed-fixture-data.json scripts/identity-reviewed-json-data.json scripts/verify-proof-or-stop-identity-cutover.mjs scripts/identity-reviewed-*-contexts.mjs`
against `git diff --name-only main`, the 34 re-pinned rows are, by the
Lab-changed file that caused each one:

- `packages/main/src/core/runtime-artifact-registry.ts` (one added export): the
  reviewed-source row for `.lattice/runtime/host-runs/`, line 367 to 368 with
  its source digest, same line hash and occurrence count.
- `packages/main/src/core/runtime-fact-registry.ts` (delegation policy and
  fact): the reviewed-source row for `LATTICE_AGENT`, line 502 to 507 with its
  source digest, same line hash and occurrence count.
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
  `native-review-fixture.ts` and `isolated-finding-fixture.ts` under
  `/entries/39`, `/entries/269` and `/entries/270`, plus the
  CURRENT_COMPATIBLE_SCHEMA_ROWS context digest for the native review invocation
  attestation schema token (count unchanged at 4).
- the three reviewed-context readers (`identity-reviewed-source-contexts.mjs`,
  `-fixture-contexts.mjs`, `-json-contexts.mjs`): their EXPECTED_SHA256 and
  entry-count pins and the verifier's digest pin of each reader, because the
  inventories above changed.

Inherited main drift on files this Lab did not modify is left visible, not
refreshed.

## Verification boundaries

Thirty-nine direct `node scripts/verify-nested-reservation-registered.mjs <selector>`
commands are registered in `proof-or-stop.config.json`; the matching
`test:nested-reservation-*` entries in `packages/main/package.json` are
convenience aliases for manual runs and are not validation gate inputs. The
closed selector wrapper normalizes the repository working directory; selectors
that need Darwin kernel descriptor or process identity observation print an
explicit skip on other platforms before loading native controls, while six of
the seven executor result-contract selectors (`result-prepare-refusal`,
`result-cleanup-primary`, `result-cleanup-result`, `result-ordinary-error`,
`result-armed-timeout` and `result-caller-deadline`) run through the
platform-independent queue in a private OS-home namespace and are not gated
(they were exercised only on Darwin in this Lab); `result-post-capture-cleanup`
patches the Darwin-only controller cleanup and is gated like the native
controls. The entries declare the existing exclusive machine heavy and
process-fanout resources so validation serializes them against other heavy
commands; under the real executor each selector process inherits that declared
reservation and its unclassified leaf commands resolve to the declaration (see
the controlled child API). The `core` selector imports the unchanged pinned
driver statically but first removes the locator and rebinds the machine pool root
(`os.userInfo().homedir`) to a private scratch home, in place and through
NODE_OPTIONS for every child, so the driver is the genuine owner of that
namespace's pool instead of an inheriting descendant; registered index 169 was
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
boot-recovery selectors, including the two refused-registration cancellation
selectors, in 1 to 4 seconds against 30 seconds (each wraps one child whose own
timeout is at most 12 seconds), and every remaining selector,
including the two isolated-observation selectors whose child allows 40 seconds,
in under 11 seconds against its 60-second budget. Before the `core` selector
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
the pre-repair reader refused it as a foreign bootstrap.

Supplemental source-bound native fault commands are recorded separately:
`verify-nested-reservation-faults.mjs` modes `registered`, `same-group`, `pending`,
`coalesced`, `finite-owner`, `pending-lineage`, `declared-owner-unclassified`,
`declared-owner-expansion` and `retirement-backoff`, plus
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
